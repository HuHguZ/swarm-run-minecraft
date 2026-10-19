const { PILLAR, CLIMBERS, REFUGE_NEUTRAL, HOT_CELL, MOB_REACH, chaseBps, holePlan, pocketOf } = require('./surface-body')
const { gameClock, worlds, placeBlockAt, digUp, pickFiller, withTimeout, occupiedByEntity, sleep, xyz, travelXZ, inWater, findNearestLand, findSwimRoute, escapeWater, Vec3, exitShelter }: typeof import('./enter-shelter') = require('./enter-shelter')
function pillarPlan (bot, blocks, foes, shooters) {
  if (blocks < PILLAR || shooters.length) return null
  if (foes.some(h => CLIMBERS.test(h.e.name) || h.e.name === 'creeper' || (h.doc.radius === 0 && h.doc.range))) return null
  const feet = (require('.././fortify') as typeof import('.././fortify')).feetCell(bot)
  const lift = standTop(bot, feet)
  if (blocks < PILLAR + lift) return null
  // Над головой свободно на весь подъём и прыжок с верха.
  for (let k = 2; k <= PILLAR + lift + 2; k++) {
    const b = bot.blockAt(feet.offset(0, k, 0))
    if (!b || b.boundingBox !== 'empty' || /water|lava/.test(b.name)) return null
  }
  return { height: PILLAR + lift, lift, ms: 300 + (PILLAR + lift) * 600 }
}

function standTop (bot, feet) {
  const h = []
  for (let dx = -1; dx <= 1; dx++) {
    for (let dz = -1; dz <= 1; dz++) {
      if (!dx && !dz) continue
      let k = 0
      while (k < 3) {
        const b = bot.blockAt(feet.offset(dx, k, dz))
        if (!b || b.boundingBox !== 'block') break
        k++
      }
      h.push(k)
    }
  }
  const one = h.some(k => k === 1)
  if (h.some(k => k >= 2) && one) return 2
  return one ? 1 : 0
}

function grounded (bot) {
  const g = Object.create(bot)
  g.entity = Object.create(bot.entity)
  g.entity.onGround = true
  g.entity.isInWater = false
  return g
}

// Neutral species can still be the pursuer: use the observed anger flag or
// the existing damage-event attacker memory, never missing gold as proof.
function refugeFoe (bot, e, session = bot._ndGuard?.session) {
  if (!e || e.isValid === false) return false
  if (!REFUGE_NEUTRAL.test(e.name)) return true
  if ((require('../combat') as typeof import('../combat')).liveAttacker(session)?.id === e.id) return true
  if ((require('../ne-guard') as typeof import('../ne-guard')).aggressive(bot, e)) return true
  if (e.name === 'enderman') {
    const i = bot.registry?.entitiesByName.enderman?.metadataKeys?.indexOf('creepy') ?? -1
    return i >= 0 && !!e.metadata?.[i]
  }
  return false
}

function refugeThreats (bot, session, radius = 16) {
  const flee: typeof import('.././flee') = require('.././flee')
  // Гаст стреляет с 64 блоков: дальнего стрелка учитываем только в его дальности и на виду.
  return flee.hostilesAround(bot, Math.max(radius, flee.DOCTRINE.ghast.range))
    .filter(h => refugeFoe(bot, h.e, session) && (h.d <= radius ||
      (h.doc.range && h.d <= h.doc.range && (require('.././assess') as typeof import('.././assess')).inSight(bot, h.e))))
}

function refugeLook (session, { radius = 16 }: any = {}) {
  const bot = session.bot
  const t0 = gameClock.now()
  const fortify: typeof import('.././fortify') = require('.././fortify')
  const assess: typeof import('.././assess') = require('.././assess')
  const dim = worlds.worldOf(bot)
  const nether = dim === 'the_nether'
  const feet = fortify.feetCell(bot)
  const me = bot.entity.position
  const foes = refugeThreats(bot, session, radius)
  // Ходячий — угроза, если он на нашем уровне (±4): со скалы в 10 блоках не спустится за стройку.
  const walkers = foes.filter(h => h.d <= radius && h.doc.radius > 0 && Math.abs(h.e.position.y - me.y) <= 4)
  const shooters = foes.filter(h => h.doc.range && h.d <= h.doc.range && assess.inSight(bot, h.e))
  const near = walkers[0] || null
  const creeper = foes.find(h => h.e.name === 'creeper' && (h.d <= 9 || h.swelling))
  const blocks = (require('.././pack') as typeof import('.././pack')).buildCount(bot, dim)
  let lava = !!bot.entity.isInLava
  for (const dy of [0, 1]) {
    const b = bot.blockAt(me.offset(0, dy, 0))
    if (b && HOT_CELL.test(b.name)) lava = true
  }
  const from = near ? near.e.position : shooters[0] ? shooters[0].e.position : null
  const cell = fortify.refugeCell(bot, from, { have: blocks, foes: foes.map(h => h.e) })
  const filler = fortify.refugeFiller(grounded(bot), cell?.blocks ?? 10)
  const a: any = {
    dim,
    nether,
    water: inWater(bot),
    lava,
    foes: foes.length,
    walkers: walkers.length,
    shooters: shooters.length,
    nearest: near ? {
      name: near.e.name,
      d: Math.round(near.d * 10) / 10,
      etaMs: Math.round(Math.max(0, Math.hypot(near.e.position.x - me.x, near.e.position.z - me.z) - MOB_REACH) / chaseBps(near.e.name) * 1000)
    } : null,
    creeper: creeper ? { d: Math.round(creeper.d * 10) / 10, swelling: !!creeper.swelling } : null,
    // Ходячий в 16 бл. придёт — укрытие ставить сейчас, пока он идёт (нора его
    // не остановит: выход из норы под ним — самое уязвимое место отхода).
    foeClose: !!near || shooters.length > 0,
    blocks,
    filler: filler ? filler.name : null,
    pickaxe: !!fortify.pickaxeOf(bot),
    // Как будто стоим на полу: оценка бывает в прыжке после рывка, а копка в
    // воздухе впятеро дольше (digTime notOnGround) — «не выломаться» было ложным.
    canBreakOut: filler ? fortify.canBreakOut(grounded(bot), filler) : false,
    hole: nether ? null : holePlan(grounded(bot), session.mcData, feet),
    pillar: pillarPlan(bot, blocks, foes, shooters),
    pocket: 0,
    cell: cell || null
  }
  const pocket = pocketOf(bot, foes)
  a.pocket = pocket ? pocket.size : 0
  // Ниша в стене (ND_REFUGE_NICHE=1): вкопаться на клетку и заложить проём — fortify.nichePlan.
  a.niche = null
  if (nicheOn()) {
    try {
      const np = fortify.nichePlan(grounded(bot), feet, { away: from })
      if (np) a.niche = { side: np.side, cell: np.cell, digMs: np.digMs, ms: np.digMs + 300 + 2 * 180 + 300 }
    } catch {}
  }
  a.ms = gameClock.now() - t0
  return a
}

const nicheOn = () => process.env.ND_REFUGE_NICHE !== '0'

function chooseRefuge (a) {
  if (a.lava) return { how: 'flee', code: 'LAVA', why: 'в лаве или огне — не место для укрытия' }
  if (a.water) return { how: 'flee', code: 'IN_WATER', why: 'в воде не закрыться' }
  // Крипер. Закрытая коробка от него держит: SwellGoal.tick гасит фитиль без прямой видимости, а взрыв за целой стеной
  if (a.creeper && (process.env.ND_CREEPER_DODGE === '0' || a.creeper.swelling || a.creeper.d <= 4)) {
    return { how: 'flee', why: `крипер в ${a.creeper.d} бл.${a.creeper.swelling ? ' шипит' : ''} — коробка его не держит, стоять в ней значит не убежать` }
  }
  if (a.pocket) return { how: 'pocket', why: 'вокруг замкнутый карман без врагов — строить нечего' }
  const box = !!a.cell && a.canBreakOut
  // Под стрелком нору не копать: 3 с на месте под прицелом — 3–4 стрелы (C:
  // скелет в 1.5 бл., хп 10 → 0 в недокопанной норе). Сперва из-под прицела.
  const hole = !!a.hole && !a.nether && !a.shooters
  const boxWhy = () => `коробка: ${a.cell.walls ? `стен готовых ${a.cell.walls}, ` : ''}${a.cell.blocks} бл. из ${a.blocks}` +
    (a.cell.dist ? `, клетка в ${a.cell.dist} бл.` : '')
  const pillar = !!a.pillar
  const pillarWhy = `столб в ${a.pillar ? a.pillar.height : PILLAR}: ходячие рукой не достанут (блоков ${a.blocks})`
  // Ниша быстрее коробки (пещера, склон) или коробки нет — в нишу.
  const boxMs = box ? (require('.././fortify') as typeof import('.././fortify')).refugeBuildMs(a.cell) + (a.cell.dist || 0) / 4.3 * 1000 : Infinity
  const nicheWhy = () => `ниша в стене: копать ~${(a.niche.digMs / 1000).toFixed(1)} с, заложить 2 бл.`
  if (a.foeClose && a.niche && a.niche.ms < boxMs && (a.blocks >= 2)) return { how: 'niche', why: nicheWhy() }
  if (a.foeClose && box) return { how: 'box', why: boxWhy() }
  if (a.foeClose && pillar) return { how: 'pillar', why: pillarWhy }
  if (hole) return { how: 'hole', why: `нора вниз на ${a.hole.depth} (~${(a.hole.ms / 1000).toFixed(1)} с)` }
  if (box) return { how: 'box', why: boxWhy() }
  if (pillar) return { how: 'pillar', why: pillarWhy }
  if (a.cell && !a.canBreakOut) return { how: 'flee', code: 'NO_BLOCKS', why: `из коробки из ${a.filler} не выломаться — нет кирки` }
  return {
    how: 'flee',
    code: 'NO_BLOCKS',
    why: a.nether
      ? `в Аду вниз не копаю, а на коробку блоков нет (${a.blocks})`
      : a.hole && a.shooters
        ? `на коробку блоков нет (${a.blocks}), а нору под стрелком не копаю`
        : `на коробку блоков нет (${a.blocks}), пол не копается`
  }
}

function buildMsOf (a, how) {
  if (how === 'niche' && a.niche) return a.niche.ms
  if (how === 'box' && a.cell) return (require('.././fortify') as typeof import('.././fortify')).refugeBuildMs(a.cell) + a.cell.dist / 4.3 * 1000
  if (how === 'hole' && a.hole) return a.hole.ms * 2 / 3 // на 2 вниз рука моба уже не достаёт
  if (how === 'pillar' && a.pillar) return 300 + PILLAR * 600
  return 0
}

function outrun (a, how) {
  if (!a.nearest || (how !== 'box' && how !== 'hole' && how !== 'pillar' && how !== 'niche')) return false
  return a.nearest.etaMs < buildMsOf(a, how)
}

function lookLine (a) {
  const bits = [a.dim === 'the_nether' ? 'Ад' : a.dim === 'the_end' ? 'Энд' : 'верхний мир']
  bits.push(a.foes ? `врагов ${a.foes}${a.nearest ? `, ближний ${a.nearest.name} в ${a.nearest.d} бл. (дойдёт за ${(a.nearest.etaMs / 1000).toFixed(1)} с)` : ''}` : 'врагов нет')
  if (a.creeper) bits.push(`крипер в ${a.creeper.d} бл.`)
  bits.push(`блоков ${a.blocks}${a.filler ? ` (${a.filler}${a.canBreakOut ? '' : ', не выломаться'})` : ''}`)
  if (a.cell) bits.push(`клетка ${a.cell.cell.x},${a.cell.cell.y},${a.cell.cell.z} (${a.cell.blocks} бл., стен ${a.cell.walls})`)
  if (a.hole) bits.push(`нора ~${(a.hole.ms / 1000).toFixed(1)} с`)
  if (a.pocket) bits.push(`карман ${a.pocket} кл.`)
  if (a.niche) bits.push(`ниша ~${(a.niche.ms / 1000).toFixed(1)} с`)
  if (a.water) bits.push('в воде')
  if (a.lava) bits.push('в огне')
  return bits.join('; ')
}

const REFUGE_FOOD_BAD = /^(rotten_flesh|spider_eye|poisonous_potato|pufferfish|chicken|suspicious_stew)$/

function hasFood (session) {
  const bot = session.bot
  const foods = (session.mcData && session.mcData.foodsByName) || (bot.registry && bot.registry.foodsByName) || {}
  const meal = (require('.././actions') as typeof import('.././actions')).bestFood(bot, { foodsByName: foods })
  return !!meal && !REFUGE_FOOD_BAD.test(meal.name)
}

async function healStep (session, ctl, minHp) {
  const bot = session.bot
  const kit: typeof import('.././fightkit') = require('.././fightkit')
  const hp = bot.health ?? 0
  if (hp >= minHp) return null
  const apple = !kit.hasEffect(bot, 'absorption') && hp <= 8 &&
    (bot.inventory.items().find(i => i.name === 'enchanted_golden_apple') || bot.inventory.items().find(i => i.name === 'golden_apple'))
  const potion = hp <= 10 && (kit.findPotion(bot, 'healing', { splash: false }) || kit.findPotion(bot, 'regeneration', { splash: false }))
  const pick = apple || potion
  if (pick) {
    session.eating = true
    try { if (await kit.consume(bot, pick, apple ? 'absorption' : null)) return pick.name } finally { session.eating = false }
  }
  if ((bot.food ?? 0) < 20 && hasFood(session)) {
    session.eating = true
    try {
      const r = await (require('.././actions') as typeof import('.././actions')).eat(session, {})
      if (r && r.ate) return r.ate
    } catch {} finally { session.eating = false }
  }
  return null
}

function holdMouth (session, ctl) {
  const entry = ctl && ctl.entry
  if (!entry || ctl.aborted || session.current === entry) return
  if (!session.current || session.current.name === 'wait') session.current = entry
}

async function holdOut (session, ctl, { kind, box = null, minHp, deadline, note, topY = null }: any) {
  const bot = session.bot
  const fortify: typeof import('.././fortify') = require('.././fortify')
  const flee: typeof import('.././flee') = require('.././flee')
  const st: any = { ate: [], patched: 0, breaches: 0, why: null }
  let lastHp = bot.health ?? 0
  let hurtAt = 0
  const hurtTimes = []
  let lastPatch = 0
  while (!ctl.aborted) {
    holdMouth(session, ctl)
    const hp = bot.health ?? 0
    if (hp <= 0) { st.why = 'died'; break }
    if (hp < lastHp) { hurtAt = gameClock.now(); hurtTimes.push(hurtAt) }
    lastHp = hp
    if (hp >= minHp) {
      // Вылечился — доесть до 18 перед выходом, если есть что: снаружи бой.
      if ((bot.food ?? 0) < 18 && hasFood(session)) {
        const got = await healStep(session, ctl, 21)
        if (got) st.ate.push(got)
      }
      st.why = 'healed'
      break
    }
    if (gameClock.now() >= deadline) { st.why = 'timeout'; break }
    // Стены. Нору латает её караул (armShelterGuard); коробку — здесь.
    if (kind === 'box' && box) {
      const enc = fortify.enclosure(bot, box.cell)
      if (!enc.sealed && gameClock.now() - lastPatch > 400) {
        st.breaches++
        lastPatch = gameClock.now()
        const n = await fortify.refugePatch(bot, box, { ctl })
        st.patched += n
        if (!n && !st.noFill && !(require('.././build') as typeof import('.././build')).pickFiller(bot, { steady: true })) { st.noFill = true; note('латать нечем — коробка открыта') }
      }
    }
    // Бьют внутри закрытого укрытия — кто-то внутри или рядом с дырой, которую
    // не заложить: сидеть дальше значит умереть на месте.
    const closeFoe = flee.hostilesAround(bot, 3).find(h => refugeFoe(bot, h.e, session) && h.d < 2.2)
    if (gameClock.now() - hurtAt < 700 && closeFoe && kind !== 'open') {
      const sealedNow = kind === 'box' && box ? fortify.enclosure(bot, box.cell).sealed : true
      // Один удар в закрытой коробке — это чаще стрела, пущенная до крыши (E:
      // «вскрыли» при целой коробке): вскрыли — если бьют снова за 3 с.
      const again = hurtTimes.filter(t => gameClock.now() - t < 3000).length >= 2
      if ((sealedNow && again) || st.breaches >= 6) { st.why = 'breached'; st.by = closeFoe.e.name; break }
    }
    // На столбе: достают — стрелок видит или бьют — слезать и бежать.
    if (kind === 'pillar') {
      if (topY !== null && bot.entity.position.y < topY - 0.6 && !st.fell) { st.fell = true; note(`со столба упал: ноги y${bot.entity.position.y.toFixed(1)} при верхе ${topY}`) }
      const shot = refugeThreats(bot, session).some(h => h.doc.range && h.d <= h.doc.range && (require('.././assess') as typeof import('.././assess')).inSight(bot, h.e))
      if (shot) { st.why = 'breached'; break }
      if (gameClock.now() - hurtAt < 700) {
        // Достают снизу — выше, пока есть блоки (до +2), и только потом слезать.
        if ((st.raised || 0) < 2 && (require('.././pack') as typeof import('.././pack')).buildCount(bot, worlds.worldOf(bot)) > 0) {
          let r = null
          try { r = await (require('.././build') as typeof import('.././build')).towerUp(bot, ctl, 1, { sneak: true, fast: true }) } catch {}
          if (r && r.placed) { st.raised = (st.raised || 0) + 1; note('достают — столб выше'); hurtAt = 0; continue }
        }
        st.why = 'breached'; break
      }
    }
    // На открытом месте (после бегства): подошли — снова бежать.
    if (kind === 'open') {
      // Ходячий ближе 7 бл. — до удара ~2.4 с (зомби): кусок уже не доесть.
      // Стрелок видит — тоже бежать (из-под прицела), а не есть под стрелами.
      const hs = refugeThreats(bot, session)
      const near = hs.filter(h => h.doc.radius > 0 && h.d < 7)
      const aimed = hs.some(h => h.doc.range && h.d <= h.doc.range && (require('.././assess') as typeof import('.././assess')).inSight(bot, h.e))
      if (near.length || aimed) { st.why = 'contact'; break }
    }
    const got = await healStep(session, ctl, minHp)
    if (got) { st.ate.push(got); continue }
    // Лечиться нечем: сытость ниже 18 — регенерации нет (FoodData.tick).
    if ((bot.food ?? 0) < 18 && !hasFood(session)) { st.why = 'no_food'; break }
    await sleep(250)
  }
  if (!st.why) st.why = ctl.aborted ? 'aborted' : 'stopped'
  return st
}

async function planksFromLogs (session, ctl, logs = 2) {
  const bot = session.bot
  const log = bot.inventory.items().find(i => /_(log|stem)$/.test(i.name) && !/^stripped_/.test(i.name)) ||
    bot.inventory.items().find(i => /_(log|stem)$/.test(i.name))
  if (!log) return 0
  const plank = log.name.replace(/^stripped_/, '').replace(/_(log|stem)$/, '_planks')
  if (!session.mcData.itemsByName[plank]) return 0
  const before = bot.inventory.items().filter(i => i.name === plank).reduce((n, i) => n + i.count, 0)
  try {
    await (require('.././actions') as typeof import('.././actions')).craft(session, ctl, { item: plank, count: before + Math.min(logs, log.count) * 4, spendReserve: true })
  } catch {}
  const after = bot.inventory.items().filter(i => i.name === plank).reduce((n, i) => n + i.count, 0)
  return Math.max(0, after - before)
}

async function takeNiche (session, ctl, a, step) {
  const bot = session.bot
  const fortify: typeof import('.././fortify') = require('.././fortify')
  await fortify.landed(bot, 600)
  const feet = fortify.feetCell(bot)
  const near = a.nearest ? (require('.././flee') as typeof import('.././flee')).hostilesAround(bot, 16).find(h => h.e.name === a.nearest.name) : null
  const plan = fortify.nichePlan(bot, feet, { away: near ? near.e.position : null })
  if (!plan) { step('ниша: здесь не вкопаться'); return null }
  try { await fortify.centerInCell(bot, 500) } catch {}
  const r = await fortify.takeNicheBody(bot, feet, plan, { ctl, toward: near ? near.e.position : null })
  step(`ниша: вкопал ${r.dug}/2, поставил ${r.placed}${r.steps.length ? ' — ' + r.steps.slice(0, 2).join('; ') : ''}`)
  if (!r.box) return null
  const b = r.box
  for (let k = 0; k < 2 && !ctl.aborted && !fortify.enclosure(bot, b.cell).sealed; k++) {
    b.placed += await fortify.refugePatch(bot, b, { ctl })
    if (!fortify.enclosure(bot, b.cell).sealed) await sleep(300)
  }
  const enc = fortify.enclosure(bot, b.cell)
  step(`ниша: стен ${enc.walls}/4, крыша ${enc.roof ? 'есть' : 'нет'}`)
  if (!enc.sealed) return null
  session.shelterBox = b.cell
  return b
}

async function takeBox (session, ctl, a, step, report = (_box: any) => {}) {
  const bot = session.bot
  const fortify: typeof import('.././fortify') = require('.././fortify')
  const target = a.cell
  if (!target || ctl.aborted || (bot.health ?? 0) <= 0) return null
  const toward = a.nearest ? (require('.././flee') as typeof import('.././flee')).hostilesAround(bot, 16).find(h => h.e.name === a.nearest.name)?.e.position : null
  // Клетка в том же столбце (на блок ниже/выше ног) — тело ещё в прыжке после выхода из воды или рывка: дождаться пола,
  // а не «идти» к ней (trap2 02.10, вода: «к клетке (0 бл.) — до клетки не дошёл», откат на столб под трезубцем).
  {
    const f = fortify.feetCell(bot)
    if (!target.cell.equals(f) && target.cell.x === f.x && target.cell.z === f.z) await fortify.landed(bot, 1200)
  }
  if (!target.cell.equals(fortify.feetCell(bot))) {
    step(`к клетке у стены: ${target.cell.x},${target.cell.y},${target.cell.z} (${target.dist} бл.)`)
    // Шагом по прямой, не pathfinder'ом: у мобов его путь дорог (обход мобов),
    await stepTo(bot, ctl, target.cell, 1500)
    if (!fortify.feetCell(bot).equals(target.cell)) {
      // Не дошёл — строиться там, где стою, если тут годится.
      const here = fortify.refugeNeed(bot, fortify.feetCell(bot))
      if (!here || here.blocks > a.blocks) { step('до клетки не дошёл'); return null }
      target.cell = fortify.feetCell(bot)
    }
  }
  // Walls/roof cannot shelter a body from an attacker already inside. Recheck
  // the actual fallback cell before digging its floor or claiming sealed cover.
  const occupied = (box: any = { cell: fortify.feetCell(bot), placed: 0 }) => {
    const cell = fortify.feetCell(bot)
    if (ctl.aborted || (bot.health ?? 0) <= 0 || !fortify.refugeNeed(bot, cell)) return null
    const intruder = (require('.././flee') as typeof import('.././flee')).hostilesAround(bot, 3).find(h => refugeFoe(bot, h.e, session) &&
      ((require('.././pick') as typeof import('.././pick')).aim(bot, h.e)?.point || (require('../combat') as typeof import('../combat')).liveAttacker(session)?.id === h.e.id) &&
      [cell, cell.offset(0, 1, 0)].some(p => occupiedByEntity({ entity: bot.entity, entities: { [h.e.id]: h.e } }, p)))
    if (!intruder) return null
    const breached = { ...box, cell, intruder: intruder.e.name }
    step(`${intruder.e.name} внутри коробки — крышу не ставлю, выхожу`)
    report({ ...breached, ...fortify.enclosure(bot, cell) })
    return breached
  }
  const before = occupied()
  if (before) return before
  const b: Awaited<ReturnType<typeof fortify.refugeBox>> & { sunk?: boolean } = await fortify.refugeBox(bot, target.cell, { toward, ctl })
  // Не закрылась — ещё до двух заходов латания (зомби отходит из клетки стены).
  for (let k = 0; k <= 2; k++) {
    const breach = occupied(b)
    if (breach) return breach
    if (k === 2 || ctl.aborted || fortify.enclosure(bot, b.cell).sealed) break
    b.placed += await fortify.refugePatch(bot, b, { ctl })
    if (!fortify.enclosure(bot, b.cell).sealed) await sleep(300)
  }
  // Стены целы, а крыша не встаёт (подпорку в прыжке не взять) — как игрок:
  {
    const e0 = fortify.enclosure(bot, b.cell)
    if (!e0.sealed && e0.walls === 4 && !e0.roof && !ctl.aborted && !worlds.worldOf(bot).includes('end')) {
      const low = await fortify.sinkRoof(bot, b.cell, { ctl, why: w => step(`осесть не вышло: ${w}`) })
      if (low) { step('крыша не встала — осел на 1 и закрылся на уровне головы'); b.cell = low; b.sunk = true }
    }
  }
  const enc = fortify.enclosure(bot, b.cell)
  step(`коробка: поставил ${b.placed}, стен ${enc.walls}/4, крыша ${enc.roof ? 'есть' : 'нет'}${b.failed ? ` — ${b.failed.slice(0, 2).join('; ')}` : ''}`)
  report({ ...b, ...enc })
  // С открытой стороной это не укрытие, а угол: через неё бьют, пока ешь
  if (!enc.sealed) return null
  session.shelterBox = b.cell
  return b
}

async function stepTo (bot, ctl, cell, ms = 1500) {
  const fortify: typeof import('.././fortify') = require('.././fortify')
  try { bot.pathfinder.setGoal(null) } catch {}
  const until = gameClock.now() + ms
  try {
    // s1c-A-1: six ghast fireballs killed the body at 0.0 s of "to the wall cell", the step reported "not reached" at 37.8 s
    // (after the respawn). A dead body does not walk (S4d 07.10).
    while (gameClock.now() < until && !ctl.aborted && (bot.health ?? 0) > 0 && !fortify.feetCell(bot).equals(cell)) {
      const p = bot.entity.position
      const dx = cell.x + 0.5 - p.x
      const dz = cell.z + 0.5 - p.z
      await bot.look(Math.atan2(-dx, -dz), 0, true).catch(() => {})
      bot.setControlState('forward', true)
      bot.setControlState('jump', cell.y > Math.floor(p.y + 1e-3) && bot.entity.onGround)
      await sleep(50)
    }
  } finally { try { bot.clearControlStates() } catch {} }
  await fortify.landed(bot, 600)
  return fortify.feetCell(bot).equals(cell)
}

const SIT_CAP_MS = 9.5 * 60000

function outsideDanger (bot, at, { untilDawn = false, session = bot._ndGuard?.session, shooters = new Set() }: any = {}) {
  const spatial = process.env.ND_REFUGE_SPATIAL_EXIT === '1' && !untilDawn
  let hs = refugeThreats(bot, session, spatial ? 18 : 16)
  if (spatial) {
    const held = new Set(shooters)
    shooters.clear()
    hs = hs.filter(h => {
      if (!/^(skeleton|stray|bogged|parched|pillager)$/.test(h.e.name)) return true
      const danger = h.d <= (held.has(h.e.id) ? 18 : 16) && (require('.././assess') as typeof import('.././assess')).inSight(bot, h.e)
      if (danger) shooters.add(h.e.id)
      return danger
    })
  }
  const hp = bot.health ?? 0
  // Ходячие у самых стен (≤ 6 бл. по горизонтали от клетки) — выйти значит в их руки. Бродящие дальше — не повод
  const horiz = h => Math.hypot(h.e.position.x - (at.x + 0.5), h.e.position.z - (at.z + 0.5))
  // Двое в 10 бл. — снова найдут (trap2 с «2 в 12» — 26/30, trap3–4 с «у стен ≤ 6» — выходил к ним); один — если
  // у самой стены и хп мало.
  const walkers = hs.filter(h => h.doc.radius > 0 && horiz(h) <= 10 && Math.abs(h.e.position.y - at.y) <= 4)
  const close = walkers.filter(h => horiz(h) <= 6)
  if (walkers.length >= 2 || (close.length && hp < 12)) return `ходячих ${walkers.length} в 10 бл.`
  if (hs.some(h => h.e.name === 'creeper' && h.d <= 8)) return 'крипер у стен'
  // Стрелок в своей дальности: на выходе первая же стрела (на открытом месте без щита — 3–5 хп раз в ~3 с).
  if (hs.some(h => /^(skeleton|stray|bogged|parched|pillager)$/.test(h.e.name) && h.d <= (spatial ? 18 : 16))) return 'стрелок рядом'
  if (hs.some(h => h.doc.range && h.d <= h.doc.range && (require('.././assess') as typeof import('.././assess')).inSight(bot, h.e))) return 'стрелок на виду'
  const t = bot.time && typeof bot.time.timeOfDay === 'number' ? bot.time.timeOfDay : 6000
  const night = t >= 12542 && t <= 23459
  // До рассвета (кампания уже решила: ночь наверху) — без проверки неба: листва над коробкой — не крыша от мобов
  // (trap4 02.10: «до рассвета» вышел через 16 с в лесу).
  if (night && untilDawn && worlds.worldOf(bot) === 'overworld') return 'ночь — до рассвета'
  if (night && hp < 12 && worlds.worldOf(bot) === 'overworld' && openSkyOver(bot, at)) return `ночь наверху, хп ${Math.round(hp)}`
  // Рассвет (23459…600) при хп < 8: зомби и скелеты ещё не сгорели (горят по яркости, не сразу) — выход к ним на 5 хп
  // и охота = смерть (trapJ 03.10, lowhp ×2: сидел до 23460, вышел, зомби в 8 бл. → смерть). Сидеть до утра (≤ SIT_CAP).
  if (hp < 8 && (t > 23459 || t < 600) && worlds.worldOf(bot) === 'overworld' && openSkyOver(bot, at)) return `рассвет, хп ${Math.round(hp)} — пока не сгорят`
  // ND_REFUGE_SIT2=1: ночью наверху сидеть и при хп < 16 или без еды — без еды не вылечиться, а ночью мобы прибывают
  // (camp1 02.10: коробка NO_FOOD на 12 хп — выход к пауку, скелет добил; столб NO_FOOD на 5 — слез и умер).
  if (process.env.ND_REFUGE_SIT2 === '1' && night && worlds.worldOf(bot) === 'overworld' && openSkyOver(bot, at) &&
    (hp < 16 || !bot.inventory.items().some(i => /^(cooked_|bread|baked_potato|golden_carrot|apple|carrot|melon_slice|sweet_berries|beef|porkchop|mutton|rabbit|cod|salmon)/.test(i.name)))) return `ночь наверху, хп ${Math.round(hp)}, без еды или ранен`
  return null
}

function openSkyOver (bot, at) {
  for (let dy = 3; dy <= 24; dy++) {
    const b = bot.blockAt(at.offset(0, dy, 0))
    if (b && b.boundingBox === 'block' && !/leaves|_log$|_wood$|mushroom_block/.test(b.name)) return false
  }
  return true
}

async function sitTight (session, ctl, { at, t0, box = null, step, untilDawn = false }: any) {
  const bot = session.bot
  const fortify: typeof import('.././fortify') = require('.././fortify')
  const s0 = gameClock.now()
  const shooters = new Set()
  const spatial = process.env.ND_REFUGE_SPATIAL_EXIT === '1' && !untilDawn
  let why = outsideDanger(bot, at, { untilDawn, session, shooters })
  if (!why) return { sat: 0 }
  step(`снаружи опасно (${why}) — сижу`)
  let clearSince = 0
  let lastPatch = 0
  let failedPatches = 0
  // Не до рассвета — не дольше 3 мин: под землёй мобы не горят, а ждать «пока уйдут» можно бесконечно.
  const t = bot.time && typeof bot.time.timeOfDay === 'number' ? bot.time.timeOfDay : 6000
  const night = t >= 12542 && t <= 23459 && worlds.worldOf(bot) === 'overworld'
  const nightSky = night && openSkyOver(bot, at)
  const cap = (nightSky && ((bot.health ?? 0) < 12 || process.env.ND_REFUGE_SIT2 === '1')) || (night && untilDawn) ? SIT_CAP_MS : Math.min(SIT_CAP_MS, gameClock.now() - t0 + 180000)
  while (!ctl.aborted && (bot.health ?? 0) > 0 && gameClock.now() - t0 < cap) {
    holdMouth(session, ctl)
    if (box && gameClock.now() - lastPatch > 600 && !fortify.enclosure(bot, box.cell).sealed) {
      lastPatch = gameClock.now()
      let n = 0
      try { n = await fortify.refugePatch(bot, box, { ctl }) } catch {}
      // Дыру не заложить (нечем, моб в клетке стены) — сидеть в открытой коробке незачем.
      if (!n && !fortify.enclosure(bot, box.cell).sealed && ++failedPatches >= 5) { step('коробку не залатать — не сижу'); break }
    }
    await healStep(session, ctl, 20).catch(() => null)
    const w = outsideDanger(bot, at, { untilDawn, session, shooters })
    if (spatial && !w) break
    if (w) { why = w; clearSince = 0 } else if (!clearSince) clearSince = gameClock.now()
    // Стихло 8 с подряд — выходить.
    if (clearSince && gameClock.now() - clearSince >= 8000) break
    await sleep(500)
  }
  const sat = gameClock.now() - s0
  step(`сидел ${Math.round(sat / 1000)} с${gameClock.now() - t0 >= cap ? ' — до предела' : ''}`)
  return { sat, why }
}

async function waitClear (session, ctl, at, { deadline, reach = 3, step }: any) {
  const bot = session.bot
  const flee: typeof import('.././flee') = require('.././flee')
  const t0 = gameClock.now()
  const near = () => flee.hostilesAround(bot, 12).some(h => refugeFoe(bot, h.e, session) && h.doc.radius > 0 &&
    Math.hypot(h.e.position.x - (at.x + 0.5), h.e.position.z - (at.z + 0.5)) <= reach &&
    h.e.position.y - at.y >= -1 && h.e.position.y - at.y <= 4)
  if (!near()) return true
  while (!ctl.aborted && gameClock.now() < deadline && (bot.health ?? 0) > 0 && near()) {
    // Ждём сытыми: доесть, пока стоят.
    holdMouth(session, ctl)
    await healStep(session, ctl, 21).catch(() => null)
    await sleep(400)
  }
  const ok = !near()
  if (step) step(`у выхода ждал ${Math.round((gameClock.now() - t0) / 1000)} с${ok ? '' : ' — не ушли, выхожу'}`)
  return ok
}

async function leaveBox (session, ctl, b, hold, step) {
  const bot = session.bot
  const fortify: typeof import('.././fortify') = require('.././fortify')
  const live = () => !ctl.aborted && (bot.health ?? 0) > 0
  session.shelterBox = null
  if (hold.why === 'died' || (bot.health ?? 0) <= 0) return null
  // Отход оборвали (новое намерение, чат, смерть) — стены не ломать и не выходить: решает тот, кто оборвал.
  if (!live()) return null
  if (!bot.entity.position.floored().equals(b.cell) && !fortify.feetCell(bot).equals(b.cell)) return { ok: true, note: 'уже снаружи' }
  const foes = (require('.././flee') as typeof import('.././flee')).hostilesAround(bot, 12).filter(h => refugeFoe(bot, h.e, session))
  const away = foes.length ? foes[0].e.position : null
  let r = null
  // Ниша: выйти тем же проёмом — выломать свои 2 блока и шагнуть.
  if (b.front) {
    let ok = true
    for (const y of [1, 0]) {
      if (!live()) return null
      if (fortify.solidAt(bot, b.front.offset(0, y, 0))) ok = (await fortify.breakBlock(bot, b.front.offset(0, y, 0), { maxMs: 4000 })) && ok
    }
    if (!live()) return null
    if (ok) {
      try {
        await bot.lookAt(b.front.offset(0.5, 1.2, 0.5), true)
        if (!live()) return null
        bot.setControlState('forward', true)
        await sleep(400)
      } catch {} finally { try { bot.setControlState('forward', false) } catch {} }
      return live() ? { ok: true, front: true } : null
    }
  }
  try {
    r = await fortify.breakOut(bot, b.cell, { away }, { onHole: () => {
      // The current head dig may finish after cancellation; do not start the feet dig.
      if (!live()) throw new Error('выход отменён')
      return false
    } })
  } catch (e) { r = { ok: false, steps: [e.message] } }
  if (!live()) return null
  if (r.ok) {
    try {
      await bot.lookAt(r.exit.offset(0.5, 1.2, 0.5), true)
      if (!live()) return null
      bot.setControlState('forward', true)
      await sleep(350)
    } catch {} finally { try { bot.setControlState('forward', false) } catch {} }
  } else {
    step(`выход из коробки: ${(r.steps || []).join('; ')}`)
    // Вбок некуда (коробка в яме, за стенами порода) — вверх, как из норы:
    // крышу долой и столбом (exitShelter).
    try {
      const up = await exitShelter(session, ctl, { depth: 1 })
      step(`выход вверх: ${up.out ? 'вышел' : up.stopped || 'не вышел'}`)
      r = { ok: !!up.out, up: true }
    } catch (e) { step(`выход вверх: ${e.message}`) }
  }
  return live() ? r : null
}

function shoreRoute (bot, { radius = 16, rise = 6, drop = 4, foes = [] }: any = {}) {
  const start = bot.entity.position.floored()
  const key = p => `${p.x},${p.y},${p.z}`
  const water = (require('.././movement') as typeof import('.././movement')).waterCell
  const passable = b => !!b && b.boundingBox === 'empty' && !/lava/.test(b.name)
  const queue = [{ p: start, parent: -1, n: 0 }]
  const seen = new Set([key(start)])
  const sides = [new Vec3(1, 0, 0), new Vec3(-1, 0, 0), new Vec3(0, 0, 1), new Vec3(0, 0, -1)]
  let best = null
  // Ближний берег важнее тихого: в воде тело ~1.96 бл/с даже со спринтом (prismarine-physics), трезубец 8 хп раз в 2 с
  // (codex-lab/surv-mobs/MOBS.md §3) — штраф за врага у берега мягкий, на суше утопленник медленнее нас вдвое.
  const danger = p => {
    let c = 0
    for (const f of foes) {
      const d = Math.hypot(f.x - (p.x + 0.5), f.z - (p.z + 0.5))
      if (d < 4) c += (4 - d) * 1.5
    }
    return c
  }
  for (let i = 0; i < queue.length && queue.length < 6000; i++) {
    const { p } = queue[i]
    const feet = bot.blockAt(p)
    const head = bot.blockAt(p.offset(0, 1, 0))
    const floor = bot.blockAt(p.offset(0, -1, 0))
    if (i > 0 && passable(feet) && passable(head) && !water(feet) && !water(head) && floor && floor.boundingBox === 'block' && !water(floor) &&
      !/^(magma_block|campfire|soul_campfire|cactus|sweet_berry_bush|pointed_dripstone|powder_snow)$/.test(floor.name) && !/fire|lava/.test(feet.name)) {
      // Путь до берега: опасность у пути — по точкам пути.
      let k = i
      let pathDanger = 0
      while (queue[k].parent >= 0) { pathDanger += danger(queue[k].p) * 0.5; k = queue[k].parent }
      const cost = queue[i].n + danger(p) + pathDanger
      if (!best || cost < best.cost) best = { i, cost }
      continue // через берег дальше не ищем
    }
    if (best && queue[i].n > best.cost) break
    const over = bot.blockAt(p.offset(0, 2, 0))
    const next = [...sides.map(d => p.plus(d)), p.offset(0, 1, 0), p.offset(0, -1, 0)]
    if (passable(over)) next.push(...sides.map(d => p.plus(d).offset(0, 1, 0)))
    for (const q of next) {
      if (Math.max(Math.abs(q.x - start.x), Math.abs(q.z - start.z)) > radius || q.y - start.y > rise || start.y - q.y > drop) continue
      if (seen.has(key(q))) continue
      const f = bot.blockAt(q); const h = bot.blockAt(q.offset(0, 1, 0)); const g = bot.blockAt(q.offset(0, -1, 0))
      if (!passable(f) || !passable(h)) continue
      if (!water(f) && !water(h) && !(g && g.boundingBox === 'block')) continue
      seen.add(key(q))
      queue.push({ p: q, parent: i, n: queue[i].n + 1 })
    }
  }
  if (!best) return null
  const path = []
  let k = best.i
  while (queue[k].parent >= 0) { path.unshift(queue[k].p); k = queue[k].parent }
  return { target: queue[best.i].p, path, cost: Math.round(best.cost) }
}

// Берег дальше 24 бл. (океан: cl-ag/cl-ah 14.10 — «берега в 16 бл. не вижу» за 0 с, круги по воде, утопленники добили):
// ближайшая суша над уровнем воды — то, что видно с поверхности, — в загруженных чанках, кольцами от тела.
function farShore (bot, { maxRadius = 64 }: any = {}) {
  const water = (require('.././movement') as typeof import('.././movement')).waterCell
  const me = bot.entity.position.floored()
  let top = me.y
  while (top - me.y < 16 && water(bot.blockAt(new Vec3(me.x, top + 1, me.z)))) top++
  const open = b => !!b && b.boundingBox === 'empty' && !water(b) && !/lava|fire/.test(b.name)
  const stand = (x, z) => {
    const at = bot.blockAt(new Vec3(x, top, z))
    if (!at || water(at)) return null
    for (let y = top + 3; y >= top; y--) {
      const floor = bot.blockAt(new Vec3(x, y - 1, z))
      if (floor && floor.boundingBox === 'block' && !water(floor) && !/magma|cactus/.test(floor.name) &&
        open(bot.blockAt(new Vec3(x, y, z))) && open(bot.blockAt(new Vec3(x, y + 1, z)))) return new Vec3(x, y, z)
    }
    return null
  }
  for (let r = 2; r <= maxRadius; r++) {
    let best = null
    for (let dx = -r; dx <= r; dx++) {
      for (const dz of Math.abs(dx) === r ? Array.from({ length: 2 * r + 1 }, (_, i) => i - r) : [-r, r]) {
        const p = stand(me.x + dx, me.z + dz)
        const d = p ? Math.hypot(dx, dz) : Infinity
        if (p && (!best || d < best.d)) best = { p, d }
      }
    }
    if (best) return best.p
  }
  return null
}

async function toShore (session, ctl, { timeoutMs = 15000, step = () => {} }: any = {}) {
  const bot = session.bot
  const flee: typeof import('.././flee') = require('.././flee')
  const t0 = gameClock.now()
  const set = (k, v) => { try { bot.setControlState(k, v) } catch {} }
  const stop = () => { for (const k of ['forward', 'back', 'left', 'right', 'jump', 'sprint']) set(k, false) }
  const dry = () => !inWater(bot) && bot.entity.onGround
  try { bot.pathfinder.setGoal(null) } catch {}
  let route = null
  let planAt = 0
  let target = null
  let far = null
  let limit = timeoutMs
  try {
    while (!ctl.aborted && gameClock.now() - t0 < limit && (bot.health ?? 0) > 0 && !dry()) {
      // Retain the existing threat-aware shore route while breath is full.
      if (process.env.ND_WATER_ESCAPE_BUDGET !== '0' && ((require('../movement') as typeof import('../movement')).airTicks(bot) < 270 || bot.entity._ndPoseHeight === .6)) {
        const swim = await escapeWater(bot, ctl, { timeoutMs: Math.max(0, limit - (gameClock.now() - t0)), visibleOnly: true, radius: 16 })
        target = swim.target ? new Vec3(swim.target.x, swim.target.y, swim.target.z) : null
        if (!swim.ok) return { ...swim, seconds: (gameClock.now() - t0) / 1000 }
        break
      }
      // К дальнему берегу — пересчёт реже и только ближним поиском: в открытой воде он обходит тысячи клеток.
      if (!route || gameClock.now() - planAt > (route.far ? 2000 : 600)) {
        const foes = flee.hostilesAround(bot, 20).filter(h => refugeFoe(bot, h.e, session)).map(h => h.e.position)
        // Ближнего берега нет — шире и выше (затопленная лесенка: сухие ступени выше 6 бл.; pool1 02.10 слот 16 — «берега в
        // 16 бл. не вижу» за 0.1 с, утопленник добил).
        route = shoreRoute(bot, { foes }) || (far ? null : shoreRoute(bot, { foes, radius: 24, rise: 14, drop: 8 }))
        planAt = gameClock.now()
        if (!route) {
          // Дальше 24 бл. — плыть по поверхности к ближайшей видимой суше; время — по расстоянию (~1.9 бл/с вплавь со спринтом).
          if (!far) {
            far = farShore(bot)
            if (!far) { step('берега в 64 бл. не вижу'); break }
            const d = Math.hypot(far.x + 0.5 - bot.entity.position.x, far.z + 0.5 - bot.entity.position.z)
            limit = Math.max(limit, Math.min(60000, (gameClock.now() - t0) + d / 1.5 * 1000 + 4000))
            step(`берег далеко: плыву к ${far.x},${far.y},${far.z} (${Math.round(d)} бл.)`)
          }
          route = { target: far, path: [], far: true }
        } else if (!target || !target.equals(route.target)) { target = route.target; step(`к берегу ${target.x},${target.y},${target.z} (${route.path.length} кл.)`) }
      }
      const me = bot.entity.position
      // Ближайшая точка пути, до которой ещё не доплыли.
      let next = route.path.find(c => Math.hypot(c.x + 0.5 - me.x, c.z + 0.5 - me.z) > 0.7) || route.target
      const dx = next.x + 0.5 - me.x
      const dz = next.z + 0.5 - me.z
      await bot.look(Math.atan2(-dx, -dz), next.y + 0.5 > me.y + 0.3 ? 0.3 : 0, true).catch(() => {})
      set('forward', true)
      set('sprint', (bot.food ?? 20) > 6)
      // Прыжок — в воде и на ступень; на суше без него: тело с зажатым прыжком скачет, onGround почти не бывает, и «на суше»
      // не засчитывалось — шло вглубь берега до конца времени (ферма 14.10: вышел за 11 с, отход кончился на 25-й с).
      set('jump', inWater(bot) || next.y > me.y + 0.5)
      await sleep(80)
    }
  } finally { stop() }
  const ok = dry()
  if (ok) {
    // Ещё несколько шагов прочь от воды: утопленник на берегу бьёт из воды, трезубец — по прямой.
    try {
      const me = bot.entity.position
      let wx = 0; let wz = 0; let n = 0
      for (let dx = -4; dx <= 4; dx++) for (let dz = -4; dz <= 4; dz++) {
        for (const dy of [-1, 0]) {
          const b = bot.blockAt(me.offset(dx, dy, dz))
          if (b && b.name === 'water') { wx += dx; wz += dz; n++ }
        }
      }
      if (n) {
        const yaw = Math.atan2(wx / n, wz / n) // прочь от середины воды
        const until = gameClock.now() + 900
        await bot.look(yaw, 0, true).catch(() => {})
        const { stepSafe, keyDir }: typeof import('.././moves') = require('.././moves')
        while (gameClock.now() < until && !ctl.aborted && (bot.health ?? 0) > 0) {
          const f = keyDir(bot, 'forward')
          set('forward', stepSafe(bot, f))
          set('sprint', (bot.food ?? 20) > 6)
          const ahead = bot.blockAt(bot.entity.position.offset(f.x * 0.8, 0, f.z * 0.8).floored())
          set('jump', !!(ahead && ahead.boundingBox === 'block'))
          await sleep(50)
        }
        stop()
        await (require('.././fortify') as typeof import('.././fortify')).landed(bot, 600)
      }
    } catch {} finally { stop() }
  }
  return { ok, seconds: Math.round((gameClock.now() - t0) / 100) / 10, target: target ? xyz(target) : null }
}

module.exports = { pillarPlan, standTop, grounded, refugeFoe, refugeLook, nicheOn, chooseRefuge, buildMsOf, outrun, lookLine, REFUGE_FOOD_BAD, hasFood, healStep, holdMouth, holdOut, planksFromLogs, takeNiche, takeBox, stepTo, SIT_CAP_MS, outsideDanger, openSkyOver, sitTight, waitClear, leaveBox, shoreRoute, toShore, farShore }
export {
  pillarPlan, standTop, grounded, refugeFoe, refugeLook, nicheOn, chooseRefuge, buildMsOf, outrun, lookLine,
  REFUGE_FOOD_BAD, hasFood, healStep, holdMouth, holdOut, planksFromLogs, takeNiche, takeBox, stepTo, SIT_CAP_MS,
  outsideDanger, openSkyOver, sitTight, waitClear, leaveBox, shoreRoute, toShore, farShore
}
