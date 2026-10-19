'use strict'
// Сводка серий арены S7d (08.10): ПОЛНЫЕ файлы серий (все строки ROUND), смерти — из ROUND.deaths (лог сервера слота
// строго в окне раунда: arena.ts roundDeaths), причины: foe — убит соперником, crash — разбился сам (элитры о стену,
// падение без него), self — своим (кристалл/стрела), blast — взрыв ни на кого (якорь), fall-escape — упал, убегая.
//   node dist/farm/crystal/s7dsum.js 'farm/results/s7d-b-27/*.out' [--rounds] [--json]
// Таблицы: исход, причины смертей, граф боя (выбор/запреты/оружие), комбо, ближний бой (спринт-сброс, хит-селект,
// размены), щит, элитры, кристаллы/якоря, удочка, трезубец, булава, блоки в бою, частоты и урон приёмов.
import * as fs from 'fs'
import path = require('path')

const args = process.argv.slice(2)
const SHOW = args.includes('--rounds')
const pats = args.filter(a => !a.startsWith('--'))

function files (list) {
  const out = []
  for (const a of list) {
    if (a.includes('*')) {
      const dir = path.dirname(a)
      if (!fs.existsSync(dir)) continue
      const re = new RegExp('^' + path.basename(a).replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*') + '$')
      for (const f of fs.readdirSync(dir)) if (re.test(f)) out.push(path.join(dir, f))
    } else out.push(a)
  }
  return out
}
const rounds = []
for (const f of files(pats)) {
  for (const line of fs.readFileSync(f, 'utf8').split(/\r?\n/)) {
    const i = line.indexOf('ROUND {')
    if (i < 0) continue
    try { const r = JSON.parse(line.slice(i + 6)); r.file = path.basename(f); rounds.push(r) } catch {}
  }
}
if (!rounds.length) { console.log('раундов нет'); process.exit(0) }

const f1 = (x) => Math.round(x * 10) / 10
const num = (x) => Number(x) || 0
const sum = (xs) => xs.reduce((s, x) => s + num(x), 0)
const med = (xs) => { const s = xs.filter(x => x != null).slice().sort((a, b) => a - b); return s.length ? s[Math.floor(s.length / 2)] : null }
const pct = (a, b) => b ? `${Math.round(100 * a / b)} %` : '—'
const addTo = (acc, obj) => { for (const [k, v] of Object.entries(obj || {})) acc[k] = f1((acc[k] || 0) + num(v)); return acc }
const top = (obj, n = 8) => Object.entries(obj).sort((a: any, b: any) => b[1] - a[1]).slice(0, n).map(([k, v]) => `${k} ${v}`).join('; ')

const byKit = new Map()
for (const r of rounds) { if (!byKit.has(r.kit)) byKit.set(r.kit, []); byKit.get(r.kit).push(r) }

for (const [kit, rs] of byKit) {
  const n = rs.length
  const sides = rs.flatMap(r => [r.a, r.b].filter(Boolean))
  const wins = {}
  for (const r of rs) if (r.winner) wins[r.winner] = (wins[r.winner] || 0) + 1
  const byPos = { A: 0, B: 0 }
  for (const r of rs) if (r.winner) byPos[r.a && r.winner === r.a.name ? 'A' : 'B']++
  console.log(`\n== ${kit}: раундов ${n}, победы ${Object.entries(wins).map(([k, v]) => `${k} ${v}`).join(', ') || '—'} (сторона арены A ${byPos.A} : B ${byPos.B}), ничьих ${rs.filter(r => !r.winner).length}`)
  console.log(`   длительность медиана ${med(rs.map(r => r.durS))} с игровых (${med(rs.map(r => r.wallS))} реальных), темп ${med(rs.map(r => r.tps))} т/с, отставание часов до ${Math.max(...rs.map(r => Math.max(num(r.lagMax?.a), num(r.lagMax?.b))))} т, доля физики мин ${Math.min(...rs.map(r => Math.min(r.physShare?.a ?? 1, r.physShare?.b ?? 1)))}`)
  // Смерти.
  const kinds: any = {}; const msgs = {}
  let deaths = 0; let withDeaths = 0
  for (const r of rs) {
    if (r.deaths) withDeaths++
    for (const d of r.deaths || []) { deaths++; kinds[d.kind] = (kinds[d.kind] || 0) + 1; const m = d.msg.replace(/NeuroFarm\d+b?/g, 'X'); msgs[m] = (msgs[m] || 0) + 1 }
  }
  const NAMES = { foe: 'убит соперником', crash: 'разбился сам', self: 'своим (кристалл/стрела)', blast: 'взрыв якоря', 'fall-escape': 'упал, убегая', other: 'прочее' }
  console.log(`   смерти (лог сервера в окне раунда, раундов с данными ${withDeaths}/${n}): ${deaths} — ${Object.entries(kinds).map(([k, v]) => `${NAMES[k] || k} ${v}`).join(', ') || '—'}; разбился сам — ${pct(rs.filter(r => (r.deaths || []).some(d => d.kind === 'crash')).length, n)} раундов`)
  console.log(`     сообщения: ${top(msgs, 6)}`)
  const filled = sides.filter(s => s.filled).length
  const empty = sides.filter(s => !s.tricks && s.swings == null).length
  const unconf = sides.filter(s => s.deathUnconfirmed).length
  if (filled || empty || unconf) console.log(`   отчёты: дозабраны из демона ${filled}, пустых ${empty} из ${sides.length}; «смерть» арены без строки сервера (не засчитана) ${unconf}`)
  // Граф боя.
  const picks = {}; const gated = {}; const weapons = {}; let plans = 0
  for (const s of sides) { const c = s.calc || {}; plans += num(c.plans); addTo(picks, c.picks); addTo(gated, c.gated); addTo(weapons, c.weapons) }
  if (plans) console.log(`   граф боя: решений ${plans}; выбор ${top(picks)}; отвергнуто ${top(gated) || '—'}; смена оружия ${top(weapons) || '—'}`)
  const chains = {}; const cdmg = {}
  for (const s of sides) { addTo(chains, s.combos?.chains); addTo(cdmg, s.combos?.dmg) }
  if (Object.keys(chains).length) console.log(`   комбо (цепочка → раз, урон): ${Object.entries(chains).sort((a: any, b: any) => b[1] - a[1]).slice(0, 10).map(([k, v]) => `${k} ${v} (${cdmg[k]})`).join('; ')}`)
  // Ближний бой.
  const M = sides.map(s => s.melee).filter(Boolean)
  if (M.length) {
    const t = (k) => sum(M.map(m => m[k]))
    const ex = M.reduce((a, m) => { if (m.ex) { a.n += m.ex.n; a.first += m.ex.first; a.mine += m.ex.mine; a.his += m.ex.his } return a }, { n: 0, first: 0, mine: 0, his: 0 })
    const avgOf = (k) => { const xs = M.map(m => m[k]).filter(x => x != null); return xs.length ? f1(sum(xs) / xs.length) : '—' }
    const comboMax = Math.max(0, ...M.map(m => (m.combo && m.combo.max) || 0))
    const comboAvg = (() => { const xs = M.map(m => m.combo && m.combo.avg).filter(x => x != null); return xs.length ? f1(sum(xs) / xs.length) : '—' })()
    console.log(`   ближний: взмахов ${t('swings')}, спринт-ударов ${t('sprintHits')}/${t('sprintTries')} (${pct(t('sprintHits'), t('sprintTries'))}), W-tap ${t('wtaps')}, S-tap ${t('staps')}, перевзвод спринта ${t('rearms')}, ×0.6 себе ${t('slow06')}, крит в спринте ${t('sprintCrit')}; критов ${t('crits')}`)
    console.log(`     комбо отбросом (ударов подряд без ответа): макс ${comboMax}, ср ${comboAvg}; jump-reset ${t('jumpResets')} на ${t('knocks')} его отбросов, отлёт ср: без ничего ${avgOf('kbPlain')} / прыжок ${avgOf('kbReset')} / ответный удар ${avgOf('kbCounter')} бл.`)
    console.log(`     хит-селект ${M.some(m => m.hitSelect === false) ? (M.some(m => m.hitSelect !== false) ? 'у одного из бойцов ВЫКЛ' : 'ВЫКЛ') : 'вкл'}: ответных ударов ${t('counterHits')}; разменов ${ex.n}, первым попал ${ex.first} (${pct(ex.first, ex.n)}), попаданий ${ex.mine} : ${ex.his} (своих : его, по обеим сторонам — сумма), пустых взмахов ${t('empty')}, в его неуязвимость ${t('iframeSwings')}`)
    // По бойцам (демонам): A/B-сравнение, когда настройки бойцов разные (хит-селект у одного).
    const byName = new Map()
    for (const r of rs) for (const sd of [r.a, r.b]) if (sd && sd.melee) { if (!byName.has(sd.name)) byName.set(sd.name, { rounds: 0, wins: 0, ms: [] }); const x = byName.get(sd.name); x.ms.push(sd.melee); x.rounds++; if (r.winner === sd.name) x.wins++ }
    for (const [nm, x] of byName) {
      const tt = (k) => sum(x.ms.map(m => m[k]))
      const e2 = x.ms.reduce((a, m) => { if (m.ex) { a.n += m.ex.n; a.first += m.ex.first; a.mine += m.ex.mine; a.his += m.ex.his } return a }, { n: 0, first: 0, mine: 0, his: 0 })
      const av = (k) => { const xs = x.ms.map(m => m[k]).filter(v => v != null); return xs.length ? f1(sum(xs) / xs.length) : '—' }
      console.log(`     ${nm} (хит-селект ${x.ms.some(m => m.hitSelect === false) ? 'выкл' : x.ms.some(m => m.hsWait === false) ? 'без ожидания' : 'вкл'}): побед ${x.wins}/${x.rounds}; первым в размене ${e2.first}/${e2.n} (${pct(e2.first, e2.n)}); попаданий ${e2.mine} : ${e2.his}; ответных ${tt('counterHits')}; отлёт без/прыжок/ответ ${av('kbPlain')}/${av('kbReset')}/${av('kbCounter')}; спринт-ударов ${tt('sprintHits')}/${tt('sprintTries')}; комбо макс ${Math.max(0, ...x.ms.map(m => (m.combo && m.combo.max) || 0))}`)
    }
  }
  // Щит.
  // Щит: у владельца — отчёт щита (guard: подъёмов, погашено сервером, выбит топором, секунд под щитом, урон в
  // секунду под щитом и без него); у атакующего — удары по поднятому (vsShield: топором, вне 90°, урон сквозь).
  const G = sides.map(s => s.shield).filter(x => x && x.worn)
  const VS = sides.map(s => s.vsShield).filter(Boolean)
  const breaks = sum(M.map(m => m.shieldBreaks)); const axeOn = sum(sides.map(s => s.axeOnShield))
  if (G.length || VS.length || breaks || axeOn) {
    const g = (k) => sum(G.map(x => x[k]))
    const v = (k) => sum(VS.map(x => x[k]))
    const under = g('upSeconds'); const open = g('openSeconds')
    console.log(`   щит (владелец): подъёмов ${g('raises')}, погашено ударов (сервер) ${g('blocked')}, выбит топором ${g('disabled')}, под щитом ${f1(under)} с (в упор ${f1(g('closedSeconds'))} из ${f1(g('contactSeconds'))} с), урон под щитом ${f1(g('hpUnderShield'))} / без ${f1(g('hpOpen'))} за ${f1(open)} с`)
    console.log(`   щит (атакующий): ударов по поднятому ${v('hits')} (топором ${v('axe')}, сбоку/сзади вне 90° ${v('outside')}), урон сквозь поднятый ${f1(v('through'))}; axeOnShield ${axeOn}, щит выбит (звук) ${breaks}`)
  }
  // Элитры.
  const E = sides.map(s => s.elytra).filter(Boolean)
  if (E.length) {
    const t = (k) => sum(E.map(e => e[k]))
    const crash = {}
    for (const e of E) for (const c of e.crashes || []) { const k = String(c).replace(/\/−[\d.?]+/, ''); crash[k] = (crash[k] || 0) + 1 }
    const blocked = {}
    for (const e of E) for (const b of e.blockedBy || []) { const m = /^(.*)×(\d+)$/.exec(b); if (m) blocked[m[1]] = Math.max(blocked[m[1]] || 0, Number(m[2])) }
    console.log(`   элитры: взлётов ${t('takeoffs')}, ракет ${t('rockets')}; таранов ${t('lances')}, заходов ${t('lancePasses')}, касаний ${t('lanceHits')} (${pct(t('lanceHits'), t('lancePasses'))}), урон касаний [${E.flatMap(e => e.lanceDealt || []).join(' ')}]; пике ${t('dives')}/${t('diveHits')}; уколов в воздухе ${t('airJabs')}`)
    console.log(`     удары о стену/пол себе ${Object.values(crash).reduce((a: any, b: any) => a + b, 0)}: ${top(crash) || '—'}; рефлекс столкновения ${t('guardSaves')}; замок руля отбил ${t('blockedLooks')} чужих поворотов (${top(blocked, 4) || '—'}); плохих посадок ${t('lanceBadLand')}`)
  }
  // Кристаллы и якоря.
  const C = sides.map(s => s.crystal).filter(Boolean)
  if (C.some(c => c.placed || c.anchors || c.threats)) {
    const t = (k) => sum(C.map(c => c[k]))
    const dealt = C.flatMap(c => c.dealt || [])
    console.log(`   кристаллы: поставлено ${t('placed')}, подрывов рукой ${t('hits')} / стрелой ${t('shots')}; по нему с уроном ≥1 ${dealt.filter(x => x >= 1).length} из ${dealt.length}, урон ${f1(sum(dealt))}; себе ${f1(t('self'))}, самоподрывов ${t('selfPops')}`)
    console.log(`     его подрывы у меня ${t('threats')}, уклонений ${t('evaded')} (${pct(t('evaded'), t('threats'))}), «потом» ${t('evadedSlow')}/${t('threatsSlow')} (${pct(t('evadedSlow'), t('threatsSlow'))}); прогноз ${f1(t('threatMax'))} → пришло ${f1(t('threatTaken'))}; щит ${t('shieldUps')}, укрытие ${t('covers')}, блок между ${t('walls')}, отход ${t('dodges')}, окружение ${t('surround')}, сбил ${t('defuse')}`)
    if (t('anchors') || t('anchorThreats')) {
      const ad = C.flatMap(c => c.anchorDealt || [])
      console.log(`     якоря: поставил ${t('anchors')}, подорвал ${t('anchorBooms')}, за светокамнем ${t('anchorGuards')}, сбил его ${t('anchorPops')}; по нему ≥1 ${ad.filter(x => x >= 1).length}/${ad.length} (${f1(sum(ad))}); себе ${f1(t('anchorSelf'))}; его якоря у меня ${t('anchorThreats')}, уклонений ${t('anchorEvaded')} (${pct(t('anchorEvaded'), t('anchorThreats'))})`)
    }
  }
  // Удочка, трезубец, булава, арбалет.
  const R = sides.map(s => s.rod).filter(Boolean)
  if (R.length) { const t = (k) => sum(R.map(x => x[k])); console.log(`   удочка: забросов ${t('casts')}, зацепов ${t('hooked')} (${pct(t('hooked'), t('casts'))}), его поплавок на мне ${t('hookedOnMe')}, обратный подтяг ${t('counter')}, меня дёрнули ${t('pulledMe')}`) }
  const U = sides.map(s => s.util).filter(Boolean)
  if (U.some(u => u.trident)) { const t = (k) => sum(U.map(x => x[k])); console.log(`   трезубец: бросков ${t('trident')}, попаданий ${t('tridentHit')} (${pct(t('tridentHit'), t('trident'))}), молний в него ${t('bolts')}; «Тягун» ${t('riptide')}`) }
  const MC = sides.map(s => s.mace).filter(Boolean)
  if (MC.length) console.log(`   булава: ${JSON.stringify(MC.reduce((a, m) => { for (const [k, v] of Object.entries(m)) if (typeof v === 'number') a[k] = f1((a[k] || 0) + v); return a }, {}))}`)
  const X = sides.map(s => s.xbow).filter(Boolean)
  if (X.length) console.log(`   арбалет: ${JSON.stringify(X.reduce((a, m) => { for (const [k, v] of Object.entries(m)) if (typeof v === 'number') a[k] = f1((a[k] || 0) + v); return a }, {}))}`)
  // Прыжки в бою, опора под ним, гроза.
  const H = sides.map(s => s.hops).filter(Boolean)
  if (H.length) { const why = {}; for (const h of H) if (h.why) why[h.why] = (why[h.why] || 0) + 1; console.log(`   прыжки в бою (combatHop): попыток ${sum(H.map(h => h.tries))}, удачных по исполнителю ${sum(H.map(h => h.ok))}, по делу (долетел/стал ближе на 1.5+) ${sum(H.map(h => h.eff))}; последние отказы: ${top(why, 5)}`) }
  const BU = sides.map(s => s.breakUnder).filter(Boolean)
  if (BU.length) console.log(`   сломать опору под ним: попыток ${sum(BU.map(x => x.tries))}, сломал ${sum(BU.map(x => x.ok))}, он упал ${sum(BU.map(x => x.fell))}`)
  const ST = sides.map(s => s.storm).filter(Boolean)
  if (ST.length) console.log(`   гроза (его «Громовержец»): замечено ${sum(ST.map(x => x.seen))}, под навес ${sum(ST.map(x => x.shelters))}, держал навес ${sum(ST.map(x => x.under))}, навеса рядом нет ${sum(ST.map(x => x.noShelter))}`)
  // Блоки в бою.
  const B = sides.map(s => s.blockLog).filter(Boolean)
  if (B.length) {
    const agg = (k) => { const o = {}; for (const b of B) for (const [t, e] of Object.entries<any>(b[k] || {})) { const a = o[t] || (o[t] = { n: 0, ok: 0, msSum: 0, msN: 0 }); a.n += e.n; a.ok += e.ok; if (e.ms != null) { a.msSum += e.ms * e.ok; a.msN += e.ok } } return o }
    const fmt = (o) => Object.entries<any>(o).sort((a, b) => b[1].n - a[1].n).map(([t, a]) => `${t} ${a.ok}/${a.n}${a.msN ? ` (${Math.round(a.msSum / a.msN)} мс)` : ''}`).join('; ')
    const err = B.reduce((a, b) => { a.nc += num(b.errors?.notConfirmed); a.os += num(b.errors?.ownSupport); return a }, { nc: 0, os: 0 })
    console.log(`   блоки — поставил (успех/попыток, время): ${fmt(agg('place')) || '—'}`)
    console.log(`     сломал: ${fmt(agg('dig')) || '—'}; ошибок: не подтвердил сервер ${err.nc}, своя опора ${err.os}`)
  }
  // Приёмы: частота и урон (падение его хп ≤ 1.5 с после приёма; телеметрия).
  const tricks = {}; const tdmg = {}
  for (const s of sides) { addTo(tricks, s.tricks); addTo(tdmg, s.trickDmg) }
  const norm = (o) => { const out = {}; for (const [k, v] of Object.entries(o)) { const kk = k.replace(/\d+(\.\d+)?/g, '#'); out[kk] = f1((out[kk] || 0) + num(v)) } return out }
  console.log(`   приёмы (раз): ${top(norm(tricks), 12)}`)
  console.log(`   урон приёмов: ${top(norm(tdmg), 10)}`)
  if (SHOW) for (const r of rs) console.log(`   #${r.n} ${r.sides} ${r.durS}с ${r.winner || 'ничья'} | ${(r.deaths || []).map(d => `${d.who} ${d.msg} [${d.kind}]`).join('; ')}`)
}
