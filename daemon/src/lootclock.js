'use strict'
const gameClock = require('./game-clock')
// Часы кучи после смерти. Предмет стареет только в своём tick()
// (ItemEntity.age++, исчезает на despawnRate = 6000 тиков), а тикают лишь
// сущности в чанках в пределах дистанции симуляции от игрока
// (server.properties simulation-distance, по умолчанию 10 чанков) — и в
// чанках спавна (gamerule spawn_chunk_radius, 2). Возродился далеко — чанк
// встал, куча ждёт. Настенные часы от момента смерти врут: recover
// отказывался «не успею за 129 с» от кучи, которая стояла замороженной.
//
// Здесь считаем, сколько секунд куча действительно тикала: пока тело в том же
// мире и не дальше SIM чанков (Чебышёв) от неё — или она у точки спавна.
const SIM = Number(process.env.ND_SIM_CHUNKS || 10)
const SPAWN_CHUNKS = 2

function chunkDist (a, b) {
  return Math.max(Math.abs(Math.floor(a.x / 16) - Math.floor(b.x / 16)), Math.abs(Math.floor(a.z / 16) - Math.floor(b.z / 16)))
}

function install (session) {
  if (session._lootclock && !session._lootclock.clock?.disposed) return
  let lastSave = gameClock.wall.now()
  session._lootclock = gameClock.setInterval(() => {
    const bot = session.bot
    const deaths = session.journal && session.journal.state && session.journal.state.deaths
    if (!bot || !bot.entity || !Array.isArray(deaths)) return
    const dim = (bot.game && bot.game.dimension) || 'overworld'
    let changed = false
    for (let i = Math.max(0, deaths.length - 5); i < deaths.length; i++) {
      const d = deaths[i]
      if (!d || d.recovered || !d.pos || typeof d.pos.x !== 'number') continue
      if (typeof d.ticking !== 'number') d.ticking = 0
      if (d.ticking >= 300) continue
      const here = (d.dimension || 'overworld') === dim
      const near = here && chunkDist(bot.entity.position, d.pos) <= SIM
      const atSpawn = (d.dimension || 'overworld') === 'overworld' && bot.spawnPoint && chunkDist(bot.spawnPoint, d.pos) <= SPAWN_CHUNKS
      if (near || atSpawn) { d.ticking++; changed = true }
    }
    if (changed && gameClock.wall.now() - lastSave > 20000) {
      lastSave = gameClock.wall.now()
      try { session.journal.patch(() => {}) } catch {}
    }
  }, 1000)
  if (session._lootclock.unref) session._lootclock.unref()
}

module.exports = { install, SIM }
