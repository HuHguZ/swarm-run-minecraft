// Одно тело — один подъём: прицел не рвёт продвижение, а стояние не получает вечную защиту.
import { blockCount, cellKey, distance } from './common'
import { currentTurn } from './lifecycle'

export const ladderEntry = (route, from) => from.y >= route.base.y && from.y < route.top.y &&
  Math.hypot(from.x - route.base.x, from.z - route.base.z) <= 1 ? from : route.base

export function readyLadder (sw, b, to, from = sw.pos[b.name]?.p) {
  if (!from) return undefined
  return (sw.ladderRoutes || []).filter(l => l.top.y > from.y + .6 && l.top.y <= to.y + 1 &&
    (l.base.y >= from.y - 1 || ladderEntry(l, from) === from) &&
    Math.hypot(l.top.x - to.x, l.top.z - to.z) < 12 && !sw.blocked(b, `ladder:${b.name}:${cellKey(l.base)}`))
    .sort((a, c) => distance(from, a.base) - distance(from, c.base))[0]
}

export function ascentActive (b, frame, now = Date.now()) {
  const run = b.swarmAscent
  if (!b.climbing || !run?.pending || run.stopping || !frame?.p ||
      !Number.isFinite(frame.observedAt) || !Number.isFinite(frame.frameAt) ||
      now - Math.min(frame.observedAt, frame.frameAt) > 5000) return false
  const left = distance(frame.p, run.to), blocks = blockCount(frame.inv) + (frame.inv?.ladder || 0)
  if (left < run.left - .35 || frame.p.y > run.y + .35 || blocks < run.blocks) {
    run.left = Math.min(run.left, left); run.y = Math.max(run.y, frame.p.y); run.blocks = Math.min(run.blocks, blocks)
    run.progressAt = now; run.stalled = false
  }
  // Застывшая физика или старый status не доказывают, что путь застрял.
  const changed = frame.frame !== run.frame
  run.frame = frame.frame
  if (changed && now - run.progressAt >= 1500) { run.stalled = true; return false }
  return !run.stalled
}

export async function runAscent (b, frame, to, call, now = Date.now) {
  const run = { to: { ...to }, left: distance(frame.p, to), y: frame.p.y,
    blocks: blockCount(frame.inv) + (frame.inv?.ladder || 0), progressAt: now(), frame: frame.frame, pending: true, stalled: false }
  b.climbing = true; b.swarmAscent = run
  try { return await call() } finally {
    run.pending = false
    if (b.swarmAscent === run) { delete b.swarmAscent; b.climbing = false }
  }
}

export async function followLadder (sw, b, route, arena, seconds = 25) {
  const round = sw.generation, frame = sw.pos[b.name], started = sw.now()
  const interrupted = () => ({ status: 'interrupted', detail: { interrupted: true } })
  return runAscent(b, frame, route.top, async () => {
    if (ladderEntry(route, frame.p) !== frame.p && distance(frame.p, route.base) > .6) {
      const walk = await sw.go(b, { ...route.base, _climb: true }, .4, seconds, arena)
      if (!currentTurn(sw, b, round)) return interrupted()
      if (walk?.status === 'interrupted' || !sw.detail(walk).arrived) return walk
    }
    if (!currentTurn(sw, b, round)) return interrupted()
    const result = await b.c.call('ladder_up', { wall: { x: Math.floor(route.top.x), y: route.base.y, z: Math.floor(route.top.z) },
      face: { x: route.base.x - route.top.x, z: route.base.z - route.top.z }, top: route.top.y - 1,
      timeoutSeconds: Math.max(.05, seconds - (sw.now() - started) / 1000), arena, _climb: true })
    return currentTurn(sw, b, round) ? result : interrupted()
  }, sw.now).catch(e => currentTurn(sw, b, round) ? { status: 'failed', error: e.message } : interrupted())
}
