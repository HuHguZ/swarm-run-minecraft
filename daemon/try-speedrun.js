'use strict'
const gameClock = require('./src/game-clock')
// Спидран-приёмы на настоящем мире своего сервера (2026-09-26). Сцена ставит
// тело командами оператора, а дальше всё делает демон теми же вызовами, что и
// мозг/кампания — честно, без команд:
//   (у) точность ока: N одиночных бросков (mode=throw) из разных точек вокруг
//       крепости; правда — /locate (угол чанка старта). Невязка угла — для σ.
//   (т) триангуляция mode=find: ошибка в блоках против /locate, броски, время.
//   (п) дорога через Ад mode=travel: тело в Аду в ~60 блоках от точки
//       (крепость/8), 10 обсидиана и огниво; «крепость» в памяти — из (т).
//       Правда: где тело вышло наверх, против лестницы старта.
//   (б) бартер: тело у бастиона (/locate bastion_remnant в Аду), золотой шлем,
//       слитки; mc_pearls mode=barter — сделок в минуту, жемчуг, урон.
// Запуск: ND_WS=ws://127.0.0.1:8783 node try-speedrun.js ут  (TRIALS=6 DIST=300..1500)
const path = require('path')
const { connect, createKit, sleep } = require('./scene-kit')

const WS = process.env.ND_WS || 'ws://127.0.0.1:8783'
const PLAYER = process.env.MC_USERNAME || 'NeuroDown'
const LOG = process.env.ND_SERVER_LOG || path.join(__dirname, '..', 'server-nether', 'logs', 'latest.log')
const conn = connect(WS)
const call = conn.call
const kit = createKit({ call, heard: conn.heard, logFile: LOG, player: PLAYER })
const ONLY = process.argv[2] || 'ут'
const TRIALS = Number(process.env.TRIALS || 6)
const [DMIN, DMAX] = (process.env.DIST || '300..1500').split('..').map(Number)
const NEAR = process.env.SH_NEAR ? process.env.SH_NEAR.split(',').map(Number) : [0, 0]

let failures = 0
function check (what, ok, saw) {
  if (!ok) failures++
  console.log(`   [${ok ? ' OK ' : 'ПЛОХО'}] ${what}${saw === undefined ? '' : ` — ${typeof saw === 'string' ? saw : JSON.stringify(saw)}`}`)
  return ok
}
const header = async () => ((await call('status')) || {}).state || {}
const DEG = 180 / Math.PI
const wrap = a => { a = (a + Math.PI) % (2 * Math.PI); if (a < 0) a += 2 * Math.PI; return a - Math.PI }

async function locate (what, dim = 'overworld') {
  const cmd = dim === 'overworld' ? `/locate structure minecraft:${what}` : `/execute in minecraft:${dim} run locate structure minecraft:${what}`
  const loc = await call('ask', { command: cmd, match: 'nearest|Could not', ms: 20000 })
  const line = (((loc && loc.detail) || loc || {}).lines || []).find(l => /nearest/.test(l)) || ''
  const m = /\[(-?\d+), (~|-?\d+), (-?\d+)\]/.exec(line)
  return m ? { x: Number(m[1]), z: Number(m[3]) } : null
}

// Тело на сушу у (x, z): сначала чанки телом с высоты, потом spreadplayers
// (в воду он не ставит; не вышло — «Could not», и тело упало бы в море:
// тогда другая точка). Возвращает true, если стоит на суше.
async function placeAt (x, z, spread = 24) {
  await kit.cmd('/effect give @s minecraft:slow_falling 40 0 true')
  await kit.cmd(`/execute in minecraft:overworld run tp @s ${Math.round(x)} 220 ${Math.round(z)}`)
  await sleep(4000)
  const r = await kit.cmd(`/spreadplayers ${Math.round(x)} ${Math.round(z)} 0 ${spread} false @s`, { reply: /Spread|Could not/, ms: 30000 })
  await sleep(2500)
  const ok = !!(r && r.reply && /^Spread/.test(r.reply))
  const h = await header()
  return ok && !(h.pos && h.pos.y < 63.5 && /water/.test(JSON.stringify(h.below || h.feet || '')))
}
// Точка на суше в кольце DMIN..DMAX вокруг S, ближайшая крепость оттуда — S.
async function landSpot (S) {
  for (let i = 0; i < 6; i++) {
    // ARC=0..180 — сектор углов (компас: 90 — восток), чтобы не падать в море.
    const [a0, a1] = (process.env.ARC || '0..360').split('..').map(Number)
    const a = (a0 + Math.random() * (a1 - a0)) * Math.PI / 180
    const d = DMIN + Math.random() * (DMAX - DMIN)
    const sp = { x: Math.round(S.x + Math.sin(a) * d), z: Math.round(S.z + Math.cos(a) * d), d: Math.round(d) }
    if (!(await placeAt(sp.x, sp.z))) { console.log(`   ${sp.x},${sp.z}: суши нет — другая точка`); continue }
    const again = await locate('stronghold')
    if (!again || again.x !== S.x || again.z !== S.z) { console.log(`   ${sp.x},${sp.z}: ближайшая другая — другая точка`); continue }
    return sp
  }
  return null
}

async function gear (extra = []) {
  await kit.cmd('/clear @s')
  for (const g of ['iron_pickaxe', 'iron_sword', 'iron_helmet', 'iron_chestplate', 'iron_leggings', 'iron_boots', 'cooked_beef 32', 'ender_eye 16', ...extra]) {
    await kit.cmd(`/give @s minecraft:${g}`)
  }
  await sleep(800)
  await call('armor', {})
}

const stats = { throws: [], finds: [] }

conn.ready.then(async () => {
  await call('connect')
  await call('stop')
  try {
    await kit.gamerule('spawn_mobs', 'false')
    await kit.setDifficulty('peaceful')
    await kit.cmd('/time set day')
    await kit.gamerule('advance_time', 'false')
    const h0 = await header()
    if (h0.dimension !== 'overworld') {
      await kit.cmd('/effect give @s minecraft:slow_falling 30 0 true')
      await kit.cmd(`/execute in minecraft:overworld run tp @s ${NEAR[0]} 200 ${NEAR[1]}`)
      await sleep(3000)
    } else {
      await kit.cmd('/effect give @s minecraft:slow_falling 30 0 true')
      await kit.cmd(`/tp @s ${NEAR[0]} 200 ${NEAR[1]}`)
      await sleep(3000)
    }
    const S = await locate('stronghold')
    if (!S) throw new Error('крепость не нашлась /locate')
    console.log(`/locate от ${NEAR}: крепость (угол чанка старта) ${S.x}, ${S.z}; от 0,0 ${Math.round(Math.hypot(S.x, S.z))}`)

    // Точки испытаний: вокруг крепости на DMIN..DMAX, в случайную сторону, но так,
    // чтобы /locate оттуда давал ту же крепость.
    const spots = []
    for (let i = 0; spots.length < TRIALS && i < TRIALS * 4; i++) {
      const a = Math.random() * 2 * Math.PI
      const d = DMIN + Math.random() * (DMAX - DMIN)
      spots.push({ x: Math.round(S.x + Math.sin(a) * d), z: Math.round(S.z + Math.cos(a) * d), d: Math.round(d) })
    }

    if (ONLY.includes('у')) {
      console.log(`(у) одиночные броски: ${spots.length} точек`)
      for (const sp of spots) {
        await placeAt(sp.x, sp.z)
        const again = await locate('stronghold')
        if (!again || again.x !== S.x || again.z !== S.z) { console.log(`   точка ${sp.x},${sp.z}: ближайшая другая (${JSON.stringify(again)}) — пропуск`); continue }
        await gear()
        for (let k = 0; k < 2; k++) {
          const t0 = gameClock.now()
          const r = await call('stronghold', { mode: 'throw' })
          const t = r.detail || {}
          if (!t.thrown || !t.start || !Number.isFinite(t.bearing)) { console.log(`   бросок не вышел: ${t.why || r.error || JSON.stringify(t).slice(0, 200)}`); continue }
          const truth = Math.atan2(S.x - t.start.x, S.z - t.start.z)
          const res = wrap(t.bearing - truth)
          const dist = Math.hypot(S.x - t.start.x, S.z - t.start.z)
          stats.throws.push({ res, dist, flew: t.flew, samples: t.samples })
          console.log(`   ${Math.round(dist)} бл.: угол ${t.bearingDeg}°, правда ${(truth * DEG).toFixed(4)}°, невязка ${(res * DEG).toFixed(5)}° (${(res * dist).toFixed(2)} бл. поперёк у крепости), пролёт ${t.flew}, пакетов ${t.samples}, разбилось ${t.broke}, ${Math.round((gameClock.now() - t0) / 1000)}с`)
          // Второй бросок — с другой точки в 30 блоках вбок (для решателя из памяти).
          if (k === 0) {
            const side = t.bearing + Math.PI / 2
            await call('goto', { x: Math.round(t.start.x + Math.sin(side) * 30), y: Math.round(t.start.y), z: Math.round(t.start.z + Math.cos(side) * 30), range: 3, timeoutSeconds: 40 })
          }
        }
        const sol = await call('stronghold', { mode: 'solve', maxAgeMin: 3 })
        const d = sol.detail || sol
        if (d.stronghold) console.log(`   решение по двум броскам из памяти: ${d.stronghold.x},${d.stronghold.z} p=${d.p} → ошибка ${Math.round(Math.hypot(d.stronghold.x - S.x, d.stronghold.z - S.z))} бл.`)
      }
      if (stats.throws.length) {
        const rms = Math.sqrt(stats.throws.reduce((a, t) => a + t.res * t.res, 0) / stats.throws.length)
        const max = Math.max(...stats.throws.map(t => Math.abs(t.res)))
        console.log(`   ИТОГ (у): бросков ${stats.throws.length}, невязка угла RMS ${(rms * DEG).toFixed(5)}° (${rms.toExponential(2)} рад), max ${(max * DEG).toFixed(5)}°`)
        check('(у) невязка угла меньше 0.01° (точность F3 у человека)', max * DEG < 0.01, `${(max * DEG).toFixed(5)}°`)
      }
    }

    if (ONLY.includes('т')) {
      console.log(`(т) find: ${TRIALS} точек на суше`)
      for (let n = 0; n < TRIALS; n++) {
        const sp = await landSpot(S)
        if (!sp) { console.log('   суши с этой крепостью не нашлось'); continue }
        await gear()
        const t0 = gameClock.now()
        const r = await call('stronghold', { mode: 'find', timeoutSeconds: 300 })
        const d = r.detail || {}
        const secs = Math.round((gameClock.now() - t0) / 1000)
        const err = d.stronghold ? Math.round(Math.hypot(d.stronghold.x - S.x, d.stronghold.z - S.z)) : null
        stats.finds.push({ err, secs, throws: (d.throws || []).length, p: d.p, d: sp.d, broke: (d.throws || []).filter(t => t.broke).length })
        console.log(`   ${sp.d} бл.: ${d.stronghold ? `${d.stronghold.x},${d.stronghold.z}` : d.stopped} p=${d.p} ошибка ${err} бл., бросков ${(d.throws || []).length}, разбилось ${(d.throws || []).filter(t => t.broke).length}, ${secs}с, ls ${JSON.stringify(d.ls)}`)
      }
      const ok = stats.finds.filter(f => f.err === 0).length
      const secs = stats.finds.map(f => f.secs).sort((a, b) => a - b)
      console.log(`   ИТОГ (т): точно в угол чанка ${ok}/${stats.finds.length}, время медиана ${secs[secs.length >> 1]}с, бросков в среднем ${(stats.finds.reduce((a, f) => a + f.throws, 0) / Math.max(1, stats.finds.length)).toFixed(1)}`)
      check('(т) все решения — точный угол чанка', ok === stats.finds.length && ok > 0, `${ok}/${stats.finds.length}`)
    }

    if (ONLY.includes('п')) {
      // Крепость в памяти — правда /locate, как её дал бы find (refined).
      console.log('(п) дорога через Ад: тело в Аду у точки (крепость/8) + 60')
      const N = { x: Math.floor((S.x + 4) / 8), z: Math.floor((S.z + 4) / 8) }
      await gear(['obsidian 10', 'flint_and_steel', 'diamond_pickaxe', 'cobblestone 64', 'golden_helmet'])
      await kit.cmd('/effect give @s minecraft:fire_resistance 600 0 true')
      await kit.cmd('/effect give @s minecraft:slow_falling 40 0 true')
      const a = Math.random() * 2 * Math.PI
      const sx = Math.round(N.x + Math.sin(a) * 60)
      const sz = Math.round(N.z + Math.cos(a) * 60)
      await kit.cmd(`/execute in minecraft:the_nether run tp @s ${sx} 110 ${sz}`)
      await sleep(5000)
      await kit.cmd(`/execute in minecraft:the_nether run spreadplayers ${sx} ${sz} 0 20 under 100 false @s`, { reply: /Spread|Could not/, ms: 30000 })
      await sleep(3000)
      const t0 = gameClock.now()
      // Цель — лестница старта по правде /locate (как её дал бы find): x,z явно.
      const r = await call('stronghold', { mode: 'travel', x: S.x + 4, z: S.z + 4, go: false, timeoutSeconds: 540 })
      const d = r.detail || {}
      const h = await header()
      const secs = Math.round((gameClock.now() - t0) / 1000)
      const off = h.pos ? Math.round(Math.hypot(h.pos.x - (S.x + 4), h.pos.z - (S.z + 4))) : null
      console.log(`   travel: ${r.status} ${d.stopped || ''} за ${secs}с; мир ${h.dimension}, тело ${JSON.stringify(h.pos)}, до лестницы ${off} бл.; шаги ${JSON.stringify(d.legs)}`)
      check('(п) вышел в верхний мир ближе 64 блоков к лестнице старта', h.dimension === 'overworld' && off !== null && off <= 64, `${h.dimension} ${off}`)
    }

    if (ONLY.includes('б')) {
      console.log('(б) бартер у бастиона')
      const B = await locate('bastion_remnant', 'the_nether')
      if (!B) throw new Error('бастион не нашёлся')
      console.log(`   /locate бастион ${B.x},${B.z}`)
      await gear(['golden_helmet', 'gold_ingot 64', 'cobblestone 64'])
      await kit.cmd('/effect give @s minecraft:fire_resistance 600 0 true')
      await kit.cmd('/effect give @s minecraft:slow_falling 40 0 true')
      await kit.cmd(`/execute in minecraft:the_nether run tp @s ${B.x + 8} 110 ${B.z + 8}`)
      await sleep(5000)
      await kit.cmd(`/execute in minecraft:the_nether run spreadplayers ${B.x + 8} ${B.z + 8} 0 24 under 100 false @s`, { reply: /Spread|Could not/, ms: 30000 })
      await sleep(3000)
      await call('armor', {})
      const t0 = gameClock.now()
      const r = await call('pearls', { mode: 'barter', count: Number(process.env.BARTER || 16), timeoutSeconds: 150 })
      const d = r.detail || {}
      const secs = Math.round((gameClock.now() - t0) / 1000)
      console.log(`   barter: ${r.status} за ${secs}с — отдал ${d.spent}, жемчуг ${d.pearls}, добыча ${JSON.stringify(d.gained)}, урон ${d.hpLost}, ${d.stopped || ''}`)
      check('(б) хоть одна сделка', (d.spent || 0) > 0, d.spent)
    }
  } catch (e) {
    failures++
    console.log('   [ПЛОХО] сцена оборвалась:', e.message)
  } finally {
    try { await call('stop') } catch {}
    try { await kit.gamerule('advance_time', 'true') } catch {}
    try { await kit.gamerule('spawn_mobs', 'true') } catch {}
    console.log(failures ? `\nИТОГ: ПЛОХО — ${failures}` : '\nИТОГ: всё зелёное')
    if (failures) process.exitCode = 1
    conn.close()
  }
}).catch(e => { console.error('ws:', e.message); process.exitCode = 1 })
