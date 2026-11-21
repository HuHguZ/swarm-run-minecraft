import { Vec3 } from 'vec3'
import * as clock from '../game-clock'
import { pickFiller, placeBlockAt, withTimeout } from '../build'
import { seesPlayer, gearPartVisible } from '../pvp/last-seen'
import { observedCollision } from '../pvp/search'
import { reachFrom } from '../pvp/body'
import { bodyClear, supportAt } from '../navigation/geometry'
import { withinArena } from '../navigation/parkour/model'
import { faceAim, RANGE } from '../pick'
import { visibleAllies, isAlly } from './ally-safety'
import { observedVelocity } from '../bow/track'
import { isSpear, MAX_R } from '../spear'
import { incoming } from '../threats'

const UP = new Vec3(0, 1, 0)
const full = block => block?.shapes?.some(s => s.every((v, i) => v === (i < 3 ? 0 : 1)))
const air = block => !!block && /^(air|cave_air|void_air)$/.test(block.name)

/** Automatic retreat makes a single placement in a doorway that it can actually obstruct. */
export async function blockBehind(bot, foe, { ctl = null, retreatYaw = null, deadline = Infinity, stop = null, arena = null }: any = {}) {
  const fleeing = retreatYaw != null
  const seen = () => bot.entity && foe?.position && !isAlly(bot, foe) && bot.players?.[foe.username]?.gamemode !== 3 &&
    (!foe.username || bot.players?.[foe.username]?.entity === foe) && seesPlayer(bot, foe)
  if (!seen()) return { ok: false, why: 'не вижу его' }
  const from = bot.entity.position.floored(), delta = foe.position.minus(bot.entity.position)
  const axis = Math.abs(delta.x) >= Math.abs(delta.z) ? 'x' : 'z', other = axis === 'x' ? 'z' : 'x'
  const sign = Math.sign(delta[axis]), step = new Vec3(axis === 'x' ? sign : 0, 0, axis === 'z' ? sign : 0)
  const side = new Vec3(axis === 'z' ? 1 : 0, 0, axis === 'x' ? 1 : 0), cell = from.plus(step)
  if (!sign) return { ok: false, why: 'нет прохода за спиной' }
  const items = bot.inventory.items()
  if (!items.length) return { ok: false, why: 'нечем' }
  if (fleeing && (Math.abs(delta.y) >= 1 || foe.position.floored()[other] !== cell[other] ||
    observedVelocity(foe)[axis] * sign >= 0 ||
    -(axis === 'x' ? Math.sin(retreatYaw) : Math.cos(retreatYaw)) * sign >= -.5)) return { ok: false, why: 'другой путь отхода' }

  const world = observedCollision(bot)
  const walled = (view, at) => full(view.blockAt(at.plus(side))) && full(view.blockAt(at.minus(side)))
  const corridor = walled(world, cell)
  const low = corridor && full(world.blockAt(cell.offset(0, 2, 0)))
  const head = cell.plus(UP), hanging = fleeing && !low
  const upperChoke = view => walled(view, head) && walled(view, head.plus(step)) && air(view.blockAt(head))
  if (hanging && (!corridor || !upperChoke(world))) return { ok: false, why: 'один блок не закроет проход' }
  if (!air(world.blockAt(cell))) return { ok: false, why: 'клетка занята' }
  const item = name => items.find(i => i.name === name)
  const web = !hanging && item('cobweb'), filler = corridor && pickFiller(bot, { steady: hanging })
  if (!web && !filler && (fleeing || !item('lava_bucket') && !item('water_bucket'))) return { ok: false, why: 'нечем' }
  // A runner already separated by a low barrier can keep moving without paving the tunnel behind them.
  if (fleeing) for (let n = 2; n < Math.abs(foe.position.floored()[axis] - from[axis]); n++) {
    const pathCell = from.plus(step.scaled(n))
    if (!air(world.blockAt(pathCell)) || hanging && !air(world.blockAt(pathCell.plus(UP)))) return { ok: false, why: 'проход уже перекрыт' }
  }
  // The time until the sprinting pursuer can strike also bounds the wait for a placement receipt.
  const contactMs = () => {
    const v = observedVelocity(foe)
    const speed = Math.max(.28, -(v[axis] || 0) * sign)
    const spear = foe.username && gearPartVisible(bot, foe, 0) && isSpear((foe.equipment?.[0] ?? foe.heldItem)?.name)
    const reach = spear ? MAX_R + speed : RANGE
    return (reachFrom(foe.position.offset(0, (foe.height || 1.8) * .9, 0), bot.entity) - reach) / speed * 50
  }
  const until = Math.min(deadline, clock.now() + Math.min(1200, contactMs() - 50))
  const unsafe = () => {
    if (ctl?.aborted || clock.now() + 50 >= until) return 'нет времени на блок'
    if (!seen()) return 'не вижу его'
    if (!bot.entity.position.floored().equals(from) || (foe.position[axis] - (cell[axis] + .5)) * sign <= .5 ||
      fleeing && (foe.position.floored()[other] !== cell[other] || observedVelocity(foe)[axis] * sign >= 0) ||
      contactMs() < 100) return 'положение изменилось'
    // A second exit towards the attacker does not help the teammate still crossing this doorway.
    for (const ally of visibleAllies(bot)) {
      const pos = ally.position, half = (ally.width || .6) / 2
      const along = (pos[axis] - cell[axis] - .5) * sign
      if (along >= -.5 - half && (foe.position[axis] - pos[axis]) * sign >= -half &&
        Math.abs(pos[other] - cell[other] - .5) < .5 + half && pos.y < cell.y + 2 && pos.y + (ally.height || 1.8) > cell.y) return 'союзник ещё в проходе'
    }
    const view = observedCollision(bot)
    if (fleeing) {
      const intact = walled(view, cell) && (hanging ? upperChoke(view) : full(view.blockAt(cell.offset(0, 2, 0))))
      if (!intact || incoming(bot).some(p => p.ticks <= 10)) return 'проход или опасность изменились'
    }
    const exits = fleeing ? [step.scaled(-1)] : [step.scaled(-1), side, side.scaled(-1)]
    if (!exits.some(d => {
      const pos = from.plus(d).offset(.5, 0, .5)
      return withinArena(view, pos, arena, bot.entity.position) &&
        bodyClear(view, pos) && supportAt(view, pos, .05)
    })) return 'нет безопасного выхода'
    return null
  }
  let reason = unsafe()
  if (reason) return { ok: false, why: reason }
  if (hanging && !faceAim(bot, head.minus(side), side) && !faceAim(bot, head.plus(side), side.scaled(-1))) return { ok: false, why: 'не вижу боковой грани' }
  stop?.()
  const guard = { get aborted() { return !!reason || ctl?.aborted || clock.now() >= until } }
  const put = async (at, name) => {
    const budget = Math.max(1, until - clock.now())
    const r = await withTimeout(placeBlockAt(bot, at, { item: name, honest: true, exactAim: true, visibleOccupantsOnly: true,
      timeoutMs: budget, ctl: guard, onClick: (ref, face, aim) => {
        reason = unsafe()
        if (!reason && (!air(bot.blockAt(at)) || !faceAim(bot, ref.position, face)?.equals(aim))) reason = 'грань больше не видна'
        if (reason) throw new Error(reason)
      } }), budget).catch(() => null)
    return !!r?.placed
  }
  if (web && await put(cell, web.name)) return { ok: true, how: 'паутина', corridor }
  if (!guard.aborted && corridor && filler) {
    const base = !hanging && await put(cell, filler.name)
    const top = !reason && !low && await put(head, filler.name)
    if (base || top) return { ok: true, how: `стена ${Number(base) + Number(!!top)}`, corridor }
  }
  if (!fleeing && !guard.aborted) for (const [name, how] of [['lava_bucket', 'лава'], ['water_bucket', 'вода']]) {
    const it = item(name)
    if (!it) continue
    try {
      await withTimeout(bot.equip(it, 'hand'), Math.max(1, until - clock.now()))
      const floor = cell.minus(UP), aim = faceAim(bot, floor, UP)
      if (!aim) continue
      await withTimeout(bot.lookAt(aim, true), Math.max(1, until - clock.now()))
      reason = unsafe()
      if (reason || !faceAim(bot, floor, UP)?.equals(aim)) break
      bot.activateItem()
      return { ok: true, how, corridor }
    } catch {}
  }
  return { ok: false, why: reason || 'не удалось поставить', corridor }
}
