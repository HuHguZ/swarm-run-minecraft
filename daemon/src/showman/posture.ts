'use strict'
// Человек в бою (showman.ts): стойка — реплики в чат, взмах в воздух (цена заряда на Paper), когда можно
// покрасоваться, выбор действия стойки (ответ тем же на его жест или по нраву) и один тик действия: клавиши и взгляд.
import * as gameClock from '../game-clock'
import { CHAT, THEIR_REACH, clamp, between, pick, weighted, ACTS, ACT_LABEL } from './consts'
import { tally, tgt, lookAtHim } from './body'
import type { Showman } from './state'
import { visiblePower } from '../pvp/arms-graph'

// Видимое снаряжение (руки и броня — пакеты equipment, как видит человек) не слабее моего: с таким не красуются.
function stronger (H: Showman) {
  const e = tgt(H), bot = H.bot
  if (!e || !Array.isArray(e.equipment)) return false
  const theirs = visiblePower(e.equipment.filter(Boolean).map(i => i.name))
  const mine = visiblePower([bot.heldItem, ...[5, 6, 7, 8].map(k => bot.inventory?.slots?.[k])].filter(Boolean).map(i => i.name))
  return theirs >= mine * 0.9
}

// Реплики — редко, коротко, в характере (PERSONA.md: «свой пацан»). Не больше
// одной за бой и не чаще раза в минуту на бота: пользователь не любит спам.
const LINES = {
  posture: ['ну иди сюда', 'давай, давай', 'чё встал?', 'иди, не бойся', 'ну?'],
  mirror: ['о, привет)', 'и тебе привет', 'ну привет-привет', 'здарова'],
  kill: ['гг', 'изи', 'гг вп', 'ещё раунд?', 'ну ты держался', 'бывает)']
}
const lastChat = new WeakMap()

function say (H: Showman, slot) {
  const { bot } = H
  if (!CHAT || H.chatSlot !== slot) return
  H.chatSlot = null
  const now = gameClock.now()
  if (now - (lastChat.get(bot) || 0) < 60000) return
  lastChat.set(bot, now)
  const line = pick(LINES[slot])
  try { bot.chat(line) } catch {}
  tally(H, `чат: «${line}»`)
}

// Взмах в воздух (см. шапку): на Paper — только если заряд успеет вернуться
// (оружие + 300 мс), пока он добежит до руки (его спринт 0.28 бл/тик, а если
// бежим и мы — вдвое быстрее).
function swingCostly (H: Showman) { const { bot } = H; return !/^vanilla$/i.test(String((bot.game && bot.game.serverBrand) || '')) }
function swingOk (H: Showman, theirR, both = false) {
  const { weaponMs } = H
  if (!swingCostly(H)) return true
  const T = (weaponMs ? weaponMs() : 625) + 300
  return Math.max(0, theirR - 3.3) / (both ? 0.56 : 0.28) * 50 > T
}
function airSwing (H: Showman, theirR, both = false) {
  const { bot, onAirSwing } = H
  if (!swingOk(H, theirR, both)) return false
  try { bot.swingArm() } catch { return false }
  if (swingCostly(H)) {
    if (bot._ndMelee) bot._ndMelee.resetAt = Math.max(bot._ndMelee.resetAt || 0, gameClock.now())
    if (onAirSwing) onAirSwing()
  }
  return true
}
function closingOf (H: Showman, c) {
  const { bot } = H
  const e = tgt(H)
  if (!e || !c.vel || !bot.entity) return 0
  const me = bot.entity.position
  return (c.vel.x * (me.x - e.position.x) + c.vel.z * (me.z - e.position.z)) / Math.max(c.d, 0.1)
}
// Когда можно покрасоваться: он не достанет и не выстрелит, пока мы
// отвечаем на его ход (цикл 50 мс + реакция), и ничем не занят — занятого
// наказывает tempo, а не стойка.
function unsafeWhy (H: Showman, c, closing) {
  const { tt } = H
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
  // Пользователь 22.10: «убрать вообще, если противник сильный и идёт на тебя — потеря времени и потенциальная смерть». Идёт —
  // любое сближение (было: быстрее 3.4 бл/с), сильный — не слабее меня по видимому.
  if (closing > 0.05) return 'он идёт на меня'
  if (stronger(H)) return 'он не слабее'
  if (Math.abs(c.dy) > 2.5) return 'разная высота'
  if (!c.seesBody) return 'не вижу'
  if (c.busyFoe) return 'не время'
  if (tt) {
    const s = tt.state(tgt(H))
    if (s.consuming || s.pillaring || s.placing || s.inWeb || s.pearled) return 'он занят — наказывать'
  }
  return null
}
function startAct (H: Showman, kind) {
  const a = ACTS[kind]
  const act: any = { kind, t0: gameClock.now(), until: gameClock.now() + between(a.ms[0], a.ms[1]), n: 0, nextAt: 0, seq: null }
  if (kind === 'присед') { act.on = between(150, 230); act.off = between(130, 200); act.taps = 2 + Math.floor(Math.random() * 3) }
  if (kind === 'кивок') act.seq = [-0.55, 0.05, -0.55, 0.05].concat(Math.random() < 0.4 ? [-0.5, 0.05] : []).map(v => v + between(-0.08, 0.08))
  if (kind === 'головой') act.seq = [0.42, -0.42, 0.42, -0.42, 0].map(v => v + between(-0.08, 0.08))
  if (kind === 'подзыв') { act.fw = between(220, 320); act.bk = between(260, 360) }
  if (act.seq) act.step = (act.until - act.t0) / act.seq.length
  H.posture.act = act
  tally(H, ACT_LABEL[kind])
  return act
}
function nextAct (H: Showman, c) {
  const { human, persona, nearDrop } = H
  // Сначала — ответ тем же на его жест (зеркало), если созрела реакция.
  if (H.mirror && gameClock.now() >= H.mirror.after) {
    let kind = H.mirror.kind === 'головой' && Math.random() < 0.5 ? 'кивок' : H.mirror.kind
    if (kind === 'взмах' && !swingOk(H, c.theirR)) kind = 'присед'
    H.mirror = null
    tally(H, `отвечаю тем же: ${kind}`)
    say(H, 'mirror')
    return startAct(H, kind)
  }
  const w: any = {}
  for (const [k, a] of (Object.entries(ACTS) as [string, any][])) {
    w[k] = a.w + persona.show * a.show + (human ? a.social : a.social * 0.3)
    if (H.posture.act && H.posture.act.kind === k) w[k] *= 0.3
  }
  if (!swingOk(H, c.theirR)) w.взмах = 0
  if (nearDrop && nearDrop()) w.прыжки = 0
  return startAct(H, weighted(w))
}
// Один тик действия стойки: клавиши и взгляд.
function actTick (H: Showman, act, c) {
  const { bot, aimTo, stepOk, nearDrop } = H
  const now = gameClock.now()
  const el = now - act.t0
  const k: any = {}
  // Держать среднюю дистанцию: дальше 7.5 — подойти шагом, ближе его руки
  // с запасом — шаг назад.
  const keep = () => {
    if (c.d > 7.5 && stepOk('forward')) k.forward = true
    else if (c.theirR < THEIR_REACH + 1.6 && stepOk('back')) k.back = true
  }
  aimTo('target')
  switch (act.kind) {
    case 'круг': {
      if (now >= H.circleFlipAt) { H.circleKey = H.circleKey === 'left' ? 'right' : 'left'; H.circleFlipAt = now + between(900, 2600) }
      if (!stepOk(H.circleKey)) H.circleKey = H.circleKey === 'left' ? 'right' : 'left'
      if (stepOk(H.circleKey)) k[H.circleKey] = true
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
      const base = lookAtHim(H)
      aimTo('point', act.kind === 'кивок' ? { yaw: base.yaw, pitch: clamp(base.pitch + act.seq[i], -1.5, 1.5) } : { yaw: base.yaw + act.seq[i], pitch: base.pitch })
      break
    }
    case 'взмах': {
      if (now >= act.nextAt) { if (airSwing(H, c.theirR)) act.n++; act.nextAt = now + between(260, 420) }
      if (stepOk(H.circleKey)) k[H.circleKey] = true
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

export { LINES, lastChat, say, swingCostly, swingOk, airSwing, closingOf, unsafeWhy, startAct, nextAct, actTick }
