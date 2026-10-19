'use strict'
// Зачарование: одно зачарование предмета на столе (предложения, переброс, выбор строки).
import * as gameClock from '../game-clock'
import { sleep } from '../movement'
import { KIND_RU, enchantsOf, levelOf, tierOf, pointsBetween, WANT, W, conflicts, worthFor } from './facts'
import { openBlockWindow, watchProps, putAll, putOne, freshProps, offersOf, rankOffers, worthOfOffer, takeOut } from './window'
import { unwearIfNeeded } from './table'

export async function enchantOne (session, ctl, table, target, { rerolls = 2, patient = true, lines }: any) {
  const bot = session.bot
  const kind = target.kind
  const name = target.item.name
  const out: any = { item: name, kind: KIND_RU[kind] || kind }

  await unwearIfNeeded(bot, target)
  const win = await openBlockWindow(bot, table, 'стол зачарования')
  const st: any = watchProps(bot, win)
  try {
    // Лазурит — стеком в клетку 1.
    const lap = win.items().find(i => i.name === 'lapis_lazuli')
    if (!lap) throw new Error('нет лазурита')
    await putAll(bot, win, lap, 1)

    const putTarget = async () => {
      const it = win.items().find(i => i.name === name && !enchantsOf(bot, i).length)
      if (!it) throw new Error(`${name} нет в рюкзаке`)
      const since = gameClock.now()
      await putOne(bot, win, it, 0)
      await freshProps(st, since)
    }
    await putTarget()

    let rolled = 0
    let pick = null
    for (;;) {
      const level = levelOf(bot)
      const lapis = (win.slots[1] && win.slots[1].count) || 0
      const offers = offersOf(bot, st)
      const ranked = rankOffers(kind, offers, { level, lapis })
      out.offers = ranked.map(o => `${o.slot + 1}: ${o.cost} ур. → ${o.clue || '?'} ${o.clueLevel > 0 ? o.clueLevel : ''}`.trim())
      if (!ranked.length) throw new Error(`${name} стол не принимает (не зачаровывается или уже зачарован)`)
      const affordable = ranked.filter(o => o.affordable)
      const best = affordable.find(o => !o.junk) || affordable[0] || null
      const top = ranked.reduce((a, b) => (b.cost > a.cost ? b : a), ranked[0])

      // Терпение: алмазную вещь не тратим на дешёвую строку, если верхняя
      // скоро по карману (копи уровни — это дешевле, чем потом переделывать).
      if (patient && tierOf(name) >= 4 && top && !top.affordable && top.cost >= 20) {
        out.skipped = `копи уровни: верхняя строка ${top.cost} ур., у меня ${level} — на ${name} дешёвую строку не трачу`
        out.need = { what: 'уровни опыта', count: top.cost, have: level, points: pointsBetween(level, top.cost) }
        return out
      }
      if (!best) {
        out.skipped = `не хватает: уровней ${level}, лазурита ${lapis} — самая дешёвая строка ${ranked[ranked.length - 1].cost} ур.`
        out.need = { what: 'уровни опыта', count: Math.min(...ranked.map(o => o.cost)), have: level }
        return out
      }

      // Переброс: зачаровать книгу первой строкой (1 уровень, 1 лазурит) — стол
      // перетасует предложения, а книга пойдёт на наковальню. Когда: всё
      // доступное — мусор; или верхняя строка слабая (smite вместо остроты), а
      // уровней хватит на неё и после переброса. Другую вещь для этого не
      // берём: зачарованную стол больше не примет.
      const spareBook = win.items().find(i => i.name === 'book')
      // «Слабо» — меньше 0.6 от главной чары вида: прочность III на меч (5
      // против остроты 10) — повод перебросить, на кирку (8 против 9) — нет.
      const kindTop = Math.max(...(Object.values(WANT[kind] || { x: W(5, '') }) as any[]).map((w : any) => w.w))
      const weakTop = top && top.cost >= 20 && worthOfOffer(kind, top) < 0.6 * kindTop && level >= top.cost + 1
      if ((best.junk || weakTop) && rolled < rerolls && spareBook && level >= 2 && lapis >= 2) {
        const tSlot = 0
        await takeOut(bot, win, tSlot)
        const since = gameClock.now()
        await putOne(bot, win, spareBook, 0)
        await freshProps(st, since)
        const before = win.slots[0]
        bot._client.write('enchant_item', { windowId: win.id, enchantment: 0 })
        const t0 = gameClock.now()
        while (gameClock.now() - t0 < 3000 && win.slots[0] === before) await sleep(50)
        await takeOut(bot, win, 0)
        rolled++
        lines.push(`▸ переброс: на ${name} стол давал ${best.junk ? best.clue + " (мусор)" : "наверху " + top.clue + " (слабо)"} — зачаровал книгу за 1 ур., смотрю заново`)
        await putTarget()
        continue
      }
      // Алмазная вещь зачаровывается один раз: дешёвая строка (острота I)
      // навсегда закрывает ей стол. Верхняя по карману — берём верхнюю (там
      // 2-3 чары), если она не мусор; мусор и перебросить нечем — ждём.
      if (tierOf(name) >= 4 && top && top.affordable && top.cost >= 20 && best !== top) {
        if (!top.junk) {
          lines.push(`▸ ${name}: беру верхнюю строку (${top.clue}), а не ${best.clue} за ${best.cost} — вещь зачаровывается один раз`)
          pick = top
          break
        }
        // Мусор в подсказке — это одна чара из 2-3. Беда, только если она
        // закрывает главную (smite/bane навсегда закрывают остроту).
        const main = (Object.entries(WANT[kind] || {}) as [string, any][]).sort((a: any, b: any) => b[1].w - a[1].w)[0]
        if (patient && main && conflicts(top.clue, main[0])) {
          out.skipped = `наверху ${top.clue} — навсегда закроет ${main[0]}; нужна книга на переброс (1 ур.)`
          out.need = { what: 'book', count: 1, have: 0 }
          out.rerolls = rolled || undefined
          return out
        }
        lines.push(`▸ ${name}: наверху ${top.clue} (в подсказке мусор), но строка 30 даёт 2-3 чары и ничего не закрывает — беру`)
        pick = top
        break
      }
      pick = best
      break
    }

    const levelBefore = levelOf(bot)
    const since = gameClock.now()
    bot._client.write('enchant_item', { windowId: win.id, enchantment: pick.slot })
    let got = []
    while (gameClock.now() - since < 4000) {
      got = enchantsOf(bot, win.slots[0])
      if (got.length) break
      await sleep(80)
    }
    if (!got.length) throw new Error(`стол не зачаровал ${name} (строка ${pick.slot + 1}, ${pick.cost} ур.)`)
    await takeOut(bot, win, 0)
    out.slot = pick.slot + 1
    out.cost = pick.cost
    out.spentLevels = pick.slot + 1
    out.got = got
    out.rerolls = rolled || undefined
    // Сначала то, ради чего брали; мусор, пришедший в нагрузку, — последним и с пометкой.
    out.why = got.slice().sort((a, b) => worthFor(kind, b.name).w - worthFor(kind, a.name).w)
      .map(e => `${e.name} ${e.level}: ${worthFor(kind, e.name).w < 2 ? "(в нагрузку) " : ""}${worthFor(kind, e.name).why}`)
    out.levelsLeft = levelOf(bot)
    if (out.levelsLeft === levelBefore) out.levelsLeft = levelBefore - (pick.slot + 1)
    return out
  } finally {
    st.stop()
    // Лазурит и всё, что осталось в столе, сервер вернёт при закрытии; забираем
    // сами, чтобы рюкзак клиента не разошёлся (invsync).
    try { if (bot.currentWindow === win) { await takeOut(bot, win, 0); await takeOut(bot, win, 1) } } catch {}
    try { win.close() } catch {}
    await sleep(600)
    if (target.rewear) {
      const back = bot.inventory.items().find(i => i.name === name)
      if (back) { try { await bot.equip(back, target.rewear) } catch {} }
    }
  }
}
