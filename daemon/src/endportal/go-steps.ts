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
      const s1 = sample()
      if (s1) {
        const v = S.vecOf(s1.yaw)
        const w = await travelXZ(bot, ctl, Math.round(s1.x - v.z * 10), Math.round(s1.z + v.x * 10), { range: 2, retries: 1, deadline: Math.min(deadline, gameClock.now() + 30000) })
        const s2 = w.ok ? sample() : null
        const est = s2 ? S.triangulate([s1, s2]) : null
        const off = est ? Math.hypot(est.x - gx.shaft.x, est.z - gx.shaft.z) : null
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
          gx.shaft = pick || { x: Math.round(est.x + (gx.shaft.x - est.x) * k), z: Math.round(est.z + (gx.shaft.z - est.z) * k) }
          session._pieDig = { key: pieKey, shaft: gx.shaft, est, y: el ? el.y : null }
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
    gx.around = await goAround(session, ctl, shaft, { deadline, why: wet, far: process.env.ND_SEA_TUNNEL !== '0' ? 48 : 20 })
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
      gx.broke = eb.inside ? { inside: true, steps: (eb.tries || []).map(t => `к ${t.to.x},${t.to.y},${t.to.z}`) } : await breakIn(session, ctl, { deadline, toward: refined ? shaft : null })
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
