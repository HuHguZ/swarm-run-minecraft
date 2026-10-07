'use strict'
// Бег вприпрыжку (просьба пользователя 03.10, поток route): на прямом ровном отрезке пути — прыжок с бегом в каждый
// тик приземления. Ванильная физика (Player.jumpFromGround, 1.21.11): прыжок при беге добавляет 0.2 к скорости по
// взгляду — бег ~5.6 м/с, вприпрыжку ~7.1 м/с; голод — 0.2 за прыжок против 0.1 за метр бега (FoodData.addExhaustion).
// mineflayer-pathfinder сам прыгает с бегом только там, где без прыжка путь не пройти (physics.canSprintJump к path[0]);
// здесь — поверх него: слушатель physicsTick после исполнителя pathfinder'а (он ставит управление в своём physicsTick
// раньше нас), на прямых ≥ AHEAD узлах вровень с ногами, с пустым потолком +2 над каждым и без копки/стройки в них.
// Включён по умолчанию (решение пользователя 06.10); A/B S6c 07.10 в одном сеансе (try-parkour-sprint SJ=ab): --lockstep
// 750 — коридор −9.6 %, повороты −3.6 %, рельеф −3.0 %; 20 TPS — −9.8 / −4.6 / −2.4 %; урон 0. ND_SPRINT_JUMP=0 — выключить.
// Края и лава (s6b 06.10): в воздухе руль слабый (0.02 против 0.1 на земле), боковой снос прыжка не поправить —
// поэтому по бокам каждой клетки прямого отрезка нужен пол или стена (не лава, не огонь, не яма), а тело,
// которым владеет паркур (_ndParkourForecast) или рефлекс падения (waterPlan), прыжками не трогаем.
const Vec3 = require('vec3')

const AHEAD = 5
// bot._ndSprintJumpWanted (goto {sprintJump}) — на один goto поверх env (A/B в одном сеансе).
const on = (bot?) => (bot && typeof bot._ndSprintJumpWanted === 'boolean') ? bot._ndSprintJumpWanted : process.env.ND_SPRINT_JUMP !== '0'
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
    if (!sideSafe(c.offset(-dz0, 0, dx0)) || !sideSafe(c.offset(dz0, 0, -dx0))) return false
    px = nx; pz = nz
  }
  // Прыжок садится на 3–4 клетки вперёд: ступень сразу за прямой (вверх или вниз) — без прыжка, иначе тело влетает
  // в ступень с разгона и теряет скорость (s6c-sj-trace6, terrain: вкл на 4 % медленнее выкл).
  for (let i = AHEAD; i < AHEAD + 2; i++) if (path[i] && Math.floor(path[i].y + 0.01) !== fy) return false
  // Над головой сейчас — тоже пусто.
  return free(new Vec3(Math.floor(p.x), fy + 2, Math.floor(p.z)))
}

function install (bot) {
  if (!bot || bot._ndSprintJump) return
  // dir/until — направление нашего последнего прыжка и до какого тика узлы по нему можно снимать (прыжок ~12 тиков).
  bot._ndSprintJump = { path: [], dir: null, until: 0, tick: 0, jumps: 0, skipped: 0, ticks: 0, logged: 0 }
  const st = bot._ndSprintJump
  // The executor's own node array (mineflayer-pathfinder keeps results.path and reads path[0] every tick).
  bot.on('path_update', r => { st.path = (r && Array.isArray(r.path)) ? r.path : [] })
  bot.on('path_reset', () => { st.path = []; st.dir = null })
  bot.on('goal_reached', () => { st.path = []; st.dir = null; if (st.jumps !== st.logged) { st.logged = st.jumps; console.log('[sprintjump]', JSON.stringify({ jumps: st.jumps, skipped: st.skipped })) } })
  // Снятие пролетевших узлов — ДО исполнителя в том же тике (prependListener): он берёт path[0] и поворачивает тело к нему
  // в своём physicsTick; после него снятый узел уже стоил тика руля назад (s6c-sj-trace3: −0.025 бл/тик на каждом узле).
  bot.prependListener('physicsTick', () => {
    st.tick++
    if (!on(bot) || !st.path.length || !bot.entity) return
    const p = bot.entity.position
    // Прыжок пролетает узлы, ни разу не оказавшись в 0.35 от них (так исполнитель отмечает узел; в прыжке ноги ещё и
    // выше узла на 1+ — его порог dy < 1), и тот разворачивал тело назад к пропущенному узлу: s6b-sprint6-trace — бег
    // назад 0.5–0.8 бл. после каждой посадки; s6c-sj-trace1 — руль назад в воздухе (−0.026/тик). Снимаем узел в массиве
    // исполнителя (как его собственный pathFromPlayer при частичном пути), только пока идёт НАШ прыжок, и только узел,
    // за которым следующий — соседняя клетка на той же высоте ПО НАПРАВЛЕНИЮ прыжка: угол поворота (следующий —
    // вбок), ступень/лестница (другая высота), узел отрыва паркур-прыжка pathfinder'а (следующий — не соседняя клетка)
    // остаются исполнителю с его 0.35/1. Тело — не дальше 0.35 до узла по направлению (или за ним), 0.5 сбоку, ниже 1.5.
    const passed = (n, next) => {
      if (!st.dir || st.tick > st.until || !next) return false
      if ((n.toBreak && n.toBreak.length) || (n.toPlace && n.toPlace.length) || Math.abs(n.y - p.y) >= 1.5 || Math.abs(next.y - n.y) > .01) return false
      const dx = Math.round(next.x - n.x); const dz = Math.round(next.z - n.z)
      if (dx !== st.dir[0] || dz !== st.dir[1]) return false
      // В 0.35 до узла — порог исполнителя по горизонтали: в воздухе он узел не засчитает (ноги выше на 1+), а за узлом
      // повернул бы тело назад.
      return (p.x - n.x) * dx + (p.z - n.z) * dz >= -.35 && Math.abs((p.x - n.x) * dz - (p.z - n.z) * dx) <= .5
    }
    while (st.path.length > 1 && passed(st.path[0], st.path[1])) { st.path.shift(); st.skipped++ }
  })
  bot.on('physicsTick', () => {
    if (!on(bot) || !st.path.length || !bot.entity) return
    if (process.env.ND_SPRINT_TRACE === '1') {
      const e = bot.entity; const c = k => bot.getControlState(k) ? k[0] : '-'
      console.log('[sj]', e.position.x.toFixed(2), e.position.y.toFixed(2), e.position.z.toFixed(2), Math.hypot(e.velocity.x, e.velocity.z).toFixed(3), e.onGround ? 'G' : 'A', c('forward') + c('sprint') + c('jump'), st.path.length)
    }
    if (!shouldJump(bot, st.path)) return
    st.dir = [Math.round(st.path[1].x - st.path[0].x), Math.round(st.path[1].z - st.path[0].z)]
    st.until = st.tick + 20
    if (process.env.ND_SPRINT_TRACE === '1') console.log('[sj] jump', JSON.stringify(st.path.slice(0, 7).map(n => [n.x, n.y, n.z])))
    bot.setControlState('jump', true)
    st.jumps++
  })
}

module.exports = { install, on, shouldJump, AHEAD }
