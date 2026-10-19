'use strict'
// Арена (часть arena.ts): поле — стеклянная коробка или Колизей, потолок, барьерная оболочка под взрывчатку, свет,
// дыры, рельеф и уборка между раундами. Потолок, взрывчатку и модель Колизея выставляет вход — сеттерами в конце.
import * as gameClock from '../../src/game-clock'
import * as terrainMod from '../arena-terrain-random'
import { A, cmd } from './rpc'
import { sleep, log, NA, X, Y, Z, TP, FLOOR } from './config'

// Стиль (2026-09-26): classic — стеклянная коробка, как было; colosseum —
// Колизей вокруг поля (colosseum.js; строится один раз build-colosseum.js или
// здесь при первом запуске, флаг colosseum-built.json). В нём сдерживание
// поля — сплошной барьер от слоя пола до потолка по всему периметру: взрывы
// до силы 6 наружу не проходят (дно щели у стены и фундамент — обсидиан);
// потолок всегда (ARENA_CEIL=0 — снять); свет поля — светокамень вдоль x
// (взрыв выбивает — дыр больше) и плачущий обсидиан вдоль z (свет 10, не
// выбить); зритель — в пульвинаре на малой оси, лицом к полю.
const STYLE = process.env.ARENA_STYLE || 'classic'
const COLOS = STYLE === 'colosseum'
const CZ = COLOS ? (require('../colosseum') as typeof import('../colosseum')) : null
const CZB = COLOS ? (require('../build-colosseum') as typeof import('../build-colosseum')) : null
let CZM = null // модель Колизея: место зрителя, габарит для /kill мобов
let CZFP = null

// Потолок (mace.js, 2026-09-26): заряд ветра под ноги поднимает на 6–11
// блоков (замер probe-mace), «Порыв ветра» булавы — до 24, а стены 5 — бойцы
// вылетали бы из коробки в небе. Стекло до Y+CEIL_H−1 и невидимый барьер на
// Y+CEIL_H: голова на вершине взлёта (≤ Y+13) до него не достаёт. По
// умолчанию — только если в выбранных наборах есть заряды ветра или булава;
// ARENA_CEIL=0/1 — выключить/включить явно.
const CEIL_H = Number(process.env.ARENA_CEIL_H || 16)
let CEIL = false
const TOP = () => (CEIL ? Y + CEIL_H - 1 : Y + 4)
// Взрывчатка в наборах (boom.js, 2026-09-26: вагонетки с TNT, кристаллы):
// стекло стен (стойкость 0.3) взрыв выбивает — бойцы вылетали бы из коробки в
// небе. В классике за стеклом — оболочка из барьера (стойкость 3600000, не
// выбить, и не видно), от слоя пола до потолка; в Колизее сдерживание и так
// барьерное (colosseum.fieldCommands). Ставится, только если такие наборы
// выбраны (BLAST) — остальные арены как были.
let BLAST = false
async function blastShell () {
  if (!BLAST || COLOS) return
  const R = CLEAN_R + 2
  const T = CEIL ? Y + CEIL_H : TOP() + 1
  await cmd(`/fill ${X - R} ${Y - 1} ${Z - R} ${X + R} ${T} ${Z - R} minecraft:barrier`)
  await cmd(`/fill ${X - R} ${Y - 1} ${Z + R} ${X + R} ${T} ${Z + R} minecraft:barrier`)
  await cmd(`/fill ${X - R} ${Y - 1} ${Z - R} ${X - R} ${T} ${Z + R} minecraft:barrier`)
  await cmd(`/fill ${X + R} ${Y - 1} ${Z - R} ${X + R} ${T} ${Z + R} minecraft:barrier`)
  if (CEIL) await cmd(`/fill ${X - R} ${Y + CEIL_H} ${Z - R} ${X + R} ${Y + CEIL_H} ${Z + R} minecraft:barrier`)
}

async function buildArena () {
  await cmd(`${TP} ${NA} ${X} ${Y + 2} ${Z}`)
  await sleep(1500)
  // Уже стоит большая арена (arena-mobs) — свою коробку внутри не строим.
  if (process.env.ARENA_NOBUILD) return
  if (COLOS) {
    await ensureColosseum()
    await walls()
    await fillBox(X - CLEAN_R, Y - 1, Z - CLEAN_R, X + CLEAN_R, Y - 1, Z + CLEAN_R, FLOOR)
    return
  }
  const R = CLEAN_R
  await fillBox(X - R - 1, Y - 1, Z - R - 1, X + R + 1, TOP(), Z + R + 1, 'minecraft:glass hollow')
  await fillBox(X - R, Y - 1, Z - R, X + R, Y - 1, Z + R, FLOOR)
  await fillBox(X - R, TOP(), Z - R, X + R, TOP(), Z + R, 'minecraft:air')
  if (CEIL) await fillBox(X - R - 1, Y + CEIL_H, Z - R - 1, X + R + 1, Y + CEIL_H, Z + R + 1, 'minecraft:barrier')
  await blastShell()
}

// Колизей уже стоит? Читать блоки арена не умеет — верим флагу постройки
// (build-colosseum.js пишет его после проверки контрольных блоков). Нет флага
// (или другой R/версия модели) — строим сами, один раз: ~12 тыс. команд,
// минуты полторы-две; перед этим объём постройки (кроме поля) очищается.
async function ensureColosseum () {
  const f = CZB.readFlag({ X, Y, Z })
  if (CZB.flagMatches(f, { R: CLEAN_R })) { log(`Колизей уже стоит (флаг ${f.builtAt}) — не строю`); return }
  log(`Колизея у ${X} ${Y} ${Z} нет${f ? ` (флаг на R=${f.R}, версия ${f.version})` : ''} — строю один раз`)
  await CZB.run({ call: (m, p) => A.call(m, p), log, X, Y, Z, R: CLEAN_R, ceilH: CEIL_H, who: NA, rules: false, rate: Number(process.env.ARENA_COLOS_RATE || 150) })
}

// /fill берёт не больше 32768 блоков — большие объёмы режем по высоте.
async function fillBox (x1, y1, z1, x2, y2, z2, block) {
  const area = (Math.abs(x2 - x1) + 1) * (Math.abs(z2 - z1) + 1)
  const step = Math.max(1, Math.floor(32768 / area))
  for (let y = Math.min(y1, y2); y <= Math.max(y1, y2); y += step) {
    await cmd(`/fill ${x1} ${y} ${z1} ${x2} ${Math.min(Math.max(y1, y2), y + step - 1)} ${z2} ${block}`)
  }
}

// Сколько чистить вокруг центра: в большой арене (arena-mobs, R=30) бойцы
// разбегаются дальше 15, а столбы (побег от игрока) — до 6 блоков в высоту.
const CLEAN_R = Number(process.env.ARENA_R || 15)
// Рельеф (arena-terrain.js): ямы, лава, вода, высоты, укрытия — каждый раунд новый.
const TERRAIN = !!process.env.ARENA_TERRAIN
// Seed рельефа: ARENA_TERRAIN_SEED + номер раунда (повторяемо), иначе время.
const TERRAIN_SEED = process.env.ARENA_TERRAIN_SEED ? Number(process.env.ARENA_TERRAIN_SEED) : null
let terrainRound = 0

// Между раундами: убрать лаву, огонь, паутину, столбы и дроп, всё вернуть к ровному полу.
// Свет: ночью в коробке ничего не видно. Полосы светокамня в полу каждые 8
// блоков и пояс по стенам — десяток /fill вместо сотни /setblock.
// light — чем светить в полу: кристаллы (набор floor/light, 2026-09-30) выбивают
// светокамень (стойкость 0.3) — дыры в небо; плачущий обсидиан (1200) держит.
async function lightArena (light = 'glowstone') {
  if (COLOS) {
    for (const c of CZ.fieldLightCommands({ X, Y, Z, R: CLEAN_R })) await cmd(c)
    // Набор со своим светом (кристаллы, 2026-09-30): светокамень полос поля —
    // тот же свет из плачущего обсидиана. Под полем Колизея пусто до земли (~40
    // блоков), а ~50 взрывов за раунд выбили бы все полосы в дыры — опыт на
    // ферме: «сорвался в яму», назад не дошёл, раунд — ничья по застою. Только
    // пол поля (его арена и так ставит каждый раунд), постройка не трогается;
    // дыры ARENA_HOLES — как были.
    if (light && light !== 'glowstone') await cmd(`/fill ${X - CLEAN_R} ${Y - 1} ${Z - CLEAN_R} ${X + CLEAN_R} ${Y - 1} ${Z + CLEAN_R} minecraft:${light} replace minecraft:glowstone`)
    return
  }
  const R = CLEAN_R
  for (let d = -R + 4; d <= R - 4; d += 8) {
    await cmd(`/fill ${X + d} ${Y - 1} ${Z - R} ${X + d} ${Y - 1} ${Z + R} minecraft:${light}`)
    await cmd(`/fill ${X - R} ${Y - 1} ${Z + d} ${X + R} ${Y - 1} ${Z + d} minecraft:${light}`)
  }
  await cmd(`/fill ${X - R - 1} ${Y + 2} ${Z - R - 1} ${X + R + 1} ${Y + 2} ${Z - R - 1} minecraft:sea_lantern`)
  await cmd(`/fill ${X - R - 1} ${Y + 2} ${Z + R + 1} ${X + R + 1} ${Y + 2} ${Z + R + 1} minecraft:sea_lantern`)
  await cmd(`/fill ${X - R - 1} ${Y + 2} ${Z - R - 1} ${X - R - 1} ${Y + 2} ${Z + R + 1} minecraft:sea_lantern`)
  await cmd(`/fill ${X + R + 1} ${Y + 2} ${Z - R - 1} ${X + R + 1} ${Y + 2} ${Z + R + 1} minecraft:sea_lantern`)
}

// Стены чинить каждый раунд: люди ломали стекло посреди боя, и коробка
// переставала держать бойцов (арена в небе — выпавший летит полсотни блоков).
async function walls () {
  // Колизей: барьер от слоя пола до потолка по всему периметру, потолок,
  // дно щели — плачущий обсидиан (colosseum.fieldCommands).
  if (COLOS) { for (const c of CZ.fieldCommands({ X, Y, Z, R: CLEAN_R, ceilH: CEIL ? CEIL_H : TOP() - Y + 1, ceiling: CEIL })) await cmd(c); return }
  const R = CLEAN_R + 1
  const T = TOP()
  await cmd(`/fill ${X - R} ${Y - 1} ${Z - R} ${X + R} ${T} ${Z - R} minecraft:glass`)
  await cmd(`/fill ${X - R} ${Y - 1} ${Z + R} ${X + R} ${T} ${Z + R} minecraft:glass`)
  await cmd(`/fill ${X - R} ${Y - 1} ${Z - R} ${X - R} ${T} ${Z + R} minecraft:glass`)
  await cmd(`/fill ${X + R} ${Y - 1} ${Z - R} ${X + R} ${T} ${Z + R} minecraft:glass`)
  if (CEIL) await cmd(`/fill ${X - R} ${Y + CEIL_H} ${Z - R} ${X + R} ${Y + CEIL_H} ${Z + R} minecraft:barrier`)
  await blastShell()
}

// Дыры в полу (ARENA_HOLES=n, каждый раунд новые): арена в небе, и в дыру
// падают насмерть. Бойцы должны видеть край, обходить его и сбивать туда
// противника (просьба 2026-09-25). Места старта (X±6..8) и проход у стен не
// трогаем.
const HOLES = Number(process.env.ARENA_HOLES || 0)
async function holes () {
  const made = []
  const starts = [[X - 6, Z], [X + 6, Z], [X + 8, Z - 2], [X + 8, Z + 2]]
  for (let tries = 0; made.length < HOLES && tries < HOLES * 30; tries++) {
    const s = 2 + Math.floor(Math.random() * 2)
    const x = X - CLEAN_R + 3 + Math.floor(Math.random() * (2 * CLEAN_R - 5 - s))
    const z = Z - CLEAN_R + 3 + Math.floor(Math.random() * (2 * CLEAN_R - 5 - s))
    const near = (ax, az, gap) => ax >= x - gap && ax <= x + s - 1 + gap && az >= z - gap && az <= z + s - 1 + gap
    if (starts.some(([sx, sz]: any) => near(sx, sz, 4))) continue
    if (made.some(h => near(h.x, h.z, h.s + 3) || near(h.x + h.s - 1, h.z + h.s - 1, h.s + 3))) continue
    made.push({ x, z, s })
    await cmd(`/fill ${x} ${Y - 1} ${z} ${x + s - 1} ${Y - 1} ${z + s - 1} minecraft:air`)
  }
  if (made.length) log(`дыры в полу: ${made.map(h => `${h.x},${h.z} ${h.s}×${h.s}`).join('; ')}`)
}

// Дроп и стрелы — только внутри коробки: мир чужой, и /kill @e[type=item]
// без границ стирал бы вещи по всему миру.
const INSIDE = () => `x=${X - CLEAN_R - 1},y=${Y - 2},z=${Z - CLEAN_R - 1},dx=${2 * CLEAN_R + 2},dy=${CEIL ? CEIL_H + 2 : 16},dz=${2 * CLEAN_R + 2}`
const JUNK = ['item', 'arrow', 'spectral_arrow', 'trident', 'experience_orb', 'firework_rocket', 'wind_charge', 'ender_pearl', 'fishing_bobber', 'snowball', 'falling_block', 'tnt', 'tnt_minecart', 'end_crystal']
// Диких мобов — в Колизее по его габариту (фундамент — мачты): шар ..40 от
// центра не доставал до трибун, а вниз доставал до земли под ареной.
const MOBS_AT = () => COLOS && CZFP
  ? `x=${CZFP.x0},y=${CZFP.y0 - 1},z=${CZFP.z0},dx=${CZFP.x1 - CZFP.x0},dy=${CZFP.y1 - CZFP.y0 + 2},dz=${CZFP.z1 - CZFP.z0}`
  : `x=${X},y=${Y},z=${Z},distance=..40`

// kit.floor / kit.light — пол и свет набора (кристаллы: обсидиан — кристалл
// ставится везде, взрыв не пробивает; свет — плачущий обсидиан). В Колизее
// свет его собственный (colosseum.js), пол — набора.
async function resetArena (kit: any = {} as Record<string, any>) {
  const floor = kit.floor ? 'minecraft:' + kit.floor : FLOOR
  if (TERRAIN) {
    await terrainMod.clearTerrain(cmd, fillBox, { X, Y, Z, R: CLEAN_R, top: TOP() })
    const seed = TERRAIN_SEED != null ? TERRAIN_SEED + terrainRound++ : (gameClock.wall.now() >>> 0)
    const features = await terrainMod.buildTerrain(cmd, { X, Y, Z, R: CLEAN_R, seed, avoid: [[X - 6, Z], [X + 6, Z]], canopies: Number(process.env.ARENA_CANOPY || 0) })
    const kinds: Record<string, any> = {} as Record<string, any>
    for (const f of features) kinds[f.kind] = (kinds[f.kind] || 0) + 1
    log(`рельеф (seed ${seed}): ` + Object.entries<any>(kinds).map(([k, v]: any) => `${k}×${v}`).join(', '))
    // Стены — как без рельефа (раньше рельеф их пропускал: стекло, выбитое в
    // прошлом раунде, не чинилось). Свет полосами в полу залил бы ямы — без
    // него: на арене день стоит (/time set day, do_daylight_cycle false).
    if (!process.env.ARENA_NOBUILD) await walls()
  } else {
    await fillBox(X - CLEAN_R, Y, Z - CLEAN_R, X + CLEAN_R, Math.max(Y + 8, TOP()), Z + CLEAN_R, 'minecraft:air')
    await fillBox(X - CLEAN_R, Y - 1, Z - CLEAN_R, X + CLEAN_R, Y - 1, Z + CLEAN_R, floor)
    // Под полом из обсидиана — второй слой: взрыв у стыка с плачущим обсидианом
    // и стеклом стены не оставит дыры в небо. В Колизее под полем свой
    // фундамент из обсидиана (colosseum.js, dy −2) — его не трогаем.
    // kit.sub — слой под полом явно (по умолчанию под обсидиановым полом —
    // обсидиан). Пол из камня для кристаллов не годится: основа на уровне его
    // ног закрывает ему низ, кристалл берёт ~1.7 (crystal.test.js).
    const sub = kit.sub || (kit.floor === 'obsidian' ? 'obsidian' : null)
    if (sub && !COLOS) await fillBox(X - CLEAN_R - 1, Y - 2, Z - CLEAN_R - 1, X + CLEAN_R + 1, Y - 2, Z + CLEAN_R + 1, 'minecraft:' + sub)
    if (!process.env.ARENA_NOBUILD) await walls()
    await lightArena(kit.light)
    await holes()
  }
  // Дроп, снаряды и взрывчатка прошлого раунда — все, по всему Колизею (трибуны тоже): пользователь 09.10 —
  // вещи копились раунд за раундом и тормозили игру; ракеты, трезубцы, жемчуг раньше оставались.
  for (const t of JUNK) await cmd(`/kill @e[type=${t},${COLOS && CZFP ? MOBS_AT() : INSIDE()}]`)
  // Под крышей темно — ночью внутри спавнятся дикие мобы и мешают дуэли.
  for (const t of ['zombie', 'husk', 'skeleton', 'stray', 'creeper', 'spider', 'cave_spider', 'witch', 'enderman', 'zombie_villager', 'drowned', 'slime', 'phantom']) {
    await cmd(`/kill @e[type=${t},${MOBS_AT()}]`)
  }
}

function setCeil (v) { CEIL = v }
function setBlast (v) { BLAST = v }
function setCZM (v) { CZM = v }
function setCZFP (v) { CZFP = v }

export { COLOS, CZ, CZM, CZFP, CEIL_H, CEIL, TOP, BLAST, CLEAN_R, buildArena, resetArena, setCeil, setBlast, setCZM, setCZFP }
