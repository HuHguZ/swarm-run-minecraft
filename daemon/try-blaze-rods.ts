'use strict'
const gameClock = require('./src/game-clock')
// Огненные стержни у спавнера (blaze.js, RPC blaze / mc_blaze). Ложь, которую
// ловит сцена: «убил N» вместо «принёс N». Лут блейза — blaze_rod 0..1 и только
// при убийстве игроком (loot_table/entities/blaze.json), поэтому прибыль
// меряется разницей рюкзака, а убийства — отдельным числом.
//
// Арена: закрытая коробка из polished_blackstone в Аду, спавнер блейзов
// (setblock spawner{SpawnData blaze}) в 7 блоках от тела, из западной стены —
// коридор с поворотом (укрытие для отдыха, как коридоры крепости у тронного
// зала). spawn_mobs false — живые мобы только из спавнера и призванные;
// spawner_blocks_work true.
//
// (а) Подготовленный набор (железо, меч, щит, лук и стрелы, снежки, еда и
//     зелье огнестойкости), count=RODS (3): [ OK ] зелье выпито до боя,
//     стержней в рюкзаке прибавилось >= RODS и detail.rods.gained равен
//     разнице рюкзака; [ПЛОХО] смерть или «Blaze Rod» на земле в 8 блоках у
//     живого бота.
// (г) Тот же набор БЕЗ огнестойкости против 4–5 блейзов разом: [ OK ] не
//     умер — набрал или честно бросил бой (stopped) и ушёл. Замеры первых
//     прогонов: открытое стояние под пятью стоит 20 хп за ~8 с.
// (б) Висящий блейз (NoAI, NoGravity, 5 блоков над полом), только меч:
//     [ OK ] бой не висит до таймаута, а встаёт со словами «нужен лук ... или
//     снежки» — прибор честно говорит, чего не хватает.
// (в) Тот же висящий, плюс 16 снежков: [ OK ] убит (снежок по блейзу — 3
//     урона, 7 штук на блейза), снежков потрачено >= 7.
//
// Запуск: node try-blaze-rods.js (демон NeuroNether на 8772).
const path = require('path')
const { connect, createKit, sleep } = require('./scene-kit')

const WS = process.env.ND_WS || 'ws://127.0.0.1:8772'
const PLAYER = process.env.MC_USERNAME || 'NeuroNether'
const LOG = process.env.ND_SERVER_LOG || path.join(__dirname, '..', 'server-nether', 'logs', 'latest.log')
const conn = connect(WS)
const call = conn.call
const kit = createKit({ call, heard: conn.heard, logFile: LOG, player: PLAYER })

const CX = -200
const CZ = -200
const FY = 64 // пол
const FLOOR = 'polished_blackstone'
const SPAWNER = { x: CX, y: FY + 2, z: CZ + 3 }
const START = `${CX + 0.5} ${FY + 1} ${CZ - 4 + 0.5}`
const ONLY = (process.argv[2] || 'абвг')
const RODS = Number(process.env.RODS || 3)

let failures = 0
function check (what, ok, saw) {
  if (!ok) failures++
  console.log(`   [${ok ? ' OK ' : 'ПЛОХО'}] ${what}${saw === undefined ? '' : ` — вижу ${typeof saw === 'string' ? saw : JSON.stringify(saw)}`}`)
  return ok
}
const header = async () => ((await call('status')) || {} as Record<string, any>).state || {} as Record<string, any>
const inv = async n => ((await header()).inventory || {} as Record<string, any>)[n] || 0
const nether = c => `/execute in minecraft:the_nether run ${c.replace(/^\//, '')}`
async function mobs (name) {
  const o = await call('observe', { radius: 24, fair: false })
  return (((o && o.detail) || {} as Record<string, any>).entities || []).filter(e => e.name === name || e.name === name.replace(/^./, c => c.toUpperCase()))
}
async function rodsOnGround () {
  const o = await call('observe', { radius: 8, fair: false })
  return (((o && o.detail) || {} as Record<string, any>).entities || []).filter(e => /Blaze Rod/i.test(e.name)).length
}

async function arena () {
  await kit.gamerule('spawn_mobs', 'false')
  await kit.gamerule('spawner_blocks_work', 'true')
  await kit.setDifficulty('normal')
  await kit.forceload('the_nether', [[CX - 12, FY, CZ - 12], [CX + 12, FY, CZ + 12]])
  await kit.fillExact('the_nether', [[CX - 10, FY, CZ - 10], [CX + 10, FY + 12, CZ + 10]], FLOOR)
  await kit.fillExact('the_nether', [[CX - 9, FY + 1, CZ - 9], [CX + 9, FY + 11, CZ + 9]], 'air')
  // Коридор с поворотом из западной стены: укрытие, где блейзы из комнаты не
  // видят (отдых blaze.js rest). Как коридор крепости у тронного зала.
  await kit.fillExact('the_nether', [[CX - 18, FY, CZ - 7], [CX - 11, FY + 4, CZ + 2]], FLOOR)
  await kit.fillExact('the_nether', [[CX - 16, FY + 1, CZ], [CX - 10, FY + 3, CZ + 1]], 'air')
  await kit.fillExact('the_nether', [[CX - 16, FY + 1, CZ - 5], [CX - 15, FY + 3, CZ - 1]], 'air')
  await kit.cmd('/effect give @s minecraft:slow_falling 10 0 true')
  await kit.ensureWorld('the_nether', { tp: START, floor: FLOOR })
  await kit.cmd(nether(`kill @e[type=!player,x=${CX - 10},y=${FY},z=${CZ - 10},dx=20,dy=12,dz=20]`))
}

async function kitUp (extra = []) {
  // Куча прошлого случая (лук, стрелы) на полу арены подобралась бы в «только
  // меч» — так (б) третьего прогона убил висящего стрелами.
  await kit.cmd(nether(`kill @e[type=minecraft:item,x=${CX - 18},y=${FY},z=${CZ - 10},dx=28,dy=12,dz=20]`))
  await kit.cmd('/clear @s')
  for (const g of ['iron_helmet', 'iron_chestplate', 'iron_leggings', 'iron_boots', 'iron_sword', 'shield', 'cooked_beef 16', ...extra]) {
    await kit.cmd(`/give @s minecraft:${g}`)
  }
  await kit.cmd('/effect clear @s')
  await kit.cmd('/effect give @s minecraft:instant_health 1 5 true')
  await kit.cmd('/effect give @s minecraft:saturation 1 20 true')
  await sleep(1500)
  await call('armor', {} as Record<string, any>)
}

conn.ready.then(async () => {
  await call('connect')
  await call('stop')
  try {
    await arena()
    if (ONLY.includes('а')) {
      console.log(`(а) спавнер, полный набор, count=${RODS}`)
      await kitUp(['bow', 'arrow 64', 'snowball 16', 'potion[potion_contents={potion:"minecraft:long_fire_resistance"}]'])
      await kit.cmd(nether(`setblock ${SPAWNER.x} ${SPAWNER.y} ${SPAWNER.z} minecraft:air`))
      await kit.cmd(nether(`setblock ${SPAWNER.x} ${SPAWNER.y} ${SPAWNER.z} minecraft:spawner{SpawnData:{entity:{id:"minecraft:blaze"}},Delay:20}`))
      await kit.cmd(nether(`summon minecraft:blaze ${SPAWNER.x + 0.5} ${SPAWNER.y} ${SPAWNER.z - 1.5}`))
      await sleep(1500)
      const seen = await mobs('blaze')
      check('(а) блейз в мире перед замером (observe fair:false)', seen.length > 0, seen.map(e => `${e.name} ${e.dist}`))
      const before = await inv('blaze_rod')
      const t0 = gameClock.now()
      const r = await call('blaze', { count: RODS, timeoutSeconds: 400 })
      const d = r.detail || {} as Record<string, any>
      const after = await inv('blaze_rod')
      const h = await header()
      console.log(`   blaze: ${r.status}${r.error ? ' ' + r.error : ''} за ${Math.round((gameClock.now() - t0) / 1000)}с — ${d.stopped || ''} ${d.note || ''}`)
      console.log(`   убито ${d.kills}, стержней +${d.rods && d.rods.gained}, хп потеряно ${d.hpLost}, снежки ${JSON.stringify(d.snowballs)}, бои ${JSON.stringify(d.fights)}`)
      console.log(`   отдых ${JSON.stringify(d.rests)}, укрытия ${JSON.stringify(d.covers)}, еда ${JSON.stringify(d.ate)}`)
      // Смерть, оборвавшая намерение, приезжает в r.by, а не в событиях
      // (session.js runIntent вычитает её из списка) — считать обе.
      const deaths = kit.between(t0, gameClock.now(), 'death').length + (r.by && r.by.type === 'death' ? 1 : 0)
      if (r.by) console.log(`   оборвано событием ${r.by.type}`)
      check('(а) смерти в окне нет', deaths === 0 && h.health > 0, deaths)
      check(`(а) стержней прибавилось >= ${RODS}`, after - before >= RODS, `${before} → ${after}`)
      check('(а) detail.rods.gained равен разнице рюкзака', d.rods && d.rods.gained === after - before, d.rods)
      const lying = await rodsOnGround()
      check('(а) на земле в 8 блоках стержней не осталось', lying === 0, lying)
      console.log(`   на убийство: ${d.perKill} (игра: 0..1, в среднем 0.5); спавнер ${JSON.stringify(d.spawner)}; зелье: ${d.potion}`)
      check('(а) огнестойкость выпита до боя', /fire_resistance|действует/.test(d.potion || ''), d.potion)
    }

    if (ONLY.includes('г')) {
      // Без огнестойкости те же 4–5 блейзов разом снимают 20 хп за ~8 с
      // открытого стояния. Здесь вердикт — не стержни, а жизнь: либо набрал,
      // либо честно бросил бой и ушёл, но не умер.
      console.log(`(г) спавнер, без огнестойкости, count=${RODS}`)
      await kit.ensureWorld('the_nether', { tp: START, floor: FLOOR })
      await kit.cmd(nether(`kill @e[type=minecraft:blaze,x=${CX - 10},y=${FY},z=${CZ - 10},dx=20,dy=12,dz=20]`))
      await kitUp(['bow', 'arrow 64', 'snowball 16'])
      await kit.cmd(nether(`setblock ${SPAWNER.x} ${SPAWNER.y} ${SPAWNER.z} minecraft:air`))
      await kit.cmd(nether(`setblock ${SPAWNER.x} ${SPAWNER.y} ${SPAWNER.z} minecraft:spawner{SpawnData:{entity:{id:"minecraft:blaze"}},Delay:20}`))
      await sleep(1500)
      const before = await inv('blaze_rod')
      const t0 = gameClock.now()
      const r = await call('blaze', { count: RODS, timeoutSeconds: 300 })
      const d = r.detail || {} as Record<string, any>
      const after = await inv('blaze_rod')
      const h = await header()
      const deaths = kit.between(t0, gameClock.now(), 'death').length + (r.by && r.by.type === 'death' ? 1 : 0)
      console.log(`   blaze: ${r.status} за ${Math.round((gameClock.now() - t0) / 1000)}с — ${d.stopped || d.note || ''}`)
      console.log(`   убито ${d.kills}, стержней +${d.rods && d.rods.gained}, хп ${h.health}, укрытия ${JSON.stringify(d.covers)}, отдых ${JSON.stringify(d.rests)}, бег ${JSON.stringify(d.fled)}`)
      check('(г) не умер', deaths === 0 && h.health > 0, `смертей ${deaths}, хп ${h.health}`)
      check('(г) либо набрал, либо назвал, почему бросил', after - before >= RODS || (typeof d.stopped === 'string' && d.stopped.length > 10), d.stopped || `${before} → ${after}`)
      check('(г) detail.rods.gained равен разнице рюкзака', d.rods && d.rods.gained === after - before, d.rods)
    }
    // Спавнер убрать: дальше замеры на одном призванном блейзе.
    await kit.cmd(nether(`setblock ${SPAWNER.x} ${SPAWNER.y} ${SPAWNER.z} minecraft:air`))
    await kit.cmd(nether(`kill @e[type=minecraft:blaze,x=${CX - 10},y=${FY},z=${CZ - 10},dx=20,dy=12,dz=20]`))

    if (ONLY.includes('б')) {
      console.log('(б) висящий блейз, только меч')
      await kit.ensureWorld('the_nether', { tp: START, floor: FLOOR })
      await kitUp([])
      await kit.cmd(nether(`summon minecraft:blaze ${CX + 0.5} ${FY + 7} ${CZ + 2.5} {NoAI:1b,NoGravity:1b,PersistenceRequired:1b}`))
      await sleep(1000)
      const seen = await mobs('blaze')
      check('(б) висящий блейз в мире', seen.length === 1, seen.map(e => `${e.name} y=${e.pos && e.pos.y}`))
      const t0 = gameClock.now()
      const r = await call('blaze', { count: 1, timeoutSeconds: 150 })
      const d = r.detail || {} as Record<string, any>
      const secs = Math.round((gameClock.now() - t0) / 1000)
      console.log(`   blaze: ${r.status} за ${secs}с — ${d.stopped || ''}; бои ${JSON.stringify(d.fights)}`)
      check('(б) встал со словами «нужен лук ... или снежки», а не по таймауту', r.status === 'done' && /лук|снежк/.test(d.stopped || ''), d.stopped)
    }

    if (ONLY.includes('в')) {
      console.log('(в) тот же висящий, плюс снежки')
      await kit.ensureWorld('the_nether', { tp: START, floor: FLOOR })
      await kitUp(['snowball 16'])
      const had = (await mobs('blaze')).length
      if (!had) await kit.cmd(nether(`summon minecraft:blaze ${CX + 0.5} ${FY + 7} ${CZ + 2.5} {NoAI:1b,NoGravity:1b,PersistenceRequired:1b}`))
      await sleep(800)
      const t0 = gameClock.now()
      const r = await call('blaze', { count: 1, timeoutSeconds: 120 })
      const d = r.detail || {} as Record<string, any>
      const left = await inv('snowball')
      const alive = await mobs('blaze')
      console.log(`   blaze: ${r.status} за ${Math.round((gameClock.now() - t0) / 1000)}с — ${d.stopped || d.note}; снежки ${JSON.stringify(d.snowballs)}`)
      check('(в) висящий блейз убит', alive.length === 0 && d.kills >= 1, `живых ${alive.length}, убито ${d.kills}`)
      check('(в) снежков ушло >= 7 (3 урона из 20 хп)', 16 - left >= 7, 16 - left)
    }
  } catch (e) {
    failures++
    console.log('   [ПЛОХО] сцена оборвалась:', e.message)
  } finally {
    try { await call('stop') } catch {}
    try { await kit.cmd(nether(`kill @e[type=minecraft:blaze,x=${CX - 10},y=${FY},z=${CZ - 10},dx=20,dy=12,dz=20]`)) } catch {}
    try { await kit.gamerule('spawn_mobs', 'true') } catch {}
    console.log(failures ? `\nИТОГ: ПЛОХО — ${failures}` : '\nИТОГ: всё зелёное')
    if (failures) process.exitCode = 1
    conn.close()
  }
}).catch(e => { console.error('ws:', e.message); process.exitCode = 1 })
