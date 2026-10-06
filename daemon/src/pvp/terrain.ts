type CombatContext = Record<string, any>

export function createTerrain(ctx: CombatContext) {
const punchThrough = async () => {
    ctx.rest('punch', 700)
    const eye0 = ctx.bot.entity.position.offset(0, ctx.EYE, 0)
    const to = ctx.entity.position.offset(0, (ctx.entity.height || 1.8) * 0.6, 0)
    const delta = to.minus(eye0)
    const dist = delta.norm()
    if (dist < 0.5 || dist > 7) return false
    let hit = null
    try { hit = ctx.bot.world.raycast(eye0, delta.scaled(1 / dist), dist, b => b && b.boundingBox === 'block') } catch {}
    if (!hit || hit.position.offset(0.5, 0.5, 0.5).distanceTo(eye0) > 4.5) return false
    const plan = ctx.tools.bestFor(ctx.bot, hit)
    if (plan.ms > 1500) return false
    ctx.pathTo(false); ctx.pathing = false
    ctx.clear()
    ctx.aim = 'free'
    const r = await ctx.tools.breakFast(ctx.bot, hit.position, { maxMs: 1500 })
    ctx.aim = 'target'
    await ctx.holdWeapon()
    if (r.ok) { ctx.used(`пробил его стенку (${r.tool})`); return true }
    return false
  }

const edgeTally = (now) => {
    try {
      const b = ctx.bot.entity
      if (b.onGround) { ctx.falls.ground = b.position.y; if (ctx.falls.mine && now - ctx.falls.mine > 500) ctx.falls.mine = 0 }
      if (!b.onGround && ctx.falls.ground != null && b.position.y < ctx.falls.ground - 3 && !ctx.falls.mine) {
        ctx.falls.mine = now
        ctx.used(now - ctx.lastHurtByTarget < 1500 ? 'выбили в яму' : 'сорвался в яму сам')
      }
      if (!ctx.entity || !ctx.entity.position) return
      ctx.falls.hisY.push({ y: ctx.entity.position.y, t: now })
      while (ctx.falls.hisY.length > 2 && now - ctx.falls.hisY[0].t > 800) ctx.falls.hisY.shift()
      if (ctx.falls.hisY[0].y - ctx.entity.position.y > 3 && now - ctx.lastSwing < 2500 && now - ctx.falls.his > 5000) {
        ctx.falls.his = now
        ctx.used('столкнул в яму')
      }
    } catch {}
  }

const climbOut = async (pit) => {
    const filler = ctx.pickFiller(ctx.bot)
    const foe = ctx.entity.position
    ctx.pathTo(false); ctx.pathing = false
    ctx.clear()
    ctx.aim = 'free'
    try {
      if (filler && ctx.countOf(ctx.bot, filler.name) >= pit.depth && ctx.headroom(pit.depth + 1)) {
        ctx.noteBuild('pit', pit.depth * ctx.PILLAR_MS)
        const gT = ctx.buildGuard()
        try { await ctx.towerUp(ctx.bot, ctx.guardCtl(gT), pit.depth, { sneak: false, fast: true, beforeStep: ctx.towerShield }) } catch {}
        if (ctx.buildDone(gT, 'столб из ямы')) return true
        const f = ctx.bot.entity.position.floored()
        let best = null
        for (const [dx, dz] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
          const c = f.offset(dx, 0, dz)
          if (!ctx.solid(ctx.bot, c.offset(0, -1, 0)) || ctx.solid(ctx.bot, c) || ctx.solid(ctx.bot, c.offset(0, 1, 0))) continue
          const away = Math.hypot(c.x + 0.5 - foe.x, c.z + 0.5 - foe.z)
          if (!best || away > best.away) best = { c, away }
        }
        if (best) {
          await ctx.bot.lookAt(best.c.offset(0.5, 1.2, 0.5), true).catch(() => {})
          ctx.set('forward', true)
          await ctx.sleep(450)
          ctx.set('forward', false)
        }
        ctx.used(`выбрался из ямы столбом (${pit.depth} бл.)`)
        ctx.st.blocks = (ctx.st.blocks || 0) + pit.depth
        return true
      }
      const f0 = ctx.bot.entity.position.floored()
      let dir = null
      let far = -1
      for (const [dx, dz] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
        if (!ctx.solid(ctx.bot, f0.offset(dx, 0, dz))) continue
        const away = Math.hypot(f0.x + dx + 0.5 - foe.x, f0.z + dz + 0.5 - foe.z)
        if (away > far) { far = away; dir = [dx, dz] }
      }
      if (!dir) return false
      for (let k = 0; k < pit.depth + 1 && !ctx.ctl.aborted; k++) {
        const f = ctx.bot.entity.position.floored()
        const step = f.offset(dir[0], 0, dir[1])
        for (const c of [step.offset(0, 1, 0), step.offset(0, 2, 0), f.offset(0, 2, 0)]) {
          if (ctx.solid(ctx.bot, c)) { const r = await ctx.tools.breakFast(ctx.bot, c, { maxMs: 4000 }); if (!r.ok) return false }
        }
        if (!ctx.solid(ctx.bot, step)) break
        await ctx.bot.lookAt(step.offset(0.5, 1.5, 0.5), true).catch(() => {})
        ctx.set('forward', true); ctx.set('jump', true)
        const y0 = ctx.bot.entity.position.y
        const t0 = ctx.gameClock.now()
        while (ctx.gameClock.now() - t0 < 700 && ctx.bot.entity.position.y < y0 + 0.9) await ctx.sleep(ctx.TICK_MS)
        ctx.set('jump', false)
        await ctx.sleep(150)
        ctx.set('forward', false)
      }
      ctx.used('вырубил ступени из ямы')
      return true
    } finally {
      ctx.clear()
      ctx.aim = 'target'
      await ctx.holdWeapon()
    }
  }

const lavaIntoPit = async (lava) => {
    const f = ctx.entity.position.floored()
    let roof = null
    for (let y = f.y + 2; y <= ctx.theirPit.rimY; y++) {
      const c = new ctx.Vec3(f.x, y, f.z)
      if (ctx.solid(ctx.bot, c)) { roof = c; break }
    }
    if (roof) {
      const myFeet = ctx.bot.entity.position.floored()
      if (myFeet.x === roof.x && myFeet.z === roof.z && myFeet.y === roof.y + 1) {
        const around = [[1, 0], [-1, 0], [0, 1], [0, -1]]
        const step = [...around.map(([dx, dz]) => myFeet.offset(dx, 0, dz)), ...around.map(([dx, dz]) => myFeet.offset(dx, -1, dz))]
          .find(c => !ctx.solid(ctx.bot, c) && !ctx.solid(ctx.bot, c.offset(0, 1, 0)) && ctx.solid(ctx.bot, c.offset(0, -1, 0)) && !/lava|fire|magma/.test(ctx.blockName(ctx.bot, c.offset(0, -1, 0)) || ''))
        if (!step) return false
        ctx.aim = 'free'
        await ctx.bot.lookAt(step.offset(0.5, 1.6, 0.5), true).catch(() => {})
        ctx.clear()
        ctx.set('forward', true)
        const t0 = ctx.gameClock.now()
        while (ctx.gameClock.now() - t0 < 700 && !ctx.ctl.aborted) {
          const p = ctx.bot.entity.position.floored()
          if (p.x === step.x && p.z === step.z) break
          await ctx.sleep(ctx.TICK_MS)
        }
        ctx.clear()
        ctx.aim = 'target'
        ctx.rest('pitLava', 250)
        ctx.used('сошёл с его крыши — вскрывать')
        return true
      }
      const rb = ctx.bot.blockAt(roof)
      const plan = ctx.tools.bestFor(ctx.bot, rb)
      if (plan.unbreakable || plan.ms > 2500 || roof.offset(0.5, 0.5, 0.5).distanceTo(ctx.bot.entity.position.offset(0, ctx.EYE, 0)) > 4.4) return false
      ctx.pathTo(false); ctx.pathing = false
      ctx.clear()
      ctx.aim = 'free'
      const stop = await ctx.digWatch(rb, () => ctx.maceNow() ? 'булава летит' : null)
      ctx.aim = 'target'
      await ctx.holdWeapon()
      if (stop) ctx.used(`бросил вскрывать крышу: ${stop}`)
      else if (!ctx.solid(ctx.bot, roof)) { ctx.rest('pitLava', 250); ctx.used(`вскрыл крышу его коробки (${plan.item ? plan.item.name : 'рукой'}) — лью в дыру`) }
      return true
    }
    const inColumn = c => c.x === f.x && c.z === f.z && c.y >= f.y && c.y <= ctx.theirPit.rimY
    const eye0 = ctx.bot.entity.position.offset(0, ctx.EYE, 0)
    const cands = [f.offset(0.5, 0, 0.5)]
    const top = new ctx.Vec3(f.x, ctx.theirPit.rimY - 1, f.z)
    for (const [dx, dz] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
      const rim = top.offset(dx, 0, dz)
      if (ctx.solid(ctx.bot, rim)) cands.push(rim.offset(0.5 - dx * 0.5, 0.5, 0.5 - dz * 0.5))
    }
    const pick = cands.filter(pt => pt.distanceTo(eye0) < 4.4).find(pt => { const land = ctx.bucketLanding(pt); return land && inColumn(land.cell) })
    if (ctx.process.env.ND_DEBUG_PVP) console.log('[pitlava]', JSON.stringify({ me: ctx.bot.entity.position.floored(), him: f, rimY: ctx.theirPit.rimY, cands: cands.map(pt => { const land = ctx.bucketLanding(pt); return { pt: [pt.x, pt.y, pt.z], dist: +pt.distanceTo(eye0).toFixed(2), land: land && [land.cell.x, land.cell.y, land.cell.z], hit: land && [land.block.x, land.block.y, land.block.z] } }), pick: !!pick }))
    if (!pick) return false
    if (!(await ctx.holdItem(lava))) return false
    ctx.aim = 'free'
    await ctx.bot.lookAt(pick, true).catch(() => {})
    await ctx.sleep(60)
    try { ctx.bot.activateItem() } catch {}
    await ctx.sleep(80)
    ctx.aim = 'target'
    ctx.used('вылил лаву ему в яму')
    await ctx.holdWeapon()
    return true
  }

const bucketLanding = (pt) => {
    const eye = ctx.bot.entity.position.offset(0, ctx.bot.getControlState('sneak') ? 1.27 : ctx.EYE, 0)
    const delta = pt.minus(eye)
    const dist = delta.norm()
    if (dist < 1e-3) return null
    let hit = null
    try { hit = ctx.bot.world.raycast(eye, delta.scaled(1 / dist), 4.5) } catch {}
    if (!hit) return null
    const N = [[0, -1, 0], [0, 1, 0], [0, 0, -1], [0, 0, 1], [-1, 0, 0], [1, 0, 0]][hit.face]
    if (!N) return null
    return { block: hit.position, cell: hit.position.offset(N[0], N[1], N[2]) }
  }

const useOnGroundAt = async (item, cell, what) => {
    if (ctx.ctl.aborted) return false
    const below = ctx.bot.blockAt(cell.offset(0, -1, 0))
    if (!below || below.boundingBox !== 'block') return false
    const fire = item.name === 'flint_and_steel'
    const face = new ctx.Vec3(0, 1, 0)
    const at = fire ? ctx.pick.faceAim(ctx.bot, below.position, face) : below.position.offset(0.5, 1, 0.5)
    if (!at) return false
    if (/_bucket$/.test(item.name)) {
      const land = ctx.bucketLanding(below.position.offset(0.5, 1, 0.5))
      if (!land || !land.cell.equals(cell)) return false
    }
    if (!(await ctx.holdItem(item))) return false
    ctx.aim = 'free'
    try {
      await ctx.bot.lookAt(at, true)
      await ctx.sleep(50)
      if (ctx.ctl.aborted) return false
      if (fire) {
        const fresh = ctx.pick.faceAim(ctx.bot, below.position, face)
        if (!fresh || ctx.bot.heldItem?.name !== item.name) return false
        await ctx.bot.lookAt(fresh, true)
        if (ctx.ctl.aborted) return false
        await ctx.withTimeout(ctx.bot._genericPlace(below, face, { delta: fresh.minus(below.position), forceLook: 'ignore', swingArm: 'right' }), 600)
      }
      else ctx.bot.activateItem()
    } catch { if (fire) return false } finally { ctx.aim = 'target' }
    await ctx.sleep(80)
    ctx.aim = 'target'
    if (fire) {
      const started = ctx.gameClock.now()
      while (!ctx.ctl.aborted && ctx.blockName(ctx.bot, cell) !== 'fire' && ctx.gameClock.now() - started < 500) await ctx.sleep(50)
      if (ctx.ctl.aborted || ctx.blockName(ctx.bot, cell) !== 'fire') return false
    }
    ctx.used(what)
    return true
  }

const scoop = async (cell) => {
    const bucket = ctx.findItem(ctx.bot, i => i.name === 'bucket')
    if (!bucket) return
    if (!(await ctx.holdItem(bucket))) return
    ctx.aim = 'free'
    try {
      await ctx.bot.lookAt(cell.offset(0.5, 0.2, 0.5), true)
      await ctx.sleep(50)
      ctx.bot.activateItem()
    } catch {}
    await ctx.sleep(80)
    ctx.aim = 'target'
  }

const towerShield = async () => {
    if (!ctx.entity.isValid || !ctx.prof.player) return null
    const shield = ctx.guard && ctx.guard.stats && ctx.guard.stats.worn
    if (!shield) return null
    const held = ctx.entity.equipment && ctx.entity.equipment[0] ? ctx.entity.equipment[0].name : ''
    const xbow = held === 'crossbow' && !!ctx.bowWatch.loadedAt
    const drawMs = ctx.bowWatch.drawAt ? ctx.gameClock.now() - ctx.bowWatch.drawAt : -1
    if (!xbow && drawMs < ctx.TOWER_SAFE_DRAW_MS) return null
    if (!ctx.raySees(ctx.bot, ctx.entity.position.offset(0, ctx.EYE, 0), ctx.bot.entity.position.offset(0, 1.2, 0))) return null
    try { await ctx.bot.lookAt(ctx.entity.position.offset(0, 1.4, 0), true) } catch {}
    const raised = await ctx.guard.raise(true)
    if (ctx.process.env.ND_DEBUG_TOWER) console.log('[towerShield] raise', JSON.stringify({ drawMs, xbow, raised, shots: ctx.bowWatch.shots }))
    const t0 = ctx.gameClock.now()
    const shots0 = ctx.bowWatch.shots
    let shot = false
    while (ctx.gameClock.now() - t0 < 4000 && !ctx.ctl.aborted && ctx.entity.isValid) {
      if (ctx.bowWatch.shots > shots0) { shot = true; break }
      if (!ctx.bowWatch.drawAt && !ctx.bowWatch.loadedAt) break
      if (!ctx.raySees(ctx.bot, ctx.entity.position.offset(0, ctx.EYE, 0), ctx.bot.entity.position.offset(0, 1.2, 0))) break
      ctx.bot.lookAt(ctx.entity.position.offset(0, 1.4, 0), true).catch(() => {})
      await ctx.sleep(ctx.TICK_MS)
    }
    if (shot) await ctx.sleep(Math.min(400, 60 + ctx.entity.position.distanceTo(ctx.bot.entity.position) * 17))
    await ctx.guard.raise(false)
    if (ctx.process.env.ND_DEBUG_TOWER) console.log('[towerShield] lower', JSON.stringify({ shot, waited: ctx.gameClock.now() - t0 }))
    if (shot) { ctx.st.towerShots = (ctx.st.towerShots || 0) + 1; if (ctx.ready('towerShieldNote')) { ctx.rest('towerShieldNote', 3000); ctx.used('на столбе — стрела в щит, строю дальше') } }
    return 'waited'
  }

const hazardOnLine = () => {
    const me0 = ctx.bot.entity.position
    const dx = ctx.entity.position.x - me0.x; const dz = ctx.entity.position.z - me0.z
    const len = Math.hypot(dx, dz)
    if (len < 1) return null
    const feetY = Math.floor(me0.y + 1e-3)
    for (let t = 0.8; t <= Math.min(4.5, len - 0.5); t += 0.35) {
      const feet = new ctx.Vec3(Math.floor(me0.x + dx / len * t), feetY, Math.floor(me0.z + dz / len * t))
      const fn = ctx.blockName(ctx.bot, feet) || ''
      if (/^(lava|fire|soul_fire)$/.test(fn)) return { cell: feet, kind: fn }
      const floor = feet.offset(0, -1, 0)
      const fl = ctx.bot.blockAt(floor)
      if (fl && (fl.name === 'lava' || (fl.boundingBox === 'empty' && !/water|cobweb/.test(fl.name)))) return { cell: floor, kind: fl.name === 'lava' ? 'lava' : 'pit' }
    }
    return null
  }

const unblockPath = async () => {
    const h = ctx.hazardOnLine()
    if (!h) return false
    if (h.cell.offset(0.5, 0.5, 0.5).distanceTo(ctx.bot.entity.position.offset(0, ctx.EYE, 0)) > 4.4) return false
    const b = ctx.bot.blockAt(h.cell)
    const lava = !!b && b.name === 'lava'
    let level = null
    try { level = b && b.getProperties ? b.getProperties().level : null } catch {}
    ctx.clear()
    if (lava && (level === 0 || level === '0') && ctx.findItem(ctx.bot, i => i.name === 'bucket')) {
      await ctx.scoop(h.cell)
      await ctx.holdWeapon()
      if (ctx.blockName(ctx.bot, h.cell) !== 'lava') { ctx.used('лава между нами — зачерпнул ведром'); return true }
    }
    if (ctx.pickFiller(ctx.bot)) {
      const r = await ctx.placeBlockAt(ctx.bot, h.cell, { timeoutMs: 700, honest: true }).catch(() => ({ ok: false }))
      await ctx.holdWeapon()
      if (r.ok) { ctx.used(h.kind === 'pit' ? 'дыра между нами — заложил блоком' : 'лава между нами — заложил блоком'); return true }
    }
    const wb = lava ? ctx.findItem(ctx.bot, i => i.name === 'water_bucket') : null
    if (wb && !/nether/.test(String((ctx.bot.game && ctx.bot.game.dimension) || ''))) {
      await ctx.useOnGroundAt(wb, h.cell, 'лава между нами — залил водой')
      ctx.pendingWater.push({ cell: h.cell, at: ctx.gameClock.now() })
      await ctx.holdWeapon()
      return true
    }
    return false
  }

const digWatch = async (block, abortIf) => {
    let why = null
    const plan = ctx.tools.bestFor(ctx.bot, block)
    const iv = ctx.gameClock.setInterval(() => {
      if (why) return
      const w = abortIf()
      if (w) { why = w; try { ctx.bot.stopDigging() } catch {} }
    }, ctx.TICK_MS)
    try { await ctx.withTimeout(ctx.bot.dig(block, true), (Number.isFinite(plan.ms) ? plan.ms : 1000) + 500) } catch {} finally { ctx.gameClock.clearInterval(iv) }
    return why
  }
return { punchThrough, edgeTally, climbOut, lavaIntoPit, bucketLanding, useOnGroundAt, scoop, towerShield, hazardOnLine, unblockPath, digWatch }
}
