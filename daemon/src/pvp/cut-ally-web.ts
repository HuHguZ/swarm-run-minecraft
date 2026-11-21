import { Vec3 } from 'vec3'
import * as pick from '../pick'
import { webCells } from '../hazards'
import { equipFastest } from '../tools'
import { watchDigReceipt } from '../environments/dig-receipt'
import { seesPlayer, SIGHT_TRANSPARENT } from './last-seen'

const { BlockFace }: typeof import('prismarine-world').iterators = require('prismarine-world').iterators
const unknown = { name: 'unknown', boundingBox: 'block', shapes: [[0, 0, 0, 1, 1, 1]] }
const cutter = item => !!item && /_sword$|^shears$/.test(item.name)

// A strand is transparent to sight, but the crosshair still picks its outline. To report freedom,
// see a point of the ally's body inside every cell it overlaps, including feet behind a parapet.
function inspect(bot, ally) {
  const box = pick.hitboxOf(bot, ally), eye = pick.eyeOf(bot)
  let complete = true
  const webs = webCells(bot, ally, p => {
    const mid = axis => (Math.max(p[axis], box.lo[axis]) + Math.min(p[axis] + 1, box.hi[axis])) / 2
    const delta = new Vec3(mid('x'), mid('y'), mid('z')).minus(eye), len = delta.norm()
    const blocked = len > 128 || len > 1e-6 && pick.blockOnRay(bot, eye, delta.scaled(1 / len), len, SIGHT_TRANSPARENT)
    const b = !blocked && bot.blockAt(p, false)
    if (!b || b === unknown) complete = false
    return b
  })
  return { webs, complete }
}

export async function cutAllyWeb(bot, ctl, name: string) {
  let cut = 0
  const fail = why => ({ ok: false, cut, why })
  const ally = bot.players?.[name]?.entity
  const present = () => ally?.position && bot.players?.[name]?.entity === ally && ally.isValid !== false &&
    bot.players[name].gamemode !== 3 && ally._ndVisible !== false && (!(ally.metadata?.[0] & 0x20) || seesPlayer(bot, ally))
  if (!present()) return fail('не вижу его')
  const view = Object.create(bot)
  view.blockAt = p => bot.blockAt(p, false) || unknown
  bot.pathfinder?.setGoal(null); bot.clearControlStates()
  while (!ctl.aborted && present()) {
    const { webs, complete } = inspect(view, ally)
    if (!webs.length) return complete ? { ok: true, cut, ...(cut === 0 && { alreadyFree: true }) } : fail('не вижу его целиком')
    if (!bot.inventory.items().some(cutter)) return fail('нечем резать')
    const pickWeb = at => pick.blockAim(view, at, { range: 4.5, seeThrough: null })
    const at = webs.find(pickWeb)
    if (!at) return fail('не достаю')
    const block = bot.blockAt(at)
    try { await equipFastest(bot, block) } catch { return fail('нечем резать') }
    if (ctl.aborted || !present()) break
    if (!cutter(bot.heldItem)) return fail('нечем резать')
    if (!inspect(view, ally).webs.some(p => p.equals(at))) continue
    const aim = pickWeb(at)
    if (!aim) return fail('не достаю')
    const eye = pick.eyeOf(bot)
    await bot.lookAt(aim, true)
    const { yaw, pitch } = bot.entity
    const pickedFace = () => {
      if (ctl.aborted || !present() || !cutter(bot.heldItem) || !eye.equals(pick.eyeOf(bot)) || yaw !== bot.entity.yaw || pitch !== bot.entity.pitch ||
          !inspect(view, ally).webs.some(p => p.equals(at))) return null
      const current = pickWeb(at)
      if (!current || !current.equals(aim)) return null
      if (aim.x === at.x) return BlockFace.WEST
      if (aim.x === at.x + 1) return BlockFace.EAST
      if (aim.y === at.y) return BlockFace.BOTTOM
      if (aim.y === at.y + 1) return BlockFace.TOP
      return aim.z === at.z ? BlockFace.NORTH : BlockFace.SOUTH
    }
    if (pickedFace() === null) return fail(ctl.aborted ? 'interrupted' : 'потерял прицел')
    const receipt = watchDigReceipt(bot, at, () => ctl.aborted)
    const stop = () => { if (bot.targetDigBlock?.position.equals(at)) bot.stopDigging() }
    const check = () => { if (bot.targetDigBlock?.position.equals(at) && pickedFace() === null) stop() }
    bot.on('physicsTick', check); ctl.onAbort.push(stop)
    try {
      await bot.dig(block, 'ignore', { ndPickedFace: pickedFace }, ctl)
      if (await receipt.settle() !== 'confirmed') return fail(ctl.aborted ? 'interrupted' : 'сервер не подтвердил срез')
      cut++
    } catch (e) { return fail(ctl.aborted ? 'interrupted' : String(e.message || e)) }
    finally {
      bot.removeListener('physicsTick', check)
      const i = ctl.onAbort.indexOf(stop); if (i >= 0) ctl.onAbort.splice(i, 1)
      receipt.close()
    }
  }
  return fail(ctl.aborted ? 'interrupted' : 'не вижу его')
}
