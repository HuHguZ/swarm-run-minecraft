'use strict'
// Шерсть на кровать: овцы на виду, цвет, стрижка или убой.
import * as gameClock from '../game-clock'
import { goals } from 'mineflayer-pathfinder'
import { withTimeout } from '../build'
import { countOf, approach, visible, holdOne, sleep } from './basics'

// ---------------------------------------------------------------- шерсть на кровать
//
// Кровать до ночи (поток route, 03.10: 17 из 24 смертей маршрута — ночью, кровать к 10-й мин была в 7 прогонах из 48).
// Рецепт *_bed 1.21.11 — 3 шерсти ОДНОГО цвета + 3 доски. С 1.21.5 цвет овцы зависит от биома (тёплые — больше
// коричневых, холодные — чёрных), поэтому цвет выбираем по стаду на виду, а не «белая».
// Sheep (1.21.11): метаданные 16 — детёныш, 17 — байт шерсти (цвет & 0x0F, острижена 0x10). Убитая неостриженная
// взрослая овца роняет 1 шерсть своего цвета; ножницы (Sheep.shear) — 1–3 шерсти, овца живёт и не убегает.
export const WOOL_COLORS = ['white', 'orange', 'magenta', 'light_blue', 'yellow', 'lime', 'pink', 'gray', 'light_gray', 'cyan', 'purple', 'blue', 'brown', 'green', 'red', 'black']
function sheepInfo (bot, e) {
  const b = e.metadata && typeof e.metadata[17] === 'number' ? e.metadata[17] : 0
  return { e, color: WOOL_COLORS[b & 15], sheared: (b & 16) !== 0, baby: e.metadata && e.metadata[16] === true, d: e.position.distanceTo(bot.entity.position) }
}
export function sheepAround (bot, radius = 40) {
  const me = bot.entity.position
  return (Object.values(bot.entities) as any[])
    .filter((e : any) => e && e.name === 'sheep' && e.position && e.position.distanceTo(me) <= radius)
    .map(e => sheepInfo(bot, e))
    .filter(s => !s.sheared && !s.baby)
}
// Цвет: тот, шерсть которого уже есть (и его овцы рядом), иначе — самого большого стада на виду.
function woolColorPick (bot, list, want) {
  const held = WOOL_COLORS.map(c => ({ c, n: countOf(bot, `${c}_wool`) })).filter(x => x.n > 0).sort((a, b) => b.n - a.n)
  const by = {}
  for (const s of list) by[s.color] = (by[s.color] || 0) + 1
  // Уже есть шерсть цвета, и его овцы на виду — добирать его (h.n + овец ≥ want или их больше прочих).
  for (const h of held) if (by[h.c] && (h.n + by[h.c] >= want || by[h.c] >= Math.max(0, ...(Object.values(by) as any[])))) return h.c
  return (Object.entries(by) as [string, any][]).sort((a: any, b: any) => b[1] - a[1])[0]?.[0] || null
}
export async function wool (session, ctl, { count = 3, radius = 40, x = null, z = null, timeoutSeconds = 90, color = null }: any = {}) {
  const bot = session.bot
  const combat: typeof import('../combat') = require('../combat')
  const actions: typeof import('../actions') = require('../actions')
  const t0 = gameClock.now()
  const out: any = { color: null, killed: 0, sheared: 0, seen: 0, steps: [] }
  const step = s => { out.steps.push(`${Math.round((gameClock.now() - t0) / 100) / 10}с ${s}`) }
  const deadline = t0 + Math.max(10, Math.min(240, timeoutSeconds)) * 1000
  // К стаду по карте (скан копии: овцы при генерации) — если его не видно отсюда.
  if (Number.isFinite(x) && Number.isFinite(z) && !sheepAround(bot, radius).length) {
    const far = Math.hypot(bot.entity.position.x - x, bot.entity.position.z - z)
    if (far > 12) {
      step(`к стаду по карте ${Math.round(far)} бл.`)
      try { await withTimeout(bot.pathfinder.goto(new goals.GoalNearXZ(x, z, 8)), Math.min(60000, deadline - gameClock.now()), 'путь к стаду') } catch (e) { step(`путь: ${String(e.message).slice(0, 60)}`) }
    }
  }
  const done = () => out.color && countOf(bot, `${out.color}_wool`) >= count
  let misses = 0
  // Овца, с которой не вышло (не дошёл, в яме, за водой), — мимо: следующая того же цвета.
  const skip = new Set()
  while (!ctl.aborted && gameClock.now() < deadline && !done()) {
    const list = sheepAround(bot, radius).filter(s => !skip.has(s.e.id))
    out.seen = Math.max(out.seen, list.length)
    const c = color || out.color || woolColorPick(bot, list, count)
    if (!c) { step('овец на виду нет'); break }
    out.color = c
    const mine = list.filter(s => s.color === c).sort((a, b) => a.d - b.d)
    if (!mine.length) { step(`${c}: овец этого цвета больше нет`); break }
    // Без ножниц овца даёт 1 шерсть: овец цвета + своя шерсть < count — кровати не будет, время не тратить.
    if (!countOf(bot, 'shears') && mine.length + countOf(bot, `${c}_wool`) < count) {
      // Отложенные «не дошёл» — ещё раз, один раз (овца ушла с обрыва/из-за воды, теперь, может, рядом).
      if (skip.size && !out.retried) { out.retried = true; skip.clear(); step(`${c}: мало без отложенных — пробую их снова`); continue }
      step(`${c}: овец ${mine.length}, шерсти ${countOf(bot, `${c}_wool`)} — на кровать мало`); break
    }
    const s = mine[0]
    const before = countOf(bot, `${c}_wool`)
    if (countOf(bot, 'shears') > 0) {
      // Ножницы: подойти, рука — ножницы, клик по овце (use_entity), подобрать 1–3 шерсти.
      if (!(await approach(bot, ctl, s.e, 2.0, 15000)) || !visible(bot, s.e)) { misses++; skip.add(s.e.id); step(`${c}: не подошёл`); if (misses >= 3) break; continue }
      await holdOne(bot, ['shears'])
      try { await bot.lookAt(s.e.position.offset(0, (s.e.height || 1) * 0.6, 0), true) } catch {}
      try { bot.activateEntity(s.e) } catch (e) { step(`ножницы: ${String(e.message).slice(0, 50)}`) }
      await sleep(500, ctl)
      await actions.collectNearbyDrops(bot, ctl, { radius: 6, timeoutMs: 3000 })
      if (countOf(bot, `${c}_wool`) > before) { out.sheared++; step(`${c}: острижена +${countOf(bot, `${c}_wool`) - before}`) } else { misses++; step(`${c}: стрижка без шерсти`) }
    } else {
      let r = null
      // Сперва дойти (путь есть — овца не в яме/за водой), потом бой: бой сам за дальней овцой ходит до 20 с впустую.
      // Дальняя — сперва дойти (бой сам за ней ходит недолго); ближнюю (≤ 10) бой догоняет сам. rt3-A1: «не дошёл (7–15 бл.)»
      // за 12 с у двух стад — шаг кровати сорвался, хотя овцы были рядом.
      // Дальняя: сперва к месту овцы статичной целью (GoalFollow за идущей овцой пересчитывал путь и «не дошёл» за 20 с у
      // 3 овец подряд — rt3-V1), потом догон.
      if (s.d > 10) {
        const p0 = s.e.position.clone()
        try { await withTimeout(bot.pathfinder.goto(new goals.GoalNear(p0.x, p0.y, p0.z, 3)), 15000, 'путь к овце') } catch {}
        try { bot.pathfinder.setGoal(null) } catch {}
      }
      if (s.e.position.distanceTo(bot.entity.position) > 8 && !(await approach(bot, ctl, s.e, 2.5, 10000))) { misses++; skip.add(s.e.id); step(`${c}: не дошёл (${Math.round(s.d)} бл.)`); if (misses >= 3) break; continue }
      try { r = await combat.fight(session, ctl, { target: `#${s.e.id}`, purpose: 'command', timeoutSeconds: 20, retreatAtHealth: 4, allowRanged: false }) } catch (e) { step(`бой: ${String(e.message).slice(0, 60)}`) }
      await actions.collectNearbyDrops(bot, ctl, { radius: 6, timeoutMs: 3000 })
      if (countOf(bot, `${c}_wool`) > before) { out.killed++; step(`${c}: овца +1`) } else { misses++; skip.add(s.e.id); step(`${c}: шерсти нет (${Math.round(s.d)} бл.; ${r ? String(r.stopped || r.note || r.reason || Object.keys(r).join(',')).slice(0, 70) : 'нет ответа'})`) }
    }
    if (misses >= 3) break
  }
  out.wool = out.color ? countOf(bot, `${out.color}_wool`) : 0
  out.ok = !!done()
  out.seconds = Math.round((gameClock.now() - t0) / 1000)
  return out
}
