'use strict'
const gameClock = require('./src/game-clock')
// Животные, голем, жители (src/fauna.js): приручить волка и кошку, усадить,
// развести коров, построить железного и снежного голема, поторговать.
// Всё на своей площадке x=1900; животные и житель — /summon, а приручение,
// любовь и сделки — честные, как у игрока.
const WebSocket = require('ws')

const ws = new WebSocket(process.env.ND_WS || 'ws://127.0.0.1:8765')
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
const brief = (r) => JSON.stringify(r.detail || r.error || r.status).slice(0, 220)

const X = 1900
const Y = 100
const Z = 1600

async function main () {
  await new Promise<any>((resolve, reject) => { ws.once('open', resolve); ws.once('error', reject) })
  try { await call('connect') } catch {}
  await sleep(1500)
  await cmd('/difficulty peaceful')
  await cmd(`/tp @s ${X + 0.5} ${Y + 2} ${Z + 0.5}`)
  await cmd('/effect give @s minecraft:slow_falling 5 0 true')
  await sleep(2500)
  await cmd(`/fill ${X - 16} ${Y - 1} ${Z - 16} ${X + 16} ${Y - 1} ${Z + 16} minecraft:grass_block`)
  await cmd(`/fill ${X - 16} ${Y} ${Z - 16} ${X + 16} ${Y + 6} ${Z + 16} minecraft:air`)
  // Забор по краю — чтобы животные не ушли с площадки.
  await cmd(`/fill ${X - 16} ${Y} ${Z - 16} ${X + 16} ${Y} ${Z - 16} minecraft:oak_fence`)
  await cmd(`/fill ${X - 16} ${Y} ${Z + 16} ${X + 16} ${Y} ${Z + 16} minecraft:oak_fence`)
  await cmd(`/fill ${X - 16} ${Y} ${Z - 16} ${X - 16} ${Y} ${Z + 16} minecraft:oak_fence`)
  await cmd(`/fill ${X + 16} ${Y} ${Z - 16} ${X + 16} ${Y} ${Z + 16} minecraft:oak_fence`)
  await cmd('/kill @e[type=!minecraft:player,distance=..40]')
  await cmd(`/tp @s ${X + 0.5} ${Y} ${Z + 0.5}`)
  await cmd('/clear @s')

  // (а) Волк: 24 кости, шанс 1/3.
  {
    await cmd(`/summon minecraft:wolf ${X + 4} ${Y} ${Z}`)
    await cmd('/give @s minecraft:bone 24')
    await sleep(800)
    const r: any = await call('animals', { mode: 'tame', kind: 'wolf', tries: 24 })
    const d = r.detail || {} as Record<string, any>
    check('(а) волк приручён', d.tamed === true, `костей ${d.used}, дым ${d.fails}; ${brief(r)}`)
    await sleep(1500)
  }
  // (б) Усадить и поднять.
  {
    const r1: any = await call('animals', { mode: 'sit' })
    // Только что приручённый уже сидит по приказу — «сел» значит «сидит», а не «щёлкнул».
    check('(б) волк сидит', (r1.detail || {} as Record<string, any>).inState >= 1, brief(r1))
    const r2: any = await call('animals', { mode: 'stand' })
    check('(б) волк встал', (r2.detail || {} as Record<string, any>).inState >= 1, brief(r2))
  }
  // (в) Кошка: 24 трески.
  {
    await cmd(`/summon minecraft:cat ${X - 4} ${Y} ${Z}`)
    await cmd('/give @s minecraft:cod 24')
    await sleep(800)
    const r: any = await call('animals', { mode: 'tame', kind: 'cat', tries: 24 })
    const d = r.detail || {} as Record<string, any>
    check('(в) кошка приручена', d.tamed === true, `рыб ${d.used}; ${brief(r)}`)
  }
  // (г) Коровы: пара и 4 пшеницы.
  {
    await cmd(`/summon minecraft:cow ${X} ${Y} ${Z + 5}`)
    await cmd(`/summon minecraft:cow ${X + 1} ${Y} ${Z + 6}`)
    await cmd('/give @s minecraft:wheat 4')
    await sleep(800)
    const r: any = await call('animals', { mode: 'breed', kind: 'cow', pairs: 1 })
    check('(г) родился телёнок', (r.detail || {} as Record<string, any>).bred >= 1, brief(r))
  }
  // (д) Железный голем: 4 блока железа и вырезанная тыква.
  {
    await cmd(`/tp @s ${X - 8.5} ${Y} ${Z - 8.5} -90 0`)
    await cmd('/give @s minecraft:iron_block 4')
    await cmd('/give @s minecraft:carved_pumpkin 1')
    await sleep(800)
    const r: any = await call('golem', { kind: 'iron' })
    check('(д) железный голем', (r.detail || {} as Record<string, any>).built === true, brief(r))
  }
  // (е) Снежный голем из тыквы и ножниц — вырезать на месте.
  {
    await cmd(`/tp @s ${X + 8.5} ${Y} ${Z - 8.5} 90 0`)
    await cmd('/give @s minecraft:snow_block 2')
    await cmd('/give @s minecraft:pumpkin 1')
    await cmd('/give @s minecraft:shears 1')
    await sleep(800)
    const r: any = await call('golem', { kind: 'snow' })
    check('(е) снежный голем (тыква вырезана на месте)', (r.detail || {} as Record<string, any>).built === true, brief(r))
  }
  // (ж) Торговля: фермер берёт 20 пшеницы за изумруд.
  {
    await cmd(`/tp @s ${X + 0.5} ${Y} ${Z - 6.5}`)
    // Чат режет строку на 256 символах — команда должна влезть.
    await cmd(`/summon villager ${X + 2} ${Y} ${Z - 6} {NoAI:1b,VillagerData:{profession:farmer,level:2,type:plains},Offers:{Recipes:[{buy:{id:wheat,count:20},sell:{id:emerald,count:1}},{buy:{id:emerald,count:1},sell:{id:bread,count:6}}]}}`)
    await cmd('/give @s minecraft:wheat 40')
    await sleep(1000)
    const l: any = await call('trade', { mode: 'list' })
    const ld = l.detail || {} as Record<string, any>
    check('(ж) видит сделки жителя', (ld.trades || []).length >= 2, ld.text || brief(l))
    const b: any = await call('trade', { mode: 'buy', want: 'emerald', times: 2 })
    const bd = b.detail || {} as Record<string, any>
    check('(ж) продал пшеницу за 2 изумруда', bd.got >= 2, brief(b))
    const c: any = await call('trade', { mode: 'buy', want: 'bread', times: 1 })
    check('(ж) купил хлеб за изумруд', ((c.detail || {} as Record<string, any>).got || 0) >= 6, brief(c))
  }

  await cmd('/difficulty normal')
  console.log(failures ? `\nПЛОХО: ${failures}` : '\nвсё зелёное')
  ws.close()
  process.exit(failures ? 1 : 0)
}

main().catch(e => { console.error('сцена упала:', e); process.exit(2) })
