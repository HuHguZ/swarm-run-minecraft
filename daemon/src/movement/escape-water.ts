'use strict'
// Ходьба: выход из воды на сушу вплавь, с воздухом и бюджетом.
import * as gameClock from '../game-clock'
const Vec3: typeof import('vec3').Vec3 = require('vec3')
import * as geometry from '../navigation/geometry'
import { sleep, xyz } from './basics'
import { inWater, findSwimRoute, headWet, dryFooting, airTicks, idleBreath, airAbove, swimUpTicks, waterCell, breathCell } from './water'
import { lazyBuild, lazyItems, lazyPick } from './lazy'

// Follow the connected swim route with manual controls: the old direct line to
// the bank could point through a wall while jump stayed stuck under a roof.
// Итог escapeWater: был ли в воде, вышел ли, куда плыл (target) и разбор выхода (exit, kind, eye, feet…).
interface WaterEscape { ok: boolean; wasInWater: boolean; error?: string; target?: { x: number; y: number; z: number } | null; [key: string]: any }
export async function escapeWater (bot, ctl, { timeoutMs = 25000, visibleOnly = false, radius = 8 }: any = {}): Promise<WaterEscape> {
  if (!inWater(bot)) return { ok: true, wasInWater: false, error: undefined }

  try { bot.pathfinder.setGoal(null) } catch {}
  const deadline = gameClock.now() + timeoutMs
  let target = null
  let exit = 'dry', loops = 0, kind = null, breathBudget = null, etaTicks = null
  const budget = process.env.ND_WATER_ESCAPE_BUDGET !== '0'
  const rescue = process.env.ND_WATER_RESCUE === '1'
  const routes = new Map()
  const observed = new Map()
  let waterToward = null
  const changed = () => { routes.clear(); observed.clear(); waterToward = null }
  if (budget) bot.on?.('blockUpdate', changed)
  const plan = opts => {
    if (!budget) return findSwimRoute(bot, opts)
    const p = bot.entity.position
    const key = [Math.floor(p.x * 2), Math.floor(p.y * 2), Math.floor(p.z * 2), lazyPick().eyeHeight(bot), headWet(bot), (bot.oxygenLevel ?? 20) <= 8, opts.radius, opts.rise, opts.breathOnly, waterToward?.toString()].join(',')
    if (routes.has(key)) return routes.get(key)
    const route = findSwimRoute(bot, { ...opts, observed, toward: waterToward })
    if (route) routes.set(key, route)
    return route
  }

  try {
    let plugged = false
    let opened = false
    let wide = null, wideAt = 0, diveTo = null
    while (gameClock.now() < deadline && !ctl.aborted && !dryFooting(bot)) {
      if (waterToward && Math.hypot(waterToward.x + .5 - bot.entity.position.x, waterToward.z + .5 - bot.entity.position.z) <= .35 && bot.entity.position.y >= waterToward.y) waterToward = null
      if (budget && !headWet(bot) && airTicks(bot) < 270) {
        // Recover breath before the bank route can send us below another overhang.
        exit = 'recover-air'
        const eye = lazyPick().eyeOf(bot)
        bot.setControlState('forward', false); bot.setControlState('sprint', !!bot.entity._ndSwimming && !idleBreath(bot))
        bot.setControlState('jump', eye.y < Math.floor(eye.y) + .5 && (bot.entity.velocity?.y ?? 0) <= 0)
        await sleep(50); loops++; continue
      }
      if (budget && headWet(bot)) {
        breathBudget = Math.max(0, airTicks(bot) + 20)
        const up = airAbove(bot), eye = lazyPick().eyeOf(bot)
        if (up && (geometry.verticalLift(bot, bot.entity.position, up.y - eye.y) ?? 0) >= up.y - eye.y - 1e-7) {
          exit = 'air-budget-up'; kind = 'air'; target = up
          etaTicks = swimUpTicks(up.y - eye.y, bot.entity.velocity?.y ?? 0)
          await bot.lookAt(up, true)
          if (ctl.aborted || gameClock.now() >= deadline) { exit = ctl.aborted ? 'aborted' : 'deadline'; break }
          bot.setControlState('forward', false); bot.setControlState('sprint', false); bot.setControlState('jump', true)
          await sleep(50); loops++; continue
        }
      }
      // Воздух кончается, а в 8 бл. его нет (затопленный штрек, cl-ac/cl-ai 14.10: утонул в 1–2 бл. от своего хода) — шире:
      // поиск при нехватке воздуха кончается на первом воздухе, так что широкий круг дёшев.
      let route = plan({ visibleOnly: budget || visibleOnly, radius }) ||
        (radius < 16 && (budget || (bot.oxygenLevel ?? 20) <= 8) && headWet(bot) ? plan({ visibleOnly: budget || visibleOnly, radius: 16, rise: 16 }) : null)
      // A previously observed opening stays the goal until reached or invalidated by blocks.
      if (budget) waterToward = route?.kind === 'water' ? route.target : null
      if (budget && headWet(bot)) {
        breathBudget = Math.max(0, airTicks(bot) + 20)
        // ETA uses the reviewed water acceleration/drag; the air deadline determines whether shore needs a breath stop.
        const stepTicks = (1 - ((bot.food ?? 20) > 6 ? .9 : .8)) / (.02 * .98)
        etaTicks = route ? Math.ceil(route.path.length * stepTicks) : Infinity
        if (route?.kind === 'land' && etaTicks > breathBudget) {
          route = plan({ visibleOnly: true, radius: 16, rise: 16, breathOnly: true }) || route
          etaTicks = Math.ceil(route.path.length * stepTicks)
        }
      }
      target = route?.target || null
      kind = route?.kind || null
      loops++
      if (!route) {
        // Своя нора залита и закрыта сверху (tw-a-s1-3 15.10: нора у пруда «потолок закрыт», вода натекла; тактика Surface
        // 13 раз «не нашёл доступного пути из воды» за 2 с, утонул на месте): твёрдый потолок над головой — вскрыть один раз,
        // за ним бывает воздух. Вода над головой (шахта залита сверху) — ниже, затычка.
        const roofAt = budget ? new Vec3(Math.floor(bot.entity.position.x), Math.ceil(bot.entity.position.y + geometry.dimensions(bot).height - 1e-7), Math.floor(bot.entity.position.z)) : bot.entity.position.floored().offset(0, 2, 0)
        const roof = !opened && headWet(bot) ? bot.blockAt(roofAt) : null
        const cause = () => roof && `${roof.position}:${roof.stateId}:${bot.heldItem?.type}:${geometry.dimensions(bot).height}`
        const lifeTicks = () => airTicks(bot) + 20 + Math.max(0, Math.ceil(bot.health / 2) - 1) * 20
        const sameCause = budget && bot._ndWaterDigRefusal === cause() && lifeTicks() <= (bot._ndWaterDigBudget ?? Infinity)
        if (roof && roof.boundingBox === 'block' && !/^(bedrock|obsidian|crying_obsidian|reinforced_deepslate)$/.test(roof.name) &&
            !sameCause && (!budget || lazyPick().blockSeen(bot, roof.position)) && (typeof bot.canDigBlock !== 'function' || bot.canDigBlock(roof))) {
          opened = true
          try {
            if (budget) bot.clearControlStates()
            await lazyItems().equipBestTool(bot, roof)
            if (ctl.aborted) break
            // The watchdog is the body's remaining air/HP, not another arbitrary dig timeout.
            if (budget) {
              bot._ndWaterDigRefusal = cause()
              bot._ndWaterDigBudget = lifeTicks()
              const ms = Math.max(50, lifeTicks() * 50)
              try { await lazyBuild().withTimeout(bot.dig(roof, true), Math.min(ms, Math.max(1, deadline - gameClock.now())), 'кончился бюджет воздуха на вскрытие потолка') }
              finally { try { bot.stopDigging() } catch {} }
            } else await bot.dig(roof, true)
          } catch {}
          await sleep(200)
          continue
        }
        // Открытая вода над головой (озеро, море — у глубины лучи глаз воздуха не видят): плыть вверх, как человек
        // (tw-cr2-s1-3 15.10: Surface 15 с «пути нет», под водой без маршрута, хп 20 → 11.7 → смерть). Узкая шахта 1×1 без
        // соседней воды — ниже, затычка.
        const feetC = bot.entity.position.floored()
        const headCell = budget ? lazyPick().eyeOf(bot).floored() : feetC.offset(0, 1, 0)
        const upCell = bot.blockAt(headCell.offset(0, 1, 0))
        const openWater = [headCell, headCell.offset(0, 1, 0)].some(c => [[1, 0], [-1, 0], [0, 1], [0, -1]].some(([dx, dz]) => waterCell(bot.blockAt(c.offset(dx, 0, dz)))))
        const headBlock = bot.blockAt(lazyPick().eyeOf(bot)), feetBlock = bot.blockAt(feetC)
        const headLevel = headBlock?.getProperties?.().level ?? headBlock?.metadata
        const feetLevel = feetBlock?.getProperties?.().level ?? feetBlock?.metadata
        const flowingShaft = rescue && !openWater && headBlock?.name === 'water' && headLevel > 0 && feetBlock?.name === 'water' && feetLevel > 0
        if (headWet(bot) && waterCell(upCell) && !flowingShaft && (openWater || rescue)) {
          exit = 'swim-up'
          bot.setControlState('forward', false)
          bot.setControlState('sprint', false)
          bot.setControlState('jump', true)
          await sleep(160)
          continue
        }
        // Шахта залита сверху (своя копка вверх в воду, cl-n 14.10: «не нашёл доступного пути из воды», смерть): воздуха в
        // досягаемости нет — заткнуть клетку над головой; текущая вода в шахте без притока стекает за тики.
        // A plug cuts a flowing inlet; it cannot drain source water already occupying the body.
        if (!plugged && !opened && headWet(bot) && (!rescue || flowingShaft)) {
          plugged = true
          const above = budget ? roofAt : bot.entity.position.floored().offset(0, 2, 0)
          let r = null
          try { r = await lazyBuild().placeBlockAt(bot, above, { timeoutMs: 1500, honest: true, steady: true, ctl }) } catch {}
          if (r && r.ok) { await sleep(1000); continue }
        }
        exit = 'no-route'
        break
      }
      if (route.kind === 'air' && !headWet(bot)) {
        // Голова над водой, а берега в 8 бл. нет. Раньше — выход сразу: клавиши снимались, тело тонуло, тактика снова звала
        // Surface — качели «вынырнул — утонул», воздух 6–8 и вниз (j1k1-s2-2/3/4 15.10: 3 утопления за 10 мин). Теперь: с
        // поверхности видно дальше — берег в 24 бл.; нет и его — держаться на плаву (прыжок), пока воздух не восстановится.
        // Широкий поиск дорог (лучи по клеткам) — не чаще раза в секунду.
        if (gameClock.now() >= wideAt) { wideAt = gameClock.now() + 1000; wide = plan({ visibleOnly: budget || visibleOnly, radius: 24, rise: 4 }) }
        if (wide && wide.kind === 'land') {
          target = wide.target; kind = 'land-wide'
          const passed = wide.path.findIndex(p => p.equals(bot.entity.position.floored()))
          if (passed >= 0) wide.path.splice(0, passed + 1)
          route = wide
        } else if ((bot.oxygenLevel ?? 20) < 18 || budget && !idleBreath(bot)) {
          exit = 'tread'
          bot.setControlState('forward', false)
          bot.setControlState('sprint', false)
          bot.setControlState('jump', true)
          await sleep(160)
          continue
        } else {
          exit = 'air-dry-head'
          break
        }
      }
      const next = route.path[0] || route.target
      // Finish sinking to a lower route cell before jumping again (j1k1-s2-3).
      const surfaceStroke = budget && !headWet(bot) && idleBreath(bot) && (geometry.verticalLift(bot, bot.entity.position, 1) ?? 0) >= 1
      if (surfaceStroke) diveTo = null
      else if (next.y < bot.entity.position.floored().y) diveTo = next.y
      if (diveTo !== null && bot.entity.position.y <= diveTo) diveTo = null
      const horizontal = Math.hypot(next.x + 0.5 - bot.entity.position.x, next.z + 0.5 - bot.entity.position.z)
      await bot.lookAt(next.offset(0.5, budget ? lazyPick().eyeHeight(bot) : 1.62, 0.5), true)
      if (ctl.aborted || gameClock.now() >= deadline) { exit = ctl.aborted ? 'aborted' : 'deadline'; break }
      bot.setControlState('forward', horizontal > 0.25)
      // Skim the open surface without re-entering a dive; compact air pockets retain their swimming pose.
      bot.setControlState('sprint', (horizontal > 0.25 || budget && headWet(bot) && bot.entity._ndSwimming) && (bot.food ?? 20) > 6 && (!budget || headWet(bot) || !idleBreath(bot)))
      // Jump doubles as "swim up" in water and keeps the head above surface.
      bot.setControlState('jump', inWater(bot) && diveTo === null)
      await sleep(160)
    }
  } finally {
    if (budget) bot.removeListener?.('blockUpdate', changed)
    try { bot.clearControlStates() } catch {}
  }

  const out = dryFooting(bot)
  const head = bot.blockAt(lazyPick().eyeOf(bot))
  const breathing = breathCell(head)
  if (exit === 'dry' && !out) exit = ctl.aborted ? 'aborted' : 'deadline'
  const feet = bot.blockAt(bot.entity.position)
  return {
    ok: out,
    breathing,
    wasInWater: true,
    target: target ? xyz(target) : null,
    // Почему кончилось (разбор утоплений 15.10: «не нашёл пути» при найденной цели): выход цикла, вид маршрута, клетки глаз/ног.
    exit, loops, kind, eye: head ? head.name : null, feet: feet ? feet.name : null, air: bot.oxygenLevel ?? null,
    ...(budget ? { breathBudget, etaTicks: Number.isFinite(etaTicks) ? etaTicks : null } : {}),
    error: out ? undefined : breathing ? 'голова в воздухе, но на сухой берег не вышел' : 'не нашёл доступного пути из воды'
  }
}
