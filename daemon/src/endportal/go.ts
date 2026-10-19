'use strict'
// Крепость и портал в Край (endportal.ts): к известной комнате и к крепости (mode=go).
const gameClock: typeof import('../game-clock') = require('../game-clock')
const Vec3: typeof import('vec3').Vec3 = require('vec3')
const { xyz, travelXZ }: typeof import('../movement') = require('../movement')
const { itemNamed, countOf }: typeof import('../items') = require('../items')
const { seesBlock }: typeof import('../sight') = require('../sight')
const worlds: typeof import('../worlds') = require('../worlds')
const pick: typeof import('../pick') = require('../pick')
import { PLACE, BRICKS, clamp, honestDescent, log, placeOf, savePlace, noInfested } from './common'
import { shaftToBricks, digStepInto } from './shaft'
import { enterByBricks, breakIn } from './break-in'
import { surfaceY, wetColumn, DRY_FAR, dryEntry, wetNear, goAround, pickDryShaft } from './wet'
import { swimToward, altStrongholds, walkOrBridge, oceanAt, skyAbove } from './overland'

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
  let corner = { x: rec.x, z: rec.z }
  const walks = []
  let seaAround = null
  // Начатый обход воды над лестницей (шахта у сухой клетки, штрек под дном) — продолжить отсюда, а не идти поверху к лестнице
  // (s5e-P-2 07.10: после обрыва тактикой каждый вызов — walkOrBridge из своей шахты, «хода нет» ×N).
  const sd = session._seaDig
  if (sd && !sd.failed && sd.key === `${corner.x + 4},${corner.z + 4}` && Math.hypot(bot.entity.position.x - sd.from.x - 0.5, bot.entity.position.z - sd.from.z - 0.5) <= 10 &&
    bot.entity.position.y < sd.from.y - 1 && !ctl.aborted) {
    const st = await goAround(session, ctl, { x: corner.x + 4, z: corner.z + 4 }, { deadline, far: 96, fromHere: true, fromY: sd.from.y })
    walks.push({ seaResume: sd.from, ok: st.ok, why: st.why, dug: st.dug })
    log('обход воды: продолжаю из своей шахты', { ok: st.ok, why: st.why, dug: st.dug })
    if (st.ok) seaAround = st
  }
  // Место шахты по «пирогу» уже выбрано (сухое, у портальной комнаты) — идти туда, а не к лестнице старта (s5e-B-2 07.10: после
  // обрыва спуска тактикой вызов шёл к лестнице под озером — «крепость под морем» ×N).
  const pd0 = session._pieDig && session._pieDig.key === `${corner.x},${corner.z}` && (session._pieDig.est || session._pieDig.dry) ? session._pieDig : null
  const walkTarget = pd0 ? { x: pd0.shaft.x - 4, z: pd0.shaft.z - 4 } : corner
  const far = seaAround ? 0 : Math.hypot(bot.entity.position.x - walkTarget.x - 4, bot.entity.position.z - walkTarget.z - 4)
  // Ближе 16 — уже у лестницы (дальше — бросок ока и шахта): walkOrBridge у воды над лестницей крутился на месте (s5e-A-4).
  if (far > 16 && pd0) {
    const w = await walkOrBridge(session, ctl, pd0.shaft, deadline)
    walks.push({ toPieShaft: pd0.shaft, ok: w.ok, error: w.error })
    if (!w.ok) return { went: false, walks, stopped: `до места шахты у портальной комнаты не дошёл: ${w.error}` }
  } else if (far > 16) {
    const sw = await swimToward(bot, ctl, corner, Math.min(120000, Math.max(0, deadline - gameClock.now() - 30000)))
    if (sw.swam) walks.push({ swam: sw })
    const w = await walkOrBridge(session, ctl, corner, deadline)
    walks.push({ to: corner, ok: w.ok, error: w.error, bridged: w.bridged || undefined, legs: w.legs.length })
    let sea = oceanAt(bot, corner)
    // Крепость под морем (S5e 07.10, замечание (в) к S5d: сид −7145914149339214824 — «впереди вода 46 бл.» ×N, 35 мин вышли):
    // как человек — с ближней суши (до 96 бл.) шахтой вниз и штреком под дном к лестнице старта (честно: увиденную воду — заложить).
    // ND_SEA_TUNNEL=0 — прежний отказ («другая крепость кольца»).
    if ((sea || (w.sea && w.sea.open)) && process.env.ND_SEA_TUNNEL !== '0' && !ctl.aborted && gameClock.now() < deadline - 60000) {
      const st = await goAround(session, ctl, { x: corner.x + 4, z: corner.z + 4 }, { deadline, far: 96 })
      walks.push({ seaTunnel: st.from, ok: st.ok, why: st.why, dug: st.dug })
      log('крепость под водой — с суши штреком', { ok: st.ok, from: st.from, why: st.why, dug: st.dug })
      if (st.ok) { sea = null; seaAround = st }
    }
    if (!sea && w.sea && w.sea.open && !walks.some(x => x.seaTunnel && x.ok)) {
      const alt = altStrongholds(corner)
      return {
        went: false,
        walks,
        ocean: { ocean: true, onTheWay: w.sea, alternatives: alt },
        awayBlocks: Math.round(Math.hypot(bot.entity.position.x - corner.x, bot.entity.position.z - corner.z)),
        stopped: `на прямой к крепости море: воды ${w.sea.run}+ блоков, берега не видно, блоков на мост ${w.sea.have}. Крепость под морем или за ним — моста не хватит. Другие крепости кольца 0 — на ${alt.map(a => a.bearingDeg + '°').join(' и ')} от 0,0 (радиус 1408..2688): туда и бросать око (через Незер путь в 8 раз короче); или обойти воду берегом`
      }
    }
    if (sea) {
      return {
        went: false,
        walks,
        ocean: sea,
        stopped: `крепость под морем: над лестницей старта вода, сухой земли в 14 блоках нет — копать не с чего. Другие крепости кольца 0 — на ${sea.alternatives.map(a => a.bearingDeg + '°').join(' и ')} от 0,0 (радиус 1408..2688): туда и бросать око`
      }
    }
    if (!w.ok && !seaAround) {
      return {
        went: false,
        walks,
        awayBlocks: Math.round(Math.hypot(bot.entity.position.x - corner.x, bot.entity.position.z - corner.z)),
        stopped: `до крепости не дошёл: ${w.error}. Позови ещё раз — пойду с того же места`
      }
    }
  }

  // --- 2. уточнить оком: ближе 12 блоков оно летит в точный угол чанка старта.
  const throws = []
  let refined = !!rec.refined
  if (!refined && !seaAround && !pd0 && p.refine !== false && itemNamed(bot, 'ender_eye')) {
    const stronghold: typeof import('../stronghold') = require('../stronghold')
    for (let i = 0; i < 4 && !ctl.aborted && gameClock.now() < deadline; i++) {
      const t = await stronghold.throwEye(session, ctl)
      throws.push({ from: t.from, landed: t.landed, flew: t.flew, bearingDeg: t.bearingDeg, below: t.below, broke: t.broke })
      if (!t.thrown) break
      if (t.flew < 11) {
        corner = { x: Math.floor(t.landed.x), z: Math.floor(t.landed.z) }
        refined = true
        break
      }
      // Улетело на полные 12 — до угла дальше 12: пройти за ним и бросить снова.
      if (t.bearing === null || t.bearing === undefined) break
      const tx = Math.round(bot.entity.position.x + Math.sin(t.bearing) * 12)
      const tz = Math.round(bot.entity.position.z + Math.cos(t.bearing) * 12)
      const w = await travelXZ(bot, ctl, tx, tz, { range: 2, retries: 2, deadline })
      walks.push({ to: { x: tx, z: tz }, ok: w.ok, error: w.error })
      if (!itemNamed(bot, 'ender_eye')) break
    }
    if (refined) {
      savePlace(session, PLACE, { x: corner.x, z: corner.z, dimension: 'overworld', refined: true, note: 'угол стартового чанка по оку (±2): лестница старта у x+2..x+6, z+2..z+6, ниже y≈50' },
        `уточнил оком: угол чанка старта ${corner.x},${corner.z}`)
    }
  }

  // --- 3. вниз у лестничной башни старта — или сразу у портальной комнаты, если её спавнер виден «пирогом» F3 с поверхности
  // (как спидраннеры: pie-ray). Два пеленга (здесь и в 10 бл. вбок) → пересечение; в 80 бл. от лестницы — шахта в 5 бл. от оценки
  // в сторону лестницы (не в лаву под рамками). Дальний спавнер (заброшенная шахта, данж) — мимо. ND_PIE_DIG=0 — у лестницы.
  let shaft = { x: corner.x + 4, z: corner.z + 4 }
  const sky0 = skyAbove(bot)
  // Решение «где копать» — одно на крепость (повторный вызов после обрыва тактикой не ходит снова за пеленгами: s5e-P-1 07.10 —
  // 20 вызовов, каждый с отходом на 10 бл.).
  const pieKey = `${corner.x},${corner.z}`
  if (session._pieDig && session._pieDig.key === pieKey) shaft = session._pieDig.shaft
  else if (honestDescent() && process.env.ND_PIE_DIG !== '0' && sky0 && !seaAround && !ctl.aborted && gameClock.now() < deadline - 60000) {
    session._pieDig = { key: pieKey, shaft }
    try {
      const S: typeof import('../perception/senses') = require('../perception/senses')
      const sample = () => { const a = S.pieArcs(bot, 'spawner', { fov: 20, step: 2 }); return a.length && !a[0].all && a[0].center !== null ? { x: bot.entity.position.x, z: bot.entity.position.z, yaw: a[0].center } : null }
      const s1 = sample()
      if (s1) {
        const v = S.vecOf(s1.yaw)
        const w = await travelXZ(bot, ctl, Math.round(s1.x - v.z * 10), Math.round(s1.z + v.x * 10), { range: 2, retries: 1, deadline: Math.min(deadline, gameClock.now() + 30000) })
        const s2 = w.ok ? sample() : null
        const est = s2 ? S.triangulate([s1, s2]) : null
        const off = est ? Math.hypot(est.x - shaft.x, est.z - shaft.z) : null
        log('«пирог» с поверхности: спавнер', { s1: s1.yaw, s2: s2 && s2.yaw, est, fromStairs: off && Math.round(off) })
        if (est && est.spread <= 4 && off <= 80) {
          // Высота спавнера — «пирогом» по вертикали; колонка шахты — сухая по видимому (нет воды в 4 бл. на поверхности), в 5–24 бл.
          // от оценки, ближе к лестнице (вода у лестницы: s5e-Q-1/R-1 — лестница у озера затопилась). Спуск — до этой высоты, потом
          // штрек к оценке (без поиска по коридорам).
          const me = bot.entity.position
          const el = (require('../endportal-descent') as typeof import('../endportal-descent')).pieElevation(bot, Math.hypot(est.x - me.x, est.z - me.z))
          const stairs = { x: corner.x + 4, z: corner.z + 4 }
          const pick = pickDryShaft(bot, est, stairs, session._wetAvoid || [])
          const k = off > 6 ? 5 / off : 0
          shaft = pick || { x: Math.round(est.x + (shaft.x - est.x) * k), z: Math.round(est.z + (shaft.z - est.z) * k) }
          session._pieDig = { key: pieKey, shaft, est, y: el ? el.y : null }
          walks.push({ pie: { est: { x: est.x, z: est.z }, y: el && el.y, shaft, dry: !!pick } })
          log('«пирог» с поверхности: копаю у оценки', { est: { x: est.x, z: est.z }, y: el && el.y, shaft, dry: !!pick })
        }
      }
    } catch (e) { log('«пирог» с поверхности: ошибка', { error: e.message }) }
  }
  const minY = (bot.game && Number.isFinite(bot.game.minY) ? bot.game.minY : -64) + 6
  let around = null
  // Уже в своей шахте под землёй (второй вызов после «пещера под ногами»):
  // поверхность отсюда не видна, и прежняя проверка находила воду пещеры —
  // «над лестницей старта вода» три вызова подряд (лаборатория, прогон 10).
  const me3 = bot.entity.position
  // Своя шахта открыта в небо — «под землёй» по высоте: ниже уровня моря.
  // В воде (у кромки озера над лестницей) — не «своя шахта»: иначе второй и
  // следующие вызовы копали прямо у воды без обхода (room-A-7: «вода у шахты —
  // заложил 0 из 1» четыре вызова подряд).
  const wetMe = !seaAround && ([0, 1].some(dy => { const b = bot.blockAt(me3.offset(0, dy, 0)); return !!b && /water/.test(b.name) }) || wetNear(bot, me3.x, me3.y + 1, me3.z, 1))
  // Своя винтовая лестница (честный спуск начат здесь же, тело ниже её начала) — «под землёй», даже если в неё натекла вода.
  const own = session._ownShaft
  const inOwn = !!own && own.key === `${corner.x},${corner.z}` && Math.hypot(me3.x - own.x, me3.z - own.z) <= 4 && me3.y < own.y - 2
  const underground = inOwn || (!wetMe && Math.hypot(me3.x - shaft.x - 0.5, me3.z - shaft.z - 0.5) <= 3 && (me3.y < 55 || !skyAbove(bot)))
  const topY = underground || seaAround ? me3.floored().y : surfaceY(bot, shaft.x, shaft.z, bot.entity.position.floored().y)
  const wet = underground || seaAround ? null : session._wetStairs === pieKey && !(session._pieDig && session._pieDig.key === pieKey && session._pieDig.est) ? 'вода (спуск залило)'
    : (topY === null ? 'нет суши' : wetColumn(bot, shaft.x, shaft.z, topY) || (honestDescent() && wetNear(bot, shaft.x, topY, shaft.z, 4) ? 'вода в 4 бл.' : null))
  if (seaAround) {
    around = seaAround
  } else if (wet) {
    // Над лестницей вода (озеро, река): шахта сюда зальётся. Спуститься с
    // ближайшей сухой клетки и подойти под водой штреком ниже её дна
    // (прогон у -3760,-3408: «под ногами вода — дальше вниз не копаю»).
    around = await goAround(session, ctl, shaft, { deadline, why: wet, far: process.env.ND_SEA_TUNNEL !== '0' ? 48 : 20 })
    walks.push({ around: around.from, ok: around.ok, why: around.why })
  } else if (!underground) {
    const w2 = await travelXZ(bot, ctl, shaft.x, shaft.z, { range: 1, retries: 2, deadline })
    walks.push({ to: shaft, ok: w2.ok, error: w2.error })
  }
  const tDescent = gameClock.now()
  if (!around && !inOwn) session._ownShaft = { key: `${corner.x},${corner.z}`, x: bot.entity.position.x, z: bot.entity.position.z, y: bot.entity.position.y }
  const pd = session._pieDig && session._pieDig.key === pieKey && session._pieDig.est && Number.isFinite(session._pieDig.y) && honestDescent() ? session._pieDig : null
  let dig = around && !around.ok
    ? { stopped: `над лестницей старта ${wet}, обойти не вышло: ${around.why}`, dug: around.dug || 0 }
    : (around && around.bricks ? around.bricks : await shaftToBricks(session, ctl, pd && !around ? { minY, deadline, targetY: pd.y + 1 } : { minY, deadline }))
  // Спуск залило (вода со всех сторон ступени, s5e-M-2: лестница под озером, «утонул») — это место бросить: следующий вызов копает в
  // сухой колонке дальше 8 бл. отсюда (у оценки «пирога» или у лестницы старта, до 32 бл.).
  if ((dig as any).wet && !around) {
    const av = session._wetAvoid || (session._wetAvoid = [])
    av.push({ x: Math.round(bot.entity.position.x), z: Math.round(bot.entity.position.z) })
    session._ownShaft = null
    // Голова в воде — сперва наверх (всплыть/столбом), потом новое место.
    if ((dig as any).drowning || (require('../movement') as typeof import('../movement')).inWater(bot)) {
      try { await require('../survival/surface-body').surface(session, ctl, { timeoutSeconds: 40, preferPillar: true }) } catch {}
    }
    if (pd) {
      const next = pickDryShaft(bot, pd.est, { x: corner.x + 4, z: corner.z + 4 }, av, 5, 32)
      session._pieDig = { ...pd, shaft: next || shaft, dry: true }
      log('спуск залило — новое место шахты у оценки «пирога»', { avoid: av, next })
    } else {
      // У лестницы старта — обход воды: сухая клетка дальше 8 бл. от залитого места, шахта ниже дна, штрек под водой (goAround).
      session._wetStairs = pieKey
      log('спуск залило — к лестнице обходом воды', { avoid: av })
    }
  }
  // Спуск к высоте спавнера («пирог») — дальше штрек к оценке на этой высоте; дошёл — «у крепости» (вход и разведка — как от кирпича).
  if (pd && !around && (dig as any).reached && !ctl.aborted) {
    const b = await (require('../endportal-descent') as typeof import('../endportal-descent')).honestBore(session, ctl, { x: Math.round(pd.est.x), z: Math.round(pd.est.z) }, { deadline: Math.min(deadline, gameClock.now() + 60000), maxSteps: 40, bricks: BRICKS })
    log('«пирог»: штрек к оценке на её высоте', { moved: b.moved, dug: b.dug, ok: b.ok, why: b.why })
    dig = { found: 'pie', at: xyz(bot.entity.position.floored()), dug: ((dig as any).dug || 0) + (b.dug || 0) } as any
  }
  if (around && around.ok && around.dug) dig.dug = (dig.dug || 0) + around.dug
  let broke = null
  if (dig.found && !dig.stopped) {
    const restore = noInfested(bot)
    try {
      const eb = await enterByBricks(session, ctl, { deadline })
      log('вход по кирпичу', eb)
      broke = eb.inside ? { inside: true, steps: (eb.tries || []).map(t => `к ${t.to.x},${t.to.y},${t.to.z}`) } : await breakIn(session, ctl, { deadline, toward: refined ? shaft : null })
    } finally { restore() }
  }
  const here = bot.entity.position.floored()
  const detail: any = {
    went: !!dig.found,
    corner,
    refined,
    throws,
    walks: walks.length ? walks : undefined,
    shaft,
    dug: dig.dug,
    at: xyz(here),
    bricks: dig.found ? { name: dig.found, at: dig.at } : null,
    inside: broke ? broke.inside : false,
    brokeIn: broke && broke.steps.length ? broke.steps : undefined,
    eyesLeft: countOf(bot, 'ender_eye'),
    seconds: Math.round((gameClock.now() - t0) / 1000),
    descentSeconds: Math.round((gameClock.now() - tDescent) / 1000),
    honest: (dig as any).honest || undefined
  }
  if (dig.found) {
    savePlace(session, PLACE, { x: corner.x, z: corner.z, y: here.y, dimension: 'overworld', entered: xyz(here) },
      `дошёл до кирпича крепости (${dig.found}) на ${here.x},${here.y},${here.z}`)
    detail.note = `Я у крепости: ${dig.found} на ${dig.at.x},${dig.at.y},${dig.at.z}, стою на ${here.x},${here.y},${here.z}. ` +
      'Портальная комната — где-то в 112 блоках по коридорам: mc_stronghold mode=room.'
    if (dig.stopped) detail.stopped = dig.stopped
    else if (broke && !broke.inside) detail.stopped = `кирпич рядом, но внутрь не пробился${broke.stopped ? `: ${broke.stopped}` : ''} — mc_stronghold mode=room попробует ещё`
  } else {
    detail.stopped = `до кирпича не докопался: ${dig.stopped}` + (refined ? '' : '. Точку оком не уточнил — брось око рядом (mc_stronghold mode=throw)')
  }
  return detail
}

export {
  mappedStepRisk, goMappedRoom, goMappedRoomBody, goStronghold
}
