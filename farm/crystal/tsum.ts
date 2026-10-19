'use strict'
// Сводка дуэлей арены по приёмам (аудит комбо Technoblade, 2026-10-06): строки
// «ROUND {...}» из вывода арены (farm/crystal/*.out). По наборам: победы по
// бойцам и по ролям A/B (смена сторон), длительность, фактический TPS и
// отставание часов, удары, затем приёмы — в скольких раундах, сколько раз и
// оценка урона (trickDmg: падение хп врага за 1.5 с после приёма).
//   node dist/farm/crystal/tsum.js 'farm/crystal/s7-*.out' [--kit копья] [--top 25] [--json]
import * as fs from 'fs'
import path = require('path')

function files (args) {
  const out = []
  for (const a of args) {
    if (a.includes('*')) {
      const dir = path.dirname(a)
      const re = new RegExp('^' + path.basename(a).replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*') + '$')
      for (const f of fs.readdirSync(dir)) if (re.test(f)) out.push(path.join(dir, f))
    } else out.push(a)
  }
  return out
}

function parse (text, file = '') {
  const out = []
  for (const line of String(text).split(/\r?\n/)) {
    const i = line.indexOf('ROUND {')
    if (i < 0) continue
    try { const r = JSON.parse(line.slice(i + 6)); r.file = file; out.push(r) } catch {}
  }
  return out
}

// Метки с числами («арбалет: выстрелов 3, попал 1») — шаблон «…выстрелов #,
// попал #» и сумма чисел по местам; остальные — счёт применений.
const NUM = /-?\d+(?:\.\d+)?/g
function addTrick (acc, key, n, dmg) {
  const nums = key.match(NUM)
  const tpl = nums ? key.replace(NUM, '#') : key
  const t = acc[tpl] || (acc[tpl] = { rounds: 0, uses: 0, dmg: 0, nums: null })
  t.rounds++
  if (nums) t.nums = nums.map((x, i) => Math.round(((t.nums && t.nums[i]) || 0) * 10 + Number(x) * 10) / 10)
  else t.uses += n
  t.dmg = Math.round((t.dmg + (dmg || 0)) * 10) / 10
}
const label = (tpl, t) => t.nums ? tpl.replace(/#/g, () => String(t.nums.shift())) : tpl

function summarize (rounds) {
  const kits = {}
  for (const r of rounds) {
    const k = kits[r.kit] || (kits[r.kit] = { kit: r.kit, n: 0, draws: 0, byName: {}, byRole: { a: 0, b: 0 }, dur: [], tps: [], phys: {}, lag: 0, deaths: {}, ringouts: 0, hits: {}, weapons: {}, tricks: {} })
    k.n++
    if (!r.winner) k.draws++
    else {
      k.byName[r.winner] = (k.byName[r.winner] || 0) + 1
      k.byRole[r.a && r.a.name === r.winner ? 'a' : 'b']++
    }
    k.dur.push(r.durS)
    if (r.tps) k.tps.push(r.tps)
    if (r.lagMax) k.lag = Math.max(k.lag, r.lagMax.a || 0, r.lagMax.b || 0)
    for (const role of ['a', 'b']) { const v = r.physShare && r.physShare[role]; const nm = r[role] && r[role].name; if (nm && typeof v === 'number') (k.phys[nm] || (k.phys[nm] = [])).push(v) }
    for (const s of [r.a, r.b]) {
      if (!s) continue
      if (s.died) k.deaths[s.name] = (k.deaths[s.name] || 0) + 1
      if (s.ringout) k.ringouts++
      const h = k.hits[s.name] || (k.hits[s.name] = { swings: 0, landed: 0, crits: 0, sprint: 0 })
      h.swings += s.swings || 0; h.landed += s.landed || 0; h.crits += s.crits || 0; h.sprint += s.sprintHits || 0
      // Оружие (s7b): булава, элитры (таран копьём, пике), арбалет, прыжки — суммы чисел и списки урона.
      const w = k.weapons[s.name] || (k.weapons[s.name] = {})
      const addW = (pre, o) => { for (const [kk, v] of Object.entries<any>(o || {})) { const key = pre + '.' + kk; if (typeof v === 'number') w[key] = Math.round(((w[key] || 0) + v) * 10) / 10; else if (Array.isArray(v) && v.every(x => typeof x === 'number')) w[key] = (w[key] || []).concat(v) } }
      addW('mace', s.mace); addW('elytra', s.elytra); addW('xbow', s.xbow); addW('hops', s.hops)
      if (s.arrows) addW('bow', { arrows: s.arrows, arrowHits: s.arrowHits || 0 })
      const dmg = s.trickDmg || {}
      for (const [key, n] of Object.entries<any>(s.tricks || {})) addTrick(k.tricks, key, n, dmg[key])
      for (const [key, v] of Object.entries<any>(dmg)) if (!(s.tricks || {})[key]) addTrick(k.tricks, key, 0, v)
    }
  }
  const med = (xs) => { const s = xs.slice().sort((a, b) => a - b); return s.length ? s[Math.floor(s.length / 2)] : null }
  return Object.values<any>(kits).map(k => ({ ...k, durMed: med(k.dur), tpsMed: med(k.tps), tpsMin: k.tps.length ? Math.min(...k.tps) : null }))
}

function render (sums, { top = 25 } = {}) {
  const lines = []
  for (const k of sums) {
    lines.push(`== ${k.kit}: раундов ${k.n}, ничьих ${k.draws}; победы ${Object.entries(k.byName).map(([n, v]) => `${n} ${v}`).join(', ') || '—'}; роль A ${k.byRole.a} / B ${k.byRole.b}`)
    lines.push(`   длительность медиана ${k.durMed} с; TPS медиана ${k.tpsMed ?? '?'} (мин ${k.tpsMin ?? '?'}), отставание часов до ${k.lag} тиков; смерти ${Object.entries(k.deaths).map(([n, v]) => `${n} ${v}`).join(', ') || '0'}, вылетов ${k.ringouts}`)
    for (const [n, h] of Object.entries<any>(k.hits)) { const ph = k.phys[n] || []; lines.push(`   ${n}: махов ${h.swings}, попал ${h.landed}, криты ${h.crits}, спринт-удары ${h.sprint}; доля физ. тиков ${ph.length ? `мин ${Math.min(...ph)}, ср ${Math.round(ph.reduce((a, b) => a + b, 0) / ph.length * 100) / 100}` : '?'}`) }
    for (const [n, w] of Object.entries<any>(k.weapons)) { const parts = Object.entries<any>(w).filter(([kk]) => !/\.(foe|aerialNodes|pushWhy|why)$/.test(kk)).map(([kk, v]) => `${kk} ${Array.isArray(v) ? '[' + v.map(x => Math.round(x * 10) / 10).join(' ') + ']' : v}`); if (parts.length) lines.push(`   ${n} оружие: ${parts.join(', ')}`) }
    const tr = Object.entries<any>(k.tricks).sort((a, b) => (b[1].dmg - a[1].dmg) || (b[1].uses - a[1].uses) || (b[1].rounds - a[1].rounds)).slice(0, top)
    for (const [tpl, t] of tr) lines.push(`   ${String(t.dmg).padStart(6)} урона | раундов ${String(t.rounds).padStart(2)} | ×${String(t.uses).padStart(3)} | ${label(tpl, { ...t, nums: t.nums && t.nums.slice() })}`)
  }
  return lines.join('\n')
}

export { parse, summarize, render }

if (require.main === module) {
  const argv = process.argv.slice(2)
  const opt = (k, d = null) => { const i = argv.indexOf(k); return i >= 0 ? argv.splice(i, 2)[1] : d }
  const kit = opt('--kit')
  const top = Number(opt('--top', 25))
  const json = argv.includes('--json')
  const rounds = []
  for (const f of files(argv.filter(a => a !== '--json'))) rounds.push(...parse(fs.readFileSync(f, 'utf8'), path.basename(f)))
  const sums = summarize(kit ? rounds.filter(r => String(r.kit).includes(kit)) : rounds)
  if (!sums.length) console.log('раундов нет')
  else console.log(json ? JSON.stringify(sums, null, 1) : render(sums, { top }))
}
