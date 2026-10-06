// Сводка тактических эпизодов (daemon/src/tactics/minecraft.ts → telemetry: level 'tactical' на действие,
// 'tactical_episode' на инцидент): уровень, варианты, выбор, исход, цепочки до смерти.
//   node farm/tactics-report.js [--tag <метка>]... [--since <ISO>] [--file <jsonl>] [--deaths N] [--all] [--json]
// Демоны фермы пишут в общий daemon/skills.jsonl; строка привязана к слоту полем mcPort (25600+слот, с 06.10 вечера).
// Без --all — только строки с mcPort: до 06.10 туда же писали юнит-тесты (фальшивый бот, ручные часы).
// --tag берёт слоты из farm/results/<метка>*/pids.json и окно времени из slot-N.out (создан … последняя запись).
const fs = require('fs')
const path = require('path')

const ROOT = path.join(__dirname, '..')
const args = process.argv.slice(2)
const opt = (name: string) => args.flatMap((a, i) => a === name ? [args[i + 1]] : [])
const json = args.includes('--json')
const file = opt('--file')[0] || path.join(ROOT, 'daemon', 'skills.jsonl')
const since = opt('--since')[0] ? Date.parse(opt('--since')[0]) : -Infinity
const deathsShown = Number(opt('--deaths')[0] ?? 5)
const all = args.includes('--all')

type Row = Record<string, any>
const windows: Array<{ tag: string; port: number; from: number; to: number }> = []
for (const tag of opt('--tag')) {
  const results = path.join(__dirname, 'results')
  for (const dir of fs.readdirSync(results).filter((d: string) => d.startsWith(tag))) {
    let pids: Record<string, number> = {}
    try { pids = JSON.parse(fs.readFileSync(path.join(results, dir, 'pids.json'), 'utf8')) } catch { continue }
    for (const slot of Object.keys(pids)) {
      try {
        const stat = fs.statSync(path.join(results, dir, `slot-${slot}.out`))
        windows.push({ tag: dir, port: 25600 + Number(slot), from: Math.min(stat.birthtimeMs, stat.ctimeMs), to: stat.mtimeMs + 5000 })
      } catch {}
    }
  }
}

const rows: Row[] = []
let unattributed = 0
for (const line of fs.readFileSync(file, 'utf8').split('\n')) {
  if (!line.includes('"level":"tactical')) continue
  let row: Row
  try { row = JSON.parse(line) } catch { continue }
  const at = Date.parse(row.at)
  if (at < since || !all && row.mcPort === undefined && !windows.length) continue
  if (windows.length) {
    const hit = windows.find(w => row.mcPort === w.port && at >= w.from && at <= w.to)
    if (!hit) { if (row.mcPort === undefined) unattributed++; continue }
    row.tag = hit.tag
  }
  rows.push(row)
}

const count = (list: string[]) => Object.entries(list.reduce((m: Record<string, number>, k) => (m[k] = (m[k] || 0) + 1, m), {}))
  .sort((a, b) => b[1] - a[1])
const mean = (list: number[]) => list.length ? Math.round(list.reduce((a, b) => a + b, 0) / list.length * 10) / 10 : null
const actions = rows.filter(r => r.level === 'tactical')
const episodes = rows.filter(r => r.level === 'tactical_episode')
const bySkill: Record<string, Row> = {}
for (const r of actions) (bySkill[r.skill] ||= []).push(r)
const report = {
  file: path.relative(ROOT, file), rows: rows.length, unattributed: windows.length ? unattributed : undefined,
  episodes: { count: episodes.length, results: count(episodes.map(e => e.result)), threat: count(episodes.map(e => `L${e.threat}`)),
    sec: mean(episodes.map(e => e.sec)), hpLost: mean(episodes.map(e => e.hp0 - e.hp)),
    chains: count(episodes.map(e => (e.chain || e.actions || []).join('>') + (e.result === 'died' ? ' ✝' : ''))).slice(0, 12) },
  actions: Object.entries(bySkill).sort((a: any, b: any) => b[1].length - a[1].length).map(([skill, list]: [string, any]) => ({
    skill, n: list.length, results: count(list.map((r: Row) => r.result)), outcomes: count(list.filter((r: Row) => r.outcome).map((r: Row) => r.outcome)),
    sec: mean(list.map((r: Row) => r.sec)),
    hpDelta: mean(list.map((r: Row) => r.hp - r.hp0)), threat: count(list.map((r: Row) => `L${r.threat}`)),
    preemptedBy: count(list.filter((r: Row) => r.result === 'preempted' && r.detail?.by).map((r: Row) => r.detail.by)) })),
  deaths: episodes.filter(e => e.result === 'died').slice(-deathsShown).map(e => ({ at: e.at, tag: e.tag, mcPort: e.mcPort,
    chain: e.chain || e.actions, hp0: e.hp0, sec: e.sec, state: e.state }))
}
if (json) console.log(JSON.stringify(report, null, 2))
else {
  const pairs = (list: Array<[string, number]>) => list.map(([k, n]) => `${k} ${n}`).join(', ')
  console.log(`${report.file}: строк ${report.rows}${report.unattributed ? `, без mcPort (не отнесены к метке) ${report.unattributed}` : ''}`)
  console.log(`эпизоды ${report.episodes.count}: ${pairs(report.episodes.results)}; уровни ${pairs(report.episodes.threat)}; ` +
    `в среднем ${report.episodes.sec} с, −${report.episodes.hpLost} хп`)
  for (const [chain, n] of report.episodes.chains) console.log(`  ${String(n).padStart(4)}  ${chain}`)
  console.log('действия:')
  for (const a of report.actions) console.log(`  ${a.skill.padEnd(18)} ${String(a.n).padStart(5)}  ${pairs(a.results)}${a.outcomes.length ? ` [${pairs(a.outcomes)}]` : ''}; ${a.sec} с, хп ${a.hpDelta}; ${pairs(a.threat)}` +
    (a.preemptedBy.length ? `; вытеснен: ${pairs(a.preemptedBy)}` : ''))
  if (report.deaths.length) console.log('смерти (последние):')
  for (const d of report.deaths) console.log(`  ${d.at} ${d.tag || d.mcPort || ''} ${(d.chain || []).join('>')} hp0 ${d.hp0} за ${d.sec} с` +
    (d.state ? ` | ${JSON.stringify(d.state)}` : ''))
}
