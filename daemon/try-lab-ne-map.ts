'use strict'
const gameClock = require('./src/game-clock')
// Знание карты Ада для сцен фермы (поток nether-end, 02.10): «как из копии этого же мира» — AGENTS.md разрешает основному
// телу знание карты из копии мира (бастионы, точки обзора, крепость). Здесь та же запись, снятая с правды фермы:
//   бастионы — /locate из центров 9 регионов (сетка Ада 432), forceload, save-all, NBT начала постройки (structures.starts:
//   куски jigsaw — шаблон, позиция, поворот) → золото и сундуки по шаблонам (bastion-pieces), золото сверено
//   `execute if block` (процессоры часть золота меняют);
//   крепость — то же NBT начала (куски nemt — тронный зал) и блок-сущность спавнера в чанках зала.
// Итог — записи памяти тела: «бастион (ад)», «бастион 2 (ад)» { x, y, z, gold, chests }, «крепость (ад)», «спавнер блейзов».
//
//   node try-lab-ne-map.js <слот> <x> <z> [bastions=2]   — проверка вручную (Ад слота должен быть поднят)
const fs = require('fs')
const path = require('path')
const zlib = require('zlib')
const net = require('net')
const nbt = require('prismarine-nbt')
const bp = require('./src/bastion-pieces')

const FARM = path.join(__dirname, '..', 'farm')
const sleep = ms => gameClock.wall.sleep(ms)

function props (slot) {
  const t = fs.readFileSync(path.join(FARM, `server-${slot}`, 'server.properties'), 'utf8')
  const get = k => { const m = new RegExp('^' + k.replace(/\./g, '\\.') + '=(.*)$', 'm').exec(t); return m ? m[1].trim() : null }
  return { port: Number(get('rcon.port')), pass: get('rcon.password') }
}
function rconOnce (port, pass, cmd, timeoutMs = 15000) {
  return new Promise<any>((resolve, reject) => {
    const pkt = (id, type, body) => {
      const b = Buffer.from(body, 'utf8')
      const buf = Buffer.alloc(14 + b.length)
      buf.writeInt32LE(10 + b.length, 0); buf.writeInt32LE(id, 4); buf.writeInt32LE(type, 8); b.copy(buf, 12)
      return buf
    }
    const sock = net.connect(port, '127.0.0.1', () => sock.write(pkt(1, 3, pass)))
    let acc = Buffer.alloc(0)
    let authed = false
    const t = gameClock.wall.setTimeout(() => { sock.destroy(); reject(new Error('rcon timeout')) }, timeoutMs)
    sock.on('data', d => {
      acc = Buffer.concat([acc, d])
      while (acc.length >= 4) {
        const len = acc.readInt32LE(0)
        if (acc.length < len + 4) break
        const id = acc.readInt32LE(4)
        const body = acc.slice(12, len + 2).toString('utf8')
        acc = acc.slice(len + 4)
        if (!authed) {
          if (id === -1) { gameClock.wall.clearTimeout(t); sock.end(); return reject(new Error('rcon auth failed')) }
          authed = true
          sock.write(pkt(2, 2, cmd))
        } else { gameClock.wall.clearTimeout(t); sock.end(); return resolve(body) }
      }
    })
    sock.on('error', e => { gameClock.wall.clearTimeout(t); reject(e) })
  })
}
function rconOf (slot) {
  const { port, pass } = props(slot)
  return cmd => rconOnce(port, pass, cmd).catch(e => 'ERR ' + e.message)
}

// Чанк из региона Ада слота (deflate/gzip/без сжатия) → NBT (simplify).
function chunkReader (slot, dim = 'the_nether') {
  const slotN = slot
  const dir = dim === 'overworld' ? path.join(FARM, `server-${slot}`, 'world', 'region') : path.join(FARM, `server-${slot}`, 'world_nether', 'DIM-1', 'region')
  const reader = (cx, cz) => {
    const f = path.join(dir, `r.${Math.floor(cx / 32)}.${Math.floor(cz / 32)}.mca`)
    let buf
    try { buf = fs.readFileSync(f) } catch { return null }
    const i = 4 * ((cx & 31) + (cz & 31) * 32)
    const off = ((buf[i] << 16) | (buf[i + 1] << 8) | buf[i + 2]) * 4096
    if (!off || off + 5 > buf.length) return null
    const len = buf.readUInt32BE(off)
    const type = buf[off + 4]
    const data = buf.slice(off + 5, off + 4 + len)
    try {
      const raw = type === 2 ? zlib.inflateSync(data) : type === 1 ? zlib.gunzipSync(data) : data
      return nbt.simplify(nbt.parseUncompressed(raw))
    } catch { return null }
  }
  reader.slot = slotN
  return reader
}

// Сущности чанка из entities/ региона Ада (1.17+ хранит сущности отдельно от блоков).
function entityReader (slot) {
  const dir = path.join(FARM, `server-${slot}`, 'world_nether', 'DIM-1', 'entities')
  return (cx, cz) => {
    const f = path.join(dir, `r.${Math.floor(cx / 32)}.${Math.floor(cz / 32)}.mca`)
    let buf
    try { buf = fs.readFileSync(f) } catch { return [] }
    const i = 4 * ((cx & 31) + (cz & 31) * 32)
    const off = ((buf[i] << 16) | (buf[i + 1] << 8) | buf[i + 2]) * 4096
    if (!off || off + 5 > buf.length) return []
    const len = buf.readUInt32BE(off)
    const type = buf[off + 4]
    const data = buf.slice(off + 5, off + 4 + len)
    try {
      const raw = type === 2 ? zlib.inflateSync(data) : type === 1 ? zlib.gunzipSync(data) : data
      const c = nbt.simplify(nbt.parseUncompressed(raw))
      return Array.isArray(c.Entities) ? c.Entities : []
    } catch { return [] }
  }
}

// Все постройки вида what в 3×3 регионах вокруг at (locate из центра каждого — ответ его кольца 0), ближние первыми.
async function locateAll (rcon, what, at) {
  if (!require('./src/perception/knowledge').allows('structures', 'try-lab-ne-map.locateAll')) return [] // S10: /locate — от ssg
  const out = []
  for (let i = -1; i <= 1; i++) {
    for (let j = -1; j <= 1; j++) {
      const p = { x: (Math.floor(at.x / 432) + i) * 432 + 216, z: (Math.floor(at.z / 432) + j) * 432 + 216 }
      const r = await rcon(`execute in minecraft:the_nether positioned ${p.x} 70 ${p.z} run locate structure minecraft:${what}`)
      const m = /\[(-?\d+), [^,]+, (-?\d+)\]/.exec(r)
      if (!m) continue
      const s = { x: Number(m[1]), z: Number(m[2]) }
      if (!out.some(o => o.x === s.x && o.z === s.z)) out.push({ ...s, dist: Math.round(Math.hypot(s.x - at.x, s.z - at.z)) })
    }
  }
  return out.sort((a, b) => a.dist - b.dist)
}

const ROT = { NONE: 0, CLOCKWISE_90: 1, CLOCKWISE_180: 2, COUNTERCLOCKWISE_90: 3 }
// Начало постройки из NBT чанка старта; чанк грузим forceload (генерация до FULL) и сбрасываем на диск save-all flush.
async function structureStart (rcon, read, id, x, z, dim = 'the_nether') {
  const cx = Math.floor(x / 16); const cz = Math.floor(z / 16)
  await rcon(`execute in minecraft:${dim} run forceload add ${cx * 16} ${cz * 16}`)
  for (let k = 0; k < 8; k++) {
    await sleep(k ? 1500 : 800)
    await rcon('save-all flush')
    const c = read(cx, cz)
    const st = c && c.structures && c.structures.starts && c.structures.starts[`minecraft:${id}`]
    if (st && st.Children) return st
  }
  return null
}
async function forceBox (rcon, bb, add = true) {
  // forceload — до 256 чанков за команду
  const [x1, z1, x2, z2] = bb
  const cmds = []
  for (let cx = Math.floor(x1 / 16); cx <= Math.floor(x2 / 16); cx += 15) {
    for (let cz = Math.floor(z1 / 16); cz <= Math.floor(z2 / 16); cz += 15) {
      const ex = Math.min(Math.floor(x2 / 16), cx + 14); const ez = Math.min(Math.floor(z2 / 16), cz + 14)
      cmds.push(`execute in minecraft:the_nether run forceload ${add ? 'add' : 'remove'} ${cx * 16} ${cz * 16} ${ex * 16} ${ez * 16}`)
    }
  }
  for (const c of cmds) await rcon(c)
}
const box = list => list.reduce((b, p) => [Math.min(b[0], p.x), Math.min(b[1], p.z), Math.max(b[2], p.x), Math.max(b[3], p.z)], [Infinity, Infinity, -Infinity, -Infinity])

// Бастион: куски → золото (сверено) и сундуки.
async function bastionOf (rcon, read, B) {
  const st = await structureStart(rcon, read, 'bastion_remnant', B.x, B.z)
  if (!st) return { ...B, error: 'нет NBT начала' }
  const L = bp.lib()
  const pieces = st.Children.map(c => ({ piece: String((c.pool_element && c.pool_element.location) || '').replace(/^minecraft:bastion\//, ''), r: ROT[c.rotation] ?? 0, t: { x: c.PosX, y: c.PosY, z: c.PosZ } }))
  const bbAll = st.Children.filter(c => Array.isArray(c.BB)).reduce((b, c) => [Math.min(b[0], c.BB[0]), Math.min(b[1], c.BB[1]), Math.min(b[2], c.BB[2]), Math.max(b[3], c.BB[3]), Math.max(b[4], c.BB[4]), Math.max(b[5], c.BB[5])], [Infinity, Infinity, Infinity, -Infinity, -Infinity, -Infinity])
  const start = pieces[0]
  const type = /^units\//.test(start.piece) ? 'units' : /^hoglin_stable\//.test(start.piece) ? 'hoglin_stable' : /^treasure\//.test(start.piece) ? 'treasure' : /^bridge\//.test(start.piece) ? 'bridge' : 'unknown'
  const gold = []
  const chests = []
  for (const c of pieces) {
    const P = L[c.piece]
    if (!P) continue
    for (const v of bp.goldOf(c)) gold.push({ x: v.x, y: v.y, z: v.z })
    for (const ch of (P.chests || [])) { const [x, y, z] = Array.isArray(ch) ? ch : [ch.x, ch.y, ch.z]; const v = bp.toWorld(c, x, y, z); chests.push({ x: v.x, y: v.y, z: v.z }) }
  }
  let real = gold
  if (gold.length) {
    const bb = box(gold)
    await forceBox(rcon, bb, true)
    // Чанки грузятся не сразу: execute if block в непрогруженном — «Test failed», и золото выпадало целиком (слот 22
    // 02.10: конюшни, золота 0 из плана). Ждать, пока каждый чанк с золотом прогружен (execute if loaded), до 30 с.
    const chunks = [...new Map(gold.map(g => [`${g.x >> 4},${g.z >> 4}`, g])).values()]
    for (let k = 0; k < 30; k++) {
      let all = true
      for (const g of chunks) { const q = await rcon(`execute in minecraft:the_nether if loaded ${g.x} ${g.y} ${g.z}`); if (!/passed/i.test(q)) { all = false; break } }
      if (all) break
      await sleep(1000)
    }
    real = []
    for (const g of gold) {
      let r = ''
      for (let k = 0; k < 3; k++) {
        r = await rcon(`execute in minecraft:the_nether if block ${g.x} ${g.y} ${g.z} minecraft:gold_block`)
        if (/passed|failed/i.test(r)) break
        await sleep(1000)
      }
      if (/passed/i.test(r)) real.push(g)
    }
    await forceBox(rcon, bb, false)
  }
  // Бруты бастиона (стоят у своих мест, не исчезают; удар 13) — из сущностей копии мира по коробке кусков: туда ход
  // по сетке — втридорога, золото у них — пропуск (D3-23 и D5-22 03.10, сид 2: оба раза смерть у брута у -72,36,-22).
  const brutes = []
  if (bbAll && Number.isFinite(bbAll[0])) {
    const bb2 = [bbAll[0], bbAll[2], bbAll[3], bbAll[5]]
    await forceBox(rcon, bb2, true)
    await sleep(2500)
    await rcon('save-all flush')
    await sleep(800)
    const er = entityReader(read.slot || 0)
    for (let cx = Math.floor(bb2[0] / 16); cx <= Math.floor(bb2[2] / 16); cx++) {
      for (let cz = Math.floor(bb2[1] / 16); cz <= Math.floor(bb2[3] / 16); cz++) {
        for (const e of er(cx, cz)) if (/piglin_brute/.test(String(e.id)) && Array.isArray(e.Pos)) brutes.push(e.Pos.map(v => Math.floor(v)))
      }
    }
    await forceBox(rcon, bb2, false)
  }
  const mid = box(real.length ? real : [start.t])
  const c0 = { x: Math.round((mid[0] + mid[2]) / 2), z: Math.round((mid[1] + mid[3]) / 2) }
  return { ...B, type, start: { type, r: start.r, t: start.t }, pieces: pieces.length, goldPlanned: gold.length, gold: real, chests, center: c0, bbAll: Number.isFinite(bbAll[0]) ? bbAll : null, brutes }
}

// Крепость: тронные залы (nemt) → спавнер из блок-сущностей их чанков.
async function fortressOf (rcon, read, F, at) {
  const st = await structureStart(rcon, read, 'fortress', F.x, F.z)
  if (!st) return { ...F, error: 'нет NBT начала' }
  const thrones = st.Children.filter(c => /nemt/i.test(String(c.id))).map(c => c.BB)
  // Коробка всей крепости (по кускам) — для сетки маршрута: мосты к тронному залу уходят далеко от прямой.
  const bbAll = st.Children.filter(c => Array.isArray(c.BB)).reduce((b, c) => [Math.min(b[0], c.BB[0]), Math.min(b[1], c.BB[1]), Math.min(b[2], c.BB[2]), Math.max(b[3], c.BB[3]), Math.max(b[4], c.BB[4]), Math.max(b[5], c.BB[5])], [Infinity, Infinity, Infinity, -Infinity, -Infinity, -Infinity])
  const spawners = []
  for (const bb of thrones) {
    const area = [bb[0], bb[2], bb[3], bb[5]]
    await forceBox(rcon, area, true)
    for (let k = 0; k < 8 && !spawners.some(s => s.x >= bb[0] && s.x <= bb[3] && s.z >= bb[2] && s.z <= bb[5]); k++) {
      await sleep(1500)
      await rcon('save-all flush')
      for (let cx = Math.floor(bb[0] / 16); cx <= Math.floor(bb[3] / 16); cx++) {
        for (let cz = Math.floor(bb[2] / 16); cz <= Math.floor(bb[5] / 16); cz++) {
          const c = read(cx, cz)
          for (const be of ((c && c.block_entities) || [])) {
            if (/mob_spawner/.test(String(be.id)) && !spawners.some(s => s.x === be.x && s.y === be.y && s.z === be.z)) spawners.push({ x: be.x, y: be.y, z: be.z })
          }
        }
      }
    }
    await forceBox(rcon, area, false)
  }
  spawners.sort((a, b) => Math.hypot(a.x - at.x, a.z - at.z) - Math.hypot(b.x - at.x, b.z - at.z))
  return { ...F, thrones: thrones.length, spawner: spawners[0] || null, spawners, bbAll: Number.isFinite(bbAll[0]) ? bbAll : null }
}

// Знание карты для точки входа at: { bastions: [...], fortress, places } — places готовы для fortress mode=map.
async function netherMap (slot, at, { bastions = 2, log = () => {} }: any = {} as Record<string, any>) {
  // S10: карта Ада копии с золотом бастиона — «полный скан» (MAP=1 без ND_KNOWLEDGE и есть scan).
  if (!require('./src/perception/knowledge').allows('gold', 'try-lab-ne-map.netherMap')) return { error: `знание ${require('./src/perception/knowledge').level()}: карта Ада копии не читается`, bastions: [], fortress: null, places: {} as Record<string, any> }
  const rcon = rconOf(slot)
  const read = chunkReader(slot)
  const out: Record<string, any> = { bastions: [], fortress: null, places: {} as Record<string, any> }
  const Bs = (await locateAll(rcon, 'bastion_remnant', at)).slice(0, bastions + 1) // +1: выбор без сокровищницы
  for (const B of Bs) {
    const b = await bastionOf(rcon, read, B).catch(e => ({ ...B, error: e.message }))
    log('бастион', { x: b.x, z: b.z, dist: b.dist, type: b.type, gold: (b.gold || []).length, planned: b.goldPlanned, error: b.error })
    out.bastions.push(b)
  }
  const Fs = await locateAll(rcon, 'fortress', at)
  const fs2 = []
  for (const F of Fs.slice(0, 3)) {
    const f = await fortressOf(rcon, read, F, at).catch(e => ({ ...F, error: e.message }))
    log('крепость', { x: f.x, z: f.z, dist: f.dist, thrones: f.thrones, spawner: f.spawner, error: f.error })
    if (f.spawner) fs2.push(f)
    if (fs2.length >= 2) break
  }
  await rcon('execute in minecraft:the_nether run forceload remove all')
  const keys = ['бастион (ад)', 'бастион 2 (ад)', 'бастион 3 (ад)']
  // Порядок бастионов — план по карте: сокровищница последней (её золото — в открытом зале над лавой, закрытым
  // штреком не взять: neF-map21-1, neF-map23-1 02.10 — 0 блоков, «штрек: пути нет»), если до другого не вдвое дальше.
  // Маршрут по карте (бастион первым, как у спидраннеров): портал → бастион → крепость. Пара (бастион, крепость) —
  // с меньшей суммой дорог; сокровищница — со штрафом. Второй бастион — ближний к первому и крепости.
  // Сокровищница: 0 из 3 попыток с золотом (02.10: map21-1, map23-1, mC23-1 — закрытым штреком 0 блоков) — только если других нет.
  // S1d 07.10: штраф сокровищницы 2000 → 600 и золото в цене (10 бл. пути за блок): 4120… — t31 в 143 бл. уступала мосту с 20
  // блоками в 843 (s1d-N-1: 10 мин хода), а в s1c сокровищница 4120… давала 90–116 слитков — больше всех; смерти там — у входа
  // (подход к гуще у брутов; теперь bastion.approachGold ведёт мимо их домов).
  const pen = b => (b.type === 'treasure' ? 600 : 0) - 10 * ((b.gold && b.gold.length) || 0)
  const d2 = (p, q) => Math.hypot(p.x - q.x, p.z - q.z)
  const okB = out.bastions.filter(b => b.gold && b.gold.length)
  let best = null
  for (const b of okB) for (const f of (fs2.length ? fs2 : [null])) {
    const c = b.dist + pen(b) + (f ? d2(b, f.spawner) : 0)
    if (!best || c < best.c) best = { c, b, f }
  }
  out.fortress = (best && best.f) || fs2[0] || null
  const F0 = out.fortress ? out.fortress.spawner : at
  const cost = b => b === (best && best.b) ? -1 : d2(best.b, b) + d2(b, F0) + pen(b)
  out.route = best ? { cost: Math.round(best.c), bastion: { x: best.b.x, z: best.b.z, type: best.b.type }, fortress: out.fortress ? { x: out.fortress.x, z: out.fortress.z } : null } : null
  okB.sort((a, b) => cost(a) - cost(b)).slice(0, bastions).forEach((b, i) => {
    // Запись — у ближнего к входу золота (туда кампания и bastion() ведут подход), золото и сундуки — по памяти.
    const g = b.gold.slice().sort((p, q) => Math.hypot(p.x - at.x, p.z - at.z) - Math.hypot(q.x - at.x, q.z - at.z))[0]
    out.places[keys[i]] = { x: g.x, y: g.y, z: g.z, dimension: 'the_nether', gold: b.gold.map(p => [p.x, p.y, p.z]), chests: b.chests.map(p => [p.x, p.y, p.z]), ...(b.bbAll ? { bb: b.bbAll } : {} as Record<string, any>), ...(b.brutes && b.brutes.length ? { brutes: b.brutes } : {} as Record<string, any>), note: `карта (копия мира): бастион ${b.type}, золотых блоков ${b.gold.length}` }
  })
  if (out.fortress) {
    const s = out.fortress.spawner
    out.places['крепость (ад)'] = { x: s.x, y: s.y, z: s.z, dimension: 'the_nether', note: 'карта (копия мира): крепость Ада, тронный зал' }
    out.places['спавнер блейзов'] = { x: s.x, y: s.y, z: s.z, dimension: 'the_nether', note: 'карта (копия мира): спавнер блейзов' }
  }
  return out
}

// Крепость Края (верхний мир) — для MAP_SH: /locate, NBT начала (куски; комната портала — shpr), рамки по комнате:
// сколько всего и сколько с оком (execute if block). Запись «крепость» — как после броска ока у лестницы (refined), но
// «лестница» — у боковой стены комнаты (отн. x 2, середина длины): шахта сверху попадает в комнату мимо лавы под
// порталом (отн. x 4..6, z 9..11, y 1 — StrongholdPieces.PortalRoom).
async function strongholdMap (slot, at) {
  if (!require('./src/perception/knowledge').allows('structures', 'try-lab-ne-map.strongholdMap')) return { error: `знание ${require('./src/perception/knowledge').level()}: крепость по /locate не читается` }
  const rcon = rconOf(slot)
  const r = await rcon(`execute in minecraft:overworld positioned ${at.x} 70 ${at.z} run locate structure minecraft:stronghold`)
  const m = /\[(-?\d+), [^,]+, (-?\d+)\]/.exec(r)
  if (!m) return { error: 'locate: ' + String(r).slice(0, 120) }
  const S = { x: Number(m[1]), z: Number(m[2]) }
  const read = chunkReader(slot, 'overworld')
  const st = await structureStart(rcon, read, 'stronghold', S.x, S.z, 'overworld')
  await rcon(`execute in minecraft:overworld run forceload remove ${Math.floor(S.x / 16) * 16} ${Math.floor(S.z / 16) * 16}`)
  if (!st) return { start: S, error: 'нет NBT начала' }
  const room = (st.Children || []).find(c => /shpr$/i.test(String(c.id)))
  if (!room || !Array.isArray(room.BB)) return { start: S, error: 'нет комнаты портала в NBT' }
  const [x1, y1, z1, x2, y2, z2] = room.BB
  await rcon(`execute in minecraft:overworld run forceload add ${x1} ${z1} ${x2} ${z2}`)
  for (let k = 0; k < 20; k++) {
    const q = await rcon(`execute in minecraft:overworld if loaded ${x1} ${y1} ${z1}`)
    const q2 = await rcon(`execute in minecraft:overworld if loaded ${x2} ${y2} ${z2}`)
    if (/passed/i.test(q) && /passed/i.test(q2)) break
    await sleep(1000)
  }
  const frames = []
  for (const y of [y1 + 3, y1 + 2, y1 + 4]) {
    for (let x = x1; x <= x2; x++) {
      for (let z = z1; z <= z2; z++) {
        const t = await rcon(`execute in minecraft:overworld if block ${x} ${y} ${z} minecraft:end_portal_frame`)
        if (!/passed/i.test(t)) continue
        const e = await rcon(`execute in minecraft:overworld if block ${x} ${y} ${z} minecraft:end_portal_frame[eye=true]`)
        frames.push({ x, y, z, eye: /passed/i.test(e) })
      }
    }
    if (frames.length) break
  }
  await rcon(`execute in minecraft:overworld run forceload remove ${x1} ${z1} ${x2} ${z2}`)
  const ex = x2 - x1; const ez = z2 - z1
  // Длинная ось комнаты — 16 (z отн.), короткая — 11 (x отн.): шахта — у стены по короткой оси, в середине длинной.
  const shaft = ex <= ez ? { x: x1 + 2, z: Math.round((z1 + z2) / 2) } : { x: Math.round((x1 + x2) / 2), z: z1 + 2 }
  const eyes = frames.filter(q => q.eye).length
  return { start: S, room: { bb: room.BB, center: { x: Math.round((x1 + x2) / 2), y: y1 + 3, z: Math.round((z1 + z2) / 2) } }, frames: frames.length, eyes, need: Math.max(0, frames.length - eyes), shaft,
    place: { x: shaft.x - 4, y: y2 + 1, z: shaft.z - 4, dimension: 'overworld', refined: true, note: `карта (копия мира): крепость Края, комната портала ${x1},${y1},${z1}..${x2},${y2},${z2}; рамок ${frames.length}, с оком ${eyes}` } }
}

// Сетка Ада по коридорам (03.10): прямоугольники rects [x1, z1, x2, z2] (Ад) → классы клеток (src/nether-grid.js) из
// регионов копии мира, y y1..y2. Чанки — forceload (генерация до FULL), save-all flush, пока каждый не станет full
// (до waitS с); не догрузившиеся — UNKNOWN. Итог — Grid и сводка; save — в memoryDir тела (nether-grid.bin/json).
async function netherGrid (slot, rects, { y1 = 8, y2 = 122, waitS = 150, log = () => {} }: any = {} as Record<string, any>) {
  if (!require('./src/perception/knowledge').allows('grid', 'try-lab-ne-map.netherGrid')) throw new Error(`знание ${require('./src/perception/knowledge').level()}: сетка Ада копии не читается`)
  const NG = require('./src/nether-grid')
  const rcon = rconOf(slot)
  const read = chunkReader(slot)
  const chunks = new Map()
  for (const [ax, az, bx, bz] of rects) {
    for (let cx = Math.floor(Math.min(ax, bx) / 16); cx <= Math.floor(Math.max(ax, bx) / 16); cx++) {
      for (let cz = Math.floor(Math.min(az, bz) / 16); cz <= Math.floor(Math.max(az, bz) / 16); cz++) chunks.set(`${cx},${cz}`, [cx, cz])
    }
  }
  const list = [...chunks.values()]
  const xs = list.map(c => c[0]); const zs = list.map(c => c[1])
  const box = [Math.min(...xs) * 16, y1, Math.min(...zs) * 16, Math.max(...xs) * 16 + 15, y2, Math.max(...zs) * 16 + 15]
  const grid = new NG.Grid(NG.headerOf(box))
  const t0 = gameClock.wall.now()
  // forceload — по прямоугольникам коридоров (≤ 256 чанков на команду).
  const fl = async add => {
    for (const [ax, az, bx, bz] of rects) {
      const cx1 = Math.floor(Math.min(ax, bx) / 16); const cx2 = Math.floor(Math.max(ax, bx) / 16)
      const cz1 = Math.floor(Math.min(az, bz) / 16); const cz2 = Math.floor(Math.max(az, bz) / 16)
      for (let cx = cx1; cx <= cx2; cx += 15) {
        for (let cz = cz1; cz <= cz2; cz += 15) {
          const ex = Math.min(cx2, cx + 14); const ez = Math.min(cz2, cz + 14)
          await rcon(`execute in minecraft:the_nether run forceload ${add ? 'add' : 'remove'} ${cx * 16} ${cz * 16} ${ex * 16} ${ez * 16}`)
        }
      }
    }
  }
  await fl(true)
  const done = new Set()
  for (let k = 0; gameClock.wall.now() - t0 < waitS * 1000 && done.size < list.length; k++) {
    await sleep(k ? 3000 : 1500)
    await rcon('save-all flush')
    for (const [cx, cz] of list) {
      const key = `${cx},${cz}`
      if (done.has(key)) continue
      const c = read(cx, cz)
      if (!c || !/full/.test(String(c.Status || '')) || !Array.isArray(c.sections)) continue
      for (const sec of c.sections) {
        const sy = Number(sec.Y)
        if (!Number.isFinite(sy) || sy * 16 + 15 < y1 || sy * 16 > y2) continue
        NG.decodeSection(sec, (x, y, z, cl) => { const wy = sy * 16 + y; if (wy >= y1 && wy <= y2) grid.setRaw(cx * 16 + x, wy, cz * 16 + z, cl) })
      }
      done.add(key)
    }
    log('сетка: чанков', { done: done.size, of: list.length, s: Math.round((gameClock.wall.now() - t0) / 1000) })
  }
  await fl(false)
  const counts: Record<string, any> = {} as Record<string, any>
  for (let i = 0; i < grid.data.length; i += 7) counts[NG.NAMES[grid.data[i]]] = (counts[NG.NAMES[grid.data[i]]] || 0) + 1
  return { grid, box, chunks: list.length, loaded: done.size, seconds: Math.round((gameClock.wall.now() - t0) / 1000), sample: counts }
}

// Коридоры маршрута: отрезки между точками (портал → бастион → спавнер → выход) с запасом m по бокам.
function corridorRects (points, m = 40) {
  const out = []
  for (let i = 0; i + 1 < points.length; i++) {
    const a = points[i]; const b = points[i + 1]
    if (!a || !b) continue
    const len = Math.hypot(b.x - a.x, b.z - a.z)
    // Длинный отрезок — кусками по 64 (иначе прямоугольник по диагонали — квадрат длины).
    const n = Math.max(1, Math.ceil(len / 64))
    for (let k = 0; k < n; k++) {
      const p = { x: a.x + (b.x - a.x) * k / n, z: a.z + (b.z - a.z) * k / n }
      const q = { x: a.x + (b.x - a.x) * (k + 1) / n, z: a.z + (b.z - a.z) * (k + 1) / n }
      out.push([Math.round(Math.min(p.x, q.x) - m), Math.round(Math.min(p.z, q.z) - m), Math.round(Math.max(p.x, q.x) + m), Math.round(Math.max(p.z, q.z) + m)])
    }
  }
  if (!out.length && points[0]) out.push([points[0].x - m, points[0].z - m, points[0].x + m, points[0].z + m])
  return out
}

module.exports = { netherMap, strongholdMap, locateAll, rconOf, chunkReader, netherGrid, corridorRects }

if (require.main === module && process.argv[2] === 'sh') {
  const [, slot, x, z] = process.argv.slice(2)
  strongholdMap(Number(slot), { x: Number(x), z: Number(z) }).then(m => console.log(JSON.stringify(m))).catch(e => { console.error(e); process.exit(1) })
} else if (require.main === module) {
  const [slot, x, z, nb] = process.argv.slice(2)
  netherMap(Number(slot), { x: Number(x), z: Number(z) }, { bastions: Number(nb || 2), log: (w, o) => console.log(w, JSON.stringify(o)) })
    .then(m => { console.log(JSON.stringify({ places: Object.fromEntries(Object.entries<any>(m.places).map(([k, v]: any) => [k, { ...v, gold: v.gold && v.gold.length, chests: v.chests && v.chests.length }])) })) })
    .catch(e => { console.error(e); process.exit(1) })
}
