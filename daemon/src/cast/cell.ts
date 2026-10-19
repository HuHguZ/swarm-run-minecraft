'use strict'
// Литьё портала (cast.ts): одна клетка рамы — лава на опору, вода к ней, обсидиан.
import { equipBestTool } from '../items'
import { placeBlockAt } from '../build'
import { sleep, xyz } from '../movement'
import * as gameClock from '../game-clock'
import { UP, countOf, digVisible, isEmptyish, isSolid, levelOf } from './base'
import { ensureWater, refillLava, stand } from './walk'
import { pour, scoop, scoopAim } from './bucket'


// ---------------------------------------------------------------- одна клетка

// Отлить клетку cell: лава на грань lavaRef, вода на грань waterRef (вверх),
// стоя в (col, h). Возвращает { ok } или { why }.
export async function castCell (session, ctl, g, t, report) {
  const bot = session.bot
  const cell = t.cell
  let b = bot.blockAt(cell)
  if (b && b.name === 'obsidian') return { ok: true, already: true }
  // Застыло камнем (текла лава) или мусор — выкопать и лить заново.
  if (b && !isEmptyish(b) && !/lava/.test(b.name)) {
    try { await equipBestTool(bot, b); await digVisible(bot, b, 6000); report.dug++ } catch {}
    b = bot.blockAt(cell)
  }
  const lavaHere = b && b.name === 'lava' && levelOf(b) === 0
  if (!lavaHere && !countOf(bot, 'lava_bucket')) {
    const s0 = await stand(session, ctl, g, t.col, -1, report)
    if (!s0.ok) return { ok: false, why: s0.why }
    if (!(await refillLava(session, ctl, report))) return { ok: false, fatal: process.env.ND_OW_KIT_FRAME !== '0', why: 'лава кончилась: зачерпнуть не вышло' }
  }
  if (!(await ensureWater(session, ctl))) return { ok: false, why: 'нет воды в ведре' }
  const s = await stand(session, ctl, g, t.col, t.h, report)
  if (!s.ok) return { ok: false, why: s.why }
  // Опора под лаву пропала (pathfinder копает по пути; угол и подпорка —
  // булыжник) — поставить заново, а не мазать лучом мимо.
  if (!lavaHere && !isSolid(bot.blockAt(t.lavaRef))) {
    const r = await placeBlockAt(bot, t.lavaRef, { steady: true })
    if (r.ok) report.placed++
    else return { ok: false, why: `опоры под лаву нет на ${t.lavaRef.x},${t.lavaRef.y},${t.lavaRef.z}: ${r.reason}` }
  }
  if (!lavaHere) {
    const l = await pour(bot, 'lava_bucket', t.lavaRef)
    if (!l.ok) return { ok: false, why: `лава: ${l.why}` }
  }
  // Вода рядом уже была (текущая с прошлого шага) — застыло сразу.
  await sleep(150)
  if ((bot.blockAt(cell) || {}).name !== 'obsidian') {
    const w = await pour(bot, 'water_bucket', t.waterRef)
    if (!w.ok) {
      // Вода не легла — лава рядом с телом растечётся через полторы секунды:
      // черпнуть её обратно тем же (теперь пустым) ведром.
      await scoop(bot, cell, 'lava')
      return { ok: false, why: `вода: ${w.why}` }
    }
    const t0 = gameClock.now()
    while (gameClock.now() - t0 < 1500 && (bot.blockAt(cell) || {}).name !== 'obsidian') await sleep(50)
    const b2 = bot.blockAt(cell)
    if (b2 && b2.name === 'lava') {
      // Легла не туда (луч задел другую грань) — воду назад, лаву назад.
      await scoop(bot, t.waterRef.plus(UP), 'water')
      await scoop(bot, cell, 'lava')
      return { ok: false, why: 'вода легла не рядом с лавой — забрал обе' }
    }
  }
  // Вычерпать свою воду (она в клетке над waterRef) — иначе растечётся.
  const wc = t.waterRef.plus(UP)
  if (!(await scoop(bot, wc, 'water'))) {
    await sleep(200)
    if (!(await scoop(bot, wc, 'water'))) {
      const wb = bot.blockAt(wc)
      const me = bot.entity.position
      return { ok: false, fatal: true, why: `свою воду не забрал (${wc.x},${wc.y},${wc.z}: ${wb ? wb.name : '?'} ур. ${levelOf(wb)}; тело ${me.x.toFixed(1)},${me.y.toFixed(1)},${me.z.toFixed(1)}; прицел ${scoopAim(bot, wc) ? 'есть' : 'нет'}) — литьё остановлено` }
    }
  }
  await sleep(500)
  const now = bot.blockAt(cell)
  if (now && now.name === 'obsidian') { report.cast.push(xyz(cell)); return { ok: true } }
  return { ok: false, why: `на ${cell.x},${cell.y},${cell.z} вышло ${now ? now.name : '?'}` }
}
