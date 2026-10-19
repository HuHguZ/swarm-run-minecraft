'use strict'
import vec3 from 'vec3'
import * as clock from './game-clock'
import * as build from './build'
import * as pick from './pick'
import { directThreat } from './swarm-work'
import { seesPlayer, createLastSeen } from './pvp/last-seen'
import { observedCollision } from './pvp/search'
import { bodyClear, shapeBoxes, HAZARD } from './navigation/geometry'
// Фабрика vec3 (parseFloat, null → 0,0,0), как прежний require('vec3'); тип — класс Vec3.
const Vec3 = vec3 as unknown as typeof import('vec3').Vec3

const point = p => ({ x: p.x, y: p.y, z: p.z })
const key = p => `${p.x},${p.y},${p.z}`
const finite = p => p && [p.x, p.y, p.z].every(Number.isFinite)
function inside(p, arena) {
  return finite(p) && (!arena || Number.isFinite(arena.x) && Number.isFinite(arena.z) && Number.isFinite(arena.r) &&
    Math.abs(p.x - arena.x) + .3 <= arena.r - 1 && Math.abs(p.z - arena.z) + .3 <= arena.r - 1 &&
    (arena.killY === undefined || Number.isFinite(arena.killY) && p.y > arena.killY))
}
const full = b => b && !HAZARD.test(b.name) && b.shapes?.some(s => s.every((n, i) => n === (i < 3 ? 0 : 1)))

// why — отказ; при ok — блок, запас, высота, опора, вершина и клетки столба.
interface PillarCheck { ok: boolean; why?: string; item?: string; reserve?: number; height?: number; base?: import('vec3').Vec3; at?: { x: number; y: number; z: number }; cells?: import('vec3').Vec3[] }
/** A proposed pillar is an observed empty column above a real full support, never a mining route. */
function pillarCheck(bot, { height = 1, item, reserve = 1, arena }: any = {}, world: import('./navigation/geometry').CollisionWorld = observedCollision(bot)): PillarCheck {
  const fail = why => ({ ok: false, why })
  const p = bot?.entity?.position
  if (!finite(p) || !Number.isInteger(height) || height < 1 || height > 16 || !Number.isInteger(reserve) || reserve < 0 ||
      item !== undefined && (typeof item !== 'string' || item.length > 100)) return fail('invalid_pillar')
  if (!inside(p, arena)) return fail('outside_arena')
  if (!bot.entity.onGround || Math.abs(p.y - Math.round(p.y)) > .03) return fail('unsupported_start')
  const base = new Vec3(Math.floor(p.x), Math.round(p.y), Math.floor(p.z)), at = base.offset(.5, height, .5)
  if (!inside(base.offset(.5, 0, .5), arena) || !inside(at, arena)) return fail('outside_arena')
  const minY = bot.game?.minY ?? -64, maxY = minY + (bot.game?.height ?? 384)
  if (base.y - 1 < minY || base.y + height + 3 >= maxY) return fail('world_height')
  if (!full(world.blockAt(base.offset(0, -1, 0)))) return fail('unobserved_support')
  // The native jump apex and standing head both need room, not merely the blocks being filled.
  for (let y = 0; y <= height + 2; y++) {
    const b = world.blockAt(base.offset(0, y, 0))
    if (!b) return fail('unobserved_column')
    if (shapeBoxes(b).length || HAZARD.test(b.name) || !/^(air|cave_air|void_air)$/.test(b.name)) return fail('blocked_column')
  }
  if (!bodyClear(world, p)) return fail('blocked_start')
  const counts: Record<string, number> = {}
  for (const stack of bot.inventory?.items?.() || []) counts[stack.name] = (counts[stack.name] || 0) + stack.count
  const Block = (require('prismarine-block') as typeof import('prismarine-block'))(bot.registry)
  const suitable = name => {
    const data = bot.registry.blocksByName[name]
    return data && !/glass|sand$|gravel$|concrete_powder$/.test(name) && full(Block.fromStateId(data.defaultState, undefined))
  }
  item ||= Object.keys(counts).filter(suitable).sort((a, b) => counts[b] - counts[a])[0]
  if (!item || !suitable(item)) return fail('no_solid_item')
  if ((counts[item] || 0) - reserve < height) return fail('reserved_blocks')
  return { ok: true, item, reserve, height, base, at: point(at), cells: Array.from({ length: height }, (_, y) => base.offset(0, y, 0)) }
}

// healthFloor — урон не обрывает работу, пока здоровье не ниже порога (стойка щитом под обстрелом);
// ranged — прицел лучника считать угрозой (для стойки со щитом — нет).
function guard(bot, ctl, p, budget, { healthFloor = Infinity, ranged = true }: { healthFloor?: number; ranged?: boolean } = {}) {
  const sight = createLastSeen(bot), start = clock.now(), end = start + budget
  let why = '', active = true, hp = bot.health, wake
  const interrupted = new Promise(resolve => { wake = resolve })
  const local: any = { get aborted() { return !active || !!why || !!ctl?.aborted }, onAbort: [] }
  const stop = reason => {
    if (why || !active) return
    why = reason
    try { bot.clearControlStates() } catch {}
    try { bot.pathfinder?.setGoal(null) } catch {}
    for (const f of [...local.onAbort]) f()
    wake(null)
  }
  const cancel = () => stop('cancelled'), dead = () => stop('disconnected_or_dead')
  const check = () => {
    if (local.aborted) { if (ctl?.aborted) stop('cancelled'); return }
    if (!inside(bot.entity.position, p.arena)) { stop('outside_arena'); return }
    if (p.arena && bot.entity.velocity) {
      const edges: typeof import('./edges') = require('./edges'), state = edges.stateOf(bot, Object.fromEntries(['forward', 'back', 'left', 'right', 'jump', 'sprint', 'sneak'].map(k => [k, !!bot.getControlState?.(k)])))
      edges.simOf(bot)(state, edges.worldOf(bot))
      if (!inside(state.pos, p.arena)) { stop('arena_step'); return }
    }
    if (directThreat(bot, p.allies || [], Math.min(750, end - clock.now()), sight.observe, { ranged })) stop('direct_threat')
  }
  const health = () => { if (bot.health < hp && (healthFloor === Infinity || bot.health < healthFloor)) stop('taking_damage'); hp = bot.health }
  ctl?.onAbort?.push(cancel)
  bot.on('physicsTick', check); bot.on('health', health)
  for (const event of ['death', 'end', 'kicked']) bot.on(event, dead)
  const timer = clock.setTimeout(() => stop('timeout'), budget)
  const out = (extra = {}) => ({ ok: !why && !ctl?.aborted, aborted: !!why && why !== 'timeout' || !!ctl?.aborted,
    why: why || (ctl?.aborted ? 'cancelled' : 'completed'), at: point(bot.entity.position), ...extra })
  return { local, interrupted, check, stop, out, start, sight,
    get active() { return active && !local.aborted },
    close() {
      active = false; clock.clearTimeout(timer); sight.close()
      if (ctl?.onAbort) { const i = ctl.onAbort.indexOf(cancel); if (i >= 0) ctl.onAbort.splice(i, 1) }
      bot.removeListener('physicsTick', check); bot.removeListener('health', health)
      for (const event of ['death', 'end', 'kicked']) bot.removeListener(event, dead)
      bot.clearControlStates()
    } }
}

// Стойка на месте: присед и взгляд на видимого врага (часовой, засада). shield: true — стойка кольца: щит поднят,
// лицом к видимому врагу снаружи кольца, а нет такого — наружу, на точку face; стрелы в щит стойку не рвут, рвёт только
// ближний бой и здоровье ниже healthFloor (6).
async function swarmHold(session, ctl, p: any = {}) {
  const bot = session.bot, seconds = p.seconds ?? p.timeoutSeconds ?? 3
  if (!bot?.entity || !Number.isFinite(seconds) || seconds <= 0 || seconds > 5 || !inside(bot.entity.position, p.arena) ||
      p.allies && (!Array.isArray(p.allies) || p.allies.length > 128 || p.allies.some(n => typeof n !== 'string')) ||
      p.enemies && (!Array.isArray(p.enemies) || p.enemies.length > 128 || p.enemies.some(n => !['string', 'number'].includes(typeof n))) ||
      p.face !== undefined && !finite(p.face) || p.healthFloor !== undefined && !Number.isFinite(p.healthFloor)) return { ok: false, why: 'invalid_hold' }
  const shieldMode = p.shield === true
  const g = guard(bot, ctl, p, seconds * 1000 + 50, shieldMode ? { healthFloor: p.healthFloor ?? 6, ranged: false } : {})
  let seen = 0, shield = null, raisedTicks = 0
  try {
    g.check()
    if (shieldMode && g.active) {
      shield = (require('./combat') as typeof import('./combat')).makeShield(session, g.local, { shield: 'always' })
      if (!(await shield.wear())) { const why = shield.report()?.why; shield.close(); shield = null; if (p.requireShield) { g.stop('no_shield'); return g.out({ shieldWhy: why }) } }
    }
    if (g.active) { bot.clearControlStates(); bot.setControlState('sneak', !shieldMode && p.sneak !== false) }
    const face = p.face ? new Vec3(p.face.x, p.face.y, p.face.z) : null
    const watch = async () => {
      while (g.active && clock.now() - g.start < seconds * 1000) {
        const me = bot.entity.position
        const outward = face ? face.minus(me) : null
        const visible = (Object.values(bot.entities || {}) as any[]).filter(e => e && e !== bot.entity &&
          (e.type === 'player' || e.username) && !(p.allies || []).includes(e.username) &&
          (!p.enemies?.length || p.enemies.includes(e.username) || p.enemies.includes(e.id)) && seesPlayer(bot, e))
        // Position is read only after strict LOS. No opponent health or inventory enters this skill.
        // В кольце — только враг снаружи (с моей стороны кольца): повернуться к тому, кто за спиной, — открыть спину кольца.
        const enemy = visible.filter(e => !outward || outward.x * (e.position.x - me.x) + outward.z * (e.position.z - me.z) > 0)
          .sort((a, b) => a.position.distanceTo(me) - b.position.distanceTo(me))[0]
        if (enemy) { seen++; await bot.lookAt(enemy.position.offset(0, pick.eyeHeight(bot, enemy), 0), true) }
        else if (face) await bot.lookAt(face, true)
        else await bot.look(bot.entity.yaw + Math.PI / 8, bot.entity.pitch || 0, true)
        if (shield && g.active) { await shield.raise(true); if (shield.blocking()) raisedTicks += 2 }
        if (g.active) await clock.sleep(100)
      }
    }
    await Promise.race([watch(), g.interrupted])
    return g.out({ heldSeconds: Math.min(seconds, (clock.now() - g.start) / 1000), seen,
      ...(shieldMode ? { shield: shield ? { blockingSeconds: raisedTicks / 20, ...shield.nativeUse() } : null } : {}) })
  } catch (error) { g.stop('hold_failed'); return g.out({ error: error.message, seen }) }
  finally { shield?.close(); g.close() }
}

async function swarmPillar(session, ctl, p: any = {}) {
  const bot = session.bot, seconds = p.timeoutSeconds ?? 15
  if (!bot?.entity || !Number.isFinite(seconds) || seconds <= 0 || seconds > 30 ||
      p.allies && (!Array.isArray(p.allies) || p.allies.length > 128 || p.allies.some(n => typeof n !== 'string'))) return { ok: false, why: 'invalid_pillar' }
  const initial: any = pillarCheck(bot, p)
  if (!initial.ok) return initial
  const g = guard(bot, ctl, p, seconds * 1000), receipts = new Map<string, number>()
  const expected = new Set(initial.cells.map(key))
  const single = packet => { if (packet?.location && expected.has(key(packet.location)) && Number.isInteger(packet.type)) receipts.set(key(packet.location), packet.type) }
  const multi = packet => {
    const c = packet?.chunkCoordinates
    if (!c || ![c.x, c.y, c.z].every(Number.isInteger) || !Array.isArray(packet.records)) return
    for (const r of packet.records) if (Number.isSafeInteger(r)) single({ location: { x: c.x * 16 + ((r >>> 8) & 15), y: c.y * 16 + (r & 15), z: c.z * 16 + ((r >>> 4) & 15) }, type: Math.floor(r / 4096) })
  }
  bot._client.on('block_change', single); bot._client.on('multi_block_change', multi)
  const countPlaced = () => initial.cells.filter(cell => {
    const b = bot.blockAt(cell, false)
    return b?.name === initial.item && full(b) && receipts.get(key(cell)) === b.stateId
  }).length
  // The existing executor may still settle an await after cancellation. Gate its late output to the real body.
  const facade = new Proxy(bot, { get(target, name) {
    if (['setControlState', 'clearControlStates', 'look', 'lookAt', 'equip', '_genericPlace'].includes(String(name))) return (...args) => {
      g.check()
      if (!g.active) return Promise.resolve()
      if (name === '_genericPlace') {
        const [ref, face] = args, cell = ref.position.plus(face)
        if (!expected.has(key(cell)) || target.heldItem?.name !== initial.item || !pick.faceAim(target, ref.position, face)) { g.stop('occluded_placement'); return Promise.resolve() }
      }
      return target[name](...args)
    }
    const value = target[name]; return typeof value === 'function' ? value.bind(target) : value
  } })
  try {
    g.check()
    const work = async () => {
      if (!g.active) return null
      return build.towerUp(facade, g.local, initial.height, { item: initial.item, sneak: true, maxDigMs: 0,
        abortIf: () => { g.check(); return g.active ? null : 'interrupted' }, beforeStep: () => {
          const raised = Math.round(bot.entity.position.y - initial.base.y), remaining = initial.height - raised
          if (Math.floor(bot.entity.position.x) !== initial.base.x || Math.floor(bot.entity.position.z) !== initial.base.z || remaining <= 0) return 'abort'
          const next: any = pillarCheck(bot, { ...p, item: initial.item, height: remaining })
          if (!next.ok) { g.stop(next.why); return 'abort' }
        } })
    }
    const result: any = await Promise.race([work(), g.interrupted])
    const placed = countPlaced()
    const raised = Math.max(0, bot.entity.position.y - initial.base.y)
    return g.out({ ok: !!(g.active && result?.ok && placed === initial.height && bot.entity.onGround && raised >= initial.height - .03),
      placed, raised, item: initial.item, ...(g.active && placed !== initial.height ? { why: 'server_unconfirmed' } :
        g.active && !result?.ok ? { why: 'pillar_incomplete' } : {}) })
  } catch (error) { g.stop('pillar_failed'); return g.out({ error: error.message, placed: countPlaced() }) }
  finally { bot._client.removeListener('block_change', single); bot._client.removeListener('multi_block_change', multi); g.close() }
}

export { pillarCheck, swarmHold, swarmPillar }
