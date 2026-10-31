// Рой: где могут быть тайники — честное знание команды (21.10, пользователь: «в стенах Колизея спрятано 2–3 тайника; где —
// боты не знают»). Только то, что видит игрок:
//   · лучи глаз (daemon cache-scan): клетка, куда луч вошёл, — увиденный воздух; первая непрозрачная — увиденная грань.
//     Толща постройки — столбцы, где видна грань выше клетки, а сама клетка не видна ни разу (форма, которую видит игрок:
//     ряды, стены, ярусы; что внутри — неизвестно). Тайник — только там: у него нет открытой грани, луч в него не входит;
//   · «пирог» F3 с наклоном (окно взгляда рысканье × тангаж): сколько сундуков в окне — минус известные команде в том же
//     окне. Окно, где лишних нет, — тайника там нет; лишние — они среди невиданных клеток окна (поровну, пока не уточнено
//     с другого места). Клетки «пирог» не даёт, только счёт.
// Ничего о раскладке: модель общая для любой постройки и рельефа (коробка арены и уровень пола — всё, что ей дают).
// Копка (planDig): ход 1×2 к точке, выбранный по открытой вероятности на секунду (цена — дорога и копка); узор «шаг 3»
// получается сам — соседний ход ближе трёх открывает уже открытое.
import type { SwarmPosition } from './types'

export type Box = { x0: number; x1: number; y0: number; y1: number; z0: number; z1: number }
export type CacheScan = {
  eye: SwarmPosition; n: number; spin: number; range: number
  // по лучу: [x, y, z, грань] первой непрозрачной клетки (грань — нормаль к смотрящему, FACES), [t] — непрогруженное с t
  // (воздух только до t) или 0 — до range пусто
  hits: (number[] | 0)[]
  pie?: { step: number; range: number; bins: number[][] } // [рысканье, тангаж, счёт] — только ненулевые окна
  chests?: number[][] // сундуки, видимые сейчас (грань под лучом)
}
export type DigPlan = { from: SwarmPosition; to: SwarmPosition; gain: number; cost: number; rate: number; cells: number; exposed: number[] }

export const FACES = [[-1, 0, 0], [1, 0, 0], [0, -1, 0], [0, 1, 0], [0, 0, -1], [0, 0, 1]]
const UNKNOWN = 0, AIR = 1, SOLID = 2, DUG = 3

// Лучи — сфера Фибоначчи на n точек, повёрнутая (spin ∈ [0, 1)): сетка не повторяется от скана к скану. Одна функция у
// демона (бросает лучи) и у модели (восстанавливает их по ответу).
export function rayDirs (n: number, spin: number): number[][] {
  const out: number[][] = []
  const ga = Math.PI * (3 - Math.sqrt(5)), jitter = (spin * 7.13) % 1
  for (let i = 0; i < n; i++) {
    const y = 1 - (i + jitter) / n * 2, r = Math.sqrt(Math.max(0, 1 - y * y)), th = ga * i + spin * 2 * Math.PI
    out.push([Math.cos(th) * r, y, Math.sin(th) * r])
  }
  return out
}

// Окно «пирога» для точки от глаз: рысканье atan2(dz, dx) и тангаж — в градусах, шагом step. Та же функция у демона.
export function pieBin (eye: SwarmPosition, x: number, y: number, z: number, step: number): number {
  const dx = x - eye.x, dy = y - eye.y, dz = z - eye.z
  const yaw = (Math.atan2(dz, dx) * 180 / Math.PI + 360) % 360
  const pitch = Math.atan2(dy, Math.hypot(dx, dz)) * 180 / Math.PI + 90
  return Math.floor(yaw / step) * 1000 + Math.min(Math.floor(180 / step) - 1, Math.floor(pitch / step))
}

// Лучи из глаз o: по каждому — первая непрозрачная клетка и грань входа (нормаль к смотрящему), [t] — луч ушёл в непрогруженное
// на расстоянии t (дальше не видно) или 0 — до range пусто. opaque: 1 —
// непрозрачно, 0 — прозрачно, −1 — не прогружено (конец луча). Демон зовёт с миром тела, тесты — с сеткой.
export function castRays (o: SwarmPosition, opaque: (x: number, y: number, z: number) => number, n: number, spin: number, range: number): (number[] | 0)[] {
  return rayDirs(n, spin).map(d => castRay(o, opaque, d, range))
}

export function castRay (o: SwarmPosition, opaque: (x: number, y: number, z: number) => number, d: number[], range: number): number[] | 0 {
  const inv = (v: number) => Math.abs(v) < 1e-12 ? Infinity : Math.abs(1 / v)
    let x = Math.floor(o.x), y = Math.floor(o.y), z = Math.floor(o.z)
    const sx = d[0] > 0 ? 1 : -1, sy = d[1] > 0 ? 1 : -1, sz = d[2] > 0 ? 1 : -1
    let tx = Math.abs(d[0]) < 1e-12 ? Infinity : ((sx > 0 ? x + 1 : x) - o.x) / d[0]
    let ty = Math.abs(d[1]) < 1e-12 ? Infinity : ((sy > 0 ? y + 1 : y) - o.y) / d[1]
    let tz = Math.abs(d[2]) < 1e-12 ? Infinity : ((sz > 0 ? z + 1 : z) - o.z) / d[2]
    let hit: number[] | 0 = 0
    for (let i = 0; i < 4 * range; i++) {
      let t: number, face: number
      // Нормаль к смотрящему: шаг +x — вошёл через грань −x (0), шаг −x — через +x (1); так же y (2, 3) и z (4, 5).
      if (tx <= ty && tx <= tz) { t = tx; x += sx; tx += inv(d[0]); face = sx > 0 ? 0 : 1 } else if (ty <= tz) { t = ty; y += sy; ty += inv(d[1]); face = sy > 0 ? 2 : 3 } else { t = tz; z += sz; tz += inv(d[2]); face = sz > 0 ? 4 : 5 }
      if (t > range) break
      const s = opaque(x, y, z)
      if (s < 0) { hit = [t]; break } // не прогружено: луч кончился здесь, дальше не видно
      if (s > 0) { hit = [x, y, z, face]; break }
    }
    return hit
}

// «Пирог» с наклоном: счёт сундуков в окнах взгляда от глаз o (range — дальность отрисовки блок-сущностей).
export function pieCounts (o: SwarmPosition, chests: SwarmPosition[], step: number, range: number): number[][] {
  const bins = new Map<number, number>()
  for (const c of chests) {
    if (Math.hypot(c.x + .5 - o.x, c.y + .5 - o.y, c.z + .5 - o.z) > range) continue
    const b = pieBin(o, c.x + .5, c.y + .5, c.z + .5, step)
    bins.set(b, (bins.get(b) || 0) + 1)
  }
  return [...bins].map(([b, k]) => [Math.floor(b / 1000), b % 1000, k])
}

type PieScan = { eye: SwarmPosition; step: number; range: number; bins: Map<number, number> }

export class CacheModel {
  box: Box; sx: number; sy: number; sz: number
  state: Uint8Array
  colTop: Int16Array
  lw: Float32Array
  pies: PieScan[] = []
  known = new Map<string, SwarmPosition>()
  found = new Set<string>()
  expected: number
  unknown = 2.5
  dirty = true
  cand: Int32Array = new Int32Array(0)
  total = 0
  scans = 0

  constructor (box: Box, { expected = 2.5 }: { expected?: number } = {}) {
    this.box = box
    this.sx = box.x1 - box.x0 + 1; this.sy = box.y1 - box.y0 + 1; this.sz = box.z1 - box.z0 + 1
    this.state = new Uint8Array(this.sx * this.sy * this.sz)
    this.colTop = new Int16Array(this.sx * this.sz).fill(-1)
    this.lw = new Float32Array(this.state.length)
    this.expected = expected
    this.unknown = expected
  }

  idx (x: number, y: number, z: number): number {
    x -= this.box.x0; y -= this.box.y0; z -= this.box.z0
    if (x < 0 || y < 0 || z < 0 || x >= this.sx || y >= this.sy || z >= this.sz) return -1
    return (y * this.sz + z) * this.sx + x
  }
  at (i: number): SwarmPosition { const x = i % this.sx, r = (i - x) / this.sx, z = r % this.sz, y = (r - z) / this.sz; return { x: x + this.box.x0, y: y + this.box.y0, z: z + this.box.z0 } }
  stateAt (x: number, y: number, z: number): number { const i = this.idx(x, y, z); return i < 0 ? -1 : this.state[i] }
  open (x: number, y: number, z: number): boolean { const s = this.stateAt(x, y, z); return s === AIR || s === DUG }
  // Невиданная клетка толщи: в её столбце видна непрозрачная грань выше неё; ниже пола коробки (y0 — слой пола) не ищем.
  // Сосед — увиденный воздух: тайником клетка быть не может. Это вывод из правила игры, которое знает бот («тайник спрятан в
  // толще, снаружи его не видно»): сундук с открытой гранью виден снаружи — значит, не спрятан. Раскладку и место тайника
  // правило не выдаёт: лишь отсекает клетки, у которых бот сам видел воздух рядом.
  candidate (i: number): boolean {
    if (this.state[i] !== UNKNOWN) return false
    const x = i % this.sx, r = (i - x) / this.sx, z = r % this.sz, y = (r - z) / this.sz
    if (y < 1 || this.colTop[z * this.sx + x] <= y) return false
    const st = this.state, sx = this.sx, layer = this.sx * this.sz
    const open = (j: number) => st[j] === AIR || st[j] === DUG
    return !(x > 0 && open(i - 1) || x < sx - 1 && open(i + 1) || z > 0 && open(i - sx) || z < this.sz - 1 && open(i + sx) || open(i - layer) || y < this.sy - 1 && open(i + layer))
  }

  // Увиденная грань: клетка непрозрачна; форма постройки — высота столбцов вокруг (2 бл.: лучи редки, грань соседнего
  // столбца — та же стена; лишний воздух у подножия увиден лучами и в толщу не попадёт).
  private solid (x: number, y: number, z: number) {
    const i = this.idx(x, y, z); if (i < 0) return
    if (this.state[i] !== DUG) this.state[i] = SOLID
    const ry = y - this.box.y0
    for (let dx = -2; dx <= 2; dx++) for (let dz = -2; dz <= 2; dz++) {
      const cx = x - this.box.x0 + dx, cz = z - this.box.z0 + dz
      if (cx < 0 || cz < 0 || cx >= this.sx || cz >= this.sz) continue
      const c = cz * this.sx + cx
      if (ry > this.colTop[c]) this.colTop[c] = ry
    }
  }

  // Скан глаз: воздух по лучам, грани, видимые сундуки, окна «пирога».
  addScan (s: CacheScan): void {
    const dirs = rayDirs(s.n, s.spin)
    for (let k = 0; k < s.hits.length && k < dirs.length; k++) {
      const h = s.hits[k], d = dirs[k]
      if (h && h.length === 1) { this.trace(s.eye, d, h[0], null); continue }
      this.trace(s.eye, d, h ? Math.hypot(h[0] + .5 - s.eye.x, h[1] + .5 - s.eye.y, h[2] + .5 - s.eye.z) + 1 : s.range, h || null)
      if (h) this.solid(h[0], h[1], h[2])
    }
    for (const c of s.chests || []) { this.known.set(`${c[0]},${c[1]},${c[2]}`, { x: c[0], y: c[1], z: c[2] }); this.solid(c[0], c[1], c[2]) }
    if (s.pie) {
      const scan: PieScan = { eye: { ...s.eye }, step: s.pie.step, range: s.pie.range, bins: new Map(s.pie.bins.map(b => [b[0] * 1000 + b[1], b[2]])) }
      // Скан с того же места (3 бл.) заменяет прежний: повтор не добавляет знания, а лишь удваивал бы его вес.
      const same = this.pies.findIndex(p => Math.hypot(p.eye.x - scan.eye.x, p.eye.y - scan.eye.y, p.eye.z - scan.eye.z) < 3)
      if (same >= 0) this.pies.splice(same, 1)
      this.pies.push(scan)
      if (this.pies.length > 24) this.pies.shift() // ponytail: последние 24 места; больше — отбор по разнесённости
    }
    this.scans++
    this.dirty = true
  }

  // Луч по клеткам до попадания (или range): пройденные — воздух (поверх «грани»: её снесли — теперь это воздух).
  private trace (o: SwarmPosition, d: number[], len: number, hit: number[] | null) {
    let x = Math.floor(o.x), y = Math.floor(o.y), z = Math.floor(o.z)
    const sx = d[0] > 0 ? 1 : -1, sy = d[1] > 0 ? 1 : -1, sz = d[2] > 0 ? 1 : -1
    const inv = (v: number) => Math.abs(v) < 1e-12 ? Infinity : Math.abs(1 / v)
    let tx = Math.abs(d[0]) < 1e-12 ? Infinity : ((sx > 0 ? x + 1 : x) - o.x) / d[0]
    let ty = Math.abs(d[1]) < 1e-12 ? Infinity : ((sy > 0 ? y + 1 : y) - o.y) / d[1]
    let tz = Math.abs(d[2]) < 1e-12 ? Infinity : ((sz > 0 ? z + 1 : z) - o.z) / d[2]
    const ddx = inv(d[0]), ddy = inv(d[1]), ddz = inv(d[2])
    for (let n = 0; n < 512; n++) {
      if (hit && x === hit[0] && y === hit[1] && z === hit[2]) return
      const i = this.idx(x, y, z)
      if (i >= 0 && this.state[i] !== DUG) this.state[i] = AIR
      let t
      if (tx <= ty && tx <= tz) { t = tx; x += sx; tx += ddx } else if (ty <= tz) { t = ty; y += sy; ty += ddy } else { t = tz; z += sz; tz += ddz }
      if (t > len) return
    }
  }

  markDug (cells: SwarmPosition[]): void { for (const c of cells) { const i = this.idx(c.x, c.y, c.z); if (i >= 0) this.state[i] = DUG } this.dirty = true }
  // Где тело прошло (ноги и голова): там воздух, а грани вокруг — перед глазами (ход 1×2 виден изнутри целиком; лучи скана
  // редки и стенки хода ловят через раз). Что за гранью — по-прежнему неизвестно: соседи — «увиденная грань», не глубже.
  markWalked (feet: SwarmPosition): void {
    const x = Math.floor(feet.x), y = Math.floor(feet.y), z = Math.floor(feet.z)
    for (const yy of [y, y + 1]) {
      const i = this.idx(x, yy, z)
      if (i < 0) continue
      if (this.state[i] !== DUG) this.state[i] = AIR
      for (const f of FACES) { const j = this.idx(x + f[0], yy + f[1], z + f[2]); if (j >= 0 && this.state[j] === UNKNOWN) this.state[j] = SOLID }
    }
    this.dirty = true
  }
  markFound (p: SwarmPosition): void { const k = `${p.x},${p.y},${p.z}`; this.found.add(k); this.known.set(k, { ...p }); this.dirty = true }

  // Вес клеток: лог-правдоподобие по окнам «пирога» относительно равномерного (ρ0 = ожидаемых тайников / невиданных клеток).
  // Окно без лишних сундуков — клетки окна вычеркнуты (−∞); лишние r на M невиданных клеток окна — множитель (r/M)/ρ0.
  // force — пересчитать сейчас; иначе не чаще minGapMs (реального времени): пересчёт — десятки мс на 70 тыс. клеток, а сканы
  // идут каждую секунду; между пересчётами веса чуть старые, но увиденное вычёркивается сразу (candidate — по состоянию).
  minGapMs = 0
  private refreshedAt = -Infinity
  refresh (force = false): void {
    if (!this.dirty) return
    const t = performance.now()
    if (!force && t - this.refreshedAt < this.minGapMs) return
    this.refreshedAt = t
    this.dirty = false
    this.epoch++
    const list: number[] = []
    for (let i = 0; i < this.state.length; i++) if (this.candidate(i)) list.push(i)
    this.cand = Int32Array.from(list)
    const N = list.length
    // Невиданных сундуков в «пироге» (больше всего с одного места: окна минус известные) — тайники и ещё не увиденные обычные
    // (комнаты, галереи). Вес клеток — на всех невиданных; доля тайников в находке — left/unknown (знание правила: их 2–3).
    const left = Math.max(0.5, this.expected - this.found.size)
    let U = 0
    for (const p of this.pies) {
      const known = new Map<number, number>()
      for (const c of this.known.values()) if (Math.hypot(c.x + .5 - p.eye.x, c.y + .5 - p.eye.y, c.z + .5 - p.eye.z) <= p.range) { const b = pieBin(p.eye, c.x + .5, c.y + .5, c.z + .5, p.step); known.set(b, (known.get(b) || 0) + 1) }
      let u = 0
      for (const [b, k] of p.bins) u += Math.max(0, k - (known.get(b) || 0))
      U = Math.max(U, u)
    }
    this.unknown = Math.max(left, U)
    const rho0 = N ? this.unknown / N : 1
    const lw = this.lw
    const cx = new Float32Array(N), cy = new Float32Array(N), cz = new Float32Array(N)
    for (let k = 0; k < N; k++) { const i = list[k]; lw[i] = 0; const p = this.at(i); cx[k] = p.x + .5; cy[k] = p.y + .5; cz[k] = p.z + .5 }
    // Окна — плотным массивом (рысканье < 128, тангаж < 64 при шаге ≥ 3°).
    const dense = (b: number) => Math.floor(b / 1000) * 64 + b % 1000
    const binOf = new Int32Array(N)
    for (const p of this.pies) {
      const r2 = p.range * p.range, known = new Int32Array(128 * 64), M = new Int32Array(known.length)
      for (const c of this.known.values()) {
        const dx = c.x + .5 - p.eye.x, dy = c.y + .5 - p.eye.y, dz = c.z + .5 - p.eye.z
        if (dx * dx + dy * dy + dz * dz <= r2) known[dense(pieBin(p.eye, c.x + .5, c.y + .5, c.z + .5, p.step))]++
      }
      // Вычеркнутые прежними окнами в счёт клеток окна не идут: тайника там нет — лишний сундук делится на оставшиеся.
      for (let k = 0; k < N; k++) {
        binOf[k] = -1
        if (lw[list[k]] === -Infinity) continue
        const dx = cx[k] - p.eye.x, dy = cy[k] - p.eye.y, dz = cz[k] - p.eye.z
        if (dx * dx + dy * dy + dz * dz > r2) continue
        const b = pieBin(p.eye, cx[k], cy[k], cz[k], p.step); binOf[k] = b; M[dense(b)]++
      }
      for (let k = 0; k < N; k++) {
        const b = binOf[k]; if (b < 0) continue
        const r = Math.max(0, (p.bins.get(b) || 0) - known[dense(b)])
        lw[list[k]] += r === 0 ? -Infinity : Math.log(r / M[dense(b)] / rho0)
      }
    }
    let total = 0
    for (const i of list) total += Math.exp(Math.min(30, lw[i]))
    this.total = total
  }
  weight (i: number): number { return this.candidate(i) ? Math.exp(Math.min(30, this.lw[i])) : 0 }
  // Вероятность, что тайник в клетке i (из оставшихся ожидаемых).
  prob (i: number): number { return this.total > 0 ? this.weight(i) / this.total * this.unknown : 0 }
  // Доля тайников среди невиданных сундуков (1 — без «пирога» или когда обычные все известны).
  get share (): number { return Math.min(1, Math.max(0.5, this.expected - this.found.size) / this.unknown) }

  // Цели копки: самые вероятные клетки (по одной на окрестность sep бл.) и, пока «пирог» не выделил мест, — невиданные
  // клетки толщи рядом с near (вес у всех равный: ближняя толща дешевле).
  private hotMemo: { epoch: number; key: string; out: { at: SwarmPosition; p: number }[] } | null = null
  private epoch = 0
  hotspots (k = 12, sep = 4, near: SwarmPosition | null = null): { at: SwarmPosition; p: number }[] {
    this.refresh()
    // Без near — одна выборка на пересчёт весов (сортировка 70 тыс. клеток — 8 мс, а зовут её на каждого копателя).
    const key = `${k},${sep}`
    if (!near && this.hotMemo && this.hotMemo.epoch === this.epoch && this.hotMemo.key === key) return this.hotMemo.out
    const out0 = this.hotspotsRaw(k, sep, near)
    if (!near) this.hotMemo = { epoch: this.epoch, key, out: out0 }
    return out0
  }
  private hotspotsRaw (k: number, sep: number, near: SwarmPosition | null): { at: SwarmPosition; p: number }[] {
    const top = [...this.cand].map(i => ({ i, w: this.weight(i) })).filter(o => o.w > 0).sort((a, b) => b.w - a.w || a.i - b.i)
    const out: { at: SwarmPosition; p: number }[] = []
    const add = (i: number) => {
      const at = this.at(i)
      if (out.some(h => Math.max(Math.abs(h.at.x - at.x), Math.abs(h.at.y - at.y), Math.abs(h.at.z - at.z)) < sep)) return
      out.push({ at, p: this.prob(i) })
    }
    // Вес 1 — равномерно (ничего не известно), 0 — вычеркнуто «пирогом», больше 1.5 — окна с лишним сундуком выделили место.
    for (const o of top) { if (out.length >= k || o.w < 1.5) break; add(o.i) }
    if (near) {
      const close = top.filter(o => { const c = this.at(o.i); return Math.hypot(c.x - near.x, c.y - near.y, c.z - near.z) < 20 })
      const stride = Math.max(1, Math.floor(close.length / k))
      for (let j = (this.scans * 7) % stride; j < close.length && out.length < 2 * k; j += stride) add(close[j].i)
    }
    return out
  }

  // Клетки хода 1×2 от ног from к to (ступенями, как dig_to: по большей оси, по высоте — шагом вверх/вниз) и всё, что он
  // открывает (клетки хода и их соседи). taken — уже открытое другими планами (не считать дважды).
  dig (from: SwarmPosition, to: SwarmPosition, taken: Set<number> = new Set()): { dug: SwarmPosition[]; solid: number; gain: number; exposed: number[] } {
    const dug: SwarmPosition[] = []
    let x = Math.floor(from.x), y = Math.floor(from.y), z = Math.floor(from.z)
    const tx = Math.floor(to.x), ty = Math.floor(to.y), tz = Math.floor(to.z)
    for (let n = 0; n < 64 && (x !== tx || z !== tz || y !== ty); n++) {
      const dx = tx - x, dz = tz - z
      if (dx || dz) { if (Math.abs(dx) >= Math.abs(dz)) x += Math.sign(dx); else z += Math.sign(dz) }
      if (ty > y) y++; else if (ty < y - 1 || (ty < y && !dx && !dz)) y--
      dug.push({ x, y, z }, { x, y: y + 1, z })
      if (!dx && !dz && ty >= y && ty <= y + 1) break
    }
    const seen = new Set<number>()
    let solid = 0, gain = 0
    for (const c of dug) {
      const i = this.idx(c.x, c.y, c.z)
      if (i < 0 || this.state[i] === UNKNOWN || this.state[i] === SOLID) solid++
      for (const f of [[0, 0, 0], ...FACES]) {
        const j = this.idx(c.x + f[0], c.y + f[1], c.z + f[2])
        if (j < 0 || seen.has(j) || taken.has(j)) continue
        seen.add(j)
        gain += this.prob(j)
      }
    }
    return { dug, solid, gain, exposed: [...seen] }
  }

  // Где можно стоять (видно: ноги и голова — воздух, под ногами — грань) рядом с точкой (r по каждой оси).
  standsNear (p: SwarmPosition, r = 10, max = 24): SwarmPosition[] {
    const out: { at: SwarmPosition; d: number }[] = []
    const px = Math.floor(p.x), py = Math.floor(p.y), pz = Math.floor(p.z)
    for (let y = py - r; y <= py + r; y++) for (let x = px - r; x <= px + r; x++) for (let z = pz - r; z <= pz + r; z++) {
      if (!this.open(x, y, z) || !this.open(x, y + 1, z)) continue
      const below = this.stateAt(x, y - 1, z)
      if (below !== SOLID && !(below === -1 && y - 1 < this.box.y0)) continue
      out.push({ at: { x, y, z }, d: Math.hypot(x - px, y - py, z - pz) })
    }
    return out.sort((a, b) => a.d - b.d).slice(0, max).map(o => o.at)
  }

  // Лучший ход для копателя в me: к каждой горячей точке — от себя и от мест, где можно стоять рядом с ней; цена — дорога
  // (путь ×1.3, бег 4 бл/с) и копка (digS на блок, ход по ходу 2 бл/с); выгода — вероятность найти тайник в открытом.
  // reserved — клетки, открытые планами других копателей; away — их цели (сектора: не ближе sep к чужой цели).
  // skip(to) — цель, что уже не вышла с этого места (повтор по причине у драйвера).
  planDig (me: SwarmPosition, { digS = 0.5, maxLen = 14, reserved = new Set<number>(), away = [] as SwarmPosition[], sep = 10, skip = null as ((to: SwarmPosition, from: SwarmPosition) => boolean) | null } = {}): DigPlan | null {
    this.refresh()
    let best: DigPlan | null = null
    const feet = { x: Math.floor(me.x), y: Math.floor(me.y), z: Math.floor(me.z) }
    const far = (p: SwarmPosition) => away.some(a => Math.hypot(a.x - p.x, a.z - p.z) < sep)
    // Места старта, кроме своего — до ±8 по высоте (лестницы, ряды): дальше путь по прямой врёт совсем. Дорога — по прямой
    // ×1.5 (обходы стен); не дошёл — эта пара и эта цель не повторяются с того места (retry у драйвера), так что дальняя
    // горячая точка стоит попытки (стенд 21.10: с пределом 20 бл. копатели видели «0/мин» — вся толща рядом вычеркнута).
    const walkable = (p: SwarmPosition) => Math.abs(p.y - feet.y) <= 8
    // Пол коробки (y0 — слой, на котором стоят) не копается никогда: под ним может быть пустота (арена на высоте — ход вниз с
    // поля уводил в пропасть под Колизеем, стенд 21.10).
    const floorY = this.box.y0 + 1
    const tryPlan = (s: SwarmPosition, to: SwarmPosition) => {
      if (far(to) || skip?.(to, s) || to.y < floorY) return
      const { dug, solid, gain, exposed } = this.dig(s, to, reserved)
      if (!dug.length || dug.some(c => c.y < floorY)) return
      const travel = s === feet ? 0 : Math.hypot(s.x - me.x, s.y - me.y, s.z - me.z) * 1.5 / 4
      const cost = 1 + travel + solid * digS + dug.length / 4
      const rate = gain / cost
      if (!best || rate > best.rate) best = { from: s, to, gain, cost, rate, cells: dug.length, exposed }
    }
    // Прямые ходы по четырём сторонам — от себя и от мест рядом, где можно стоять (равномерная толща: прямой 1×2 открывает
    // 6 клеток на 2 блока; лестница и зигзаг — меньше).
    // Уровень — свой и на 2–4 ниже или 2 выше (ступенями в начале хода): толща рядов — под ступенями, а не вровень с ними.
    for (const s of [feet, ...this.standsNear(feet, 5, 8).filter(walkable)]) for (const [dx, dz] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) for (const dy of [0, -2, -4, 2]) tryPlan(s, { x: s.x + dx * maxLen, y: s.y + dy, z: s.z + dz * maxLen })
    // К горячим точкам «пирога» — от себя и от мест рядом с ними.
    for (const h of this.hotspots(12, 4)) {
      for (const s of [feet, ...this.standsNear(h.at, 8, 12).filter(walkable)]) {
        // Ход длиннее maxLen — к точке не дотянуться за раз: до неё — первые maxLen шагов (следующий план продолжит). От себя —
        // и к дальней точке (копать к ней, а не идти в обход); от чужого места — только к ближней.
        const span = Math.max(Math.abs(h.at.x - s.x), Math.abs(h.at.z - s.z), Math.abs(h.at.y - s.y))
        if (s !== feet && span > maxLen * 1.6) continue
        // Ход — до соседней с горячей точкой клетки (со стороны старта), не в неё: в самой точке может стоять сундук — ход в неё
        // ломал его вслепую (стенд 21.10: сундуки галереи 2 «копались» каждый раунд, вещи падали, а увиден он так и не был).
        const dx = s.x - h.at.x, dz = s.z - h.at.z, dy = s.y - h.at.y
        const side = Math.abs(dx) >= Math.abs(dz) && dx ? { x: Math.sign(dx), y: 0, z: 0 } : dz ? { x: 0, y: 0, z: Math.sign(dz) } : { x: 0, y: Math.sign(dy) || 1, z: 0 }
        const near = { x: h.at.x + side.x, y: h.at.y + side.y, z: h.at.z + side.z }
        tryPlan(s, span > maxLen ? { x: Math.round(s.x + (h.at.x - s.x) * maxLen / span), y: Math.round(s.y + (h.at.y - s.y) * maxLen / span), z: Math.round(s.z + (h.at.z - s.z) * maxLen / span) } : near)
      }
    }
    return best
  }
}
