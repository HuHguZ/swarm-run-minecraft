'use strict'
import * as gameClock from '../../src/game-clock'
// Полный рюкзак (src/pack.js) и схрон (session.cache): тело само выкидывает
// дешёвое ради дорогого, говорит «РЮКЗАК ПОЛОН», когда выкинуть нечего, ставит
// схрон и разгружается от хлама, не подбирая его обратно.
import WebSocket = require('ws')

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

const X = 1800
const Y = 100
const Z = 1600
const inv = async () => { const s: any = await call('status'); return (s.state && s.state.inventory) || {} as Record<string, any> }

async function fill (big, bigCount?: any) {
  await cmd('/clear @s')
  await cmd('/give @s minecraft:iron_pickaxe')
  await cmd('/give @s minecraft:cooked_beef 16')
  for (const [name, stacks] of big) for (let i = 0; i < stacks; i++) await cmd(`/give @s minecraft:${name} 64`)
  void bigCount
  await sleep(800)
}

async function main () {
  await new Promise<any>((resolve, reject) => { ws.once('open', resolve); ws.once('error', reject) })
  try { await call('connect') } catch {}
  await sleep(1500)
  await cmd('/difficulty peaceful')
  await cmd(`/tp @s ${X + 0.5} ${Y + 2} ${Z + 0.5}`)
  await cmd('/effect give @s minecraft:slow_falling 5 0 true')
  await sleep(2500)
  await cmd(`/fill ${X - 12} ${Y - 1} ${Z - 12} ${X + 12} ${Y - 1} ${Z + 12} minecraft:smooth_stone`)
  await cmd(`/fill ${X - 12} ${Y} ${Z - 12} ${X + 12} ${Y + 5} ${Z + 12} minecraft:air`)
  await cmd(`/kill @e[type=minecraft:item,distance=..30]`)
  await cmd(`/tp @s ${X + 0.5} ${Y} ${Z + 0.5}`)

  // (а) Полон: 6 стопок земли, 28 стопок камня, кирка, еда — 36 клеток.
  // Железная руда рядом: raw_iron дороже земли — выкинуть землю, поднять.
  await fill([['dirt', 6], ['stone', 28]])
  {
    const i0 = await inv()
    await cmd(`/setblock ${X + 2} ${Y} ${Z} minecraft:iron_ore`)
    const r: any = await call('mine', { block: 'iron_ore', count: 1, radius: 6, timeoutSeconds: 40 })
    await sleep(500)
    const i1 = await inv()
    console.log('    mine:', r.status, JSON.stringify(r.detail || r.error).slice(0, 300))
    const ev = (r.events || []).find(e => e.type === 'tossed')
    check('(а) поднял raw_iron в полный рюкзак', (i1.raw_iron || 0) >= 1, `raw_iron ${i1.raw_iron || 0}; ${ev ? 'выкинул ' + ev.tossed.join(',') : 'событие tossed нет'}`)
    check('(а) выкинул землю, а не камень и не снаряжение', (i1.dirt || 0) < (i0.dirt || 0) && (i1.stone || 0) === (i0.stone || 0) && i1.iron_pickaxe === 1,
      `dirt ${i0.dirt}→${i1.dirt}, stone ${i0.stone}→${i1.stone}`)
  }

  // (б) Полон ценным (обсидиан), под ногами уголь — дешевле всего в рюкзаке:
  // не выкидывать обсидиан, сказать «РЮКЗАК ПОЛОН».
  await cmd(`/kill @e[type=minecraft:item,distance=..30]`)
  await fill([['obsidian', 33]])
  await cmd('/give @s minecraft:chest 1')
  {
    await cmd(`/setblock ${X + 2} ${Y} ${Z + 1} minecraft:coal_ore`)
    const r: any = await call('mine', { block: 'coal_ore', count: 1, radius: 6, timeoutSeconds: 30 })
    await sleep(500)
    const i1 = await inv()
    const full = [r.by, ...(r.events || [])].find(e => e && e.type === 'bag_full')
    check('(б) обсидиан ради угля не выкинут', (i1.obsidian || 0) === 33 * 64, `obsidian ${i1.obsidian}`)
    check('(б) сказал «РЮКЗАК ПОЛОН»', !!full, full ? full.text : JSON.stringify((r.events || []).map(e => e.type)))
  }

  // (в) Схрон: сундук рядом, лишнее в него, память.
  {
    const r: any = await call('cache', { mode: 'make' })
    const d = r.detail || {} as Record<string, any>
    const i1 = await inv()
    const list = ((await call('cache', { mode: 'list' })) as any).detail || {} as Record<string, any>
    const mine = (list.caches || []).find(c => c.name === d.name)
    check('(в) схрон поставлен и записан', !!mine, `${d.name} ${JSON.stringify(d.at)}; положил ${JSON.stringify(d.put || {} as Record<string, any>).slice(0, 120)}; ${r.error || d.stopped || ''}`)
    check('(в) место в рюкзаке освободилось', (i1.obsidian || 0) < 33 * 64, `obsidian теперь ${i1.obsidian || 0}`)
  }

  // (г) Разгрузка от хлама: выкинуть землю и не поднять её обратно.
  {
    await cmd(`/kill @e[type=minecraft:item,distance=..30]`)
    await fill([['dirt', 4], ['stone', 2]])
    const r: any = await call('pack', { mode: 'tidy' })
    await sleep(3500)
    const i1 = await inv()
    check('(г) хлам выкинут и не поднят обратно', !i1.dirt, `dirt ${i1.dirt || 0}; ${JSON.stringify(r.detail || r.error).slice(0, 160)}`)
    const st = ((await call('pack', {} as Record<string, any>)) as any).detail || {} as Record<string, any>
    check('(г) status отвечает словами', typeof st.text === 'string', st.text)
  }

  await cmd('/clear @s')
  await cmd('/difficulty normal')
  console.log(failures ? `\nПЛОХО: ${failures}` : '\nвсё зелёное')
  ws.close()
  process.exit(failures ? 1 : 0)
}

main().catch(e => { console.error('сцена упала:', e); process.exit(2) })
