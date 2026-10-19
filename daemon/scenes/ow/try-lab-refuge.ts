'use strict'
import * as gameClock from '../../src/game-clock'
// Аварийный отход (research/05-synthesis.md H5–H6, research/dev-B-refuge.md):
// тело идёт по делу (goto или mine), хп мало, мобы рядом — автопилот сам
// (EMERGENCY) бросает дело, уходит в укрытие (survival.refuge), лечится и
// отдаёт тело обратно; сцена — «мозг»: ждёт отхода, отвечает на угрозу, как
// кампания (answerThreat: бой при хп ≥ 10 и оружии, иначе бег), и повторяет
// прерванное дело.
//
// Только ферма (команды оператора готовят раунд; после старта дела — ни одной).
// VARIANT:
//   zombies  — верхний мир, 4 зомби в 6–8 бл., хп 6, 10 булыжника, каменная кирка;
//   skeleton — верхний мир, 2 скелета в 11–13 бл. и зомби в 8, остальное так же;
//   nether   — Ад, 4 зомби, 10 незерака: коробка, вниз не копать;
//   noblocks — верхний мир, 4 зомби, ни блоков, ни кирки: бегство и еда на ходу.
// TASK=goto|mine (по умолчанию — чередовать), ROUNDS (5).
// Итог раунда — строка JSON: выжил / вылечился до ≥ 16 / вернулся к делу и
// закончил его, как укрылся (how, code, секунды), что увидел и выбрал.
import * as fs from 'fs'
import { connect, createKit, sleep } from '../lib/scene-kit'

const VARIANT = process.env.VARIANT || 'zombies'
const ROUNDS = Math.max(1, Number(process.env.ROUNDS || 5))
// Без кирки mine не копает — в noblocks дело только goto.
const TASKS = process.env.TASK ? [process.env.TASK] : VARIANT === 'noblocks' ? ['goto'] : ['goto', 'mine']
const NETHER = VARIANT === 'nether'
const DIM = NETHER ? 'the_nether' : 'overworld'
// Арена: пол 5 бл. (нора на 3 копается), 61×61, стены по краю. Верхний мир —
// высоко (y 150), чтобы рельеф не мешал; Ад — закрытая скорлупа с потолком.
const X: any = NETHER ? 400 : 3000
const Z: any = NETHER ? 400 : 3000
const Y = NETHER ? 70 : 150
const R = 30
const FLOOR = NETHER ? 'netherrack' : 'stone'
const ROUND_MS = 200000
const POLICY = process.env.POLICY || 'flee'
const REFUGE_COOLDOWN_MS = 32000 // autopilot EMERGENCY.cooldownMs (от начала прошлого отхода) + запас

function mobsOf (variant) {
  const z = [['zombie', 7, 0], ['zombie', -6, 3], ['zombie', 2, -7], ['zombie', -4, -6]]
  if (variant === 'skeleton') return [['skeleton', 12, 3], ['skeleton', -9, -8], ['zombie', 3, 8]]
  return z
}
function kitOf (variant) {
  const food = ['cooked_mutton 6']
  // Середина игры: железный меч и нагрудник — после отхода сцена дерётся, как кампания.
  const gear = ['iron_sword', 'iron_chestplate']
  if (variant === 'noblocks') return [...gear, ...food]
  // Блоков на коробку мало, на столб хватает (разбор столба).
  if (variant === 'fewblocks') return [...gear, 'stone_pickaxe', 'cobblestone 5', ...food]
  if (variant === 'nether') return [...gear, 'stone_pickaxe', 'netherrack 10', ...food]
  return [...gear, 'stone_pickaxe', 'cobblestone 10', ...food]
}

async function main () {
  const slot = Number(process.env.FARM_SLOT)
  if (!(slot >= 21 && slot <= 26) || process.env.ND_WS !== `ws://127.0.0.1:${8800 + slot}` || process.env.MC_USERNAME !== `NeuroFarm${slot}`) throw new Error('только ферма, слоты 21–26')
  const conn = connect(process.env.ND_WS)
  await conn.ready
  const call = conn.call
  const st = async () => (await call('status')).state
  try {
    await call('connect')
    await call('stop')
    if ((await call('status')).detail.server !== `127.0.0.1:${25600 + slot}`) throw new Error('не сервер фермы')
    const kit = createKit({ call, heard: conn.heard, logFile: process.env.ND_SERVER_LOG, player: process.env.MC_USERNAME })
    const cmd = async text => { const r = await kit.cmd(text); if (!r.ok) throw new Error('не подтверждена команда: ' + text) }
    await cmd('/gamemode creative')
    await kit.setDifficulty('normal')
    await kit.gamerule('spawn_mobs', false)
    await kit.gamerule('advance_time', false)
    await kit.gamerule('keep_inventory', true)
    await kit.cmd('/time set 18000')
    await kit.forceload(DIM, [[X - R - 2, Y, Z - R - 2], [X + R + 2, Y, Z + R + 2]])
    await kit.ensureWorld(DIM, { tp: `${X}.5 ${Y + 12} ${Z}.5` })
    let lastEmergency = 0
    let lastRec = null
    for (let round = 1; round <= ROUNDS; round++) {
      const task = TASKS[(round - 1) % TASKS.length]
      const wall = round % 2 === 0
      const rec: Record<string, any> = { labFixture: true, slot, variant: VARIANT, task, round, wall, ok: false }
      const t0 = gameClock.now()
      try {
        // Перерыв отхода автопилота (30 с от начала прошлого) — иначе раунд не мерит ничего.
        for (const e of conn.heard) if (e && e.type === 'emergency' && (e.gameAt ?? e.at) > lastEmergency) lastEmergency = e.gameAt ?? e.at
        // Авария, прервавшая дело, приходит в by, а не в events.
        if (lastRec && lastRec.emergencyAt > lastEmergency) lastEmergency = lastRec.emergencyAt
        const wait = lastEmergency + REFUGE_COOLDOWN_MS - gameClock.now()
        if (wait > 0) await sleep(wait)
        await prepare(kit, cmd, call, { wall, round })
        rec.before = await st()
        if (rec.before.dimension !== DIM || rec.before.health < 19 || rec.before.food > 17) throw new Error(`не готова сцена: ${rec.before.dimension} хп ${rec.before.health} еда ${rec.before.food}`)
        rec.fixtureReady = true
        const res = await play(conn, call, st, task, rec)
        Object.assign(rec, res)
      } catch (e) { rec.error = e.message }
      rec.seconds = Math.round((gameClock.now() - t0) / 1000)
      rec.ok = !!(rec.fixtureReady && rec.survived && rec.healed && rec.returned)
      lastRec = rec
      fs.appendFileSync(process.env.LAB_OUT, JSON.stringify(rec) + '\n')
      console.log(JSON.stringify({ slot, variant: VARIANT, round, task, ok: rec.ok, survived: rec.survived, healed: rec.healed, returned: rec.returned,
        how: rec.refuge && rec.refuge.how, code: rec.refuge && rec.refuge.code, refugeS: rec.refuge && rec.refuge.seconds, minHp: rec.minHp, maxHpAfter: rec.maxHpAfter, error: rec.error }))
      try { await call('stop') } catch {}
    }
  } finally {
    try { await call('stop'); await call('disconnect') } catch {}
    conn.close()
  }
}

// Раунд с чистого листа: арена, рюкзак, хп 6, мобы без ИИ (ИИ — со стартом дела).
async function prepare (kit, cmd, call, { wall, round }: any) {
  await cmd('/gamemode creative')
  await kit.randomReset()
  // Мобы и дроп прошлого раунда — у арены, а не у тела (после смерти оно на спавне).
  await kit.cmd(`/execute in minecraft:${DIM} positioned ${X} ${Y} ${Z} run kill @e[type=!player,distance=..70]`)
  if (NETHER) {
    await kit.fillExact(DIM, [[X - R - 1, Y - 6, Z - R - 1], [X + R + 1, Y + 12, Z + R + 1]], 'netherrack')
    await kit.fillExact(DIM, [[X - R, Y, Z - R], [X + R, Y + 10, Z + R]], 'air')
  } else {
    await kit.fillExact(DIM, [[X - R - 1, Y - 6, Z - R - 1], [X + R + 1, Y - 1, Z + R + 1]], FLOOR)
    await kit.fillExact(DIM, [[X - R - 1, Y, Z - R - 1], [X + R + 1, Y + 4, Z + R + 1]], FLOOR)
    await kit.fillExact(DIM, [[X - R, Y, Z - R], [X + R, Y + 10, Z + R]], 'air')
  }
  // Чётный раунд — стена в 3 бл. в трёх шагах: «прижаться к стене».
  if (wall) await kit.fillExact(DIM, [[X - 3, Y, Z - 4], [X - 3, Y + 2, Z + 4]], FLOOR)
  // Цель mine — угольная руда на полу за 18 бл.
  for (const dz of [0, 1, 2]) await kit.cmd(`/execute in minecraft:${DIM} run setblock ${X + 18} ${Y} ${Z + dz} minecraft:coal_ore`)
  await kit.ensureWorld(DIM, { tp: `${X}.5 ${Y} ${Z}.5` })
  await cmd('/clear @s')
  await cmd('/effect clear @s')
  for (const item of kitOf(VARIANT)) await cmd('/give @s minecraft:' + item)
  for (const [name, dx, dz] of mobsOf(VARIANT)) {
    await cmd(`/summon minecraft:${name} ${X + dx}.5 ${Y} ${Z + dz}.5 {NoAI:1b,PersistenceRequired:1b,Tags:["nd_refuge"]}`)
  }
  await cmd('/effect give @s minecraft:instant_health 1 10 true')
  await cmd('/effect give @s minecraft:saturation 1 0 true')
  await sleep(300)
  await cmd('/effect clear @s')
  await cmd('/gamemode survival')
  // Сытость 17 без насыщения: сама не лечит (FoodData.tick — реген с 18), лечит
  // только еда из рюкзака. Иначе при 20 и насыщении хп 6 → 20 за 7 с само, и
  // отходить незачем (первый прогон сцены). Голод 200 — 1 ед. истощения за тик.
  await cmd('/effect give @s minecraft:hunger 30 200 true')
  const drainUntil = gameClock.now() + 15000
  while (gameClock.now() < drainUntil && (await call('status')).state.food > 17) await sleep(40)
  await cmd('/effect clear @s minecraft:hunger')
  await cmd('/effect give @s minecraft:instant_health 1 10 true')
  await call('armor')
  await sleep(200)
  void round
}

// Сцена-мозг: дело → прервали → ждать отхода автопилота → ответ на угрозу → снова дело.
async function play (conn, call, st, task, rec) {
  const params = task === 'mine'
    ? { block: 'coal_ore', count: 3, radius: 64, timeoutSeconds: 60, fair: false } // дело — не зрение: руда за коробкой тоже цель
    : { x: X + 25, y: Y, z: Z, range: 1, timeoutSeconds: 60 }
  const out: Record<string, any> = { calls: [], survived: false, healed: false, returned: false, minHp: 6, maxHpAfter: 0 }
  let deaths = 0
  const d0 = rec.before.lastDeathAt
  let refuge = null
  let emergency = null
  let done = false
  const deadline = gameClock.now() + ROUND_MS
  const heardFrom = conn.heard.length
  const newEvents = () => conn.heard.slice(heardFrom)
  // Мобам — ИИ: с этой секунды никакой помощи, кроме одного удара ниже.
  await call('ask', { command: '/execute as @e[tag=nd_refuge] run data merge entity @s {NoAI:0b}', ms: 400 })
  // Хп 6 — уже на ходу (иначе в простое перед делом автопилот доедает и лечится
  // сам): удар падения (тихий — дело не рвёт, и это не моб: отход решает по мобам).
  gameClock.setTimeout(() => { call('ask', { command: '/damage @s 14 minecraft:fall', ms: 300 }).catch(() => {}) }, 500)
  let poll = gameClock.setInterval(async () => {
    try {
      const s = (await call('status')).state
      out.minHp = Math.min(out.minHp, s.health)
      if (refuge) out.maxHpAfter = Math.max(out.maxHpAfter, s.health)
    } catch {}
  }, 400)
  try {
    while (!done && gameClock.now() < deadline) {
      // Отход автопилота идёт — не мешать (новое дело его оборвёт): ждать, как мозг по «занят: refuge».
      await waitRefuge(st)
      const r = await call(task, params)
      out.calls.push({ task, status: r.status, by: r.by && r.by.type, code: r.code, hp: r.state && r.state.health, stopped: r.detail && r.detail.stopped, error: r.error })
      const s = r.state || await st()
      if (s.lastDeathAt !== d0 || (r.events || []).some(e => e.type === 'death') || (r.by && r.by.type === 'death')) { deaths++; break }
      // Дело сделано по миру (руда уже в рюкзаке), а не по статусу вызова: добранная
      // между отходами руда кончается, и mine отвечает «не вижу».
      if (taskDone(task, r, s) || (task === 'mine' && /не вижу/.test(r.error || '') && await oreGone(call))) { done = true; break }
      // Прервали (урон, мало хп, авария) — отход автопилота начинается в пределах тика.
      const t1 = gameClock.now()
      let busy = s.busy
      while (busy !== 'refuge' && gameClock.now() - t1 < 2500) { await sleep(250); busy = (await st()).busy }
      if (busy === 'refuge') await waitRefuge(st)
      const evs = newEvents()
      emergency = emergency || evs.find(e => e.type === 'emergency') || (r.by && r.by.type === 'emergency' ? r.by : null)
      for (const e of [...evs, r.by]) if (e && e.type === 'emergency' && (e.gameAt ?? e.at)) out.emergencyAt = Math.max(out.emergencyAt || 0, e.gameAt ?? e.at)
      const ref = [...evs].reverse().find(e => e.type === 'refuge')
      if (ref && ref !== refuge) {
        refuge = ref
        out.refugeEndAt = gameClock.now()
        out.refuges = (out.refuges || 0) + 1
      }
      const now = await st()
      out.maxHpAfter = Math.max(out.maxHpAfter, now.health)
      if (now.lastDeathAt !== d0) { deaths++; break }
      // Как кампания (answerThreat): мобы рядом — бой при хп ≥ 10 с оружием, иначе бег.
      const sit = (await call('situation')).detail || {} as Record<string, any>
      await waitRefuge(st)
      if (sit.foes) {
        // POLICY=fight — как campaign.answerThreat (бой при оружии, хп ≥ 10 и вердикте не «уходить»);
        // по умолчанию flee — уход с боя (просьба пользователя: «быстро сливаться с битв»), дело — дальше.
        const fight = POLICY === 'fight' && sit.armed !== false && now.health >= 10 && sit.verdict !== 'уходить'
        const f = fight ? await call('fight', { timeoutSeconds: 40, retreatAtHealth: 7 }) : await call('flee', { timeoutSeconds: 15 })
        out.calls.push({ task: fight ? 'fight' : 'flee', verdict: sit.verdict, status: f.status, by: f.by && f.by.type, hp: f.state && f.state.health })
        if ((f.state || {} as Record<string, any>).lastDeathAt !== d0 || (f.by && f.by.type === 'death')) { deaths++; break }
      }
    }
  } finally { gameClock.clearInterval(poll); poll = null }
  const end = await st()
  out.end = { hp: end.health, food: end.food, pos: end.pos, dim: end.dimension, inventory: end.inventory }
  if (end.lastDeathAt !== d0) deaths = Math.max(deaths, 1)
  out.deaths = deaths
  out.survived = deaths === 0
  out.emergency = emergency ? { hp: emergency.hp, threshold: emergency.threshold, why: emergency.why, during: emergency.during, dist: emergency.dist } : null
  out.refuge = refuge ? { how: refuge.how, code: refuge.code, hp0: refuge.hp0, hp: refuge.hp, healed: refuge.healed, seconds: refuge.seconds, look: refuge.look, choice: refuge.choice, steps: refuge.steps, ate: refuge.ate, placed: refuge.placed, by: refuge.by, held: refuge.held } : null
  out.healed = !!(refuge && (refuge.healed || out.maxHpAfter >= 16))
  out.returned = done && out.survived
  // Дело кончилось раньше, чем мобы дошли, — отхода не было: раунд не мерит отход.
  out.noEmergency = !emergency
  // В Аду — коробка или карман, не нора.
  if (NETHER && refuge && refuge.how === 'hole') out.netherHole = true
  return out
}

// Руды у арены не осталось — все три блока вскопаны (уголь мог остаться на полу
// недобранным, если копку рвали мобы): дело сделано.
async function oreGone (call) {
  try {
    const r = await call('blocks_around', { find: 'coal_ore', radius: 64, count: 8 })
    return Array.isArray(r.detail && r.detail.found) && r.detail.found.length === 0
  } catch { return false }
}

async function waitRefuge (st) {
  const t0 = gameClock.now()
  while ((await st()).busy === 'refuge' && gameClock.now() - t0 < 180000) await sleep(400)
}

function taskDone (task, r, s) {
  if (task === 'mine') return ((s.inventory || {} as Record<string, any>).coal || 0) >= 3 || (r.detail && r.detail.dug >= 3)
  return Math.hypot(s.pos.x - (X + 25), s.pos.z - Z) <= 2.5
}

main().catch(e => { console.error(e); process.exitCode = 1 })
