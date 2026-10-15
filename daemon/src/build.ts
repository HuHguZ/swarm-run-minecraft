'use strict'
const gameClock = require('./game-clock')
const Vec3 = require('vec3')
const { sleep, xyz, centerOnFloor } = require('./movement')
const { itemNamed, itemMatching, equipBestTool, missingHarvestTool } = require('./items')

// Putting a block at a *chosen* coordinate, as opposed to "somewhere near me".
// actions.place() answers "drop a crafting table around here"; walling off a
// skeleton, roofing a shelter and torching a tunnel all need the other
// question — and mineflayer only knows how to place *against* a neighbour, so
// the work is picking the right reference block and face every time.

const FACES = [
  new Vec3(0, -1, 0), new Vec3(0, 1, 0),
  new Vec3(1, 0, 0), new Vec3(-1, 0, 0),
  new Vec3(0, 0, 1), new Vec3(0, 0, -1)
]

// Cheap solid blocks, best first: what a player grabs when they need a wall
// right now and do not care how it looks. Ordered so we spend rubble before
// anything that took a craft. Every drop of the stone_like group is here —
// basalt included — because a staircase with nothing to prop with names
// «mc_mine block=stone_like» as the way on, and a fetch that brings a block
// this list refuses is the same dead end one call later.
const FILLER = [
  'cobblestone', 'cobbled_deepslate', 'dirt', 'netherrack', 'stone', 'deepslate',
  'andesite', 'diorite', 'granite', 'tuff', 'blackstone', 'basalt', 'sandstone', 'red_sandstone', 'sand', 'gravel'
]

// Blocks that do not stay where they are put when there is air under them.
// Harmless in a wall standing on a floor; under a staircase step over a cave
// the block drops into the cave the tick it lands, and the body walks onto the
// air where it was — an unplanned fall of however deep the cave is.
const FALLING = new Set(['sand', 'red_sand', 'gravel'])
// Арена (ND_SCAFFOLD_ANY=1, 12.10: «кирку нашли — ломать Колизей и строиться его блоками»): стройка — и блоки постройки
// (песчаник, кварц, кирпич, бетон, терракота), не только простые.
// Песок, песчаник, доски (14.10: песок поля руками — 16 бл. за 15 с, а столб из него строитель путей не ставил: не было в
// списке) — башня 1×1 из песка стоит (кладётся на опору под ногами); мост из песка упадёт — ponytail: мосты без песка, если станут.
const ARENA_FILLER = /^(sand|red_sand|sandstone|red_sandstone|oak_planks|smooth_sandstone|cut_sandstone|chiseled_sandstone|smooth_red_sandstone|smooth_quartz|quartz_block|chiseled_quartz_block|quartz_pillar|quartz_bricks|stone_bricks|smooth_stone|obsidian|.*_terracotta|.*_concrete)$/
const scaffoldAny = () => process.env.ND_SCAFFOLD_ANY === '1'

// В Аду — незерак первым: булыжник там — запасные кирки (см. worlds.tuneMovements).
// Кирпич бастиона и соул-сэнд — тоже стройка (после бастиона незерака в рюкзаке бывало 0, а кирпича 20+:
// окоп эндерменов стоял «нечем строить», chain6-15 30.09). Соул-сэнд — последним: на нём тело вязнет.
const FILLER_NETHER = ['netherrack', 'dirt', 'basalt', 'blackstone', 'stone', 'andesite', 'diorite', 'granite', 'tuff', 'cobbled_deepslate', 'cobblestone', 'deepslate', 'polished_blackstone_bricks', 'cracked_polished_blackstone_bricks', 'polished_blackstone', 'end_stone', 'mossy_cobblestone', 'soul_soil', 'warped_wart_block', 'nether_wart_block', 'sand', 'gravel', 'soul_sand']
// Гаст на виду (64) или слышен (15 с) — сперва взрывостойкое: шар (сила 1) рвёт незерак (стойкость 0.4) и коробку из него,
// булыжник и чернокамень (6), базальт (4.2) — нет (Codex q8, jar 1.21.11). Касается и мостов: «гаст → лава» — пол из незерака.
const BLAST_NETHER = ['cobblestone', 'cobbled_deepslate', 'blackstone', 'stone', 'deepslate', 'andesite', 'diorite', 'granite', 'tuff',
  'polished_blackstone_bricks', 'cracked_polished_blackstone_bricks', 'polished_blackstone', 'mossy_cobblestone', 'end_stone', 'basalt', ...FILLER_NETHER]
function ghastThreat (bot) {
  if (process.env.ND_BLAST_FILLER === '0') return false
  const now = gameClock.now()
  const c = bot._ndGhastFiller
  if (c && now - c.at < 1000) return c.v
  let v = false
  try {
    v = require('./perception/eyes').entities(bot, { radius: 64 }).some(e => e.name === 'ghast' && e.seen) ||
      require('./perception/senses').heard(bot, { sinceMs: 15000, match: /ghast/ }).length > 0
  } catch {}
  bot._ndGhastFiller = { at: now, v }
  return v
}
function pickFiller (bot, { steady = false }: any = {}) {
  let nether = false
  try { nether = require('./worlds').worldOf(bot) === 'the_nether' } catch {}
  for (const name of (nether ? (ghastThreat(bot) ? BLAST_NETHER : FILLER_NETHER) : FILLER)) {
    if (steady && FALLING.has(name)) continue
    const found = itemNamed(bot, name)
    if (found) return found
  }
  return itemMatching(bot, /_planks$/) || (scaffoldAny() ? itemMatching(bot, ARENA_FILLER) : null)
}

// A promise that cannot hang the intent. bot.placeBlock waits for a block
// update the server does not always send on 1.21.11 — the same class of bug
// that makes crafting tables hang for 20s.
function withTimeout (p, ms, message = 'ответа от сервера нет', clock = gameClock) {
  let timer = null
  const guard = new Promise<any>((_resolve, reject) => {
    timer = clock.setTimeout(() => reject(new Error(message)), ms)
  })
  return Promise.race([p, guard]).finally(() => clock.clearTimeout(timer))
}

// The two blocks our own body occupies. Placing into them is rejected by the
// server, and on the rare occasion it lands the bot suffocates.
function isOurOwnSpace (bot, pos) {
  const feet = bot.entity.position.floored()
  return pos.equals(feet) || pos.equals(feet.offset(0, 1, 0))
}

// Poll for a block to actually exist. Used where we fire a placement packet
// and cannot afford to wait on mineflayer's own block-update round trip.
async function waitForBlock (bot, pos, ms = 900) {
  const deadline = gameClock.now() + ms
  while (gameClock.now() < deadline) {
    const b = bot.blockAt(pos)
    if (b && b.boundingBox !== 'empty') return true
    await sleep(50)
  }
  return false
}

// Is a mob (or a player) standing in this square? The server refuses to place
// a block inside a living entity, and every refusal costs a full placement
// timeout — with a zombie parked in the target square the bot spent thirty
// seconds failing to build a wall and died holding the blocks.
// area_effect_cloud: облако (дыхание дракона, зелья) blocksBuilding не ставит
// (байткод AreaEffectCloud, paper-1.21.11) — ставить блок в его клетку можно.
const IGNORED_ENTITIES = new Set(['item', 'experience_orb', 'arrow', 'spectral_arrow', 'item_frame', 'painting', 'area_effect_cloud'])

function occupiedByEntity (bot, pos) {
  for (const e of ((Object.values(bot.entities) as any[]) as any)) {
    if (!e || e === bot.entity || !e.position || IGNORED_ENTITIES.has(e.name)) continue
    const p = e.position
    const half = (e.width || 0.6) / 2
    if (p.x + half <= pos.x || p.x - half >= pos.x + 1) continue
    if (p.z + half <= pos.z || p.z - half >= pos.z + 1) continue
    if (p.y + (e.height || 1.8) <= pos.y || p.y >= pos.y + 1) continue
    return e.name || 'кто-то'
  }
  return null
}

function isFree (block) {
  return !!block && block.boundingBox === 'empty' && !/lava/.test(block.name)
}

// The words survival.js matches on (AGAIN_WONT_HELP) to stop re-trying.
const NO_FACE = 'не к чему прислонить блок: вокруг клетки нет ни одной твёрдой грани'

// Put the right stack in hand, or say in words why there is none. Asked again
// after a prop, because the prop may have been the last block of the stack.
async function holdFiller (bot, item, steady) {
  const stack = item ? itemNamed(bot, item) : pickFiller(bot, { steady })
  if (!stack) {
    if (item) return `нет ${item} в инвентаре`
    // «нечем строить» stays the head of the sentence: survival.js matches it.
    return steady && [...FALLING].some(n => itemNamed(bot, n))
      ? 'нечем строить: в сумке только песок или гравий, а над пустотой он осыплется'
      : 'нечем строить'
  }
  if (!bot.heldItem || bot.heldItem.type !== stack.type) {
    try { await bot.equip(stack, 'hand') } catch (e) { return e.message }
  }
  return null
}

const isNeighbour = (a, b) => Math.abs(a.x - b.x) + Math.abs(a.y - b.y) + Math.abs(a.z - b.z) === 1

// Place a block at exactly this coordinate. Returns a verdict rather than
// throwing: every caller here has a fallback, and an exception would blow past it.
//
// `prop` is a face-neighbour of `pos` the caller lets us fill first when `pos`
// has no solid face at all. Open air on six sides is not the end of building:
// a block can go against a block that is not there YET. The staircase is the
// caller that needs it — its step cell over a cave is often already open, and
// the only solid thing near the cell under it is the floor under our own feet,
// diagonal to it and so no face of it. One block in the step cell, against the
// side of that floor, gives the cell under it a face; the staircase then cuts
// the prop out again as an ordinary step. Paper 1.21.11 accepts that second
// placement against a BOTTOM face from above: handleUseItemOn checks only the
// eye-to-block distance (block_interaction_range + 1) and that the hit point
// lies within the clicked block, and neither it, useItemOn nor
// BlockItem.canPlace looks at line of sight or at which way the face points
// (read from the jar's bytecode, not assumed). Read, not yet seen: no run has
// placed against an underside in the game, so the result says which face took
// (`face`) and which were refused (`refused`), and try-diamond counts both.
//
// `steady` keeps sand and gravel out of the hand: a block meant to hang over
// air must not be one that falls.
async function placeBlockAt (bot, pos, { item = null, timeoutMs = 5000, steady = false, prop = null, honest = false, ctl = null }: any = {}) {
  if (ctl?.aborted) return { ok: false, reason: 'прервано' }
  const target = bot.blockAt(pos)
  if (!target) return { ok: false, reason: 'блок вне прогруженного мира' }
  if (item && target.name === item) return { ok: true, already: target.name }
  if (target.boundingBox !== 'empty') return { ok: true, already: target.name }
  // Факел без коллизии законно стоит там же, где тело (как lightNiche).
  if (isOurOwnSpace(bot, pos) && item !== 'torch') return { ok: false, reason: 'это моя же клетка' }
  const squatter = occupiedByEntity(bot, pos)
  if (squatter) return { ok: false, reason: `в клетке стоит ${squatter}` }

  const cannot = await holdFiller(bot, item, steady)
  if (cannot) return { ok: false, reason: cannot }
  if (ctl?.aborted) return { ok: false, reason: 'прервано' }

  const first = await againstFaces(bot, pos, timeoutMs, { honest, ctl })
  if (first.ok) return first
  if (first.refs) return { ok: false, refused: first.refused, reason: first.reason }
  // Open air on all six sides. Nothing about the bag, the tool or the server:
  // mineflayer can only place *against* something, and there is no something.
  // `noFooting` is the same fact for a caller that would rather branch than
  // parse Russian.
  if (!prop || !isNeighbour(pos, prop)) return { ok: false, noFooting: true, reason: NO_FACE }

  const at = xyz(prop)
  const under = await placeBlockAt(bot, prop, { item, timeoutMs, steady, honest, ctl })
  if (!under.ok) {
    return {
      ok: false,
      noFooting: true,
      prop: { at, reason: under.reason, refused: under.refused },
      reason: `${NO_FACE}; подпорку на ${at.x},${at.y},${at.z} поставить не вышло: ${under.reason}`
    }
  }
  const propped = { at, placed: under.placed || under.already, face: under.face }
  const again = await holdFiller(bot, item, steady)
  if (again) return { ok: false, prop: propped, reason: `подпорку поставил, а на сам блок: ${again}` }
  const second = await againstFaces(bot, pos, timeoutMs, { honest, ctl })
  if (second.ok) return { ...second, prop: propped }
  return { ok: false, prop: propped, refused: second.refused, reason: second.reason }
}

// Which face of the reference a placement clicked. FACES points from the
// reference to the target, so y -1 is the reference ABOVE the target: its
// underside, the one face a player standing over it never sees.
const faceKind = f => (f.y < 0 ? 'bottom' : f.y > 0 ? 'top' : 'side')

// One pass over the six neighbours of `pos` with whatever is in hand.
// honest — только грани, которые видно из глаз (pick.faceAim): блок у
// противника (ловушка, опора наковальни) не ставится сквозь стенку, за которой
// грани не видно, — клиент игры так не может (2026-09-26, «чит WH»).
async function againstFaces (bot, pos, timeoutMs, { honest = false, ctl = null }: any = {}) {
  const torch = bot.heldItem?.name === 'torch'
  const expected = bot.heldItem?.name
  const appeared = b => b && (b.boundingBox !== 'empty' || b.name === expected || (torch && /^(wall_)?torch$/.test(b.name)))
  let last = null
  // Counted, because «нечего было пробовать» and «пробовал, не вышло» are two
  // different refusals with two different answers, and until today both came
  // out as the same six words. The descent that stopped at y=-36 spent eight
  // legs of a trip on the first one while reading it as the second.
  let refs = 0
  // The faces tried and not given, and on success the face that took. A caller
  // that builds on a claim no run has yet confirmed in the game (the underside,
  // see placeBlockAt) needs the answer as a field, or «the server refused that
  // face» and «that face never came up» read the same.
  const refused = []
  for (const face of FACES) {
    if (ctl?.aborted) return { ok: false, refs, reason: 'прервано' }
    if (torch && face.y < 0) continue // обычный факел не крепится снизу к потолку
    const ref = bot.blockAt(pos.minus(face))
    if (!ref || ref.boundingBox !== 'block' && ref.name !== 'cobweb') continue
    if (/water|lava/.test(ref.name)) continue
    if (honest && !require('./pick').faceAim(bot, ref.position, face)) continue
    refs++
    try {
      // Целимся туда же, куда прицелится сам placeBlock, а не в центр клетки.
      // mineflayer смотрит второй раз внутри _genericPlace (generic_place.js:38),
      // и тот взгляд НЕ форсирован — placeBlock передаёт только {swingArm}. А
      // нефорсированный ждёт, пока догоняющий lastSentYaw сравняется с
      // bot.entity.yaw, и догоняет он не быстрее 0.15 рад за тик
      // (physics.js:166, prismarine-physics yawSpeed 3.0) — 8.6° за 50 мс.
      // Центр клетки и центр грани опоры разнесены на полблока, с метра это
      // десятки градусов и несколько тиков ожидания внутри нашего же поводка.
      // Прицел в ту же точку делает второй взгляд пустым: yawChange === 0 и
      // ранний return.
      const aim = ref.position.offset(0.5 + face.x * 0.5, 0.5 + face.y * 0.5, 0.5 + face.z * 0.5)
      await bot.lookAt(aim, true)
      if (ctl?.aborted) return { ok: false, refs, reason: 'прервано' }
      // A cancellable call has already aimed; avoid another async look inside
      // generic_place between the cancellation check and the actual packet.
      await withTimeout(ctl && bot._placeBlockWithOptions
        ? bot._placeBlockWithOptions(ref, face, { forceLook: 'ignore', swingArm: 'right' })
        : bot.placeBlock(ref, face), timeoutMs)
      const now = bot.blockAt(pos)
      if (appeared(now)) return { ok: true, placed: now.name, face: faceKind(face) }
      last = new Error('блок не появился')
    } catch (e) {
      last = e
      // The server may still have applied it even though we timed out waiting.
      const now = bot.blockAt(pos)
      if (appeared(now)) return { ok: true, placed: now.name, face: faceKind(face), note: 'подтверждения не дождался' }
    }
    refused.push(faceKind(face))
  }
  if (!refs) return { ok: false, refs, reason: NO_FACE }
  return { ok: false, refs, refused, reason: last ? last.message : 'не к чему прислонить блок' }
}

// Fill a list of coordinates, skipping the ones that are already solid.
// Reports partial success, because a wall with one hole is still worth having.
async function placeMany (bot, ctl, positions, opts: any = {}) {
  let placed = 0
  const failed = []
  for (const pos of positions) {
    if (ctl && ctl.aborted) break
    const r = await placeBlockAt(bot, pos, opts)
    if (r.ok) { if (!r.already) placed++ } else failed.push(r.reason)
  }
  return { placed, failed: failed.length ? failed : undefined }
}

// Climb by jumping and dropping a block under our own feet mid-air. The only
// way up out of a hole we dug ourselves, and the standard way past a cliff.
// `item` — чем именно (леса архитектора берут то, что стройке не нужно);
// без него — первый наполнитель из FILLER, как было.
// maxDigMs — дольше этого не ломать то, что мешает в клетке ног (паутину без
// меча и ножниц: 20 с рукой); abortIf() — причина бросить столб (горю, бьют),
// спрашивается перед каждым блоком.
// beforeStep — перед каждым блоком (await): пауза на защиту (щит к стрелку,
// pvp.js), 'abort' — бросить столб.
async function towerUp (bot, ctl, blocks = 1, { sneak = true, item = null, maxDigMs = 2000, abortIf = null, beforeStep = null, fast = false }: any = {}): Promise<{ ok: boolean; placed: number; supportPlaced?: number; reason?: string; why?: string[] }> {
  const stack = item ? itemNamed(bot, item) : pickFiller(bot)
  if (!stack) return { ok: false, placed: 0, reason: item ? `нет ${item} на столб` : 'нечем строить столб' }
  try { await bot.equip(stack, 'hand') } catch (e) { return { ok: false, placed: 0, reason: e.message } }

  let placed = 0
  let supportPlaced = 0
  const baseY = Math.floor(bot.entity.position.y)
  const why = []
  for (let i = 0; i < blocks && !(ctl && ctl.aborted); i++) {
    const stop = abortIf ? abortIf() : null
    if (stop) { why.push(stop); break }
    if (beforeStep) {
      let r = null
      try { r = await beforeStep() } catch {}
      if (r === 'abort') { why.push('бросил столб'); break }
      // Щит и взгляд отняли руку и поворот — блок снова в руку.
      if (r && (!bot.heldItem || bot.heldItem.name !== stack.name)) {
        const again = itemNamed(bot, stack.name)
        if (!again) { why.push('блоки кончились'); break }
        try { await bot.equip(again, 'hand') } catch {}
      }
    }
    const feet = bot.entity.position.floored()
    const below = bot.blockAt(feet.offset(0, -1, 0))
    const head = bot.blockAt(feet.offset(0, 2, 0))
    if (!below) { why.push('под ногами пусто'); break }
    // No point jumping into a ceiling.
    if (head && head.boundingBox === 'block') { why.push(`потолок ${head.name}`); break }

    // Our own feet square can hold something that does not block movement but
    // does block building. A wall torch is the one that bit us: shelter lights
    // the niche, and then the climb out stalls one block down because the
    // server will not put cobblestone where the torch is.
    // Ломать — самым быстрым (tools.equipFastest в bot.dig): паутину мечом или
    // ножницами 0.4 с, а не блоком столба в руке — им она снимается 20 с
    // (арена 2026-09-26: бот ковырял паутину булыжником, стоя в лаве, и
    // сгорел). Дольше maxDigMs — не ломать: пусть решает тот, кто звал.
    // Паутина в клетке головы держит так же: прыжок в ней ×0.05 по высоте
    // (WebBlock.entityInside), столб не растёт — «не подпрыгнул (+0.01)» по
    // кругу (замер 2026-09-26, try-webclimb.js). Поэтому обе клетки тела.
    const feetB = bot.blockAt(feet)
    if (feetB && /^(lava|fire|soul_fire)$/.test(feetB.name)) { why.push(`стою в ${feetB.name}`); break }
    let blocked = false
    for (const inTheWay of [feetB, bot.blockAt(feet.offset(0, 1, 0))]) {
      if (!inTheWay || inTheWay.name === 'air' || inTheWay.boundingBox !== 'empty' || /water|lava|air$/.test(inTheWay.name)) continue
      const tools = require('./tools')
      if (!tools.breakable(inTheWay)) continue
      const plan = tools.bestFor(bot, inTheWay)
      if (plan.ms > maxDigMs) { why.push(`мешает ${inTheWay.name}: ${plan.item ? plan.item.name : 'рукой'} ${(plan.ms / 1000).toFixed(1)} с`); blocked = true; break }
      try {
        await withTimeout(bot.dig(inTheWay, true), plan.ms + 1500)
        await sleep(100)
      } catch {
        why.push(`мешает ${inTheWay.name}`)
      }
    }
    if (blocked) break
    // Блок столба — снова в руку: резали, скорее всего, мечом.
    if (!bot.heldItem || bot.heldItem.name !== stack.name) {
      const again = itemNamed(bot, stack.name)
      if (!again) { why.push(`кончился ${stack.name}`); break }
      try { await bot.equip(again, 'hand') } catch (e) { why.push(e.message); break }
    }

    let waterSide = null
    if (/^(water|bubble_column)$/.test(feetB?.name || '')) {
      // Liquid jump adds 0.04/tick (LivingEntity.jumpInLiquid), so one source
      // layer only lifts the feet ~0.82: it never clears a full block below us.
      // A low side face gives the native jumpOutOfFluid impulse. Keep the
      // original column: callers remember its coordinates, not a shifted one.
      bot.clearControlStates()
      for (let t = 0; t < 24 && !bot.entity.onGround && !ctl?.aborted; t++) await sleep(25)
      await centerOnFloor(bot, ctl, 1000, { water: true })
      if (ctl?.aborted) break
      const pick = require('./pick')
      const dry = b => !!b && b.boundingBox === 'empty' && !/water|bubble_column|lava|fire|cobweb/.test(b.name)
      const full = b => b?.boundingBox === 'block' && b.shapes?.some(s => s.length === 6 && s.every((v, i) => v === (i < 3 ? 0 : 1)))
      const sides = [new Vec3(1, 0, 0), new Vec3(-1, 0, 0), new Vec3(0, 0, 1), new Vec3(0, 0, -1)]
      // A visible existing step has zero block cost; use it before adding one.
      sides.sort((a, b) => Number(full(bot.blockAt(feet.plus(b)))) - Number(full(bot.blockAt(feet.plus(a)))))
      for (const d of sides) {
        const side = feet.plus(d)
        if (!dry(bot.blockAt(side.offset(0, 1, 0))) || !dry(bot.blockAt(side.offset(0, 2, 0)))) continue
        const b = bot.blockAt(side)
        if (!full(b)) {
          if (!b || b.boundingBox !== 'empty' || /lava|fire|cobweb/.test(b.name)) continue
          const r = await placeBlockAt(bot, side, { item: stack.name, honest: true, timeoutMs: 900, ctl })
          if (!r.ok) continue
          if (!r.already) supportPlaced++
        }
        if (ctl?.aborted) break
        if (pick.faceAim(bot, side, d.scaled(-1))) { waterSide = d; break }
      }
      if (ctl?.aborted) break
      if (!waterSide) { why.push('нет низкой грани для выхода из воды'); break }
    } else if (!fast) await centerOnFloor(bot, ctl)
    const startY = bot.entity.position.y
    try {
      // Строго вниз, под ноги — туда, куда ставим. В mineflayer наклон вверх
      // положительный: здесь стояло +π/2, и бот строил столб, глядя в небо
      // (блок всё равно вставал — пакет установки идёт с forceLook: 'ignore', —
      // но со стороны это выглядело нелепо).
      await bot.look(waterSide ? Math.atan2(-waterSide.x, -waterSide.z) : bot.entity.yaw, -Math.PI / 2, true)
      if (ctl?.aborted) break
      // Sneak keeps the body from walking off the one-block pillar it is
      // standing on between placements. It does not stop knockback, but it
      // stops the bot from strolling off its own tower. Inside a shaft there
      // is nothing to fall off, and it only costs jump clearance there.
      bot.setControlState('sneak', waterSide ? false : sneak)
      if (waterSide) bot.setControlState('forward', true)
      bot.setControlState('jump', true)

      // Wait for the body to actually clear the square being filled. The
      // server rejects a block placed inside the player, and a fixed 130ms
      // delay was not enough — the bot rose, the place failed, and it dropped
      // straight back down. Watched it happen while a zombie chewed on it.
      // 1.1 rather than 1.0, plus one tick of grace: the server rejects a
      // block placed inside the player, and it judges that against the last
      // position packet it received, not against what the client already
      // believes. Firing the moment the client crosses 1.0 was consistently
      // refused.
      let clear = false
      for (let t = 0; t < 24 && !clear && !ctl?.aborted; t++) {
        await sleep(25)
        const p = bot.entity.position
        // Release while still against the face (horizontal velocity is zero),
        // as soon as native water escape supplied the lift. Waiting until the
        // apex carries the body onto the adjacent block and shifts the tower.
        if (waterSide && bot.entity.velocity.y >= bot.physics?.outOfLiquidImpulse) bot.setControlState('forward', false)
        if (Math.floor(p.x) !== feet.x || Math.floor(p.z) !== feet.z) break
        clear = p.y - feet.y >= 1.1
      }
      bot.setControlState('jump', false)
      if (waterSide) bot.setControlState('forward', false)
      if (clear) await sleep(60)
      if (ctl?.aborted) break
      if (!clear) { why.push(`не подпрыгнул (+${(bot.entity.position.y - startY).toFixed(2)})`); continue }
      if (bot.entity.position.y < feet.y + 1) { why.push('опустился до установки'); continue }

      // Fire the packet the instant the body clears the square, skipping
      // mineflayer's own smooth lookAt and its wait for a block update: those
      // two together outlast the jump, and by the time they finish the bot has
      // fallen back into the square it was trying to fill, so the server
      // refuses it. We are already looking straight down, so the look is the
      // part we can afford to drop. Then verify rather than trust.
      await bot._genericPlace(below, new Vec3(0, 1, 0), { forceLook: 'ignore', swingArm: 'right' })
      if (await waitForBlock(bot, feet, 900)) placed++
      else why.push(`сервер не поставил блок под ноги (${(bot.blockAt(feet) || {}).name})`)
    } catch (e) {
      // A missed jump-place is normal; the loop just tries again from wherever
      // the body landed.
      why.push(e.message.slice(0, 60))
    } finally {
      try { bot.setControlState('jump', false) } catch {}
      if (waterSide) { try { bot.setControlState('forward', false) } catch {} }
    }
    // В бою (fast) — не 250 мс, а до приземления на новый блок: шаг столба
    // ~0.5 с вместо ~0.7, и между выстрелами лучника встаёт лишний блок.
    if (fast) {
      for (let k = 0; k < 10 && !bot.entity.onGround; k++) await sleep(25)
      await sleep(40)
    } else await sleep(250)
  }
  try { bot.setControlState('sneak', false) } catch {}
  return { ok: placed >= blocks && bot.entity.position.y >= baseY + blocks, placed,
    ...(supportPlaced ? { supportPlaced } : {}), why: why.length ? why : undefined }
}



// Break the ceiling straight overhead and climb into the gap. Sand and gravel
// pour into the shaft the moment they are unsupported, so the block above is
// re-read every swing instead of trusting a plan made three swings ago.
async function digUp (bot, ctl, { blocks = 3, mcData = null, tower = true, guard = null }: any = {}) {
  let dug = 0
  let stopped = null
  const threatened = () => {
    const mob = guard && guard()
    if (!mob) return false
    stopped = `${mob.who.name} подошёл на ${Math.round(mob.dist)} — прерываю столб`
    return true
  }

  const clear = async (offset, required) => {
    if (threatened()) return false
    const above = bot.blockAt(bot.entity.position.floored().offset(0, offset, 0))
    if (!above) { if (required) stopped = 'потолок ещё не загружен — не копаю'; return false }
    if (/lava|water|bubble_column/.test(above.name)) { if (required) stopped = `сверху ${above.name} — не копаю`; return false }
    if (above.boundingBox === 'empty') return true
    // A solid ceiling can be the only plug holding back a lava pocket.
    // This probe can only refuse a dig; it never reveals ore to the planner.
    for (const d of [new Vec3(0, 1, 0), new Vec3(1, 0, 0), new Vec3(-1, 0, 0), new Vec3(0, 0, 1), new Vec3(0, 0, -1)]) {
      const behind = bot.blockAt(above.position.plus(d))
      if (behind && /lava|water|bubble_column/.test(behind.name)) {
        if (required) stopped = `${behind.name} за потолком — не вскрываю`
        return false
      }
    }
    if (above.name === 'bedrock') { if (required) stopped = 'сверху бедрок'; return false }
    if (mcData) {
      const problem = missingHarvestTool(bot, above, mcData)
      if (problem) { if (required) stopped = problem; return false }
    }
    try {
      await equipBestTool(bot, above)
      await bot.dig(above)
      dug++
      await sleep(150)
      return true
    } catch (e) {
      if (required) stopped = e.message
      return false
    }
  }

  for (let i = 0; i < blocks && !(ctl && ctl.aborted); i++) {
    // Two blocks of headroom, not one. With a ceiling still at feet+3 the jump
    // tops out around +1.2 and the block dropped under our own feet misses its
    // window — measured in game, the bot climbed one block and then sat in its
    // own shaft reporting that it had nothing to build with. The second block
    // is best-effort: bedrock or lava overhead should not cost us the climb we
    // can still make.
    if (!(await clear(2, true))) break
    await clear(3, false)
    if (!tower || threatened()) break

    const up = await towerUp(bot, ctl, 1, { sneak: false })
    if (!up.placed) { stopped = (up.reason || 'столб не встал') + (up.why ? `: ${up.why[0]}` : ''); break }
  }

  return { dug, stopped: stopped || undefined }
}

// Boxed in on at least three sides with walls above them: the shape of the
// bottom of our own dig_down shaft.
function inPit (bot) {
  const feet = bot.entity.position.floored()
  let walls = 0
  for (const [dx, dz] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
    const side = bot.blockAt(feet.offset(dx, 0, dz))
    const over = bot.blockAt(feet.offset(dx, 1, dz))
    if (side && side.boundingBox === 'block' && over && over.boundingBox === 'block') walls++
  }
  if (walls >= 3) return true
  // Two walls is a shaft with a niche cut in it, or the mouth of a drift — the
  // shapes a descent actually leaves behind. Counting neighbours cannot tell
  // those from a corner of an open room, so the expensive question gets asked
  // only here: can a walking body get five blocks away without climbing. Asked
  // for every square it would also call a 3x3 chamber a pit, and goto would
  // then dig for the sky from inside a perfectly good room. Required lazily
  // because survival.js needs this module back.
  if (walls < 2) return false
  try { return !require('./survival').pitCheck(bot).free } catch { return false }
}

// Pathfinder cannot climb a 1x1 column: it plans a route the body cannot walk
// and the stuck guard fires. Measured during the first descent — goto out of a
// three-block shaft failed with "застрял на air у air", and the bot then sat
// there suffocating. Climbing out first turns that into an ordinary walk.
async function escapePit (bot, ctl, { maxClimb = 24, mcData = null }: any = {}) {
  if (!inPit(bot)) return { wasInPit: false, climbed: 0 }
  const startY = bot.entity.position.y

  for (let i = 0; i < maxClimb && !(ctl && ctl.aborted); i++) {
    if (!inPit(bot)) break
    const before = bot.entity.position.y
    const r = await digUp(bot, ctl, { blocks: 1, mcData, tower: true })
    if (bot.entity.position.y - before < 0.5) {
      return { wasInPit: true, climbed: Math.round(bot.entity.position.y - startY), stopped: r.stopped || 'выше не поднимаюсь' }
    }
  }
  return { wasInPit: true, climbed: Math.round(bot.entity.position.y - startY) }
}

module.exports = {
  FACES, FILLER, ARENA_FILLER, pickFiller, withTimeout, waitForBlock, placeBlockAt, placeMany, towerUp, digUp,
  isFree, occupiedByEntity, inPit, escapePit
}
