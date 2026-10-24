import * as flee from '../flee'
import * as gameClock from '../game-clock'
import { keyDir } from '../moves'
import * as pick from '../pick'
import * as throwMod from '../throw'
import * as ct from './crowd-threat'
import { crowdSpot } from './crowd-spot'
import { lookDead, noteWindThrowers, reachFrom, stepSafe } from './body'
import { potionOf } from './potions'
import { EYE, HIT_REACH, TICK_MS } from './rules'
import { Vec3 } from './vec3'
import { NEXT, type DuelCtx, type TurnFrame } from './turn'

// Толпа на одного (21.10): трое и больше живых врагов рядом — ход боя решает crowd-threat.decide, а не дуэль с одним:
// цель — кого бить сейчас (добить, открытого, в руке), взрывное зелье в кучу, уход из клещей туда, где все спереди
// (flee.pickDirection: мимо стен, обрыва, лавы, по полю арены), булава сверху — первым делом. Пока толпа, дуэльные
// приёмы на одного выключены: жесты и финты показа, ожидание его удара (hit-select), бег «поесть» под ударами всех.
// ND_CROWD=0 — без этого (прогон «до»).
export const ON = process.env.ND_CROWD !== '0'
// Замеры по частям: ND_CROWD_BREAK=0 — без ухода из клещей, ND_CROWD_SPOT=0 — без шага к месту в перезарядке.
const BREAK = process.env.ND_CROWD_BREAK !== '0'
const SPOT = process.env.ND_CROWD_SPOT !== '0'
// ND_CROWD_KITE=1 — «ударил и отошёл»: уход в перезарядке от любого скорого удара (замер против «держу место»).
const KITE = process.env.ND_CROWD_KITE === '1'
const RADIUS = 20
const SPLASH = /^(strong_)?harming$|poison$|weakness$|slowness$/

type Foe = ct.CrowdFoe & { e: any }
export interface CrowdState {
  on: boolean; offAt: number; mem: ct.CrowdMem; hist: Map<number, { p: any; t: number }>; frameAt: number
  frame: { foes: Foe[]; me: ct.CrowdMe; reach?: Map<number, boolean> } | null; plan: any; planAt: number; prevYaw: number | null
  runFrom: any; runAt: number; skipUntil: Map<number, number>; boxAt: number; noteAt: Map<string, number>; st: any
  spot: any; spotAt: number; freeAim?: boolean; hold?: boolean
}

export function crowdOf (ctx: DuelCtx): CrowdState {
  if (ctx.crowd) return ctx.crowd
  // Арена зовёт бой кусками по 3 с: решение, добиваемый, счёт смен и ход врагов — из прошлого куска, если он был только
  // что (иначе каждый кусок — заново: добиваемый терялся, удержание решения обнулялось).
  const now = gameClock.now()
  const prev = ctx.bot._ndCrowd && now - ctx.bot._ndCrowd.at < 4000 ? ctx.bot._ndCrowd : null
  const keep = ctx.bot._ndCrowd = { at: now, mem: prev ? prev.mem : ct.newMem(), hist: prev ? prev.hist : new Map(), on: !!(prev && prev.on) }
  return (ctx.crowd = {
    on: keep.on, offAt: 0, mem: keep.mem, hist: keep.hist, frameAt: 0, frame: null, plan: null, planAt: 0, prevYaw: null,
    runFrom: null, runAt: 0, skipUntil: new Map(), boxAt: 0, noteAt: new Map(), spot: null, spotAt: 0,
    st: { ticks: 0, foesMax: 0, kinds: {}, switches: 0, thrown: 0, throwFail: 0, breaks: 0, stuck: 0, trapped: 0, boxes: 0, spots: 0 }
  })
}
// Толпа ли сейчас (для выключения дуэльных приёмов в других ступенях).
export const crowdOn = (ctx: DuelCtx) => !!(ctx.crowd && ctx.crowd.on)

// Враги этого боя: цели арены (opts.targets — имена или id), кто бил меня, память 1 против 2, текущая цель.
function foesOf (ctx: DuelCtx, now: number) {
  const { bot, opts, attackers, dead, duo, vision } = ctx
  const out = new Map<number, any>()
  for (const t of opts.targets || []) {
    const e = typeof t === 'number' ? bot.entities[t] : bot.players[t]?.entity || (Object.values(bot.entities) as any[]).find(x => x && x.username === t)
    if (e) out.set(e.id, e)
  }
  for (const [id, a] of attackers) if (a && a.e && now - a.at < 10000) out.set(id, a.e)
  for (const e of duo.foes()) out.set(e.id, e)
  if (ctx.entity) out.set(ctx.entity.id, ctx.entity)
  const me = bot.entity.position
  return [...out.values()].map(e => vision.observe(e)).filter(e => e && e.position && e.isValid !== false && (e.type === 'player' || e.username) &&
    e.id !== bot.entity.id && e.username !== bot.username && !dead.has(e.id) && !lookDead(bot, e) && e.position.distanceTo(me) < RADIUS)
}

// Кадр толпы: что видно о каждом (позиция и ход по своим наблюдениям, что в руках, оценка хп, его заряд, щит к нам,
// в воздухе ли) и о себе.
function frameOf (ctx: DuelCtx, cr: CrowdState, now: number) {
  const { bot, duo, guard, tt, vision } = ctx
  const eye = bot.entity.position.offset(0, EYE, 0)
  const foes: Foe[] = []
  for (const e of foesOf(ctx, now)) {
    const p = e.position
    const h = cr.hist.get(e.id)
    const v = h && now - h.t > 30 && now - h.t < 400 ? { x: (p.x - h.p.x) / ((now - h.t) / 50), y: (p.y - h.p.y) / ((now - h.t) / 50), z: (p.z - h.p.z) / ((now - h.t) / 50) } : null
    if (!h || now - h.t >= 100) cr.hist.set(e.id, { p: p.clone(), t: now })
    const eq = e.equipment || []
    const held = eq[0] ? eq[0].name : null
    const fsx = tt.foes.get(e.id)
    const readyMs = fsx && fsx.swungAt ? Math.max(0, fsx.swungAt + require('../tempo').swingCooldownMs(held) - now) : 0
    const s = tt.state ? tt.state(e) : {}
    const under = bot.blockAt(new Vec3(Math.floor(p.x), Math.floor(p.y - 0.25), Math.floor(p.z)))
    const r = reachFrom(eye, e)
    foes.push({
      e, id: e.id, name: e.username || String(e.id), p, v, held, ehp: duo.ehp(e), readyMs,
      drawing: !!s.drawing, blocking: duo.shieldAtUs(e), busy: s.consuming ? 'ест или пьёт' : s.inWeb ? 'в паутине' : null,
      flying: typeof e.metadata?.[0] === 'number' && (e.metadata[0] & 0x80) !== 0,
      airborne: !under || under.boundingBox === 'empty',
      sees: vision.visible(e), r, theirR: reachFrom(p.offset(0, EYE, 0), bot.entity),
      hitNow: r <= HIT_REACH && vision.visible(e) && pick.canHit(bot, e, { range: HIT_REACH }),
      armor: eq.slice(2).filter(Boolean).map(it => ({ name: it.name }))
    })
  }
  noteWindThrowers(bot, foes.map(f => f.e), now)
  const off = bot.inventory.slots[45]
  const splash = bot.inventory.items().filter(i => i.name === 'splash_potion' && SPLASH.test(potionOf(i) || '')).map(i => ({ item: i, kind: potionOf(i) }))
  const me: ct.CrowdMe = {
    p: bot.entity.position, v: bot.entity.velocity, hp: bot.health ?? 20, charge: 0, weapon: ctx.weapon ? ctx.weapon.name : bot.heldItem?.name,
    armor: [5, 6, 7, 8].map(i => bot.inventory.slots[i]).filter(Boolean).map(it => ({ name: it.name })),
    shield: !!(guard && guard.stats && guard.stats.worn && off && off.name === 'shield'), axe: bot.inventory.items().some(i => /_axe$/.test(i.name)), splash
  }
  return { foes, me }
}

// Подпись решения в отчёт — одна на вид и цель раз в 2 с (лог читается, счёт идёт).
function note (ctx: DuelCtx, cr: CrowdState, key: string, text: string, ms = 2000) {
  const now = gameClock.now()
  if ((cr.noteAt.get(key) || 0) > now) return
  cr.noteAt.set(key, now + ms)
  ctx.used('толпа: ' + text)
}

export async function crowdTurn (ctx: DuelCtx, turn: TurnFrame) {
  if (!ON || !ctx.prof.player) return
  const cr = crowdOf(ctx)
  const { now } = turn
  if (!cr.frame || now - cr.frameAt >= 100) { cr.frame = frameOf(ctx, cr, now); cr.frameAt = now }
  const { foes, me } = cr.frame
  // Режим толпы: трое и больше живых врагов в 20 бл.; выход — меньше трёх 2 с подряд (не мигать на границе).
  if (foes.length >= 3) {
    if (!cr.on) { cr.on = true; note(ctx, cr, 'on', `${foes.length} на меня — бой одного против всех`, 30000) }
    cr.offAt = 0
  } else if (cr.on) {
    cr.offAt = cr.offAt || now
    if (now - cr.offAt > 2000) cr.on = false
  }
  ctx.bot._ndCrowd.at = now; ctx.bot._ndCrowd.on = cr.on
  if (!cr.on) return
  const st = cr.st
  st.ticks++
  st.foesMax = Math.max(st.foesMax, foes.length)
  me.charge = ctx.mf.clock.charge(0)
  for (const [id, until] of cr.skipUntil) if (until <= now) cr.skipUntil.delete(id)
  cr.mem.skipSplash = new Set(cr.skipUntil.keys())
  const sw0 = cr.mem.switches; const fl0 = cr.mem.flips
  // Долетит ли взрывное до его ног (throw.aim — дорогой перебор наклонов): раз на кадр и только для точек в окне броска.
  const reachMemo = cr.frame.reach || (cr.frame.reach = new Map())
  const kind = throwMod.kindOf('splash_potion')
  // Точка — где он будет к разрыву (его ход × время полёта ~0.45 бл/т), как упреждение броска (leadFn): иначе «долетит»
  // здесь и «не долетит» в броске (L5c: 11 из 12 отказов).
  const reach = (f) => {
    if (!reachMemo.has(f.id)) {
      const from = ctx.bot.entity.position.offset(0, EYE - 0.1, 0)
      const t = Math.hypot(f.p.x - from.x, f.p.z - from.z) / 0.45
      const v = f.v || { x: 0, z: 0 }
      reachMemo.set(f.id, !!throwMod.aim(from, new Vec3(f.p.x + v.x * t, f.p.y, f.p.z + v.z * t), kind))
    }
    return reachMemo.get(f.id)
  }
  const d = ct.decide({ foes, me, cur: ctx.entity ? ctx.entity.id : null, now, mem: cr.mem, noBreak: !BREAK, reach, kite: KITE })
  st.kinds[d.kind] = (st.kinds[d.kind] || 0) + 1
  st.switches += cr.mem.switches - sw0
  if (ctx.TRACE && cr.mem.switches !== sw0) ctx.trace(`толпа → ${d.kind}${d.f ? ' ' + d.f.name : ''}: ${d.why} | хп ${Math.round(me.hp)}, заряд ${me.charge.toFixed(2)}`)
  st.flips = (st.flips || 0) + cr.mem.flips - fl0
  // Отход кончился — взгляд снова на цель (бег смотрел по ходу), клавиши хода — ступеням ближнего боя.
  if (d.kind !== 'break' && (cr.runFrom || cr.freeAim)) { cr.plan = null; cr.runFrom = null; cr.freeAim = false; if (ctx.aim === 'free') ctx.aim = 'target' }
  const f = d.f as Foe | null
  const retargetTo = async (why: string) => {
    if (!f || !ctx.entity || f.id === ctx.entity.id) return false
    note(ctx, cr, d.kind + ':' + f.name, why)
    ctx.retarget(f.e)
    await ctx.holdWeapon()
    return true
  }
  cr.hold = d.kind === 'hold'
  if (d.kind === 'mace' && f) {
    // Булава сверху: щит к нему (держит и удар сверху — горизонталь до него нулевая, 90°: applyItemBlocking) и шаг из-под
    // него; без щита — бег из-под. Не бью: взмах опускает щит, а удар с падения — 15–25.
    note(ctx, cr, 'mace:' + f.name, d.why)
    if (ctx.pathing) { ctx.pathTo(false); ctx.pathing = false }
    ctx.aim = 'free'
    cr.freeAim = true
    await ctx.bot.lookAt(new Vec3(f.p.x, f.p.y + 1, f.p.z), true).catch(() => {})
    const away = (k) => { const v = keyDir(ctx.bot, k); return v.x * (me.p.x - f.p.x) + v.z * (me.p.z - f.p.z) }
    const keys = ['back', 'left', 'right'].filter(k => stepSafe(ctx.bot, keyDir(ctx.bot, k))).sort((a, b) => away(b) - away(a))
    for (const k of ['forward', 'back', 'left', 'right', 'jump']) ctx.set(k, false)
    if (me.shield && ctx.guard) { ctx.guard.raise(true); ctx.set('sprint', false) }
    if (keys[0]) ctx.set(keys[0], true)
    await ctx.sleep(TICK_MS)
    return NEXT
  }
  if (d.kind === 'strike' || d.kind === 'engage' || d.kind === 'hold') {
    // Смена цели — новый ход: расстояния и прицел кадра хода считаны для прежней.
    if (await retargetTo(d.why)) return NEXT
    if (d.kind !== 'engage' && d.kind !== 'hold') note(ctx, cr, d.kind + ':' + (f ? f.name : ''), d.why)
    if (d.kind === 'hold') note(ctx, cr, 'hold', d.why, 3000)
    return
  }
  if (d.kind === 'splash') {
    const cur = ctx.entity
    if (f && f.id !== cur.id) ctx.retarget(f.e)
    if (ctx.guard) await ctx.guard.raise(false)
    if (ctx.pathing) { ctx.pathTo(false); ctx.pathing = false }
    ctx.throwWhy = null
    // Упреждение — по ходу из кадра толпы (тот же, что в проверке «долетит»), к ногам.
    const fp = f.p; const fv = f.v || { x: 0, z: 0 }
    const lead = (t) => new Vec3(f.e.position.x + fv.x * Math.min(30, t), f.e.position.y, f.e.position.z + fv.z * Math.min(30, t))
    void fp
    if (await ctx.throwAt(d.item, 'толпа: ' + d.why, { minLand: 3.8, frac: 0, lead, clear: d.clear ?? 4 })) { st.thrown++; await ctx.holdWeapon(); return NEXT }
    st.throwFail++
    st.whyFail = st.whyFail || {}; st.whyFail[ctx.throwWhy || '?'] = (st.whyFail[ctx.throwWhy || '?'] || 0) + 1
    if (ctx.TRACE && f) ctx.trace(`толпа: зелье не брошено (${ctx.throwWhy}) — до него ${ctx.bot.entity.position.distanceTo(f.e.position).toFixed(1)}`)
    // Отказ броска (облако легло бы на меня, не долетит) — 1.2 с без зелий: каждая попытка — смена предмета и сброс заряда.
    for (const x of foes) cr.skipUntil.set(x.id, now + 1200)
    await ctx.holdWeapon()
    return NEXT
  }
  if (d.kind === 'break') return breakOut(ctx, cr, turn, d)
  if (d.kind === 'shield' && f) {
    // Щит к лучнику: лицом к нему (щит держит из передних ±90°), шаг вбок — с линии; цель боя не меняю.
    note(ctx, cr, 'shield:' + f.name, d.why)
    ctx.aim = 'free'
    await ctx.bot.lookAt(new Vec3(f.p.x, f.p.y + 1.5, f.p.z), true).catch(() => {})
    if (ctx.guard) ctx.guard.raise(true)
    const side = ctx.strafeKey || 'left'
    for (const k of ['forward', 'back', 'left', 'right', 'sprint', 'jump']) ctx.set(k, false)
    ctx.set(side, stepSafe(ctx.bot, keyDir(ctx.bot, side)))
    cr.freeAim = true
    await ctx.sleep(TICK_MS)
    return NEXT
  }
}

// Уход из клещей — тем же навыком, что у роя: он сравнивает бег, спуск и прокоп, прежде чем признать тупик.
async function breakOut (ctx: DuelCtx, cr: CrowdState, turn: TurnFrame, d: ct.CrowdDecision) {
  const { now } = turn
  const st = cr.st
  const home = ctx.opts.relocateTo
  if (ctx.pathing) { ctx.pathTo(false); ctx.pathing = false }
  ctx.clear(); ctx.aim = 'free'; cr.freeAim = true
  if (ctx.guard) await ctx.guard.raise(false)
  st.breaks++
  note(ctx, cr, 'break', d.why + ' — ищу выход')
  const out = await flee.smartFlee(ctx.session, ctx.ctl, { timeoutMs: Math.max(0, Math.min(3000, ctx.deadline - now)),
    foes: cr.frame.foes.map(f => f.id), arena: ctx.AR,
    goals: home && Number.isFinite(home.x) && Number.isFinite(home.z) ? [home] : [] })
  if (out.cornered && !ctx.ctl.aborted) {
    ctx.aim = 'target'; cr.freeAim = false
    await ctx.holdWeapon()
    st.trapped++
    if (now >= cr.boxAt && ctx.fortPossible()) {
      cr.boxAt = now + 3000
      note(ctx, cr, 'box', 'бежать некуда — коробка')
      if (await ctx.fortOut()) { st.boxes++; return NEXT }
    }
    note(ctx, cr, 'trapped', 'бежать некуда — бьюсь на месте')
    return
  }
  return NEXT
}

// Шаг в перезарядке: к месту, где по мне бьют немногие (crowd-spot), клавишами относительно взгляда на цель — удар не
// теряется. Удар готов и цель почти в руке — шаг к ней не отнимаю. Каждая клавиша — только в безопасный шаг (не в стену
// выше прыжка, не в лаву, не с обрыва: moves.stepSafe).
export function crowdSteer (ctx: DuelCtx, keys: any, { r, cooldownLeft }: { r: number; cooldownLeft: number }) {
  const cr = ctx.crowd as CrowdState
  if (!SPOT || !cr || !cr.on || !cr.frame) return keys
  const { bot } = ctx
  const now = gameClock.now()
  // Держу место — ищу его шире (до 9 бл.: угол, проход, стенка от лучника), пока никто не в руке.
  const wide = cr.hold && !cr.frame.foes.some(f => (f.theirR ?? 9) <= 3.5)
  // Заряд ветра у кого-то в 10 бл. — до края хочу 5 бл. (рой скидывает нарочно: удар и взрыв ветра в сторону обрыва).
  const windBy = bot._ndWindBy || new Map()
  const wind = cr.frame.foes.some(f => (f.held === 'wind_charge' || now - (windBy.get(f.id) || -1e9) < 10000) && Math.hypot(f.p.x - bot.entity.position.x, f.p.z - bot.entity.position.z) <= 10)
  if (now >= cr.spotAt) {
    cr.spotAt = now + (wide ? 700 : 400)
    try { cr.spot = crowdSpot(bot, cr.frame.foes, { radius: wide || wind ? 9 : 4, edgeWant: wind ? 5 : 1.5 }) } catch { cr.spot = null }
    if (cr.spot) { cr.st.spots++; note(ctx, cr, 'spot:' + cr.spot.why, 'встаю: ' + cr.spot.why, 3000) }
  }
  if (cooldownLeft <= 150 && r <= HIT_REACH + 0.6) return keys
  // Держу место без лучшего рядом: к цели не иду (она в куче), шаг вбок — с линии удара.
  if (!cr.spot && cr.hold) return { ...keys, forward: false, sprint: false, back: keys.back && r < HIT_REACH - 0.4 }
  if (!cr.spot) return keys
  const me = bot.entity.position
  const dx = cr.spot.x - me.x; const dz = cr.spot.z - me.z
  const n = Math.hypot(dx, dz)
  if (n < 0.5) { cr.spot = null; return keys }
  const f = keyDir(bot, 'forward'); const rt = keyDir(bot, 'right')
  const fd = (dx * f.x + dz * f.z) / n; const rd = (dx * rt.x + dz * rt.z) / n
  const out = { ...keys }
  out.forward = fd > 0.35 && stepSafe(bot, f)
  out.back = fd < -0.35 && stepSafe(bot, keyDir(bot, 'back'))
  out.strafe = Math.abs(rd) > 0.3 && stepSafe(bot, keyDir(bot, rd > 0 ? 'right' : 'left')) ? (rd > 0 ? 'right' : 'left') : null
  out.sprint = !!out.forward && !!keys.sprint
  return out
}
