'use strict'
// Бой с драконом (dragonFight) — путь и бой по порядку прежнего тела try: броня и вода, особые режимы (лаборатория,
// воскрешение, домой), жемчуг и мост к острову, путь к центру, кристаллы, бой и победа. Стадия возвращает отчёт
// (конец вызова) или ничего (дальше по стадиям).
import { gameClock, CENTER, clearControls, armor, findItem, supportCell, offIsland, cloudsOf, isSolid, Vec3, pearlHop, starer, envv, digUpThrough, envNum, padOverVoid, runnerOn, sleep } from '../dig-down-to'
import { clearCrystalKnowledge, bridgeToIsland, burrowTo, noteCrystalClear } from '../bridge-to-island'
import { r1, inClouds, doing, pickSpot } from '../fall-guard'
import { waterToHotbar } from '../station-plan'
import { dragonLab, respawnDragon, takeEgg, goHome, pearlApproach, blindPit, collectXp } from '../blind-pit'
import { evade, countOf } from '../evade-raw'
import { walkTo, destroyCrystals, makeDragonFeed, fightDragon } from '../pillar-run'
import { type DragonFight } from './state'

export async function dfGear (df: DragonFight) {
  const { bot, ctl, session, p } = df
  // Броня — с повтором (s5-e22-s3, 06.10: в начале боя автопилот ел — «ем — броню надену после», бой без брони, смерть
  // от эндермена по 7): занят рот/курсор или сервер не подтвердил — ещё раз, до 4 попыток.
  for (let i = 0; i < 4 && !ctl.aborted; i++) {
    const ar: any = await armor.equipBestArmor(session, ctl).catch(e => ({ stopped: e.message }))
    const again = ar && ((ar.stopped && ar.stopped !== 'прервано') || (ar.skipped || []).some(s => /не подтвердил/.test(s)))
    if (!again) break
    df.rep.armorRetry = (df.rep.armorRetry || 0) + 1
    await sleep(600)
  }
  // Вырезанная тыква на голове — эндермены не злятся на взгляд
  const pumpkin = findItem(bot, /^carved_pumpkin$/)
  const headNow = bot.inventory.slots[5]
  if (pumpkin && (p.pumpkin === true || (!headNow && p.pumpkin !== false))) {
    try { await bot.equip(pumpkin, 'head'); df.rep.pumpkin = true } catch (e) { df.rep.pumpkin = `не надел: ${e.message}` }
  }
  df.rep.waterReady = await waterToHotbar(bot)
}

export async function dfModes (df: DragonFight) {
  const { bot, ctl, session, p } = df
  if (df.mode === 'labPlan' || df.mode === 'labRun') {
    df.rep.lab = await dragonLab(session, ctl, df.stats, p, df.mode, df.deadline)
    return df.report(df.rep.lab && df.rep.lab.stop ? df.rep.lab.stop : null)
  }
  if (df.mode === 'respawn') {
    clearCrystalKnowledge(bot)
    df.rep.respawn = await respawnDragon(session, ctl, df.rep)
    if (df.rep.respawn.need) df.rep.need = df.rep.respawn.need
    return df.report(df.rep.respawn.started ? null : `не воскресил: ${df.rep.respawn.why || 'поставил ' + df.rep.respawn.placed + ' из 4'}`)
  }
  if (df.mode === 'home') {
    if (p.egg !== false) df.rep.egg = await takeEgg(session, ctl, df.rep)
    df.rep.home = await goHome(session, ctl, df.rep)
    return df.report(df.rep.home.home ? null : `домой не ушёл: ${df.rep.home.why || df.rep.home.walk || 'портал не сработал'}`)
  }
}

export async function dfIsland (df: DragonFight) {
  const { bot, ctl, session, p } = df
  // Жемчуг (2026-10-01): с платформы — броском к станции у столба вместо моста и пешего пути, если
  // выходит быстрее с ценой хп (pearl-hop.js). ND_PEARL=0 или p.pearl === false — выкл.
  df.pearlOn = (df.mode === 'beds' || df.mode === 'full' || df.mode === 'dragon') && p.pearl !== false && process.env.ND_PEARL !== '0'
  // Подход жемчугом и сводка по всем попыткам вызова (платформа, край острова после моста, на ходу к центру).
  df.pearlStep = async (where) => {
    const ph = await pearlApproach(session, ctl, df.stats)
    if (!ph) return null
    const was = df.rep.pearl
    df.rep.pearl = was ? { ...ph, hops: was.hops + ph.hops, pearls: was.pearls + ph.pearls, hpLost: r1(was.hpLost + ph.hpLost), misses: was.misses + ph.misses, secs: r1(was.secs + ph.secs), steps: [...(was.steps || []), ...(ph.steps || [])], where: [...(was.where || []), where] } : { ...ph, where: [where] }
    if (ph.hops) df.rep.timing.pearl = Math.round((gameClock.now() - df.started) / 100) / 10
    return ph
  }
  if (df.pearlOn) await df.pearlStep('платформа')
  if (ctl.aborted) return df.report()
  // Прибыть: с платформы или издалека — мост к острову, потом к центру.
  const sup = supportCell(bot)
  if (sup && bot.blockAt(sup).name !== 'end_stone' && offIsland(bot, sup)) {
    const b: any = await bridgeToIsland(session, ctl, df.rep)
    // Платформа внутри острова (сид с сушей у x = 100: «потолок end_stone», «впереди не
    if (b.stopped && !b.land) {
      // Отказ повторят через пару секунд — не стоять при этом в облаке на платформе.
      const c0 = inClouds(cloudsOf(bot), bot.entity.position, 1)
      if (c0) await evade(bot, ctl, df.stats, { kind: 'облако', c: c0 }).catch(() => {})
      return df.report(`мост не дошёл до острова: ${b.stopped}`)
    }
  }
  if (ctl.aborted) return df.report()
  // Жемчуг с края острова (мост дошёл; с платформы броска не было — далеко/обрыв): к станции броском.
  if (df.pearlOn && !(df.rep.pearl && df.rep.pearl.hops)) await df.pearlStep('край')
  if (ctl.aborted) return df.report()
}

// До центра: pathfinder, а не вышло — напролом (копать, мостить).
export async function dfToCenter (df: DragonFight) {
  const { bot, ctl, session } = df
  const m = bot.entity.position
  if (Math.hypot(m.x - CENTER.x, m.z - CENTER.z) <= 25) return null
  const sup0 = supportCell(bot)
  if (sup0 && !offIsland(bot, sup0) && Math.hypot(m.x - CENTER.x, m.z - CENTER.z) < 45) return null
  // На ходу (раз в 2 с): бросок к станции стал выгоден — встать и бросить (s23/s24 pp1: платформа под обрывом,
  // с неё не бросить, а пешком к центру 60–70 с).
  let pearlAt = 0
  const pearlStop = df.pearlOn && (ctl.pearlWalkStops || 0) < 3 ? () => {
    if (gameClock.now() - pearlAt < 2000 || !bot.entity.onGround) return null
    pearlAt = gameClock.now()
    const mm = bot.entity.position
    if (Math.hypot(mm.x - CENTER.x, mm.z - CENTER.z) < 35) return null
    const under = bot.blockAt(mm.floored().offset(0, -1, 0))
    if (!under || under.name !== 'end_stone') return null
    // 03.10 (ca1-s10): в своём прокопе под островом бросок «на ходу» трижды бился о потолок («не перенесло», −3.4 хп
    // каждый) — бросать только под открытым небом (над головой на 12 блоков нет твёрдого)
    for (let k = 2; k <= 12; k++) { const b = bot.blockAt(mm.floored().offset(0, k, 0)); if (b && isSolid(b)) return null }
    const goal = ctl.pearlGoal || new Vec3(CENTER.x + (mm.x - CENTER.x) * 8 / Math.hypot(mm.x - CENTER.x, mm.z - CENTER.z), mm.y, CENTER.z + (mm.z - CENTER.z) * 8 / Math.hypot(mm.x - CENTER.x, mm.z - CENTER.z))
    const hw = pearlHop.hopWorth(bot, goal, { reserve: Number(process.env.ND_PEARL_RESERVE ?? 1), hpMin: Number(process.env.ND_PEARL_HPMIN ?? 11), floorOk: (b) => b.name === 'end_stone', avoid: (f) => Math.hypot(f.x - CENTER.x, f.z - CENTER.z) < 4.5, lookOk: (y, pt) => !starer(bot, y, pt) })
    return hw.go ? 'жемчуг' : null
  } : null
  // 03.10 (пользователь видел тоннель на слоте 1, rs17-s8 22:05: платформа внутри острова — walkTo 30 с, потом burrowTo
  if (envv('ND_DIGUP') !== '0' && envv('ND_DIGUP_FIRST') !== '0' && !ctl.digUpFirst) {
    const f0 = bot.entity.position.floored()
    let ceil = false
    for (let k = 2; k <= 7 && !ceil; k++) { const b = bot.blockAt(f0.offset(0, k, 0)); if (b && b.name === 'end_stone') ceil = true }
    if (ceil) {
      ctl.digUpFirst = true
      doing(ctl, 'to-center:dig-up')
      const t0u = gameClock.now()
      const up: any = await digUpThrough(session, ctl)
      up.ms = gameClock.now() - t0u; up.first = true
      if (ctl.trace) ctl.trace.ev('digUp', up)
      // бросок сразу с верха шахты дважды «не перенесло» (cp1-s7, ca1-s5: −5…6 с) — жемчуг только «на ходу», под открытым небом
      if (ctl.aborted) return { walk: 'прервано', up }
      doing(ctl, 'to-center')
      return dfToCenter(df)
    }
  }
  // над пустотой (свой мост, платформа) — без копки: pathfinder рыл нависший остров с моста в блок шириной, тело в воздухе
  const runC = envv('ND_CENTER_RUN') !== '0'
  const supW = supportCell(bot); const overVoid = !!(supW && offIsland(bot, supW))
  const w = await walkTo(session, ctl, new Vec3(CENTER.x, m.y, CENTER.z), { range: 18, xz: true, timeoutMs: 30000, stopIf: pearlStop, noDig: overVoid, sprint: runC, digCost: runC ? envNum('ND_CENTER_DIGCOST', 4) : 1 })
  if (w.stopped && w.why === 'жемчуг') {
    ctl.pearlWalkStops = (ctl.pearlWalkStops || 0) + 1
    clearControls(bot)
    await df.pearlStep('на ходу')
    doing(ctl, 'to-center')
    return dfToCenter(df)
  }
  if (w.ok) return { walk: 'дошёл' }
  // 02.10 (rs6-s18, смерть): мост с платформы под нависшим островом («потолок end_stone»), pathfinder рыл остров с моста над
  const supV = supportCell(bot)
  // 02.10 (rs10-s7, rs11-s7, сид пула 9123766181046481267): платформа под нависшим островом — мост упирается в «потолок
  if (supV && offIsland(bot, supV) && envv('ND_DIGUP') !== '0') {
    const up = await digUpThrough(session, ctl)
    if (ctl.trace) ctl.trace.ev('digUp', up)
    // шахта поднялась хоть на 3 (rs13-s7: 5 блоков вверх, дальше столб не встал — второй вызов пошёл оттуда пешком и дошёл) — идти
    if (up.ok || up.up >= 3) {
      const w3 = await walkTo(session, ctl, new Vec3(CENTER.x, bot.entity.position.y, CENTER.z), { range: 18, xz: true, timeoutMs: 45000, stopIf: pearlStop, sprint: runC, digCost: runC ? envNum('ND_CENTER_DIGCOST', 4) : 1 })
      if (w3.ok) return { walk: 'дошёл через остров над платформой', up }
      const sv3 = supportCell(bot)
      if (!(sv3 && offIsland(bot, sv3))) return { walk: w3.why, burrow: await burrowTo(session, ctl, new Vec3(CENTER.x, bot.entity.position.y, CENTER.z), { near: 18 }), up }
    }
  }
  if (supV && offIsland(bot, supV)) {
    const pad = await padOverVoid(bot, supV)
    if (ctl.trace) ctl.trace.ev('voidPad', pad)
    if (!pad.ok) { ctl.voidStop = true; return { walk: w.why, burrow: { ok: false, why: 'над пустотой — площадку не сложить' } } }
    const w2 = await walkTo(session, ctl, new Vec3(CENTER.x, m.y, CENTER.z), { range: 18, xz: true, timeoutMs: 45000, stopIf: pearlStop, sprint: runC, digCost: runC ? envNum('ND_CENTER_DIGCOST', 4) : 1 })
    if (w2.ok) return { walk: 'дошёл с площадки', pad }
    const sv2 = supportCell(bot)
    if (sv2 && offIsland(bot, sv2)) { ctl.voidStop = true; return { walk: w2.why, burrow: { ok: false, why: 'над пустотой — напролом нельзя' } } }
  }
  const b = await burrowTo(session, ctl, new Vec3(CENTER.x, m.y, CENTER.z), { near: 18 })
  return { walk: w.why, burrow: b }
}

export async function dfCenter (df: DragonFight) {
  const { bot, ctl, session } = df
  if (df.mode === 'arrive') {
    df.rep.approach = await dfToCenter(df)
    const spot = pickSpot(bot, CENTER, { rMin: 8, rMax: 18 })
    if (spot) df.rep.walk = await walkTo(session, ctl, spot.feet, { range: 1.5, timeoutMs: 60000, stats: df.stats })
    const m = bot.entity.position
    df.rep.fromCenter = Math.round(Math.hypot(m.x - CENTER.x, m.z - CENTER.z))
    return df.report(df.rep.fromCenter > 25 ? `до центра острова не дошёл: ${df.rep.walk ? df.rep.walk.why : 'нет места'}` : null)
  }
  doing(ctl, 'to-center')
  if (df.mode === 'full' || df.mode === 'crystals' || df.mode === 'dragon' || df.mode === 'beds') df.rep.approach = await dfToCenter(df)
  if (ctl.voidStop) { const sv = supportCell(bot); if (sv && offIsland(bot, sv)) return df.report('до центра острова не дошёл: над пустотой, напролом нельзя') }
  {
    const m = bot.entity.position
    if (Math.hypot(m.x - CENTER.x, m.z - CENTER.z) < 30) df.rep.timing.center = Math.round((gameClock.now() - df.started) / 100) / 10
  }
  if (df.mode === 'full' || df.mode === 'crystals') {
    await destroyCrystals(session, ctl, df.rep, df.stats, { deadline: df.deadline })
    noteCrystalClear(bot, df.rep.crystals)
    if (!ctl.aborted && /end/.test(bot.game.dimension) && df.rep.crystals.left === 0) df.rep.timing.crystals = Math.round((gameClock.now() - df.started) / 1000)
    if (ctl.aborted) return df.report()
    if (df.mode === 'crystals') return df.report(df.rep.crystals.left ? `кристаллов осталось ${df.rep.crystals.left}` : null)
  }
}

export async function dfFight (df: DragonFight) {
  const { bot, ctl, session, p } = df
  if (df.mode === 'beds' && !ctl.feed) { ctl.feed = makeDragonFeed(bot) }
  // Станция у столба — по умолчанию, если в рюкзаке обсидиан (fightkit end: ≥ 4; станции нужно 2): ND_PILLAR=0 — выкл.,
  // ND_PILLAR=1 — вкл. и без него. С ней яма для слепого не нужна (pil4/pil5: ND_BEDS_BLIND=0).
  ctl.pillarMode = df.mode === 'beds' && (process.env.ND_PILLAR === '1' || (process.env.ND_PILLAR !== '0' && (runnerOn() || countOf(bot, /^(obsidian|crying_obsidian)$/) >= 2)))
  if (df.mode === 'beds' && process.env.ND_BEDS_BLIND !== '0' && !ctl.pillarMode) await blindPit(session, ctl, df.stats, df.deadline)
  await fightDragon(session, ctl, df.rep, df.stats, { deadline: df.deadline, perches: p.perches || 0 })
  if (ctl.aborted) return df.report()
  if (!df.rep.dragon.won) {
    return df.report(gameClock.now() >= df.deadline ? 'время вышло — позови mc_dragon ещё раз, продолжит с того места' : (df.rep.dragon.lost || 'дракон жив'))
  }
  // Победа: опыт, яйцо, домой.
  await sleep(3000)
  df.rep.xp = await collectXp(session, ctl, 8000)
  if (p.egg !== false) df.rep.egg = await takeEgg(session, ctl, df.rep)
  if (p.home !== false) df.rep.home = await goHome(session, ctl, df.rep)
  return df.report()
}
