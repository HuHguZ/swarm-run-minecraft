'use strict'
// Окно точности на ферме (s5, 06.10). Цепочка кроватей щёлкает в тик прохода головы дракона: на 20 тиках/с это 50 мс на
// реакцию, на 750 — 1.3 мс, и демон под нагрузкой ошибается на ±2…6 тиков (свидетель DragonLab: голова в тик взрыва
// 5–10 бл. вместо 2, урон кровати 7–30 вместо 45–55). Ускорение фермы — подделка времени, в игре 20 тиков; поэтому
// на ферме, только если задано ND_PRECISION_TPS=<n> (бот — оператор фермы), сервер на время захода на посадку, снижения
// и посадки идёт на n тиках/с, потом — прежний темп. В основном мире переменной нет: ничего не делает.
const gameClock = require('../game-clock')

// Защита фермой, а не только переменной (замечание проверки, s5c 06.10): окно открывается лишь в мире слота фермы —
// сервер на порту 25601..25632 (farm.ts: 25600+i) и бот NeuroFarm<i>. В основном мире (25569, NeuroDown, бот не оп)
// команда не уходит даже при заданной ND_PRECISION_TPS.
function farmWorld (cfg = require('../config')) {
  return cfg.port >= 25601 && cfg.port <= 25632 && /^NeuroFarm\d+$/.test(cfg.username || '')
}
const APPROACH_MS = 40000
function precisionRate () {
  const n = Number(process.env.ND_PRECISION_TPS || 0)
  return n >= 1 && n <= 10000 && farmWorld() ? Math.round(n) : 0
}

// want — нужна ли точность сейчас; состояние окна — в ctl.precision. Ответ — что сделано (для трассы), иначе null.
function precisionWindow (bot, ctl, want) {
  const n = precisionRate()
  if (!n) return null
  const st = ctl.precision || (ctl.precision = { on: false, was: null, n: 0 })
  const rate = gameClock.snapshot()?.tickRate ?? 20
  if (want && !st.on) {
    if (rate <= n) return null
    st.on = true; st.was = rate; st.n++
    bot.chat(`/tick rate ${n}`)
    return { on: n, was: rate }
  }
  if (!want && st.on) return precisionOff(bot, ctl)
  return null
}

function precisionOff (bot, ctl) {
  const st = ctl && ctl.precision
  if (!st || !st.on) return null
  st.on = false
  try { bot.chat(`/tick rate ${st.was}`) } catch {}
  return { off: st.was }
}

// Опасность рядом (s5-e21: на окне только посадки 3 смерти из 4 — облака дыхания: облако бьёт раз в 20 тиков, на 750 это
// 27 мс, демон уходит из него за 2–4 удара). Облако в 4 бл. от его края, фаербол в 48 бл., заход с фаерболом, злой эндермен
// в 12 бл. Держится ещё 3 игровых с после последней опасности.
function dangerNear (bot) {
  const { cloudsOf, fireballsOf, dragonOf, phaseOf, PHASE } = require('./dig-down-to')
  const { angryEndermen } = require('./fall-guard')
  const me = bot.entity && bot.entity.position
  if (!me) return null
  if (cloudsOf(bot).some(c => Math.hypot(c.pos.x - me.x, c.pos.z - me.z) < c.r + 4 && Math.abs(c.pos.y - me.y) < 4)) return 'облако'
  if (fireballsOf(bot).some(f => f.e && f.e.position && f.e.position.distanceTo(me) < 48)) return 'фаербол'
  const d = dragonOf(bot)
  if (d && phaseOf(bot, d) === PHASE.STRAFE) return 'заход с фаерболом'
  if (angryEndermen(bot, 12).length) return 'эндермен'
  return null
}

// Раз в 100 игровых мс на всё время навыка: точность нужна на заходе/снижении/посадке при готовой станции и при опасности.
function precisionTick (bot, ctl) {
  if (!precisionRate() || !bot.entity) return null
  const { dragonOf, phaseOf, PHASE, SITTING } = require('./dig-down-to')
  const d = dragonOf(bot)
  const ph = d ? phaseOf(bot, d) : null
  const landing = !!(ctl.pillar && ctl.pillar.built) && (ph === PHASE.APPROACH || ph === PHASE.LANDING || SITTING.has(ph))
  const danger = dangerNear(bot)
  const now = gameClock.now()
  if (danger) ctl.dangerUntil = now + 3000
  // Подход с платформы (первые APPROACH_MS навыка, пока нет станции): демон на 750 занят прогрузкой острова и планом
  // жемчуга, тело почти без физики, а облако дыхания на платформе бьёт раз в 20 тиков (s5c-d1-s6 06.10: 0.6 физ. тика на
  // игровую с, смерть от облака за ~1 с реального времени, все удары в одну игровую мс; окно по опасности не успело).
  const approach = !(ctl.pillar && ctl.pillar.built) && now - (ctl.started || now) < APPROACH_MS
  const want = landing || approach || (ctl.dangerUntil || 0) > now
  const r = precisionWindow(bot, ctl, want)
  if (r && ctl.trace) ctl.trace.ev('precision', { ...r, ph, why: landing ? 'посадка' : approach ? 'подход' : danger || 'после опасности' })
  return r
}

module.exports = { precisionRate, precisionWindow, precisionOff, precisionTick, dangerNear, farmWorld }
