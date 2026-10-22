type CombatContext = Record<string, any>

export function createEquipment(ctx: CombatContext) {
const stack = item => item && [item.name, item.type, item.metadata, item.slot, item.count, JSON.stringify(item.components || []), JSON.stringify(item.nbt || null), item.durabilityUsed].join(':')
let failedSelection = null
const uses = new Map<string, string>()
const throws = new Map<string, any>()
const placements = new Map<string, any>()
const cooldowns = new Map<string, number>()
const onCooldown = packet => cooldowns.set(String(packet.cooldownGroup).replace(/^minecraft:/, ''), ctx.gameClock.now() + Math.max(0, packet.cooldownTicks || 0) * 50)
const itemReady = item => !!item && (cooldowns.get(item.componentMap?.get('use_cooldown')?.data?.cooldownGroup?.replace(/^minecraft:/, '') || item.name) || 0) <= (ctx.gameClock?.now() ?? 0)
const owner = () => ctx.session?._reflexState?.active || null
const line = () => {
  const from = ctx.bot.entity.position.toString()
  const to = ctx.entity.position
  let hit = null
  try { const eye = ctx.pick.eyeOf(ctx.bot); const delta = to.offset(0, .9, 0).minus(eye); hit = ctx.pick.blockOnRay(ctx.bot, eye, delta.normalize(), delta.norm()) } catch {}
  return [ctx.entity.id, from, to.toString(), hit?.pos?.toString(), hit?.block?.stateId ?? hit?.block?.name].join('|')
}
const onSpawn = packet => {
  if (Number(packet.objectData) !== ctx.bot.entity?.id) return
  for (const attempt of throws.values()) {
    if (attempt.sent && attempt.id == null && ctx.bot.registry?.entitiesByName?.[attempt.name]?.id === packet.type) {
      attempt.id = packet.entityId
      break
    }
  }
}
const onGone = e => {
  for (const attempt of throws.values()) {
    if (attempt.id === e?.id) attempt.resolved = true
    if (attempt.cloudId === e?.id) attempt.cloudResolved = true
  }
}
ctx.bot._client?.on?.('spawn_entity', onSpawn)
ctx.bot._client?.on?.('set_cooldown', onCooldown)
ctx.bot.on?.('entityGone', onGone)
const closeEquipment = () => {
  ctx.bot._client?.removeListener?.('spawn_entity', onSpawn)
  ctx.bot._client?.removeListener?.('set_cooldown', onCooldown)
  ctx.bot.removeListener?.('entityGone', onGone)
}
const splashDanger = () => {
  for (const attempt of throws.values()) {
    if (!attempt.sent || !/potion/.test(attempt.name)) continue
    const at = attempt.land || attempt.target
    const cloud = attempt.name === 'lingering_potion' && !attempt.cloudResolved && (attempt.cloudId != null ? ctx.bot.entities?.[attempt.cloudId] :
      (Object.values(ctx.bot.entities || {}) as any[]).find(e => e.name === 'area_effect_cloud' && e.position?.distanceTo(new ctx.Vec3(at.x, at.y, at.z)) < 2))
    if (cloud) attempt.cloudId = cloud.id
    const inFlight = !attempt.resolved && (attempt.id != null || (ctx.gameClock?.now() ?? 0) - attempt.started < ((attempt.ticks || 40) + 2) * 50)
    if (!attempt.resolved && attempt.id == null && !inFlight && !cloud && (require('./last-seen') as typeof import('./last-seen')).seesPlayer(ctx.bot, { position: new ctx.Vec3(at.x, at.y, at.z), width: .25, height: .25 })) {
      attempt.sent = false; attempt.why = 'projectile_not_confirmed'
      continue
    }
    if (!attempt.resolved || cloud) return { id: cloud?.id ?? attempt.id, at: cloud?.position || at, radius: 4, pending: attempt.id == null, inFlight }
  }
  return null
}
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
    if (!item || !itemReady(item)) return false
    const wanted = stack(item)
    const same = () => !!ctx.bot.heldItem && (ctx.bot.registry?.itemsByName
      ? (require('../invsync') as typeof import('../invsync')).sameStack(ctx.bot, ctx.bot.heldItem, item) : stack(ctx.bot.heldItem) === stack(item))
    if (same()) { failedSelection = null; return true }
    if (failedSelection?.wanted === wanted && failedSelection.owner === owner() && failedSelection.equip === ctx.bot.equip && !same()) return false
    const before = ctx.heldName()
    try {
      // Зелье — свежим поиском по содержимому (слот предмета из прошлого тика мог уже занять другое зелье).
      if (/potion$/.test(item.name)) {
        const potionOf = (require('./potions') as typeof import('./potions')).potionOf
        const want = potionOf(item)
        item = ctx.bot.inventory.items().find(i => i.name === item.name && potionOf(i) === want) || item
      }
      await ctx.bot.equip(item, 'hand')
      // Зелья одного имени различаются только содержимым (splash_potion «лечение II» и «вред II»): equip по устаревшему
      // слоту брал соседнее — «лечение под ноги» вредом себе, −12 и смерть «using magic» (S7d, репетиция показа z2,
      // «арсенал»). В руке не то зелье — не бросать.
      if (/potion$/.test(item.name)) {
        const potionOf = (require('./potions') as typeof import('./potions')).potionOf
        const held = ctx.bot.heldItem
        if (!held || held.name !== item.name || potionOf(held) !== potionOf(item)) { failedSelection = { wanted, owner: owner(), equip: ctx.bot.equip, why: 'equip_mismatch' }; return false }
      }
      if (!same()) { failedSelection = { wanted, owner: owner(), equip: ctx.bot.equip, why: 'equip_mismatch' }; return false }
      failedSelection = null
      return true
    } catch (error) { failedSelection = { wanted, owner: owner(), equip: ctx.bot.equip, why: error.message }; return false } finally { ctx.switched(before) }
  }

const useAt = async (yaw, pitch, { holdMs = 0, item = ctx.bot.heldItem }: any = {}) => {
    if (!item) return false
    const key = item.name + ':' + (item.componentMap?.get('potion_contents')?.data?.potionId ?? '')
    if (!itemReady(item) || uses.get(key) === stack(item)) return false
    const selected = structuredClone(item)
    ctx.aim = 'point'
    ctx.aimPoint = { yaw, pitch }
    try {
      await ctx.bot.look(yaw, pitch, true).catch(() => {})
      await ctx.sleep(60)
      // Пока ждали прицел, рефлекс/обновление рюкзака могли сменить руку.
      if (!(require('../invsync') as typeof import('../invsync')).sameStack(ctx.bot, ctx.bot.heldItem, selected)) return false
      ctx.bot.activateItem()
      uses.set(key, stack(selected))
      if (holdMs) {
        await ctx.sleep(holdMs)
        ctx.bot.deactivateItem()
      }
      await ctx.sleep(60)
      return true
    } finally { ctx.aim = 'target' }
  }

const foeGrounded = () => { try { return ctx.edges.support(ctx.bot, ctx.entity.position, new Map()).drop <= 0.05 } catch { return true } }

const leadFn = (frac) => (t) => {
    const p = ctx.track.at(Math.min(30, t))
    const y = !ctx.foeGrounded() ? p.y : ctx.entity.position.y
    return new ctx.Vec3(p.x, y + (ctx.entity.height || 1.8) * frac, p.z)
  }

// frac — куда в нём целить по высоте (0 — ноги: зелье до середины тела долетает лишь на ~4.6 бл., до ног — на ~5.5;
// облако с земли у его ног бьёт так же — толпа, turn-crowd).
// lead — своё упреждение fn(тики) → точка (толпа: ход по своим наблюдениям; свежий трекер цели после смены цели
// упреждает мимо — L5c/L5k: 70 из 80 отказов «не долетит» при «долетит» по кадру толпы).
const reachable = (item, frac = 0.5, lead = null) => {
    const k = ctx.throwMod.kindOf(item.name)
    if (!k) return false
    const from = ctx.bot.entity.position.offset(0, ctx.EYE - 0.1, 0)
    return !!ctx.throwMod.aim(from, lead || ctx.leadFn(frac), k)
  }

// clear — зазор рамок до облака (4 — облако не задевает меня; толпа для вреда II при хп ≥ 10 — 3.4: край облака по мне).
const throwAt = async (item, what, { minLand = 4.5, frac = 0.5, lead = null, clear = 4 }: any = {}) => {
    const previousClearance = throws.get(item.name + ':' + (item.componentMap?.get('potion_contents')?.data?.potionId ?? '') + ':' + ctx.entity.id)?.refusal === 'splash_clearance'
    if (previousClearance && /potion/.test(item.name)) {
      const mine = ctx.pick.hitboxOf(ctx.bot, ctx.bot.entity), target = ctx.pick.hitboxOf(ctx.bot, ctx.entity)
      const gap = Math.hypot(...['x', 'y', 'z'].map(a => Math.max(0, mine.lo[a] - target.hi[a] - .425, target.lo[a] - mine.hi[a] - .425)))
      if (gap < clear) { ctx.throwWhy = 'прошлый отказ: облако легло бы на меня'; return false }
    }
    const key = item.name + ':' + (item.componentMap?.get('potion_contents')?.data?.potionId ?? '') + ':' + ctx.entity.id
    const inputs = line() + '|' + stack(item) + '|' + minLand
    const previous = throws.get(key)
    // Почему не бросил — в ctx.throwWhy (толпа пишет в трассу).
    if (!itemReady(item)) { ctx.throwWhy = 'перезарядка предмета'; return false }
    if (previous?.sent && !previous.resolved) { ctx.throwWhy = 'прошлое такое же ещё летит'; return false }
    if (previous?.inputs === inputs && !previous.sent && previous.owner === owner()) { ctx.throwWhy = 'тот же отказ: ' + (previous.refusal || previous.why); return false }
    if (!ctx.reachable(item, frac, lead)) { ctx.throwWhy = 'не долетит'; return false }
    // Вред — по окнам неуязвимости (strike-order.harmWait): облако ложится после окна от последнего попадания по нему.
    if (ctx.targetHurtAt && /potion/.test(item.name) && /harming$/.test((require('./potions') as typeof import('./potions')).potionOf(item) || '')) {
      const flight = ctx.throwMod.aim?.(ctx.bot.entity.position.offset(0, ctx.EYE - 0.1, 0), lead || ctx.leadFn(frac), ctx.throwMod.kindOf?.(item.name))?.ticks ?? 0
      const wait = (require('./strike-order') as typeof import('./strike-order')).harmWait(ctx.gameClock?.now() ?? 0, ctx.targetHurtAt, flight)
      if (wait > 0) { ctx.throwWhy = `окно неуязвимости: вред лёг бы в него (ещё ${wait} мс)`; return false }
    }
    if (!(await ctx.holdItem(item))) { ctx.throwWhy = 'не взял в руку'; return false }
    ctx.aim = 'free'
    const attempt: any = { inputs, owner: owner(), why: 'awaiting_projectile', sent: true, id: null,
      name: item.name, target: ctx.entity.position.clone(), started: ctx.gameClock?.now() ?? 0 }
    throws.set(key, attempt)
    let r = null
    try {
      r = await ctx.throwMod.throwAt(ctx.bot, lead || ctx.leadFn(frac), {
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
          if (/potion/.test(item.name) && ctx.entity && ctx.entity.position && gap(ctx.pick.hitboxOf(ctx.bot, ctx.entity), 0.3 + 0.125) < clear) { attempt.refusal = 'splash_clearance'; return false }
          if (/potion/.test(item.name) && at && gap({ lo: at, hi: at }, 0.125) < clear) { attempt.refusal = 'landing_clearance'; return false }
          if (!at) return true
          if (at.y < me0.y - 2.3) return true
          return Math.hypot(at.x - me0.x, at.z - me0.z) >= minLand
        }
      })
    } catch (error) { r = { thrown: false, why: error.message } }
    ctx.aim = 'target'
    attempt.sent = !!r?.thrown
    attempt.why = r?.thrown ? 'projectile_in_flight' : r?.why || 'trajectory_rejected'
    attempt.land = r?.land
    attempt.ticks = r?.ticks
    if (r && r.thrown) { ctx.used(what); return true }
    ctx.throwWhy = attempt.refusal || attempt.why
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
    const key = item.name + ':' + cell.toString()
    const inputs = [ctx.bot.entity.position.floored(), below.stateId ?? below.name, here.stateId ?? here.name, faceP, stack(item)].join('|')
    if (placements.get(key)?.inputs === inputs && placements.get(key)?.owner === owner()) return false
    if (!(await ctx.holdItem(item))) return false
    ctx.aim = 'free'
    try {
      await ctx.bot.lookAt(faceP, true)
      await ctx.withTimeout(ctx.bot.placeBlock(below, new ctx.Vec3(0, 1, 0)), 600)
    } catch {}
    ctx.aim = 'target'
    const placed = ctx.blockName(ctx.bot, cell)
    if (placed === item.name) { placements.delete(key); ctx.used(what); return true }
    placements.set(key, { inputs, owner: owner(), why: 'block_not_confirmed' })
    return false
  }
const placeUnder = (item, what) => placeAt(item, ctx.entity.position, what)
return { heldName, switched, pickWeaponFor, holdWeapon, holdItem, useAt, foeGrounded, leadFn, reachable, throwAt, placeUnder, placeAt, itemReady, splashDanger, closeEquipment }
}
