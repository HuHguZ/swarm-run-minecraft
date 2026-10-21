import * as gameClock from '../game-clock'
import { FACES, FILLER, FALLING, placeBlockAt, pickFiller } from '../build'
import { eyeOf, blockAim, faceAim } from '../pick'

export const plugWaterEnabled = () => process.env.ND_DIG_PLUG_WATER === '1'
const liquid = b => b && /^(water|bubble_column|lava)$/.test(b.name)
const key = p => `${p.x},${p.y},${p.z}`
export function liquidSeen(bot, b) {
  if (!b) return false
  try {
    const eye = eyeOf(bot), delta = b.position.offset(.5, .5, .5).minus(eye), dist = delta.norm()
    if (dist < .01) return true
    // Like sight.seesBlock, with opaque lava: water behind lava is not known.
    const hit = bot.world.raycast(eye, delta.scaled(1 / dist), dist + .5,
      (cell, ray) => cell.name === 'lava' || cell.position.equals(b.position) || !!ray.intersect(cell.shapes, cell.position))
    return !!hit && hit.position.equals(b.position)
  } catch { return false }
}

export function plugBudget() {
  const n = Number(process.env.ND_DIG_PLUG_WATER_MAX_BLOCKS ?? 16)
  return { limit: Number.isFinite(n) ? Math.max(0, Math.min(64, Math.floor(n))) : 16,
    placed: [] as { name: string; at: any }[], tries: new Map<string, number>() }
}

export async function digVisibleBlock(bot, block, ctl) {
  if (!plugWaterEnabled()) return bot.dig(block)
  const aim = blockAim(bot, block.position, { range: 4.5, seeThrough: null })
  if (!aim) throw new Error('блок забоя не в прицеле — сначала подойди')
  await bot.lookAt(aim, true)
  if (ctl.aborted) throw new Error('прервано')
  // Mineflayer otherwise aims at the centre again, which can be behind an edge
  // even when blockAim found a genuinely visible point on the target face.
  return bot.dig(block, 'ignore')
}

// Only presently visible liquid is actionable. No source search through walls,
// no virtual removal of rock, no steering from unseen liquid. Re-read after each
// swing/placement: an aquifer is learned when its wall actually opens.
export async function plugVisibleLiquids(bot, ctl, cells, deadline, budget = plugBudget()) {
  if (!plugWaterEnabled()) return null
  const path = new Set(cells.map(key))
  for (;;) {
    if (ctl.aborted) return 'прервано'
    if (gameClock.now() >= deadline) return 'время на затычку вышло — обходи другим направлением'
    const nearby = new Map<string, any>()
    // Клетки самого тела не затыкаются («это моя же клетка» — owC2-03: стоял в луже, 20 отказов спуска подряд, отход «от себя» на месте).
    const feet = bot.entity?.position?.floored?.()
    const own = feet ? new Set([key(feet), key(feet.offset(0, 1, 0))]) : new Set<string>()
    for (const c of cells) for (const p of [c, ...FACES.map(f => c.plus(f))]) {
      const b = bot.blockAt(p)
      if (liquid(b) && liquidSeen(bot, b) && !own.has(key(p))) nearby.set(key(p), b)
    }
    // Seal the wall/roof first, not the water it has already poured into the
    // corridor. Higher cells precede lower ones; flowing water is not a source
    // coordinate and grants no knowledge of an invisible source.
    const candidates = [...nearby.values()].sort((a, b) =>
      Number(path.has(key(a.position))) - Number(path.has(key(b.position))) || b.position.y - a.position.y)
    if (!candidates.length) return null
    // The source itself may have no clickable support while its observable
    // flow inside the opening does. Try the reachable flow in that case.
    const reachable = candidates.find(b => FACES.some(face => {
      const ref = bot.blockAt(b.position.minus(face))
      return ref?.boundingBox === 'block' && !!faceAim(bot, ref.position, face)
    }))
    const b = reachable || candidates[0], p = b.position, k = key(p), lava = b.name === 'lava'
    const label = `${lava ? 'лава' : 'вода'} на ${k}`
    const bypass = why => `${label}: ${why} — обходи другим направлением или на 3 блока в сторону`
    if (!reachable) return bypass('нет видимой грани для затычки')
    // 21.10 (ow): видимую лаву не затыкаю — стою у неё, пока ставлю блок, и течение доходит до тела (owKR-owA1-05: горел на лестнице y33).
    // ND_DIG_PLUG_WATER_LAVA=1 — прежняя затычка лавы.
    if (lava && process.env.ND_DIG_PLUG_WATER_LAVA !== '1') return bypass('видимая лава — не затыкаю, обхожу')
    if (eyeOf(bot).distanceTo(p.offset(.5, .5, .5)) > 4.5) return bypass('видна, но вне досягаемости')
    // The repeat cap prices a reservoir explicitly instead of mining out and
    // replacing the same plug forever. Total cost belongs to the whole intent.
    if (budget.placed.length >= budget.limit || (budget.tries.get(k) || 0) >= 2) return bypass('бюджет затычек исчерпан')
    const stack = lava ? bot.inventory.items().find(i => i.count > 0 && FILLER.includes(i.name) && !FALLING.has(i.name))
      : pickFiller(bot, { steady: true })
    if (!stack) return bypass('нечем заткнуть устойчивым блоком')
    // One block and a bounded placement versus a three-block detour. If the
    // remaining intent cannot pay even one placement, return the alternative.
    const ms = Math.min(1500, deadline - gameClock.now())
    if (ms <= 0) return bypass('нет времени на затычку')
    budget.tries.set(k, (budget.tries.get(k) || 0) + 1)
    const put = await placeBlockAt(bot, p, { item: stack.name, steady: true, honest: true, exactAim: true, ctl, timeoutMs: ms })
    const after = bot.blockAt(p)
    if (!put.ok || !after || after.boundingBox !== 'block' || liquid(after)) return bypass(put.reason || 'блок не подтвердился')
    budget.placed.push({ name: b.name, at: { x: p.x, y: p.y, z: p.z } })
  }
}
