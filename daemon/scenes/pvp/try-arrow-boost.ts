'use strict'
// Разгон стрелой (пользователь 24.10: «один бот другого стрелой ускоряет, и тот копьём ваншотит»; «два бота одновременно
// пуляют в третьего»). Бот демона слота — копейщик: стоит с копьём в «использовании» в D бл. от манекена (RPC boost_lance);
// лучники — mineflayer-боты сцены за его спиной, стреляют в него слабой стрелой «Отдачи» тем же кодом, что бот демона
// (combat/arrow-boost.boostShot). Две стрелы — второй тянет сильнее (урон больше — вторая не отскочит в неуязвимости) и
// пускает так, чтобы обе пришли в один тик. Итог — смерти манекена, урон, скорость копейщика.
//   node dist/farm/farm.js up 1 --seed 1 --fresh --tick-rate 20, затем node dist/farm/farm.js run try-arrow-boost.js --slots 1 --tick-rate 20
//   [-- варианты [заходов] [D] [стрел]] — варианты: железо, незерит (по умолчанию оба); заходов 8; D 7; стрел 1,2,3.
import type { Bot } from 'mineflayer'
import { Vec3 } from 'vec3'
import { connect, createKit, createGameBot, normBox, splitBox } from '../lib/scene-kit'
import * as clock from '../../src/game-clock'

const X = 3000; const Y = 200; const Z = 3000; const R = 20
const ARMOR: Record<string, string[]> = {
  железо: ['iron_helmet', 'iron_chestplate', 'iron_leggings', 'iron_boots'],
  незерит: ['netherite_helmet', 'netherite_chestplate', 'netherite_leggings', 'netherite_boots'].map(n => `${n}[enchantments={protection:4}]`)
}
const SLOTS = ['armor.head', 'armor.chest', 'armor.legs', 'armor.feet']
// Тиков натяжения: урон обычной стрелой ceil(скорость × 2) — 3, 4, 6: каждая следующая больнее прошлой (не отскочит).
const DRAW = (process.env.DRAW || '10,14,20').split(',').map(Number)

async function bot (name: string) {
  const b = createGameBot({ host: '127.0.0.1', port: Number(process.env.MC_PORT), username: name, auth: 'offline', version: '1.21.11' })
  await new Promise<void>((resolve, reject) => { b.once('spawn', () => resolve()); b.once('error', reject); b.once('kicked', r => reject(new Error(name + ': ' + String(r)))) })
  return b
}

async function main () {
  const slot = process.env.FARM_SLOT
  const me = process.env.MC_USERNAME
  ;(require('../lib/arms-guard') as typeof import('../lib/arms-guard')).farmOnly({ ws: [process.env.ND_WS], mc: [process.env.MC_PORT] })
  if (!slot || !me) throw new Error('сцену запускает farm.js run (FARM_SLOT, MC_USERNAME)')
  const only = (process.argv[2] || Object.keys(ARMOR).join(',')).split(',')
  const N = Number(process.argv[3] || 8), D = Number(process.argv[4] || 7)
  const counts = (process.argv[5] || '1,2,3').split(',').map(Number)
  const foeName = `NeuroFoe${slot}`, archNames = [`NeuroBowA${slot}`, `NeuroBowB${slot}`, `NeuroBowC${slot}`]
  const c = connect(process.env.ND_WS)
  const bots: Bot[] = []
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
    for (const b of splitBox(normBox([[X - R, Y, Z - R], [X + R, Y + 20, Z + R]]))) await kit.cmd(`/fill ${b.x1} ${b.y1} ${b.z1} ${b.x2} ${b.y2} ${b.z2} minecraft:air`)

    const foe = await bot(foeName); bots.push(foe)
    const archers: Bot[] = []
    for (const n of archNames) archers.push(await bot(n))
    bots.push(...archers)
    // Копейщик и лучники — одна команда (как рой): демон не бьёт своих лучников за стрелу в спину.
    await kit.cmd('/team add boost'); await kit.cmd('/team modify boost friendlyFire true')
    await kit.cmd(`/team join boost ${me} ${archNames.join(' ')}`)
    let deaths = 0
    foe.on('death', () => { deaths++ })
    const ab: typeof import('../../src/combat/arrow-boost') = require('../../src/combat/arrow-boost')
    const ba: typeof import('../../src/bow/ballistics') = require('../../src/bow/ballistics')
    const dm: typeof import('../../src/pvp/damage-model') = require('../../src/pvp/damage-model')
    const pick: typeof import('../../src/pick') = require('../../src/pick')
    // Копейщик в L лицом на север (−z), манекен в D бл. к северу, лучники в 3 бл. за спиной (рядом, на 0.8 вбок).
    const L = new Vec3(X + 0.5, Y, Z + 0.5), F = L.offset(0, 0, -D)
    const A = [L.offset(-0.6, 0, 3), L.offset(0.6, 0, 3), L.offset(0, 0, 4.5)]

    const rows: any[] = []
    for (const variant of only) for (const n of counts) {
      const row: any = { variant, n, trials: 0, kills: 0, hits: 0, dmg: [] as number[], v: [] as number[], notes: {} as Record<string, number> }
      for (let k = 0; k < N; k++) {
        await kit.cmd(`/gamemode survival ${foeName}`); await kit.cmd(`/clear ${foeName}`); await kit.cmd(`/effect clear ${foeName}`)
        await kit.cmd(`/effect give ${foeName} minecraft:instant_health 1 10 true`); await kit.cmd(`/effect give ${foeName} minecraft:saturation 1 10 true`)
        for (const [i, it] of ARMOR[variant].entries()) await kit.cmd(`/item replace entity ${foeName} ${SLOTS[i]} with minecraft:${it}`)
        await kit.cmd(`/clear ${me}`); await kit.cmd(`/effect give ${me} minecraft:instant_health 1 10 true`)
        await kit.cmd(`/give ${me} minecraft:netherite_spear 1`)
        for (const [i, it] of ARMOR.железо.entries()) await kit.cmd(`/item replace entity ${me} ${SLOTS[i]} with minecraft:${it}`)
        for (const [i, a] of archers.entries()) {
          await kit.cmd(`/clear ${archNames[i]}`); await kit.cmd(`/gamemode survival ${archNames[i]}`)
          await kit.cmd(`/give ${archNames[i]} minecraft:bow[enchantments={punch:${process.env.PUNCH || 2}}] 1`); await kit.cmd(`/give ${archNames[i]} minecraft:arrow 16`)
          await kit.cmd(`/tp ${archNames[i]} ${A[i].x} ${Y} ${A[i].z} 180 0`)
        }
        await c.call('stop').catch(() => {})
        await kit.cmd('/kill @e[type=arrow]') // упавшие стрелы: копейщик бегал их подбирать
        await kit.cmd(`/tp ${me} ${L.x} ${Y} ${L.z} 180 0`)
        await kit.cmd(`/tp ${foeName} ${F.x} ${Y} ${F.z} 0 0`)
        // Ждать расстановки: убитый в прошлом заходе возрождается и встаёт на место не сразу.
        // Сущность — из players: после /tp и смертей в entities лежат и устаревшие (isValid false) с тем же именем.
        const seen = (a: Bot, name: string) => (a.players[name]?.entity || Object.values(a.entities).find((e: any) => e.username === name && e.isValid !== false)) as any
        const placed = () => archers.every(a => {
          const l = seen(a, me), f = seen(a, foeName)
          return l && f && l.position.distanceTo(L) < 0.6 && f.position.distanceTo(F) < 0.6
        })
        for (let w = 0; w < 30 && !placed(); w++) {
          await clock.sleep(200)
          if (w % 5 === 4) { await kit.cmd(`/tp ${me} ${L.x} ${Y} ${L.z} 180 0`); await kit.cmd(`/tp ${foeName} ${F.x} ${Y} ${F.z} 0 0`) }
        }
        await clock.sleep(1000)
        const before = deaths, hp0 = foe.health
        const lancer = (a: Bot) => seen(a, me)
        if (process.env.DEBUG) {
          const st: any = await c.call('status').catch(() => null), real = st?.state?.pos || st?.detail?.state?.pos
          console.log('ВИД', JSON.stringify({ real, ...Object.fromEntries(archers.map(a => { const l = seen(a, me); return [a.username, l ? [l.id, +l.position.x.toFixed(1), +l.position.y.toFixed(1), +l.position.z.toFixed(1), l.isValid, Object.keys(a.entities).length] : null] })) }))
        }
        const lance = c.call('boost_lance', { foe: foeName, maxMs: 4000, from: archNames }).catch((e: any) => ({ detail: { why: e.message } }))
        await clock.sleep(800) // задержка незеритового копья 0.4 с и запас
        // Стрелы — в один тик: каждый лучник ждёт общего сигнала (копейщик пошёл вверх в прыжке) и ещё lag тиков — разницу
        // полётов. Слабая летит дольше и выходит раньше: сущность, созданная раньше, в тике обрабатывается первой.
        const track: string[] = []
        const plan = archers.slice(0, n).map((a, i) => {
          const L0 = lancer(a)
          const f = L0 && ba.aim(pick.eyeOf(a), () => L0.position.offset(0, .9, 0), dm.bowShot(DRAW[i]).speed)
          return { a, draw: DRAW[i], flight: Math.ceil(f?.ticks ?? 3) }
        })
        const longest = Math.max(...plan.map(p => p.flight))
        const shots = await Promise.all(plan.map(p => {
          const foeSeen = seen(p.a, foeName)
          return ab.boostShot(p.a, lancer(p.a), { foe: foeSeen, draw: p.draw, lag: longest - p.flight, wait: Math.max(...plan.map(q => q.draw)) - p.draw })
        }))
        const r: any = await lance
        const d = r?.detail || r || {}
        await clock.sleep(800)
        const killed = deaths > before
        const dmg = killed ? hp0 : Math.max(0, hp0 - foe.health)
        row.trials++
        if (d.hit) row.hits++
        if (killed) row.kills++
        row.dmg.push(Math.round(dmg * 10) / 10); if (d.vmax != null) row.v.push(d.vmax)
        const shotNote = shots.map((s: any) => s.ok ? (s.hit ? 'попал' : 'мимо') : s.why).join('+')
        const note = killed ? 'убил' : d.hit ? 'ударил, жив' : `не ударил (${d.why || 'нет касания'})`
        row.notes[`${note} | стрелы: ${shotNote}`] = (row.notes[`${note} | стрелы: ${shotNote}`] || 0) + 1
        if (process.env.DEBUG) console.log(JSON.stringify({ d: { ...d, events: undefined, state: undefined }, shots, track: track.slice(0, 40).join(' ') }))
        console.log(`[${variant} ×${n} ${k + 1}/${N}] ${note}, урон ${dmg.toFixed(1)}, скорость ${d.vmax ?? '?'} бл/т | стрелы: ${shotNote}`)
      }
      const avg = (a: number[]) => a.length ? (a.reduce((s, x) => s + x, 0) / a.length).toFixed(1) : '-'
      console.log(`[${variant} ×${n}] заходов ${row.trials}: убил ${row.kills}, касаний ${row.hits}, урон ср. ${avg(row.dmg)}, скорость ср. ${avg(row.v)} бл/т | ${Object.entries(row.notes).map(([k, v]) => `${k} ×${v}`).join('; ')}`)
      rows.push(row)
    }
    console.log('ИТОГ ' + rows.map(r => `${r.variant} ×${r.n}: убийств ${r.kills}/${r.trials}`).join(' | '))
  } finally {
    await c.call('stop').catch(() => {})
    try { await kit.unforceload?.('overworld', [[X - R, 0, Z - R], [X + R, 0, Z + R]]) } catch {}
    for (const b of bots) b.quit('try-arrow-boost done')
    c.close()
  }
}

if (require.main === module) main().then(() => clock.wall.setTimeout(() => process.exit(0), 300)).catch(e => { console.error('FAILED', e?.stack || e); process.exit(1) })
