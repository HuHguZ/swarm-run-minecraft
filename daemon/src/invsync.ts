'use strict'
const gameClock = require('./game-clock')
const menuStates = new WeakMap<object, Map<number, number>>()

function sameStack(bot, a, b) {
  const Item = require('prismarine-item')(bot.registry)
  return Item.equal(a, b, false) && JSON.stringify(a?.components ?? []) === JSON.stringify(b?.components ?? [])
    && JSON.stringify(a?.removedComponents ?? []) === JSON.stringify(b?.removedComponents ?? [])
}
// Рюкзак клиента расходится с сервером после окон — и это не наша догадка, а
// замер: крафт на верстаке ответил «сделал кирку, верстак вернул», рюкзак
// тела показывал ни кирки, ни верстака, а /clear @s crafting_table 0 на
// сервере — «Found 1». Кампания 2026-09-25 из-за этого дважды «теряла»
// верстак и отказывалась крафтить.
//
// Две дыры mineflayer 4.37.1 (lib/plugins/inventory.js):
// * Пока открыто окно, обновления наших клеток идут в window.slots, а
//   bot.inventory копируется из окна только при НАШЕМ closeWindow
//   (copyInventory). Когда окно закрывает СЕРВЕР (сломали верстак — меню
//   стало недействительным), обработчик 'close_window' просто обнуляет
//   currentWindow — всё, что пришло в окно, пропадает из bot.inventory.
// * Сервер присылает полный рюкзак, только если клиент ошибся номером
//   состояния: ServerGamePacketListenerImpl.handleContainerClick при
//   stateId != menu.getStateId() зовёт broadcastFullState (байткод
//   paper-1.21.11). Клик мимо окна (slot -999) пустым курсором ничего не
//   делает — им и просим полную копию.

function install (bot) {
  if (bot.__ndInvSync) return
  bot.__ndInvSync = true
  const Item = require('prismarine-item')(bot.registry)
  const states = new Map<number, number>()
  menuStates.set(bot, states)
  if (bot.version === '1.21.11') {
    // Ordinary Mineflayer clicks predict Slot components, but this protocol
    // expects component hashes. A late carried correction can outlive the
    // next, correctly predicted empty cursor (which gets no separate echo).
    // As with confirmedClick, request a full receipt after EACH real click.
    const write = bot._client.write
    bot._client.write = function (...args) {
      if (args[0] === 'window_click') args[1] = { ...args[1], stateId: -2 }
      return write.apply(this, args)
    }
  }
  let activeWindow = bot.currentWindow
  bot.on('windowOpen', window => {
    if (window === bot.currentWindow) activeWindow = window
  })
  bot._client.on('open_window', packet => states.delete(packet.windowId))

  // Modern full-state packets include the carried stack. Mineflayer updates
  // the slots but omits it, leaving crafting to use a stale predicted cursor.
  bot._client.on('window_items', packet => {
    const previous = states.get(packet.windowId)
    const distance = previous === undefined ? 1 : (packet.stateId - previous + 32768) % 32768
    if (Number.isInteger(packet.stateId) && distance > 0 && distance < 16384) states.set(packet.windowId, packet.stateId)
    const window = bot.currentWindow || bot.inventory
    if (packet.windowId === window.id && 'carriedItem' in packet) {
      window.selectedItem = Item.fromNotch(packet.carriedItem)
      bot.inventory.selectedItem = window.selectedItem
    }
  })
  bot._client.on('set_cursor_item', packet => {
    const item = Item.fromNotch(packet.contents)
    bot.inventory.selectedItem = item
    if (bot.currentWindow) bot.currentWindow.selectedItem = item
  })

  // Сервер закрыл окно — перенести наши клетки из окна, как при своём закрытии.
  bot._client.prependListener('close_window', (packet) => {
    const w = bot.currentWindow
    if (!w || w.id !== packet.windowId || w.inventoryStart === undefined) return
    try {
      const off = w.inventoryStart - bot.inventory.inventoryStart
      for (let i = w.inventoryStart; i < w.inventoryEnd; i++) {
        const item = w.slots[i]
        const slot = i - off
        if (item) item.slot = slot
        if (!Item.equal(bot.inventory.slots[slot], item, true)) bot.inventory.updateSlot(slot, item)
      }
    } catch {}
  })

  // Mineflayer's ordinary clicks update only the open window's cursor. Its
  // close copies inventory slots, but not that cursor: an earlier carriedItem
  // packet can otherwise leave a phantom stack that also blocks resync forever.
  bot.on('windowClose', window => {
    if (window && window === activeWindow) {
      activeWindow = null
      if (!bot.currentWindow) bot.inventory.selectedItem = window.selectedItem
    }
    // Keep a genuinely occupied cursor guarded; an old close must not clear a
    // newer menu or a stack picked up after returning to the player inventory.
    gameClock.wall.setTimeout(() => resync(bot), 150)
  })
}

function resync (bot, afterCraft = false, closedInventory = false) {
  if (!bot || !bot._client || bot.currentWindow || bot.inventory?.selectedItem && !closedInventory || bot._ndCrafting && !afterCraft) return false
  try {
    const Item = require('prismarine-item')(bot.registry)
    bot._client.write('window_click', {
      windowId: 0,
      stateId: -2,
      slot: -999,
      mouseButton: 0,
      mode: 0,
      changedSlots: [],
      cursorItem: Item.toNotch(null)
    })
    return true
  } catch {
    return false
  }
}

async function refresh (bot, timeoutMs = 2000, closeGrid = false) {
  if (!bot?._client || bot.currentWindow || bot.inventory?.selectedItem && !closeGrid) return false
  install(bot)
  const Item = closeGrid ? require('prismarine-item')(bot.registry) : null
  return new Promise<boolean>(resolve => {
    let timer
    const finish = (ok: boolean) => { gameClock.wall.clearTimeout(timer); bot._client.removeListener('window_items', onItems); bot.removeListener('end', onEnd); resolve(ok) }
    const onItems = packet => {
      if (packet.windowId !== 0) return
      if (closeGrid && (!('carriedItem' in packet) || Item.fromNotch(packet.carriedItem) ||
        !Array.isArray(packet.items) || packet.items.length < 5 || packet.items.slice(1, 5).some(item => Item.fromNotch(item)))) return
      finish(true)
    }
    const onEnd = () => finish(false)
    bot._client.on('window_items', onItems)
    bot.once('end', onEnd)
    timer = gameClock.wall.setTimeout(() => finish(false), timeoutMs)
    try {
      // InventoryMenu.removed returns the cursor and grid before the next TCP-ordered click.
      if (closeGrid) bot._client.write('close_window', { windowId: 0 })
      if (!resync(bot, true, closeGrid)) finish(false)
    } catch { finish(false) }
  })
}

async function confirmedClick(bot, slot: number, mouseButton = 0, mode = 0, timeoutMs = 3000) {
  if (!bot?._client || bot.version !== '1.21.11') throw new Error('confirmed inventory clicks require 1.21.11')
  install(bot)
  const window = bot.currentWindow || bot.inventory
  if (!Number.isInteger(slot) || slot < 0 && slot !== -999 || slot >= window.slots.length) throw new Error('confirmed inventory click needs a real slot or the outside drop slot')
  if (mode !== 0 || ![0, 1].includes(mouseButton)) throw new Error('confirmed inventory click supports ordinary left/right clicks')
  const Item = require('prismarine-item')(bot.registry)
  const carried = window.selectedItem
  const current = window.slots[slot]
  const expected = (item, count: number) => count > 0 ? { item, count } : null
  let nextSlot = expected(current, current?.count ?? 0)
  let nextCursor = expected(carried, carried?.count ?? 0)
  if (slot === -999 && carried) {
    nextCursor = expected(carried, mouseButton === 0 ? 0 : carried.count - 1)
  } else if (!carried && current) {
    const taken = mouseButton === 0 ? current.count : Math.ceil(current.count / 2)
    nextSlot = expected(current, current.count - taken)
    nextCursor = expected(current, taken)
  } else if (carried && (!current || sameStack(bot, carried, current))) {
    const moved = Math.min(mouseButton === 0 ? carried.count : 1, carried.stackSize - (current?.count ?? 0))
    nextSlot = expected(carried, (current?.count ?? 0) + moved)
    nextCursor = expected(carried, carried.count - moved)
  } else if (carried && current) {
    nextSlot = expected(carried, carried.count)
    nextCursor = expected(current, current.count)
  } else throw new Error('confirmed inventory click would do nothing')
  const baseline = menuStates.get(bot)?.get(window.id)
  const matches = (actual, wanted) => wanted ? actual?.count === wanted.count && sameStack(bot, actual, wanted.item) : !actual
  return new Promise<void>((resolve, reject) => {
    let finished = false
    let timer
    let gameTimer
    const finish = (error?: Error) => {
      if (finished) return
      finished = true
      gameClock.wall.clearTimeout(timer)
      if (gameTimer !== undefined) gameClock.clearTimeout(gameTimer)
      bot._client.removeListener('window_items', onItems)
      bot.removeListener('end', onEnd)
      bot.removeListener('windowClose', onClose)
      if (error) reject(error); else resolve()
    }
    const onItems = packet => {
      if (packet.windowId !== window.id || !('carriedItem' in packet)) return
      if (baseline !== undefined && Number.isInteger(packet.stateId)) {
        const distance = (packet.stateId - baseline + 32768) % 32768
        if (distance === 0 || distance >= 16384) return
      }
      // A craft result click can generate two full states. A late state from
      // the preceding click must not confirm storing its carried output.
      if ((slot === -999 || matches(Item.fromNotch(packet.items[slot]), nextSlot)) && matches(Item.fromNotch(packet.carriedItem), nextCursor)) finish()
    }
    const onEnd = () => finish(new Error('inventory click disconnected'))
    const onClose = closed => { if (closed?.id === window.id) finish(new Error('inventory window closed during click')) }
    bot._client.on('window_items', onItems)
    bot.once('end', onEnd)
    bot.on('windowClose', onClose)
    timer = gameClock.wall.setTimeout(() => finish(new Error(`server did not confirm click ${slot} in window ${window.id}`)), timeoutMs)
    // И по игровым тикам: сервер отвечает window_items в тик клика, а 3 с реального на ускоренной ферме — 45–150 игр. с на
    // каждый пропавший ответ (s8 07.10: крафт палок 110 с, досок 63 с на --lockstep). ND_CLICK_CONFIRM_GAME_MS=0 — только реальное.
    const gameMs = Number(process.env.ND_CLICK_CONFIRM_GAME_MS ?? 2000)
    if (gameMs > 0) gameTimer = gameClock.setTimeout(() => finish(new Error(`server did not confirm click ${slot} in window ${window.id} (${gameMs} game ms)`)), Math.min(timeoutMs, gameMs))
    try {
      // The real click is processed before broadcastFullState on a state-id
      // mismatch (ServerGamePacketListenerImpl 1.21.11). Do not predict slots.
      bot._client.write('window_click', { windowId: window.id, stateId: -2,
        slot, mouseButton, mode, changedSlots: [], cursorItem: Item.toNotch(window.selectedItem) })
    } catch (error) { finish(error as Error) }
  })
}

// Сетка 2×2 рюкзака. Сорванный крафт (mineflayer «missing ingredient» — гонка с
// обновлением рюкзака) оставляет ингредиенты в клетках 1-4 меню рюкзака, а
// bot.inventory.items() считает только 9..44 — доски «пропадают»: кампания
// 2026-09-26 за три неудачных крафта палок потеряла 8 досок, и каменную кирку
// стало не из чего собрать. Сервер отдаёт сетку обратно, когда клиент
// закрывает меню рюкзака: handleContainerClose → ServerPlayer.doCloseContainer
// → InventoryMenu.removed → clearContainer(player, craftSlots) (исходник
// 1.21.11, extracted_minecraft_data). Живой клиент шлёт то же, закрывая
// инвентарь клавишей E. Пока открыто другое окно — не трогаем: закрыли бы его.
function flushGrid (bot) {
  if (!bot || !bot._client || bot.currentWindow) return false
  try {
    bot._client.write('close_window', { windowId: 0 })
    gameClock.wall.setTimeout(() => resync(bot), 150)
    return true
  } catch {
    return false
  }
}

module.exports = { install, resync, refresh, flushGrid, confirmedClick, sameStack }
