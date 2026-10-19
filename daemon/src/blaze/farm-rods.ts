'use strict'
import * as gameClock from '../game-clock'
const Vec3: typeof import('vec3').Vec3 = require('vec3')
import { sleep, xyz } from '../movement'
import { seesBlock } from '../sight'
import { countOf, itemNamed } from '../items'
import * as worlds from '../worlds'
import * as survival from '../combat-safety'
import {
  EYES_WANTED, SPAWNER_PLACE, clamp, log, rodsShort, reachTo, seesMob, nearestBlaze, visibleSpawner, droppedRods,
  liveBlazes, watchers, witherClose
} from './targets'
import { hasEffect, drinkFireResistance } from './potions'
import { collectRods, snowballAt, makeTrack, canApproachSpawner, walkNear, takeCover, rest } from './approach'
import { seesMe } from './radar'
import { pitFrom, digInNear } from './post'
import { holdSpawner } from './hold'
import { campSpawner } from './camp'

const SPAWNER_RANGE = 16
// Снежок летит 1.5 блока за тик; дальше 24 блоков он опускается и расходится.
const SNOW_RANGE = 24
// Досягаемость меча: от глаз до хитбокса, entity_interaction_range 3.0.
const SWORD_REACH = 3.0
// Из укрытия мечом — только за теми, кто висит в этом радиусе от угла.
const CHASE_FROM_COVER = 7
// Дальше этого от укрытия бой без огнестойкости не уводит (см. farmRods).
const LEASH = 9

// Типы урона — номер в реестре damage_type (пакет damage_event), реестр по
// алфавиту имён: data/minecraft/damage_type/*.json в server-1.21.11.jar, 50
// штук (сверено 2026-09-27; тот же список в dragon.js).
const DAMAGE_TYPES = ['arrow', 'bad_respawn_point', 'cactus', 'campfire', 'cramming', 'dragon_breath', 'drown', 'dry_out',
  'ender_pearl', 'explosion', 'fall', 'falling_anvil', 'falling_block', 'falling_stalactite', 'fireball', 'fireworks',
  'fly_into_wall', 'freeze', 'generic', 'generic_kill', 'hot_floor', 'in_fire', 'in_wall', 'indirect_magic', 'lava',
  'lightning_bolt', 'mace_smash', 'magic', 'mob_attack', 'mob_attack_no_aggro', 'mob_projectile', 'on_fire',
  'out_of_world', 'outside_border', 'player_attack', 'player_explosion', 'sonic_boom', 'spear', 'spit', 'stalagmite',
  'starve', 'sting', 'sweet_berry_bush', 'thorns', 'thrown', 'trident', 'unattributed_fireball', 'wind_charge',
  'wither', 'wither_skull']

// Куда ушли хп: каждая потеря здоровья — к последнему damage_event по нам
// (тип и кто), и к тому, чем тело было занято (phase). Разбор смертей в
// лаборатории этапов: «сгорел» от шара, от огня после шара, от лавы — это три
// разные поправки.
function damageLedger (bot, phaseOf) {
  const byType = {}
  const byPhase = {}
  const hits = []
  let last = null
  let hp = bot.health ?? 20
  const onPk = pk => {
    if (!bot.entity || !pk || pk.entityId !== bot.entity.id) return
    const src = pk.sourceCauseId > 0 ? bot.entities[pk.sourceCauseId - 1] : null
    const direct = pk.sourceDirectId > 0 ? bot.entities[pk.sourceDirectId - 1] : null
    last = { type: DAMAGE_TYPES[pk.sourceTypeId] || String(pk.sourceTypeId), by: src ? src.name : undefined, t: gameClock.now() }
    // Геометрия щита в миг удара: куда смотрим, откуда прилетело (снаряд или
    // тот, кто бил), поднят ли щит по метаданным и сколько мс назад.
    try {
      const from = (direct && direct.position) || (src && src.position)
      if (from && ledger.probe) {
        const me = bot.entity.position
        const dx = from.x - me.x; const dz = from.z - me.z; const n = Math.hypot(dx, dz) || 1
        const fx = -Math.sin(bot.entity.yaw); const fz = -Math.cos(bot.entity.yaw)
        last.geo = { ang: Math.round(Math.acos(Math.max(-1, Math.min(1, (dx * fx + dz * fz) / n))) * 180 / Math.PI), ...ledger.probe() }
      }
    } catch {}
  }
  const onHealth = () => {
    const now = bot.health ?? 0
    if (now < hp) {
      const lost = hp - now
      const fresh = last && gameClock.now() - last.t < 600
      const key = fresh ? last.type + (last.by && last.by !== last.type ? ':' + last.by : '') : 'unknown'
      const phase = phaseOf() || '-'
      byType[key] = (byType[key] || 0) + lost
      byPhase[phase] = (byPhase[phase] || 0) + lost
      if (hits.length < 60) hits.push({ t: gameClock.now(), k: key, lost: Math.round(lost * 10) / 10, hp: Math.round(now * 10) / 10, ph: phase, geo: fresh && last.geo && key !== 'on_fire' ? last.geo : undefined })
      if (fresh && last.geo && key !== 'on_fire') log('удар', { k: key, lost: Math.round(lost * 10) / 10, hp: Math.round(now * 10) / 10, ph: phase, ...last.geo })
    }
    hp = now
  }
  bot._client.on('damage_event', onPk)
  bot.on('health', onHealth)
  const r1 = o => Object.fromEntries((Object.entries(o) as [string, any][]).map(([k, v]: any) => [k, Math.round(v * 10) / 10]).sort((a: any, b: any) => b[1] - a[1]))
  const ledger = {
    probe: null,
    stop () {
      bot._client.removeListener('damage_event', onPk)
      bot.removeListener('health', onHealth)
    },
    report () {
      const total: any = (Object.values(byType) as any[]).reduce((s: any, v) => s + v, 0)
      return total > 0 ? { total: Math.round(total * 10) / 10, byType: r1(byType), byPhase: r1(byPhase) } : undefined
    },
    hits
  }
  return ledger
}

async function farmRods (session, ctl, p: any = {}) {
  const bot = session.bot
  try { (require('../ne-guard') as typeof import('../ne-guard')).swatInstall(bot) } catch {}
  try { (require('../ne-guard') as typeof import('../ne-guard')).attach(session) } catch {}
  const mcData = session.mcData
  const combat: typeof import('../combat') = require('../combat')
  const actions: typeof import('../actions') = require('../actions')
  const t0 = gameClock.now()
  const deadline = t0 + clamp(p.timeoutSeconds ?? 240, 30, 600) * 1000 - 4000
  const retreatAt = clamp(p.retreatAtHealth ?? 8, 3, 16)
  // Раньше порога отхода — отдых за углом: пять блейзов разом снимают 16 хп за
  // полминуты (замер try-blaze-rods (а), первый прогон), а порог — это конец боя.
  const restAt = Math.max(retreatAt + 6, 14)
  let restsLeft = p.rest === false ? 0 : 4
  const rests = []
  const covers = []
  let coverAt = 0
  let coverFailAt = 0
  let lastBeat = 0
  let anchor = null
  let farSince = 0
  let coverFails = 0
  let bail = false
  let fled = null
  let dugIn = null
  let radius = clamp(p.radius ?? 20, 8, 32)
  // Бой мечом (ND_BLAZE_MELEE) владеет руками с начала навыка: тактика не рвёт подготовку у спавнера (bnf3/bnf4 16.10: TACTICAL
  // на 2–4-й с — заход потерян до первого взмаха). Чужие враги вплотную тактика по-прежнему берёт (protectedEncounter).
  if (process.env.ND_BLAZE_MELEE !== '0' && worlds.worldOf(bot) === 'the_nether') session._blazeCombatCtl = ctl
  const rods0 = countOf(bot, 'blaze_rod')
  const short = rodsShort(bot, p.eyes ?? EYES_WANTED)
  // rods — сколько должно СТАТЬ в рюкзаке (так зовёт автомат: blaze {rods: 7});
  // count — сколько добыть сверх того, что есть.
  const want = p.rods ? Math.max(rods0 + 1, p.rods) : rods0 + Math.max(1, p.count ?? short)
  const hp0 = Math.round(bot.health ?? 20)
  const here = worlds.worldOf(bot)

  const kills = []
  const dead = new Set()
  let phase = 'начало'
  const ledger = damageLedger(bot, () => phase)
  // Кого мы задели за последние 3 с: пропажа засчитывается убийством только у
  // них. Иначе смена мира (worlds.js чистит все сущности) и смерть самого бота
  // рождали «убил 8» у бота, убившего одного.
  const hurtAt = new Map()
  const onHurt = e => { if (e && e.name === 'blaze') hurtAt.set(e.id, gameClock.now()) }
  bot.on('entityHurt', onHurt)
  const onDead = (e, how) => {
    if (!e || e.name !== 'blaze' || !e.position || dead.has(e.id)) return
    if (e.position.distanceTo(bot.entity.position) > 24) return
    if (how === 'gone' && !(gameClock.now() - (hurtAt.get(e.id) || 0) < 3000)) return
    dead.add(e.id)
    kills.push({ at: xyz(e.position), t: Math.round((gameClock.now() - t0) / 100) / 10 })
  }
  const onGone = e => onDead(e, 'gone')
  // entityDead приходит не всегда (pvp.js: «сущность снимается с мира через
  // секунду после смерти, и entityDead приходит не всегда») — счёт по нему одному
  // давал «по 1 стержню на блейза» 12 раз из 14, где игра даёт 0..1. Блейз не
  // исчезает сам в 24 блоках от игрока, поэтому пропажа рядом — тоже смерть.
  bot.on('entityDead', onDead)
  bot.on('entityGone', onGone)

  const fights = []
  const ate = []
  let thrown = 0
  let walked = null
  let stopped = null
  let highTimeouts = 0
  let potion = null
  let toured = null
  let held = null
  let camp = null
  let unseenWalks = 0
  // Недостижимые за стеной — не мёртвые: убийство их всё равно засчитается.
  const skip = new Set()

  try {
    // --- где спавнер: видно глазами, иначе память этого мира.
    const pitOut: any = {}
    if (witherClose(bot)) { phase = 'яма от иссушителя'; await pitFrom(session, ctl, pitOut, witherClose(bot)) }
    let spawner = visibleSpawner(bot, mcData, 32)
    // Сразу после входа/телепорта чанки вокруг ещё грузятся: спавнер в трёх
    // блоках «не виден», и бой шёл к старой записи памяти за 1971 блок
    // (ферма 2026-09-29, blaze-mainkit-1). Подождать до 4 с.
    for (let k = 0; !spawner && k < 8 && !ctl.aborted; k++) {
      if (witherClose(bot)) { phase = 'яма от иссушителя'; await pitFrom(session, ctl, pitOut, witherClose(bot)) }
      await sleep(500); spawner = visibleSpawner(bot, mcData, 32)
    }
    let spawnerFrom = spawner ? 'вижу' : null
    const places = (session.journal.state && session.journal.state.places) || {}
    const rec = places[SPAWNER_PLACE]
    if (!spawner && rec && worlds.worldOfRecord(rec) === here) {
      spawner = new Vec3(rec.x, rec.y, rec.z)
      spawnerFrom = 'память'
      // Запись есть, а на месте уже не спавнер (сломан) — забыть, а не ждать
      // его 50 секунд (сцена (в): «спавнер молчит» у убранного спавнера).
      const b = bot.blockAt(spawner)
      if (b && b.name !== 'spawner' && seesBlock(bot, b)) {
        session.journal.patch(s => { if (s.places) delete s.places[SPAWNER_PLACE] })
        spawner = null
        spawnerFrom = null
      }
    }
    // Ни спавнера, ни блейза рядом, а крепость найдена — дойти до неё и обойти
    // по видимому кирпичу, пока не увидим тронный зал (fortress.js tour).
    if (!spawner && !nearestBlaze(bot, radius, dead) && here === 'the_nether' && p.tour !== false) {
      const fortress: typeof import('../fortress') = require('../fortress')
      const known = fortress.placeOf(session, fortress.PLACE)
      if (known && worlds.worldOfRecord(known) === here) {
        phase = 'обход крепости'
        toured = await fortress.tour(session, ctl, { deadline: Math.min(deadline, gameClock.now() + 240000) })
        // Спавнера не нашёл, а блейзов видел — бить тех, что есть (крепость
        // спавнит их и без спавнера): дальше обычных 20 блоков.
        if (toured.blazes && !p.radius) radius = 32
        if (toured.spawners && toured.spawners.length) {
          const s = toured.spawners[0]
          spawner = new Vec3(s.x, s.y, s.z)
          spawnerFrom = 'вижу'
        }
      }
    }
    if (spawner && spawnerFrom === 'вижу' && !(rec && rec.x === spawner.x && rec.y === spawner.y && rec.z === spawner.z)) {
      session.journal.patch(s => {
        if (!s.places) s.places = {}
        s.places[SPAWNER_PLACE] = { ...xyz(spawner), dimension: here, note: 'спавнер блейзов: стоять в 16 блоках, чтобы работал' }
      })
      session.journal.append(SPAWNER_PLACE, `спавнер блейзов на ${spawner.x},${spawner.y},${spawner.z}`, spawner)
    }
    // Спавнер работает, только пока мы в 16 блоках от его центра — подойти,
    // но не в упор: блейзы появляются в ±4 от него.
    // Не на уровне помоста (ноги ниже/выше спавнера больше чем на 2) — тоже ход по сетке на пол зала: из-под помоста ифриты
    // над краем не видны и не достаются (s1-post07/09/14/15 06.10: тело на y66 при спавнере y69 в 5 бл. — 0 убийств за 6 мин).
    // Ниже помоста уже на 2 (ноги y−2: глаза под верхом пола, s1-LA-1/LB-1 06.10: y67 при спавнере y69 — 0 убийств за 2 зелья FR).
    const offLevel = () => !!spawner && (Math.floor(bot.entity.position.y) < spawner.y - 1 || Math.floor(bot.entity.position.y) > spawner.y + 2)
    // …но не под ударами: ход по сетке не дерётся, 5 шагов под ифритами вплотную — 22.7 урона и смерть (s1-post17 06.10); ифрит без
    // луча к нам (тело в своём закрытом штреке под помостом) не мешает (s1-post18: 6 ифритов в 3–6 бл., все за стеной, 0 убийств);
    // тогда бой с места, а на помост — из основного цикла, когда рядом пусто.
    if (spawner && (bot.entity.position.distanceTo(spawner.offset(0.5, 0.5, 0.5)) > SPAWNER_RANGE - 4 || offLevel() && !liveBlazes(bot, dead, 6).some(e => seesMe(bot, e)))) {
      // Издалека (спавнер из памяти за полкрепости) — отрезками и штреком
      // (nether.js walkToward): одним GoalNear pathfinder по Аду не находит.
      phase = 'путь к спавнеру'
      // Сетка копии мира есть — сперва ходом по ней на пол зала (цель fortress mode=spawner): с крыши крепости в 16 бл. над
      // спавнером pathfinder не спускался (s1-post03 06.10: walkNear 0 шагов, «точка боя none», 370 с без выстрела, ифриты в
      // 17–31 бл. — дальше BOW_MAX). Бой тактика здесь не рвёт (protectedEncounter blaze), так что ход доходит.
      const NR: typeof import('../nether-route') = require('../nether-route')
      if (NR.enabled() && NR.gridOf(session) && here === 'the_nether') {
        // Огнестойкость — до хода к помосту, а не после: на ходу шары ифритов жгли (s1-LB-5 06.10: «fireball:blaze» 6.3 урона за
        // 34 с хода, на помосте 5 хп → смерть).
        if (!hasEffect(bot, 'fire_resistance') && liveBlazes(bot, dead, 24).length) {
          const d0 = await drinkFireResistance(bot)
          for (let i = 0; i < 20 && d0 === 'выпил fire_resistance' && !hasEffect(bot, 'fire_resistance'); i++) await sleep(100)
        }
        const rr: Partial<import('../nether-route').NetherRouteResult> = await NR.routeTo(session, ctl, { x: spawner.x, y: spawner.y, z: spawner.z, r: 2, dy: 0, solidFloor: true, frKeep: 2,
          // Без огнестойкости ход к помосту под шарами — горение и залпы без щита (s1c-L-2 06.10: 15 шарами и 17 огнём за 68 с хода,
          // смерть до боя): ифрит с лучом в 14 бл. — ход бросить, бой (радар, щит, коробка) с места.
          frNear: { x: spawner.x, y: spawner.y, z: spawner.z, r: 22 }, ironOk: true, abortNear: { re: '^blaze$', r: hasEffect(bot, 'fire_resistance') ? 4 : 14 },
          timeoutSeconds: Math.max(30, Math.min(180, Math.round((deadline - gameClock.now()) / 1000) - 60)) }).catch(e => ({ ok: false, why: e.message }))
        log('путь к спавнеру по сетке', { ok: rr.ok, why: rr.why, steps: rr.steps, dug: rr.dug, s: rr.seconds, at: xyz(bot.entity.position) })
      }
    }
    if (spawner && canApproachSpawner(bot, dead) && bot.entity.position.distanceTo(spawner.offset(0.5, 0.5, 0.5)) > SPAWNER_RANGE - 4) {
      walked = bot.entity.position.distanceTo(spawner) > 32
        ? await (require('../nether') as typeof import('../nether')).walkToward(session, ctl, spawner, Math.min(deadline, gameClock.now() + 150000), { range: 7 })
        : await walkNear(bot, ctl, spawner, 7, Math.max(5000, Math.min(60000, deadline - gameClock.now())), { stopIf: () => !canApproachSpawner(bot, dead) })
    }

    // Место под стержни — до боя (рюкзак после хода по Аду бывает полон: стержень рядом не подбирается — B16f21 03.10).
    if (process.env.ND_NE_ROUTE !== '0') { try { await (require('../nether-route') as typeof import('../nether-route')).makeRoom(bot, 6) } catch {} }
    potion = await drinkFireResistance(bot)
    // Эффект приходит отдельным пакетом после глотка — до него «зелья нет», и
    // первый же шаг цикла уходил прятаться.
    if (potion === 'выпил fire_resistance') {
      for (let i = 0; i < 20 && !hasEffect(bot, 'fire_resistance'); i++) await sleep(100)
    }

    // Only the running combat loop owns the hands; the preceding survey/path still needs tactical protection.
    session._blazeCombatCtl = ctl
    // Без огнестойкости бой не запрещён (ND_FR_STRICT убран 06.10, решение пользователя): holdSpawner ведёт его по механике ифрита.
    if (here === 'the_nether' && !hasEffect(bot, 'fire_resistance')) log('бой без огнестойкости', { potion, hp: Math.round(bot.health ?? 0) })
    // Яма (ND_BLAZE_HOLE=1) сама доходит до клетки у спавнера ходом по сетке, отбиваясь (holeCamp fightClose), — лагерь и с 9 бл.
    // (s1-post13camp 06.10: старт в 6–8 бл. — лагерь не включался, бой по-старому).
    if (process.env.ND_BLAZE_CAMP === '1' && spawner && !p.legacy && bot.entity.position.distanceTo(spawner.offset(0.5, 0.5, 0.5)) <= (process.env.ND_BLAZE_HOLE === '1' ? 9 : 5.6)) {
      const { potionOf }: typeof import('../pvp') = require('../pvp')
      const frN = bot.inventory.items().filter(i => /potion$/.test(i.name) && /fire_resistance$/.test(potionOf(i) || '')).reduce((n, i) => n + i.count, 0)
      let seen = false
      try { const b = bot.blockAt(spawner); seen = !!b && bot.canSeeBlock(b) } catch {}
      // Спавнер из памяти (карта) и мы в 5.6 бл. — лагерь и без луча к нему (стоим над ним на своих блоках).
      if ((seen || spawnerFrom === 'память') && (hasEffect(bot, 'fire_resistance') || frN > 0)) {
        phase = 'лагерь у спавнера'
        camp = await campSpawner(session, ctl, { spawner, want, deadline, dead, p, setPhase: s => { phase = s } })
        if (camp.stopped === 'набрал') stopped = null
      } else log('лагерь не начат', { seen, fr: hasEffect(bot, 'fire_resistance'), frN })
    }
    // Лагерь кончился без огнестойкости — дальше holdSpawner без неё (вылазки там под радаром залпов, не «по-старому»).
    if (camp && camp.inHole) { stopped = stopped || camp.stopped; bail = true }
    // ND_BLAZE_MELEE=1 — бой «мечом по месту» (blaze-melee.ts) вместо holdSpawner: бить того, кто в досягаемости, подходить к
    // видимому на высоте глаз, без коробки с окном; отлёжка — только когда вплотную никого.
    if (!bail && !p.legacy && spawner && !camp && process.env.ND_BLAZE_MELEE !== '0') {
      phase = 'бой мечом у спавнера'
      held = await (require('../blaze-melee') as typeof import('../blaze-melee')).meleeCamp(session, ctl, { spawner, want, deadline, dead, setPhase: s => { phase = s } })
      log('бой мечом', held)
      stopped = held.stopped === 'набрал' ? null : held.stopped
      bail = !!held.bail
      camp = held
    }
    if (!bail && !p.legacy && !(held && held.mode === 'melee') && !(camp && (camp.stopped === 'набрал' || /^хп/.test(camp.stopped)))) {
      // Бой по механике блейза (holdSpawner): щит под очереди, меч/лук между
      // ними, коробка на отдых. Старый цикл — legacy: true (для сравнения).
      phase = 'бой у спавнера'
      held = await holdSpawner(session, ctl, {
        spawner, want, deadline, dead, t0, p, ledger, kills,
        setPhase: s => { phase = s },
        restAt: clamp(p.restAtHealth ?? 12, 6, 18),
        bailAt: clamp(p.retreatAtHealth ?? 6, 3, 12),
        fireproof: false
      })
      stopped = held.stopped
      bail = held.bail
      if (held.dugIn) dugIn = held.dugIn
    }
    let idleSince = gameClock.now()
    while (p.legacy) {
      const have = countOf(bot, 'blaze_rod')
      const hp = Math.round(bot.health ?? 0)
      if (ctl.aborted) { stopped = 'прервано'; break }
      if (have >= want) break
      if (gameClock.now() > deadline) { stopped = 'время вышло'; break }
      // Сначала отдых за углом, и только если его нет — конец боя.
      if (restsLeft > 0 && hp <= restAt) {
        restsLeft--
        phase = 'отдых'
        const r = await rest(session, ctl, dead)
        rests.push(r)
        log('отдых', r)
        if (r.rested) continue
        restsLeft = 0
      }
      if (hp <= retreatAt) { stopped = `хп ${hp} — дальше не дерусь (порог ${retreatAt})`; bail = true; break }
      if (highTimeouts >= 3) {
        stopped = 'блейз держится выше досягаемости меча, а бить издалека нечем: нужен лук со стрелами или снежки'
        break
      }
      // Автопилот в намерении не ест (autopilot.js bodyBusy) — ест бой сам,
      // между блейзами, пока шары не летят.
      if ((bot.food ?? 20) <= 14) {
        try {
          const r = await actions.eat(session, {})
          if (r && r.ate) ate.push(r.ate)
        } catch {}
      }

      // Больше двух видят нас — сначала укрытие, потом бой (замер (а): пять
      // блейзов разом сняли 20 хп за 24 с, и бот умер посреди второго боя).
      const watching = watchers(bot, dead)
      if (gameClock.now() - lastBeat > 2000) {
        lastBeat = gameClock.now()
        log('шаг', { t: Math.round((gameClock.now() - t0) / 1000), hp, watching, fire: !!(bot.entity.metadata && (bot.entity.metadata[0] & 1)), pos: xyz(bot.entity.position) })
      }
      // Под огнестойкостью шары не жгут вовсе (fireball в #is_fire) — прятаться
      // не от чего, опасен только удар в упор, и бой идёт в открытую.
      const fireproof = hasEffect(bot, 'fire_resistance')
      // Под зельем угол не нужен: иначе сторож «не гоняться из укрытия»
      // держал бы тело там вечно (прогон с зельем простоял 396 с при шести
      // видящих и не ударил ни разу).
      if (fireproof) anchor = null
      if (!fireproof && covers.length < 12 && watching >= 2 && gameClock.now() - coverFailAt > 15000) {
        phase = 'укрытие'
        const c = await takeCover(bot, ctl, dead)
        covers.push(c)
        log('укрытие', { watching, hp: Math.round(bot.health ?? 0), ...c })
        if (c.at) { coverAt = gameClock.now(); anchor = new Vec3(c.at.x, c.at.y, c.at.z); farSince = 0 } else { coverFailAt = gameClock.now(); coverFails++ }
        continue
      }
      // Трое и больше видят, укрыться не вышло дважды, а огнестойкости нет —
      // это не бой, а тир по нам: 4–5 блейзов в железе снимают 20 хп за 8 с
      // открытого стояния (замеры (а)). Уйти, пока хп есть, и сказать почему.
      // Или: укрыться только что не вышло, а видят трое — ждать второго отказа
      // значит стоять под очередями (прогон (г): 16 → 5 хп между отказами).
      if (!fireproof && watching >= 3 && (coverFails >= 2 || gameClock.now() - coverFailAt < 15000)) {
        stopped = `видят сразу ${watching} блейза, а укрыться не вышло — под перекрёстным огнём не стою. ` +
          'Нужна огнестойкость (зелье: бартер пиглинов или варка) или укрытие у спавнера — поставь блоки и позови снова'
        bail = true
        break
      }

      const blaze: any = nearestBlaze(bot, radius, skip.size ? new Set([...dead, ...skip]) : dead)
      if (!blaze) {
        if (droppedRods(bot, 12) > 0) {
          phase = 'сбор'
          await collectRods(bot, ctl, 12, 6000)
          continue
        }
        const idle = gameClock.now() - idleSince
        if (idle > (spawner ? 50000 : toured ? 30000 : 6000)) {
          stopped = spawner
            ? `спавнер молчит ${Math.round(idle / 1000)}с (блейзов в ${radius} бл. нет) — встань в 16 блоках от него на ${spawner.x},${spawner.y},${spawner.z}`
            : `блейзов в ${radius} блоках больше не вижу`
          break
        }
        phase = 'ожидание'
        await sleep(400)
        continue
      }
      idleSince = gameClock.now()
      // Только что ушли в укрытие и никого не видно — подождать, пока выйдут
      // из-за угла, а не гнаться pathfinder'ом обратно под огонь.
      if (!seesMob(bot, blaze) && gameClock.now() - coverAt < 6000) {
        await sleep(400)
        continue
      }
      // Ближайший за стеной, и мы не в укрытии — подойти, а не звать бой:
      // бой по невидимому отвечает «не видно — за стеной» сразу, и прогон 11
      // крутил так четырнадцать «боёв» подряд у крепости без спавнера.
      if (!seesMob(bot, blaze) && !anchor) {
        if (unseenWalks < 6) {
          unseenWalks++
          phase = 'к невидимому'
          await walkNear(bot, ctl, blaze.position.floored(), 6, 8000)
          continue
        }
        skip.add(blaze.id)
        unseenWalks = 0
        continue
      }
      unseenWalks = 0

      // Висит выше меча и видно — снежок, пока есть: 3 урона без сближения.
      const r = reachTo(bot, blaze)
      // Только один на один: стоя с поднятой рукой под тремя очередями, бот
      // сгорал с 20 до 10 хп за шестнадцать снежков (замер (а), третий прогон).
      if (r > SWORD_REACH + 0.3 && r <= SNOW_RANGE && watching <= 1 && itemNamed(bot, 'snowball') && seesMob(bot, blaze)) {
        const track = makeTrack(blaze)
        track.update()
        await sleep(100)
        track.update()
        phase = 'снежки'
        const s = await snowballAt(bot, blaze, track).catch(() => null)
        if (s && s.thrown) thrown++
        await sleep(200)
        continue
      }

      // Из укрытия за далёким не гоняться: погоня через всю комнату увела тело
      // на 15 блоков от угла, и обратный путь под двумя очередями стоил 11 хп
      // (замер (а), шестой прогон). Далёкого бьют лук и снежки; мечом — только
      // того, кто сам подлетел, или если ждать уже 15 с, а видит нас он один.
      if (anchor && blaze.position.distanceTo(anchor) > CHASE_FROM_COVER) {
        if (!farSince) farSince = gameClock.now()
        if (gameClock.now() - farSince < 15000 || watching > 1) {
          await sleep(400)
          continue
        }
      } else {
        farSince = 0
      }

      // Из укрытия без огнестойкости — на поводке: бой гнался за блейзом на 13
      // блоков от угла, и там тело увидели одиннадцать (try-blaze-rods (г),
      // 2026-09-25: смерть). Дальше LEASH от угла — бой обрывается, назад в угол.
      const sub = { aborted: false, onAbort: [] }
      const leash = gameClock.setInterval(() => {
        const far = anchor && !fireproof && bot.entity && bot.entity.position.distanceTo(anchor) > LEASH
        if ((ctl.aborted || far) && !sub.aborted) {
          sub.aborted = true
          for (const fn of sub.onAbort) { try { fn() } catch {} }
        }
      }, 150)
      phase = 'бой'
      const f = await combat.fight(session, sub, {
        // Именно этого, видимого (combat.findTarget «#id»). По имени бой брал
        // ближайшего вообще — за стеной — и уводил тело из укрытия под огонь
        // остальных: «blaze не видно — за стеной» дважды за прогон.
        target: '#' + blaze.id,
        purpose: 'resource',
        resourceGoal: { item: 'blaze_rod', count: want },
        allowRanged: p.allowRanged,
        clearArea: 0,
        retreatAtHealth: restsLeft > 0 ? restAt : retreatAt,
        // Короткий бой: погоня за одним выводит из укрытия под остальных, и
        // решение «где стоять» надо пересматривать чаще (второй бой того же
        // прогона — 20 → 11 хп при двух видящих).
        timeoutSeconds: 12,
        shield: p.shield || 'ranged'
      }).catch(e => ({ error: String(e.message || e) })).finally(() => gameClock.clearInterval(leash))
      if (sub.aborted && !ctl.aborted) f.leashed = true
      const brief = {
        killed: f.killed || (f.kills ? f.kills.join(', ') : undefined),
        swings: f.swings,
        arrows: f.arrows,
        hp: f.hp,
        why: f.leashed ? `поводок: дальше ${LEASH} бл. от укрытия не гонюсь` : (f.error || f.lost || f.stopped || (f.timeout ? 'время боя вышло' : undefined))
      }
      fights.push(brief)
      log('бой', { watching, ...brief })
      // «Не достал»: бой кончился по времени, а ни взмаха, ни стрелы не было.
      if ((f.timeout || (!brief.killed && /время/.test(brief.why || ''))) && !f.swings && !f.arrows) {
        highTimeouts++
      } else if (brief.killed) {
        highTimeouts = 0
      }
      if ((f.retreated || f.lowHealth) && restsLeft <= 0) { stopped = `отошёл: ${f.mode || f.why || 'мало хп'}`; break }
      phase = 'сбор'
      await collectRods(bot, ctl, 10, 5000)
      // Бой увёл от угла — назад, пока новые не набежали.
      if (anchor && bot.entity.position.distanceTo(anchor) > 5 && !ctl.aborted) {
        phase = 'назад в укрытие'
        await walkNear(bot, ctl, anchor, 0, 8000)
      }
    }
    // Бросая бой, не стоять под шарами: намерение кончится, а автопилот уводит
    // тело только ниже своего порога (autopilot fleeIfDying). Бег с оглядкой на
    // всех, кто рядом (flee.js smartFlee), до 12 с.
    // Набрал или бросаю бой, а ифриты с лучом рядом — в толщу на месте, а не бег под шарами.
    if (!ctl.aborted && !dugIn && here === 'the_nether' && (bot.health ?? 0) > 0 && liveBlazes(bot, dead, 10).some(e => seesMe(bot, e))) {
      phase = 'в толщу на месте'
      dugIn = await digInNear(bot, ctl).catch(e => ({ ok: false, why: e.message }))
      log('в толщу на месте', dugIn)
    }
    if (bail && !(dugIn && dugIn.ok) && !ctl.aborted && (watchers(bot, dead) > 0 || !survival.safeGround(bot))) {
      try {
        phase = 'бегство'
        if (!survival.safeGround(bot)) await survival.disengage(session, ctl, () => liveBlazes(bot, dead, 32))
        fled = await (require('../flee') as typeof import('../flee')).smartFlee(session, ctl, { timeoutMs: 12000, safeDist: 20, reason: 'блейзы' })
      } catch (e) { fled = { error: e.message } }
    }
    if (!ctl.aborted && !bail && !(dugIn && dugIn.ok)) await collectRods(bot, ctl, 12, 5000)
  } finally {
    bot.removeListener('entityDead', onDead)
    if (session._blazeCombatCtl === ctl) delete session._blazeCombatCtl
    bot.removeListener('entityGone', onGone)
    bot.removeListener('entityHurt', onHurt)
    ledger.stop()
    log('урон', { hp: Math.round(bot.health ?? 0), ...(ledger.report() || {}), last: ledger.hits.slice(-6) })
  }

  const rods = countOf(bot, 'blaze_rod')
  const gained = rods - rods0
  const left = droppedRods(bot, 12)
  const detail: any = {
    rods: { before: rods0, now: rods, gained, want },
    dugIn: dugIn && dugIn.ok ? dugIn : undefined,
    kills: kills.length,
    killsAt: kills.slice(0, 12),
    perKill: kills.length ? Math.round(gained / kills.length * 100) / 100 : null,
    fights: fights.slice(-8),
    snowballs: thrown ? { thrown, left: countOf(bot, 'snowball') } : undefined,
    hpLost: Math.max(0, hp0 - Math.round(bot.health ?? 0)),
    camp: camp || undefined,
    clearing: held?.clearing,
    safety: held?.safety,
    escape: held?.escape,
    damage: ledger.report(),
    ate: ate.length ? ate : undefined,
    rests: rests.length ? rests : (held && held.rests.length ? held.rests : undefined),
    doctrine: held ? { melee: held.melee, arrows: held.arrows, arrowsLeft: held.arrowsLeft, shieldSec: Math.round(held.shieldMs / 1000), bunker: held.bunker || undefined, sorties: held.sorties || undefined, foes: held.foes.length ? held.foes : undefined, shield: held.shield ? { blocked: held.shield.blocked, raises: held.shield.raises, hpUp: held.shield.hpUnderShield, hpOpen: held.shield.hpOpen } : undefined, shieldWear: held.shieldWear || undefined, balls: held.radar ? held.radar.balls : undefined } : undefined,
    covers: covers.length ? covers : undefined,
    fled: fled ? { mode: fled.mode, ran: fled.ran, from: fled.from } : undefined,
    potion: potion || undefined,
    spawner: undefined,
    walked: walked || undefined,
    toured: toured ? { hops: toured.hops.length, spawners: toured.spawners, seen: toured.seen, at: toured.at } : undefined,
    groundLeft: left || undefined,
    eyesPossible: countOf(bot, 'ender_eye') + countOf(bot, 'blaze_powder') + 2 * rods,
    seconds: Math.round((gameClock.now() - t0) / 1000)
  }
  const places = (session.journal.state && session.journal.state.places) || {}
  if (places[SPAWNER_PLACE] && worlds.worldOfRecord(places[SPAWNER_PLACE]) === here) {
    const s = places[SPAWNER_PLACE]
    detail.spawner = { x: s.x, y: s.y, z: s.z }
  }
  if (rods < want) {
    detail.need = held && held.needArrows ? { what: 'arrow', count: 32, have: 0, for: 'blaze_rod' } : { what: 'blaze_rod', count: want - rods, have: rods }
    detail.stopped = `${stopped || 'встал'} — стержней ${rods} из ${want} (убил ${kills.length}, выпало ${gained}` +
      `${left ? `, ещё ${left} лежат рядом` : ''})`
  }
  detail.note = `Стержней +${gained} (теперь ${rods}), убито блейзов ${kills.length}` +
    (kills.length ? ` — по ${detail.perKill} на блейза (игра даёт 0 или 1, в среднем 0.5)` : '') +
    `. Хватит на ${detail.eyesPossible} око(в) при жемчуге. ` +
    (rods >= want ? 'Порошок: mc_craft item=blaze_powder (1 стержень = 2 порошка).' : 'Позови ещё раз у спавнера — он работает, пока я в 16 блоках.')
  return detail
}

export { farmRods }
