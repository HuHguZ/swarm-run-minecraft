'use strict'
// Сводка дуэлей кристаллами (2026-09-30): строки «ROUND {...}» из вывода
// арены (farm/crystal/*.out или daemon/arena-88xx.log).
//   node dist/farm/crystal/csum.js farm/crystal/c2-29.out farm/crystal/c2-30.out
//   node dist/farm/crystal/csum.js 'farm/crystal/c3-*.out'
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
const rounds = []
for (const f of files(process.argv.slice(2))) {
  for (const line of fs.readFileSync(f, 'utf8').split(/\r?\n/)) {
    const i = line.indexOf('ROUND {')
    if (i < 0) continue
    try { const r = JSON.parse(line.slice(i + 6)); r.file = path.basename(f); rounds.push(r) } catch {}
  }
}
if (!rounds.length) { console.log('раундов нет'); process.exit(0) }
const n = rounds.length
const sum = (xs) => xs.reduce((s, x) => s + (x || 0), 0)
const med = (xs) => { const s = xs.slice().sort((a, b) => a - b); return s.length ? s[Math.floor(s.length / 2)] : 0 }
const side = (r, k) => [r.a, r.b].map(s => (s.crystal || {} as Record<string, any>)[k] || 0)
const both = (k) => rounds.map(r => sum(side(r, k)))
const wins = rounds.filter(r => r.winner).length
const draws = n - wins
const dur = rounds.map(r => r.durS)
const byName: Record<string, any> = {} as Record<string, any>
for (const r of rounds) if (r.winner) byName[r.winner] = (byName[r.winner] || 0) + 1
// Взрывы в раунде: у каждого бойца «booms» — все взрывы, что он видел; берём
// максимум из двух (оба видят одни и те же), свои — сумма «mine».
const booms = rounds.map(r => Math.max(...side(r, 'booms')))
const mineB = both('mine')
// Тотемы — счёт crystal.js за бой (st.myPops): счётчик totem.js копится между раундами.
const pops = both('myPops')
const popsDealt = both('popsDealt')
const selfPops = both('selfPops')
const self = both('self')
const dealt = rounds.flatMap(r => [...((r.a.crystal || {} as Record<string, any>).dealt || []), ...((r.b.crystal || {} as Record<string, any>).dealt || [])])
const wall = rounds.map(r => sum(side(r, 'wallPlace')) + sum(side(r, 'wallHit')))
const deaths = rounds.map(r => (r.a.died ? 1 : 0) + (r.b.died ? 1 : 0))
const ringouts = rounds.filter(r => r.a.ringout || r.b.ringout).length
const f1 = (x) => Math.round(x * 10) / 10
console.log(`раундов ${n}: победа ${wins} (${Object.entries<any>(byName).map(([k, v]: any) => `${k} ${v}`).join(', ')}), ничьих ${draws}, вылетов с ринга ${ringouts}`)
console.log(`длительность, с: среднее ${f1(sum(dur) / n)}, медиана ${med(dur)}, мин ${Math.min(...dur)}, макс ${Math.max(...dur)}`)
console.log(`взрывов за раунд: среднее ${f1(sum(booms) / n)} (подрывов бойцами ${f1(sum(mineB) / n)}), всего ${sum(booms)}`)
console.log(`тотемов сработало за раунд: ${f1(sum(pops) / n)} (всего ${sum(pops)}; от чужого кристалла ${sum(popsDealt)})`)
console.log(`урон ему за свой подрыв: среднее ${dealt.length ? f1(sum(dealt) / dealt.length) : '-'} (${dealt.length} подрывов с замером)`)
console.log(`себе от своих подрывов: ${f1(sum(self))} хп за все раунды; САМОПОДРЫВОВ (свой тотем своим кристаллом): ${sum(selfPops)}`)
console.log(`сквозь стену: поставлено/ударено 0 по построению (pick.faceAim/aim); второй луч не согласился — отказов ${sum(wall)}`)
const tot = (k) => sum(both(k))
console.log(`приёмы: поставил ${tot('placed')}, рукой ${tot('hits')}, стрелой ${tot('shots')}, заранее ${tot('pre')}, окружение ${tot('surround')} (${tot('surroundBlocks')} бл.), сбил его ${tot('defuse')}, в своё окно ${tot('free')}, уходы ${tot('dodges')}, яблок ${tot('gapples')}, починок ${tot('mends')} (бутылок ${tot('bottles')}, прочности +${tot('repaired')})`)
console.log(`смертей ${sum(deaths)}`)
if (process.env.V) for (const r of rounds) console.log(`  ${r.file} #${r.n}: ${r.winner || 'ничья'} ${r.durS}с, взрывов ${Math.max(...side(r, 'booms'))}, тотемы ${side(r, 'myPops').join('/')}, хп ${r.a.hp} | ${r.b.hp}`)
