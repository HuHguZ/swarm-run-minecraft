'use strict'
import { REPO_ROOT } from '../../src/paths'
// Existing farm only. Never starts or replaces a server/daemon.
// node dist/daemon/scenes/infra/try-tick-speed.js --slot 31 --rates 100,200,400,800 --repeats 3 --tag tick-speed
import * as fs from 'node:fs'
import path = require('node:path')
import { spawn, execFile } from 'node:child_process'
import { tickRate } from '../../../farm/tick-control'
const ROOT = REPO_ROOT
const FARM = path.join(__dirname, '..', '..', '..', 'farm', 'farm.js')
const delay = ms => new Promise<any>(resolve => setTimeout(resolve, ms))
const round = value => Number.isFinite(value) ? +value.toFixed(1) : null

function options (argv) {
  const a: Record<string, any> = { slot: process.env.FARM_SLOT, rates: '100,200,400,800', repeats: '3', seconds: '8', tag: 'tick-speed-' + Date.now() }
  for (let i = 0; i < argv.length; i++) {
    const key = argv[i].replace(/^--/, '')
    if (key === 'help') return { help: true }
    if (!['slot', 'rates', 'repeats', 'seconds', 'tag'].includes(key) || argv[i + 1] === undefined) throw new Error('параметры: --slot N --rates 100,200,400,800 --repeats 3 --seconds 8 --tag имя')
    a[key] = argv[++i]
  }
  a.slot = Number(a.slot); a.repeats = Number(a.repeats); a.seconds = Number(a.seconds)
  if (!Number.isInteger(a.slot) || a.slot < 1 || a.slot > 32) throw new Error('--slot: явно укажи один существующий слот фермы 1..32')
  if (!Number.isInteger(a.repeats) || a.repeats < 1 || a.repeats > 20) throw new Error('--repeats: 1..20')
  if (!Number.isFinite(a.seconds) || a.seconds < 4 || a.seconds > 60) throw new Error('--seconds: 4..60 настенных секунд на устойчивый замер')
  if (!/^[a-zA-Z0-9_-]+$/.test(a.tag)) throw new Error('--tag: буквы, цифры, _ и -')
  a.rates = [...new Set(a.rates.split(',').map(value => tickRate({ 'tick-rate': value }, {} as Record<string, any>)))].sort((x: any, y: any) => x - y)
  if (a.rates.some(rate => Math.ceil(rate / 20 * a.seconds) > 600)) throw new Error('замер превышает лимит wait 600 игровых секунд: уменьши --seconds или --rates')
  return a
}

function querySample (text) {
  const number = re => { const m = re.exec(text); return m ? Number(m[1].replace(',', '.')) : null }
  return { target: number(/Target tick rate:\s*([\d.,]+)/i), mspt: number(/Average time per tick:\s*([\d.,]+)ms/i),
    p95MSPT: number(/P95:\s*([\d.,]+)ms/i), overloaded: /can't keep up|lagging/i.test(text), raw: text.trim() }
}

function analyze (rate, trials, settings) {
  const selected = trials.map(trial => ({ ...trial, selected: trial.rows.filter(row => row.rate === rate) }))
  const waits = selected.map(trial => trial.selected.find(row => /^wait\d/.test(row.name)))
  const failures = { goto: 0, dig: 0, combat: 0 }
  for (const trial of selected) for (const [key, name] of [['goto', 'walk24'], ['dig', 'dig-stone'], ['combat', 'fight-zombie']]) {
    const row = trial.selected.find(row => row.name === name)
    if (!row || row.status !== 'done') failures[key]++
  }
  const actual = waits.map(row => row?.actualServerTPS).filter(Number.isFinite)
  const lags = waits.map(row => row?.lagTicks).filter(Number.isFinite)
  const maxLagTicks = Math.max(0, ...selected.flatMap(trial => trial.selected.map(row => row.lagTicks)).filter(Number.isFinite))
  const queries = trials.flatMap(trial => trial.queries).filter(query => query.target === rate && query.mspt !== null)
  const totalWall = waits.reduce((sum, row) => sum + (row?.realSeconds || 0), 0)
  const botTPS = waits.every(row => Number.isFinite(row?.ticks)) && totalWall > 0 ? waits.reduce((sum, row) => sum + row.ticks, 0) / totalWall : null
  const serverTPS = actual.length === trials.length && totalWall > 0 ? waits.reduce((sum, row) => sum + row.actualServerTPS * row.realSeconds, 0) / totalWall : null
  const reasons = []
  if (trials.some(trial => trial.sceneExit !== 0 || trial.runnerExit !== 0 || trial.timedOut)) reasons.push('probe failed')
  if (Object.values<any>(failures).some(count => count)) reasons.push('goto/dig/combat failed or missing')
  if (waits.some(row => !row || row.status !== 'done' || row.realSeconds < settings.seconds * 0.8)) reasons.push('insufficient steady sample')
  if (actual.length !== trials.length) reasons.push('actual server TPS unavailable')
  else if (rate > 20 && Math.min(...actual) <= 20) reasons.push('actual server TPS does not accelerate beyond 20')
  if (serverTPS !== null && (botTPS === null || botTPS < serverTPS * 0.9)) reasons.push('bot ticks below 90% of server ticks')
  if (maxLagTicks > 20) reasons.push('bot lag exceeds 20 game ticks')
  if (lags.length !== trials.length) reasons.push('bot lag unavailable')
  if (!queries.length) reasons.push('no matching RCON MSPT sample')
  if (trials.length < 2) reasons.push('one trial: provisional')
  return { requestedTPS: rate, actualServerTPS: round(serverTPS), actualBotTPS: round(botTPS), minTrialTPS: actual.length ? round(Math.min(...actual)) : null,
    trials: trials.length, steadyWallSeconds: round(totalWall), failures, maxLagTicks, querySamples: queries.length,
    maxAverageMSPT: queries.length ? Math.max(...queries.map(query => query.mspt)) : null,
    maxServerP95MSPT: queries.some(query => query.p95MSPT !== null) ? Math.max(...queries.map(query => query.p95MSPT ?? 0)) : null,
    overloadedSamples: queries.filter(query => query.overloaded).length,
    targetReached: actual.length === trials.length && Math.min(...actual) >= rate * 0.9,
    stable: reasons.length === 0, reasons }
}

function farm (args) {
  return new Promise<any>((resolve, reject) => execFile(process.execPath, [FARM, ...args], { cwd: ROOT, windowsHide: true, timeout: 15000, maxBuffer: 1024 * 1024 }, (error, stdout, stderr) => {
    if (error) reject(new Error(stderr || stdout || error.message)); else resolve(stdout)
  }))
}
async function disconnected (slot) {
  const { connect }: typeof import('../lib/scene-kit') = require('../lib/scene-kit')
  const conn = connect(`ws://127.0.0.1:${8800 + slot}`)
  let timer
  try {
    await Promise.race([(async () => { await conn.ready; await conn.call('stop'); await conn.call('disconnect', { reason: 'tick benchmark: trial ended' }) })(),
      new Promise<void>((resolve, reject) => { timer = setTimeout(() => reject(new Error('disconnect timeout')), 8000) })])
  } finally { clearTimeout(timer); conn.close() }
}
async function trial (settings, rate, repetition) {
  const tag = `${settings.tag}-r${rate}-n${repetition}`
  const dir = path.join(ROOT, 'farm/results', tag)
  fs.mkdirSync(dir, { recursive: true })
  const runnerLog = path.join(dir, 'runner.log')
  const fd = fs.openSync(runnerLog, 'w')
  const waitSeconds = Math.ceil(rate / 20 * settings.seconds)
  const child = spawn(process.execPath, [FARM, 'run', 'try-tick-clock.js', '--slots', String(settings.slot), '--tick-rate', String(rate), '--tag', tag, `TICK_WAIT_SECONDS=${waitSeconds}`],
    { cwd: ROOT, windowsHide: true, stdio: ['ignore', fd, fd] })
  fs.closeSync(fd)
  let ended = false; let timedOut = false
  const exited = new Promise<any>((resolve, reject) => { child.once('error', reject); child.once('exit', code => { ended = true; resolve(code) }) })
  const queries = []; const started = Date.now(); let runnerExit
  try {
    while (!ended) {
      await Promise.race([exited, delay(2000)])
      if (ended) break
      if (Date.now() - started > 180000 && !timedOut) { timedOut = true; await farm(['kill-runs', tag]) }
      try { queries.push({ at: new Date().toISOString(), ...querySample(await farm(['rcon', String(settings.slot), 'tick query'])) }) } catch (error) { queries.push({ error: error.message }) }
    }
    runnerExit = await exited
  } finally {
    // An unexpected monitor error also tears down this batch's scene, using
    // farm's PID ownership check. Do not start another rate until it has exited.
    if (!ended) { await farm(['kill-runs', tag]); await exited }
    await disconnected(settings.slot)
  }
  const text = fs.readFileSync(runnerLog, 'utf8')
  const matched = /сцена кончилась, код (\d+)/.exec(text)
  const file = path.join(dir, `slot-${settings.slot}.jsonl`)
  const rows = fs.existsSync(file) ? fs.readFileSync(file, 'utf8').split(/\r?\n/).filter(Boolean).map(line => JSON.parse(line)) : []
  return { tag, runnerLog, runnerExit, sceneExit: matched ? Number(matched[1]) : null, timedOut, queries, rows }
}
async function main (settings) {
  if (settings.help) return console.log('node dist/daemon/scenes/infra/try-tick-speed.js --slot N [--rates 100,200,400,800] [--repeats 3] [--seconds 8] [--tag имя]\nСлот уже поднят; результаты farm/results/<tag>.json. Один повтор даёт предварительный результат.')
  const report: Record<string, any> = { at: new Date().toISOString(), settings, policy: { targetReachedRatio: 0.9, maxBotLagTicks: 20, minTrials: 2, selection: 'actual server TPS with completed skills and no bot lag' }, trials: [], rates: [] }
  const file = path.join(ROOT, 'farm/results', `${settings.tag}.json`)
  fs.mkdirSync(path.dirname(file), { recursive: true })
  try {
    for (const rate of settings.rates) {
      const trials = []
      for (let i = 1; i <= settings.repeats; i++) { console.log(`слот ${settings.slot}, запрос ${rate} TPS, повтор ${i}/${settings.repeats}`); trials.push(await trial(settings, rate, i)) }
      report.trials.push(...trials)
      const result = analyze(rate, trials, settings); report.rates.push(result)
      console.log(JSON.stringify(result)); fs.writeFileSync(file, JSON.stringify(report, null, 2))
    }
    const best = report.rates.filter(row => row.stable).sort((a, b) => b.actualServerTPS - a.actualServerTPS)[0]
    report.best = best ? { requestedTPS: best.requestedTPS, actualServerTPS: best.actualServerTPS } : null
    console.table(report.rates.map(({ requestedTPS, actualServerTPS, actualBotTPS, failures, maxLagTicks, querySamples, maxAverageMSPT, maxServerP95MSPT, stable }: any) =>
      ({ requestedTPS, actualServerTPS, actualBotTPS, failures: Object.values<any>(failures).reduce((a, b) => a + b, 0), maxLagTicks, querySamples, maxAverageMSPT, maxServerP95MSPT, stable })))
    console.log(`Максимум по фактическим серверным тикам: ${report.best ? JSON.stringify(report.best) : 'устойчивый rate не подтверждён'}; ${file}`)
  } finally {
    await farm(['tick', String(settings.slot), 'unfreeze']).catch(error => { report.cleanupError = error.message })
    await farm(['tick', String(settings.slot), 'rate', '20']).catch(error => { report.cleanupError = error.message })
    fs.writeFileSync(file, JSON.stringify(report, null, 2))
  }
}
export { options, querySample, analyze }
if (require.main === module) main(options(process.argv.slice(2))).catch(error => { console.error(error.stack); process.exitCode = 1 })
