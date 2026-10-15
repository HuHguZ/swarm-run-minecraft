'use strict'
const gameClock = require('./game-clock')
// Блочный клатч от падения (TODO.md «Спидраннерское перемещение блоками», шаг 1;
// Codex 30.09.2026, codex-lab/clutch — механика по javap Paper 1.21.11, таблицы
// там же: placement-mechanics.md, fall-mechanics.md). Там, где вода не годится —
// Ад, нет ведра в хотбаре, посадка на листву/полублок/забор, внизу лава или
// пустота, — блок на ВИДИМУЮ грань (pick.faceAim), чтобы сесть на него с < 4
// блоков (урон = floor(fall + 1e-6 − 3), LivingEntity.calculateFallDamage):
// у стены — на её боковую грань в первые тики падения, при отбросе с края —
// цепочка до 3 блоков под траекторией (по одному за тик, каждый опирается на
// предсказанный предыдущий).
// Тик: решение на physicsTick по позиции, которую уйдёт пакетом этого тика;
// клик — сразу после пакета позиции (событие move), так сервер проверит
// пересечение клетки с телом (BlockItem.canPlace → Level.checkEntityCollision,
// касание можно) по той же позиции. Блок ставим и в свой мир (как ванильный
// клиент), чтобы следующий simulate уже встал на него; отказ сервера
// (block_change с другим состоянием) или тишина 1 с — откат.
// Зависимости — параметрами (Vec3, faceAim, simulate, makeBlock, PlayerState,
// общая рука lockHand): модуль переносим и тестируем без сокетов.
const IDLE = Object.freeze({ forward: false, back: false, left: false, right: false, jump: false, sprint: false, sneak: false })
const FILLER = /^(cobblestone|cobbled_deepslate|dirt|netherrack|stone|deepslate|andesite|diorite|granite|tuff|blackstone|basalt|obsidian|crying_obsidian|[a-z_]+_planks)$/
const REPLACE = /^(air|cave_air|void_air|water|lava|short_grass|tall_grass|fern|large_fern|dead_bush|snow)$/
const INTERACTIVE = /chest|barrel|furnace|crafting_table|enchanting_table|anvil|door|trapdoor|button|lever|bed|shulker|hopper|dispenser|dropper|smoker|loom|stonecutter|grindstone|cartography_table|smithing_table|composter|note_block|jukebox|respawn_anchor/
const key = p => `${Math.floor(p.x)},${Math.floor(p.y)},${Math.floor(p.z)}`
function replaceable (b) {
  return !!(b && REPLACE.test(b.name) && (b.name !== 'snow' || Number(b.getProperties?.().layers) === 1))
}
function othersOf (entities, selfId) {
  return (Object.values(entities || {}) as any[]).filter((e : any) => e && e.position && (selfId == null || e.id !== selfId) && e.isValid !== false &&
    e.blocksBuilding !== false && !/^(item|experience_orb|arrow|spectral_arrow|snowball|egg|fireball|small_fireball|wind_charge)$/.test(e.name || ''))
}
const occupied = (cell, others) => others.some(e => intersects(cell, e.position, e.width || 0.6, e.height || 1.8))
const fullReference = b => !!(b && b.boundingBox === 'block' && !INTERACTIVE.test(b.name) && b.shapes && b.shapes.some(s => s.every((v, i) => v === (i < 3 ? 0 : 1))))
// BlockItem placement needs a clickable reference, not a full cube. faceAim
// still proves the actual face; ladders retain their full support requirement.
const blockReference = b => !!(b && b.boundingBox === 'block' && !INTERACTIVE.test(b.name) && b.shapes?.length)
function intersects (cell, pos, width = 0.6, height = 1.8) {
  // Strict intersection: feet exactly at the cube top are allowed.
  return pos.x + width / 2 > cell.x && pos.x - width / 2 < cell.x + 1 &&
    pos.z + width / 2 > cell.z && pos.z - width / 2 < cell.z + 1 && pos.y < cell.y + 1 && pos.y + height > cell.y
}
// Паутина — последней (пользователь 14.10: «паутину себе могут ставить, когда в обрыв летят, если ничего другого нет —
// погасит скорость»): твёрдого блока нет — паутина под ноги; в ней скорость падения ×0.05 и fallDistance сброшен (тег
// FALLDAMAGE_RESETTING), а дальше клатч молчит (climbing).
function selectBlock (slots: any, reserve: any = 0, pending: any = 0) {
  return selectOf(slots, FILLER, reserve, pending) || selectOf(slots, /^cobweb$/, 0, pending)
}
function selectOf (slots: any, kind: RegExp, reserve: any, pending: any) {
  // S1f: доски — последними (в Аду дерево — палки и кирки: s1f-FB-1 «нет безопасного дерева на 4 доски», доски ушли в клатч и мост).
  const items = slots.filter(i => i && kind.test(i.name)).sort((p, q) => (/_planks$/.test(p.name) ? 1 : 0) - (/_planks$/.test(q.name) ? 1 : 0))
  const total = pending instanceof Map ? [...pending.values()].reduce((n, v) => n + v, 0) : pending
  if (items.reduce((s, i) => s + i.count, 0) - total <= reserve) return null
  let left = total
  return items.find(i => {
    if (i.slot < 36 || i.slot > 44) return false
    const used = pending instanceof Map ? (pending.get(i.slot) || 0) : Math.min(left, i.count)
    if (!(pending instanceof Map)) left -= used
    return i.count > used
  }) || null
}
function decide (ctx) {
  const a = ctx; const l = a.landing || { top: -Infinity }
  if (a.mode === 'creative' || a.mode === 'spectator' || a.mode === 1 || a.mode === 3 || a.dead ||
      a.dragon || a.wind || a.mace || a.swimming || a.lava || a.intentional || a.guardAllow || a.waterPlaced ||
      a.elytra || a.riding || a.slowFalling || a.levitation || a.climbing) return { action: 'none', why: 'excluded' }
  // На земле — не клатч (ревью координатора 30.09): прогноз 24 тиков с зажатыми
  // клавишами «уводил» с края любое тело, которое pathfinder вёл вдоль обрыва, и
  // клатч строил бы мост на каждом повороте. Отброс и шаг с края — уже в воздухе
  // на первом же physicsTick (simulate идёт раньше), там и ловим.
  if (a.ground) return { action: 'none', why: 'on_ground' }
  if (l.unknown) return { action: 'none', why: 'unknown_world' }
  if (l.water && !l.deep) return { action: 'none', why: 'natural_water' }
  if (Number.isFinite(l.top) && a.peak - l.top <= 3 && !l.lava && !l.deep) return { action: 'none', why: 'safe_landing' }
  const bucket = a.hasBucketBar || Number.isFinite(a.bucketReadyIn) && a.bucketReadyIn <= (a.ticksToWater ?? 0)
  const guarded = a.waterEligible !== false && a.peak - l.top - 3 >= Math.min((a.minFall ?? 6) - 3, (a.hp ?? 20) - 1)
  if (!/nether/.test(String(a.dimension)) && bucket && guarded && Number.isFinite(l.top) && !l.bad && !l.lava && !l.deep && !a.waterTooLate) return { action: 'water', why: 'bucket' }
  return a.blocks > 0 ? { action: 'clutch', why: a.waterTooLate ? 'late_water' : 'unsafe_or_no_water' } : { action: 'none', why: 'no_blocks' }
}
function copyState (s, control = s.control || IDLE) {
  return Object.assign(Object.create(Object.getPrototypeOf(s)), s, { pos: s.pos.clone(), vel: s.vel.clone(), control: { ...control }, jumpQueued: false })
}
function create ({ Vec3, faceAim, simulate, makeBlock }: any) {
  if (!Vec3 || !faceAim || !simulate || !makeBlock) throw new TypeError('Vec3, faceAim, simulate, makeBlock required')
  const faces = [[1, 0, 0], [-1, 0, 0], [0, 1, 0], [0, -1, 0], [0, 0, 1], [0, 0, -1]].map(v => new Vec3(...v))
  const full = fullReference
  function candidates (s, world, options: any = {}) {
    const sp = options.serverPos || s.pos; const cells = new Map()
    const probe = copyState(s, options.control || IDLE)
    for (let t = 0; t < 7; t++) {
      const yMax = Math.floor(Math.min(s.pos.y, sp.y) + 1e-9) - 1
      for (let y = yMax; y >= yMax - 2; y--) {
        for (const dx of [-0.299, 0.299]) for (const dz of [-0.299, 0.299]) {
          const c = new Vec3(Math.floor(probe.pos.x + dx), y, Math.floor(probe.pos.z + dz))
          cells.set(key(c), c)
        }
      }
      simulate(probe, world)
    }
    const others = othersOf(options.entities, options.selfId)
    const bot = { entity: { position: s.pos }, entities: {}, blockAt: p => world.getBlock(p) }
    const eye = sp.offset(0, options.eyeHeight ?? 1.62, 0)
    const out = []
    for (const c of cells.values()) {
      const b = world.getBlock(c)
      if (!replaceable(b) || intersects(c, sp) || intersects(c, s.pos) || occupied(c, others)) continue
      for (const face of faces) {
        const ref = c.minus(face); const rb = world.getBlock(ref)
        if (!blockReference(rb) || options.canReference && !options.canReference(rb)) continue
        const point = faceAim(bot, ref, face, { eye, range: 4.5, avoid: others })
        if (!point) continue
        const d = point.minus(eye)
        out.push({ cell: c, ref, face, point, cursor: point.minus(ref), tick: 0,
          yaw: Math.atan2(-d.x, -d.z), pitch: Math.atan2(d.y, Math.hypot(d.x, d.z)) })
        break
      }
    }
    return out.sort((a, b) => b.cell.y - a.cell.y || a.cell.distanceTo(s.pos) - b.cell.distanceTo(s.pos))
  }
  function rollout (s, world, first, options) {
    const inserted = new Map([[key(first.cell), makeBlock(first.cell)]])
    const virtual = { getBlock: p => inserted.get(key(p)) || world.getBlock(p) }
    const control = options.control || IDLE
    const st = copyState(s, control); st.yaw = first.yaw
    const chain = [{ ...first, tick: 0 }]
    let peak = Math.max(options.peak ?? s.pos.y, s.pos.y)
    for (let t = 1; t <= (options.maxTicks ?? 24); t++) {
      simulate(st, virtual); peak = Math.max(peak, st.pos.y)
      if (st.isInWater || st.isInLava) return null
      if (st.onGround) {
        const contact = [...inserted.values()].some(b => Math.abs(st.pos.y - b.position.y - 1) < 1e-6 &&
          st.pos.x + 0.3 > b.position.x && st.pos.x - 0.3 < b.position.x + 1 && st.pos.z + 0.3 > b.position.z && st.pos.z - 0.3 < b.position.z + 1)
        if (!contact) return null
        return { ...first, landingY: st.pos.y, fall: peak - st.pos.y, landTick: t, chain, control: { ...control } }
      }
      if (chain.length < options.maxBlocks) {
        // One extension per tick, each using an actually visible face of an
        // earlier virtual block. Real guard revalidates the whole plan next tick.
        const extensions = candidates(st, virtual, { ...options, serverPos: st.pos, control })
          .filter(p => inserted.has(key(p.ref)))
        if (extensions.length) {
          const next = extensions[0]
          inserted.set(key(next.cell), makeBlock(next.cell)); chain.push({ ...next, tick: t })
          st.yaw = next.yaw
        }
      }
    }
    return null
  }
  function plan (options) {
    const { state: s, world } = options
    const maxBlocks = Math.min(options.maxBlocks ?? 3, options.blockCount ?? 3)
    if (maxBlocks <= 0) return null
    const controls = options.steer === false ? [IDLE] : [IDLE, { ...IDLE, forward: true }, { ...IDLE, back: true }, { ...IDLE, left: true }, { ...IDLE, right: true }]
    let best = null
    for (const control of controls) {
      for (const c of candidates(s, world, { ...options, control })) {
        const p = rollout(s, world, c, { ...options, maxBlocks, control })
        if (!p) continue
        // deep (спуск блоками, navigation/descent.ts): из безопасных (≤ 3) одним блоком — самый глубокий, чтобы шаг
        // спуска был 3 блока, а не 1; иначе — как всегда: наименьшее падение, короче цепочка, раньше посадка.
        const rank = q => options.deep && q.fall <= 3 && q.chain.length === 1 ? [0, -q.fall, q.landTick] : [1, q.fall, q.chain.length, q.landTick]
        const a = rank(p); const b = best && rank(best); const i = b ? a.findIndex((v, j) => Math.abs(v - b[j]) > 1e-6) : -1
        if (!b || i >= 0 && a[i] < b[i]) best = p
        if (!options.deep && best.fall <= 3 && best.chain.length === 1) return best
      }
    }
    return best
  }


  // Лестница на стену (s6b 06.10, javap 1.21.11): Entity.move при шаге >= 1 блока за тик ведёт луч ног по движению
  // (ClipContext.Block.FALLDAMAGE_RESETTING: #climbable, ягоды, паутина; и вода) и при попадании сбрасывает fallDistance,
  // затем Entity.checkFallDamage добавляет лишь dy этого тика (не больше 3.92) — посадка через клетку с лестницей
  // не ранит; медленнее блока за тик тело входит в клетку и LivingEntity.handleOnClimbable тоже сбрасывает падение.
  // Лестница ставится кликом по видимой боковой грани полной стены в одну из трёх клеток над местом посадки, пока тело
  // выше клетки (BlockItem.canPlace не пустит тонкую пластину сквозь тело). `ladderBlock(cell, facing)` — блок лестницы.
  function ladderPlan (options) {
    const { state: s, world, ladderBlock } = options
    const sp = options.serverPos || s.pos
    const probe = copyState(s, IDLE); const path = [probe.pos.clone()]
    let land = null
    for (let t = 0; t < (options.maxTicks ?? 40); t++) {
      simulate(probe, world); path.push(probe.pos.clone())
      if (probe.isInWater || probe.isInLava) return null
      if (probe.onGround) { land = probe; break }
    }
    if (!land) return null
    const peak = Math.max(options.peak ?? s.pos.y, s.pos.y)
    // Клетки у пола достижимы рукой (4.5 от глаз) лишь в последние блоки падения — раньше не считать.
    if (peak - land.pos.y <= 3 || s.pos.y - land.pos.y > 6) return null
    const others = othersOf(options.entities, options.selfId)
    const bot = { entity: { position: s.pos }, entities: {}, blockAt: p => world.getBlock(p) }
    const eye = sp.offset(0, options.eyeHeight ?? 1.62, 0)
    const sides = faces.filter(f => f.y === 0)
    const names = { '1,0': 'east', '-1,0': 'west', '0,1': 'south', '0,-1': 'north' }
    let best = null
    for (let k = 0; k <= 2; k++) {
      const y = Math.floor(land.pos.y + 1e-9) + k
      // Колонна траектории на высоте клетки (падение почти отвесное; берём точку пути внутри клетки).
      const at = path.find(q => q.y < y + 1 && q.y >= y - 1e-9) || land.pos
      const c = new Vec3(Math.floor(at.x), y, Math.floor(at.z))
      if (!replaceable(world.getBlock(c)) || world.getBlock(c)?.name === 'water' || sp.y < c.y + 1 || s.pos.y < c.y + 1 || occupied(c, others)) continue
      for (const d of sides) {
        const ref = c.plus(d); const rb = world.getBlock(ref)
        if (!full(rb) || options.canReference && !options.canReference(rb)) continue
        const face = d.scaled(-1)
        const point = faceAim(bot, ref, face, { eye, range: 4.5, avoid: others })
        if (!point) continue
        const facing = names[`${face.x},${face.z}`]
        const ladder = ladderBlock(c, facing)
        const virtual = { getBlock: p => key(p) === key(c) ? ladder : world.getBlock(p) }
        const st = copyState(s, IDLE); let top = peak; let crossed = false
        for (let t = 1; t <= (options.maxTicks ?? 40); t++) {
          const from = st.pos.clone(); simulate(st, virtual)
          if (st.isInWater || st.isInLava) break
          top = Math.max(top, st.pos.y)
          // Луч ног этого тика через клетку лестницы: падение заново с точки входа (не выше верха клетки).
          const lo = Math.min(from.y, st.pos.y); const hi = Math.max(from.y, st.pos.y)
          const mx = Math.floor((from.x + st.pos.x) / 2); const mz = Math.floor((from.z + st.pos.z) / 2)
          if (!crossed && mx === c.x && mz === c.z && lo < c.y + 1 && hi >= c.y) { crossed = true; top = Math.min(hi, c.y + 1) }
          if (st.onGround) {
            const fall = top - st.pos.y
            if (crossed && fall <= 3 && (!best || fall < best.fall || fall === best.fall && t < best.landTick)) {
              const v = point.minus(eye)
              best = { kind: 'ladder', cell: c, ref, face, point, facing, fall, landTick: t, yaw: Math.atan2(-v.x, -v.z), pitch: Math.atan2(v.y, Math.hypot(v.x, v.z)) }
            }
            break
          }
        }
      }
    }
    return best
  }

  function landing (s, world, depth = 80) {
    let best = { top: -Infinity }
    for (const dx of [-0.299, 0.299]) for (const dz of [-0.299, 0.299]) {
      const x = Math.floor(s.pos.x + dx); const z = Math.floor(s.pos.z + dz)
      for (let y = Math.floor(s.pos.y); y >= Math.floor(s.pos.y) - depth; y--) {
        const p = new Vec3(x, y, z); const b = world.getBlock(p)
        if (!b) return { top: s.pos.y, unknown: true }
        let c = null
        if (b.name === 'lava') c = { top: y + 1, lava: true, cell: p.offset(0, 1, 0) }
        else if (b.name === 'water' || b.name === 'bubble_column') c = { top: y + 1, water: true, waterCell: p, deep: Math.floor(s.pos.y) - y > 12 }
        else if (b.boundingBox === 'block' && b.shapes && b.shapes.length) {
          const props = b.getProperties ? b.getProperties() : {}
          c = { top: y + Math.max(...b.shapes.map(sh => sh[4])), cell: p.offset(0, 1, 0), bad: 'waterlogged' in props || /^(cactus|magma_block|campfire|soul_campfire|pointed_dripstone|sweet_berry_bush|powder_snow)$/.test(b.name) }
        }
        if (c) { if (c.top > best.top) best = c; break }
      }
    }
    return best
  }
  return { plan, ladderPlan, candidates, landing, copyState }
}
function install (session, opts) {
  const bot = session.bot
  if (bot._ndClutch) return bot._ndClutch
  const { Vec3, PlayerState, faceAim, hand } = opts
  if (!hand || !hand.as || !hand.hold || !bot.world || !bot._genericPlace) throw new TypeError('shared hand, world and _genericPlace required')
  const now = opts.now || gameClock.now
  const eyeHeight = () => typeof opts.eyeHeight === 'function' ? opts.eyeHeight(bot) : (opts.eyeHeight ?? (bot.getControlState?.('sneak') ? 1.27 : 1.62))
  const simulate = opts.simulate || ((s, w) => (bot._ndSimOrig || bot.physics.simulatePlayer).call(bot.physics, s, w))
  const makeBlock = opts.makeBlock
  const api = create({ Vec3, faceAim, simulate, makeBlock })
  const world = { getBlock: p => bot.blockAt(p, false) }
  const pending = new Map(); const blocked = new Map(); const spent = new Map()
  let reservations = []
  const available = () => selectBlock(bot.inventory.slots, opts.reserve ?? 0, spent)
  const stats = { placed: 0, confirmed: 0, denied: 0, timeout: 0, landed: 0, saved: 0, no_face: 0, stale: 0, water_plans: 0, water_saved: 0, water_failed: 0, soft_plans: 0, soft_saved: 0, soft_failed: 0, ladders: 0 }
  const st: any = { stats, pending, api, peak: null, blocks: 0, t: 0, stopped: false, flight: null, path: [], lastDecision: null }
  let scheduled = null; let preparing = false; let lastPrepare = -Infinity; let barAt = -Infinity; let movement = null
  // Клавиши поимённо: у mineflayer bot.controlState — геттеры без enumerable, и
  // { ...bot.controlState } пуст → в прогнозе (undefined − undefined) = NaN по x/z
  // (ферма 30.09, clutch-dbg3: клатч молчал «unknown_world» на каждом падении).
  const controls = () => {
    const c = {}
    for (const k of Object.keys(IDLE)) c[k] = !!(typeof bot.getControlState === 'function' ? bot.getControlState(k) : bot.controlState && bot.controlState[k])
    return c
  }
  // BlockTags.CLIMBABLE 1.21.11 (клетка ног) и паутина.
  const CLIMB = /^(ladder|vine|scaffolding|weeping_vines|weeping_vines_plant|twisting_vines|twisting_vines_plant|cave_vines|cave_vines_plant|cobweb)$/
  const climbing = (p) => { const b = world.getBlock(p.floored ? p.floored() : new Vec3(Math.floor(p.x), Math.floor(p.y), Math.floor(p.z))); return !!(b && CLIMB.test(b.name)) }
  const emit = (what, detail: any = {}) => bot.emit('nd_clutch', { what, fall: st.flight ? st.flight.fall : 0, blocks: st.blocks, t: st.t, ...detail })
  function releaseSteering () {
    const own = st.steering
    if (!own) return
    for (const [k, v] of (Object.entries(own.control) as [string, any][])) if (bot.getControlState?.(k) === v) bot.setControlState?.(k, !!own.previous[k])
    st.steering = null
  }
  function releaseReservation (r) {
    if (!r.reserved) return
    r.reserved = false
    spent.set(r.slot, Math.max(0, (spent.get(r.slot) || 0) - 1))
  }
  function removePrediction (k, restore, reason?: any) {
    const p = pending.get(k)
    if (!p) return
    pending.delete(k)
    if (restore && world.getBlock(p.cell)?.stateId === p.stateId) bot.world.setBlockStateId(p.cell, p.oldStateId)
    if (reason) { stats[reason]++; releaseReservation(p); reservations = reservations.filter(r => r.reserved); if (st.flight) st.flight.denied = true; blocked.set(k, now() + 500); emit(reason, { cell: p.cell }) }
    // An unaccepted parent cannot support dependent unaccepted extensions.
    for (const [child, record] of [...pending]) if (record.refKey === k) removePrediction(child, true, 'denied')
  }
  function receipt (p, id) {
    const k = key(p); const r = pending.get(k)
    if (!r) return
    if (id === r.stateId) { pending.delete(k); r.confirmed = true; stats.confirmed++; if (st.flight) st.flight.confirmed = (st.flight.confirmed || 0) + 1; emit('confirmed', { cell: r.cell }) }
    else removePrediction(k, false, 'denied') // mineflayer already installed the authoritative state
  }
  const single = p => receipt(new Vec3(p.location.x, p.location.y, p.location.z), p.type)
  const multi = p => {
    // Protocol 1.21.11: one 16^3 section, number records (same decode as blocks.js).
    if (!p.chunkCoordinates) return
    for (const r of p.records) receipt(new Vec3(p.chunkCoordinates.x * 16 + ((r >> 8) & 15), p.chunkCoordinates.y * 16 + (r & 15), p.chunkCoordinates.z * 16 + ((r >> 4) & 15)), r >> 12)
  }
  st.expire = () => {
    for (const [k, p] of [...pending]) if (now() - p.sentAt >= (opts.confirmMs ?? 1000)) removePrediction(k, true, 'timeout')
    for (const [k, until] of blocked) if (now() >= until) blocked.delete(k)
  }
  function prepare () {
    if (opts.prepare === false || preparing || now() - lastPrepare < 1000 || bot.currentWindow || hand.on && hand.on()) return
    lastPrepare = now()
    if (selectBlock(bot.inventory.slots, opts.reserve ?? 0)) return
    const it = bot.inventory.items().find(i => FILLER.test(i.name) && i.slot < 36) || bot.inventory.items().find(i => i.name === 'cobweb' && i.slot < 36)
    if (!it || typeof bot.moveSlotItem !== 'function') return
    let dest = -1
    for (let i = 36; i <= 44; i++) if (!bot.inventory.slots[i] && i !== bot.quickBarSlot + 36) { dest = i; break }
    // S1f: хотбар полон — блоки для клатча обменять со слотом наименее нужного (не оружие/инструмент/ведро/щит/еда/жемчуг/зелья…).
    // «no_bar_slot» в 10 из 30 прогонов Ада вслепую, а «клатч молчит: no_blocks» при полном рюкзаке блоков — смерти в лаве (s1f-H2-2:
    // за прогон блоков почти не потрачено, в хотбаре их не было). ND_CLUTCH_SWAP=0 — прежнее.
    if (dest < 0 && process.env.ND_CLUTCH_SWAP !== '0') {
      const KEEP = /_(sword|axe|pickaxe|shovel|hoe|helmet|chestplate|leggings|boots)$|bucket|shield|bow$|crossbow|arrow|ender_pearl|ender_eye|flint_and_steel|fire_charge|potion|^cooked_|bread|golden_(apple|carrot)|_bed$|blaze_rod|blaze_powder|totem|crafting_table|^stick$/
      for (let i = 36; i <= 44; i++) { const s = bot.inventory.slots[i]; if (s && i !== bot.quickBarSlot + 36 && !KEEP.test(s.name) && !FILLER.test(s.name)) { dest = i; break } }
    }
    if (dest < 0) { emit('no_bar_slot'); return }
    preparing = true
    Promise.resolve(bot.moveSlotItem(it.slot, dest)).catch(e => emit('to_bar_failed', { error: e.message })).finally(() => { preparing = false; barAt = now() })
  }
  function intentional (s) {
    if (!opts.mlgDrop || !opts.mlgDrop(session).ok || !bot.pathfinder?.isMoving?.()) return false
    return st.path.some((p, i) => {
      const q = st.path[i + 1]
      return q && p.y - q.y >= 6 && s.pos.y <= p.y + 1.3 && s.pos.y >= q.y &&
        Math.hypot(s.pos.x - (p.x + 0.5), s.pos.z - (p.z + 0.5)) <= 1.7 &&
        Math.hypot(s.pos.x - (q.x + 0.5), s.pos.z - (q.z + 0.5)) <= 1.7
    })
  }
  function context (s) {
    const marker = bot._ndParkourForecast
    // Physics listeners can run before or after the movement controller has
    // advanced its marker to the next native tick. Both observed endpoints
    // belong to that one verified transition; drift and damage still revoke it.
    const guardAllow = now() < (bot._ndClutchAllowUntil || 0) || !!(marker && marker.until > now() && bot.health >= marker.hp &&
      Math.min(s.pos.distanceTo(marker.from), marker.next ? s.pos.distanceTo(marker.next) : Infinity) <= .1)
    // Supported movement needs no airborne rescue. A verified native skill
    // already owns its trajectory; reforecasting it at750TPS starves the clock.
    // An active water rescue still needs actual fluid/landing observations.
    const predict = !!st.waterPlan || !s.onGround && !guardAllow
    const forecast = copyState(s, s.control)
    let ticksToWater = Infinity; let settled = false
    for (let t = 0; predict && t < 24; t++) {
      simulate(forecast, world)
      if (forecast.isInWater || forecast.isInLava) { settled = true; break }
      if (forecast.onGround) {
        // A brief edge contact still carries horizontal momentum. Forecast the
        // neutral braking after contact before calling this a safe landing;
        // otherwise the guard omits its own necessary second support block.
        forecast.control = { ...IDLE }
        if (forecast.vel.x === 0 && forecast.vel.z === 0) { settled = true; break }
      }
    }
    const l: any = predict ? api.landing(forecast, world) : { top: s.onGround ? s.pos.y : -Infinity, unknown: !s.onGround, water: !!s.isInWater, lava: !!s.isInLava }
    // column's depth limit is relative to this tick's feet, not the forecast
    // after it has already reached a distant water surface.
    if (l.water) l.deep = Math.floor(s.pos.y) - Math.floor(l.top - 1) > 12
    if (opts.mlgLandingBad && l.cell && !l.lava) l.bad = !!opts.mlgLandingBad(bot, l.cell.x, l.cell.y, l.cell.z)
    if (predict && Number.isFinite(l.top)) {
      const probe = copyState(s, s.control)
      for (let t = 0; t < 24; t++) {
        if (probe.pos.y > l.top && probe.pos.y + 1.62 <= l.top + 4.5) { ticksToWater = t; break }
        simulate(probe, world)
        if (probe.onGround) break
      }
    }
    const ready = bot.inventory.slots.slice(36, 45).some(i => i?.name === 'water_bucket') && (!bot._ndFallGuard?.barAt || now() - bot._ndFallGuard.barAt >= 300)
    const next = copyState(s); if (predict) simulate(next, world)
    return { landing: l, peak: st.peak, feet: s.pos.y, blocks: available() ? 1 : 0, hp: bot.health, minFall: opts.waterMinFall ?? 6, waterEligible: !!bot._ndFallGuard,
      ground: !!s.onGround, elytra: !!(s.elytraFlying || bot.entity?.elytraFlying), riding: !!bot.vehicle,
      slowFalling: (s.slowFalling || 0) > 0, levitation: (s.levitation || 0) > 0, climbing: climbing(s.pos) || !!s.isInWeb,
      mode: bot.game?.gameMode, dimension: bot.game?.dimension, dead: bot.health <= 0,
      dragon: session.current?.name === 'dragon', swimming: s.isInWater, lava: s.isInLava, mace: !!(bot._ndDescend || bot._ndSmashNow),
      wind: !!bot._ndWindFall?.(l.top), waterPlaced: !!bot._ndFallGuard?.placed,
      intentional: intentional(s), guardAllow,
      hasBucketBar: ready, ticksToWater, waterTooLate: settled && next.onGround && s.pos.y + 1.62 > l.top + 4.5,
      ...(opts.context ? opts.context({ state: s, landing: l, peak: st.peak, guard: st }) : {}) }
  }
  function cancelScheduled () {
    if (movement) bot.removeListener('move', movement)
    movement = null; scheduled = null
  }
  function waterStep (s, ctx, decision) {
    const parkour = () => require('./navigation/parkour') as typeof import('./navigation/parkour')
    let own = st.waterPlan
    if (!own && !st.waterAttempted && opts.existingWater !== false && decision.why !== 'excluded' && decision.why !== 'unknown_world' && !ctx.ground && s.vel.y < -.08 &&
        (ctx.landing.deep || ctx.landing.lava || !Number.isFinite(ctx.landing.top) || ctx.peak - ctx.landing.top > 3)) {
      st.waterAttempted = true
      const began = performance.now(); const plan = parkour().planNearbyWaterEntry(bot, ctx.landing.waterCell)
      if (plan) {
        own = st.waterPlan = { plan, index: 0, hp: bot.health }
        stats.water_plans++; emit('water_plan', { target: plan.target, ticks: plan.ticks, planningMs: performance.now() - began })
      } else if (process.env.ND_SOFT_LANDING === '1') {
        // No water: steer onto a nearby floor that hurts less (hay/honey/slime), when
        // it beats the floor straight below. Off by default until a native series.
        const soft = parkour().planNearbySoftLanding(bot, ctx.peak)
        if (soft) {
          own = st.waterPlan = { plan: soft, index: 0, hp: bot.health, soft: soft.damage }
          stats.soft_plans++; emit('soft_plan', { target: soft.target, ticks: soft.ticks, damage: soft.damage, planningMs: performance.now() - began })
        }
      }
    }
    if (!own) return null
    const excluded = ctx.dead || ctx.lava || ctx.elytra || ctx.riding || ctx.mace || ctx.wind || ctx.dragon || ctx.guardAllow || ctx.mode === 'creative' || ctx.mode === 'spectator'
    const expected = own.index ? own.plan.states[own.index - 1] : null
    const allowed = own.soft ?? 0
    if (excluded || bot.health < own.hp - allowed || expected && s.pos.distanceTo(expected.pos) > .65) {
      stats[own.soft !== undefined ? 'soft_failed' : 'water_failed']++; emit(own.soft !== undefined ? 'soft_failed' : 'water_failed', { target: own.plan.target, at: s.pos, ticks: own.index, why: excluded ? 'owner_changed' : bot.health < own.hp - allowed ? 'hurt' : 'physics_diverged' })
      st.waterPlan = null; releaseSteering(); return null
    }
    if (own.index >= own.plan.steps.length) {
      const soft = own.soft !== undefined
      const ok = soft ? s.onGround && Math.hypot(s.pos.x - own.plan.target.x, s.pos.z - own.plan.target.z) < .35 && Math.abs(s.pos.y - own.plan.target.y) < .03 && bot.health >= own.hp - allowed
        : parkour().inWaterCell(bot, s, own.plan.target) && bot.health >= own.hp && Math.hypot(s.vel.x, s.vel.z) < .04
      const kind = soft ? 'soft' : 'water'
      stats[`${kind}_${ok ? 'saved' : 'failed'}`]++; emit(`${kind}_${ok ? 'saved' : 'failed'}`, { target: own.plan.target, at: s.pos, hp: bot.health, ticks: own.index })
      st.waterPlan = null; releaseSteering()
      return ok ? { action: 'none', why: soft ? 'soft_floor_landed' : 'existing_water_landed' } : null
    }
    const step = own.plan.steps[own.index++]
    const previous = st.steering?.previous || controls()
    bot.look(step.yaw, 0, true)?.catch?.(() => {})
    for (const [k, v] of Object.entries(step.control)) bot.setControlState?.(k, v)
    st.steering = { yaw: step.yaw, control: step.control, previous }
    return { action: 'clutch', why: own.soft !== undefined ? 'soft_floor' : 'existing_water' }
  }
  function fire (plan, snapshot, decision) {
    if (st.stopped || !scheduled || st.lastDecision?.action !== 'clutch') return
    cancelScheduled()
    const pos = bot.entity?.position
    if (!pos || pos.distanceTo(snapshot) > 1e-7) { stats.stale++; emit('stale'); return }
    // A custom afterPacket callback may execute after another simulation tick.
    // Abort stale work rather than use a different server AABB/eye accidentally.
    const s = new PlayerState(bot, controls())
    const current = context(s)
    if (decide(current).action !== 'clutch') return
    const rb = world.getBlock(plan.ref); const cell = world.getBlock(plan.cell)
    const others = othersOf(bot.entities, bot.entity.id)
    const eye = snapshot.offset(0, eyeHeight(), 0)
    const point = faceAim(bot, plan.ref, plan.face, { eye, range: 4.5, avoid: others })
    const item = available()
    if (!item || !replaceable(cell) || !blockReference(rb) || !point || intersects(plan.cell, snapshot) || occupied(plan.cell, others)) return
    const def = bot.registry.blocksByName[item.name]
    if (!def) return
    const virtualBlock = makeBlock(plan.cell, def.defaultState)
    if (!virtualBlock || !virtualBlock.shapes?.some(sh => sh.every((v, i) => v === (i < 3 ? 0 : 1)))) return
    const k = key(plan.cell)
    const record = { cell: plan.cell, refKey: key(plan.ref), oldStateId: cell.stateId, stateId: def.defaultState, sentAt: now(), slot: item.slot, reserved: true }
    // move is emitted after position/position_look; this look goes before place.
    // Explicit look also covers concurrent look changes and forceLook:'ignore'.
    // The same steering that proved this placement must own the body until
    // its forecast landing; a four-tick click pulse can end mid knockback arc.
    hand.hold(Math.max(200, plan.landTick * 50))
    hand.as(() => {
      const d = point.minus(eye)
      const yaw = Math.atan2(-d.x, -d.z); const pitch = Math.atan2(d.y, Math.hypot(d.x, d.z))
      bot.look(yaw, pitch, true)?.catch?.(() => {})
      bot._client.write('look', { yaw: 180 - yaw * 180 / Math.PI, pitch: -pitch * 180 / Math.PI,
        onGround: !!bot.entity.onGround, flags: { onGround: !!bot.entity.onGround, hasHorizontalCollision: !!bot.entity.isCollidedHorizontally } })
      if (bot.quickBarSlot !== item.slot - 36) bot.setQuickBarSlot(item.slot - 36)
      pending.set(k, record)
      reservations.push(record)
      spent.set(item.slot, (spent.get(item.slot) || 0) + 1)
      try {
        // _genericPlace writes synchronously until its first await; ignore
        // avoids that await. Cursor is the exact legal faceAim point.
        const sent = bot._genericPlace(rb, plan.face, { delta: point.minus(plan.ref), forceLook: 'ignore', swingArm: 'right' })
        bot.world.setBlockStateId(plan.cell, def.defaultState)
        Promise.resolve(sent).catch(e => { removePrediction(k, true, 'denied'); emit('send_error', { error: e.message }) })
      } catch (e) { removePrediction(k, true, 'denied'); emit('send_error', { error: e.message }); return }
      stats.placed++; st.blocks++
      if (!st.flight) st.flight = { hp: bot.health, fall: plan.fall, peak: st.peak, started: now(), cells: [] }
      st.flight.cells.push(record)
      st.flight.fall = plan.fall
      emit('placed', { cell: plan.cell, ref: plan.ref, face: plan.face, fall: plan.fall, expectedBlocks: plan.chain.length, landTick: plan.landTick })
      const previous = st.steering?.previous || controls()
      for (const [k, v] of (Object.entries(plan.control) as [string, any][])) bot.setControlState?.(k, v)
      st.steering = { yaw: plan.yaw, control: plan.control, previous }
    })
  }
  const ladderState = facing => require('prismarine-block')(bot.registry).fromProperties('ladder', { facing, waterlogged: false }).stateId
  function fireLadder (plan, snapshot) {
    if (st.stopped || scheduled !== plan) return
    cancelScheduled()
    const pos = bot.entity?.position
    if (!pos || pos.distanceTo(snapshot) > 1e-7) { stats.stale++; emit('stale'); return }
    const item = bot.inventory.slots.slice(36, 45).find(i => i?.name === 'ladder')
    const rb = world.getBlock(plan.ref); const cell = world.getBlock(plan.cell)
    const others = othersOf(bot.entities, bot.entity.id)
    const eye = snapshot.offset(0, eyeHeight(), 0)
    const point = faceAim(bot, plan.ref, plan.face, { eye, range: 4.5, avoid: others })
    if (!item || !replaceable(cell) || !fullReference(rb) || !point || snapshot.y < plan.cell.y + 1) return
    const stateId = ladderState(plan.facing)
    const k = key(plan.cell)
    const record = { cell: plan.cell, refKey: key(plan.ref), oldStateId: cell.stateId, stateId, sentAt: now(), slot: item.slot, reserved: false, ladder: true }
    hand.hold(200)
    hand.as(() => {
      const d = point.minus(eye)
      const yaw = Math.atan2(-d.x, -d.z); const pitch = Math.atan2(d.y, Math.hypot(d.x, d.z))
      bot.look(yaw, pitch, true)?.catch?.(() => {})
      bot._client.write('look', { yaw: 180 - yaw * 180 / Math.PI, pitch: -pitch * 180 / Math.PI,
        onGround: !!bot.entity.onGround, flags: { onGround: !!bot.entity.onGround, hasHorizontalCollision: !!bot.entity.isCollidedHorizontally } })
      if (bot.quickBarSlot !== item.slot - 36) bot.setQuickBarSlot(item.slot - 36)
      pending.set(k, record)
      try {
        const sent = bot._genericPlace(rb, plan.face, { delta: point.minus(plan.ref), forceLook: 'ignore', swingArm: 'right' })
        bot.world.setBlockStateId(plan.cell, stateId)
        Promise.resolve(sent).catch(e => { removePrediction(k, true, 'denied'); emit('send_error', { error: e.message }) })
      } catch (e) { removePrediction(k, true, 'denied'); emit('send_error', { error: e.message }); return }
      stats.ladders++; st.ladderPlaced = true
      if (!st.flight) st.flight = { hp: bot.health, fall: plan.fall, peak: st.peak, started: now(), cells: [] }
      st.flight.cells.push(record); st.flight.ladder = true
      emit('ladder_placed', { cell: plan.cell, ref: plan.ref, face: plan.face, facing: plan.facing, fall: plan.fall, landTick: plan.landTick })
    })
  }
  st.step = () => {
    if (st.stopped) return { action: 'none', why: 'stopped' }
    st.t++; st.expire(); cancelScheduled()
    const e = bot.entity
    if (!e?.position || !e.velocity) return { action: 'none', why: 'no_body' }
    if (e.onGround && !st.waterPlan) { releaseSteering(); st.waterAttempted = false }
    const s = new PlayerState(bot, controls())
    if (e.onGround) {
      if (st.flight) {
        const f = st.flight
        if (f.landed == null) { f.landed = now(); f.fall = Math.max(f.peak, st.peak ?? f.peak) - e.position.y; stats.landed++; emit('landed', { y: e.position.y, fall: f.fall, pending: pending.size }) }
        if (now() - f.landed >= 300) {
          const contact = f.cells.some(r => r.confirmed && world.getBlock(r.cell)?.stateId === r.stateId && Math.abs(e.position.y - r.cell.y - 1) < 1e-6 &&
            e.position.x + 0.3 > r.cell.x && e.position.x - 0.3 < r.cell.x + 1 && e.position.z + 0.3 > r.cell.z && e.position.z - 0.3 < r.cell.z + 1)
          if (bot.health >= f.hp - 0.01 && !pending.size && (contact || f.ladder) && !f.denied) { stats.saved++; emit('saved', { hp: bot.health, fall: f.fall, ladder: !!f.ladder }) }
          else emit('damaged_or_unconfirmed', { hp: bot.health, fall: f.fall, pending: pending.size })
          st.flight = null; st.blocks = 0; st.steering = null; st.ladderPlaced = false
        }
      } else { st.blocks = 0; st.ladderPlaced = false }
      st.peak = e.position.y; prepare()
    } else st.peak = Math.max(st.peak ?? bot._ndFallGuard?.peak ?? e.position.y, e.position.y)
    // Лестница, лоза, леса, паутина сбрасывают падение (LivingEntity.onClimbable →
    // resetFallDistance, makeStuckInBlock) — считать его заново от этой высоты.
    if (!e.onGround && climbing(e.position)) st.peak = e.position.y
    const ctx = context(s); const decision = decide(ctx); st.lastDecision = decision
    st.forecast = { from: s.pos.clone(), at: now(), landing: { lava: !!ctx.landing.lava, top: ctx.landing.top },
      guardAllow: !!ctx.guardAllow, intentional: !!ctx.intentional, ground: !!ctx.ground, vy: s.vel.y, excluded: decision.why === 'excluded' }
    const waterChoice = waterStep(s, ctx, decision)
    if (waterChoice) { st.lastDecision = waterChoice; return waterChoice }
    const L = ctx.landing || {}
    // Для журнала сторожа (edges.js «[clutch] молчит»): почему не клатч.
    st._dbg = { top: L.top, water: !!L.water, lava: !!L.lava, bad: !!L.bad, unknown: !!L.unknown, blocks: ctx.blocks, ground: ctx.ground, bucket: ctx.hasBucketBar, mode: ctx.mode, excl: ['dragon', 'wind', 'mace', 'swimming', 'lava', 'intentional', 'guardAllow', 'waterPlaced', 'elytra', 'riding', 'slowFalling', 'levitation', 'climbing'].filter(k => ctx[k]) }
    if (decision.action === 'water' || [ctx.dragon, ctx.wind, ctx.mace, ctx.swimming, ctx.lava, ctx.intentional, ctx.guardAllow, ctx.waterPlaced, ctx.dead].some(Boolean) || ctx.mode === 'creative' || ctx.mode === 'spectator') releaseSteering()
    if (s.isInWater || s.isInLava) { st.peak = null; st.flight = null; st.blocks = 0 }
    if ((decision.action === 'clutch' || decision.why === 'no_blocks') && !st.ladderPlaced && !preparing && process.env.ND_LADDER_CLUTCH !== '0') {
      const ladder = bot.inventory.slots.slice(36, 45).find(i => i?.name === 'ladder')
      const lp = ladder && api.ladderPlan({ state: s, world, peak: st.peak, entities: bot.entities, selfId: e.id, eyeHeight: eyeHeight(),
        ladderBlock: (cell, facing) => makeBlock(cell, ladderState(facing)), canReference: b => !blocked.has(key(b.position)) })
      if (lp) {
        scheduled = lp
        const snapshot = s.pos.clone()
        hand.hold(200)
        bot.look(lp.yaw, lp.pitch, true)?.catch?.(() => {})
        movement = () => fireLadder(lp, snapshot)
        bot.once('move', movement)
        if (opts.afterPacket) opts.afterPacket(bot, () => { if (scheduled === lp) fireLadder(lp, snapshot) })
        return { action: 'clutch', why: 'ladder' }
      }
    }
    if (decision.action !== 'clutch' || st.blocks >= (opts.maxBlocks ?? 3) || preparing || now() - barAt < 300) return decision
    // Спуск блоками (descent.ts): первые ~0.4 бл. падения не ставить — грань стены на глубине 3 ещё вне руки (4.5),
    // а самый верхний блок дал бы шаг в 1 блок.
    const deep = !st.blocks && (bot._ndClutchDeep || 0) > now()
    if (deep && (st.peak ?? e.position.y) - e.position.y < 0.4) return decision
    const count = bot.inventory.slots.slice(36, 45).filter(i => i && FILLER.test(i.name)).reduce((n, i) => n + i.count, 0) - (opts.reserve ?? 0) - [...spent.values()].reduce((n, v) => n + v, 0)
    const p = api.plan({ state: s, world, peak: st.peak, blockCount: count, maxBlocks: (opts.maxBlocks ?? 3) - st.blocks, entities: bot.entities, selfId: e.id, eyeHeight: eyeHeight(),
      canReference: b => !blocked.has(key(b.position)), steer: opts.steer, deep })
    if (!p || blocked.has(key(p.cell))) { stats.no_face++; emit('no_face'); return decision }
    scheduled = p
    const snapshot = s.pos.clone()
    hand.hold(200)
    bot.look(p.yaw, p.pitch, true)?.catch?.(() => {})
    movement = () => fire(p, snapshot, decision)
    bot.once('move', movement)
    // Optional existing edges.afterPacket fallback. move handles catch-up ticks
    // synchronously, before simulatePlayer of the next real tick can run.
    if (opts.afterPacket) opts.afterPacket(bot, () => { if (scheduled === p) fire(p, snapshot, decision) })
    return decision
  }
  const path = r => { st.path = r?.path || [] }
  const slotUpdate = (slot, old, item) => {
    if (!spent.has(slot)) return
    let consumed = !item || !old || old.name !== item.name ? Infinity : Math.max(0, old.count - item.count)
    // Reconcile each shot once. A later denial must not release a reservation
    // belonging to another placement when the inventory update arrived first.
    for (const r of reservations) if (r.slot === slot && r.reserved && consumed > 0) { releaseReservation(r); consumed-- }
    reservations = reservations.filter(r => r.reserved)
  }
  const reset = () => { cancelScheduled(); releaseSteering(); for (const k of [...pending.keys()]) removePrediction(k, true); spent.clear(); reservations = []; st.peak = null; st.flight = null; st.blocks = 0; st.path = []; st.waterPlan = null; st.waterAttempted = false; st.forecast = null }
  st.stop = () => {
    st.stopped = true; reset()
    bot.removeListener('physicsTick', st.step); bot.removeListener('path_update', path); bot.removeListener('path_reset', path)
    bot.removeListener('end', st.stop); bot.removeListener('spawn', reset); bot.removeListener('forcedMove', reset)
    bot._client.removeListener('block_change', single); bot._client.removeListener('multi_block_change', multi)
    bot.inventory.removeListener('updateSlot', slotUpdate)
    if (bot._ndClutch === st) delete bot._ndClutch
  }
  bot._client.on('block_change', single); bot._client.on('multi_block_change', multi)
  bot.inventory.on('updateSlot', slotUpdate)
  bot.on('path_update', path); bot.on('path_reset', path); bot.on('end', st.stop); bot.on('spawn', reset); bot.on('forcedMove', reset)
  if (opts.listen !== false) bot.on('physicsTick', st.step)
  bot._ndClutch = st
  return st
}
module.exports = { create, install, decide, intersects, selectBlock, FILLER, IDLE, copyState }
