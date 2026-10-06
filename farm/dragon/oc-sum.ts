'use strict'
// Сводка серии «один цикл»: node farm/dragon/oc-sum.js <тег-префикс> [...]
// По каждому бою (farm/logs/trace-<тег>-*/dragon-*.jsonl и farm/logs/<тег>*.jsonl): победа, смерть,
// посадки и урон за посадку (кровати по фазам), слепота, кровати на снижении; и урон взрыва
// против расстояния изголовье–голова в миг щелчка (dist — до головы по прогнозу/частям).
const fs = require('fs'); const path = require('path')
const L = path.join(__dirname, '..', 'logs')
const tags = process.argv.slice(2)
const rows = []; const pairs = []
for (const tag of tags) {
  for (const d of fs.readdirSync(L).filter(f => f.startsWith('trace-' + tag))) {
    for (const f of fs.readdirSync(path.join(L, d)).filter(f => f.startsWith('dragon-'))) {
      let ev
      try { ev = fs.readFileSync(path.join(L, d, f), 'utf8').split('\n').filter(Boolean).map(l => JSON.parse(l)) } catch { continue }
      const perches = []; let cur = null; let blind = null; let died = false; let hpMin = 200; let won = false; let lastT = 0
      const Ls = []
      for (const e of ev) {
        lastT = e.t
        if (e.k === 's' && e.d && e.d.hp != null && e.d.hp >= 0) hpMin = Math.min(hpMin, e.d.hp)
        if (e.k === 'phase' && e.ph === 3) { cur = { t: e.t, hp0: e.hp, beds: [] }; perches.push(cur) }
        if (e.k === 'phase' && (e.ph === 4 || e.ph === 8 || e.ph === 9) && cur && cur.hp1 == null) cur.hp1 = e.hp
        if (e.k === 'bedDone') {
          if (!cur) { cur = { t: e.t, hp0: null, beds: [] }; perches.push(cur) }
          cur.beds.push(e)
          if (e.dmg != null) pairs.push({ dist: e.headDist != null ? e.headDist : e.dist, dmg: e.dmg, kind: e.oc || (e.ph || '').slice(0, 5) })
          if (e.oc === 'L') Ls.push(e)
        }
        if (e.k === 'blind:result') blind = e.sat && !e.roared ? 'да' : 'нет'
        if (e.k === 'death') died = true
        if (e.k === 'end' && e.won) won = true
      }
      const dmgs = perches.map(p => p.beds.reduce((s, b) => s + (b.dmg || 0), 0)).filter(x => x > 0)
      rows.push({ fight: d.replace('trace-', ''), secs: Math.round(lastT / 1000), won, died, blind, perches: perches.length, beds: perches.reduce((s, p) => s + p.beds.length, 0), perchDmg: dmgs.map(x => Math.round(x)), best: dmgs.length ? Math.round(Math.max(...dmgs)) : 0, L: Ls.map(e => `${Math.round(e.dmg)}@${e.headDist}`), hpMin: Math.round(hpMin), hp: perches.map(p => `${Math.round(p.hp0 ?? 0)}→${p.hp1 != null ? Math.round(p.hp1) : '?'}`).join(' ') })
    }
  }
}
// итоги E2E (серверный свидетель победы)
const res = []
for (const tag of tags) for (const f of fs.readdirSync(L).filter(f => f.startsWith(tag) && f.endsWith('.jsonl'))) for (const l of fs.readFileSync(path.join(L, f), 'utf8').split('\n').filter(Boolean)) { try { res.push(JSON.parse(l)) } catch {} }
console.log('бой | с | слепой | посадок | кроватей | урон за посадку | лучшая | L (урон@расст.) | мин хп | хп дракона по посадкам')
for (const r of rows) console.log(`${r.fight} | ${r.secs} | ${r.blind} | ${r.perches} | ${r.beds} | ${JSON.stringify(r.perchDmg)} | ${r.best} | ${r.L.join(' ')} | ${r.hpMin}${r.died ? ' | СМЕРТЬ' : ''} | ${r.hp}`)
console.log('\nE2E:', res.map(r => `${r.killed ? 'ПОБЕДА' : 'нет'}${r.died ? '/смерть' : ''} ${r.killSecs || r.secs}с драк.${r.dragonHp}`).join('; '))
// урон против расстояния
const bins: Record<string, any> = {} as Record<string, any>
for (const p of pairs) { const b = Math.floor(p.dist * 2) / 2; (bins[b] = bins[b] || []).push(p.dmg) }
console.log('\nрасстояние изголовье–голова → урон (n, медиана, макс):')
for (const b of Object.keys(bins).map(Number).sort((a, c) => a - c)) { const a = bins[b].sort((x, y) => x - y); console.log(`  ${b.toFixed(1)}–${(b + 0.5).toFixed(1)}: n ${a.length}, мед ${a[Math.floor(a.length / 2)].toFixed(1)}, макс ${a[a.length - 1].toFixed(1)}`) }
