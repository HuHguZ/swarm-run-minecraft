// Для каждой посадки: откуда шёл дракон (LANDING), где был бот, куда смотрела голова, сев.
const fs = require('fs'); const path = require('path')
const L = 'C:/Users/user/Desktop/work/minecraft-claude/farm/logs'
const deg = r => Math.round(r * 180 / Math.PI)
const wrap = a => { while (a > Math.PI) a -= 2 * Math.PI; while (a < -Math.PI) a += 2 * Math.PI; return a }
const rows = []
for (const d of fs.readdirSync(L).filter(f => f.startsWith('trace-'))) {
  for (const f of fs.readdirSync(path.join(L, d))) {
    let lines
    try { lines = fs.readFileSync(path.join(L, d, f), 'utf8').split('\n').filter(Boolean).map(l => JSON.parse(l)) } catch { continue }
    const S = lines.filter(l => l.k === 's' && l.d && l.d.p)
    for (let i = 1; i < S.length; i++) {
      if (S[i].d.ph === 3 && S[i - 1].d.ph !== 3) {
        // начало LANDING
        const a = S[i]
        let j = i; while (j < S.length && S[j].d.ph === 3) j++
        if (j >= S.length || S[j].d.ph !== 6) continue
        const sit = S[j]
        // направление захода: от первой точки LANDING к центру
        const ax = 0.5 - a.d.p[0]; const az = 0.5 - a.d.p[2]
        const appr = Math.atan2(ax, az) // угол в осях (sin, cos) как у mineflayer yaw: dir = (sin yaw, cos yaw)
        const head = sit.d.yaw
        // где бот при начале LANDING
        const bx = a.p[0] - 0.5; const bz = a.p[2] - 0.5
        const botAng = Math.atan2(bx, bz)
        const botR = Math.hypot(bx, bz)
        // yaw через 1.5 с сидения
        let k = j; while (k < S.length && S[k].t - sit.t < 1500 && [5, 6, 7].includes(S[k].d.ph)) k++
        const later = S[Math.min(k, S.length - 1)]
        const landMs = sit.t - a.t
        rows.push({ d, landMs, apprVsHead: deg(wrap(head - appr)), botVsAppr: deg(wrap(botAng - appr)), botVsHead: deg(wrap(botAng - head)), botR: Math.round(botR), headLater: deg(wrap(later.d.yaw - head)), landDist: Math.round(Math.hypot(ax, az)) })
      }
    }
  }
}
console.log('perches', rows.length)
const hist = (k, bin = 15) => { const h: Record<string, any> = {} as Record<string, any>; for (const r of rows) { const b = Math.round(r[k] / bin) * bin; h[b] = (h[b] || 0) + 1 } return Object.entries<any>(h).sort((a: any, b: any) => a[0] - b[0]).map(([b, n]: any) => `${b}:${n}`).join(' ') }
console.log('head - approach dir:', hist('apprVsHead'))
console.log('bot - approach dir:', hist('botVsAppr'))
console.log('bot - head dir:', hist('botVsHead'))
console.log('yaw change first 1.5s:', hist('headLater'))
const lm = rows.map(r => r.landMs).sort((a, b) => a - b); console.log('LANDING ms median', lm[lm.length >> 1], 'p10', lm[Math.floor(lm.length * 0.1)], 'p90', lm[Math.floor(lm.length * 0.9)])
const near = rows.filter(r => r.botR >= 8 && r.botR <= 16)
console.log('bot 8-16 from center n', near.length, 'bot-head:', (() => { const h: Record<string, any> = {} as Record<string, any>; for (const r of near) { const b = Math.round(r.botVsHead / 15) * 15; h[b] = (h[b] || 0) + 1 } return Object.entries<any>(h).sort((a: any, b: any) => a[0] - b[0]).map(([b, n]: any) => `${b}:${n}`).join(' ') })())
