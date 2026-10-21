'use strict'
// Штрек к золоту бастиона (sealedGold) — у цели: что под рукой (сундук, не золото), можно ли ломать (окно 1×1, кто видит),
// ломка, подбор и заделка. Порядок — SG_STEPS в bastion/sealed-gold.ts.
import { foesNear } from '../tower-scan'
import * as goldEvidence from '../gold-evidence'
import * as HF from '../hyp-focus'
import { log, sleep, mobs, seesMob, gameClock, angerSet, countOf, fullCover, isBaby, raySees, pickUp } from '../take-gold-block'
import * as miningCycle from '../mining-cycle'
import { goldWindowOk } from '../brute-risk'
import { goldExposes, hunker, sealBody } from '../defense'
import { type SealedRun, type SealTick, type Turn, routeRetryAt } from './state'

export async function sgArrive (sg: SealedRun, tk: SealTick): Promise<Turn> {
  const f = tk.feet()
  tk.hit = tk.tgGoals.find(q => q.g(f.x, f.y, f.z))
  if (!tk.hit) return 'next'
  tk.t = tk.hit.t
}

export async function sgChest (sg: SealedRun, tk: SealTick): Promise<Turn> {
  const { session, ctl, st } = sg
  if (tk.t.chest) {
    const guarded = process.env.ND_SEALED_FLUID_GUARD === '1'
    if (guarded) {
      const eyes: typeof import('../../perception/eyes') = require('../../perception/eyes')
      const seen = eyes.seesNow(sg.bot, tk.t.pos)
      const chest = seen ? sg.bot.blockAt(tk.t.pos, false) : null
      if (!chest || !/^(chest|trapped_chest|barrel)$/.test(chest.name)) {
        if (seen) { HF.judgeChest(sg.bot, st, st.chestSeen.get(tk.t.k), chest?.name || 'air'); st.chestSeen.delete(tk.t.k) }
        else st.skip.set(tk.t.k, routeRetryAt(60000))
        log('штрек: сундук не подтверждён — крышу не вскрываю', { at: tk.t.k, block: chest?.name || 'не виден' })
        return 'next'
      }
    }
    // Сундук из штрека: нас не видит никто — открыть не злит (ChestBlock: злит видящих).
    let took = null
    try { took = await (require('../../structures') as typeof import('../../structures')).takeWorth(session, ctl, tk.t.pos, { kind: 'bastion', ...(guarded ? { visibleOnly: true, stay: true } : {}) }) } catch (e) { took = { error: e.message } }
    if (miningCycle.confirmedChestLoot(took, tk.t.pos, ctl.aborted)) st.looted.add(tk.t.k)
    else st.skip.set(tk.t.k, routeRetryAt(60000))
    st.chests.push({ at: tk.t.k, took: (took && took.took) || {}, stopped: took && (took.stopped || took.error) })
    log('штрек: сундук', { at: tk.t.k, took: took && took.took, stopped: took && (took.stopped || took.error) })
    return 'next'
  }
}

export async function sgMissing (sg: SealedRun, tk: SealTick): Promise<Turn> {
  const { bot, st, S } = sg
  const b = bot.blockAt(tk.t.pos)
  // Штрек прошёл сквозь цель (золото взято по пути) — не промах.
  if (b && b.boundingBox === 'empty' && S.own.has(tk.t.k)) { st.pred.delete(tk.t.k); return 'next' }
  if (!b || b.name !== 'gold_block') {
    // Стоим вплотную и видим: не золото — промах гипотезы этого ранга.
    const rank = (st.pred.get(tk.t.k) || {}).rank
    if (goldEvidence.on() && b && b.boundingBox === 'block' &&
        (require('../../perception/eyes') as typeof import('../../perception/eyes')).seesNow(bot, tk.t.pos)) goldEvidence.observedGold(st, tk.t.k, b.name)
    if (b && (require('../../perception/eyes') as typeof import('../../perception/eyes')).seesNow(bot, tk.t.pos)) HF.judgeGold(bot, st, st.pred.get(tk.t.k), b.name)
    st.pred.delete(tk.t.k)
    st.predWrong = (st.predWrong || 0) + 1
    if (!goldEvidence.on() && b && b.boundingBox === 'block') {
      st.rankMiss = st.rankMiss || {}
      st.rankMiss[rank] = (st.rankMiss[rank] || 0) + 1
      if (st.rankMiss[rank] >= 2) for (const [k, v] of [...st.pred.entries()]) if (v.rank === rank || (rank >= 100 && rank % 100 === 0 && Math.floor((v.rank || 0) / 100) === rank / 100)) st.pred.delete(k)
    }
    log('штрек: не золото', { at: tk.t.k, block: b ? b.name : '?', rank })
    return 'next'
  }
}

export async function sgWindow (sg: SealedRun, tk: SealTick): Promise<Turn> {
  const { bot, st, S, SL } = sg
  // Ломка золота на глазах у пиглина злит всех в 16 бл. (PiglinAi.angerNearbyPiglins с проверкой луча) — штрек открыт
  tk.opens = goldExposes(bot, S, tk.t.pos)
  // Ломка gold_block: requireLineOfSight=false. До изоляции мобов не вскрываем двор,
  const upC = tk.t.pos.offset(0, 1, 0); const dnC = tk.t.pos.offset(0, -1, 0)
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
  const gC = tk.t.pos.offset(0.5, 0, 0.5)
  const strongG = [...mobs(bot, 'piglin_brute', 8, gC), ...mobs(bot, 'hoglin', 8, gC), ...mobs(bot, 'zoglin', 8, gC)].length
  const onTop = (Object.values(bot.entities) as any[]).some((e : any) => e && e !== bot.entity && e.position && /^(hostile|animal|mob|passive|water_creature|ambient)$/.test(e.type || '') &&
    Math.hypot(e.position.x - gC.x, e.position.z - gC.z) < 1.3 && e.position.y >= tk.t.pos.y + 0.5 && e.position.y <= tk.t.pos.y + 2.5)
  let windowOk = goldWindowOk({ win1, dropSafe, strong: strongNear.length, strongG, onTop, hp: bot.health ?? 20 })
  // Дыра от ломки безопасна, только если она — ЕДИНСТВЕННЫЙ выход хода во двор (S1d s1d-AB-4 A: заплатка прошлого золота не
  // встала, ход открыт; следующее золото «окном» — злые пиглины вошли в пролом, 5 ударов, смерть на 12-й мин). Ход открыт —
  // сперва заложиться (sealBody); не вышло — как прежде, пропуск.
  if (windowOk && tk.opens && SL.exposure(bot, S.own).length) {
    await sealBody(bot, S).catch(() => null)
    S.exposed = SL.exposure(bot, S.own).length > 0
    if (S.exposed) { windowOk = false; log('штрек: ход открыт — окно не ломаю', { at: tk.t.k }) }
  }
  // Пиглин, разглядывающий золото (слиток в левой руке), не «бездельник»: angerNearbyPiglins злит только PiglinAi.isIdle
  // (Brain.isActive(Activity.IDLE), javap 1.21.11 PiglinAi.angerNearbyPiglins: filter isIdle → filter canSee при ломке
  // сундука; золотой блок — без луча). Такие пиглины ломке не мешают.
  const admiring = e => /^(gold_ingot|gold_block|golden_.*)$/.test(e.equipment?.[1]?.name || '')
  const exposedFoes = st.fastSafe && tk.opens && !windowOk ? [
    ...mobs(bot, 'piglin', 18).filter(e => !isBaby(bot, e) && !admiring(e)),
    ...mobs(bot, 'piglin_brute', 18), ...mobs(bot, 'hoglin', 18), ...mobs(bot, 'zoglin', 18)
  ] : []
  if (st.fastSafe && tk.opens && windowOk) log('штрек: золото окном 1×1 — ломаю и сразу заделываю', { at: tk.t.k, piglins: mobs(bot, 'piglin', 18).length })
  if (exposedFoes.length || (st.fastSafe && tk.opens && SL.fillerCount(bot) < 3)) {
    // Пиглины бродят: отложить на 2 мин, а не на 10 (s1c-A-2 06.10: 9 из 22 блоков карты «пропустил» при 2–4 пиглинах рядом,
    // к концу захода «золото по памяти осталось (16), пути нет»). Блоков на заделку нет — по-прежнему надолго.
    st.skip.set(tk.t.k, exposedFoes.length ? gameClock.now() + (SL.fillerCount(bot) >= 3 ? 120000 : 600000) : routeRetryAt(600000))
    log('штрек: небезопасное вскрытие — пропустил', { at: tk.t.k, foes: exposedFoes.length, win1, dropSafe, strongG, onTop, up: bot.blockAt(upC)?.name, dn: bot.blockAt(dnC)?.name, strong: strongNear.length, hp: Math.round(bot.health ?? 0), filler: SL.fillerCount(bot) })
    return 'next'
  }
  // Свой ход сам открыт во двор (вход «из открытого со вскрытием», заплатка не встала), а ломка злит всех пиглинов в 16 — сперва
  // заложиться, иначе отложить. S1d включил по умолчанию по одной смерти (s1d-AB-4 A) без парного A/B — S1e (проверка S1d (д)) вернул
  // как было: только ND_ANGER_SAFE=1, до A/B на снимках.
  if (process.env.ND_ANGER_SAFE === '1' && SL.exposure(bot, S.own).length && angerSet(bot, null, true).length) {
    await sealBody(bot, S).catch(() => null)
    S.exposed = SL.exposure(bot, S.own).length > 0
    if (S.exposed) {
      st.skip.set(tk.t.k, routeRetryAt(60000))
      log('штрек: ход открыт, пиглины в 16 — золото отложил', { at: tk.t.k, n: angerSet(bot, null, true).length })
      return 'next'
    }
  }
  const watchers = st.fastSafe ? [] : mobs(bot, 'piglin', 16).filter(p => seesMob(bot, p))
  if (watchers.length) { st.skip.set(tk.t.k, gameClock.now() + 20000); log('штрек: золото — видят пиглины, отложил', { at: tk.t.k, n: watchers.length, exposed: S.exposed }); await sleep(500); return 'next' }
  // Ломка вскроет штрек во двор, а брут рядом (сквозь стены он не видит — но пролом увидит): отложить (neF-Pa22-1).
  const brutes = mobs(bot, 'piglin_brute', 16).filter((e : any) => raySees(bot, e.position.offset(0, (e.height || 1.95) * 0.92, 0), tk.t.pos.offset(0.5, 0.5, 0.5)))
  if (brutes.length && goldExposes(bot, S, tk.t.pos)) { st.skip.set(tk.t.k, gameClock.now() + 30000); log('штрек: золото у двора, брут рядом — отложил', { at: tk.t.k, n: brutes.length, d: Math.round(Math.min(...brutes.map((e : any) => e.position.distanceTo(tk.t.pos)))) }); await sleep(500); return 'next' }
}

export async function sgTake (sg: SealedRun, tk: SealTick): Promise<Turn> {
  const { bot, session, ctl, st, S, SL, dimension } = sg
  const had = countOf(bot, 'gold_block')
  const observed = goldEvidence.on() && bot.blockAt(tk.t.pos)?.name === 'gold_block' &&
    (require('../../perception/eyes') as typeof import('../../perception/eyes')).seesNow(bot, tk.t.pos)
  const Drops: typeof import('../../drops') = require('../../drops')
  const pickupMark = st.fastSafe ? Drops.pickupMark(bot) : null
  bot.setControlState('sneak', true)
  let dr
  try { dr = await SL.digCell(bot, tk.t.pos, { allowGuard: true }) } finally { bot.setControlState('sneak', false) }
  if (dr !== 'ok') { st.skip.set(tk.t.k, routeRetryAt(60000)); log('штрек: золото не ломается', { at: tk.t.k, r: dr }); return 'next' }
  S.own.add(tk.t.k)
  if (observed) goldEvidence.observedGold(st, tk.t.k, 'gold_block')
  st.pred.delete(tk.t.k)
  st.blocks++
  st.lastBreak = bot._ndGoldBreakAt = gameClock.now()
  // Гипотеза подтверждена (3 золота на местах шаблона) — соседние гипотезы
  // других рангов (та же стена со сдвигом на блок) снять.
  const rk = tk.hit.rank ?? 0
  st.rankHit = st.rankHit || {}
  if (!goldEvidence.on()) st.rankHit[rk] = (st.rankHit[rk] || 0) + 1
  if (!goldEvidence.on() && st.rankHit[rk] >= 3) {
    const mine = [...(st.predAll || [])].filter(q => q.rank === rk)
    for (const [k, v] of [...st.pred.entries()]) if (v.rank !== rk && mine.some(q => q.pos.distanceTo(v.pos) <= 2.5)) st.pred.delete(k)
  }
  // Тот же сторож — и для повторного подбора после заплатки (угроза, тело не в воздухе или без опоры — не подбирать).
  let pickupSafe = () => false
  if (st.fastSafe) {
    const Pack: typeof import('../../pack') = require('../../pack')
    const safePickup = () => {
      if (ctl.aborted || session.bot !== bot || !bot.entity || (bot.health ?? 0) <= 0 ||
        bot.game?.dimension !== dimension || bot._ndGuard?.ended || session.reflex) return false
      const body = SL.bodyCells(bot)
      if (body.some(cell => SL.classOf(bot.blockAt(cell)) !== SL.AIR) ||
        !fullCover(bot.blockAt(body[0].offset(0, -1, 0)))) return false
      // Злые пиглины — не повод бросать слиток у тела: ломка золота злит всех в 16 (PiglinAi.angerNearbyPiglins), и подбор обрывался
      // сразу после ломки (c92-int10-s21: 12 «не подтверждён», 0 из 15 блоков; сцена nbp96 — окно y49 при пиглинах рядом, гнездо y35 без
      // них — 8 из 9). Подбор — без шага, дыра 1×1 под заплатку: мечник через клетку не достаёт. Злой пиглин вплотную (≤ 2.5) и бруты/
      // хоглины в 6 — по-прежнему стоп.
      const me = bot.entity.position
      return !(require('../../ne-guard') as typeof import('../../ne-guard')).hot(bot, { near: 6 }) &&
        !foesNear(bot, 6).some((e: any) => e.name !== 'piglin' || e.position.distanceTo(me) <= 2.5)
    }
    pickupSafe = safePickup
    const match = (_entity, stack) => stack?.name === 'gold_block'
    const candidates = Drops.lying(bot, { from: tk.t.pos, radius: 3, match })
    const me0 = bot.entity.position
    const near0 = candidates.map(it => Math.round(Math.hypot(it.rest.x - me0.x, it.rest.z - me0.z) * 10) / 10)
    const receipt: any = { at: tk.t.k, picked: 0, received: 0, gained: 0, why: '', free: bot.inventory?.emptySlotCount?.(), stacks: candidates.length, d: near0.slice(0, 3),
      inFrame: candidates.filter(it => Drops.inPickup(me0, it.rest)).length }
    if (!safePickup()) receipt.why = 'подбор отложен: угроза или текущая клетка без подтверждённого воздуха и опоры'
    else if (!candidates.some(it => Drops.inPickup(bot.entity.position, it.rest))) receipt.why = 'подбор: нет подтверждённой стопки в рамке тела'
    else {
      receipt.picked = await Drops.collect(bot, ctl, { from: tk.t.pos, radius: 3, match, appearMs: 0,
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
      bot.game?.dimension !== dimension || bot._ndGuard?.ended || session.reflex) return 'stop'
  }
  if (st.fastSafe && tk.opens) {
    const closed = await SL.fillCell(bot, tk.t.pos)
    if (!closed || !fullCover(bot.blockAt(tk.t.pos))) {
      await hunker(session, ctl, st, 'золото: заплатка не встала')
      S.fails.push('золото: заплатка не встала'); return 'stop'
    }
    S.own.delete(tk.t.k); S.fills++; (S.filled || (S.filled = new Set())).add(tk.t.k)
    S.exposed = SL.exposure(bot, S.own).length > 0
    // Слиток не взят до заплатки — заплатка выталкивает предмет из клетки в ближайшую свободную (Entity.moveTowardsClosestSpace), часто
    // в наш штрек: подобрать ещё раз (c92-int10-s21: 15 блоков сломано, 12 «подбор не подтверждён», в рюкзаке 0).
    const goldMatch = (_e, stack) => stack?.name === 'gold_block'
    if (countOf(bot, 'gold_block') <= had && !ctl.aborted && pickupSafe() && Drops.lying(bot, { from: tk.t.pos, radius: 3, match: goldMatch }).length) {
      const again = await Drops.collect(bot, ctl, { from: tk.t.pos, radius: 3, match: goldMatch, appearMs: 0, timeoutMs: 1500, allowMovement: false, canContinue: pickupSafe }).catch(() => 0)
      log('штрек: подбор после заплатки', { at: tk.t.k, picked: again, gained: Math.max(0, countOf(bot, 'gold_block') - had) })
    }
  }
  if (!st.fastSafe) {
    for (let i = 0; i < 15 && countOf(bot, 'gold_block') <= had; i++) await sleep(100)
    if (countOf(bot, 'gold_block') <= had) await pickUp(bot, ctl, 3, 2500)
  }
  // Золото касалось чужого воздуха — закрыть его клетку.
  if (SL.exposure(bot, S.own).length) {
    if (await SL.fillCell(bot, tk.t.pos)) { S.own.delete(tk.t.k); S.fills++; (S.filled || (S.filled = new Set())).add(tk.t.k) }
    S.exposed = SL.exposure(bot, S.own).length > 0
  }
  log('штрек: золото', { at: tk.t.k, blocks: countOf(bot, 'gold_block'), left: st.pred.size, hp: Math.round(bot.health ?? 0), exposed: S.exposed })
}
