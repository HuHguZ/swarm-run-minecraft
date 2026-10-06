// Скорость лечения дракона по трассам: подъёмы хп между сэмплами; и сколько раз был «полный» (200) после урона
const fs = require('fs'); const path = require('path')
const L = 'C:/Users/user/Desktop/work/minecraft-claude/farm/logs'
let up = 0; let upT = 0; let flat = 0; let flatT = 0
const ex = []
for (const d of fs.readdirSync(L).filter(f => f.startsWith('trace-'))) {
  for (const f of fs.readdirSync(path.join(L, d))) {
    let lines
    try { lines = fs.readFileSync(path.join(L, d, f), 'utf8').split('\n').filter(Boolean).map(l => JSON.parse(l)) } catch { continue }
    const S = lines.filter(l => l.k === 's' && l.d && l.d.hp != null)
    const gone = new Set(lines.filter(l => l.k === 'crystalGone').map(l => l.id))
    for (let i = 1; i < S.length; i++) {
      const dt = S[i].t - S[i - 1].t
      if (dt > 600) continue
      const dh = S[i].d.hp - S[i - 1].d.hp
      if (S[i - 1].d.hp >= 199.5) continue
      if (dh > 0) { up += dh; upT += dt } else if (dh === 0) { flat++; flatT += dt }
    }
    // пример: участок подъёма > 20 хп
    let st = null
    for (let i = 1; i < S.length; i++) {
      if (S[i].d.hp > S[i - 1].d.hp) { if (!st) st = S[i - 1] } else if (st && S[i].d.hp < S[i - 1].d.hp) { st = null }
      if (st && S[i].d.hp - st.d.hp > 30 && ex.length < 8) { ex.push({ d, from: Math.round(st.d.hp), to: Math.round(S[i].d.hp), secs: ((S[i].t - st.t) / 1000).toFixed(1), at: Math.round(st.t / 1000) }); st = null }
    }
  }
}
console.log('подъём хп', up.toFixed(0), 'за', (upT / 1000).toFixed(0), 'с — во время подъёма', (up / (upT / 1000)).toFixed(2), 'хп/с; ровных сэмплов ниже 200:', flat)
console.log(ex)
