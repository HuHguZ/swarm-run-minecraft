'use strict'
// Офлайн-оценка «вторых клеток» подушки R (02.10 вечер, поток dragon): по свидетелю DragonLab (позы головы и тела по тикам
// на снижении) — какой урон дал бы каждый вариант кровати на каждом проходе: расстояние голова—центр взрыва + seen родителя по
// модели dragon.js (smCompile/smDragonSeen, сверена с сервером: |Δ| p90 0.009), коробка тела не даёт поставить F (bodyBlocksBed).
// Варианты в системе бота (s — сторона бота по z, side — сторона опоры K по x):
//   cur P / cur P+1 — как сейчас: H (0,yb,0) над столбом, F (0,yb,s), ставка по грани K (side,yb,s);
//   fwd P / fwd P+1 — дальше от бота: F (0,yb,0), H (0,yb,−s), ставка по грани K2 (side,yb,0) — нужен обсидиан K2;
//   lat P — вбок: F (−side,P,s), H (−side,P,0), ставка по грани −side булыжника (0,P,s) (опора P+1).
// Цепочка: на каждом проходе — лучший вариант (бот прогнозирует проход с ошибкой головы p90 0.26). Убийство 4 кроватями —
// если Σ4 модели набора ≥ Σ4 модели «как сейчас» + остаток хп после 4-й кровати.
//   node farm/dragon/offline/rcells.js rs8 rs9 ...
const fs = require('fs'); const path = require('path'); const vm = require('vm'); const Module = require('module')
const file = path.resolve(__dirname, '../../../daemon/src/dragon.js'); const req = Module.createRequire(file); const Vec3 = req('vec3')
const src = fs.readFileSync(file, 'utf8') + '\nmodule.exports.__R={smCompile,smDragonSeen,bodyBlocksBed,bedDamage,faceClick,faceClickFacing,exposure,lowRowsOpen,LABENV};'
const m = { exports: {} as Record<string, any> }
new vm.Script(Module.wrap(src), { filename: file }).runInThisContext()(m.exports, req, m, file, path.dirname(file))
const D = m.exports.__R
D.LABENV.ND_RUNNER = '1'
const LOGS = path.resolve(__dirname, '../../logs')

function worldBot (P, cells) {
  const o = P - 4
  const blockAt = p => {
    const x = Math.floor(p.x), y = Math.floor(p.y), z = Math.floor(p.z), r = x * x + z * z
    let name = y < o - 1 ? 'end_stone' : 'air'
    if (y === o - 1) name = r < 6.25 ? 'bedrock' : 'end_stone'
    if (y === o && r >= 6.25) name = r < 12.25 ? 'bedrock' : 'end_stone' // обод; дальше — земля на уровне обода (типично)
    if (x === 0 && z === 0 && y >= o && y < P) name = 'bedrock'
    const c = cells.get(`${x},${y},${z}`); if (c) name = c
    const solid = !['air'].includes(name)
    return { name, position: new Vec3(x, y, z), boundingBox: solid ? 'block' : 'empty', shapes: solid ? [[0, 0, 0, 1, 1, 1]] : [] }
  }
  return { blockAt, entity: { position: new Vec3(0, 0, 0), onGround: true }, entities: {} as Record<string, any> }
}
function variants (P, s, side) {
  const v = []
  for (const dy of [0, 1]) {
    const yb = P + dy
    v.push({ name: `cur${dy ? '+1' : ''}`, yb, H: { x: 0, z: 0 }, F: { x: 0, z: s }, K: { x: side, y: yb, z: s }, face: new Vec3(-side, 0, 0), cob: dy === 1, needK2: false })
    v.push({ name: `fwd${dy ? '+1' : ''}`, yb, H: { x: 0, z: -s }, F: { x: 0, z: 0 }, K: { x: side, y: yb, z: 0 }, face: new Vec3(-side, 0, 0), cob: false, needK2: true })
  }
  v.push({ name: 'lat', yb: P, H: { x: -side, z: 0 }, F: { x: -side, z: s }, K: { x: 0, y: P, z: s }, face: new Vec3(-side, 0, 0), cob: true, needK2: false })
  for (const q of v) q.centre = new Vec3(q.H.x + 0.5, q.yb + 0.5, q.H.z + 0.5)
  return v
}
function baseCells (P, s, side, k2) {
  const c = new Map()
  for (const [x, y, z] of [[side, P - 1, 0], [side, P - 1, s], [side, P, s], [side, P + 1, s]]) c.set(`${x},${y},${z}`, 'obsidian')
  if (k2) for (const [x, y, z] of (k2 === 'P1' ? [[side, P + 1, 0]] : [[side, P, 0], [side, P + 1, 0]])) c.set(`${x},${y},${z}`, 'obsidian')
  return c
}
function load (tag) {
  const out = []
  const dir = path.join(LOGS, 'trace-' + tag)
  for (const s of fs.readdirSync(dir).filter(x => /^s\d+$/.test(x))) {
    const lab = path.join(dir, s, 'lab-ev.jsonl'); if (!fs.existsSync(lab)) continue
    let plan = null
    for (const f of fs.readdirSync(path.join(dir, s)).filter(x => /^dragon-/.test(x))) for (const l of fs.readFileSync(path.join(dir, s, f), 'utf8').split('\n')) if (l.includes('"k":"pillarPlan"') && l.includes('"R":true')) { try { plan = JSON.parse(l) } catch {} }
    if (!plan) continue
    const ev = fs.readFileSync(lab, 'utf8').split('\n').filter(Boolean).map(l => { try { return JSON.parse(l) } catch { return null } }).filter(Boolean)
    const P = plan.H[1]; const sz = Math.sign(plan.B[2])
    let side = null
    for (const e of ev) if (e.t === 'occ' && e.occ.top) for (const [k] of e.occ.top) { const [x, , , n] = k.split(','); if (n === 'obsidian' && Math.abs(+x) === 1) { side = +x; break } }
    if (side == null) side = 1
    const poses = ev.filter(e => e.t === 'pose' && e.ph === 'LAND_ON_PORTAL')
    const bx = ev.filter(e => e.t === 'bx' && e.ph === 'LAND_ON_PORTAL'); const dd = ev.filter(e => e.t === 'dd' && e.type === 'bad_respawn_point')
    let ch = []; const cs = []
    for (const b of bx) { if (ch.length && b.tick - ch[ch.length - 1].tick > 100) { cs.push(ch); ch = [] } ch.push(b) }
    if (ch.length) cs.push(ch)
    for (const c of cs) {
      const items = c.map((b, i) => {
        const prev = i > 0 ? c[i - 1].tick + 10 : b.tick - 60
        const x = dd.find(e => e.tick === b.tick)
        return { b, win: poses.filter(p => p.tick >= prev && p.tick <= b.tick + Number(process.env.ND_RCELLS_TAIL ?? 1)), dmg: x ? x.fin : 0 }
      })
      out.push({ tag, s, P, sz, side, items, hp4: c[3] ? c[3].hp : null, n: c.length })
    }
  }
  return out
}
const tags = process.argv.slice(2)
const chains = tags.flatMap(load)
const snaps = new Map()
function snapFor (P, s, side, k2, v) {
  const key = `${P}|${s}|${side}|${k2}|${v.name}`
  if (snaps.has(key)) return snaps.get(key)
  const cells = baseCells(P, s, side, k2)
  if (v.cob) cells.set(`0,${P},${s}`, 'cobblestone')
  const bot = worldBot(P, cells)
  const skip = (x, y, z) => y === v.yb && ((x === v.H.x && z === v.H.z) || (x === v.F.x && z === v.F.z))
  const snap = D.smCompile(bot, [-16, P - 6, -16, 16, P + 16, 16], skip)
  // ставка и щелчок честные? экспозиция бота?
  const feet = new Vec3(0.5 + 0.2 * side, P - 4, 2 * s + 0.5); const eye = feet.offset(0, 1.62, 0)
  const place = D.faceClickFacing(bot, eye, new Vec3(v.K.x, v.K.y, v.K.z), v.face, { x: v.H.x - v.F.x, z: v.H.z - v.F.z }, { minCos: 0.8 })
  const wb = new Map(cells); wb.set(`${v.F.x},${v.yb},${v.F.z}`, 'red_bed'); wb.set(`${v.H.x},${v.yb},${v.H.z}`, 'red_bed')
  const bb = worldBot(P, wb)
  let click = null
  for (const cell of [v.F, v.H]) for (const f of [new Vec3(0, 0, s), new Vec3(side, 0, 0), new Vec3(-side, 0, 0), new Vec3(0, -1, 0)]) { if (!click) click = D.faceClick(bb, eye, new Vec3(cell.x, v.yb, cell.z), f) }
  const expo = D.exposure(bot, feet, v.centre)
  const r = { snap, place: !!place, click: !!click, expo }
  snaps.set(key, r)
  return r
}
// Кровать поставлена заранее (ND_RCELLS_PRE=1): есть тик t0 ≤ t (не раньше 20 тиков), когда коробка родителя F не закрывает,
// и до t ни голова, ни шея, ни тело (их коробки по позе) не задевают клетки F/H (checkWalls сломал бы кровать).
function partBoxes (p) {
  const h = p.head, b = p.body; const ux = h[0] - b[0], uz = h[2] - b[2]; const L = Math.hypot(ux, uz) || 1
  const nx = b[0] + ux * 5.5 / 6.5, ny = b[1] + (h[1] - b[1]) * 5.5 / 6.5, nz = b[2] + uz * 5.5 / 6.5
  const bc = [b[0] + ux / L * 0.5, b[2] + uz / L * 0.5]
  return [[h[0] - 0.5, h[1], h[2] - 0.5, h[0] + 0.5, h[1] + 1, h[2] + 0.5], [nx - 1.5, ny, nz - 1.5, nx + 1.5, ny + 3, nz + 1.5], [bc[0] - 2.5, b[1], bc[1] - 2.5, bc[0] + 2.5, b[1] + 3, bc[1] + 2.5]]
}
function prePlaced (it, v, t) {
  const cells = [[v.F.x, v.yb, v.F.z], [v.H.x, v.yb, v.H.z]].map(([x, y, z]: any) => [x, y, z, x + 1, y + 0.5625, z + 1])
  const hit = p => partBoxes(p).some(pb => cells.some(c => pb[0] < c[3] && pb[3] > c[0] && pb[1] < c[4] && pb[4] > c[1] && pb[2] < c[5] && pb[5] > c[2]))
  const win = it.win.filter(q => q.tick <= t && q.tick >= t - 20).sort((x, y) => y.tick - x.tick)
  for (const q of win) {
    if (hit(q)) return false
    if (!D.bodyBlocksBed(new Vec3(q.body[0], q.body[1], q.body[2]), { x: v.F.x, z: v.F.z }, v.yb, 0)) return q.tick < t
  }
  return false
}
function bestOf (it, ch, v, k2) {
  const sn = snapFor(ch.P, ch.sz, ch.side, k2, v)
  if (!sn.place || !sn.click || sn.expo > 0.02) return null
  let best = null
  for (const p of it.win) {
    const body = new Vec3(p.body[0], p.body[1], p.body[2])
    if (D.bodyBlocksBed(body, { x: v.F.x, z: v.F.z }, v.yb, 0) && !(process.env.ND_RCELLS_PRE === '1' && prePlaced(it, v, p.tick))) continue
    const head = new Vec3(p.head[0], p.head[1], p.head[2])
    const dist = head.distanceTo(v.centre)
    if (dist > 6.5) continue
    const seen = D.smDragonSeen(sn.snap, v.centre, body)
    if (seen == null) continue
    const dmg = D.bedDamage(dist, seen)
    if (!best || dmg > best.dmg) best = { dmg, dist, seen, tick: p.tick }
  }
  return best
}
const SETS = { now: { k2: false, names: ['cur', 'cur+1'] }, nowK21: { k2: 'P1', names: ['cur', 'cur+1'] }, fwd1: { k2: 'P1', names: ['cur', 'cur+1', 'fwd+1'] }, nowK2: { k2: true, names: ['cur', 'cur+1'] }, fwd: { k2: true, names: ['cur', 'cur+1', 'fwd', 'fwd+1'] }, fwdLat: { k2: true, names: ['cur', 'cur+1', 'fwd', 'fwd+1', 'lat'] }, lat: { k2: false, names: ['cur', 'cur+1', 'lat'] } }
const res: Record<string, any> = {} as Record<string, any>
const feas: Record<string, any> = {} as Record<string, any>
for (const ch of chains) {
  if (ch.n < 4) continue
  const vs = variants(ch.P, ch.sz, ch.side)
  for (const v of vs) for (const k2 of [false, true, "P1"]) { const sn = snapFor(ch.P, ch.sz, ch.side, k2, v); const k = `${v.name}${k2 ? '/K2' : ''}`; feas[k] = feas[k] || { n: 0, place: 0, click: 0, expoOk: 0 }; feas[k].n++; if (sn.place) feas[k].place++; if (sn.click) feas[k].click++; if (sn.expo <= 0.02) feas[k].expoOk++ }
  const sums: Record<string, any> = {} as Record<string, any>
  for (const [name, set] of Object.entries<any>(SETS)) {
    let sum = 0; const pick = []
    for (const it of ch.items.slice(0, 4)) {
      let b = null; let bn = null
      for (const v of vs.filter(q => set.names.includes(q.name))) { const r = bestOf(it, ch, v, set.k2); if (r && (!b || r.dmg > b.dmg)) { b = r; bn = v.name } }
      sum += b ? b.dmg : 0; pick.push(bn)
    }
    sums[name] = { sum, pick }
  }
  const act = ch.items.slice(0, 4).reduce((a, it) => a + it.dmg, 0)
  const need = sums.now.sum + Math.max(0, ch.hp4 || 0) // убито 4-й — hp4 ≤ 0
  for (const name of Object.keys(SETS)) {
    res[name] = res[name] || { n: 0, kill: 0, d: [], picks: {} as Record<string, any> }
    res[name].n++
    if (sums[name].sum >= need - 0.01) res[name].kill++
    res[name].d.push(sums[name].sum - sums.now.sum)
    for (const p of sums[name].pick) res[name].picks[p] = (res[name].picks[p] || 0) + 1
  }
  res.act = res.act || { n: 0, kill: 0, d: [] }; res.act.n++; if ((ch.hp4 || 0) <= 0) res.act.kill++; res.act.d.push(act - sums.now.sum)
}
const med = a => { a = a.slice().sort((x, y) => x - y); return a.length ? a[a.length >> 1] : null }
console.log('годность вариантов (ставка по грани / щелчок / экспозиция бота ≤ 2 %):', JSON.stringify(feas))
for (const [k, r] of Object.entries<any>(res)) console.log(k.padEnd(7), `цепочек ${r.n}, убийство 4-мя ${r.kill} (${Math.round(100 * r.kill / r.n)} %), Σ4 − модель «сейчас» p50 ${med(r.d)}`, r.picks ? JSON.stringify(r.picks) : '')

// Разбор потерь исполнения (ND_RCELLS_LOSS=1): по каждому взрыву — оракул (лучший тик и ярус окна) против факта.
if (process.env.ND_RCELLS_LOSS === '1') {
  const rows = []
  for (const ch of chains) {
    const vs = variants(ch.P, ch.sz, ch.side).filter(v => v.name === 'cur' || v.name === 'cur+1')
    for (const it of ch.items) {
      const b = it.b; const yb = Math.floor(b.c[1]); const used = vs.find(v => v.yb === yb)
      if (!used) continue
      let best = null; let bestV = null
      for (const v of vs) { const r = bestOf(it, ch, v, false); if (r && (!best || r.dmg > best.dmg)) { best = r; bestV = v } }
      const ub = bestOf(it, ch, used, false)
      // модель в фактический тик фактического яруса
      const sn = snapFor(ch.P, ch.sz, ch.side, false, used)
      const pose = it.win.find(p => p.tick === b.tick + 1) || null
      const mAct = pose ? D.bedDamage(new Vec3(...pose.head).distanceTo(used.centre), D.smDragonSeen(sn.snap, used.centre, new Vec3(pose.body[0], pose.body[1], pose.body[2])) ?? 1) : null
      rows.push({ act: it.dmg, mAct, oracle: best ? best.dmg : null, sameLevelBest: ub ? ub.dmg : null, levelOk: bestV === used, dt: best ? b.tick - best.tick : null, used: used.name, ora: bestV ? bestV.name : null, tickLoss: ub && mAct != null ? ub.dmg - mAct : null })
    }
  }
  const q = (a, p) => { a = a.filter(x => x != null).sort((x, y) => x - y); return a.length ? +a[Math.floor(p * (a.length - 1))].toFixed(1) : null }
  console.log('взрывов', rows.length, 'факт p50', q(rows.map(r => r.act), 0.5), 'модель в факт. тик p50', q(rows.map(r => r.mAct), 0.5), 'лучший тик того же яруса p50', q(rows.map(r => r.sameLevelBest), 0.5), 'оракул p50', q(rows.map(r => r.oracle), 0.5))
  console.log('потеря: ярус (оракул − лучший того же яруса) p50/p75', q(rows.map(r => r.oracle - r.sameLevelBest), 0.5), q(rows.map(r => r.oracle - r.sameLevelBest), 0.75), '; тик (лучший того же яруса − модель факта) p50/p75', q(rows.map(r => r.sameLevelBest - r.mAct), 0.5), q(rows.map(r => r.sameLevelBest - r.mAct), 0.75), '; модель − факт p50', q(rows.map(r => r.mAct - r.act), 0.5))
  const mean = a => { a = a.filter(x => x != null && isFinite(x)); return +(a.reduce((s, x) => s + x, 0) / a.length).toFixed(2) }
  console.log('средние потери: ярус', mean(rows.map(r => r.oracle - r.sameLevelBest)), 'тик', mean(rows.map(r => r.sameLevelBest - r.mAct)), 'модель−факт', mean(rows.map(r => r.mAct - r.act)), '; доля взрывов с потерей > 5:', rows.filter(r => r.oracle - r.act > 5).length + '/' + rows.length)
  const grp: Record<string, any> = {} as Record<string, any>; for (const r of rows) { const k = r.used + '→' + r.ora; grp[k] = grp[k] || { n: 0, loss: 0 }; grp[k].n++; grp[k].loss += (r.oracle - r.sameLevelBest) || 0 }
  console.log('ярус факт→оракул:', JSON.stringify(Object.fromEntries(Object.entries<any>(grp).map(([k, v]: any) => [k, { n: v.n, lossMean: +(v.loss / v.n).toFixed(1) }]))))
  const tl = rows.filter(r => r.tickLoss != null && r.tickLoss > 3); console.log('потеря тика > 3:', tl.length, 'сдвиг факт−лучший тик того же яруса p50', (() => { const a = tl.map(r => r.dt); a.sort((x, y) => x - y); return a[a.length >> 1] })())
  console.log('ярус выбран как у оракула:', rows.filter(r => r.levelOk).length, 'из', rows.length, '; сдвиг тика факт − оракул p25/p50/p75', q(rows.map(r => r.dt), 0.25), q(rows.map(r => r.dt), 0.5), q(rows.map(r => r.dt), 0.75))
}
