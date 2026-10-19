// A native target client in its own event loop: aiming CPU in the shooter must
// not slow this player's movement and then release a burst of queued ticks.
import { createGameBot } from '../lib/scene-kit'
import sky = require('../../src/elytra')
import { createPacketWitness } from './air-ranged-witness'
if (process.env.FARM_SLOT !== '31' || process.env.MC_PORT !== '25631') throw new Error('air target is farm31 only')
const bot = createGameBot({ host: '127.0.0.1', port: 25631, username: 'NeuroAT31', auth: 'offline', version: '1.21.11', viewDistance: 'tiny' }, { primary: true })
sky.install(bot)
const witness = createPacketWitness(bot, process.env.AIR_TRACE === '1')
let spawned = false
let active = false
let flying = false
let reversed = false
let turnAt: number | null = null
let started = 0
let chunkAt = Date.now()
const publish = () => {
  if (!process.connected || !bot.entity?.position) return
  process.send?.({ type: 'state', spawned, health: bot.health, food: bot.food, gameMode: bot.game?.gameMode, dimension: bot.game?.dimension,
    position: { ...bot.entity.position }, velocity: { ...bot.entity.velocity }, grounded: bot.entity.onGround,
    gliding: sky.gliding(bot.entity), loaded: !!bot.blockAt(bot.entity.position), quietMs: Date.now() - chunkAt,
    clock: { ...bot.ndClock.snapshot(), pacingSampled: bot.ndClock.pacingSampled,
      sampleAge: String(bot.ndClock.sampleAge), sampleAt: bot.ndClock.sampleAt }, driveStarted: active ? started : null, reversed })
}
bot.once('spawn', () => { spawned = true; publish() })
bot.on('health', publish)
bot.on('forcedMove', publish)
bot._client.on('map_chunk', () => { chunkAt = Date.now() })
bot.on('physicsTick', () => {
  if (active) {
    bot.setControlState('forward', true); bot.setControlState('sprint', true)
    if (turnAt !== null && bot.ndClock.ticks - started >= turnAt && !reversed) {
      reversed = true; bot.look(Math.PI / 2, 0, true).catch(() => {})
    }
    if (flying && !bot.entity.onGround && bot.entity.velocity.y < 0 && !sky.gliding(bot.entity)) sky.startGlide(bot)
  }
  if (bot.ndClock.ticks % 5 === 0) publish()
})
// Readiness is transport state and must publish while native game ticks freeze.
const stateTimer = setInterval(publish, 40)
const quit = () => { clearInterval(stateTimer); witness.dispose(); bot.clearControlStates(); bot.quit('air target fixture done'); bot.ndClock.dispose() }
process.on('message', (message: any) => {
  if (message.type === 'coast') {
    active = false; reversed = false; bot.clearControlStates(); publish()
    const trace = witness.drain()
    if (trace && message.witnessId !== undefined) process.send?.({ type: 'packet-witness', id: message.witnessId, trace })
  }
  if (message.type === 'drive') {
    witness.start()
    active = true; flying = !!message.flying; turnAt = message.turnAt ?? null
    reversed = false; started = bot.ndClock.ticks
  }
  if (message.type === 'turn') { turnAt = bot.ndClock.ticks - started + message.ticks; reversed = false }
  if (message.type === 'quit') quit()
})
process.once('disconnect', quit)
bot.once('end', () => { clearInterval(stateTimer); if (process.connected) process.disconnect?.() })
bot.once('error', (error: Error) => { process.send?.({ type: 'error', message: error.message }); quit() })
bot.once('kicked', (reason: any) => { process.send?.({ type: 'error', message: String(reason) }); quit() })
