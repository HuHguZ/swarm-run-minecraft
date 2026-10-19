// Бастион — bastion(): оркестр вызова. Состояние вызова — объект bx (bastion/run.ts); фазы: run-setup (отладка сцен,
// броня и кирка, место и память, бартер по памяти, золото по памяти), run-approach (подход), run-loop с run-trade (цикл
// добычи и торга). Остальные экспорты — части бастиона (brute-risk, defense, sealed-gold, barter-site, gold-mode).
import { pickUp, worlds, dropJunk } from './take-gold-block'
import { scanPiecesAsync } from './predict-gold'
import { goldMode } from './gold-mode'
import { openRun, report, planGold, watchDamage, closeRun, finalReport } from './run'
import { debugRun, checkGear, restoreMemo, barterOnly, loadMemory } from './run-setup'
import { approachSite } from './run-approach'
import { mineLoop } from './run-loop'

async function bastion (session, ctl, p: any = {}) {
  const bx = openRun(session, ctl, p)
  const { bot, st, mode } = bx
  if (worlds.worldOf(bot) !== 'the_nether') return report(bx, 'бастионы — в Аду; сначала mc_portal mode=enter')
  // scan — только посмотреть: видимые сундуки и узнанные по ним куски (сцены).
  if (mode === 'scan') return { ...report(bx), scan: await scanPiecesAsync(bot, p.radius || 48, ctl) }
  const debug = await debugRun(bx)
  if (debug) return debug
  const gear = await checkGear(bx)
  if (gear) return gear
  const unknown = restoreMemo(bx)
  if (unknown) return unknown
  if (mode === 'barter' && st.sealed) {
    const traded = await barterOnly(bx)
    if (traded) return traded
  }
  planGold(bx)
  watchDamage(bx)
  try {
    const far = await approachSite(bx)
    if (far) return far
    loadMemory(bx)
    await mineLoop(bx)
    if (bx.ret) return bx.ret
    // Добыча бартера, что легла дальше руки (за уступом, в яме) — собрать с копкой.
    if (!st.sealedState) await pickUp(bot, ctl, 10, 20000)
    const tossed = await dropJunk(bot)
    if (tossed.length) st.tossed.push(...tossed)
  } finally {
    closeRun(bx)
  }
  return finalReport(bx)
}

// Снимок на загрузке, как прежний экспорт FAST_SAFE (module.exports брал значение let при загрузке); никем не читается.
const FAST_SAFE = goldMode.fastSafe

export {
  approachGold, targetsByBruteHome, bruteHomeTake, pitAngerWait, bruteWalkRisk, nearBruteHome, pitsAwayFromBrutes, goldWindowOk
} from './brute-risk'
export { rememberStarts, planView, digToPredicted, digToPredictedBody, sealedGold } from './sealed-gold'
export { bruteDefense, goldExposes, hunker, burrowColumn, burrow, answerAttack, sealBody } from './defense'
export { digTrap, buildTrap, prepareBarterCover, digPit, moveBarterSite } from './barter-site'
export { FAST_SAFE, bastion }
