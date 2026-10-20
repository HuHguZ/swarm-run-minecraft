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
import { hasEffect, drinkFireResistance } from '../potions'
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
  fr.potion = await drinkFireResistance(bot)
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
  if (!fr.bail && !p.legacy && fr.spawner && !fr.camp && process.env.ND_BLAZE_MELEE !== '0') {
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
  // Бросая бой, не стоять под шарами: намерение кончится, а автопилот уводит
  // тело только ниже своего порога (autopilot fleeIfDying). Бег с оглядкой на
  // всех, кто рядом (flee.js smartFlee), до 12 с.
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
}
