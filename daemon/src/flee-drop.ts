// Отход вниз: сухая посадка, вода, паутина и планирование сравниваются одной ценой.
import { Vec3 } from 'vec3'
import * as read from './read'
import * as damage from './pvp/damage-model'
import { observedCollision } from './pvp/search'
import { ledgeOptions, planLedgeDrop, waterBelow, planWaterDrop } from './navigation/descent'
import { bodyClear, supportAt, HAZARD } from './navigation/geometry'
import { landingDamage } from './navigation/landing'
import { withinArena, forecastOwner } from './navigation/parkour'
import { mlgLandingBad } from './edges/mlg'
import * as clock from './game-clock'
import * as sky from './elytra'
import * as tools from './tools'
import * as pick from './pick'
import { withTimeout } from './build'
import { watchDigReceipt } from './environments/dig-receipt'
import { PlayerState, controls, clone, simulator } from './navigation/parkour/model'

// Короткий выход через пролом: тот же нативный прогноз, без прыжка и скрытых клеток.
function wallExit(bot, target) {
  const st = new PlayerState(bot, controls()), sim = simulator(bot), world = { getBlock: p => bot.blockAt(p, false) }
  const steps = [], states = []; let settled = 0
  for (let i = 0; i < 45; i++) {
    const dx = target.x - st.pos.x, dz = target.z - st.pos.z
    const near = Math.hypot(dx, dz) < .2
    st.yaw = Math.atan2(-dx, -dz); st.control = controls({ forward: !near, sneak: near })
    sim(st, world)
    if (!bodyClear(bot, st.pos) || st.isInLava || st.isInWater || st.isInWeb || Math.abs(st.pos.y - target.y) > .1) return null
    steps.push({ yaw: st.yaw, control: { ...st.control } }); states.push(clone(st))
    if (near && st.onGround && Math.hypot(st.vel.x, st.vel.z) < .05 && ++settled >= 4) {
      const floor = supportAt(bot, st.pos, .04)
      return floor && !HAZARD.test(floor.block.name) ? { steps, states, ticks: steps.length, target: { ...st.pos }, damage: 0 } : null
    }
  }
  return null
}

function wingReady(bot) {
  if (!sky.ON || bot.currentWindow || bot.entity.isInWater || bot.entity.isInLava) return false
  const wing = [bot.inventory.slots[6], ...bot.inventory.items()].find(it => it?.name === 'elytra')
  const max = wing?.maxDurability ?? bot.registry?.itemsByName?.elytra?.maxDurability
  return !!wing && Number.isFinite(max) && (wing.durabilityUsed ?? 0) < max - 1
}

function glideLanding(bot, plan, arena) {
  bot = bot._ndReflexSession?.bot ?? bot
  if (!wingReady(bot)) return null
  const W = sky.worldOf(bot, { observed: true })
  const air = plan.states.findIndex(st => !st.onGround && !W.boxHit(st.pos.x, st.pos.y - .1, st.pos.z))
  if (air < 0) return null
  const st = plan.states[air]
  // Касание rollout заходит в пол подшагом до 0.45: граница на блок ниже, сама посадка — не ниже пола.
  const bounds = { ...arena, killY: Math.max(arena.killY ?? -64, (arena.y ?? plan.target.y) - 1) }
  const glide = sky.choose(W, { p: st.pos, v: st.vel, boost: 0, fd: bot.entity.position.y - st.pos.y },
    { kind: 'land', at: plan.target, arena: bounds, maxFallDamage: plan.damage })
  // Локальный прогноз на 18 тиков ещё не доказывает посадку; нужен полный манёвр landingPlan.
  if (glide?.work == null || glide.r.kind !== 'floor') return null
  const floor = W.floorBelow(glide.r.p.x, glide.r.p.y + .5, glide.r.p.z, 3)
  if (!floor || floor.lava || floor.water) return null
  const end = new Vec3(glide.r.p.x, floor.top, glide.r.p.z)
  if (bot.entity.position.y - end.y <= 3 || end.y < Math.max(arena.y ?? plan.target.y, (arena.killY ?? -64) + 1) ||
      !withinArena(bot, end, arena) || !bodyClear(bot, end) || !W.landingSafe(end)) return null
  const support = supportAt(bot, end, .04)
  if (!support) return null
  const fd = Math.max(0, glide.r.fd - Math.max(0, floor.top - glide.r.p.y))
  const damageRaw = landingDamage(support.block, fd, bot.entity.attributes)
  if (damageRaw > plan.damage) return null
  return { ...glide, air, end, damageRaw, bounds }
}

export function dropOptions(bot, arena, price) {
  if (!arena || !bot.entity.onGround || !bot.physics?.simulatePlayer) return []
  const me = bot.entity.position
  // Ниже поля — воронка/подвал, не выход с яруса; неизвестное не становится полом.
  const floor = Math.max(arena.y ?? me.y, (arena.killY ?? -64) + 1)
  const sight = observedCollision(bot), cache = new Map()
  const observed = Object.assign(Object.create(bot), { blockAt(p) {
    const key = p.floored().toString()
    if (!cache.has(key)) cache.set(key, sight.blockAt(p))
    return cache.get(key)
  } })
  // Воздух — не опора: дешёвый предварительный поиск. Саму траекторию всё равно проверяет observed.
  const discovery = Object.assign(Object.create(bot), { blockAt(p) {
    const raw = bot.blockAt(p, false)
    return raw && /^(air|cave_air|void_air)$/.test(raw.name) ? raw : observed.blockAt(p)
  } })
  const effect = bot.registry?.effectsByName?.resistance || bot.registry?.effectsByName?.Resistance
  const defense = slots => damage.defenseOf(slots.map(s => bot.inventory.slots[s]).filter(Boolean).map(it => ({ name: it.name,
    ench: { protection: read.enchLevel(bot, it, 'protection'), feather_falling: read.enchLevel(bot, it, 'feather_falling') } })),
  { resistance: (effect && bot.entity.effects?.[effect.id]?.amplifier) ?? -1 })
  const def = defense([5, 6, 7, 8]), flightDef = defense([5, 7, 8])
  const hp = (bot.health ?? 0) + read.absorptionOf(bot, bot.entity)
  const fallGuard = bot._ndFallGuard
  const inBar = name => bot.inventory.slots.slice(36, 45).some(it => it?.name === name)
  const waterReady = !/nether/.test(String(bot.game?.dimension || '')) && inBar('water_bucket') && fallGuard?.waterReady?.().ok
  const webReady = inBar('cobweb') && fallGuard?.webReady?.().ok
  // shortcut: до накопления квитанций риск оценён сглаженной частотой; калибровать по живым замерам MLG.
  const miss = Math.min(1, ((fallGuard?.missed ?? 0) + 1) / ((fallGuard?.saved ?? 0) + (fallGuard?.missed ?? 0) + 2))
  const recentMiss = fallGuard?.missedAt != null && clock.now() - fallGuard.missedAt < 30 * 60 * 1000
  const risk = recentMiss ? Math.max(.5, miss) : miss
  const options = []
  const variant = { sprint: (bot.food ?? 20) > 6, jump: false, coast: 6 }
  const add = (plan, water = false, technique = '', glide = null, dig = null, exit = false, inspect = false) => {
    if (!plan || !exit && !inspect && me.y - plan.target.y <= 3 || plan.target.y < floor || plan.states.some(st => !withinArena(bot, st.pos, arena, me))) return
    if (technique === 'water' && mlgLandingBad(observed, Math.floor(plan.target.x), plan.target.y, Math.floor(plan.target.z))) return
    // Промах может стоить всей жизни: это конечная цена риска, а не бесплатное обнуление сухого урона.
    const dry = damage.afterDefense(plan.damage, 'fall', technique === 'elytra' ? flightDef : def)
    const contact = glide ? damage.afterDefense(glide.damageRaw, 'fall', flightDef) : 0
    if (contact >= hp) return
    const hurt = technique ? contact + Math.min(Math.max(0, dry - contact), hp - contact) * risk : dry
    if (hurt >= hp) return
    const end = glide?.end ?? new Vec3(plan.target.x, plan.target.y, plan.target.z)
    const wait = Math.ceil((dig?.ms ?? 0) / 50)
    const ticks = wait + (glide ? glide.air + 1 + glide.r.t + (sky.wearingElytra(bot) ? 0 : 8) : plan.ticks + (technique ? 20 : 0))
    const states = [...Array.from({ length: wait }, () => ({ pos: me, onGround: true })), ...plan.states]
    const yaw = plan.steps[0]?.yaw ?? bot.entity.yaw, riskCost = technique ? 60 * risk * dry : 0
    options.push({ yaw, dir: { x: -Math.sin(yaw), z: -Math.cos(yaw) },
      run: inspect ? 0 : 10, end, cost: price(end, hurt, ticks, glide ? [] : states) + riskCost / hp,
      drop: { plan, hurt, hp, water, technique, glide, dig, exit, inspect, riskCost, from: me.clone(), velocity: bot.entity.velocity.clone() } })
  }
  const targets = (me.y - floor > 3 ? ledgeOptions(discovery, { ...me, y: floor }, { radius: 4, maxFallDamage: me.y - floor }) : [])
    .map(p => {
      const support = supportAt(observed, p, .04)
      const hurt = support ? damage.afterDefense(landingDamage(support.block, me.y - p.y, bot.entity.attributes), 'fall', def) : Infinity
      return { p, cost: price(p, hurt, 0, []) }
    }).sort((a, b) => a.cost - b.cost)
  // Короткий список сначала; не считаем сотни траекторий каждые 300 мс.
  const shortlist = targets.slice(0, 3)
  const deepest = targets.reduce((a, b) => !a || b.p.y < a.p.y ? b : a, null)
  if (deepest && !shortlist.includes(deepest)) shortlist.push(deepest)
  for (const target of shortlist) {
    const plan = planLedgeDrop(observed, target.p, variant, Infinity)
    if (Number.isFinite(target.cost)) add(plan)
    if (!plan) continue
    if (waterReady) add(plan, false, 'water')
    if (webReady) add(plan, false, 'cobweb')
    const glide = glideLanding(bot, plan, arena)
    if (glide) add(plan, false, 'elytra', glide)
  }
  const waters = waterBelow(discovery, { radius: 4, maxDrop: me.y - floor, soft: false })
  for (const water of waters.slice(0, 3)) add(planWaterDrop(observed, water, variant), true)
  const feet = me.floored(), sides = [[1, 0], [-1, 0], [0, 1], [0, -1]]
  const routes = [
    ...[[0, 0], ...sides].map(([x, z]) => ({ positions: [feet.offset(x, -1, z)], target: null })),
    ...sides.map(([x, z]) => ({ positions: [feet.offset(x, 1, z), feet.offset(x, 0, z)], target: feet.offset(2 * x + .5, 0, 2 * z + .5) }))
  ]
  for (const route of routes) {
    const blocks = route.positions.map(p => observed.blockAt(p)).filter(b => b?.boundingBox === 'block')
    if (!blocks.length) continue
    const digs = blocks.map(b => ({ position: b.position.clone(), stateId: b.stateId, ms: tools.bestFor(bot, b).ms }))
    const ms = digs.reduce((sum, b) => sum + b.ms, 0)
    // Непрозрачная стена: сперва открыть взгляд, стоя на прежней опоре; следующий ход решается по новому обзору.
    const opening = route.target && digs.find(b => Number.isFinite(b.ms) && pick.blockAim(bot, b.position, { range: 4.5, seeThrough: null }))
    if (opening && supportAt(observed, me, .04)) add({ steps: [], states: [], ticks: 0, target: { ...me }, damage: 0 },
      false, '', null, { blocks: [opening], ms: opening.ms }, false, true)
    if (!Number.isFinite(ms) || blocks.some(b => !pick.blockAim(bot, b.position, { range: 4.5, seeThrough: null }))) continue
    const dig = { blocks: digs, ms }
    // Удаляем только увиденные блоки; за ними остаётся прежнее неизвестное, а не пакетный рентген.
    const opened = Object.assign(Object.create(observed), { blockAt(p) {
      const cell = p.floored()
      return digs.some(b => b.position.equals(cell)) ? { name: 'air', boundingBox: 'empty', shapes: [], position: cell } : observed.blockAt(cell)
    } })
    if (route.target) add(wallExit(opened, route.target), false, '', null, dig, true)
    for (const target of shortlist) {
      const plan = planLedgeDrop(opened, target.p, variant, Infinity)
      if (Number.isFinite(target.cost)) add(plan, false, '', null, dig)
      if (waterReady) add(plan, false, 'water', null, dig)
      if (webReady) add(plan, false, 'cobweb', null, dig)
    }
    for (const water of waters.slice(0, 3)) add(planWaterDrop(opened, water, variant), true, '', null, dig)
  }
  return options
}

export async function runDrop(bot, ctl, choice, guard, arena, onDrop = null) {
  const { hurt, hp, water, technique, from, velocity, dig, exit, inspect } = choice.drop
  let plan = choice.drop.plan
  const anchorSupport = inspect && supportAt(bot, from, .04)
  const anchor = anchorSupport && bot.blockAt(anchorSupport.block.position)
  const health = () => (bot.health ?? 0) + read.absorptionOf(bot, bot.entity)
  const safetyReady = () => technique === 'water' ? bot._ndFallGuard?.waterReady?.().ok : technique === 'cobweb' ? bot._ndFallGuard?.webReady?.().ok : technique !== 'elytra' || sky.wearingElytra(bot) && wingReady(bot)
  const landingValid = () => {
    if (inspect && (!anchor || !bot.entity.onGround || bot.entity.position.distanceTo(from) > .1)) return false
    const target = new Vec3(plan.target.x, plan.target.y, plan.target.z)
    if (!bodyClear(bot, target, { water })) return false
    if (water) return bot.blockAt(target.floored())?.name === 'water'
    const floor = supportAt(bot, target, .04)
    const currentFloor = floor && bot.blockAt(floor.block.position)
    return !!floor && (!inspect || currentFloor?.stateId === anchor.stateId && currentFloor.position.equals(anchor.position)) && !HAZARD.test(floor.block.name) &&
      landingDamage(floor.block, from.y - target.y, bot.entity.attributes) <= plan.damage
  }
  const fresh = () => !ctl.aborted && bot.entity.onGround && bot.entity.position.distanceTo(from) <= .1 && bot.entity.velocity.distanceTo(velocity) <= .05 && (dig || health() >= hp) && health() > hurt
  if (!fresh()) return false
  if (!landingValid()) return false
  let glide = null
  if (technique === 'elytra') {
    glide = glideLanding(bot, plan, arena)
    if (!glide) return false
    if (!sky.wearingElytra(bot)) {
      if (!(await sky.swapChest(bot, 'elytra', { ctl })).ok || !fresh() || !landingValid()) return false
      glide = glideLanding(bot, plan, arena)
      if (!glide) return false
    }
  }
  let release = null
  if (technique === 'water' || technique === 'cobweb') {
    if (technique === 'water' && mlgLandingBad(bot, Math.floor(plan.target.x), plan.target.y, Math.floor(plan.target.z))) return false
    release = bot._ndFallGuard?.planWater?.({ owner: choice, until: clock.now() + (plan.ticks + 20) * 50 + (dig?.ms ?? 0),
      ...(technique === 'cobweb' ? { material: 'cobweb' } : {}) })
    if (!release) return false
  }
  bot.clearControlStates()
  const previous = bot._ndParkourForecast
  const own = forecastOwner(bot.entity.position, bot.health ?? 0)
  bot._ndParkourForecast = own
  guard.allow(Math.ceil(from.y - plan.target.y) + 1, (plan.ticks + 4) * 50 + (dig?.ms ?? 0))
  return new Promise<boolean>((resolve, reject) => {
    let i = 0, done = false, preparing = !!dig, lowest = from.clone(), braking = 'без', terminal = false, reported = false
    const observeDrop = () => {
      if (!bot.entity?.position) return
      if (bot.entity.position.y < lowest.y) lowest = bot.entity.position.clone()
      if (from.y - bot.entity.position.y <= 3) return
      if (bot.entity.isInWater) braking = 'вода'
      else if (bot.entity.isInWeb || bot.blockAt(bot.entity.position.floored())?.name === 'cobweb') braking = 'паутина'
    }
    const finish = (ok = false, error = null) => {
      if (done) return
      done = true
      observeDrop()
      if (preparing) { try { bot.stopDigging() } catch {} }
      release?.()
      bot.removeListener('physicsTick', tick); bot.removeListener('death', gone); bot.removeListener('end', gone)
      const index = ctl.onAbort?.indexOf(abort) ?? -1
      if (index >= 0) ctl.onAbort.splice(index, 1)
      if (bot._ndParkourForecast === own) {
        if (previous) bot._ndParkourForecast = previous
        else delete bot._ndParkourForecast
      }
      bot.clearControlStates(); guard.allow(3, 0)
      const report = () => {
        if (reported) return
        reported = true
        if (from.y - lowest.y > 3) {
          try { onDrop?.({ height: from.y - lowest.y, technique: braking, from: from.clone(), to: lowest }) } catch {}
        }
      }
      const contact = () => !bot.entity || bot.entity.onGround || bot.entity.isInWater || bot.entity.isInWeb || braking === 'вода' || braking === 'паутина'
      // Отмена отдаёт управление сразу; уже начатое падение только досматриваем до контакта или срока.
      if (onDrop && !terminal && health() > 0 && !contact() &&
          (lowest.y < from.y || bot.entity.velocity.y < 0 && bot.entity.position.y <= from.y)) {
        let timer
        const close = () => {
          if (reported) return
          try { observeDrop() } catch {}
          bot.removeListener('physicsTick', follow); bot.removeListener('death', close); bot.removeListener('end', close)
          clock.clearTimeout(timer); report()
        }
        const follow = () => {
          try { observeDrop(); if (contact() || health() <= 0) close() } catch { close() }
        }
        bot.on('physicsTick', follow); bot.on('death', close); bot.on('end', close)
        timer = clock.setTimeout(close, (plan.ticks + 20) * 50)
      } else report()
      if (error) reject(error); else resolve(ok)
    }
    const abort = () => finish()
    const gone = () => { terminal = true; finish() }
    const apply = () => {
      if (ctl.aborted || health() <= 0 || !bot.entity.onGround && health() <= hurt || !withinArena(bot, bot.entity.position, arena, from)) { finish(); return }
      // Обычный сход отменяем после удара; копка допускает удар и заново сравнивается с боем на месте.
      if (bot.entity.onGround && bot.entity.position.y >= from.y - .5 && (!dig && health() < hp || !landingValid() || !safetyReady())) { finish(); return }
      if (!bodyClear(bot, plan.states[i].pos, { water: water || technique === 'water', web: technique === 'cobweb' })) { finish(); return }
      const step = plan.steps[i]
      // guard смотрит вниз лишь на 14 бл.; точный текущий прогноз, как у executePlan, разрешает и глубокий спуск.
      own.from = { ...bot.entity.position }; own.next = { ...plan.states[i].pos }; own.hp = bot.health ?? 0
      void bot.look(step.yaw, 0, true).catch(error => finish(false, error))
      for (const [key, value] of Object.entries(step.control)) bot.setControlState(key, value)
    }
    const tick = () => {
      try {
        observeDrop()
        if (ctl.aborted || health() <= 0 || !withinArena(bot, bot.entity.position, arena, from)) { finish(); return }
        if (preparing) { if (health() <= hurt || !landingValid() || !safetyReady()) finish(); return }
        if (technique === 'elytra' && i >= glide.air && !ctl.aborted && !bot.entity.onGround) {
          // Сухой прогноз заканчивается при раскрытии; дальше рулит готовая безракетная посадка.
          if (bot.entity.position.distanceTo(plan.states[i].pos) > .65 || health() <= 0 ||
              !withinArena(bot, bot.entity.position, arena, from) || !wingReady(bot) || !sky.startGlide(bot)) { finish(); return }
          braking = 'элитры'
          bot.removeListener('physicsTick', tick)
          if (bot._ndParkourForecast === own) {
            if (previous) bot._ndParkourForecast = previous
            else delete bot._ndParkourForecast
          }
          bot.clearControlStates()
          const flight = sky.install(bot), fallen = Math.max(0, from.y - bot.entity.position.y)
          flight.fd = Math.max(flight.fd, fallen); flight.moveFd = Math.max(flight.moveFd, fallen)
          void sky.steer(bot, glide.yaw, glide.pitch)
          void sky.land(bot, ctl, { at: choice.end, maxFallDamage: glide.damageRaw, arena: glide.bounds })
            .then(async result => {
              if (bot.entity.onGround) await sky.chestDown(bot, ctl, { arena })
              finish(result.ok && bot.entity.position.y >= (arena.y ?? plan.target.y))
            }).catch(error => finish(false, error))
          return
        }
        if (technique && bot.entity.position.y < from.y - 3 &&
            (bot.entity.isInWater || bot.entity.isInWeb || bot.blockAt(bot.entity.position.floored())?.name === 'cobweb')) { finish(true); return }
        const expected = plan.states[i++]
        if (ctl.aborted || bot.entity.position.distanceTo(expected.pos) > .65 || health() <= 0 ||
          !withinArena(bot, bot.entity.position, arena, from)) { finish(); return }
        if (i < plan.steps.length) { apply(); return }
        finish(technique !== 'water' && technique !== 'cobweb' && (exit || bot.entity.position.y < from.y - 3) &&
          (water ? !!bot.entity.isInWater : bot.entity.onGround && Math.abs(bot.entity.position.y - plan.target.y) < .1))
      } catch (error) { finish(false, error) }
    }
    bot.on('physicsTick', tick); bot.on('death', gone); bot.on('end', gone); ctl.onAbort?.push(abort)
    if (dig) void (async () => {
      for (const [index, expected] of dig.blocks.entries()) {
        if (done || ctl.aborted || health() <= hurt || !landingValid() || !safetyReady()) { finish(); return }
        const b = bot.blockAt(expected.position), point = pick.blockAim(bot, expected.position, { range: 4.5, seeThrough: null })
        if (!point || b?.stateId !== expected.stateId || tools.bestFor(bot, b).ms > expected.ms) { finish(); return }
        await tools.equipFastest(bot, b)
        if (done || ctl.aborted) { finish(); return }
        await bot.lookAt(point, true)
        if (done || ctl.aborted || health() <= hurt || bot.blockAt(expected.position)?.stateId !== expected.stateId ||
            !pick.blockAim(bot, expected.position, { range: 4.5, seeThrough: null })) { finish(); return }
        const wait = Math.ceil(dig.blocks.slice(index).reduce((sum, b) => sum + b.ms, 0) / 50)
        const pending = { ...plan, ticks: plan.ticks + wait,
          states: [...Array.from({ length: wait }, () => ({ pos: bot.entity.position, onGround: bot.entity.onGround })), ...plan.states] }
        if (choice.drop.worth && !choice.drop.worth(pending, hurt)) { finish(); return }
        const receipt = watchDigReceipt(bot, expected.position, () => done || ctl.aborted || health() <= hurt)
        try {
          await withTimeout(bot.dig(b, 'ignore', undefined, ctl), expected.ms + 1500)
          if (await receipt.settle() !== 'confirmed') { finish(); return }
        } finally { receipt.close() }
      }
      if (done) return
      if (inspect) {
        if (ctl.aborted || !landingValid()) { finish(); return }
        await bot.lookAt(dig.blocks[0].position.offset(.5, .5, .5), true)
        finish(!ctl.aborted && landingValid())
        return
      }
      // Сервер подтвердил дыру уже после начала падения: старый первый кадр больше не является текущим.
      const sight = observedCollision(bot), revealed = Object.assign(Object.create(bot), { blockAt: p => sight.blockAt(p) })
      const column = water && waterBelow(revealed, { radius: 4, maxDrop: from.y - (arena.y ?? plan.target.y), soft: false })
        .find(w => w.x === Math.floor(plan.target.x) && w.z === Math.floor(plan.target.z))
      const remaining = exit ? wallExit(revealed, plan.target) : water ? column && planWaterDrop(revealed, column, plan.variant)
        : planLedgeDrop(revealed, plan.target, plan.variant, plan.damage)
      if (!remaining || remaining.ticks > plan.ticks + 1 || remaining.damage > plan.damage ||
          remaining.states.some(st => !withinArena(bot, st.pos, arena, from))) { finish(); return }
      if (health() <= hurt || bot.entity.onGround && choice.drop.worth && !choice.drop.worth(remaining, hurt)) { finish(); return }
      plan = { ...remaining, damage: plan.damage }
      preparing = false
      apply()
    })().catch(error => finish(false, error))
    else try { apply() } catch (error) { finish(false, error) }
  })
}
