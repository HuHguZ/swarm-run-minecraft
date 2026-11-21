// Рой: лут — безопасность сцены, обход сундуков, пополнение, сундук под рукой.
import { WEAPON, blockCount, distance, cellKey, inDropPile, PILE_MEMORY_MS, underArrowFire } from './common'
import { currentTurn } from './lifecycle'
import type { SwarmDriverCtx } from './common'
import type { KnownChest } from './state'
import { swarmCaches } from './caches'
import { followLadder, readyLadder } from './ascent'
import { powerOf, weaponScore } from '../../../daemon/src/pvp/arms-graph'
import type { ClaimedTask, SwarmPosition } from '../../../daemon/src/swarm/types'

const chestId = p => 'chest:' + cellKey({ x: Math.floor(p.x), y: Math.floor(p.y), z: Math.floor(p.z) })
const kitSlot = (name: string) => /_(sword|axe)$|^(trident|mace)$/.test(name) ? 'melee' : /_(helmet|chestplate|leggings|boots)$/.exec(name)?.[1]

export function swarmLoot (sw: SwarmDriverCtx) {
  const { now, pos, hideouts, chestTops, log, arms, arena, drops, alive, toured, cooldown, tourBad, knownChests, fullFor, blockedRoutes, lootThreat, weakLoot, teamOf, detail, bounded, lootArena, go, renew } = sw
  // Тайники в толще (21.10, caches.ts): сканы глаз — с каждого хода (chestAtHand), копка — из лута, если планировщик выбрал.
  const caches = swarmCaches(sw)
  let reportRound = sw.generation
  type Views = { at: number; checked: SwarmPosition[]; options: SwarmPosition[] }
  const piles = new Map<string, Map<string, { p: SwarmPosition; at: number; revision: number; busy?: boolean; inspectedAt?: number; views?: Views }>>()
  // A bot already standing on the site can inspect it while its teammate is still walking there.
  type Approach = { bot: any; walk: any; local?: Promise<void> }
  const approaches = new WeakMap<object, Approach>()
  const teamPiles = b => {
    if (reportRound !== sw.generation) { piles.clear(); reportRound = sw.generation }
    const team = teamOf(b)
    if (!piles.has(team)) piles.set(team, new Map())
    const seen = piles.get(team)!
    for (const [key, pile] of seen) if (now() - pile.at >= PILE_MEMORY_MS) seen.delete(key)
    return seen
  }
  const observeDeaths = (b, reports, observedAt) => {
    const seen = teamPiles(b)
    for (const { position: p, ageMs } of reports) {
      const at = observedAt - ageMs
      if (!(ageMs >= 0 && at <= now() && now() - at < PILE_MEMORY_MS) || !p || ![p.x, p.y, p.z].every(Number.isFinite)) continue
      const key = cellKey({ x: Math.floor(p.x), y: Math.floor(p.y), z: Math.floor(p.z) }), old = seen.get(key)
      if (!old) seen.set(key, { p: { ...p }, at, revision: 0 })
      else if (at >= Math.max(old.at, old.inspectedAt ?? -Infinity, old.views?.at ?? -Infinity)) {
        old.at = at; old.p = { ...p }; old.revision++
        delete old.inspectedAt; delete old.views
      }
    }
  }
  // A recently collected pile still explains an inventory gain in the observer's next status sample.
  const knownDrops = b => [...teamPiles(b).values(), ...drops(b)]
  let visitSequence = 0
  const restocked = new Map<string, number>()
  // За ним идёт человек (враг в 14 бл., виден за 2 с) — не к сундукам и не в комнаты (пользователь 14.10: «лазают в пустые
  // сундуки в комнате, когда мы туда забежали бота убивать; не должны в замкнутые пространства бежать, когда игрок рядом»).
  const chased = (board, p, enemies?) => !!p && (enemies ?? board.enemies()).some(e => now() - e.seenAt < 2000 && distance(e.position, p) < 14)
  const sceneOf = b => ({ me: { ...pos[b.name].p }, foes: new Map(lootThreat(b).foes.map(e => [e.id, { ...e.position }])) })
  const sameScene = (b, s) => {
    if (!s || !pos[b.name]?.p || distance(pos[b.name].p, s.me) >= 2) return false
    const foes = lootThreat(b).foes
    return foes.length === s.foes.size && foes.every(e => s.foes.has(e.id) && distance(e.position, s.foes.get(e.id)) < 2)
  }
  const lootSafe = (b, at, allowDetour = false, threat?) => {
    const me = pos[b.name]?.p
    if (!me || !at) return false
    const { r, foes } = threat ?? lootThreat(b)
    const dx = at.x - me.x, dz = at.z - me.z, len = dx * dx + dz * dz || 1
    return foes.every(e => {
      const t = Math.max(0, Math.min(1, ((e.position.x - me.x) * dx + (e.position.z - me.z) * dz) / len))
      const pass = Math.hypot(me.x + dx * t - e.position.x, me.z + dz * t - e.position.z)
      // Weak loot uses a bounded A* detour; transfers and ready looters keep their straight-route guard.
      return distance(at, e.position) >= r && (allowDetour && weakLoot(b) || pass >= Math.min(r, Math.hypot(me.x - e.position.x, me.z - e.position.z)) - .5)
    })
  }
  const chestSafe = (b, board, at) => {
    if (underArrowFire(b, now())) return false
    const foes = board.enemies()
    return !chased(board, pos[b.name]?.p, foes) &&
      lootSafe(b, { x: at.x + .5, y: at.y, z: at.z + .5 }, false, lootThreat(b, foes))
  }
  // From the same spot a smaller stack cannot improve a failed climb. More blocks, a new route or a new position can.
  const roofBlocked = (b, key, kit, blocks) =>
    sw.blocked(b, key, kit) && blocks <= (tourBad.get(key + '|' + kit) ?? Infinity)
  const failedRoof = (b, key, kit, blocks) => {
    tourBad.set(key + '|' + kit, blocks)
    sw.failed(b, key, kit)
  }
  function tourChoice(b, board) {
    if (underArrowFire(b, now())) return null
    const marks = toured.get(teamOf(b)) || new Map<number, { by: string; at: number; done?: boolean }>()
    const me = pos[b.name]?.p; if (!me || !hideouts.length && !chestTops.length) return null
    // Все кандидаты сравниваются синхронно. Новый ход и открытие после похода снова запрашивают свежие наблюдения.
    const foes = board.enemies().filter(e => now() - e.seenAt < 10000)
    if (chased(board, me, foes)) return null
    const threat = lootThreat(b, foes)
    // Крыша и венец (climbFrom — докуда пешком): полёт сравнивается с подъёмом, нехватка блоков не закрывает воздух.
    const blocks = blockCount(pos[b.name]?.inv || {})
    const pearls = pos[b.name]?.inv?.ender_pearl || 0
    // Неудачи подъёма и похода — повтор по причине (retry.ts): с того же места (2 бл.) и с теми же запасами — нет.
    const kit = `${pearls}|${pos[b.name]?.inv?.firework_rocket || 0}|${pos[b.name]?.inv?.elytra || pos[b.name]?.armor?.torso === 'elytra'}`
    const inv = pos[b.name]?.inv || {}
    const digTools = Object.keys(inv).filter(n => inv[n] > 0 && /_(pickaxe|axe|shovel)$/.test(n)).sort().join(',')
    // Голый или слабый при свежем враге ближе 22 — не наверх (подъём долгий, стоп не прервёт его до 6 бл.; Codex 15.10).
    const naked = !Object.keys(pos[b.name]?.inv || {}).some(n => WEAPON.test(n)) || !!b.swarmTask?.data?.weak
    const exposed = naked && foes.some(e => now() - e.seenAt < 3000 && distance(e.position, me) < 22)
    // Приоритет — лучший доступный ярус (пользователь 12.11); внутри яруса сравниваем путь и риск.
    // Ближе к врагу — дороже (стенд 21.10, чемпион с луком: слабые шли за сундуком через полкарты к нему — «лут к врагу 85 → 47
    // бл.» — и гибли от стрел): каждый блок ближе 40 к свежему врагу — четверть блока пути.
    const danger = h => foes.reduce((s, e) => s + Math.max(0, 40 - distance(h, e.position)) / 4, 0)
    const chestMemory: Map<string, KnownChest> | undefined = knownChests.get(teamOf(b))
    const frame = pos[b.name], pack = packOf(b)
    const equipped = new Set([...Object.keys(frame.inv || {}).filter(n => frame.inv[n] > 0), ...Object.values<string>(frame.armor || {})].filter(Boolean).map(kitSlot))
    const options = [...hideouts, ...chestTops].flatMap((h, k) => {
      const id = chestId(h), report = chestMemory?.get(id)?.report, mark = marks.get(k)
      if (report?.items.length === 0 || fullFor.get(`${b.name}:${id}`) === pack) return []
      // После вскрытия союзник знает, какой слот ещё можно заполнить. В путь одновременно выходит один получатель.
      const item = report && report.by !== b.name && now() - report.time <= 45000 &&
        report.items.find(n => { const slot = kitSlot(n); return slot && !equipped.has(slot) })
      if (mark && now() - mark.at <= 45000 && !(mark.by === b.name && !mark.done) &&
          !(item && mark.done && (mark.by === report.by || mark.at < report.time))) return []
      // A ladder only changes this attempt if the bot can actually use it to reach this roof.
      const ladder = readyLadder(sw, b, h, me) ?? null
      const ascent = h.climbFrom !== undefined || h.y - me.y > 1
      const upSig = kit + '|' + (ladder?.key || '') + (ascent ? '|' + digTools : '')
      const pathKey = `tourBad:${b.name}:${k}`
      const pathFailed = ascent ? roofBlocked(b, pathKey, upSig, blocks) : sw.blocked(b, pathKey, blocks + '|' + upSig)
      if (pathFailed || foes.some(e => distance(e.position, h) < 22) || !lootSafe(b, h, true, threat)) return []
      const price = sw.travelCost(b, h, me, threat, ladder)
      if (!Number.isFinite(price.fly) && (!Number.isFinite(price.walk) || h.climbFrom !== undefined && (exposed || roofBlocked(b, `tourUp:${b.name}`, upSig, blocks)))) return []
      return [{ h, k, mark, item, reporter: report?.by, ladder, ascent, upSig, price, cost: Math.min(price.walk, price.fly) * 5.6 / (1 + (h.tier || 0)) + danger(h) }]
    })
      // Своя незавершённая цель — только при равной цене: после бегства старая (в 40 бл. за врагом) вела назад (Codex 15.10).
      .sort((a, c) => (c.h.tier || 0) - (a.h.tier || 0) || a.cost - c.cost || Number(!!c.item) - Number(!!a.item) || Number(c.mark?.by === b.name && !c.mark?.done) - Number(a.mark?.by === b.name && !a.mark?.done))
    const pick = options[0]
    return pick ? { pick, marks, me, blocks } : null
  }
  const lootOffer = (b, board) => {
    const choice = tourChoice(b, board)
    if (!choice) return null
    const { h, price: cost } = choice.pick
    return { position: h, tier: h.tier || 0, seconds: Math.min(cost.walk, cost.fly) + 8 }
  }
  async function tour(b, board) {
    const round = sw.generation, choice = tourChoice(b, board)
    if (!choice) return false
    const { pick, marks, me, blocks } = choice, { upSig } = pick
    toured.set(teamOf(b), marks)
    // Дошёл — и на высоте места (сундук венца с крыши в 3 бл. ниже засчитывался «дошёл», а не виден; Codex 15.10).
    if (distance(pick.h, me) < 4 && me.y >= pick.h.y - 1) { marks.set(pick.k, { by: b.name, at: now(), done: true }); return false }
    if (pick.mark?.by !== b.name || pick.mark?.done) {
      marks.set(pick.k, { by: b.name, at: now() })
      if (pick.item) log(`🧰 ${b.name}: за ${pick.item} по сообщению ${pick.reporter} из ${chestId(pick.h)}`)
    }
    const claim = marks.get(pick.k)
    const from = { ...me }
    let approach, walkReply
    let walkedRoof = false
    // Подъём за лутом уступает прицелу; боевой подъём владеет движением отдельно.
    b.grabbing = true
    try {
      // Полёт выгоднее — садимся рядом; иначе остаются жемчуг и прежний подъём блоками.
      const price = pick.price, air = price.fly < price.walk, ladder = !air && pick.ladder
      const up = !air && !ladder && pick.h.climbFrom !== undefined && pick.h.y - me.y > 3 ? await sw.pearlUp(b, pick.h) : null
      if (!currentTurn(sw, b, round)) return true
      if (underArrowFire(b, now()) || up?.moved) return true
      if (ladder) {
        const raw = await followLadder(sw, b, ladder, lootArena(b), Math.max(25, Math.ceil(price.walk)))
        approach = detail(raw)
        if (!currentTurn(sw, b, round)) return true
        if (raw?.status === 'interrupted' || approach.interrupted) return true
        const end = raw?.state?.pos || approach.arrived || approach.at || pos[b.name]?.p
        if (approach.ok && approach.complete && end?.y >= ladder.top.y - .5) approach = { ...approach, arrived: end }
        if (!(end?.y >= ladder.top.y - .5) && (!end || end.y < me.y + 1 && distance(end, ladder.top) >= distance(me, ladder.top) - 1) &&
            !underArrowFire(b, now())) sw.failed(b, `ladder:${b.name}:${cellKey(ladder.base)}`)
      } else if (up) approach = up
      else if (air) approach = detail(await go(b, pick.h, 1, 6, lootArena(b), true).catch(e => ({ why: e.message })))
      else if (pick.h.climbFrom !== undefined && pick.h.y - me.y > 1) {
        b.climbing = true
        walkReply = await b.c.call('goto', { ...bounded(pick.h), range: 1, surface: pick.h.surface ?? false, timeoutSeconds: Math.max(20, Number.isFinite(price.walk) ? Math.ceil(price.walk) : 0), arena: lootArena(b), climb: true, exactY: true, _hunt: true, _climb: true }).catch(e => ({ status: 'failed', error: e.message })).finally(() => { if (round === sw.generation) b.climbing = false })
        if (!currentTurn(sw, b, round)) return true
        approach = detail(walkReply)
        log(`🧰 ${b.name}: к сундукам наверху (+${Math.round(pick.h.y - me.y)}, блоков ${blocks}) — ${approach.arrived ? 'дошёл' : String(approach.why || approach.stopped || walkReply.error || walkReply.status || 'не дошёл').slice(0, 60)}`)
        walkedRoof = true
      } else {
        walkReply = await go(b, pick.h, 2, 6, lootArena(b), true).catch(e => ({ why: e.message }))
        approach = detail(walkReply)
      }
    } finally { if (round === sw.generation) delete b.grabbing }
    if (!currentTurn(sw, b, round)) return true
    if (walkReply?.notStarted || walkReply?.status === 'interrupted' || walkReply?.status === 'skipped') {
      if (marks.get(pick.k) === claim) marks.delete(pick.k)
      return true
    }
    if (underArrowFire(b, now()) || approach.interrupted) return true
    const end = walkReply?.state?.pos || (typeof approach.arrived === 'object' && approach.arrived) || approach.at || pos[b.name]?.p
    if (end && distance(end, pick.h) < 4 && end.y >= pick.h.y - 1) {
      if (marks.get(pick.k) === claim) marks.set(pick.k, { by: b.name, at: now(), done: true })
    }
    // Частичный подъём продолжается; отказ без набора высоты и стояние освобождают цель.
    else if (!end || !approach.arrived && end.y < from.y + 1 || distance(end, pick.h) >= distance(from, pick.h) - 1) {
      const key = `tourBad:${b.name}:${pick.k}`
      if (pick.ascent) {
        failedRoof(b, key, upSig, blocks)
        if (walkedRoof && !approach.arrived && (!end || end.y < from.y + 1)) failedRoof(b, `tourUp:${b.name}`, upSig, blocks)
      } else sw.failed(b, key, blocks + '|' + upSig)
      if (marks.get(pick.k) === claim) marks.delete(pick.k)
    }
    return true
  }
  const packOf = b => JSON.stringify(pos[b.name]?.inv || {})
  const refill = at => {
    const id = chestId(at)
    const changed = new Set([id])
    restocked.set(id, ++visitSequence)
    for (const memory of knownChests.values()) {
      const current = memory.get(id)
      for (const key of current?.partner ? [id, chestId(current.partner)] : [id]) {
        const chest = memory.get(key)
        if (chest) memory.set(key, { at: chest.at, partner: chest.partner, slots: chest.slots })
        changed.add(key)
      }
    }
    for (const key of fullFor.keys()) if (changed.has(key.slice(key.indexOf(':') + 1))) fullFor.delete(key)
  }
  const chestAtHand = b => {
    const me = pos[b.name]?.p
    if (!me || underArrowFire(b, now())) return false
    caches.cacheObserve(b)
    const tops = chestTops.map(c => { const at = { x: Math.floor(c.x), y: Math.floor(c.y), z: Math.floor(c.z) }; return ['chest:' + cellKey(at), at] })
    const memory: Map<string, KnownChest> | undefined = knownChests.get(teamOf(b))
    return [...Array.from(memory || [], ([id, c]) => [id, c.at]), ...tops].some(([id, at]) => Math.abs(at.y - me.y) < 3 && Math.hypot(at.x + .5 - me.x, at.z + .5 - me.z) < 5 &&
      memory?.get(id)?.report?.items.length !== 0 && fullFor.get(`${b.name}:${id}`) !== packOf(b) && !sameScene(b, blockedRoutes.get(`lootPath:${b.name}:${id}`)))
  }
  function riskyFor(b, board) {
    const naked = !Object.keys(pos[b.name]?.inv || {}).some(n => WEAPON.test(n)) || !!b.swarmTask?.data?.weak
    return at => Math.abs(at.x + .5 - arena.x) + .3 >= arena.r || Math.abs(at.z + .5 - arena.z) + .3 >= arena.r || at.y <= (arena.killY ?? -64) || board.enemies().some(e => now() - e.seenAt < (naked ? 10000 : 3000) && distance(e.position, at) < (naked ? 22 : 14))
  }
  async function loot(b, board, atHand = false, uncovered?: ClaimedTask[]) {
    if (underArrowFire(b, now())) return false
    const round = sw.generation
    // Копатель тайников (plan-jobs.cacheJobs: копка дороже лута и боя) — копает, а не обходит сундуки.
    if (arms && !atHand && await caches.cacheTurn(b, board)) return true
    if (!currentTurn(sw, b, round)) return false
    // Под рукой — без паузы опроса: пауза 4 с от прошлого похода отпускала бота к приказу мимо сундука.
    if (!arms || !atHand && (cooldown.get(`loot:${b.name}`) || 0) > now() || chased(board, pos[b.name]?.p)) return false
    cooldown.set(`loot:${b.name}`, now() + 4000)
    // Броня слабее алмазной — сперва вещи погибших: в куче незерит, а сундуки через полкарты (игра пользователя 25.10: «до конца
    // в железке ходил, а лута вокруг полно»).
    if (!uncovered && !/netherite|diamond/.test(pos[b.name]?.armor?.torso || '') && await scavenge(b, board, round)) return true
    if (!currentTurn(sw, b, round)) return false
    // The preceding confirmed dig identified this chest and still owns both halves of its window.
    const chests = uncovered ? [uncovered[0].position] : detail(await b.c.call('blocks_around', { find: 'chest', seen: true, radius: 16, count: 8 })).found || []
    if (!currentTurn(sw, b, round)) return false
    if (underArrowFire(b, now())) return false
    const team = teamOf(b), memory: Map<string, KnownChest> = knownChests.get(team) || new Map()
    knownChests.set(team, memory)
    for (const at of chests) if (!memory.has(chestId(at))) memory.set(chestId(at), { at })
    if (!uncovered) caches.cacheSeen(b, chests)
    // Угроза дороже лута (пользователь 14.10: «подбегают лутаться, даже если я рядом; у кого ничего нет — тем более»): голому
    // — сундук не ближе 20 бл. к врагу (видели за 10 с), остальным — 14 (за 3 с).
    // Слабый (лут из бегства) — как голый: сундук у врага ближе 22 бл. снова гнал к нему («лут ↔ бегство», поле s12).
    const risky = riskyFor(b, board)
    for (const at of chests) {
      if (risky(at) || !lootSafe(b, { x: at.x + .5, y: at.y, z: at.z + .5 }, true)) continue
      const id = 'chest:' + cellKey(at), routeKey = `lootPath:${b.name}:${id}`
      if (memory.get(id)?.report?.items.length === 0 || fullFor.get(`${b.name}:${id}`) === packOf(b) || sameScene(b, blockedRoutes.get(routeKey))) continue
      if (!uncovered) board.upsert({ id, kind: 'scout', position: { x: at.x, y: at.y, z: at.z }, data: { loot: true } })
      const claim = uncovered ? uncovered[0] : board.claim(id, b.name, 15000)
      if (!claim) continue
      try {
        if (!uncovered && distance(pos[b.name].p, at) > 3) {
          if (!board.renew(claim.id, b.name, claim.claim.token, 45000)) return false
          const approach = await go(b, at, 2, 4, lootArena(b), true).catch(() => null)
          if (!currentTurn(sw, b, round) || approach?.status === 'interrupted') return false
          if (approach?.status !== 'done' || !detail(approach).arrived) { blockedRoutes.set(routeKey, sceneOf(b)); continue }
        }
        // Пока шёл, враг подошёл — не открывать: стоять у сундука под ним (игра пользователя 25.10: «убил, пока он в сундуке был»).
        const ownsWindow = () => uncovered ? uncovered.every(c => renew(board, b, c)) : renew(board, b, claim)
        if (!chestSafe(b, board, at) || !ownsWindow()) return false
        const take = { item: 'all', x: at.x, y: at.y, z: at.z, timeoutSeconds: 8, visibleOnly: true, stay: true }
        const chest = memory.get(id)!
        let visit = 0
        const sameStock = () => round === sw.generation && memory.get(id) === chest
        const observed = () => sameStock() && chest.reportedVisit === visit
        const canContinue = (reply, window) => currentTurn(sw, b, round) && sameStock() &&
          (!reply.status || reply.status === 'done') && (!window.contents || observed())
        const readWindow = async params => {
          visit = ++visitSequence
          const time = now()
          const reply = await b.c.call('chest_take', params)
          const window = detail(reply)
          // Перенос может быть прерван после открытия. Положение и содержимое окна сообщило само тело.
          if (sameStock() && alive(b.name) && visit > (chest.reportedVisit || 0) &&
              !reply.notStarted && (!reply.status || ['done', 'interrupted', 'timeout'].includes(reply.status)) &&
              window.at?.x === at.x && window.at.y === at.y && window.at.z === at.z &&
              window.contents && typeof window.contents === 'object' && !Array.isArray(window.contents)) {
            const counts = Object.entries(window.contents) as [string, number][]
            if (counts.every(([, n]) => Number.isSafeInteger(n) && n >= 0)) {
              const p = window.chestPartner
              const paired = window.chestSlots === 54 && p && [p.x, p.y, p.z].every(Number.isSafeInteger) &&
                p.y === at.y && Math.abs(p.x - at.x) + Math.abs(p.z - at.z) === 1
              const peerId = paired ? chestId(p) : null
              const peer = peerId && memory.get(peerId)
              // Both clicks address one stock. Ignore a late window after either half was restocked or inspected again.
              if (peerId && (visit <= (restocked.get(peerId) || 0) || visit <= (peer?.reportedVisit || 0))) return reply
              const detach = (half: KnownChest, key: string, next: string | null) => {
                if (!half?.partner || chestId(half.partner) === next) return
                const old = memory.get(chestId(half.partner))
                if (old?.partner && chestId(old.partner) === key) {
                  delete old.partner; delete old.report; delete old.slots
                  old.reportedVisit = visit
                }
                delete half.partner
              }
              if (window.chestSlots === 27 || peerId) detach(chest, id, peerId)
              if (peerId) detach(peer, peerId, id)
              if (window.chestSlots === 27 || window.chestSlots === 54) chest.slots = window.chestSlots
              chest.report = { by: b.name, time, items: counts.filter(([, n]) => n > 0).map(([name]) => name) }
              chest.reportedVisit = visit
              if (peerId) {
                chest.partner = { x: p.x, y: p.y, z: p.z }
                const other: KnownChest = peer || { at: chest.partner }
                Object.assign(other, { partner: chest.at, slots: 54, report: chest.report, reportedVisit: visit })
                memory.set(peerId, other)
              }
            }
          }
          return reply
        }
        let r = await readWindow(take)
        let d = detail(r)
        if (!canContinue(r, d)) return false
        if (r.status === 'done' && d.full && d.contents && Object.keys(d.contents).some(n => /^(netherite|diamond)_(helmet|chestplate|leggings|boots|sword|axe|spear)$|^(mace|trident|totem_of_undying|elytra|enchanted_golden_apple)$/.test(n)) &&
            chestTops.some(h => h.tier >= 4 && Math.floor(h.x) === at.x && h.y === at.y && Math.floor(h.z) === at.z) && !underArrowFire(b, now())) {
          const dressed = await b.c.call('armor')
          if (!canContinue(r, d) || underArrowFire(b, now()) || dressed?.status === 'interrupted') return false
          const m = pos[b.name]
          if (dressed?.state?.inventory) m.inv = dressed.state.inventory
          if (dressed?.state?.armor) m.armor = dressed.state.armor
          const owned = Object.keys(m.inv || {}), enchants = m.enchants || []
          const rating = (n, armor = false) => Math.max(armor ? powerOf([{ name: n }]).armor : weaponScore(n),
            ...enchants.filter(it => it.name === n).map(it => armor ? powerOf([it]).armor : weaponScore(n, it.ench)))
          const weapons = Math.max(0, ...owned.filter(n => WEAPON.test(n)).map(n => rating(n)))
          const wanted = Object.keys(d.contents).filter(n => d.contents[n] > 0).map(name => {
            const kind = /_(helmet|chestplate|leggings|boots)$/.exec(name)?.[1]
            if (kind) {
              const worn = m.armor?.[{ helmet: 'head', chestplate: 'torso', leggings: 'legs', boots: 'feet' }[kind]]
              const have = Math.max(0, ...[...owned.filter(n => n.endsWith('_' + kind)), ...(worn ? [worn] : [])].map(n => rating(n, true)))
              return { name, priority: rating(name, true) > have ? have ? 1 : 0 : Infinity }
            }
            return { name, priority: WEAPON.test(name) && rating(name) > weapons ? 2 : /^(totem_of_undying|elytra|enchanted_golden_apple)$/.test(name) && !m.inv?.[name] && m.offHand?.item !== name && m.offHand !== name && m.armor?.torso !== name ? 3 : Infinity }
          }).filter(n => Number.isFinite(n.priority)).sort((a, c) => a.priority - c.priority).map(n => n.name)
          if (wanted.length) {
            if (!ownsWindow() || !chestSafe(b, board, at)) return false
            r = await readWindow({ ...take, item: wanted.join(','), makeRoom: { slots: Math.min(36, wanted.length), forItem: wanted[0] } })
            d = detail(r)
            if (!canContinue(r, d) || underArrowFire(b, now())) return false
          }
        }
        const moved = Object.values(d.took || d.moved || {}).reduce((s: number, n: any) => s + (Number(n) || 0), 0)
        const opened = observed()
        if (opened) caches.cacheOpened(b, at) // открыт своими — копатель его повторно не берёт
        if (Number(moved) > 0 || opened) board.ack(id, b.name, { token: claim.claim.token, confirmed: true })
        if (opened && chest.report.items.length && !Number(moved)) {
          fullFor.set(`${b.name}:${id}`, packOf(b))
          if (chest.partner) fullFor.set(`${b.name}:${chestId(chest.partner)}`, packOf(b))
        }
        // Не открылся (не виден, не дотянулся) — этому боту отказ, пока он и враги на том же месте.
        else if (!d.contents) blockedRoutes.set(routeKey, sceneOf(b))
        if (Number(moved) > 0) { if (!underArrowFire(b, now())) await b.c.call('armor'); log(`🧰 ${b.name}: ${id} +${moved}`) }
        return Number(moved) > 0
      } finally { if (!uncovered) board.release(id, b.name, claim.claim.token) }
    }
    return !uncovered && await scavenge(b, board, round)
  }
  async function scavenge(b, board, round) {
    // Вещи погибших (пользователь 14.10: «остаются бомжи без предметов в конце игры, хотя их много валяется — им надо
    // лутаться; в итоге мы на спавне их легко убили»): место по сообщению тела или очевидца команды. К нему идёт
    // один; с земли подбирает только видимые предметы, потом надевает лучшее.
    const me = pos[b.name]?.p, risky = riskyFor(b, board)
    // No trip to cleared ground. A nearby scout can still see a fresh item placed there since the survey.
    const surveyed = me && [...teamPiles(b).values()].filter(d => (d.inspectedAt !== undefined || d.views) && distance(me, d.p) <= 16)
      .map(pile => ({ pile, revision: pile.revision }))
    if (surveyed?.length && !(cooldown.get(`pileLook:${b.name}`) > now())) {
      const observedAt = now()
      cooldown.set(`pileLook:${b.name}`, observedAt + 4000)
      const report = detail(await b.c.call('items_near', { radius: 16 }).catch(() => null))
      if (!currentTurn(sw, b, round) || underArrowFire(b, now())) return false
      for (const { pile: d, revision } of surveyed) if (d.revision === revision && report?.items?.some(it =>
        it.at && inDropPile(it.at, d.p))) {
        delete d.inspectedAt; delete d.views; d.at = observedAt; d.revision++
      }
    }
    // Погибший в падении за край (последняя позиция в 3 бл. над смертельной высотой) вещей не оставил: они ушли вниз с ним.
    // Не взял или не видит вещи — снова после перемещения (retry.ts); локальный отказ не очищает общую кучу,
    // а не через 30 с (21.10).
    const pileKey = (d, to) => `pile:${b.name}:` + cellKey({ x: Math.floor(d.p.x), y: Math.floor(d.p.y), z: Math.floor(d.p.z) }) + (d.views ? ':' + cellKey(to) : '')
    const signature = d => `${d.at}:${d.revision || 0}`
    const choices = []
    if (!me) return false
    for (const d of knownDrops(b)) {
      if (!d.p || now() - d.at >= PILE_MEMORY_MS || d.inspectedAt !== undefined || d.empty || distance(d.p, me) >= 48 || d.p.y <= (arena.killY ?? -64) + 3) continue
      const trip = approaches.get(d), walker = trip && pos[trip.bot.name]?.p
      if (d.busy && (!walker || trip.local || teamOf(trip.bot) !== teamOf(b) || d.views || distance(d.p, me) > 2)) continue
      if (risky({ x: Math.floor(d.p.x), y: Math.floor(d.p.y), z: Math.floor(d.p.z) })) continue
      const options = d.views ? [...d.views.options] : [d.p]
      // An ally may reach an untried side on its own, for example after the cover is dug out.
      if (d.views && Math.hypot(me.x - d.p.x, me.z - d.p.z) <= 3 && Math.abs(me.y - d.p.y) <= 1.25) options.push(me)
      for (const to of options) {
        if (d.views?.checked.some(at => distance(at, to) < 1.3) || sw.blocked(b, pileKey(d, to), signature(d))) continue
        if (!risky({ x: Math.floor(to.x), y: Math.floor(to.y), z: Math.floor(to.z) }) && lootSafe(b, to, true)) choices.push({ pile: d, to, cost: distance(me, to) })
      }
    }
    const choice = choices.sort((a, b) => a.cost - b.cost)[0]
    if (!choice) return false
    const { pile, to } = choice, key = pileKey(pile, to), version = signature(pile), site = { ...pile.p }
    const local = pile.busy && approaches.get(pile)
    let releaseLocal: () => void
    if (local) local.local = new Promise<void>(resolve => { releaseLocal = resolve })
    else pile.busy = true
    try {
      if (local && distance(site, pos[local.bot.name].p) <= 6) {
        // Both allies can reach this area. Intercept only visible equipment nearer to us; the scout retains the rest of the site.
        const seen = detail(await b.c.call('items_near', { radius: 6 }).catch(() => null))
        const frame = pos[b.name], walker = pos[local.bot.name]?.p
        if (!currentTurn(sw, b, round) || b.swarmReserved || !walker || !frame?.p || signature(pile) !== version ||
            underArrowFire(b, now()) || chased(board, frame.p)) return false
        const stock = [...Object.entries<number>(frame.inv || {}).map(([name, count]) => ({ name, count })),
          ...Object.values<string>(frame.armor || {}).filter(Boolean).map(name => ({ name })),
          ...(frame.enchants || []).filter(it => kitSlot(it.name))]
        const strength = powerOf(stock).total, threat = lootThreat(b)
        // Named pickup reaches the nearest visible stack of that item. Never bid for a farther copy by ignoring a nearer one.
        const nearest = new Map<string, any>()
        for (const it of seen?.items || []) if (it.at && (!nearest.has(it.name) ||
            distance(frame.p, it.at) < distance(frame.p, nearest.get(it.name).at))) nearest.set(it.name, it)
        const options = [...nearest.values()].filter(it => distance(it.at, site) <= 6 &&
          distance(frame.p, it.at) < distance(walker, it.at) && lootSafe(b, it.at, true, threat))
          .map(it => ({ it, gain: powerOf([...stock, { name: it.name, count: 1 }]).total - strength }))
          .filter(candidate => candidate.gain > 0).sort((a, c) => c.gain - a.gain || a.it.d - c.it.d)
        const wanted = options[0]?.it
        if (!wanted) return false
        const receipt = await b.c.call('assist', { mode: 'pickup', item: wanted.name, maxD: Math.min(6, wanted.d + .051), surveySite: site, arena: lootArena(b) }).catch(() => null)
        if (!currentTurn(sw, b, round) || !detail(receipt)?.ok) return false
        const slot = kitSlot(wanted.name)
        if (slot && slot !== 'melee' && !b.swarmReserved && !underArrowFire(b, now()) && !chased(board, pos[b.name]?.p)) await b.c.call('armor').catch(() => {})
        log(`🪦 ${b.name}: подобрал ${wanted.name} рядом с местом гибели до подхода ${local.bot.name}`)
        return true
      }
      if (distance(me, to) > (pile.views ? .6 : 2)) {
        const old = b.last
        const moving = go(b, pile.views ? { ...to, surface: 'strict' } : to, pile.views ? .35 : 1, 8, lootArena(b), !pile.views)
        const trip: Approach = { bot: b, walk: b.last !== old && b.last?.m === 'goto' ? b.last : null }
        approaches.set(pile, trip)
        const approach = await moving.catch(() => null)
        approaches.delete(pile)
        if (trip.local) await trip.local
        if (!currentTurn(sw, b, round) || approach?.status === 'interrupted') return false
        if (pile.inspectedAt !== undefined || signature(pile) !== version) return false
        if (approach?.status !== 'done' || !detail(approach).arrived) { sw.failed(b, key, version); return false }
      }
      let got = 0, why = '', sharedFrom: SwarmPosition | undefined
      for (let k = 0; k < 8 && currentTurn(sw, b, round) && !underArrowFire(b, now()) && !chased(board, pos[b.name]?.p); k++) {
        const r = detail(await b.c.call('assist', { mode: 'pickup', maxD: 6, surveySite: site, arena: lootArena(b) }).catch(() => ({})))
        if (!currentTurn(sw, b, round)) return false
        if (!r.ok) {
          if (r.inspected && distance(r.inspected, site) === 0 && signature(pile) === version) {
            pile.inspectedAt = now(); delete pile.views; pile.revision = (pile.revision || 0) + 1
            if (local?.walk?.pending && local.bot.last === local.walk && currentTurn(sw, local.bot, round)) {
              void local.bot.c.call('stop').catch(() => {})
            }
          } else if (r.partial && distance(r.partial.site, site) === 0 && signature(pile) === version &&
              (!pile.views || distance(r.partial.from, to) < .9)) {
            const views: Views = pile.views ||= { at: now(), checked: [], options: [] }
            views.checked.push(r.partial.from); views.at = now()
            const { options, ruledOut = [] } = r.partial
            // At a corner another scout may have seen a still-unvisited safe stance behind this scout's wall.
            views.options = [...options, ...views.options.filter(old => !options.some(p => p.x === old.x && p.z === old.z) &&
              !ruledOut.some(p => distance(p, old) === 0) && !views.checked.some(p => distance(p, old) < 1.3))]
            pile.revision = (pile.revision || 0) + 1
            sharedFrom = r.partial.from
          }
          why = r.why || 'нет подтверждения'; break
        }
        got++
      }
      if (!got && underArrowFire(b, now())) return false
      if (got && !underArrowFire(b, now())) await b.c.call('armor').catch(() => {})
      log(`🪦 ${b.name}: вещи погибшего у ${cellKey({ x: Math.floor(pile.p.x), y: Math.floor(pile.p.y), z: Math.floor(pile.p.z) })} — ${got ? `подобрал ${got}` : `не подобрал: ${why || 'подбор остановлен'}`}${sharedFrom ? `, осмотрел с ${cellKey(sharedFrom)}, часть скрыта` : ''}`)
      if (!got && why && pile.inspectedAt === undefined && !sharedFrom) sw.failed(b, key, version)
      return got > 0 || !!sharedFrom
    } finally {
      if (local) { releaseLocal(); delete local.local }
      else pile.busy = false
    }
  }
  return { observeDeaths, knownDrops, chased, sceneOf, sameScene, lootSafe, chestSafe, lootOffer, tour, packOf, refill, chestAtHand, loot, ...caches }
}
