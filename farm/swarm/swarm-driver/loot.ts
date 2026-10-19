// Рой: лут — безопасность сцены, обход сундуков, пополнение, сундук под рукой.
import { WEAPON, blockCount, distance, cellKey } from './common'
import type { SwarmDriverCtx } from './common'

export function swarmLoot (sw: SwarmDriverCtx) {
  const { now, pos, hideouts, chestTops, log, arms, arena, drops, alive, toured, cooldown, tourBad, emptyChests, knownChests, fullFor, blockedRoutes, lootThreat, weakLoot, teamOf, detail, bounded, lootArena, go, renew } = sw
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
    const marks = toured.get(teamOf(b)) || new Map<number, { by: string; at: number; done?: boolean }>(); toured.set(teamOf(b), marks)
    const me = pos[b.name]?.p; if (!me || !hideouts.length || chased(board, me)) return false
    const foes = board.enemies().filter(e => now() - e.seenAt < 10000)
    // Сундуки крыши и венца (climbFrom — докуда пешком) — тому, у кого блоков на столб оттуда; подъём не штрафуется ×4.
    const blocks = blockCount(pos[b.name]?.inv || {})
    // Уже наверху — блоки не нужны (Codex 15.10: на крыше без запаса цель исключалась).
    const need = h => h.climbFrom === undefined || me.y >= h.y - 1 ? 0 : Math.max(0, h.y - Math.max(me.y, h.climbFrom)) + 3
    // Голый или слабый при свежем враге ближе 22 — не наверх (подъём долгий, стоп не прервёт его до 6 бл.; Codex 15.10).
    const naked = !Object.keys(pos[b.name]?.inv || {}).some(n => WEAPON.test(n)) || !!b.swarmTask?.data?.weak
    const exposed = naked && foes.some(e => now() - e.seenAt < 3000 && distance(e.position, me) < 22)
    // Цена — путь, делённый на ярус (лучший лут наверху; Codex 15.10: верхний был 21-м в очереди).
    const cost = h => (distance(h, me) + (h.climbFrom === undefined ? 4 * Math.max(0, h.y - me.y - 1) : Math.max(0, h.y - me.y))) / (1 + (h.tier || 0))
    const options = [...hideouts, ...chestTops].map((h, k) => ({ h, k, mark: marks.get(k) }))
      .filter(({ h, k, mark }) => blocks >= need(h) && !(h.climbFrom !== undefined && (exposed || (cooldown.get(`tourUp:${b.name}`) || 0) > now())) && (!mark || mark.by === b.name && !mark.done || now() - mark.at > 45000) && !((tourBad.get(`${b.name}:${k}`) || 0) > now()) && foes.every(e => distance(e.position, h) >= 22) && lootSafe(b, h, true))
      // Своя незавершённая цель — только при равной цене: после бегства старая (в 40 бл. за врагом) вела назад (Codex 15.10).
      .sort((a, c) => cost(a.h) - cost(c.h) || Number(c.mark?.by === b.name && !c.mark?.done) - Number(a.mark?.by === b.name && !a.mark?.done))
    const pick = options[0]; if (!pick) return false
    // Дошёл — и на высоте места (сундук венца с крыши в 3 бл. ниже засчитывался «дошёл», а не виден; Codex 15.10).
    if (distance(pick.h, me) < 4 && me.y >= pick.h.y - 1) { marks.set(pick.k, { by: b.name, at: now(), done: true }); return false }
    if (pick.mark?.by !== b.name || pick.mark?.done) marks.set(pick.k, { by: b.name, at: now() })
    const from = { ...me }
    let approach
    if (pick.h.climbFrom !== undefined && pick.h.y - me.y > 1) {
      b.climbing = true
      const r = detail(await b.c.call('goto', { ...bounded(pick.h), range: 1, timeoutSeconds: 20, arena: lootArena(b), climb: true, exactY: true, _hunt: true, _climb: true }).catch(e => ({ why: e.message })).finally(() => { b.climbing = false }))
      log(`🧰 ${b.name}: к сундукам наверху (+${Math.round(pick.h.y - me.y)}, блоков ${blocks}) — ${r.arrived ? 'дошёл' : String(r.why || r.stopped || 'не дошёл').slice(0, 60)}`)
      // Не поднялся — минуту ни к каким верхним (31aj: перебирал 12 сундуков крыши по очереди, 10 отказов за 51 с).
      approach = r
      const up = (pos[b.name]?.p?.y ?? me.y) - me.y
      if (!r.arrived && up < 2) cooldown.set(`tourUp:${b.name}`, now() + 60000)
    } else approach = detail(await go(b, pick.h, 2, 6, lootArena(b)).catch(e => ({ why: e.message })))
    const end = pos[b.name]?.p
    if (end && distance(end, pick.h) < 4 && end.y >= pick.h.y - 1) marks.set(pick.k, { by: b.name, at: now(), done: true })
    // Не приблизился (стоял или ушёл вбок) — место ему плохое на минуту (Codex 15.10: «вбок на 3 бл.» держало приоритет навсегда).
    else if (!approach.arrived || !end || distance(end, pick.h) >= distance(from, pick.h) - 1) { tourBad.set(`${b.name}:${pick.k}`, now() + 60000); marks.delete(pick.k) }
    return true
  }
  const packOf = b => JSON.stringify(pos[b.name]?.inv || {})
  const refill = at => { emptyChests.delete('chest:' + cellKey(at)) }
  const chestAtHand = b => {
    const me = pos[b.name]?.p
    if (!me) return false
    const tops = chestTops.map(c => { const at = { x: Math.floor(c.x), y: Math.floor(c.y), z: Math.floor(c.z) }; return ['chest:' + cellKey(at), at] })
    return [...knownChests.entries(), ...tops].some(([id, at]) => Math.abs(at.y - me.y) < 3 && Math.hypot(at.x + .5 - me.x, at.z + .5 - me.z) < 5 &&
      !emptyChests.has(id) && fullFor.get(`${b.name}:${id}`) !== packOf(b) && !sameScene(b, blockedRoutes.get(`lootPath:${b.name}:${id}`)))
  }
  async function loot(b, board, atHand = false) {
    // Под рукой — без паузы опроса: пауза 4 с от прошлого похода отпускала бота к приказу мимо сундука.
    if (!arms || !atHand && (cooldown.get(`loot:${b.name}`) || 0) > now() || chased(board, pos[b.name]?.p)) return false
    cooldown.set(`loot:${b.name}`, now() + 4000)
    const chests = detail(await b.c.call('blocks_around', { find: 'chest', seen: true, radius: 16, count: 8 })).found || []
    for (const at of chests) knownChests.set('chest:' + cellKey(at), at)
    // Угроза дороже лута (пользователь 14.10: «подбегают лутаться, даже если я рядом; у кого ничего нет — тем более»): голому
    // — сундук не ближе 20 бл. к врагу (видели за 10 с), остальным — 14 (за 3 с).
    // Слабый (лут из бегства) — как голый: сундук у врага ближе 22 бл. снова гнал к нему («лут ↔ бегство», поле s12).
    const naked = !Object.keys(pos[b.name]?.inv || {}).some(n => WEAPON.test(n)) || !!b.swarmTask?.data?.weak
    const risky = at => Math.abs(at.x + .5 - arena.x) + .3 >= arena.r || Math.abs(at.z + .5 - arena.z) + .3 >= arena.r || at.y <= (arena.killY ?? -64) || board.enemies().some(e => now() - e.seenAt < (naked ? 10000 : 3000) && distance(e.position, at) < (naked ? 22 : 14))
    for (const at of chests) {
      if (risky(at) || !lootSafe(b, { x: at.x + .5, y: at.y, z: at.z + .5 }, true)) continue
      const id = 'chest:' + cellKey(at), routeKey = `lootPath:${b.name}:${id}`
      if (emptyChests.has(id) || fullFor.get(`${b.name}:${id}`) === packOf(b) || sameScene(b, blockedRoutes.get(routeKey))) continue
      board.upsert({ id, kind: 'scout', position: { x: at.x, y: at.y, z: at.z }, data: { loot: true } })
      const claim = board.claim(id, b.name, 15000)
      if (!claim) continue
      try {
        if (distance(pos[b.name].p, at) > 3) {
          if (!renew(board, b, claim)) return false
          const approach = await go(b, at, 2, 4, lootArena(b)).catch(() => null)
          if (approach?.status !== 'done' || !detail(approach).arrived) { blockedRoutes.set(routeKey, sceneOf(b)); continue }
        }
        if (!renew(board, b, claim)) return false
        const r = await b.c.call('chest_take', { item: 'all', x: at.x, y: at.y, z: at.z, timeoutSeconds: 8, visibleOnly: true, stay: true })
        const d = detail(r), moved = Object.values(d.took || d.moved || {}).reduce((s: number, n: any) => s + (Number(n) || 0), 0)
        if (Number(moved) > 0 || d.at && d.contents) board.ack(id, b.name, { token: claim.claim.token, confirmed: true })
        if (d.contents && !Object.keys(d.contents).length) emptyChests.add(id)
        else if (!Number(moved) && d.contents) fullFor.set(`${b.name}:${id}`, packOf(b))
        // Не открылся (не виден, не дотянулся) — этому боту отказ, пока он и враги на том же месте.
        else if (!d.contents) blockedRoutes.set(routeKey, sceneOf(b))
        if (Number(moved) > 0) { await b.c.call('armor'); log(`🧰 ${b.name}: ${id} +${moved}`) }
        return Number(moved) > 0
      } finally { board.release(id, b.name, claim.claim.token) }
    }
    // Вещи погибших (пользователь 14.10: «остаются бомжи без предметов в конце игры, хотя их много валяется — им надо
    // лутаться; в итоге мы на спавне их легко убили»): куча — где умер боец (последняя позиция, drops), живёт 5 мин
    // (предмет исчезает), к ней идёт один; подбор с земли по вещи, пока видно, потом надеть лучшее.
    const me = pos[b.name]?.p
    // Погибший в падении за край (последняя позиция в 3 бл. над смертельной высотой) вещей не оставил: они ушли вниз с ним.
    const pile = me && drops().filter(d => d.p && now() - d.at < 280000 && (d.retryAt ?? 0) <= now() && distance(d.p, me) < 48 && d.p.y > (arena.killY ?? -64) + 3 && !risky({ x: Math.floor(d.p.x), y: Math.floor(d.p.y), z: Math.floor(d.p.z) }) && lootSafe(b, d.p, true))
      .sort((p, q) => distance(p.p, me) - distance(q.p, me))[0]
    if (!pile) return false
    pile.retryAt = Infinity // одна попытка может длиться дольше 30 с
    try {
      if (distance(me, pile.p) > 2) {
        const approach = await go(b, pile.p, 1, 8, lootArena(b)).catch(() => null)
        if (approach?.status !== 'done' || !detail(approach).arrived) return false
      }
      let got = 0
      for (let k = 0; k < 8 && alive(b.name) && !chased(board, pos[b.name]?.p); k++) { const r = detail(await b.c.call('assist', { mode: 'pickup', maxD: 6, arena: lootArena(b) }).catch(() => ({}))); if (!r.ok) break; got++ }
      if (got) await b.c.call('armor').catch(() => {})
      log(`🪦 ${b.name}: вещи погибшего у ${cellKey({ x: Math.floor(pile.p.x), y: Math.floor(pile.p.y), z: Math.floor(pile.p.z) })} — ${got ? `подобрал ${got}` : 'пусто'}`)
      return got > 0
    } finally { pile.retryAt = now() + 30000 }
  }
  return { chased, sceneOf, sameScene, lootSafe, tour, packOf, refill, chestAtHand, loot }
}
