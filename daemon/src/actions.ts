'use strict'
const gameClock = require('./game-clock')
const { goals } = require('mineflayer-pathfinder')
const Vec3 = require('vec3')
const { sleep, xyz, travelXZ } = require('./movement')
const {
  GROUPS, equipBestTool, missingHarvestTool, itemNamed, itemMatching,
  countItems, countOf, diffItems, resolveBlockIds, toolBudget, toolShortfall, toolStatus,
  bestOfKind, plankCount, spendablePlanks, planksPerCraft,
  SWINGS_PER_LEVEL, TABLE_PLANKS
} = require('./items')
const { withTimeout, placeBlockAt, pickFiller, FACES } = require('./build')
const { visibleOf } = require('./sight')

// ---------------------------------------------------------------- movement helpers

async function reachBlock (bot, block, ctl) {
  if (bot.canDigBlock(block)) return
  const p = block.position
  const attempts = [
    () => {
      const pick = require('./pick')
      const goal = new goals.GoalLookAtBlock(p, bot.world, { reach: 4, entityHeight: pick.eyeHeight(bot) })
      // Native LookAt measures feet to ABOVE the target, rejecting reachable upper logs.
      goal.isEnd = node => {
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
  const pack = require('./pack')
  const drops = require('./drops')
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
  return (require('./movement').waterBudgetOn?.() ?? false) ? require('./movement').waterCell?.(up) : !!up && UNDERWATER.test(up.name)
}

function priceResources (bot, candidates) {
  const prices = new Map<any, number>(candidates.map(b => [b, bot.entity.position.distanceTo(b.position) + (require('./movement').waterApproachCost?.(bot, b.position) ?? 0)]))
  return candidates.sort((a, b) => prices.get(a) - prices.get(b))
}

async function mine (session, ctl, { block: name, count = 1, radius = 32, fair, at = null, collect = true, dry = false, avoidPiglinAggro = false }: any = {}) {
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
    ? require('./cast1').siteCells1(plan) : null

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
      skip: p => (targetPos && !targetPos.equals(p)) || floor.some(f => f.equals(p)) ||
        castSite?.has(`${p.x},${p.y},${p.z}`) ||
        unreachable.has(`${p.x},${p.y},${p.z}`) || lavaBeside(p) || (dry && underWater(bot, p))
    })

    if (!visible.length) {
      if (dug === 0) {
        throw new Error(`не вижу ${name} в радиусе ${radius}${useFair ? ' (смотрю честно, только по прямой видимости)' : ''}`)
      }
      break
    }

    if ((require('./movement').waterBudgetOn?.() ?? false)) priceResources(bot, visible)
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
          return require('./bastion/predict-gold').rayClear(require('./drops').blockGetter(bot),
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

// ---------------------------------------------------------------- dig down

// Stone does not lie around on the surface; getting to it means going down.
// Straight down is how players die to lava, so check two blocks ahead before
// every swing and refuse rather than gamble.
async function digDown (session, ctl, p: any = {}) {
  // A staircase is a different shape of the same intent, so it lives behind
  // the same tool rather than a thirty-fifth one the brain has to learn.
  if (p.mode === 'stairs' || p.mode === 'лестница') return digStairs(session, ctl, p)
  const { depth = 5, maxFallHp = 0 } = p
  const bot = session.bot
  const mcData = session.mcData
  const before = countItems(bot)
  let dug = 0
  const drops = []
  // Health this call has already paid for drops out of maxFallHp.
  let spent = 0
  // The shaft is a column the mob drops into from above or walks into from the
  // cave it breaks; the guard's faces are the cell over the head and that mouth.
  const guard = descentGuard(session, { again: 'mc_dig_down mode=shaft' })
  const finish = (stopped, ledge?: any) => finishDig(bot, ctl, before, dug, stopped, { drops, ledge, guard })
  // Its own deadline, the way digStairs has had one all along. Without it the
  // shaft could only ever be stopped from outside by runIntent, and until today
  // that path answered `timeout` with no detail at all: the blocks were dug and
  // the report was thrown away. session.js hands down the very number it
  // budgeted the intent with and keeps twenty seconds more for itself, so
  // stopping here is the normal ending and the brain gets numbers rather than a
  // bare clock. The fallback repeats session.js's formula for a direct call.
  const deadline = gameClock.now() + Math.max(10, Math.min(600,
    p.budgetSeconds ?? p.timeoutSeconds ?? (25 + Math.max(1, Math.min(128, depth)) * 4))) * 1000

  for (let i = 0; i < depth && !ctl.aborted; i++) {
    if (gameClock.now() >= deadline) {
      return finish(`время вышло на ${dug}-м блоке`)
    }
    // Before the swing: a swing is seconds and the answer to a mob is a block.
    const alarm = await guard.check()
    if (alarm) return finish(alarm)
    const feet = bot.entity.position.floored()
    const below = bot.blockAt(feet.offset(0, -1, 0))
    const under = bot.blockAt(feet.offset(0, -2, 0))
    if (!below) break
    if (below.name === 'bedrock') break

    if (under && /lava/.test(under.name)) {
      return finish('под ногами лава — дальше не копаю')
    }
    if (under && under.name === 'water') {
      return finish('под ногами вода — дальше не копаю')
    }
    // A cave two below used to be a flat «дальше не копаю», and on the run of
    // 2026-09-15 that sentence ended the whole trip at y=1 with the floor five
    // blocks down for two points out of eighteen. The same verdict the staircase
    // uses decides it now: a free drop is taken, a paid one only when the call
    // said how much it will pay, and the refusal names that parameter.
    let jump = null
    if (under && under.boundingBox === 'empty') {
      const deeper = bot.blockAt(feet.offset(0, -3, 0))
      if (deeper && deeper.boundingBox === 'empty') {
        const verdict: any = judgeDrop(session, bot, feet, groundUnder(bot, feet, 32, [below.position]),
          maxFallHp, spent, 'mc_dig_down mode=shaft')
        if (!verdict.ok) {
          // A retry is a way on only while it is one: lava, a bottomless cave
          // and a price no health can pay name no call, and the shaft used to
          // stop right there, on a sentence with nothing to do in it.
          const out = verdict.retry ? null : shaftWayOut(bot, feet, verdict.fall)
          return finish(`под ногами пустота (пещера) — ${verdict.text}${out ? `; ${out.text}` : ''}`,
            { at: xyz(feet), mode: 'shaft', ...dropFields(verdict), ...(out ? out.fields : {}) })
        }
        jump = { verdict, hp: bot.health ?? 20 }
      }
    }

    const problem = missingHarvestTool(bot, below, mcData)
    if (problem) return finish(problem)

    await equipBestTool(bot, below)
    await bot.dig(below)
    dug++
    if (!jump) {
      await sleep(450) // let the body drop into the hole before the next swing
      continue
    }
    await settleFall(bot, ctl, feet.y, jump.verdict.fall)
    const fell = feet.y - bot.entity.position.floored().y
    if (fell > 0) spent += recordDrop(drops, bot, feet, fell, jump)
  }

  return finish(null)
}

async function finishDig (bot, ctl, before, dug, stopped, { drops = [], ledge = null, guard = null }: any = {}) {
  await collectNearbyDrops(bot, ctl, { radius: 4, timeoutMs: 4000 })
  return {
    dug,
    gained: diffItems(before, countItems(bot)),
    depth: xyz(bot.entity.position),
    drops: drops.length ? drops : undefined,
    ...(guard ? guard.report() : {}),
    ledge: ledge || undefined,
    stopped: stopped || undefined
  }
}

// ---------------------------------------------------------------- stairs

const STAIR_DIRS = {
  north: [0, -1], south: [0, 1], east: [1, 0], west: [-1, 0],
  север: [0, -1], юг: [0, 1], восток: [1, 0], запад: [-1, 0]
}

// Which cardinal the body is actually facing. Matches mineflayer's own lookAt
// maths (yaw 0 is north), so "no direction given" means "carry on the way I am
// already pointed" rather than an arbitrary axis.
function facingDir (bot) {
  const yaw = bot.entity.yaw
  const x = -Math.sin(yaw)
  const z = -Math.cos(yaw)
  return Math.abs(x) >= Math.abs(z) ? [Math.sign(x) || 1, 0] : [0, Math.sign(z) || 1]
}

function dirName (dir) {
  for (const [name, v] of (Object.entries(STAIR_DIRS) as [string, any][])) {
    if (/[a-z]/.test(name) && v[0] === dir[0] && v[1] === dir[1]) return name
  }
  return `${dir[0]},${dir[1]}`
}

// Same "feel the heat" probe digDown uses, applied to a whole step. It looks
// through solid stone, which is only ever allowed to REFUSE a dig — never to
// find anything.
const AROUND_CELL = [[0, 0, 0], [1, 0, 0], [-1, 0, 0], [0, 0, 1], [0, 0, -1], [0, 1, 0], [0, -1, 0]]

function hazardAt (bot, cells) {
  for (const c of cells) {
    for (const [dx, dy, dz] of AROUND_CELL) {
      const b = bot.blockAt(c.offset(dx, dy, dz))
      if (!b) continue
      if (/lava/.test(b.name)) return `лава у ${c.x + dx},${c.y + dy},${c.z + dz}`
      if (b.name === 'water') return `вода у ${c.x + dx},${c.y + dy},${c.z + dz}`
    }
  }
  return null
}

// Vanilla fall damage, read out of paper-1.21.11.jar rather than remembered:
// LivingEntity.calculateFallDamage is floor(fall + 1e-6 - safe_fall_distance),
// safe_fall_distance 3, and armour does not enter into it. Three blocks are
// free, four cost one point, six cost three, thirteen cost ten. That arithmetic
// is why a drop is an ordinary move rather than a last resort — and also why a
// paid one is not decided here: only the brain knows whether three points are
// worth paying on the trip it is on, so it says so with maxFallHp.
const fallCost = d => Math.max(0, Math.floor(d) - 3)
const FREE_FALL = 3

// How far a body walking in at the level above `pos` falls before it stands
// again, or null when that is past the free drop. Floor d cells under `pos`
// means feet d lower than they started. The loop used to run to maxDrop + 1,
// and the fourth block is the one that costs a point: a «free» drop that took
// health without asking is exactly what maxFallHp exists to stop.
function floorBelow (bot, pos, maxDrop = FREE_FALL) {
  for (let d = 1; d <= maxDrop; d++) {
    const b = bot.blockAt(pos.offset(0, -d, 0))
    if (!b) return null
    if (/lava|water/.test(b.name)) return null
    if (b.boundingBox === 'block') return d
  }
  return null
}

const STAIR_DIR_LIST = [[1, 0], [-1, 0], [0, 1], [0, -1]]

// floorBelow answers «can I step down here for free» and is allowed to decide a
// step. This answers a different question — «how far is the ground at all» — and
// only ever goes into a sentence, so it may look as far as it likes. The
// distance is the entire difference between «дна не видно» and «до пола шесть
// блоков»: measured at y=-36, the cave floor lay well past the four cells
// floorBelow inspects, which is precisely why the free-drop rule never fired and
// the staircase went hunting for something to prop a block against instead.
//
// Returns how far the body would FALL from `from`, not the index of the block:
// feet in `from` land on top of the solid cell d below, so the fall is d - 1.
// `open` are cells the caller is about to cut: until today the staircase priced
// a jump through its own uncut step as «до пола 0 блоков».
function groundUnder (bot, from, maxDrop = 32, open: any = []) {
  const cut = p => open.some(o => o.x === p.x && o.y === p.y && o.z === p.z)
  for (let d = 1; d <= maxDrop; d++) {
    const at = from.offset(0, -d, 0)
    if (cut(at)) continue
    const b = bot.blockAt(at)
    if (!b) return null
    if (/lava/.test(b.name)) return { fall: d - 1, lava: true }
    if (/water/.test(b.name)) return { fall: d - 1, water: true }
    if (b.boundingBox === 'block') return { fall: d - 1, name: b.name }
  }
  return null
}

const blockWord = n => {
  const t = n % 100
  const u = n % 10
  if (t >= 11 && t <= 14) return 'блоков'
  return u === 1 ? 'блок' : u >= 2 && u <= 4 ? 'блока' : 'блоков'
}

function lavaNear (bot, cell) {
  for (const [dx, dy, dz] of AROUND_CELL) {
    const b = bot.blockAt(cell.offset(dx, dy, dz))
    if (b && /lava/.test(b.name)) return `лава у ${cell.x + dx},${cell.y + dy},${cell.z + dz}`
  }
  return null
}

// Level with the landing, not the whole column: the drift on the same run kept
// stopping for zombies five blocks under its floor, behind rock, and a mob
// that cannot reach the landing is no reason to stay on the ledge. Required
// here, not at the top: combat.js requires this module back.
const MOB_AT_LANDING = 5
// A zombie on a cave floor wanders off in about this long, or it does not and
// the second refusal says so with the same numbers.
const MOB_WAIT_SECONDS = 15
function mobAtLanding (bot, landing) {
  const { HOSTILES } = require('./combat')
  let best = null
  for (const e of ((Object.values(bot.entities || {}) as any[]) as any)) {
    if (!e || e === bot.entity || !e.position || !HOSTILES.has(e.name)) continue
    const dy = e.position.y - landing.y
    if (dy < -1 || dy > 2) continue
    const dist = Math.hypot(e.position.x - (landing.x + 0.5), e.position.z - (landing.z + 0.5))
    if (dist > MOB_AT_LANDING) continue
    if (!best || dist < best.dist) best = { who: e.name, dist: Math.round(dist * 10) / 10 }
  }
  return best
}

// Health a paid drop must leave standing. Not a number of its own: every long
// dig is interrupted the moment health crosses cfg.lowHealth (session.js,
// low_health), so a drop landing at or under it would reach the brain as
// «interrupted» instead of as the drop it paid for. One above that line.
function fallReserve (session) {
  const low = session && session.cfg && Number.isFinite(session.cfg.lowHealth) ? session.cfg.lowHealth : 8
  return low + 1
}

// A player's full bar. Health Boost could raise it; the bot never drinks one,
// and reading the ceiling low only refuses a jump, never pays for one.
const MAX_HEALTH = 20

// One verdict on «jump here?» for the staircase and the shaft alike, so the
// refusal and the jump can never disagree about the price. `from` is the cell
// the body falls out of, `call` the exact call that would come back and jump.
// ok means jump now: free drops always, paid ones only up to maxFallHp — a
// default that pays health nobody agreed to is a fall, not a move.
//
// maxFallHp is what the whole call may pay, not each drop: `spent` is what it
// already has. Per drop, one «9» said for one twelve-block cave would also buy
// every later drop of the same leg down to the reserve — eleven points taken
// on an agreement to nine.
function judgeDrop (session, bot, from, ground, maxFallHp, spent, call) {
  const hp = Math.round(bot.health ?? 20)
  const reserve = fallReserve(session)
  const pay = Math.max(0, Math.floor(Number(maxFallHp) || 0))
  const left = Math.max(0, pay - spent)
  const base = { hp, reserve, maxFallHp: pay, spent }
  if (!ground) {
    return { ...base, ok: false, drop: 'deep', text: 'дна не видно на 32 блока вниз — не прыгаю ни с каким maxFallHp' }
  }
  const fall = ground.fall
  const inBlocks = `в ${fall} ${fall % 10 === 1 && fall % 100 !== 11 ? 'блоке' : 'блоках'}`
  const toFloor = `до пола ${fall} ${blockWord(fall)}`
  if (ground.lava) return { ...base, ok: false, drop: 'lava', fall, text: `${inBlocks} внизу лава — не прыгаю` }
  if (ground.water) return { ...base, ok: false, drop: 'water', fall, text: `внизу вода ${inBlocks} — в воду вслепую не прыгаю` }
  const cost = fallCost(fall)
  const after = hp - cost
  const landing = from.offset(0, -fall, 0)
  const out = { ...base, fall, floor: ground.name, cost, after, landing: xyz(landing) }
  const hot = lavaNear(bot, landing)
  if (hot) return { ...out, ok: false, drop: 'hazard', text: `${toFloor}, но у места приземления ${hot} — не прыгаю` }
  if (cost === 0) return { ...out, ok: true, drop: 'free' }
  // A price no health can pay is not a price. «Подлечись» used to be said for
  // it too, with healTo = cost + reserve: 21 for fifteen blocks, 23 for
  // seventeen, and the named retry at full health came back with the same
  // refusal from the same spot (review of 2026-09-15). So no retry and no heal
  // target here — the caller names the moves that do exist instead.
  if (cost + reserve > MAX_HEALTH) {
    return {
      ...out,
      ok: false,
      drop: 'high',
      text: `${toFloor}, прыжок стоит ${cost} хп — даже с полными ${MAX_HEALTH} осталось бы ${MAX_HEALTH - cost}, ` +
        `а ниже ${reserve} не прыгаю ни с каким maxFallHp`
    }
  }
  // A paid drop lands short of full health in a cave nobody has lit, and on the
  // run it was meant for the cave floor had zombies on it. A mob at the landing
  // is part of the price, and not one maxFallHp can pay. The words name a wait
  // and a call, so the fields carry the same wait and the same call.
  const mob = mobAtLanding(bot, landing)
  if (mob) {
    return {
      ...out,
      ok: false,
      drop: 'mob',
      mob,
      waitSeconds: MOB_WAIT_SECONDS,
      retry: { maxFallHp: cost },
      text: `${toFloor}, но у места приземления ${mob.who} в ${mob.dist} бл. — прыгать к нему на ${after} хп не буду; ` +
        `подожди mc_wait seconds=${MOB_WAIT_SECONDS}, пока уйдёт, и зови ${call} maxFallHp=${cost}`
    }
  }
  if (after < reserve) {
    // Natural regeneration is a point per four seconds on a fed bar, which is
    // the only way this number turns into a jump without anyone's help.
    const healTo = cost + reserve
    const waitSeconds = Math.min(300, (healTo - hp) * 4)
    return {
      ...out,
      ok: false,
      drop: 'hurt',
      healTo,
      waitSeconds,
      retry: { maxFallHp: cost },
      text: `${toFloor}, прыжок стоит ${cost} хп, а у меня ${hp} — осталось бы ${after}, ` +
        `а ниже ${reserve} не прыгаю ни с каким maxFallHp; подлечись до ${healTo}: mc_eat, потом ` +
        `mc_wait seconds=${waitSeconds}, и зови ${call} maxFallHp=${cost}`
    }
  }
  if (cost > left) {
    const already = spent > 0 ? `; из maxFallHp=${pay} этого вызова ${spent} уже ушло на прыжки выше` : ''
    return {
      ...out,
      ok: false,
      drop: 'price',
      retry: { maxFallHp: cost },
      text: `${toFloor}, прыжок стоит ${cost} хп из ${hp} (останется ${after})${already}; ` +
        `прыгну, если позовёшь ${call} maxFallHp=${cost}`
    }
  }
  return { ...out, ok: true, drop: 'paid' }
}

// The machine half of a drop refusal: everything the words say, minus the words.
function dropFields (v) {
  const { ok, text, ...fields } = v
  return fields
}

// Wait out a fall the body has already started. Health is read a beat after
// landing: the server applies fall damage on the landing tick and update_health
// reaches us a packet later.
async function settleFall (bot, ctl, fromY, fall) {
  const until = gameClock.now() + 1500 + fall * 150
  while (gameClock.now() < until && !ctl.aborted) {
    if (bot.entity.onGround && bot.entity.position.floored().y < fromY) break
    await sleep(50)
  }
  await sleep(400)
}

// What a drop actually cost next to what it was priced at. The two disagreeing
// is either a mob hitting during the fall or fallCost being wrong, and only a
// report that carries both numbers can tell the brain which. Returns what the
// drop takes out of maxFallHp: the larger of the two, because a budget the
// brain set is a ceiling on health lost, whatever took it.
function recordDrop (drops, bot, feet, fell, jump) {
  const now = bot.health ?? 20
  const rec = {
    from: xyz(feet),
    to: xyz(bot.entity.position),
    fell,
    cost: jump.verdict.cost,
    paid: Math.max(0, Math.round(jump.hp - now)),
    hp: Math.round(now)
  }
  drops.push(rec)
  return Math.max(rec.cost, rec.paid)
}

// Can a staircase step be founded this way at all: something solid to land on,
// a free drop, or — when the bag holds something steady to build with — a face
// to place the step's support against. Nine blockAt calls and no digging,
// because it is asked about three directions the body never walked — and the
// only thing worth knowing about them is whether they are a different question
// or the same one. A direction that would need a prop in its open step cell is
// the same one: that is precisely what just failed here.
function canFootStep (bot, feet, dx, dz, canBuild = true) {
  const land = feet.offset(dx, -2, dz)
  const under = bot.blockAt(land)
  if (under && under.boundingBox === 'block') return true
  if (floorBelow(bot, feet.offset(dx, -1, dz), FREE_FALL) !== null) return true
  if (!canBuild) return false
  for (const f of FACES) {
    const ref = bot.blockAt(land.offset(f.x, f.y, f.z))
    if (ref && ref.boundingBox === 'block' && !/water|lava/.test(ref.name)) return true
  }
  return false
}

// Would a shaft actually start from this square? Advice that names a move the
// tool then refuses is the same class of lie this whole refusal exists to stop,
// so the question is asked with digDown-s own rules rather than assumed: solid
// underfoot, not bedrock, no lava or water one below, and not a cave already
// open two below. On the floor of a cave all of that holds — which is what
// makes the shaft the answer there — but on a one-block ledge over the void it
// does not, and then saying «копай колодец» would send the brain into a second
// refusal. Kept next to the branch it mirrors; if digDown changes, so does this.
// Asked for a call WITHOUT maxFallHp: over a cave the shaft starts on its own
// only when the drop into it is free.
function shaftStarts (bot, feet) {
  const below = bot.blockAt(feet.offset(0, -1, 0))
  if (!below || below.boundingBox !== 'block' || below.name === 'bedrock') return false
  const under = bot.blockAt(feet.offset(0, -2, 0))
  if (under && /lava|water/.test(under.name)) return false
  if (under && under.boundingBox === 'empty') {
    const deeper = bot.blockAt(feet.offset(0, -3, 0))
    if (deeper && deeper.boundingBox === 'empty') {
      const g = groundUnder(bot, feet, 32, [below.position])
      return !!g && !g.lava && !g.water && fallCost(g.fall) === 0 && !lavaNear(bot, feet.offset(0, -g.fall, 0))
    }
  }
  return true
}

// How many blocks to fetch before a staircase can cross a cave: a step over
// open cave places two and cuts the prop back out, one a level, and the levels
// are the cave's depth. Unknown depth counts as the 32 groundUnder looks.
function blocksToCross (fall) {
  return Math.min(64, Math.max(8, (Number.isFinite(fall) ? fall : 28) + 4))
}

// A shaft refusing over a cave used to stop on the refusal itself — «лава — не
// прыгаю», «дна не видно» — a sentence with no call in it (review of
// 2026-09-15). The way on from a square over a cave is the other mode of the
// same tool: a staircase steps onto rock beside the hole, or walks out over the
// cave on props. Asked with the staircase's own rules — canFootStep for a step
// that needs no blocks, and a prop needs only the floor under our own feet,
// which a shaft stands on by definition — so the call named here is not one
// the staircase refuses for the same reason.
function shaftWayOut (bot, feet, fall) {
  const bare = STAIR_DIR_LIST.find(d => canFootStep(bot, feet, d[0], d[1], false))
  if (bare) {
    const name = dirName(bare)
    return {
      text: `лесенке на ${name} есть куда ступить и без блоков: mc_dig_down mode=stairs direction=${name}`,
      fields: { stairs: name }
    }
  }
  const name = dirName(facingDir(bot))
  if (pickFiller(bot, { steady: true })) {
    return {
      text: `лесенка перейдёт пещеру на подпорках из сумки: mc_dig_down mode=stairs direction=${name}`,
      fields: { stairs: name }
    }
  }
  const need = blocksToCross(fall)
  return {
    text: `подмостить лесенку нечем: mc_mine block=stone_like count=${need} (по блоку на уровень над пещерой), ` +
      `потом mc_dig_down mode=stairs direction=${name}`,
    fields: { stairs: name, mine: need }
  }
}

// «не к чему прислонить блок» is true and useless: it names the physics and
// leaves the brain holding nothing. Measured on the descent that stopped at
// y=-36 — four directions tried, eight legs of the trip spent, zero steps cut,
// and 64 cobblestone plus a hundred deepslate in the bag the whole time. The bag
// was never the problem: a block needs a face to go on, and open cave has none.
//
// So the refusal answers the things that can actually be acted on: how far the
// ground is and what the fall would cost, whether another direction is a
// different question or the same one, and the move that does work here.
//
// It used to end on «Остаётся спрыгнуть, если цена выше по карману» — and no
// call jumped. On 2026-09-15 that sentence closed eight legs of the trip at y=1
// with the floor five blocks down for two points of eighteen: advice with no
// callable path is a dead end. The jump is now a parameter of this very call,
// and the sentence names it with its number; `ledge` carries the same facts for
// a caller that reads fields rather than Russian.
//
// Without blocks the prop is the move that is missing, not the direction: the
// floor under our feet is always a face for one. So an empty bag names the
// fetch and the same call after it — on a pillar with the price past any
// health, that is the only thing in the sentence that can be done.
function ledgeReport (bot, feet, dir, put, other, noFooting, verdict, { canBuild = true, call }: any = {}) {
  const parts = [`под ступенькой пусто (${put.reason})`, verdict.text]
  if (other) parts.push(`с другой стороны опора есть — зови лесенку с direction=${dirName(other)}`)
  else if (noFooting) parts.push('опоры нет ни с одной из четырёх сторон — перебирать направления бесполезно')
  else parts.push('опора тут есть, но блок не встал — можно позвать лесенку ещё раз с этого же места')
  const mine = canBuild ? undefined : blocksToCross(verdict.fall)
  if (mine) {
    parts.push(`подмостить нечем: mc_mine block=stone_like count=${mine} (по блоку на уровень над пещерой), потом снова ${call}`)
  }
  const shaft = shaftStarts(bot, feet)
  parts.push(shaft
    ? 'подо мной твёрдый пол: mc_dig_down mode=shaft копает вниз без подпорок'
    : 'колодцем отсюда тоже только прыжок — под ногами пустота через блок')
  if (!verdict.retry && !other && !shaft && !mine) parts.push('остаётся увести меня mc_goto к стене пещеры и звать лесенку оттуда')
  return {
    stopped: parts.join('; '),
    ledge: {
      at: xyz(feet),
      mode: 'stairs',
      direction: dirName(dir),
      why: put.reason,
      // Faces the server was asked for under the step and did not give, and the
      // prop if one went in first: the underside is placed on a reading of the
      // jar, and this is where a run finds out the reading was wrong.
      refused: put.refused && put.refused.length ? put.refused : undefined,
      prop: put.prop,
      ...dropFields(verdict),
      other: other ? dirName(other) : null,
      directionWontHelp: !!noFooting,
      mine,
      shaft
    }
  }
}

// One block forward on manual controls. Pathfinder re-plans the whole route for
// a single step, and with canDig on it digs its own detour straight out of the
// staircase we are cutting.
async function stepForward (bot, ctl, target, ms = 2500) {
  const deadline = gameClock.now() + ms
  const cx = target.x + 0.5
  const cz = target.z + 0.5
  const near = () => Math.hypot(bot.entity.position.x - cx, bot.entity.position.z - cz)
  try {
    await bot.lookAt(new Vec3(cx, bot.entity.position.y, cz), true)
    bot.setControlState('forward', true)
    while (gameClock.now() < deadline && !ctl.aborted && near() > 0.55) await sleep(60)
  } catch {
  } finally {
    try { bot.setControlState('forward', false) } catch {}
  }
  return near() < 0.95
}

// The cell the body stands in, taken from the block that holds it up rather
// than from where its centre happens to be. A body rests on any block its
// 0.6-wide hitbox overlaps, and after a step it often stops with the centre
// just past the edge of the step block: with prismarine-physics driven the way
// mineflayer drives it (review of 2026-09-15) it landed at 167.965 with 0.068
// of speed left and came to rest past 168.0. position.floored() then named the
// next column, whose floor is open cave, and the staircase planned its prop
// against nothing — 8 of 12 crossings of a 24-deep cave stopped part-way with
// 64 cobblestone in the bag. The hand-written test body stopped at exactly
// +0.300 and never showed it.
function standingCell (bot) {
  const pos = bot.entity.position
  const feet = pos.floored()
  const holds = c => { const b = bot.blockAt(c.offset(0, -1, 0)); return !!b && b.boundingBox === 'block' }
  if (holds(feet)) return feet
  const half = (bot.entity.width || 0.6) / 2
  let best = null
  for (let x = Math.floor(pos.x - half); x < pos.x + half; x++) {
    for (let z = Math.floor(pos.z - half); z < pos.z + half; z++) {
      if (x === feet.x && z === feet.z) continue
      const cell = new Vec3(x, feet.y, z)
      if (!holds(cell)) continue
      const area = (Math.min(pos.x + half, x + 1) - Math.max(pos.x - half, x)) *
        (Math.min(pos.z + half, z + 1) - Math.max(pos.z - half, z))
      if (area > 0 && (!best || area > best.area)) best = { cell, area }
    }
  }
  return best ? best.cell : feet
}

// Off a lip and into a drop that was priced on the column under the step — and
// down in that column. A body that walks off keeps 0.91 of its speed every tick
// in the air: measured with prismarine-physics, a twelve-block drop priced on
// column 161 came down on 162.227, and with the event loop busy it slid off
// that floor's edge too and paid 17 on a price of 9, landing at 3 hp (review of
// 2026-09-15). So: walk up short of the edge, let the glide die, step off from
// nearly a standstill, and on the first tick in the air turn round and push
// against the drift until it is gone. Air control is 0.02 a tick; a standing
// start leaves the lip at about 0.15, which that cancels in a few ticks and a
// fraction of a block. Returns false if the body never left the lip.
async function walkOff (bot, ctl, step, [dx, dz], fromY, ms = 4000) {
  const e = bot.entity
  const deadline = gameClock.now() + ms
  // How far the centre is past the face between the lip and the step cell. The
  // hitbox leaves the lip at +0.3.
  const face = dx > 0 ? step.x : dx < 0 ? -(step.x + 1) : dz > 0 ? step.z : -(step.z + 1)
  const past = () => e.position.x * dx + e.position.z * dz - face
  let left = false
  const airborne = () => (left = left || (!e.onGround && e.position.y < fromY - 0.01))
  const going = () => !ctl.aborted && gameClock.now() < deadline
  try {
    await bot.lookAt(new Vec3(step.x + 0.5, e.position.y + 1.6, step.z + 0.5), true)
    // Walking speed is 0.22 a tick and the glide after letting go about a
    // quarter of a block, so let go a tenth short of the face.
    bot.setControlState('forward', true)
    while (going() && !airborne() && past() < -0.1) await sleep(20)
    bot.setControlState('forward', false)
    const calm = gameClock.now() + 700
    while (going() && gameClock.now() < calm && !airborne() && Math.hypot(e.velocity.x, e.velocity.z) > 0.01) await sleep(20)
    if (!airborne()) {
      bot.setControlState('forward', true)
      while (going() && !airborne()) await sleep(20)
      bot.setControlState('forward', false)
    }
    if (!airborne()) return false
    const vx = e.velocity.x
    const vz = e.velocity.z
    if (Math.hypot(vx, vz) > 0.003) {
      await bot.look(Math.atan2(-vx, -vz), e.pitch, true)
      bot.setControlState('back', true)
      while (going() && !e.onGround && e.velocity.x * vx + e.velocity.z * vz > 0) await sleep(20)
    }
    return true
  } catch {
    return left
  } finally {
    try { bot.setControlState('forward', false) } catch {}
    try { bot.setControlState('back', false) } catch {}
  }
}

// placeBlockAt judges success by the square becoming solid, and a torch never
// is — so verify by name. Short leash on purpose: a torch that will not stick
// must never cost the descent.
async function placeTorch (bot, pos) {
  const lit = b => !!b && /torch/.test(b.name)
  if (lit(bot.blockAt(pos))) return true
  if (!itemNamed(bot, 'torch')) return false
  try {
    await placeBlockAt(bot, pos, { item: 'torch', timeoutMs: 1200 })
  } catch {}
  return lit(bot.blockAt(pos))
}

// ---------------------------------------------------------------- the guard on the way down

// The way down had no eyes, and try-diamond «вниз» of 2026-09-16 paid for it:
// the leg west from y=-7 came back with four damage events and 14 hp, the next
// leg took five more and was cut off by low_health, and the drift called right
// after met «zombie в 0.7 блоках впереди, вплотную». Nine hits on a body that
// kept swinging. Nothing in the staircase or the shaft ever asked about a mob,
// and dig_down is rightly not interrupted by damage (session.js: chip damage
// must not throw a descent away) — so between two autopilot turns nobody looked.
//
// The drift (mining.tunnel's watch) and the climb (survival.surface's watch)
// already answer this, and the answer here is theirs: look between swings, ask
// reach.reachOf whether the mob can actually get at us, close the way with
// blocks when it can, report it as scenery when it cannot, and stop with the
// reason and a call when the wall does not close. A radius instead of reachOf
// would stop the staircase for every zombie in every cave it passes over — the
// y=1 paralysis reach.js was written to end.
//
// Twelve blocks for the climb's reason (MOB_WATCH): reach.PATH_MAX is twelve
// cells, and a look before every swing sees anything further off arrive.
const GUARD_RADIUS = 12
// Per placement. A wall that works lands in a tenth of a second (survival.js,
// case з); what this bounds is a refused face, and placeBlockAt pays it once per
// usable face of the cell.
const GUARD_LEASH_MS = 1000
// Everything one alarm may spend before the answer is «не закрылся» — the
// climb's WALL_BUDGET_MS, measured there: past it the wall is not slow, it is
// not happening, and the body is standing still being hit.
const GUARD_WALL_MS = 2500
// What one call may spend on walls, counted both ways, the climb's WALL_LIMIT
// and WALL_BLOCKS: past them the walls are not closing anything.
const GUARD_WALLS = 4
const GUARD_BLOCKS = 10

// Where the wall goes. Not survival.wallOff, although it is the same move,
// because on a staircase down its column stands one step too low. Both its
// shapes put the blocks at OUR feet and head toward the mob, and a mob on a
// descent comes down the steps we just cut: the step behind has its tread level
// with our feet and its open cells one higher than ours. The feet cell toward it
// is that tread — rock — so wallOff places one block, leaves the step's upper
// cell open, and asks a ray (shutOut) whether that worked: «заслон не закрыл его
// (1 бл.)» over a walker the block did stop, and a clear line down the stairs
// for a skeleton.
//
// So the cells are found from our own air rather than from our height: the open
// cells touching the column the body stands in — feet, head, and the cell over
// the head when it is open, which a staircase and a shaft both have — one face
// at a time. On a staircase with the mob behind, that face IS the step behind:
// its cell level with our head and the one over it. Two blocks, and a walker on
// the step above then stands on our block with rock over our head — nowhere for
// 1.95 of body to go, and too high for its attack box, which grows sideways and
// never up. In a shaft the face is the cell over the head when the mob is above,
// and the cave mouth beside us when it is not. Order: the bearing it mostly lies
// in, then overhead, then the other bearing, and reachOf is asked after each
// face, so a face that did not matter costs nothing more.
//
// The cell is standingCell's — the one digStairs itself cuts from — and not
// position.floored(). Over a cave the body comes to rest past the edge of the
// step holding it up (standingCell's own comment, measured), floored() then
// names the column ahead, and every face computed from it is one column off:
// the guard lays a single block over its own head, the step behind — the way
// down the mob is walking — stays wide open, and reachOf, asked from that same
// drifted body, sees that block on the eye line and answers «closed». Review
// arena of 2026-09-16: wall [106,56], one block, «заложился», and the leg
// walking on, where the centred body walls 105,55 and 105,56.
function guardFaces (bot, mob) {
  const feet = standingCell(bot)
  const open = p => { const b = bot.blockAt(p); return !!b && b.boundingBox === 'empty' && !/lava|water/.test(b.name) }
  const tall = open(feet.offset(0, 2, 0)) ? 3 : 2
  const dx = mob.position.x - (feet.x + 0.5)
  const dz = mob.position.z - (feet.z + 0.5)
  const alongX = Math.abs(dx) >= Math.abs(dz)
  const main = alongX ? [Math.sign(dx) || 1, 0] : [0, Math.sign(dz) || 1]
  const other = alongX ? [0, Math.sign(dz) || 1] : [Math.sign(dx) || 1, 0]
  const face = ([sx, sz]: any) => ({
    bearing: [sx, sz],
    cells: [0, 1, 2].slice(0, tall).map(h => feet.offset(sx, h, sz)).filter(open)
  })
  const faces = [face(main)]
  if (tall === 3 && mob.position.y >= feet.y + 2 && open(feet.offset(0, 3, 0))) {
    faces.push({ bearing: null, cells: [feet.offset(0, 2, 0)] })
  }
  faces.push(face(other))
  return faces.filter(f => f.cells.length)
}

// Put the faces down and ask reachOf after each, the way mining.sealOff judges
// its own wall: solid is not the same as closed. No ctl.aborted between cells,
// for sealOff's reason too — low_health fires in the middle of exactly this, and
// an abort there leaves the way open with one block lying in it.
async function guardWall (bot, mob) {
  const { reachOf } = require('./reach')
  const deadline = gameClock.now() + GUARD_WALL_MS
  const put = []
  const why = []
  let left = null
  const faces = guardFaces(bot, mob)
  // It gets at us through cells that are not ours to fill — up through a floor
  // we are standing on the edge of, or down a shaft whose ceiling is rock. Said
  // out loud, because «блоки встали, но не перекрыли» would be a lie about
  // blocks that were never placed.
  if (!faces.length) why.push('между нами нет ни одной открытой клетки, которую я могу заложить')
  for (const f of faces) {
    for (const cell of f.cells) {
      if (gameClock.now() >= deadline) break
      const r = await placeBlockAt(bot, cell, { timeoutMs: GUARD_LEASH_MS })
      if (r.ok && !r.already) put.push({ at: cell, bearing: f.bearing })
      else if (!r.ok && !why.includes(r.reason)) why.push(r.reason)
    }
    left = mob.isValid === false ? null : reachOf(bot, mob)
    if (!left || !left.reaches) return { sealed: true, put, why }
    if (gameClock.now() >= deadline) { why.push('время на стену вышло'); break }
  }
  if (!left) left = mob.isValid === false ? null : reachOf(bot, mob)
  if (!left || !left.reaches) return { sealed: true, put, why }
  return { sealed: false, put, why, left }
}

// The words mining.tunnel answers with, so the brain hears the same sentence
// from the drift and from the stairs.
function reachWords (r) {
  if (r.how === 'дойдёт') return `дойдёт до меня за ${r.steps} шаг.`
  if (r.how === 'стреляет') return 'видит меня и бьёт с дистанции'
  if (r.how === 'сквозь стены') return 'достаёт сквозь породу'
  if (r.how === 'вплотную') return 'вплотную'
  return 'видит меня'
}

// One guard per call. `dir` is the staircase's bearing (null for the shaft): a
// wall in that bearing is a wall the next swing cuts back out. `again` is the
// call that resumes this descent, named in every stop.
//
// The report carries what the drift and the climb carry: `met` — every mob this
// call answered and what the answer was (заложился / закрыт породой / мимо / не
// закрылся / сквозь стены), `threat` — the one that stopped it, with `next` as
// fields ({call, target | direction}) for a caller that reads fields rather
// than Russian, and `behindRock` — the nearest mob seen and let be.
//
// `own` says whether `again` is our own mc_dig_down. It is not always: mc_recover
// digs with this same staircase and chose the bearing itself, so a stop there
// that names «mc_dig_down direction=…» abandons the errand — mc_dig_down knows
// nothing about the pile — and the bearing is not ours to change either.
function descentGuard (session, { dir = null, again, own = true }: any) {
  const bot = session.bot
  const met = []
  const scenery = new Map()
  // survival.surface's `passed`: a mob whose wall failed and which was doing
  // nothing to us, re-asked on every look by the same test that let it pass.
  const passed = new Set()
  let walls = 0
  let blocks = 0
  let threat = null
  // Required at call time: survival requires this module back at load.
  const survival = () => { try { return require('./survival') } catch { return {} } }

  // survival.dangerousNow when survival.js exports it. Without it every wall
  // that did not close is a stop — the cautious reading, never a quiet «мимо».
  // The words are about the bot, not about the tree: which export is missing is
  // not a fact the brain has any lever on, and `danger` is read aloud. The cause
  // stays visible where it is actionable — a machine field for whoever greps.
  const BLIND = 'опасен он сейчас или нет, я проверить не могу — считаю опасным'
  const dangerous = (mob) => {
    const s = survival()
    if (typeof s.dangerousNow !== 'function') return BLIND
    return s.dangerousNow(session, { who: mob, dist: mob.position.distanceTo(bot.entity.position) })
  }

  // survival.whereToFight without a trail: its «на 2 ступеньки вниз по моей же
  // лестнице» is the climb's retreat, and on the way down our stairs lead up —
  // to where the mob usually came from. Its fifth argument names the call to
  // come back to; a survival.js from before that argument says «подъём», which
  // is swapped for ours rather than handed to the brain.
  // The way back is appended when the line does not name it: whereToFight's
  // cheapest-fight sentence ends on the fight, and a stop has to end on a call
  // that resumes the descent.
  const fightLine = (reach, seen, name) => {
    const s = survival()
    const line = typeof s.whereToFight === 'function'
      ? s.whereToFight([], reach, seen, name, again).replace('зови подъём снова', `зови ${again} снова`)
      : reach <= 1 || seen <= 1
        ? `${reach <= 1 ? 'тут шириной в клетку, ко мне пролезет только один' : 'он тут один'} — дерись прямо здесь: mc_fight target=${name}`
        : `до меня дотягиваются с ${reach} сторон — сначала отгороди фланги (mc_place), потом mc_fight target=${name}`
    return line.includes(again) ? line : `${line}; потом зови ${again}`
  }

  const look = () => {
    const { HOSTILES } = require('./combat')
    const { reachOf, sceneryOf } = require('./reach')
    const me = bot.entity.position
    // One block read per cell for the whole look, however many mobs share it.
    const cache = new Map()
    const near = (Object.values(bot.entities || {}) as any[])
      .filter((e : any) => e && e !== bot.entity && e.name && e.position && e.isValid !== false &&
        HOSTILES.has(e.name) && e.position.distanceTo(me) <= GUARD_RADIUS)
      .sort((a: any, b: any) => a.position.distanceTo(me) - b.position.distanceTo(me))
    let first = null
    let seen = 0
    for (const mob of (near as any)) {
      const r = reachOf(bot, mob, { cache })
      if (!r.reaches) { scenery.set(mob.id, sceneryOf(mob, r)); continue }
      scenery.delete(mob.id)
      if (passed.has(mob.id) && !dangerous(mob)) continue
      seen++
      if (!first) first = { mob, r }
    }
    return first ? { ...first, seen } : null
  }

  // Returns the stop sentence, or null to carry on.
  const answer = async ({ mob, r, seen }: any) => {
    const { openSides } = require('./combat')
    // standingCell, for guardFaces' reason: the wall's bearing is worked out
    // from this cell too, and a drifted floored() names the wrong column.
    const feet = standingCell(bot)
    const name = mob.name
    const at = xyz(mob.position)
    const rec: any = { who: name, dist: r.dist, at, where: r.where, how: r.how, seen, y: feet.y }
    if (r.steps !== null) rec.steps = r.steps
    // Bounded, because a mob that keeps stepping in and out of reach would
    // otherwise write one line per swing.
    if (met.length < 12) met.push(rec)
    const how = reachWords(r)

    if (r.how === 'сквозь стены') {
      rec.what = 'сквозь стены'
      const vex = name === 'vex'
      threat = { mob: name, where: r.where, dist: r.dist, at, how: r.how, seen, next: vex ? { call: 'mc_fight', target: name } : { call: 'mc_surface' } }
      return `${name} в ${r.dist} бл. ${r.where}, ${how} — стена от него не спасает, спуск бросаю: ` +
        (vex ? `убей его (mc_fight target=${name}), потом зови ${again}` : 'уходи от него наверх (mc_surface)')
    }

    let wall
    if (walls >= GUARD_WALLS || blocks >= GUARD_BLOCKS) {
      wall = { sealed: false, put: [], why: [`за этот вызов я уже поставил ${walls} стен(ы), ${blocks} бл., а до меня снова дотягиваются — дальше это пустой рюкзак`] }
    } else if (!pickFiller(bot)) {
      wall = { sealed: false, put: [], why: ['нечем: в сумке ни одного блока — булыжник, дипслейт, доски, любой сплошной'] }
    } else {
      wall = await guardWall(bot, mob)
    }
    const placed = wall.put.length
    if (placed) {
      rec.wall = wall.put.map(p => xyz(p.at))
      rec.placed = placed
      blocks += placed
      walls++
    }

    if (wall.sealed) {
      rec.what = placed ? 'заложился' : 'закрыт породой'
      // Behind us, over us, beside us: the descent walks away from that wall.
      // In the bearing of travel it is the first thing the next swing removes.
      const ahead = dir && wall.put.some(p => p.bearing && p.bearing[0] === dir[0] && p.bearing[1] === dir[1])
      if (!ahead) return null
      const perps = [[dir[1], dir[0]], [-dir[1], -dir[0]]]
      const lateral = (mob.position.x - (feet.x + 0.5)) * perps[0][0] + (mob.position.z - (feet.z + 0.5)) * perps[0][1]
      const side = lateral > 0 ? perps[1] : perps[0]
      // Ours to re-aim, or one level aside and then back into the caller's own
      // call: `then` is the same field mc_place→mc_fight uses below. A foreign
      // caller re-planning from the same square would pick the same bearing —
      // its plan is drawn from where the pile lies, not from our wall — so the
      // move that unblocks it has to be the step sideways, not the repeat.
      threat = {
        mob: name, where: r.where, dist: r.dist, at, how: r.how, seen, wall: rec.wall, placed, sealed: true,
        next: own
          ? { call: 'mc_dig_down', mode: 'stairs', direction: dirName(side) }
          : { call: 'mc_dig_down', mode: 'stairs', direction: dirName(side), depth: 1, then: again }
      }
      return `${name} в ${r.dist} бл. ${r.where}, ${how} — заложился прямо по ходу лесенки ` +
        `(${rec.wall.map(p => `${p.x},${p.y},${p.z}`).join(' и ')}), ${placed} бл.; следующая ступенька на ${dirName(dir)} ` +
        `вскроет эту стену первым же взмахом, так что туда не копаю: ` +
        (own
          ? `зови mc_dig_down mode=stairs direction=${dirName(side)}`
          : `сторону на этом спуске выбрал не я, и тем же вызовом я опять пойду на ${dirName(dir)} — ` +
            `сведи меня на ступеньку в сторону сам (mc_dig_down mode=stairs direction=${dirName(side)} depth=1), потом зови ${again}`)
    }

    const why = wall.why.length
      ? wall.why.join('; ')
      : wall.left && wall.left.how === 'дойдёт'
        ? `${placed} бл. встали, но он обойдёт их за ${wall.left.steps} шаг.`
        : `${placed} бл. встали, но линию ко мне не перекрыли`
    rec.why = why
    const danger = dangerous(mob)
    if (!danger) {
      rec.what = 'мимо'
      passed.add(mob.id)
      return null
    }
    rec.what = 'не закрылся'
    rec.danger = danger
    if (danger === BLIND) rec.dangerCheck = 'unavailable'
    // How many sides a walker can reach us from: combat's measured table is
    // indexed by this, not by head count. On a staircase it is 0 or 1 — the
    // step behind is a tread, not a side — which is the cheapest fight there is.
    const reach = openSides(bot, 2).length
    rec.reach = reach
    const lone = reach <= 1 || seen <= 1
    threat = {
      mob: name, where: r.where, dist: r.dist, at, how: r.how, seen, reach, wall: rec.wall, placed, sealed: false, danger,
      next: lone ? { call: 'mc_fight', target: name } : { call: 'mc_place', then: 'mc_fight', target: name }
    }
    if (r.steps !== null) threat.steps = r.steps
    if (danger === BLIND) threat.dangerCheck = 'unavailable'
    return `${name} в ${r.dist} бл. ${r.where}, ${how} — закрыться не вышло (${why}). ${fightLine(reach, seen, name)}`
  }

  return {
    async check () {
      if (!bot.entity) return null
      const g = look()
      return g ? answer(g) : null
    },
    report () {
      const live = [...scenery.entries()]
        .filter(([id]) => { const e = bot.entities && bot.entities[id]; return !!e && e.isValid !== false })
        .map(([, rec]) => rec)
        .sort((a, b) => a.dist - b.dist)
      return {
        met: met.length ? met : undefined,
        threat: threat || undefined,
        behindRock: live.length ? (live.length > 1 ? { ...live[0], seen: live.length } : live[0]) : undefined
      }
    }
  }
}

// A staircase instead of a shaft. Costs one extra block per level and is worth
// it every time: you can walk back up it, you cannot fall down it, and it does
// not leave the bot stranded at the bottom of a hole pathfinder cannot climb.
// The vertical shaft is still the right answer when the only goal is depth.
// `call` is how the caller's own tool is named in a refusal: mc_recover digs
// with this same staircase, and «прыгну, если позовёшь mc_dig_down» sent from
// inside it would name a sixteen-level dig past the pile instead of the retry.
async function digStairs (session, ctl, {
  depth = 16, direction = null, torchEvery = 6, timeoutSeconds = 240, maxFallHp = 0, call = null, nightWork = false
}: any = {}) {
  const bot = session.bot
  const mcData = session.mcData
  const dir = direction && STAIR_DIRS[direction] ? STAIR_DIRS[direction] : facingDir(bot)
  const [dx, dz] = dir
  const want = Math.max(1, Math.min(128, depth))
  const deadline = gameClock.now() + Math.max(10, Math.min(600, timeoutSeconds)) * 1000
  const again = call || `mc_dig_down mode=stairs direction=${dirName(dir)}`

  const before = countItems(bot)
  const from = xyz(bot.entity.position)
  let cut = 0
  let stalls = 0
  let torches = 0
  let stopped = null
  // Not «this direction did not work» but «direction is not what is wrong here».
  // Whoever loops over the four outside reads this instead of parsing Russian.
  let noFooting = false
  // Steps founded on a block we placed, and how many of those needed a prop in
  // the open step cell first — the case that used to end the trip.
  let bridged = 0
  let propped = 0
  // Of the bridged steps, those whose block went against the underside of the
  // one above it — the placement no run has yet seen the server accept.
  let underside = 0
  const drops = []
  let spent = 0
  let ledge = null
  const guard = descentGuard(session, { dir, again, own: !call })

  ctl.onAbort.push(() => { try { bot.clearControlStates() } catch {} })

  // Loop on levels delivered, not swings taken: the caller asked for a depth,
  // and a lip-stop that costs an iteration should not cost a metre of descent.
  // The iteration cap is only a runaway guard.
  for (let i = 0; cut < want && i < want * 3 && !ctl.aborted; i++) {
    if (gameClock.now() >= deadline) { stopped = `время вышло на ${cut}-й ступеньке`; break }
    const hp = bot.health ?? 20
    if (hp < 6) { stopped = `здоровья ${Math.round(hp)} — дальше не копаю`; break }

    // Ten levels of pickaxe left is the line, not zero. Measured on the descent
    // that stranded the bot at y=-58: forty levels cost 166 swings and then 182,
    // so a level is four, and running out at depth is not a setback but the end
    // of the run — it could neither dig on nor cut a staircase home, carrying
    // 208 cobblestone the whole time. Asked every level, so the same line is
    // also the up-front refusal when the bag is already under it.
    const worn = toolShortfall(bot, mcData, { need: SWINGS_PER_LEVEL })
    if (worn) { stopped = worn; break }

    // Once at the top of every level and again before every swing below: a
    // step is three cells of rock, several seconds, and a zombie covers the
    // whole watch radius inside one step (the climb measured that as eight hits
    // and no wall, survival.js stairStep).
    const alarm = await guard.check()
    if (alarm) { stopped = alarm; break }

    const feet = standingCell(bot)
    // Stepping from feet down to (dir, -1): the body walks through the two
    // cells at its own height and drops into the one below them.
    const head = feet.offset(dx, 1, dz)
    const mid = feet.offset(dx, 0, dz)
    const low = feet.offset(dx, -1, dz)
    const land = feet.offset(dx, -2, dz)

    const hz = hazardAt(bot, [head, mid, low])
    if (hz) { stopped = `${hz} — дальше не копаю`; break }
    const lowBlock = bot.blockAt(low)
    if (lowBlock && lowBlock.name === 'bedrock') { stopped = 'бедрок — ниже не пройти'; break }

    // Nothing to land on means a cave under the step. Bridging keeps the
    // staircase walkable both ways, but a block can only be placed against a
    // solid neighbour and over open cave there frequently is none — that is
    // exactly where the first real descent stopped, at y=-27 with four
    // directions all refusing. A cave is not an obstacle on the way down, it is
    // a free thirty blocks, so drop into it when the floor is close enough to
    // land on unhurt, and only bridge when it is not.
    //
    // Order, and why: free drop, then support, then a paid drop, then refuse.
    // Support comes BEFORE any cutting: the cell under the step has no face of
    // its own over a cave, but until the step is cut the step block is a face
    // (its underside), and when the step cell is already open — the run of
    // 2026-09-15 stopped on exactly that lip, eight legs at 160,40,120 and down —
    // a prop in it against the side of our own floor makes one. The prop is cut
    // out again as the step itself, so the staircase keeps its shape and costs
    // one block per level over the cave. Health comes after blocks because
    // health is the resource whose shortage ends the trip, and every step gives
    // back two or three cobblestone.
    const under = bot.blockAt(land)
    let drop = 1
    let jump = null
    if (!under || under.boundingBox !== 'block') {
      const reach = floorBelow(bot, low, FREE_FALL)
      if (reach !== null) {
        drop = reach
      } else {
        const put = await placeBlockAt(bot, land, { steady: true, prop: low })
        if (put.ok) {
          bridged++
          if (put.prop) propped++
          if (put.face === 'bottom') underside++
        } else {
          const verdict: any = judgeDrop(session, bot, mid, groundUnder(bot, mid, 32, [low]), maxFallHp, spent, again)
          if (verdict.ok) {
            drop = verdict.fall
            jump = { verdict, hp: bot.health ?? 20 }
          } else {
            // Asked before the answer is written rather than after: whether the
            // other three directions are worth a leg of the trip is the one thing
            // the caller cannot work out from the words on its own.
            const canBuild = !!pickFiller(bot, { steady: true })
            const other = STAIR_DIR_LIST
              .filter(d => d[0] !== dx || d[1] !== dz)
              .find(d => canFootStep(bot, feet, d[0], d[1], canBuild))
            noFooting = !other && !canFootStep(bot, feet, dx, dz, canBuild)
            ;({ stopped, ledge } = ledgeReport(bot, feet, dir, put, other, noFooting, verdict, { canBuild, call: again }))
            break
          }
        }
      }
    }

    let refused = null
    for (const cell of [head, mid, low]) {
      if (ctl.aborted) break
      const b = bot.blockAt(cell)
      if (!b || b.boundingBox === 'empty') continue
      const seen = await guard.check()
      if (seen) { refused = seen; break }
      const problem = missingHarvestTool(bot, b, mcData)
      if (problem) { refused = problem; break }
      try {
        await equipBestTool(bot, b)
        await withTimeout(bot.dig(b), 20000, 'блок не ломается')
      } catch (e) {
        refused = e.message
        break
      }
      // Verify rather than trust. Gravel refills the slot as fast as we empty
      // it, and a swing the server quietly refuses returns without error and
      // leaves the block standing — the bot then walks onto the step instead of
      // into it, and the staircase flattens. One retry, then give up honestly.
      const left = bot.blockAt(cell)
      if (left && left.boundingBox !== 'empty') {
        try {
          await equipBestTool(bot, left)
          await withTimeout(bot.dig(left), 20000, 'блок не ломается')
        } catch (e) {
          refused = e.message
          break
        }
        const still = bot.blockAt(cell)
        if (still && still.boundingBox !== 'empty') {
          refused = `${still.name} на ${cell.x},${cell.y},${cell.z} не ломается`
          break
        }
      }
    }
    if (refused) { stopped = refused; break }
    // The last cell cut is the one most likely to have opened a cave, and the
    // step itself is the next second or so.
    const opened = await guard.check()
    if (opened) { stopped = opened; break }
    const work = nightWork ? require('./night-work').step(bot, low, feet, 3.25, undefined, 3) : null
    if (work?.stopped) {
      const cover = await require('./night-work').closeBehind(bot, ctl, mid)
      stopped = `${work.stopped}; ${cover || 'проход закрыт перед собой'}`
      break
    }

    // Into a drop the body goes by walkOff, which lands it in the column the
    // drop was judged on; a free three-block drop that drifts onto a deeper
    // floor next door is a paid one nobody agreed to.
    if (drop > 1) {
      if (!await walkOff(bot, ctl, low, dir, feet.y)) { stopped = 'не смог сойти с уступа в пещеру'; break }
    } else if (!await stepForward(bot, ctl, low)) { stopped = 'не смог шагнуть на ступеньку'; break }

    // Confirm the body is standing IN the step, not on its lip. Planning the
    // next cut from the old level flattens the staircase into a corridor —
    // measured: 20 steps for 13 levels. Waiting for onGround alone is not
    // enough, because standing on the edge is also "on ground"; the height has
    // to have actually changed.
    // A long drop needs a long wait: twelve blocks take most of a second in the
    // air, and reading the height mid-fall counts a stall.
    const settleFor = drop > 1 ? 1500 + drop * 150 : 1200
    let settle = gameClock.now() + settleFor
    while (gameClock.now() < settle && !ctl.aborted) {
      if (bot.entity.position.floored().y <= low.y && bot.entity.onGround) break
      if (drop > 1 && bot.entity.position.floored().y < feet.y && bot.entity.onGround) break
      await sleep(60)
    }
    // Still on the lip. The second push used to aim at the same column centre,
    // and stepForward counts half a block short of that as arrived — so it
    // returned without a tick of walking, from exactly the spot where a body
    // whose hitbox still overhangs the edge stands on it. That is the flattened
    // staircase above, and over a cave it is also a decided drop not taken.
    // Aim past the centre: in rock the uncut wall ahead stops the body anyway,
    // on a bridged step the landing block is still under it at +0.4.
    if (bot.entity.position.floored().y >= feet.y && !ctl.aborted) {
      await stepForward(bot, ctl, low.offset(dx * 0.4, 0, dz * 0.4), 900)
      settle = gameClock.now() + settleFor
      while (gameClock.now() < settle && !ctl.aborted) {
        if (bot.entity.position.floored().y < feet.y && bot.entity.onGround) break
        await sleep(60)
      }
    }
    if (jump) {
      await sleep(400) // fall damage lands on the landing tick, update_health a packet later
      const fell = feet.y - bot.entity.position.floored().y
      if (fell > 0) spent += recordDrop(drops, bot, feet, fell, jump)
    }

    // Count levels actually gained, not swings taken. A step that cut its cells
    // but left the body at the same height is not progress, and three of those
    // in a row means something is in the way that another lap will not move.
    const gainedLevels = feet.y - bot.entity.position.floored().y
    if (gainedLevels > 0) {
      // A step into a cave can be worth several levels at once, and the caller
      // asked for depth, not for swings.
      cut += gainedLevels
      stalls = 0
    } else if (++stalls >= 3) {
      stopped = 'ступенька не углубляется — что-то мешает'
      break
    }
    // Before the torch and the pickup: the pickup walks for up to two and a half
    // seconds every fourth level, the longest stretch of a level with no look.
    const landed = await guard.check()
    if (landed) { stopped = landed; break }
    if (work?.close) {
      stopped = await require('./night-work').closeBehind(bot, ctl, feet)
      if (stopped) break
    }
    // Light the step we just left. An unlit staircase is a mob spawner pointed
    // at our own back — the run that died at depth was killed by something that
    // spawned in the dark behind it, not by anything it dug into.
    if (!work?.close && torchEvery > 0 && cut % torchEvery === 0 && await placeTorch(bot, feet)) torches++

    // Collecting after every step costs more than the cobblestone is worth.
    if (!work?.close && cut % 4 === 0) await collectNearbyDrops(bot, ctl, { radius: 3, timeoutMs: 2500 })
  }

  if (!nightWork) await collectNearbyDrops(bot, ctl, { radius: 4, timeoutMs: 4000 })
  // Swings left matters more the deeper we are: the climb home is three digs a
  // level, so the brain has to be able to turn back while it still can.
  const picks = toolStatus(bot, 'pickaxe')
  return {
    mode: 'лестница',
    direction: dirName(dir),
    from,
    at: xyz(bot.entity.position),
    steps: cut,
    torches,
    bridged,
    propped,
    underside,
    drops: drops.length ? drops : undefined,
    gained: diffItems(before, countItems(bot)),
    pickaxeLeft: picks.total,
    // The sum alone misled try-tools into reading 135 as "the give did not
    // land": it was five swings of worn iron plus a fresh stone pick the
    // autopilot had just made. A brain reading the sum has the same blind
    // spot — it cannot see that the tool in hand is one block from breaking.
    pickaxes: picks.count ? picks.tools : undefined,
    directionWontHelp: noFooting || undefined,
    ...guard.report(),
    ledge: ledge || undefined,
    stopped: stopped || undefined
  }
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
  const candidates = visibleOf(bot, ids, radius, { max: (require('./movement').waterBudgetOn?.() ?? false) ? 12 : 1, fair: useFair, ...((dry || skip) ? { skip: p => (dry && underWater(bot, p)) || !!skip?.(p) } : {}) })
  if ((require('./movement').waterBudgetOn?.() ?? false)) priceResources(bot, candidates)
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
    !(bot.canDigBlock(bot.blockAt(p)) && require('./pick').blockSeen(bot, p))
  // Ведру нужен источник: текущая вода «уже видно отсюда» при «источника не вижу» у bucket гоняла этап воды по кругу (cl-c 14.10).
  const notSource = p => waterSource && !require('./obsidian').isSource(bot.blockAt(p), 'water')
  const findHit = () => {
    if (newView && (ctl.aborted || bot.entity.position.equals(viewFrom))) return null
    return lavaSource ? (require('./cast').lavaSources(bot)[0] || null)
      : firstVisible(bot, ids, radius, useFair, dry,
        (unlootedContainers || newView || waterSource) ? p => (unlootedContainers && skipLooted(p)) || skipSeen(p) || notSource(p) : null)
  }

  let hit = findHit()
  if (hit) return { found: hit.name, at: xyz(hit.position), walked: 0, note: 'уже видно отсюда' }
  // A newly placed roof can be confirmed before the client skylight update arrives.
  if (surface && require('./worlds').worldOf(bot) === 'overworld' && !ctl.aborted && deadline - gameClock.now() >= 10000 &&
    (!session.underSky?.() || require('./fortify').enclosure(bot, bot.entity.position.floored()).sealed)) {
    await require('./survival').surface(session, ctl, { timeoutSeconds: Math.min(30, (deadline - gameClock.now()) / 1000), hand: false, preferPillar: true })
    // 30 с не хватило (карман под крышей своей лестницы: «поднялся на 6», до неба 2 блока — cl-n 14.10) — ещё подъём на остаток.
    if (!ctl.aborted && typeof session.underSky === 'function' && !session.underSky() && deadline - gameClock.now() >= 10000) {
      await require('./survival').surface(session, ctl, { timeoutSeconds: Math.min(30, (deadline - gameClock.now()) / 1000), hand: false, preferPillar: true })
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
    return require('./perception/eyes').nearest(bot, names, { max: 8, maxDist: Math.max(radius * 2, 96) })
      .find(m => !memTried.has(`${m.x},${m.y},${m.z}`) && (!newView || !seenHere.has(posKey(m))) && !skipLooted(m, m.name) && Math.hypot(m.x - me.x, m.z - me.z) > 6 && !(dry && underWater(bot, new Vec3(m.x, m.y, m.z)))) || null
  }
  // Разведка из-под неба верхнего мира — поверху (session.underSky,
  // underRoofCost): отрезок «по прямой» иначе уходил в пещеры.
  const walkTop = (surface && require('./worlds').worldOf(bot) === 'overworld') || (typeof session.underSky === 'function' && session.underSky())
  const walk = async (x, z, options) => {
    session.surfaceWalk = walkTop
    session.scoutFromY = walkTop && bot.entity ? bot.entity.position.y : null
    const mv = bot.pathfinder.movements
    const dug = mv ? mv.canDig : undefined
    const scaffold = mv ? mv.scafoldingBlocks : undefined
    if (walkTop && mv) { mv.canDig = false; mv.scafoldingBlocks = [] }
    try { return await travelXZ(bot, ctl, x, z, { ...options, retries: 1, deadline }) }
    finally {
      session.surfaceWalk = false
      session.scoutFromY = null
      if (walkTop && mv) { mv.canDig = dug; mv.scafoldingBlocks = scaffold }
    }
  }
  let failStreak = 0
  let failFrom = null
  let escaped = false
  // Своя запертая клетка (коробка тактики): поверху без копки из неё пути нет ни в одну сторону (cl-j 14.10: 22 мин «пути нет»).
  if (walkTop) await require('./fortify').leaveSealedCell(session, ctl, null)
  while (gameClock.now() < deadline && !ctl.aborted) {
    const mem = remembered()
    if (mem) {
      memTried.add(`${mem.x},${mem.y},${mem.z}`)
      const r = await walk(mem.x, mem.z, { y: mem.y, range: 4 })
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
}

// ---------------------------------------------------------------- place

// Куда ставят блок: клетка пустая или заменимая (canBeReplaced: трава,
// папоротник, снег, лоза, корни Ада — растения из REPLACEABLE_BY_TREES
// без цветов; цветы, саженцы и факел заменимыми не бывают).
const PLACE_INTO = /^(air|cave_air|void_air|short_grass|tall_grass|fern|large_fern|dead_bush|snow|seagrass|tall_seagrass|leaf_litter|vine|glow_lichen|light|warped_roots|nether_sprouts|crimson_roots|hanging_roots|bush|firefly_bush|short_dry_grass|tall_dry_grass)$/
// Не заменимое, но ломается мгновенно (прочность 0: цветы, саженцы, факел) —
// сорвать и поставить, как игрок. Огонь и порталы — нет.
const clearable = b => !!b && b.boundingBox === 'empty' && b.hardness === 0 && !/fire|portal|water|lava|bubble/.test(b.name)
// Опоры, клик по которым — действие (окно, сон, дверь), а не постановка.
const CLICKABLE = /furnace|smoker|chest|barrel|crafting_table|crafter|_bed$|anvil|shulker|enchanting_table|brewing_stand|hopper|dispenser|dropper|lectern|loom|grindstone|stonecutter|smithing_table|cartography_table|fletching_table|note_block|jukebox|_door$|_trapdoor$|_button$|lever|beacon|bell|composter|repeater|comparator|daylight_detector|cake|_sign$|_fence_gate$/

async function place (session, ctl, { block: name, at = null }: any = {}) {
  const bot = session.bot
  const item = itemNamed(bot, name)
  if (!item) throw new Error(`нет ${name} в инвентаре`)

  if (at) {
    if (!['x', 'y', 'z'].every(k => Number.isInteger(at[k]))) throw new Error('at: нужны целые координаты x,y,z')
    const pos = new Vec3(at.x, at.y, at.z)
    if (pos.offset(0.5, 0.5, 0.5).distanceTo(bot.entity.position.offset(0, 1.62, 0)) > 4.5) {
      throw new Error('названная клетка слишком далеко — сначала подойди')
    }
    if (ctl.aborted) return { stopped: 'прервано' }
    const r = await placeBlockAt(bot, pos, { item: item.name, honest: true })
    if (!r.ok) throw new Error(`не поставил ${name} на ${pos.x},${pos.y},${pos.z}: ${r.reason}`)
    return { placed: !r.already, block: r.already || name, at: xyz(pos) }
  }

  const feet = bot.entity.position.floored()
  const head = feet.offset(0, 1, 0)
  // Опора — на два уровня вниз, а не на один: на подъёме лесенкой пустые
  // ступени позади лежат НИЖЕ ног (клетка ног прошлой ступени — feet-1), и
  // прежний перебор dy -1..1 не видел ни одной. Кампания 2026-09-26: кирка
  // стёрлась на подъёме с y=16, «некуда поставить crafting_table — вокруг нет
  // свободной опоры» при 212 булыжника и 7 палках, и тело встало насовсем.
  const collect = () => {
    const out = []
    for (let dx = -3; dx <= 3; dx++) {
      for (let dz = -3; dz <= 3; dz++) {
        for (let dy = -2; dy <= 1; dy++) {
          const p = feet.offset(dx, dy, dz)
          const target = p.offset(0, 1, 0)
          // Never place into our own hitbox.
          if (target.equals(feet) || target.equals(head)) continue
          const ref = bot.blockAt(p)
          const above = bot.blockAt(target)
          if (!ref || !above) continue
          if (ref.boundingBox !== 'block' || above.boundingBox !== 'empty') continue
          if (/water|lava/.test(above.name)) continue
          // Над опорой — воздух или трава: в клетку с факелом блок не встаёт
          // (у факела рамка пустая, но клетка занята). И опора — не печь,
          // сундук, верстак: клик по ним открывает окно, а блок не ставится.
          // 2026-09-26, штрек: два факела на полу и печь — восемь попыток
          // верстака «blockUpdate did not fire», и ни ведра, ни щита из 17
          // слитков.
          // Цветы у леса — не заменимы, а белый список без них оставил тело
          // без верстака на поляне: «некуда поставить crafting_table» и ночь
          // на 1 хп в яме без кирки (2026-09-26, 13:29). Такие — сорвать.
          const free = PLACE_INTO.test(above.name)
          if (!free && !clearable(above)) continue
          if (CLICKABLE.test(ref.name)) continue
          out.push({ ref, dist: p.distanceTo(feet) + (free ? 0 : 0.5), clear: free ? null : above })
        }
      }
    }
    return out.sort((a, b) => a.dist - b.dist)
  }
  let candidates = collect()
  // Совсем тесно (колодец, штрек без хвоста) — как игрок: вырубить нишу в
  // стене на уровне головы и поставить туда.
  if (!candidates.length && await digNiche(bot, ctl, feet)) candidates = collect()
  if (!candidates.length) {
    // Стою на столбе или узком уступе: сверху ни одной свободной опоры, но у
    // блока под ногами есть бока — поставить сбоку, к его грани (как игрок,
    // присев на краю). Кампания 2026-09-26: на столбе в небе стёрлась кирка, а
    // верстак ставить было «некуда» — и спуститься стало нечем.
    const { placeBlockAt } = require('./build')
    const under = feet.offset(0, -1, 0)
    for (const [dx, dz] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
      if (ctl.aborted) break
      const p = under.offset(dx, 0, dz)
      const b = bot.blockAt(p)
      if (!b || b.boundingBox !== 'empty' || /water|lava/.test(b.name)) continue
      const r = await placeBlockAt(bot, p, { item: name })
      if (r.ok) {
        rememberOwnBlock(session, name, p)
        return { placed: name, at: xyz(p), side: true }
      }
    }
    throw new Error(`некуда поставить ${name} — вокруг нет свободной опоры`)
  }

  await bot.equip(item, 'hand')
  let last = null
  for (const c of candidates.slice(0, 8)) {
    if (ctl.aborted) break
    try {
      if (c.clear) {
        try { await withTimeout(bot.dig(c.clear, true), 3000, 'не сорвать') } catch {}
        await sleep(100)
        await bot.equip(item, 'hand')
      }
      await bot.lookAt(c.ref.position.offset(0.5, 1.2, 0.5), true)
      await bot.placeBlock(c.ref, new Vec3(0, 1, 0))
      const at = c.ref.position.offset(0, 1, 0)
      rememberOwnBlock(session, name, at)
      return { placed: name, at: xyz(at) }
    } catch (e) {
      last = e
    }
  }
  throw new Error(`не смог поставить ${name}${last ? ': ' + last.message : ''}`)
}

// Ниша под блок: одна клетка сбоку на уровне головы, под ней остаётся опора
// (клетка сбоку на уровне ног). Не вскрываем жидкость и пустоту за стеной:
// вода или лава за нишей — это потоп в штрек; бедрок и обсидиан не рубим.
async function digNiche (bot, ctl, feet) {
  const sides = [[1, 0], [-1, 0], [0, 1], [0, -1]]
  for (const [dx, dz] of sides) {
    if (ctl.aborted) return false
    const cell = feet.offset(dx, 1, dz)
    const support = bot.blockAt(feet.offset(dx, 0, dz))
    const b = bot.blockAt(cell)
    if (!b || !support || support.boundingBox !== 'block' || b.boundingBox !== 'block') continue
    if (/bedrock|obsidian|chest|furnace|crafting_table|barrel|spawner/.test(b.name)) continue
    const around = [cell.offset(0, 1, 0), cell.offset(dx, 0, dz), cell.offset(dz, 0, dx), cell.offset(-dz, 0, -dx)]
    if (around.some(p => { const n = bot.blockAt(p); return !n || /water|lava/.test(n.name) })) continue
    try {
      await equipBestTool(bot, b)
      await withTimeout(bot.dig(b, true), 8000, 'не копается')
      return true
    } catch {}
  }
  return false
}

// ---------------------------------------------------------------- own blocks

// A crafting table costs four planks and, at depth, the climb home: the run of
// 2026-08-31 stood one up at y=-59, crafted a pickaxe on it, walked forty
// blocks on and later refused the next pickaxe with «нужен верстак, а его нет
// ни рядом, ни в инвентаре». So a table the bot stood up has to leave with the
// body.
//
// A table found already standing does not: on a shared server breaking someone
// else's furniture is theft, and the block itself cannot tell the two cases
// apart. The only honest witness is our own memory of having placed it, so
// that is what is kept here — every place() goes through this, including the
// autopilot's tableUnderfoot, which places through the same function.
const OWN_BLOCKS_KEPT = 24
// Recent, not forever: «я его поставил в этом крафте» is the licence, and two
// minutes covers place → craft → pick up with room for a 90s craft intent. A
// table standing on that square an hour later is part of the world again.
const OWN_BLOCK_TTL_MS = 120000
const posKey = p => `${p.x},${p.y},${p.z}`

function rememberOwnBlock (session, name, pos) {
  if (name !== 'crafting_table') return
  if (!session.ownBlocks) session.ownBlocks = new Map()
  session.ownBlocks.delete(posKey(pos)) // re-insert so the eviction order is age
  session.ownBlocks.set(posKey(pos), gameClock.now())
  while (session.ownBlocks.size > OWN_BLOCKS_KEPT) {
    session.ownBlocks.delete(session.ownBlocks.keys().next().value)
  }
}

function isOwnBlock (session, pos) {
  const at = session.ownBlocks && session.ownBlocks.get(posKey(pos))
  return !!at && gameClock.now() - at < OWN_BLOCK_TTL_MS
}

function forgetOwnBlock (session, pos) {
  if (session.ownBlocks) session.ownBlocks.delete(posKey(pos))
}

// A window left open blocks every window after it (README), so this runs before
// digging and after crafting either way.
async function closeStrayWindow (bot) {
  if (!bot.currentWindow) return false
  try { bot.closeWindow(bot.currentWindow) } catch {}
  await sleep(200)
  return true
}

// Bare hands on purpose. minecraft-data 1.21.11: crafting_table is hardness
// 2.5, material mineable/axe, drops [332] — itself — and has NO harvestTools,
// so anything breaks it and it always drops. But digging with a tool in hand
// costs that tool a point of durability whatever the block is, and pickaxe
// swings are the entire reason we are carrying the table home. An axe is worth
// it (0.95s against 3.75s, and an axe is not the way out); a pickaxe is not.
async function handForBreaking (bot) {
  const axe = bestOfKind(bot, 'axe')
  if (axe) { await bot.equip(axe, 'hand'); return axe.name }
  const held = bot.heldItem
  if (!held || !held.maxDurability) return held ? held.name : 'пусто'
  const junk = bot.inventory.items().find(i => !i.maxDurability)
  try {
    if (junk) { await bot.equip(junk, 'hand'); return junk.name }
    await bot.unequip('hand')
    return 'пусто'
  } catch {
    return held.name
  }
}

// Break a table we put down ourselves and take it with us. Never throws: a
// table left standing is a loss worth reporting, not a reason to fail a craft
// that already succeeded.
async function reclaimTable (session, ctl, table) {
  const bot = session.bot
  if (!table || ctl.aborted) return null
  const at = table.position
  if (!isOwnBlock(session, at)) return null
  const here = bot.blockAt(at)
  if (!here || here.name !== 'crafting_table') { forgetOwnBlock(session, at); return null }
  await closeStrayWindow(bot)
  if (!bot.canDigBlock(here)) {
    return { kept: false, at: xyz(at), note: 'до верстака не дотянуться — оставил стоять, вернись за ним' }
  }

  const before = countOf(bot, 'crafting_table')
  const receipt = bot.version === '1.21.11' && bot._client
    ? require('./environments/dig-receipt').watchDigReceipt(bot, at, () => ctl.aborted) : null
  try {
    await handForBreaking(bot)
    await withTimeout(bot.dig(here), 12000, 'верстак не ломается')
    if (receipt && await receipt.settle() !== 'confirmed') throw new Error('сервер не подтвердил разрушение')
  } catch (e) {
    return { kept: false, at: xyz(at), note: `верстак остался стоять (${e.message}) — сломай сам, это 4 доски` }
  } finally { receipt?.close() }
  forgetOwnBlock(session, at)

  // Vanilla only vacuums up a drop within about a block, and the table is one
  // to three squares away. Wait for the free pickup first, walk only if it does
  // not come — walking is what cost eleven levels of altitude last time.
  const deadline = gameClock.now() + 1500
  while (gameClock.now() < deadline && countOf(bot, 'crafting_table') <= before) await sleep(150)
  if (countOf(bot, 'crafting_table') <= before) {
    try { await withTimeout(collectNearbyDrops(bot, ctl, { radius: 3, timeoutMs: 3000, appearMs: 3000 }), 5000) } catch {}
    try { bot.pathfinder.setGoal(null) } catch {}
  }
  // Второй заход — шире и дольше. Верстак, брошенный в штреке, — это конец
  // на глубине: без него ни кирки, ни печи (2026-09-26, 12:52: «подобрать не
  // успел», а через три минуты — y=29 без кирки и верстака).
  if (countOf(bot, 'crafting_table') <= before && !ctl.aborted) {
    try { await withTimeout(collectNearbyDrops(bot, ctl, { radius: 6, timeoutMs: 6000, appearMs: 6000 }), 8000) } catch {}
    try { bot.pathfinder.setGoal(null) } catch {}
  }

  const kept = countOf(bot, 'crafting_table') > before
  if (kept) return { kept, at: xyz(at) }
  // Что на самом деле: стоит ли он ещё (удар «прошёл», а блок цел) и какие
  // предметы лежат рядом — чтобы следующий заход чинил правду, а не догадку.
  const still = bot.blockAt(at)
  const standing = !!still && still.name === 'crafting_table'
  if (standing) rememberOwnBlock(session, 'crafting_table', at)
  const drops = (Object.values(bot.entities) as any[]).filter((e : any) => e && e.name === 'item' && e.position && e.position.distanceTo(bot.entity.position) < 10)
    .map((e : any) => { let n = '?'; try { n = e.getDroppedItem().name } catch {} return `${n}@${xyz(e.position).x},${xyz(e.position).y},${xyz(e.position).z}` })
  return {
    kept,
    at: xyz(at),
    standing,
    drops: drops.slice(0, 6),
    note: standing
      ? `верстак не сломался — стоит на ${xyz(at).x},${xyz(at).y},${xyz(at).z}`
      : `верстак сломал, но подобрать не успел — рядом: ${drops.slice(0, 4).join(', ') || 'ничего'}`
  }
}

// ---------------------------------------------------------------- craft

function findTable (bot, mcData, maxDistance = 3) {
  return bot.findBlock({ matching: [mcData.blocksByName.crafting_table.id], maxDistance })
}

// bot.craft() opens the table by activating the block, which silently does
// nothing when the bot is out of reach or has no line of sight — and then the
// call hangs 20s waiting for a window that never opens. So guarantee a table
// right next to us: walk to a known one, or build a fresh one on the spot.
// Put a brand new table directly next to us, crafting one first if needed.
async function placeFreshTable (session, ctl) {
  const bot = session.bot
  const mcData = session.mcData
  let item = bot.inventory.items().find(i => i.name === 'crafting_table')
  if (!item) {
    const own = bot.recipesFor(mcData.itemsByName.crafting_table.id, null, 1, null)
    if (!own.length) return null
    await bot.craft(own[0], 1, null)
    item = bot.inventory.items().find(i => i.name === 'crafting_table')
  }
  if (!item) return null
  await place(session, ctl, { block: 'crafting_table' })
  return findTable(bot, mcData, 3)
}

async function ensureTable (session, ctl) {
  const bot = session.bot
  const mcData = session.mcData

  let table = findTable(bot, mcData, 3)
  if (table) return table

  // Walking to a table we can see is only worth it when it is genuinely close
  // and we cannot simply stand one up. Twenty blocks underground is not close.
  // Measured: the second craft of a run went looking for the table the first
  // craft had left behind twelve blocks back, spent the entire 60s intent
  // budget inside pathfinder, and answered `timeout` — with canDig movements
  // inherited from the drift, because craft is one of the few intents that
  // never calls updateMovements. It was not walking to the table, it was
  // digging its way back to it. A crafting table costs four planks; a minute
  // at y=-59 costs the climb.
  const canPlace = !!bot.inventory.items().find(i => i.name === 'crafting_table') ||
    bot.recipesFor(mcData.itemsByName.crafting_table.id, null, 1, null).length > 0
  const far = findTable(bot, mcData, canPlace ? 6 : 20)
  if (far) {
    const p = far.position
    // Bounded, and cleared afterwards either way: pathfinder outlives the
    // promise we stopped waiting for, and a goal left set keeps walking the
    // body long after this call has answered.
    try {
      await withTimeout(
        bot.pathfinder.goto(new goals.GoalNear(p.x, p.y, p.z, 2)), 15000, 'до верстака не дошёл')
    } catch {}
    try { bot.pathfinder.setGoal(null) } catch {}
    table = findTable(bot, mcData, 3)
    if (table) return table
  }

  let item = bot.inventory.items().find(i => i.name === 'crafting_table')
  if (!item) {
    const own = bot.recipesFor(mcData.itemsByName.crafting_table.id, null, 1, null)
    if (!own.length) return null
    await bot.craft(own[0], 1, null)
    item = bot.inventory.items().find(i => i.name === 'crafting_table')
  }
  if (!item) return null

  await place(session, ctl, { block: 'crafting_table' })
  return findTable(bot, mcData, 3)
}

// mineflayer waits a flat twenty seconds for the table window and there is no
// way to ask it to wait less: promise_utils.js `once (emitter, event, timeout =
// 20000)`, awaited in craft.js immediately after `bot.activateBlock(table)`.
// That single wait is the bulk of the 28.9s a second craft cost in try-tools
// against 3.3s for the first — what goes missing on 1.21.11 is the activate,
// not the crafting.
//
// We cannot shorten someone else's timer, but we can poke the same block again
// while it runs: craft.js waits for the FIRST windowOpen event, whoever caused
// it, so a repeat activate is not a second craft — it is the same one asking
// again. Poking stops the moment a window exists, and bot.currentWindow is set
// by the open_window packet handler one beat BEFORE the event is emitted
// (inventory.js: prepareWindow), so reading it cannot arrive late.
// Six seconds before the first poke, not one: a window that is merely slow must
// be allowed to arrive on its own. Two windows for one craft would be worse than
// the wait — mineflayer would keep clicking into the first while the server
// answers about the second — and a normally opening table takes under a third of
// a second. After that, 10.5s and 15.5s, all still inside mineflayer's own 20.
const NUDGE_AT_MS = [6000, 4500, 5000]

// How many runs of this recipe the bag can actually pay for. recipesFor only
// answers yes/no for the exact number asked, and its "no" used to send craft
// off table-hunting for a craft that was never about the table: «палки, count
// 16» with six planks placed a crafting table, spent four of the six planks on
// it, and then answered «для stick нужен верстак, а его нет ни рядом, ни в
// инвентаре». Fewer sticks is a better answer than that in every case.
function affordableCrafts (bot, recipe) {
  const have = {}
  for (const i of bot.inventory.items()) have[i.type] = (have[i.type] || 0) + i.count
  let n = Infinity
  for (const d of (recipe && recipe.delta) || []) {
    if (d.count >= 0) continue
    n = Math.min(n, Math.floor((have[d.id] || 0) / -d.count))
  }
  return Number.isFinite(n) ? n : 1
}

function craftWithNudge (bot, recipe, times, table, ctl = null) {
  if (bot.version === '1.21.11') return require('./craft-confirmed').craftConfirmed(bot, recipe, times, table, () => !!ctl?.aborted)
  // Mineflayer predicts output locally; verify every inventory craft against
  // the server before the next iteration can spend those predicted items.
  if (!table && times > 1) {
    // И с паузой: подряд без неё второй заход падал так же — ждём, пока сервер
    // положит результат в рюкзак (это и есть свидетель, что заход прошёл).
    const made = () => bot.inventory.items().reduce((n, i) => n + (i.type === recipe.result.id ? i.count : 0), 0)
    return (async () => {
      for (let i = 0; i < times; i++) {
        const before = made()
        await bot.craft(recipe, 1, null)
        if (bot.version === '1.21.11' && !(await require('./invsync').refresh(bot))) throw new Error('крафт: сервер не подтвердил инвентарь')
        for (let t = 0; t < 30 && made() <= before; t++) await sleep(50)
        await sleep(150)
      }
    })()
  }
  if (!table) return bot.craft(recipe, times, null)
  let done = false
  const work = bot.craft(recipe, times, table)
  work.then(() => { done = true }, () => { done = true })
  const nudge = async () => {
    for (const ms of NUDGE_AT_MS) {
      await sleep(ms)
      if (done || bot.currentWindow) return
      try { await bot.activateBlock(table) } catch {}
    }
  }
  nudge().catch(() => {})
  return work
}

async function craft (session, ctl, { item: name, count = 1, spendReserve = false, conversionStep = false, conversionInputs = null, conversionTimes = 1, planOnly = false, repair = false }: any = {}) {
  const bot = session.bot
  if (repair) return require('./conversions/repair').repairItems(session, ctl, { item: name, planOnly })
  const mcData = session.mcData
  const itemData = mcData.itemsByName[name]
  if (!itemData) throw new Error(`нет такого предмета: ${name}`)
  if (!conversionStep && bot.version === '1.21.11') {
    const converted = await require('./conversions/runtime').craftConverted(session, ctl, { item: name, count, spendReserve, planOnly })
    if (converted) return converted
  }

  // runIntent aborts the ctl on timeout and nothing in here used to listen, so
  // a craft that ran out of time left the body walking to a table under a goal
  // nobody cleared. That is how a climb from y=-48 ended at y=-59 with the
  // intent already reported as `timeout`. Same teardown tunnel and surface do.
  ctl.onAbort.push(() => {
    try { bot.pathfinder.setGoal(null) } catch {}
    try { bot.clearControlStates() } catch {}
  })

  // Anything below may put a table on the ground, and a table we stood up has
  // to come back with the body — including when the craft fails, because the
  // four planks are worth exactly as much either way.
  const placed = []
  const taken = []
  const reclaimAll = async () => {
    while (placed.length) {
      const r = await reclaimTable(session, ctl, placed.shift())
      if (r) taken.push(r)
    }
  }
  // Что застряло в сетке 2×2 от прошлого сорванного крафта — сначала вернуть в
  // рюкзак (invsync.flushGrid), иначе рецепт «не видит» своих же досок.
  const inventorySync = require('./invsync')
  if (bot.version === '1.21.11') {
    if (!(await inventorySync.refresh(bot, 2000, true))) throw new Error('крафт: сервер не подтвердил возврат сетки')
  } else if (inventorySync.flushGrid(bot)) await sleep(350)
  // Свидетель — рюкзак, а не отсутствие исключения (см. ниже, после крафта).
  // Считаем и надетое: автопилот надевает свежий нагрудник и берёт щит в левую
  // руку раньше, чем мы успеваем посчитать (2026-09-26: нагрудник скрафтился,
  // был надет, а проверка по рюкзаку сказала «не прибавилось»).
  const owned = () => {
    let n = countOf(bot, name)
    for (const s of [5, 6, 7, 8, 45]) { const it = bot.inventory.slots[s]; if (it && it.name === name) n += it.count }
    return n
  }
  const before = owned()

  try {
    bot._ndCrafting = true
    // Try the 2x2 inventory grid first. Handing bot.craft a table it does not
    // need makes it open the table UI, and if the bot has since wandered out of
    // reach the window never opens and the call hangs for 20s. Asked for one
    // item and not for `count`, because the question here is only "can this be
    // made at all, and does it need the 3x3 grid" — how many is a separate
    // question, answered from the bag below.
    let table = null
    let recipes = bot.recipesFor(itemData.id, null, 1, null)
    const planned = recipe => {
      const consumed = Object.fromEntries(recipe.delta.filter(d => d.count < 0).map(d => [mcData.items[d.id].name, -d.count]))
      return Object.keys(consumed).length === Object.keys(conversionInputs).length &&
        Object.entries(conversionInputs).every(([item, quantity]: [string, number]) => consumed[item] === quantity / conversionTimes)
    }

    // В сетке 2×2 есть только свёртка «блок → 9 слитков», а план — самородки на верстаке: искать и с верстаком
    // (s1-full48 06.10: iron_block из сундука бастиона + самородки → «рецепт не совпал» ×4, кирки не сделаны).
    if (!recipes.length || conversionInputs && !recipes.some(planned)) {
      table = await ensureTable(session, ctl)
      if (table) {
        placed.push(table)
        await bot.lookAt(table.position.offset(0.5, 0.5, 0.5), true)
        recipes = bot.recipesFor(itemData.id, null, 1, table)
      }
    }

    if (!recipes.length) {
      const known = bot.recipesAll(itemData.id, null, table || true)
      if (!known.length) throw new Error(`не знаю рецепта для ${name}`)
      const missing = describeMissing(bot, known, mcData)
      // Everything is in the bag and it still will not craft: the only thing in
      // the way is the 3x3 grid. Saying "не хватает ингредиентов" while the bot
      // is carrying 64 cobblestone sends the brain hunting for the wrong thing.
      if (!missing) throw new Error(`для ${name} нужен верстак, а его нет ни рядом, ни в инвентаре`)
      throw new Error(`не хватает на ${name}: ${missing}` + (table ? '' : ' (и верстака рядом нет)'))
    }

    if (conversionInputs) recipes = recipes.filter(planned)
    if (!recipes.length) throw new Error(`серверный рецепт для ${name} не совпал с планом преобразования`)
    const recipe = recipes[0]
    const preserve = new Set(recipe.delta.filter(ingredient => ingredient.count < 0).map(ingredient => mcData.items[ingredient.id].name))
    // `count` is how many items the caller wants to own, and that is also how
    // recipesFor above read it (minResultCount). bot.craft reads the same number
    // as how many TIMES to run the recipe (craft.js: `for (let i = 0; i < count;
    // i++) await craftOnce(...)`), and for sticks the two disagree by a factor of
    // four. That is where sixteen planks went on 2026-08-31: the brain asked for
    // «палки, count 4» twice, got four crafts each time — eight planks a call,
    // 32 sticks — and then had nothing left to build the table it needed to leave.
    const perCraft = (recipe.result && recipe.result.count) || 1
    let times = Math.max(1, Math.min(Math.ceil(count / perCraft), affordableCrafts(bot, recipe)))

    // The same reserve idea as TOOL_RESERVE, in wood. Four planks are a crafting
    // table, a table is the 3x3 grid, and the grid is the only road to a stone
    // pickaxe — so at depth they are as untouchable as the swings for the climb.
    // Exempt: the table itself, and a caller that says outright it means to
    // spend them.
    const perCraftPlanks = planksPerCraft(recipe, mcData)
    let heldBack = 0
    if (perCraftPlanks > 0 && name !== 'crafting_table' && !spendReserve) {
      const fit = Math.floor(spendablePlanks(bot, mcData) / perCraftPlanks)
      if (fit <= 0) {
        throw new Error(
          `не трачу последние доски (их ${plankCount(bot)}): ${TABLE_PLANKS} держу на верстак, ` +
          'без него внизу не собрать ни кирку, ни меч. Нужно дерево — одно бревно даёт 4 доски. ' +
          'Если верстак не нужен, сначала скрафти crafting_table: с ним в рюкзаке доски снова свободны')
      }
      if (fit < times) { heldBack = times - fit; times = fit }
    }

    const outputRoom = async () => {
      const pack = require('./pack')
      const slots = pack.outputSlots(bot, name, times * perCraft) +
        (placed.length && !countOf(bot, 'crafting_table') ? 1 : 0)
      if (bot.inventory.emptySlotCount() < slots) await pack.makeRoom(bot, { slots, forItem: name, preserve, allowEqual: true })
      if (bot.inventory.emptySlotCount() < slots) throw new Error(`нет места для ${name} и возврата верстака — сначала разгрузи рюкзак; материалы не трачу`)
    }
    await outputRoom()
    const inputs = (recipe.delta || []).filter(d => d.count < 0).map(d => {
      const item = mcData.items[d.id]?.name
      return { item, before: item ? countOf(bot, item) : 0 }
    })
    const spent = () => inputs.some(i => i.item && countOf(bot, i.item) < i.before)
    const consumedError = () => new Error(`крафт ${name}: материалы списаны, результат не подтверждён — проверь дроп или сетку крафта; новый рецепт не запускаю`)
    const notes = []
    let usedTable = !!table
    try {
      await craftWithNudge(bot, recipe, times, table, ctl)
    } catch (err) {
      if (/missing ingredient/.test(err.message)) {
        const w = bot.currentWindow || bot.inventory
        const slots = w.slots.map((it, slot) => it && { slot, item: it.name, count: it.count }).filter(Boolean)
        throw new Error(`${err.message}: ${JSON.stringify({ window: w.id, cursor: w.selectedItem?.name ?? null, slots })}`)
      }
      // Opening a table that is merely "nearby" fails often on 1.21.11 — the
      // activate packet goes nowhere and mineflayer waits 20s for a window.
      // Crafting at a table we just placed under our own feet does work, so
      // that is the retry.
      if (!table || !/windowOpen|updateSlot/.test(err.message)) throw err
      if (spent()) throw consumedError()
      await reclaimAll()
      const fresh = await placeFreshTable(session, ctl)
      if (!fresh) throw new Error(`верстак не открылся и новый поставить не вышло: ${err.message}`)
      placed.push(fresh)
      await bot.lookAt(fresh.position.offset(0.5, 0.5, 0.5), true)
      const retry = bot.recipesFor(itemData.id, null, 1, fresh)
      if (!retry.length) throw new Error(`после переустановки верстака рецепт ${name} не собрался`)
      await outputRoom()
      await craftWithNudge(bot, retry[0], times, fresh, ctl)
      usedTable = true
      notes.push('верстак пришлось переставить')
    }

    await reclaimAll()
    await closeStrayWindow(bot)

    // Верстак на 1.21.11 иногда молчит: bot.craft возвращается без ошибки, а
    // сервер не скрафтил ничего и ничего не списал. Отчёт писал count = times ×
    // perCraft, и кампания 2026-09-26 дважды шла дальше «с киркой», которой нет
    // (деревянная в первом круге, каменная во втором: меч и топор есть, кирки
    // нет, булыжник и палки на неё целы). Считаем по рюкзаку — после сверки
    // invsync (~150 мс после окна) — и один раз повторяем у свежего верстака.
    let got = owned() - before
    if (got <= 0) { await sleep(400); got = owned() - before }
    if (got <= 0 && spent()) throw consumedError()
    if (got <= 0 && usedTable && !ctl.aborted) {
      const fresh = await placeFreshTable(session, ctl)
      if (fresh) {
        placed.push(fresh)
        await bot.lookAt(fresh.position.offset(0.5, 0.5, 0.5), true)
        const again = bot.recipesFor(itemData.id, null, 1, fresh)
        if (again.length) {
          await outputRoom()
          try { await craftWithNudge(bot, again[0], times, fresh, ctl) } catch {}
        }
        await reclaimAll()
        await closeStrayWindow(bot)
        await sleep(400)
        got = owned() - before
        if (got > 0) notes.push('первый заход верстак не принял — повторил у свежего')
      }
    }
    if (got <= 0) {
      if (spent()) throw consumedError()
      throw new Error(`крафт ${name} прошёл без ошибки, а в рюкзаке его не прибавилось — ` +
        'верстак не ответил (болезнь 1.21.11); повтори вызов')
    }

    const made = got
    const out: any = { crafted: name, count: made, usedTable }
    if (made !== count) out.asked = count
    if (heldBack) {
      notes.push(`сделал меньше: ${TABLE_PLANKS} доски оставил на верстак, без него внизу не скрафтить кирку`)
    }
    if (taken.length) {
      // The brain needs this as much as the scene does: a table left on the
      // floor forty blocks back is the same as no table at all.
      out.tableBack = taken.every(t => t.kept)
      for (const t of taken) if (t.note) notes.push(t.note)
    }
    if (notes.length) out.note = notes.join('; ')
    return out
  } finally {
    bot._ndCrafting = false
    // Never let the teardown mask the real error.
    try { await reclaimAll() } catch {}
    try { await closeStrayWindow(bot) } catch {}
    // Сорванный крафт в сетке 2×2 оставляет ингредиенты в ней — вернуть.
    try { require('./invsync').flushGrid(bot) } catch {}
  }
}

// Most items have several recipe variants (one per wood species, say). Naming
// the first one is actively misleading — "нужен cherry_planks" when the bot is
// carrying oak. Report the variant the bot is closest to completing.
// «oak_planks×2» and «cherry_planks×2» differ only in the wood, and the wood
// is exactly the part the bot can do nothing about: it has never seen cherry.
// Measured on the expedition — an empty bag makes all thirteen stick recipes
// equal, the tie broke on list order, and the refusal named a tree that does
// not grow anywhere the bot has been.
function sameKind (a, b) {
  if (a === b) return a
  const tail = s => (s.match(/_([a-z_]+×\d+)$/) || [])[1]
  const ta = tail(a)
  return ta && ta === tail(b) ? `любые ${ta}` : a
}

function describeMissing (bot, recipes, mcData) {
  const have = {}
  for (const i of bot.inventory.items()) have[i.type] = (have[i.type] || 0) + i.count

  let best = null
  for (const recipe of recipes) {
    const need = {}
    for (const d of recipe.delta || []) {
      if (d.count < 0) need[d.id] = (need[d.id] || 0) + (-d.count)
    }
    const parts = []
    let total = 0
    let untouched = 0
    for (const [id, n] of ((Object.entries(need) as [string, any][]) as any)) {
      const owned = have[id] || 0
      const short = n - owned
      if (short > 0) {
        total += short
        // An ingredient we own none of means a whole separate sub-quest.
        // Counting those first keeps "3 доски + шерсть которая уже есть" from
        // losing to "покрасить чёрную кровать, которой тоже нет".
        if (owned === 0) untouched++
        parts.push(`${mcData.items[id] ? mcData.items[id].name : id}×${short}`)
      }
    }
    if (!best || untouched < best.untouched || (untouched === best.untouched && total < best.total)) {
      best = { untouched, total, parts }
    } else if (untouched === best.untouched && total === best.total) {
      // A tie between wood types is not a choice, it is a coincidence: say the
      // thing they have in common instead of picking one at random.
      for (let i = 0; i < best.parts.length && i < parts.length; i++) {
        best.parts[i] = sameKind(best.parts[i], parts[i])
      }
    }
  }

  // Null, not a vague sentence: the caller has to be able to tell "nothing is
  // missing" from "something is missing and I cannot name it".
  if (!best || !best.parts.length) return null
  const suffix = recipes.length > 1 ? ` (вариантов рецепта: ${recipes.length}, показан ближайший)` : ''
  return best.parts.join(', ') + suffix
}

// ---------------------------------------------------------------- equip / eat / drop

async function equip (session, { item: name, destination = 'hand' }: any = {}) {
  const bot = session.bot
  const item = itemNamed(bot, name)
  if (!item) throw new Error(`нет ${name} в инвентаре`)
  await bot.equip(item, destination)
  return { equipped: name, destination }
}

// Things that feed you and then hurt you. Eaten only when there is nothing
// else, because a bot that clears a cave comes home with a bag of rotten flesh.
const RISKY_FOOD = /^(rotten_flesh|spider_eye|poisonous_potato|pufferfish|chicken|suspicious_stew)$/

// minecraft-data 1.21.11 lists salmon_bucket / cod_bucket / pufferfish_bucket /
// tropical_fish_bucket in foodsByName, and they are not edible at all — using
// one spills a fish on the floor. Their score (3.6) beats rotten flesh (-89.6),
// so without this the bag-of-flesh case picks a bucket and eats nothing.
const NOT_ACTUALLY_FOOD = /_bucket$/

// mineflayer refuses to consume anything else at food 20 ("Food is full").
const ALWAYS_EDIBLE = /^(potion|milk_bucket|golden_apple|enchanted_golden_apple)$/

// A bite takes 1.61s in vanilla; mineflayer waits 2.5s for its own confirmation
// packet before giving up. 4s covers both plus server lag, and the poll returns
// the instant the food bar actually moves, so the normal case still costs ~1.6s.
const EAT_WATCH_MS = 4000

// Equipping a meal moves its whole stack out of inventory.items() (slots 9..44).
// Slot 45 is still carried food; moving it is not a witnessed bite.
function mealItems (bot) {
  const bag = bot.inventory.items()
  const off = bot.inventory.slots?.[45]
  return off && !bag.some(i => i === off || i.slot === 45) ? [...bag, off] : bag
}

function bestFood (bot, mcData) {
  const edible = mealItems(bot)
    .filter(i => !NOT_ACTUALLY_FOOD.test(i.name))
    .map(i => ({ item: i, data: mcData.foodsByName[i.name] }))
    .filter(e => e.data)
  if (!edible.length) return null
  const score = e => (e.data.foodPoints || 0) + (e.data.saturation || 0) - (RISKY_FOOD.test(e.item.name) ? 100 : 0)
  edible.sort((a, b) => score(b) - score(a))
  return edible[0].item
}

// The bar, not the promise. bot.consume() resolves on a confirmation packet the
// server may never send, and it is aborted outright by any second bite —
// including the autopilot's, which fires every second below food 16 and cancels
// ours with "Consuming cancelled due to calling bot.consume() again". If the
// food bar went up, the bot ate, whatever the promise says.
async function untilFoodRises (bot, before, timeoutMs, giveUp) {
  const deadline = gameClock.now() + timeoutMs
  while (gameClock.now() < deadline) {
    if ((bot.food ?? 0) > before) return true
    if (giveUp && giveUp()) break
    await sleep(200)
  }
  return (bot.food ?? 0) > before
}

// The next failure has to be diagnosable from one run, so the full original text
// goes into the answer. mineflayer throws plain Errors, node AssertionError and
// TypeError on this path, and a bare "Cannot read properties of null" says
// nothing about which of them it was or where it came from.
function describeFailure (err, during) {
  if (!err) return null
  const name = (err && err.name) || typeof err
  const message = String((err && err.message) || err)
  const at = err && err.stack
    ? String(err.stack).split('\n').slice(1, 3).map(s => s.trim()).join(' <- ')
    : null
  const out: any = { during, error: `${name}: ${message}` }
  if (at) out.at = at
  return out
}

// The captured Item object goes stale the moment the server resyncs a slot: its
// .slot then points at whatever moved in, so re-equipping by that reference puts
// the wrong thing in the hand — or clicks slot undefined and throws an
// AssertionError over an otherwise successful meal. Look the item up again by
// type, and never let this step decide the outcome.
async function restoreHand (bot, previous, food) {
  if (!previous || previous.type === food.type) return null
  try {
    const again = mealItems(bot).find(i => i.type === previous.type)
    if (!again) return { error: `прежний предмет (${previous.name}) в руку не вернулся: его больше нет в инвентаре` }
    await bot.equip(again, 'hand')
    return null
  } catch (err) {
    return describeFailure(err, 'вернуть предмет в руку')
  }
}

// Never rejects. Every failure here is recoverable — no food, a full bar, a bite
// the server ignored — and rejecting turns all of them into one WebSocket error
// with no detail at all: that is exactly the pair of "поесть RPC null" lines in
// diamond4.log, one of which was a bot that had just died with an empty bag.
async function eat (session, { item: name }: any = {}) {
  const bot = session.bot
  const mcData = session.mcData
  const foodBefore = bot.food ?? 0

  // A full bar is not a failure, and mineflayer's raw "Food is full" reaching
  // the brain as an error is worse than useless — it reads as "eating is
  // broken". Health regenerates on its own above 18 food, so the honest answer
  // is that there is nothing to do here.
  if (!name && foodBefore >= 20) {
    return { note: 'сыт, есть не стал — здоровье и так восстанавливается', food: Math.round(foodBefore) }
  }

  const food = name ? mealItems(bot).find(i => i.name === name) : bestFood(bot, mcData)
  if (!food) {
    return {
      ate: null,
      note: name ? `нет ${name} в инвентаре` : 'еды в инвентаре нет',
      food: Math.round(foodBefore),
      slotsUsed: bot.inventory.items().length,
      offHand: bot.inventory.slots?.[45] ? { item: bot.inventory.slots[45].name, count: bot.inventory.slots[45].count } : null
    }
  }

  // Asking the world first is both faster and a better answer than relaying
  // mineflayer's exception for the same thing.
  if (foodBefore >= 20 && !ALWAYS_EDIBLE.test(food.name)) {
    return { note: 'сыт, есть не стал', food: Math.round(foodBefore), tried: food.name }
  }

  const owned = n => mealItems(bot).reduce((s, i) => s + (i.name === n ? i.count : 0), 0)
  const hadCount = owned(food.name)
  // Еда — immediate: session.current — чужое намерение, часто уже прерванное тактикой (sr-1010 10.10: «не поел» за 2 тика при
  // 12 стейках, хп 13 → 6 → смерть). Сдаваться — только если его прервали во время еды.
  const ctl0 = session.current?.ctl
  const aborted0 = !!ctl0?.aborted
  const stopped = () => !aborted0 && !!ctl0?.aborted
  const previous = bot.heldItem
  const { consumeInOffhand, restoreOffhand } = require('./consumable-hands')
  const offHand = consumeInOffhand(bot)
  const previousOff = bot.inventory.slots?.[45]

  let failure = null
  try {
    await bot.equip(food, offHand ? 'off-hand' : 'hand')
  } catch (err) {
    failure = describeFailure(err, 'взять еду в руку')
  }

  if (!failure) {
    let thrown = null
    // Started, never awaited as the verdict: its rejection is only evidence.
    const consuming = (offHand ? Promise.resolve().then(() => bot.activateItem(true)) : bot.consume()).then(() => null, err => { thrown = err })
    // Only one rejection is allowed to cut the watch short. "Food is full" is
    // refused before any packet leaves, so nothing can happen afterwards; every
    // other rejection — the cancelled bite above especially — still leaves a
    // meal in flight, and bailing on it would throw away a successful one.
    const fed = await untilFoodRises(bot, foodBefore, EAT_WATCH_MS,
      () => owned(food.name) < hadCount || stopped() || !!thrown && /food is full/i.test(String((thrown && thrown.message) || thrown)))
    if (!fed && owned(food.name) >= hadCount) {
      await consuming
      failure = describeFailure(thrown, 'съесть') ||
        { during: 'съесть', error: 'ошибки не было, но сытость не выросла за 4с' }
    }
  }

  let handBack = null
  if (offHand) {
    try { bot.deactivateItem(); await restoreOffhand(bot, previousOff, food) } catch (err) { handBack = describeFailure(err, 'вернуть предмет во вторую руку') }
  } else handBack = await restoreHand(bot, previous, food)
  // Keep the remaining meal in the spendable bag, including a resumed stack
  // left in the second hand by an earlier interrupted meal. Preserve new gear.
  const remaining = bot.inventory.slots?.[45]
  if (remaining && (remaining.name === food.name || remaining.name === previousOff?.name) &&
      mcData.foodsByName[remaining.name] && !NOT_ACTUALLY_FOOD.test(remaining.name) && bot.inventory.emptySlotCount() > 0) {
    try { await bot.unequip('off-hand') } catch (err) { handBack = describeFailure(err, 'вернуть остаток еды в рюкзак') }
  }
  const foodAfter = bot.food ?? 0
  // Two independent witnesses, because either one alone can lie: the bar does
  // not move if exhaustion spends the point in the same second (digging and
  // fighting both do that), and the stack does not shrink if it was the
  // autopilot's bite that fed us.
  const spent = hadCount - owned(food.name)

  if (foodAfter > foodBefore || spent > 0) {
    const out: any = { ate: food.name, hand: offHand ? 'off-hand' : 'hand', food: Math.round(foodAfter), gain: Math.round(foodAfter - foodBefore), spent }
    if (spent <= 0) out.note = 'сытость выросла, но свой кусок цел — успел автопилот'
    if (foodAfter <= foodBefore) out.note = 'кусок съеден, но полоска не выросла — голод съедает быстрее'
    // Kept even on success: this is the only place the cancelled-bite text ever
    // shows up once the world says the meal happened anyway.
    if (failure) out.despite = failure.error
    if (handBack) out.handBack = handBack.error
    return out
  }

  if (failure && /food is full/i.test(failure.error)) {
    return { note: 'сыт, есть не стал', food: Math.round(foodAfter), tried: food.name }
  }

  // Everything the next run needs to tell the cases apart without a third
  // attempt: an open window makes equip click the wrong slots, and a running
  // intent means something else was moving the same inventory at the same time.
  const out: any = {
    ate: null,
    note: 'не поел',
    tried: food.name,
    food: Math.round(foodAfter),
    held: bot.heldItem ? bot.heldItem.name : null,
    windowOpen: bot.currentWindow ? (bot.currentWindow.type || bot.currentWindow.id) : null,
    busy: session.current ? session.current.name : null,
    offHand: bot.inventory.slots?.[45] ? { item: bot.inventory.slots[45].name, count: bot.inventory.slots[45].count } : null
  }
  Object.assign(out, failure)
  if (handBack) out.handBack = handBack.error
  return out
}

async function drop (session, { item: name, count }: any = {}) {
  const bot = session.bot
  const item = itemNamed(bot, name)
  if (!item) throw new Error(`нет ${name} в инвентаре`)
  await bot.toss(item.type, null, count ?? item.count)
  return { dropped: name, count: count ?? item.count }
}

// ---------------------------------------------------------------- sleep

const isBed = b => !!b && /_bed$/.test(b.name)

// facing on a bed points from the foot toward the head.
const BED_FACING = { north: [0, -1], south: [0, 1], west: [-1, 0], east: [1, 0] }
const CARDINALS = [[0, -1], [0, 1], [-1, 0], [1, 0]]

function bedProps (block) {
  try { return block.getProperties() || {} } catch { return {} }
}

// Which half is which. Checked against all 16 bed states on 1.21.11:
// mineflayer's own state decoding is correct, so the metadata is trustworthy —
// but the world is trusted over it anyway, because the failure being fixed here
// is exactly the case where the two disagree.
function bedHalves (bot, block) {
  const props = bedProps(block)
  const out = { props, head: null, foot: null }
  if (props.part === 'head') out.head = block
  else if (props.part === 'foot') out.foot = block

  const dir = BED_FACING[props.facing]
  if (dir) {
    const away = props.part === 'head' ? [-dir[0], -dir[1]] : dir
    const other = bot.blockAt(block.position.offset(away[0], 0, away[1]))
    if (isBed(other)) {
      if (props.part === 'head') out.foot = other
      else out.head = other
    }
  }

  if (!out.head || !out.foot) {
    for (const [dx, dz] of CARDINALS) {
      const nb = bot.blockAt(block.position.offset(dx, 0, dz))
      if (!isBed(nb)) continue
      const part = bedProps(nb).part
      if (part === 'head' && !out.head) out.head = nb
      if (part === 'foot' && !out.foot) out.foot = nb
    }
  }
  return out
}

// "there's only half bed" on its own tells the brain nothing it can act on.
// Dump what the two squares actually are so the next attempt is informed.
function describeBed (bot, block) {
  const around = CARDINALS.map(([dx, dz]) => {
    const nb = bot.blockAt(block.position.offset(dx, 0, dz))
    return `${dx},${dz}:${nb ? nb.name : 'null'}`
  })
  const p = xyz(block.position)
  return `${block.name}@${p.x},${p.y},${p.z} ${JSON.stringify(bedProps(block))} вокруг[${around.join(' ')}]`
}

const BED_ERRORS = [
  [/only half bed/, 'вторая половина кровати не видна — кровать легла криво или чанк не догрузился'],
  [/not night/, 'ещё не ночь и грозы нет'],
  [/bed is occupied/, 'кровать занята'],
  [/bed is too far/, 'до кровати далеко'],
  [/cant click the bed/, 'до кровати не дотянуться, что-то мешает'],
  [/monsters nearby/, 'рядом мобы — сначала разогнать'],
  [/not sleeping/, 'сервер не подтвердил сон'],
  [/already sleeping/, 'уже сплю'],
  [/not a bed block/, 'это не кровать']
]

function translateBedError (message) {
  for (const [re, text] of (BED_ERRORS as any)) if (re.test(message)) return text
  return message
}

// The server refuses outright before we ever click, and its reasons are things
// the brain can actually fix. Naming which one beats a generic failure.
function whyNotSleep (bot) {
  if (bot.isSleeping) return 'уже сплю'
  // Вне верхнего мира кровать взрывается при попытке лечь (damage_type
  // bad_respawn_point) — самая дешёвая гарантированная смерть в Аду. Отказ до
  // постановки: часы тут ничего не решают.
  const dim = bot.game && bot.game.dimension
  if (dim && dim !== 'overworld') {
    return `${dim === 'the_nether' ? 'в Аду' : 'здесь'} кровать взрывается — не ставлю и не ложусь. Переждать можно в mc_shelter, ` +
      'точка возрождения переносится только в верхнем мире'
  }
  const t = bot.time ? bot.time.timeOfDay : 0
  // Гроза — по уровню грозы (perception.thundering, 2026-09-26): флаг
  // bot.isRaining на Paper вывернут и под дождём не встаёт.
  const storm = require('./perception').thundering(bot)
  if (!storm && !(t >= 12541 && t <= 23458)) return `спать можно только ночью или в грозу (сейчас ${t} тиков)`
  return null
}

// Vanilla drops the foot where you click and stretches the head away from you,
// so a bed needs two free squares in a row with solid ground under both — and
// the bot has to stand in line with them, because the server reads the head
// direction off our yaw. place() only ever guarantees one square, which is how
// beds ended up facing into a wall.
async function placeBed (session, ctl, name) {
  const bot = session.bot
  const item = itemNamed(bot, name)
  if (!item) throw new Error(`нет ${name} в инвентаре`)

  const feet = bot.entity.position.floored()
  const head = feet.offset(0, 1, 0)
  const free = p => { const b = bot.blockAt(p); return !!b && b.boundingBox === 'empty' && !/water|lava/.test(b.name) }
  const solid = p => { const b = bot.blockAt(p); return !!b && b.boundingBox === 'block' }
  const mine = p => p.equals(feet) || p.equals(head)

  const spots = []
  for (const [dx, dz] of CARDINALS) {
    for (let d = 1; d <= 3; d++) {
      for (const dy of [0, -1, 1]) {
        const foot = feet.offset(dx * d, dy, dz * d)
        const bedHead = foot.offset(dx, 0, dz)
        if (mine(foot) || mine(bedHead)) continue
        if (!free(foot) || !free(bedHead)) continue
        if (!solid(foot.offset(0, -1, 0)) || !solid(bedHead.offset(0, -1, 0))) continue
        if (!free(foot.offset(0, 1, 0)) || !free(bedHead.offset(0, 1, 0))) continue
        spots.push({ ground: bot.blockAt(foot.offset(0, -1, 0)), foot, bedHead, dist: d })
      }
    }
  }
  if (!spots.length) throw new Error('негде поставить кровать — нужны две свободные клетки в ряд на твёрдой земле')
  spots.sort((a, b) => a.dist - b.dist)

  await bot.equip(item, 'hand')
  let last = null
  for (const spot of spots.slice(0, 8)) {
    if (ctl.aborted) break
    try {
      await withTimeout(bot.placeBlock(spot.ground, new Vec3(0, 1, 0)), 6000)
      await sleep(300) // the second half arrives in its own block update
      if (isBed(bot.blockAt(spot.foot))) return { at: xyz(spot.foot), aimedHead: xyz(spot.bedHead) }
    } catch (e) {
      last = e
      // The server may have applied it anyway; we only stopped waiting.
      if (isBed(bot.blockAt(spot.foot))) {
        return { at: xyz(spot.foot), aimedHead: xyz(spot.bedHead), note: 'подтверждения не дождался' }
      }
    }
  }
  throw new Error(`не смог поставить кровать${last ? ': ' + last.message : ''}`)
}

// Sleeping is the actual answer to "survive the night" — it skips the night and
// resets the spawn point, which matters a lot for a bot that keeps dying.
//
// The old failure was self-inflicted. findBlock returns whichever half is
// nearest, and mineflayer only goes hunting for the missing half when you hand
// it the FOOT — that search is the single place "there's only half bed" is
// thrown. Hand it the HEAD and the branch cannot run at all.
async function sleepInBed (session, ctl, { untilMorning = true, waitSeconds = 40 }: any = {}) {
  const bot = session.bot
  const blocked = whyNotSleep(bot)
  if (blocked) throw new Error(blocked)

  let bed = bot.findBlock({ matching: isBed, maxDistance: 8 })
  let placedNote = null

  if (!bed) {
    const item = itemMatching(bot, /_bed$/)
    if (!item) throw new Error('кровати нет ни рядом, ни в инвентаре')
    const put = await placeBed(session, ctl, item.name)
    placedNote = put.note
    bed = bot.findBlock({ matching: isBed, maxDistance: 8 })
    if (!bed) throw new Error(`поставил кровать на ${put.at.x},${put.at.y},${put.at.z}, но в мире её не вижу`)
  }

  const halves = bedHalves(bot, bed)
  const target = halves.head || halves.foot || bed

  // mineflayer measures the click box from the head, not from whichever half we
  // happened to spot first, so close the distance to the half being clicked.
  const p = target.position
  if (p.distanceTo(bot.entity.position) > 2.2) {
    try { await bot.pathfinder.goto(new goals.GoalNear(p.x, p.y, p.z, 1)) } catch {}
  }

  try {
    await bot.sleep(target)
  } catch (err) {
    throw new Error(`не лёг спать: ${translateBedError(err.message)} · ${describeBed(bot, bed)}`)
  }

  const out: any = {
    sleeping: true,
    at: xyz(p),
    half: bedProps(target).part || '?',
    bothHalves: !!(halves.head && halves.foot),
    note: placedNote || undefined
  }
  if (!untilMorning) return out

  // Lying down is not the point — skipping the night is. The server only fires
  // the skip about 100 ticks after everyone is in bed, so a call that returns
  // the instant the bot is horizontal has done nothing useful yet.
  const deadline = gameClock.now() + Math.max(5, Math.min(120, waitSeconds)) * 1000
  while (gameClock.now() < deadline && !ctl.aborted && bot.isSleeping) {
    const t = bot.time ? bot.time.timeOfDay : 0
    if (t < 12541 || t > 23458) break
    await sleep(500)
  }
  // The server wakes us the moment it skips the night, and the time packet
  // lands a beat later — read it too early and the result claims morning while
  // still showing a night clock.
  await sleep(600)
  out.morning = !bot.isSleeping || (bot.time && bot.time.timeOfDay < 12541)
  out.timeOfDay = bot.time ? bot.time.timeOfDay : null
  if (!out.morning) out.note = 'ночь не проскочила — видимо, кто-то ещё не спит'
  return out
}

async function wakeUp (session) {
  const bot = session.bot
  if (!bot.isSleeping) return { note: 'и так не сплю' }
  await bot.wake()
  return { woke: true }
}

module.exports = {
  mine, digDown, explore, place, craft, equip, eat, drop, sleepInBed, wakeUp,
  swarmWork: (...args) => require('./swarm-work').swarmWork(...args),
  collectNearbyDrops, reachBlock, ensureTable, placeBed, bedHalves, describeBed,
  digStairs, GROUPS,
  // preflight.js counts «еда в дорогу» by the same two rules bestFood picks by,
  // and takes them from here when they are exported: one list, not two to drift.
  RISKY_FOOD, NOT_ACTUALLY_FOOD, bestFood
}
