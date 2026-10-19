'use strict'
import { seesBlock } from '../sight'
import { countOf } from '../items'
import { canSeePoint, eyePos, raySees } from '../perception'

// 12 рамок портала в Край, каждая с оком с шансом 10% (PortalRoom:
// nextFloat() > 0.9) — в худшем случае нужны все 12; плюс броски при поиске
// крепости: око разбивается в 20% (EyeOfEnder surviveAfterDeath = nextInt(5) > 0).
const EYES_WANTED = 14
const SPAWNER_PLACE = 'спавнер блейзов'

function clamp (v, lo, hi) { return Math.max(lo, Math.min(hi, v)) }
// Ход боя — в лог демона: отчёт намерения, оборванного смертью, до мозга не
// доезжает, а разбирать, где именно ушли хп, надо.
// Время (ЧЧ:ММ:СС) — для разбора, куда ушли минуты этапа (dev-F 02.10).
const log = (what, o) => console.log('[blaze]', new Date().toTimeString().slice(0, 8), what, JSON.stringify(o))

// Сколько стержней не хватает на EYES_WANTED око с тем, что уже есть: оки,
// порошок и стержни (по два ока с каждого).
function rodsShort (bot, eyesWanted = EYES_WANTED) {
  const eyes = countOf(bot, 'ender_eye')
  const powder = countOf(bot, 'blaze_powder')
  const rods = countOf(bot, 'blaze_rod')
  return Math.max(0, Math.ceil(Math.max(0, eyesWanted - eyes - powder) / 2) - rods)
}

// От глаз до ближайшей точки хитбокса — так сервер меряет удар.
function reachTo (bot, e) {
  const eye = eyePos(bot)
  const w = (e.width || 0.6) / 2
  const h = e.height || 1.8
  const p = e.position
  const cx = clamp(eye.x, p.x - w, p.x + w)
  const cy = clamp(eye.y, p.y, p.y + h)
  const cz = clamp(eye.z, p.z - w, p.z + w)
  return Math.hypot(eye.x - cx, eye.y - cy, eye.z - cz)
}

const seesMob = (bot, e) => canSeePoint(bot, e.position.offset(0, (e.height || 1.8) * 0.55, 0))
// S1f (аудит S10 №20): ифриты, стержни и стрелы — только известные телу (видимые/слышимые: eyes.knownEntities), не все сущности слежения.
const ents = (bot): any[] => (require('../perception/eyes') as typeof import('../perception/eyes')).knownEntities(bot)

// Живой блейз в радиусе: сначала видимые, потом ближайшие.
function nearestBlaze (bot, radius, dead) {
  const me = bot.entity.position
  const list = ents(bot).filter((e : any) => e && e.name === 'blaze' && e.position && e.isValid !== false &&
    !dead.has(e.id) && e.position.distanceTo(me) <= radius)
  if (!list.length) return null
  list.sort((a: any, b: any) => (Number(seesMob(bot, b)) - Number(seesMob(bot, a))) || (a.position.distanceTo(me) - b.position.distanceTo(me)))
  return list[0]
}

// Спавнер, который ВИДНО (fairPlay: луч от глаз). Спавнер за стеной честно не
// замечен — его может назвать память.
function visibleSpawner (bot, mcData, radius = 32) {
  const id = mcData.blocksByName.spawner.id
  const found = bot.findBlocks({ matching: [id], maxDistance: radius, count: 16 })
  const me = bot.entity.position
  found.sort((a, b) => a.distanceTo(me) - b.distanceTo(me))
  for (const p of found) {
    const b = bot.blockAt(p)
    if (b && seesBlock(bot, b)) return p
  }
  return null
}

// reachable — только те, за которыми collectRods пойдёт (не ниже 3 блоков под
// ногами, не у лавы). Иначе бой крутил «вылазку» без единого await на таймере —
// 7 млн оборотов за попытку, тело замирало под шарами (лаборатория, замер 10).
function droppedRods (bot, radius = 12, { reachable = false }: any = {}) {
  const me = bot.entity.position
  let n = 0
  for (const e of ents(bot)) {
    if (!e || e.name !== 'item' || !e.position || e.position.distanceTo(me) > radius) continue
    if (reachable && (e.position.y < me.y - 3 || lavaNear(bot, e.position))) continue
    try {
      const it = e.getDroppedItem && e.getDroppedItem()
      if (it && it.name === 'blaze_rod') n += it.count
    } catch {}
  }
  return n
}

const isRod = e => { try { const it = e.getDroppedItem && e.getDroppedItem(); return !!it && it.name === 'blaze_rod' } catch { return false } }

// Подобрать именно стержни. Общий подбор (actions.collectNearbyDrops) идёт к
// ближайшему предмету любого рода и застревал на чужой куче: сцена (в) простояла
// 125 с, а стержень так и остался лежать рядом.
// Лава рядом с точкой (в 3 блоках по x/z, от 2 ниже до 1 выше): за стержнем у
// лавопада тело шло к лаве (замер 3: «tried to swim in lava to escape Blaze»).
function lavaNear (bot, p, r = 3) {
  const lava = bot.registry.blocksByName.lava.id
  const c = p.floored()
  for (let x = -r; x <= r; x++) for (let y = -2; y <= 1; y++) for (let z = -r; z <= r; z++) {
    const b = bot.blockAt(c.offset(x, y, z))
    if (b && b.type === lava) return true
  }
  return false
}

// Свои стрелы на полу (мимо блейза — в пол и стены): подобрать в вылазке.
// Стрела в земле неподвижна; брать те, что не выше 1.6 над полом и не у лавы.
function arrowsOnFloor (bot, radius = 14) {
  const me = bot.entity.position
  return ents(bot).filter((e : any) => e && e.name === 'arrow' && e.position && e.isValid !== false &&
    e.position.distanceTo(me) <= radius && e.position.y >= me.y - 3 && e.position.y <= me.y + 2.5 &&
    (!e.velocity || Math.hypot(e.velocity.x, e.velocity.y, e.velocity.z) < 0.01) && !lavaNear(bot, e.position, 2))
}

// Отдышаться: за угол, поесть, ждать хп. Возвращает, что вышло.
// Ифрит, которого знает игрок: виден лучом или слышен (дыхание/залп ифрита — звук сущности, слышен в 16 бл.: дальность звука по
// умолчанию, SoundEvent.createVariableRangeEvent 1.21.11). Дальше 16 — только видимые (замечание проверки 06.10: как у игрока).
const BLAZE_HEAR = 16
function liveBlazes (bot, dead, radius = 48) {
  // Своё честное правило (слух 16 / видимые) — без eyes.knownEntities.
  return (Object.values(bot.entities) as any[]).filter((e : any) => e && e.name === 'blaze' && e.position && e.isValid !== false &&
    !dead.has(e.id) && e.position.distanceTo(bot.entity.position) <= radius && (e.position.distanceTo(bot.entity.position) <= BLAZE_HEAR || seesMob(bot, e)))
}

// Сколько блейзов видят нас сейчас (луч от их глаз до наших).
function watchers (bot, dead) {
  const eye = bot.entity.position.offset(0, 1.62, 0)
  return liveBlazes(bot, dead, 40).filter((b : any) => raySees(bot, b.position.offset(0, 1.2, 0), eye)).length
}

// Ближний бой со щитом: щит к нему всё время, взмах — сразу после его удара в
// щит (звук блока: у моба перезарядка 20 тиков, наш щит снова держит через 5)
// или если он молчит 1.2 с. Замер 11: combat.fight (pvp.duel) держал щит
// опущенным — иссушитель добил с 8 хп двумя ударами под огнём.
// Нейтральный на линии стрельбы: стрела мимо блейза (или сквозь него) попадёт в зомби-пиглина — и злится вся стая
// (ZombifiedPiglin.alertOthers). neF-fort25-3 02.10: лук под огнестойкостью, 4 удара по 4.8 от зомби-пиглинов за 6 с,
// смерть на 9-м убитом блейзе. Отрезок глаз → цель и чуть за неё (промах летит дальше), коридор 1.6 бл.
// Взмах меча с полным откатом на земле — размашистый удар (Player.attack: всем живым в рамке цели, раздутой на 1/0.25/1, в 3 бл.
// от нас — 1 урона): зомби-пиглин рядом с ифритом получает удар от игрока и злит всю группу (s1-post30/31 06.10: смерть от
// зомбифицированных пиглинов у спавнера). Нейтрал вплотную к цели — не бить, щит.
function sweepRisk (bot, e) {
  const me = bot.entity.position
  return (Object.values(bot.entities) as any[]).some((o: any) => o && o !== e && o.id !== e.id && o.position && /^(zombified_piglin|piglin|piglin_brute|enderman)$/.test(o.name || '') &&
    Math.abs(o.position.x - e.position.x) < 1.7 && Math.abs(o.position.z - e.position.z) < 1.7 && o.position.y < e.position.y + (e.height || 1.8) + 0.3 && o.position.y + (o.height || 1.9) > e.position.y - 0.3 &&
    o.position.distanceTo(me) < 4 && seesMob(bot, o))
}

function bystanderOnLine (bot, e) {
  const eye = bot.entity.position.offset(0, 1.52, 0)
  const tgt = e.position.offset(0, (e.height || 1.8) * 0.5, 0)
  const dx = tgt.x - eye.x; const dy = tgt.y - eye.y; const dz = tgt.z - eye.z
  const L2 = dx * dx + dy * dy + dz * dz || 1
  for (const o of ((Object.values(bot.entities) as any[]) as any)) {
    if (!o || o === e || o.id === e.id || !o.position || !/^(zombified_piglin|piglin|piglin_brute|enderman)$/.test(o.name || '')) continue
    const cx = o.position.x; const cy = o.position.y + (o.height || 1.9) * 0.5; const cz = o.position.z
    const t = ((cx - eye.x) * dx + (cy - eye.y) * dy + (cz - eye.z) * dz) / L2
    if (t < -0.05 || t > 1.35) continue
    if (Math.hypot(eye.x + dx * t - cx, eye.y + dy * t - cy, eye.z + dz * t - cz) < 1.6) return o
  }
  return null
}

const OTHER_FOES = new Set(['wither_skeleton', 'skeleton', 'magma_cube', 'hoglin', 'piglin_brute', 'ghast'])
const FOOD_RE = /cooked|bread|apple|carrot|potato|steak|porkchop|mutton|chicken|rabbit|cod|salmon|beef|stew|cookie|pie|melon|berries/
const BLOCK_RE = /^(cobblestone|cobbled_deepslate|netherrack|stone|dirt|blackstone|basalt|nether_bricks|soul_soil|andesite|diorite|granite|tuff|deepslate|polished_blackstone|polished_basalt|end_stone)$/
const blocksHave = bot => bot.inventory.items().filter(i => BLOCK_RE.test(i.name)).reduce((n, i) => n + i.count, 0)
const arrowsHave = bot => bot.inventory.items().filter(i => /arrow$/.test(i.name)).reduce((n, i) => n + i.count, 0)
function shieldWear (bot) {
  try {
    const it = bot.inventory.slots[45]
    if (!it || it.name !== 'shield') return null
    const dmg = (it.components || []).find(c => c.type === 'damage')
    const used = dmg ? (dmg.data ?? 0) : (it.durabilityUsed || 0)
    return { used, left: 336 - used }
  } catch { return null }
}

// Сам бой у спавнера. Возвращает, что вышло; убийства считает farmRods.
// Иссушитель вплотную — бой из ямы глубиной 2 (nether-route.pitFight: его рамка удара раздута только вширь), а не вердикт
// «не переживу размен» и бег (s1c-A-7 06.10: иссушитель у помоста — 9.6 ударом и 4 иссушением за секунду, отказ, бег — смерть;
// s1c-L-3: 19 урона за ожидание «спавнер виден?» в начале навыка).
function witherClose (bot) {
  if (process.env.ND_WITHER_PIT === '0') return null
  return (Object.values(bot.entities) as any[]).find((e: any) => e && e.name === 'wither_skeleton' && e.isValid !== false && e.position &&
    e.position.distanceTo(bot.entity.position) < 3.6 && seesMob(bot, e)) || null
}

export {
  EYES_WANTED, SPAWNER_PLACE, clamp, log, rodsShort, reachTo, seesMob, ents, nearestBlaze, visibleSpawner,
  droppedRods, isRod, lavaNear, arrowsOnFloor, liveBlazes, watchers, sweepRisk, bystanderOnLine, OTHER_FOES,
  FOOD_RE, blocksHave, arrowsHave, shieldWear, witherClose
}
