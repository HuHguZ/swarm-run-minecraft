'use strict'
// Блочный клатч (clutch.ts) — блоки и решение: чем ставить, что можно заменить, пересечение клетки с телом, выбор
// блока из хотбара, решение «вода / клатч / ничего» и копия состояния физики для прогноза. Чистые функции.

const IDLE = Object.freeze({ forward: false, back: false, left: false, right: false, jump: false, sprint: false, sneak: false })
const FILLER = /^(cobblestone|cobbled_deepslate|dirt|netherrack|stone|deepslate|andesite|diorite|granite|tuff|blackstone|nether_bricks|basalt|obsidian|crying_obsidian|[a-z_]+_planks)$/
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

export { IDLE, FILLER, REPLACE, INTERACTIVE, key, replaceable, othersOf, occupied, fullReference, blockReference, intersects, selectBlock, selectOf, decide, copyState }
