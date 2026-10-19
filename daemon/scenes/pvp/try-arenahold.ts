'use strict'
import * as gameClock from '../../src/game-clock'
// Арена: держать поле и возвращаться на него (2026-09-27, пользователь:
// «один упал, второй его скинул и сам спрыгнул на его колонну, стал рукой
// бить булыжник; тот внизу поднял голову и ничего не делал; нет блоков —
// программа выживания; ночью мобы бьют упавшего — он не сопротивляется»).
// Поле — обсидиан (±12) на Y−1 с дырой 2×2, земля в 21 блоке ниже (три слоя:
// камень, земля, дёрн). Бой с геометрией поля (fight.arena).
//   Сцены: «держу» — B упал в дыру (блоки есть), A на поле у дыры: A не должен
//   сходить с поля, B — вернуться. «без блоков» — B внизу без блоков: добыть и
//   подняться. «мобы» — A внизу, рядом кадавры (husk), B на поле: A бьёт их,
//   потом поднимается.
//   A=ws://127.0.0.1:88NN B=ws://127.0.0.1:89NN MC_PORT=256NN node try-arenahold.js [сцена]   (только слот фермы NN, arms-guard)
import WebSocket = require('ws')
// Both bots share server ticks; keep the first connection as the time source.
let clockSource = null
function client (url) {
  clockSource ??= url
  const ws = new WebSocket(url)
  let id = 0
  const pending = new Map()
  ws.on('message', raw => {
    const m = JSON.parse(raw.toString()); if (url === clockSource) gameClock.follow(m.clock || m.result?.state?.clock || m.result?.clock)
    const p = pending.get(m.id)
    if (!p) return
    pending.delete(m.id)
    m.ok ? p.resolve(m.result) : p.reject(new Error(m.error))
  })
  const ready = new Promise<any>((resolve, reject) => { ws.once('open', resolve); ws.once('error', reject) })
  const call = (method, params: any = {} as Record<string, any>) => new Promise<any>((resolve, reject) => {
    const rid = ++id
    pending.set(rid, { resolve, reject })
    ws.send(JSON.stringify({ id: rid, method, params }))
  })
  return { ws, ready, call }
}
const sleep = ms => gameClock.sleep(ms)
;(require('../lib/arms-guard') as typeof import('../lib/arms-guard')).farmOnly({ ws: [process.env.A, process.env.B] })
const A = client(process.env.A)
const B = client(process.env.B)
async function cmd (text) { await B.call('say', { text }); await sleep(40) }
const X = 1000; const Y = 170; const Z = 1700
const DEPTH = Number(process.env.DEPTH || 20)
const SECONDS = Number(process.env.SECONDS || 90)
const ARENA = { x: X + 0.5, y: Y, z: Z + 0.5, r: 12 }
const G = Y - DEPTH - 1

async function stage () {
  await cmd(`/fill ${X - 16} ${G - 2} ${Z - 16} ${X + 16} ${Y + 4} ${Z + 16} minecraft:air`)
  await cmd(`/fill ${X - 16} ${G - 2} ${Z - 16} ${X + 16} ${G - 2} ${Z + 16} minecraft:stone`)
  await cmd(`/fill ${X - 16} ${G - 1} ${Z - 16} ${X + 16} ${G - 1} ${Z + 16} minecraft:dirt`)
  await cmd(`/fill ${X - 16} ${G} ${Z - 16} ${X + 16} ${G} ${Z + 16} minecraft:grass_block`)
  await cmd(`/fill ${X - 12} ${Y - 1} ${Z - 12} ${X + 12} ${Y - 1} ${Z + 12} minecraft:obsidian`)
  await cmd(`/fill ${X + 6} ${Y - 1} ${Z} ${X + 7} ${Y - 1} ${Z + 1} minecraft:air`)
  // Свет на поле и внизу — мобы не родятся сами.
  for (const [dx, dz] of [[-8, -8], [-8, 8], [8, -8], [8, 8], [0, 0]]) await cmd(`/setblock ${X + dx} ${G + 1} ${Z + dz} minecraft:torch`)
  await cmd(`/kill @e[type=!player,x=${X},y=${Y},z=${Z},distance=..60]`)
}

async function kit (who, { blocks = true, pick = true }: any = {} as Record<string, any>) {
  await cmd(`/clear ${who}`); await cmd(`/effect clear ${who}`)
  for (const it of ['diamond_sword', ...(pick ? ['diamond_pickaxe'] : []), 'bow', 'arrow 32', 'golden_apple 2']) { const [n, c] = it.split(' '); await cmd(`/give ${who} minecraft:${n} ${c || 1}`) }
  if (blocks) await cmd(`/give ${who} minecraft:cobblestone 64`)
  await cmd(`/item replace entity ${who} weapon.offhand with minecraft:shield`)
  await cmd(`/item replace entity ${who} armor.chest with minecraft:iron_chestplate`)
  await cmd(`/item replace entity ${who} armor.head with minecraft:iron_helmet`)
}

async function scene (name) {
  await cmd('/difficulty ' + (name === 'мобы' ? 'normal' : 'peaceful'))
  await stage()
  await kit('NeuroDown', { blocks: name !== 'мобы' ? true : false })
  await kit('NeuroDown2', { blocks: name !== 'без блоков', pick: !(name === 'под полом' && process.env.NOPICK) })
  if (name === 'мобы') {
    await cmd(`/give NeuroDown minecraft:cobblestone 40`)
    await cmd(`/tp NeuroDown ${X + 6.5} ${G + 1} ${Z + 0.5}`)
    await cmd(`/tp NeuroDown2 ${X - 4.5} ${Y} ${Z + 0.5}`)
    for (const [dx, dz] of [[3, 3], [-2, 4], [4, -3]]) await cmd(`/summon husk ${X + 6 + dx} ${G + 1} ${Z + dz} {PersistenceRequired:1b}`)
  } else if (name === 'под полом') {
    // Свой столб под сплошным полом (живая арена 2026-09-27): до дыры с верхушки не дойти.
    await cmd(`/fill ${X - 3} ${G + 1} ${Z - 3} ${X - 3} ${Y - 4} ${Z - 3} minecraft:cobblestone`)
    await cmd(`/tp NeuroDown ${X + 3.5} ${Y} ${Z + 0.5}`)
    await cmd(`/tp NeuroDown2 ${X - 2.5} ${Y - 3} ${Z - 2.5}`)
  } else {
    await cmd(`/tp NeuroDown ${X + 3.5} ${Y} ${Z + 0.5}`)
    await cmd(`/tp NeuroDown2 ${X + 6.5} ${G + 1} ${Z + 0.5}`)
  }
  for (const who of ['NeuroDown', 'NeuroDown2']) { await cmd(`/effect give ${who} minecraft:instant_health 1 10 true`); await cmd(`/effect give ${who} minecraft:saturation 1 20 true`) }
  await sleep(1500)
  const t0 = gameClock.now()
  const track: Record<string, any> = { aMinY: 1e9, bBackAt: 0, aBackAt: 0, bMinY: 1e9 }
  let polling = true
  const poll = (async () => {
    while (polling) {
      try {
        const sa = ((await A.call('status')) as any).state || {} as Record<string, any>
        const sb = ((await B.call('status')) as any).state || {} as Record<string, any>
        if (sa.pos) { track.aMinY = Math.min(track.aMinY, sa.pos.y); if (name === 'мобы' && !track.aBackAt && sa.pos.y >= Y - 0.2) track.aBackAt = gameClock.now() - t0 }
        if (sb.pos) { track.bMinY = Math.min(track.bMinY, sb.pos.y); if (name !== 'мобы' && !track.bBackAt && sb.pos.y >= Y - 0.2) track.bBackAt = gameClock.now() - t0 }
      } catch {}
      await sleep(250)
    }
  })()
  const fa = A.call('fight', { target: 'NeuroDown2', allowPlayer: true, timeoutSeconds: SECONDS, retreatAtHealth: 1, arena: ARENA }).catch(e => ({ status: 'failed', error: e.message }))
  const fb = B.call('fight', { target: 'NeuroDown', allowPlayer: true, timeoutSeconds: SECONDS, retreatAtHealth: 1, arena: ARENA }).catch(e => ({ status: 'failed', error: e.message }))
  const [ra, rb] = await Promise.all([fa, fb])
  polling = false
  await poll
  await A.call('stop').catch(() => {}); await B.call('stop').catch(() => {})
  const pick = (r) => { const d = (r && r.detail) || {} as Record<string, any>; return Object.entries<any>(d.tricks || {} as Record<string, any>).filter(([k]: any) => /поле|держу|верн|добы|блок|husk|моб|сперва|убил|спрыгн|столб|подъём/.test(k)).map(([k, v]: any) => `${k}×${v}`).join(', ') || '-' }
  const dd = (r) => (r && r.detail) || {} as Record<string, any>
  console.log(`[${name}] A ${ra.status}, мин. высота A ${track.aMinY.toFixed(1)} (пол ${Y}); B ${rb.status}, мин. высота B ${track.bMinY.toFixed(1)}`)
  if (name === 'мобы') console.log(`   A: мобов убил ${dd(ra).mobKills || 0}, вернулся ${track.aBackAt ? 'за ' + (track.aBackAt / 1000).toFixed(1) + ' с' : 'нет'}`)
  else console.log(`   B вернулся на поле: ${track.bBackAt ? 'за ' + (track.bBackAt / 1000).toFixed(1) + ' с' : 'нет'}; добыл блоков ${dd(rb).gathered || 0}; A держал поле ${dd(ra).holds || 0} раз`)
  console.log(`   A: ${pick(ra)}`)
  console.log(`   B: ${pick(rb)}`)
}

;(async () => {
  try {
    await A.ready; await B.ready
    await A.call('connect').catch(() => {}); await B.call('connect').catch(() => {})
    await A.call('temper', { enabled: false }).catch(() => {}); await B.call('temper', { enabled: false }).catch(() => {})
    await A.call('stop').catch(() => {}); await B.call('stop').catch(() => {})
    await cmd('/gamerule send_command_feedback false')
    await cmd('/time set day')
    await cmd(`/forceload add ${X - 20} ${Z - 20} ${X + 20} ${Z + 20}`)
    const which = process.argv[2] ? [process.argv[2]] : ['держу', 'без блоков', 'мобы']
    for (const s of which) await scene(s)
    await cmd('/difficulty peaceful')
    await cmd(`/forceload remove ${X - 20} ${Z - 20} ${X + 20} ${Z + 20}`)
    await cmd('/gamerule send_command_feedback true')
  } catch (e) {
    console.error('FAILED', e.stack || e.message)
    process.exitCode = 1
  } finally {
    A.ws.close(); B.ws.close()
    gameClock.wall.setTimeout(() => process.exit(process.exitCode || 0), 300)
  }
})()
