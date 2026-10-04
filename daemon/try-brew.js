'use strict'
// Зелья (src/brew.js), честно: только сырьё через /give — стержни ифрита,
// булыжник, песок, уголь, слизь, адский нарост, редстоун, порох. Стойку,
// порошок, сливки магмы, стекло (печь), бутылки и воду в них бот делает сам.
//   (а) план без сырья: чего не хватает и где взять
//   (б) огнестойкость ×3 из сырья (стекло из песка, стойка из стержня)
//   (в) взрывная долгая сила ×3: нарост → порошок → редстоун → порох
// Площадка x=2440 z=1600, источник воды рядом (/setblock — это мир, не рюкзак).
const WebSocket = require('ws')

const ws = new WebSocket(process.env.ND_WS || 'ws://127.0.0.1:8765')
let id = 0
const pending = new Map()
const call = (method, params = {}) => new Promise((resolve, reject) => {
  const rid = ++id
  pending.set(rid, { resolve, reject })
  ws.send(JSON.stringify({ id: rid, method, params }))
})
ws.on('message', raw => {
  const m = JSON.parse(raw.toString())
  const p = pending.get(m.id)
  if (!p) return
  pending.delete(m.id)
  m.ok ? p.resolve(m.result) : p.reject(new Error(m.error))
})
const sleep = ms => new Promise(r => setTimeout(r, ms))
async function cmd (text) { await call('say', { text }); await sleep(350) }

let failures = 0
function check (label, ok, note = '') {
  if (!ok) failures++
  console.log(`  ${ok ? '[ OK ]' : '[ПЛОХО]'} ${label}${note ? ' — ' + note : ''}`)
}
const brief = (r) => JSON.stringify(r.detail || r.error || r.status).slice(0, 700)

const X = 2440
const Y = 100
const Z = 1600

async function stage () {
  await cmd(`/tp @s ${X + 0.5} ${Y + 2} ${Z + 0.5}`)
  await cmd('/effect give @s minecraft:slow_falling 5 0 true')
  await sleep(2500)
  await cmd(`/fill ${X - 8} ${Y - 4} ${Z - 8} ${X + 8} ${Y - 1} ${Z + 8} minecraft:stone`)
  await cmd(`/fill ${X - 8} ${Y} ${Z - 8} ${X + 8} ${Y + 5} ${Z + 8} minecraft:air`)
  // Лужа-источник в полу в 4 блоках.
  await cmd(`/setblock ${X + 4} ${Y - 1} ${Z} minecraft:water`)
  await cmd('/kill @e[type=!minecraft:player,distance=..30]')
  await cmd(`/tp @s ${X + 0.5} ${Y} ${Z + 0.5}`)
  await cmd('/clear @s')
  await sleep(600)
}

async function main () {
  await new Promise((resolve, reject) => { ws.once('open', resolve); ws.once('error', reject) })
  try { await call('connect') } catch {}
  await sleep(1500)
  await cmd('/gamerule log_admin_commands false')
  await cmd('/difficulty peaceful')
  await cmd('/time set 1000')
  const ONLY = process.env.ONLY || ''
  const on = k => !ONLY || ONLY.includes(k)

  if (on('а')) {
    await stage()
    const r = await call('brew', { potion: 'fire_resistance', plan: true })
    const d = r.detail || {}
    const miss = (d.missing || []).map(m => m.what)
    check('(а) план: цепочка нарост → сливки магмы', JSON.stringify(d.steps) === '["nether_wart","magma_cream"]', JSON.stringify(d.steps))
    check('(а) не хватает нароста, сливок, порошка, стойки, бутылок', ['nether_wart', 'magma_cream', 'blaze_powder', 'brewing_stand', 'glass_bottle'].every(w => miss.includes(w)), miss.join(','))
    check('(а) сказано, где брать нарост', /крепост/.test(((d.missing || []).find(m => m.what === 'nether_wart') || {}).where || ''))
  }

  if (on('б')) {
    await stage()
    await cmd('/give @s minecraft:blaze_rod 2')
    await cmd('/give @s minecraft:cobblestone 11')
    await cmd('/give @s minecraft:oak_log 1') // верстак: стойка 3x2, в рюкзаке не собрать
    await cmd('/give @s minecraft:sand 3')
    await cmd('/give @s minecraft:coal 2')
    await cmd('/give @s minecraft:slime_ball 1')
    await cmd('/give @s minecraft:nether_wart 1')
    await sleep(800)
    const t0 = Date.now()
    const r = await call('brew', { potion: 'fire_resistance', count: 3 })
    const d = r.detail || {}
    const s = Math.round((Date.now() - t0) / 1000)
    check('(б) огнестойкость сварена ×3', r.status === 'done' && d.made === 3, `${brief(r)} за ${s} с`)
    const inv = (r.state && r.state.inventory) || {}
    check('(б) стойку, стекло, бутылки сделал сам', !!d.stand && !inv.sand && !inv.blaze_rod, JSON.stringify(inv))
    console.log('     шаги:', (d.steps || []).join(' | '))
  }

  if (on('в')) {
    await cmd('/give @s minecraft:nether_wart 1')
    await cmd('/give @s minecraft:blaze_rod 1')
    await cmd('/give @s minecraft:redstone 1')
    await cmd('/give @s minecraft:gunpowder 1')
    await cmd('/give @s minecraft:glass_bottle 3')
    await sleep(800)
    const t0 = Date.now()
    const r = await call('brew', { potion: 'long_strength', splash: true, count: 3 })
    const d = r.detail || {}
    check('(в) взрывная долгая сила ×3', r.status === 'done' && d.made === 3, `${brief(r)} за ${Math.round((Date.now() - t0) / 1000)} с`)
    console.log('     шаги:', (d.steps || []).join(' | '))
  }

  console.log(failures ? `\nПЛОХО: ${failures}` : '\nвсё зелёное')
  ws.close()
  process.exit(failures ? 1 : 0)
}

main().catch(e => { console.error('сцена упала:', e); process.exit(2) })
