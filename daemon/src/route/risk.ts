'use strict'
// Маршрут: учёт исхода шага, предел прерываний, цена копки и воды, риск шага, разведка, озёра лавы из увиденного.
import { DEATH_S } from './data'

/** Учёт исхода шага маршрута (S8b 07.10). Удачный шаг — в done; мягкие food/water — тоже done (еда ещё перед входом, вода — у
 *  литья); плавка — до трёх провалов, третий кончает маршрут ('break'); прочие провалы считаются, постройки/жилы/лава — сразу в
 *  avoid. Раньше цепочка была в campaign.ts и вставки «вода/еда по пути» её разорвали: удачный шаг попадал в ветки провала. */
export function bookStep (id: string, ok: unknown, book: { done: Set<string>, fails: Map<string, number>, avoid: Set<string> }): 'break' | null {
  if (ok || /^(food|water)$/.test(id)) { book.done.add(id); return null }
  const n = (book.fails.get(id) || 0) + 1
  book.fails.set(id, n)
  if (id === 'smelt') return n >= 3 ? 'break' : null
  if (n >= 2 || /^(ruin|village|treasure|ship|ore:|dig:|mine|ironStage|lava:|scoutLava|lookout|scoutIron|cave)/.test(id)) book.avoid.add(id)
  return null
}

// Шаг, N раз сорванный тактикой (S8d): постройка/разведка/вода — угроза у места постоянная, считать провалом; железо, кремень,
// литьё, вход — нет (их прерывают обычные мобы штрека/ночи, а без них маршрута нет).
export function interruptCap (kind: string, n: number, max = 3): boolean {
  return max > 0 && n >= max && /^(ruin|village|treasure|ship|water|cave|lookout|scoutLava|scoutIron)$/.test(kind)
}

// Копка/спуск маршрута при низком хп — цена против лечения, а не порог (S8b 07.10, замечание проверки д). Хвост потерь хп за
// одно действие (dig_down, mine камня/руды, mine_seen, tunnel, goto вниз на 3+; этап route, серии day05r/night05t/s8 —
// 6791 действие, 1 смерть): потерять ≥ h хп. Риск смерти = P(потеря ≥ хп) (Лаплас) × цена смерти графа (72000 т = 1 ч).
const DIG_LOSS = { n: 6791, tail: [[1, 72], [2, 56], [3, 35], [4, 22], [5, 4], [6, 4], [8, 2], [10, 2]] }
export function digRiskTicks (hp: number): number {
  // Осторожно: хвост для ближайшего h ≤ хп (P(потеря ≥ h) ≥ P(потеря ≥ хп)).
  const row = [...DIG_LOSS.tail].reverse().find(([h]) => h <= hp)
  const k = row ? row[1] : DIG_LOSS.n
  return Math.round((k + 0.5) / (DIG_LOSS.n + 1) * 72000)
}
// Лечение до 13: есть еда (или сытость ≥ 18) — съесть и регенерация ~1 хп/4 с (80 т); лечиться нечем — охота ~90 с и то же.
export function healTicks (hp: number, canEat: boolean): number {
  const need = Math.max(0, 13 - hp)
  return need === 0 ? 0 : (canEat ? 40 : 1800) + need * 80
}

// Отказ от копки сейчас: риск при нынешнем хп дороже, чем лечение до 13 плюс риск уже после него (при хп ≥ 13 лечить нечего —
// не отказ; S8b 07.10: без второго слагаемого хп 20 давал «риск 27 > лечение 0» — копка запрещалась всегда).
export function digRefuse (hp: number, canEat: boolean): { refuse: boolean, riskT: number, healT: number } {
  const riskT = digRiskTicks(hp), healT = healTicks(hp, canEat)
  return { refuse: riskT > healT + digRiskTicks(Math.max(hp, 13)), riskT, healT }
}

// Копка/спуск маршрута рядом с врагами, в воде — цена и риск вместо запретов (S8c 07.10, замечание проверки г; правило гибкости
// 06.10). Враги: их ожидаемый урон (assess.plan expectedDamage — если придётся снять всех) вычитается из хп, риск копки — от
// остатка (digRefuse); одиночный зомби при 20 хп копке не мешает, шипящий крипер или толпа — сперва ответ угрозе. Вода: копка
// с глазами в воде в 5 раз медленнее, не на земле — ещё /5 (Player.getDestroySpeed, jar 1.21.11) — ~10 с копки станут 50+,
// выйти на берег ~8 с: дешевле выйти; спуск goto — не копка, в воде идёт как есть. Завалило — физически: сначала откопаться.
// S8d (замечание проверки S8c «г»): в воде — цена, а не константы (было 40 > 8 — копка в воде отклонялась всегда). Лишнее время
// копки = блоков × 0.75 с (каменная кирка: камень 0.6 с + шаг) × 4 (×5 в воде); выход = 2 с + до берега / 2.2 м/с (плавание
// ~2.2 м/с, jar: в воде 0.02/тик ускорения при сопротивлении 0.8). Берег не измерен — 10 бл., объём не назван — 10 блоков.
const DIG_BLOCK_S = 0.75, SWIM_MS = 2.2
export function waterDigPrice (digBlocks?: number, shoreDist?: number) {
  const blocks = Number.isFinite(digBlocks) && digBlocks > 0 ? digBlocks : 10
  const shore = Number.isFinite(shoreDist) && shoreDist >= 0 ? shoreDist : 10
  return { extraS: Math.round(blocks * DIG_BLOCK_S * 4 * 10) / 10, leaveS: Math.round((2 + shore / SWIM_MS) * 10) / 10 }
}
export function routeActRisk ({ hp, canEat, foeDamage = 0, inWater = false, digging = false, buried = false, digBlocks, shoreDist }: { hp: number, canEat: boolean, foeDamage?: number, inWater?: boolean, digging?: boolean, buried?: boolean, digBlocks?: number, shoreDist?: number }): { refuse: boolean; why: string; riskT?: number; healT?: number } {
  if (buried) return { refuse: true, why: 'завалило — сперва откопаться' }
  const hpEff = Math.max(0, hp - (foeDamage || 0))
  const r = digRefuse(hpEff, canEat)
  if (r.refuse) return { ...r, refuse: true, why: `хп ${Math.round(hp)}${foeDamage ? ` − урон врагов ${Math.round(foeDamage)}` : ''}: риск ${r.riskT} т > лечение ${r.healT} т` }
  if (inWater && digging) {
    // ND_ROUTE_WATERPRICE=0 — прежнее: копка в воде — всегда отказ (константы 40 > 8).
    const w = process.env.ND_ROUTE_WATERPRICE === '0' ? { extraS: 40, leaveS: 8 } : waterDigPrice(digBlocks, shoreDist)
    if (w.extraS > w.leaveS) return { ...r, refuse: true, why: `в воде: копка ×5 (+${w.extraS} с) дороже выхода (~${w.leaveS} с)` }
  }
  return { ...r, refuse: false, why: '' }
}
// Объём копки действия (блоков) — для цены копки в воде: mine count, dig_down depth (лесенка — 3 блока на ступень), tunnel
// length × 2, mine_seen — жила ~4.
export function digBlocksOf (method: string, params: any = {}): number {
  if (method === 'mine') return Math.max(1, Number(params.count) || 1)
  if (method === 'dig_down') return Math.max(1, Number(params.depth) || 5) * (params.mode === 'stairs' ? 3 : 1)
  if (method === 'tunnel') return Math.max(1, Number(params.length) || 8) * (params.direction === 'down' || params.direction === 'up' ? 1 : 2)
  if (method === 'mine_seen') return 4
  return 10
}

// Ночной отрезок разведки поверху (S8d, замечание «г»: scoutLava/scoutIron ночью — жёсткий отказ → цена). Цена = время отрезка +
// риск × цена смерти. Риск ночного отрезка поверху — априор 0.05 при 20 хп без щита (S8c: смерти вслепую 25 %, из них половина —
// ночью поверху за 3–4 мин ходьбы ≈ 6 отрезков), ×20/хп, щит ×0.6; днём — 0.005. Подземная альтернатива (лестница и штреки со
// слухом) — 150 с и риск 0.02 (пещеры). Возвращает { surface: цена поверху, under: цена под землёй, pick }.
export function scoutLegPrice ({ night, hp = 20, shield = false, legS = 60 }: { night: boolean, hp?: number, shield?: boolean, legS?: number }) {
  const risk = night ? Math.min(0.5, 0.05 * 20 / Math.max(1, hp) * (shield ? 0.6 : 1)) : 0.005
  const surface = Math.round(legS + risk * DEATH_S)
  const under = Math.round(150 + 0.02 * DEATH_S)
  return { surface, under, risk: Math.round(risk * 1000) / 1000, pick: surface <= under ? 'surface' : 'under' }
}

// Лава в памяти глаз → озёра (S8d). Клетки связаны, если ближе 2 бл. (Чебышёв); у кластера «зеркало» — число клеток на самом
// людном уровне y: у озера их много, у лавопада из одного источника — по одной-две на уровень. Литьё одним ведром берёт по
// источнику на блок рамы (cast1: до 10), у одиночной лавы «лавы в досягаемости всего 1» — castSky вслепую 0/5 в s8c-g.
// Вход: [{x,y,z}]; выход: [{x,y,z — клетка зеркала ближе к его центру, n — клеток, level — клеток на уровне, sky — y ≥ 58}],
// людные первыми.
export function lavaLakes (cells: { x: number, y: number, z: number }[]) {
  const pts = (cells || []).filter(c => c && Number.isFinite(c.x) && Number.isFinite(c.y) && Number.isFinite(c.z)).slice(0, 800)
  const parent = pts.map((_, i) => i)
  const find = i => { while (parent[i] !== i) { parent[i] = parent[parent[i]]; i = parent[i] } return i }
  for (let i = 0; i < pts.length; i++) {
    for (let j = i + 1; j < pts.length; j++) {
      const a = pts[i], b = pts[j]
      if (Math.abs(a.x - b.x) <= 2 && Math.abs(a.y - b.y) <= 2 && Math.abs(a.z - b.z) <= 2) parent[find(i)] = find(j)
    }
  }
  const groups = new Map()
  pts.forEach((p, i) => { const k = find(i); if (!groups.has(k)) groups.set(k, []); groups.get(k).push(p) })
  const out = []
  for (const g of groups.values()) {
    const byY = new Map()
    for (const p of g) byY.set(p.y, (byY.get(p.y) || 0) + 1)
    const [ly, level] = [...byY.entries()].sort((a, b) => b[1] - a[1] || a[0] - b[0])[0]
    const mirror = g.filter(p => p.y === ly)
    const cx = mirror.reduce((n, p) => n + p.x, 0) / mirror.length, cz = mirror.reduce((n, p) => n + p.z, 0) / mirror.length
    const c = mirror.sort((a, b) => Math.hypot(a.x - cx, a.z - cz) - Math.hypot(b.x - cx, b.z - cz))[0]
    out.push({ x: c.x, y: c.y, z: c.z, n: g.length, level, sky: c.y >= 58 })
  }
  return out.sort((a, b) => b.level - a.level || b.n - a.n)
}
