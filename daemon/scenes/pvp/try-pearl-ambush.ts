'use strict'
// Засада на жемчуг (пользователь 24.10: «тот, кто бросает жемчуг, появляется — и бам, сразу убивают»): воспроизведение без
// роя. Манекен — mineflayer-бот сцены, смертный (20 хп), в броне варианта, бросает настоящий жемчуг на ~40 бл.; бот демона
// слота стоит в D бл. от точки приземления с булавой и зарядами ветра, видит жемчуг глазами (combat/pearl-watch через status
// swarm) и сам делает засаду (RPC pearl_ambush — тот же, что зовёт рой). Итог — смерти манекена и удары с падения.
//   node dist/farm/farm.js up 1 --seed 1 --fresh --tick-rate 20, затем node dist/farm/farm.js run try-pearl-ambush.js --slots 1 --tick-rate 20
//   [-- варианты [заходов] [D]] — 20 TPS обязательно: засада считает срок по стенным часам, как на арене.
//   варианты: железо, незерит (по умолчанию оба), заходов — 10.
import type { Bot } from 'mineflayer'
import { Vec3 } from 'vec3'
import { connect, createKit, createGameBot, normBox, splitBox } from '../lib/scene-kit'
import * as clock from '../../src/game-clock'

const X = 3000; const Y = 200; const Z = 3000; const R = 46
const ARMOR: Record<string, string[]> = {
  железо: ['iron_helmet', 'iron_chestplate', 'iron_leggings', 'iron_boots'],
  незерит: ['netherite_helmet', 'netherite_chestplate', 'netherite_leggings', 'netherite_boots'].map(n => `${n}[enchantments={protection:4}]`)
}
const SLOTS = ['armor.head', 'armor.chest', 'armor.legs', 'armor.feet']

async function main () {
  const slot = process.env.FARM_SLOT
  const me = process.env.MC_USERNAME
  ;(require('../lib/arms-guard') as typeof import('../lib/arms-guard')).farmOnly({ ws: [process.env.ND_WS], mc: [process.env.MC_PORT] })
  if (!slot || !me) throw new Error('сцену запускает farm.js run (FARM_SLOT, MC_USERNAME)')
  const only = (process.argv[2] || Object.keys(ARMOR).join(',')).split(',')
  const N = Number(process.argv[3] || 10), D = Number(process.argv[4] || 5)
  const dummyName = `NeuroPearl${slot}`
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
    await kit.gamerule('immediate_respawn', true)
    await kit.gamerule('keep_inventory', false)
    await kit.cmd('/time set day'); await kit.cmd('/weather clear')
    await kit.setDifficulty('normal')
    await kit.forceload('overworld', [[X - R, 0, Z - R], [X + R, 0, Z + R]])
    await kit.must(`/tp ${me} ${X + 0.5} ${Y + 5} ${Z + 0.5}`, null, 'бот к площадке')
    await kit.fillExact('overworld', [[X - R, Y - 1, Z - R], [X + R, Y - 1, Z + R]], 'smooth_stone')
    for (const b of splitBox(normBox([[X - R, Y, Z - R], [X + R, Y + 30, Z + R]]))) await kit.cmd(`/fill ${b.x1} ${b.y1} ${b.z1} ${b.x2} ${b.y2} ${b.z2} minecraft:air`)

    dummy = createGameBot({ host: '127.0.0.1', port: Number(process.env.MC_PORT), username: dummyName, auth: 'offline', version: '1.21.11' })
    await new Promise<void>((resolve, reject) => { dummy!.once('spawn', () => resolve()); dummy!.once('error', reject); dummy!.once('kicked', r => reject(new Error('манекен: ' + String(r)))) })
    let deaths = 0
    dummy.on('death', () => { deaths++ })
    const pw: typeof import('../../src/combat/pearl-watch') = require('../../src/combat/pearl-watch')
    const L = new Vec3(X + 0.5, Y, Z + 0.5) // точка приземления
    // Откуда бросает: за 40 бл. (~2.5 с полёта — побег жемчугом) или UP=1 — с самой точки вверх (пользователь 24.10: «подкинул
    // вверх на одном месте и убежал» — жемчуг летит ~3 с и падает туда же).
    const UP = process.env.UP === '1', TRAP = process.env.TRAP || ''
    const S = UP ? L.clone() : new Vec3(X + 0.5 - 40, Y, Z + 0.5)

    const rows: any[] = []
    for (const variant of only) {
      const row: any = { variant, trials: 0, kills: 0, launched: 0, hits: 0, notes: {} as Record<string, number> }
      for (let k = 0; k < N; k++) {
        // Манекен: выживание, полное хп и сытость, броня варианта, жемчуг в руке; бот — булава, заряды, ведро.
        await kit.cmd(`/gamemode survival ${dummyName}`); await kit.cmd(`/clear ${dummyName}`); await kit.cmd(`/effect clear ${dummyName}`)
        await kit.cmd(`/effect give ${dummyName} minecraft:instant_health 1 10 true`); await kit.cmd(`/effect give ${dummyName} minecraft:saturation 1 10 true`)
        for (const [i, it] of ARMOR[variant].entries()) await kit.cmd(`/item replace entity ${dummyName} ${SLOTS[i]} with minecraft:${it}`)
        await kit.cmd(`/item replace entity ${dummyName} weapon.mainhand with minecraft:ender_pearl 16`)
        await kit.cmd(`/clear ${me}`); await kit.cmd(`/effect give ${me} minecraft:instant_health 1 10 true`)
        // TRAP=lava|web|dig — вместо засады ловушка (RPC pearl_trap): ведро лавы, паутина или незеритовая кирка.
        const gear = TRAP === 'lava' ? ['lava_bucket 1'] : TRAP === 'web' ? ['cobweb 8'] : TRAP === 'dig' ? ['netherite_pickaxe[enchantments={efficiency:5}] 1'] : ['mace[enchantments={density:5,wind_burst:1}] 1', 'wind_charge 16', 'water_bucket 1']
        for (const g of gear) await kit.cmd(`/give ${me} minecraft:${g}`)
        await kit.cmd(`/fill ${X - R} ${Y - 1} ${Z - R} ${X + R} ${Y - 1} ${Z + R} minecraft:smooth_stone replace air`)
        await kit.cmd(`/fill ${X - R} ${Y} ${Z - R} ${X + R} ${Y + 2} ${Z + R} minecraft:air`)
        // Бот — в D бл. от точки, вбок от линии броска (жемчуг не попадёт в него), лицом к точке.
        const side = new Vec3(0, 0, D)
        await kit.cmd(`/tp ${me} ${L.x + side.x} ${Y} ${L.z + side.z} 180 0`)
        await kit.cmd(`/tp ${dummyName} ${S.x} ${Y} ${S.z} -90 0`)
        await clock.sleep(1500)
        const before = deaths
        // Угол броска — по той же модели полёта (pearl-watch.pearlLanding): ближе всего к L.
        const eye = dummy.entity.position.offset(0, 1.62, 0), yaw = Math.atan2(-(L.x - eye.x), -(L.z - eye.z))
        let best: { pitch: number; miss: number } | null = UP ? { pitch: Math.PI / 2 - .02, miss: 0 } : null
        for (let pitch = -.2; pitch <= .9 && !UP; pitch += .01) {
          const v = new Vec3(-Math.sin(yaw) * Math.cos(pitch), Math.sin(pitch), -Math.cos(yaw) * Math.cos(pitch)).scaled(1.5)
          const land = pw.pearlLanding({ blockAt: (p: Vec3) => dummy!.blockAt(p) }, eye, v)
          if (!land) continue
          const miss = Math.hypot(land.at.x - L.x, land.at.z - L.z)
          if (!best || miss < best.miss) best = { pitch, miss }
        }
        if (!best) { row.notes['нет броска'] = (row.notes['нет броска'] || 0) + 1; continue }
        await dummy.look(yaw, best.pitch, true)
        // Бот смотрит в сторону броска (жемчуг видит глазами, как в бою) — и ловит его в status swarm.
        let call: Promise<any> | null = null
        const t0 = Date.now()
        dummy.activateItem()
        // Бросил вверх — и убежал (вбок от бота).
        if (UP) { dummy.setControlState('forward', true); dummy.setControlState('sprint', true); clock.wall.setTimeout(() => { dummy!.setControlState('forward', false); dummy!.setControlState('sprint', false) }, 1500) }
        while (!call && Date.now() - t0 < 2500) {
          const st = await c.call('status', { swarm: true }).catch(() => null)
          const pl = (st?.detail?.pearls || []).find((q: any) => q.owner === dummyName)
          if (pl) call = c.call(TRAP ? 'pearl_trap' : 'pearl_ambush', { owner: pl.owner, id: pl.id, at: pl.at, contact: pl.contact, block: pl.block, eta: pl.eta, seenAt: Date.now() })
          else await clock.sleep(30)
        }
        row.trials++
        if (!call) { row.notes['жемчуг не увидел'] = (row.notes['жемчуг не увидел'] || 0) + 1; continue }
        const r = await call.catch((e: any) => ({ detail: { why: e.message } }))
        const d = r?.detail || r || {}
        await clock.sleep(1500)
        const killed = deaths > before
        if (TRAP) {
          // Итог ловушки: где он и в чём (лава/паутина под ногами), на сколько ниже пола, умер ли за 1.5 с после.
          const at = dummy.entity.position, inBlock = dummy.blockAt(at)?.name, low = +(Y - at.y).toFixed(1)
          const note = killed ? 'убит' : d.ok ? `${d.kind}: он ${inBlock === 'cobweb' ? 'в паутине' : inBlock === 'lava' ? 'в лаве' : low > .5 ? `в яме / ниже на ${low} бл.` : Math.hypot(at.x - L.x, at.z - L.z) > 3 ? 'не долетел (жемчуг пропал)' : 'на полу'}` : `не вышло: ${String(d.why).slice(0, 70)}`
          row.notes[note.replace(/[\d.]+ бл/, 'N бл')] = (row.notes[note.replace(/[\d.]+ бл/, 'N бл')] || 0) + 1
          if (killed) row.kills++
          if (d.ok) row.launched++
          console.log(`[${variant} ${k + 1}/${N}] ${note}${d.drop != null ? ` (прогноз: ниже на ${d.drop})` : ''}${d.lost ? ' (прогноз: жемчуг в пустоту)' : ''}`)
          continue
        }
        if (d.ok) row.launched++
        if (d.hit) row.hits++
        if (killed) row.kills++
        const note = killed ? `убил (${d.travel}${d.fall ? `, падение ${d.fall} бл.` : ''})` : d.hit ? `попал, жив (${d.travel})` : d.ok ? `мимо (${d.why || d.note || d.travel})` : `не взлетел: ${String(d.why).slice(0, 60)}`
        row.notes[note.replace(/[\d.]+ бл\./, 'N бл.')] = (row.notes[note.replace(/[\d.]+ бл\./, 'N бл.')] || 0) + 1
        console.log(`[${variant} ${k + 1}/${N}] ${note}`)
      }
      console.log(`[${variant}] заходов ${row.trials}: убил ${row.kills}, ударов ${row.hits}, взлётов ${row.launched} | ${Object.entries(row.notes).map(([k, v]) => `${k}×${v}`).join(', ')}`)
      rows.push(row)
    }
    console.log('ИТОГ ' + rows.map(r => `${r.variant}: убийств ${r.kills}/${r.trials}`).join(' | '))
  } finally {
    await c.call('stop').catch(() => {})
    try { await kit.unforceload?.('overworld', [[X - R, 0, Z - R], [X + R, 0, Z + R]]) } catch {}
    dummy?.quit('try-pearl-ambush done')
    c.close()
  }
}

if (require.main === module) main().then(() => clock.wall.setTimeout(() => process.exit(0), 300)).catch(e => { console.error('FAILED', e?.stack || e); process.exit(1) })
