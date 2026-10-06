type CombatContext = Record<string, any>

export function createCover(ctx: CombatContext) {
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
    const y0 = ctx.bot.entity.position.y
    ctx.pathTo(false); ctx.pathing = false
    ctx.clear()
    ctx.aim = 'free'
    try { await ctx.towerUp(ctx.bot, ctx.guardCtl(gP), h, { sneak: false, fast: true, beforeStep: ctx.towerShield }) } catch {}
    ctx.aim = 'target'
    ctx.switched(before)
    await ctx.holdWeapon()
    if (ctx.buildDone(gP, 'столб')) return false
    const top = ctx.bot.entity.position.y
    if (top - y0 < 3) return false
    ctx.perch = { since: ctx.gameClock.now(), y0, top, h: Math.round(top - y0) }
    ctx.used(`ушёл на столб ${ctx.perch.h} бл. (спуск −${Math.max(0, ctx.perch.h - 3)} хп)`)
    ctx.st.blocks = (ctx.st.blocks || 0) + ctx.perch.h
    return true
  }

const dropFromPerch = async () => {
    const me0 = ctx.bot.entity.position
    const toward = ctx.yawTo(me0, ctx.entity.position)
    let yaw = toward
    for (const off of [0, 0.8, -0.8, 1.6, -1.6, 2.4, -2.4, Math.PI]) {
      const y = toward + off
      const cell = me0.offset(-Math.sin(y) * 1.2, 0, -Math.cos(y) * 1.2).floored()
      let bad = true
      for (let k = 0; k <= ctx.PERCH_MAX + 2; k++) {
        const n = ctx.blockName(ctx.bot, cell.offset(0, -k, 0))
        if (!n || n === 'air' || n === 'cave_air') continue
        bad = /lava|fire|magma|cactus|campfire|sweet_berry/.test(n)
        break
      }
      if (!bad) { yaw = y; break }
    }
    const smashDrop = ctx.prof.player && ctx.mace.fallSmashReady(ctx.bot, ctx.entity)
    if (smashDrop) {
      const m = ctx.findItem(ctx.bot, i => i.name === 'mace')
      if (m && (!ctx.bot.heldItem || ctx.bot.heldItem.name !== 'mace')) await ctx.holdItem(m)
      const t1 = ctx.gameClock.now()
      while (ctx.gameClock.now() - t1 < 1100 && !ctx.ctl.aborted && ctx.mace.fallSmashReady(ctx.bot, ctx.entity)) await ctx.sleep(ctx.TICK_MS)
    }
    ctx.aim = 'free'
    await ctx.bot.look(yaw, 0, true).catch(() => {})
    ctx.clear()
    ctx.edgeGuard.allow(ctx.PERCH_MAX + 2, 1500)
    ctx.set('forward', true)
    const t0 = ctx.gameClock.now()
    while (ctx.gameClock.now() - t0 < 900 && ctx.bot.entity.position.y > ctx.perch.top - 0.6 && !ctx.ctl.aborted) await ctx.sleep(ctx.TICK_MS)
    ctx.set('forward', false)
    if (smashDrop) {
      const fr = await ctx.mace.descend(ctx.bot, ctx.ctl, ctx.entity, { vel: () => ctx.track.vel(), stats: ctx.mc.st })
      ctx.mc.st.fallSmash++
      if (fr.hit) { ctx.st.swings++; ctx.lastSwing = ctx.gameClock.now(); ctx.mc.st.smashHits++ }
      ctx.used(fr.hit ? 'булава: удар со столба' : 'булава: со столба не достал')
      await ctx.holdWeapon()
    }
    ctx.aim = 'target'
    ctx.perch = null
    ctx.used('спрыгнул со столба')
  }

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

const fortOut = async () => {
    if (ctx.FIX && ctx.buildHot(ctx.BOX_FRONT_MS)) { ctx.st.build.refused++; ctx.rest('fort', 1200); if (ctx.ready('boxNoNote')) { ctx.rest('boxNoNote', 3000); ctx.used('коробка: не строю — он достанет за стройку') } return false }
    ctx.noteBuild('box', ctx.BOX_MS)
    ctx.aim = 'free'
    ctx.pathTo(false); ctx.pathing = false
    ctx.clear()
    const spot = ctx.fortSpot()
    if (!spot) { ctx.aim = 'target'; ctx.used('негде строить коробку'); return false }
    if (!spot.equals(ctx.fortify.feetCell(ctx.bot))) {
      ctx.used('отбегаю на чистое место под коробку')
      try {
        ctx.bot.pathfinder.setGoal(new ctx.goals.GoalBlock(spot.x, spot.y, spot.z))
        const t0 = ctx.gameClock.now()
        while (ctx.gameClock.now() - t0 < 3000 && !ctx.ctl.aborted && !ctx.fortify.feetCell(ctx.bot).equals(spot)) await ctx.sleep(50)
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
    const box = await ctx.fortify.boxIn(ctx.bot, { toward: ctx.entity.position, roof: true, ctl: ctx.guardCtl(gB) })
    if (ctx.st.build.boxMs.length < 12) ctx.st.build.boxMs.push(ctx.gameClock.now() - boxT0)
    if (ctx.process.env.ND_DEBUG_PVP) console.log('[fort]', JSON.stringify({ placed: box.placed, walls: box.walls, roof: box.roof, failed: box.failed, cell: box.cell, pos: ctx.bot.entity.position }))
    if (box.walls < 3 || (gB.why && !box.sealed)) {
      ctx.aim = 'target'
      await ctx.holdWeapon()
      if (!ctx.buildDone(gB, 'коробку') && box.placed) ctx.used('коробка не вышла')
      return false
    }
    ctx.fort = box
    ctx.st.blocks = (ctx.st.blocks || 0) + box.placed
    ctx.used(`закрылся в коробке (${box.placed} бл.)`)
    if (box.hardN) ctx.used(`коробка: лицо, бока и крыша — ${box.hard}`)
    const t0 = ctx.gameClock.now()
    let patchedTotal = 0
    let hitThrough = 0
    let breaches = 0
    let holeSince = 0
    let budget = ctx.style.patchBudget
    let why = null
    let breakAway = false
    while (!ctx.ctl.aborted && ctx.gameClock.now() - t0 < 70000) {
      if ((ctx.bot.health ?? 0) <= 0) break
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
        if (!holeSince) { holeSince = ctx.gameClock.now(); breaches++ }
        const filler = ctx.pickFiller(ctx.bot)
        if (!filler || budget <= 0) { why = 'латать нечем или хватит'; break }
        if (breaches >= 3 && ctx.gameClock.now() - t0 < 12000) { why = 'ломает быстрее, чем латаю'; break }
        if (ctx.gameClock.now() - holeSince >= ctx.style.reactMs) {
          const n = await ctx.fortify.patch(ctx.bot, box.plan, { mats: box.mats })
          if (n) { patchedTotal += n; budget -= n; ctx.st.blocks = (ctx.st.blocks || 0) + n; holeSince = 0 }
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
        if (/splash_potion/.test(item.name)) {
          if (await ctx.holdItem(item)) { await ctx.useAt(ctx.bot.entity.yaw, -Math.PI / 2); ctx.used('лечение под ноги'); ctx.st.healed.push('взрывное лечения') }
          ctx.aim = 'free'
        } else if (await ctx.consumeItem(item)) { ctx.used('съел в коробке ' + item.name); ctx.st.healed.push(item.name) }
      }
      const waited = ctx.gameClock.now() - t0
      const regen = (ctx.bot.food ?? 0) >= 18
      if (hpNow >= 18) break
      if (!ctx.healItem() && hpNow >= 14 && waited > 12000) break
      if (!ctx.healItem() && !regen && waited > 15000) break
      if (waited > Math.max(ctx.style.boxPatienceMs, 20000) && hpNow >= 10) { why = 'надоело сидеть'; break }
      if (waited > 60000) break
      await ctx.sleep(100)
    }
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
return { buildGuard, guardCtl, buildDone, buildHot, noteBuild, wallToward, coverFrom, coverForDrink, perchHeight, headroom, pillarOut, dropFromPerch, healItem, fortPossible, isAir, cellOk, fortSpot, fortOut }
}
