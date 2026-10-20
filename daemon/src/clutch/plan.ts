'use strict'
// Блочный клатч (clutch.ts) — планировщик create(): клетки под траекторией с видимой гранью, прогноз посадки на
// цепочке до 3 блоков, лестница на стену, место посадки под телом. Зависимости — параметрами (Vec3, faceAim, simulate,
// makeBlock).
import { IDLE, key, replaceable, othersOf, occupied, fullReference, blockReference, intersects, copyState } from './blocks'

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

export { create }
