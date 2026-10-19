'use strict'
// Крепость и портал в Край (endportal.ts): к известной комнате и к крепости (mode=go).
import * as gameClock from '../game-clock'
import { Vec3 } from 'vec3'
import { xyz, travelXZ } from '../movement'
import { itemNamed, countOf } from '../items'
import { seesBlock } from '../sight'
import * as worlds from '../worlds'
import * as pick from '../pick'
import { PLACE, BRICKS, clamp, honestDescent, placeOf } from './common'
import { shaftToBricks, digStepInto } from './shaft'
import { DRY_FAR, dryEntry } from './wet'
import { walkOrBridge, skyAbove } from './overland'
import { type GoRun, goToCorner, refineByEye, chooseShaft, reachShaft, digDown, goReport } from './go-steps'

// Локальная безопасность перед каждым шагом штрека к известной комнате.
// Жидкости как в mining.danger: проверить до вскрытия стены, неизвестное — отказ.
function mappedStepRisk (bot, cell) {
  for (const dy of [0, 1]) {
    const b = bot.blockAt(cell.offset(0, dy, 0))
    if (!b) return 'чанк не прогружен'
    if (/end_portal|spawner|infested|bedrock|fire|powder_snow/.test(b.name)) return `${b.name} в забое — обход`
  }
  for (let dy = -1; dy <= 2; dy++) {
    for (const [dx, dz] of [[0, 0], [1, 0], [-1, 0], [0, 1], [0, -1]]) {
      const b = bot.blockAt(cell.offset(dx, dy, dz))
      if (!b) return 'чанк не прогружен'
      if (/water|lava|bubble_column/.test(b.name)) return `${b.name} у забоя — обход`
    }
  }
  const floor = bot.blockAt(cell.offset(0, -1, 0))
  if (/pointed_dripstone|magma_block|cactus|end_portal|campfire/.test(floor.name)) return `${floor.name} под ногами — обход`
  return null
}

async function goMappedRoom (session, ctl, room, deadline) {
  const bot = session.bot
  const original = bot.dig
  const visibleDig = function (block, ...args: any[]) {
    // Заражённый — только при хп ≥ 12 (цена — чешуйница, см. shaftToBricks); рамки и спавнер комнаты — никогда.
    if (!block || /end_portal|spawner/.test(block.name) || (/infested/.test(block.name) && (bot.health ?? 20) < 12) || !seesBlock(bot, block)) return Promise.reject(new Error('забой не виден в прицеле или блок комнаты защищён'))
    return original.call(bot, block, ...args)
  }
  bot.dig = visibleDig
  try { return await goMappedRoomBody(session, ctl, room, deadline) } finally { if (bot.dig === visibleDig) bot.dig = original }
}

async function goMappedRoomBody (session, ctl, room, deadline) {
  const bot = session.bot
  const plan = (require('../stronghold') as typeof import('../stronghold')).roomApproach(room, bot.entity.position)
  const target = new Vec3(plan.target.x, plan.target.y, plan.target.z)
  const walks = []
  // Под землёй дальше 56 бл. от колонки шахты (целая колонка — в 48; выход из Ада в пещеру: s5d-p5-1 07.10 — шахта прямо из пещеры в 80 бл. от комнаты,
  // вода на y 20 и зомби, смерть на 6-й мин) — сперва наверх, потом сухая и целая колонка как обычно.
  if (!skyAbove(bot) && bot.entity.position.y > target.y + 2 && Math.hypot(plan.shaft.x + 0.5 - bot.entity.position.x, plan.shaft.z + 0.5 - bot.entity.position.z) > 56 &&
    process.env.ND_SHAFT_SURFACE !== '0') {
    const up = await require('../survival/surface-body').surface(session, ctl, { timeoutSeconds: Math.max(20, Math.min(90, Math.round((deadline - gameClock.now()) / 1000) - 30)), preferPillar: true }).catch(e => ({ ok: false, error: e.message }))
    walks.push({ surface: !!(up && (up.ok || up.surfaced)), y: Math.round(bot.entity.position.y) })
  }
  // На поверхности сначала выбираем сухую колонку вне комнаты. При повторном
  // вызове из шахты продолжаем с текущей высоты и не возвращаемся наверх.
  // Неба не видно (крона над выходом из Ада, s5d-p7-1), но до колонки шахты дальше 56 бл. — тоже «наверху»: выбор колонки.
  const farShaft = Math.hypot(plan.shaft.x + 0.5 - bot.entity.position.x, plan.shaft.z + 0.5 - bot.entity.position.z) > 56
  if (bot.entity.position.y > target.y + 2 && (skyAbove(bot) || farShaft) && bot.entity.position.y >= 55) {
    // Сухой вход — ещё с суши, по прогруженным чанкам, до DRY_FAR бл. от входа комнаты (s5c-f1-1, 06.10: комната под
    // океаном у монумента — лодкой к точке над комнатой, сухого в 14 бл. нет, тело в воде у стражей погибло). Дальний
    // сухой вход — шахта там и штрек на уровне комнаты под дном (mappedStepRisk обходит воду и лаву).
    let dry = dryEntry(bot, plan.shaft, DRY_FAR, target.y, target)
    if (!dry) {
      const w = await walkOrBridge(session, ctl, plan.shaft, deadline)
      if (!w.ok) return { went: false, mapped: true, stopped: `к сухому входу комнаты не дошёл: ${w.error}` }
      dry = dryEntry(bot, plan.shaft, DRY_FAR, target.y, target)
    }
    if (!dry) return { went: false, mapped: true, stopped: `над комнатой вода/лава: сухой вход в ${DRY_FAR} бл. не найден` }
    if (Math.hypot(dry.x + 0.5 - bot.entity.position.x, dry.z + 0.5 - bot.entity.position.z) > 8) {
      const w = await walkOrBridge(session, ctl, dry, deadline)
      walks.push({ to: { x: dry.x, z: dry.z }, ok: w.ok, fromShaft: dry.r })
      if (!w.ok) return { went: false, mapped: true, walks, stopped: `к сухому входу (${dry.r} бл. от комнаты) не дошёл: ${w.error}` }
    }
    const approach = await travelXZ(bot, ctl, dry.x, dry.z, { range: 0, retries: 1, deadline })
    walks.push({ to: dry, ok: approach.ok })
    if (!approach.ok) return { went: false, mapped: true, walks, stopped: `до сухой колонки не дошёл: ${approach.error}` }
  }
  const descent = await shaftToBricks(session, ctl, { minY: target.y, targetY: target.y, deadline })
  if (!descent.reached) return { went: false, mapped: true, descent, stopped: descent.stopped }
  const level = bot.entity.position.floored().y
  const seen = new Set()
  let dug = descent.dug
  const dirs = [[1, 0, 'east'], [-1, 0, 'west'], [0, 1, 'south'], [0, -1, 'north']]
  const key = c => `${c.x},${c.y},${c.z}`
  let stopped = null
  // К комнате прямо на её высоте. Лава/вода — обойти по сухому на этом же
  // уровне; пустота — твёрдая подпорка перед шагом, никакого падения к лаве.
  for (let i = 0; i < 260 && !ctl.aborted && gameClock.now() < deadline; i++) {
    const feet = bot.entity.position.floored()
    if (feet.y !== level) { stopped = 'сбило с уровня комнаты — нужен новый подход'; break }
    if (feet.x === target.x && feet.z === target.z) return { went: true, inside: true, mapped: true, room: room.centre, target: xyz(target), dug, walks }
    seen.add(key(feet))
    const candidates = dirs.map(([dx, dz, direction]) => ({ cell: feet.offset(dx, 0, dz), direction }))
      .filter(c => !seen.has(key(c.cell)))
      .sort((a, b) => a.cell.distanceTo(target) - b.cell.distanceTo(target))
    let moved = false
    for (const { cell, direction } of candidates) {
      if (honestDescent()) {
        // Честно: без заглядывания в толщу — копать видимое, увиденную жидкость заложить, пустоту под ногами — мостом.
        const r = await (require('../nether') as typeof import('../nether')).guarded(session, ctl, sub => (require('../endportal-descent') as typeof import('../endportal-descent')).honestTunnelStep(session, sub, cell, { bricks: BRICKS, throughBricks: true }))
        dug += r.dug || 0
        if (bot.entity.position.floored().equals(cell)) { moved = true; walks.push({ to: xyz(cell) }); break }
        stopped = r.why || r.stopped || r.error || `шаг штрека ${direction} не выполнен`
        if (r.fought || ctl.aborted) break
        continue
      }
      stopped = mappedStepRisk(bot, cell)
      if (stopped) continue
      const floor = cell.offset(0, -1, 0)
      if (bot.blockAt(floor).boundingBox !== 'block') {
        const build: typeof import('../build') = require('../build')
        const fill = build.pickFiller(bot, { steady: true })
        if (!fill) { stopped = 'пустота: нет твёрдых блоков на пол'; continue }
        const b = await build.placeBlockAt(bot, floor, { item: fill.name, timeoutMs: Math.min(2000, Math.max(1, deadline - gameClock.now())) })
        if (!b.ok) { stopped = `пустота: не поставил опору (${b.reason})`; continue }
      }
      // Видимость проверяет обёртка каждого dig: голова сначала открывает ноги.
      if ((require('../tunnel') as typeof import('../tunnel')).lowPicks(bot) < 2) await (require('../tunnel') as typeof import('../tunnel')).restockPicks(session, ctl, 2).catch(() => 0)
      const r = await (require('../nether') as typeof import('../nether')).guarded(session, ctl, () => digStepInto(bot, session.mcData, cell))
      dug += r.dug || 0
      if (bot.entity.position.floored().equals(cell)) { moved = true; walks.push({ to: xyz(cell) }); break }
      stopped = r.why || r.stopped || r.error || `шаг штрека ${direction} не выполнен`
      if (r.fought || ctl.aborted) break
    }
    if (!moved) break
  }
  return { went: false, mapped: true, dug, walks, room: room.centre, stopped: ctl.aborted ? 'прервано' : gameClock.now() >= deadline ? 'время вышло' : stopped || 'прямой штрек к комнате не закончен' }
}

async function goStronghold (session, ctl, p: any = {}) {
  const bot = session.bot
  const t0 = gameClock.now()
  const deadline = t0 + clamp(p.timeoutSeconds ?? 300, 30, 600) * 1000 - 4000
  if (worlds.worldOf(bot) !== 'overworld') {
    return { went: false, stopped: `крепость — в верхнем мире, а я ${worlds.inWorld(worlds.worldOf(bot))}: сначала портал (mc_portal mode=enter)` }
  }
  const rec = placeOf(session, PLACE)
  if (!rec) return { went: false, stopped: 'крепости в памяти нет — сначала mc_stronghold mode=find (два ока и пересечение лучей)' }
  const mapped = process.env.ND_ROOM_MAP !== '0' && (require('../stronghold') as typeof import('../stronghold')).mappedRoom(rec)
  if (mapped) return goMappedRoom(session, ctl, mapped, deadline)
  // Уже дошёл до кирпича этой крепости и под землёй рядом (findRoom зовёт go, когда кирпича не видно — из своего штрека к
  // приманке): новый спуск не начинать (s5e-F-1 07.10: «обход воды: продолжаю из своей шахты» из штрека у комнаты — ещё 6 бл. вниз).
  const ent = rec.entered
  if (honestDescent() && ent && Number.isFinite(ent.y) && Math.hypot(bot.entity.position.x - ent.x, bot.entity.position.z - ent.z) <= 96 && bot.entity.position.y < ent.y + 12 && !skyAbove(bot)) {
    return { went: true, already: true, inside: true, corner: { x: rec.x, z: rec.z }, at: xyz(bot.entity.position.floored()), bricks: { name: 'entered', at: ent }, dug: 0, seconds: 0 }
  }

  // --- 1. дойти до точки из памяти
  const gx = { session, ctl, p, bot, t0, deadline, rec, corner: { x: rec.x, z: rec.z }, walks: [], seaAround: null } as GoRun
  const stop = await goToCorner(gx)
  if (stop) return stop
  // --- 2. уточнить оком; 3. место шахты, подход, спуск до кирпича и вход.
  gx.throws = []
  gx.refined = !!rec.refined
  await refineByEye(gx)
  gx.shaft = { x: gx.corner.x + 4, z: gx.corner.z + 4 }
  await chooseShaft(gx)
  await reachShaft(gx)
  await digDown(gx)
  return goReport(gx)
}

export {
  mappedStepRisk, goMappedRoom, goMappedRoomBody, goStronghold
}
