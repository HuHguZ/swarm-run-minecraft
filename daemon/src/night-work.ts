'use strict'
import fortify = require('./fortify')
import build = require('./build')
import * as assess from './assess'
import route = require('./route')
import * as gameClock from './game-clock'
import { sleep, xyz } from './movement'

function profile (bot, at = bot.entity.position.floored(), height = null) {
  const solid = p => fortify.fullCube(bot.blockAt(p))
  const tall = height || (solid(at.offset(0, 2, 0)) ? 2 : 3)
  const sides = fortify.SIDES.map(d => ({ d, shut: Array.from({ length: tall }, (_, y) => solid(at.plus(d).offset(0, y, 0))).every(Boolean) }))
  const walls = sides.filter(s => s.shut).length, roof = solid(at.offset(0, tall, 0))
  const floor = fortify.solidAt(bot, at.offset(0, -1, 0)) || at.equals(bot.entity.position.floored()) && bot.entity.onGround === true
  // The freshly opened cell is visible: use its actual light, including a new mouth torch.
  const b = bot.blockAt((process.env.ND_NIGHT_FAIL_KEY === '1' ? at : bot.entity.position.floored()).offset(0, 1, 0))
  const need = fortify.refugeNeed(bot, at)
  const blocks = (bot.inventory?.items() || []).filter(i => build.FILLER.includes(i.name) && !/^(sand|gravel)$/.test(i.name)).reduce((n, i) => n + i.count, 0)
  return { walls, roof, floor, sealed: walls === 4 && roof && floor, block: b?.light, sky: b?.skyLight,
    night: (bot.time?.timeOfDay ?? 18000) >= 12542 && (bot.time?.timeOfDay ?? 18000) <= 23459,
    coverSeconds: fortify.refugeBuildMs(need) / 1000, blocks, sides }
}

// Price prior from route.scoutLegPrice, scaled by exposed seconds; it is not a measured probability for C8.
function price (view, seconds) {
  const death = (Number(process.env.ND_DEATH_COST_MIN) || 60) * 60
  if (!view?.floor) return death
  const hp = Math.max(1, view.hp ?? 20), night = view.night !== false
  const dark = !(Number(view.block) > 0 || !night && Number(view.sky) > 7)
  const exposure = Math.max(1 - (view.walls || 0) / 4, view.roof ? 0 : 1)
  // ND_NIGHT_CAVE_PRIOR=<доля смертей в минуту, напр. 0.01> — клетка без неба (skyLight 0) опасна одинаково днём и ночью: ночной
  // поверхностный prior 5 %/мин запрещал ночью тот же штрек в тёмную пещеру, что днём этап iron копает без проверки (owB1-05: вся ночь
  // «коробка → шаг из неё NIGHT_RISK → коробка» на y16).
  const caveRate = Number(process.env.ND_NIGHT_CAVE_PRIOR) || 0
  const rate = caveRate > 0 && dark && Number(view.sky) === 0
    ? Math.min(0.5, caveRate * 20 / hp * (view.shield ? 0.6 : 1)) : route.scoutLegPrice({ night: dark, hp, shield: view.shield }).risk
  const prior = view.sealed ? 0 : rate * seconds / 60 * exposure
  let damage = 0
  for (const f of view.fight?.order || []) {
    // combat-safety's six-block exchange horizon includes the armed walker before we put the tool away.
    const arrive = f.ranged ? 0 : Math.max(0, (f.dist - 6) / 3)
    if (arrive <= seconds) damage += (f.hit || 0) + (f.dps || 0) * Math.max(0, seconds - arrive)
  }
  return death * Math.min(1, prior + damage / hp)
}

function step (bot, at, back, seconds, fight: any = assess.plan(bot, { radius: 16 }), height = null) {
  const v = profile(bot, at, height)
  const here = bot.entity.position.floored(), distance = Math.abs(at.x - here.x) + Math.abs(at.y - here.y) + Math.abs(at.z - here.z)
  const attenuation = process.env.ND_NIGHT_FAIL_KEY === '1' ? 0 : distance
  const env = { ...v, block: Math.max(0, (v.block || 0) - attenuation), sky: Math.max(0, (v.sky || 0) - attenuation), hp: bot.health, fight }, open = price(env, seconds)
  const dx = Math.sign(back.x - at.x), dz = Math.sign(back.z - at.z)
  const corridor = v.floor && v.roof && v.sides.every(s => s.shut || s.d.x === dx && s.d.z === dz)
  const closeSeconds = fortify.refugeBuildMs({ blocks: 2, roofSolid: true, leans: true }) / 1000
  const closed = corridor && v.blocks >= 2 ? closeSeconds + price({ ...env, walls: 4, roof: true, sealed: false }, closeSeconds) : Infinity
  // ND_NIGHT_STEP_MARGINAL=1 — риск шага сверх риска стоять на месте те же секунды: отказ от шага не бесплатен (21.10 owb01-s1-3:
  // с поверхности ночью «риск 10 с > выигрыш 3 с» не должен запрещать первый шаг вниз при том же фоновом риске).
  // Subtract only ambient exposure: a visible attack and a missing floor remain real costs.
  const standing = process.env.ND_NIGHT_STEP_MARGINAL === '1' && distance > 0 ? profile(bot, here) : null
  const stay = v.floor && standing?.floor ? price({ ...standing, hp: bot.health }, seconds) : 0
  const background = closed < open
    ? price({ ...env, walls: 4, roof: true, sealed: false, fight: null }, closeSeconds)
    : price({ ...env, fight: null }, seconds)
  const extra = Math.max(0, Math.min(open, closed) - Math.min(stay, background))
  if (extra > seconds) return { stopped: `NIGHT_RISK: хп ${bot.health}, свет ${v.block ?? '?'}/${v.sky ?? '?'}, стен ${v.walls}/4: риск ≈ ${Math.round(extra)} с > выигрыш шага ${seconds} с` }
  return { close: closed < open, extra }
}

// Rejected dark cave entry: buy real illumination when it is cheaper, then reprice
// the observed world. A torch item or successful placement packet is not light.
async function prepareStep (bot, ctl, at, back, seconds, height = null) {
  let fight = assess.plan(bot, { radius: 16 }), work = step(bot, at, back, seconds, fight, height), torchPlaced = false
  if (work.stopped && !ctl.aborted) {
    const v = profile(bot, at, height), env = { ...v, hp: bot.health, fight }
    const torchSeconds = fortify.refugeBuildMs({ blocks: 1, roofSolid: true, leans: true }) / 1000 + 0.5
    const litRisk = price({ ...env, block: 1 }, seconds)
    if (!(Number(v.block) > 0) && v.floor && litRisk <= seconds && litRisk + torchSeconds < price(env, seconds) &&
      (bot.inventory?.items() || []).some(i => i.name === 'torch' && i.count > 0)) {
      const already = /^(wall_)?torch$/.test(bot.blockAt(at)?.name || '')
      try { await build.placeBlockAt(bot, at, { item: 'torch', honest: true, ctl, timeoutMs: 1200 }) } catch {}
      const appeared = /^(wall_)?torch$/.test(bot.blockAt(at)?.name || '')
      torchPlaced = appeared && !already
      // Light arrives in a separate packet. Bounded observation; no assumed level.
      const lightBy = gameClock.now() + 500
      while (appeared && !ctl.aborted && !(Number(profile(bot, at, height).block) > 0) && gameClock.now() < lightBy) await sleep(50)
      fight = assess.plan(bot, { radius: 16 })
      work = step(bot, at, back, seconds, fight, height)
    }
  }
  if (!work.stopped) return { ...work, torchPlaced, nightRefusal: undefined }
  const v = profile(bot, at, height), here = bot.entity.position.floored()
  const pickView = p => ({ walls: p.walls, roof: p.roof, floor: p.floor, sealed: p.sealed, block: p.block, sky: p.sky, night: p.night })
  const dx = Math.sign(back.x - at.x), dz = Math.sign(back.z - at.z)
  // Record the OPEN mouth before the caller seals it: our own wall/material
  // changes cannot be evidence that the refused cave became safe to reopen.
  const nightRefusal = { target: xyz(at), from: xyz(here), seconds, view: pickView(v), standing: pickView(profile(bot, here)),
    corridor: v.floor && v.roof && v.sides.every(s => s.shut || s.d.x === dx && s.d.z === dz),
    closeSeconds: fortify.refugeBuildMs({ blocks: 2, roofSolid: true, leans: true }) / 1000 }
  return { ...work, torchPlaced, nightRefusal }
}

async function closeBehind (bot, ctl, back) {
  // ND_NIGHT_CLOSE_LOW_FIRST=1: снизу вверх — нижняя клетка ложится на пол прохода, верхняя на неё. Сверху вниз верхней клетке
  // ступени часто не к чему прислониться (C4–C12: 2293 «не к чему прислонить блок», 3/4 — ночные лестницы), и работа стояла.
  const lowFirst = typeof process !== 'undefined' && process.env.ND_NIGHT_CLOSE_LOW_FIRST === '1'
  for (const p of lowFirst ? [back, back.offset(0, 1, 0)] : [back.offset(0, 1, 0), back]) {
    if (ctl.aborted) return 'NIGHT_RISK: прервано до закладки'
    const r = await build.placeBlockAt(bot, p, { honest: true, steady: true, ctl, timeoutMs: 1500 })
    if (ctl.aborted) return 'NIGHT_RISK: прервано во время закладки'
    if (!r.ok || !fortify.fullCube(bot.blockAt(p))) return `NIGHT_RISK: задний проход не закрыт (${r.reason || 'блок не подтверждён'})`
  }
  return null
}

export { profile, price, step, prepareStep, closeBehind }
