'use strict'
// Механизм из чертежа: mc_mechanism kind=cane (src/mechanism.js) — самосрез
// тростника. Тело строит ряд само (копает жёлоб, льёт воду, ставит поршни и
// наблюдателей с нужным поворотом, провод, сажает), потом тростник растёт
// ПО-НАСТОЯЩЕМУ (random_tick_speed поднят), механизм срезает сам, тело
// собирает с дорожки.
//
//  А. ПЛАН: чего не хватает на пустой рюкзак — short; с полным — пусто.
//  Б. СТРОЙКА: зритель MechEye видит в каждом столбце почву, воду-источник,
//     поршень[facing к тростнику], наблюдатель[facing к тростнику], провод,
//     тростник. Отчёт columns совпадает с миром.
//  В. РАБОТА: тростник растёт до трёх, поршни срезают 2-й и 3-й блок, корни
//     все на месте, поршни вернулись; дроп лежит у фермы.
//  Г. СБОР: collect — тростник в рюкзаке, дропа не осталось.
//
// Запуск: node try-mech.js. Сервер build (127.0.0.1:25566), демон ND_WS (8771).
const path = require('path')
const mineflayer = require('mineflayer')
const Vec3 = require('vec3')
const { connect, createKit, sleep } = require('./scene-kit')

const WS = process.env.ND_WS || 'ws://127.0.0.1:8771'
const PLAYER = process.env.ND_PLAYER || 'NeuroBuild'
const HOST = process.env.MC_HOST || '127.0.0.1'
const PORT = Number(process.env.MC_PORT || 25566)
const LOG = process.env.ND_SERVER_LOG || path.join(__dirname, '..', process.env.ND_SERVER_DIR || 'server-build', 'logs', 'latest.log')

const Y = 120
const X = 3300; const Z = 3400
const N = 4

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
  const t0 = Date.now()
  const r = await call(method, params).catch(e => ({ status: 'RPC', error: e.message }))
  console.log(`${label.padEnd(10)} ${String(r.status).padEnd(10)} ${Math.round((Date.now() - t0) / 1000)}с ${JSON.stringify(r.detail || {}).slice(0, 900)}${r.error ? ' ← ' + r.error : ''}`)
  return r
}

async function bag () {
  const s = await call('status')
  return (s.state && s.state.inventory) || {}
}

const at = (x, y, z) => eye.blockAt(new Vec3(x, y, z))
const props = b => { try { return b.getProperties() } catch { return {} } }
const cols = () => [...Array(N).keys()].map(i => X + i)
const drops = () => Object.values(eye.entities).filter(e => e && e.name === 'item' && e.position.x > X - 3 && e.position.x < X + N + 2 && Math.abs(e.position.z - Z) < 4)

;(async () => {
  await c.ready
  kit = createKit({ call, heard: c.heard, player: PLAYER, logFile: LOG })
  await call('connect')
  await call('stop')
  await kit.gamerule('advance_time', 'false')
  await kit.gamerule('spawn_mobs', 'false')
  await kit.gamerule('random_tick_speed', '0')
  await kit.cmd('/time set day')
  await kit.setDifficulty('peaceful')
  await kit.cmd('/effect give @s minecraft:resistance 900 4 true')
  await kit.cmd(`/tp @s ${X} ${Y + 3} ${Z - 4}`)
  await sleep(3000)
  await kit.cmd(`/kill @e[type=item,x=${X},y=${Y},z=${Z},distance=..30]`)
  await kit.fillExact(null, [[X - 8, Y - 3, Z - 8], [X + 12, Y, Z + 8]], 'grass_block')
  await kit.fillExact(null, [[X - 8, Y + 1, Z - 8], [X + 12, Y + 8, Z + 8]], 'air')
  await kit.cmd(`/tp @s ${X} ${Y + 1} ${Z - 3} 0 0`)
  await kit.cmd('/clear @s')
  eye = mineflayer.createBot({ host: HOST, port: PORT, username: 'MechEye', version: '1.21.11', auth: 'offline' })
  await new Promise((resolve, reject) => { eye.once('spawn', resolve); eye.once('error', reject) })
  await kit.cmd('/gamemode spectator MechEye')
  await kit.cmd(`/tp MechEye ${X + 2} ${Y + 10} ${Z}`)
  await sleep(2500)

  try {
    console.log('\n(А) план: пустой рюкзак — чего не хватает')
    const p0 = await step('plan', 'mechanism', { kind: 'cane', mode: 'plan', at: { x: X, y: Y, z: Z }, facing: 'south', length: N })
    const short = ((p0.detail || {}).short || []).map(s => s.what)
    check('назвал поршни, наблюдателей, редстоун, тростник, воду', ['piston', 'observer', 'redstone', 'sugar_cane', 'water_bucket'].every(w => short.includes(w)), short.join(','))

    for (const [item, n] of [['piston', N], ['observer', N], ['redstone', N], ['sugar_cane', N], ['cobblestone', 40], ['water_bucket', 2], ['stone_shovel', 1]]) {
      await kit.must(`/give @s ${item} ${n}`, /^Gave \d+ /, `не выдан ${item}`)
    }
    await sleep(800)
    const p1 = await step('plan', 'mechanism', { kind: 'cane', mode: 'plan', at: { x: X, y: Y, z: Z }, facing: 'south', length: N })
    check('с полным рюкзаком не хватает ничего', !(p1.detail || {}).short, JSON.stringify((p1.detail || {}).short))

    console.log('\n(Б) стройка')
    const r = await step('build', 'mechanism', { kind: 'cane', mode: 'build', at: { x: X, y: Y, z: Z }, facing: 'south', length: N, timeoutSeconds: 400 })
    const d = r.detail || {}
    await sleep(1500)
    for (const x of cols()) {
      const s = at(x, Y, Z); const w = at(x, Y, Z + 1); const pi = at(x, Y + 2, Z + 1); const ob = at(x, Y + 3, Z + 1); const wi = at(x, Y + 3, Z + 2); const cn = at(x, Y + 1, Z)
      const ok = s && /grass_block|dirt|sand/.test(s.name) && w && w.name === 'water' && Number(props(w).level) === 0 &&
        pi && pi.name === 'piston' && props(pi).facing === 'north' && ob && ob.name === 'observer' && props(ob).facing === 'north' &&
        wi && wi.name === 'redstone_wire' && cn && cn.name === 'sugar_cane'
      check(`столбец ${x - X}: почва, вода, поршень→N, наблюдатель→N, провод, тростник`, ok,
        [s, w, pi, ob, wi, cn].map(b => b ? `${b.name}${props(b).facing ? '[' + props(b).facing + ']' : ''}${b.name === 'water' ? '[' + props(b).level + ']' : ''}` : '?').join(' '))
    }
    check('отчёт: собрано все столбцы', d.ok === N, `ok ${d.ok}; ${d.stopped || ''} ${JSON.stringify(d.steps)}`)

    console.log('\n(В) растёт само, срезает само')
    await kit.cmd(`/kill @e[type=item,x=${X},y=${Y},z=${Z},distance=..12]`)
    await sleep(500)
    await kit.gamerule('random_tick_speed', '2000')
    const t0 = Date.now()
    while (Date.now() - t0 < 120000 && drops().reduce((n, e) => n + ((e.metadata && e.metadata[8] && e.metadata[8].itemCount) || 1), 0) < N * 2) await sleep(1000)
    await kit.gamerule('random_tick_speed', '0')
    await sleep(1500)
    const roots = cols().filter(x => (at(x, Y + 1, Z) || {}).name === 'sugar_cane').length
    const third = cols().filter(x => (at(x, Y + 3, Z) || {}).name === 'sugar_cane').length
    const ext = cols().filter(x => props(at(x, Y + 2, Z + 1)).extended === 'true' || props(at(x, Y + 2, Z + 1)).extended === true).length
    const seen = drops()
    check('дроп тростника у фермы появился (механизм срезал)', seen.length > 0, `предметов ${seen.length} за ${Math.round((Date.now() - t0) / 1000)}с`)
    check('корни на месте все', roots === N, `корней ${roots}`)
    check('до третьего блока не стоит (срезано)', third === 0, `третьих ${third}`)
    check('поршни вернулись', ext === 0, `выдвинуто ${ext}`)

    console.log('\n(Г) сбор с дорожки')
    const before = await bag()
    const g = await step('collect', 'mechanism', { kind: 'cane', mode: 'collect' })
    const after = await bag()
    await sleep(800)
    const got = (after.sugar_cane || 0) - (before.sugar_cane || 0)
    check('тростник в рюкзаке', got >= seen.length, `+${got}; gained ${JSON.stringify((g.detail || {}).gained)}`)
    check('дропа у фермы не осталось', drops().length === 0, `осталось ${drops().length}: ${drops().map(e => `${e.position.x.toFixed(2)},${e.position.y.toFixed(2)},${e.position.z.toFixed(2)}`).join(' ')}`)
    const st = await step('status', 'mechanism', { kind: 'cane', mode: 'status' })
    check('status: все столбцы целы (ферма запомнена, без координат)', (st.detail || {}).ok === N, JSON.stringify((st.detail || {}).columns))
  } catch (e) { check('сцена упала', false, e.stack || e.message) }

  await kit.gamerule('random_tick_speed', '3')
  console.log(`\n${failures ? `ПЛОХО: ${failures}` : 'всё зелёное'}`)
  try { eye.quit() } catch {}
  c.close()
  process.exit(failures ? 1 : 0)
})().catch(e => { console.error(e); process.exit(2) })
