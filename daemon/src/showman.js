'use strict'
const gameClock = require('./game-clock')
// Человек в бою (2026-09-26, просьба пользователя: «боты просто бегут и бьют
// вслепую, тактики одинаковые; пусть затаиваются, отбегают, подзывают, жмут
// шифт, машут мечом, кивают — как в боксе: подозвал, отбежал, и только потом
// в бой; и время от времени меняют поведение, хаотично, как живой»).
//
// pvp.js зовёт отсюда маленькими крючками:
//  · pre   — до сшибки и в затишье: стойка (круг, присед, кивок, мотает головой,
//            взмах мечом, прыжки, подзыв), ответ тем же на его жест, засада за
//            колонной. Берёт тело на тик и отдаёт в тот же тик, как только он
//            пошёл в атаку, натянул лук или что-то бросил;
//  · steer — в ближнем бою поверх решения pvp.js: фаза (напор, оборона,
//            хитрость, шоу), финт на краю его досягаемости и наказание промаха,
//            отход-сброс размена. Удар (canHit) остаётся за pvp.js на каждом тике;
//  · victory — после убийства: присесть над ним, взмах, оглядеться.
// ND_HUMAN=0 выключает слой целиком (прогон «до»), ND_HUMAN_CHAT=0 — только чат.
//
// Механика, на которую опираемся (декомпиляция клиента 1.21.11, github
// extremeheat/extracted_minecraft_data, ветка client1.21.11):
//  · взмах в воздух у ванильного клиента — Minecraft.startAttack, ветка MISS:
//    missTime = 10 (MultiPlayerGameMode.hasMissTime: не в творческом) и
//    player.resetAttackStrengthTicker(); пока missTime > 0, startAttack сразу
//    выходит — 10 тиков (500 мс) клик не проходит вовсе, а шкала удара у него
//    пустая. Сервер про промах знает только взмах: ServerGamePacketListenerImpl
//    .handleAnimate = resetLastActionTime() + swing() — серверный счётчик заряда
//    не трогается. Поэтому финт работает против человека (его клиент заперт на
//    500 мс), а против бота на mineflayer — нет (он и не машет мимо);
//  · свой взмах мечом в воздух (bot.swingArm, пакет arm_animation) — тот же
//    handleAnimate: на ванильном сервере (мир по LAN) заряд не трогает. Но
//    Paper 1.21.11 заряд СБРАСЫВАЕТ — замер try-showman.js swing 2026-09-26:
//    железный меч с полным зарядом 4–5 урона, после трёх взмахов в воздух
//    0 / 0.39 / 1.39, как после смены слота (0.27). Поэтому на не-ванильном
//    сервере машем, только если он не дойдёт до руки раньше, чем заряд
//    вернётся, и часы ближнего боя (melee.js) узнают, что заряд с нуля;
//  · досягаемость игрока — ENTITY_INTERACTION_RANGE 3.0 от глаз до хитбокса
//    (Player.createAttributes), клиент выбирает цель только в ней
//    (GameRenderer.pick → filterHitResult): стоим в 3.1–3.4 — его клик уходит
//    в MISS.

const ON = process.env.ND_HUMAN !== '0'
const CHAT = process.env.ND_HUMAN_CHAT !== '0'
// Качество боя (pvp.js FIX, 2026-09-26): нрав — на каждый бой случаем, а не
// по нику (NeuroDown всегда «задира», NeuroDown2 всегда «хитрец» — второй
// проигрывал 3:7, пятился и прятался); фазы короче; стойка — короткое окно;
// нажим из pvp.js (c.press) снимает стойку, засаду, финты и паузы.
// ND_FIGHTFIX=0 — как раньше.
const FIXP = process.env.ND_FIGHTFIX !== '0'
const HIT_REACH = 2.9
const THEIR_REACH = 3.4
const EYE = 1.62

const PHASES = ['напор', 'оборона', 'хитрость', 'шоу']
// Нрав — постоянный для бота (по нику), чтобы два одинаковых бота с одним
// китом дрались по-разному; в каждом бою — ещё свой разброс поверх.
// show — любит покрасоваться, cunning — финты и засады, patience — сколько
// кружит до сшибки, chat — разговорчивость, rhythm — длина фаз.
const ARCH = {
  задира: { show: 0.85, cunning: 0.3, patience: 0.35, chat: 0.8, rhythm: 0.85, bias: { напор: 1.7, оборона: 0.5, хитрость: 0.6, шоу: 1.5 } },
  боксёр: { show: 0.55, cunning: 0.6, patience: 0.7, chat: 0.4, rhythm: 1.0, bias: { напор: 1.1, оборона: 1.2, хитрость: 1.2, шоу: 0.8 } },
  хитрец: { show: 0.45, cunning: 0.95, patience: 0.6, chat: 0.5, rhythm: 0.9, bias: { напор: 0.7, оборона: 1.0, хитрость: 1.9, шоу: 0.6 } },
  тихоня: { show: 0.25, cunning: 0.55, patience: 0.9, chat: 0.2, rhythm: 1.2, bias: { напор: 0.7, оборона: 1.7, хитрость: 1.1, шоу: 0.35 } }
}
const ARCH_ORDER = ['задира', 'боксёр', 'хитрец', 'тихоня']

function hashName (s) {
  let h = 2166136261
  for (const ch of String(s)) { h ^= ch.codePointAt(0); h = Math.imul(h, 16777619) }
  return h >>> 0
}
function seeded (seed) {
  let a = seed >>> 0
  return () => {
    a = (a + 0x6D2B79F5) >>> 0
    let t = a
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}
const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v))
const between = (a, b) => a + Math.random() * (b - a)
const pick = (arr) => arr[Math.floor(Math.random() * arr.length)]
function weighted (w) {
  const total = Object.values(w).reduce((a, b) => a + b, 0)
  let x = Math.random() * total
  for (const [k, v] of Object.entries(w)) { x -= v; if (x <= 0) return k }
  return Object.keys(w)[0]
}

function personaOf (name) {
  const forced = process.env.ND_HUMAN_PERSONA
  const h = hashName(name)
  const arch = ARCH[forced] ? forced : FIXP ? ARCH_ORDER[Math.floor(Math.random() * ARCH_ORDER.length)] : ARCH_ORDER[h % ARCH_ORDER.length]
  const base = ARCH[arch]
  // Постоянный разброс по нику держал одного бота всегда слабее — теперь случай.
  const r = FIXP ? Math.random : seeded(h)
  // Постоянный разброс бота (от ника) и разброс боя (случай).
  const j = (v, a) => clamp(v + (r() - 0.5) * a + (Math.random() - 0.5) * a * 0.6, 0.05, 1)
  const bias = {}
  for (const p of PHASES) bias[p] = Math.max(0.15, base.bias[p] * (0.8 + r() * 0.4) * (0.85 + Math.random() * 0.3))
  return { name: arch, show: j(base.show, 0.3), cunning: j(base.cunning, 0.3), patience: j(base.patience, 0.3), chat: j(base.chat, 0.3), rhythm: base.rhythm * (0.85 + r() * 0.3), bias }
}

// Свои боты — жестов им меньше (просьба: «против людей больше, против ботов меньше»).
function isBotName (n) {
  if (!n) return false
  const extra = (process.env.ND_BOTS || '').split(',').map(x => x.trim()).filter(Boolean)
  return /^neurodown/i.test(n) || extra.includes(n)
}

// Реплики — редко, коротко, в характере (PERSONA.md: «свой пацан»). Не больше
// одной за бой и не чаще раза в минуту на бота: пользователь не любит спам.
const LINES = {
  posture: ['ну иди сюда', 'давай, давай', 'чё встал?', 'иди, не бойся', 'ну?'],
  mirror: ['о, привет)', 'и тебе привет', 'ну привет-привет', 'здарова'],
  kill: ['гг', 'изи', 'гг вп', 'ещё раунд?', 'ну ты держался', 'бывает)']
}
const lastChat = new WeakMap()

// Действия стойки: сколько длится и на что больше похоже — на показуху
// (show) или на разговор телом (social: против людей их больше).
const ACTS = {
  круг: { ms: [900, 2200], w: 1.1, show: 0.2, social: 0 },
  присед: { ms: [500, 1000], w: 0.25, show: 0.5, social: 1.2 },
  кивок: { ms: [600, 950], w: 0.15, show: 0.3, social: 1.0 },
  головой: { ms: [450, 800], w: 0.12, show: 0.45, social: 0.5 },
  взмах: { ms: [500, 1100], w: 0.3, show: 0.9, social: 0.2 },
  прыжки: { ms: [550, 1100], w: 0.2, show: 0.7, social: 0.3 },
  подзыв: { ms: [900, 1500], w: 0.3, show: 0.5, social: 0.8 },
  пауза: { ms: [150, 450], w: 0.35, show: 0, social: 0 }
}
const ACT_LABEL = {
  круг: 'жест: кружит на средней дистанции',
  присед: 'жест: присед-присед',
  кивок: 'жест: кивок',
  головой: 'жест: мотает головой',
  взмах: 'жест: взмах мечом в воздух',
  прыжки: 'жест: прыжки на месте',
  подзыв: 'жест: подзывает (шаг вперёд-назад)',
  пауза: null
}

function create (opts) {
  if (!ON) return null
  const { bot, session, target, style = {}, used = () => {}, set, aimTo, stopPath, tt, stepOk, cover, fillerCount, styleOut, weaponMs, onAirSwing, nearDrop = null } = opts
  const me0 = target()
  const human = !isBotName(me0 && me0.username)
  const persona = personaOf(bot.username)
  if (styleOut) { styleOut.нрав = persona.name; styleOut.противник = human ? 'человек' : 'бот' }
  const t0 = gameClock.now()
  const stats = { showMs: 0, tacticMs: 0, acts: {}, phaseMs: {} }
  const tally = (label) => { if (!label) return; stats.acts[label] = (stats.acts[label] || 0) + 1; used(label) }
  const cds = {}
  const ready = (k) => gameClock.now() >= (cds[k] || 0)
  const rest = (k, ms) => { cds[k] = gameClock.now() + ms }

  // ------------------------------------------------------------ его жесты
  // Всё на событиях и на тике физики: цикл pvp.js бывает занят луком или
  // глотком по секунде, а кивок длится полсекунды.
  const seen = { crouches: [], swings: [], pitch: [], yaw: [], jumps: [], myY: [], ground: null, peak: null, lastY: null }
  const hits = { took: [], gave: [] }
  let lastExchange = 0
  let deathSpot = null
  const tgt = () => { try { return target() } catch { return null } }
  const theirReachNow = () => {
    const e = tgt()
    if (!e || !e.position || !bot.entity) return 99
    const eye = e.position.offset(0, EYE, 0)
    const p = bot.entity.position
    const cx = clamp(eye.x, p.x - 0.3, p.x + 0.3)
    const cy = clamp(eye.y, p.y, p.y + 1.8)
    const cz = clamp(eye.z, p.z - 0.3, p.z + 0.3)
    return Math.hypot(eye.x - cx, eye.y - cy, eye.z - cz)
  }
  const onCrouch = (e) => { const t = tgt(); if (t && e && e.id === t.id) seen.crouches.push(gameClock.now()) }
  // Взмах: вне его руки — промах (или дразнит), это и ловит финт.
  let whiff = null
  const onSwing = (e) => {
    const t = tgt()
    if (!t || !e || e.id !== t.id) return
    const now = gameClock.now()
    const tr = theirReachNow()
    seen.swings.push({ at: now, tr })
    if (tr > 3.08) {
      if (bait) bait.bit = true
      // Наказуемо, только если успеем дойти за его 10 тиков missTime: с 4.3
      // спринтом (0.28 бл/тик) — за 2-5 тиков.
      if (human && tr <= 4.3) whiff = { at: now, tr }
    }
  }
  const onHurt = (victim, source) => {
    const t = tgt()
    if (!t || !bot.entity || !victim) return
    const now = gameClock.now()
    if (victim === bot.entity && source && source.id === t.id) { hits.took.push(now); lastExchange = now }
    if (victim.id === t.id && source && source.id === bot.entity.id) { hits.gave.push(now); lastExchange = now }
  }
  const onDead = (e) => { const t = tgt(); if (t && e && e.id === t.id && e.position) deathSpot = e.position.clone() }
  const onTick = () => {
    const e = tgt()
    if (!e || !e.position) return
    const now = gameClock.now()
    // Своя высота: прыгаем за критом — его голова ходит за нами вверх-вниз, и
    // это не кивок.
    if (bot.entity) { seen.myY.push({ t: now, y: bot.entity.position.y }); while (seen.myY.length > 40) seen.myY.shift() }
    seen.pitch.push({ t: now, v: e.pitch || 0, x: e.position.x, z: e.position.z })
    // Поворот головы без скачка через ±π: иначе переход 359°→0° читался бы
    // как «мотает головой».
    let yv = typeof e.headYaw === 'number' ? e.headYaw : (e.yaw || 0)
    const prevY = seen.yaw[seen.yaw.length - 1]
    if (prevY) { while (yv - prevY.v > Math.PI) yv -= 2 * Math.PI; while (yv - prevY.v < -Math.PI) yv += 2 * Math.PI }
    seen.yaw.push({ t: now, v: yv })
    while (seen.pitch.length > 40) seen.pitch.shift()
    while (seen.yaw.length > 40) seen.yaw.shift()
    // Прыжок на месте: подъём на 0.8+ над землёй и назад (как в gestures.js).
    const y = e.position.y
    if (seen.lastY !== null && Math.abs(y - seen.lastY) < 0.01) seen.ground = y
    seen.lastY = y
    if (seen.ground !== null && !seen.peak && y - seen.ground > 0.8) seen.peak = { at: now, x: e.position.x, z: e.position.z }
    else if (seen.peak && seen.ground !== null && y - seen.ground < 0.1) { seen.jumps.push(seen.peak); seen.peak = null }
    if (seen.peak && now - seen.peak.at > 1500) seen.peak = null
    // Поводок: тело держим, только пока pre зовут каждый тик. Цикл ушёл в
    // другую ветку (лечение, лук) — отпустить присед и взгляд.
    if (driving && now > lease) release()
  }
  bot.on('entityCrouch', onCrouch)
  bot.on('entitySwingArm', onSwing)
  bot.on('entityHurt', onHurt)
  bot.on('entityDead', onDead)
  bot.on('physicsTick', onTick)

  // Колебания угла — сколько раз он сменил направление с размахом ≥ amp за ms.
  const swingsOf = (arr, ms, amp) => {
    const now = gameClock.now()
    const xs = arr.filter(s => now - s.t <= ms)
    if (xs.length < 4) return 0
    let ext = xs[0].v; let dir = 0; let n = 0
    for (const s of xs) {
      const dv = s.v - ext
      if (dir >= 0 && dv <= -amp) { dir = -1; ext = s.v; n++ } else if (dir <= 0 && dv >= amp) { dir = 1; ext = s.v; n++ } else if ((dir > 0 && s.v > ext) || (dir < 0 && s.v < ext)) ext = s.v
    }
    return n
  }
  const mirrored = {}
  let mirror = null
  const readGestures = (c) => {
    const now = gameClock.now()
    seen.crouches = seen.crouches.filter(t => now - t < 2500)
    seen.swings = seen.swings.filter(s => now - s.at < 2500)
    seen.jumps = seen.jumps.filter(j => now - j.at < 3500)
    // В рубке его прыжки — криты, а взмахи — удары, не жесты; и то, что
    // осталось в памяти от рубки, тоже не жест: считаем только то, что он
    // сделал в спокойном окне (разошлись больше чем на 1.5 с).
    if (c.d > 14 || mirror || c.theirR < THEIR_REACH + 1.1) return
    const calm = Math.max(lastExchange + 1500, t0)
    if (now - calm < 400) return
    const e = tgt()
    const pitch = seen.pitch.filter(s => s.t >= calm)
    const yaw = seen.yaw.filter(s => s.t >= calm)
    const still = pitch.length > 10 && Math.hypot(pitch[pitch.length - 1].x - pitch[pitch.length - 11].x, pitch[pitch.length - 1].z - pitch[pitch.length - 11].z) < 0.8
    const myYs = seen.myY.filter(s => now - s.t <= 1600).map(s => s.y)
    const meSteady = myYs.length > 4 && Math.max(...myYs) - Math.min(...myYs) < 0.4
    const jumps = seen.jumps.filter(j => j.at >= calm)
    let kind = null
    if (seen.crouches.filter(t => t >= calm).length >= 2) kind = 'присед'
    else if (meSteady && still && swingsOf(pitch, 1600, 0.4) >= 3) kind = 'кивок'
    else if (meSteady && still && swingsOf(yaw, 1400, 0.3) >= 3) kind = 'головой'
    else if (jumps.length >= 2 && e && Math.hypot(e.position.x - jumps[0].x, e.position.z - jumps[0].z) < 1.5) kind = 'прыжки'
    else if (seen.swings.filter(s => s.tr > 4.5 && s.at >= calm).length >= 2) kind = 'взмах'
    if (!kind || mirrored[kind]) return
    mirrored[kind] = true
    // Против человека отвечаем почти всегда, боту — через раз.
    if (Math.random() < (human ? 0.95 : 0.5)) mirror = { kind, at: now, after: now + (style.reactMs || 180) + between(150, 450) }
    tally(`вижу его жест: ${kind}`)
  }

  // ---------------------------------------------------------------- фазы
  let phase = null
  let phaseAt = gameClock.now()
  const nextPhase = (c) => {
    const w = {}
    for (const p of PHASES) w[p] = persona.bias[p]
    w.напор *= 0.6 + (style.aggression ?? 0.6) // характер боя из pvp.js
    const diff = (c.hp ?? 20) - (c.theirHp ?? 20)
    if (diff <= -4) { w.оборона *= 1.8; w.хитрость *= 1.4; w.шоу *= 0.3; w.напор *= 0.7 }
    if (diff >= 4) { w.напор *= 1.5; w.шоу *= 1.4 }
    if ((c.hp ?? 20) < 9) w.шоу *= 0.15
    if (!human) w.шоу *= 0.6
    if (phase) w[phase.name] *= 0.45 // тянет сменить
    const name = weighted(w)
    const was = phase ? phase.name : null
    phase = { name, since: gameClock.now(), until: gameClock.now() + (FIXP ? between(6000, 14000) : between(10000, 30000)) * persona.rhythm }
    if (name !== was) tally('фаза: ' + name)
  }
  const tickPhase = (c) => {
    const now = gameClock.now()
    if (phase) stats.phaseMs[phase.name] = (stats.phaseMs[phase.name] || 0) + Math.min(200, now - phaseAt)
    phaseAt = now
    if (!phase || now >= phase.until) nextPhase(c)
  }

  // --------------------------------------------------------------- стойка
  let driving = false
  let lease = 0
  let posture = null // { budgetUntil, act }
  let engaged = false
  let lullRolled = false
  let lastTick = gameClock.now()
  let rushSwings = 0
  let honorRush = null
  let circleKey = Math.random() < 0.5 ? 'left' : 'right'
  let circleFlipAt = 0
  const keys = ['forward', 'back', 'left', 'right', 'jump', 'sprint', 'sneak']
  const release = () => {
    if (!driving) return
    driving = false
    for (const k of keys) set(k, false)
    aimTo('target')
  }
  const drive = (ctl) => {
    driving = true
    lease = gameClock.now() + 150
    for (const k of keys) set(k, !!ctl[k])
  }
  let chatSlot = null
  const chatP = (human ? 0.5 : 0.12) * (0.5 + persona.chat)
  if (CHAT && Math.random() < chatP) chatSlot = pick(['kill', 'kill', 'posture', 'mirror'])
  const say = (slot) => {
    if (!CHAT || chatSlot !== slot) return
    chatSlot = null
    const now = gameClock.now()
    if (now - (lastChat.get(bot) || 0) < 60000) return
    lastChat.set(bot, now)
    const line = pick(LINES[slot])
    try { bot.chat(line) } catch {}
    tally(`чат: «${line}»`)
  }

  // Взмах в воздух (см. шапку): на Paper — только если заряд успеет вернуться
  // (оружие + 300 мс), пока он добежит до руки (его спринт 0.28 бл/тик, а если
  // бежим и мы — вдвое быстрее).
  const swingCostly = () => !/^vanilla$/i.test(String((bot.game && bot.game.serverBrand) || ''))
  const swingOk = (theirR, both = false) => {
    if (!swingCostly()) return true
    const T = (weaponMs ? weaponMs() : 625) + 300
    return Math.max(0, theirR - 3.3) / (both ? 0.56 : 0.28) * 50 > T
  }
  const airSwing = (theirR, both = false) => {
    if (!swingOk(theirR, both)) return false
    try { bot.swingArm() } catch { return false }
    if (swingCostly()) {
      if (bot._ndMelee) bot._ndMelee.resetAt = Math.max(bot._ndMelee.resetAt || 0, gameClock.now())
      if (onAirSwing) onAirSwing()
    }
    return true
  }
  const closingOf = (c) => {
    const e = tgt()
    if (!e || !c.vel || !bot.entity) return 0
    const me = bot.entity.position
    return (c.vel.x * (me.x - e.position.x) + c.vel.z * (me.z - e.position.z)) / Math.max(c.d, 0.1)
  }
  // Когда можно покрасоваться: он не достанет и не выстрелит, пока мы
  // отвечаем на его ход (цикл 50 мс + реакция), и ничем не занят — занятого
  // наказывает tempo, а не стойка.
  const unsafeWhy = (c, closing) => {
    if (c.perch || c.fort || c.meInWeb) return 'занят'
    if (c.theyBow) return 'он тянет лук'
    // Его заряженный арбалет смотрит на нас (read.aimedAtMe, 2026-09-26):
    // выстрел мгновенный — стойка под ним — это стрела в грудь (hisxbow:
    // бот кивал и приседал под прицелом).
    if (c.cbAimed) return 'его арбалет на мне'
    if (c.incoming) return 'летит снаряд'
    if (c.others) return 'второй рядом'
    if (c.hp < 11) return 'мало хп'
    if (c.theirHp != null && c.theirHp > c.hp + 6) return 'проигрываю'
    if (gameClock.now() - (tt ? tt.myHurtAt : 0) < 1200) return 'по мне попали'
    if (c.theirR < THEIR_REACH + 1.3) return 'он близко'
    if (closing > 0.17) return 'он идёт в атаку'
    if (Math.abs(c.dy) > 2.5) return 'разная высота'
    if (!c.seesBody) return 'не вижу'
    if (c.busyFoe) return 'не время'
    if (tt) {
      const s = tt.state(tgt())
      if (s.consuming || s.pillaring || s.placing || s.inWeb || s.pearled) return 'он занят — наказывать'
    }
    return null
  }
  const startAct = (kind) => {
    const a = ACTS[kind]
    const act = { kind, t0: gameClock.now(), until: gameClock.now() + between(a.ms[0], a.ms[1]), n: 0, nextAt: 0, seq: null }
    if (kind === 'присед') { act.on = between(150, 230); act.off = between(130, 200); act.taps = 2 + Math.floor(Math.random() * 3) }
    if (kind === 'кивок') act.seq = [-0.55, 0.05, -0.55, 0.05].concat(Math.random() < 0.4 ? [-0.5, 0.05] : []).map(v => v + between(-0.08, 0.08))
    if (kind === 'головой') act.seq = [0.42, -0.42, 0.42, -0.42, 0].map(v => v + between(-0.08, 0.08))
    if (kind === 'подзыв') { act.fw = between(220, 320); act.bk = between(260, 360) }
    if (act.seq) act.step = (act.until - act.t0) / act.seq.length
    posture.act = act
    tally(ACT_LABEL[kind])
    return act
  }
  const nextAct = (c) => {
    // Сначала — ответ тем же на его жест (зеркало), если созрела реакция.
    if (mirror && gameClock.now() >= mirror.after) {
      let kind = mirror.kind === 'головой' && Math.random() < 0.5 ? 'кивок' : mirror.kind
      if (kind === 'взмах' && !swingOk(c.theirR)) kind = 'присед'
      mirror = null
      tally(`отвечаю тем же: ${kind}`)
      say('mirror')
      return startAct(kind)
    }
    const w = {}
    for (const [k, a] of Object.entries(ACTS)) {
      w[k] = a.w + persona.show * a.show + (human ? a.social : a.social * 0.3)
      if (posture.act && posture.act.kind === k) w[k] *= 0.3
    }
    if (!swingOk(c.theirR)) w.взмах = 0
    if (nearDrop && nearDrop()) w.прыжки = 0
    return startAct(weighted(w))
  }
  // Взгляд на него: yaw и pitch от глаз к его глазам.
  const lookAtHim = () => {
    const e = tgt()
    const me = bot.entity.position
    const dx = e.position.x - me.x
    const dz = e.position.z - me.z
    const dy = (e.position.y + EYE) - (me.y + EYE)
    return { yaw: Math.atan2(-dx, -dz), pitch: Math.atan2(dy, Math.hypot(dx, dz)) }
  }
  // Один тик действия стойки: клавиши и взгляд.
  const actTick = (act, c) => {
    const now = gameClock.now()
    const el = now - act.t0
    const k = {}
    // Держать среднюю дистанцию: дальше 7.5 — подойти шагом, ближе его руки
    // с запасом — шаг назад.
    const keep = () => {
      if (c.d > 7.5 && stepOk('forward')) k.forward = true
      else if (c.theirR < THEIR_REACH + 1.6 && stepOk('back')) k.back = true
    }
    aimTo('target')
    switch (act.kind) {
      case 'круг': {
        if (now >= circleFlipAt) { circleKey = circleKey === 'left' ? 'right' : 'left'; circleFlipAt = now + between(900, 2600) }
        if (!stepOk(circleKey)) circleKey = circleKey === 'left' ? 'right' : 'left'
        if (stepOk(circleKey)) k[circleKey] = true
        keep()
        break
      }
      case 'присед': {
        const period = act.on + act.off
        k.sneak = el < period * act.taps && (el % period) < act.on
        break
      }
      case 'кивок':
      case 'головой': {
        const i = Math.min(act.seq.length - 1, Math.floor(el / act.step))
        const base = lookAtHim()
        aimTo('point', act.kind === 'кивок' ? { yaw: base.yaw, pitch: clamp(base.pitch + act.seq[i], -1.5, 1.5) } : { yaw: base.yaw + act.seq[i], pitch: base.pitch })
        break
      }
      case 'взмах': {
        if (now >= act.nextAt) { if (airSwing(c.theirR)) act.n++; act.nextAt = now + between(260, 420) }
        if (stepOk(circleKey)) k[circleKey] = true
        keep()
        break
      }
      case 'прыжки': {
        // У ямы по линии его толчка — не прыгать (pvp.js nearDrop): удар в прыжке унесёт.
        if (now >= act.nextAt && bot.entity.onGround && act.n < 2 && !(nearDrop && nearDrop())) { k.jump = true; act.n++; act.nextAt = now + between(450, 650) }
        break
      }
      case 'подзыв': {
        const cyc = act.fw + act.bk
        const inFw = (el % cyc) < act.fw
        // Шаг к нему — только пока с запасом вне его руки.
        if (inFw && c.theirR > THEIR_REACH + 1.8 && stepOk('forward')) k.forward = true
        else if (!inFw && stepOk('back')) k.back = true
        break
      }
      default: keep()
    }
    return k
  }

  // ---------------------------------------------------------------- засада
  let hide = null
  const hideStart = async (c) => {
    // Засада со стройкой выключена (2026-09-26, пользователь: «бессмысленно
    // строят колонну, чуть постоят и идут обратно»): колонна ставилась и
    // через 1–2 с бросалась («достали — выхожу»), оставляя мусор. ND_HIDE=1 —
    // вернуть.
    if (process.env.ND_HIDE !== '1') return false
    if (!cover || !fillerCount || fillerCount() < 4) return false
    if (!ready('hide') || !bot.entity.onGround || gameClock.now() - t0 < 1500) return false
    const cunningNow = phase && (phase.name === 'хитрость' || phase.name === 'оборона') ? persona.cunning : persona.cunning * 0.25
    // От лучника — всегда повод (стрела в колонну). От бегущего — только
    // издалека и в хитрости: смена предмета на блок сбрасывает заряд меча
    // (Player.tick → resetAttackStrengthTicker при смене предмета), и он
    // должен успеть вернуться (675 мс), пока тот обходит колонну.
    // 2026-09-26: засада не случилась ни разу — лучник тянет лук обычно с 8–20
    // бл., а она ждала его ближе 8.5 и бросала кубик «хитрость × 0.9», вне фазы
    // хитрости — ещё ×0.25 (≈ 0.1 на случай). От стрелы колонна разумна при
    // любом нраве и с любого расстояния, где стрела долетит, — до 16 бл. и шанс
    // 0.3 + 0.6·хитрость; от бегущего — как было (смена предмета стоит заряда).
    const bowWhy = c.theyBow && c.d >= 4.5 && c.d <= 16
    const why = bowWhy ? 'он тянет лук'
      : c.closingNow > 0.1 && c.d >= 6.5 && c.d <= 8.5 && phase && phase.name === 'хитрость' ? 'он идёт на меня' : null
    if (!why || c.theirR < 4.2 || c.hp < 6) return false
    rest('hide', 4000)
    const chance = bowWhy ? 0.3 + 0.6 * persona.cunning : cunningNow * 0.5
    if (Math.random() > chance) return false
    rest('hide', between(20000, 32000))
    release()
    stopPath()
    const e = tgt()
    const placed = await cover(e.position.clone())
    if (!placed) return false
    hide = { since: gameClock.now(), until: gameClock.now() + between(2500, 4200), hpAt: c.hp }
    tally(`засада: спрятался за колонной (${why})`)
    return true
  }
  const hideTick = (c) => {
    const now = gameClock.now()
    const e = tgt()
    const end = (label) => { hide = null; release(); if (label) tally(label) }
    if (!e || !e.isValid) { end(null); return false }
    if (c.seesBody && c.theirR < THEIR_REACH + 1.2) { end('засада: он вышел — бью первым'); return false }
    if (c.seesBody && c.theyBow) { end('засада: обошёл с луком — выхожу'); return false }
    if (gameClock.now() - (tt ? tt.myHurtAt : 0) < 400 || c.hp < hide.hpAt - 1) { end('засада: достали — выхожу'); return false }
    if (now > hide.until || c.d > 18) { end('засада: выглянул из-за колонны'); return false }
    stats.tacticMs += Math.min(100, now - lastTick)
    drive({ sneak: true })
    aimTo('target')
    return true
  }

  // ------------------------------------------------------------------ pre
  const pre = async (c) => {
    const now = gameClock.now()
    const dt = Math.min(100, now - lastTick)
    tickPhase(c)
    readGestures(c)
    const closing = closingOf(c)
    c.closingNow = closing
    // Его руку мы уже видели вблизи — бой начался; затишье — разошлись.
    if (c.theirR < THEIR_REACH + 0.2) { lastExchange = now; engaged = true }
    if (now - lastExchange < 2000) lullRolled = false
    try {
      // Нажим (pvp.js): долго без размена — никакой стойки и засады, в бой.
      if (FIXP && c.press) {
        if (hide) { hide = null; tally('засада: нажим — выхожу') }
        if (posture) { posture = null; engaged = true }
        release()
        return false
      }
      if (hide) return hideTick(c)
      // Засада — до стойки: от лучника и от бегущего на нас.
      if (!c.perch && !c.fort && !c.meInWeb && !c.others && (await hideStart(c))) return true
      // Рывок начала (tempo.pickOpening): в напоре — бежать, как решил темп;
      // иначе чаще сперва покружить (жалоба: «просто бегут и бьют вслепую»).
      // Наказание занятого (punRush) — всегда рывок: окно короткое.
      if (c.openRush && honorRush === null) honorRush = (phase && phase.name === 'напор') || Math.random() < 0.25
      const rushing = c.punRush || (c.openRush && honorRush)
      // На рывке стойки нет, а мечом на бегу помахать можно — если заряд
      // успеет вернуться до его руки (airSwing: на Paper взмах его сбрасывает).
      if (rushing) {
        release()
        if (c.d > 3.8 && c.d < 13 && rushSwings < 3 && now >= (cds.rushSwing || 0) && Math.random() < persona.show * 0.5 && airSwing(c.theirR, true)) {
          rushSwings++
          cds.rushSwing = now + between(300, 500)
          if (rushSwings === 1) tally('жест: машет мечом на бегу')
        }
        return false
      }
      const why = c.d > 13 ? 'далеко' : unsafeWhy(c, closing)
      if (why) {
        if (posture) { if (why !== 'далеко' && why !== 'не вижу') engaged = true; posture = null }
        release()
        return false
      }
      if (!posture) {
        let budget = 0
        const ph = phase ? phase.name : 'шоу'
        if (!engaged) {
          // Начало: до сшибки покружить, по нраву и фазе.
          budget = ph === 'шоу' ? between(2500, 5000) : ph === 'хитрость' ? between(1500, 3000) : ph === 'оборона' ? between(1200, 2800) : (Math.random() < 0.4 ? 0 : between(500, 1500))
        } else if (now - lastExchange > 2000 && !lullRolled) {
          // Затишье (разошлись после размена) — иногда подразнить.
          lullRolled = true
          const p = (0.15 + persona.show * 0.4) * (ph === 'шоу' ? 1.8 : ph === 'напор' ? 0.4 : 1) * (human ? 1 : 0.6)
          if (Math.random() < p) budget = between(600, 1800)
        }
        if (mirror && !budget) budget = 1200 // на жест ответить всегда
        budget *= (0.7 + persona.patience * 0.6) * (human ? 1.2 : 0.85)
        // Стойка — короткое окно (FIX): до сшибки ≤ 3 с, в затишье ≤ 1.5 с, за бой
        // всего ≤ 8 с — дальше только бой.
        if (FIXP) budget = stats.showMs > 8000 ? 0 : Math.min(budget, engaged ? 1500 : 3000)
        if (budget < 250) { if (!engaged) engaged = true; return false }
        posture = { budgetUntil: now + budget, act: null }
        if (!engaged) tally(`стойка перед боем (${ph})`)
      }
      if (now >= posture.budgetUntil && !(mirror && now >= mirror.after)) {
        posture = null
        engaged = true
        release()
        return false
      }
      let act = posture.act
      if (!act || now >= act.until) act = nextAct(c)
      if (act.kind === 'подзыв' && act.n === 0) { act.n = 1; say('posture') }
      const k = actTick(act, c)
      // Погоня pathfinder'ом перебивает клавиши каждый тик — снять её.
      if (!driving) stopPath()
      drive(k)
      stats.showMs += dt
      return true
    } finally {
      lastTick = now
    }
  }

  // ---------------------------------------------------------------- steer
  let bait = null
  let baits = 0
  let bites = 0
  let baitOff = false
  let baitRolled = false
  let retreat = null
  let pauseUntil = 0
  let pauseRolledAt = 0
  let lastSteer = gameClock.now()
  const steer = (k, c) => {
    const now = gameClock.now()
    // Свои часы: pre зовут в том же проходе цикла раньше steer.
    const dt = Math.min(100, now - lastSteer)
    lastSteer = now
    tickPhase(c)
    if (driving) release()
    const out = { ...k }
    // Нажим (pvp.js): без отхода-сброса, финтов, пауз и пятящейся обороны.
    if (FIXP && c.press) { retreat = null; bait = null; pauseUntil = 0; return out }
    const ph = phase ? phase.name : 'напор'
    if (c.theirR < THEIR_REACH + 0.2) { lastExchange = now; engaged = true }
    // Наказать промах: его клиент 10 тиков не пропустит клик (missTime),
    // наш удар заряжен — шаг внутрь спринтом, удар сделает pvp.js.
    if (whiff && now - whiff.at < 450 && c.cooldownLeft <= 100) {
      if (!whiff.said) { whiff.said = true; bites++; tally('финт: он махнул мимо — наказываю') }
      out.forward = c.r > HIT_REACH - 0.15
      out.back = false
      out.sprint = out.forward
      stats.tacticMs += dt
      return out
    }
    if (whiff && now - whiff.at >= 450) whiff = null
    // Отход-сброс: два его удара подряд без нашего ответа — выйти из размена
    // (S-tap и шаг назад), дальше затишье и снова в бой.
    hits.took = hits.took.filter(t => now - t < 2500)
    hits.gave = hits.gave.filter(t => now - t < 2500)
    if (!retreat && hits.took.length >= 2 && hits.gave.length === 0 && ready('reset') && !(c.cooldownLeft === 0 && c.r <= HIT_REACH + 0.2)) {
      rest('reset', 7000)
      const p = ph === 'оборона' ? 0.85 : ph === 'хитрость' ? 0.6 : ph === 'напор' ? 0.2 : 0.45
      if (Math.random() < p) { retreat = { until: now + between(900, 1600) }; tally('отход: сбросить размен') }
    }
    if (retreat) {
      if (now > retreat.until || c.theirR > 6 || (c.cooldownLeft === 0 && c.r <= HIT_REACH)) retreat = null
      else if (!c.dodging) {
        out.forward = false; out.sprint = false; out.back = true
        if (!out.strafe) out.strafe = circleKey
        stats.tacticMs += dt
        return out
      }
    }
    // Финт на краю его досягаемости: заряжены, он в 3.1–4.6 — шаг на край,
    // пауза под его клик, шаг назад. Махнул мимо — наказание выше. Только
    // против человека: бот на mineflayer бьёт лишь в досягаемости и мимо не
    // машет, запирать нечего (арена 2026-09-26: 12 финтов против бота — 0
    // укусов, минус темп).
    if (human && !bait && !baitOff && c.cooldownLeft === 0 && c.theirR > 3.1 && c.theirR < 4.6 && !c.blocking && !c.vulnerable && !c.rush && !c.dodging && !c.flank && ready('bait')) {
      if (!baitRolled) {
        baitRolled = true
        const p = ph === 'хитрость' ? 0.55 : ph === 'оборона' ? 0.3 : ph === 'шоу' ? 0.2 : 0.08
        if (Math.random() < p * (0.5 + persona.cunning)) {
          bait = { stage: 'in', at: now, bit: false }
          baits++
          tally('финт: шаг на край его руки и назад')
        } else rest('bait', between(600, 1400))
      }
    }
    if (!bait && (c.cooldownLeft > 0 || c.theirR >= 4.6)) baitRolled = false
    if (bait) {
      const el = now - bait.at
      if (bait.bit || c.cooldownLeft > 0 || c.blocking || c.dodging || c.theirR > 5.5 || el > 1300) {
        bait = null
        rest('bait', between(1500, 3500))
        if (baits >= 3 && bites === 0 && !baitOff) { baitOff = true; tally('финт: не ведётся — бросил') }
      } else {
        if (bait.stage === 'in' && (c.theirR <= 3.2 || el > 380)) { bait.stage = 'hold'; bait.holdUntil = now + between(120, 260) }
        if (bait.stage === 'hold' && now >= bait.holdUntil) { bait.stage = 'out'; bait.outAt = now }
        if (bait.stage === 'out' && (c.theirR >= 3.75 || now - bait.outAt > 420)) { bait = null; rest('bait', between(1500, 3500)) }
        if (bait) {
          out.sprint = false
          out.forward = bait.stage === 'in'
          out.back = bait.stage === 'out'
          stats.tacticMs += dt
          return out
        }
      }
    }
    // Фаза.
    if (c.cooldownLeft > 150 && !c.vulnerable && !c.dodging) {
      if (ph === 'оборона' && c.theirR < 3.8 && c.cooldownLeft > 250 && !c.rush) { out.back = true; out.forward = false; out.sprint = false }
      if (ph === 'напор' && out.back && tt) {
        // Он тоже не заряжен (махнул позже нас) — не пятиться, давить.
        const s = tt.state(tgt())
        if (s.swung && s.swung.left > c.cooldownLeft + 50) out.back = false
      }
    }
    // Живая пауза: замереть на миг вне его руки, пока заряжаемся.
    // Пауза кончается раньше заряда: к готовности удара — снова в ходу.
    if (ph !== 'напор' && c.theirR > 3.9 && c.cooldownLeft > 450 && !c.dodging && now - pauseRolledAt > 1000) {
      pauseRolledAt = now
      if (Math.random() < 0.15 + persona.patience * 0.2) { pauseUntil = now + Math.min(between(150, 350), c.cooldownLeft - 150); stats.acts['пауза'] = (stats.acts['пауза'] || 0) + 1 }
    }
    if (now < pauseUntil && !c.dodging) { out.strafe = null; if (!out.back) out.forward = false }
    return out
  }

  // --------------------------------------------------------------- победа
  let victoryDone = false
  const victory = () => {
    if (victoryDone) return
    victoryDone = true
    const spot = deathSpot || (tgt() && tgt().position && tgt().position.clone())
    if (!spot || !bot.entity) return
    if (Math.random() > (human ? 0.95 : 0.6)) return
    const taps = human ? 3 + Math.floor(Math.random() * 3) : 1 + Math.floor(Math.random() * 2)
    tally(`победа: присел над ним ×${taps}, взмах, огляделся`)
    say('kill')
    // Не на поводке боя: арена после смерти второго сразу шлёт stop, и жест
    // внутри боя обрывался. Рефлекс сам кончается за ~3 с и бросает всё, если
    // по нам попали или мозг дал новое дело.
    const cur0 = session && session.current
    const hp0 = bot.health ?? 20
    const tv0 = gameClock.now()
    const off = () => !bot.entity || (bot.health ?? 0) < hp0 - 0.5 || (session && session.current && session.current !== cur0) || gameClock.now() - tv0 > 3500
    const wait = (ms) => new Promise(resolve => gameClock.setTimeout(resolve, ms))
    Promise.resolve().then(async () => {
      await wait(between(250, 450))
      if (off()) return
      await bot.lookAt(spot.offset(0, 0.3, 0), true).catch(() => {})
      for (let i = 0; i < taps && !off(); i++) {
        bot.setControlState('sneak', true)
        await wait(between(150, 220))
        bot.setControlState('sneak', false)
        await wait(between(120, 190))
      }
      if (off()) return
      airSwing(99)
      await wait(between(200, 320))
      const y0 = bot.entity.yaw
      for (const dy of [0.9, -0.9]) {
        if (off()) return
        await bot.look(y0 + dy + between(-0.2, 0.2), between(0.05, 0.25), true).catch(() => {})
        await wait(between(260, 380))
      }
    }).catch(() => {}).finally(() => { try { bot.setControlState('sneak', false) } catch {} })
  }

  // ---------------------------------------------------------------- отчёт
  let closed = false
  const report = () => {
    const total = gameClock.now() - t0
    const ph = {}
    for (const [k, v] of Object.entries(stats.phaseMs)) ph[k] = Math.round(v / 100) / 10
    return {
      on: true,
      нрав: persona.name,
      противник: human ? 'человек' : 'бот',
      фазы: ph,
      showMs: Math.round(stats.showMs),
      tacticMs: Math.round(stats.tacticMs),
      fightMs: total,
      showPct: total ? Math.round(stats.showMs / total * 1000) / 10 : 0,
      tacticPct: total ? Math.round(stats.tacticMs / total * 1000) / 10 : 0,
      baits,
      bites,
      acts: stats.acts
    }
  }
  const close = () => {
    if (closed) return
    closed = true
    release()
    bot.removeListener('entityCrouch', onCrouch)
    bot.removeListener('entitySwingArm', onSwing)
    bot.removeListener('entityHurt', onHurt)
    bot.removeListener('entityDead', onDead)
    bot.removeListener('physicsTick', onTick)
    const r = report()
    if (r.fightMs > 1500) used(`человек: шоу ${r.showPct}%, финты и засады ${r.tacticPct}% времени боя`)
    try { console.log('[human]', JSON.stringify({ at: new Date().toTimeString().slice(0, 8), bot: bot.username, ...r })) } catch {}
  }

  return { pre, steer, victory, report, close, hiding: () => !!hide, persona, human }
}

module.exports = { ON, create, personaOf, isBotName, hashName }
