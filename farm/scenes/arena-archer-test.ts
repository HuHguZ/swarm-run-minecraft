import { REPO_ROOT } from '../../daemon/src/paths'
// Проверка уворота ботов арены от лучника сверху (12.10: «целюсь из лука сверху — стоят и ждут, пока убью»).
// Скриптовый лучник заходит на сервер слота, встаёт на точку (по умолчанию — где стоял игрок на верху Колизея),
// SHOTS раз: берёт ближайшего синего бота в 6–40 бл., целится с упреждением, натягивает лук 1 с и стреляет.
// По каждому выстрелу — сдвиг цели за натяжку, попадание (хп по RCON до/после), итог: доля попаданий.
//   node dist/farm/scenes/arena-archer-test.js <слот> [x y z] [SHOTS=15]
import path = require('path')
import * as fs from 'fs'
import * as net from 'net'
const ROOT = REPO_ROOT
const mf = require(path.join(ROOT, 'daemon', 'node_modules', 'mineflayer'))
// Паузы — в игровом времени: на ускоренном сервере (tick rate > 20) натяжка 1 с — 20 тиков, как у человека на 20 TPS.
let speed = 1
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms / speed))

const slot = Number(process.argv[2] || 31)
const at = process.argv.length >= 6 ? process.argv.slice(3, 6).map(Number) : [591.5, 150, 544.5]
const SHOTS = Number(process.env.SHOTS || 15)
const props = fs.readFileSync(path.join(ROOT, 'farm', `server-${slot}`, 'server.properties'), 'utf8')
const prop = (k: string) => (new RegExp('^' + k + '=(.*)$', 'm').exec(props) || [])[1].trim()

function rcon (cmd: string): Promise<string> {
  return new Promise((resolve) => {
    const pkt = (id: number, t: number, b: string) => { const B = Buffer.from(b, 'utf8'); const x = Buffer.alloc(14 + B.length); x.writeInt32LE(10 + B.length, 0); x.writeInt32LE(id, 4); x.writeInt32LE(t, 8); B.copy(x, 12); return x }
    const s = net.connect(Number(prop('rcon.port')), '127.0.0.1', () => s.write(pkt(1, 3, prop('rcon.password'))))
    let acc = Buffer.alloc(0); let sent = false
    s.on('data', (d: Buffer) => {
      acc = Buffer.concat([acc, d])
      while (acc.length >= 4) {
        const len = acc.readInt32LE(0); if (acc.length < len + 4) break
        const id = acc.readInt32LE(4); const body = acc.slice(12, len + 2).toString(); acc = acc.slice(len + 4)
        if (id === 1 && !sent) { sent = true; s.write(pkt(2, 2, cmd)) } else if (id === 2) { s.end(); resolve(body) }
      }
    })
    s.on('error', () => resolve(''))
    setTimeout(() => { s.destroy(); resolve('') }, 4000)
  })
}
const hpOf = async (sel: string) => { const m = /([\d.]+)f/.exec(await rcon(`data get entity ${sel} Health`)); return m ? +m[1] : null }
// CAL=1 — калибровка самого лучника: неподвижный зомби (NoAI) на крыше в 8 бл. (CAL_AT="x y z"), а не боты.
const CAL = process.env.CAL === '1'
const CAL_MOB = process.env.CAL_MOB || 'zombie'
const CAL_AT = (process.env.CAL_AT || '599.5 151 544.5').split(' ').map(Number)
// TARGET=<бот> — стрелять только в него; TARGET_AT="x y z" — перед каждым выстрелом, если он ушёл дальше 12 бл. от точки,
// вернуть его туда (случай «залез ко мне на крышу — стоит, а я расстреливаю»).
// MODE: bow (умолч.) | potion — взрывное зелье вреда II (12.10: «стою сверху, кидаю зелья — не уворачиваются») |
// snowball. Бросок — как у игрока: в руке видно 0.5 с, прицел — дуга броска (Projectile.shootFromRotation: зелье −20° и
// 0.5 бл/т, снежок 0 и 1.5; гравитация 0.05/0.03, трение 0.99) в ноги цели там, где она сейчас.
// Попадание — по событию урона цели (entityHurt у лучника), не по хп: боты лечатся зельями между бросками.
const MODE = process.env.MODE || 'bow'
// MODE=mace — падение с булавой (12.10: «лечу на них булавой — смотрят, как я ваншотаю»): лучник ставится на 14 бл. над
// точкой в 1.5 бл. от цели, падает и бьёт, как только цель в 3.4 бл. (как человек: удар в последние тики падения).
// EAT=1 и TARGET_WS=<порт демона цели> — за миг до прыжка цель начинает есть (12.10: «когда хилятся — ноль реакций»).
const EAT = process.env.EAT === '1'
// Порт демона бойца: NeuroFarm<i> — 8800+i, доп. NeuroFarm<i><буква> — 8961+номер буквы (farm/arena/ffa.ts extra).
const wsPortOf = (n: string) => { const m = /^NeuroFarm(d+)([a-z]*)$/.exec(n); if (!m) return 0; return m[2] ? 8961 + 'cdefghijklmnopqrstuvwxyz'.indexOf(m[2]) : 8800 + Number(m[1]) }
function wsCall (port: number, method: string, params: any) {
  return new Promise(resolve => {
    const WebSocket = require(path.join(ROOT, 'daemon', 'node_modules', 'ws'))
    const ws = new WebSocket('ws://127.0.0.1:' + port)
    ws.on('open', () => ws.send(JSON.stringify({ id: 1, method, params })))
    ws.on('message', (m: any) => { if (String(m).includes('"id":1')) { ws.close(); resolve(null) } })
    ws.on('error', () => resolve(null))
    setTimeout(() => { try { ws.close() } catch {} resolve(null) }, 3000)
  })
}
// TARGET — один или несколько через запятую: убитый выбывает до конца раунда — берётся следующий живой.
const TARGETS = (process.env.TARGET || '').split(',').filter(Boolean)
let TARGET = TARGETS[0] || ''
const TARGET_AT = process.env.TARGET_AT ? process.env.TARGET_AT.split(' ').map(Number) : null

async function main () {
  const bot = mf.createBot({ host: '127.0.0.1', port: 25600 + slot, username: 'TestArcher', version: '1.21.11', auth: 'offline' })
  await new Promise(r => bot.once('spawn', r))
  const gt = async () => [Date.now(), +((/(\d+)/.exec(await rcon(`time query gametime`)) || [])[1] || 0)]
  const g0 = await gt(); await new Promise(r => setTimeout(r, 2000)); const g1 = await gt()
  speed = Math.max(0.5, (g1[1] - g0[1]) * 50 / (g1[0] - g0[0])); console.log(`темп сервера ×${speed.toFixed(2)}`)
  // Драйвер арены ставит нового человека в команду и на старт — дождаться и встать на точку.
  await sleep(8000)
  for (const c of ['gamemode survival TestArcher', `tp TestArcher ${at[0]} ${at[1]} ${at[2]}`, 'clear TestArcher', ...(MODE === 'mace' ? ['give TestArcher minecraft:mace 1'] : MODE === 'potion' ? ['give TestArcher minecraft:splash_potion[potion_contents={potion:"minecraft:strong_harming"}] 64'] : MODE === 'snowball' ? ['give TestArcher minecraft:snowball 64'] : ['give TestArcher minecraft:bow[enchantments={infinity:1,power:3}] 1', 'give TestArcher minecraft:arrow 1']), 'effect give TestArcher minecraft:resistance 300 4 true']) await rcon(c)
  if (CAL) { await rcon('kill @e[tag=ndcal]'); await rcon(`summon ${CAL_MOB} ${CAL_AT.join(' ')} {NoAI:1b,Tags:[ndcal],PersistenceRequired:1b,Health:20f}`) }
  await sleep(1500)
  const held = bot.inventory.items().find((i: any) => i.name === (MODE === 'mace' ? 'mace' : MODE === 'potion' ? 'splash_potion' : MODE === 'snowball' ? 'snowball' : 'bow'))
  if (held) await bot.equip(held, 'hand')
  const hurt = new Map<number, number>()
  bot.on('entityHurt', (e: any) => hurt.set(e.id, (hurt.get(e.id) || 0) + 1))
  // Дуга броска: питч, при котором снаряд ляжет ближе всего к точке (ноги цели).
  const throwPitch = (from: any, to: any) => {
    const [off, sp, g] = MODE === 'potion' ? [-20, 0.5, 0.05] : [0, 1.5, 0.03]
    const dx = to.x - from.x; const dz = to.z - from.z; const H = Math.hypot(dx, dz)
    let best = { pitch: 0, err: Infinity }
    for (let deg = -89; deg <= 89; deg += 1) {
      const a = (deg + off) * Math.PI / 180
      let vx = Math.cos(a) * sp; let vy = Math.sin(a) * sp; let x = 0; let y = 0
      for (let t = 0; t < 200; t++) { x += vx; y += vy; vx *= 0.99; vy = (vy - g) * 0.99; if (vy < 0 && y <= to.y + 0.9 - from.y) break }
      const err = Math.abs(x - H) + Math.max(0, (to.y + 0.9 - from.y) - y)
      if (err < best.err) best = { pitch: deg, err }
    }
    return best.pitch * Math.PI / 180
  }
  const rows: any[] = []
  for (let k = 0; k < SHOTS; k++) {
    await rcon(`tp TestArcher ${at[0]} ${at[1]} ${at[2]}`)
    if (TARGETS.length > 1) {
      TARGET = ''
      for (const n of TARGETS) if (/passed/.test(await rcon(`execute if entity @a[name=${n},gamemode=survival]`))) { TARGET = n; break }
      if (!TARGET) { console.log('все цели выбыли'); break }
    }
    if (TARGET && TARGET_AT) {
      // Каждый выстрел — с той же точки: бот, сбежавший с крыши (так и надо), для замера возвращается.
      await rcon(`tp ${TARGET} ${TARGET_AT.join(' ')}`); await sleep(800)
    }
    await sleep(300)
    // Драйвер соло-арены выдаёт «человеку» свой набор (кит) в фоне — в руке должно быть наше: нет — убрать кит и выдать снова.
    const want = MODE === 'mace' ? 'mace' : MODE === 'potion' ? 'splash_potion' : MODE === 'snowball' ? 'snowball' : 'bow'
    if (bot.heldItem?.name !== want) {
      let it = bot.inventory.items().find((i: any) => i.name === want)
      if (!it || bot.inventory.items().length > 3) {
        await rcon('clear TestArcher')
        for (const c of MODE === 'mace' ? ['give TestArcher minecraft:mace 1'] : MODE === 'potion' ? ['give TestArcher minecraft:splash_potion[potion_contents={potion:"minecraft:strong_harming"}] 64'] : MODE === 'snowball' ? ['give TestArcher minecraft:snowball 64'] : ['give TestArcher minecraft:bow[enchantments={infinity:1,power:3}] 1', 'give TestArcher minecraft:arrow 1']) await rcon(c)
        await sleep(500); it = bot.inventory.items().find((i: any) => i.name === want)
      }
      if (it) await bot.equip(it, 'hand').catch(() => {})
    }
    const me = bot.entity.position
    const foes = Object.values(bot.entities).filter((e: any) => (CAL ? e.name === CAL_MOB : TARGET ? e.username === TARGET : e.type === 'player' && /^NeuroFarm/.test(e.username)) && e.position && e.position.distanceTo(me) >= 6 && e.position.distanceTo(me) <= Number(process.env.MAXD || 40))
      .sort((a: any, b: any) => a.position.distanceTo(me) - b.position.distanceTo(me)) as any[]
    const t = foes[0]
    if (!t) { rows.push({ k, none: true }); await sleep(1500); continue }
    const sel = CAL ? '@e[tag=ndcal,limit=1]' : t.username
    if (!CAL) await rcon(`effect give ${t.username} minecraft:instant_health 1 3`)
    const p0 = t.position.clone(); const hp0 = await hpOf(sel); const h0 = hurt.get(t.id) || 0
    let p1 = p0
    if (MODE === 'mace') {
      if (EAT && wsPortOf(t.username)) { await rcon(`give ${t.username} minecraft:golden_apple 1`); await rcon(`effect give ${t.username} minecraft:hunger 1 255`); wsCall(wsPortOf(t.username), 'eat', { item: 'golden_apple' }); await sleep(300) }
      const a = Math.random() * 2 * Math.PI
      await rcon(`tp TestArcher ${(t.position.x + Math.cos(a) * 1.5).toFixed(2)} ${(t.position.y + 14).toFixed(2)} ${(t.position.z + Math.sin(a) * 1.5).toFixed(2)}`)
      let swung = false
      // Падение считает клиент лучника — в реальном времени (20 Гц), поэтому и ждём по стене; замер булавы — на 20 TPS.
      for (let i = 0; i < 60 && !swung; i++) {
        await new Promise(r => setTimeout(r, 50))
        const d = bot.entity.position.distanceTo(t.position.offset(0, 0.9, 0))
        await bot.lookAt(t.position.offset(0, 1, 0), true)
        if (d < 3.4 && bot.entity.velocity.y < -0.3) { bot.attack(t); swung = true }
        if (bot.entity.onGround) break
      }
      p1 = t.position.clone()
    } else if (MODE === 'bow') {
      bot.activateItem()
      for (let i = 0; i < 20; i++) { await bot.lookAt(t.position.offset(0, 1.2 + t.position.distanceTo(me) * 0.012, 0), true); await sleep(50) }
      p1 = t.position.clone()
      // Упреждение по ходу за последние 0.25 с не моделируем — как человек, бьём туда, где он сейчас.
      bot.deactivateItem()
    } else {
      // Зелье/снежок в руке видно 0.5 с (столько у человека — навестись), бросок — в ноги, где цель сейчас.
      for (let i = 0; i < 10; i++) { await bot.lookAt(t.position.offset(0, 1, 0), true); await sleep(50) }
      p1 = t.position.clone()
      const eye = bot.entity.position.offset(0, 1.62, 0)
      await bot.look(Math.atan2(-(t.position.x - eye.x), -(t.position.z - eye.z)), throwPitch(eye, t.position), true)
      bot.activateItem()
    }
    // Урон — минимум хп за 1.5 с после выстрела/броска (опрос раз в 2 тика): позже бот уже лечится.
    let hp1 = hp0
    for (let i = 0; i < 15; i++) { await sleep(100); const h = (await hpOf(sel)) ?? 0; if (hp1 == null || h < hp1) hp1 = h }
    if (CAL && hp1 != null && hp1 < 8) await rcon('data merge entity @e[tag=ndcal,limit=1] {Health:20f}')
    const moved = Math.hypot(p1.x - p0.x, p1.z - p0.z)
    rows.push({ at: new Date().toTimeString().slice(0, 8), k, target: t.username || t.name, d: +p0.distanceTo(me).toFixed(1), below: +(me.y - p0.y).toFixed(1), moved: +moved.toFixed(1), hit: (hurt.get(t.id) || 0) > h0, dmg: hp0 != null && hp1 != null ? +Math.max(0, hp0 - hp1).toFixed(1) : null, hp0, hp1 })
    console.log(JSON.stringify(rows[rows.length - 1]))
  }
  const shot = rows.filter(r => !r.none)
  const hits = shot.filter(r => r.hit).length
  const still = shot.filter(r => r.moved < 1).length
  const dmg = shot.reduce((a, r) => a + (r.dmg || 0), 0)
  console.log(`ИТОГ: урон за бросок/выстрел в среднем ${(dmg / Math.max(1, shot.length)).toFixed(1)} хп, с уроном ≥ 3 — ${shot.filter(r => r.dmg >= 3).length}`)
  console.log(`ИТОГ: выстрелов ${shot.length}, попаданий ${hits} (${Math.round(100 * hits / Math.max(1, shot.length))} %), цель стояла (сдвиг < 1 бл. за натяжку) ${still}`)
  bot.quit()
  await rcon('kill @e[type=arrow]'); await rcon('kill @e[type=area_effect_cloud]')
  if (CAL) await rcon('kill @e[tag=ndcal]')
}
main().catch(e => { console.error(e); process.exit(1) })
