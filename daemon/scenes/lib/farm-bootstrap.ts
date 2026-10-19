'use strict'
const { REPO_ROOT }: typeof import('../../src/paths') = require('../../src/paths')
const fs: typeof import('fs') = require('fs')
const path: typeof import('path') = require('path')
const gameClock: typeof import('../../src/game-clock') = require('../../src/game-clock')
const { withTimeout }: typeof import('../../src/build') = require('../../src/build')
const { configureTick, tickRate }: typeof import('../../../farm/tick-control') = require('../../../farm/tick-control')

// Only the first farm connection is paced while its collision columns are unknown.
// Normal ticks/tick_end continue: stopping them would also stop chunk delivery.
async function farmBootstrap (call, ws, player) {
  const slot = Number(process.env.FARM_SLOT)
  if (!Number.isInteger(slot) || slot < 1 || slot > 32 || ws !== `ws://127.0.0.1:${8800 + slot}` ||
    Number(process.env.MC_PORT) !== 25600 + slot || player !== `NeuroFarm${slot}`) {
    throw new Error('farm bootstrap: slot, WS, MC port and player must identify one farm slot')
  }
  const properties = fs.readFileSync(path.join(REPO_ROOT, 'farm', `server-${slot}`, 'server.properties'), 'utf8')
  const port = key => Number(new RegExp('^' + key.replace(/\./g, '\\.') + '=(.*)$', 'm').exec(properties)?.[1]?.trim())
  if (port('server-port') !== 25600 + slot || port('rcon.port') !== 25700 + slot) throw new Error('farm bootstrap: configured server/RCON ports do not match the slot')
  const server = `127.0.0.1:${25600 + slot}`
  const read = async (ms = 12000) => {
    const snapshot = await withTimeout(call('peek', { physics: true }), ms, 'farm bootstrap: readiness RPC timed out', gameClock.wall)
    if (snapshot?.detail?.server !== server) throw new Error('farm bootstrap: daemon targets another server')
    return snapshot
  }
  const initial = await read()
  if (initial.state?.connected && initial.detail?.physics?.worldLoaded === true) return withTimeout(call('connect', { bootstrapPaused: true }), 12000, 'farm bootstrap: connect RPC timed out', gameClock.wall)
  const target = tickRate({ 'tick-rate': process.env.TICK_RATE ?? process.env.ND_TICK_RATE ?? 20 })
  const rcon = (require('./try-lab-ne-map') as typeof import('./try-lab-ne-map')).rconOf(slot)
  const send = async command => {
    const reply = await rcon(command)
    if (/^ERR\b/.test(String(reply))) throw new Error(String(reply))
    return reply
  }
  let pending, connectError, watching = true, restored = false
  try {
    await configureTick(send, Math.min(20, target))
    pending = call('connect', { bootstrapPaused: true })
    // These callbacks never start work; disabling them precedes failed-connection teardown.
    pending.then(() => {}, error => { if (watching) connectError = error })
    const deadline = gameClock.wall.now() + 12000 // same transport bound as Session.waitForChunksToLoad
    let ready = false
    while (gameClock.wall.now() < deadline) {
      if (connectError) throw connectError
      const snapshot = await read(Math.max(1, deadline - gameClock.wall.now()))
      if (connectError) throw connectError
      if (snapshot.state?.connected && snapshot.detail?.physics?.worldLoaded === true) { ready = true; break }
      await gameClock.wall.sleep(50)
    }
    if (!ready) throw new Error('farm bootstrap: own collision columns did not become readable')
    await configureTick(send, target)
    restored = true
    return await withTimeout(pending, 12000, 'farm bootstrap: connect RPC timed out', gameClock.wall)
  } catch (error) {
    watching = false
    if (pending) {
      try {
        await withTimeout(call('disconnect', { reason: 'farm bootstrap failed before readiness' }), 12000, 'farm bootstrap: disconnect unconfirmed', gameClock.wall)
      } finally {
        await withTimeout(pending.catch(() => {}), 12000, 'farm bootstrap: connect teardown unconfirmed', gameClock.wall)
      }
    }
    throw error
  } finally {
    watching = false
    if (!restored) await configureTick(send, target)
  }
}

module.exports = { farmBootstrap }
export { farmBootstrap }
