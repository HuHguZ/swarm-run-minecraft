'use strict'
// RPC демона — гонка вооружений (поток «тайники», 21.10): скан глаз и «пирога» с места (src/cache-scan.ts) и подъём жемчугом
// наверх (pearl-hop: бросок по расчёту траектории, в прыжке — выше: вертикаль прыжка 0.42 прибавляется к броску).
import type { RpcContext } from './context'

function cacheMethods ({ session }: RpcContext) {
  // Бросок наверх: те же расчёты, что pearl_to (planRoute/planHop: сетка посадок, полёт по блокам, разброс ±0.7), но с
  // броском в прыжке (jump: 'stand' — на месте; 'run' — ещё и с разбегом, рискованно у стен) и только с посадкой у самой
  // цели (mustArrive: наверх пешком не дойти — «долететь до рядов, а дальше пешком» не годится).
  const upOpts = (p: any, ctl: any) => ({ reserve: 0, minGain: -999, hpMin: 3, maxHops: p.maxHops ?? 2, arriveR: p.arriveR ?? 3, walkSec: 999,
    edgeOk: p.edgeOk ?? true, yTop: p.yTop ?? 45, yBot: p.yBot ?? 8, jump: p.jump ?? 'stand', mustArrive: p.mustArrive ?? true, abortIf: () => !!ctl?.aborted })
  return {
    cache_scan: async (p: any = {}) => session.immediate(async () => (require('../cache-scan') as typeof import('../cache-scan')).cacheScan(session.require(), p || {})),
    // Есть ли отсюда бросок к to (без броска): посадка, дуга, прыжок — или почему нет.
    pearl_plan: async (p: any = {}) => session.immediate(async () => {
      const bot = session.require(); const ph = require('../pearl-hop')
      if (!p?.to) throw new Error('нужна точка to')
      const o = upOpts(p, null)
      const r = ph.planHop(ph.worldOf(bot), bot.entity.position, p.to, { ...o, maxTries: p.maxTries ?? 40 })
      // Бросок есть, но посадка не у цели (ближайшая годная — на рядах) — для подъёма это «нет броска».
      const near = r.plan && Math.hypot(r.plan.feet.x - p.to.x, r.plan.feet.y - p.to.y, r.plan.feet.z - p.to.z) <= (p.arriveR ?? 3) + 1
      return near ? { ok: true, feet: r.plan.feet, arc: r.plan.arc, jump: r.plan.jump, ticks: r.plan.ticks, rem: r.plan.rem } : { ok: false, why: r.plan ? { 'посадка не у цели': Math.round(r.plan.rem) } : r.why, cands: r.cands }
    }),
    pearl_up: async (p: any = {}) => session.runIntent('pearl_up', async (ctl) => {
      const bot = session.require(); const ph = require('../pearl-hop')
      if (!p?.to) throw new Error('нужна точка to')
      const lines: string[] = []
      const r = await ph.hopTo(bot, p.to, { ...upOpts(p, ctl), log: (m: string) => lines.push(m) })
      const me = bot.entity.position
      const ok = Math.hypot(me.x - p.to.x, me.y - p.to.y, me.z - p.to.z) <= (p.arriveR ?? 3) + 1
      return { ok, hops: r.hops, stop: r.stop, why: r.why, steps: r.steps, log: lines.slice(-4), at: { x: Math.round(me.x), y: Math.round(me.y), z: Math.round(me.z) } }
    }, { timeoutMs: 15000, interruptOn: ['death', 'kicked', 'disconnected'], params: p || {} })
  }
}

export { cacheMethods }
