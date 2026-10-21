'use strict'
// Сколько очей уносить из Ада — ценой, а не воротами (координатор 21.10: цель 13, уход с 11–12 по цене).
// Модель 1.21.11: 12 рамок портала, в каждой око с шансом 10 % (EndPortalFrame при генерации комнаты); брошенное око
// (EyeOfEnder: surviveAfterDeath = nextInt(5) > 0) бьётся с шансом 20 %, уцелевшее бот подбирает (stronghold/throw.ts).
// Бросков в коде: поиск — от 2 до 4 (find.ts: стоп при ≥2 и уверенности 0.95), у крепости уточнение — с первого же
// броска, если око легло ближе 12 (endportal/go-steps refineByEye): типично 2 + 1 = 3, крепость известна — 1.
// Цены — замер потока ne 21.10 (46 прогонов сцены бастиона nbf45–nbf62, KIT=cgs):
//  · темп с золотом на руках — 4.4 мин/жемчуг: seek 87.7 мин, 251 слиток, 20 жемчуга (с ходьбой и пустыми заходами);
//  · добыча — +1.2 мин/жемчуг: 12 блоков (108 слитков ≈ 7 жемчуга по 0.064) за 5.7–9 мин от прибытия (5408 ×12);
//  · добор при нехватке — 24 мин: эндермены не добирают (искажённый лес 0 жемчуга за 15 мин ×2, end27 — 1 убит, 0 жемчуга,
//    2 смерти), значит снова Ад: дорога и бастион ~8 мин + 4.4 мин/жемчуг + обратный путь ≈ 18 мин, и смерть 30 % за 30 мин
//    Ада (14 из 46) — ~15 % за такой заход, цена провала — весь прогон (~60 мин): 0.85·18 + 0.15·60 ≈ 24.
// Торговать, пока ожидаемый добор, который снимет ещё одна жемчужина, дороже её цены сейчас.
const C = (n, k) => { let r = 1; for (let i = 0; i < k; i++) r = r * (n - i) / (i + 1); return r }
const binom = (n, k, p) => C(n, k) * p ** k * (1 - p) ** (n - k)

// Ожидаемая нехватка очей (сколько добирать) с eyes очами в руках и throws бросками; P — вероятность нехватки.
export function deficit (eyes: number, throws = 3, frames = 12) {
  let e = 0, p = 0
  for (let a = 0; a <= frames; a++) for (let b = 0; b <= throws; b++) {
    const w = binom(frames, a, 0.1) * binom(throws, b, 0.2)
    const d = Math.max(0, frames - a - (eyes - b))
    e += w * d
    if (d > 0) p += w
  }
  return { expected: e, pShort: p }
}

// Цель по очам: base — потолок (13 до крепости), have — уже есть; не ниже floor (11).
// paceMin — минут на следующую жемчужину сейчас; topupMin — минут на жемчужину добора.
export function eyesTarget ({ base, throws = 3, paceMin, topupMin = TOPUP_MIN, floor = 11 }: { base: number, throws?: number, paceMin: number, topupMin?: number, floor?: number }) {
  for (let n = Math.min(floor, base); n < base; n++) {
    const gain = (deficit(n, throws).expected - deficit(n + 1, throws).expected) * topupMin
    if (gain <= paceMin) return n
  }
  return base
}

// Темп следующей жемчужины: золото на руках — торг; нет, а в бастионе осталось — ещё и добыча; ничего — только добор той же
// ценой (уход сейчас не дороже).
export const TRADE_MIN = 4.4, MINE_MIN = 1.2, TOPUP_MIN = 24
export function paceMin ({ goldCarried, goldLeft, tradeMin = TRADE_MIN, mineMin = MINE_MIN, topupMin = TOPUP_MIN }: { goldCarried: number, goldLeft: number, tradeMin?: number, mineMin?: number, topupMin?: number }) {
  if (goldCarried >= 15) return tradeMin
  if (goldLeft > 0) return tradeMin + mineMin
  return topupMin
}
