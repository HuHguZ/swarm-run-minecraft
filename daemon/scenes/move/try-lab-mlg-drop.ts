'use strict'
import { REPO_ROOT } from '../../src/paths'
import * as gameClock from '../../src/game-clock'
// Прыжок с ведром как ход (edges.mlgDrop + сторож падения, 30.09.2026).
// Тело стоит на каменном столбе 3×3 высотой H над ровным полом в небе, цель — на полу
// в 9 блоках. Лестниц нет; кирка и булыжник в рюкзаке, так что без ведра путь
// всё равно есть — копать ступени или столб вниз. С ведром (mode=mlg) — должен
// спрыгнуть, вылить воду в последний тик, забрать её и дойти. Меряем время,
// урон, забрал ли воду, прыгал ли вообще (перепад высоты за 1 с).
// Хотбар забит — ведро в рюкзаке: его в хотбар должен переложить сам демон.
//   node dist/farm/farm.js run try-lab-mlg-drop.js --slots 1-4 --tag mlg-drop HS=8,12,16,20 MODES=mlg,none
import * as fs from 'fs'
import path = require('path')
import { connect, createKit, createServerLog, sleep } from '../lib/scene-kit'

async function main () {
  const slot = Number(process.env.FARM_SLOT)
  if (!(slot >= 1 && slot <= 32) || process.env.ND_WS !== `ws://127.0.0.1:${8800 + slot}` || process.env.MC_USERNAME !== `NeuroFarm${slot}`) throw new Error('только ферма')
  const HS = String(process.env.HS || '8,12,16,20').split(',').map(Number).filter(h => h >= 4)
  const MODES = String(process.env.MODES || 'mlg,none').split(',')
  // Грунт посадки: stone | grass (трава поверх) | leaves | slab (нижние полублоки) | snow (слой снега) | sand
  const SURFS = String(process.env.SURFS || 'stone').split(',')
  const conn = connect(process.env.ND_WS)
  await conn.ready
  const out = []
  try {
    const c0 = await conn.call('connect')
    if (c0.status !== 'done') throw new Error('connect: ' + (c0.error || c0.status))
    const st0 = await conn.call('status')
    if (st0.detail.server !== `127.0.0.1:${25600 + slot}`) throw new Error('сервер не фермы')
    const kit = createKit({ call: conn.call, heard: conn.heard, logFile: process.env.ND_SERVER_LOG, player: process.env.MC_USERNAME })
    await kit.gamerule('send_command_feedback', 'true')
    await kit.gamerule('spawn_mobs', 'false')
    await kit.gamerule('advance_time', 'false')
    await kit.cmd('/time set day')
    await kit.cmd('/weather clear')
    let k = 0
    for (const surf of SURFS) {
      for (const H of HS) {
        for (const mode of MODES) {
          k++
          out.push(await trial(conn, kit, { slot, H, mode, k, surf }))
        }
      }
    }
  } finally {
    try { await conn.call('disconnect') } catch {}
    conn.close()
  }
}

async function trial (conn, kit, { slot, H, mode, k, surf = 'stone' }: any) {
  // Стенд в небе (y 200): внизу mlg-drop-1 в рельеф натекала чужая вода, и
  // «без ведра» тело падало в неё без урона.
  const cx = 3000 + k * 48; const cz = 3000; const F = Number(process.env.FLOOR || 200)
  const r: Record<string, any> = { slot, H, mode, surf, ok: false }
  try {
    await kit.cmd('/gamemode creative')
    // Ведро прошлого захода — долой до телепорта: сторож вылил бы его в полёте.
    await kit.cmd('/clear @s')
    await kit.ensureWorld('overworld', { tp: `${cx + 0.5} ${F + H + 6} ${cz + 0.5}` })
    await kit.forceload('overworld', [[cx - 8, F, cz - 8], [cx + 16, F, cz + 8]])
    await kit.fillExact('overworld', [[cx - 6, F, cz - 6], [cx + 14, F + H + 8, cz + 6]], 'air')
    const floor = [[cx - 6, F - 1, cz - 6], [cx + 14, F - 1, cz + 6]]
    const top = [[cx - 6, F, cz - 6], [cx + 14, F, cz + 6]]
    await kit.fillExact('overworld', [[cx - 6, F - 2, cz - 6], [cx + 14, F - 2, cz + 6]], 'stone')
    if (surf === 'grass' || surf === 'snow') await kit.fillExact('overworld', floor, 'grass_block')
    else if (surf === 'leaves') await kit.fillExact('overworld', floor, 'oak_leaves[persistent=true]')
    else if (surf === 'sand') await kit.fillExact('overworld', floor, 'sand')
    else await kit.fillExact('overworld', floor, 'stone')
    if (surf === 'grass') await kit.fillExact('overworld', top, 'short_grass')
    if (surf === 'snow') await kit.fillExact('overworld', top, 'snow[layers=1]')
    if (surf === 'slab') await kit.fillExact('overworld', top, 'stone_slab[type=bottom]')
    await kit.fillExact('overworld', [[cx - 1, F, cz - 1], [cx + 1, F + H - 1, cz + 1]], 'stone')
    await kit.cmd('/clear @s')
    const bar = ['iron_sword', 'iron_pickaxe', 'cobblestone 32', 'bread 8', 'torch 16', 'oak_log 4', 'crafting_table', 'stone_axe', 'stone_shovel']
    for (let i = 0; i < 9; i++) await kit.cmd(`/item replace entity @s hotbar.${i} with minecraft:${bar[i]}`)
    await kit.cmd(`/tp @s ${cx + 0.5} ${F + H} ${cz + 0.5}`)
    await sleep(1500)
    // Ведро — когда тело уже стоит на столбе: в творческом падении при
    // постройке стенда сторож перекладывал его, и сервер откатывал клик
    // (mlg-drop-2/3: четыре захода без прыжка).
    await kit.cmd(`/item replace entity @s inventory.5 with minecraft:${mode === 'mlg' ? 'water_bucket' : 'bucket'}`)
    await sleep(300)
    await kit.cmd('/effect give @s minecraft:instant_health 1 5 true')
    await kit.cmd('/effect give @s minecraft:saturation 1 5 true')
    await kit.cmd('/gamemode survival')
    await sleep(1200)
    const s0 = (await conn.call('status')).state
    r.start = { pos: s0.pos, hp: s0.health }
    if (Math.round(s0.pos.y) !== F + H) throw new Error(`не на столбе: ${JSON.stringify(s0.pos)}`)
    // nd_mlg сейчас пишется Session в журнал демона, а не в RPC events.
    // Отметка по байтам исключает спасение прошлого захода и не смешивает часы.
    const daemonLog = createServerLog(process.env.ND_DAEMON_LOG || path.join(REPO_ROOT, 'farm', `daemon-${slot}.out.log`))
    const mlgFrom = daemonLog.mark()
    // Трек тела во время пути: минимум хп, самый быстрый спуск за 1 с.
    const track = []
    let going = true
    const poll = (async () => {
      while (going) {
        const s = await conn.call('status').catch(() => null)
        if (s && s.state) track.push({ t: gameClock.now(), y: s.state.pos.y, hp: s.state.health })
        await sleep(120)
      }
    })()
    const t0 = gameClock.now()
    const wall0 = gameClock.wall.monotonic()
    const g = await conn.call('goto', { x: cx + 9, y: F, z: cz, range: 1, timeoutSeconds: 90 })
    r.wallSecs = +((gameClock.wall.monotonic() - wall0) / 1000).toFixed(3)
    r.rate = s0.clock?.tickRate ?? null
    r.gameTicks = s0.clock && g.state?.clock ? g.state.clock.ticks - s0.clock.ticks : null
    r.serverTicks = s0.clock?.serverTicks != null && g.state?.clock?.serverTicks != null ? g.state.clock.serverTicks - s0.clock.serverTicks : null
    r.lagTicks = g.state?.clock?.lagTicks ?? null
    r.ms = gameClock.now() - t0
    await sleep(2500) // сторож забирает воду после посадки
    going = false
    await poll
    const s1 = (await conn.call('status')).state
    r.goto = { status: g.status, error: g.error || null }
    r.end = { pos: s1.pos, hp: s1.health }
    r.minHp = Math.min(...track.map(p => p.hp), s1.health)
    let jump = 0
    for (let i = 0; i < track.length; i++) {
      for (let j = i + 1; j < track.length && track[j].t - track[i].t <= 1000; j++) jump = Math.max(jump, track[i].y - track[j].y)
    }
    r.jump = Math.round(jump * 10) / 10
    r.waterBack = (s1.inventory.water_bucket || 0) > 0
    r.bucketEmpty = (s1.inventory.bucket || 0) > 0
    r.dug = Math.max(0, 32 - (s1.inventory.cobblestone || 0)) // сколько булыжника ушло в столбы/мосты
    const mlg = []
    for (const l of daemonLog.linesFrom(mlgFrom).lines) {
      const match = /\[mlg\]\s+(\{.*\})\s*$/.exec(l.text)
      if (match) { try { const e = JSON.parse(match[1]); if (e.what) mlg.push(e) } catch {} }
    }
    r.mlgFired = mlg.some(e => e.what === 'fired')
    r.mlgEvents = mlg
    r.died = g.by?.type === 'death' || conn.heard.some(e => e.type === 'death' && (e.gameAt ?? e.at ?? 0) >= t0)
    const arrived = Math.abs(s1.pos.x - (cx + 9.5)) <= 2 && Math.abs(s1.pos.z - (cz + 0.5)) <= 2 && Math.abs(s1.pos.y - F) <= 1
    r.arrived = arrived
    r.ok = arrived && s1.health > 0 && !r.died && (mode !== 'mlg' || (r.mlgFired && r.waterBack))
  } catch (e) { r.error = e.message }
  fs.appendFileSync(process.env.LAB_OUT, JSON.stringify(r) + '\n')
  console.log(JSON.stringify({ slot: r.slot, H: r.H, mode: r.mode, surf: r.surf, ok: r.ok, rate: r.rate, gameTicks: r.gameTicks, ms: r.ms, wallSecs: r.wallSecs, jump: r.jump, minHp: r.minHp, hp: r.end && r.end.hp, died: r.died, water: r.waterBack, mlg: r.mlgFired, goto: r.goto && r.goto.status, error: r.error }))
  return r
}

main().catch(e => { console.error(e); process.exitCode = 1 })
