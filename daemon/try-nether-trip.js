'use strict'
// Поход в настоящий Ад целиком (NETHER.md срез 7) — той же цепочкой вызовов,
// какой пошёл бы автомат (director.js), без арены: свой портал в верхнем мире
// (try-travel.js X=800) → portal enter → fortress без mode (обход регионов
// nether_complexes змейкой от портала, до 6 вызовов по 300 с) → blaze {rods: 7} (сам идёт к крепости и обходит её до
// спавнера) → portal enter домой (дорога к порталу — по записи «портал (ад)»,
// отрезками и штреком). Перед поиском — fortress forget: память арен
// try-fortress/try-blaze-rods не должна подсказывать.
//
// Вердикты — только то, что обязан код при любом рельефе: [ OK ] в Аду после
// перехода; [ OK ] смертей за весь поход нет; [ OK ] в конце — верхний мир у
// своей рамы. Нашёл ли крепость, сколько прошёл, сколько стержней — числа:
// ближайшая крепость на этом сервере — /locate (288, ~, 304), в 277 блоках от
// портала прибытия по диагонали, и рельеф между ними настоящий.
//
// Скромный набор (всё добывается наверху): железо + золотой шлем, меч, щит,
// лук и стрелы, 16 снежков, железная и каменная кирки (одной железной на
// поход не хватило: 250 копаний ушло на дорогу по netherrack), еда, огниво,
// булыжник. Зелья
// огнестойкости — только ND_TRIP_POTIONS=1; ND_TRIP_RODS — сколько стержней (7).
//
// Запуск: node try-nether-trip.js (демон NeuroNether на 8772; try-travel.js
// должен был хоть раз пройти — рама на X=800).
const path = require('path')
const { connect, createKit, sleep } = require('./scene-kit')

const WS = process.env.ND_WS || 'ws://127.0.0.1:8772'
const PLAYER = process.env.MC_USERNAME || 'NeuroNether'
const LOG = process.env.ND_SERVER_LOG || path.join(__dirname, '..', 'server-nether', 'logs', 'latest.log')
const conn = connect(WS)
const call = conn.call
const kit = createKit({ call, heard: conn.heard, logFile: LOG, player: PLAYER })
const HOME = { x: 800, y: 121, z: 800 }
const RODS = Number(process.env.ND_TRIP_RODS || 7)

let failures = 0
let deaths = 0
function check (what, ok, saw) {
  if (!ok) failures++
  console.log(`   [${ok ? ' OK ' : 'ПЛОХО'}] ${what}${saw === undefined ? '' : ` — вижу ${typeof saw === 'string' ? saw : JSON.stringify(saw)}`}`)
  return ok
}
const header = async () => ((await call('status')) || {}).state || {}
async function step (label, method, params) {
  const t0 = Date.now()
  const r = await call(method, params)
  const d = r.detail || {}
  if (r.by && r.by.type === 'death') deaths++
  deaths += (r.events || []).filter(e => e.type === 'death').length
  const h = r.state || {}
  console.log(`   ${label}: ${r.status}${r.error ? ' ' + r.error : ''} за ${Math.round((Date.now() - t0) / 1000)}с, ` +
    `${h.dimension} ${h.pos ? `${h.pos.x},${h.pos.y},${h.pos.z}` : ''} хп ${h.health} — ${d.stopped || ''} ${d.note || ''}`.slice(0, 600))
  return { r, d }
}

// Как сделал бы мозг между вызовами: мало хп — поесть и подождать, а не звать
// ту же работу снова на 4 хп (второй прогон: fortress #2 на 4 хп — смерть).
async function mend () {
  let h = await header()
  if ((h.health || 0) >= 14) return
  await step('eat', 'eat', {})
  for (let i = 0; i < 6 && (h.health || 0) < 16; i++) {
    await call('wait', { seconds: 10 })
    h = await header()
  }
  console.log(`   подлечился: хп ${h.health}, еда ${h.food}`)
}

conn.ready.then(async () => {
  await call('connect')
  await call('stop')
  try {
    await kit.gamerule('spawn_mobs', 'true')
    await kit.setDifficulty('normal')
    // ND_TRIP_FROM=blaze — продолжение с того места, где тело уже стоит в Аду
    // у найденной крепости (память «крепость (ад)» цела): без набора, портала
    // и поиска. Для отладки второй половины; честный прогон — без него.
    let h0 = await header()
    for (let i = 0; i < 20 && !h0.dimension; i++) { await sleep(500); h0 = await header() }
    const fromBlaze = process.env.ND_TRIP_FROM === 'blaze' && h0.dimension === 'the_nether'
    if (process.env.ND_TRIP_FROM === 'blaze' && !fromBlaze) throw new Error('ND_TRIP_FROM=blaze, а тело не в Аду (' + h0.dimension + ') — продолжать нечего')
    if (!fromBlaze) {
    await kit.cmd('/effect give @s minecraft:slow_falling 20 0 true')
    await kit.ensureWorld('overworld', { tp: `${HOME.x + 0.5} ${HOME.y} ${HOME.z - 4 + 0.5}`, floor: 'polished_andesite' })
    await kit.cmd('/clear @s')
    // Скромный набор без чита: всё это добывается в верхнем мире (зелий
    // огнестойкости до Ада не сварить — только ND_TRIP_POTIONS=1 для сравнения).
    const gear = ['iron_chestplate', 'iron_leggings', 'iron_boots', 'golden_helmet', 'iron_sword', 'bow', 'arrow 64',
      'iron_pickaxe', 'stone_pickaxe', 'cooked_beef 32', 'flint_and_steel', 'cobblestone 64', 'shield', 'snowball 16']
    if (process.env.ND_TRIP_POTIONS === '1') gear.push('potion[potion_contents={potion:"minecraft:long_fire_resistance"}] 2')
    for (const g of gear) {
      await kit.cmd(`/give @s minecraft:${g}`)
    }
    await sleep(1000)
    await call('armor', {})

    console.log('1. портал туда')
    await step('portal enter', 'portal', { mode: 'enter', timeoutSeconds: 90 })
    const h1 = await header()
    check('в Аду после перехода', h1.dimension === 'the_nether', h1.dimension)
    if (h1.dimension !== 'the_nether') throw new Error('перехода нет — дальше нечего мерить')

    }
    console.log('2. крепость: без mode — как автомат (обход регионов от портала, продолжает с того же места)')
    if (!fromBlaze) await step('fortress forget', 'fortress', { mode: 'forget' })
    let f = { d: {} }
    for (let i = 0; i < 6 && !f.d.found; i++) {
      await mend()
      f = await step(`fortress #${i + 1}`, 'fortress', { timeoutSeconds: 300 })
      if (deaths) break
    }
    console.log(`   крепость: ${JSON.stringify(f.d.fortress)}, спавнеры ${JSON.stringify(f.d.spawners)}, пройдено ${f.d.walked}, обход ${JSON.stringify(f.d.search)}`)
    check('крепость найдена', !!f.d.found, f.d.fortress)

    let rods = 0
    if (f.d.found && !deaths) {
      console.log(`3. блейзы: rods ${RODS} (сам дойдёт до тронного зала по видимому кирпичу)`)
      for (let i = 0; i < 3; i++) {
        await mend()
        const b = await step(`blaze #${i + 1}`, 'blaze', { rods: RODS, timeoutSeconds: 500 })
        console.log(`   стержни ${JSON.stringify(b.d.rods)}, убито ${b.d.kills}, обход ${JSON.stringify(b.d.toured)}, зелье ${b.d.potion}`)
        rods = b.d.rods ? b.d.rods.now : rods
        if (!b.d.rods || b.d.rods.now >= RODS || deaths || ((b.r.state || {}).health || 0) < 8) break
      }
    }
    console.log(`   стержней в рюкзаке: ${rods} из ${RODS}`)

    console.log('4. домой через свой портал')
    await step('portal where', 'portal', { mode: 'where' })
    let home = await step('portal enter', 'portal', { mode: 'enter', timeoutSeconds: 300 })
    if (!home.d.went && home.d.awayBlocks) home = await step('portal enter (ещё)', 'portal', { mode: 'enter', timeoutSeconds: 300 })
    const h4 = await header()
    check('в конце — верхний мир у своей рамы', h4.dimension === 'overworld' && Math.abs(h4.pos.x - HOME.x) <= 5 && Math.abs(h4.pos.z - HOME.z) <= 5, `${h4.dimension} ${JSON.stringify(h4.pos)}`)
    check('смертей за поход нет', deaths === 0, deaths)
  } catch (e) {
    failures++
    console.log('   [ПЛОХО] сцена оборвалась:', e.message)
  } finally {
    try { await call('stop') } catch {}
    try {
      const h = await header()
      if (h.dimension !== 'overworld') {
        await kit.cmd('/effect give @s minecraft:slow_falling 20 0 true')
        await kit.cmd(`/execute in minecraft:overworld run tp @s ${HOME.x + 0.5} ${HOME.y} ${HOME.z - 4 + 0.5}`)
      }
    } catch {}
    console.log(failures ? `\nИТОГ: ПЛОХО — ${failures}` : '\nИТОГ: всё зелёное')
    if (failures) process.exitCode = 1
    conn.close()
  }
}).catch(e => { console.error('ws:', e.message); process.exitCode = 1 })
