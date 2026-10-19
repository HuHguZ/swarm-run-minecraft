'use strict'
const Vec3: typeof import('vec3').Vec3 = require('vec3')
import { xyz } from '../movement'
import { FILLER } from '../build'
import * as bp from '../blueprint'
import { k3 } from './world'

// ---------------------------------------------------------------- palette

const hasName = mcData => n => !!(mcData.blocksByName[n] || mcData.itemsByName[n])

// Материал «auto»: то, чего в запасе больше всего. Дерево считается досками —
// бревно стоит четырёх.
function autoMaterial (stock, kind) {
  const woods = bp.WOODS.map(w => ({ m: w, n: (stock[`${w}_planks`] || 0) + 4 * ((stock[`${w}_log`] || 0) + (stock[`${w}_stem`] || 0)) }))
  const stones = bp.STONES.map(s => ({ m: s, n: stock[s] || 0 }))
  const loose = kind === 'hut' ? ['dirt', 'coarse_dirt', 'netherrack', 'sand'].map(s => ({ m: s, n: stock[s] || 0 })) : []
  let pool = [...woods, ...stones, ...loose]
  if (kind === 'castle' && stones.some(s => s.n > 0)) pool = stones
  const best = pool.sort((a, b) => b.n - a.n)[0]
  if (best && best.n > 0) return best.m
  return kind === 'castle' ? 'cobblestone' : kind === 'hut' ? 'dirt' : 'oak'
}

// Роли палитры, которые решает запас, а не материал: дверь, стекло, свет,
// заделка, табличка, лестница. Подмена — только когда предмета нет СОВСЕМ:
// если его есть хоть сколько-то, значит его и хотели, и нехватка — это отказ
// сметы с числом, а не тихая замена.
function resolvePalette (mcData, p, kind, stock) {
  const has = hasName(mcData)
  const asked = p.material && String(p.material).toLowerCase() !== 'auto' ? String(p.material).toLowerCase() : null
  const material = asked || autoMaterial(stock, kind)
  const pal = bp.palette(material, has)
  const subs = []
  const got = n => (n ? stock[n] || 0 : 0)
  const fallback = p.fallback !== false
  const anyOf = re => Object.keys(stock).filter(n => re.test(n) && stock[n] > 0).sort((a, b) => stock[b] - stock[a])[0] || null

  if (pal.stairs && !got(pal.stairs) && fallback) {
    subs.push({ key: 'stairs', role: 'крыша', wanted: pal.stairs, used: pal.roofFill, why: 'ступеней нет совсем — крыша уступами из полного блока' })
    pal.stairs = null
  }
  if (pal.slab && !got(pal.slab) && fallback) {
    subs.push({ key: 'slab', role: 'конёк', wanted: pal.slab, used: pal.roofFill, why: 'плит нет — конёк полным блоком' })
    pal.slab = null
  }
  if (pal.frame !== pal.main && !got(pal.frame)) {
    subs.push({ key: 'frame', role: 'каркас', wanted: pal.frame, used: pal.main, why: 'брёвен нет — углы тем же, что стены' })
    pal.frame = pal.main
  }
  // Дверь: своей породы, любая из рюкзака, иначе проём.
  const door = got(pal.door) ? pal.door : anyOf(/_door$/)
  if (p.door === false) pal.door = null
  else if (door) pal.door = door
  else {
    subs.push({ key: 'door', role: 'дверь', wanted: pal.door, used: null, why: 'двери нет — оставлю проём (oak_door: 6 досок на 3 двери)' })
    pal.door = null
  }
  // Окна: панель, стекло, иначе глухая стена (дыра 1×1 пропускает детёныша зомби).
  if (p.windows === false) pal.window = null
  else if (got('glass_pane')) pal.window = 'glass_pane'
  else if (got('glass')) pal.window = 'glass'
  else {
    pal.window = null
    subs.push({ key: 'window', role: 'окна', wanted: 'glass_pane', used: pal.main, why: 'стекла нет — окна заложены стеной' })
  }
  // Свет.
  pal.light = ['torch', 'lantern', 'soul_torch', 'soul_lantern'].find(n => got(n)) || null
  if (!pal.light && p.light !== false) subs.push({ key: 'light', role: 'свет', wanted: 'torch', used: null, why: 'факелов нет — внутри будет темно, мобы могут появиться' })
  // Заделка дыр и фундамент — дешёвым, если он есть, а не материалом стен.
  const fillers = FILLER.filter(n => !/^(sand|gravel)$/.test(n)).map(n => ({ n, c: got(n) })).sort((a, b) => b.c - a.c)
  pal.fill = p.fill || (fillers[0] && fillers[0].c > 0 ? fillers[0].n : pal.main)
  // Табличка, лестница, кровать.
  pal.sign = got(pal.sign) ? pal.sign : (anyOf(/_sign$/) || pal.sign)
  pal.ladder = got('ladder') ? 'ladder' : null
  pal.bed = anyOf(/_bed$/) || 'red_bed'
  return { pal, subs, material }
}

// ---------------------------------------------------------------- plan

function cleanParams (p) {
  const out = {}
  for (const [k, v] of (Object.entries(p || {}) as [string, any][])) if (v !== undefined && v !== null) out[k] = v
  return out
}

// Во что просили: готовый kind или свой план частями.
function makeParts (session, p, stock) {
  const kind = p.plan ? 'plan' : String(p.kind || 'house').toLowerCase()
  if (kind === 'plan') {
    const parts = Array.isArray(p.plan) ? p.plan : p.plan.parts
    return { kind, parts, pal: null, subs: [], material: null, labels: null }
  }
  const spec = bp.KINDS[kind]
  if (!spec) throw new Error(`не знаю постройку «${p.kind}»: ${Object.keys(bp.KINDS).join(', ')} или свой plan`)
  const { pal, subs, material } = resolvePalette(session.mcData, p, kind, stock)
  if (kind === 'storage') {
    const sorting: typeof import('../sorting') = require('../sorting')
    const labels = sorting.labelsFor(session, p.categories, stock)
    return { kind, parts: bp.storage(p, pal, labels), pal, subs: subs.filter(x => spec.roles.includes(x.key)), material, labels }
  }
  return { kind, parts: spec.make(p, pal), pal, subs: subs.filter(x => !spec.roles || spec.roles.includes(x.key)), material, labels: null }
}

// Мировые клетки: layout (поворот + прижатие к углу) плюс origin.
function place (layout, origin) {
  const cells = layout.rel.map(c => {
    const pos = new Vec3(origin.x + c.x, origin.y + c.y, origin.z + c.z)
    return { ...c, pos, key: k3(pos), pair: c.pair ? (() => { const [x, y, z] = c.pair.split(',').map(Number); return `${origin.x + x},${origin.y + y},${origin.z + z}` })() : undefined }
  })
  // Проём двери вынимается в самом начале, вместе с прочей землёй: дверь
  // ставится последней, а до того проём — единственный вход. В землянке он
  // был полон земли, и тело копало комнату снаружи сквозь стену, а заднюю
  // стенку так и не достало. Готово — когда там воздух или уже сама дверь.
  for (const c of cells.filter(c => c.kind === 'door' || (c.kind === 'part' && /_door$/.test(c.name)))) {
    cells.push({ x: c.x, y: c.y, z: c.z, pos: c.pos, key: `${c.key}:проём`, name: 'air', kind: 'air', allow: c.name, phase: bp.PHASE.clear, role: 'doorway', part: c.part })
  }
  return cells
}

function boxOf (cells) {
  const b = { x1: Infinity, y1: Infinity, z1: Infinity, x2: -Infinity, y2: -Infinity, z2: -Infinity }
  for (const c of cells) {
    if (c.kind === 'seal' && c.role === 'foundation') continue
    b.x1 = Math.min(b.x1, c.pos.x); b.y1 = Math.min(b.y1, c.pos.y); b.z1 = Math.min(b.z1, c.pos.z)
    b.x2 = Math.max(b.x2, c.pos.x); b.y2 = Math.max(b.y2, c.pos.y); b.z2 = Math.max(b.z2, c.pos.z)
  }
  return b
}

// Относительная клетка канонического (фасад на юг) плана после того же
// поворота и сдвига, что сделал layout: нужна, чтобы привязать вход к месту.
function relOf (layout, parts, has, cx, cz) {
  const steps = layout.steps
  let x = cx; let z = cz
  for (let i = 0; i < steps; i++) [x, z] = [-z, x]
  // bounds до сдвига — пересчитываем по той же компиляции
  const raw = bp.rotateCells(bp.compileParts(parts, has), steps)
  const b = bp.bounds(raw)
  return { x: x - b.x1, z: z - b.z1 }
}

// ---------------------------------------------------------------- sites

function cardinalTo (from, to) {
  const dx = to.x - from.x; const dz = to.z - from.z
  if (Math.abs(dx) > Math.abs(dz)) return dx > 0 ? 'east' : 'west'
  return dz > 0 ? 'south' : 'north'
}

function facingOf (bot) {
  // Куда смотрит тело — сторона света по yaw.
  const y = ((bot.entity.yaw % (2 * Math.PI)) + 2 * Math.PI) % (2 * Math.PI)
  const i = Math.round(y / (Math.PI / 2)) % 4
  return ['north', 'west', 'south', 'east'][i]
}

// Подпись заказа: по ЗАПРОШЕННОМУ материалу, не по выбранному. «auto» после
// половины дома выбрал бы другое дерево (доски-то ушли в стены), и повтор
// перестал бы узнавать свой же дом.
function sigOf (kind, p) {
  const pick = ['width', 'depth', 'height', 'roof', 'furnish', 'double', 'categories', 'door', 'windows', 'front']
  const o: any = { kind, material: p.material ? String(p.material).toLowerCase() : 'auto' }
  for (const k of pick) if (p[k] !== undefined) o[k] = p[k]
  if (kind === 'plan') o.plan = p.plan
  return JSON.stringify(o)
}

// Где вход: клетка двери, а без неё — нижняя клетка проёма или ворот.
function entranceOf (cells) {
  const door = cells.find(c => c.kind === 'door')
  if (door) return xyz(door.pos)
  const way = cells.filter(c => c.role === 'doorway' || c.role === 'gate').sort((a, b) => a.pos.y - b.pos.y)[0]
  return way ? xyz(way.pos) : undefined
}

export {
  hasName, autoMaterial, resolvePalette, cleanParams, makeParts, place, boxOf, relOf, cardinalTo, facingOf,
  sigOf, entranceOf
}
