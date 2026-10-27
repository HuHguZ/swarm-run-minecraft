import { performance } from 'node:perf_hooks'
import { Vec3 } from 'vec3'
import * as pick from '../../pick'
import { hold, landing } from '../../cast/bucket'
import { afterPacket } from '../../edges/mlg'
import { isAlly } from '../../combat/ally-safety'

type Point = { x: number; y: number; z: number }

/** One bucket attempt. The caller owns movement and the preceding visible hit cue. */
export async function waterCatch(bot: any, visibleAlly: any, cell: Point, ctl: { aborted: boolean }, enabled = true) {
  const result = { sent: false, waterObserved: false, bucketChanged: false, why: '', cell: { ...cell },
    sentAt: null as number | null, observedAt: null as number | null, aim: null as Point | null,
    detail: null as Record<string, any> | null, actualView: null as Record<string, any> | null }
  if (!cell || ![cell.x, cell.y, cell.z].every(Number.isSafeInteger)) return { ...result, why: 'invalid_cell' }
  const target = new Vec3(cell.x, cell.y, cell.z), ref = target.offset(0, -1, 0), up = new Vec3(0, 1, 0)
  let dead = false, pointed: Vec3 | null = null, stage = 'before_equip'
  const end = () => { dead = true }
  const entityDead = (entity: any) => { if (entity?.id === visibleAlly?.id || entity?.id === bot.entity?.id) dead = true }
  const cancelled = () => !!ctl?.aborted || dead || !bot.entity
  const count = () => bot.inventory.items().filter((item: any) => item.name === 'water_bucket').reduce((n: number, item: any) => n + item.count, 0)
  const xyz = (p: any) => p ? { x: p.x, y: p.y, z: p.z } : null
  const diagnose = (check: string, extra: Record<string, any> = {}) => {
    const own = bot.entity?.position ? { position: xyz(bot.entity.position), velocity: xyz(bot.entity.velocity),
      yaw: bot.entity.yaw, pitch: bot.entity.pitch, onGround: bot.entity.onGround } : null
    const delta = own && pointed ? pointed.minus(pick.eyeOf(bot)) : null
    result.detail = { stage, check, ms: Date.now(), own, actualFacePoint: null,
      expected: delta ? { point: xyz(pointed), yaw: Math.atan2(-delta.x, -delta.z),
        pitch: Math.atan2(delta.y, Math.hypot(delta.x, delta.z)) } : null, ...extra }
  }
  const failure = (why: string) => { if (!result.detail) diagnose(why); return { ...result, why } }
  // Public role/visibility flags precede the visibility ray, and no ally HP is read.
  const guard = (held: boolean, view = false): { why: string; point?: Vec3 } => {
    if (cancelled()) return { why: 'cancelled' }
    if (!visibleAlly || !isAlly(bot, visibleAlly) || visibleAlly._ndVisible === false || visibleAlly.isValid === false ||
      bot.players?.[visibleAlly.username]?.gamemode === 3) return { why: 'unseen_ally' }
    const ally = bot.entities?.[visibleAlly.id]
    if (!ally || ally.username !== visibleAlly.username || !isAlly(bot, ally) || ally._ndVisible === false || ally.isValid === false ||
      !pick.canHit(bot, ally, { range: 32 })) return { why: 'unseen_ally' }
    if (/nether/.test(String(bot.game?.dimension || ''))) return { why: 'water_evaporates' }
    const source = bot.blockAt(target), floor = bot.blockAt(ref)
    if (!source || !floor) return { why: 'unloaded_cell' }
    if (source.name === 'water') return { why: 'water_already' }
    if (!/^(air|cave_air|void_air)$/.test(source.name)) return { why: 'source_occupied' }
    if (floor.name !== 'stone' || floor.boundingBox !== 'block') return { why: 'unsupported_floor' }
    if (held && (bot.heldItem?.name !== 'water_bucket' || count() <= 0)) return { why: 'wrong_bucket' }
    const point = view ? null : pick.faceAim(bot, ref, up, { range: 4.5 })
    if (!view && (!point || !landing(bot, point, 4.5)?.cell.equals(target))) return { why: 'no_visible_face' }
    if (view) {
      // Mouse-quantized look need not equal the ideal angle/point. Only the actual client ray authorizes use.
      const eye = pick.eyeOf(bot)
      const direction = new Vec3(-Math.sin(bot.entity.yaw) * Math.cos(bot.entity.pitch), Math.sin(bot.entity.pitch),
        -Math.cos(bot.entity.yaw) * Math.cos(bot.entity.pitch))
      const viewed = landing(bot, eye.plus(direction.scaled(4.5)), 4.5)
      const hit = pick.blockOnRay(bot, eye, direction, 4.5), hitPoint = hit ? eye.plus(direction.scaled(hit.t)) : null
      if (stage === 'packet') result.actualView = { ms: Date.now(), own: { position: xyz(bot.entity.position), velocity: xyz(bot.entity.velocity),
        onGround: bot.entity.onGround }, yaw: bot.entity.yaw, pitch: bot.entity.pitch, from: xyz(eye), direction: xyz(direction), range: 4.5,
        blockCell: xyz(hit?.pos), blockName: hit?.block?.name, waterCell: xyz(viewed?.cell), hitPoint: xyz(hitPoint),
        hitDistance: hit?.t ?? null, entityClear: false }
      if (!viewed?.cell.equals(target) || !viewed.hit.equals(ref)) {
        diagnose('view_lands_elsewhere', { actualFacePoint: xyz(hitPoint), actualLanding: viewed ? { cell: xyz(viewed.cell), hit: xyz(viewed.hit), face: viewed.face } : null })
        return { why: 'aim_changed' }
      }
      // Check the actual pointed ray too; use_item's block-only ray must not bypass a client entity pick.
      if (!hit || !hit.pos.equals(ref)) { diagnose('no_view_block', { actualFacePoint: xyz(hitPoint) }); return { why: 'aim_changed' } }
      for (const entity of Object.values<any>(bot.entities || {})) {
        if (entity === bot.entity || entity.id === bot.entity.id || !entity.position || entity.isValid === false) continue
        const box = pick.hitboxOf(bot, entity), t = pick.rayBox(eye, direction, box.lo, box.hi, hit.t)
        if (t !== null && t < hit.t - .01) {
          diagnose('entity_blocks_view', { actualFacePoint: xyz(hitPoint), blockerId: entity.id, blockerName: entity.name, entityT: t, blockT: hit.t })
          return { why: 'entity_blocks_view' }
        }
      }
      if (stage === 'packet') result.actualView!.entityClear = true
    }
    return { why: '', point: point ?? undefined }
  }
  bot.on('death', end); bot.on('end', end); bot.on('entityDead', entityDead)
  try {
    let checked = guard(false)
    if (checked.why) return failure(checked.why)
    stage = 'equip'
    if (!await hold(bot, 'water_bucket')) return failure('missing_bucket')
    stage = 'after_equip'
    checked = guard(true)
    if (checked.why) return failure(checked.why)
    pointed = checked.point!; result.aim = { x: pointed.x, y: pointed.y, z: pointed.z }
    stage = 'look'
    await bot.lookAt(pointed, true)
    stage = 'after_look'
    checked = guard(true, true)
    if (checked.why) return failure(checked.why)
    stage = 'movement_tick'
    await bot.waitForTicks(1)
    stage = 'after_tick'
    checked = guard(true, true)
    if (checked.why) return failure(checked.why)
    let before = 0
    await new Promise<void>(resolve => afterPacket(bot, () => {
      try {
        stage = 'packet'
        const current = guard(true, true)
        if (current.why) { if (!result.detail) diagnose(current.why); result.why = current.why; return }
        if (!enabled) { result.why = 'sham'; return }
        before = count(); result.sentAt = Date.now()
        bot.activateItem(); result.sent = true
      } catch (error) { diagnose('use_error', { error: String(error) }); result.why = 'use_error' }
      finally { resolve() }
    }))
    if (!result.sent) return result
    const started = performance.now()
    for (;;) {
      result.bucketChanged ||= count() < before
      if (!result.waterObserved && bot.blockAt(target)?.name === 'water') { result.waterObserved = true; result.observedAt = Date.now() }
      if (cancelled()) { result.why = 'cancelled'; break }
      if (result.waterObserved && result.bucketChanged) { result.why = 'water_observed'; break }
      if (performance.now() - started >= 1000) { result.why = result.waterObserved ? 'bucket_unconfirmed' : 'water_unconfirmed'; break }
      await new Promise(resolve => setTimeout(resolve, Math.min(10, Math.max(0, 1000 - (performance.now() - started)))))
    }
    return result
  } catch (error) { if (!result.detail) diagnose('preparation_error', { error: String(error) }); return { ...result, why: cancelled() ? 'cancelled' : 'preparation_error' } }
  finally { bot.removeListener('death', end); bot.removeListener('end', end); bot.removeListener('entityDead', entityDead) }
}
