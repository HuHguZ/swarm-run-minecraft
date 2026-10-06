// Куда летит тело на взлёте (азимут смещения тела через ~1.5–2 с) — один ли узел для мира.
const fs = require('fs'); const path = require('path')
const L = 'C:/Users/user/Desktop/work/minecraft-claude/farm/logs'
const h: Record<string, any> = {} as Record<string, any>; const byYaw: Record<string, any> = {} as Record<string, any>
for (const d of fs.readdirSync(L).filter(f => f.startsWith("trace-" + (process.argv[2] || "")))) {
  for (const f of fs.readdirSync(path.join(L, d))) {
    let lines
    try { lines = fs.readFileSync(path.join(L, d, f), 'utf8').split('\n').filter(Boolean).map(l => JSON.parse(l)) } catch { continue }
    const S = lines.filter(l => l.k === 's' && l.d && l.d.p)
    for (let i = 1; i < S.length; i++) {
      if (!(S[i].d.ph === 4 && [5, 6, 7].includes(S[i - 1].d.ph))) continue
      const s0 = S[i - 1]
      if (Math.hypot(s0.d.p[0] - 0.5, s0.d.p[2] - 0.5) > 2) continue
      const s1 = S.find(s => s.t - s0.t >= 1800 && s.t - s0.t < 2600)
      if (!s1) continue
      const dx = s1.d.p[0] - s0.d.p[0]; const dz = s1.d.p[2] - s0.d.p[2]
      if (Math.hypot(dx, dz) < 3) continue
      const az = Math.round(Math.atan2(dz, dx) * 180 / Math.PI / 15) * 15
      h[az] = (h[az] || 0) + 1
      // азимут головы сидя (в осях x=cos,z=sin): голова = (sin yaw, cos yaw)
      const hy = Math.round(Math.atan2(Math.cos(s0.d.yaw), Math.sin(s0.d.yaw)) * 180 / Math.PI / 45) * 45
      byYaw[hy] = byYaw[hy] || {} as Record<string, any>; byYaw[hy][az] = (byYaw[hy][az] || 0) + 1
    }
  }
}
console.log('азимут полёта тела (x=cos, z=sin):', Object.entries<any>(h).sort((a: any, b: any) => a[0] - b[0]).map(([a, n]: any) => `${a}:${n}`).join(' '))
for (const [hy, m] of Object.entries<any>(byYaw).sort((a: any, b: any) => a[0] - b[0])) console.log('голова сидя', hy, '→', Object.entries<any>(m).sort((a, b) => b[1] - a[1]).slice(0, 5).map(([a, n]: any) => `${a}:${n}`).join(' '))
