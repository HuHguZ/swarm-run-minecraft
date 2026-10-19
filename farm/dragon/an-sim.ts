// Сколько посадок до смерти дракона при уроне D за посадку и лечении 2 хп/с в перерывах
// (перерывы — эмпирические, из трасс: от конца сидения до следующего SCANNING).
import * as fs from 'fs'; import path = require('path')
const L = 'C:/Users/user/Desktop/work/minecraft-claude/farm/logs'
const gaps = []
for (const d of fs.readdirSync(L).filter(f => f.startsWith('trace-'))) {
  for (const f of fs.readdirSync(path.join(L, d))) {
    let lines
    try { lines = fs.readFileSync(path.join(L, d, f), 'utf8').split('\n').filter(Boolean).map(l => JSON.parse(l)) } catch { continue }
    const P = lines.filter(l => l.k === 'phase')
    let sitEnd = null
    for (let i = 1; i < P.length; i++) {
      const sit = [5, 6, 7].includes(P[i].ph); const was = [5, 6, 7].includes(P[i - 1].ph)
      if (!sit && was) sitEnd = P[i].t
      if (P[i].ph === 6 && P[i - 1].ph === 3 && sitEnd != null) { gaps.push((P[i].t - sitEnd) / 1000); sitEnd = null }
    }
  }
}
const pickGap = () => gaps[Math.floor(Math.random() * gaps.length)]
for (const D of [90, 110, 130, 150, 170]) {
  const res = []
  for (let k = 0; k < 20000; k++) {
    let hp = 200; let t = 60; let n = 0
    while (t < 15 * 60 && n < 40) {
      n++
      hp -= D * (0.8 + Math.random() * 0.4)
      if (hp <= 0) break
      const g = pickGap(); t += g + 8
      hp = Math.min(200, hp + 2 * (g + 4))
    }
    res.push(hp <= 0 ? n : 99)
  }
  const win = res.filter(x => x < 99)
  win.sort((a, b) => a - b)
  console.log(`D=${D}: победа за 15 мин ${(win.length / res.length * 100).toFixed(0)}%, посадок: медиана ${win[win.length >> 1] ?? '-'}`)
}
