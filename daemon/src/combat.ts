'use strict'
import * as gameClock from './game-clock'
import { goals } from 'mineflayer-pathfinder'
const Vec3: typeof import('vec3').Vec3 = require('vec3')
import { sleep, xyz, standableY, travelXZ, inWater, escapeWater } from './movement'
import './perception'
import { bestWeapon, itemNamed, countItems, diffItems } from './items'
import './build'
import { collectNearbyDrops } from './actions'
// Одеться перед боем — не побочное дело combat.js, а его прямое: автопилот
// не одевается, пока работает намерение, а бой — намерение. Цикла импортов
// нет: armor.js тянет только ./movement.
import * as armor from './armor'
// One definition of "who is a person", shared with the reflex that watches
// them: two copies is two things to forget to update, and the routine that
// turns the head toward a player and the code that refuses to swing at one
// must never disagree about the same body.
import { isPlayerEntity } from './social'
import * as pvp from './pvp'
import * as flee from './flee'
import { decideFight } from './play-policy'
import * as survival from './combat-safety'
// Часть имён выше теперь нужна только частям combat/* — импорты оставлены (perception и build — без имён), чтобы не
// менять порядок загрузки модулей.
import { RANGED, liveAttacker, attackerHint, findTarget, nearestHostile, countHostiles, threatPoint } from './combat/foes'
import { corridorShape, sealCorridor } from './combat/corridor'
import { retreat } from './combat/retreat'
import { makeShield } from './combat/shield'

// One swing of a sword: the cooldown the fight loop paces itself by, and the
// unit the shield's cost is billed in — a second of block inside sword reach is
// a second and a half of damage not dealt.
const SWING_MS = 650

// ------------------------------------------------------------ pre-flight

// Ближе этого одеваться поздно: план из четырёх предметов — это восемь
// кликов и окно подтверждения, около секунды с небольшим, а зомби проходит
// шесть блоков примерно за три. Внутри этого радиуса дерёмся в том, что есть.
const ARMOR_GAP = 6

// Броня перед боем, один раз и до сближения.
//
// Автопилот одевает бота раз в 15 секунд и НЕ берётся за это, пока работает
// намерение (autopilot.js:457) — правило разумное, щёлкать инвентарём посреди
// работы вредно. Но бой — это намерение, в котором броня нужна больше, чем в
// любом другом. Замерено 2026-09-01 на try-shield: бот отдрался целый раунд с
// полным железным набором в рюкзаке и defense 0, потому что /clear снял
// надетое, а таймер автопилота до боя не подошёл. То есть исключение не
// размывает правило, а достаёт из него ровно один случай — и ровно один
// момент, когда это дёшево: пока моб ещё идёт к нам.
async function dressForFight (session, ctl, entity) {
  const bot = session.bot
  let gap = Infinity
  try { gap = entity.position.distanceTo(bot.entity.position) } catch {}
  // Голым — одеваться даже вплотную: секунда кликов дешевле боя с защитой 0
  // (арена 2026-09-25: бот раз за разом дрался без брони, полный комплект в рюкзаке).
  const naked = [5, 6, 7, 8].every(s => !bot.inventory.slots[s])
  const hasArmor = bot.inventory.items().some(i => /_(helmet|chestplate|leggings|boots)$/.test(i.name))
  if (gap <= ARMOR_GAP && !(naked && hasArmor)) return { skipped: `вплотную (${Math.round(gap)} бл.) — дерусь в чём есть` }
  // Рот и руки — один курсор: actions.eat таскает еду через bot.equip
  // (actions.js:1103). armor.js теперь проверяет этот же флаг у себя, но
  // спросить до кликов дешевле, чем получить отказ после.
  if (session.eating) return { skipped: 'ем — дерусь в чём есть' }

  const t0 = gameClock.now()
  let r
  try {
    r = await armor.equipBestArmor(session, ctl, { confirmMs: 400 })
  } catch (err) {
    // Одеться не вышло — это не причина не драться. Мозг увидит причину
    // словами и решит сам, стоит ли отступать.
    return { skipped: String((err && err.message) || err) }
  }
  const seconds = Math.round((gameClock.now() - t0) / 100) / 10
  if (r.stopped) return { skipped: r.stopped, defense: r.defense }
  if (!r.equipped.length) return { already: true, defense: r.defense }
  // Цена видна: это клики, и они стоят секунд перед контактом.
  return {
    put: r.equipped.map(e => e.item),
    defense: r.defense,
    seconds,
    skipped: r.skipped ? r.skipped.join('; ') : undefined
  }
}

// ---------------------------------------------------------------- fight

// The brain picks the target, the weapon and when to bail. The swinging is
// done here, because a 2-5 second round trip cannot hit anything.
// Except one target it does not get to pick by accident: a person. allowPlayer
// has to be written into the call, and findTarget refuses every other way in.
// The shield lives outside the body so that every one of the body's exits —
// kill, seal, retreat, timeout, throw — reports the same accounting and drops
// the block on the way out. Missing one of those returns is how a bot walks
// away from a won fight still standing there with its shield up.
const FIGHT_NOAVOID = () => process.env.ND_FIGHT_NOAVOID !== '0'
// Сторож боя (ND_FIGHT_WATCH=1): бой мобу, которого не достать (зомби на краю лесенки сверху, паук прыгает), шёл
// десятки секунд без взмахов, пока бьют (trap4 02.10: «взмахов 0, попаданий 1», 16 → 0 за 20 с; пещера — паук 7.8 с при
// зомби рядом). Ни одного удара за 4 с при потере ≥ 4 хп, или за 8 с при ≥ 8 — бросить бой: дальше отвечает тот, кто
// звал (кампания, автопилот EMERGENCY — бой самоохраняемый, его он не рвёт).
const FIGHT_WATCH = () => process.env.ND_FIGHT_WATCH !== '0'
function watchFight (bot, parent) {
  const sub: any = { aborted: false, onAbort: [], why: null }
  sub.abort = () => {
    if (sub.aborted) return
    sub.aborted = true
    for (const fn of sub.onAbort) { try { fn() } catch {} }
  }
  parent.onAbort.push(() => sub.abort())
  if (parent.aborted) sub.abort()
  if (!FIGHT_WATCH() || !bot) return { ctl: sub, close: () => {} }
  const hp0 = bot.health ?? 20
  const t0 = gameClock.now()
  let swings = 0
  const attack = bot.attack
  bot.attack = function (...args: any[]) { swings++; return attack.apply(this, args) }
  // Прогресс боя — не только взмах (S7d, ревью Codex по гонке вооружений: лучник/арбалетчик стрелял и попадал, а сторож
  // «ни одного удара за 4 с» бросал бой — 9 из 12 боёв проигравшего оборваны): выстрел/бросок (отпустил «использовать»)
  // и урон по другой сущности рядом — тоже ход.
  const deact = bot.deactivateItem
  if (typeof deact === 'function') bot.deactivateItem = function (...args: any[]) { swings++; return deact.apply(this, args) }
  const onHurt = (e) => { try { if (e && e !== bot.entity && bot.entity && e.position && e.position.distanceTo(bot.entity.position) < 48) swings++ } catch {} }
  try { bot.on('entityHurt', onHurt) } catch {}
  const timer = gameClock.setInterval(() => {
    const lost = hp0 - (bot.health ?? 0)
    const dt = gameClock.now() - t0
    if (swings === 0 && ((dt >= 4000 && lost >= 4) || (dt >= 8000 && lost >= 8))) {
      sub.why = `ни одного удара за ${Math.round(dt / 1000)} с, а потерял ${Math.round(lost)} хп — бросил бой`
      sub.abort()
    }
  }, 250)
  return { ctl: sub, close: () => { gameClock.clearInterval(timer); if (bot.attack !== attack) bot.attack = attack; if (typeof deact === 'function' && bot.deactivateItem !== deact) bot.deactivateItem = deact; try { bot.removeListener('entityHurt', onHurt) } catch {} } }
}

// The producer owns the price comparison. This mailbox belongs to one intent,
// not watchFight's child controller, and never aborts a physical action.
function strategicYieldState (ctl) {
  if (!ctl._ndStrategicYield) {
    const state = ctl._ndStrategicYield = { pending: null, closed: false }
    ctl.onAbort.push(() => { state.pending = null; state.closed = true })
  }
  return ctl._ndStrategicYield
}

function requestStrategicYield (session, p: any = {}) {
  const current = session.current
  if (current?.name !== 'fight' || !current.ctl || current.ctl.aborted || current.ctl._ndStrategicYield?.closed) return { accepted: false, reason: 'no active fight' }
  if (current.params?.allowStrategicYield !== true) return { accepted: false, reason: 'fight did not opt in' }
  for (const key of ['roundScope', 'fightId', 'target']) {
    if (typeof p?.[key] !== 'string' || !p[key] || p[key] !== current.params[key]) return { accepted: false, reason: `${key} mismatch` }
  }
  const r = p.request
  if (r !== null && (!r || typeof r.requestId !== 'string' || !r.requestId ||
    !['LootChest', 'Recover'].includes(r.preparation) || typeof r.quoteEvidence !== 'string' ||
    !Number.isFinite(r.before) || !Number.isFinite(r.after))) return { accepted: false, reason: 'invalid preparation request' }
  const state = strategicYieldState(current.ctl)
  const receivedAt = gameClock.now()
  state.pending = r === null ? null : { requestId: r.requestId, preparation: r.preparation,
    quoteEvidence: r.quoteEvidence, before: r.before, after: r.after, receivedAt }
  return { accepted: true, receivedAt }
}

// A guard snapshot belongs to one running intent; it never enters the intent queue or cancels its controller.
function requestFightGuard (session, p: any = {}) {
  const current = session.current
  if (current?.name !== 'fight' || !current.ctl || current.ctl.aborted || current.ctl._ndFightClosed) return { accepted: false, reason: 'no active fight' }
  for (const key of ['roundScope', 'fightId', 'target']) {
    if (typeof p?.[key] !== 'string' || !p[key] || p[key] !== current.params?.[key]) return { accepted: false, reason: `${key} mismatch` }
  }
  const coordinate = n => Number.isFinite(n) && Math.abs(n) <= 30000000
  const position = q => q && [q.x, q.y, q.z].every(coordinate)
  if (!Array.isArray(p.digAvoid) || p.digAvoid.length > 4096 || p.digAvoid.some(q => !position(q) ||
      ![q.x, q.y, q.z].every(Number.isInteger) || q.feetY !== undefined && !coordinate(q.feetY)) ||
      p.swarmStand !== null && !position(p.swarmStand) ||
      p.shoveAt !== undefined && p.shoveAt !== null && !position(p.shoveAt)) return { accepted: false, reason: 'invalid guard snapshot' }
  const xyz = q => ({ x: q.x, y: q.y, z: q.z })
  current.params.digAvoid = p.digAvoid.map(q => ({ ...xyz(q), ...(q.feetY !== undefined ? { feetY: q.feetY } : {}) }))
  current.params.swarmStand = p.swarmStand === null ? null : xyz(p.swarmStand)
  if (p.shoveAt !== undefined) current.params.shoveAt = p.shoveAt === null ? null : xyz(p.shoveAt)
  return { accepted: true }
}

async function fight (session, ctl, opts: any = {}) {
  const w = watchFight(session.bot, ctl)
  const pctl = ctl
  const yieldState = opts.allowStrategicYield === true ? strategicYieldState(pctl) : null
  const strategicYield = () => {
    if (!yieldState || yieldState.closed || pctl.aborted || session.current?.ctl !== pctl) return null
    const pending = yieldState.pending
    // Two 500-game-ms watcher periods: stale prices must be quoted again.
    return pending && gameClock.now() - pending.receivedAt < 1000 ? { ...pending } : null
  }
  ctl = w.ctl
  const guard: any = makeShield(session, ctl, opts)
  guard.safety = survival.watch(session.bot)
  // Обход мобов pathfinder'а (flee.mobAvoidance) в бою мешает дойти до цели: клетки у самой цели и у её соседей
  // стоят по 30–50, поиск кончается partial/noPath, и тело стоит под ударами (trap0 02.10, пещера: «взмахов 0»,
  // 18 → 0 за 15 с, путь partial length 3 → noPath). В бою к цели — без обхода; отход (retreat/disengage) — с ним.
  // По умолчанию так (замер survival 02.10–03.10); ND_FIGHT_NOAVOID=0 — по-старому.
  const bot = session.bot
  const avoidWas = bot._ndNoMobAvoid
  if (FIGHT_NOAVOID()) bot._ndNoMobAvoid = true
  try {
    let r
    try {
      r = await fightBody(session, ctl, { ...opts, strategicYield }, guard)
    } catch (e) {
      if (!ctl.why || pctl.aborted) throw e
      r = {}
    }
    if (ctl.why && !pctl.aborted) {
      try { bot.pathfinder.setGoal(null) } catch {}
      try { bot.clearControlStates() } catch {}
      r = { ...r, stopped: ctl.why, watched: true }
    }
    return { ...r, shield: guard.report(), armor: guard.pre || undefined, mobs: guard.mobs || undefined }
  } finally {
    pctl._ndFightClosed = true
    if (yieldState) { yieldState.pending = null; yieldState.closed = true }
    w.close()
    bot._ndNoMobAvoid = avoidWas
    guard.safety.close()
    guard.close()
  }
}

// Один бой — прежние параметры и const тела fightBody, общие для его частей (подготовка, игрок, моб в поле, штрек).
interface FightCtx {
  session: any; ctl: any; guard: any; bot: any; entity: any; decision: any; label: string; ranged: boolean
  retreatAtHealth: number; reach: number; timeoutSeconds: number; calmAfterMs: number; arena: any; allowRanged: any
  lastStand: boolean; repelLava: boolean; engaged: boolean; roundScope: any; strategicYield: any; targets: any[]; relocateTo: any
  potionFirst: boolean; wasWet: boolean; weapon: any; collectSafeDrops: (radius: number) => Promise<any>
}

async function fightBody (session, ctl, { target, retreatAtHealth = 6, reach = 3.2, timeoutSeconds = 60, allowPlayer = false, calmAfterMs = 0, clearArea, arena = null, purpose, resourceGoal, allowRanged, lastStand = false, repelLava = false, engaged = false, roundScope = null, strategicYield = null, targets = [], relocateTo = null, potionFirst = false }: any = {}, guard) {
  const bot = session.bot
  // Зачистка большой площадки: искать первого по всему её радиусу.
  const entity = findTarget(bot, target, session, { allowPlayer, radius: Math.max(24, clearArea || 0) })
  if (!entity) throw new Error(`не вижу цель${target ? ' ' + target : ''}${attackerHint(session)}`)
  const decision = decideFight(session, entity, { target, clearArea, purpose, resourceGoal })
  if (decision.skip) return { skipped: true, stopped: decision.stopped, purpose: decision.purpose }

  async function collectSafeDrops (radius) {
    // CF22: a second walker hit during post-kill settling. Recheck its attack window each poll.
    const pickup = (require('./tempo') as typeof import('./tempo')).track(bot, { threats: () => guard.safety.check({ target: liveAttacker(session) }).threats
      .map(threat => bot.entities[threat.id]).filter(foe => foe && foe !== entity) })
    try {
      return await collectNearbyDrops(bot, ctl, { radius, timeoutMs: 5000, canContinue: () =>
        !ctl.aborted && (bot.health ?? 0) > 0 && survival.safeGround(bot) && pickup.safe(2 * gameClock.TICK_MS).ok })
    } finally { pickup.close() }
  }

  const label = entity.username || entity.name
  const ranged = !!(entity.name && RANGED.has(entity.name))
  const fb: FightCtx = { session, ctl, guard, bot, entity, decision, label, ranged, retreatAtHealth, reach, timeoutSeconds, calmAfterMs,
    arena, allowRanged, lastStand, repelLava, engaged, roundScope, strategicYield, targets, relocateTo, potionFirst,
    wasWet: false, weapon: null, collectSafeDrops }
  const early = await fightPrepare(fb)
  if (early) return early
  if (isPlayerEntity(entity)) return fightPlayer(fb)
  if (lastStand || repelLava || !corridorShape(bot, threatPoint(entity)).corridor) return fightOpen(fb)
  const sealed = await fightSealFirst(fb)
  if (sealed) return sealed
  return fightCorridor(fb)
}

// Вода, оружие, броня и щит, затем проверка начала боя: не годится — отход (результат), годится — ничего.
async function fightPrepare (fb: FightCtx) {
  const { session, ctl, guard, bot, entity, retreatAtHealth, reach, arena, lastStand, repelLava, engaged } = fb
  // Fighting from the water is not fighting: pathfinder will not swim to the
  // target and the body just floats there being shot.
  if (inWater(bot) && !lastStand) {
    fb.wasWet = true
    await escapeWater(bot, ctl, { timeoutMs: 8000 })
  }

  fb.weapon = bestWeapon(bot)
  if (fb.weapon) await bot.equip(fb.weapon, 'hand')

  // Порядок не случаен: armor.js кладёт щит в свободную левую руку последним
  // шагом своего плана, так что после него guard.wear() чаще всего находит
  // щит уже надетым и не кликает второй раз.
  guard.pre = await dressForFight(session, ctl, entity)

  // A shield in the off-hand is the difference between trading with a skeleton
  // and being pincushioned on the approach. It goes on for every fight and not
  // only against shooters: the clicks cost two hundred milliseconds once, and
  // a bot that equips it mid-fight equips it while being shot at.
  guard.watch(entity, reach)
  guard.sawMobs(countHostiles(bot, 8))
  await guard.wear()

  // Модуль PvP распознаёт также лечебные зелья; общий вход проверяет еду и
  // оружие, а его цикл — безопасное окно для конкретного лечебного предмета.
  const potionHeal = bot.inventory.items().some(i => /potion$/.test(i.name) && ['heal', 'regen'].includes(pvp.potionRole(pvp.potionOf(i))))
  // engaged (S4d, tactics/minecraft.ts Fight; ND_S4D=0 — прежнее): тактика уже взвесила бой у тела (размен/«дёшево»), и проверка
  // начала боя («нет запаса еды после восстановления сытости») не отменяет его — 60 из 3135 тактических Fight живой телеметрии
  // кончились «skipped» без единого взмаха, тактика выбирала их снова. Остаётся проверка продолжения боя (phase continue).
  const preparation = guard.safety.check({ target: entity, phase: engaged && process.env.ND_S4D !== '0' ? 'continue' : 'start', minHealth: Math.max(8, retreatAtHealth), instantHeal: potionHeal, repelLava })
  // Арена с игроком (arena задан): бой до конца, как arenaStay в pvp.duel — без оружия и еды тоже (гонка вооружений, s7).
  const arenaDuel = !!arena && isPlayerEntity(entity) && preparation.action !== 'dead'
  if (!lastStand && !arenaDuel && preparation.action !== 'fight') {
    await guard.raise(false)
    if (FIGHT_NOAVOID()) bot._ndNoMobAvoid = false
    const escape = await survival.disengage(session, ctl, () => [entity, ...flee.hostilesAround(bot, 16).map(h => h.e)])
    return { skipped: true, lowHealth: preparation.action === 'recover', stopped: preparation.reason, safety: preparation, escape }
  }
}

// Человек — другой бой. Моб идёт по прямой и бьёт, когда достал; человек
// отходит в перезарядке, крутится и бьёт в прыжке, и доктрина «подошёл и
// махай раз в 650 мс» проигрывает ему всухую (живой прогон 2026-09-24: 12
// ударов бота против 20). Вся тактика — в pvp.js.
async function fightPlayer (fb: FightCtx) {
  const { session, ctl, guard, bot, entity, decision, retreatAtHealth, timeoutSeconds, calmAfterMs, arena, allowRanged, lastStand, repelLava,
    roundScope, strategicYield, targets, relocateTo, potionFirst } = fb
  const r = await pvp.duel(session, ctl, entity, {
    retreatAtHealth,
    timeoutSeconds,
    guard,
    calmAfterMs: calmAfterMs || 0,
    allowRanged,
    lastStand,
    repelLava,
    purpose: decision.purpose,
    roundScope,
    strategicYield,
    targets, relocateTo, potionFirst,
    // Поле арены (arena.js): не уходить с него за соперником, вернуться, если выпал.
    arena
  })
  if (!lastStand && r.lowHealth && !ctl.aborted && (bot.health ?? 0) > 0) {
    if (FIGHT_NOAVOID()) bot._ndNoMobAvoid = false
    const how = await retreat(session, ctl, entity)
    return { ...r, retreated: true, ...how }
  }
  return r
}

// Моб на открытом месте — то же микро: зомби достаёт на ~1.4 блока, мы на
// 2.9, так что удар с края и шаг назад в перезарядке оставляют его без
// ответа; скелету — зигзаг и уклон от стрел; криперу — спринт-удар и отход.
// В штреке остаётся старая доктрина ниже: там не отступают и запечатывают.
// Здоровье кончилось — отход по доктрине (retreat), как и раньше.
async function fightOpen (fb: FightCtx) {
  const { session, ctl, guard, bot, entity, decision, retreatAtHealth, timeoutSeconds, allowRanged, lastStand, repelLava, collectSafeDrops } = fb
  const hunting = /^(cow|pig|sheep|chicken|rabbit|mooshroom)$/.test(entity.name || '')
  const r = await pvp.duel(session, ctl, entity, {
    retreatAtHealth,
    timeoutSeconds,
    guard,
    clearArea: decision.clearArea,
    allowRanged,
    lastStand,
    repelLava,
    purpose: decision.purpose
  })
  if (!lastStand && r.lowHealth && !ctl.aborted && (bot.health ?? 0) > 0) {
    const from = entity.isValid ? entity : nearestHostile(bot, 16)
    if (FIGHT_NOAVOID()) bot._ndNoMobAvoid = false
    const how = from ? await retreat(session, ctl, from) : { mode: 'врагов рядом уже нет' }
    return { ...r, retreated: true, from: from ? (from.name || '?') : undefined, ...how }
  }
  // Добыча: мясо с животного, порох с крипера, стрелы со скелета. Бой в
  // поле (pvp.duel) кончается на смерти цели, а дроп остаётся лежать —
  // охота за едой приносила ноль свинины (прогон campaign 2026-09-25).
  // Штрековая ветка ниже подбирает сама; здесь — то же, если цель умерла.
  if ((r.kills && r.kills.length) || !entity.isValid) {
    const before = countItems(bot)
    // Животное могло умереть от стрелы вне прежних восьми блоков. Подбор
    // должен видеть место смерти, иначе охота тратит стрелы и приносит ноль.
    const radius = hunting ? Math.max(8, Math.min(24, Math.ceil(entity.position.distanceTo(bot.entity.position)) + 2)) : 8
    try { await collectSafeDrops(radius) } catch {}
    r.gained = diffItems(before, countItems(bot))
    r.picked = (Object.values(r.gained) as any[]).reduce((n: any, count) => n + count, 0)
  }
  return r
}

// Walking at an archer down a straight drift is the one approach with no
// cover at any point of it, and the price is measured, not guessed: run 3b
// walked fifteen blocks and went 17 hp to 5 while landing two swings, run 3
// walked nine and paid 4. Call it 0.8 hp per block and use the worse of the
// two readings, because guessing high costs two blocks of cobblestone and
// guessing low costs twelve hp. The wall is the other side of that trade:
// run 3 sealed at ten blocks for two blocks and zero damage.
async function fightSealFirst (fb: FightCtx) {
  const { session, ctl, bot, entity, label, ranged, retreatAtHealth } = fb
  const APPROACH_COST_PER_BLOCK = 0.8

  // Decided before the chase starts rather than at the health threshold,
  // because reaching that threshold means taking the arrows first: the same
  // code sealed from its own square at 17 hp and walked nine blocks into the
  // line at 20, in the same drift, purely because of where health started.
  //
  // And decided against retreatAtHealth alone. An earlier version had its own
  // quiet second threshold two points above that one; it never actually fired
  // in a run, but a policy the brain cannot see is a policy it cannot argue
  // with. The brain sets exactly one number, and the only question asked here
  // is whether the walk would spend it -- with the arithmetic put into the
  // result in words, so "I stopped short of a fight you ordered" arrives as a
  // sentence and not as a surprise.
  if (ranged && !ctl.aborted) {
    const gap = entity.position.distanceTo(bot.entity.position)
    const toll = Math.round(gap * APPROACH_COST_PER_BLOCK)
    const line = corridorShape(bot, threatPoint(entity))
    // Under about four blocks it is already inside sword reach, and the sword
    // is faster than a wall.
    if (line.corridor && gap > 4 && (bot.health ?? 20) - toll <= retreatAtHealth) {
      const seal = await sealCorridor(session, ctl, line)
      if (seal.ok) {
        return {
          retreated: true,
          from: label,
          health: Math.round(bot.health ?? 0),
          swings: 0,
          mode: seal.placed ? 'запечатал штрек' : 'штрек уже перекрыт',
          why: `не пошёл на сближение: ${Math.round(gap)} блоков по прямой стоили бы ~${toll} хп, а бросать бой велено на ${retreatAtHealth}`,
          corridor: true,
          sealed: true,
          placed: seal.placed,
          at: seal.at
        }
      }
    }
  }
}

// Штрек: старая доктрина — сближение, удар раз в перезарядку, щит против стрелка; отход по порогу хп.
async function fightCorridor (fb: FightCtx) {
  const { session, ctl, guard, bot, entity, decision, label, ranged, retreatAtHealth, reach, timeoutSeconds, collectSafeDrops } = fb
  // В режиме замера тело не двигается вовсе: сближение кончается ближним боем,
  // а ближний бой опускает щит и меряет уже не то. Один if вместо арены со рвом.
  const chase = () => {
    if (guard.measure) return
    try { bot.pathfinder.setGoal(new goals.GoalFollow(entity, 2), true) } catch {}
  }
  chase()
  ctl.onAbort.push(() => {
    try { bot.pathfinder.setGoal(null) } catch {}
    try { bot.deactivateItem() } catch {}
  })

  const deadline = gameClock.now() + Math.min(300, timeoutSeconds) * 1000
  let swings = 0
  let stood = null
  let lastSeal = 0

  while (!ctl.aborted && gameClock.now() < deadline) {
    if (!entity.isValid) {
      await guard.raise(false)
      try { bot.pathfinder.setGoal(null) } catch {}
      await collectSafeDrops(8)
      return {
        killed: label,
        swings,
        weapon: fb.weapon ? fb.weapon.name : 'кулаки',
        wasWet: fb.wasWet || undefined,
        stoodGround: stood || undefined
      }
    }

    // Золотое яблоко раньше отхода: +4 сердца поглощения и регенерация II
    // (fightkit.healInFight — раз в 8 с, только если хп упало до 10 и ниже).
    if ((bot.health ?? 20) <= Math.max(10, retreatAtHealth + 4) && bot.inventory.items().some(i => /golden_apple$/.test(i.name))) {
      await guard.raise(false)
      if (await (require('./fightkit') as typeof import('./fightkit')).healInFight(session, ctl, { weapon: fb.weapon, retreatAtHealth }).catch(() => false)) continue
    }
    if (decision.purpose === 'food' && guard.safety.hit() > 0) {
      try { bot.pathfinder.setGoal(null) } catch {}
      return { stopped: 'получил урон на охоте — новое наблюдение и защита', swings }
    }
    const hp = bot.health ?? 20
    const safety = guard.safety.check({ target: entity, minHealth: Math.max(8, retreatAtHealth) })
    if (safety.action !== 'fight') {
      await guard.raise(false)
      if (safety.action === 'dead') return { stopped: safety.reason, safety }
      // Режим замера кончается САМ и отход не делает. Порог срабатывал и
      // раньше — ветка выше никогда не смотрела на guard.measure, — но
      // дальше тело уходило в retreat(), а отход по открытому месту от
      // стрелка это шестнадцать блоков спиной к нему, с места, без разгона
      // (mode «укрытия не нашёл, просто убежал»). Пять прогонов из пяти
      // кончились смертью ВО ВРЕМЯ отхода: замер укладывался в бюджет, а
      // отход — нет, и весь бюджет выживания держался на нём.
      // Дальше тело подхватывает автопилот: как только намерение кончилось,
      // session.current пуст, и fleeIfDying уводит бота сам. То есть выживание
      // здесь стоит не на боевой доктрине, а на рутине, и это сказано вслух.
      if (guard.measure) {
        try { bot.pathfinder.setGoal(null) } catch {}
        return {
          measured: true,
          from: label,
          health: Math.round(hp),
          swings,
          stopped: `бюджет хп исчерпан: порог ${retreatAtHealth}, отход не делаю`,
          survivesOn: 'дальше уводит автопилот (fleeIfDying), боевого отхода в режиме замера нет'
        }
      }
      if (FIGHT_NOAVOID()) bot._ndNoMobAvoid = false
      const escape = await survival.disengage(session, ctl, () => [entity, ...flee.hostilesAround(bot, 16).map(h => h.e)])
      guard.safety.lastEscape = escape
      const how = await retreat(session, ctl, entity)
      return { retreated: true, from: label, health: Math.round(bot.health), swings, safety, escape, ...how }
    }

    const tick = gameClock.now()
    guard.sawMobs(countHostiles(bot, 8))
    const dist = entity.position.distanceTo(bot.entity.position)
    if (dist <= reach) {
      await guard.raise(false)
      try {
        await bot.lookAt(entity.position.offset(0, (entity.height || 1.8) * 0.85, 0), true)
        bot.attack(entity)
        swings++
        guard.swung()
      } catch {}
      // Melee shielding is a swap, not a bonus: the block only goes up during
      // the cooldown, when there is nothing to swing with anyway. Off unless
      // asked for, because it also spends the turn the next swing needs —
      // try-shield.js case (в) is what decides whether it pays.
      if (guard.melee) await guard.raise(true)
    } else if (ranged) {
      // The block only counts against what comes at the front, and pathfinder
      // stops steering the head the moment the goal is reached (index.js:607 is
      // inside its path loop). Standing at an archer's feet with the shield up
      // and the back turned is a shield that measures as doing nothing.
      try { await bot.lookAt(threatPoint(entity), true) } catch {}
      await guard.raise(guard.measure ? guard.phase() : true)
    }
    // Sword cooldown is 0.625s; swinging faster just wastes damage. Sleeping
    // the REMAINDER of the tick rather than a flat 650, because everything
    // above it takes real time: lookAt awaits a packet and a shield raise
    // waits for the server to confirm. A flat sleep turned the stated 650 into
    // a second and more, and then a shield comparison measures the sleep.
    await sleep(Math.max(0, SWING_MS - (gameClock.now() - tick)))
  }

  await guard.raise(false)
  try { bot.pathfinder.setGoal(null) } catch {}
  return { timeout: true, target: label, swings, targetAlive: entity.isValid, stoodGround: stood || undefined }
}

export { fight, requestStrategicYield, requestFightGuard, watchFight, dressForFight, ARMOR_GAP, SWING_MS }
export { HOSTILES, RANGED, trackAttackers, liveAttacker, findTarget, nearestHostile, countHostiles } from './combat/foes'
export { corridorShape, sealCorridor, openRun, headroomAt, openSides, shieldFlanks } from './combat/corridor'
export { retreat, coverSpots } from './combat/retreat'
export {
  makeShield, findShield, shieldUp, facingCos, offHandItem, OFF_HAND_SLOT, SHIELD_DELAY_TICKS, SHIELD_NATIVE_CONFIRM_MS
} from './combat/shield'
