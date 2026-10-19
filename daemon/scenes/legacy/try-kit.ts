'use strict'
import * as gameClock from '../../src/game-clock'
// Сборы и рефлексы (src/fightkit.js):
//   (а) чек-лист Энда без крафта: чего не хватает и зачем
//   (б) сборы в Ад из сырья: щит, лук, стрелы, огниво, 2 золотых яблока,
//       золотой шлем (и надет) — бот крафтит сам
//   (в) горит — сам пьёт огнестойкость (автопилот)
//   (г) 8 хп и зомби рядом — сам ест золотое яблоко (автопилот)
//   (д) бой: хп падает — яблоко посреди боя (combat.fightBody → healInFight)
// Площадка x=2480 z=1600. Меч, нагрудник и кирка — «уже есть» (их крафт — prep).
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
const brief = (r) => JSON.stringify(r.detail || r.error || r.status).slice(0, 700)
const inv = (r) => (r && r.state && r.state.inventory) || {} as Record<string, any>

const X = 2480
const Y = 100
const Z = 1600

async function stage () {
  await cmd(`/tp @s ${X + 0.5} ${Y + 2} ${Z + 0.5}`)
  await sleep(2500)
  await cmd(`/fill ${X - 8} ${Y - 4} ${Z - 8} ${X + 8} ${Y - 1} ${Z + 8} minecraft:stone`)
  await cmd(`/fill ${X - 8} ${Y} ${Z - 8} ${X + 8} ${Y + 5} ${Z + 8} minecraft:air`)
  await cmd('/kill @e[type=!minecraft:player,distance=..30]')
  await cmd(`/tp @s ${X + 0.5} ${Y} ${Z + 0.5}`)
  await cmd('/clear @s')
  await cmd('/effect clear @s')
  await sleep(600)
}

// Подождать и собрать события автопилота. mc_wait будит первый же урон, так
// что ждём кусками, пока не придёт нужное или не выйдет время.
async function waitEvents (seconds, want = null) {
  const out = []
  const t0 = gameClock.now()
  while (gameClock.now() - t0 < seconds * 1000) {
    const r: any = await call('wait', { seconds: Math.max(1, Math.ceil(seconds - (gameClock.now() - t0) / 1000)) })
    out.push(...(r.events || []), ...(r.by ? [r.by] : []))
    if (want && out.some(want)) break
  }
  return out
}

async function main () {
  await new Promise<any>((resolve, reject) => { ws.once('open', resolve); ws.once('error', reject) })
  try { await call('connect') } catch {}
  await sleep(1500)
  await cmd('/gamerule log_admin_commands false')
  await cmd('/difficulty peaceful')
  await cmd('/time set 1000')
  const ONLY = process.env.ONLY || ''
  const on = k => !ONLY || ONLY.includes(k)

  if (on('а')) {
    await stage()
    await cmd('/give @s minecraft:iron_sword 1')
    await sleep(500)
    const r: any = await call('kit', { for: 'dragon', craft: false })
    const d = r.detail || {} as Record<string, any>
    const miss = (d.items || []).filter(i => !i.ok).map(i => i.key)
    check('(а) к дракону не готов', d.ready === false && /не готов/.test(d.stopped || ''), d.stopped)
    check('(а) не хватает лука, стрел, кроватей, яблок, ведра', ['bow', 'arrows', 'beds', 'gapple', 'water_bucket'].every(k => miss.includes(k)), miss.join(','))
    check('(а) меч есть — не в списке', !miss.includes('sword'))
  }

  if (on('б')) {
    await stage()
    await cmd('/give @s minecraft:iron_sword 1')
    await cmd('/give @s minecraft:iron_chestplate 1')
    await cmd('/give @s minecraft:iron_pickaxe 1')
    await cmd('/give @s minecraft:iron_ingot 2')
    await cmd('/give @s minecraft:oak_log 4')
    await cmd('/give @s minecraft:string 3')
    await cmd('/give @s minecraft:flint 3')
    await cmd('/give @s minecraft:feather 2')
    await cmd('/give @s minecraft:gold_ingot 21')
    await cmd('/give @s minecraft:apple 2')
    await cmd('/give @s minecraft:cobblestone 64')
    await cmd('/give @s minecraft:cooked_beef 8')
    await sleep(800)
    const t0 = gameClock.now()
    const r: any = await call('kit', { for: 'nether' })
    const d = r.detail || {} as Record<string, any>
    const i = inv(r)
    const s = Math.round((gameClock.now() - t0) / 1000)
    check('(б) к Аду готов', r.status === 'done' && d.ready === true, `${brief(r)} за ${s} с`)
    check('(б) 2 золотых яблока скрафтил', i.golden_apple === 2, `golden_apple=${i.golden_apple}`)
    check('(б) щит, лук, стрелы, огниво', !!(i.shield || (r.state && r.state.offHand === 'shield')) && i.bow === 1 && (i.arrow || 0) >= 8 && i.flint_and_steel === 1, JSON.stringify(i))
    const head = r.state && r.state.armor && r.state.armor.head
    check('(б) золотой шлем надет (пиглины)', head === 'golden_helmet', `head=${head}`)
  }

  if (on('в')) {
    await stage()
    await cmd('/give @s minecraft:potion[potion_contents={potion:"minecraft:fire_resistance"}] 1')
    await sleep(800)
    // Огонь под ногами: горим.
    await cmd(`/setblock ${X} ${Y} ${Z} minecraft:fire`)
    const ev = await waitEvents(8, e => e.type === 'drank')
    const drank = ev.find(e => e.type === 'drank')
    check('(в) горел — выпил огнестойкость сам', !!(drank && drank.ok), drank ? drank.text : JSON.stringify(ev.map(e => e.type)))
    await cmd(`/setblock ${X} ${Y} ${Z} minecraft:air`)
  }

  if (on('г')) {
    await stage()
    await cmd('/difficulty easy')
    await cmd('/give @s minecraft:golden_apple 1')
    await cmd(`/summon minecraft:zombie ${X + 4} ${Y} ${Z} {NoAI:1b,PersistenceRequired:1b}`)
    await sleep(600)
    await cmd('/damage @s 12 minecraft:generic')
    const ev = await waitEvents(8, e => e.type === 'ate')
    const ate = ev.find(e => e.type === 'ate' && /golden_apple/.test(e.item || ''))
    check('(г) 8 хп и зомби рядом — съел золотое яблоко', !!ate, ate ? ate.text : JSON.stringify(ev.map(e => e.type)))
    await cmd('/kill @e[type=minecraft:zombie,distance=..30]')
    await cmd('/difficulty peaceful')
  }

  if (on('д')) {
    await stage()
    await cmd('/difficulty easy')
    await cmd('/give @s minecraft:iron_sword 1')
    await cmd('/give @s minecraft:golden_apple 2')
    await cmd(`/summon minecraft:zombie ${X + 3} ${Y} ${Z} {PersistenceRequired:1b,Health:60f,attributes:[{id:"minecraft:max_health",base:60}]}`)
    await sleep(600)
    await cmd('/damage @s 11 minecraft:generic')
    await sleep(300)
    const r: any = await call('fight', { target: 'zombie', retreatAtHealth: 3, timeoutSeconds: 40 })
    // Ближний бой с мобом ведёт pvp.duel — он лечится сам (detail.healed);
    // прочие ветки combat.fightBody — через fightkit.healInFight (событие ate).
    const ate = (r.events || []).find(e => e.type === 'ate' && /golden_apple/.test(e.item || ''))
    const healed = ((r.detail && r.detail.healed) || []).some(h => /golden_apple/.test(h))
    check('(д) в бою съел яблоко', !!ate || healed, ate ? ate.text : `${r.status} healed=${JSON.stringify(r.detail && r.detail.healed)} hp=${r.detail && r.detail.hp}`)
    await cmd('/kill @e[type=minecraft:zombie,distance=..30]')
    await cmd('/difficulty peaceful')
  }

  console.log(failures ? `\nПЛОХО: ${failures}` : '\nвсё зелёное')
  ws.close()
  process.exit(failures ? 1 : 0)
}

main().catch(e => { console.error('сцена упала:', e); process.exit(2) })
