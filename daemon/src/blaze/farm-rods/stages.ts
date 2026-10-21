'use strict'
// Стержни ифрита (farmRods) — стадии навыка по порядку прежнего тела try: где спавнер, путь к нему, подготовка,
// бой (лагерь, меч или holdSpawner), уход. Старый цикл (legacy) — farm-rods/legacy.ts.
import * as gameClock from '../../game-clock'
const Vec3: typeof import('vec3').Vec3 = require('vec3')
import { sleep, xyz } from '../../movement'
import { seesBlock } from '../../sight'
import * as worlds from '../../worlds'
import * as survival from '../../combat-safety'
import { SPAWNER_PLACE, clamp, log, nearestBlaze, visibleSpawner, liveBlazes, watchers, witherClose } from '../targets'
import { hasEffect, drinkFireResistance, frSpendOk } from '../potions'
import { collectRods, canApproachSpawner, walkNear } from '../approach'
import { seesMe } from '../radar'
import { pitFrom, digInNear } from '../post'
import { holdSpawner } from '../hold'
import { campSpawner } from '../camp'
import { type RodsFarm, SPAWNER_RANGE } from './state'

export async function rodsLocate (fr: RodsFarm) {
  const { bot, ctl, session, mcData, p } = fr
  // --- где спавнер: видно глазами, иначе память этого мира.
  const pitOut: any = {}
  if (witherClose(bot)) { fr.phase = 'яма от иссушителя'; await pitFrom(session, ctl, pitOut, witherClose(bot)) }
  fr.spawner = visibleSpawner(bot, mcData, 32)
  // Сразу после входа/телепорта чанки вокруг ещё грузятся: спавнер в трёх
  // блоках «не виден», и бой шёл к старой записи памяти за 1971 блок
  // (ферма 2026-09-29, blaze-mainkit-1). Подождать до 4 с.
  for (let k = 0; !fr.spawner && k < 8 && !ctl.aborted; k++) {
    if (witherClose(bot)) { fr.phase = 'яма от иссушителя'; await pitFrom(session, ctl, pitOut, witherClose(bot)) }
    await sleep(500); fr.spawner = visibleSpawner(bot, mcData, 32)
  }
  fr.spawnerFrom = fr.spawner ? 'вижу' : null
  const places = (session.journal.state && session.journal.state.places) || {}
  const rec = places[SPAWNER_PLACE]
  if (!fr.spawner && rec && worlds.worldOfRecord(rec) === fr.here) {
    fr.spawner = new Vec3(rec.x, rec.y, rec.z)
    fr.spawnerFrom = 'память'
    // Запись есть, а на месте уже не спавнер (сломан) — забыть, а не ждать
    // его 50 секунд (сцена (в): «спавнер молчит» у убранного спавнера).
    const b = bot.blockAt(fr.spawner)
    if (b && b.name !== 'spawner' && seesBlock(bot, b)) {
      session.journal.patch(s => { if (s.places) delete s.places[SPAWNER_PLACE] })
      fr.spawner = null
      fr.spawnerFrom = null
    }
  }
  // Ни спавнера, ни блейза рядом, а крепость найдена — дойти до неё и обойти
  // по видимому кирпичу, пока не увидим тронный зал (fortress.js tour).
  if (!fr.spawner && !nearestBlaze(bot, fr.radius, fr.dead) && fr.here === 'the_nether' && p.tour !== false) {
    const fortress: typeof import('../../fortress') = require('../../fortress')
    const known = fortress.placeOf(session, fortress.PLACE)
    if (known && worlds.worldOfRecord(known) === fr.here) {
      fr.phase = 'обход крепости'
      fr.toured = await fortress.tour(session, ctl, { deadline: Math.min(fr.deadline, gameClock.now() + 240000) })
      // Спавнера не нашёл, а блейзов видел — бить тех, что есть (крепость
      // спавнит их и без спавнера): дальше обычных 20 блоков.
      if (fr.toured.blazes && !p.radius) fr.radius = 32
      if (fr.toured.spawners && fr.toured.spawners.length) {
        const s = fr.toured.spawners[0]
        fr.spawner = new Vec3(s.x, s.y, s.z)
        fr.spawnerFrom = 'вижу'
      }
    }
  }
  if (fr.spawner && fr.spawnerFrom === 'вижу' && !(rec && rec.x === fr.spawner.x && rec.y === fr.spawner.y && rec.z === fr.spawner.z)) {
    session.journal.patch(s => {
      if (!s.places) s.places = {}
      s.places[SPAWNER_PLACE] = { ...xyz(fr.spawner), dimension: fr.here, note: 'спавнер блейзов: стоять в 16 блоках, чтобы работал' }
    })
    session.journal.append(SPAWNER_PLACE, `спавнер блейзов на ${fr.spawner.x},${fr.spawner.y},${fr.spawner.z}`, fr.spawner)
  }
}

export async function rodsApproach (fr: RodsFarm) {
  const { bot, ctl, session } = fr
  // Спавнер работает, только пока мы в 16 блоках от его центра — подойти,
  // но не в упор: блейзы появляются в ±4 от него.
  // Не на уровне помоста (ноги ниже/выше спавнера больше чем на 2) — тоже ход по сетке на пол зала: из-под помоста ифриты
  // над краем не видны и не достаются (s1-post07/09/14/15 06.10: тело на y66 при спавнере y69 в 5 бл. — 0 убийств за 6 мин).
  // Ниже помоста уже на 2 (ноги y−2: глаза под верхом пола, s1-LA-1/LB-1 06.10: y67 при спавнере y69 — 0 убийств за 2 зелья FR).
  const offLevel = () => !!fr.spawner && (Math.floor(bot.entity.position.y) < fr.spawner.y - 1 || Math.floor(bot.entity.position.y) > fr.spawner.y + 2)
  // …но не под ударами: ход по сетке не дерётся, 5 шагов под ифритами вплотную — 22.7 урона и смерть (s1-post17 06.10); ифрит без
  // луча к нам (тело в своём закрытом штреке под помостом) не мешает (s1-post18: 6 ифритов в 3–6 бл., все за стеной, 0 убийств);
  // тогда бой с места, а на помост — из основного цикла, когда рядом пусто.
  if (fr.spawner && (bot.entity.position.distanceTo(fr.spawner.offset(0.5, 0.5, 0.5)) > SPAWNER_RANGE - 4 || offLevel() && !liveBlazes(bot, fr.dead, 6).some(e => seesMe(bot, e)))) {
    // Издалека (спавнер из памяти за полкрепости) — отрезками и штреком
    // (nether.js walkToward): одним GoalNear pathfinder по Аду не находит.
    fr.phase = 'путь к спавнеру'
    // Сетка копии мира есть — сперва ходом по ней на пол зала (цель fortress mode=spawner): с крыши крепости в 16 бл. над
    // спавнером pathfinder не спускался (s1-post03 06.10: walkNear 0 шагов, «точка боя none», 370 с без выстрела, ифриты в
    // 17–31 бл. — дальше BOW_MAX). Бой тактика здесь не рвёт (protectedEncounter blaze), так что ход доходит.
    const NR: typeof import('../../nether-route') = require('../../nether-route')
    if (NR.enabled() && NR.gridOf(session) && fr.here === 'the_nether') {
      // Огнестойкость — до хода к помосту, а не после: на ходу шары ифритов жгли (s1-LB-5 06.10: «fireball:blaze» 6.3 урона за
      // 34 с хода, на помосте 5 хп → смерть).
      if (!hasEffect(bot, 'fire_resistance') && liveBlazes(bot, fr.dead, 24).length) {
        const d0 = await drinkFireResistance(bot)
        for (let i = 0; i < 20 && d0 === 'выпил fire_resistance' && !hasEffect(bot, 'fire_resistance'); i++) await sleep(100)
      }
      const rr: Partial<import('../../nether-route').NetherRouteResult> = await NR.routeTo(session, ctl, { x: fr.spawner.x, y: fr.spawner.y, z: fr.spawner.z, r: 2, dy: 0, solidFloor: true, frKeep: 2,
        // Без огнестойкости ход к помосту под шарами — горение и залпы без щита (s1c-L-2 06.10: 15 шарами и 17 огнём за 68 с хода,
        // смерть до боя): ифрит с лучом в 14 бл. — ход бросить, бой (радар, щит, коробка) с места.
        frNear: { x: fr.spawner.x, y: fr.spawner.y, z: fr.spawner.z, r: 22 }, ironOk: true, abortNear: { re: '^blaze$', r: hasEffect(bot, 'fire_resistance') ? 4 : 14 },
        timeoutSeconds: Math.max(30, Math.min(180, Math.round((fr.deadline - gameClock.now()) / 1000) - 60)) }).catch(e => ({ ok: false, why: e.message }))
      log('путь к спавнеру по сетке', { ok: rr.ok, why: rr.why, steps: rr.steps, dug: rr.dug, s: rr.seconds, at: xyz(bot.entity.position) })
    }
  }
  if (fr.spawner && canApproachSpawner(bot, fr.dead) && bot.entity.position.distanceTo(fr.spawner.offset(0.5, 0.5, 0.5)) > SPAWNER_RANGE - 4) {
    fr.walked = bot.entity.position.distanceTo(fr.spawner) > 32
      ? await (require('../../nether') as typeof import('../../nether')).walkToward(session, ctl, fr.spawner, Math.min(fr.deadline, gameClock.now() + 150000), { range: 7 })
      : await walkNear(bot, ctl, fr.spawner, 7, Math.max(5000, Math.min(60000, fr.deadline - gameClock.now())), { stopIf: () => !canApproachSpawner(bot, fr.dead) })
  }
}

export async function rodsPrepare (fr: RodsFarm) {
  const { bot, ctl, session } = fr
  // Место под стержни — до боя (рюкзак после хода по Аду бывает полон: стержень рядом не подбирается — B16f21 03.10).
  if (process.env.ND_NE_ROUTE !== '0') { try { await (require('../../nether-route') as typeof import('../../nether-route')).makeRoom(bot, 6) } catch {} }
  // ND_BLAZE_FR_LATE: зелье — когда бой есть (ифрит с лучом к нам в 16 бл.), а не на старте навыка: bzI1-s17-3 21.10 — навык начат в 30 бл.
  // от трона по двум дальним ифритам, оба зелья выпиты за 6 мин без убийства, у спавнера потом — без FR, смерть. Иначе пьёт бой (meleeCamp).
  const fightNow = (process.env.ND_BLAZE_FR_LATE !== '1' || liveBlazes(bot, fr.dead, 16).some(e => seesMe(bot, e))) && frSpendOk(bot, fr.dead)
  fr.potion = fightNow ? await drinkFireResistance(bot) : 'позже: боя ещё нет'
  // Эффект приходит отдельным пакетом после глотка — до него «зелья нет», и
  // первый же шаг цикла уходил прятаться.
  if (fr.potion === 'выпил fire_resistance') {
    for (let i = 0; i < 20 && !hasEffect(bot, 'fire_resistance'); i++) await sleep(100)
  }

  // Only the running combat loop owns the hands; the preceding survey/path still needs tactical protection.
  session._blazeCombatCtl = ctl
  // Без огнестойкости бой не запрещён (ND_FR_STRICT убран 06.10, решение пользователя): holdSpawner ведёт его по механике ифрита.
  if (fr.here === 'the_nether' && !hasEffect(bot, 'fire_resistance')) log('бой без огнестойкости', { potion: fr.potion, hp: Math.round(bot.health ?? 0) })
}

export async function rodsEngage (fr: RodsFarm) {
  const { bot, ctl, session, p } = fr
  // Яма (ND_BLAZE_HOLE=1) сама доходит до клетки у спавнера ходом по сетке, отбиваясь (holeCamp fightClose), — лагерь и с 9 бл.
  // (s1-post13camp 06.10: старт в 6–8 бл. — лагерь не включался, бой по-старому).
  if (process.env.ND_BLAZE_CAMP === '1' && fr.spawner && !p.legacy && bot.entity.position.distanceTo(fr.spawner.offset(0.5, 0.5, 0.5)) <= (process.env.ND_BLAZE_HOLE === '1' ? 9 : 5.6)) {
    const { potionOf }: typeof import('../../pvp') = require('../../pvp')
    const frN = bot.inventory.items().filter(i => /potion$/.test(i.name) && /fire_resistance$/.test(potionOf(i) || '')).reduce((n, i) => n + i.count, 0)
    let seen = false
    try { const b = bot.blockAt(fr.spawner); seen = !!b && bot.canSeeBlock(b) } catch {}
    // Спавнер из памяти (карта) и мы в 5.6 бл. — лагерь и без луча к нему (стоим над ним на своих блоках).
    if ((seen || fr.spawnerFrom === 'память') && (hasEffect(bot, 'fire_resistance') || frN > 0)) {
      fr.phase = 'лагерь у спавнера'
      fr.camp = await campSpawner(session, ctl, { spawner: fr.spawner, want: fr.want, deadline: fr.deadline, dead: fr.dead, p, setPhase: s => { fr.phase = s } })
      if (fr.camp.stopped === 'набрал') fr.stopped = null
    } else log('лагерь не начат', { seen, fr: hasEffect(bot, 'fire_resistance'), frN })
  }
  // Лагерь кончился без огнестойкости — дальше holdSpawner без неё (вылазки там под радаром залпов, не «по-старому»).
  if (fr.camp && fr.camp.inHole) { fr.stopped = fr.stopped || fr.camp.stopped; fr.bail = true }
  // ND_BLAZE_MELEE=1 — бой «мечом по месту» (blaze-melee.ts) вместо holdSpawner: бить того, кто в досягаемости, подходить к
  // видимому на высоте глаз, без коробки с окном; отлёжка — только когда вплотную никого.
  // STANCE: спавнер не увиден (тело под троном, ифриты видны) — тоже меч: старый holdSpawner без спавнера кружил щитом и коробками
  // (abS1-s17-1 21.10: в 4 бл. под троном, 377 с, FR не выпит, шары — смерть).
  if (!fr.bail && !p.legacy && (fr.spawner || process.env.ND_BLAZE_STANCE !== '0') && !fr.camp && process.env.ND_BLAZE_MELEE !== '0') {
    fr.phase = 'бой мечом у спавнера'
    fr.held = await (require('../../blaze-melee') as typeof import('../../blaze-melee')).meleeCamp(session, ctl, { spawner: fr.spawner, want: fr.want, deadline: fr.deadline, dead: fr.dead, setPhase: s => { fr.phase = s } })
    log('бой мечом', fr.held)
    fr.stopped = fr.held.stopped === 'набрал' ? null : fr.held.stopped
    fr.bail = !!fr.held.bail
    fr.camp = fr.held
  }
  if (!fr.bail && !p.legacy && !(fr.held && fr.held.mode === 'melee') && !(fr.camp && (fr.camp.stopped === 'набрал' || /^хп/.test(fr.camp.stopped)))) {
    // Бой по механике блейза (holdSpawner): щит под очереди, меч/лук между
    // ними, коробка на отдых. Старый цикл — legacy: true (для сравнения).
    fr.phase = 'бой у спавнера'
    fr.held = await holdSpawner(session, ctl, {
      spawner: fr.spawner, want: fr.want, deadline: fr.deadline, dead: fr.dead, t0: fr.t0, p, ledger: fr.ledger, kills: fr.kills,
      setPhase: s => { fr.phase = s },
      restAt: clamp(p.restAtHealth ?? 12, 6, 18),
      bailAt: clamp(p.retreatAtHealth ?? 6, 3, 12),
      fireproof: false
    })
    fr.stopped = fr.held.stopped
    fr.bail = fr.held.bail
    if (fr.held.dugIn) fr.dugIn = fr.held.dugIn
  }
}

export async function rodsLeave (fr: RodsFarm) {
  const { bot, ctl, session } = fr
  // ND_BLZ_EXIT_TACTICS=1 (blz 21.10): бой мечом кончился — руки больше не его: иначе тактика считает встречу защищённой (observe.ts
  // protectedEncounter: blaze + _blazeCombatCtl, иссушитель и магмовый куб — «их бьёт цикл боя») и на выходе на иссушителя не отвечает
  // никто (fB11-s19-1: 13 убийств, 6 стержней, «домой по следу» — иссушитель 7.9 × 3 за 2 с, смерть с 6 стержнями).
  if (process.env.ND_BLZ_EXIT_TACTICS === '1' && session._blazeCombatCtl === ctl) delete session._blazeCombatCtl
  // Бросая бой, не стоять под шарами: намерение кончится, а автопилот уводит
  // тело только ниже своего порога (autopilot fleeIfDying). Бег с оглядкой на
  // всех, кто рядом (flee.js smartFlee), до 12 с.
  // ND_BLZ_EXIT_FR=1 (blz 21.10): уход от трона под ифритами без FR — шары на выходе (fa11-s19-1: 7 стержней, FR кончилась, зелье в
  // рюкзаке, «домой 44 бл.» — сгорел через 2 с). Ифрит с лучом в 24 бл., FR нет или < 30 с, зелье есть — выпить до ухода.
  if (process.env.ND_BLZ_EXIT_FR === '1' && !ctl.aborted && fr.here === 'the_nether' && (bot.health ?? 0) > 0 &&
      (!hasEffect(bot, 'fire_resistance') || (bot._ndFrUntil && bot._ndFrUntil - gameClock.now() < 30000)) && liveBlazes(bot, fr.dead, 24).some(e => seesMe(bot, e))) {
    const d = await drinkFireResistance(bot, { renew: hasEffect(bot, 'fire_resistance') })
    log('выход: огнестойкость', { d })
  }
  // ND_BLZ_EXIT_UNDER=1 (blz 21.10): без FR ифриты с лучом в 24 бл. — уход под землёй: яма с крышкой на месте (digInNear), из неё
  // закрытый штрек к порталу на 24 шага (nether-cover.closedBore — устья заделываются): ход поверху от трона под шарами без FR убивал
  // через 1–2 с (fa11-s19-1: 7 стержней, «домой 44 бл.», сгорел; bzL1-s17-2: штрек домой с открытого места под ударами вплотную).
  // ND_BLZ_ROD_SWEEP=1: стержней меньше нужного, а рядом лежат (и ниже помоста — упали с трона) — собрать до ямы и ухода, пока FR
  // ещё жжёт шары впустую (≥ 18 с) или ни один ифрит нас не видит; до 15 с и не дольше остатка FR без 10 с.
  {
    const items: typeof import('../../items') = require('../../items')
    const frLeft = bot._ndFrUntil ? bot._ndFrUntil - gameClock.now() : 0
    const safe = frLeft >= 18000 || !liveBlazes(bot, fr.dead, 16).some(e => seesMe(bot, e))
    if (process.env.ND_BLZ_ROD_SWEEP === '1' && !ctl.aborted && fr.here === 'the_nether' && (bot.health ?? 0) > 6 && safe &&
        items.countOf(bot, 'blaze_rod') < fr.want && (require('../targets') as typeof import('../targets')).droppedRods(bot, 16) > 0) {
      const r0 = items.countOf(bot, 'blaze_rod')
      fr.phase = 'сбор стержней перед уходом'
      await collectRods(bot, ctl, 16, Math.max(3000, Math.min(15000, frLeft >= 18000 ? frLeft - 10000 : 15000)), { deep: true }).catch(() => 0)
      log('сбор перед уходом', { got: items.countOf(bot, 'blaze_rod') - r0, frLeft: Math.round(frLeft / 1000) })
    }
  }
  // ND_BLZ_FR_RESERVE: бой брошен за 25 с до конца последнего FR (frExit) — та же яма и штрек, но под FR, пока шары не жгут.
  const frExit = !!fr.held?.frExit
  if (process.env.ND_BLZ_EXIT_UNDER === '1' && !ctl.aborted && !fr.dugIn && fr.here === 'the_nether' && (bot.health ?? 0) > 0 &&
      (!hasEffect(bot, 'fire_resistance') || frExit || process.env.ND_BLZ_EXIT_BORE === '1' && (require('../../items') as typeof import('../../items')).countOf(bot, 'blaze_rod') >= fr.want) &&
      liveBlazes(bot, fr.dead, 24).some(e => seesMe(bot, e) || (frExit || process.env.ND_BLZ_EXIT_BORE === '1') && e.position.distanceTo(bot.entity.position) < 12)) {
    fr.phase = 'под землю от трона'
    fr.dugIn = await digInNear(bot, ctl).catch(e => ({ ok: false, why: e.message }))
    const portal = (session.journal?.state?.places || {})[worlds.portalKey('the_nether')]
    let away: any = null
    // Яма не встала (помост тонкий: «лава/пусто у ямы» — nS11-s19-1, hC11-s18-1), а FR ещё есть — сразу закрытым штреком: он сам
    // начинает «в толщу пола» с открытого места (nether-cover.closedBore), глубже на 4 — в опору трона.
    if ((fr.dugIn?.ok || frExit) && portal && worlds.worldOfRecord(portal) === 'the_nether' && !ctl.aborted) {
      away = await (require('../../nether-cover') as typeof import('../../nether-cover')).closedBore(session, ctl, { x: portal.x, z: portal.z },
        // ND_BLZ_EXIT_BORE=1 (blz 21.10): закрытым штреком до самого портала (в 96 бл.), а не 24 шага: с середины пути тело шло поверху
        // без FR под шарами ифритов крепости и добивал иссушитель (qS13-s19-1: 5 стержней, 20 огня + 20 шаров на «портал/goto»).
        { ...(process.env.ND_BLZ_EXIT_BORE === '1' && Math.hypot(portal.x - bot.entity.position.x, portal.z - bot.entity.position.z) <= 96
          ? { deadline: gameClock.now() + 120000, maxSteps: Math.ceil(Math.hypot(portal.x - bot.entity.position.x, portal.z - bot.entity.position.z)) + 8 }
          : { deadline: gameClock.now() + 40000, maxSteps: 24 }), minY: Math.floor(bot.entity.position.y) - (fr.dugIn?.ok ? 2 : 4) }).catch(e => ({ ok: false, why: e.message }))
      if (!fr.dugIn?.ok && away?.ok) fr.dugIn = { ok: true, sealed: true, bored: true, at: xyz(bot.entity.position) }
    }
    log('выход под землёй', { dugIn: fr.dugIn, away: away && { ok: away.ok, moved: away.moved, dug: away.dug, why: away.why } })
  }
  // Набрал или бросаю бой, а ифриты с лучом рядом — в толщу на месте, а не бег под шарами.
  if (!ctl.aborted && !fr.dugIn && fr.here === 'the_nether' && (bot.health ?? 0) > 0 && liveBlazes(bot, fr.dead, 10).some(e => seesMe(bot, e))) {
    fr.phase = 'в толщу на месте'
    fr.dugIn = await digInNear(bot, ctl).catch(e => ({ ok: false, why: e.message }))
    log('в толщу на месте', fr.dugIn)
  }
  if (fr.bail && !(fr.dugIn && fr.dugIn.ok) && !ctl.aborted && (watchers(bot, fr.dead) > 0 || !survival.safeGround(bot))) {
    try {
      fr.phase = 'бегство'
      if (!survival.safeGround(bot)) await survival.disengage(session, ctl, () => liveBlazes(bot, fr.dead, 32))
      fr.fled = await (require('../../flee') as typeof import('../../flee')).smartFlee(session, ctl, { timeoutMs: 12000, safeDist: 20, reason: 'блейзы' })
    } catch (e) { fr.fled = { error: e.message } }
  }
  if (!ctl.aborted && !fr.bail && !(fr.dugIn && fr.dugIn.ok)) await collectRods(bot, ctl, 12, 5000)
  // ND_BLZ_RETRACE: набрал — домой по своему следу (fortress/legs.retraceHome), пока не в 20 бл. от портала или срок навыка.
  // ND_BLZ_FR_RESERVE: ушёл от трона под последним FR (яма не встала или штрек короток) — тоже домой по следу, при любом числе стержней.
  if (process.env.ND_BLZ_RETRACE === '1' && !ctl.aborted && fr.here === 'the_nether' && (bot.health ?? 0) > 0 &&
      ((require('../../items') as typeof import('../../items')).countOf(bot, 'blaze_rod') >= fr.want || frExit && !(fr.dugIn?.ok && fr.dugIn?.sealed))) {
    fr.phase = 'домой по следу'
    try { fr.retrace = await (require('../../fortress/legs') as typeof import('../../fortress/legs')).retraceHome(session, ctl, { deadline: Math.max(gameClock.now() + 30000, fr.deadline) }) } catch (e) { fr.retrace = { ok: false, why: e.message } }
  }
}
