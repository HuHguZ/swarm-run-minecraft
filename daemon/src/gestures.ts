'use strict'
import * as gameClock from './game-clock'
const Vec3: typeof import('vec3').Vec3 = require('vec3')
import { goals } from 'mineflayer-pathfinder'
import * as social from './social'
import { raySees } from './perception'
import { Mood } from './mood'
import { evaluateSocial, type SocialSignal } from './social-graph'
import controlLock = require('./reflex-lock')

// Жесты людей и ответ телом. social.js замечает, что человек подошёл; этот
// файл — что он делает. В майне без слов говорят телом: присед-присед — это
// «привет» или «эй, сюда», прыжки на месте — «смотри на меня», долгий взгляд в
// упор — «я к тебе обращаюсь», предмет под ноги — «на, держи», взгляд на блок
// — «вот это». Живой игрок это видит и отвечает, иногда тем же жестом.
//
// Граница та же, что в social.js: рефлекс — телом, слова — мозгу. Тело
// приседает в ответ, поворачивает голову, подбирает брошенное ему и смотрит
// туда же, куда смотрит человек. Говорить, благодарить, выполнять просьбу —
// дело мозга, и жест будит его из mc_wait так же, как сообщение в чате
// (событие gesture, events.js WAKES).
//
// Каждое правило ниже — по пакетам, которые реально приходят клиенту:
// entityCrouch/entityUncrouch (метаданные позы, mineflayer entities.js:480-490),
// entitySwingArm (пакет animation 0), itemDrop (метаданные предмета: сам
// предмет приходит вторым пакетом после спавна), entitySleep, и позиция с
// поворотом головы (entity.yaw / entity.headYaw / entity.pitch) — по ним
// считается, куда человек смотрит.

// Глаза игрока: 1.62 стоя, 1.27 присев (Pose.CROUCHING, EntityDimensions
// eyeHeight в Player.getDefaultDimensions — 1.62 и 1.27).
const EYE = 1.62
const EYE_CROUCH = 1.27

// Дальше этого человек жестами с нами не разговаривает: присед за 20 блоков
// не виден, а прыжки там — это просто бег.
const GESTURE_R = 10
const STARE_R = 16
// Один и тот же жест одного человека — не чаще, чем раз в это время: присед
// приходит парами пакетов, и двадцать событий про одно «привет» — это шум.
const SAME_GESTURE_MS = 5000
// Долгий взгляд — «смотрит на меня», а не «глянул мимо».
const STARE_MS = 1600
// После того как взгляд засчитан, следующий — только если отвёл глаза хотя бы
// на столько и посмотрел снова, и не чаще раза в STARE_AGAIN_MS.
const STARE_AWAY_MS = 3000
const STARE_AGAIN_MS = 40000
// Смотрит на блок, а не на нас: столько держит взгляд на одной клетке, чтобы
// это было «вот это», а не взгляд под ноги на ходу.
const POINT_MS = 1800
const DEBUG = !!process.env.ND_DEBUG_GESTURES
const POINT_R = 24

// Куда смотрит сущность: те же формулы, что у mineflayer для своего тела —
// вперёд (-sin yaw, -cos yaw), pitch вверх положительный (conv.fromNotchianPitch).
// Для игрока headYaw приходит отдельным пакетом, yaw — с движением; голова
// точнее, если она есть.
function lookDir (ent) {
  const yaw = typeof ent.headYaw === 'number' ? ent.headYaw : ent.yaw
  const pitch = ent.pitch || 0
  return new Vec3(-Math.sin(yaw) * Math.cos(pitch), Math.sin(pitch), -Math.cos(yaw) * Math.cos(pitch))
}

function eyeOf (ent) {
  return ent.position.offset(0, ent.crouching ? EYE_CROUCH : EYE, 0)
}

// Смотрит ли он на наше тело: луч из его глаз проходит через цилиндр нашего
// хитбокса (ширина 0.6, высота 1.8) с небольшим запасом — игрок целится в
// лицо, но «смотрит на тебя» и в грудь тоже. Плюс прямая видимость: сквозь
// стену на нас не смотрят.
function looksAtBody (bot, ent, slack = 0.35) {
  const eye = eyeOf(ent)
  const me = bot.entity.position
  const dir = lookDir(ent)
  // Ближайшая к оси нашего тела точка луча: по горизонтали.
  const hx = dir.x
  const hz = dir.z
  const hn = hx * hx + hz * hz
  const dx = me.x - eye.x
  const dz = me.z - eye.z
  const t = hn > 1e-6 ? (dx * hx + dz * hz) / hn : 0
  if (t <= 0.2) return false
  const px = eye.x + hx * t
  const pz = eye.z + hz * t
  const off = Math.hypot(px - me.x, pz - me.z)
  if (off > 0.3 + slack) return false
  // Высота луча в этой точке — внутри нашего роста.
  const py = eye.y + dir.y * t
  if (py < me.y - slack || py > me.y + 1.8 + slack) return false
  return raySees(bot, eye, me.offset(0, 1.1, 0))
}

// Блок, на который он смотрит (до POINT_R). raycast в prismarine-world
// синхронный у bot.world (worldsync).
function blockLookedAt (bot, ent) {
  try {
    const hit = bot.world.raycast(eyeOf(ent), lookDir(ent), POINT_R, b => b && b.boundingBox !== 'empty')
    return hit || null
  } catch {
    return null
  }
}

function playerEnt (bot, e) {
  if (!e || e === bot.entity || !social.isPlayerEntity(e)) return null
  if (!e.username || e.username === bot.username) return null
  return e
}

function distTo (bot, e) {
  return e.position.distanceTo(bot.entity.position)
}

function sleep (ms) { return new Promise<any>(resolve => gameClock.setTimeout(resolve, ms)) }

// Зов: «иди сюда», «ко мне», «смотри», «глянь», «зацени». И отбой: «стой».
// Грубо, по словам: разбирать смысл — дело мозга, а бежать надо сразу.
const SUMMON = /(иди|беги|подойди|давай|пошли|go|come)\s*(сюда|ко мне|here)|(^|[\s,!.])(сюда|ко мне)([\s,!.?]|$)|(смотри|посмотри|глянь|гляди|зацени|позырь|look)([\s,!.?]|$)/i
const URGENT = /(срочно|быстр|скорее|помоги|спаси|help|!!)/i
const STOP = /^(стой|стоп|не надо|не иди|отбой|отмена|stop|stay)([\s,!.]|$)/i

// Враждебные — за кого вступаться. Не из combat.js (тот тянет pvp и
// половину тела): здесь достаточно имени.
const HOSTILE = /^(zombie|zombie_villager|husk|drowned|skeleton|stray|bogged|parched|spider|cave_spider|creeper|witch|pillager|vindicator|evoker|ravager|vex|phantom|slime|magma_cube|blaze|wither_skeleton|piglin_brute|hoglin|zoglin|silverfish|endermite|guardian|breeze|enderman|zombified_piglin|piglin|wolf|bee|polar_bear|llama|iron_golem)$/

// Хп чужого игрока: LivingEntity.DATA_HEALTH_ID — синхронизируемое поле
// (индекс 9 в метаданных 1.21: 0-7 Entity, 8 руки, 9 здоровье), сервер шлёт
// его всем, кто видит сущность.
function hpOf (ent) {
  const v = ent && ent.metadata ? ent.metadata[9] : null
  return typeof v === 'number' ? Math.round(v * 10) / 10 : null
}

// ------------------------------------------------------------------- рефлексы

// Тело свободно: мозг не ведёт намерение (mc_wait — не занятость, как в
// autopilot.bodyBusy), не спит, не копает, pathfinder не идёт.
function idle (session, bot) {
  if (session.reflex || (session.tactics?.snapshot()?.threatLevel ?? 0) > 0 || bot.entity?.elytraFlying || bot._ndDescend) return false
  const cur = session.current
  if (cur && cur.name !== 'wait') return false
  if (bot.isSleeping || bot.targetDigBlock) return false
  try {
    if (bot.pathfinder && (bot.pathfinder.isMoving() || bot.pathfinder.isMining() || bot.pathfinder.isBuilding())) return false
  } catch {}
  return true
}

// Присесть в ответ: два коротких приседа, как делают люди. Реакция —
// через живые 200-450 мс, а не в тот же тик.
async function crouchBack (bot, times = 2, allowed = () => true) {
  await sleep(200 + Math.random() * 250)
  for (let i = 0; i < times && allowed(); i++) {
    bot.setControlState('sneak', true)
    await sleep(160 + Math.random() * 80)
    if (!allowed()) return
    bot.setControlState('sneak', false)
    await sleep(160 + Math.random() * 100)
  }
}

async function jumpBack (bot, allowed = () => true) {
  await sleep(250 + Math.random() * 250)
  if (!allowed()) return
  bot.setControlState('jump', true)
  await sleep(120)
  if (!allowed()) return
  bot.setControlState('jump', false)
}

async function faceHim (bot, ent) {
  try { await bot.lookAt(eyeOf(ent), true) } catch {}
}

// Подобрать брошенное нам. Идём туда, где предмет ляжет (drops.js: физика полёта —
// mineflayer до секунды показывает его у глаз бросившего), и ждём у него, пока кончится
// задержка подбора (40 тиков у выброшенного игроком). Мозг начал своё намерение — бросаем.
async function pickUp (session, bot, item, ms = 7000) {
  const busy = () => { const cur = session.current; return !!(cur && cur.name !== 'wait') || !!bot.isSleeping || !!bot.targetDigBlock }
  if (busy()) return 'занят'
  const res = await (require('./drops') as typeof import('./drops')).pickOne(bot, { get aborted () { return busy() } }, { id: item.id, e: item }, { timeoutMs: ms })
  if (res === 'прервано') return 'занят'
  return res === 'picked' ? 'подобрал' : 'не дотянулся'
}

// --------------------------------------------------------------------- слежка

// Подключается один раз на тело (как autopilot.hookTemper): на слушателях
// mineflayer плюс таймер взглядов 4 раза в секунду. Состояние — по имени.
function hook (ap, bot) {
  if (ap.gestureBot === bot) return
  ap.gestureBot = bot
  const session = ap.session
  const people = new Map()
  const rec = (name) => {
    let r = people.get(name)
    if (!r) {
      r = { crouches: [], jumps: [], swings: [], said: {}, stareFrom: 0, stareOff: 0, stareSaid: 0, point: null, ground: null, peak: null, lastGesture: 0 }
      people.set(name, r)
    }
    return r
  }
  // Один жест одного человека — не чаще SAME_GESTURE_MS.
  const fresh = (r, kind, ms = SAME_GESTURE_MS) => {
    const now = gameClock.now()
    if (r.said[kind] && now - r.said[kind] < ms) return false
    r.said[kind] = now
    return true
  }
  const emit = (name, kind, text, extra: any = {}) => {
    if (DEBUG) console.log(`[gest] emit ${name} ${kind}: ${text}`)
    // Взгляд во время другого жеста — часть того жеста, а не отдельный
    // «смотрит в упор»: присел, глядя на меня, — это один жест, не два.
    if (kind !== 'смотрит') {
      const r = rec(name)
      r.lastGesture = gameClock.now()
      // Смотрел на меня, пока жестикулировал, — этот взгляд уже сказан
      // жестом; следующий «в упор» — только когда отведёт глаза и посмотрит
      // снова (иначе через три секунды после «привета» приходит второй
      // будильник про тот же взгляд).
      const ent = bot.players[name] && bot.players[name].entity
      if (ent && looksAtBody(bot, ent, 0.8)) r.stareSaid = r.lastGesture
    }
    session.bus.emit('gesture', { name, kind, text, ...extra })
  }
  // Рефлекс в стороне от автопилота: не держать его тик.
  let reflexBusy = false
  const reflex = (fn, signal: SocialSignal = 'look', name = null) => {
    if (reflexBusy || !idle(session, bot)) return false
    const decision = evaluateSocial({ signal, mood: mood.state.mood, affinity: name ? mood.affinity(name) : 50,
      health: bot.health ?? 20, threatLevel: session.tactics?.snapshot()?.threatLevel ?? 0,
      bodyBusy: false, airborne: !!bot.entity?.elytraFlying, interrupted: false, distance: 3 })
    session.socialDecision = decision
    if (!decision.gesture || (signal === 'crouch' && decision.gesture !== 'crouch')) return false
    reflexBusy = true
    controlLock.start(session, async ctl => {
      const allowed = () => !ctl.aborted && (session.tactics?.snapshot()?.threatLevel ?? 0) === 0
        && !(session.current && session.current.name !== 'wait') && !bot.entity?.elytraFlying
      if (allowed()) await fn(allowed)
    }, { owner: 'Skill', priority: 1, source: 'social-gesture' }).catch(() => {}).finally(() => { reflexBusy = false })
    return true
  }
  ap.gestureState = { people, reflexBusy: () => reflexBusy }

  // Настроение и отношение к людям за сессию (mood.js). Одно на сессию —
  // переживает переподключение тела.
  const mood = session.mood || (session.mood = new Mood(session, session.cfg && session.cfg.memoryDir))

  // --------------------------------------------------------------- зов
  // «Иди сюда, покажу», присел или прыгает издалека, глядя на меня. Прибежать
  // ли — решает настроение (mood.decideCome): отношение к нему, как часто
  // зовёт, сам ли ранен и голоден, далеко ли. Добежав — посмотреть туда, куда
  // смотрит он: «смотреть, что показывают» — это и есть зачем звали.
  const summon = { active: null }
  const freeForSummon = () => {
    if (session.reflex || (session.tactics?.snapshot()?.threatLevel ?? 0) > 0 || bot.entity?.elytraFlying || bot._ndDescend) return false
    const cur = session.current
    if (cur && cur.name !== 'wait') return false
    return !bot.isSleeping
  }
  const arrive = async (name, ent) => {
    await faceHim(bot, ent)
    await sleep(300 + Math.random() * 300)
    const r = rec(name)
    let g: any = gaze(bot, ent)
    // Показывал раньше, чем мы дошли, — тоже годится (в пределах 20 с).
    if ((!g || g.atMe || !g.block) && r.pointing && gameClock.now() - r.pointing.at < 20000) {
      g = { block: r.pointing.block, x: r.pointing.x, y: r.pointing.y, z: r.pointing.z }
    }
    if (g && g.block && !g.atMe) {
      try { await bot.lookAt(new Vec3(g.x + 0.5, g.y + 0.5, g.z + 0.5), true) } catch {}
      emit(name, 'пришёл', `прибежал к ${name}; он показывает на ${g.block} (${g.x}, ${g.y}, ${g.z}) — смотрю туда`, { block: g.block, x: g.x, y: g.y, z: g.z })
      await sleep(2200 + Math.random() * 1500)
      if (freeForSummon()) await faceHim(bot, ent)
    } else {
      emit(name, 'пришёл', `прибежал к ${name}, стою рядом, смотрю на него`, {})
    }
  }
  const trySummon = (name, { urgent = false, byGesture = false }: any = {}) => {
    const ent = bot.players[name] && bot.players[name].entity
    if (!ent || !ent.position) {
      session.bus.emit('summon', { name, come: false, text: `${name} зовёт, но я его не вижу — слишком далеко (координаты спроси или mc_goto)` })
      return
    }
    if (summon.active) return
    const d = distTo(bot, ent)
    if (d <= 2.8) {
      if (freeForSummon()) Promise.resolve().then(() => arrive(name, ent)).catch(() => {})
      return
    }
    if (!freeForSummon()) {
      session.bus.emit('summon', { name, come: false, text: `${name} зовёт, но я занят (${session.current?.name || (session.reflex ? 'рефлекс' : 'угроза')}) — решай сам` })
      return
    }
    const dec = mood.decideCome(name, { dist: d, urgent, byGesture })
    session.bus.emit('summon', {
      name,
      come: dec.come,
      chance: dec.chance,
      why: dec.why,
      text: dec.come
        ? `иду к ${name} (${Math.round(d)} бл.)${urgent ? ' бегом' : ''}: ${dec.why}`
        : `не пошёл к ${name}: ${dec.why} (шанс был ${Math.round(dec.chance * 100)}%)`
    })
    if (!dec.come) return
    const me = { name, abort: false }
    summon.active = me
    Promise.resolve().then(async () => {
      await sleep(dec.delayMs)
      try { session.updateMovements() } catch {}
      const deadline = gameClock.now() + 10000 + d / 4.3 * 1600
      let goal = null
      let goalAt = null
      let result = 'не дошёл: время вышло'
      while (!me.abort && gameClock.now() < deadline) {
        if (!freeForSummon()) { result = 'передумал: мозг дал другое дело'; break }
        const e = bot.players[name] && bot.players[name].entity
        if (!e || !e.position) { result = 'потерял его из виду'; break }
        if (distTo(bot, e) <= 2.8) { result = null; break }
        if (!goal || !goalAt || goalAt.distanceTo(e.position) > 1.5 || bot.pathfinder.goal !== goal) {
          goalAt = e.position.clone()
          goal = new goals.GoalNear(goalAt.x, goalAt.y, goalAt.z, 2)
          try { bot.pathfinder.setGoal(goal) } catch {}
        }
        await sleep(250)
      }
      if (me.abort) result = 'остановился: попросили'
      try { if (goal && bot.pathfinder.goal === goal) bot.pathfinder.setGoal(null) } catch {}
      if (summon.active === me) summon.active = null
      const e = bot.players[name] && bot.players[name].entity
      if (!result && e) await arrive(name, e)
      else session.bus.emit('summon', { name, come: false, text: `к ${name}: ${result}` })
    }).catch(() => { if (summon.active === me) summon.active = null })
  }

  const onChat = (username, message) => {
    if (!username || username === bot.username || !bot.players[username]) return
    mood.chat(username, message)
    if (STOP.test(message.trim())) {
      if (summon.active && summon.active.name === username) summon.active.abort = true
      return
    }
    if (SUMMON.test(message)) trySummon(username, { urgent: URGENT.test(message) })
  }
  bot.on('chat', onChat)
  bot.on('whisper', onChat)

  // Настроение от того, что с нами делают: удар человека, своя смерть.
  bot.on('entityHurt', (victim, source) => {
    if (victim !== bot.entity || !source || !social.isPlayerEntity(source)) return
    if (source.username && source.username !== bot.username) mood.bump(source.username, 'ударил', -10, -6)
  })
  bot.on('death', () => mood.bump(null, 'умер', 0, -15))

  // Присед. Пара пакетов на каждый присед; считаем начала.
  bot.on('entityCrouch', (e) => {
    const p = playerEnt(bot, e)
    if (!p) return
    const d = distTo(bot, p)
    if (d > GESTURE_R) return
    const r = rec(p.username)
    const now = gameClock.now()
    r.crouches = r.crouches.filter(t => now - t < 2500)
    r.crouches.push(now)
    if (r.crouches.length < 2) return
    const atMe = looksAtBody(bot, p, 0.8)
    if (!fresh(r, 'присед')) return
    if (fresh(r, 'приветМуд', 300000)) mood.bump(p.username, 'поздоровался', 1, 1)
    // На «привет» от того, кого недолюбливаем, — не приседаем (дуемся).
    const friendly = mood.affinity(p.username) >= 35
    const answered = friendly && (atMe || d < 4) ? reflex(async allowed => { await faceHim(bot, p); await crouchBack(bot, 2 + (Math.random() < 0.4 ? 1 : 0), allowed) }, 'crouch', p.username) : false
    // Издалека и глядя на меня — это «иди сюда».
    if (atMe && d > 4) trySummon(p.username, { byGesture: true })
    emit(p.username, 'присед',
      `${p.username} приседает ${atMe ? 'передо мной, глядя на меня' : 'рядом'} (${r.crouches.length} раза за 2 с) — это «привет» или «эй, сюда»` +
      (answered ? '; присел в ответ' : ''),
      { dist: Math.round(d * 10) / 10, atMe, count: r.crouches.length, answered })
  })

  // Взмах рукой. Удар по нам ловит autopilot.hookTemper (урон); здесь — взмах,
  // направленный в нас, без урона: «тычет», «машет» (или бьёт в мирном режиме).
  bot.on('entitySwingArm', (e) => {
    const p = playerEnt(bot, e)
    if (!p) return
    const d = distTo(bot, p)
    if (d > 6 || !looksAtBody(bot, p, 0.5)) return
    const r = rec(p.username)
    const now = gameClock.now()
    r.swings = r.swings.filter(t => now - t < 2500)
    r.swings.push(now)
    if (r.swings.length < 2 || !fresh(r, 'машет')) return
    const answered = reflex(() => faceHim(bot, p))
    emit(p.username, 'машет', `${p.username} машет рукой в мою сторону${d < 3.5 ? ' (тычет в меня)' : ''}`, { dist: Math.round(d * 10) / 10, answered })
  })

  // Лёг спать. Ночь пропустится, только если лягут все (правило
  // players_sleeping_percentage, по умолчанию 100) — значит, и мы тоже.
  bot.on('entitySleep', (e) => {
    const p = playerEnt(bot, e)
    if (!p) return
    const r = rec(p.username)
    if (!fresh(r, 'спит', 30000)) return
    const night = bot.time && typeof bot.time.timeOfDay === 'number' && bot.time.timeOfDay >= 12542 && bot.time.timeOfDay <= 23459
    emit(p.username, 'спит', `${p.username} лёг спать${night ? ' — ночь пропустится, только если лягу и я (mc_sleep)' : ''}`,
      { dist: Math.round(distTo(bot, p)), night })
  })

  // Друга бьёт моб. Урон приходит пакетом damage_event с виновником
  // (mineflayer: entityHurt(victim, source)); для стрелы виновник — стрелок.
  // Живой напарник оборачивается и вступается: бьём именно этого моба, если
  // тело свободно, хп хватает и характер позволяет (session.temper.defend).
  // Человек, ударивший человека, — не наше дело: только мобы.
  bot.on('entityHurt', (victim, source) => {
    const p = playerEnt(bot, victim)
    if (!p || !source || social.isPlayerEntity(source)) return
    const d = distTo(bot, p)
    if (d > STARE_R) return
    const r = rec(p.username)
    if (!fresh(r, 'ранен', 4000)) return
    const mob = source.name || 'моб'
    const hp = hpOf(p)
    const t = session.temper || {}
    const md = source.position ? source.position.distanceTo(bot.entity.position) : 99
    const canHelp = t.defend !== false && HOSTILE.test(mob) && md < 20 && (bot.health || 0) >= 10 && idle(session, bot) &&
      mood.affinity(p.username) >= 30
    session.bus.emit('friend_hurt', {
      name: p.username,
      by: mob,
      hp,
      dist: Math.round(d * 10) / 10,
      defending: canHelp,
      text: `${mob} бьёт ${p.username}${hp !== null ? ` (у него ${hp} хп)` : ''} в ${Math.round(d)} блоках` + (canHelp ? ' — вступаюсь' : '')
    })
    if (canHelp) {
      Promise.resolve()
        .then(() => session.defend(source.id, p.username))
        .then(res => {
          if (res && (res.killed || (res.kills && res.kills.length))) mood.bump(p.username, 'отбились вместе', 5, 3)
          return res
        })
        .then(res => session.bus.emit('defended', {
          name: p.username,
          by: mob,
          killed: !!(res && (res.killed || (res.kills && res.kills.length))),
          text: res && (res.killed || (res.kills && res.kills.length))
            ? `отбил ${p.username} от ${mob} (хп ${Math.round(bot.health || 0)})`
            : `вступался за ${p.username} (${mob}): ${(res && (res.lost || res.error || (res.lowHealth && 'мало хп, отошёл') || (res.died && 'умер') || res.busy)) || 'бой кончился без победы'}`
        }))
        .catch(() => {})
    }
  })

  // Брошенный предмет. Спавн запоминаем сразу — itemDrop приходит позже, с
  // метаданными, и предмет к тому времени уже пролетел тик-другой.
  const spawned = new Map()
  bot.on('entitySpawn', (e) => {
    if (e && (e.name === 'item' || e.displayName === 'Item')) spawned.set(e.id, { at: gameClock.now(), pos: e.position.clone(), vel: e.velocity ? e.velocity.clone() : null })
    if (spawned.size > 200) spawned.delete(spawned.keys().next().value)
  })
  const throws = new Map()
  bot.on('itemDrop', (item) => {
    const born = spawned.get(item.id)
    spawned.delete(item.id)
    if (!born || gameClock.now() - born.at > 1500) return
    // Чей: предмет, выброшенный игроком, появляется у его глаз (Player.drop:
    // getEyeY() - 0.3). Ближайший игрок, у чьих глаз он родился.
    let who = null
    let best = 2.2
    for (const name of Object.keys(bot.players)) {
      const p = playerEnt(bot, bot.players[name] && bot.players[name].entity)
      if (!p) continue
      const dd = born.pos.distanceTo(p.position.offset(0, EYE - 0.3, 0))
      if (dd < best) { best = dd; who = p }
    }
    if (!who) return
    const d = distTo(bot, who)
    if (d > GESTURE_R) return
    let stack = null
    try { stack = item.getDroppedItem() } catch {}
    const name = stack ? stack.name : 'что-то'
    const count = stack ? stack.count : 1
    // Нам ли: смотрел на нас, или летит в нашу сторону.
    let toMe = looksAtBody(bot, who, 1.2)
    // Скорость броска — из пакета появления (drops.js; у mineflayer она нулевая).
    const vel = (require('./drops') as typeof import('./drops')).spawnVelocity(bot, item.id) || born.vel
    if (!toMe && vel) {
      const vx = vel.x
      const vz = vel.z
      const tx = bot.entity.position.x - born.pos.x
      const tz = bot.entity.position.z - born.pos.z
      const cos = (vx * tx + vz * tz) / ((Math.hypot(vx, vz) || 1) * (Math.hypot(tx, tz) || 1))
      toMe = cos > 0.85 && d < 7
    }
    // Несколько стаков подряд — одно событие: копим 400 мс.
    const key = who.username
    let t = throws.get(key)
    if (!t) {
      t = { items: [], toMe: false, dist: d, ents: [] }
      throws.set(key, t)
      gameClock.setTimeout(() => {
        throws.delete(key)
        // /give выбрасывает игроку «фальшивый» предмет у его глаз и тут же
        // забирает его обратно (GiveCommand: player.drop(...) + makeFakeItem)
        // — ради анимации подбора. Настоящий брошенный предмет 40 тиков
        // лежит; фальшивого к этому моменту уже нет.
        const live = t.ents.map((e, i) => ({ e, it: t.items[i] })).filter(x => bot.entities[x.e.id])
        if (!live.length) return
        t.items = live.map(x => x.it)
        const what = t.items.map(i => `${i.name}×${i.count}`).join(', ')
        const ents = live.map(x => x.e)
        if (t.toMe) mood.bump(key, 'подарок', 6, 4)
        const willPick = t.toMe && idle(session, bot) && !reflexBusy
        emit(key, t.toMe ? 'кинул мне' : 'выбросил',
          t.toMe
            ? `${key} кинул мне ${what}${willPick ? ' — подбираю' : ''}`
            : `${key} выбросил ${what} рядом (не в мою сторону)`,
          { items: t.items, toMe: t.toMe, dist: Math.round(t.dist * 10) / 10 })
        if (willPick) {
          reflex(async () => {
            const got = []
            for (const it of ents) {
              const res = await pickUp(session, bot, it)
              if (res === 'занят') return
              got.push(res)
            }
            const ok = got.filter(x => x === 'подобрал').length
            session.bus.emit('picked_up', {
              from: key,
              text: ok === ents.length ? `подобрал то, что кинул ${key}: ${what}` : `подобрал ${ok} из ${ents.length} брошенного ${key}`
            })
          })
        }
      }, 400)
    }
    t.items.push({ name, count })
    t.ents.push(item)
    t.toMe = t.toMe || toMe
  })

  // Прыжки и взгляды — по таймеру: позиции чужих игроков приходят каждый тик,
  // а решать чаще четырёх раз в секунду незачем.
  const timer = gameClock.setInterval(() => {
    if (!bot.entity) return
    const now = gameClock.now()
    for (const name of Object.keys(bot.players)) {
      const p = playerEnt(bot, bot.players[name] && bot.players[name].entity)
      if (!p) continue
      const d = distTo(bot, p)
      if (d > STARE_R) { people.delete(name); continue }
      const r = rec(name)

      // Прыжок: подъём от «земли» на 0.8+ и возврат. Земля — последняя высота,
      // на которой он стоял два замера подряд. Прыжок на месте — если между
      // прыжками почти не сдвинулся (бег с прыжками — это не жест).
      const y = p.position.y
      if (r.lastY !== undefined && Math.abs(y - r.lastY) < 0.01) r.ground = y
      r.lastY = y
      if (r.ground !== null && !r.peak && y - r.ground > 0.8) {
        r.peak = { at: now, x: p.position.x, z: p.position.z }
      } else if (r.peak && r.ground !== null && y - r.ground < 0.1) {
        r.jumps = r.jumps.filter(j => now - j.at < 3500)
        r.jumps.push(r.peak)
        r.peak = null
        const first = r.jumps[0]
        const still = Math.hypot(p.position.x - first.x, p.position.z - first.z) < 1.5
        if (r.jumps.length >= 2 && still && d <= GESTURE_R && fresh(r, 'прыгает')) {
          const atMe = looksAtBody(bot, p, 0.8)
          const answered = atMe && Math.random() < 0.6 && mood.affinity(name) >= 35 ? reflex(async allowed => { await faceHim(bot, p); await jumpBack(bot, allowed) }, 'jump', name) : false
          if (atMe && d > 4) trySummon(name, { byGesture: true })
          emit(name, 'прыгает', `${name} прыгает на месте${atMe ? ', глядя на меня' : ''} (${r.jumps.length} раза) — зовёт внимание` + (answered ? '; подпрыгнул в ответ' : ''),
            { dist: Math.round(d * 10) / 10, atMe, answered })
        }
      }
      if (r.peak && now - r.peak.at > 1500) r.peak = null

      // Долгий взгляд в упор.
      const staring = looksAtBody(bot, p)
      if (DEBUG && (staring !== r.dbgStaring)) {
        r.dbgStaring = staring
        console.log(`[gest] ${name} ${staring ? 'смотрит' : 'отвёл'} stareSaid=${r.stareSaid ? now - r.stareSaid : 0} said=${r.said.смотрит ? now - r.said.смотрит : 0} last=${r.lastGesture ? now - r.lastGesture : 0}`)
      }
      if (staring) {
        if (!r.stareFrom) r.stareFrom = now
        r.stareOff = 0
        const quiet = now - (r.lastGesture || 0) > STARE_MS + 1500
        if (quiet && now - r.stareFrom >= STARE_MS && !r.stareSaid && now - (r.said.смотрит || 0) > STARE_AGAIN_MS) {
          r.stareSaid = now
          r.said.смотрит = now
          const answered = reflex(() => faceHim(bot, p))
          emit(name, 'смотрит', `${name} смотрит на меня в упор с ${Math.round(d)} блоков` + (answered ? '; посмотрел в ответ' : ''),
            { dist: Math.round(d * 10) / 10, answered })
        }
      } else {
        if (!r.stareOff) r.stareOff = now
        if (now - r.stareOff > 400) r.stareFrom = 0
        if (r.stareSaid && now - r.stareOff > STARE_AWAY_MS) r.stareSaid = 0
      }

      // Указывает взглядом на блок: держит одну клетку POINT_MS. Мозгу — в
      // mc_players (pointing), телу — посмотреть туда же (общее внимание),
      // событие не будит: это контекст для «вот это», «сюда», «сломай его».
      if (d <= GESTURE_R && !looksAtBody(bot, p)) {
        const hit = blockLookedAt(bot, p)
        const key = hit ? `${hit.position.x},${hit.position.y},${hit.position.z}` : null
        if (key && r.point && r.point.key === key) {
          if (!r.point.said && now - r.point.from >= POINT_MS) {
            r.point.said = true
            r.pointing = { block: hit.name, x: hit.position.x, y: hit.position.y, z: hit.position.z, at: now }
            reflex(async () => {
              await sleep(250 + Math.random() * 300)
              try { await bot.lookAt(hit.position.offset(0.5, 0.5, 0.5), true) } catch {}
              await sleep(900 + Math.random() * 600)
              if (idle(session, bot)) await faceHim(bot, p)
            })
          }
        } else {
          r.point = key ? { key, from: now, said: false } : null
        }
      }
    }
  }, 250)
  bot.once('end', () => gameClock.clearInterval(timer))
}

// Для mc_players: куда человек смотрит прямо сейчас и на что указывал
// последним долгим взглядом.
function gaze (bot, ent) {
  const p = playerEnt(bot, ent)
  if (!p) return null
  const atMe = looksAtBody(bot, p)
  if (atMe) return { atMe: true, text: 'смотрит на меня' }
  const hit = blockLookedAt(bot, p)
  if (!hit) return { atMe: false, text: 'смотрит в небо или вдаль' }
  return {
    atMe: false,
    block: hit.name,
    x: hit.position.x,
    y: hit.position.y,
    z: hit.position.z,
    text: `смотрит на ${hit.name} (${hit.position.x}, ${hit.position.y}, ${hit.position.z})`
  }
}

export { hook, gaze, hpOf, lookDir, looksAtBody, blockLookedAt }
