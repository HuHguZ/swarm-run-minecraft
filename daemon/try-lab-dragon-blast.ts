'use strict'
const gameClock = require('./src/game-clock')
// Лаборатория одного шага боя (01.10.2026, агент дракона): дракон заходит на снижение → бот взрывает кровать со
// станции у столба → сервер меряет урон. Целые бои не гоняются: подход, стройка и облака уже работают.
//
// Сцена (только ферма — команды можно):
//   · вход в Энд, набор кампании (campaign2) + кровати; дракону max_health 1024 — не умирает от цепочки;
//   · план станции считает сам бот (RPC dragon mode labPlan, плечо arm, переключатели env) по нетронутому миру;
//     сцена ставит его клетки командами (обсидиан, опоры, окоп) и ставит тело в окоп — без подхода и стройки;
//   · цикл: мир у центра — из снимка (clone), клетки плеча, тело в окоп, кровати до LAB_BEDS, хп боту;
//     дракон — на кольцо 60 в случайный угол, кружит (DragonPhase 0) 1–4 с, потом заход (DragonPhase 2 —
//     LANDING_APPROACH, id по байткоду paper-1.21.11 EnderDragonPhase: 0 HOLDING … 2 APPROACH, 3 LANDING);
//     бот (mode labRun) ждёт снижения и делает одну цепочку pillarRun, как в бою; потом дракон — на кольцо;
//   · плечи ARMS_FILE ([{name, env}]) чередуются по циклам в одном мире — сравнение на тех же условиях.
// Свидетель — сервер: плагин DragonLab (farm/dragon/lab-plugin) пишет plugins/DragonLab/events.jsonl — взрыв (bx),
// урон дракону (dd: хп до, части, seen = ServerExplosion.getSeenPercent по коробке дракона), хп после (hp),
// урон игроку (pd), фазы (ph), голову по тикам на снижении (pose), смерти.
// Итог: LAB_OUT — строки blast (на взрыв) и cyc (на снижение); сводка — node farm/dragon/an-blast.js <тег>.
//   LAB_MIN (8) — минут; LAB_BEDS (12) — кроватей на снижение; ARMS_FILE — плечи (по умолчанию одно A без env).
const fs = require('fs')
const path = require('path')
const net = require('net')
const { connect, createKit, sleep } = require('./scene-kit')

const WS = process.env.ND_WS || 'ws://127.0.0.1:8801'
const PLAYER = process.env.MC_USERNAME || 'NeuroFarm1'
const LOG = process.env.ND_SERVER_LOG || path.join(__dirname, '..', 'farm', 'server-1', 'logs', 'latest.log')
const SDIR = path.dirname(path.dirname(LOG))
const OUT = process.env.LAB_OUT || path.join(__dirname, 'lab-dragon-blast.jsonl')
const MIN = Number(process.env.LAB_MIN || 8)
const BEDS = Number(process.env.LAB_BEDS || 12)
const ARMS = process.env.ARMS_FILE ? JSON.parse(fs.readFileSync(process.env.ARMS_FILE, 'utf8')) : [{ name: 'A', env: {} as Record<string, any> }]
const EVF = path.join(SDIR, 'plugins', 'DragonLab', 'events.jsonl')
const PARTS = ['head', 'neck', 'body', 'tail1', 'tail2', 'tail3', 'wing1', 'wing2']
const prot = n => `${n}[enchantments={protection:2}]`
const KIT = [prot('iron_helmet'), prot('iron_chestplate'), prot('iron_leggings'), prot('iron_boots'), 'iron_sword', 'shield', 'iron_pickaxe',
  'cobblestone 64', 'cooked_beef 16', 'obsidian 4', ...(process.env.LAB_BOW === '1' ? ['bow', 'arrow 64'] : [])]

const conn = connect(WS)
const call = conn.call
const kit = createKit({ call, heard: conn.heard, logFile: LOG, player: PLAYER })
const header = async () => ((await call('status')) || {} as Record<string, any>).state || {} as Record<string, any>
const r2 = v => Math.round(v * 100) / 100
const out = o => fs.appendFileSync(OUT, JSON.stringify(o) + '\n')

// ---------------------------------------------------------------- RCON (по одной команде: пачку RconClient теряет)
function rcon () {
  const props = fs.readFileSync(path.join(SDIR, 'server.properties'), 'utf8')
  const get = k => (new RegExp('^' + k.replace('.', '\\.') + '=(.*)$', 'm').exec(props) || [])[1]
  const port = Number(get('rcon.port')); const pass = get('rcon.password')
  const pkt = (id, type, body) => { const b = Buffer.from(body, 'utf8'); const buf = Buffer.alloc(14 + b.length); buf.writeInt32LE(10 + b.length, 0); buf.writeInt32LE(id, 4); buf.writeInt32LE(type, 8); b.copy(buf, 12); return buf }
  let sock = null; let acc = Buffer.alloc(0); let id = 10; const wait = new Map(); let chain = Promise.resolve()
  const open = () => new Promise<any>((resolve, reject) => {
    sock = net.connect(port, '127.0.0.1')
    sock.on('data', d => {
      acc = Buffer.concat([acc, d])
      while (acc.length >= 4) {
        const len = acc.readInt32LE(0); if (acc.length < len + 4) break
        const rid = acc.readInt32LE(4); const body = acc.slice(12, len + 2).toString('utf8'); acc = acc.slice(len + 4)
        const w = wait.get(rid); if (w) { wait.delete(rid); w(body) }
      }
    })
    sock.on('error', reject)
    sock.on('connect', () => { wait.set(1, resolve); sock.write(pkt(1, 3, pass)) })
  })
  const send = body => (chain = chain.then(() => new Promise<any>(resolve => {
    const i = ++id
    const to = gameClock.wall.setTimeout(() => { wait.delete(i); resolve('') }, 8000)
    wait.set(i, r => { gameClock.wall.clearTimeout(to); resolve(r) })
    sock.write(pkt(i, 2, body))
  })))
  return { open, send, close: () => { try { sock.end() } catch {} } }
}
const rc = rcon()
const E = c => rc.send(`execute in minecraft:the_end run ${c}`)
const DRAGON = '@e[type=minecraft:ender_dragon,limit=1]'

// ---------------------------------------------------------------- события плагина
const events = []
let evPos = 0
function pollEvents () {
  let st; try { st = fs.statSync(EVF) } catch { return }
  if (st.size < evPos) evPos = 0
  if (st.size === evPos) return
  const fd = fs.openSync(EVF, 'r'); const buf = Buffer.alloc(st.size - evPos); fs.readSync(fd, buf, 0, buf.length, evPos); fs.closeSync(fd)
  const nl = buf.lastIndexOf(10); if (nl < 0) return
  evPos += nl + 1
  for (const l of buf.slice(0, nl + 1).toString('utf8').split('\n')) { if (!l) continue; try { events.push(JSON.parse(l)) } catch {} }
}
const dist = (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2])
// ExplosionDamageCalculator.getEntityDamageAmount (сила 5): ((q² + q)/2·7·10 + 1), q = (1 − d/10)·seen; не голова — /4 + min(·, 1)
function partDmg (d, seen, isHead) {
  if (d > 10) return 0
  const q = (1 - d / 10) * seen
  const raw = (q * q + q) / 2 * 7 * 10 + 1
  return isHead ? raw : raw / 4 + Math.min(raw, 1)
}

function analyse (evs, lab, arm, cyc, tickRate = gameClock.snapshot()?.tickRate) {
  const me = e => e.name === PLAYER
  const blasts = []
  const beds = (lab && lab.beds) || []
  // DragonLab ms — календарные часы сервера. Игровые sent/fcT на ускорении
  // несопоставимы; старые записи допускаются только при известных 20 TPS.
  const wallStamp = (r, wallKey, gameKey) => Number.isFinite(r[wallKey]) ? r[wallKey]
    : Number(r.tickRate ?? tickRate) === 20 && Number.isFinite(r[gameKey]) ? r[gameKey] : null
  const bx = evs.filter(e => e.t === 'bx' && /BED/.test(e.type || ''))
  const poseAt = new Map()
  for (const e of evs) if (e.t === 'pose') poseAt.set(e.tick, e)
  for (const [k, b] of bx.entries()) {
    const dd = evs.filter(e => e.t === 'dd' && e.tick === b.tick)
    const hp = evs.find(e => e.t === 'hp' && e.of === b.tick)
    const d0 = dd[0] || null
    const parts = (d0 && d0.parts) || b.parts || null
    const seen = d0 && d0.seen != null ? d0.seen : b.seen
    const dmg = d0 ? (hp ? d0.hp - hp.hp : dd.reduce((s, e) => s + e.fin, 0)) : 0
    const rec: Record<string, any> = { t: 'blast', arm, cyc, k, tick: b.tick, ph: (d0 && d0.ph) || b.ph || null, dmg: r2(dmg), seen: seen != null ? r2(seen) : null, c: b.c }
    if (parts) {
      const ds = parts.map(p => dist(p, b.c))
      rec.dHead = r2(ds[0])
      rec.headUp = r2(parts[0][1] - b.c[1]); rec.headHz = r2(Math.hypot(parts[0][0] - b.c[0], parts[0][2] - b.c[2]))
      const pd = ds.map((d, i) => partDmg(d, seen ?? 1, i === 0))
      let best = 0; for (let i = 1; i < pd.length; i++) if (pd[i] > pd[best]) best = i
      rec.part = PARTS[best]; rec.pred = r2(pd[best]); rec.dBody = r2(ds[2])
    }
    if (b.body) rec.body = b.body
    const oc = evs.find(e => e.t === 'occ' && e.tick === b.tick)
    if (oc && oc.occ) rec.occ = { seen: r2(1 - oc.occ.blocked / oc.occ.rays), inside: oc.occ.inside, rays: oc.occ.rays, top: oc.occ.top.slice(0, 5), bb: oc.occ.bb }
    // Проход головы у центра взрыва. pose тика T пишется в начале тика T (до движения дракона), а щелчок сервер
    // обрабатывает между тиками — взрыв тика N видит голову после тика N, то есть pose(N + 1). dAt(j) — голова после
    // тика N + j; dMin — ближайшая за ±10 тиков.
    const dAt = j => { const p = poseAt.get(b.tick + 1 + j); return p ? dist(p.head, b.c) : null }
    let mn = null
    for (let j = -10; j <= 10; j++) { const d = dAt(j); if (d != null && (!mn || d < mn.d)) mn = { d, dt: j } }
    if (mn) { rec.dMin = r2(mn.d); rec.dtMin = mn.dt }
    if (dAt(-1) != null) rec.dPrev = r2(dAt(-1))
    if (dAt(1) != null) rec.dNext = r2(dAt(1))
    const self = evs.filter(e => e.t === 'pd' && me(e) && e.tick === b.tick)
    rec.self = r2(self.reduce((s, e) => s + e.fin, 0))
    // запись бота — по времени щелчка (sent ≤ bx.ms, ближайшая, не «съели»): по номеру нельзя — съеденная кровать
    // даёт запись бота без взрыва (Codex dragon-blast, 02.10)
    let bot = null; let sentWall = null
    for (const r of beds) {
      const sent = wallStamp(r, 'sentWall', 'sent')
      if (sent == null || b.ms == null || sent > b.ms + 5 || b.ms - sent > 400) continue
      if (!bot || sent > sentWall) { bot = r; sentWall = sent }
    }
    if (bot) {
      rec.bot = { dist: bot.dist, headNow: bot.headNow, early: bot.early, pass: bot.pass, runnerY: bot.runnerY, seenP: bot.seenP, bodyDy: bot.bodyDy, salvage: bot.salvage, lagMs: bot.lagMs, ph: bot.ph, dmg: bot.dmg }
      // Тайминг: тик, в который ушёл щелчок (по началу тиков pose.ms), и задуманный — тик пакета прогноза + pass + 1
      const tickOf = ms => { let t = null; for (const [tk, p] of poseAt) if (p.ms <= ms && (t == null || tk > t)) t = tk; return t }
      const ts = tickOf(sentWall)
      if (ts != null) { rec.sentTick = ts - b.tick; rec.sentInTick = sentWall - poseAt.get(ts).ms }
      // пакет прогноза приходит в начале тика tb (1–4 мс после pose) и несёт дракона после тика tb − 1; path[pass] —
      // после тика tb − 1 + pass + 1 = tb + pass. aimErr > 0 — взрыв позже задуманного
      const fcWall = wallStamp(bot, 'fcWall', 'fcT')
      if (fcWall != null && bot.pass != null) { const tb = tickOf(fcWall); if (tb != null) { rec.aimErr = b.tick - (tb + bot.pass); rec.fcInTick = fcWall - poseAt.get(tb).ms } }
    }
    blasts.push(rec)
  }
  const selfBy: Record<string, any> = {} as Record<string, any>
  for (const e of evs.filter(e => e.t === 'pd' && me(e))) { const k = `${e.cause}${e.by ? ':' + e.by : ''}`; selfBy[k] = r2((selfBy[k] || 0) + e.fin) }
  const run = (lab && lab.run) || {} as Record<string, any>
  const phs = evs.filter(e => e.t === 'ph').map(e => e.to)
  const cycRec: Record<string, any> = {
    t: 'cyc', arm, cyc, landed: phs.includes('LAND_ON_PORTAL'), blasts: blasts.length, arrows: evs.filter(e => e.t === 'dd' && e.type === 'arrow').map(e => ({ tick: e.tick, fin: r2(e.fin), dmg: r2(e.dmg) })), dmg: r2(blasts.reduce((s, b) => s + b.dmg, 0)),
    why: run.why || (lab && lab.stop) || null, lost: run.lost || 0, eaten: run.eaten || 0, bedFail: run.bedFail || 0, salvage: run.salvage || 0,
    runnerHeights: run.runnerHeights || null, booms: run.booms || null, self: r2(Object.values<any>(selfBy).reduce((s, v) => s + v, 0)), selfBy, deaths: evs.filter(e => e.t === 'death' && me(e)).length,
    phases: phs.slice(0, 12), ms: lab ? lab.ms : null, inTrench: lab ? lab.inTrench : null, botHp: lab ? lab.hp : null
  }
  return { blasts, cycRec }
}

async function toEnd () {
  for (let i = 0; i < 3; i++) {
    const h = await header()
    if (h.dimension === 'the_end') return true
    await rc.send(`effect give ${PLAYER} minecraft:slow_falling 15 0 true`)
    await E(`tp ${PLAYER} 0.5 75 -20.5`)
    for (let k = 0; k < 30; k++) { await sleep(1000); if ((await header()).dimension === 'the_end') { await sleep(3000); return true } }
  }
  return false
}
async function giveKit () {
  await rc.send(`clear ${PLAYER}`)
  for (const g of KIT) await rc.send(`give ${PLAYER} minecraft:${g}`)
  await sleep(800)
  try { await call('armor', {} as Record<string, any>) } catch {}
}

conn.ready.then(async () => {
  const t0 = gameClock.now()
  const res: Record<string, any> = { t: 'summary', at: new Date().toISOString(), arms: ARMS.map(a => a.name), cycles: 0 }
  try {
    // под нагрузкой фермы connect падает на «10 chunks to load» — ещё раз
    for (let i = 0; ; i++) { try { await call('connect'); break } catch (e) { if (i >= 5) throw e; console.log('connect:', e.message); await sleep(5000) } }
    await call('stop')
    await rc.open()
    try { evPos = fs.statSync(EVF).size } catch { evPos = 0 }
    const poll = gameClock.setInterval(pollEvents, 100)
    await rc.send(`gamemode survival ${PLAYER}`)
    if (!(await toEnd())) throw new Error('не в Энде')
    await E('forceload add -16 -16 15 15')
    await E('forceload add 192 -16 223 15')
    await giveKit()
    let alive = false
    for (let i = 0; i < 40 && !alive; i++) { alive = /passed/i.test(await E(`execute if entity ${DRAGON}`)); if (!alive) await sleep(1000) }
    if (!alive) throw new Error('дракона нет')
    await E(`attribute ${DRAGON} minecraft:max_health base set 1024`)
    await E(`data merge entity ${DRAGON} {Health:1024f}`)
    await E(`execute positioned 0 0 -12 positioned over motion_blocking run tp ${PLAYER} ~0.5 ~ ~0.5`)
    await sleep(3000)
    // Снимок нетронутого центра (x/z −8..8, y 50..75) — в x 200..216; метка — золотой блок 199,50,−9. Метка есть
    // (прошлая сцена в этом мире) — сперва вернуть центр из снимка, потом считать планы.
    const Y0 = 50; const Y1 = 75
    if (/passed/i.test(await E('execute if block 199 50 -9 minecraft:gold_block'))) await E(`clone 200 ${Y0} -8 216 ${Y1} 8 -8 ${Y0} -8`)
    else { await E(`clone -8 ${Y0} -8 8 ${Y1} 8 200 ${Y0} -8`); await E('setblock 199 50 -9 minecraft:gold_block') }
    await sleep(1500)
    // планы плеч — по нетронутому миру
    const plans: Record<string, any> = {} as Record<string, any>
    for (const a of ARMS) {
      const r = await call('dragon', { mode: 'labPlan', arm: a.name, env: a.env || {} as Record<string, any>, timeoutSeconds: 120 })
      const lab = (r && r.detail && r.detail.lab) || {} as Record<string, any>
      if (!lab.plan) { out({ t: 'noplan', arm: a.name, lab }); console.log(`плечо ${a.name}: плана нет (${JSON.stringify(lab).slice(0, 300)})`); continue }
      plans[a.name] = lab.plan
      out({ t: 'plan', arm: a.name, plan: lab.plan, ms: lab.ms })
      console.log(`план ${a.name}: H ${lab.plan.H} F ${lab.plan.F} B ${lab.plan.B} ноги ${lab.plan.feet} seen ${lab.plan.seen} клеток ${lab.plan.cells.length}`)
    }
    const armsOk = ARMS.filter(a => plans[a.name])
    if (!armsOk.length) throw new Error('ни одного плана')
    const P = plans[armsOk[0].name].P
    res.P = P
    const tEnd = t0 + MIN * 60000
    for (let cyc = 0; gameClock.now() < tEnd - 20000; cyc++) {
      const arm = armsOk[cyc % armsOk.length]
      const pl = plans[arm.name]
      const h = await header()
      if (h.dimension !== 'the_end') { await toEnd(); await giveKit() }
      // мир у центра — из снимка, потом клетки плеча; тело — над островом на время клона
      await E(`tp ${PLAYER} 0.5 ${P + 14} -12.5`)
      await E(`clone 200 ${Y0} -8 216 ${Y1} 8 -8 ${Y0} -8`)
      for (const [x, y, z, b] of pl.cells) await E(`setblock ${x} ${y} ${z} minecraft:${b}`)
      for (const t of ['enderman', 'item', 'experience_orb', 'area_effect_cloud', 'dragon_fireball']) await E(`kill @e[type=minecraft:${t},x=0,y=${P},z=0,distance=..90]`)
      const [fx, fy, fz] = pl.feet
      const yaw = Math.atan2(-(pl.H[0] + 0.5 - fx), pl.H[2] + 0.5 - fz) * 180 / Math.PI
      await E(`tp ${PLAYER} ${fx} ${fy} ${fz} ${yaw.toFixed(1)} 30`)
      await rc.send(`effect give ${PLAYER} minecraft:instant_health 1 5 true`)
      await rc.send(`effect give ${PLAYER} minecraft:saturation 1 20 true`)
      // булыжник на опору P + 1 и столбики — каждый цикл (labS1/labS2: 64 штук кончались к ~20-му циклу — ярус P + 1 пропадал)
      await rc.send(`clear ${PLAYER} minecraft:cobblestone`)
      await rc.send(`give ${PLAYER} minecraft:cobblestone 64`)
      await rc.send(`clear ${PLAYER} minecraft:red_bed`)
      await rc.send(`give ${PLAYER} minecraft:red_bed ${BEDS}`)
      // LAB_BOW=1 (02.10): лук и 16 стрел на снижение — стрелы в промежутках цепочки (ND_RUN_GAPARROW)
      if (process.env.LAB_BOW === '1') { await rc.send(`clear ${PLAYER} minecraft:arrow`); await rc.send(`give ${PLAYER} minecraft:arrow 16`) }
      // дракон — на кольцо 60 в сторону, противоположную окопу (±60°): заход (LANDING_APPROACH) идёт от узла напротив
      // игрока — короткий путь к нему, а сам заход и снижение — свои, как в бою
      const a0 = Math.atan2(-pl.B[1], -pl.B[0]) + (Math.random() - 0.5) * Math.PI * 2 / 3
      await E(`tp ${DRAGON} ${(Math.cos(a0) * 60).toFixed(1)} ${P + 20} ${(Math.sin(a0) * 60).toFixed(1)}`)
      await E(`data merge entity ${DRAGON} {DragonPhase:0,Health:1024f}`)
      await sleep(1200)
      const from = events.length
      const tc = gameClock.now()
      let done = false; let lab = null
      const runP = call('dragon', { mode: 'labRun', arm: arm.name, env: arm.env || {} as Record<string, any>, waitSeconds: 65, timeoutSeconds: 90 })
        .then(r => { lab = (r && r.detail && r.detail.lab) || null; done = true }, () => { done = true })
      await sleep(800 + Math.random() * 1500)
      await E(`data merge entity ${DRAGON} {DragonPhase:2}`)
      let forced = 1
      while (!done) {
        await sleep(250)
        const landed = events.slice(from).some(e => e.t === 'ph' && e.to === 'LAND_ON_PORTAL')
        if (!landed && forced < 3 && gameClock.now() - tc > 20000 * forced) { forced++; await E(`data merge entity ${DRAGON} {DragonPhase:2}`) }
      }
      await runP
      // цепочка кончилась (сел/взлетел/кровати) — дракона прочь, пока не дохнул на окоп
      const a1 = Math.atan2(-pl.B[1], -pl.B[0]) + (Math.random() - 0.5) * Math.PI * 2 / 3
      await E(`tp ${DRAGON} ${(Math.cos(a1) * 60).toFixed(1)} ${P + 25} ${(Math.sin(a1) * 60).toFixed(1)}`)
      await E(`data merge entity ${DRAGON} {DragonPhase:0,Health:1024f}`)
      await sleep(700)
      const { blasts, cycRec } = analyse(events.slice(from), lab, arm.name, cyc)
      cycRec.forced = forced
      for (const b of blasts) out(b)
      out(cycRec)
      res.cycles++
      console.log(`[${arm.name} #${cyc}] ${cycRec.landed ? 'снижение' : 'НЕ СЕЛ'}: взрывов ${cycRec.blasts}, урон ${blasts.map(b => `${b.dmg}(${b.dHead}/${b.seen}/${b.part})`).join(' ')}; ${cycRec.why}; нам ${cycRec.self} ${JSON.stringify(cycRec.selfBy)}${cycRec.deaths ? ' СМЕРТЬ' : ''}`)
      if (events.length > 20000) events.splice(0, events.length - 5000)
    }
    gameClock.clearInterval(poll)
  } catch (e) {
    res.error = e.message
    console.log('сцена оборвалась:', e.stack || e.message)
  } finally {
    res.seconds = Math.round((gameClock.now() - t0) / 1000)
    res.ok = !res.error && res.cycles > 0
    out(res)
    try { await call('stop') } catch {}
    rc.close()
    conn.close()
    gameClock.wall.setTimeout(() => process.exit(0), 500)
  }
}).catch(e => { console.error('ws:', e.message); process.exitCode = 1 })
