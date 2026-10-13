'use strict'
// Боевой калькулятор, часть 3 — планировщик добивания на короткий горизонт (2–4 действия).
// Чистый модуль: на входе наблюдение (combat-observe.observe или руками в тестах), на выходе
// { action, why, expected, pKill, plan[], dps, danger, hp }. Тело он не трогает.
//
// Модель: каждое действие — время исполнения (смена слота, сближение, ожидание заряда, прыжок для крита,
// заряд арбалета/лука) и исходы { p, сырой урон } (промах, крит — вероятностями из параметров). Исходы
// проходят его щит → окно неуязвимости → броню/чары (damage-model). Цель — максимум P(ЭХП ≤ урон за T тиков)
// по распределению оценки хп (hp-estimate.cdf), с тотемом (вторая жизнь: 1 хп + 8 поглощения + Регенерация II)
// и естественной регенерацией по ходу плана. Убить за T нельзя — максимум урона в секунду.
const dm = require('./damage-model')
const { cdf, REGEN_FAST, REGEN_SLOW } = require('./hp-estimate')

const DEFAULTS = {
  horizon: 60, // T, тиков
  depth: 3, // действий в плане, 2–4
  beam: 16, // частичных планов на шаг
  pHit: { melee: 0.9, jab: 0.8, charge: 0.6, smash: 0.7, arrow: 0.6, firework: 0.7, crystal: 0.85, anchor: 0.8, rod: 0.4, trident: 0.55 },
  pCrit: 0.8, // доля ударов, которые бот доводит до крита, когда крит возможен
  reach: 3.0, // ENTITY_INTERACTION_RANGE игрока (Player.createAttributes 3.0)
  sprint: 0.28, // бл/тик сближения спринтом (5.6 бл/с)
  runway: 7.1, // бл/с — наша скорость в разгоне с копьём (спринт-прыжки)
  jumpCritTicks: 6, // от прыжка до падения: vy 0.42 → вершина ~6 тиков
  switchTicks: 1,
  knockback: 1.0, // бл. — на сколько отлетает он после нашего удара (0.4 + разгон)
  crystalTicks: 4, // поставить и ударить
  anchorTicks: 8, // поставить, зарядить, нажать
  arrowRange: 15, // дальше попадание стрелой падает ∝ 1/d
  minPKill: 0.05,
  // Удочка (S7d): зацеп — 40 % забросов (натива s7i: 38/96); рывок FishingHook.pullEntity Δv = 0.1·(я − поплавок) —
  // на 6 бл. 0.6 б/т к нам, на земле гасится трением за ~4 тика: его к нам ≈ 0.45 дистанции, и 10 тиков он идёт к нам
  // (это и есть комбо «подтяг → спринт-удар / крит / разгон копья»: rel разгона = моя + его скорость к нам).
  rodMax: 20, rodPullShare: 0.45, rodPullTicks: 10,
  tridentRange: 24
}
const SPEAR_JAB_MIN = 2.0 // AttackRange(2.0, 4.5, …) у копья: Item$Properties.spear
const SPEAR_JAB_MAX = 4.5
const REGEN_MEAN = (REGEN_FAST + REGEN_SLOW) / 2

const r1 = (x) => Math.round(x * 10) / 10
const NAMES = {
  melee: 'удар', jab: 'укол копьём', charge: 'разгон копьём', smash: 'булава с падения', 'axe-shield': 'топором по щиту',
  xbow: 'арбалет', 'xbow-load': 'зарядить арбалет и выстрелить', bow: 'лук', crystal: 'кристалл', anchor: 'якорь',
  rod: 'подтяг удочкой', trident: 'бросок трезубца'
}
const label = (t) => `${NAMES[t.kind] || t.kind}${t.item && t.kind !== 'axe-shield' ? ` (${t.item}${t.variant ? ', ' + t.variant : ''})` : t.variant ? ` (${t.variant})` : ''}`

// ---------------------------------------------------------------- каталог действий

const lvl = (it, k) => (it && it.ench && it.ench[k]) || 0
const countOf = (items, name) => items.reduce((n, i) => n + (i && i.name === name ? (i.count ?? 1) : 0), 0)

function catalog (obs) {
  const me = obs.me
  const items = (me.items || []).filter(Boolean)
  const out = []
  // Ближнее оружие: по одному на имя (с лучшей Остротой), плюс кулак. «now» — сразу, текущим зарядом
  // (быстрое добивание); «full» — полный заряд и прыжок для крита.
  const best = new Map()
  for (const it of items) {
    if (!dm.isMeleeWeapon(it.name) || dm.isSpear(it.name)) continue
    if (!best.has(it.name) || lvl(it, 'sharpness') > lvl(best.get(it.name), 'sharpness')) best.set(it.name, it)
  }
  const melee = [...best.values(), { name: null }]
  for (const it of melee) {
    out.push({ kind: 'melee', item: it.name, it, variant: 'full' })
    out.push({ kind: 'melee', item: it.name, it, variant: 'now' })
  }
  const spears = items.filter(i => dm.isSpear(i.name))
  if (spears.length) {
    const sp = spears.reduce((a, b) => (dm.attackDamage(b.name) + dm.sharpBonus(lvl(b, 'sharpness')) > dm.attackDamage(a.name) + dm.sharpBonus(lvl(a, 'sharpness')) ? b : a))
    out.push({ kind: 'jab', item: sp.name, it: sp })
    const ch = spears.reduce((a, b) => (dm.spearChargeRaw({ weapon: b.name, rel: 10 }) > dm.spearChargeRaw({ weapon: a.name, rel: 10 }) ? b : a))
    out.push({ kind: 'charge', item: ch.name, it: ch })
  }
  const maceIt = items.find(i => i.name === 'mace')
  if (maceIt && (obs.smash || ((me.fallDistance || 0) > dm.SMASH_MIN && !me.onGround))) out.push({ kind: 'smash', item: 'mace', it: maceIt })
  const axe = items.filter(i => dm.isAxe(i.name)).sort((a, b) => dm.attackSpeed(b.name) - dm.attackSpeed(a.name))[0]
  if (axe && obs.foe.blocking) out.push({ kind: 'axe-shield', item: axe.name, it: axe })
  items.forEach((it, idx) => {
    const cb = it.name === 'crossbow' && it.crossbow
    if (cb && cb.loaded) out.push({ kind: 'xbow', item: 'crossbow', it, id: idx, variant: cb.ammo === 'firework' ? `ракета ×${cb.stars || 0}` : 'стрела' })
  })
  const empty = items.find(it => it.name === 'crossbow' && it.crossbow && !it.crossbow.loaded)
  const rockets = items.find(i => i.name === 'firework_rocket')
  const arrows = items.some(i => /arrow$/.test(i.name))
  if (empty && (arrows || rockets)) out.push({ kind: 'xbow-load', item: 'crossbow', it: empty, rocketStars: rockets ? (rockets.stars ?? 0) : 0, arrows })
  const bow = items.find(i => i.name === 'bow')
  if (bow && arrows) out.push({ kind: 'bow', item: 'bow', it: bow })
  // Удочка — подтяг (урона нет, меняет дистанцию и даёт ему скорость к нам: см. DEFAULTS.rodPullShare).
  const rod = items.find(i => i.name === 'fishing_rod')
  if (rod && obs.foe.player !== false) out.push({ kind: 'rod', item: 'fishing_rod', it: rod })
  // Трезубец броском (не «Тягун» — TridentItem.releaseUsing его не бросает): 8 (ThrownTrident.baseDamage, тип trident —
  // снаряд, щит держит), «Громовержец» в грозу по цели под небом — молния 5 (lightning_bolt: мимо щита, броня держит)
  // + поджог 8 с (on_fire, мимо брони). Без «Верности» — трезубец остаётся на земле: дорогой.
  const tri = items.filter(i => i.name === 'trident' && !lvl(i, 'riptide')).sort((a, b) => (lvl(b, 'channeling') - lvl(a, 'channeling')) || (lvl(b, 'loyalty') - lvl(a, 'loyalty')))[0]
  if (tri) out.push({ kind: 'trident', item: 'trident', it: tri, expensive: !lvl(tri, 'loyalty') })
  // Сильные расходники — только если вызывающий знает точку и видимость (crystal.ts / boom.ts).
  // Кристалл дорог, пока их мало; с запасом от 16 — обычный удар (10.10, раунд кристаллов: 128 в рюкзаке, а планировщик брал меч
  // при равном шансе — 0 взрывов на 13 смертей).
  if (obs.boom && obs.boom.crystal && countOf(items, 'end_crystal') > 0) out.push({ kind: 'crystal', item: 'end_crystal', expensive: countOf(items, 'end_crystal') < 16, at: obs.boom.crystal })
  if (obs.boom && obs.boom.anchor && countOf(items, 'respawn_anchor') > 0 && countOf(items, 'glowstone') > 0) out.push({ kind: 'anchor', item: 'respawn_anchor', expensive: true, at: obs.boom.anchor })
  return out
}

// ---------------------------------------------------------------- одно действие

function approachTicks (dist, target, obs, P, st: any = null) {
  if (dist <= target) return 0
  const pull = st && st.pullUntil > st.t ? st.pullV : 0
  const closing = P.sprint + Math.max(-P.sprint, (obs.foe.approach || 0) + pull)
  return closing > 0.02 ? Math.ceil((dist - target) / closing) : Infinity
}
// Свёртка равновероятных исходов в ≤ 3 корзины (среднее внутри) — чтобы дерево планов не взрывалось.
function bucket (outs) {
  if (outs.length <= 3) return outs
  const sorted = outs.slice().sort((a, b) => a.raw - b.raw)
  const k = Math.ceil(sorted.length / 3)
  const res = []
  for (let i = 0; i < sorted.length; i += k) {
    const g = sorted.slice(i, i + k)
    const p = g.reduce((s, o) => s + o.p, 0)
    res.push({ ...g[0], p, raw: g.reduce((s, o) => s + o.raw * o.p, 0) / p })
  }
  return res
}
const scale = (outs, q) => outs.map(o => ({ ...o, p: o.p * q }))

// Исполнить шаблон из состояния: { dt, outs: [{ p, raw, kind, breach, pierce, disables }], held, attack }
// или null — нельзя. outs не включают промах: его вероятность — 1 − Σp.
function run (tpl, st, obs, P) {
  const me = obs.me
  const foe = obs.foe
  const switched = st.held !== tpl.item
  const sw = switched ? P.switchTicks : 0
  const since0 = switched ? 0 : st.since
  const strength = me.strength ?? -1
  const weakness = me.weakness ?? -1
  const sharpness = lvl(tpl.it, 'sharpness')
  switch (tpl.kind) {
    case 'melee': {
      const app = approachTicks(st.dist, P.reach - 0.1, obs, P, st)
      if (!isFinite(app)) return null
      if (tpl.variant === 'now') {
        if (switched) return null
        const charge = dm.chargeAfter(since0 + app, tpl.item)
        const raw = dm.meleeRaw({ weapon: tpl.item, sharpness, strength, weakness, charge })
        return { dt: app, outs: [{ p: P.pHit.melee, raw, kind: 'melee' }], attack: true, dist: P.reach - 0.1 + P.knockback }
      }
      const wait = Math.max(0, dm.ticksToCharge(tpl.item, 1) - since0)
      const crit = me.canCrit !== false
      const dt = sw + Math.max(app, wait, crit && me.onGround !== false ? P.jumpCritTicks : 0)
      const base = { weapon: tpl.item, sharpness, strength, weakness, charge: 1 }
      const outs = crit
        ? [{ p: P.pHit.melee * P.pCrit, raw: dm.meleeRaw({ ...base, crit: true }), kind: 'melee' }, { p: P.pHit.melee * (1 - P.pCrit), raw: dm.meleeRaw(base), kind: 'melee' }]
        : [{ p: P.pHit.melee, raw: dm.meleeRaw(base), kind: 'melee' }]
      return { dt, outs, attack: true, dist: P.reach - 0.1 + P.knockback }
    }
    case 'axe-shield': {
      if (!st.shieldUp || st.t < st.shieldOffUntil) return null
      const app = approachTicks(st.dist, P.reach - 0.1, obs, P)
      if (!isFinite(app)) return null
      // Любой заряд годится: щит гасит удар целиком (урон > 0 → blockUsingItem → disable 100 тиков).
      const raw = dm.meleeRaw({ weapon: tpl.item, sharpness, strength, weakness, charge: dm.chargeAfter(since0 + app, tpl.item) })
      return { dt: sw + app, outs: [{ p: P.pHit.melee, raw, kind: 'melee', disables: true }], attack: true, dist: Math.min(st.dist, P.reach - 0.1) }
    }
    case 'smash': {
      if (st.smashUsed) return null
      const falling = (me.fallDistance || 0) > dm.SMASH_MIN && !me.onGround && st.t === 0
      const h = falling ? me.fallDistance : obs.smash && obs.smash.h
      if (!(h > dm.SMASH_MIN)) return null
      if (falling && st.dist > P.reach) return null
      // Подъём (заряд ветра) идёт параллельно заряду булавы: бьём с полным зарядом (крит), если не падаем уже.
      const dt = falling ? sw : Math.max(obs.smash.ticks || 0, sw + Math.max(0, dm.ticksToCharge('mace', 1) - since0))
      const charge = dm.chargeAfter(switched ? dt - sw : since0 + dt, 'mace')
      const raw = dm.meleeRaw({ weapon: 'mace', fall: h, charge, density: lvl(tpl.it, 'density'), strength, weakness })
      return { dt, outs: [{ p: P.pHit.smash, raw, kind: 'melee', breach: lvl(tpl.it, 'breach') }], attack: true, smash: true, dist: P.reach - 0.1 + P.knockback }
    }
    case 'jab': {
      if (st.dist < SPEAR_JAB_MIN) return null
      const app = approachTicks(st.dist, SPEAR_JAB_MAX - 0.1, obs, P)
      if (!isFinite(app)) return null
      const dt = sw + Math.max(app, Math.max(0, dm.ticksToCharge(tpl.item, 1) - since0))
      const raw = dm.jabRaw({ weapon: tpl.item, sharpness, strength, weakness, charge: 1 })
      return { dt, outs: [{ p: P.pHit.jab, raw, kind: 'melee' }], attack: true, dist: Math.min(st.dist, SPEAR_JAB_MAX - 0.1) + P.knockback * 0.5 }
    }
    case 'charge': {
      const pull = st.pullUntil > st.t ? st.pullV : 0
      const rel = P.runway + Math.max(0, ((foe.approach || 0) + pull) * 20)
      const raw = dm.spearChargeRaw({ weapon: tpl.item, sharpness, rel })
      if (!(raw > 0) || st.dist < 3) return null
      const s = require('../spear').SPEARS[tpl.item]
      const runUp = Math.ceil(Math.max(0, st.dist - 3) / (P.runway / 20))
      return { dt: sw + Math.max(Math.round(s.delay * 20), runUp), outs: [{ p: P.pHit.charge, raw, kind: 'melee' }], attack: false, dist: 2.5 + P.knockback }
    }
    case 'xbow': {
      const cb = tpl.it.crossbow
      if (st.used[tpl.id] || !obs.los) return null
      if (cb.ammo === 'firework') {
        if (st.dist < 6 || st.dist > 34) return null
        return { dt: sw + 1, outs: [{ p: P.pHit.firework, raw: dm.fireworkRaw(cb.stars || 0, 1), kind: 'explosion' }], use: tpl.id }
      }
      if (st.dist < 2.5 || st.dist > 48) return null
      const q = P.pHit.arrow * Math.min(1, P.arrowRange / Math.max(P.arrowRange, st.dist))
      const outs = dm.arrowOutcomes({ speed: dm.arrowSpeedAt(dm.CROSSBOW_ARROW_SPEED, st.dist), crit: true }).map(o => ({ ...o, kind: 'projectile', pierce: cb.piercing || 0 }))
      return { dt: sw + 1, outs: scale(bucket(outs), q), use: tpl.id }
    }
    case 'xbow-load': {
      if (st.loadedOnce || !obs.los) return null
      const load = dm.crossbowChargeTicks(lvl(tpl.it, 'quick_charge'))
      const rocket = tpl.rocketStars > 0 && st.dist >= 6 && st.dist <= 34
      if (!rocket && !(tpl.arrows && st.dist >= 2.5 && st.dist <= 48)) return null
      const dt = sw + load + 1
      if (rocket) return { dt, outs: [{ p: P.pHit.firework, raw: dm.fireworkRaw(tpl.rocketStars, 1), kind: 'explosion' }], loaded: true }
      const q = P.pHit.arrow * Math.min(1, P.arrowRange / Math.max(P.arrowRange, st.dist))
      const outs = dm.arrowOutcomes({ speed: dm.arrowSpeedAt(dm.CROSSBOW_ARROW_SPEED, st.dist), crit: true }).map(o => ({ ...o, kind: 'projectile', pierce: lvl(tpl.it, 'piercing') }))
      return { dt, outs: scale(bucket(outs), q), loaded: true }
    }
    case 'bow': {
      if (!obs.los || st.dist < 2.5 || st.dist > 60) return null
      const shot = dm.bowShot(dm.BOW_FULL_TICKS)
      const q = P.pHit.arrow * Math.min(1, P.arrowRange / Math.max(P.arrowRange, st.dist))
      const outs = dm.arrowOutcomes({ speed: dm.arrowSpeedAt(shot.speed, st.dist), power: lvl(tpl.it, 'power'), crit: shot.crit }).map(o => ({ ...o, kind: 'projectile' }))
      return { dt: sw + dm.BOW_FULL_TICKS + 1, outs: scale(bucket(outs), q) }
    }
    case 'rod': {
      if (st.rodUsed || !obs.los || st.dist < 3.5 || st.dist > P.rodMax || foe.blocking) return null
      // Поплавок ~1.2–1.5 б/т: долетает за dist/1.3 тика + заброс; на зацепе — подсечка (тот же тик).
      const dt = sw + 2 + Math.ceil(st.dist / 1.3)
      const pulled = Math.max(2.2, st.dist * (1 - P.rodPullShare))
      return { dt, outs: [{ p: P.pHit.rod, raw: 0, kind: 'none', dist: pulled, pull: { v: 0.1 * st.dist * 0.5, ticks: P.rodPullTicks } }], attack: false, rod: true }
    }
    case 'trident': {
      if (st.tridentUsed || !obs.los || st.dist < 3 || st.dist > P.tridentRange) return null
      const it = tpl.it
      // Натяжение ≥ 10 тиков (TridentItem.releaseUsing), полёт 2.5 б/т с сопротивлением 0.99 — ~dist/2.4 тика.
      const dt = sw + 10 + Math.ceil(st.dist / 2.4)
      // Попадание падает с дальностью и его боковой скоростью (упреждение по видимому ходу, решатель bow.aim):
      // поперечный ход за время полёта сверх ~0.6 бл. (полрамки + ошибка упреждения) — вдвое меньше шанс за блок.
      const fly = Math.ceil(st.dist / 2.4)
      const drift = Math.max(0, (foe.lateral || 0) * fly - 0.6)
      const q = P.pHit.trident * Math.min(1, 10 / Math.max(10, st.dist)) / (1 + drift)
      const outs: any[] = [{ p: q, raw: 8, kind: 'projectile' }]
      if (lvl(it, 'channeling') && obs.storm && obs.foeSky) outs[0].bolt = 5
      return { dt, outs, tridentUsed: true }
    }
    case 'crystal':
    case 'anchor': {
      if (st.boomUsed) return null
      const a = tpl.at
      const power = tpl.kind === 'crystal' ? dm.CRYSTAL_POWER : dm.ANCHOR_POWER
      const raw = dm.explosionRaw({ power, dist: a.dist, seen: a.seen ?? 1, difficulty: obs.difficulty || 'normal' })
      return { dt: sw + (tpl.kind === 'crystal' ? P.crystalTicks : P.anchorTicks), outs: [{ p: P.pHit[tpl.kind], raw, kind: 'explosion', angle: a.angle }], boom: true }
    }
  }
  return null
}

// Удар по нему в момент t: щит → неуязвимость → защита. Возвращает прошедший урон и новое состояние щита/окна.
function land (st, o, t, def) {
  if (!(o.raw > 0)) return { d: 0, iframe: st.iframe, shieldOffUntil: st.shieldOffUntil }
  const ago = st.iframe ? t - st.iframe.at : Infinity
  const last = st.iframe ? { raw: st.iframe.raw, ago } : null
  const raised = st.shieldUp && t >= st.shieldOffUntil
  if (dm.shieldBlocks({ raised, angle: o.angle ?? st.shieldAngle, kind: o.kind, piercing: o.pierce || 0 })) {
    // Щит гасит всё; Paper (computeAmountFromEntityDamageEvent: BASE + BLOCKING) ставит окно с lastHurt 0.
    const it = dm.throughIframes(0, last)
    return { d: 0, iframe: it.fresh ? { raw: 0, at: t } : st.iframe, shieldOffUntil: o.disables ? t + dm.AXE_DISABLE_TICKS : st.shieldOffUntil }
  }
  const it = dm.throughIframes(o.raw, last)
  const iframe = it.fresh ? { raw: o.raw, at: t } : (it.raw > 0 ? { raw: o.raw, at: st.iframe.at } : st.iframe)
  let d = dm.afterDefense(it.raw, o.kind, def, { breach: o.breach || 0 })
  // Молния «Громовержца» после попадания трезубцем (post_attack): своим источником, в том же тике — сверх окна
  // неуязвимости только превышение 5 над уроном трезубца (обычно 0); поджог 8 с — on_fire мимо брони, ~1 за 20 т:
  // в горизонт плана идёт как +2 (тушение водой/огнестойкость не видны заранее).
  if (o.bolt) d += 2
  return { d, iframe, shieldOffUntil: st.shieldOffUntil }
}

// ---------------------------------------------------------------- P(убить)

// Ветка плана: удары { t, d } по времени. Убит к удару i, если Σd − регенерация·t ≥ ЭХП. С тотемом —
// первый «смертельный» удар j срабатывает тотемом (излишек пропадает), дальше нужно ≥ 1 + 8 поглощения +
// Регенерация II (+1 за 25 тиков) от j.
function pKillHits (hits, est, totem, T) {
  const regen = est.exact ? 0 : REGEN_MEAN
  let S = 0; let best = -Infinity
  const A = []
  for (const h of hits) {
    if (h.t > T) break
    S += h.d
    A.push(S - regen * h.t)
  }
  if (!A.length) return 0
  if (!totem) {
    for (const a of A) best = Math.max(best, a)
    return cdf(est, best)
  }
  const second = dm.TOTEM.hp + dm.TOTEM.absorption
  const ri = dm.regenInterval(dm.TOTEM.regenAmp)
  let p = 0; let prevMax = -Infinity
  for (let j = 0; j < A.length; j++) {
    const curMax = Math.max(prevMax, A[j])
    const w = cdf(est, curMax) - (prevMax === -Infinity ? 0 : cdf(est, prevMax))
    prevMax = curMax
    if (w <= 0) continue
    let after = 0; let dead = false
    for (let i = j + 1; i < A.length && !dead; i++) {
      after += hits[i].d
      if (after >= second + Math.floor((hits[i].t - hits[j].t) / ri)) dead = true
    }
    if (dead) p += w
  }
  return p
}

// ---------------------------------------------------------------- поиск

function initState (obs) {
  const foe = obs.foe
  return {
    t: 0,
    held: obs.me.held ?? null,
    since: obs.me.since ?? 99,
    dist: obs.dist,
    shieldUp: !!foe.blocking,
    shieldAngle: foe.shieldAngle ?? 0,
    shieldOffUntil: foe.shieldOffTicks || 0,
    iframe: foe.iframe ? { raw: foe.iframe.raw, at: -foe.iframe.ago } : null,
    used: {},
    smashUsed: false,
    boomUsed: false,
    loadedOnce: false,
    rodUsed: false,
    tridentUsed: false,
    pullUntil: 0,
    pullV: 0
  }
}

function extend (node, tpl, obs, def, P) {
  const branches = []
  let any = false
  let firstDt = null
  let stepE = 0
  // Разброс урона шага при попадании — для trackFoe.noteAttack (подтверждённое попадание вычитается им).
  const range = { min: Infinity, max: 0, mean: 0, raw: 0, p: 0 }
  for (const b of node.branches) {
    const r = run(tpl, b.st, obs, P)
    if (!r) { branches.push(b); continue }
    any = true
    if (firstDt == null) firstDt = r.dt
    const t = b.st.t + r.dt
    const base = { ...b.st, t, held: tpl.item, dist: r.dist ?? b.st.dist }
    base.since = r.attack ? 0 : (b.st.held === base.held ? b.st.since + r.dt : Math.max(0, r.dt - P.switchTicks))
    if (r.use != null) base.used = { ...b.st.used, [r.use]: true }
    if (r.smash) base.smashUsed = true
    if (r.boom) base.boomUsed = true
    if (r.loaded) base.loadedOnce = true
    if (r.rod) base.rodUsed = true
    if (r.tridentUsed) base.tridentUsed = true
    let pLeft = 1
    for (const o of r.outs) {
      if (!(o.p > 0)) continue
      pLeft -= o.p
      const L = land(b.st, o, t, def)
      const st: any = { ...base, iframe: L.iframe, shieldOffUntil: L.shieldOffUntil }
      if (o.dist != null) st.dist = o.dist
      if (o.pull) { st.pullUntil = t + o.pull.ticks; st.pullV = o.pull.v }
      branches.push({ p: b.p * o.p, st, hits: L.d > 0 ? b.hits.concat({ t, d: L.d }) : b.hits })
      stepE += b.p * o.p * L.d
      if (L.d > 0) {
        const q = b.p * o.p
        range.min = Math.min(range.min, L.d); range.max = Math.max(range.max, L.d)
        range.mean += q * L.d; range.p += q; range.raw = Math.max(range.raw, o.raw)
      }
    }
    if (pLeft > 1e-9) branches.push({ p: b.p * pLeft, st: base, hits: b.hits })
  }
  if (!any) return null
  const hit = range.p > 0 ? { min: range.min, max: range.max, mean: range.mean / range.p, raw: range.raw, p: range.p } : null
  return { seq: node.seq.concat(tpl), steps: node.steps.concat({ tpl, dt: firstDt, E: stepE, hit }), branches }
}

function evaluate (node, est, obs, P) {
  const totem = !!obs.foe.totem
  let pKill = 0; let E = 0; let tEnd = 0
  for (const b of node.branches) {
    pKill += b.p * pKillHits(b.hits, est, totem, P.horizon)
    E += b.p * b.hits.reduce((s, h) => s + h.d, 0)
    tEnd += b.p * b.st.t
  }
  // Урон в секунду — с откатом последнего действия (иначе удар «сейчас» за 0 тиков — бесконечность).
  const last = node.seq[node.seq.length - 1]
  const recover = RECOVERS.has(last.kind) ? dm.attackDelayTicks(last.item) : last.kind === 'xbow' ? dm.crossbowChargeTicks(lvl(last.it, 'quick_charge')) : 0
  return { pKill, E, tEnd, dps: E / Math.max(1, tEnd + recover) * 20, expensive: node.seq.some(t => t.expensive) }
}
const RECOVERS = new Set(['melee', 'jab', 'axe-shield', 'smash'])

const better = (a, b) => {
  if (Math.abs(a.m.pKill - b.m.pKill) > 0.02) return a.m.pKill > b.m.pKill
  if (a.m.expensive !== b.m.expensive) return !a.m.expensive
  if (a.m.pKill >= DEFAULTS.minPKill && Math.abs(a.m.tEnd - b.m.tEnd) > 1) return a.m.tEnd < b.m.tEnd
  return a.m.dps > b.m.dps
}

// ---------------------------------------------------------------- опасность

// Его потенциальный урон по нам по видимому: оружие в руке (заряд 1, крит), булава с падения, копьё,
// заряженный арбалет (ракета/стрела), натянутый лук. Наша защита известна точно.
function dangerOf (obs, P = DEFAULTS) {
  const me = obs.me
  const foe = obs.foe
  const myDef = dm.defenseOf(me.armor || [], { resistance: me.resistance ?? -1 })
  const eff = foe.effects || {}
  const strength = eff.strength ? 0 : -1 // уровень по частицам не виден — берём I
  const weakness = eff.weakness ? 0 : -1
  const w = foe.main && foe.main.name
  const sharpness = lvl(foe.main, 'sharpness')
  const out = { melee: 0, smash: 0, ranged: 0, worst: 0, source: null, hitsToKillMe: Infinity, advise: 'trade', why: '' }
  const near = obs.dist <= P.reach + 0.28 * 10
  if (near) {
    const raw = dm.isSpear(w)
      ? Math.max(dm.jabRaw({ weapon: w, sharpness, strength, weakness, charge: 1 }), foe.using === w ? dm.spearChargeRaw({ weapon: w, sharpness, rel: Math.max(0, (foe.approach || 0) * 20) + P.runway }) : 0)
      : dm.meleeRaw({ weapon: w || null, sharpness, strength, weakness, charge: 1, crit: true })
    out.melee = dm.afterDefense(raw, 'melee', myDef)
    if (w === 'mace' && (foe.fallDistance || 0) > dm.SMASH_MIN) {
      out.smash = dm.afterDefense(dm.meleeRaw({ weapon: 'mace', fall: foe.fallDistance, charge: 1, density: lvl(foe.main, 'density'), strength, weakness }), 'melee', myDef, { breach: lvl(foe.main, 'breach') })
    }
  }
  const cb = [foe.main, foe.off].find(i => i && i.name === 'crossbow' && i.crossbow && i.crossbow.loaded)
  if (cb) {
    const c = cb.crossbow
    out.ranged = c.ammo === 'firework'
      ? dm.afterDefense(dm.fireworkRaw(c.stars || 0, 1), 'explosion', myDef)
      : dm.afterDefense(Math.max(...dm.arrowOutcomes({ speed: dm.CROSSBOW_ARROW_SPEED, crit: true }).map(o => o.raw)), 'projectile', myDef)
  }
  const bow = [foe.main, foe.off].find(i => i && i.name === 'bow')
  if (bow && foe.using === 'bow') {
    out.ranged = Math.max(out.ranged, dm.afterDefense(Math.max(...dm.arrowOutcomes({ speed: 3, power: lvl(bow, 'power'), crit: true }).map(o => o.raw)), 'projectile', myDef))
  }
  const list = [['melee', out.melee], ['smash', out.smash], ['ranged', out.ranged]].sort((a: any, b: any) => b[1] - a[1])
  out.worst = list[0][1] as number
  out.source = out.worst > 0 ? list[0][0] : null
  const ehp = me.ehp ?? 20
  out.hitsToKillMe = out.melee > 0 ? Math.ceil(ehp / out.melee) : Infinity
  if (out.worst >= ehp - 1) {
    const axe = out.source !== 'ranged' && dm.isAxe(w)
    const piercing = cb && cb.crossbow.piercing > 0 && out.source === 'ranged'
    if (me.hasShield && !axe && !piercing) { out.advise = 'shield'; out.why = `его ${out.source} до ${r1(out.worst)} ≥ моих ${r1(ehp)}: поднять щит` } else { out.advise = 'retreat'; out.why = `его ${out.source} до ${r1(out.worst)} ≥ моих ${r1(ehp)}${axe ? ' (топор выбьет щит)' : ''}: разорвать дистанцию` }
  } else out.why = out.worst > 0 ? `его лучший удар ${r1(out.worst)}, мне хватит на ${out.hitsToKillMe === Infinity ? '∞' : out.hitsToKillMe}` : 'угрозы не видно'
  return out
}

// ---------------------------------------------------------------- главное

function planAttack (obs, opts: any = {}) {
  const P = { ...DEFAULTS, ...opts, pHit: { ...DEFAULTS.pHit, ...(opts.pHit || {}) } }
  const est = obs.foe.hp || { lo: 20, hi: 20, mean: 20 }
  const def = dm.defenseOf(obs.foe.armor || [], { resistance: obs.foe.resistance ?? -1 })
  const tpls = catalog(obs)
  const done = []
  let frontier = [{ seq: [], steps: [], branches: [{ p: 1, st: initState(obs), hits: [] }] }]
  for (let depth = 0; depth < Math.max(1, Math.min(4, P.depth)); depth++) {
    const next = []
    for (const node of frontier) {
      for (const tpl of tpls) {
        const ext: any = extend(node, tpl, obs, def, P)
        if (!ext) continue
        ext.m = evaluate(ext, est, obs, P)
        next.push(ext)
        done.push(ext)
      }
    }
    next.sort((a, b) => (better(a, b) ? -1 : 1))
    frontier = next.slice(0, P.beam)
    if (!frontier.length) break
  }
  const danger = dangerOf(obs, P)
  if (!done.length) return { action: null, why: 'нечем бить', expected: 0, pKill: 0, plan: [], dps: 0, danger, hp: est }

  const all = done.slice().sort((a, b) => (better(a, b) ? -1 : 1))
  // Лучший план по каждому первому действию — граф боя (fight-graph) сравнивает приёмы между собой.
  const alts = []
  const seenKind = new Set()
  for (const n of all) {
    const k = n.seq[0].kind
    if (seenKind.has(k)) continue
    seenKind.add(k)
    const endDist = n.branches.reduce((s, br) => s + br.p * br.st.dist, 0)
    alts.push({ kind: k, item: n.seq[0].item, pKill: n.m.pKill, dps: n.m.dps, E: n.m.E, tEnd: n.m.tEnd, endDist, expensive: n.m.expensive, seq: n.seq.map(t => t.kind) })
  }
  let best = all[0]
  // Сильный расходник — только если без него шанс заметно хуже (кулак добивает — кристалл не тратим).
  const cheap = all.find(n => !n.m.expensive)
  if (best.m.expensive && cheap && cheap.m.pKill >= best.m.pKill - 0.05) best = cheap
  let pick = null; let why = ''
  // Добивание: гарантированный урон быстрого дешёвого действия (при попадании — самый слабый исход) больше
  // верха оценки — берём самое быстрое такое, если его шанс не хуже лучшего плана больше чем на 0.1.
  // С тотемом «гарантированно» не бывает.
  if (!obs.foe.totem) {
    let fin = null
    for (const n of done) {
      if (n.seq.length !== 1 || n.m.expensive || !n.steps[0].hit) continue
      const g = n.steps[0].hit.min
      if (!(g > est.hi) || n.m.pKill < best.m.pKill - 0.1) continue
      if (!fin || n.steps[0].dt < fin.steps[0].dt || (n.steps[0].dt === fin.steps[0].dt && n.m.pKill > fin.m.pKill)) fin = n
    }
    if (fin) { pick = fin; why = `добиваю: ${label(fin.seq[0])} — не меньше ${r1(fin.steps[0].hit.min)} > верх оценки ${r1(est.hi)}` }
  }
  if (!pick && best.m.pKill >= P.minPKill) {
    pick = best
    const h = best.steps[0].hit
    const fin = !obs.foe.totem && h && h.min > est.hi ? `добиваю: ${label(best.seq[0])} — не меньше ${r1(h.min)} > верх оценки ${r1(est.hi)}; ` : ''
    why = `${fin}план: ${best.seq.map(label).join(' → ')}; P(убить за ${P.horizon} т) ${Math.round(best.m.pKill * 100)} %${obs.foe.totem ? ' (с тотемом)' : ''}`
  }
  if (!pick) {
    pick = done.filter(n => !n.m.expensive).sort((a, b) => b.m.dps - a.m.dps)[0] || all[0]
    why = `убить за ${P.horizon} т нельзя (оценка ${r1(est.lo)}–${r1(est.hi)}${obs.foe.totem ? ', тотем' : ''}) — максимум урона: ${pick.seq.map(label).join(' → ')}, ${r1(pick.m.dps)} хп/с`
  }
  let at = 0
  const plan = pick.steps.map(s => { at += s.dt || 0; return { kind: s.tpl.kind, item: s.tpl.item, variant: s.tpl.variant || null, at, expected: r1(s.E) } })
  const first = pick.steps[0]
  return {
    action: { kind: first.tpl.kind, item: first.tpl.item, variant: first.tpl.variant || null, ticks: first.dt, expensive: !!first.tpl.expensive, range: first.hit },
    why,
    expected: first.E,
    pKill: pick.m.pKill,
    plan,
    dps: pick.m.dps,
    danger,
    hp: est,
    alts
  }
}

module.exports = { planAttack, dangerOf, catalog, pKillHits, DEFAULTS }
