'use strict'
// Передача: забрать брошенное человеком (или своё) с земли.
import * as gameClock from '../game-clock'
import { sleep, xyz } from '../movement'
import { collectNearbyDrops } from '../actions'
import { GROUPS, countItems, diffItems } from '../items'
import { normalizeAsk, isFood, TOOL_KINDS, at } from './vocabulary'
import { waitForDrops, lyingAround } from './world'

// ---------------------------------------------------------------- take

export async function take (session, ctl, { item: ask = null, radius = 8, timeoutSeconds = 25 }: any = {}) {
  const bot = session.bot
  const mcData = session.mcData
  const from = xyz(bot.entity.position)
  const budget = Math.max(5, Math.min(120, Math.round(Number(timeoutSeconds) || 25)))
  const deadline = gameClock.now() + budget * 1000
  const reach = Math.max(2, Math.min(24, Math.round(Number(radius) || 8)))

  const before = countItems(bot)
  const wanted = ask ? normalizeAsk(ask) : null

  // The words «на, возьми» beat the entity to us, so this waits instead of
  // asking once — see waitForDrops.
  const lying = await waitForDrops(bot, ctl, { radius: reach })

  const matches = (d) => {
    if (!wanted || !d.item) return !wanted
    if (d.item === wanted) return true
    if (GROUPS[wanted]) return GROUPS[wanted].test(d.item)
    if (wanted === 'еда' || wanted === 'food') return isFood(mcData, d.item)
    if (TOOL_KINDS.test(wanted)) return d.item.endsWith(`_${wanted}`)
    return d.item.includes(wanted)
  }

  if (!lying.length) {
    return {
      took: {}, picked: 0, from, at: from, lying: [],
      stopped: `на земле в ${reach} бл. ничего не лежит`,
      note:
        (wanted ? `${wanted} рядом не валяется. ` : '') +
        'Попроси человека бросить ещё раз (mc_say) — вещи на земле лежат 5 минут. ' +
        `Кинул дальше ${reach} бл. — позови mc_take с radius побольше.`
    }
  }

  const target = lying.filter(matches)
  if (wanted && !target.length) {
    // «Не то» и «сервер ещё не сказал, что это» — разные ответы, и путать их
    // нельзя: во втором случае вещь может быть ровно та, которую просили.
    const unnamed = lying.filter(d => !d.item).length
    return {
      took: {}, picked: 0, from, at: from, lying,
      stopped: unnamed
        ? `рядом лежит ${lying.length} ${lying.length === 1 ? 'куча' : 'кучи'}, но что именно — сервер ещё не прислал`
        : `${wanted} среди лежащего рядом нет`,
      note:
        `на земле лежит: ${lying.map(d => `${d.item || 'что-то'}×${d.count ?? '?'} (${d.dist} бл. ${d.where})`).join('; ')}. ` +
        'Брать не стал — просили другое. Нужно это (или неизвестное) — позови mc_take без item, он берёт всё подряд.'
    }
  }

  // A full bag is why «взял 0» used to be indistinguishable from «там пусто» —
  // the same case containers.js:1923-1927 spells out before walking anywhere.
  // Not fatal on its own: a partial stack of the same thing still has room.
  const free = bot.inventory.emptySlotCount()
  const canTopUp = target.some(d => d.item && bot.inventory.items().some(i => i.name === d.item && i.count < i.stackSize))
  if (free === 0 && !canTopUp) {
    return {
      took: {}, picked: 0, from, at: from, lying,
      stopped: 'рюкзак полон — ни одного пустого слота',
      note:
        `занято ${bot.inventory.items().length} слотов, доложить некуда. ` +
        `На земле: ${target.map(d => `${d.item || 'что-то'}×${d.count ?? '?'}`).join(', ')} — лежит 5 минут. ` +
        'Освободи место: mc_stash mode=put или mc_chest_put, в крайнем случае mc_drop лишнего, потом mc_take снова.'
    }
  }

  // Walking over a stack is how picking up works, so this takes everything on
  // the way and not only what was asked for — the report below says exactly what
  // came, including what nobody asked for.
  //
  // Two rounds, not one, and for the same reason waitForDrops exists:
  // collectNearbyDrops leaves the moment the world answers empty
  // (actions.js:41-42), and a person handing over two stacks throws the second
  // while the body is still walking onto the first.
  const gainedSoFar = () => diffItems(before, countItems(bot))
  const hasWanted = () => Object.keys(gainedSoFar()).some(n => matches({ item: n, count: 1 }))
  let picked = 0
  for (let round = 0; round < 2; round++) {
    picked += await collectNearbyDrops(bot, ctl, {
      radius: reach,
      timeoutMs: Math.max(3000, Math.min(20000, deadline - gameClock.now()))
    })
    await sleep(500) // the last stack lands a tick or two after the walk (survival.js:526)
    if (ctl.aborted || gameClock.now() > deadline - 2000) break
    if (!wanted || hasWanted()) break
    if (!(await waitForDrops(bot, ctl, { radius: reach, windowMs: 800 })).filter(matches).length) break
  }

  const gained = diffItems(before, countItems(bot))
  const got = (Object.entries(gained) as [string, any][])
  const stillThere = lyingAround(bot, { radius: reach })
  const here = xyz(bot.entity.position)

  const missed = wanted && !got.some(([n]) => matches({ item: n, count: 1 }))
    ? target.map(d => d.item).filter(Boolean)
    : []

  const spoils = got.map(([n, c]) => `${n}×${c}`).join(', ')
  const out: any = {
    took: gained,
    picked,
    from,
    at: here,
    lying: stillThere,
    asked: wanted || null
  }

  if (!got.length) {
    // Совет «разгрузись» уместен ровно тогда, когда место и было проблемой:
    // picked>0 значит, что тело дошло до куч и всё равно ничего не влезло.
    const full = picked > 0
    out.stopped = full ? 'прошёл по кучам и ничего не влезло — рюкзак полон' : 'ничего не подобрал'
    out.note =
      `на земле осталось ${stillThere.length} ${stillThere.length === 1 ? 'куча' : 'куч'}` +
      (stillThere.length ? `: ${stillThere.map(d => `${d.item || 'что-то'} на ${at(d.at)}`).join('; ')}` : '') +
      (full
        ? '. Класть некуда: разгрузись (mc_stash mode=put) и позови mc_take снова.'
        : '. Дойти до кучи не вышло — подойди ближе (mc_goto) и позови mc_take снова.')
  } else {
    out.note =
      `подобрал ${spoils}` +
      (missed.length ? `; а вот ${missed.join(', ')} не досталось` : '') +
      (stillThere.length ? `; на земле ещё лежит ${stillThere.map(d => d.item || 'что-то').join(', ')}` : '') +
      `. Скажи человеку спасибо (mc_say) — он ждёт ответа.`
  }

  try {
    session.journal.append('передача', `взял с земли: ${got.length ? spoils : 'ничего'}`, bot.entity.position)
  } catch {}

  return out
}
