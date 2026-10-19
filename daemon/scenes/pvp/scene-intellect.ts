'use strict'
import * as gameClock from '../../src/game-clock'
import path = require('node:path')
import * as fs from 'node:fs'
import { createGameBot, connect, createKit } from '../lib/scene-kit'
import { pathfinder, Movements } from 'mineflayer-pathfinder'
import sky = require('../../src/elytra')
import * as projectiles from '../../src/throw'
import { duel } from '../../src/pvp'
const Vec3: typeof import('vec3').Vec3 = require('vec3')
import { INTELLECT_ARENA, buildArena, terrainHeight } from '../../arena/arena-builder'

async function main() {
  const mode = process.env.INTELLECT_MODE ?? process.argv[2] ?? 'duel'
  if (!['arena', 'duel', 'air', 'pearl', 'height'].includes(mode)) throw new Error('mode: arena | duel | air | pearl | height')
  const rounds = Math.max(1, Math.min(5, Number(process.env.INTELLECT_ROUNDS ?? process.argv[3] ?? 1)))
  const url = process.env.ND_WS ?? 'ws://127.0.0.1:8831'
  const port = Number(process.env.MC_PORT ?? process.env.ND_MC_PORT ?? 25631)
  const logFile = process.env.ND_SERVER_LOG
  if (url !== 'ws://127.0.0.1:8831' || port !== 25631 || !logFile || !fs.existsSync(logFile)) throw new Error('scene requires isolated farm slot 31 and ND_SERVER_LOG for command witnesses')
  const player = 'NeuroFarm31'
  const opponent = 'NeuroAir31'
  const rpc = connect(url)
  let followedClock: any = null
  const clockBound = (clock: any) => { followedClock = clock }
  gameClock.changes.on('bound', clockBound)
  let partner: any = null
  const partnerSession: any = { bot: null, eating: false }
  let ctl: any = null
  let arena = { ...INTELLECT_ARENA }
  const outcomes: any[] = []
  const observed = { flightTicks: 0, airDamage: 0, pearls: 0, offhandUses: 0 }
  const sleep = (ms: number) => gameClock.sleep(ms)
  try {
    await rpc.ready
    await rpc.call('connect')
    await rpc.call('stop')
    await rpc.call('temper', { enabled: false })
    const kit = createKit({ call: rpc.call, heard: rpc.heard, player, logFile })
    const cmd = async (text: string) => { const reply = await kit.cmd(text); if (!reply.ok) throw new Error('fixture command not witnessed: ' + text) }
    await kit.gamerule('keep_inventory', false)
    await kit.gamerule('spawn_mobs', false)
    partner = createGameBot({ host: '127.0.0.1', port, username: opponent, auth: 'offline', version: '1.21.11' })
    partnerSession.bot = partner
    await new Promise<void>((resolve, reject) => { partner.once('spawn', resolve); partner.once('error', reject); partner.once('kicked', reason => reject(new Error(String(reason)))) })
    partner.loadPlugin(pathfinder)
    partner.pathfinder.setMovements(new Movements(partner))
    ;(require('../../src/pick') as typeof import('../../src/pick')).install(partner)
    ;(require('../../src/melee') as typeof import('../../src/melee')).install(partner)
    ;(require('../../src/mace') as typeof import('../../src/mace')).install(partner)
    sky.install(partner)
    const savedArena = path.join(path.dirname(path.dirname(logFile)), 'intellect-arena.json')
    const saved = fs.existsSync(savedArena) ? JSON.parse(fs.readFileSync(savedArena, 'utf8')) : null
    let plan
    if (mode === 'arena' || process.env.INTELLECT_REBUILD === '1' || !saved?.ready) {
      await cmd(`/gamemode spectator ${opponent}`)
      await cmd(`/gamemode spectator ${player}`)
      await kit.forceload('overworld', [[2920, 64, 2830], [3080, 200, 2970]])
      await cmd(`/tp ${opponent} 3000.5 180 2900.5 0 0`)
      await partner.waitForChunksToLoad()
      plan = await buildArena(kit, logFile, saved?.ground ?? await terrainHeight(partner, kit, opponent))
    } else plan = saved
    arena = plan.arena
    if (mode === 'arena') {
      const p = plan.watch
      await cmd(`/tp ${player} ${p.x} ${p.y} ${p.z} ${p.yaw} ${p.pitch}`)
      console.log('INTELLECT_VIEW', JSON.stringify({ arena, interior: p, exterior: plan.exterior, viewer: 'http://127.0.0.1:3131' }))
      return
    }
    partner.on('physicsTick', () => { if (partner.entity?.elytraFlying) observed.flightTicks++ })
    partner.on('entityHurt', entity => { if (entity?.type === 'player' && sky.gliding(entity)) observed.airDamage++ })
    partner.on('entitySpawn', entity => { if (/ender_pearl/.test(entity?.name ?? '')) observed.pearls++ })
    const rawWrite = partner._client.write
    partner._client.write = function(name, data) { if (name === 'use_item' && data.hand === 1) observed.offhandUses++; return rawWrite.call(this, name, data) }
    for (let round = 1; round <= rounds; round++) {
      await rpc.call('stop')
      partner.clearControlStates()
      await cmd(`/kill @e[type=item,x=${arena.x - 30},y=${arena.y - 3},z=${arena.z - 30},dx=60,dy=50,dz=60]`)
      for (const name of [player, opponent]) {
        await cmd(`/gamemode spectator ${name}`)
        await cmd(`/clear ${name}`)
        await cmd(`/effect clear ${name}`)
        for (const [slot, item] of [['head', 'diamond_helmet'], ['legs', 'diamond_leggings'], ['feet', 'diamond_boots'], ['chest', mode === 'air' ? 'elytra' : 'diamond_chestplate']]) await cmd(`/item replace entity ${name} armor.${slot} with minecraft:${item}`)
        const inventory = ['diamond_sword', 'mace', 'diamond_spear', 'ender_pearl 8', 'cobweb 8', 'cobblestone 64', 'golden_apple 4', 'cooked_beef 16', 'water_bucket', 'diamond_chestplate', 'shield', 'potion[potion_contents={potion:"minecraft:fire_resistance"}] 2']
        if (mode !== 'height') inventory.push('elytra', 'firework_rocket 32')
        for (const spec of inventory) { const [item, count = '1'] = spec.split(' '); await cmd(`/give ${name} minecraft:${item} ${count}`) }
        await cmd(`/effect give ${name} minecraft:instant_health 1 10 true`)
        await cmd(`/effect give ${name} minecraft:saturation 1 20 true`)
      }
      const height = arena.y + (mode === 'air' ? 20 : 0)
      const mainX = arena.x + (mode === 'height' ? 4 : -4)
      const foeX = arena.x + (mode === 'height' ? 7 : 4)
      await cmd(`/tp ${player} ${mainX}.5 ${height} ${arena.z}.5 -90 0`)
      await cmd(`/tp ${opponent} ${foeX}.5 ${height} ${arena.z}.5 90 0`)
      for (const name of [player, opponent]) await cmd(`/gamemode survival ${name}`)
      await sleep(300)
      const spear = partner.inventory.items().find(item => item.name === 'diamond_spear')
      if (!spear || !(partner.health > 0)) throw new Error('partner fixture has no spear or died before the measured fight')
      await partner.equip(spear, 'hand')
      if (mode === 'air') { sky.startGlide(partner); await partner.look(Math.PI / 2, 0.05, true); sky.fireRocket(partner) }
      ctl = { aborted: false, onAbort: [], abort() { this.aborted = true; for (const fn of this.onAbort) fn() } }
      const began = gameClock.now()
      const mainFight = rpc.call('fight', { target: opponent, allowPlayer: true, timeoutSeconds: 120, retreatAtHealth: 2, arena })
      let partnerFight: Promise<any>
      if (mode === 'pearl') {
        partnerFight = (async () => {
          await sleep(600)
          const item = partner.inventory.items().find(item => item.name === 'ender_pearl')
          const shot = await projectiles.throwAt(partner, new Vec3(arena.x - 1.5, arena.y + .1, arena.z + 5.5), { item, preferOffhand: true })
          console.log('VISIBLE_PEARL', JSON.stringify(shot))
          const enemy = partner.players[player]?.entity
          return enemy ? duel(partnerSession, ctl, enemy, { timeoutSeconds: 120, retreatAtHealth: 2, arena }) : { lost: true }
        })()
      } else {
        const enemy = partner.players[player]?.entity
        partnerFight = enemy ? duel(partnerSession, ctl, enemy, { timeoutSeconds: 120, retreatAtHealth: 2, arena }) : Promise.resolve({ lost: true })
      }
      const first = await Promise.race([mainFight.then(result => ({ side: player, result })), partnerFight.then(result => ({ side: opponent, result }))])
      await rpc.call('stop')
      ctl.abort()
      const settled = await Promise.allSettled([mainFight, partnerFight])
      const status = await rpc.call('status')
      const record = { mode, round, gameMs: gameClock.now() - began, first, results: settled, state: status.state, partnerHp: partner.health, observed: { ...observed } }
      outcomes.push(record)
      console.log('INTELLECT_ROUND', JSON.stringify(record))
    }
    console.log('INTELLECT_SUMMARY', JSON.stringify(outcomes))
  } finally {
    try { ctl?.abort() } catch (error) { console.error('scene cleanup abort:', error.message) }
    await rpc.call('stop').catch(() => {})
    try { partner?.quit('scene finished') } catch (error) { console.error('scene cleanup partner:', error.message) }
    try { partner?.ndClock?.dispose() } catch (error) { console.error('scene cleanup clock:', error.message) }
    try { rpc.close() } catch (error) { console.error('scene cleanup rpc:', error.message) }
    gameClock.changes.removeListener('bound', clockBound)
    try { followedClock?.dispose() } catch (error) { console.error('scene cleanup follower:', error.message) }
  }
}

if (require.main === module) main().catch(error => { console.error(error); process.exitCode = 1 })
export { main }
