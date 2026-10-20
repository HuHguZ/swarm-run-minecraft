'use strict'
import { REPO_ROOT } from '../src/paths'
// «Гонка вооружений», первая версия на ферме (s7 2026-10-06; TODO «PvP Гонка вооружений» п.1–9).
// Раскладка arms-layout (seed) строится на сервере слота по RCON; два бойца — NeuroFarm<i> (ws 88xx) и
// NeuroFarm<i>b (ws 89xx, farm/crystal/bside.js) — стартуют пустыми. У каждого свой StrategicDirector над
// реестром pvp/arms-graph (разведка → сундук/тайник → уход/атака), исполнитель — RPC своего демона, бой —
// навык fight (pvp.duel). Знание бойца — только своё: сундук и облицовку он узнаёт, когда увидел глазами
// (blocks_around seen), врага — по players (canSee). Архитектура (комнаты, кроме тайных) известна заранее.
// Раунд: полный сброс (перестройка по описи раскладки, /clear, опыт 0, эффекты, лечение, сытость),
// старт одновременно, до смерти одного или ARMS_MAX_S. Строка «ARMS_ROUND {json}» на раунд (+ LAB_OUT).
//   node dist/farm/farm.js run arms-run.js --slots 27 --tag s7-arms01 ROUNDS=4 SEED=1
// env: ROUNDS (2), SEED ('demo'), ARMS_POS ("2000 100 2000"), LOOT_S (240 — срок лута, игровые с),
//      ARMS_MAX_S (600), PREP_RATE (20), FIGHT_RATE (750); стороны меняются каждый раунд.
import * as fs from 'fs'
import * as path from 'path'
import * as net from 'net'
import * as gameClock from '../src/game-clock'
import { connect } from '../scenes/lib/scene-kit'
import * as guard from '../scenes/lib/arms-guard'
import * as AL from './arms-layout'
import { StrategicDirector } from '../src/core/strategy'
import { emptyWorld, fact } from '../src/core/world-state'
import * as AG from '../src/pvp/arms-graph'
import * as Loot from '../src/pvp/arms-loot'
const LOOT_PRIOR = Loot.sampleItems(AL.publicLootSamples(), AL.ROCKET3)

const WS_A = process.env.ND_WS || process.env.ARMS_A
const SLOT = Number(String(WS_A || '').split(':').pop()) - 8800
const WS_B = process.env.ARMS_B || `ws://127.0.0.1:${8900 + SLOT}`
guard.farmOnly({ ws: [WS_A, WS_B], mc: [process.env.MC_PORT || 25600 + SLOT] })
const SERVER_DIR = path.join(REPO_ROOT, 'farm', `server-${SLOT}`)
const NAME_A = `NeuroFarm${SLOT}`
const NAME_B = `NeuroFarm${SLOT}b`
const ROUNDS = Number(process.env.ROUNDS || 2)
const SEED = process.env.SEED || 'demo'
const [X, Y, Z] = (process.env.ARMS_POS || '2000 100 2000').split(/\s+/).map(Number)
const LOOT_MS = Number(process.env.LOOT_S || 240) * 1000
const MAX_MS = Number(process.env.ARMS_MAX_S || 600) * 1000
const PREP_RATE = Number(process.env.PREP_RATE || 20)
const FIGHT_RATE = Number(process.env.FIGHT_RATE || 750)
const OUT = process.env.LAB_OUT || null
const sleep = (ms) => gameClock.sleep(ms)
// Опрос не чаще раза в 100 мс настоящего времени: при 750 TPS игровые 0.5 с — это 13 мс, и сцена заваливала
// демонов RPC (players/status), отнимая у тел физические тики.
const WALL_POLL_MS = 100
const pace = (ms) => Promise.all([sleep(ms), gameClock.wall.sleep(WALL_POLL_MS)])
function every (ms, fn) {
  let last = -Infinity
  return gameClock.setInterval(() => { const w = gameClock.wall.now(); if (w - last < WALL_POLL_MS) return; last = w; fn() }, ms)
}
const log = (...a) => console.log(`[${new Date().toTimeString().slice(0, 8)}]`, ...a)

// ---------------------------------------------------------------- RCON (одно соединение на сцену)
function rconClient (port, pass) {
  const sock = net.connect(port, '127.0.0.1')
  const waiting = new Map()
  let id = 0
  let acc = Buffer.alloc(0)
  const send = (type, body) => new Promise<string>((resolve, reject) => {
    const i = ++id
    waiting.set(i, { resolve, reject })
    const b = Buffer.from(body, 'utf8')
    const buf = Buffer.alloc(14 + b.length)
    buf.writeInt32LE(10 + b.length, 0); buf.writeInt32LE(i, 4); buf.writeInt32LE(type, 8); b.copy(buf, 12)
    sock.write(buf)
  })
  sock.on('data', (d: Buffer) => {
    acc = Buffer.concat([acc, d])
    while (acc.length >= 4) {
      const len = acc.readInt32LE(0)
      if (acc.length < len + 4) break
      const i = acc.readInt32LE(4)
      const body = acc.slice(12, len + 2).toString('utf8')
      acc = acc.slice(len + 4)
      if (i === -1) { for (const w of waiting.values()) w.reject(new Error('rcon: неверный пароль')); waiting.clear(); continue }
      const w = waiting.get(i)
      if (w) { waiting.delete(i); w.resolve(body) }
    }
  })
  sock.on('error', e => { for (const w of waiting.values()) w.reject(e); waiting.clear() })
  const ready = new Promise<void>((resolve, reject) => sock.once('connect', () => send(3, pass).then(() => resolve(), reject)))
  return { ready, cmd: async (c) => { await ready; return send(2, c.replace(/^\//, '')) }, close: () => sock.destroy() }
}
const props = fs.readFileSync(path.join(SERVER_DIR, 'server.properties'), 'utf8')
const prop = (k) => (props.match(new RegExp('^' + k.replace(/\./g, '\\.') + '=(.*)$', 'm')) || [])[1]
const rcon = rconClient(Number(prop('rcon.port')), prop('rcon.password'))
const cmd = (c) => rcon.cmd(c)

// ---------------------------------------------------------------- раскладка и сброс
const L = AL.generate(SEED)
const V = AL.validate(L)
if (!V.ok) { console.error('раскладка не прошла проверку:', V.errs.join('; ')); process.exit(2) }
const W = (p) => ({ x: X + p.x, y: Y + p.y, z: Z + p.z })

async function build () {
  await cmd(`forceload add ${X - L.half} ${Z - L.half} ${X + L.half} ${Z + L.half}`)
  const cmds = AL.commands(L, { X, Y, Z })
  let bad = 0
  for (const c of cmds) { const r = await cmd(c); if (/Unknown|Incorrect|Expected|not loaded|Too many/i.test(r)) { bad++; if (bad <= 3) log('команда не прошла:', c.slice(0, 120), '→', r.slice(0, 120)) } }
  await cmd(`kill @e[type=!minecraft:player,x=${X - L.half},y=${Y + L.y0},z=${Z - L.half},dx=${2 * L.half},dy=${L.y1 - L.y0},dz=${2 * L.half}]`)
  // Свидетели: сундуки и стол стоят (execute if block).
  let ok = 0
  const probes = [...L.chests.slice(0, 4).map(c => [W(c), 'chest'] as const), [W(L.lab.table), 'enchanting_table'] as const]
  for (const [p, b] of probes) if (/passed/i.test(await cmd(`execute if block ${p.x} ${p.y} ${p.z} minecraft:${b}`))) ok++
  return { cmds: cmds.length, bad, probes: `${ok}/${probes.length}` }
}

async function resetPlayer (name, spawn) {
  for (const c of [`gamemode survival ${name}`, `clear ${name}`, `effect clear ${name}`, `xp set ${name} 0 levels`, `xp set ${name} 0 points`,
    `effect give ${name} minecraft:instant_health 1 10 true`, `effect give ${name} minecraft:saturation 1 20 true`]) await cmd(c)
  const p = W(spawn)
  await cmd(`tp ${name} ${p.x + 0.5} ${p.y} ${p.z + 0.5} ${spawn.yaw} 0`)
}

// ---------------------------------------------------------------- знание бойца
// Известные заранее места: комнаты (кроме тайных — их двери заложены), четверти поля, две крыши.
function knownAreas () {
  const out = []
  for (const r of L.rooms) if (!L.secret.includes(r.id)) out.push({ id: r.id, x: (r.x0 + r.x1) / 2, y: 0, z: (r.z0 + r.z1) / 2, r: 12 })
  for (const [sx, sz] of [[-1, -1], [-1, 1], [1, -1], [1, 1]]) out.push({ id: `field${sx > 0 ? 'E' : 'W'}${sz > 0 ? 'S' : 'N'}`, x: 6 * sx, y: 0, z: 6 * sz, r: 12 })
  out.push({ id: 'roofW', x: -21, y: 5, z: 0, r: 26 }, { id: 'roofE', x: 21, y: 5, z: 0, r: 26 })
  return out
}
const COVERS = [AL.FACADE, AL.UNDER]
// Обход в поисках врага: центр поля, затем кольцевой коридор (|x| или |z| = 15).
const HUNT = [{ x: 0, y: 0, z: 0 }, { x: -15, y: 0, z: 0 }, { x: 0, y: 0, z: -15 }, { x: 15, y: 0, z: 0 }, { x: 0, y: 0, z: 15 }, { x: 0, y: 0, z: 0 }, { x: -15, y: 0, z: -15 }, { x: 15, y: 0, z: -15 }, { x: 15, y: 0, z: 15 }, { x: -15, y: 0, z: 15 }]
const key = (p) => `${p.x},${p.y},${p.z}`

// RPC с пределом настоящего времени: зависший демон (s7-arms08: 8827 перестал принимать соединения) не должен
// вешать сцену навсегда.
const RPC_WALL_MS = 150000
function makeSide (name, ws) {
  const c = connect(ws)
  const call = (m, p?) => Promise.race([c.call(m, p), gameClock.wall.sleep(RPC_WALL_MS).then(() => { throw new Error(`RPC ${m}: нет ответа ${RPC_WALL_MS / 1000} с`) })])
  return { name, ws, c, call, foe: null, spawn: null, t0: 0, stats: null, know: null, director: null, busy: null }
}

function freshStats () {
  return { firstWeapon: null, firstArmor: null, chests: 0, caches: 0, crafted: [], lab: null, ambushes: 0, ambushSeen: 0, fights: 0, fightWhy: {}, decisions: [], inv0: null, plan: [], hpLost: 0, near: 0, retreats: 0, engages: 0, killed: false, died: false, powerAtEngage: null, firstEngage: null, fightEvents: [] }
}

type ExecResult = import('../src/core/environment').ExecutionResult
// Один вызов ArmsEnv.execute: команда, сигнал, сторона и её знание, события, общий RPC; finished — передача (сундук,
// бой) закончена или навык завершён: сторож больше не переоценивает.
interface ArmsExec {
  command: any; signal: AbortSignal; side: any; k: any; ev: any[]; finished: boolean
  rpc: (m: string, p: any) => Promise<any>; here: () => Promise<any>; near: (p: any, list: any[]) => any[]
}

class ArmsEnv {
  constructor (readonly side, readonly round) {}
  now () { return gameClock.now() }
  sleep (ms) { return sleep(ms) }
  async cancel () { await this.side.call('stop').catch(() => {}) }

  // Глаза: видимые сундуки и облицовка в радиусе r из текущей точки.
  async look (r = 16) {
    const k = this.side.know
    // Откуда увидел — туда и вернуться, чтобы ломать облицовку (mine смотрит честно, только видимые грани).
    const from = (((await this.side.call('status').catch(() => null)) || {}).state || {}).pos || null
    for (const block of ['chest', ...COVERS]) {
      const res = await this.side.call('blocks_around', { find: block, seen: true, radius: r, count: 32 }).catch(() => null)
      for (const p of (res && res.detail && res.detail.found) || []) {
        const rel = { x: p.x - X, y: p.y - Y, z: p.z - Z }
        if (Math.max(Math.abs(rel.x), Math.abs(rel.z)) > L.half) continue
        if (block === 'chest') {
          const id = key(p)
          if (!k.chests.has(id)) k.chests.set(id, { ...p, id, opened: false, looted: false, taken: 0, contents: null, attempt: null })
          const chest = k.chests.get(id)
          if (from && chest.seenFrom && Loot.cellKey(from) !== Loot.cellKey(chest.seenFrom)) {
            chest.evidenceRevision = (chest.evidenceRevision || 0) + 1
            chest.attempt = null
          }
          Object.assign(chest, { seenAt: gameClock.now(), seenFrom: from && { ...from } })
        }
        else if (!k.caches.has(key(p))) k.caches.set(key(p), { ...p, block, opened: false, from })
      }
    }
  }

  // Враг: виден ли и что на нём (players: canSee, gear, at).
  async foe (current = () => true) {
    const k = this.side.know
    const r = await this.side.call('players', { radius: 48 }).catch(() => null)
    if (!current() || this.side.know !== k) return null
    const p = ((r && r.detail && r.detail.players) || []).find(q => q.name === this.side.foe)
    if (p && p.canSee && p.at) {
      const previous = k.foe?.pos && gameClock.now() > k.foe.at ? { at: k.foe.at, pos: { ...k.foe.pos } } : k.foe?.previous
      k.foe = { at: gameClock.now(), pos: { ...p.at }, previous, dist: p.dist, power: AG.visiblePower(p.gear || []), myPowerAt: k.power || 1 }
      if (p.dist < 12) k.nearUntil = gameClock.now() + 4000
      if (p.dist < 4.5) k.contactUntil = gameClock.now() + 2000
    }
    return k.foe
  }

  lootQuote (state, chest) {
    const k = this.side.know
    const interactionTicks = Loot.interactionCost(k.lootInteractions || [], Array.isArray(chest.contents) ? [chest.contents] : LOOT_PRIOR, k.storage || null)
    return Loot.quoteLoot({ state, owned: k.items || [], storage: k.storage || null, chest, prior: LOOT_PRIOR,
      priorGain: k.lootPrior, traversals: k.traversals || [], foe: k.foe, roundScope: this.round.roundScope,
      now: gameClock.now(), interactionTicks,
      engage: AG.armsRegistry().get('Engage') })
  }

  async observe (current = () => true) {
    const side = this.side
    const k = side.know
    const st = await side.call('status', { items: true, foeEstimate: { roundScope: this.round.roundScope, target: side.foe } }).catch(() => null)
    if (!current() || side.know !== k) return null
    const s = (st && st.state) || {}
    await this.foe(current)
    if (!current() || side.know !== k) return null
    const items = Array.isArray(st?.detail?.items) ? st.detail.items : [...Object.entries(s.inventory || {}).map(([name, count]) => ({ name, count: Number(count) })),
      ...Object.values(s.armor || {}).filter(Boolean).map(name => ({ name: String(name) })), ...(s.offHand ? [{ name: String(typeof s.offHand === 'string' ? s.offHand : (s.offHand.item || s.offHand.name)) }] : [])]
    const pw = AG.powerOf(items)
    k.items = items
    k.storage = Array.isArray(st?.detail?.storage) && st.detail.storage.length === 36 ? st.detail.storage : null
    k.lootPrior = Loot.gainRange(items, LOOT_PRIOR, k.storage)
    const t = (gameClock.now() - side.t0) / 1000
    if (pw.weapon > 1 && side.stats.firstWeapon === null) side.stats.firstWeapon = Math.round(t)
    if (pw.armor > 0 && side.stats.firstArmor === null) side.stats.firstArmor = Math.round(t)
    k.power = pw.total
    const w = emptyWorld()
    w.position = s.pos || null
    w.health = s.health ?? 20
    w.hunger = s.food ?? 20
    w.inventory = s.inventory || {}
    // Конец раунда — не смерть (ревью Codex: живой победитель писался Engage/FAILURE).
    w.alive = !this.side.stats.died && (s.health ?? 20) > 0
    w.elapsedMs = gameClock.now() - side.t0
    w.revision = k.revision
    const unscouted = k.areas.filter(a => !k.scouted.has(a.id)).length
    const chests = [...k.chests.values()].filter(c => !c.looted && !c.attempt?.abandoned).length
    const caches = [...k.caches.values()].filter(c => !c.opened).length
    const craft = AG.bestCraft(items)
    k.craft = craft
    const healItems = AG.recoveryFood(w.inventory).count
    w.resources = { power: pw.total, unscouted, chests, caches, loot_completed: side.stats.chests || 0,
      loot_progress: k.lootProgress || 0, craft_gain: craft ? Math.max(1, Math.round(craft.gain)) : 0,
      lab_gain: !k.labDone && AG.labReady(items) ? 2 : 0, heal_items: healItems }
    const now = gameClock.now()
    const hp = st?.detail?.foeEstimate
    if (hp) for (const key of ['lo', 'hi', 'mean', 'conf']) w.facts['enemy_hp_' + key] = fact(hp[key], 'inferred', now, hp.conf)
    const recent = k.foe && now - k.foe.at < 30000
    // Его сила — по последнему увиденному (с возрастом наблюдения), а не «его видимое + мой рюкзак» и не «паритет через
    // 30 с» (S7d, ревью Codex: свой тотем в рюкзаке «усиливал» врага 10 → 18). Не видел ни разу — паритет (prior).
    // С момента наблюдения он лутал, как и я: к увиденному — мой прирост с того момента (s7d-armsB: увиденный голым на
    // старте «сила 1» держался весь раунд, и бой начинался на 9-й секунде против уже вооружённого).
    const enemyPower = k.foe ? k.foe.power + Math.max(0, pw.total - (k.foe.myPowerAt ?? pw.total)) : pw.total
    w.facts.enemy_power = fact(Math.round(enemyPower), k.foe ? 'observed' : 'inferred', k.foe ? k.foe.at : now)
    w.facts.enemy_known = fact(!!recent, 'observed', now)
    w.facts.enemy_near = fact(now < (k.nearUntil || 0), 'observed', now)
    // Бьют (хп падает) или он вплотную — уходить поздно, только драться.
    w.facts.enemy_contact = fact(now < (k.contactUntil || 0) || (k.hp != null && w.health < k.hp && now < (k.nearUntil || 0)), 'observed', now)
    k.hp = w.health
    w.facts.deadline = fact(w.elapsedMs >= LOOT_MS, 'observed', now)
    w.facts.opponent_defeated = fact(!!side.stats.killed || this.round.winner === side.name, 'observed', now)
    w.facts.ambushed = fact(!!k.ambushed, 'observed', now)
    w.facts.loot_prior_gain = fact(k.lootPrior.gain, 'inferred', now)
    k.lootQuote = Loot.chooseLoot([...k.chests.values()].filter(c => !c.looted && !c.attempt?.abandoned).map(c => this.lootQuote(w, c)))
    const q = k.lootQuote
    if (q) {
      const chest = k.chests.get(q.chestId)
      w.facts.loot_target_id = fact(q.chestId, 'observed', chest.seenAt)
      w.facts.loot_target_pos = fact(q.at, 'observed', chest.seenAt)
      for (const [name, value] of Object.entries({ round_scope: q.roundScope, quote_at: q.quoteAt,
        evidence: `${q.chestId}:${chest.evidenceRevision || 0}`, cost_ticks: q.costTicks, travel_ticks: q.travelTicks,
        travel_source: q.travelSource, risk: q.risk, risk_lo: q.riskLo, risk_hi: q.riskHi,
        gain: q.gain, gain_lo: q.gainLo, gain_hi: q.gainHi, exposure: q.exposure, exposure_lo: q.exposureLo,
        exposure_hi: q.exposureHi, risk_prior: q.riskPrior })) w.facts['loot_' + name] = fact(value, 'inferred', now)
    }
    return w
  }

  preparation (state) {
    const side = this.side, k = side.know, q = k.lootQuote
    const allowed = new Set(['Recover', 'Engage'])
    const chest = q && k.chests.get(q.chestId)
    if (chest && !chest.looted && !chest.attempt?.abandoned && q.roundScope === this.round.roundScope &&
      state.facts.loot_target_id?.value === q.chestId && state.facts.loot_round_scope?.value === q.roundScope) allowed.add('LootChest')
    const direct = side.director.decide(state, new Set(['Engage']), { maxDepth: 1, record: false })
    const better = side.director.decide(state, allowed, { maxDepth: 2, record: false })
    const preparation = better.steps[0]?.id
    if (better.reason !== 'goal' || better.steps.length !== 2 || better.steps[1].id !== 'Engage' ||
      !['LootChest', 'Recover'].includes(preparation) || !Number.isFinite(direct.cost) || !(better.cost < direct.cost)) return null
    // Only changed observations reopen an ignored handoff, never quote_at or time.
    const quoteEvidence = JSON.stringify({ preparation, chest: preparation === 'LootChest' ? state.facts.loot_evidence?.value : null,
      position: state.position && Loot.cellKey(state.position), health: state.health, hunger: state.hunger,
      items: (k.items || []).map(i => JSON.stringify(i)).sort(), enemyPower: state.facts.enemy_power?.value,
      enemyPosition: k.foe?.pos && Loot.cellKey(k.foe.pos) })
    return { preparation, quoteEvidence, before: direct.cost, after: better.cost }
  }

  async execute (command, signal): Promise<ExecResult> {
    const side = this.side
    const k = side.know
    if (k.strategicReturn) {
      if (command.skill === 'arms.engage') k.yieldBlocked = k.strategicReturn.quoteEvidence
      k.strategicReturn = null
    }
    const x = this.execContext(command, signal)
    const watch = this.execWatch(x)
    try {
      const me = (await x.here()) || W(L.spawns[0])
      if (command.skill === 'arms.scout') return await this.execScout(x, me)
      if (command.skill === 'arms.loot') return await this.execLoot(x, me)
      if (command.skill === 'arms.cache') return await this.execCache(x, me)
      if (command.skill === 'arms.craft') return await this.execCraft(x)
      if (command.skill === 'arms.lab') return await this.execLab(x)
      if (command.skill === 'arms.heal') return await this.execHeal(x, me)
      if (command.skill === 'arms.ambush') return await this.execAmbush(x)
      if (command.skill === 'arms.retreat') return await this.execRetreat(x)
      if (command.skill === 'arms.engage') return await this.execEngage(x)
      return { outcome: 'FAILURE', reason: `нет навыка ${command.skill}`, events: x.ev }
    } finally {
      x.finished = true
      if (watch) gameClock.clearInterval(watch)
    }
  }

  // Общее одного вызова execute: RPC с квитанцией пути (traversals, lootInteractions) и прерываниями, своя позиция,
  // ближние по списку.
  execContext (command, signal): ArmsExec {
    const side = this.side
    const k = side.know
    const x: ArmsExec = { command, signal, side, k, ev: [], finished: false, rpc: null, here: null, near: null }
    const { ev } = x
    const rpc = async (m, p) => {
      if (signal.aborted) return { status: 'interrupted' }
      const from = m === 'goto' || m === 'chest_take' ? await here() : null
      if (signal.aborted) return { status: 'interrupted' }
      const started = gameClock.now(), points = from ? [{ ...from }] : []
      let sampling = false, closed = false
      const sample = from && every(500, async () => {
        if (sampling || closed) return
        sampling = true
        try { const at = await here(); if (at && !closed) points.push({ ...at }) } finally { sampling = false }
      })
      let r
      try { r = await side.call(m, p).catch(e => ({ status: 'failed', error: e.message })) }
      finally {
        closed = true
        if (sample) gameClock.clearInterval(sample)
        // The transfer is settled. Its watcher must not re-price the now empty
        // chest during route receipts, armor or the following look.
        if (m === 'chest_take' || m === 'fight') x.finished = true
      }
      if (from) {
        const to = await here()
        if (to) {
          points.push({ ...to })
          const receipt = m === 'chest_take' ? Loot.lootReceipt(p, r) : null
          const opened = receipt?.opened
          const ticks = Math.max(0, (gameClock.now() - started) / 50)
          ;(k.traversals ||= []).push({ from: { ...from }, to: { ...to }, points, ticks,
            completed: m === 'goto' ? r.status === 'done' : opened, at: gameClock.now() })
          if (opened && Loot.cellKey(from) === Loot.cellKey(to) && Math.hypot(from.x - p.x, from.y - p.y, from.z - p.z) <= 3.5 && ticks > 0)
            (k.lootInteractions ||= []).push({ ticks, movedNames: Object.keys(receipt.moved).length, interrupted: receipt.interrupted })
        }
      }
      if (r && r.status === 'interrupted') ev.push({ type: r.by && r.by.type === 'tactical' ? 'tactical' : 'interrupted', reason: r.error })
      return r
    }
    const here = async () => { const st = await side.call('status').catch(() => null); return (st && st.state && st.state.pos) || null }
    const near = (p, list) => list.sort((a, b) => Math.hypot(a.x - p.x, a.z - p.z) - Math.hypot(b.x - p.x, b.z - p.z))
    Object.assign(x, { rpc, here, near })
    return x
  }

  // Сторож навыка (кроме боя, отхода и засады): враг рядом или сундук стал дороже боя — прервать директором.
  execWatch (x: ArmsExec) {
    const { command, signal, side, k } = x
    // Для конкретного сундука пересчитываем оставшийся подход и открытие; близость сама по себе не запрет.
    let watching = false
    const watch = command.skill === 'arms.engage' || command.skill === 'arms.retreat' || command.skill === 'arms.ambush' ? null : every(500, async () => {
      if (signal.aborted || this.round.over || watching || x.finished) return
      watching = true
      try {
        if (command.skill === 'arms.loot') {
          const state = await this.observe(), f = k.foe
          if (x.finished || signal.aborted || this.round.over) return
          const chest = k.chests.get(command.params?.chestId)
          if (!chest || !f || gameClock.now() - f.at >= 600) return
          const quote = this.lootQuote(state, chest), engage = AG.armsRegistry().get('Engage')
          const engageTicks = engage.estimateCost(state) + engage.estimateRisk(state) * AG.ARMS_RISK_PENALTY
          const interrupted = quote.totalWithFight > engageTicks
          k.lootWatch = { chestId: chest.id, continueTicks: quote.totalWithFight, engageTicks, travelTicks: quote.travelTicks, interrupted }
          if (interrupted) side.director.interrupt(`loot ${chest.id}: continue ${Math.round(quote.totalWithFight)} > engage ${Math.round(engageTicks)}`)
        } else {
          const f = await this.foe()
          if (x.finished || signal.aborted || this.round.over) return
          if (f && gameClock.now() - f.at < 600 && f.dist < 12) { side.stats.near++; side.director.interrupt('enemy near') }
        }
      } catch {} finally { watching = false }
    })
    return watch
  }

  async execScout (x: ArmsExec, me): Promise<ExecResult> {
    const { signal, k, ev, rpc } = x
    // Ближнее неразведанное, но подальше от врага (последнее наблюдение за 30 с): иначе оба идут в центр и
    // встречаются с пустыми руками (s7-arms06 — кулачный бой на старте).
    const foeAt = k.foe && k.foe.pos && gameClock.now() - k.foe.at < 30000 ? { x: k.foe.pos.x - X, z: k.foe.pos.z - Z } : null
    // Крыши — в последнюю очередь (+40): спуск с них при 750 TPS часто не укладывался в 40 с (s7-arms13…16).
    const score = (a) => Math.hypot(a.x - (me.x - X), a.z - (me.z - Z)) - (foeAt ? 0.7 * Math.hypot(a.x - foeAt.x, a.z - foeAt.z) : 0) + (a.y > 0 ? 40 : 0)
    const area = k.areas.filter(a => !k.scouted.has(a.id)).sort((a, b) => score(a) - score(b))[0]
    if (!area) return { outcome: 'FAILURE', reason: 'всё разведано', events: ev }
    const p = W(area)
    const r = await rpc('goto', { x: p.x, y: p.y, z: p.z, range: 1, timeoutSeconds: 60 })
    if (signal.aborted) return { outcome: 'INTERRUPTED', reason: 'enemy near', events: ev }
    // Разведано — только если дошёл (ревью Codex: неудачный путь записывался «комната изучена»); две неудачи — бросить.
    if (r.status === 'done' || (area.tries = (area.tries || 0) + 1) >= 2) k.scouted.add(area.id)
    await this.look(area.r)
    return { outcome: r.status === 'done' ? 'SUCCESS' : 'PARTIAL', reason: r.error, events: ev, detail: { area: area.id } }
  }

  async execLoot (x: ArmsExec, me): Promise<ExecResult> {
    const { command, signal, side, k, ev, rpc } = x
    const chest = command.params?.roundScope === this.round.roundScope && k.chests.get(command.params?.chestId)
    if (!chest || chest.looted || chest.attempt?.abandoned) return { outcome: 'FAILURE', reason: 'stale loot target', events: ev }
    const quote = k.lootQuote?.chestId === chest.id ? k.lootQuote : null
    k.lootWatch = null
    const started = gameClock.now()
    const r = await rpc('chest_take', { item: 'all', x: chest.x, y: chest.y, z: chest.z })
    const receipt: import('../src/pvp/arms-loot').LootReceipt = Loot.lootReceipt(chest, r)
    const moved = Object.values(receipt.moved).reduce((sum: number, n: number) => sum + n, 0)
    const learned = receipt.opened && (!chest.opened || JSON.stringify(chest.contents) !== JSON.stringify(receipt.contents))
    if (receipt.opened) { chest.opened = true; chest.contents = receipt.contents }
    if (learned) chest.evidenceRevision = (chest.evidenceRevision || 0) + 1
    chest.taken = (chest.taken || 0) + moved
    if (moved > 0 || learned) k.lootProgress = (k.lootProgress || 0) + 1
    if (receipt.emptied) {
      chest.looted = true
      if (chest.taken > 0) side.stats.chests++
    }
    const interrupted = signal.aborted || receipt.interrupted
    const outcome = interrupted ? 'INTERRUPTED' : receipt.emptied && chest.taken > 0 ? 'SUCCESS' : moved > 0 || learned ? 'PARTIAL' : 'FAILURE'
    if (outcome === 'FAILURE') {
      const from = Loot.cellKey(me), reason = receipt.reason || 'no confirmed transfer'
      const revision = chest.evidenceRevision || 0
      const same = chest.attempt?.from === from && chest.attempt.reason === reason && chest.attempt.evidenceRevision === revision
      const failures = (same ? chest.attempt.failures : 0) + 1
      chest.attempt = { from, reason, failures, spentTicks: (same ? chest.attempt.spentTicks : 0) + (gameClock.now() - started) / 50, abandoned: failures >= 2, evidenceRevision: revision }
      if (chest.attempt.abandoned) side.stats.chestFails = (side.stats.chestFails || 0) + 1
    } else if (moved > 0 || learned) chest.attempt = null
    k.lastLoot = { chestId: chest.id, quote, receipt, outcome, abandoned: !!chest.attempt?.abandoned, comparison: k.lootWatch || null }
    await rpc('armor', {})
    await this.look(12)
    return { outcome, reason: receipt.emptied && !chest.taken ? 'observed empty' : receipt.reason, events: ev,
      detail: { chestId: command.params.chestId, receipt, abandoned: !!chest.attempt?.abandoned } }
  }

  async execCache (x: ArmsExec, me): Promise<ExecResult> {
    const { side, k, ev, rpc, near } = x
    const cv = near({ x: me.x, z: me.z }, [...k.caches.values()].filter(c => !c.opened))[0]
    if (!cv) return { outcome: 'FAILURE', reason: 'нет облицовки', events: ev }
    // Вернуться туда, откуда её видел (оттуда грань точно видна), и подойти: mine смотрит честно.
    if (cv.from) await rpc('goto', { x: cv.from.x, y: cv.from.y, z: cv.from.z, range: 1, timeoutSeconds: 30 })
    const r = await rpc('mine', { block: cv.block, at: { x: cv.x, y: cv.y, z: cv.z }, collect: false, timeoutSeconds: 40 })
    // Вскрыт — только по подтверждённой копке; две неудачи — бросил (ревью Codex: отказ шёл «вскрыт»).
    if (r.status === 'done') cv.opened = true
    else if ((cv.tries = (cv.tries || 0) + 1) >= 2) { cv.opened = true; cv.gaveUp = true; side.stats.cacheFails = (side.stats.cacheFails || 0) + 1 }
    // Облицовка двери — в два блока: нижний и верхний вместе, чтобы пройти.
    for (const dy of [1, -1]) { const o = k.caches.get(key({ x: cv.x, y: cv.y + dy, z: cv.z })); if (o && !o.opened) { const r2 = await rpc('mine', { block: o.block, at: { x: o.x, y: o.y, z: o.z }, collect: false, timeoutSeconds: 40 }); if (r2.status === 'done' || (o.tries = (o.tries || 0) + 1) >= 2) o.opened = true } }
    if (r.status === 'done') side.stats.caches++
    await this.look(10)
    return { outcome: r.status === 'done' ? 'SUCCESS' : 'PARTIAL', reason: r.error, events: ev }
  }

  async execCraft (x: ArmsExec): Promise<ExecResult> {
    const { side, k, ev, rpc } = x
    const c = k.craft
    if (!c) return { outcome: 'FAILURE', reason: 'нечего делать', events: ev }
    const r = await rpc('craft', { item: c.item, count: 1, timeoutSeconds: 40 })
    await rpc('armor', {})
    if (r.status === 'done') side.stats.crafted.push(c.item)
    return { outcome: r.status === 'done' ? 'SUCCESS' : 'FAILURE', reason: r.error, events: ev, detail: { item: c.item } }
  }

  async execLab (x: ArmsExec): Promise<ExecResult> {
    const { side, k, ev, rpc } = x
    // Лаборатория N2: стол (0,0,−22), подойти на 2 бл. к югу; бутылки под ноги, затем стол (enchant сам подойдёт).
    // Лаборатория «использована» — только после улучшения; не дошёл — не тратить попытку (ревью Codex).
    const t = W({ x: L.lab.table.x, y: 0, z: L.lab.table.z + 2 })
    const arrived = await rpc('goto', { x: t.x, y: t.y, z: t.z, range: 1, timeoutSeconds: 40 })
    if (arrived.status !== 'done') return { outcome: arrived.status === 'interrupted' ? 'INTERRUPTED' : 'FAILURE', reason: arrived.error, events: ev }
    const xp = await rpc('xp_bottles', {})
    // Сперва наковальня (книга — дешевле), остаток уровней — на стол.
    const anvil = await rpc('enchant', { mode: 'anvil' })
    const table = await rpc('enchant', {})
    await rpc('armor', {})
    const got = [...(anvil.status === 'done' && anvil.detail && !anvil.detail.skipped ? ['наковальня'] : []),
      ...((table.detail && table.detail.enchanted) || []).filter(e => e.got).map(e => e.item)]
    const why = [anvil.error || (anvil.detail && anvil.detail.skipped), table.error || (table.detail && table.detail.stopped)].filter(Boolean).join('; ')
    side.stats.lab = { level: xp.detail && xp.detail.level, got, why: why || undefined }
    k.labDone = got.length > 0 || (k.labTries = (k.labTries || 0) + 1) >= 2
    return { outcome: got.length ? 'SUCCESS' : 'FAILURE', reason: why, events: ev }
  }

  async execHeal (x: ArmsExec, me): Promise<ExecResult> {
    const { signal, side, k, ev, rpc } = x
    const before = (((await side.call('status').catch(() => null)) || {}).state) || {}
    if (!Number.isFinite(before.health) || !Number.isFinite(before.food)) return { outcome: 'FAILURE', reason: 'нет наблюдения здоровья/сытости', events: ev }
    if (before.food < 18 && !AG.recoveryFood(before.inventory || {}).count) return { outcome: 'FAILURE', reason: 'нет еды и сытости для регенерации', events: ev }
    // Подальше от последнего места врага — к ближнему углу комплекса со своей стороны; съесть (eat выберет лучшее),
    // затем ждать регенерацию до 18 хп или 15 с; сторож прерывает, если враг показался.
    const f = k.foe && k.foe.pos ? { x: k.foe.pos.x - X, z: k.foe.pos.z - Z } : null
    if (f && Math.hypot(me.x - X - f.x, me.z - Z - f.z) < 10) {
      const away = k.areas.slice().sort((a, b) => Math.hypot(b.x - f.x, b.z - f.z) - Math.hypot(a.x - f.x, a.z - f.z) + 0.5 * (Math.hypot(a.x - (me.x - X), a.z - (me.z - Z)) - Math.hypot(b.x - (me.x - X), b.z - (me.z - Z))))[0]
      if (away) { const p = W(away); await rpc('goto', { x: p.x, y: p.y, z: p.z, range: 2, timeoutSeconds: 10 }) }
    }
    const ate = await rpc('eat', {})
    if (signal.aborted || ate.status === 'interrupted') return { outcome: 'INTERRUPTED', reason: ate.error || 'поедание прервано', events: ev }
    const until = gameClock.now() + 15000
    const eaten = ate.detail?.spent > 0 ? ate.detail.ate : null
    const regenUntil = gameClock.now() + AG.recoveryRegenMs(eaten)
    let after = before
    while (!signal.aborted && !this.round.over) {
      after = (((await side.call('status').catch(() => null)) || {}).state) || {}
      if (!Number.isFinite(after.health) || !Number.isFinite(after.food)) return { outcome: 'FAILURE', reason: 'нет подтверждения здоровья/сытости', events: ev }
      if (after.health >= 18 || after.health < before.health || (after.food < 18 && gameClock.now() >= regenUntil) || gameClock.now() >= until) break
      await pace(500)
    }
    const hpGain = after.health - before.health, foodGain = after.food - before.food
    if (hpGain > 0) side.stats.heals = (side.stats.heals || 0) + 1
    return { outcome: signal.aborted || this.round.over ? 'INTERRUPTED' : hpGain > 0 ? 'SUCCESS' : foodGain > 0 ? 'PARTIAL' : 'FAILURE',
      reason: hpGain > 0 || foodGain > 0 ? undefined : 'нет подтверждённого восстановления', events: ev,
      detail: { hpBefore: before.health, hp: after.health, foodBefore: before.food, food: after.food, hpGain, foodGain, ate: eaten || null } }
  }

  async execAmbush (x: ArmsExec): Promise<ExecResult> {
    const { signal, side, k, ev, rpc } = x
    // Точка — середина поля со своей стороны (x = ±5): чужой обход идёт через центр; ждать до 25 с, пока не покажется.
    k.ambushed = true
    side.stats.ambushes++
    const p = W({ x: side.spawn.x < 0 ? -5 : 5, y: 0, z: 0 })
    await rpc('goto', { x: p.x, y: p.y, z: p.z, range: 1, timeoutSeconds: 20 })
    const until = gameClock.now() + 25000
    while (!signal.aborted && gameClock.now() < until) {
      const f = await this.foe()
      if (f && gameClock.now() - f.at < 600) { side.stats.ambushSeen++; return { outcome: 'SUCCESS', events: ev } }
      await pace(400)
    }
    return { outcome: 'PARTIAL', reason: 'не пришёл', events: ev }
  }

  async execRetreat (x: ArmsExec): Promise<ExecResult> {
    const { signal, side, k, ev, rpc } = x
    side.stats.retreats++
    const f = k.foe && k.foe.pos ? { x: k.foe.pos.x - X, z: k.foe.pos.z - Z } : { x: 0, z: 0 }
    const far = k.areas.filter(a => !k.scouted.has(a.id)).concat(k.areas).sort((a, b) => Math.hypot(b.x - f.x, b.z - f.z) - Math.hypot(a.x - f.x, a.z - f.z))[0]
    const p = W(far)
    const r = await rpc('goto', { x: p.x, y: p.y, z: p.z, range: 2, timeoutSeconds: 12 })
    // Ушёл — по факту пути и нового взгляда на врага (ревью Codex: угроза стиралась и успех писался всегда).
    await this.foe()
    return { outcome: signal.aborted || r.status === 'interrupted' ? 'INTERRUPTED' : r.status === 'done' ? 'SUCCESS' : 'FAILURE', reason: r.error, events: ev }
  }

  async execEngage (x: ArmsExec): Promise<ExecResult> {
    const { signal, side, k, ev, rpc } = x
    k.lastYield = null
    side.stats.engages++
    if (side.stats.firstEngage == null) side.stats.firstEngage = Math.round((gameClock.now() - side.t0) / 1000)
    if (side.stats.powerAtEngage === null) side.stats.powerAtEngage = k.power
    await rpc('armor', {})
    const fresh = (f) => f && gameClock.now() - f.at < 1500
    if (!fresh(await this.foe())) {
      // Не видно: к последнему наблюдению, иначе обход — центр поля (оттуда видно поле и двери), затем
      // кольцевой коридор; путь рвётся, как только враг показался (s7: без обхода оба искали 200 с и не встретились).
      const last = k.foe && k.foe.pos && gameClock.now() - k.foe.at < 30000 ? k.foe.pos : null
      if (k.foe) k.foe.pos = null
      // Обход зеркален по сторонам: первым — коридор со стороны врага (s7-arms09…12: общий порядок «сперва запад»
      // давал восточному старту 17 побед из 22 — он шёл навстречу, западный — от врага).
      const h = HUNT[(k.hunt = (k.hunt ?? -1) + 1) % HUNT.length]
      const target = last || W({ ...h, x: h.x * (side.spawn.x < 0 ? -1 : 1) })
      let seen = false
      const go = rpc('goto', { x: target.x, y: target.y, z: target.z, range: 2, timeoutSeconds: 25 })
      const poll = every(400, async () => { if (!seen && fresh(await this.foe())) { seen = true; side.call('stop').catch(() => {}) } })
      try { await go } finally { gameClock.clearInterval(poll) }
      if (!seen && !fresh(await this.foe())) return { outcome: 'PARTIAL', reason: 'не нашёл', events: ev }
    }
    const t1 = gameClock.now()
    const roundScope = this.round.roundScope, fightId = `${roundScope}:${k.fightSeq = (k.fightSeq || 0) + 1}`
    k.activeFightId = fightId
    let polling = false, pending = null, requestSeq = 0
    const issued = new Map()
    const current = () => !x.finished && !signal.aborted && !this.round.over && side.know === k && k.activeFightId === fightId
    const watchYield = every(500, async () => {
      if (!current() || polling) return
      polling = true
      try {
        const state = await this.observe(current)
        if (!current() || !state) return
        const choice = this.preparation(state)
        if (choice && choice.quoteEvidence !== k.yieldBlocked) {
          const request = { ...choice, requestId: pending?.quoteEvidence === choice.quoteEvidence ? pending.requestId : `${fightId}:${++requestSeq}` }
          pending = request
          k.yieldWatch = { ...request, enemyHp: Object.fromEntries(['lo', 'hi', 'mean', 'conf'].map(b => [b, state.facts['enemy_hp_' + b]?.value])) }
          issued.set(request.requestId, k.yieldWatch)
          await side.call('fight_yield', { roundScope, fightId, target: side.foe, request })
        } else if (pending) {
          pending = null
          await side.call('fight_yield', { roundScope, fightId, target: side.foe, request: null })
        }
      } catch {} finally { polling = false }
    })
    // arena — весь комплекс (|x|,|z| ≤ 25 от центра, пол y=0): дуэль не уходит по сытости/оружию (arenaStay), стены держат поле.
    let r
    try { r = await rpc('fight', { target: side.foe, allowPlayer: true, allowStrategicYield: true, fightId,
      timeoutSeconds: 120, retreatAtHealth: 3, purpose: 'defense', roundScope, arena: { x: X + 0.5, y: Y, z: Z + 0.5, r: 25 } }) }
    finally { gameClock.clearInterval(watchYield); if (k.activeFightId === fightId) k.activeFightId = null }
    const d = (r && r.detail) || {}
    const sent = issued.get(d.strategicYield?.requestId)
    const strategicYield = sent && sent.quoteEvidence === d.strategicYield.quoteEvidence && sent.preparation === d.strategicYield.preparation ? d.strategicYield : null
    if (strategicYield) k.strategicReturn = k.lastYield = { ...strategicYield, fightId, roundScope, enemyHp: sent.enemyHp }
    if (side.stats.fightEvents.length < 40) side.stats.fightEvents.push({ t: Math.round((t1 - side.t0) / 1000), s: Math.round((gameClock.now() - t1) / 1000), status: r.status, by: r.by && r.by.type, stopped: d.stopped, sw: d.swings, hit: d.landed,
      ...(strategicYield ? { strategicYield: k.lastYield } : {}) })
    if (d.killed && String(d.killed).split(', ').includes(side.foe)) side.stats.killed = true
    side.stats.fights++
    const why = `fight ${r.status}${r.error ? ': ' + r.error : ''}${d.skipped ? ' skip ' + (d.stopped || d.purpose || '') : ''}${d.stopped && !d.skipped ? ' stop ' + d.stopped : ''} sw ${d.swings ?? '-'}`.slice(0, 90)
    const kind = why.replace(/sw \d+$/, 'sw #')
    side.stats.fightWhy[kind] = (side.stats.fightWhy[kind] || 0) + 1
    // Мгновенный возврат без боя — не крутить: пауза, иначе тысячи вызовов за раунд (s7-arms02: 3996).
    if (gameClock.now() - t1 < 1000 && !side.stats.killed && !strategicYield) await sleep(1000)
    return { outcome: side.stats.killed ? 'SUCCESS' : 'PARTIAL', reason: why, events: ev,
      detail: { swings: d.swings, landed: d.landed, ...(strategicYield ? { strategicYield: k.lastYield } : {}) } }
  }
}

// ---------------------------------------------------------------- раунд
async function brain (side, round) {
  const env = new ArmsEnv(side, round)
  side.director = new StrategicDirector(AG.armsRegistry(), env, {
    goal: AG.opponentDefeated, riskPenalty: AG.ARMS_RISK_PENALTY, maxFailures: 3, retryAfterMs: 30000,
    record: (r) => {
      // Первые решения раунда — с ресурсами и фактами (отладка выбора).
      if (r.level === 'decision' && side.stats.decisions.length < 40) side.stats.decisions.push({ t: Math.round((gameClock.now() - side.t0) / 1000), plan: (r.plan || []).slice(0, 4).join('>'), res: r.before && r.before.resources, facts: r.before && Object.fromEntries(Object.entries(r.before.facts).map(([k, v]: any) => [k, v.value])), why: r.reason })
      if (r.level === 'strategy') side.stats.plan.push({ t: Math.round((gameClock.now() - side.t0) / 1000), s: r.strategy, o: r.outcome, why: r.reason ? String(r.reason).slice(0, 60) : undefined,
        ...(r.strategy === 'LootChest' ? { loot: side.know.lastLoot } : {}) }) }
  })
  while (!round.over) {
    let r
    try { r = await side.director.tick() } catch (e) { log(side.name, 'граф:', e.message); await sleep(1000); continue }
    if (r.stopped === 'goal' || r.stopped === 'death') break
    if (r.stopped) await sleep(500)
  }
}

// Тело на связи: после смерти на 750 TPS сервер кикает за «Invalid move player packet» (возрождение далеко от
// арены, s7-arms05) — переподключить; часы сцены идут за демоном A, без тела они стоят.
async function ensureConnected (s) {
  if ((((await s.call('status').catch(() => null)) || {}).state || {}).connected) return true
  await s.call('connect').catch(() => {})
  for (let i = 0; i < 30; i++) { if ((((await s.call('status').catch(() => null)) || {}).state || {}).connected) { await s.call('auto_loot', { enabled: false }).catch(() => {}); return true } await gameClock.wall.sleep(1000) }
  return false
}

async function runRound (n, A, B) {
  const sides = n % 2 ? [B, A] : [A, B] // западный старт — по очереди
  for (const s of [A, B]) if (!(await ensureConnected(s))) throw new Error(`${s.name} не подключается`)
  await cmd(`tick rate ${PREP_RATE}`)
  const built = await build()
  // Возрождение после прошлого раунда должно закончиться до телепорта: иначе клиент шлёт ход от точки
  // возрождения, сервер кикает «Invalid move player packet» (s7-arms05/06).
  for (const s of [A, B]) for (let i = 0; i < 20; i++) { const S = ((await s.call('status').catch(() => null)) || {}).state || {}; if (S.connected && S.health > 0) break; await gameClock.wall.sleep(500) }
  await gameClock.wall.sleep(1000)
  for (const [i, s] of sides.entries()) {
    s.spawn = L.spawns[i]
    for (let k = 0; k < 3; k++) {
      await resetPlayer(s.name, s.spawn)
      await gameClock.wall.sleep(500)
      const S = ((await s.call('status').catch(() => null)) || {}).state || {}
      const p = W(s.spawn)
      if (S.pos && Math.abs(S.pos.x - p.x) <= 2 && Math.abs(S.pos.z - p.z) <= 2) break
      log(`${s.name}: после телепорта не на старте (${JSON.stringify(S.pos)}), повтор`)
      await ensureConnected(s)
    }
  }
  // Возрождение — над центром арены (на барьерном потолке): рядом, без дальнего переноса.
  for (const s of [A, B]) await cmd(`spawnpoint ${s.name} ${X} ${Y + L.y1 + 1} ${Z}`)
  await sleep(1500)
  // Прошлый бой (ответ на удары, тактика) не должен тянуться в новый раунд: стоп дважды с паузой.
  for (const s of [A, B]) { await s.call('stop').catch(() => {}); await s.call('temper', { enabled: false }).catch(() => {}) }
  await gameClock.wall.sleep(500)
  for (const s of [A, B]) await s.call('stop').catch(() => {})
  await cmd(`tick rate ${FIGHT_RATE}`)
  await gameClock.wall.sleep(1500)
  // Damage or stale movement can arrive after reset/tp. Admit both sides from
  // their final observed state, and repair an unequal start before either brain.
  const starts = new Map()
  for (let attempt = 0; attempt < 3; attempt++) {
    const invalid = []
    for (const s of [A, B]) {
      const S = ((await s.call('status').catch(() => null)) || {}).state || {}
      starts.set(s, S)
      const p = W(s.spawn)
      // status rounds HP; farm setup must also reject e.g. 19.75 reported as 20.
      const full = /passed/i.test(await cmd(`execute if entity @a[name=${s.name},nbt={Health:20.0f,foodLevel:20}]`))
      const ready = S.connected && S.health === 20 && S.food === 20 && S.inventory &&
        !Object.values(S.inventory).some(n => Number(n) > 0) && !Object.values(S.armor || {}).some(Boolean) && !S.offHand &&
        S.pos && Math.abs(S.pos.x - p.x - 0.5) <= 1 && Math.abs(S.pos.y - p.y) <= 0.5 && Math.abs(S.pos.z - p.z - 0.5) <= 1 && full
      if (!ready) invalid.push(s)
    }
    if (!invalid.length) break
    if (attempt === 2) throw new Error(`не готов к старту: ${invalid.map(s => `${s.name} ${JSON.stringify(starts.get(s))}`).join('; ')}`)
    for (const s of invalid) { await s.call('stop').catch(() => {}); await resetPlayer(s.name, s.spawn) }
    await gameClock.wall.sleep(500)
  }
  const deaths = new Map([A, B].map(s => [s, starts.get(s).lastDeathAt || null]))
  const round = { over: false, winner: null, why: null, roundScope: `arms:${SEED}:${n}:${gameClock.wall.now()}` }
  const t0 = gameClock.now()
  const w0 = gameClock.wall.now()
  const tick0 = gameClock.snapshot()?.ticks ?? null
  for (const s of [A, B]) {
    s.t0 = t0
    s.stats = freshStats()
    s.know = { areas: knownAreas(), scouted: new Set(), chests: new Map(), caches: new Map(), foe: null, nearUntil: 0, power: 0, revision: 0 }
    // Опись старта: пустой рюкзак и голое тело — иначе раунд не равный.
    const st0 = starts.get(s)
    s.stats.inv0 = { inv: st0.inventory, armor: Object.values(st0.armor || {}).filter(Boolean), offHand: st0.offHand || null, hp: st0.health, food: st0.food, pos: st0.pos }
  }
  // Доля физических тиков тел за раунд (status.physicsTicks / clock.ticks), как в arena.ts.
  const phys = async (c) => { const S = (((await c.call('status').catch(() => null)) || {}).state) || {}; return S.clock && typeof S.physicsTicks === 'number' ? { p: S.physicsTicks, t: S.clock.ticks } : null }
  const phys0 = new Map([[A, await phys(A)], [B, await phys(B)]])
  const brains = [brain(A, round), brain(B, round)]
  const hp = new Map()
  while (!round.over) {
    // Игровые 0.5 с, но не дольше 1.5 с настоящих: если тело A отвалилось, игровые часы стоят.
    await Promise.race([pace(500), gameClock.wall.sleep(1500)])
    for (const s of [A, B]) {
      const st = await s.call('status').catch(() => null)
      const S = st && st.state
      if (!S) continue
      if (S.connected === false) { round.over = true; round.why = `обрыв связи ${s.name}`; break }
      if (hp.has(s) && S.health < hp.get(s)) s.stats.hpLost += hp.get(s) - S.health
      hp.set(s, S.health)
      if (S.health <= 0 || (S.lastDeathAt || null) !== deaths.get(s)) { s.stats.died = true; round.over = true; round.winner = s === A ? B.name : A.name; round.why = 'смерть' }
    }
    if (!round.over && gameClock.now() - t0 > MAX_MS) { round.over = true; round.why = 'время' }
    if (!round.over && gameClock.wall.now() - w0 > 600000) { round.over = true; round.why = 'зависание (10 мин настоящего времени)' }
  }
  // Конец — до остановки бойцов и ожидания мозгов (ревью Codex: уборка входила в длительность раунда).
  const tEnd = gameClock.now()
  const wallS = (gameClock.wall.now() - w0) / 1000
  const tick1 = gameClock.snapshot()?.ticks ?? null
  for (const s of [A, B]) { s.director?.interrupt('round over'); await s.call('stop').catch(() => {}) }
  await Promise.race([Promise.all(brains), gameClock.wall.sleep(5000)])
  for (const s of [A, B]) { const a = phys0.get(s); const b = await phys(s); s.stats.physShare = a && b && b.t > a.t ? Math.round((b.p - a.p) / (b.t - a.t) * 100) / 100 : null }
  const row = {
    n, seed: SEED, built, winner: round.winner, why: round.why, durS: Math.round((tEnd - t0) / 1000), wallS: Math.round(wallS),
    tps: tick0 != null && tick1 != null && wallS > 0 ? Math.round((tick1 - tick0) / wallS) : null,
    sides: Object.fromEntries([A, B].map(s => [s.name, { start: s.spawn.x < 0 ? 'W' : 'E', power: s.know.power, ...s.stats, plan: s.stats.plan.slice(-40) }]))
  }
  log('ARMS_ROUND ' + JSON.stringify(row))
  if (OUT) fs.appendFileSync(OUT, JSON.stringify(row) + '\n')
  return row
}

async function main () {
  const A = makeSide(NAME_A, WS_A)
  const B = makeSide(NAME_B, WS_B)
  A.foe = NAME_B; B.foe = NAME_A
  await gameClock.wall.sleep(1500)
  // Часы сцены идут за демоном A: без подключённого тела игровое время стоит — сперва connect.
  for (const s of [A, B]) {
    guard.farmServer(((await s.call('status')).detail || {}).server)
    await s.call('connect')
    // Сундуки — только через граф: автолут автопилота выключен.
    await s.call('auto_loot', { enabled: false })
    for (let i = 0; i < 30 && !((await s.call('status')).state || {}).connected; i++) await gameClock.wall.sleep(1000)
  }
  for (const g of ['spawn_mobs false', 'do_daylight_cycle false', 'do_immediate_respawn true', 'keep_inventory false', 'send_command_feedback false']) await cmd(`gamerule ${g}`)
  await cmd('time set day')
  log(`гонка вооружений: слот ${SLOT}, seed ${SEED}, центр ${X} ${Y} ${Z}, раундов ${ROUNDS}, лут ${LOOT_MS / 1000} с, предел ${MAX_MS / 1000} с; сундуков ${L.chests.length}, бюджет ${JSON.stringify(L.budget)}`)
  // BUILD_ONLY=1 — только перестроить раскладку по описи (проверка мира, отладка путей) и выйти.
  if (process.env.BUILD_ONLY) { log('стройка: ' + JSON.stringify(await build())); rcon.close(); process.exit(0) }
  const rows = []
  for (let n = 0; n < ROUNDS; n++) {
    log(`=== раунд ${n + 1} ===`)
    rows.push(await runRound(n, A, B))
  }
  const wins = {}
  for (const r of rows) if (r.winner) wins[r.winner] = (wins[r.winner] || 0) + 1
  log('ARMS_SUMMARY ' + JSON.stringify({ rounds: rows.length, wins, draws: rows.filter(r => !r.winner).length }))
  await cmd(`tick rate ${FIGHT_RATE}`).catch(() => {})
  rcon.close()
  process.exit(0)
}
main().catch(e => { console.error(e); process.exit(1) })
