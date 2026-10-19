const { approachWallSide, approachWallTop, foesNear, FOES_RE }: typeof import('./tower-scan') = require('./tower-scan')
const { log, sleep, xyz, mobs, seesMob, goals, walkGoal, gameClock, seesBlock, reachSet, angerSet, threatens, takeGoldBlock, inLava, lavaEscape, lavaEscapeDeep, inOwnTunnel, GOLD_PICK, makeIronPick, countOf, Vec3, fullCover, isBaby, raySees, pickUp, keyOf, armGold }: typeof import('./take-gold-block') = require('./take-gold-block')
const { walkUnlessBrute, bruteComing, tunnelTo }: typeof import('./booth-trade') = require('./booth-trade')
const { eatIfHungry }: typeof import('./predict-gold') = require('./predict-gold')
const miningCycle: typeof import('./mining-cycle') = require('./mining-cycle')
const { targetsByBruteHome, goldWindowOk }: typeof import('./brute-risk') = require('./brute-risk')
const { bruteDefense, goldExposes, hunker, burrow, answerAttack, sealBody }: typeof import('./defense') = require('./defense')

const GOLD_ARMOR_RE = /\bgolden_(helmet|chestplate|leggings|boots)\b/

// План штрека: вслепую — мир по шаблону гипотез (видимое — как есть, скрытое — символ куска), иначе — живой мир.
function planView (bot, st) {
  if (!(require('.././nether-cover') as typeof import('.././nether-cover')).blind()) return (require('.././sealed') as typeof import('.././sealed')).worldView(bot)
  const TV: typeof import('./template-view') = require('./template-view')
  return TV.templateView(bot, TV.piecesOf(st))
}

// Координаты ниже — гипотезы шаблона из наблюдения fortress, не прочитанные клетки мира.
function rememberStarts (bot, st, starts) {
  const bp: typeof import('.././bastion-pieces') = require('.././bastion-pieces')
  const list = Array.isArray(starts) ? starts : []
  const possible = process.env.ND_BASTION_ROOT_GRID === '1' && (require('.././nether-cover') as typeof import('.././nether-cover')).blind() ? list.filter(bp.startFitsGenerator) : list
  for (const [i, s] of possible.slice(0, 4).entries()) {
    if (!bp.START_REL[s?.type] || !Number.isInteger(s.r) || s.r < 0 || s.r > 3 ||
        !s.t || !['x', 'y', 'z'].every(k => Number.isFinite(s.t[k]))) continue
    for (const c of bp.piecesFromStart(s)) {
      ;(st.pieces ||= []).push(c)
      const rank = 100 * (i + 1) + c.slot + 1
      for (const pos of bp.goldOf(c)) {
        const k = keyOf(pos)
        if (!st.pred.has(k) && !st.gold.has(k)) st.pred.set(k, { pos, piece: c.piece, rank, wall: c })
      }
      for (const [x, y, z] of bp.lib()[c.piece].chests) {
        const pos = bp.toWorld(c, x, y, z); const k = keyOf(pos)
        if (!st.chestSeen.has(k) && !st.looted.has(k)) st.chestSeen.set(k, { pos, pred: true, rank })
      }
    }
  }
}

// An unchanged physical failure stays closed for this RPC; the campaign reopens it after new evidence or an approach.
function routeRetryAt (ms) { return process.env.ND_NE_RECOVER === '1' ? Infinity : gameClock.now() + ms }
async function sealedGold (session, ctl, st, until) {
  const bot = session.bot
  const dimension = bot.game?.dimension
  const SL: typeof import('.././sealed') = require('.././sealed')
  const S = st.sealedState || (st.sealedState = { own: new Set(), exposed: true, dug: 0, moves: 0, fills: 0, ores: 0, bonusBlocks: 0, goldPassed: 0, plans: 0, fails: [], planMs: 0, walks: 0 })
  S.deadline = until
  // Вслепую — план по шаблону узнанного бастиона (template-view), сверка исполнителя — только с видимым (S.honest); попутная
  // руда (bonusGold) судит по скрытым соседям — выкл.
  if ((require('.././nether-cover') as typeof import('.././nether-cover')).blind()) { S.honest = true; S.noBonus = true }
  S.onThreat = async () => { try { await answerAttack(session, ctl, st) } catch {} }
  // BonusGold обходит проверку цели; в этом эксперименте охраняемое копаем только здесь.
  if (st.fastSafe) S.noBonus = true
  let noPlan = 0
  while (!ctl.aborted && gameClock.now() < until - 10000) {
    if (session.bot !== bot || !bot.entity || (bot.health ?? 0) <= 0 || bot.game?.dimension !== dimension || bot._ndGuard?.ended) break
    if (st.fastSafe && st.stopMining && st.stopMining()) break
    if (inLava(bot)) { if (!(await lavaEscape(bot))) await lavaEscapeDeep(bot); continue }
    // Злые пиглины у вскрытого хода (золото касалось двора): сперва ответить — neF-map23-3 02.10: 4 удара и стрела
    // за 5 с, тело планировало следующий ход, 20 → 0 хп («slain by Piglin»). Брут — bruteDefense (столб).
    if (await answerAttack(session, ctl, st)) continue
    // Штрек вскрыт, а брут/хоглин уже в 6 бл. — заложиться до удара (удар брута 7+, трёх хватает на 20 хп).
    if (S.exposed && inOwnTunnel(bot, S) && foesNear(bot, 6).some((e : any) => FOES_RE.test(e.name || '')) && await hunker(session, ctl, st, 'враг у пролома')) continue
    if ((bot.health ?? 20) < 8) { await eatIfHungry(session, ctl); if ((bot.health ?? 20) < 8) { S.fails.push('хп'); break } }
    await eatIfHungry(session, ctl)
    // Без золотой брони: первое золото (сундук, блок) — сразу в броню, пока тело в закрытом штреке (верстак встаёт внутри), а не
    // после всего захода (ревью Codex 14.10): дальше пиглины к нам нейтральны, и вскрытия/бартер не под их ударами.
    if (st.goldless && !S.exposed && inOwnTunnel(bot, S) &&
        countOf(bot, 'gold_ingot') + 9 * countOf(bot, 'gold_block') + Math.floor(countOf(bot, 'gold_nugget') / 9) >= 4 ||
        st.goldless && GOLD_ARMOR_RE.test(bot.inventory.items().map(i => i.name).join(' '))) {
      if (await armGold(session, ctl)) { st.goldless = false; log('штрек: золотая броня из первого золота', { ingots: countOf(bot, 'gold_ingot'), blocks: countOf(bot, 'gold_block') }) }
    }
    // Кирки в штреке: каменные кончились — фильтр бастиона пускал железную на чернокамень и незерак, она стиралась, и
    if (process.env.ND_GUARD !== '0') {
      const G: typeof import('.././ne-guard') = require('.././ne-guard')
      const h = G.hot(bot, { near: 5 })
      if (h) {
        const rr = await G.react(session, ctl, { force: h, onOwn: cells => { for (const k of cells) S.own.add(k) } })
        if (rr.cancelled || ctl.aborted || session.bot !== bot) break
        if (rr.acted !== false) {
          S.exposed = SL.exposure(bot, S.own).length > 0
          log('штрек: страж', { why: h.why, how: rr.how, hp: Math.round(bot.health ?? 0) })
          continue
        }
      }
    }
    {
      const TN: typeof import('.././tunnel') = require('.././tunnel')
      if (TN.lowPicks(bot) === 0) { const made = await TN.restockPicks(session, ctl, 3).catch(() => 0); log('штрек: каменные кирки', { made }) }
      if (!bot.inventory.items().some(i => GOLD_PICK.test(i.name)) && !st.chestsOnly) {
        const made = await makeIronPick(session, ctl).catch(() => false)
        log('штрек: железная кирка', { made, ingots: countOf(bot, 'iron_ingot'), nuggets: countOf(bot, 'iron_nugget') })
        if (!made) { S.fails.push('нет железной кирки'); break }
      }
      // Свои клетки тела после крафта (верстак мог сдвинуть тело на клетку).
      const bc = [bot.entity.position.floored(), bot.entity.position.floored().offset(0, 1, 0)]
      if (bc.some(v => S.own.has(SL.keyV(v)))) for (const v of bc) { const b = bot.blockAt(v); if (b && b.boundingBox === 'empty') S.own.add(SL.keyV(v)) }
    }
    // Предсказания, уже выкопанные попутно (штрек прошёл сквозь них), — снять.
    for (const [k, v] of [...st.pred.entries()]) { const b = bot.blockAt(v.pos); if (b && b.boundingBox === 'empty' && S.own.has(k)) st.pred.delete(k) }
    for (const [k, g] of st.gold) if (!st.pred.has(k) && !S.own.has(k)) st.pred.set(k, { pos: g.pos, piece: 'видно', rank: 0 })
    // Без железной кирки (st.chestsOnly) — только сундуки: золото ей не взять, а железо в сундуках есть.
    // Цели в 6 бл. от дома брута копии — не трогать (S1d s1d-N-2: сундук у брута, 2 удара за секунду, смерть на 7-й мин).
    const BH6 = (require('.././nether-route') as typeof import('.././nether-route')).bruteSpots(session)
    const gear6 = (require('.././assess') as typeof import('.././assess')).gearOf((bot.inventory.slots || []).slice(5, 9))
    const preds = st.chestsOnly ? [] : targetsByBruteHome([...st.pred.entries()].filter(([k]) => (st.skip.get(k) || 0) < gameClock.now()), ([, v]) => v.pos, BH6, bot.health ?? 20, gear6)
    const chestsT = st.lootChests ? [...st.chestSeen.entries()].filter(([k]) => !st.looted.has(k) && (st.skip.get(k) || 0) < gameClock.now()).map(([k, v]) => ({ k, pos: v.pos, chest: true })) : []
    if (!preds.length && !chestsT.length) break
    const chestsOk = targetsByBruteHome(chestsT, c => c.pos, BH6, bot.health ?? 20, gear6)
    if (!preds.length && !chestsOk.length) break
    const minRank = preds.length ? Math.min(...preds.map(([, v]) => v.rank || 0)) : 0
    const tg = [...preds.map(([k, v]) => ({ k, pos: v.pos })), ...chestsOk]
    const view = planView(bot, st)
    S.view = S.honest ? view : null
    // S1f: клетка ног — с поправкой на песок душ (высота 0.875: на нём floored() — клетка самого песка). План от floored() начинался
    // внутри пола: «не шагнул vdown/up … (я …,N.88,…) пол soul_sand» — 50 из 61 остановок штрека во вслепую сериях S1e/S1f, заход с 0
    // золота при верном шаблоне. ND_SOUL_FEET=0 — прежнее.
    const feet = () => process.env.ND_SOUL_FEET === '0' ? bot.entity.position.floored() : SL.bodyCells(bot)[0]
    const me = feet()
    let starts
    const inTunnel = S.own.has(SL.keyV(me)) && !S.exposed
    if (inTunnel) starts = [{ x: me.x, y: me.y, z: me.z, g: 0 }]
    else {
      // Из открытого: клетки заливки; у брута и хоглина (10 блоков) — дороже.
      const danger = [...mobs(bot, 'piglin_brute', 40), ...mobs(bot, 'hoglin', 40)].map((e : any) => e.position)
      starts = []
      for (const n of SL.reachCells(view, process.env.ND_SOUL_FEET === '0' ? bot.entity.position : me, { radius: 28, maxNodes: 5000 })) {
        if (S.badStarts && S.badStarts.has(SL.key(n.x, n.y, n.z))) continue
        let g = n.d * 4
        for (const d of danger) { const dd = d.distanceTo(new Vec3(n.x, n.y, n.z)); if (dd < 10) g += (10 - dd) * 4 }
        starts.push({ x: n.x, y: n.y, z: n.z, g })
      }
      if (S.own.has(SL.keyV(me))) starts.push({ x: me.x, y: me.y, z: me.z, g: 0 })
    }
    const tgGoals = tg.map(t => ({ t, rank: minRank, g: SL.adjacentGoal(t.pos, view.cls), h: SL.manhattan(t.pos) }))
    if (!st.predAll) st.predAll = [...st.pred.values()].map(v => ({ rank: v.rank || 0, pos: v.pos.clone() }))
    const xs = [...starts.map(s => s.x), ...tg.map(t => t.pos.x)]
    const ys = [...starts.map(s => s.y), ...tg.map(t => t.pos.y)]
    const zs = [...starts.map(s => s.z), ...tg.map(t => t.pos.z)]
    const box = { x0: Math.min(...xs) - 14, x1: Math.max(...xs) + 14, y0: Math.max(5, Math.min(...ys) - 8), y1: Math.min(120, Math.max(...ys) + 12), z0: Math.min(...zs) - 14, z1: Math.max(...zs) + 14 }
    const t0 = gameClock.wall.now()
    const planO = {
      cls: view.cls, dig: view.dig, own: S.own, starts, box, maxNodes: inTunnel ? 60000 : 160000,
      goal: (x, y, z) => tgGoals.some(q => q.g(x, y, z)),
      h: (x, y, z) => Math.min(...tgGoals.map(q => q.h(x, y, z))),
      targets: new Set(tg.filter((t : any) => !t.chest).map(t => t.k)), vup: SL.fillerCount(bot) >= 6, vdown: !S.honest
    }
    let r = await SL.plan(planO)
    // Вход из открытой пещеры: первая клетка в толще почти всегда касается воздуха пещеры сбоку (неровная стена), и
    let entryBreach = null
    // ND_ANGER_SAFE=1: золото сломано меньше 30 с назад (злость пиглинов — 600 тиков), злые в 16 — не вскрывать ход во двор,
    // а переждать заложившись (D7s9c-31 03.10: золото в закрытом ходе, следом «вход со вскрытием» — пиглины, смерть).
    if (!r.ok && st.breach && process.env.ND_ANGER_SAFE === '1' && st.lastBreak && gameClock.now() - st.lastBreak < 30000 && angerSet(bot, null, false).length) {
      log('штрек: злость после золота — вскрытие подожду', { s: Math.round((gameClock.now() - st.lastBreak) / 1000), n: angerSet(bot, null, false).length })
      await sealBody(bot, S).catch(() => null)
      while (!ctl.aborted && gameClock.now() - st.lastBreak < 31000) await sleep(500)
    }
    if (!r.ok && st.breach && (starts.length || tg.length)) {
      const near = new Set()
      const around = (p, dyLo, dyHi) => { for (let dx = -2; dx <= 2; dx++) for (let dz = -2; dz <= 2; dz++) if (Math.abs(dx) + Math.abs(dz) <= 2) for (let dy = dyLo; dy <= dyHi; dy++) near.add(SL.key(p.x + dx, p.y + dy, p.z + dz)) }
      if (!inTunnel) for (const st0 of starts.slice().sort((a, b) => a.g - b.g).slice(0, 300)) around(st0, -1, 3)
      for (const t of (tg as any)) if (!t.chest) around(t.pos, -2, 2)
      entryBreach = ck => near.has(ck)
      const r2 = await SL.plan({ ...planO, breachOk: (ck) => entryBreach(ck), breachCost: 8 })
      log('штрек: вход из открытого со вскрытием', { ok: r2.ok, nodes: r2.nodes, why: r2.ok ? undefined : r2.why, starts: starts.length, from: inTunnel ? 'штрек' : 'снаружи' })
      if (r2.ok) r = r2
      else entryBreach = null
    }
    S.plans++
    S.planMs += gameClock.wall.now() - t0
    // Снаружи пути нет (все входы касаются чужого воздуха) — закопаться и планировать из своего кармана.
    if (!r.ok && !inTunnel && (st.burrowsSG || 0) < 2 && process.env.ND_BURROW !== '0') {
      st.burrowsSG = (st.burrowsSG || 0) + 1
      const bw = await burrow(session, ctl, st, 'штрек к золоту снаружи не начался')
      if (bw.ok) { S.exposed = SL.exposure(bot, S.own).length > 0; continue }
      log('закопаться не вышло', { why: bw.why })
    }
    if (!r.ok) {
      log('штрек: пути нет', { targets: tg.length, rank: minRank, nodes: r.nodes, why: r.why, from: inTunnel ? 'штрек' : 'снаружи', ms: gameClock.wall.now() - t0 })
      // Нет пути ни к одной цели этого ранга — отложить их; из штрека попробовать снаружи.
      for (const t of tg) st.skip.set(t.k, routeRetryAt(10 * 60000))
      if (++noPlan >= 3) break
      continue
    }
    log('штрек: план', { from: r.start, moves: r.path.length, dig: r.path.reduce((n, m) => n + m.clear.length, 0), cost: Math.round(r.cost), nodes: r.nodes, ms: gameClock.wall.now() - t0 })
    // Без золотой брони ко входу по открытому не идти (пиглины видят — бьют): закопаться здесь и планировать из своего кармана.
    if (!inTunnel && st.goldless && !(me.x === r.start.x && me.y === r.start.y && me.z === r.start.z) && (st.burrowsSG || 0) < 2 && process.env.ND_BURROW !== '0') {
      st.burrowsSG = (st.burrowsSG || 0) + 1
      const bw = await burrow(session, ctl, st, 'без золотой брони ко входу штрека по открытому не иду')
      if (bw.ok) { S.exposed = SL.exposure(bot, S.own).length > 0; continue }
      log('закопаться не вышло', { why: bw.why })
    }
    // Вход из открытого — сперва дойти ногами (без копки) до клетки входа.
    if (!inTunnel && !(me.x === r.start.x && me.y === r.start.y && me.z === r.start.z)) {
      S.walks++
      // Пол Ада для pathfinder (worlds: не ниже min(40, где стоишь)) — опустить до входа, иначе «пустой путь».
      const floor0 = bot._ndNetherFloor
      bot._ndNetherFloor = Math.min(floor0 ?? 40, r.start.y - 2)
      let w
      try { w = await walkUnlessBrute(session, ctl, new goals.GoalBlock(r.start.x, r.start.y, r.start.z), 30000, { dig: false }) } finally { bot._ndNetherFloor = floor0 }
      const f = feet()
      if (!(f.x === r.start.x && f.y === r.start.y && f.z === r.start.z)) {
        // Этот вход ногами не взять — в следующих планах его нет (sealed booth-1: 15 раз «пустой путь» к одной клетке).
        (S.badStarts || (S.badStarts = new Set())).add(SL.key(r.start.x, r.start.y, r.start.z))
        S.fails.push(`ко входу: ${(w && w.error) || 'не дошёл'}`); if (S.fails.length > 14) break
        // Пешком не выйти ни к одной клетке входа (тело в яме после спуска со столба, у злых пиглинов
        S.walkFails = (S.walkFails || 0) + 1
        if (S.walkFails >= 2) { for (const v of [f, f.offset(0, 1, 0)]) S.own.add(SL.keyV(v)); S.exposed = true }
        continue
      }
      S.exposed = true
    }
    if (!inTunnel) S.entry = { x: r.start.x, y: r.start.y, z: r.start.z }
    const prevBreach = S.breachOk
    if (entryBreach) S.breachOk = (k, nk) => entryBreach(k) || !!(prevBreach && prevBreach(k, nk))
    let ex
    try { ex = await SL.execute(session, ctl, r.path, S) } finally { if (entryBreach) S.breachOk = prevBreach }
    if (!ex.ok) {
      S.fails.push(ex.why)
      log('штрек: стоп', { why: ex.why, done: ex.done, of: r.path.length, at: xyz(bot.entity.position.floored()) })
      if (S.fails.length > 14) break
      continue
    }
    const f = feet()
    const hit = tgGoals.find(q => q.g(f.x, f.y, f.z))
    if (!hit) continue
    const t: any = hit.t
    if (t.chest) {
      // Сундук из штрека: нас не видит никто — открыть не злит (ChestBlock: злит видящих).
      let took = null
      try { took = await (require('.././structures') as typeof import('.././structures')).takeWorth(session, ctl, t.pos, { kind: 'bastion' }) } catch (e) { took = { error: e.message } }
      if (miningCycle.confirmedChestLoot(took, t.pos, ctl.aborted)) st.looted.add(t.k)
      else st.skip.set(t.k, routeRetryAt(60000))
      st.chests.push({ at: t.k, took: (took && took.took) || {}, stopped: took && (took.stopped || took.error) })
      log('штрек: сундук', { at: t.k, took: took && took.took, stopped: took && (took.stopped || took.error) })
      continue
    }
    const b = bot.blockAt(t.pos)
    // Штрек прошёл сквозь цель (золото взято по пути) — не промах.
    if (b && b.boundingBox === 'empty' && S.own.has(t.k)) { st.pred.delete(t.k); continue }
    if (!b || b.name !== 'gold_block') {
      // Стоим вплотную и видим: не золото — промах гипотезы этого ранга.
      const rank = (st.pred.get(t.k) || {}).rank
      st.pred.delete(t.k)
      st.predWrong = (st.predWrong || 0) + 1
      if (b && b.boundingBox === 'block') {
        st.rankMiss = st.rankMiss || {}
        st.rankMiss[rank] = (st.rankMiss[rank] || 0) + 1
        if (st.rankMiss[rank] >= 2) for (const [k, v] of [...st.pred.entries()]) if (v.rank === rank || (rank >= 100 && rank % 100 === 0 && Math.floor((v.rank || 0) / 100) === rank / 100)) st.pred.delete(k)
      }
      log('штрек: не золото', { at: t.k, block: b ? b.name : '?', rank })
      continue
    }
    // Ломка золота на глазах у пиглина злит всех в 16 бл. (PiglinAi.angerNearbyPiglins с проверкой луча) — штрек открыт
    const opens = goldExposes(bot, S, t.pos)
    // Ломка gold_block: requireLineOfSight=false. До изоляции мобов не вскрываем двор,
    const upC = t.pos.offset(0, 1, 0); const dnC = t.pos.offset(0, -1, 0)
    const win1 = fullCover(bot.blockAt(upC)) && !S.own.has(SL.keyV(upC)) && fullCover(bot.blockAt(dnC)) && !S.own.has(SL.keyV(dnC))
    const strongNear = [...mobs(bot, 'piglin_brute', 12), ...mobs(bot, 'hoglin', 12), ...mobs(bot, 'zoglin', 12)]
    // S1d 07.10: дыра от ломки — всегда одна клетка золота, её заделка закрывает штрек снова. Удар пиглина/брута/хоглина через
    // клетку не достаёт (Mob.getAttackBoundingBox: вширь +0.83 — от центра 1.13…1.53, а между телами 2 бл.), злость от ломки
    // (PiglinAi.angerNearbyPiglins, без луча) копке в закрытом ходе не мешает — заделать сразу. Окно 1×1 (верх и низ закрыты)
    // больше не обязательно; нужно, чтобы слиток не выпал наружу: под золотом — своё или твёрдое (ND_GOLD_OPEN=0 — прежнее
    // правило). Данные: s1c std — 98 «небезопасное вскрытие» за прогон 7777…, ~50 % золота карты оставалось в стенах.
    const dnB = bot.blockAt(dnC)
    // Под золотом ступени/плиты тоже держат слиток (pair 2: 20 из 80 пропусков — ступени кирпича), воздух — нет.
    const dropSafe = S.own.has(SL.keyV(dnC)) || dnB?.boundingBox === 'block'
    const gC = t.pos.offset(0.5, 0, 0.5)
    const strongG = [...mobs(bot, 'piglin_brute', 8, gC), ...mobs(bot, 'hoglin', 8, gC), ...mobs(bot, 'zoglin', 8, gC)].length
    const onTop = (Object.values(bot.entities) as any[]).some((e : any) => e && e !== bot.entity && e.position && /^(hostile|animal|mob|passive|water_creature|ambient)$/.test(e.type || '') &&
      Math.hypot(e.position.x - gC.x, e.position.z - gC.z) < 1.3 && e.position.y >= t.pos.y + 0.5 && e.position.y <= t.pos.y + 2.5)
    let windowOk = goldWindowOk({ win1, dropSafe, strong: strongNear.length, strongG, onTop, hp: bot.health ?? 20 })
    // Дыра от ломки безопасна, только если она — ЕДИНСТВЕННЫЙ выход хода во двор (S1d s1d-AB-4 A: заплатка прошлого золота не
    // встала, ход открыт; следующее золото «окном» — злые пиглины вошли в пролом, 5 ударов, смерть на 12-й мин). Ход открыт —
    // сперва заложиться (sealBody); не вышло — как прежде, пропуск.
    if (windowOk && opens && SL.exposure(bot, S.own).length) {
      await sealBody(bot, S).catch(() => null)
      S.exposed = SL.exposure(bot, S.own).length > 0
      if (S.exposed) { windowOk = false; log('штрек: ход открыт — окно не ломаю', { at: t.k }) }
    }
    // Пиглин, разглядывающий золото (слиток в левой руке), не «бездельник»: angerNearbyPiglins злит только PiglinAi.isIdle
    // (Brain.isActive(Activity.IDLE), javap 1.21.11 PiglinAi.angerNearbyPiglins: filter isIdle → filter canSee при ломке
    // сундука; золотой блок — без луча). Такие пиглины ломке не мешают.
    const admiring = e => /^(gold_ingot|gold_block|golden_.*)$/.test(e.equipment?.[1]?.name || '')
    const exposedFoes = st.fastSafe && opens && !windowOk ? [
      ...mobs(bot, 'piglin', 18).filter(e => !isBaby(bot, e) && !admiring(e)),
      ...mobs(bot, 'piglin_brute', 18), ...mobs(bot, 'hoglin', 18), ...mobs(bot, 'zoglin', 18)
    ] : []
    if (st.fastSafe && opens && windowOk) log('штрек: золото окном 1×1 — ломаю и сразу заделываю', { at: t.k, piglins: mobs(bot, 'piglin', 18).length })
    if (exposedFoes.length || (st.fastSafe && opens && SL.fillerCount(bot) < 3)) {
      // Пиглины бродят: отложить на 2 мин, а не на 10 (s1c-A-2 06.10: 9 из 22 блоков карты «пропустил» при 2–4 пиглинах рядом,
      // к концу захода «золото по памяти осталось (16), пути нет»). Блоков на заделку нет — по-прежнему надолго.
      st.skip.set(t.k, exposedFoes.length ? gameClock.now() + (SL.fillerCount(bot) >= 3 ? 120000 : 600000) : routeRetryAt(600000))
      log('штрек: небезопасное вскрытие — пропустил', { at: t.k, foes: exposedFoes.length, win1, dropSafe, strongG, onTop, up: bot.blockAt(upC)?.name, dn: bot.blockAt(dnC)?.name, strong: strongNear.length, hp: Math.round(bot.health ?? 0), filler: SL.fillerCount(bot) })
      continue
    }
    // Свой ход сам открыт во двор (вход «из открытого со вскрытием», заплатка не встала), а ломка злит всех пиглинов в 16 — сперва
    // заложиться, иначе отложить. S1d включил по умолчанию по одной смерти (s1d-AB-4 A) без парного A/B — S1e (проверка S1d (д)) вернул
    // как было: только ND_ANGER_SAFE=1, до A/B на снимках.
    if (process.env.ND_ANGER_SAFE === '1' && SL.exposure(bot, S.own).length && angerSet(bot, null, true).length) {
      await sealBody(bot, S).catch(() => null)
      S.exposed = SL.exposure(bot, S.own).length > 0
      if (S.exposed) {
        st.skip.set(t.k, routeRetryAt(60000))
        log('штрек: ход открыт, пиглины в 16 — золото отложил', { at: t.k, n: angerSet(bot, null, true).length })
        continue
      }
    }
    const watchers = st.fastSafe ? [] : mobs(bot, 'piglin', 16).filter(p => seesMob(bot, p))
    if (watchers.length) { st.skip.set(t.k, gameClock.now() + 20000); log('штрек: золото — видят пиглины, отложил', { at: t.k, n: watchers.length, exposed: S.exposed }); await sleep(500); continue }
    // Ломка вскроет штрек во двор, а брут рядом (сквозь стены он не видит — но пролом увидит): отложить (neF-Pa22-1).
    const brutes = mobs(bot, 'piglin_brute', 16).filter((e : any) => raySees(bot, e.position.offset(0, (e.height || 1.95) * 0.92, 0), t.pos.offset(0.5, 0.5, 0.5)))
    if (brutes.length && goldExposes(bot, S, t.pos)) { st.skip.set(t.k, gameClock.now() + 30000); log('штрек: золото у двора, брут рядом — отложил', { at: t.k, n: brutes.length, d: Math.round(Math.min(...brutes.map((e : any) => e.position.distanceTo(t.pos)))) }); await sleep(500); continue }
    const had = countOf(bot, 'gold_block')
    const Drops: typeof import('.././drops') = require('.././drops')
    const pickupMark = st.fastSafe ? Drops.pickupMark(bot) : null
    bot.setControlState('sneak', true)
    let dr
    try { dr = await SL.digCell(bot, t.pos, { allowGuard: true }) } finally { bot.setControlState('sneak', false) }
    if (dr !== 'ok') { st.skip.set(t.k, routeRetryAt(60000)); log('штрек: золото не ломается', { at: t.k, r: dr }); continue }
    S.own.add(t.k)
    st.pred.delete(t.k)
    st.blocks++
    st.lastBreak = gameClock.now()
    // Гипотеза подтверждена (3 золота на местах шаблона) — соседние гипотезы
    // других рангов (та же стена со сдвигом на блок) снять.
    const rk = hit.rank ?? 0
    st.rankHit = st.rankHit || {}
    st.rankHit[rk] = (st.rankHit[rk] || 0) + 1
    if (st.rankHit[rk] >= 3) {
      const mine = [...(st.predAll || [])].filter(q => q.rank === rk)
      for (const [k, v] of [...st.pred.entries()]) if (v.rank !== rk && mine.some(q => q.pos.distanceTo(v.pos) <= 2.5)) st.pred.delete(k)
    }
    if (st.fastSafe) {
      const Pack: typeof import('.././pack') = require('.././pack')
      const safePickup = () => {
        if (ctl.aborted || session.bot !== bot || !bot.entity || (bot.health ?? 0) <= 0 ||
          bot.game?.dimension !== dimension || bot._ndGuard?.ended || session.reflex) return false
        const body = SL.bodyCells(bot)
        if (body.some(cell => SL.classOf(bot.blockAt(cell)) !== SL.AIR) ||
          !fullCover(bot.blockAt(body[0].offset(0, -1, 0)))) return false
        return !(require('.././ne-guard') as typeof import('.././ne-guard')).hot(bot, { near: 6 }) && !foesNear(bot, 6).length
      }
      const match = (_entity, stack) => stack?.name === 'gold_block'
      const candidates = Drops.lying(bot, { from: t.pos, radius: 3, match })
      const receipt = { at: t.k, picked: 0, received: 0, gained: 0, why: '' }
      if (!safePickup()) receipt.why = 'подбор отложен: угроза или текущая клетка без подтверждённого воздуха и опоры'
      else if (!candidates.some(it => Drops.inPickup(bot.entity.position, it.rest))) receipt.why = 'подбор: нет подтверждённой стопки в рамке тела'
      else {
        receipt.picked = await Drops.collect(bot, ctl, { from: t.pos, radius: 3, match, appearMs: 0,
          timeoutMs: 1500, allowMovement: false, canContinue: safePickup,
          onStack: async it => Pack.fits(bot, 'gold_block', 1) && Drops.inPickup(bot.entity.position, it.rest) ? 'go' : 'skip' })
        receipt.received = Drops.pickupDelta(bot, pickupMark)?.gold_block || 0
        receipt.gained = Math.max(0, countOf(bot, 'gold_block') - had)
        if (!receipt.received || !receipt.gained) receipt.why = 'подбор золота сервером не подтверждён'
      }
      ;(S.goldPickups || (S.goldPickups = [])).push(receipt)
      if (S.goldPickups.length > 6) S.goldPickups.shift()
      if (receipt.why) S.fails.push(receipt.why)
      log('штрек: подбор золота', receipt)
      if (ctl.aborted || session.bot !== bot || !bot.entity || (bot.health ?? 0) <= 0 ||
        bot.game?.dimension !== dimension || bot._ndGuard?.ended || session.reflex) break
    }
    if (st.fastSafe && opens) {
      const closed = await SL.fillCell(bot, t.pos)
      if (!closed || !fullCover(bot.blockAt(t.pos))) {
        await hunker(session, ctl, st, 'золото: заплатка не встала')
        S.fails.push('золото: заплатка не встала'); break
      }
      S.own.delete(t.k); S.fills++; (S.filled || (S.filled = new Set())).add(t.k)
      S.exposed = SL.exposure(bot, S.own).length > 0
    }
    if (!st.fastSafe) {
      for (let i = 0; i < 15 && countOf(bot, 'gold_block') <= had; i++) await sleep(100)
      if (countOf(bot, 'gold_block') <= had) await pickUp(bot, ctl, 3, 2500)
    }
    // Золото касалось чужого воздуха — закрыть его клетку.
    if (SL.exposure(bot, S.own).length) {
      if (await SL.fillCell(bot, t.pos)) { S.own.delete(t.k); S.fills++; (S.filled || (S.filled = new Set())).add(t.k) }
      S.exposed = SL.exposure(bot, S.own).length > 0
    }
    log('штрек: золото', { at: t.k, blocks: countOf(bot, 'gold_block'), left: st.pred.size, hp: Math.round(bot.health ?? 0), exposed: S.exposed })
  }
  st.blocks += S.goldPassed + S.bonusBlocks
  S.goldPassed = 0
  S.bonusBlocks = 0
  return S
}

async function digToPredicted (session, ctl, st, t) {
  const bot = session.bot
  // Пол Ада для pathfinder (worlds.tuneMovements: не ниже min(40, где стоишь))
  const floor0 = bot._ndNetherFloor
  // Пол 32 (над морем лавы): к стенам ведут полы жилых блоков на y 35–40, и пол
  bot._ndNetherFloor = 32
  bot._ndMobAvoidOnly = new Set(['piglin_brute', 'hoglin'])
  bot._ndLavaStrict = true
  try { return await digToPredictedBody(session, ctl, st, t) } finally { bot._ndNetherFloor = floor0; bot._ndMobAvoidOnly = null; bot._ndLavaStrict = false }
}

async function digToPredictedBody (session, ctl, st, t) {
  const bot = session.bot
  // Стена известна — сперва на её кромку поверху (один раз за вызов).
  const pr = st.pred.get(t.k)
  if (st.outside && pr && pr.wall && !st.onWall && (st.wallTries || 0) < 2) {
    st.wallTries = (st.wallTries || 0) + 1
    // high — вход в толщу стены высоко над лавой (approachWallSide), иначе
    // прежний подход к низу внешних граней.
    const a = st.high ? await approachWallSide(session, ctl, pr.wall, t.pos) : await approachWallTop(session, ctl, pr.wall)
    st.onWall = a.ok
    log('на кромку стены', { top: xyz(a.top), ok: a.ok, error: a.error, at: xyz(bot.entity.position.floored()) })
  }
  // Брут видит нас — сначала он (столб, удары сверху: bruteDefense), а не
  // общий бой по дороге («бой без победы» с брутом и хоглином на ферме).
  if (mobs(bot, 'piglin_brute', 16).some(e => seesMob(bot, e))) { try { await bruteDefense(session, ctl, st) } catch {} }
  // Издалека — pathfinder к цели на 5 блоков (он ходит по бастиону и копает
  if (!st.onWall && t.pos.distanceTo(bot.entity.position) > 9) {
    const pf0 = bot.pathfinder
    const th0 = pf0 && pf0.thinkTimeout
    if (pf0) pf0.thinkTimeout = 12000
    try { await walkUnlessBrute(session, ctl, new goals.GoalNear(t.pos.x, t.pos.y, t.pos.z, 5), 45000, { dig: true }) } catch {} finally { if (pf0) pf0.thinkTimeout = th0 }
    if (bruteComing(bot)) return { walk: 'брут идёт', block: '?' }
  }
  // Сначала пешком (без копки) к ближайшей к цели клетке, куда можно дойти, и
  try {
    const { walkable }: typeof import('.././walkable') = require('.././walkable')
    let stage = null
    let bestD = Infinity
    for (const n of walkable(bot, bot.entity.position, { radius: 40, maxNodes: 8000 })) {
      const d = n.pos.distanceTo(t.pos)
      if (d < bestD) { bestD = d; stage = n.pos }
    }
    if (!st.onWall && stage && stage.distanceTo(bot.entity.position) > 2 && bestD + 3 < t.pos.distanceTo(bot.entity.position)) {
      await walkGoal(session, ctl, new goals.GoalBlock(stage.x, stage.y, stage.z), 30000, { dig: false })
    }
  } catch {}
  const trail = []
  const samp = gameClock.setInterval(() => { try { const f = bot.entity.position.floored(); const last = trail[trail.length - 1]; if (!last || !last.equals(f)) trail.push(f) } catch {} }, 200)
  let w
  // Свой штрек по шагу; упёрся — pathfinder с копкой (до 12 с на решение).
  let tun = null
  try {
    tun = await tunnelTo(session, ctl, t.pos)
    w = { ok: tun.ok, error: tun.why }
    // Из толщи стены (high) — только свой штрек: pathfinder с копкой уводил во двор.
    if (!tun.ok && !ctl.aborted && !(st.high && st.onWall)) {
      const pf = bot.pathfinder
      const think = pf && pf.thinkTimeout
      if (pf) pf.thinkTimeout = 12000
      try { w = await walkGoal(session, ctl, new goals.GoalGetToBlock(t.pos.x, t.pos.y, t.pos.z), 45000, { dig: true }) } finally { if (pf) pf.thinkTimeout = think }
    }
  } finally { gameClock.clearInterval(samp) }
  const b = bot.blockAt(t.pos)
  const res: any = { walk: w && w.ok ? 'ok' : (w && w.error) || '?', block: b ? b.name : '?', tunnel: tun ? { ok: tun.ok, steps: tun.steps, why: tun.why } : undefined }
  if (!(w && w.ok)) { st.skip.set(t.k, routeRetryAt(45000)); st.predMiss = (st.predMiss || 0) + 1; return res }
  if (b && b.boundingBox === 'empty' && st.blocks > 0 && t.pos.distanceTo(bot.entity.position) < 3) {
    // Воздух на месте предсказанного — уже выкопан (с видимого списка), не промах.
    st.pred.delete(t.k)
    return { ...res, r: 'уже выкопан' }
  }
  if (!b || b.name !== 'gold_block') {
    // Видим клетку, а золота нет — гипотеза этого ранга неверна целиком.
    const rank = (st.pred.get(t.k) || {}).rank
    st.pred.delete(t.k)
    st.predWrong = (st.predWrong || 0) + 1
    // Два промаха одного ранга (процессор generic превращает 30% золота в
    // треснутый кирпич — один промах ещё не приговор).
    if (b && b.boundingBox === 'block' && seesBlock(bot, b)) {
      st.rankMiss = st.rankMiss || {}
      st.rankMiss[rank] = (st.rankMiss[rank] || 0) + 1
      if (st.rankMiss[rank] >= 2) for (const [k, v] of [...st.pred.entries()]) if (v.rank === rank || (rank >= 100 && rank % 100 === 0 && Math.floor((v.rank || 0) / 100) === rank / 100)) st.pred.delete(k)
    }
    return { ...res, r: 'не золото', rank }
  }
  // Злые дойдут по штреку — закрыть его за спиной (ноги и голова).
  const set = reachSet(bot)
  const pigs = angerSet(bot).filter(e => threatens(bot, e, set))
  if (pigs.length && trail.length >= 2) {
    const { placeBlockAt }: typeof import('.././build') = require('.././build')
    const me = bot.entity.position.floored()
    const back = [...trail].reverse().find(c => !c.equals(me) && c.distanceTo(me) <= 1.5)
    if (back) {
      for (const c of [back, back.offset(0, 1, 0)]) { try { await placeBlockAt(bot, c, { timeoutMs: 1500 }) } catch {} }
      res.sealed = xyz(back)
    }
  }
  st.pred.delete(t.k)
  st.gold.set(t.k, { pos: t.pos.clone(), seen: gameClock.now() })
  res.r = await takeGoldBlock(session, ctl, t.pos, st)
  return res
}

export { planView, rememberStarts, sealedGold, digToPredicted, digToPredictedBody }
