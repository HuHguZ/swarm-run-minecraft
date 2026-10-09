'use strict'
// Боевой калькулятор, часть 2 — оценка хп противника-ИГРОКА без его метаданных (пользователь, 06.10:
// точное хп игрока — чит, человек его не видит). Состояние — интервал [lo, hi] здоровья и отдельно
// поглощения, среднее и уверенность. Чистый модуль: события подаёт адаптер (combat-observe.ts).
//
// Вниз — только то, что видно: наши подтверждённые попадания (damage_event по нему в окне после удара),
// урон от видимых источников (лава, огонь, падение, взрыв). Вверх — видимое лечение (еда, зелья, тотем)
// и естественная регенерация в границах FoodData. Для мобов адаптер ставит точное хп (exact).
const dm = require('./damage-model')

const MAX_HP = 20
// FoodData (javap): saturatedRegenRate 10 — при сытости 20 и насыщении > 0 лечит min(насыщение, 6)/6 хп
// за 10 тиков; unsaturatedRegenRate 80 — при сытости ≥ 18 1 хп за 80 тиков. Его сытость не видна:
// верх растёт по быстрой, низ — по медленной. Вне наблюдений низ не растёт: лечение только возможно.
const REGEN_FAST = 1 / 10
const REGEN_SLOW = 1 / 80
// Быстрая регенерация тратит насыщение: FoodData.tick — лечение f = min(насыщение, 6)/6 хп и истощение 6·f, 4
// истощения = 1 насыщения → 1.5 насыщения за 1 хп. Насыщение ≤ 20 → не больше ~13.3 хп быстрой регенерации, дальше —
// медленная (S7d: без бюджета верх оценки за бой стоял 17–19 при его 2–5 — «за 10 с без попаданий уходит к 20» — и
// добивание «наверняка» не срабатывало). Видимая еда пополняет бюджет её насыщением (Foods).
const SAT_PER_HP = 1.5
const SAT_OF = { golden_apple: 9.6, enchanted_golden_apple: 9.6, cooked_beef: 12.8, cooked_porkchop: 12.8, cooked_mutton: 9.6, cooked_chicken: 7.2, bread: 6, baked_potato: 6, cooked_salmon: 9.6, cooked_cod: 6, carrot: 3.6, apple: 2.4, golden_carrot: 14.4 }

// Еда и зелья, которые лечат сразу или эффектом. Consumables.<clinit>: GOLDEN_APPLE — Поглощение I 2400 т,
// Регенерация II 100 т; ENCHANTED_GOLDEN_APPLE — Поглощение IV 2400 т, Регенерация II 400 т (+ Сопротивление,
// Огнестойкость 6000 т). Potions.<clinit>: healing — мгновенное лечение I, strong_healing — II;
// regeneration 900 т I, long_regeneration 1800 т I, strong_regeneration 450 т II.
// Обычная еда хп сразу не даёт — только насыщение, а его покрывает верхняя граница регенерации.
const FOOD = {
  golden_apple: { absorbAmp: 0, absorbTicks: 2400, regenAmp: 1, regenTicks: 100 },
  enchanted_golden_apple: { absorbAmp: 3, absorbTicks: 2400, regenAmp: 1, regenTicks: 400 }
}
const POTION = {
  healing: { heal: dm.instantHeal(0) },
  strong_healing: { heal: dm.instantHeal(1) },
  regeneration: { regenAmp: 0, regenTicks: 900 },
  long_regeneration: { regenAmp: 0, regenTicks: 1800 },
  strong_regeneration: { regenAmp: 1, regenTicks: 450 }
}

const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v))

function createHpEstimate ({ hp = MAX_HP, absorption = 0, maxHp = MAX_HP }: any = {}) {
  const s = {
    lo: hp, hi: hp, mean: hp,
    aLo: absorption, aHi: absorption, aMean: absorption, aTicks: absorption > 0 ? Infinity : 0,
    regen: [] as any[], totems: 0, exact: false,
    satHp: 20 / SAT_PER_HP // сколько хп ещё может дать быстрая регенерация (насыщение неизвестно — берём полное)
  }

  function fix () {
    // Он жив — здоровье больше нуля: если наш «минимум урона» его превысил, значит он лечился невидимо.
    s.hi = clamp(s.hi, 0.5, maxHp)
    s.lo = clamp(s.lo, 0, s.hi)
    s.mean = clamp(s.mean, s.lo, s.hi)
    s.aLo = Math.max(0, s.aLo); s.aHi = Math.max(s.aLo, s.aHi); s.aMean = clamp(s.aMean, s.aLo, s.aHi)
  }

  // Урон после его брони: сначала поглощение, потом здоровье. Верх — по наименьшему урону и наибольшему
  // поглощению, низ — по наибольшему урону и наименьшему поглощению.
  function damage (dMin, dMax, dMean = (dMin + dMax) / 2) {
    const ah = Math.min(s.aHi, dMin); s.aHi -= ah; s.hi -= dMin - ah
    const al = Math.min(s.aLo, dMax); s.aLo -= al; s.lo -= dMax - al
    const am = Math.min(s.aMean, dMean); s.aMean -= am; s.mean -= dMean - am
    s.exact = false
    fix()
  }

  const api = {
    // Подтверждённое попадание: урон по нашей модели с разбросом (крит, неуязвимость) — { min, max, mean }.
    hit (r) { damage(r.min, r.max, r.mean ?? (r.min + r.max) / 2) },
    // Неподтверждённое (в его окне неуязвимости damage_event не приходит): может, прошло до max.
    maybeHit (max) { damage(0, max, 0) },
    // Урон от видимого источника (лава, огонь, падение, взрыв) — оценка интервалом.
    env (min, max) { damage(min, max) },
    heal (min, max) {
      s.lo += min; s.hi += max; s.mean += (min + max) / 2
      fix()
    },
    // AbsorptionMobEffect.onEffectStarted: поглощение = max(текущее, 4·(amp+1)).
    absorb (amp, ticks) {
      const a = dm.absorptionOfAmp(amp)
      s.aLo = Math.max(s.aLo, a); s.aHi = Math.max(s.aHi, a); s.aMean = Math.max(s.aMean, a)
      s.aTicks = Math.max(s.aTicks, ticks)
      fix()
    },
    regen (amp, ticks) { s.regen.push({ amp, ticks }) },
    // Тотем (событие сущности 35): здоровье 1, все эффекты сняты, Поглощение II, Регенерация II.
    totem () {
      const T = dm.TOTEM
      s.lo = s.hi = s.mean = T.hp
      s.aLo = s.aHi = s.aMean = T.absorption
      s.aTicks = T.absorptionTicks
      s.regen = [{ amp: T.regenAmp, ticks: T.regenTicks }]
      s.totems++
    },
    eat (name) {
      s.satHp = Math.min(20 / SAT_PER_HP, s.satHp + (SAT_OF[name] ?? 8) / SAT_PER_HP)
      const f = FOOD[name]
      if (!f) return false
      api.absorb(f.absorbAmp, f.absorbTicks)
      api.regen(f.regenAmp, f.regenTicks)
      return true
    },
    // Выпил зелье (видим предмет в руке и конец использования).
    drink (potion) {
      const p = POTION[potion]
      if (!p) return false
      if (p.heal) api.heal(p.heal, p.heal)
      else api.regen(p.regenAmp, p.regenTicks)
      return true
    },
    // Взрыв брошенного зелья рядом с ним: сколько дошло, зависит от расстояния (ThrownSplashPotion:
    // 1 − d/4) — низ не трогаем, верх — как полное.
    splash (potion) {
      const p = POTION[potion]
      if (!p) return false
      api.heal(0, p.heal || p.regenTicks / dm.regenInterval(p.regenAmp))
      return true
    },
    // Моб или телеметрия: хп известно точно.
    exact (hp, abs = 0) {
      s.lo = s.hi = s.mean = hp
      s.aLo = s.aHi = s.aMean = abs
      s.exact = true
    },
    tick (dt = 1, { visible = true }: any = {}) {
      if (!(dt > 0) || s.exact) return
      // Насыщение тратится только на лечение: верх у потолка — лечить нечего, бюджет цел (FoodData.tick лечит при
      // isHurt). Раньше бюджет таял за 6.7 с от начала боя и при полном хп.
      const fast = Math.min(dt * REGEN_FAST, s.satHp, Math.max(0, maxHp - s.hi))
      s.satHp -= fast
      const up = fast + (dt - fast / REGEN_FAST) * REGEN_SLOW
      s.hi += up
      const low = visible ? dt * REGEN_SLOW : 0
      s.lo += low
      s.mean += (up + low) / 2
      for (const r of s.regen) {
        const n = Math.min(dt, r.ticks) / dm.regenInterval(r.amp)
        if (visible) s.lo += n
        s.hi += n; s.mean += visible ? n : n / 2
        r.ticks -= dt
      }
      s.regen = s.regen.filter(r => r.ticks > 0)
      s.aTicks -= dt
      if (s.aTicks <= 0) { s.aLo = s.aHi = s.aMean = 0; s.aTicks = 0 }
      fix()
    },
    // ЭХП (здоровье + поглощение) — то, что надо снести; conf = 1 − ширина / maxHp.
    snapshot () {
      const lo = s.lo + s.aLo; const hi = s.hi + s.aHi
      return {
        lo, hi, mean: s.mean + s.aMean,
        conf: s.exact ? 1 : clamp(1 - (hi - lo) / maxHp, 0, 1),
        health: { lo: s.lo, hi: s.hi, mean: s.mean },
        absorption: { lo: s.aLo, hi: s.aHi, mean: s.aMean },
        regen: s.regen.length > 0,
        satHp: s.satHp,
        totems: s.totems,
        exact: s.exact
      }
    }
  }
  return api
}

// P(ЭХП ≤ x) по оценке: кусочно-линейно через (lo, 0), (mean, 0.5), (hi, 1). Точное — ступенька.
function cdf (est, x) {
  const { lo, hi } = est
  const mean = clamp(est.mean ?? (lo + hi) / 2, lo, hi)
  if (x < lo) return 0
  if (x >= hi) return 1
  if (x < mean) return mean > lo ? 0.5 * (x - lo) / (mean - lo) : 0.5
  return hi > mean ? 0.5 + 0.5 * (x - mean) / (hi - mean) : 1
}

module.exports = { createHpEstimate, cdf, REGEN_FAST, REGEN_SLOW, FOOD, POTION, MAX_HP }
