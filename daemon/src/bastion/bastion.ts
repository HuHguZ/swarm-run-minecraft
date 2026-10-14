const { approachWallSide, approachWallTop, foesNear, FOES_RE, digBooth, mergeTrades, exitTunnel, towerScan, routeGold, pocketOpen } = require('./tower-scan')
const { log, sleep, xyz, mobs, seesMob, goals, walkGoal, gameClock, visibleOf, seesBlock, reachSet, angerSet, threatens, takeGoldBlock, inLava, lavaEscape, lavaEscapeDeep, inOwnTunnel, GOLD_PICK, makeIronPick, countOf, Vec3, fullCover, isBaby, raySees, eyePos, pickUp, BF, centerIn, waitWatched, clamp, fireRes, worlds, wearGold, PLACE, unpackGold, drinkFireRes, effectOn, keyOf, centerGuess, vantagePoints, goldWorn, armGold, nearestTrader, survey, nextTarget, lootChest, dropJunk, SIDES4, aggressive } = require('./take-gold-block')
const { walkUnlessBrute, bruteComing, tunnelTo, pitCandidates, tradeBreach, tradeExecute, trapCandidates, boothTrade, MEMO, exitReserveReady, barterRound, DAMAGE_TYPES, lavaWatched, ownTunnelAt } = require('./booth-trade')
const { trade: penTrade } = require('./pen-trap')
const { eatIfHungry, lastGoldBreak, baitAim, scanPiecesAsync } = require('./predict-gold')
const miningCycle = require('./mining-cycle')
const GOLD_ARMOR_RE = /\bgolden_(helmet|chestplate|leggings|boots)\b/
async function bruteDefense (session, ctl, st, forced = null) {
  const bot = session.bot
  const pick = require('.././pick')
  // Столб — только от того, кто идёт на нас: агрессивен (mob_flags бит 2 —
  const me0 = bot.entity.position
  // В своём закрытом штреке брут за стеной не страшен (нет луча — нет пути к нам): столба в штреке нет (потолок), а
  // «отхожу» pathfinder'ом выводил наружу (neF-R25-1 02.10: 40 вызовов «столба нет — отхожу» за секунду).
  if (!forced && inOwnTunnel(bot, st.sealedState) && !mobs(bot, 'piglin_brute', 12).some(e => seesMob(bot, e))) return false
  // Видит нас в своём штреке (пролом) — заложиться, а не столб.
  if (!forced && inOwnTunnel(bot, st.sealedState)) {
    const seer: any = mobs(bot, 'piglin_brute', 12).find(e => seesMob(bot, e))
    // ND_BRUTE_HUNKER=1: ход закрыт (пробоев нет), брут виден сквозь щель/неполный блок — пути к нам у него нет, и
    // закладывать нечего (D6-22 03.10: 19 раз «заложился» с n 0, exposed false — 13 мин стояния до конца этапа).
    if (seer && process.env.ND_BRUTE_HUNKER === '1' && seer.position.distanceTo(bot.entity.position) > 3.5 && !require('.././sealed').exposure(bot, st.sealedState.own).length) return false
    if (seer && await hunker(session, ctl, st, 'брут видит в штреке', seer)) return true
  }
  const brute = forced || mobs(bot, 'piglin_brute', 12).find((e : any) => {
    const d = e.position.distanceTo(me0)
    if (d < 6) return true
    if (!aggressive(bot, e) || !seesMob(bot, e)) return false
    // Идёт к нам: за последнюю секунду ближе на 1+ блок (st.bruteSeen — прошлые расстояния).
    const prev = st.bruteSeen.get(e.id)
    st.bruteSeen.set(e.id, { d, at: gameClock.now() })
    return prev && gameClock.now() - prev.at < 2500 && prev.d - d > 1
  })
  if (!brute) return false
  st.brutes++
  const t0 = gameClock.now()
  const base = bot.entity.position.floored()
  let pil = null
  try { pil = await require('.././pearls').emergencyPillar(bot, ctl) } catch (e) { pil = { ok: false, why: e.message } }
  if (!pil || !pil.ok) {
    // Столба не вышло (потолок, лава) — уйти от него.
    if (process.env.ND_GUARD !== '0') {
      const G = require('.././ne-guard')
      const bx = await G.boxIn(bot, brute, { ctl }).catch(e => ({ ok: false, why: e.message }))
      if (bx.ok) {
        const sat = await G.sit(session, ctl, 25000)
        log('брут: коробка вместо столба', { placed: bx.placed, sat, hp: Math.round(bot.health ?? 0) })
        return true
      }
      log('брут: коробки нет', { why: bx.why, left: bx.left })
    }
    const me = bot.entity.position
    const dx = me.x - brute.position.x
    const dz = me.z - brute.position.z
    const n = Math.hypot(dx, dz) || 1
    log('брут: столба нет — отхожу', { why: pil && pil.why })
    await walkGoal(session, ctl, new goals.GoalNearXZ(Math.round(me.x + dx / n * 16), Math.round(me.z + dz / n * 16), 3), 12000)
    return true
  }
  const sword = bot.inventory.items().filter(i => /_sword$/.test(i.name)).sort((a, c) => (/netherite/.test(c.name) ? 4 : /diamond/.test(c.name) ? 3 : /iron/.test(c.name) ? 2 : 1) - (/netherite/.test(a.name) ? 4 : /diamond/.test(a.name) ? 3 : /iron/.test(a.name) ? 2 : 1))[0]
  let swings = 0
  let arrows = 0
  let lastSwing = 0
  let away = 0
  let close = 0
  while (!ctl.aborted && gameClock.now() - t0 < 60000) {
    const e = bot.entities[brute.id]
    if (!e || e.isValid === false) { st.fights.push('брут убит со столба'); break }
    const d = e.position.distanceTo(bot.entity.position)
    const flat = Math.hypot(e.position.x - bot.entity.position.x, e.position.z - bot.entity.position.z)
    if (flat < 4) close = gameClock.now()
    // Ушёл, или 12 с не подходит к столбу и не злится — слезть и дальше.
    if (d > 12) { if (!away) away = gameClock.now(); if (gameClock.now() - away > 6000) break } else away = 0
    if (gameClock.now() - Math.max(t0, close) > 12000 && !aggressive(bot, e)) break
    if (gameClock.now() - Math.max(t0, close) > 20000 && !arrows) break
    if (gameClock.now() - t0 > 45000 && !swings) break
    if ((bot.health ?? 20) < 6) break
    const below = e.position.y <= bot.entity.position.y - 1.5
    const a = below ? pick.aim(bot, e) : null
    if (a && a.point && gameClock.now() - lastSwing >= 650) {
      try {
        if (sword && (!bot.heldItem || bot.heldItem.name !== sword.name)) await bot.equip(sword, 'hand')
        await bot.lookAt(a.point, true)
        bot.attack(e)
        swings++
        lastSwing = gameClock.now()
      } catch {}
    } else if (!a && flat >= 3 && d <= 20 && seesMob(bot, e) && bot.inventory.items().some(i => i.name === 'bow') && bot.inventory.items().some(i => /arrow$/.test(i.name))) {
      // Не под столбом — лук: брут до нас не достаёт, а стрела достаёт его.
      try {
        const r = await require('.././bow').shoot(bot, e, { shouldStop: () => ctl.aborted || !bot.entities[brute.id] })
        if (r && r.shot) arrows++
      } catch {}
    }
    await sleep(100)
  }
  log('брут со столба', { swings, arrows, hp: Math.round(bot.health ?? 0), alive: !!bot.entities[brute.id], s: Math.round((gameClock.now() - t0) / 1000) })
  // Слезть: копать столб под собой (блоки назад в рюкзак).
  try { await require('.././pearls').pillarDown(bot, ctl, session.mcData, base) } catch {}
  return true
}

let FAST_SAFE = process.env.ND_GOLD_FAST_SAFE === '1'

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
  const hit = require('../assess').afterArmor(13, armor, tough)
  const pDeath = hp <= hit ? 0.9 : hp <= 2 * hit ? 0.25 : 0.01
  return { take: pDeath * deathS < valueS, pDeath, hit: Math.round(hit * 10) / 10 }
}
/** S1f (проверка S1e (е)): переждать злость от золота перед ямой — цена. Злых (angerSet — кого злит ломка) нет — не ждать. Есть —
 *  каждый ~2 удара мечом пиглина (5 + золотой меч, после нашей брони) по пути к яме; риск смерти × час против оставшихся секунд злости. */
function pitAngerWait ({ angry, hp, leftS, gear = {} as any, deathS = 3600 }) {
  if (!angry) return { wait: false, why: 'злить некого' }
  const dmg = angry * 2 * require('../assess').afterArmor(8, gear.armor || 0, gear.tough || 0)
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

function goldExposes (bot, S, pos) {
  const SL = require('.././sealed')
  for (const [dx, dy, dz] of SL.FACES) {
    const n = pos.offset(dx, dy, dz)
    if (S.own.has(SL.keyV(n))) continue
    const b = bot.blockAt(n)
    if (FAST_SAFE ? !fullCover(b) : (!b || b.boundingBox === 'empty' || /lava|water/.test(b.name))) return true
  }
  return false
}

async function hunker (session, ctl, st, why, attacker = null) {
  const bot = session.bot
  const SL = require('.././sealed')
  const S = st.sealedState
  if (!inOwnTunnel(bot, S) || SL.fillerCount(bot) < 3) return false
  try { bot.pathfinder.setGoal(null) } catch {}
  bot.clearControlStates()
  const t0 = gameClock.now()
  const seal = async () => {
    const r = await sealBody(bot, S)
    const top = bot.entity.position.floored().offset(0, 2, 0)
    const tb = bot.blockAt(top)
    if (tb && tb.boundingBox === 'empty' && !/lava|water/.test(tb.name) && await SL.fillCell(bot, top)) { S.own.delete(SL.keyV(top)); r.n++; (S.filled || (S.filled = new Set())).add(SL.keyV(top)) }
    return r
  }
  // В безопасном режиме сначала сохранить возможность отступления: sealBody закладывает и свой ход.
  let r = st.fastSafe ? { n: 0, left: [], risky: ['до заделки'] } : await seal()
  let stepped = false
  // Враг в соседней клетке (заложить нельзя) — шаг вглубь своего штрека, прочь от него, и заложиться снова.
  const foe = attacker || foesNear(bot, 4).sort((a: any, b: any) => a.position.distanceTo(bot.entity.position) - b.position.distanceTo(bot.entity.position))[0]
  if (r.risky.length && foe && foe.position.distanceTo(bot.entity.position) < 3.5) {
    const f = bot.entity.position.floored()
    const opts = []
    for (const [dx, dz] of SIDES4) {
      const c = f.offset(dx, 0, dz)
      const h = c.offset(0, 1, 0)
      const fl = c.offset(0, -1, 0)
      const bc = bot.blockAt(c); const bh = bot.blockAt(h); const bf = bot.blockAt(fl)
      if (!bc || !bh || !bf || bc.boundingBox !== 'empty' || bh.boundingBox !== 'empty' || bf.boundingBox !== 'block') continue
      if (!S.own.has(SL.keyV(c)) && !S.own.has(SL.keyV(h))) continue
      opts.push({ c, d: c.distanceTo(foe.position) })
    }
    opts.sort((a, b) => b.d - a.d)
    if (opts.length && opts[0].d > f.distanceTo(foe.position)) {
      const back = f
      stepped = await centerIn(bot, opts[0].c, 1500)
      if (stepped) {
        // Клетки, откуда ушли, — заложить (между нами и врагом).
        for (const v of [back.offset(0, 1, 0), back]) if (await SL.fillCell(bot, v)) { S.own.delete(SL.keyV(v)); (S.filled || (S.filled = new Set())).add(SL.keyV(v)) }
        r = await seal()
      }
    }
  }
  if (st.fastSafe && !stepped) r = await seal()
  S.exposed = SL.exposure(bot, S.own).length > 0
  st.hunkers = (st.hunkers || 0) + 1
  log('штрек: удар — заложился', { why, n: r.n, left: r.left.length, risky: r.risky.length, stepped, exposed: S.exposed, hp: Math.round(bot.health ?? 0), foe: foe ? foe.name : null })
  // Сидеть, пока злые рядом. Бьют и в кармане (враг уже внутри: R26 02.10 — пиглин в 0.3 бл., «заложился», 4 удара
  // за 4 с, 20 → 0) — не сидеть: бой с ближним (обычный пиглин — 16 хп, три удара железным мечом).
  let hp0 = bot.health ?? 20
  while (!ctl.aborted && gameClock.now() - t0 < 25000) {
    if (!foesNear(bot, 10).length && gameClock.now() - t0 > 4000) break
    const hp = bot.health ?? 20
    const inside: any = foesNear(bot, 2.2)[0]
    if (inside || hp <= hp0 - 3) {
      log('штрек: бьют в кармане — бой', { foe: inside ? inside.name : null, hp: Math.round(hp), was: Math.round(hp0) })
      return false
    }
    hp0 = Math.max(hp0, hp)
    if (hp < 16) await eatIfHungry(session, ctl)
    await sleep(400)
  }
  return true
}

function burrowColumn (bot, f) {
  const SL = require('.././sealed')
  const cls = v => SL.classOf(bot.blockAt(v))
  const safe = FAST_SAFE
  const cover = v => !safe || fullCover(bot.blockAt(v))
  const c = [f.offset(0, -1, 0), f.offset(0, -2, 0), f.offset(0, -3, 0)]
  if (!c.every(v => cls(v) === SL.SOLID && cover(v))) return false
  const fl = cls(f.offset(0, -4, 0))
  if (!(fl === SL.SOLID || fl === SL.HARD || fl === SL.GUARD) || !cover(f.offset(0, -4, 0))) return false
  for (const v of c) {
    for (const [dx, dy, dz] of SL.FACES) {
      if (dx === 0 && dz === 0) continue
      const k = cls(v.offset(dx, dy, dz))
      if ((k !== SL.SOLID && k !== SL.HARD && k !== SL.GUARD && k !== SL.FALL) || !cover(v.offset(dx, dy, dz))) return false
    }
  }
  // Ни лавы, ни воды в клетке под полом и вокруг пола.
  for (const [dx, dz] of [[0, 0], ...SIDES4]) if (cls(f.offset(dx, -4, dz)) === SL.FLUID || cls(f.offset(dx, -5, dz)) === SL.FLUID) return false
  return true
}

async function burrow (session, ctl, st, why = '') {
  // Вслепую — по видимому (nether-cover.coverHere): колонна burrowColumn выбиралась по скрытым блокам (Codex q9).
  if (require('.././nether-cover').blind()) return require('.././nether-cover').coverHere(session, ctl)
  const bot = session.bot
  const SL = require('.././sealed')
  if (SL.fillerCount(bot) < 2) return { ok: false, why: 'нечем заложить шахту' }
  if (!bot.entity.onGround) return { ok: false, why: 'не на земле' }
  const me = bot.entity.position.floored()
  // Уже в своём штреке/кармане — глубже не закапываться: штрек отсюда не начался не из-за открытого места, а повтор
  // спускал тело по 3 клетки за ход до самого дна Ада (neF-R21-1 02.10: тело на y 5, «пути нет» ×5000 ходов).
  const own0 = require('.././tunnel').ownSet(session)
  if (own0.has(SL.keyV(me)) || own0.has(SL.keyV(me.offset(0, 1, 0))) || (st.sealedState && st.sealedState.own && st.sealedState.own.has(SL.keyV(me)))) return { ok: false, why: 'уже в своём штреке — закапываться глубже незачем' }
  if (me.y < 30) return { ok: false, why: `низко (y ${me.y}) — у дна Ада лава` }
  let f = burrowColumn(bot, me) ? me : null
  if (!f) {
    const cands = []
    for (let dx = -6; dx <= 6; dx++) {
      for (let dz = -6; dz <= 6; dz++) {
        for (let dy = -3; dy <= 3; dy++) {
          const v = me.offset(dx, dy, dz)
          const b = bot.blockAt(v); const h = bot.blockAt(v.offset(0, 1, 0))
          if (!b || !h || b.boundingBox !== 'empty' || h.boundingBox !== 'empty' || /lava|water|fire/.test(b.name + h.name)) continue
          if (!burrowColumn(bot, v)) continue
          cands.push({ v, d: Math.abs(dx) + Math.abs(dz) + 2 * Math.abs(dy) })
        }
      }
    }
    cands.sort((a, b) => a.d - b.d)
    for (const c of cands.slice(0, 3)) {
      const w = await walkGoal(session, ctl, new goals.GoalBlock(c.v.x, c.v.y, c.v.z), 12000, { dig: false })
      const at = bot.entity.position.floored()
      if (at.equals(c.v) && burrowColumn(bot, at)) { f = at; break }
      log('закопаться: к колонне не дошёл', { to: xyz(c.v), at: xyz(at), ok: w && w.ok })
    }
    if (!f) return { ok: false, why: cands.length ? 'к колонне не дошёл' : 'колонны в толще рядом нет' }
  }
  const safe = FAST_SAFE
  if (safe) { try { bot.pathfinder.setGoal(null) } catch {} ; bot.clearControlStates() }
  const centered = await centerIn(bot, f, 1500)
  if (safe && (!centered || !burrowColumn(bot, f))) return { ok: false, why: 'колонна изменилась или не встал' }
  for (let i = 1; i <= 3; i++) {
    if (safe && (ctl.aborted || (bot.health ?? 20) <= 0)) return { ok: false, why: 'закопаться: прервано' }
    const v = f.offset(0, -i, 0)
    const r = await SL.digCell(bot, v)
    if (r !== 'ok' && r !== 'air') return { ok: false, why: `копка ${xyz(v).x},${xyz(v).y},${xyz(v).z}: ${r}` }
    for (let k = 0; k < 20 && bot.entity.position.y > v.y + 0.2; k++) await sleep(50)
  }
  for (let k = 0; k < 20 && !bot.entity.onGround; k++) await sleep(50)
  if (safe && (!bot.entity.onGround || bot.entity.position.distanceTo(f.offset(0.5, -3, 0.5)) > 0.25)) return { ok: false, why: 'не приземлился на дно шахты' }
  const top = f.offset(0, -1, 0)
  const sealed = await SL.fillCell(bot, top)
  if (safe && (!sealed || !fullCover(bot.blockAt(top)))) return { ok: false, why: 'пробка не закрыла шахту' }
  const cells = [f.offset(0, -3, 0), f.offset(0, -2, 0)].map(v => SL.keyV(v))
  try { require('.././tunnel').rememberOwn(session, new Set(cells)) } catch {}
  if (st.sealedState && st.sealedState.own) for (const k of cells) st.sealedState.own.add(k)
  st.burrows = (st.burrows || 0) + 1
  log('закопался', { why, at: xyz(bot.entity.position.floored()), sealed, moved: !f.equals(me) })
  return { ok: sealed, sealed, at: xyz(bot.entity.position.floored()) }
}

async function answerAttack (session, ctl, st) {
  const bot = session.bot
  const combat = require('.././combat')
  const a = combat.liveAttacker(session)
  if (!a || !a.position || a.position.distanceTo(bot.entity.position) > 8) {
    // ND_BRUTE_HUNKER=1: брут ближе 9 бл., а ход вскрыт — заложиться до удара (D6-24 03.10: выход штреком после
    // бартера, брут — 3 удара за 2 с, 20 → 0; ответ на удар запаздывает). Не чаще раза в 8 с.
    const S = st.sealedState
    if (process.env.ND_BRUTE_HUNKER === '1' && S && S.exposed && gameClock.now() - (st.bruteHunkAt || 0) > 8000 && inOwnTunnel(bot, S)) {
      const b: any = mobs(bot, 'piglin_brute', 9).sort((x: any, y: any) => x.position.distanceTo(bot.entity.position) - y.position.distanceTo(bot.entity.position))[0]
      if (b) {
        st.bruteHunkAt = gameClock.now()
        st.preHunkers = (st.preHunkers || 0) + 1
        if (await hunker(session, ctl, st, `брут в ${b.position.distanceTo(bot.entity.position).toFixed(1)} бл.`, b)) return true
      }
    }
    return false
  }
  // В своём закрытом штреке — не бой и не столб: заложиться (hunker). Пиглин/брут/хоглин — у пролома к двору.
  // Обычный пиглин уже вплотную (≤ 2.5 бл.) — бой, а не заложиться: он в нашем ходу, клетку с ним не заложить.
  const close = a.position.distanceTo(bot.entity.position) < 2.5
  // Скелет (долина песка душ у бастиона) стреляет в наш ход: бой с ним из штрека — 25 с без удара (он ниже/за углом), 10
  // стрел за 27 с, 20 → 0 (neF-Sc26-2 02.10). Заложиться — луча нет, стрел нет.
  if (/^(piglin_brute|piglin|hoglin|zoglin|skeleton)$/.test(a.name || '') && !(a.name === 'piglin' && close) && inOwnTunnel(bot, st.sealedState) && await hunker(session, ctl, st, 'удар ' + a.name, a)) return true
  if (a.name === 'piglin_brute') { await bruteDefense(session, ctl, st, a); return true }
  if (process.env.ND_GUARD !== '0') {
    const G = require('.././ne-guard')
    if (G.HIDE_FROM.test(a.name || '') || G.meleeFoes(bot, 6).length >= 3 || (bot.health ?? 20) < 9) {
      const rr = await G.react(session, ctl, { force: { e: a, why: 'удар ' + a.name }, onOwn: cells => { if (st.sealedState && st.sealedState.own) for (const k of cells) st.sealedState.own.add(k) } })
      if (rr.cancelled || rr.acted === false) return false
      st.fights.push(a.name + ': ' + (rr.how || 'ответ'))
      return true
    }
  }
  try {
    const f = await combat.fight(session, ctl, { target: '#' + a.id, timeoutSeconds: 25, retreatAtHealth: 6, clearArea: 0 })
    st.fights.push(`${a.name}${f && (f.killed || (f.kills && f.kills.length)) ? ' убит' : ''}`)
  } catch (e) { st.fights.push(`${a.name}: ${e.message}`) }
  return true
}

async function digToPredicted (session, ctl, st, t) {
  const bot = session.bot
  // Пол Ада для pathfinder (worlds.tuneMovements: не ниже min(40, где стоишь))
  const floor0 = bot._ndNetherFloor
  // Пол 32 (над морем лавы): к стенам ведут полы жилых блоков на y 35–40, и пол
  bot._ndNetherFloor = 32
  bot._ndMobAvoidOnly = new Set(['piglin_brute', 'hoglin'])
  bot._ndLavaStrict = true
  try { return await digToPredictedBody(session, ctl, st, t) } finally { bot._ndNetherFloor = floor0; bot._ndMobAvoidOnly = null; bot._ndLavaStrict = false }
}

async function digToPredictedBody (session, ctl, st, t) {
  const bot = session.bot
  // Стена известна — сперва на её кромку поверху (один раз за вызов).
  const pr = st.pred.get(t.k)
  if (st.outside && pr && pr.wall && !st.onWall && (st.wallTries || 0) < 2) {
    st.wallTries = (st.wallTries || 0) + 1
    // high — вход в толщу стены высоко над лавой (approachWallSide), иначе
    // прежний подход к низу внешних граней.
    const a = st.high ? await approachWallSide(session, ctl, pr.wall, t.pos) : await approachWallTop(session, ctl, pr.wall)
    st.onWall = a.ok
    log('на кромку стены', { top: xyz(a.top), ok: a.ok, error: a.error, at: xyz(bot.entity.position.floored()) })
  }
  // Брут видит нас — сначала он (столб, удары сверху: bruteDefense), а не
  // общий бой по дороге («бой без победы» с брутом и хоглином на ферме).
  if (mobs(bot, 'piglin_brute', 16).some(e => seesMob(bot, e))) { try { await bruteDefense(session, ctl, st) } catch {} }
  // Издалека — pathfinder к цели на 5 блоков (он ходит по бастиону и копает
  if (!st.onWall && t.pos.distanceTo(bot.entity.position) > 9) {
    const pf0 = bot.pathfinder
    const th0 = pf0 && pf0.thinkTimeout
    if (pf0) pf0.thinkTimeout = 12000
    try { await walkUnlessBrute(session, ctl, new goals.GoalNear(t.pos.x, t.pos.y, t.pos.z, 5), 45000, { dig: true }) } catch {} finally { if (pf0) pf0.thinkTimeout = th0 }
    if (bruteComing(bot)) return { walk: 'брут идёт', block: '?' }
  }
  // Сначала пешком (без копки) к ближайшей к цели клетке, куда можно дойти, и
  try {
    const { walkable } = require('.././walkable')
    let stage = null
    let bestD = Infinity
    for (const n of walkable(bot, bot.entity.position, { radius: 40, maxNodes: 8000 })) {
      const d = n.pos.distanceTo(t.pos)
      if (d < bestD) { bestD = d; stage = n.pos }
    }
    if (!st.onWall && stage && stage.distanceTo(bot.entity.position) > 2 && bestD + 3 < t.pos.distanceTo(bot.entity.position)) {
      await walkGoal(session, ctl, new goals.GoalBlock(stage.x, stage.y, stage.z), 30000, { dig: false })
    }
  } catch {}
  const trail = []
  const samp = gameClock.setInterval(() => { try { const f = bot.entity.position.floored(); const last = trail[trail.length - 1]; if (!last || !last.equals(f)) trail.push(f) } catch {} }, 200)
  let w
  // Свой штрек по шагу; упёрся — pathfinder с копкой (до 12 с на решение).
  let tun = null
  try {
    tun = await tunnelTo(session, ctl, t.pos)
    w = { ok: tun.ok, error: tun.why }
    // Из толщи стены (high) — только свой штрек: pathfinder с копкой уводил во двор.
    if (!tun.ok && !ctl.aborted && !(st.high && st.onWall)) {
      const pf = bot.pathfinder
      const think = pf && pf.thinkTimeout
      if (pf) pf.thinkTimeout = 12000
      try { w = await walkGoal(session, ctl, new goals.GoalGetToBlock(t.pos.x, t.pos.y, t.pos.z), 45000, { dig: true }) } finally { if (pf) pf.thinkTimeout = think }
    }
  } finally { gameClock.clearInterval(samp) }
  const b = bot.blockAt(t.pos)
  const res: any = { walk: w && w.ok ? 'ok' : (w && w.error) || '?', block: b ? b.name : '?', tunnel: tun ? { ok: tun.ok, steps: tun.steps, why: tun.why } : undefined }
  if (!(w && w.ok)) { st.skip.set(t.k, gameClock.now() + 45000); st.predMiss = (st.predMiss || 0) + 1; return res }
  if (b && b.boundingBox === 'empty' && st.blocks > 0 && t.pos.distanceTo(bot.entity.position) < 3) {
    // Воздух на месте предсказанного — уже выкопан (с видимого списка), не промах.
    st.pred.delete(t.k)
    return { ...res, r: 'уже выкопан' }
  }
  if (!b || b.name !== 'gold_block') {
    // Видим клетку, а золота нет — гипотеза этого ранга неверна целиком.
    const rank = (st.pred.get(t.k) || {}).rank
    st.pred.delete(t.k)
    st.predWrong = (st.predWrong || 0) + 1
    // Два промаха одного ранга (процессор generic превращает 30% золота в
    // треснутый кирпич — один промах ещё не приговор).
    if (b && b.boundingBox === 'block' && seesBlock(bot, b)) {
      st.rankMiss = st.rankMiss || {}
      st.rankMiss[rank] = (st.rankMiss[rank] || 0) + 1
      if (st.rankMiss[rank] >= 2) for (const [k, v] of [...st.pred.entries()]) if (v.rank === rank || (rank >= 100 && rank % 100 === 0 && Math.floor((v.rank || 0) / 100) === rank / 100)) st.pred.delete(k)
    }
    return { ...res, r: 'не золото', rank }
  }
  // Злые дойдут по штреку — закрыть его за спиной (ноги и голова).
  const set = reachSet(bot)
  const pigs = angerSet(bot).filter(e => threatens(bot, e, set))
  if (pigs.length && trail.length >= 2) {
    const { placeBlockAt } = require('.././build')
    const me = bot.entity.position.floored()
    const back = [...trail].reverse().find(c => !c.equals(me) && c.distanceTo(me) <= 1.5)
    if (back) {
      for (const c of [back, back.offset(0, 1, 0)]) { try { await placeBlockAt(bot, c, { timeoutMs: 1500 }) } catch {} }
      res.sealed = xyz(back)
    }
  }
  st.pred.delete(t.k)
  st.gold.set(t.k, { pos: t.pos.clone(), seen: gameClock.now() })
  res.r = await takeGoldBlock(session, ctl, t.pos, st)
  return res
}

async function sealedGold (session, ctl, st, until) {
  const bot = session.bot
  const dimension = bot.game?.dimension
  const SL = require('.././sealed')
  const S = st.sealedState || (st.sealedState = { own: new Set(), exposed: true, dug: 0, moves: 0, fills: 0, ores: 0, bonusBlocks: 0, goldPassed: 0, plans: 0, fails: [], planMs: 0, walks: 0 })
  S.deadline = until
  S.onThreat = async () => { try { await answerAttack(session, ctl, st) } catch {} }
  // BonusGold обходит проверку цели; в этом эксперименте охраняемое копаем только здесь.
  if (st.fastSafe) S.noBonus = true
  let noPlan = 0
  while (!ctl.aborted && gameClock.now() < until - 10000) {
    if (session.bot !== bot || !bot.entity || (bot.health ?? 0) <= 0 || bot.game?.dimension !== dimension || bot._ndGuard?.ended) break
    if (st.fastSafe && st.stopMining && st.stopMining()) break
    if (inLava(bot)) { if (!(await lavaEscape(bot))) await lavaEscapeDeep(bot); continue }
    // Злые пиглины у вскрытого хода (золото касалось двора): сперва ответить — neF-map23-3 02.10: 4 удара и стрела
    // за 5 с, тело планировало следующий ход, 20 → 0 хп («slain by Piglin»). Брут — bruteDefense (столб).
    if (await answerAttack(session, ctl, st)) continue
    // Штрек вскрыт, а брут/хоглин уже в 6 бл. — заложиться до удара (удар брута 7+, трёх хватает на 20 хп).
    if (S.exposed && inOwnTunnel(bot, S) && foesNear(bot, 6).some((e : any) => FOES_RE.test(e.name || '')) && await hunker(session, ctl, st, 'враг у пролома')) continue
    if ((bot.health ?? 20) < 8) { await eatIfHungry(session, ctl); if ((bot.health ?? 20) < 8) { S.fails.push('хп'); break } }
    await eatIfHungry(session, ctl)
    // Без золотой брони: первое золото (сундук, блок) — сразу в броню, пока тело в закрытом штреке (верстак встаёт внутри), а не
    // после всего захода (ревью Codex 14.10): дальше пиглины к нам нейтральны, и вскрытия/бартер не под их ударами.
    if (st.goldless && !S.exposed && inOwnTunnel(bot, S) &&
        countOf(bot, 'gold_ingot') + 9 * countOf(bot, 'gold_block') + Math.floor(countOf(bot, 'gold_nugget') / 9) >= 4 ||
        st.goldless && GOLD_ARMOR_RE.test(bot.inventory.items().map(i => i.name).join(' '))) {
      if (await armGold(session, ctl)) { st.goldless = false; log('штрек: золотая броня из первого золота', { ingots: countOf(bot, 'gold_ingot'), blocks: countOf(bot, 'gold_block') }) }
    }
    // Кирки в штреке: каменные кончились — фильтр бастиона пускал железную на чернокамень и незерак, она стиралась, и
    if (process.env.ND_GUARD !== '0') {
      const G = require('.././ne-guard')
      const h = G.hot(bot, { near: 5 })
      if (h) {
        const rr = await G.react(session, ctl, { force: h, onOwn: cells => { for (const k of cells) S.own.add(k) } })
        if (rr.cancelled || ctl.aborted || session.bot !== bot) break
        if (rr.acted !== false) {
          S.exposed = SL.exposure(bot, S.own).length > 0
          log('штрек: страж', { why: h.why, how: rr.how, hp: Math.round(bot.health ?? 0) })
          continue
        }
      }
    }
    {
      const TN = require('.././tunnel')
      if (TN.lowPicks(bot) === 0) { const made = await TN.restockPicks(session, ctl, 3).catch(() => 0); log('штрек: каменные кирки', { made }) }
      if (!bot.inventory.items().some(i => GOLD_PICK.test(i.name)) && !st.chestsOnly) {
        const made = await makeIronPick(session, ctl).catch(() => false)
        log('штрек: железная кирка', { made, ingots: countOf(bot, 'iron_ingot'), nuggets: countOf(bot, 'iron_nugget') })
        if (!made) { S.fails.push('нет железной кирки'); break }
      }
      // Свои клетки тела после крафта (верстак мог сдвинуть тело на клетку).
      const bc = [bot.entity.position.floored(), bot.entity.position.floored().offset(0, 1, 0)]
      if (bc.some(v => S.own.has(SL.keyV(v)))) for (const v of bc) { const b = bot.blockAt(v); if (b && b.boundingBox === 'empty') S.own.add(SL.keyV(v)) }
    }
    // Предсказания, уже выкопанные попутно (штрек прошёл сквозь них), — снять.
    for (const [k, v] of [...st.pred.entries()]) { const b = bot.blockAt(v.pos); if (b && b.boundingBox === 'empty' && S.own.has(k)) st.pred.delete(k) }
    for (const [k, g] of st.gold) if (!st.pred.has(k) && !S.own.has(k)) st.pred.set(k, { pos: g.pos, piece: 'видно', rank: 0 })
    // Без железной кирки (st.chestsOnly) — только сундуки: золото ей не взять, а железо в сундуках есть.
    // Цели в 6 бл. от дома брута копии — не трогать (S1d s1d-N-2: сундук у брута, 2 удара за секунду, смерть на 7-й мин).
    const BH6 = require('.././nether-route').bruteSpots(session)
    const gear6 = require('.././assess').gearOf((bot.inventory.slots || []).slice(5, 9))
    const preds = st.chestsOnly ? [] : targetsByBruteHome([...st.pred.entries()].filter(([k]) => (st.skip.get(k) || 0) < gameClock.now()), ([, v]) => v.pos, BH6, bot.health ?? 20, gear6)
    const chestsT = st.lootChests ? [...st.chestSeen.entries()].filter(([k]) => !st.looted.has(k) && (st.skip.get(k) || 0) < gameClock.now()).map(([k, v]) => ({ k, pos: v.pos, chest: true })) : []
    if (!preds.length && !chestsT.length) break
    const chestsOk = targetsByBruteHome(chestsT, c => c.pos, BH6, bot.health ?? 20, gear6)
    if (!preds.length && !chestsOk.length) break
    const minRank = preds.length ? Math.min(...preds.map(([, v]) => v.rank || 0)) : 0
    const tg = [...preds.filter(([, v]) => (v.rank || 0) === minRank).map(([k, v]) => ({ k, pos: v.pos })), ...(minRank === 0 ? chestsOk : [])]
    const view = SL.worldView(bot)
    // S1f: клетка ног — с поправкой на песок душ (высота 0.875: на нём floored() — клетка самого песка). План от floored() начинался
    // внутри пола: «не шагнул vdown/up … (я …,N.88,…) пол soul_sand» — 50 из 61 остановок штрека во вслепую сериях S1e/S1f, заход с 0
    // золота при верном шаблоне. ND_SOUL_FEET=0 — прежнее.
    const feet = () => process.env.ND_SOUL_FEET === '0' ? bot.entity.position.floored() : SL.bodyCells(bot)[0]
    const me = feet()
    let starts
    const inTunnel = S.own.has(SL.keyV(me)) && !S.exposed
    if (inTunnel) starts = [{ x: me.x, y: me.y, z: me.z, g: 0 }]
    else {
      // Из открытого: клетки заливки; у брута и хоглина (10 блоков) — дороже.
      const danger = [...mobs(bot, 'piglin_brute', 40), ...mobs(bot, 'hoglin', 40)].map((e : any) => e.position)
      starts = []
      for (const n of SL.reachCells(view, process.env.ND_SOUL_FEET === '0' ? bot.entity.position : me, { radius: 28, maxNodes: 5000 })) {
        if (S.badStarts && S.badStarts.has(SL.key(n.x, n.y, n.z))) continue
        let g = n.d * 4
        for (const d of danger) { const dd = d.distanceTo(new Vec3(n.x, n.y, n.z)); if (dd < 10) g += (10 - dd) * 4 }
        starts.push({ x: n.x, y: n.y, z: n.z, g })
      }
      if (S.own.has(SL.keyV(me))) starts.push({ x: me.x, y: me.y, z: me.z, g: 0 })
    }
    const tgGoals = tg.map(t => ({ t, rank: minRank, g: SL.adjacentGoal(t.pos, view.cls), h: SL.manhattan(t.pos) }))
    if (!st.predAll) st.predAll = [...st.pred.values()].map(v => ({ rank: v.rank || 0, pos: v.pos.clone() }))
    const xs = [...starts.map(s => s.x), ...tg.map(t => t.pos.x)]
    const ys = [...starts.map(s => s.y), ...tg.map(t => t.pos.y)]
    const zs = [...starts.map(s => s.z), ...tg.map(t => t.pos.z)]
    const box = { x0: Math.min(...xs) - 14, x1: Math.max(...xs) + 14, y0: Math.max(5, Math.min(...ys) - 8), y1: Math.min(120, Math.max(...ys) + 12), z0: Math.min(...zs) - 14, z1: Math.max(...zs) + 14 }
    const t0 = gameClock.wall.now()
    const planO = {
      cls: view.cls, dig: view.dig, own: S.own, starts, box, maxNodes: inTunnel ? 60000 : 160000,
      goal: (x, y, z) => tgGoals.some(q => q.g(x, y, z)),
      h: (x, y, z) => Math.min(...tgGoals.map(q => q.h(x, y, z))),
      targets: new Set(tg.filter((t : any) => !t.chest).map(t => t.k)), vup: SL.fillerCount(bot) >= 6
    }
    let r = await SL.plan(planO)
    // Вход из открытой пещеры: первая клетка в толще почти всегда касается воздуха пещеры сбоку (неровная стена), и
    let entryBreach = null
    // ND_ANGER_SAFE=1: золото сломано меньше 30 с назад (злость пиглинов — 600 тиков), злые в 16 — не вскрывать ход во двор,
    // а переждать заложившись (D7s9c-31 03.10: золото в закрытом ходе, следом «вход со вскрытием» — пиглины, смерть).
    if (!r.ok && st.breach && process.env.ND_ANGER_SAFE === '1' && st.lastBreak && gameClock.now() - st.lastBreak < 30000 && angerSet(bot, null, false).length) {
      log('штрек: злость после золота — вскрытие подожду', { s: Math.round((gameClock.now() - st.lastBreak) / 1000), n: angerSet(bot, null, false).length })
      await sealBody(bot, S).catch(() => null)
      while (!ctl.aborted && gameClock.now() - st.lastBreak < 31000) await sleep(500)
    }
    if (!r.ok && st.breach && (starts.length || tg.length)) {
      const near = new Set()
      const around = (p, dyLo, dyHi) => { for (let dx = -2; dx <= 2; dx++) for (let dz = -2; dz <= 2; dz++) if (Math.abs(dx) + Math.abs(dz) <= 2) for (let dy = dyLo; dy <= dyHi; dy++) near.add(SL.key(p.x + dx, p.y + dy, p.z + dz)) }
      if (!inTunnel) for (const st0 of starts.slice().sort((a, b) => a.g - b.g).slice(0, 300)) around(st0, -1, 3)
      for (const t of (tg as any)) if (!t.chest) around(t.pos, -2, 2)
      entryBreach = ck => near.has(ck)
      const r2 = await SL.plan({ ...planO, breachOk: (ck) => entryBreach(ck), breachCost: 8 })
      log('штрек: вход из открытого со вскрытием', { ok: r2.ok, nodes: r2.nodes, why: r2.ok ? undefined : r2.why, starts: starts.length, from: inTunnel ? 'штрек' : 'снаружи' })
      if (r2.ok) r = r2
      else entryBreach = null
    }
    S.plans++
    S.planMs += gameClock.wall.now() - t0
    // Снаружи пути нет (все входы касаются чужого воздуха) — закопаться и планировать из своего кармана.
    if (!r.ok && !inTunnel && (st.burrowsSG || 0) < 2 && process.env.ND_BURROW !== '0') {
      st.burrowsSG = (st.burrowsSG || 0) + 1
      const bw = await burrow(session, ctl, st, 'штрек к золоту снаружи не начался')
      if (bw.ok) { S.exposed = SL.exposure(bot, S.own).length > 0; continue }
      log('закопаться не вышло', { why: bw.why })
    }
    if (!r.ok) {
      log('штрек: пути нет', { targets: tg.length, rank: minRank, nodes: r.nodes, why: r.why, from: inTunnel ? 'штрек' : 'снаружи', ms: gameClock.wall.now() - t0 })
      // Нет пути ни к одной цели этого ранга — отложить их; из штрека попробовать снаружи.
      for (const t of tg) st.skip.set(t.k, gameClock.now() + 10 * 60000)
      if (++noPlan >= 3) break
      continue
    }
    log('штрек: план', { from: r.start, moves: r.path.length, dig: r.path.reduce((n, m) => n + m.clear.length, 0), cost: Math.round(r.cost), nodes: r.nodes, ms: gameClock.wall.now() - t0 })
    // Без золотой брони ко входу по открытому не идти (пиглины видят — бьют): закопаться здесь и планировать из своего кармана.
    if (!inTunnel && st.goldless && !(me.x === r.start.x && me.y === r.start.y && me.z === r.start.z) && (st.burrowsSG || 0) < 2 && process.env.ND_BURROW !== '0') {
      st.burrowsSG = (st.burrowsSG || 0) + 1
      const bw = await burrow(session, ctl, st, 'без золотой брони ко входу штрека по открытому не иду')
      if (bw.ok) { S.exposed = SL.exposure(bot, S.own).length > 0; continue }
      log('закопаться не вышло', { why: bw.why })
    }
    // Вход из открытого — сперва дойти ногами (без копки) до клетки входа.
    if (!inTunnel && !(me.x === r.start.x && me.y === r.start.y && me.z === r.start.z)) {
      S.walks++
      // Пол Ада для pathfinder (worlds: не ниже min(40, где стоишь)) — опустить до входа, иначе «пустой путь».
      const floor0 = bot._ndNetherFloor
      bot._ndNetherFloor = Math.min(floor0 ?? 40, r.start.y - 2)
      let w
      try { w = await walkUnlessBrute(session, ctl, new goals.GoalBlock(r.start.x, r.start.y, r.start.z), 30000, { dig: false }) } finally { bot._ndNetherFloor = floor0 }
      const f = feet()
      if (!(f.x === r.start.x && f.y === r.start.y && f.z === r.start.z)) {
        // Этот вход ногами не взять — в следующих планах его нет (sealed booth-1: 15 раз «пустой путь» к одной клетке).
        (S.badStarts || (S.badStarts = new Set())).add(SL.key(r.start.x, r.start.y, r.start.z))
        S.fails.push(`ко входу: ${(w && w.error) || 'не дошёл'}`); if (S.fails.length > 14) break
        // Пешком не выйти ни к одной клетке входа (тело в яме после спуска со столба, у злых пиглинов
        S.walkFails = (S.walkFails || 0) + 1
        if (S.walkFails >= 2) { for (const v of [f, f.offset(0, 1, 0)]) S.own.add(SL.keyV(v)); S.exposed = true }
        continue
      }
      S.exposed = true
    }
    if (!inTunnel) S.entry = { x: r.start.x, y: r.start.y, z: r.start.z }
    const prevBreach = S.breachOk
    if (entryBreach) S.breachOk = (k, nk) => entryBreach(k) || !!(prevBreach && prevBreach(k, nk))
    let ex
    try { ex = await SL.execute(session, ctl, r.path, S) } finally { if (entryBreach) S.breachOk = prevBreach }
    if (!ex.ok) {
      S.fails.push(ex.why)
      log('штрек: стоп', { why: ex.why, done: ex.done, of: r.path.length, at: xyz(bot.entity.position.floored()) })
      if (S.fails.length > 14) break
      continue
    }
    const f = feet()
    const hit = tgGoals.find(q => q.g(f.x, f.y, f.z))
    if (!hit) continue
    const t: any = hit.t
    if (t.chest) {
      // Сундук из штрека: нас не видит никто — открыть не злит (ChestBlock: злит видящих).
      let took = null
      try { took = await require('.././structures').takeWorth(session, ctl, t.pos, { kind: 'bastion' }) } catch (e) { took = { error: e.message } }
      if (miningCycle.confirmedChestLoot(took, t.pos, ctl.aborted)) st.looted.add(t.k)
      else st.skip.set(t.k, gameClock.now() + 60000)
      st.chests.push({ at: t.k, took: (took && took.took) || {}, stopped: took && (took.stopped || took.error) })
      log('штрек: сундук', { at: t.k, took: took && took.took, stopped: took && (took.stopped || took.error) })
      continue
    }
    const b = bot.blockAt(t.pos)
    // Штрек прошёл сквозь цель (золото взято по пути) — не промах.
    if (b && b.boundingBox === 'empty' && S.own.has(t.k)) { st.pred.delete(t.k); continue }
    if (!b || b.name !== 'gold_block') {
      // Стоим вплотную и видим: не золото — промах гипотезы этого ранга.
      const rank = (st.pred.get(t.k) || {}).rank
      st.pred.delete(t.k)
      st.predWrong = (st.predWrong || 0) + 1
      if (b && b.boundingBox === 'block') {
        st.rankMiss = st.rankMiss || {}
        st.rankMiss[rank] = (st.rankMiss[rank] || 0) + 1
        if (st.rankMiss[rank] >= 2) for (const [k, v] of [...st.pred.entries()]) if (v.rank === rank || (rank >= 100 && rank % 100 === 0 && Math.floor((v.rank || 0) / 100) === rank / 100)) st.pred.delete(k)
      }
      log('штрек: не золото', { at: t.k, block: b ? b.name : '?', rank })
      continue
    }
    // Ломка золота на глазах у пиглина злит всех в 16 бл. (PiglinAi.angerNearbyPiglins с проверкой луча) — штрек открыт
    const opens = goldExposes(bot, S, t.pos)
    // Ломка gold_block: requireLineOfSight=false. До изоляции мобов не вскрываем двор,
    const upC = t.pos.offset(0, 1, 0); const dnC = t.pos.offset(0, -1, 0)
    const win1 = fullCover(bot.blockAt(upC)) && !S.own.has(SL.keyV(upC)) && fullCover(bot.blockAt(dnC)) && !S.own.has(SL.keyV(dnC))
    const strongNear = [...mobs(bot, 'piglin_brute', 12), ...mobs(bot, 'hoglin', 12), ...mobs(bot, 'zoglin', 12)]
    // S1d 07.10: дыра от ломки — всегда одна клетка золота, её заделка закрывает штрек снова. Удар пиглина/брута/хоглина через
    // клетку не достаёт (Mob.getAttackBoundingBox: вширь +0.83 — от центра 1.13…1.53, а между телами 2 бл.), злость от ломки
    // (PiglinAi.angerNearbyPiglins, без луча) копке в закрытом ходе не мешает — заделать сразу. Окно 1×1 (верх и низ закрыты)
    // больше не обязательно; нужно, чтобы слиток не выпал наружу: под золотом — своё или твёрдое (ND_GOLD_OPEN=0 — прежнее
    // правило). Данные: s1c std — 98 «небезопасное вскрытие» за прогон 7777…, ~50 % золота карты оставалось в стенах.
    const dnB = bot.blockAt(dnC)
    // Под золотом ступени/плиты тоже держат слиток (pair 2: 20 из 80 пропусков — ступени кирпича), воздух — нет.
    const dropSafe = S.own.has(SL.keyV(dnC)) || dnB?.boundingBox === 'block'
    const gC = t.pos.offset(0.5, 0, 0.5)
    const strongG = [...mobs(bot, 'piglin_brute', 8, gC), ...mobs(bot, 'hoglin', 8, gC), ...mobs(bot, 'zoglin', 8, gC)].length
    const onTop = (Object.values(bot.entities) as any[]).some((e : any) => e && e !== bot.entity && e.position && /^(hostile|animal|mob|passive|water_creature|ambient)$/.test(e.type || '') &&
      Math.hypot(e.position.x - gC.x, e.position.z - gC.z) < 1.3 && e.position.y >= t.pos.y + 0.5 && e.position.y <= t.pos.y + 2.5)
    let windowOk = goldWindowOk({ win1, dropSafe, strong: strongNear.length, strongG, onTop, hp: bot.health ?? 20 })
    // Дыра от ломки безопасна, только если она — ЕДИНСТВЕННЫЙ выход хода во двор (S1d s1d-AB-4 A: заплатка прошлого золота не
    // встала, ход открыт; следующее золото «окном» — злые пиглины вошли в пролом, 5 ударов, смерть на 12-й мин). Ход открыт —
    // сперва заложиться (sealBody); не вышло — как прежде, пропуск.
    if (windowOk && opens && SL.exposure(bot, S.own).length) {
      await sealBody(bot, S).catch(() => null)
      S.exposed = SL.exposure(bot, S.own).length > 0
      if (S.exposed) { windowOk = false; log('штрек: ход открыт — окно не ломаю', { at: t.k }) }
    }
    // Пиглин, разглядывающий золото (слиток в левой руке), не «бездельник»: angerNearbyPiglins злит только PiglinAi.isIdle
    // (Brain.isActive(Activity.IDLE), javap 1.21.11 PiglinAi.angerNearbyPiglins: filter isIdle → filter canSee при ломке
    // сундука; золотой блок — без луча). Такие пиглины ломке не мешают.
    const admiring = e => /^(gold_ingot|gold_block|golden_.*)$/.test(e.equipment?.[1]?.name || '')
    const exposedFoes = st.fastSafe && opens && !windowOk ? [
      ...mobs(bot, 'piglin', 18).filter(e => !isBaby(bot, e) && !admiring(e)),
      ...mobs(bot, 'piglin_brute', 18), ...mobs(bot, 'hoglin', 18), ...mobs(bot, 'zoglin', 18)
    ] : []
    if (st.fastSafe && opens && windowOk) log('штрек: золото окном 1×1 — ломаю и сразу заделываю', { at: t.k, piglins: mobs(bot, 'piglin', 18).length })
    if (exposedFoes.length || (st.fastSafe && opens && SL.fillerCount(bot) < 3)) {
      // Пиглины бродят: отложить на 2 мин, а не на 10 (s1c-A-2 06.10: 9 из 22 блоков карты «пропустил» при 2–4 пиглинах рядом,
      // к концу захода «золото по памяти осталось (16), пути нет»). Блоков на заделку нет — по-прежнему надолго.
      st.skip.set(t.k, gameClock.now() + (exposedFoes.length && SL.fillerCount(bot) >= 3 ? 120000 : 600000))
      log('штрек: небезопасное вскрытие — пропустил', { at: t.k, foes: exposedFoes.length, win1, dropSafe, strongG, onTop, up: bot.blockAt(upC)?.name, dn: bot.blockAt(dnC)?.name, strong: strongNear.length, hp: Math.round(bot.health ?? 0), filler: SL.fillerCount(bot) })
      continue
    }
    // Свой ход сам открыт во двор (вход «из открытого со вскрытием», заплатка не встала), а ломка злит всех пиглинов в 16 — сперва
    // заложиться, иначе отложить. S1d включил по умолчанию по одной смерти (s1d-AB-4 A) без парного A/B — S1e (проверка S1d (д)) вернул
    // как было: только ND_ANGER_SAFE=1, до A/B на снимках.
    if (process.env.ND_ANGER_SAFE === '1' && SL.exposure(bot, S.own).length && angerSet(bot, null, true).length) {
      await sealBody(bot, S).catch(() => null)
      S.exposed = SL.exposure(bot, S.own).length > 0
      if (S.exposed) {
        st.skip.set(t.k, gameClock.now() + 60000)
        log('штрек: ход открыт, пиглины в 16 — золото отложил', { at: t.k, n: angerSet(bot, null, true).length })
        continue
      }
    }
    const watchers = st.fastSafe ? [] : mobs(bot, 'piglin', 16).filter(p => seesMob(bot, p))
    if (watchers.length) { st.skip.set(t.k, gameClock.now() + 20000); log('штрек: золото — видят пиглины, отложил', { at: t.k, n: watchers.length, exposed: S.exposed }); await sleep(500); continue }
    // Ломка вскроет штрек во двор, а брут рядом (сквозь стены он не видит — но пролом увидит): отложить (neF-Pa22-1).
    const brutes = mobs(bot, 'piglin_brute', 16).filter((e : any) => raySees(bot, e.position.offset(0, (e.height || 1.95) * 0.92, 0), t.pos.offset(0.5, 0.5, 0.5)))
    if (brutes.length && goldExposes(bot, S, t.pos)) { st.skip.set(t.k, gameClock.now() + 30000); log('штрек: золото у двора, брут рядом — отложил', { at: t.k, n: brutes.length, d: Math.round(Math.min(...brutes.map((e : any) => e.position.distanceTo(t.pos)))) }); await sleep(500); continue }
    const had = countOf(bot, 'gold_block')
    const Drops = require('.././drops')
    const pickupMark = st.fastSafe ? Drops.pickupMark(bot) : null
    bot.setControlState('sneak', true)
    let dr
    try { dr = await SL.digCell(bot, t.pos, { allowGuard: true }) } finally { bot.setControlState('sneak', false) }
    if (dr !== 'ok') { st.skip.set(t.k, gameClock.now() + 60000); log('штрек: золото не ломается', { at: t.k, r: dr }); continue }
    S.own.add(t.k)
    st.pred.delete(t.k)
    st.blocks++
    st.lastBreak = gameClock.now()
    // Гипотеза подтверждена (3 золота на местах шаблона) — соседние гипотезы
    // других рангов (та же стена со сдвигом на блок) снять.
    const rk = hit.rank ?? 0
    st.rankHit = st.rankHit || {}
    st.rankHit[rk] = (st.rankHit[rk] || 0) + 1
    if (st.rankHit[rk] >= 3) {
      const mine = [...(st.predAll || [])].filter(q => q.rank === rk)
      for (const [k, v] of [...st.pred.entries()]) if (v.rank !== rk && mine.some(q => q.pos.distanceTo(v.pos) <= 2.5)) st.pred.delete(k)
    }
    if (st.fastSafe) {
      const Pack = require('.././pack')
      const safePickup = () => {
        if (ctl.aborted || session.bot !== bot || !bot.entity || (bot.health ?? 0) <= 0 ||
          bot.game?.dimension !== dimension || bot._ndGuard?.ended || session.reflex) return false
        const body = SL.bodyCells(bot)
        if (body.some(cell => SL.classOf(bot.blockAt(cell)) !== SL.AIR) ||
          !fullCover(bot.blockAt(body[0].offset(0, -1, 0)))) return false
        return !require('.././ne-guard').hot(bot, { near: 6 }) && !foesNear(bot, 6).length
      }
      const match = (_entity, stack) => stack?.name === 'gold_block'
      const candidates = Drops.lying(bot, { from: t.pos, radius: 3, match })
      const receipt = { at: t.k, picked: 0, received: 0, gained: 0, why: '' }
      if (!safePickup()) receipt.why = 'подбор отложен: угроза или текущая клетка без подтверждённого воздуха и опоры'
      else if (!candidates.some(it => Drops.inPickup(bot.entity.position, it.rest))) receipt.why = 'подбор: нет подтверждённой стопки в рамке тела'
      else {
        receipt.picked = await Drops.collect(bot, ctl, { from: t.pos, radius: 3, match, appearMs: 0,
          timeoutMs: 1500, allowMovement: false, canContinue: safePickup,
          onStack: async it => Pack.fits(bot, 'gold_block', 1) && Drops.inPickup(bot.entity.position, it.rest) ? 'go' : 'skip' })
        receipt.received = Drops.pickupDelta(bot, pickupMark)?.gold_block || 0
        receipt.gained = Math.max(0, countOf(bot, 'gold_block') - had)
        if (!receipt.received || !receipt.gained) receipt.why = 'подбор золота сервером не подтверждён'
      }
      ;(S.goldPickups || (S.goldPickups = [])).push(receipt)
      if (S.goldPickups.length > 6) S.goldPickups.shift()
      if (receipt.why) S.fails.push(receipt.why)
      log('штрек: подбор золота', receipt)
      if (ctl.aborted || session.bot !== bot || !bot.entity || (bot.health ?? 0) <= 0 ||
        bot.game?.dimension !== dimension || bot._ndGuard?.ended || session.reflex) break
    }
    if (st.fastSafe && opens) {
      const closed = await SL.fillCell(bot, t.pos)
      if (!closed || !fullCover(bot.blockAt(t.pos))) {
        await hunker(session, ctl, st, 'золото: заплатка не встала')
        S.fails.push('золото: заплатка не встала'); break
      }
      S.own.delete(t.k); S.fills++; (S.filled || (S.filled = new Set())).add(t.k)
      S.exposed = SL.exposure(bot, S.own).length > 0
    }
    if (!st.fastSafe) {
      for (let i = 0; i < 15 && countOf(bot, 'gold_block') <= had; i++) await sleep(100)
      if (countOf(bot, 'gold_block') <= had) await pickUp(bot, ctl, 3, 2500)
    }
    // Золото касалось чужого воздуха — закрыть его клетку.
    if (SL.exposure(bot, S.own).length) {
      if (await SL.fillCell(bot, t.pos)) { S.own.delete(t.k); S.fills++; (S.filled || (S.filled = new Set())).add(t.k) }
      S.exposed = SL.exposure(bot, S.own).length > 0
    }
    log('штрек: золото', { at: t.k, blocks: countOf(bot, 'gold_block'), left: st.pred.size, hp: Math.round(bot.health ?? 0), exposed: S.exposed })
  }
  st.blocks += S.goldPassed + S.bonusBlocks
  S.goldPassed = 0
  S.bonusBlocks = 0
  return S
}

async function digTrap (session, ctl, st, until) {
  const bot = session.bot
  const SL = require('.././sealed')
  const S = st.sealedState
  if (!S) return null
  S.deadline = until
  S.noBonus = true
  for (let tries = 0; tries < 3 && !ctl.aborted && gameClock.now() < until - 20000; tries++) {
    const view = SL.worldView(bot)
    const cands = trapCandidates(bot, view, S.own).slice(0, 16)
    if (!cands.length) { log('ловушка: места нет', { pigs: mobs(bot, 'piglin', 40).length }); return null }
    const me = bot.entity.position.floored()
    // Цель пути — ноги в H (голова в клетке рта M): отсюда видно камеру и можно бросить приманку.
    const goalMap = new Map(cands.map(b => [SL.key(b.H.x, b.H.y, b.H.z), b]))
    const xs = [me.x, ...cands.map(b => b.H.x)]; const ys = [me.y, ...cands.map(b => b.H.y)]; const zs = [me.z, ...cands.map(b => b.H.z)]
    const box = { x0: Math.min(...xs) - 10, x1: Math.max(...xs) + 10, y0: Math.max(5, Math.min(...ys) - 8), y1: Math.min(120, Math.max(...ys) + 8), z0: Math.min(...zs) - 10, z1: Math.max(...zs) + 10 }
    const hs = cands.map(b => b.H)
    const r = await SL.plan({
      cls: view.cls, dig: view.dig, own: S.own, box, maxNodes: 80000, vup: SL.fillerCount(bot) >= 6,
      starts: [{ x: me.x, y: me.y, z: me.z, g: 0 }],
      goal: (x, y, z) => goalMap.has(SL.key(x, y, z)),
      h: (x, y, z) => Math.min(...hs.map(t => Math.abs(x - t.x) + Math.abs(y - t.y) + Math.abs(z - t.z)))
    })
    if (!r.ok) { log('ловушка: пути нет', { cands: cands.length, nodes: r.nodes, why: r.why }); return null }
    const last = r.path.length ? r.path[r.path.length - 1].to : me
    const bo: any = goalMap.get(SL.key(last.x, last.y, last.z))
    log('ловушка: план', { feet: bo.P, mouth: bo.M, room: bo.C0, room2: bo.C2, dump: !!bo.dump, pigs: bo.pigs, brutes: bo.brutes, moves: r.path.length })
    st.doing = 'ловушка: путь'
    const ex = await SL.execute(session, ctl, r.path, S)
    if (!ex.ok) { S.fails.push('ловушка: ' + ex.why); continue }
    const built = await buildTrap(session, ctl, st, bo, S)
    if (!built) continue
    return built
  }
  return null
}

async function buildTrap (session, ctl, st, bo, S) {
  const bot = session.bot
  const SL = require('.././sealed')
  const step = what => {
    const f = bot.entity.position
    const nm = v => { const b = bot.blockAt(v); return b ? b.name : '?' }
    log('ловушка: шаг', { what, hp: Math.round(bot.health ?? 0), at: [+f.x.toFixed(2), +f.y.toFixed(2), +f.z.toFixed(2)], under: nm(f.offset(0, -0.5, 0)) })
  }
  step('дошёл')
  if (!(await centerIn(bot, bo.H))) { S.fails.push('ловушка: не встал в центр'); step('не в центре'); return null }
  st.doing = 'ловушка: жду злость'
  for (let w = 0; w < 40 && gameClock.now() - lastGoldBreak(st) < 33000 && !ctl.aborted; w++) await sleep(1000)
  // Камера, пока всё закрыто (над ней ещё пол пиглинов): низ C0, дальняя C2.
  st.doing = 'ловушка: камера'
  let bad = null
  const dig = async q => { const dr = await SL.digCell(bot, new Vec3(q.x, q.y, q.z)); if (dr !== 'ok' && dr !== 'air') bad = q.x + ',' + q.y + ',' + q.z + ': ' + dr; return !bad }
  if (!(await dig(bo.C0))) { S.fails.push('ловушка: ' + bad); return null }
  if (bo.C2 && !(await dig(bo.C2))) { bo.C2 = null; bad = null }
  // Вскрыть: сперва дальнюю (C2 над ней), приманку туда, потом ближнюю (C1) — и сразу вниз: пиглин
  // в C0 рядом с нашей головой, пока мы стоим в H, достал бы ударом.
  st.doing = 'ловушка: вскрыть'
  if (bo.C2 && !(await dig({ x: bo.C2.x, y: bo.C2.y + 1, z: bo.C2.z }))) { bo.C2 = null; bad = null }
  const aim = bo.C2 && countOf(bot, 'gold_ingot') > 0 ? baitAim(bot, bo) : null
  if (aim) {
    try { await bot.lookAt(aim, true); await sleep(80); await bot.toss(bot.registry.itemsByName.gold_ingot.id, null, 1); bo.baited = 1 } catch {}
  }
  if (!(await dig(bo.C1))) { S.fails.push('ловушка: ' + bad); return null }
  // Вниз: копаем P под ногами и падаем в него — теперь на 2 ниже пола камеры.
  st.doing = 'ловушка: вниз'
  if (!(await dig(bo.P))) { S.fails.push('ловушка: ' + bad); return null }
  S.own.add(SL.key(bo.P.x, bo.P.y, bo.P.z))
  for (let i = 0; i < 20 && bot.entity.position.y > bo.P.y + 0.1; i++) await sleep(50)
  step('внизу')
  if (bo.dump) {
    st.doing = 'ловушка: свалка'
    let ok = true
    for (const q of [bo.dump.Dh, bo.dump.D1, bo.dump.D2]) {
      const dr = await SL.digCell(bot, new Vec3(q.x, q.y, q.z))
      if (dr === 'ok' || dr === 'air') S.own.add(SL.key(q.x, q.y, q.z)); else { ok = false; break }
    }
    if (!ok) bo.dump = null
    await centerIn(bot, bo.P)
    step('свалка')
  }
  st.doing = 'ловушка: замкнуть'
  bo.sealed = await sealBody(bot, S, bo.dump ? [bo.dump.Dh, bo.dump.D1, bo.dump.D2] : [], [bo.M])
  await centerIn(bot, bo.P)
  step('замкнул ' + JSON.stringify(bo.sealed))
  if (bo.sealed.risky && bo.sealed.risky.length) { S.fails.push('ловушка: угол открыт наружу'); return null }
  st.doing = 'ловушка: торг'
  S.exposed = true
  bo.at = xyz(bot.entity.position.floored())
  return bo
}

async function sealBody (bot, S, keep: any = [], open: any = [], mouth = null, canContinue = () => true) {
  const SL = require('.././sealed')
  const f = bot.entity.position.floored()
  const body = [f, f.offset(0, 1, 0)]
  const K = q => SL.key(q.x, q.y, q.z)
  const inside = new Set([...body, ...keep, ...open].map(K))
  const want = new Map()
  const add = (q, pri) => {
    const k = K(q)
    if (inside.has(k) || want.has(k)) return
    const b = bot.blockAt(q)
    if (!b || b.boundingBox !== 'empty' || /lava|water/.test(b.name)) return
    want.set(k, { q, pri })
  }
  for (const c of body) for (let dx = -1; dx <= 1; dx++) for (let dz = -1; dz <= 1; dz++) if (dx || dz) add(c.offset(dx, 0, dz), dx && dz ? 2 : 1)
  for (const c of keep) for (const [dx, dy, dz] of SL.FACES) add(new Vec3(c.x + dx, c.y + dy, c.z + dz), 0)
  // Бока и зад рта (клетка над головой): наш штрек рядом со ртом давал бруту луч сквозь угол
  // (pit-v4-3 30.09: брут в угловой клетке на уровне головы, rel [0.94, 1, −1], два удара, хп 20→5).
  if (mouth) for (const [dx, dz] of [[mouth.d[1], mouth.d[0]], [-mouth.d[1], -mouth.d[0]], [-mouth.d[0], -mouth.d[1]]]) add(new Vec3(mouth.M.x + dx, mouth.M.y, mouth.M.z + dz), 1)
  let n = 0
  const left = []
  for (const { q } of [...want.values()].sort((a, b) => b.pri - a.pri)) {
    if (!canContinue()) { left.push(K(q)); break }
    if (await SL.fillCell(bot, q)) {
      S.own.delete(K(q)); n++
      if (FAST_SAFE) (S.filled || (S.filled = new Set())).add(K(q))
    } else left.push(K(q))
  }
  // Незаложенное — опасно, только если оттуда воздухом можно выйти наружу (туда придёт брут).
  const skip = new Set([...body, ...keep, ...open].map(K))
  if (mouth) skip.add(K(mouth.M))
  const risky = left.filter(k => pocketOpen(bot, k, skip))
  return { n, left, risky, breaches: SL.exposure(bot, S.own).length }
}

async function prepareBarterCover (session, ctl, st, until) {
  const bot = session.bot
  const SL = require('.././sealed')
  const CM = require('./cover-memory')
  let feet = bot.entity.position.floored()
  const air = at => SL.classOf(bot.blockAt(new Vec3(at.x, at.y, at.z))) === SL.AIR
  const firm = at => {
    const block = bot.blockAt(new Vec3(at.x, at.y, at.z))
    return fullCover(block) && ![SL.HOT, SL.FLUID, SL.FALL].includes(SL.classOf(block))
  }
  const reject = (why: string, n?: number) => {
    const position = bot.entity.position
    const diagnostic = { position: { x: position.x, y: position.y, z: position.z }, onGround: bot.entity.onGround }
    try {
      const { bodyObservation } = require('.././navigation/parkour') as typeof import('../navigation/parkour')
      const observation = bodyObservation(bot, position)
      const body = position.floored()
      return { ok: false as const, why, n, diagnostic: { ...diagnostic, ...observation, cells: observation.cells.slice(0, 24),
        breaches: SL.exposure(bot, new Set([SL.keyV(body), SL.keyV(body.offset(0, 1, 0))])).slice(0, 24) } }
    } catch (error) {
      return { ok: false as const, why, n, diagnostic: { ...diagnostic, error: String(error?.message || error).slice(0, 300) } }
    }
  }
  const active = () => !ctl.aborted && session.bot === bot && gameClock.now() < until && (bot.health ?? 0) > 0
  // Ответ стража (столб, коробка) или прыжок ещё идёт — дождаться опоры, а не отказывать сразу (Full44 06.10: четыре
  // отказа подряд за 0 с на y 51.4→52.2→53.2, 58 слитков так и не отданы).
  if (!bot.entity.onGround && active()) {
    if (ctl.waitReflex) await ctl.waitReflex()
    if (process.env.ND_GUARD !== '0') await require('.././ne-guard').waitIdle(bot).catch(() => null)
    for (let i = 0; i < 40 && active() && !bot.entity.onGround; i++) await sleep(100)
    feet = bot.entity.position.floored()
  }
  if (worlds.worldOf(bot) !== 'the_nether' || !active() || !bot.entity.onGround || !air(feet) || !air(feet.offset(0, 1, 0))) {
    return reject('тело не на сухом подтверждённом полу')
  }
  if (!firm(feet.offset(0, -1, 0))) {
    const known = new Set([...st.sealedState?.own || [], ...require('.././tunnel').ownSet(session)])
    const candidates = SIDES4.map(([dx, dz]) => feet.offset(dx, 0, dz)).filter(at =>
      known.has(SL.keyV(at)) && known.has(SL.keyV(at.offset(0, 1, 0))) &&
      air(at) && air(at.offset(0, 1, 0)) && firm(at.offset(0, -1, 0)))
    for (const destination of candidates) {
      if (!active() || !bot.entity.onGround || !bot.entity.position.floored().equals(feet)) break
      if (ctl.waitReflex) await ctl.waitReflex()
      if (!active() || !air(destination) || !air(destination.offset(0, 1, 0)) || !firm(destination.offset(0, -1, 0))) break
      const moved = await require('.././navigation/parkour').executeJump(bot, ctl, destination.offset(.5, 0, .5), { allowWalk: true })
      if (moved.ok && active() && bot.entity.onGround && bot.entity.position.floored().equals(destination)) {
        feet = destination
        log('бартер: ушёл с рыхлого пола', { at: xyz(feet) })
        break
      }
    }
  }
  const head = feet.offset(0, 1, 0)
  const roof = feet.offset(0, 2, 0)
  const current = () => !ctl.aborted && gameClock.now() < until && (bot.health ?? 0) > 0 &&
    session.bot === bot && bot.entity.onGround && bot.entity.position.floored().equals(feet) && air(feet) && air(head) && firm(feet.offset(0, -1, 0))
  if (worlds.worldOf(bot) !== 'the_nether' || !current()) return reject('тело не на сухом подтверждённом полу')
  try { bot.pathfinder.setGoal(null) } catch {}
  bot.clearControlStates()
  const own = new Set([SL.keyV(feet), SL.keyV(head)])
  const S = { own, filled: new Set(), exposed: true, entry: xyz(feet), dug: 0, moves: 0,
    fills: 0, ores: 0, bonusBlocks: 0, goldPassed: 0, plans: 0, fails: [], planMs: 0, walks: 0 }
  const protectedNow = () => current() && CM.protectedGeometry(bot.entity.position, own, SL.exposure(bot, own), air, firm)
  let n = 0
  if (!protectedNow()) {
    if (SL.fillerCount(bot) < 1) return reject('нечем восстановить стены укрытия')
    st.doing = 'бартер: восстановить укрытие'
    const closed = await sealBody(bot, S, [], [], null, current)
    n += closed.n
    if (!current()) return reject('восстановление укрытия прервано', n)
    if (air(roof)) {
      if (await SL.fillCell(bot, roof)) { S.filled.add(SL.keyV(roof)); own.delete(SL.keyV(roof)); n++ }
    }
    if (!protectedNow()) return reject('стены или потолок физически не замкнуты', n)
  }
  S.exposed = false
  const historical = new Set([...st.sealedState?.own || [], ...require('.././tunnel').ownSet(session)])
  for (const cell of historical) {
    const [x, y, z] = String(cell).split(',').map(Number)
    if ([x, y, z].every(Number.isInteger) && Math.abs(x - feet.x) + Math.abs(y - feet.y) + Math.abs(z - feet.z) < 96 && air({ x, y, z })) own.add(cell)
  }
  st.sealedState = S
  st.sealedDone = true
  st.towered = Math.max(st.towered || 0, 3)
  require('.././tunnel').rememberOwn(session, own)
  log('бартер: укрытие подтверждено', { at: xyz(feet), placed: n, own: own.size })
  return { ok: true as const, n }
}

async function digPit (session, ctl, st, until) {
  const bot = session.bot
  const SL = require('.././sealed')
  const S = st.sealedState
  if (!S) return null
  S.deadline = until
  S.noBonus = true
  const readyPen = require('./pen-trap').penHere(bot)
  if (readyPen) {
    S.exposed = SL.exposure(bot, S.own).length > 0
    return { ...readyPen, kind: 'pit', F: readyPen.Bf, W: readyPen.H, O: readyPen.lanes.find(l => l.k === 0).T }
  }
  const readyPit = require('./booth-trade').currentPit(bot, S)
  if (readyPit) {
    S.exposed = true
    log('яма: использую готовую', { feet: readyPit.P, mouth: readyPit.M, pigs: readyPit.pigs })
    return readyPit
  }
  // S1d 07.10: злость от последнего золота (600 тиков) — переждать в своём штреке, потом к яме (s1d-G22-6: золото «окном», сразу
  // «яма: путь» 20 ходов — злые пиглины, 5 ударов, смерть на 24-й мин). Ломок «окном» стало много — ожидание по умолчанию.
  // S1f (проверка S1e (е)): ждать — цена: пиглинов, которых злит ломка (angerSet: в 16 бл.), нет — ждать нечего; есть — остаток
  // злости против риска (pitAngerWait). ND_PIT_ANGER_PRICE=0 — прежнее «всегда ждать».
  const leftAnger = lastGoldBreak(st) + 33000 - gameClock.now()
  let angerWait = leftAnger > 0 && inOwnTunnel(bot, S)
  if (angerWait && process.env.ND_PIT_ANGER_PRICE !== '0') {
    const w = pitAngerWait({ angry: angerSet(bot, null, false).length, hp: bot.health ?? 20, leftS: leftAnger / 1000, gear: require('.././assess').gearOf((bot.inventory.slots || []).slice(5, 9)) })
    if (!w.wait) log('яма: злость от золота — не жду', { why: w.why })
    angerWait = w.wait
  }
  if (angerWait) {
    log('яма: злость от золота — жду в штреке', { s: Math.round((lastGoldBreak(st) + 33000 - gameClock.now()) / 1000) })
    const why = await waitWatched(session, ctl, Math.min(33000, lastGoldBreak(st) + 33000 - gameClock.now()))
    if (why || ctl.aborted) return null
  }
  // Снаружи (второй вызов кампании: тело вышло штреком к входу) — сперва ко входу своего штрека:
  { const me0 = bot.entity.position.floored()
    if (!S.own.has(SL.keyV(me0)) && S.entry && Math.hypot(S.entry.x - me0.x, S.entry.z - me0.z) + Math.abs(S.entry.y - me0.y) > 1) {
      const w = await walkUnlessBrute(session, ctl, new goals.GoalBlock(S.entry.x, S.entry.y, S.entry.z), 30000, { dig: false })
      log('яма: ко входу штрека', { entry: S.entry, ok: !!(w && w.ok), at: xyz(bot.entity.position.floored()) })
      S.exposed = true
    } }
  for (let tries = 0; tries < 3 && !ctl.aborted && gameClock.now() < until - 20000; tries++) {
    const view = SL.worldView(bot)
    // Яма — не у дома брута из копии (S1d s1d-AB-4 B: план ямы в 39 ходах к 92,59,−87, в 7 бл. от брута 85,58,−88 — два удара на пути, смерть).
    const BH = require('.././nether-route').bruteSpots(session)
    const cands = pitsAwayFromBrutes(pitCandidates(bot, view, S.own, BF.enabled() ? 64 : 40).filter(b => !(S.badPits && S.badPits.has(SL.key(b.M.x, b.M.y, b.M.z)))), BH).slice(0, 16)
    if (!cands.length) { log('яма: места у пиглинов нет', { pigs: mobs(bot, 'piglin', 40).length }); return null }
    const me = bot.entity.position.floored()
    const goalMap = new Map(cands.map(b => [SL.key(b.P.x, b.P.y, b.P.z), b]))
    const xs = [me.x, ...cands.map(b => b.P.x)]; const ys = [me.y, ...cands.map(b => b.P.y)]; const zs = [me.z, ...cands.map(b => b.P.z)]
    const box = { x0: Math.min(...xs) - 10, x1: Math.max(...xs) + 10, y0: Math.max(5, Math.min(...ys) - 8), y1: Math.min(120, Math.max(...ys) + 8), z0: Math.min(...zs) - 10, z1: Math.max(...zs) + 10 }
    const hs = cands.map(b => b.P)
    const pitPlan = extra => SL.plan({
      cls: view.cls, dig: view.dig, own: S.own, box, maxNodes: 80000, vup: SL.fillerCount(bot) >= 6, breachOk: tradeBreach(S),
      starts: [{ x: me.x, y: me.y, z: me.z, g: 0 }],
      goal: (x, y, z) => goalMap.has(SL.key(x, y, z)),
      h: (x, y, z) => Math.min(...hs.map(t => Math.abs(x - t.x) + Math.abs(y - t.y) + Math.abs(z - t.z))),
      ...extra
    })
    let r = await pitPlan({})
    // Тело в «чужом» кармане (ни одного хода со старта: кругом воздух не из своих) — пройти и вскрыть можно
    // только этот карман (localAir), дальше — как всегда (main 30.09: 9 золотых блоков, «яма: пути нет» ×6).
    let local = null
    if (!r.ok && r.nodes <= 1) {
      local = SL.localAir(bot)
      if (local) {
        r = await pitPlan({ openOk: local, breachOk: tradeBreach(S, (ck, nk) => local.has(nk)) })
        log('яма: старт из чужого кармана', { cells: local.size, ok: r.ok, nodes: r.nodes })
        if (!r.ok) local = null
      }
    }
    // Тело на открытой выработке (золото моста/двора: свои клетки, но кругом чужой воздух) — ни хода отсюда, и карман
    if (!r.ok && r.nodes <= 1 && S.own.size > 2) {
      const seen = new Set([SL.keyV(me)])
      const q = [{ v: me, d: 0 }]
      const starts = []
      for (let i = 0; i < q.length && q.length < 800; i++) {
        const { v, d } = q[i]
        for (const [dx, dy, dz] of SL.FACES) {
          const n = v.offset(dx, dy, dz)
          const nk = SL.keyV(n)
          if (seen.has(nk) || !S.own.has(nk)) continue
          const b = bot.blockAt(n)
          if (!b || b.boundingBox !== 'empty' || /lava|fire/.test(b.name)) continue
          seen.add(nk)
          q.push({ v: n, d: d + 1 })
          const fl = bot.blockAt(n.offset(0, -1, 0))
          if (fl && fl.boundingBox === 'block') starts.push({ x: n.x, y: n.y, z: n.z, g: (d + 1) * 2 })
        }
      }
      if (starts.length) {
        const r2 = await pitPlan({ starts })
        log('яма: старт из своего штрека', { own: S.own.size, starts: starts.length, ok: r2.ok, nodes: r2.nodes, start: r2.start })
        if (r2.ok && r2.start && !(r2.start.x === me.x && r2.start.y === me.y && r2.start.z === me.z)) {
          const w = await walkUnlessBrute(session, ctl, new goals.GoalBlock(r2.start.x, r2.start.y, r2.start.z), 30000, { dig: false })
          const f = bot.entity.position.floored()
          if (f.x === r2.start.x && f.y === r2.start.y && f.z === r2.start.z) r = r2
          else log('яма: к старту не дошёл', { start: r2.start, at: xyz(f), error: w && w.error })
        } else if (r2.ok) r = r2
      }
    }
    if (!r.ok) { log('яма: пути нет', { cands: cands.length, nodes: r.nodes, why: r.why }); return null }
    const last = r.path.length ? r.path[r.path.length - 1].to : me
    const bo: any = goalMap.get(SL.key(last.x, last.y, last.z))
    log('яма: план', { feet: bo.P, mouth: bo.M, dump: !!bo.dump, catch: bo.catch, pigs: bo.pigs, brutes: bo.brutes, moves: r.path.length })
    st.doing = 'яма: путь'
    S.exposed = SL.exposure(bot, S.own).length > 0
    const ex = await tradeExecute(session, ctl, r.path, S, local)
    if (!ex.ok) {
      S.fails.push('яма: ' + ex.why)
      const position = bot.entity.position
      log('яма: путь не завершён', { why: ex.why, done: ex.done, of: r.path.length, target: bo.P,
        at: { x: position.x, y: position.y, z: position.z }, onGround: bot.entity.onGround })
      continue
    }
    const step = what => {
      const f = bot.entity.position
      const nm = v => { const b = bot.blockAt(v); return b ? b.name : '?' }
      log('яма: шаг', { what, hp: Math.round(bot.health ?? 0), at: [+f.x.toFixed(2), +f.y.toFixed(2), +f.z.toFixed(2)], under: nm(f.offset(0, -0.5, 0)), inP: Math.floor(f.x) === bo.P.x && Math.floor(f.y) === bo.P.y && Math.floor(f.z) === bo.P.z })
    }
    step('дошёл')
    if (bo.dump) {
      st.doing = 'яма: свалка'
      let ok = true
      for (const c of [bo.dump.Dh, bo.dump.D1, bo.dump.D2]) {
        const dr = await SL.digCell(bot, new Vec3(c.x, c.y, c.z))
        if (dr === 'ok' || dr === 'air') S.own.add(SL.key(c.x, c.y, c.z)); else { ok = false; break }
      }
      if (!ok) bo.dump = null
      step('свалка')
    }
    // Тело — в центр своей клетки: рядом открыт столб свалки, и с края в него съехать.
    if (!(await centerIn(bot, bo.P))) { S.fails.push('яма: не встал в центр'); step('не в центре'); continue }
    st.doing = 'яма: замкнуть'
    bo.sealed = await sealBody(bot, S, bo.dump ? [bo.dump.Dh, bo.dump.D1, bo.dump.D2] : [], [], bo)
    await centerIn(bot, bo.P)
    step('замкнул ' + JSON.stringify(bo.sealed))
    if (bo.sealed.risky.length) { (S.badPits || (S.badPits = new Set())).add(SL.key(bo.M.x, bo.M.y, bo.M.z)); S.fails.push('яма: угол открыт наружу'); continue }
    if (gameClock.now() >= until || ctl.aborted) return null
    // Рот вскрывать, когда злость от золота остыла (600 тиков): злой арбалетчик стреляет в рот.
    st.doing = 'яма: жду злость'
    for (let w = 0; w < 40 && gameClock.now() - lastGoldBreak(st) < 33000 && !ctl.aborted; w++) await sleep(1000)
    st.doing = 'яма: рот'
    const mr = await SL.digCell(bot, new Vec3(bo.M.x, bo.M.y, bo.M.z))
    if (mr !== 'ok' && mr !== 'air') { S.fails.push('яма: рот ' + mr); continue }
    step('рот')
    st.doing = 'яма: торг'
    S.exposed = true
    bo.at = xyz(bot.entity.position.floored())
    return bo
  }
  return null
}

async function moveBarterSite (session, ctl, st, p, until) {
  const NR = require('.././nether-route'); const SL = require('.././sealed'); const bot = session.bot
  if (!NR.enabled() || !NR.gridOf(session) || !st.sealedState || ctl.aborted || gameClock.now() > until - 20000 || (st.flowMoves || 0) >= 3) return false
  if ((bot.health ?? 20) < 16 || SL.fillerCount(bot) < 16) return false
  // Cool down behind cover, never at the open courtyard. The subsequent route is guarded and bounded.
  if (gameClock.now() - lastGoldBreak(st) < 33000) {
    if (!inOwnTunnel(bot, st.sealedState)) return false
    const why = await waitWatched(session, ctl, Math.min(33000, lastGoldBreak(st) + 33000 - gameClock.now()))
    if (why || ctl.aborted) return false
  }
  const view = SL.worldView(bot); const me = bot.entity.position
  const seen = st.flowVisited || (st.flowVisited = new Set())
  const pits = pitsAwayFromBrutes(pitCandidates(bot, view, st.sealedState.own, 64), require('.././nether-route').bruteSpots(session))
    .filter(b => !b.brutes && !(st.sealedState.badPits && st.sealedState.badPits.has(SL.key(b.M.x, b.M.y, b.M.z))))
  const targets = pits.map(b => ({ ...b.P, r: 0, dy: 0, source: 'яма', pigs: b.pigs }))
  // Only the current bastion's known chest floors; no blind random walk and no outside-grid fallback.
  if (!targets.length) for (const [x, y, z] of p.knownChests || []) targets.push({ x, y, z, r: 4, dy: 1, source: 'этаж по карте' })
  for (const target of targets) {
    const key = `${target.x},${target.y},${target.z}`
    if (seen.has(key) || Math.hypot(target.x - me.x, target.z - me.z) < 6 && Math.abs(target.y - me.y) < 3) continue
    seen.add(key); st.flowMoves = (st.flowMoves || 0) + 1
    const sec = Math.min(60, Math.floor((until - gameClock.now()) / 1000))
    if (sec < 20) return false
    const rr = await NR.routeTo(session, ctl, { ...target, timeoutSeconds: sec, ironOk: false, zoneExpo: 14,
      abortNear: { re: '^(piglin_brute|hoglin)$', r: 10 } }).catch(e => ({ ok: false, why: e.message }))
    for (const k of rr.own || []) st.sealedState.own.add(k)
    log('бартер: смена места', { target, ok: rr.ok, why: rr.why, seconds: rr.s, moves: st.flowMoves })
    if (rr.ok) return true
    // A failed route can leave the body exposed; close up before giving the hands back.
    await burrow(session, ctl, st, 'бартер: смена места не вышла').catch(() => null)
    return false
  }
  return false
}

async function bastion (session, ctl, p: any = {}) {
  const bot = session.bot
  try { require('.././ne-guard').swatInstall(bot) } catch {}
  try { require('.././ne-guard').attach(session) } catch {}
  FAST_SAFE = p.fastSafe === true || process.env.ND_GOLD_FAST_SAFE === '1'
  const t0 = gameClock.now()
  const deadline = t0 + clamp(p.timeoutSeconds ?? 400, 30, 1800) * 1000 - 5000
  const mode = p.mode || 'auto'
  const wantPearls = p.pearls ?? 12
  const wantFire = p.fireRes ?? 3
  // Обсидиан на раму выхода у крепости Края (кампания ND_SH_NETHER: 10 на раму) — тоже цель бартера (вес 40/469, по 1).
  const wantObs = p.obsidian ?? 0
  // Слитки про запас не держим: без золотой брони на теле bastion не идёт (wearGold ниже), а
  // 8 оставленных — это 8 сделок, ~0.5 жемчуга (ревью Codex 29.09: 153 → 145 обменов).
  const keep = p.keep ?? 0
  const st: any = {
    gold: new Map(), chestSeen: new Map(), skip: new Map(), looted: new Set(),
    blocks: 0, bribed: 0, traded: 0, chests: [], fights: [], barters: [], gained: {}, tossed: [], brutes: 0,
    visited: new Set(), lastBlocked: null, bruteSeen: new Map(), bricks: new Map(), been: [],
    pred: new Map(), towered: 0, predWrong: 0, predMiss: 0,
    // outside — подход к стене снаружи (внешние грани шаблона): на ферме пока
    // не лучше подхода через двор, поэтому по параметру (route-10/11 против 6).
    outside: !!p.outside || !!p.high,
    high: !!p.high,
    // sealed — золото закрытым штреком (sealedGold), без обхода двора.
    sealed: p.sealed !== false,
    fastSafe: FAST_SAFE,
    // breach — второй план закрытого штрека со вскрытием у входа и у целей (ND_SEALED_BREACH=1 у кампании; 02.10, мерка идёт)
    breach: !!p.breach || process.env.ND_SEALED_BREACH === '1',
    lootChests: p.chests !== false,
    hitBrutes: !!p.hitBrutes
  }
  const out = (stopped = null) => {
    const d: any = {
      mode,
      seconds: Math.round((gameClock.now() - t0) / 1000),
      goldBlocksDug: st.blocks,
      bribed: st.bribed,
      ingotsTraded: st.traded,
      chests: st.chests,
      gained: st.gained,
      bag: { gold_ingot: countOf(bot, 'gold_ingot'), gold_block: countOf(bot, 'gold_block'), ender_pearl: countOf(bot, 'ender_pearl'), fire_res: fireRes(bot), obsidian: countOf(bot, 'obsidian'), string: countOf(bot, 'string'), fire_charge: countOf(bot, 'fire_charge') },
      goldSeenLeft: [...st.gold.keys()].length,
      predLeft: st.pred.size,
      ...(st.fastSafe ? { knownGoldLeft: (p.knownGold || []).filter(a => {
        const b = bot.blockAt(new Vec3(...a)); return !b || b.name === 'gold_block'
      }).length } : {}),
      predWrong: st.predWrong || undefined,
      predMiss: st.predMiss || undefined,
      towered: st.towered || undefined,
      sealed: st.sealedState ? { dug: st.sealedState.dug, moves: st.sealedState.moves, fills: st.sealedState.fills, ores: st.sealedState.ores, plans: st.sealedState.plans, planMs: st.sealedState.planMs, walks: st.sealedState.walks, exposed: st.sealedState.exposed, fails: st.sealedState.fails.slice(-6), goldPickups: st.sealedState.goldPickups } : undefined,
      goldNuggets: countOf(bot, 'gold_nugget') || undefined,
      pit: st.pit || undefined,
      pitTrade: st.pitTrade || undefined,
      barterRetry: BF.enabled() && st.barterRetry ? st.barterRetry : undefined,
      barterPlans: st.plans && st.plans.length ? st.plans.slice(-6) : undefined,
      hurts: st.hurts && st.hurts.length ? st.hurts : undefined,
      exit: st.exit || undefined,
      fights: st.fights.length ? st.fights : undefined,
      brutesAvoided: st.brutes || undefined,
      tossed: st.tossed.length ? st.tossed : undefined,
      lastBlocked: st.lastBlocked || undefined,
      goldless: st.goldless || undefined
    }
    if (st.supplyNeeded) d.supplyNeeded = st.supplyNeeded
    if (stopped) d.stopped = stopped
    d.note = `Золотых блоков ${st.blocks}, сундуков ${st.chests.filter(c => !c.error && !c.stopped).length}, слитков пиглинам ${st.traded}. ` +
      `В рюкзаке: жемчуг ${d.bag.ender_pearl}, огнестойкость ${d.bag.fire_res}, слитков ${d.bag.gold_ingot} (+${d.bag.gold_block} блоков), обсидиан ${d.bag.obsidian}, нить ${d.bag.string}.`
    if (st.ironNeed) d.need = { what: 'iron_pickaxe', count: 1, have: 0 }
    return d
  }

  if (worlds.worldOf(bot) !== 'the_nether') return out('бастионы — в Аду; сначала mc_portal mode=enter')
  // scan — только посмотреть: видимые сундуки и узнанные по ним куски (сцены).
  if (mode === 'scan') return { ...out(), scan: await scanPiecesAsync(bot, p.radius || 48, ctl) }
  // goto — отладка подхода pathfinder'ом (noMob — без обхода мобов, floor — пол Ада).
  if (mode === 'goto') {
    const f0 = bot._ndNetherFloor
    bot._ndNoMobAvoid = !!p.noMob
    if (p.floor) bot._ndNetherFloor = p.floor
    const pf = bot.pathfinder
    const th = pf && pf.thinkTimeout
    if (pf) pf.thinkTimeout = p.think || 12000
    const t0g = gameClock.now()
    let w
    try { w = await walkGoal(session, ctl, new goals.GoalNear(p.tx, p.ty, p.tz, p.range ?? 1), (p.seconds || 45) * 1000, { dig: !!p.dig }) } finally { bot._ndNoMobAvoid = false; bot._ndNetherFloor = f0; if (pf) pf.thinkTimeout = th }
    return { ...out(), goto: { ...w, s: Math.round((gameClock.now() - t0g) / 1000), at: xyz(bot.entity.position.floored()) } }
  }
  // booth — отладка окна бартера: тело уже стоит в клетке F, окно — F+d+1 (dx,dz), пиглины за ним (сцены).
  if (mode === 'trap') {
    // Отладка ловушки (сцены): ноги в H, пол пиглинов (их ноги) — на 3 выше наших ног, камера по d.
    const f = bot.entity.position.floored()
    const d = [p.dx || 0, p.dz || 0]
    const px = d[1]; const pz = d[0]
    const M = { x: f.x, y: f.y + 1, z: f.z }
    const C0 = { x: M.x + d[0], y: M.y, z: M.z + d[1] }
    const C2 = { x: C0.x + d[0], y: C0.y, z: C0.z + d[1] }
    const P = { x: f.x, y: f.y - 1, z: f.z }
    const bo = { kind: 'trap', O: C0, C0, C1: { x: C0.x, y: C0.y + 1, z: C0.z }, C2, M, R: { x: M.x, y: M.y + 1, z: M.z }, H: xyz(f), P, d, p: [px, pz], dump: null, F: P, W: M, C: xyz(f), sill: true }
    if (p.dump) bo.dump = { Dh: { x: f.x + px, y: f.y, z: f.z + pz }, D1: { x: P.x + px, y: P.y, z: P.z + pz }, D2: { x: P.x + px, y: P.y - 1, z: P.z + pz } }
    const S = { own: new Set([require('.././sealed').key(f.x, f.y, f.z), require('.././sealed').key(M.x, M.y, M.z)]), fails: [], deadline: gameClock.now() + 600000 }
    const built = await buildTrap(session, ctl, st, bo, S)
    if (!built) return { ...out('ловушка не построилась: ' + S.fails.join('; ')), trap: bo }
    const r = await boothTrade(session, ctl, st, built, gameClock.now() + clamp(p.seconds ?? 60, 10, 600) * 1000, { keep: p.keep ?? 0 })
    return { ...out(), booth: r, trap: { baited: built.baited, C2: !!built.C2 } }
  }
  if (mode === 'pit') {
    // Отладка ямы (сцены): тело уже в яме, рот над головой (P+2), пиглины по d.
    const f = bot.entity.position.floored()
    const d = [p.dx || 0, p.dz || 0]
    const M = { x: f.x, y: f.y + 2, z: f.z }
    const bo = { kind: 'pit', P: xyz(f), H: { x: f.x, y: f.y + 1, z: f.z }, M, R: { x: M.x, y: M.y + 1, z: M.z }, O: { x: M.x + d[0], y: M.y, z: M.z + d[1] }, d, p: [d[1], d[0]], dump: null, F: xyz(f), W: M, C: { x: f.x, y: f.y + 1, z: f.z }, sill: true }
    if (p.dump) bo.dump = { Dh: { x: f.x + d[1], y: f.y + 1, z: f.z + d[0] }, D1: { x: f.x + d[1], y: f.y, z: f.z + d[0] }, D2: { x: f.x + d[1], y: f.y - 1, z: f.z + d[0] } }
    const r = await boothTrade(session, ctl, st, bo, gameClock.now() + clamp(p.seconds ?? 60, 10, 600) * 1000, { keep: p.keep ?? 0 })
    return { ...out(), booth: r }
  }
  if (mode === 'booth') {
    const f = bot.entity.position.floored()
    const d = [p.dx || 0, p.dz || 0]
    const bo = { F: xyz(f), C: { x: f.x + d[0], y: f.y, z: f.z + d[1] }, W: { x: f.x + d[0], y: f.y + 1, z: f.z + d[1] }, O: { x: f.x + 2 * d[0], y: f.y, z: f.z + 2 * d[1] }, d, sill: p.sill === false }
    const r = await boothTrade(session, ctl, st, bo, gameClock.now() + clamp(p.seconds ?? 60, 10, 600) * 1000, { keep: p.keep ?? 0 })
    return { ...out(), booth: r }
  }
  // tunnel — отладка своего штрека к клетке tx,ty,tz (сцены).
  if (mode === 'tunnel') return { ...out(), tunnel: await tunnelTo(session, ctl, new Vec3(p.tx, p.ty, p.tz), { maxSteps: p.maxSteps || 60 }) }
  // Без золотой брони пиглины враждебны сами (PiglinAi.isWearingSafeArmor: хватит одной вещи), но целятся только видя нас
  // (NEAREST_TARGETABLE_PLAYER_NOT_WEARING_GOLD — сенсор с лучом): закрытый штрек их не показывает. Поэтому без брони — не отказ
  // (b0 14.10: бастион в 28 и 55 бл., «в бастион не иду» и 90 мин без добычи), а заход только закрытым штреком до первого золота
  // (сундук, блок): броня из него — armGold, торг — после неё. Бартер с принесённым золотом без брони — прежний отказ.
  if (!(await armGold(session, ctl))) {
    if (mode === 'barter' || !st.sealed) {
      return { ...out('без золотой брони пиглины нападают сами (PiglinAi.isWearingSafeArmor: хватит одной вещи) — золотой шлем: 5 слитков'), need: { what: 'golden_helmet', count: 1, have: 0 } }
    }
    st.goldless = true
    log('бастион без золотой брони — только закрытым штреком до первого золота', { ingots: countOf(bot, 'gold_ingot'), nuggets: countOf(bot, 'gold_nugget') })
  }
  const needPick = mode !== 'barter' && !bot.inventory.items().some(i => GOLD_PICK.test(i.name))
  // Кирка сломалась, а золото в рюкзаке есть (≥ 18 слитков с блоками) — не выходить с ним: торговать
  const goldHave = countOf(bot, 'gold_ingot') + 9 * countOf(bot, 'gold_block')
  // Нет железной кирки и золота мало — сперва сундуки бастиона (закрытым штреком, каменными кирками):
  if (needPick && !(st.sealed && goldHave >= 18) && !(st.sealed && p.chestsFirst !== false)) return { ...out('золотой блок ломается только железной киркой и лучше (needs_iron_tool)'), need: { what: 'iron_pickaxe', count: 1, have: 0 } }
  if (needPick && goldHave >= 18) { st.noPick = true; log('бастион: железной кирки нет — только торг', { gold: goldHave }) } else if (needPick) { st.chestsOnly = true; log('бастион: железной кирки нет — сперва сундуки (железо)', { ironIngots: countOf(bot, 'iron_ingot'), raw: countOf(bot, 'raw_iron'), nuggets: countOf(bot, 'iron_nugget') }) }

  const places = (session.journal.state && session.journal.state.places) || {}
  const rec = p.x !== undefined ? { x: p.x, y: p.y ?? 64, z: p.z } : places[PLACE]
  if (!rec && mode !== 'barter') return out('бастион не знаю: mc_fortress в Аду записывает его («бастион (ад)»), когда видит кирпич чернокамня')
  // Память между вызовами (кампания зовёт bastion несколько раз): узнанные стены,
  const memoKey = rec ? `${Math.round(rec.x)},${Math.round(rec.z)}` : null
  let memo = memoKey && MEMO.get(memoKey)
  if (memo && memo.owner === bot && memo.dimension === worlds.worldOf(bot)) {
    for (const key of memo.looted || []) st.looted.add(key)
  }
  if (!memo && memoKey && st.sealed && mode === 'barter') {
    const SL = require('.././sealed')
    const CM = require('./cover-memory')
    const air = at => SL.classOf(bot.blockAt(new Vec3(at.x, at.y, at.z))) === SL.AIR
    const firm = at => fullCover(bot.blockAt(new Vec3(at.x, at.y, at.z)))
    const geometry = {
      site: memoKey, dimension: worlds.worldOf(bot), now: gameClock.wall.now(), position: bot.entity.position,
      air, firm, closed: own => CM.protectedGeometry(bot.entity.position, own, SL.exposure(bot, own), air, firm)
    }
    const near = bot.entity.position.distanceTo(new Vec3(rec.x, rec.y, rec.z)) < 96
    const restored = near && (CM.restoreCover(session.journal.state?.bastionCovers?.[memoKey], geometry) ||
      CM.recognizeCover(require('.././tunnel').ownSet(session), geometry))
    if (restored) {
      memo = { pred: new Map(), mined: new Set(), looted: new Set(), owner: bot, dimension: worlds.worldOf(bot), own: restored.own, entry: restored.entry,
        filled: new Set(), exposed: false, t: gameClock.now() }
      MEMO.set(memoKey, memo)
      log('защищённый бартер восстановлен', { site: memoKey, own: restored.own.size })
    }
  }
  if (st.sealed && memo && gameClock.now() - memo.t < 3600e3) {
    for (const [k, v] of memo.pred) if (!memo.mined.has(k)) st.pred.set(k, { ...v, pos: new Vec3(v.pos.x, v.pos.y, v.pos.z) })
    st.towered = 2
    st.sealedState = { own: memo.own, filled: memo.filled, exposed: memo.exposed, entry: memo.entry, dug: 0, moves: 0, fills: 0, ores: 0, bonusBlocks: 0, goldPassed: 0, plans: 0, fails: [], planMs: 0, walks: 0 }
    const tradeOwn = mode === 'barter' && memo.own?.size > 0 && memo.entry &&
      bot.entity.position.distanceTo(new Vec3(rec.x, rec.y, rec.z)) < 96
    if (!st.pred.size || tradeOwn) st.sealedDone = true
  }
  if (st.noPick && st.sealed) {
    if (!st.sealedState) st.sealedState = { own: new Set(), exposed: true, dug: 0, moves: 0, fills: 0, ores: 0, bonusBlocks: 0, goldPassed: 0, plans: 0, fails: [], planMs: 0, walks: 0 }
    st.pred.clear()
    st.sealedDone = true
    st.towered = Math.max(st.towered || 0, 3)
  }
  const memoSave = () => {
    if (!memoKey || !st.sealed || !st.sealedState) return
    const old = memo || { pred: new Map(), mined: new Set() }
    for (const [k, v] of st.pred) old.pred.set(k, { rank: v.rank, piece: v.piece, pos: { x: v.pos.x, y: v.pos.y, z: v.pos.z } })
    for (const [k] of old.pred) if (!st.pred.has(k)) { const b = bot.blockAt(new Vec3(...k.split(',').map(Number))); if (b && b.name !== 'gold_block') old.mined.add(k) }
    MEMO.set(memoKey, { pred: old.pred, mined: old.mined, looted: new Set(st.looted), owner: bot, dimension: worlds.worldOf(bot), own: st.sealedState.own, filled: st.sealedState.filled, exposed: st.sealedState.exposed, entry: st.sealedState.entry, t: gameClock.now() })
    const CM = require('./cover-memory')
    const feet = bot.entity.position.floored()
    const current = st.sealedState.own.has(`${feet.x},${feet.y},${feet.z}`) &&
      st.sealedState.own.has(`${feet.x},${feet.y + 1},${feet.z}`) ? feet : st.sealedState.entry
    const record = CM.coverRecord(memoKey, worlds.worldOf(bot), gameClock.wall.now(), st.sealedState.own, current)
    if (record && session.journal.patch) session.journal.patch(state => { state.bastionCovers = CM.storeCover(state.bastionCovers, record) })
  }

  if (mode === 'barter' && st.sealed) {
    let near = rec && bot.entity.position.distanceTo(new Vec3(rec.x, rec.y, rec.z)) < 96
    if (!near && rec && !ctl.aborted) {
      const NR = require('.././nether-route')
      const seconds = Math.min(300, Math.floor((deadline - gameClock.now()) / 1000) - 180)
      if (!NR.enabled() || !NR.gridOf(session) || seconds < 20) {
        return { ...out('к защищённому бартеру сначала нужен безопасный подход'), barterRetry: 'подход недоступен или бюджет исчерпан' }
      }
      const rr = await lavaWatched(bot, ctl, sub => NR.routeTo(session, sub,
        { x: rec.x, y: rec.y, z: rec.z, r: 12, dy: 8, solidFloor: true, timeoutSeconds: seconds, zoneExpo: 14,
          abortNear: { re: '^(piglin_brute|hoglin)$', r: 10 } }))
      st.tunnel = { ok: rr.ok, route: true, steps: rr.steps, dug: rr.dug, at: rr.at, why: rr.why }
      if (!ctl.aborted && session.bot === bot && rr.own?.size) {
        st.sealedState ||= { own: new Set(), filled: new Set(), exposed: true, dug: 0, moves: 0,
          fills: 0, ores: 0, bonusBlocks: 0, goldPassed: 0, plans: 0, fails: [], planMs: 0, walks: 0 }
        for (const cell of rr.own) st.sealedState.own.add(cell)
        require('.././tunnel').rememberOwn(session, rr.own)
      }
      log('к защищённому бартеру по сетке', st.tunnel)
      if (!rr.ok || ctl.aborted || session.bot !== bot) {
        return { ...out('подход к защищённому бартеру не завершён'), barterRetry: rr.why || 'подход прерван' }
      }
      near = bot.entity.position.distanceTo(new Vec3(rec.x, rec.y, rec.z)) < 96
    }
    const restored = near && await prepareBarterCover(session, ctl, st, Math.min(deadline - 85000, gameClock.now() + 60000))
    if (!restored || !restored.ok) {
      const refused = restored && restored.ok === false ? restored : undefined
      // Гибкость (решение пользователя 06.10): укрытие не встало — бартер на открытом, как у спидраннеров, когда риск мал: золото
      // на теле, хп ≥ 16, взрослые пиглины рядом; бруты/хоглины — отказ самого pearls.barter (bastionThreats). По std-прогонам
      // «укрытие не подтверждено» — 62 вызова с нулём сделок при золоте в рюкзаке. ND_OPEN_BARTER=0 — выкл.
      const carried = countOf(bot, 'gold_ingot') + 9 * countOf(bot, 'gold_block') - keep
      if (process.env.ND_OPEN_BARTER !== '0' && near && carried >= 8 && goldWorn(bot) && (bot.health ?? 0) >= 16 &&
        mobs(bot, 'piglin', 16).some(e => !isBaby(bot, e)) && !ctl.aborted && gameClock.now() < deadline - 60000) {
        if (countOf(bot, 'gold_ingot') - keep < carried) await unpackGold(session, ctl, carried)
        const n = countOf(bot, 'gold_ingot') - keep
        const ob: any = await barterRound(session, ctl, st, n, deadline - 30000).catch(e => ({ error: e.message }))
        st.lastBarter = 'на открытом'
        log('бартер на открытом (укрытие не встало)', { ingots: n, spent: ob && ob.spent, pearls: ob && ob.pearls, stopped: ob && (ob.stopped || ob.error), why: refused?.why })
        if (ob && ob.spent > 0) return { ...out(ob.stopped ? 'бартер на открытом: ' + ob.stopped : null), openBarter: { spent: ob.spent, pearls: ob.pearls || 0 } }
      }
      return { ...out('защищённое укрытие для бартера не подтверждено; выход к торговцам без укрытия запрещён'),
        barterRetry: refused?.why || 'далеко от известного бастиона', barterCover: refused?.diagnostic }
    }
    memoSave()
  }

  const spare = () => countOf(bot, 'gold_ingot') + 9 * countOf(bot, 'gold_block') - keep
  // Огнестойкость — плюс, не цель копки (решение пользователя 06.10 22:33): за неё отдаётся уже добытое золото (оно оплачено),
  // но ни копки, ни ожидания ради неё (барьер-модель: слиток стоит 2.4 с торга + 2.5 с копки, FR даёт 0.034 на слиток).
  const done = () => countOf(bot, 'ender_pearl') >= wantPearls && (fireRes(bot) >= wantFire || spare() <= 0) && countOf(bot, 'obsidian') >= wantObs && exitReserveReady(bot, p)
  // Сколько слитков нужно на цели (таблица бартера 1.21.11): жемчуг 0.064 на
  const goldTarget = () => p.gold ?? Math.min(BF.enabled() ? 480 : 240, Math.max(
    BF.enabled() ? BF.pearlBudget(wantPearls - countOf(bot, 'ender_pearl')) : Math.ceil(Math.max(0, wantPearls - countOf(bot, 'ender_pearl')) / 0.064),
    Math.ceil(Math.max(0, wantObs - countOf(bot, 'obsidian')) / (40 / 469)),
    // Нет огня: 34 сделки дают >=95% хотя бы одного fire_charge (40/469).
    !exitReserveReady(bot, p) && !require('.././nether').exitKit(bot).lighter ? 34 : 0))
  // Пакет копки — от модели бартера S3 (core/barter-model.barterPlan через barter-flow.plan): при известном золоте бастиона
  // (st.pred — карта копии или узнанные стены) копать пакет B* = √(2·S·E[копки]/c) и торговать, а не всё «на 85 % жемчуга» сразу.
  // Модель считается на начало пакета (gold 0: добытое ещё не в рюкзаке), её строка — в лог и в итог (detail.plans).
  st.round = 0
  let batchRound = -1
  const batch = () => {
    if (batchRound === st.round) return st.batch
    batchRound = st.round
    const tr = st.pitTrade || {}
    const d = BF.plan({ pearls: countOf(bot, 'ender_pearl'), required: wantPearls, gold: 0, siteIngots: st.pred.size * 9,
      delivered: tr.barterDelivered, thrown: tr.barterReceipts,
      ...(st.traded ? { traded: { ingots: st.traded, seconds: tr.seconds || 0 } } : {}),
      fireRes: { have: fireRes(bot), want: wantFire, valueSeconds: 120 } })
    st.batch = d.action === 'mine' ? Math.max(9, d.batch) : 9
    ;(st.plans ||= []).push({ round: st.round, action: d.action, batch: d.batch, eSeconds: Math.round(d.eSeconds), pReach: Math.round(d.pReach * 100) / 100, why: d.why })
    log(d.line, { round: st.round, site: st.pred.size * 9, pearls: countOf(bot, 'ender_pearl'), want: wantPearls, spare: spare(), batch: st.batch })
    return st.batch
  }
  st.stopMining = () => mode !== 'gold' && spare() >= (BF.enabled() && st.pred.size && p.gold == null ? batch() : BF.enabled() ? Math.min(144, goldTarget()) : goldTarget())
  if (BF.enabled()) st.fastSafe = true
  // Золоту — не больше 60% вызова: остальное — бартер (прогон 2 лаборатории
  // ходил по точкам обзора все 500 с, и на обмен не осталось ни секунды).
  let goldPhaseEnd = mode === 'gold' ? deadline : t0 + (deadline - t0) * 0.6
  let barterNext = 0
  // Без брони: после каждой добычи — броня из неё; пока её нет, ни торга, ни хода по двору.
  const goldReady = async () => {
    if (!st.goldless) return true
    if (!(await armGold(session, ctl))) return false
    st.goldless = false
    log('золотая броня из добычи бастиона — дальше как обычно', { ingots: countOf(bot, 'gold_ingot'), blocks: countOf(bot, 'gold_block') })
    return true
  }
  const piglinsAround = () => mobs(bot, 'piglin', 16).filter(e => !isBaby(bot, e) && seesMob(bot, e))
  const tryBarter = async (force = false) => {
    if (mode === 'gold' || done() || gameClock.now() < barterNext) return false
    if (!(await goldReady())) return false
    if (!force && spare() < 24) return false
    if (countOf(bot, 'gold_ingot') - keep < 8 && countOf(bot, 'gold_block')) await unpackGold(session, ctl, keep + 27)
    const can = countOf(bot, 'gold_ingot') - keep
    if (can <= 0 || !piglinsAround().length) return false
    const r = await barterRound(session, ctl, st, Math.min(can, 24), deadline)
    log('бартер', { spent: r.spent, handed: r.handed, thrown: r.thrown, stopped: r.stopped, gained: r.gained, s: r.seconds })
    barterNext = gameClock.now() + (r.spent > 0 ? 1500 : 20000)
    if (!(r.spent > 0)) st.lastBarter = r.stopped || 'пиглины не берут'
    return r.spent > 0
  }

  // Кто и чем бьёт (damage_event: тип урона из реестра 1.21.11, причина) — с позицией, хп и
  // блоками вокруг: урон 20→5 за секунды у свалки ямы (pit-dump 30.09) остался без объяснения.
  st.hurts = []
  let lastHp = bot.health ?? 20
  const onDmg = pk => {
    if (!pk || pk.entityId !== bot.entity.id || st.hurts.length >= 40) return
    const f = bot.entity.position
    const nm = v => { const b = bot.blockAt(v); return b ? b.name : '?' }
    const cause = id => { const e = bot.entities[id]; return e ? (e.name || e.username || e.type) : (id >= 0 ? '#' + id : null) }
    const src = bot.entities[(pk.sourceCauseId ?? 0) - 1]
    const rel = src && src.position ? [+(src.position.x - f.x).toFixed(2), +(src.position.y - f.y).toFixed(2), +(src.position.z - f.z).toFixed(2)] : null
    const rec = { t: Math.round((gameClock.now() - t0) / 1000), type: DAMAGE_TYPES[pk.sourceTypeId] || pk.sourceTypeId, by: cause((pk.sourceCauseId ?? 0) - 1), rel, hpBefore: Math.round(lastHp), at: [+f.x.toFixed(2), +f.y.toFixed(2), +f.z.toFixed(2)], feet: nm(f), under: nm(f.offset(0, -0.5, 0)), head: nm(f.offset(0, 1.6, 0)), doing: st.doing || null }
    st.hurts.push(rec)
    log('урон', rec)
  }
  const onHp = () => { lastHp = bot.health ?? lastHp }
  bot._client.on('damage_event', onDmg)
  const toolFilter0 = bot._ndToolFilter
  bot._ndToolFilter = require('.././tunnel').makeToolFilter(bot, false)
  bot.on('health', onHp)
  try {
    // Дойти до бастиона (издалека — отрезками по Аду).
    const inOwnTunnel = !!(st.sealedState && st.sealedState.own && st.sealedState.own.has(`${Math.floor(bot.entity.position.x)},${Math.floor(bot.entity.position.y)},${Math.floor(bot.entity.position.z)}`))
    const nearMemo = !!memo && bot.entity.position.distanceTo(new Vec3(rec.x, rec.y, rec.z)) < 96
    if (inOwnTunnel || nearMemo) log('подход не нужен', { inOwnTunnel, nearMemo })
    // Золото бастиона известно (карта копии этого мира — разрешено пользователем 30.09): цель подхода — гуще
    const KG0 = (p.knownGold || []).map(([x, y, z]) => ({ x, y, z }))
    const me00 = bot.entity.position
    const dens0 = g => KG0.filter(q => Math.abs(q.x - g.x) + Math.abs(q.y - g.y) + Math.abs(q.z - g.z) <= 6).length
    // Гуща золота сокровищницы — дом брутов (копия мира): цель подхода — гуща вне их зоны, если такая есть (S1d 07.10:
    // 4120… — 6 смертей от брута у входа 18,41,−115, цель подхода 18,37,−124 — в 9 бл. от его места). Остальное золото
    // берёт закрытый штрек (sealedGold — бруты его не видят) или пропускает routeGold.
    const KGa = approachGold(KG0, require('.././nether-route').bruteSpots(session))
    const nearG0 = KGa.length ? KGa.reduce((a, b) => (dens0(b) > dens0(a) || (dens0(b) === dens0(a) && Math.hypot(b.x - me00.x, b.z - me00.z) < Math.hypot(a.x - me00.x, a.z - me00.z))) ? b : a) : null
    const needApproach = () => nearG0
      ? Math.hypot(nearG0.x - bot.entity.position.x, nearG0.z - bot.entity.position.z) > 12 || Math.abs(nearG0.y - bot.entity.position.y) > 8
      : bot.entity.position.distanceTo(new Vec3(rec.x, rec.y, rec.z)) > 40
    if (mode !== 'barter' && rec && needApproach() &&
      miningCycle.needsKnownGoldApproach(bot.entity.position, nearG0, inOwnTunnel, nearMemo)) {
      const { walkToward } = require('.././nether')
      // Подход по Аду — со строгим обходом лавы (session: шаг над обрывом к лаве — 1000, у лавы — 200):
      // pit-v2-14 и trip-9 30.09 — тело на подходе упало в лавовое озеро (y 24–31), одна смерть.
      const strict0 = bot._ndLavaStrict
      // Восстановить и при исключении из питья/штрека — во внешнем finally (ревью Codex 30.09).
      if (st.lavaStrict0 === undefined) st.lavaStrict0 = strict0
      bot._ndLavaStrict = true
      // Дальний путь (второй бастион): огнестойкость на дорогу, если зелий хватает (≥2 — одно остаётся).
      if ((p.tripSeconds || 0) > 0 && fireRes(bot) >= 2) { const fr = await drinkFireRes(bot).catch(() => null); log('в путь: огнестойкость', { fr, left: fireRes(bot) }) }
      // Издалека (второй бастион) — не в центр, а к краю: в 28 блоках не доходя, по горизонтали. У центра
      const me0 = bot.entity.position
      const far0 = Math.hypot(rec.x - me0.x, rec.z - me0.z)
      // Место обзора (vantage) из памяти — там вал бастиона виден с вышки (b2-15 30.09: 642,59,269 → стены
      // узнаны, 17 блоков); с края по прямой вышка слепла в толще незерака (trip2-11: basalt 0 ×3).
      const V = p.vantage || (rec && rec.vantage) || null
      // Золото бастиона известно (карта копии этого мира — разрешено пользователем 30.09): штрек — прямо к
      const nearG = nearG0
      const goal = nearG ? { x: nearG.x, y: nearG.y, z: nearG.z } : V ? { x: V.x, y: V.y ?? rec.y, z: V.z } : far0 > 200 ? { x: rec.x - (rec.x - me0.x) / far0 * 28, y: rec.y, z: rec.z - (rec.z - me0.z) / far0 * 28 } : rec
      // Сторож лавы: в лаве — оборвать ходьбу (свой ctl), выбраться, идти дальше.
      const walk = async (ms, to = null) => {
        const sub = { aborted: false, onAbort: [] as Array<() => void>, waitReflex: () => ctl.waitReflex?.() }
        const cut = () => { if (sub.aborted) return; sub.aborted = true; for (const fn of sub.onAbort) { try { fn() } catch {} } }
        const watch = gameClock.setInterval(() => { if (ctl.aborted || inLava(bot)) cut() }, 100)
        try { await walkToward(session, sub, to || goal, Math.min(deadline, gameClock.now() + ms), to ? { range: 8, xz: true } : goal === rec || V ? { range: V ? 4 : 6 } : { range: 6, xz: true }) } finally { gameClock.clearInterval(watch) }
        if (inLava(bot)) { try { bot.pathfinder.setGoal(null) } catch {} ; if (!(await lavaEscape(bot))) await lavaEscapeDeep(bot); st.lavaEscapes = (st.lavaEscapes || 0) + 1; return true }
        return false
      }
      // Штреком (tunnel.js), если далеко: пешком по Аду тело гибло (лавовое озеро у 103,31,80 — 4 смерти;
      const far1 = Math.hypot(goal.x - me0.x, goal.z - me0.z)
      // ND_NE_ROUTE=1 и сетка копии мира есть — к гуще золота одним планом (nether-route): мосты/спрыгивания по дороге,
      let routed = false
      const NR = require('.././nether-route')
      if (nearG && NR.enabled() && NR.gridOf(session) && !ctl.aborted && (far1 > 12 || Math.abs(goal.y - me0.y) > 8)) {
        const xs = KG0.map(q => q.x); const ys = KG0.map(q => q.y); const zs = KG0.map(q => q.z)
        const zone = [Math.min(...xs) - 12, Math.min(...ys) - 6, Math.min(...zs) - 12, Math.max(...xs) + 12, Math.max(...ys) + 8, Math.max(...zs) + 12]
        const rStart = bot.entity.position.floored()
        const rr = await lavaWatched(bot, ctl, sub => NR.routeTo(session, sub, { x: goal.x, y: goal.y, z: goal.z, r: 4, dy: 3, zone, zoneExpo: 5, supplyReserve: true, timeoutSeconds: Math.max(60, Math.min(600, Math.round((deadline - gameClock.now()) / 1000) - 300)) }))
        log('к бастиону по сетке', { ok: rr.ok, why: rr.why, steps: rr.steps, dug: rr.dug, placed: rr.placed, plans: rr.plans, s: rr.seconds, at: rr.at })
        if (!ctl.aborted && rr.own?.size) {
          const SL = require('.././sealed')
          const own = new Set([...(st.sealedState?.own || []), ...rr.own])
          st.sealedState = { ...(st.sealedState || {}), own, exposed: SL.exposure(bot, own).length > 0,
            entry: st.sealedState?.entry || { x: rStart.x, y: rStart.y, z: rStart.z },
            dug: st.sealedState?.dug || 0, moves: st.sealedState?.moves || 0, fills: st.sealedState?.fills || 0,
            ores: st.sealedState?.ores || 0, bonusBlocks: st.sealedState?.bonusBlocks || 0,
            goldPassed: st.sealedState?.goldPassed || 0, plans: st.sealedState?.plans || 0,
            fails: st.sealedState?.fails || [], planMs: st.sealedState?.planMs || 0, walks: st.sealedState?.walks || 0 }
          try { require('.././tunnel').rememberOwn(session, [...own]) } catch {}
        }
        if (rr.supplyNeeded && !ctl.aborted && session.bot === bot) {
          st.supplyNeeded = rr.supplyNeeded
          return out(rr.why || 'нужно пополнить инструменты до продолжения подхода')
        }
        if (rr.ok && !ctl.aborted) {
          routed = true
          st.tunnel = { ok: true, route: true, steps: rr.steps, dug: rr.dug, at: rr.at }
        }
      }
      // Без золотой брони — штреком и вблизи: пешком на виду у пиглинов — бой с ними (b0-5-1 14.10: «враги 8 не по силам»).
      if (!routed && (far1 > (st.goldless ? 12 : 40) || (nearG && (far1 > 12 || Math.abs(goal.y - me0.y) > 8))) && p.tunnel !== false) {
        // Вслепую — закрытым штреком по видимому (nether-cover.coveredTo): tunnelTo планирует по скрытому объёму (Codex q9).
        const NC = require('.././nether-cover')
        const tunnelTo = NC.blind() ? (s0, sub, g, o) => NC.coveredTo(s0, sub, g, { deadline: o.deadline, radius: o.radius }) : require('.././tunnel').tunnelTo
        // Вход штрека подхода — клетка, откуда он начат: без него exitTunnel отвечал «входа нет», и после бастиона тело
        // оставалось в своём штреке под лавовым морем (neF-mB26-1 02.10: y 21, все шаги к спавнеру и порталу — на месте).
        let tStart = bot.entity.position.floored()
        const tOpts = () => ({ band: p.band ?? 40, radius: nearG ? 10 : 5, noBreachNear: rec ? { x: rec.x, z: rec.z, r: 48 } : null, deadline: Math.min(deadline - 240000, gameClock.now() + 90000 + far1 * 3000), log: (w, d) => log(w, d) })
        let tr = await lavaWatched(bot, ctl, sub => tunnelTo(session, sub, goal, tOpts()))
        // Штрек не начался (тело на открытом, «со старта не войти»): закопаться и снова.
        if (!tr.ok && !tr.segs && (tr.dug || 0) < 8 && !ctl.aborted && process.env.ND_BURROW !== '0') {
          const bw = await burrow(session, ctl, st, 'штрек к бастиону не начался')
          if (bw.ok) { tStart = bot.entity.position.floored(); tr = await lavaWatched(bot, ctl, sub => tunnelTo(session, sub, goal, tOpts())) } else log('закопаться не вышло', { why: bw.why })
        }
        st.tunnel = { ok: tr.ok, why: tr.why, segs: tr.segs, breach: tr.breach, detours: tr.detours, dug: tr.dug, crafted: tr.crafted, at: tr.at }
        log('штрек к бастиону', st.tunnel)
        // Дальше — тем же закрытым штреком: его клетки — «свои» для sealedGold (без «ко входу» пешком).
        if (nearG && tr.own && tr.own.size) st.sealedState = { own: tr.own, exposed: !!tr.exposed, entry: { x: tStart.x, y: tStart.y, z: tStart.z }, dug: 0, moves: 0, fills: 0, ores: 0, bonusBlocks: 0, goldPassed: 0, plans: 0, fails: [], planMs: 0, walks: 0 }
        // Известное золото, а штрек встал далеко («пути нет»: лавовые озёра по дороге — neF-map26-1 02.10: 145 бл. до
        for (let k = 0; k < 2 && nearG && !tr.ok && !ctl.aborted && gameClock.now() < deadline - 300000; k++) {
          const me1 = bot.entity.position
          const d1 = Math.hypot(nearG.x - me1.x, nearG.z - me1.z)
          if (d1 <= 60) break
          const mid = { x: Math.round(nearG.x - (nearG.x - me1.x) / d1 * 40), y: Math.round(me1.y), z: Math.round(nearG.z - (nearG.z - me1.z) / d1 * 40) }
          // Пешком по Аду — только под огнестойкостью (есть зелье — выпить): без неё подход ногами кончался лавой и
          if (st.fastSafe && !effectOn(bot, 'fire_resistance')) {
            if (fireRes(bot) >= 1) { const d = await drinkFireRes(bot).catch(e => e.message); for (let q = 0; q < 30 && !effectOn(bot, 'fire_resistance'); q++) await sleep(100); log('подход пешком: огнестойкость', { d, left: fireRes(bot) }) }
            // Без зелья — только недалеко (≤ 110 бл., строгий обход лавы): иначе тело стоит у портала весь прогон
            // (neF-T24-1 02.10: штрек и закопаться не начались на тонкой корке у портала, 84 бл. до золота).
            if (!effectOn(bot, 'fire_resistance') && d1 > 110) { log('подход пешком без огнестойкости — не иду', { left: Math.round(d1) }); break }
          }
          await walk(150000, mid)
          const d2 = Math.hypot(nearG.x - bot.entity.position.x, nearG.z - bot.entity.position.z)
          log('подход пешком к штреку', { k, from: { x: Math.round(me1.x), y: Math.round(me1.y), z: Math.round(me1.z) }, to: mid, left: Math.round(d2), was: Math.round(d1) })
          if (d2 > d1 - 16 && k > 0) break
          let tStart2 = bot.entity.position.floored()
          const tOpts2 = () => ({ band: p.band ?? 40, radius: 10, noBreachNear: rec ? { x: rec.x, z: rec.z, r: 48 } : null, deadline: Math.min(deadline - 240000, gameClock.now() + 90000 + d2 * 3000), log: (w, d) => log(w, d) })
          let tr2 = await lavaWatched(bot, ctl, sub => tunnelTo(session, sub, goal, tOpts2()))
          if (!tr2.ok && !tr2.segs && (tr2.dug || 0) < 8 && !ctl.aborted && process.env.ND_BURROW !== '0') {
            const bw = await burrow(session, ctl, st, 'штрек после подхода не начался')
            if (bw.ok) { tStart2 = bot.entity.position.floored(); tr2 = await lavaWatched(bot, ctl, sub => tunnelTo(session, sub, goal, tOpts2())) } else log('закопаться не вышло', { why: bw.why })
          }
          st.tunnel = { ok: tr2.ok, why: tr2.why, segs: tr2.segs, breach: tr2.breach, detours: tr2.detours, dug: tr2.dug, crafted: tr2.crafted, at: tr2.at, walked: k + 1 }
          log('штрек к бастиону', st.tunnel)
          if (tr2.own && tr2.own.size) st.sealedState = { own: tr2.own, exposed: !!tr2.exposed, entry: { x: tStart2.x, y: tStart2.y, z: tStart2.z }, dug: 0, moves: 0, fills: 0, ores: 0, bonusBlocks: 0, goldPassed: 0, plans: 0, fails: [], planMs: 0, walks: 0 }
          if (tr2.ok) break
        }
      }
      try {
        const left = () => goal === rec ? bot.entity.position.distanceTo(new Vec3(rec.x, rec.y, rec.z)) : Math.hypot(goal.x - bot.entity.position.x, goal.z - bot.entity.position.z)
        // Вслепую без золотой вещи поверху не идём (d5-7-1 14.10: штрек «пути нет» → пешком над лавовым морем, падение с y 74).
        const openOk = !(require('.././nether-cover').blind() && !goldWorn(bot))
        let again = openOk && !nearG && left() > (goal === rec ? 40 : 12) ? await walk(180000 + (p.tripSeconds || 0) * 1000) : false
        // Второй заход (бой по дороге, обрыв: booth-2 — «не дошёл: 76 блоков» за 38 с; вынырнули из лавы).
        for (let k = 0; k < 3 && openOk && !nearG && !ctl.aborted && (again || left() > (goal === rec ? 48 : 20)) && gameClock.now() < deadline - 300000; k++) {
          if ((bot.health ?? 20) < 12) await eatIfHungry(session, ctl)
          again = await walk(150000)
        }
      } finally { bot._ndLavaStrict = strict0 }
      const leftNow = nearG0 ? Math.hypot(nearG0.x - bot.entity.position.x, nearG0.z - bot.entity.position.z) : bot.entity.position.distanceTo(new Vec3(rec.x, rec.y, rec.z))
      // Известное золото: штрек довёл на ~50 блоков, а дальше закрытого пути нет (вокруг двор и лава) —
      if (nearG0 ? leftNow > 72 : leftNow > 48) return out(`до бастиона не дошёл: ${Math.round(leftNow)} блоков`)
    }
    if ((p.knownGold || []).length && !st.knownLoaded) {
      st.knownLoaded = true
      for (const [x, y, z] of p.knownGold) { const v = new Vec3(x, y, z); const b = bot.blockAt(v); if (b && b.name !== 'gold_block' && b.boundingBox === 'empty') continue; const k = keyOf(v); if (!st.pred.has(k)) st.pred.set(k, { pos: v, piece: 'память', rank: 0 }) }
      for (const [x, y, z] of (p.knownChests || [])) { const v = new Vec3(x, y, z); const k = keyOf(v); if (!st.chestSeen.has(k) && !st.looted.has(k)) st.chestSeen.set(k, { pos: v, seen: gameClock.now(), pred: true }) }
      st.towered = 3
      log('бастион по памяти', { gold: st.pred.size, chests: st.chestSeen.size })
    }
    const center = rec ? centerGuess(bot, rec) : bot.entity.position.floored()
    const points = rec ? vantagePoints(center, center.box) : []
    log('план обзора', { center: { x: center.x, y: center.y, z: center.z }, box: center.box, points: points.length })
    let idle = 0
    let vantage = 0
    let barterWalks = 0
    let minedSinceRetry = false
    const miningSnapshot = () => ({ goldBlocks: st.blocks, chests: st.chests.length,
      dug: st.sealedState?.dug || 0, ownCells: st.sealedState?.own.size || 0, gold: spare() })
    while (!ctl.aborted && gameClock.now() < deadline - 12000) {
      if (inLava(bot)) { if (!(await lavaEscape(bot))) await lavaEscapeDeep(bot); continue }
      if ((bot.health ?? 20) < 8) return out(`хп ${Math.round(bot.health)} — ухожу лечиться`)
      await eatIfHungry(session, ctl)
      if (await answerAttack(session, ctl, st)) continue
      if (await bruteDefense(session, ctl, st)) continue
      if (mode !== 'gold' && done()) break
      // Закрытый путь: после золота — торговое окно из штрека, потом штреком назад.
      if (st.sealed && st.sealedState && st.sealedDone && !st.pitDone) {
        st.pitDone = true
        if (mode !== 'gold' && !done() && (spare() > 0 || countOf(bot, 'gold_block')) && await goldReady()) {
          // Яма со ртом (добыча падает к нам); не вышла — окно в стене.
          let bo = null
          for (let tryN = 0; tryN < (BF.enabled() ? 2 : 6) && !bo && !ctl.aborted && gameClock.now() < deadline - 90000; tryN++) {
            if (tryN && BF.enabled()) {
              if (!(await moveBarterSite(session, ctl, st, p, deadline - 60000))) break
            }
            if (tryN && !BF.enabled()) {
              // Тело стоит не в своём ходе (ход по сетке к золоту кончился у двора: план ямы — «пути нет», 9 узлов:
              // D2-21 03.10 — 19 золотых блоков в рюкзаке, бартера не было вовсе) — закопаться в толщу и искать снова.
              if (tryN <= 2 && process.env.ND_GOLD_ROUTE === '1' && !ownTunnelAt(bot, st.sealedState)) {
                const bw = await burrow(session, ctl, st, 'бартер: места нет').catch(e => ({ ok: false, why: e.message }))
                log('бартер: закопался', { ok: bw && bw.ok, why: bw && bw.why })
                if (bw && bw.ok) continue
              }
              st.doing = 'жду место'; log('бартер: места нет — жду', { try: tryN, pigs: mobs(bot, 'piglin', 40).length })
              const w = await waitWatched(session, ctl, 15000)
              if (w) log('бартер: ждать не вышло', { why: w, hp: Math.round(bot.health ?? 0) })
            }
            bo = p.trade === 'trap' ? await digTrap(session, ctl, st, deadline - 85000) : null
            if (!bo && p.trade !== 'booth') bo = await digPit(session, ctl, st, deadline - 85000)
            // Окно — только по просьбе (trade:'booth' или boothFallback): доставка у окна 0–41% (pit-v2-1
            // 30.09: 41 слиток — один бросок пиглина). Ямы нет — золото остаётся в рюкзаке до другого места.
            if (!bo && ((!BF.enabled() && tryN >= 1 && p.boothFallback !== false) || p.trade === 'booth')) bo = await digBooth(session, ctl, st, deadline - 85000)
          }
          if (bo) {
            st.pit = { kind: bo.kind || 'booth', at: bo.F, window: bo.W, dump: !!bo.dump, catch: bo.catch, pigs: bo.pigs, brutes: bo.brutes, sealed: bo.sealed, baited: bo.baited }
            st.pitTrade = await (bo.kind === 'pit' ? penTrade : boothTrade)(session, ctl, st, bo, deadline - 5000, { keep, done })
            log(bo.kind === 'trap' ? 'ловушка: бартер' : bo.kind === 'pit' ? 'яма: бартер' : 'окно: бартер', st.pitTrade)
            // Яма не работает (приманки не берут, нет бросков) — другая яма, до двух раз.
            const notWorking = t => t && (t.stopped === 'яма не работает' || t.stopped === 'яма не доносит' || /не подходят|страж изменил место|ушёл из места/.test(t.stopped || ''))
            for (let k = 0; k < 2 && bo.kind === 'pit' && notWorking(st.pitTrade) && countOf(bot, 'gold_ingot') + 9 * countOf(bot, 'gold_block') >= 18 && !ctl.aborted && gameClock.now() < deadline - 150000; k++) {
              const S2 = st.sealedState
              ;(S2.badPits || (S2.badPits = new Set())).add(require('.././sealed').key(bo.M.x, bo.M.y, bo.M.z))
              log('яма не работает — другая', { at: bo.P, tossed: st.pitTrade.tossed, seconds: st.pitTrade.seconds })
              if (BF.enabled() && !(await moveBarterSite(session, ctl, st, p, deadline - 60000))) break
              const bo2 = await digPit(session, ctl, st, deadline - 85000)
              if (!bo2) break
              bo = bo2
              st.pits = [...(st.pits || [st.pit]), { kind: bo.kind, at: bo.F, catch: bo.catch, pigs: bo.pigs, sealed: bo.sealed }]
              const r2 = await penTrade(session, ctl, st, bo, deadline - 5000, { keep, done })
              log('яма: бартер', r2)
              st.pitTrade = mergeTrades(st.pitTrade, r2)
            }
          } else {
            st.lastBarter = 'ни ямы, ни окна'
            if (BF.enabled()) st.barterRetry = 'нет защищённого места у торговцев'
            // ND_OPEN_BARTER=1: ни ямы, ни окна, а золото есть — бартер на открытом, как у спидраннеров (золотая броня, брутов и
            // хоглинов в 24 нет): D7b-32 03.10 — 15 золотых блоков, 0 сделок, бастион «выработан».
            if (!BF.enabled() && process.env.ND_OPEN_BARTER === '1' && !ctl.aborted && goldWorn(bot) && countOf(bot, 'gold_ingot') + 9 * countOf(bot, 'gold_block') >= 9 &&
              ![...mobs(bot, 'piglin_brute', 24), ...mobs(bot, 'hoglin', 24)].length && gameClock.now() < deadline - 60000) {
              await unpackGold(session, ctl, 9 * countOf(bot, 'gold_block') + countOf(bot, 'gold_ingot'))
              const n = countOf(bot, 'gold_ingot')
              const ob = await barterRound(session, ctl, st, n, deadline - 40000).catch(e => ({ error: e.message }))
              st.lastBarter = 'на открытом'
              log('бартер на открытом', { ingots: n, spent: ob && ob.spent, pearls: ob && ob.pearls, stopped: ob && (ob.stopped || ob.error) })
            }
          }
          // ND_PEARL_PICK=1: жемчуг, брошенный мимо ямы (D6-21 03.10: 108 слитков, брошено 4 жемчуга, доставка 0.58 — в
          // рюкзаке 0), — ходом по сетке (двор втридорога, брут в 10 — бросить) к каждому в 14 бл. и подобрать.
          if (bo && process.env.ND_PEARL_PICK === '1' && !ctl.aborted) {
            const NR = require('.././nether-route')
            const isPearl = e => { try { const d = e.getDroppedItem && e.getDroppedItem(); return !!d && d.name === 'ender_pearl' } catch { return false } }
            const pk = { seen: 0, went: 0, got: 0 }
            const p0 = countOf(bot, 'ender_pearl')
            for (let k = 0; k < 5 && NR.enabled() && NR.gridOf(session) && !ctl.aborted && gameClock.now() < deadline - 60000; k++) {
              const me = bot.entity.position
              const its: any = (Object.values(bot.entities) as any[]).filter((e : any) => e && e.name === 'item' && e.position && isPearl(e) && e.position.distanceTo(me) < 14 && e.position.distanceTo(me) > 1.3).sort((a: any, b: any) => a.position.distanceTo(me) - b.position.distanceTo(me))
              if (!k) pk.seen = its.length
              if (!its.length || mobs(bot, 'piglin_brute', 16).length) break
              const g = its[0].position.floored()
              pk.went++
              const rr = await NR.routeTo(session, ctl, { x: g.x, y: g.y, z: g.z, r: 1, dy: 1, zones: undefined, zoneExpo: 14, abortNear: { re: '^(piglin_brute|hoglin)$', r: 10 }, timeoutSeconds: 45 }).catch(e => ({ ok: false, why: e.message }))
              for (const c of (rr.own || [])) { if (st.sealedState && st.sealedState.own) st.sealedState.own.add(c) }
              await pickUp(bot, ctl, 3, 2500)
              if (!rr.ok) break
            }
            pk.got = countOf(bot, 'ender_pearl') - p0
            if (pk.seen || pk.went) log('жемчуг мимо ямы', pk)
          }
        }
        // Лечиться — здесь, в замкнутой яме/штреке, а не снаружи: кампания после захода с хп 6 искала
        // нору в Аду, нора не закрылась — «БЛОКЕР», тело отключено (ферма 30.09, camp-10).
        if ((bot.health ?? 20) < 14 && !ctl.aborted) {
          const h0 = Math.round(bot.health ?? 0)
          const until2 = Math.min(deadline - 20000, gameClock.now() + 120000)
          while ((bot.health ?? 20) < 16 && gameClock.now() < until2 && !ctl.aborted && !inLava(bot)) {
            if ((bot.food ?? 20) < 18) await eatIfHungry(session, ctl)
            if ((bot.food ?? 20) < 18 && (bot.food ?? 20) < 20 && !bot.inventory.items().some(i => /cooked|bread|apple|carrot|potato|melon_slice|stew|porkchop|beef|mutton|chicken|rabbit|cod|salmon/.test(i.name))) break
            await sleep(2000)
          }
          st.healed = { from: h0, to: Math.round(bot.health ?? 0) }
          log('лечусь в штреке', st.healed)
        }
        // Выходить — только подлечившись (хп ≥ 14); иначе остаться в замкнутом штреке: следующий вызов
        // продолжит отсюда (ревью Codex 30.09: выход при хп 7 после неудачного лечения).
        if (p.exit !== false && (!BF.enabled() || done()) && (bot.health ?? 20) >= 14 && exitReserveReady(bot, p)) { st.exit = await exitTunnel(session, ctl, st, deadline); log('выход', st.exit) } else if (p.exit !== false && (!BF.enabled() || done())) { st.exit = { ok: false, why: !exitReserveReady(bot, p) ? 'набор на выход не готов (обсидиан/огонь) — остаюсь в штреке' : `лечение не завершилось (хп ${Math.round(bot.health ?? 0)}) — остаюсь в штреке` }; log('выход', st.exit) }
        if (BF.enabled() && mode !== 'gold' && !done() && !ctl.aborted) {
          if (spare() < 18 && st.pred.size && !st.noPick && gameClock.now() < deadline - 60000) {
            // Ход к сундукам/золоту без единого блока золота — тоже «продвижение» для miningProgress; два пакета подряд без золота —
            // стоп (s1c-A-8 06.10: 4 пакета по кругу у сундуков, которые видят пиглины, и «небезопасных» блоков; 680 с, 0 золота).
            st.dryBatches = st.blocks > (st.blocksAtBatch ?? -1) || spare() > 0 ? 0 : (st.dryBatches || 0) + 1
            st.blocksAtBatch = st.blocks
            if (!minedSinceRetry || mode === 'barter' || st.dryBatches >= 2) {
              st.barterRetry = 'добыча не продвинулась — нужен новый путь к оставшемуся золоту'
              break
            }
            minedSinceRetry = false
            st.pitDone = false; st.sealedDone = false
            // S1f: новый пакет — новая фаза золота. Прежний goldPhaseEnd (конец первого пакета, «сейчас») делал goldOver истинным на
            // первом же обороте: пакет 2+ не копался ни разу, заход кончался «золото кончилось» при 54 целях шаблона (s1f-B0-1).
            if (process.env.ND_BATCH_PHASE !== '0') goldPhaseEnd = gameClock.now() + (deadline - gameClock.now()) * 0.6
            st.round++
            log('бартер: следующий пакет золота', { left: st.pred.size, pearls: countOf(bot, 'ender_pearl') })
            continue
          }
          if (spare() >= 18) st.barterRetry = 'сменить место у торговцев с сохранённым золотом'
        }
        break
      }
      // Бартер между делом: слитков много и пиглины рядом — сделки идут, пока
      // копаем (и разглядывающие золото не злятся от следующего блока).
      if (!st.sealed || !st.sealedState) { if (await tryBarter()) continue }
      // S1f: >= — «фаза кончилась сейчас» (goldPhaseEnd = now) под пошаговой фермой не ждёт сдвига часов: с > цикл без единого await
      // на таймере крутился вечно (мир ждёт тело) — s1f-D1-1: «игровые часы стоят 90 с» после 16 точек обзора.
      const goldOver = mode === 'barter' || spare() >= goldTarget() || gameClock.now() >= goldPhaseEnd
      if (goldOver) {
        if (mode === 'gold') break
        if (!(await goldReady())) { st.lastBarter = st.lastBarter || 'без золотой брони к торговцам не иду'; break }
        // Злость пиглинов от сломанного золота — 600 тиков (30 с): торговать,
        // когда остынут, а до того сидеть там, где копал (они до нас не доходят).
        if (gameClock.now() - (st.lastBreak || 0) < 33000) { await sleep(2000); continue }
        if (spare() <= 0) break
        if (await tryBarter(true)) continue
        // Брут в 16 — к торговцам не идти: выход из ямы под его удары (S1d s1d-F21-1: «бартер: рядом брут в 10 — отойти», ход к пиглинам
        // через двор — 2 удара, смерть). Заложиться на месте и кончить заход.
        // Пиглинов в 16 не видно — к ближайшему известному (до 48 блоков).
        const tr = nearestTrader(bot, 48)
        const brutesNear = mobs(bot, 'piglin_brute', 24)
        if (brutesNear.length) {
          const reach = reachSet(bot)
          const A = require('.././assess')
          const g = A.gearOf([5, 6, 7, 8].map(i => bot.inventory.slots[i]))
          const wr = bruteWalkRisk(brutesNear, { threatens: b => threatens(bot, b, reach), nearTrader: b => !!tr && b.position.distanceTo(tr.e.position) < 10,
            hit: A.afterArmor(13, g.armor, g.tough), hp: bot.health ?? 20 })
          if (!wr.go) { log('бартер: к торговцам — брут', { ...wr, brutes: brutesNear.length }); await hunker(session, ctl, st, 'брут рядом — к торговцам не иду').catch(() => null); st.lastBarter = 'брут рядом'; break }
        }
        if (!tr || barterWalks >= 8) { st.lastBarter = st.lastBarter || 'пиглинов рядом нет'; break }
        barterWalks++
        const pg: any = tr.e
        await walkGoal(session, ctl, new goals.GoalNear(pg.position.x, pg.position.y, pg.position.z, 3), 15000, { dig: !tr.walk })
        barterNext = 0
        continue
      }
      // Закрытый штрек (sealed): вышка-обзор → золото по шаблону сквозь твёрдое.
      if (st.sealed && mode !== 'barter' && !st.sealedDone) {
        survey(bot, st, 56)
        const chestsLeft = st.lootChests && [...st.chestSeen.keys()].some(k => !st.looted.has(k))
        const goldLeft = !st.chestsOnly && (st.pred.size > 0 || st.gold.size > 0)
        if (!goldLeft && !chestsLeft && st.towered < 3 &&
            (!st.lastTower || st.lastTower.distanceTo(bot.entity.position) >= 4)) {
          st.towered++
          await towerScan(session, ctl, st)
          st.lastTower = bot.entity.position.clone()
          continue
        }
        if (st.chestsOnly && chestsLeft) {
          await sealedGold(session, ctl, st, Math.max(gameClock.now() + 60000, deadline - 300000))
          await goldReady()
          const made = await makeIronPick(session, ctl)
          log('железная кирка из сундуков', { made, ingots: countOf(bot, 'iron_ingot'), raw: countOf(bot, 'raw_iron'), nuggets: countOf(bot, 'iron_nugget'), blocks: countOf(bot, 'iron_block') })
          st.chestsOnly = false
          if (!made) { st.ironNeed = true; break }
          continue
        }
        // Сундуки, увиденные с вышки (survey), — тоже цели закрытого штрека: в сундуках бастиона золото и золотая броня
        // (loot_table chests/bastion_other: ботинки ×2, шлем, нагрудник, поножи, блок и слитки — 9 из 20 на бросок, бросков 2).
        // Вслепую стены по шаблону часто не узнаются (b2-6-1 14.10), а сундук двора виден — без него заход кончался пустым.
        if (goldLeft || chestsLeft) {
          const beforeMining = miningSnapshot()
          await sealedGold(session, ctl, st, mode === 'gold' ? deadline : Math.max(gameClock.now() + 60000, deadline - 240000))
          await goldReady()
          // Золото карты осталось — ходом по сетке к каждому (ND_GOLD_ROUTE=1).
          if (process.env.ND_GOLD_ROUTE === '1' && st.pred.size && !ctl.aborted) st.routeGold = await routeGold(session, ctl, st, mode === 'gold' ? deadline : Math.max(gameClock.now() + 60000, deadline - 200000))
          minedSinceRetry = miningCycle.miningProgress(beforeMining, miningSnapshot())
          st.sealedDone = true
          goldPhaseEnd = gameClock.now()
          continue
        }
        // shortcut: три перехода только по видимому полу; если не хватит, добавить поиск по пеленгам.
        // Вслепую — и с золотом не ходить по бастиону открыто: бруты бьют при любом золоте (g4-9-1: обзор по двору на ботинках —
        // брут, смерть на 3-й мин); обзор — зондом закрытого штрека ниже.
        if (goldWorn(bot) && vantage < 3 && !require('.././nether-cover').blind()) {
          const eyes = require('.././perception/eyes')
          const view = { blockAt: pos => eyes.seesNow(bot, pos) ? bot.blockAt(pos) : null }
          const me = bot.entity.position.clone()
          st.been.push(me)
          const aims = points.map(q => new Vec3(q.x, q.y, q.z)).filter(q => !st.been.some(v => v.distanceTo(q) < 4))
          if (!aims.length) aims.push(new Vec3(center.x, center.y, center.z))
          const A = require('.././assess')
          const gear = A.gearOf([5, 6, 7, 8].map(i => bot.inventory.slots[i]))
          const brutes = mobs(bot, 'piglin_brute', 40).filter(e => seesMob(bot, e))
          const score = n => Math.min(...aims.map(q => q.distanceTo(n.pos))) + n.d * 0.3
          const next = require('.././walkable').walkable(view, me, { radius: 20, maxNodes: 3000 })
            .filter(n => !st.visited.has(keyOf(n.pos)) && !st.been.some(v => v.distanceTo(n.pos) < 4))
            .filter(n => bruteWalkRisk(brutes, { threatens: () => false, nearTrader: e => e.position.distanceTo(n.pos) < 10,
              hit: A.afterArmor(13, gear.armor, gear.tough), hp: bot.health ?? 20 }).go)
            .sort((a, b) => score(a) - score(b))[0]
          if (next) {
            st.visited.add(keyOf(next.pos))
            vantage++
            const strict = bot._ndLavaStrict
            bot._ndLavaStrict = true
            let w
            try {
              w = await walkUnlessBrute(session, ctl, new goals.GoalBlock(next.pos.x, next.pos.y, next.pos.z),
                Math.min(20000, deadline - gameClock.now() - 12000), { dig: false })
            } finally { bot._ndLavaStrict = strict }
            if (!ctl.aborted && session.bot === bot) survey(bot, st, 56)
            log('закрытый заход: обзор', { to: xyz(next.pos), ok: w && w.ok, moved: me.distanceTo(bot.entity.position),
              gold: st.gold.size, chests: st.chestSeen.size })
            continue
          }
        }
        // Вслепую без золотой вещи — к центру бастиона закрытым штреком (nether-cover), устья — окна обзора (survey): вскрытый двор
        // показывает золото и сундуки, дальше — к ним (sealedGold). golden-v1 g1-5-1: бастион в 15 бл., «не узнан» за 2 с, брошен.
        const NC = require('.././nether-cover')
        if (NC.blind() && (st.probes || 0) < 6 && gameClock.now() < deadline - 30000) {
          st.probes = (st.probes || 0) + 1
          const targets = () => st.gold.size + [...st.chestSeen.keys()].filter(k => !st.looted.has(k)).length
          const r: any = await NC.closedBore(session, ctl, { x: center.x, z: center.z }, {
            deadline: Math.min(deadline - 20000, gameClock.now() + 60000), maxSteps: 24,
            onOpen: async () => { survey(bot, st, 56); return { seen: targets() } }, stop: v => !!(v && v.seen > 0)
          })
          survey(bot, st, 56)
          log('бастион: штреком к центру', { n: st.probes, ok: r.ok, moved: r.moved, mouths: r.mouths, corridor: r.corridor, gold: st.gold.size, chests: st.chestSeen.size, why: r.why, at: r.at })
          if (r.moved || targets()) continue
        }
        st.sealedDone = true
        st.notRecognized = true
        break
      }
      if (!(await goldReady())) { st.lastBarter = st.lastBarter || 'без золотой брони по двору не хожу'; break }
      survey(bot, st)
      const t = nextTarget(bot, st)
      // Целей не видно, а слитков на бартер хватает — к пиглинам (они в 32
      // блоках слышны), а не бродить по точкам обзора.
      if (!t && mode !== 'gold' && spare() >= 24 && barterWalks < 6) {
        const tr0 = nearestTrader(bot, 32)
        if (tr0) {
          barterWalks++
          const pg0: any = tr0.e
          await walkGoal(session, ctl, new goals.GoalNear(pg0.position.x, pg0.position.y, pg0.position.z, 3), 15000, { dig: !tr0.walk })
          barterNext = 0
          if (await tryBarter(true)) continue
        }
      }
      if (t) {
        idle = 0
        const r = t.kind === 'gold' ? await takeGoldBlock(session, ctl, t.pos, st) : await lootChest(session, ctl, t.pos, st)
        log(t.kind, { at: t.k, r, hp: Math.round(bot.health ?? 0), ingots: countOf(bot, 'gold_ingot'), blocks: countOf(bot, 'gold_block') })
        // Слитки на подкуп — из первого же блока.
        if (r === 'piglins' && !countOf(bot, 'gold_ingot') && countOf(bot, 'gold_block')) await unpackGold(session, ctl, 9)
        continue
      }
      // Видимых целей нет — узнать бастион сверху (вышка) и идти к золоту по
      // шаблону: предсказанные блоки в стенах (жилой: 17 золотых в двух стенах).
      if (!st.pred.size && st.towered < 2 && mode !== 'barter') {
        st.towered++
        await towerScan(session, ctl, st)
        continue
      }
      const pt = [...st.pred.entries()].filter(([k]) => (st.skip.get(k) || 0) < gameClock.now())
        .map(([k, v]) => ({ k, pos: v.pos, rank: v.rank || 0, d: v.pos.distanceTo(bot.entity.position) })).sort((a, c) => (a.rank - c.rank) || (a.d - c.d))[0]
      if (pt) {
        idle = 0
        const r = await digToPredicted(session, ctl, st, pt)
        log('к золоту по шаблону', { at: pt.k, ...r, left: st.pred.size, hp: Math.round(bot.health ?? 0), blocks: countOf(bot, 'gold_block') })
        continue
      }
      // Отложенные есть — подождать, пока пиглины разойдутся (или раздать слитки).
      const waiting = [...st.gold.keys()].some(k => (st.skip.get(k) || 0) >= gameClock.now())
      if (waiting && idle < 3) {
        idle++
        if (!countOf(bot, 'gold_ingot') && countOf(bot, 'gold_block')) await unpackGold(session, ctl, 9)
        await sleep(3000)
        continue
      }
      // Точка обзора: ближайшая непосещённая; восемь — и хватит искать.
      const me = bot.entity.position
      // Граница обхода: видимый кирпич бастиона вдали от того, где уже стоял
      st.been.push(me.clone())
      const bricks = [...st.bricks.values()]
      const minY = bricks.length ? Math.min(...bricks.map(b => b.y)) : me.y
      let next = null
      let best = Infinity
      for (const b of bricks) {
        if (st.been.some(v => v.distanceTo(b) < 12)) continue
        if (st.visited.has(keyOf(b))) continue
        const score = b.distanceTo(me) + 1.5 * (b.y - minY)
        if (score < best) { best = score; next = b }
      }
      if (!next) next = points.filter(q => !st.visited.has(keyOf(q))).sort((a, c) => Math.hypot(a.x - me.x, a.z - me.z) - Math.hypot(c.x - me.x, c.z - me.z))[0] || null
      if (!next || vantage >= 16) { goldPhaseEnd = gameClock.now(); if (mode === 'gold') break; continue }
      st.visited.add(keyOf(next))
      vantage++
      idle = 0
      // Сквозь стены бастиона — можно (чернокамень; охраняемое pathfinder не
      // ломает, лава под шагом — прыжок к полу).
      const w = await walkGoal(session, ctl, new goals.GoalNear(next.x, next.y + 1, next.z, 3), 20000, { dig: true })
      log('обзор', { to: xyz(next), ok: w && w.ok, at: xyz(bot.entity.position.floored()), gold: st.gold.size, chests: st.chestSeen.size, bricks: st.bricks.size })
      // S1f: не дошёл — соседние кирпичи той же стены (8 бл.) тоже недоступны отсюда: не тратить на них точки обзора (s1f-D1-1:
      // 13 точек подряд у x 82–86 «ok:false» с одного места, бюджет обзора ушёл). ND_VANTAGE_SKIP=0 — прежнее.
      if (!(w && w.ok) && process.env.ND_VANTAGE_SKIP !== '0') for (const b of st.bricks.values()) if (b.distanceTo(next) <= 8) st.visited.add(keyOf(b))
    }
    // Добыча бартера, что легла дальше руки (за уступом, в яме) — собрать с копкой.
    if (!st.sealedState) await pickUp(bot, ctl, 10, 20000)
    const tossed = await dropJunk(bot)
    if (tossed.length) st.tossed.push(...tossed)
  } finally {
    try { bot.setControlState('sneak', false) } catch {}
    bot._client.removeListener('damage_event', onDmg)
    bot.removeListener('health', onHp)
    bot._ndToolFilter = toolFilter0
    if (st.lavaStrict0 !== undefined) bot._ndLavaStrict = st.lavaStrict0
    // Свои клетки бастиона (штрек к золоту и сундукам, яма) — в общую память штреков (и на диск): обратный путь
    // к порталу идёт по ним, а не вскрытием двора (разбор Codex 30.09: 2 смерти на обратном штреке у бастиона).
    try { if (st.sealedState && st.sealedState.own) require('.././tunnel').rememberOwn(session, st.sealedState.own) } catch {}
    try { memoSave() } catch {}
  }
  const leftGold = [...st.gold.keys()].length
  // Золото по памяти (карта копии мира), до которого не нашлось пути, — не «кончилось»: neF-Pa25-1 02.10 — 4 блока,
  // «штрек: пути нет» к 26 целям, и кампания пометила бастион выработанным при 24 известных.
  const memLeft = [...st.pred.values()].filter(v => v.piece === 'память').length
  const tplLeft = [...st.pred.entries()].filter(([k, v]) => v.piece !== 'память' && v.piece !== 'видно' && !(st.sealedState && st.sealedState.own && st.sealedState.own.has(k))).length
  let stopped = null
  if (ctl.aborted) stopped = 'прервано'
  else if (st.notRecognized) stopped = 'бастион не узнан — доступных целей после обзора нет'
  else if (done()) stopped = null
  else if (spare() <= 0 && leftGold === 0 && memLeft > 0) stopped = `золото по памяти осталось (${memLeft}), пути к нему нет${st.lastBarter ? `; бартер: ${st.lastBarter}` : ''}`
  // S1f: цели шаблона (predictGold: тип и поворот бастиона узнаны) остались — не «кончилось» (вслепую кампания по этой фразе
  // помечала бастион выработанным после первого пакета: s1f-B0-1, 18 слитков при 54 целях шаблона).
  else if (spare() <= 0 && leftGold === 0 && tplLeft > 0 && process.env.ND_BATCH_PHASE !== '0') stopped = `золото по шаблону осталось (${tplLeft}), заход кончился${st.lastBarter ? `; бартер: ${st.lastBarter}` : ''}`
  else if (spare() <= 0 && leftGold === 0) stopped = `золото кончилось: видимых блоков больше нет${st.lastBarter ? `; бартер: ${st.lastBarter}` : ''}`
  else if (gameClock.now() >= deadline - 20000) stopped = 'время вышло — позови ещё раз, продолжу'
  else if (st.lastBarter) stopped = `бартер встал: ${st.lastBarter}`
  return out(stopped)
}

module.exports = { approachGold, targetsByBruteHome, bruteHomeTake, pitAngerWait, bruteWalkRisk, nearBruteHome, pitsAwayFromBrutes, goldWindowOk, bruteDefense, FAST_SAFE, goldExposes, hunker, burrowColumn, burrow, answerAttack, digToPredicted, digToPredictedBody, sealedGold, digTrap, buildTrap, sealBody, prepareBarterCover, digPit, moveBarterSite, bastion }
