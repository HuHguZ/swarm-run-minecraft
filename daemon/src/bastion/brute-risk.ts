/** In a copy brute home zone: 12 bl. across (the route danger zone), 6 up/down. */
const nearBruteHome = (p, brutes, r = 12) => brutes.some(b => Math.hypot(b[0] - p.x, b[2] - p.z) < r && Math.abs(b[1] - p.y) < 6)
/** Pit sites away from brute homes (12), else at least 8 away: a stable full of brutes keeps some site. */
function pitsAwayFromBrutes (list, brutes) {
  const far = list.filter(b => !nearBruteHome(b.P, brutes))
  return far.length ? far : list.filter(b => !nearBruteHome(b.P, brutes, 8))
}
/** Known gold the approach may aim at: away from the copy brute homes, when any is. */
function approachGold (gold, brutes) {
  const safe = gold.filter(g => !nearBruteHome(g, brutes))
  return safe.length ? safe : gold
}
/** S1f (проверка S1e (е)): цель у дома брута — цена, а не порог хп. Удар брута 13 (7 + золотой топор, assess.MOBS) после нашей
 *  брони (CombatRules: assess.afterArmor); до отхода — 1 удар наверняка, второй — с вероятностью 0.25. Риск смерти × час против
 *  ценности последних целей (по умолчанию 240 с: 9 слитков × 0.054 жемчуга × ~500 с жемчуга альтернативой). ND_BRUTE_HOME_PRICE=0 —
 *  прежний порог хп ≥ 16. */
function bruteHomeTake (hp, { armor = 0, tough = 0, valueS = 240, deathS = 3600 }: any = {}) {
  const hit = (require('../assess') as typeof import('../assess')).afterArmor(13, armor, tough)
  const pDeath = hp <= hit ? 0.9 : hp <= 2 * hit ? 0.25 : 0.01
  return { take: pDeath * deathS < valueS, pDeath, hit: Math.round(hit * 10) / 10 }
}
/** S1f (проверка S1e (е)): переждать злость от золота перед ямой — цена. Злых (angerSet — кого злит ломка) нет — не ждать. Есть —
 *  каждый ~2 удара мечом пиглина (5 + золотой меч, после нашей брони) по пути к яме; риск смерти × час против оставшихся секунд злости. */
function pitAngerWait ({ angry, hp, leftS, gear = {} as any, deathS = 3600 }) {
  if (!angry) return { wait: false, why: 'злить некого' }
  const dmg = angry * 2 * (require('../assess') as typeof import('../assess')).afterArmor(8, gear.armor || 0, gear.tough || 0)
  const pDeath = dmg >= hp ? 0.5 : dmg >= hp / 2 ? 0.1 : 0.02
  const wait = pDeath * deathS > leftS
  return { wait, why: `злых ${angry}, урон ~${Math.round(dmg)} при хп ${Math.round(hp)} → риск ${pDeath} × ${deathS} с ${wait ? '>' : '≤'} ${Math.round(leftS)} с злости` }
}
/** S1e (проверка S1d (в)): цели у дома брута — не «никогда», а последними: пока есть другие, их не берём; когда остались только
 *  они — по цене (bruteHomeTake). gear — { armor, tough } тела (assess.gearOf); без него — голое тело. */
function targetsByBruteHome (list, posOf, brutes, hp, gear: any = {}) {
  const far = list.filter(t => !nearBruteHome(posOf(t), brutes, 6))
  if (far.length) return far
  const ok = process.env.ND_BRUTE_HOME_PRICE === '0' ? hp >= 16 : bruteHomeTake(hp, gear).take
  return ok ? list : far
}
/** S1e (проверка S1d (в)): ход к торговцам при бруте рядом — цена: ожидаемый урон от брутов, которые видят нас или дойдут (заливка
 *  тела), или стоят в 10 бл. от торговца, ~2 удара каждый (13 после нашей брони), против хп с запасом 8. Брут за стеной — не повод. */
function bruteWalkRisk (brutes, { threatens, nearTrader, hit, hp }) {
  const n = brutes.filter(b => threatens(b) || nearTrader(b)).length
  const dmg = n * 2 * hit
  return { n, dmg, go: hp - dmg >= 8 }
}

/** Gold that opens the sealed tunnel may be broken and patched at once: 1×1 window (no brute/hoglin in 12 of the body), or
 *  (S1d) any face as long as the drop cannot fall out (own/collision block below), no brute/hoglin in 8 of the gold and no mob
 *  standing on it (it would drop into the hole next to us); never under 16 hp. ND_GOLD_OPEN=0 — the 1×1 rule only. */
function goldWindowOk ({ win1, dropSafe, strong, strongG = strong, onTop = false, hp }, env = process.env) {
  if (hp < 16) return false
  if (win1 && !strong) return true
  return env.ND_GOLD_OPEN !== '0' && dropSafe && !strongG && !onTop
}

export {
  nearBruteHome, pitsAwayFromBrutes, approachGold, bruteHomeTake, pitAngerWait, targetsByBruteHome,
  bruteWalkRisk, goldWindowOk
}
