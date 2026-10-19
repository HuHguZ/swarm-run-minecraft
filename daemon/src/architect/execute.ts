'use strict'
import * as gameClock from '../game-clock'
import { goals } from 'mineflayer-pathfinder'
import { xyz } from '../movement'
import * as bp from '../blueprint'
import { AIR, FLUID, V, HORIZ, sleep, isSolid, holds, propsOf, isDone, eyeOf, centre, inReach, bodyInCell, squatter, insideBox } from './world'
import { boxOf } from './plan'
import { saveJob } from './estimate'
import { buildMovements, walk, standSpots, reachMap, canWalkOut } from './reach'
import { putCell, digAt, onTower, towerFor, descend, sweepTower } from './hands'
import { onceSignEditor, writeSign } from './signs'

// ---------------------------------------------------------------- execute

async function execute (session, ctl, job, cells, { deadline }: any) {
  const bot = session.bot
  const t0 = gameClock.now()
  const byKey = new Map(cells.map(c => [c.key, c]))
  const box = boxOf(cells)
  const stats: any = { placed: 0, dug: 0, scaffold: 0, redo: 0 }
  // Куда ушло время: без этого «медленно» не разобрать на ходьбу и на руки.
  const clock = { walk: 0, walks: 0, place: 0, dig: 0 }
  const timed = async (k, fn) => { const t = gameClock.now(); try { return await fn() } finally { clock[k] += gameClock.now() - t } }
  const skipped = new Map()
  const tries = new Map()
  const missing = new Set()
  const crooked = new Set()
  let unloaded = 0
  const hardSkip = new Set()
  const towerTries = new Map()
  const walkedTo = new Map()
  let focus = null
  const ctx: any = {
    byKey,
    box,
    stats,
    pendingSolid: new Set(),
    pendingAir: new Set(),
    planNeeds: {},
    towers: job.towers || (job.towers = []),
    saveTowers: () => saveJob(session, job)
  }
  let stopped = null

  bot.pathfinder.setMovements(buildMovements(bot))
  ctl.onAbort.push(() => { try { bot.pathfinder.setGoal(null) } catch {}; try { bot.setControlState('sneak', false) } catch {} })

  const fail = (c, why, hard = false) => {
    const n = (tries.get(c.key) || 0) + 1
    tries.set(c.key, n)
    c.lastWhy = why
    if (hard || n >= 3) skipped.set(c.key, why)
    if (hard) hardSkip.add(c.key)
    const at = bot.entity.position
    console.log(`[build] ${c.key} ${c.name} #${n}: ${why} (я ${at.x.toFixed(1)},${at.y.toFixed(1)},${at.z.toFixed(1)})`)
  }

  // Прошлый вызов оборвался на лесах — сначала слезть и прибрать.
  for (const t of [...ctx.towers]) {
    if (onTower(bot, t)) await descend(bot, t, ctx)
    else await sweepTower(bot, t, ctx)
  }
  let tower = null

  // Своя дверь уже стоит (прошлый вызов дошёл до неё), а работы ещё есть —
  // снять её: pathfinder дверей не открывает. В конце она встанет снова.
  let reopened = 0
  const leftWork = cells.some(c => c.kind !== 'door' && c.kind !== 'part' && !isDone(bot, c))
  for (const d of cells.filter(c => c.kind === 'door' && isDone(bot, c))) {
    if (!leftWork || ctl.aborted) break
    if (!inReach(bot, d)) await walk(bot, new goals.GoalNear(d.pos.x, d.pos.y, d.pos.z, 2), 12000)
    if (inReach(bot, d)) {
      const r = await digAt(bot, d.pos)
      if (r.ok) reopened++
      // Верхнюю половину сервер снимает отдельным обновлением, чуть позже нижней:
      // карта «куда дойду», снятая раньше, видит проём закрытым.
      const up = d.pos.offset(0, 1, 0)
      for (let i = 0; i < 30 && !AIR.has((bot.blockAt(up) || {}).name); i++) await sleep(50)
    }
  }

  const refresh = () => {
    ctx.pendingSolid.clear(); ctx.pendingAir.clear()
    const need = {}
    const pending = []
    // Клетки под своими лесами — не работа: столб снимется сам, спускаясь.
    const scaffolded = p => ctx.towers.some(t => p.x === t.x && p.z === t.z && p.y >= t.base && p.y <= t.top)
    for (const c of cells) {
      if (c.kind === 'part') continue
      if (isDone(bot, c)) continue
      if (scaffolded(c.pos)) continue
      if (skipped.has(c.key)) continue
      pending.push(c)
      if (c.kind === 'air') ctx.pendingAir.add(c.key)
      else {
        ctx.pendingSolid.add(c.key)
        need[c.item] = (need[c.item] || 0) + 1
      }
    }
    // Вторая половина двери и кровати — тоже будущий блок.
    for (const c of pending) if (c.pair && c.kind !== 'air') ctx.pendingSolid.add(c.pair)
    ctx.planNeeds = need
    return pending
  }

  const ready = c => {
    const b = bot.blockAt(c.pos)
    if (!b) return false
    if (c.kind === 'air') return true
    const opts = c.kind === 'wall' || c.kind === 'lantern'
      ? [c.support || 'down']
      : c.kind === 'floor' || c.kind === 'door' || c.kind === 'bed' ? ['down'] : ['down', ...HORIZ, 'up']
    return opts.some(d => {
      const n = bot.blockAt(c.pos.plus(V[d]))
      return (c.kind === 'wall' || c.kind === 'floor' || c.kind === 'lantern') ? holds(c, n) : isSolid(n)
    })
  }

  while (!ctl.aborted) {
    if (gameClock.now() > deadline - (tower ? 9000 : 2500)) { stopped = 'время вышло'; break }
    const pending = refresh()
    if (!pending.length) break
    const phase = Math.min(...pending.map(c => c.phase))
    const layer = pending.filter(c => c.phase === phase)
    const workable = layer.filter(c => ready(c) && !missing.has(c.item))
    for (const c of layer) {
      if (c.kind !== 'air' && missing.has(c.item)) { skipped.set(c.key, `нет ${c.item}`); hardSkip.add(c.key) }
    }
    // Дверь — последней и только когда внутри доделано: pathfinder дверей не
    // открывает, и с дверью на месте следующий вызов внутрь уже не войдёт.
    if (phase === bp.PHASE.door) {
      const unfinished = [...skipped.keys()].filter(k => !hardSkip.has(k) && byKey.get(k) && (byKey.get(k) as any).phase < bp.PHASE.door)
      if (unfinished.length) {
        for (const c of layer) skipped.set(c.key, `дверь не ставлю: не достроено ${unfinished.length} клеток, проём оставил, чтобы войти`)
        continue
      }
    }
    if (!workable.length) {
      // Чанк выгрузился (ушли далеко на леса или за угол) — подождать, а не списывать.
      if (layer.some(c => !bot.blockAt(c.pos)) && (unloaded++ < 20)) { await sleep(500); continue }
      for (const c of layer) {
        if (skipped.has(c.key)) continue
        skipped.set(c.key, c.kind === 'wall' ? 'опоры для неё нет' : 'висит в воздухе: прислонить не к чему')
        hardSkip.add(c.key)
      }
      continue
    }

    // Порядок: копать сверху вниз (осыпь падает в уже пустое), ставить снизу
    // вверх полосой в три ряда — чтобы с одного места ложилась вся колонка.
    let band
    if (phase === bp.PHASE.clear) {
      const top = Math.max(...workable.map(c => c.pos.y))
      band = workable.filter(c => c.pos.y >= top - 2)
    } else {
      const low = Math.min(...workable.map(c => c.pos.y))
      band = workable.filter(c => c.pos.y <= low + 2)
    }
    const me = bot.entity.position
    const byDist = (a, b) => (phase === bp.PHASE.clear ? b.pos.y - a.pos.y : a.pos.y - b.pos.y) || centre(a.pos).distanceTo(me) - centre(b.pos).distanceTo(me)
    const reachable = c => inReach(bot, c) && !bodyInCell(bot, c.pos) &&
      !(c.pair && byKey.get(c.pair) && bodyInCell(bot, (byKey.get(c.pair) as any).pos)) &&
      !(bot.entity.position.floored().offset(0, -1, 0).equals(c.pos))
    // Сначала то, что уже в руке: смена предмета — это клик по окну и круг до сервера.
    const held = bot.heldItem ? bot.heldItem.name : null
    const inHand = (a, b) => ((b.item === held) as any) - ((a.item === held) as any)
    let target = null
    // Леса ставились под конкретную клетку — её и первой, не перебирая заново.
    if (focus) {
      const f = pending.find(c => c.key === focus)
      if (f && reachable(f)) target = f
      else if (f) console.log(`[build] под ${f.key} встал на леса, а не достаю: до глаз ${eyeOf(bot).distanceTo(centre(f.pos)).toFixed(2)}, тело ${bodyInCell(bot, f.pos)}`)
      focus = null
    }
    if (!target) target = band.filter(reachable).sort((a, b) => (phase === bp.PHASE.clear ? 0 : inHand(a, b)) || byDist(a, b))[0]
    if (!target && tower) target = workable.filter(reachable).sort(byDist)[0]

    if (!target) {
      if (tower) {
        const b0 = band[0]
        const e = bot.entity.position
        console.log(`[build] с лесов ${tower.x},${tower.top},${tower.z} больше не достать: в полосе ${band.length} (${b0.key} до глаз ${eyeOf(bot).distanceTo(centre(b0.pos)).toFixed(2)}, тело в клетке ${bodyInCell(bot, b0.pos)}), готовых ${workable.length}, я ${e.x.toFixed(2)},${e.y.toFixed(2)},${e.z.toFixed(2)}`)
        await descend(bot, tower, ctx); tower = null; continue
      }
      const near = (a, b) => centre(a.pos).distanceTo(me) - centre(b.pos).distanceTo(me)
      const goal = band.slice().sort((a, b) => (tries.get(a.key) || 0) - (tries.get(b.key) || 0) || near(a, b))[0]
      ctx.reach = reachMap(bot, box)
      const spots = standSpots(bot, goal, ctx, { band })
      let there = false
      for (const s of spots.slice(0, 3)) {
        if (ctl.aborted) break
        clock.walks++
        await timed('walk', () => walk(bot, new goals.GoalBlock(s.p.x, s.p.y, s.p.z), 12000))
        if (reachable(goal)) { there = true; break }
      }
      if (ctl.aborted) continue
      if (there) { walkedTo.set(goal.key, (walkedTo.get(goal.key) || 0) + 1); if (walkedTo.get(goal.key) > 3) fail(goal, 'дохожу, а взять не выходит', true); continue }
      // Леса — только когда клетка правда высоко. Низкая, до которой не
      // дошли, — это дорога, а не рост, и столб её не решит.
      if (spots.length && goal.pos.y - bot.entity.position.floored().y < 4) {
        fail(goal, 'не дошёл до места, откуда достать')
        continue
      }
      const up = await towerFor(bot, ctl, goal, ctx)
      if (up.ok) {
        tower = up.tower
        focus = goal.key
        const n = (towerTries.get(goal.key) || 0) + 1
        towerTries.set(goal.key, n)
        // Леса под одну и ту же клетку в третий раз — дело не в высоте.
        if (n > 2) fail(goal, 'и с лесов не выходит поставить', true)
        continue
      }
      fail(goal, spots.length ? `не дошёл, куда встать (${up.why})` : `встать некуда: ${up.why}`)
      continue
    }

    // --- работа над клеткой
    const c = target
    if (c.kind === 'air') {
      const r = await timed('dig', () => digAt(bot, c.pos))
      if (r.ok) { if (!r.already) stats.dug++ } else fail(c, r.why, r.hard)
      continue
    }
    const who = squatter(bot, c.pos)
    if (who) { fail(c, `в клетке стоит ${who}`); await sleep(400); continue }

    // Чужой блок на месте — убрать. Заделку (seal) твёрдое устраивает всегда.
    const w = bot.blockAt(c.pos)
    if (w && !AIR.has(w.name)) {
      if (FLUID.test(w.name)) { fail(c, `в клетке ${w.name}`, true); continue }
      const r = await timed('dig', () => digAt(bot, c.pos))
      if (!r.ok) { fail(c, `мешает ${w.name}: ${r.why}`, r.hard); continue }
      if (w.name === c.name) stats.redo++
    }
    if (c.pair) {
      const pc: any = byKey.get(c.pair)
      const pw = pc && bot.blockAt(pc.pos)
      if (pw && !AIR.has(pw.name)) {
        const r = await digAt(bot, pc.pos)
        if (!r.ok) { fail(c, `вторая клетка занята ${pw.name}`, r.hard); continue }
      }
    }
    // Не замуровать себя: пока тело внутри, после этого блока выход должен остаться.
    const feet = bot.entity.position.floored()
    // Выход закрывают только клетки на уровне ног и головы (и та, что над ней,
    // — для прыжка): поиск пути наружу — десятки мс, и на крышу его не тратим.
    // Факел, табличка, фонарь, лестница проход не закрывают — их не проверяем.
    const blocks = !(c.kind === 'wall' || c.kind === 'floor' || c.kind === 'lantern')
    if (blocks && insideBox(feet, box) && c.pos.y >= feet.y - 1 && c.pos.y <= feet.y + 2) {
      const extra = new Set([c.key])
      if (c.pair) extra.add(c.pair)
      if (!canWalkOut(bot, box, extra)) {
        // Стою на своих лесах — сперва слезть: столб в клетке за проёмом сам
        // закрывает выход (так и было: леса под конёк встали прямо за дверью).
        if (tower) { await descend(bot, tower, ctx); tower = null; continue }
        ctx.reach = reachMap(bot, box)
        const out = standSpots(bot, c, ctx, { outside: box })
        let moved = false
        for (const s of out.slice(0, 3)) {
          await walk(bot, new goals.GoalBlock(s.p.x, s.p.y, s.p.z), 15000)
          if (!insideBox(bot.entity.position.floored(), box) && inReach(bot, c)) { moved = true; break }
        }
        if (!moved) { fail(c, 'замуровал бы себя изнутри: снаружи до клетки не дотянуться'); continue }
      }
    }

    const sign: any = c.text && c.text.length ? onceSignEditor(bot, 2500) : null
    const r = await timed('place', () => putCell(bot, c, { onSign: sign ? () => sign : null }))
    if (!r.ok) {
      if (sign) sign.cancel()
      if (r.noItem) { missing.add(c.item); fail(c, r.why, true) } else fail(c, r.why)
      continue
    }
    stats.placed++
    if (!r.match) {
      // Встал, но не тем боком. Один повтор (следующий круг выкопает и
      // поставит снова), потом — как есть, с причиной: иначе круг вечный.
      const got = JSON.stringify(propsOf(bot.blockAt(c.pos)))
      if (crooked.has(c.key)) skipped.set(c.key, `встал не тем боком: ${got}`)
      else { crooked.add(c.key); c.lastWhy = `встал не тем боком: ${got}` }
      continue
    }
    if (sign) {
      const s = await writeSign(bot, c.pos, c.text, { opened: sign })
      if (!s.ok) c.signWhy = s.why
      else stats.signs = (stats.signs || 0) + 1
    }
  }

  if (tower && !ctl.aborted) await descend(bot, tower, ctx)
  try { session.updateMovements(true) } catch {}

  const unfinished = cells.filter(c => c.kind !== 'part' && !isDone(bot, c))
  // Необязательное (мебель, свет, окна), чего нет в рюкзаке, — не недострой,
  // а пропуск с причиной: дом без кровати всё равно дом.
  const lacking = unfinished.filter(c => c.optional && missing.has(c.item))
  const left = unfinished.filter(c => !lacking.includes(c))
  const optionalMissing = {}
  for (const c of lacking) optionalMissing[c.item] = (optionalMissing[c.item] || 0) + 1
  const why = {}
  for (const c of left) {
    const w = skipped.get(c.key) || c.lastWhy || 'не дошли руки'
    why[w] = (why[w] || 0) + 1
  }
  const skippedAt = left.filter(c => skipped.has(c.key)).slice(0, 6)
    .map(c => ({ at: xyz(c.pos), block: c.name, why: skipped.get(c.key) }))
  const signFails = cells.filter(c => c.signWhy).map(c => ({ at: xyz(c.pos), why: c.signWhy }))
  const walledIn = insideBox(bot.entity.position.floored(), box) && !canWalkOut(bot, box, new Set())
  return {
    placed: stats.placed,
    dug: stats.dug,
    optionalMissing: Object.keys(optionalMissing).length ? optionalMissing : undefined,
    redo: stats.redo || undefined,
    reopened: reopened || undefined,
    scaffold: stats.scaffold || undefined,
    towersLeft: ctx.towers.length ? ctx.towers.map(t => ({ x: t.x, z: t.z, from: t.base, to: t.top })) : undefined,
    left: left.length,
    skipped: skipped.size,
    why: Object.keys(why).length ? why : undefined,
    skippedAt: skippedAt.length ? skippedAt : undefined,
    signs: stats.signs || undefined,
    signFails: signFails.length ? signFails : undefined,
    missing: missing.size ? [...missing] : undefined,
    walledIn: walledIn || undefined,
    stopped,
    seconds: Math.round((gameClock.now() - t0) / 1000),
    timing: { walk: Math.round(clock.walk / 1000), walks: clock.walks, place: Math.round(clock.place / 1000), dig: Math.round(clock.dig / 1000) }
  }
}

export { execute }
