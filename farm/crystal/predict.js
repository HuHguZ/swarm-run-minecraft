'use strict'
// Модель урона против сервера (2026-09-30): в логе демона пара «кристалл у его
// ног и удар (прогноз ему X, мне Y)» → следующая «[crystal] мой взрыв: {dealt,
// self}» (урон — по здоровью и поглощению за 400 мс). Без «попов» (там урон —
// всё здоровье). Ошибка — медиана и доля в пределах ±2 хп.
//   node farm/crystal/predict.js farm/daemon-29.out.log farm/crystal/daemon-29b.out.log
const fs = require('fs')
const pairs = []
for (const f of process.argv.slice(2)) {
  const lines = fs.readFileSync(f, 'utf8').split(/\r?\n/)
  let want = null
  for (const l of lines) {
    const m = l.match(/кристалл у его ног и удар \(прогноз ему ([\d.]+), мне ([\d.]+)\)|кристалл у него — удар \(прогноз ему ([\d.]+), мне ([\d.]+)\)/)
    if (m) { want = { him: Number(m[1] || m[3]), me: Number(m[2] || m[4]) }; continue }
    const b = l.match(/\[crystal\] мой взрыв: (\{.*\})/)
    if (b && want) {
      try {
        const j = JSON.parse(b[1])
        if (!j.popHim && !j.popMe) pairs.push({ ...want, dealt: j.dealt, self: j.self })
      } catch {}
      want = null
    }
  }
}
if (!pairs.length) { console.log('пар нет'); process.exit(0) }
const med = (xs) => { const s = xs.slice().sort((a, b) => a - b); return s[Math.floor(s.length / 2)] }
const f1 = (x) => Math.round(x * 10) / 10
const eh = pairs.map(p => p.dealt - p.him)
const em = pairs.map(p => p.self - p.me)
const within = (xs, d) => Math.round(100 * xs.filter(x => Math.abs(x) <= d).length / xs.length)
console.log(`пар ${pairs.length}: ему прогноз ${f1(pairs.reduce((s, p) => s + p.him, 0) / pairs.length)}, факт ${f1(pairs.reduce((s, p) => s + p.dealt, 0) / pairs.length)}; ошибка медиана ${f1(med(eh))}, в ±2 хп ${within(eh, 2)}%`)
console.log(`себе прогноз ${f1(pairs.reduce((s, p) => s + p.me, 0) / pairs.length)}, факт ${f1(pairs.reduce((s, p) => s + p.self, 0) / pairs.length)}; ошибка медиана ${f1(med(em))}, в ±2 хп ${within(em, 2)}%; факт себе > прогноз+3: ${em.filter(x => x > 3).length}`)
