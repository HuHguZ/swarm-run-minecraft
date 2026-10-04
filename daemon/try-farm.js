'use strict'
// Грядки: mc_farm (src/farm.js) — полный цикл от травы до урожая.
//
// Что здесь проверяется и почему именно это:
//
//  А. ПОЛЕ С НУЛЯ (plot): трава с травинками сверху, ведро воды, мотыга,
//     семена. Тело выкапывает лунку, льёт воду, срезает траву, пашет квадрат
//     9×9 вокруг и сажает. Судит не ответ демона, а второй клиент — зритель
//     FarmEye в режиме наблюдателя: грядок 80, вода в центре, посевов 80.
//  Б. КОСТНАЯ МУКА: стадии age растут у тех, кого удобрили (сумма стадий по
//     полю, зритель).
//  В. РОСТ И СБОР: random_tick_speed поднят — посевы растут сами, по-настоящему.
//     Сбор снимает только спелое (age = максимум из данных блока) и сразу
//     сажает обратно: после сбора на грядках снова посевы, грядок по-прежнему
//     80 (не вытоптаны — по полю тело ходит без прыжков, FarmBlock.fallOn).
//  Г. ТРОСТНИК: посадить у воды на песок, дать вырасти, срезать — корни
//     остались все, выше корня пусто, тростник в рюкзаке.
//  Д. АРБУЗ И ТЫКВА: стебли на грядке, плоды выросли рядом; сбор ломает плод,
//     стебель остаётся.
//  Е. ОТКАЗ: сухая земля без воды в 4 блоках — не пашет, говорит почему, мир
//     не тронут (зритель: грядок ноль).
//
// Запуск: node try-farm.js (всё, ~6 мин) или ONLY=plot,grow node try-farm.js.
// Сервер — свой, build (127.0.0.1:25566), демон ND_WS (ws://127.0.0.1:8771),
// игрок NeuroBuild — оператор.
const path = require('path')
const mineflayer = require('mineflayer')
const Vec3 = require('vec3')
const { connect, createKit, sleep } = require('./scene-kit')

const WS = process.env.ND_WS || 'ws://127.0.0.1:8771'
const PLAYER = process.env.ND_PLAYER || 'NeuroBuild'
const HOST = process.env.MC_HOST || '127.0.0.1'
const PORT = Number(process.env.MC_PORT || 25566)
const LOG = process.env.ND_SERVER_LOG || path.join(__dirname, '..', process.env.ND_SERVER_DIR || 'server-build', 'logs', 'latest.log')
const ONLY = process.env.ONLY ? process.env.ONLY.split(',') : null

const Y = 120
// Равнины. Рядом снежные: открытая вода там замерзает под случайными тиками
// (Biome.shouldFreeze, свет блоков < 10), и тростник у льда осыпается —
// замер: семь корней из семи за три секунды при random_tick_speed 900.
let Z0 = 2200
const LANES = { plot: [2200, 2200], cane: [2140, 2200], melon: [2080, 2200], dry: [2140, 2260] }
const R = 14

let failures = 0
function check (label, ok, note = '') {
  if (!ok) failures++
  console.log(`  ${ok ? '[ OK ]' : '[ПЛОХО]'} ${label}${note ? ' — ' + note : ''}`)
}

const c = connect(WS)
const call = c.call
let kit = null
let eye = null

async function step (label, method, params) {
  const r = await call(method, params).catch(e => ({ status: 'RPC', error: e.message }))
  const d = r.detail || {}
  const { field, ...rest } = d
  console.log(`${label.padEnd(22)} ${String(r.status).padEnd(10)} ${JSON.stringify(rest).slice(0, 700)}${r.error ? ' ← ' + r.error : ''}`)
  return r
}

async function eyeOpen () {
  eye = mineflayer.createBot({ host: HOST, port: PORT, username: 'FarmEye', version: '1.21.11', auth: 'offline' })
  await new Promise((resolve, reject) => { eye.once('spawn', resolve); eye.once('error', reject); eye.once('kicked', r => reject(new Error('зрителя выкинули: ' + r))) })
  await kit.cmd('/gamemode spectator FarmEye')
}

async function eyeTo (x, y, z) {
  await kit.cmd(`/tp FarmEye ${x} ${y} ${z}`)
  const t0 = Date.now()
  while (Date.now() - t0 < 15000) {
    const p = eye.entity && eye.entity.position
    if (p && Math.abs(p.x - x) < 2 && Math.abs(p.z - z) < 2 && eye.blockAt(new Vec3(x, Y, z))) break
    await sleep(300)
  }
  await sleep(1200)
}

const at = (x, y, z) => eye.blockAt(new Vec3(x, y, z))
const props = b => { try { return b.getProperties() } catch { return {} } }
function scan (x1, y1, z1, x2, y2, z2, fn) {
  const out = []
  for (let x = Math.min(x1, x2); x <= Math.max(x1, x2); x++) {
    for (let y = Math.min(y1, y2); y <= Math.max(y1, y2); y++) {
      for (let z = Math.min(z1, z2); z <= Math.max(z1, z2); z++) {
        const b = at(x, y, z)
        if (b && fn(b)) out.push(b)
      }
    }
  }
  return out
}

async function bag () {
  const s = await call('status')
  return (s.state && s.state.inventory) || {}
}

// Площадка: трава на Y, воздух сверху, тело на краю, зритель над центром.
async function arena (lane, gives, { extra = null, yaw = -90 } = {}) {
  const X = lane[0]
  Z0 = lane[1]
  await call('stop')
  await sleep(400)
  await kit.gamerule('random_tick_speed', '3')
  await kit.cmd('/effect give @s minecraft:resistance 900 4 true')
  await kit.cmd('/effect give @s minecraft:slow_falling 25 1 true')
  await kit.cmd(`/tp @s ${X} ${Y + 3} ${Z0}`)
  await sleep(3000)
  await kit.fillExact(null, [[X - R, Y - 3, Z0 - R], [X + R, Y, Z0 + R]], 'grass_block')
  await kit.fillExact(null, [[X - R, Y + 1, Z0 - R], [X + R, Y + 10, Z0 + R]], 'air')
  if (extra) await extra(X)
  await kit.cmd(`/tp @s ${X - 8} ${Y + 1} ${Z0} ${yaw} 0`)
  await kit.cmd(`/spawnpoint @s ${X - 8} ${Y + 1} ${Z0}`)
  await kit.cmd('/effect clear @s minecraft:slow_falling')
  await kit.cmd(`/kill @e[type=!player,distance=..40]`)
  await kit.cmd('/clear @s')
  for (const [item, n] of gives) await kit.must(`/give @s ${item} ${n}`, /^Gave \d+ /, `не выдан ${item}`)
  await eyeTo(X, Y + 12, Z0)
  await sleep(600)
}

// ------------------------------------------------------------------ cases

const P = { x: LANES.plot[0], y: Y, z: LANES.plot[1] }
const inPlot = (fn) => scan(P.x - 4, Y, P.z - 4, P.x + 4, Y, P.z + 4, fn)
const cropsAbove = () => scan(P.x - 4, Y + 1, P.z - 4, P.x + 4, Y + 1, P.z + 4, b => /^(wheat|carrots|potatoes|beetroots)$/.test(b.name))

async function casePlot () {
  console.log('\n(А) поле с нуля: лунка, вода, трава срезана, 9×9 вспахано, посажено')
  await arena(LANES.plot, [['stone_hoe', 1], ['water_bucket', 1], ['wheat_seeds', 64], ['carrot', 16]], {
    extra: async () => {
      // Травинки поверх части поля: мотыга по траве с травинкой не пашет.
      await kit.cmd(`/fill ${P.x - 4} ${Y + 1} ${P.z - 4} ${P.x - 1} ${Y + 1} ${P.z + 4} minecraft:short_grass`)
    }
  })
  const before = scan(P.x - 4, Y, P.z - 4, P.x + 4, Y, P.z + 4, b => b.name === 'farmland').length
  const r = await step('plot', 'farm', { mode: 'plot', at: P, radius: 4, timeoutSeconds: 240 })
  const d = r.detail || {}
  await eyeTo(P.x, Y + 10, P.z)
  const water = at(P.x, Y, P.z)
  const farmland = inPlot(b => b.name === 'farmland').length
  const crops = cropsAbove()
  check('до работы грядок не было', before === 0, `было ${before}`)
  check('в центре вода', water && water.name === 'water', water && water.name)
  const odd = inPlot(b => b.name !== 'farmland' && !(b.position.x === P.x && b.position.z === P.z)).map(b => `${b.name}@${b.position.x - P.x},${b.position.z - P.z}`)
  check('вспахано 80 клеток (9×9 без лунки)', farmland === 80, `грядок ${farmland}; отчёт tilled ${d.tilled}, weeded ${d.weeded}${odd.length ? `; не грядка: ${odd.join(' ')}` : ''}`)
  check('засеяно 80 (64 пшеницы + 16 моркови)', crops.length === 80, `посевов ${crops.length}; отчёт planted ${d.planted} ${JSON.stringify(d.plantedAs)}`)
  // Не «рюкзак пуст»: травинка роняет семечко (1/8), и лишнее законно. Отчёт
  // должен совпасть с миром.
  check('отчёт planted совпал с тем, что видит зритель', d.planted === crops.length, `planted ${d.planted}, в мире ${crops.length}`)
  check('травинки срезаны, а не оставлены', (d.weeded || 0) >= 30, `weeded ${d.weeded}`)
}

async function caseBonemeal () {
  console.log('\n(Б) костная мука: стадии растут')
  await kit.gamerule('random_tick_speed', '0')
  await kit.cmd('/clear @s')
  await kit.must('/give @s bone_meal 12', /^Gave \d+ /, 'мука')
  await eyeTo(P.x, Y + 10, P.z)
  const sum = () => cropsAbove().reduce((n, b) => n + Number(props(b).age || 0), 0)
  const s0 = sum()
  const r = await step('bonemeal', 'farm', { mode: 'bonemeal', at: P, radius: 6, count: 12 })
  await eyeTo(P.x, Y + 10, P.z)
  const s1 = sum()
  check('стадии выросли после муки (+2..5 за штуку, CropBlock)', s1 - s0 >= 12, `сумма age ${s0} → ${s1}, удобрено ${(r.detail || {}).bonemealed}`)
}

async function caseGrow () {
  console.log('\n(В) рост и сбор: спелое снято, посажено обратно, грядки целы')
  await kit.cmd('/clear @s')
  await kit.gamerule('random_tick_speed', '600')
  await eyeTo(P.x, Y + 10, P.z)
  const t0 = Date.now()
  let ripe = 0
  while (Date.now() - t0 < 90000) {
    ripe = cropsAbove().filter(b => Number(props(b).age) === 7).length
    if (ripe >= 76) break
    await sleep(2000)
  }
  await kit.gamerule('random_tick_speed', '0')
  check('поле выросло само (random ticks)', ripe >= 60, `спелых ${ripe} за ${Math.round((Date.now() - t0) / 1000)}с`)
  // Влажность ставит случайный тик (FarmBlock.randomTick), а не мотыга: смотреть
  // её можно только после того, как тики прошли.
  const wet = inPlot(b => b.name === 'farmland' && Number(props(b).moisture) > 0).length
  check('грядки влажные (вода в 4 блоках — FarmBlock.isNearWater)', wet === 80, `влажных ${wet} из 80`)
  // Одна незрелая клетка — её трогать нельзя.
  await kit.cmd(`/setblock ${P.x + 4} ${Y + 1} ${P.z + 4} minecraft:wheat[age=3]`)
  await sleep(500)
  const before = await bag()
  const r = await step('harvest', 'farm', { mode: 'harvest', at: P, radius: 7, timeoutSeconds: 240 })
  const d = r.detail || {}
  await eyeTo(P.x, Y + 10, P.z)
  const after = await bag()
  const got = n => (after[n] || 0) - (before[n] || 0)
  const farmland = inPlot(b => b.name === 'farmland').length
  const crops = cropsAbove()
  const young = crops.filter(b => Number(props(b).age) < 7).length
  const green = at(P.x + 4, Y + 1, P.z + 4)
  check('пшеница в рюкзаке', got('wheat') >= 50, `wheat +${got('wheat')}, семена +${got('wheat_seeds')}`)
  check('морковь в рюкзаке', got('carrot') >= 10, `carrot +${got('carrot')}`)
  check('пересажено: на грядках снова посевы', crops.length >= 76 && young >= 70, `посевов ${crops.length}, молодых ${young}; replanted ${d.replanted}`)
  check('грядки не вытоптаны', farmland === 80, `грядок ${farmland}`)
  check('незрелую (age 3) не тронул', green && green.name === 'wheat' && Number(props(green).age) === 3, `${green && green.name} age ${green && props(green).age}`)
}

async function caseCane () {
  console.log('\n(Г) тростник: посадить у воды, вырос, срезать выше корня')
  const X = LANES.cane[0]
  await arena(LANES.cane, [['sugar_cane', 7]], {
    extra: async () => {
      // Песок в ряд, вода вдоль него, вокруг воды камень: иначе трава у края
      // воды — тоже законное место под тростник, и семь штук уйдут не туда.
      await kit.cmd(`/fill ${X - 4} ${Y} ${Z0 + 1} ${X + 4} ${Y} ${Z0 + 2} minecraft:stone`)
      await kit.cmd(`/fill ${X - 3} ${Y} ${Z0} ${X + 3} ${Y} ${Z0} minecraft:sand`)
      await kit.cmd(`/fill ${X - 3} ${Y} ${Z0 + 1} ${X + 3} ${Y} ${Z0 + 1} minecraft:water`)
    }
  })
  await kit.gamerule('random_tick_speed', '0')
  const r1 = await step('plant cane', 'farm', { mode: 'plant', seed: 'sugar_cane', at: { x: X, y: Y, z: Z0 }, radius: 6 })
  await eyeTo(X, Y + 10, Z0)
  const bases = () => scan(X - 3, Y + 1, Z0, X + 3, Y + 1, Z0, b => b.name === 'sugar_cane').length
  check('тростник посажен 7 штук у воды', bases() === 7, `корней ${bases()}; planted ${(r1.detail || {}).planted}`)
  await kit.gamerule('random_tick_speed', '900')
  const t0 = Date.now()
  let tall = 0
  while (Date.now() - t0 < 90000) {
    tall = scan(X - 3, Y + 3, Z0, X + 3, Y + 3, Z0, b => b.name === 'sugar_cane').length
    if (tall >= 6) break
    await sleep(2000)
  }
  await kit.gamerule('random_tick_speed', '0')
  const above = scan(X - 3, Y + 2, Z0, X + 3, Y + 4, Z0, b => b.name === 'sugar_cane').length
  check('вырос выше корня', above >= 7, `блоков над корнями ${above}, высотой 3 — ${tall}`)
  const before = await bag()
  const r = await step('harvest cane', 'farm', { mode: 'harvest', what: 'sugar_cane', at: { x: X, y: Y, z: Z0 }, radius: 6 })
  await eyeTo(X, Y + 10, Z0)
  const after = await bag()
  const left = scan(X - 3, Y + 2, Z0, X + 3, Y + 4, Z0, b => b.name === 'sugar_cane').length
  check('корни на месте все 7', bases() === 7, `корней ${bases()}`)
  check('выше корня пусто', left === 0, `осталось ${left}`)
  check('тростник в рюкзаке ~ сколько срезано', (after.sugar_cane || 0) - (before.sugar_cane || 0) >= above - 1, `+${(after.sugar_cane || 0) - (before.sugar_cane || 0)} из ${above}; ${JSON.stringify((r.detail || {}).harvested)}`)
}

async function caseMelon () {
  console.log('\n(Д) арбуз и тыква: плод сломан, стебель остался')
  const X = LANES.melon[0]
  await arena(LANES.melon, [['wooden_hoe', 1], ['melon_seeds', 2], ['pumpkin_seeds', 2], ['stone_axe', 1]], {
    extra: async () => {
      // Ряд грядок у воды, по обе стороны — голая земля под плоды.
      await kit.cmd(`/fill ${X - 3} ${Y} ${Z0} ${X + 3} ${Y} ${Z0} minecraft:farmland[moisture=7]`)
      await kit.cmd(`/fill ${X - 3} ${Y} ${Z0 + 1} ${X + 3} ${Y} ${Z0 + 1} minecraft:dirt`)
      await kit.cmd(`/fill ${X - 3} ${Y} ${Z0 - 1} ${X + 3} ${Y} ${Z0 - 1} minecraft:dirt`)
      await kit.cmd(`/setblock ${X - 4} ${Y} ${Z0} minecraft:water`)
      await kit.cmd(`/setblock ${X + 4} ${Y} ${Z0} minecraft:water`)
      // Только 4 грядки из 7 — через одну, чтобы стебли не мешали друг другу.
      for (const dx of [-2, 0, 2]) await kit.cmd(`/setblock ${X + dx} ${Y} ${Z0} minecraft:dirt`)
    }
  })
  await kit.gamerule('random_tick_speed', '0')
  const r1 = await step('plant melon', 'farm', { mode: 'plant', seed: 'melon_seeds', at: { x: X, y: Y, z: Z0 }, radius: 6 })
  const r2 = await step('plant pumpkin', 'farm', { mode: 'plant', seed: 'pumpkin_seeds', at: { x: X, y: Y, z: Z0 }, radius: 6 })
  await eyeTo(X, Y + 10, Z0)
  const stems = () => scan(X - 3, Y + 1, Z0, X + 3, Y + 1, Z0, b => /stem$/.test(b.name))
  check('посажено 4 стебля', stems().length === 4, `стеблей ${stems().length}; ${(r1.detail || {}).planted}+${(r2.detail || {}).planted}`)
  await kit.gamerule('random_tick_speed', '900')
  const t0 = Date.now()
  let fruit = 0
  while (Date.now() - t0 < 120000) {
    fruit = scan(X - 4, Y + 1, Z0 - 1, X + 4, Y + 1, Z0 + 1, b => b.name === 'melon' || b.name === 'pumpkin').length
    if (fruit >= 4) break
    await sleep(2000)
  }
  await kit.gamerule('random_tick_speed', '0')
  check('плоды выросли у стеблей', fruit >= 2, `плодов ${fruit}`)
  const before = await bag()
  const r = await step('harvest fruit', 'farm', { mode: 'harvest', at: { x: X, y: Y, z: Z0 }, radius: 6 })
  await eyeTo(X, Y + 10, Z0)
  const after = await bag()
  const leftFruit = scan(X - 4, Y + 1, Z0 - 1, X + 4, Y + 1, Z0 + 1, b => b.name === 'melon' || b.name === 'pumpkin').length
  check('стебли на месте', stems().length === 4, `стеблей ${stems().length}`)
  check('плоды сняты', leftFruit === 0, `осталось ${leftFruit}; ${JSON.stringify((r.detail || {}).harvested)}`)
  const got = ((after.melon_slice || 0) - (before.melon_slice || 0)) + ((after.pumpkin || 0) - (before.pumpkin || 0))
  check('в рюкзаке ломтики/тыквы', got >= fruit, `melon_slice +${(after.melon_slice || 0) - (before.melon_slice || 0)}, pumpkin +${(after.pumpkin || 0) - (before.pumpkin || 0)}`)
}

async function caseDry () {
  console.log('\n(Е) отказ: сухая земля без воды — не пашет и говорит почему')
  const X = LANES.dry[0]
  await arena(LANES.dry, [['wooden_hoe', 1]])
  const r = await step('till dry', 'farm', { mode: 'till', at: { x: X, y: Y, z: Z0 }, radius: 4 })
  const d = r.detail || {}
  await eyeTo(X, Y + 10, Z0)
  const farmland = scan(X - 6, Y, Z0 - 6, X + 6, Y, Z0 + 6, b => b.name === 'farmland').length
  check('предмет в мире есть: трава под пашню', scan(X - 4, Y, Z0 - 4, X + 4, Y, Z0 + 4, b => b.name === 'grass_block').length > 60)
  check('не вспахал ни клетки', farmland === 0 && !d.tilled, `грядок ${farmland}`)
  check('сказал про воду', /вод/.test(d.stopped || ''), d.stopped)
}

// ------------------------------------------------------------------ run

;(async () => {
  await c.ready
  kit = createKit({ call, heard: c.heard, player: PLAYER, logFile: LOG })
  await call('connect')
  await call('stop')
  await kit.gamerule('advance_time', 'false')
  await kit.gamerule('spawn_mobs', 'false')
  await kit.gamerule('advance_weather', 'false')
  await kit.cmd('/weather clear')
  await kit.cmd('/time set day')
  await kit.setDifficulty('peaceful')
  await eyeOpen()
  const cases = { plot: casePlot, bonemeal: caseBonemeal, grow: caseGrow, cane: caseCane, melon: caseMelon, dry: caseDry }
  for (const [name, fn] of Object.entries(cases)) {
    if (ONLY && !ONLY.includes(name)) continue
    try { await fn() } catch (e) { check(`${name}: сцена упала`, false, e.message) }
  }
  await kit.gamerule('random_tick_speed', '3')
  console.log(`
${failures ? `ПЛОХО: ${failures}` : 'всё зелёное'}`)
  try { eye.quit() } catch {}
  c.close()
  process.exit(failures ? 1 : 0)
})().catch(e => { console.error(e); process.exit(2) })
