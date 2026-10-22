'use strict'
// Бот-противник для самопроверки роя (пользователь 22.10: «такие слабые места ты мог бы сам проверять — подходи к ним,
// смотри, что он не зависает, не стоит на месте»). Заходит на стенд человеком — драйвер ставит его к красным (ARMS_SOLO), —
// бессмертный (Сопротивление V) и по кругу делает то, чем пользователь убивал рой: рывок со Скоростью и меч, подкоп в
// креативе, цепочку динамита за убегающим, булаву сверху, лук издали, паутину на бота. Всё время считает стояние: бот ближе
// 7 бл. ко мне секунду и дольше не двигается, не бьёт, не держит щит и не ест — «стоит» (время — для лога драйвера).
// Итог сценария — строка «📋 {json}», общий — «📊 {json}».
//   node dist/farm/arena/adversary.js <слот> [rush,undermine,tnt,mace,bow,web,idle,pit,tntlate,moat,room] [минут] [имя]
import * as path from 'path'
import { REPO_ROOT } from '../../daemon/src/paths'
import { rcon } from './server'

const slot = Number(process.argv[2] || 31)
const plan = (process.argv[3] || 'rush,undermine,tnt,mace,bow,web').split(',').filter(Boolean)
const minutes = Number(process.argv[4] || 10)
const NAME = process.argv[5] || 'Tester'
const mod = (n: string) => require(path.join(REPO_ROOT, 'daemon', 'node_modules', n))
const mf = mod('mineflayer')
const { pathfinder, Movements, goals } = mod('mineflayer-pathfinder')
const { Vec3 } = mod('vec3')
const cmd = (c: string): Promise<string> => rcon(slot, c).then(String).catch((e: any) => 'ошибка: ' + e.message)
const stamp = () => new Date().toTimeString().slice(0, 8)
const say = (...a: any[]) => console.log(`[${stamp()}]`, ...a)
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms))
// Точное хп — только для замера (телеметрия стенда), не для решений.
const hpOf = async (n: string) => { const m = /([\d.]+)f/.exec(await cmd(`data get entity ${n} Health`)); return m ? +m[1] : null }

const bot = mf.createBot({ host: '127.0.0.1', port: 25600 + slot, username: NAME, version: '1.21.11', auth: 'offline' })
bot.loadPlugin(pathfinder)
bot.on('kicked', (r: any) => { say('выкинут', JSON.stringify(r)); process.exit(1) })
bot.on('error', (e: any) => say('ошибка', e.message))

const dist = (e: any) => e.position.distanceTo(bot.entity.position)
const foes = () => (Object.values(bot.entities) as any[]).filter(e => e?.type === 'player' && /^NeuroFarm/.test(e.username || '') && e.position &&
  bot.players[e.username]?.gamemode !== 3)
const nearest = (ok: (e: any) => boolean = () => true) => foes().filter(ok).sort((a, b) => dist(a) - dist(b))[0]
const eye = () => bot.entity.position.offset(0, 1.62, 0)
const sees = (e: any) => {
  const to = e.position.offset(0, 1.2, 0), d = to.minus(eye()), n = d.norm()
  const hit = bot.world.raycast(eye(), d.scaled(1 / n), n)
  return !hit
}
const openSky = (e: any, h: number) => { for (let y = 2; y <= h; y++) { const b = bot.blockAt(e.position.offset(0, y, 0)); if (!b || b.boundingBox !== 'empty') return false } return true }

// Стояние рядом со мной: позиция по тикам, взмахи, рука занята (щит, еда, лук — флаг живой сущности).
let LF = 8
const handActive = (e: any) => (Number(e.metadata?.[LF]) & 1) === 1
const watch = new Map<string, any>()
const freezes: any[] = []
let scene = 'старт'
let tick = 0
const hurt = new Map<string, number>()
const dead = new Map<string, number>()
const swings = new Map<string, number>()
bot.on('entitySwingArm', (e: any) => { const w = watch.get(e.username); if (w) w.swing = tick; if (e.username) swings.set(e.username, (swings.get(e.username) || 0) + 1) })
bot.on('entityHurt', (e: any) => { if (e.username) hurt.set(e.username, (hurt.get(e.username) || 0) + 1) })
bot.on('entityDead', (e: any) => { if (e.username) dead.set(e.username, tick) })
bot.on('physicsTick', () => {
  tick++
  if (!bot.entity) return
  for (const e of foes()) {
    let w = watch.get(e.username)
    if (!w) { w = { p: e.position.clone(), v: new Vec3(0, 0, 0), still: 0, swing: -99 }; watch.set(e.username, w) }
    const dv = e.position.minus(w.p)
    w.v = w.v.scaled(0.5).plus(dv.scaled(0.5)); w.p = e.position.clone()
    const d = dist(e)
    if (d <= 16) w.nearAt = tick
    const moved = Math.hypot(dv.x, dv.z) > 0.03 || Math.abs(dv.y) > 0.08
    if (d <= 7 && !moved && tick - w.swing >= 12 && !handActive(e)) { if (!w.still) w.from = stamp(); w.still++; w.d = d }
    else {
      if (w.still >= 20) { freezes.push({ who: e.username, s: +(w.still / 20).toFixed(1), d: +w.d.toFixed(1), from: w.from, scene }); say(`🧊 ${e.username} стоял ${(w.still / 20).toFixed(1)} с в ${w.d.toFixed(1)} бл. от меня (с ${w.from}, ${scene})`) }
      w.still = 0
    }
  }
})

async function setMode (m: string) {
  // Полёт креатива у mineflayer — тяжесть 0 в его физике: без stopFlying в выживании бот висел над целью (булава не падала).
  if (m !== 'creative') { try { bot.creative.stopFlying() } catch {} }
  await cmd(`gamemode ${m} ${NAME}`)
  for (let k = 0; k < 20 && bot.game.gameMode !== m; k++) await sleep(100)
}
async function immortal () {
  for (const c of [`effect give ${NAME} minecraft:resistance infinite 4 true`, `effect give ${NAME} minecraft:regeneration infinite 4 true`,
    `effect give ${NAME} minecraft:saturation infinite 0 true`, `effect give ${NAME} minecraft:speed infinite 1 true`]) await cmd(c)
}
async function hold (name: string, give = `minecraft:${name}`) {
  let it = bot.inventory.items().find((i: any) => i.name === name)
  if (!it) { await cmd(`give ${NAME} ${give} 1`); await sleep(400); it = bot.inventory.items().find((i: any) => i.name === name) }
  if (it) await bot.equip(it, 'hand').catch(() => {})
  return !!it
}
const stop = () => { try { bot.pathfinder.setGoal(null) } catch {} bot.clearControlStates() }

// Рывок со Скоростью и меч: с какого расстояния заметил (бежит прочь, идёт на меня или бьёт), сколько ударов принял,
// отвечал ли.
async function rush () {
  await setMode('survival'); await immortal(); await hold('netherite_sword')
  const t = nearest(e => dist(e) > 14 && dist(e) < 60) || nearest()
  if (!t) return { skip: 'нет целей' }
  const name = t.username, hp0 = await hpOf(name), from = +dist(t).toFixed(1), h0 = hurt.get(name) || 0, swing0 = watch.get(name)?.swing ?? -99
  bot.pathfinder.setGoal(new goals.GoalFollow(t, 1.5), true)
  let notice: any = null, swings = 0, lastHit = 0
  const t0 = Date.now()
  while (Date.now() - t0 < 25000 && bot.entities[t.id] && !dead.has(name)) {
    await sleep(50)
    const w = watch.get(name), d = dist(t)
    if (!notice && w) {
      const to = t.position.minus(bot.entity.position); const radial = (w.v.x * to.x + w.v.z * to.z) / (Math.hypot(to.x, to.z) || 1)
      if (w.swing > swing0) notice = { d: +d.toFixed(1), how: 'бьёт' }
      else if (Math.abs(radial) > 0.12) notice = { d: +d.toFixed(1), how: radial > 0 ? 'бежит прочь' : 'идёт на меня' }
    }
    if (d < 3.2 && Date.now() - lastHit > 650) { await bot.lookAt(t.position.offset(0, 1.4, 0), true); bot.attack(t); lastHit = Date.now(); swings++ }
    if (swings >= 16) break
  }
  stop()
  const back = (watch.get(name)?.swing ?? -99) > swing0
  return { name, from, notice, swings, hits: (hurt.get(name) || 0) - h0, back, hpDrop: hp0 != null ? +(hp0 - ((await hpOf(name)) ?? 0)).toFixed(1) : null, died: dead.has(name) }
}

// Подкоп в креативе (как пользователь 22.10): 8 с держусь в 3 бл. от цели и ломаю опору под её рамкой (до 2 вниз), куда бы
// она ни шла. Замер: сколько блоков сломал, сколько раз она провалилась (ноги ниже на 1.2+ бл. от высоты до подкопа).
async function undermine () {
  await setMode('creative'); await immortal()
  const t = nearest(e => dist(e) < 48 && bot.blockAt(e.position.offset(0, -0.5, 0))?.boundingBox === 'block' && Math.hypot(watch.get(e.username)?.v.x || 0, watch.get(e.username)?.v.z || 0) < 0.1) ||
    nearest(e => dist(e) < 48 && bot.blockAt(e.position.offset(0, -0.5, 0))?.boundingBox === 'block')
  if (!t) return { skip: 'нет целей на полу' }
  const name = t.username
  await cmd(`execute at ${name} run tp ${NAME} ~3 ~0.5 ~`); await sleep(400)
  try { bot.creative.startFlying() } catch {}
  const t0 = Date.now()
  let broke = 0, falls = 0, floorY = t.position.y, walked = 0, last = t.position.clone(), digErr = ''
  while (Date.now() - t0 < 8000 && bot.entities[t.id] && !dead.has(name)) {
    const cells = new Map<string, any>()
    for (const [dx, dz] of [[-.3, -.3], [-.3, .3], [.3, -.3], [.3, .3]]) for (const dy of [1, 2]) {
      const c = t.position.offset(dx, -dy + 0.01, dz).floored(); cells.set(c.toString(), c)
    }
    for (const c of cells.values()) {
      const b = bot.blockAt(c)
      if (b && b.boundingBox === 'block' && eye().distanceTo(c.offset(.5, .5, .5)) < 4.8) { try { await bot.dig(b, true); broke++ } catch (e: any) { digErr ||= e.message } }
    }
    await sleep(100)
    walked += Math.hypot(t.position.x - last.x, t.position.z - last.z); last = t.position.clone()
    if (t.position.y < floorY - 1.2) { falls++; floorY = t.position.y } else if (bot.blockAt(t.position.offset(0, -0.5, 0))?.boundingBox === 'block') floorY = Math.max(floorY, t.position.y)
    // Ушёл — догнать: стою в 3 бл. от него (креатив, полёт).
    if (dist(t) > 4.2) { await cmd(`execute at ${name} run tp ${NAME} ~3 ~0.5 ~`); await sleep(150) }
  }
  return { name, broke, falls, walked: +walked.toFixed(1), ...(digErr ? { digErr } : {}) }
}

// Цепочка динамита за убегающим: держусь в 4 бл. за ним, кладу динамит на его след каждые 0.4 с, на втором — поджигаю
// первый. Замер: хп до и после, смерть, насколько свернул (угол хода до поджога и после).
async function tnt () {
  await setMode('creative'); await immortal()
  const t = nearest(e => dist(e) < 48)
  if (!t) return { skip: 'нет целей' }
  const name = t.username, hp0 = await hpOf(name)
  const trail: any[] = []; const laid: any[] = []
  let dir0: any = null, turn = 0, lit = false
  for (let k = 0; k < 12 && bot.entities[t.id] && !dead.has(name); k++) {
    const c = t.position.floored()
    trail.push(c)
    const w = watch.get(name)
    if (lit && w && dir0) { const v = Math.hypot(w.v.x, w.v.z); if (v > 0.05) turn = Math.max(turn, Math.acos(Math.max(-1, Math.min(1, (w.v.x * dir0.x + w.v.z * dir0.z) / v))) * 180 / Math.PI) }
    const at = trail[trail.length - 2]
    if (at && !laid.some(l => l.equals(at))) { await cmd(`setblock ${at.x} ${at.y} ${at.z} minecraft:tnt keep`); laid.push(at) }
    if (laid.length === 2 && !lit) {
      const f = laid[0]
      if (w) { const v = Math.hypot(w.v.x, w.v.z) || 1; dir0 = { x: w.v.x / v, z: w.v.z / v } }
      await cmd(`setblock ${f.x} ${f.y} ${f.z} minecraft:air`); await cmd(`summon minecraft:tnt ${f.x + .5} ${f.y} ${f.z + .5} {fuse:20}`); lit = true
    }
    await cmd(`execute at ${name} facing entity ${NAME} feet run tp ${NAME} ^ ^1 ^4`)
    await sleep(400)
  }
  await sleep(2500)
  const hp1 = await hpOf(name)
  return { name, laid: laid.length, turnDeg: Math.round(turn), hpDrop: hp0 != null && hp1 != null ? +(hp0 - hp1).toFixed(1) : null, died: dead.has(name) }
}

// Булава сверху: подлёт — телепорт на 14 бл. над целью (как взлёт на заряде ветра), падение с рулём на него, удар у земли.
// Замер: поднят ли щит в миг удара, урон, смерть.
async function mace () {
  await setMode('survival'); await immortal()
  const still = (e: any) => Math.hypot(watch.get(e.username)?.v.x || 0, watch.get(e.username)?.v.z || 0) < 0.15
  const t = nearest(e => dist(e) < 40 && openSky(e, 14) && still(e)) || nearest(e => dist(e) < 40 && openSky(e, 14))
  if (!t) return { skip: 'нет целей под открытым небом' }
  await hold('mace')
  const name = t.username, hp0 = await hpOf(name)
  await cmd(`execute at ${name} run tp ${NAME} ~1 ~12 ~1`); await sleep(250)
  const t0 = Date.now()
  let hit = false, shield: boolean | null = null, d = 99, fled = 0
  const p0 = t.position.clone()
  while (Date.now() - t0 < 4000 && bot.entities[t.id]) {
    await bot.lookAt(t.position.offset(0, 1, 0), true)
    const h = Math.hypot(t.position.x - bot.entity.position.x, t.position.z - bot.entity.position.z)
    bot.setControlState('forward', h > 0.8); bot.setControlState('sprint', h > 2)
    d = bot.entity.position.distanceTo(t.position.offset(0, 1, 0))
    fled = Math.hypot(t.position.x - p0.x, t.position.z - p0.z)
    if (d < 3 && bot.entity.velocity.y < -0.3) { shield = handActive(t); bot.attack(t); hit = true; break }
    if (bot.entity.onGround && Date.now() - t0 > 400) break
    await sleep(50)
  }
  stop(); await sleep(400)
  const hp1 = await hpOf(name)
  return { name, hit, shield, fled: +fled.toFixed(1), hpDrop: hp0 != null && hp1 != null ? +(hp0 - hp1).toFixed(1) : null, died: dead.has(name) }
}

// Лук издали: 12 с стреляю в одну цель на 10–32 бл. по прямой видимости. Замер: попадания, ушёл ли из видимости,
// поднял ли щит, пошёл ли на меня.
async function bow () {
  await setMode('survival'); await immortal()
  const t = nearest(e => dist(e) > 10 && dist(e) < 32 && sees(e))
  if (!t) return { skip: 'нет целей в видимости' }
  if (!await hold('bow', 'minecraft:bow[enchantments={power:5,infinity:1}]')) return { skip: 'нет лука' }
  if (!bot.inventory.items().some((i: any) => i.name === 'arrow')) await cmd(`give ${NAME} minecraft:arrow 1`)
  const name = t.username, h0 = hurt.get(name) || 0, t0 = Date.now()
  let shots = 0, hidAt: number | null = null, shieldSeen = false, closest = dist(t)
  while (Date.now() - t0 < 12000 && bot.entities[t.id] && !dead.has(name)) {
    bot.activateItem()
    for (let k = 0; k < 22; k++) {
      await sleep(50)
      const d = dist(t); closest = Math.min(closest, d)
      shieldSeen ||= handActive(t)
      // Падение стрелы (скорость 3 б/т, тяжесть 0.05 б/т²): поднять прицел на полёт.
      const fly = d / 2.8
      await bot.lookAt(t.position.offset(0, 1.1 + 0.025 * fly * fly, 0), true)
    }
    if (!sees(t)) { bot.deactivateItem(); if (hidAt == null) hidAt = Date.now() - t0; await sleep(300); continue }
    bot.deactivateItem(); shots++
    await sleep(150)
  }
  return { name, shots, hits: (hurt.get(name) || 0) - h0, hidMs: hidAt, shield: shieldSeen, closest: +closest.toFixed(1), died: dead.has(name) }
}

// Паутина на бота рядом со мной: сколько тиков он из неё выходит.
async function web () {
  await setMode('survival'); await immortal(); await hold('netherite_sword')
  const t = nearest(e => dist(e) < 24)
  if (!t) return { skip: 'никого рядом' }
  const name = t.username, c = t.position.floored()
  await cmd(`setblock ${c.x} ${c.y} ${c.z} minecraft:cobweb keep`); await cmd(`setblock ${c.x} ${c.y + 1} ${c.z} minecraft:cobweb keep`)
  const t0 = Date.now(); let outMs: number | null = null
  while (Date.now() - t0 < 10000 && bot.entities[t.id] && !dead.has(name)) {
    await sleep(50)
    if (!t.position.floored().equals(c) && !t.position.floored().equals(c.offset(0, 1, 0))) { outMs = Date.now() - t0; break }
  }
  return { name, outMs, broke: bot.blockAt(c)?.name !== 'cobweb', died: dead.has(name) }
}

// Стою среди них, не бью (человек осматривается, ест, перекладывает вещи): 10 с у ближайшего бота. Замер: сколько ударов
// получил я, сколько ботов в 6 бл. за это время ни разу не махнули.
async function idle () {
  await setMode('survival'); await immortal(); await hold('netherite_sword')
  const t = nearest(e => dist(e) < 40)
  if (!t) return { skip: 'никого рядом' }
  // Встать на пол рядом, а не в стену или яму: телепорт «~2 ~ ~2» ставил меня в колонну или на 2 бл. ниже, и боты честно не
  // доставали (стояния, которых в игре нет).
  const free = (c: any) => { const f = bot.blockAt(c), h = bot.blockAt(c.offset(0, 1, 0)), g = bot.blockAt(c.offset(0, -1, 0))
    return f?.boundingBox === 'empty' && h?.boundingBox === 'empty' && g?.boundingBox === 'block' && !/lava|fire|cobweb/.test(f.name + g.name) }
  const spot = [[2, 2], [-2, 2], [2, -2], [-2, -2], [3, 0], [-3, 0], [0, 3], [0, -3]].map(([dx, dz]) => t.position.offset(dx, 0, dz).floored()).find(free)
  await cmd(spot ? `tp ${NAME} ${spot.x + .5} ${spot.y} ${spot.z + .5}` : `execute at ${t.username} run tp ${NAME} ~2 ~ ~2`); await sleep(300)
  const me0 = hurt.get(NAME) || 0, t0 = Date.now(), seen = new Map<string, number>()
  while (Date.now() - t0 < 10000) {
    await sleep(100)
    for (const e of foes()) if (dist(e) < 6 && !seen.has(e.username)) seen.set(e.username, watch.get(e.username)?.swing ?? -99)
  }
  const idlers = [...seen].filter(([n, s]) => (watch.get(n)?.swing ?? -99) <= s).map(([n]) => n)
  return { near: seen.size, hitMe: (hurt.get(NAME) || 0) - me0, idlers: idlers.length, who: idlers.slice(0, 6).join(',') }
}

// Я в яме на 2 бл. ниже, в 2 бл. от бота (пользователь: стояли у края, цель ниже — держали копьё или махали мимо). 10 с жду.
// Замер: сколько раз меня ударили, кто стоял. Яму потом засыпаю тем, что было.
async function pit () {
  await setMode('survival'); await immortal(); await hold('netherite_sword')
  const solid = (c: any) => bot.blockAt(c)?.boundingBox === 'block' && !/lava|water/.test(bot.blockAt(c)?.name || '')
  const air = (c: any) => bot.blockAt(c)?.boundingBox === 'empty'
  const spot = (e: any) => [[2, 0], [-2, 0], [0, 2], [0, -2]].map(([dx, dz]) => e.position.floored().offset(dx, 0, dz)).find(c => air(c) && air(c.offset(0, 1, 0)) && solid(c.offset(0, -1, 0)) && solid(c.offset(0, -2, 0)) && solid(c.offset(0, -3, 0)))
  const t = foes().filter(e => dist(e) < 60 && bot.blockAt(e.position.offset(0, -0.5, 0))?.boundingBox === 'block' && spot(e)).sort((a, b) => dist(a) - dist(b))[0]
  if (!t) return { skip: 'нет места для ямы' }
  const cell = spot(t)
  const was = [1, 2].map(k => bot.blockAt(cell.offset(0, -k, 0))?.name || 'stone')
  for (const k of [1, 2]) await cmd(`setblock ${cell.x} ${cell.y - k} ${cell.z} minecraft:air`)
  await cmd(`tp ${NAME} ${cell.x + .5} ${cell.y - 2} ${cell.z + .5}`); await sleep(300)
  if (bot.entity.position.y > cell.y - 1.5) say(`яма не вышла: я на ${bot.entity.position.y.toFixed(1)}, край ${cell.y}`)
  const me0 = hurt.get(NAME) || 0, t0 = Date.now(), f0 = freezes.length, sw0 = swings.get(t.username) || 0
  say(`🕳 я в яме у ${t.username}`)
  while (Date.now() - t0 < 10000) await sleep(100)
  const swung = (swings.get(t.username) || 0) - sw0
  await cmd(`tp ${NAME} ${cell.x + .5} ${cell.y} ${cell.z + .5}`); await sleep(200)
  for (const k of [2, 1]) await cmd(`setblock ${cell.x} ${cell.y - k} ${cell.z} minecraft:${was[k - 1]}`)
  return { name: t.username, hitMe: (hurt.get(NAME) || 0) - me0, swung, stands: freezes.slice(f0).filter(f => f.who === t.username).reduce((a, f) => a + f.s, 0) }
}

// Поздний динамит: бот со щитом, горящий заряд у ног с фитилём 12 т (0.6 с — за 8 бл. не убежать). Щит гасит взрыв, если
// поднят к нему. Замер: урон, смерть, был ли щит поднят в миг взрыва.
async function tntlate () {
  await setMode('creative'); await immortal()
  const t = nearest(e => dist(e) < 40)
  if (!t) return { skip: 'нет целей' }
  const name = t.username
  await cmd(`item replace entity ${name} weapon.offhand with minecraft:shield`); await sleep(500)
  await cmd(`execute at ${name} facing entity ${name} feet run tp ${NAME} ^ ^3 ^-9`); await sleep(200)
  const hp0 = await hpOf(name), p = t.position
  await cmd(`summon minecraft:tnt ${p.x.toFixed(2)} ${p.y.toFixed(2)} ${p.z.toFixed(2)} {fuse:12}`)
  let shield: boolean | null = null
  for (let k = 0; k < 30; k++) { await sleep(50); if (k === 10) shield = handActive(t) }
  await sleep(1500)
  const hp1 = await hpOf(name)
  return { name, shield, hpDrop: hp0 != null && hp1 != null ? +(hp0 - hp1).toFixed(1) : null, died: dead.has(name) }
}

// Остров во рву: я на 3×3 посреди кольца воды 4 бл. шириной и 2 глубиной на поле Колизея (пользователь: «плывут по воде
// вместо прыжков по блокам»). Боты видят меня и идут сами. Пол сохраняю clone под потолок мира и возвращаю. Замер — 15 с
// с подхода первого бота на 10 бл.: кто первым дошёл до острова (ближе 2.5 бл. по горизонтали, на моей высоте) и через
// сколько после подхода, тиков ботов в воде, клеток рва, заложенных блоками, ударов по мне.
async function moat () {
  await setMode('survival'); await immortal(); await hold('netherite_sword')
  const [X, Y, Z] = (process.env.ARMS_POS || '600 120 600').split(/\s+/).map(Number)
  // Блоки на мост у ботов рядом (обычно они есть — проверяем «есть блоки → мост, а не вплавь»).
  if (process.env.ADV_MOAT_BLOCKS !== '0') for (const e of foes().filter(e => dist(e) < 40)) await cmd(`give ${e.username} minecraft:cobblestone 32`)
  // Центр поля: столбы, ямы и мосты ботов за раунд — площадку 13×13 расчищаю сам (объём с полом — в копию под потолок мира).
  const c = new Vec3(X, Y, Z), lo = c.offset(-6, -3, -6), hi = c.offset(6, 3, 6)
  await cmd(`clone ${lo.x} ${lo.y} ${lo.z} ${hi.x} ${hi.y} ${hi.z} ${lo.x} 300 ${lo.z}`)
  await cmd(`fill ${c.x - 6} ${c.y} ${c.z - 6} ${c.x + 6} ${c.y + 3} ${c.z + 6} minecraft:air`)
  await cmd(`fill ${lo.x} ${lo.y} ${lo.z} ${hi.x} ${c.y - 1} ${hi.z} minecraft:stone`)
  await cmd(`fill ${c.x - 5} ${c.y - 2} ${c.z - 5} ${c.x + 5} ${c.y - 1} ${c.z + 5} minecraft:water`)
  await cmd(`fill ${c.x - 1} ${c.y - 2} ${c.z - 1} ${c.x + 1} ${c.y - 1} ${c.z + 1} minecraft:stone`)
  await cmd(`tp ${NAME} ${c.x + .5} ${c.y} ${c.z + .5}`); await sleep(300)
  const ring = (x: number, z: number) => Math.max(Math.abs(x - c.x), Math.abs(z - c.z)) >= 2
  const t0 = Date.now(), me0 = hurt.get(NAME) || 0, wet = new Map<string, number>()
  // Кто стоял на площадке, когда я её строил, — не в счёт «дошёл первым».
  const inside = new Set(foes().filter(e => Math.max(Math.abs(e.position.x - c.x - .5), Math.abs(e.position.z - c.z - .5)) < 7).map(e => e.username))
  let first: any = null, near: number | null = null
  // Рой в начале раунда лутает галереи — замер идёт с подхода первого бота на 10 бл. (15 с), не дольше 45 с всего.
  while (Date.now() - t0 < 45000 && !(near != null && Date.now() - near > 15000)) {
    await sleep(50)
    for (const e of foes()) {
      if (dist(e) > 24) continue
      if (near == null && !inside.has(e.username) && dist(e) < 10) near = Date.now()
      if (/water/.test(bot.blockAt(e.position.floored())?.name || '')) wet.set(e.username, (wet.get(e.username) || 0) + 1)
      if (!first && !inside.has(e.username) && Math.hypot(e.position.x - c.x - .5, e.position.z - c.z - .5) < 2.5 && Math.abs(e.position.y - c.y) < 1.5) first = { who: e.username, ms: Date.now() - t0, wet: wet.get(e.username) || 0 }
    }
  }
  let placed = 0
  for (let x = c.x - 5; x <= c.x + 5; x++) for (let z = c.z - 5; z <= c.z + 5; z++) if (ring(x, z) && !/water|air/.test(bot.blockAt(new Vec3(x, c.y - 1, z))?.name || 'water')) placed++
  await cmd(`clone ${lo.x} 300 ${lo.z} ${hi.x} 306 ${hi.z} ${lo.x} ${lo.y} ${lo.z}`)
  await cmd(`fill ${lo.x} 300 ${lo.z} ${hi.x} 306 ${hi.z} minecraft:air`)
  const swimmers = [...wet].filter(([, n]) => n >= 10)
  return { at: `${c.x},${c.z}`, nearMs: near && near - t0, first: first && { ...first, ms: first.ms - (near ?? t0) + t0 }, swimmers: swimmers.length, wetTicks: [...wet.values()].reduce((a, n) => a + n, 0), placed, hitMe: (hurt.get(NAME) || 0) - me0 }
}

// Вбегаю в комнату (пользователь: «поздно замечают человека, забежавшего в комнату»): бот под крышей, я — в 5–8 бл. от него
// на виду. Замер за 8 с: когда повернулся ко мне (взгляд в 30°), когда двинулся (ко мне или прочь на 1.5 бл.), когда меня
// ударили; чем был занят — по логу драйвера в это время.
async function room () {
  await setMode('survival'); await immortal(); await hold('netherite_sword')
  const roofed = (e: any) => { for (let k = 2; k <= 6; k++) if (bot.blockAt(e.position.offset(0, k, 0))?.boundingBox === 'block') return true; return false }
  // Не тот, кто уже бьётся со мной: последние 10 с не был ближе 16 бл. ко мне.
  const fresh = (e: any) => tick - (watch.get(e.username)?.nearAt ?? -1e9) > 200
  const t = nearest(e => dist(e) < 80 && fresh(e) && roofed(e) && bot.blockAt(e.position.offset(0, -0.5, 0))?.boundingBox === 'block')
  if (!t) return { skip: 'никого свежего под крышей' }
  const name = t.username, base = t.position.floored()
  const free = (c: any) => bot.blockAt(c)?.boundingBox === 'empty' && bot.blockAt(c.offset(0, 1, 0))?.boundingBox === 'empty' &&
    bot.blockAt(c.offset(0, -1, 0))?.boundingBox === 'block' && !/lava|fire|cobweb|water/.test((bot.blockAt(c)?.name || '') + bot.blockAt(c.offset(0, -1, 0))?.name)
  const clear = (c: any) => { const o = c.offset(.5, 1.62, .5), to = t.position.offset(0, 1.2, 0), dv = to.minus(o), n = dv.norm(); return !bot.world.raycast(o, dv.scaled(1 / n), n) }
  let spot: any = null
  for (let r = 5; r <= 8 && !spot; r++) for (let k = 0; k < 16 && !spot; k++) {
    const a = k / 16 * Math.PI * 2
    for (const dy of [0, 1, -1]) { const c = base.offset(Math.round(Math.cos(a) * r), dy, Math.round(Math.sin(a) * r)); if (free(c) && clear(c)) { spot = c; break } }
  }
  if (!spot) return { skip: 'нет места на виду' }
  await cmd(`tp ${NAME} ${spot.x + .5} ${spot.y} ${spot.z + .5}`)
  // Отсчёт — когда клиент уже стоит на месте (ответ сервера о телепорте приходит не сразу).
  for (let k = 0; k < 40 && bot.entity.position.distanceTo(spot.offset(.5, 0, .5)) > 1; k++) await sleep(25)
  const t0 = Date.now(), p0 = t.position.clone(), d0 = dist(t), me0 = hurt.get(NAME) || 0
  let lookMs: number | null = null, moveMs: number | null = null, moved = 0, hitMs: number | null = null
  say(`🚪 вбежал к ${name} (${d0.toFixed(1)} бл.)`)
  while (Date.now() - t0 < 8000 && bot.entities[t.id] && !dead.has(name)) {
    await sleep(50)
    const ms = Date.now() - t0, to = bot.entity.position.minus(t.position), yaw = t.headYaw ?? t.yaw
    const cos = (-Math.sin(yaw) * to.x - Math.cos(yaw) * to.z) / (Math.hypot(to.x, to.z) || 1)
    if (lookMs == null && cos > Math.cos(Math.PI / 6)) lookMs = ms
    if (moveMs == null && t.position.distanceTo(p0) > 1.5) { moveMs = ms; moved = +(d0 - dist(t)).toFixed(1) }
    if (hitMs == null && (hurt.get(NAME) || 0) > me0) hitMs = ms
  }
  return { name, d0: +d0.toFixed(1), lookMs, moveMs, moved, hitMs }
}

const SCENES: Record<string, () => Promise<any>> = { rush, undermine, tnt, mace, bow, web, idle, pit, tntlate, moat, room }
const results: any[] = []
bot.once('spawn', async () => {
  // Креатив ломает сразу; расчёт времени mineflayer падал на зачарованиях предмета в руке («enchantments.concat»).
  const digTime = bot.digTime.bind(bot)
  bot.digTime = (b: any) => bot.game.gameMode === 'creative' ? 0 : digTime(b)
  LF = bot.registry.entitiesByName.player?.metadataKeys?.indexOf('living_entity_flags') ?? 8
  if (LF < 0) LF = 8
  bot.pathfinder.setMovements(new Movements(bot))
  say(`${NAME} на слоте ${slot}: жду команду и набор`)
  // Драйвер ставит человека в команду, когда боты зашли и раунд начался; набор — через пару секунд после.
  for (let k = 0; k < 120 && !/passed/i.test(await cmd(`execute if entity @a[name=${NAME},team=red]`)); k++) await sleep(3000)
  for (let k = 0; k < 60 && foes().length < 5; k++) await sleep(2000)
  await sleep(5000)
  say(`${NAME} в красных, ботов видно: ${foes().length}`)
  const end = Date.now() + minutes * 60000
  for (let k = 0; Date.now() < end; k++) {
    scene = plan[k % plan.length]
    const fn = SCENES[scene]
    if (!fn) { say(`нет сценария ${scene}`); continue }
    const f0 = freezes.length
    // Рой далеко (лутает по ярусам) — к ближайшему боту: сценариям нужны цели рядом.
    const near = nearest()
    if (scene !== 'rush' && near && dist(near) > 30) { await setMode('survival'); await cmd(`execute at ${near.username} run tp ${NAME} ~ ~1 ~`); await sleep(1500) }
    let r: any
    try { r = await fn() } catch (e: any) { r = { error: e.message } }
    stop()
    r = { scene, at: stamp(), ...r, freezes: freezes.length - f0 }
    results.push(r); say('📋', JSON.stringify(r))
    await sleep(3000)
  }
  const by: Record<string, any> = {}
  for (const r of results) { const s = by[r.scene] ||= { n: 0 }; s.n++; for (const [k, v] of Object.entries(r)) if (typeof v === 'number' && k !== 'n') s[k] = +((s[k] || 0) + v).toFixed(1); else if (typeof v === 'boolean') s[k] = (s[k] || 0) + (v ? 1 : 0) }
  say('📊', JSON.stringify({ scenes: by, freezes: freezes.length, longest: freezes.sort((a, b) => b.s - a.s).slice(0, 8) }))
  bot.quit(); setTimeout(() => process.exit(0), 500)
})
