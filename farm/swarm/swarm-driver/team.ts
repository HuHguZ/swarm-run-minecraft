// Рой: команда — доска команды, состав и роли, наблюдение и обновление плана, речь в чат.
import { SwarmBoard, planPvp, planTransfers } from '../../../daemon/src/swarm'
import { pvpState } from '../../../daemon/src/swarm/board'
import { WEAPON, BLOCK, FOOD, distance, cellKey } from './common'
import type { SwarmDriverCtx } from './common'

export function swarmTeam (sw: SwarmDriverCtx) {
  const { edgeOf, now, pos, bots, alive, aggressive, hostile, sandSpot, hideouts, perches, digSites, log, announce, holes, boards, blueprints, telemetry, plannedAt, planned, walls, cooldown, transfers } = sw
  const preempt = (...a: any[]) => sw.preempt(...a)
  // Яма на его полу или ниже (не выше: пол 128 при ногах 126.5 засчитывался — Codex 15.10), в 3.5 бл.
  const edgeNear = p => {
    const gap = h => Math.hypot(h.x + .5 - p.x, h.z + .5 - p.z)
    const h = holes.filter(h => (h.feetY ?? h.y + 1) <= p.y + .1 && p.y - (h.feetY ?? h.y + 1) < 1.6 && gap(h) > .1 && gap(h) <= 3.5).sort((a, c) => gap(a) - gap(c))[0]
    if (!h) return edgeOf ? edgeOf(p) : null
    const d = gap(h)
    // Яма-ловушка в полу этажа — падение 6–8 бл. до этажа ниже (watch.ts holeCells): не насмерть, но урон и он внизу.
    return { x: (h.x + .5 - p.x) / d, z: (h.z + .5 - p.z) / d, drop: h.drop ?? 7, at: d }
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
    const stock = roster.filter(a => alive(a.name)).flatMap(a => Object.keys(pos[a.name]?.inv || {}))
    // Номер в составе команды, а не среди живых: смерть одного не перетасовывает роли всех (ревью 13.10).
    return roster.filter(o => alive(o.name) && pos[o.name]?.p).map(o => member(o, roster.indexOf(o), stock, b))
  }
  const member = (o, k, stock, b) => {
    const m = pos[o.name], inv = m.inv || {}, names = Object.keys(inv)
    const heal = Object.entries(m.potions || {}).some(([n, c]: any) => /^splash_.*(healing|regeneration)$/.test(n) && c > 0)
    const role = heal && k % 3 === 1 ? 'healer' : names.some(n => /_pickaxe$/.test(n)) && k % 3 === 0 ? 'miner-builder' : inv.bow && inv.arrow && k % 2 ? 'ranged' : k % 3 === 2 ? 'flank' : 'fighter'
    const reserve: Record<string, number> = {}, needs: Record<string, number> = {}
    for (const n of names) reserve[n] = BLOCK.test(n) ? 16 : FOOD.test(n) ? 4 : WEAPON.test(n) || /_pickaxe$/.test(n) ? 1 : /potion|pearl|totem|wind_charge/.test(n) ? 1 : 0
    const melee = names.filter(n => /(_sword|_axe)$/.test(n))
    if (melee.length > 1) for (const n of melee.slice(1)) reserve[n] = 0
    if (!names.some(n => WEAPON.test(n))) { const weapon = stock.find(n => WEAPON.test(n)); if (weapon) needs[weapon] = 1 }
    for (const [slot, suffix] of Object.entries({ head: '_helmet', torso: '_chestplate', legs: '_leggings', feet: '_boots' })) {
      const spare = stock.find(n => n.endsWith(suffix))
      if (!m.armor?.[slot] && spare) needs[spare] = 1
      if (m.armor?.[slot]) for (const n of names.filter(n => n.endsWith(suffix))) reserve[n] = 0
    }
    if (inv.bow || inv.crossbow) needs.arrow = 16
    if (role === 'miner-builder') needs[[...blueprints].find(([key]) => key.startsWith(teamOf(b) + ':'))?.[1]?.material || 'cobblestone'] = 16
    if (m.hp < 16 && !names.some(n => FOOD.test(n))) needs.cooked_beef = 4
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
    const weapon = names.find(n => /(_sword|_axe|_spear)$|^(mace|trident)$/.test(n))
    const ench = { sharpness: Math.max(0, ...(m.enchants || []).filter(it => it.name === weapon).map(it => it.ench?.sharpness || 0)), protection: (m.enchants || []).filter(it => it.slot >= 5 && it.slot <= 8).reduce((sum, it) => sum + (it.ench?.protection || 0), 0) }
    // Левая рука (щит, тотем) в рюкзак не входит: без неё надетый щит для доски «пропадал», и кольцо не строилось.
    const offHand = typeof m.offHand === 'string' ? m.offHand : m.offHand?.item || undefined
    if (offHand === 'shield') reserve.shield = 1
    // Заряды ветра — к булаве (пользователь 14.10: «грозу ветра сливают, просто стреляют в игрока ей, хотя надо с булавой
    // комбинировать»): у кого булава, тот свои держит и просит ещё — подброс и удар сверху; у прочих один — на выход из ямы.
    if (inv.mace) { reserve.wind_charge = inv.wind_charge || 0; needs.wind_charge = 8 }
    return { id: o.name, team: teamOf(o), position: m.p, health: m.hp, strength, role, canHeal: heal, inventory: inv, potions: m.potions || {}, reserve, needs, armor: m.armor || {}, offHand, weapon, ench }
  }
  // seenAt — когда спросили (наблюдение не старше запроса статуса), без него — сейчас.
  const observe = (b, sightings, seenAt?: number) => {
    const board = boardOf(b), at = Number.isFinite(seenAt) ? Math.min(seenAt!, now()) : now()
    board.setMembers(membersOf(b))
    for (const e of sightings || []) if (hostile(b, e.id) && board.observe(b.name, at, e)) telemetry.observed++
    preempt(b)
  }
  const refresh = (b) => {
    const board = boardOf(b), team = teamOf(b), members = membersOf(b)
    for (const [key, blueprint] of blueprints) if (key.startsWith(team + ':') && blueprint.expiresAt && blueprint.expiresAt <= now()) {
      for (const t of board.tasks().filter(t => t.data?.blueprint === key.slice(team.length + 1))) board.cancel(t.id)
      blueprints.delete(key)
    }
    board.setMembers(members)
    if (now() - (plannedAt.get(team) || 0) >= 500 || !planned.has(team)) {
      const was = board.doctrineState()?.doctrine, held = board.teamFight?.engage, a0 = board.assault?.since, e0 = board.assaultEnded?.at
      // Дефицит блоков на подъём: нужды лезущих минус то, что у своих сверх запаса, — сколько добытчиков снять (gather).
      const need = members.reduce((s, a) => s + Object.entries(a.needs || {}).filter(([n]) => n === 'sand').reduce((t, [n, c]: any) => t + Math.max(0, c - (a.inventory?.[n] || 0)), 0), 0)
      const spare = members.reduce((s, a) => s + Object.entries(a.inventory || {}).filter(([n]) => n === 'sand' && !a.needs?.[n]).reduce((t, [n, c]: any) => t + Math.max(0, c - (a.reserve?.[n] ?? 16)), 0), 0)
      const onslaughtNow = aggressive || !!pvpState(board).strongFew
      const gather = onslaughtNow && sandSpot && need > spare ? { item: 'sand', deficit: need - spare, spot: sandSpot } : undefined
      // Живые враги — по ленте смертей (открытое знание); против людей (соло) их среди ботов нет — неизвестно.
      const rivals = bots.filter(o => teamOf(o) !== team && (!hostile || hostile(b, o.name)))
      // Лента смертей раунда (открытое знание): кто сколько наших убил — рой учится, что навалом его не взять (race.ts strongFew).
      const killsBy: Record<string, number> = { ...sw.pastKills.get(team) }
      for (const d of sw.drops()) if (d.team === team && d.by) killsBy[d.by] = (killsBy[d.by] || 0) + 1
      planned.set(team, planPvp(board, members, { foesLeft: rivals.length ? rivals.filter(o => alive(o.name)).length : undefined, killsBy, quorum: Math.min(2, Math.max(1, members.length)), doctrine: process.env.SWARM_DOCTRINE as any || undefined, aggressive, hideouts, perches, gather, edgeOf: edgeNear,
        // Лестницы — выключены, пока столбы берутся из перемещения, а не подтверждённой кладки (арена 36: «стена кончилась»,
        // крафт рвут рефлексы — трое ботов вне боя впустую). ARENA_LADDERS=1 — включить.
        // Точки (стена лестницы, яма, засада) — закрыты, пока споткнувшийся на них стоит там же или у раскрытой засады враг
        // (retry.ts siteOpen), а не 8/4/15 с.
        ladderSites: process.env.ARENA_LADDERS === '0' ? [] : [...walls.values()].filter(t => !t.done && sw.siteOpen('ladder:' + t.key)),
        digSites: digSites ? p => digSites(p).filter(s => sw.siteOpen('hole:' + cellKey(s)) && !holes.some(h => Math.abs(h.y - s.y) < 2 && Math.hypot(h.x - s.x, h.z - s.z) < 3)) : undefined, campSpots: onslaughtNow ? hideouts.filter(s => sw.siteOpen('camp:' + cellKey(s), board.enemies())) : undefined }))
      const chosen = board.doctrineState()?.doctrine, fight = board.teamFight
      if (chosen && chosen !== was) { log(`🧭 ${team}: приём ${was || '—'} → ${chosen}`); say2(`🧭 приём: ${DOCTRINE_RU[chosen] || chosen}`, 'aqua', true) }
      // Штурм и отбой — в журнал и в чат (пользователь 14.10: «как рой показывает интеллект — не вижу»).
      const short = n => String(n).replace(/^NeuroFarm/, '')
      // Сперва итог старого штурма, потом старт нового: в одном плане старый истекает и сразу голосуют за новый — в чате
      // «окончен» шло следом за «ШТУРМ!» и читалось как конец только что начатого (разбор соседней сессии, 14.10).
      if (board.assaultEnded && board.assaultEnded.at !== e0) {
        const e = board.assaultEnded
        const text = e.why === 'проигрываем' ? `⚠ штурм на ${e.target} провален за ${e.seconds} с (потеряли ${e.lost}) — меняем тактику: отход в колизей, лут и лечение, новый штурм — когда станем сильнее` : `штурм на ${e.target} окончен: ${e.why === 'время вышло' ? `${e.seconds} с вышли` : e.why}, потеряли ${e.lost}`
        log(`☢ ${team}: ${text}`); say2(text, e.why === 'проигрываем' ? 'yellow' : 'gray')
      }
      if (board.assault && board.assault.since !== a0) {
        const a = board.assault
        log(`☢ ${team}: ШТУРМ на ${a.target} — подтвердили ${a.voters.length}: ${a.voters.map(short).join(', ')}`)
        say2(`☢ ШТУРМ на ${a.target}! подтвердили ${a.voters.length}: ${a.voters.slice(0, 6).map(short).join(', ')}${a.voters.length > 6 ? '…' : ''} — все до конца`, 'red')
      }
      if (fight && fight.engage !== held) log(`⚖ ${team}: бой ${fight.engage ? 'держим' : 'не держим'} — ${fight.ours} на ${fight.theirs}, потери ≈ ${fight.ourLoss.toFixed(1)} : ${fight.theirLoss.toFixed(1)}${fight.wipedUs && !fight.wipedThem ? ', нас выносят' : ''}`)
      transfers.set(team, planTransfers(board, members, (donor, recipient, item) => (cooldown.get(`transfer:${donor.id}:${recipient.id}:${item}`) || 0) <= now()))
      plannedAt.set(team, now())
      // Что видел этот план (враги, хп своих): мгновенная паника — только на новое (safety.ts).
      sw.plannedFoes.set(team, new Set(board.enemies().map(e => e.id)))
      for (const m of members) { const o = bots.find(x => x.name === m.id); if (o) o.plannedHp = m.health }
    }
    return { board, members, member: members.find(m => m.id === b.name), task: planned.get(team)?.get(b.name) }
  }
  // Голос роя в чате игры (натиск): приёмы — не чаще раза в 5 с, штурм — всегда.
  const DOCTRINE_RU: Record<string, string> = { hunt: 'загон — строители режут путь, бойцы давят', wave: 'волна — ветром сбивают с высоты', buffalo: 'бизон — центр давит, фланги заходят сбоку', fountain: 'фонтан — рассыпаться от взрывов и сомкнуться' }
  const say2 = (text: string, color: string, throttled = false) => { if (!announce || throttled && now() - sw.saidAt < 5000) return; sw.saidAt = now(); Promise.resolve(announce(text, color)).catch(() => {}) }
  const say = (b, task) => {
    // Сброс и удар с взлёта — в ключе строки: без них «🫸сброс» печатался только при смене дела или цели (стенд 21.10: шесть
    // строк за шесть раундов — по ним решили, что сброс не включается).
    const identity = `${task.kind}:${task.data?.target || task.data?.ally || task.data?.blueprint || ''}:${task.data?.doctrine || ''}:${task.data?.camp || task.data?.dig || task.data?.gather || task.data?.ladder || ''}:${task.data?.shove ? 'shove' : ''}:${task.data?.smash ? 'smash' : ''}`
    if (b.swarmSaid === identity) return
    b.swarmSaid = identity
    if (task.data?.doctrine) b.swarmDoctrine = task.data.doctrine
    log(`🐜 ${b.name} [${task.data?.role || ''}/${task.data?.doctrine || ''}]: ${task.kind}${task.data?.target ? ' → ' + task.data.target : ''}${task.data?.ally ? ' для ' + task.data.ally : ''}${task.data?.shove ? ' 🫸сброс' : ''}${task.kind === 'fight' ? ['finishing', 'cover', 'ambush', 'turned', 'fountain', 'cordon', 'assault', 'smash'].filter(k => task.data?.[k]).map(k => ' #' + k).join('') : ''}${(task.data?.panic || task.data?.camp || task.data?.dig || task.data?.gather || task.data?.ladder || task.kind === 'loot') && task.data.reason ? ` (${task.data.reason})` : ''}`)
  }
  // Натиск: против людей (соло) или по оценке плана команды — сильное меньшинство (race.ts strongFew).
  const onslaught = b => aggressive || !!pvpState(boardOf(b)).strongFew
  return { edgeNear, teamOf, boardOf, onslaught, fighting, membersOf, member, observe, refresh, DOCTRINE_RU, say2, say }
}
