'use strict'
// Граф боя (S7d, 08.10): выбор приёма по цене и риску, а не порядком веток pvp.duel.
//
// Вход — наблюдение (combat-observe.observe: только видимое и оценка хп), план добивания kill-planner (короткие
// действия: удар, крит, топор по щиту, укол/разгон копья, булава, арбалет, лук, удочка, трезубец, кристалл, якорь)
// и длинные приёмы, которые pvp.ts проверил на выполнимость (таран копьём на элитрах, пике с булавой). Выход —
// какой приём сейчас лучший по «чистому урону в секунду»: (ожидаемый урон ему − ожидаемый урон себе − цена
// расходника) / время приёма, и разрешение веткам pvp.ts: ветка приёма исполняется, только если граф его
// не отверг (allow). Ближний бой мечом — запасной путь всегда.
//
// Цифры длинных приёмов — априори из нативных серий и уточняются опытом этого бота за сессию (счёт попыток,
// касаний и ударов о стену): s7f/s7k — касаний тарана 30 % (7/23), s7c5 — удар о стену 8 на 23 захода, урон о
// стену 8–13 (fly_into_wall: 10·Δv − 3). Пике булавой: e2e s7e — 20 ударов из 21 взлёта, 0 урона в 2 из 20.
import * as dm from './damage-model'

const r1 = (x) => Math.round(x * 10) / 10
const lvl = (it, k) => (it && it.ench && it.ench[k]) || 0

// ---------------------------------------------------------------- оружие ближнего боя

// Лучшее ближнее оружие по устойчивому урону в секунду против его брони: заряд 1, крит с долей pCrit (в 1.21 бой —
// заряд, а не клики), время — откат оружия. Щит поднят и топор есть — топор (выключит щит на 100 тиков:
// Item$Properties.axe Weapon(… 5.0 с)); копьё и булава — у своих веток (разгон/укол, падение).
function meleeChoice (obs, { pCrit = 0.8, pHit = 0.9 }: any = {}) {
  const def = dm.defenseOf(obs.foe.armor || [], { resistance: obs.foe.resistance ?? -1 })
  const me = obs.me || {}
  const strength = me.strength ?? -1
  const weakness = me.weakness ?? -1
  const items = (me.items || []).filter(i => i && dm.isMeleeWeapon(i.name) && !dm.isSpear(i.name) && i.name !== 'mace' && i.name !== 'trident')
  let best = null
  for (const it of items) {
    const base = { weapon: it.name, sharpness: lvl(it, 'sharpness'), strength, weakness, charge: 1 }
    const crit = dm.afterDefense(dm.meleeRaw({ ...base, crit: true }), 'melee', def)
    const plain = dm.afterDefense(dm.meleeRaw(base), 'melee', def)
    const per = pHit * (pCrit * crit + (1 - pCrit) * plain)
    const cd = dm.attackDelayTicks(it.name)
    const dps = per / Math.max(1, cd) * 20
    if (!best || dps > best.dps + 1e-9) best = { item: it.name, dps: r1(dps), perHit: r1(per), cd }
  }
  const axe = items.filter(i => dm.isAxe(i.name)).sort((a, b) => dm.attackSpeed(b.name) - dm.attackSpeed(a.name))[0]
  if (obs.foe.blocking && axe && !(obs.foe.shieldOffTicks > 0)) return { item: axe.name, why: 'топор по щиту: выключит щит на 5 с', shield: true, dps: best ? best.dps : 0 }
  return best ? { ...best, why: `лучший урон в секунду: ${best.item} ${best.dps} хп/с (${best.perHit} за удар)` } : null
}

// ---------------------------------------------------------------- длинные приёмы: априори + опыт

const PRIOR = {
  // [попыток, удач] — Бета-сглаживание: (удач + a)/(попыток + a + b).
  // crash: s7c5 8/23 — до floorBelow/rollout; показ 09.10 — 1 удар о пол на ~35 заходов (−6): априори 3/23.
  lance: { hit: [7, 23], crash: [3, 23], ticks: 90, crashDmg: 11 },
  dive: { hit: [20, 21], crash: [2, 21], ticks: 70, crashDmg: 6 }
}
function experience (store, kind) {
  const p = PRIOR[kind]
  const e = (store && store[kind]) || { tries: 0, hits: 0, crashes: 0 }
  const pHit = (e.hits + p.hit[0]) / (e.tries + p.hit[1])
  const pCrash = (e.crashes + p.crash[0]) / (e.tries + p.crash[1])
  return { pHit, pCrash, ticks: p.ticks, crashDmg: p.crashDmg, tries: e.tries }
}
function noteExperience (store, kind, { hit = false, crash = false }: any = {}) {
  if (!store || !PRIOR[kind]) return
  const e = store[kind] || (store[kind] = { tries: 0, hits: 0, crashes: 0 })
  e.tries++
  if (hit) e.hits++
  if (crash) e.crashes++
}

// Таран копьём: урон разгона = 1 + floor(rel·mult) (KineticWeapon), rel ≈ 1.5 б/т = 30 бл/с полёта под ракетой.
function lanceOption (obs, spearName, store) {
  const spec = (require('../spear') as typeof import('../spear')).SPEARS[spearName]
  if (!spec) return null
  const def = dm.defenseOf(obs.foe.armor || [], { resistance: obs.foe.resistance ?? -1 })
  const raw = 1 + Math.floor(30 * spec.mult)
  const x = experience(store, 'lance')
  // Щит поднят — копьё он держит (BlocksAttacks 90°): касание без урона.
  const dmg = obs.foe.blocking ? 0 : x.pHit * dm.afterDefense(raw, 'melee', def)
  // В воздухе его ближнее оружие меня не достаёт (показ 09.10: таран проигрывал мечу, хотя на земле он рубит в ответ) —
  // избегнутый урон его видимого оружия ближнего боя за время захода; лук/трезубец/арбалет — не ближнее, 0.
  const his = obs.foe.main ? meleeChoice({ me: { items: [obs.foe.main] }, foe: { armor: (obs.me && obs.me.armor) || [] } }) : null
  const avoided = his ? his.dps * x.ticks / 20 : 0
  return { kind: 'lance', dmg: dmg + avoided, self: x.pCrash * x.crashDmg, cost: 1.5, ticks: x.ticks, why: `таран: касание ${Math.round(x.pHit * 100)} %, удар о стену ${Math.round(x.pCrash * 100)} %, его меч не достаёт ${r1(avoided)}` }
}
// Пике с булавой с элитр: высота h — бонус булавы (MaceItem: 4h до 3, …), щит держит, топор+булава — «оглушающий».
function diveOption (obs, h, store) {
  const def = dm.defenseOf(obs.foe.armor || [], { resistance: obs.foe.resistance ?? -1 })
  const mace = (obs.me.items || []).find(i => i && i.name === 'mace')
  if (!mace) return null
  const raw = dm.meleeRaw({ weapon: 'mace', fall: h, charge: 1, density: lvl(mace, 'density') })
  const x = experience(store, 'dive')
  const dmg = x.pHit * dm.afterDefense(raw, 'melee', def, { breach: lvl(mace, 'breach') })
  return { kind: 'dive', dmg, self: x.pCrash * x.crashDmg, cost: 1, ticks: x.ticks, why: `пике с ${Math.round(h)} бл.: удар ${Math.round(x.pHit * 100)} %` }
}

// ---------------------------------------------------------------- решение

// options — длинные приёмы [{ kind, dmg, self, cost, ticks, why }]; plan — planAttack(obs).
function decide (obs, plan, options: any[] = [], { margin = 0.15 }: any = {}) {
  const scores = []
  // База — план калькулятора: его первый шаг и урон в секунду; размен вблизи стоит его урона по мне.
  // Каждое первое действие калькулятора — своя строка (лучший план, начинающийся с него): удочка против удара,
  // трезубец против арбалета и т. п. Выбор калькулятора (добивание, «расходник только если заметно лучше») — сверху.
  const alts = plan && plan.alts && plan.alts.length ? plan.alts : (plan && plan.action ? [{ kind: plan.action.kind, item: plan.action.item, pKill: plan.pKill, dps: plan.dps }] : [])
  // Сравнение на общем горизонте T (60 т): урон плана + после его конца — устойчивый урон мечом, если план кончается
  // вплотную (≤ 3.2 бл.). Без этого «подготовка» (удочка, зарядка арбалета) проигрывала ударам только из-за глубины
  // плана в 3 действия. Урон по мне вблизи — у всех коротких приёмов одинаков и в сравнение между ними не входит.
  const T = 60
  const sustain = (() => { const m = meleeChoice(obs); return m ? m.dps : 0 })()
  for (const a of alts) {
    const chosen = plan && plan.action && plan.action.kind === a.kind
    const tail = a.E != null && a.tEnd != null && a.endDist != null && a.endDist <= 3.2 ? sustain * Math.max(0, T - a.tEnd) / 20 : 0
    const perSec = a.E != null && a.tEnd != null ? (a.E + tail) / (Math.max(T, a.tEnd) / 20) : (a.dps || 0)
    const value = perSec + (a.pKill || 0) * 4 + (chosen ? 0.01 : 0)
    scores.push({ kind: a.kind, item: a.item, value: r1(value), dps: r1(a.dps || 0), self: 0, why: chosen ? plan.why : (a.seq || []).join('→'), plan: true })
  }
  for (const o of options) {
    if (!o) continue
    const sec = Math.max(1, o.ticks) / 20
    // Его урон по мне не входит ни в короткие приёмы, ни в длинные (в воздухе он стреляет, на земле бьёт) — сравнение
    // по моему урону минус урон себе от самого приёма (удар о стену, падение) и цене расходников.
    const value = (o.dmg - o.self - o.cost) / sec
    scores.push({ kind: o.kind, value: r1(value), dps: r1(o.dmg / sec), self: r1(o.self), why: o.why })
  }
  scores.sort((a, b) => b.value - a.value)
  const top = scores[0] || null
  const allowed = new Set(scores.filter(s => top && s.value >= top.value - Math.max(margin, Math.abs(top.value) * margin)).map(s => s.kind))
  return {
    pick: top ? top.kind : null,
    why: top ? `${top.kind}: ${top.value} хп/с (${top.why || ''})` : 'нечего',
    scores,
    // Короткие приёмы плана (удар, топор, копьё…) исполняют ветки боя как раньше; длинные и дорогие — только по графу.
    allow: (kind) => !top || allowed.has(kind) || !scores.some(s => s.kind === kind),
    plan
  }
}

// ---------------------------------------------------------------- комбо (телеметрия)

// Класс приёма по метке used() боя: цепочки «A → B», после которых его хп упало (≤ 1.5 с от последнего звена).
const CLASSES: [RegExp, string][] = [
  [/он ставит/, 'реакция'], [/укрыт|колонн|столб|коробк|мост|ступен|заслон|блок(ом| между)|обсидиан вокруг|опору|стенк/, 'блоки'],
  [/удочк/, 'удочка'], [/топор|щит выбит|оглушающ/, 'топор'], [/таран|копьё к тарану/, 'таран'], [/разгон копь/, 'разгон'],
  [/укол/, 'укол'], [/булав|с падения|пике/, 'булава'], [/кристалл/, 'кристалл'], [/якор/, 'якорь'],
  [/арбалет|фейерверк|ракет/, 'арбалет'], [/трезуб|молни/, 'трезубец'], [/жемчуг/, 'жемчуг'], [/лук|стрел/, 'лук'],
  [/крит/, 'крит'], [/спринт-удар|рывок/, 'спринт-удар'],
  [/^удар$/, 'удар']
]
function classOf (label) {
  for (const [re, k] of CLASSES) if (re.test(label)) return k === 'реакция' ? null : k
  return null
}
function comboLog (now = () => Date.now()) {
  const seq = [] // [{ k, at }]
  const chains = {}
  const dmg = {}
  let lastKeys = null; let lastAt = -1e9
  return {
    note (label) {
      const k = classOf(String(label || ''))
      if (!k) return
      const t = now()
      const last = seq[seq.length - 1]
      if (last && last.k === k) { last.at = t; return }
      seq.push({ k, at: t })
      if (seq.length > 6) seq.shift()
    },
    // Его хп упало на amount (телеметрия): цепочка из звеньев не старше 3 с, последнее — ≤ 1.5 с.
    dealt (amount) {
      const t = now()
      // Одно попадание приходит частями (поглощение, потом хп) — в те же цепочки, без нового счёта.
      if (lastKeys && t - lastAt < 400) { for (const key of lastKeys) dmg[key] = r1((dmg[key] || 0) + amount); return }
      lastKeys = null
      const recent = seq.filter(x => t - x.at <= 3000)
      if (!recent.length || t - recent[recent.length - 1].at > 1500) return
      const tail = recent.slice(-3).map(x => x.k)
      const keys = []
      for (let i = 0; i < tail.length - 1; i++) {
        const key = tail.slice(i).join('→')
        chains[key] = (chains[key] || 0) + 1
        dmg[key] = r1((dmg[key] || 0) + amount)
        keys.push(key)
      }
      if (keys.length) { lastKeys = keys; lastAt = t }
    },
    report () { return Object.keys(chains).length ? { chains, dmg } : undefined }
  }
}

export { meleeChoice, lanceOption, diveOption, decide, experience, noteExperience, comboLog, classOf, PRIOR }
