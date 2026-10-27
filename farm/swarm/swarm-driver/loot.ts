// Рой: лут — безопасность сцены, обход сундуков, пополнение, сундук под рукой.
import { WEAPON, blockCount, distance, cellKey, underArrowFire } from './common'
import { currentTurn } from './lifecycle'
import type { SwarmDriverCtx } from './common'
import { swarmCaches } from './caches'

export function swarmLoot (sw: SwarmDriverCtx) {
  const { now, pos, hideouts, chestTops, log, arms, arena, drops, alive, toured, cooldown, tourBad, emptyChests, knownChests, fullFor, blockedRoutes, lootThreat, weakLoot, teamOf, detail, bounded, lootArena, go, renew } = sw
  // Тайники в толще (21.10, caches.ts): сканы глаз — с каждого хода (chestAtHand), копка — из лута, если планировщик выбрал.
  const caches = swarmCaches(sw)
  // За ним идёт человек (враг в 14 бл., виден за 2 с) — не к сундукам и не в комнаты (пользователь 14.10: «лазают в пустые
  // сундуки в комнате, когда мы туда забежали бота убивать; не должны в замкнутые пространства бежать, когда игрок рядом»).
  const chased = (board, p) => !!p && board.enemies().some(e => now() - e.seenAt < 2000 && distance(e.position, p) < 14)
  const sceneOf = b => ({ me: { ...pos[b.name].p }, foes: new Map(lootThreat(b).foes.map(e => [e.id, { ...e.position }])) })
  const sameScene = (b, s) => {
    const foes = lootThreat(b).foes
    return !!s && !!pos[b.name]?.p && distance(pos[b.name].p, s.me) < 2 && foes.length === s.foes.size && foes.every(e => s.foes.has(e.id) && distance(e.position, s.foes.get(e.id)) < 2)
  }
  const lootSafe = (b, at, allowDetour = false) => {
    const me = pos[b.name]?.p
    if (!me || !at) return false
    const { r, foes } = lootThreat(b)
    const dx = at.x - me.x, dz = at.z - me.z, len = dx * dx + dz * dz || 1
    return foes.every(e => {
      const t = Math.max(0, Math.min(1, ((e.position.x - me.x) * dx + (e.position.z - me.z) * dz) / len))
      const pass = Math.hypot(me.x + dx * t - e.position.x, me.z + dz * t - e.position.z)
      // Weak loot uses a bounded A* detour; transfers and ready looters keep their straight-route guard.
      return distance(at, e.position) >= r && (allowDetour && weakLoot(b) || pass >= Math.min(r, Math.hypot(me.x - e.position.x, me.z - e.position.z)) - .5)
    })
  }
  async function tour(b, board) {
    if (underArrowFire(b, now())) return false
    const round = sw.generation
    const marks = toured.get(teamOf(b)) || new Map<number, { by: string; at: number; done?: boolean }>(); toured.set(teamOf(b), marks)
    const me = pos[b.name]?.p; if (!me || !hideouts.length && !chestTops.length || chased(board, me)) return false
    const foes = board.enemies().filter(e => now() - e.seenAt < 10000)
    // Крыша и венец (climbFrom — докуда пешком): полёт сравнивается с подъёмом, нехватка блоков не закрывает воздух.
    const blocks = blockCount(pos[b.name]?.inv || {})
    // Уже наверху — блоки не нужны (Codex 15.10: на крыше без запаса цель исключалась). С жемчугом — тоже (бросок наверх, 21.10).
    const pearls = pos[b.name]?.inv?.ender_pearl || 0
    const need = h => h.climbFrom === undefined || me.y >= h.y - 1 || pearls > 0 ? 0 : Math.max(0, h.y - Math.max(me.y, h.climbFrom)) + 3
    // Неудачи подъёма и похода — повтор по причине (retry.ts): с того же места (2 бл.) и с теми же запасами — нет.
    const upSig = `${blocks}|${pearls}|${pos[b.name]?.inv?.firework_rocket || 0}|${pos[b.name]?.inv?.elytra || pos[b.name]?.armor?.torso === 'elytra'}`
    // Голый или слабый при свежем враге ближе 22 — не наверх (подъём долгий, стоп не прервёт его до 6 бл.; Codex 15.10).
    const naked = !Object.keys(pos[b.name]?.inv || {}).some(n => WEAPON.test(n)) || !!b.swarmTask?.data?.weak
    const exposed = naked && foes.some(e => now() - e.seenAt < 3000 && distance(e.position, me) < 22)
    // Цена — путь, делённый на ярус (лучший лут наверху; Codex 15.10: верхний был 21-м в очереди).
    // Ближе к врагу — дороже (стенд 21.10, чемпион с луком: слабые шли за сундуком через полкарты к нему — «лут к врагу 85 → 47
    // бл.» — и гибли от стрел): каждый блок ближе 40 к свежему врагу — четверть блока пути.
    const danger = h => foes.reduce((s, e) => s + Math.max(0, 40 - distance(h, e.position)) / 4, 0)
    const cost = h => { const c = sw.travelCost(b, h); return Math.min(c.walk, c.fly) * 5.6 / (1 + (h.tier || 0)) + danger(h) }
    const options = [...hideouts, ...chestTops].map((h, k) => ({ h, k, mark: marks.get(k) }))
      .filter(({ h, k, mark }) => (Number.isFinite(sw.travelCost(b, h).fly) || blocks >= need(h) && !(h.climbFrom !== undefined && (exposed || sw.blocked(b, `tourUp:${b.name}`, upSig)))) && (!mark || mark.by === b.name && !mark.done || now() - mark.at > 45000) && !sw.blocked(b, `tourBad:${b.name}:${k}`, upSig) && foes.every(e => distance(e.position, h) >= 22) && lootSafe(b, h, true))
      // Своя незавершённая цель — только при равной цене: после бегства старая (в 40 бл. за врагом) вела назад (Codex 15.10).
      .sort((a, c) => cost(a.h) - cost(c.h) || Number(c.mark?.by === b.name && !c.mark?.done) - Number(a.mark?.by === b.name && !a.mark?.done))
    const pick = options[0]; if (!pick) return false
    // Дошёл — и на высоте места (сундук венца с крыши в 3 бл. ниже засчитывался «дошёл», а не виден; Codex 15.10).
    if (distance(pick.h, me) < 4 && me.y >= pick.h.y - 1) { marks.set(pick.k, { by: b.name, at: now(), done: true }); return false }
    if (pick.mark?.by !== b.name || pick.mark?.done) marks.set(pick.k, { by: b.name, at: now() })
    const from = { ...me }
    let approach
    // Подъём за лутом уступает прицелу; боевой подъём владеет движением отдельно.
    b.grabbing = true
    try {
      // Полёт выгоднее — садимся рядом; иначе остаются жемчуг и прежний подъём блоками.
      const price = sw.travelCost(b, pick.h), air = price.fly < price.walk
      const up = !air && pick.h.climbFrom !== undefined && pick.h.y - me.y > 3 ? await sw.pearlUp(b, pick.h) : null
      if (!currentTurn(sw, b, round)) return true
      if (underArrowFire(b, now()) || up?.moved) return true
      if (up) approach = up
      else if (air) approach = detail(await go(b, pick.h, 1, 6, lootArena(b), true).catch(e => ({ why: e.message })))
      else if (pick.h.climbFrom !== undefined && pick.h.y - me.y > 1) {
        b.climbing = true
        const r = detail(await b.c.call('goto', { ...bounded(pick.h), range: 1, timeoutSeconds: 20, arena: lootArena(b), climb: true, exactY: true, _hunt: true, _climb: true }).catch(e => ({ why: e.message })).finally(() => { if (round === sw.generation) b.climbing = false }))
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
    const end = pos[b.name]?.p
    if (end && distance(end, pick.h) < 4 && end.y >= pick.h.y - 1) marks.set(pick.k, { by: b.name, at: now(), done: true })
    // Не приблизился (стоял или ушёл вбок) — место ему плохое на минуту (Codex 15.10: «вбок на 3 бл.» держало приоритет навсегда).
    else if (!approach.arrived || !end || distance(end, pick.h) >= distance(from, pick.h) - 1) { sw.failed(b, `tourBad:${b.name}:${pick.k}`, upSig); marks.delete(pick.k) }
    return true
  }
  const packOf = b => JSON.stringify(pos[b.name]?.inv || {})
  const refill = at => { emptyChests.delete('chest:' + cellKey(at)) }
  const chestAtHand = b => {
    const me = pos[b.name]?.p
    if (!me || underArrowFire(b, now())) return false
    caches.cacheObserve(b)
    const tops = chestTops.map(c => { const at = { x: Math.floor(c.x), y: Math.floor(c.y), z: Math.floor(c.z) }; return ['chest:' + cellKey(at), at] })
    return [...knownChests.entries(), ...tops].some(([id, at]) => Math.abs(at.y - me.y) < 3 && Math.hypot(at.x + .5 - me.x, at.z + .5 - me.z) < 5 &&
      !emptyChests.has(id) && fullFor.get(`${b.name}:${id}`) !== packOf(b) && !sameScene(b, blockedRoutes.get(`lootPath:${b.name}:${id}`)))
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
    for (const at of chests) knownChests.set('chest:' + cellKey(at), at)
    caches.cacheSeen(b, chests)
    // Угроза дороже лута (пользователь 14.10: «подбегают лутаться, даже если я рядом; у кого ничего нет — тем более»): голому
    // — сундук не ближе 20 бл. к врагу (видели за 10 с), остальным — 14 (за 3 с).
    // Слабый (лут из бегства) — как голый: сундук у врага ближе 22 бл. снова гнал к нему («лут ↔ бегство», поле s12).
    const risky = riskyFor(b, board)
    for (const at of chests) {
      if (risky(at) || !lootSafe(b, { x: at.x + .5, y: at.y, z: at.z + .5 }, true)) continue
      const id = 'chest:' + cellKey(at), routeKey = `lootPath:${b.name}:${id}`
      if (emptyChests.has(id) || fullFor.get(`${b.name}:${id}`) === packOf(b) || sameScene(b, blockedRoutes.get(routeKey))) continue
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
        const r = await b.c.call('chest_take', { item: 'all', x: at.x, y: at.y, z: at.z, timeoutSeconds: 8, visibleOnly: true, stay: true })
        if (!currentTurn(sw, b, round)) return false
        const d = detail(r), moved = Object.values(d.took || d.moved || {}).reduce((s: number, n: any) => s + (Number(n) || 0), 0)
        if (d.contents) caches.cacheOpened(b, at) // открыт своими — копатель его повторно не берёт
        if (Number(moved) > 0 || d.at && d.contents) board.ack(id, b.name, { token: claim.claim.token, confirmed: true })
        if (d.contents && !Object.keys(d.contents).length) emptyChests.add(id)
        else if (!Number(moved) && d.contents) fullFor.set(`${b.name}:${id}`, packOf(b))
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
    // Куча — пока не разобрана (подход дал «пусто») и пока у неё никто; не дошёл — снова, когда сам ушёл с места (retry.ts),
    // а не через 30 с (21.10).
    const pileKey = d => 'pile:' + cellKey({ x: Math.floor(d.p.x), y: Math.floor(d.p.y), z: Math.floor(d.p.z) })
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
      let got = 0
      for (let k = 0; k < 8 && round === sw.generation && alive(b.name) && !underArrowFire(b, now()) && !chased(board, pos[b.name]?.p); k++) { const r = detail(await b.c.call('assist', { mode: 'pickup', maxD: 6, arena: lootArena(b) }).catch(() => ({}))); if (!currentTurn(sw, b, round)) return false; if (!r.ok) break; got++ }
      if (!got && underArrowFire(b, now())) return false
      if (got && !underArrowFire(b, now())) await b.c.call('armor').catch(() => {})
      log(`🪦 ${b.name}: вещи погибшего у ${cellKey({ x: Math.floor(pile.p.x), y: Math.floor(pile.p.y), z: Math.floor(pile.p.z) })} — ${got ? `подобрал ${got}` : 'пусто'}`)
      if (!got) pile.empty = true
      return got > 0
    } finally { pile.busy = false }
  }
  return { chased, sceneOf, sameScene, lootSafe, tour, packOf, refill, chestAtHand, loot, ...caches }
}
