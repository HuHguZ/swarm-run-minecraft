// Stress stand for the REAL TacticalSystem (arbiter, graph, escape progress, reflex-lock leases, skill interruption,
// release/replan) in the abstract world of sim-world.ts. Only observation and action effects are simulated.
import { EventEmitter } from 'node:events'
import { TacticalSystem } from './minecraft'
import { candidates, outpaced, type ActionId, type Candidate, type TacticalState } from './state'
import { createWorld, observeWorld, stepAction, stepWorld, threatTruth, type ActionRun, type Scenario, type SimWorld } from './sim-world'
import { mineflayerFacade } from './sim-mineflayer'
import { observeTactics } from './minecraft'

const clock = require('../game-clock')
const locks = require('../reflex-lock')
const { Vec3 } = require('vec3')

export interface Violation { kind: string; tick: number; detail: string }
export interface SimResult {
  scenario: string; died: string | null; hp: number; ticks: number; violations: Violation[]; selections: Array<{ tick: number; action: string; level: number; options?: number; result?: string; swoop?: boolean }>
  skillRestarts: number; skillProgress: number; replanRevision: number; rows: Array<Record<string, unknown>>; log: string[]
}
interface Run extends ActionRun { ctl: { aborted: boolean; onAbort: Array<() => void> }; resolve(value: unknown): void; reject(error: unknown): void }
type Policy = (state: TacticalState, current: ActionId | null) => ActionId | null

const flush = () => new Promise<void>(resolve => setImmediate(resolve))
export const FLAP_TICKS = 40
const INTERLUDES = new Set(['FreeEmbedded', 'Surface', 'Dodge', 'UseWater', 'UseFireResistance', 'PearlEscape', 'FlightEscape', 'ClimbOut', 'WebBoatEscape', 'BoatLavaHop'])

function fakeBot(world: SimWorld) {
  const bot: any = new EventEmitter()
  bot.setMaxListeners(0)
  bot.entity = { id: 1, position: new Vec3(0, 64, 0), onGround: true, effects: {}, metadata: [] }
  bot.health = world.body.hp; bot.food = world.body.food
  bot.game = { dimension: world.spec.nether ? 'the_nether' : 'overworld', gameMode: 'survival' }
  bot.inventory = { slots: [], items: () => [] }
  bot.pathfinder = { setGoal() {}, setMovements() {}, stop() {} }
  bot.clearControlStates = () => {}; bot.stopDigging = () => {}; bot.deactivateItem = () => {}
  bot.blockAt = (p: any) => ({ name: 'stone', position: p, boundingBox: 'block' })
  return bot
}

function stepRuns(world: SimWorld, runs: Run[]): void {
  for (const run of [...runs]) {
    if (run.ctl.aborted) { runs.splice(runs.indexOf(run), 1); continue }
    try {
      const result = stepAction(world, run)
      if (result) { runs.splice(runs.indexOf(run), 1); run.resolve(result) }
    } catch (error) { runs.splice(runs.indexOf(run), 1); run.reject(error) }
  }
}

// observe 'mirror': observeWorld (fast, the decision logic); 'minecraft': the real observeTactics over a mineflayer facade.
export async function runSystem(scenario: Scenario, { observe = 'mirror' }: { observe?: 'mirror' | 'minecraft' } = {}): Promise<SimResult> {
  const world = createWorld(scenario)
  const timer = clock.activate(new clock.GameClock({ manual: true, epoch: 0 }))
  const session: any = {}
  const facade = observe === 'minecraft' ? mineflayerFacade(world, session) : null
  const bot = facade?.bot ?? fakeBot(world)
  const violations: Violation[] = []
  const selections: SimResult['selections'] = []
  const rows: Array<Record<string, unknown>> = []
  const runs: Run[] = []
  const flag = (kind: string, detail: string) => { if (!violations.some(v => v.kind === kind)) violations.push({ kind, tick: world.tick, detail }) }
  Object.assign(session, { bot, current: null, reflex: null, replanRevision: 0, bus: { emit(name: string, payload: any) {
    if (name === 'tactical_selected') selections.push({ tick: world.tick, action: payload.action, level: payload.threatLevel,
      options: new Set((payload.candidates ?? []).map((candidate: Candidate) => candidate.id === 'CreateDistance' ? 'Flee' : candidate.id)).size,
      swoop: /^(Fight|LastStand)$/.test(payload.action) && !!session.tactics?.snapshot().state && outpaced(session.tactics.snapshot().state) })
    if (name === 'tactical_finished') { const open = [...selections].reverse().find(s => s.action === payload.action && !s.result); if (open) open.result = payload.detail?.killed ? 'killed' : payload.result }
    world.log.push(`${world.tick} ${name} ${payload?.action ?? payload?.reason ?? ''}`)
    return payload
  } } })
  // A long skill the tactics must pause, interrupt and give back. Raw body calls (behind the reflex-lock wrappers that
  // install() puts on the bot at attach) must never run while a tactical lease owns the body; a craft interrupted by a
  // lease must be finished locally without duplicate or lost items (reflex-lock REFLEX_RETRY).
  let progress = 0, restarts = 0
  const leak = (what: string) => { if (locks.owner(session)) flag('skill-during-lease', `skill ${what} reached the body under ${locks.owner(session).source}`) }
  const skill: 'mine' | 'walk' | 'craft' = typeof scenario.skill === 'string' ? scenario.skill : 'mine'
  bot.dig = async () => { leak('dig'); await clock.sleep(250); progress++ }
  bot.setControlState = (key: string, on: boolean) => { if (on) leak(`setControlState ${key}`) }
  bot.pathfinder.goto = async () => { for (let step = 0; step < 10; step++) { bot.setControlState('forward', true); await clock.sleep(50) } progress++ }
  const crafted = { type: 280, name: 'stick', count: 0, metadata: null }
  const baseItems = bot.inventory.items
  bot.inventory.items = () => crafted.count ? [...baseItems(), crafted] : baseItems()
  bot.entities ??= {}
  bot.clickWindow = async () => { leak('clickWindow'); await clock.sleep(100) }
  bot.craft = async (recipe: { result: { id: number; count: number } }, count: number) => {
    for (let i = 0; i < count; i++) { await bot.clickWindow(0, 0, 0); crafted.count += recipe.result.count }
  }
  const work: Record<string, () => Promise<void>> = {
    mine: () => bot.dig({ position: new Vec3(1, 63, 0) }),
    walk: () => bot.pathfinder.goto({}),
    craft: async () => {
      const before = crafted.count
      await bot.craft({ result: { id: 280, count: 1 } }, 4, null)
      if (crafted.count - before !== 4) flag('craft-count', `crafted ${crafted.count - before} of 4 across an interruption`)
      progress++
    }
  }
  const startSkill = () => {
    const ctl: any = { aborted: false, onAbort: [], abort() { if (!this.aborted) { this.aborted = true; for (const f of [...this.onAbort]) f() } } }
    session.current = { name: skill, ctl }
    void locks.run(session, ctl, async () => { while (!ctl.aborted) await work[skill]() })
      .catch(() => {}).finally(() => { if (session.current?.ctl === ctl) session.current = null })
  }
  const system = new TacticalSystem(session, {
    observe: () => facade ? (facade.sync(), observeTactics(session)) : observeWorld(world, session),
    record: row => { rows.push(row) },
    execute: (action: Candidate, ctl: Run['ctl']) => new Promise((resolve, reject) => {
      const run: Run = { id: action.id, started: world.tick, data: {}, ctl, resolve, reject }
      runs.push(run)
      ctl.onAbort.push(() => resolve({ cancelled: true }))
    })
  })
  // As in the daemon: ne-guard and the autopilot defer to the tactics only when the session carries them.
  session.tactics = system
  const original = process.env.ND_TACTICS
  delete process.env.ND_TACTICS
  let level4Since: number | null = null, lastLevel4 = -Infinity
  let incidentRevision: number | null = null, calmSince: number | null = null
  try {
    system.attach(bot)
    if (scenario.skill !== false) startSkill()
    const ticks = scenario.ticks ?? 600
    while (world.tick < ticks && world.body.hp > 0 && !world.body.escaped) {
      const hp = world.body.hp
      stepRuns(world, runs)
      stepWorld(world)
      if (facade) facade.sync()
      else { bot.health = world.body.hp; bot.food = world.body.food; bot.entity.position = new Vec3(world.body.x, 64, world.body.z) }
      timer.advanceTicks(1)
      if (world.body.hp !== hp) bot.emit('health')
      bot.emit('physicsTick')
      await flush()
      // invariants
      const live = runs.filter(run => !run.ctl.aborted)
      if (live.length > 1) flag('two-owners', live.map(run => run.id).join('+'))
      // A strike that killed hands over to the next foe (cave spiders one by one): not a flap of choices.
      const recent = selections.filter(s => world.tick - s.tick < 20 && s.result !== 'killed')
      if (recent.length > 4) flag('flapping', recent.map(s => s.action).join('>'))
      // A level-4 sample or a fall between the two runs of A is an interlude too: the place changed.
      if (system.snapshot().threatLevel === 4 || world.body.falling) lastLevel4 = world.tick
      const [a, b, c] = selections.slice(-3)
      // Dithering at one threat level: A>B>A within FLAP_TICKS (farm 06.10, slot 30: Fight/LastStand in turns every 150 ms
      // for 2 s; the old 12-tick window missed a 1-2 s swing). An urgent interlude (Eat > UseWater on fire > Eat) is a resume.
      // A rescue between two runs of one action (FreeEmbedded, water on fire...) or repeated for a new cause (a second fire), a
      // fallback after B failed, a strike that killed, or one at the swoop of a flyer no run shakes (state.outpaced) is a resume.
      if (c?.tick === world.tick && c.tick - a.tick < FLAP_TICKS && a.action === c.action && a.action !== b.action && a.level === b.level && b.level === c.level &&
        !INTERLUDES.has(b.action) && !INTERLUDES.has(a.action) && b.result !== 'failed' && b.result !== 'killed' && !a.swoop && !b.swoop && !(lastLevel4 > a.tick)) flag('flapping', `${a.action}>${b.action}>${c.action} in ${c.tick - a.tick} ticks`)
      const last = selections[selections.length - 1]
      if (last?.tick === world.tick && last.action === 'Fight' && world.body.hp <= 6 && !(world.body.inLava && world.body.fireRes > 0)) flag('fight-low-hp', `hp ${world.body.hp.toFixed(1)}`)
      if (last?.tick === world.tick && last.level >= 2) incidentRevision = session.replanRevision
      const calm = !session.reflex && !live.length && system.snapshot().threatLevel === 0
      calmSince = calm ? calmSince ?? world.tick : null
      // A death ends the incident without a replan (the selection and the fatal landing share a tick: stage B fall deaths).
      if (incidentRevision !== null && calmSince !== null && world.tick - calmSince > 40 && world.body.hp > 0) {
        if (session.replanRevision === incidentRevision) flag('no-replan', 'calm for 2 s after an incident without replanRevision++')
        incidentRevision = null
      }
      const same = selections.filter(s => s.action === last?.action && world.tick - s.tick < 400)
      // Shield is a bounded hold that is meant to repeat while an archer aims; a strike per swoop of a circling phantom is
      // the answer, not a loop (strikes that do nothing are cooled down by the TacticalSystem itself); a meal cut by each
      // swoop is retried by design.
      // A forced repeat (the only candidate: fists and no blocks against a husk and a phantom) is a hopeless spot, not a loop.
      if (last?.tick === world.tick && !['Shield', 'Fight', 'LastStand', 'Eat'].includes(last.action) && (last.options ?? 2) > 1 && same.length >= 5) flag('cycle', `${last.action} selected ${same.length} times in 20 s`)
      const truth = threatTruth(world)
      // While falling the clutch controller owns the body by design (arbiter: dangerousFall selects nothing).
      if (truth.level4 && !live.length && !world.body.falling) {
        level4Since ??= world.tick
        if (world.tick - level4Since > 8) flag('level4-unhandled', truth.why)
      } else level4Since = null
      if (scenario.skill !== false && !session.current && !session.reflex && (system.snapshot().threatLevel ?? 0) < 2 && world.body.hp > 0) {
        restarts++
        system.observed()
        startSkill()
      }
    }
  } finally {
    system.detach()
    session.current?.ctl.abort()
    for (const run of runs.splice(0)) run.resolve({ cancelled: true })
    await flush()
    timer.dispose(); clock.activate(null)
    if (original === undefined) delete process.env.ND_TACTICS; else process.env.ND_TACTICS = original
  }
  return { scenario: scenario.name, died: world.died, hp: world.body.hp, ticks: world.tick, violations, selections, skillRestarts: restarts,
    skillProgress: progress, replanRevision: session.replanRevision, rows, log: world.log }
}

// A scripted controller over the same world: "could anything simple have survived?"
export function runPolicy(scenario: Scenario, policy: Policy): { died: string | null; hp: number } {
  const world = createWorld(scenario)
  const runs: Run[] = []
  const ticks = scenario.ticks ?? 600
  let current: Run | null = null
  while (world.tick < ticks && world.body.hp > 0 && !world.body.escaped) {
    if (world.tick % 3 === 0) {
      const state = observeWorld(world)
      const choice: ActionId | null = state ? policy(state, current && runs.includes(current) ? current.id : null) : null
      if (current && (!runs.includes(current) || choice !== current.id)) { current.ctl.aborted = true; current = null }
      if (choice && !current) {
        current = { id: choice, started: world.tick, data: {}, ctl: { aborted: false, onAbort: [] }, resolve() {}, reject() {} }
        runs.push(current)
      }
    }
    stepRuns(world, runs)
    stepWorld(world)
  }
  return { died: world.died, hp: world.body.hp }
}

const RESCUE: ActionId[] = ['FreeEmbedded', 'Surface', 'Dodge', 'PearlEscape', 'FlightEscape', 'UseFireResistance', 'ClimbOut', 'UseWater']
export const POLICIES: Record<string, Policy> = {
  idle: () => null,
  flee: preference([...RESCUE, 'Flee', 'CreateDistance']),
  shelter: preference([...RESCUE, 'Hide', 'BlockOff', 'PillarUp', 'DigDown', 'Heal', 'Flee', 'CreateDistance']),
  fight: preference([...RESCUE, 'LastStand', 'Fight', 'Flee', 'CreateDistance']),
  portal: preference([...RESCUE, 'EnterPortal', 'Flee'])
}
function preference(order: ActionId[]): Policy {
  return (state, current) => {
    const available = new Set(candidates(state).map(candidate => candidate.id))
    if (current && available.has(current) && !RESCUE.some(id => id !== current && available.has(id) && order.indexOf(id) < order.indexOf(current))) return current
    return order.find(id => available.has(id)) ?? null
  }
}

export function survivors(scenario: Scenario): string[] {
  return Object.entries(POLICIES).filter(([, policy]) => !runPolicy(scenario, policy).died).map(([name]) => name)
}

export async function check(scenario: Scenario, options: Parameters<typeof runSystem>[1] = {}): Promise<SimResult> {
  const result = await runSystem(scenario, options)
  if (result.died) {
    const alive = survivors(scenario)
    if (alive.length) result.violations.push({ kind: 'death', tick: result.ticks, detail: `${result.died}; survived by: ${alive.join(', ')}` })
  }
  return result
}
