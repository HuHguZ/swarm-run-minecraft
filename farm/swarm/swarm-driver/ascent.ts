// Одно тело — один подъём: прицел не рвёт продвижение, а стояние не получает вечную защиту.
import { blockCount, distance } from './common'

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
