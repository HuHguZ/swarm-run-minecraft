'use strict'
import * as gameClock from '../../src/game-clock'
// Жемчуг в прыжке (06.10): серия бросков на дальние цели с места, в прыжке на месте и с разбега. Полоса камня в
// небе на север от старта, цель — точка на полу; правда из игры — куда перенесло (forcedMove). Меряем ошибку
// прогноза (точка переноса throwAt против факта), дальность (старт → факт) и попадание в площадку 3×3 у цели.
//   node dist/farm/farm.js run try-pearl-jump.js --slots N --tag pj-1   (на ферме: ND_WS, LAB_OUT)
//   REPEAT=3 — бросков на каждый случай.
import * as fs from 'fs'
import WebSocket = require('ws')

const ws = new WebSocket(process.env.ND_WS || 'ws://127.0.0.1:8767')
let id = 0
const pending = new Map()
const call = (method, params: any = {} as Record<string, any>) => new Promise<any>((resolve, reject) => {
  const rid = ++id
  pending.set(rid, { resolve, reject })
  ws.send(JSON.stringify({ id: rid, method, params }))
})
ws.on('message', raw => {
  const m = JSON.parse(raw.toString()); gameClock.follow(m.clock || m.result?.state?.clock || m.result?.clock)
  const p = pending.get(m.id)
  if (!p) return
  pending.delete(m.id)
  m.ok ? p.resolve(m.result) : p.reject(new Error(m.error))
})
const sleep = ms => gameClock.sleep(ms)
async function cmd (text) { await call('say', { text }); await sleep(300) }

const X = 0; const Y = 220; const Z = 0
const REPEAT = Number(process.env.REPEAT || 3)
// [дальность, как бросать]: still — с места; auto — прыжок, только если с места не долетает; run — auto с разбегом.
const CASES: [number, string][] = [
  [45, 'still'], [50, 'still'], [58, 'still'],
  [45, 'auto'], [58, 'auto'], [63, 'auto'],
  [50, 'jump'],
  [72, 'run'], [82, 'run'], [88, 'run']
]
const r2 = x => x == null ? null : Math.round(x * 100) / 100

async function setup () {
  await call('connect')
  await call('temper', { enabled: false }).catch(() => {})
  await cmd(`/tp @s ${X + 0.5} ${Y + 2} ${Z + 0.5}`)
  await sleep(1500)
  await cmd('/gamerule spawn_mobs false')
  await cmd('/kill @e[type=!player,distance=..120]')
  // Полоса 13 × 107: пол y−1, воздух до y+30 (два fill по ≤ 32768).
  await cmd(`/fill ${X - 6} ${Y - 1} ${Z - 100} ${X + 6} ${Y - 1} ${Z + 6} minecraft:stone`)
  await cmd(`/fill ${X - 6} ${Y} ${Z - 100} ${X + 6} ${Y + 14} ${Z + 6} minecraft:air`)
  await cmd(`/fill ${X - 6} ${Y + 15} ${Z - 100} ${X + 6} ${Y + 30} ${Z + 6} minecraft:air`)
  await cmd('/effect give @s minecraft:resistance 99999 4 true')
  await cmd('/effect give @s minecraft:saturation 99999 1 true')
  await cmd('/clear @s')
  await cmd('/give @s minecraft:ender_pearl 64')
}

async function one (dist, how, k) {
  // Площадка 3×3 у цели — видно в мире; на полосе всё камень, посадка безопасна.
  const tz = Z - dist
  await cmd(`/fill ${X - 1} ${Y - 1} ${tz - 1} ${X + 1} ${Y - 1} ${tz + 1} minecraft:gold_block`)
  await cmd(`/tp @s ${X + 0.5} ${Y} ${Z + 0.5} 180 0`)
  await sleep(800)
  const to = { x: X + 0.5, y: Y, z: tz + 0.5 }
  const params: any = { item: 'ender_pearl', to }
  if (how !== 'still') { params.jump = how === 'jump' ? true : 'auto'; params.sprint = how === 'run' }
  const r: any = await call('throw', params).catch(e => ({ error: e.message }))
  const d = r.detail || r
  const landed = d.landed
  const row = {
    case: `${how}-${dist}`, k, how, dist, thrown: !!d.thrown, why: d.why || d.error || null, jump: d.jump ?? null,
    moved: d.moved || null, airborne: d.airborne ?? null, pitchDeg: d.pitchDeg ?? null, ticks: d.ticks ?? null,
    predicted: d.land || null, landed: landed || null,
    modelErr: d.modelErr ?? null, // прогноз переноса против факта
    err: d.err ?? null, // факт против цели
    range: landed ? r2(Math.hypot(landed.x - (X + 0.5), landed.z - (Z + 0.5))) : null,
    pad: landed ? Math.abs(landed.x - to.x) <= 1.5 && Math.abs(landed.z - to.z) <= 1.5 : false
  }
  if (process.env.LAB_OUT) fs.appendFileSync(process.env.LAB_OUT, JSON.stringify(row) + '\n')
  console.log(`${row.case} #${k}: ${row.thrown ? `прыжок ${row.jump || '—'}, дальность ${row.range}, промах ${r2(row.err)}, модель ${r2(row.modelErr)}${row.pad ? ' ПЛОЩАДКА' : ''}` : 'не бросил: ' + row.why}`)
  await cmd(`/fill ${X - 1} ${Y - 1} ${tz - 1} ${X + 1} ${Y - 1} ${tz + 1} minecraft:stone`)
  await sleep(1200)
  return row
}

ws.on('open', async () => {
  try {
    await setup()
    const rows = []
    for (const [dist, how] of CASES) for (let k = 1; k <= REPEAT; k++) rows.push(await one(dist, how, k))
    console.log('\n=== сводка: случай | брошено | прыжок | дальность ср | промах ср | модель ср/макс | площадка')
    const groups = new Map()
    for (const r of rows) { if (!groups.has(r.case)) groups.set(r.case, []); groups.get(r.case).push(r) }
    const avg = a => a.length ? r2(a.reduce((s, x) => s + x, 0) / a.length) : null
    for (const [c, g] of groups) {
      const ok = g.filter(r => r.landed)
      const me = ok.map(r => r.modelErr).filter(x => x != null)
      console.log(`${c} | ${g.filter(r => r.thrown).length}/${g.length} | ${[...new Set(g.map(r => r.jump || '—'))].join(',')} | ` +
        `${avg(ok.map(r => r.range))} | ${avg(ok.map(r => r.err))} | ${avg(me)}/${me.length ? r2(Math.max(...me)) : null} | ${g.filter(r => r.pad).length}/${g.length}`)
    }
  } catch (e) {
    console.error('FAILED:', e.stack || e.message)
    process.exitCode = 1
  } finally {
    ws.close()
  }
})
ws.on('error', e => { console.error('ws:', e.message); process.exitCode = 1 })
