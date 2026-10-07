'use strict'
// Сводка серий арены S7c (07.10): ПОЛНЫЕ файлы серии (все строки ROUND) + причина смерти из лога сервера слота.
//   node farm/crystal/xsum.js 'farm/results/s7c1/*.out' [--slot 27] [--rounds]
// Кристаллы по сторонам: подрывов по сопернику (свой взрыв, ему ≥ 1), урон взрывами, его подрывы у меня
// (threats) и удачные уклонения (evaded: пришло ≤ max(1.5, ¼ прогноза)), щит/укрытие/блок между, сбитые его
// кристаллы, самоподрывы. Причина смерти — строка сервера «<имя> was blown up by …» в окне раунда
// (время ROUND — UTC арены, лог сервера — местное МСК, +3 ч).
const fs = require('fs')
const path = require('path')
const zlib = require('zlib')

const args = process.argv.slice(2)
const opt = (k, d = null) => { const i = args.indexOf(k); return i >= 0 ? args[i + 1] : d }
const SLOT = Number(opt('--slot', '27'))
const SHOW = args.includes('--rounds')
const pats = args.filter((a, i) => !a.startsWith('--') && !(i > 0 && args[i - 1] === '--slot'))

function files (list) {
  const out = []
  for (const a of list) {
    if (a.includes('*')) {
      const dir = path.dirname(a)
      const re = new RegExp('^' + path.basename(a).replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*') + '$')
      for (const f of fs.readdirSync(dir)) if (re.test(f)) out.push(path.join(dir, f))
    } else out.push(a)
  }
  return out
}
const tod = (s) => { const [h, m, x] = s.split(':').map(Number); return h * 3600 + m * 60 + x }

const rounds = []
for (const f of files(pats)) {
  for (const line of fs.readFileSync(f, 'utf8').split(/\r?\n/)) {
    const i = line.indexOf('ROUND {')
    if (i < 0) continue
    try {
      const r = JSON.parse(line.slice(i + 6))
      r.file = path.basename(f)
      const m = /^\[(\d\d:\d\d:\d\d)\]/.exec(line)
      r.endT = m ? tod(m[1]) : null
      rounds.push(r)
    } catch {}
  }
}
if (!rounds.length) { console.log('раундов нет'); process.exit(0) }

// Смерти из логов сервера слота (latest.log и *.log.gz за последние двое суток).
const deaths = []
try {
  const dir = path.join(__dirname, '..', `server-${SLOT}`, 'logs')
  const names = new Set(rounds.flatMap(r => [r.a && r.a.name, r.b && r.b.name]).filter(Boolean))
  const cut = Date.now() - 2 * 86400e3
  for (const f of fs.readdirSync(dir)) {
    const p = path.join(dir, f)
    if (fs.statSync(p).mtimeMs < cut) continue
    let text = ''
    try { text = f.endsWith('.gz') ? zlib.gunzipSync(fs.readFileSync(p)).toString('utf8') : fs.readFileSync(p, 'utf8') } catch { continue }
    for (const line of text.split(/\r?\n/)) {
      const m = /^\[(\d\d:\d\d:\d\d)\] \[Server thread\/INFO\]: (\S+) (.+)$/.exec(line)
      if (!m || !names.has(m[2])) continue
      if (/joined the game|left the game|lost connection|issued server command|has made the advancement|has reached the goal|moved too quickly|was kicked/.test(m[3])) continue
      if (!/^(was |died|blew|hit |fell|experienced|went |burned|tried|drowned|walked|withered|froze|starved|suffocated|discovered|didn't|was )/.test(m[3])) continue
      deaths.push({ t: tod(m[1]), who: m[2], msg: m[3] })
    }
  }
} catch {}
// Окно: смерть за ≤ 15 с до строки ROUND (раунд кончается первой смертью), сутки по кругу; лог МСК = UTC + 3 ч.
for (const r of rounds) {
  r.deaths = []
  if (r.endT == null) continue
  const end = (r.endT + 3 * 3600) % 86400
  const len = Math.min(15, Math.max(r.wallS || 0, r.durS || 0) + 3) // раунд кончается первой смертью; ROUND пишется через секунды после неё
  for (const d of deaths) {
    const dt = (end - d.t + 86400) % 86400
    if (dt <= len && !r.deaths.some(x => x.who === d.who && x.msg === d.msg && Math.abs(x.t - d.t) < 2)) r.deaths.push(d)
  }
}
const kind = (msg, foe) => {
  if (/blown up|blew up|intentional game design/i.test(msg)) return 'взрыв'
  if (/kinetic energy/.test(msg)) return 'кинетическая (элитры о стену/пол)'
  if (/fell|hit the ground|doomed to fall/.test(msg)) return 'падение'
  if (/speared/.test(msg)) return 'копьё'
  if (/shot|fireworks|went off with a bang/.test(msg)) return 'стрела/ракета'
  if (/slain|killed|smashed/.test(msg)) return 'удар'
  if (/lava|burn|fire/.test(msg)) return 'огонь/лава'
  return 'прочее'
}

const f1 = (x) => Math.round(x * 10) / 10
const sum = (xs) => xs.reduce((s, x) => s + (Number(x) || 0), 0)
const med = (xs) => { const s = xs.slice().sort((a, b) => a - b); return s.length ? s[Math.floor(s.length / 2)] : 0 }
const byKit = new Map()
for (const r of rounds) { if (!byKit.has(r.kit)) byKit.set(r.kit, []); byKit.get(r.kit).push(r) }

for (const [kit, rs] of byKit) {
  const n = rs.length
  const wins = {}
  for (const r of rs) if (r.winner) wins[r.winner] = (wins[r.winner] || 0) + 1
  const draws = rs.filter(r => !r.winner).length
  const sides = {}
  for (const r of rs) for (const s of [r.a, r.b]) if (s && s.name) { const k = `${s.name}@${s === r.a ? 'A' : 'B'}`; sides[k] = (sides[k] || 0) + (r.winner === s.name ? 1 : 0) }
  console.log(`\n== ${kit}: раундов ${n}, победы ${Object.entries(wins).map(([k, v]) => `${k} ${v}`).join(', ') || '—'}, ничьих ${draws}; длительность медиана ${med(rs.map(r => r.durS))} с (реальных ${med(rs.map(r => r.wallS || 0))} с), ТПС медиана ${med(rs.map(r => r.tps || 0))}`)
  console.log(`   победы по стороне арены: ${Object.entries(sides).map(([k, v]) => `${k} ${v}`).join(', ')}`)
  // Причины смерти.
  const causes = {}
  let selfKills = 0; let deathsN = 0
  for (const r of rs) {
    for (const d of r.deaths) {
      deathsN++
      const foe = [r.a, r.b].find(s => s && s.name && s.name !== d.who)
      const k = kind(d.msg, foe && foe.name)
      causes[k] = (causes[k] || 0) + 1
      const byFoe = foe && d.msg.includes(foe.name) && !/while trying to escape/.test(d.msg)
      if (/kinetic/.test(d.msg) || (!byFoe && /fell|hit the ground|doomed to fall/.test(d.msg))) selfKills++
    }
  }
  console.log(`   смертей по логу сервера ${deathsN} (раундов со смертью ${rs.filter(r => r.a.died || r.b.died).length}): ${Object.entries(causes).map(([k, v]) => `${k} ${v}`).join(', ') || '—'}; разбился сам (элитры/падение без его удара) ${selfKills} (${n ? f1(100 * selfKills / n) : 0}% раундов)`)
  // Элитры: удары о стену/пол себе (чёрный ящик elytra.install) по виду и фазе.
  const crash = {}
  let crashN = 0
  for (const r of rs) for (const s of [r.a, r.b]) for (const c of ((s && s.elytra && s.elytra.crashes) || [])) { crashN++; const k = String(c).replace(/\/−[\d.?]+/, ''); crash[k] = (crash[k] || 0) + 1 }
  const lance = rs.flatMap(r => [r.a, r.b]).map(s => (s && s.elytra) || {})
  if (crashN || lance.some(e => e.lancePasses)) console.log(`   элитры: ударов о стену/пол себе ${crashN}${crashN ? ' — ' + Object.entries(crash).map(([k, v]) => `${k} ${v}`).join(', ') : ''}; таранов ${sum(lance.map(e => e.lances))}, заходов ${sum(lance.map(e => e.lancePasses))}, касаний ${sum(lance.map(e => e.lanceHits))}, урон касаний [${lance.flatMap(e => e.lanceDealt || []).join(' ')}], плохих посадок ${sum(lance.map(e => e.lanceBadLand))}`)
  // Кристаллы.
  const C = (s) => (s && s.crystal) || {}
  const cs = rs.flatMap(r => [C(r.a), C(r.b)])
  if (cs.some(c => c.booms || c.placed || c.anchors || c.anchorSeen || c.threats)) {
    const dealt = cs.flatMap(c => c.dealt || [])
    const landed = dealt.filter(x => x >= 1).length
    const tot = (k) => sum(cs.map(c => c[k] || 0))
    const pops = sum(rs.map(r => (r.a.crystal?.myPops || 0) + (r.b.crystal?.myPops || 0)))
    console.log(`   кристаллы: поставлено ${tot('placed')}, подрывов рукой ${tot('hits')} / стрелой ${tot('shots')}, взрывов (видел) ${f1(sum(rs.map(r => Math.max(C(r.a).booms || 0, C(r.b).booms || 0))) / n)}/раунд`)
    console.log(`   по сопернику: подрывов с уроном ≥1 — ${landed} из ${dealt.length} замеренных, урон взрывами ${f1(sum(dealt))} (ср. ${dealt.length ? f1(sum(dealt) / dealt.length) : '-'}), его тотемов от моих ${tot('popsDealt')}; тотемов всего ${pops}`)
    console.log(`   его подрывов всего ${tot('his')}, мне от них ${f1(tot('hisTaken'))} (${tot('his') ? f1(tot('hisTaken') / tot('his')) : '-'} на подрыв); его подрывы у меня (прогноз ≥4 при полной видимости): ${tot('threats')}, удачных уклонений ${tot('evaded')} (${tot('threats') ? f1(100 * tot('evaded') / tot('threats')) : 0}%), прогноз ${f1(tot('threatMax'))} → пришло ${f1(tot('threatTaken'))}`)
    console.log(`   из них «потом» (кристалл стоял > 0.3 с — заранее/стрелой): ${tot('threatsSlow')}, уклонений ${tot('evadedSlow')} (${tot('threatsSlow') ? f1(100 * tot('evadedSlow') / tot('threatsSlow')) : 0}%), прогноз ${f1(tot('threatSlowMax'))} → пришло ${f1(tot('threatSlowTaken'))}`)
    console.log(`   защита: щит ${tot('shieldUps')} (${f1(tot('shieldMs') / 1000)} с), укрытие ${tot('covers')}, блок между ${tot('walls')} (${tot('wallBlocks')} бл.), отход ${tot('dodges')}, окружение ${tot('surround')}, сбил его кристалл ${tot('defuse')} + в своё окно ${tot('free')}, планов уклонения ${tot('evadePlans')}`)
    console.log(`   себе от своих: ${f1(tot('self'))} хп, САМОПОДРЫВОВ (свой тотем своим кристаллом) ${tot('selfPops')}; сквозь стену: отказов второго луча ${tot('wallPlace') + tot('wallHit')}`)
    const anch = tot('anchors')
    if (anch || tot('anchorSeen')) {
      const ad = cs.flatMap(c => c.anchorDealt || [])
      console.log(`   якоря: поставил ${anch}, подорвал свой ${tot('anchorBooms')}, за светокамнем ${tot('anchorGuards')}, сбил его ${tot('anchorPops')}; взрывов якорей ${tot('anchorSeen')}`)
      console.log(`   якоря по сопернику: подрывов с уроном ≥1 — ${ad.filter(x => x >= 1).length} из ${ad.length}, урон ${f1(sum(ad))}; себе ${f1(tot('anchorSelf'))} (свой тотем своим якорем ${tot('anchorSelfPops')}); его якоря у меня ${tot('anchorThreats')}, уклонений ${tot('anchorEvaded')}, прогноз ${f1(tot('anchorThreatMax'))} → пришло ${f1(tot('anchorThreatTaken'))}`)
    }
  }
  if (SHOW) {
    for (const r of rs) {
      const c = (s) => { const x = C(s); return x.placed != null || x.threats ? `пост ${x.placed || 0} взр ${x.mine || 0} ему ${f1(sum(x.dealt || []))} угр ${x.threats || 0}/укл ${x.evaded || 0} щит ${x.shieldUps || 0} укр ${x.covers || 0} блок ${x.walls || 0} сбил ${(x.defuse || 0) + (x.free || 0)}` : '' }
      console.log(`   #${r.n} ${r.sides || ''} ${r.durS}с ${r.winner || 'ничья'} | A ${r.a.name}${r.a.died ? '†' : ''} ${c(r.a)} | B ${r.b.name}${r.b.died ? '†' : ''} ${c(r.b)} | ${r.deaths.map(d => `${d.who} ${d.msg}`).join('; ')}`)
    }
  }
}
