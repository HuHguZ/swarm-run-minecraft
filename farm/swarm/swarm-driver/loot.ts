// Рой: лут — безопасность сцены, обход сундуков, пополнение, сундук под рукой.
import { WEAPON, blockCount, distance, cellKey, underArrowFire } from './common'
import { currentTurn } from './lifecycle'
import type { SwarmDriverCtx } from './common'
import type { KnownChest } from './state'
import { swarmCaches } from './caches'
import { followLadder, readyLadder } from './ascent'
import { powerOf, weaponScore } from '../../../daemon/src/pvp/arms-graph'

const chestId = p => 'chest:' + cellKey({ x: Math.floor(p.x), y: Math.floor(p.y), z: Math.floor(p.z) })
const kitSlot = (name: string) => /_(sword|axe)$|^(trident|mace)$/.test(name) ? 'melee' : /_(helmet|chestplate|leggings|boots)$/.exec(name)?.[1]

export function swarmLoot (sw: SwarmDriverCtx) {
  const { now, pos, hideouts, chestTops, log, arms, arena, drops, alive, toured, cooldown, tourBad, knownChests, fullFor, blockedRoutes, lootThreat, weakLoot, teamOf, detail, bounded, lootArena, go, renew } = sw
  // Тайники в толще (21.10, caches.ts): сканы глаз — с каждого хода (chestAtHand), копка — из лута, если планировщик выбрал.
  const caches = swarmCaches(sw)
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
    const upSig = `${blocks}|${pearls}|${pos[b.name]?.inv?.firework_rocket || 0}|${pos[b.name]?.inv?.elytra || pos[b.name]?.armor?.torso === 'elytra'}|${(sw.ladderRoutes || []).map(l => l.key).sort().join(';')}`
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
      if (sw.blocked(b, `tourBad:${b.name}:${k}`, upSig) || foes.some(e => distance(e.position, h) < 22) || !lootSafe(b, h, true, threat)) return []
      const price = sw.travelCost(b, h, me, threat)
      if (!Number.isFinite(price.fly) && (!Number.isFinite(price.walk) || h.climbFrom !== undefined && (exposed || sw.blocked(b, `tourUp:${b.name}`, upSig)))) return []
      return [{ h, k, mark, item, reporter: report?.by, price, cost: Math.min(price.walk, price.fly) * 5.6 / (1 + (h.tier || 0)) + danger(h) }]
    })
      // Своя незавершённая цель — только при равной цене: после бегства старая (в 40 бл. за врагом) вела назад (Codex 15.10).
      .sort((a, c) => (c.h.tier || 0) - (a.h.tier || 0) || a.cost - c.cost || Number(!!c.item) - Number(!!a.item) || Number(c.mark?.by === b.name && !c.mark?.done) - Number(a.mark?.by === b.name && !a.mark?.done))
    const pick = options[0]
    return pick ? { pick, marks, me, blocks, upSig } : null
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
    const { pick, marks, me, blocks, upSig } = choice
    toured.set(teamOf(b), marks)
    // Дошёл — и на высоте места (сундук венца с крыши в 3 бл. ниже засчитывался «дошёл», а не виден; Codex 15.10).
    if (distance(pick.h, me) < 4 && me.y >= pick.h.y - 1) { marks.set(pick.k, { by: b.name, at: now(), done: true }); return false }
    if (pick.mark?.by !== b.name || pick.mark?.done) {
      marks.set(pick.k, { by: b.name, at: now() })
      if (pick.item) log(`🧰 ${b.name}: за ${pick.item} по сообщению ${pick.reporter} из ${chestId(pick.h)}`)
    }
    const from = { ...me }
    let approach
    // Подъём за лутом уступает прицелу; боевой подъём владеет движением отдельно.
    b.grabbing = true
    try {
      // Полёт выгоднее — садимся рядом; иначе остаются жемчуг и прежний подъём блоками.
      const price = pick.price, air = price.fly < price.walk, ladder = !air && readyLadder(sw, b, pick.h)
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
        const r = detail(await b.c.call('goto', { ...bounded(pick.h), range: 1, timeoutSeconds: Math.max(20, Number.isFinite(price.walk) ? Math.ceil(price.walk) : 0), arena: lootArena(b), climb: true, exactY: true, _hunt: true, _climb: true }).catch(e => ({ why: e.message })).finally(() => { if (round === sw.generation) b.climbing = false }))
        if (!currentTurn(sw, b, round)) return true
        log(`🧰 ${b.name}: к сундукам наверху (+${Math.round(pick.h.y - me.y)}, блоков ${blocks}) — ${r.arrived ? 'дошёл' : String(r.why || r.stopped || 'не дошёл').slice(0, 60)}`)
        // Не поднялся — минуту ни к каким верхним (31aj: перебирал 12 сундуков крыши по очереди, 10 отказов за 51 с).
        approach = r
        const rise = (pos[b.name]?.p?.y ?? me.y) - me.y
        if (!r.arrived && rise < 2 && !underArrowFire(b, now())) sw.failed(b, `tourUp:${b.name}`, upSig)
      } else approach = detail(await go(b, pick.h, 2, 6, lootArena(b), true).catch(e => ({ why: e.message })))
    } finally { if (round === sw.generation) delete b.grabbing }
    if (underArrowFire(b, now())) return true
    if (!currentTurn(sw, b, round) || approach.interrupted) return true
    const end = approach.arrived || pos[b.name]?.p
    if (end && distance(end, pick.h) < 4 && end.y >= pick.h.y - 1) marks.set(pick.k, { by: b.name, at: now(), done: true })
    // Частичный подъём продолжается; отказ без набора высоты и стояние освобождают цель.
    else if (!end || !approach.arrived && end.y < from.y + 1 || distance(end, pick.h) >= distance(from, pick.h) - 1) { sw.failed(b, `tourBad:${b.name}:${pick.k}`, upSig); marks.delete(pick.k) }
    return true
  }
  const packOf = b => JSON.stringify(pos[b.name]?.inv || {})
  const refill = at => {
    const id = chestId(at)
    for (const memory of knownChests.values()) { const chest = memory.get(id); if (chest) delete chest.report }
    for (const key of fullFor.keys()) if (key.endsWith(':' + id)) fullFor.delete(key)
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
  async function loot(b, board, atHand = false) {
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
    if (!/netherite|diamond/.test(pos[b.name]?.armor?.torso || '') && await scavenge(b, board, round)) return true
    if (!currentTurn(sw, b, round)) return false
    const chests = detail(await b.c.call('blocks_around', { find: 'chest', seen: true, radius: 16, count: 8 })).found || []
    if (!currentTurn(sw, b, round)) return false
    if (underArrowFire(b, now())) return false
    const team = teamOf(b), memory: Map<string, KnownChest> = knownChests.get(team) || new Map()
    knownChests.set(team, memory)
    for (const at of chests) if (!memory.has(chestId(at))) memory.set(chestId(at), { at })
    caches.cacheSeen(b, chests)
    // Угроза дороже лута (пользователь 14.10: «подбегают лутаться, даже если я рядом; у кого ничего нет — тем более»): голому
    // — сундук не ближе 20 бл. к врагу (видели за 10 с), остальным — 14 (за 3 с).
    // Слабый (лут из бегства) — как голый: сундук у врага ближе 22 бл. снова гнал к нему («лут ↔ бегство», поле s12).
    const risky = riskyFor(b, board)
    for (const at of chests) {
      if (risky(at) || !lootSafe(b, { x: at.x + .5, y: at.y, z: at.z + .5 }, true)) continue
      const id = 'chest:' + cellKey(at), routeKey = `lootPath:${b.name}:${id}`
      if (memory.get(id)?.report?.items.length === 0 || fullFor.get(`${b.name}:${id}`) === packOf(b) || sameScene(b, blockedRoutes.get(routeKey))) continue
      board.upsert({ id, kind: 'scout', position: { x: at.x, y: at.y, z: at.z }, data: { loot: true } })
      const claim = board.claim(id, b.name, 15000)
      if (!claim) continue
      try {
        if (distance(pos[b.name].p, at) > 3) {
          if (!board.renew(claim.id, b.name, claim.claim.token, 45000)) return false
          const approach = await go(b, at, 2, 4, lootArena(b), true).catch(() => null)
          if (!currentTurn(sw, b, round) || approach?.status === 'interrupted') return false
          if (approach?.status !== 'done' || !detail(approach).arrived) { blockedRoutes.set(routeKey, sceneOf(b)); continue }
        }
        // Пока шёл, враг подошёл — не открывать: стоять у сундука под ним (игра пользователя 25.10: «убил, пока он в сундуке был»).
        if (underArrowFire(b, now()) || !lootSafe(b, { x: at.x + .5, y: at.y, z: at.z + .5 }) || !renew(board, b, claim)) return false
        const take = { item: 'all', x: at.x, y: at.y, z: at.z, timeoutSeconds: 8, visibleOnly: true, stay: true }
        let r = await b.c.call('chest_take', take)
        if (!currentTurn(sw, b, round)) return false
        let d = detail(r)
        if (r.status === 'done' && d.full && d.contents && Object.keys(d.contents).some(n => /^(netherite|diamond)_(helmet|chestplate|leggings|boots|sword|axe|spear)$|^(mace|trident|totem_of_undying|elytra|enchanted_golden_apple)$/.test(n)) &&
            chestTops.some(h => h.tier >= 4 && Math.floor(h.x) === at.x && h.y === at.y && Math.floor(h.z) === at.z) && !underArrowFire(b, now())) {
          const dressed = await b.c.call('armor')
          if (!currentTurn(sw, b, round) || underArrowFire(b, now()) || dressed?.status === 'interrupted') return false
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
            r = await b.c.call('chest_take', { ...take, item: wanted.join(','), makeRoom: { slots: Math.min(36, wanted.length), forItem: wanted[0] } })
            if (!currentTurn(sw, b, round) || underArrowFire(b, now())) return false
            d = detail(r)
          }
        }
        const moved = Object.values(d.took || d.moved || {}).reduce((s: number, n: any) => s + (Number(n) || 0), 0)
        if (d.contents) caches.cacheOpened(b, at) // открыт своими — копатель его повторно не берёт
        if (Number(moved) > 0 || d.at && d.contents) board.ack(id, b.name, { token: claim.claim.token, confirmed: true })
        if (d.at && chestId(d.at) === id && d.contents && (!r.status || r.status === 'done')) {
          const items = Object.keys(d.contents).filter(n => d.contents[n] > 0)
          memory.set(id, { at, report: { by: b.name, time: now(), items } })
          if (items.length && !Number(moved)) fullFor.set(`${b.name}:${id}`, packOf(b))
        }
        // Не открылся (не виден, не дотянулся) — этому боту отказ, пока он и враги на том же месте.
        else if (!d.contents) blockedRoutes.set(routeKey, sceneOf(b))
        if (Number(moved) > 0) { if (!underArrowFire(b, now())) await b.c.call('armor'); log(`🧰 ${b.name}: ${id} +${moved}`) }
        return Number(moved) > 0
      } finally { board.release(id, b.name, claim.claim.token) }
    }
    return await scavenge(b, board, round)
  }
  async function scavenge(b, board, round) {
    // Вещи погибших (пользователь 14.10: «остаются бомжи без предметов в конце игры, хотя их много валяется — им надо
    // лутаться; в итоге мы на спавне их легко убили»): куча — где умер боец (последняя позиция, drops), живёт 5 мин
    // (предмет исчезает), к ней идёт один; подбор с земли по вещи, пока видно, потом надеть лучшее.
    const me = pos[b.name]?.p, risky = riskyFor(b, board)
    // Погибший в падении за край (последняя позиция в 3 бл. над смертельной высотой) вещей не оставил: они ушли вниз с ним.
    // Не взял или не видит вещи — снова после перемещения (retry.ts); локальный отказ не очищает общую кучу,
    // а не через 30 с (21.10).
    const pileKey = d => `pile:${b.name}:` + cellKey({ x: Math.floor(d.p.x), y: Math.floor(d.p.y), z: Math.floor(d.p.z) })
    const pile = me && drops().filter(d => d.p && now() - d.at < 280000 && !d.busy && !d.empty && !sw.blocked(b, pileKey(d)) && distance(d.p, me) < 48 && d.p.y > (arena.killY ?? -64) + 3 && !risky({ x: Math.floor(d.p.x), y: Math.floor(d.p.y), z: Math.floor(d.p.z) }) && lootSafe(b, d.p, true))
      .sort((p, q) => distance(p.p, me) - distance(q.p, me))[0]
    if (!pile) return false
    pile.busy = true
    try {
      if (distance(me, pile.p) > 2) {
        const approach = await go(b, pile.p, 1, 8, lootArena(b), true).catch(() => null)
        if (!currentTurn(sw, b, round) || approach?.status === 'interrupted') return false
        if (approach?.status !== 'done' || !detail(approach).arrived) { sw.failed(b, pileKey(pile)); return false }
      }
      let got = 0, why = ''
      for (let k = 0; k < 8 && round === sw.generation && alive(b.name) && !underArrowFire(b, now()) && !chased(board, pos[b.name]?.p); k++) { const r = detail(await b.c.call('assist', { mode: 'pickup', maxD: 6, arena: lootArena(b) }).catch(() => ({}))); if (!currentTurn(sw, b, round)) return false; if (!r.ok) { why = r.why || 'нет подтверждения'; break }; got++ }
      if (!got && underArrowFire(b, now())) return false
      if (got && !underArrowFire(b, now())) await b.c.call('armor').catch(() => {})
      log(`🪦 ${b.name}: вещи погибшего у ${cellKey({ x: Math.floor(pile.p.x), y: Math.floor(pile.p.y), z: Math.floor(pile.p.z) })} — ${got ? `подобрал ${got}` : `не подобрал: ${why || 'подбор остановлен'}`}`)
      if (!got && why) sw.failed(b, pileKey(pile))
      return got > 0
    } finally { pile.busy = false }
  }
  return { chased, sceneOf, sameScene, lootSafe, lootOffer, tour, packOf, refill, chestAtHand, loot, ...caches }
}
