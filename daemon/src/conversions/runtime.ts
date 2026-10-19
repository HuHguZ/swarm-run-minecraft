import { planConversion, type ConversionPlan, type ConversionStep } from './planner'
import { conversionProvenance, guaranteedDrops } from './registry'

import * as clock from '../game-clock'
import { countItems, countOf } from '../items'
import pick = require('../pick')
const Vec3: typeof import('vec3').Vec3 = require('vec3')

export function craftStepMismatch(before: Record<string, number>, after: Record<string, number>, step: ConversionStep, pickups: Record<string, number> | null = null): string | null {
  for (const item of new Set([...Object.keys(step.inputs), step.output.item])) {
    const received = item !== step.output.item && Number.isSafeInteger(pickups?.[item]) && pickups[item] > 0 ? pickups[item] : 0
    const expected = (before[item] ?? 0) - (step.inputs[item] ?? 0) + (item === step.output.item ? step.output.count : 0) + received
    if ((after[item] ?? 0) !== expected) return `${item}: ожидал ${expected}, сервер подтвердил ${after[item] ?? 0}`
  }
  return null
}

const toolFacts = (bot: any, item: any) => ({ item: item.name, durabilityLeft: item.maxDurability - (item.durabilityUsed ?? 0), enchantments: {
  silk_touch: (require('../read') as typeof import('../read')).enchLevel(bot, item, 'silk_touch'),
  fortune: (require('../read') as typeof import('../read')).enchLevel(bot, item, 'fortune')
} })

export function planFor(session: any, item: string, count = 1): ConversionPlan {
  const bot = session.bot
  const mc = session.mcData ?? bot.registry
  const inventory = countItems(bot)
  const tools = bot.inventory.items().filter((i: any) => i.maxDurability).map((i: any) => toolFacts(bot, i))
    .sort((a: any, b: any) => b.enchantments.silk_touch - a.enchantments.silk_touch)
  const harvestTools = Object.fromEntries(Object.entries(mc.blocksByName).map(([name, block]: [string, any]) => [name,
    Object.keys(block.harvestTools ?? {}).map(id => mc.items[id]?.name).filter(Boolean)]))
  const containers: typeof import('../containers') = require('../containers')
  const fuels = containers.conversionFuels(bot)
  const table = !!bot.findBlock({ matching: mc.blocksByName.crafting_table.id, maxDistance: 3 })
  const furnace = !!bot.findBlock({ matching: mc.blocksByName.furnace.id, maxDistance: 3 })
  return planConversion(inventory, item, count, { tools, harvestTools, fuels, table, furnace })
}

function blockUnderAim(bot: any, block: any) {
  const eye = pick.eyeOf(bot)
  const delta = block.position.offset(.5, .5, .5).minus(eye)
  const length = delta.norm()
  const hit = pick.blockOnRay(bot, eye, delta.scaled(1 / Math.max(.001, length)), length + .8)
  return !!hit?.pos.equals(block.position) && length <= 4.5
}
async function placeAndHarvest(session: any, ctl: any, step: ConversionStep) {
  const bot = session.bot
  const { placeBlockAt, withTimeout }: typeof import('../build') = require('../build')
  const actions: typeof import('../actions') = require('../actions')
  const perBlock = step.output.count / step.times
  let tool: any = null
  if (step.tool) {
    tool = bot.inventory.items().find((i: any) => i.name === step.tool &&
      guaranteedDrops(step.block!, toolFacts(bot, i))?.some(drop => drop.item === step.output.item && drop.count === perBlock))
    if (!tool || (tool.maxDurability && tool.maxDurability - (tool.durabilityUsed ?? 0) < step.times)) throw new Error('инструмент для преобразования отсутствует или почти сломан')
  }
  for (let n = 0; n < step.times; n++) {
    if (ctl.aborted) throw new Error('преобразование прервано')
    const before = countOf(bot, step.output.item)
    const feet = bot.entity.position.floored()
    let pos: any = null
    for (const [dx, dz] of [[1, 0], [-1, 0], [0, 1], [0, -1], [2, 0], [-2, 0], [0, 2], [0, -2]]) {
      const at = feet.offset(dx, 0, dz)
      const block = bot.blockAt(at)
      const floor = bot.blockAt(at.offset(0, -1, 0))
      if (!block || block.name !== 'air' || floor?.boundingBox !== 'block') continue
      const result = await placeBlockAt(bot, at, { item: step.block, honest: true, timeoutMs: 2000 })
      if (result.ok && !result.already) { pos = at; break }
    }
    if (!pos) throw new Error(`не нашёл видимой безопасной грани для ${step.block}`)
    const block = bot.blockAt(pos)
    if (!block || block.name !== step.block || !blockUnderAim(bot, block) || !bot.canDigBlock(block)) throw new Error('поставленный блок недоступен прицелу')
    if (tool) await bot.equip(tool, 'hand')
    else await bot.unequip('hand')
    if (ctl.aborted || !blockUnderAim(bot, block)) throw new Error('преобразование прервано до разрушения')
    await bot.lookAt(block.position.offset(.5, .5, .5), true)
    const receipt = bot.version === '1.21.11' && bot._client
      ? (require('../environments/dig-receipt') as typeof import('../environments/dig-receipt')).watchDigReceipt(bot, pos, () => ctl.aborted) : null
    try {
      await withTimeout(bot.dig(block, false), 12000, 'блок не разрушен')
      if (receipt && await receipt.settle() !== 'confirmed') throw new Error('сервер не подтвердил разрушение блока преобразования')
    } finally { receipt?.close() }
    await clock.sleep(300)
    if (countOf(bot, step.output.item) < before + perBlock) await actions.collectNearbyDrops(bot, ctl, { radius: 4, timeoutMs: 3000, appearMs: 3000, from: new Vec3(pos.x, pos.y, pos.z) })
    if (countOf(bot, step.output.item) < before + perBlock) throw new Error(`drop ${step.output.item} не подтверждён инвентарём: ${JSON.stringify({
      held: bot.heldItem?.name, block: bot.blockAt(pos)?.name, position: bot.entity.position,
      collect: bot._ndLastCollect, nearby: (Object.values(bot.entities) as any[]).filter(e => e.name === 'item' && e.position?.distanceTo(pos) < 5)
        // @ts-expect-error drops не экспортирует stackOf (и он берёт одну сущность): stack всегда undefined; поведение не трогаю.
        .map(e => ({ id: e.id, position: e.position, stack: (require('../drops') as typeof import('../drops')).stackOf?.(bot, e) }))
    })}`)
  }
}

export async function craftConverted(session: any, ctl: any, params: any): Promise<any | null> {
  if (!params.planOnly && session.bot.version === '1.21.11') {
    if (ctl.aborted) throw new Error('цепочка преобразования прервана')
    if (!(await (require('../invsync') as typeof import('../invsync')).refresh(session.bot, 2000, true))) throw new Error('сервер не подтвердил инвентарь перед преобразованием')
  }
  const plan = planFor(session, params.item, params.count ?? 1)
  if (params.planOnly) return { conversionPlan: plan, provenance: conversionProvenance }
  if (!plan.ok) return null
  const completed: Array<ConversionStep & { pickups?: { items: Record<string, number>; from: number; to: number; epoch: number } }> = []
  let last: any = null
  for (const step of plan.steps) {
    if (ctl.aborted) throw new Error('цепочка преобразования прервана')
    const before = countItems(session.bot)
    const pickupBaseline = step.mechanism === 'craft' ? (require('../drops') as typeof import('../drops')).pickupMark(session.bot) : null
    const ownedBeforeSlots = [5, 6, 7, 8, 45].reduce((sum, slot) => sum + (session.bot.inventory.slots[slot]?.name === step.output.item ? session.bot.inventory.slots[slot].count : 0), 0)
    for (const [name, count] of Object.entries(step.inputs)) if ((before[name] ?? 0) < count) throw new Error(`инвентарь изменился: для ${step.id} нужно ${name}×${count}`)
    if (step.mechanism === 'place-dig') { await placeAndHarvest(session, ctl, step); last = { item: step.output.item, made: step.output.count } }
    else if (step.mechanism === 'smelt') last = await (require('../containers') as typeof import('../containers')).smelt(session, ctl,
      { item: Object.keys(step.inputs).find(name => name !== step.fuel), count: step.times, fuel: step.fuel, timeoutSeconds: Math.min(600, step.times * 10 + 30) })
    else last = await (require('../actions') as typeof import('../actions')).craft(session, ctl, { item: step.output.item, count: step.output.count,
      spendReserve: params.spendReserve, conversionStep: true, conversionInputs: step.inputs, conversionTimes: step.times })
    const after = countItems(session.bot)
    let ownedAfter = after[step.output.item] ?? 0
    const ownedBefore = (before[step.output.item] ?? 0) + ownedBeforeSlots
    for (const slot of [5, 6, 7, 8, 45]) if (session.bot.inventory.slots[slot]?.name === step.output.item) ownedAfter += session.bot.inventory.slots[slot].count
    if (ownedAfter < ownedBefore + step.output.count) throw new Error(`результат ${step.id} не подтверждён: ожидал +${step.output.count} ${step.output.item}`)
    let pickups: Record<string, number> | null = null
    if (step.mechanism === 'craft') {
      pickups = (require('../drops') as typeof import('../drops')).pickupDelta(session.bot, pickupBaseline)
      const mismatch = craftStepMismatch({ ...before, [step.output.item]: ownedBefore }, { ...after, [step.output.item]: ownedAfter }, step,
        pickups)
      if (mismatch) throw new Error(`расход ${step.id} не подтверждён: ${mismatch}`)
    }
    completed.push(pickups && Object.keys(pickups).length ? { ...step, pickups: { items: pickups,
      from: pickupBaseline.sequence + 1, to: session.bot._ndDrops.pickupSequence, epoch: pickupBaseline.epoch } } : step)
    session.lastConversion = { item: params.item, completed, provenance: conversionProvenance }
  }
  return { ...last, conversion: { item: params.item, steps: completed, expanded: plan.expanded, provenance: conversionProvenance } }
}
