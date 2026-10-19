'use strict'
import { REPO_ROOT } from '../../src/paths'
import * as gameClock from '../../src/game-clock'
import { createGameBot } from '../lib/scene-kit'
// Езда: mc_ride (src/ride.js) — лошадь и лодка, честно, без /tp и без NBT Tame.
//
//  А. ЛОШАДЬ: дикая лошадь (/summon без Tame). Тело приручает её посадками —
//     сидит, пока лошадь не бросит кубик (RunAroundLikeCrazyGoal): дым (6) —
//     сбросила, сердечки (7) — стерпела. Судит второй клиент — зритель RideEye:
//     он сам слышит события сущности и видит флаг приручения в метаданных.
//  Б. ВЕРХОМ ~60 БЛОКОВ по неровной земле: холм ступенями по 1, стена в 3
//     блока с проходом сбоку, канава, пруд. Седло из рюкзака, доехать, слезть,
//     привязать к забору поводком. Зритель: лошадь под седлом, за стеной, у
//     цели, на поводке у столба (узел leash_knot); тело у цели.
//  В. ЛОДКА: 5 досок + верстак → лодка; спустить на озеро, обойти остров,
//     высадиться на дальнем берегу, разбить лодку и подобрать. Зритель: тело
//     на суше за озером, лодок на воде нет, лодка в рюкзаке.
//
// Запуск: node try-ride.js (всё, ~4 мин) или ONLY=tame,horse,boat node try-ride.js.
// Сервер — свой, build (127.0.0.1:25566), демон ND_WS (ws://127.0.0.1:8771),
// игрок NeuroBuild — оператор.
import path = require('path')
const Vec3: typeof import('vec3').Vec3 = require('vec3')
import { connect, createKit, sleep } from '../lib/scene-kit'
import ride = require('../../src/ride')

const WS = process.env.ND_WS || 'ws://127.0.0.1:8771'
const PLAYER = process.env.ND_PLAYER || 'NeuroBuild'
const HOST = process.env.MC_HOST || '127.0.0.1'
const PORT = Number(process.env.MC_PORT || 25566)
const LOG = process.env.ND_SERVER_LOG || path.join(REPO_ROOT, process.env.ND_SERVER_DIR || 'server-build', 'logs', 'latest.log')
const ONLY = process.env.ONLY ? process.env.ONLY.split(',') : null

const Y = 120
const H = { x: 3000, z: 3000 } // лошадиная полоса: x .. x+70
const B = { x: 3000, z: 3120 } // озеро: x+2 .. x+46
const GOAL = { x: H.x + 62, z: H.z }
const FENCE = { x: H.x + 64, y: Y + 1, z: H.z + 3 }

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
  const t0 = gameClock.now()
  const r = await call(method, params).catch(e => ({ status: 'RPC', error: e.message }))
  const d = r.detail || {} as Record<string, any>
  console.log(`${label.padEnd(16)} ${String(r.status).padEnd(10)} ${Math.round((gameClock.now() - t0) / 1000)}с ${JSON.stringify(d).slice(0, 900)}${r.error ? ' ← ' + r.error : ''}`)
  return r
}

async function eyeOpen () {
  eye = createGameBot({ host: HOST, port: PORT, username: 'RideEye', version: '1.21.11', auth: 'offline' })
  await new Promise<any>((resolve, reject) => { eye.once('spawn', resolve); eye.once('error', reject); eye.once('kicked', r => reject(new Error('зрителя выкинули: ' + r))) })
  await kit.cmd('/gamemode spectator RideEye')
  eye._client.on('set_passengers', ({ entityId, passengers }: any) => riders.set(entityId, passengers))
}

async function eyeTo (x, y, z) {
  await kit.cmd(`/tp RideEye ${x} ${y} ${z}`)
  const t0 = gameClock.now()
  while (gameClock.now() - t0 < 15000) {
    const p = eye.entity && eye.entity.position
    if (p && Math.abs(p.x - x) < 2 && Math.abs(p.z - z) < 2 && eye.blockAt(new Vec3(x, Y, z))) break
    await sleep(300)
  }
  await sleep(1200)
}

async function bag () {
  const s = await call('status')
  return (s.state && s.state.inventory) || {} as Record<string, any>
}

async function where () {
  const s = await call('status')
  return s.state && s.state.pos
}

const eyeEntities = (fn) => Object.values<any>(eye.entities).filter(e => e && e.position && fn(e))
// Кто на ком сидит — по пакетам set_passengers зрителя. Не e.vehicle: mineflayer
// снимает с транспорта только перечисленных пассажиров, и слезший игрок так и
// остаётся «в седле» (та же ошибка, что ride.js правит у тела).
const riders = new Map()
const riding = (id) => { for (const [v, ps] of riders) if (ps.includes(id)) return v; return null }
const meId = () => { const me = eyeEntities(e => e.username === PLAYER)[0]; return me ? me.id : null }
const flat = (a, b) => Math.hypot(a.x - b.x, a.z - b.z)

// Площадка: трава на Y, воздух сверху; тело на западном краю, лицом на восток.
async function ground (x1, z1, x2, z2) {
  await kit.fillExact(null, [[x1, Y - 3, z1], [x2, Y, z2]], 'grass_block')
  await kit.fillExact(null, [[x1, Y + 1, z1], [x2, Y + 12, z2]], 'air')
}

async function prepare (x, z, gives?: any) {
  await call('stop')
  await sleep(400)
  await kit.cmd('/effect give @s minecraft:resistance 900 4 true')
  await kit.cmd('/effect give @s minecraft:slow_falling 25 1 true')
  await kit.cmd(`/tp @s ${x} ${Y + 3} ${z}`)
  await sleep(3000)
}

async function place (x, z, gives) {
  await kit.cmd(`/tp @s ${x} ${Y + 1} ${z} -90 0`)
  await kit.cmd(`/spawnpoint @s ${x} ${Y + 1} ${z}`)
  await kit.cmd('/effect clear @s minecraft:slow_falling')
  await kit.cmd('/clear @s')
  for (const [item, n] of gives) await kit.must(`/give @s ${item} ${n}`, /^Gave \d+ /, `не выдан ${item}`)
  await sleep(800)
}

// ------------------------------------------------------------------ лошадь

let horseId = null
const horseOf = () => horseId && eye.entities[horseId]

async function horseArena () {
  const { x, z } = H
  await prepare(x, z)
  await kit.cmd(`/kill @e[type=!player,x=${x + 30},y=${Y},z=${z},distance=..80]`)
  // Убитая лошадь прошлого прогона роняет седло, кожу и поводок — убрать.
  await sleep(1500)
  await kit.cmd(`/kill @e[type=item,x=${x + 30},y=${Y},z=${z},distance=..80]`)
  await ground(x - 6, z - 16, x + 70, z + 16)
  // Холм ступенями по 1 — поперёк всей полосы: объехать нельзя, только взойти.
  await kit.fillExact(null, [[x + 10, Y + 1, z - 16], [x + 22, Y + 1, z + 16]], 'grass_block')
  await kit.fillExact(null, [[x + 13, Y + 2, z - 16], [x + 19, Y + 2, z + 16]], 'grass_block')
  // Стена в 3 блока: проход только у южного края, z+10..z+16.
  await kit.fillExact(null, [[x + 32, Y + 1, z - 16], [x + 32, Y + 3, z + 9]], 'stone_bricks')
  // Канава в блок глубиной поперёк всей полосы.
  await kit.fillExact(null, [[x + 42, Y, z - 16], [x + 43, Y, z + 16]], 'air')
  // Пруд прямо на линии к цели — лошадь его обходит.
  await kit.fillExact(null, [[x + 50, Y, z - 4], [x + 53, Y, z + 4]], 'water')
  // Столбы-деревья.
  for (const [dx, dz] of [[5, 3], [26, -2], [37, -5], [58, 6]]) await kit.cmd(`/fill ${x + dx} ${Y + 1} ${z + dz} ${x + dx} ${Y + 3} ${z + dz} minecraft:oak_log`)
  // Коновязь у цели.
  await kit.cmd(`/setblock ${FENCE.x} ${FENCE.y} ${FENCE.z} minecraft:oak_fence`)
}

async function caseTame () {
  console.log('\n(А) дикая лошадь: приручить посадками, честно')
  await horseArena()
  await place(H.x - 2, H.z, [['saddle', 1], ['lead', 1]])
  await kit.cmd(`/summon minecraft:horse ${H.x + 3} ${Y + 1} ${H.z}`)
  await eyeTo(H.x + 2, Y + 8, H.z)
  await sleep(1500)
  const h = eyeEntities(e => e.name === 'horse' && flat(e.position, { x: H.x + 3, z: H.z }) < 10)[0]
  check('лошадь есть и дикая', !!h && !ride.isTamedHorse(h), h ? `id ${h.id}` : 'нет лошади')
  if (!h) return
  horseId = h.id
  const heard = []
  const onStatus = pk => { if (pk.entityId === horseId) heard.push(pk.entityStatus) }
  eye._client.on('entity_status', onStatus)
  const s = await step('status', 'ride', { mode: 'status' })
  check('status: дикая, без седла', s.detail && s.detail.horse && s.detail.horse.tamed === false && s.detail.horse.saddled === false, JSON.stringify(s.detail && s.detail.horse))
  const r = await step('tame', 'ride', { mode: 'tame', timeoutSeconds: 240 })
  await sleep(1000)
  eye._client.removeListener('entity_status', onStatus)
  const d = r.detail || {} as Record<string, any>
  const t = d.tame || {} as Record<string, any>
  const smoke = heard.filter(x => x === 6).length
  const hearts = heard.filter(x => x === 7).length
  check('приручена (флаг 0x02 у зрителя)', ride.isTamedHorse(horseOf() || {} as Record<string, any>), `tame ${JSON.stringify(t)}`)
  check('сердечки видел зритель ровно раз', hearts === 1, `событий 7: ${hearts}`)
  check('сбросы в отчёте = дым у зрителя', t.bucked === smoke, `bucked ${t.bucked}, дым ${smoke}`)
  check('посадок больше, чем сбросов, на одну (последняя — стерпела)', t.tries === smoke + 1, `tries ${t.tries}`)
  const pos = await where()
  const on = riding(meId())
  check('после приручения тело слезло (зритель: не в пассажирах)', meId() !== null && on === null, `${pos && `${pos.x},${pos.y},${pos.z}`}; сидит на ${on}`)
}

async function caseHorse () {
  console.log('\n(Б) седло и 60 блоков верхом: холм, стена, канава, пруд; привязать')
  if (!horseOf()) {
    // Отдельный запуск: лошадь приручена заранее — А это и проверяет.
    await horseArena()
    await place(H.x - 2, H.z, [['saddle', 1], ['lead', 1]])
    await kit.cmd(`/summon minecraft:horse ${H.x + 3} ${Y + 1} ${H.z}`)
    await eyeTo(H.x + 2, Y + 8, H.z)
    await sleep(1500)
    const h = eyeEntities(e => e.name === 'horse')[0]
    horseId = h && h.id
    await step('tame', 'ride', { mode: 'tame', timeoutSeconds: 240 })
  }
  const heard = []
  const onAttach = pk => { heard.push(pk) }
  eye._client.on('attach_entity', onAttach)
  const t0 = gameClock.now()
  const r = await step('go', 'ride', { mode: 'go', x: GOAL.x, z: GOAL.z, tie: true, timeoutSeconds: 180 })
  const secs = (gameClock.now() - t0) / 1000
  const d = r.detail || {} as Record<string, any>
  await eyeTo(GOAL.x, Y + 8, GOAL.z)
  await sleep(1000)
  eye._client.removeListener('attach_entity', onAttach)
  const h = horseOf()
  const pos = await where()
  check('доехал: arrived', d.arrived === true, d.stopped || '')
  check('седло на лошади (зритель)', !!h && ride.isSaddled(h), h ? JSON.stringify((h.equipment || []).map(i => i && i.name)) : 'лошади не видно')
  check('лошадь у цели, за стеной и прудом', !!h && flat(h.position, GOAL) < 6 && h.position.x > H.x + 55, h && `${h.position.x.toFixed(1)},${h.position.y.toFixed(1)},${h.position.z.toFixed(1)}`)
  check('тело у цели, на земле', !!pos && flat(pos, GOAL) < 5 && pos.y >= Y + 0.9 && pos.y < Y + 3 && riding(meId()) === null, `${pos && `${pos.x},${pos.y},${pos.z}`}; сидит на ${riding(meId())}`)
  check('ехал сам: маршрут с объездом стены', d.route && d.route.legs >= 2 && d.rode && d.rode.ticks > 40, JSON.stringify({ route: d.route, rode: d.rode }))
  check('быстрее, чем пешком (4.3 бл/с)', d.rode && d.rode.avgSpeed > 4.3, `avgSpeed ${d.rode && d.rode.avgSpeed}, весь вызов ${Math.round(secs)}с`)
  const knot = eyeEntities(e => e.name === 'leash_knot' && flat(e.position, FENCE) < 1.5)[0]
  const tiedTo = heard.filter(pk => pk.entityId === horseId).pop()
  check('привязана к забору (узел у столба, поводок от лошади к узлу)', !!knot && tiedTo && knot && tiedTo.vehicleId === knot.id, `knot ${knot && knot.id}, attach ${JSON.stringify(tiedTo)}; tied ${d.tied} ${d.note || ''}`)
  const b = await bag()
  check('поводок ушёл из рюкзака, седло — на лошадь', !b.lead && !b.saddle, JSON.stringify(b))
}

// Тот же честный цикл через mc_animals (fauna.tame отдаёт лошадиных ride.tameHorse).
async function caseAnimals () {
  console.log('\n(А2) mc_animals mode=tame kind=horse — тот же цикл посадок')
  await horseArena()
  await place(H.x - 2, H.z, [])
  await kit.cmd(`/summon minecraft:horse ${H.x + 3} ${Y + 1} ${H.z}`)
  await eyeTo(H.x + 2, Y + 8, H.z)
  await sleep(1500)
  const h = eyeEntities(e => e.name === 'horse' && flat(e.position, { x: H.x + 3, z: H.z }) < 10)[0]
  if (!h) { check('лошадь есть', false); return }
  const r = await step('animals', 'animals', { mode: 'tame', kind: 'horse', tries: 20 })
  const d = r.detail || {} as Record<string, any>
  await sleep(800)
  check('приручена (зритель)', ride.isTamedHorse(eye.entities[h.id] || {} as Record<string, any>), JSON.stringify({ tamed: d.tamed, used: d.used, fails: d.fails }))
  check('отчёт fauna: tamed, used = fails + 1', d.tamed === true && d.used === (d.fails || 0) + 1, `used ${d.used}, fails ${d.fails}`)
  check('тело слезло', riding(meId()) === null, `сидит на ${riding(meId())}`)
}

// ------------------------------------------------------------------ лодка

async function caseBoat () {
  console.log('\n(В) лодка: скрафтить, спустить, переплыть озеро мимо острова, подобрать')
  const { x, z } = B
  await prepare(x, z)
  await kit.cmd(`/kill @e[type=!player,x=${x + 25},y=${Y},z=${z},distance=..60]`)
  await sleep(1500)
  await kit.cmd(`/kill @e[type=item,x=${x + 25},y=${Y},z=${z},distance=..60]`)
  await ground(x - 6, z - 14, x + 56, z + 14)
  // Озеро глубиной 3, берега на уровне воды; остров посреди — прямо на линии.
  await kit.fillExact(null, [[x + 2, Y - 2, z - 11], [x + 46, Y, z + 11]], 'water')
  await kit.fillExact(null, [[x + 20, Y - 2, z - 4], [x + 27, Y, z + 4]], 'grass_block')
  await kit.cmd(`/fill ${x + 22} ${Y + 1} ${z - 1} ${x + 25} ${Y + 2} ${z + 1} minecraft:oak_leaves[persistent=true]`)
  await place(x - 2, z, [['oak_planks', 5], ['crafting_table', 1]])
  await eyeTo(x + 24, Y + 14, z)
  const target = { x: x + 52, z }

  const r1 = await step('craft', 'ride', { kind: 'boat', mode: 'craft' })
  const b1 = await bag()
  check('лодка скрафчена', (b1.oak_boat || 0) === 1, `${JSON.stringify(b1)}; crafted ${(r1.detail || {} as Record<string, any>).crafted}`)

  const r = await step('go', 'ride', { kind: 'boat', mode: 'go', x: target.x, z: target.z, timeoutSeconds: 150 })
  const d = r.detail || {} as Record<string, any>
  await eyeTo(x + 40, Y + 12, z)
  await sleep(1000)
  const pos = await where()
  const boats = eyeEntities(e => ride.isBoatName(e.name) && Math.abs(e.position.x - (x + 24)) < 40 && Math.abs(e.position.z - z) < 20)
  const b2 = await bag()
  const under = pos && eye.blockAt(new Vec3(Math.floor(pos.x), Math.floor(pos.y) - 1, Math.floor(pos.z)))
  check('спустил на воду', !!d.launched, JSON.stringify(d.launched))
  check('доплыл: arrived', d.arrived === true, d.stopped || '')
  check('маршрут в обход острова (больше одного галса)', d.route && d.route.complete && d.route.legs >= 2, JSON.stringify(d.route))
  check('высадился на дальнем берегу, на суше', !!pos && pos.x >= x + 46.5 && under && under.name !== 'water', pos && `${pos.x},${pos.y},${pos.z} на ${under && under.name}`)
  check('лодки на воде не осталось', boats.length === 0, boats.map(e => `${e.name}@${e.position.x.toFixed(1)},${e.position.z.toFixed(1)}`).join(' '))
  check('лодка в рюкзаке', (b2.oak_boat || 0) === 1, `pickedUp ${d.pickedUp}; ${JSON.stringify(b2)}`)
  check('по воде быстрее, чем пешком', d.rode && d.rode.seconds > 0 && (40 / d.rode.seconds) > 4.3, JSON.stringify(d.rode))
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
  await kit.gamerule('random_tick_speed', '3')
  await kit.cmd('/weather clear')
  await kit.cmd('/time set day')
  await kit.setDifficulty('peaceful')
  await eyeOpen()
  const cases = { tame: caseTame, horse: caseHorse, animals: caseAnimals, boat: caseBoat }
  for (const [name, fn] of Object.entries<any>(cases)) {
    if (ONLY && !ONLY.includes(name)) continue
    try { await fn() } catch (e) { check(`${name}: сцена упала`, false, e.stack || e.message) }
  }
  console.log(`
${failures ? `ПЛОХО: ${failures}` : 'всё зелёное'}`)
  try { eye.quit() } catch {}
  c.close()
  process.exit(failures ? 1 : 0)
})().catch(e => { console.error(e); process.exit(2) })
