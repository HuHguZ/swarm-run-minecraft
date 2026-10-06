import { chooseRepairPair, type RepairItem } from './repair-policy'
const clock = require('../game-clock')
const pick = require('../pick')
const { confirmedClick, refresh } = require('../invsync')
const { putSlotAway, putCursorAway } = require('../craft-confirmed')

function enchantments(bot: any, item: any): Record<string, number> {
  const component = item.componentMap?.get('enchantments')?.data
  const list = component?.enchantments ?? (Array.isArray(component) ? component : item.enchants)
  const result: Record<string, number> = {}
  for (const entry of Array.isArray(list) ? list : []) {
    const id = entry.id ?? entry.enchantment
    const name = entry.name ?? (typeof id === 'number' ? bot.registry.enchantments[id]?.name : String(id).replace(/^minecraft:/, ''))
    if (!name) throw new Error('неизвестные чары: автоматическое объединение запрещено')
    result[name] = entry.level ?? entry.lvl ?? 1
  }
  const nbt = item.nbt?.value
  for (const entry of nbt?.Enchantments?.value?.value ?? nbt?.ench?.value?.value ?? []) {
    const id = entry.id?.value
    const name = typeof id === 'number' ? bot.registry.enchantments[id]?.name : String(id).replace(/^minecraft:/, '')
    if (!name) throw new Error('неизвестные NBT чары')
    result[name] = entry.lvl?.value ?? 1
  }
  if (component && !Array.isArray(list) && Object.keys(component).some(key => key !== 'showTooltip')) throw new Error('нераспознанный компонент чар')
  return result
}

export function repairOptions(session: any, name?: string) {
  const bot = session.bot
  const facts: RepairItem[] = bot.inventory.items().filter((item: any) => item.maxDurability).map((item: any) => ({
    slot: item.slot, name: item.name, count: item.count, maxDamage: item.maxDurability,
    damage: item.durabilityUsed ?? 0, enchanted: Object.keys(enchantments(bot, item)).length > 0,
    modified: !!item.customName || item.componentMap?.has('trim') || item.componentMap?.has('custom_data')
  }))
  return chooseRepairPair(facts, name)
}

export async function repairItems(session: any, ctl: any, { item: name, planOnly = false }: any = {}) {
  const bot = session.bot
  if (bot.version !== '1.21.11') throw new Error('repair проверен только для 1.21.11')
  if (!planOnly && !(await refresh(bot))) throw new Error('repair: сервер не подтвердил инвентарь до ремонта')
  const pair = repairOptions(session, name)
  if (!pair) return { repaired: false, why: 'нет двух совместимых повреждённых предметов без потери полезной прочности' }
  const ids = ['anvil', 'chipped_anvil', 'damaged_anvil'].map(name => bot.registry.blocksByName[name]?.id).filter(Number.isInteger)
  const anvilBlock = pair.mechanism === 'anvil' ? bot.findBlock({ matching: ids, maxDistance: 4 }) : null
  if (planOnly) return { repair: pair, executable: pair.mechanism === 'craft' || !!anvilBlock, why: pair.mechanism === 'anvil' && !anvilBlock ? 'зачарованные предметы требуют видимой наковальни' : null }
  if (bot.currentWindow || bot.inventory.selectedItem) throw new Error('repair: курсор или окно заняты')
  const eye = pick.eyeOf(bot)
  const visibleAnvil = anvilBlock && (() => { const delta = anvilBlock.position.offset(.5, .5, .5).minus(eye); const hit = pick.blockOnRay(bot, eye, delta.scaled(1 / delta.norm()), delta.norm() + .8); return hit?.pos.equals(anvilBlock.position) })()
  if (pair.mechanism === 'anvil' && !visibleAnvil) throw new Error('зачарованные предметы ремонтируются только на доступной наковальне')
  const first = bot.inventory.slots[pair.first.slot]
  const second = bot.inventory.slots[pair.second.slot]
  const initialCount = bot.inventory.items().filter((item: any) => item.name === first.name).reduce((sum: number, item: any) => sum + item.count, 0)
  const protectedEnchants = { ...enchantments(bot, first) }
  for (const [name, level] of Object.entries(enchantments(bot, second))) protectedEnchants[name] = Math.max(protectedEnchants[name] ?? 0, level)
  let window = bot.inventory
  let cost: number | null = pair.mechanism === 'anvil' ? null : 0
  let actualPreview = false
  const onCost = (packet: any) => { if (window !== bot.inventory && packet.windowId === window.id && packet.property === 0) cost = packet.value }
  const onSlot = (packet: any) => { if (packet.windowId === window.id && packet.slot === (pair.mechanism === 'anvil' ? 2 : 0)) actualPreview = true }
  const onItems = (packet: any) => { if (packet.windowId === window.id) actualPreview = true }
  bot._client.on('craft_progress_bar', onCost)
  bot._client.on('set_slot', onSlot)
  bot._client.on('window_items', onItems)
  const resultSlot = pair.mechanism === 'anvil' ? 2 : 0
  const inputSlots = pair.mechanism === 'anvil' ? [0, 1] : [1, 2]
  const waitUntil = async (ready: () => boolean, milliseconds = 2500) => {
    const at = clock.now()
    while (!ready()) {
      if (ctl.aborted) throw new Error('repair прерван')
      if (clock.now() - at > milliseconds) throw new Error('repair: сервер не подтвердил результат')
      await clock.sleep(50)
    }
  }
  const alreadyCrafting = bot._ndCrafting
  bot._ndCrafting = true
  try {
    if (pair.mechanism === 'anvil') window = await bot.openAnvil(anvilBlock)
    if ((pair.mechanism === 'craft' ? [1, 2, 3, 4] : inputSlots).some(slot => window.slots[slot])) throw new Error('repair: ячейки уже заняты')
    for (const [index, original] of [first, second].entries()) {
      if (ctl.aborted) throw new Error('repair прерван до передачи вещей')
      const source = window.slots.find((item: any, slot: number) => slot >= window.inventoryStart && item?.name === original.name
        && item.durabilityUsed === original.durabilityUsed && JSON.stringify(enchantments(bot, item)) === JSON.stringify(enchantments(bot, original)))
      if (!source) throw new Error('repair: исходная вещь изменилась')
      await confirmedClick(bot, source.slot)
      if (ctl.aborted) throw new Error('repair прерван с вещью на курсоре')
      await confirmedClick(bot, inputSlots[index])
    }
    await waitUntil(() => actualPreview && !!window.slots[resultSlot] && cost !== null && (pair.mechanism !== 'anvil' || cost > 0))
    const preview = window.slots[resultSlot]
    if (preview.name !== pair.first.name || preview.count !== 1 || preview.durabilityUsed >= Math.min(pair.first.damage, pair.second.damage)) throw new Error('repair: сервер предложил неподходящую прочность')
    if (first.customName && JSON.stringify(first.customName) !== JSON.stringify(preview.customName)) throw new Error('repair: сервер изменит имя предмета')
    const afterEnchants = enchantments(bot, preview)
    for (const [name, level] of Object.entries(protectedEnchants)) if ((afterEnchants[name] ?? 0) < level) throw new Error(`repair: сервер потеряет чары ${name}`)
    if (pair.mechanism === 'craft' && (Object.keys(afterEnchants).length || preview.durabilityUsed !== pair.expectedDamage)) throw new Error('repair: результат special recipe не совпал с 1.21.11')
    if (cost! >= 40 || cost! < 0 || cost! > bot.experience.level) throw new Error(`repair: не хватает опыта либо слишком дорого (${cost})`)
    const paidCost = cost!
    const damage = preview.durabilityUsed
    if (ctl.aborted) throw new Error('repair прерван до получения результата')
    await putSlotAway(bot, window, resultSlot)
    await waitUntil(() => !window.slots[inputSlots[0]] && !window.slots[inputSlots[1]])
    const confirmedItems = window.slots.slice(window.inventoryStart, window.inventoryEnd).filter(Boolean)
    const repaired = confirmedItems.find((item: any) => item.name === pair.first.name && item.durabilityUsed === damage
      && Object.entries(protectedEnchants).every(([name, level]) => (enchantments(bot, item)[name] ?? 0) >= level))
    if (!repaired) throw new Error('repair: улучшенная вещь не подтверждена инвентарём')
    const finalCount = confirmedItems.filter((item: any) => item.name === first.name).reduce((sum: number, item: any) => sum + item.count, 0)
    if (finalCount !== initialCount - 1) throw new Error('repair: расход ровно двух вещей в одну не подтверждён')
    return { repaired: true, item: repaired.name, mechanism: pair.mechanism, damageBefore: [pair.first.damage, pair.second.damage], damage,
      xpCost: paidCost, freedSlots: 1, enchantments: enchantments(bot, repaired) }
  } finally {
    bot._client.removeListener('craft_progress_bar', onCost)
    bot._client.removeListener('set_slot', onSlot)
    bot._client.removeListener('window_items', onItems)
    if (window.selectedItem) { try { await putCursorAway(bot, window) } catch {} }
    for (const slot of inputSlots) if (window.slots[slot]) { try { await putSlotAway(bot, window, slot) } catch {} }
    if (window !== bot.inventory) { try { window.close() } catch {} }
    try { await refresh(bot) } catch {}
    bot._ndCrafting = alreadyCrafting
  }
}
