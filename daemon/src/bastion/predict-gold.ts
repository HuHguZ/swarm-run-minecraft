const { visibleOf, seesBlock, log, sleep, xyz, Vec3, reserveKeeper, countOf, mobs, LOVED, admiring, itemNamed, seesMob }: typeof import('./take-gold-block') = require('./take-gold-block')
async function eatIfHungry (session, ctl) {
  const bot = session.bot
  if ((bot.food ?? 20) >= 16 && (bot.health ?? 20) >= 14) return
  if ((bot.food ?? 20) >= 20) return
  try { await (require('.././actions') as typeof import('.././actions')).eat(session, {}) } catch {}
}

function predictGold (bot, radius = 56) {
  const steps = predictGoldSteps(bot, radius)
  let next = steps.next()
  while (!next.done) next = steps.next()
  return next.value
}

async function predictGoldAsync (bot, radius = 56, ctl: any = {}) {
  const steps = predictGoldSteps(bot, radius)
  let ended = false
  let wakeReflex: (() => void) | null = null
  const onEnd = () => { ended = true; wakeReflex?.() }
  const onAbort = () => wakeReflex?.()
  const check = () => { if (ended || ctl.aborted || !bot.entity || (bot.health ?? 20) <= 0) throw new Error('обзор бастиона прерван') }
  bot.once?.('end', onEnd)
  bot.once?.('death', onEnd)
  ctl.onAbort?.push(onAbort)
  try {
    for (;;) {
      // Voting per visible block must let damage, death and reflex packets run.
      await new Promise<void>(resolve => setImmediate(resolve))
      check()
      if (ctl.waitReflex) {
        const stopped = new Promise<void>(resolve => { wakeReflex = resolve })
        await Promise.race([ctl.waitReflex(), stopped])
        wakeReflex = null
      }
      check()
      const next = steps.next()
      if (next.done) return next.value
    }
  } finally {
    wakeReflex = null
    steps.return(null)
    bot.removeListener?.('end', onEnd); bot.removeListener?.('death', onEnd)
    const at = ctl.onAbort?.indexOf(onAbort) ?? -1
    if (at >= 0) ctl.onAbort.splice(at, 1)
  }
}

function * predictGoldSteps (bot, radius = 56) {
  const bp: typeof import('.././bastion-pieces') = require('.././bastion-pieces')
  const rootGrid = process.env.ND_BASTION_ROOT_GRID === '1' && (require('.././nether-cover') as typeof import('.././nether-cover')).blind()
  const R = bot.registry.blocksByName
  const cids = [R.chest && R.chest.id, R.trapped_chest && R.trapped_chest.id, R.barrel && R.barrel.id].filter(Boolean)
  const chests = visibleOf(bot, cids, radius, { max: 40, rays: 3000 }).map(b => ({ pos: b.position, block: b }))
  yield
  const bids = ['basalt', 'polished_basalt'].map(n => R[n] && R[n].id).filter(Boolean)
  const basalt = visibleOf(bot, bids, radius, { max: 300, rays: 4000 })
  yield
  const entry = bot.world?.getColumn && bot.world?.raycast
    ? yield * (require('./entry-route') as typeof import('./entry-route')).observeSteps(bot) : null
  const byChest = bp.locate(bot, chests).found
  yield
  let byBasalt = []
  const debug = []
  try { byBasalt = yield * bp.voteByBasaltSteps(bot, basalt, undefined, { debug }) } catch (e) { log('голоса', { error: e.message }) }
  // Один и тот же вал узнаётся тремя шаблонами одной формы (units/ramparts_0,
  const seenR = new Set()
  const ramparts = [...byChest.filter(c => bp.RAMPART_SHAPES.has(c.piece)), ...byBasalt].filter(c => {
    const k = `${c.r}|${c.t.x},${c.t.y},${c.t.z}`
    if (seenR.has(k)) return false
    seenR.add(k)
    return true
  })
  const walls = new Map()
  for (const rc of ramparts) {
    const h = bp.unitsWallsFromRampart(rc)
    if (!h) continue
    for (const [name, w] of [['A', 3], ['B', 1]]) {
      const wb = h[name].find(c => c.piece === 'units/walls/wall_base')
      const cw = h[name].find(c => c.piece === 'units/walls/connected_wall')
      const k = `${wb.r}|${wb.t.x},${wb.t.y},${wb.t.z}`
      const cur = walls.get(k) || { wall: wb, conn: cw, score: 0, from: [] }
      cur.score += w
      cur.from.push(`${rc.piece.split('/').pop()}:${name}`)
      walls.set(k, cur)
    }
  }
  for (const w of walls.values()) {
    const v = bp.verify(bot, w.wall, { radius: 40 })
    w.match = v.match
    w.miss = v.miss
    w.score += Math.max(0, v.match - 2 * v.miss) / 10
  }
  // Одна слабая гипотеза (один вал, score 3) на ферме давала стену на y −3 —
  const bestWalls = [...walls.values()]
    // С вышки до y 86 стена под валом (y 31) — в 55 блоках ниже глаз; порог 40 отбрасывал верную
    // гипотезу (b2-15 30.09: вал ramparts_0 узнан, 29 голосов, match 48, miss 0 — стен 0, золота 0).
    .filter(w => w.wall.t.y >= 5 && w.wall.t.y <= 120 && Math.abs(w.wall.t.y - bot.entity.position.y) < 64)
    // Глаза против (видно много чужого на месте стены) — нет; иначе хватает
    // одного вала (A, 3) — неверную гипотезу снимут два промаха копки.
    .filter(w => !(w.match >= 8 && w.miss > 0.3 * w.match))
    .filter(w => w.score >= 3 || (w.match >= 10 && w.miss <= 0.2 * w.match))
    .sort((a, b) => b.score - a.score)
  const direct = byChest.filter(c => !bp.RAMPART_SHAPES.has(c.piece) && c.gold > 0)
  const gold = []
  const add = (c, src, rank?: any) => {
    const roots = rootGrid ? bp.startsFrom(c) : []
    if (roots.length && !roots.some(bp.startFitsGenerator)) return
    for (const v of bp.goldOf(c)) gold.push({ pos: v, piece: c.piece, src, rank, wall: c })
  }
  if (bestWalls[0]) { add(bestWalls[0].wall, 'стена'); add(bestWalls[0].conn, 'стена') }
  for (const c of direct) add(c, 'сундук')
  // Все типы (dev-F 02.10): любой узнанный кусок таблицы START_REL (сундук, базальт якорей, видимое золото моста и
  let start = null
  try {
    const gids = [R.gold_block && R.gold_block.id].filter(Boolean)
    const dbgA = []
    const goldSeen = visibleOf(bot, gids, radius, { max: 60, rays: 3000 })
    const byAnchors = [
      ...bp.locate(bot, chests, { radius, debug: dbgA }).found,
      ...(yield * bp.voteBySteps(bot, basalt, bp.BASALT_ANCHORS, 'b', { debug: dbgA, radius })),
      ...(goldSeen.length >= 4 ? (yield * bp.voteBySteps(bot, goldSeen, bp.GOLD_ANCHORS, 'G', { minVotes: 4, minMatch: 10, debug: dbgA, radius })) : []),
      ...ramparts
    ]
    const hyp = new Map()
    const seenA = new Set()
    for (const c of byAnchors) {
      const ak = c.piece + '|' + c.r + '|' + c.t.x + ',' + c.t.y + ',' + c.t.z
      if (seenA.has(ak)) continue
      seenA.add(ak)
      for (const S of bp.startsFrom(c)) {
        if (rootGrid && !bp.startFitsGenerator(S)) continue
        const k = S.type + '|' + S.r + '|' + S.t.x + ',' + S.t.y + ',' + S.t.z
        const h = hyp.get(k) || { ...S, score: 0, from: [] }
        h.score += S.w * (1 + Math.max(0, (c.match || 0) - 2 * (c.miss || 0)) / 20)
        h.from.push(c.piece.split('/').pop())
        hyp.set(k, h)
      }
    }
    const hs = [...hyp.values()].filter(h => h.t.y >= 5 && h.t.y <= 120 && Math.abs(h.t.y - bot.entity.position.y) < 72).sort((a, b) => b.score - a.score)
    // Одна форма вала у трёх типов (units ramparts_0/1/2, bridge rampart_1, hoglin ramparts_1): тип решают ОСТАЛЬНЫЕ
    // куски гипотезы — их видимые клетки сверяются глазами (verify); у неверного типа на месте его стен — чужое.
    for (const h of hs.slice(0, 6)) {
      let chk = 0
      for (const sl of (bp.START_REL[h.type] || [])) {
        const [piece, p]: any = (Object.entries(sl.v) as [string, any][]).sort((x: any, y: any) => y[1] - x[1])[0]
        if (p < 0.5) continue
        const [ox, oz] = bp.rot(h.r, sl.d[0], sl.d[2])
        const v = bp.verify(bot, { piece, r: (h.r + sl.dr) & 3, t: { x: h.t.x + ox, y: h.t.y + sl.d[1], z: h.t.z + oz } }, { radius, maxChecks: 160 })
        chk += v.match - 2 * v.miss
      }
      h.check = chk
      h.score += Math.max(-2, Math.min(3, chk / 25))
    }
    // Хоглины видны — конюшни (только этот тип их спавнит; бруты есть у всех): глазами, как человек узнаёт двор.
    const hoglins = (Object.values(bot.entities) as any[]).filter((e : any) => e && e.name === 'hoglin' && e.position && e.position.distanceTo(bot.entity.position) < 48 && seesMob(bot, e)).length
    if (hoglins) for (const h of hs) if (h.type === 'hoglin_stable') h.score += 1.5
    hs.sort((a, b) => b.score - a.score)
    // До четырёх гипотез разом (одна форма вала у трёх типов — тип решит копка): ранг гипотезы i — 100·(i+1) у верных
    const picked = entry?.start ? [{ ...entry.start, score: 100, from: ['two observed contours'] }]
      : hs.filter(h => h.score >= 0.3).slice(0, 4)
    if (entry?.start) gold.length = 0
    picked.forEach((h, i) => {
      const pcs = bp.goldPiecesFromStart(h)
      for (const g of pcs) add(g, 'старт', 100 * (i + 1) + (g.p >= 0.85 ? 0 : g.slot + 1))
      h.pieces = pcs.map(g => g.piece.split('/').pop() + '@' + g.t.x + ',' + g.t.y + ',' + g.t.z + ' p' + g.p)
    })
    start = picked[0] || null
    if (start) start.all = picked.map(h => ({ type: h.type, r: h.r, t: h.t, score: Math.round(h.score * 10) / 10 }))
    if (debug) debug.unshift({ starts: hs.slice(0, 3).map(h => ({ type: h.type, r: h.r, t: h.t, score: Math.round(h.score * 10) / 10, check: h.check, from: h.from.slice(0, 4) })), anchors: byAnchors.length, goldSeen: goldSeen.length, tried: dbgA.sort((x, y) => y.match - x.match).slice(0, 8) })
  } catch (e) { log('старт', { error: e.message }) }
  return { chests: chests.length, basalt: basalt.length, ramparts: ramparts.length, walls: bestWalls.slice(0, 3), direct, gold, start, debug: debug.slice(0, 5) }
}

const lastGoldBreak = st => Math.max(st.lastBreak || 0, (st.sealedState && st.sealedState.lastBreak) || 0)

function rayClear (getBlock, a, b) {
  const n = Math.ceil(a.distanceTo(b) / 0.05)
  for (let i = 1; i < n; i++) {
    const t = i / n
    const x = a.x + (b.x - a.x) * t; const y = a.y + (b.y - a.y) * t; const z = a.z + (b.z - a.z) * t
    const bl = getBlock(Math.floor(x), Math.floor(y), Math.floor(z))
    if (!bl) return false
    for (const sh of bl.shapes || []) {
      const lx = x - Math.floor(x); const ly = y - Math.floor(y); const lz = z - Math.floor(z)
      if (lx > sh[0] && lx < sh[3] && ly > sh[1] && ly < sh[4] && lz > sh[2] && lz < sh[5]) return false
    }
  }
  return true
}

function baitAim (bot, bo) {
  const T = bo.C2
  const gb = (require('.././drops') as typeof import('.././drops')).blockGetter(bot)
  for (const hy of [1.0, 0.8, 1.3, 0.6, 1.6]) {
    for (const far of [0.6, 0.8, 0.4, 0.95]) {
      const aim = new Vec3(T.x + 0.5 + bo.d[0] * (far - 0.5), T.y + hy, T.z + 0.5 + bo.d[1] * (far - 0.5))
      const ok = [-0.1, 0, 0.1].every(dvy => { const at = tossLands(bot, aim, gb, dvy); return Math.floor(at.x) === T.x && Math.floor(at.z) === T.z && Math.floor(at.y) === T.y })
      if (ok) return aim
    }
  }
  return null
}

function distToBox (p, e) {
  const w = (e.width || 0.6) / 2
  const h = e.height || 1.95
  const dx = Math.max(e.position.x - w - p.x, 0, p.x - (e.position.x + w))
  const dy = Math.max(e.position.y - p.y, 0, p.y - (e.position.y + h))
  const dz = Math.max(e.position.z - w - p.z, 0, p.z - (e.position.z + w))
  return Math.hypot(dx, dy, dz)
}

async function handNoWalk (bot, pg) {
  const pick: typeof import('.././pick') = require('.././pick')
  if (!bot.entities[pg.id] || admiring(pg)) return false
  const a = pick.aim(bot, pg)
  if (!a || !a.point) return false
  const ingot = itemNamed(bot, 'gold_ingot')
  if (!ingot) return false
  const had = countOf(bot, 'gold_ingot')
  try {
    await bot.equip(ingot, 'hand')
    await bot.lookAt(a.point, true)
    await bot.activateEntity(pg)
  } catch { return false }
  for (let i = 0; i < 8 && countOf(bot, 'gold_ingot') >= had; i++) await sleep(60)
  return countOf(bot, 'gold_ingot') < had
}

const pitLike = bo => bo.kind === 'pit' || bo.kind === 'trap'

function aimOut (bo) {
  // Ловушка: слиток — на пол дальней клетки камеры (дальше нашей рамки подбора): пиглин за ним
  // спрыгнет в камеру и останется в ней.
  if (bo.kind === 'trap') { const T = bo.C2 || bo.C0; return new Vec3(T.x + 0.5, T.y + 0.15, T.z + 0.5) }
  if (bo.kind === 'pit') return new Vec3(bo.M.x + 0.5 + bo.d[0] * 0.6, bo.M.y + 0.45, bo.M.z + 0.5 + bo.d[1] * 0.6)
  return new Vec3(bo.W.x + 0.5 + bo.d[0] * 0.5, bo.W.y + 0.55, bo.W.z + 0.5 + bo.d[1] * 0.5)
}

async function tossOut (bot, bo, name, count = 1, aim = null) {
  const it = itemNamed(bot, name)
  if (!it) return false
  try {
    await bot.lookAt(aim || aimOut(bo), true)
    await sleep(80) // взгляд уходит на сервер следующим тиком, бросок — сразу
    await bot.toss(it.type, null, Math.min(count, it.count))
    return true
  } catch { return false }
}

const WEAPON_RANK = n => n.startsWith('netherite') ? 5 : n.startsWith('diamond') ? 4 : n.startsWith('iron') ? 3 : n.startsWith('stone') ? 2 : 1

async function hitThroughWindow (bot) {
  const pick: typeof import('.././pick') = require('.././pick')
  const eye = bot.entity.position.offset(0, 1.62, 0)
  const t = [...mobs(bot, 'piglin_brute', 5), ...mobs(bot, 'hoglin', 5), ...mobs(bot, 'zoglin', 5)].filter(e => distToBox(eye, e) <= 2.9)[0]
  if (!t) return false
  const a = pick.aim(bot, t)
  if (!a || !a.point) return false
  const sword = bot.inventory.items().filter(i => /_sword$/.test(i.name)).sort((x, y) => WEAPON_RANK(y.name) - WEAPON_RANK(x.name))[0]
  try {
    if (sword && (!bot.heldItem || bot.heldItem.type !== sword.type)) await bot.equip(sword, 'hand')
    await bot.lookAt(a.point, true)
    bot.attack(t)
  } catch { return false }
  await sleep(650)
  return true
}

const JUNK_OUT = { gravel: 0, soul_sand: 8, soul_soil: 0, nether_brick: 0, quartz: 0, crying_obsidian: 8, dried_ghast: 0, leather: 0, iron_nugget: 64, magma_block: 0, nether_wart_block: 0, warped_wart_block: 0, crimson_fungus: 0, warped_fungus: 0, crimson_roots: 0, warped_roots: 0, basalt: 0, polished_basalt: 0, smooth_basalt: 0, polished_blackstone_bricks: 16, cracked_polished_blackstone_bricks: 0, polished_blackstone: 0, chiseled_polished_blackstone: 0, blackstone: 32, netherrack: 32, glowstone_dust: 0, magma_cream: 0, cobblestone: 32 }

function dumpAim (bot, bo) {
  if (!bo.dump) return null
  const { D1, D2 } = bo.dump
  const getBlock = (require('.././drops') as typeof import('.././drops')).blockGetter(bot)
  const px = D1.x - bo.P.x; const pz = D1.z - bo.P.z
  for (const far of [0.9, 0.7, 0.5, 0.3]) {
    for (const hy of [1.3, 1.1, 1.5, 0.9, 0.6]) {
      const aim = new Vec3(bo.P.x + 0.5 + px * (0.5 + far), D1.y + hy, bo.P.z + 0.5 + pz * (0.5 + far))
      const ok = [-0.1, 0, 0.1].every(dvy => {
        const at = tossLands(bot, aim, getBlock, dvy)
        return Math.floor(at.x) === D2.x && Math.floor(at.z) === D2.z && at.y < bo.P.y - 0.5
      })
      if (ok) return aim
    }
  }
  return null
}

const PIT_KEEP = /^(iron_nugget|iron_block|raw_iron|gold_ingot|gold_block|gold_nugget|raw_gold|ender_pearl|ender_eye|blaze_rod|blaze_powder|potion|splash_potion|obsidian|string|[a-z_]*wool|[a-z_]+_bed|spectral_arrow|arrow|bow|crossbow|fire_charge|flint_and_steel|shield|[a-z_]*bucket|crafting_table|iron_ingot|ancient_debris|netherite_[a-z_]+|diamond|[a-z_]+_(pickaxe|axe|shovel|sword|hoe)|iron_(helmet|chestplate|leggings)|diamond_(helmet|chestplate|leggings|boots)|golden_(helmet|chestplate|leggings|boots)|cooked_[a-z_]+|bread|apple|golden_apple|enchanted_golden_apple|golden_carrot|carrot|baked_potato|beef|porkchop|mutton|chicken|rabbit|cod|salmon|melon_slice|sweet_berries|dried_kelp|torch|stick|[a-z_]+_planks|[a-z_]+_log|oak_boat|[a-z_]+_boat)$/

const PIT_FILL_KEEP = 128

const END_FILLER = /^(cobblestone|cobbled_deepslate|dirt|netherrack|stone|deepslate|andesite|diorite|granite|tuff|blackstone|end_stone)$/

function pitJunk (bot) {
  const SL: typeof import('.././sealed') = require('.././sealed')
  const out = []
  let fill = 0
  // Камень на каменные кирки (stone_tool_materials: булыжник, чернокамень, глубинный булыжник) — первым в запас заливки: незерак на
  // кирку не годится (S1d s1d-AB-2: в яму ушли cobbled_deepslate 64 и cobblestone 46, оставлен незерак 128 — к 46-й мин кирок нет).
  const TOOL_STONE = /^(cobblestone|blackstone|cobbled_deepslate)$/
  const items = bot.inventory.items().slice().sort((a, b) => (Number(TOOL_STONE.test(b.name)) - Number(TOOL_STONE.test(a.name))) ||
    (Number(END_FILLER.test(b.name)) - Number(END_FILLER.test(a.name))) || (b.count - a.count))
  const goldArmor = /^golden_(helmet|chestplate|leggings|boots)$/
  let spareGold = 0
  for (const it of items) {
    if (SL.FILL_NAMES && SL.FILL_NAMES.includes(it.name)) { if (fill < PIT_FILL_KEEP) { fill += it.count; continue } out.push(it); continue }
    if (goldArmor.test(it.name)) { if (spareGold++ < 1) continue; out.push(it); continue } // одна запасная золотая вещь
    if (PIT_KEEP.test(it.name)) continue
    out.push(it)
  }
  // Аварийный запас (pack.RESERVE) — не в свалку, даже если это «хлам» ямы (кирпич Ада, картошка).
  const spare = reserveKeeper(bot)
  return out.filter(it => spare(it.name, it.count))
}

async function junkOut (bot, bo, tally = null) {
  // Яма без свалки: хлам — наружу сквозь рот, прицелом приманки (ляжет на пол пиглинов ≥1.6 от нас;
  if (bo.kind === 'pit' && !bo.dump) {
    if (!bo.lureAims) bo.lureAims = pitLures(bot, bo)
    if (!bo.lureAims.length) return 0
    bo.dumpAim = bo.lureAims[0].aim
  } else if (pitLike(bo) && !bo.dump) return 0
  if (pitLike(bo)) {
    const aim = bo.dumpAim || (bo.dumpAim = dumpAim(bot, bo))
    if (!aim) return 0
    let n = 0
    for (const it of pitJunk(bot)) {
      try {
        await bot.lookAt(aim, true)
        await sleep(80) // взгляд уходит на сервер следующим тиком, бросок — сразу
        await bot.tossStack(it)
        n++
        if (tally) tally[it.name] = (tally[it.name] || 0) + it.count
      } catch {}
    }
    return n
  }
  const aim = bo.kind === 'pit'
    ? (bo.dumpAim || (bo.dumpAim = dumpAim(bot, bo)))
    : new Vec3(bo.W.x + 0.5 + bo.d[0] * 0.5, bo.W.y + 0.55, bo.W.z + 0.5 + bo.d[1] * 0.5)
  if (!aim) return 0
  let n = 0
  const spare = reserveKeeper(bot)
  for (const [name, keep] of (Object.entries(JUNK_OUT) as [string, any][])) {
    let have = countOf(bot, name)
    for (const it of bot.inventory.items().filter(i => i.name === name).sort((a, c) => a.count - c.count)) {
      if (have - it.count < keep) break
      if (!spare(name, it.count)) break
      try {
        await bot.lookAt(aim, true)
        await sleep(80) // взгляд уходит на сервер следующим тиком, бросок — сразу
        await bot.tossStack(it)
        have -= it.count
        n++
        if (tally) tally[name] = (tally[name] || 0) + it.count
      } catch {}
    }
  }
  return n
}

async function makeSill (bot, bo) {
  const SL: typeof import('.././sealed') = require('.././sealed')
  const { placeBlockAt }: typeof import('.././build') = require('.././build')
  const C = new Vec3(bo.C.x, bo.C.y, bo.C.z)
  const b = bot.blockAt(C)
  if (b && b.name === 'soul_sand') return true
  if (b && b.boundingBox !== 'empty') { const r = await SL.digCell(bot, C); if (r !== 'ok' && r !== 'air') return false }
  for (let i = 0; i < 3; i++) {
    try { const r = await placeBlockAt(bot, C, { item: 'soul_sand', timeoutMs: 1500 }); if (r && r.ok) return true } catch {}
    await sleep(200)
  }
  // Не встал — закрыть проём обратно чем есть (иначе он высотой 2).
  await SL.fillCell(bot, C)
  return false
}

const PIGLIN_EYE = 1.79

function throwLands (bot, from, feet = bot.entity.position, getBlock = null) {
  const drops: typeof import('.././drops') = require('.././drops')
  getBlock = getBlock || drops.blockGetter(bot)
  const t = { x: feet.x - from.x, y: feet.y + 1 - from.y, z: feet.z - from.z }
  const L = Math.hypot(t.x, t.y, t.z) || 1
  const s = { id: 0, age: 0, x: from.x, y: from.y + PIGLIN_EYE - 0.3, z: from.z, vx: 0.3 * t.x / L, vy: 0.3 * t.y / L, vz: 0.3 * t.z / L, onGround: false }
  for (let i = 0; i < 80; i++) {
    drops.stepItem(getBlock, s)
    if (i >= 10 && drops.inPickup(feet, s, 0.05)) return { ok: true, at: s, tick: i }
    if (s.onGround && Math.abs(s.vx) + Math.abs(s.vz) < 0.005) break
  }
  return { ok: drops.inPickup(feet, s, 0.05), at: s }
}

function floorRegion (gb, x0, z0, fy, max = 800) {
  // Ходьба пиглина: по ровному и ступенькой ±1 (лестницы, плиты бастиона); ключи «x,z» на уровнях fy−2..fy+2.
  const ok = (x, y, z) => {
    const f = gb(x, y, z); const h = gb(x, y + 1, z); const u = gb(x, y - 1, z)
    return f && f.boundingBox === 'empty' && !/lava|fire/.test(f.name) && h && h.boundingBox === 'empty' && u && u.boundingBox === 'block'
  }
  const seen = new Set()
  const cells = new Set()
  if (!ok(x0, fy, z0)) return cells
  const q = [[x0, fy, z0]]
  seen.add(x0 + ',' + fy + ',' + z0)
  cells.add(x0 + ',' + z0)
  for (let i = 0; i < q.length && seen.size < max; i++) {
    const [x, y, z] = q[i]
    for (const [dx, dz] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
      for (const dy of [0, 1, -1]) {
        const ny = y + dy
        if (ny < fy - 2 || ny > fy + 2) continue
        const k = (x + dx) + ',' + ny + ',' + (z + dz)
        if (seen.has(k) || !ok(x + dx, ny, z + dz)) continue
        // Ступенька вверх — нужна голова над собой; вниз — над клеткой спуска.
        if (dy === 1) { const hh = gb(x, y + 2, z); if (!hh || hh.boundingBox !== 'empty') continue }
        seen.add(k)
        cells.add((x + dx) + ',' + (z + dz))
        q.push([x + dx, ny, z + dz])
        break
      }
    }
  }
  return cells
}

function pitLures (bot, bo, gb = null) {
  gb = gb || (require('.././drops') as typeof import('.././drops')).blockGetter(bot)
  const me = bot.entity.position
  const eye = me.offset(0, 1.62, 0)
  const d = bo.d; const pp = [d[1], d[0]]
  const fy = bo.M.y
  const Mx = bo.M.x + 0.5; const Mz = bo.M.z + 0.5
  const standable = (x, z) => {
    const f = gb(Math.floor(x), fy, Math.floor(z)); const h = gb(Math.floor(x), fy + 1, Math.floor(z)); const u = gb(Math.floor(x), fy - 1, Math.floor(z))
    return f && f.boundingBox === 'empty' && h && h.boundingBox === 'empty' && u && u.boundingBox === 'block'
  }
  // Где пиглин стоит, подняв предмет: Mob.aiStep берёт предмет, попавший в его рамку, раздутую на (1,0,1)
  const pts = [[0, 0], ...[0, 1, 2, 3, 4, 5, 6, 7].flatMap(k => [0.7, 1.2].map(r => [r * Math.cos(k * Math.PI / 4 + (r > 1 ? Math.PI / 8 : 0)), r * Math.sin(k * Math.PI / 4 + (r > 1 ? Math.PI / 8 : 0))]))]
  const out = []
  for (const a of [0.5, 0.7, 0.9, 1.2, 1.6, 2.2]) {
    for (const h of [0.1, 0.3, 0.5, 0.7, 0.9, 1.2, 1.6]) {
      for (const l of [-0.3, -0.15, 0, 0.15, 0.3]) {
        const aim = new Vec3(Mx + d[0] * a + pp[0] * l, fy + h, Mz + d[1] * a + pp[1] * l)
        // Разброс по вертикали у Player.drop — (rand − rand)·0.1, треугольный: веса выборок ~ плотности.
        // Не долетевший слиток просто вернётся к нам (2 с), поэтому нужна лишь доля удачных ≥ 0.6.
        let pl = 0; let score = 9; let at = null
        for (const [dvy, w] of [[0, 1], [-0.04, 0.6], [0.04, 0.6], [-0.08, 0.2], [0.08, 0.2]]) {
          const q = tossLands(bot, aim, gb, dvy)
          if (!(q.onGround && Math.abs(q.y - fy) < 0.3 && Math.hypot(q.x - me.x, q.z - me.z) >= 1.6)) continue
          pl += w / 2.6
          if (!at) at = q
          let ok = 0; let n = 0
          for (const [dx, dz] of pts) {
            if (!standable(q.x + dx, q.z + dz)) continue
            n++
            // Бросок к нам — только если пиглин нас видит (PiglinAi.throwItems: NEAREST_VISIBLE_PLAYER,
            const from = new Vec3(q.x + dx, fy, q.z + dz)
            if (!rayClear(gb, from.offset(0, PIGLIN_EYE, 0), eye)) continue
            if (throwLands(bot, from, me, gb).ok) ok++
          }
          score = Math.min(score, n ? Math.floor(9 * ok / n) : 0)
        }
        if (pl < 0.6 || !at) continue
        out.push({ aim, score, pl: +pl.toFixed(2), at })
      }
    }
  }
  out.sort((x, y) => y.score - x.score || y.pl - x.pl || Math.hypot(x.at.x - Mx, x.at.z - Mz) - Math.hypot(y.at.x - Mx, y.at.z - Mz))
  return out
}

async function unholdGold (bot) {
  const h = bot.heldItem
  if (!h || !LOVED.test(h.name)) return false
  for (let i = 0; i < 9; i++) if (!bot.inventory.slots[36 + i]) { bot.setQuickBarSlot(i); return true }
  const items = bot.inventory.items().filter(it => !LOVED.test(it.name))
  const alt = items.find(it => /pickaxe|sword|_axe|shovel/.test(it.name)) || items[0]
  if (alt) { try { await bot.equip(alt, 'hand'); return true } catch {} }
  return false
}

function tossLands (bot, aim, getBlock = null, dvy = 0) {
  const drops: typeof import('.././drops') = require('.././drops')
  getBlock = getBlock || drops.blockGetter(bot)
  const me = bot.entity.position
  const eye = me.offset(0, 1.62, 0)
  const dx = aim.x - eye.x; const dy = aim.y - eye.y; const dz = aim.z - eye.z
  const h = Math.hypot(dx, dz) || 1e-6
  const pitch = Math.atan2(dy, h)
  const s = { id: 0, age: 0, x: me.x, y: eye.y - 0.3, z: me.z, vx: 0.3 * Math.cos(pitch) * dx / h, vy: 0.3 * Math.sin(pitch) + 0.1 + dvy, vz: 0.3 * Math.cos(pitch) * dz / h, onGround: false }
  for (let i = 0; i < 80; i++) { drops.stepItem(getBlock, s); if (s.onGround && Math.abs(s.vx) + Math.abs(s.vz) < 0.005) break }
  return s
}

function scanPieces (bot, radius = 48) {
  const pg = predictGold(bot, Math.max(radius, 56))
  return piecesReport(bot, radius, pg)
}

async function scanPiecesAsync (bot, radius = 48, ctl: any = {}) {
  const pg = await predictGoldAsync(bot, Math.max(radius, 56), ctl)
  return piecesReport(bot, radius, pg)
}

function piecesReport (bot, radius, pg) {
  const walls = pg.walls.map(w => ({ wall: w.wall.t, r: w.wall.r, score: Math.round(w.score * 10) / 10, match: w.match, miss: w.miss, from: w.from }))
  const R = bot.registry.blocksByName
  const cids = [R.chest && R.chest.id, R.trapped_chest && R.trapped_chest.id, R.barrel && R.barrel.id].filter(Boolean)
  const chests = visibleOf(bot, cids, radius, { max: 40, rays: 3000 }).map(b => ({ pos: b.position, block: b }))
  const bp: typeof import('.././bastion-pieces') = require('.././bastion-pieces')
  const loc = bp.locate(bot, chests)
  const props = b => { try { return b.getProperties() || {} } catch { return {} } }
  return {
    at: xyz(bot.entity.position.floored()),
    chests: chests.map(c => [c.pos.x, c.pos.y, c.pos.z, props(c.block).facing, props(c.block).type]),
    candidates: loc.candidates,
    found: loc.found.map(f => ({ piece: f.piece, type: bp.typeOf(f), r: f.r, t: f.t, match: f.match, miss: f.miss, gold: f.gold })),
    basalt: pg.basalt,
    ramparts: pg.ramparts,
    walls,
    gold: pg.gold.map(g => [g.pos.x, g.pos.y, g.pos.z]),
    votes: pg.debug
  }
}

module.exports = { eatIfHungry, predictGold, predictGoldAsync, lastGoldBreak, rayClear, baitAim, distToBox, handNoWalk, pitLike, aimOut, tossOut, WEAPON_RANK, hitThroughWindow, JUNK_OUT, dumpAim, PIT_KEEP, PIT_FILL_KEEP, END_FILLER, pitJunk, junkOut, makeSill, PIGLIN_EYE, throwLands, floorRegion, pitLures, unholdGold, tossLands, scanPieces, scanPiecesAsync }
export {
  eatIfHungry, predictGold, predictGoldAsync, lastGoldBreak, rayClear, baitAim, distToBox, handNoWalk, pitLike,
  aimOut, tossOut, WEAPON_RANK, hitThroughWindow, JUNK_OUT, dumpAim, PIT_KEEP, PIT_FILL_KEEP, END_FILLER, pitJunk,
  junkOut, makeSill, PIGLIN_EYE, throwLands, floorRegion, pitLures, unholdGold, tossLands, scanPieces,
  scanPiecesAsync
}
