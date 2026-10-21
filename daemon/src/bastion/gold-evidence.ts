'use strict'
// Only observations made at a reached target; every source keeps its own hypothesis/slot rank.
const on = () => process.env.ND_BASTION_GOLD_EVIDENCE === '1'
const pieceKey = c => c ? `${c.piece}|${c.r}|${c.t.x},${c.t.y},${c.t.z}` : ''

function claimGold (st, pos, wall, rank) {
  if (st.goldRejected?.has(pieceKey(wall))) return
  const k = `${pos.x},${pos.y},${pos.z}`
  const v = st.pred.get(k)
  if (v && !v.wall) return // A directly observed/manual target keeps its provenance.
  if (!v) { if (!st.gold.has(k)) st.pred.set(k, { pos, piece: wall.piece, rank, wall, sources: [{ rank, wall }] }); return }
  const sources = v.sources ||= v.wall ? [{ rank: v.rank, wall: v.wall }] : []
  if (!sources.some(s => s.rank === rank && pieceKey(s.wall) === pieceKey(wall))) sources.push({ rank, wall })
}

function observedGold (st, k, name) {
  const v = st.pred.get(k)
  if (!v || st.goldObserved?.get(k) === name) return
  const sources = v.sources || (v.wall ? [{ rank: v.rank, wall: v.wall }] : [])
  ;(st.goldObserved ||= new Map()).set(k, name)
  if (name === 'gold_block') {
    st.rankHit ||= {}
    // A shared gold cell supports all of its sources; three shared hits do not select a root.
    for (const rank of new Set<number>(sources.map(s => s.rank))) st.rankHit[rank] = (st.rankHit[rank] || 0) + 1
    return
  }
  // 1.21.11 hoglin_stable/ramparts uses stable_degradation: it never replaces G.
  // Reject this physical gold-bearing variant only. Other slots, roots and processors stay possible.
  const rejected = st.goldRejected ||= new Set()
  for (const s of sources) if (s.wall.piece === 'hoglin_stable/ramparts/ramparts_1') rejected.add(pieceKey(s.wall))
  for (const [key, q] of st.pred) {
    const claims = q.sources || (q.wall ? [{ rank: q.rank, wall: q.wall }] : [])
    if (!claims.length) continue
    const left = claims.filter(s => !rejected.has(pieceKey(s.wall)))
    if (!left.length) st.pred.delete(key)
    else { q.sources = left; q.rank = left[0].rank; q.wall = left[0].wall; q.piece = left[0].wall.piece }
  }
  st.pieces = (st.pieces || []).filter(c => !rejected.has(pieceKey(c)))
}

export { on, pieceKey, claimGold, observedGold }
