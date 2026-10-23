'use strict'
// Точность тарана копьём с элитр (combat/aerial-lance, RPC lance) на управляемой цели (23.10). На стенде 15×15 точность
// тонет в свалке (0.17–0.42 попаданий на заход от прогона к прогону, hurt cooldown съедает damage_event), здесь — один
// бот демона слота с набором ARMS_AIR против манекена: mineflayer-бот этой сцены, без брони и оружия, движется строго по
// сценарию (позиция и скорость перезаписываются каждый physicsTick — не уворачивается, отдача не сносит), max_health 1024.
// Варианты (по строке итога на каждый): стоит — на полу; бежит — туда-обратно по полу 0.28 б/т; прямо — на элитрах
// туда-обратно ±26 бл.; повороты — на элитрах по кругу r=12. Полёт манекена — настоящий (физика элитр, ракеты), см. PILOTS.
// Попадание — damage_event у манекена с причиной «бот» (sourceCauseId = его id + 1) и падение хп манекена после него;
// рядом — «попал» самого тарана и его damage_event, отказы — по итогам захода (мимо, опасно: стена, долго…).
//   node dist/farm/farm.js up 1 --seed 1 --fresh, затем node dist/farm/farm.js run try-lance.js --slots 1 [-- варианты [заходов]]
//   LANCE_PASSES=400 — заходов на вариант (по умолчанию), RNG_SEED — соль /random reset (по умолчанию 1).
import * as fs from 'fs'
import type { Bot } from 'mineflayer'
import { connect, createKit, createGameBot, normBox, splitBox } from '../lib/scene-kit'
import * as clock from '../../src/game-clock'

const X = 2000; const Y = 200; const Z = 2000; const R = 40
const FLY_Y = Y + 14
const ARENA = { x: X + 0.5, z: Z + 0.5, r: R - 2 }
type Pose = { p: { x: number; y: number; z: number }; v: { x: number; y: number; z: number }; ground: boolean }
// Туда-обратно по отрезку ±half со скоростью s: положение и знак скорости на тике t.
const pingPong = (t: number, s: number, half: number) => {
  const L = 2 * half; const u = (t * s) % (2 * L)
  return u < L ? { x: -half + u, dir: 1 } : { x: half - (u - L), dir: -1 }
}
const PATHS: Record<string, (t: number) => Pose> = {
  стоит: () => ({ p: { x: X + 0.5, y: Y, z: Z + 0.5 }, v: { x: 0, y: 0, z: 0 }, ground: true }),
  бежит: t => { const q = pingPong(t, 0.28, 8); return { p: { x: X + 0.5 + q.x, y: Y, z: Z + 0.5 }, v: { x: 0.28 * q.dir, y: 0, z: 0 }, ground: true } },
}
// Летящий манекен — настоящий полёт (физика элитр клиента, ракеты): каждый тик взгляд на точку маршрута и высоту FLY_Y,
// ракета — когда медленно. Рельсовый полёт (позиция по сценарию) давал атакующему цель вне физики элитр: трекер
// (bow/track observedGlideVelocity) на ней не срабатывал, и замер мерил не то, что встретится в бою.
type Pilot = (p: { x: number; y: number; z: number }) => { x: number; z: number }
const PILOTS: Record<string, () => Pilot> = {
  // Туда-обратно между x = ±26, разворот у края.
  прямо: () => { let dir = 1; return p => { if ((p.x - X - 0.5) * dir > 22) dir = -dir; return { x: X + 0.5 + 26 * dir, z: Z + 0.5 } } },
  // По кругу r=12: точка на 0.7 рад впереди по ходу.
  повороты: () => p => { const a = Math.atan2(p.z - Z - 0.5, p.x - X - 0.5) + 0.7; return { x: X + 0.5 + 12 * Math.cos(a), z: Z + 0.5 + 12 * Math.sin(a) } }
}

async function main () {
  const slot = process.env.FARM_SLOT
  const me = process.env.MC_USERNAME
  ;(require('../lib/arms-guard') as typeof import('../lib/arms-guard')).farmOnly({ ws: [process.env.ND_WS], mc: [process.env.MC_PORT] })
  if (!slot || !me) throw new Error('сцену запускает farm.js run (FARM_SLOT, MC_USERNAME)')
  const only = (process.argv[2] || [...Object.keys(PATHS), ...Object.keys(PILOTS)].join(',')).split(',')
  const N = Number(process.argv[3] || process.env.LANCE_PASSES || 400)
  const dummyName = `NeuroLance${slot}`
  const c = connect(process.env.ND_WS)
  let dummy: Bot | null = null
  const kit: any = { cmd: null }
  try {
    await c.ready
    await c.call('connect')
    await c.call('stop')
    await c.call('play_mode', { mode: 'free' })
    await c.call('temper', { enabled: false }).catch(() => {})
    Object.assign(kit, createKit({ call: c.call, heard: c.heard, logFile: process.env.ND_SERVER_LOG, player: me }))
    await kit.must('/tick unfreeze', null, 'часы идут')
    await kit.cmd('/gamerule send_command_feedback true')
    await kit.gamerule('spawn_mobs', false)
    await kit.gamerule('natural_health_regeneration', false)
    await kit.cmd('/time set day'); await kit.cmd('/weather clear')
    await kit.setDifficulty('normal')
    await kit.forceload('overworld', [[X - R, 0, Z - R], [X + R, 0, Z + R]])
    await kit.must(`/tp ${me} ${X + 0.5} ${Y + 5} ${Z + 20.5}`, null, 'бот к площадке')
    await kit.fillExact('overworld', [[X - R, Y - 1, Z - R], [X + R, Y - 1, Z + R]], 'smooth_stone')
    for (const b of splitBox(normBox([[X - R, Y, Z - R], [X + R, Y + 40, Z + R]]))) await kit.cmd(`/fill ${b.x1} ${b.y1} ${b.z1} ${b.x2} ${b.y2} ${b.z2} minecraft:air`)

    dummy = createGameBot({ host: '127.0.0.1', port: Number(process.env.MC_PORT), username: dummyName, auth: 'offline', version: '1.21.11' })
    await new Promise<void>((resolve, reject) => { dummy!.once('spawn', () => resolve()); dummy!.once('error', reject); dummy!.once('kicked', r => reject(new Error('манекен: ' + String(r)))) })
    dummy.on('kicked', r => console.log('[манекен] кик', String(r)))
    await kit.must(`/gamemode survival ${dummyName}`, null, 'манекен в выживании')
    await kit.must(`/attribute ${dummyName} minecraft:max_health base set 1024`, null, 'хп манекена')
    await kit.must(`/attribute ${dummyName} minecraft:knockback_resistance base set 1`, null, 'манекен без отдачи')

    // Сценарий манекена: после шага физики клиента — позиция и скорость по пути, mineflayer шлёт её серверу.
    // Между таранами (hold) — замер в последней позе: под обычной физикой манекен падал и получал урон падением.
    let path: ((t: number) => Pose) | null = null
    let hold = true
    let tick = 0
    let glideTry = 0
    let pilot: Pilot | null = null
    let rocketAt = -100
    dummy.on('physicsTick', () => {
      const b = dummy!.entity
      if (pilot && b) {
        tick++
        if (!b.elytraFlying) { if (!b.onGround && tick - glideTry > 5) { glideTry = tick; dummy!.elytraFly().catch(() => {}) } return }
        const w = pilot(b.position)
        b.yaw = Math.atan2(-(w.x - b.position.x), -(w.z - b.position.z))
        b.pitch = Math.max(-0.6, Math.min(0.6, (FLY_Y - b.position.y) * 0.08 - b.velocity.y * 0.5))
        if (!(dummy!.fireworkRocketDuration > 0) && Math.hypot(b.velocity.x, b.velocity.z) < 1.1 && tick - rocketAt > 20 && dummy!.heldItem?.name === 'firework_rocket') { rocketAt = tick; dummy!.activateItem() }
        return
      }
      if (!path || !b) return
      const q = path(hold ? tick : tick++)
      if (hold) q.v = { x: 0, y: 0, z: 0 }
      dummy!.entity.position.set(q.p.x, q.p.y, q.p.z)
      dummy!.entity.velocity.set(q.v.x, q.v.y, q.v.z)
      dummy!.entity.onGround = q.ground
      if (q.v.x || q.v.z) dummy!.entity.yaw = Math.atan2(-q.v.x, -q.v.z)
      dummy!.entity.pitch = 0
      if (!q.ground && !dummy!.entity.elytraFlying && tick - glideTry > 5) { glideTry = tick; dummy!.elytraFly().catch(() => {}) }
    })
    // Счёт со стороны манекена: damage_event по нему от бота, затем падение хп (update_health) — подтверждено.
    const cnt = { events: 0, confirmed: 0, drops: 0, other: 0 }
    let pendingHit = 0
    let hp = 1024
    dummy._client.on('damage_event', (pk: any) => {
      if (!dummy!.entity || pk.entityId !== dummy!.entity.id) return
      const atk = dummy!.players[me]?.entity
      if (atk && pk.sourceCauseId === atk.id + 1) { cnt.events++; pendingHit = 10 } else cnt.other++
    })
    dummy.on('physicsTick', () => { if (pendingHit > 0) pendingHit-- })
    dummy.on('health', () => {
      const h = dummy!.health
      if (h < hp - 1e-6) { cnt.drops++; if (pendingHit > 0) { cnt.confirmed++; pendingHit = 0 } }
      hp = h
    })

    const salt = await kit.randomReset(process.env.RNG_SEED ?? 1)
    const rows: any[] = []
    for (const name of only) {
      const pathOf = PATHS[name]
      if (!pathOf && !PILOTS[name]) throw new Error(`нет варианта ${name}: ${[...Object.keys(PATHS), ...Object.keys(PILOTS)].join(', ')}`)
      hold = true
      path = pathOf || null
      pilot = null
      Object.assign(cnt, { events: 0, confirmed: 0, drops: 0, other: 0 })
      const row: any = { variant: name, passes: 0, hitsLance: 0, hurtsLance: 0, calls: 0, reasons: {} as Record<string, number>, salt }
      const t0 = clock.now()
      // Набор и площадка — перед каждым тараном: таран сам садится и снимает элитры.
      while (row.passes < N && row.calls < Math.ceil(N / 2) + 10) {
        hold = true
        await kit.cmd(`/clear ${me}`)
        await kit.must(`/give ${me} minecraft:diamond_spear[enchantments={sharpness:3,knockback:1}] 1`, null, 'копьё')
        await kit.must(`/give ${me} minecraft:elytra 1`, null, 'элитры')
        await kit.must(`/give ${me} minecraft:firework_rocket 64`, null, 'ракеты')
        if (!pathOf) {
          await kit.must(`/item replace entity ${dummyName} armor.chest with minecraft:elytra`, null, 'элитры манекену')
          await kit.must(`/item replace entity ${dummyName} weapon.mainhand with minecraft:firework_rocket 64`, null, 'ракеты манекену')
        }
        for (const w of [me, dummyName]) {
          await kit.cmd(`/effect clear ${w}`)
          await kit.cmd(`/effect give ${w} minecraft:instant_health 1 20 true`)
          await kit.cmd(`/effect give ${w} minecraft:saturation 1 20 true`)
        }
        if (pathOf) {
          tick = 0 // каждый таран — с той же фазы пути: прогоны сравнимы
          const p0 = pathOf(tick)
          await kit.must(`/tp ${dummyName} ${p0.p.x} ${p0.p.y} ${p0.p.z}`, null, 'манекен на старт')
        } else if (!pilot || !dummy.entity.elytraFlying || dummy.entity.position.y < Y + 5) {
          // Полёт манекена не прерывается между таранами; старт или сбой (сел, упал) — на высоту и раскрыть элитры.
          pilot = null
          await kit.must(`/tp ${dummyName} ${X - 25.5} ${FLY_Y + 4} ${Z + 0.5} -90 0`, null, 'манекен на старт')
          pilot = PILOTS[name]()
          await clock.sleep(1500)
          row.restarts = (row.restarts || 0) + 1
        }
        await kit.must(`/tp ${me} ${X + 0.5} ${Y} ${Z + 22.5} 180 0`, null, 'бот на старт')
        if (pathOf) path = pathOf
        await clock.sleep(1000)
        hold = false
        await clock.sleep(500)
        const left = N - row.passes
        const r = await c.call('lance', { target: dummyName, passes: Math.min(16, left), maxSeconds: 120, arena: ARENA }).catch((e: any) => ({ status: 'failed', error: e.message }))
        row.calls++
        const d = r?.detail || {}
        if (r?.status !== 'done') console.log('[таран]', JSON.stringify({ status: r?.status, by: r?.by, error: r?.error, note: d.note }).slice(0, 400))
        // Таран, оборванный в воздухе, садится фоном — до /clear дождаться земли.
        for (let i = 0; i < 60; i++) { const st = await c.call('status', { physics: true }).catch(() => null); const g = st?.state?.physics?.onGround ?? st?.physics?.onGround ?? st?.detail?.physics?.onGround; if (g !== false) break; await clock.sleep(250) }
        if (r?.status !== 'done' || !Array.isArray(d.results)) { row.reasons['отказ: ' + (d.note || d.why || r?.error || r?.status)] = (row.reasons['отказ: ' + (d.note || d.why || r?.error || r?.status)] || 0) + 1; await clock.sleep(1000); continue }
        row.passes += d.results.length
        row.hitsLance += d.results.filter((x: string) => x === 'попал').length
        row.hurtsLance += (d.hurts || []).length
        for (const x of d.results) row.reasons[x] = (row.reasons[x] || 0) + 1
        // Таран сам садится до ответа (lanceLand); пауза — дать снять элитры.
        await clock.sleep(500)
      }
      hold = true
      pilot = null
      Object.assign(row, { dmgEvents: cnt.events, confirmed: cnt.confirmed, hpDrops: cnt.drops, otherHurts: cnt.other, seconds: Math.round((clock.now() - t0) / 1000) })
      row.rate = row.passes ? +(row.confirmed / row.passes).toFixed(3) : 0
      row.rateLance = row.passes ? +(row.hitsLance / row.passes).toFixed(3) : 0
      console.log(`[${name}] заходов ${row.passes} (таранов ${row.calls}) | попаданий ${row.confirmed} = ${row.rate}/заход (у тарана «попал» ${row.hitsLance}, его damage_event ${row.hurtsLance}; у манекена событий ${row.dmgEvents}, падений хп ${row.hpDrops}, чужих ${row.otherHurts}) | ${Object.entries(row.reasons).map(([k, v]) => `${k}×${v}`).join(', ')}`)
      rows.push(row)
      if (process.env.LAB_OUT) fs.appendFileSync(process.env.LAB_OUT, JSON.stringify(row) + '\n')
    }
    console.log('ИТОГ ' + rows.map(r => `${r.variant} ${r.rate}`).join(' | '))
  } finally {
    await c.call('stop').catch(() => {})
    try { await kit.unforceload?.('overworld', [[X - R, 0, Z - R], [X + R, 0, Z + R]]) } catch {}
    dummy?.quit('try-lance done')
    c.close()
  }
}

if (require.main === module) main().then(() => clock.wall.setTimeout(() => process.exit(0), 300)).catch(e => { console.error('FAILED', e?.stack || e); process.exit(1) })
