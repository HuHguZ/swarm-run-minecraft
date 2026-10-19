'use strict'
// Литьё одним ведром (cast1.ts): одна клетка рамы (вода → лава из озера → лава в клетку → вода назад) и сдвиг столба.
import * as gameClock from '../game-clock'
import { sleep, xyz } from '../movement'
import {
  OneCast, aimClear, clearLavaRay, climb, cnt, digOne, dumpLava, goG, late, regainWater, strayWater, syncH, topLeft, tr
} from './kit'
import { C, fluid, isAirB, keyOf, lakeReach, solid, useAt } from './geometry'
import { lavaInReach } from './plan'


export async function castCell (ox: OneCast, t) {
  const { p, bot, report, g, used, digKeys } = ox
  if ((bot.blockAt(t.c) || {}).name === 'obsidian') return { ok: true, already: true }
  // Мусор в клетке и в её воде (застыло камнем, не выкопано) — выкопать.
  for (const q of [t.c, t.w]) {
    const b = bot.blockAt(q)
    if (b && !isAirB(b) && !fluid(b)) { const w = await digOne(ox, q); if (w && !/огонь/.test(w)) return { ok: false, why: `клетка ${q.x},${q.y},${q.z} занята (${b.name}): ${w}` } }
  }
  if (!cnt(ox, 'water_bucket') && !(await regainWater(ox))) return { ok: false, fatal: true, why: 'воды в ведре нет' }
  // Всё — до воды: прицелы воды и лавы, источник в озере и луч к нему.
  const dbgWater = () => { const out = []; const o = g.G(0, 0); for (let dx = -5; dx <= 5; dx++) for (let dy = -2; dy <= 5; dy++) for (let dz = -5; dz <= 5; dz++) { const b = bot.blockAt(o.offset(dx, dy, dz)); if (b && /water/.test(b.name)) out.push(`${o.x + dx},${o.y + dy},${o.z + dz}:${C().levelOf(b)}`) } return out.join(' ') || 'нет' }
  if (process.env.ND_CAST1_DEBUG === '2') tr(ox, `до клетки ${t.c.x},${t.c.y},${t.c.z}: вода ${dbgWater()}`)
  const wa = await aimClear(ox, t.water, t.w)
  if (!wa.aim) return { ok: false, why: `вода: ${wa.why}` }
  if (process.env.ND_CAST1_DEBUG === '2') tr(ox, `прицел воды готов: вода ${dbgWater()}`)
  const ca = await aimClear(ox, t.lava, t.c)
  if (!ca.aim) return { ok: false, why: `лава: ${ca.why}` }
  let Ls = lavaInReach(bot, g, used, { high: ox.h > 0, keep: ox.h > 0 || ox.col !== 0 ? 0 : topLeft(ox), dig: digKeys })
  if (!Ls.length && ox.h > 0 && await clearLavaRay(ox)) Ls = lavaInReach(bot, g, used, { high: true })
  if (!Ls.length) { const R = lakeReach(p => bot.blockAt(p), g); return { ok: false, fatal: true, why: `${ox.h > 0 ? 'лавы со столба не достать' : 'лавы в досягаемости нет'} (ox.h ${ox.h}; источников по геометрии: с земли ${R.ground.size}, со столба ${R.top.size})` } }
  const L = Ls[0]
  const sAim = C().scoopAim(bot, t.w) || t.w.offset(0.5, 0.5, 0.5)
  // Четыре клика подряд: вода → черпак лавы → лава в клетку → вода назад.
  const t1 = gameClock.now()
  if (!(await useAt(bot, wa.aim, 'water_bucket'))) return { ok: false, why: 'ведро воды не опустело — луч упёрся не туда' }
  const st = [gameClock.now() - t1]
  if (!(await useAt(bot, L.aim, 'bucket')) || !cnt(ox, 'lava_bucket')) {
    used.add(keyOf(L.p))
    if (!cnt(ox, 'water_bucket')) await useAt(bot, sAim, 'bucket')
    if (!cnt(ox, 'water_bucket')) await regainWater(ox)
    return { ok: false, why: `лава ${L.p.x},${L.p.y},${L.p.z} не зачерпнулась` }
  }
  used.add(keyOf(L.p))
  report.refills++
  st.push(gameClock.now() - t1)
  if (!(await useAt(bot, ca.aim, 'lava_bucket'))) {
    await dumpLava(ox)
    await useAt(bot, sAim, 'bucket')
    if (!cnt(ox, 'water_bucket')) await regainWater(ox)
    return { ok: false, why: 'лава не вылилась в клетку' }
  }
  st.push(gameClock.now() - t1)
  let nowC = bot.blockAt(t.c)
  if (!nowC || nowC.name !== 'obsidian') {
    const tq = gameClock.now()
    while (gameClock.now() - tq < 120 && (bot.blockAt(t.c) || {}).name !== 'obsidian') await sleep(10)
    nowC = bot.blockAt(t.c)
  }
  if (nowC && nowC.name === 'obsidian') {
    let back = await useAt(bot, sAim, 'bucket')
    const win = gameClock.now() - t1
    const wb = bot.blockAt(t.w)
    const dbg = [`шаги ${st.join('/')}/${win} мс, w ${wb ? wb.name : '?'}${wb && /water/.test(wb.name) ? C().levelOf(wb) : ''}, вёдра в${cnt(ox, 'water_bucket')} л${cnt(ox, 'lava_bucket')} п${cnt(ox, 'bucket')}`]
    if (process.env.ND_CAST1_DEBUG === '1') { await sleep(300); const wb2 = bot.blockAt(t.w); const ch = []; for (let i = -1; i <= 2; i++) for (let j = -1; j <= 4; j++) { const b = bot.blockAt(g.F(i, j)); if (b && /water/.test(b.name)) ch.push(`F${i},${j}:${C().levelOf(b)}`) } dbg.push(`через 300 мс w ${wb2 ? wb2.name : '?'}; жёлоб ${ch.join(' ') || 'сух'}; вне ${strayWater(ox).length}`) }
    if (!back || !cnt(ox, 'water_bucket')) back = await regainWater(ox)
    report.cast.push(xyz(t.c))
    report.win = Math.max(report.win || 0, win)
    if (!back) return { ok: false, fatal: true, why: `свою воду не забрал (${t.w.x},${t.w.y},${t.w.z})` }
    return { ok: true, win, dbg: dbg.join('; ') }
  }
  // Не застыла: вода легла не туда. Лаву из клетки — в ведро и в озеро, воду найти.
  const lb = bot.blockAt(t.c)
  tr(ox, `лава не застыла в ${t.c.x},${t.c.y},${t.c.z} (${lb && lb.name}); у w ${(bot.blockAt(t.w) || {}).name}`)
  if (lb && lb.name === 'lava') { const a = C().scoopAim(bot, t.c); if (a) await useAt(bot, a, 'bucket') }
  await dumpLava(ox)
  if (!cnt(ox, 'water_bucket')) await regainWater(ox)
  if (cnt(ox, 'lava_bucket')) return { ok: false, fatal: true, why: 'лава не застыла, в ведре лава' }
  return { ok: false, why: 'лава не застыла (вода не рядом?)' }
}

// want — высота тела для клетки: 2 — столб (верх рамы), 0 — с земли (низ рамы: лава у G(0) кончилась — s8b-b2-4: рама 5/10,
// «лавы в досягаемости нет (h 0)»; с G(±1) с земли достаются и низ, и стойки).
export async function shiftPillar (ox: OneCast, want = 2) {
  const { ctl, bot, report, g, used, shifted } = ox
  if (process.env.ND_CAST1_SHIFT === '0') return false
  for (const k of [1, -1]) {
    if (shifted.has(k) || late(ox)) continue
    shifted.add(k)
    const S = g.G(k, 0)
    const free = [0, 1, 2, 3].every(j => { const b = bot.blockAt(g.G(k, j)); return !!b && !fluid(b) && (isAirB(b) || b.boundingBox === 'empty') })
    if (!solid(bot.blockAt(g.G(k, -1))) || !free) { tr(ox, `столб в ${S.x},${S.z}: место занято`); continue }
    if (ox.h > 0) await C().descend(bot, ctl, ox.pc.y, report)
    syncH(ox)
    if (ox.h > 0) return false
    const back = { col: ox.col, pc: ox.pc }
    ox.col = k; ox.pc = S
    if (!(await goG(ox, k))) { ({ col: ox.col, pc: ox.pc } = back); tr(ox, `столб в ${S.x},${S.z}: не дошёл`); continue }
    await C().centreOn(bot, ctl, S)
    const w = want > 0 ? await climb(ox, want) : null
    if (w) { tr(ox, `столб в ${S.x},${S.z}: ${w}`); syncH(ox); if (ox.h > 0) await C().descend(bot, ctl, ox.pc.y, report); syncH(ox); continue }
    const n = lavaInReach(bot, g, used, { high: true }).length
    tr(ox, `${want > 0 ? 'столб сдвинут' : 'место сдвинуто'} в ${S.x},${S.z}: лавы ${want > 0 ? 'со столба' : 'с земли'} ${n}`)
    if (n) { report.shifted = (report.shifted || 0) + 1; return true }
  }
  return false
}
