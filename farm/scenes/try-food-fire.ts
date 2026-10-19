import * as fs from 'node:fs'
import * as clock from '../../daemon/src/game-clock'
import { connect, createKit } from '../../daemon/scenes/lib/scene-kit'

async function main() {
  const slot = Number(process.env.SLOT ?? 31)
  const url = process.env.ND_WS ?? `ws://127.0.0.1:${8800 + slot}`
  const logFile = process.env.ND_SERVER_LOG
  const player = process.env.ND_BOT_NAME ?? `NeuroFarm${slot}`
  if (!Number.isInteger(slot) || slot < 1 || slot > 32 || url !== `ws://127.0.0.1:${8800 + slot}` || !logFile || !fs.existsSync(logFile)) {
    throw new Error('FoodFire fixture requires an isolated farm slot and ND_SERVER_LOG command witnesses')
  }
  const rpc = connect(url)
  const x = 3480; const y = 100; const z = 3300
  try {
    await rpc.ready; await rpc.call('connect'); await rpc.call('stop')
    await rpc.call('temper', { enabled: false }); await rpc.call('play_mode', { mode: 'speedrun', foodTarget: 8 })
    const kit = createKit({ call: rpc.call, heard: rpc.heard, player, logFile })
    const cmd = async (text: string) => { const reply = await kit.cmd(text); if (!reply.ok) throw new Error(`Unwitnessed fixture command: ${text}`) }
    await kit.gamerule('keep_inventory', false); await kit.gamerule('spawn_mobs', false)
    await cmd('/difficulty normal'); await cmd('/weather clear'); await cmd('/time set noon')
    await cmd(`/gamemode spectator ${player}`); await cmd(`/tp ${player} ${x}.5 ${y + 8} ${z}.5`)
    await kit.forceload('overworld', [[x - 8, y, z - 8], [x + 12, y, z + 8]])
    await cmd(`/fill ${x - 8} ${y - 1} ${z - 8} ${x + 12} ${y - 1} ${z + 8} minecraft:stone`)
    await cmd(`/fill ${x - 8} ${y} ${z - 8} ${x + 12} ${y + 5} ${z + 8} minecraft:air`)
    await cmd(`/kill @e[type=!player,x=${x - 8},y=${y - 2},z=${z - 8},dx=20,dy=10,dz=16]`)
    await cmd(`/clear ${player}`); await cmd(`/effect clear ${player}`)
    await cmd(`/attribute ${player} minecraft:max_health base set 20`)
    for (const item of ['wooden_sword', 'flint_and_steel']) await cmd(`/give ${player} minecraft:${item}`)
    await cmd(`/tp ${player} ${x}.5 ${y} ${z}.5 -90 0`)
    await cmd(`/gamemode survival ${player}`)
    await cmd(`/effect give ${player} minecraft:instant_health 1 10 true`)
    await cmd(`/effect give ${player} minecraft:saturation 1 20 true`)
    await cmd(`/summon minecraft:cow ${x + 3}.75 ${y} ${z}.25`)
    await clock.sleep(200)
    const before = await rpc.call('status')
    const result = await rpc.call('fight', { target: 'cow', purpose: 'food', timeoutSeconds: 45, clearArea: 0 })
    const final = await rpc.call('status')
    const cooked = (final.state?.inventory?.cooked_beef ?? 0) - (before.state?.inventory?.cooked_beef ?? 0)
    const proof = { status: result.status, by: result.by, foodFire: result.detail?.foodFire, gained: result.detail?.gained,
      cooked, hp: final.state?.health, inventory: final.state?.inventory, result: result.detail, events: result.events }
    console.log('FOOD_FIRE', JSON.stringify(proof))
    if (!(proof.foodFire?.ignited > 0) || !(proof.foodFire?.burningObserved > 0) || !(cooked > 0) || !(proof.hp > 0)) {
      throw new Error('FoodFire ignition, target burning and actual cooked drop were not all observed')
    }
  } finally {
    try { await rpc.call('stop') } catch {}
    rpc.close()
  }
}
if (require.main === module) main().catch((error: Error) => { console.error(error); process.exitCode = 1 })
export { main }
