'use strict'
// Толпа на одного (21.10, пользователь: «боты-дурачки бегут через него за лутом, тупят у стен и стоят»): на бота идут
// 3–6 врагов со всех сторон — мечи, топоры, лучник, булава с зарядом ветра, элитры. Здесь — чистые функции: угрозы по
// приоритету (кто ударит первым и чем) и ответ на этот тик: бить, взрывное зелье в кучу, щит к самому опасному, уйти из
// клещей, закрыться. На входе только видимое человеку: позиции и ход, что в руках, тянет ли лук, щит к нам, оценка хп
// по своим попаданиям (hp-estimate), не метаданные.
//
// Механика 1.21.11 (jar Paper, сверка — damage-model.ts):
//  * рука игрока — entity_interaction_range 3.0 от глаз до рамки; спринт 5.6 бл/с (tempo.SPRINT_BPT 0.28);
//  * перезарядка удара — attackDelayTicks (меч 12.5 т, топор 22 т, булава 33 т);
//  * булава с падения — MaceItem.getAttackDamageBonus (mace.smashDamage): 4 за блок до 3, 2 до 8, дальше 1;
//  * взрывное зелье — ThrownSplashPotion.onHitAsPotion: всем, кто ближе 4 бл. к точке разрыва, сила 1 − d/4;
//    вред II — 12 магией мимо брони (6 << уровень), яд II — 1 хп за 12 т (оставляет 1 хп), слабость — −4 к удару
//    (MobEffects ATTACK_DAMAGE −4), замедление — −15 % хода; бросившего задевает так же;
//  * щит (LivingEntity.applyItemBlocking) гасит удар из передних ±90° по взгляду, держит через 5 т после подъёма.
import * as dm from './damage-model'

type V = { x: number; y: number; z: number }

export type CrowdFoe = {
  id: number; name: string; p: V; v?: V | null
  held?: string | null; ehp: number
  readyMs?: number; drawing?: boolean; blocking?: boolean; flying?: boolean; airborne?: boolean; busy?: string | null
  sees?: boolean; hitNow?: boolean; r?: number; theirR?: number; armor?: any[]
}
export type CrowdMe = {
  p: V; v?: V | null; hp: number; charge: number; weapon?: string | null; armor?: any[]
  shield?: boolean; axe?: boolean; splash?: { item: any; kind: string }[]
}
export type Threat = { f: CrowdFoe; kind: 'melee' | 'archer' | 'mace' | 'flyer'; eta: number; dmg: number; danger: number }

export const REACH = 3.0
const SPRINT_BPS = 5.6
const hd = (a: V, b: V) => Math.hypot(a.x - b.x, a.z - b.z)
const d3 = (a: V, b: V) => Math.hypot(a.x - b.x, a.y - b.y, a.z - b.z)
const r1 = (x: number) => Math.round(x * 10) / 10
const RANGED = /^(bow|crossbow|trident)$/

// Тиков свободного падения с высоты h (тяжесть 0.08, сопротивление 0.98 — как ticksToFall в rules.ts).
function fallTicks (h: number) {
  let y = 0; let v = 0; let n = 0
  while (y < h && n < 60) { v = (v + 0.08) * 0.98; y += v; n++ }
  return n
}

// Одна угроза: когда может ударить (eta, с) и сколько снимет мне (после моей брони).
export function threatOf (f: CrowdFoe, me: CrowdMe): Threat {
  const def = dm.defenseOf(me.armor || [])
  const dy = f.p.y - me.p.y
  const dh = hd(f.p, me.p)
  const held = f.held || null
  let kind: Threat['kind'] = 'melee'; let eta: number; let dmg: number
  // Булава сверху: в руке булава — или заряд ветра и взлёт над нами (булаву берут в руку на спуске, mace.windSmash:
  // c5e — 3 смерти «smashed» с предупреждением 0.45 с, когда булава появилась в руке уже на спуске).
  const launch = held === 'wind_charge' && f.v && f.v.y > 0.3
  if ((held === 'mace' || launch) && (f.airborne || f.flying) && dy > 1.5 && dh < 6) {
    kind = 'mace'
    eta = fallTicks(dy) / 20
    dmg = dm.afterDefense(dm.meleeRaw({ weapon: 'mace', fall: dy }), 'melee', def)
  } else if (held && RANGED.test(held) && f.sees && dh > 4) {
    kind = 'archer'
    eta = f.drawing ? 0.3 : 1.2
    dmg = dm.afterDefense(held === 'trident' ? 8 : 6, 'projectile', def)
  } else if (f.flying) {
    kind = 'flyer'
    const sp = f.v ? Math.hypot(f.v.x, f.v.y, f.v.z) * 20 : 20
    eta = d3(f.p, me.p) / Math.max(8, sp)
    dmg = dm.afterDefense(dm.meleeRaw({ weapon: held && dm.isMeleeWeapon(held) ? held : null }), 'melee', def) + 2
  } else {
    // Подход — его ходом к нам (стоит или уходит — не быстрее 2.5 бл/с: до спринта ему 3–4 тика), без хода — спринтом.
    const gap = Math.max(0, (f.theirR ?? dh) - REACH)
    const closing = f.v && dh > 0.1 ? ((f.v.x * (me.p.x - f.p.x) + f.v.z * (me.p.z - f.p.z)) / dh) * 20 : SPRINT_BPS
    eta = Math.max(gap / Math.max(2.5, Math.min(SPRINT_BPS, closing)), (f.readyMs || 0) / 1000)
    if (f.busy) eta += 0.6
    dmg = dm.afterDefense(dm.meleeRaw({ weapon: held && dm.isMeleeWeapon(held) ? held : null }), 'melee', def)
  }
  return { f, kind, eta: Math.round(eta * 100) / 100, dmg: r1(dmg), danger: r1(dmg / (eta + 0.25)) }
}

// Кто ударит первым и чем — по убыванию опасности.
export function threats (foes: CrowdFoe[], me: CrowdMe): Threat[] {
  return foes.map(f => threatOf(f, me)).sort((a, b) => b.danger - a.danger)
}

// Наибольший угол между соседями по кругу, видимыми из точки: все спереди — разброс мал, клещи — велик (рад).
export function spread (from: V, pts: V[]) {
  if (pts.length < 2) return 0
  const a = pts.map(p => Math.atan2(p.z - from.z, p.x - from.x)).sort((x, y) => x - y)
  let gap = 0
  for (let i = 0; i < a.length; i++) gap = Math.max(gap, (i + 1 < a.length ? a[i + 1] : a[0] + 2 * Math.PI) - a[i])
  return 2 * Math.PI - gap
}

// Мой удар по нему (полный заряд, без крита) после его видимой брони.
export function myHit (f: CrowdFoe, me: CrowdMe) {
  return dm.afterDefense(dm.meleeRaw({ weapon: me.weapon || null }), 'melee', dm.defenseOf(f.armor || []))
}

// Кого бить сейчас: из тех, кого достаю и вижу прицелом. Добью — первым; добиваемый (focus: урон не размазывать по
// всем — c5a: 125 урона за 8 раундов на пятерых поровну, ни одного убийства); меньше хп по оценке; кто вот-вот ударит
// (удар первым сбивает его заряд отбросом); занятого (ест, тянет лук). Текущую цель держу при равных.
export function strikeChoice (foes: CrowdFoe[], me: CrowdMe, cur: number | null = null, focus: number | null = null) {
  let best = null
  for (const f of foes) {
    // Щит к нам без топора — удар уйдёт в щит (0 урона): такого не бью, пока есть кто открыт.
    if (!f.hitNow || (f.blocking && !me.axe)) continue
    const hit = myHit(f, me)
    let s = hit - f.ehp * 0.6
    const why: string[] = []
    if (f.ehp <= hit + 0.5) { s += 10; why.push('добью') }
    if (f.id === focus) { s += 4; why.push('добиваемый') }
    if ((f.readyMs ?? 999) < 150 && (f.theirR ?? 9) <= REACH + 0.3) { s += 2; why.push('бьёт первым') }
    if (f.busy) { s += 3; why.push(f.busy) }
    if (f.blocking) { s += 2; why.push('топором по щиту') }
    if (f.id === cur) s += 1.5
    if (!best || s > best.score) best = { f, score: r1(s), why: why.join(', ') || `${Math.round(f.ehp)} хп` }
  }
  return best
}

// Сколько ещё ближних врагов в 4.5 бл. от него: идти к нему — встать в кучу («третий лишний» — сам; crowd.ts CROWD).
export function crowdedAt (f: CrowdFoe, foes: CrowdFoe[]) {
  return foes.filter(o => o !== f && !o.flying && !(o.held && RANGED.test(o.held)) && hd(o.p, f.p) < 4.5).length
}

// Добиваемый: слабейший по оценке из ближних (в 7 бл.); щит к нам без топора и куча вокруг него — хуже. Держу, пока жив
// и рядом; сменить — если другой лучше на 4+ (как duo.ts: «не метаться»; там порог 6 — здесь толпа, ждать дольше нельзя).
export function focusOf (foes: CrowdFoe[], me: CrowdMe, prev: number | null) {
  const near = foes.filter(f => !f.flying && hd(f.p, me.p) < 7)
  const val = (f: CrowdFoe) => f.ehp + (f.blocking && !me.axe ? 4 : 0) + crowdedAt(f, foes) * 3
  const best = near.slice().sort((a, b) => val(a) - val(b))[0] || null
  const keep = prev != null ? near.find(f => f.id === prev) : null
  if (keep && (!best || val(best) > val(keep) - 4)) return keep
  return best
}

// Сила взрывного зелья на его рамку по расстоянию от точки разрыва (у рамки 0.3 бл. запаса).
const splashK = (d: number) => Math.max(0, 1 - Math.max(0, d - 0.3) / 4)
// Окно броска: дальше 5.0 к ногам не берусь — предел 5.54 (throw.solve: скорость 0.5 бл/т, наклон −20°, тяжесть 0.05;
// до середины тела ~4.8), а между решением и броском (опустить щит, взять зелье) мы оба сдвигаемся на 0.3–0.6 (L5g:
// 50 из 70 отказов «не долетит» на 5.1–5.35). Ближе — облако на мне: рамки ≥ 4 (pvp.throwAt splash_clearance) — центры ≥
// 5.1, окна нет. Поэтому чистое окно — только с высоты; вред II при хп ≥ 10 — с 4.5 (рамки ≥ 3.4: край облака по мне,
// сила ≤ 0.15 — до 2 хп мне против 12 каждому в куче). Слабость, яд, замедление на себя — нет: только с CLEAR.
const SPLASH_MAX = 5.0
const CLEAR = 4 // зазор рамок, как в throwAt
export const HARM_CLEAR = 3.4
const SPLASH_MIN = (clear: number) => clear + 0.6 + 0.425 + 0.1 // центры: зазор + две полуширины + запас попадания
// Расстояние от точки M до отрезка A→B (в плоскости).
function segGap (A: V, B: V, M: V) {
  const ax = B.x - A.x; const az = B.z - A.z; const l2 = ax * ax + az * az
  const t = l2 ? Math.max(0, Math.min(1, ((M.x - A.x) * ax + (M.z - A.z) * az) / l2)) : 0
  return Math.hypot(A.x + ax * t - M.x, A.z + az * t - M.z)
}
const MELEE_W = (h?: string | null) => !h || !RANGED.test(h)
// Куда бросить взрывное зелье: точка — ноги врага в центре кучи; польза — по каждому в 4 бл. от неё; бросок — с
// 5.1–5.5 бл. (SPLASH_MIN/MAX; с высоты — дальше). Вред — урон мимо брони (до его хп), добивание — сверху; слабость — минус
// 4 с каждого его удара на ~5 ударов; яд — до 10 хп за бой (до 1 хп); замедление — разрыв дистанции. Пусто — нет пользы.
// reach(f) — долетит ли до его ног (throw.aim, у вызывающего мир и тело); нет — точку не беру (смена предмета впустую).
export function splashChoice (foes: CrowdFoe[], me: CrowdMe, { min = 10, skip = new Set<number>(), focus = null as number | null, reach = null as ((f: CrowdFoe) => boolean) | null } = {}) {
  const pots = me.splash || []
  if (!pots.length) return null
  let best = null
  for (const c of foes) {
    if (skip.has(c.id) || !c.sees || c.flying) continue
    // Другой враг на линии броска ближе 4.6 ко мне — зелье разобьётся о него рядом со мной (c5e: «killed by NeuroFarm29
    // using magic» — свой вред II).
    const blocked = foes.some(o => o !== c && !o.flying && hd(o.p, me.p) < SPLASH_MIN(CLEAR) && segGap(me.p, c.p, o.p) < 0.9)
    if (blocked) continue
    const dc = d3(c.p, me.p)
    // Пока зелье летит (~0.45 бл/т), бегущий на меня сокращает дистанцию: разрыв — у его тела ближе (c5a: свой вред
    // II в себя −2, бросок с 5.4 в троих, бегущих на меня). Мерю по тому, где он будет.
    const rv = { x: (c.v ? c.v.x : 0) - (me.v ? me.v.x : 0), z: (c.v ? c.v.z : 0) - (me.v ? me.v.z : 0) }
    const closing = Math.max(0, (rv.x * (me.p.x - c.p.x) + rv.z * (me.p.z - c.p.z)) / (hd(c.p, me.p) || 1))
    const at = dc - closing * dc / 0.45
    if (hd(c.p, me.p) > SPLASH_MAX + Math.max(0, me.p.y - c.p.y) * 0.8) continue
    let reached = null
    const near = foes.filter(f => !f.flying && d3(f.p, c.p) < 4.3)
    for (const pot of pots) {
      const harm = /harming$/.test(pot.kind)
      // Мало хп — свой вред с края облака может добить меня: не бросаю.
      if (harm && me.hp <= 6) continue
      const clear = harm && me.hp >= 10 ? HARM_CLEAR : CLEAR
      if (at < SPLASH_MIN(clear)) continue
      if (reach && (reached ?? (reached = reach(c))) === false) continue
      let value = 0; let kills = 0; const hit: string[] = []
      for (const f of near) {
        const k = splashK(d3(f.p, c.p))
        if (k <= 0) continue
        let v = 0
        if (pot.kind === 'strong_harming' || pot.kind === 'harming') {
          const amt = (pot.kind === 'strong_harming' ? 12 : 6) * k
          v = Math.min(f.ehp, amt) + (amt >= f.ehp ? 8 : 0)
          if (amt >= f.ehp) kills++
        } else if (/weakness$/.test(pot.kind)) v = MELEE_W(f.held) ? 10 * k : 0
        else if (/poison$/.test(pot.kind)) v = Math.min(Math.max(0, f.ehp - 1), (/^strong/.test(pot.kind) ? 12 : 6) * k) * 0.8
        else if (/slowness$/.test(pot.kind)) v = 2.5 * k
        if (v > 0.5) { value += v; hit.push(f.name) }
      }
      // Одному — только вред, и то если добивает этим или следующим броском (два вреда II — 24, второй не раньше
      // 10 т: LivingEntity.hurtServer); остальное в одного — debuff-ветка дуэли.
      const harms = pots.filter(q => /harming$/.test(q.kind)).slice(0, 2).reduce((t, q) => t + (q.kind === 'strong_harming' ? 12 : 6), 0)
      const burst = c.id === focus && /harming$/.test(pot.kind) && hit.length === 1 && harms >= c.ehp + 1
      if (burst && !kills) value += 8
      if (hit.length < 2 && !kills && !burst) continue
      if (value >= min && (!best || value > best.value)) best = { f: c, item: pot.item, kind: pot.kind, clear, value: r1(value), hit, why: `${pot.kind} в кучу: ${hit.join(', ')} (польза ${r1(value)})` }
    }
  }
  return best
}

export type CrowdDecision = { kind: 'mace' | 'splash' | 'strike' | 'break' | 'shield' | 'engage' | 'hold'; f?: CrowdFoe | null; item?: any; clear?: number; why: string; urgent?: boolean }
type Mark = { cls: string; id: number | null; at: number }
export type CrowdMem = { kind: string | null; id: number | null; since: number; switches: number; flips: number; focus: number | null
  last?: Mark | null; prev?: Mark | null; skipSplash?: Set<number> }
const HOLD_MS = { break: 700, shield: 350, engage: 600, hold: 600 }
// Класс решения для счёта смен: удар и подход к одному — одно и то же «бью его».
const CLS = { strike: 'fight', engage: 'fight', hold: 'fight' }

// Ответ на этот тик. ts — threats(); cur — моя цель; now — часы боя (мс); mem — прошлое решение (держать без дёрганья:
// смена вида или цели — только по срочному поводу или после срока HOLD_MS). Счёт: switches — смены (класс, цель),
// flips — возврат к предпоследнему, когда последнее продержалось меньше 1 с (дёрганье между двумя).
export function decide ({ foes, me, ts, cur = null, now = 0, mem, noBreak = false, reach = null, kite = false }: { foes: CrowdFoe[]; me: CrowdMe; ts?: Threat[]; cur?: number | null; now?: number; mem: CrowdMem; noBreak?: boolean; reach?: ((f: CrowdFoe) => boolean) | null; kite?: boolean }): CrowdDecision {
  ts = ts || threats(foes, me)
  const pick = (d: CrowdDecision) => {
    const id = d.f ? d.f.id : null
    if (d.kind !== mem.kind || id !== mem.id) { mem.kind = d.kind; mem.id = id; mem.since = now }
    const cls = CLS[d.kind] || d.kind
    if (!mem.last || mem.last.cls !== cls || mem.last.id !== id) {
      if (mem.last) {
        mem.switches++
        if (mem.prev && mem.prev.cls === cls && mem.prev.id === id && now - mem.last.at < 1000) mem.flips++
      }
      mem.prev = mem.last
      mem.last = { cls, id, at: now }
    }
    return d
  }
  const fx = focusOf(foes, me, mem.focus)
  mem.focus = fx ? fx.id : null
  // 1. Булава сверху — до всего: удар с падения снимает 15–25 (по железу), щит его держит, уход из-под — тоже.
  const mace = ts.find(t => t.kind === 'mace' && t.eta <= 1.5)
  if (mace) return pick({ kind: 'mace', f: mace.f, why: `булава сверху: ${mace.f.name} (через ${mace.eta} с, до ${Math.round(mace.dmg)})`, urgent: true })
  const charged = me.charge >= 0.85
  const strike = strikeChoice(foes, me, cur, mem.focus)
  // 2. Добить того, кто в руке, — сразу (минус один в толпе дороже всего).
  if (charged && strike && /добью/.test(strike.why)) return pick({ kind: 'strike', f: strike.f, why: 'добиваю ' + strike.f.name, urgent: true })
  // 3. Взрывное зелье в кучу (или вред в добиваемого, если два броска его снимут).
  const sp = splashChoice(foes, me, { skip: mem.skipSplash, focus: mem.focus, reach })
  if (sp) return pick({ kind: 'splash', f: sp.f, item: sp.item, clear: sp.clear, why: sp.why, urgent: true })
  const imminent = ts.filter(t => t.kind !== 'archer' && t.eta <= 0.6)
  // kite — «ударил и отошёл»: в перезарядке не стоять в руке ни у кого (двое скоро — уйти; один — уйти, пока удар пуст).
  const pincer = !noBreak && (imminent.length >= 3 || (imminent.length >= 2 && (kite || spread(me.p, imminent.map(t => t.f.p)) > 110 * Math.PI / 180)) ||
    (kite && imminent.length >= 1 && me.charge < 0.5))
  const held = mem.kind && now - mem.since < (HOLD_MS[mem.kind] || 0)
  // 4. Удар заряжен и кто-то в руке — бить (в клещах тоже: удар отбросит одного, рывок без удара — подарок всем).
  if (charged && strike) return pick({ kind: 'strike', f: strike.f, why: `бью ${strike.f.name}: ${strike.why}` })
  // 5. Клещи: двое с разных сторон или трое разом ударят в ближайшие 0.6 с — уйти так, чтобы все были спереди.
  if (pincer && (!held || mem.kind === 'break')) return pick({ kind: 'break', why: `клещи: ${imminent.map(t => t.f.name).join(', ')}` })
  if (held && mem.kind === 'break') return pick({ kind: 'break', why: 'держу отход' })
  // 6. Щит к лучнику, который тянет на меня, пока ближних рядом нет (от ближнего щит поднимает удар по цели —
  // strikeTurn, mf.shield; поворот к каждому ближнему — дёрганье целей, c5a: до 18 смен за 3 с).
  if (me.shield && !imminent.length) {
    const arch = ts.find(t => t.kind === 'archer' && t.f.drawing)
    const keep = held && mem.kind === 'shield' ? foes.find(x => x.id === mem.id) : null
    const f = arch ? arch.f : keep
    if (f) return pick({ kind: 'shield', f, why: `щит к лучнику ${f.name}` })
  }
  // 7. Добиваемый рядом (в 3.6 бл.) или один (не в куче) — к нему. В куче — не лезть (c5d: шёл в середину пятерых —
  // жил 8.6 с против 15.7 у прежнего): держать место, лицом к тому, кто ударит первым, бить вошедшего в руку.
  if (fx && (hd(fx.p, me.p) <= 3.6 || crowdedAt(fx, foes) <= 1)) return pick({ kind: 'engage', f: fx, why: `добиваемый ${fx.name}: ${Math.round(fx.ehp)} хп` })
  const first = ts.find(t => t.kind !== 'archer' && !t.f.flying)
  if (fx && first) {
    const keep = held && mem.kind === 'hold' ? foes.find(f => f.id === mem.id) : null
    const f = keep && keep.id !== first.f.id && hd(keep.p, me.p) < 6 ? keep : first.f
    return pick({ kind: 'hold', f, why: `держу место: ${fx.name} в куче (${crowdedAt(fx, foes) + 1}), лицом к ${f.name}` })
  }
  let best = null
  for (const t of ts) {
    if (t.kind === 'archer' && t.f.r != null && t.f.r > 12) continue
    const s = t.f.ehp * 0.6 + t.eta * 3 - t.dmg * 0.3 + (t.f.blocking ? 4 : 0) - (t.f.busy ? 3 : 0) - (t.f.id === cur ? 3 : 0)
    if (!best || s < best.s) best = { t, s }
  }
  if (!best) return pick({ kind: 'engage', f: null, why: 'никого рядом' })
  if (held && mem.kind === 'engage' && mem.id !== best.t.f.id) {
    const keep = foes.find(f => f.id === mem.id)
    if (keep) return pick({ kind: 'engage', f: keep, why: 'держу цель' })
  }
  return pick({ kind: 'engage', f: best.t.f, why: `к ${best.t.f.name}: ${Math.round(best.t.f.ehp)} хп, через ${best.t.eta} с` })
}

export function newMem (): CrowdMem { return { kind: null, id: null, since: 0, switches: 0, flips: 0, focus: null, last: null, prev: null, skipSplash: new Set() } }
