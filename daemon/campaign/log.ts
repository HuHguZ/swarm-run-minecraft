'use strict'
// Журнал кампании и телеметрия: строка лога, снимок стыка (ND_E2E).
import { LOG, E2E, SEAM_FLAGS } from './flags'
import { T0, stage, state, sit, memorySnapshot, known } from './state'
const fs: typeof import('fs') = require('fs')
const gameClock: typeof import('../src/game-clock') = require('../src/game-clock')
const telemetry = (() => { try { return (require('../src/telemetry') as typeof import('../src/telemetry')) } catch { return { on: () => false, snapshot: () => null, delta: () => ({}), outcome: () => ({}), record () {} } } })()
const telParams = p => { try { return JSON.stringify(p).slice(0, 300) } catch { return null } }
function seamSnapshot (seam) {
  if (!E2E) return
  log(`СТЫК ${JSON.stringify({ at: new Date().toISOString(), seconds: Math.round((gameClock.now() - T0) / 1000),
    seam, stage, body: { dimension: state.dimension, pos: state.pos, health: state.health, food: state.food,
      inventory: state.inventory || {}, armor: state.armor || {}, offHand: state.offHand || null,
      potions: state.potions || null, effects: state.effects || null },
    situation: { tod: sit.tod ?? null, night: sit.night ?? null, surface: sit.surface ?? null },
    memory: memorySnapshot, known, flagsExplicit: Object.fromEntries(SEAM_FLAGS.filter(k => process.env[k] !== undefined).map(k => [k, process.env[k]])) })}`)
}
function log (line) {
  const t = new Date().toTimeString().slice(0, 8)
  const m = Math.round((gameClock.now() - T0) / 60000)
  const s = `[${t} +${String(m).padStart(3)}м] ${stage.padEnd(10)} ${line}`
  console.log(s)
  try { fs.appendFileSync(LOG, s + '\n') } catch {}
}

export { telemetry, telParams, seamSnapshot, log }
