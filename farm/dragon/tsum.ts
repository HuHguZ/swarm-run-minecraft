// Сводка трассы боя: node tsum.js <файл.jsonl> [от_с] [до_с]
import * as fs from 'fs'
const [file, from = 0, to = 1e9] = process.argv.slice(2)
const L = fs.readFileSync(file, 'utf8').split('\n').filter(Boolean).map(l => { try { return JSON.parse(l) } catch { return null } }).filter(Boolean)
let lastDoing = null; let lastP = null; let lastHp = null; let lastPh = null
const skip = new Set(['hp', 'angry', 'stare'])
for (const l of L) {
  const t = l.t / 1000
  if (t < +from || t > +to) continue
  if (l.k === 's') {
    const ph = l.d ? l.d.ph : null
    if (l.doing !== lastDoing || !lastP || Math.hypot(l.p[0] - lastP[0], l.p[2] - lastP[2]) > 5 || Math.abs(l.p[1] - lastP[1]) > 1.5 || Math.abs(l.hp - lastHp) >= 1 || ph !== lastPh) {
      console.log(t.toFixed(1), 's', JSON.stringify(l.p), 'hp', l.hp, 'g', l.g, l.doing, l.d ? `d ph${l.d.ph} hp${l.d.hp} ${JSON.stringify(l.d.p)} y${l.d.yaw}` : '', l.cl ? JSON.stringify(l.cl) : '', l.fb || '')
      lastDoing = l.doing; lastP = l.p; lastHp = l.hp; lastPh = ph
    }
  } else if (!skip.has(l.k)) console.log(t.toFixed(1), JSON.stringify(l).slice(0, 360))
}
