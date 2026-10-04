'use strict'
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

  // После любого закрытия окна — попросить у сервера полный рюкзак.
  bot.on('windowClose', () => setTimeout(() => resync(bot), 150))
}

function resync (bot) {
  if (!bot || !bot._client || bot.currentWindow) return false
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
    setTimeout(() => resync(bot), 150)
    return true
  } catch {
    return false
  }
}

module.exports = { install, resync, flushGrid }
