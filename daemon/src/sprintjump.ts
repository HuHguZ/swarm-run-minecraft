'use strict'
// Бег вприпрыжку (просьба пользователя 03.10, поток route): на прямом ровном отрезке пути — прыжок с бегом в каждый
// тик приземления. Ванильная физика (Player.jumpFromGround, 1.21.11): прыжок при беге добавляет 0.2 к скорости по
// взгляду — бег ~5.6 м/с, вприпрыжку ~7.1 м/с; голод — 0.2 за прыжок против 0.1 за метр бега (FoodData.addExhaustion).
// mineflayer-pathfinder сам прыгает с бегом только там, где без прыжка путь не пройти (physics.canSprintJump к path[0]);
// здесь — поверх него: слушатель physicsTick после исполнителя pathfinder'а (он ставит управление в своём physicsTick
// раньше нас), на прямых ≥ AHEAD узлах вровень с ногами, с пустым потолком +2 над каждым и без копки/стройки в них.
// Под флагом ND_SPRINT_JUMP=1 (по умолчанию выкл. до замера).
const Vec3 = require('vec3')

const AHEAD = 5
const on = () => process.env.ND_SPRINT_JUMP === '1'

function install (bot) {
  if (!bot || bot._ndSprintJump) return
  bot._ndSprintJump = { path: [], jumps: 0, ticks: 0 }
  const st = bot._ndSprintJump
  bot.on('path_update', r => { st.path = (r && Array.isArray(r.path)) ? r.path.slice() : [] })
  bot.on('path_reset', () => { st.path = [] })
  bot.on('goal_reached', () => { st.path = [] })
  const free = p => { const b = bot.blockAt(p); return !!b && b.boundingBox === 'empty' && !/water|lava|cobweb|powder_snow/.test(b.name) }
  const solid = p => { const b = bot.blockAt(p); return !!b && b.boundingBox === 'block' && !/magma|campfire|soul_sand|honey|slime|ice/.test(b.name) }
  bot.on('physicsTick', () => {
    if (!on() || !st.path.length) return
    const e = bot.entity
    if (!e || !e.onGround || e.isInWater || e.isInLava) return
    if (!bot.getControlState('forward') || !bot.getControlState('sprint') || bot.getControlState('sneak')) return
    if ((bot.food ?? 20) <= 6) return
    try { if (bot.pathfinder && (bot.pathfinder.isMining() || bot.pathfinder.isBuilding())) return } catch {}
    const p = e.position
    // Снять пройденные узлы (как исполнитель: в 0.35 по горизонтали и |dy| < 1).
    while (st.path.length && Math.abs(st.path[0].x - p.x) <= 0.5 && Math.abs(st.path[0].z - p.z) <= 0.5 && Math.abs(st.path[0].y - p.y) < 1) st.path.shift()
    if (st.path.length < AHEAD) return
    const fy = Math.floor(p.y + 0.01)
    const n0 = st.path[0]
    const dx0 = Math.sign(Math.round(n0.x - p.x)); const dz0 = Math.sign(Math.round(n0.z - p.z))
    if (!dx0 && !dz0) return
    let px = Math.floor(p.x); let pz = Math.floor(p.z)
    for (let i = 0; i < AHEAD; i++) {
      const n = st.path[i]
      if (!n || Math.floor(n.y + 0.01) !== fy) return
      if ((n.toBreak && n.toBreak.length) || (n.toPlace && n.toPlace.length)) return
      const nx = Math.floor(n.x); const nz = Math.floor(n.z)
      // Прямо: шаг на одну клетку в том же направлении.
      if (nx - px !== dx0 || nz - pz !== dz0) return
      const c = new Vec3(nx, fy, nz)
      if (!free(c) || !free(c.offset(0, 1, 0)) || !free(c.offset(0, 2, 0)) || !solid(c.offset(0, -1, 0))) return
      px = nx; pz = nz
    }
    // Над головой сейчас — тоже пусто.
    const h = new Vec3(Math.floor(p.x), fy + 2, Math.floor(p.z))
    if (!free(h)) return
    bot.setControlState('jump', true)
    st.jumps++
  })
}

module.exports = { install, on, AHEAD }
