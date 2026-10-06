'use strict'
// Разведка крепости Ада глазами (fortress.js, RPC fortress / mc_fortress).
// Ложь, которую ловит сцена: «вижу крепость», когда она за стеной. Сцена
// строит в Аду арену, где у каждого видимого предмета есть спрятанный двойник
// БЛИЖЕ к телу: кирпич, спавнер и блейз. Прибор без луча выбрал бы ближний.
//
// Арена (Ад, x 465..550, z 494..514): сплошной netherrack, под ним лавовое море
// (y 60..68) — как в настоящем Аду, где лава съедала бюджет observe. В нём:
//   комната 9x5x9 (пол polished_blackstone) → коридор обзора на восток 37 блоков
//   → стена nether_bricks в конце (x=546, ~42 бл. от центра комнаты);
//   западный туннель 30 блоков в комнату — старт для explore;
//   спрятанные в породе: куб кирпича 3x3x3 в ~12 бл. к северо-западу, спавнер
//   в ~9 бл., блейз в каморке 1x2.
// (а) look из комнаты: [ OK ] ближайший ВИДИМЫЙ кирпич — стена на востоке
//     (x >= 540), а не спрятанный куб; спавнер — видимый, не спрятанный; блейзов
//     видно ровно 1; в памяти «крепость (ад)» с dimension the_nether.
// (б) explore east из начала туннеля (стена в 75 блоках, дальше радиуса 64):
//     [ OK ] нашёл, прошёл > 10 блоков, ближайший кирпич — та же стена.
// (в) look из верхнего мира — отказ словами, тело не сдвинулось.
//
// Запуск: node try-fortress.js [абв] (демон NeuroNether на 8772).
const fs = require('fs')
const path = require('path')
const { connect, createKit, sleep } = require('./scene-kit')

const WS = process.env.ND_WS || 'ws://127.0.0.1:8772'
const PLAYER = process.env.MC_USERNAME || 'NeuroNether'
const LOG = process.env.ND_SERVER_LOG || path.join(__dirname, '..', 'server-nether', 'logs', 'latest.log')
const MEM = path.join(process.env.ND_MEMORY_DIR || path.join(__dirname, '..', 'memory-nether'), 'state.json')
const conn = connect(WS)
const call = conn.call
const kit = createKit({ call, heard: conn.heard, logFile: LOG, player: PLAYER })
const ONLY = process.argv[2] || 'абв'
const N = 'the_nether'
const nether = c => `/execute in minecraft:the_nether run ${c.replace(/^\//, '')}`

let failures = 0
function check (what, ok, saw) {
  if (!ok) failures++
  console.log(`   [${ok ? ' OK ' : 'ПЛОХО'}] ${what}${saw === undefined ? '' : ` — вижу ${typeof saw === 'string' ? saw : JSON.stringify(saw)}`}`)
  return ok
}
const header = async () => ((await call('status')) || {} as Record<string, any>).state || {} as Record<string, any>
const memory = () => { try { return JSON.parse(fs.readFileSync(MEM, 'utf8')) } catch { return {} as Record<string, any> } }

async function arena () {
  await kit.gamerule('spawn_mobs', 'false')
  await kit.setDifficulty('normal')
  await kit.forceload(N, [[465, 60, 494], [550, 60, 514]])
  await kit.fillExact(N, [[465, 69, 494], [550, 78, 514]], 'netherrack')
  await kit.fillExact(N, [[465, 60, 494], [550, 68, 514]], 'lava')
  await kit.fillExact(N, [[500, 69, 500], [508, 69, 508]], 'polished_blackstone')
  await kit.fillExact(N, [[500, 70, 500], [508, 74, 508]], 'air')
  await kit.fillExact(N, [[509, 70, 502], [545, 74, 506]], 'air')
  await kit.fillExact(N, [[546, 70, 502], [546, 74, 506]], 'nether_bricks')
  await kit.fillExact(N, [[470, 70, 503], [499, 72, 505]], 'air')
  await kit.fillExact(N, [[470, 69, 503], [499, 69, 505]], 'polished_blackstone')
  await kit.fillExact(N, [[490, 71, 496], [492, 73, 498]], 'nether_bricks')
  await kit.cmd(nether('setblock 538 70 506 minecraft:spawner{SpawnData:{entity:{id:"minecraft:blaze"}}}'))
  await kit.cmd(nether('setblock 495 72 497 minecraft:spawner{SpawnData:{entity:{id:"minecraft:blaze"}}}'))
  await kit.fillExact(N, [[486, 71, 497], [486, 72, 497]], 'air')
  await kit.gamerule('spawner_blocks_work', 'false')
  // Ниже арены тоже: блейзы прошлого прогона от спрятанного спавнера падают в
  // лаву под полом и висят там (третий прогон видел четырёх вместо двух).
  await kit.cmd(nether('kill @e[type=minecraft:blaze,x=455,y=0,z=484,dx=105,dy=90,dz=40]'))
  await kit.cmd(nether('summon minecraft:blaze 530.5 71 504.5 {NoAI:1b,PersistenceRequired:1b}'))
  await kit.cmd(nether('summon minecraft:blaze 486.5 71 497.5 {NoAI:1b,PersistenceRequired:1b}'))
}

conn.ready.then(async () => {
  await call('connect')
  await call('stop')
  try {
    await kit.cmd('/effect give @s minecraft:slow_falling 20 0 true')
    await arena()
    await kit.cmd('/clear @s')
    for (const g of ['iron_pickaxe', 'iron_sword', 'cooked_beef 16', 'golden_helmet']) await kit.cmd(`/give @s minecraft:${g}`)

    if (ONLY.includes('а')) {
      console.log('(а) look из комнаты')
      await kit.ensureWorld(N, { tp: '504.5 70 504.5', floor: 'polished_blackstone' })
      await sleep(1000)
      const o = await call('observe', { radius: 64, fair: false })
      const truth = (((o && o.detail) || {} as Record<string, any>).entities || []).filter(e => /blaze/i.test(e.name))
      check('(а) оба блейза в мире (observe fair:false)', truth.length === 2, truth.map(e => `${e.pos.x},${e.pos.y},${e.pos.z}`))
      const r = await call('fortress', { mode: 'look', radius: 64 })
      const d = r.detail || {} as Record<string, any>
      console.log(`   fortress look: ${r.status} — ${d.stopped || d.note || r.error}`)
      const f = d.fortress || {} as Record<string, any>
      check('(а) крепость увидел', d.found === true && f.seen > 0, f)
      check('(а) ближайший видимый кирпич — стена на востоке, не спрятанный куб', f.nearest && f.nearest.x >= 540, f.nearest)
      const sp = d.spawners || []
      check('(а) видимый спавнер назван, спрятанный — нет', sp.some(s => s.x === 538 && s.z === 506) && !sp.some(s => s.x === 495), sp)
      check('(а) блейзов видно ровно 1', d.blazes && d.blazes.seen === 1, d.blazes)
      const mem = (memory().places || {} as Record<string, any>)['крепость (ад)']
      check('(а) в памяти «крепость (ад)» с dimension the_nether', !!mem && mem.dimension === 'the_nether' && mem.x >= 540, mem && { x: mem.x, y: mem.y, z: mem.z, dimension: mem.dimension })
    }

    if (ONLY.includes('б')) {
      console.log('(б) explore east из начала туннеля')
      await kit.ensureWorld(N, { tp: '471.5 70 504.5', floor: 'polished_blackstone' })
      await sleep(1000)
      const r = await call('fortress', { mode: 'explore', direction: 'east', radius: 64, distance: 80, timeoutSeconds: 120 })
      const d = r.detail || {} as Record<string, any>
      console.log(`   fortress explore: ${r.status} — ${d.stopped || d.note || r.error}; отрезков ${(d.legs || []).length}`)
      const f = d.fortress || {} as Record<string, any>
      check('(б) нашёл, пройдя больше 10 блоков', d.found === true && d.walked > 10, `found=${d.found} walked=${d.walked}`)
      check('(б) ближайший видимый кирпич — стена на востоке', f.nearest && f.nearest.x >= 540, f.nearest)
    }

    if (ONLY.includes('в')) {
      console.log('(в) look из верхнего мира')
      await kit.cmd('/effect give @s minecraft:slow_falling 20 0 true')
      await kit.cmd('/execute in minecraft:overworld run tp @s 800.5 121 796.5')
      await sleep(2500)
      const before = await header()
      const r = await call('fortress', { mode: 'explore' })
      const after = await header()
      const d = r.detail || {} as Record<string, any>
      check('(в) отказ словами про Ад, тело не сдвинулось', d.found === false && /Ад/.test(d.stopped || '') && before.pos.x === after.pos.x && before.pos.z === after.pos.z, d.stopped)
    }
  } catch (e) {
    failures++
    console.log('   [ПЛОХО] сцена оборвалась:', e.message)
  } finally {
    try { await call('stop') } catch {}
    try { await kit.gamerule('spawner_blocks_work', 'true') } catch {}
    try { await kit.gamerule('spawn_mobs', 'true') } catch {}
    console.log(failures ? `\nИТОГ: ПЛОХО — ${failures}` : '\nИТОГ: всё зелёное')
    if (failures) process.exitCode = 1
    conn.close()
  }
}).catch(e => { console.error('ws:', e.message); process.exitCode = 1 })
