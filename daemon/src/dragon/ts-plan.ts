const { Vec3, isSolid, isAirish, nearPortal, playerBox, box, overlap, inflate, EYE, pick, gameClock, build, fillerItem, FILLER_RE, dbg, sleep, items, findItem } = require('./dig-down-to')
const { surfaceY, r1 } = require('./fall-guard')
const { DIRS4, addc, bedCellFree, landingHits, hurtNear, predParts, BED_TOP, DRAD, virtualBot, exposure, anClickPoint, tsClickPoint, SNEAK_EYE, fillPlaceable, blastReaches, bedDamage, dragonSeen, simClone, simHead, simNeck, simStep, turnLanding, mcos, msin, blockRes, wrapDeg, lookAtSafe } = require('./evade-raw')
const DAMAGE_TYPES = ['arrow', 'bad_respawn_point', 'cactus', 'campfire', 'cramming', 'dragon_breath', 'drown', 'dry_out',
  'ender_pearl', 'explosion', 'fall', 'falling_anvil', 'falling_block', 'falling_stalactite', 'fireball', 'fireworks',
  'fly_into_wall', 'freeze', 'generic', 'generic_kill', 'hot_floor', 'in_fire', 'in_wall', 'indirect_magic', 'lava',
  'lightning_bolt', 'mace_smash', 'magic', 'mob_attack', 'mob_attack_no_aggro', 'mob_projectile', 'on_fire',
  'out_of_world', 'outside_border', 'player_attack', 'player_explosion', 'sonic_boom', 'spear', 'spit', 'stalagmite',
  'starve', 'sting', 'sweet_berry_bush', 'thorns', 'thrown', 'trident', 'unattributed_fireball', 'wind_charge',
  'wither', 'wither_skull']

const r3 = v => Math.round(v * 1000) / 1000

function readVarIntAt (buf, off) {
  let v = 0; let s = 0; let b
  do { b = buf[off++]; v += (b & 0x7f) * 2 ** s; s += 7 } while (b & 0x80 && s < 35)
  return [v, off]
}

const yRotOf = yaw => wrapDeg(180 - yaw * 180 / Math.PI)

function lpVec3At (buf, off) {
  const a = buf[off]
  if (a === 0) return { x: 0, y: 0, z: 0 }
  const packed = buf.readUInt32BE(off + 2) * 65536 + buf[off + 1] * 256 + a
  let scale = a & 3
  if ((a & 4) === 4) { const [c] = readVarIntAt(buf, off + 6); scale += c * 4 }
  const un = sh => Math.min(Math.floor(packed / 2 ** sh) % 32768, 32766) * 2 / 32766 - 1
  return { x: un(3) * scale, y: un(18) * scale, z: un(33) * scale }
}

function pushedForecast (fc, i0, centre, seen, P) {
  const base = fc.path[i0]
  if (!base || !base.st) return null
  const s = simClone(base.st)
  const push = blastPush(s, centre, seen)
  s.vx += push.x; s.vy += push.y; s.vz += push.z
  const T = { x: 0.5, y: P, z: 0.5 }
  const path = fc.path.slice(0, i0 + 1)
  for (let k = i0 + 2; k <= i0 + 400; k++) {
    const dx = s.x - T.x; const dy = s.y - T.y; const dz = s.z - T.z
    if (dx * dx + dy * dy + dz * dz < 1) {
      const sit = simClone(s)
      return { t: fc.t, wallMs: fc.wallMs, n: k, fitErr: fc.fitErr, sit, head: simHead(sit, true), neck: simNeck(sit, true), path, yRotA: s.yRotA, pushed: push }
    }
    simStep(s, T, 1.5, turnLanding)
    path.push({ k, head: simHead(s, false), neck: simNeck(s, false), pos: new Vec3(s.x, s.y, s.z), yRot: s.yRot, st: simClone(s) })
  }
  return null
}

const NODE_ADJ = [6146, 8197, 8202, 16404, 32808, 32848, 65696, 131392, 131712, 263424, 526848, 525313, 1581057, 3166214, 2138120, 6373424, 4358208, 12910976, 9044480, 9706496, 15216640, 13688832, 11763712, 8257536]

let nodesCache = null

function dragonNodes (bot) {
  if (nodesCache && nodesCache.dim === bot.game.dimension && gameClock.now() - nodesCache.t < 600000) return nodesCache.nodes
  const h = (x, z) => { const s = surfaceY(bot, x + 0.5, z + 0.5, 200); return s ? s.y : null }
  const out = []
  for (let i = 0; i < 24; i++) {
    let k; let l; let j = 5
    // Угол — во float, как в Java (узлы 6/16/22: sin(−π) во float даёт z = 0, в double — −1; Codex, 01.10).
    const F = Math.fround
    const ang = (step, m) => F(F(2) * F(F(-3.1415927) + F(F(step) * F(m))))
    if (i < 12) { const a = ang(0.2617994, i); k = Math.floor(F(60 * mcos(a))); l = Math.floor(F(60 * msin(a))) } else if (i < 20) { const m = i - 12; const a = ang(0.3926991, m); k = Math.floor(F(40 * mcos(a))); l = Math.floor(F(40 * msin(a))); j += 10 } else { const m = i - 20; const a = ang(0.7853982, m); k = Math.floor(F(20 * mcos(a))); l = Math.floor(F(20 * msin(a))) }
    // Колонка не прогружена (кольцо 60 — за дальностью прорисовки): высота острова там ~60–64.
    let hy = h(k, l)
    if (hy == null) hy = i < 12 ? 0 : 62
    out.push({ i, x: k, y: Math.max(73, hy + j), z: l })
  }
  nodesCache = { nodes: out, t: gameClock.now(), dim: bot.game.dimension }
  return out
}

const nd2 = (a, b) => { const x = a.x - b.x; const y = a.y - b.y; const z = a.z - b.z; return Math.fround(x * x + y * y + z * z) }

const ndist = (a, b) => Math.fround(Math.sqrt(nd2(a, b)))

function closestNode (nodes, x, y, z, crystals = 10) {
  const p = { x: Math.floor(x), y: Math.floor(y), z: Math.floor(z) }
  let f = 10000; let best = 0
  for (let k = crystals === 0 ? 12 : 0; k < 24; k++) { const g = nd2(nodes[k], p); if (g < f) { f = g; best = k } }
  return best
}

function findNodePath (nodes, start, end, crystals = 10) {
  const N = nodes.map(n => ({ ...n, closed: false, f: 0, g: 0, h: 0, from: null, heap: -1 }))
  const heap = []
  const up = i => { const n = heap[i]; const f = n.f; while (i > 0) { const p = (i - 1) >> 1; const q = heap[p]; if (!(f < q.f)) break; heap[i] = q; q.heap = i; i = p } heap[i] = n; n.heap = i }
  const down = i => {
    const n = heap[i]; const f = n.f
    for (;;) {
      const a = 1 + (i << 1); const b = a + 1
      if (a >= heap.length) break
      const na = heap[a]; const fa = na.f
      let nb = null; let fb = Infinity
      if (b < heap.length) { nb = heap[b]; fb = nb.f }
      if (fa < fb) { if (!(fa < f)) break; heap[i] = na; na.heap = i; i = a } else { if (!(fb < f)) break; heap[i] = nb; nb.heap = i; i = b }
    }
    heap[i] = n; n.heap = i
  }
  const insert = n => { heap.push(n); n.heap = heap.length - 1; up(n.heap) }
  const pop = () => { const n = heap[0]; const last = heap.pop(); if (heap.length) { heap[0] = last; last.heap = 0; down(0) } n.heap = -1; return n }
  const change = (n, f) => { const o = n.f; n.f = f; if (f < o) up(n.heap); else down(n.heap) }
  const recon = e => { const out = [e]; while (e.from) { e = e.from; out.unshift(e) } return out.map(q => q.i) }
  const s = N[start]; const t = N[end]
  s.g = 0; s.h = ndist(s, t); s.f = s.h
  insert(s)
  let best = s
  const from = crystals === 0 ? 12 : 0
  while (heap.length) {
    const n = pop()
    if (n.i === t.i) return recon(t)
    if (ndist(n, t) < ndist(best, t)) best = n
    n.closed = true
    for (let k = from; k < 24; k++) {
      if (!((NODE_ADJ[n.i] & (1 << k)) > 0)) continue
      const m = N[k]
      if (m.closed) continue
      const g = Math.fround(n.g + ndist(n, m))
      if (m.heap >= 0 && !(g < m.g)) continue
      m.from = n; m.g = g; m.h = ndist(m, t)
      if (m.heap >= 0) change(m, Math.fround(m.g + m.h))
      else { m.f = Math.fround(m.g + m.h); insert(m) }
    }
  }
  return best === s ? null : recon(best)
}

function takeoffNode (nodes, s, crystals = 10, P = null) {
  const i = closestNode(nodes, s.x, s.y, s.z, crystals)
  // getHeadLookVector: у фонтана (тело ближе 4 к центру) наклон −45° — по XZ радиус 40·cos(45°)
  // ≈ 28.28, а не 40 (EnderDragon.getHeadLookVector, Codex 01.10).
  const dist = P != null ? Math.hypot(s.x - 0.5, s.y - P, s.z - 0.5) : 0
  const pitch = -45 / Math.max(dist / 4, 1) * DRAD
  const cp = Math.cos(pitch)
  const hx = msin(s.yRot * DRAD) * cp; const hz = -mcos(s.yRot * DRAD) * cp
  let j = closestNode(nodes, hx * 40, 105, hz * 40, crystals)
  if (crystals > 0) { j %= 12; if (j < 0) j += 12 } else { j -= 12; j &= 7; j += 12 }
  const path = findNodePath(nodes, i, j, crystals)
  if (!path || path.length < 2) return null
  return nodes[path[1]]
}

function blastPush (s, centre, seen = 1) {
  const d = Math.hypot(s.x - centre.x, s.y - centre.y, s.z - centre.z) / 10
  if (d > 1) return { x: 0, y: 0, z: 0 }
  const ex = s.x - centre.x; const ey = s.y + 6.8 - centre.y; const ez = s.z - centre.z
  const l = Math.hypot(ex, ey, ez) || 1
  const m = (1 - d) * seen
  return { x: ex / l * m, y: ey / l * m, z: ez / l * m }
}

function takeoffForecast (sit, node, ticks = 30) {
  const s = simClone(sit)
  const T = { x: node.x, y: node.y + 10, z: node.z }
  const turn = st => { const f = Math.hypot(st.vx, st.vz) + 1; return 0.7 / Math.min(f, 40) / f }
  const path = []
  for (let k = 0; k < ticks; k++) {
    simStep(s, T, 0.6, turn)
    path.push({ k, head: simHead(s, false), neck: simNeck(s, false), pos: new Vec3(s.x, s.y, s.z), yRot: s.yRot })
  }
  return path
}

const FACE_IDX = (f) => f.y < 0 ? 0 : f.y > 0 ? 1 : f.z < 0 ? 2 : f.z > 0 ? 3 : f.x < 0 ? 4 : 5

function tsPlan (bot, target, { lift = 1, fc = null, skip = null, dpos = null, fixedB = null, avoid = null, extra = null, lid = false, radius = 2.6, anchor = false, portalOk = false }: any = {}) {
  const all = []
  const at = (x, y, z) => bot.blockAt(new Vec3(x, y, z))
  const solidOk = b => isSolid(b) && !/_bed$|portal|gateway|bedrock/.test(b.name)
  const why = {}
  const no = k => { why[k] = (why[k] || 0) + 1 }
  // Верх земли в колонке c около G (G + 1 … G − 2): y первого воздуха над твёрдым.
  const gTop = (c, G) => { for (let y = G + 1; y >= G - 2; y--) { if (solidOk(at(c.x, y - 1, c.z)) && !isSolid(at(c.x, y, c.z))) return y } return null }
  let best = null
  const H0 = { x: Math.floor(target.x), z: Math.floor(target.z) }
  // ±2 клетки от головы (fin1: «нет станции у головы» ×9 при ±1): дальше — меньше урона,
  // но лучше, чем ничего; стоимость выбирает ближнюю, если есть.
  const R = Math.ceil(radius)
  for (let ox = -R; ox <= R; ox++) {
    for (let oz = -R; oz <= R; oz++) {
      const H = { x: H0.x + ox, z: H0.z + oz }
      if (Math.hypot(H.x + 0.5 - target.x, H.z + 0.5 - target.z) > radius) continue
      const sH = surfaceY(bot, H.x, H.z, Math.floor(target.y) + 2)
      if (!sH) { no('нет земли у головы'); continue }
      for (const u of DIRS4) {
        for (const a of DIRS4) {
          if (a.x * u.x + a.z * u.z !== 0) continue
          const F = addc(H, a, -1); const B = addc(F, u, -2); const V = addc(F, u, -1); const W = addc(H, u, -1); const PS = addc(F, a, -2)
          const key = `${H.x},${H.z},${u.x},${u.z},${a.x},${a.z}`
          if (skip && skip.has(key)) continue
          if (fixedB && (B.x !== fixedB.x || B.z !== fixedB.z)) continue
          if (avoid && [F, W, V, PS, H].some(c => avoid.has(`${c.x},${c.z}`))) { no('клетки второй станции'); continue }
          // G — земля у окопа (ноги стоящего у B); кровать на G + lift
          const G = gTop(B, sH.y)
          if (G == null) { no('у окопа нет земли'); continue }
          const yb = G + lift
          // Якорь (dragon_immune: коробка головы его не сносит) — можно прямо на пути головы.
          if (!anchor && target.y - yb < 0.6) { no('голова низко'); continue }
          const gF = gTop(F, G); const gV = gTop(V, G); const gW = gTop(W, G)
          if (!anchor && (gF == null || gF > G || gF < G - 1)) { no('под изножьем'); continue }
          if (gV == null || gV > G) { no('просвет: земля выше'); continue }
          if (gW == null || gW > G) { no('заслон: земля выше'); continue }
          if (!bedCellFree(at(H.x, yb, H.z)) || !bedCellFree(at(F.x, yb, F.z))) { no('клетки кровати'); continue }
          if ([...Array(lift + 1).keys()].some(k => !isAirish(at(V.x, G + k, V.z)))) { no('просвет закрыт'); continue }
          const wCells = []; for (let y = gW; y <= G + lift; y++) { const w = at(W.x, y, W.z); if (!(isAirish(w) || solidOk(w))) { wCells.length = 0; wCells.push(null); break } wCells.push(y) }
          if (wCells[0] === null) { no('клетка заслона'); continue }
          const sCells = []; if (!anchor) for (let y = gF; y < yb; y++) sCells.push(y)
          if (sCells.some(y => !(isAirish(at(F.x, y, F.z)) || solidOk(at(F.x, y, F.z))))) { no('клетка опоры'); continue }
          if (!portalOk && [F, W, V, B, PS, H].some(c => nearPortal(new Vec3(c.x + 0.5, G, c.z + 0.5)))) { no('чаша портала'); continue }
          const gPS = gTop(PS, G)
          if (gPS == null || Math.abs(gPS - G) > 1 || !isAirish(at(PS.x, gPS + 1, PS.z))) { no('место ставки'); continue }
          if (!isAirish(at(B.x, G, B.z)) || !isAirish(at(B.x, G + 1, B.z))) { no('над окопом блок'); continue }
          // lid (первая посадка — ослепить): окоп в 2, крышка над головой (B, G) к упору K — сосед
          let K = null
          if (lid) {
            for (const kd of [{ x: -u.x, z: -u.z }, a, { x: -a.x, z: -a.z }]) {
              const c = addc(B, kd)
              if (solidOk(at(c.x, G - 1, c.z)) && (isAirish(at(c.x, G, c.z)) || solidOk(at(c.x, G, c.z)))) { K = c; K.d = kd; break }
            }
            if (!K) { no('нет упора крышки'); continue }
          }
          for (const depth of (lid ? [2] : [1, 2])) {
            // окоп: копаем G − 1 … G − depth, пол — твёрдый
            const digs = []; let okDig = true
            for (let k = 1; k <= depth; k++) { const b = at(B.x, G - k, B.z); if (!b || !/end_stone|cobble|stone|dirt|netherrack|andesite|diorite|granite|tuff/.test(b.name)) okDig = false; digs.push(G - k) }
            if (!okDig || !solidOk(at(B.x, G - depth - 1, B.z))) { no('окоп не выкопать'); continue }
            const trench = new Vec3(B.x + 0.5, G - depth, B.z + 0.5)
            if (fc && landingHits(fc, trench, 0.15)) { no('окоп под драконом'); continue }
            // Вылезти из окопа после посадки — не в коробки головы/шеи сидящего (oc7-6:
            // удар шеей на выходе из окопа к кровати A).
            if (fc && hurtNear(playerBox(new Vec3(B.x + 0.5, G, B.z + 0.5)), predParts(fc))) { no('окоп у шеи сидящего'); continue }
            // Кровать не в коробках головы/шеи/тела снижающегося до мига щелчка (checkWalls
            // снесёт её без взрыва: oc3-22 — кровать на два блока пропала).
            if (fc) {
              // Кровать — или (у якоря) клетки заслона: не в коробках до мига щелчка.
              const boxes = anchor ? wCells.map(y => ({ min: new Vec3(W.x, y, W.z), max: new Vec3(W.x + 1, y + 1, W.z + 1) })) : [{ min: new Vec3(Math.min(F.x, H.x), yb, Math.min(F.z, H.z)), max: new Vec3(Math.max(F.x, H.x) + 1, yb + BED_TOP, Math.max(F.z, H.z) + 1) }]
              const upto = Math.max(1, fc.n - 3)
              let hitBed = false
              for (const st of fc.path) {
                if (st.k > upto) break
                const hb = box(st.head.x, st.head.y, st.head.z, 0.5, 1); const nb = box(st.neck.x, st.neck.y, st.neck.z, 1.5, 3)
                const by = box(st.pos.x + Math.sin(st.yRot * DRAD) * 0.5, st.pos.y, st.pos.z - Math.cos(st.yRot * DRAD) * 0.5, 2.5, 3)
                if (boxes.some(bb => overlap(bb, inflate(hb, 0.15)) || overlap(bb, inflate(nb, 0.15)) || overlap(bb, inflate(by, 0.15)))) { hitBed = true; break }
              }
              if (hitBed) { no(anchor ? 'заслон якоря на пути головы' : 'кровать на пути головы'); continue }
            }
            // мир «как будет»: опора F, заслон W, окоп (и вторая станция, если есть)
            const ex = new Map(extra || [])
            for (const y of sCells) ex.set(`${F.x},${y},${F.z}`, 'block')
            for (const y of wCells) ex.set(`${W.x},${y},${W.z}`, 'block')
            for (const y of digs) ex.set(`${B.x},${y},${B.z}`, 'air')
            if (lid && !solidOk(at(K.x, G, K.z))) ex.set(`${K.x},${G},${K.z}`, 'block')
            const vb = virtualBot(bot, ex)
            const centre = new Vec3(H.x + 0.5, yb + 0.5, H.z + 0.5)
            const expo = exposure(vb, trench, centre)
            if (expo > 0.02) { no('взрыв видит окоп'); continue }
            const ex2 = new Map(ex)
            if (anchor) ex2.set(`${H.x},${yb},${H.z}`, 'block'); else { ex2.set(`${F.x},${yb},${F.z}`, 'bed'); ex2.set(`${H.x},${yb},${H.z}`, 'bed') }
            const cp = anchor ? anClickPoint(virtualBot(bot, ex2), trench.offset(0, EYE, 0), { H, yb }) : tsClickPoint(virtualBot(bot, ex2), trench.offset(0, EYE, 0), { F, u, yb })
            if (!cp) { no(anchor ? 'якорь из окопа не видно' : 'бок кровати не видно'); continue }
            // Кровать на два блока: верх опоры (G + 2) выше глаз стоящего на земле — ставим с блока
            // у PS (psLift): встать на свой блок, как столбом. Якорь ставим к боку заслона — не нужно.
            const psLift = !anchor && yb - gPS >= 2 ? 1 : 0
            if (psLift && (!isAirish(at(PS.x, gPS + 2, PS.z)) || !isAirish(at(PS.x, gPS + 1, PS.z)))) { no('над местом ставки блок'); continue }
            const ground = new Vec3(PS.x + 0.5, gPS + psLift, PS.z + 0.5)
            if (psLift) { ex.set(`${PS.x},${gPS},${PS.z}`, 'block') }
            if (anchor) {
              // якорь — к грани +u верхнего блока заслона (W + u = H), с места ставки, крадучись
              if (!pick.faceAim(virtualBot(bot, ex), new Vec3(W.x, yb, W.z), new Vec3(u.x, 0, u.z), { eye: ground.offset(0, SNEAK_EYE, 0), avoid: [] })) { no('грань заслона для якоря не видно'); continue }
            } else if (!pick.faceAim(virtualBot(bot, ex), new Vec3(F.x, yb - 1, F.z), new Vec3(0, 1, 0), { eye: ground.offset(0, EYE, 0), avoid: [] })) { no('верх опоры не видно с места ставки'); continue }
            // Честная ставка каждого блока по порядку стройки (опора, заслон — с PS или с B
            // до окопа): грань соседа видна из глаз (крадучись) на «мире как будет».
            {
              // Уже стоящие блоки других станций (extra) — в «мире стройки» с самого начала.
              const exB = new Map(extra || []); let bad = null
              const eyePS = ground.offset(0, SNEAK_EYE, 0); const eyeB = new Vec3(B.x + 0.5, G + SNEAK_EYE, B.z + 0.5)
              for (const y of sCells) { const c = new Vec3(F.x, y, F.z); if (!fillPlaceable(exB.size ? virtualBot(bot, exB) : bot, c, eyePS, { robust: true })) { bad = 'опору не поставить честно'; break } exB.set(`${F.x},${y},${F.z}`, 'block') }
              if (!bad) for (const y of wCells) { const c = new Vec3(W.x, y, W.z); const vv = virtualBot(bot, exB); if (!fillPlaceable(vv, c, eyePS, { robust: true }) && (psLift || !fillPlaceable(vv, c, eyeB, { robust: true }))) { bad = 'заслон не поставить честно'; break } exB.set(`${W.x},${y},${W.z}`, 'block') }
              if (!bad && lid && !solidOk(at(K.x, G, K.z))) { const vv = virtualBot(bot, exB); if (!fillPlaceable(vv, new Vec3(K.x, G, K.z), eyePS) && !fillPlaceable(vv, new Vec3(K.x, G, K.z), eyeB)) bad = 'упор крышки не поставить честно' }
              if (!bad && lid && !pick.faceAim(vb, new Vec3(K.x, G, K.z), new Vec3(-K.d.x, 0, -K.d.z), { eye: trench.offset(0, EYE, 0), avoid: [] })) bad = 'крышку из окопа не поставить'
              if (!bad && lid && blastReaches(vb, bot, centre, [{ x: K.x, y: G, z: K.z }])) bad = 'упор крышки снесёт взрыв L'
              if (bad) { no(bad); continue }
            }
            const dist = centre.distanceTo(target)
            // видимость дракона — позже, для лучших (дорого)
            const seen = 1
            const expect = bedDamage(dist, seen)
            const me = bot.entity.position
            const walk = Math.hypot(PS.x + 0.5 - me.x, PS.z + 0.5 - me.z)
            // Место ставки и клетка окопа под крылом/головой на последних ~2.5 с снижения — стройка
            // там обрывается («дракон рядом: крыло через N тиков», 16 из 29 обрывов fin3–fin5).
            let wingPen = 0
            if (fc && fc.path && fc.path.length) {
              const tail = { ...fc, path: fc.path.filter(st => st.k >= fc.n - 50) }
              if (landingHits(tail, ground, 0.3) || landingHits(tail, new Vec3(B.x + 0.5, G, B.z + 0.5), 0.3)) wingPen = 25
            }
            const cost = -expect + walk * 0.8 + (sCells.length + wCells.length) * 1.5 + depth * 2 + wingPen
            const cand = { key, H, F, W, V, B, PS, u, a, G, yb, lift, depth, sCells, wCells, digs, trench, ground, centre, dist: r1(dist), expect, seen: Math.round(seen * 100) / 100, cost: cost + psLift * 3, y: yb, D: a, expo, world: ex, psLift, gPS, K: lid ? K : null, anchor: anchor || undefined }
            all.push(cand)
            if (!best || cost < best.cost) best = cand
            break
          }
        }
      }
    }
  }
  // Видимость дракона из центра взрыва (свои блоки режут урон) — для лучших 5 по стоимости.
  if (dpos && all.length) {
    all.sort((p, q) => p.cost - q.cost)
    best = null
    for (const c of all.slice(0, 5)) {
      const seen = dragonSeen(virtualBot(bot, c.world), c.centre, dpos)
      c.seen = Math.round(seen * 100) / 100
      const e2 = bedDamage(c.centre.distanceTo(target), seen)
      c.cost += c.expect - e2
      c.expect = e2
      if (!best || c.cost < best.cost) best = c
    }
  }
  tsPlan.why = why
  tsPlan.all = all
  return best
}
declare namespace tsPlan {
  let why: any
  let all: any[]
}

function tsSecond (bot, plan, fc, { dpos = null, sides = null, imin = null, imax = null, primaryFirst = false }: any = {}) {
  const at = (x, y, z) => bot.blockAt(new Vec3(x, y, z))
  const solidOk = b => isSolid(b) && !/_bed$|portal|gateway|bedrock/.test(b.name)
  const gTop = (c, G) => { for (let y = G + 1; y >= G - 2; y--) { if (solidOk(at(c.x, y - 1, c.z)) && !isSolid(at(c.x, y, c.z))) return y } return null }
  const why = {}
  const no = k => { why[k] = (why[k] || 0) + 1 }
  const { B, u, G } = plan
  let best = null
  const pend = []
  // Стороны окопа: для L0 — напротив станции L (−u); для C (взлёт) — любая, кроме +u.
  const sideList = sides || [{ x: -u.x, z: -u.z }]
  for (const nu of sideList) {
  for (const d0 of [2, 3]) {
    const F0 = addc(B, nu, d0); const V0 = addc(B, nu, 1)
    const gF = gTop(F0, G)
    if (gF == null || gF > G || gF < G - 1) { no('под изножьем L0'); continue }
    const gV = gTop(V0, G)
    if (gV == null || gV > G) { no('просвет L0'); continue }
    for (const a0 of DIRS4) {
      if (a0.x * nu.x + a0.z * nu.z !== 0) continue
      const H0 = addc(F0, a0); const W0 = addc(H0, nu, -1); const PS0 = addc(F0, a0, -2)
      const gW = gTop(W0, G)
      if (gW == null || gW > G) { no('заслон L0: земля'); continue }
      const gPS = gTop(PS0, G)
      if (gPS == null || Math.abs(gPS - G) > 1 || !isAirish(at(PS0.x, gPS + 1, PS0.z))) { no('место ставки L0'); continue }
      if ([F0, W0, V0, PS0, H0].some(c => nearPortal(new Vec3(c.x + 0.5, G, c.z + 0.5)))) { no('чаша портала'); continue }
      for (const lift0 of [2, 1]) {
        const yb0 = G + lift0
        if (d0 === 3 && [0, 1, 2].slice(0, lift0 + 1).some(k => !isAirish(at(B.x + nu.x * 2, G + k, B.z + nu.z * 2)))) { no('вид L0 закрыт'); continue }
        if ([...Array(lift0 + 1).keys()].some(k => !isAirish(at(V0.x, G + k, V0.z)))) { no('просвет L0 закрыт'); continue }
        if (!bedCellFree(at(H0.x, yb0, H0.z)) || !bedCellFree(at(F0.x, yb0, F0.z))) { no('клетки кровати L0'); continue }
        // мишень: тик i0 ≤ n − 13, голова над H0 (гориз. ≤ 1.6), низ головы выше центра взрыва на 0.2…1.8
        const cen0 = new Vec3(H0.x + 0.5, yb0 + 0.5, H0.z + 0.5)
        let tgt = null
        const iHi = imax != null ? imax : fc.n - 13; const iLo = imin != null ? imin : Math.max(0, fc.n - 26)
        for (let i0 = iHi; i0 >= iLo; i0--) {
          const st = fc.path[i0]; if (!st) continue
          const hh = Math.hypot(st.head.x - cen0.x, st.head.z - cen0.z); const dy = st.head.y - cen0.y
          if (hh > 1.6 || dy < 0.2 || dy > 1.8) continue
          const dist = st.head.distanceTo(cen0)
          if (!tgt || dist < tgt.dist) tgt = { i0, dist, head: st.head }
        }
        if (!tgt) { no('голова L0 не над станцией'); continue }
        // кровать L0 не в коробках снижающегося до её тика
        const bb = { min: new Vec3(Math.min(F0.x, H0.x), yb0, Math.min(F0.z, H0.z)), max: new Vec3(Math.max(F0.x, H0.x) + 1, yb0 + BED_TOP, Math.max(F0.z, H0.z) + 1) }
        let hitBed = false
        for (const st of fc.path) {
          if (st.k > tgt.i0 + 1) break
          if (overlap(bb, inflate(box(st.head.x, st.head.y, st.head.z, 0.5, 1), 0.15)) || overlap(bb, inflate(box(st.neck.x, st.neck.y, st.neck.z, 1.5, 3), 0.15))) { hitBed = true; break }
        }
        if (hitBed) { no('кровать L0 на пути головы'); continue }
        // мир «как будет»: обе станции + окоп
        const sCells = []; for (let y = gF; y < yb0; y++) sCells.push(y)
        const wCells = []; for (let y = gW; y <= G + lift0; y++) wCells.push(y)
        if ([...sCells.map(y => at(F0.x, y, F0.z)), ...wCells.map(y => at(W0.x, y, W0.z))].some(b => !(isAirish(b) || solidOk(b)))) { no('клетки опоры/заслона L0'); continue }
        const ex = new Map(plan.world)
        for (const y of sCells) ex.set(`${F0.x},${y},${F0.z}`, 'block')
        for (const y of wCells) ex.set(`${W0.x},${y},${W0.z}`, 'block')
        const vb = virtualBot(bot, ex)
        const expo = exposure(vb, plan.trench, cen0)
        if (expo > 0.02) { no('взрыв L0 видит окоп'); continue }
        // взрыв L L ещё не был; мир на миг L0: кровать L стоит, кровать L0 уже убрана
        const exL = new Map(ex); exL.set(`${plan.F.x},${plan.yb},${plan.F.z}`, 'bed'); exL.set(`${plan.H.x},${plan.yb},${plan.H.z}`, 'bed')
        const vbL = virtualBot(bot, exL)
        // и взрыв L не видит окоп в мире со станцией L0
        if (exposure(vb, plan.trench, plan.centre) > 0.02) { no('взрыв L видит окоп при L0'); continue }
        const ex2 = new Map(exL); ex2.set(`${F0.x},${yb0},${F0.z}`, 'bed'); ex2.set(`${H0.x},${yb0},${H0.z}`, 'bed')
        const cp = tsClickPoint(virtualBot(bot, ex2), plan.trench.offset(0, EYE, 0), { F: F0, u: nu, yb: yb0 })
        if (!cp) { no('бок L0 не видно'); continue }
        const ground0 = new Vec3(PS0.x + 0.5, gPS, PS0.z + 0.5)
        if (!pick.faceAim(vb, new Vec3(F0.x, yb0 - 1, F0.z), new Vec3(0, 1, 0), { eye: ground0.offset(0, EYE, 0), avoid: [] })) { no('верх опоры L0 не видно'); continue }
        {
          const exB = new Map(plan.world); let bad = null
          const eyePS = ground0.offset(0, SNEAK_EYE, 0); const eyeB = new Vec3(B.x + 0.5, G + SNEAK_EYE, B.z + 0.5)
          for (const y of sCells) { const c = new Vec3(F0.x, y, F0.z); if (!fillPlaceable(virtualBot(bot, exB), c, eyePS)) { bad = 'опору L0 не поставить честно'; break } exB.set(`${F0.x},${y},${F0.z}`, 'block') }
          if (!bad) for (const y of wCells) { const c = new Vec3(W0.x, y, W0.z); const vv = virtualBot(bot, exB); if (!fillPlaceable(vv, c, eyePS) && !fillPlaceable(vv, c, eyeB)) { bad = 'заслон L0 не поставить честно'; break } exB.set(`${W0.x},${y},${W0.z}`, 'block') }
          if (bad) { no(bad); continue }
        }
        // Дорогие проверки (лучи взрыва по блокам, видимость дракона) — потом, по порядку
        // ожидания (oc8-19: перебор с лучами на каждую — 7 с без тиков, прогноз устарел).
        const expect1 = bedDamage(tgt.dist, 1)
        pend.push({ F: F0, H: H0, W: W0, V: V0, PS: PS0, u: nu, a: a0, G, yb: yb0, y: yb0, lift: lift0, sCells, wCells, ground: ground0, centre: cen0, dist: r1(tgt.dist), i0: tgt.i0, D: a0, vb, vbL, ex2, cost1: -expect1 + (sCells.length + wCells.length) * 1.5 })
      }
    }
  }
  }
  pend.sort((p, q) => p.cost1 - q.cost1)
  for (const c of pend.slice(0, 4)) {
    // Кровать, взрывающаяся второй, переживает первый взрыв (лучи ServerExplosion).
    if (!primaryFirst && blastReaches(c.vbL, bot, c.centre, [{ x: plan.F.x, y: plan.yb, z: plan.F.z }, { x: plan.H.x, y: plan.yb, z: plan.H.z }])) { no('взрыв L0 снесёт кровать L'); continue }
    if (primaryFirst && blastReaches(virtualBot(bot, c.ex2), bot, plan.centre, [{ x: c.F.x, y: c.yb, z: c.F.z }, { x: c.H.x, y: c.yb, z: c.H.z }])) { no('первый взрыв снесёт вторую кровать'); continue }
    const seen = dpos ? dragonSeen(c.vb, c.centre, dpos) : 1
    const expect = bedDamage(c.dist, seen)
    const cost = -expect + (c.sCells.length + c.wCells.length) * 1.5
    if (!best || cost < best.cost) { const { vb, vbL, ex2, cost1, ...rest } = c; best = { ...rest, expect, seen: r1(seen), cost } }
    if (best && best.expect >= 40) break
  }
  tsSecond.why = why
  return best
}
declare namespace tsSecond {
  let why: any
}

function blastDestroyed (vbot, bot, centre, power = 5) {
  const out = new Set()
  for (let i = 0; i < 16; i++) {
    for (let j = 0; j < 16; j++) {
      for (let k = 0; k < 16; k++) {
        if (!(i === 0 || i === 15 || j === 0 || j === 15 || k === 0 || k === 15)) continue
        let dx = i / 15 * 2 - 1; let dy = j / 15 * 2 - 1; let dz = k / 15 * 2 - 1
        const l = Math.sqrt(dx * dx + dy * dy + dz * dz); dx /= l; dy /= l; dz /= l
        let h = power * 1.3
        let x = centre.x; let y = centre.y; let z = centre.z
        while (h > 0) {
          const bx = Math.floor(x); const by = Math.floor(y); const bz = Math.floor(z)
          const b = vbot.blockAt(new Vec3(bx, by, bz))
          if (b && b.boundingBox !== 'empty') {
            h -= (blockRes(bot, b) + 0.3) * 0.3
            if (h > 0 && !/bedrock|obsidian|end_portal|gateway|barrier|respawn_anchor/.test(b.name)) out.add(`${bx},${by},${bz}`)
          }
          x += dx * 0.3; y += dy * 0.3; z += dz * 0.3
          h -= 0.225
        }
      }
    }
  }
  return out
}

function stationCells (st) {
  return [{ x: st.F.x, y: st.yb, z: st.F.z }, { x: st.H.x, y: st.yb, z: st.H.z }, ...(st.sCells || []).map(y => ({ x: st.F.x, y, z: st.F.z })), ...(st.wCells || []).map(y => ({ x: st.W.x, y, z: st.W.z }))]
}

function stationWorld (st, base = null, { bed = true }: any = {}) {
  const ex = new Map(base || [])
  for (const y of st.sCells || []) ex.set(`${st.F.x},${y},${st.F.z}`, 'block')
  for (const y of st.wCells || []) ex.set(`${st.W.x},${y},${st.W.z}`, 'block')
  if (bed) { ex.set(`${st.F.x},${st.yb},${st.F.z}`, 'bed'); ex.set(`${st.H.x},${st.yb},${st.H.z}`, 'bed') }
  return ex
}

function tsOwnStation (bot, target, { fc = null, dpos = null, world = new Map(), priors = [], protect = [], avoid = [], cap = null, minExpect = 30, sitP = null, lifts = [1, 0, 2], radius = 3.2 }: any = {}) {
  const why = {}
  const no = k => { why[k] = (why[k] || 0) + 1 }
  tsOwnStation.why = why
  const av = new Set()
  for (const st of avoid) for (const q of [st.F, st.W, st.V, st.PS, st.H, st.B]) av.add(`${q.x},${q.z}`)
  const cands = []
  for (const lift of lifts) {
    tsPlan(bot, target, { lift, fc, dpos, avoid: av, extra: world, radius })
    for (const [k, v] of (Object.entries(tsPlan.why || {}) as [string, any][])) why[k] = (why[k] || 0) + v
    cands.push(...(tsPlan.all || []))
  }
  if (!cands.length) { no('нет станции'); return null }
  let best = null
  for (const c of cands.filter(q => !q.psLift && !av.has(`${q.B.x},${q.B.z}`)).sort((p, q) => q.expect - p.expect).slice(0, 14)) {
    if (sitP) {
      const bb = { min: new Vec3(Math.min(c.F.x, c.H.x), c.yb, Math.min(c.F.z, c.H.z)), max: new Vec3(Math.max(c.F.x, c.H.x) + 1, c.yb + 1, Math.max(c.F.z, c.H.z) + 1) }
      if (overlap(bb, inflate(sitP.head, 0.05)) || overlap(bb, inflate(sitP.neck, 0.05)) || overlap(bb, inflate(sitP.body, 0.05))) { no('кровать в сидячих коробках'); continue }
    }
    const cells = stationCells(c)
    const mine = stationWorld(c, world)
    if (protect.length && blastReaches(virtualBot(bot, mine), bot, c.centre, protect)) { no('снесёт следующую'); continue }
    let post = new Map(mine); let bad = null
    const ground = [{ x: c.B.x, y: c.G - 1, z: c.B.z }, { x: c.B.x, y: c.G - 1 - c.depth, z: c.B.z }, { x: c.V.x, y: c.G - 1, z: c.V.z }]
    for (const pr of priors) {
      const vb = virtualBot(bot, post)
      if (blastReaches(vb, bot, pr.centre, cells)) { bad = 'прежний взрыв снесёт'; break }
      const des = blastDestroyed(vb, bot, pr.centre)
      if (ground.some(q => des.has(`${q.x},${q.y},${q.z}`))) { bad = 'окоп в воронке'; break }
      post = new Map(post)
      for (const k of des) post.set(k, 'air')
      post.set(`${pr.F.x},${pr.yb},${pr.F.z}`, 'air'); post.set(`${pr.H.x},${pr.yb},${pr.H.z}`, 'air')
    }
    if (bad) { no(bad); continue }
    for (let k = 1; k <= c.depth; k++) post.set(`${c.B.x},${c.G - k},${c.B.z}`, 'air')
    const vPost = virtualBot(bot, post)
    if (exposure(vPost, c.trench, c.centre) > 0.02) { no('после прежних окоп открыт'); continue }
    if (!tsClickPoint(vPost, c.trench.offset(0, EYE, 0), c)) { no('после прежних бок не видно'); continue }
    const noBed = new Map(post); noBed.set(`${c.F.x},${c.yb},${c.F.z}`, 'air'); noBed.set(`${c.H.x},${c.yb},${c.H.z}`, 'air')
    const seen = dpos ? dragonSeen(virtualBot(bot, noBed), c.centre, dpos) : (c.seen || 1)
    const expect = bedDamage(c.centre.distanceTo(target), seen)
    if (cap != null && expect > cap) { no('больше потолка'); continue }
    if (expect < minExpect) { no('мала'); continue }
    const score = expect - (c.sCells.length + c.wCells.length) * 1.5 - c.depth * 3
    const psSafe = !(sitP && hurtNear(playerBox(c.ground), sitP))
    if (!best || score > best.score) best = { ...c, expect, seen: Math.round(seen * 100) / 100, score, own: true, world: mine, psSafe }
  }
  return best
}
declare namespace tsOwnStation {
  let why: any
}

function tsOwnPlan (bot, plan, fcL, { cap = null, dpos = null }: any = {}) {
  const why = {}
  const no = k => { why[k] = (why[k] || 0) + 1 }
  tsOwnPlan.why = why
  tsOwnPlan.small = []
  const target = fcL.head
  const exL = stationWorld(plan, plan.world)
  const avoid = new Set([plan.F, plan.W, plan.V, plan.PS, plan.H, plan.B].map(q => `${q.x},${q.z}`))
  const fcA = { ...fcL, n: fcL.n + 3 }
  const sitP = predParts(fcL)
  const cands = []
  for (const lift of [1, 0, 2]) {
    tsPlan(bot, target, { lift, fc: fcA, dpos, avoid, extra: exL, radius: 3.2 })
    for (const [k, v] of (Object.entries(tsPlan.why || {}) as [string, any][])) why[k] = (why[k] || 0) + v
    cands.push(...(tsPlan.all || []))
  }
  if (!cands.length) { no('нет своей станции у головы'); return null }
  const vbL = virtualBot(bot, exL)
  const destroyed = blastDestroyed(vbL, bot, plan.centre)
  let best = null
  for (const c of cands.filter(q => !q.psLift && !avoid.has(`${q.B.x},${q.B.z}`)).sort((p, q) => q.expect - p.expect).slice(0, 14)) {
    const bb = { min: new Vec3(Math.min(c.F.x, c.H.x), c.yb, Math.min(c.F.z, c.H.z)), max: new Vec3(Math.max(c.F.x, c.H.x) + 1, c.yb + 1, Math.max(c.F.z, c.H.z) + 1) }
    if (overlap(bb, inflate(sitP.head, 0.05)) || overlap(bb, inflate(sitP.neck, 0.05)) || overlap(bb, inflate(sitP.body, 0.05))) { no('кровать A в коробках сидящего'); continue }
    // L не должна видеть окоп A? нет: в окопе A нас при L нет. Клетки A — целы после L.
    const cells = [{ x: c.F.x, y: c.yb, z: c.F.z }, { x: c.H.x, y: c.yb, z: c.H.z }, ...c.sCells.map(y => ({ x: c.F.x, y, z: c.F.z })), ...c.wCells.map(y => ({ x: c.W.x, y, z: c.W.z }))]
    const exBoth = stationWorld(c, exL)
    if (blastReaches(virtualBot(bot, exBoth), bot, plan.centre, cells)) { no('взрыв L снесёт A'); continue }
    // земля окопа A и просвета — не в воронке L
    const ground = [{ x: c.B.x, y: c.G - 1, z: c.B.z }, { x: c.B.x, y: c.G - 1 - c.depth, z: c.B.z }, { x: c.V.x, y: c.G - 1, z: c.V.z }]
    if (ground.some(q => destroyed.has(`${q.x},${q.y},${q.z}`))) { no('окоп A в воронке L'); continue }
    const post = new Map(exBoth)
    for (const k of destroyed) post.set(k, 'air')
    post.set(`${plan.F.x},${plan.yb},${plan.F.z}`, 'air'); post.set(`${plan.H.x},${plan.yb},${plan.H.z}`, 'air')
    for (const q of cells) post.set(`${q.x},${q.y},${q.z}`, q.y === c.yb && ((q.x === c.F.x && q.z === c.F.z) || (q.x === c.H.x && q.z === c.H.z)) ? 'bed' : 'block')
    for (let k = 1; k <= c.depth; k++) post.set(`${c.B.x},${c.G - k},${c.B.z}`, 'air')
    const vPost = virtualBot(bot, post)
    if (exposure(vPost, c.trench, c.centre) > 0.02) { no('после L окоп A открыт взрыву A'); continue }
    if (!tsClickPoint(vPost, c.trench.offset(0, EYE, 0), c)) { no('после L бок A не видно'); continue }
    if (!tsClickPoint(virtualBot(bot, exBoth), plan.trench.offset(0, EYE, 0), plan)) { no('A закрыла бок L'); continue }
    // видимость дракона из центра A — без самой кровати A (её убирают до взрыва)
    const noBed = new Map(post); noBed.set(`${c.F.x},${c.yb},${c.F.z}`, 'air'); noBed.set(`${c.H.x},${c.yb},${c.H.z}`, 'air')
    const seen = dpos ? dragonSeen(virtualBot(bot, noBed), c.centre, dpos) : (c.seen || 1)
    const expect = bedDamage(c.centre.distanceTo(target), seen)
    if (cap != null && expect > cap) { no('A больше потолка'); continue }
    if (expect < 30) { no('A мала'); (tsOwnPlan.small = tsOwnPlan.small || []).push({ d: r1(c.centre.distanceTo(target)), seen: r1(seen), e0: c.expect, lift: c.lift }); continue }
    const score = expect - (c.sCells.length + c.wCells.length) * 1.5 - c.depth * 3
    if (!best || score > best.score) best = { ...c, expect, seen: Math.round(seen * 100) / 100, score, role: 'A', own: true }
  }
  return best
}
declare namespace tsOwnPlan {
  let why: any
  let small: any
}

async function placeAnchorAt (bot, plan) {
  const Hp = new Vec3(plan.H.x, plan.yb, plan.H.z)
  const cur = bot.blockAt(Hp)
  if (cur && cur.name === 'respawn_anchor') return { ok: true, already: true }
  const it = bot.inventory.items().find(i => i.name === 'respawn_anchor')
  if (!it) return { ok: false, why: 'нет якоря' }
  const Wb = bot.blockAt(new Vec3(plan.W.x, plan.yb, plan.W.z))
  if (!Wb || !isSolid(Wb)) return { ok: false, why: 'нет блока заслона на высоте якоря' }
  const face = new Vec3(plan.u.x, 0, plan.u.z)
  const was = bot.getControlState('sneak')
  bot.setControlState('sneak', true)
  try {
    await bot.equip(it, 'hand')
    await new Promise<any>(resolve => bot.once('physicsTick', resolve))
    const aim = pick.faceAim(bot, Wb.position, face)
    if (!aim) return { ok: false, why: 'грань заслона не видно' }
    await bot.lookAt(aim, true)
    try { await build.withTimeout(bot.placeBlock(Wb, face), 1500) } catch (e) { dbg('anchor place', e.message) }
  } finally { if (!was) bot.setControlState('sneak', false) }
  const b = bot.blockAt(Hp)
  return b && b.name === 'respawn_anchor' ? { ok: true } : { ok: false, why: `не встал (${b ? b.name : '?'})` }
}

function anchorCharges (bot, p) {
  const b = bot.blockAt(p)
  if (!b || b.name !== 'respawn_anchor') return -1
  try { const pr = b.getProperties(); return Number(pr.charges || 0) } catch { return 0 }
}

async function chargeAnchor (bot, plan, n = 1, clickFn = null) {
  const Hp = new Vec3(plan.H.x, plan.yb, plan.H.z)
  for (let k = 0; k < 3 && anchorCharges(bot, Hp) < n; k++) {
    if (anchorCharges(bot, Hp) < 0) return { ok: false, why: 'якоря нет' }
    const glow = bot.inventory.items().find(i => i.name === 'glowstone')
    if (!glow) return { ok: false, why: 'нет светокамня' }
    bot.setControlState('sneak', false)
    await bot.equip(glow, 'hand')
    const hit = clickFn ? clickFn() : anClickPoint(bot, bot.entity.position.offset(0, EYE, 0), plan)
    if (!hit) return { ok: false, why: 'якорь не видно' }
    await lookAtSafe(bot, hit.point)
    await new Promise<any>(resolve => bot.once('physicsTick', resolve))
    const cur = hit.point.minus(hit.block.position)
    bot._client.write('block_place', { location: hit.block.position, direction: FACE_IDX(hit.face), hand: 0, cursorX: cur.x, cursorY: cur.y, cursorZ: cur.z, insideBlock: false, sequence: 0, worldBorderHit: false })
    bot.swingArm()
    const t0 = gameClock.now()
    while (gameClock.now() - t0 < 600 && anchorCharges(bot, Hp) < n) await sleep(30)
  }
  const wpn = items.bestWeapon(bot)
  if (wpn) await bot.equip(wpn, 'hand').catch(() => {})
  return anchorCharges(bot, Hp) >= n ? { ok: true } : { ok: false, why: `заряд ${anchorCharges(bot, Hp)}` }
}

const TURN_SAFE_R = 9.2

function turnSafe (d, feet) { return Math.hypot(feet.x - d.position.x, feet.z - d.position.z) >= TURN_SAFE_R }

function clearOfDragon (bot, from, to, parts) {
  if (!parts) return true
  const n = Math.max(1, Math.ceil(from.distanceTo(to) / 0.4))
  for (let k = 1; k <= n; k++) {
    const p = from.plus(to.minus(from).scaled(k / n))
    if (hurtNear(playerBox(p), parts)) return false
  }
  return true
}

async function placeBedAt (bot, F, H, y) {
  const floor = bot.blockAt(new Vec3(F.x, y - 1, F.z))
  if (!floor || !isSolid(floor)) return { ok: false, why: 'нет пола под изножьем' }
  if (!pick.faceAim(bot, floor.position, new Vec3(0, 1, 0))) return { ok: false, why: 'пол под изножьем не видно' }
  try {
    await bot.equip(findItem(bot, /_bed$/), 'hand')
    await bot.lookAt(floor.position.offset(0.5, 1, 0.5), true)
    await new Promise<any>(resolve => bot.once('physicsTick', resolve))
    // В руке должна быть кровать: иначе «кровать» встаёт булыжником досыпки
    // (b4, попытка 2: «кровать не встала (air/cobblestone)»).
    if (!bot.heldItem || !/_bed$/.test(bot.heldItem.name)) {
      await bot.equip(findItem(bot, /_bed$/), 'hand')
      await new Promise<any>(resolve => bot.once('physicsTick', resolve))
      if (!bot.heldItem || !/_bed$/.test(bot.heldItem.name)) return { ok: false, why: 'кровать не в руке' }
    }
    await build.withTimeout(bot.placeBlock(floor, new Vec3(0, 1, 0)), 1500)
  } catch (e) { dbg('beds bed', e.message) }
  await sleep(60)
  const h = bot.blockAt(new Vec3(H.x, y, H.z)); const f = bot.blockAt(new Vec3(F.x, y, F.z))
  if (h && /_bed$/.test(h.name) && f && /_bed$/.test(f.name)) return { ok: true }
  return { ok: false, why: `кровать не встала (${h ? h.name : '?'}/${f ? f.name : '?'})` }
}

const AXES = [{ x: 1, z: 0 }, { x: -1, z: 0 }, { x: 0, z: 1 }, { x: 0, z: -1 }]

async function placeNoBed (bot, pos, { timeoutMs = 1200 }: any = {}) {
  const at = bot.blockAt(pos)
  if (!at) return { ok: false, reason: 'не прогружено' }
  if (isSolid(at)) return { ok: true, already: at.name }
  if (build.occupiedByEntity(bot, pos)) return { ok: false, reason: `в клетке стоит ${build.occupiedByEntity(bot, pos)}` }
  const filler = fillerItem(bot) || (build.pickFiller(bot, { steady: true }) || {}).name
  const stack = bot.inventory.items().find(i => i.name === filler) || bot.inventory.items().find(i => FILLER_RE.test(i.name))
  if (!stack) return { ok: false, reason: 'нечем строить' }
  const was = bot.getControlState('sneak')
  bot.setControlState('sneak', true)
  try {
    await bot.equip(stack, 'hand')
    await new Promise<any>(resolve => bot.once('physicsTick', resolve))
    for (const face of [new Vec3(0, 1, 0), new Vec3(1, 0, 0), new Vec3(-1, 0, 0), new Vec3(0, 0, 1), new Vec3(0, 0, -1), new Vec3(0, -1, 0)]) {
      const ref = bot.blockAt(pos.minus(face))
      if (!ref || !isSolid(ref) || /_bed$|portal|gateway/.test(ref.name)) continue
      const aim = pick.faceAim(bot, ref.position, face)
      if (!aim) continue
      try {
        await bot.lookAt(aim, true)
        await build.withTimeout(bot.placeBlock(ref, face), timeoutMs)
      } catch (e) { dbg('placeNoBed', e.message) }
      if (isSolid(bot.blockAt(pos))) return { ok: true }
    }
    return { ok: false, reason: 'не к чему прислонить (кроме кровати) или грань не видно' }
  } finally { if (!was) bot.setControlState('sneak', false) }
}

module.exports = { DAMAGE_TYPES, r3, readVarIntAt, yRotOf, lpVec3At, pushedForecast, NODE_ADJ, nodesCache, dragonNodes, nd2, ndist, closestNode, findNodePath, takeoffNode, blastPush, takeoffForecast, FACE_IDX, tsPlan, tsSecond, blastDestroyed, stationCells, stationWorld, tsOwnStation, tsOwnPlan, placeAnchorAt, anchorCharges, chargeAnchor, TURN_SAFE_R, turnSafe, clearOfDragon, placeBedAt, AXES, placeNoBed }
