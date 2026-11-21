// Рой: передачи своим, поиск врага, ветер в паре, позиция (стрельба, стройка, отход), перевес лучника.
import { ownedCount, assessSwarmFight } from '../../../daemon/src/swarm'
import { enemyDefense } from '../../../daemon/src/swarm/fight'
import { BOW_FULL_TICKS, arrowSpeedAt, arrowOutcomes, afterDefense } from '../../../daemon/src/pvp/damage-model'
import { powerOf } from '../../../daemon/src/pvp/arms-graph'
import { fittingLoot, type StorageItem } from '../../../daemon/src/pvp/arms-loot'
import { WEAPON, distance, cellKey, blockCount, underArrowFire, withOffHand } from './common'
import { currentTurn } from './lifecycle'
import { antidoteDeliveryValue } from './antidotes'
import { withinArena } from '../../../daemon/src/navigation/parkour/model'
import { arenaRoom, windStanceOverlaps } from '../../../daemon/src/combat/team-wind'
import type { SwarmDriverCtx } from './common'

// N: S reached the pillar with 31 arrows. A 35s upper-gallery offer priced only its alternative on foot.
export function perchShotBeforeLoot(sw: SwarmDriverCtx, b, context, enemies, assaultTarget?: string) {
  const { task, board, member } = context, frame = sw.pos[b.name], data = task.data
  const pearl = b.swarmPearlPost
  const post = assaultTarget && frame?.p ? { at: frame.p } : pearl && pearl.round === sw.generation && frame?.p && distance(frame.p, pearl.at) < 1
    ? pearl : b.swarmPosition?.purpose === 'ranged' ? b.swarmPosition : null
  if (!sw.arms || task.kind !== 'loot' || !Number.isFinite(data?.lootSeconds) || !(data.improvement > 0) ||
      data.commanded || data.finishing || data.digAvoid?.length || !task.position || !post ||
      !frame?.inv?.bow || distance(frame.p, post.at) >= 1 || frame.gliding || frame.rescuing || /^(Tactical|Emergency)$/.test(frame.tactics?.owner || '')) return null
  const now = sw.now(), arrows = frame.attackArrows ?? (frame.inv.arrow || 0) + (frame.inv.spectral_arrow || 0)
  if (!arrows || !(now - frame.sightAt >= 0 && now - frame.sightAt < 1000) || underArrowFire(b, now)) return null
  const separated = p => assaultTarget ? p.y > frame.p.y + 6 : p.y + 6 < frame.p.y
  const rangedDanger = e => ['bow', 'aerial', 'blast'].includes(e.threat) || /bow|trident|end_crystal|respawn_anchor/.test(e.equipment?.weapon || '')
  const divingWeapon = e => !e.equipment?.weapon || /mace|_spear/.test(e.equipment.weapon)
  if (enemies.some(e => {
    if (now - e.seenAt >= 1000 || distance(frame.p, e.position) > 32) return false
    return !separated(e.position) || rangedDanger(e) || assaultTarget && (e.id !== assaultTarget || divingWeapon(e))
  })) return null

  let best
  for (const enemy of enemies) {
    if (assaultTarget && enemy.id !== assaultTarget) continue
    const seen = board.visualSighting(enemy.id, b.name)
    if (!seen || seen.seenAt !== frame.sightAt || !separated(seen.position)) continue
    if (assaultTarget && (rangedDanger(seen) || divingWeapon(seen))) continue
    const range = distance(frame.p, seen.position)
    if (range > 32) continue
    const signature = [seen.position.x, seen.position.y, seen.position.z, arrows].map(Math.floor).join(',')
    if (sw.blocked(b, `perchShot:${b.name}:${enemy.id}`, signature)) continue
    const speed = arrowSpeedAt(3, range), defense = enemyDefense(seen.equipment?.armor ? seen : { equipment: { unknownArmorSlots: 4 } })
    const damage = arrowOutcomes({ speed, power: member.ench?.power || 0, crit: true })
      .reduce((sum, o) => sum + o.p * afterDefense(o.raw, 'projectile', defense), 0)
    const shots = Math.ceil((enemy.hpEstimate ?? 20) / damage)
    const seconds = (shots * BOW_FULL_TICKS / 20 + range / (speed * 20)) / Math.min(1, arrows / shots)
    if (!best || seconds < best.seconds) best = { target: enemy.id, position: seen.position, seconds, signature }
  }
  if (!best) return null
  // Returning to a designated perch also costs time. A shot from the ordinary arena floor needs no return trip.
  const back = assaultTarget ? null : sw.travelCost(b, post.at, task.position)
  const lootPrice = (data.lootSeconds + (back ? Math.min(data.lootSeconds, back.walk, back.fly) : 0)) / (1 + data.lootTier) / data.improvement
  return best.seconds < lootPrice ? { ...best, at: post.at, pearl: post === pearl } : null
}

// Своё у получателя — с ракетами и зарядами во второй руке (подобранная ракета ложится туда).
const held = (state: any, item: string) => ownedCount({ ...(state || {}), inventory: withOffHand(state?.inventory, state?.offHand) }, item)

export function supplyRoomBlocked(sw: SwarmDriverCtx, recipient, item: string) {
  const key = `supplyRoom:${recipient.name}:${item}`
  return sw.retries?.has(key) && sw.blocked(recipient, key, JSON.stringify(sw.pos[recipient.name]?.inv))
}

function fittingDelivery(fresh: any[], name: string, count: number) {
  const storage: (StorageItem | null)[] = fresh[1].detail?.storage
  if (!Array.isArray(storage)) {
    // An older status envelope can still prove a lower bound: each item could occupy its own slot.
    const held = Object.values<number>(fresh[1].state.inventory).reduce((sum, qty) => sum + qty, 0)
    return Math.min(count, Math.max(0, 36 - held))
  }
  const donor = fresh[0]?.detail?.storage
  const available = Array.isArray(donor) ? donor.filter(s => s?.name === name) : []
  // toss(type) may select any of the donor's stacks; merging into an existing stack requires a plain offer.
  if (!available.length) return Math.min(count, storage.filter(s => !s).length)
  if (available.some(s => s.plain !== true)) {
    // With mixed components even two same-name source stacks may require two empty slots.
    const slots = storage.filter(s => !s).length
    const safe = available.map(s => s.count).sort((a, b) => a - b).slice(0, slots)
    return Math.min(count, safe.reduce((n, amount) => n + amount, 0))
  }
  return fittingLoot([{ name, count }], storage)[0]?.count || 0
}

export function swarmPosition (sw: SwarmDriverCtx) {
  const { now, bots, pos, arena, log, alive, transfers, telemetry, visited, teamOf, fighting, lootSafe, lootArena, go, renew, detail, execute, buildGo, buildStep, boardOf } = sw
  const panic = (...a: any[]) => sw.panic(...a)
  async function transfer(b, context) {
    const task = (transfers.get(teamOf(b)) || []).find(t => t.assignedTo === b.name && t.status !== 'done')
    const recipient = task && bots.find(o => o.name === task.data.recipient)
    // Неудавшаяся передача — снова, когда пара на новом месте (получатель ушёл с места неудачи), а не через 30 с (21.10).
    if (!task || recipient && (sw.blocked(recipient, `transfer:${task.id}`, task.data.item) || supplyRoomBlocked(sw, recipient, task.data.item))) return false
    const round = sw.generation
    const antidote = /^(honey_bottle|milk_bucket)$/.test(task.data.item)
    const medical = () => antidoteDeliveryValue(sw, b.name, recipient?.name, task.data.item, context.members, context.board.enemies())
    const coverAt = () => !pos[recipient?.name]?.p ? 0 : recipient.swarmPosition && distance(pos[recipient.name].p, recipient.swarmPosition.at) < 1.5 ? Math.max(0, Math.min(1, recipient.swarmPosition.cover || 0)) :
      recipient.swarmTask?.data?.hide && recipient.swarmTask.position && distance(pos[recipient.name].p, recipient.swarmTask.position) < 3 ? 1 : 0
    // Сидящего в укрытии на шифте можно снабдить; бой, бег и рефлекс опасности не останавливаем.
    const available = () => !!recipient && (!antidote || medical() > 0) && !pos[b.name]?.rescuing && !pos[recipient.name]?.rescuing && currentTurn(sw, b, round) && alive(recipient.name) && !panic(recipient) &&
      !((/^(lava_escape|dodge_blast|clear_web)$/.test(recipient.last?.m || '') || recipient.shieldHold && recipient.last?.m === 'swarm_hold') && recipient.last?.pending !== false) &&
      (medical() > 0 || (!fighting(recipient) || coverAt() > 0 && recipient.last?.m === 'swarm_hold') &&
      context.board.enemies().every(e => now() - e.seenAt >= 1500 || distance(e.position, pos[recipient.name].p) >= 8))
    const meetingScore = () => {
      if (antidote) return medical()
      if (!WEAPON.test(task.data.item) && !/_(helmet|chestplate|leggings|boots)$/.test(task.data.item)) return Infinity
      const m = pos[recipient.name], member = context.members.find(a => a.id === recipient.name)
      if (!member) return -Infinity
      const owned = [...Object.entries(m.inv || {}).map(([name, count]: any) => ({ name, count })), ...Object.values(m.armor || {}).filter(Boolean).map((name: string) => ({ name })), ...(m.enchants || [])]
      const strength = powerOf(owned).total, gain = powerOf([...owned, { name: task.data.item, count: task.data.count }]).total - strength
      const foes = context.board.enemies(), fresh = Math.max(0, ...foes.map(e => 1 - (now() - e.seenAt) / context.board.enemyTtlMs))
      const travel = sw.travelCost(b, m.p), seconds = Math.min(travel.walk, travel.fly)
      const body = { ...member, position: m.p, health: m.hp ?? member.health, inventory: m.inv, armor: m.armor }
      const survival = assessSwarmFight(body, foes, [body]).survivalSeconds
      // Выигрыш слабому против риска ждать: время доставки, живучесть, свежесть врага и доля укрытия.
      return gain / Math.max(1, strength) - fresh * (1 - coverAt()) * seconds / Math.max(.05, survival)
    }
    if (!available() || recipient.swarmReserved) return false
    if (b.swarmTask?.kind === 'loot' && b.swarmTask.data?.weak && !lootSafe(b, pos[recipient.name].p)) return false
    // Аренда покрывает местный поиск укрытия, перелёт и подход; после долгого дела проверяем её снова.
    const claim = context.board.claim(task.id, b.name, 60000)
    if (!claim) return false
    let ok = false, physicalFailure = false
    const reservation = {}
    const ownsRecipient = () => recipient.swarmReserved === reservation && currentTurn(sw, b, round) && alive(recipient.name)
    const releaseRecipient = () => { if (recipient.swarmReserved === reservation) delete recipient.swarmReserved }
    const stopRecipient = async () => {
      if (!available() || recipient.swarmReserved && recipient.swarmReserved !== reservation) return false
      recipient.swarmReserved = reservation
      const paused = await recipient.c.call(antidote ? 'antidote_pause' : 'stop').catch(() => null)
      if (antidote && (!paused || !detail(paused)?.ready)) return false
      const until = now() + 3000, wallUntil = performance.now() + 3000
      while (recipient.swarmExecuting && ownsRecipient() && !pos[recipient.name]?.rescuing && now() < until && performance.now() < wallUntil) await new Promise(resolve => setTimeout(resolve, 50))
      return !recipient.swarmExecuting && ownsRecipient() && available()
    }
    try {
      // Останавливаем начатый поход до полёта: claim держит новые ходы, но не отменяет старый goto.
      if (!await stopRecipient()) return false
      releaseRecipient()
      if (meetingScore() <= 0) {
        const member = context.members.find(m => m.id === recipient.name)
        if (!member) return false
        await positionStep(recipient, { ...context, member }, 'recover')
        if (!available() || meetingScore() <= 0) return false
      }
      // Во время доставки claim держит место, а обычные ходы и рефлексы получателя остаются доступны при угрозе.
      if (!context.board.renew(task.id, b.name, claim.claim.token, 45000)) return false
      const meeting = { ...pos[recipient.name].p }
      if (distance(pos[b.name].p, meeting) > 2.5) {
        const approach = await go(b, meeting, 1.5, 8, lootArena(b), true)
        if (approach?.status === 'interrupted') return false
      }
      if (!available() || distance(pos[recipient.name].p, meeting) > 1.5 || meetingScore() <= 0) return false
      if (!await stopRecipient()) return false
      const actors = [b, recipient]
      let initialOwned = task.data.recipientBeforeOwned ?? task.data.recipientBefore
      const readPair = async () => {
        const fresh = await Promise.all(actors.map(o => o.c.call('status', { items: true })))
        if (!ownsRecipient()) return null
        for (const [i, o] of actors.entries()) {
          const state = fresh[i]?.state
          if (state?.pos) pos[o.name].p = fresh[i].detail?.at || state.pos
          if (state?.inventory) pos[o.name].inv = withOffHand(state.inventory, state.offHand)
        }
        if (!fresh[1]?.state?.inventory) return null
        const before = held(fresh[1].state, task.data.item)
        initialOwned ??= before
        const count = Math.min(task.data.count, initialOwned + task.data.count - before)
        const have = fresh[0]?.state?.inventory?.[task.data.item] || 0
        return count > 0 && have - task.data.reserve >= count && available() ? { before, count, fits: fittingDelivery(fresh, task.data.item, count), bothLocated: fresh.every(o => o?.state?.pos) } : null
      }
      let fresh = await readPair()
      if (!fresh) return false
      // Доска запаздывает за физикой: после посадки доводим бросок по свежим координатам, не расширяем дальность tossTo.
      if (distance(pos[b.name].p, pos[recipient.name].p) > 2.5) {
        const approach = await go(b, pos[recipient.name].p, 1.5, 3, lootArena(b))
        if (approach?.status === 'interrupted') return false
        fresh = await readPair()
        if (!fresh) return false
      }
      if (!available() || distance(pos[recipient.name].p, meeting) > 1.5) return false
      if (!renew(context.board, b, claim)) return false
      const inReach = () => distance(pos[b.name].p, pos[recipient.name].p) <= 3
      let sent = 0
      const toss = async () => {
        if (fresh.fits < fresh.count) {
          if (!ownsRecipient() || !available() || underArrowFire(recipient, now())) return null
          await recipient.c.call('assist', { mode: 'prepare_pickup', ally: b.name, item: task.data.item }).catch(() => null)
          fresh = await readPair()
          if (!fresh || !ownsRecipient() || !available() || underArrowFire(recipient, now()) || !inReach() || !renew(context.board, b, claim)) return null
          if (!fresh.fits) {
            // A rearrangement can free a slot without changing totals. Recheck after a normal 3 s walk budget even then.
            sw.failed(recipient, `supplyRoom:${recipient.name}:${task.data.item}`, JSON.stringify(pos[recipient.name].inv), now() + 3000)
            return null
          }
        }
        sent = fresh.fits
        return detail(await b.c.call('assist', { mode: 'toss', ally: recipient.name, item: task.data.item, count: sent, arena }).catch(e => ({ why: e.message })))
      }
      let r = inReach() ? await toss() : { ok: false, outOfReach: true }
      if (!r) return false
      if (r.outOfReach && !r.ok) {
        // A failed distance check precedes the drop. The stationary recipient can
        // walk the last safe stretch once; an ambiguous toss is never repeated.
        fresh = await readPair()
        if (!fresh?.bothLocated || recipient.swarmReserved !== reservation) return false
        const to = pos[b.name].p, pathArena = lootArena(recipient)
        const canWalk = () => !fighting(recipient) && !underArrowFire(recipient, now()) && !coverAt() && !recipient.swarmTask?.data?.hold && lootSafe(recipient, to)
        if (!canWalk() || !renew(context.board, b, claim)) return false
        if (!withinArena(recipient, to, pathArena, pos[recipient.name].p) || !(sw.travelCost(recipient, to).walk <= 3)) { physicalFailure = true; return false }
        const approach = await go(recipient, to, 1.5, 3, pathArena)
        if (approach?.status === 'interrupted') return false
        fresh = await readPair()
        if (!fresh?.bothLocated || recipient.swarmReserved !== reservation || !canWalk() || !renew(context.board, b, claim)) return false
        if (!inReach()) { physicalFailure = true; return false }
        r = await toss()
        if (!r) return false
      }
      if (!currentTurn(sw, b, round)) return true
      // Вещь уже на земле. Если получатель уклоняется, проверяем пассивный подбор по его сумке.
      const canCollect = ownsRecipient() && available() && !underArrowFire(recipient, now())
      const pu = r.ok && canCollect ? detail(await recipient.c.call('assist', { mode: 'pickup', item: task.data.item, ownedTarget: fresh.before + sent, arena }).catch(e => ({ why: e.message }))) : null
      if (!currentTurn(sw, b, round)) return true
      const result = await recipient.c.call('status')
      if (!currentTurn(sw, b, round)) return true
      const received = r.ok === true && held(result?.state, task.data.item) - fresh.before >= sent
      if (result?.state?.inventory && pos[recipient.name]) pos[recipient.name].inv = withOffHand(result.state.inventory, result.state.offHand)
      if (result?.state?.antidote && pos[recipient.name]) pos[recipient.name].antidote = { ...result.state.antidote, receivedAt: now() }
      if (result?.state?.armor && pos[recipient.name]) pos[recipient.name].armor = result.state.armor
      const donor = await b.c.call('status')
      if (!currentTurn(sw, b, round)) return true
      if (donor?.state?.inventory && pos[b.name]) pos[b.name].inv = withOffHand(donor.state.inventory, donor.state.offHand)
      if (donor?.state?.antidote && pos[b.name]) pos[b.name].antidote = { ...donor.state.antidote, receivedAt: now() }
      if (donor?.state?.armor && pos[b.name]) pos[b.name].armor = donor.state.armor
      if (received && (sent < fresh.count ? renew(context.board, b, claim) : context.board.ack(task.id, b.name, { token: claim.claim.token, confirmed: true }))) telemetry.transfers++
      log(`📦 ${b.name} → ${recipient.name}: ${task.data.item}×${sent}, ${received ? 'получено' : 'не подтверждено'}${received ? '' : ` (${r.ok ? `бросил, не подобрал: ${pu?.why || '?'}` : r.why || r.error || '?'})`}`)
      ok = received; physicalFailure = !received && (!r.ok || canCollect && ownsRecipient() && available())
      return true
    } finally {
      // Не вышло (не дошёл, далеко, не подобрал) — пара ждёт нового места (Codex 15.10: 40 отказов «далеко 5.0» за 3 мин).
      if (round === sw.generation) { if (ok) sw.cleared(`transfer:${task.id}`); else if (physicalFailure) sw.failed(recipient, `transfer:${task.id}`, task.data.item) }
      releaseRecipient(); context.board.release(task.id, b.name, claim.claim.token)
    }
  }
  const searchLegs = new Set<{ marks: Map<string, number>; key: string }>()
  const searchCell = p => `${Math.round(p.x / 4)},${Math.floor(p.y / 2)},${Math.round(p.z / 4)}`
  // away — враги, от которых он отходит: обход только в их противоположную полусферу (оторвавшийся «искал» прямо к ним).
  async function search(b, context, away: { position: { x: number; z: number } }[] = []) {
    const team = teamOf(b), marks = visited.get(team) || new Map()
    visited.set(team, marks)
    const m = pos[b.name], index = context.members.findIndex(o => o.id === b.name)
    let pathArena = b.swarmTask?.kind === 'loot' ? lootArena(b) : arena
    const round = sw.generation, from = { ...m.p }, legSeconds = 4
    const mark = p => {
      const key = searchCell(p)
      marks.delete(key)
      marks.set(key, now())
      if (marks.size > 256) marks.delete(marks.keys().next().value)
    }
    mark(m.p)
    const candidates = []
    let blocked = false
    const offer = (at, range, occupied = false) => {
      if (distance(at, from) < range + 1) return
      // Match goto's endpoint and snapped-cell checks; away from one foe can enter another's exclusion.
      const snapped = { ...at, x: Math.floor(at.x) + .5, z: Math.floor(at.z) + .5 }
      if (![at, snapped].every(p => withinArena(b, p, pathArena))) return
      // An arbitrary sector beyond the rim needs a reported floor. Native parkour options already observed their support.
      if (range === 2 && pathArena.ellipse && arenaRoom(pathArena, snapped) < 0 &&
          !sw.placed?.get(team)?.has(cellKey({ x: Math.floor(at.x), y: Math.floor(at.y) - 1, z: Math.floor(at.z) }))) { blocked = true; return }
      const lastMiss = b.badSpots?.findLastIndex(p => p.from && distance(p.from, from) < 2 && distance(p, at) < 1) ?? -1
      if (range === 2 && lastMiss >= 0) { blocked = true; return }
      const toward = away.filter(e => (at.x - from.x) * (e.position.x - from.x) + (at.z - from.z) * (e.position.z - from.z) > 0).length
      candidates.push({ at, range, key: searchCell(at), toward, lastMiss, occupied })
    }
    const offerRing = (sectors, radius) => {
      for (let k = 0; k < sectors; k++) {
        const a = (k + index) * 2 * Math.PI / sectors
        offer({ x: Math.max(arena.x - arena.r + 3, Math.min(arena.x + arena.r - 3, from.x + Math.cos(a) * radius)), y: from.y, z: Math.max(arena.z - arena.r + 3, Math.min(arena.z + arena.r - 3, from.z + Math.sin(a) * radius)) }, 2)
      }
    }
    offerRing(8, 8)
    if (!candidates.length && blocked) {
      // На короткой галерее все дальние цели могут висеть в воздухе. Соседнюю опору должен увидеть сам разведчик.
      const key = 'searchSteps:' + b.name, owner = b.swarmTurnOwner, task = b.swarmTask
      if ((sw.cooldown.get(key) ?? -Infinity) > now()) return false
      sw.cooldown.set(key, now() + legSeconds * 1000)
      const reply = await b.c.call('parkour', { mode: 'options', timeoutSeconds: legSeconds }).catch(() => null)
      const latest = pos[b.name]
      if (!currentTurn(sw, b, round) || b.swarmTurnOwner !== owner || b.swarmTask !== task ||
          reply?.status !== 'done' || !latest?.p || latest.rescuing || distance(latest.p, from) >= .5) return false
      pathArena = b.swarmTask?.kind === 'loot' ? lootArena(b) : arena
      // A scout can finish its route and still stand on the landing. Use allies' latest own body reports.
      const at = now(), occupants = []
      for (const { id } of context.members) {
        if (id === b.name || !alive(id)) continue
        const ally = pos[id], age = at - Math.min(ally?.hpAskedAt, ally?.frameAt)
        if (ally?.p && ally.hp > 0 && ally.watchRound === latest.watchRound && age >= 0 && age < 1000) occupants.push(ally.p)
      }
      for (const { target } of detail(reply).options || []) {
        if (!target || ![target.x, target.y, target.z].every(Number.isFinite)) continue
        // Two .6-wide player bodies overlap at the intended stance, including while crouching.
        const occupied = occupants.some(p => Math.abs(p.x - target.x) < .6 && Math.abs(p.z - target.z) < .6 && Math.abs(p.y - target.y) < .6)
        if (!occupied || away.length) offer(target, .5, occupied)
      }
    }
    // Враги с двух сторон — все направления к кому-то: наименее плохое (к меньшему числу), а не стоять (DeepSeek, ревью 21.10).
    const busy = new Set([...searchLegs].filter(leg => leg.marks === marks).map(leg => leg.key))
    // В обычном поиске уже занятый сектор обследует товарищ. За четыре секунды можно пройти и второе кольцо.
    if (!away.length && busy.size && candidates.some(c => c.range === 2) && candidates.every(c => busy.has(c.key))) offerRing(16, 16)
    // При отходе двое вправе воспользоваться одним безопасным выходом.
    const options = away.length ? candidates : candidates.filter(c => !busy.has(c.key))
    const seen = c => busy.has(c.key) ? Infinity : marks.get(c.key) ?? -Infinity
    const chosen = options.sort((a, c) => a.toward - c.toward || Number(a.occupied) - Number(c.occupied) || a.lastMiss - c.lastMiss || seen(a) - seen(c))[0]
    if (!chosen) return false
    const leg = { marks, key: chosen.key }
    searchLegs.add(leg)
    telemetry.searches++
    try {
      const reply = await go(b, chosen.at, chosen.range, legSeconds, pathArena).catch(() => null)
      if (!currentTurn(sw, b, round) || reply?.status === 'interrupted') return
      const arrived = reply?.status === 'done' && detail(reply)?.arrived
      if (!arrived) {
        if (reply && !reply.notStarted) { (b.badSpots ||= []).push({ ...chosen.at, from }); b.badSpots = b.badSpots.slice(-32) }
        return false
      }
      mark([arrived.x, arrived.y, arrived.z].every(Number.isFinite) ? arrived : m.p)
      return true
    } finally { searchLegs.delete(leg) }
  }
  const freeHelper = o => !pos[o.name]?.rescuing && !sw.commandOwnsMovement?.(o) && !o.swarmTask?.data?.commanded && !fighting(o) && !panic(o)
  const windHelper = b => bots.filter(o => o !== b && teamOf(o) === teamOf(b) && alive(o.name) && !o.swarmReserved &&
    pos[o.name]?.p && pos[b.name]?.p && pos[o.name].inv?.wind_charge > 0 && distance(pos[o.name].p, pos[b.name].p) < 5 && freeHelper(o))
    .sort((a, c) => distance(pos[a.name].p, pos[b.name].p) - distance(pos[c.name].p, pos[b.name].p))[0]
  const helperReport = async o => {
    const own = await o.c.call('status', { physics: true }), physics = own?.detail?.physics
    return physics?.onGround && { id: o.name, position: physics.pos, velocity: physics.velocity, onGround: true, attributes: physics.attributes }
  }
  const reservedWindLandings = b => bots.filter(o => teamOf(o) === teamOf(b) && o.swarmWindReservation?.round === sw.generation)
    .map(o => o.swarmWindReservation.landing).filter(Boolean)
  async function pairedWind(b, context, at, attack: { enemy?: string; incomingDps?: number } = {}, priced?: { helper; report; plan }) {
    const { board } = context, m = pos[b.name], round = sw.generation
    if (m?.rescuing || sw.commandOwnsMovement?.(b)) return false
    const thrower = priced?.helper || windHelper(b)
    if (!thrower || !freeHelper(thrower) || priced && (priced.plan?.thrower?.id !== thrower.name ||
        !priced.plan.target || distance(priced.plan.target, at) > .01)) return false
    const key = `spear-wind:${b.name}`, signature = attack.enemy ? JSON.stringify([attack.enemy, at, thrower.name, pos[thrower.name]?.p, m.inv, m.hp, attack.incomingDps, context.members?.map(a => [a.id, a.position])]) : ''
    if (attack.enemy && sw.blocked?.(b, key, signature)) return false
    const preview = async () => {
      const report = priced?.report || await helperReport(thrower)
      if (!currentTurn(sw, b, round) || !alive(thrower.name)) return null
      if (!report) return null
      const dry = await execute(b, 'wind_receive', { thrower: report, to: at, ...attack, ...(priced && { plan: priced.plan }), arena, dryRun: true })
      if (!currentTurn(sw, b, round) || !alive(thrower.name)) return null
      if (!dry.plan) { if (attack.enemy && !dry.partial) sw.failed?.(b, key, signature); return null }
      return { report, dry }
    }
    // Combat rejection leaves the idle helper working; navigation keeps its existing exclusive claim throughout planning.
    let prepared = attack.enemy ? await preview() : null
    if (!currentTurn(sw, b, round) || attack.enemy && !prepared || pos[b.name]?.rescuing || thrower.swarmReserved || !freeHelper(thrower) || !alive(thrower.name)) return false
    if (!attack.enemy && reservedWindLandings(b).some(p => windStanceOverlaps(at, p))) return false
    const id = `wind-pair:${b.name}`
    board.upsert({ id, kind: 'goto', assignedTo: b.name, participants: [b.name, thrower.name], position: at, expiresAt: now() + 20000 })
    const claim = board.claim(id, b.name, 20000)
    if (!claim) return false
    const reservation = { round, landing: attack.enemy ? null : at }
    thrower.swarmReserved = true
    thrower.swarmWindReservation = reservation
    const ownsPair = () => currentTurn(sw, b, round) && thrower.swarmWindReservation === reservation && alive(thrower.name) &&
      !pos[b.name]?.rescuing && !sw.commandOwnsMovement?.(b) && freeHelper(thrower) && renew(board, b, claim)
    let acknowledged = false
    try {
      await thrower.c.call('stop')
      if (!ownsPair()) return false
      const until = now() + 5000, wallUntil = performance.now() + 5000
      while (thrower.swarmExecuting && now() < until && performance.now() < wallUntil && ownsPair()) await new Promise(resolve => setTimeout(resolve, 50))
      if (thrower.swarmExecuting || !ownsPair()) return false
      if (!prepared) prepared = await preview()
      if (!prepared || !ownsPair()) return false
      const { report, dry } = prepared
      if (!ownsPair()) return false
      const ready = await execute(thrower, 'wind_boost', { ally: b.name, plan: dry.plan, arena, ...(attack.enemy ? { prepareOnly: true } : { dryRun: true }) })
      if (!ready.ok || !ownsPair() || !Number.isFinite(dry.gameTick) || !Number.isFinite(ready.gameTick)) return false
      const startTick = Math.max(dry.gameTick, ready.gameTick) + (dry.plan.spear?.price.setupTicks ?? 40)
      let receive: any, boost: any
      if (attack.enemy) {
        let finished = false, step = 0
        const receiving = execute(b, 'wind_receive', { thrower: report, to: at, ...attack, plan: dry.plan, arena, startTick }).then(r => { finished = true; return r }, error => { finished = true; throw error })
        boost = { ok: false }
        while (!finished && ownsPair()) {
          const progress = detail(await b.c.call('wind_report', { pairProgress: true, startTick, afterStep: step }).catch(() => null))
          if (finished || !ownsPair()) break
          step = Math.max(step, progress?.executed || 0)
          if (!progress?.ok || !progress.plan?.progress) continue
          boost = await execute(thrower, 'wind_boost', { ally: b.name, plan: progress.plan, arena, startTick })
          if (boost.fired) break
        }
        receive = await receiving
      } else [receive, boost] = await Promise.all([
          execute(b, 'wind_receive', { thrower: report, to: at, ...attack, plan: dry.plan, arena, startTick }),
          execute(thrower, 'wind_boost', { ally: b.name, plan: dry.plan, arena, startTick })
        ])
      if (!ownsPair()) return false
      const ok = !!receive.ok && !!boost.ok && (!attack.enemy || !!receive.combat?.hit && !!receive.received && !!boost.launchConfirmed)
      acknowledged = board.ack(id, b.name, { token: claim.claim.token, confirmed: ok })
      if (ok && attack.enemy) sw.cleared?.(key)
      if (ok) log(attack.enemy ? `🌬 ${thrower.name} разогнал копьё ${b.name} → ${attack.enemy}: попадание подтверждено` : `🌬 ${thrower.name} подбросил ${b.name} на ${cellKey(at)}`)
      return ok ? receive : false
    } finally {
      if (thrower.swarmWindReservation === reservation) { delete thrower.swarmWindReservation; if (thrower.swarmReserved === true) delete thrower.swarmReserved }
      if (round === sw.generation && (acknowledged || board.release(id, b.name, claim.claim.token))) board.cancel(id)
    }
  }
  // Запрос позиции — по миру, а не раз в 20 с (21.10): занятая позиция держится, пока бот на ней, цель та же и враги те же;
  // неудача — до ухода бота с места или смены врагов (retry.ts). Не больше двух тяжёлых запросов разом — бюджет ЦП.
  async function positionStep(b, context, purpose) {
    const sceneOf = () => `${purpose}:${context.board.enemies().map(e => e.id).sort().join(',')}`
    const scene = sceneOf(), me = pos[b.name]?.p, occupied = b.swarmPosition?.occupied && b.swarmPosition
    const stillHere = at => { const feet = pos[b.name]?.p; return feet && at && feet.x === at.x && feet.y === at.y && feet.z === at.z }
    if (occupied) delete b.swarmPosition // Occupied footing must be confirmed again before the next construction action.
    const recheck = purpose === 'build' && occupied?.scene === scene && stillHere(occupied.at)
    const holding = !!me && b.swarmPosition?.purpose === purpose && b.swarmPosition.scene === scene && distance(me, b.swarmPosition.at) < 1.5
    const team = teamOf(b)
    const teamQueries = (sw.positionQueriesByTeam ??= new Map<string, number>())
    if ((teamQueries.get(team) || 0) >= 2 || holding) return false
    const helper = !recheck && windHelper(b), hp = helper && pos[helper.name].p
    const windLandings = hp ? reservedWindLandings(b) : []
    const attempt = hp ? `${scene}:wind:${helper.name}:${Math.floor(hp.x)},${Math.floor(hp.y)},${Math.floor(hp.z)}:${windLandings.map(cellKey).sort().join('|')}` : scene
    if (!recheck && sw.blocked(b, `position:${b.name}`, attempt)) return false
    if (!recheck) sw.failed(b, `position:${b.name}`, attempt)
    b.swarmBusyUntil = now() + 20000
    const round = sw.generation
    try {
      const m = pos[b.name], board = context.board
      let report: any = null, query: any
      teamQueries.set(team, (teamQueries.get(team) || 0) + 1)
      sw.positionQueries = (sw.positionQueries || 0) + 1
      try {
        report = helper && await helperReport(helper).catch(() => null)
        if (!currentTurn(sw, b, round)) return false
        query = await execute(b, 'swarm_position', { purpose, arena, enemies: board.enemies().map(e => ({ id: e.id })), radius: 12, limit: 6, reserve: context.member.reserve, budgetMs: 1500, ...(recheck && { currentBuildOnly: true }), ...(report && { windPartner: report, windLandings }) })
      } finally {
        const left = (teamQueries.get(team) || 1) - 1
        if (left > 0) teamQueries.set(team, left); else teamQueries.delete(team)
        sw.positionQueries = Math.max(0, (sw.positionQueries || 1) - 1)
      }
      if (!currentTurn(sw, b, round)) return false
      const candidates = query.observed ? query.candidates || [] : []
      // A visible player can leave the ledge within the shared launch preparation (40 game ticks).
      if (query.windOccupied) sw.failed(b, `position:${b.name}`, attempt, now() + 2000)
      // Место, куда не вышло, — плохое, пока бот там же, откуда пробовал (сторож арены так же: watch.ts).
      const reachable = candidates.filter(c => c.score > 0 && distance(c.at, m.p) > 2 && !(b.badSpots || []).some(p => p.from && distance(p.from, m.p) < 2 && distance(p, c.at) < 1))
      const here = query.observed && query.currentBuild
      if (purpose === 'build' && here?.highGround >= 3 && here.score > 0 && here.score >= (reachable[0]?.score ?? 0) &&
          scene === sceneOf() && stillHere(here.at) && blockCount(m.inv)) {
        b.swarmPosition = { ...here, purpose, scene, occupied: true, placedAt: now() }
        sw.cleared(`position:${b.name}`)
        return false // No movement occurred. The same turn can claim the first outpost cell.
      }
      let deck: ReturnType<typeof board.tasks> | undefined
      const checked = new Set<string>()
      for (const choice of reachable) {
        const method = [...choice.methods].sort((a, c) => a.cost - c.cost)[0]
        if (!method) continue
        // Walking back into an unfinished floor cell would occupy its only free placement volume again.
        if (purpose === 'build' && method.kind === 'walk' && sw.blueprints?.size) {
          deck ??= board.tasks().filter(t => {
            if (t.kind !== 'build' || t.status !== 'pending' || !t.position || !(t.data?.obstruction?.self || t.data?.obstruction?.entity)) return false
            const plan = sw.blueprints.get(board.team + ':' + t.data.blueprint)
            return plan?.kind === 'outpost' && t.position.y === plan.origin.y - 1 && distance(m.p, t.position) <= 4.5
          })
          const at = choice.at
          const floor = deck.find(t => !checked.has(t.id) && Math.abs(at.x - t.position.x - .5) < .8 && Math.abs(at.z - t.position.z - .5) < .8 &&
            at.y < t.position.y + 1 && at.y + 1.8 > t.position.y)
          if (floor) {
            checked.add(floor.id)
            const id = floor.data.blueprint, origin = sw.blueprints.get(board.team + ':' + id)?.origin
            if (origin && await buildStep(b, context, { kind: 'outpost', id, origin, fromHere: true }, new Set([cellKey(floor.position)]))) return true
            if (!currentTurn(sw, b, round)) return false
          }
        }
        let ok = false, actual
        if (method.kind === 'build' && method.plan?.kind === 'pillar') {
          const id = `pillar:${b.name}`, base = { x: Math.floor(m.p.x), y: Math.floor(m.p.y), z: Math.floor(m.p.z) }
          board.upsert({ id, kind: 'build', assignedTo: b.name, position: base, data: { block: method.params.item }, expiresAt: now() + 15000 })
          const claim = board.claim(id, b.name, 15000)
          if (!claim) continue
          try {
            const r = await execute(b, 'swarm_pillar', { ...method.params, arena, allies: context.members.map(a => a.id), timeoutSeconds: 12 })
            if (!currentTurn(sw, b, round)) return false
            ok = r.ok === true && r.at && distance(r.at, choice.at) < .6
            actual = r.at
            board.ack(id, b.name, { token: claim.claim.token, confirmed: ok, position: base, block: method.params.item })
          } finally { if (round === sw.generation) { board.release(id, b.name, claim.claim.token); board.cancel(id) } }
        } else if (method.kind === 'build') {
          const approach = await buildGo(b, method.plan.approach)
          if (!currentTurn(sw, b, round)) return false
          if (approach?.status === 'failed') continue
          const cell = method.plan.cells[0]
          await buildStep(b, context, { kind: 'platform', id: `platform:${cellKey(cell.at)}`, origin: cell.at, cells: method.plan.cells, protected: [method.plan.reference] })
          if (!currentTurn(sw, b, round)) return false
          if (!board.tasks().some(t => t.kind === 'build' && cellKey(t.position) === cellKey(cell.at) && t.status === 'done')) return true
          const moved = await buildGo(b, choice.at)
          actual = detail(moved).arrived
          ok = !!actual && distance(actual, choice.at) < .6
        } else {
          const needsHelper = method.skill === 'wind_receive'
          if (method.kind !== 'walk') {
            if (needsHelper && (!helper || !report)) continue
            if (needsHelper && (helper.swarmWindReservation || reservedWindLandings(b).some(p => windStanceOverlaps(choice.at, p)))) {
              // Another pair obtained the helper or its landing during the two native surveys.
              // Only this price expires; a genuine geometric refusal still lasts until the scene changes.
              sw.failed(b, `position:${b.name}`, attempt, now())
              continue
            }
            const pair = await pairedWind(b, context, choice.at, {}, needsHelper ? { helper, report, plan: method.plan } : undefined)
            if (!currentTurn(sw, b, round)) return false
            ok = !!pair; actual = pair && pair.at
            if (needsHelper && !ok) continue
          }
          if (!currentTurn(sw, b, round)) return false
          if (!ok && choice.at.y < m.p.y && m.p.y - choice.at.y <= 4 && Math.hypot(choice.at.x - m.p.x, choice.at.z - m.p.z) <= 3) {
            const ledge = await execute(b, 'ledge_to', { at: choice.at, arena, maxFallDamage: 0, timeoutSeconds: 5 })
            if (!currentTurn(sw, b, round)) return false
            ok = !!ledge.ok
            actual = ledge.at
          }
          if (!ok) {
            const r = await execute(b, method.skill, { ...method.params, arena, ...(method.kind === 'walk' ? { range: .25, surface: 'strict', timeoutSeconds: 6, _hunt: true } : {}) })
            ok = r.ok === true || r.reached === true || !!r.arrived && distance(r.arrived, choice.at) < .6
            actual = r.at || r.arrived
          }
        }
        if (!currentTurn(sw, b, round)) return false
        if (ok && (!actual || ![actual.x, actual.y, actual.z].every(Number.isFinite))) {
          const s = await b.c.call('status', { physics: true }); actual = s?.state?.pos || s?.detail?.physics?.pos
          if (!currentTurn(sw, b, round)) return false
          ok = !!actual && distance(actual, choice.at) < .6
        }
        if (!ok) { (b.badSpots ||= []).push({ ...choice.at, from: { ...m.p } }); b.badSpots = b.badSpots.slice(-32); continue }
        b.swarmPosition = { ...choice, purpose, scene, placedAt: now() }
        m.p = { ...actual }
        sw.cleared(`position:${b.name}`)
        board.recordFact(b.name, now(), { id: `rally:${b.name}`, kind: 'mark', position: choice.at }, 30000)
        log(`🏔 ${b.name}: ${purpose} → ${cellKey(choice.at)} (${method.kind})`)
        return true
      }
      return false
    } finally { if (round === sw.generation) delete b.swarmBusyUntil }
  }
  const rangedAdvantage = b => {
    const here = b.swarmPosition, m = pos[b.name], enemies = boardOf(b).enemies()
    return !!here && here.purpose === 'ranged' && m?.inv?.bow && (m.attackArrows ?? (m.inv.arrow || 0) + (m.inv.spectral_arrow || 0)) && distance(m.p, here.at) < 1 && enemies.length && enemies.every(e => now() - e.seenAt < 1000 && e.position.y + 6 < m.p.y && !['bow', 'aerial', 'blast'].includes(e.threat) && !/bow|trident|end_crystal|respawn_anchor/.test(e.equipment?.weapon || ''))
  }
  return { transfer, search, pairedWind, positionStep, rangedAdvantage }
}
