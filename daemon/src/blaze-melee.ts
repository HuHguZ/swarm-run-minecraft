// Бой у спавнера ифритов «мечом по месту» (ND_BLAZE_MELEE=1, 16.10, Claude-сим). Сцены у спавнера (blz-scene, tw-n23):
// holdSpawner с коробкой/окном/«тишиной» давал 0–1 стержня и смерти — тело строило коробку и «лечилось» под ударами ифритов
// вплотную, а под огнестойкостью стояло в 4 бл. от ифритов и не подходило (bfr-5974-601: 400 с, 1 взмах).
// Механика (jar 1.21.11, Blaze$BlazeAttackGoal.tick): d² < 4 — удар вплотную раз в 20 тиков и полёт к цели; дальше, при луче, —
// очередь: заряд 60 тиков, 3 шара через 6, откат 100; ифрит сам не подлетает, пока видит цель. Значит, ифрита в досягаемости бить
// сразу (не строить и не лечиться под ним), к ифриту на высоте глаз ±2 — подходить; без огнестойкости — щит к заряженному,
// отлёжка в коробке (boxRest) при малом хп, когда вплотную никого. Удар — только по тому, что видит прицел (pick.aim/canHit).
import * as gameClock from './game-clock'
import { goals } from 'mineflayer-pathfinder'
import { sleep, xyz } from './movement'
import { countOf } from './items'
import { OTHER_FOES } from './blaze/targets'
import { knownEntities } from './perception/eyes'
const Vec3: typeof import('vec3').Vec3 = require('vec3')

const REACH = 2.95
const isWeapon = it => !!it && /_(sword|axe)$|^(mace|trident)$|_spear$/.test(it.name)

const flat = (a, b) => Math.hypot(a.x - b.x, a.z - b.z)
// Клетка помоста для подъёма или спуска к нему (ND_BLZ_CLIMB) или null — тело уже на уровне помоста, далеко или клеток нет.
// Выше помоста на 3+ — тоже к нему (bzC3-s17-1 21.10: тело на 8 выше трона, 711 «к ифриту» без единого удара, FR кончился).
// Клетки пола помоста по шаблону MonsterThrone: ноги на уровне спавнера, в ±2 от него (любой поворот), где можно стоять.
function plinthCells (bot, spawner) {
  const { standable }: typeof import('./walkable') = require('./walkable')
  const cells = []
  for (let dx = -2; dx <= 2; dx++) for (let dz = -2; dz <= 2; dz++) if ((dx || dz) && standable(bot, spawner.offset(dx, 0, dz))) cells.push(spawner.offset(dx, 0, dz))
  return cells
}
const onPlinth = (bot, spawner) => Math.abs(bot.entity.position.y - spawner.y) < 0.6 && flat(bot.entity.position, spawner.offset(0.5, 0, 0.5)) <= 3

function climbCell (bot, spawner, blazes) {
  const me = bot.entity.position, cells = []
  if (spawner) {
    if (me.y >= spawner.y - 1.5 && me.y <= spawner.y + 2.5 || flat(me, spawner) > 24) return null
    cells.push(...plinthCells(bot, spawner))
  } else {
    const { floorUnder }: typeof import('./blaze/post') = require('./blaze/post')
    for (const e of blazes) {
      // Спавнер не виден — только вверх: ифрит, отдыхающий ниже, — не помост (мог слететь на землю под троном).
      if (e.position.y < me.y + 2.5 || flat(me, e.position) > 16) continue
      const f = floorUnder(bot, e.position)
      if (f && f.y >= me.y + 2.5) cells.push(f)
    }
  }
  // Без спавнера — нижний из полов ифритов (мост перед троном раньше стены помоста: bzC3-s17-2 — цель на стене y71, 7 срывов подъёма).
  return cells.sort((a, b) => (spawner ? 0 : a.y - b.y) || flat(me, a) - flat(me, b))[0] || null
}

async function meleeCamp (session, ctl, { spawner, want, deadline, dead, setPhase = (_: string) => {} }: any) {
  const bot = session.bot
  const B: typeof import('./blaze') = require('./blaze')
  const pick: typeof import('./pick') = require('./pick')
  const actions: typeof import('./actions') = require('./actions')
  const guard = (require('./combat') as typeof import('./combat')).makeShield(session, ctl, { shield: 'ranged' })
  const radar = B.makeRadar(bot)
  const skeletons = process.env.ND_BLAZE_SKELETON === '1'
  // ND_BLAZE_STANCE=1 (поток blz 21.10): ближний удар ифрита — только при d² < 4 по ногам и луче (BlazeAttackGoal.tick), а меч достаёт
  // с 2.95 от глаз до рамки: бить с 2–2.9, к ифриту подходить на 2.4 (не под него), между взмахами шаг назад, если он ближе 2; ждать в 3–4
  // от спавнера, не в 2. Сбор под FR — когда ни у тела, ни у стержня нет ифрита ближе 2. bf12-s18-2: 13 убийств, урон 28 — весь ближний
  // («меч» 18, «жду ифритов» 6), 6 стержней лежали несобранными.
  const stance = process.env.ND_BLAZE_STANCE !== '0'
  const crowdRun = process.env.ND_BLZ_CROWD_RUN === '1'
  // ND_BLZ_DODGE=1 (blz 21.10, пользователь: «спидраннеры уворачиваются и мечом быстро забивают; для сильного бота нет разницы, есть
  // огнестойкость или нет»): без FR — уклонение от шара (видимая сущность со скоростью, радар: прямая проходит у тела, долёт ≤ 0.8 с) рывком
  // поперёк линии огня, и бой дальше без FR (не стоп «без неё бой не веду», подъём на помост и без зелья).
  // ND_BLZ_REFLEX=1 (blaze 27.10): рефлекс уклонения каждый тик (blaze/dodge.ts) вместо ветки DODGE цикла; пока он ведёт ноги, цикл
  // только бьёт того, кто в досягаемости, и не ходит (base1-s15: без FR 67 урона из 67 — шары и огонь, 29 из них «жду ифритов» стоя).
  const reflexOn = process.env.ND_BLZ_REFLEX === '1'
  // ND_BLZ_UNDERHIT=1 (blaze 27.10): без FR — и к ифритам на 2..4.2 выше глаз (смещение высоты triangle(0.5, 6.891) держит их над
  // целью): из-под них удар достаёт, ближний удар ифрита — нет. rx8: «жду ифритов» 119 с из 225 — ифриты рядом, но выше ±2.
  const underHit = process.env.ND_BLZ_UNDERHIT === '1'
  const coverOn = process.env.ND_BLZ_COVER === '1'
  const wallOn = process.env.ND_BLZ2_WALL === '1'
  const wall = { nextAt: 0, skip: new Map<any, number>() }
  const fillerCount = () => bot.inventory.items().filter(i => /^(cobblestone|cobbled_deepslate|netherrack|blackstone|basalt|smooth_basalt|stone|dirt|nether_bricks|soul_soil|andesite|diorite|granite|tuff)$/.test(i.name)).reduce((n, i) => n + i.count, 0)
  const dodge = process.env.ND_BLZ_DODGE === '1' && !reflexOn
  // Клетки шага по (ux, uz) на 1 и 2: ноги и голова пусты, без лавы/огня, пол не глубже 3, не магма.
  const safeStep = (ux: number, uz: number) => {
    const me = bot.entity.position
    for (const k of [1, 2]) {
      const q = me.offset(ux * k, 0, uz * k).floored()
      const feet = bot.blockAt(q), head = bot.blockAt(q.offset(0, 1, 0))
      if (!feet || !head || feet.boundingBox !== 'empty' || head.boundingBox !== 'empty' || /lava|fire/.test(feet.name + head.name)) return false
      let floor = false
      for (let d = 1; d <= 3 && !floor; d++) { const f = bot.blockAt(q.offset(0, -d, 0)); if (f && /lava|fire|magma/.test(f.name)) return false; floor = !!f && f.boundingBox === 'block' }
      if (!floor) return false
    }
    return true
  }
  const feetDist = e => e.position.distanceTo(bot.entity.position)
  // Шаг назад от ифрита (лицом к нему): клетка за спиной — пол без лавы и обрыва, ноги и голова пусты.
  const backstep = async e => {
    const me = bot.entity.position, dx = me.x - e.position.x, dz = me.z - e.position.z, L = Math.hypot(dx, dz) || 1
    const c = me.offset(dx / L, 0, dz / L).floored()
    const okFloor = b => !!b && b.boundingBox === 'block' && !/magma|lava|fire/.test(b.name)
    const empty = b => !!b && b.boundingBox === 'empty' && !/lava|fire/.test(b.name)
    if (!okFloor(bot.blockAt(c.offset(0, -1, 0))) || !empty(bot.blockAt(c)) || !empty(bot.blockAt(c.offset(0, 1, 0)))) return false
    try { await bot.lookAt(B.blazeEye(e), true) } catch {}
    bot.setControlState('back', true)
    await sleep(150)
    bot.setControlState('back', false)
    out.backsteps = (out.backsteps || 0) + 1
    return true
  }
  const saved = bot.pathfinder.movements
  bot.pathfinder.setMovements(B.fightMoves(session))
  // STANCE: в бою спрыгнуть на 3 (без урона) и прорубить ограду/кирпич, если иначе к ифриту не подойти — дорого, но не запрет
  // (bz15-s17-1 21.10: тело в 6 бл. от спавнера на 3 выше помоста, 773 «к ифриту» за 396 с без пути — maxDropDown 2, копать нельзя).
  if (stance) {
    const m = bot.pathfinder.movements; m.maxDropDown = 3; m.canDig = true; m.digCost = Math.max(m.digCost ?? 1, 6)
    // …и столбом/мостком к помосту, если тело внизу под троном (bz16-s19-1: в 12 бл. от трона на 9 ниже, гонялось за ифритами по земле).
    m.allow1by1towers = true; m.scafoldingBlocks = [...(saved?.scafoldingBlocks || [])]
    const sp = bot.registry.blocksByName.spawner; if (sp && m.blocksCantBreak) m.blocksCantBreak.add(sp.id)
  }
  // rests/foes/shieldMs — те же поля, что у holdSpawner: farmRods собирает из них итог (doctrine).
  const out: any = { mode: 'melee', melee: 0, hits: 0, approaches: 0, rests: [], foes: [], shieldMs: 0, arrows: 0, eats: 0, collects: 0,
    ...(process.env.ND_BLZ2_WALL === '1' ? { walls: { tries: 0, placed: 0, shut: 0, open: 0 } } : {}) }
  const dead0 = dead.size
  const onHurt = e => { if (e && e.name === 'blaze') out.hits++ }
  bot.on('entityHurt', onHurt)
  let lastSwing = 0, swapAt = 0, goalAt = 0, phase = '', focus = null, jumpAt = 0, seenAt = gameClock.now(), hadFr = false
  const onHeld = () => { swapAt = gameClock.now() }
  bot.on('heldItemChanged', onHeld)
  // Разбор: время по фазам (с), пока действует FR и без неё — куда уходит зелье.
  let phaseAt = gameClock.now()
  const phaseTo = (s: string) => {
    if (s === phase) return
    const t = gameClock.now(), k = (B.hasEffect(bot, 'fire_resistance') ? 'fr:' : '') + (phase || 'начало')
    out.phaseS = out.phaseS || {}; out.phaseS[k] = Math.round(((out.phaseS[k] || 0) + (t - phaseAt) / 1000) * 10) / 10
    phaseAt = t; phase = s; setPhase(s)
  }
  // REFLEX: в прыжке ноги не управляют (уклониться нечем) — не прыгать за критом, пока заряжен видящий нас ифрит в 10 бл. (rx1-s16:
  // шары с 2–4 бл. попадали в прыжке-крите, onGround=false).
  const jumpOk = (blazes: any[]) => !reflexOn || !blazes.some(e => e.position.distanceTo(bot.entity.position) < 10 && radar.charged(e) && B.seesMe(bot, e))
  // Шаг рефлекса — на 1 бл. (ход за залп ≤ 1.2 бл.; проверка на 2 бл. на помосте трона закрывала почти все стороны: rx2-s15 stuck 20),
  // пол не глубже 4 (спрыгнуть с помоста — 1 урона против 9 от шара с огнём).
  // Проверка — по коробке тела 0.6 (все клетки, которые она займёт на 0.4 и 0.8 бл. хода, на уровне ног и головы): по одной клетке
  // центра тело упиралось краем в стену и стояло под шарами с нажатой клавишей (rx5-s16: x 73.3 шесть тиков, v = 0).
  const reflexStep = (ux: number, uz: number) => {
    const me = bot.entity.position, y = Math.floor(me.y + 0.01)
    for (const k of [0.4, 0.8]) {
      const cx = me.x + ux * k, cz = me.z + uz * k
      for (const x of new Set([Math.floor(cx - 0.3), Math.floor(cx + 0.3)])) for (const z of new Set([Math.floor(cz - 0.3), Math.floor(cz + 0.3)])) for (const dy of [0, 1]) {
        const b = bot.blockAt(new Vec3(x, y + dy, z))
        if (!b || b.boundingBox !== 'empty' || /lava|fire/.test(b.name)) return false
      }
    }
    const q = new Vec3(Math.floor(me.x + ux * 0.8), y, Math.floor(me.z + uz * 0.8))
    // Пол — не глубже 2 (спуск на 1): с высокого трона рефлекс сбрасывал тело вниз, и ифриты над головой были недосягаемы
    // (cv10-s15, −2642: трон в 9 бл. над землёй, 0 убийств за 1211 с на y62 при спавнере y70).
    for (let d = 1; d <= 2; d++) { const f = bot.blockAt(q.offset(0, -d, 0)); if (!f || /lava|fire|magma/.test(f.name)) return false; if (f.boundingBox === 'block') return true }
    return false
  }
  const reflex = reflexOn ? (require('./blaze/dodge') as typeof import('./blaze/dodge')).attachReflex(bot, radar, reflexStep, {
    onStart: () => { stopWalk(); bot.setControlState('jump', false) },
    // Окно — с 0.5 с до первого шара (quietFor ≤ 500: телу набрать ход) и до конца залпа; в 10 бл. (rx7: шары с 2–4 бл. появлялись
    // уже в зазоре < 0 по всем сторонам — уйти можно только заранее).
    preempt: () => B.liveBlazes(bot, dead, 10).filter(e => radar.charged(e) && radar.quietFor(e) <= 500 && B.seesMe(bot, e))
      .sort((a, b) => feetDist(a) - feetDist(b))[0]?.position || null,
    near: () => B.liveBlazes(bot, dead, 4).filter(e => B.seesMe(bot, e) && !(underHit && eyeDy(e) >= 2.4)).map(e => e.position) }) : null
  const shieldTrace = process.env.ND_BLAZE_SHIELD_TRACE === '1' ? (require('./blaze/shield-trace') as typeof import('./blaze/shield-trace')).attachShieldTrace(bot, guard, radar, () => phase) : null
  const fr = () => B.hasEffect(bot, 'fire_resistance')
  // Цель хода — заново, только если сменилась клетка цели или ход стоит дольше 1.5 с: setGoal с той же целью сбрасывает путь и рвёт копку
  // (abT1c9-s19-1 21.10: «к спавнеру» раз в 0.8 с — 1304 сброса «goal_updated», путь с копкой длиной 1, 0 убийств за 20 мин в 17 бл.).
  let steerKey = '', steerAt = 0
  const steer = (x: number, y: number, z: number, r: number) => {
    const key = `${Math.floor(x)},${Math.floor(y)},${Math.floor(z)},${r}`, t = gameClock.now()
    if (key === steerKey && (bot.pathfinder.isMoving() || t - steerAt < 1500)) return
    steerKey = key; steerAt = t
    try { bot.pathfinder.setGoal(new goals.GoalNear(Math.floor(x), Math.floor(y), Math.floor(z), r), true) } catch {}
  }
  const stopWalk = () => { steerKey = ''; try { bot.pathfinder.setGoal(null) } catch {} }
  const sword = async () => {
    const w = (require('./items') as typeof import('./items')).bestWeapon(bot)
    if (w && bot.heldItem?.name !== w.name) { try { await bot.equip(w, 'hand') } catch {} }
  }
  const eyeDy = e => B.blazeEye(e).y - pick.eyeOf(bot).y
  const hp0 = () => bot.health ?? 0
  // ND_BLZ_CLIMB (blz 21.10, вкл. по умолчанию; =0 — выкл.): тело ниже помоста трона — наверх (столбом, прорубая ограду), а не бой снизу: SEEK2 доводит до трона,
  // но ноги на 4–18 бл. ниже спавнера (abU0-s18-2: y61 при спавнере y70 — 3 убийства за 270 с; abU1-s17-1: 7 убийств, 0 стержней —
  // падали на помост). Цель — клетка помоста: спавнер известен — пол шаблона MonsterThrone (ноги на sp.y в ±2 от спавнера при любом
  // повороте); не известен — пол под ифритом выше нас (ифриты отдыхают на помосте и мостах зала; floorUnder — не глубже 4).
  const climbOn = process.env.ND_BLZ_CLIMB !== '0' // вкл. по умолчанию с 05:53 (A/B UNDER: 10/24 против 4/19)
  let climb: any = null, spawnerLookAt = 0
  const chase = { id: null as any, at: 0, best: 0, skip: new Map<any, number>() }
  // ND_BLZ_FR_CLIMB=1 (blz 21.10, одно зелье): подъём на помост — без FR, зелье — на помосте (или ударили/горим, хп < 14): подъём под FR
  // съедал 25–53 с зелья до первого убийства (jA11/jA12-s17-1: подъём ×5/×14, первое убийство на 25-й/53-й с FR). Горение от шара
  // гасит автопилот тем же зельем (frSpendOk у трона) — худший случай как прежде.
  let hurtAt = 0, hp1 = bot.health ?? 20
  const onHealth = () => {
    const h = bot.health ?? 20
    if (h < hp1) {
      hurtAt = gameClock.now()
      // Разбор REFLEX: урон, пока рефлекс ведёт ноги, и вне его — по фазам цикла.
      if (reflex) { const k = reflex.active() ? 'рефлекс' : phase || 'начало'; const m = (reflex.stats as any).hp ||= {}; m[k] = Math.round(((m[k] || 0) + hp1 - h) * 10) / 10 }
    }
    hp1 = h
  }
  bot.on('health', onHealth)
  const frClimb = process.env.ND_BLZ_FR_CLIMB === '1'
  const climbDefer = () => {
    if (!frClimb || fr() || B.frCount(bot) > 1 || hp0() < 14 || gameClock.now() - hurtAt < 3000) return false
    const me = bot.entity.position
    if (spawner) return !(Math.abs(me.y - spawner.y) <= 1.5 && flat(me, spawner) <= 5)
    // Спавнер не виден: ифриты висят выше нас на 3+ (середина их высот в 16 бл.) — трон над нами, подъём ещё впереди (nA12-s17-1: пол
    // под ифритом не нашёлся — FR выпита у подножия, подъём ×136 и падение, 1 убийство).
    const ys = B.liveBlazes(bot, dead, 16).map(e => e.position.y).sort((a, b) => a - b)
    if (ys.length && ys[Math.floor(ys.length / 2)] > me.y + 3) return true
    return !!climbCell(bot, null, B.liveBlazes(bot, dead, 24))
  }
  try {
    // Зелье огнестойкости в рюкзаке, а эффекта нет (bnf9 n39: «выпил», эффект так и не пришёл — шары и горение до смерти) —
    // выпить снова и дождаться эффекта до первого взмаха (смена предмета в руке обрывает питьё).
    // ND_BLAZE_FR_LATE=1: огнестойкость — когда бой есть (ифрит с лучом в 16 бл. или шар к нам), а не на старте навыка: bz06-s19-1 21.10 —
    // оба зелья ушли на вызов без убийств (ифриты за стенами), к бою — без FR.
    const frLate = process.env.ND_BLAZE_FR_LATE === '1'
    const fightOn = () => B.liveBlazes(bot, dead, 16).some(e => B.seesMe(bot, e)) || radar.incoming(gameClock.now()).length > 0
    for (let k = 0; k < 2 && !fr() && !ctl.aborted && (!frLate || fightOn()) && B.frSpendOk(bot, dead) && !climbDefer(); k++) {
      const d = await B.drinkFireResistance(bot)
      if (!/^выпил/.test(String(d))) break
      for (let i = 0; i < 40 && !fr(); i++) await sleep(100)
      out.drinks = (out.drinks || 0) + 1
    }
    await sword()
    try { await guard.wear() } catch {}
    // Сторож цикла: ветка, вернувшаяся без таймера (только микрозадачи), крутит цикл, пакеты не читаются, игровые часы стоят — демон
    // висит (cl02-s19-1 21.10: «молчит 62 с», стек meleeCamp → knownEntities). Часы не сдвинулись за 20 оборотов — уступить тик.
    let spinAt = -1, spins = 0, renewOffUntil = 0
    // Разбор: секунды убийств от начала боя и окно FR (начало по часам глотка) — сколько FR ушло до первого убийства.
    const t0 = gameClock.now(); let deadSeen = dead.size
    out.killSec = []
    while (!ctl.aborted && (bot.health ?? 0) > 0) {
      const now = gameClock.now()
      if (dead.size > deadSeen) { for (; deadSeen < dead.size; deadSeen++) out.killSec.push(Math.round((now - t0) / 1000)) }
      if (bot._ndFrUntil && out.frSec == null && bot._ndFrUntil > now) out.frSec = Math.round((bot._ndFrUntil - 178000 - t0) / 1000)
      if (now === spinAt) { if (++spins >= 20) { spins = 0; out.spins = (out.spins || 0) + 1; await sleep(50); continue } } else { spinAt = now; spins = 0 }
      if (countOf(bot, 'blaze_rod') >= want) {
        // ND_BLZ_CLEAR_EXIT=1: набрал, а ифриты вплотную (в 5 бл.) — добить их здесь (до 45 с, под FR или при хп ≥ 12), а не уходить
        // спиной: выход штреком под ударами вплотную убивал (bzL1-s17-2: 7 стержней, 4 ифрита у трона, 20 → 0 на выходе).
        const near = process.env.ND_BLZ_CLEAR_EXIT === '1' ? B.liveBlazes(bot, dead, 6).filter(e => feetDist(e) < 5) : []
        if (!near.length || (out.clearUntil ??= now + 45000) < now || (!fr() && hp0() < 12)) { out.stopped = 'набрал'; break }
        out.clearing = Math.max(out.clearing || 0, near.length)
      }
      // STANCE: огнестойкость кончилась, зелий нет — бой без FR смертелен (abT1b4 21.10: 6 стержней, FR истёк на 372-й с, «коробка не
      // закрылась» — шары). Стержней на очи хватает — уйти с ними; не хватает — тоже стоп: выбор (бартер на FR, сток, отход) — за этапом.
      if (stance && !fr() && hadFr && !B.drinkable?.(bot) && !dodge) {
        const enough = countOf(bot, 'blaze_rod') >= Math.ceil((Number(process.env.ND_EYES_NEED) || 12) / 2)
        out.stopped = enough ? 'набрал на очи — огнестойкость кончилась' : 'огнестойкость кончилась — без неё бой не веду'
        if (enough) out.enough = true
        break
      }
      if (fr()) hadFr = true
      // Стержней на очи хватает, а хп < 10 — 7-й (запасной) не стоит риска: уйти (bzJ1-s17-1 21.10: 6 стержней на 1.9 мин, смерть от
      // ближнего на 2.6 мин за 7-м).
      if (stance && countOf(bot, 'blaze_rod') >= Math.ceil((Number(process.env.ND_EYES_NEED) || 12) / 2) && hp0() < 10) {
        out.stopped = 'набрал на очи — хп мало'; out.enough = true
        break
      }
      // STANCE: стержней на очи хватает, зелий нет, FR на исходе (< 30 с) — уйти под FR, а не после (bzC1-s17-3 21.10: стоп по концу
      // FR с 6 стержнями, закапывание на помосте под шарами 4 × 5 — смерть).
      if (stance && fr() && !B.drinkable?.(bot) && bot._ndFrUntil && bot._ndFrUntil - now < 30000 &&
          countOf(bot, 'blaze_rod') >= Math.ceil((Number(process.env.ND_EYES_NEED) || 12) / 2)) {
        out.stopped = 'набрал на очи — огнестойкость на исходе'; out.enough = true
        break
      }
      // ND_BLZ_FR_RESERVE=1 (blz 21.10, набор полного прохода — 1 FR): последнее зелье на исходе (< 25 с), других нет — уйти под ним при
      // любом числе стержней: после конца FR тело у трона горело насмерть (di-s19-1: 9 убийств, 2 стержня, яма «лава/пусто», 20 → 0 за
      // 20 с; di-s19-3: 14 убийств, 5 стержней). Яма с крышкой и штрек под FR — без урона.
      if (process.env.ND_BLZ_FR_RESERVE === '1' && !dodge && stance && fr() && !B.drinkable?.(bot) && bot._ndFrUntil && bot._ndFrUntil - now < (process.env.ND_BLZ_ROD_SWEEP === '1' && B.droppedRods(bot, 16) > 0 ? 35000 : 25000)) {
        out.stopped = 'огнестойкость на исходе — ухожу под ней'; out.frExit = true
        break
      }
      if (now >= deadline) { out.stopped = 'время вышло'; break }
      const hp = bot.health ?? 0
      const blazes = B.liveBlazes(bot, dead, 24)
      const others = skeletons ? knownEntities(bot, { radius: 24 }).filter(e => e && e.position && e.isValid !== false &&
        (OTHER_FOES.has(e.name) || e.name === 'stray') && pick.canHit(bot, e, { range: 24 })) :
        (Object.values(bot.entities) as any[]).filter(e => e && /^(wither_skeleton|magma_cube)$/.test(e.name) && e.position && e.isValid !== false)
      const archer = skeletons && others.filter(e => /^(skeleton|stray|wither_skeleton)$/.test(e.name) &&
        e.equipment?.[0]?.name === 'bow' && B.reachTo(bot, e) > REACH).sort((a,b) => B.reachTo(bot,a)-B.reachTo(bot,b))[0]
      // REFLEX: ноги ведёт рефлекс — удар по тому, кто в досягаемости и на откате, без шага и прыжка; иначе ждать тик.
      if (reflex?.active()) {
        phaseTo('уклонение')
        const e = [...blazes, ...others].filter(x => B.reachTo(bot, x) <= REACH && pick.canHit(bot, x) && !B.sweepRisk(bot, x)).sort((a, b) => B.reachTo(bot, a) - B.reachTo(bot, b))[0]
        if (e && now - Math.max(lastSwing, swapAt) >= (require('./pvp') as typeof import('./pvp')).cooldownMs(bot.heldItem)) {
          if (!isWeapon(bot.heldItem)) await sword()
          const aim = pick.aim(bot, e)
          if (aim?.point) { try { await bot.lookAt(aim.point, true); reflex.reapply(); bot.attack(e); lastSwing = gameClock.now(); out.melee++; out.dodgeHits = (out.dodgeHits || 0) + 1 } catch {} }
        } else if (!e && process.env.ND_BLZ_REFLEX_SPRINT === '1') {
          // Бить некого — лицом по ходу: бег (×1.3, только вперёд) вместо шага вбок/назад (трассы pt2: разгон 0.05 → 0.14 за 5 т).
          const d = reflex.dir()
          if (d && (d[0] || d[1])) { try { await bot.look(Math.PI - Math.atan2(-d[0], d[1]), 0, true); reflex.reapply(); out.sprintTurns = (out.sprintTurns || 0) + 1 } catch {} }
        }
        await sleep(50)
        continue
      }
      // ND_BLZ2_WALL (blaze2 27.10): заслон вместо уклонения. Заряженный ифрит с лучом к глазам, чей первый шар через ≤ 2.5 с
      // (≤ 1.5 с, когда есть кого бить), — блок (с подпоркой) на луче глаз → глаз у тела: нет луча — нет выстрела, через 3 с цель забыта
      // (blaze/wall.ts). Рефлекс остаётся для шаров, уже летящих (A sr27-blz2: урон под рефлексом — больше половины всего).
      if (wallOn && !fr() && bot.entity.onGround && now >= wall.nextAt && fillerCount() >= 6) {
        const urgent = blazes.some(e => B.reachTo(bot, e) <= REACH) ? 1500 : 2500
        const shooter = blazes.filter(e => B.reachTo(bot, e) > REACH && feetDist(e) >= 2.3 && radar.charged(e) && radar.quietFor(e) <= urgent &&
          (wall.skip.get(e.id) ?? 0) <= now && B.seesMe(bot, e)).sort((a, b) => radar.quietFor(a) - radar.quietFor(b))[0]
        if (shooter) {
          stopWalk(); bot.setControlState('jump', false)
          phaseTo('заслон')
          const W: typeof import('./blaze/wall') = require('./blaze/wall')
          const build: typeof import('./build') = require('./build')
          const cells = W.screenCells(p => bot.blockAt(p), bot.entity.position, B.blazeEye(shooter))
          let placed = 0
          for (const c of cells) {
            const r: any = await build.placeBlockAt(bot, c, { honest: true, timeoutMs: 700, ctl }).catch(e => ({ ok: false, reason: e.message }))
            if (!r.ok) { out.walls.why = String(r.reason || '').slice(0, 60); break }
            if (!r.already) placed++
          }
          out.walls.tries++; out.walls.placed += placed
          if (B.seesMe(bot, shooter)) { out.walls.open++; wall.skip.set(shooter.id, gameClock.now() + 1500) } else out.walls.shut++
          wall.nextAt = gameClock.now() + 150
          continue
        }
      }
      // Уклонение: ближайший по времени шар с прямой у тела — рывок бегом поперёк его хода (сторона с полом), на исходе — прыжок.
      if (dodge && !fr()) {
        const inc = radar.incoming(now).filter(b => b.eta <= 800 && b.dir).sort((a, b) => a.eta - b.eta)
        if (inc.length) {
          const d = inc[0].dir, L0 = Math.hypot(d.x, d.z) || 1
          let px = -d.z / L0, pz = d.x / L0
          if (out.dodgeSide < 0) { px = -px; pz = -pz }
          const side = safeStep(px, pz) ? 1 : safeStep(-px, -pz) ? -1 : 0
          if (side) {
            const ux = px * side, uz = pz * side, me = bot.entity.position
            stopWalk()
            try { await guard.raise(false) } catch {}
            phaseTo('уклонение')
            out.dodges = (out.dodges || 0) + 1
            out.dodgeSide = -(out.dodgeSide || 1) // следующий шар очереди целит в новую точку — в другую сторону
            try { await bot.lookAt(me.offset(ux * 4, 1.6, uz * 4), true) } catch {}
            bot.setControlState('sprint', true); bot.setControlState('forward', true)
            if (inc[0].eta < 450 && bot.entity.onGround) bot.setControlState('jump', true)
            await sleep(Math.max(200, Math.min(450, inc[0].eta + 120)))
            bot.setControlState('forward', false); bot.setControlState('sprint', false); bot.setControlState('jump', false)
            continue
          }
          out.dodgeStuck = (out.dodgeStuck || 0) + 1
        }
      }
      // ND_BLZ_CROWD_RUN=1 (blz 21.10, каменный меч без щита): под FR бьёт только ближний (6 раз в 20 тиков каждый, d² < 4), а ифрит
      // в воздухе летит ~1 бл/с — от толпы уйти шагом, бить по одному. Два и больше в 2.6 бл. (или один при хп ≤ 8) — отход на 5 от их
      // середины без взмахов (gA11-s17-1: 5 ифритов в 5.5 бл., три вплотную — 20 → 0 за 3 с в «сборе» и «мече»; шаг назад STANCE —
      // 0.3 бл., толпе мало; ветка FR_PICK стоит после «в досягаемости» и с ифритом рядом не срабатывает).
      if (crowdRun && fr() && bot.entity.onGround) {
        const near = blazes.filter(b => feetDist(b) < 2.6)
        if (near.length >= 2 || near.length >= 1 && hp <= 8) {
          const c = near.reduce((a, b) => a.plus(b.position), new (require('vec3').Vec3)(0, 0, 0)).scaled(1 / near.length)
          // Шагом от толпы лицом к ней (клавиши, не pathfinder: новая цель каждые 300 мс сбрасывала путь — тело стояло под ударами,
          // hC11-s18-1: 11.9 урона в «отходе»). Сзади пол без лавы и обрыва (крупный шаг ≤ 3 вниз) — назад, иначе вбок.
          const me = bot.entity.position, dx = me.x - c.x, dz = me.z - c.z, L = Math.hypot(dx, dz) || 1
          const okCell = (ux: number, uz: number) => {
            for (const k of [1, 2]) {
              const q = me.offset(ux * k, 0, uz * k).floored()
              const feet = bot.blockAt(q), head = bot.blockAt(q.offset(0, 1, 0))
              if (!feet || !head || feet.boundingBox !== 'empty' || head.boundingBox !== 'empty' || /lava|fire/.test(feet.name + head.name)) return false
              let floor = false
              for (let d = 1; d <= 3 && !floor; d++) { const f = bot.blockAt(q.offset(0, -d, 0)); if (f && /lava|fire|magma/.test(f.name)) return false; floor = !!f && f.boundingBox === 'block' }
              if (!floor) return false
            }
            return true
          }
          const back = okCell(dx / L, dz / L), left = !back && okCell(-dz / L, dx / L), right = !back && !left && okCell(dz / L, -dx / L)
          stopWalk()
          try { await guard.raise(false) } catch {}
          phaseTo('отход от толпы под FR')
          out.crowdRuns = (out.crowdRuns || 0) + 1
          if (back || left || right) {
            try { await bot.lookAt(c.offset(0, 1, 0), true) } catch {}
            const key = back ? 'back' : left ? 'left' : 'right'
            // Шагом до 1.2 с, пока у тела есть ифрит в 2.6 (по 0.35 с за раз толпа догоняла между шагами: pA03-s17-1 — 22 урона
            // в «отходе», 8 отходов, смерть).
            bot.setControlState(key, true)
            const t1 = gameClock.now()
            do { await sleep(100) } while (gameClock.now() - t1 < 1200 && B.liveBlazes(bot, dead, 6).some(b => feetDist(b) < 2.6) && !ctl.aborted)
            bot.setControlState(key, false)
            continue
          }
          out.crowdStuck = (out.crowdStuck || 0) + 1
        }
      }
      // 1. Ифрит в досягаемости — бить на откате (смена предмета обнуляет откат — Player.resetAttackStrengthTicker).
      // Иссушитель и магмовый куб у спавнера бьют вплотную (bnf4-5974-603: смерть от иссушителя, пока цикл бил только ифритов).
      // REFLEX: не бить с размахом, когда у цели нейтрал (зомби-пиглин злит всю группу — rx3-s17 смерть от зомби-пиглинов).
      const inReach = [...blazes, ...others].filter(e => B.reachTo(bot, e) <= REACH && pick.canHit(bot, e) && !(reflexOn && B.sweepRisk(bot, e))).sort((a, b) => B.reachTo(bot, a) - B.reachTo(bot, b))
      if (inReach.length) {
        stopWalk()
        // Бить одного до смерти (отбрасывание и смена цели размазывали урон: bn-5974-601 — 26 попаданий, 1 убийство).
        // Иссушитель в досягаемости — первым (удар 8 + иссушение, bnf6/bnf8 на −2642…: смерти от иссушителя при фокусе на ифрите).
        const e = inReach.find(x => x.name === 'wither_skeleton') || inReach.find(x => x.id === focus) || inReach[0]
        focus = e.id
        if (skeletons) guard.watch(e, REACH)
        // Меч в руке перед взмахом: клатч прыжка-крита у края помоста ставит блок и оставляет в руке булыжник (nbz02c 21.10:
        // 11 попаданий по ифритам булыжником, 0 убийств, held=cobblestone).
        if (!isWeapon(bot.heldItem)) await sword()
        const ready = now - Math.max(lastSwing, swapAt) >= (require('./pvp') as typeof import('./pvp')).cooldownMs(bot.heldItem)
        // Крит (Player.attack: падение, не на земле, не в воде/на лестнице, без слепоты) ×1.5: 9 вместо 6 — ифрит за 3 удара.
        // Прыжок за откат до готовности; удар — на спуске. Без опоры над головой (потолок гасит прыжок).
        const v = bot.entity.velocity, falling = !bot.entity.onGround && v.y < -0.08 && !bot.entity.isInWater
        if (!ready && bot.entity.onGround && now - jumpAt > 500 && now - Math.max(lastSwing, swapAt) >= (require('./pvp') as typeof import('./pvp')).cooldownMs(bot.heldItem) - 350) {
          const head = bot.blockAt(bot.entity.position.offset(0, 2.2, 0))
          if ((!head || head.boundingBox === 'empty') && jumpOk(blazes)) { jumpAt = now; bot.setControlState('jump', true); gameClock.setTimeout(() => bot.setControlState('jump', false), 100) }
        }
        // STANCE: два ифрита и больше вплотную (ближний только с 2 бл., по 6 раз в 20 тиков каждый) — сперва шаг назад, потом удар:
        // bzF1-s17-1 21.10 под FR — 14 → 8.8 → 3.3 → 0 за 4 тика от трёх ифритов у спавнера.
        const crowd = stance && bot.entity.onGround && now - jumpAt > 450 ? blazes.filter(b => feetDist(b) < 2.2).sort((a, b) => feetDist(a) - feetDist(b)) : []
        if (crowd.length >= 2 && await backstep(crowd[0])) {
          phaseTo('шаг назад от толпы')
          out.crowdSteps = (out.crowdSteps || 0) + 1
        } else if (ready && (falling || bot.entity.onGround && now - jumpAt > 700)) {
          const aim = pick.aim(bot, e)
          if (aim?.point) {
            try { await guard.raise(false) } catch {}
            phaseTo('меч')
            try { await bot.lookAt(aim.point, true); bot.attack(e); lastSwing = gameClock.now(); out.melee++; if (falling) out.crits = (out.crits || 0) + 1 } catch {}
          }
        } else if (stance && !ready && bot.entity.onGround && now - jumpAt > 450 && blazes.some(b => feetDist(b) < 2.1) &&
          await backstep(blazes.filter(b => feetDist(b) < 2.1).sort((a, b) => feetDist(a) - feetDist(b))[0])) {
          phaseTo('шаг назад от ифрита')
        // Иссушитель в досягаемости — щит между взмахами и под FR (удар 8 + иссушение, щит спереди гасит целиком; cl12/cn13-s19-1 21.10:
        // смерть от иссушителя у трона при полном хп и FR).
        } else if (!ready && (!fr() || hp < 12 || e.name === 'wither_skeleton') && !(bot.entity.onGround && now - jumpAt < 450)) {
          // Между взмахами — щит к ифриту и под огнестойкостью: удар вплотную (6, BlazeAttackGoal раз в 20 тиков) щит гасит спереди
          // (bnf3-6185-601: 3 убийства и смерть от ударов вплотную под FR). Поднят ≥5 тиков до удара (BlocksAttacks.blockDelay).
          try { await bot.lookAt(B.blazeEye(e), true); await guard.raise(true) } catch {}
        }
        await sleep(50)
        continue
      }
      // A visible bow skeleton is not a rest window. Near foes above retain their attack priority.
      if (archer && guard.stats.worn) {
        stopWalk(); bot.setControlState('jump', false)
        guard.watch(archer, REACH)
        phaseTo('щит: скелет-лучник')
        try { await bot.lookAt(archer.position.offset(0, (archer.height || 1.99) * .85, 0), true); await guard.raise(true) } catch {}
        await sleep(50); continue
      }
      // 1б. Ифрит чуть выше досягаемости (до +1.2 по высоте, рядом по горизонтали) — прыжок: удар на спуске, он же крит.
      const overhead = blazes.find(e => pick.canHit(bot, e, { range: REACH + 1.2 }) && B.reachTo(bot, e) <= REACH + 1.2 && eyeDy(e) > 0.3)
      if (overhead && bot.entity.onGround && now - jumpAt > 450 && jumpOk(blazes) && now - Math.max(lastSwing, swapAt) >= (require('./pvp') as typeof import('./pvp')).cooldownMs(bot.heldItem) - 300) {
        stopWalk()
        focus = overhead.id
        try { await guard.raise(false); await bot.lookAt(B.blazeEye(overhead), true) } catch {}
        jumpAt = now; bot.setControlState('jump', true); gameClock.setTimeout(() => bot.setControlState('jump', false), 100)
        phaseTo('прыжок к ифриту')
        await sleep(50)
        continue
      }
      // Иссушитель/магмовый куб в 5 бл. — тоже «вплотную»: не есть, не пить и не отходить спиной к нему (cl12-s19-1 21.10: на помосте
      // ел и отходил под FR при иссушителе в 1.6 бл. — 8 + 8 + иссушение, смерть с 25 убийствами).
      const groundFoe = others.filter(e => /^(wither_skeleton|magma_cube)$/.test(e.name) && feetDist(e) < 5).sort((a, b) => feetDist(a) - feetDist(b))[0]
      const close = blazes.some(e => e.position.distanceTo(bot.entity.position) < 4) || !!groundFoe
      // 1в. Огнестойкость кончилась (3 мин на зелье), а зелья ещё есть — допить, пока вплотную никого (bnfa-7564-662: 7 стержней,
      // эффект кончился на 6-й минуте боя — сгорел и потерял стержни).
      // Продлить заранее: за 15 с до конца выпитой огнестойкости (bnfc-7564-684: сгорел на 200-й с, на исходе первого зелья).
      const frEnding = !!bot._ndFrUntil && bot._ndFrUntil - now < (stance ? 25000 : 15000)
      // STANCE: продление под действующей FR — и при ифритах в 2–4 бл. (шары и огонь не жгут, ближний — только с 2): на помосте
      // ифриты вплотную всегда, и «!close» не давал продлить — FR кончалась посреди боя, а питьё под шарами рвали щит/клатч/еда
      // (cm11-s19-1 21.10: 5 стержней, второе зелье «выпито» без расхода, смерть).
      const renewClear = stance && fr() && frEnding && !groundFoe && !blazes.some(e => feetDist(e) < 2.2)
      if ((!fr() || frEnding && now >= renewOffUntil) && (!close || renewClear) && B.drinkable?.(bot) && (!frLate || fightOn()) && (fr() || B.frSpendOk(bot, dead) && !climbDefer())) {
        stopWalk()
        try { await guard.raise(false) } catch {}
        phaseTo('огнестойкость')
        const until0 = bot._ndFrUntil
        await B.drinkFireResistance(bot, { renew: frEnding })
        // Продление не вышло (зелье не выпито, срок не сдвинулся) — не повторять 5 с: иначе ветка без ожидания крутит цикл.
        if (frEnding && bot._ndFrUntil === until0) { renewOffUntil = now + 5000; await sleep(100) }
        for (let i = 0; i < 40 && !fr(); i++) await sleep(100)
        out.drinks = (out.drinks || 0) + 1
        continue
      }
      // 2а. ND_BLAZE_FR_PICK=1, под огнестойкостью и мало хп: бьёт только ближний удар (d² < 4 с лучом), шары не жгут — отойти от
      // ифритов на 5 бл. и отлечиться (поесть при сытости < 20), а не стоять под ударами (bf09 21.10: под FR 10–14 убийств, смерть от
      // ближнего 30–35 хп за сцену).
      if (process.env.ND_BLAZE_FR_PICK === '1' && fr() && hp < 8) {
        const near = blazes.slice().sort((a, b) => a.position.distanceTo(bot.entity.position) - b.position.distanceTo(bot.entity.position))[0]
        out.frBackoffs = (out.frBackoffs || 0) + 1
        // Иссушитель идёт следом с той же скоростью — не уйти: щит к нему (ближний спереди гасится целиком), удар — шагом 1, когда дойдёт.
        if (groundFoe) {
          stopWalk()
          phaseTo('щит: иссушитель')
          try { await bot.lookAt(groundFoe.position.offset(0, (groundFoe.height || 1.5) * 0.85, 0), true); await guard.raise(true) } catch {}
          await sleep(100)
          continue
        }
        phaseTo('отход под FR')
        if (near && near.position.distanceTo(bot.entity.position) < 5) {
          try { bot.pathfinder.setGoal(new goals.GoalInvert(new goals.GoalNear(near.position.x, near.position.y, near.position.z, 5)), true) } catch {}
          await sleep(400)
          continue
        }
        stopWalk()
        if ((bot.food ?? 20) < 20) { try { await actions.eat(session, {}); out.eats++ } catch {} }
        await sleep(400)
        continue
      }
      // 2. Без огнестойкости и мало хп, вплотную никого — отлёжка в коробке (поесть, отлечиться) и назад.
      // ND_BLZ_PIT=1: без FR и хп < 10 — яма с крышкой на месте (post.digInPlace: 3 вниз, крышка над головой; ~2 с копки), там еда и
      // регенерация до 18 (не дольше 60 с), потом крышку снять и столбом наверх. В укрытии/коробке под шарами огонь и залпы добивали
      // (cv13: смерть «сгорел» с уроном под рефлексом 33–40 — отлечиться было негде).
      if (process.env.ND_BLZ_PIT === '1' && !fr() && hp < 10 && now >= (out.pitOffUntil || 0) && !blazes.some(e => feetDist(e) < 2.3) && !groundFoe && bot.entity.onGround) {
        stopWalk()
        phaseTo('яма: копка')
        const t1 = gameClock.now(), hp1 = hp
        const r: any = await B.digInNear(bot, ctl).catch(e => ({ ok: false, why: e.message }))
        const rec: any = { ok: !!r.ok, why: r.why, sealed: r.sealed, hp0: Math.round(hp1) }
        if (r.ok) {
          phaseTo('яма: лечение')
          const tr = gameClock.now()
          while (!ctl.aborted && (bot.health ?? 0) > 0 && (bot.health ?? 0) < 18 && gameClock.now() - tr < 60000) {
            if ((bot.food ?? 20) < 20 && (bot.health ?? 20) < 18) { try { await actions.eat(session, {}); out.eats++ } catch {} }
            await sleep(500)
            if ((bot.food ?? 20) < 18 && !bot.inventory.items().some(i => /cooked|bread|apple|carrot|potato|steak|porkchop|mutton|chicken|rabbit|cod|salmon|beef/.test(i.name))) break
          }
          rec.hp1 = Math.round(bot.health ?? 0)
          phaseTo('яма: выход')
          const SL: typeof import('./sealed') = require('./sealed')
          const top = bot.entity.position.floored().offset(0, 2, 0)
          try { if (bot.blockAt(top)?.boundingBox === 'block') await SL.digCell(bot, top) } catch {}
          const up = await (require('./build') as typeof import('./build')).towerUp(bot, ctl, r.depth || 3, { sneak: true }).catch(e => ({ ok: false, reason: e.message }))
          rec.up = !!(up && up.ok)
        }
        rec.s = Math.round((gameClock.now() - t1) / 1000)
        // Не вышло (мост/помост тонкий: «под ногами: air») — 10 с не пробовать (pt1: попытка на каждом обороте цикла).
        if (!rec.ok) out.pitOffUntil = gameClock.now() + 10000
        ;(out.pits ||= []).push(rec)
        if ((out.pits as any[]).length > 20) (out.pits as any[]).shift()
        await sword()
        continue
      }
      // COVER: отлёжка — в укрытии с едой (ветка 7), не в коробке (cv5: «отлёжка» до 108 с, коробка «не закрылась»).
      if (!fr() && hp < 9 && !close && !coverOn) {
        stopWalk()
        try { await guard.raise(false) } catch {}
        phaseTo('отлёжка')
        const r = await B.boxRest(session, ctl, { toward: spawner, until: 18, maxMs: 60000 })
        out.rests.push({ rested: !!r.rested, why: r.why, hp: Math.round(bot.health ?? 0) })
        if (!r.rested && (bot.health ?? 0) < 7) { out.stopped = `хп ${Math.round(bot.health ?? 0)}, отлёжка не вышла: ${r.why || '?'}`; out.bail = true; break }
        await sword()
        continue
      }
      // 3. Поесть, пока вплотную никого.
      if ((bot.food ?? 20) < 17 && !close) {
        stopWalk()
        try { await guard.raise(false) } catch {}
        phaseTo('еда')
        try { await actions.eat(session, {}); out.eats++ } catch {}
        await sword()
        continue
      }
      // 4. Стержни на полу рядом, вплотную никого.
      // Под огнестойкостью — и при ифритах в 3+ бл. (bnf4-7564-604: 22 убийства, подобрано 4 стержня).
      // ND_BLAZE_FR_PICK=1: под FR мешает сбору только ифрит в досягаемости своего удара (d < 2.5), а не любой в 3.45 (bf09 21.10: 10–14
      // убийств и «ещё 4 стержня лежат рядом» — сбор не начинался).
      const pickupClear = fr() ? !blazes.some(e => process.env.ND_BLAZE_FR_PICK === '1' || stance ? e.position.distanceTo(bot.entity.position) < (stance ? 2.2 : 2.5) : B.reachTo(bot, e) <= REACH + 0.5) : reflexOn ? !groundFoe && !blazes.some(e => feetDist(e) < 2.3) : !close
      if (pickupClear && B.droppedRods(bot, 12, { reachable: true }) > 0) {
        try { await guard.raise(false) } catch {}
        phaseTo('сбор')
        const rods0 = countOf(bot, 'blaze_rod'), at0 = bot.entity.position.clone()
        await B.collectRods(bot, ctl, 12, 5000, { stopIf: () => B.liveBlazes(bot, dead, fr() ? (stance ? 1.9 : 2) : reflexOn ? 2.2 : 3).length > 0 || !!reflex?.active() })
        out.collects++
        // Сбор вернулся сразу без стержня и без шага — уступить игровой тик, а не крутить цикл без ожидания (bf04-s17-2 21.10).
        if (countOf(bot, 'blaze_rod') <= rods0 && bot.entity.position.distanceTo(at0) < 0.5) { out.idleCollects = (out.idleCollects || 0) + 1; await sleep(250) }
        continue
      }
      // 4б. ND_BLZ_CLIMB: ниже помоста — на помост (под FR или с зельем: шары не страшны, ближний отбивает шаг 1). Спавнер, увиденный
      // по пути, — дальше цель шаблона. Нет подъёма 20 с — 30 с прежним боем.
      if (climbOn && !spawner && now - spawnerLookAt > 2000) {
        spawnerLookAt = now
        spawner = B.visibleSpawner(bot, bot.registry, 20) || null
        if (spawner) out.spawnerSeen = xyz(spawner)
      }
      // Два ифрита и больше в 4 бл. и хп < 14 — не строить столб под ними (в прыжке ни шага назад, ни щита: bzH1-s17-3 21.10 — 20 → 0 за
      // 4 тика ближним трёх ифритов на столбе под троном); сперва бой с места. При полном хп — подъём (bzJ3-s19-1/-2: запрет при любом хп —
      // 7 срывов подъёма, бой снизу, 2–3 убийства за всю FR).
      const cc = climbOn && (fr() || dodge || B.drinkable?.(bot) && (B.frSpendOk(bot, dead) || frClimb)) && !(climb && now < climb.offUntil) && (hp >= 14 || blazes.filter(e => feetDist(e) < 4).length < 2) ? climbCell(bot, spawner, blazes) : null
      if (cc) {
        if (!fr() && !climbDefer() && B.drinkable?.(bot)) {
          stopWalk()
          phaseTo('огнестойкость')
          await B.drinkFireResistance(bot)
          for (let i = 0; i < 40 && !fr(); i++) await sleep(100)
          out.drinks = (out.drinks || 0) + 1
          continue
        }
        const y = bot.entity.position.y, key = cc.toString()
        // ND_BLZ_DROP_PLINTH=1 (blz 21.10): помост ниже тела (5955: крепость у y48–57, тело приходит сверху на 7–8 бл.) — успех хода
        // меряется сближением с клеткой помоста, а не только высотой (вниз «успеха» не бывало: 20 с — срыв ×3, FR сгорала без взмаха,
        // hC12-s18-1/bE2-s18-1), и спуск — прыжком до хп − 6 бл. (урон падения — высота − 3), а не по 3.
        const dropPlinth = process.env.ND_BLZ_DROP_PLINTH === '1'
        const gap = dropPlinth ? bot.entity.position.distanceTo(cc.offset(0.5, 0, 0.5)) : 0
        if (!climb) { climb = { best: y, bestAt: now, at: 0, key: '', gap }; out.climb = { from: Math.floor(y), to: cc.y, tries: 0, fails: 0 } }
        if (y > climb.best + 0.9) { climb.best = y; climb.bestAt = now }
        if (dropPlinth && gap < (climb.gap ?? Infinity) - 0.9) { climb.gap = gap; climb.bestAt = now }
        if (dropPlinth) { const m = bot.pathfinder.movements; if (m) m.maxDropDown = cc.y < y - 2.5 ? Math.max(3, Math.min(10, Math.floor(hp) - 6)) : 3 }
        // ND_BLZ_CLIMB_TOWER=1 (blz 21.10): помост на 3.5+ выше, ход 6 с без продвижения, тело на земле и над головой пусто — столбом
        // прямо вверх до уровня помоста: с вершины виден спавнер и короткий мостик к помосту. −2642: трон на опоре 7×7 в 9 бл. над
        // землёй — подъём pathfinder'ом ×27–×136 смен цели, FR уходила до первого убийства (nA12/nA13/nS02, 1–2 убийства за зелье).
        if (process.env.ND_BLZ_CLIMB_TOWER === '1' && cc.y - y >= 3.5 && now - climb.bestAt > 6000 && bot.entity.onGround && (climb.towers || 0) < 2 &&
            !blazes.some(e => feetDist(e) < 2.6)) {
          const n = Math.min(12, Math.ceil(cc.y - y))
          stopWalk()
          phaseTo('столб к помосту')
          climb.towers = (climb.towers || 0) + 1
          const tw = await (require('./build') as typeof import('./build')).towerUp(bot, ctl, n, { sneak: true }).catch(e => ({ ok: false, placed: 0, reason: e.message }))
          out.climb.towers = (out.climb.towers || 0) + 1
          out.climb.towered = (out.climb.towered || 0) + (tw.placed || 0)
          climb.bestAt = gameClock.now()
          await sword()
          continue
        }
        if (now - climb.bestAt > 20000) {
          climb.offUntil = now + 30000; climb.bestAt = now + 30000; out.climb.fails++; stopWalk()
        } else {
          if (climb.key !== key) { climb.key = key; climb.gap = gap; out.climb.tries++ }
          steer(cc.x, cc.y, cc.z, 1)
          phaseTo('на помост')
          await sleep(100)
          continue
        }
      }
      if (climb && out.climb && !cc) out.climb.at = Math.floor(bot.entity.position.y)
      // DROP_PLINTH: большой спуск — только на ходу к помосту; вне подъёма — прежние 3 (иначе «к ифриту» с помоста прыгал на 7–10 вниз:
      // vN1-s19-1 — «подъём 74→67», под помостом весь FR).
      if (!cc && process.env.ND_BLZ_DROP_PLINTH === '1' && stance && bot.pathfinder.movements && bot.pathfinder.movements.maxDropDown !== 3) bot.pathfinder.movements.maxDropDown = 3
      // 5. Подойти к видимому ифриту на высоте глаз (−2…+2): под огнестойкостью — всегда, без неё — с 12+ хп.
      // Ифрит висит над целью на triangle(0.5, 6.891) от её глаз (Blaze.customServerAiStep, смена раз в 100 тиков) — чаще всего на
      // уровне глаз: под огнестойкостью встать под ним и ждать спуска/прыгать; без неё — только к тем, кто на высоте глаз ±2.
      // STANCE под FR: и к ифритам высоко над нами (до 12, в 16 бл.) — пол под ними и есть помост трона, путь — столбом/ступенями.
      // ND_BLZ_PLINTH_STAY=1 (blz 21.10): на помосте — к ифриту только над помостом (≤ 3.5 от спавнера по горизонтали, глаза ≤ +3: удар
      // с прыжка): ход «к ифриту» за висящими вне помоста съедал 60–80 с из 180 FR (pA03/pA14-s17-1, phaseS) и сбрасывал с помоста (nS06:
      // 75 → 61). Остальные сами спустятся к глазам цели (Blaze.allowedHeightOffset) или их сменят новые из спавнера.
      const stay = process.env.ND_BLZ_PLINTH_STAY === '1' && !!spawner && onPlinth(bot, spawner)
      // ND_BLZ_CHASE_CAP=1 (blz 21.10): за ифритом, к которому 6 с не стало ближе на 1 бл., — не гнаться 20 с (выбрать другого или ждать у
      // спавнера): «к ифриту» съедал 132 с из 180 FR (vN1-s19-1 — первое убийство на 146-й с), 63–82 с (pA03/pA14).
      // COVER: и предел погони (cv5-s16: «к ифриту» 266 с из 396 за недостижимыми).
      const chaseCap = process.env.ND_BLZ_CHASE_CAP === '1' || coverOn
      // COVER: при хп ≥ 14 — вылазка и к ифриту, который нас не видит (в 8 бл.): из укрытия иначе ни одной цели (cv1-s15: 300 с
      // «в укрытии», 5 убийств за 400 с). Хп < 14 — только видящие (остальное время — в укрытии, отлечиться).
      const sortie = coverOn && !fr() && hp >= 14
      // COVER: бой по одному — к ифриту, только если клетку подхода не видит ни один другой ифрит (cv6: шары двух-трёх ифритов с разных
      // сторон — рефлекс метался, урон под ним 21–37 за сцену). Иначе — укрытие (ветка 7).
      // COVER: стержень падает отвесно — к ифриту над лавой/пустотой не идти (radar.floorBelow: пол не глубже 12 и не ниже нас на 5):
      // cv12-s17 «убил 10, выпало 1» — бой над лавовым морем у моста.
      const dropOk = (e: any) => !coverOn || fr() || (require('./blaze/radar') as typeof import('./blaze/radar')).floorBelow(bot, e, bot.entity.position)
      const loneOk = (e: any) => {
        if (!coverOn || fr()) return true
        const C: typeof import('./blaze/cover') = require('./blaze/cover')
        const me = bot.entity.position, tp = e.position, dx = me.x - tp.x, dz = me.z - tp.z, L = Math.hypot(dx, dz) || 1
        const R = underHit && eyeDy(e) >= 2.4 ? 0.9 : 2.8
        const f = B.floorUnder(bot, tp.offset(dx / L * R, 0, dz / L * R))
        // Без боя 15 с — допуск растёт на одного видящего (до 3): иначе укрытие навсегда, когда шесть ифритов спавнера видят все
        // клетки подхода, а новые не родятся — лимит 6 (cv8-s16: два вызова по 392 с «в укрытии», 0 убийств).
        const allow = Math.min(3, 1 + Math.floor((now - (out.engagedAt ?? t0)) / 15000))
        return !!f && C.exposure(bot, f, blazes.filter(x => x !== e)).n <= allow
      }
      // WALL: к ифриту, чей залп вот-вот (заряжен, первый шар < 2 с), не идти — в упор шар не обойти; бить после залпа (откат 5 с + заряд 3).
      const target = blazes.filter(e => !(chaseCap && (chase.skip.get(e.id) ?? 0) > now) && (B.seesMe(bot, e) || sortie && feetDist(e) <= 14) && loneOk(e) && dropOk(e) &&
        !(wallOn && !fr() && radar.charged(e) && radar.quietFor(e) < 2000) && eyeDy(e) >= -2 && eyeDy(e) <= (underHit && !fr() ? 4.2 : stay || chaseCap && spawner ? 3 : fr() ? (stance ? 12 : 5) : 2) && e.position.distanceTo(bot.entity.position) <= (stance && fr() ? 16 : 12) &&
        (!stay || flat(e.position, spawner.offset(0.5, 0, 0.5)) <= 3.5))
        .sort((a, b) => a.position.distanceTo(bot.entity.position) - b.position.distanceTo(bot.entity.position))[0]
      // COVER: два и больше заряженных ифрита с лучом к телу — не подходить (залпы с разных сторон, рефлекс мечется: cv11 урон под
      // рефлексом 20–45 за сцену), а в укрытие (ветка 7); бить того, кто уже в досягаемости, — ветка 1 выше.
      const pinned = coverOn && !fr() && blazes.filter(e => radar.charged(e) && B.seesMe(bot, e)).length >= 2
      if (pinned) out.pinned = (out.pinned || 0) + 1
      if (target && !pinned && (fr() || hp >= 12)) {
        // Без огнестойкости — подход со щитом к цели: шар спереди гасится целиком и не поджигает (BlocksAttacks, фронт 90°); шаг медленнее,
        // зато очередь на подходе не жжёт (bn5: смерть за 25–570 с от шаров и горения).
        if (!fr()) {
          try { await bot.lookAt(B.blazeEye(target), true); await guard.raise(true) } catch {}
        } else { try { await guard.raise(false) } catch {} }
        if (chaseCap) {
          const d = feetDist(target)
          if (chase.id !== target.id) { chase.id = target.id; chase.at = now; chase.best = d }
          else if (d < chase.best - 1) { chase.best = d; chase.at = now }
          else if (now - chase.at > 6000) { chase.skip.set(target.id, now + 20000); chase.id = null; out.chaseSkips = (out.chaseSkips || 0) + 1; stopWalk(); continue }
        }
        out.engagedAt = now
        if (now - goalAt > 400) {
          goalAt = now
          phaseTo('к ифриту')
          out.approaches++
          // STANCE: точка в 2.4 от ифрита по горизонтали со своей стороны — удар достаёт, его удар (d < 2) — нет.
          const me = bot.entity.position, tp = target.position, dx = me.x - tp.x, dz = me.z - tp.z, L = Math.hypot(dx, dz) || 1
          // UNDERHIT: ифрит на 1.9+ выше глаз — встать почти под него (0.9 бл.): удар вверх достаёт низ рамки, а его удар вплотную —
          // нет (ноги ифрита выше наших на 2+, d² ≥ 4).
          // REFLEX: подход на 2.7 (рефлекс держит 2.6 по ногам; ближе 2 ифрит бьёт сам и летит к телу — cv3-s17: 34 урона вплотную).
          const R = underHit && eyeDy(target) >= 2.4 ? 0.9 : reflexOn ? 2.8 : 2.4
          const aimAt = stance ? tp.offset(dx / L * R, 0, dz / L * R) : tp
          const f = B.floorUnder(bot, aimAt) || aimAt.floored()
          steer(f.x, f.y, f.z, 1)
        }
        await sleep(100)
        continue
      }
      // 6. Без огнестойкости — щит к заряженному с лучом.
      // Без щита стоять лицом к заряженному бессмысленно (raise — пустой): при уклонении — дальше (к спавнеру/ждать, шары — уклонением).
      const charged = !fr() && !((dodge || reflexOn) && !guard.stats?.worn) && blazes.find(e => B.seesMe(bot, e) && radar.charged(e))
      if (charged) {
        stopWalk()
        phaseTo('щит')
        try { await bot.lookAt(B.blazeEye(charged), true); await guard.raise(true) } catch {}
        await sleep(50)
        continue
      }
      // ND_BLZ_MELEE_CLEAR=1 (blz 21.10, пользователь 16.10 и 10:55: «потом блоки вокруг ломают, чтобы спавнились активнее»): в затишье
      // (вплотную никого, шаров нет, на нас не смотрит заряженный) — расчистка объёма спавна по цене blaze-clear.plan (выигрыш шанса
      // появления против секунд копки; только то, что видит прицел), как в старом holdSpawner — в бою мечом её не было.
      if (process.env.ND_BLZ_MELEE_CLEAR === '1' && spawner && now >= (out.clearNext || 0) && !blazes.some(e => feetDist(e) < 6) && !radar.incoming(now).length &&
          !blazes.some(e => B.seesMe(bot, e) && radar.charged(e)) && bot.entity.onGround) {
        out.clearNext = now + 4000
        const clearing: typeof import('./blaze-clear') = require('./blaze-clear')
        if (!out.clearObserved) { try { clearing.observe(bot, spawner) } catch {}; out.clearObserved = true }
        const remaining = Math.max(0, want - countOf(bot, 'blaze_rod') - B.droppedRods(bot, 16, { reachable: true }) - blazes.length * 0.5)
        const plan = remaining > 0 ? (() => { try { return clearing.plan(bot, spawner, { rods: remaining, protectedCells: [], horizon: (deadline - now) / 1000, windowMs: 4000 }) } catch { return null } })() : null
        if (plan) {
          stopWalk()
          phaseTo('расчистка спавнера')
          const safe = () => countOf(bot, 'blaze_rod') < want && !B.liveBlazes(bot, dead, 6).length && !radar.incoming(gameClock.now()).length && !!bot.entity.onGround
          const r = await clearing.execute(session, ctl, plan, safe).catch(e => ({ ok: false, why: e.message }))
          ;(out.clearing ||= []).push({ ok: !!r.ok, pos: xyz(plan.pos), gain: plan.gain, why: r.why })
          await sword()
          continue
        }
      }
      // 7. Никого в досягаемости — стоять у спавнера (спавн в ±4 от него, работает при игроке в 16).
      try { await guard.raise(false) } catch {}
      // ND_BLZ_COVER=1: без FR ждать не на виду — в ближней клетке, куда не смотрит ни один ифрит (blaze/cover.ts), в 13 бл. от спавнера;
      // в укрытии — стоять (не к помосту). Пересчёт раз в секунду.
      if (coverOn && !fr()) {
        const C: typeof import('./blaze/cover') = require('./blaze/cover')
        // И скелеты-лучники (cv8-s15: смерть от стрел скелета, 21 урона).
        const all = [...B.liveBlazes(bot, dead, 32), ...others.filter(e => /^(skeleton|stray)$/.test(e.name))]
        if (now - (out.coverAt || 0) > 1000) {
          out.coverAt = now
          const c = C.coverCell(bot, all, { spawner, minSpawner: 3.5, charged: e => radar.charged(e) })
          out.coverCell = c ? c.pos : null
          if (c) out.covers = (out.covers || 0) + 1
        }
        if (out.coverCell && !bot.entity.position.floored().equals(out.coverCell)) {
          goalAt = now
          phaseTo('в укрытие')
          steer(out.coverCell.x, out.coverCell.y, out.coverCell.z, 0)
          await sleep(100)
          continue
        }
        const farSp = !spawner || Math.hypot(bot.entity.position.x - spawner.x - 0.5, bot.entity.position.z - spawner.z - 0.5) >= 3.5
        if (farSp && (!all.length || C.exposure(bot, bot.entity.position.floored(), all).w === 0)) {
          stopWalk()
          phaseTo('в укрытии')
          // В укрытии — лечение едой: при хп < 16 и сытости < 20 (быстрая регенерация — только при 20 и насыщении, FoodData 1.21.11;
          // ветка «еда» ест лишь при сытости < 17 — хп годами шло по 1 за 4 с или стояло).
          if ((bot.health ?? 20) < 16 && (bot.food ?? 20) < 20 && now - (out.coverEatAt || 0) > 3000) {
            out.coverEatAt = now
            try { await actions.eat(session, {}); out.eats++; out.coverEats = (out.coverEats || 0) + 1 } catch {}
            await sword()
            continue
          }
          await sleep(150)
          continue
        }
      }
      // 7а. Ифритов не видно долго, но их слышно (субтитры: сторона и примерная дальность) — шаг на звук за новым лучом. Иначе стойка:
      // шесть ифритов висят за стенами, лимит спавнера (6 в коробке 9³) полон, новые не родятся (bz06-s19-1 21.10: 25 мин у спавнера с
      // FR-набором — 0 убийств, vis 0 при 6 ифритах в 5–12 бл.). ND_BLAZE_SEEK_HEARD=1.
      if (process.env.ND_BLAZE_SEEK_HEARD === '1') {
        if (blazes.some(e => B.seesMe(bot, e))) seenAt = now
        if (now - seenAt > 10000 && now - goalAt > 4000) {
          const S: typeof import('./perception/senses') = require('./perception/senses')
          const h = S.heard(bot, { sinceMs: 8000, match: /blaze/ })[0]
          const q = h && S.hearPoint(bot, h)
          if (q) {
            goalAt = now
            out.seeks = (out.seeks || 0) + 1
            phaseTo('на звук ифрита')
            steer(q.x, q.y ?? bot.entity.position.y, q.z, 3)
            await sleep(150)
            continue
          }
        }
      }
      // ND_BLZ_CLIMB: ждать на полу помоста у спавнера (новые ифриты родятся в досягаемости), а не в 3.5–5 от него — это уже ступени
      // и стены трона (co11-s19-1: 10 убийств за 6 мин FR, тело на стене y73, 453 «к ифриту»).
      const plinth = climbOn && spawner && !onPlinth(bot, spawner) && now - goalAt > 800 ? plinthCells(bot, spawner).sort((a, b) => a.distanceTo(bot.entity.position) - b.distanceTo(bot.entity.position))[0] : null
      if (plinth) {
        goalAt = now
        phaseTo('на помост к спавнеру')
        steer(plinth.x, plinth.y, plinth.z, 0.5)
      } else if (spawner && !(climbOn && onPlinth(bot, spawner)) && bot.entity.position.distanceTo(spawner.offset(0.5, 0.5, 0.5)) > (stance ? 5 : 3.5) && now - goalAt > 800) {
        goalAt = now
        phaseTo('к спавнеру')
        steer(spawner.x, spawner.y, spawner.z, stance ? 3.5 : 2)
      } else if (stance && blazes.some(b => feetDist(b) < 2.1) && bot.entity.onGround &&
          await backstep(blazes.filter(b => feetDist(b) < 2.1).sort((a, b) => feetDist(a) - feetDist(b))[0])) {
        phaseTo('шаг назад от ифрита')
      } else phaseTo('жду ифритов')
      await sleep(150)
    }
  } finally {
    phaseTo('конец')
    stopWalk()
    try { await guard.raise(false) } catch {}
    try { out.shield = guard.report() } catch {}
    shieldTrace?.close()
    if (reflex) {
      reflex.stop()
      const rs = radar.stats, r1 = (x: number) => Math.round(x * 100) / 100
      out.reflex = { ...reflex.stats, radar: { balls: rs.balls, offMax: rs.offMax, offAvg: rs.offN ? r1(rs.offSum / rs.offN) : null, lagAvg: rs.lagN ? r1(rs.lagSum / rs.lagN) : null } }
    }
    try { radar.stop() } catch {}
    bot.removeListener('entityHurt', onHurt)
    bot.removeListener('heldItemChanged', onHeld)
    bot.removeListener('health', onHealth)
    try { bot.pathfinder.setMovements(saved) } catch {}
  }
  out.at = xyz(bot.entity.position)
  out.kills = dead.size - dead0
  if (!out.stopped && ctl.aborted) out.stopped = 'прервано'
  return out
}

export { meleeCamp, climbCell }
