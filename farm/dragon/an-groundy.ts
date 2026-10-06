// Высота ног бота на земле у фонтана (g=1) по кольцам радиуса; и Y сидящего дракона.
const fs = require('fs'); const path = require('path')
const L = 'C:/Users/user/Desktop/work/minecraft-claude/farm/logs'
const h: Record<string, any> = {} as Record<string, any>; const Ys: Record<string, any> = {} as Record<string, any>
for (const d of fs.readdirSync(L).filter(f => f.startsWith('trace-')).slice(0, 80)) {
  for (const f of fs.readdirSync(path.join(L, d))) {
    let lines
    try { lines = fs.readFileSync(path.join(L, d, f), 'utf8').split('\n').filter(Boolean).map(l => JSON.parse(l)) } catch { continue }
    for (const l of lines) {
      if (l.k !== 's') continue
      if (l.d && [5, 6, 7].includes(l.d.ph)) { const y = l.d.p[1].toFixed(1); Ys[y] = (Ys[y] || 0) + 1 }
      if (!l.g) continue
      const r = Math.hypot(l.p[0] - 0.5, l.p[2] - 0.5)
      if (r > 14) continue
      const k = Math.floor(r / 2) * 2
      const y = Math.round(l.p[1] * 10) / 10
      h[k] = h[k] || {} as Record<string, any>; h[k][y] = (h[k][y] || 0) + 1
    }
  }
}
for (const k of Object.keys(h).sort((a: any, b: any) => a - b)) console.log('r', k, '-', k + 2, Object.entries<any>(h[k]).sort((a, b) => b[1] - a[1]).slice(0, 5).map(([y, n]: any) => `${y}:${n}`).join(' '))
console.log('Y сидя:', Object.entries<any>(Ys).sort((a, b) => b[1] - a[1]).slice(0, 8).map(([y, n]: any) => `${y}:${n}`).join(' '))
