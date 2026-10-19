'use strict'
import * as gameClock from '../game-clock'
import { sleep, xyz } from '../movement'
import { countOf, resolveItemNames } from '../items'
import { budgetOf, guardWindow } from './window'
import { BASE, STASH_WALK, LOAD_MS, readBase, rememberChest, stashTotals, chestView, aliveChests, freeSlots, stalest } from './base-record'
import { findAndOpen, mapOf, shelfFacts, chestList, depositPass, withdrawPass, ALL_ALIAS, resolveFromContainer } from './chest'
import { waitLoaded, growStash, liveShelves, needBase, awayFrom, walkHome } from './shelves'
import { parseKeep, surplusPlan } from './keep'

function stashNow (session, { name = BASE }: any = {}) {
  const rec = readBase(session, name)
  if (!rec) return { base: null, note: `базы «${name}» нет — общаку негде быть. base mode=set` }
  const alive = aliveChests(rec)
  const total = stashTotals(rec)
  const parts = [`общак на ${rec.x},${rec.y},${rec.z}: ${alive.length} сундук(ов), ${Object.keys(total).length} видов, свободно ${freeSlots(rec)} слотов`]
  if (!alive.length) parts.push('сундуков в памяти нет — stash mode=put найдёт или поставит')
  else if (stalest(rec) >= 30) parts.push(`последний раз открывали ${stalest(rec)} мин назад; stash mode=check пересчитает`)
  const away = session.bot && session.bot.entity ? awayFrom(session.bot, rec) : null
  if (away !== null && away > 4) parts.push(`я в ${away} блоках`)
  return { at: { x: rec.x, y: rec.y, z: rec.z }, away, chests: rec.chests.map(chestView), stash: total, note: parts.join('; ') }
}

// Common preamble for put/take/check: get home, get the shelves, and refuse
// with numbers rather than spending a 90-second budget on a 200-block walk.
async function atStash (session, ctl, rec, { grow, deadline }: any) {
  const bot = session.bot
  const away = awayFrom(bot, rec)
  if (away > STASH_WALK) {
    return { far: `до базы ${away} блоков — это отдельная дорога: сначала base mode=go, потом сюда` }
  }
  if (away > 4) {
    const walk: any = await walkHome(session, ctl, rec, { range: 3, deadline })
    if (walk.away > 6) {
      return { far: `до базы не дошёл, осталось ${walk.away} блоков (${walk.trip.error || 'время вышло'}) — base mode=go` }
    }
  }
  await waitLoaded(bot, rec.centre, LOAD_MS)
  return { shelves: await liveShelves(session, ctl, rec, { grow }) }
}

// Open one shelf, move what the plan still asks for, close, and write what is
// now inside into the cache. Every stash call goes through here, so the memory
// can never drift from the world by more than one failed window.
async function useShelf (session, ctl, name, block, deadline, work) {
  const opened = await findAndOpen(session, ctl, xyz(block.position), deadline)
  const shut = guardWindow(ctl, opened.win)
  let pass = null
  let facts = null
  try {
    pass = await work(opened.win)
    facts = { contents: mapOf(opened.win.containerItems()), ...shelfFacts(opened.win) }
  } finally {
    shut()
    await sleep(120)
  }
  rememberChest(session, name, block, facts)
  return { pass, facts }
}

async function stashPut (session, ctl, { name = BASE, item = null, count = null, keep = null }: any = {}) {
  const bot = session.bot
  const mcData = session.mcData
  const rec = needBase(session, name)
  const deadline = gameClock.now() + 70000

  const asks = String(item === null || item === undefined ? '' : item)
    .split(',').map(s => s.trim()).filter(Boolean)
  // "all" is not a list of item names. resolveItemNames answers it with every
  // stack in the bag, which put the pickaxe, the bucket and the last steak in
  // the chest — the exact thing mc_stash promises it will never do. The brain
  // saying "положи всё" means the loot, and the loot is what surplusPlan
  // computes; naming items or a group is still the escape hatch that drops the
  // reserve on purpose, the same one smelt gives for fuel.
  const wholeBag = asks.some(p => ALL_ALIAS.test(p))
  const asked = asks.length > 0 && !wholeBag

  const override = { ...(keep ? parseKeep(keep) : null) }
  // "all,cobblestone" is the brain asking for the loot AND for that reserve
  // dropped, so the named ones lose their cap — unless keep= says otherwise.
  if (wholeBag) {
    const named = asks.filter(p => !ALL_ALIAS.test(p))
    if (named.length) {
      for (const n of resolveItemNames(named.join(','), bot)) {
        if (override[n] === undefined) override[n] = 0
      }
    }
  }

  const surplus = asked ? null : surplusPlan(bot, override)
  const want = asked
    ? resolveItemNames(item, bot).reduce((o, n) => { o[n] = countOf(bot, n); return o }, {})
    : surplus.plan
  const kept = asked ? null : surplus.kept

  if (!Object.keys(want).filter(n => want[n] > 0).length) {
    const note = asked ? `${item} в рюкзаке нет` : 'лишнего нет — всё, что при мне, нужно в дороге'
    return { at: { x: rec.x, y: rec.y, z: rec.z }, put: {}, kept: kept || undefined, note }
  }

  const home = await atStash(session, ctl, rec, { grow: true, deadline })
  // `at` even on the refusal: the brain's next move is base mode=go, and it
  // must not have to spend another call finding out where that is.
  if (home.far) return { at: { x: rec.x, y: rec.y, z: rec.z }, put: {}, went: false, stopped: home.far, note: home.far }

  let budget = budgetOf(count)
  const remain = { ...want }
  const put = {}
  const failed = {}
  const used = []
  let stopped = null

  const spendOn = async (block, fresh = false) => {
    const names = Object.keys(remain).filter(n => remain[n] > 0)
    if (!names.length) return false
    let done
    try {
      done = await useShelf(session, ctl, name, block, deadline, win =>
        depositPass(bot, mcData, win, names, { budget, caps: remain, deadline, ctl }))
    } catch (e) {
      failed[`${block.position.x},${block.position.y},${block.position.z}`] = e.message
      return false
    }
    for (const [n, k] of ((Object.entries(done.pass.put) as [string, any][]) as any)) {
      put[n] = (put[n] || 0) + k
      remain[n] -= k
    }
    budget = done.pass.budget
    used.push({ at: xyz(block.position), put: done.pass.put, free: done.facts.free, fresh: fresh || undefined })
    if (done.pass.stopped) stopped = done.pass.stopped
    return true
  }

  // A shelf that had to be built because the old one is gone is news, not
  // bookkeeping: the brain asked to put things away and got a new chest at a
  // new coordinate out of it.
  const rebuilt = home.shelves.built && home.shelves.built.ok ? home.shelves.built.block : null
  for (const block of home.shelves.ok) {
    if (ctl.aborted || budget <= 0 || stopped) break
    if (gameClock.now() >= deadline) { stopped = 'время вышло'; break }
    await spendOn(block, block === rebuilt)
  }

  // Everything full and nothing left to build with is the case the naive
  // version gets wrong: it drops the remainder on the floor and says "готово".
  // A leftover only means "did not fit" while there was still budget to spend
  // on it. `stash put item=torch count=8` with sixteen torches in the bag ends
  // with eight in `remain` that were never asked for — and counting those as a
  // shortfall built a second chest nobody needed (measured in game: an empty
  // 27-slot shelf at the base) and reported the brain's own instruction back to
  // it as "не влезло". A null count leaves budget at Infinity, so the
  // no-count case is unchanged.
  const short = () => (budget > 0 ? (Object.entries(remain) as [string, any][]).filter(([, k]: any) => k > 0) : [])

  let grew = null
  if (short().length && !stopped && !ctl.aborted && gameClock.now() < deadline) {
    grew = await growStash(session, ctl, readBase(session, name))
    if (grew.ok) await spendOn(grew.block, true)
  }

  const still = short()
  const fresh = readBase(session, name) || rec
  const moved = (Object.values(put) as any[]).reduce((n: any, k) => n + k, 0)

  const parts = [`положил ${moved} предметов в ${used.length} сундук(ов), свободно ${freeSlots(fresh)} слотов`]
  const placed = used.filter(u => u.fresh)
  if (placed.length) {
    parts.push(`поставил новый сундук на ${placed.map(u => `${u.at.x},${u.at.y},${u.at.z}`).join('; ')}`)
  }
  if (!home.shelves.ok.length && !(grew && grew.ok)) {
    parts.push(`сундука на базе нет: ${(home.shelves.built && home.shelves.built.why) || (grew && grew.why) || 'поставить не вышло'}`)
  }
  if (still.length) {
    parts.push(`не влезло: ${still.map(([n, k]) => `${n}×${k}`).join(', ')} — ` +
      (grew && !grew.ok ? grew.why : 'общак полон, нужен ещё сундук (8 досок)'))
  }
  if (kept && Object.keys(kept).length) {
    parts.push(`при мне оставил нужное: ${(Object.entries(kept) as [string, any][]).map(([n, k]) => `${n}×${k}`).join(', ')}`)
  }
  if (stopped) parts.push(stopped)

  return {
    at: { x: rec.x, y: rec.y, z: rec.z },
    put,
    kept: kept || undefined,
    chests: used,
    leftOnMe: still.length ? Object.fromEntries(still) : undefined,
    free: freeSlots(fresh),
    stash: stashTotals(fresh),
    failed: Object.keys(failed).length ? failed : undefined,
    stopped: stopped || undefined,
    note: parts.join('; ')
  }
}

async function stashTake (session, ctl, { name = BASE, item, count = null }: any = {}) {
  const bot = session.bot
  const mcData = session.mcData
  if (!String(item || '').trim()) throw new Error('не сказано, что брать из общака')
  const rec = needBase(session, name)
  const deadline = gameClock.now() + 70000

  // A full backpack is why "взял 0" used to be indistinguishable from "там
  // пусто". Say which one it is before walking anywhere.
  if (bot.inventory.emptySlotCount() === 0) {
    const note = 'рюкзак забит под завязку, ни одного пустого слота — сначала stash mode=put, потом take'
    return { at: { x: rec.x, y: rec.y, z: rec.z }, took: {}, went: false, stopped: note, note }
  }

  const home = await atStash(session, ctl, rec, { grow: false, deadline })
  if (home.far) return { at: { x: rec.x, y: rec.y, z: rec.z }, took: {}, went: false, stopped: home.far, note: home.far }

  let budget = budgetOf(count)
  const took = {}
  const left = {}
  const from = []
  let stopped = null

  for (const block of home.shelves.ok) {
    if (ctl.aborted || budget <= 0 || stopped) break
    if (gameClock.now() >= deadline) { stopped = 'время вышло'; break }
    let done
    try {
      done = await useShelf(session, ctl, name, block, deadline, win =>
        withdrawPass(bot, mcData, win, resolveFromContainer(win, item), { budget, deadline, ctl }))
    } catch (e) {
      left[`${block.position.x},${block.position.y},${block.position.z}`] = e.message
      continue
    }
    if (Object.keys(done.pass.took).length) from.push({ at: xyz(block.position), took: done.pass.took })
    for (const [n, k] of (Object.entries(done.pass.took) as [string, any][])) took[n] = (took[n] || 0) + k
    Object.assign(left, done.pass.left)
    budget = done.pass.budget
    if (done.pass.full) stopped = 'рюкзак полон — что не влезло, осталось в общаке'
    else if (done.pass.stopped) stopped = done.pass.stopped
  }

  const fresh = readBase(session, name) || rec
  const got = (Object.values(took) as any[]).reduce((n: any, k) => n + k, 0)
  const parts = []
  if (got) parts.push(`взял ${(Object.entries(took) as [string, any][]).map(([n, k]) => `${n}×${k}`).join(', ')} из ${from.length} сундук(ов)`)
  else if (!home.shelves.ok.length) parts.push('сундуков на базе не нашёл — stash mode=put поставит новый')
  else parts.push(`${item} в общаке нет`)
  if (home.shelves.lost.length) parts.push(`сундук сломан на ${home.shelves.lost.map(c => `${c.x},${c.y},${c.z}`).join('; ')}`)
  if (stopped) parts.push(stopped)

  return {
    at: { x: rec.x, y: rec.y, z: rec.z },
    took,
    from,
    left: Object.keys(left).length ? left : undefined,
    stash: stashTotals(fresh),
    stopped: stopped || undefined,
    note: parts.join('; ')
  }
}

// Open every shelf and recount. The honest counterpart to `list`: for when the
// cache is old or somebody else has been here.
async function stashCheck (session, ctl, { name = BASE }: any = {}) {
  const rec = needBase(session, name)
  const deadline = gameClock.now() + 70000
  const home = await atStash(session, ctl, rec, { grow: false, deadline })
  if (home.far) return { at: { x: rec.x, y: rec.y, z: rec.z }, went: false, stopped: home.far, note: home.far }

  const seen = []
  for (const block of home.shelves.ok) {
    if (ctl.aborted || gameClock.now() >= deadline) break
    // chestList writes the cache itself through touchChest, so this loop is
    // both the recount and the refresh.
    try { seen.push(await chestList(session, ctl, xyz(block.position))) } catch (e) {
      seen.push({ at: xyz(block.position), error: e.message })
    }
  }
  const fresh = readBase(session, name) || rec
  const parts = [`пересчитал ${seen.length} сундук(ов), свободно ${freeSlots(fresh)} слотов`]
  if (!seen.length) parts.push('открывать нечего: сундуков на базе нет — stash mode=put поставит')
  if (home.shelves.lost.length) parts.push(`сундук сломан на ${home.shelves.lost.map(c => `${c.x},${c.y},${c.z}`).join('; ')}`)
  if (home.shelves.unloaded.length) parts.push(`${home.shelves.unloaded.length} в непрогруженных чанках`)
  return {
    at: { x: rec.x, y: rec.y, z: rec.z },
    chests: fresh.chests.map(chestView),
    stash: stashTotals(fresh),
    lost: home.shelves.lost.length ? home.shelves.lost : undefined,
    note: parts.join('; ')
  }
}

async function stash (session, ctl, p: any = {}) {
  const how = String(p.mode || 'list').trim().toLowerCase()
  if (how === 'put') return stashPut(session, ctl, p)
  if (how === 'take') return stashTake(session, ctl, p)
  if (how === 'check') return stashCheck(session, ctl, p)
  if (how === 'list') return stashNow(session, p)
  throw new Error(`не знаю режим ${p.mode}, бывает list / put / take / check`)
}

export { stashNow, stash }
