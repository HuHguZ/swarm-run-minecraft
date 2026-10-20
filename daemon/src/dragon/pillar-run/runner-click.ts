'use strict'
// Бой с драконом: бегун по столбу (pillarRun) — прицел и щелчок в тик прохода; упреждение клика — clickLead.
import { gameClock, Vec3, findItem, sleep, dragonOf, phaseOf, PHASE, EYE, envNum, envv, RUN_FACING, RUN_GAPARROW, RUN_LATEHEAD } from '../dig-down-to'
import { r1 } from '../fall-guard'
import { countOf, lookAtSafe, virtualBot, landingForecast, landingHits, bedDamage } from '../evade-raw'
import { runnerGapArrow } from '../station-plan'
import { faceClick, BED_GAP_MS, faceClickFacing } from '../pillar-plan'
import { pushedForecast } from '../ts-plan'
import { bedsBoom } from './beds-act'
import { type RunState, type RunTick, type Turn } from './runner-state'

// Тиков после прохода головы по прогнозу до щелчка: +1 на 20 тиках (an-pilltiming, 81 из 90), 0 на ускоренных (s5 06.10).
function clickLead (rate = gameClock.snapshot()?.tickRate ?? 20) { return envNum('ND_CLICK_LEAD', rate > 100 ? 0 : 1) }

export async function runAim (rs: RunState, tk: RunTick): Promise<Turn> {
  const { bot, ctl, session, feed } = rs
  // щелчок в тик прохода
  const eyeNow = bot.entity.position.offset(0, EYE, 0)
  const vBed = tk.placeClick ? virtualBot(bot, new Map([[`${rs.F.x},${rs.yb},${rs.F.z}`, 'bed'], [`${rs.H.x},${rs.yb},${rs.H.z}`, 'bed']])) : bot
  tk.hit = tk.useAn ? rs.anClick(bot) : faceClick(vBed, eyeNow, new Vec3(rs.plan.click.cell.x, rs.yb, rs.plan.click.cell.z), new Vec3(rs.plan.click.face.x, rs.plan.click.face.y, rs.plan.click.face.z))
  // ставка в тот же миг: грань опоры K (взгляд — на неё: по горизонтали взгляда сервер кладёт изголовье)
  tk.pre = null
  if (tk.placeClick && tk.hit) {
    const Kb = bot.blockAt(new Vec3(rs.plan.place.K.x, rs.plan.place.K.y, rs.plan.place.K.z))
    const fk = Kb && (rs.runnerLevels && RUN_FACING() ? faceClickFacing(bot, eyeNow, Kb.position, rs.plan.place.face, { x: rs.H.x - rs.F.x, z: rs.H.z - rs.F.z }) : faceClick(bot, eyeNow, Kb.position, rs.plan.place.face))
    if (!fk) { if (await rs.recenter()) return 'next'; rs.st.built = false; rs.out.why = 'грань опоры не видно'; return 'stop' }
    tk.pre = { pos: Kb.position, face: rs.plan.place.face, point: fk.point }
  }
  if (!tk.hit) { if (await rs.recenter()) return 'next'; if (!tk.useAn) rs.st.built = false; rs.out.why = tk.useAn ? 'якорь не видно' : 'кровать не видно'; return 'stop' }
  // +1 тик против L: по записи сервера (an-pilltiming.js, 90 взрывов pil2) лучший тик — на 1 позже в 81 из 90
  // 750 TPS (s5, 06.10, свидетель DragonLab, 16 взрывов): тот же +1 тик опаздывал — лучший тик раньше на 1 (медиана; −2…+1):
  // доставка и разбор пакетов — доли мс, но это 1–2 тика. На ускоренных тиках — без +1 (ND_CLICK_LEAD).
  tk.tClick = tk.fc.t + 50 * (tk.clickI + clickLead()) + envNum('ND_CLICK_OFS', -25)
  // тот же миг по ровным часам на ускоренных тиках (ND_CLICK_MONO=0 — по игровым, как раньше)
  const snNow = gameClock.snapshot(); tk.rateNow = snNow?.effectiveRate || snNow?.tickRate || 20
  tk.tClickMono = !snNow?.lockstep && tk.rateNow > 100 && tk.fc.monoT != null && envv('ND_CLICK_MONO') !== '0' ? tk.fc.monoT + (tk.clickI + clickLead() + envNum('ND_CLICK_OFS', -25) / 50) * 1000 / tk.rateNow : null
  tk.dClick = tk.clickI === tk.pass.i ? tk.pass.d : tk.fc.path[tk.clickI].head.distanceTo(tk.ctr)
  // щёлкать — по свежему прогнозу, когда до прохода ≤ 8 тиков (на 30 тиков вперёд прогноз спирали
  // ошибается на 2–3 блока: pil1-8 — ждали 41, вышло 15)
  tk.aimAt = tk.pre ? tk.pre.point : tk.hit.point
  // R: стрела в промежутке, пока до щелчка ≥ 1.5 с (ND_RUN_GAPARROW=1); одна попытка на промежуток
  if (rs.runnerLevels && RUN_GAPARROW() && tk.tClick - gameClock.now() > 1500 && rs.gapKey !== rs.lastBoom && bot.health >= 10 && countOf(bot, /arrow$/) > 0) {
    rs.gapKey = rs.lastBoom
    const ga: any = await runnerGapArrow(session, ctl, feed, rs.P, { minHit: (rs.lastBoom || 0) + 560, maxHit: tk.tClick - 560, deadline: tk.tClick - 330 })
    ;(rs.out.gapLog || (rs.out.gapLog = [])).push(ga.shot ? { ...ga.shot, hpAfter: ga.hpAfter } : ga.why)
    return 'next'
  }
  if (tk.tClick - gameClock.now() > 260) { await lookAtSafe(bot, tk.aimAt); await sleep(30); return 'next' }
}

export async function runClick (rs: RunState, tk: RunTick): Promise<Turn> {
  const { bot, ctl, session, stats, feed } = rs
  await lookAtSafe(bot, tk.aimAt)
  if (tk.pre) { const bi = findItem(bot, /_bed$/); if (!bi) { rs.out.why = 'кровати кончились'; return 'stop' } if (!bot.heldItem || !/_bed$/.test(bot.heldItem.name)) await bot.equip(bi, 'hand').catch(() => {}) }
  await new Promise<any>(resolve => bot.once('physicsTick', resolve))
  if (ctl.trace && rs.runnerLevels) rs.ev('clickSchedule', { rate: tk.rateNow, game: gameClock.now(), mono: gameClock.wall.monotonic(), tClick: tk.tClick, targetMono: tk.tClickMono, fcT: tk.fc.t, fcMono: tk.fc.monoT,
    samples: feed.list.slice(-6).map(q => ({ t: q.t, mono: q.mono, tick: q.tick, n: q.n, tt: q.tt, ttMono: q.ttMono, p: [q.x, q.y, q.z], v: [q.vx, q.vy, q.vz] })) })
  const r = await bedsBoom(session, ctl, stats, { ...rs.plan, ...(tk.useAn ? { H: { x: rs.F.x, z: rs.F.z }, centre: rs.Acentre } : {}), anchor: tk.useAn, dist: r1(tk.dClick), expect: bedDamage(tk.dClick, rs.plan.seen || 1), D: rs.plan.a, y: rs.yb, reuse: true }, { point: tk.hit.point, face: rs.runnerLevels ? rs.plan.click.face : null, runnerGuard: rs.runnerLevels ? () => {
    const q = bot.entity.position, f = landingForecast(feed, rs.P) || tk.fc
    const k = Math.max(0, Math.round((gameClock.now() - f.t) / 50))
    const dd = dragonOf(bot)
    // причина отказа — строкой (в трассу bedFail), годится — true
    if (ctl.aborted) return 'прервано'
    if (!dd || phaseOf(bot, dd) !== PHASE.LANDING) return 'фаза'
    if (k >= f.path.length) return 'прогноз кончился'
    if (!bot.entity.onGround) return 'не на земле'
    if (q.distanceTo(rs.plan.feet) > 0.15) return `сдвинут ${r1(q.distanceTo(rs.plan.feet) * 10) / 10}`
    if (bot.health < 10) return 'мало хп'
    // свежий прогноз в миг щелчка: голова в тик взрыва далеко (rs6-s1: прогноз 1.3, по серверу 11.1 — урон 0.3) — кровать не тратить;
    // порог с запасом (rs7-s18: вето при 3.3 на раннем тике — цепочка оборвалась, дракон сел)
    { const kc = Math.round((tk.tClick + 25 - f.t) / 50); const st2 = f.path[Math.min(f.path.length - 1, Math.max(0, kc))]; const hd = st2 ? st2.head.distanceTo(tk.ctr) : null; if (RUN_LATEHEAD() && hd != null && hd > Math.max(6.5, tk.dClick + 3)) return `голова ${r1(hd)}` }
    if (landingHits({ path: f.path.slice(k, k + 3) }, q)) return 'коробки дракона'
    const v = virtualBot(bot, new Map([[`${rs.F.x},${rs.yb},${rs.F.z}`, 'bed'], [`${rs.H.x},${rs.yb},${rs.H.z}`, 'bed']]))
    const eye = q.offset(0, EYE, 0)
    if (!faceClick(v, eye, new Vec3(rs.F.x, rs.yb, rs.F.z), rs.plan.click.face)) return 'бок кровати не виден'
    if (!(RUN_FACING() ? faceClickFacing(bot, eye, new Vec3(rs.plan.place.K.x, rs.yb, rs.plan.place.K.z), rs.plan.place.face, { x: rs.H.x - rs.F.x, z: rs.H.z - rs.F.z }, { minCos: 0.75 }) : faceClick(bot, eye, new Vec3(rs.plan.place.K.x, rs.yb, rs.plan.place.K.z), rs.plan.place.face))) return 'грань K не видна'
    return true
  } : null, block: tk.useAn ? bot.blockAt(rs.Apos) : bot.blockAt(new Vec3(rs.plan.click.cell.x, rs.yb, rs.plan.click.cell.z)) }, 'снижение', { aimed: true, until: Math.max(tk.tClick, (stats.lastBoom || 0) + BED_GAP_MS), untilMono: tk.tClickMono, uncounted: true, ...(tk.pre ? { keepHand: true, prePlace: tk.pre } : {}), phCheck: p => p === PHASE.LANDING, note: { ...(tk.pre ? { pc: 1 } : {}), ...(rs.runnerLevels ? { runnerY: rs.yb, ...rs.seenNote(tk.clickI) } : {}), oc: tk.useAn ? 'PA' : 'P', pass: tk.clickI, headDist: r1(tk.dClick), fcT: tk.fc.t, fcWall: tk.fc.wallMs, tClick: tk.tClick, mono: tk.tClickMono != null, ...(tk.clickI !== tk.pass.i ? { early: tk.pass.i - tk.clickI } : {}) } })
  // кровать пропала без удара по дракону и без урона нам — её снесли коробки дракона (checkWalls), взрыва
  // не было: толчка нет, прогноз — свежий (pil6-15, pil6-21: «съеденная» кровать на последнем заходе)
  const eaten = r.ok && !tk.useAn && r.lagMs == null && !r.dmg && !r.self
  if (r.ok) rs.placedSince = false
  rs.out.booms.push(r.ok ? (eaten ? 'съели' : r.dmg) : null)
  if (!r.ok) (rs.out.fails || (rs.out.fails = [])).push(r.why)
  if (eaten) { rs.out.eaten = (rs.out.eaten || 0) + 1; rs.pushed = null; return 'next' }
  if (r.ok) {
    rs.lastBoom = stats.lastBoom || gameClock.now()
    rs.st.booms++
    const pf = pushedForecast(tk.fc, tk.clickI, tk.ctr, rs.plan.seen || 1, rs.P)
    rs.pushed = pf ? { fc: { ...pf, t: tk.fc.t }, after: gameClock.now() + 150 } : null
  } else if (!tk.useAn && !rs.bedHere()) { /* снесло — следующая */ }
}

export { clickLead }
