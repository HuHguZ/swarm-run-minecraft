import { startWindRescue } from './combo-wind-rescue'
import { observedFallTicks } from '../../../daemon/src/bow/track'

// shortcut: three positions test only local arc consistency; extend the window if later traces expose ambiguous impulses.
export function createPostSmashObserver(baseline: any) {
  const key = (p: any) => JSON.stringify([p.t, p.kind, p.x, p.y, p.z])
  const seen = new Set<string>(baseline ? [key(baseline)] : []), points: any[] = []
  return (receipt: any, trackedVelocity: any): any => {
    const fit: any = { reason: 'insufficient_points', sampleCount: points.length }
    const unknown = (reason: string) => ({ velocity: null, confidence: false, fit: { ...fit, reason } })
    if (!receipt || ![receipt.t, receipt.x, receipt.y, receipt.z].every(Number.isFinite)) return unknown('invalid_receipt')
    const receiptKey = key(receipt)
    if (!seen.has(receiptKey)) {
      seen.add(receiptKey)
      points.push({ t: receipt.t, kind: receipt.kind, x: receipt.x, y: receipt.y, z: receipt.z })
      if (points.length > 3) points.shift()
    }
    fit.sampleCount = points.length; fit.receipts = points.map(p => ({ ...p }))
    if (points.length && key(points[points.length - 1]) !== receiptKey) return unknown('old_receipt')
    if (!trackedVelocity || ![trackedVelocity.x, trackedVelocity.z, trackedVelocity.ageTicks].every(Number.isFinite) || trackedVelocity.ageTicks < 0)
      return unknown('invalid_tracked_velocity')
    // A poll between native position packets may be stale; keep its arc for the next fresh receipt.
    if (trackedVelocity.ageTicks > 1.5) return unknown('stale_motion')
    if (points.length < 3) return unknown('insufficient_points')
    fit.dy1 = points[1].y - points[0].y; fit.dy2 = points[2].y - points[1].y
    fit.intervalTicks = observedFallTicks(fit.dy1, fit.dy2)
    if (fit.intervalTicks === null) return unknown('fit_unknown')
    // Receipt time is not a server tick count. Invert the last displacement using the house geometry fit.
    const drag = Math.fround(.98), power = drag ** fit.intervalTicks, sum = (1 - power) / (1 - drag)
    const loss = .08 * drag * (fit.intervalTicks - sum) / (1 - drag)
    fit.endVy = (fit.dy2 + loss) / sum * power - .08 * drag * sum
    return { velocity: { ...trackedVelocity, y: fit.endVy }, confidence: true, fit: { ...fit, reason: 'fit' } }
  }
}

export function startObservedWindRescue(a: any, b: any, t: any, enabled: boolean, stop: () => boolean, t0 = Date.now()) {
  return startWindRescue(a, b, t, enabled, stop, t0, createPostSmashObserver)
}

if (require.main === module) {
  const [pairs = '3', hp = '100', ...extra] = process.argv.slice(2)
  if (extra.length || !/^\d+$/.test(pairs) || +pairs < 1 || +pairs > 20 || !['20', '100'].includes(hp)) throw new Error('combo-wind-observation [pairs=3:1..20] [hp=100:20|100]')
  require('./combo-anvil').apexTrials(false, +pairs, +hp, 'wind-observed').then(() => process.exit(0), error => { console.error(error); process.exit(1) })
}
