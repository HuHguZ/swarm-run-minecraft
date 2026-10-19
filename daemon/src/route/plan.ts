'use strict'
// Маршрут: план (фазы planFirstSteps … planFinish), почему шаг, имя маршрута, строка для журнала.
import { asXZ, WORK, outpostNear, flat, SPEED, LOOT, GOLEM_DEATH_P, DEATH_S, structureSearchLeft, MINE_IRON_S, MINE_DEATH_P } from './data'
import { woodCandidates, pickLava, ironNeed, BUCKETS, orderPoints, foodHerds, bedCands } from './candidates'

// План маршрута: шаги дерева и камня, заходы за железом и огнём (постройки, руда, гравий) по цене, вода, лава, вход в Ад.
// Фазы — planFirstSteps (дерево, камень, вышка), planCandidates (лава, нужда в железе, кандидаты заходов), planChoose (выбор
// заходов по цене и бюджету построек), planSupplySteps (железо копкой, вёдра, огниво, еда, вода, литьё, вход), planFinish
// (кровать к ночи, брёвна под плавку, итог); общее — объект RoutePlan.
interface RoutePlan {
  info: any; opts: any; from: { x: number; z: number }; have: any; avoid: Set<string>; done: Set<string>; ok: (id: string) => boolean; steps: any[]
  bedAt?: number
  frame?: any; lava?: any; end?: { x: number; z: number }; iron?: number; lighter?: boolean; detour?: (at: any) => number; sc?: any
  inScan?: (at: any) => any; cand?: any[]
  ordered?: any[]; expect?: number; need?: number; short?: boolean; structureBudgetSeconds?: number
}

export function plan (info, opts: any = {}) {
  const from = asXZ(opts.from || info.spawn)
  const have = opts.have || {}
  const avoid = opts.avoid instanceof Set ? opts.avoid : new Set(opts.avoid || [])
  const done = opts.done instanceof Set ? opts.done : new Set(opts.done || [])
  const ok = id => !avoid.has(id) && !done.has(id)
  const steps = []
  if (opts.portal) return { seed: info.seed, lava: { kind: 'lit' }, ironNeed: 0, ironExpect: 0, short: false, steps: [{ id: 'enter', kind: 'enter', budget: WORK.enter, why: 'портал горит — в Ад' }], budget: WORK.enter, route: 'портал горит → вход' }
  const pc: RoutePlan = { info, opts, from, have, avoid, done, ok, steps }
  planFirstSteps(pc)
  planCandidates(pc)
  planChoose(pc)
  planSupplySteps(pc)
  return planFinish(pc)
}

function planFirstSteps (pc: RoutePlan): void {
  const { info, opts, from, have, ok, steps } = pc
  const logs = (Object.entries(have) as [string, any][]).filter(([k]) => /_(log|stem)$/.test(k)).reduce((n: any, [, v]) => n + v, 0)
  const pick = Object.keys(have).some(k => /_pickaxe$/.test(k))
  const stonePick = Object.keys(have).some(k => /^(stone|iron|diamond|netherite)_pickaxe$/.test(k))
  if (!pick && ok('wood')) {
    // Деревья по скану копии: ближняя роща (≥ 8 брёвен) — к ней, если рядом с телом деревьев нет (равнины: «не вижу
    // any_log в 48» и разведка на 2 мин — rt-S1 03.10, слот 29).
    const treesAll = (info.ores && Array.isArray(info.ores.trees) ? info.ores.trees : []).filter(t => !outpostNear(info, t, 8))
    let all = treesAll.filter(t => !Number.isFinite(opts.fromY) || Math.abs(t.y - (opts.fromY + 3)) <= 8)
    // Своей высоты деревьев нет в 160 м, а выше/ниже — есть (−4303…: равнина у спавна, все деревья на горе в 60–90 м, на 40–55
    // выше; без них — «дома деревни», которых не видно, и 4×120 с разведки вслепую, s8-f1-7/f2-7) — те, что есть.
    const anyY = process.env.ND_ROUTE_TREEANYY !== '0' && !all.some(t => flat(from, t) <= 160) && treesAll.some(t => flat(from, t) <= 160)
    if (anyY) all = treesAll.filter(t => flat(from, t) <= 160)
    const trees = all.filter(t => t.n >= 8).sort((a, b) => flat(from, a) - flat(from, b))
    // Аванпост рядом со спавном — роща подальше от него, даже если деревья тут есть (пиллагеры бьют с 15+ бл.).
    const nearAny = all.some(t => t.n >= 4 && flat(from, t) <= 40) && !outpostNear(info, from, 24)
    let grove = !nearAny && trees[0] && flat(from, trees[0]) <= 160 ? trees[0] : null
    // Только чужой высоты и мелкие (n 4–7) — ближняя по дороге с подъёмом (2 с на блок высоты), не дома деревни.
    if (!grove && anyY) grove = all.filter(t => t.n >= 4).sort((a, b) => flat(from, a) + 2 * Math.abs(a.y - (opts.fromY + 3)) - flat(from, b) - 2 * Math.abs(b.y - (opts.fromY + 3)))[0] || null
    // Рощи нет ближе 100 м (24 % сканированных сидов пула: пустыня, океан, степь) — дерево из построек (правило
    // пользователя: ресурсы сначала из построек): деревня ближе 260 м — брёвна/доски её домов (rt3-A1 слоты 16, 17: брёвна
    // искались вслепую 8–11 мин, смерти).
    let src = null
    if (!nearAny && (!grove || flat(from, grove) > 100) && info.village && flat(from, info.village) <= 260 && !outpostNear(info, info.village) && process.env.ND_ROUTE_VWOOD !== '0') {
      const vch = info.ores && (info.ores.chests || []).filter(c => /^village\//.test(c.table) && flat(c, info.village) <= 96).sort((a, b) => flat(from, a) - flat(from, b))[0]
      grove = vch ? { x: vch.x, y: vch.y, z: vch.z, n: 0 } : { x: info.village.x, y: undefined, z: info.village.z, n: 0 }
      src = 'village'
    }
    if (process.env.ND_ROUTE_WOODMAP !== '0') {
      const mapped = woodCandidates(info, from, opts.fromY)[0]
      if (mapped && (mapped.in || !grove)) { grove = { ...mapped, ...(mapped.stand || {}) }; src = 'mapwood' }
    }
    steps.push({ id: 'wood', kind: 'wood', ...(grove ? { at: { x: grove.x, y: grove.y, z: grove.z }, d: Math.round(flat(from, grove)) } : {}), ...(src ? { src } : {}), ...(grove && grove.in ? { in: grove.in } : {}), budget: WORK.wood + (grove ? Math.round(flat(from, grove) / SPEED) : 0), why: `брёвна, верстак, деревянная кирка${src === 'village' ? ' (рощ рядом нет — дома деревни по карте)' : grove ? ` (роща ${grove.n} брёвен по карте)` : ''}` })
  }
  if (!stonePick && ok('stone')) steps.push({ id: 'stone', kind: 'stone', budget: WORK.stone, why: 'каменная кирка, меч, печь, блоки на литьё' })
  // Вслепую — осмотр со столба (+10) после камня: над лесом и холмом видно постройки, лаву и воду в 128 бл. (как раннер лезет
  // на дерево/холм), один раз. ND_ROUTE_LOOKOUT=0 — выкл.
  if (info.map === 'blind' && ok('lookout') && process.env.ND_ROUTE_LOOKOUT !== '0') steps.push({ id: 'lookout', kind: 'lookout', budget: 30, why: 'осмотр со столба: постройки, лава, вода в 128 бл.' })
  void logs
  // Шаг кровати встаёт сразу после камня (меч есть) — место в списке шагов запоминаем здесь.
  const bedAt = steps.length
  pc.bedAt = bedAt
}

function planCandidates (pc: RoutePlan): void {
  const { info, opts, from, have, avoid, ok } = pc
  // Готовая рама без огня (opts.frame, campaign castOneAt) — не новая лава, а огонь и поджиг её (шаг light).
  const frame = opts.frame && ok('light') ? opts.frame : null
  const lava = frame ? { kind: 'frame', id: 'light', at: { x: frame.x, y: frame.y, z: frame.z } } : pickLava(info, from, { avoid })
  // Куда идём в конце: лава (или спавн, если вниз вслепую).
  const end = lava.at ? { x: lava.at.x, z: lava.at.z } : from
  let iron = ironNeed(have)
  // Огонь есть или будет из рюкзака: огниво/заряд, или кремень + слиток сверх вёдер (огниво — крафт на месте).
  const ingotsSpare = (have.iron_ingot || 0) + (have.raw_iron || 0) - 3 * Math.max(0, BUCKETS() - ((have.bucket || 0) + (have.water_bucket || 0) + (have.lava_bucket || 0)))
  const lighter = (have.flint_and_steel || 0) + (have.fire_charge || 0) > 0 || ((have.flint || 0) > 0 && ingotsSpare >= 1)
  // Кандидаты на заход: { id, kind, at, cost (крюк, с), gives }.
  const detour = at => (flat(from, at) + flat(at, end) - flat(from, end)) / SPEED
  const cand = []
  // Скан копии v2 знает сундуки построек (место и таблицу лута) и где постройки встали: место — сундук, нет сундука в
  // скане, а постройка внутри квадрата скана — её нет (cubiomes знает попытку). Вне квадрата — по seedtool.
  const sc = info.ores && info.ores.v >= 2 ? info.ores : null // v3: у руды ещё wet (вода/лава в ±3)
  const inScan = at => sc && sc.spawn && Math.abs(at.x - sc.spawn.x) <= (sc.half || 0) - 8 && Math.abs(at.z - sc.spawn.z) <= (sc.half || 0) - 8
  // Постройка вокруг сундука (по BB из скана): океанские руины и затонувший (не выброшенный на берег) корабль — под водой:
  // утопленники и воздух (rt-R0: 3 из 7 смертей — утопленники/утонул) — туда не ходим.
  const structAt = c => sc ? (sc.structures || []).find(t => Array.isArray(t.bb) && c.x >= t.bb[0] - 1 && c.x <= t.bb[3] + 1 && c.z >= t.bb[2] - 1 && c.z <= t.bb[5] + 1 && c.y >= t.bb[1] - 2 && c.y <= t.bb[4] + 2) : null
  const wet = c => { const t = structAt(c); return (c.wet || 0) > 2 || (!!t && (/ocean|underwater/.test(t.name) || (/^shipwreck$/.test(t.name)))) }
  const chestOf = (re, near, r = 48) => sc ? (sc.chests || []).filter(c => re.test(c.table) && (!near || flat(c, near) <= r) && !wet(c)).sort((a, b) => (near ? flat(a, near) - flat(b, near) : flat(from, a) - flat(from, b)))[0] || null : null
  if (info.rp && ok('ruin') && !(lighter && (have.obsidian || 0) >= 2)) {
    const ch0 = chestOf(/^ruined_portal$/, info.rp, 40)
    // Руины под землёй (сундук ниже 48: вариант underground) — в темноте пещеры мобы: rtV-A 14 сундук на y −43 (хп 20 →
    // 13, 3 захода), R7 29 скелет у руин в пещере на 11-й мин. Такие — мимо (ND_ROUTE_DEEPRUIN=1 — брать).
    // Скан v6 знает верх рельефа над сундуком (gy): глубже 20 под ним — тоже под землёй (rtV-A 15: сундук y49 под горой
    // y88–104). Полузасыпанные (≤ 20) — берём: на D1 таких 3 из 16, а глубоких 5 (огонь тогда — кремень).
    const under = c => c.y < 30 || (Number.isFinite(c.gy) && c.y < c.gy - 20)
    const ch = ch0 && under(ch0) && process.env.ND_ROUTE_DEEPRUIN !== '1' ? null : ch0
    if (ch0 && !ch) { /* руины под землёй — не заход */ } else if (ch) cand.push({ id: 'ruin', kind: 'ruin', at: { x: ch.x, z: ch.z }, y: ch.y, chest: true, work: WORK.ruin - 10, gives: LOOT.ruin })
    else if (!inScan(info.rp)) cand.push({ id: 'ruin', kind: 'ruin', at: { x: info.rp.x, z: info.rp.z }, work: WORK.ruin, gives: LOOT.ruin })
  }
  if (info.village && ok('village')) {
    const vch = sc ? (sc.chests || []).filter(c => /^village\//.test(c.table) && flat(c, info.village) <= 96) : []
    const smith = vch.filter(c => /weaponsmith|toolsmith|armorer/.test(c.table))
    const golem = sc ? (sc.golems || []).filter(g => flat(g, info.village) <= 96).sort((a, b) => flat(a, info.village) - flat(b, info.village))[0] : null
    const outside = !sc || !inScan(info.village)
    const there = outside || vch.length > 0 || golem
    const iron = (golem || outside ? LOOT.golem.iron : 0) + smith.reduce((n, c) => n + (/weaponsmith/.test(c.table) ? 1.4 : /toolsmith/.test(c.table) ? 1.0 : 1.2), 0)
    // Место — у голема (по скану), иначе у кузницы, иначе точка seedtool.
    const at = golem ? { x: golem.x, z: golem.z } : smith[0] ? { x: smith[0].x, z: smith[0].z } : { x: info.village.x, z: info.village.z }
    const golemRisk = (golem || outside) && process.env.ND_ROUTE_GOLEM_RISK !== '0' ? Math.round(GOLEM_DEATH_P * DEATH_S) : 0
    if (there && iron > 0) cand.push({ id: 'village', kind: 'village', at, ...(golem ? { y: golem.y } : {}), work: WORK.village + WORK.golem, risk: golemRisk, gives: { iron, ironMin: golem || outside ? LOOT.golem.ironMin : 0, food: 6, beds: true, smith: smith.map(c => c.table) } })
  }
  if (info.treasure && ok('treasure')) {
    const ch = chestOf(/^buried_treasure$/, info.treasure, 24)
    if (ch) cand.push({ id: 'treasure', kind: 'treasure', at: { x: ch.x, z: ch.z }, y: ch.y, work: WORK.treasure, gives: LOOT.treasure })
    else if (!inScan(info.treasure)) cand.push({ id: 'treasure', kind: 'treasure', at: { x: info.treasure.x, z: info.treasure.z }, work: WORK.treasure, gives: LOOT.treasure })
  }
  if (info.ship && ok('ship')) {
    const ch = chestOf(/^shipwreck_treasure$/, info.ship, 40)
    if (ch) cand.push({ id: 'ship', kind: 'ship', at: { x: ch.x, z: ch.z }, y: ch.y, work: WORK.ship, gives: { iron: 8, ironMin: 1, food: 1 } })
    else if (!inScan(info.ship)) cand.push({ id: 'ship', kind: 'ship', at: { x: info.ship.x, z: info.ship.z }, work: WORK.ship, gives: LOOT.ship })
  }
  // Руда у воздуха из скана копии (жила ≥ 3, не глубже 40 под рельефом): колодцем вниз у места (~1.2 с на уровень),
  // руда видна из пещеры, копка ~2 с на блок, назад наверх (~0.8 с на уровень).
  if (info.ores && Array.isArray(info.ores.iron)) {
    let k = 0
    for (const o of info.ores.iron) {
      const id = `ore:${o.x},${o.y},${o.z}`
      // Только руда, к которой идти пещерой от поверхности недалеко (скан v4: walk — шагов по воздуху от поверхности):
      // колодцы к пещерной руде вставали на воде водоносного слоя и кончались утопленниками (rt-R1: слоты 8, 14, 10).
      const walk = Number.isFinite(o.walk) ? o.walk : null
      if (!ok(id) || (o.n || 0) < 3 || (o.wet || 0) > 0) continue
      // rt-R1 (03:05): 7 смертей из 12 — все у пещерной руды глубже 17 бл. (утопленники в водоносном слое, скелеты,
      // крипер). Теперь только руда у самой поверхности (≤ 6 под рельефом) или пещера в 20 шагах от входа.
      if ((o.depth || 0) > 6 && (walk === null || walk > 20)) continue
      const st = o.stand || o
      // Риск пещеры (темно — мобы; rt-R1: 4 смерти из 12, все у пещерной руды) — к цене +90 с: голем со столба и сундуки
      // идут первыми, руда — добор.
      cand.push({ id, kind: 'ore', at: { x: st.x, z: st.z }, y: st.y, walk, depth: o.depth || 0, ore: { x: o.x, y: o.y, z: o.z }, work: 25 + (walk === null ? (o.depth || 0) * 2.2 : walk * 0.7) + Math.min(o.n, 10) * 2 + ((o.depth || 0) > 6 ? 90 : 0), gives: { iron: Math.min(o.n, 8) * 0.9, ironMin: Math.min(o.open || 1, 3) } })
      if (++k >= 16) break
    }
  }
  // Закрытая жила неглубоко (скан v6 ironBuried): свой колодец сверху (столбец без пещер), руда под ногами, назад своим
  // колодцем. Колодец ~2 с на уровень вниз и ~0.8 вверх; без пещер и воды по пути (проверено сканом). ND_ROUTE_DIG=0 — выкл.
  if (info.ores && Array.isArray(info.ores.ironBuried) && process.env.ND_ROUTE_DIG !== '0') {
    let k = 0
    for (const o of info.ores.ironBuried) {
      const id = 'dig:' + o.x + ',' + o.y + ',' + o.z
      if (!ok(id) || (o.n || 0) < 3 || flat(from, o) > 200) continue
      cand.push({ id, kind: 'ore', buried: true, at: { x: o.x, z: o.z }, y: o.y, depth: o.depth, top: o.top, ore: { x: o.x, y: o.y, z: o.z }, work: 20 + o.depth * 2.8 + Math.min(o.n, 8) * 2.5, gives: { iron: Math.min(o.n, 8) * 0.95, ironMin: Math.min(o.n, 3) } })
      if (++k >= 12) break
    }
  }
  Object.assign(pc, { frame, lava, end, iron, lighter, detour, sc, inScan, cand })
}

function planChoose (pc: RoutePlan): void {
  const { info, opts, from, steps, end, lighter, detour, cand } = pc
  let iron = pc.iron
  for (const c of cand) {
    c.cost = detour(c.at) + c.work
    c.d = Math.round(flat(from, c.at))
  }
  // Заходы в зону аванпоста — мимо (пиллагеры в коробке постройки появляются всё время и бьют с 15+ бл.).
  for (let i = cand.length - 1; i >= 0; i--) if (outpostNear(info, cand[i].at, 8)) cand.splice(i, 1)
  // Выбор: руины — если крюк ≤ 100 с (огонь, обсидиан — дешевле, чем кремень и литьё лишней клетки); железо — по цене
  // слитка (с), пока ожидаемого не хватит с запасом (×1.25), а гарантированного — хотя бы на ведро.
  const chosen = []
  // Руды по карте нет (уровень struct, вслепую) — железо иначе копкой: этап железа (strategy-costs 'iron': медиана 384 с при успехе
  // 34/63, ≈ 700 с на нужду; в базе s8c-a ironStage 330–540+ с). Бюджет построек 180 с — не запрет, а цена: постройка дешевле
  // копки — берём (S8c 07.10, правило гибкости; s8c-a: деревни в 150–350 м выпадали из плана при «осталось 180 с»).
  const oreKnown = cand.some(c => c.kind === 'ore')
  const structureBudgetSeconds = oreKnown ? structureSearchLeft(opts.structureSeconds) : Math.max(structureSearchLeft(opts.structureSeconds), MINE_IRON_S - Math.max(0, Number(opts.structureSeconds) || 0))
  const costCap = oreKnown ? 420 : MINE_IRON_S
  let structureLeft = structureBudgetSeconds
  const ruin = cand.find(c => c.kind === 'ruin')
  // Без огня — руины и подальше: кремень из гравия в rt-R3/R4 — 1 из 7 и 2 из 8 (гравий у рек под водой, «не вижу»),
  // а сундук руин даёт огниво или заряд в 73 %.
  if (ruin && ruin.cost <= structureLeft && (ruin.cost <= 100 || (!lighter && ruin.cost <= 260))) {
    chosen.push(ruin); structureLeft -= ruin.cost; iron -= ruin.gives.iron * 0.5
  }
  if (ruin && chosen.includes(ruin) && !lighter) iron -= LOOT.ruin.lighter // огонь из сундука снимает слиток на огниво
  const structuresFirst = process.env.ND_ROUTE_STRUCTURES_FIRST !== '0'
  const ironCand = cand.filter(c => c.kind !== 'ruin' && c.d <= (c.kind === 'ore' ? 160 : 360))
    .sort((a, b) => (structuresFirst ? Number(a.kind === 'ore') - Number(b.kind === 'ore') : 0) ||
      (a.cost + (a.risk || 0)) / Math.max(0.5, a.gives.iron) - (b.cost + (b.risk || 0)) / Math.max(0.5, b.gives.iron))
  let expect = 0
  let sure = 0
  const need = Math.max(0, iron)
  for (const c of ironCand) {
    if (expect >= need && sure >= Math.min(need - 1, 2)) break
    // Цена с риском (голем) — против копки с её риском (MINE_DEATH_P); бюджет поиска построек — только время.
    if (c.cost + (c.risk || 0) > costCap + (c.risk ? Math.round(MINE_DEATH_P * DEATH_S) : 0) || (c.kind !== 'ore' && c.cost > structureLeft)) continue
    chosen.push(c)
    if (c.kind !== 'ore') structureLeft -= c.cost
    expect += c.gives.iron
    sure += c.gives.ironMin || 0
  }
  // Не хватает и с этим — копать по пути (видимая руда), потом этап железа кампании (лесенка к y 16, штреки).
  const short = need > 0 && expect < need
  const ordered = orderPoints(from, chosen, end).order
  if (structuresFirst) ordered.sort((a, b) => Number(a.kind === 'ore') - Number(b.kind === 'ore'))
  for (const c of ordered) {
    steps.push({ id: c.id, kind: c.kind, at: { ...c.at, ...(c.y !== undefined ? { y: c.y } : {}) }, ...(c.ore ? { ore: c.ore, walk: c.walk, depth: c.depth, ...(c.buried ? { buried: true, top: c.top } : {}) } : {}), budget: Math.round(c.cost), d: c.d, gives: c.gives, why: whyOf(c) })
  }
  Object.assign(pc, { ordered, expect, need, short, structureBudgetSeconds })
}

function planSupplySteps (pc: RoutePlan): void {
  const { info, opts, from, have, ok, steps, frame, lava, end, lighter, detour, ordered, expect, need, short } = pc
  const needNow = ironNeed(have)
  const buckets = (have.bucket || 0) + (have.water_bucket || 0) + (have.lava_bucket || 0)
  // Железа в рюкзаке (с сырым и самородками) не хватает, а заходов за ним больше нет — копать; не вышло и это — этап
  // железа кампании; не вышло и он — маршрут кончается, дальше обычные этапы (giveup).
  const sourcesLeft = ordered.some(c => c.kind !== 'ruin')
  if (needNow > 0 && !sourcesLeft) {
    // Вслепую построек не видно — сперва разведка построек по пути (колокол, сундуки, structures scan; ≤ 150 с): деревня/корабль
    // дают железо за 1.5–3 мин, копка штреками вслепую — 3–17 мин (s8c-b/c: ironStage 163–1044 с). По умолчанию ВЫКЛ.
    // (ND_ROUTE_SCOUTIRON=1 — вкл.): s8c-d/e — 0 построек из 3 разведок по 150 с, осмотр со столба (lookout, 128 бл.) их уже видит.
    if (ok('mine')) steps.push({ id: 'mine', kind: 'mine', budget: 300, why: `железа ${needNow} не хватает — видимая руда в 48` })
    else if (info.map === 'blind' && ok('scoutIron') && process.env.ND_ROUTE_SCOUTIRON === '1') steps.push({ id: 'scoutIron', kind: 'scoutIron', budget: 150, why: 'построек не видно — разведка (до 150 с) до копки' })
    // Вслепую (S8d): как игрок — колодцем вниз до пещеры, войти в неё и брать руду в её стенах по виду (eyes), идя по пещере;
    // штреки 1×2 на y 16 (этап железа) — запасной путь. s8c-g (32 прогона вслепую): штреки 169 с/прогон, колодец выходил в
    // пещеру 31 раз из 32 и пещеру пропускал (из колодца 1×1 её не видно). ND_ROUTE_CAVE=0 — без шага.
    else if (info.map === 'blind' && ok('cave') && process.env.ND_ROUTE_CAVE !== '0') steps.push({ id: 'cave', kind: 'cave', budget: 240, why: `железа ${needNow} не хватает — пещера: руда в стенах по виду` })
    else if (ok('ironStage')) steps.push({ id: 'ironStage', kind: 'ironStage', budget: 600, why: `железа ${needNow} не хватает — этап железа (y 16)` })
    else steps.push({ id: 'giveup', kind: 'giveup', budget: 0, why: 'железа нет и не нашлось — дальше обычные этапы' })
  } else if (short && ok('mine') && !ordered.length) steps.push({ id: 'mine', kind: 'mine', budget: 300, why: `железа ожидается ${Math.round(expect * 10) / 10} из ${need} — руда по пути` })
  if (buckets < BUCKETS() && ok('smelt')) steps.push({ id: 'smelt', kind: 'smelt', budget: 60, why: BUCKETS() === 1 ? 'ведро' : 'вёдра' })
  // Огонь: огнива и заряда нет — кремень из гравия (10 % за блок): ближний гравий у воздуха из скана, иначе видимый.
  // Руины ещё впереди — огонь, скорее всего, будет оттуда (73 %), кремень — только если руины не дали.
  const ruinAhead = ordered.some(c => c.kind === 'ruin')
  if (!lighter && !ruinAhead && ok('flint')) {
    // Жила с открытыми гранями (open — клеток гравия у воздуха): у жилы с 1–2 открытыми клетками на 2–6 под рельефом тело
    // вставало у клетки скана и «не вижу gravel в 12» (rt3-A1 слоты 29, 18: кремень ✗ 73–112 с). Открытая и неглубокая — вперёд.
    const gScore = g => flat(from, g) + (g.depth || 0) * 8 - Math.min(g.open || 0, 40) * 1.5
    const grs = info.ores && Array.isArray(info.ores.gravel) ? info.ores.gravel.filter(g => (g.n || 0) >= 6 && (g.open || 0) >= 4 && (g.depth || 0) <= 6 && !(g.wet > 0) && flat(from, g) <= 200).sort((a, b) => gScore(a) - gScore(b)) : []
    // Открытого сухого гравия нет — закрытая залежь (скан v6 gravelBuried): свой колодец к ней, как к жиле железа.
    // Открытый — если дешевле: путь (2.5 м/с) + 30 с против пути + 3 с на уровень колодца + 40 с.
    const gb0 = info.ores && Array.isArray(info.ores.gravelBuried) && process.env.ND_ROUTE_DIGGRAVEL !== '0' ? info.ores.gravelBuried.filter(g => flat(from, g) <= 200 && !outpostNear(info, g, 8)).sort((a, b) => (flat(from, a) + a.depth * 7) - (flat(from, b) + b.depth * 7))[0] : null
    const gb = gb0 && (!grs.length || flat(from, gb0) / SPEED + gb0.depth * 3 + 40 < flat(from, grs[0]) / SPEED + 30) ? gb0 : null
    if (gb) {
      steps.push({ id: 'flint', kind: 'flint', buried: true, at: { x: gb.x, y: gb.top + 1, z: gb.z }, top: gb.top, ore: { x: gb.x, y: gb.y, z: gb.z }, n: gb.n, d: Math.round(flat(from, gb)), budget: 50 + Math.round(flat(from, gb) / SPEED) + gb.depth * 3, why: 'огниво: кремень из залежи гравия ' + gb.n + ' бл. в ' + gb.depth + ' под землёй (колодец)' })
    }
    const gat = gb ? null : (grs[0] || null)
    const alts = grs.slice(1, 4).map(g => ({ x: (g.stand || g).x, y: (g.stand || g).y, z: (g.stand || g).z }))
    if (!gb) steps.push({ id: 'flint', kind: 'flint', ...(gat ? { at: { x: (gat.stand || gat).x, y: (gat.stand || gat).y, z: (gat.stand || gat).z }, alts, d: Math.round(flat(from, gat)) } : {}), budget: 60 + (gat ? Math.round(flat(from, gat) / SPEED) : 120), why: `огниво: кремень из гравия${gat ? ` (гравий ${gat.n} по карте, запасных ${alts.length})` : ''}` })
  }
  if (ok('food')) {
    // Стадо съедобных по скану копии (звери при генерации стоят у места): крюк ≤ 60 с к самому дешёвому. Еды на входе в Ад
    // было 0 в 7 из 9 удачных (S8 07.10), а без еды ночью тело не лечится — смерти от пауков на 13–16 мин. Звери — знание
    // сущностей копии, не карты (правило: постройки и лава): только ND_ROUTE_FOODMAP=1 и отдельной строкой «со знанием стад»
    // (S8b 07.10); по умолчанию — звери по пути (видимость).
    const herd = process.env.ND_ROUTE_FOODMAP !== '1' ? null : foodHerds(info).filter(h => !outpostNear(info, h, 16) && (!Number.isFinite(opts.fromY) || Math.abs(h.y - opts.fromY) <= 16))
      .map(h => ({ h, c: detour(h) })).filter(x => x.c <= 60).sort((a, b) => a.c - b.c)[0]
    steps.push({ id: 'food', kind: 'food', ...(herd ? { at: { x: herd.h.x, y: herd.h.y, z: herd.h.z }, d: Math.round(flat(from, herd.h)) } : {}), budget: WORK.food + (herd ? Math.round(herd.c) : 0), why: `еды на вход ≥ 6 (${herd ? `стадо ${herd.h.n} по карте` : 'сено, звери по пути'})` })
  }
  if (ok('water') && !have.water_bucket && !frame) {
    // Вода с открытым верхом из скана: у лавы поверху (≤ 24) — литьё само зачерпнёт (cast.ensureWater), шаг не нужен;
    // иначе — источник с наименьшим крюком по пути к лаве (не подо льдом: у скана вода только с воздухом сверху).
    // Вода в зоне аванпоста — мимо (rt3-A5 слот 10: вода по карте в 68 м от аванпоста, сон там — пиллагер).
    const ws = info.ores && Array.isArray(info.ores.water) ? info.ores.water.filter(w => !outpostNear(info, w, 8)) : []
    const nearLava = lava.kind === 'sky' && lava.at && ws.some(w => flat(w, lava.at) <= 24)
    if (!nearLava) {
      const endW = lava.at || from
      const best = ws.map(w => ({ w, c: flat(from, w) + flat(w, endW) })).sort((a, b) => a.c - b.c)[0]
      // Крюк до 200 с; нет такой — ближняя вода карты в 250 м (rt3-V1: шаг воды без точки — разведка вслепую 43–92 с, ✗).
      const wat = best && best.c - flat(from, endW) <= 200 ? best.w : (ws.slice().sort((a, b) => flat(from, a) - flat(from, b)).find(w => flat(from, w) <= 250) || null)
      steps.push({ id: 'water', kind: 'water', ...(wat ? { at: { x: (wat.stand || wat).x, y: (wat.stand || wat).y, z: (wat.stand || wat).z }, d: Math.round(flat(from, wat)) } : {}), budget: WORK.water + (wat ? Math.round((flat(from, wat) + flat(wat, endW) - flat(from, endW)) / SPEED) : 30), why: `ведро воды на литьё${wat ? ' (вода по карте)' : ''}` })
    }
  }
  const travel = Math.round(flat(ordered.length ? ordered[ordered.length - 1].at : from, end) / SPEED)
  if (lava.kind === 'frame') steps.push({ id: 'light', kind: 'light', at: lava.at, budget: travel + 30, d: Math.round(flat(from, lava.at)), why: "готовая рама без огня — поджиг" })
  else if (lava.kind === 'sky') steps.push({ id: lava.id, kind: 'castSky', at: lava.at, budget: travel + WORK.castSky, d: Math.round(flat(from, lava.at)), why: `лава под небом (${lava.cls}, ${lava.tag}, источников ${lava.src ?? '?'}) — литьё поверху` })
  else if (lava.kind === 'cave') steps.push({ id: lava.id, kind: 'castCave', at: lava.at, budget: travel + WORK.castCave + Math.round((lava.depth || 0) * 2), d: Math.round(flat(from, lava.at)), why: `лава в пещере (${lava.cls}, ${lava.tag}, глубина ${lava.depth ?? '?'}, источников ${lava.src ?? '?'}) — вниз к ней и литьё с окнами` })
  // Вслепую лава не видна — разведка по виду (поверху, 96 бл.) и слуху, а не сразу глубокое литьё (castDeep: 0 из 34, 17 смертей, S8).
  else if (info.map === 'blind' && ok('scoutLava') && process.env.ND_ROUTE_SCOUTLAVA !== '0') steps.push({ id: 'scoutLava', kind: 'scoutLava', budget: 240, why: 'лава не видна — разведка поверху (взгляд 96 бл.) и слух' })
  else steps.push({ id: 'lava:deep', kind: 'castDeep', budget: 600, why: 'видимой лавы по карте нет — вниз к −54 (глубокое литьё)' })
  steps.push({ id: 'enter', kind: 'enter', budget: WORK.enter, why: 'в Ад' })
}

function planFinish (pc: RoutePlan): any {
  const { info, opts, from, have, ok, steps, bedAt, lava, end, sc, inScan, ordered, expect, need, short, structureBudgetSeconds } = pc
  // Кровать к ночи: нет кровати и 3 шерсти одного цвета, план до Ада не успевает до ~9-й мин — шаг bed после камня
  // (стадо или кровать постройки по карте, дешевле 240 с). Деревня с кроватями в плане до ~8-й мин — кровать оттуда.
  const bedOwned = Object.keys(have).some(k => /_bed$/.test(k)) || (Object.entries(have) as [string, any][]).some(([k, v]: any) => /_wool$/.test(k) && v >= 3)
  const elapsed = Number(opts.elapsed) || 0
  let bedStep = null
  // Кровать в маршруте — только ND_ROUTE_BED=1: в спидране сон запрещён (routeSleep при speedrun выходит), кровать — потеря
  // ~1.3 мин на прогон (night05t/day05r, S8 07.10).
  if (!bedOwned && ok('bed') && process.env.ND_ROUTE_BED === '1') {
    const total = steps.reduce((n, s) => n + (s.budget || 0), 0)
    let cum = elapsed
    let villageBy = Infinity
    for (const s of steps) { cum += s.budget || 0; if (s.kind === 'village') { villageBy = cum; break } }
    const villageBeds = villageBy <= 480 && (!sc || (sc.beds || []).some(b => /village/.test(b.in || '') && info.village && flat(b, info.village) <= 120) || !inScan(info.village))
    if (elapsed + total > 560 && !villageBeds) {
      const b = bedCands(info, from, ordered.length ? ordered[0].at : end)[0]
      if (b && b.cost <= 240) bedStep = { id: 'bed', kind: 'bed', how: b.how, at: b.at, ...(b.color !== undefined ? { color: b.color, n: b.n } : {}), ...(b.in ? { in: b.in } : {}), budget: b.cost, d: Math.round(flat(from, b.at)), why: b.how === 'sheep' ? `кровать: стадо ${b.n} овец цвета ${b.color} по карте` : `кровать: ${b.in || 'постройка'} по карте` }
    }
  }
  if (bedStep) steps.splice(bedAt, 0, bedStep)
  // Брёвна под плавку: в плане жила (сырое железо) — печи нужно топливо, а верстак/палки/кирки съедают 6 брёвен почти целиком
  // (s8-f4-5: «плавить raw_iron нечем: угля нет, а дерево — запас» ×3 → маршрут кончился; s8-f4-2: досок 3, нового верстака не
  // сделать). Без жилы (железо из сундуков/голема) — 6.
  const woodStep = steps.find(x => x.kind === 'wood')
  if (woodStep && !process.env.ND_ROUTE_WOODN && steps.some(x => x.kind === 'ore' || x.kind === 'mine' || x.kind === 'ironStage')) woodStep.logs = 8
  const budget = steps.reduce((n, s) => n + (s.budget || 0), 0)
  return { seed: info.seed, map: info.map, lava, ironNeed: need, ironExpect: Math.round(expect * 10) / 10, short, steps, budget, structureBudgetSeconds, route: routeName(steps) }
}

function whyOf (c) {
  if (c.kind === 'ruin') return `сундук руин: огонь ${Math.round(LOOT.ruin.lighter * 100)} %, обсидиан ~${LOOT.ruin.obsidian}, ${c.d} м`
  if (c.kind === 'village') return `деревня ${c.d} м: голем 3–5 железа, сено, кровати, сундуки${c.risk ? ` (риск голема ${c.risk} с против копки ${Math.round(MINE_DEATH_P * DEATH_S)} с)` : ''}`
  if (c.kind === 'treasure') return `клад ${c.d} м: железо ~9, рыба`
  if (c.kind === 'ship') return `корабль ${c.d} м: сундук сокровищ ~8 железа (если есть), еда`
  if (c.kind === 'ore' && c.buried) return 'жила железа в ' + c.depth + ' бл. под землёй, ' + c.d + ' м: колодец сверху, ~' + Math.round(c.gives.iron * 10) / 10 + ' железа'
  if (c.kind === 'ore') return `руда на виду ${c.d} м: ~${c.gives.iron} железа`
  return c.kind
}
// Короткое имя маршрута для журнала: A — руины + лава под небом, B — деревня + лава под небом, C — глубоко, …
export function routeName (steps) {
  const k = new Set(steps.map(s => s.kind))
  const lava = k.has('light') ? 'готовая рама' : k.has('castSky') ? 'небо' : k.has('castCave') ? 'пещера' : 'глубоко'
  const iron = ['village', 'treasure', 'ship', 'ore', 'mine'].filter(x => k.has(x))
  return `${k.has('ruin') ? 'руины + ' : ''}${iron.join('+') || 'без железа'} → лава: ${lava}`
}

// Строка для журнала: шаги с бюджетом.
export function describe (p) {
  return `маршрут [${p.route}]${p.map ? `, карта ${p.map}` : ""}, бюджет ${Math.round(p.budget / 60 * 10) / 10} мин` +
    (Number.isFinite(p.structureBudgetSeconds) ? `; поиск построек осталось ${Math.floor(p.structureBudgetSeconds)} с, затем руда` : '') + ': ' +
    p.steps.map(s => `${s.id}${s.d !== undefined ? `(${s.d} м)` : ''} ${s.budget} с`).join(' → ')
}
