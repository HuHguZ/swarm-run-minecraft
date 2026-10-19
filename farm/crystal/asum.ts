'use strict'
// Сводка строк ARMS_ROUND гонки вооружений (s7, 06.10): node dist/farm/crystal/asum.js <slot-27.out|jsonl> [--plan] [--dec]
import * as fs from 'fs'
const rows: any[] = []
for (const f of process.argv.slice(2).filter(a => !a.startsWith('--'))) for (const l of fs.readFileSync(f, 'utf8').split(/\r?\n/)) { const i = l.indexOf('{"n"'); if (i >= 0) try { rows.push(JSON.parse(l.slice(i))) } catch {} }
for (const r of rows) {
  console.log(`раунд ${r.n} seed ${r.seed}: победил ${r.winner || '—'} (${r.why}), ${r.durS} с игры / ${r.wallS} с, TPS ${r.tps}`)
  for (const [n, x] of Object.entries<any>(r.sides)) {
    console.log(`  ${n} ${x.start}: сила ${x.power} (в бою ${x.powerAtEngage}), оружие ${x.firstWeapon ?? '—'} с, броня ${x.firstArmor ?? '—'} с, сундуков ${x.chests}, тайников ${x.caches}${x.crafted && x.crafted.length ? ", крафт " + x.crafted.join("+") : ""}${x.ambushes ? `, засад ${x.ambushes} (дождался ${x.ambushSeen})` : ""}, боёв ${x.fights}, рядом ${x.near}, уходов ${x.retreats}, потерял ${x.hpLost} хп${x.physShare != null ? `, физ. тиков ${x.physShare}` : ""}${x.died ? ', УМЕР' : ''}${x.killed ? ', убил' : ''}`)
    if (x.inv0) console.log(`    старт: ${JSON.stringify(x.inv0)}`)
    if (Object.keys(x.fightWhy || {}).length) console.log(`    бои: ${JSON.stringify(x.fightWhy)}`)
    if (process.argv.includes('--plan')) console.log('    ' + x.plan.map(p => `${p.t}:${p.s}${p.o === 'SUCCESS' ? '' : '/' + p.o}`).join(' '))
    if (process.argv.includes('--dec')) for (const d of x.decisions || []) console.log(`    реш ${d.t}: ${d.plan} ${JSON.stringify(d.res)} ${JSON.stringify(d.facts)}`)
  }
}
// --agg: свод по всем раундам — победы по бойцам и по старту, медианы времени до оружия/брони, сундуки, сила в сшибке.
if (process.argv.includes('--agg')) {
  const med = (a: any[]) => { a = a.filter(x => x != null).sort((x, y) => x - y); return a.length ? (a[(a.length - 1) >> 1] + a[a.length >> 1]) / 2 : null }
  const by: Record<string, number> = {}; const bySide: Record<string, number> = { W: 0, E: 0 }
  const fw: any[] = []; const fa: any[] = []; const ch: any[] = []; const dur: any[] = []; const tps: any[] = []; const pw: any[] = []; const pl: any[] = []
  let draws = 0; let tact = 0; let richer = 0; const eng: any[] = []; const strat: Record<string, number> = {}
  for (const r of rows) {
    dur.push(r.durS); tps.push(r.tps)
    for (const x of Object.values<any>(r.sides)) {
      fw.push(x.firstWeapon); fa.push(x.firstArmor); ch.push(x.chests)
      // Первый ВХОД в Engage (S7d, ревью Codex); в старых файлах его нет — конец первого Engage из плана.
      eng.push(x.firstEngage ?? (x.plan.find((p: any) => p.s === 'Engage') || {}).t)
      for (const p of x.plan) strat[p.s] = (strat[p.s] || 0) + 1
    }
    if (!r.winner) { draws++; continue }
    by[r.winner] = (by[r.winner] || 0) + 1
    bySide[r.sides[r.winner].start]++
    const loser = Object.entries<any>(r.sides).find(([n]) => n !== r.winner)
    if (loser && r.sides[r.winner].chests > loser[1].chests) richer++
    for (const [n, x] of Object.entries<any>(r.sides)) {
      ;(n === r.winner ? pw : pl).push(x.powerAtEngage)
      if (n !== r.winner && Object.keys(x.fightWhy || {}).some(k => /tactical/.test(k))) tact++
    }
  }
  console.log(`СВОД: раундов ${rows.length}, ничьих ${draws}; победы ${JSON.stringify(by)}; по старту запад ${bySide.W} : восток ${bySide.E}`)
  console.log(`  медианы: первое оружие ${med(fw)} с (без оружия ${fw.filter(x => x == null).length} из ${fw.length}), броня ${med(fa)} с (без ${fa.filter(x => x == null).length}), сундуков ${med(ch)}, раунд ${med(dur)} с, TPS ${med(tps)} (мин ${Math.min(...tps)})`)
  console.log(`  сила в сшибке: победитель ${med(pw)}, проигравший ${med(pl)}; бой проигравшего оборван тактикой: ${tact} из ${rows.length - draws}; у победителя больше сундуков: ${richer}`)
  console.log(`  первый вход в Engage (в старых сериях — конец первого) медиана ${med(eng)} с; стратегий: ${JSON.stringify(strat)}`)
}
