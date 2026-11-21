'use strict'
import vec3 from 'vec3'
import * as clock from './game-clock'
import * as build from './build'
import * as pick from './pick'
import * as tools from './tools'
import { bestWeapon } from './items'
import * as safety from './combat-safety'
import { seesPlayer, createLastSeen } from './pvp/last-seen'
import { watchDigReceipt } from './environments/dig-receipt'
import { lidBlock, placeChestLid, seenChest, seenChestPartner } from './chest-lid'
import { supportAt, HAZARD } from './navigation/geometry'
import { withinArena } from './navigation/parkour/model'
import { observedCollision } from './pvp/search'
import { iterators } from 'prismarine-world'
// Фабрика vec3 (parseFloat, null → 0,0,0), как прежний require('vec3'); тип — класс Vec3.
const Vec3 = vec3 as unknown as typeof import('vec3').Vec3
const BlockFaces = iterators.BlockFace

type Cell = { x: number; y: number; z: number }
type BuildProof = { match: string; token: number }
type KeptCell = Cell & { repair?: BuildProof }
const xyz = (p): Cell => ({ x: p.x, y: p.y, z: p.z })
const key = p => `${p.x},${p.y},${p.z}`
const validCell = p => p && ['x', 'y', 'z'].every(k => Number.isSafeInteger(p[k])) &&
  Math.abs(p.x) < 30_000_000 && Math.abs(p.z) < 30_000_000 && p.y >= -64 && p.y <= 319
const DIRECTIONS = { north: [0, -1], south: [0, 1], east: [1, 0], west: [-1, 0] }
const AIR = /^(air|cave_air|void_air)$/
const masonry = (name: string) => !build.FALLING.has(name) && (build.FILLER.includes(name) || build.ARENA_FILLER.test(name) || /_planks$/.test(name))
const treadQuarters = [[0, 0], [.5, 0], [0, .5], [.5, .5]]
const outpostTread = block => /_(stairs|slab)$/.test(block.name) && treadQuarters.every(([x, z]) =>
  block.shapes?.some(([left, , front, right, top, back]) =>
    left <= x && front <= z && right >= x + .5 && back >= z + .5 && top >= .5 && top <= 1))

// Paper schedules FallingBlock two ticks after placement. A side-face block_change cannot certify a deck.
function supportedColumn(bot, cell) {
  const view = observedCollision(bot)
  for (let p = cell.offset(0, -1, 0); p.y >= (bot.game?.minY ?? -64); p = p.offset(0, -1, 0)) {
    const base = view.blockAt(p)
    if (!base) return null
    if (build.REPLACEABLE.test(base.name)) return false
    if (!build.FALLING.has(base.name) && !/anvil$|_concrete_powder$|^dragon_egg$|^suspicious_(sand|gravel)$/.test(base.name)) return true
  }
  return false
}

// Свои постройки роя (кокон, загон, укрытие): бой их не прорубает. «Пробил его стенку» принимал кокон вокруг цели за её
// стену — строитель сам вскрыл две клетки, которые поставил (лаборатория 14.10, кокон 21/23). Знание честное: клетки
// положил сам бот или их подтвердил журнал роя.
// The same authoritative 1.21.11 updates confirm a click and report a witnessed breach.
function blockPackets(bot, receive: (p: Cell, state: number) => void) {
  const single = pkt => { if (pkt?.location && Number.isInteger(pkt.type)) receive(pkt.location, pkt.type) }
  const multi = pkt => {
    const c = pkt?.chunkCoordinates
    if (!c || ![c.x, c.y, c.z].every(Number.isInteger) || !Array.isArray(pkt.records)) return
    for (const r of pkt.records) if (Number.isSafeInteger(r)) receive({ x: c.x * 16 + ((r >>> 8) & 15), y: c.y * 16 + (r & 15), z: c.z * 16 + ((r >>> 4) & 15) }, Math.floor(r / 4096))
  }
  bot._client.on('block_change', single); bot._client.on('multi_block_change', multi)
  return () => { bot._client.removeListener('block_change', single); bot._client.removeListener('multi_block_change', multi) }
}
type ProtectedCells = Map<string, { until: number; repair?: BuildProof }>
type Breach = { at: Cell; repair: BuildProof; time: number }
const kept = new WeakMap<object, ProtectedCells>()
const breachRadios = new WeakMap<object, { pending: Map<string, Breach>; close: () => void }>()
export const BREACH_FRESH_MS = 2000
function watchBreaches(bot, map: ProtectedCells) {
  const pending = new Map<string, Breach>()
  const unsubscribe = blockPackets(bot, (p, state) => {
    const id = key(p), proof = map.get(id)?.repair
    if (!proof || !bot.entity?.position || bot.isAlive === false || !(bot.health > 0) ||
        !['adventure', 'survival'].includes(bot.game?.gameMode)) return
    const air = AIR.test(bot.registry.blocksByStateId[state]?.name)
    if (!air && !pending.has(id)) return
    const at = new Vec3(p.x, p.y, p.z)
    if (at.distanceTo(bot.entity.position) > 32) return
    const seen = observedCollision(bot).blockAt(at)
    if (!seen || seen.stateId !== state) return
    if (air) pending.set(id, { at: xyz(p), repair: proof, time: clock.now() })
    else pending.delete(id)
  })
  const close = () => {
    unsubscribe(); bot.removeListener('end', close); bot.removeListener('death', close)
    pending.clear(); breachRadios.delete(bot)
  }
  bot.once('end', close); bot.once('death', close); breachRadios.set(bot, { pending, close })
}
function keepBlocks(bot, cells: KeptCell[] = [], { clear = false, ms = 300000 } = {}) {
  if (clear) { kept.delete(bot); breachRadios.get(bot)?.close() }
  const map: ProtectedCells = kept.get(bot) || new Map(), until = clock.now() + ms
  for (const c of cells) if (validCell(c)) {
    const id = key(c), incoming = c.repair
    let repair = map.get(id)?.repair
    if (typeof incoming?.match === 'string' && incoming.match.length <= 64 && Number.isSafeInteger(incoming.token) &&
        (!repair || repair.match !== incoming.match || repair.token < incoming.token)) repair = incoming
    map.set(id, { until, repair })
    if (repair && !breachRadios.has(bot) && bot.version === '1.21.11' && bot._client?.on) watchBreaches(bot, map)
  }
  if (map.size) kept.set(bot, map)
  return map.size
}
function witnessedBreaches(bot) {
  const reports = [], pending = breachRadios.get(bot)?.pending
  if (!pending?.size || bot.isAlive === false || !(bot.health > 0) || !['survival', 'adventure'].includes(bot.game?.gameMode)) return reports
  for (const [id, fact] of pending) {
    const ageMs = clock.now() - fact.time
    if (ageMs < 0 || ageMs >= BREACH_FRESH_MS || kept.get(bot)?.get(id)?.repair !== fact.repair) pending.delete(id)
    else reports.push({ at: fact.at, repair: fact.repair, ageMs })
  }
  return reports
}
const isKept = (bot, p) => (kept.get(bot)?.get(key({ x: Math.floor(p.x), y: Math.floor(p.y), z: Math.floor(p.z) }))?.until ?? 0) > clock.now()

// Plans contain claims, never world knowledge; the coordinator assigns each cell to one worker.
function swarmBlueprint(kind, origin, direction = 'north') {
  if (!validCell(origin) || !DIRECTIONS[direction] || !['shelter', 'cocoon', 'cutoff', 'outpost', 'beacon'].includes(kind)) throw new Error('invalid_blueprint')
  const [dx, dz] = DIRECTIONS[direction], radius = kind === 'shelter' ? 2 : 1
  const cells = [], protectedCells = []
  const at = (x, y, z) => ({ x: origin.x + x, y: origin.y + y, z: origin.z + z })
  if (kind === 'beacon') {
    for (let y = 0; y < 2; y++) cells.push({ kind: 'place', at: at(0, y, 0) })
    protectedCells.push(at(0, -1, 0))
  } else if (kind === 'cutoff') {
    for (let y = 0; y < 2; y++) for (let w = -2; w <= 2; w++) cells.push({ kind: 'place', at: at(-dz * w, y, dx * w) })
  } else {
    if (kind === 'outpost') for (let x = -1; x <= 1; x++) for (let z = -1; z <= 1; z++) cells.push({ kind: 'place', at: at(x, -1, z) })
    for (let y = 0; y < 2; y++) for (let x = -radius; x <= radius; x++) for (let z = -radius; z <= radius; z++) {
      const edge = Math.abs(x) === radius || Math.abs(z) === radius
      const doorway = (kind === 'shelter' || kind === 'outpost') && x === dx * radius && z === dz * radius
      const slit = kind === 'cocoon' && y === 1 && ((x === dx && z === dz) || (x === -dx && z === -dz))
      if (edge && !doorway && !slit) cells.push({ kind: 'place', at: at(x, y, z) })
      else protectedCells.push(at(x, y, z))
    }
    for (let x = -radius; x <= radius; x++) for (let z = -radius; z <= radius; z++) {
      cells.push({ kind: 'place', at: at(x, 2, z) }); protectedCells.push(at(x, -1, z))
    }
    if (kind === 'outpost') for (const y of [0, 1]) protectedCells.push(at(2 * dx, y, 2 * dz))
  }
  if (![...cells.map(c => c.at), ...protectedCells].every(validCell)) throw new Error('invalid_blueprint')
  return { kind, origin: xyz(origin), cells, protected: protectedCells }
}

// Сколько может снять один его удар по мне сейчас: видимое оружие (блеск — острота V, как у оценки боя роя), крит, моя
// надетая броня с чарами. Не видно — бесконечно (прежняя осторожность).
function hitBound(bot, e) {
  try {
    const dm: typeof import('./pvp/damage-model') = require('./pvp/damage-model'), { enchantsOf }: typeof import('./enchant') = require('./enchant')
    const held = (require('./pvp/last-seen') as typeof import('./pvp/last-seen')).observePlayerGear(bot, e).equipment[0]
    const weapon = held?.name || null
    const raw = dm.meleeRaw({ weapon, sharpness: held?.enchanted && /_(sword|axe|spear)$/.test(weapon || '') ? 5 : 0, crit: true,
      fall: weapon === 'mace' ? Math.max(0, e.position.y - bot.entity.position.y) : 0, density: held?.enchanted && weapon === 'mace' ? 5 : 0 })
    const armor = [5, 6, 7, 8].map(i => bot.inventory?.slots?.[i]).filter(Boolean)
      .map(it => ({ name: it.name, ench: Object.fromEntries(enchantsOf(bot, it).map(x => [x.name, x.level])) }))
    const hit = dm.afterDefense(raw, 'melee', dm.defenseOf(armor), { breach: held?.enchanted && weapon === 'mace' ? 4 : 0 })
    return Number.isFinite(hit) ? hit : Infinity
  } catch { return Infinity }
}
// Closing time is priced against the current hand action, not merely a nearby enemy's presence.
// ranged: false — лучник, взявший на прицел, не угроза (стойка со щитом против стрел и есть ответ ему).
// contained — запертые (цель кокона за стенами): такой достаёт только сквозь щель и угрозой считается, лишь если его
// удар дорог — больше четверти моего здоровья или оставит меньше 8 (правило цены: деревянный меч сквозь щель не повод
// бросать кладку крыши — лаборатория 13.10, две клетки крыши так и не легли).
function directThreat(bot, allies: string[] = [], remainingMs = 500, observe = e => e, { ranged = true, contained = [], workMs, opening }: { ranged?: boolean; contained?: string[]; workMs?: number; opening?: Cell } = {}) {
  const candidates = (Object.values(bot.entities || {}) as any[]).filter(e => e && e !== bot.entity &&
    (e.type === 'player' || e.username) && !allies.includes(e.username) && bot.players?.[e.username]?.gamemode !== 3 && seesPlayer(bot, e))
  const visible = candidates.map(observe).filter(Boolean)
  const health = bot.health ?? 20
  let cost = 0
  const cheap = e => { if (!contained.includes(e.username)) return false; const hit = hitBound(bot, e); return hit < health * .25 && health - hit >= 8 }
  for (const e of visible) {
    if (cheap(e)) continue
    const delta = bot.entity.position.minus(e.position), distance = delta.norm()
    const aim = { eye: e.position.offset(0, pick.eyeHeight(bot, e), 0), range: 3 }
    const inReach = !!pick.aim(bot, bot.entity, aim)?.point
    if (!inReach && opening && distance <= 5) {
      const visible = observedCollision(bot)
      // Unknown space cannot be counted as cover once the one observed obstruction is gone.
      const after = Object.create(bot)
      after.blockAt = p => p.equals(opening) ? null : visible.blockAt(p)
      if (pick.aim(after, bot.entity, aim)?.point) return e
    }
    const v = e.velocity, closing = v && distance > 0 ? (v.x * delta.x + v.y * delta.y + v.z * delta.z) / distance * 20 : 0
    if (inReach || closing > 0 && Math.max(0, distance - 3) / closing * 1000 <= remainingMs + 350) {
      // Краткий подкоп окупает удар; длинный — нет, если сумма ударов за окна 10 тиков смертельна.
      if (workMs !== undefined) { cost += hitBound(bot, e) * Math.max(1, Math.ceil(workMs / 500)); if (cost < health) continue }
      return e
    }
  }
  if (visible.length && ranged) {
    const aimed = (require('./threats') as typeof import('./threats')).aims(bot, null, null, { candidates })
    const archer = visible.find(e => aimed.some(a => a.name === e.username))
    if (archer) return archer
  }
  return null
}

function alliedSupport(bot, at, allies, anyPlayer = false) {
  return [bot.entity, ...(Object.values(bot.entities || {}) as any[]).filter(e => (allies.includes(e?.username) || anyPlayer && e?.username) && seesPlayer(bot, e))].some(e => {
    if (!e?.position) return false
    const p = e.position, half = (e.width || .6) / 2
    return at.y === Math.floor(p.y - .01) && p.x + half > at.x && p.x - half < at.x + 1 && p.z + half > at.z && p.z - half < at.z + 1
  })
}

function nearbyBuildFaces(bot, pos, cells, protectedCells): Cell[] {
  if (!Array.isArray(cells) || cells.length > build.FACES.length) return []
  const eye = pick.eyeOf(bot), body = pick.hitboxOf(bot, bot.entity)
  return cells.filter(p => {
    if (!validCell(p) || Math.abs(p.x - pos.x) + Math.abs(p.y - pos.y) + Math.abs(p.z - pos.z) !== 1 ||
        protectedCells.some(c => key(c) === key(p))) return false
    if (body.lo.x < p.x + 1 && body.hi.x > p.x && body.lo.y < p.y + 1 && body.hi.y > p.y && body.lo.z < p.z + 1 && body.hi.z > p.z) return false
    const cell = new Vec3(p.x, p.y, p.z), delta = cell.offset(.5, .5, .5).minus(eye), d = delta.norm()
    if (d > 4.5 || !d || pick.blockOnRay(bot, eye, delta.scaled(1 / d), d) || !AIR.test(bot.blockAt(cell)?.name) ||
        build.occupiedByEntity(bot, cell, { visibleOnly: true })) return false
    return build.FACES.some(f => {
      const ref = cell.minus(f)
      return bot.blockAt(ref)?.boundingBox === 'block' && !!pick.faceAim(bot, ref, f)
    })
  }).map(xyz)
}

async function swarmWork(session, ctl, params: any = {}) {
  if (!params || typeof params !== 'object' || Array.isArray(params)) return { ok: false, done: false, aborted: false, why: 'invalid_work' }
  const { kind, at, item, protected: protectedCells = [], allies = [], contained = [], timeoutSeconds = 5, undermine = false, chestLid = false } = params
  const result = (why, more: any = {}) => ({ ok: false, done: false, aborted: false, kind, at: validCell(at) ? xyz(at) : null, why, ...more })
  if (!validCell(at)) return result('invalid_cell')
  if (!['place', 'dig'].includes(kind) || typeof undermine !== 'boolean' || undermine && kind !== 'dig' || !Number.isFinite(timeoutSeconds) || timeoutSeconds < .1 || timeoutSeconds > 15 ||
    !Array.isArray(protectedCells) || protectedCells.length > 4096 || !protectedCells.every(validCell) ||
    !Array.isArray(allies) || allies.length > 128 || !allies.every(n => typeof n === 'string' && n.length <= 32) ||
    !Array.isArray(contained) || contained.length > 16 || !contained.every(n => typeof n === 'string' && n.length <= 32) ||
    (item != null && (typeof item !== 'string' || !/^[a-z][a-z0-9_]{0,99}$/.test(item)))) return result('invalid_work')
  if (ctl?.aborted) return result('cancelled', { aborted: true })
  const bot = session.bot, pos = new Vec3(at.x, at.y, at.z), before = bot.blockAt(pos)
  if (chestLid) {
    if (!lidBlock.test(item) || params.chestPartner && !validCell(params.chestPartner)) return result('lid_unavailable')
    if (!seenChest(bot, pos, params.chestPartner)) {
      if (kind === 'dig') {
        const base = pos.offset(0, -1, 0), current = bot.blockAt(base)
        if (seenChest(bot, pos)) return result('lid_pair_changed', { partner: null })
        const partner = seenChestPartner(bot, current)
        if (partner) return result('lid_pair_changed', { partner: xyz(partner) })
        if (current && !/^(chest|trapped_chest)$/.test(current.name) && pick.blockSeen(bot, base, { range: 4.5 })) return result('lid_changed')
      }
      return result('lid_unavailable')
    }
    if (kind === 'place' && (typeof params.rival?.id !== 'string' || !AIR.test(before?.name))) return result('lid_unavailable')
    if (kind === 'dig' && before?.name !== item && !AIR.test(before?.name)) return result('lid_changed')
  }
  if (protectedCells.some(p => key(p) === key(at))) return result('protected_cell')
  const exit = params.passageExit
  // A field probe opens one visible sand cap from a separate standing cell; it never steps down.
  const surface = exit && item === 'sand' && at.y === exit.y - 1
  if (exit && (kind !== 'dig' || !validCell(exit) || Math.abs(exit.x - at.x) + Math.abs(exit.z - at.z) !== 1 || !surface && at.y < exit.y || at.y > exit.y + 1)) return result('invalid_work')
  if (kind === 'dig' && alliedSupport(bot, pos, allies, !!exit)) return result('allied_support')
  if (!before) return result('unloaded_cell')
  if (bot.version !== '1.21.11' || !bot._client?.on) return result('native_receipt_unavailable')
  if (kind === 'dig' && AIR.test(before.name)) {
    if (pos.offset(.5, .5, .5).distanceTo(pick.eyeOf(bot)) > 64 || !observedCollision(bot).blockAt(pos)) return result('occluded_or_out_of_reach')
    return result('already_clear', { ok: true, done: true, before: before.name, after: before.name, already: true })
  }
  const gravity = kind === 'place' && build.FALLING.has(item)
  if (gravity && (before.name === item || before.boundingBox === 'empty') && !supportedColumn(bot, pos)) return result('needs_stable_block')
  const inspectMasonry = params.reuseMasonry === true && !chestLid && before.boundingBox !== 'empty'
  const tread = params.outpostFloor === true && !chestLid && outpostTread(before)
  if (kind === 'place' && item && (before.name === item || inspectMasonry || tread)) {
    if ([bot._ndClutch, bot._ndBridgeExec].some(p => p?.pending?.has(key(at)))) return result('server_unconfirmed')
    if (!build.FACES.some(face => pick.faceAim(bot, pos, face))) return result('occluded_or_out_of_reach')
    if (before.name !== item && !tread && (!masonry(before.name) || !before.shapes?.some(s => s.every((v, i) => v === (i < 3 ? 0 : 1))))) return result('occupied_cell', { before: before.name })
    if (params.repair && !chestLid) keepBlocks(bot, [{ ...xyz(at), repair: params.repair }])
    return result('already_placed', { ok: true, done: true, already: true, confirmation: 'visible_existing', before: before.name, after: before.name, ...(tread && { tread: true }) })
  }
  if (kind === 'place' && before.boundingBox !== 'empty') {
    if (!build.FACES.some(face => pick.faceAim(bot, pos, face))) return result('occluded_or_out_of_reach')
    return result('occupied_cell', { before: before.name })
  }

  let plan = kind === 'dig' ? tools.bestFor(bot, before) : null
  const budget = timeoutSeconds * 1000, deadline = clock.now() + budget
  let why = '', foe = null, confirmedState = null, receipt = null
  let clicked = false
  const matchesConfirmed = (after = bot.blockAt(pos)) => confirmedState != null && after?.stateId === confirmedState &&
    after.boundingBox === 'block' && (!item || after.name === item)
  const onClick = () => {
    if (local.aborted) throw new Error(why || 'aborted')
    if (!matchesConfirmed()) confirmedState = null
    clicked = true
  }
  const confirmedBlock = after => clicked && matchesConfirmed(after)
  const sight = createLastSeen(bot)
  let expectedEnd = Math.min(deadline, clock.now() + (plan?.ms ?? 500)), tickWake: (() => void) | null = null
  let wake!: (value: any) => void
  const interrupted = new Promise(resolve => { wake = resolve })
  const local: any = { get aborted() { return !!ctl?.aborted || !!why }, onAbort: [] }
  const stop = (reason) => {
    if (why) return
    why = reason
    for (const cb of local.onAbort.splice(0)) { try { cb() } catch {} }
    try { bot.stopDigging() } catch {}
    try { bot.pathfinder?.setGoal(null) } catch {}
    try { bot.clearControlStates() } catch {}
    wake(result(reason, { aborted: reason !== 'timeout', before: before.name }))
  }
  const cancel = () => stop('cancelled')
  const dead = () => stop('disconnected_or_dead')
  const footingChanged = (_old, block) => {
    const p = block?.position
    if (p?.x === pos.x && p.z === pos.z && p.y < pos.y && supportedColumn(bot, pos) === false) stop('needs_stable_block')
  }
  const threatNow = () => {
    const remaining = Math.max(0, expectedEnd - clock.now())
    return directThreat(bot, allies, remaining, sight.observe, { contained, opening: exit && pos,
      ...(undermine ? { workMs: remaining } : chestLid && kind === 'place' ? { workMs: 50 } : {}) })
  }
  // Свой встал на копаемую клетку уже после начала — стоп (Codex 15.10: проверка была только до начала копки).
  const check = () => {
    tickWake?.(); tickWake = null
    if (why || ctl?.aborted) return
    if (kind === 'dig' && alliedSupport(bot, pos, allies, !!exit)) { stop('allied_support'); return }
    foe = threatNow()
    if (foe) { stop('direct_threat'); return }
    if (exit) {
      if (build.occupiedByEntity(bot, pos, { visibleOnly: true }) || build.isOurOwnSpace(bot, pos)) { stop('occupied_cell'); return }
      const view = observedCollision(bot), feet = new Vec3(exit.x, exit.y, exit.z)
      if (surface) {
        const me = bot.entity.position
        const floor = supportAt(view, me, .04)
        if (!bot.entity.onGround || Math.floor(me.x) !== feet.x || Math.floor(me.z) !== feet.z || Math.abs(me.y - feet.y) > .04 ||
            !floor || key(floor.block.position) !== key(feet.offset(0, -1, 0)) ||
            !withinArena(bot, me, params.arena)) stop('unsafe_probe_stand')
        return
      }
      const air = p => AIR.test(view.blockAt(p)?.name)
      const floor = air(feet.offset(0, -1, 0)) ? feet.offset(0, -2, 0) : feet.offset(0, -1, 0)
      const base = view.blockAt(floor)
      if (!air(feet) || !air(feet.offset(0, 1, 0)) || !base || HAZARD.test(base.name) ||
          !withinArena(bot, floor.offset(.5, 1, .5), params.arena) ||
          !(outpostTread(base) || base.shapes?.some(s => s.every((v,i) => v === (i < 3 ? 0 : 1))))) stop('unsafe_passage_exit')
    }
  }
  let hp = bot.health
  // Рядом запертый (кокон) — мелкий тычок сквозь щель кладку не рвёт: только потеря больше четверти или ниже 8.
  const health = () => {
    const before = hp; hp = bot.health
    const lost = before - hp
    if (lost <= 0 || local.aborted) return
    const mustStop = undermine ? lost * Math.max(1, Math.ceil(Math.max(0, expectedEnd - clock.now()) / 500)) >= hp :
      !contained.length || lost >= before * .25 || hp < 8
    if (!mustStop) return
    // update_health can arrive between physics ticks. A visible threat can already call for retreat.
    foe = hp > 0 ? threatNow() : null
    stop(foe ? 'direct_threat' : 'taking_damage')
  }
  const stopPackets = kind === 'place' ? blockPackets(bot, (p, state) => {
    if (p.x === pos.x && p.y === pos.y && p.z === pos.z) confirmedState = state
  }) : null
  ctl?.onAbort?.push(cancel)
  bot.on('physicsTick', check); bot.on('health', health)
  if (gravity) bot.on('blockUpdate', footingChanged)
  for (const event of ['death', 'end', 'kicked']) bot.on(event, dead)
  const timer = clock.setTimeout(() => stop('timeout'), budget)
  const ASYNC_MUTATORS = new Set(['equip', 'unequip', 'look', 'lookAt', 'dig', '_placeBlockWithOptions', '_genericPlace', 'placeBlock', 'activateBlock'])
  const SYNC_MUTATORS = new Set(['setControlState', 'clearControlStates', 'stopDigging', 'swingArm', 'activateItem', 'deactivateItem'])
  // Gate late body mutations from a detached work() coroutine after stop() so it never races safety.disengage().
  const workBot = new Proxy(bot, {
    get(target, prop) {
      const name = String(prop)
      if (ASYNC_MUTATORS.has(name)) return (...args) => {
        if (local.aborted) return Promise.reject(new Error(why || 'aborted'))
        return target[prop](...args)
      }
      if (SYNC_MUTATORS.has(name)) return (...args) => {
        if (local.aborted) return
        return target[prop](...args)
      }
      const value = target[prop]
      return typeof value === 'function' ? value.bind(target) : value
    },
    set(target, prop, value) {
      if (local.aborted) return true
      target[prop] = value
      return true
    }
  })
  try {
    check()
    const work = async () => {
      if (local.aborted) return result(why || 'cancelled', { aborted: true })
      if (kind === 'place') {
        // Pass raw `bot` into placeChestLid/placeBlockAt so WeakMap-keyed body state (e.g. chest-lid `open`,
        // ally-safety `observedBots`) resolves on the real bot; both helpers check `local.aborted` after every await
        // and `onClick` throws if `local.aborted` before any placement packet.
        let r = chestLid ? await placeChestLid(bot, local, pos, item, params.rival, allies, params.arena,
          onClick, params.chestPartner) :
          await build.placeBlockAt(bot, pos, { item, honest: true, exactAim: true, visibleOccupantsOnly: true, steady: true, timeoutMs: budget, ctl: local, onClick })
        if (!r.ok && !confirmedBlock(bot.blockAt(pos)) && !r.occupiedByEntity && !r.selfOccupied && !r.exitBlocked && !chestLid && !local.aborted && bot.entity.onGround && typeof bot.setControlState === 'function' && at.y > bot.entity.position.y + 1) {
          const jumpEnd = Math.min(clock.now() + 600, expectedEnd + budget)
          try {
            workBot.setControlState('jump', true)
            while (!local.aborted && clock.now() < jumpEnd && !confirmedBlock(bot.blockAt(pos))) {
              await clock.sleep(25)
              if (local.aborted || confirmedBlock(bot.blockAt(pos))) break
              r = await build.placeBlockAt(bot, pos, { item, honest: true, exactAim: true, visibleOccupantsOnly: true, steady: true, timeoutMs: Math.min(600, budget), ctl: local, onClick })
              if (r.ok || r.occupiedByEntity || r.selfOccupied || r.exitBlocked || confirmedBlock(bot.blockAt(pos))) break
            }
          } finally { if (!local.aborted) workBot.setControlState('jump', false) }
        }
        if (local.aborted) return result(why || 'cancelled', { aborted: true })
        const after = bot.blockAt(pos)
        // The new block can hide its previously witnessed support. Only a visible loss invalidates that proof.
        if (gravity && r.ok && supportedColumn(bot, pos) === false) return result('needs_stable_block')
        const confirmed = confirmedBlock(after)
        if (confirmed && !r.ok) r = { ...r, ok: true }
        if (confirmed && r.ok && !chestLid) keepBlocks(bot, [{ ...xyz(at), repair: params.repair }])
        return result(confirmed && r.ok ? 'placed' : r.reason || 'server_unconfirmed', { ok: !!(confirmed && r.ok), done: !!(confirmed && r.ok),
          ...(r.occupiedByEntity && { occupiedByEntity: true }),
          ...(r.selfOccupied && { selfOccupied: true }),
          ...(r.exitBlocked && { exitBlocked: r.exitBlocked }),
          ...(r.noFooting ? { noVisibleSupport: true, viewpoint: xyz(bot.entity.position),
            ...(params.supportCells?.length && { reachableNeighbours: nearbyBuildFaces(bot, pos, params.supportCells, protectedCells) }) } : {}),
          before: before.name, after: after?.name })
      }
      let face = build.FACES.find(f => pick.faceAim(bot, pos, f))
      if (!face || !bot.canDigBlock(before)) return result('occluded_or_out_of_reach')
      if (item && before.name !== item) return result('block_changed')
      if (plan.item) await workBot.equip(plan.item, 'hand')
      if (local.aborted) return result(why || 'cancelled', { aborted: true })
      plan = tools.bestFor(bot, before)
      // A falling body can retain the native airborne dig penalty until the next collision frame.
      while (!local.aborted && plan.ms > deadline - clock.now() && !bot.entity.onGround && bot.entity.velocity?.y <= 0 &&
        !bot.entity.isInWater && !bot.entity.isInLava && supportAt(bot, bot.entity.position, 1.05)) {
        await Promise.race([new Promise<void>(resolve => { tickWake = resolve }), interrupted])
        plan = tools.bestFor(bot, before)
      }
      if (local.aborted) return result(why || 'cancelled', { aborted: true })
      face = build.FACES.find(f => pick.faceAim(bot, pos, f))
      if (!face) return result('occluded_or_out_of_reach')
      await workBot.lookAt(pick.faceAim(bot, pos, face), true)
      if (exit) check()
      if (local.aborted) return result(why || 'cancelled', { aborted: true })
      if (item && (bot.blockAt(pos)?.name !== item || !pick.faceAim(bot, pos, face))) return result('block_changed')
      plan = tools.bestFor(bot, before)
      if (!Number.isFinite(plan.ms) || plan.ms > deadline - clock.now()) return result('work_exceeds_budget', { ms: plan.ms, before: before.name, tool: plan.item?.name || 'hand' })
      receipt = watchDigReceipt(bot, pos, () => local.aborted)
      // Native dig('ignore') preserves the aimed point but also skips its own face assignment.
      workBot.targetDigFace = face.x ? (face.x > 0 ? BlockFaces.EAST : BlockFaces.WEST) :
        face.y ? (face.y > 0 ? BlockFaces.TOP : BlockFaces.BOTTOM) : face.z > 0 ? BlockFaces.SOUTH : BlockFaces.NORTH
      expectedEnd = clock.now() + plan.ms
      await workBot.dig(before, 'ignore')
      if (local.aborted) return result(why || 'cancelled', { aborted: true })
      const accepted = await receipt.settle(Math.min(3000, budget))
      const after = bot.blockAt(pos)
      return result(accepted === 'confirmed' ? 'dug' : 'server_' + accepted, { ok: accepted === 'confirmed', done: accepted === 'confirmed', before: before.name, after: after?.name })
    }
    const workPromise = work()
    workPromise.catch(() => {})
    const out: any = await Promise.race([workPromise, interrupted])
    if (out.why === 'direct_threat' && !ctl?.aborted && (bot.health ?? 0) > 0) {
      const equipWeapon = async () => {
        const weapon = bestWeapon(bot)
        if (weapon && bot.heldItem !== weapon && bot.heldItem?.name !== weapon.name && typeof bot.equip === 'function') {
          await bot.equip(weapon, 'hand').catch(() => {})
        }
      }
      await equipWeapon()
      const state = safety.inspect(bot, { entities: [foe], target: foe })
      if (state.action !== 'fight') {
        const raw = sight.source(foe)
        const present = () => bot.entities?.[foe.id] === raw && raw.isValid !== false
        const foes = () => present() && sight.visible(raw) ? [foe] : []
        const { aims }: typeof import('./threats') = require('./threats')
        const exposed = () => present() && aims(bot, null, null, { candidates: [raw] }).length > 0
        out.retreat = await safety.disengage(session, ctl || { aborted: false }, foes, { ms: 1000, exposed })
        if (!ctl?.aborted && (bot.health ?? 0) > 0) await equipWeapon()
      }
      out.safety = state.action
    }
    // A packet for the last click can arrive during the retreat; the worker needn't stand still to receive it.
    if (clicked && out.aborted && confirmedState != null) {
      const after = bot.blockAt(pos)
      if (confirmedBlock(after) && (!gravity || supportedColumn(bot, pos) !== false)) {
        Object.assign(out, { ok: true, done: true, after: after.name })
        if (!chestLid) keepBlocks(bot, [{ ...xyz(at), repair: params.repair }])
      }
    }
    return out
  } catch (error) {
    stop(why || 'work_failed')
    return result(why, { aborted: why !== 'timeout' && why !== 'work_failed', error: error.message, before: before.name, after: bot.blockAt(pos)?.name })
  } finally {
    tickWake = null
    clock.clearTimeout(timer)
    if (receipt && local.aborted) await receipt.settle(0)
    receipt?.close(); sight.close()
    if (ctl?.onAbort) { const i = ctl.onAbort.indexOf(cancel); if (i >= 0) ctl.onAbort.splice(i, 1) }
    bot.removeListener('physicsTick', check); bot.removeListener('health', health)
    if (gravity) bot.removeListener('blockUpdate', footingChanged)
    for (const event of ['death', 'end', 'kicked']) bot.removeListener(event, dead)
    stopPackets?.()
    try { bot.clearControlStates() } catch {}
  }
}

export { swarmWork, swarmBlueprint, directThreat, keepBlocks, isKept, masonry, outpostTread, validCell, DIRECTIONS, AIR, witnessedBreaches }
