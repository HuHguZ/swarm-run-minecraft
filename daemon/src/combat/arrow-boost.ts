// Разгон стрелой (пользователь 24.10: «один бот другого стрелой ускоряет, и тот копьём ваншотит»; скорость — запас энергии,
// который копьё превращает в урон). 1.21.11, AbstractArrow.doKnockback: толчок «Отдачи» — по горизонтали полёта стрелы,
// НОРМИРОВАН: 0.6 × уровень × (1 − сопр. отбросу), +0.1 вверх, от скорости стрелы не зависит; урон стрелы — ceil(скорость ×
// база), так что почти не натянутый лук толкает своего так же, а ранит на 1–4. До толчка — обычный отброс попадания 0.4
// вдоль полёта (на земле — подброс, дальше полёт с сопротивлением воздуха 0.91). Копьё в «использовании» (KineticWeapon)
// бьёт 1 + floor(отн. скорость бл/с × множитель): «Отдача II» ≈ 1.6 бл/т ≈ 32 бл/с → незеритовое копьё 39 до брони.
// Вторая стрела в первые 10 тиков неуязвимости (LivingEntity.hurtServer: invulnerableTime > 10) отскакивает, если её урон
// не больше прошлого, и толкает ещё раз, если больше, — поэтому второй стрелок тянет сильнее (draw больше).
import { Vec3 } from 'vec3'
import * as gameClock from '../game-clock'
import * as pick from '../pick'
import * as read from '../read'
import * as ranged from '../ranged'
import * as spear from '../spear'
import { aim } from '../bow/ballistics'
import { bowShot } from '../pvp/damage-model'
import { visibleAllies, allyOnSegment } from './ally-safety'
import { createLastSeen, gearPartVisible } from '../pvp/last-seen'
import { usingItem } from '../pvp/body'
import { pearlDeadline } from './pearl-clock'

const wrap = (a: number) => Math.atan2(Math.sin(a), Math.cos(a))
const yawTo = (a: any, b: any) => Math.atan2(-(b.x - a.x), -(b.z - a.z))
const punchOf = (bot: any, it: any) => (it && read.enchLevel(bot, it, 'punch')) || 0
// Возродившийся — новая сущность; старая (isValid false) ещё может лежать в bot.entities.
const byName = (bot: any, name: string) => name && (bot.players?.[name]?.entity ||
  Object.values(bot.entities || {}).find((e: any) => e.username === name && e.isValid !== false)) as any

function boostPathProblem(bot: any, ally: any, sol: any, speed: number) {
  const box = pick.hitboxOf(bot, ally), others = visibleAllies(bot).filter(a => a.id !== ally.id)
  let p = pick.eyeOf(bot), v = new Vec3(-Math.sin(sol.yaw) * Math.cos(sol.pitch), Math.sin(sol.pitch), -Math.cos(sol.yaw) * Math.cos(sol.pitch)).scaled(speed)
  for (let tick = 0; tick < Math.ceil(sol.ticks); tick++) {
    const len = v.norm(), dir = v.scaled(1 / len), hit = pick.rayBox(p, dir, box.lo, box.hi, len), reach = hit ?? len
    if (bot.world.raycast(p, dir, reach, (b: any) => b && b.boundingBox === 'block')) return 'на пути блок'
    if (others.length && allyOnSegment(bot, others, p, p.plus(dir.scaled(reach)), tick)) return 'другой свой на пути'
    if (hit != null) return null
    p = p.plus(v); v = new Vec3(v.x * .99, v.y * .99 - .05, v.z * .99)
  }
  return 'свой вышел из линии выстрела'
}

/** Shoot ally `ally` with a weakly drawn Punch arrow so the push throws him toward `foe` (draw — use ticks, ≥ 3; wait — ticks
 * before drawing, so archers with different draws are ready together; lag — ticks to hold after he starts rising, so their
 * arrows land in one tick). */
export async function boostShot(bot: any, ally: any, { foe = null, draw = 6, maxOff = .45, lag = 0, wait = 0, ctl, inTime = () => true }: any = {}) {
  const unavailable = () => ctl?.aborted ? 'прервали' : !inTime(0) ? 'поздно к жемчугу' : !ally || ally.isValid === false || !ally.position ? 'своего не вижу' :
    foe && (foe.isValid === false || !foe.position) ? 'врага не вижу' : null
  const missing = unavailable()
  if (missing) return { ok: false, why: missing }
  const bow = bot.inventory.items().filter((i: any) => i.name === 'bow').sort((a: any, b: any) => punchOf(bot, b) - punchOf(bot, a))[0]
  const punch = punchOf(bot, bow)
  if (!bow || !punch) return { ok: false, why: 'нет лука с Отдачей' }
  const plain = bot.inventory.items().find((i: any) => i.name === 'arrow')
  if (!plain) return { ok: false, why: 'нет обычной стрелы' }
  if (bot.heldItem?.slot !== bow.slot) await bot.equip(bow, 'hand')
  if (ctl?.aborted) return { ok: false, why: 'прервали' }
  // Первая по порядку поиска — обычная: вред/яд по своему — урон, а не разгон.
  if (!await ranged.readyArrow(bot, plain)) return { ok: false, why: 'обычная стрела не первая' }
  await bot.waitForTicks(2) // смена предмета и стрел дошла до сервера — иначе «использование» не начнётся
  if (wait > 0 && !ctl?.aborted) await bot.waitForTicks(wait)
  const blocked = unavailable()
  if (blocked) return { ok: false, why: blocked }
  const slot = bot.quickBarSlot
  const holdsBow = () => bot.quickBarSlot === slot && bot.heldItem?.name === 'bow'
  const holdsBoostBow = () => holdsBow() && punchOf(bot, bot.heldItem) === punch
  if (!holdsBoostBow()) return { ok: false, why: 'лук с Отдачей не в руке' }
  const hurt0 = ally.id
  let hitAt = 0
  const onHurt = (v: any) => { if (v?.id === hurt0 && !hitAt) hitAt = gameClock.now() }
  bot.on('entityHurt', onHurt)
  bot.activateItem()
  // Снять натяжение без выстрела — сменой слота (deactivateItem выпустит стрелу).
  const cancel = (why: string) => {
    if (holdsBow()) {
      bot.setQuickBarSlot((slot + 1) % 9); bot.setQuickBarSlot(slot)
    }
    return { ok: false, why }
  }
  // The use animation identifies a hand. A previously seen spear in a now hidden hand cannot authorize a friendly shot.
  const flags = bot.registry.entitiesByName.player?.metadataKeys?.indexOf('living_entity_flags') ?? -1
  const braced = () => {
    const state = flags >= 0 ? ally.metadata?.[flags] : undefined
    if (typeof state !== 'number' || !(state & 1)) return false
    const hand = state & 2 ? 1 : 0
    return (ally._ndGearVisible?.[hand] ?? gearPartVisible(bot, ally, hand)) && spear.isSpear(usingItem(bot, ally))
  }
  let stop = () => {}
  const res: any = await new Promise(resolve => {
    let ticks = 0, lowY = Infinity, prevY = ally.position.y, fireAt = Infinity, ended = false
    const abort = () => { if (!ended) { ended = true; resolve(cancel('прервали')) } }
    const onT = () => {
      if (ended) return
      const why = unavailable()
      if (why) { ended = true; return resolve(cancel(why)) }
      const y = ally.position.y, rising = y > prevY + 1e-3
      prevY = y; lowY = Math.min(lowY, y)
      if (++ticks < draw) return
      // Толчок ловить в воздухе (spear.charge stand прыгает на месте): на земле трение 0.546 съедает его. Держать тетиву до
      // подъёма прыжка — стрела в полёте 1–3 тика, прыжок длится 12. Ждать не дольше 30 тиков сверх натяжения.
      const air = y - lowY > .15 && rising
      if (air && braced() && fireAt === Infinity && ticks >= draw) fireAt = ticks + lag
      if (ticks < Math.min(fireAt, draw + 30)) return
      bot.removeListener('physicsTick', onT)
      if (!braced()) return resolve(cancel('свой не держит копьё наготове'))
      if (!ally.isValid && ally.isValid !== undefined) return resolve(cancel('свой пропал'))
      // Сила — по тикам, что тетива реально натянута (держали дольше draw — стрела быстрее и больнее).
      const eye = pick.eyeOf(bot), c = ally.position.offset(0, .9, 0), speed = bowShot(ticks).speed
      // Толкнёт к врагу, только если я за его спиной: я и враг — по разные стороны от него.
      if (foe?.position && (eye.x - c.x) * (foe.position.x - c.x) + (eye.z - c.z) * (foe.position.z - c.z) >= 0) return resolve(cancel('не за спиной своего'))
      const sol: any = aim(eye, () => c, speed)
      if (!sol) return resolve(cancel('не долетит'))
      // Толчок — вдоль горизонтали стрелы: она должна смотреть на врага.
      const off = foe?.position ? wrap(sol.yaw - yawTo(ally.position, foe.position)) : 0
      if (Math.abs(off) > maxOff) return resolve(cancel(`не по линии на врага (${off.toFixed(2)})`))
      // Путь по тикам полёта (физика ballistics): блоки и прочие свои (bow.blockedAt считает своим на пути и его самого).
      bot.look(sol.yaw, sol.pitch, true).catch(() => {})
      spear.afterPacket(bot, () => {
        if (ended) return
        ended = true
        const why = unavailable()
        if (!inTime(sol.ticks)) return resolve(cancel('поздно к жемчугу'))
        if (why || !braced() || !holdsBoostBow()) return resolve(cancel(why || 'смена предмета'))
        if (foe && Math.abs(wrap(sol.yaw - yawTo(ally.position, foe.position))) > maxOff) return resolve(cancel('изменилась линия разгона'))
        let problem: string | null
        try { problem = boostPathProblem(bot, ally, sol, speed) } catch { problem = 'путь стрелы неизвестен' }
        if (problem) return resolve(cancel(problem))
        bot.deactivateItem(); resolve({ ok: true, ticks: Math.round(sol.ticks * 10) / 10, off: Math.round(off * 100) / 100, speed: Math.round(speed * 100) / 100, held: ticks })
      })
    }
    bot.on('physicsTick', onT)
    ctl?.onAbort?.push(abort)
    stop = () => {
      ended = true; bot.removeListener('physicsTick', onT)
      const index = ctl?.onAbort?.indexOf(abort) ?? -1
      if (index >= 0) ctl.onAbort.splice(index, 1)
    }
  }).finally(() => stop())
  try { if (res.ok) { const t0 = gameClock.now(); while (!ctl?.aborted && !hitAt && gameClock.now() - t0 < 600) await gameClock.sleep(50) } } finally { bot.removeListener('entityHurt', onHurt) }
  return { ...res, hit: !!hitAt }
}

/** Stand with a charging spear facing `foe` and wait for an ally's Punch arrow to throw us into him. */
// from — имена лучников, чьих стрел жду (их не обходить: threats.incoming).
export async function boostLance(bot: any, ctl: any, foe: any, { maxMs = 4000, from = [] as string[] }: any = {}) {
  const best = spear.spearOf(bot)
  if (!best) return { ok: false, why: 'нет копья' }
  if (ctl.aborted || !foe || foe.isValid === false || !foe.position) return { ok: false, why: 'врага не вижу' }
  // Всегда в руку и 2 тика: «использование» сразу после смены (или /give) сервер не начинал — копьё не било (сцена: каждый
  // второй заход «свой не держит копьё»).
  await bot.equip(best.item, 'hand')
  if (ctl.aborted || foe.isValid === false) return { ok: false, why: 'разгон прерван' }
  // После прошлого удара копьём «использование» нового разгона сервер подтверждал только мне: лучники видели флаг 0
  // (сцена: каждый второй заход). Отпустить кнопку и подождать — тогда новое начало видят все.
  bot.deactivateItem()
  await bot.waitForTicks(3)
  if (ctl.aborted || foe.isValid === false) return { ok: false, why: 'разгон прерван' }
  bot._ndBoostFrom = new Set(from)
  // Замер: скорость тела по тикам после первого толчка (скорость, что прислал сервер, — got).
  const got: number[] = [], path: number[] = []
  const onVel = (pk: any) => { if (pk?.entityId === bot.entity?.id && got.length < 4) got.push(Math.round(Math.hypot(pk.velocity.x, pk.velocity.z) * 100) / 100) }
  const onT = () => { if (got.length && path.length < 12) path.push(Math.round(Math.hypot(bot.entity.velocity.x, bot.entity.velocity.z) * 100) / 100) }
  bot._client.on('entity_velocity', onVel); bot.on('physicsTick', onT)
  const shooters = bot._ndBoostFrom
  try {
    const charge = await spear.charge(bot, ctl, foe, { maxMs, stand: true })
    const why = !charge.hit && (ctl.aborted ? 'прервали' : foe.isValid === false ? 'врага не вижу' : null)
    return { ...charge, ...(why && { ok: false, why }), got, path }
  } finally {
    if (bot._ndBoostFrom === shooters) bot._ndBoostFrom = null
    bot._client.removeListener('entity_velocity', onVel); bot.removeListener('physicsTick', onT)
  }
}

// Разгон к жемчугу (пользователь 24.10: «стрелами должны тоже кидать друг друга к жемчугу»): место и тик его появления
// известны заранее, и первые тики он стоит — то, чего в живом бою разгону не хватало (цель уходит с линии: 1 удар из 123).
// at/eta — точка и тики до появления; stand — своё место (бег до него прямо, поле открытое). Срок — по своим игровым
// часам от получения: часы драйвера на ускоренном сервере идут иначе.
const PEARL_TRAVEL = 6 // тиков полёта копейщика с 7 бл. на ~1.3 бл/т (сцена try-arrow-boost)
export function pearlBoostMinimum(method: 'boost_shot' | 'boost_lance', p: any) {
  return PEARL_TRAVEL + (method === 'boost_lance' ? 3 : (Number(p.wait) || 0) + (Number(p.draw) || 6) + (Number(p.lag) || 0))
}
function trackedTarget(bot: any, sight: ReturnType<typeof createLastSeen>, name: string, at?: Vec3, forecastValid = () => true) {
  const expected = byName(bot, name)
  const forecast = at && { position: at, velocity: new Vec3(0, 0, 0), username: name, type: 'player', height: 1.8, width: .6 }
  let target: any
  // Both workers check validity for each aim. A pearl supplies only its reported landing until the owner is seen there.
  return new Proxy({}, { get (_t, key) {
    if (key === 'isValid') {
      const raw = byName(bot, name), seen = raw && (at || raw === expected) ? sight.observe(raw) : null
      target = seen?._ndVisible && (!at || seen.position.distanceTo(at) < 3) ? seen : forecastValid() && forecast
      return !!target
    }
    return target?.[key]
  } })
}
async function runTo(bot: any, ctl: any, to: Vec3, canRun: () => boolean) {
  while (!ctl.aborted && canRun() && Math.hypot(to.x - bot.entity.position.x, to.z - bot.entity.position.z) > .6) {
    const me = bot.entity.position
    await bot.look(Math.atan2(-(to.x - me.x), -(to.z - me.z)), 0, true).catch(() => {})
    if (ctl.aborted || !canRun()) { bot.clearControlStates(); return false }
    bot.setControlState('forward', true); bot.setControlState('sprint', true); bot.setControlState('jump', !!bot.entity.isCollidedHorizontally)
    await new Promise(r => gameClock.setTimeout(r, 50))
  }
  bot.clearControlStates()
  return Math.hypot(to.x - bot.entity.position.x, to.z - bot.entity.position.z) <= 1.2
}
async function prepareBoost(session: any, bot: any, ctl: any, p: any, lead: number, minimum: number) {
  const deadline = pearlDeadline(session, bot, ctl, p)
  const late = () => {
    const left = deadline?.left()
    return !Number.isFinite(left) || deadline.timed && left < minimum * 50
  }
  if (late()) return { ok: false as const, why: 'поздно к жемчугу' }
  freeHands(session)
  if (p.stand && !await runTo(bot, ctl, new Vec3(p.stand.x, p.stand.y, p.stand.z), () => deadline.left() > (lead + 2) * 50))
    return { ok: false as const, why: 'не добежал до места' }
  while (deadline.left() > lead * 50) await new Promise(r => gameClock.setTimeout(r, 25))
  if (late()) return { ok: false as const, why: 'поздно к жемчугу' }
  return { ok: true as const, deadline, at: new Vec3(p.at.x, p.at.y, p.at.z) }
}

export async function boostShotRpc(session: any, ctl: any, p: any = {}) {
  const bot = session.require()
  if (ctl.aborted) return { ok: false, why: 'прервали' }
  const draw = Number(p.draw) || 6, lag = Number(p.lag) || 0, wait = Number(p.wait) || 0
  let at: Vec3 | undefined
  let inTime = (_flight: number) => true
  if (p.at || p.gameTick !== undefined) {
    const minimum = pearlBoostMinimum('boost_shot', p)
    const prep = await prepareBoost(session, bot, ctl, p, minimum + 2, minimum)
    if (!prep.ok) return prep
    at = prep.at
    if (prep.deadline.timed) inTime = flight => prep.deadline.left() >= (Math.ceil(flight) + PEARL_TRAVEL - 2) * 50
  } else freeHands(session)
  const sight = createLastSeen(bot)
  try {
    const foe = p.foe || at ? trackedTarget(bot, sight, p.foe, at) : null
    return await boostShot(bot, trackedTarget(bot, sight, p.ally), { foe, draw, lag, wait, ctl, inTime })
  } finally { sight.close() }
}

// Уже идущий неаварийный рефлекс (бой тактики после прошлого удара) держит руки и ноги: новые COMMANDED_ESCAPE не пускает,
// а старый — снять (сцена: после каждого убийства следующий разгон стоял 4 с без копья и прыжка).
function freeHands(session: any) {
  const rl: typeof import('../reflex-lock') = require('../reflex-lock')
  const o = rl.owner(session)
  if (o && o.owner !== 'Emergency') rl.cancel(session)
}

export async function boostLanceRpc(session: any, ctl: any, p: any = {}) {
  const bot = session.require()
  if (ctl.aborted) return { ok: false, why: 'прервали' }
  let at: Vec3 | undefined, maxMs = Number(p.maxMs) || 4000
  let forecastValid = () => true
  if (p.at || p.gameTick !== undefined) {
    const prep = await prepareBoost(session, bot, ctl, p, (Number(p.lead) || 24) + PEARL_TRAVEL + 6, pearlBoostMinimum('boost_lance', p))
    if (!prep.ok) return prep
    at = prep.at
    maxMs = Math.max(1500, prep.deadline.left() + 1000)
    if (prep.deadline.timed) forecastValid = () => prep.deadline.left() >= 0
  } else freeHands(session)
  const sight = createLastSeen(bot)
  try { return await boostLance(bot, ctl, trackedTarget(bot, sight, p.foe, at, forecastValid), { maxMs, from: p.from || [] }) } finally { sight.close() }
}
