import { bodyClear, supportAt } from '../navigation/geometry'
import { ledgeOptions, planLedgeDrop } from '../navigation/descent'

import * as damageModel from './damage-model'
import * as read from '../read'
type CombatContext = Record<string, any>

export function createCover(ctx: CombatContext) {
  return { ...createBuildGuards(ctx), ...createWalls(ctx), ...createPerch(ctx), ...createFortSiting(ctx), ...createFortOut(ctx) }
}

// Стройка под ударами: сторож, прерывание, учёт построек.
function createBuildGuards (ctx: CombatContext) {
const buildGuard = () => {
    let n = 0
    let last = ctx.tt.myHurtAt
    const g: any = () => {
      if (g.why) return true
      if (ctx.tt.myHurtAt !== last) {
        last = ctx.tt.myHurtAt
        let far = false
        try { far = ctx.entity.isValid && ctx.reachFrom(ctx.entity.position.offset(0, ctx.EYE, 0), ctx.bot.entity) > ctx.tempo.PLAYER_REACH + 0.5 } catch {}
        if (!far || (ctx.bot.health ?? 20) <= 8) n++
      }
      const fn = ctx.blockName(ctx.bot, ctx.bot.entity.position.floored())
      if (/^(lava|fire|soul_fire)$/.test(fn || '')) { g.why = `стою в ${fn}`; return true }
      if (ctx.onFire(ctx.bot) && !ctx.hasEffect(ctx.bot, 'fire_resistance') && (ctx.bot.health ?? 20) <= 8) { g.why = 'горю'; return true }
      if (ctx.FIX && ctx.maceNow()) { g.why = 'булава сверху'; return true }
      if (ctx.FIX && ctx.prof.player && (n >= 2 || (n >= 1 && (ctx.bot.health ?? 20) <= 8))) { g.why = 'бьют'; return true }
      return false
    }
    return g
  }

const guardCtl = (g) => ({ get aborted () { return ctx.ctl.aborted || g() }, onAbort: ctx.ctl.onAbort, abort: () => ctx.ctl.abort() })

const buildDone = (g, what) => {
    if (!g.why) return false
    ctx.st.build.aborted++
    if (g.why === 'булава сверху') ctx.maceAbort(what)
    else ctx.used(g.why === 'бьют' ? `бросил ${what}: бьют — дерусь` : `бросил ${what}: ${g.why}`)
    return true
  }

const buildHot = (ms) => { try { return ctx.prof.player && ctx.tt.eta(ctx.entity) < ms + ctx.style.reactMs } catch { return false } }

const noteBuild = (kind, ms) => {
    const hot = ctx.buildHot(ms)
    ctx.st.build[kind]++
    if (hot) ctx.st.build[kind + 'Hot']++
    return hot
  }
return { buildGuard, guardCtl, buildDone, buildHot, noteBuild }
}

// Стенка между нами: колонка, 3×2 от лучника, укрытие перед питьём.
function createWalls (ctx: CombatContext) {
const wallToward = async (pos, what) => {
    if (!ctx.pickFiller(ctx.bot)) return 0
    const me0 = ctx.bot.entity.position
    const dx = pos.x - me0.x
    const dz = pos.z - me0.z
    const step = Math.abs(dx) > Math.abs(dz) ? new ctx.Vec3(Math.sign(dx), 0, 0) : new ctx.Vec3(0, 0, Math.sign(dz) || 1)
    const base = me0.floored().plus(step)
    let placed = 0
    ctx.aim = 'free'
    for (const c of [base, base.offset(0, 1, 0)]) {
      if (ctx.FIX && ctx.maceNow()) { ctx.maceAbort('стенку'); break }
      try {
        const r = await ctx.placeBlockAt(ctx.bot, c, { timeoutMs: 700 })
        if (r.ok && !r.already) placed++
      } catch {}
    }
    ctx.aim = 'target'
    if (placed) ctx.used(what)
    return placed
  }

const coverFrom = async (pos, { wide = false, what = 'укрытие' }: any = {}) => {
    const filler = ctx.pickFiller(ctx.bot)
    if (!filler) return 0
    const have = ctx.countOf(ctx.bot, filler.name)
    const me0 = ctx.bot.entity.position
    const dx0 = pos.x - me0.x
    const dz0 = pos.z - me0.z
    const n = Math.hypot(dx0, dz0) || 1
    const mine = me0.floored()
    const cells = []
    for (const a of (wide && have >= 6 ? [0, -Math.PI / 4, Math.PI / 4] : [0])) {
      const c = Math.cos(a); const sn = Math.sin(a)
      const ux = (dx0 * c - dz0 * sn) / n
      const uz = (dx0 * sn + dz0 * c) / n
      const cell = new ctx.Vec3(Math.floor(me0.x + ux * 1.3), mine.y, Math.floor(me0.z + uz * 1.3))
      if (cell.equals(mine) || cells.some(q => q.equals(cell))) continue
      cells.push(cell)
    }
    let placed = 0
    ctx.aim = 'free'
    let maceStop = false
    for (const cell of cells) {
      if (maceStop) break
      for (const c of [cell, cell.offset(0, 1, 0)]) {
        if (ctx.FIX && ctx.maceNow()) { maceStop = true; ctx.maceAbort('стенку'); break }
        try {
          const r = await ctx.placeBlockAt(ctx.bot, c, { timeoutMs: 700 })
          if (r.ok && !r.already) placed++
        } catch {}
      }
    }
    ctx.aim = 'target'
    if (placed) { ctx.used(what); ctx.st.blocks = (ctx.st.blocks || 0) + placed }
    return placed
  }

const coverForDrink = async () => {
    try {
      if (!ctx.prof.player || ctx.fort || ctx.perch || !ctx.entity.isValid || !ctx.pickFiller(ctx.bot) || !ctx.ready('drinkCover')) return 0
      const dd = ctx.entity.position.distanceTo(ctx.bot.entity.position)
      if (dd > 24 || !ctx.raySees(ctx.bot, ctx.entity.position.offset(0, ctx.EYE, 0), ctx.bot.entity.position.offset(0, 1.2, 0))) return 0
      ctx.rest('drinkCover', 2500)
      const hisMain = ctx.entity.equipment && ctx.entity.equipment[0] ? ctx.entity.equipment[0].name : ''
      const archerNow = /^(bow|crossbow|trident)$/.test(hisMain)
      if (ctx.tempo.ON && !ctx.tt.safe(ctx.tempo.consumeMs('potion') + (archerNow ? ctx.COVER_WIDE_MS : ctx.COVER_MS)).ok) return 0
      return await ctx.coverFrom(ctx.entity.position, { wide: archerNow, what: archerNow ? 'стенка 3×2 перед глотком (он с луком)' : 'колонна перед глотком' })
    } catch { return 0 }
  }
return { wallToward, coverFrom, coverForDrink }
}

// Столб: высота, потолок, подъём и спуск со столба.
function createPerch (ctx: CombatContext) {
const rememberBlock = b => b && ({ ...b, position: b.position.clone(), shapes: b.shapes?.map(shape => [...shape]) })

const perchHeight = () => {
    const need = ctx.entity.position.y + ctx.EYE + 1.25 + 3.0 + 0.1 - ctx.bot.entity.position.y
    return Math.max(3, Math.ceil(need))
  }

const headroom = (n) => {
    const f = ctx.bot.entity.position.floored()
    for (let i = 2; i <= n + 2; i++) {
      const b = ctx.bot.blockAt(f.offset(0, i, 0))
      if (!b || b.boundingBox !== 'empty') return false
    }
    return true
  }

const pillarOut = async () => {
    const h = ctx.perchHeight()
    const filler = ctx.pickFiller(ctx.bot)
    if (h > ctx.PERCH_MAX || !filler || ctx.countOf(ctx.bot, filler.name) < h || !ctx.headroom(h + 1)) return false
    if (ctx.FIX && ctx.buildHot(h * ctx.PILLAR_MS)) { ctx.st.build.refused++; ctx.used('столб: не строю — он достанет за стройку'); return false }
    ctx.noteBuild('pillar', h * ctx.PILLAR_MS)
    const gP = ctx.buildGuard()
    const before = ctx.heldName()
    const start = ctx.bot.entity.position.clone()
    const y0 = start.y
    const base = rememberBlock(ctx.bot.blockAt(start.floored().offset(0, -1, 0)))
    const placed = new Map<string, any>()
    let placing = null
    const sawPlaced = () => {
      if (!placing) return
      const b = ctx.bot.blockAt(placing)
      if (b?.name === filler.name && ctx.pick.faceAim(ctx.bot, placing, new ctx.Vec3(0, 1, 0))) {
        placed.set(placing.toString(), { pos: placing.clone(), stateId: b.stateId, block: rememberBlock(b) })
      }
    }
    ctx.pathTo(false); ctx.pathing = false
    ctx.clear()
    ctx.aim = 'free'
    let built = null
    try { built = await ctx.towerUp(ctx.bot, ctx.guardCtl(gP), h, { sneak: false, fast: true, beforeStep: async () => {
      sawPlaced()
      const result = await ctx.towerShield()
      placing = ctx.bot.entity.position.floored()
      return result
    } }) } catch {}
    sawPlaced()
    ctx.aim = 'target'
    ctx.switched(before)
    await ctx.holdWeapon()
    if (ctx.buildDone(gP, 'столб')) return false
    const top = ctx.bot.entity.position.y
    if (top - y0 < 3) return false
    // Only a confirmed straight column belongs to this climb. A knockback or
    // failed placement must not turn pre-existing blocks into our supports.
    let own = []
    const height = Math.round(top - y0)
    if (built?.placed === height && ctx.bot.entity.position.floored().offset(0, -height, 0).equals(start.floored())) {
      own = Array.from({ length: height }, (_, i) => placed.get(start.floored().offset(0, i, 0).toString()))
      if (own.some(b => !b)) own = []
    }
    ctx.perch = { since: ctx.gameClock.now(), y0, top, h: height, own,
      base: base && { pos: base.position.clone(), stateId: base.stateId, block: rememberBlock(base) } }
    ctx.used(`ушёл на столб ${ctx.perch.h} бл. (спуск −${Math.max(0, ctx.perch.h - 3)} хп)`)
    ctx.st.blocks = (ctx.st.blocks || 0) + ctx.perch.h
    return true
  }

const dropFromPerch = async () => {
    const bot = ctx.bot; const perch = ctx.perch
    if (!perch || ctx.ctl.aborted || !bot.entity.onGround) return { ok: false, acted: false }
    const me0 = bot.entity.position.clone()
    const hp = (bot.health ?? 0) + (read.absorptionOf(bot, bot.entity) || 0)
    const effect = bot.registry?.effectsByName?.resistance || bot.registry?.effectsByName?.Resistance
    const def = damageModel.defenseOf([5, 6, 7, 8].map(slot => bot.inventory.slots[slot]).filter(Boolean).map(item => ({ name: item.name,
      ench: { protection: read.enchLevel(bot, item, 'protection'), feather_falling: read.enchLevel(bot, item, 'feather_falling') } })),
    { resistance: (effect && bot.entity.effects?.[effect.id]?.amplifier) ?? -1 })
    const eta = ctx.tt?.eta(ctx.entity) ?? Infinity
    // Explicit price: fraction of remaining HP lost plus exposure relative to
    // the observed time to his next hit. No minimum-HP gate for leaving a perch.
    const price = (damage, ms, exposedEta = eta) => damage / (hp - damage) + ms / Math.max(ctx.TICK_MS, exposedEta)
    const waterGuard = bot._ndFallGuard
    const bucket = ctx.findItem(bot, item => item.name === 'water_bucket')
    const waterReady = bucket && waterGuard?.waterReady?.()
    const canWater = hp > 0 && waterGuard?.planWater && (waterReady?.ok || waterReady?.toBar || waterReady?.retryMs > 0)
    const options: any[] = []
    const pos = me0.floored().offset(0, -1, 0)
    const own = perch.own?.find(b => b.pos.equals(pos))
    const below = [...(perch.own || []), perch.base].find(b => b?.pos.equals(pos.offset(0, -1, 0)))
    const block = bot.blockAt(pos)
    // Beneath our feet we know what we built, not its hidden packet updates.
    // A newly exposed support can refresh that memory; an unseen change cannot
    // tell us that somebody secretly removed the bottom of the column.
    if (below && ctx.pick.blockSeen(bot, below.pos)) below.block = rememberBlock(bot.blockAt(below.pos))
    const point = ctx.pick.faceAim(bot, pos, new ctx.Vec3(0, 1, 0))
    if (point && own) own.block = rememberBlock(block)
    const remembered = [...(perch.own || []), perch.base].filter(Boolean)
    const observed = Object.create(bot)
    observed.blockAt = p => remembered.find(b => b.pos.equals(p.floored()))?.block || bot.blockAt(p)
    const without = { blockAt: p => p.floored().equals(pos) ? { name: 'air', boundingBox: 'empty', shapes: [], position: pos }
      : observed.blockAt(p), physics: bot.physics, game: bot.game }
    const down = me0.offset(0, -1, 0)
    if (hp > 0 && point && own && below && block?.stateId === own.stateId &&
      bodyClear(without, down) && supportAt(without, down, .04) && Math.hypot(bot.entity.velocity.x, bot.entity.velocity.z) < .02) {
      const tool = ctx.tools.bestFor(bot, block)
      if (Number.isFinite(tool.ms)) options.push({ kind: 'dig', block, point, tool: tool.item, ms: tool.ms, damage: 0, cost: price(0, tool.ms * perch.h) })
    }
    for (const target of ledgeOptions(observed, { ...ctx.entity.position, y: perch.y0 }, { radius: 4, maxFallDamage: ctx.PERCH_MAX }).slice(0, 8)) {
      const floor = supportAt(observed, target, .04)
      if (!floor || !ctx.pick.blockSeen(bot, floor.block.position)) continue
      const plan = planLedgeDrop(observed, target, { sprint: false, jump: false, coast: 6 }, Infinity)
      if (!plan) continue
      const damage = damageModel.afterDefense(plan.damage, 'fall', def)
      const ms = plan.ticks * ctx.TICK_MS
      if (damage < hp) options.push({ kind: 'drop', plan, damage, ms, cost: price(damage, ms) })
      if (canWater && damage > 0) {
        const gap = Math.max(0, Math.hypot(target.x - ctx.entity.position.x, target.z - ctx.entity.position.z) - ctx.tempo.PLAYER_REACH)
        const landingEta = Math.min(eta, gap / ctx.tempo.SPRINT_BPT * ctx.TICK_MS)
        const waterMs = ms + 300 + (waterReady.retryMs || (waterReady.toBar ? 300 : 0))
        // A hit can spoil the clutch: price the dry fallback by exposure, rather
        // than treating a bucket as immunity or banning every risky landing.
        // shortcut: exposure is a cost, not a failure probability; fit it from timed hit receipts when available.
        const risk = damage / hp * ms / Math.max(ctx.TICK_MS, landingEta)
        options.push({ kind: 'water', plan, damage: 0, failureDamage: damage, ms: waterMs, cost: price(0, waterMs, landingEta) + risk })
      }
    }
    options.sort((a, b) => a.cost - b.cost || a.ms - b.ms)
    const choice = options[0]
    if (!choice) return { ok: false, acted: false }
    ctx.pathTo(false); ctx.pathing = false; ctx.clear(); ctx.aim = 'free'
    if (choice.kind === 'dig') {
      const stop = () => { try { bot.stopDigging() } catch {} }
      ctx.ctl.onAbort.push(stop)
      let acted = false
      try {
        if (choice.tool && bot.heldItem !== choice.tool) await bot.equip(choice.tool, 'hand')
        await bot.lookAt(choice.point, true)
        if (ctx.ctl.aborted || !ctx.pick.faceAim(bot, pos, new ctx.Vec3(0, 1, 0))) return { ok: false, acted }
        acted = true
        const previousTag = bot._ndBlockTag
        let digging
        try {
          bot._ndBlockTag = { what: 'спуск по своей опоре', intent: 'perch-descent', cell: pos, at: ctx.gameClock.wall.now() }
          digging = bot.dig(choice.block, true)
        } finally { bot._ndBlockTag = previousTag }
        await ctx.withTimeout(digging, choice.ms + 1500)
        const t0 = ctx.gameClock.now()
        while (!ctx.ctl.aborted && ctx.gameClock.now() - t0 < 1000 && !(bot.entity.onGround && bot.entity.position.y < me0.y - .6)) await ctx.sleep(ctx.TICK_MS)
        if (!bot.entity.onGround || Math.abs(bot.entity.position.y - down.y) > .05 || ctx.ctl.aborted) return { ok: false, acted }
        perch.own = perch.own.filter(b => !b.pos.equals(pos))
        perch.top = bot.entity.position.y; perch.h = Math.round(perch.top - perch.y0)
        if (perch.top <= perch.y0 + .05) ctx.perch = null
        ctx.used(`спуск: разобрал свою опору, ${Math.round(choice.ms)} мс, без урона`)
        return { ok: true, acted, kind: 'dig', damage: 0, ms: choice.ms }
      } catch { return { ok: false, acted } }
      finally {
        stop()
        const index = ctx.ctl.onAbort.indexOf(stop)
        if (index >= 0) ctx.ctl.onAbort.splice(index, 1)
        ctx.clear(); ctx.aim = 'target'; await ctx.holdWeapon()
      }
    }
    const smashDrop = choice.kind !== 'water' && ctx.prof.player && ctx.mace.fallSmashReady(ctx.bot, ctx.entity)
    let releaseWater = null
    const pickedBefore = waterGuard?.picked || 0
    const firedBefore = waterGuard?.fired || 0
    try {
    if (choice.kind === 'water') {
      let ready = waterGuard.waterReady()
      if (!ready.ok) {
        if (ready.toBar) {
          try { await bot.equip(bucket, 'hand') } catch { return { ok: false, acted: false } }
          ready = waterGuard.waterReady()
        }
        if (ready.retryMs > 0) { await ctx.sleep(ready.retryMs); ready = waterGuard.waterReady() }
        if (!ready.ok || ctx.ctl.aborted) return { ok: false, acted: false }
        return await dropFromPerch() // Reprice before cleanup can reclaim the child's hand.
      }
      releaseWater = waterGuard.planWater({ owner: {}, until: ctx.gameClock.now() + choice.ms + 3000 })
      if (!releaseWater) return { ok: false, acted: false }
    }
    if (smashDrop) {
      const m = ctx.findItem(ctx.bot, i => i.name === 'mace')
      if (m && (!ctx.bot.heldItem || ctx.bot.heldItem.name !== 'mace')) await ctx.holdItem(m)
      const t1 = ctx.gameClock.now()
      while (ctx.gameClock.now() - t1 < 1100 && !ctx.ctl.aborted && ctx.mace.fallSmashReady(ctx.bot, ctx.entity)) await ctx.sleep(ctx.TICK_MS)
    }
    if (ctx.ctl.aborted || !bot.entity.onGround || bot.entity.position.distanceTo(me0) > .05 ||
      (bot.health ?? 0) + (read.absorptionOf(bot, bot.entity) || 0) <= choice.damage) return { ok: false, acted: !!smashDrop }
    ctx.edgeGuard.allow(Math.ceil(me0.y - choice.plan.target.y) + 1, choice.ms + 500)
    for (let i = 0; i < choice.plan.steps.length && !ctx.ctl.aborted; i++) {
      if (choice.kind === 'water' && (waterGuard.placed || bot.entity.isInWater)) break
      if (i && bot.entity.position.distanceTo(choice.plan.states[i - 1].pos) > .65) break
      const step = choice.plan.steps[i]
      if (choice.kind !== 'water' || !waterGuard.busy) await bot.look(step.yaw, 0, true)
      if (ctx.ctl.aborted) break
      for (const [key, value] of Object.entries(step.control)) ctx.set(key, value)
      await ctx.sleep(ctx.TICK_MS)
      if (smashDrop && bot.entity.position.y < me0.y - .6) break
    }
    ctx.clear()
    if (choice.kind === 'water') {
      const until = ctx.gameClock.now() + 3000
      while ((bot.health ?? 0) > 0 && ctx.gameClock.now() < until &&
        (!bot.entity.onGround || waterGuard.placed || waterGuard.picked <= pickedBefore && !ctx.ctl.aborted)) {
        await ctx.sleep(ctx.TICK_MS)
      }
      const landed = bot.entity.onGround && bot.entity.position.y < me0.y - .6
      const picked = waterGuard.picked > pickedBefore && !!ctx.findItem(bot, item => item.name === 'water_bucket')
      if (landed) {
        ctx.perch = null
        ctx.used(picked ? 'спрыгнул со столба с водой и забрал ведро' : waterGuard.fired > firedBefore
          ? 'спрыгнул со столба: вода и подбор не подтверждены' : 'спрыгнул со столба: водяной клатч не сработал')
      }
      return { ok: landed && picked, acted: true, kind: 'water', damage: picked ? 0 : choice.failureDamage,
        failureDamage: choice.failureDamage, ms: choice.ms, picked, fired: waterGuard.fired > firedBefore }
    }
    if (smashDrop && !ctx.ctl.aborted && !bot.entity.onGround && bot.entity.position.y < me0.y - .6) {
      const fr = await ctx.mace.descend(ctx.bot, ctx.ctl, ctx.entity, { vel: () => ctx.track.vel(), stats: ctx.mc.st, telemetryHp: ctx.telemetryHp })
      ctx.mc.st.fallSmash++
      if (fr.hit) { ctx.st.swings++; ctx.lastSwing = ctx.gameClock.now(); ctx.mc.st.smashHits++ }
      ctx.used(fr.hit ? 'булава: удар со столба' : 'булава: со столба не достал')
      await ctx.holdWeapon()
    }
    const ok = bot.entity.onGround && bot.entity.position.y < me0.y - .6
    if (ok) {
      ctx.perch = null
      ctx.used(`спрыгнул со столба: ${choice.damage.toFixed(1)} хп, ${choice.ms} мс`)
    }
    return { ok, acted: true, kind: 'drop', damage: choice.damage, ms: choice.ms }
    } finally {
      releaseWater?.()
      ctx.clear(); ctx.aim = 'target'
      if (choice.kind === 'water' && bot.entity.onGround && !waterGuard.placed) await ctx.holdWeapon()
    }
  }
return { perchHeight, headroom, pillarOut, dropFromPerch }
}

// Коробка: чем лечиться, можно ли, где ставить.
function createFortSiting (ctx: CombatContext) {
const healItem = () => ctx.findPotion(ctx.bot, 'splash_potion', 'heal') || ctx.findPotion(ctx.bot, 'potion', 'heal') ||
    ctx.findPotion(ctx.bot, 'potion', 'regen') || ctx.findItem(ctx.bot, i => /golden_apple$/.test(i.name)) ||
    ctx.findItem(ctx.bot, i => /cooked_|bread|baked_potato|golden_carrot|steak/.test(i.name))

const fortPossible = () => {
    const filler = ctx.pickFiller(ctx.bot)
    if (!filler || ctx.countOf(ctx.bot, filler.name) < 10 || !ctx.fortify.canBreakOut(ctx.bot, filler)) return false
    if (!ctx.bot.entity.onGround || ctx.bot.entity.isInWater) return false
    const cell = ctx.bot.entity.position.floored()
    for (const k of [2, 3]) {
      const b = ctx.bot.blockAt(cell.offset(0, k, 0))
      if (!b || b.boundingBox !== 'empty') return false
    }
    const creeper = ctx.bot.nearestEntity(e => e && e.name === 'creeper' && e.position.distanceTo(ctx.bot.entity.position) < 9)
    if (creeper) return false
    return !!ctx.healItem() || (ctx.bot.food ?? 0) >= 18
  }

const isAir = (c) => { const b = ctx.bot.blockAt(c); return !!b && b.name === 'air' }

const cellOk = (c) => {
    if (!ctx.solid(ctx.bot, c.offset(0, -1, 0))) return false
    for (const y of [0, 1, 2]) if (!ctx.isAir(c.offset(0, y, 0)) && !(y < 2 && c.equals(ctx.fortify.feetCell(ctx.bot)) && ctx.bot.blockAt(c.offset(0, y, 0)).boundingBox === 'empty' && ctx.bot.blockAt(c.offset(0, y, 0)).name !== 'cobweb')) return false
    for (const [dx, dz] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
      for (const y of [0, 1]) if (!ctx.isAir(c.offset(dx, y, dz))) return false
    }
    return true
  }

const fortSpot = () => {
    const here = ctx.fortify.feetCell(ctx.bot)
    if (ctx.cellOk(here)) return here
    const away = ctx.bot.entity.position.minus(ctx.entity.position)
    let best = null; let bs = Infinity
    for (let dx = -5; dx <= 5; dx++) {
      for (let dz = -5; dz <= 5; dz++) {
        for (const dy of [0, -1, 1]) {
          const c = here.offset(dx, dy, dz)
          if (!ctx.cellOk(c)) continue
          const dist = Math.hypot(dx, dz)
          const toward = (dx * away.x + dz * away.z) / (Math.hypot(away.x, away.z) || 1)
          const sc = dist - toward * 0.6 + Math.abs(dy)
          if (sc < bs) { bs = sc; best = c }
        }
      }
    }
    return best
  }
return { healItem, fortPossible, isAir, cellOk, fortSpot }
}

// Коробка: риск под ударами и сама постройка.
function createFortOut (ctx: CombatContext) {
const shelterRisk = (ms) => {
    const foes = (ctx.tt.threats?.() || [ctx.entity]).filter(e => e && e.isValid !== false && e._ndVisible !== false &&
      (require('./last-seen') as typeof import('./last-seen')).seesPlayer(ctx.bot, e))
    if (!foes.length) return null
    const state = (require('../combat-safety') as typeof import('../combat-safety')).inspect(ctx.bot, { entities: foes, target: foes[0] })
    let expected = 0
    for (const foe of foes) {
      const eta = ctx.tt.eta(foe), exposed = ms + ctx.style.reactMs - eta
      if (exposed < 0) continue
      const hand = { name: foe.equipment?.[0]?.name || '' }
      const cooldown = ctx.cooldownMs(hand)
      const hit = state.threats?.find(t => t.id === foe.id)?.hit || state.hit
      if (!hit) return 'нет безопасного времени на коробку'
      expected += hit * (1 + Math.floor(exposed / Math.max(50, cooldown)))
    }
    const hp = (ctx.bot.health ?? 0) + (read.absorptionOf(ctx.bot, ctx.bot.entity) || 0)
    return expected >= hp ? 'риск смерти за время стройки' : null
  }

const fortOut = async () => {
    const spot = ctx.fortSpot()
    const check = spot && ctx.fortify.boxCheck(ctx.bot, { cell: spot, toward: ctx.entity.position, roof: true })
    const moveMs = spot ? spot.offset(.5, 0, .5).distanceTo(ctx.bot.entity.position) / 4.3 * 1000 : 0
    const risk = check?.ok ? shelterRisk(check.ms + moveMs) : null
    if (!check?.ok || risk) {
      ctx.st.build.refused++; ctx.rest('fort', 15000); ctx.used('коробка: ' + (risk || check?.why || 'негде закрыться')); return false
    }
    ctx.noteBuild('box', check.ms)
    ctx.aim = 'free'
    ctx.pathTo(false); ctx.pathing = false
    ctx.clear()
    if (!spot.equals(ctx.fortify.feetCell(ctx.bot))) {
      ctx.used('отбегаю на чистое место под коробку')
      try {
        ctx.bot.pathfinder.setGoal(new ctx.goals.GoalBlock(spot.x, spot.y, spot.z))
        const t0 = ctx.gameClock.now()
        while (ctx.gameClock.now() - t0 < 3000 && !ctx.ctl.aborted && !ctx.fortify.feetCell(ctx.bot).equals(spot) && !shelterRisk(check.ms)) await ctx.sleep(50)
      } catch {}
      ctx.bot.pathfinder.setGoal(null)
      ctx.clear()
      if (!ctx.fortify.feetCell(ctx.bot).equals(spot)) {
        if (ctx.process.env.ND_DEBUG_PVP || ctx.process.env.ND_TRACE_PVP) console.log('[fort] не добежал', JSON.stringify({ spot, pos: ctx.bot.entity.position }))
        ctx.aim = 'target'; ctx.used('не добежал до места под коробку'); return false
      }
    }
    const gB: any = ctx.buildGuard()
    const boxT0 = ctx.gameClock.now()
    const box = await ctx.fortify.boxIn(ctx.bot, { toward: ctx.entity.position, roof: true, ctl: ctx.guardCtl(gB), abortIf: shelterRisk })
    if (ctx.st.build.boxMs.length < 12) ctx.st.build.boxMs.push(ctx.gameClock.now() - boxT0)
    if (ctx.process.env.ND_DEBUG_PVP) console.log('[fort]', JSON.stringify({ placed: box.placed, walls: box.walls, roof: box.roof, failed: box.failed, cell: box.cell, pos: ctx.bot.entity.position }))
    if (!box.sealed || box.aborted || ctx.ctl.aborted) {
      ctx.aim = 'target'
      await ctx.holdWeapon()
      if (!ctx.buildDone(gB, 'коробку') && box.placed) ctx.used('коробка не вышла')
      return false
    }
    ctx.fort = box
    ctx.st.blocks = (ctx.st.blocks || 0) + box.placed
    ctx.used(`закрылся в коробке (${box.placed} бл.)`)
    // Сидеть на шифте (пользователь 10.10: «прячутся — пусть шифт жмут, ника тогда не видно сквозь стены»).
    try { ctx.bot.setControlState('sneak', true) } catch {}
    if (box.hardN) ctx.used(`коробка: лицо, бока и крыша — ${box.hard}`)
    let patchedTotal = 0
    let hitThrough = 0
    let holeSince = 0
    let budget = ctx.style.patchBudget
    let why = null
    let breakAway = false
    while (!ctx.ctl.aborted) {
      if ((ctx.bot.health ?? 0) <= 0) break
      if (!ctx.bot.entity.position.floored().equals(box.cell)) break
      const hpNow = ctx.bot.health ?? 20
      const swell = ctx.bot.nearestEntity(e => e && e.name === 'creeper' && e.position.distanceTo(ctx.bot.entity.position) < 6 && ctx.creeperSwelling(ctx.bot, e))
      if (swell) { ctx.used('крипер у коробки — выхожу'); break }
      const eye0 = ctx.bot.entity.position.offset(0, ctx.EYE, 0)
      // Он в дыре и достаётся рукой — бить через неё (прицел как у клиента:
      const holeAim = ctx.entity.isValid && ctx.reachFrom(eye0, ctx.entity) <= ctx.HIT_REACH && ctx.gameClock.now() >= ctx.nextReady
        ? ctx.pick.aim(ctx.bot, ctx.entity, { eye: ctx.pick.eyeOf(ctx.bot), range: ctx.HIT_REACH }) : null
      if (holeAim && holeAim.point) {
        await ctx.holdWeapon()
        await ctx.bot.lookAt(holeAim.point, true).catch(() => {})
        try { ctx.bot.attack(ctx.entity) } catch {}
        ctx.st.swings++
        hitThrough++
        ctx.lastSwing = ctx.gameClock.now()
        ctx.nextReady = ctx.lastSwing + ctx.cooldownMs(ctx.bot.heldItem)
        await ctx.sleep(ctx.TICK_MS)
        continue
      }
      if (ctx.tempo.ON && ctx.prof.player) {
        const burningNow = ctx.onFire(ctx.bot) && !ctx.hasEffect(ctx.bot, 'fire_resistance')
        const wb = burningNow && !ctx.bot.entity.isInWater && ctx.ready('fortWater') ? ctx.findItem(ctx.bot, i => i.name === 'water_bucket') : null
        if (wb) {
          ctx.rest('fortWater', 2000)
          await ctx.useOnGroundAt(wb, box.cell, 'вода: потушился в коробке')
          await ctx.sleep(250)
          await ctx.scoop(box.cell)
          await ctx.holdWeapon()
          continue
        }
        const encB = ctx.fortify.enclosure(ctx.bot, box.cell)
        const fs = ctx.entity.isValid ? ctx.tt.foes.get(ctx.entity.id) : null
        const theirEye0 = ctx.entity.position.offset(0, ctx.EYE, 0)
        const canHitMe = ctx.entity.isValid && ctx.reachFrom(theirEye0, ctx.bot.entity) <= ctx.tempo.PLAYER_REACH &&
          ctx.pick.canHit(ctx.bot, ctx.bot.entity, { eye: theirEye0, range: ctx.tempo.PLAYER_REACH })
        const digLeft = ctx.entity.isValid ? ctx.tt.digLeftMs(ctx.entity) : null
        const digging = !!(fs && ctx.gameClock.now() - fs.digAt < 1200 && fs.digPos && fs.digPos.distanceTo(box.cell) <= 2.5) && (digLeft == null || digLeft < 1200)
        if (!digging && digLeft != null && digLeft >= 1200 && fs && fs.digPos && fs.digPos.distanceTo(box.cell) <= 2.5 && ctx.ready('hardDigNote')) { ctx.rest('hardDigNote', 3000); ctx.used('он ломает крепкую стену — ещё лечусь') }
        const nearHole = !encB.sealed && ctx.entity.isValid && ctx.entity.position.distanceTo(ctx.bot.entity.position) < 5
        const hurtNow = ctx.gameClock.now() - ctx.tt.myHurtAt < 1000
        const breach = canHitMe ? 'он достаёт через дыру' : digging ? 'он ломает стену' : hurtNow ? 'по мне попали' : nearHole ? 'дыра, он рядом' : burningNow ? 'горю, воды нет' : null
        // Латать, а не выбегать (пользователь 10.10: «ломаю сверху укрытие — блоки не ставят, чтобы закрыться»): дыра есть
        // и есть чем — заделать сразу; стену ещё ломают — ждать дыру и заделать. Выход — когда по мне уже попали, латать
        // нечем, бюджет подтверждённых блоков кончился или дыру не удалось закрыть.
        const canPatch = breach && !hurtNow && !burningNow && budget > 0 && ctx.pickFiller(ctx.bot)
        if (canPatch && !encB.sealed) {
          const n = await ctx.fortify.patch(ctx.bot, box.plan, { mats: box.mats, ctl: ctx.guardCtl(ctx.buildGuard()) })
          if (n) {
            patchedTotal += n; budget -= n; holeSince = 0; ctx.st.blocks = (ctx.st.blocks || 0) + n
            if (ctx.ready('patchNote')) { ctx.rest('patchNote', 2000); ctx.used(`заделал дыру (${breach})`) }
            continue
          }
        } else if (canPatch && digging) { await ctx.sleep(50); continue }
        if (breach) {
          ctx.tt.stats.breaches++
          const theirHp0 = ctx.foeHpDecide(ctx.entity) // оценка, не метаданные (правило 06.10)
          const edge = (theirHp0 != null && hpNow >= theirHp0 + 6) || !!ctx.tt.state(ctx.entity).consuming
          why = `вскрыли (${breach}) — ${edge ? 'перевес, выхожу драться' : 'вырываюсь с тыла'}`
          breakAway = !edge
          break
        }
      }
      const enc = ctx.fortify.enclosure(ctx.bot, box.cell)
      if (!enc.sealed) {
        if (!holeSince) holeSince = ctx.gameClock.now()
        const filler = ctx.pickFiller(ctx.bot)
        if (!filler || budget <= 0) { why = 'латать нечем или хватит'; break }
        if (ctx.gameClock.now() - holeSince >= ctx.style.reactMs) {
          const n = await ctx.fortify.patch(ctx.bot, box.plan, { mats: box.mats, ctl: ctx.guardCtl(ctx.buildGuard()) })
          if (n) { patchedTotal += n; budget -= n; ctx.st.blocks = (ctx.st.blocks || 0) + n; holeSince = 0 }
          else { why = 'дырка не закрывается — выхожу'; break }
        }
      } else holeSince = 0
      if (ctx.tempo.ON && ctx.prof.player && ctx.ready('fortBuff') && ctx.tt.safe(ctx.tempo.consumeMs('potion'), { fortSealed: ctx.fortSealed() }).ok) {
        ctx.rest('fortBuff', 400)
        const potOf = k => ctx.findItem(ctx.bot, i => i.name === 'potion' && (ctx.potionOf(i) || '').replace(/^(long|strong)_/, '') === k)
        const need = [['strength', 'strength'], ['speed', 'swiftness'], ['regeneration', 'regeneration']].find(([e, k]) => !ctx.hasEffect(ctx.bot, e) && potOf(k))
        if (need && (await ctx.drink(potOf(need[1]), 'выпил в коробке ' + need[1]))) { await ctx.holdWeapon(); continue }
      }
      const item0 = hpNow < 17 && ctx.ready('fortEat') ? ctx.healItem() : null
      const item = item0 && (/splash_potion/.test(item0.name) || !(ctx.tempo.ON && ctx.prof.player) ||
        ctx.tt.safe(ctx.tempo.consumeMs(item0.name), { fortSealed: ctx.fortSealed() }).ok) ? item0 : null
      if (item) {
        ctx.rest('fortEat', 1800)
        let confirmed = false
        if (/splash_potion/.test(item.name)) {
          confirmed = await ctx.holdItem(item) && await ctx.useAt(ctx.bot.entity.yaw, -Math.PI / 2, { item })
          if (confirmed) { ctx.used('лечение под ноги'); ctx.st.healed.push('взрывное лечения') }
          ctx.aim = 'free'
        } else if (await ctx.consumeItem(item)) { confirmed = true; ctx.used('съел в коробке ' + item.name); ctx.st.healed.push(item.name) }
        if (!confirmed) { why = 'лечение не подтверждено — перепланирую'; break }
      }
      const regen = (ctx.bot.food ?? 0) >= 18 || ctx.hasEffect(ctx.bot, 'regeneration')
      if ((ctx.bot.health ?? 0) >= 18) break
      if (!ctx.healItem() && !regen) { why = 'лечиться больше нечем'; break }
      await ctx.sleep(100)
    }
    try { ctx.bot.setControlState('sneak', false) } catch {}
    if (why) ctx.used(`из коробки: ${why}`)
    const stillIn = ctx.bot.entity && (ctx.bot.health ?? 0) > 0 && ctx.bot.entity.position.floored().equals(box.cell)
    if (!stillIn) {
      ctx.used((ctx.bot.health ?? 0) <= 0 ? 'убит в своей коробке' : 'выбит из коробки')
      ctx.fort = null
      ctx.aim = 'target'
      if ((ctx.bot.health ?? 0) > 0) await ctx.holdWeapon()
      return true
    }
    if (patchedTotal) ctx.used(`залатал коробку (${patchedTotal} бл.)`)
    if (hitThrough) ctx.used(`бил через дыру ×${hitThrough}`)
    const theirs = ctx.foeHpDecide(ctx.entity)
    const bold = !breakAway && (ctx.bot.health ?? 0) >= (theirs ?? 20) - 2
    const out = await ctx.fortify.breakOut(ctx.bot, box.cell, bold ? { toward: ctx.entity.position } : { away: ctx.entity.position }, {
      onHole: async () => {
        const eye0 = ctx.bot.entity.position.offset(0, ctx.EYE, 0)
        if (!ctx.entity.isValid || ctx.reachFrom(eye0, ctx.entity) > ctx.HIT_REACH) return false
        await ctx.holdWeapon()
        if (ctx.gameClock.now() < ctx.nextReady) await ctx.sleep(ctx.nextReady - ctx.gameClock.now())
        const ha = ctx.pick.aim(ctx.bot, ctx.entity, { eye: ctx.pick.eyeOf(ctx.bot), range: ctx.HIT_REACH })
        if (!ha || !ha.point) return false
        await ctx.bot.lookAt(ha.point, true).catch(() => {})
        try { ctx.bot.attack(ctx.entity) } catch {}
        ctx.st.swings++
        ctx.lastSwing = ctx.gameClock.now()
        ctx.nextReady = ctx.lastSwing + ctx.cooldownMs(ctx.bot.heldItem)
        return true
      }
    })
    if (ctx.process.env.ND_DEBUG_PVP) console.log('[fort] out', JSON.stringify({ ok: out.ok, side: out.side, hp: ctx.bot.health, theirs, bold, steps: out.steps }))
    ctx.used(out.ok ? (bold ? 'вышел из коробки ему во фланг' : 'вышел из коробки с тыла') : 'не выбрался из коробки')
    if (out.ok) {
      await ctx.bot.lookAt(out.exit.offset(0.5, 1.2, 0.5), true).catch(() => {})
      ctx.set('forward', true)
      await ctx.sleep(350)
      ctx.set('forward', false)
      if (breakAway) {
        ctx.fort = null
        ctx.aim = 'free'
        const how = await ctx.tempo.kite(ctx.bot, ctx.ctl, () => [ctx.entity], {
          ms: 2500,
          until: () => ctx.tt.safe(ctx.tempo.consumeMs('golden_apple')).ok,
          stop: () => ctx.entity.isValid && ctx.reachFrom(ctx.entity.position.offset(0, ctx.EYE, 0), ctx.bot.entity) <= ctx.tempo.PLAYER_REACH
        })
        ctx.tt.stats.breachEscapes++
        ctx.tt.stats.kites++
        ctx.used('вырвался из вскрытой коробки: ' + how)
      }
    }
    ctx.fort = null
    ctx.aim = 'target'
    await ctx.holdWeapon()
    return true
  }
return { fortOut }
}
