import { chooseAntidote, type AntidoteState, type AntidoteItem, type AntidoteChoice } from '../pvp/antidotes'
import type { SwarmMember } from './types'
import type { PvpPlan } from './plan-frame'
import { count, distance, hasShield } from './common'

const items: AntidoteItem[] = ['honey_bottle', 'milk_bucket']
type Stock = string[] | Record<string, number>
export type AntidoteMember = Pick<SwarmMember, 'id' | 'team' | 'health' | 'inventory' | 'reserve' | 'needs' | 'antidote'>
export interface AntidoteExchange {
  state: AntidoteState | null; choice: AntidoteChoice | null; need: AntidoteChoice | null;
  needs: Record<string, number>; reserve: Record<string, number>; using: boolean
}
function agedState(member: AntidoteMember, now: number): AntidoteState | null {
  const report = member.antidote
  if (!report?.state || !Array.isArray(report.state.effects) || !Number.isFinite(report.receivedAt) || !Number.isFinite(now) || now < report.receivedAt) return null
  const ageTicks = (now - report.receivedAt) / 50
  return { ...report.state, health: member.health, alive: member.health > 0 && report.state.alive !== false,
    effects: report.state.effects.map(fx => ({ ...fx, remainingTicks: fx.remainingTicks == null ? null : Math.max(0, fx.remainingTicks - ageTicks) })),
    inventory: Object.fromEntries(items.map(item => [item, member.inventory ? count(member.inventory, item) : count(report.state.inventory, item)])) as Record<AntidoteItem, number> }
}

/** Only fresh own reports supply effect duration; stock contains actually available team items. */
export function antidoteExchange(member: AntidoteMember, now: number, stock: Stock = []): AntidoteExchange {
  const state = agedState(member, now), needs: Record<string, number> = {}, reserve: Record<string, number> = {}
  const choice = state && chooseAntidote(state)
  const has = (item: AntidoteItem) => Array.isArray(stock) ? stock.includes(item) : count(stock, item) > 0
  const need = state && !choice && chooseAntidote({ ...state, deliveryTicks: 40,
    inventory: Object.fromEntries(items.map(item => [item, has(item) ? 1 : 0])) as Record<AntidoteItem, number> })
  if (choice) { needs[choice.item] = 1; reserve[choice.item] = 1 }
  else if (need) needs[need.item] = 1
  return { state, choice: choice || null, need: need || null, needs, reserve, using: !!state && !!member.antidote.using }
}

/** Pickup's forty ticks delay the recipient; the donor may resume after the toss. */
export function antidoteTransferValue(donor: AntidoteMember, recipient: AntidoteMember, item: string, now: number, deliveryTicks: number, exposure = 0): number {
  if (!items.includes(item as AntidoteItem) || donor.id === recipient.id || donor.team !== recipient.team || !(donor.health > 0) || !(recipient.health > 0) || !Number.isFinite(deliveryTicks) || deliveryTicks < 0) return 0
  const giving = antidoteExchange(donor, now), receiving = antidoteExchange(recipient, now)
  if (receiving.choice || !receiving.state || count(donor.inventory, item) <= Math.max(count(donor.reserve, item), count(giving.reserve, item), count(donor.needs, item))) return 0
  const quote = chooseAntidote({ ...receiving.state, deliveryTicks, exposurePerTick: Math.max(0, exposure),
    inventory: { honey_bottle: item === 'honey_bottle' ? 1 : 0, milk_bucket: item === 'milk_bucket' ? 1 : 0 } })
  if (!quote || quote.item !== item) return 0
  const donorWork = Math.max(0, deliveryTicks - 40), opportunity = Math.max(0, giving.state?.damagePerTick ?? .04) * donorWork
  return Math.max(0, quote.utility - opportunity)
}

export function pvpAntidotes(S: PvpPlan): void {
  const { team, enemies, plan, put } = S, now = S.board.now()
  const own = new Map(team.map(m => [m.id, antidoteExchange(m, now)]))
  const stock = Object.fromEntries(items.map(item => [item, team.reduce((n, m) => n + Math.max(0,
    count(m.inventory, item) - Math.max(count(m.reserve, item), count(own.get(m.id).reserve, item), count(m.needs, item))), 0)]))
  for (const m of team) {
    const prior = plan.get(m.id)
    if (prior && (prior.kind !== 'recover' || prior.data?.panic)) continue
    const exchange = antidoteExchange(m, now, stock), quote = exchange.choice || exchange.need
    if (!quote) continue
    const at = prior?.position || m.position
    const foe = [...enemies].filter(e => now >= e.seenAt && now - e.seenAt <= 1000).sort((a, b) => distance(at, a.position) - distance(at, b.position))[0]
    let cover: SwarmMember | undefined
    if (foe) {
      const dx = foe.position.x - at.x, dz = foe.position.z - at.z, length = Math.hypot(dx, dz) || 1
      const spot = { x: at.x + dx / length * 1.2, y: at.y, z: at.z + dz / length * 1.2 }
      const candidates = team.filter(a => a.id !== m.id && a.health > 0 && hasShield(a) && !plan.has(a.id) && !own.get(a.id).choice && !own.get(a.id).using).map(a => {
        const walk = distance(a.position, spot) / .215, work = walk + 5 + quote.drinkTicks + (exchange.choice ? 0 : 40), state = own.get(a.id).state
        const cost = work * (state?.damagePerTick ?? .04) + (walk + 5) * (state?.incomingPerTick ?? .05) * 20 / Math.max(1, a.health)
        return { member: a, utility: quote.utility - cost }
      }).filter(c => c.utility > 0).sort((a, b) => b.utility - a.utility || a.member.id.localeCompare(b.member.id))
      cover = candidates[0]?.member
      if (cover) put(cover, 'goto', { hold: 'shield', antidoteCover: m.id, target: foe.id, face: foe.position, range: .6 }, spot)
    }
    put(m, 'recover', { ...prior?.data, ally: m.id, antidote: { item: quote.item, ...(cover ? { cover: cover.id } : {}) } }, at)
  }
}
