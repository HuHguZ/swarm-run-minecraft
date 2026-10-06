'use strict'
// Бег вприпрыжку (просьба пользователя 03.10, поток route): на прямом ровном отрезке пути — прыжок с бегом в каждый
// тик приземления. Ванильная физика (Player.jumpFromGround, 1.21.11): прыжок при беге добавляет 0.2 к скорости по
// взгляду — бег ~5.6 м/с, вприпрыжку ~7.1 м/с; голод — 0.2 за прыжок против 0.1 за метр бега (FoodData.addExhaustion).
// mineflayer-pathfinder сам прыгает с бегом только там, где без прыжка путь не пройти (physics.canSprintJump к path[0]);
// здесь — поверх него: слушатель physicsTick после исполнителя pathfinder'а (он ставит управление в своём physicsTick
// раньше нас), на прямых ≥ AHEAD узлах вровень с ногами, с пустым потолком +2 над каждым и без копки/стройки в них.
// Включён по умолчанию (решение пользователя 06.10 после A/B s6-sprint-on/off: −30 % игрового времени на ровном
// коридоре); ND_SPRINT_JUMP=0 — выключить.
// Края и лава (s6b 06.10): в воздухе руль слабый (0.02 против 0.1 на земле), боковой снос прыжка не поправить —
// поэтому по бокам каждой клетки прямого отрезка нужен пол или стена (не лава, не огонь, не яма), а тело,
// которым владеет паркур (_ndParkourForecast) или рефлекс падения (waterPlan), прыжками не трогаем.
const Vec3 = require('vec3')

const AHEAD = 5
const on = () => process.env.ND_SPRINT_JUMP !== '0'
const HAZARD = /lava|fire|magma|campfire|cactus|sweet_berry|powder_snow|cobweb|pointed_dripstone|wither_rose/

/** Прыжок с бегом на этом тике пути `path` (узлы pathfinder'а) — да/нет. */
function shouldJump (bot, path) {
  if (bot._ndParkourForecast || bot._ndClutch?.waterPlan) return false
  const e = bot.entity
  if (!e || !e.onGround || e.isInWater || e.isInLava) return false
  if (!bot.getControlState('forward') || !bot.getControlState('sprint') || bot.getControlState('sneak')) return false
  if ((bot.food ?? 20) <= 6) return false
  try { if (bot.pathfinder && (bot.pathfinder.isMining() || bot.pathfinder.isBuilding())) return false } catch {}
  if (path.length < AHEAD) return false
  const free = p => { const b = bot.blockAt(p); return !!b && b.boundingBox === 'empty' && !/water|lava|cobweb|powder_snow/.test(b.name) }
  const solid = p => { const b = bot.blockAt(p); return !!b && b.boundingBox === 'block' && !/magma|campfire|soul_sand|honey|slime|ice/.test(b.name) }
  // Сбоку: стена (тело упрётся) или пол на уровне ног; лава/огонь и яма — нет.
  const sideSafe = p => {
    const at = bot.blockAt(p); const below = bot.blockAt(p.offset(0, -1, 0))
    if (!at || !below || HAZARD.test(at.name) || HAZARD.test(below.name)) return false
    return at.boundingBox === 'block' || below.boundingBox === 'block'
  }
  const p = e.position
  const fy = Math.floor(p.y + 0.01)
  const n0 = path[0]
  const dx0 = Math.sign(Math.round(n0.x - p.x)); const dz0 = Math.sign(Math.round(n0.z - p.z))
  if (!dx0 && !dz0) return false
  let px = Math.floor(p.x); let pz = Math.floor(p.z)
  for (let i = 0; i < AHEAD; i++) {
    const n = path[i]
    if (!n || Math.floor(n.y + 0.01) !== fy) return false
    if ((n.toBreak && n.toBreak.length) || (n.toPlace && n.toPlace.length)) return false
    const nx = Math.floor(n.x); const nz = Math.floor(n.z)
    // Прямо: шаг на одну клетку в том же направлении.
    if (nx - px !== dx0 || nz - pz !== dz0) return false
    const c = new Vec3(nx, fy, nz)
    if (!free(c) || !free(c.offset(0, 1, 0)) || !free(c.offset(0, 2, 0)) || !solid(c.offset(0, -1, 0))) return false
    if (process.env.ND_SPRINT_JUMP_SIDES !== '0' && (!sideSafe(c.offset(-dz0, 0, dx0)) || !sideSafe(c.offset(dz0, 0, -dx0)))) return false
    px = nx; pz = nz
  }
  // Над головой сейчас — тоже пусто.
  return free(new Vec3(Math.floor(p.x), fy + 2, Math.floor(p.z)))
}

function install (bot) {
  if (!bot || bot._ndSprintJump) return
  bot._ndSprintJump = { path: [], jumps: 0, ticks: 0, logged: 0 }
  const st = bot._ndSprintJump
  // The executor's own node array (mineflayer-pathfinder keeps results.path and reads path[0] every tick).
  bot.on('path_update', r => { st.path = (r && Array.isArray(r.path)) ? r.path : [] })
  bot.on('path_reset', () => { st.path = [] })
  bot.on('goal_reached', () => { st.path = []; if (st.jumps !== st.logged) { st.logged = st.jumps; console.log('[sprintjump]', JSON.stringify({ jumps: st.jumps })) } })
  bot.on('physicsTick', () => {
    if (!on() || !st.path.length || !bot.entity) return
    const p = bot.entity.position
    // Снять пройденные узлы прямо в массиве исполнителя. Прыжок пролетает узлы, ни разу не оказавшись в 0.35 от
    // них (так исполнитель отмечает узел), и тот разворачивал тело назад к пропущенному узлу: s6b-sprint6-trace —
    // после каждой посадки бег назад на 0.5–0.8 бл., 1000 тиков на 73 бл. против 375 без прыжков.
    const passed = (n, next) => {
      if ((n.toBreak && n.toBreak.length) || (n.toPlace && n.toPlace.length) || Math.abs(n.y - p.y) >= 1.5) return false
      if (Math.abs(n.x - p.x) <= 0.5 && Math.abs(n.z - p.z) <= 0.5) return true
      if (!next || Math.abs(next.y - n.y) > .5) return false
      const dx = next.x - n.x; const dz = next.z - n.z; const len = Math.hypot(dx, dz) || 1
      return ((p.x - n.x) * dx + (p.z - n.z) * dz) / len >= 0 && Math.abs((p.x - n.x) * dz - (p.z - n.z) * dx) / len <= .5
    }
    while (st.path.length > 1 && passed(st.path[0], st.path[1])) st.path.shift()
    if (process.env.ND_SPRINT_TRACE === '1') {
      const e = bot.entity; const c = k => bot.getControlState(k) ? k[0] : '-'
      console.log('[sj]', e.position.x.toFixed(2), e.position.y.toFixed(2), e.position.z.toFixed(2), Math.hypot(e.velocity.x, e.velocity.z).toFixed(3), e.onGround ? 'G' : 'A', c('forward') + c('sprint') + c('jump'), st.path.length)
    }
    if (!shouldJump(bot, st.path)) return
    bot.setControlState('jump', true)
    st.jumps++
  })
}

module.exports = { install, on, shouldJump, AHEAD }
