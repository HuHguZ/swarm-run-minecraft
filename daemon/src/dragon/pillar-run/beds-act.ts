'use strict'
// Бой с драконом (dragon/pillar-run.ts): кровати в деле: поставить и подорвать.
const { gameClock, Vec3, dbg, sleep, stepTo, dragonOf, phaseOf, PHASE, items, build, SITTING, partsOf, clearControls, PHASE_RU, hpOf, makeTrack, sitFix }: typeof import('../dig-down-to') = require('../dig-down-to')
const { doing, r1 }: typeof import('../fall-guard') = require('../fall-guard')
const { clickBedAt }: typeof import('../pillar-plan') = require('../pillar-plan')
const { turnSafe, clearOfDragon, DAMAGE_TYPES }: typeof import('../ts-plan') = require('../ts-plan')
import { sitRec, blindKnown, sitAcc, noteSitDamage } from './sight-zones'
import { walkTo } from './walk'

async function bedsGo (session, ctl, plan, brave, parts = null) {
  const bot = session.bot
  if (plan.lift) {
    // Свой блок у B: дойти до земли под ним и встать на блок (прыжок с блоком под себя).
    const low = { ...plan, lift: 0, feet: plan.feet.offset(0, -1, 0), y: plan.y - 1 }
    const me0 = bot.entity.position
    if (!(Math.hypot(me0.x - plan.feet.x, me0.z - plan.feet.z) < 0.5 && Math.abs(me0.y - plan.y) < 0.3)) {
      const g = await bedsGo(session, ctl, low, brave, parts)
      if (!g.ok) return g
      doing(ctl, 'beds:stand')
      await build.towerUp(bot, ctl, 1).catch(() => {})
      clearControls(bot)
    }
    const p = bot.entity.position
    if (Math.abs(p.y - plan.y) > 0.3 || Math.hypot(p.x - plan.feet.x, p.z - plan.feet.z) > 0.6) return { ok: false, why: 'на свой блок не встал' }
    return { ok: true }
  }
  const me = bot.entity.position
  const off = Math.hypot(me.x - plan.feet.x, me.z - plan.feet.z)
  if (off < 0.2 && Math.abs(me.y - plan.feet.y) < 0.3) return { ok: true }
  doing(ctl, 'beds:walk')
  // Видящий начал новый круг «высматривает» — голова пойдёт к нам: остановиться
  // (b2-22, попытка 2, 100.8–101.3 с: шёл к месту — удар головой).
  const scanStop = () => { const dd = dragonOf(bot); return !!dd && phaseOf(bot, dd) === PHASE.SCANNING && !blindKnown(sitRec) && !turnSafe(dd, bot.entity.position) }
  const near = off < 8 && Math.abs(me.y - plan.feet.y) < 1.2 && clearOfDragon(bot, me, plan.feet, parts)
  let r: any = near ? await stepTo(bot, ctl, plan.feet, { ms: 3000, sprint: off > 3, stopAt: 0.15, clouds: true, stop: scanStop }) : { ok: false }
  if (scanStop()) return { ok: false, why: 'высматривает — голова пойдёт к нам' }
  if (!r.ok) {
    const g = new Vec3(plan.B.x + 0.5, plan.y, plan.B.z + 0.5)
    r = await walkTo(session, ctl, g, { range: 0.3, timeoutMs: 8000, hazards: true, stopIf: () => scanStop() ? 'высматривает — голова пойдёт к нам' : null })
    if (Math.hypot(bot.entity.position.x - g.x, bot.entity.position.z - g.z) > 0.7) return { ok: false, why: r.why || 'не дошёл' }
    await stepTo(bot, ctl, plan.feet, { ms: 900, sprint: false, stopAt: 0.12, clouds: false })
  }
  clearControls(bot)
  const p = bot.entity.position
  if (Math.hypot(p.x - plan.feet.x, p.z - plan.feet.z) > 0.5 || Math.abs(p.y - plan.y) > 0.3) {
    // Чуть не дошёл/проскочил — ещё шаг клавишами.
    await stepTo(bot, ctl, plan.feet, { ms: 700, sprint: false, stopAt: 0.12, clouds: false })
    clearControls(bot)
    const q = bot.entity.position
    if (Math.hypot(q.x - plan.feet.x, q.z - plan.feet.z) > 0.5 || Math.abs(q.y - plan.y) > 0.3) return { ok: false, why: 'не на месте' }
  }
  return { ok: true }
}

async function bedsBoom (session, ctl, stats, plan, hit, why, opts: any = {}) {
  const bot = session.bot
  const d = dragonOf(bot)
  const wpn = items.bestWeapon(bot)
  if (!opts.keepHand && wpn && (!bot.heldItem || /_bed$|glowstone|respawn_anchor/.test(bot.heldItem.name))) await bot.equip(wpn, 'hand').catch(() => {})
  if (opts.phCheck && d && !opts.phCheck(phaseOf(bot, d))) return { ok: false, why: 'фаза уже не та' }
  const ph = d ? phaseOf(bot, d) : null
  const before = d ? hpOf(bot, d) : null
  const me0 = bot.health
  let boomAt = 0
  const onDmg = pk => { if (d && pk && pk.entityId === d.id && DAMAGE_TYPES[pk.sourceTypeId] === 'bad_respawn_point' && !boomAt) boomAt = gameClock.now() }
  bot._client.on('damage_event', onDmg)
  // Свидетель клиента (02.10, rs1: 14 из 25 ставок+щелчков R без взрыва и без причины в трассе): что сервер прислал по клеткам
  // кровати (ставка встала? снесена?), взрыв, телепорт; рука, крадучись, тело дракона против клетки F (коробка 16×8 мешает ставке).
  const wit: any = { blk: [] }; const tw0 = gameClock.now()
  const watch = opts.prePlace || hit.runnerGuard ? new Set([`${plan.H.x},${plan.y},${plan.H.z}`, ...(opts.prePlace ? [`${opts.prePlace.pos.x + opts.prePlace.face.x},${plan.y},${opts.prePlace.pos.z + opts.prePlace.face.z}`] : [])]) : null
  const onBlk = (o, n) => { if (watch && n && watch.has(`${n.position.x},${n.position.y},${n.position.z}`) && wit.blk.length < 8) wit.blk.push([gameClock.now() - tw0, n.position.x, n.position.z, n.name]) }
  const onExp = pk => { if (!wit.exp) wit.exp = gameClock.now() - tw0 }
  const onTp = () => { wit.tp = (wit.tp || 0) + 1 }
  if (watch) { bot.on('blockUpdate', onBlk); bot._client.on('explosion', onExp); bot._client.on('position', onTp) }
  const unwatch = () => { if (watch) { bot.removeListener('blockUpdate', onBlk); bot._client.removeListener('explosion', onExp); bot._client.removeListener('position', onTp) } }
  if (watch) {
    const hi = bot.heldItem; const q0 = bot.entity.position
    wit.hand = hi ? `${hi.name}x${hi.count}` : null; wit.sneak = !!bot.getControlState('sneak'); wit.g = !!bot.entity.onGround
    wit.me = [r1(q0.x), r1(q0.y), r1(q0.z)]
    if (d) { wit.body = [r1(d.position.x), r1(d.position.y), r1(d.position.z)]; wit.inBox = Math.abs(d.position.x - 0.5) < 8.5 && Math.abs(d.position.z - 0.5) < 8.5 && d.position.y < plan.y + 0.5625 && d.position.y + 8 > plan.y }
  }
  doing(ctl, `beds:click:${why}`)
  if (ctl.trace) ctl.trace.ev('bed', { ph, why, dist: plan.dist, expect: plan.expect, dragonHp: before, me: me0, D: [plan.D.x, plan.D.z], y: plan.y, at: [plan.H.x, plan.y, plan.H.z], ...(opts.note || {}) })
  let tc = gameClock.now()
  let tcWall = gameClock.wall.now()
  const failW = (w) => { unwatch(); if (watch && ctl.trace) { const dc = dragonOf(bot); if (dc) wit.body2 = [r1(dc.position.x), r1(dc.position.y), r1(dc.position.z)]; ctl.trace.ev('bedFail', { why: w, ...wit, ...(opts.note || {}) }) } return { ok: false, why: w } }
  // Подтверждение щелчка сервером (750 TPS, s5 06.10): окно 700 игровых мс — 19 мс реального времени, damage_event и хп
  // приходили позже — взорванная кровать считалась «ставка не прошла», урон 0. Ждать ack своего номера (clickBedAt).
  let seqWant = null; let acked = false
  const onAck = pk => { if (seqWant != null && pk && pk.sequenceId >= seqWant) acked = true }
  bot._client.on('acknowledge_player_digging', onAck)
  try { const sent = await clickBedAt(bot, hit, { aimed: !!opts.aimed, until: opts.until || 0, untilMono: opts.untilMono ?? null, prePlace: opts.prePlace || null }); if (sent === false) { bot._client.removeListener('damage_event', onDmg); bot._client.removeListener('acknowledge_player_digging', onAck); return failW('R: поздняя проверка безопасности' + (hit.guardWhy ? ': ' + hit.guardWhy : '')) } if (typeof sent === 'number') seqWant = sent; tc = gameClock.now(); tcWall = gameClock.wall.now(); wit.sentMs = tc - tw0 } catch (e) { dbg('beds click', e.message) }
  // В тик щелчка (01.10): голова по клиенту — расстояние от центра взрыва (клетка подушки H) и фаза.
  let atClick = null
  try {
    const dc = dragonOf(bot)
    if (dc && plan.H) {
      const pc = partsOf(bot, dc, makeTrack(bot))
      const C = plan.centre || new Vec3(plan.H.x + 0.5, plan.y + 0.5, plan.H.z + 0.5)
      atClick = { headNow: r1(pc.headC.distanceTo(C)), phNow: PHASE_RU[phaseOf(bot, dc)] ?? phaseOf(bot, dc) }
    }
  } catch {}
  if (opts.afterClick) { try { await opts.afterClick() } catch (e) { dbg('afterClick', e.message) } }
  const w0 = gameClock.wall.monotonic()
  while (seqWant != null ? !acked && (gameClock.now() - tc < 700 || gameClock.wall.monotonic() - w0 < 1500) : !boomAt && gameClock.now() - tc < 700) await sleep(25)
  bot._client.removeListener('damage_event', onDmg)
  bot._client.removeListener('acknowledge_player_digging', onAck)
  wit.acked = acked
  if (!acked) await sleep(120)
  const nameAt = (bot.blockAt(new Vec3(plan.H.x, plan.y, plan.H.z)) || {}).name || ''
  const gone = plan.anchor ? nameAt !== 'respawn_anchor' : !/_bed$/.test(nameAt)
  if (!gone && !boomAt) return failW('щёлкнул — не взорвалась')
  // ставка+взрыв в одном тике (ND_PLACE_CLICK): кровать не встала — урона нет и кровать в рюкзаке, это не трата (fs1: 6
  // «нулевых» bedDone, B/s16 и s28 насчитали 7 кроватей при 6 взрывах)
  if (opts.prePlace && !boomAt) return failW('ставка не прошла')
  unwatch()
  stats.lastBoom = boomAt || tc
  const dd = dragonOf(bot)
  const after = dd ? hpOf(bot, dd) : 0
  const dmg = before != null && after != null ? Math.max(0, before - after) : null
  // Толчок сидящему (скорость заморожена и копит толчки — взлёт с ними): для прогноза взлёта (T1).
  if (dd && SITTING.has(phaseOf(bot, dd)) && plan.centre) { const fx = sitFix.get(dd.id); if (fx && fx.pushes) fx.pushes.push({ centre: plan.centre.clone(), seen: plan.seen != null ? plan.seen : 1 }) }
  // Снижение (L): урон не в сидячий счёт — только запомнить хп.
  if (dd && opts.uncounted) { const h = hpOf(bot, dd); if (h != null) sitAcc.hp = h; sitAcc.sitting = false } else if (dd) noteSitDamage(bot, dd, phaseOf(bot, dd))
  stats.bedsUsed = (stats.bedsUsed || 0) + 1
  if (dmg) stats.dmg += dmg
  const rec = { ph: PHASE_RU[ph] ?? ph, why, dist: plan.dist, expect: plan.expect, dmg: dmg != null ? r1(dmg) : null, self: r1(Math.max(0, me0 - bot.health)), took: dd ? phaseOf(bot, dd) === PHASE.TAKEOFF : false, lagMs: boomAt ? boomAt - tc : null, sent: tc, sentWall: tcWall, tickRate: gameClock.snapshot()?.tickRate ?? 20, ...(opts.note || {}), ...(atClick || {}) }
  console.log(`[bed] ${why}: фаза ${rec.ph}${atClick ? '/' + atClick.phNow : ''}, голова ${atClick ? atClick.headNow : '?'} бл. (прогноз ${plan.dist}), урон ${rec.dmg} (ждали ${plan.expect}), нам ${rec.self}`)
  stats.beds.push(rec)
  if (ctl.trace) ctl.trace.ev('bedDone', rec)
  dbg('beds boom', JSON.stringify(rec))
  return { ok: true, ...rec }
}

export {
  bedsGo, bedsBoom
}
