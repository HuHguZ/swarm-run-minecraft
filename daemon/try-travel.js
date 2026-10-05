'use strict'
const gameClock = require('./src/game-clock')
// Срез 3 (NETHER.md): портал туда и обратно, одним вызовом mc_portal mode=enter
// в каждую сторону. Ложь, которую ловит сцена: «простоял в портале» вместо
// «перешёл». Переход засчитывается только по смене мира в шапке И по полу,
// которого в другом мире нет; стояние — число в отчёте, а не вердикт.
//
// Сервер свой (server-nether, 25567): рама ставится командами, поджигает её
// сам бот (ветка «готовая рама без огня»), а портал прибытия в Аду строит
// СЕРВЕР — так, как он построит его в настоящей игре.
//
// (г) Отказ без огнива: need, смещение 0, мир тот же.
// (а) Туда: мир the_nether по шапке и по полу (не polished_andesite), вне клеток
//     портала прибытия, heldSeconds >= 3, через 20 с всё ещё Ад (нет отскока),
//     в памяти две записи с разными dimension и leadsTo, огниво в рюкзаке.
// (в) Обратно: верхний мир в 4 блоках от своей рамы, на своём полу.
// (е) Стоп посреди стояния: через 8 с тело в верхнем мире и НЕ в портале.
//     Контроль, способный покраснеть: стоп шлётся, только когда шапка показала
//     тело в клетке портала.
// (ж) Красный контроль свидетеля: allow_entering_nether_using_portals false —
//     went:false и «ПЕРЕХОДА НЕТ». Реализация, верящая времени в портале,
//     краснеет здесь.
//
// Запуск: node try-travel.js (демон NeuroNether на 8772, restart-nether.ps1).
const fs = require('fs')
const path = require('path')
const { connect, createKit, describe, sleep } = require('./scene-kit')

const WS = process.env.ND_WS || 'ws://127.0.0.1:8772'
const PLAYER = process.env.MC_USERNAME || 'NeuroNether'
const LOG = process.env.ND_SERVER_LOG || path.join(__dirname, '..', 'server-nether', 'logs', 'latest.log')
const MEM = path.join(process.env.ND_MEMORY_DIR || path.join(__dirname, '..', 'memory-nether'), 'state.json')

const conn = connect(WS)
const call = conn.call
const kit = createKit({ call, heard: conn.heard, logFile: LOG, player: PLAYER })

// Верхний мир: площадка в небе, чтобы рельеф не решал за сцену. Ад: где
// сервер сам поставит портал прибытия (около X/8, Z/8).
const X = 800
const Y = 120
const Z = 800
const FLOOR = 'polished_andesite'
// Рама по оси x в плоскости z=Z: дырка 2x3 (x X..X+1, y Y+1..Y+3).
const INNER = []
for (let dx = 0; dx < 2; dx++) for (let dy = 1; dy <= 3; dy++) INNER.push({ x: X + dx, y: Y + dy, z: Z })
const START = `${X + 0.5} ${Y + 1} ${Z - 4 + 0.5}`

let failures = 0
function check (what, ok, saw) {
  if (!ok) failures++
  console.log(`   [${ok ? ' OK ' : 'ПЛОХО'}] ${what}${saw === undefined ? '' : ` — вижу ${typeof saw === 'string' ? saw : JSON.stringify(saw)}`}`)
  return ok
}
const header = async () => ((await call('status')) || {}).state || {}
const memory = () => { try { return JSON.parse(fs.readFileSync(MEM, 'utf8')) } catch { return {} } }
const inCells = (pos, cells) => !!pos && cells.some(c => c.x === pos.x && (c.y === pos.y || c.y === pos.y + 1) && c.z === pos.z)
const floorUnder = async () => ((((await call('observe', { radius: 4, fair: false })) || {}).detail || {}).terrain || {}).standingOn || null

async function arena () {
  await kit.must('/clear @s', /^(Removed|No items were found)/, 'рюкзак не очищен').catch(() => {})
  await kit.gamerule('spawn_mobs', 'false')
  await kit.gamerule('allow_entering_nether_using_portals', 'true')
  await kit.setDifficulty('normal')
  await kit.forceload('overworld', [[X - 8, Y, Z - 8], [X + 8, Y, Z + 8]])
  await kit.fillExact('overworld', [[X - 6, Y + 1, Z - 6], [X + 6, Y + 6, Z + 6]], 'air')
  await kit.fillExact('overworld', [[X - 6, Y, Z - 6], [X + 6, Y, Z + 6]], FLOOR)
  // Рама: низ, два столба, верх — 10 обсидиана, углы пустые.
  await kit.fillExact('overworld', [[X, Y, Z], [X + 1, Y, Z]], 'obsidian')
  await kit.fillExact('overworld', [[X - 1, Y + 1, Z], [X - 1, Y + 3, Z]], 'obsidian')
  await kit.fillExact('overworld', [[X + 2, Y + 1, Z], [X + 2, Y + 3, Z]], 'obsidian')
  await kit.fillExact('overworld', [[X, Y + 4, Z], [X + 1, Y + 4, Z]], 'obsidian')
  // Свет, чтобы ночью на площадке никто не завёлся, и точка возрождения своя.
  await kit.cmd(`/setblock ${X - 5} ${Y + 1} ${Z - 5} minecraft:light[level=15]`)
  await kit.cmd(`/setblock ${X + 5} ${Y + 1} ${Z + 5} minecraft:light[level=15]`)
  await kit.cmd('/effect give @s minecraft:slow_falling 20 0 true')
  await kit.ensureWorld('overworld', { tp: START, floor: FLOOR })
  await kit.cmd(`/spawnpoint @s ${X} ${Y + 1} ${Z - 4}`)
  for (const g of ['iron_helmet', 'iron_chestplate', 'iron_leggings', 'iron_boots', 'iron_sword', 'bread 16', 'flint_and_steel']) {
    await kit.cmd(`/give @s minecraft:${g}`)
  }
  await kit.cmd('/effect clear @s')
  await sleep(1500)
}

async function enter (label) {
  const t0 = gameClock.now()
  const r = await call('portal', { mode: 'enter', timeoutSeconds: 90 })
  const d = r.detail || {}
  console.log(`   ${label}: ${r.status}${r.error ? ' ' + r.error : ''} за ${Math.round((gameClock.now() - t0) / 100) / 10}с — ${d.stopped || d.note || ''}`)
  return { r, d, t0, t1: gameClock.now() }
}

conn.ready.then(async () => {
  await call('connect')
  await call('stop')
  try {
    // Начать в верхнем мире, чем бы ни кончилась прошлая сцена.
    const h0 = await header()
    if (h0.dimension !== 'overworld') await kit.must(`/execute in minecraft:overworld run tp @s ${START}`, /^Teleported /, 'возврат в верхний мир')
    await arena()
    // Память портала — чистая: сцена проверяет, что пишет именно этот прогон.
    await call('portal', { mode: 'forget', world: 'overworld' })
    await call('portal', { mode: 'forget', world: 'the_nether' })

    console.log('(г) отказ без огнива')
    await kit.cmd('/clear @s minecraft:flint_and_steel')
    await sleep(500)
    const before = await header()
    const g = await enter('enter без огнива')
    const after = await header()
    check('(г) went:false и need flint_and_steel', g.d.went === false && g.d.need && g.d.need.what === 'flint_and_steel', g.d.need)
    check('(г) тело не сдвинулось и мир тот же', after.dimension === 'overworld' && Math.abs(after.pos.x - before.pos.x) + Math.abs(after.pos.z - before.pos.z) === 0, `${before.pos.x},${before.pos.z} → ${after.pos.x},${after.pos.z}`)
    await kit.cmd('/give @s minecraft:flint_and_steel')
    await sleep(500)

    console.log('(а) туда')
    const a = await enter('enter туда')
    const hA = await header()
    const floorA = await floorUnder()
    const inNether = check('(а) шапка: the_nether, под ногами не пол верхней арены', hA.dimension === 'the_nether' && floorA && floorA !== FLOOR, `${hA.dimension}, ${floorA}`)
    check('(а) detail.to.world согласен с шапкой', a.d.to && a.d.to.world === hA.dimension, a.d.to)
    check('(а) рама зажжена самим ботом (ветка готовой рамы)', !!(a.d.lit && a.d.lit.portalBlocks === 6), a.d.lit)
    check('(а) heldSeconds >= 3 (переход не мгновенный — иначе отчёт врёт)', typeof a.d.heldSeconds === 'number' && a.d.heldSeconds >= 3, a.d.heldSeconds)
    const arrivalCells = a.d.arrivalPortal ? (() => {
      const o = a.d.arrivalPortal.inner; const out = []
      for (let i = 0; i < 2; i++) for (let dy = 0; dy < 3; dy++) out.push(a.d.arrivalPortal.axis === 'x' ? { x: o.x + i, y: o.y + dy, z: o.z } : { x: o.x, y: o.y + dy, z: o.z + i })
      return out
    })() : []
    check('(а) вышел из портала прибытия', !!a.d.out && !a.d.inPortal && !inCells(hA.pos, arrivalCells), { out: a.d.out, pos: hA.pos })
    const dimEv = kit.between(a.t0, a.t1, 'dimension')
    check('(а) событие dimension с via=portal и ready', dimEv.some(e => e.to === 'the_nether' && e.via === 'portal' && e.ready), dimEv.map(e => `${e.from}→${e.to} ${e.via} ready=${e.ready} ${e.ms}мс purged=${e.purged}`))
    console.log(`   прибытие: предсказано ${JSON.stringify(a.d.predicted)}, портал сервера ${JSON.stringify(a.d.arrivalPortal)}, вокруг ${JSON.stringify(a.d.around)}`)
    if (inNether) {
      await sleep(20000)
      const h20 = await header()
      check('(а) через 20 с всё ещё Ад (нет отскока)', h20.dimension === 'the_nether', h20.dimension)
    }
    const m1 = memory().places || {}
    const up = m1['портал']; const down = m1['портал (ад)']
    check('(а) в памяти «портал» верхнего мира у своей рамы, не затёрт', !!up && (up.dimension || 'overworld') === 'overworld' && Math.abs(up.x - X) <= 3 && Math.abs(up.z - Z) <= 3, up && { x: up.x, y: up.y, z: up.z, dimension: up.dimension })
    check('(а) «портал (ад)» с dimension the_nether', !!down && down.dimension === 'the_nether', down && { x: down.x, y: down.y, z: down.z, dimension: down.dimension })
    check('(а) пара связана leadsTo в обе стороны', !!(up && down && up.leadsTo && down.leadsTo && up.leadsTo.world === 'the_nether' && down.leadsTo.world === 'overworld'), { up: up && up.leadsTo, down: down && down.leadsTo })
    check('(а) огниво в рюкзаке, смерти в окне нет', (hA.inventory || {}).flint_and_steel >= 1 && kit.between(a.t0, gameClock.now(), 'death').length === 0, hA.inventory && hA.inventory.flint_and_steel)
    const whereR = await call('portal', { mode: 'where' })
    console.log(`   where из Ада: ${(whereR.detail || {}).note}`)

    console.log('(в) обратно')
    const v = await enter('enter обратно')
    const hV = await header()
    const floorV = await floorUnder()
    check('(в) шапка: overworld, на своём полу', hV.dimension === 'overworld' && floorV === FLOOR, `${hV.dimension}, ${floorV}`)
    check('(в) в 4 блоках от своей рамы', Math.abs(hV.pos.x - X) <= 4 && Math.abs(hV.pos.z - Z) <= 4, hV.pos)
    check('(в) не в клетке портала', !inCells(hV.pos, INNER), hV.pos)
    const m2 = memory().places || {}
    check('(в) у обеих записей leadsTo, верхняя не переехала', !!(m2['портал'] && m2['портал (ад)'] && m2['портал'].leadsTo && m2['портал (ад)'].leadsTo && Math.abs(m2['портал'].x - X) <= 3), { up: m2['портал'] && m2['портал'].leadsTo, down: m2['портал (ад)'] && m2['портал (ад)'].leadsTo })

    console.log('(е) стоп посреди стояния')
    await kit.ensureWorld('overworld', { tp: START, floor: FLOOR })
    await sleep(1000)
    const pending = call('portal', { mode: 'enter', timeoutSeconds: 60 })
    let stoppedInside = false
    const tE = gameClock.now()
    while (gameClock.now() - tE < 15000) {
      const h = await header()
      if (h.dimension !== 'overworld') break
      if (inCells(h.pos, INNER)) { await call('stop'); stoppedInside = true; break }
      await sleep(150)
    }
    const pe = await pending.catch(e => ({ error: e.message }))
    console.log(`   enter (е): ${pe && pe.status} ${JSON.stringify((pe && pe.detail) || {}).slice(0, 300)}`)
    await sleep(8000)
    const hE = await header()
    check('(е) стоп дошёл, когда тело было в портале', stoppedInside, stoppedInside ? 'в клетке портала' : 'ни разу не видел тело в портале')
    check('(е) через 8 с после стопа — верхний мир и не в портале', hE.dimension === 'overworld' && !inCells(hE.pos, INNER), `${hE.dimension} ${JSON.stringify(hE.pos)}`)

    console.log('(ж) красный контроль свидетеля: портал не пускает')
    await kit.gamerule('allow_entering_nether_using_portals', 'false')
    await kit.ensureWorld('overworld', { tp: START, floor: FLOOR })
    const zh = await enter('enter при запрете')
    const hZ = await header()
    check('(ж) went:false и «ПЕРЕХОДА НЕТ», мир тот же', zh.d.went === false && /ПЕРЕХОДА НЕТ/.test(zh.d.stopped || '') && hZ.dimension === 'overworld', `${zh.d.went} / ${hZ.dimension} / held ${zh.d.heldSeconds}`)
    check('(ж) простоял долго, а перехода не засчитал', (zh.d.heldSeconds || 0) >= 10, zh.d.heldSeconds)
    check('(ж) после отказа тело не в портале', !inCells(hZ.pos, INNER), hZ.pos)
  } catch (e) {
    failures++
    console.log('   [ПЛОХО] сцена оборвалась:', e.message)
  } finally {
    try { await call('stop') } catch {}
    try { await kit.gamerule('allow_entering_nether_using_portals', 'true') } catch (e) { console.log('   правило портала не вернул:', e.message) }
    try {
      const h = await header()
      if (h.dimension !== 'overworld') await kit.cmd(`/execute in minecraft:overworld run tp @s ${START}`)
    } catch {}
    try { await kit.gamerule('spawn_mobs', 'true') } catch {}
    console.log(failures ? `\nИТОГ: ПЛОХО — ${failures}` : '\nИТОГ: всё зелёное')
    if (failures) process.exitCode = 1
    conn.close()
  }
}).catch(e => { console.error('ws:', e.message); process.exitCode = 1 })
