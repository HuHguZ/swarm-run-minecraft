const { gameClock, log, mobs, sleep, xyz, Vec3, walkGoal, goals, keyOf, survey, aggressive, angerSet, pickUp, countOf }: typeof import('./take-gold-block') = require('./take-gold-block')
const { boothCandidates, tradeBreach, tradeExecute, walkUnlessBrute }: typeof import('./booth-trade') = require('./booth-trade')
const { lastGoldBreak, predictGoldAsync, eatIfHungry }: typeof import('./predict-gold') = require('./predict-gold')
const FOES_RE = /^(piglin_brute|hoglin|zoglin)$/

function foesNear (bot, r = 10) {
  return (Object.values(bot.entities || {}) as any[]).filter((e : any) => e && e.position && e !== bot.entity &&
    (FOES_RE.test(e.name || '') || (/^piglin$/.test(e.name || '') && aggressive(bot, e))) && e.position.distanceTo(bot.entity.position) < r)
}

async function towerScan (session, ctl, st) {
  const bot = session.bot
  const { towerUp }: typeof import('.././build') = require('.././build')
  // Над головой крыша (внутри бастиона вышка не росла: +0..+1, ферма 29.09) —
  // сначала к месту с небом: клетка в 20 блоках, где над головой больше воздуха.
  const headroom = p => { let n = 0; for (let y = 2; y <= 25; y++) { const b = bot.blockAt(p.offset(0, y, 0)); if (!b || b.boundingBox !== 'empty' || /lava/.test(b.name)) break; n++ } return n }
  // Лава рядом с местом вышки (в 3 блоках вбок, от 4 ниже до 3 выше ног): столб там кончался падением в
  // лаву (pit-v5-14 30.09: вышка у 93,41,91, спуск — «tried to swim in lava», pit-v5-16 — ожоги у 96,39,90).
  const lavaNear = p => {
    for (let dx = -3; dx <= 3; dx++) for (let dz = -3; dz <= 3; dz++) for (let dy = -4; dy <= 3; dy++) {
      const b = bot.blockAt(p.offset(dx, dy, dz)); if (b && b.name === 'lava') return true
    }
    return false
  }
  const here0 = bot.entity.position.floored()
  if (headroom(here0) < 14 || lavaNear(here0)) {
    const { walkable }: typeof import('.././walkable') = require('.././walkable')
    let best = null
    for (const n of walkable(bot, bot.entity.position, { radius: 20, maxNodes: 3000 })) {
      const h = headroom(n.pos)
      if (h < 14 || lavaNear(n.pos)) continue
      const score = h - n.d * 0.3
      if (!best || score > best.score) best = { pos: n.pos, score, h }
    }
    if (best) await walkUnlessBrute(session, ctl, new goals.GoalBlock(best.pos.x, best.pos.y, best.pos.z), 25000, { dig: false })
  }
  // Вышка и штрек — из блоков стройки; после долгого пути по Аду их нет (trip2-9 30.09: вышка +0..+1,
  // «бастион не узнан»). Добрать незерака рядом.
  const SLf: typeof import('.././sealed') = require('.././sealed')
  if (SLf.fillerCount(bot) < 24) {
    try { const g = await (require('.././edges') as typeof import('.././edges')).gatherBlocks(bot, ctl, { want: 40 - SLf.fillerCount(bot), maxMs: 40000, radius: 10 }); log('вышка: блоки', { got: g && g.got, have: SLf.fillerCount(bot) }) } catch {}
  }
  const base = bot.entity.position.floored()
  let pg = await predictGoldAsync(bot, 56, ctl)
  let steps = 0
  // Выше, пока гипотеза стен слабая: один вал (score 3, голос одного вала) давал стену не там —
  const sure = q => q.direct.length > 0 || (q.walls.length > 0 && q.walls[0].from.length >= 2) || (q.start && q.start.score >= 1)
  // Стрелки на виду (гаст в 48; пиглины без нашего золота, скелеты, ифриты в 24) — выше не строить: со столба тело не уходит,
  // шар гаста сбрасывает (b5-6-1 14.10: вышка до y 85, шар → хп 2), арбалеты пиглинов добивают.
  const shootersNear = () => {
    const gold = [5, 6, 7, 8].some(s => /^golden_/.test(bot.inventory.slots[s]?.name || ''))
    const seen = (require('.././perception/eyes') as typeof import('.././perception/eyes')).entities(bot, { radius: 48 }).filter(e => e.seen && e.dist != null &&
      ((e.name === 'ghast' && e.dist <= 48) || (/^(skeleton|blaze)$/.test(e.name) && e.dist <= 24) || (e.name === 'piglin' && !gold && e.dist <= 24)))
    // Гаста слышно (громкий звук, 80 бл.: senses.heard) — тоже не строить.
    const heard = (require('.././perception/senses') as typeof import('.././perception/senses')).heard(bot, { sinceMs: 15000, match: /ghast/ }).map(h => ({ name: 'ghast (слышно)', dist: 0 }))
    return [...seen, ...heard]
  }
  const topY = Math.max(84, base.y + 6)
  while (!ctl.aborted && !sure(pg) && steps < 5 && bot.entity.position.y < topY) {
    const sh = process.env.ND_TOWER_SHOOTERS !== '0' ? shootersNear() : []
    if (sh.length) { log('вышка: стрелки рядом — выше не строю', { n: sh.length, near: sh.slice(0, 3).map(e => `${e.name} ${Math.round(e.dist)}`) }); break }
    const y0 = bot.entity.position.y
    const up = await towerUp(bot, ctl, Math.min(6, topY - Math.floor(bot.entity.position.y)), {
      abortIf: () => process.env.ND_TOWER_SHOOTERS !== '0' && shootersNear().length ? 'стрелки рядом' : null
    })
    if (!up.placed) { log('вышка: стоп', { reason: up.reason, why: up.why }); break }
    steps++
    pg = await predictGoldAsync(bot, 56, ctl)
    if (bot.entity.position.y < y0 + 0.9) break
  }
  const top = bot.entity.position.floored()
  // Слепая вышка (ни базальта, ни сундуков — столб в толще незерака): следующая — не отсюда.
  st.blindTower = !pg.basalt && !pg.chests && !(st.bricks && st.bricks.size)
  log('вышка', { from: xyz(base), to: xyz(top), blind: st.blindTower || undefined, basalt: pg.basalt, chests: pg.chests, walls: pg.walls.map(w => ({ at: xyz(w.wall.t), r: w.wall.r, score: Math.round(w.score), from: w.from.length })), direct: pg.direct.map(c => c.piece), gold: pg.gold.length, start: pg.start ? { type: pg.start.type, score: Math.round(pg.start.score * 10) / 10, pieces: pg.start.pieces } : undefined, votes: pg.debug && pg.debug[0] })
  // Две лучшие гипотезы стен (ранг 0 и 1): вал над connected_wall тоже бывает
  const bp: typeof import('.././bastion-pieces') = require('.././bastion-pieces')
  // ND_BASTION_HYP_FOCUS: цели — только гипотезы старта на сетке (rememberStarts, у каждой цели — её гипотеза).
  const focus = process.env.ND_BASTION_HYP_FOCUS !== '0'
  if (focus) (require('./sealed-gold') as typeof import('./sealed-gold')).rememberStarts(bot, st, pg.start?.all)
  if (!focus) pg.walls.slice(0, 2).forEach((w, rank) => {
    for (const c of [w.wall, w.conn]) {
      for (const v of bp.goldOf(c)) {
        const k = keyOf(v)
        if (!st.pred.has(k) && !st.gold.has(k)) st.pred.set(k, { pos: v, piece: c.piece, rank, wall: c })
      }
    }
  })
  if (!focus) for (const g of pg.gold.filter(x => x.src === 'сундук')) {
    const k = keyOf(g.pos)
    if (!st.pred.has(k) && !st.gold.has(k)) st.pred.set(k, { pos: g.pos, piece: g.piece, rank: 0 })
  }
  if (!focus) for (const g of pg.gold.filter(x => x.src === 'старт')) {
    const k = keyOf(g.pos)
    if (!st.pred.has(k) && !st.gold.has(k)) st.pred.set(k, { pos: g.pos, piece: g.piece, rank: g.rank, wall: g.wall })
  }
  if (pg.start) st.start = { type: pg.start.type, r: pg.start.r, t: pg.start.t, score: Math.round(pg.start.score * 10) / 10, pieces: pg.start.pieces }
  // С вышки видно золото и сундуки двора — их тоже в цели (закрытый штрек).
  try { survey(bot, st, 56) } catch {}
  const w0 = pg.walls[0]
  if (w0 && !focus) for (const c of [w0.wall, w0.conn]) { const P = bp.lib()[c.piece]; for (const [x, y, z] of (P.chests || [])) { const v = bp.toWorld(c, x, y, z); const k = keyOf(v); if (!st.chestSeen.has(k) && !st.looted.has(k)) st.chestSeen.set(k, { pos: v, seen: gameClock.now(), pred: true }) } }
  // Вниз — свой столб из-под ног (блоки вернутся), не прыжком.
  for (let i = 0; i < 30 && !ctl.aborted; i++) {
    const f = bot.entity.position.floored()
    if (f.y <= base.y) break
    const below = bot.blockAt(f.offset(0, -1, 0))
    if (!below || below.boundingBox !== 'block') { await sleep(300); continue }
    try { await bot.dig(below, true) } catch { break }
    await sleep(250)
  }
  return pg
}

async function approachWallTop (session, ctl, wall) {
  const bot = session.bot
  const bp: typeof import('.././bastion-pieces') = require('.././bastion-pieces')
  // Снаружи, у внешних граней стены (шаблон x=0 и z=15 — там не двор
  for (const [x, y, z] of [[-3, 9, 10], [8, 9, 18]]) {
    const p = bp.toWorld(wall, x, y, z)
    const floor0 = bot._ndNetherFloor
    bot._ndNetherFloor = Math.max(32, p.y - 6)
    const pf = bot.pathfinder
    const th = pf && pf.thinkTimeout
    if (pf) pf.thinkTimeout = 12000
    let w
    try { w = await walkUnlessBrute(session, ctl, new goals.GoalNear(p.x, p.y, p.z, 3), 25000, { dig: true }) } finally { bot._ndNetherFloor = floor0; if (pf) pf.thinkTimeout = th }
    if (bot.entity.position.distanceTo(p.offset(0.5, 0, 0.5)) < 5) return { ok: true, top: p }
    if (w && /брут/.test(w.error || '')) return { ok: false, top: p, error: w.error }
  }
  // Кромка поверху (z 0..2 над слоем 23) не нашлась ни разу: pathfinder не
  // мостит 40+ блоков над двором («No path»). Не пробуем.
  return { ok: false, top: bp.toWorld(wall, 8, 24, 1), error: 'снаружи к стене не подошёл' }
}

async function approachWallSide (session, ctl, wall, target) {
  const bot = session.bot
  const bp: typeof import('.././bastion-pieces') = require('.././bastion-pieces')
  const { walkable }: typeof import('.././walkable') = require('.././walkable')
  const a = bp.toWorld(wall, 0, 0, 0)
  const b = bp.toWorld(wall, 15, 0, 15)
  const box = { x0: Math.min(a.x, b.x), x1: Math.max(a.x, b.x), z0: Math.min(a.z, b.z), z1: Math.max(a.z, b.z), y0: wall.t.y, y1: wall.t.y + 31 }
  const inBox = q => q.x >= box.x0 && q.x <= box.x1 && q.z >= box.z0 && q.z <= box.z1 && q.y >= box.y0 && q.y <= box.y1
  const stone = q => { const s = bot.blockAt(q); return !!s && s.boundingBox === 'block' && /blackstone|basalt/.test(s.name) }
  const overLava = q => {
    for (let d = 1; d <= 20; d++) {
      const s = bot.blockAt(q.offset(0, -d, 0))
      if (!s) return true
      if (/lava/.test(s.name)) return true
      if (s.boundingBox === 'block') return false
    }
    return true
  }
  const minY = wall.t.y + 13
  let best = null
  let nodes = 0
  for (const n of walkable(bot, bot.entity.position, { radius: 64, maxNodes: 16000 })) {
    nodes++
    const q = n.pos
    if (q.y < minY) continue
    let side = null
    for (const [dx, dz] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
      const w = q.offset(dx, 0, dz)
      if (inBox(w) && stone(w) && stone(w.offset(0, 1, 0))) { side = w; break }
    }
    if (!side || overLava(q)) continue
    const score = n.d * 0.5 + q.distanceTo(target) * 1.5
    if (!best || score < best.score) best = { q, side, score, steps: n.d }
  }
  if (!best) {
    // Ногами (без копки) не подойти — бастион за морем лавы или за скалой
    const me = bot.entity.position
    const cx = Math.max(box.x0 - 1, Math.min(box.x1 + 1, Math.floor(me.x)))
    const cz = Math.max(box.z0 - 1, Math.min(box.z1 + 1, Math.floor(me.z)))
    const ey = wall.t.y + 16
    const entry = new Vec3(cx, ey, cz)
    log('вход в стену: копая', { to: xyz(entry), nodes })
    const pf = bot.pathfinder
    const th = pf && pf.thinkTimeout
    if (pf) pf.thinkTimeout = 12000
    let w
    try { w = await walkUnlessBrute(session, ctl, new goals.GoalNear(entry.x, entry.y, entry.z, 2), 60000, { dig: true }) } finally { if (pf) pf.thinkTimeout = th }
    const ok = bot.entity.position.distanceTo(entry.offset(0.5, 0, 0.5)) <= 3.5 && !overLava(bot.entity.position.floored())
    return { ok, top: entry, nodes, error: ok ? undefined : (w && w.error) || 'копая к стене не дошёл' }
  }
  log('вход в стену', { at: xyz(best.q), side: xyz(best.side), steps: best.steps, target: xyz(target), nodes })
  const w = await walkUnlessBrute(session, ctl, new goals.GoalBlock(best.q.x, best.q.y, best.q.z), 40000, { dig: false })
  const ok = bot.entity.position.floored().distanceTo(best.q) <= 1.5
  return { ok, top: best.q, error: ok ? undefined : (w && w.error) || 'не дошёл' }
}

async function routeGold (session, ctl, st, until) {
  const bot = session.bot
  const NR: typeof import('.././nether-route') = require('.././nether-route')
  const SL: typeof import('.././sealed') = require('.././sealed')
  if (!NR.enabled() || !NR.gridOf(session)) return { tried: 0 }
  const out: any = { tried: 0, dug: 0, routeFails: 0, skipped: 0, sealed: 0 }
  const KG = [...st.pred.values()].map(v => v.pos).filter(Boolean)
  if (!KG.length) return out
  const xs = KG.map(q => q.x); const ys = KG.map(q => q.y); const zs = KG.map(q => q.z)
  const zone = [Math.min(...xs) - 12, Math.min(...ys) - 6, Math.min(...zs) - 12, Math.max(...xs) + 12, Math.max(...ys) + 8, Math.max(...zs) + 12]
  const tried = new Set()
  const home = bot.entity.position.floored()
  for (let n = 0; n < 40 && !ctl.aborted && gameClock.now() < until - 20000; n++) {
    if (st.fastSafe && st.stopMining && st.stopMining()) break
    // ND_GUARD=1: злой пиглин/брут бьёт — ответ до следующего золота (B0-31/B0-3 03.10: пиглин, разозлённый ломкой, 5 ударов
    // за 4 с, а тело ломало следующее золото по сетке).
    if (process.env.ND_GUARD !== '0') {
      const GD: typeof import('.././ne-guard') = require('.././ne-guard')
      const h = GD.hot(bot)
      if (h) {
        const rr = await GD.react(session, ctl, { force: h, onOwn: cells => { if (st.sealedState && st.sealedState.own) for (const c of cells) st.sealedState.own.add(c) } })
        if (rr.cancelled || ctl.aborted || session.bot !== bot) break
        if (rr.acted !== false) {
          out.guards = (out.guards || 0) + 1
          log('золото по сетке: страж', { why: h.why, how: rr.how, hp: Math.round(bot.health ?? 0) })
          if (rr.how === 'яма' || rr.how === 'столб') break
          continue
        }
      }
    }
    if ((bot.health ?? 20) < 10) { await eatIfHungry(session, ctl); if ((bot.health ?? 20) < 10) break }
    const me = bot.entity.position
    const left = [...st.pred.entries()].filter(([k, v]) => !tried.has(k) && v.pos).sort((a, b) => a[1].pos.distanceTo(me) - b[1].pos.distanceTo(me))
    if (!left.length) break
    const [k, v] = left[0]
    tried.add(k)
    const G = v.pos
    const b0 = bot.blockAt(G)
    if (b0 && b0.name !== 'gold_block') { st.pred.delete(k); continue }
    // Брут/хоглин рядом с этим золотом — пропустить (ломка злит, ход у двора); места брутов из копии мира — тоже.
    if ([...mobs(bot, 'piglin_brute', 40), ...mobs(bot, 'hoglin', 40)].some((e : any) => e.position.distanceTo(G) < 12)) { out.skipped++; continue }
    if (NR.bruteSpots(session).some(b => Math.hypot(b[0] - G.x, b[2] - G.z) < 10 && Math.abs(b[1] - G.y) < 6)) { out.skipped++; out.bruteHome = (out.bruteHome || 0) + 1; continue }
    out.tried++
    const rr = await NR.routeTo(session, ctl, { x: G.x, y: G.y, z: G.z, r: 1, dy: 1, zone, zoneExpo: 14, abortNear: { re: /^(piglin_brute|hoglin)$/, r: 10 }, timeoutSeconds: Math.max(30, Math.min(180, Math.round((until - gameClock.now()) / 1000) - 20)) })
    if (!rr.ok) {
      out.routeFails++
      // Ход брошен из-за брута/хоглина рядом — всё золото по сетке бросить, а не следующее (D7e-25 03.10: три цели подряд
      // мимо того же брута, на третьей — удары, смерть).
      if (/рядом (piglin_brute|hoglin)/.test(rr.why || '')) { out.stopped = rr.why; break }
      continue
    }
    for (const c of (rr.own || [])) { if (st.sealedState && st.sealedState.own) st.sealedState.own.add(c) }
    const b1 = bot.blockAt(G)
    if (!b1 || b1.name !== 'gold_block') { st.pred.delete(k); continue }
    // Ломка золота злит всех пиглинов в 16 бл. без луча (PiglinAi.angerNearbyPiglins, requireLineOfSight=false). Клетка
    {
      const ownS = (st.sealedState && st.sealedState.own) || new Set()
      const body = [bot.entity.position.floored(), bot.entity.position.floored().offset(0, 1, 0)]
      const openNext = [[1, 0, 0], [-1, 0, 0], [0, 1, 0], [0, -1, 0], [0, 0, 1], [0, 0, -1]].some(([dx, dy, dz]) => {
        const q = G.offset(dx, dy, dz); const bq = bot.blockAt(q)
        return bq && bq.boundingBox === 'empty' && !ownS.has(`${q.x},${q.y},${q.z}`) && !body.some(v => v.equals(q))
      })
      // S1d 07.10: злость страшна только тем, кто нас видит или дойдёт (как takeGoldBlock: threatens по заливке тела) — из своего хода
      // клетку золота сломать и сразу заделать (ниже: foreign → fillCell). Было: любой пиглин в 16 — пропуск (s1d-AB-2: 14 из 16).
      if (openNext) {
        const TG: typeof import('./take-gold-block') = require('./take-gold-block')
        const reach = TG.reachSet(bot)
        const near = angerSet(bot, null, !!bot.getControlState('sneak'))
        if (near.some(e => TG.threatens(bot, e, reach))) { out.skippedPig = (out.skippedPig || 0) + 1; continue }
        if (near.length) out.angerBlind = (out.angerBlind || 0) + 1
      }
    }
    const r = await SL.digCell(bot, G, { allowGuard: true }).catch(e => 'err ' + e.message)
    if (r !== 'ok' && r !== 'air') { log('золото по сетке: не сломал', { at: xyz(G), r }); continue }
    out.dug++
    // Ломка злит пиглинов на 30 с — отметка для ND_ANGER_SAFE (ревью Codex ne-deaths.md №2: золото по сетке её не ставило).
    st.lastBreak = gameClock.now()
    if (st.sealedState) st.sealedState.lastBreak = st.lastBreak
    st.pred.delete(k)
    st.blocks++
    // Клетка золота касается чужого воздуха — заделать (свой ход не вскрывать во двор).
    await sleep(250)
    const own = (st.sealedState && st.sealedState.own) || new Set()
    const foreign = [[1, 0, 0], [-1, 0, 0], [0, 1, 0], [0, -1, 0], [0, 0, 1], [0, 0, -1]].some(([dx, dy, dz]) => {
      const q = G.offset(dx, dy, dz); const bq = bot.blockAt(q)
      return bq && bq.boundingBox === 'empty' && !own.has(`${q.x},${q.y},${q.z}`) && !(q.equals(bot.entity.position.floored()) || q.equals(bot.entity.position.floored().offset(0, 1, 0)))
    })
    if (foreign) { await pickUp(bot, ctl, 2, 1200).catch(() => null); if (await SL.fillCell(bot, G)) out.sealed++ }
    log('золото по сетке', { at: xyz(G), steps: rr.steps, foreign, left: st.pred.size, bag: countOf(bot, 'gold_block') })
  }
  // Назад, откуда начинали (свой закрытый ход после sealedGold): от последнего золота у двора план ямы для бартера
  const homeD = bot.entity.position.floored().distanceTo(home)
  // ND_GOLD_BACK=1 (по умолчанию нет: D7b-32 03.10 — из начала хода «яма: пути нет» ×10, 15 золотых блоков без бартера).
  if (process.env.ND_GOLD_BACK === '1' && out.dug && !ctl.aborted && homeD > 1.5 && homeD <= 20 && ![...mobs(bot, 'piglin_brute', 24), ...mobs(bot, 'hoglin', 24)].length) {
    const back: Partial<import('.././nether-route').NetherRouteResult> = await NR.routeTo(session, ctl, { x: home.x, y: home.y, z: home.z, r: 0, dy: 0, zone, zoneExpo: 14, abortNear: { re: '^(piglin_brute|hoglin)$', r: 12 }, timeoutSeconds: 60 }).catch(e => ({ ok: false, why: e.message }))
    out.back = back.ok ? 'да' : back.why
    for (const c of (back.own || [])) { if (st.sealedState && st.sealedState.own) st.sealedState.own.add(c) }
  }
  log('золото по сетке: итог', out)
  return out
}

// Local head window: discover through ONE observed block, not a room from raw chunks.
async function digWallBooth (session, ctl, st, until, { peekOnly = false }: any = {}) {
  const bot = session.bot
  const SL: typeof import('../sealed') = require('../sealed')
  const E: typeof import('../perception/eyes') = require('../perception/eyes')
  const P: typeof import('../pick') = require('../pick')
  const { fullCover, isBaby }: typeof import('./take-gold-block') = require('./take-gold-block')
  const S = st.sealedState
  if (!S || ctl.aborted || !bot.entity.onGround || SL.fillerCount(bot) < 1) return null
  const F = SL.bodyCells(bot)[0]; const world = bot.world
  const sameBody = () => session.bot === bot && bot.world === world && (bot.health ?? 0) > 0
  const home = () => sameBody() &&
    bot.entity.onGround && SL.bodyCells(bot)[0].equals(F)
  const seen = () => E.entities(bot, { radius: 16, rememberMs: 0, hearMs: 0 }).filter(e => e.seen)
    .map(e => bot.entities[e.id]).filter(Boolean)
  const read = v => v.equals(F.offset(0, -1, 0)) || E.seesNow(bot, v) ? bot.blockAt(v, false) : null
  const firm = v => { const b = read(v); return fullCover(b) && [SL.SOLID, SL.HARD, SL.GUARD].includes(SL.classOf(b)) }
  const trustedOwn = new Set(process.env.ND_BARTER_TRADER_MEMORY === '1' && S.exposed === false ? S.own : [])
  const enclosed = v => firm(v) || v.y>=F.y && v.y<=F.y+1 && trustedOwn.has(SL.keyV(v)) && SL.classOf(read(v))===SL.AIR
  const dirs = [[1, 0], [-1, 0], [0, 1], [0, -1]]
  const shell = [F.offset(0, -1, 0), F.offset(0, 2, 0), ...dirs.flatMap(([x,z]) => [F.offset(x,0,z), F.offset(x,1,z)])]
  if (!home() || !shell.every(enclosed)) { log('окно стены: кожух не замкнут', { at: xyz(F) }); return null }
  if (!bot._ndWallBoothTried || bot._ndWallBoothTried.world !== world) bot._ndWallBoothTried = { world, cells: new Map() }
  const tried = bot._ndWallBoothTried.cells
  for (const [k,t] of tried) if (gameClock.now()<t || gameClock.now()-t>=30000) tried.delete(k)
  const TM: typeof import('./trader-memory') | null = process.env.ND_BARTER_TRADER_MEMORY === '1' ? require('./trader-memory') : null
  const hints = TM ? TM.hints(bot) : []
  const candidates = dirs.map(([x,z]) => ({ d: [x,z], W: F.offset(x,1,z) }))
    .sort((a,b) => (TM ? TM.score(F,b.d,hints)-TM.score(F,a.d,hints) : 0) || Number(/blackstone|basalt/.test(read(b.W)?.name || '')) - Number(/blackstone|basalt/.test(read(a.W)?.name || '')))
  for (const { d, W } of candidates) {
    if (!home() || ctl.aborted || gameClock.now() > until - 12000) break
    if (gameClock.now() - (tried.get(SL.keyV(W)) ?? -Infinity) < 30000 || SL.classOf(read(W)) !== SL.SOLID) continue
    const face = new Vec3(-d[0],0,-d[1]); const aim = P.faceAim(bot,W,face)
    if (!aim) continue
    const close = async () => {
      S.exposed = true
      const G: typeof import('../ne-guard') = require('../ne-guard')
      if (G.busy(bot)) {
        await Promise.race([G.waitIdle(bot,1500), sleep(2000)])
        if (G.busy(bot)) return false
      }
      if (!sameBody() || !E.seesNow(bot,W)) return false
      await SL.fillCell(bot,W) // bounded cleanup also when the trade controller was cancelled
      const closed = firm(W)
      S.exposed = !closed || !home() || !shell.every(enclosed)
      log('окно стены: закрыто', { at: xyz(W), closed })
      return closed
    }
    let handedOff = false; let discovered = false
    try {
      st.doing = 'окно стены: проба'
      const dr = await SL.digCell(bot,W,{face,aim,interrupted:()=>ctl.aborted || !home()})
      if (!['ok','air'].includes(dr)) continue
      S.exposed = true
      if (S.filled) S.filled.delete(SL.keyV(W))
      await sleep(150)
      const threat = () => seen().find(e => /^(piglin_brute|hoglin|zoglin)$/.test(e.name) ||
        e.name === 'piglin' && (aggressive(bot,e) || isBaby(bot,e)) && e.position.distanceTo(bot.entity.position) < 4)
      if (threat()) { log('окно стены: угроза', {}); return null }
      if (ctl.aborted || !home() || !seen().some(e => e.name === 'piglin' && !isBaby(bot,e))) continue
      const eyeSees = pg => {
        const eye = P.eyeOf(bot); const delta = pg.position.offset(0,1.79,0).minus(eye); const n = delta.norm()
        return n > 0 && !P.blockOnRay(bot,eye,delta.scaled(1/n),n)
      }
      const intact = () => home() && shell.filter(q=>!q.equals(W)).every(enclosed) && SL.classOf(read(W)) === SL.AIR
      if (!intact()) continue
      log('окно стены: взрослые видны', { at: xyz(W), pigs: seen().filter(e=>e.name==='piglin' && !isBaby(bot,e)).length })
      discovered = true
      if (TM) TM.traders(bot,64) // freeze the observation while the aperture is still open
      if (peekOnly) return { peeked:true, adults:seen().filter(e=>e.name==='piglin' && !isBaby(bot,e)).length }
      handedOff = true
      return { kind:'wall', wall:true, F:xyz(F), W:xyz(W), C:xyz(W.offset(0,-1,0)),
        O:xyz(F.offset(2*d[0],0,2*d[1])), d, p:[d[1],d[0]], sill:true, seen, threat, eyeSees, intact, close }
    } finally {
      if (!handedOff) {
        if (!discovered) tried.set(SL.keyV(W),gameClock.now())
        if (!(await close()) && home()) throw new Error('окно стены не закрылось')
      }
    }
  }
  return null
}

// Bounded reconnaissance in already dug, same-floor tunnel; no path into inferred sound coordinates.
async function peekTraders (session,ctl,st,until) {
  if(process.env.ND_BARTER_TRADER_MEMORY!=='1')return null
  const bot=session.bot, S=st.sealedState
  const TM: typeof import('./trader-memory')=require('./trader-memory')
  const SL: typeof import('../sealed')=require('../sealed')
  const G: typeof import('../ne-guard')=require('../ne-guard')
  const { isBaby, aggressive }: typeof import('./take-gold-block')=require('./take-gold-block')
  const hints=TM.hints(bot), world=bot.world, now=gameClock.now()
  const last=bot._ndTraderPeekAt??-Infinity
  if(!S || !hints.length || ctl.aborted || G.busy(bot) || now>=until || now>=last && now-last<15000)return null
  bot._ndTraderPeekAt=now
  const start=SL.bodyCells(bot)[0], q=[{v:start,path:[]}], visited=new Set([SL.keyV(start)])
  const own=v=>S.own.has(SL.keyV(v)) && S.own.has(SL.keyV(v.offset(0,1,0)))
  for(let i=0;i<q.length && q.length<256;i++) {
    const r=q[i]; if(r.path.length>=8)continue
    for(const [x,z] of [[1,0],[-1,0],[0,1],[0,-1]]) {
      const v=r.v.offset(x,0,z), k=SL.keyV(v)
      if(visited.has(k) || !own(v))continue
      visited.add(k);q.push({v,path:[...r.path,v]})
    }
  }
  const cost=r=>Math.min(...hints.map(h=>Math.hypot(h.position.x-r.v.x,h.position.z-r.v.z)))+r.path.length*.25
  const safe=()=>!ctl.aborted && session.bot===bot && bot.world===world && (bot.health??0)>0 && gameClock.now()<until && !G.busy(bot) &&
    !TM.visible(bot).some(e=>/^(piglin_brute|hoglin|zoglin)$/.test(e.name) || e.name==='piglin' &&
      new Vec3(e.pos.x,e.pos.y,e.pos.z).distanceTo(bot.entity.position)<4 && (aggressive(bot,bot.entities[e.id]) || isBaby(bot,bot.entities[e.id])))
  // Paths were rooted at start. Try one station per call, preserving a known route and bounded cost.
  const target=q.sort((a,b)=>cost(a)-cost(b))[0]
  for(const to of target.path) {
    if(!safe())return null
    const at=SL.bodyCells(bot)[0]
    const read=v=>(require('../perception/eyes') as typeof import('../perception/eyes')).seesNow(bot,v)?bot.blockAt(v,false):null
    if(!own(to) || at.y!==to.y || Math.abs(at.x-to.x)+Math.abs(at.z-to.z)!==1 || SL.classOf(read(to))!==SL.AIR || SL.classOf(read(to.offset(0,1,0)))!==SL.AIR ||
      ![SL.SOLID,SL.HARD,SL.GUARD].includes(SL.classOf(read(to.offset(0,-1,0)))))return null
    if(!(await SL.stepMove(bot,ctl,{kind:'walk',to},safe)))return null
  }
  if(!safe())return null
  const r=await digWallBooth(session,ctl,st,until,{peekOnly:true})
  log('бартер: разведка торговцев',{station:xyz(target.v),steps:target.path.length,peeked:!!r,...TM.stats(bot)})
  return r
}

async function digBooth (session, ctl, st, until) {
  if (process.env.ND_BARTER_WALL_BOOTH === '1') return digWallBooth(session, ctl, st, until)
  const bot = session.bot
  const SL: typeof import('.././sealed') = require('.././sealed')
  const S = st.sealedState
  if (!S) return null
  S.deadline = until
  S.noBonus = true // руда золота Ада злит пиглинов — у окна её не трогать
  for (let tries = 0; tries < 3 && !ctl.aborted && gameClock.now() < until - 20000; tries++) {
    const view = SL.worldView(bot)
    const cands = boothCandidates(bot, view, S.own).slice(0, 16)
    if (!cands.length) { log('окно: места у пиглинов нет', { pigs: mobs(bot, 'piglin', 40).length }); return null }
    const me = bot.entity.position.floored()
    const goalMap = new Map(cands.map(b => [SL.key(b.F.x, b.F.y, b.F.z), b]))
    const xs = [me.x, ...cands.map(b => b.F.x)]; const ys = [me.y, ...cands.map(b => b.F.y)]; const zs = [me.z, ...cands.map(b => b.F.z)]
    const box = { x0: Math.min(...xs) - 10, x1: Math.max(...xs) + 10, y0: Math.max(5, Math.min(...ys) - 8), y1: Math.min(120, Math.max(...ys) + 8), z0: Math.min(...zs) - 10, z1: Math.max(...zs) + 10 }
    const hs = cands.map(b => b.F)
    const r = await SL.plan({
      cls: view.cls, dig: view.dig, own: S.own, box, maxNodes: 80000, vup: SL.fillerCount(bot) >= 6, breachOk: tradeBreach(S),
      starts: [{ x: me.x, y: me.y, z: me.z, g: 0 }],
      goal: (x, y, z) => goalMap.has(SL.key(x, y, z)),
      h: (x, y, z) => Math.min(...hs.map(t => Math.abs(x - t.x) + Math.abs(y - t.y) + Math.abs(z - t.z)))
    })
    if (!r.ok) { log('окно: пути нет', { cands: cands.length, nodes: r.nodes, why: r.why }); return null }
    const last = r.path.length ? r.path[r.path.length - 1].to : me
    const bo: any = goalMap.get(SL.key(last.x, last.y, last.z))
    log('окно: план', { at: bo.F, window: bo.W, wide: bo.wide, pigs: bo.pigs, brutes: bo.brutes, moves: r.path.length })
    const ex = await tradeExecute(session, ctl, r.path, S)
    if (!ex.ok) { S.fails.push('окно: ' + ex.why); continue }
    // Окно вскрывать, когда злость от золота остыла (600 тиков): злой арбалетчик стреляет в окно.
    for (let w = 0; w < 40 && gameClock.now() - lastGoldBreak(st) < 33000 && !ctl.aborted; w++) await sleep(1000)
    const Wv = new Vec3(bo.W.x, bo.W.y, bo.W.z)
    if (bo.wide) {
      // Сперва ниши у головы (закрыто), потом боковые окна и среднее.
      const [px, pz] = bo.p
      for (const sg of [1, -1]) { const r0 = await SL.digCell(bot, new Vec3(bo.F.x + sg * px, bo.F.y + 1, bo.F.z + sg * pz)); if (r0 === 'ok' || r0 === 'air') S.own.add(SL.key(bo.F.x + sg * px, bo.F.y + 1, bo.F.z + sg * pz)) }
      for (const sg of [1, -1]) await SL.digCell(bot, Wv.offset(sg * px, 0, sg * pz))
    }
    const dr = await SL.digCell(bot, Wv)
    if (dr !== 'ok' && dr !== 'air') { S.fails.push('окно: ' + dr); continue }
    S.exposed = true
    bo.at = xyz(bot.entity.position.floored())
    return bo
  }
  return null
}

function pocketOpen (bot, k, skip, limit = 300) {
  const [x0, y0, z0] = k.split(',').map(Number)
  const seen = new Set([k])
  const q = [[x0, y0, z0]]
  // Моб, уже стоящий в закрытом кармане, — тоже угроза (ревью Codex 30.09: pocketOpen видел только блоки).
  const foes = (Object.values(bot.entities) as any[]).filter((e : any) => e && e.position && /^(piglin_brute|hoglin|zoglin|piglin|zombified_piglin|wither_skeleton|magma_cube|blaze)$/.test(e.name || '') && e.position.distanceTo(new Vec3(x0, y0, z0)) < 12)
    .map((e : any) => Math.floor(e.position.x) + ',' + Math.floor(e.position.y) + ',' + Math.floor(e.position.z))
  for (let i = 0; i < q.length; i++) {
    if (seen.size > limit) return true
    if (foes.includes(q[i].join(','))) return true
    const [x, y, z] = q[i]
    for (const [dx, dy, dz] of [[1, 0, 0], [-1, 0, 0], [0, 1, 0], [0, -1, 0], [0, 0, 1], [0, 0, -1]]) {
      const nk = (x + dx) + ',' + (y + dy) + ',' + (z + dz)
      if (seen.has(nk) || skip.has(nk)) continue
      const b = bot.blockAt(new Vec3(x + dx, y + dy, z + dz))
      if (!b) return true
      if (b.boundingBox !== 'empty') continue
      seen.add(nk)
      q.push([x + dx, y + dy, z + dz])
    }
  }
  return false
}

function mergeTrades (a, b) {
  const sum = (x, y) => (x || 0) + (y || 0)
  const addMap = (x, y) => { const o = { ...(x || {}) }; for (const [k, v] of (Object.entries(y || {}) as [string, any][])) o[k] = (o[k] || 0) + v; return o }
  const out = { ...b }
  for (const k of ['handed', 'tossed', 'hits', 'tossHeld', 'unseen', 'wontLand', 'seconds', 'pearls', 'spent', 'throwsN', 'barterReceipts', 'barterDelivered', 'lureBad', 'unheld']) out[k] = sum(a[k], b[k])
  for (const k of ['thrown', 'got', 'junked', 'dumped', 'lyingOutside']) out[k] = addMap(a[k], b[k])
  out.ingots0 = a.ingots0
  out.lyingWhere = [...(a.lyingWhere || []), ...(b.lyingWhere || [])]
  const th: any = (Object.values(out.thrown || {}) as any[]).reduce((m: any, v) => m + v, 0)
  if (a.delivery !== undefined || b.delivery !== undefined) out.delivery = th ? ((a.delivery || 0) * (Object.values(a.thrown || {}) as any[]).reduce((m: any, v) => m + v, 0) + (b.delivery || 0) * (Object.values(b.thrown || {}) as any[]).reduce((m: any, v) => m + v, 0)) / th : undefined
  out.pits = 2
  return out
}

async function exitTunnel (session, ctl, st, until) {
  const bot = session.bot
  const SL: typeof import('.././sealed') = require('.././sealed')
  const S = st.sealedState
  if (!S || !S.entry) return { ok: false, why: 'входа нет' }
  const E = S.entry
  const ek = [SL.key(E.x, E.y, E.z), SL.key(E.x, E.y + 1, E.z)]
  const me = bot.entity.position.floored()
  if (me.x === E.x && me.y === E.y && me.z === E.z) return { ok: true }
  const view = SL.worldView(bot)
  // Коробка — весь свой штрек (он уходит в сторону от прямой вход–тело; в booth-1 коробка по двум точкам резала его: «пути назад нет»).
  const pts = [me, E, ...[...S.own].map(k => { const [x, y, z] = k.split(',').map(Number); return { x, y, z } })]
  const box = { x0: Math.min(...pts.map(q => q.x)) - 4, x1: Math.max(...pts.map(q => q.x)) + 4, y0: Math.max(5, Math.min(...pts.map(q => q.y)) - 4), y1: Math.min(120, Math.max(...pts.map(q => q.y)) + 4), z0: Math.min(...pts.map(q => q.z)) - 4, z1: Math.max(...pts.map(q => q.z)) + 4 }
  const openOk = new Set(ek)
  const r = await SL.plan({
    cls: view.cls, dig: view.dig, own: S.own, box, maxNodes: 120000, vup: SL.fillerCount(bot) >= 6, openOk,
    starts: [{ x: me.x, y: me.y, z: me.z, g: 0 }],
    goal: (x, y, z) => x === E.x && y === E.y && z === E.z,
    h: (x, y, z) => Math.abs(x - E.x) + Math.abs(y - E.y) + Math.abs(z - E.z),
    breachOk: ck => openOk.has(ck) || !!(S.filled && S.filled.has(ck))
  })
  if (!r.ok) return { ok: false, why: 'пути назад нет', nodes: r.nodes }
  S.deadline = until
  S.openOk = openOk
  // Засыпанное нами (вход, клетки за спиной) — копать назад можно, хоть оно и касается открытого.
  S.breachOk = ck => openOk.has(ck) || !!(S.filled && S.filled.has(ck))
  let ex
  try { ex = await SL.execute(session, ctl, r.path, S) } finally { S.openOk = null; S.breachOk = null }
  return { ok: ex.ok, why: ex.why, moves: r.path.length }
}

module.exports = { FOES_RE, foesNear, towerScan, approachWallTop, approachWallSide, routeGold, digBooth, peekTraders, pocketOpen, mergeTrades, exitTunnel }
export {
  FOES_RE, foesNear, towerScan, approachWallTop, approachWallSide, routeGold, digBooth, peekTraders, pocketOpen, mergeTrades,
  exitTunnel
}
