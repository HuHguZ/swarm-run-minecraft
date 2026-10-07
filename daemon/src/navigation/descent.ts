// Быстрый спуск со скалы/горы как ход goto (S6c 07.10, просьба пользователя: перефокус lead 22:39).
// Варианты по цене и риску, всё нативной физикой клиента (тот же prismarine-physics, что и у прыжков паркура):
//  water  — прыжок с обрыва в воду внизу: точка отрыва на краю, разбег/прыжок с края, руль в воздухе к колонне воды;
//           план принят, только если тело входит в воду раньше любой сухой посадки (вода любой глубины сбрасывает
//           падение: Entity.checkFallDamage/Entity.move clip с Fluid.WATER, landing-damage-1.21.11.json).
//           То же — паутина, порошковый снег, сено/мёд (урон ×0.2 — только в бюджет урона).
//  ledges — прыжки вниз по уступам (planLedgeDrop: перепад ≤ 3 без урона, по правилу гибкости — больше при высоком хп,
//           урон сверяется квитанцией в executePlan);
//  blocks — где уступов нет: шаг с края вдоль стены, блок на видимую грань стены в падении (clutch.ts, режим deep —
//           самая глубокая безопасная клетка, шаг 3 блока), снова шаг — как игроки;
//  MLG-ведро и мягкие приземления — ходы pathfinder'а и рефлекс клатча (edges.mlgDrop, clutch.ts), здесь не дублируются.
// Сравнение — с настоящим пешим путём pathfinder'а (hopgoto.planWalk/pathSeconds), выигрыш ≥ minGain с. В goto — в начале
// и на ходу (watch: у края с готовым вариантом попытка pathfinder'а обрывается и решает maybeDescend).
// Включено по умолчанию в goto; ND_DESCENT=0 или goto {descent:false} — выключить.
import { Vec3 } from 'vec3'
import { bodyClear, containsWater, groundedHazardClear, shapeBoxes, standPositions, supportAt, type CollisionWorld, type Point } from './geometry'
import { landingDamage } from './landing'
import { executeJump, executePlan, IDLE, type Cancellation, type Control, type JumpPlan, type MovementBot, type State, type Step } from './parkour'

const { PlayerState } = require('../tick-plugins').getPhysics() as { PlayerState: new(bot: MovementBot, control: Control) => State }
const controls = (extra: Partial<Control> = {}): Control => ({ ...IDLE, ...extra })
const flat = (a: Point, b: Point): number => Math.hypot(a.x - b.x, a.z - b.z)
function clone(st: State): State { return Object.assign(Object.create(Object.getPrototypeOf(st)) as State, st, { pos: st.pos.clone(), vel: st.vel.clone(), control: { ...st.control } }) }
function simulator(bot: MovementBot) { return (bot._ndSimOrig ?? bot.physics.simulatePlayer).bind(bot.physics) }
function cachedWorld(bot: MovementBot) {
  const cells = new Map<string, ReturnType<CollisionWorld['blockAt']>>()
  return { getBlock(p: Vec3) { const q = p.floored(); const k = `${q.x},${q.y},${q.z}`; if (!cells.has(k)) cells.set(k, bot.blockAt(q, false)); return cells.get(k) } }
}
// Тело «стоит» в точке `pos` — для прогноза из точки отрыва, куда ещё не дошли.
function standingAt(bot: MovementBot, pos: Point): MovementBot {
  const body = Object.create(bot) as MovementBot
  body.entity = Object.assign(Object.create(Object.getPrototypeOf(bot.entity)), bot.entity, {
    position: new Vec3(pos.x, pos.y, pos.z), velocity: new Vec3(0, 0, 0), onGround: true, isInWater: false, isInLava: false, isInWeb: false })
  return body
}

export const on = (wanted?: unknown): boolean => wanted !== undefined ? wanted !== false : process.env.ND_DESCENT !== '0'
export const RUN = 5.0 // бл/с — как hopgoto.RUN
const SWIM_OUT = 2.5 // с — выплыть из воды на берег (оценка)

// Мягкое внизу (landing-damage-1.21.11.json): вода и паутина сбрасывают падение (Entity.move clip FALLDAMAGE_RESETTING,
// makeStuckInBlock), порошковый снег — 0 урона (PowderSnowBlock.fallOn), сено/мёд — урон ×0.2 (только в бюджет урона).
export type SoftKind = 'water' | 'cobweb' | 'powder_snow' | 'hay_block' | 'honey_block'
const SOFT = /^(cobweb|powder_snow|hay_block|honey_block)$/
export interface WaterColumn { x: number; z: number; top: number; depth: number; kind?: SoftKind }
/** Вода (и мягкое) внизу: колонны в `radius`, первый непустой блок под ногами — вода/мягкое, ниже ног хотя бы на `minDrop`. */
export function waterBelow(bot: MovementBot, { radius = 12, minDrop = 4, maxDrop = 96, soft = true }: { radius?: number; minDrop?: number; maxDrop?: number; soft?: boolean } = {}): WaterColumn[] {
  const me = bot.entity.position; const fy = Math.floor(me.y + 1e-6); const out: WaterColumn[] = []
  for (let dx = -radius; dx <= radius; dx++) for (let dz = -radius; dz <= radius; dz++) {
    if (dx * dx + dz * dz > radius * radius) continue
    const x = Math.floor(me.x) + dx; const z = Math.floor(me.z) + dz
    for (let y = fy + 1; y >= fy - maxDrop; y--) {
      const b = bot.blockAt(new Vec3(x, y, z), false)
      if (!b) break
      const kind: SoftKind | null = containsWater(b) ? 'water' : soft && SOFT.test(b.name) ? b.name as SoftKind : null
      if (kind) {
        const top = kind === 'hay_block' || kind === 'honey_block' ? y + 1 : y
        if (fy - top < minDrop) break
        let depth = 1
        while (kind === 'water' && depth < 4 && bot.blockAt(new Vec3(x, y - depth, z), false) && containsWater(bot.blockAt(new Vec3(x, y - depth, z), false)!)) depth++
        out.push({ x, z, top: y, depth, kind }); break
      }
      if (shapeBoxes(b).length || /lava/.test(b.name)) break
    }
  }
  return out
}

export interface DropVariant { sprint: boolean; jump: boolean; coast: number }
export const DROP_VARIANTS: DropVariant[] = [
  { sprint: false, jump: false, coast: 6 }, { sprint: true, jump: false, coast: 6 }, { sprint: true, jump: true, coast: 6 },
  { sprint: false, jump: false, coast: 12 }, { sprint: true, jump: true, coast: 12 }, { sprint: false, jump: false, coast: 3 }]

/**
 * Прогноз прыжка с обрыва в воду из позиции тела `bot` (или виртуальной точки отрыва — standingAt): бег к краю над
 * колонной воды, прыжок на последнем тике опоры (jump), руль в воздухе с предвидением инерции (coast тиков без клавиш,
 * как planWaterEntry). Принят — тело в воде два тика подряд, до того ни одной сухой посадки ниже 1.25 и ни лавы,
 * ни застревания. Без побочных эффектов.
 */
export function planWaterDrop(bot: MovementBot, water: WaterColumn, variant: DropVariant, maxTicks = 160, maxDamage = 0): (JumpPlan & { variant: DropVariant; drop: number; damage: number }) | null {
  if (!bot.physics) return null
  const world = cachedWorld(bot); const geometry: CollisionWorld = { blockAt: p => world.getBlock(p), physics: bot.physics, game: bot.game }
  const sim = simulator(bot); const st = new PlayerState(bot, controls()); const startY = st.pos.y
  const aim = new Vec3(water.x + .5, water.top, water.z + .5)
  const steps: Step[] = []; const states: State[] = []; let floorY = startY; let wet = 0; let peak = startY
  for (let tick = 0; tick < maxTicks; tick++) {
    const stop = clone(st); stop.control = controls()
    for (let i = 0; i < variant.coast && !stop.onGround; i++) sim(stop, world)
    const dx = aim.x - stop.pos.x; const dz = aim.z - stop.pos.z; const far = Math.hypot(dx, dz) > .15
    const yaw = Math.atan2(-dx, -dz)
    const control = controls({ forward: far, sprint: variant.sprint && far })
    if (variant.jump && st.onGround) {
      const probe = clone(st); probe.yaw = yaw; probe.control = control; sim(probe, world)
      if (!probe.onGround && probe.vel.y <= 0 && probe.pos.y < st.pos.y - .01) control.jump = true // прыжок с последнего тика опоры
    }
    st.yaw = yaw; st.control = control; sim(st, world)
    steps.push({ yaw, control }); states.push(clone(st)); peak = Math.max(peak, st.pos.y)
    const done = () => ({ steps, states, target: { ...st.pos }, ticks: steps.length, variant, drop: peak - st.pos.y, damage: 0 })
    if (st.isInLava || !bodyClear(geometry, st.pos, { water: true, web: true, powder: true })) return null
    // Вода, паутина: падение сброшено — два тика внутри, и план готов.
    if (st.isInWater || st.isInWeb) { if (++wet >= 2) return done(); continue }
    const feet = world.getBlock(st.pos.floored())
    if (feet && feet.name === 'powder_snow' && peak - st.pos.y > 3) return done()
    if (st.onGround && floorY - st.pos.y > 1.25) {
      // Сухая посадка ниже края: только на мягкое из цели и в пределах бюджета урона (сено/мёд ×0.2, снег 0).
      const support = supportAt(geometry, st.pos, .04)
      const damage = support && SOFT.test(support.block.name) ? landingDamage(support.block, peak - st.pos.y, bot.entity.attributes) : Infinity
      if (damage <= maxDamage) return { ...done(), damage }
      return null
    }
    if (st.onGround) {
      // Ступень вниз по дороге к краю — ещё не спуск; ниже — сухая посадка, план не тот.
      floorY = st.pos.y
    }
    if (st.pos.y < water.top - 1.5) return null
  }
  return null
}

/** От точки входа до цели по прямой: по воде — вплавь (~2.2 бл/с), остальное бегом. Озеро поперёк пути — не «бегом». */
export function restSeconds(bot: MovementBot, from: Point, goal: Point): number {
  const d = flat(from, goal); let wet = 0
  for (let i = 1; i <= Math.min(64, Math.floor(d)); i++) {
    const x = from.x + (goal.x - from.x) * i / d; const z = from.z + (goal.z - from.z) * i / d
    for (let y = Math.floor(from.y) + 1; y >= Math.floor(from.y) - 2; y--) {
      const b = bot.blockAt(new Vec3(Math.floor(x), y, Math.floor(z)), false)
      if (b && containsWater(b)) { wet++; break }
      if (b && shapeBoxes(b).length) break
    }
  }
  return wet / 2.2 + (d - wet) / RUN
}

/**
 * Спрыгнуть на уступ ниже: тот же руль, что у прыжка в воду (разбег/прыжок с края/руль в воздухе), принят — посадка на
 * опору уровня `target.y` в 1.5 бл. от цели с уроном ≤ `maxDamage`, и тело, присев, остаётся на ней (скорость < 0.05).
 * Точная клетка не нужна (executeJump требует центр ±0.22 и 6 тиков приседа — на 3 бл. вниз с разгона не сходился).
 */
export function planLedgeDrop(bot: MovementBot, target: Point, variant: DropVariant, maxDamage = 0, maxTicks = 80): (JumpPlan & { variant: DropVariant; damage: number }) | null {
  if (!bot.physics) return null
  const world = cachedWorld(bot); const geometry: CollisionWorld = { blockAt: p => world.getBlock(p), physics: bot.physics, game: bot.game }
  const sim = simulator(bot); const st = new PlayerState(bot, controls()); const startY = st.pos.y
  const steps: Step[] = []; const states: State[] = []; let floorY = startY; let fallen = 0; let landed = -1; let damage = 0
  let allow: JumpPlan['allowDamage']
  for (let tick = 0; tick < maxTicks; tick++) {
    let control: Control; let yaw = st.yaw
    if (landed >= 0) control = controls({ sneak: true }) // посадка: присесть и погасить скорость на уступе
    else {
      const stop = clone(st); stop.control = controls()
      for (let i = 0; i < variant.coast && !stop.onGround; i++) sim(stop, world)
      const dx = target.x - stop.pos.x; const dz = target.z - stop.pos.z; const far = Math.hypot(dx, dz) > .15
      yaw = Math.atan2(-dx, -dz)
      control = controls({ forward: far, sprint: variant.sprint && far })
      if (variant.jump && st.onGround) {
        const probe = clone(st); probe.yaw = yaw; probe.control = control; sim(probe, world)
        if (!probe.onGround && probe.vel.y <= 0 && probe.pos.y < st.pos.y - .01) control.jump = true
      }
    }
    const before = st.pos.y
    st.yaw = yaw; st.control = control; sim(st, world)
    steps.push({ yaw, control }); states.push(clone(st)); fallen += Math.max(0, before - st.pos.y)
    if (st.isInLava || st.isInWater || st.isInWeb || !bodyClear(geometry, st.pos) || !groundedHazardClear(geometry, st.pos, st.vel.y, st.onGround)) return null
    if (landed >= 0) {
      if (!st.onGround || Math.abs(st.pos.y - target.y) > .05) return null // съехал с уступа
      if (Math.hypot(st.vel.x, st.vel.z) < .05 && tick - landed >= 3) return { steps, states, target: { ...st.pos }, ticks: steps.length, variant, damage, ...(allow ? { allowDamage: allow } : {}) }
      continue
    }
    if (st.onGround) {
      if (floorY - st.pos.y <= .55) { floorY = st.pos.y; fallen = 0; continue } // ещё на краю/ступень
      const support = supportAt(geometry, st.pos, .04)
      if (!support || Math.abs(st.pos.y - target.y) > .05 || flat(st.pos, target) > 1.5) return null
      damage = landingDamage(support.block, fallen, bot.entity.attributes)
      if (damage > maxDamage) return null
      // Принятый урон (гибкость): executePlan не считает его отказом после тика посадки (allowDamage); хп и угрозы —
      // safeFallCost перед исполнением (ledgeHops).
      if (damage > 0) allow = { damage, tick: steps.length - 1 }
      landed = tick
    }
    if (st.pos.y < target.y - .5) return null
  }
  return null
}

export interface WaterOption { takeoff: Vec3; water: WaterColumn; plan: ReturnType<typeof planWaterDrop> & object; seconds: number; walk: number }
/**
 * Лучший прыжок в воду отсюда к цели: колонны воды (waterBelow), точки отрыва на уровне ног в `radius` (стоять можно,
 * вода с точки отрыва видна), прогноз по вариантам. Оценка времени: подойти к точке отрыва + полёт + выплыть + от
 * воды до цели по прямой. `budgetMs` — реальные мс на весь поиск (сначала ближние к цели колонны).
 */
export function findWaterDrop(bot: MovementBot, goal: Point, { radius = 6, budgetMs = 120, waterRadius = 12, maxDamage = 0 }: { radius?: number; budgetMs?: number; waterRadius?: number; maxDamage?: number } = {}): WaterOption | null {
  const me = bot.entity.position
  const waters = waterBelow(bot, { radius: waterRadius }).sort((a, b) => flat({ x: a.x + .5, y: 0, z: a.z + .5 }, goal) - flat({ x: b.x + .5, y: 0, z: b.z + .5 }, goal)).slice(0, 6)
  const stands: Vec3[] = []
  for (let dx = -radius; dx <= radius; dx++) for (let dz = -radius; dz <= radius; dz++) {
    if (dx * dx + dz * dz > radius * radius) continue
    for (const p of standPositions(bot, new Vec3(Math.floor(me.x) + dx, me.y, Math.floor(me.z) + dz), { rise: 1, drop: 1 })) stands.push(p)
  }
  // Бюджет — на прогнозы (скан колонн и опор выше не в счёт: под нагрузкой фермы он один съедал 30 мс, s6c-desc-ridge4).
  let best: WaterOption | null = null; const t0 = performance.now()
  for (const water of waters) {
    const wc = { x: water.x + .5, y: water.top, z: water.z + .5 }
    const near = stands.filter(s => flat(s, wc) <= 9).sort((a, b) => flat(a, wc) - flat(b, wc) || flat(a, me) - flat(b, me)).slice(0, 4)
    for (const takeoff of near) {
      if (performance.now() - t0 > budgetMs) return best
      const body = standingAt(bot, takeoff)
      // Глаза на краю (шаг к воде на 0.8 — как человек, заглянувший вниз) или там, где тело сейчас, видят гладь воды.
      const lean = new Vec3(wc.x - takeoff.x, 0, wc.z - takeoff.z); const len = Math.hypot(lean.x, lean.z) || 1
      const surface = new Vec3(wc.x, water.top + .85, wc.z)
      if (![takeoff.offset(lean.x / len * .8, 1.62, lean.z / len * .8), me.offset(0, 1.62, 0)].some(eye => seesPoint(bot, eye, surface))) continue
      for (const variant of DROP_VARIANTS) {
        const plan = planWaterDrop(body, water, variant, 160, maxDamage)
        if (!plan) continue
        const walk = flat(me, takeoff) / RUN
        // Выплыть из воды / выбраться из паутины или снега; урон — по 2 с за хп (гибкость: цена, не запрет).
        const out = water.kind === 'water' || !water.kind ? SWIM_OUT : water.kind === 'cobweb' || water.kind === 'powder_snow' ? 2 : .3
        const seconds = walk + plan.ticks / 20 + out + plan.damage * 2 + restSeconds(bot, plan.target, goal)
        if (!best || seconds < best.seconds) best = { takeoff, water, plan, seconds, walk }
        break
      }
    }
  }
  return best
}

/** Луч от глаз до точки: первое, во что он упрётся (форма блока), — не раньше точки (вода лучу не мешает). */
export function seesPoint(bot: MovementBot, eye: Vec3, point: Vec3): boolean {
  const d = point.minus(eye); const dist = d.norm()
  if (!bot.world || dist < .01) return true
  try { return !bot.world.raycast(eye, d.normalize(), dist - .05, (block, it) => !!block && it.intersect(block.shapes, block.position)) } catch { return false }
}

/** Уступы вниз: опоры в `radius` ниже ног на 0.5..(3 + урон), ближе к цели и глубже — лучше. */
export function ledgeOptions(bot: MovementBot, goal: Point, { radius = 4, maxFallDamage = 0 }: { radius?: number; maxFallDamage?: number } = {}): Vec3[] {
  const me = bot.entity.position; const drop = 3 + Math.max(0, maxFallDamage); const out: Array<{ p: Vec3; score: number }> = []
  for (let dx = -radius; dx <= radius; dx++) for (let dz = -radius; dz <= radius; dz++) {
    if (!dx && !dz || dx * dx + dz * dz > radius * radius) continue
    for (const p of standPositions(bot, new Vec3(Math.floor(me.x) + dx, me.y - 1, Math.floor(me.z) + dz), { rise: 0, drop })) {
      const down = me.y - p.y
      if (down < .5 || down > drop + .01 || p.y < goal.y - .01) continue
      const support = supportAt(bot, p, .04)
      if (!support || /lava|magma|fire|cactus|campfire|dripstone|powder_snow|berry/.test(support.block.name) || lavaNear(bot, p)) continue
      // Урон (гибкость) — только если без него нельзя: 1 хп стоит как 2 блока спуска.
      const damage = landingDamage(support.block, down, bot.entity.attributes)
      out.push({ p, score: down * 1.5 + (flat(me, goal) - flat(p, goal)) - flat(me, p) * .3 - damage * 3 })
    }
  }
  return out.sort((a, b) => b.score - a.score).map(o => o.p)
}

/** Лава в клетках вокруг (±r по x/z, dy от y0 до y1): у лавы — к лаве осторожно (Ад), шаг/прыжок туда не планируем. */
export function lavaNear(bot: MovementBot, at: Point, { r = 1, dy0 = -1, dy1 = 1 }: { r?: number; dy0?: number; dy1?: number } = {}): boolean {
  const x0 = Math.floor(at.x); const y0 = Math.floor(at.y + 1e-6); const z0 = Math.floor(at.z)
  for (let dx = -r; dx <= r; dx++) for (let dz = -r; dz <= r; dz++) for (let dy = dy0; dy <= dy1; dy++) {
    const b = bot.blockAt(new Vec3(x0 + dx, y0 + dy, z0 + dz), false)
    if (b && /lava/.test(b.name)) return true
  }
  return false
}

const FILLER = /^(cobblestone|cobbled_deepslate|dirt|netherrack|stone|deepslate|andesite|diorite|granite|tuff|blackstone|basalt|[a-z_]+_planks)$/
const fullCube = (b: ReturnType<CollisionWorld['blockAt']>) => !!b && b.boundingBox === 'block' && !!b.shapes?.some(s => s.every((v, i) => v === (i < 3 ? 0 : 1)))
const hotbarBlocks = (bot: any): boolean => (bot.inventory?.slots ?? []).slice(36, 45).some((i: any) => i && FILLER.test(i.name) && i.count > 0)
export function blockCount(bot: { inventory?: { items(): Array<{ name: string; count: number }> } }): number {
  return (bot.inventory?.items() ?? []).filter(i => FILLER.test(i.name)).reduce((n, i) => n + i.count, 0)
}
/**
 * Шаг с края вниз вдоль стены: соседняя клетка, где ноги и голова свободны, под ней обрыв глубже 3, а у колонны падения
 * на глубине 3..5 есть полная грань стены (на неё клатч поставит блок). Ближе к цели — лучше. -> направление или null.
 */
export function wallStep(bot: MovementBot, goal: Point, last?: Vec3 | null): { dir: Vec3; cell: Vec3 } | null {
  // Клетка ног — над опорой, а не floor(позиции): тело на краю поставленного блока висит над соседней колонной
  // (s6c-force-wall4: посадка у дальнего края блока → «no_wall_step»).
  const me = bot.entity.position; const support = supportAt(bot, me, .04)
  const f = support ? new Vec3(support.block.position.x, Math.floor(me.y + 1e-6), support.block.position.z) : me.floored()
  let best: { dir: Vec3; cell: Vec3; score: number } | null = null
  for (const [dx, dz] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
    const c = f.offset(dx, 0, dz)
    const free = (p: Vec3) => { const b = bot.blockAt(p, false); return !!b && !shapeBoxes(b).length && !/lava|water|fire|cobweb|powder_snow/.test(b.name) }
    if (!free(c) || !free(c.offset(0, 1, 0))) continue
    let open = 0
    while (open < 6 && free(c.offset(0, -1 - open, 0))) open++
    if (open < 4) continue // ≤ 3 вниз — обычный шаг pathfinder'а
    // Колонна падения до дна и вокруг посадки — без лавы (блок клатча не встанет — тело в лаве).
    let bottom = c.offset(0, -1 - open, 0)
    while (bottom.y > c.y - 128 && free(bottom)) bottom = bottom.offset(0, -1, 0)
    const floor = bot.blockAt(bottom, false)
    // Дно — твёрдое (не пустота Края за 128 бл., не лава рядом).
    if (!floor || !shapeBoxes(floor).length || /lava/.test(floor.name) || lavaNear(bot, bottom.offset(0, 1, 0), { r: 2, dy0: -1, dy1: 1 })) continue
    let wall = false
    for (let k = 3; k <= 5 && !wall; k++) for (const [ax, az] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) if (fullCube(bot.blockAt(c.offset(ax, -k, az), false))) { wall = true; break }
    if (!wall) continue
    // Вдоль стены — зигзагом (шаг назад в колонну рядом с прошлой): стена под ногами не кончается.
    const score = flat(f, goal) - flat(c, goal) - (last && last.x === dx && last.z === dz ? .25 : 0)
    if (!best || score > best.score) best = { dir: new Vec3(dx, 0, dz), cell: c, score }
  }
  return best && { dir: best.dir, cell: best.cell }
}

// Тело сессии — mineflayer-бот (pathfinder, инвентарь, клатч): типы ядра навигации его не описывают.
/**
 * Край обрыва рядом (откуда прыгать по уступам или спускаться блоками): опора на уровне ног (±1) в `radius`, у которой
 * соседняя клетка — обрыв глубже 3. Ближе к цели и к телу — лучше. Тело на краю уже — его позиция.
 */
export function edgeNear(bot: MovementBot, goal: Point, { radius = 8 }: { radius?: number } = {}): Vec3 | null {
  const me = bot.entity.position; let best: { p: Vec3; score: number } | null = null
  const air = (p: Vec3) => { const b = bot.blockAt(p, false); return !!b && !shapeBoxes(b).length && !/lava|water|fire/.test(b.name) }
  for (let dx = -radius; dx <= radius; dx++) for (let dz = -radius; dz <= radius; dz++) {
    if (dx * dx + dz * dz > radius * radius) continue
    for (const p of standPositions(bot, new Vec3(Math.floor(me.x) + dx, me.y, Math.floor(me.z) + dz), { rise: 1, drop: 1 })) {
      const f = p.floored(); let edge = false
      for (const [ax, az] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
        const c = f.offset(ax, 0, az)
        if (air(c) && air(c.offset(0, 1, 0)) && air(c.offset(0, -1, 0)) && air(c.offset(0, -2, 0)) && air(c.offset(0, -3, 0)) && air(c.offset(0, -4, 0)) &&
            flat(c, goal) < flat(f, goal)) { edge = true; break }
      }
      if (!edge) continue
      const score = -flat(p, goal) - flat(me, p) * .5
      if (!best || score > best.score) best = { p, score }
    }
  }
  return best && best.p
}

type Session = { bot: any; current?: { name?: string } | null }
const log = (m: string) => console.log('[descent] ' + m)

/** Дойти pathfinder'ом до клетки опоры `at` (уже там — сразу). */
async function walkTo(bot: any, at: Vec3, ms: number): Promise<{ ok: boolean; why?: string }> {
  if (flat(bot.entity.position, at) <= .3 && Math.abs(bot.entity.position.y - at.y) <= .1) return { ok: true }
  const { goals } = require('mineflayer-pathfinder'); const gameClock = require('../game-clock')
  let timer: unknown = null
  try {
    await Promise.race([bot.pathfinder.goto(new goals.GoalBlock(Math.floor(at.x), Math.floor(at.y + 1e-6), Math.floor(at.z))),
      new Promise((_, reject) => { timer = gameClock.setTimeout(() => reject(new Error('timeout')), ms) })])
    return { ok: true }
  } catch (error) { try { bot.pathfinder.setGoal(null) } catch {} ; return { ok: false, why: String((error as Error)?.message ?? error).slice(0, 60) } } finally { if (timer) gameClock.clearTimeout(timer) }
}

/** Прыжок в воду: дойти до точки отрыва (pathfinder), заново спрогнозировать с настоящего тела и исполнить. */
export async function waterDrop(session: Session, ctl: Cancellation, option: WaterOption): Promise<{ ok: boolean; why?: string; ticks: number; fall?: number; surfaced?: number }> {
  const bot = session.bot
  const walked = await walkTo(bot, option.takeoff, Math.max(4000, option.walk * 3000))
  if (!walked.ok) return { ok: false, why: 'takeoff: ' + walked.why, ticks: 0 }
  if (ctl.aborted) return { ok: false, why: 'interrupted', ticks: 0 }
  for (const variant of [option.plan.variant, ...DROP_VARIANTS.filter(v => v !== option.plan.variant)]) {
    const plan = planWaterDrop(bot, option.water, variant, 160, option.plan.damage)
    if (!plan) continue
    if (plan.damage > 0) bot._ndExpectFall = { until: require('../game-clock').now() + plan.ticks * 50 + 3000, max: plan.damage }
    let r
    try { r = await executePlan(bot, ctl, plan, st => st.isInWater || st.isInWeb || st.onGround) } finally { if (plan.damage > 0) delete bot._ndExpectFall }
    // Выплыть на берег: с глубины pathfinder пути не видит (noPath — узел на дне, до кромки 2 вверх), лестница выхода
    // плыла 3.9–5.4 с (s6c-desc-water/water3: «плыл к берегу, не вышел»). Прыжок (всплыть) + вперёд к ближайшей сухой
    // опоре у кромки, пока тело не встанет на неё (≤ 60 тиков); не нашлось — только всплыть.
    let surfaced = 0
    if (r.ok && bot.entity.isInWater) {
      const at = bot.entity.position
      let shore: Vec3 | null = null
      for (let dx = -4; dx <= 4; dx++) for (let dz = -4; dz <= 4; dz++) {
        for (const p of standPositions(bot, new Vec3(Math.floor(at.x) + dx, option.water.top + 1, Math.floor(at.z) + dz), { rise: 1, drop: 1 })) {
          const under = bot.blockAt(p.offset(0, -.5, 0).floored(), false)
          if (!under || containsWater(under) || lavaNear(bot, p)) continue
          if (!shore || flat(p, at) < flat(shore, at)) shore = p
        }
      }
      try {
        for (; surfaced < 60 && !ctl.aborted; surfaced++) {
          const eye = bot.blockAt(bot.entity.position.offset(0, 1.62, 0).floored(), false)
          if (!shore && (!eye || !containsWater(eye))) break
          if (shore && bot.entity.onGround && !bot.entity.isInWater) break
          if (shore) { await bot.look(Math.atan2(bot.entity.position.x - shore.x, bot.entity.position.z - shore.z), 0, true); bot.setControlState('forward', true) }
          bot.setControlState('jump', true); await bot.waitForTicks(1)
        }
      } finally { bot.setControlState('jump', false); bot.setControlState('forward', false) }
    }
    return { ok: r.ok, why: r.why, ticks: r.ticks, fall: plan.drop, surfaced }
  }
  return { ok: false, why: 'no_water_plan_from_takeoff', ticks: 0 }
}

/** Вниз по уступам: прыжки нативной физикой (executeJump), пока опускаемся к цели. */
export async function ledgeHops(session: Session, ctl: Cancellation, goal: Point, { maxHops = 24, maxFallDamage = 0 }: { maxHops?: number; maxFallDamage?: number } = {}): Promise<{ hops: number; down: number; why?: string }> {
  const bot = session.bot; const y0 = bot.entity.position.y; let hops = 0; let misses = 0
  while (hops < maxHops && !ctl.aborted && bot.entity.position.y > goal.y + .5) {
    let moved = false
    for (const target of ledgeOptions(bot, goal, { maxFallDamage }).slice(0, 3)) {
      // Принятый урон падения (гибкость) не должен рвать goto как «урон» (events INTERRUPTING): session.wireHealth молчит
      // о падении в пределах max до until — executeJump сам сверяет квитанцию урона с прогнозом.
      if (maxFallDamage > 0) bot._ndExpectFall = { until: require('../game-clock').now() + 5000, max: maxFallDamage }
      let r
      try {
        let plan = null
        for (const v of DROP_VARIANTS) if ((plan = planLedgeDrop(bot, target, v, maxFallDamage))) break
        r = plan ? await executePlan(bot, ctl, plan, st => st.onGround && Math.abs(st.pos.y - target.y) < .06)
          : await executeJump(bot, ctl, target, { allowWalk: true, maxTicks: 40, maxFallDamage, planningMs: 150, tolerance: .35 })
      } finally { delete bot._ndExpectFall }
      if (r.ok) { hops++; misses = 0; moved = true; break }
      if (r.ticks > 0) {
        // Тело уже сдвинулось (расхождение, квитанция урона): на узком уступе пеший путь назад часто есть только вниз —
        // встать (крадучись) и спланировать заново отсюда, а не бросать спуск (s6c-desc-flex6: брошенный на уступе бот
        // ушёл с него лестницей выхода и упал на 17 бл.). Три промаха подряд — стоп.
        if (++misses >= 3) return { hops, down: y0 - bot.entity.position.y, why: r.why }
        bot.clearControlStates(); bot.setControlState('sneak', true)
        for (let t = 0; t < 20 && !(bot.entity.onGround && Math.hypot(bot.entity.velocity.x, bot.entity.velocity.z) < .01); t++) await bot.waitForTicks(1)
        moved = true; break
      }
    }
    if (!moved) return { hops, down: y0 - bot.entity.position.y, why: hops ? 'no_lower_ledge' : 'no_ledge' }
  }
  return { hops, down: y0 - bot.entity.position.y, why: ctl.aborted ? 'interrupted' : undefined }
}

/**
 * Вниз блоками вдоль стены: шаг с края (клавиши только до отрыва), падение ведёт рефлекс клатча в режиме deep —
 * блок на видимую грань стены, посадка ≤ 3. Урон или нет шага — стоп. Последние ≤ 3 блока — обычный ход pathfinder'а.
 */
export async function blockSteps(session: Session, ctl: Cancellation, goal: Point, { maxSteps = 40 }: { maxSteps?: number } = {}): Promise<{ steps: number; down: number; placed: number; why?: string }> {
  const bot = session.bot; const gameClock = require('../game-clock'); const y0 = bot.entity.position.y
  const placed0 = bot._ndClutch?.stats?.placed ?? 0; let steps = 0; let last: Vec3 | null = null
  const report = (why?: string) => ({ steps, down: y0 - bot.entity.position.y, placed: (bot._ndClutch?.stats?.placed ?? 0) - placed0, why })
  try { bot.pathfinder?.setGoal(null) } catch {}
  while (steps < maxSteps && !ctl.aborted && bot.entity.position.y > goal.y + 3.5) {
    if (!bot._ndClutch || blockCount(bot) < 1) return report('no_blocks')
    // Клатч ставит только из хотбара (clutch.selectBlock); блоки в рюкзаке он перекладывает сам на земле раз в 1 с —
    // без блока в хотбаре шаг с края был бы падением во всю высоту.
    for (let w = 0; w < 40 && !hotbarBlocks(bot) && !ctl.aborted; w++) await bot.waitForTicks(1)
    if (!hotbarBlocks(bot)) return report('no_hotbar_blocks')
    const step = wallStep(bot, goal, last)
    if (!step) return report(steps ? 'no_wall_step' : 'no_wall')
    last = step.dir
    const hp = bot.health ?? 20
    bot.clearControlStates()
    // Встать на середину опоры (крадучись — не сорваться): иначе шаг вбок уводит тело в колонну без стены рядом.
    const centre = new Vec3(step.cell.x - step.dir.x + .5, bot.entity.position.y, step.cell.z - step.dir.z + .5)
    for (let t = 0; t < 20 && !ctl.aborted && flat(bot.entity.position, centre) > .15; t++) {
      await bot.look(Math.atan2(bot.entity.position.x - centre.x, bot.entity.position.z - centre.z), 0, true)
      bot.setControlState('sneak', true); bot.setControlState('forward', true); await bot.waitForTicks(1)
    }
    bot.clearControlStates()
    await bot.look(Math.atan2(-step.dir.x, -step.dir.z), 0, true)
    bot._ndClutchDeep = gameClock.now() + 4000
    bot.setControlState('forward', true)
    let t = 0
    try { while (t < 20 && bot.entity.onGround && !ctl.aborted) { await bot.waitForTicks(1); t++ } } finally { bot.setControlState('forward', false) }
    if (bot.entity.onGround) { delete bot._ndClutchDeep; return report('did_not_leave_edge') }
    while (t < 120 && !ctl.aborted && !bot.entity.onGround && !bot.entity.isInWater && (bot.health ?? 0) > 0) { await bot.waitForTicks(1); t++ }
    delete bot._ndClutchDeep
    await bot.waitForTicks(4) // квитанция урона идёт за посадкой
    steps++
    if ((bot.health ?? 0) < hp) return report('hurt')
    if (bot.entity.isInWater) return report('water')
  }
  return report(ctl.aborted ? 'interrupted' : undefined)
}

/**
 * Решение в goto: цель ниже на `minDrop`+ — сравнить пеший путь pathfinder'а с прыжком в воду, уступами и блоками,
 * исполнить лучший, если выигрыш ≥ minGain с (или пешего пути нет). Дальше goto идёт сам от места посадки.
 */
export async function maybeDescend(session: Session, ctl: Cancellation, goalXYZ: { x: number; y: number | null; z: number }, goal: unknown, opt: Record<string, any> = {}): Promise<Record<string, unknown>> {
  const bot = session.bot; const me = bot.entity?.position
  const minGain = opt.minGain ?? 3; const minDrop = opt.minDrop ?? 6
  if (!me || !bot.entity.onGround || bot.entity.isInWater || bot.entity.isInLava) return { used: null, why: 'не на земле' }
  if (session.current?.name === 'dragon') return { used: null, why: 'бой с драконом' }
  const gy = goalXYZ.y ?? surfaceY(bot, goalXYZ.x, goalXYZ.z, me.y)
  if (gy == null || me.y - gy < minDrop) return { used: null, why: 'цель не ниже' }
  const target = { x: goalXYZ.x + .5, y: gy, z: goalXYZ.z + .5 }
  const drop = me.y - gy; const t0 = performance.now(); const clock = require('../game-clock'); const g0 = clock.now()
  // Сначала дешёвое: есть ли вообще спуск (вода внизу, уступ ≥ 2, стена для блоков); нет — goto без задержки на A*.
  // Уступы и блоки заранее не проверить целиком — оценка по шагам (ниже); блоками — 1.1 с на шаг по 3 бл. вниз.
  const hp = bot.health ?? 20; const flex = opt.maxFallDamage ?? (hp >= 16 ? 2 : 0)
  // Ад: вода не бывает, но паутина/снег/сено — те же правила (findWaterDrop смотрит всё мягкое).
  const water = findWaterDrop(bot, target, { budgetMs: opt.budgetMs ?? 150, maxDamage: flex })
  // Уступы и блоки — с края обрыва рядом (тело может стоять в глубине плато): дойти до края + спуск + остаток.
  const edge = edgeNear(bot, target)
  const atEdge = edge ? standingAt(bot, edge) : null
  const ledges = atEdge ? ledgeOptions(atEdge, target, { maxFallDamage: flex }).filter(p => edge!.y - p.y >= 2) : []
  const wall = atEdge && blockCount(bot) >= Math.ceil(drop / 3) ? wallStep(atEdge, target) : null
  const toEdge = edge ? flat(me, edge) / RUN : 0
  const options: Array<{ kind: string; seconds: number }> = []
  if (water) options.push({ kind: !water.water.kind || water.water.kind === 'water' ? 'water' : 'soft:' + water.water.kind, seconds: water.seconds })
  // Прыжок с уступа на уступ: ~0.8 с, вниз ~2.5 и ~2 бл. к цели по горизонтали (остаток — бегом).
  const hops = Math.ceil(drop / 2.5)
  if (ledges.length) options.push({ kind: 'ledges', seconds: toEdge + hops * .8 + Math.max(0, flat(edge!, target) - hops * 2) / RUN })
  if (wall) options.push({ kind: 'blocks', seconds: toEdge + drop / 3 * 1.1 + flat(edge!, target) / RUN })
  if (!options.length) return { used: null, why: 'нет спуска', planMs: Math.round(performance.now() - t0) }
  const hopgoto = require('../hopgoto')
  // 0.4 с реального на A*: с блоками в рюкзаке поиск раздувается стройкой (try-descent wall: таймаут 1 с = ~235 игровых
  // тиков на lockstep 750, 20 тиков на 20 TPS); неполный путь оценивается (ниже), а не ждётся.
  const walk = await hopgoto.planWalk(bot, goal, { ms: opt.planMs ?? 400, abortIf: () => ctl.aborted })
  const speed = bot.pathfinder?.movements?.allowSprinting ? hopgoto.RUN : hopgoto.WALK
  // Путь не найден целиком за planMs (с блоками в рюкзаке A* раздувается стройкой) — не «бесконечно»: найденный кусок +
  // остаток до цели по прямой ×2 (обход); ничего — прямая ×3, как hopgoto.
  const tail = walk?.path?.length ? walk.path[walk.path.length - 1] : null
  const walkSec = walk && walk.status === 'success' ? hopgoto.pathSeconds(walk.path, me, { speed })
    : tail ? hopgoto.pathSeconds(walk.path, me, { speed }) + Math.hypot(tail.x - target.x, tail.y - target.y, tail.z - target.z) * 2 / speed
      : Math.hypot(me.x - target.x, me.y - target.y, me.z - target.z) * 3 / speed
  const planMs = Math.round(performance.now() - t0)
  options.sort((a, b) => a.seconds - b.seconds)
  const best = options[0]
  const line = `цель ниже на ${drop.toFixed(1)}; пешком ~${walkSec.toFixed(1)} с (${walk ? walk.status : 'пути нет'}); ` +
    options.map(o => `${o.kind} ~${o.seconds.toFixed(1)} с`).join(', ') + ` (план ${planMs} мс)`
  // Пеший путь почти по прямой (≤ 1.3 прямой + 2 с) — дальше по нему спуску выиграть нечего: сторож на этот goto не нужен.
  const efficient = walkSec <= 1.3 * Math.hypot(me.x - target.x, me.y - target.y, me.z - target.z) / speed + 2
  if (!best || walkSec - best.seconds < minGain) { log(line + ' — пешком'); return { used: null, why: best ? 'мал выигрыш' : 'нет спуска', walkSec, options, planMs, efficient } }
  log(line + ` — ${best.kind}`)
  try { bot.pathfinder?.setGoal(null) } catch {}
  const hp0 = bot.health ?? 20; const g1 = clock.now()
  let result: Record<string, unknown>
  if (best.kind === 'water' || best.kind.startsWith('soft')) result = await waterDrop(session, ctl, water!)
  else {
    const walked = await walkTo(bot, edge!, Math.max(4000, toEdge * 3000))
    if (!walked.ok) result = { why: 'edge: ' + walked.why }
    else if (ctl.aborted) result = { why: 'interrupted' }
    else if (best.kind === 'ledges') result = await ledgeHops(session, ctl, target, { maxFallDamage: flex })
    else result = await blockSteps(session, ctl, target)
  }
  // Игровые секунды: решение (A* пешего пути и прогнозы) и само исполнение спуска.
  const out = { used: best.kind, walkSec, options, planMs, decideSec: (g1 - g0) / 1000, execSec: (clock.now() - g1) / 1000, ...result, hpLost: Math.max(0, hp0 - (bot.health ?? 0)) }
  log(JSON.stringify(out))
  return out
}

/**
 * Сторож спуска на ходу (goto): раз в `every` тиков, на земле, сдвинувшись на `minMove`+ от прошлой проверки и не рядом с
 * местом, где уже решили «пешком», — если цель ниже на `minDrop`+ и в `near` бл. по горизонтали, а рядом есть готовый
 * вариант (вода/мягкое внизу с нативным прогнозом, уступ ≥ 2 или стена для блоков у края), — `fire()` один раз.
 * Решение (сравнение с пешим путём) — maybeDescend; «пешком» — `skip(pos)`, сторож туда не вернётся.
 */
export function watch(bot: any, goal: { x: number; y: number | null; z: number }, fire: () => boolean | void, { every = 40, minMove = 4, minDrop = 6, near = 96 }: { every?: number; minMove?: number; minDrop?: number; near?: number } = {}) {
  let ticks = 0; let due = false; let last: Vec3 | null = null; let fired = false; const skipped: Vec3[] = []
  const onTick = () => {
    if (fired) return
    if (++ticks % every === 0) due = true
    const e = bot.entity
    // Срок проверки — на ближайшем тике на земле: вприпрыжку тело в воздухе 12 тиков из 13, и проверка «ровно на
    // тике N» почти всегда пропускалась (s6c-desc-ridge4/5: 0 из 6).
    if (!due || !e || !e.onGround) return
    due = false
    if (e.isInWater || e.isInLava || (last && e.position.distanceTo(last) < minMove)) return
    last = e.position.clone()
    if (skipped.some(p => p.distanceTo(e.position) < 8)) return
    const gy = goal.y ?? surfaceY(bot, goal.x, goal.z, e.position.y)
    const target = { x: goal.x + .5, y: gy ?? 0, z: goal.z + .5 }
    if (gy == null || e.position.y - gy < minDrop || flat(e.position, target) > near) return
    const hp = bot.health ?? 20; const flex = hp >= 16 ? 2 : 0
    const edge = edgeNear(bot, target, { radius: 3 })
    const atEdge = edge && standingAt(bot, edge)
    const ready = !!(atEdge && (ledgeOptions(atEdge, target, { maxFallDamage: flex }).some(p => edge!.y - p.y >= 2) || (blockCount(bot) >= Math.ceil((e.position.y - gy) / 3) && wallStep(atEdge, target)))) ||
      !!findWaterDrop(bot, target, { budgetMs: 60, maxDamage: flex, waterRadius: 10 })
    if (ready) fired = fire() !== false // false — некому принять (между попытками): проверить снова
  }
  bot.on('physicsTick', onTick)
  return { stop: () => bot.removeListener('physicsTick', onTick), skip: (p: Vec3) => { skipped.push(p.clone()); fired = false; last = p.clone() } }
}

/** Верх колонны (x, z) под `fromY`: ноги на первом сверху твёрдом блоке; незагружено — null. */
export function surfaceY(bot: MovementBot, x: number, z: number, fromY: number): number | null {
  for (let y = Math.floor(fromY) + 8; y >= Math.floor(fromY) - 128; y--) {
    const b = bot.blockAt(new Vec3(Math.floor(x), y, Math.floor(z)), false)
    if (!b) return null
    if (containsWater(b)) return y
    const boxes = shapeBoxes(b)
    if (boxes.length) return Math.max(...boxes.map(s => s.maxY))
  }
  return null
}

export { landingDamage }
