// Засада на жемчуг (пользователь 24.10: «когда я телепортируюсь, они заранее там взлетают, чтобы сразу долбануть булавой
// и ваншотнуть»). Тело караула (combat/pearl-watch) знает точку и тик приземления жемчуга; здесь — бег к точке, взлёт на
// заряде ветра заранее, на столько тиков раньше появления, сколько длится свой полёт, и спуск булавой в точку появления:
// бить — только когда он уже там (descend ready). Взлёт — тот же windSmash (заряд булавы, прыжок, заряд под ноги).
import { Vec3 } from 'vec3'
import * as gameClock from '../game-clock'

// Взлёт булавы: вершина 8 бл. над точкой взлёта (медиана 261 взлёта арены, 7.9–8.2) — подъём 1.18 бл./т., тяжесть 0.08,
// сопротивление 0.98. OVERHEAD — тики windSmash от конца заряда до отрыва: ожидание земли, прыжок, полёт заряда.
const LAUNCH_VY = 1.18, OVERHEAD = 3, STAND = 1.8, RUN = 5.6

/** Ticks from lift-off until the feet fall to `strikeY` above the launch floor (his feet `dy` above ours, strike ~1.2 over them). */
export function ambushFlight(dy: number) {
  // Удар — с падения не меньше 2 бл. (MaceItem: бонус от fallDistance > 1.5): он выше моей вершины без запаса — не достать.
  let y = 0, v = LAUNCH_VY, apex = 0
  for (let t = 1; t < 80; t++) { y += v; v = (v - .08) * .98; apex = Math.max(apex, y); if (v < 0 && y <= dy + 1.2) return apex - y >= 2 ? t : null }
  return null
}

/** Launch schedule: milliseconds before his arrival to start windSmash, and the mace charge that still fits; null — too late. */
export function ambushPlan(msLeft: number, dy: number, runMs = 0, slackMs = 300) {
  const flight = ambushFlight(dy)
  if (flight === null) return null
  // Падать в точку на 2 тика позже его появления: телепорт приходит пакетом, он ещё стоит; опоздать можно ещё на slackMs —
  // только что прилетевший оглядывается, прежде чем уйти.
  for (const charge of [9, 5, 0]) {
    const leadMs = (charge + OVERHEAD + flight - 2) * 50
    if (msLeft - runMs >= leadMs - slackMs) return { charge, leadMs, flight }
  }
  return null
}

export async function pearlAmbush(session: any, ctl: any, p: any = {}) {
  const bot = session.require(), mace: typeof import('../mace') = require('../mace')
  // Срок — от получения, в игровом времени этого демона: seenAt драйвера — в его часах, на ускоренном сервере они расходятся
  // со здешними (бой роя 24.10: «до появления −157099 мс» — засада ни разу не успела). Задержка драйвера — десятки мс.
  const at = new Vec3(p.at.x, p.at.y, p.at.z), arrival = gameClock.now() + Number(p.eta) * 50
  const items = bot.inventory.items()
  if (!items.some(i => i.name === 'mace') || !items.some(i => i.name === 'wind_charge') && bot.inventory.slots[45]?.name !== 'wind_charge') return { ok: false, why: 'нет булавы или заряда' }
  const me = () => bot.entity.position
  // Место взлёта — в STAND бл. от точки со своей стороны (или с угла side, что раздал рой — двое не в одну клетку): не на
  // ней (жемчуг, попавший в тело, переносит его ко мне).
  const side = Number.isFinite(p.side) ? new Vec3(-Math.sin(p.side), 0, -Math.cos(p.side)) : (() => { const v = me().minus(at); v.y = 0; return v.norm() > .1 ? v.scaled(1 / v.norm()) : new Vec3(1, 0, 0) })()
  // Уже рядом (до 4.5 бл. — спуск дорулит: в воздухе клавиши разгоняют до ~0.2 бл./т., за полёт 28 т. это 4–5 бл.; сцена
  // try-pearl-ambush: подбег 3–4 бл. стоил 50–70 мс, и засада не успевала): взлёт с места, без подбега.
  const near = Math.hypot(at.x - me().x, at.z - me().z) <= 4.5
  const stand0 = near ? me().clone() : new Vec3(Math.floor(at.x + side.x * STAND) + .5, at.y, Math.floor(at.z + side.z * STAND) + .5)
  // Ноги — на полу под клеткой: точка жемчуга — его место в тик удара, до 1.5 бл. над полом (клетка на её высоте — в воздухе:
  // бой роя 24.10, свой жемчуг «нет броска ни в одну клетку» 40 из 40).
  const solid = (x: number, y: number, z: number) => bot.blockAt(new Vec3(x, y, z), false)?.boundingBox === 'block'
  const feet = (c: Vec3) => { for (let y = Math.floor(at.y) + 1; y >= Math.floor(at.y) - 3; y--) if (solid(c.x, y - 1, c.z) && !solid(c.x, y, c.z) && !solid(c.x, y + 1, c.z)) return new Vec3(c.x, y, c.z); return null }
  const stand = near ? stand0 : feet(stand0) || stand0
  const left = () => arrival - gameClock.now(), flat = () => Math.hypot(stand.x - me().x, stand.z - me().z)
  // Как добраться (пользователь 24.10: «все способы быстрого перемещения — жемчуг на опережение, ветром себя подкинуть»):
  // бегом, если успеваю; иначе прыжок на заряде ветра (до 14 бл., ~1.5 с) или свой жемчуг (полёт ~1 с, −5 хп), затем взлёт.
  let travel = 'бег'
  // Бьют, пока жду появления, — засада снята: стоять под мечом ради чужого жемчуга нельзя (игра пользователя 24.10).
  const hp0 = bot.health ?? 20, hurt = () => (bot.health ?? 20) < hp0 - 1
  const real = () => bot.players?.[p.owner]?.entity
  const here = () => { const e = real(); return !!e?.position && e.position.distanceTo(at) < 3 }
  // Цель спуска — точка появления, пока его там нет; появился — он сам (позиция, скорость, рамка).
  const ghost: any = new Proxy({}, { get (_t, k) {
    const e = real(), there = here()
    if (k === 'position') return there ? e.position : at
    if (k === 'isValid') return true
    if (k === 'velocity') return there ? e.velocity : new Vec3(0, 0, 0)
    return (e || { username: p.owner, type: 'player', width: .6, height: 1.8 })[k]
  } })
  const track: typeof import('../bow/track') = require('../bow/track')
  const vel = () => here() ? track.observedVelocity(real()) : { x: 0, y: 0, z: 0 }
  const charges = items.filter(i => i.name === 'wind_charge').reduce((n, i) => n + i.count, 0)
  // Не успеть «добежать, потом взлететь» (жемчуг летит 1.5–2 с, стенд 24.10: 11–15 бл. и взлёт 1.5 с — ни одной засады):
  // прыжок на заряде ветра прямо к точке и на его спуске — булава в точку появления. Путь и удар — одно движение.
  const hands: typeof import('../mace/hands') = require('../mace/hands')
  const smashDown = async (travel: string) => {
    const slot = hands.hotbarIndex(bot, 'mace')
    if (slot >= 0) bot.setQuickBarSlot(slot)
    const r: any = await mace.descend(bot, alive, ghost, { vel, ready: here, maxMs: 3000 })
    return { ok: true, hit: !!r.hit, travel, fall: r.hit?.fall, why: r.why, lateMs: gameClock.now() - arrival }
  }
  // После отрыва отменяет только смерть: срок засады или новое задание посреди полёта оставили бы падать без булавы.
  const alive = { get aborted () { return !bot.entity || !((bot.health ?? 0) > 0) } }
  if (!ambushPlan(left(), at.y - me().y, flat() / RUN * 1000) && bot.entity.onGround) {
    await hands.ensureHotbar(bot, ['mace']).catch(() => {})
    // «Тягун» в грозу или воде — быстрее всего на 10–30 бл.: низкая дуга (вершина от 3 бл. — хватит на удар) за ~1 с и падение
    // булавой в точку; заряд трезубца 10 тиков + разгон. Промах страхует сторож падения (ведро), как в связке боя.
    const td: typeof import('../utility/trident') = require('../utility/trident')
    const tri = td.tridents(bot).filter(x => x.riptide).sort((a, b) => b.riptide - a.riptide)[0]
    if (tri && td.wetOrRain(bot)) {
      const rt: typeof import('../navigation/riptide') = require('../navigation/riptide')
      const insured = items.some(i => i.name === 'water_bucket' || i.name === 'cobweb')
      const arc = rt.riptideArcs(tri.riptide, me(), at, insured ? 48 : (bot.health ?? 0) - 5, [0, .25, -.25], 3)
        .filter(a => (16 + a.ticks) * 50 <= left() + 300).sort((a, b) => a.ticks - b.ticks)[0]
      if (arc) {
        bot._ndCombo = { kind: 'pearl_ambush', until: gameClock.now() + left() + 3500 }
        bot._ndRiptideMace = { maxDamage: insured ? 1000 : Math.max(0, (bot.health ?? 0) - 6) }
        try {
          const r: any = await td.riptide(bot, arc.yaw, arc.pitch, { ctl: alive })
          delete bot._ndRiptideMace
          if (!r.ok) return { ok: false, why: `Тягун: ${r.why}`, travel: 'Тягун' }
          return await smashDown('Тягун+спуск')
        } finally { delete bot._ndRiptideMace; delete bot._ndCombo; bot.clearControlStates() }
      }
    }
    // Прыжок на заряде ветра к точке и на его спуске — булава в точку появления. Клетка посадки — любая из кольца вокруг
    // точки, которую планировщик прыжка берёт (одна клетка: «не допрыгнуть» 8 из 8 на стенде).
    const wl: typeof import('../wind-leap') = require('../wind-leap')
    if (charges >= 1 && flat() <= 16) {
      const ring = [stand, ...[0, 1, 2, 3, 4, 5, 6, 7].map(k => feet(new Vec3(Math.floor(at.x + 2 * Math.cos(k * Math.PI / 4)) + .5, at.y, Math.floor(at.z + 2 * Math.sin(k * Math.PI / 4)) + .5))).filter((c): c is Vec3 => !!c)]
        .sort((a, b) => a.distanceTo(me()) - b.distanceTo(me()))
      let to: Vec3 | null = null
      for (const c of ring) { const d: any = await wl.leap(session, ctl, c, { dryRun: true, arena: p.arena }).catch(() => null); if (d?.ok) { to = c; break } }
      if (to) {
        bot._ndCombo = { kind: 'pearl_ambush', until: gameClock.now() + left() + 3500 }
        try {
          const over = () => me().y - at.y >= 2.5 && Math.hypot(at.x - me().x, at.z - me().z) <= 3.5
          const lp: any = await wl.leap(session, ctl, to, { arena: p.arena, handoff: over }).catch((e: any) => ({ ok: false, why: e.message }))
          if (!lp?.handedOff) return { ok: false, why: `прыжок на ветре: ${lp?.ok ? 'сел рядом, без спуска' : lp?.why || '?'}`, travel: 'ветер' }
          return await smashDown('ветер+спуск')
        } finally { delete bot._ndCombo; bot.clearControlStates() }
      }
    }
  }
  if (!ambushPlan(left(), at.y - me().y, flat() / RUN * 1000)) {
    const pearl = items.some(i => i.name === 'ender_pearl') && (bot.health ?? 0) > 9
    const legs: [string, () => Promise<any>, number][] = []
    if (charges >= 2 && flat() <= 14) legs.push(['ветер', () => (require('../wind-leap') as typeof import('../wind-leap')).leap(session, ctl, stand, { arena: p.arena }), 1500])
    // Клетка посадки — первая из кольца вокруг точки, куда есть бросок (одна клетка stand: «no_observed_pearl_trajectory»
    // 16 из 16 в бою роя 24.10 — пол не там или клетка занята).
    if (pearl) legs.push(['жемчуг', async () => {
      const sp: typeof import('../swarm-position') = require('../swarm-position')
      const ring = [stand, ...[0, 1, 2, 3, 4, 5, 6, 7].flatMap(k => [2, 3].map(r => new Vec3(Math.floor(at.x + r * Math.cos(k * Math.PI / 4)) + .5, at.y, Math.floor(at.z + r * Math.sin(k * Math.PI / 4)) + .5)))]
        .map(feet).filter((c): c is Vec3 => !!c).sort((a, b) => a.distanceTo(me()) - b.distanceTo(me()))
      for (const c of ring) {
        if (ctl.aborted || hurt() || left() < 1500) break
        if ((await sp.pearlPositionPlan(bot, { to: c, arena: p.arena })).ok) { stand.x = c.x; stand.y = c.y; stand.z = c.z; return sp.pearlToPosition(session, ctl, { to: c, arena: p.arena }) }
      }
      return { ok: false, why: 'нет броска ни в одну клетку у точки' }
    }, 1200])
    // После переноса стою на месте взлёта — на высоте точки (stand.y = at.y): взлёт оттуда считать с dy = 0, а не с моей
    // нынешней высоты (бой роя 24.10: точка на ярусе выше — «до появления 4800 мс, до места 8.7 бл. — не успеваю»).
    const leg = legs.find(([, , ms]) => ambushPlan(left() - ms, 0, 0))
    if (!leg) return { ok: false, why: `не успеваю: до появления ${left()} мс, до места ${flat().toFixed(1)} бл., способы: бег${legs.map(l => ', ' + l[0]).join('')}` }
    travel = leg[0]
    const moved = await leg[1]().catch((e: any) => ({ ok: false, why: e.message }))
    if (flat() > 3) return { ok: false, why: `${travel}: не долетел (${moved?.why || '?'}), до места ${flat().toFixed(1)} бл.`, travel }
  }
  const plan = ambushPlan(left(), at.y - me().y, flat() / RUN * 1000)
  if (!plan) return { ok: false, why: `${travel}: опоздал — до появления ${left()} мс`, travel }
  bot._ndCombo = { kind: 'pearl_ambush', until: gameClock.now() + left() + 2500 }
  try {
    // Бег к месту взлёта до срока (прямо: поле открытое; встал рядом — стоять).
    const launchAt = arrival - plan.leadMs
    while (!ctl.aborted && !hurt() && gameClock.now() < launchAt) {
      const d = Math.hypot(stand.x - me().x, stand.z - me().z)
      if (d > .6) {
        await bot.look(Math.atan2(-(stand.x - me().x), -(stand.z - me().z)), 0, true).catch(() => {})
        bot.setControlState('forward', true); bot.setControlState('sprint', d > 2)
        bot.setControlState('jump', !!bot.entity.isCollidedHorizontally)
      } else bot.clearControlStates()
      await new Promise(r => gameClock.setTimeout(r, 50))
    }
    bot.clearControlStates()
    if (ctl.aborted || hurt()) return { ok: false, why: hurt() ? 'меня бьют' : 'прервали', travel }
    if (Math.hypot(at.x - me().x, at.z - me().z) > 4.5) return { ok: false, why: `не добежал: до точки ${Math.hypot(at.x - me().x, at.z - me().z).toFixed(1)} бл.`, travel }
    const r: any = await mace.windSmash(bot, ctl, ghost, { chargeTicks: plan.charge, ready: here, vel })
    return { ok: !!r.launched, hit: !!r.hit, travel, plan, why: r.launched ? undefined : r.note, note: r.note, dealt: r.dealt, fall: r.fall }
  } finally { delete bot._ndCombo; bot.clearControlStates() }
}

// Подброс в точке появления: заряд ветра в пол под ней — всплеск через тик после телепорта (WindCharge 1.5 бл./т., без
// тяжести: время полёта точно). Дальнему не надо бежать; подброшенного дальше жонглирует ветер (wind-out) и бьёт булава.
export async function pearlPop(session: any, ctl: any, p: any = {}) {
  const bot = session.bot, hands: typeof import('../mace/hands') = require('../mace/hands'), tw: typeof import('./team-wind') = require('./team-wind')
  const at = new Vec3(p.at.x, p.at.y, p.at.z), arrival = gameClock.now() + Number(p.eta) * 50
  if (!hands.offWind(bot) && !(await hands.ensureHotbar(bot, ['wind_charge']).catch(() => false))) return { ok: false, why: 'нет заряда в хотбаре' }
  // Пол — верх блока, в который попал жемчуг (он упадёт на него), или первый твёрдый под точкой появления.
  let floor: Vec3 | null = null
  const hitTop = p.block && bot.blockAt(new Vec3(p.block.x, p.block.y, p.block.z), false)?.boundingBox === 'block' && p.contact && Math.abs(p.contact.y - (p.block.y + 1)) < .05
  if (hitTop) floor = new Vec3(p.contact.x, p.block.y + 1, p.contact.z)
  for (let dy = 0; dy <= 4 && !floor; dy++) { const b = bot.blockAt(new Vec3(at.x, at.y - dy - .01, at.z), false); if (b?.boundingBox === 'block') floor = new Vec3(at.x, Math.floor(at.y - dy - .01) + 1, at.z) }
  if (!floor) return { ok: false, why: 'под точкой пусто' }
  const pick: typeof import('../pick') = require('../pick')
  // Всплеск — до 1 бл. ближе ко мне (порыв 1.2 бл. ещё достаёт): прямо в точку луч часто упирается в пол чуть раньше.
  const me = bot.entity.position, back = new Vec3(me.x - floor.x, 0, me.z - floor.z), aims = [0, .5, 1].map(k => back.norm() > .1 ? floor!.plus(back.scaled(k / back.norm())) : floor!)
  const shotNow = () => { const v = bot.entity.velocity, moved = new Vec3(v.x, bot.entity.onGround ? 0 : v.y, v.z); for (const a of aims) { const s = tw.windShot(bot, pick.eyeOf(bot), a, moved, bot.username); if (s) return s } return null }
  const first = shotNow()
  if (!first) return { ok: false, why: 'пол под точкой не виден' }
  // Всплеск — через 1 тик после его появления: бросок за ticks тиков до этого.
  const fireAt = arrival + 50 - first.ticks * 50
  if (fireAt < gameClock.now() - 50) return { ok: false, why: `поздно: полёт заряда ${first.ticks} т.` }
  while (!ctl.aborted && gameClock.now() < fireAt - 25) await new Promise(r => gameClock.setTimeout(r, 25))
  if (ctl.aborted) return { ok: false, why: 'прервали' }
  return await new Promise<any>(resolve => hands.afterPacket(bot, () => {
    const shot = shotNow()
    if (!shot || !hands.windReady(bot)) return resolve({ ok: false, why: shot ? 'заряд не готов' : 'прицел пропал' })
    const fired = (require('./wind-out') as typeof import('./wind-out')).release(bot, shot)
    resolve({ ok: fired, ticks: shot.ticks, lateMs: gameClock.now() + shot.ticks * 50 - arrival })
  }))
}

// Зелье в точку появления (пользователь 24.10: «зелья, которые по площади работают, — заранее кидать в место приземления,
// это гарантированный урон»). Оседающее (AreaEffectCloud: радиус 3, 30 с, эффект каждые 5 т.) — сразу, облако ждёт его;
// взрывное (ThrownSplashPotion: брызги 4 бл. в момент разрыва) — так, чтобы разбилось к тику появления: бросок в
// arrival − полёт (throw.aim). Вред — мгновенный урон, яд, слабость, замедление; прочее не берём.
const HARMFUL = /^(strong_|long_)?(harming|poison|weakness|slowness)$/
export async function pearlPotion(session: any, ctl: any, p: any = {}) {
  const bot = session.require()
  const T: typeof import('../throw') = require('../throw'), potionOf = (require('../pvp') as typeof import('../pvp')).potionOf
  const arrival = gameClock.now() + Number(p.eta) * 50
  const rank = (i: any) => (i.name === 'lingering_potion' ? 0 : 2) + (/harming/.test(String(potionOf(i))) ? 0 : 1)
  const it = bot.inventory.items().filter((i: any) => /^(lingering|splash)_potion$/.test(i.name) && HARMFUL.test(String(potionOf(i) || ''))).sort((a: any, b: any) => rank(a) - rank(b))[0]
  if (!it) return { ok: false, why: 'нет вредного зелья' }
  const at = new Vec3(p.at.x, p.at.y, p.at.z), eye = () => bot.entity.position.offset(0, 1.62, 0)
  const sol = T.aim(eye(), at, T.KINDS[it.name as 'splash_potion'])
  if (!sol) return { ok: false, why: `не докинуть: ${eye().distanceTo(at).toFixed(1)} бл.` }
  const fireAt = it.name === 'lingering_potion' ? gameClock.now() : arrival - sol.ticks * 50
  if (fireAt < gameClock.now() - 100) return { ok: false, why: `поздно: полёт ${sol.ticks} т.`, potion: potionOf(it) }
  while (!ctl.aborted && gameClock.now() < fireAt - 25) await new Promise(r => gameClock.setTimeout(r, 25))
  if (ctl.aborted) return { ok: false, why: 'прервали' }
  const r = await T.throwAt(bot, at, { item: it })
  return { ok: !!r.thrown, why: r.why, kind: it.name, potion: potionOf(it), lateMs: Math.round(gameClock.now() + (r.ticks ?? sol.ticks) * 50 - arrival) }
}
