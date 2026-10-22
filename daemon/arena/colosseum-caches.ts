'use strict'
// Тайники в толще Колизея (пользователь 21.10): каждый раунд 2–3 сундука с «ультра-ценным» прячутся прямо в стенах,
// засыпке рядов и ярусах, вплоть до самого верха. Сундук не на открытом месте: все 6 соседних клеток — полные непрозрачные
// блоки, снаружи его не видно; найти — только вскрыв толщу (рой: daemon/src/swarm/cache-model, драйвер — caches.ts).
// Место — случайное на раунд (зерно карты + номер раунда), по полосам высоты: низ, середина, верх. Содержимое — несколько
// вещей, каждая меняет ход боя: оружие и броня с чарами сверх ванили (до 30 уровня), трезубец, зелья вреда-ваншота, скорости,
// прыжка, силы и регенерации высоких уровней, зачарованные золотые яблоки, тотем.
// Генератор знает раскладку (он её и строит); боты знают только правило «в стенах спрятано 2–3 тайника».
import * as C from './colosseum'

export type Cache = { x: number; y: number; z: number; facing: string; was: string; items: string[] }
type Cell = { x: number; y: number; z: number; was: string }

// Полный куб, но сквозь него видно или он не «камень стены»: такой сосед выдаёт тайник, такую клетку не занимаем.
const SEE = /glass|^barrier$|ice$|leaves|^light$|slime|honey|spawner|^water$|^lava$/
// Клетка самого тайника — только из «тела» постройки (не светильник, не мебель, не облицовка ниши).
const BODY = /sandstone|quartz|stone|brick|terracotta|concrete|deepslate|tuff|calcite|andesite|diorite|granite|smooth_/

function rng (seed: string) {
  let h = [...String(seed)].reduce((a, ch) => (a * 31 + ch.charCodeAt(0)) >>> 0, 7)
  return () => { h = (h * 1664525 + 1013904223) >>> 0; return h / 4294967296 }
}

// Мир раунда без тайников: модель постройки + раскладка гонки (поле, камеры, сундуки), как кладёт её restoreArena.
function worldGrid (L: any) {
  const m = C.model({ R: 24, ceilH: 16 })
  for (const [x, y, z, b] of [...L.field, ...L.set]) m.g.set(x, y, z, b === 'air' ? '' : String(b).replace(/\{.*$/, ''))
  return m
}

const memo = new Map<string, { cells: Cell[]; bands: Cell[][] }>()
// Все клетки, где может стоять тайник (по карте — один раз): 6 соседей сплошные, не поле, не у сундуков раскладки (над
// сундуком раскладка кладёт плиту — сосед перестал бы быть сплошным; облицовку ниш ломают — тайник за ней открылся бы сразу).
export function cacheCells (L: any): { cells: Cell[]; bands: Cell[][] } {
  const key = `${L.seed}:${L.map}`
  const hit = memo.get(key); if (hit) return hit
  const { g, p } = worldGrid(L)
  const near = new Set<string>()
  for (const c of L.chests || []) {
    for (const v of [c, ...(c.cover || [])]) for (let dx = -2; dx <= 2; dx++) for (let dy = -2; dy <= 2; dy++) for (let dz = -2; dz <= 2; dz++) near.add(`${v.x + dx},${v.y + dy},${v.z + dz}`)
  }
  const solid = (x, y, z) => { const b = g.get(x, y, z); return !!b && C.isFullCube(b) && !SEE.test(C.parse(b).name) }
  const cells: Cell[] = []
  for (let y = Math.max(0, g.y0 + 1); y < g.y1; y++) for (let x = g.x0 + 1; x < g.x1; x++) for (let z = g.z0 + 1; z < g.z1; z++) {
    if (Math.abs(x) <= L.R + 1 && Math.abs(z) <= L.R + 1) continue // поле — его рельеф меняется, и это не «толща Колизея»
    const b = g.get(x, y, z)
    if (!b || !BODY.test(C.parse(b).name) || !solid(x, y, z)) continue
    if (!solid(x + 1, y, z) || !solid(x - 1, y, z) || !solid(x, y + 1, z) || !solid(x, y - 1, z) || !solid(x, y, z + 1) || !solid(x, y, z - 1)) continue
    if (C.foot(p.A1, p.B1, x, z).n < 0 || near.has(`${x},${y},${z}`)) continue
    cells.push({ x, y, z, was: b })
  }
  // Полосы высоты: низ (ярус песка и террасы), середина (ряды и пояса), верх (галерея 4, крыша, венец).
  const bands = [cells.filter(c => c.y <= 9), cells.filter(c => c.y >= 10 && c.y <= 21), cells.filter(c => c.y >= 22)]
  const out = { cells, bands }
  memo.set(key, out)
  return out
}

// Вещи тайника: оружие и броня сверх ванили, зелья высоких уровней, яблоки, тотем. k — номер тайника в раунде (первому —
// трезубец, чтобы он был в каждом раунде), остальное — по зерну. 4–7 предметов: сундук не забит, каждая вещь меняет бой.
export function cacheLoot (rnd: () => number, k: number): string[] {
  const pick = <T>(a: T[]): T => a[Math.floor(rnd() * a.length)]
  const lv = (lo: number, hi: number) => lo + Math.floor(rnd() * (hi - lo + 1))
  const ub = `unbreaking:${lv(5, 10)}`
  const weapons = [
    () => [`trident[enchantments={sharpness:${lv(15, 30)},loyalty:3,impaling:${lv(10, 20)},${ub}}] 1`],
    () => [`netherite_sword[enchantments={sharpness:${lv(20, 30)},fire_aspect:${lv(2, 4)},knockback:${lv(2, 3)},${ub}}] 1`],
    () => [`netherite_axe[enchantments={sharpness:${lv(20, 30)},efficiency:${lv(8, 10)},${ub}}] 1`],
    () => [`mace[enchantments={density:${lv(15, 25)},breach:${lv(5, 8)},wind_burst:3,${ub}}] 1`, 'wind_charge 16'],
    () => [`bow[enchantments={power:${lv(20, 30)},punch:${lv(2, 3)},flame:1,infinity:1,${ub}}] 1`, 'arrow 1']
  ]
  const armor = (piece: string) => `netherite_${piece}[enchantments={protection:${lv(20, 30)},${ub}${piece === 'boots' ? `,feather_falling:${lv(8, 12)}` : piece === 'chestplate' ? `,thorns:${lv(3, 5)}` : ''}}] 1`
  // Основа зелья — та, по которой бой узнаёт его (strong_harming — бросить во врага, strong_swiftness/strength — выпить
  // перед боем); сверху — свой эффект высокого уровня (вред X — ваншот без тотема).
  const fx = (kind: string, base: string, id: string, amp: number, sec: number, n: number) =>
    `${kind}[potion_contents={potion:"minecraft:${base}",custom_effects:[{id:"minecraft:${id}",amplifier:${amp},duration:${sec * 20}}]}] ${n}`
  const potions = [
    () => fx('splash_potion', 'strong_harming', 'instant_damage', lv(6, 9), 1, lv(1, 2)),
    () => fx('potion', 'strong_swiftness', 'speed', lv(4, 6), 180, 1),
    () => fx('potion', 'strong_leaping', 'jump_boost', lv(3, 4), 180, 1),
    () => fx('potion', 'strong_strength', 'strength', lv(5, 9), 120, 1),
    () => fx('potion', 'strong_regeneration', 'regeneration', lv(3, 5), 60, 1)
  ]
  const items: string[] = []
  items.push(...(k === 0 ? weapons[0] : pick(weapons))())
  items.push(armor(pick(['helmet', 'chestplate', 'leggings', 'boots'])))
  if (rnd() < 0.4) items.push(armor(pick(['helmet', 'chestplate', 'leggings', 'boots'])))
  const pots = new Set<number>()
  for (let n = 1 + (rnd() < 0.5 ? 1 : 0); pots.size < n;) pots.add(Math.floor(rnd() * potions.length))
  for (const j of pots) items.push(potions[j]())
  items.push(k % 2 ? 'totem_of_undying 1' : `enchanted_golden_apple ${lv(1, 2)}`)
  if (rnd() < 0.3) items.push(k % 2 ? 'enchanted_golden_apple 1' : 'totem_of_undying 1')
  return [...new Set(items)].slice(0, 7)
}

// Тайники раунда: 2–3 (зерно), каждый — в своей полосе высоты (три — по одному в низу, середине и верху), друг от друга
// по горизонтали не ближе 16 бл. — разные сектора толщи.
export function pickCaches (L: any, round: number, { n = 0 }: { n?: number } = {}): Cache[] {
  const { bands } = cacheCells(L)
  const rnd = rng(`${L.seed}:cache:${round}`)
  const count = n || (rnd() < 0.5 ? 2 : 3)
  const order = [0, 1, 2].sort(() => rnd() - 0.5).filter(b => bands[b].length)
  const out: Cache[] = []
  for (let k = 0; k < count && order.length; k++) {
    const band = bands[order[k % order.length]]
    for (let tries = 0; tries < 200; tries++) {
      const c = band[Math.floor(rnd() * band.length)]
      if (out.some(o => Math.hypot(o.x - c.x, o.z - c.z) < 16)) continue
      out.push({ x: c.x, y: c.y, z: c.z, facing: ['north', 'east', 'south', 'west'][Math.floor(rnd() * 4)], was: c.was, items: [] })
      break
    }
  }
  out.forEach((c, k) => { c.items = cacheLoot(rnd, k) })
  return out
}
