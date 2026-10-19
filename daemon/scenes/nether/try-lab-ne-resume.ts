import { appendFileSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { basename, join, resolve } from 'node:path'
import { spawn, type ChildProcess } from 'node:child_process'
import { bastionMetrics, explicitBarterMetrics, deliveredBarterReceipts } from '../../src/campaign/nether-progress'
import { requireInheritedResumeBody } from '../lib/scene-nether-resume'
import { REPO_ROOT } from '../../src/paths'

interface ClockSnapshot { tickRate: number; effectiveRate?: number; ticks: number; lagTicks?: number }
interface SceneState {
  health: number; dimension: string; pos?: { x: number; y: number; z: number }
  inventory: Record<string, number>; potions?: Record<string, number>; fireResistance?: boolean; clock?: ClockSnapshot
}
interface RpcResult { state?: SceneState; detail?: { server?: string; state?: { places?: Record<string, unknown> } }; events?: unknown[] }
interface Connection { ready: Promise<void>; call(method: string, params?: Record<string, unknown>): Promise<RpcResult>; close(): void }
interface SceneClock { now(): number; wall: { now(): number; sleep(milliseconds: number): Promise<void> }; sleep(milliseconds: number): Promise<void> }

const slot = Number(process.env.FARM_SLOT)
const ws = process.env.ND_WS ?? ''
const player = process.env.MC_USERNAME ?? ''
if (!(slot >= 1 && slot <= 32) || ws !== `ws://127.0.0.1:${8800 + slot}` || player !== `NeuroFarm${slot}`) {
  throw new Error('resume requires an explicit matching farm slot, WS, and fixture player')
}
if (!process.env.ND_SERVER_LOG) throw new Error('resume requires the existing farm server log')
const minutes = Math.max(1, Math.min(240, Number(process.env.MINUTES) || 120))
const eyes = Math.max(1, Math.min(14, Number(process.env.EYES) || 12))
const until = process.env.UNTIL ?? 'end'
if (!['end', 'pearls', 'rods', 'barter'].includes(until)) throw new Error('UNTIL must be end, pearls, rods, or barter')
const minimumTrades = Math.max(1, Math.min(144, Number(process.env.MIN_TRADES) || 4))
const output = resolve(process.env.LAB_OUT ?? join(REPO_ROOT, 'daemon/lab-ne-resume.jsonl'))
const campaignLog = output.replace(/\.jsonl$/, '') + '-' + new Date().toISOString().slice(11, 19).replace(/:/g, '') + '.campaign.log'
const skillsLog = campaignLog.replace(/\.campaign\.log$/, '.skills.jsonl')
const clock: SceneClock = require('../../src/game-clock')
const connection: Connection = (require('../lib/scene-kit') as typeof import('../lib/scene-kit')).connect(ws)
const call = connection.call
const count = (inventory: Record<string, number>, pattern: RegExp) => Object.entries(inventory)
  .reduce((total, [name, quantity]) => total + (pattern.test(name) ? quantity : 0), 0)
const status = async (): Promise<SceneState> => {
  const result = await call('status')
  if (!result.state) throw new Error('status omitted the actual body state')
  return result.state
}
const skillRows = (): unknown[] => {
  try { return readFileSync(skillsLog, 'utf8').split('\n').flatMap(line => { try { return [JSON.parse(line)] } catch { return [] } }) } catch { return [] }
}

async function main(): Promise<void> {
  await connection.ready
  let child: ChildProcess | undefined
  try {
    await call('connect')
    const connected = await call('status')
    if (connected.detail?.server !== `127.0.0.1:${25600 + slot}`) throw new Error('resume is not connected to the specified farm server')
    await call('stop')
    const initial = await status()
    const recalled = initial.dimension === 'overworld' ? await call('recall', { lines: 1 }) : null
    requireInheritedResumeBody(initial, recalled?.detail?.state?.places?.['портал'])
    if (initial.clock?.tickRate !== 750) throw new Error('resume requires verified requested 750 TPS on this connection')
    const seed = JSON.parse(readFileSync(join(REPO_ROOT, 'farm/slots.json'), 'utf8')).slots[slot].seed as string
    const deathLines: () => string[] = (require('../lib/try-lab-ne-util') as typeof import('../lib/try-lab-ne-util')).deaths(process.env.ND_SERVER_LOG, player, statSync(process.env.ND_SERVER_LOG!).size)
    let extra: Record<string, string> = {}
    if (process.env.CENV) extra = JSON.parse(process.env.CENV)
    writeFileSync(campaignLog, '')
    const started = clock.now(); const wallStarted = clock.wall.now()
    child = spawn(process.execPath, [process.env.CAMPAIGN ?? 'campaign.js', ...(process.env.STAGES ? [process.env.STAGES] : [])], {
      cwd: join(__dirname, '..', '..'), stdio: 'ignore', env: { ...process.env, ...extra, ND_WS: ws, ND_CAMPAIGN_LOG: campaignLog,
        ND_SKILLS_LOG: skillsLog, ND_WORLD_SEED: seed, ND_EYES_NEED: String(eyes), ND_WATCHDOG_MIN: String(minutes + 5) }
    })
    let exited = false; let childError: string | undefined
    child.on('exit', () => { exited = true })
    child.on('error', error => { childError = error.message; exited = true })
    console.log(JSON.stringify({ resume: true, worldState: 'reused', seed, initial, until, eyes, requestedTickRate: 750 }))
    let reached = false; let stoppedBy = 'game time budget'
    let best = { pearls: 0, rodUnits: 0, fireResistancePotions: 0 }
    while (clock.now() - started < minutes * 60000 && clock.wall.now() - wallStarted < 15 * 60000) {
      await Promise.race([clock.sleep(5000), clock.wall.sleep(1000)])
      const state = await status(); const inventory = state.inventory
      const pearls = count(inventory, /^(ender_pearl|ender_eye)$/)
      const rodUnits = count(inventory, /^blaze_rod$/) * 2 + count(inventory, /^(blaze_powder|ender_eye)$/)
      const fireResistancePotions = count(state.potions ?? {}, /fire_resistance$/)
      best = { pearls: Math.max(best.pearls, pearls), rodUnits: Math.max(best.rodUnits, rodUnits),
        fireResistancePotions: Math.max(best.fireResistancePotions, fireResistancePotions) }
      if (deathLines().length || state.health <= 0) { stoppedBy = 'death'; break }
      reached = until === 'end' ? state.dimension === 'the_end'
        : until === 'pearls' ? pearls >= eyes && (fireResistancePotions > 0 || state.fireResistance === true)
          : until === 'barter' ? deliveredBarterReceipts(skillRows()) >= minimumTrades : rodUnits >= eyes
      if (reached) { stoppedBy = until; break }
      if (exited) { stoppedBy = childError ?? `campaign exit ${child.exitCode}`; break }
      if (/БЛОКЕР/.test(readFileSync(campaignLog, 'utf8'))) { stoppedBy = 'campaign watchdog'; break }
    }
    if (!exited) child.kill()
    await call('stop')
    const final = await status(); const deaths = deathLines()
    const text = readFileSync(campaignLog, 'utf8')
    const barters = [...bastionMetrics(text), ...explicitBarterMetrics(skillRows())]
    const result = { at: new Date().toISOString(), resume: true, worldState: 'reused', seed,
      ok: reached && deaths.length === 0 && final.health > 0, until, stoppedBy, minutes: (clock.now() - started) / 60000,
      wallSeconds: (clock.wall.now() - wallStarted) / 1000, deathCount: deaths.length, deaths, initial, final, best,
      ingotsTraded: barters.reduce((total, row) => total + row.ingots, 0), barters, requestedTickRate: 750,
      campaignLog: basename(campaignLog), skillsLog: basename(skillsLog) }
    if (until === 'barter') Object.assign(result, { scope: 'carried gold barter proof', minimumTrades, deliveredBarterReceipts: deliveredBarterReceipts(skillRows()) })
    appendFileSync(output, JSON.stringify(result) + '\n')
    console.log(JSON.stringify(result))
  } finally {
    if (child?.exitCode === null) child.kill()
    try { await Promise.race([call('stop'), clock.wall.sleep(10000)]) } catch {}
    try { await Promise.race([call('disconnect', { reason: 'Nether resume measurement complete' }), clock.wall.sleep(10000)]) } catch {}
    connection.close()
  }
}

main().catch(error => { console.error(error); process.exitCode = 1 })
