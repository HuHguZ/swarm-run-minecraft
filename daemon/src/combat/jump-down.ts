// Спрыгнуть от врага (пользователь 25.10: «не спрыгивают сверху — легко умирают»): наверху (ярус, крыша, насест) человек
// пришёл на удар — край в стороне от него, где падение дёшево: вода, ведро в хотбаре (сторож падения ставит воду сам) или урон,
// после которого остаётся minHpAfter. Сход и торможение на уступе проверяются физикой клиента.
import { Vec3 } from 'vec3'
import { bodyClear, HAZARD, supportAt } from '../navigation/geometry'
import { landingDamage } from '../navigation/landing'
import { DROP_VARIANTS, planLedgeDrop, planWaterDrop, seesPoint } from '../navigation/descent'
import { executePlan, withinArena } from '../navigation/parkour'
import { runDrop } from '../flee-drop'
import { eyeHeight } from '../pick'

const DIRS = 16

export async function jumpDown (session, ctl, p: any = {}) {
  const bot = session.require()
  const me = bot.entity.position.clone(), hp = bot.health ?? 20, minHpAfter = p.minHpAfter ?? 6
  const edges = require('../edges') as typeof import('../edges')
  if (ctl.aborted || !bot.entity.onGround || hp <= 0) return { ok: false, why: 'нет опоры для спуска' }
  const bucket = edges.mlgDrop(session)
  const bucketReady = bucket.ok && bot._ndFallGuard?.waterReady?.().ok
  const from = p.from ? new Vec3(p.from.x, p.from.y, p.from.z) : null
  const eye = me.offset(0, eyeHeight(bot), 0)
  const velocity = bot.entity.velocity.clone()
  const fy = Math.floor(me.y + 1e-6)
  const bottom = Math.max(fy - 48, Math.floor(Math.max(p.arena?.killY ?? -Infinity, p.arena?.minY ?? -Infinity)) - 1)
  const candidates = [], seen = new Set<string>()
  for (let k = 0; k < DIRS; k++) {
    const a = k * 2 * Math.PI / DIRS, dx = -Math.sin(a), dz = -Math.cos(a)
    for (let r = 1; r <= 4; r++) {
      const x = Math.floor(me.x + dx * r), z = Math.floor(me.z + dz * r)
      // Путь до края: голова и ноги свободны; дальше по лучу — только если под ногами ещё пол.
      const approach = new Vec3(x + .5, me.y, z + .5)
      if (!bodyClear(bot, approach)) break
      const floor = supportAt(bot, approach, .55)
      if (floor && me.y - floor.top <= .55) continue
      const key = x + ',' + z
      if (seen.has(key)) break
      seen.add(key)
      for (let y = fy - 1; y >= bottom; y--) {
        const block = bot.blockAt(new Vec3(x, y, z), false)
        if (!block || HAZARD.test(block.name) || block.name === 'pointed_dripstone') break
        const water = block.name === 'water' || block.name === 'bubble_column'
        if (!water && block.boundingBox !== 'block') continue
        const stand = new Vec3(x + .5, y + 1.5, z + .5)
        const top = water ? y + 1 : supportAt(bot, stand, 1.5)?.top
        if (top === undefined) break
        const at = new Vec3(stand.x, top, stand.z), drop = me.y - top
        if (drop <= .55 || !withinArena(bot, at, p.arena) || !seesPoint(bot, eye, at.offset(0, .015, 0)) || !bodyClear(bot, at, { water })) break
        const dmg = water ? 0 : landingDamage(block, drop, bot.entity.attributes)
        const mlg = bucketReady && dmg > 0 && drop <= bucket.drop && !edges.mlgLandingBad(bot, x, top, z)
        if (dmg && !mlg && hp - dmg < minHpAfter) break
        const away = from ? at.distanceTo(from) : 0
        const score = (mlg ? 0 : dmg) * 1.5 + r * .5 - away
        candidates.push({ score, dmg, at, mlg, water, y })
        break
      }
      break
    }
  }
  for (const c of candidates.sort((a, b) => a.score - b.score)) {
    for (const variant of DROP_VARIANTS) {
      if (ctl.aborted || !bot.entity.onGround || bot.entity.position.distanceTo(me) > .1 || bot.entity.velocity.distanceTo(velocity) > .05 || bot.health < hp) {
        return { ok: false, why: 'исходная позиция изменилась' }
      }
      const plan = c.water
        ? planWaterDrop(bot, { x: Math.floor(c.at.x), z: Math.floor(c.at.z), top: c.y, depth: 1 }, variant)
        : planLedgeDrop(bot, c.at, variant, c.dmg)
      if (plan && (!c.water || plan.states.at(-1)?.isInWater) &&
          plan.states.every((s, i) => withinArena(bot, s.pos, p.arena, i ? plan.states[i - 1].pos : me))) {
        const end = new Vec3(plan.target.x, plan.target.y, plan.target.z)
        if (!seesPoint(bot, eye, end.offset(0, .015, 0))) continue
        const mlg = !!(plan.damage && c.mlg && bot._ndFallGuard?.waterReady?.().ok &&
          !edges.mlgLandingBad(bot, Math.floor(end.x), end.y, Math.floor(end.z)))
        if (plan.damage && !mlg && hp - plan.damage < minHpAfter) continue
        let ok: boolean, why: string | undefined
        if (plan.damage) {
          const technique = mlg ? 'water' : ''
          const guard = edges.guard(bot, { arena: p.arena })
          try {
            ok = await runDrop(bot, ctl, { drop: { plan, hurt: mlg ? 0 : plan.damage, hp, water: false, technique, from: me, velocity } }, guard, p.arena)
          } finally { guard.stop() }
        } else {
          const landed = st => c.water ? st.isInWater && !st.isInLava : st.onGround && Math.abs(st.pos.y - end.y) < .05 &&
            !!supportAt(bot, st.pos, .04) && bodyClear(bot, st.pos)
          const result = await executePlan(bot, ctl, { ...plan, arena: p.arena }, st => st.pos.distanceTo(end) <= .65 && landed(st))
          ok = result.ok; why = result.why
        }
        const actual = bot.entity.position
        return { ok, why: ok ? undefined : why ?? 'посадка не подтверждена', drop: me.y - actual.y, dmg: plan.damage, mlg, at: actual.floored(), hp: bot.health }
      }
      // Следующий физический вариант уступает очередь пакетам и таймауту RPC.
      await new Promise<void>(resolve => setImmediate(resolve))
    }
  }
  return { ok: false, why: 'нет края с дешёвым падением' }
}
