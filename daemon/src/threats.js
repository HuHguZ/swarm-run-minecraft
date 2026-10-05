'use strict'
const gameClock = require('./game-clock')
// Что летит в бота и куда от этого деваться. Общий для PvP и для побега от
// мобов: стрела скелета и стрела человека — одна и та же сущность, и уклоняться
// от неё надо одинаково.
//
// Скорость снаряда меряется по разнице позиций между двумя опросами, а не
// берётся из entity.velocity. Скорость в пакете приходит в тех единицах, что
// выбрал протокол версии (1/8000 блока за тик раньше, упакованный вектор с
// 1.21.9), и mineflayer не везде переводит её одинаково; две позиции,
// пришедшие от сервера, в переводе не нуждаются. Цена — первый опрос после
// появления стрелы ничего не знает, и это 50 мс из ~500, что она летит.

const PROJECTILES = new Set([
  'arrow', 'spectral_arrow', 'trident', 'snowball', 'egg', 'fireball',
  'small_fireball', 'wind_charge', 'breeze_wind_charge', 'shulker_bullet',
  'splash_potion', 'lingering_potion', 'potion', 'llama_spit', 'dragon_fireball',
  'wither_skull', 'ender_pearl',
  // Фейерверк из арбалета (2026-09-26): летит по прямой без гравитации
  // (FireworkRocketEntity, shotAtAngle), 1.6 бл/тик — от него успеть уйти можно.
  'firework_rocket'
])

// Снаряды, которые бьют. Жемчуг и чужие зелья лечения тоже летят, но
// уворачиваться от своего же жемчуга незачем, поэтому бросок самого бота
// отсекается по владельцу ниже, а не по имени.
const HARMLESS = new Set(['ender_pearl'])

const seen = new Map() // id -> { x, y, z, t }

function sample (e, now) {
  const prev = seen.get(e.id)
  const cur = { x: e.position.x, y: e.position.y, z: e.position.z, t: now }
  seen.set(e.id, cur)
  if (!prev) return null
  const dtTicks = (now - prev.t) / 50
  if (dtTicks <= 0.2 || dtTicks > 10) return null
  return {
    x: (cur.x - prev.x) / dtTicks,
    y: (cur.y - prev.y) / dtTicks,
    z: (cur.z - prev.z) / dtTicks
  }
}

// Стрела, которая лежит на земле или воткнулась в стену, тоже сущность arrow.
// Отличить её можно только по тому, что она не движется.
const RESTING = 0.05

// Ближайший подход снаряда к телу бота за horizonTicks. Та же физика, что у
// игры для стрел: сначала шаг, потом сопротивление 0.99 и гравитация.
// Брошенное рукой (ThrowableProjectile.tick, 1.21.2+) за тик: гравитация,
// трение, сдвиг. Стрела и трезубец (AbstractArrow.tick): сдвиг, трение,
// гравитация. Разница — полблока на двадцати тиках.
const THROWN = new Set(['snowball', 'egg', 'ender_pearl', 'splash_potion', 'lingering_potion', 'potion', 'experience_bottle'])

function closestApproach (bot, pos, vel, gravity, horizonTicks, thrown = false) {
  const me = bot.entity.position
  const cx = me.x
  const cy = me.y + 0.9
  const cz = me.z
  let p = { x: pos.x, y: pos.y, z: pos.z }
  let v = { x: vel.x, y: vel.y, z: vel.z }
  let best = { dist: Infinity, ticks: 0 }
  for (let t = 1; t <= horizonTicks; t++) {
    if (thrown) {
      v = { x: v.x * 0.99, y: (v.y - gravity) * 0.99, z: v.z * 0.99 }
      p = { x: p.x + v.x, y: p.y + v.y, z: p.z + v.z }
    } else {
      p = { x: p.x + v.x, y: p.y + v.y, z: p.z + v.z }
      v = { x: v.x * 0.99, y: v.y * 0.99 - gravity, z: v.z * 0.99 }
    }
    // Тело — столб высотой 1.8, а не точка: стрела, пролетающая над головой на
    // уровне 1.7, попадает, и считать по центру значит уворачиваться поздно.
    const dy = Math.max(0, Math.abs(p.y - cy) - 0.9)
    const d = Math.hypot(p.x - cx, dy, p.z - cz)
    if (d < best.dist) best = { dist: d, ticks: t, at: p, vel: v }
  }
  return best
}

const GRAVITY = {
  arrow: 0.05, spectral_arrow: 0.05, trident: 0.05,
  snowball: 0.03, egg: 0.03, ender_pearl: 0.03,
  splash_potion: 0.05, lingering_potion: 0.05, potion: 0.05, experience_bottle: 0.07, llama_spit: 0.06
}

// Всё, что летит в нас и попадёт в ближайшие horizonTicks. Самые срочные первыми.
function incoming (bot, { horizonTicks = 24, hitRadius = 0.9 } = {}) {
  if (!bot || !bot.entity) return []
  const now = gameClock.now()
  const out = []
  const me = bot.entity.position
  for (const e of Object.values(bot.entities)) {
    if (!e || !e.position || !PROJECTILES.has(e.name)) continue
    if (e.position.distanceTo(me) > 48) continue
    const vel = sample(e, now)
    if (!vel || HARMLESS.has(e.name)) continue
    const speed = Math.hypot(vel.x, vel.y, vel.z)
    if (speed < RESTING) continue
    const g = GRAVITY[e.name] ?? 0
    const hit = closestApproach(bot, e.position, vel, g, horizonTicks, THROWN.has(e.name))
    if (hit.dist > hitRadius) continue
    out.push({ entity: e, name: e.name, ticks: hit.ticks, dist: hit.dist, at: hit.at, vel, speed })
  }
  // Забываем то, что исчезло: иначе карта растёт за каждую стрелу за смену.
  if (seen.size > 256) {
    for (const id of seen.keys()) if (!bot.entities[id]) seen.delete(id)
  }
  return out.sort((a, b) => a.ticks - b.ticks)
}

// Куда шагнуть, чтобы сойти с линии: поперёк полёта, в ту сторону, где
// стоять можно. Ответ — имя клавиши относительно того, куда бот смотрит
// сейчас ('left' | 'right'), потому что именно ей и будут двигать тело.
function dodgeKey (bot, proj, safe = () => true) {
  const yaw = bot.entity.yaw
  // Взгляд (-sin, -cos); правая рука — взгляд, повёрнутый по часовой (сверху):
  // смотрит на север (0,-1) — правая рука на востоке (1,0).
  const right = { x: Math.cos(yaw), z: -Math.sin(yaw) }
  // Прочь от точки, где линия полёта ближе всего к нам. Если она идёт ровно в
  // центр, любая сторона поперёк полёта одинаково хороша.
  const me = bot.entity.position
  let away = proj.at ? { x: me.x - proj.at.x, z: me.z - proj.at.z } : { x: 0, z: 0 }
  if (Math.hypot(away.x, away.z) < 0.15) away = { x: -proj.vel.z, z: proj.vel.x }
  const side = away.x * right.x + away.z * right.z
  const first = side >= 0 ? 'right' : 'left'
  const second = first === 'right' ? 'left' : 'right'
  if (safe(first)) return first
  if (safe(second)) return second
  return null
}

module.exports = { incoming, dodgeKey, PROJECTILES, closestApproach }
