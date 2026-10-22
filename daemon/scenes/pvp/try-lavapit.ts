'use strict'
// Выход из лавы (21.10, стенд 15×15: «tried to swim in lava»): бот в середине ямы лавы 3×3 вровень с полом (кольцо магмы,
// как на Колизее) или в разливе лавы из ведра на поле; выход — RPC lava_escape (pvp/lava-exit, без pathfinder'а) или,
// как было на арене, goto на 3 бл. Счёт: вышел ли, за сколько, сколько хп снято, жив ли.
//   A=ws://127.0.0.1:8829 node dist-enc/daemon/scenes/pvp/try-lavapit.js <escape|goto> <pit|spill> <метка> [раундов]
import WebSocket = require('ws')
import * as fs from 'fs'
import path = require('path')
import * as gameClock from '../../src/game-clock'
import { REPO_ROOT } from '../../src/paths'

const ws = new WebSocket(process.env.A)
let id = 0
const pending = new Map()
ws.on('message', raw => { const m = JSON.parse(raw.toString()); gameClock.follow(m.clock || m.result?.state?.clock || m.result?.clock); const p = pending.get(m.id); if (!p) return; pending.delete(m.id); m.ok ? p.resolve(m.result) : p.reject(new Error(m.error)) })
const call = (method, params: any = {}) => new Promise<any>((resolve, reject) => { const rid = ++id; pending.set(rid, { resolve, reject }); ws.send(JSON.stringify({ id: rid, method, params })) })
const sleep = ms => gameClock.sleep(ms)
const { farmOnly, farmServer } = require('../lib/arms-guard') as typeof import('../lib/arms-guard')
farmOnly({ ws: [process.env.A] })

const [HOW = 'escape', KIND = 'pit', LABEL = 'pit', ROUNDS_S = '8'] = process.argv.slice(2)
const ROUNDS = Number(ROUNDS_S)
const OUT = path.join(REPO_ROOT, 'farm', 'results', 'claude-arena', 'enc')
const NAME = 'NeuroFarm29'
const X = 3000; const Y = 200; const Z = 3400
async function cmd (text) { await call('say', { text }); await sleep(30) }

async function stage () {
  await cmd(`/fill ${X - 8} ${Y - 3} ${Z - 8} ${X + 8} ${Y - 1} ${Z + 8} minecraft:sand`)
  await cmd(`/fill ${X - 8} ${Y} ${Z - 8} ${X + 8} ${Y + 5} ${Z + 8} minecraft:air`)
  if (KIND === 'pit') {
    await cmd(`/fill ${X - 2} ${Y - 1} ${Z - 2} ${X + 2} ${Y - 1} ${Z + 2} minecraft:magma_block`)
    await cmd(`/fill ${X - 1} ${Y - 2} ${Z - 1} ${X + 1} ${Y - 2} ${Z + 1} minecraft:sandstone`)
    await cmd(`/fill ${X - 1} ${Y - 1} ${Z - 1} ${X + 1} ${Y - 1} ${Z + 1} minecraft:lava`)
  }
}

;(async () => {
  try {
    await new Promise(r => ws.once('open', r))
    await call('connect').catch(() => {})
    const st = await call('status')
    if (farmServer(st.detail?.server) !== 25629) throw new Error('не слот 29')
    await call('temper', { enabled: false }).catch(() => {})
    for (const c of ['difficulty normal', 'gamerule keep_inventory true', 'gamerule immediate_respawn true', `forceload add ${X - 10} ${Z - 10} ${X + 10} ${Z + 10}`]) await cmd('/' + c)
    const res = []
    for (let n = 1; n <= ROUNDS; n++) {
      await call('stop').catch(() => {})
      await stage()
      await cmd(`/clear ${NAME}`); await cmd(`/effect clear ${NAME}`)
      await cmd(`/effect give ${NAME} minecraft:instant_health 1 10 true`); await cmd(`/effect give ${NAME} minecraft:saturation 1 20 true`)
      await cmd(`/give ${NAME} minecraft:cooked_beef 8`)
      await cmd(`/tp ${NAME} ${X + 0.5} ${Y} ${Z + 0.5} ${n * 70} 0`)
      if (KIND === 'spill') { await sleep(300); await cmd(`/setblock ${X} ${Y} ${Z} minecraft:lava`) }
      await sleep(KIND === 'spill' ? 900 : 300)
      const t0 = gameClock.now()
      const h0 = 20
      let out = null
      const r = HOW === 'goto'
        ? await call('goto', { x: X + 0.5 + Math.cos(n) * 3, y: Y + 1, z: Z + 0.5 + Math.sin(n) * 3, range: 1.5, timeoutSeconds: 3 }).catch(e => ({ error: e.message }))
        : await call('lava_escape', { limitMs: 2500 }).catch(e => ({ error: e.message }))
      await sleep(800)
      const s = await call('status', { physics: true }).catch(() => null)
      const dead = (s?.events || []).some(e => e && e.type === 'death')
      const p = s?.detail?.physics
      out = { label: LABEL, how: HOW, kind: KIND, round: n, ms: gameClock.now() - t0, hp: s?.state?.health, dead, inLava: !!p?.isInLava, pos: p?.pos, r: r?.detail || r?.error || r?.status }
      fs.appendFileSync(path.join(OUT, `lavapit-${LABEL}.jsonl`), JSON.stringify(out) + '\n')
      console.log(JSON.stringify(out))
      res.push(out)
      await sleep(500)
    }
    const alive = res.filter(r => !r.dead)
    console.log(`[${LABEL}] ИТОГ ${res.length}: жив ${alive.length}, хп в конце ${Math.round(alive.reduce((a, r) => a + (r.hp || 0), 0) / Math.max(1, alive.length) * 10) / 10}`)
  } catch (e) { console.error('FAILED', e.stack || e.message); process.exitCode = 1 } finally { try { await call('stop') } catch {} ; ws.close(); process.exit() }
})()
