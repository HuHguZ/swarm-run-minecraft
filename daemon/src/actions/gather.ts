'use strict'
// Добыча: дойти до блока, копка видимого (mine), подбор дропа, обзор новых мест (explore).
// ---------------------------------------------------------------- movement helpers
const gameClock: typeof import('../game-clock') = require('../game-clock')
const { goals }: typeof import('mineflayer-pathfinder') = require('mineflayer-pathfinder')
const Vec3: typeof import('vec3').Vec3 = require('vec3')
const { sleep, xyz, travelXZ }: typeof import('../movement') = require('../movement')
const { equipBestTool, missingHarvestTool, countItems, diffItems, resolveBlockIds }: typeof import('../items') = require('../items')
const { withTimeout, FACES }: typeof import('../build') = require('../build')
const { visibleOf }: typeof import('../sight') = require('../sight')
async function reachBlock (bot, block, ctl) {
  if (bot.canDigBlock(block)) return
  const p = block.position
  const attempts = [
    () => {
      const pick: typeof import('../pick') = require('../pick')
      const goal = new goals.GoalLookAtBlock(p, bot.world, { reach: 4, entityHeight: pick.eyeHeight(bot) })
      // Native LookAt measures feet to ABOVE the target, rejecting reachable upper logs.
      goal.isEnd = (node: any) => {
        const eye = node.floored().offset(.5, goal.entityHeight, .5)
        const distance = Math.hypot(...['x', 'y', 'z'].map(k => Math.max(p[k] - eye[k], 0, eye[k] - p[k] - 1)))
        return distance <= goal.reach && FACES.some(face => pick.faceAim(bot, p, face, { eye, range: goal.reach }))
      }
      return goal
    },
    () => new goals.GoalNear(p.x, p.y, p.z, 2)
  ]
  // Срок на подход к одному блоку: pathfinder на частичных путях топтался у бревна на кроне 240 с — весь бюджет mine (ферма
  // 14.10, тайга 3292227454314326185: g1-4 и g2-s1-2, «mine any_log 239.9 с timeout», сытость 20 → 13, рядом другие деревья).
  // Вышел срок — блок в недоступные (mine берёт следующий видимый), как при «No path».
  const budget = Math.round(8 + bot.entity.position.distanceTo(p))
  const until = gameClock.now() + budget * 1000
  let last = null
  for (const make of attempts) {
    if (ctl.aborted) return
    const left = until - gameClock.now()
    if (left <= 0) break
    try {
      await withTimeout(bot.pathfinder.goto(make()), left, `не подошёл за ${budget} с`)
      if (bot.canDigBlock(block)) return
    } catch (e) {
      last = e
      if (gameClock.now() >= until) { try { bot.pathfinder.setGoal(null) } catch {} }
    }
  }
  if (!bot.canDigBlock(block)) {
    throw new Error(`не могу подойти к ${block.name} на ${p.x},${p.y},${p.z}${last ? ': ' + last.message : ''}`)
  }
}

// Broken blocks drop an item entity that has to be walked over.
//
// Полный рюкзак: mineflayer в него не подбирает, и тело стояло над алмазом,
// считая «подошёл» за «подобрал». Теперь — освободить клетку под то, что
// дороже выбрасываемого (pack.js), а нечего выбросить — оставить лежать и
// сказать мозгу (событие bag_full: ставь схрон). Выброшенное не подбираем
// обратно в этом же заходе.
//
// 2026-09-29: сам поход — drops.collect (общий слой подбора). Прежний цикл читал
// позицию предмета один раз и шёл GoalBlock в её клетку:
// у летящего (бросок пиглина, дроп над головой) это точка появления в воздухе, у
// лежащего на плите — клетка плиты; «пути нет» обрывал весь подбор. Замер фермы
// (pickprobe): брошенное к телу — 0 из 16, после — 14–16 из 16.
async function collectNearbyDrops (bot, ctl, { radius = 6, timeoutMs = 8000, from = null, appearMs = 600, canContinue }: any = {}) {
  const pack: typeof import('../pack') = require('../pack')
  const drops: typeof import('../drops') = require('../drops')
  const tossedNames = new Set()
  const match = (e, stack) => {
    if (pack.ignoreDrop?.(bot, e)) return false
    if (tossedNames.size && stack && tossedNames.has(stack.name)) return false
    return true
  }
  // Полный рюкзак: освободить клетку под то, что дороже выбрасываемого (pack.js), а
  // нечего выбросить — оставить лежать и сказать мозгу (bag_full).
  const onStack = async (it) => {
    const stack = it.stack
    if (!stack || pack.fits(bot, stack.name, 1)) return 'go'
    const room = await pack.makeRoom(bot, { slots: 1, forItem: stack.name, away: it.e.position })
    for (const t of room.tossed) tossedNames.add(t.split('×')[0])
    if (!room.freed) {
      try { bot.emit('nd_bag_full', { item: stack.name, count: stack.count, at: new Vec3(it.rest.x, it.rest.y, it.rest.z).floored() }) } catch {}
      return 'skip'
    }
    try { bot.emit('nd_tossed', { tossed: room.tossed, forItem: stack.name }) } catch {}
    return 'go'
  }
  return drops.collect(bot, ctl, { radius, timeoutMs, from, appearMs, match, onStack, canContinue })
}

// ---------------------------------------------------------------- mine

// The cells under the body's 0.6-wide footprint: every block holding it up.
// 0.01 below the feet, so a body on a full block reads the block and one on a
// slab reads the slab.
function underFeet (bot) {
  const p = bot.entity.position
  const half = (bot.entity.width || 0.6) / 2
  const y = Math.floor(p.y - 0.01)
  const cells = []
  for (let x = Math.floor(p.x - half); x < p.x + half; x++) {
    for (let z = Math.floor(p.z - half); z < p.z + half; z++) cells.push(new Vec3(x, y, z))
  }
  return cells
}

// Блок под водой (сверху вода, трава или ламинария): со дна реки тело не
// достаёт — 2026-09-29 13:04 гравий для огнива, 150 с на плаву над травой.
const UNDERWATER = /^(water|bubble_column|seagrass|tall_seagrass|kelp|kelp_plant)$/
function underWater (bot, p) {
  const up = bot.blockAt(p.offset(0, 1, 0))
  return ((require('../movement') as typeof import('../movement')).waterBudgetOn?.() ?? false) ? (require('../movement') as typeof import('../movement')).waterCell?.(up) : !!up && UNDERWATER.test(up.name)
}

function priceResources (bot, candidates) {
  const prices = new Map<any, number>(candidates.map(b => [b, bot.entity.position.distanceTo(b.position) + ((require('../movement') as typeof import('../movement')).waterApproachCost?.(bot, b.position) ?? 0)]))
  return candidates.sort((a, b) => prices.get(a) - prices.get(b))
}

async function mine (session, ctl, { block: name, count = 1, radius = 32, fair, at = null, collect = true, dry = false, avoidPiglinAggro = false, minY = null }: any = {}) {
  const bot = session.bot
  const mcData = session.mcData
  const wantedIds = resolveBlockIds(name, mcData)
  const useFair = fair === undefined ? session.cfg.fairPlay : !!fair
  if (at && !['x', 'y', 'z'].every(k => Number.isInteger(at[k]))) throw new Error('at: нужны целые координаты x,y,z')
  const targetPos = at ? new Vec3(at.x, at.y, at.z) : null
  // Явная клетка — ровно один блок: её отсутствие не разрешает ломать соседей.
  if (targetPos) count = 1
  const plan = session.castPlan1
  const castSite = !targetPos && plan && (plan.dimension || 'overworld') === (bot.game?.dimension || 'overworld')
    ? (require('../cast1') as typeof import('../cast1')).siteCells1(plan) : null

  const before = countItems(bot)
  let dug = 0
  const misses = []
  // Куда не подойти — больше не брать в этом вызове. Раньше ближайший видимый
  // блок оставался ближайшим и после «No path»: три промаха подряд в одно и то
  // же бревно на макушке дерева, отказ, и кампания 2026-09-26 крутила mine →
  // explore («уже видно отсюда») десять раз за три секунды, а рядом стояли
  // другие деревья.
  const unreachable = new Set()
  let streak = 0

  // Reads dug and misses at call time, so one shape of report serves both the
  // ordinary ending and every stop half way through.
  const report = stopped => ({
    wanted: name,
    dug,
    gained: diffItems(before, countItems(bot)),
    problems: misses.length ? misses : undefined,
    skipped: unreachable.size || undefined,
    stopped: stopped || undefined
  })

  // Подбор одним заходом (S8c 07.10, скорость: брёвна ~7 с на штуку с подбором после каждого — s8b-c 72 с/прогон, земля на литьё
  // и камень — ещё ~90 с/прогон): дроп копится, пока следующий блок в 5 бл. от первого несобранного; дальше — подобрать и идти.
  // Руду (пещеры, лава рядом) — как прежде, после каждого блока. ND_MINE_BATCH=0 — после каждого всегда.
  const batch = collect && count > 1 && !/_ore|ore$|debris/.test(String(name)) && process.env.ND_MINE_BATCH !== '0'
  let pendingAt = null
  const flush = async () => { if (pendingAt) { const at = pendingAt; pendingAt = null; await collectNearbyDrops(bot, ctl, { from: at, radius: 7, timeoutMs: 9000 }) } }
  while (dug < count && !ctl.aborted) {
    // Never a block the body is standing on. findBlocks sorts by distance from
    // the feet cell and, within a section, walks x, then y, then z — so of the
    // blocks one away the floor under the feet comes first. And a refusal of
    // the staircase over a cave names «mc_mine block=stone_like» as the way to
    // get blocks to prop with (2026-09-15): its first swing would have dropped
    // the body into the very cave it was fetching blocks to cross.
    const floor = underFeet(bot)
    // Fog of war: only blocks actually in line of sight are fair game. Отсечка
    // по числу — ПОСЛЕ зрения (sight.visibleOf): findBlocks count 40 на лугу
    // брал сорок клеток камня под дёрном, луч не доходил ни до одной, и камень
    // на склоне рядом был «не вижу stone в радиусе 32» (кампания 2026-09-25).
    // Блок с лавой сверху или сбоку не брать: выкопанная клетка — дорога лаве,
    // и она течёт на того, кто стоит рядом с киркой. Кампания 2026-09-26:
    // «камень» у спавна на краю лавы, «tried to swim in lava». Лава снизу не
    // течёт вверх — такой блок можно.
    const lavaBeside = p => [[0, 1, 0], [1, 0, 0], [-1, 0, 0], [0, 0, 1], [0, 0, -1]].some(([dx, dy, dz]) => {
      const n = bot.blockAt(p.offset(dx, dy, dz))
      return !!n && n.name === 'lava'
    })
    const visible = visibleOf(bot, wantedIds, radius, {
      max: 12,
      fair: useFair,
      // minY — не ниже этой высоты (земля для вышки обзора: без ямы под собой, owC2-09: 10 земли — тело в яме на 5 ниже, обзор сорван).
      skip: p => (targetPos && !targetPos.equals(p)) || floor.some(f => f.equals(p)) || (Number.isFinite(minY) && p.y < minY) ||
        castSite?.has(`${p.x},${p.y},${p.z}`) ||
        unreachable.has(`${p.x},${p.y},${p.z}`) || lavaBeside(p) || (dry && underWater(bot, p))
    })

    if (!visible.length) {
      if (dug === 0) {
        throw new Error(`не вижу ${name} в радиусе ${radius}${useFair ? ' (смотрю честно, только по прямой видимости)' : ''}`)
      }
      break
    }

    if (((require('../movement') as typeof import('../movement')).waterBudgetOn?.() ?? false)) priceResources(bot, visible)
    const target = visible[0]
    if (pendingAt && target.position.distanceTo(pendingAt) > 5) await flush()
    const problem = missingHarvestTool(bot, target, mcData)
    if (problem) {
      // Refusing up front is the whole point of this check and the tool
      // description promises it by name — but only while nothing has been dug
      // yet. After the first block the same throw took `dug` and `gained` with
      // it, and a bag that had grown by eight iron ore reached the brain as
      // `failed` with no numbers in it at all. The next block needing a better
      // pickaxe is a reason to stop, not a reason to forget the previous eight.
      if (dug === 0) throw new Error(problem)
      await flush()
      return report(problem)
    }

    try {
      // The campaign's cautious ore variant pays for another look after walking
      // and hand swaps. Block.playerWillDestroy angers adults in the player's
      // AABB inflated by 16, with requireLineOfSight=false (native 1.21.11).
      // Only visible adults affect this choice; ordinary mine keeps its variant.
      const piglinRisk = () => {
        if (!avoidPiglinAggro || !/^(nether_gold_ore|gilded_blackstone)$/.test(target.name)) return false
        const me = bot.entity.position
        const baby = bot.registry.entitiesByName.piglin.metadataKeys.indexOf('baby')
        return (Object.values(bot.entities || {}) as any[]).some(e => {
          if (!e || e.name !== 'piglin' || !e.position || e.isValid === false || e.metadata?.[baby]) return false
          const half = ((bot.entity.width || 0.6) + (e.width || 0.6)) / 2
          if (Math.abs(e.position.x - me.x) >= 16 + half || Math.abs(e.position.z - me.z) >= 16 + half ||
              e.position.y + (e.height || 1.95) <= me.y - 16 || e.position.y >= me.y + (bot.entity.height || 1.8) + 16) return false
          return (require('../bastion/predict-gold') as typeof import('../bastion/predict-gold')).rayClear((require('../drops') as typeof import('../drops')).blockGetter(bot),
            me.offset(0, bot.entity.eyeHeight || 1.62, 0), e.position.offset(0, (e.height || 1.95) * 0.6, 0))
        })
      }
      await reachBlock(bot, target, ctl)
      if (ctl.aborted) break
      if (piglinRisk()) return report('виден взрослый пиглин в зоне злости — осторожную копку золота остановил')
      await equipBestTool(bot, target)
      if (ctl.aborted) break
      if (piglinRisk()) return report('виден взрослый пиглин в зоне злости — осторожную копку золота остановил')
      await bot.dig(target, true)
      dug++
      streak = 0
      if (batch) { if (!pendingAt) pendingAt = target.position.clone() } else if (collect) await collectNearbyDrops(bot, ctl)
    } catch (err) {
      misses.push(err.message)
      streak++
      // Не дошёл — следующий видимый; не докопал (блок на месте, дошёл) — тоже
      // не этот: второй заход в тот же блок кончается тем же.
      const tp = target.position
      unreachable.add(`${tp.x},${tp.y},${tp.z}`)
      if (streak >= 3) {
        // Same split as the tool check above: three misses in a row is the end of
        // this call either way, but only an empty tally deserves to be an error.
        const why = `не смог добыть ${name}: ${misses[misses.length - 1]}`
        if (dug === 0) throw new Error(why)
        await flush()
        return report(why)
      }
    }
  }

  if (!ctl.aborted) await flush()
  return report(ctl.aborted ? 'прервано' : null)
}

// ---------------------------------------------------------------- explore

const COMPASS = {
  east: [1, 0], west: [-1, 0], south: [0, 1], north: [0, -1],
  восток: [1, 0], запад: [-1, 0], юг: [0, 1], север: [0, -1]
}
const SWEEP = [[1, 0], [0, 1], [-1, 0], [0, -1], [1, 1], [-1, 1], [1, -1], [-1, -1]]

// Ближайший видимый. Отсечка count 12 стояла ДО зрения, и explore stone с луга
// не находил склон никогда: двенадцать ближних клеток камня — под дёрном.
// dry — без блоков под водой (см. underWater).
function firstVisible (bot, ids, radius, useFair, dry = false, skip = null) {
  const candidates = visibleOf(bot, ids, radius, { max: ((require('../movement') as typeof import('../movement')).waterBudgetOn?.() ?? false) ? 12 : 1, fair: useFair, ...((dry || skip) ? { skip: p => (dry && underWater(bot, p)) || !!skip?.(p) } : {}) })
  if (((require('../movement') as typeof import('../movement')).waterBudgetOn?.() ?? false)) priceResources(bot, candidates)
  return candidates[0] || null
}

// Walk around until the thing we want comes into view. Returns partial
// progress when it runs out of time instead of failing, so the brain can just
// call it again — one call is one leg of a search, not an all-or-nothing trip.
async function explore (session, ctl, {
  block = 'any_log', radius = 48, stepDistance = 40, direction = null, timeoutSeconds = 45, fair, dry = false, surface = false, lavaSource = false, waterSource = false, unlootedContainers = false, newView = false
}: any = {}) {
  const bot = session.bot
  const ids = resolveBlockIds(block, session.mcData)
  const useFair = fair === undefined ? session.cfg.fairPlay : !!fair
  const from = xyz(bot.entity.position)
  const deadline = gameClock.now() + Math.min(280, timeoutSeconds) * 1000
  // Resource scouting has already inspected these containers through real loot;
  // ordinary explicit exploration may still revisit them.
  const looted = new Set(unlootedContainers ? session.journal?.state?.looted || [] : [])
  const skipLooted = (p, name = bot.blockAt(p)?.name) => looted.has(`${p.x},${p.y},${p.z}`) && ['chest', 'trapped_chest', 'barrel'].includes(name)
  // After failed mining, the same remote visible material is not another view.
  // Keep only what this bounded sight call actually observed, never hidden cells.
  const viewFrom = newView ? bot.entity.position.clone() : null
  const seenHere = new Set(newView ? visibleOf(bot, ids, radius, { max: Infinity, fair: useFair,
    skip: p => (dry && underWater(bot, p)) || (unlootedContainers && skipLooted(p)) }).map(b => posKey(b.position)) : [])
  const skipSeen = p => newView && seenHere.has(posKey(p)) &&
    !(bot.canDigBlock(bot.blockAt(p)) && (require('../pick') as typeof import('../pick')).blockSeen(bot, p))
  // Ведру нужен источник: текущая вода «уже видно отсюда» при «источника не вижу» у bucket гоняла этап воды по кругу (cl-c 14.10).
  const notSource = p => waterSource && !(require('../obsidian') as typeof import('../obsidian')).isSource(bot.blockAt(p), 'water')
  const findHit = () => {
    if (newView && (ctl.aborted || bot.entity.position.equals(viewFrom))) return null
    return lavaSource ? ((require('../cast') as typeof import('../cast')).lavaSources(bot)[0] || null)
      : firstVisible(bot, ids, radius, useFair, dry,
        (unlootedContainers || newView || waterSource) ? p => (unlootedContainers && skipLooted(p)) || skipSeen(p) || notSource(p) : null)
  }

  let hit = findHit()
  if (hit) return { found: hit.name, at: xyz(hit.position), walked: 0, note: 'уже видно отсюда' }
  // A newly placed roof can be confirmed before the client skylight update arrives.
  if (surface && (require('../worlds') as typeof import('../worlds')).worldOf(bot) === 'overworld' && !ctl.aborted && deadline - gameClock.now() >= 10000 &&
    (!session.underSky?.() || (require('../fortify') as typeof import('../fortify')).enclosure(bot, bot.entity.position.floored()).sealed)) {
    await (require('../survival') as typeof import('../survival')).surface(session, ctl, { timeoutSeconds: Math.min(30, (deadline - gameClock.now()) / 1000), hand: false, preferPillar: true })
    // 30 с не хватило (карман под крышей своей лестницы: «поднялся на 6», до неба 2 блока — cl-n 14.10) — ещё подъём на остаток.
    if (!ctl.aborted && typeof session.underSky === 'function' && !session.underSky() && deadline - gameClock.now() >= 10000) {
      await (require('../survival') as typeof import('../survival')).surface(session, ctl, { timeoutSeconds: Math.min(30, (deadline - gameClock.now()) / 1000), hand: false, preferPillar: true })
    }
    hit = findHit()
    if (hit) return { found: hit.name, at: xyz(hit.position), from, now: xyz(bot.entity.position), note: 'увидел после выхода наверх' }
  }

  const legs = []
  let i = 0
  // Память увиденного (perception/eyes, S10): блок, который тело видело раньше (с прошлого отрезка, за спиной, другим
  // навыком), — сперва к нему, потом снова взгляд. Ближе 6 бл. и уже пробованные в этом вызове — мимо. ND_EXPLORE_MEM=0 — без.
  const memTried = new Set()
  const remembered = () => {
    if (!useFair || !bot._ndEyes || process.env.ND_EXPLORE_MEM === '0') return null
    const names = ids.map(id => session.mcData.blocks[id] && session.mcData.blocks[id].name).filter(Boolean)
    const me = bot.entity.position
    return (require('../perception/eyes') as typeof import('../perception/eyes')).nearest(bot, names, { max: 8, maxDist: Math.max(radius * 2, 96) })
      .find(m => !memTried.has(`${m.x},${m.y},${m.z}`) && (!newView || !seenHere.has(posKey(m))) && !skipLooted(m, m.name) && Math.hypot(m.x - me.x, m.z - me.z) > 6 && !(dry && underWater(bot, new Vec3(m.x, m.y, m.z)))) || null
  }
  // Разведка из-под неба верхнего мира — поверху (session.underSky,
  // underRoofCost): отрезок «по прямой» иначе уходил в пещеры.
  const walkTop = (surface && (require('../worlds') as typeof import('../worlds')).worldOf(bot) === 'overworld') || (typeof session.underSky === 'function' && session.underSky())
  // Слой C грузится только под флагом: песочницы тестов explore (vm с заглушками) без него.
  const sw = walkTop && process.env.ND_OW_SURFACE_WALK === '1' ? (require('../session/surface-walk') as typeof import('../session/surface-walk')) : null
  const surfaceScope = sw ? sw.startSurfaceWalk(bot) : null
  const stopSurface = () => sw?.stopSurfaceWalk(bot, surfaceScope)
  ctl.onAbort?.push(stopSurface)
  try {
  const walk = async (x, z, options): Promise<any> => {
    session.surfaceWalk = walkTop
    session.scoutFromY = walkTop && bot.entity ? bot.entity.position.y : null
    const mv = bot.pathfinder.movements
    const dug = mv ? mv.canDig : undefined
    const scaffold = mv ? mv.scafoldingBlocks : undefined
    if (walkTop && mv) { mv.canDig = false; mv.scafoldingBlocks = [] }
    // ND_GRAPH2_EXPLORE_NODIG=1 (поток graph2 sr27, выкл.): в Аду разведка (стебли, камень кирки, эндермены) — взгляд по открытому, а не
    // копка pathfinder'ом сквозь незерак к точке луча: AcquireNetherTools ел 16 % взмахов Ада (7.2 тыс. на 127 прогонов sr27), ища дерево
    // на кирки. Нет пути без копки — следующий луч.
    const noDig = !walkTop && !!mv && process.env.ND_GRAPH2_EXPLORE_NODIG === '1' && (require('../worlds') as typeof import('../worlds')).worldOf(bot) === 'the_nether'
    if (noDig) mv.canDig = false
    try {
      const result = await travelXZ(bot, ctl, x, z, { ...options, retries: 1, deadline })
      if (result.surfaceDrop && sw) return { ...result, recovered: await sw.recoverSurface(session, ctl, deadline) }
      return result
    }
    finally {
      session.surfaceWalk = false
      session.scoutFromY = null
      if (walkTop && mv) { mv.canDig = dug; mv.scafoldingBlocks = scaffold }
      if (noDig) mv.canDig = dug
    }
  }
  let failStreak = 0
  let failFrom = null
  let escaped = false
  // Своя запертая клетка (коробка тактики): поверху без копки из неё пути нет ни в одну сторону (cl-j 14.10: 22 мин «пути нет»).
  if (walkTop) await (require('../fortify') as typeof import('../fortify')).leaveSealedCell(session, ctl, null)
  if (block === 'any_log' && process.env.ND_OW_DESERT_LOOK === '1') {
    const look = await (require('./desert') as typeof import('./desert')).desertTreeLook(session, ctl, walk, deadline)
    if (look?.stopped) return { found: null, from, now: xyz(bot.entity.position), legs, note: look.stopped }
    if (look?.tree && !ctl.aborted) {
      // A visible canopy supplies a direction, not a fictitious log. Approach, then re-observe.
      const tree = look.tree
      await walk(tree.pos.x, tree.pos.z, { range: 6 })
      hit = findHit()
      if (hit) return { found: hit.name, at: xyz(hit.position), from, now: xyz(bot.entity.position), legs, note: 'desert: visible tree approached' }
      legs.push(`desert canopy ${tree.name} ${tree.pos.x},${tree.pos.z}; raised ${look.raised}`)
    }
  }
  while (gameClock.now() < deadline && !ctl.aborted) {
    const mem = remembered()
    if (mem) {
      memTried.add(`${mem.x},${mem.y},${mem.z}`)
      const r = await walk(mem.x, mem.z, { y: surfaceScope ? null : mem.y, range: 4 })
      if (r.surfaceDrop && !r.recovered) return { found: null, from, now: xyz(bot.entity.position), legs, note: r.error }
      legs.push(`память ${mem.name} ${mem.x},${mem.y},${mem.z}${r.ok ? '' : ' ✗ ' + r.error}`)
      console.log('[eyes] explore: к увиденному раньше', JSON.stringify({ name: mem.name, at: [mem.x, mem.y, mem.z], dist: mem.dist, ago: mem.ago, ok: !!r.ok }))
      if (!r.ok) await sleep(250)
      hit = findHit()
      if (hit) return { found: hit.name, at: xyz(hit.position), from, now: xyz(bot.entity.position), legs, note: 'видел раньше — подошёл' }
      continue
    }
    const [dx, dz] = direction && COMPASS[direction] ? COMPASS[direction] : SWEEP[i % SWEEP.length]
    const spread = direction ? i + 1 : 1 + Math.floor(i / SWEEP.length)
    const here = from // Rays share an origin; relative rays return to the start after east/south/west/north.
    // И без копки: разведка — это взгляд с поверхности, а не штрек сквозь
    // гору (session.goto surface:'strict'). Нет пути поверху — следующий луч.
    const r = await walk(here.x + dx * stepDistance * spread, here.z + dz * stepDistance * spread, { range: 6 })
    if (r.surfaceDrop && !r.recovered) return { found: null, from, now: xyz(bot.entity.position), legs, note: r.error }
    legs.push(`${dx},${dz}${r.ok ? '' : ' ✗ ' + r.error}`)
    i++
    // S8d (S9: explore на льду — 551 noPath за прогон, каждый отрезок отказывал сразу, цикл крутил стороны до срока): все 8 сторон
    // подряд без пути и тело на месте (< 3 бл.) — отказ отсюда, разведку решает вызвавший (другая цель/место). ND_EXPLORE_STUCK=0 — прежнее.
    if (!r.ok) {
      if (!failFrom) failFrom = bot.entity.position.clone()
      if (++failStreak >= SWEEP.length && bot.entity.position.distanceTo(failFrom) < 3 && process.env.ND_EXPLORE_STUCK !== '0') {
        // Поверху без копки ни шагу (карман своей лестницы под крышей, верх столба — cl-l/cl-n 14.10: 5–35 мин на месте, потом
        // смерть): один короткий отрезок с копкой — выйти из кармана, как игрок прокапывает выход; не вышло — отказ, как раньше.
        if (walkTop && !escaped && !ctl.aborted && deadline - gameClock.now() > 5000) {
          escaped = true
          const [ex, ez] = direction && COMPASS[direction] ? COMPASS[direction] : SWEEP[0]
          const was = bot.entity.position.clone()
          const out = await travelXZ(bot, ctl, was.x + ex * 12, was.z + ez * 12, { range: 3, retries: 1, deadline })
          legs.push(`выход с копкой ${ex},${ez}${out && out.ok ? '' : ' ✗ ' + (out && out.error)}`)
          if (bot.entity.position.distanceTo(was) >= 3) { failStreak = 0; failFrom = null; continue }
        }
        return { found: null, from, now: xyz(bot.entity.position), legs, stuck: true, note: `пути нет ни в одну из ${SWEEP.length} сторон отсюда — смени место или цель` }
      }
    } else { failStreak = 0; failFrom = null }
    // Отрезок отказал сразу (в воде без пути из неё: escapeWater и travelXZ возвращаются без единого таймера) — цикл крутился
    // одними микрозадачами: игровые часы не шли, срок не наступал, пакеты и keepalive не обрабатывались, память росла
    // (s5c-f4-4 06.10: демон 100 % CPU и 2.7 ГБ 12+ мин, профиль — explore → firstVisible; сервер: Disconnected). Пауза
    // игрового тика после отказа отдаёт цикл событий.
    if (!r.ok) await sleep(250)

    hit = findHit()
    if (hit) {
      return { found: hit.name, at: xyz(hit.position), from, now: xyz(bot.entity.position), legs }
    }
  }

  return {
    found: null,
    from,
    now: xyz(bot.entity.position),
    legs,
    note: 'не нашёл за отведённое время — позови ещё раз, поиск продолжится с текущего места'
  }
  } finally {
    stopSurface()
    const off = ctl.onAbort?.indexOf(stopSurface) ?? -1
    if (off >= 0) ctl.onAbort.splice(off, 1)
  }
}
const posKey = p => `${p.x},${p.y},${p.z}`

export { reachBlock, collectNearbyDrops, mine, explore, posKey }
