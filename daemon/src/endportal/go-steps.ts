'use strict'
// Крепость и портал в Край (endportal.ts): к крепости (goStronghold, mode=go) — фазы хода. Прежние const/let функции
// goStronghold — поля объекта gx (GoRun): 1 — дойти до точки из памяти (суша, море, мост), 2 — уточнить оком, 3 — место
// шахты («пирог» с поверхности), подход к ней (вода — обход), спуск до кирпича и вход; итог.
import * as gameClock from '../game-clock'
import { xyz, travelXZ } from '../movement'
import { itemNamed, countOf } from '../items'
import { PLACE, BRICKS, honestDescent, log, savePlace, noInfested } from './common'
import { shaftToBricks } from './shaft'
import { enterByBricks, breakIn } from './break-in'
import { surfaceY, wetColumn, wetNear, goAround, pickDryShaft } from './wet'
import { swimToward, altStrongholds, walkOrBridge, oceanAt, skyAbove } from './overland'

export interface GoRun {
  session: any
  ctl: any
  p: any
  bot: any
  t0: number
  deadline: number
  rec: any
  corner: { x: number, z: number }
  walks: any[]
  seaAround: any
  pd0: any
  throws: any[]
  refined: boolean
  shaft: { x: number, z: number }
  pieKey: string
  minY: number
  around: any
  wet: any
  inOwn: boolean
  tDescent: number
  dig: any
  broke: any
}

// --- 1. дойти до точки из памяти. Итог — объект для немедленного возврата из goStronghold (море, не дошёл) или undefined.
export async function goToCorner (gx: GoRun) {
  const { session, ctl, bot, deadline, corner, walks } = gx
  // Начатый обход воды над лестницей (шахта у сухой клетки, штрек под дном) — продолжить отсюда, а не идти поверху к лестнице
  // (s5e-P-2 07.10: после обрыва тактикой каждый вызов — walkOrBridge из своей шахты, «хода нет» ×N).
  const sd = session._seaDig
  if (sd && !sd.failed && sd.key === `${corner.x + 4},${corner.z + 4}` && Math.hypot(bot.entity.position.x - sd.from.x - 0.5, bot.entity.position.z - sd.from.z - 0.5) <= 10 &&
    bot.entity.position.y < sd.from.y - 1 && !ctl.aborted) {
    const st = await goAround(session, ctl, { x: corner.x + 4, z: corner.z + 4 }, { deadline, far: 96, fromHere: true, fromY: sd.from.y })
    walks.push({ seaResume: sd.from, ok: st.ok, why: st.why, dug: st.dug })
    log('обход воды: продолжаю из своей шахты', { ok: st.ok, why: st.why, dug: st.dug })
    if (st.ok) gx.seaAround = st
  }
  // Место шахты по «пирогу» уже выбрано (сухое, у портальной комнаты) — идти туда, а не к лестнице старта (s5e-B-2 07.10: после
  // обрыва спуска тактикой вызов шёл к лестнице под озером — «крепость под морем» ×N).
  const pd0 = gx.pd0 = session._pieDig && session._pieDig.key === `${corner.x},${corner.z}` && (session._pieDig.est || session._pieDig.dry) ? session._pieDig : null
  const walkTarget = pd0 ? { x: pd0.shaft.x - 4, z: pd0.shaft.z - 4 } : corner
  const far = gx.seaAround ? 0 : Math.hypot(bot.entity.position.x - walkTarget.x - 4, bot.entity.position.z - walkTarget.z - 4)
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
      if (st.ok) { sea = null; gx.seaAround = st }
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
    // ND_SH_BORE=1 (sr27-end): под землёй у крепости (выход из Ада в пещеру) поверху не дошёл — штрек к лестнице старта на своей
    // высоте, как игрок: кирпич в забое — это крепость (дальше вход, как у штрека под морем). sr27-end-a slot 20: «хода нет: 4 витков
    // на месте» в 48 бл. от угла, 30 мин до конца срока.
    if (!w.ok && !gx.seaAround && process.env.ND_SH_BORE === '1' && !skyAbove(bot) && !ctl.aborted && gameClock.now() < deadline - 30000) {
      const b = await boreToStairs(gx)
      walks.push({ bore: b })
      log('под землёй у крепости — штреком к лестнице старта', b)
      if (b.bricks) gx.seaAround = { ok: true, dug: b.dug, bricks: b.bricks }
      if (b.ok) return
    }
    if (!w.ok && !gx.seaAround) {
      return {
        went: false,
        walks,
        awayBlocks: Math.round(Math.hypot(bot.entity.position.x - corner.x, bot.entity.position.z - corner.z)),
        stopped: `до крепости не дошёл: ${w.error}. Позови ещё раз — пойду с того же места`
      }
    }
  }
}

// Штрек под землёй к лестнице старта (угол + 4): ниже y 5 — сперва ступенями к y 20 (крепость выше), дальше по осям шагами
// honestTunnelStep; кирпич в забое — стоп, это крепость. { ok, dug, moved, bricks?, why? }
export async function boreToStairs (gx: GoRun) {
  const { session, ctl, bot, deadline, corner } = gx
  const D: typeof import('../endportal-descent') = require('../endportal-descent')
  const T = { x: corner.x + 4, z: corner.z + 4 }
  const p0 = bot.entity.position
  const far = Math.abs(T.x - p0.x) + Math.abs(T.z - p0.z)
  if (far > 160) return { ok: false, dug: 0, moved: 0, why: `до лестницы ${Math.round(far)} бл. — далеко для штрека` }
  let dug = 0; let moved = 0; let why = null
  if (p0.y < 5) {
    const u = await D.toLevel(session, ctl, 20, { deadline, bricks: BRICKS, maxSteps: 40 })
    dug += u.dug || 0
  }
  for (let s = 0; s < far + 40 && !ctl.aborted && gameClock.now() < deadline; s++) {
    const f = bot.entity.position.floored()
    const dx = T.x - f.x; const dz = T.z - f.z
    if (Math.abs(dx) <= 1 && Math.abs(dz) <= 1) return { ok: true, dug, moved }
    const axes = (Math.abs(dx) >= Math.abs(dz) ? [[Math.sign(dx), 0], [0, Math.sign(dz)]] : [[0, Math.sign(dz)], [Math.sign(dx), 0]]).filter(([x, z]) => x || z)
    let stepped = false
    for (const [sx, sz] of axes) {
      const cell = f.offset(sx, 0, sz)
      const r = await D.honestTunnelStep(session, ctl, cell, { bricks: BRICKS, throughBricks: false })
      dug += r.dug || 0
      if (r.brick) return { ok: true, dug, moved, bricks: { found: r.brick, at: xyz(cell), dug } }
      if (r.ok) { moved++; stepped = true; break }
      why = r.why
    }
    if (!stepped) return { ok: false, dug, moved, why: why || 'штрек не пошёл' }
  }
  return { ok: false, dug, moved, why: why || 'время вышло' }
}

// --- 2. уточнить оком: ближе 12 блоков оно летит в точный угол чанка старта.
export async function refineByEye (gx: GoRun) {
  const { session, ctl, p, bot, deadline, walks, seaAround, pd0, throws } = gx
  if (!gx.refined && !seaAround && !pd0 && p.refine !== false && itemNamed(bot, 'ender_eye')) {
    const stronghold: typeof import('../stronghold') = require('../stronghold')
    for (let i = 0; i < 4 && !ctl.aborted && gameClock.now() < deadline; i++) {
      const t = await stronghold.throwEye(session, ctl)
      throws.push({ from: t.from, landed: t.landed, flew: t.flew, bearingDeg: t.bearingDeg, below: t.below, broke: t.broke })
      if (!t.thrown) break
      if (t.flew < 11) {
        gx.corner = { x: Math.floor(t.landed.x), z: Math.floor(t.landed.z) }
        gx.refined = true
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
    if (gx.refined) {
      savePlace(session, PLACE, { x: gx.corner.x, z: gx.corner.z, dimension: 'overworld', refined: true, note: 'угол стартового чанка по оку (±2): лестница старта у x+2..x+6, z+2..z+6, ниже y≈50' },
        `уточнил оком: угол чанка старта ${gx.corner.x},${gx.corner.z}`)
    }
  }
}

// --- 3. вниз у лестничной башни старта — или сразу у портальной комнаты, если её спавнер виден «пирогом» F3 с поверхности
// (как спидраннеры: pie-ray). Два пеленга (здесь и в 10 бл. вбок) → пересечение; в 80 бл. от лестницы — шахта в 5 бл. от оценки
// в сторону лестницы (не в лаву под рамками). Дальний спавнер (заброшенная шахта, данж) — мимо. ND_PIE_DIG=0 — у лестницы.
const PIE_Y_MAX = 52
export async function chooseShaft (gx: GoRun) {
  const { session, ctl, bot, deadline, corner, walks, seaAround } = gx
  const sky0 = skyAbove(bot)
  // Решение «где копать» — одно на крепость (повторный вызов после обрыва тактикой не ходит снова за пеленгами: s5e-P-1 07.10 —
  // 20 вызовов, каждый с отходом на 10 бл.).
  const pieKey = gx.pieKey = `${corner.x},${corner.z}`
  if (session._pieDig && session._pieDig.key === pieKey) gx.shaft = session._pieDig.shaft
  else if (honestDescent() && process.env.ND_PIE_DIG !== '0' && sky0 && !seaAround && !ctl.aborted && gameClock.now() < deadline - 60000) {
    session._pieDig = { key: pieKey, shaft: gx.shaft }
    try {
      const S: typeof import('../perception/senses') = require('../perception/senses')
      const sample = () => { const a = S.pieArcs(bot, 'spawner', { fov: 20, step: 2 }); return a.length && !a[0].all && a[0].center !== null ? { x: bot.entity.position.x, z: bot.entity.position.z, yaw: a[0].center } : null }
      // ND_END2_PIE=1: все дуги спавнеров по трекам (два отсчёта: здесь и в 10 бл. вбок), данж и спавнер выше крепости — мимо.
      const tracked = process.env.ND_END2_PIE === '1'
      const P: typeof import('./pie-track') = require('./pie-track')
      const store = tracked ? P.pieStore(session, pieKey) : null
      if (tracked) P.pieObserve(bot, store, { minStep: 0 })
      const t1 = tracked ? store.tracks.find(t => !t.notRoom && !t.dungeon) : null
      const s1 = tracked ? (t1 ? t1.samples[t1.samples.length - 1] : null) : sample()
      if (s1) {
        const v = S.vecOf(s1.yaw)
        const w = await travelXZ(bot, ctl, Math.round(s1.x - v.z * 10), Math.round(s1.z + v.x * 10), { range: 2, retries: 1, deadline: Math.min(deadline, gameClock.now() + 30000) })
        if (tracked && w.ok) P.pieObserve(bot, store, { minStep: 0 })
        const best = tracked ? P.pieBest(bot, store, { x: corner.x + 4, z: corner.z + 4 }) : null
        const s2 = tracked ? null : w.ok ? sample() : null
        const est = tracked ? (best && best.precise ? { ...best.est, x: best.at.x, z: best.at.z } : null) : s2 ? S.triangulate([s1, s2]) : null
        const off = est ? Math.hypot(est.x - gx.shaft.x, est.z - gx.shaft.z) : null
        log('«пирог» с поверхности: спавнер', { s1: s1.yaw, s2: s2 && s2.yaw, est, fromStairs: off && Math.round(off), ...(tracked ? { tracks: P.pieSummary(store) } : {}) })
        if (est && est.spread <= 4 && off <= 80) {
          // Высота спавнера — «пирогом» по вертикали; колонка шахты — сухая по видимому (нет воды в 4 бл. на поверхности), в 5–24 бл.
          // от оценки, ближе к лестнице (вода у лестницы: s5e-Q-1/R-1 — лестница у озера затопилась). Спуск — до этой высоты, потом
          // штрек к оценке (без поиска по коридорам).
          const me = bot.entity.position
          const el = tracked ? (Number.isFinite(best.y) ? { y: best.y } : null) : (require('../endportal-descent') as typeof import('../endportal-descent')).pieElevation(bot, Math.hypot(est.x - me.x, est.z - me.z))
          const stairs = { x: corner.x + 4, z: corner.z + 4 }
          const pick = pickDryShaft(bot, est, stairs, session._wetAvoid || [])
          const k = off > 6 ? 5 / off : 0
          gx.shaft = pick || { x: Math.round(est.x + (gx.shaft.x - est.x) * k), z: Math.round(est.z + (gx.shaft.z - est.z) * k) }
          // Крепость целиком ниже уровня моря − 10 (StrongholdStructure: moveBelowSeaLevel(seaLevel, minY, random, 10) — верх рамки < 53):
          // наклон «пирога» выше — не спавнер комнаты или промах оценки (eb01-s17 21.10: y 79 → «ниже уровня комнаты (61 < 80)» по кругу).
          // ND_PIE_YCAP=1 — такую высоту не брать: спуск до кирпича.
          const pieY = el && !(process.env.ND_PIE_YCAP === '1' && el.y > PIE_Y_MAX) ? el.y : null
          session._pieDig = { key: pieKey, shaft: gx.shaft, est, y: pieY }
          walks.push({ pie: { est: { x: est.x, z: est.z }, y: el && el.y, shaft: gx.shaft, dry: !!pick } })
          log('«пирог» с поверхности: копаю у оценки', { est: { x: est.x, z: est.z }, y: el && el.y, shaft: gx.shaft, dry: !!pick })
        }
      }
    } catch (e) { log('«пирог» с поверхности: ошибка', { error: e.message }) }
  }
}

// К месту шахты: уже в своей шахте — копать дальше; над лестницей вода — обход с сухой клетки; иначе дойти.
export async function reachShaft (gx: GoRun) {
  const { session, ctl, bot, deadline, corner, walks, seaAround, shaft, pieKey } = gx
  gx.minY = (bot.game && Number.isFinite(bot.game.minY) ? bot.game.minY : -64) + 6
  gx.around = null
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
  const inOwn = gx.inOwn = !!own && own.key === `${corner.x},${corner.z}` && Math.hypot(me3.x - own.x, me3.z - own.z) <= 4 && me3.y < own.y - 2
  const underground = inOwn || (!wetMe && Math.hypot(me3.x - shaft.x - 0.5, me3.z - shaft.z - 0.5) <= 3 && (me3.y < 55 || !skyAbove(bot)))
  const topY = underground || seaAround ? me3.floored().y : surfaceY(bot, shaft.x, shaft.z, bot.entity.position.floored().y)
  const wet = gx.wet = underground || seaAround ? null : session._wetStairs === pieKey && !(session._pieDig && session._pieDig.key === pieKey && session._pieDig.est) ? 'вода (спуск залило)'
    : (topY === null ? 'нет суши' : wetColumn(bot, shaft.x, shaft.z, topY) || (honestDescent() && wetNear(bot, shaft.x, topY, shaft.z, 4) ? 'вода в 4 бл.' : null))
  if (seaAround) {
    gx.around = seaAround
  } else if (wet) {
    // Над лестницей вода (озеро, река): шахта сюда зальётся. Спуститься с
    // ближайшей сухой клетки и подойти под водой штреком ниже её дна
    // (прогон у -3760,-3408: «под ногами вода — дальше вниз не копаю»).
    // ND_END2_FAR=1: суша для шахты — до 112 бл. (e2-rA/rB 3292: лестница старта под озером, суши в 48 бл. нет — «обойти не вышло»
    // ×108 за 30 мин; штрек под дном 100 бл. — 2–3 мин).
    gx.around = await goAround(session, ctl, shaft, { deadline, why: wet, far: process.env.ND_END2_FAR === '1' ? 112 : process.env.ND_SEA_TUNNEL !== '0' ? 48 : 20 })
    walks.push({ around: gx.around.from, ok: gx.around.ok, why: gx.around.why })
  } else if (!underground) {
    const w2 = await travelXZ(bot, ctl, shaft.x, shaft.z, { range: 1, retries: 2, deadline })
    walks.push({ to: shaft, ok: w2.ok, error: w2.error })
  }
}

// Спуск до кирпича (или до высоты спавнера «пирогом» и штрек к оценке), залитый спуск — новое место; у кирпича — вход.
export async function digDown (gx: GoRun) {
  const { session, ctl, bot, deadline, corner, shaft, pieKey, minY, around, wet, inOwn, refined } = gx
  gx.tDescent = gameClock.now()
  if (!around && !inOwn) session._ownShaft = { key: `${corner.x},${corner.z}`, x: bot.entity.position.x, z: bot.entity.position.z, y: bot.entity.position.y }
  const pd = session._pieDig && session._pieDig.key === pieKey && session._pieDig.est && Number.isFinite(session._pieDig.y) && honestDescent() ? session._pieDig : null
  gx.dig = around && !around.ok
    ? { stopped: `над лестницей старта ${wet}, обойти не вышло: ${around.why}`, dug: around.dug || 0 }
    : (around && around.bricks ? around.bricks : await shaftToBricks(session, ctl, pd && !around ? { minY, deadline, targetY: pd.y + 1 } : { minY, deadline }))
  // Спуск залило (вода со всех сторон ступени, s5e-M-2: лестница под озером, «утонул») — это место бросить: следующий вызов копает в
  // сухой колонке дальше 8 бл. отсюда (у оценки «пирога» или у лестницы старта, до 32 бл.).
  if ((gx.dig as any).wet && !around) {
    const av = session._wetAvoid || (session._wetAvoid = [])
    av.push({ x: Math.round(bot.entity.position.x), z: Math.round(bot.entity.position.z) })
    session._ownShaft = null
    // Голова в воде — сперва наверх (всплыть/столбом), потом новое место.
    if ((gx.dig as any).drowning || (require('../movement') as typeof import('../movement')).inWater(bot)) {
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
  if (pd && !around && (gx.dig as any).reached && !ctl.aborted) {
    const b = await (require('../endportal-descent') as typeof import('../endportal-descent')).honestBore(session, ctl, { x: Math.round(pd.est.x), z: Math.round(pd.est.z) }, { deadline: Math.min(deadline, gameClock.now() + 60000), maxSteps: 40, bricks: BRICKS })
    log('«пирог»: штрек к оценке на её высоте', { moved: b.moved, dug: b.dug, ok: b.ok, why: b.why })
    gx.dig = { found: 'pie', at: xyz(bot.entity.position.floored()), dug: ((gx.dig as any).dug || 0) + (b.dug || 0) } as any
  }
  if (around && around.ok && around.dug) gx.dig.dug = (gx.dig.dug || 0) + around.dug
  gx.broke = null
  if (gx.dig.found && !gx.dig.stopped) {
    const restore = noInfested(bot)
    try {
      const eb = await enterByBricks(session, ctl, { deadline })
      log('вход по кирпичу', eb)
      // ND_SH_PIE_STAY=1: шахта «пирога» уже на высоте спавнера — пробиваться внутрь без спуска (s-B 5730: штрек к оценке в 6 бл. от
      // комнаты прервал рефлекс, вход «честно» ушёл ступенями с y 36 до −1, в тупик под крепостью; комната — на y 34–41).
      const pieStay = process.env.ND_SH_PIE_STAY === '1' && (gx.dig as any).found === 'pie'
      gx.broke = eb.inside ? { inside: true, steps: (eb.tries || []).map(t => `к ${t.to.x},${t.to.y},${t.to.z}`) } : await breakIn(session, ctl, { deadline, toward: refined ? shaft : null, ...(pieStay ? { allowDescent: false } : {}) })
    } finally { restore() }
  }
}

// Итог хода к крепости: у кирпича — место в память; нет — почему.
export function goReport (gx: GoRun) {
  const { session, bot, t0, corner, walks, throws, refined, shaft, tDescent, dig, broke } = gx
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
