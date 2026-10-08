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
    try {
      // Зелье — свежим поиском по содержимому (слот предмета из прошлого тика мог уже занять другое зелье).
      if (/potion$/.test(item.name)) {
        const potionOf = require('../pvp').potionOf
        const want = potionOf(item)
        item = ctx.bot.inventory.items().find(i => i.name === item.name && potionOf(i) === want) || item
      }
      await ctx.bot.equip(item, 'hand')
      // Зелья одного имени различаются только содержимым (splash_potion «лечение II» и «вред II»): equip по устаревшему
      // слоту брал соседнее — «лечение под ноги» вредом себе, −12 и смерть «using magic» (S7d, репетиция показа z2,
      // «арсенал»). В руке не то зелье — не бросать.
      if (/potion$/.test(item.name)) {
        const potionOf = require('../pvp').potionOf
        const held = ctx.bot.heldItem
        if (!held || held.name !== item.name || potionOf(held) !== potionOf(item)) return false
      }
      return true
    } catch { return false } finally { ctx.switched(before) }
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
          const me0 = ctx.bot.entity.position
          // Брошенное В НЕГО разбивается о его тело раньше земли (прогноз landing видит только блоки). jar 1.21.11
          // (ThrownSplashPotion.onHitAsPotion, сверка Codex): задевает всех, чья рамка в 4 бл. от рамки зелья (0.25),
          // бросившего тоже; сила 1 − d/4. S7d: колизей слота 28, «арсенал» — дважды «killed by … using magic» своим
          // «вредом II» с 2.5–4.3 бл. Разрыв у его рамки (с запасом попадания 0.3) или в точке падения ближе 4 бл. к
          // моей рамке — не бросаю.
          const mine = ctx.pick.hitboxOf(ctx.bot, ctx.bot.entity)
          const gap = (box, pad) => Math.hypot(...['x', 'y', 'z'].map(a => Math.max(0, mine.lo[a] - box.hi[a] - pad, box.lo[a] - mine.hi[a] - pad)))
          if (/potion/.test(item.name) && ctx.entity && ctx.entity.position && gap(ctx.pick.hitboxOf(ctx.bot, ctx.entity), 0.3 + 0.125) < 4) return false
          if (/potion/.test(item.name) && at && gap({ lo: at, hi: at }, 0.125) < 4) return false
          if (!at) return true
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
