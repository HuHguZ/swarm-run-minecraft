// Загрузка ЦП всего ПК раз в N с (os.cpus, без прав администратора): node dist/farm/dragon/cpu-log.js <файл> [сек=5] [минут=180]
// Строка: ISO-время и % занятости всех ядер. Сводка боёв по CPU — farm/dragon/an-crys.js (окно боя по трассе).
import * as fs from 'fs'; import * as os from 'os'
const out = process.argv[2]; const sec = Number(process.argv[3] || 5); const mins = Number(process.argv[4] || 180)
if (!out) { console.error('файл?'); process.exit(1) }
const snap = () => os.cpus().reduce((a, c) => { const t = c.times; a.idle += t.idle; a.all += t.user + t.nice + t.sys + t.idle + t.irq; return a }, { idle: 0, all: 0 })
let prev = snap()
const end = Date.now() + mins * 60000
const timer = setInterval(() => {
  const cur = snap()
  const all = cur.all - prev.all; const idle = cur.idle - prev.idle
  prev = cur
  if (all > 0) fs.appendFileSync(out, `${new Date().toISOString()} ${Math.round(1000 * (1 - idle / all)) / 10}\n`)
  if (Date.now() > end) clearInterval(timer)
}, sec * 1000)
