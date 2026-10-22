'use strict'
// RPC демона — выход из лавы снаружи боя (арена: farm/arena/dangers.ts, «лава 0.0 бл.»): без pathfinder'а, сразу —
// pvp/lava-exit.escapeBurn (к ближайшей клетке поля до 3 бл., вперёд + прыжок + спринт, пока под ногами горит).
import type { RpcContext } from './context'

function pvpEscapeMethods ({ session, gameClock }: RpcContext) {
  return {
    lava_escape: async (p: any = {}) => session.runIntent('lava_escape', async (ctl) => {
      const bot = session.require()
      const { escapeBurn, burningFeet } = require('../pvp/lava-exit')
      if (!burningFeet(bot)) return { ok: true, why: 'не горит' }
      const foe = p.from && Number.isFinite(p.from.x) && Number.isFinite(p.from.z) ? p.from : null
      return escapeBurn(bot, { limitMs: Math.min(4000, p.limitMs || 2500), foe, aborted: () => ctl.aborted, sleep: ms => gameClock.sleep(ms), now: () => gameClock.now() })
    }, { timeoutMs: 5000, interruptOn: ['death', 'kicked', 'disconnected'], params: p })
  }
}

export { pvpEscapeMethods }
