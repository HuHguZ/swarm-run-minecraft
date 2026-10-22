'use strict'
// Толпа на одного (21.10, пользователь: «боты-дурачки бегут через него за лутом, тупят у стен и стоят»): защитник
// NeuroFarm29 (демон слота, 8829) против N нападающих со всех сторон — меч со щитом, топор, лучник, элитры с копьём,
// булава с зарядами ветра. Нападающим — fight на защитника; защитнику — fight кусками по 3 с со всеми целями, как зовёт
// арена (swarm-driver: { target, targets, allowPlayer, allowRanged, timeoutSeconds: 3, arena }).
// Поле — плита камня ±16 на высоте 200: три стороны — стекло, восток — обрыв (падение смертельно), лава 3×3, стенки,
// столб, узкий проход. Счёт раунда: жив ли и сколько, урон нанесён/получен, секунды без дела (за секунду сдвинулся
// < 0.5 бл. и никому не снял хп), упоры (клавиша хода нажата, а тело стоит ≥ 0.3 с), лава/обрыв, решения боя.
//   node dist-enc/daemon/scenes/pvp/crowd-fleet.js up 5
//   A=ws://127.0.0.1:8829 node dist-enc/daemon/scenes/pvp/try-crowd.js <метка> [раундов] [нападающих]
//   CROWD_S — длина раунда (60 с).
import WebSocket = require('ws')
import * as fs from 'fs'
import path = require('path')
import * as gameClock from '../../src/game-clock'
import { REPO_ROOT } from '../../src/paths'
import { fighter, portOpen, MC_PORT } from './crowd-fleet'

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
  ws.on('error', () => {})
  const ready = new Promise<any>((resolve, reject) => { ws.once('open', resolve); ws.once('error', reject) })
  const call = (method, params: any = {}, limitMs = method === 'fight' || method === 'fly_to' ? 120000 : 15000) => new Promise<any>((resolve, reject) => {
    const rid = ++id
    const t = gameClock.wall.setTimeout(() => { if (pending.delete(rid)) reject(new Error(`${method}: нет ответа ${limitMs} мс`)) }, limitMs)
    pending.set(rid, { resolve: (v) => { gameClock.wall.clearTimeout(t); resolve(v) }, reject: (e) => { gameClock.wall.clearTimeout(t); reject(e) } })
    try { ws.send(JSON.stringify({ id: rid, method, params })) } catch (e) { pending.delete(rid); reject(e) }
  })
  return { ws, ready, call }
}
const sleep = ms => gameClock.sleep(ms)
const { farmOnly, farmServer } = require('../lib/arms-guard') as typeof import('../lib/arms-guard')
farmOnly({ ws: [process.env.A] })

const LABEL = process.argv[2] || 'run'
const ROUNDS = Number(process.argv[3] || 4)
const N = Math.max(1, Math.min(7, Number(process.argv[4] || 5)))
const ROUND_MS = Number(process.env.CROWD_S || 60) * 1000
const OUT = path.join(REPO_ROOT, 'farm', 'results', 'claude-arena', 'enc')
fs.mkdirSync(OUT, { recursive: true })
const LOG = path.join(OUT, `crowd-${LABEL}.log`)
const JSONL = path.join(OUT, `crowd-${LABEL}.jsonl`)
const log = (...a) => { const l = `[${new Date().toISOString().slice(11, 19)}] ${a.join(' ')}`; console.log(l); fs.appendFileSync(LOG, l + '\n') }

const X = 3000; const Y = 200; const Z = 3000; const R = 16
const ARENA = { x: X + 0.5, y: Y, z: Z + 0.5, r: R }
const HOLD = { x: X + 60, y: Y, z: Z }
const SERVER_LOG = path.join(REPO_ROOT, 'farm', 'server-29', 'logs', 'latest.log')
const D = { name: 'NeuroFarm29', c: client(process.env.A) }
const FOES = Array.from({ length: N }, (_, k) => ({ ...fighter(k), c: null as any, role: '' }))
async function cmd (text) { await D.c.call('say', { text }); await sleep(30) }

// Роли нападающих по кругу.
const ROLES = process.env.CROWD_ROLES ? process.env.CROWD_ROLES.split(',') : ['меч-щит', 'лучник', 'элитры', 'топор', 'булава', 'меч', 'лучник']
const ARMOR = ['iron_helmet', 'iron_chestplate', 'iron_leggings', 'iron_boots']
const SLOTS = { helmet: 'armor.head', chestplate: 'armor.chest', leggings: 'armor.legs', boots: 'armor.feet' }
const splash = (p) => `splash_potion[potion_contents={potion:"minecraft:${p}"}]`
const KIT = {
  defender: { off: 'shield', items: ['iron_sword', 'iron_pickaxe', 'cobblestone 64', 'cooked_beef 16', 'golden_apple 2', splash('strong_harming'), splash('strong_harming'), splash('strong_poison'), splash('weakness'), splash('slowness')] },
  'меч-щит': { off: 'shield', items: ['iron_sword', 'cooked_beef 8'] },
  'лучник': { items: ['bow', 'arrow 64', 'iron_sword', 'cooked_beef 8'] },
  'элитры': { items: ['elytra', 'firework_rocket 32', 'iron_spear', 'iron_sword', 'cooked_beef 8'] },
  'топор': { items: ['iron_axe', 'iron_sword', 'cooked_beef 8'] },
  'булава': { items: ['mace', 'wind_charge 16', 'iron_sword', 'cooked_beef 8'] },
  'меч': { items: ['iron_sword', 'cooked_beef 8'] }
}

async function stage () {
  await cmd(`/fill ${X - R - 2} ${Y} ${Z - R - 2} ${X + R + 2} ${Y + 18} ${Z + R + 2} minecraft:air`)
  await cmd(`/fill ${X - R} ${Y - 4} ${Z - R} ${X + R} ${Y - 1} ${Z + R} minecraft:stone`)
  await cmd(`/fill ${X + R + 1} ${Y - 4} ${Z - R - 1} ${X + R + 2} ${Y - 1} ${Z + R + 1} minecraft:air`)
  // Стекло по трём сторонам; восток (x > X+R) — обрыв.
  await cmd(`/fill ${X - R - 1} ${Y - 4} ${Z - R - 1} ${X + R} ${Y + 16} ${Z - R - 1} minecraft:glass`)
  await cmd(`/fill ${X - R - 1} ${Y - 4} ${Z + R + 1} ${X + R} ${Y + 16} ${Z + R + 1} minecraft:glass`)
  await cmd(`/fill ${X - R - 1} ${Y - 4} ${Z - R - 1} ${X - R - 1} ${Y + 16} ${Z + R + 1} minecraft:glass`)
  // Лава 3×3 в полу (юго-запад), стенка, угол, столб, узкий проход (север-восток).
  await cmd(`/fill ${X - 8} ${Y - 1} ${Z + 5} ${X - 6} ${Y - 1} ${Z + 7} minecraft:lava`)
  await cmd(`/fill ${X + 5} ${Y} ${Z - 6} ${X + 5} ${Y + 2} ${Z - 1} minecraft:stone`)
  await cmd(`/fill ${X - 11} ${Y} ${Z - 11} ${X - 6} ${Y + 2} ${Z - 11} minecraft:stone`)
  await cmd(`/fill ${X - 11} ${Y} ${Z - 11} ${X - 11} ${Y + 2} ${Z - 6} minecraft:stone`)
  await cmd(`/fill ${X - 2} ${Y} ${Z + 9} ${X - 2} ${Y + 2} ${Z + 9} minecraft:stone`)
  await cmd(`/fill ${X + 3} ${Y} ${Z + 10} ${X + 10} ${Y + 2} ${Z + 10} minecraft:stone`)
  await cmd(`/fill ${X + 3} ${Y} ${Z + 12} ${X + 10} ${Y + 2} ${Z + 12} minecraft:stone`)
  for (const [dx, dz] of [[-12, 12], [12, -12], [0, 0], [-12, -2], [10, 6]]) await cmd(`/setblock ${X + dx} ${Y + 4} ${Z + dz} minecraft:glowstone`)
  await cmd(`/kill @e[type=!player,x=${X},y=${Y},z=${Z},distance=..80]`)
}

async function equip (who, kit) {
  await cmd(`/clear ${who}`)
  await cmd(`/effect clear ${who}`)
  for (const a of ARMOR) await cmd(`/item replace entity ${who} ${SLOTS[a.replace(/^.*_/, '')]} with minecraft:${a}`)
  if (kit.off) await cmd(`/item replace entity ${who} weapon.offhand with minecraft:${kit.off}`)
  for (const it of kit.items) { const m = it.match(/^(\S+)(?: (\d+))?$/); await cmd(`/give ${who} minecraft:${m[1]} ${m[2] || 1}`) }
}

async function probe (c, physics = false) {
  const st = await c.call('status', physics ? { physics: true } : {}).catch(() => null)
  if (!st) return null
  const dead = (st.events || []).some(e => e && e.type === 'death')
  const s = st.state || {}
  const pos = st.detail?.physics?.pos || s.position || s.pos || null
  return { h: typeof s.health === 'number' ? s.health : null, dead, pos, ph: st.detail?.physics || null }
}
const diedIn = r => !!(r && ((r.detail && r.detail.died) || (r.status === 'interrupted' && r.by && r.by.type === 'death') || (r.events || []).some(e => e && e.type === 'death')))
const hd = (a, b) => a && b ? Math.hypot(a.x - b.x, a.z - b.z) : Infinity

// Счёт раунда по опросу раз в 100 мс игрового времени.
function meter (t0) {
  const m = { taken: 0, dealt: 0, idleS: 0, bumps: 0, bumpS: 0, lava: 0, fell: false, samples: 0, still: 0 }
  let hpD = null; const hpF = {}
  let sec = { t: t0, from: null, dealt: 0 }
  let last = null; let bumpRun = 0
  return {
    m,
    sample (now, d, foes) {
      m.samples++
      if (d && d.h != null) { if (hpD != null && d.h < hpD) m.taken += hpD - d.h; hpD = d.h }
      let dealt = 0
      for (const [name, f] of Object.entries<any>(foes)) {
        if (!f || f.h == null) continue
        if (hpF[name] != null && f.h < hpF[name]) dealt += hpF[name] - f.h
        hpF[name] = f.h
      }
      m.dealt += dealt; sec.dealt += dealt
      const pos = d && d.pos
      if (pos) {
        if (!sec.from) sec.from = pos
        if (now - sec.t >= 1000) {
          if (hd(pos, sec.from) < 0.5 && sec.dealt < 0.5) m.idleS++
          sec = { t: now, from: pos, dealt: 0 }
        }
        const ph = d.ph
        const keys = ph && ph.controls && (ph.controls.forward || ph.controls.back || ph.controls.left || ph.controls.right)
        const moved = last ? hd(pos, last) : 1
        if (keys && moved < 0.04 && ph.onGround) { bumpRun++; if (bumpRun === 3) m.bumps++; if (bumpRun >= 3) m.bumpS += 0.1 } else bumpRun = 0
        if (!keys && moved < 0.02) m.still++
        if (ph && ph.isInLava) m.lava++
        if (pos.y < Y - 3 && d.h > 0) m.fell = true
        last = pos
      }
    }
  }
}

async function round (n) {
  const all = [D, ...FOES]
  await Promise.all(all.map(b => b.c.call('stop').catch(() => {})))
  await Promise.all(all.map(b => b.c.call('connect').catch(() => {})))
  for (const b of all) for (let i = 0; i < 20; i++) { const p = await probe(b.c); if (p && p.h > 0) break; await sleep(500) }
  await stage()
  // Поднятые, но не занятые в раунде бойцы флота — в загон, не на поле.
  for (let k = N; k < 7; k++) await cmd(`/tp ${fighter(k).name} ${HOLD.x} ${HOLD.y} ${HOLD.z}`)
  await equip(D.name, KIT.defender)
  for (const f of FOES) await equip(f.name, KIT[f.role])
  // Нападающие — с равных углов (сдвиг угла от раунда к раунду), лучник дальше, элитры — с края поля.
  // CROWD_START=lava — защитник в 1.5 бл. к востоку от ямы лавы (вровень с полом, как на Колизее), нападающие — дугой с
  // востока: удары кидают его к лаве (стенд 15×15 a24: «tried to swim in lava» после серии ударов).
  // CROWD_START=edge — защитник в 5 бл. от обрыва (восток), нападающие — дугой с запада в 9 бл. (рой скидывает нарочно).
  const LAVA_START = process.env.CROWD_START === 'lava'
  const EDGE_START = process.env.CROWD_START === 'edge'
  const cx = LAVA_START ? X - 4.5 : EDGE_START ? X + R - 4 : X + 0.5; const cz = LAVA_START ? Z + 6.5 : Z + 0.5
  const a0 = LAVA_START ? -Math.PI / 3 : EDGE_START ? Math.PI * 2 / 3 : n * 0.7
  await cmd(`/tp ${D.name} ${cx} ${Y} ${cz}`)
  FOES.forEach((f, k) => { (f as any).ang = LAVA_START || EDGE_START ? a0 + k * (2 * Math.PI / 3) / Math.max(1, N - 1) : a0 + k * 2 * Math.PI / N })
  for (const f of FOES as any[]) {
    const r = f.role === 'элитры' ? 14 : f.role === 'лучник' ? 12 : LAVA_START ? 5 : EDGE_START ? 9 : 8
    let x = cx + Math.cos(f.ang) * r; let z = cz + Math.sin(f.ang) * r
    x = Math.max(X - R + 1, Math.min(X + R - 1, x)); z = Math.max(Z - R + 1, Math.min(Z + R - 1, z))
    if (x > X - 9 && x < X - 5 && z > Z + 4 && z < Z + 8) z -= 5 // не в лаву
    await cmd(`/tp ${f.name} ${x.toFixed(1)} ${Y} ${z.toFixed(1)} facing ${cx} ${Y + 1} ${cz}`)
  }
  // Сытость 20, насыщение ≈ 1 (как try-duo: насыщение 20 лечит 1 хп за 10 тиков).
  for (const b of all) { await cmd(`/effect give ${b.name} minecraft:instant_health 1 10 true`); await cmd(`/effect give ${b.name} minecraft:saturation 1 20 true`) }
  await sleep(1150)
  for (const b of all) await cmd(`/effect give ${b.name} minecraft:hunger 3 255 true`)
  await sleep(3150)
  for (const b of all) { await cmd(`/effect clear ${b.name} minecraft:hunger`); await cmd(`/effect give ${b.name} minecraft:instant_health 1 10 true`) }
  await sleep(1000)

  const t0 = gameClock.now()
  const logAt = (() => { try { return fs.statSync(SERVER_LOG).size } catch { return 0 } })()
  const mt = meter(t0)
  const died: Record<string, number> = {}
  const pos: Record<string, any> = {}
  const over = { done: false }
  const reports: any[] = []
  const end = () => { if (!over.done) { over.done = true; for (const b of all) b.c.call('stop').catch(() => {}) } }
  const aliveFoes = () => FOES.filter(f => !died[f.name])
  const watch = gameClock.setInterval(async () => {
    if (over.done) return
    const [d, ...fs] = await Promise.all([probe(D.c, true), ...FOES.map(f => died[f.name] ? null : probe(f.c))])
    const now = gameClock.now()
    if (d?.dead && !died[D.name]) died[D.name] = now - t0
    if (d?.pos) pos[D.name] = d.pos
    const fm = {}
    FOES.forEach((f, k) => {
      const p = fs[k]; if (!p) return
      if (p.dead && !died[f.name]) died[f.name] = now - t0
      if (p.pos) pos[f.name] = p.pos
      if (!died[f.name]) fm[f.name] = p
    })
    if (!died[D.name]) mt.sample(now, d, fm)
    if (died[D.name] || !aliveFoes().length || now - t0 > ROUND_MS) end()
  }, 100)
  const defend = async () => {
    while (!over.done) {
      const left = aliveFoes()
      if (!left.length) break
      const me = pos[D.name]
      const near = left.slice().sort((a, b) => hd(pos[a.name], me) - hd(pos[b.name], me))[0]
      const r = await D.c.call('fight', { target: near.name, targets: left.map(f => f.name), allowPlayer: true, allowRanged: true, timeoutSeconds: 3, retreatAtHealth: 3, arena: ARENA, roundScope: `${LABEL}:${n}` }).catch(e => ({ status: 'failed', error: e.message }))
      if (r?.detail) reports.push(r.detail)
      if (diedIn(r) && !died[D.name]) died[D.name] = gameClock.now() - t0
      if (died[D.name]) { end(); break }
      await sleep(r && r.status === 'failed' ? 300 : 50)
    }
  }
  const atk = { swings: 0, landed: 0 }
  const attack = async (f) => {
    if (f.role === 'элитры') await f.c.call('fly_to', { at: { x: X + 0.5, y: Y, z: Z + 0.5 }, timeoutSeconds: 8, arena: ARENA }).catch(() => null)
    while (!over.done && !died[f.name]) {
      // CROWD_ORDER=1 — очередь ударов роя (pvp/strike-order): нападающим одна очередь на защитника.
      const order = process.env.CROWD_ORDER === '1' ? { strikeOrder: { [D.name]: FOES.map(x => x.name) } } : {}
      const r = await f.c.call('fight', { target: D.name, allowPlayer: true, allowRanged: true, timeoutSeconds: 15, retreatAtHealth: 0, arena: ARENA, ...order }).catch(e => ({ status: 'failed', error: e.message }))
      if (r?.detail) { atk.swings += r.detail.swings || 0; atk.landed += r.detail.landed || 0 }
      if (diedIn(r) && !died[f.name]) died[f.name] = gameClock.now() - t0
      await sleep(r && r.status === 'failed' ? 400 : 100)
    }
  }
  await Promise.all([defend(), ...FOES.map(attack)])
  while (!over.done) await sleep(200)
  gameClock.clearInterval(watch)
  const m = mt.m
  const secs = Math.round(((died[D.name] ?? Math.min(ROUND_MS, gameClock.now() - t0)) / 1000) * 10) / 10
  // Решения боя по отчётам кусков: метки used() и сколько раз.
  const tricks: Record<string, number> = {}
  let swings = 0; let landed = 0; let wallTicks = 0; let targets = 0; let prevT = null
  for (const rep of reports) {
    for (const [k, v] of Object.entries<any>(rep.tricks || {})) { const key = k.replace(/\d+(\.\d+)?/g, '#').slice(0, 80); tricks[key] = (tricks[key] || 0) + (typeof v === 'number' ? v : 1) }
    swings += rep.swings || 0; landed += rep.landed || 0; wallTicks += rep.itemUse?.wallTicks || 0
    if (rep.target && rep.target !== prevT) { targets++; prevT = rep.target }
  }
  const crowd = reports.map(r => r.crowd).filter(Boolean)
  // Смерти раунда — по журналу сервера: кого убил защитник, отчего умер он сам.
  let deaths: string[] = []
  try {
    const fd = fs.openSync(SERVER_LOG, 'r'); const size = fs.fstatSync(fd).size; const buf = Buffer.alloc(Math.max(0, size - logAt))
    fs.readSync(fd, buf, 0, buf.length, logAt); fs.closeSync(fd)
    deaths = buf.toString('utf8').split(/\r?\n/).map(l => l.replace(/^.*\]: /, '')).filter(l => /^NeuroFarm29[a-z]? (was|fell|hit|burned|tried|died|drowned|went|walked|experienced)/.test(l))
  } catch {}
  const byMe = deaths.filter(l => !l.startsWith(D.name + ' ') && / by NeuroFarm29(?![a-z])/.test(l)).length
  const out = {
    label: LABEL, round: n, foes: N, roles: FOES.map(f => f.role),
    alive: !died[D.name], secs, kills: byMe, foeDeaths: FOES.filter(f => died[f.name]).length,
    death: deaths.find(l => l.startsWith(D.name + ' ')) || undefined,
    dealt: Math.round(m.dealt), taken: Math.round(m.taken),
    idleS: m.idleS, idlePct: Math.round(m.idleS / Math.max(1, secs) * 100), bumps: m.bumps, bumpS: Math.round(m.bumpS * 10) / 10,
    lavaTicks: m.lava, fell: m.fell, swings, landed, wallTicks, chunks: reports.length, targetChanges: targets, foeSwings: atk.swings, foeLanded: atk.landed,
    crowd: crowd.length ? crowd : undefined,
    // Решения толпы (pvp/turn-crowd) за раунд: смены (вид, цель), дёрганья, броски, отходы.
    cr: crowd.length ? crowd.reduce((a, c) => {
      for (const k of ['ticks', 'switches', 'flips', 'thrown', 'throwFail', 'breaks', 'stuck', 'trapped', 'boxes', 'spots']) a[k] = (a[k] || 0) + (c[k] || 0)
      for (const [k, v] of Object.entries<any>(c.kinds || {})) a.kinds[k] = (a.kinds[k] || 0) + v
      // Профиль ступеней хода (диагностическая сборка): [ходов, мс].
      for (const [k, v] of Object.entries<any>(c.stages || {})) { const r = a.stages[k] || (a.stages[k] = [0, 0]); r[0] += v[0]; r[1] += v[1] }
      for (const [k, v] of Object.entries<any>(c.whyFail || {})) a.whyFail[k] = (a.whyFail[k] || 0) + v
      return a
    }, { kinds: {}, stages: {}, whyFail: {} } as any) : undefined
  }
  fs.appendFileSync(JSONL, JSON.stringify({ ...out, tricks }) + '\n')
  const top = Object.entries(tricks).sort((a, b) => b[1] - a[1]).slice(0, 14).map(([k, v]) => `${k}×${v}`).join(' | ')
  log(`[${LABEL}] ${JSON.stringify({ ...out, crowd: undefined })}`)
  log(`   решения: ${top}`)
  await sleep(2000)
  return out
}

;(async () => {
  try {
    for (const f of FOES) if (!(await portOpen(f.ws))) throw new Error(`${f.name}: демона на ${f.ws} нет — crowd-fleet.js up ${N}`)
    FOES.forEach((f, k) => { f.c = client(`ws://127.0.0.1:${f.ws}`); f.role = ROLES[k % ROLES.length] })
    await D.c.ready; for (const f of FOES) await f.c.ready
    await Promise.all([D, ...FOES].map(b => b.c.call('connect').catch(() => {})))
    for (const b of [D, ...FOES]) {
      const st = await b.c.call('status')
      if (farmServer(st.detail?.server) !== MC_PORT) throw new Error(`${b.name}: подключён не к слоту 29 (${st.detail?.server})`)
      await b.c.call('temper', { enabled: false }).catch(() => {})
      await b.c.call('play_mode', { mode: 'free' }).catch(() => {})
    }
    for (const c of ['difficulty normal', 'gamerule spawn_mobs false', 'gamerule immediate_respawn true', 'gamerule keep_inventory true',
      'gamerule send_command_feedback false', 'gamerule advance_time false', 'gamerule advance_weather false', 'time set day', 'weather clear',
      `forceload add ${X - 32} ${Z - 32} ${X + 72} ${Z + 32}`, 'team add crowd', 'team modify crowd friendlyFire false']) await cmd('/' + c)
    for (const f of FOES) await cmd(`/team join crowd ${f.name}`)
    await cmd(`/team leave ${D.name}`)
    await cmd(`/fill ${HOLD.x - 3} ${HOLD.y - 1} ${HOLD.z - 3} ${HOLD.x + 3} ${HOLD.y - 1} ${HOLD.z + 3} minecraft:stone`)
    for (const f of FOES) await cmd(`/spawnpoint ${f.name} ${HOLD.x} ${HOLD.y} ${HOLD.z}`)
    await cmd(`/spawnpoint ${D.name} ${HOLD.x} ${HOLD.y} ${HOLD.z}`)
    log(`[${LABEL}] ${ROUNDS} раундов по ${ROUND_MS / 1000} с, защитник ${D.name} против ${N}: ${FOES.map(f => `${f.name} (${f.role})`).join(', ')}`)
    const res = []
    for (let n = 1; n <= ROUNDS; n++) res.push(await round(n))
    const avg = k => Math.round(res.reduce((s, r) => s + (+r[k] || 0), 0) / res.length * 10) / 10
    log(`[${LABEL}] ИТОГ ${res.length}: жив ${res.filter(r => r.alive).length}/${res.length}, жил ${avg('secs')} с, снял ${avg('dealt')}, получил ${avg('taken')}, убил ${res.reduce((s, r) => s + r.kills, 0)}, без дела ${avg('idleS')} с (${avg('idlePct')} %), упоров ${avg('bumps')} (${avg('bumpS')} с), лава ${res.filter(r => r.lavaTicks).length}, обрыв ${res.filter(r => r.fell).length}, смен цели ${avg('targetChanges')}, удары ${avg('swings')}` +
      (res.some(r => r.cr) ? `, толпа: смен решения ${Math.round(res.reduce((s, r) => s + (r.cr?.switches || 0), 0) / Math.max(1, res.reduce((s, r) => s + r.secs, 0)) * 10) / 10}/с, дёрганий ${res.reduce((s, r) => s + (r.cr?.flips || 0), 0)}, зелий ${res.reduce((s, r) => s + (r.cr?.thrown || 0), 0)} (отказов ${res.reduce((s, r) => s + (r.cr?.throwFail || 0), 0)}), отходов ${res.reduce((s, r) => s + (r.cr?.breaks || 0), 0)}, упёрся в беге ${res.reduce((s, r) => s + (r.cr?.stuck || 0), 0)}` : ''))
  } catch (e) {
    console.error('FAILED', e.stack || e.message)
    process.exitCode = 1
  } finally {
    for (const b of [D, ...FOES]) { try { await b.c?.call('stop') } catch {} ; try { b.c?.ws.close() } catch {} }
    process.exit()
  }
})()
