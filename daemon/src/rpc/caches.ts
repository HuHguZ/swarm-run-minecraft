'use strict'
// RPC демона — гонка вооружений (поток «тайники», 21.10): скан глаз и «пирога» с места (src/cache-scan.ts) и подъём жемчугом
// наверх (pearl-hop: бросок по расчёту траектории, в прыжке — выше: вертикаль прыжка 0.42 прибавляется к броску).
import type { RpcContext } from './context'
import { withinArena } from '../navigation/parkour/model'
import { stablePearlPost } from '../navigation/pearl-stand'

function cacheMethods ({ session }: RpcContext) {
  // Бросок наверх: те же расчёты, что pearl_to (planRoute/planHop: сетка посадок, полёт по блокам, разброс ±0.7), но с
  // броском в прыжке (jump: 'stand' — на месте; 'run' — ещё и с разбегом, рискованно у стен) и только с посадкой у самой
  // цели (mustArrive: наверх пешком не дойти — «долететь до рядов, а дальше пешком» не годится).
  const upOpts = (bot, p: any, ctl: any) => ({ observed: true, reserve: 0, minGain: -999, hpMin: 3, maxHops: p.maxHops ?? 2, arriveR: p.arriveR ?? 3, walkSec: 999,
    avoid: p.arena ? landing => !withinArena(bot, landing, p.arena) : undefined,
    minBlockY: Number.isFinite(p.arena?.killY) ? Math.floor(p.arena.killY) : undefined,
    edgeOk: p.edgeOk ?? true, yTop: p.yTop ?? 45, yBot: p.yBot ?? 8, jump: p.jump ?? 'stand', mustArrive: p.mustArrive ?? true,
    maxTries: p.maxTries, abortIf: () => !!ctl?.aborted })
  return {
    cache_scan: async (p: any = {}) => session.immediate(async () => (require('../cache-scan') as typeof import('../cache-scan')).cacheScan(session.require(), p || {})),
    pearl_stand: async (p: any = {}) => session.runIntent('pearl_stand', ctl => (require('../navigation/pearl-stand') as typeof import('../navigation/pearl-stand')).pearlStand(session, ctl, p),
      { timeoutMs: 2500, interruptOn: ['damage', 'death', 'kicked', 'disconnected'], params: p }),
    // Есть ли отсюда бросок к to (без броска): посадка, дуга, прыжок — или почему нет.
    pearl_plan: async (p: any = {}) => session.immediate(async () => {
      const bot = session.require(); const ph = require('../pearl-hop')
      if (!p?.to) throw new Error('нужна точка to')
      const o = upOpts(bot, p, null)
      const r = ph.planAscentHop(ph.worldOf(bot, o.minBlockY, o.observed), bot.entity.position, p.to, { ...o, obstacles: ph.obstaclesOf(bot, true) })
      return r.plan ? { ok: true, feet: r.plan.feet, arc: r.plan.arc, jump: r.plan.jump, ticks: r.plan.ticks, rem: r.plan.rem } : { ok: false, why: r.why, cands: r.cands }
    }),
    pearl_up: async (p: any = {}) => session.runIntent('pearl_up', async (ctl) => {
      const bot = session.require(); const ph = require('../pearl-hop')
      if (!p?.to) throw new Error('нужна точка to')
      const lines: string[] = []
      const r = await ph.hopTo(bot, p.to, { ...upOpts(bot, p, ctl), log: (m: string) => lines.push(m) })
      const me = bot.entity.position
      const ok = Math.hypot(me.x - p.to.x, me.y - p.to.y, me.z - p.to.z) <= (p.arriveR ?? 3) + 1
      const last = r.steps?.at(-1)
      const landed = ok ? !r.stop || r.stop === 'у цели' : r.stop === 'нет броска' && last?.moved === true
      const landing = landed && !ctl?.aborted && r.hops > 0 && last?.err <= 4 && stablePearlPost(bot, p.arena)
        ? { x: me.x, y: me.y, z: me.z } : undefined
      return { ok, hops: r.hops, launchAt: r.launchAt, stop: r.stop, why: r.why, steps: r.steps, log: lines.slice(-4),
        ...(landing && (ok ? { landing } : { partialLanding: landing })), at: { x: Math.round(me.x), y: Math.round(me.y), z: Math.round(me.z) } }
    }, { timeoutMs: 15000, interruptOn: ['death', 'kicked', 'disconnected'], params: p || {} })
  }
}

export { cacheMethods }
