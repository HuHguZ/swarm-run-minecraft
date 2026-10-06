import { consumeHand } from './pvp/hand-policy'

interface Item { name: string; type?: number; slot?: number }
interface Bot {
  heldItem?: Item | null; health?: number; usingHeldItem?: boolean; entity?: { onGround?: boolean; elytraFlying?: boolean }
  inventory: { slots?: Array<Item | null>; items(): Item[] }
  _ndReflexSession?: { tactics?: { snapshot(): { threatLevel: number } } }
  _ndHandLock?: { on(): boolean }; _ndClutch?: { lastDecision?: { action?: string } }
  activateItem?: (offHand?: boolean) => void
  equip(item: Item, destination: string): Promise<void>
}

export function consumeInOffhand(bot: Bot): boolean {
  if (!bot.activateItem || !bot.inventory.slots || bot.entity?.onGround !== true || bot.usingHeldItem) return false
  const off = bot.inventory.slots[45]?.name ?? null
  const threat = bot._ndReflexSession?.tactics?.snapshot().threatLevel ?? 0
  return consumeHand({ main: bot.heldItem?.name ?? null, off, safe: threat === 0, grounded: true,
    clutchActive: !!bot._ndHandLock?.on() || bot._ndClutch?.lastDecision?.action === 'clutch',
    shieldNeeded: threat > 0 && off === 'shield', totemNeeded: off === 'totem_of_undying' && (bot.health ?? 20) < 12 }) === 'off-hand'
}

export async function restoreOffhand(bot: Bot, previous: Item | null | undefined, used: Item): Promise<void> {
  const current = bot.inventory.slots?.[45]
  if (current && current.name !== used.name || !previous || previous.name === used.name) return
  const item = bot.inventory.items().find(candidate => previous.type !== undefined ? candidate.type === previous.type : candidate.name === previous.name)
  if (item) await bot.equip(item, 'off-hand')
}
