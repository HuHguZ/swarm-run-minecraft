import type { Bot } from 'mineflayer'
import type { Window } from 'prismarine-windows'

const { confirmedClick, refresh, sameStack } = require('./invsync')
const clock = require('./game-clock')

interface Ingredient { id: number; metadata?: number | null; count?: number }
export interface CraftRecipe {
  requiresTable?: boolean
  inShape?: Ingredient[][]
  ingredients?: Ingredient[]
  result: Ingredient & { count: number }
  delta: Array<Ingredient & { count: number }>
}

export async function putCursorAway(bot: Bot, window: Window, preserve?: ReadonlySet<string>) {
  while (window.selectedItem) {
    const held = window.selectedItem
    let destination = -1
    for (let slot = window.inventoryStart; slot < window.inventoryEnd; slot++) {
      const current = window.slots[slot]
      if (current && current.type === held.type && current.metadata === held.metadata && current.count < current.stackSize
        && sameStack(bot, current, held)) { destination = slot; break }
    }
    if (destination < 0) for (let slot = window.inventoryStart; slot < window.inventoryEnd; slot++) {
      if (!window.slots[slot]) { destination = slot; break }
    }
    if (destination < 0) {
      const disposable = require('./pack').tossPlan(bot, { below: 2, inventory: window, preserve })[0]
      if (disposable) {
        const discarded = window.slots[disposable.slot]
        await confirmedClick(bot, disposable.slot)
        if (!sameStack(bot, window.selectedItem, discarded)) throw new Error('server did not confirm exchanging crafting cursor for clutter')
        await confirmedClick(bot, -999)
        continue
      }
    }
    if (destination < 0) throw new Error(`no inventory room for carried crafting stack: ${JSON.stringify({ window: window.id,
      cursor: { item: held.name, count: held.count }, grid: window.slots.slice(0, window.inventoryStart).map((item, slot) => item && { slot, item: item.name, count: item.count }) })}`)
    const before = held.count
    await confirmedClick(bot, destination)
    if (window.selectedItem && window.selectedItem.count >= before) throw new Error('server did not store carried crafting stack')
  }
}

export async function putSlotAway(bot: Bot, window: Window, slot: number, preserve?: ReadonlySet<string>) {
  if (window.selectedItem) await putCursorAway(bot, window, preserve)
  if (!window.slots[slot]) return
  await confirmedClick(bot, slot)
  await putCursorAway(bot, window, preserve)
}

async function openTable(bot: Bot, table: Parameters<Bot['activateBlock']>[0]): Promise<Window> {
  if (bot.currentWindow) throw new Error('another inventory window is already open')
  return new Promise<Window>((resolve, reject) => {
    let timer: ReturnType<typeof setTimeout>
    let finished = false
    const finish = (window?: Window, error?: Error) => {
      if (finished) return
      finished = true
      clock.wall.clearTimeout(timer)
      bot.removeListener('windowOpen', onOpen)
      bot.removeListener('end', onEnd)
      if (error) reject(error); else resolve(window!)
    }
    const onOpen = (window: Window) => finish(window)
    const onEnd = () => finish(undefined, new Error('crafting table disconnected'))
    bot.once('windowOpen', onOpen)
    bot.once('end', onEnd)
    timer = clock.wall.setTimeout(() => finish(undefined, new Error('windowOpen: crafting table did not open')), 6000)
    bot.activateBlock(table).catch(error => finish(undefined, error))
  })
}

export async function craftConfirmed(bot: Bot, recipe: CraftRecipe, times: number, table: Parameters<Bot['activateBlock']>[0] | null, interrupted: () => boolean = () => false) {
  const window = table ? await openTable(bot, table) : bot.inventory
  const width = table ? 3 : 2
  if (table && !String(window.type).startsWith('minecraft:crafting')) throw new Error('opened window is not a crafting table')
  const preserve = new Set(recipe.delta.filter(ingredient => ingredient.count < 0).map(ingredient => bot.registry.items[ingredient.id].name))
  let failed = false
  try {
    for (let slot = 1; slot <= width * width; slot++) await putSlotAway(bot, window, slot, preserve)
    for (let run = 0; run < times; run++) {
      if (interrupted()) throw new Error('crafting interrupted')
      const destinations: Array<{ slot: number; ingredient: Ingredient }> = []
      if (recipe.inShape) for (let y = 0; y < recipe.inShape.length; y++) for (let x = 0; x < recipe.inShape[y].length; x++) {
        const ingredient = recipe.inShape[y][x]
        if (ingredient.id >= 0) destinations.push({ slot: 1 + x + y * width, ingredient })
      }
      else for (const [index, ingredient] of (recipe.ingredients ?? []).entries()) destinations.push({ slot: 1 + index, ingredient })
      for (const { slot, ingredient } of destinations) {
        if (interrupted()) throw new Error('crafting interrupted')
        if (!window.selectedItem || window.selectedItem.type !== ingredient.id ||
          ingredient.metadata != null && window.selectedItem.metadata !== ingredient.metadata) {
          await putCursorAway(bot, window, preserve)
          const source = window.findInventoryItem(ingredient.id, ingredient.metadata ?? null, false)
          if (!source) throw new Error(`missing ingredient ${ingredient.id} in confirmed server inventory`)
          await confirmedClick(bot, source.slot)
        }
        await confirmedClick(bot, slot, 1)
        if (window.slots[slot]?.type !== ingredient.id) throw new Error('server did not accept crafting ingredient')
      }
      await putCursorAway(bot, window, preserve)
      if (interrupted()) throw new Error('crafting interrupted before taking result')
      const output = window.slots[0]
      if (!output || output.type !== recipe.result.id || output.count !== recipe.result.count) throw new Error('server did not produce the expected crafting result')
      await putSlotAway(bot, window, 0, preserve)
      for (let slot = 1; slot <= width * width; slot++) await putSlotAway(bot, window, slot, preserve)
    }
  } catch (error) { failed = true; throw error } finally {
    try { await putCursorAway(bot, window, preserve) } catch {}
    for (let slot = 1; slot <= width * width; slot++) {
      try { await putSlotAway(bot, window, slot, preserve) } catch {}
    }
    if (table && bot.currentWindow === window) bot.closeWindow(window)
    if (!bot.currentWindow && !bot.inventory.selectedItem && !(await refresh(bot)) && !failed) throw new Error('server did not confirm completed crafting inventory')
  }
}
