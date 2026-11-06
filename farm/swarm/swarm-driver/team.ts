// Рой: команда — доска команды, состав и роли, наблюдение и обновление плана, речь в чат.
import { SwarmBoard, planPvp, planTransfers } from '../../../daemon/src/swarm'
import { pvpState, knownEnemies } from '../../../daemon/src/swarm/board'
import { healExchange, pickForager } from '../../../daemon/src/swarm/logistics'
import { antidoteExchange } from '../../../daemon/src/swarm/antidotes'
import { antidoteDeliveryValue } from './antidotes'
import { powerOf, weaponScore } from '../../../daemon/src/pvp/arms-graph'
import { shoveValue, SHOVE, type Edge } from '../../../daemon/src/swarm/shove'
import { WEAPON, BLOCK, FOOD, distance, cellKey } from './common'
import type { SwarmDriverCtx } from './common'

export function swarmTeam (sw: SwarmDriverCtx) {
  const { edgeOf, now, pos, bots, alive, aggressive, hostile, sandSpot, hideouts, perches, digSites, log, announce, holes, boards, blueprints, telemetry, plannedAt, planned, walls, cooldown, transfers } = sw
  const preempt = (...a: any[]) => sw.preempt(...a)
  // Яма на его полу или ниже; сравниваем её с естественным краем по смертельности и цене цепи.
  const edgeNear = (p, foe = {}) => {
    const gap = h => Math.hypot(h.x + .5 - p.x, h.z + .5 - p.z)
    const edges: Edge[] = holes.filter(h => (h.bottomY ?? h.y) <= p.y + .1 && p.y - (h.feetY ?? h.y + 1) < 1.6 && gap(h) > .1 && gap(h) <= 16)
      .map(h => ({ x: (h.x + .5 - p.x) / gap(h), z: (h.z + .5 - p.z) / gap(h), drop: h.drop ?? 7, at: gap(h) }))
    const natural = edgeOf?.(p)
    if (natural) edges.push(natural)
    const value = (e: Edge) => shoveValue(foe, e)
    return edges.sort((a, b) => Number(value(b) >= SHOVE) - Number(value(a) >= SHOVE) || value(b) / (1 + (b.at ?? 0)) - value(a) / (1 + (a.at ?? 0)))[0] || null
  }
  const teamOf = b => b.team || b.name
  const boardOf = b => {
    const team = teamOf(b)
    if (!boards.has(team)) boards.set(team, new SwarmBoard(team, () => now(), 8000))
    return boards.get(team)!
  }
  // Союзник в бою (свой fight, бой из уворота, враг вплотную) — не брать на обмен и ветер: assist/stop рвали его бой (Codex 15.10).
  const fighting = o => o.last?.m === 'fight' || o.swarmExecuting && /^(fight|flee)$/.test(o.swarmTask?.kind || '') ||
    !!pos[o.name]?.p && boardOf(o).enemies().some(e => now() - e.seenAt < 1000 && distance(e.position, pos[o.name].p) <= 3.5)
  const membersOf = b => {
    const roster = bots.filter(o => teamOf(o) === teamOf(b))
    const stock = [...new Set<string>(roster.filter(a => alive(a.name)).flatMap(a => Object.keys(pos[a.name]?.inv || {})))]
    // Номер в составе команды, а не среди живых: смерть одного не перетасовывает роли всех (ревью 13.10).
    const team = roster.filter(o => alive(o.name) && pos[o.name]?.p).map(o => member(o, roster.indexOf(o), stock, b))
    const forager = pickForager(team, sw.forager?.[teamOf(b)])
    if (forager && sw.forager?.[teamOf(b)] !== forager.id) { (sw.forager ||= {})[teamOf(b)] = forager.id; log(`🧺 ${teamOf(b)}: фуражир ${forager.id} — свои запасы отдаёт бойцам`) }
    return team
  }
  const member = (o, k, stock, b) => {
    const m = pos[o.name], inv = m.inv || {}, names = Object.keys(inv).filter(n => inv[n] > 0)
    const heal = Object.entries(m.potions || {}).some(([n, c]: any) => /^splash_.*(healing|regeneration)$/.test(n) && c > 0)
    const role = heal && k % 3 === 1 ? 'healer' : names.some(n => /_pickaxe$/.test(n)) && k % 3 === 0 ? 'miner-builder' : inv.bow && (m.attackArrows ?? (inv.arrow || 0) + (inv.spectral_arrow || 0)) && k % 2 ? 'ranged' : k % 3 === 2 ? 'flank' : 'fighter'
    const reserve: Record<string, number> = {}, needs: Record<string, number> = {}
    for (const n of names) reserve[n] = BLOCK.test(n) ? 16 : FOOD.test(n) ? 4 : WEAPON.test(n) || /_pickaxe$/.test(n) ? 1 : /potion|pearl|totem|wind_charge/.test(n) ? 1 : 0
    const weaponRating = n => Math.max(weaponScore(n), ...(m.enchants || []).filter(it => it.name === n && it.slot >= 9 && it.slot <= 44).map(it => weaponScore(n, it.ench)))
    const melee = names.filter(n => /(_sword|_axe)$/.test(n)).sort((a, b) => weaponRating(b) - weaponRating(a) || a.localeCompare(b))
    // Бросок выбирает по имени: зачарованный лучший экземпляр держим вместе с его тёзками.
    for (const n of melee) reserve[n] = n === melee[0] ? weaponRating(n) > weaponScore(n) ? inv[n] : 1 : 0
    // Одно копьё — ещё не наземный комплект; копьё и булаву донора для тарана/комбо не трогаем.
    const grounded = n => /(_sword|_axe)$|^(mace|trident)$/.test(n)
    const groundPower = Math.max(0, ...names.filter(grounded).map(weaponRating))
    if (!groundPower || o.swarmTask?.data?.rearm) for (const n of stock.filter(grounded)) if (weaponScore(n) > groundPower) needs[n] = 1
    if (!names.some(n => WEAPON.test(n))) for (const n of stock.filter(n => WEAPON.test(n) && !grounded(n))) needs[n] = 1
    for (const [slot, suffix] of Object.entries({ head: '_helmet', torso: '_chestplate', legs: '_leggings', feet: '_boots' })) {
      const armorSlot = { head: 5, torso: 6, legs: 7, feet: 8 }[slot]
      const rating = (name, onBody = false) => name ? Math.max(powerOf([{ name }]).armor, ...(m.enchants || [])
        .filter(it => it.name === name && (onBody ? it.slot === armorSlot : it.slot >= 9 && it.slot <= 44)).map(it => powerOf([it]).armor)) : 0
      const worn = m.armor?.[slot], packed = names.filter(n => n.endsWith(suffix))
      const owned = Math.max(rating(worn, true), ...packed.map(n => rating(n)))
      // Просим любое доступное улучшение: один редкий алмазный предмет не закрывает доставку лишнего железа.
      for (const n of stock.filter(n => n.endsWith(suffix))) if (powerOf([{ name: n }]).armor > owned) needs[n] = 1
      for (const n of packed) reserve[n] = rating(n) === owned && owned > rating(worn, true) ? rating(n) > powerOf([{ name: n }]).armor ? inv[n] : 1 : 0
    }
    if (inv.bow || inv.crossbow) needs.arrow = 16
    // Ракеты (пользователь 25.10: «между собой ракетами должны делиться»): у кого элитры — держит 8 и просит до 8 (3 из них —
    // запас на спасение из пропасти, elytra/consts RESCUE_ROCKETS), у кого элитр нет — отдаёт все.
    if (inv.elytra || m.armor?.torso === 'elytra') { needs.firework_rocket = 8; reserve.firework_rocket = Math.min(inv.firework_rocket || 0, 8) } else reserve.firework_rocket = 0
    if (role === 'miner-builder') needs[[...blueprints].find(([key]) => key.startsWith(teamOf(b) + ':'))?.[1]?.material || 'cobblestone'] = 16
    if (m.hp < 16 && !names.some(n => FOOD.test(n))) needs.cooked_beef = 4
    healExchange(m.hp, inv, reserve, needs)
    // Подъём (пользователь 14.10: «залез наверх — бегают внизу, не строятся, не ищут кирку; блоков нет — делать всё, чтобы
    // добыть»): враг выше на 4+, а у меня оружие, но ни кирки, ни блоков на столб (высота + 4) — нужда в блоках (песок поля);
    // принесут передачи от добытчиков (планировщик, gather). Добытчик своё не держит — отдаёт всё.
    const up = onslaught(o) || o.swarmTask?.data?.finishing ? Math.max(0, ...boardOf(o).enemies().filter(e => now() - e.seenAt < 15000).map(e => e.position.y - m.p.y)) : 0
    const blocks = names.filter(n => BLOCK.test(n)).reduce((s, n) => s + (inv[n] || 0), 0)
    if (up > 4 && names.some(n => WEAPON.test(n)) && !names.some(n => /_pickaxe$/.test(n)) && blocks < up + 4) needs.sand = Math.min(64, Math.ceil(up) + 6 - blocks + (inv.sand || 0))
    // Добытчик (дело gather) своё не держит — пока это его дело, а не 20 с после взятия (повтор по миру, 21.10).
    if (o.swarmTask?.data?.gather) for (const n of names) if (BLOCK.test(n)) reserve[n] = 0
    const worn = Object.values(m.armor || {}).filter(Boolean).length
    const strength = m.hp * (1 + (names.some(n => WEAPON.test(n)) ? 1 : 0)) * (1 + worn * .25)
    const weapon = melee[0] || names.find(n => /(_spear)$|^(mace|trident)$/.test(n))
    const ench = { knockback: Math.max(0, ...(m.enchants || []).filter(it => it.name === weapon).map(it => it.ench?.knockback || 0)), sharpness: Math.max(0, ...(m.enchants || []).filter(it => it.name === weapon).map(it => it.ench?.sharpness || 0)), protection: (m.enchants || []).filter(it => it.slot >= 5 && it.slot <= 8).reduce((sum, it) => sum + (it.ench?.protection || 0), 0) }
    // Левая рука (щит, тотем) в рюкзак не входит: без неё надетый щит для доски «пропадал», и кольцо не строилось.
    const offHand = typeof m.offHand === 'string' ? m.offHand : m.offHand?.item || undefined
    if (offHand === 'shield') reserve.shield = 1
    // Заряды ветра — к булаве (пользователь 14.10: «грозу ветра сливают, просто стреляют в игрока ей, хотя надо с булавой
    // комбинировать»): у кого булава, тот свои держит и просит ещё — подброс и удар сверху; у прочих один — на выход из ямы.
    // И паутину (22.10: «паутиной и булавой добивание»): прижать его перед ударом (smashSetupTurn) — у прочих её берут передачи.
    if (inv.mace) { reserve.wind_charge = inv.wind_charge || 0; needs.wind_charge = 8; needs.cobweb = 2 }
    const member = { id: o.name, team: teamOf(o), position: m.p, health: m.hp, food: m.food, strength, role, canHeal: heal, inventory: inv, attackArrows: m.attackArrows, potions: m.potions || {}, reserve, needs, armor: m.armor || {}, offHand, weapon, ench, antidote: m.antidote }
    const medical = antidoteExchange(member, now(), stock)
    Object.assign(needs, medical.needs); Object.assign(reserve, medical.reserve)
    return member
  }
  const pincerSent = new Map<string, { key: string; at: number }>()
  const lanceWebSent = new Map<string, { key: string; at: number }>()
  const lanceWebTrace = new Map<string, string>()
  const webSight = new Map<string, { target: string | null; at: number }>()
  const allocationSent = new Map<string, { key: string; at: number }>()
  const pincerTarget = o => o.last?.m === 'fight' && o.last.pending === true ? o.last.p?.target : null
  const pincerKit = o => {
    const m = pos[o.name]
    return !!m?.p && (m.inv?.elytra > 0 || m.armor?.torso === 'elytra') &&
      Object.entries(m.inv || {}).some(([name, count]) => /_spear$/.test(name) && Number(count) > 0)
  }
  // seenAt — когда спросили (наблюдение не старше запроса статуса), без него — сейчас.
  const observe = (b, sightings, seenAt?: number) => {
    const board = boardOf(b), at = Number.isFinite(seenAt) ? Math.min(seenAt!, now()) : now()
    board.setMembers(membersOf(b))
    for (const e of sightings || []) if (hostile(b, e.id) && board.observe(b.name, at, e)) telemetry.observed++
    preempt(b)
    // Сначала воздушный эскорт: пеший фланг иначе резервировал всех элитровых до выбора облётчика.
    sw.windWing?.(b, sightings)
    sw.windFlank?.(b, sightings)
    sw.sentries?.(b, sightings)
    sw.arrowBoost?.(b, sightings)
    sw.pearlUpTest?.(b, sightings)
    void sw.windObserve?.(b, sightings, at).catch(e => log(`🌬 ${b.name}: ${String(e.message).slice(0, 100)}`))
    const target = pincerTarget(b)
    webSight.set(b.name, { target: sightings?.some(e => e.id === target && e.visible === true) ? target : null, at })
    const pair = target ? bots.filter(o => alive(o.name) && teamOf(o) === teamOf(b) &&
      pincerTarget(o) === target && pincerKit(o)).sort((a, c) => a.name.localeCompare(c.name)).slice(0, 2) : []
    const leader = pair.length === 2 && pair[1] === b ? pair[0] : null
    const key = leader ? sw.generation + ':' + target + ':' + leader.name : ''
    const sent = pincerSent.get(b.name)
    if ((key && (sent?.key !== key || at - sent.at >= 1000)) || (!key && sent?.key)) {
      pincerSent.set(b.name, { key, at })
      void b.c.call('team_hint', leader ? { target, from: { ...pos[leader.name].p } } : {})
        .catch(() => pincerSent.delete(b.name))
    }
    const foe = target && board.enemies().find(e => e.id === target && at - e.seenAt < 1000)
    const fresh = o => !!pos[o.name]?.p && alive(o.name) && at - (pos[o.name].observedAt ?? -Infinity) < 1000
    const lancer = target && bots.some(o => o !== b && teamOf(o) === teamOf(b) && fresh(o) &&
      pincerTarget(o) === target && pos[o.name].gliding && pos[o.name].lance?.target === target &&
      /^(таран: разбег|таран: заход)$/.test(pos[o.name].lance.phase))
    const helpers = foe && lancer ? bots.filter(o => teamOf(o) === teamOf(b) && fresh(o) &&
      !pos[o.name].gliding && pincerTarget(o) === target && pos[o.name].inv?.cobweb > 0 &&
      webSight.get(o.name)?.target === target && at - webSight.get(o.name)!.at < 1000 &&
      distance(pos[o.name].p, foe.position) < 12)
      .sort((a, c) => distance(pos[a.name].p, foe.position) - distance(pos[c.name].p, foe.position) ||
        a.name.localeCompare(c.name)) : []
    const webKey = helpers[0] === b ? sw.generation + ':' + target : ''
    if (process.env.ND_LANCE_WEB_TRACE === '1' && target && pos[b.name]?.inv?.cobweb > 0) {
      const reason = !foe ? 'no_fresh_target' : !lancer ? 'no_allied_lance' : !helpers.length ? 'no_eligible_helper' : helpers[0] === b ? 'selected' : 'other_helper'
      const visible = webSight.get(b.name)?.target === target, gliding = !!pos[b.name]?.gliding
      const key = [sw.generation, target, reason, visible, gliding, ...helpers.map(o => o.name)].join(':')
      if (lanceWebTrace.get(b.name) !== key) {
        lanceWebTrace.set(b.name, key)
        log('[lance-web] ' + JSON.stringify({ stage: 'decision', where: 'driver', at, helper: b.name, target, reason, lancer: !!lancer, visible, gliding,
          distance: foe ? Math.round(distance(pos[b.name].p, foe.position) * 10) / 10 : null, helpers: helpers.map(o => o.name) }))
      }
    }
    const webSent = lanceWebSent.get(b.name)
    if ((webKey && (webSent?.key !== webKey || at - webSent.at >= 250)) || (!webKey && webSent?.key)) {
      lanceWebSent.set(b.name, { key: webKey, at })
      if (process.env.ND_LANCE_WEB_TRACE === '1')
        log('[lance-web] ' + JSON.stringify({ stage: 'send', helper: b.name, target: webKey ? target : null }))
      void b.c.call('team_hint', { lanceWeb: webKey ? { target } : null })
        .then(reply => {
          if (process.env.ND_LANCE_WEB_TRACE === '1')
            log('[lance-web] ' + JSON.stringify({ stage: 'ack', helper: b.name, status: reply?.status, accepted: reply?.detail?.lanceWeb ?? null }))
        })
        .catch(() => {
          lanceWebSent.delete(b.name)
          if (process.env.ND_LANCE_WEB_TRACE === '1') log('[lance-web] ' + JSON.stringify({ stage: 'send_failed', helper: b.name, target: webKey ? target : null }))
        })
    }
  }
  const refresh = (b) => {
    const board = boardOf(b), team = teamOf(b), members = membersOf(b)
    for (const [key, blueprint] of blueprints) if (key.startsWith(team + ':') && blueprint.expiresAt && blueprint.expiresAt <= now()) {
      for (const t of board.tasks().filter(t => t.data?.blueprint === key.slice(team.length + 1))) board.cancel(t.id)
      blueprints.delete(key)
    }
    board.setMembers(members)
    // cl28b: убитый копьём соперник ещё 6 с держал бой убившего — доска помнила его зрение до срока.
    for (const o of bots) if (teamOf(o) !== team && !alive(o.name)) board.forget(o.name)
    if (now() - (plannedAt.get(team) || 0) >= 500 || !planned.has(team)) {
      const was = board.doctrineState()?.doctrine, held = board.teamFight?.engage, a0 = board.assault?.since, e0 = board.assaultEnded?.at
      // Дефицит блоков на подъём: нужды лезущих минус то, что у своих сверх запаса, — сколько добытчиков снять (gather).
      const need = members.reduce((s, a) => s + Object.entries(a.needs || {}).filter(([n]) => n === 'sand').reduce((t, [n, c]: any) => t + Math.max(0, c - (a.inventory?.[n] || 0)), 0), 0)
      const spare = members.reduce((s, a) => s + Object.entries(a.inventory || {}).filter(([n]) => n === 'sand' && !a.needs?.[n]).reduce((t, [n, c]: any) => t + Math.max(0, c - (a.reserve?.[n] ?? 16)), 0), 0)
      const onslaughtNow = aggressive || !!pvpState(board).strongFew
      const gather = onslaughtNow && sandSpot && need > spare ? { item: 'sand', deficit: need - spare, spot: sandSpot } : undefined
      // Боты — по ленте смертей; один человек в соло — весь состав врага, а не повод отменять лут ради добивания.
      const rivals = bots.filter(o => teamOf(o) !== team && (!hostile || hostile(b, o.name)))
      const humans = [...new Set<string>(sw.humanNames?.() || [])].filter(name => !bots.some(o => o.name === name) && hostile?.(b, name))
      // Лента смертей раунда (открытое знание): кто сколько наших убил — рой учится, что навалом его не взять (race.ts strongFew).
      const killsBy: Record<string, number> = { ...sw.pastKills.get(team) }
      for (const d of sw.drops()) if (d.team === team && d.by) killsBy[d.by] = (killsBy[d.by] || 0) + 1
      planned.set(team, planPvp(board, members, { foesLeft: rivals.length ? rivals.filter(o => alive(o.name)).length + humans.length : undefined, killsBy, quorum: Math.min(2, Math.max(1, members.length)), doctrine: process.env.SWARM_DOCTRINE as any || undefined, aggressive, hideouts, perches, gather, edgeOf: edgeNear,
        // Лестницы — выключены, пока столбы берутся из перемещения, а не подтверждённой кладки (арена 36: «стена кончилась»,
        // крафт рвут рефлексы — трое ботов вне боя впустую). ARENA_LADDERS=1 — включить.
        // Точки (стена лестницы, яма, засада) — закрыты, пока споткнувшийся на них стоит там же или у раскрытой засады враг
        // (retry.ts siteOpen), а не 8/4/15 с.
        ladderSites: process.env.ARENA_LADDERS === '0' ? [] : [...walls.values()].filter(t => !t.done && sw.siteOpen('ladder:' + t.key)),
        digSites: digSites ? p => digSites(p).filter(s => sw.siteOpen('hole:' + cellKey(s)) && !holes.some(h => h.x === s.x && h.z === s.z && h.y >= s.y - (s.blocks?.length ?? 2) + 1 && (h.bottomY ?? h.y) <= s.y)) : undefined, campSpots: onslaughtNow ? hideouts.filter(s => sw.siteOpen('camp:' + cellKey(s), board.enemies())) : undefined }))
      const chosen = board.doctrineState()?.doctrine, fight = board.teamFight
      if (chosen && chosen !== was) { log(`🧭 ${team}: приём ${was || '—'} → ${chosen}`); announceTeam(`🧭 приём: ${DOCTRINE_RU[chosen] || chosen}`, 'aqua') }
      // В чат игры проходят только командные события; арена ограничивает их общей частотой.
      const short = n => String(n).replace(/^NeuroFarm/, '')
      // Сперва итог старого штурма, потом старт нового: в одном плане старый истекает и сразу голосуют за новый — в чате
      // «окончен» шло следом за «ШТУРМ!» и читалось как конец только что начатого (разбор соседней сессии, 14.10).
      if (board.assaultEnded && board.assaultEnded.at !== e0) {
        const e = board.assaultEnded
        const text = e.why === 'проигрываем' ? `⚠ штурм на ${e.target} провален за ${e.seconds} с (потеряли ${e.lost}) — меняем тактику: отход в колизей, лут и лечение, новый штурм — когда станем сильнее` : `штурм на ${e.target} окончен: ${e.why === 'время вышло' ? `${e.seconds} с вышли` : e.why}, потеряли ${e.lost}`
        log(`☢ ${team}: ${text}`); announceTeam(text, e.why === 'проигрываем' ? 'yellow' : 'gray')
      }
      if (board.assault && board.assault.since !== a0) {
        const a = board.assault
        log(`☢ ${team}: ШТУРМ на ${a.target} — подтвердили ${a.voters.length}: ${a.voters.map(short).join(', ')}`)
        announceTeam(`☢ ШТУРМ на ${a.target}! подтвердили ${a.voters.length}: ${a.voters.slice(0, 6).map(short).join(', ')}${a.voters.length > 6 ? '…' : ''} — все до конца`, 'red')
      }
      if (fight && fight.engage !== held) log(`⚖ ${team}: бой ${fight.engage ? 'держим' : 'не держим'} — ${fight.ours} на ${fight.theirs}, потери ≈ ${fight.ourLoss.toFixed(1)} : ${fight.theirLoss.toFixed(1)}${fight.wipedUs && !fight.wipedThem ? ', нас выносят' : ''}`)
      const deliveryFoes = board.enemies(), occupied = new Set(board.tasks().filter(t => t.status === 'claimed').flatMap(t => [t.claim!.owner, ...(t.participants || [])]))
      transfers.set(team, planTransfers(board, members, (donor, recipient, item) => {
        const task = planned.get(team)?.get(donor.id), d = task?.data || {}, giver = bots.find(o => o.name === donor.id), receiver = bots.find(o => o.name === recipient.id)
        const medical = antidoteDeliveryValue(sw, donor.id, recipient.id, item, members, deliveryFoes) > 0
        // Пропускаем до сортировки: занятый или застрявший донор не закрывает свободного курьера.
        return !!task && !occupied.has(donor.id) && !occupied.has(recipient.id) && !['flee', 'recover', 'heal'].includes(task.kind) &&
          !(d.fountain || d.ambush || d.hold || d.line !== undefined || d.bait || d.cordon || d.buildKind || d.dig || d.ladder || d.finishing || d.shove) &&
          !!giver && !((/^(lava_escape|dodge_blast|clear_web)$/.test(giver.last?.m || '') || giver.shieldHold && giver.last?.m === 'swarm_hold') && giver.last?.pending !== false) &&
          (medical || !(giver.swarmExecuting && giver.last?.m === 'fight' && giver.last.pending === true) &&
          !deliveryFoes.some(e => now() - e.seenAt < 1000 && distance(e.position, donor.position) <= 4.5 + Math.max(5.6, Math.hypot(e.velocity?.x || 0, e.velocity?.z || 0) * 20))) &&
          !!receiver && !sw.blocked(receiver, `transfer:transfer:${donor.id}:${recipient.id}:${item}`, item) &&
          (cooldown.get(`transfer:${donor.id}:${recipient.id}:${item}`) || 0) <= now()
      }))
      plannedAt.set(team, now())
      // Что видел этот план (враги, хп своих): мгновенная паника — только на новое (safety.ts).
      sw.plannedFoes.set(team, new Set(board.enemies().map(e => e.id)))
      for (const m of members) { const o = bots.find(x => x.name === m.id); if (o) o.plannedHp = m.health }
    }
    // Ограничиваем только журнал: смена плана и режима доступна сразу.
    const allocationAt = now(), sent = allocationSent.get(team)
    if (!sent || allocationAt - sent.at >= 3000) {
      const rows = [...(planned.get(team) || [])].sort(([a], [b]) => a.localeCompare(b)).map(([id, t]) =>
        [id, t.kind, t.data?.target || '', t.data?.role || '', t.data?.shove || t.data?.undermine || t.data?.dig ? 1 : t.kind === 'fight' ? 0 : t.kind === 'loot' || t.kind === 'flee' || t.data?.rearm || t.data?.camp ? 2 : -1] as const)
      const foes = knownEnemies(board), lethal = foes.map(e => edgeNear(e.position, e)).filter((e, k) => shoveValue(foes[k], e) >= SHOVE)
      const terrain = !foes.length ? '' : !lethal.length ? 'смертельного края нет — натиск' : `смертельный край в ${Math.min(...lethal.map(e => e!.at ?? 0)).toFixed(1)} бл.`
      const key = JSON.stringify([sw.generation, rows, terrain])
      if (key !== sent?.key) {
        const counts = [0, 0, 0]
        for (const row of rows) if (row[4] >= 0) counts[row[4]]++
        const targets = [...new Set(rows.map(row => row[2]).filter(Boolean))].sort().join(', ')
        const roles = [...new Set(rows.map(row => row[3]).filter(Boolean))].sort().join(', ')
        allocationSent.set(team, { key, at: allocationAt })
        log(`🐜 ${team}: распределение — бой ${counts[0]}, сброс/подкоп ${counts[1]}, лут/укрытие ${counts[2]}${targets ? '; цели ' + targets : ''}${roles ? '; роли ' + roles : ''}${terrain ? '; ' + terrain : ''}`)
      }
    }
    return { board, members, member: members.find(m => m.id === b.name), task: planned.get(team)?.get(b.name) }
  }
  // Поштучная связь бойцов остаётся в журнале, независимо от режима чата арены.
  const DOCTRINE_RU: Record<string, string> = { hunt: 'загон — строители режут путь, бойцы давят', wave: 'волна — ветром сбивают с высоты', buffalo: 'бизон — центр давит, фланги заходят сбоку', fountain: 'фонтан — рассыпаться от взрывов и сомкнуться' }
  const announceTeam = (text: string, color: string) => { if (announce) Promise.resolve(announce(text, color)).catch(() => {}) }
  const say2 = (text: string, _color: string, _throttled = false) => { log(`📻 ${text}`) }
  const say = (b, task) => {
    // Сброс и удар с взлёта — в ключе строки: без них «🫸сброс» печатался только при смене дела или цели (стенд 21.10: шесть
    // строк за шесть раундов — по ним решили, что сброс не включается).
    const identity = `${task.kind}:${task.data?.target || task.data?.ally || task.data?.blueprint || ''}:${task.data?.doctrine || ''}:${task.data?.camp || task.data?.dig || task.data?.gather || task.data?.ladder || ''}:${task.data?.shove ? 'shove' : ''}:${task.data?.smash ? 'smash' : ''}:${task.data?.axe ? 'axe' : ''}:${task.data?.cover || ''}`
    if (b.swarmSaid === identity) return
    b.swarmSaid = identity
    if (task.data?.doctrine) b.swarmDoctrine = task.data.doctrine
    log(`🐜 ${b.name} [${task.data?.role || ''}/${task.data?.doctrine || ''}]: ${task.kind}${task.data?.target ? ' → ' + task.data.target : ''}${task.data?.ally || task.data?.cover ? ' для ' + (task.data.ally || task.data.cover) : ''}${task.data?.shove ? ' 🫸сброс' : ''}${task.kind === 'fight' ? ['finishing', 'cover', 'ambush', 'turned', 'fountain', 'cordon', 'assault', 'smash', 'axe'].filter(k => task.data?.[k]).map(k => ' #' + k).join('') : ''}${(task.data?.panic || task.data?.camp || task.data?.dig || task.data?.gather || task.data?.ladder || task.kind === 'loot') && task.data.reason ? ` (${task.data.reason})` : ''}`)
    if ((task.kind === 'fight' || task.kind === 'goto') && task.data?.target && !task.data?.search)
      say2(`${b.name} — цель ${task.data.target}; иду${task.data.cover ? ' прикрыть ' + task.data.cover : ''}`, b.team === 'red' ? 'red' : 'aqua', true)
  }
  // Натиск: против людей (соло) или по оценке плана команды — сильное меньшинство (race.ts strongFew).
  const onslaught = b => aggressive || !!pvpState(boardOf(b)).strongFew
  return { edgeNear, teamOf, boardOf, onslaught, fighting, membersOf, member, observe, refresh, DOCTRINE_RU, say2, say }
}
