'use strict'
import * as gameClock from './game-clock'
// Переход по Аду закрытым штреком (общий: бастион, крепость, портал; любой сид).
//
// Пешком по Аду тело гибло в каждой второй попытке на ~560 блоков (ферма 30.09, trip*: падения у
// 512,36,211, лавовое озеро у 103,31,80 — «tried to swim in lava», «fell from a high place»). Штрек
// идёт сквозь толщу (предпочтительная высота band, по умолчанию 40 — над лавовым морем y 31):
// планировщик sealed.plan кусками по ~18 блоков — ни одна наша клетка не касается лавы, огня и чужого
// воздуха (мобы не подходят, лава не течёт, падать некуда). Не вышло — тот же кусок с правом вскрыть
// стену в пещеру (за спиной засыпает sealed.execute; у бастиона — нельзя, noBreachNear), потом обход
// вбок, потом другая высота. Кирки — только каменные (деревянные, золотые): фильтр tools.bestFor на
// время штрека, железная — для золота; запас по бюджету прочности на кусок, не хватает — делаем
// из булыжника/чернокамня и палок (actions.craft). Клетки прежних штреков (session._tunnelOwn) —
// свои: обратный путь по тому же штреку почти без копки.
const sleep = ms => new Promise<any>(r => gameClock.setTimeout(r, ms))
const clamp = (v, a, b) => Math.max(a, Math.min(b, v))
const LOW_PICK = /^(stone|wooden|golden)_pickaxe$/
const HIGH_PICK = /^(iron|diamond|netherite)_pickaxe$/
const STONE_MAT = /^(cobblestone|blackstone|cobbled_deepslate)$/
const WOOD_MAT = /_(log|stem|wood|hyphae)$/
// Что без железной кирки не добыть (в Аду — золотые блоки; обломки — алмазной).
const NEEDS_HIGH = /^(gold_block|raw_gold_block|gold_ore|deepslate_gold_ore|diamond_ore|deepslate_diamond_ore|emerald_ore|deepslate_emerald_ore|redstone_ore|deepslate_redstone_ore|obsidian|crying_obsidian|ancient_debris|respawn_anchor)$/

function lowPicks (bot) { return bot.inventory.items().filter(i => LOW_PICK.test(i.name)).length }
function lowUses (bot) {
  return bot.inventory.items().filter(i => LOW_PICK.test(i.name))
    .reduce((n, i) => n + Math.max(0, (i.maxDurability || 131) - (i.durabilityUsed || 0)), 0)
}
function countOf (bot, re) { return bot.inventory.items().filter(i => re.test(i.name)).reduce((n, i) => n + i.count, 0) }
// Фильтр инструментов (tools.bestFor): железные и лучше кирки — только для того, что без них не добыть.
// strict (штрек) — всегда; иначе (бастион) — пока есть каменные: без них копать рукой встало бы.
const makeToolFilter = (bot, strict = true) => (it, block) => !HIGH_PICK.test(it.name) || NEEDS_HIGH.test(block && block.name) || (!strict && lowPicks(bot) === 0)

// Каменные кирки на запас: верстак из рюкзака ставит actions.craft. Итог — сколько сделано.
async function restockPicks (session, ctl, want = 3, options: { reservePlanks?: number } = {}) {
  const bot = session.bot
  const actions: typeof import('./actions') = require('./actions')
  const { hasTableHandy, spendablePlanks }: typeof import('./items') = require('./items')
  let made = 0
  const reservePlanks = Math.max(0, options.reservePlanks ?? 0)
  // Две палки — на железную кирку, пока её нет, а железо (или самородки) есть (chain6-6 30.09: железо из
  // сундуков есть, палки ушли на каменные — «не хватает stick×2»).
  const reserve = () => (!bot.inventory.items().some(i => HIGH_PICK.test(i.name)) && (countOf(bot, /^(iron_ingot|raw_iron)$/) > 0 || countOf(bot, /^iron_nugget$/) >= 9)) ? 2 : 0
  const sticksFree = () => countOf(bot, /^stick$/) + 4 * Math.floor(Math.max(0, spendablePlanks(bot, session.mcData) - reservePlanks) / 2) - reserve()
  const unpackWood = async minPlanks => {
    while (!ctl.aborted && countOf(bot, /_planks$/) < minPlanks) {
      const wood = bot.inventory.items().find(it => WOOD_MAT.test(it.name))
      if (!wood) break
      const before = countOf(bot, /_planks$/)
      const planks = wood.name.replace(/^stripped_/, '').replace(WOOD_MAT, '_planks')
      try { await actions.craft(session, ctl, { item: planks, count: 4 }) } catch {}
      if (countOf(bot, /_planks$/) <= before) break
    }
  }
  // Палок уже может хватать, но верстак оставлен в первом бастионе: actions.ensureTable сам брёвна
  // не распаковывает. Сначала делаем переносной верстак, затем палки/кирки из свободных досок.
  if (countOf(bot, STONE_MAT) >= 3 && !hasTableHandy(bot, session.mcData)) {
    if (pickBudget(bot, session.mcData, options).craftable === 0) return 0
    await unpackWood(4 + reservePlanks)
    if (countOf(bot, /_planks$/) < 4 + reservePlanks || ctl.aborted) return 0
    try { await actions.craft(session, ctl, { item: 'crafting_table', count: 1 }) } catch {}
    if (!hasTableHandy(bot, session.mcData)) return 0
  }
  for (let i = 0; i < want && !ctl.aborted; i++) {
    if (countOf(bot, STONE_MAT) < 3) break
    // pickBudget считает и брёвна: этот запас надо реально распаковать, иначе после первой кирки
    // при одной доске и трёх брёвнах весь длинный маршрут копался рукой (main 30.09).
    if (sticksFree() < 2) {
      await unpackWood(2 + reservePlanks)
    }
    if (sticksFree() < 2) break
    if (countOf(bot, /^stick$/) - reserve() < 2) {
      if (countOf(bot, /_planks$/) < 2 + reservePlanks) break
      try { await actions.craft(session, ctl, { item: 'stick', count: 4 }) } catch {}
      if (countOf(bot, /^stick$/) - reserve() < 2) break
    }
    const n = lowPicks(bot)
    try { await actions.craft(session, ctl, { item: 'stone_pickaxe', count: 1 }) } catch {}
    if (lowPicks(bot) <= n) break
    made++
  }
  return made
}

// Прочность каменных кирок в рюкзаке и из запаса (камень по 3, палки по 2; две палки — железной кирке,
// если её нет, а железо есть): сколько копок по незераку можно сделать.
function pickBudget (bot, mcData = bot.registry, options: { reservePlanks?: number } = {}) {
  const reserve = (!bot.inventory.items().some(i => HIGH_PICK.test(i.name)) && (countOf(bot, /^(iron_ingot|raw_iron)$/) > 0 || countOf(bot, /^iron_nugget$/) >= 9)) ? 2 : 0
  const tableCost = (require('./items') as typeof import('./items')).hasTableHandy(bot, mcData) ? 0 : 4
  const planks = Math.max(0, countOf(bot, /_planks$/) + 4 * countOf(bot, WOOD_MAT) - tableCost - Math.max(0, options.reservePlanks ?? 0))
  // 1 бревно → 4 доски; 2 доски → 4 палки. На верстак уходит ещё 4 доски, если его нет.
  const sticks = countOf(bot, /^stick$/) + 4 * Math.floor(planks / 2) - reserve
  if (tableCost && countOf(bot, /_planks$/) + 4 * countOf(bot, WOOD_MAT) < tableCost + Math.max(0, options.reservePlanks ?? 0)) return { uses: lowUses(bot), craftable: 0, total: lowUses(bot) }
  const craftable = Math.max(0, Math.min(Math.floor(countOf(bot, STONE_MAT) / 3), Math.floor(sticks / 2)))
  return { uses: lowUses(bot), craftable, total: lowUses(bot) + craftable * 131 }
}

// Клетки своих штреков — и на диске (память тела, tunnel-own.json): после перезапуска демона обратный путь
// по своему штреку иначе считался «чужой пещерой» и копался рядом заново. Сверка с живым миром — в adoptPrev
// (клетка своя, только если сейчас воздух без лавы).
const OWN_MAX = 40000
function ownFile (session) { const d = session.cfg && session.cfg.memoryDir; return d ? (require('path') as typeof import('path')).join(d, 'tunnel-own.json') : null }
function ownSet (session) {
  if (session._tunnelOwn) return session._tunnelOwn
  const s = new Set()
  try {
    const f = ownFile(session); const fs: typeof import('fs') = require('fs')
    if (f && fs.existsSync(f)) for (const k of (JSON.parse(fs.readFileSync(f, 'utf8')).cells || [])) s.add(k)
  } catch {}
  return (session._tunnelOwn = s)
}
function rememberOwn (session, cells) {
  const keep = ownSet(session)
  for (const k of (cells || [])) keep.add(k)
  if (keep.size > OWN_MAX) { const arr = [...keep].slice(-OWN_MAX); keep.clear(); for (const k of arr) keep.add(k) }
  try { const f = ownFile(session); if (f) (require('fs') as typeof import('fs')).writeFileSync(f, JSON.stringify({ t: gameClock.now(), cells: [...keep] })) } catch {}
}

// Сколько копок у пути (клетки не воздух и не свои).
function digsOf (SL, view, own, path) {
  let n = 0
  const seen = new Set()
  for (const mv of path) {
    for (const c of mv.clear) {
      const k = SL.key(c.x, c.y, c.z)
      if (seen.has(k) || own.has(k)) continue
      seen.add(k)
      if (view.cls(c.x, c.y, c.z) !== SL.AIR) n++
    }
  }
  return n
}

// Точки маршрута ([x,y,z] или {x,y,z}) → {x,y,z}.
const normVia = via => (Array.isArray(via) ? via : []).map(p => Array.isArray(p) ? { x: +p[0], y: +p[1], z: +p[2] } : { x: +p.x, y: +p.y, z: +p.z })
  .filter(p => Number.isFinite(p.x) && Number.isFinite(p.y) && Number.isFinite(p.z))
// Сколько копок впереди по маршруту (оценка сверху: 2 клетки на блок пути) от точки i и до цели.
function viaDigs (me, via, target) {
  let n = 0; let p = me
  for (const q of [...via, target]) { n += Math.abs(q.x - p.x) + Math.abs(q.z - p.z) + Math.abs((Number.isFinite(q.y) ? q.y : p.y) - p.y); p = { x: q.x, y: Number.isFinite(q.y) ? q.y : p.y, z: q.z } }
  return 2 * n
}

// target {x,z[,y]}; opts: band (предпочтительная высота), radius (дошёл — в стольких по горизонтали),
// deadline, seg (длина куска), noBreachNear {x,z,r} (не вскрывать открытое ближе r), log(what, data),
// via — точки маршрута сквозь толщу (по карте копии мира: tools/router.js), идём от точки к точке на их
// высоте, хоть под лавовым морем (y 6–17 между бастионами 105,87 и 672,272: на y 34–46 там открытая
// пещера 400×250 — chain6 30.09, «куска нет» ×15 у 214,37,159).
// Итог: { ok, why?, segs, breach, detours, crafted, dug, moves, fills, own, exposed, at }.
//
// По шагам: startTunnel ставит контекст tc — всё, что было замыканием tunnelTo (бывшие let — поля tc: wi, foes,
// band, fails, side; помощники — те же замыкания). Круг цикла (tunnelTurn) — четыре ступени: turnStart (время,
// дошёл ли, хп, кирки, финальный план к цели), segmentGoal (цель куска), planSegment (план куска, вход ногами),
// walkSegment (отказ плана или ход по куску). Значения круга (me, dist, leg, цель и план куска) — в кадре fr.
// Ответ ступени: NEXT — новый круг (прежнее continue), объект — итог out(…) (прежнее return out(…)),
// undefined — следующая ступень.
const NEXT = 'next'

interface TunnelCtx {
  session: any; ctl: any; target: any; opts: any; bot: any; SL: typeof import('./sealed'); feetNow: () => any; log: any;
  band0: number; via: any[]; legOf: (me: any) => any; radius: any; deadline: any; segLen: any; nb: any; S: any;
  body: () => any[]; adoptPrev: () => void; st: any; farFromNb: (k: any) => boolean; refreshFoes: () => void;
  nearFoe: (k: any) => boolean; breachFn: (ck: any, nk: any) => boolean; out: (ok: any, why?: any) => any;
  wi: number; foes: any[]; band: number; fails: number; side: number
}

interface TunnelTurn {
  me: any; dist: any; yOk: any; leg: any; L: any; ux: any; uz: any; last: any; ex: any; ey: any; ez: any;
  tol: any; ytol: any; box: any; view: any; r: any; breach: any; local: any
}

async function tunnelTo (session, ctl, target, opts: any = {}) {
  const tc = startTunnel(session, ctl, target, opts)
  const { bot, band0, via, legOf, feetNow, st, out } = tc
  // Маршрут длинный (между бастионами ~1700 копок, via2 30.09): кирок совсем мало — не начинать. Порог 0.6 от
  // оценки (2 копки на блок пути): недостача копается рукой (незерак — 2 с на блок, +10–20 мин), это дешевле
  // эндерменов на всю недостачу.
  if (via.length && opts.budgetCheck === true) {
    const me = feetNow()
    legOf(me)
    const need = viaDigs(me, via.slice(tc.wi), target)
    const pb = pickBudget(bot)
    st.need = need; st.budget = pb.total
    if (pb.total < need * 0.6) return out(false, `кирок на дорогу не хватит: копок ~${need}, кирок на ${pb.total} (каменных ${lowPicks(bot)}, из запаса ${pb.craftable})`)
  }
  const filter0 = bot._ndToolFilter
  // ironOk (все бастионы позади — железной больше нечего беречь): без каменных копать и железной.
  bot._ndToolFilter = makeToolFilter(bot, !opts.ironOk)
  try {
    tc.band = band0
    tc.fails = 0
    tc.side = 1
    while (!ctl.aborted) {
      const turn = await tunnelTurn(tc)
      if (turn === NEXT) continue
      if (turn) return turn
    }
    return out(false, 'прервано')
  } finally { bot._ndToolFilter = filter0 }
}

function startTunnel (session, ctl, target, opts): TunnelCtx {
  const bot = session.bot
  const SL: typeof import('./sealed') = require('./sealed')
  // S1f: клетка ног с поправкой на песок душ (высота 0.875: floored() — клетка самого песка): «не шагнул down/flat/vdown … (я …,N.88,…)»
  // — 36 остановок штрека по Аду во вслепую сериях S1e/S1f. ND_SOUL_FEET=0 — прежнее.
  const feetNow = () => process.env.ND_SOUL_FEET === '0' ? bot.entity.position.floored() : SL.bodyCells(bot)[0]
  const log = opts.log || (() => {})
  const band0 = clamp(Math.round(opts.band ?? 40), 34, 110)
  const via = normVia(opts.via)
  const tc = {} as TunnelCtx
  tc.wi = 0
  // Вход в маршрут — в точке, где путь «тело → точка → хвост маршрута → цель» короче всего (тело у конца
  // маршрута не идёт к его началу; тело в стороне — входит ближе к цели).
  if (via.length) {
    const me0 = feetNow()
    const tgt = { x: target.x, y: Number.isFinite(target.y) ? target.y : via[via.length - 1].y, z: target.z }
    const m1 = (a, b) => Math.abs(a.x - b.x) + Math.abs(a.y - b.y) + Math.abs(a.z - b.z)
    const tail = new Array(via.length).fill(0)
    for (let k = via.length - 1; k >= 0; k--) tail[k] = m1(via[k], k + 1 < via.length ? via[k + 1] : tgt) + (k + 1 < via.length ? tail[k + 1] : 0)
    // Путь вне маршрута — втрое дороже (там толща не проверена): иначе при почти «манхэттенском» маршруте вход
    // выпадал у его конца и штрек шёл напрямик — в ту самую пещеру (via1 30.09: вход в точке 32 из 37).
    let bv = Infinity
    for (let k = 0; k < via.length; k++) { const v = 3 * m1(me0, via[k]) + tail[k]; if (v < bv) { bv = v; tc.wi = k } }
  }
  // Текущая точка маршрута: ближайшая из оставшихся в 12 блоках — до неё всё пройдено; в 5 — следующая.
  const legOf = me => {
    let best = -1; let bd = Infinity
    for (let k = tc.wi; k < via.length; k++) { const d = Math.hypot(via[k].x - me.x, via[k].y - me.y, via[k].z - me.z); if (d < bd) { bd = d; best = k } }
    // Перескок вперёд — только если тело уже у поздней точки (≤ 5 блоков): маршрут не петляет, а свой старый
    // штрек мог увести вперёд (ревью Codex 30.09: перескок в 12 блоках пропускал точки).
    if (best > tc.wi && bd <= 5) tc.wi = best
    while (tc.wi < via.length && Math.hypot(via[tc.wi].x - me.x, via[tc.wi].z - me.z) <= 4 && Math.abs(via[tc.wi].y - me.y) <= 3) tc.wi++
    return tc.wi < via.length ? via[tc.wi] : null
  }
  const radius = opts.radius ?? 4
  const deadline = opts.deadline ?? gameClock.now() + 15 * 60000
  const segLen = opts.seg ?? 18
  const nb = opts.noBreachNear || null
  const S: any = { own: new Set(), exposed: true, dug: 0, moves: 0, fills: 0, ores: 0, bonusBlocks: 0, goldPassed: 0, plans: 0, fails: [], planMs: 0, walks: 0, noBonus: !opts.bonus, deadline } // bonus — добор золотой руды в стенах (ne-gold-first, ND_NE_GOLD_FIRST)
  const body = () => { const f = feetNow(); return [f, f.offset(0, 1, 0)] }
  // Прежние штреки — свои, если клетка и сейчас воздух (проверка по живому миру).
  const V3 = (require('vec3') as typeof import('vec3')).Vec3
  // Только рядом (в 56 блоках): план куска смотрит не дальше, а своих клеток на диске — до 40 тыс.
  const adoptPrev = () => {
    const p = bot.entity.position
    for (const k of ownSet(session)) {
      if (S.own.has(k)) continue
      const [x, y, z] = k.split(',').map(Number)
      if (Math.abs(x - p.x) > 56 || Math.abs(z - p.z) > 56 || Math.abs(y - p.y) > 40) continue
      const b = bot.blockAt(new V3(x, y, z))
      if (b && b.boundingBox === 'empty' && !/lava|water|fire/.test(b.name)) S.own.add(k)
    }
  }
  adoptPrev()
  for (const v of body()) S.own.add(SL.keyV(v))
  const st: any = { segs: 0, breach: 0, detours: 0, crafted: 0, bandShifts: 0, reused: S.own.size - 2, via: via.length }
  // Вскрыть открытое можно только дальше noBreachNear — по каждой вскрываемой клетке (ревью Codex 30.09:
  // проверка по старту куска пускала пробой в 47 блоках при запрете 48).
  const farFromNb = k => { if (!nb) return true; const [x, , z] = k.split(',').map(Number); return Math.hypot(x - nb.x, z - nb.z) >= nb.r }
  // И не вскрывать туда, где рядом хоглин/брут/зоглин (chain6 30.09: 3 смерти от хоглинов у 63–69,34–48,92–108
  // — план к стене вскрыл западный край бастиона).
  tc.foes = []
  const refreshFoes = () => { tc.foes = (Object.values(bot.entities || {}) as any[]).filter((e : any) => e && e.position && /^(hoglin|zoglin|piglin_brute|magma_cube|ghast)$/.test(e.name || '')).map((e : any) => e.position) }
  const nearFoe = k => { const [x, y, z] = k.split(',').map(Number); return tc.foes.some(p => Math.abs(p.x - x) < 8 && Math.abs(p.y - y) < 5 && Math.abs(p.z - z) < 8) }
  const breachFn = (ck, nk) => farFromNb(ck) && farFromNb(nk) && !nearFoe(nk)
  const out = (ok, why?: any) => {
    // Запомнить штрек для обратного пути.
    rememberOwn(session, S.own)
    return { ok, why, ...st, viaDone: tc.wi, dug: S.dug, moves: S.moves, fills: S.fills, ores: S.ores, own: S.own, exposed: SL.exposure(bot, S.own).length > 0, at: (() => { const p = bot.entity.position; return { x: Math.floor(p.x), y: Math.floor(p.y), z: Math.floor(p.z) } })() }
  }
  return Object.assign(tc, {
    session, ctl, target, opts, bot, SL, feetNow, log, band0, via, legOf, radius, deadline, segLen, nb, S, body, adoptPrev, st,
    farFromNb, refreshFoes, nearFoe, breachFn, out
  })
}

// Один круг штрека.
async function tunnelTurn (tc: TunnelCtx) {
  const fr = {} as TunnelTurn
  const start = await turnStart(tc, fr)
  if (start) return start
  const goal = segmentGoal(tc, fr)
  if (goal) return goal
  const planned = await planSegment(tc, fr)
  if (planned) return planned
  return walkSegment(tc, fr)
}

// Начало круга: время, дошёл ли, свои клетки, хп, запас кирок, финальный план прямо к цели.
async function turnStart (tc: TunnelCtx, fr: TunnelTurn) {
  const { session, ctl, target, opts, bot, SL, feetNow, log, via, legOf, radius, deadline, S, body, adoptPrev, st,
    refreshFoes, breachFn, out } = tc
  if (gameClock.now() > deadline) return out(false, 'время')
  const me = feetNow()
  const dist = Math.hypot(target.x - me.x, target.z - me.z)
  const yOk = !Number.isFinite(target.y) || Math.abs(me.y - target.y) <= 4
  if (dist <= radius && yOk) return out(true)
  adoptPrev()
  if ((bot.health ?? 20) < 8) {
    try { await (require('./actions') as typeof import('./actions')).eat(session, {}) } catch {}
    if ((bot.health ?? 20) < 6) return out(false, `хп ${Math.round(bot.health ?? 0)}`)
  }
  if (lowPicks(bot) === 0) {
    const made = await restockPicks(session, ctl, 3)
    st.crafted += made
    for (const v of body()) S.own.add(SL.keyV(v))
    if (made) return NEXT
  }
  // Вблизи цели (≤ finalDist) — один план прямо к ней, с большим поиском и любой высотой: у бастиона
  // прямая «кусками» упиралась в открытый двор и лаву (chain4 30.09: от 92,47,88 к стене 89,36,140 —
  // «куска нет» ×15), а закрытый путь есть ниже, под двором (pit-v4: 106 ходов от 98,36,87).
  const finalDist = opts.finalDist ?? 72
  const leg = via.length ? legOf(me) : null
  if (!leg && dist <= finalDist && !st.finalTried) {
    st.finalTried = true
    const view = SL.worldView(bot)
    const ty = Number.isFinite(target.y) ? target.y : me.y
    const goalF = (x, y, z) => Math.hypot(x - target.x, z - target.z) <= radius && Math.abs(y - ty) <= 6
    const hF = (x, y, z) => Math.max(0, Math.hypot(x - target.x, z - target.z) - radius) + 0.3 * Math.max(0, Math.abs(y - ty) - 6)
    const boxF = {
      x0: Math.min(me.x, target.x) - 14, x1: Math.max(me.x, target.x) + 14,
      y0: Math.max(33, Math.min(me.y, ty) - 10), y1: Math.min(120, Math.max(me.y, ty) + 12),
      z0: Math.min(me.z, target.z) - 14, z1: Math.max(me.z, target.z) + 14
    }
    const t0 = gameClock.wall.now()
    refreshFoes()
    const baseF = { cls: view.cls, dig: view.dig, own: S.own, starts: [{ x: me.x, y: me.y, z: me.z, g: 0 }], goal: goalF, h: hF, box: boxF, maxNodes: 160000, vup: SL.fillerCount(bot) >= 6 }
    let rF = await SL.plan(baseF)
    // Закрытого пути к стене нет (вокруг бастиона двор и пещеры, chain5 30.09: 12 тыс. узлов, пути нет) —
    // с правом вскрыть на ходу только вне noBreachNear: финальный подход не должен обходить запрет
    // двора у бастиона (chain6: хоглин у открытого края сдвинул тело в лаву).
    let breachF = false
    if (!rF.ok) { rF = await SL.plan({ ...baseF, breachOk: breachFn, breachCost: 25 }); breachF = rF.ok }
    S.plans++; S.planMs += gameClock.wall.now() - t0
    log('штрек по Аду: план к цели', { ok: rF.ok, moves: rF.ok ? rF.path.length : 0, nodes: rF.nodes, ms: gameClock.wall.now() - t0, why: rF.ok ? undefined : rF.why })
    if (rF.ok && rF.path.length) {
      const need = digsOf(SL, view, S.own, rF.path)
      if (lowUses(bot) < need + 8) { st.crafted += await restockPicks(session, ctl, Math.min(6, Math.ceil((need + 8 - lowUses(bot)) / 120))); for (const v of body()) S.own.add(SL.keyV(v)) }
      if ((lowUses(bot) >= need + 8 || opts.hand !== false) && feetNow().equals(me)) {
        S.breachOk = breachF ? breachFn : null
        let exF
        try { exF = await SL.execute(session, ctl, rF.path, S) } finally { S.breachOk = null }
        if (exF.ok) { st.segs++; st.finalOk = true; return NEXT }
        log('штрек по Аду: план к цели оборвался', { why: exF.why, done: exF.done, of: rF.path.length })
      }
    }
  }
  Object.assign(fr, { me, dist, yOk, leg })
}

// Цель куска: к точке маршрута или по прямой к цели; после отказов — со сдвигом вбок и шире круг цели.
function segmentGoal (tc: TunnelCtx, fr: TunnelTurn) {
  const { target, radius, segLen, out } = tc
  const { band, fails, side } = tc
  const { me, dist, leg } = fr
  let L, ux, uz, last, ex, ey, ez, tol, ytol, box
  if (leg) {
    // К точке маршрута: кусок до segLen по горизонтали, высота — по прямой к высоте точки (подъёмы
    // и спуски маршрута круче куска — не больше segLen по высоте за кусок). Обход — в 3–6 блоках:
    // коридор маршрута узкий (запас толщи по карте — 2 блока).
    const dL = Math.hypot(leg.x - me.x, leg.z - me.z)
    L = Math.min(segLen, dL)
    ux = dL > 0.5 ? (leg.x - me.x) / dL : 0; uz = dL > 0.5 ? (leg.z - me.z) / dL : 0
    last = false
    const off = !fails ? 0 : side * 3 * Math.min(2, Math.ceil(fails / 2))
    ex = Math.round(me.x + ux * L - uz * off); ez = Math.round(me.z + uz * L + ux * off)
    ey = dL <= segLen ? leg.y : Math.round(me.y + (leg.y - me.y) * L / dL)
    if (Math.abs(ey - me.y) > segLen) ey = me.y + Math.sign(ey - me.y) * segLen
    tol = 2 + Math.min(4, fails); ytol = 2 + Math.min(3, fails)
    box = {
      x0: Math.min(me.x, ex) - 8, x1: Math.max(me.x, ex) + 8,
      y0: Math.max(5, Math.min(me.y, ey) - 6), y1: Math.min(120, Math.max(me.y, ey) + 8),
      z0: Math.min(me.z, ez) - 8, z1: Math.max(me.z, ez) + 8
    }
  } else {
    L = Math.min(segLen, dist)
    ux = dist > 0 ? (target.x - me.x) / dist : 1; uz = dist > 0 ? (target.z - me.z) / dist : 0
    last = dist <= segLen
    // Обход вбок — не дальше 12 блоков (смещения до 42 уводили кусок в лавовое море). Последний кусок не
    // смещаем, а расширяем круг цели (у места обзора в открытом клетки в толще может не быть); ближе
    // радиуса так и не подошли — неуспех, довод — у вызывающего (ревью Codex 30.09: ложный ok в 10 бл.).
    const off = last || !fails ? 0 : side * 6 * Math.min(2, Math.ceil(fails / 2))
    ex = Math.round(me.x + ux * L - uz * off); ez = Math.round(me.z + uz * L + ux * off)
    if (last && fails >= 5) return out(false, 'к цели штреком ближе не подойти')
    ey = last && Number.isFinite(target.y) ? clamp(Math.round(target.y), 34, 118) : band
    tol = last ? Math.min(14, Math.max(3, Math.min(radius, 6)) + 2 * fails) : 2
    // Высота band — лишь предпочтение: у бастиона 105,87 суша над лавовым морем тонкая, на y 40 под ней
    // пустоты (chain1-16: «куска нет» ×9), штрек идёт по толще выше. Последний кусок — к высоте цели.
    ytol = last ? 4 : 14
    box = {
      x0: Math.min(me.x, ex) - 8, x1: Math.max(me.x, ex) + 8,
      y0: Math.max(33, Math.min(me.y, ey) - 10), y1: Math.min(120, Math.max(me.y, ey) + 16),
      z0: Math.min(me.z, ez) - 8, z1: Math.max(me.z, ez) + 8
    }
  }
  Object.assign(fr, { L, ux, uz, last, ex, ey, ez, tol, ytol, box })
}

// План куска: закрытый путь; старт из чужого кармана; пробой стены пещеры; со старта не войти — шаги ногами.
async function planSegment (tc: TunnelCtx, fr: TunnelTurn) {
  const { ctl, bot, SL, feetNow, log, deadline, S, body, st, farFromNb, refreshFoes, nearFoe, breachFn } = tc
  const { fails } = tc
  const { me, leg, ux, uz, last, ex, ey, ez, tol, ytol, box } = fr
  const view = SL.worldView(bot)
  const goal = (x, y, z) => Math.hypot(x - ex, z - ez) <= tol && Math.abs(y - ey) <= ytol
  const h = (x, y, z) => Math.max(0, Math.abs(x - ex) + Math.abs(z - ez) - tol) + 0.3 * Math.max(0, Math.abs(y - ey) - (last ? 0 : 3))
  const base = { cls: view.cls, dig: view.dig, own: S.own, starts: [{ x: me.x, y: me.y, z: me.z, g: 0 }], goal, h, box, maxNodes: 60000, vup: SL.fillerCount(bot) >= 6 }
  const t0 = gameClock.wall.now()
  let r = await SL.plan(base)
  let breach = false
  // Старт в «чужом» кармане (ни одного хода: кругом воздух не из своих — стена бастиона, main 30.09) —
  // пройти и вскрыть можно только этот карман (sealed.localAir); дальше — как всегда.
  let local = null
  if (!r.ok && r.nodes <= 1) {
    local = SL.localAir(bot)
    if (local) {
      r = await SL.plan({ ...base, openOk: local, breachOk: (ck, nk) => local.has(nk) })
      log('штрек по Аду: старт из чужого кармана', { cells: local.size, ok: r.ok, nodes: r.nodes })
      if (!r.ok) local = null
    }
  }
  if (!r.ok && !leg) {
    // Стена пещеры на пути: вскрыть можно (за спиной засыплется), лаву — нет; у бастиона — нельзя.
    // По маршруту — никогда: он проложен сквозь толщу с запасом, пробой там — ошибка (ревью Codex 30.09).
    refreshFoes()
    r = await SL.plan({ ...base, breachOk: breachFn, breachCost: 25 })
    breach = r.ok
  }
  S.plans++
  S.planMs += gameClock.wall.now() - t0
  // У площадки портала стартовый воздух чужой и незамкнутый: localAir его не разрешает.
  // Единственный короткий вход ногами допустим и для via, но только у портала, вне запрета и без врагов.
  let portalIngress = false
  if (!r.ok && leg && !st.segs && !st.stepped && fails >= 1) {
    try { portalIngress = !!bot.findBlock({ matching: b => b && b.name === 'nether_portal', maxDistance: 16 }) } catch {}
  }
  refreshFoes()
  const ingressStart = SL.key(me.x, me.y, me.z)
  const ingressEnd = SL.key(Math.round(me.x + ux * 8), me.y, Math.round(me.z + uz * 8))
  if (!r.ok && (!leg || portalIngress) && !st.segs && !st.stepped && fails >= 1 &&
      farFromNb(ingressStart) && farFromNb(ingressEnd) && !nearFoe(ingressStart) && !nearFoe(ingressEnd)) {
    // Со старта не войти в толщу (площадка портала из обсидиана, кругом открыто: chain3-1 — 15 раз
    // «куска нет» у портала 3,69,2) — несколько шагов ногами к цели, и снова штреком.
    st.stepped = true
    let timer = null; let watch = null
    try {
      const { goals }: typeof import('mineflayer-pathfinder') = require('mineflayer-pathfinder')
      const gx = Math.round(me.x + ux * 8); const gz = Math.round(me.z + uz * 8)
      const lim = Math.max(1000, Math.min(20000, deadline - gameClock.now()))
      await Promise.race([
        bot.pathfinder.goto(new goals.GoalNearXZ(gx, gz, 2)),
        new Promise<any>(resolve => { timer = gameClock.setTimeout(resolve, lim) }),
        new Promise<any>(resolve => { watch = gameClock.setInterval(() => { if (ctl.aborted) resolve(undefined) }, 100) })
      ])
    } catch {} finally { if (timer) gameClock.clearTimeout(timer); if (watch) gameClock.clearInterval(watch); try { bot.pathfinder.setGoal(null) } catch {} }
    for (const v of body()) S.own.add(SL.keyV(v))
    log('штрек по Аду: со старта не войти — отошёл ногами', { from: me, at: feetNow() })
    return NEXT
  }
  Object.assign(fr, { view, r, breach, local })
}

// Отказ плана — обход, другая высота или конец; план есть — бюджет кирок на кусок и ход по нему.
async function walkSegment (tc: TunnelCtx, fr: TunnelTurn) {
  const { session, ctl, target, opts, bot, SL, feetNow, log, band0, via, radius, S, body, st, breachFn, out } = tc
  const { me, dist, yOk, leg, L, last, ex, ey, ez, view, r, breach, local } = fr
  if (!r.ok) {
    tc.fails++
    st.detours++
    tc.side = -tc.side
    if (!leg && tc.fails % 4 === 0) { tc.band = clamp(tc.band + (tc.band >= band0 ? -6 : 6) * (1 + Math.floor(tc.fails / 8)), 34, 100); st.bandShifts++ }
    log('штрек по Аду: куска нет', { from: me, to: { x: ex, y: ey, z: ez }, fails: tc.fails, leg: leg ? tc.wi : undefined, why: r.why })
    // Непройденная точка не считается пройденной: из портала прежде пропускались все 11 без единого хода.
    if (leg && tc.fails >= 6) return out(false, `точка маршрута ${tc.wi + 1}/${via.length} недоступна`)
    if (tc.fails > 14) return out(false, 'пути нет')
    return NEXT
  }
  if (!r.path.length && leg) {
    // В цели куска: точка пройдена, только если тело и правда у неё; иначе — как отказ куска.
    if (Math.hypot(leg.x - me.x, leg.z - me.z) <= 4 && Math.abs(leg.y - me.y) <= 3) { tc.wi++; return NEXT }
    tc.fails++; tc.side = -tc.side
    if (tc.fails > 14) return out(false, 'стою в цели куска')
    return NEXT
  }
  if (!r.path.length) {
    // Уже в цели куска: последний — дошли, если и правда в радиусе (и по высоте); иначе обходом.
    if (last && Math.hypot(target.x - me.x, target.z - me.z) <= radius && yOk) return out(true)
    tc.fails++; tc.side = -tc.side
    if (tc.fails > 14) return out(false, 'стою в цели куска')
    return NEXT
  }
  // Бюджет кирок на кусок: копок больше, чем осталось прочности у каменных, — сделать ещё до хода
  // (иначе последняя ломалась посреди куска и копали железной: ревью Codex 30.09).
  let path = r.path
  const need = digsOf(SL, view, S.own, path)
  if (need > 0 && lowUses(bot) < need + 8) {
    st.crafted += await restockPicks(session, ctl, 3)
    for (const v of body()) S.own.add(SL.keyV(v))
    if (!feetNow().equals(me)) return NEXT // верстак сдвинул тело — план заново
    if (lowUses(bot) < need + 8) {
      // Хватает на часть — пройти префикс.
      let cut = 0; let digs = 0; const seen = new Set()
      for (; cut < path.length; cut++) {
        for (const c of path[cut].clear) { const k = SL.key(c.x, c.y, c.z); if (!seen.has(k) && !S.own.has(k) && view.cls(c.x, c.y, c.z) !== SL.AIR) { seen.add(k); digs++ } }
        if (digs > Math.max(0, lowUses(bot) - 4)) break
      }
      if (cut) path = path.slice(0, cut)
      // Кирок и запаса нет: встать посреди Ада хуже (дальше — «пешком» мимо бастиона, chain6 30.09: брут, 2
      // смерти) — копать чем есть: железной (ironOk) или рукой (незерак — 2 с на блок).
      else if (opts.hand === false) return out(false, 'кирок нет (камня или палок не хватает)')
      else if (!st.hand) { st.hand = true; log('штрек по Аду: кирок нет — копаю чем есть', { ironOk: !!opts.ironOk, uses: lowUses(bot) }) }
    }
  }
  if (breach) st.breach++
  S.breachOk = local ? (ck, nk) => local.has(nk) : breach ? breachFn : null
  if (local) S.openOk = local
  let ex2
  try { ex2 = await SL.execute(session, ctl, path, S) } finally { S.breachOk = null; S.openOk = null }
  if (!ex2.ok) {
    tc.fails++
    st.detours++
    tc.side = -tc.side
    log('штрек по Аду: кусок оборвался', { why: ex2.why, done: ex2.done, of: path.length, leg: leg ? tc.wi : undefined })
    if (leg && tc.fails >= 6) return out(false, `точка маршрута ${tc.wi + 1}/${via.length}: ${ex2.why || 'кусок не прошёл'}`)
    if (tc.fails > 14) return out(false, ex2.why || 'кусок не прошёл')
    return NEXT
  }
  tc.fails = 0
  st.segs++
  if (st.segs % 5 === 0) log('штрек по Аду', { segs: st.segs, left: Math.round(dist - L), wi: via.length ? tc.wi + '/' + via.length : undefined, y: me.y, dug: S.dug, picks: lowPicks(bot), uses: lowUses(bot) })
}

export {
  tunnelTo, restockPicks, lowPicks, lowUses, makeToolFilter, NEEDS_HIGH, normVia, viaDigs, pickBudget,
  rememberOwn, ownSet
}
