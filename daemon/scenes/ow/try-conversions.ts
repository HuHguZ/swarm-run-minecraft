import assert from 'node:assert/strict'
import { connect, createKit } from '../lib/scene-kit'

export async function runConversionScene() {
  const slot = Number(process.env.FARM_SLOT)
  assert.equal(slot, 31, 'conversion fixture reserved for farm31')
  assert.equal(process.env.ND_WS, 'ws://127.0.0.1:8831')
  assert.equal(process.env.MC_PORT, '25631')
  assert.ok(process.env.ND_SERVER_LOG?.replaceAll('\\', '/').endsWith('/farm/server-31/logs/latest.log'))
  const connection = connect(process.env.ND_WS)
  await connection.ready
  const call = (method: string, params: Record<string, unknown> = {}) => connection.call(method, params)
  const kit = createKit({ call, heard: connection.heard, logFile: process.env.ND_SERVER_LOG, player: 'NeuroFarm31', replyMs: 3000 })
  const command = async (text: string, confirm = true) => {
    const result = await kit.cmd(text)
    if (confirm) assert.ok(result.ok, `${text}: ${result.why}`)
  }
  const reset = async (items: string[]) => {
    await call('stop')
    await command('/clear @s', false)
    await command('/kill @e[type=minecraft:item,distance=..16]', false)
    await command('/tp @s 3200.5 160 2900.5')
    for (const item of items) await command(`/give @s minecraft:${item}`)
    await command('/effect give @s minecraft:saturation 1 5 true')
    await command('/effect give @s minecraft:instant_health 1 5 true')
  }
  const craft = async (item: string, count = 1, repair = false) => {
    const result = await call('craft', { item, count, repair, spendReserve: true, timeoutSeconds: 300 })
    console.log(JSON.stringify({ slot, name: repair ? 'repair' : item, result }))
    assert.equal(result.status, 'done', JSON.stringify(result))
    assert.ok(result.state.health > 0)
    return result
  }
  try {
    await call('connect')
    await call('play_mode', { mode: 'free' })
    await command('/gamemode creative', false)
    await kit.ensureWorld('overworld', { tp: '3200.5 165 2900.5' })
    await kit.fillExact('overworld', [[3194, 160, 2894], [3206, 164, 2906]], 'air')
    await kit.fillExact('overworld', [[3194, 159, 2894], [3206, 159, 2906]], 'stone')
    await command('/gamemode survival')

    if (process.env.ONLY_PACK_DISPOSAL === '1') {
      for (const cliff of [false, true]) {
        await call('stop')
        await command('/gamemode creative')
        await kit.fillExact('overworld', [[3194, 159, 2894], [3206, 159, 2906]], cliff ? 'air' : 'stone')
        await command('/setblock 3200 159 2900 minecraft:stone')
        await command('/gamemode survival')
        await reset(['gravel 10', 'iron_pickaxe', 'cooked_beef 16'])
        const result = await call('pack', { mode: 'tidy' })
        console.log(JSON.stringify({ slot, name: 'pack-disposal', cliff, result }))
        assert.equal(result.status, 'done', JSON.stringify(result))
        assert.ok(result.detail.tossed.length > 0)
        assert.equal(result.state.health, 20)
        assert.equal(result.state.pos.y, 160, 'disposal must keep the body on its safe floor')
        const distance = Math.hypot(result.state.pos.x - 3200, result.state.pos.z - 2900)
        if (cliff) assert.equal(distance, 0)
        else assert.ok(distance >= 2, 'safe ground still permits leaving discarded clutter')
      }
      return
    }

    if (process.env.ONLY_STICK_CAPACITY === '1') {
      for (const refill of [false, true]) {
        await reset([])
        for (let slot = 0; slot < 9; slot++) await command(`/item replace entity @s hotbar.${slot} with minecraft:iron_sword`)
        for (let slot = 0; slot < 27; slot++) await command(`/item replace entity @s inventory.${slot} with minecraft:iron_sword`)
        for (const [slot, item] of ['oak_planks 12', 'crafting_table', 'iron_pickaxe', 'stone_pickaxe', 'cobbled_deepslate 64', 'polished_blackstone_bricks 2', 'gilded_blackstone'].entries()) {
          await command(`/item replace entity @s hotbar.${slot} with minecraft:${item}`)
        }
        if (refill) for (const item of ['dirt', 'gravel', 'sand', 'granite', 'diorite', 'andesite', 'tuff', 'calcite']) {
          await command(`/summon minecraft:item 3200.5 160 2900.5 {Tags:["nd_capacity"],PickupDelay:0s,Item:{id:"minecraft:${item}",count:64}}`)
        }
        const before = await call('status')
        assert.equal(before.state.inventory.iron_sword, 29)
        assert.equal(before.state.inventory.oak_planks, 12)
        assert.equal(Object.values(before.state.inventory).reduce((total: number, count: number) => total + count, 0), 111, 'the prepared 36 slots must be full')
        const result = await craft('stick', 4)
        console.log(JSON.stringify({ slot, name: 'stick-capacity', refill, before: before.state.inventory, result }))
        assert.equal(result.state.inventory.stick, 4)
        assert.equal(result.state.inventory.oak_planks, 10)
        assert.equal(result.state.inventory.crafting_table, 1, 'the carried table must remain available')
        assert.equal(result.state.inventory.iron_sword, 29)
        assert.equal(result.state.inventory.iron_pickaxe, 1)
        assert.equal(result.state.inventory.stone_pickaxe, 1)
        assert.equal(result.state.inventory.cobbled_deepslate, 64, 'the existing build reserve must survive')
      }
      return
    }

    if (process.env.ONLY_PICK_CAPACITY === '1') {
      await reset([])
      for (let slot = 0; slot < 9; slot++) await command(`/item replace entity @s hotbar.${slot} with minecraft:iron_sword`)
      for (let slot = 0; slot < 27; slot++) await command(`/item replace entity @s inventory.${slot} with minecraft:iron_sword`)
      for (const [slot, item] of ['blackstone 15', 'basalt 8', 'cobbled_deepslate 64', 'stick 4', 'crafting_table', 'iron_pickaxe'].entries()) {
        await command(`/item replace entity @s hotbar.${slot} with minecraft:${item}`)
      }
      await command('/item replace entity @s inventory.0 with minecraft:basalt 8')
      const before = await call('status')
      const result = await craft('stone_pickaxe')
      console.log(JSON.stringify({ slot, name: 'pick-capacity', before: before.state.inventory, result }))
      assert.equal(result.state.inventory.blackstone, 12, 'only the three recipe blocks may be spent')
      assert.equal(result.state.inventory.stick, 2)
      assert.equal(result.state.inventory.stone_pickaxe, 1)
      assert.equal(result.state.inventory.crafting_table, 1)
      assert.equal(result.detail.tableBack, true)
      return
    }

    if (process.env.ONLY_CAPACITY === '1') {
      for (const refill of [false, true]) {
        await reset([])
        for (let slot = 1; slot < 9; slot++) await command(`/item replace entity @s hotbar.${slot} with minecraft:netherrack 64`)
        for (let slot = 0; slot < 27; slot++) await command(`/item replace entity @s inventory.${slot} with minecraft:netherrack 64`)
        await command('/item replace entity @s hotbar.1 with minecraft:iron_pickaxe')
        await command('/item replace entity @s hotbar.2 with minecraft:iron_sword')
        await command('/item replace entity @s hotbar.0 with minecraft:oak_planks 6')
        if (refill) for (const item of ['dirt', 'gravel', 'sand', 'granite', 'diorite', 'andesite', 'tuff', 'calcite']) {
          await command(`/summon minecraft:item 3200.5 160 2900.5 {Tags:["nd_capacity"],PickupDelay:0s,Item:{id:"minecraft:${item}",count:64}}`)
        }
        const before = await call('status')
        assert.equal(before.state.inventory.oak_planks, 6)
        assert.equal(before.state.inventory.netherrack, 33 * 64, 'all 36 inventory slots must be occupied')
        const result = await call('craft', { item: 'crafting_table', count: 1, timeoutSeconds: 300 })
        console.log(JSON.stringify({ slot, name: 'craft-capacity', refill, before: before.state.inventory, result }))
        assert.equal(result.status, 'done', JSON.stringify(result))
        assert.equal(result.state.inventory.crafting_table, 1)
        assert.equal(result.state.inventory.oak_planks, 2, 'only the four recipe planks may be spent')
      }
      return
    }

    await reset(['cobweb 3', 'stick 3', 'diamond_sword', 'crafting_table'])
    const bow = await craft('bow')
    assert.equal(bow.state.inventory.bow, 1)
    assert.equal(bow.state.inventory.cobweb ?? 0, 0)
    assert.equal(bow.state.inventory.string ?? 0, 0)
    assert.ok(bow.detail.conversion.steps.some((step: { mechanism: string }) => step.mechanism === 'place-dig'))
    assert.equal(bow.detail.tableBack, true, 'the temporarily placed crafting table must be recovered')
    assert.equal(bow.state.inventory.crafting_table, 1)
    if (process.env.ONLY_BOW === '1') return

    await reset(['iron_block', 'crafting_table'])
    const unpacked = await craft('iron_nugget', 81)
    assert.equal(unpacked.state.inventory.iron_nugget, 81)
    assert.equal(unpacked.state.inventory.iron_block ?? 0, 0)
    const packed = await craft('iron_block')
    assert.equal(packed.state.inventory.iron_block, 1)
    assert.equal(packed.state.inventory.iron_nugget ?? 0, 0)

    await reset(['raw_iron 3', 'coal 8', 'furnace'])
    const smelted = await craft('iron_ingot', 3)
    assert.equal(smelted.state.inventory.iron_ingot, 3)
    assert.equal(smelted.state.inventory.raw_iron ?? 0, 0)

    await reset(['iron_sword[damage=200]', 'iron_sword[damage=180]'])
    const repaired = await craft('iron_sword', 1, true)
    assert.equal(repaired.detail.mechanism, 'craft')
    assert.equal(repaired.detail.damage, 118)
    assert.equal(repaired.state.inventory.iron_sword, 1)
    assert.equal(repaired.detail.freedSlots, 1)

    await reset(['iron_sword[damage=200,enchantments={sharpness:1}]', 'iron_sword[damage=180,enchantments={sharpness:1}]'])
    const guarded = await call('craft', { item: 'iron_sword', repair: true, planOnly: true })
    assert.equal(guarded.detail.repair.mechanism, 'anvil')
    assert.equal(guarded.detail.executable, false)
    assert.equal(guarded.state.inventory.iron_sword, 2)
    await command('/setblock 3199 160 2900 minecraft:anvil')
    await command('/experience set @s 30 levels')
    const enchanted = await craft('iron_sword', 1, true)
    assert.equal(enchanted.detail.mechanism, 'anvil')
    assert.ok(enchanted.detail.enchantments.sharpness >= 1)
    assert.ok(enchanted.detail.xpCost > 0 && enchanted.detail.xpCost < 40)
    assert.equal(enchanted.state.inventory.iron_sword, 1)
    console.log(JSON.stringify({ slot, name: 'conversion-scene', ok: true, actualInventory: true, cases: 5 }))
  } finally {
    await call('stop').catch(() => {})
    connection.close()
  }
}

if (require.main === module) runConversionScene().catch(error => { console.error(error); process.exitCode = 1 })
