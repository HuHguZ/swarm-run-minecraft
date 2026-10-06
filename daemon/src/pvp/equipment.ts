type CombatContext = Record<string, any>

export function createEquipment(ctx: CombatContext) {
const heldName = () => (ctx.bot.heldItem ? ctx.bot.heldItem.name : null)

const switched = (before) => {
    if (ctx.heldName() !== before) ctx.nextReady = Math.max(ctx.nextReady, ctx.gameClock.now() + ctx.cooldownMs(ctx.bot.heldItem))
  }

const pickWeaponFor = (e) => {
    ctx.chosenWeapon = null
    if (!e || ctx.isPlayer(e)) return
    try {
      const w = ctx.assess.weaponFor(ctx.bot, e)
      if (w && w.item) ctx.chosenWeapon = w.item.name
    } catch {}
  }

const holdWeapon = async () => {
    if (ctx.bot.targetDigBlock) return
    const before = ctx.heldName()
    ctx.weapon = (ctx.chosenWeapon && ctx.findItem(ctx.bot, i => i.name === ctx.chosenWeapon)) || ctx.bestWeapon(ctx.bot)
    const held = ctx.bot.heldItem
    if (ctx.weapon && (!held || held.name !== ctx.weapon.name)) {
      try { await ctx.bot.equip(ctx.weapon, 'hand') } catch {}
    } else if (!ctx.weapon && held && !/_sword$|_axe$/.test(held.name)) {
      try { await ctx.bot.unequip('hand') } catch {}
    }
    ctx.switched(before)
  }

const holdItem = async (item) => {
    const before = ctx.heldName()
    try { await ctx.bot.equip(item, 'hand'); return true } catch { return false } finally { ctx.switched(before) }
  }

const useAt = async (yaw, pitch, { holdMs = 0 }: any = {}) => {
    ctx.aim = 'point'
    ctx.aimPoint = { yaw, pitch }
    await ctx.bot.look(yaw, pitch, true).catch(() => {})
    await ctx.sleep(60)
    ctx.bot.activateItem()
    if (holdMs) {
      await ctx.sleep(holdMs)
      ctx.bot.deactivateItem()
    }
    await ctx.sleep(60)
    ctx.aim = 'target'
  }

const foeGrounded = () => { try { return ctx.edges.support(ctx.bot, ctx.entity.position, new Map()).drop <= 0.05 } catch { return true } }

const leadFn = (frac) => (t) => {
    const p = ctx.track.at(Math.min(30, t))
    const y = !ctx.foeGrounded() ? p.y : ctx.entity.position.y
    return new ctx.Vec3(p.x, y + (ctx.entity.height || 1.8) * frac, p.z)
  }

const reachable = (item) => {
    const k = ctx.throwMod.kindOf(item.name)
    if (!k) return false
    const from = ctx.bot.entity.position.offset(0, ctx.EYE - 0.1, 0)
    return !!ctx.throwMod.aim(from, ctx.leadFn(0.5), k)
  }

const throwAt = async (item, what, { minLand = 4.5 }: any = {}) => {
    if (!ctx.reachable(item)) return false
    if (!(await ctx.holdItem(item))) return false
    ctx.aim = 'free'
    let r = null
    try {
      r = await ctx.throwMod.throwAt(ctx.bot, ctx.leadFn(0.5), {
        item: ctx.bot.heldItem,
        onAim: (res) => {
          const at = res.land && res.land.at
          if (!at) return true
          const me0 = ctx.bot.entity.position
          if (at.y < me0.y - 2.3) return true
          return Math.hypot(at.x - me0.x, at.z - me0.z) >= minLand
        }
      })
    } catch {}
    ctx.aim = 'target'
    if (r && r.thrown) { ctx.used(what); return true }
    await ctx.holdWeapon()
    return false
  }

const placeAt = async (item, point, what, ctl = ctx.ctl) => {
    if (ctl.aborted) return false
    const cell = point.floored()
    const below = ctx.bot.blockAt(cell.offset(0, -1, 0))
    const here = ctx.bot.blockAt(cell)
    if (!below || below.boundingBox !== 'block' || !here || here.boundingBox !== 'empty' || here.name !== 'air') return false
    const faceP = ctx.pick.faceAim(ctx.bot, below.position, new ctx.Vec3(0, 1, 0))
    if (!faceP) return false
    if (!(await ctx.holdItem(item))) return false
    ctx.aim = 'free'
    try {
      await ctx.bot.lookAt(faceP, true)
      await ctx.withTimeout(ctx.bot.placeBlock(below, new ctx.Vec3(0, 1, 0)), 600)
    } catch {}
    ctx.aim = 'target'
    const placed = ctx.blockName(ctx.bot, cell)
    if (placed === item.name) { ctx.used(what); return true }
    return false
  }
const placeUnder = (item, what) => placeAt(item, ctx.entity.position, what)
return { heldName, switched, pickWeaponFor, holdWeapon, holdItem, useAt, foeGrounded, leadFn, reachable, throwAt, placeUnder, placeAt }
}
