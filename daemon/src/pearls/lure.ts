'use strict'
// Торг приманкой (ND_SEEK_LURE, поток ne 21.10): слитки на пол у drop — пиглин видит золото в 9 бл. и идёт к нему (PiglinAi
// GoToWantedItem 9), берёт, любуется и бросает добычу к видимому игроку (throwItems → NEAREST_VISIBLE_PLAYER). На полу держать
// слитков на одного больше, чем видно торговцев (до 5); подбор добычи — рамкой тела, не-золото в 4 бл. — раз в 8 с с возвратом на
// stand. Стоп: брут/хоглин в виду (20), жемчуг набран, золото кончилось, idleMs никто не берёт.
import * as gameClock from '../game-clock'
import { countOf } from '../items'

const FOES = /^(piglin_brute|hoglin|zoglin)$/
const sleep = ms => new Promise<void>(r => gameClock.setTimeout(r, ms))

function look (bot) {
  const E: typeof import('../perception/eyes') = require('../perception/eyes')
  const C: typeof import('../bastion/take-gold-block') = require('../bastion/take-gold-block')
  const all = E.entities(bot, { radius: 24, rememberMs: 0, hearMs: 0 }).filter(e => e.seen)
  const foes = all.filter(e => FOES.test(e.name) && e.dist <= 20)
  const pigs = all.filter(e => e.name === 'piglin' && e.dist <= 16 && bot.entities[e.id] && !C.isBaby(bot, bot.entities[e.id]) && !C.aggressive(bot, bot.entities[e.id]))
  return { foes, pigs }
}

export async function lureTrade (session, ctl, bot, drop, stand, until, keep, wantPearls, idleMs = 30000) {
  const D: typeof import('../drops') = require('../drops')
  const SL: typeof import('../sealed') = require('../sealed')
  const C: typeof import('../bastion/take-gold-block') = require('../bastion/take-gold-block')
  const out: any = { tossed: 0, taken: 0, pearls: 0, stopped: null, seconds: 0 }
  const t0 = gameClock.now(), p0 = countOf(bot, 'ender_pearl')
  const gold = () => countOf(bot, 'gold_ingot') + 9 * countOf(bot, 'gold_block') - keep
  const lyingGold = () => D.lying(bot, { radius: 3, from: drop, match: (e, st) => st?.name === 'gold_ingot' }).reduce((n, it) => n + (it.stack?.count || 1), 0)
  let prev = lyingGold(), lastTake = gameClock.now(), lastCollect = gameClock.now()
  while (!ctl.aborted && gameClock.now() < until) {
    if (countOf(bot, 'ender_pearl') >= wantPearls) { out.stopped = 'жемчуга хватает'; break }
    const v = look(bot)
    if (v.foes.length) { out.stopped = `${v.foes[0].name} ${Math.round(v.foes[0].dist)}`; break }
    const lying = lyingGold()
    if (lying < prev) { out.taken += prev - lying; lastTake = gameClock.now() }
    if (lying < Math.min(5, v.pigs.length + 1) && gold() > 0) {
      if (countOf(bot, 'gold_ingot') - keep < 1 && countOf(bot, 'gold_block')) await C.unpackGold(session, ctl, keep + 27)
      const it = bot.inventory.items().find(x => x.name === 'gold_ingot')
      if (it) { try { await bot.lookAt(drop.offset(0, 0.3, 0), true); await bot.toss(it.type, null, 1); out.tossed++ } catch {} }
    }
    prev = lyingGold()
    if (gold() <= 0 && prev === 0) { await sleep(7000); out.stopped = 'золото кончилось'; break }
    if (gameClock.now() - lastTake > idleMs) { out.stopped = `слитки не берут ${Math.round(idleMs / 1000)} с`; break }
    if (gameClock.now() - lastCollect > 8000) {
      lastCollect = gameClock.now()
      await D.collect(bot, ctl, { radius: 4, timeoutMs: 2500, match: (e, st) => st?.name !== 'gold_ingot' }).catch(() => null)
      if (!SL.bodyCells(bot)[0].equals(stand)) await C.walkGoal(session, ctl, new C.goals.GoalBlock(stand.x, stand.y, stand.z), 6000, { dig: false })
    }
    await sleep(500)
  }
  await D.collect(bot, ctl, { radius: 4, timeoutMs: 3000, match: (e, st) => st?.name !== 'gold_ingot' }).catch(() => null)
  out.pearls = countOf(bot, 'ender_pearl') - p0
  out.seconds = Math.round((gameClock.now() - t0) / 1000)
  return out
}
