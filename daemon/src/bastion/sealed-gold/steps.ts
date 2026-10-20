'use strict'
// Штрек к золоту бастиона (sealedGold) — шаги оборота до плана: тело, лава, удары, хп и еда, золотая броня, страж Ада,
// кирки; цели оборота (предсказанное золото и сундуки). Порядок — SG_STEPS в bastion/sealed-gold.ts.
import { foesNear, FOES_RE } from '../tower-scan'
import { log, gameClock, inLava, lavaEscape, lavaEscapeDeep, inOwnTunnel, GOLD_PICK, makeIronPick, countOf, armGold } from '../take-gold-block'
import { eatIfHungry } from '../predict-gold'
import { targetsByBruteHome } from '../brute-risk'
import { hunker, answerAttack } from '../defense'
import { type SealedRun, type SealTick, type Turn, chestTargets } from './state'

const GOLD_ARMOR_RE = /\bgolden_(helmet|chestplate|leggings|boots)\b/

export async function sgVitals (sg: SealedRun): Promise<Turn> {
  const { bot, session, ctl, st, S, dimension } = sg
  if (session.bot !== bot || !bot.entity || (bot.health ?? 0) <= 0 || bot.game?.dimension !== dimension || bot._ndGuard?.ended) return 'stop'
  if (st.fastSafe && st.stopMining && st.stopMining()) return 'stop'
  if (inLava(bot)) { if (!(await lavaEscape(bot))) await lavaEscapeDeep(bot); return 'next' }
  // Злые пиглины у вскрытого хода (золото касалось двора): сперва ответить — neF-map23-3 02.10: 4 удара и стрела
  // за 5 с, тело планировало следующий ход, 20 → 0 хп («slain by Piglin»). Брут — bruteDefense (столб).
  if (await answerAttack(session, ctl, st)) return 'next'
  // Штрек вскрыт, а брут/хоглин уже в 6 бл. — заложиться до удара (удар брута 7+, трёх хватает на 20 хп).
  if (S.exposed && inOwnTunnel(bot, S) && foesNear(bot, 6).some((e : any) => FOES_RE.test(e.name || '')) && await hunker(session, ctl, st, 'враг у пролома')) return 'next'
  if ((bot.health ?? 20) < 8) { await eatIfHungry(session, ctl); if ((bot.health ?? 20) < 8) { S.fails.push('хп'); return 'stop' } }
  await eatIfHungry(session, ctl)
  // Без золотой брони: первое золото (сундук, блок) — сразу в броню, пока тело в закрытом штреке (верстак встаёт внутри), а не
  // после всего захода (ревью Codex 14.10): дальше пиглины к нам нейтральны, и вскрытия/бартер не под их ударами.
  if (st.goldless && !S.exposed && inOwnTunnel(bot, S) &&
      countOf(bot, 'gold_ingot') + 9 * countOf(bot, 'gold_block') + Math.floor(countOf(bot, 'gold_nugget') / 9) >= 4 ||
      st.goldless && GOLD_ARMOR_RE.test(bot.inventory.items().map(i => i.name).join(' '))) {
    if (await armGold(session, ctl)) { st.goldless = false; log('штрек: золотая броня из первого золота', { ingots: countOf(bot, 'gold_ingot'), blocks: countOf(bot, 'gold_block') }) }
  }
}

export async function sgGuard (sg: SealedRun): Promise<Turn> {
  const { bot, session, ctl, st, S, SL } = sg
  // Кирки в штреке: каменные кончились — фильтр бастиона пускал железную на чернокамень и незерак, она стиралась, и
  if (process.env.ND_GUARD !== '0') {
    const G: typeof import('../../ne-guard') = require('../../ne-guard')
    const h = G.hot(bot, { near: 5 })
    if (h) {
      const rr = await G.react(session, ctl, { force: h, onOwn: cells => { for (const k of cells) S.own.add(k) } })
      if (rr.cancelled || ctl.aborted || session.bot !== bot) return 'stop'
      if (rr.acted !== false) {
        S.exposed = SL.exposure(bot, S.own).length > 0
        log('штрек: страж', { why: h.why, how: rr.how, hp: Math.round(bot.health ?? 0) })
        return 'next'
      }
    }
  }
  {
    const TN: typeof import('../../tunnel') = require('../../tunnel')
    if (TN.lowPicks(bot) === 0) { const made = await TN.restockPicks(session, ctl, 3).catch(() => 0); log('штрек: каменные кирки', { made }) }
    if (!bot.inventory.items().some(i => GOLD_PICK.test(i.name)) && !st.chestsOnly) {
      const made = await makeIronPick(session, ctl).catch(() => false)
      log('штрек: железная кирка', { made, ingots: countOf(bot, 'iron_ingot'), nuggets: countOf(bot, 'iron_nugget') })
      if (!made) { S.fails.push('нет железной кирки'); return 'stop' }
    }
    // Свои клетки тела после крафта (верстак мог сдвинуть тело на клетку).
    const bc = [bot.entity.position.floored(), bot.entity.position.floored().offset(0, 1, 0)]
    if (bc.some(v => S.own.has(SL.keyV(v)))) for (const v of bc) { const b = bot.blockAt(v); if (b && b.boundingBox === 'empty') S.own.add(SL.keyV(v)) }
  }
}

export async function sgTargets (sg: SealedRun, tk: SealTick): Promise<Turn> {
  const { bot, session, st, S } = sg
  // Предсказания, уже выкопанные попутно (штрек прошёл сквозь них), — снять.
  for (const [k, v] of [...st.pred.entries()]) { const b = bot.blockAt(v.pos); if (b && b.boundingBox === 'empty' && S.own.has(k)) st.pred.delete(k) }
  for (const [k, g] of st.gold) if (!st.pred.has(k) && !S.own.has(k)) st.pred.set(k, { pos: g.pos, piece: 'видно', rank: 0 })
  // Без железной кирки (st.chestsOnly) — только сундуки: золото ей не взять, а железо в сундуках есть.
  // Цели в 6 бл. от дома брута копии — не трогать (S1d s1d-N-2: сундук у брута, 2 удара за секунду, смерть на 7-й мин).
  const BH6 = (require('../../nether-route') as typeof import('../../nether-route')).bruteSpots(session)
  const gear6 = (require('../../assess') as typeof import('../../assess')).gearOf((bot.inventory.slots || []).slice(5, 9))
  const preds = st.chestsOnly ? [] : targetsByBruteHome([...st.pred.entries()].filter(([k]) => (st.skip.get(k) || 0) < gameClock.now()), ([, v]) => v.pos, BH6, bot.health ?? 20, gear6)
  const chestsT = chestTargets(st)
  if (!preds.length && !chestsT.length) return 'stop'
  const chestsOk = targetsByBruteHome(chestsT, c => c.pos, BH6, bot.health ?? 20, gear6)
  if (!preds.length && !chestsOk.length) return 'stop'
  tk.minRank = preds.length ? Math.min(...preds.map(([, v]) => v.rank || 0)) : 0
  tk.tg = [...preds.map(([k, v]) => ({ k, pos: v.pos })), ...chestsOk]
}
