// Бой + свидетель сервера (02.10, поток dragon): node farm/dragon/an-fightlab.js <тег> [слот-файл events.jsonl для боёв без lab-ev]
// Сводит bedDone бота (прогноз: headDist, seenP, bodyDy, ярус) с dd сервера (DragonLab: урон, seen родителя, голова, тело).
// Печать по взрыву и итог: ошибка прогноза seen, урон по причинам (расстояние/видимость).
const fs = require('fs'); const path = require('path')
const L = path.join(__dirname, '..', 'logs')
const tag = process.argv[2]
const root = path.join(L, 'trace-' + tag)
const q = (xs, p) => { const v = xs.filter(x => x != null && !Number.isNaN(x)).sort((a, b) => a - b); return v.length ? Math.round(v[Math.min(v.length - 1, Math.floor((v.length - 1) * p + 0.5))] * 1000) / 1000 : '-' }
const rows = []
// бой k → слот (seeds: «k слот сид»): без lab-ev.jsonl — общий events.jsonl слота, взрывы сводятся по времени
const slotOf: Record<string, any> = {} as Record<string, any>
try { for (const l of fs.readFileSync(path.join(L, tag + '-seeds.txt'), 'utf8').split(/\r?\n/)) { const m = /^(\d+) (\d+) /.exec(l); if (m) slotOf['s' + m[1]] = m[2] } } catch {}
for (const s of fs.readdirSync(root)) {
  const d = path.join(root, s); if (!fs.statSync(d).isDirectory()) continue
  let evf = path.join(d, 'lab-ev.jsonl')
  if (!fs.existsSync(evf) && slotOf[s]) evf = path.join(__dirname, '..', 'server-' + slotOf[s], 'plugins', 'DragonLab', 'events.jsonl')
  if (!fs.existsSync(evf)) continue
  const dd = fs.readFileSync(evf, 'utf8').split('\n').filter(l => l.includes('"t":"dd"') && l.includes('bad_respawn_point')).map(l => { try { return JSON.parse(l) } catch { return null } }).filter(Boolean)
  for (const f of fs.readdirSync(d).filter(f => /^dragon-/.test(f))) {
    for (const l of fs.readFileSync(path.join(d, f), 'utf8').split('\n')) {
      if (!l.includes('"k":"bedDone"')) continue
      const b = JSON.parse(l)
      const m = dd.filter(e => e.ms >= b.sent - 50 && e.ms <= b.sent + 600).sort((x, y) => x.ms - y.ms)[0]
      if (!m) { rows.push({ s, miss: true, b }); continue }
      const h = m.parts[0], c = m.src
      const dHead = Math.hypot(h[0] - c[0], h[1] - c[1], h[2] - c[2])
      rows.push({ s, y: b.runnerY, yb: c[1] - 0.5, dmgS: m.dmg, seenS: m.seen, dHead, headDist: b.headDist, seenP: b.seenP, bodyDy: b.bodyDy, bodyDyS: m.body[1] - (c[1] - 0.5), dmgB: b.dmg, ph: m.ph })
    }
  }
}
const ok = rows.filter(r => !r.miss)
for (const r of ok) if (process.env.ROWS) console.log(`${r.s} yb ${r.yb} урон ${r.dmgS.toFixed(1)} seen ${r.seenS} (прогноз ${r.seenP ?? '-'}) голова ${r.dHead.toFixed(2)} (прогноз ${r.headDist}) тело над ярусом ${r.bodyDyS.toFixed(2)} (прогноз ${r.bodyDy ?? '-'})`)
const eS = ok.filter(r => r.seenP != null).map(r => Math.abs(r.seenP - r.seenS))
const eD = ok.map(r => Math.abs(r.dHead - r.headDist))
console.log(`${tag}: взрывов ${ok.length} (без свидетеля ${rows.length - ok.length}); урон p25/p50 ${q(ok.map(r => r.dmgS), 0.25)}/${q(ok.map(r => r.dmgS), 0.5)}; seen p25/p50 ${q(ok.map(r => r.seenS), 0.25)}/${q(ok.map(r => r.seenS), 0.5)}; голова p50 ${q(ok.map(r => r.dHead), 0.5)}`)
console.log(`  ошибка прогноза seen p50/p90 ${q(eS, 0.5)}/${q(eS, 0.9)} (n ${eS.length}); головы p50/p90 ${q(eD, 0.5)}/${q(eD, 0.9)}`)
const dm = (d, s) => { const i = Math.max(0, 1 - d / 10) * s; return 35 * (i * i + i) + 1 }
const lossSeen = ok.map(r => dm(r.dHead, 1) - dm(r.dHead, r.seenS)); const lossD = ok.map(r => 71 - dm(r.dHead, 1))
console.log(`  недобор до 71: геометрия p50 ${q(lossD, 0.5)}, видимость p50 ${q(lossSeen, 0.5)} p75 ${q(lossSeen, 0.75)}; тело над ярусом p25/p50 ${q(ok.map(r => r.bodyDyS), 0.25)}/${q(ok.map(r => r.bodyDyS), 0.5)}`)
