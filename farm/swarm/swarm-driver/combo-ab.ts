import * as fs from 'node:fs'
import * as path from 'node:path'
import { REPO_ROOT, DIST_ROOT } from '../../../daemon/src/paths'
import { GameClock } from '../../../daemon/src/game-clock'
import { captureOpeningWire } from './combo-wire'
import { arena, chase, clients, cmd, connect, measure, reset, sleep, stopped, summarize, target } from './combo-ideas'

type Case = 'axe' | 'medic' | 'debuff'
type Actor = { name: string; team: 'own' | 'enemy'; index: number; pose: number[]; hp: number; items: string[]; shield: boolean }
type Round = { case: Case; size: number; pair: number; seed: number; side: number; actors: Actor[]; enhanced: boolean }

export function planRounds(kind: string, size: number, pairs: number): Round[] {
  if (!['axe', 'medic', 'debuff'].includes(kind) || !Number.isInteger(size) || size < 2 || size > 5 ||
      !Number.isInteger(pairs) || pairs < 1 || pairs > 100 || kind === 'medic' && size < 3)
    throw new Error('case axe|medic|debuff, size 2..5 (medic 3..5), pairs 1..100')
  const result: Round[] = []
  for (let pair = 0; pair < pairs; pair++) {
    const side = pair % 2 ? -1 : 1, actors: Actor[] = []
    for (const team of ['own', 'enemy'] as const) for (let index = 0; index < size; index++) {
      const own = team === 'own', items = ['minecraft:diamond_sword', 'minecraft:diamond_axe']
      let x = 600.5 + (index - (size - 1) / 2) * 1.5, z = own ? 603.2 : 600.5 - index * 1.3
      if (kind === 'medic') {
        x = 600.5 + (index === 0 ? 0 : index % 2 ? -.6 * index : .6 * (index - 1))
        z = own ? index === 0 ? 607.5 : 604.5 : 596.5 - index
      }
      if (kind === 'debuff') { x = 600.5 + (index === 0 ? 0 : index % 2 ? -index * 1.5 : index * 1.5); z = own ? index === 0 ? 606.5 : 609.5 : 600.5 - index * 1.5 }
      if (own && index === 0 && kind !== 'axe') items.push(`minecraft:splash_potion[potion_contents={potion:"minecraft:${kind === 'medic' ? 'strong_healing' : 'weakness'}"}]`)
      actors.push({ name: `NeuroFarm28${own ? 'b' : 'r'}${index}`, team, index, pose: [600.5 + side * (x - 600.5), 603.5 + side * (z - 603.5)],
        hp: kind === 'medic' && own && (index === 1 || index === 2) ? 8 : 20, items, shield: kind === 'axe' && !own && index === 0 })
    }
    for (const enhanced of pair % 2 ? [true, false] : [false, true]) result.push({ case: kind as Case, size, pair, seed: 280126 + pair, side, actors, enhanced })
  }
  return result
}

/** Only public equipment and hand-use metadata; never target health. */
export function shieldRaised(bot: any, foe: any) {
  const key = bot.registry?.entitiesByName?.player?.metadataKeys?.indexOf('living_entity_flags') ?? -1
  return key >= 0 && (foe?.metadata?.[key] & 3) === 3 && foe.equipment?.[1]?.name === 'shield'
}

export function teamLifeStop(bots: any[], controls: { aborted: boolean }[], size: number) {
  const halt = (i: number) => { controls[i].aborted = true; bots[i].clearControlStates(); bots[i].deactivateItem() }
  const guard = { first: null as number | null, ended: false, winner: null as 'own' | 'enemy' | null, fallen: new Set<number>(),
    alive: [bots.slice(0, size).map(b => b.username), bots.slice(size).map(b => b.username)],
    stop() { guard.ended = true; bots.forEach((_, i) => halt(i)) },
    close() { bots.forEach((b, i) => b.removeListener('death', deaths[i])) } }
  const deaths = bots.map((b, i) => {
    const fn = () => {
      if (guard.fallen.has(i)) return
      guard.fallen.add(i); halt(i)
      if (guard.first === null) guard.first = i
      const team = guard.alive[i < size ? 0 : 1]
      team.splice(team.indexOf(b.username), 1)
      if (!team.length) { guard.winner = i < size ? 'enemy' : 'own'; guard.stop() }
    }
    b.on('death', fn); return fn
  })
  return guard
}

/** Unknown or multiple causes stay unknown rather than being credited as friendly damage. */
export function damageSources(bot: any, allies: number[]) {
  const result = { friendlyDamage: 0, hostileDamage: 0, unknownDamage: 0, friendlyEvents: 0, hostileEvents: 0 }
  let last = bot.health, ended = false, causes: number[] = [], causeAt = 0
  const packet = (pk: any) => {
    if (ended || pk.entityId !== bot.entity?.id) return
    const source = pk.sourceCauseId - 1
    causes.push(source)
    causeAt = Date.now()
    if (allies.includes(source)) result.friendlyEvents++
    else if (source >= 0) result.hostileEvents++
  }
  const update = (hp: number) => {
    if (ended) return
    const loss = Math.max(0, last - hp), source = causes.length === 1 && Date.now() - causeAt <= 150 ? causes[0] : -1
    if (loss) {
      if (allies.includes(source)) result.friendlyDamage += loss
      else if (source >= 0) result.hostileDamage += loss
      else result.unknownDamage += loss
      causes = []
    }
    last = hp
  }
  const health = () => update(bot.health)
  const death = () => { if (ended) return; update(0); ended = true; causes = [] }
  bot._client.on('damage_event', packet); bot.on('health', health); bot.on('death', death)
  return () => { bot._client.removeListener('damage_event', packet); bot.removeListener('health', health); bot.removeListener('death', death); return result }
}

export function pairedSummary(rows: any[]) {
  const groups: any[] = []
  for (const key of new Set(rows.map(r => `${r.case}/${r.size}`))) {
    const selected = rows.filter(r => `${r.case}/${r.size}` === key), pairs: any[][] = []
    for (const pair of new Set(selected.map(r => r.pair))) {
      const match = selected.filter(r => r.pair === pair)
      if (match.length === 2 && match.some(r => r.enhanced) && match.some(r => !r.enhanced)) pairs.push(match)
    }
    if (!pairs.length) continue
    const mean = (enhanced: boolean, field: string) => pairs.reduce((n, p) => n + (p.find(r => r.enhanced === enhanced)[field] || 0), 0) / pairs.length
    groups.push({ case: selected[0].case, size: selected[0].size, pairs: pairs.length,
      control: summarize(pairs.map(p => p.find(r => !r.enhanced))), enhanced: summarize(pairs.map(p => p.find(r => r.enhanced))),
      delta: Object.fromEntries(['damage', 'kills', 'ownDeaths', 'friendlyDamage', 'unknownDamage', 'healed', 'consumed'].map(k => [k, mean(true, k) - mean(false, k)])) })
  }
  return groups
}

const potionCount = (bot: any) => bot.inventory.items().filter(i => i.name === 'splash_potion').reduce((n, i) => n + i.count, 0)

export async function fixtureHealth(bot: any, hp: number, send: (command: string) => Promise<any> = cmd) {
  if (hp === 20) return
  // A recently respawned player can ignore /damage; clamp and heal without spending that immunity.
  try {
    await send(`attribute ${bot.username} minecraft:max_health base set ${hp}`)
    await send(`effect give ${bot.username} minecraft:instant_health 1 10 true`)
    for (let i = 0; i < 20 && bot.health !== hp; i++) await sleep(50)
    if (bot.health !== hp) throw new Error(`${bot.username} fixture HP ${bot.health}, expected ${hp}`)
  } finally {
    try { await send(`effect clear ${bot.username} minecraft:instant_health`) }
    finally { await send(`attribute ${bot.username} minecraft:max_health base set 20`) }
  }
}

export function damageTotals(receipts: any[], attributed: any[], size: number) {
  const sum = (rows: any[], key: string) => rows.reduce((n, r) => n + r[key], 0)
  return { damage: sum(attributed.slice(size), 'hostileDamage'), rawEnemyDamage: sum(receipts.slice(size), 'damage'),
    enemyFriendlyDamage: sum(attributed.slice(size), 'friendlyDamage'), enemyUnknownDamage: sum(attributed.slice(size), 'unknownDamage'),
    friendlyDamage: sum(attributed.slice(0, size), 'friendlyDamage'), unknownDamage: sum(attributed.slice(0, size), 'unknownDamage') }
}

export async function settleFixtureTeleport(bots: any[]) {
  // Paper can discard the first move after /tp; a dry hop settles it before either measured arm.
  bots.forEach(bot => bot.setControlState('jump', true))
  try { await Promise.all(bots.map(bot => bot.waitForTicks(1))) }
  finally { bots.forEach(bot => bot.setControlState('jump', false)) }
  if (bots.some(bot => bot.entity.onGround)) throw new Error('fixture hop did not lift')
  for (let tick = 0; tick < 40; tick++) {
    if (stopped()) throw new Error('AUTO-STOP')
    if (bots.every(bot => bot.entity.onGround)) return
    await Promise.all(bots.map(bot => bot.waitForTicks(1)))
  }
  throw new Error('fixture hop did not land')
}

async function fixture(round: Round, bots: any[]) {
  await reset(bots, round.actors.map(a => a.pose))
  await cmd(`random reset * ${round.seed}`)
  for (let i = 0; i < bots.length; i++) {
    const bot = bots[i], actor = round.actors[i]
    await cmd(`spawnpoint ${bot.username} 650 151 650`)
    await cmd(`tp ${bot.username} ${actor.pose[0].toFixed(3)} 151.0 ${actor.pose[1].toFixed(3)}`)
    bot._ndSwarmAllies = round.actors.filter(a => a.team === actor.team && a.name !== actor.name).map(a => a.name)
    // reset already gives both weapons; identical consumables remain unused in the sham arm.
    for (const item of actor.items.slice(2)) await cmd(`give ${bot.username} ${item}`)
    if (actor.shield) await cmd(`item replace entity ${bot.username} weapon.offhand with minecraft:shield`)
    await fixtureHealth(bot, actor.hp)
    const sword = bot.inventory.items().find(i => i.name === 'diamond_sword')
    if (sword) await bot.equip(sword, 'hand')
  }
  await sleep(round.case === 'axe' ? 5200 : 1000)
  await settleFixtureTeleport(bots)
  for (let i = 0; i < bots.length; i++) {
    if (bots[i].health !== round.actors[i].hp) throw new Error(`${bots[i].username} fixture HP ${bots[i].health}, expected ${round.actors[i].hp}`)
    await bots[i].lookAt(bots[i < round.size ? round.size : 0].entity.position.offset(0, 1.5, 0), true)
    if (round.actors[i].shield) bots[i].activateItem(true)
  }
  await sleep(400)
  if (round.case === 'axe' && !shieldRaised(bots[0], target(bots[0], bots[round.size].username))) throw new Error('native shield not raised')
}

async function trial(round: Round, bots: any[]) {
  const { strike, splashMedic, debuffOpening } = require(path.join(DIST_ROOT, 'daemon/src/swarm/combos/ideas'))
  const { ticksToCharge } = require(path.join(DIST_ROOT, 'daemon/src/pvp/damage-model'))
  const wire = captureOpeningWire(bots[0])
  try { await fixture(round, bots) }
  catch (e) { wire.close(); throw e }
  if (round.case === 'axe') wire.close()
  const own = bots.slice(0, round.size), enemy = bots.slice(round.size), ctl = bots.map(() => ({ aborted: false }))
  const guard = teamLifeStop(bots, ctl, round.size), finish = bots.map(measure), sources = bots.map((b, i) => damageSources(b,
    bots.filter((_, j) => round.actors[j].team === round.actors[i].team && j !== i).map(b => b.entity.id)))
  const counts = bots.map(potionCount), t0 = Date.now(), events: any[] = [], tasks: Promise<any>[] = [], attacks = bots.map(() => ({ sent: 0, refused: {} as Record<string, number> }))
  const start = bots.map(b => ({ name: b.username, hp: b.health, position: { x: b.entity.position.x, y: b.entity.position.y, z: b.entity.position.z }, yaw: b.entity.yaw,
    items: b.inventory.items().map(i => ({ name: i.name, count: i.count })), offhand: b.inventory.slots[45]?.name || null }))
  const shieldCooldown = (pk: any) => {
    if (String(pk.cooldownGroup).replace(/^minecraft:/, '') === 'shield' && pk.cooldownTicks > 0)
      events.push({ kind: 'shield_disable', atMs: Date.now() - t0, ticks: pk.cooldownTicks, target: enemy[0].username })
  }
  if (round.case === 'axe') enemy[0]._client.on('set_cooldown', shieldCooldown)
  let effects: any[] = [], openingWire = wire.rows, consumed = 0
  const addRefusal = (i: number, why: string) => { attacks[i].refused[why] = (attacks[i].refused[why] || 0) + 1 }
  try {
    if (round.case !== 'axe') {
      const opening = Date.now()
      try {
        if (round.enhanced) {
          const result = round.case === 'medic' ? await splashMedic(own[0], own.slice(1).map(b => ({ ...target(own[0], b.username), health: b.health })),
            enemy.map(b => target(own[0], b.username)), { ctl: ctl[0] }) :
            await debuffOpening(own[0], target(own[0], enemy[0].username), { kind: 'weakness', allies: own.slice(1).map(b => target(own[0], b.username)), ctl: ctl[0] })
          events.push({ atMs: Date.now() - t0, kind: round.case, ...result })
          if (!result.thrown) addRefusal(0, result.why)
          if (result.thrown) await sleep(Math.ceil(result.ticks || 20) * 50 + 300)
        }
        // Both arms reserve the same support opening; nobody enters the splash during its flight.
        await sleep(Math.max(0, 1800 - (Date.now() - opening)))
        for (const bot of bots) effects.push({ name: bot.username, effects: await cmd(`data get entity ${bot.username} active_effects`) })
      } finally { wire.close() }
    }
    // Only the support opening consumes potions; later death drops are never consumption.
    consumed = counts.slice(0, round.size).reduce((n, count, i) => n + Math.max(0, count - potionCount(bots[i])), 0)
    const fight0 = Date.now()
    for (let i = 0; i < bots.length; i++) {
      const bot = bots[i], actor = round.actors[i], names = guard.alive[actor.team === 'own' ? 1 : 0]
      const movement = async () => {
        if (actor.shield) while (!ctl[i].aborted && !stopped() && Date.now() - fight0 < 3500) {
          const e = target(bot, names[0])
          if (e) await bot.lookAt(e.position.offset(0, 1.5, 0), true)
          bot.activateItem(true); await sleep(100)
        }
        if (!ctl[i].aborted) await chase(bot, names, ctl[i])
      }
      tasks.push(movement())
      tasks.push((async () => {
        while (!ctl[i].aborted && !stopped() && bot.health > 0) {
          if (actor.shield && Date.now() - fight0 < 3500) { await sleep(100); continue }
          const candidates = names.map(name => target(bot, name)).filter(e => e?.position && e.isValid !== false)
          const foe = candidates.sort((a, b) => a.position.distanceTo(bot.entity.position) - b.position.distanceTo(bot.entity.position))[0]
          if (!foe) { await sleep(50); continue }
          const axe = round.enhanced && round.case === 'axe' && i === 0 && shieldRaised(bot, foe)
          const weapon = axe ? 'diamond_axe' : 'diamond_sword'
          const r = await strike(bot, foe, { weapon, ctl: ctl[i] })
          if (r.sent) { attacks[i].sent++; if (axe) events.push({ kind: 'axe_attempt', atMs: Date.now() - t0, target: foe.username }) }
          else addRefusal(i, r.why)
          await sleep(ticksToCharge(weapon) * 50)
        }
      })())
    }
    while (!guard.ended && !stopped() && Date.now() - t0 < 12000) await sleep(50)
  } finally {
    guard.stop(); await Promise.allSettled(tasks); guard.close()
    if (round.case === 'axe') enemy[0]._client.removeListener('set_cooldown', shieldCooldown)
  }
  await sleep(100)
  const receipts = finish.map(f => f()), attributed = sources.map(f => f()), enemies = receipts.slice(round.size), ours = receipts.slice(0, round.size)
  const kills = enemies.reduce((n, r) => n + r.deaths, 0), ttk = enemies.map(r => r.ttkMs).filter(Number.isFinite)
  return { ...round, actors: round.actors, fixtureSettled: 'dry-hop-before-measurement', targetPolicy: 'nearest-valid-entity-for-movement-and-attack', elapsedMs: Date.now() - t0, firstDeath: guard.first, winner: guard.winner,
    endedBy: guard.winner ? 'teamwipe' : stopped() ? 'AUTO-STOP' : 'deadline', fallen: [...guard.fallen],
    ...damageTotals(receipts, attributed, round.size), kills, ownDeaths: ours.reduce((n, r) => n + r.deaths, 0),
    ttkMs: ttk.length ? Math.min(...ttk) : null, success: kills > 0, activations: events.filter(e => e.kind === 'shield_disable' || e.thrown).length,
    healed: ours.reduce((n, r) => n + r.healing, 0), enemyHealing: enemies.reduce((n, r) => n + r.healing, 0),
    consumed,
    start, events, attacks, receipts, attributed, effects, openingWire }
}

async function main() {
  const kind = process.argv[2] || 'all', size = Number(process.argv[3] || 3), pairs = Number(process.argv[4] || 4)
  const cases = kind === 'all' ? ['axe', 'medic', 'debuff'] : [kind]
  const plan = cases.flatMap(k => planRounds(k, size, pairs)), rows: any[] = []
  const out = path.join(REPO_ROOT, 'farm/results/ideas-28', `combo-ab-${kind}-${size}-${new Date().toISOString().replace(/[:.]/g, '-')}.jsonl`)
  if (stopped()) throw new Error('AUTO-STOP')
  fs.mkdirSync(path.dirname(out), { recursive: true })
  console.log('RESULTS', out)
  try {
    await arena(); await cmd('fill 597 151 599 604 153 599 minecraft:air')
    // Native respawns stay outside the fight; no deferred parking command can race the next reset.
    for (const command of ['forceload add 640 640 672 672', 'fill 650 150 650 660 150 660 minecraft:stone',
      'fill 650 151 650 660 157 660 minecraft:air', 'setworldspawn 650 151 650', 'gamerule respawn_radius 0']) await cmd(command)
    const bots = []
    for (const actor of plan[0].actors) bots.push(await connect(actor.name, new GameClock()))
    for (const round of plan) {
      if (stopped()) throw new Error('AUTO-STOP')
      const row = await trial(round, bots)
      rows.push(row); fs.appendFileSync(out, JSON.stringify(row) + '\n'); console.log(JSON.stringify(row))
    }
  } finally {
    for (const bot of clients) { bot.clearControlStates(); bot.deactivateItem(); bot.quit('combo A/B complete') }
    fs.writeFileSync(out.replace(/\.jsonl$/, '.summary.json'), JSON.stringify(pairedSummary(rows), null, 2) + '\n')
    await sleep(500)
  }
}

if (require.main === module) main().then(() => process.exit(0), e => { console.error(e); process.exit(1) })
