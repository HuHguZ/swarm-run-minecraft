'use strict'
// Арбалет, фейерверки, чтение врага, стрелы с эффектом (ranged.js, read.js;
// 2026-09-26). A — демон NeuroDown (бой как в арене), D — голый mineflayer
// NeuroBuild (оп тестового сервера build): мишень, которой управляет сцена, W —
// голый NeuroEnd: смотрит на D глазами read.js и сверяет с /data.
//   A=ws://127.0.0.1:8781 MC_PORT=25566 node try-xbow.js <этап,этап…>
// Этапы: read, xarrow, xrocket, xpierce, xplain, hisxbow, totem, tipped.
// Поправка протокола minecraft-data (intangible_projectile) — до создания ботов.
require('./src/gamedata')
const mineflayer = require('mineflayer')
const WebSocket = require('ws')
const Vec3 = require('vec3')
const read = require('./src/read')
const ranged = require('./src/ranged')
const edges = require('./src/edges')
const { soundName } = require('./src/melee')

const PORT = Number(process.env.MC_PORT || 25566)
const sleep = ms => new Promise(r => setTimeout(r, ms))
const X = 600; const Y = 150; const Z = 600

function client (url) {
  const ws = new WebSocket(url)
  let id = 0
  const pending = new Map()
  ws.on('message', raw => {
    const m = JSON.parse(raw.toString())
    const p = pending.get(m.id)
    if (!p) return
    pending.delete(m.id)
    m.ok ? p.resolve(m.result) : p.reject(new Error(m.error))
  })
  const ready = new Promise((resolve, reject) => { ws.once('open', resolve); ws.once('error', reject) })
  const call = (method, params = {}) => new Promise((resolve, reject) => {
    const rid = ++id
    pending.set(rid, { resolve, reject })
    ws.send(JSON.stringify({ id: rid, method, params }))
  })
  return { ws, ready, call }
}
function join (username) {
  return new Promise((resolve, reject) => {
    const bot = mineflayer.createBot({ host: '127.0.0.1', port: PORT, username, version: '1.21.11', auth: 'offline' })
    bot.once('spawn', () => resolve(bot))
    bot.once('error', reject)
    bot.once('kicked', (r) => reject(new Error('kicked ' + JSON.stringify(r))))
  })
}
const A = client(process.env.A || 'ws://127.0.0.1:8781')
let D = null
let W = null
const chatLog = []
// Имена (2026-09-26): XB_A — ник бойца-демона, XB_D — мишень, XB_W — зритель.
// XB_CMD=a — команды через демон A (он оп), тогда мишень и зритель могут быть
// не операторами и не занимать ников тестовых демонов. Имена в тексте команд
// сцены — прежние (NeuroDown/NeuroBuild/NeuroEnd), cmd подменяет их.
const AN = process.env.XB_A || 'NeuroDown'
const DN = process.env.XB_D || 'NeuroBuild'
const WN = process.env.XB_W || 'NeuroEnd'
const NAMES = { NeuroDown: AN, NeuroBuild: DN, NeuroEnd: WN }
const mapNames = (t) => t.replace(/NeuroBuild|NeuroDown|NeuroEnd/g, m => NAMES[m])
async function cmd (text, who = null) {
  const t = mapNames(text)
  if (process.env.XB_CMD === 'a' && !who) await A.call('say', { text: t }).catch(() => {})
  else (who || D).chat(t)
  await sleep(90)
}
// /data — ответ приходит сообщением в чат того, кто спросил.
async function dataGet (path) {
  const n0 = chatLog.length
  W.chat(mapNames(`/data get entity NeuroBuild ${path}`))
  const t0 = Date.now()
  while (Date.now() - t0 < 1500) {
    const hit = chatLog.slice(n0).find(s => s.includes(DN) || /has the following|не найден|No elements/.test(s))
    if (hit) return hit
    await sleep(50)
  }
  return '(нет ответа)'
}

const IRON = ['iron_helmet', 'iron_chestplate', 'iron_leggings', 'iron_boots']
const DIAMOND = ['diamond_helmet', 'diamond_chestplate', 'diamond_leggings', 'diamond_boots']
const SLOT = ['armor.head', 'armor.chest', 'armor.legs', 'armor.feet']
async function dress (who, set) { for (let i = 0; i < 4; i++) await cmd(`/item replace entity ${who} ${SLOT[i]} with minecraft:${set[i]}`) }
const ROCKET = 'firework_rocket[fireworks={flight_duration:1,explosions:[{shape:"small_ball"},{shape:"small_ball"},{shape:"small_ball"}]}]'

// Площадки: A на своей, D — через пустоту (A не дойдёт, только стрелять).
async function field (gap = 14) {
  // Площадку A (−3..3) не трогать никогда: иначе A, стоящий на ней с прошлого
  // этапа, падает в пустоту, пока её перекладывают (прогон 2026-09-26). Мишень —
  // пока на неё же.
  await cmd(`/fill ${X - 3} ${Y - 1} ${Z - 3} ${X + 3} ${Y - 1} ${Z + 3} minecraft:stone`)
  await cmd(`/tp NeuroBuild ${X + 2.5} ${Y} ${Z + 2.5}`)
  await sleep(300)
  await cmd(`/fill ${X - 8} ${Y} ${Z - 8} ${X + 8} ${Y + 6} ${Z + 40} minecraft:air`)
  await cmd(`/fill ${X - 8} ${Y - 1} ${Z + 4} ${X + 8} ${Y - 1} ${Z + 40} minecraft:air`)
  await cmd(`/fill ${X - 8} ${Y - 1} ${Z - 8} ${X - 4} ${Y - 1} ${Z + 3} minecraft:air`)
  await cmd(`/fill ${X + 4} ${Y - 1} ${Z - 8} ${X + 8} ${Y - 1} ${Z + 3} minecraft:air`)
  await cmd(`/fill ${X - 3} ${Y - 1} ${Z - 8} ${X + 3} ${Y - 1} ${Z - 4} minecraft:air`)
  if (gap < 4) return
  await cmd(`/fill ${X - 1} ${Y - 1} ${Z + gap - 1} ${X + 1} ${Y - 1} ${Z + gap + 1} minecraft:stone`)
  // Ограда мишени — стекло по пояс не мешает стрелам по телу? Мешает: только
  // невидимая граница из барьеров на уровне ног позади и по бокам.
  for (const [dx, dz] of [[-2, 0], [2, 0], [0, 2], [-2, 1], [2, 1], [-2, -1], [2, -1], [-1, 2], [1, 2]]) await cmd(`/setblock ${X + dx} ${Y} ${Z + gap + dz} minecraft:barrier`)
  await cmd(`/kill @e[type=arrow,x=${X},y=${Y},z=${Z},distance=..60]`)
  await cmd(`/kill @e[type=item,x=${X},y=${Y},z=${Z},distance=..60]`)
}
async function reset (who) { await cmd(`/clear ${who}`); await cmd(`/effect clear ${who}`); await cmd(`/gamemode survival ${who}`) }
async function heal (who) { await cmd(`/effect give ${who} minecraft:instant_health 1 10 true`); await cmd(`/effect give ${who} minecraft:saturation 1 20 true`) }

// Урон мишени — по её же здоровью (она видит своё точно).
function hpWatch (bot) {
  const ev = []
  let last = bot.health
  const on = () => { const h = bot.health; if (h < last - 0.01) ev.push({ t: Date.now(), dmg: Math.round((last - h) * 100) / 100, hp: Math.round(h * 100) / 100 }); last = h }
  bot.on('health', on)
  return { ev, stop: () => bot.removeListener('health', on), reset: () => { last = bot.health; ev.length = 0 } }
}
async function fightA (secs, extra = {}) {
  const r = await A.call('fight', { target: DN, allowPlayer: true, timeoutSeconds: secs, retreatAtHealth: 1, ...extra }).catch(e => ({ status: 'failed', error: e.message }))
  return r
}
const tricksOf = (r, re = /./) => Object.entries((r && r.detail && r.detail.tricks) || {}).filter(([k]) => re.test(k)).map(([k, v]) => `${k}×${v}`).join('; ')

async function stageRead () {
  // D: поглощение II (8), сила II, скорость, огнестойкость, невидимость; W читает.
  await reset('NeuroBuild'); await reset('NeuroEnd')
  await cmd(`/tp NeuroBuild ${X + 0.5} ${Y} ${Z + 4.5} 180 0`)
  await cmd(`/tp NeuroEnd ${X + 0.5} ${Y} ${Z + 0.5} 0 0`)
  await cmd('/effect give NeuroBuild minecraft:absorption 60 1')
  await cmd('/effect give NeuroBuild minecraft:strength 60 1')
  await cmd('/effect give NeuroBuild minecraft:speed 60 0')
  await cmd('/effect give NeuroBuild minecraft:fire_resistance 60 0')
  await cmd('/effect give NeuroBuild minecraft:invisibility 60 0')
  await cmd('/effect give NeuroBuild minecraft:slowness 60 0')
  await sleep(1200)
  const e = W.players[DN] && W.players[DN].entity
  if (!e) { console.log('[read] W не видит D'); return }
  const raw = e.metadata[read.EFFECT_COLOR ? 10 : 10]
  console.log('[read] effect_particles сырые:', JSON.stringify(raw))
  console.log(`[read] read.js: здоровье ${read.healthRaw(W, e)}, поглощение ${read.absorptionOf(W, e)}, эффекты ${[...read.effectsOf(W, e)].join(',')}`)
  console.log('[read] /data Health:', await dataGet('Health'))
  console.log('[read] /data AbsorptionAmount:', await dataGet('AbsorptionAmount'))
  const ae = await dataGet('active_effects')
  console.log('[read] /data active_effects:', ae.replace(/\s+/g, ' ').slice(0, 400))
  // Тотем: слежка W, урон D до срабатывания.
  const w = read.watch(W, { threats: () => [W.players[DN] && W.players[DN].entity].filter(Boolean) })
  await cmd('/effect clear NeuroBuild')
  await cmd('/item replace entity NeuroBuild weapon.offhand with minecraft:totem_of_undying')
  await sleep(400)
  const e2 = W.players[DN].entity
  console.log(`[read] тотем в руке виден: ${read.hasTotemInHand(e2)}`)
  await cmd('/damage NeuroBuild 40 minecraft:generic')
  await sleep(900)
  const s = w.state(e2)
  console.log(`[read] после /damage 40: событие 35 → poppedAgo ${Math.round(w.poppedAgo(e2))} мс, allIn ${JSON.stringify(w.allIn(e2))}, хп ${s.hp} + поглощение ${s.abs}, эффекты ${[...s.effects].join(',')}, тотем в руке ${s.totemInHand}`)
  console.log('[read] /data Health:', await dataGet('Health'), '| AbsorptionAmount:', await dataGet('AbsorptionAmount'))
  // Выбитый щит: D поднимает щит, W бьёт топором.
  await heal('NeuroBuild')
  await cmd('/item replace entity NeuroBuild weapon.offhand with minecraft:shield')
  await cmd('/item replace entity NeuroEnd weapon.mainhand with minecraft:diamond_axe')
  await cmd('/effect give NeuroBuild minecraft:resistance 60 4 true')
  await cmd(`/tp NeuroBuild ${X + 0.5} ${Y} ${Z + 2.6} 180 0`)
  await sleep(700)
  await D.lookAt(W.entity.position.offset(0, 1.6, 0), true)
  await W.lookAt(D.entity.position.offset(0, 1.4, 0), true)
  D.activateItem(true)
  await sleep(1400)
  W.attack(W.players[DN].entity)
  await sleep(500)
  console.log(`[read] топор по щиту: shieldOff ${w.shieldOff(W.players[DN].entity)} мс, stats ${JSON.stringify(w.stats)}`)
  D.deactivateItem()
  // Заряженный арбалет у D, смотрит на W.
  await cmd('/clear NeuroBuild')
  await cmd('/item replace entity NeuroBuild weapon.mainhand with minecraft:crossbow[enchantments={piercing:2}]')
  await cmd('/give NeuroBuild minecraft:arrow 4')
  await sleep(500)
  D.activateItem()
  await sleep(1500)
  D.deactivateItem()
  await sleep(300)
  await D.lookAt(W.entity.position.offset(0, 0.9, 0), true)
  await sleep(500)
  console.log(`[read] его арбалет: ${JSON.stringify(read.crossbowInfo(W, W.players[DN].entity.equipment[0]))}, смотрит на меня: ${JSON.stringify(w.aimedAtMe(W.players[DN].entity))}`)
  await D.look(D.entity.yaw + 1.2, 0, true)
  await sleep(400)
  console.log(`[read] отвернулся: aimedAtMe ${JSON.stringify(w.aimedAtMe(W.players[DN].entity))}`)
  w.close()
}

// A стреляет из арбалета по D через пустоту.
async function stageShoot (name, kit, { shield = false, dArmor = IRON, secs = 12, gap = 14 } = {}) {
  await field(gap)
  await reset('NeuroDown'); await reset('NeuroBuild')
  for (const it of kit) await cmd(`/give NeuroDown ${it}`)
  await dress('NeuroDown', IRON)
  await dress('NeuroBuild', dArmor)
  if (shield) await cmd('/item replace entity NeuroBuild weapon.offhand with minecraft:shield')
  await cmd(`/tp NeuroDown ${X + 0.5} ${Y} ${Z + 0.5} 0 0`)
  await cmd(`/tp NeuroBuild ${X + 0.5} ${Y} ${Z + gap + 0.5} 180 0`)
  await heal('NeuroDown'); await heal('NeuroBuild')
  await sleep(1200)
  const hw = hpWatch(D)
  let lookT = null
  if (shield) {
    await D.lookAt(new Vec3(X + 0.5, Y + 1.5, Z + 0.5), true)
    D.activateItem(true)
    lookT = setInterval(() => { try { D.lookAt(new Vec3(X + 0.5, Y + 1.5, Z + 0.5), true) } catch {} }, 250)
  }
  const t0 = Date.now()
  const r = await fightA(secs)
  if (lookT) clearInterval(lookT)
  if (shield) D.deactivateItem()
  hw.stop()
  const d = r.detail || {}
  const total = hw.ev.reduce((s, x) => s + x.dmg, 0)
  if (r.status !== 'done') console.log(`[${name}] прерван: ${JSON.stringify(r.by || r.error || r.detail).slice(0, 300)}`)
  console.log(`[${name}] ${r.status} ${Math.round((Date.now() - t0) / 100) / 10}с | урон по D: ${hw.ev.map(x => x.dmg).join(', ') || 'нет'} (всего ${Math.round(total * 10) / 10}, хп D ${Math.round(D.health * 10) / 10}) | ${tricksOf(r, /арбалет|стрела|выстрел|лук/)}`)
  return { r, hw }
}

async function stageHisXbow (piercing = false) {
  // D с заряженным арбалетом целится в A; у A щит, меч, железо. Через 3 с D стреляет.
  await field(9)
  await reset('NeuroDown'); await reset('NeuroBuild')
  await cmd('/give NeuroDown minecraft:iron_sword')
  await cmd('/item replace entity NeuroDown weapon.offhand with minecraft:shield')
  await dress('NeuroDown', IRON)
  await cmd(`/item replace entity NeuroBuild weapon.mainhand with minecraft:crossbow${piercing ? '[enchantments={piercing:4}]' : ''}`)
  await cmd('/give NeuroBuild minecraft:arrow 8')
  await cmd(`/tp NeuroDown ${X + 0.5} ${Y} ${Z + 0.5} 0 0`)
  await cmd(`/tp NeuroBuild ${X + 0.5} ${Y} ${Z + 9.5} 180 0`)
  await heal('NeuroDown'); await heal('NeuroBuild')
  await sleep(900)
  D.activateItem(); await sleep(1500); D.deactivateItem()
  await sleep(300)
  const aHp = []
  const fightP = fightA(7)
  // D целится (голова за A), через 3.0 с — выстрел, потом ещё зарядка и выстрел.
  const aimT = setInterval(() => {
    try { const a = D.players[AN] && D.players[AN].entity; if (a) D.lookAt(a.position.offset(0, 1.0, 0), true) } catch {}
  }, 50)
  const shots = []
  await sleep(3000)
  const st1 = await A.call('status').catch(() => null)
  const hp1 = st1 && st1.state ? st1.state.health : null
  // Попала ли — глазами мишени (анимация урона A, 2026-09-26): здоровье A
  // сытость подлечивает, а щит гасит без урона.
  let hurt = false
  let blockedSnd = false
  const onHurtA = (e) => { if (e && e.username === AN) hurt = true }
  const onSnd = (p) => { if (/item\.shield\.block/.test(soundName(D, p))) blockedSnd = true }
  D.on('entityHurt', onHurtA)
  D._client.on('sound_effect', onSnd)
  const aE = D.players[AN] && D.players[AN].entity
  const vA = aE && aE.velocity ? Math.round(Math.hypot(aE.velocity.x, aE.velocity.z) * 100) / 100 : null
  D.activateItem() // выстрел
  shots.push(Date.now())
  await sleep(1200)
  D.removeListener('entityHurt', onHurtA)
  D._client.removeListener('sound_effect', onSnd)
  const st2 = await A.call('status').catch(() => null)
  aHp.push({ before: hp1, after: st2 && st2.state ? st2.state.health : null })
  clearInterval(aimT)
  const r = await fightP
  const verdict = hurt ? 'ПОПАЛА' : 'мимо/щит'
  XB_TRIALS.push({ piercing, hurt })
  console.log(`[hisxbow${piercing ? '+пронзание' : ''}] ${verdict} | хп A до/после выстрела: ${JSON.stringify(aHp)} | скорость A при выстреле ${vA} | звук щита ${blockedSnd} | ${tricksOf(r, /арбалет|щит|линии|пробег/)}`)
}
const XB_TRIALS = []

async function stageTotem () {
  await field(0)
  await cmd(`/fill ${X - 6} ${Y - 1} ${Z - 6} ${X + 6} ${Y - 1} ${Z + 6} minecraft:stone`)
  await reset('NeuroDown'); await reset('NeuroBuild')
  await cmd('/give NeuroDown minecraft:diamond_sword')
  await cmd('/give NeuroDown minecraft:splash_potion[potion_contents={potion:"minecraft:strong_harming"}] 2')
  await dress('NeuroDown', IRON)
  await dress('NeuroBuild', IRON)
  await cmd('/item replace entity NeuroBuild weapon.offhand with minecraft:totem_of_undying')
  await cmd(`/tp NeuroDown ${X + 0.5} ${Y} ${Z - 3.5} 0 0`)
  await cmd(`/tp NeuroBuild ${X + 0.5} ${Y} ${Z + 3.5} 180 0`)
  await heal('NeuroDown'); await heal('NeuroBuild')
  await sleep(900)
  let popAt = 0; let deadAt = 0
  D._client.on('entity_status', p => { if (p.entityId === D.entity.id && p.entityStatus === 35) popAt = Date.now() })
  D.on('death', () => { if (!deadAt) deadAt = Date.now() })
  const fightP = fightA(12)
  await sleep(1500)
  await cmd('/damage NeuroBuild 40 minecraft:generic')
  const r = await fightP
  console.log(`[totem] тотем сработал: ${!!popAt}; добит через ${deadAt && popAt ? deadAt - popAt : '—'} мс после тотема | ${r.status} ${JSON.stringify(r.detail && r.detail.killed)} | ${tricksOf(r, /тотем|наказываю|вред|рывок|враг/)}`)
}

async function stageTipped (only = null) {
  // Лук и стрелы с эффектом; D — алмаз. 1) D убегает → медлительность;
  // 2) у D топор → слабость; 3) D на 5 хп → вред коротким натяжением.
  const kit = ['minecraft:bow', 'minecraft:arrow 16',
    'minecraft:tipped_arrow[potion_contents={potion:"minecraft:strong_harming"}] 8',
    'minecraft:tipped_arrow[potion_contents={potion:"minecraft:slowness"}] 8',
    'minecraft:tipped_arrow[potion_contents={potion:"minecraft:weakness"}] 8']
  for (const [label, setup] of [
    ['убегает', async () => { await D.look(Math.PI, 0, true); D.setControlState('forward', true); D.setControlState('sprint', true) }],
    ['топор', async () => { await cmd('/item replace entity NeuroBuild weapon.mainhand with minecraft:diamond_axe') }],
    ['добить', async () => { await cmd('/damage NeuroBuild 12 minecraft:generic') }]
  ]) {
    if (only && label !== only) continue
    await field(13)
    // Длинная полоса позади мишени — убегать есть куда.
    await cmd(`/fill ${X - 4} ${Y - 1} ${Z + 12} ${X + 4} ${Y - 1} ${Z + 30} minecraft:stone`)
    await cmd(`/fill ${X - 4} ${Y} ${Z + 12} ${X + 4} ${Y + 3} ${Z + 30} minecraft:air`)
    await cmd(`/fill ${X - 4} ${Y} ${Z + 31} ${X + 4} ${Y + 1} ${Z + 31} minecraft:barrier`)
    await reset('NeuroDown'); await reset('NeuroBuild')
    for (const it of kit) await cmd(`/give NeuroDown ${it}`)
    await dress('NeuroDown', IRON)
    await dress('NeuroBuild', label === 'топор' ? IRON : DIAMOND)
    await cmd(`/tp NeuroDown ${X + 0.5} ${Y} ${Z + 0.5} 0 0`)
    await cmd(`/tp NeuroBuild ${X + 0.5} ${Y} ${Z + 13.5} 0 0`)
    await heal('NeuroDown'); await heal('NeuroBuild')
    await sleep(900)
    await setup()
    const hw = hpWatch(D)
    const r = await fightA(label === 'убегает' ? 5 : 7)
    for (const k of ['back', 'forward', 'sprint']) D.setControlState(k, false)
    hw.stop()
    if (r.status !== 'done') console.log(`[tipped:${label}] ${r.status}: ${JSON.stringify(r.by || r.error || '').slice(0, 200)}`)
    console.log(`[tipped:${label}] урон по D (${label === 'топор' ? 'железо' : 'алмаз'}): ${hw.ev.map(x => x.dmg).join(', ') || 'нет'} | хп D ${Math.round(D.health * 10) / 10} | ${tricksOf(r, /стрела|выстрел/)}`)
  }
}

async function stageSpear () {
  // A: алмазное копьё и железный меч; D идёт на A. Укол, разгон, полоса 3.4–4.5.
  await field(0)
  await cmd(`/fill ${X - 4} ${Y - 1} ${Z - 3} ${X + 4} ${Y - 1} ${Z + 16} minecraft:stone`)
  await cmd(`/fill ${X - 5} ${Y} ${Z - 4} ${X + 5} ${Y + 1} ${Z - 4} minecraft:barrier`)
  await cmd(`/fill ${X - 5} ${Y} ${Z + 17} ${X + 5} ${Y + 1} ${Z + 17} minecraft:barrier`)
  await reset('NeuroDown'); await reset('NeuroBuild')
  await cmd('/give NeuroDown minecraft:diamond_spear')
  await cmd('/give NeuroDown minecraft:iron_sword')
  await dress('NeuroDown', IRON)
  await dress('NeuroBuild', IRON)
  await cmd(`/tp NeuroDown ${X + 0.5} ${Y} ${Z + 0.5} 0 0`)
  await cmd(`/tp NeuroBuild ${X + 0.5} ${Y} ${Z + 9.5} 180 0`)
  await heal('NeuroDown'); await heal('NeuroBuild')
  await sleep(1000)
  const hw = hpWatch(D)
  // D идёт на A шагом, как мечник на сближение.
  const walk = setInterval(() => { try { const a = D.players[AN] && D.players[AN].entity; if (a) { D.lookAt(a.position.offset(0, 1.6, 0), true); const dd = a.position.distanceTo(D.entity.position); D.setControlState('forward', dd > 2.5); D.setControlState('sprint', dd > 5) } } catch {} }, 100)
  const r = await fightA(10)
  clearInterval(walk)
  for (const k of ['forward', 'sprint']) D.setControlState(k, false)
  hw.stop()
  console.log(`[spear] урон по D (железо): ${hw.ev.map(x => x.dmg).join(', ') || 'нет'} | хп D ${Math.round(D.health * 10) / 10} | ${tricksOf(r, /коп|укол|разгон|меч/)}`)
}

;(async () => {
  const stages = (process.argv[2] || 'read').split(',')
  try {
    await A.ready
    await A.call('connect').catch(() => {})
    await A.call('temper', { enabled: false }).catch(() => {})
    D = await join(DN)
    W = await join(WN)
    // Мишень убита в прошлом прогоне — возродиться, иначе бой кончается сразу.
    await sleep(500)
    if ((D.health ?? 20) <= 0) { try { D.respawn() } catch {} await sleep(1200) }
    D.on('death', () => setTimeout(() => { try { D.respawn() } catch {} }, 300))
    for (const b of [D, W]) { try { edges.fixSelfKnockback(b) } catch {} }
    W.on('messagestr', (m) => chatLog.push(m))
    D.on('messagestr', (m) => chatLog.push(m))
    await cmd('/gamerule spawn_mobs false')
    await cmd('/gamerule send_command_feedback true')
    await cmd('/difficulty normal')
    await cmd('/time set day')
    await cmd(`/tp NeuroEnd ${X + 0.5} ${Y} ${Z + 0.5}`)
    await field(14)
    await sleep(800)
    for (const s of stages) {
      if (s === 'read') await stageRead()
      else if (s === 'xarrow') await stageShoot('xarrow', ['minecraft:crossbow[enchantments={quick_charge:3}]', 'minecraft:arrow 32', 'minecraft:iron_sword'])
      else if (s === 'xrocket') await stageShoot('xrocket', ['minecraft:crossbow[enchantments={quick_charge:3,multishot:1}]', `minecraft:${ROCKET} 16`, 'minecraft:iron_sword'])
      else if (s === 'xpierce') await stageShoot('xpierce', ['minecraft:crossbow[enchantments={quick_charge:3,piercing:4}]', 'minecraft:arrow 32', 'minecraft:iron_sword'], { shield: true })
      else if (s === 'xplain') await stageShoot('xplain-щит', ['minecraft:crossbow[enchantments={quick_charge:3}]', 'minecraft:arrow 32', 'minecraft:iron_sword'], { shield: true })
      else if (s === 'hisxbow') await stageHisXbow(false)
      else if (s === 'hisxbowp') await stageHisXbow(true)
      else if (s === 'totem') await stageTotem()
      else if (s === 'spear') await stageSpear()
      else if (s.startsWith('tipped')) await stageTipped(s.split(':')[1] || null)
      await A.call('stop').catch(() => {})
      await sleep(500)
    }
    // Итог уклонов от заряженного арбалета (2026-09-26).
    for (const p of [false, true]) {
      const t = XB_TRIALS.filter(x => x.piercing === p)
      if (t.length) console.log(`[hisxbow${p ? '+пронзание' : ''}] ИТОГ: ${t.length} выстрелов, попала ${t.filter(x => x.hurt).length}, мимо/щит ${t.filter(x => !x.hurt).length}`)
    }
  } catch (e) {
    console.error('FAILED', e.stack || e.message)
    process.exitCode = 1
  } finally {
    try { D && D.quit() } catch {}
    try { W && W.quit() } catch {}
    A.ws.close()
    setTimeout(() => process.exit(), 500)
  }
})()
