'use strict'
// Бегство (21.10): мост по воде (water-bridge) и рывок копьём с «Выпадом» (pvp/lunge). Беглец — демон слота
// NeuroFarm29 (8829), погоня — NeuroFarm29a (9100, crowd-fleet) с мечом, fight на беглеца. Коридор 5 бл. в стекле вдоль +x.
//   water — берег, озеро 12 бл. (вода 3 бл. глубиной), дальний берег; беглец в 2 бл. от воды, погоня в 7 бл. позади;
//           счёт: за сколько беглец на дальнем берегу, сколько снял с него преследователь, сколько блоков моста;
//   lunge — ровный коридор 60 бл.; счёт: отрыв за 8 с и время до конца коридора.
// Беглецу — RPC flee { from: [погоня] } (flee.smartFlee). «До» — демон беглеца с ND_WATER_BRIDGE=0; «Выпад» — только с ND_LUNGE=1.
//   A=ws://127.0.0.1:8829 B=ws://127.0.0.1:9100 node dist-enc/daemon/scenes/pvp/try-escape.js <water|lunge> <метка> [раундов]
//   ESC_LUNGE=1|3 — уровень «Выпада» (по умолч. 3), ESC_BLOCKS — булыжника (64).
import WebSocket = require('ws')
import * as fs from 'fs'
import path = require('path')
import * as gameClock from '../../src/game-clock'
import { REPO_ROOT } from '../../src/paths'

let clockSource = null
function client (url) {
  clockSource ??= url
  const ws = new WebSocket(url)
  let id = 0
  const pending = new Map()
  ws.on('message', raw => {
    const m = JSON.parse(raw.toString()); if (url === clockSource) gameClock.follow(m.clock || m.result?.state?.clock || m.result?.clock)
    const p = pending.get(m.id); if (!p) return
    pending.delete(m.id); m.ok ? p.resolve(m.result) : p.reject(new Error(m.error))
  })
  ws.on('error', () => {})
  const ready = new Promise<any>((resolve, reject) => { ws.once('open', resolve); ws.once('error', reject) })
  const call = (method, params: any = {}, limitMs = 90000) => new Promise<any>((resolve, reject) => {
    const rid = ++id
    const t = gameClock.wall.setTimeout(() => { if (pending.delete(rid)) reject(new Error(`${method}: нет ответа`)) }, limitMs)
    pending.set(rid, { resolve: v => { gameClock.wall.clearTimeout(t); resolve(v) }, reject: e => { gameClock.wall.clearTimeout(t); reject(e) } })
    try { ws.send(JSON.stringify({ id: rid, method, params })) } catch (e) { pending.delete(rid); reject(e) }
  })
  return { ws, ready, call }
}
const sleep = ms => gameClock.sleep(ms)
const { farmOnly, farmServer } = require('../lib/arms-guard') as typeof import('../lib/arms-guard')
farmOnly({ ws: [process.env.A] })

const MODE = process.argv[2] || 'water'
const LABEL = process.argv[3] || MODE
const ROUNDS = Number(process.argv[4] || 6)
const OUT = path.join(REPO_ROOT, 'farm', 'results', 'claude-arena', 'enc')
const LOG = path.join(OUT, `escape-${LABEL}.log`)
const log = (...a) => { const l = `[${new Date().toISOString().slice(11, 19)}] ${a.join(' ')}`; console.log(l); fs.appendFileSync(LOG, l + '\n') }
const D = { name: 'NeuroFarm29', c: client(process.env.A) }
const C = { name: 'NeuroFarm29a', c: client(process.env.B || 'ws://127.0.0.1:9100') }
async function cmd (text) { await D.c.call('say', { text }); await sleep(30) }

const X = 3000; const Y = 200; const Z = 3200
const LAKE = MODE === 'water' ? { from: X + 1, to: X + 12 } : null
const END = MODE === 'water' ? X + 13 : X + 45

async function stage () {
  // Пол — раньше воздуха: стоящих в коридоре не замуровать (воздух снизу — и они падают в будущий камень).
  await cmd(`/fill ${X - 15} ${Y - 5} ${Z - 3} ${X + 50} ${Y - 1} ${Z + 3} minecraft:stone`)
  await cmd(`/fill ${X - 15} ${Y} ${Z - 4} ${X + 50} ${Y + 6} ${Z + 4} minecraft:air`)
  if (LAKE) {
    await cmd(`/fill ${LAKE.from} ${Y - 3} ${Z - 2} ${LAKE.to} ${Y - 1} ${Z + 2} minecraft:water`)
  }
  await cmd(`/fill ${X - 15} ${Y - 5} ${Z - 3} ${X + 50} ${Y + 5} ${Z - 3} minecraft:glass`)
  await cmd(`/fill ${X - 15} ${Y - 5} ${Z + 3} ${X + 50} ${Y + 5} ${Z + 3} minecraft:glass`)
  await cmd(`/fill ${X - 15} ${Y} ${Z - 3} ${X - 15} ${Y + 5} ${Z + 3} minecraft:glass`)
  await cmd(`/kill @e[type=item,x=${X},y=${Y},z=${Z},distance=..80]`)
}

async function kit () {
  for (const w of [D.name, C.name]) { await cmd(`/clear ${w}`); await cmd(`/effect clear ${w}`) }
  for (const [s, it] of [['armor.chest', 'iron_chestplate'], ['armor.legs', 'iron_leggings'], ['armor.feet', 'iron_boots'], ['armor.head', 'iron_helmet']]) {
    await cmd(`/item replace entity ${D.name} ${s} with minecraft:${it}`); await cmd(`/item replace entity ${C.name} ${s} with minecraft:${it}`)
  }
  await cmd(`/give ${C.name} minecraft:iron_sword 1`)
  // Еда — иначе бой отказывает с порога («нет запаса еды»), погони нет.
  await cmd(`/give ${C.name} minecraft:cooked_beef 8`); await cmd(`/give ${D.name} minecraft:cooked_beef 8`)
  if (MODE === 'water') await cmd(`/give ${D.name} minecraft:cobblestone ${Number(process.env.ESC_BLOCKS || 64)}`)
  if (MODE === 'lunge') await cmd(`/give ${D.name} minecraft:iron_spear[enchantments={"minecraft:lunge":${Number(process.env.ESC_LUNGE || 3)}}] 1`)
  for (const w of [D.name, C.name]) { await cmd(`/effect give ${w} minecraft:instant_health 1 10 true`); await cmd(`/effect give ${w} minecraft:saturation 2 20 true`) }
}

async function where (c) { const s = await c.call('status', { physics: true }).catch(() => null); return s ? { p: s.detail?.physics?.pos || s.state?.pos, h: s.state?.health } : null }

async function round (n) {
  for (const b of [D, C]) await b.c.call('stop').catch(() => {})
  await stage(); await kit()
  const dx = MODE === 'water' ? X - 2 : X
  await cmd(`/tp ${D.name} ${dx + 0.5} ${Y} ${Z + 0.5} facing ${X + 40} ${Y + 1} ${Z}`)
  await cmd(`/tp ${C.name} ${dx - 6.5} ${Y} ${Z + 0.5} facing ${X + 40} ${Y + 1} ${Z}`)
  await sleep(1500)
  const t0 = gameClock.now()
  const h0 = (await where(D.c))?.h ?? 20
  let crossed = null; let gap8 = null; let hp = h0; let maxX = -Infinity; let wet = 0; const over = { done: false }
  const watch = gameClock.setInterval(async () => {
    const [d, c] = await Promise.all([where(D.c), where(C.c)])
    if (!d?.p) return
    const now = gameClock.now() - t0
    hp = Math.min(hp, d.h ?? hp); maxX = Math.max(maxX, d.p.x)
    if (LAKE && d.p.x > LAKE.from && d.p.x < LAKE.to + 1 && d.p.y < Y - 0.3) wet++
    if (c?.p && gap8 == null && now >= 8000) gap8 = Math.hypot(d.p.x - c.p.x, d.p.z - c.p.z)
    if (crossed == null && d.p.x >= END && d.p.y >= Y - 0.5) crossed = now
    if (crossed != null || now > 20000) over.done = true
  }, 100)
  const chase = (async () => { while (!over.done) { await C.c.call('fight', { target: D.name, allowPlayer: true, timeoutSeconds: 5, retreatAtHealth: 0 }).catch(() => null); await sleep(100) } })()
  let fled = null
  while (!over.done) { fled = await D.c.call('flee', { from: [C.name], timeoutSeconds: 20, safeDist: 40 }).catch(e => ({ error: e.message })); await sleep(50) }
  gameClock.clearInterval(watch)
  for (const b of [D, C]) await b.c.call('stop').catch(() => {})
  await chase
  const out = { label: LABEL, mode: MODE, round: n, crossed: crossed != null ? Math.round(crossed / 100) / 10 : null, gap8: gap8 != null ? Math.round(gap8 * 10) / 10 : null, lost: Math.round((h0 - hp) * 10) / 10, maxX: Math.round((maxX - X) * 10) / 10, wetSamples: wet, detail: fled?.detail ? { mode: fled.detail.mode, bridged: fled.detail.bridged, lunges: fled.detail.lunges } : fled?.error }
  fs.appendFileSync(path.join(OUT, `escape-${LABEL}.jsonl`), JSON.stringify(out) + '\n')
  log(JSON.stringify(out))
  await sleep(1000)
  return out
}

;(async () => {
  try {
    await D.c.ready; await C.c.ready
    for (const b of [D, C]) {
      await b.c.call('connect').catch(() => {})
      const st = await b.c.call('status')
      if (farmServer(st.detail?.server) !== 25629) throw new Error(`${b.name}: не на слоте 29`)
      await b.c.call('temper', { enabled: false }).catch(() => {}); await b.c.call('play_mode', { mode: 'free' }).catch(() => {})
    }
    for (const c of ['difficulty normal', 'gamerule spawn_mobs false', 'gamerule keep_inventory true', 'time set day', `forceload add ${X - 20} ${Z - 8} ${X + 55} ${Z + 8}`]) await cmd('/' + c)
    const res = []
    for (let n = 1; n <= ROUNDS; n++) res.push(await round(n))
    const ok = res.filter(r => r.crossed != null)
    const avg = (k, rs = res) => rs.length ? Math.round(rs.reduce((s, r) => s + (r[k] || 0), 0) / rs.length * 10) / 10 : null
    log(`[${LABEL}] ИТОГ ${res.length}: дошёл ${ok.length}, время ${avg('crossed', ok)} с, отрыв через 8 с ${avg('gap8')} бл., потерял ${avg('lost')} хп, в воде ${avg('wetSamples')} отсчётов`)
  } catch (e) { console.error('FAILED', e.stack || e.message); process.exitCode = 1 } finally {
    for (const b of [D, C]) { try { await b.c.call('stop') } catch {} ; try { b.c.ws.close() } catch {} }
    process.exit()
  }
})()
