'use strict'
const fortify = require('./fortify')
const build = require('./build')
const assess = require('./assess')
const route = require('./route')

function profile (bot, at = bot.entity.position.floored(), height = null) {
  const solid = p => fortify.fullCube(bot.blockAt(p))
  const tall = height || (solid(at.offset(0, 2, 0)) ? 2 : 3)
  const sides = fortify.SIDES.map(d => ({ d, shut: Array.from({ length: tall }, (_, y) => solid(at.plus(d).offset(0, y, 0))).every(Boolean) }))
  const walls = sides.filter(s => s.shut).length, roof = solid(at.offset(0, tall, 0))
  const floor = fortify.solidAt(bot, at.offset(0, -1, 0)) || at.equals(bot.entity.position.floored()) && bot.entity.onGround === true
  const b = bot.blockAt(bot.entity.position.floored().offset(0, 1, 0))
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
  const prior = view.sealed ? 0 : route.scoutLegPrice({ night: dark, hp, shield: view.shield }).risk * seconds / 60 * exposure
  let damage = 0
  for (const f of view.fight?.order || []) {
    // combat-safety's six-block exchange horizon includes the armed walker before we put the tool away.
    const arrive = f.ranged ? 0 : Math.max(0, (f.dist - 6) / 3)
    if (arrive <= seconds) damage += (f.hit || 0) + (f.dps || 0) * Math.max(0, seconds - arrive)
  }
  return death * Math.min(1, prior + damage / hp)
}

function step (bot, at, back, seconds, fight = assess.plan(bot, { radius: 16 }), height = null) {
  const v = profile(bot, at, height)
  const here = bot.entity.position.floored(), distance = Math.abs(at.x - here.x) + Math.abs(at.y - here.y) + Math.abs(at.z - here.z)
  const env = { ...v, block: Math.max(0, (v.block || 0) - distance), sky: Math.max(0, (v.sky || 0) - distance), hp: bot.health, fight }, open = price(env, seconds)
  const dx = Math.sign(back.x - at.x), dz = Math.sign(back.z - at.z)
  const corridor = v.floor && v.roof && v.sides.every(s => s.shut || s.d.x === dx && s.d.z === dz)
  const closeSeconds = fortify.refugeBuildMs({ blocks: 2, roofSolid: true, leans: true }) / 1000
  const closed = corridor && v.blocks >= 2 ? closeSeconds + price({ ...env, walls: 4, roof: true, sealed: false }, closeSeconds) : Infinity
  const extra = Math.min(open, closed)
  if (extra > seconds) return { stopped: `NIGHT_RISK: хп ${bot.health}, свет ${v.block ?? '?'}/${v.sky ?? '?'}, стен ${v.walls}/4: риск ≈ ${Math.round(extra)} с > выигрыш шага ${seconds} с` }
  return { close: closed < open, extra }
}

async function closeBehind (bot, ctl, back) {
  for (const p of [back.offset(0, 1, 0), back]) {
    if (ctl.aborted) return 'NIGHT_RISK: прервано до закладки'
    const r = await build.placeBlockAt(bot, p, { honest: true, steady: true, ctl, timeoutMs: 1500 })
    if (ctl.aborted) return 'NIGHT_RISK: прервано во время закладки'
    if (!r.ok || !fortify.fullCube(bot.blockAt(p))) return `NIGHT_RISK: задний проход не закрыт (${r.reason || 'блок не подтверждён'})`
  }
  return null
}

module.exports = { profile, price, step, closeBehind }
