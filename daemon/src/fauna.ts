'use strict'
const gameClock: typeof import('./game-clock') = require('./game-clock')
const Vec3: typeof import('vec3').Vec3 = require('vec3')
const { goals }: typeof import('mineflayer-pathfinder') = require('mineflayer-pathfinder')
const { placeBlockAt, withTimeout }: typeof import('./build') = require('./build')
const { canSeePoint }: typeof import('./perception') = require('./perception')
const ride: typeof import('./ride') = require('./ride')

// Животные, питомцы, голем и жители — механики, которых у тела не было:
// приручить волка и кошку, развести животных, построить железного или
// снежного голема, поторговать с жителем.
//
// По коду сервера (paper-1.21.11.jar):
// * Wolf.tryToTame / Cat.tryToTame: random.nextInt(3) == 0 — шанс 1/3 за
//   предмет (волк — bone, кошка — сырая треска/лосось), удача —
//   broadcastEntityEvent 7 (сердечки), неудача — 6 (дым). Parrot: nextInt(10)
//   == 0, семена. Лошади: садиться, пока не «стерпит» — удача тоже событие 7.
//   Клиент эти события видит (mineflayer: entityTamed / entityTaming), по ним
//   и считаем, а не гадаем.
// * Любовь у животных — событие 18 (сердечки), ребёнок появляется рядом.
// * Голем: CarvedPumpkinBlock.trySpawnGolem — узор проверяется, когда тыква
//   (вырезанная или светильник Джека) встаёт на место; железный — Т из 4
//   железных блоков, снежный — столб из 2 снежных.

const TAME = {
  wolf: { items: ['bone'], per: '1/3' },
  cat: { items: ['cod', 'salmon'], per: '1/3' },
  parrot: { items: ['wheat_seeds', 'melon_seeds', 'pumpkin_seeds', 'beetroot_seeds', 'torchflower_seeds', 'pitcher_pod'], per: '1/10' },
  horse: { items: [], per: 'садиться, пока не стерпит' },
  donkey: { items: [], per: 'садиться, пока не стерпит' },
  mule: { items: [], per: 'садиться, пока не стерпит' },
  llama: { items: [], per: 'садиться, пока не стерпит' }
}

const BREED = {
  cow: ['wheat'], mooshroom: ['wheat'], sheep: ['wheat'], goat: ['wheat'],
  pig: ['carrot', 'potato', 'beetroot'],
  chicken: ['wheat_seeds', 'melon_seeds', 'pumpkin_seeds', 'beetroot_seeds', 'torchflower_seeds', 'pitcher_pod'],
  rabbit: ['dandelion', 'carrot', 'golden_carrot'],
  horse: ['golden_carrot', 'golden_apple'], donkey: ['golden_carrot', 'golden_apple'],
  wolf: ['beef', 'cooked_beef', 'porkchop', 'cooked_porkchop', 'chicken', 'cooked_chicken', 'mutton', 'cooked_mutton', 'rabbit', 'cooked_rabbit', 'rotten_flesh'],
  cat: ['cod', 'salmon'],
  llama: ['hay_block'], fox: ['sweet_berries', 'glow_berries'], turtle: ['seagrass'],
  frog: ['slime_ball'], armadillo: ['spider_eye'], camel: ['cactus'], strider: ['warped_fungus'], hoglin: ['crimson_fungus']
}

function sleep (ms, ctl?: any) {
  return new Promise<any>(resolve => {
    const t = gameClock.setTimeout(resolve, ms)
    if (ctl) ctl.onAbort.push(() => { gameClock.clearTimeout(t); resolve(undefined) })
  })
}

function countOf (bot, name) {
  return bot.inventory.items().filter(i => i.name === name).reduce((n, i) => n + i.count, 0)
}

// Метаданные (1.21): 16 — детёныш (AgeableMob), 17 — флаги приручаемого
// (0x04 приручен, 0x01 сидит).
function isBaby (e) { return !!(e.metadata && e.metadata[16] === true) }
// Белый медведь нейтрален; детёныша не бьём. При литье 20 блоков — защитный запас,
// а не радиус агрессии: AttackPlayersGoal 1.21.11 выбирает игрока в 10, если есть детёныш в BB+8/4/8.
function castHazard (bot, at = bot.entity.position) {
  const foes = /^(pillager|vindicator|evoker|ravager|skeleton|stray|bogged|parched|zombie|husk|drowned|spider|cave_spider|creeper|witch)$/
  for (const e of ((Object.values(bot.entities || {}) as any[]) as any)) {
    if (!e || !e.position || !/^(polar_bear)$/.test(e.name || '') && !foes.test(e.name || '')) continue
    const d = e.position.distanceTo(at)
    if (d > (e.name === 'polar_bear' ? 20 : 16) || !visible(bot, e)) continue
    return { id: e.id, name: e.name, baby: e.name === 'polar_bear' ? isBaby(e) : undefined, distance: Math.round(d * 10) / 10 }
  }
  const feet = at.floored()
  for (const q of [feet, feet.offset(0, 1, 0), feet.offset(0, -1, 0)]) {
    const b = bot.blockAt && bot.blockAt(q)
    if (b && /^(lava|fire|soul_fire|campfire|soul_campfire|magma_block|powder_snow)$/.test(b.name)) return { name: b.name, at: { x: q.x, y: q.y, z: q.z } }
  }
  return null
}
function isTamed (e) { const f = e.metadata && e.metadata[17]; return typeof f === 'number' && (f & 0x04) !== 0 }
function isSitting (e) { const f = e.metadata && e.metadata[17]; return typeof f === 'number' && (f & 0x01) !== 0 }

function visible (bot, e) {
  return canSeePoint(bot, e.position.offset(0, (e.height || 1) * 0.6, 0))
}

function nearestOf (bot, kind, filter: (entity: any) => boolean = () => true, radius = 32) {
  const me = bot.entity.position
  return (Object.values(bot.entities) as any[])
    .filter((e : any) => e && e.name === kind && e.position && e.position.distanceTo(me) <= radius && filter(e) && visible(bot, e))
    .sort((a: any, b: any) => a.position.distanceTo(me) - b.position.distanceTo(me))
}

async function holdOne (bot, names) {
  for (const n of names) {
    const it = bot.inventory.items().find(i => i.name === n)
    if (!it) continue
    if (!bot.heldItem || bot.heldItem.name !== n) { try { await bot.equip(it, 'hand') } catch { continue } }
    return n
  }
  return null
}

async function holdNothing (bot) {
  if (!bot.heldItem) return
  const slot = bot.inventory.firstEmptyHotbarSlot ? bot.inventory.firstEmptyHotbarSlot() : null
  try {
    if (slot !== null && slot !== undefined) bot.setQuickBarSlot(slot - 36)
    else await bot.unequip('hand')
  } catch {}
}

async function approach (bot, ctl, e, range = 2.2, ms = 15000) {
  if (e.position.distanceTo(bot.entity.position) <= range + 0.5) return true
  const goal = new goals.GoalFollow(e, range)
  ctl.onAbort.push(() => { try { bot.pathfinder.setGoal(null) } catch {} })
  try {
    bot.pathfinder.setGoal(goal, true)
    const t0 = gameClock.now()
    while (gameClock.now() - t0 < ms && !ctl.aborted && e.isValid !== false) {
      if (e.position.distanceTo(bot.entity.position) <= range + 0.5) return true
      await sleep(150)
    }
    return false
  } finally {
    try { if (bot.pathfinder.goal === goal) bot.pathfinder.setGoal(null) } catch {}
  }
}

// Событие сущности (entity_status) за время ожидания.
function statusWatch (bot, id) {
  const seen = []
  const on = (packet) => { if (packet.entityId === id) seen.push(packet.entityStatus) }
  bot._client.on('entity_status', on)
  return { seen, stop: () => bot._client.removeListener('entity_status', on) }
}

// ---------------------------------------------------------------- приручить

async function tame (session, ctl, { kind = 'wolf', tries = 15, radius = 32 }: any = {}) {
  const bot = session.bot
  const spec = TAME[kind]
  if (!spec) return { tamed: false, stopped: `не умею приручать ${kind}: умею ${Object.keys(TAME).join(', ')}` }
  const riding = spec.items.length === 0
  if (!riding) {
    const have = spec.items.reduce((n, it) => n + countOf(bot, it), 0)
    if (!have) return { tamed: false, need: { what: spec.items.join('|'), count: 3, have: 0 }, stopped: `нечем приручать ${kind}: нужно ${spec.items.join(' или ')} (шанс ${spec.per} за штуку)` }
  }
  // У лошадиных «приручён» — флаг 0x02 (AbstractHorse.isTamed → getFlag(2)), не 0x04.
  const wild = e => riding ? !ride.isTamedHorse(e) : !isTamed(e)
  const list = nearestOf(bot, kind, e => wild(e) && !isBaby(e), radius)
  if (!list.length) return { tamed: false, stopped: `не вижу неприручённого ${kind} в ${radius} блоках` }
  const target: any = list[0]
  if (riding) {
    // Верхом — сидеть до броска лошади, а не слезать по часам (ride.tameHorse:
    // бросок раз в ~2.5 с в среднем, посадка без броска пропадает даром).
    const rep: any = {}
    const tamed = await ride.tameHorse(session, ctl, target, rep, { tries })
    if (bot.vehicle) await ride.dismount(bot)
    return {
      tamed, kind, used: rep.tame.tries, fails: rep.tame.bucked, id: target.id, at: target.position.floored(), chance: spec.per,
      stopped: tamed ? undefined : rep.stopped
    }
  }
  const watch = statusWatch(bot, target.id)
  let used = 0
  try {
    for (let i = 0; i < tries && !ctl.aborted; i++) {
      if (!target.isValid) return { tamed: false, used, stopped: `${kind} пропал` }
      if (!(await approach(bot, ctl, target, 2.2))) return { tamed: false, used, stopped: `не подошёл к ${kind}` }
      const item = await holdOne(bot, spec.items)
      if (!item) return { tamed: false, used, stopped: `кончилось: ${spec.items.join('/')}`, need: { what: spec.items[0], count: 3, have: 0 } }
      try { await bot.lookAt(target.position.offset(0, (target.height || 0.8) * 0.6, 0), true) } catch {}
      const before = watch.seen.length
      try { bot.activateEntity(target) } catch {}
      used++
      const t0 = gameClock.now()
      while (gameClock.now() - t0 < 1200 && watch.seen.length === before) await sleep(80)
      if (watch.seen.slice(before).includes(7)) break
    }
  } finally {
    watch.stop()
  }
  const tamed = watch.seen.includes(7)
  if (tamed) {
    session.bus.emit('tamed', { kind, id: target.id, text: `приручил ${kind} (попыток ${used})` })
  }
  return {
    tamed,
    kind,
    used,
    fails: watch.seen.filter(s => s === 6).length,
    id: target.id,
    at: target.position.floored(),
    chance: spec.per,
    stopped: tamed ? undefined : `не приручился за ${used} попыток (шанс ${spec.per}) — ещё корма или другого`
  }
}

// ------------------------------------------------------------ сидеть / стоять

// Приручённый волк/кошка: правый клик пустой рукой переключает «сидеть».
async function pet (session, ctl, { kind = null, sit = true, radius = 16 }: any = {}) {
  const bot = session.bot
  const kinds = kind ? [kind] : ['wolf', 'cat', 'parrot']
  const mine = kinds.flatMap(k => nearestOf(bot, k, e => isTamed(e), radius))
  if (!mine.length) return { changed: 0, stopped: `рядом нет приручённых ${kinds.join('/')}` }
  let changed = 0
  for (const e of (mine as any)) {
    if (isSitting(e) === !!sit) continue
    if (!(await approach(bot, ctl, e, 2.5))) continue
    // Щелчок переключает приказ «сидеть», а флаг позы (0x01) приходит тиком
    // позже — и только что приручённый уже сидит по приказу (Wolf.tryToTame:
    // setOrderedToSit(true)), хотя флаг ещё 0. Поэтому — щёлкнуть и проверить;
    // вышло наоборот — щёлкнуть ещё раз.
    for (let k = 0; k < 2 && isSitting(e) !== !!sit; k++) {
      await holdNothing(bot)
      try { await bot.lookAt(e.position.offset(0, 0.5, 0), true) } catch {}
      try { bot.activateEntity(e) } catch {}
      const t0 = gameClock.now()
      while (gameClock.now() - t0 < 900 && isSitting(e) !== !!sit) await sleep(100, ctl)
    }
    if (isSitting(e) === !!sit) changed++
  }
  const inState = mine.filter(e => isSitting(e) === !!sit).length
  return { changed, inState, total: mine.length, now: sit ? 'сидят' : 'идут за мной' }
}

// ----------------------------------------------------------------- развести

async function breed (session, ctl, { kind = 'cow', pairs = 1, radius = 24 }: any = {}) {
  const bot = session.bot
  const food = BREED[kind]
  if (!food) return { bred: 0, stopped: `не знаю, чем кормить ${kind}: знаю ${Object.keys(BREED).join(', ')}` }
  const have = food.reduce((n, it) => n + countOf(bot, it), 0)
  if (have < 2) return { bred: 0, need: { what: food.join('|'), count: 2 * pairs, have }, stopped: `на пару ${kind} нужно 2 ${food.join(' или ')}` }
  let bred = 0
  const fed = new Set()
  for (let p = 0; p < pairs && !ctl.aborted; p++) {
    const adults = nearestOf(bot, kind, e => !isBaby(e) && !fed.has(e.id) && (kind !== 'wolf' && kind !== 'cat' ? true : isTamed(e)), radius).slice(0, 2)
    if (adults.length < 2) return { bred, stopped: `не вижу двух взрослых ${kind}${kind === 'wolf' || kind === 'cat' ? ' (приручённых)' : ''} рядом` }
    const kidsBefore = (Object.values(bot.entities) as any[]).filter((e : any) => e.name === kind && isBaby(e)).length
    const watches = adults.map((a : any) => statusWatch(bot, a.id))
    try {
      for (const a of (adults as any)) {
        if (!(await approach(bot, ctl, a, 2.2))) continue
        if (!(await holdOne(bot, food))) break
        try { await bot.lookAt(a.position.offset(0, (a.height || 1) * 0.6, 0), true) } catch {}
        try { bot.activateEntity(a) } catch {}
        fed.add(a.id)
        await sleep(400, ctl)
      }
      // Сердечки (18) у обоих — ждать детёныша, до 8 с.
      const t0 = gameClock.now()
      while (gameClock.now() - t0 < 8000 && !ctl.aborted) {
        const kids = (Object.values(bot.entities) as any[]).filter((e : any) => e.name === kind && isBaby(e)).length
        if (kids > kidsBefore) { bred++; break }
        await sleep(250)
      }
    } finally {
      for (const w of watches) w.stop()
    }
  }
  return { bred, kind, note: bred ? `родилось ${bred}; следующая любовь у этих — через 5 минут` : 'детёныш не появился — любовь не включилась (не та еда или недавно рожали)' }
}

// ------------------------------------------------------------------- голем

// Место перед собой: ровный пол 3 в ширину и 3 свободных в высоту.
function golemSpot (bot, kind) {
  const f = bot.entity.position.floored()
  const yaw = bot.entity.yaw
  const fx = Math.round(-Math.sin(yaw))
  const fz = Math.round(-Math.cos(yaw))
  const dirs = [[fx, fz], [1, 0], [-1, 0], [0, 1], [0, -1]]
  for (const [dx, dz] of dirs) {
    if (dx === 0 && dz === 0) continue
    const base = f.offset(dx * 2, 0, dz * 2)
    // Руки голема — поперёк направления на нас.
    const sx = dz
    const sz = -dx
    const cells = kind === 'iron'
      ? [base, base.offset(0, 1, 0), base.offset(sx, 1, sz), base.offset(-sx, 1, -sz), base.offset(0, 2, 0),
          base.offset(sx, 0, sz), base.offset(-sx, 0, -sz), base.offset(sx, 2, sz), base.offset(-sx, 2, -sz)]
      : [base, base.offset(0, 1, 0), base.offset(0, 2, 0)]
    const free = cells.every(c => { const b = bot.blockAt(c); return b && b.boundingBox === 'empty' && !/water|lava/.test(b.name) })
    const floor = bot.blockAt(base.offset(0, -1, 0))
    if (free && floor && floor.boundingBox === 'block') return { base, side: new Vec3(sx, 0, sz) }
  }
  return null
}

// ------------------------------------------------------------------- голем на железо (поток route, 03.10.2026)
// Железный голем деревни — 3–5 слитков всегда (loot_table entities/iron_golem.json, 1.21.11): ведро без шахты. Как
// спидраннеры — со столба. Голем бьёт, только если его коробка атаки пересекает хитбокс цели (Mob.isWithinMeleeAttackRange
// → getAttackBoundingBox: своя коробка, раздутая ТОЛЬКО по горизонтали на √2.04 − 0.6 ≈ 0.83; байткод Mob 1.21.11,
// codex-lab/early-nether-evidence/Mob.javap.txt). Голем 1.4 × 2.7: ноги игрока на 3 блока выше пола голема — вне его
// коробки (2.7 < 3), а удар игрока (3.0 от глаз, +4.62) до макушки голема (+2.7) достаёт при горизонтали ≤ 2.3.
// Пол вокруг столба — ровный: шаг голема (step 1.0) на бугор поднял бы его коробку на блок. Бьём топором (без взмаха
// по соседям — меч на земле задевает жителя рядом, а у жителей память на удары) или мечом.
const GOLEM_PILLAR = 3
function golemReach (bot, g) {
  const eye = bot.entity.position.offset(0, 1.62, 0)
  const hw = (g.width || 1.4) / 2
  const h = g.height || 2.7
  const p = g.position
  const cx = Math.max(p.x - hw, Math.min(eye.x, p.x + hw))
  const cy = Math.max(p.y, Math.min(eye.y, p.y + h))
  const cz = Math.max(p.z - hw, Math.min(eye.z, p.z + hw))
  return Math.hypot(eye.x - cx, eye.y - cy, eye.z - cz)
}
// Столб можно ставить здесь: под ногами твёрдое, вокруг (±2) пол не выше ног (иначе голем шагнёт на бугор), над
// головой на 4 — пусто.
function pillarSpotOk (bot, feet) {
  for (let dy = 0; dy <= GOLEM_PILLAR + 1; dy++) {
    const b = bot.blockAt(feet.offset(0, dy + 1, 0))
    if (b && b.boundingBox === 'block') return false
  }
  for (let dx = -2; dx <= 2; dx++) {
    for (let dz = -2; dz <= 2; dz++) {
      if (!dx && !dz) continue
      for (let dy = 0; dy <= 2; dy++) {
        const b = bot.blockAt(feet.offset(dx, dy, dz))
        if (b && b.boundingBox === 'block') return false
      }
    }
  }
  return true
}
// Самые высокие ноги голема у столба: клетки в 3 бл. вокруг (кроме самого столба), где под ногами твёрдое, а выше 3
// клетки свободны (голем 2.7 в высоту), на высоте пола столба −2…+4.
// Коробка атаки: половина ширины голема 0.7 + расширение 0.828 + половина игрока 0.3.
// На краю третьей клетки голем ещё может опираться ногами и доставать по обеим осям.
function golemTopNear (bot, base, golem?: any) {
  let top = base.y
  // The golem can still stand on the edge of the third cell: half-width .7
  // plus native melee inflation .828 plus player half-width .3 reaches 1.828
  // from our center; its feet then overlap that cell by up to .028 blocks.
  for (let dx = -3; dx <= 3; dx++) {
    for (let dz = -3; dz <= 3; dz++) {
      if (!dx && !dz) continue
      for (let y = base.y + 4; y >= base.y - 2; y--) {
        const p = base.offset(dx, y - base.y, dz)
        const fl = bot.blockAt(p.offset(0, -1, 0))
        if (!fl || fl.boundingBox !== 'block') continue
        let free = true
        for (let k = 0; k < 3; k++) { const b = bot.blockAt(p.offset(0, k, 0)); if (b && b.boundingBox === 'block') { free = false; break } }
        if (free) { top = Math.max(top, y); break }
      }
    }
  }
  if (!golem || top <= base.y + 1) return top
  // A roof over a four-block wall is not a walking threat. Reuse the mob's
  // bounded step search with our future supported column; retain real stairs.
  const { reachOf }: typeof import('./reach') = require('./reach')
  const future = Object.create(bot)
  future.entity = { ...bot.entity }
  const walking = { ...golem, name: 'iron_golem', width: golem.width || 1.4, height: golem.height || 2.7 }
  const fringe = (golem.width || 1.4) / 2 + .5
  for (let h = GOLEM_PILLAR; h <= 6 && h <= top - base.y + GOLEM_PILLAR; h++) {
    const center = base.offset(.5, h, .5), cache = new Map()
    future.blockAt = p => p.x === base.x && p.z === base.z && p.y >= base.y && p.y < base.y + h
      ? { name: 'cobblestone', boundingBox: 'block' } : bot.blockAt(p)
    let reaches = false
    // The search uses cell centers. A wide golem's feet can rest on the
    // neighbouring cell's edge: half its width plus half a cell of slack.
    for (const dx of [-fringe, 0, fringe]) {
      for (const dz of [-fringe, 0, fringe]) {
        future.entity.position = center.offset(dx, 0, dz)
        if (reachOf(future, walking, { cache }).reaches) { reaches = true; break }
      }
      if (reaches) break
    }
    if (!reaches) return base.y + h - GOLEM_PILLAR
  }
  return top
}
// Клетка для столба у голема: ровно вокруг (golemTopNear не выше пола), пол твёрдый, ноги и 5 над ними свободны, пол не
// ниже ног голема, до голема по горизонтали 1.8–2.8 (сверху удар достаёт: глаза +4.62, макушка +2.7).
function golemSpotNear (bot, g) {
  const gp = g.position
  const gy = Math.floor(gp.y + 0.01)
  const me = bot.entity.position
  let best = null
  for (let dx = -3; dx <= 3; dx++) {
    for (let dz = -3; dz <= 3; dz++) {
      for (let dy = -1; dy <= 1; dy++) {
        const c = new Vec3(Math.floor(gp.x) + dx, gy + dy, Math.floor(gp.z) + dz)
        const h = Math.hypot(c.x + 0.5 - gp.x, c.z + 0.5 - gp.z)
        if (h < 1.6 || h > 3.6) continue
        const fl = bot.blockAt(c.offset(0, -1, 0))
        if (!fl || fl.boundingBox !== 'block' || /water|lava/.test(fl.name)) continue
        // Пол столба — полный куб: тропа деревни (15/16), плита, грядка ниже соседнего дёрна — голем на дёрне выше нас
        // (rt-R4 слот 30: удар голема по телу на столбе 3, 20 → 11).
        if (/path|slab|farmland|soul_sand|mud$|snow|carpet|stairs|chest|_bed$|fence|wall|bell|lantern|composter|lectern/.test(fl.name)) continue
        let free = true
        for (let k = 0; k <= 4; k++) { const b = bot.blockAt(c.offset(0, k, 0)); if (!b || b.boundingBox === 'block' || /water|lava/.test(b.name)) { free = false; break } }
        if (!free || c.y < gy) continue
        // Выше пола на 1 вокруг — столб 4 (голем тогда достаётся, только прижавшись к столбу); выше — мимо.
        const extra = golemTopNear(bot, c, g) - c.y
        if (extra > 1) continue
        const strike = golemReach({ entity: { position: c.offset(.5, GOLEM_PILLAR + extra, .5) } }, g)
        // A neutral mob outside legal strike range costs the existing six-second
        // no-hit wait; prefer a perch from which the first safe hit is possible.
        const score = Math.hypot(c.x + 0.5 - me.x, c.z + 0.5 - me.z) + Math.abs(c.y - me.y) * 2 + extra * 6 + (strike > 2.95 ? 6 : 0)
        if (!best || score < best.score) best = { c, score }
      }
    }
  }
  return best && best.c
}
async function golemKill (session, ctl, { radius = 48, timeoutSeconds = 85 }: any = {}) {
  const bot = session.bot
  const t0 = gameClock.now()
  const deadline = t0 + Math.max(20, Math.min(110, timeoutSeconds)) * 1000
  const late = () => gameClock.now() > deadline || ctl.aborted
  const ironBefore = countOf(bot, 'iron_ingot')
  const out: any = { killed: false, hits: 0, pillar: 0, iron: 0, steps: [] }
  const mark = (s) => out.steps.push(`${Math.round((gameClock.now() - t0) / 100) / 10}с ${s}`)
  const golems = () => (Object.values(bot.entities) as any[]).filter((e : any) => e && e.name === 'iron_golem' && e.position && e.isValid !== false &&
    e.position.distanceTo(bot.entity.position) <= radius).sort((a: any, b: any) => a.position.distanceTo(bot.entity.position) - b.position.distanceTo(bot.entity.position))
  let g: any = golems().find(e => visible(bot, e)) || golems()[0]
  if (!g) return { ...out, stopped: `голема не вижу в ${radius} бл.` }
  const { towerUp, pickFiller }: typeof import('./build') = require('./build')
  // Блоки любых годных видов вместе (столб ставится по блоку, каждый раз берёт, что есть): rt-R2 слот 12 — «нужно 5»
  // при 3 булыжниках, земле и песчанике.
  const FILL = ['cobblestone', 'cobbled_deepslate', 'dirt', 'netherrack', 'stone', 'deepslate', 'andesite', 'diorite', 'granite', 'tuff', 'blackstone', 'basalt']
  const filler = () => FILL.reduce((n, x) => n + countOf(bot, x), 0)
  void pickFiller
  const weapon = () => bot.inventory.items().filter(i => /_(axe|sword)$/.test(i.name))
    .sort((a, b) => (/_axe$/.test(b.name) ? 1 : 0) - (/_axe$/.test(a.name) ? 1 : 0) || tier(b.name) - tier(a.name))[0] || null
  const id = g.id
  // Следующий RPC может не успеть нанести ни одного нового удара, но голем
  // помнит предыдущие. Ключ — объект сущности: новый моб с тем же id не наследует злость.
  const angerOn = process.env.ND_GOLEM_ANGER !== '0'
  const angry = () => out.hits > 0 || (angerOn && !!session._golemAngry?.has(bot.entities[id] || g))
  let gone = false
  const onGone = e => { if (e && e.id === id) gone = true }
  bot.on('entityGone', onGone)
  ctl.onAbort.push(() => { try { bot.pathfinder.setGoal(null) } catch {} })
  // Безопасно, пока ноги выше коробки атаки голема (его ноги + 2.7) с запасом: голем шагнёт на бугор — коробка выше.
  const hd = e => Math.hypot(e.position.x - bot.entity.position.x, e.position.z - bot.entity.position.z)
  // Mob1.21.11 expands its attack box horizontally, so diagonal contact must
  // use both axes, not a circular distance (S23: 1.825 on each axis still hits).
  const safe = () => {
    const e = bot.entities[id]
    if (!e) return true
    const reach = Math.sqrt(Math.fround(2.04)) - Math.fround(.6)
    const half = Math.fround(e.width || 1.4) / 2 + reach + Math.fround(bot.entity.width || .6) / 2
    const p = bot.entity.position
    return Math.abs(e.position.x - p.x) >= half || Math.abs(e.position.z - p.z) >= half || p.y >= e.position.y + (e.height || 2.7) + .3
  }
  let base = null // клетка ног у основания своего столба
  // Уже стою на своём столбе (прошлый заход оборвался со злым големом внизу) — не слезать к нему: основание — первая
  // клетка под ногами, у которой по бокам есть пол (земля), а не воздух столба.
  {
    const f = bot.entity.position.floored()
    let h = 0
    for (; h < 8; h++) {
      const under = bot.blockAt(f.offset(0, -1 - h, 0))
      if (!under || under.boundingBox !== 'block') break
      const sideAir = [[1, 0], [-1, 0], [0, 1], [0, -1]].every(([dx, dz]) => { const b = bot.blockAt(f.offset(dx, -1 - h, dz)); return !b || b.boundingBox !== 'block' })
      if (!sideAir) break
    }
    if (h >= 2) { base = f.offset(0, -h, 0); mark(`уже на столбе ${h}`) }
  }
  const hp0 = bot.health
  try {
    // An existing supported perch needs no new building material to keep fighting.
    if (!base && filler() < GOLEM_PILLAR) return { ...out, stopped: `на столб нужно ${GOLEM_PILLAR} блока` }
    for (let attempt = 0; attempt < 6 && !gone && !late(); attempt++) {
      // 1. Подойти на 2.2–3 бл. к голему (вплотную сервер не ставит блок под ноги — коробка голема в клетке).
      if (!base) {
        g = bot.entities[id]
        if (!g) { gone = true; break }
        if (!(await approach(bot, ctl, g, 3, Math.min(20000, deadline - gameClock.now())))) { mark('не подошёл'); continue }
        bot.pathfinder.setGoal(null)
        await sleep(150, ctl)
        // Ровное место в 1.8–2.8 бл. от голема: вокруг (3 бл.) голему не на что встать выше пола столба, над головой
        // пусто на 5 (lab ow-golem3: в деревне у стен домов столб рос до 6 и голем уходил из досягаемости).
        g = bot.entities[id] || g
        const spot = golemSpotNear(bot, g)
        if (!spot) {
          out.noSpot = true
          mark('у голема нет безопасного места для столба')
          break
        }
        const f0 = bot.entity.position.floored()
        if (!f0.equals(spot)) {
          try { bot.pathfinder.setGoal(new goals.GoalBlock(spot.x, spot.y, spot.z)) } catch {}
          const tw = gameClock.now()
          while (gameClock.now() - tw < 8000 && !ctl.aborted && !bot.entity.position.floored().equals(spot)) await sleep(150, ctl)
          bot.pathfinder.setGoal(null)
        }
        if (!bot.entity.position.floored().equals(spot)) { mark(`не встал на ${spot.x},${spot.y},${spot.z}`); continue }
        base = bot.entity.position.floored()
      }
      // 2. Столб: ноги выше самого высокого места, куда голем может встать в 3 бл. от столба (+2.75), и не ниже 3 над
      // своим полом; не выше 6 (lab ow-golem2: голем шагнул на бугор у столба 3 — 20 → 7 хп одним ударом).
      let needY = Math.max(base.y + GOLEM_PILLAR, golemTopNear(bot, base, bot.entities[id] || g) + 3.0)
      for (let k = 0; k < 7 && !late(); k++) {
        const h = bot.entity.position.floored().y - base.y
        if (h >= GOLEM_PILLAR && bot.entity.position.y >= needY - 0.01 && safe()) break
        if (h >= 6) break
        const t = await towerUp(bot, ctl, 1, { sneak: true })
        out.pillar += t.placed || 0
        if (!t.placed) { mark(`столб встал на ${h} (${(t.why || []).join('; ') || t.reason || '?'})`); break }
      }
      const h = bot.entity.position.floored().y - base.y
      if (h < GOLEM_PILLAR || !safe() || bot.entity.position.y < needY - 0.01) {
        mark(`высоты нет (${h})`)
        if (angerOn && angry()) { mark('злой голем — со столба не слезаю'); break }
        if (h > 0) await descendPillar(bot, ctl, base.y)
        base = null
        continue
      }
      mark(`столб ${h}`)
      // 3. Бить, только пока безопасно; голем после удара сам подойдёт к столбу. Ранен — ещё блок вверх.
      const w = weapon()
      if (w) { try { await bot.equip(w, 'hand') } catch {} }
      const cd = w && /_axe$/.test(w.name) ? 1250 : 650
      let lastHit = 0
      let farSince = gameClock.now()
      let lastHp = bot.health
      let threatCell = (bot.entities[id] || g).position.floored().toString()
      while (!gone && !late()) {
        g = bot.entities[id]
        if (!g || g.isValid === false) { gone = true; break }
        const cell = g.position.floored().toString()
        if (cell !== threatCell) { needY = Math.max(base.y + GOLEM_PILLAR, golemTopNear(bot, base, g) + 3.0); threatCell = cell }
        if (bot.entity.position.y < base.y + GOLEM_PILLAR - 0.5) { mark('сошёл со столба'); break }
        if (bot.health < lastHp - 0.5 || !safe() || bot.entity.position.y < needY - .01) {
          mark(`опасно (хп ${Math.round(bot.health)}) — блок вверх`)
          const t = await towerUp(bot, ctl, 1, { sneak: true })
          out.pillar += t.placed || 0
          lastHp = bot.health
          // Столб взял блок в руку — оружие назад (rt-R4 слот 30: 94 удара булыжником, голем жив, потом убил бота).
          const w2 = weapon()
          if (w2) { try { await bot.equip(w2, 'hand') } catch {} }
          if (!t.placed && !safe()) { mark('выше не вышло — слезаю'); break }
          continue
        }
        lastHp = bot.health
        const d = golemReach(bot, g)
        // Прицел — по рамке голема, куда луч свободен (pick.aim): со столба над вплотную прижатым големом луч к центру
        // уходил в свой же блок столба, сторож прицела удар не пускал (rt-R3 слот 30: 43 взмаха — голем жив).
        const a = d <= 2.95 ? (require('./pick') as typeof import('./pick')).aim(bot, g) : null
        if (a && a.point) {
          farSince = gameClock.now()
          if (w && (!bot.heldItem || bot.heldItem.name !== w.name)) { try { await bot.equip(w, 'hand') } catch {} }
          if (gameClock.now() - lastHit >= cd) {
            try { await bot.lookAt(a.point, true) } catch {}
            const blocked0 = bot._ndBlockedHits || 0
            try { bot.attack(g); lastHit = gameClock.now() } catch {}
            if ((bot._ndBlockedHits || 0) === blocked0) {
              out.hits++
              if (angerOn) { session._golemAngry ||= new WeakSet(); session._golemAngry.add(g) }
            }
            else out.blocked = (out.blocked || 0) + 1
          }
        } else if (gameClock.now() - farSince > 6000 && !out.hits) {
          mark(`голем ушёл (${d.toFixed(1)} бл.) до удара`)
          break
        } else if (gameClock.now() - farSince > 15000 && !out.hits) { mark('голем не подходит'); break }
        // Голем уже зол (был удар) — со столба не уходить, ждать, пока подойдёт (он идёт к нам сам).
        else if (gameClock.now() - farSince > 30000) { mark('злой голем не подходит 30 с'); break }
        await sleep(60, ctl)
      }
      if (gone || late()) break
      // Слезать к живому голему рядом нельзя — он внизу и зол (lab ow-golem1: хп 20 → 4).
      const gNow = bot.entities[id]
      if (gNow && hd(gNow) < 6 && angry()) { mark('голем у столба — остаюсь наверху'); break }
      if (bot.entity.position.floored().y > base.y) await descendPillar(bot, ctl, base.y)
      base = null
    }
  } finally {
    bot.removeListener('entityGone', onGone)
  }
  out.killed = gone
  mark(gone ? 'голем убит' : 'голем жив')
  if (gone) await sleep(600, ctl)
  const gEnd = bot.entities[id]
  if (base && bot.entity.position.floored().y > base.y && (gone || !gEnd || hd(gEnd) >= 6 || !angry())) await descendPillar(bot, ctl, base.y)
  if (gone && session._golemAngry) session._golemAngry.delete(g)
  if (gone) {
    const until = gameClock.now() + 6000
    while (gameClock.now() < until && !ctl.aborted) {
      const drop: any = (Object.values(bot.entities) as any[]).filter((e : any) => e && e.name === 'item' && e.position && e.position.distanceTo(bot.entity.position) <= 8)
        .sort((a: any, b: any) => a.position.distanceTo(bot.entity.position) - b.position.distanceTo(bot.entity.position))[0]
      if (!drop) break
      try { bot.pathfinder.setGoal(new goals.GoalNear(drop.position.x, drop.position.y, drop.position.z, 0.5)) } catch {}
      await sleep(400, ctl)
    }
    try { bot.pathfinder.setGoal(null) } catch {}
    await sleep(300, ctl)
  }
  out.iron = countOf(bot, 'iron_ingot') - ironBefore
  out.hpLost = Math.max(0, Math.round((hp0 ?? 20) - (bot.health ?? 20)))
  out.seconds = Math.round((gameClock.now() - t0) / 1000)
  if (!gone) out.stopped = `голем не убит за ${out.seconds} с (ударов ${out.hits})`
  return out
}
function tier (n) { return /^netherite/.test(n) ? 5 : /^diamond/.test(n) ? 4 : /^iron/.test(n) ? 3 : /^stone/.test(n) ? 2 : 1 }
async function descendPillar (bot, ctl, groundY) {
  const { equipBestTool }: typeof import('./items') = require('./items')
  for (let k = 0; k < GOLEM_PILLAR + 3 && !ctl.aborted; k++) {
    const feet = bot.entity.position.floored()
    if (feet.y <= groundY) return true
    const under = bot.blockAt(feet.offset(0, -1, 0))
    if (!under || under.boundingBox !== 'block') { await sleep(250, ctl); continue }
    try { await equipBestTool(bot, under); await bot.dig(under, true) } catch { return false }
    await sleep(350, ctl)
  }
  return bot.entity.position.floored().y <= groundY
}

async function golem (session, ctl, { kind = 'iron', mode = 'build', ...rest }: any = {}) {
  if (mode === 'kill') return golemKill(session, ctl, rest)
  const bot = session.bot
  const body = kind === 'iron' ? 'iron_block' : 'snow_block'
  const bodyN = kind === 'iron' ? 4 : 2
  const head = ['carved_pumpkin', 'jack_o_lantern'].find(n => countOf(bot, n) > 0) ||
    (countOf(bot, 'pumpkin') && countOf(bot, 'shears') ? 'pumpkin' : null)
  const need = []
  if (countOf(bot, body) < bodyN) need.push({ what: body, count: bodyN, have: countOf(bot, body) })
  if (!head) need.push({ what: 'carved_pumpkin', count: 1, have: 0, note: 'или pumpkin + shears — вырежу на месте' })
  if (need.length) return { built: false, need: need[0], needAll: need, stopped: `на ${kind === 'iron' ? 'железного' : 'снежного'} голема не хватает: ${need.map(n => `${n.what}×${n.count - n.have}`).join(', ')}` }
  const spot = golemSpot(bot, kind)
  if (!spot) return { built: false, stopped: 'негде поставить: нужна ровная площадка 3 в ширину и 3 свободных в высоту рядом' }
  const { base, side } = spot
  const cells = kind === 'iron'
    ? [base, base.offset(0, 1, 0), base.offset(side.x, 1, side.z), base.offset(-side.x, 1, -side.z)]
    : [base, base.offset(0, 1, 0)]
  for (const c of cells) {
    if (ctl.aborted) return { built: false, stopped: 'прервано' }
    try { await placeBlockAt(bot, c, { item: body, timeoutMs: 5000 }) } catch (e) { return { built: false, stopped: `не встал блок ${body} на ${c}: ${e.message}` } }
  }
  const top = base.offset(0, 2, 0)
  let spawned = null
  const onSpawn = (e) => { if (e && e.name === (kind === 'iron' ? 'iron_golem' : 'snow_golem') && e.position.distanceTo(base) < 3) spawned = e }
  bot.on('entitySpawn', onSpawn)
  try {
    // Тыква смотрит лицом к нам: ставим, глядя на неё.
    try { await placeBlockAt(bot, top, { item: head, timeoutMs: 5000 }) } catch (e) { return { built: false, stopped: `голову не поставил: ${e.message}` } }
    if (head === 'pumpkin') {
      const shears = bot.inventory.items().find(i => i.name === 'shears')
      try { await bot.equip(shears, 'hand') } catch {}
      const b = bot.blockAt(top)
      try { await bot.lookAt(top.offset(0.5, 0.5, 0.5), true) } catch {}
      try { await bot.activateBlock(b) } catch {}
    }
    const t0 = gameClock.now()
    while (!spawned && gameClock.now() - t0 < 2500) await sleep(100)
  } finally {
    bot.removeListener('entitySpawn', onSpawn)
  }
  if (spawned) session.bus.emit('golem', { kind, text: `построил ${kind === 'iron' ? 'железного' : 'снежного'} голема` })
  return {
    built: !!spawned,
    kind,
    at: { x: base.x, y: base.y, z: base.z },
    stopped: spawned ? undefined : 'блоки стоят, а голем не появился — узор не совпал (руки должны быть поперёк, над руками пусто)'
  }
}

// ------------------------------------------------------------------ жители

function tradeView (t, i) {
  const item = (it) => it && it.name ? `${it.name}×${it.count}` : null
  return {
    index: i,
    give: [item(t.inputItem1), t.hasItem2 ? item(t.inputItem2) : null].filter(Boolean).join(' + '),
    price: t.realPrice,
    get: item(t.outputItem),
    left: (t.maximumNbTradeUses || 0) - (t.nbTradeUses || 0),
    disabled: !!t.tradeDisabled
  }
}

// mode=list — что продаёт ближайший житель; buy — сделка index × times.
async function trade (session, ctl, { mode = 'list', index = null, times = 1, want = null, radius = 24 }: any = {}) {
  const bot = session.bot
  const vs = nearestOf(bot, 'villager', e => !isBaby(e), radius)
  if (!vs.length) return { stopped: `не вижу взрослого жителя в ${radius} блоках` }
  const v: any = vs[0]
  if (!(await approach(bot, ctl, v, 2))) return { stopped: 'не подошёл к жителю' }
  try { await bot.lookAt(v.position.offset(0, 1.5, 0), true) } catch {}
  let win = null
  try {
    win = await withTimeout(bot.openVillager(v), 6000, 'окно торговли не открылось (безработный или ребёнок не торгует)')
  } catch (e) {
    return { stopped: e.message }
  }
  try {
    const list = (win.trades || []).map(tradeView)
    if (mode === 'list') return { villager: v.id, trades: list, text: list.map(t => `#${t.index}: ${t.give} → ${t.get}${t.left <= 0 || t.disabled ? ' (закончилось)' : ''}`).join('; ') }
    let i = index
    if ((i === null || i === undefined) && want) i = list.findIndex(t => t.get && t.get.startsWith(want + '×') && t.left > 0 && !t.disabled)
    if (i === null || i === undefined || i < 0 || !list[i]) return { trades: list, stopped: want ? `${want} этот житель не продаёт` : 'не сказано, какую сделку (index или want)' }
    const n = Math.max(1, Math.min(times, list[i].left))
    const before = countOf(bot, (list[i].get || '').split('×')[0])
    try {
      await withTimeout(bot.trade(win, i, n), 8000, 'сделка не прошла')
    } catch (e) {
      return { trades: list, stopped: /Not enough/.test(e.message) ? `не хватает на сделку: ${list[i].give} × ${n}` : e.message }
    }
    // Рюкзак, пока окно открыто, — замороженная копия (containers.js:
    // «bot.inventory freezes the moment a window is up»): считать после
    // закрытия.
    try { win.close() } catch {}
    win = null
    await sleep(250)
    const got = countOf(bot, (list[i].get || '').split('×')[0]) - before
    return { bought: list[i].get, times: n, got, paid: list[i].give }
  } finally {
    if (win) { try { win.close() } catch {} }
  }
}

// ---------------------------------------------------------------- шерсть на кровать
//
// Кровать до ночи (поток route, 03.10: 17 из 24 смертей маршрута — ночью, кровать к 10-й мин была в 7 прогонах из 48).
// Рецепт *_bed 1.21.11 — 3 шерсти ОДНОГО цвета + 3 доски. С 1.21.5 цвет овцы зависит от биома (тёплые — больше
// коричневых, холодные — чёрных), поэтому цвет выбираем по стаду на виду, а не «белая».
// Sheep (1.21.11): метаданные 16 — детёныш, 17 — байт шерсти (цвет & 0x0F, острижена 0x10). Убитая неостриженная
// взрослая овца роняет 1 шерсть своего цвета; ножницы (Sheep.shear) — 1–3 шерсти, овца живёт и не убегает.
const WOOL_COLORS = ['white', 'orange', 'magenta', 'light_blue', 'yellow', 'lime', 'pink', 'gray', 'light_gray', 'cyan', 'purple', 'blue', 'brown', 'green', 'red', 'black']
function sheepInfo (bot, e) {
  const b = e.metadata && typeof e.metadata[17] === 'number' ? e.metadata[17] : 0
  return { e, color: WOOL_COLORS[b & 15], sheared: (b & 16) !== 0, baby: e.metadata && e.metadata[16] === true, d: e.position.distanceTo(bot.entity.position) }
}
function sheepAround (bot, radius = 40) {
  const me = bot.entity.position
  return (Object.values(bot.entities) as any[])
    .filter((e : any) => e && e.name === 'sheep' && e.position && e.position.distanceTo(me) <= radius)
    .map(e => sheepInfo(bot, e))
    .filter(s => !s.sheared && !s.baby)
}
// Цвет: тот, шерсть которого уже есть (и его овцы рядом), иначе — самого большого стада на виду.
function woolColorPick (bot, list, want) {
  const held = WOOL_COLORS.map(c => ({ c, n: countOf(bot, `${c}_wool`) })).filter(x => x.n > 0).sort((a, b) => b.n - a.n)
  const by = {}
  for (const s of list) by[s.color] = (by[s.color] || 0) + 1
  // Уже есть шерсть цвета, и его овцы на виду — добирать его (h.n + овец ≥ want или их больше прочих).
  for (const h of held) if (by[h.c] && (h.n + by[h.c] >= want || by[h.c] >= Math.max(0, ...(Object.values(by) as any[])))) return h.c
  return (Object.entries(by) as [string, any][]).sort((a: any, b: any) => b[1] - a[1])[0]?.[0] || null
}
async function wool (session, ctl, { count = 3, radius = 40, x = null, z = null, timeoutSeconds = 90, color = null }: any = {}) {
  const bot = session.bot
  const combat: typeof import('./combat') = require('./combat')
  const actions: typeof import('./actions') = require('./actions')
  const t0 = gameClock.now()
  const out: any = { color: null, killed: 0, sheared: 0, seen: 0, steps: [] }
  const step = s => { out.steps.push(`${Math.round((gameClock.now() - t0) / 100) / 10}с ${s}`) }
  const deadline = t0 + Math.max(10, Math.min(240, timeoutSeconds)) * 1000
  // К стаду по карте (скан копии: овцы при генерации) — если его не видно отсюда.
  if (Number.isFinite(x) && Number.isFinite(z) && !sheepAround(bot, radius).length) {
    const far = Math.hypot(bot.entity.position.x - x, bot.entity.position.z - z)
    if (far > 12) {
      step(`к стаду по карте ${Math.round(far)} бл.`)
      try { await withTimeout(bot.pathfinder.goto(new goals.GoalNearXZ(x, z, 8)), Math.min(60000, deadline - gameClock.now()), 'путь к стаду') } catch (e) { step(`путь: ${String(e.message).slice(0, 60)}`) }
    }
  }
  const done = () => out.color && countOf(bot, `${out.color}_wool`) >= count
  let misses = 0
  // Овца, с которой не вышло (не дошёл, в яме, за водой), — мимо: следующая того же цвета.
  const skip = new Set()
  while (!ctl.aborted && gameClock.now() < deadline && !done()) {
    const list = sheepAround(bot, radius).filter(s => !skip.has(s.e.id))
    out.seen = Math.max(out.seen, list.length)
    const c = color || out.color || woolColorPick(bot, list, count)
    if (!c) { step('овец на виду нет'); break }
    out.color = c
    const mine = list.filter(s => s.color === c).sort((a, b) => a.d - b.d)
    if (!mine.length) { step(`${c}: овец этого цвета больше нет`); break }
    // Без ножниц овца даёт 1 шерсть: овец цвета + своя шерсть < count — кровати не будет, время не тратить.
    if (!countOf(bot, 'shears') && mine.length + countOf(bot, `${c}_wool`) < count) {
      // Отложенные «не дошёл» — ещё раз, один раз (овца ушла с обрыва/из-за воды, теперь, может, рядом).
      if (skip.size && !out.retried) { out.retried = true; skip.clear(); step(`${c}: мало без отложенных — пробую их снова`); continue }
      step(`${c}: овец ${mine.length}, шерсти ${countOf(bot, `${c}_wool`)} — на кровать мало`); break
    }
    const s = mine[0]
    const before = countOf(bot, `${c}_wool`)
    if (countOf(bot, 'shears') > 0) {
      // Ножницы: подойти, рука — ножницы, клик по овце (use_entity), подобрать 1–3 шерсти.
      if (!(await approach(bot, ctl, s.e, 2.0, 15000)) || !visible(bot, s.e)) { misses++; skip.add(s.e.id); step(`${c}: не подошёл`); if (misses >= 3) break; continue }
      await holdOne(bot, ['shears'])
      try { await bot.lookAt(s.e.position.offset(0, (s.e.height || 1) * 0.6, 0), true) } catch {}
      try { bot.activateEntity(s.e) } catch (e) { step(`ножницы: ${String(e.message).slice(0, 50)}`) }
      await sleep(500, ctl)
      await actions.collectNearbyDrops(bot, ctl, { radius: 6, timeoutMs: 3000 })
      if (countOf(bot, `${c}_wool`) > before) { out.sheared++; step(`${c}: острижена +${countOf(bot, `${c}_wool`) - before}`) } else { misses++; step(`${c}: стрижка без шерсти`) }
    } else {
      let r = null
      // Сперва дойти (путь есть — овца не в яме/за водой), потом бой: бой сам за дальней овцой ходит до 20 с впустую.
      // Дальняя — сперва дойти (бой сам за ней ходит недолго); ближнюю (≤ 10) бой догоняет сам. rt3-A1: «не дошёл (7–15 бл.)»
      // за 12 с у двух стад — шаг кровати сорвался, хотя овцы были рядом.
      // Дальняя: сперва к месту овцы статичной целью (GoalFollow за идущей овцой пересчитывал путь и «не дошёл» за 20 с у
      // 3 овец подряд — rt3-V1), потом догон.
      if (s.d > 10) {
        const p0 = s.e.position.clone()
        try { await withTimeout(bot.pathfinder.goto(new goals.GoalNear(p0.x, p0.y, p0.z, 3)), 15000, 'путь к овце') } catch {}
        try { bot.pathfinder.setGoal(null) } catch {}
      }
      if (s.e.position.distanceTo(bot.entity.position) > 8 && !(await approach(bot, ctl, s.e, 2.5, 10000))) { misses++; skip.add(s.e.id); step(`${c}: не дошёл (${Math.round(s.d)} бл.)`); if (misses >= 3) break; continue }
      try { r = await combat.fight(session, ctl, { target: `#${s.e.id}`, purpose: 'command', timeoutSeconds: 20, retreatAtHealth: 4, allowRanged: false }) } catch (e) { step(`бой: ${String(e.message).slice(0, 60)}`) }
      await actions.collectNearbyDrops(bot, ctl, { radius: 6, timeoutMs: 3000 })
      if (countOf(bot, `${c}_wool`) > before) { out.killed++; step(`${c}: овца +1`) } else { misses++; skip.add(s.e.id); step(`${c}: шерсти нет (${Math.round(s.d)} бл.; ${r ? String(r.stopped || r.note || r.reason || Object.keys(r).join(',')).slice(0, 70) : 'нет ответа'})`) }
    }
    if (misses >= 3) break
  }
  out.wool = out.color ? countOf(bot, `${out.color}_wool`) : 0
  out.ok = !!done()
  out.seconds = Math.round((gameClock.now() - t0) / 1000)
  return out
}

module.exports = { castHazard, tame, breed, pet, golem, golemKill, golemReach, pillarSpotOk, golemTopNear, golemSpotNear, trade, wool, sheepAround, WOOL_COLORS, TAME, BREED, isTamed, isBaby, GOLEM_PILLAR }
export {
  castHazard, tame, breed, pet, golem, golemKill, golemReach, pillarSpotOk, golemTopNear, golemSpotNear, trade,
  wool, sheepAround, WOOL_COLORS, TAME, BREED, isTamed, isBaby, GOLEM_PILLAR
}
