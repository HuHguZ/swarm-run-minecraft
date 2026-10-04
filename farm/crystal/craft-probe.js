'use strict'
// Проба крафта кристалла (2026-09-30): третий бот на сервере слота 30, верстак, recipesFor/craft.
const path = require('path')
const mineflayer = require(path.join(__dirname, '../../daemon/node_modules/mineflayer'))
const { execFileSync } = require('child_process')
const Vec3 = require(path.join(__dirname, '../../daemon/node_modules/vec3'))
const rcon = (c) => execFileSync(process.execPath, [path.join(__dirname, '../farm.js'), 'rcon', '30', c], { encoding: 'utf8' }).trim()
const bot = mineflayer.createBot({ host: '127.0.0.1', port: 25630, username: 'NeuroFarm30c', version: '1.21.11', auth: 'offline' })
const sleep = ms => new Promise(r => setTimeout(r, ms))
bot.once('spawn', async () => {
  try {
    console.log(rcon('op NeuroFarm30c'))
    console.log(rcon('execute in minecraft:overworld run tp NeuroFarm30c 150 100 150'))
    console.log(rcon('fill 148 99 148 152 99 152 minecraft:obsidian'))
    console.log(rcon('fill 148 100 148 152 102 152 minecraft:air'))
    console.log(rcon('clear NeuroFarm30c'))
    for (const g of ['glass 28', 'ender_eye 4', 'ghast_tear 4', 'crafting_table 1']) console.log(rcon('give NeuroFarm30c minecraft:' + g))
    await sleep(1500)
    const md = bot.registry
    console.log('inv', bot.inventory.items().map(i => i.name + '×' + i.count).join(', '))
    console.log(rcon('setblock 151 100 150 minecraft:crafting_table'))
    await sleep(800)
    const table = bot.findBlock({ matching: md.blocksByName.crafting_table.id, maxDistance: 4 })
    console.log('table', table && table.position)
    const rs = bot.recipesFor(md.itemsByName.end_crystal.id, null, 1, table)
    console.log('recipes', rs.length)
    if (rs.length) {
      for (const n of [1, 1]) { try { await bot.craft(rs[0], n, table); console.log('crafted', n) } catch (e) { console.log('craft err', e.message) } await sleep(400) }
    }
    await sleep(800)
    console.log('inv after', bot.inventory.items().map(i => i.name + '×' + i.count).join(', '))
  } catch (e) { console.log('ERR', e.stack) }
  bot.quit(); setTimeout(() => process.exit(0), 500)
})
bot.on('error', e => console.log('error', e.message))
bot.on('kicked', r => console.log('kicked', r))
setTimeout(() => { console.log('timeout'); process.exit(1) }, 40000)
