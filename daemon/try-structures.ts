'use strict'
const gameClock = require('./src/game-clock')
// Постройки игры (src/structures.js): узнать глазами, зайти, обезвредить,
// взять ценное и оставить хлам. Подготовка — командами оператора (/place
// structure, /locate structure, /setblock с таблицей лута), дальше — честно:
// бот сам осматривается (mode=scan) и сам идёт (mode=explore).
//
//   (а) данж: замшелая комната, спавнер зомби, сундук с таблицей simple_dungeon
//       и сундук с известным набором (яблоко, алмазы — взять; плоть, кости,
//       пластинка — оставить); у входа сундук с табличкой — чужой, не трогать
//   (б) пустынный храм (натуральный, /locate): плита над 9 TNT снята, 4 сундука,
//       TNT выкопан, бот жив
//   (в) руины портала (/place structure ruined_portal на равнине): сундук,
//       счёт обсидиана
//   (г) кусок шахты: рельсы, паутина, доски, спавнер пещерных пауков,
//       вагонетка с таблицей abandoned_mineshaft
//   (д) корабль на мели (/place structure shipwreck_beached или натуральный)
//   (е) деревня (натуральная village_plains): кровати, сундуки; сундук с
//       табличкой — чужой
//   (ж) крепость Ада (/execute in the_nether ... locate): сундуки nether_bridge
//   (з) храм в джунглях (натуральный): растяжки сняты, сундуки
//
//   ND_WS=ws://127.0.0.1:8771 ONLY=абв node try-structures.js
const WebSocket = require('ws')

const ws = new WebSocket(process.env.ND_WS || 'ws://127.0.0.1:8771')
let id = 0
const pending = new Map()
const call = (method, params: any = {} as Record<string, any>) => new Promise<any>((resolve, reject) => {
  const rid = ++id
  pending.set(rid, { resolve, reject })
  ws.send(JSON.stringify({ id: rid, method, params }))
})
ws.on('message', raw => {
  const m = JSON.parse(raw.toString()); gameClock.follow(m.clock || m.result?.state?.clock || m.result?.clock)
  const p = pending.get(m.id)
  if (!p) return
  pending.delete(m.id)
  m.ok ? p.resolve(m.result) : p.reject(new Error(m.error))
})
const sleep = ms => gameClock.sleep(ms)
async function cmd (text) { await call('say', { text }); await sleep(350) }

let failures = 0
function check (label, ok, note = '') {
  if (!ok) failures++
  console.log(`  ${ok ? '[ OK ]' : '[ПЛОХО]'} ${label}${note ? ' — ' + note : ''}`)
}
const inv = (r) => (r && r.state && r.state.inventory) || {} as Record<string, any>
const pos = (r) => (r && r.state && (r.state.position || r.state.pos)) || {} as Record<string, any>
const lines = (r) => ((r && r.detail && r.detail.lines) || []).join('\n    ')

async function locate (what, dim = null) {
  const c = dim ? `/execute in minecraft:${dim} run locate structure minecraft:${what}` : `/locate structure minecraft:${what}`
  const r: any = await call('ask', { command: c, match: 'nearest|Could not', ms: 20000 })
  const line = ((r.detail && r.detail.lines) || []).find(l => /nearest/.test(l))
  const m = line && line.match(/\[(-?\d+), (~|-?\d+), (-?\d+)\]/)
  return m ? { x: +m[1], y: m[2] === '~' ? null : +m[2], z: +m[3] } : null
}

async function kit ({ extra = [] }: any = {} as Record<string, any>) {
  await cmd('/clear @s')
  await cmd('/effect clear @s')
  await cmd('/effect give @s minecraft:instant_health 1 10 true')
  await cmd('/effect give @s minecraft:saturation 1 10 true')
  for (const it of ['iron_pickaxe', 'iron_sword', 'iron_axe', 'iron_shovel', 'shield', 'iron_helmet', 'iron_chestplate', 'iron_leggings', 'iron_boots']) await cmd(`/give @s minecraft:${it} 1`)
  await cmd('/give @s minecraft:cooked_beef 24')
  await cmd('/give @s minecraft:cobblestone 48')
  await cmd('/give @s minecraft:torch 16')
  for (const it of extra) await cmd(`/give @s minecraft:${it}`)
  await sleep(1200)
}

// На поверхность у точки: spreadplayers ставит на верхний твёрдый блок.
async function dropAt (x, z, dim = null) {
  const under = dim === 'the_nether' ? ' under 90' : ''
  const pre = dim ? `/execute in minecraft:${dim} run ` : '/'
  await cmd(`${pre}spreadplayers ${x} ${z} 0 1${under} false @s`)
  await sleep(4000)
}

// Сцена строит постройку заново на том же месте: забыть прошлую и её сундуки.
async function forget (kind) { await call('structure', { mode: 'forget', kind, looted: true }) }

async function scan (radius = 48) {
  const r: any = await call('structure', { mode: 'scan', radius })
  const seen = (r.detail && r.detail.seen) || []
  console.log('  видит:', seen.map(d => `${d.kind}@${d.at.x},${d.at.y},${d.at.z} (${d.dist} бл.; ${d.evidence.join(',')})`).join(' | ') || 'ничего')
  return seen
}

async function explore (params) {
  const t0 = gameClock.now()
  const r: any = await call('structure', { mode: 'explore', timeoutSeconds: 300, ...params })
  const d = r.detail || {} as Record<string, any>
  console.log(`  explore ${r.status} за ${Math.round((gameClock.now() - t0) / 1000)} с${r.error ? ' — ' + r.error : ''}${d.stopped ? ' — встал: ' + d.stopped : ''}`)
  if (d.lines) console.log('    ' + lines(r))
  return r
}

async function prep () {
  await cmd('/gamerule advance_time false')
  await cmd('/time set 1000')
  await cmd('/weather clear 12000')
  await cmd('/difficulty normal')
  await cmd('/gamerule spawn_mobs true')
}

// ---------------------------------------------------------------- (а) данж
async function dungeon () {
  console.log('(а) данж')
  const X = -2600; const Y = 100; const Z = -3000
  // Чанки грузит сервер (forceload): /fill по незагруженным молча не работает,
  // а бот над незагруженным чанком висит и вылетает за «полёт».
  await cmd(`/forceload add ${X - 16} ${Z - 32} ${X + 16} ${Z + 16}`)
  await sleep(1500)
  // Площадка и комната 9x9x5 из замшелого булыжника, вход с севера.
  await cmd(`/fill ${X - 12} ${Y - 1} ${Z - 18} ${X + 12} ${Y - 1} ${Z + 8} minecraft:stone`)
  await cmd(`/fill ${X - 12} ${Y} ${Z - 18} ${X + 12} ${Y + 8} ${Z + 8} minecraft:air`)
  await cmd(`/fill ${X - 4} ${Y - 1} ${Z - 4} ${X + 4} ${Y + 4} ${Z + 4} minecraft:mossy_cobblestone hollow`)
  await cmd(`/fill ${X - 3} ${Y + 4} ${Z - 3} ${X + 3} ${Y + 4} ${Z + 3} minecraft:cobblestone`)
  await cmd(`/fill ${X} ${Y} ${Z - 4} ${X} ${Y + 1} ${Z - 4} minecraft:air`)
  await cmd('/kill @e[type=!minecraft:player,distance=..40]')
  await cmd(`/setblock ${X} ${Y} ${Z} minecraft:spawner{SpawnData:{entity:{id:"minecraft:zombie"}},Delay:200s}`)
  await cmd(`/setblock ${X + 3} ${Y} ${Z + 3} minecraft:chest{LootTable:"minecraft:chests/simple_dungeon"}`)
  // Чат режет команду на 256 символах — без «minecraft:» в id.
  await cmd(`/setblock ${X - 3} ${Y} ${Z + 3} chest{Items:[{Slot:0b,id:"golden_apple",count:1},{Slot:1b,id:"diamond",count:2},{Slot:2b,id:"rotten_flesh",count:8},{Slot:3b,id:"bone",count:5},{Slot:4b,id:"music_disc_13",count:1}]}`)
  // Чужой сундук у входа снаружи: табличка рядом.
  await cmd(`/setblock ${X + 3} ${Y} ${Z - 6} minecraft:chest{Items:[{Slot:0b,id:"minecraft:iron_ingot",count:10}]}`)
  await cmd(`/setblock ${X + 4} ${Y} ${Z - 6} minecraft:oak_sign`)
  await kit()
  await cmd(`/tp @s ${X} ${Y} ${Z - 14} 0 0`)
  await sleep(1500)
  await forget('dungeon')
  const seen = await scan()
  check('(а) узнал данж глазами', seen.some(d => d.kind === 'dungeon'))
  const r: any = await explore({ kind: 'dungeon' })
  const d = r.detail || {} as Record<string, any>
  const took = d.took || {} as Record<string, any>
  console.log('  сундуки:', JSON.stringify(d.chests))
  check('(а) взял яблоко и алмазы', took.golden_apple >= 1 && took.diamond >= 2, JSON.stringify(took))
  check('(а) хлам оставил', !took.rotten_flesh && !took.bone && !took.music_disc_13, JSON.stringify(d.left))
  check('(а) спавнер сломан', (d.disarmed || []).some(s => /спавнер .* сломан/.test(s)), (d.disarmed || []).join('; '))
  check('(а) чужой сундук с табличкой не тронут', !took.iron_ingot && (d.skipped || []).length >= 1, JSON.stringify(d.skipped))
  const b: any = await call('blocks_around', { find: 'spawner', radius: 16 })
  check('(а) спавнера в мире нет', !((b.detail && b.detail.found) || []).length)
}

// ---------------------------------------------------------------- (б) пустынный храм
async function desert () {
  console.log('(б) пустынный храм')
  const at = await locate('desert_pyramid')
  if (!at) return check('(б) /locate нашёл храм', false)
  await dropAt(at.x + 28, at.z + 4)
  await kit()
  await sleep(2000)
  await forget('desert_pyramid')
  const seen = await scan(64)
  check('(б) узнал храм глазами', seen.some(d => d.kind === 'desert_pyramid'))
  const hp0 = (((await call('status')) as any).state || {} as Record<string, any>).health
  const r: any = await explore({ kind: 'desert_pyramid' })
  const d = r.detail || {} as Record<string, any>
  const st: any = await call('status')
  check('(б) плита снята', (d.disarmed || []).some(s => /плита/.test(s)), (d.disarmed || []).join('; '))
  check('(б) сундуки открыты (≥3)', (d.chests || []).filter(c => !c.error).length >= 3, JSON.stringify(d.chests))
  check('(б) TNT взят', (inv(st).tnt || 0) >= 1, `tnt ${inv(st).tnt || 0}`)
  check('(б) жив и не взорван', (st.state || {} as Record<string, any>).health >= Math.min(10, hp0 || 20), `hp ${(st.state || {} as Record<string, any>).health}`)
}

// ---------------------------------------------------------------- (в) руины портала
async function portal () {
  console.log('(в) руины портала')
  const v = await locate('village_plains')
  const cx = (v ? v.x : -2320) + 120
  const cz = (v ? v.z : -3136)
  await dropAt(cx, cz)
  const st0 = await call('status')
  const p0 = pos(st0)
  const r0: any = await call('ask', { command: `/place structure minecraft:ruined_portal ${Math.round(p0.x) + 24} ${Math.round(p0.y)} ${Math.round(p0.z)}`, match: 'Generated|Failed', ms: 10000 })
  console.log('  /place:', ((r0.detail && r0.detail.lines) || []).join(' '))
  await kit()
  await sleep(1500)
  await forget('ruined_portal')
  const seen = await scan(48)
  check('(в) узнал руины портала', seen.some(d => d.kind === 'ruined_portal'))
  const r: any = await explore({ kind: 'ruined_portal' })
  const d = r.detail || {} as Record<string, any>
  check('(в) сундук открыт', (d.chests || []).some(c => !c.error), JSON.stringify(d.chests))
  check('(в) счёт обсидиана в ответе', !!d.portal, JSON.stringify(d.portal))
}

// ---------------------------------------------------------------- (г) шахта
async function mineshaft () {
  console.log('(г) кусок шахты')
  const X = -2600; const Y = 100; const Z = -3060
  await cmd(`/forceload add ${X - 16} ${Z - 24} ${X + 16} ${Z + 16}`)
  await sleep(1500)
  await cmd(`/fill ${X - 10} ${Y - 1} ${Z - 16} ${X + 10} ${Y - 1} ${Z + 12} minecraft:stone`)
  await cmd(`/fill ${X - 10} ${Y} ${Z - 16} ${X + 10} ${Y + 6} ${Z + 12} minecraft:air`)
  await cmd('/kill @e[type=!minecraft:player,distance=..40]')
  // Коридор 3x3 из досок с опорами и рельсами.
  await cmd(`/fill ${X - 2} ${Y - 1} ${Z - 6} ${X + 2} ${Y + 3} ${Z + 8} minecraft:oak_planks hollow`)
  await cmd(`/fill ${X - 1} ${Y} ${Z - 6} ${X + 1} ${Y + 2} ${Z - 6} minecraft:air`)
  await cmd(`/fill ${X} ${Y} ${Z - 5} ${X} ${Y} ${Z + 7} minecraft:rail`)
  await cmd(`/setblock ${X - 1} ${Y} ${Z - 2} minecraft:oak_fence`)
  await cmd(`/setblock ${X + 1} ${Y} ${Z - 2} minecraft:oak_fence`)
  await cmd(`/setblock ${X - 1} ${Y + 2} ${Z + 1} minecraft:cobweb`)
  await cmd(`/setblock ${X + 1} ${Y + 2} ${Z} minecraft:cobweb`)
  await cmd(`/setblock ${X + 1} ${Y} ${Z + 4} minecraft:spawner{SpawnData:{entity:{id:"minecraft:cave_spider"}},Delay:400s}`)
  await cmd(`/summon minecraft:chest_minecart ${X} ${Y} ${Z + 6} {LootTable:"minecraft:chests/abandoned_mineshaft"}`)
  await kit()
  await cmd(`/tp @s ${X} ${Y} ${Z - 12} 0 0`)
  await sleep(1500)
  await forget('mineshaft')
  const seen = await scan()
  check('(г) узнал шахту', seen.some(d => d.kind === 'mineshaft'))
  const r: any = await explore({ kind: 'mineshaft' })
  const d = r.detail || {} as Record<string, any>
  check('(г) вагонетка открыта', (d.chests || []).some(c => c.cart && !c.error), JSON.stringify(d.chests))
  check('(г) спавнер пауков сломан', (d.disarmed || []).some(s => /спавнер .* сломан/.test(s)), (d.disarmed || []).join('; '))
}

// ---------------------------------------------------------------- (д) корабль
// Натуральный «на мели» у -2672,-3168 оказался целиком в камне (не увидеть);
// поэтому затонувший корабль ставится в океан глубиной 10-15 блоков.
async function shipwreck () {
  console.log('(д) затонувший корабль')
  const X = -2900; const Z = -3000
  await cmd(`/forceload add ${X - 32} ${Z - 32} ${X + 32} ${Z + 32}`)
  await sleep(1500)
  const r0: any = await call('ask', { command: `/place structure minecraft:shipwreck ${X} 50 ${Z}`, match: 'Generated|Failed', ms: 10000 })
  console.log('  /place:', ((r0.detail && r0.detail.lines) || []).join(' '))
  // Снаряжение до прыжка в воду: автопилот через 3 с в воде сам выплывает.
  await kit()
  await forget('shipwreck')
  await cmd(`/tp @s ${X + 14} 63 ${Z + 14}`)
  await sleep(1200)
  const seen = await scan(48)
  check('(д) узнал корабль', seen.some(d => d.kind === 'shipwreck'))
  const r: any = await explore({ kind: 'shipwreck' })
  const d = r.detail || {} as Record<string, any>
  const st: any = await call('status')
  check('(д) сундуки корабля открыты', (d.chests || []).filter(c => !c.error).length >= 1, JSON.stringify(d.chests))
  check('(д) не утонул', ((st.state || {} as Record<string, any>).health || 0) > 0, `hp ${(st.state || {} as Record<string, any>).health}`)
  await cmd(`/forceload remove ${X - 32} ${Z - 32} ${X + 32} ${Z + 32}`)
}

// ---------------------------------------------------------------- (е) деревня
async function village () {
  console.log('(е) деревня')
  const at = await locate('village_plains')
  if (!at) return check('(е) /locate нашёл деревню', false)
  await dropAt(at.x, at.z)
  await kit()
  await sleep(2500)
  const st0 = await call('status')
  const p0 = pos(st0)
  // Чужой сундук посреди деревни: табличка рядом.
  await cmd(`/setblock ${Math.round(p0.x) + 2} ${Math.round(p0.y)} ${Math.round(p0.z) + 2} minecraft:chest{Items:[{Slot:0b,id:"minecraft:diamond",count:5}]}`)
  await cmd(`/setblock ${Math.round(p0.x) + 3} ${Math.round(p0.y)} ${Math.round(p0.z) + 2} minecraft:oak_sign`)
  await forget('village')
  const seen = await scan(64)
  check('(е) узнал деревню', seen.some(d => d.kind === 'village'))
  const r: any = await explore({ kind: 'village', maxDistance: 160 })
  const d = r.detail || {} as Record<string, any>
  const st = await call('status')
  const beds = Object.entries<any>(inv(st)).filter(([n]: any) => /_bed$/.test(n)).reduce((n, [, c]: any) => n + c, 0)
  check('(е) кровати взяты', beds >= 1, `кроватей ${beds}`)
  check('(е) чужой сундук с алмазами не тронут', !(d.took || {} as Record<string, any>).diamond || (d.took.diamond < 5), JSON.stringify(d.skipped))
}

// ---------------------------------------------------------------- (ж) крепость Ада
async function fortress () {
  console.log('(ж) крепость Ада')
  const at = await locate('fortress', 'the_nether')
  if (!at) return check('(ж) /locate нашёл крепость', false)
  await kit({ extra: ['golden_helmet 1'] })
  await cmd('/effect give @s minecraft:fire_resistance 600 0 true')
  await dropAt(at.x, at.z, 'the_nether')
  await sleep(3000)
  await forget('fortress')
  const seen = await scan(64)
  check('(ж) узнал крепость Ада', seen.some(d => d.kind === 'fortress'))
  const r: any = await explore({ kind: 'fortress', maxDistance: 96 })
  const d = r.detail || {} as Record<string, any>
  check('(ж) explore отработал', r.status === 'done', d.stopped || r.error || '')
  console.log('  сундуки:', JSON.stringify(d.chests))
  await cmd('/execute in minecraft:overworld run tp @s -2600 101 -3014')
}

// ---------------------------------------------------------------- (з) храм в джунглях
async function jungle () {
  console.log('(з) храм в джунглях')
  const at = await locate('jungle_pyramid')
  if (!at) return check('(з) /locate нашёл храм', false)
  await dropAt(at.x + 20, at.z + 20)
  await kit({ extra: ['shears 1', 'bow 1'] })
  await sleep(2000)
  await forget('jungle_pyramid')
  const seen = await scan(48)
  check('(з) узнал храм в джунглях', seen.some(d => d.kind === 'jungle_pyramid'))
  const r: any = await explore({ kind: 'jungle_pyramid' })
  const d = r.detail || {} as Record<string, any>
  check('(з) растяжки сняты', (d.disarmed || []).some(s => /растяж|нить|крюк/.test(s)), (d.disarmed || []).join('; '))
  check('(з) сундуки открыты', (d.chests || []).filter(c => !c.error).length >= 1, JSON.stringify(d.chests))
}

async function main () {
  await new Promise<any>((resolve, reject) => { ws.once('open', resolve); ws.once('error', reject) })
  try { await call('connect') } catch {}
  await sleep(1500)
  await prep()
  const ONLY = process.env.ONLY || 'абвгде'
  const stages = [['а', dungeon], ['б', desert], ['в', portal], ['г', mineshaft], ['д', shipwreck], ['е', village], ['ж', fortress], ['з', jungle]]
  for (const [k, fn] of (stages as Array<any>)) {
    if (!ONLY.includes(k)) continue
    try { await fn() } catch (e) { check(`(${k}) без исключений`, false, e.message) }
  }
  const w: any = await call('structure', { mode: 'where', kind: 'village' })
  console.log('где деревня дальше:', (w.detail && w.detail.text) || '')
  console.log(failures ? `ПРОВАЛОВ: ${failures}` : 'всё зелёное')
  process.exitCode = failures ? 1 : 0
  ws.close()
}
main().catch(e => { console.error('FAILED:', e.message); process.exitCode = 1; ws.close() })
