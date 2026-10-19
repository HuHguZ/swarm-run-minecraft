'use strict'
import vec3 from 'vec3'
import * as clock from './game-clock'
import * as build from './build'
import * as pick from './pick'
import * as tools from './tools'
import * as safety from './combat-safety'
import { seesPlayer, createLastSeen } from './pvp/last-seen'
import { watchDigReceipt } from './environments/dig-receipt'
import { iterators } from 'prismarine-world'
// Фабрика vec3 (parseFloat, null → 0,0,0), как прежний require('vec3'); тип — класс Vec3.
const Vec3 = vec3 as unknown as typeof import('vec3').Vec3
const BlockFaces = iterators.BlockFace

type Cell = { x: number; y: number; z: number }
const xyz = (p): Cell => ({ x: p.x, y: p.y, z: p.z })
const key = p => `${p.x},${p.y},${p.z}`
const validCell = p => p && ['x', 'y', 'z'].every(k => Number.isSafeInteger(p[k])) &&
  Math.abs(p.x) < 30_000_000 && Math.abs(p.z) < 30_000_000 && p.y >= -64 && p.y <= 319
const DIRECTIONS = { north: [0, -1], south: [0, 1], east: [1, 0], west: [-1, 0] }
const AIR = /^(air|cave_air|void_air)$/

// Свои постройки роя (кокон, загон, укрытие): бой их не прорубает. «Пробил его стенку» принимал кокон вокруг цели за её
// стену — строитель сам вскрыл две клетки, которые поставил (лаборатория 14.10, кокон 21/23). Знание честное: клетки
// положил сам бот или их подтвердил журнал роя.
const kept = new WeakMap<object, Map<string, number>>()
function keepBlocks(bot, cells: Cell[] = [], { clear = false, ms = 300000 } = {}) {
  if (clear) kept.delete(bot)
  const map = kept.get(bot) || new Map<string, number>(), until = clock.now() + ms
  for (const c of cells) if (validCell(c)) map.set(key(c), until)
  if (map.size) kept.set(bot, map)
  return map.size
}
const isKept = (bot, p) => (kept.get(bot)?.get(key({ x: Math.floor(p.x), y: Math.floor(p.y), z: Math.floor(p.z) })) ?? 0) > clock.now()

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
    const raw = dm.meleeRaw({ weapon, sharpness: held?.enchanted && /_(sword|axe|spear)$/.test(weapon || '') ? 5 : 0, crit: true, density: held?.enchanted && weapon === 'mace' ? 5 : 0 })
    const armor = [5, 6, 7, 8].map(i => bot.inventory?.slots?.[i]).filter(Boolean)
      .map(it => ({ name: it.name, ench: Object.fromEntries(enchantsOf(bot, it).map(x => [x.name, x.level])) }))
    const hit = dm.afterDefense(raw, 'melee', dm.defenseOf(armor))
    return Number.isFinite(hit) ? hit : Infinity
  } catch { return Infinity }
}
// Closing time is priced against the current hand action, not merely a nearby enemy's presence.
// ranged: false — лучник, взявший на прицел, не угроза (стойка со щитом против стрел и есть ответ ему).
// contained — запертые (цель кокона за стенами): такой достаёт только сквозь щель и угрозой считается, лишь если его
// удар дорог — больше четверти моего здоровья или оставит меньше 8 (правило цены: деревянный меч сквозь щель не повод
// бросать кладку крыши — лаборатория 13.10, две клетки крыши так и не легли).
function directThreat(bot, allies: string[] = [], remainingMs = 500, observe = e => e, { ranged = true, contained = [] }: { ranged?: boolean; contained?: string[] } = {}) {
  const visible = (Object.values(bot.entities || {}) as any[]).filter(e => e && e !== bot.entity &&
    (e.type === 'player' || e.username) && !allies.includes(e.username) && seesPlayer(bot, e)).map(observe).filter(Boolean)
  const health = bot.health ?? 20
  const cheap = e => { if (!contained.includes(e.username)) return false; const hit = hitBound(bot, e); return hit < health * .25 && health - hit >= 8 }
  for (const e of visible) {
    if (cheap(e)) continue
    if (pick.aim(bot, bot.entity, { eye: e.position.offset(0, pick.eyeHeight(bot, e), 0), range: 3 })?.point) return e
    const delta = bot.entity.position.minus(e.position), distance = delta.norm()
    const v = e.velocity, closing = v && distance > 0 ? (v.x * delta.x + v.y * delta.y + v.z * delta.z) / distance * 20 : 0
    if (closing > 0 && Math.max(0, distance - 3) / closing * 1000 <= remainingMs + 350) return e
  }
  if (visible.length && ranged) {
    const aimed = (require('./threats') as typeof import('./threats')).dangers(bot, { foes: visible.map(e => e.username) }).aims || []
    const archer = visible.find(e => aimed.some(a => a.name === e.username))
    if (archer) return archer
  }
  return null
}

function alliedSupport(bot, at, allies) {
  return [bot.entity, ...(Object.values(bot.entities || {}) as any[]).filter(e => allies.includes(e?.username) && seesPlayer(bot, e))].some(e => {
    if (!e?.position) return false
    const p = e.position, half = (e.width || .6) / 2
    return at.y === Math.floor(p.y - .01) && p.x + half > at.x && p.x - half < at.x + 1 && p.z + half > at.z && p.z - half < at.z + 1
  })
}

async function swarmWork(session, ctl, params: any = {}) {
  if (!params || typeof params !== 'object' || Array.isArray(params)) return { ok: false, done: false, aborted: false, why: 'invalid_work' }
  const { kind, at, item, protected: protectedCells = [], allies = [], contained = [], timeoutSeconds = 5 } = params
  const result = (why, more: any = {}) => ({ ok: false, done: false, aborted: false, kind, at: validCell(at) ? xyz(at) : null, why, ...more })
  if (!validCell(at)) return result('invalid_cell')
  if (!['place', 'dig'].includes(kind) || !Number.isFinite(timeoutSeconds) || timeoutSeconds < .1 || timeoutSeconds > 15 ||
    !Array.isArray(protectedCells) || protectedCells.length > 4096 || !protectedCells.every(validCell) ||
    !Array.isArray(allies) || allies.length > 128 || !allies.every(n => typeof n === 'string' && n.length <= 32) ||
    !Array.isArray(contained) || contained.length > 16 || !contained.every(n => typeof n === 'string' && n.length <= 32) ||
    (item != null && (typeof item !== 'string' || !/^[a-z][a-z0-9_]{0,99}$/.test(item)))) return result('invalid_work')
  if (ctl?.aborted) return result('cancelled', { aborted: true })
  const bot = session.bot, pos = new Vec3(at.x, at.y, at.z), before = bot.blockAt(pos)
  if (protectedCells.some(p => key(p) === key(at))) return result('protected_cell')
  if (kind === 'dig' && alliedSupport(bot, pos, allies)) return result('allied_support')
  if (!before) return result('unloaded_cell')
  if (bot.version !== '1.21.11' || !bot._client?.on) return result('native_receipt_unavailable')
  if (kind === 'dig' && AIR.test(before.name)) return result('already_clear', { ok: true, done: true, before: before.name, after: before.name, already: true })
  if (kind === 'place' && item && before.name === item) {
    if ([bot._ndClutch, bot._ndBridgeExec].some(p => p?.pending?.has(key(at)))) return result('server_unconfirmed')
    if (!build.FACES.some(face => pick.faceAim(bot, pos, face))) return result('occluded_or_out_of_reach')
    return result('already_placed', { ok: true, done: true, already: true, confirmation: 'visible_existing', before: before.name, after: before.name })
  }
  if (kind === 'place' && before.boundingBox !== 'empty') return result('occupied_cell', { before: before.name })

  const plan = kind === 'dig' ? tools.bestFor(bot, before) : null
  const budget = timeoutSeconds * 1000
  if (plan && (!Number.isFinite(plan.ms) || plan.ms > budget)) return result('work_exceeds_budget', { ms: plan.ms, before: before.name, tool: plan.item?.name || 'hand' })
  let why = '', foe = null, confirmedState = null, receipt = null
  const sight = createLastSeen(bot), expectedEnd = clock.now() + (plan?.ms ?? 500)
  let wake!: (value: any) => void
  const interrupted = new Promise(resolve => { wake = resolve })
  const local: any = { get aborted() { return !!ctl?.aborted || !!why }, onAbort: [] }
  const stop = (reason) => {
    if (why) return
    why = reason
    try { bot.stopDigging() } catch {}
    try { bot.pathfinder?.setGoal(null) } catch {}
    try { bot.clearControlStates() } catch {}
    wake(result(reason, { aborted: reason !== 'timeout', before: before.name }))
  }
  const cancel = () => stop('cancelled')
  const dead = () => stop('disconnected_or_dead')
  // Свой встал на копаемую клетку уже после начала — стоп (Codex 15.10: проверка была только до начала копки).
  const check = () => { if (why || ctl?.aborted) return; if (kind === 'dig' && alliedSupport(bot, pos, allies)) { stop('allied_support'); return } foe = directThreat(bot, allies, Math.max(0, expectedEnd - clock.now()), sight.observe, { contained }); if (foe) stop('direct_threat') }
  let hp = bot.health
  // Рядом запертый (кокон) — мелкий тычок сквозь щель кладку не рвёт: только потеря больше четверти или ниже 8.
  const health = () => { const lost = hp - bot.health; if (lost > 0 && (!contained.length || lost >= hp * .25 || bot.health < 8)) stop('taking_damage'); hp = bot.health }
  const matches = p => p && p.x === pos.x && p.y === pos.y && p.z === pos.z
  const single = p => { if (matches(p?.location) && Number.isInteger(p.type)) confirmedState = p.type }
  const multi = p => {
    const c = p?.chunkCoordinates
    if (!c || ![c.x, c.y, c.z].every(Number.isInteger) || !Array.isArray(p.records)) return
    for (const r of p.records) if (Number.isSafeInteger(r) && matches({ x: c.x * 16 + ((r >>> 8) & 15), y: c.y * 16 + (r & 15), z: c.z * 16 + ((r >>> 4) & 15) })) confirmedState = Math.floor(r / 4096)
  }
  ctl?.onAbort?.push(cancel)
  bot.on('physicsTick', check); bot.on('health', health)
  for (const event of ['death', 'end', 'kicked']) bot.on(event, dead)
  if (kind === 'place') { bot._client.on('block_change', single); bot._client.on('multi_block_change', multi) }
  const timer = clock.setTimeout(() => stop('timeout'), budget)
  try {
    check()
    const work = async () => {
      if (local.aborted) return result(why || 'cancelled', { aborted: true })
      if (kind === 'place') {
        let r = await build.placeBlockAt(bot, pos, { item, honest: true, steady: true, timeoutMs: budget, ctl: local })
        if (!r.ok && !local.aborted && bot.entity.onGround && typeof bot.setControlState === 'function' && at.y > bot.entity.position.y + 1) {
          const jumpEnd = Math.min(clock.now() + 600, expectedEnd + budget)
          try {
            bot.setControlState('jump', true)
            while (!local.aborted && clock.now() < jumpEnd) {
              await clock.sleep(25)
              r = await build.placeBlockAt(bot, pos, { item, honest: true, steady: true, timeoutMs: Math.min(600, budget), ctl: local })
              if (r.ok) break
            }
          } finally { bot.setControlState('jump', false) }
        }
        if (local.aborted) return result(why || 'cancelled', { aborted: true })
        const after = bot.blockAt(pos)
        const confirmed = confirmedState != null && after?.stateId === confirmedState && after.boundingBox === 'block' && (!item || after.name === item)
        if (confirmed && r.ok) keepBlocks(bot, [xyz(at)])
        return result(confirmed && r.ok ? 'placed' : r.reason || 'server_unconfirmed', { ok: !!(confirmed && r.ok), done: !!(confirmed && r.ok), before: before.name, after: after?.name })
      }
      let face = build.FACES.find(f => pick.faceAim(bot, pos, f))
      if (!face || !bot.canDigBlock(before)) return result('occluded_or_out_of_reach')
      if (plan.item) await bot.equip(plan.item, 'hand')
      if (local.aborted) return result(why || 'cancelled', { aborted: true })
      face = build.FACES.find(f => pick.faceAim(bot, pos, f))
      if (!face) return result('occluded_or_out_of_reach')
      await bot.lookAt(pick.faceAim(bot, pos, face), true)
      if (local.aborted) return result(why || 'cancelled', { aborted: true })
      receipt = watchDigReceipt(bot, pos, () => local.aborted)
      // Native dig('ignore') preserves the aimed point but also skips its own face assignment.
      bot.targetDigFace = face.x ? (face.x > 0 ? BlockFaces.EAST : BlockFaces.WEST) :
        face.y ? (face.y > 0 ? BlockFaces.TOP : BlockFaces.BOTTOM) : face.z > 0 ? BlockFaces.SOUTH : BlockFaces.NORTH
      await bot.dig(before, 'ignore')
      if (local.aborted) return result(why || 'cancelled', { aborted: true })
      const accepted = await receipt.settle(Math.min(3000, budget))
      const after = bot.blockAt(pos)
      return result(accepted === 'confirmed' ? 'dug' : 'server_' + accepted, { ok: accepted === 'confirmed', done: accepted === 'confirmed', before: before.name, after: after?.name })
    }
    const out: any = await Promise.race([work(), interrupted])
    if (out.why === 'direct_threat' && !ctl?.aborted && (bot.health ?? 0) > 0) {
      const state = safety.inspect(bot, { entities: [foe], target: foe })
      if (state.action !== 'fight') out.retreat = await safety.disengage(session, ctl || { aborted: false }, () => [foe], { ms: 1000 })
      out.safety = state.action
    }
    return out
  } catch (error) {
    stop(why || 'work_failed')
    return result(why, { aborted: why !== 'timeout' && why !== 'work_failed', error: error.message, before: before.name, after: bot.blockAt(pos)?.name })
  } finally {
    clock.clearTimeout(timer)
    if (receipt && local.aborted) await receipt.settle(0)
    receipt?.close(); sight.close()
    if (ctl?.onAbort) { const i = ctl.onAbort.indexOf(cancel); if (i >= 0) ctl.onAbort.splice(i, 1) }
    bot.removeListener('physicsTick', check); bot.removeListener('health', health)
    for (const event of ['death', 'end', 'kicked']) bot.removeListener(event, dead)
    bot._client.removeListener('block_change', single); bot._client.removeListener('multi_block_change', multi)
    try { bot.clearControlStates() } catch {}
  }
}

export { swarmWork, swarmBlueprint, directThreat, keepBlocks, isKept }
