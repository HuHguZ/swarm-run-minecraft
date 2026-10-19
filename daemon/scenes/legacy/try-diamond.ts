'use strict'
import * as gameClock from '../../src/game-clock'
// The run that matters: surface -> bedrock-ish -> drift for ore -> home alive.
// Every piece of this has been proven on its own; nothing has been proven
// together, and "works alone" is the weakest kind of works.
//
// This is deliberately written the way the brain would play it, not as a happy
// path: every descent step can come back "stopped: лава", and the answer to
// that is to shuffle sideways and try again, not to give up.
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
const DIAMOND_Y = Number(process.env.DIAMOND_Y || -58)

async function cmd (text) {
  await call('say', { text })
  await sleep(600)
}

let died = null

async function step (label, method, params) {
  const r: any = await call(method, params).catch(e => ({ status: 'RPC', error: e.message }))
  const problem = r.status === 'failed' ? ` ← ${r.error}` : r.status === 'timeout' ? ' ← таймаут' : ''
  console.log(`${label.padEnd(26)} ${String(r.status).padEnd(10)} ${JSON.stringify(r.detail ?? null)}${problem}`)
  // A death ends the expedition, and the run has to know it before the next
  // line. Past this point the body is at spawn with an empty backpack, so
  // every intent still queued reports on a bot that is not where the script
  // thinks it is — that is what the last twenty lines of diamond4.log were.
  const grave = [r.by, ...(r.events || [])].find(e => e && e.type === 'death')
  if (grave && !died) died = { at: grave.pos, during: label }
  // Events are where the damage lives; without them a run that quietly lost
  // fifteen health reads as a pathfinding problem.
  const ev = (r.events || []).map(e => e.type)
  if (ev.length) console.log(`${''.padEnd(26)} события: ${ev.join(', ')}`)
  return r
}

const pos = async () => ((await call('status')) as any).state.pos
const inv = async () => ((await call('status')) as any).state.inventory

// A kit a player actually has after a day or two. The point of the run is the
// descent, not the fetch quest that pays for it.
async function outfit () {
  await call('stop')
  await cmd('/clear @s')
  await cmd('/time set 6000')
  // Поход — экзамен в настоящем мире, а не на арене: мобы спавнятся сами.
  // Раньше тут стояло doMobSpawning false, и сервер 1.21.11 его молча отвергал
  // (правило теперь spawn_mobs) — значит, все прошлые походы, включая смерти на
  // -29 и -34, шли со спавном. Выключить его сейчас значило бы сдать экзамен
  // легче, чем его проваливали. Возвращаем явно: предыдущая сцена могла
  // выключить уже работающим именем.
  await cmd('/gamerule spawn_mobs true')
  // Сложность заявляем свою: без этой строки поход наследовал её у предыдущей
  // сцены, и на peaceful мобы под землёй просто не появлялись — прогон выглядел
  // спокойным не потому, что бот хорош, а потому, что драться было не с кем.
  await cmd('/difficulty normal')

  // Effects BEFORE the teleport, not after. The drop from y=100 to the ground
  // is twenty blocks, and the 700ms this used to wait before healing was long
  // enough to die in: the last run's log reads "NeuroDown fell from a high
  // place", and everything after it measured a replacement body.
  await cmd('/effect give @s minecraft:slow_falling 40 0 true')
  await cmd('/effect give @s minecraft:regeneration 20 5 true')
  await cmd('/tp @s 120 100 120')
  await sleep(8000)

  // Whatever was already standing here. doMobSpawning only stops new mobs, and
  // the run before this one was met at the bottom of its own staircase.
  await cmd('/kill @e[type=!player,type=!item,distance=..48]')

  // The run before last respawned into another scene's arena, because that
  // scene had set a personal spawnpoint and never took it back. A death here
  // has to land here.
  const landed = await pos()
  await cmd(`/spawnpoint @s ${landed.x} ${landed.y} ${landed.z}`)
  for (const give of [
    'minecraft:iron_pickaxe 2', 'minecraft:iron_sword 1', 'minecraft:cooked_beef 24',
    'minecraft:torch 64', 'minecraft:cobblestone 64', 'minecraft:crafting_table 1',
    'minecraft:iron_helmet 1', 'minecraft:iron_chestplate 1', 'minecraft:iron_leggings 1',
    'minecraft:iron_boots 1', 'minecraft:coal 16', 'minecraft:oak_planks 16',
    // Щит в наборе, потому что прошлый поход умер без него: на подъёме с -58
    // бот поставил два заслона от зомби, третий подошёл вплотную (заслон в
    // занятую клетку не встанет), бот его зарубил за три взмаха — и погиб от
    // тех, кто бил сзади. В отчёте боя стояло «щита нет ни в руке, ни в
    // рюкзаке». Автопилот кладёт его в левую руку сам, как броню.
    'minecraft:shield 1'
  ]) await cmd(`/give @s ${give}`)
  await sleep(900)
  // Одеться ЯВНО, а не ждать автопилота. Он берётся за броню не чаще раза в 15
  // секунд и не берётся вовсе, пока идёт намерение, — а весь поход это одно
  // намерение за другим. Прошлый прогон дрался в том, что автопилот случайно
  // успел надеть: в отчёте боя «одеться не смог: вплотную (1 бл.)».
  await step('одеться перед выходом', 'armor', {} as Record<string, any>)
}

// A staircase, not a shaft. The first run of this went three blocks down, hit a
// cave, and could not sidestep out of its own hole - pathfinder cannot climb a
// 1x1 column. A staircase never creates that problem: it bridges the cave under
// the step and stays walkable in both directions.
//
// When a leg stops on lava or water the answer is a new bearing, not a retreat:
// the staircase simply turns and keeps descending.
// Every underground action refuses to work with a hostile at its back, which is
// correct and is also the point where a script stops being able to stand in for
// a brain. So: deal with it, then carry on. This is the decision Claude makes in
// a real session; here it is hard-coded so the rest of the run can be measured.
async function dealWith (reason, detail) {
  // The drift now hands over a structured threat; the text is the fallback for
  // the intents that do not.
  const threat = detail && detail.threat
  if (threat && threat.sealed) {
    console.log(`   ↳ ${threat.mob} в ${threat.dist} — заложился, дерусь не буду`)
    return true
  }
  const say = String(reason || '')
  if (!threat && !/в шести блоках|спиной к нему|здоровья|zombie|skeleton|моб|враг/i.test(say)) return false
  const st: any = await call('status')
  if (st.state.health < 12) {
    await step('  поесть', 'eat', {} as Record<string, any>)
    await call('wait', { seconds: 8 })
  }
  const r: any = await step('  разобраться с мобом', 'fight', { retreatAtHealth: 7, timeoutSeconds: 45 })
  return r.status === 'done'
}

// A worn-out pickaxe is the one refusal that answers itself: the stop line
// names the tool to make and the material already in the bag. The autopilot
// will not do it here — its reserve is a flat forty swings, and the climb home
// from y=-59 needs five hundred and sixty-eight, so by its rule nothing is
// wrong yet. This is the decision Claude makes in a real session; here it is
// hard-coded so the rest of the run can be measured.
const CRAFTABLE = /можно скрафтить (\w+)/

async function dealWithTool (reason) {
  const m = CRAFTABLE.exec(String(reason || ''))
  if (!m) return false
  const want = m[1]
  // Sticks first and separately: the pickaxe recipe consumes them, and on a
  // deep run the bag has planks but never sticks — nothing down here drops any.
  await step('  палки', 'craft', { item: 'stick', count: 4 })
  const r: any = await step(`  сделать ${want}`, 'craft', { item: want, count: 1 })
  return r.status === 'done'
}

const BEARINGS = ['east', 'south', 'west', 'north']

// How much health the scene agrees to pay per call for drops: the brain's
// decision, fixed as a number here so the rest of the trip can be measured.
// The floor is the daemon's (ledge.reserve, lowHealth + 1), so this answers
// only «worth it», never «will I live».
const FALL_BUDGET = Number(process.env.FALL_BUDGET || 10)
const sameSpot = (a, b) => !!a && !!b && a.x === b.x && a.y === b.y && a.z === b.z

// Below this many placements against an underside the counts are printed as a
// measurement, not a verdict. The run of 2026-09-16 printed «[ПЛОХО] … ни разу не
// принял» from ONE refusal — and the leg right after it had come back with
// underside 2, which the loop never counted because it returned on
// `interrupted` before tallying. One sample cannot tell «the server refuses this
// face» from «that one click was refused for its own reason».
const UNDERSIDE_SAMPLE = 5

// How many guard stops one descent follows before it stops following them: past
// that the same few squares are being argued over, not descended through.
const GUARD_ROUNDS = 8

// The descent's own guard (actions.descentGuard) answers a mob the way the drift
// and the climb do, and a stop carries `threat` with `next` as fields. This is
// the brain's half, fixed so the rest of the run can be measured: fight when the
// answer names the fight and one side at most is open to it (reach ≤ 1 — the
// cheapest fight there is); otherwise take the call it names. A fight named at a
// wider reach is still the named call, and the line says so. Every decision is
// printed with the numbers it was taken on.
//
// Two reds, both contradictions inside one answer and so the code's, not the
// world's: a stop that names no call at all, and a wall «по ходу лесенки» that
// sends the staircase back onto the bearing it has just refused.
async function answerGuard (d, dir, tally) {
  const t = d.threat
  const n = t.next || {} as Record<string, any>
  tally.guardStops++
  console.log(`   ↳ страж: ${t.mob} в ${t.dist} бл. ${t.where || ''}, ${t.how || '?'}; закрылся ${t.sealed ? 'да' : 'нет'}` +
    `${typeof t.placed === 'number' ? `, блоков ${t.placed}` : ''}, сторон открыто ${t.reach ?? '—'}, в виду ${t.seen ?? '—'}; назвал ${JSON.stringify(n)}`)
  if (!n.call) {
    tally.guardBroken.push({ at: d.at, why: 'стоп без хода' })
    console.log(`   [ПЛОХО] страж встал и не назвал ни одного хода: «${d.stopped}»`)
    return { end: 'страж не назвал хода' }
  }
  if (n.call === 'mc_fight') {
    const cheap = typeof t.reach === 'number' && t.reach <= 1
    console.log(`   ↳ решение: бой с ${n.target || t.mob} — ` + (cheap
      ? `открыто сторон ${t.reach}, ко мне пролезет только он`
      : `сторон открыто ${t.reach ?? '—'}, но ответ назвал бой (в виду ${t.seen ?? '—'}) — иду по названному`))
    tally.guardFights++
    const f: any = await step('  бой по ответу стража', 'fight', { target: n.target || t.mob, retreatAtHealth: 7, timeoutSeconds: 45 })
    const fd = f.detail || {} as Record<string, any>
    console.log(`   ↳ после боя: ${f.status}${fd.killed ? `, убит ${fd.killed}` : ''}${fd.swings !== undefined ? `, взмахов ${fd.swings}` : ''}; тот же вызов лесенки с того же места`)
    return { again: true }
  }
  if (n.call === 'mc_dig_down' && n.direction) {
    if (n.direction === dir) {
      tally.guardBroken.push({ at: d.at, why: `заложился по ходу ${dir} и назвал тот же ${dir}` })
      console.log(`   [ПЛОХО] страж заложился по ходу лесенки на ${dir} и назвал тот же ${dir} — ход, который он сам только что отверг`)
      return { end: 'страж назвал отвергнутое направление' }
    }
    tally.guardTurns++
    console.log(`   ↳ решение: стена стоит по ходу лесенки — поворачиваю на ${n.direction}, как назвал ответ`)
    return { dir: n.direction }
  }
  console.log(`   ↳ решение: ответ назвал ${n.call}${n.then ? `, потом ${n.then}` : ''} — этого сцена сама не сделает, спуск кончаю`)
  return { end: `страж назвал ${n.call}` }
}

// What the guard met on a leg that it did not stop on, counted: walls that
// closed, mobs let be. And whether the leg was hurt with no word from the guard
// at all — a number, not a red: falls, lava and an arrow from past the radius
// all hurt without a mob the guard can answer.
function countGuard (r, d, tally) {
  for (const m of d.met || []) {
    tally.guardMet++
    if (m.what === 'заложился') tally.guardWalls++
    if (m.what === 'мимо') tally.guardPassed++
  }
  const hurt = (r.events || []).filter(e => e && e.type === 'damage').length
  if (hurt) {
    tally.damageLegs++
    tally.damageEvents += hurt
    if (!(d.met || []).length) tally.damageUnanswered++
  }
}

// The run of 2026-09-15 ended here: a cave opened under the staircase at y=40,
// eight legs cycled the bearings, and at y=1 the descent stopped on «Остаётся
// спрыгнуть» with no call that jumps. A refusal now carries `ledge` (drop,
// cost, after, retry, other, directionWontHelp, refused) and this loop reads
// those fields, not the Russian, and takes the move they name: `retry` is the
// exact parameters the same call jumps with. Every decision is printed with
// its numbers. The one red is about code: a call made with `retry` came back
// with the same price refusal from the same spot — the refusal named a move
// that does not exist.
async function descend (toY) {
  let legs = 0
  let stalled = 0
  let dir = BEARINGS[0]
  let extra: Record<string, any> = {} as Record<string, any>
  let promise = null
  const once = new Set()
  const tally: Record<string, any> = {
    ledges: 0, taken: 0, propped: 0, bridged: 0, underside: 0, undersideRefused: 0, drops: [], deadEnds: [],
    guardStops: 0, guardFights: 0, guardTurns: 0, guardWalls: 0, guardPassed: 0, guardMet: 0, guardBroken: [],
    damageLegs: 0, damageEvents: 0, damageUnanswered: 0
  }
  let guardRounds = 0
  const out = async (reached, why?: any) => ({ reached, at: died ? died.at : await pos(), legs, why, ...tally })

  // A leg whose ledge contradicts the option the last ledge named. Judged by
  // what the scene SENT, not by the maxFallHp the daemon echoes: a daemon that
  // drops the parameter on the floor echoes 0 and would otherwise look like a
  // call that simply did not offer enough. Only the price kind counts — «hurt»
  // and «mob» are the world moving under us, not the code refusing its advice.
  const broken = (l, mode) => {
    if (!promise || !l || promise.mode !== mode || !sameSpot(promise.at, l.at)) return false
    if (l.drop !== 'price' || l.cost > promise.sent - (l.spent || 0)) return false
    tally.deadEnds.push({ at: l.at, mode, sent: promise.sent, echoed: l.maxFallHp, cost: l.cost })
    console.log(`   [ПЛОХО] отказ назвал maxFallHp=${promise.cost}, вызов с maxFallHp=${promise.sent} вернул тот же отказ ` +
      `(цена ${l.cost}, демон видит maxFallHp=${l.maxFallHp}) с ${l.at.x},${l.at.y},${l.at.z}`)
    return true
  }
  const countFaces = (l) => {
    if (l && Array.isArray(l.refused)) tally.undersideRefused += l.refused.filter(f => f === 'bottom').length
  }

  // With nothing to prop with, a refusal names the fetch — ledge.mine, «mc_mine
  // block=stone_like count=N» — and the same call after it; a jump past any
  // health (drop 'high') names nothing else on a pillar. Followed once per
  // square. The red is the code's: mc_mine brought blocks and the next leg from
  // that same square still had nothing to prop with.
  const fetched = new Set()
  let fetchPromise = null
  const fetchFor = async (l, where) => {
    const key = `${l.at.x},${l.at.y},${l.at.z}`
    if (!l.mine || fetched.has(key)) return false
    fetched.add(key)
    const m: any = await step(`  добыть ${l.mine} камня`, 'mine', { block: 'stone_like', count: l.mine, timeoutSeconds: 120 })
    const got = Object.values<any>((m.detail && m.detail.gained) || {} as Record<string, any>).reduce((n, v) => n + Math.max(0, v), 0)
    console.log(`   ↳ ${where}: подмостить нечем (${l.drop}${l.fall ? `, пол в ${l.fall}` : ''}) — добыл ${got} из ${l.mine}, зову тот же вызов`)
    fetchPromise = got > 0 ? { at: l.at, got, want: l.mine } : null
    return true
  }
  const fetchedInVain = (l) => {
    const p = fetchPromise
    fetchPromise = null
    if (!p || !l || !l.mine || !sameSpot(p.at, l.at)) return false
    tally.deadEnds.push({ at: l.at, mode: 'mine', got: p.got, want: p.want })
    console.log(`   [ПЛОХО] отказ назвал mc_mine count=${p.want}, добыто ${p.got}, а тот же вызов с ${l.at.x},${l.at.y},${l.at.z} ` +
      `снова говорит «подмостить нечем» (mine=${l.mine})`)
    return true
  }

  // Which option of a drop refusal the scene takes, or null. Logged either way.
  const takeDrop = async (l, where) => {
    if (!l.retry) return null
    if (l.cost > FALL_BUDGET) {
      console.log(`   ↳ ${where}: прыжок ${l.fall} бл. стоит ${l.cost} хп — дороже бюджета сцены ${FALL_BUDGET}, не беру`)
      return null
    }
    const key = `${l.drop}@${l.at.x},${l.at.y},${l.at.z}`
    if (l.drop === 'price') {
      console.log(`   ↳ ${where}: пол в ${l.fall} бл., цена ${l.cost} хп из ${l.hp}, после ${l.after} (запас демона ${l.reserve}) — плачу, maxFallHp=${l.retry.maxFallHp}`)
      return l.retry
    }
    if (once.has(key)) return null
    once.add(key)
    if (l.drop === 'hurt') {
      console.log(`   ↳ ${where}: прыжок ${l.cost} хп при ${l.hp} — подлечиваюсь до ${l.healTo}: ем и жду ${l.waitSeconds}с`)
      await step('  поесть перед прыжком', 'eat', {} as Record<string, any>)
      await call('wait', { seconds: l.waitSeconds })
      return l.retry
    }
    if (l.drop === 'mob') {
      console.log(`   ↳ ${where}: у места приземления ${l.mob.who} в ${l.mob.dist} бл. — жду ${l.waitSeconds}с и пробую снова`)
      await call('wait', { seconds: l.waitSeconds })
      return l.retry
    }
    return null
  }

  for (let attempt = 0; attempt < 20; attempt++) {
    const here = await pos()
    if (here.y <= toY) return out(true)

    const want = Math.min(40, here.y - toY)
    const r: any = await step(`лесенка ${dir} ${want} (с ${here.y})${extra.maxFallHp ? ` hp≤${extra.maxFallHp}` : ''}`, 'dig_down',
      { mode: 'stairs', depth: want, direction: dir, timeoutSeconds: 240, ...extra })
    legs++

    const d = r.detail || {} as Record<string, any>
    // Counted BEFORE anything decides to leave. A leg that was interrupted still
    // reports what it did, and on 2026-09-16 exactly that report was thrown
    // away: leg 4 came back `interrupted` carrying underside 2, the loop
    // returned on the status first, and the verdict then printed «сервер принял
    // 0, отказал 1» out of the one refusal it had counted.
    tally.propped += d.propped || 0
    tally.bridged += d.bridged || 0
    tally.underside += d.underside || 0
    countGuard(r, d, tally)
    // With the leg's ends: the cave that proves the underside will not be at
    // 160,40,120 again — the next staircase from 120,73 cuts 1:1 and meets it
    // lower and elsewhere, if at all.
    if (d.bridged) {
      console.log(`   ↳ над пустотой (${d.from.x},${d.from.y},${d.from.z} → ${d.at.x},${d.at.y},${d.at.z}): ступенек на поставленном блоке ${d.bridged}, ` +
        `из них с подпоркой ${d.propped || 0}, на нижней грани ${d.underside || 0}`)
    }
    for (const j of d.drops || []) {
      tally.drops.push(j)
      console.log(`   ↳ прыжок ${j.fell} бл. с y=${j.from.y}: цена ${j.cost} хп, заплачено ${j.paid}, осталось ${j.hp}`)
    }
    // Both halves of the underside ledger on the same side of the return, or the
    // sample size below is short by the refusals an interrupted leg carried and
    // the verdict is biased the other way — one over, one under.
    const l = d.ledge
    countFaces(l)
    if (died) return out(false, 'умер на спуске')
    // Now that everything the leg brought back is counted: an interrupt ends the
    // descent the way it always did (low_health here means the body is on three
    // hit points), and its numbers are in the tally.
    if (r.status !== 'done') return out(false, r.error || r.status)

    if (broken(l, 'stairs')) return out(false, 'отказ назвал ход, которого нет')
    if (fetchedInVain(l)) return out(false, 'отказ назвал ход, которого нет')
    promise = null
    extra = {} as Record<string, any>

    if (d.stopped && await dealWithTool(d.stopped)) { attempt--; continue }
    // The guard stopped this leg: it has already said what it did and what it
    // needs, in fields. This is the one place the scene plays the brain.
    if (d.threat) {
      if (++guardRounds > GUARD_ROUNDS) return out(false, `страж останавливал ${guardRounds - 1} раз — дальше это спор об одном квадрате`)
      const g = await answerGuard(d, dir, tally)
      if (g.end) return out(false, g.end)
      if (g.dir) { dir = g.dir; continue }
      attempt--
      continue
    }
    // A ledge carries its own mob answer (drop: 'mob'); only other stops go to
    // the fight, or its zombie in the landing sentence would start one.
    if (!l && d.stopped && await dealWith(d.stopped, d)) {
      // A mob, not the rock, stopped us: same bearing again once it is handled.
      attempt--
      continue
    }

    if (l) {
      tally.ledges++
      const retry = await takeDrop(l, 'уступ')
      if (retry) {
        tally.taken++
        extra = retry
        promise = { at: l.at, mode: 'stairs', cost: l.cost, sent: retry.maxFallHp }
        continue
      }
      // Blocks before turning, as the daemon orders it: a staircase on props
      // stays walkable both ways, a turn only moves the same question over.
      if (await fetchFor(l, 'уступ')) { tally.taken++; continue }
      if (l.other) {
        console.log(`   ↳ уступ: прыгать не беру (${l.drop}), с другой стороны опора есть — поворачиваю на ${l.other}`)
        dir = l.other
        continue
      }
      // Лесенка сама сказала, что дело не в направлении: остальные три стороны
      // ответят тем же. Читаем машинный флаг, а не русскую фразу.
      console.log(`   ↳ уступ: ни прыжка (${l.drop}), ни другой стороны — пробую колодцем`)
      let shaftExtra: Record<string, any> = {} as Record<string, any>
      let shaftPromise = null
      let shaftDug = 0
      let turnTo = null
      for (let s = 0; s < 3 && !shaftDug; s++) {
        const w: any = await step(`колодец ${Math.min(20, want)} (с ${(await pos()).y})${shaftExtra.maxFallHp ? ` hp≤${shaftExtra.maxFallHp}` : ''}`,
          'dig_down', { mode: 'shaft', depth: Math.min(20, want), timeoutSeconds: 240, ...shaftExtra })
        legs++
        const wd = w.detail || {} as Record<string, any>
        countGuard(w, wd, tally)
        if (died) return out(false, 'умер на спуске')
        // The shaft has the same guard and the same fields; its answer never
        // names a bearing (a shaft has none), so this is the fight or the end.
        if (wd.threat) {
          if (++guardRounds > GUARD_ROUNDS) return out(false, `страж останавливал ${guardRounds - 1} раз — дальше это спор об одном квадрате`)
          const g = await answerGuard(wd, null, tally)
          if (g.end) return out(false, g.end)
          if (g.dir) { turnTo = g.dir; break }
          s--
          continue
        }
        for (const j of wd.drops || []) {
          tally.drops.push(j)
          console.log(`   ↳ прыжок колодцем ${j.fell} бл. с y=${j.from.y}: цена ${j.cost} хп, заплачено ${j.paid}, осталось ${j.hp}`)
        }
        promise = shaftPromise
        if (broken(wd.ledge, 'shaft')) return out(false, 'отказ назвал ход, которого нет')
        promise = null
        // Колодец прошёл — дальше снова лесенкой: по ней возвращаются пешком, а
        // из колодца только через mc_surface.
        shaftDug = wd.dug || 0
        if (shaftDug) break
        if (!wd.ledge) return out(false, wd.stopped || 'ни лесенкой, ни колодцем')
        tally.ledges++
        const again = await takeDrop(wd.ledge, 'колодец')
        if (!again) {
          // No jump from here at all (lava, no floor, past any health): the
          // refusal names the staircase from this square, ledge.stairs, after
          // the fetch when there is nothing to prop with. Once per square.
          const key = `stairs@${wd.ledge.at.x},${wd.ledge.at.y},${wd.ledge.at.z}`
          if (!wd.ledge.stairs || once.has(key)) return out(false, wd.stopped)
          once.add(key)
          await fetchFor(wd.ledge, 'колодец')
          tally.taken++
          console.log(`   ↳ колодец: прыжка нет (${wd.ledge.drop}) — лесенкой на ${wd.ledge.stairs}, как назвал отказ`)
          turnTo = wd.ledge.stairs
          break
        }
        tally.taken++
        shaftExtra = again
        shaftPromise = { at: wd.ledge.at, mode: 'shaft', cost: wd.ledge.cost, sent: again.maxFallHp }
      }
      if (turnTo) { dir = turnTo; continue }
      if (!shaftDug) return out(false, 'колодец трижды не вкопался')
      stalled = 0
      continue
    }

    if (d.stopped) console.log(`   ↳ ${d.stopped} — меняю направление`)
    dir = BEARINGS[(BEARINGS.indexOf(dir) + 1) % BEARINGS.length]
    // Two legs in a row that cut nothing means turning is not helping either.
    stalled = (d.steps || 0) === 0 ? stalled + 1 : 0
    if (stalled >= 3) return out(false, d.stopped || 'лесенка не идёт')
  }
  return out(false, 'слишком много попыток')
}

// Reds only where the code is wrong. A named option that did not exist. A guard
// answer that names nothing or names back the bearing it just walled. And the
// underside — but only with a sample: build.js founds a step over a cave by
// placing against the bottom face of the block above, on a reading of Paper's
// bytecode that no run had confirmed, and one refusal is not evidence that the
// reading is wrong. Never tried, and tried too few times, are both printed as a
// measurement with its sample size, never as a pass and never as a verdict.
function descentVerdict (down) {
  const paid = down.drops.reduce((n, j) => n + (j.paid || 0), 0)
  const priced = down.drops.reduce((n, j) => n + (j.cost || 0), 0)
  console.log(`   уступов ${down.ledges}, взят названный ход ${down.taken}; ступенек на блоке ${down.bridged}, с подпоркой ${down.propped}; ` +
    `прыжков ${down.drops.length}: цена ${priced} хп, заплачено ${paid}`)
  console.log(`   страж: встреч ${down.guardMet} (заложился ${down.guardWalls}, пропустил ${down.guardPassed}), остановок ${down.guardStops} ` +
    `(боёв ${down.guardFights}, поворотов ${down.guardTurns}); ног с уроном ${down.damageLegs} из ${down.legs}, событий damage ${down.damageEvents}, ` +
    `из них ног без единой встречи ${down.damageUnanswered}`)
  const bad = down.deadEnds.length
  console.log(`   [${bad ? 'ПЛОХО' : ' OK '}] ни один ход, названный отказом, не вернул тот же отказ: тупиков ${bad} из ${down.taken} взятых`)
  const broken = down.guardBroken.length
  console.log(`   [${broken ? 'ПЛОХО' : ' OK '}] каждая остановка стража назвала выполнимый ход: противоречий ${broken} из ${down.guardStops} остановок`)
  const took = down.underside
  const refused = down.undersideRefused
  const tries = took + refused
  if (tries < UNDERSIDE_SAMPLE) {
    console.log(`   [ЗАМЕР] нижняя грань: принял ${took}, отказал ${refused} — попыток ${tries} из ${UNDERSIDE_SAMPLE} нужных, вердикта нет` +
      (tries ? '' : ' (ставить блок над пустотой не пришлось или было нечем)'))
  } else {
    const wrong = took === 0
    console.log(`   [${wrong ? 'ПЛОХО' : ' OK '}] нижняя грань: сервер принял ${took}, отказал ${refused} из ${tries} попыток` +
      (wrong ? ' — ни разу за всю выборку: подпорки под ступенькой на этом сервере не работают' : ''))
    if (wrong) process.exitCode = 1
  }
  if (bad || broken) process.exitCode = 1
}


ws.on('open', async () => {
  try {
    await call('connect')
    await outfit()
    await call('set_goal', { text: 'сходить за алмазами и вернуться живым' })

    const home = await pos()
    const ready: any = await call('status')
    // The run has to know it is standing where it thinks it is. Both ways this
    // went wrong before were silent: a fall that killed the bot mid-outfit, and
    // a respawn into a spawnpoint another scene had left behind.
    if (Math.abs(home.x - 120) > 8 || Math.abs(home.z - 120) > 8) {
      console.log(`НЕ НА АРЕНЕ: ждали ~120,?,120, стою на ${JSON.stringify(home)} — прогон отменён`)
      return
    }
    if (ready.state.health < 18) {
      console.log(`СТАРТ НА ${ready.state.health} ХП — прогон отменён, это измерит только смерть`)
      return
    }
    console.log('старт:', JSON.stringify(home), JSON.stringify(await inv()), '\n')

    console.log('--- вниз ---')
    const down = await descend(DIAMOND_Y)
    console.log('спуск:', JSON.stringify(down))
    descentVerdict(down)
    console.log('')
    if (died) {
      const st: any = await call('status')
      console.log(`УМЕР на ${JSON.stringify(died.at)} во время «${died.during}» — прогон окончен`)
      console.log('возродился:', JSON.stringify(st.state.pos), 'рюкзак:', JSON.stringify(st.state.inventory))
      const back: any = await step('сходить за лутом', 'recover', { timeoutSeconds: 200 })
      console.log('поход за лутом:', JSON.stringify(back.detail ?? back.error ?? null))
      return
    }
    if (!down.reached) console.log('(до алмазного уровня не дошёл — дальше всё равно бурим, это тоже данные)')

    console.log('--- штреки ---')
    const found: Record<string, any> = {} as Record<string, any>
    for (const dir of ['east', 'north', 'west']) {
      let r: any = await step(`штрек ${dir} 24`, 'tunnel',
        { direction: dir, length: 24, torchEvery: 8, timeoutSeconds: 240 })
      if (died) break
      if (r.detail && r.detail.stopped && await dealWithTool(r.detail.stopped)) {
        r = await step(`штрек ${dir} 24 (с новой киркой)`, 'tunnel',
          { direction: dir, length: 24, torchEvery: 8, timeoutSeconds: 240 })
      }
      if (r.detail && r.detail.stopped && await dealWith(r.detail.stopped, r.detail)) {
        r = await step(`штрек ${dir} 24 (снова)`, 'tunnel',
          { direction: dir, length: 24, torchEvery: 8, timeoutSeconds: 240 })
      }
      for (const o of (r.detail && r.detail.ores) || []) found[o.name] = (found[o.name] || 0) + o.count
      if (r.status !== 'done') break
    }
    console.log('руда в стенах:', JSON.stringify(found), '\n')

    // Забирать надо ПАМЯТЬЮ, а не глазами. `mine` смотрит с текущего места, а
    // к этому моменту тело стоит в конце третьего штрека — от жилы, вскрытой в
    // первом, до него полсотни блоков сплошной породы. Прошлый прогон так и
    // ответил: «не вижу deepslate_diamond_ore в радиусе 24 (смотрю честно)» —
    // при двенадцати записях в реестре руды. Штрек кладёт туда координату в
    // момент вскрытия стены, `mine_seen` по ней возвращается своим же
    // коридором (замерено: 0 ударов кирки на дорогу в 16 блоков).
    for (const ore of ['diamond_ore', 'deepslate_diamond_ore', 'iron_ore', 'deepslate_iron_ore']) {
      if (!found[ore]) continue
      const got: any = await step(`добыть по памяти ${ore}`, 'mine_seen',
        { block: ore, count: found[ore], timeoutSeconds: 180 })
      // Реестр отдаёт по одной жиле за вызов, а штрек мог вскрыть несколько.
      // Зовём, пока память отдаёт, но не больше трёх раз за породу: дальше это
      // уже не сбор урожая, а бесплатная трата минут на глубине.
      for (let more = 0; more < 2; more++) {
        if (!got || got.status !== 'done') break
        const left = (got.detail && got.detail.remembered) || 0
        if (!left) break
        await step(`добыть по памяти ${ore} (ещё)`, 'mine_seen',
          { block: ore, count: found[ore], timeoutSeconds: 180 })
      }
    }

    console.log('\n--- наверх ---')
    const before = await pos()
    // targetY is the floor of the climb now, not its contract: surface() ends
    // on "I am out of the hole", which is the question that was wrong before —
    // the shaft the bot dug has open sky over it the whole way down.
    for (let i = 0; i < 14; i++) {
      const up: any = await step(`подъём #${i + 1}`, 'surface', { targetY: home.y - 1, timeoutSeconds: 200 })
      if (died) break
      let refitted = false
      if (up.detail && up.detail.stopped) {
        refitted = await dealWithTool(up.detail.stopped)
        if (!refitted) await dealWith(up.detail.stopped, up.detail)
      }
      // A leg that stopped on tool budget climbs nothing by design, and the
      // stall guard below reads that as "the climb is over". It is the opposite:
      // the pickaxe is new and the same leg will now cut. Measured: the run
      // crafted its stone pickaxe at y=-35 and then walked away from the climb.
      if (refitted) continue
      if (up.status !== 'done') break
      const here = await pos()
      if (here.y >= home.y - 2) break
      if (up.detail && up.detail.climbed === 0) break
    }
    console.log(`подъём: ${before.y} -> ${(await pos()).y} (цель ${home.y})`)

    const end: any = await call('status')
    if (died || end.state.health === 0) {
      console.log(died
        ? `ПРОГОН КОНЧИЛСЯ СМЕРТЬЮ на ${JSON.stringify(died.at)} во время «${died.during}»`
        : 'ПРОГОН КОНЧИЛСЯ СМЕРТЬЮ (тело на нуле)')
    }
    console.log('\nитог: hp', end.state.health, JSON.stringify(end.state.pos))
    console.log('добыто:', JSON.stringify(end.state.inventory))
  } catch (e) {
    console.error('FAILED:', e.message)
    process.exitCode = 1
  } finally {
    ws.close()
  }
})
ws.on('error', e => { console.error('ws:', e.message); process.exitCode = 1 })
