import * as fs from 'node:fs'
import * as clock from '../../daemon/src/game-clock'
import { connect, createKit } from '../../daemon/scenes/lib/scene-kit'

async function main() {
  const slot = Number(process.env.SLOT ?? 31)
  const url = process.env.ND_WS ?? `ws://127.0.0.1:${8800 + slot}`
  const logFile = process.env.ND_SERVER_LOG
  const player = process.env.ND_BOT_NAME ?? `NeuroFarm${slot}`
  if (!Number.isInteger(slot) || slot < 1 || slot > 32 || url !== `ws://127.0.0.1:${8800 + slot}` || !logFile || !fs.existsSync(logFile)) {
    throw new Error('LastStand fixture requires an isolated farm slot and ND_SERVER_LOG command witnesses')
  }
  const rpc = connect(url)
  const x = 3440; const y = 100; const z = 3300
  const tag = 'nd_last_stand'
  let kit: any
  const wallDeadline = <T>(work: Promise<T>, ms = 20000): Promise<T> => new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('LastStand transport wall deadline')), ms)
    work.then(value => { clearTimeout(timer); resolve(value) }, error => { clearTimeout(timer); reject(error) })
  })
  const call = (name: string, params: Record<string, unknown> = {}) => wallDeadline(rpc.call(name, params))
  const cmd = async (text: string) => {
    const reply = await kit.cmd(text)
    if (!reply.ok) throw new Error(`Unwitnessed fixture command: ${text}`)
  }
  const poll = async (label: string, accept: (reply: any) => boolean) => {
    const until = Date.now() + 20000
    let reply: any
    do {
      reply = await call('status')
      if (!(reply.state?.health > 0)) throw new Error(`${label}: bot died`)
      if (accept(reply)) return reply
      await clock.sleep(100)
    } while (Date.now() < until)
    throw new Error(`${label}: ${JSON.stringify({ state: reply.state, events: rpc.heard.slice(-12) })}`)
  }
  const closeRoom = async () => {
    await cmd(`/fill ${x - 1} ${y} ${z - 1} ${x + 3} ${y + 2} ${z + 3} minecraft:obsidian`)
    await cmd(`/fill ${x} ${y} ${z} ${x + 2} ${y + 1} ${z + 2} minecraft:air`)
  }
  try {
    await wallDeadline(rpc.ready)
    await call('connect'); await call('stop'); await call('temper', { enabled: false })
    await call('play_mode', { mode: 'free' })
    kit = createKit({ call, heard: rpc.heard, player, logFile })
    await kit.gamerule('keep_inventory', false)
    await kit.gamerule('spawn_mobs', false)
    await cmd('/difficulty normal'); await cmd('/weather clear'); await cmd('/time set midnight')
    await cmd(`/gamemode spectator ${player}`)
    await cmd(`/tp ${player} ${x}.5 ${y + 8} ${z}.5`)
    await kit.forceload('overworld', [[x - 5, y, z - 5], [x + 8, y, z + 8]])
    await cmd(`/fill ${x - 5} ${y - 1} ${z - 5} ${x + 8} ${y - 1} ${z + 8} minecraft:stone`)
    await cmd(`/fill ${x - 5} ${y} ${z - 5} ${x + 8} ${y + 4} ${z + 8} minecraft:air`)
    await cmd(`/kill @e[type=!player,x=${x - 5},y=${y - 2},z=${z - 5},dx=13,dy=8,dz=13]`)
    await closeRoom()
    await cmd(`/clear ${player}`); await cmd(`/effect clear ${player}`)
    for (const [slotName, armor] of [['head', 'diamond_helmet'], ['chest', 'diamond_chestplate'], ['legs', 'diamond_leggings'], ['feet', 'diamond_boots']]) {
      await cmd(`/item replace entity ${player} armor.${slotName} with minecraft:${armor}`)
    }
    await cmd(`/give ${player} minecraft:diamond_sword`)
    await cmd(`/attribute ${player} minecraft:max_health base set 6`)
    await cmd(`/tp ${player} ${x}.5 ${y} ${z}.5 -45 0`)
    await cmd(`/gamemode survival ${player}`)
    await cmd(`/effect give ${player} minecraft:instant_health 1 10 true`)
    await cmd(`/effect give ${player} minecraft:saturation 1 20 true`)
    await poll('corner ready', reply => reply.state.health <= 6 && reply.state.tactics?.threatLevel === 0)

    const mark = rpc.heard.length
    await cmd(`/summon minecraft:husk ${x + 2}.5 ${y} ${z + 2}.5 {Tags:["${tag}"]}`)
    const selected = await poll('LastStand selected', reply => reply.state.tactics?.action === 'LastStand')
    if (!selected.state.tactics.state.escapeExhausted || selected.state.tactics.state.escapeRoute) throw new Error('Corner escape geometry was not exhausted')
    await poll('LastStand real counterattack', () => rpc.heard.slice(mark).some((event: any) =>
      event.type === 'last_stand_kill' && event.swings > 0 && event.landed > 0) && rpc.heard.slice(mark).some((event: any) => event.type === 'last_stand_hit'))
    const physical = rpc.heard.slice(mark).filter((event: any) => /^last_stand_/.test(event.type))
    console.log('LAST_STAND_COUNTERATTACK', JSON.stringify({ selected: selected.state.tactics, physical }))

    await call('stop')
    await cmd(`/effect give ${player} minecraft:instant_health 1 10 true`)
    await cmd(`/tp ${player} ${x}.5 ${y} ${z}.5 -45 0`)
    await cmd(`/summon minecraft:husk ${x + 2}.5 ${y} ${z + 2}.5 {Tags:["${tag}"]}`)
    await poll('second LastStand selected', reply => reply.state.tactics?.action === 'LastStand')
    await cmd(`/fill ${x} ${y} ${z + 3} ${x + 2} ${y + 1} ${z + 3} minecraft:air`)
    const opened = await poll('new loaded exit releases LastStand', reply => reply.state.tactics?.state?.escapeRoute &&
      !reply.state.tactics.state.escapeExhausted && reply.state.tactics.action !== 'LastStand')
    console.log('LAST_STAND_OPEN_EXIT', JSON.stringify({ hp: opened.state.health, tactics: opened.state.tactics,
      events: rpc.heard.slice(-10) }))
  } finally {
    try { await call('stop') } catch {}
    if (kit) {
      try { await cmd(`/kill @e[tag=${tag}]`) } catch {}
      try { await cmd(`/attribute ${player} minecraft:max_health base set 20`) } catch {}
    }
    rpc.close()
  }
}
if (require.main === module) main().catch((error: Error) => { console.error(error); process.exitCode = 1 })
export { main }
