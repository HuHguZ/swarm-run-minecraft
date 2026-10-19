import { REPO_ROOT, DIST_ROOT } from '../../daemon/src/paths'
// Стенд «красные против роя» (пользователь 14.10: «за красных тестовых игроков спавни, к ним двигай синих ботов и проверяй,
// что всё работает — я устал тестить»). Скриптовые красные заходят на сервер слота как люди (драйвер арены сам ставит их в
// команду), встают на точку сцены и держат её: бьют мечом всё синее в 3 бл., издали кидают трезубец (верность — вернётся).
// Сцены (точки — по модели Колизея, центр поля ARMS_POS):
//   roof   — крыша-терраса над рядами (dy 31; снизу только жемчугом, столбом, на элитрах);
//   crown  — венец стены (dy 34); seats — верх рядов (dy 24); gallery — галерея 2-го яруса (dy 8, узкий коридор);
//   field  — песок у края поля; gate — тоннель западных ворот;
//   ledge  — выступ в один блок у внутреннего края крыши (dy 31), под ним 7 бл. пустоты до рядов (пользователь 15.10: «на краю
//            стоит колизея — под ним блоки сломать, чтобы скинуть»).
//   rush   — сильный (незерит с защитой IV) в начале раунда врывается к спавну синих (восток, 14 бл. от него) и гонится за
//            ближним (пользователь 15.10: «слабые вступают в бой с сильным, который к ним на спавн подбегает, или лутаются
//            при нём и помирают»); замер — смерти синих от него, сундуки, открытые в 8 бл. от него, кто кинулся драться.
// Замер раз в 0.25 с: первый контакт (синий в 3.5 бл.), удары по красному (damage_event с источником), паузы (синий в
// 3.5 бл., а ударов нет дольше 2 с), окружение (сколько 60°-секторов вокруг заняты синими в 5 бл.), куча (наибольшее число
// синих в 1.5 бл. друг от друга), сброс с точки (сдвиг > 2.5 бл. или падение), трезубцы (бросков/попаданий). Из журнала
// арены за время прогона — счёт приёмов (⛏ прокоп, 🧱 стройка, 🪽 полёт, 🟣 жемчуг, 💨 ветер, 💣 ТНТ, 🏔 позиция).
//   node dist/farm/scenes/arena-redtest.js <слот> [сцена] [секунд]    env: REDS=1 (сколько красных), RES=3 (сопротивление, уровень-1),
//   ARENA_LOG=farm/results/duo-31/arenaN.out, TRIDENT=1, SPREAD=1 (красные в 6 бл. друг от друга по касательной),
//   BOX=<с> — через столько секунд красного замуровывает (каменная коробка с крышей, как человек-кемпер; пользователь 15.10:
//   «уничтожение кемпера с поиском»): бьёт и кидает только тех, кого видит; замер — когда вскрыли и когда первый удар.
import path = require('path')
import * as fs from 'fs'
import * as net from 'net'
const ROOT = REPO_ROOT
const mf = require(path.join(ROOT, 'daemon', 'node_modules', 'mineflayer'))
const C = require(path.join(DIST_ROOT, 'daemon', 'arena', 'colosseum'))
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms))

const slot = Number(process.argv[2] || 31)
const SCENE = process.argv[3] || 'roof'
const SECONDS = Number(process.argv[4] || 150)
const REDS = Number(process.env.REDS || 1)
const RES = process.env.RES ?? '3'
const TRIDENT = process.env.TRIDENT !== '0'
const BOX = Number(process.env.BOX || 0)
const [X, Y, Z] = (process.env.ARMS_POS || '600 120 600').split(/\s+/).map(Number)
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

// Точка сцены по модели (как раскладка colosseum-arms: эллипс A1×B1, n — от внутренней грани подиума).
function scenePoint (k: number) {
  const p = C.params({}); const deg = (d: number) => d * Math.PI / 180
  const at = (d: number, n: number, l = 0) => {
    const t = deg(d); const e = { x: p.A1 * Math.cos(t), z: p.B1 * Math.sin(t) }
    const nx0 = p.B1 * Math.cos(t); const nz0 = p.A1 * Math.sin(t); const nl = Math.hypot(nx0, nz0); const N = { x: nx0 / nl, z: nz0 / nl }
    return { x: Math.round(e.x + N.x * n - N.z * l), z: Math.round(e.z + N.z * n + N.x * l) }
  }
  const lat = process.env.SPREAD === '0' ? 0 : (k - (REDS - 1) / 2) * 6
  const pick: Record<string, any> = {
    roof: { ...at(100, 22.5, lat), y: 30.5 }, crown: { ...at(100, 26.5, lat), y: 33.5 }, seats: { ...at(100, 20.6, lat), y: 24 },
    gallery: { ...at(100, 23, lat), y: 8 }, ledge: { ...at(100, 21, lat), y: 31 }, field: { x: Math.round(lat), y: 0, z: 18 }, gate: { x: -(p.A1 + 3), y: 0, z: Math.round(lat / 3) }, rush: { x: 22, y: 0, z: Math.round(lat) }
  }
  const q = pick[SCENE]; if (!q) throw new Error('нет сцены ' + SCENE)
  return { x: X + q.x + 0.5, y: Y + q.y, z: Z + q.z + 0.5 }
}

type Red = { name: string, bot: any, home: any, hurts: number[], lastHurt: number, throws: number, tHits: number, displaced: number, died: boolean, swings: number, box?: any }

async function startRed (k: number): Promise<Red> {
  const name = `RedTest${k + 1}`
  const bot = mf.createBot({ host: '127.0.0.1', port: Number(prop('server-port')), username: name, version: '1.21.11', auth: 'offline' })
  await new Promise((r, j) => { bot.once('spawn', r); bot.once('error', j); bot.once('kicked', j) })
  const red: Red = { name, bot, home: scenePoint(k), hurts: [], lastHurt: 0, throws: 0, tHits: 0, displaced: 0, died: false, swings: 0 }
  bot.on('entityHurt', (e: any, src: any) => { if (e === bot.entity) { red.hurts.push(Date.now()); red.lastHurt = Date.now() } else if (src === bot.entity && /^NeuroFarm/.test(e.username || '') && e.position.distanceTo(bot.entity.position) > 4) red.tHits++ })
  bot.on('death', () => { red.died = true })
  return red
}

async function place (r: Red) {
  const h = r.home
  if (SCENE === 'ledge') await rcon(`setblock ${Math.floor(h.x)} ${h.y - 1} ${Math.floor(h.z)} minecraft:smooth_sandstone`)
  for (const c of [`gamemode survival ${r.name}`, `clear ${r.name}`, `tp ${r.name} ${h.x} ${h.y} ${h.z}`,
    `give ${r.name} minecraft:netherite_sword[enchantments={sharpness:5,knockback:1}] 1`,
    ...(TRIDENT ? [`give ${r.name} minecraft:trident[enchantments={loyalty:3,impaling:5,channeling:1}] 1`] : []),
    ...(SCENE === 'rush' ? ['helmet', 'chestplate', 'leggings', 'boots'].map((k, i) => `item replace entity ${r.name} armor.${['head', 'chest', 'legs', 'feet'][i]} with minecraft:netherite_${k}[enchantments={protection:4}] 1`) : []),
    `effect clear ${r.name}`, ...(RES !== '-1' ? [`effect give ${r.name} minecraft:resistance infinite ${RES} true`] : []),
    `effect give ${r.name} minecraft:saturation infinite 0 true`]) await rcon(c)
}

const blues = (bot: any) => Object.values(bot.entities).filter((e: any) => e.type === 'player' && /^NeuroFarm/.test(e.username || '') && e.position) as any[]
// Виден ли синий (луч от глаз до его груди без блоков): из коробки сквозь стену не бьют и не кидают.
function sees (bot: any, e: any) {
  const eye = bot.entity.position.offset(0, 1.62, 0); const to = e.position.offset(0, 1.2, 0); const d = to.minus(eye); const n = d.norm()
  try { return !bot.world.raycast(eye, d.scaled(1 / n), n, (b: any) => b && b.boundingBox === 'block') } catch { return true }
}
// Стены и крыша коробки вокруг клетки ног: сколько ещё стоит (по виду красного).
const boxCells = (c: any) => [...[[1, 0], [-1, 0], [0, 1], [0, -1]].flatMap(([dx, dz]) => [c.offset(dx, 0, dz), c.offset(dx, 1, dz)]), c.offset(0, 2, 0)]

// Дуга трезубца (ThrownTrident: 2.5 бл/т, гравитация 0.05, трение 0.99): питч, при котором ляжет ближе к груди цели.
function tridentPitch (from: any, to: any) {
  const dx = to.x - from.x; const dz = to.z - from.z; const H = Math.hypot(dx, dz); const dy = to.y + 1 - from.y
  let best = { pitch: 0, err: Infinity }
  for (let d = -60; d <= 60; d += 0.5) {
    const a = d * Math.PI / 180; let vx = Math.cos(a) * 2.5; let vy = Math.sin(a) * 2.5; let x = 0; let y = 0
    for (let t = 0; t < 60 && x < H; t++) { x += vx; y += vy; vx *= 0.99; vy = vy * 0.99 - 0.05 }
    const err = Math.abs(y - dy); if (err < best.err) best = { pitch: d, err }
  }
  return best.pitch * Math.PI / 180
}

async function brain (r: Red, until: number) {
  const bot = r.bot
  let swingAt = 0; let throwAt = Date.now() + 3000; let throwing = false
  while (Date.now() < until && !r.died) {
    await sleep(50)
    const me = bot.entity?.position; if (!me) continue
    const list = blues(bot).filter(e => !r.box || sees(bot, e)).map(e => ({ e, d: e.position.distanceTo(me) })).sort((a, b) => a.d - b.d)
    const near = list[0]
    if (throwing) continue
    // Ближний: меч, удар раз в 0.65 с (полная зарядка 0.625 с).
    if (near && near.d < 3.2) {
      const sw = bot.inventory.items().find((i: any) => i.name === 'netherite_sword')
      if (sw && bot.heldItem?.name !== 'netherite_sword') await bot.equip(sw, 'hand').catch(() => {})
      await bot.lookAt(near.e.position.offset(0, 1.4, 0), true).catch(() => {})
      if (Date.now() - swingAt > 650) { swingAt = Date.now(); bot.attack(near.e); r.swings++ }
      continue
    }
    // Сильный на спавне: бежит к ближнему синему в 30 бл. (спринт, прыжок у стенки) — как человек, что гонится.
    if (SCENE === 'rush') {
      const prey = list.find(x => x.d < 30)
      if (prey && prey.d >= 2.6) {
        await bot.lookAt(prey.e.position.offset(0, 1.4, 0), true).catch(() => {})
        bot.setControlState('forward', true); bot.setControlState('sprint', true); bot.setControlState('jump', !!bot.entity.isCollidedHorizontally)
      } else for (const k of ['forward', 'sprint', 'jump']) bot.setControlState(k, false)
      if (prey && prey.d < 12) continue
    }
    // Издали: трезубец в ближнего видимого синего в 6–22 бл., раз в 2.5 с (верность вернёт).
    const far = list.find(x => x.d >= 6 && x.d <= 22)
    const tr = bot.inventory.items().find((i: any) => i.name === 'trident')
    if (TRIDENT && far && tr && Date.now() > throwAt) {
      throwing = true; throwAt = Date.now() + 2500
      try {
        await bot.equip(tr, 'hand')
        bot.activateItem()
        // Замах 14 тиков (бросок — от 10), взгляд — в грудь цели с упреждением по её ходу и подъёмом на падение трезубца;
        // отпустить через 2 тика после последнего поворота: сервер берёт поворот, что уже дошёл (иначе — старый взгляд в пол).
        for (let i = 0; i < 14; i++) {
          await bot.waitForTicks(1)
          const t = far.e; const v = t.velocity || { x: 0, z: 0 }; const fl = t.position.distanceTo(bot.entity.position) / 2.5
          const eye = bot.entity.position.offset(0, 1.62, 0)
          const aim = { x: t.position.x + v.x * fl, y: t.position.y + 1.1, z: t.position.z + v.z * fl }
          await bot.look(Math.atan2(-(aim.x - eye.x), -(aim.z - eye.z)), tridentPitch(eye, { ...aim, y: aim.y - 1 }), true).catch(() => {})
        }
        await bot.waitForTicks(2)
        bot.deactivateItem(); r.throws++
      } catch {} finally { throwing = false }
    }
  }
}

async function main () {
  const logPath = process.env.ARENA_LOG ? path.resolve(ROOT, process.env.ARENA_LOG) : null
  const log0 = logPath && fs.existsSync(logPath) ? fs.statSync(logPath).size : 0
  const reds: Red[] = []
  for (let k = 0; k < REDS; k++) { reds.push(await startRed(k)); await sleep(400) }
  // Защита сразу при входе: пока драйвер ставит «человека» в комнату спавна, там бывают синие (прогон 15.10: убит до сцены).
  for (const r of reds) for (const c of [...(RES !== '-1' ? [`effect give ${r.name} minecraft:resistance infinite ${RES} true`] : []), `effect give ${r.name} minecraft:saturation infinite 0 true`]) await rcon(c)
  // Драйвер ставит нового «человека» в команду и в комнату спавна — дождаться его строки в журнале арены (иначе он
  // переставит красного в комнату уже после точки сцены), потом на точку сцены.
  for (let t = 0; t < 60; t++) {
    await sleep(1000)
    // log0 — байты: срез по байтам (по символам кириллица и эмодзи сдвигали начало — строку 🧍 пропускал, красного убивали в комнате).
    const fresh = logPath && fs.existsSync(logPath) ? fs.readFileSync(logPath).subarray(log0).toString('utf8') : ''
    if (reds.every(r => fresh.includes(`🧍 ${r.name} `)) || (!logPath && t >= 9)) break
  }
  await sleep(1000)
  for (const r of reds) await place(r)
  await sleep(1500)
  const t0 = Date.now(); const until = t0 + SECONDS * 1000
  console.log(`стенд: сцена ${SCENE}, красных ${REDS}, ${SECONDS} с; точки ${reds.map(r => `${r.name} ${r.home.x - X - 0.5},${r.home.y - Y},${r.home.z - Z - 0.5}`).join('; ')}`)
  for (const r of reds) brain(r, until)
  const box = { at: 0, opened: 0, firstHit: 0 }
  if (BOX) setTimeout(async () => {
    for (const r of reds) {
      const c = r.bot.entity.position.floored()
      await rcon(`fill ${c.x - 1} ${c.y - 1} ${c.z - 1} ${c.x + 1} ${c.y + 2} ${c.z + 1} minecraft:stone hollow`)
      await rcon(`tp ${r.name} ${c.x + 0.5} ${c.y} ${c.z + 0.5}`)
      r.home = { x: c.x + 0.5, y: c.y, z: c.z + 0.5 }; r.box = c
    }
    box.at = Date.now(); console.log(`[${((box.at - t0) / 1000).toFixed(0)} с] красные замурованы (камень, коробка 3×4×3)`)
  }, BOX * 1000)
  const m = { firstContact: null as number | null, samples: 0, contactSamples: 0, pauseMs: 0, pauses: 0, sectorsMax: 0, sectorsSum: 0, crowdMax: 0, crowdSum: 0, nearSum: 0, nearN: 0, sameLevel: new Set<string>(), knocked: 0, deaths: 0, minNear: Infinity }
  const pauseFrom = new Map<string, number>()
  const track: { t: string, name: string, x: number, y: number, z: number }[] = []
  const blueTrack = new Map<string, { x: number, y: number, z: number }>(), blueSeen = new Map<string, string>()
  let lastPrint = t0
  while (Date.now() < until && reds.some(r => !r.died)) {
    await sleep(250)
    m.samples++
    for (const r of reds) {
      if (r.box && !box.opened && boxCells(r.box).some((v: any) => r.bot.blockAt(v)?.boundingBox === 'empty')) { box.opened = Date.now(); console.log(`[${((box.opened - t0) / 1000).toFixed(0)} с] коробку вскрыли через ${((box.opened - box.at) / 1000).toFixed(0)} с`) }
      if (r.box && !box.firstHit && r.lastHurt > box.at) { box.firstHit = r.lastHurt; console.log(`[${((box.firstHit - t0) / 1000).toFixed(0)} с] первый удар по замурованному через ${((box.firstHit - box.at) / 1000).toFixed(0)} с`) }
      const me = r.bot.entity?.position; if (!me || r.died) continue
      track.push({ t: new Date().toTimeString().slice(0, 8), name: r.name, x: me.x, y: me.y, z: me.z })
      const bs = blues(r.bot)
      // Места синих раз в секунду (rush): кто сократил дистанцию перед сменой «лут → бегство» — он или лут.
      const now = new Date().toTimeString().slice(0, 8)
      if (SCENE === 'rush' && blueSeen.get('') !== now) { blueSeen.set('', now); for (const e of bs) blueTrack.set(`${e.username}@${now}`, { x: e.position.x, y: e.position.y, z: e.position.z }) }
      const close = bs.filter(e => e.position.distanceTo(me) < 3.5)
      const near = bs.map(e => e.position.distanceTo(me)).sort((a, b) => a - b)[0]
      if (near !== undefined) { m.nearSum += near; m.nearN++; m.minNear = Math.min(m.minNear, near) }
      for (const e of bs) if (Math.abs(e.position.y - me.y) < 1.6 && e.position.distanceTo(me) < 6) m.sameLevel.add(e.username)
      if (close.length) {
        m.contactSamples++
        if (m.firstContact === null) m.firstContact = (Date.now() - t0) / 1000
        // Пауза: синие рядом, а ударов нет 2+ с — копится, пока не ударят.
        const quiet = Date.now() - Math.max(r.lastHurt, pauseFrom.get(r.name) || 0)
        if (!pauseFrom.has(r.name)) pauseFrom.set(r.name, Date.now())
        if (quiet > 2000 && Date.now() - r.lastHurt > 2000) {
          m.pauseMs += 250
          // Начало паузы — кто рядом (имя, дистанция, высота): по времени и именам — их дела в журнале арены.
          if (quiet < 2250) { m.pauses++; console.log(`[${new Date().toTimeString().slice(0, 8)}] пауза у ${r.name}: ${close.map(e => `${e.username.replace(/^NeuroFarm/, '')} ${e.position.distanceTo(me).toFixed(1)} бл.${Math.abs(e.position.y - me.y) > 1 ? ` (${(e.position.y - me.y).toFixed(1)} по высоте)` : ''}`).join(', ')}`) }
        }
      } else pauseFrom.delete(r.name)
      // Окружение: занятые 60°-секторы синими в 5 бл.
      const sec = new Set(bs.filter(e => e.position.distanceTo(me) < 5).map(e => Math.floor(((Math.atan2(e.position.z - me.z, e.position.x - me.x) + Math.PI) / (Math.PI / 3))) % 6))
      m.sectorsMax = Math.max(m.sectorsMax, sec.size); m.sectorsSum += sec.size
      // Куча: наибольшее число синих в 1.5 бл. от одного синего (среди тех, что в 20 бл. от красного).
      const pool = bs.filter(e => e.position.distanceTo(me) < 20)
      const crowd = Math.max(0, ...pool.map(a => pool.filter(b => b !== a && b.position.distanceTo(a.position) < 1.5).length + 1))
      m.crowdMax = Math.max(m.crowdMax, crowd); m.crowdSum += crowd
      // Сбит с точки (обрыв, отбрасывание, взрыв): сдвиг > 2.5 бл. — засчитать и вернуть через 3 с.
      if (SCENE !== 'rush' && (Math.hypot(me.x - r.home.x, me.z - r.home.z) > 2.5 || me.y < r.home.y - 2)) {
        if (!r.displaced) { m.knocked++; console.log(`[${((Date.now() - t0) / 1000).toFixed(0)} с] ${r.name} сбит с точки: ${me.x.toFixed(1)} ${me.y.toFixed(1)} ${me.z.toFixed(1)}`) }
        r.displaced = r.displaced || Date.now()
        if (Date.now() - r.displaced > 3000) {
          // Выступ — блок под ним заново (сломанную опору иначе не вернуть, и каждый возврат — новое «падение»).
          if (SCENE === 'ledge') await rcon(`setblock ${Math.floor(r.home.x)} ${r.home.y - 1} ${Math.floor(r.home.z)} minecraft:smooth_sandstone`)
          await rcon(`tp ${r.name} ${r.home.x} ${r.home.y} ${r.home.z}`); r.displaced = 0
        }
      } else r.displaced = 0
    }
    if (Date.now() - lastPrint > 15000) {
      lastPrint = Date.now()
      const s = (Date.now() - t0) / 1000
      console.log(`[${s.toFixed(0)} с] ближний синий ${m.nearN ? (m.nearSum / m.nearN).toFixed(1) : '—'} бл. (мин ${m.minNear.toFixed(1)}), контакт ${(100 * m.contactSamples / Math.max(1, m.samples * reds.length)).toFixed(0)} %, ударов по красным ${reds.reduce((a, r) => a + r.hurts.length, 0)}, пауз ${m.pauses}, секторов макс ${m.sectorsMax}, куча макс ${m.crowdMax}, дошли на уровень ${m.sameLevel.size}, трезубцы ${reds.reduce((a, r) => a + r.tHits, 0)}/${reds.reduce((a, r) => a + r.throws, 0)}`)
    }
  }
  const dur = (Date.now() - t0) / 1000
  m.deaths = reds.filter(r => r.died).length
  // Приёмы роя из журнала арены за прогон.
  const tricks: Record<string, number> = {}
  // Спавн (rush): смерти синих (и от красных), сундуки, открытые синими в 8 бл. от красного (по его месту в ту же секунду),
  // задачи «бой» и «бегство» от красного.
  const rush = { blueDeaths: 0, byRed: 0, lootNearRed: 0, lootTotal: 0, fightTasks: 0, fleeTasks: 0, lootToFlee: 0, backToLoot: 0, closedByRed: 0, closedByBlue: 0, blueWalkedIn: 0, nearLoots: [] as string[] }
  const secOf = (s: string) => s.split(':').reduce((a, v) => a * 60 + +v, 0), start = new Date(t0).toTimeString().slice(0, 8)
  const kinds = new Map<string, { kind: string, t: string, fromLoot: boolean }>(), traces: string[] = []
  if (logPath && fs.existsSync(logPath)) {
    const fd = fs.openSync(logPath, 'r'); const st = fs.statSync(logPath); const buf = Buffer.alloc(Math.max(0, st.size - log0)); fs.readSync(fd, buf, 0, buf.length, log0); fs.closeSync(fd)
    for (const line of buf.toString('utf8').split('\n')) {
      if (SCENE === 'rush') {
        const t = /^\[(\d\d:\d\d:\d\d)\]/.exec(line)?.[1]
        if (/☠ NeuroFarm/.test(line)) { rush.blueDeaths++; if (/by RedTest/.test(line)) rush.byRed++ }
        if (/🐜 NeuroFarm\S+ \[[^\]]*\]: fight → RedTest/.test(line)) rush.fightTasks++
        if (/🐜 NeuroFarm\S+ \[[^\]]*\]: flee → RedTest/.test(line)) rush.fleeTasks++
        // «Лут → бегство» после первых 10 с: кто сократил дистанцию за время лута — красный (его ход) или синий (ход лута).
        const k = /🐜 (NeuroFarm\S+) \[[^\]]*\]: (\w+)/.exec(line)
        if (k && t && secOf(t) - secOf(start) > 10) {
          const was = kinds.get(k[1])
          if (was?.kind === 'loot' && k[2] === 'flee') {
            rush.lootToFlee++
            const ra = track.find(q => q.t === was.t), rb = track.find(q => q.t === t), ba = blueTrack.get(`${k[1]}@${was.t}`), bb = blueTrack.get(`${k[1]}@${t}`)
            if (ra && rb && ba && bb) {
              const d = (a: any, b: any) => Math.hypot(a.x - b.x, a.z - b.z), d0 = d(ba, ra), byBlue = d0 - d(bb, ra)
              rush.closedByRed += d0 - d(ba, rb); rush.closedByBlue += byBlue; if (byBlue > 2) rush.blueWalkedIn++
              // Трасса по секундам: синий и красный (x z), расстояние — для разбора, что вело синего к нему.
              if (traces.length < 12) {
                const pts: string[] = []
                for (let s = secOf(was.t); s <= secOf(t); s++) {
                  const ts = new Date((s % 86400) * 1000).toISOString().slice(11, 19), bq = blueTrack.get(`${k[1]}@${ts}`), rq = track.find(q => q.t === ts)
                  if (bq && rq) pts.push(`${ts.slice(3)} ${bq.x.toFixed(0)},${bq.z.toFixed(0)} к ${rq.x.toFixed(0)},${rq.z.toFixed(0)} ${d(bq, rq).toFixed(0)}`)
                }
                traces.push(`${k[1].replace(/^NeuroFarm/, '')}: ${pts.join(' | ')}`)
              }
            }
          }
          if (was?.kind === 'flee' && was.fromLoot && k[2] === 'loot') rush.backToLoot++
          kinds.set(k[1], { kind: k[2], t, fromLoot: was?.kind === 'loot' && k[2] === 'flee' })
        } else if (k && t) kinds.set(k[1], { kind: k[2], t, fromLoot: false })
        const c =/🧰 (NeuroFarm\S+): chest:(-?\d+),(-?\d+),(-?\d+)/.exec(line)
        if (c && t) {
          rush.lootTotal++
          const near = track.filter(q => q.t === t).map(q => Math.hypot(q.x - +c[2] - .5, q.y - +c[3], q.z - +c[4] - .5)).sort((a, b) => a - b)[0]
          if (near !== undefined && near < 8) { rush.lootNearRed++; rush.nearLoots.push(`${t} ${c[1].replace(/^NeuroFarm/, '')} ${near.toFixed(1)} бл.`) }
        }
      }
      for (const [k, re] of Object.entries({ прокоп: /⛏/, стройка: /🧱|столб|pillar/, подъём: /🧗/, добыча: /🏖/, полёт: /🪽|fly_to/, жемчуг: /🟣|pearl/, ветер: /💨|🌬/, тнт: /💣|tnt/i, позиция: /🏔/, окружение: /⭕|окруж/, штурм: /штурм/, бой: /⚔/ })) if (re.test(line)) tricks[k] = (tricks[k] || 0) + 1
    }
  }
  const out = {
    scene: SCENE, reds: REDS, seconds: Math.round(dur), firstContactS: m.firstContact, contactShare: +(m.contactSamples / Math.max(1, m.samples * REDS)).toFixed(2),
    hitsOnReds: reds.reduce((a, r) => a + r.hurts.length, 0), hitsPerMin: +(reds.reduce((a, r) => a + r.hurts.length, 0) / dur * 60).toFixed(1),
    pauses: m.pauses, pauseS: +(m.pauseMs / 1000).toFixed(1), sectorsMax: m.sectorsMax, sectorsAvgInContact: +(m.sectorsSum / Math.max(1, m.contactSamples)).toFixed(2),
    crowdMax: m.crowdMax, crowdAvg: +(m.crowdSum / Math.max(1, m.samples * REDS)).toFixed(2), reachedLevel: m.sameLevel.size, knockedOff: m.knocked, deaths: m.deaths,
    tridents: { throws: reds.reduce((a, r) => a + r.throws, 0), hits: reds.reduce((a, r) => a + r.tHits, 0) },
    ...(BOX ? { box: { openedS: box.opened ? +((box.opened - box.at) / 1000).toFixed(1) : null, firstHitS: box.firstHit ? +((box.firstHit - box.at) / 1000).toFixed(1) : null } } : {}), redSwings: reds.reduce((a, r) => a + r.swings, 0), tricks,
    ...(SCENE === 'rush' ? { rush: { ...rush, closedByRed: Math.round(rush.closedByRed), closedByBlue: Math.round(rush.closedByBlue), traces, nearLoots: rush.nearLoots.slice(0, 12) }, redDiedS: reds.find(r => r.died) ? Math.round(dur) : null } : {})
  }
  console.log('ИТОГ ' + JSON.stringify(out))
  const dir = path.join(ROOT, 'farm', 'results', `duo-${slot}`); fs.mkdirSync(dir, { recursive: true })
  fs.writeFileSync(path.join(dir, `redtest-${SCENE}-${new Date().toISOString().replace(/[:.]/g, '-')}.json`), JSON.stringify(out, null, 1))
  for (const r of reds) r.bot.quit()
  await sleep(500)
  process.exit(0)
}
main().catch(e => { console.error(e); process.exit(1) })
