'use strict'

const COUNTERS = 'swings landed crits sprintHits arrows arrowHits blocks axeOnShield crystal totem mace elytra boom hops xbow rod util calc combos melee blockLog shield vsShield storm breakUnder tricks trickDmg'.split(' ')
const LAST = new Set(['calc.last', 'melee.skill', 'elytra.reglideReflex', 'elytra.airDrops', 'elytra.blockedLooks', 'elytra.blockedBy', 'shield.confirmedTicks'])

function merge (values, key, parents = []) {
  const present = values.filter(v => v != null)
  if (!present.length) return values.at(-1)
  if (LAST.has(key)) return structuredClone(present.at(-1))
  if (['melee.combo.max', 'crystal.planMsMax', 'shield.confirmMs'].includes(key)) return Math.max(...present)
  if (key === 'shield.worn') return present.some(Boolean)
  if (key === 'melee.combo.avg' || key === 'mace.peak' || key === 'crystal.avg' || key === 'boom.avg' || key === 'crystal.planMsAvg' || /^blockLog\.(place|dig)\..+\.ms$/.test(key)) {
    const weight = p => key === 'melee.combo.avg' ? p.n : key === 'mace.peak' ? p.launched
      : key === 'crystal.avg' || key === 'boom.avg' ? p.dealt?.length : key === 'crystal.planMsAvg' ? p.planN : p.ok
    let total = 0; let n = 0
    values.forEach((v, i) => { if (Number.isFinite(v) && weight(parents[i]) > 0) { total += v * weight(parents[i]); n += weight(parents[i]) } })
    return n ? Math.round(total / n * 100) / 100 : present.length === 1 ? present[0] : null
  }
  // shortcut: knockback reports lack sample counts; retain each segment until telemetry exposes weights.
  if (/^melee\.kb(Plain|Reset|Counter)$/.test(key)) return present.length === 1 ? present[0] : null
  if (present.every(Array.isArray)) return present.flatMap(v => structuredClone(v))
  if (present.every(v => typeof v === 'number')) return present.reduce((a, b) => a + b, 0)
  if (present.every(v => typeof v === 'object')) {
    const out = {}
    for (const child of new Set<string>(present.flatMap(v => Object.keys(v)))) out[child] = merge(present.map(v => v[child]), `${key}.${child}`, present)
    return out
  }
  return present.at(-1)
}

function roundDetail (segments) {
  const out: Record<string, any> = { ...segments.at(-1), segments: structuredClone(segments) }
  for (const key of COUNTERS) {
    const values = segments.map(d => d[key])
    if (values.some(v => v != null)) out[key] = merge(values, key)
  }
  if (out.shield) {
    const s = out.shield
    s.secondsPerSwing = s.swings ? Math.round(s.contactSeconds / s.swings * 10) / 10 : null
    s.hpPerSecUnder = s.upSeconds > 0.5 ? Math.round(s.hpUnderShield / s.upSeconds * 100) / 100 : null
    s.hpPerSecOpen = s.openSeconds > 0.5 ? Math.round(s.hpOpen / s.openSeconds * 100) / 100 : null
  }
  if (segments.some(d => d.filled)) out.filled = true
  const hp = segments.map(d => d.hp).filter(v => typeof v === 'string' && v.includes(' -> '))
  if (hp.length) out.hp = `${hp[0].split(' -> ')[0]} -> ${hp.at(-1).split(' -> ')[1]}`
  return out
}

module.exports = { roundDetail }
