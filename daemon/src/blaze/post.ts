'use strict'
const Vec3: typeof import('vec3').Vec3 = require('vec3')
import { sleep, xyz } from '../movement'
import { walkable, standable } from '../walkable'
import { lavaNear } from './targets'
import { walkNear } from './approach'
import { losClear } from './radar'

// Пол под точкой: ближайшая клетка, где можно стоять, не ниже 4 блоков.
function floorUnder (bot, p) {
  const { standable }: typeof import('../walkable') = require('../walkable')
  const c = p.floored()
  for (let dy = 0; dy >= -4; dy--) {
    const q = c.offset(0, dy, 0)
    if (standable(bot, q)) return q
  }
  return null
}

// Точка боя у спавнера (замер 4: с места прихода в 11 блоках спавнер за краем
// помоста, лук упирался в забор, и бой простоял минуту без выстрела). Клетка в
// 3.5..9 блоках от спавнера по горизонтали, откуда ВИДНО больше всего точек
// куба спавна (±3 по x/z, +0.5 и +2 по высоте — там висят блейзы), без лавы в
// 3 блоках и не на краю; лучше — со стеной за спиной (все блейзы спереди, щит
// держит их разом).
function spawnView (bot, eye, c) {
  let seen = 0
  for (const x of [-3, -1, 1, 3]) for (const z of [-3, -1, 1, 3]) for (const y of [0.5, 2]) {
    if (losClear(bot, eye, c.offset(x, y, z))) seen++
  }
  return seen
}
function choosePost (bot, spawner, avoid = null) {
  if (!spawner) return null
  const c = spawner.offset(0.5, 0, 0.5)
  const nodes = walkable(bot, bot.entity.position, { radius: 16, maxNodes: 2500 })
  let best = null
  for (const { pos, d } of nodes) {
    if (!standable(bot, pos)) continue
    const h = Math.hypot(pos.x + 0.5 - c.x, pos.z + 0.5 - c.z)
    // Вплотную к спавнеру (1.5..4): новые блейзы появляются в ±4 от него на
    // его высоте ±1 (BaseSpawner) — в досягаемости меча, и бьются до первой
    // очереди (заряд 3 с). Замер 11: у спавнера 3 убийства за 10 с, с 7 блоков —
    // одно за полминуты и 21 стрела на 6 убийств.
    if (h < 1.4 || h > 9) continue
    if (Math.abs(pos.y - spawner.y) > 2) continue
    // A nearby step can expose the hall from behind its floor. Avoiding the
    // previous post costs preference; it must not discard the only real exit.
    const repeatCost = avoid ? Math.max(0, 2.5 - pos.distanceTo(avoid)) : 0
    const eye = pos.offset(0.5, 1.62, 0.5)
    if (eye.distanceTo(c.offset(0, 0.5, 0)) > 13) continue
    if (lavaNear(bot, pos, 3)) continue
    const f = bot.blockAt(pos); const hd = bot.blockAt(pos.offset(0, 1, 0))
    if ((f && /fire/.test(f.name)) || (hd && /fire/.test(hd.name))) continue
    let edge = 0
    for (const sd of DOOR_SIDES) {
      const g1 = bot.blockAt(pos.plus(sd).offset(0, -1, 0)); const g2 = bot.blockAt(pos.plus(sd).offset(0, -2, 0)); const g0 = bot.blockAt(pos.plus(sd))
      if (!solidB(g0) && !solidB(g1) && !solidB(g2)) edge++
    }
    const view = spawnView(bot, eye, c)
    if (view < 4) continue
    const bx = (pos.x + 0.5 - c.x) / h; const bz = (pos.z + 0.5 - c.z) / h
    const back = pos.offset(Math.round(bx), 0, Math.round(bz))
    let cover = 0
    for (const y of [0, 1]) if (solidB(bot.blockAt(back.offset(0, y, 0)))) cover++
    // S1e: на посту должна копаться яма отлёжки (3, иначе 2): отлечиться на помосте крепости «в толщу» не выходило — «лава/пусто у
    // ямы», ход к соседним клеткам под ударами ифритов вплотную (s1e-K4-7: 19.9 урона в фазе «в толщу отлечиться», смерть; K4-4, K4-1).
    const pit = process.env.ND_POST_PIT === '0' ? 0 : !pitWhyAt(bot, pos, 3) ? 2 : !pitWhyAt(bot, pos, 2) ? 1 : 0
    const score = view - edge * 4 + cover * 1.5 - Math.abs(h - 2.5) * 1.5 - Math.abs(pos.y - spawner.y) - d * 0.1 + pit * 3 - repeatCost
    if (!best || score > best.score) best = { pos, score, h: Math.round(h * 10) / 10, view, cover, edge, pit }
  }
  return best
}

// A remembered spawner tells us where its hall is, not where a hidden blaze is.
// Open one visible obstruction towards that known volume, like a bunker window.
function windowForPost (bot, spawner) {
  if (!spawner || !standable(bot, bot.entity.position.floored())) return null
  const pick: typeof import('../pick') = require('../pick'); const tools: typeof import('../tools') = require('../tools')
  const eye = pick.eyeOf(bot), c = spawner.offset(0.5, 0, 0.5)
  const targets = []
  for (const x of [-3, -1, 1, 3]) for (const z of [-3, -1, 1, 3]) for (const y of [0.5, 2]) targets.push(c.offset(x, y, z))
  const candidates = new Map()
  for (const q of targets) {
    const delta = q.minus(eye), len = delta.norm()
    if (len < 0.05) continue
    const hit = pick.blockOnRay(bot, eye, delta.scaled(1 / len), len - 0.05)
    if (hit) candidates.set(hit.pos.toString(), hit.block)
  }
  let best = null
  for (const block of candidates.values()) {
    const pos = block.position
    if (/spawner|chest|barrel|shulker/.test(block.name) || !tools.breakable(block)) continue
    if (!bot.canDigBlock(block) || !pick.blockSeen(bot, pos, { range: 4.5 })) continue
    const dig = tools.bestFor(bot, block)
    if (!Number.isFinite(dig.ms)) continue
    let gain = 0
    for (const q of targets) {
      const delta = q.minus(eye), len = delta.norm()
      if (len < 0.05) continue
      const hit = pick.blockOnRay(bot, eye, delta.scaled(1 / len), len - 0.05)
      if (!hit || !hit.pos.equals(pos)) continue
      // Only this block is ignored. A second wall still closes the view.
      const after = bot.world.raycast(eye, delta.scaled(1 / len), len - 0.05,
        b => b && b.boundingBox !== 'empty' && !b.position.equals(pos))
      if (!after) gain++
    }
    const score = gain / Math.max(50, dig.ms)
    // Equal-cost views: open the upper window, not a notch in the hall floor.
    if (gain > 0 && (!best || score > best.score || (score === best.score && pos.y > best.pos.y))) best = { pos, gain, ms: dig.ms, score }
  }
  return best
}

// Ходьба без копания и стройки: к блейзу на шаг — не сквозь стену крепости и
// не столбом в воздух.
function fightMoves (session) {
  const bot = session.bot
  const { Movements }: typeof import('mineflayer-pathfinder') = require('mineflayer-pathfinder')
  const m = new Movements(bot)
  m.canDig = false
  m.allow1by1towers = false
  m.allowParkour = false
  m.allowSprinting = false
  m.maxDropDown = 2
  m.scafoldingBlocks = []
  try { (require('../worlds') as typeof import('../worlds')).tuneMovements && (require('../worlds') as typeof import('../worlds')).tuneMovements(bot, m) } catch {}
  return m
}

// Шалаш с дверью у спавнера. Второй замер (щит по очередям, бой в открытую):
// хп держалось, но видели сразу 5 блейзов, щит стоял всё время, за 120 с
// ни одного убийства, а шары из-за спины (180° не хватает) всё равно сняли 7
// хп и 10 огня. Клетка со стенами с трёх сторон и крышей оставляет только
// дверь 1x2 к спавнеру: нас видно лишь в конусе двери (±45° из середины
// клетки), значит, все шары летят в дверь — щит к двери держит каждый. Бьём
// из двери: мечом того, кто в упор, луком — остальных в тишине между
// очередями. Блейз без взгляда на нас цель бросает через 60 тиков
// (TargetGoal unseenMemoryTicks) и заряд гасит (BlazeAttackGoal.stop).
const DOOR_SIDES = [new Vec3(1, 0, 0), new Vec3(-1, 0, 0), new Vec3(0, 0, 1), new Vec3(0, 0, -1)]

function solidB (b) { return !!b && b.boundingBox === 'block' }
function airB (b) { return !!b && b.boundingBox === 'empty' && !/lava|water|fire/.test(b.name) }
async function pitFrom (session, ctl, out, w) {
  const NR: typeof import('../nether-route') = require('../nether-route')
  let ok = await NR.pitFight(session, ctl, (out.pitSt ||= {}), w).catch(() => false)
  if (ok) out.witherPits = (out.witherPits || 0) + 1
  // Яму не выкопать (мост крепости: под ногами воздух) — столб 3 и лук сверху (rangedClear: рамка удара иссушителя 2.4 по высоте не
  // достаёт ноги на +3; s1c-P-2 06.10: на мосту у помоста 3 удара за секунду, «withered away»).
  if (!ok) { ok = await NR.rangedClear(session, ctl, out.pitSt, { radius: 6 }).catch(() => false); if (ok) out.witherTowers = (out.witherTowers || 0) + 1 }
  return ok
}

// Закопаться на месте: 2 клетки вниз и крышка над головой. Яма 1×1 глубиной 2 — ифрит не достаёт ударом (BlazeAttackGoal: d² < 4),
// шару нужен луч (s1-post24/25hole 06.10: в такой яме хп 20 всё время). Выход из навыка под ифритами иначе убивал: «к колонне
// не дошёл», 17 → 2 хп (s1-LG-3, LH-3: 5 стержней и смерть через секунды).
// Почему яма глубины depth под клеткой ног f не годится (null — годится): клетки ямы и пол под ней твёрдые, без лавы/воды/огня;
// стенки ямы твёрдые со всех сторон: яма у края помоста с воздухом сбоку открыта ифритам (их удар вплотную требует луча —
// BlazeAttackGoal: hasLineOfSight; s1c-M-2 06.10: «sealed», а 7 ударов в яме сбоку, смерть). Общая для digInPlace и digInNear.
const PIT_BAD = b => !b || /lava|water|fire|magma|spawner|bedrock|chest/.test(b.name)
function pitWhyAt (bot, f, depth) {
  const cs = [1, 2, 3].slice(0, depth).map(d => f.offset(0, -d, 0))
  for (const c of cs) { const b = bot.blockAt(c); if (PIT_BAD(b) || b.boundingBox !== 'block') return 'под ногами: ' + (b ? b.name : '?') }
  const fl = bot.blockAt(f.offset(0, -depth - 1, 0))
  if (PIT_BAD(fl) || fl.boundingBox !== 'block') return `пол на −${depth + 1}: ` + (fl ? fl.name : '?')
  for (const c of cs) for (const [dx, dz] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) { const b = bot.blockAt(c.offset(dx, 0, dz)); if (!b || /lava/.test(b.name) || b.boundingBox !== 'block') return 'лава/пусто у ямы' }
  return null
}

async function digInPlace (bot, ctl) {
  const SL: typeof import('../sealed') = require('../sealed')
  // В прыжке/отбросе под ногами воздух (s1-LH-9/LH-10 06.10: «под ногами: air») — сперва стоять на земле.
  for (let i = 0; i < 30 && !bot.entity.onGround && !ctl.aborted; i++) await sleep(50)
  const f = bot.entity.position.offset(0, 0.2, 0).floored()
  // Глубина 3: крышка — над головой в клетке f−1, у неё 4 стенки ямы — грань для установки есть всегда. При глубине 2 крышка
  // шла в клетку пола f, а у неё на ровном месте ни одной опорной грани (сбоку воздух, снизу голова): «крышка не встала»,
  // шары в открытый верх (S1d s1d-N-3: 19 жемчуга, в яме без крышки 50 урона «в толщу отлечиться», смерть на 41-й мин).
  // Глубина 3 не помещается (помост крепости в 1–2 блока толщиной над пустотой: «лава/пусто у ямы» — s1d-G21-5, смерть) — яма 2
  // по-старому, без гарантии крышки, но с твёрдыми стенками. ND_PIT_DEPTH=2 — сразу 2.
  const pitWhy = depth => pitWhyAt(bot, f, depth)
  const why3 = process.env.ND_PIT_DEPTH === '2' ? 'ND_PIT_DEPTH=2' : pitWhy(3)
  const why2 = why3 ? pitWhy(2) : null
  if (why3 && why2) return { ok: false, why: why2 }
  const DEPTH = why3 ? 2 : 3
  const cells = [1, 2, 3].slice(0, DEPTH).map(d => f.offset(0, -d, 0))
  for (const c of cells) {
    if (ctl.aborted) return { ok: false, why: 'прервано' }
    // Копку под ударами сервер обрывает («server interrupted», s1c-B-3 06.10) — повторить до трёх раз.
    let r = 'err'
    for (let k = 0; k < 3 && r !== 'ok' && r !== 'air' && !ctl.aborted; k++) r = await SL.digCell(bot, c).catch(e => 'err ' + e.message)
    if (r !== 'ok' && r !== 'air') return { ok: false, why: 'копка ' + r }
    for (let i = 0; i < 20 && !bot.entity.onGround; i++) await sleep(50)
  }
  for (let i = 0; i < 10 && bot.entity.position.y > f.y - DEPTH + 0.5; i++) await sleep(100)
  if (bot.entity.position.y > f.y - DEPTH + 0.5) return { ok: false, why: 'не опустился' }
  const top = bot.entity.position.floored().offset(0, 2, 0)
  // Крышка — до трёх попыток (ифрит в клетке над ямой мешает поставить: s1-LL-6 06.10 «sealed: false» → видели в открытый верх).
  let sealed = false
  for (let k = 0; k < 3 && !sealed && !ctl.aborted; k++) { sealed = !!(await SL.fillCell(bot, top).catch(() => false)); if (!sealed) await sleep(300) }
  return { ok: true, sealed: !!sealed, depth: DEPTH, at: xyz(bot.entity.position) }
}

// В толщу рядом: на мосту/помосте под ногами воздух (s1c-A-2 06.10: «под ногами: air» у спавнера — навык вернул тело под ифритов,
// смерть через секунду). Тогда — ближняя клетка (≤ 4 бл., тот же уровень), где 3 вниз твёрдое и нет лавы рядом, 1–3 шага и там.
async function digInNear (bot, ctl, r = 4) {
  const first: any = await digInPlace(bot, ctl)
  if (first.ok || ctl.aborted || !/под ногами|пол на|лава\/пусто/.test(first.why || '')) return first
  const { standable }: typeof import('../walkable') = require('../walkable')
  const f = bot.entity.position.offset(0, 0.2, 0).floored()
  const cands = []
  for (let dx = -r; dx <= r; dx++) for (let dz = -r; dz <= r; dz++) {
    if (!dx && !dz) continue
    const c = f.offset(dx, 0, dz)
    if (!standable(bot, c)) continue
    // Соседняя клетка — под ту же яму, что примет digInPlace: 3, иначе 2 (проверка S1d (г): брали только клетки под яму 3 —
    // на помосте крепости в 2–3 блока соседней не находилось, хотя яма 2 там встаёт). Яма 2 — чуть дороже (крышка без гарантии).
    const depth = process.env.ND_PIT_DEPTH !== '2' && !pitWhyAt(bot, c, 3) ? 3 : !pitWhyAt(bot, c, 2) ? 2 : 0
    if (depth) cands.push({ c, depth, cost: c.distanceTo(f) + (depth === 3 ? 0 : 1.5) })
  }
  cands.sort((a, b) => a.cost - b.cost)
  for (const { c } of cands.slice(0, 3)) {
    if (ctl.aborted) break
    const w = await walkNear(bot, ctl, c, 0, 4000)
    if (!w.ok || !bot.entity.position.offset(0, 0.2, 0).floored().equals(c)) continue
    const r2: any = await digInPlace(bot, ctl)
    if (r2.ok) return { ...r2, moved: xyz(c) }
  }
  return { ...first, near: cands.length }
}

export {
  floorUnder, choosePost, windowForPost, fightMoves, DOOR_SIDES, solidB, airB, pitFrom, pitWhyAt, digInPlace,
  digInNear
}
