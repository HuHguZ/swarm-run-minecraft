'use strict'
const gameClock = require('./src/game-clock')
// Slice 0 (NETHER.md): does a scene command run, and which world is the body in.
// Everything here is a measurement printed with numbers; red only where the
// INSTRUMENT is wrong, because every later Nether verdict leans on these.
//
// (а) Rule name. The short form spawn_mobs has already answered on this server
//     (latest.log:9), so its silence here means the log reader is broken — that
//     is the red. The old and the namespaced forms are printed, not judged.
//     Second witness, independent of the log: with advance_time false the
//     header's time label must not cross 11000 in 8 s from 10900 (perception.js
//     timeLabel: день < 11000 <= закат). Control that must be able to go red:
//     advance_time true — the same 8 s must cross, or «frozen» proved nothing.
// (б) World. /execute in the_nether tp onto polished_blackstone: header
//     dimension AND the floor only that arena has. Red skips (в) and (г).
// (в) Nether clock: which /time set moves the label the body sees in the Nether.
// (г) Old-world tail on the old daemon: an armor stand two blocks away in the
//     overworld, then the crossing — is it still in observe fair:false.
// (д) try-*.js files still naming 1.21.10 rules, for the lead.
//
// World hygiene: the arena overworld box sits at the Nether arena's x/z on
// purpose — (г) only means something if the stale stand would fall inside the
// observe radius after the crossing. spawn_mobs and advance_time are restored
// to true in finally WITH the reply read; the spawn point goes to the open
// base spot try-diamond uses, never into a sealed box the live game would
// respawn in.
const fs = require('fs')
const path = require('path')
const { connect, createKit, lane, inWorld, describe, sleep } = require('./scene-kit')

const conn = connect()
const call = conn.call
const kit = createKit({ call, heard: conn.heard })

const L = lane('worldrules')
const NX = L.nether.x
const NZ = L.nether.z
const at = (x, y, z) => `${x + 0.5} ${y} ${z + 0.5}`
const arena = (dim, floor, y) => ({
  dim,
  floor,
  shell: [[NX - 5, y - 1, NZ - 5], [NX + 5, y + 4, NZ + 5]],
  room: [[NX - 4, y, NZ - 4], [NX + 4, y + 3, NZ + 4]],
  tp: at(NX, y, NZ),
  y
})
const OVER = arena('overworld', 'polished_andesite', 150)
const NETHER = arena('the_nether', 'polished_blackstone', 71)
// The base spot try-diamond starts from: open ground, a known landing.
const PARK = '120 100 120'
const STAND_TAG = 'nd_worldrules'

let failures = 0
function check (what, ok, saw) {
  if (!ok) failures++
  console.log(`   [${ok ? ' OK ' : 'ПЛОХО'}] ${what}${saw === undefined ? '' : ` — вижу ${typeof saw === 'string' ? saw : JSON.stringify(saw)}`}`)
  return ok
}
const header = async () => ((await call('status')) || {} as Record<string, any>).state || {} as Record<string, any>

async function stands (radius) {
  const o = await call('observe', { radius, fair: false })
  return ((o && o.detail && o.detail.entities) || []).filter(e => /armor.?stand/i.test(`${e.name} ${e.kind}`))
}

async function timeWindow (label, value) {
  await kit.gamerule('advance_time', value)
  await kit.must('/time set 10900', /^Set the time to 10900$/, 'время 10900 не выставлено')
  await sleep(2000) // update_time comes once per 20 ticks
  const before = (await header()).time
  const t0 = gameClock.now()
  await sleep(8000)
  const after = (await header()).time
  const secs = (gameClock.now() - t0) / 1000
  console.log(`   ${label}: метка ${before} → ${after} за ${secs.toFixed(1)} с (при ходе 10900+40 → ~11100, «закат» с 11000)`)
  return { before, after, secs }
}

async function caseRuleName () {
  console.log('\n--- (а) имя правила ---')
  const forms = ['/gamerule doMobSpawning false', '/gamerule spawn_mobs false', '/gamerule minecraft:spawn_mobs false']
  const got: Record<string, any> = {} as Record<string, any>
  for (const f of forms) {
    got[f] = await kit.cmd(f, { reply: /^Gamerule /, ms: 4000 })
    console.log(`   ${f.padEnd(38)} ${describe(got[f])}`)
  }
  console.log(`   ответили ${forms.filter(f => got[f].ok).length} из ${forms.length} форм (по одной команде на форму)`)
  const short = got['/gamerule spawn_mobs false']
  check('прибор читает лог: короткое spawn_mobs ответило так же, как в latest.log:9', short.ok && short.reply === 'Gamerule spawn_mobs is now set to: false', describe(short))
  if (got['/gamerule doMobSpawning false'].ok) console.log('   ↳ старое имя ОТВЕТИЛО — вывод §0 о переименовании надо перепроверить')

  const frozen = await timeWindow('advance_time false', false)
  check('после «advance_time is now set to: false» метка времени не сменилась за 8 с', frozen.before === 'день' && frozen.after === 'день', `${frozen.before} → ${frozen.after}`)
  const moving = await timeWindow('advance_time true (контроль)', true)
  const seesTime = check('контроль: при advance_time true за 8 с метка сменилась на «закат»', moving.before === 'день' && moving.after === 'закат', `${moving.before} → ${moving.after}`)
  if (!seesTime) console.log('   ↳ прибор не видит хода времени — «замерло» выше ничего не доказывает')
  // Frozen for the rest: (в) reads labels a few seconds apart.
  await kit.gamerule('advance_time', false)
}

async function buildArenas () {
  console.log('\n--- арены ---')
  const d = await kit.setDifficulty('normal')
  console.log(`   сложность normal через ${d.via}: ${describe(d)}`)
  await kit.gamerule('spawn_mobs', false)
  for (const A of [OVER, NETHER]) {
    const f = await kit.forceload(A.dim, A.shell)
    const s = await kit.fillExact(A.dim, A.shell, A.floor)
    const r = await kit.fillExact(A.dim, A.room, 'air')
    console.log(`   ${A.dim}: чанков удержано ${f.chunks}; оболочка ${s.volume} × ${A.floor}, комната ${r.volume} воздуха; заливок с повторами ${s.attempts + r.attempts} на ${s.pieces + r.pieces} кусков`)
  }
}

async function caseWorlds () {
  console.log('\n--- (б) мир, (г) хвост старого мира ---')
  await kit.must('/effect give @s minecraft:slow_falling 30 0 true', /^Applied effect Slow Falling/, 'медленное падение не выдано')
  const o = await kit.ensureWorld('overworld', { tp: OVER.tp, floor: OVER.floor })
  await kit.cmd('/kill @e[type=!player]')
  console.log(`   верхний мир: ${o.dimension} на ${o.standingOn} за ${o.ms} мс`)

  await kit.must(inWorld('overworld', `summon minecraft:armor_stand ${at(NX + 2, OVER.y, NZ)} {Tags:["${STAND_TAG}"],NoGravity:1b}`), /^Summoned new Armor Stand$/, 'стойка не призвана')
  await sleep(1500)
  const near = await stands(8)
  const standVisible = check('контроль (г): стойку в 2 блоках видно до перехода', near.length > 0, near.map(e => `${e.name} ${e.dist} бл.`))

  let nether = null
  try {
    nether = await kit.ensureWorld('the_nether', { tp: NETHER.tp, floor: NETHER.floor })
  } catch (e) {
    check('(б) header.dimension = the_nether и под ногами polished_blackstone', false, e.message)
    return false
  }
  check('(б) header.dimension = the_nether и под ногами polished_blackstone', true, `${nether.dimension}, ${nether.standingOn}, ${nether.ms} мс`)

  // Before the kill: /kill @e without a position reaches every world, and the
  // question is about what the client still lists, not what the server holds.
  const tail = await stands(100)
  if (!standVisible) {
    console.log('   (г) без ответа: до перехода стойку не было видно')
  } else if (tail.length) {
    console.log(`   (г) в Аду вижу ${tail.length} стойк. (${tail.map(e => `${e.dist} бл. на ${JSON.stringify(e.pos)}`).join('; ')}) — хвост верхнего мира в bot.entities: проверка очистки в срезе 1 покраснеть может`)
  } else {
    console.log('   (г) стойки нет в радиусе 100 — сервер сам снимает сущности — проверка очистки в срезе 1 в игре покраснеть не может')
  }
  await kit.cmd('/kill @e[type=!player]')
  return true
}

async function caseNetherClock () {
  console.log('\n--- (в) часы в Аду ---')
  const steps = [['overworld', 6000], ['the_nether', 6000], ['overworld', 18000], ['the_nether', 18000]]
  const seen = []
  for (const [dim, n] of steps) {
    await kit.must(inWorld(dim, `time set ${n}`), new RegExp(`^Set the time to ${n}$`), `time set ${n} в ${dim} не подтверждён`)
    await sleep(2500)
    const label = (await header()).time
    seen.push(label)
    console.log(`   time set ${n} в ${String(dim).padEnd(10)} → метка в Аду «${label}»`)
  }
  const [, base, byOver, byNether] = seen
  if (!(base === 'день' && byNether === 'ночь')) {
    console.log(`   вердикт: часы Ада в заголовке не видны (свои 6000 → «${base}», свои 18000 → «${byNether}») — контроль сна в срезе 2 покраснеть не может`)
  } else if (byOver === 'ночь') {
    console.log('   вердикт: часы общие — time set в верхнем мире сменил метку в Аду; по одному замеру на шаг')
  } else {
    console.log(`   вердикт: часы раздельные — верхние 18000 оставили в Аду «${byOver}», свои 18000 дали «ночь»; по одному замеру на шаг`)
  }
}

function caseOldNames () {
  console.log('\n--- (д) старые имена правил в сценах ---')
  const OLD = /\b(doMobSpawning|doDaylightCycle|doWeatherCycle|doFireTick|doFallDamage|keepInventory|doInsomnia|doPatrolSpawning|doTraderSpawning|mobGriefing|doImmediateRespawn|naturalRegeneration)\b/g
  const files = fs.readdirSync(__dirname).filter(n => /^try-.*\.js$/.test(n) && n !== path.basename(__filename))
  let stale = 0
  let unread = 0
  for (const n of files) {
    const text = fs.readFileSync(path.join(__dirname, n), 'utf8')
    const code = text.split('\n').filter(l => !/^\s*\/\//.test(l)).join('\n')
    const hits = (code.match(OLD) || [])
    if (hits.length) { stale++; console.log(`   ${n}: ${[...new Set(hits)].join(', ')} ×${hits.length}`) }
    if (/\/gamerule /.test(code) && !/scene-kit/.test(code)) unread++
  }
  console.log(`   со старыми именами ${stale} из ${files.length} сцен; шлют /gamerule без чтения ответа ${unread} из ${files.length}`)
}

conn.ready.then(async () => {
  let reachedNether = false
  try {
    console.log(`=== try-worldrules ${new Date().toISOString().slice(0, 19)}  лог: ${kit.serverLog.file}`)
    await call('stop')
    await sleep(800)
    // Park outside both boxes first: rebuilding a shell around the body would
    // bury it, and a body left in the Nether by a crashed scene comes back here.
    await kit.must('/effect give @s minecraft:slow_falling 30 0 true', /^Applied effect Slow Falling/, 'медленное падение не выдано')
    await kit.ensureWorld('overworld', { tp: PARK })
    await kit.cmd('/clear @s')
    await kit.cmd('/effect clear @s')
    await kit.must('/spawnpoint @s 120 73 120', /^Set spawn point to 120, 73, 120 /, 'точка возрождения не выставлена')

    await caseRuleName()
    await buildArenas()
    reachedNether = await caseWorlds()
    if (reachedNether) {
      await caseNetherClock()
      const back = await kit.ensureWorld('overworld', { tp: OVER.tp, floor: OVER.floor })
      await kit.cmd('/kill @e[type=!player]')
      check('возврат: overworld на polished_andesite', true, `${back.dimension}, ${back.standingOn}, ${back.ms} мс`)
    } else {
      console.log('   (в) и (г) пропущены: в Ад по стандарту не попал')
    }
    caseOldNames()
  } catch (e) {
    failures++
    console.log(`\n[ПЛОХО] сцена оборвалась: ${e.message}`)
  } finally {
    console.log('\n--- уборка ---')
    try {
      const h = await header()
      if (h.dimension !== 'overworld') await kit.ensureWorld('overworld', { tp: OVER.tp, floor: OVER.floor })
    } catch (e) {
      check('вернулся в верхний мир', false, e.message)
    }
    try { await kit.cmd(`/kill @e[type=minecraft:armor_stand,tag=${STAND_TAG}]`) } catch {}
    for (const id of ['spawn_mobs', 'advance_time']) {
      try {
        const r = await kit.gamerule(id, true)
        check(`${id} возвращено в true`, true, describe(r))
      } catch (e) {
        check(`${id} возвращено в true — иначе живая игра пойдёт без ${id === 'spawn_mobs' ? 'мобов' : 'ночи'}; руками: /gamerule ${id} true`, false, e.message)
      }
    }
    for (const A of [OVER, NETHER]) {
      try { await kit.unforceload(A.dim, A.shell) } catch (e) { console.log(`   чанки ${A.dim} не отпущены: ${e.message}`) }
    }
    console.log(`оставлено в мире: коробки 11x6x11 на ${NX},${OVER.y - 1},${NZ} (верх) и ${NX},${NETHER.y - 1},${NZ} (Ад); точка возрождения 120,73,120; сложность normal; время стоит там, где его оставил (в)`)
    console.log(`итог: ${failures ? failures + ' проверок провалено' : 'все проверки прошли'}`)
    if (failures) process.exitCode = 1
    conn.close()
  }
}).catch(e => { console.error('ws:', e.message); process.exitCode = 1 })
