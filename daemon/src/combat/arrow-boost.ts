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

const wrap = (a: number) => Math.atan2(Math.sin(a), Math.cos(a))
const yawTo = (a: any, b: any) => Math.atan2(-(b.x - a.x), -(b.z - a.z))
const punchOf = (bot: any, it: any) => (it && read.enchLevel(bot, it, 'punch')) || 0
// Возродившийся — новая сущность; старая (isValid false) ещё может лежать в bot.entities.
const byName = (bot: any, name: string) => bot.players?.[name]?.entity ||
  Object.values(bot.entities || {}).find((e: any) => e.username === name && e.isValid !== false) as any

/** Shoot ally `ally` with a weakly drawn Punch arrow so the push throws him toward `foe` (draw — use ticks, ≥ 3; wait — ticks
 * before drawing, so archers with different draws are ready together; lag — ticks to hold after he starts rising, so their
 * arrows land in one tick). */
export async function boostShot(bot: any, ally: any, { foe = null, draw = 6, maxOff = .45, lag = 0, wait = 0 }: any = {}) {
  const bow = bot.inventory.items().filter((i: any) => i.name === 'bow').sort((a: any, b: any) => punchOf(bot, b) - punchOf(bot, a))[0]
  if (!bow || !punchOf(bot, bow)) return { ok: false, why: 'нет лука с Отдачей' }
  const plain = bot.inventory.items().find((i: any) => i.name === 'arrow')
  if (!plain) return { ok: false, why: 'нет обычной стрелы' }
  if (!ally?.position) return { ok: false, why: 'своего не вижу' }
  if (bot.heldItem?.slot !== bow.slot) await bot.equip(bow, 'hand')
  // Первая по порядку поиска — обычная: вред/яд по своему — урон, а не разгон.
  if (!await ranged.readyArrow(bot, plain)) return { ok: false, why: 'обычная стрела не первая' }
  await bot.waitForTicks(2) // смена предмета и стрел дошла до сервера — иначе «использование» не начнётся
  const others = visibleAllies(bot).filter((a: any) => a.id !== ally.id)
  const hurt0 = ally.id
  let hitAt = 0
  const onHurt = (v: any) => { if (v?.id === hurt0 && !hitAt) hitAt = gameClock.now() }
  bot.on('entityHurt', onHurt)
  if (wait > 0) await bot.waitForTicks(wait)
  bot.activateItem()
  const slot = bot.quickBarSlot
  // Снять натяжение без выстрела — сменой слота (deactivateItem выпустит стрелу).
  const cancel = (why: string) => { bot.setQuickBarSlot((slot + 1) % 9); bot.setQuickBarSlot(slot); return { ok: false, why } }
  // «Использует» ли он предмет (living_entity_flags бит 1): копьё ещё не в деле — толчок пропадёт зря.
  const flags = bot.registry.entitiesByName.player?.metadataKeys?.indexOf('living_entity_flags') ?? -1
  const using = () => flags < 0 || ((Number(ally.metadata?.[flags]) || 0) & 1) === 1
  let stop = () => {}
  const res: any = await new Promise(resolve => {
    let ticks = 0, lowY = Infinity, prevY = ally.position.y, fireAt = Infinity
    const onT = () => {
      const y = ally.position.y, rising = y > prevY + 1e-3
      prevY = y; lowY = Math.min(lowY, y)
      if (++ticks < draw) return
      // Толчок ловить в воздухе (spear.charge stand прыгает на месте): на земле трение 0.546 съедает его. Держать тетиву до
      // подъёма прыжка — стрела в полёте 1–3 тика, прыжок длится 12. Ждать не дольше 30 тиков сверх натяжения.
      const air = y - lowY > .15 && rising
      if (air && using() && fireAt === Infinity && ticks >= draw) fireAt = ticks + lag
      if (ticks < Math.min(fireAt, draw + 30)) return
      bot.removeListener('physicsTick', onT)
      if (!using()) return resolve(cancel(`свой не держит копьё (флаги ${ally.metadata?.[flags]}, id ${ally.id}, valid ${ally.isValid})`))
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
      let p = eye.clone(), v = new Vec3(-Math.sin(sol.yaw) * Math.cos(sol.pitch), Math.sin(sol.pitch), -Math.cos(sol.yaw) * Math.cos(sol.pitch)).scaled(speed)
      for (let t = 0; t < Math.ceil(sol.ticks); t++) {
        const len = v.norm(), reach = t === Math.ceil(sol.ticks) - 1 ? Math.max(0, len * (sol.ticks - t) - .5) : len
        try { if (bot.world.raycast(p, v.scaled(1 / len), reach, (b: any) => b && b.boundingBox === 'block')) return resolve(cancel('на пути блок')) } catch {}
        if (others.length && allyOnSegment(bot, others, p, p.plus(v), t)) return resolve(cancel('другой свой на пути'))
        p = p.plus(v); v = new Vec3(v.x * .99, v.y * .99 - .05, v.z * .99)
      }
      bot.look(sol.yaw, sol.pitch, true).catch(() => {})
      spear.afterPacket(bot, () => { bot.deactivateItem(); resolve({ ok: true, ticks: Math.round(sol.ticks * 10) / 10, off: Math.round(off * 100) / 100, speed: Math.round(speed * 100) / 100, held: ticks }) })
    }
    bot.on('physicsTick', onT)
    stop = () => bot.removeListener('physicsTick', onT)
  }).finally(() => stop())
  try { if (res.ok) { const t0 = gameClock.now(); while (!hitAt && gameClock.now() - t0 < 600) await gameClock.sleep(50) } } finally { bot.removeListener('entityHurt', onHurt) }
  return { ...res, hit: !!hitAt }
}

/** Stand with a charging spear facing `foe` and wait for an ally's Punch arrow to throw us into him. */
// from — имена лучников, чьих стрел жду (их не обходить: threats.incoming).
export async function boostLance(bot: any, ctl: any, foe: any, { maxMs = 4000, from = [] as string[] }: any = {}) {
  const best = spear.spearOf(bot)
  if (!best) return { ok: false, why: 'нет копья' }
  if (!foe?.position) return { ok: false, why: 'врага не вижу' }
  // Всегда в руку и 2 тика: «использование» сразу после смены (или /give) сервер не начинал — копьё не било (сцена: каждый
  // второй заход «свой не держит копьё»).
  await bot.equip(best.item, 'hand')
  // После прошлого удара копьём «использование» нового разгона сервер подтверждал только мне: лучники видели флаг 0
  // (сцена: каждый второй заход). Отпустить кнопку и подождать — тогда новое начало видят все.
  bot.deactivateItem()
  await bot.waitForTicks(3)
  bot._ndBoostFrom = new Set(from)
  // Замер: скорость тела по тикам после первого толчка (скорость, что прислал сервер, — got).
  const got: number[] = [], path: number[] = []
  const onVel = (pk: any) => { if (pk?.entityId === bot.entity?.id && got.length < 4) got.push(Math.round(Math.hypot(pk.velocity.x, pk.velocity.z) * 100) / 100) }
  const onT = () => { if (got.length && path.length < 12) path.push(Math.round(Math.hypot(bot.entity.velocity.x, bot.entity.velocity.z) * 100) / 100) }
  bot._client.on('entity_velocity', onVel); bot.on('physicsTick', onT)
  try { return { ...await spear.charge(bot, ctl, foe, { maxMs, stand: true }), got, path } } finally { bot._ndBoostFrom = null; bot._client.removeListener('entity_velocity', onVel); bot.removeListener('physicsTick', onT) }
}

// Разгон к жемчугу (пользователь 24.10: «стрелами должны тоже кидать друг друга к жемчугу»): место и тик его появления
// известны заранее, и первые тики он стоит — то, чего в живом бою разгону не хватало (цель уходит с линии: 1 удар из 123).
// at/eta — точка и тики до появления; stand — своё место (бег до него прямо, поле открытое). Срок — по своим игровым
// часам от получения: часы драйвера на ускоренном сервере идут иначе.
const PEARL_TRAVEL = 6 // тиков полёта копейщика с 7 бл. на ~1.3 бл/т (сцена try-arrow-boost)
function pearlGhost(bot: any, owner: string, at: Vec3) {
  const real = () => byName(bot, owner)
  const there = () => { const e = real(); return !!e?.position && e.position.distanceTo(at) < 3 }
  return new Proxy({}, { get (_t, k) { const e = real(); if (k === 'position') return there() ? e.position : at; if (k === 'isValid') return true; if (k === 'velocity') return there() ? e.velocity : new Vec3(0, 0, 0); return (e || { username: owner, type: 'player', width: .6, height: 1.8 })[k] } })
}
async function runTo(bot: any, ctl: any, to: Vec3, until: number) {
  while (!ctl.aborted && gameClock.now() < until && Math.hypot(to.x - bot.entity.position.x, to.z - bot.entity.position.z) > .6) {
    const me = bot.entity.position
    await bot.look(Math.atan2(-(to.x - me.x), -(to.z - me.z)), 0, true).catch(() => {})
    bot.setControlState('forward', true); bot.setControlState('sprint', true); bot.setControlState('jump', !!bot.entity.isCollidedHorizontally)
    await new Promise(r => gameClock.setTimeout(r, 50))
  }
  bot.clearControlStates()
  return Math.hypot(to.x - bot.entity.position.x, to.z - bot.entity.position.z) <= 1.2
}
const waitUntil = async (ctl: any, t: number) => { while (!ctl.aborted && gameClock.now() < t) await new Promise(r => gameClock.setTimeout(r, 25)) }

export async function boostShotRpc(session: any, ctl: any, p: any = {}) {
  const bot = session.require()
  freeHands(session)
  const ally = byName(bot, p.ally)
  const draw = Number(p.draw) || 6, lag = Number(p.lag) || 0, wait = Number(p.wait) || 0
  if (p.at && Number.isFinite(p.eta)) {
    const at = new Vec3(p.at.x, p.at.y, p.at.z), arrival = gameClock.now() + Number(p.eta) * 50
    if (p.stand && !await runTo(bot, ctl, new Vec3(p.stand.x, p.stand.y, p.stand.z), arrival - (wait + draw + lag + PEARL_TRAVEL + 4) * 50)) return { ok: false, why: 'не добежал до места' }
    await waitUntil(ctl, arrival - (wait + draw + lag + PEARL_TRAVEL + 2) * 50)
    if (ctl.aborted) return { ok: false, why: 'прервали' }
    return boostShot(bot, byName(bot, p.ally), { foe: pearlGhost(bot, p.foe, at), draw, lag, wait })
  }
  const foe = p.foe ? byName(bot, p.foe) : null
  return boostShot(bot, ally, { foe, draw, lag, wait })
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
  freeHands(session)
  if (p.at && Number.isFinite(p.eta)) {
    const at = new Vec3(p.at.x, p.at.y, p.at.z), arrival = gameClock.now() + Number(p.eta) * 50, lead = (Number(p.lead) || 24) + PEARL_TRAVEL
    if (p.stand && !await runTo(bot, ctl, new Vec3(p.stand.x, p.stand.y, p.stand.z), arrival - (lead + 8) * 50)) return { ok: false, why: 'не добежал до места' }
    // Копьё в «использование» — к выстрелам лучников (lead — их натяжка с запасом), ждать толчка до появления + 1 с.
    await waitUntil(ctl, arrival - (lead + 6) * 50)
    if (ctl.aborted) return { ok: false, why: 'прервали' }
    return boostLance(bot, ctl, pearlGhost(bot, p.foe, at), { maxMs: Math.max(1500, arrival + 1000 - gameClock.now()), from: p.from || [] })
  }
  return boostLance(bot, ctl, byName(bot, p.foe), { maxMs: Number(p.maxMs) || 4000, from: p.from || [] })
}
