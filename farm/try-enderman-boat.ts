const fs = require('node:fs')
const clock = require('../daemon/src/game-clock')
const { connect, createKit } = require('../daemon/scene-kit')

async function main() {
  const slot = Number(process.env.SLOT ?? 31)
  const url = process.env.ND_WS ?? `ws://127.0.0.1:${8800 + slot}`
  const logFile = process.env.ND_SERVER_LOG
  const player = process.env.ND_BOT_NAME ?? `NeuroFarm${slot}`
  if (!Number.isInteger(slot) || slot < 1 || slot > 32 || url !== `ws://127.0.0.1:${8800 + slot}` || !logFile || !fs.existsSync(logFile)) {
    throw new Error('EndermanBoat fixture requires an isolated farm slot and ND_SERVER_LOG command witnesses')
  }
  const rpc = connect(url)
  const x = 3400; const y = 100; const z = 3300
  try {
    await rpc.ready
    await rpc.call('connect')
    await rpc.call('stop')
    await rpc.call('temper', { enabled: false })
    const kit = createKit({ call: rpc.call, heard: rpc.heard, player, logFile })
    const cmd = async (text: string) => { const reply = await kit.cmd(text); if (!reply.ok) throw new Error(`Unwitnessed fixture command: ${text}`) }
    await kit.gamerule('keep_inventory', false)
    await kit.gamerule('spawn_mobs', false)
    await cmd('/difficulty normal')
    await cmd('/weather clear')
    await cmd('/time set midnight')
    await cmd(`/gamemode spectator ${player}`)
    await cmd(`/tp ${player} ${x}.5 ${y + 12} ${z}.5`)
    await kit.forceload('overworld', [[x - 12, y, z - 12], [x + 16, y, z + 12]])
    await cmd(`/fill ${x - 12} ${y - 1} ${z - 12} ${x + 16} ${y - 1} ${z + 12} minecraft:stone`)
    await cmd(`/fill ${x - 12} ${y} ${z - 12} ${x + 16} ${y + 5} ${z + 12} minecraft:air`)
    await cmd(`/kill @e[type=!player,x=${x - 12},y=${y - 2},z=${z - 12},dx=28,dy=9,dz=24]`)
    await cmd(`/clear ${player}`)
    await cmd(`/effect clear ${player}`)
    for (const [slotName, armor] of [['head', 'diamond_helmet'], ['chest', 'diamond_chestplate'], ['legs', 'diamond_leggings'], ['feet', 'diamond_boots']]) {
      await cmd(`/item replace entity ${player} armor.${slotName} with minecraft:${armor}`)
    }
    const kitItems = ['diamond_sword', 'shield', 'cooked_beef 8', ...(process.env.BOAT_KIT === 'craft' ? ['oak_planks 8', 'crafting_table'] : ['oak_boat'])]
    for (const item of kitItems) { const [name, count = '1'] = item.split(' '); await cmd(`/give ${player} minecraft:${name} ${count}`) }
    await cmd(`/tp ${player} ${x}.5 ${y} ${z}.5 -90 0`)
    await cmd(`/gamemode survival ${player}`)
    await cmd(`/effect give ${player} minecraft:instant_health 1 10 true`)
    await cmd(`/effect give ${player} minecraft:saturation 1 20 true`)
    await cmd(`/summon minecraft:enderman ${x + 9}.5 ${y} ${z}.5`)
    await clock.sleep(500)
    const result = await rpc.call('pearls', { mode: 'hunt', style: 'boat', boatOnly: true, count: 1, timeoutSeconds: 45 })
    const final = await rpc.call('status')
    const proof = { status: result.status, by: result.by, events: result.events, boat: result.detail?.boatTrap, hp: final.state?.health,
      position: final.state?.position, tactics: final.state?.tactics,
      inventory: final.state?.inventory, death: result.by?.type === 'death' || result.events?.some((event: { type: string }) => event.type === 'death') }
    console.log('ENDERMAN_BOAT', JSON.stringify(proof))
    if (!proof.boat?.captured || !proof.boat?.killed || !(proof.boat.swings > 0) || !(proof.hp > 0) || proof.death) throw new Error('EndermanBoat capture and honest kill were not both observed')
  } finally {
    try { await rpc.call('stop') } catch {}
    rpc.close()
  }
}
if (require.main === module) main().catch((error: Error) => { console.error(error); process.exitCode = 1 })
module.exports = { main }
