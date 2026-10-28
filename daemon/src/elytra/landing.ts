import { glideStep, rollout } from './physics'
import { G, HALF, SAFE_FALL, TICK_MS, wrap } from './consts'

// Keep complete landing manoeuvres, not a constant look until first contact.
// The world belongs to one bot. Recheck the remaining route against fresh geometry each tick.
const routes = new WeakMap<object, any>()

export function landingPlan (W, st, goal, price, H = 18) {
  let work = 0
  // В явно оплаченном спуске допустим урон; касание прогноза чуть входит в пол, итог считает landingDamage.
  const safeLimit = SAFE_FALL + (goal.maxFallDamage > 0 ? goal.maxFallDamage + 1 - 1e-6 : 0)
  const accepts = fd => goal.maxFallDamage > 0 ? fd < safeLimit : fd <= SAFE_FALL
  // A CPU budget, not a flight-physics coefficient. Exhaustion retains choose's local fallback.
  const exhausted = {}
  const spend = () => { if (++work > 32768) throw exhausted }
  const key = [goal.at.x, goal.at.y, goal.at.z, goal.arena?.x, goal.arena?.z, goal.arena?.r, goal.arena?.killY].join(',')
  const advance = (s, command, count = true) => {
    if (count) spend()
    const r = rollout(W, s.p, s.v, command.yaw, command.pitch, s.boost, 1, { fd: s.clientFd ?? s.fd, arena: goal.arena })
    // Player fall accounting follows accepted movement, not the client's velocity threshold.
    const fd = r.p.y > s.p.y && !r.kind ? 0 : s.fd + Math.max(0, s.p.y - r.p.y)
    return { ...r, clientFd: r.fd, fd, boost: Math.max(0, s.boost - 1),
      boostMin: s.boostMin === undefined ? undefined : Math.max(0, s.boostMin - 1),
      boostMax: s.boostMax === undefined ? undefined : Math.max(0, s.boostMax - 1) }
  }
  const evaluate = (path, boost = st.boost) => {
    let s: any = { p: st.p, v: st.v, boost, fd: st.fd }
    for (let i = 0; i < path.length; i++) {
      s = advance(s, path[i])
      if (s.kind) {
        if (s.kind !== 'floor' || !accepts(s.fd)) return null
        const r = { ...s, t: i + 1 }
        const { c, safe } = price(r)
        return safe ? { c, r, path: path.slice(0, i + 1) } : null
      }
    }
    return null
  }
  const certify = path => {
    // shortcut: check mean and expiry bounds only; intermediate expiry can follow a different curved trajectory.
    const nominal = evaluate(path)
    if (!nominal) return null
    let c = nominal.c
    const checked = new Set([st.boost])
    for (const boost of [st.boostMin, st.boostMax]) {
      if (!(boost >= 0) || checked.has(boost)) continue
      checked.add(boost)
      const bound = evaluate(nominal.path, boost)
      if (!bound) return null
      c = Math.max(c, bound.c)
    }
    return { ...nominal, c }
  }
  let best = null
  const search = () => {
    const remembered = routes.get(W)
    if (remembered?.key === key && remembered.path.length) {
      const q = remembered.expected
      // One observed rocket expiry survives age quantisation; recheck its bounded complete paths below.
      // A different/vanished rocket changes the identity and cannot hide behind a similar countdown.
      const sameForecast = st.boostUntil != null || remembered.boostUntil != null
        ? st.boostUntil === remembered.boostUntil : st.boost === q.boost && st.boostMax === q.boostMax
      if (Math.hypot(st.p.x - q.p.x, st.p.y - q.p.y, st.p.z - q.p.z) <= HALF &&
          Math.hypot(st.v.x - q.v.x, st.v.y - q.v.y, st.v.z - q.v.z) <= G && sameForecast && st.boostMin === q.boostMin) {
        const valid = certify(remembered.path)
        if (valid && (st.boost === q.boost && st.boostMax === q.boostMax || valid.c <= remembered.c)) {
          const command = valid.path[0]
          return { ...command, ...valid }
        }
      }
      routes.delete(W)
    }
    const heading = Math.atan2(-st.v.x, -st.v.z)
    const curves = [0, .9 / H, -.9 / H, 1.35 / H, -1.35 / H, 2 / H, -2 / H]
    const maxTicks = Math.min(12000 / TICK_MS, Math.ceil(Math.max(SAFE_FALL, st.p.y - goal.at.y) / SAFE_FALL) * H * 2)
    for (const dive of [-1.3, -1, -.75, -.55, -.38, 0]) for (const flare of [.28, .45, .7, .95]) for (const curve of curves) {
      const path = []
      let s: any = { p: st.p, v: st.v, boost: st.boost, fd: st.fd }
      let recovering = false
      const commandAt = (t, pitch) => ({ yaw: wrap(heading + curve * t), pitch })
      // This client-style fall channel only prunes the search to retain S7d descent control.
      // Final acceptance uses independent movement fd and the complete collision-checked path.
      const canRecover = (from, t) => {
        if (from.kind) return from.kind === 'floor' && accepts(from.fd)
        const p = { ...from.p }; const v = { ...from.v }
        let fd = from.fd; let clientFd = from.clientFd ?? fd; let boost = from.boost
        for (let j = 0; j < H; j++) {
          spend()
          const oldY = p.y
          if (v.y > -0.5 && clientFd > 1) clientFd = 1
          const command = commandAt(t + j, flare)
          glideStep(p, v, command.yaw, command.pitch, boost > 0)
          boost--
          fd = p.y > oldY ? 0 : fd + Math.max(0, oldY - p.y)
          clientFd += Math.max(0, oldY - p.y)
          if (!accepts(clientFd)) return false
          if (p.y > oldY) return true
          if (p.y <= goal.at.y && accepts(fd)) return true
        }
        return false
      }
      for (let t = 0; t < maxTicks; t++) {
        if (!recovering) {
          const trial = advance(s, commandAt(t, dive))
          if (!canRecover(trial, t + 1)) recovering = true
        }
        const command = commandAt(t, recovering ? flare : dive)
        path.push(command)
        const before = s.p.y
        s = advance(s, command)
        if (s.kind) {
          if (s.kind === 'floor' && accepts(s.fd)) {
            const result = certify(path)
            if (result) {
              if (!best || result.c < best.c) best = { ...path[0], ...result }
            }
          }
          break
        }
        if (s.p.y > before) recovering = false
      }
    }
    return best
  }
  let plan = null
  try { plan = search() } catch (e) { if (e !== exhausted) throw e; plan = best }
  if (!plan) return null
  routes.set(W, { key, c: plan.c, boostUntil: st.boostUntil, expected: advance(st, plan, false), path: plan.path.slice(1) })
  return { yaw: plan.yaw, pitch: plan.pitch, c: plan.c, r: plan.r, work }
}
