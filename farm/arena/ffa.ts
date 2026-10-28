'use strict'
// Дезматч (FFA, показ 09.10): N ботов на сервере слота фермы бьются каждый против всех в Колизее.
// Цель бота — ближайший живой противник, пересматривается по концу боя или раз в SEG_S (30) с: чаще — обрыв тарана в воздухе (бой pvp — по одной цели за вызов);
// умер — набор заново и обратно на поле. Счёт убийств — по журналу сервера.
//   node dist/farm/arena/ffa.js up 31 4          поднять ещё 4 бойца (NeuroFarm31c…f, ws 8961…) на сервере слота 31
//   node dist/farm/arena/ffa.js run 31 [kit]     бой: NeuroFarm31, NeuroFarm31b и поднятые; kit — elytra (умолч.) | sword | crystal
//   node dist/farm/arena/ffa.js team 31 [kit]    команды 6 на 6 (красные/синие): фокус, прикрытие, зелья союзникам, стенки (набор team)
//   node dist/farm/arena/ffa.js arms 31          командная гонка вооружений 6 на 6: карта arms-layout (SEED, ARMS_POS), старт пустым,
//                                     лут LOOT_S (60) с зонами по команде → каптёр (лишнее своим) → бой
//   node dist/farm/arena/ffa.js down 31          погасить поднятых этой командой
// Только ферма: команды — RCON слота, бойцы — снимок кода из farm/slots.json (FFA_CODE — свой).
// Части боя — farm/arena/: общий контекст боя (context.ts) создаёт run() ниже и раздаёт частям в том же порядке, что и раньше.
import { ROOT, sleep, log, SEG_S, SOLO, CHAMP } from './context'
import { DIST_ROOT } from '../../daemon/src/paths'
import type { ArenaContext } from './context'
import { LAN, LAN_LOG, rcon, buildLan, gameClock } from './server'
import { discover, client, up, down, boost } from './fleet'
import { setupArmsMap, installPlaces, guardFalls } from './map'
import { startRefills } from './loot'
import { installRounds, placeFighters, startMobs, fighterLoop } from './rounds'
import { humanTeam, installHumanKit, installHumans, watchHumans } from './humans'
import { installSupply, startTactics } from './supply'
import { installRadio } from './radio'
import { installDangers } from './dangers'
import { watchAlarm, installSight, watchStatus, watchBoard } from './watch'
import * as fs from 'fs'
import path = require('path')
const crowd = require(path.join(DIST_ROOT, 'daemon', 'src', 'pvp', 'crowd'))

async function run (i, kit = 'elytra', { teams = false, arms = false } = {}) {
  // Гонка вооружений командой: карта arms-layout (сундуки, тайники, комнаты), старт пустым, лут → каптёр → бой.
  // ARMS_MAP=colosseum — гонка в Колизее (daemon/arena/colosseum-arms: камеры, лаборатория, галереи, лестницы); иначе arms-layout.
  const COLOS_MAP = process.env.ARMS_MAP === 'colosseum'
  const AL = arms ? require(path.join(DIST_ROOT, 'daemon', 'arena', COLOS_MAP ? 'colosseum-arms' : 'arms-layout')) : null
  const L = arms ? AL.generate(process.env.SEED || 'team1') : null
  const bots: any[] = await discover(i)
  const N = bots.length
  // Нрав — по кругу: в одной толпе разные почерки (crowd.PERSONAS).
  const PERS = Object.keys(crowd.PERSONAS)
  bots.forEach((b, k) => { b.persona = process.env.FFA_PERSONA || PERS[k % PERS.length] })
  // Команды (6 на 6): красные и синие через одного, цветные ники; дружественный огонь разрешён.
  if (teams) bots.forEach((b, k) => { b.team = CHAMP ? (k ? 'blue' : 'red') : SOLO || k % 2 ? 'blue' : 'red'; b.champ = CHAMP && !k })
  const teamOf = n => bots.find(b => b.name === n)?.team
  // Центр поля: Колизей (600 120 600); гонка вооружений — своя карта arms-layout (ARMS_POS, по умолчанию 2000 100 2000).
  let X = 600; let Y = 120; let Z = 600; let R = 24
  if (arms) {
    const [ax, ay, az] = (process.env.ARMS_POS || (COLOS_MAP ? '600 120 600' : '2000 100 2000')).split(/\s+/).map(Number)
    X = ax; Y = ay; Z = az; R = COLOS_MAP ? L.half : 27 // бой по всему Колизею, не только по полю
  }
  const LOGF = LAN ? LAN_LOG : path.join(ROOT, 'farm', `server-${i}`, 'logs', 'latest.log')
  const STOPF = path.join(ROOT, 'farm', `ffa-${i}.stop`)
  // Габарит уборки (дроп, стрелы, опыт — раз в 30 с и в конце раунда): Колизей или поле дезматча.
  const BOX = arms ? `x=${X - L.half},y=${Y - 6},z=${Z - L.half},dx=${2 * L.half},dy=${COLOS_MAP ? 46 : 24},dz=${2 * L.half}` : 'x=524,y=110,z=536,dx=152,dy=60,dz=128'
  // Общий контекст боя: изменяемое между частями — его полями (ctx.between, ctx.round…), не копиями.
  const base: Partial<ArenaContext> = {
    i, kit, teams, arms, COLOS_MAP, AL, L, X, Y, Z, R, bots, N, teamOf, rcon, log, sleep, LOGF, STOPF, BOX,
    HUMAN_TEAM: humanTeam(teams),
    // Набивка сундуков — на каждый раунд своя (зерно: seed карты + номер раунда).
    stockChests: async (_round: number, _only?: any) => {},
    restoreArena: async () => {},
    spawnAt: null,
    perches: [],
    names: bots.map(b => b.name),
    pos: {}, deaths: {}, kills: {},
    deadNow: new Set<string>(),
    // Раунды гонки (пользователь 10.10): погибший — зритель до конца раунда; вся команда выбыла — новый раунд для всех.
    out: new Set<string>(),
    deathAt: {},
    // Сундуки раунда: открытые и чей заявлен (двое к одному не бегут).
    opened: new Set<string>(),
    refills: new Map<string, number>(),
    chestBy: new Map<string, string>(),
    chestFail: new Map<string, number>(),
    roundWins: { red: 0, blue: 0 },
    round: 1,
    between: false,
    killGaps: [],
    busy: new Set<string>(),
    labNeed: {}, brewed: {}, alchemist: {},
    radio: {},
    stop: false,
    // Живые игроки (пользователь 10.10): кто бьёт бойцов — враг всей их команды (вся команда на него), кто помогает (вещи,
    // зелья) — союзник: его не бьют и прикрывают (бьют того, кто бьёт его). Отношение копится: удар −3, убийство −5, помощь +2.
    humans: {},
    rel: { red: {}, blue: {} },
    humanNames: [],
    humanOut: new Set<string>()
  }
  const ctx = base as ArenaContext
  if (arms) await setupArmsMap(ctx)
  log(`${teams ? 'команды' : 'дезматч'}: ${N} бойцов (${bots.map(b => `${b.name} — ${b.persona}`).join(', ')}), набор ${kit}, цель — по толпе (pvp/crowd), пересмотр ≤ ${SEG_S} с`)
  for (const b of bots) { b.c = client(`ws://127.0.0.1:${b.ws}`); if (!await b.c.ready.then(() => true, e => { log(`⚠ ${b.name}: ${e.message} — без него`); return false })) continue; await b.c.call('connect').catch(() => {}); if (arms) await rcon(i, `gamemode spectator ${b.name}`).catch(e => log(`⚠ ${b.name}: зрителем не перевёл — ${e.message}`)); await b.c.call('temper', { enabled: false }).catch(() => {}); await b.c.call('play_mode', { mode: 'free' }).catch(() => {}) }
  if (teams) {
    for (const [t, color] of [['red', 'red'], ['blue', 'blue']]) {
      await rcon(i, `team add ${t}`).catch(() => {})
      await rcon(i, `team modify ${t} color ${color}`).catch(() => {})
      await rcon(i, `team modify ${t} friendlyFire true`).catch(() => {})
      // По одному: team join берёт одного участника, списком через пробел — никого (10.10: команды были пусты, 4 убийства своих).
      for (const b of bots.filter(b => b.team === t)) await rcon(i, `team join ${t} ${b.name}`).catch(() => {})
    }
  }
  for (const c of [`gamerule immediate_respawn ${arms && process.env.ARMS_DEATH_ANIM !== '0' ? 'false' : 'true'}`, `gamerule keep_inventory ${arms && process.env.ARMS_KEEP !== '1' ? 'false' : 'true'}`, 'gamerule spawn_mobs false', LAN ? 'gamerule log_admin_commands false' : 'gamerule send_command_feedback false', 'gamerule advance_time false', 'time set day',
    // ARMS_WEATHER=thunder (14.10: «боты бьют молниями» — трезубец с «Громовержцем» зовёт молнию только в грозу): погода на
    // все раунды, без смены; умолчание — ясно, как было.
    `weather ${process.env.ARMS_WEATHER || 'clear'}`, `gamerule advance_weather ${process.env.ARMS_WEATHER && process.env.ARMS_WEATHER !== 'clear' ? 'false' : 'true'}`]) await rcon(i, c).catch(() => {})
  if (LAN && !fs.existsSync(LOGF)) fs.writeFileSync(LOGF, '')
  ctx.logAt = fs.statSync(LOGF).size
  const { rescueT, fallT } = guardFalls(ctx)
  const refillT = startRefills(ctx)
  installRounds(ctx)
  installHumanKit(ctx)
  installPlaces(ctx)
  await placeFighters(ctx)
  const mobT = await startMobs(ctx)
  installSupply(ctx)
  const announce = installRadio(ctx)
  await sleep(1500)
  process.on('SIGINT', () => { ctx.stop = true })
  try { fs.unlinkSync(STOPF) } catch {}
  installHumans(ctx)
  installDangers(ctx)
  const { humanT, giftT } = watchHumans(ctx)
  // Человек на арене — боты на обычном приоритете и всех ядрах (fleet.boost); раз в минуту повтор: перезапущенный демон
  // родится снова «ниже обычного». ARENA_BOOST=0 — не трогать (стенд бота-противника: «человек» там — свой тестовый бот).
  let boosted = false, boostAt = 0
  const boostT = setInterval(() => {
    const want = process.env.ARENA_BOOST !== '0' && ctx.humanNames.length > 0
    if (want === boosted && !(want && Date.now() - boostAt > 60000)) return
    const fresh = want !== boosted
    boosted = want; boostAt = Date.now()
    boost(i, want).then(n => { if (fresh) log(want ? `🚀 на арене ${ctx.humanNames.join(', ')} — ботам обычный приоритет и все ядра (процессов ${n})` : `🐢 людей на арене нет — ботам снова щадящий режим (процессов ${n})`) }).catch(() => {})
  }, 5000)
  const lootWatch = watchAlarm(ctx)
  installSight(ctx)
  const { mobPollT, frozenT, poll } = watchStatus(ctx)
  const boardT = watchBoard(ctx)
  if (arms) { ctx.roundT0 = Date.now(); if (process.env.ARMS_PHASES === '1') await ctx.armsPrep() }
  const { rolesT, tactT } = await startTactics(ctx)
  await Promise.all(bots.map(b => fighterLoop(ctx, b)))
  clearInterval(poll); if (refillT) clearInterval(refillT); if (fallT) clearInterval(fallT); if (rescueT) clearInterval(rescueT); clearInterval(frozenT); if (mobPollT) clearInterval(mobPollT); if (mobT) clearInterval(mobT); clearInterval(humanT); clearInterval(boostT); clearInterval(lootWatch); clearInterval(giftT); clearInterval(boardT); clearInterval(announce); clearInterval(rolesT); clearInterval(tactT)
  for (const b of bots) await b.c.call('stop').catch(() => {})
  log('итог (убил/умер) ' + ctx.board())
  process.exit(0)
}

const [cmd, slot, arg] = process.argv.slice(2)
if (cmd === 'build-lan') buildLan(slot || 'HuHguZ').then(() => process.exit(0), e => { console.error(e); process.exit(1) })
else {
const i = Number(slot)
if (!(i >= 1 && i <= 32)) { console.log('node dist/farm/arena/ffa.js up|run|down <слот> [N|набор]'); process.exit(1) }
const clocked = () => !LAN && cmd !== 'up' && cmd !== 'down' && (Number(process.env.TICK_RATE) > 20 || process.env.GAME_CLOCK === '1') ? gameClock(i) : Promise.resolve()
;clocked().then(() => cmd === 'up' ? up(i, Number(arg || 4)).then(() => process.exit(0)) : cmd === 'down' ? Promise.resolve(down(i)).then(() => process.exit(0)) : cmd === 'run' ? run(i, arg || 'elytra') : cmd === 'team' ? run(i, arg || 'team', { teams: true }) : cmd === 'arms' ? run(i, 'arms', { teams: true, arms: true }) : Promise.reject(new Error('команда?'))).catch(e => { console.error(e); process.exit(1) })
}
