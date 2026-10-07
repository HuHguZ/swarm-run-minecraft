const { PILLAR, CLIMBERS, REFUGE_NEUTRAL, HOT_CELL, MOB_REACH, chaseBps, holePlan, pocketOf } = require('./surface-body')
const { gameClock, worlds, placeBlockAt, digUp, pickFiller, withTimeout, occupiedByEntity, sleep, xyz, travelXZ, inWater, findNearestLand, findSwimRoute, escapeWater, Vec3, exitShelter } = require('./enter-shelter')
function pillarPlan (bot, blocks, foes, shooters) {
  if (blocks < PILLAR || shooters.length) return null
  if (foes.some(h => CLIMBERS.test(h.e.name) || h.e.name === 'creeper' || (h.doc.radius === 0 && h.doc.range))) return null
  const feet = require('.././fortify').feetCell(bot)
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

function refugeLook (session, { radius = 16 }: any = {}) {
  const bot = session.bot
  const t0 = gameClock.now()
  const fortify = require('.././fortify')
  const flee = require('.././flee')
  const assess = require('.././assess')
  const dim = worlds.worldOf(bot)
  const nether = dim === 'the_nether'
  const feet = fortify.feetCell(bot)
  const me = bot.entity.position
  const foes = flee.hostilesAround(bot, radius)
    .filter(h => !REFUGE_NEUTRAL.test(h.e.name) && h.e.isValid !== false)
  // Ходячий — угроза, если он на нашем уровне (±4): со скалы в 10 блоках не спустится за стройку.
  const walkers = foes.filter(h => h.doc.radius > 0 && Math.abs(h.e.position.y - me.y) <= 4)
  const shooters = foes.filter(h => h.doc.range && h.d <= h.doc.range && assess.inSight(bot, h.e))
  const near = walkers[0] || null
  const creeper = foes.find(h => h.e.name === 'creeper' && (h.d <= 9 || h.swelling))
  const blocks = require('.././pack').buildCount(bot, dim)
  const filler = pickFiller(bot, { steady: true })
  let lava = !!bot.entity.isInLava
  for (const dy of [0, 1]) {
    const b = bot.blockAt(me.offset(0, dy, 0))
    if (b && HOT_CELL.test(b.name)) lava = true
  }
  const from = near ? near.e.position : shooters[0] ? shooters[0].e.position : null
  const cell = fortify.refugeCell(bot, from, { have: blocks, foes: foes.map(h => h.e) })
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
  const boxMs = box ? require('.././fortify').refugeBuildMs(a.cell) + (a.cell.dist || 0) / 4.3 * 1000 : Infinity
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
  if (how === 'box' && a.cell) return require('.././fortify').refugeBuildMs(a.cell) + a.cell.dist / 4.3 * 1000
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
  return bot.inventory.items().some(i => foods[i.name] && !REFUGE_FOOD_BAD.test(i.name) && !/_bucket$/.test(i.name))
}

async function healStep (session, ctl, minHp) {
  const bot = session.bot
  const kit = require('.././fightkit')
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
      const r = await require('.././actions').eat(session, {})
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
  const fortify = require('.././fortify')
  const flee = require('.././flee')
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
        if (!n && !st.noFill && !require('.././build').pickFiller(bot, { steady: true })) { st.noFill = true; note('латать нечем — коробка открыта') }
      }
    }
    // Бьют внутри закрытого укрытия — кто-то внутри или рядом с дырой, которую
    // не заложить: сидеть дальше значит умереть на месте.
    const closeFoe = flee.hostilesAround(bot, 3).find(h => !REFUGE_NEUTRAL.test(h.e.name) && h.d < 2.2)
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
      const shot = flee.hostilesAround(bot, 16).some(h => !REFUGE_NEUTRAL.test(h.e.name) && h.doc.range && h.d <= h.doc.range && require('.././assess').inSight(bot, h.e))
      if (shot) { st.why = 'breached'; break }
      if (gameClock.now() - hurtAt < 700) {
        // Достают снизу — выше, пока есть блоки (до +2), и только потом слезать.
        if ((st.raised || 0) < 2 && require('.././pack').buildCount(bot, worlds.worldOf(bot)) > 0) {
          let r = null
          try { r = await require('.././build').towerUp(bot, ctl, 1, { sneak: true, fast: true }) } catch {}
          if (r && r.placed) { st.raised = (st.raised || 0) + 1; note('достают — столб выше'); hurtAt = 0; continue }
        }
        st.why = 'breached'; break
      }
    }
    // На открытом месте (после бегства): подошли — снова бежать.
    if (kind === 'open') {
      // Ходячий ближе 7 бл. — до удара ~2.4 с (зомби): кусок уже не доесть.
      // Стрелок видит — тоже бежать (из-под прицела), а не есть под стрелами.
      const hs = flee.hostilesAround(bot, 16).filter(h => !REFUGE_NEUTRAL.test(h.e.name))
      const near = hs.filter(h => h.doc.radius > 0 && h.d < 7)
      const aimed = hs.some(h => h.doc.range && h.d <= h.doc.range && require('.././assess').inSight(bot, h.e))
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
    await require('.././actions').craft(session, ctl, { item: plank, count: before + Math.min(logs, log.count) * 4, spendReserve: true })
  } catch {}
  const after = bot.inventory.items().filter(i => i.name === plank).reduce((n, i) => n + i.count, 0)
  return Math.max(0, after - before)
}

async function takeNiche (session, ctl, a, step) {
  const bot = session.bot
  const fortify = require('.././fortify')
  await fortify.landed(bot, 600)
  const feet = fortify.feetCell(bot)
  const near = a.nearest ? require('.././flee').hostilesAround(bot, 16).find(h => h.e.name === a.nearest.name) : null
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

async function takeBox (session, ctl, a, step) {
  const bot = session.bot
  const fortify = require('.././fortify')
  const target = a.cell
  if (!target) return null
  const toward = a.nearest ? require('.././flee').hostilesAround(bot, 16).find(h => h.e.name === a.nearest.name)?.e.position : null
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
  const b = await fortify.refugeBox(bot, target.cell, { toward, ctl })
  // Не закрылась — ещё до двух заходов латания (зомби отходит из клетки стены).
  for (let k = 0; k < 2 && !ctl.aborted && !fortify.enclosure(bot, b.cell).sealed; k++) {
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
  // С открытой стороной это не укрытие, а угол: через неё бьют, пока ешь
  if (!enc.sealed) return null
  session.shelterBox = b.cell
  return b
}

async function stepTo (bot, ctl, cell, ms = 1500) {
  const fortify = require('.././fortify')
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

function outsideDanger (bot, at, { untilDawn = false }: any = {}) {
  const flee = require('.././flee')
  const hs = flee.hostilesAround(bot, 16).filter(h => !REFUGE_NEUTRAL.test(h.e.name))
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
  if (hs.some(h => /^(skeleton|stray|bogged|parched|pillager)$/.test(h.e.name) && h.d <= 16)) return 'стрелок рядом'
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
  const fortify = require('.././fortify')
  const s0 = gameClock.now()
  let why = outsideDanger(bot, at, { untilDawn })
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
    const w = outsideDanger(bot, at, { untilDawn })
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
  const flee = require('.././flee')
  const t0 = gameClock.now()
  const near = () => flee.hostilesAround(bot, 12).some(h => !REFUGE_NEUTRAL.test(h.e.name) && h.doc.radius > 0 &&
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
  const fortify = require('.././fortify')
  session.shelterBox = null
  if (hold.why === 'died' || (bot.health ?? 0) <= 0) return null
  // Отход оборвали (новое намерение, чат, смерть) — стены не ломать и не выходить: решает тот, кто оборвал.
  if (ctl.aborted) return null
  if (!bot.entity.position.floored().equals(b.cell) && !fortify.feetCell(bot).equals(b.cell)) return { ok: true, note: 'уже снаружи' }
  const foes = require('.././flee').hostilesAround(bot, 12).filter(h => !REFUGE_NEUTRAL.test(h.e.name))
  const away = foes.length ? foes[0].e.position : null
  let r = null
  // Ниша: выйти тем же проёмом — выломать свои 2 блока и шагнуть.
  if (b.front) {
    let ok = true
    for (const y of [1, 0]) {
      if (ctl.aborted) return null
      if (fortify.solidAt(bot, b.front.offset(0, y, 0))) ok = (await fortify.breakBlock(bot, b.front.offset(0, y, 0), { maxMs: 4000 })) && ok
    }
    if (ok) {
      try {
        await bot.lookAt(b.front.offset(0.5, 1.2, 0.5), true)
        bot.setControlState('forward', true)
        await sleep(400)
      } catch {} finally { try { bot.setControlState('forward', false) } catch {} }
      return { ok: true, front: true }
    }
  }
  try { r = await fortify.breakOut(bot, b.cell, { away }) } catch (e) { r = { ok: false, steps: [e.message] } }
  if (r.ok) {
    try {
      await bot.lookAt(r.exit.offset(0.5, 1.2, 0.5), true)
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
  return r
}

function shoreRoute (bot, { radius = 16, rise = 6, drop = 4, foes = [] }: any = {}) {
  const start = bot.entity.position.floored()
  const key = p => `${p.x},${p.y},${p.z}`
  const water = b => !!b && /^(water|bubble_column)$/.test(b.name)
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
    const next = [...sides.map(d => p.plus(d)), p.offset(0, 1, 0)]
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

async function toShore (session, ctl, { timeoutMs = 15000, step = () => {} }: any = {}) {
  const bot = session.bot
  const flee = require('.././flee')
  const t0 = gameClock.now()
  const set = (k, v) => { try { bot.setControlState(k, v) } catch {} }
  const stop = () => { for (const k of ['forward', 'back', 'left', 'right', 'jump', 'sprint']) set(k, false) }
  const dry = () => !inWater(bot) && bot.entity.onGround
  try { bot.pathfinder.setGoal(null) } catch {}
  let route = null
  let planAt = 0
  let target = null
  try {
    while (!ctl.aborted && gameClock.now() - t0 < timeoutMs && (bot.health ?? 0) > 0 && !dry()) {
      if (!route || gameClock.now() - planAt > 600) {
        const foes = flee.hostilesAround(bot, 20).filter(h => !REFUGE_NEUTRAL.test(h.e.name)).map(h => h.e.position)
        // Ближнего берега нет — шире и выше (затопленная лесенка: сухие ступени выше 6 бл.; pool1 02.10 слот 16 — «берега в
        // 16 бл. не вижу» за 0.1 с, утопленник добил).
        route = shoreRoute(bot, { foes }) || shoreRoute(bot, { foes, radius: 24, rise: 14, drop: 8 })
        planAt = gameClock.now()
        if (!route) { step('берега в 16 бл. не вижу'); break }
        if (!target || !target.equals(route.target)) { target = route.target; step(`к берегу ${target.x},${target.y},${target.z} (${route.path.length} кл.)`) }
      }
      const me = bot.entity.position
      // Ближайшая точка пути, до которой ещё не доплыли.
      let next = route.path.find(c => Math.hypot(c.x + 0.5 - me.x, c.z + 0.5 - me.z) > 0.7) || route.target
      const dx = next.x + 0.5 - me.x
      const dz = next.z + 0.5 - me.z
      await bot.look(Math.atan2(-dx, -dz), next.y + 0.5 > me.y + 0.3 ? 0.3 : 0, true).catch(() => {})
      set('forward', true)
      set('sprint', (bot.food ?? 20) > 6)
      set('jump', true)
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
        const { stepSafe, keyDir } = require('.././moves')
        while (gameClock.now() < until && !ctl.aborted && (bot.health ?? 0) > 0) {
          const f = keyDir(bot, 'forward')
          set('forward', stepSafe(bot, f))
          set('sprint', (bot.food ?? 20) > 6)
          const ahead = bot.blockAt(bot.entity.position.offset(f.x * 0.8, 0, f.z * 0.8).floored())
          set('jump', !!(ahead && ahead.boundingBox === 'block'))
          await sleep(50)
        }
        stop()
        await require('.././fortify').landed(bot, 600)
      }
    } catch {} finally { stop() }
  }
  return { ok, seconds: Math.round((gameClock.now() - t0) / 100) / 10, target: target ? xyz(target) : null }
}

module.exports = { pillarPlan, standTop, grounded, refugeLook, nicheOn, chooseRefuge, buildMsOf, outrun, lookLine, REFUGE_FOOD_BAD, hasFood, healStep, holdMouth, holdOut, planksFromLogs, takeNiche, takeBox, stepTo, SIT_CAP_MS, outsideDanger, openSkyOver, sitTight, waitClear, leaveBox, shoreRoute, toShore }
