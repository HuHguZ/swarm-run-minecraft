'use strict'
const gameClock = require('./src/game-clock')
// The strip mine, checked against ground truth instead of against a screenshot.
//
// Four things go wrong in a drift and all four are invisible from the outside:
//
//   1. the ore report quietly loses the walls that ended up behind the bot;
//   2. a dropped item pulls the body off the line and the corridor bends;
//   3. a mob shows up and the drift stops — leaving the body standing in an
//      open corridor for the 10-30s a brain turn costs. That is the sequence in
//      diamond4.log at y=-29 that ends "здоровья 0";
//   4. the drift refuses to continue and the refusal names no number, so the
//      brain cannot tell what to bring. ("dug: 0, walked: 4, нечем строить".)
//   5. the drift stops on a mob that cannot reach it — a skeleton behind five
//      blocks of untouched deepslate — and then answers the same sentence to
//      every call. That paralysed the y=-51 run at dug 0 / walked 0, four calls
//      running, and it is the one failure that looks like success in a log.
//      Its second shape is scenes 7 and 8: a zombie under a one-block floor,
//      and a zombie that sees the bot across a moat it cannot cross.
//
// So every arena here is built out of blocks whose coordinates this file knows
// in advance, and every scene compares the answer to that list rather than to
// an impression. /fill only works in loaded chunks and refuses over 32768
// blocks, so the bot is teleported into each lane first and every volume is
// small. /clear @s comes first every time: /give into a full backpack drops the
// item on the ground and the next hour goes into wondering where the pickaxe is.
const WebSocket = require('ws')

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

async function cmd (text) {
  await call('say', { text })
  await sleep(600)
}

async function step (label, method, params) {
  const r: any = await call(method, params).catch(e => ({ status: 'RPC', error: e.message }))
  const problem = r.status === 'failed' ? ` ← ${r.error}` : r.status === 'timeout' ? ' ← таймаут' : ''
  console.log(`${label.padEnd(26)} ${String(r.status).padEnd(11)} ${JSON.stringify(r.detail ?? null)}${problem}`)
  if (r.by) console.log(`${''.padEnd(26)} прервано: ${r.by.type}`)
  return r
}

// ---------------------------------------------------------------- verdicts

let failures = 0
let skipped = 0
function check (label, ok, note = '') {
  if (!ok) failures++
  console.log(`  ${ok ? 'ok  ' : 'ПЛОХО'} ${label}${note ? ' — ' + note : ''}`)
}

// "The code did the wrong thing" and "we failed to set the experiment up" are
// different news, and a scene that prints them the same way costs an afternoon
// of arguing about the wrong bug. Three of those in one day is what put this
// here, all three the same cause: the body entered a case already bleeding.
function skip (label, why) {
  skipped++
  console.log(`  ПРОП  ${label} — ${why}`)
}

let caseName = ''
function header (name) {
  caseName = name
  console.log('\n=== ' + name + ' ===')
}

// The gate every case goes through. Below 18 hp the drift correctly refuses to
// dig at all and says so — and then every check about threat, drift and sealed
// goes red for a reason that has nothing to do with the code under test.
// Measured: case 3 entered on 5 hp and case 3b on 3, both bled dry by the case
// before them, and between them they produced twelve red lines and no
// information at all.
async function ready () {
  const st: any = await call('status')
  if (st.state.health >= 18) return true
  skip(caseName, `вошёл с ${st.state.health} хп — опыт не поставлен, а не провален`)
  return false
}

// ---------------------------------------------------------------- the arena

// Four parallel lanes, far from every other scene's arena (-26..-4, 190..210,
// 300..329, 400..416) so a leftover from one run cannot be mistaken for terrain
// in another.
const LANES = { ore: 600, drop: 610, mob: 620, pit: 630, rock: 640, path: 650, under: 660, moat: 670 }
const X0 = 600 // the mouth: where the bot stands when the drift starts
const Y = 50
const LEN = 24 // cells X0+1 .. X0+24

// A block of solid rock around one lane. 47 x 17 x 7 = 5593 blocks, well under
// the 32768 /fill refuses past, and it is filled only after the bot is standing
// in the middle of it — /fill into unloaded chunks fails silently and half the
// "controlled" arenas in this project turned out to be ordinary hillside.
async function base (lane, material = 'stone') {
  await call('stop')
  await sleep(800)
  await cmd('/kill @e[type=!player]')
  await cmd('/gamerule spawn_mobs false')
  await cmd('/gamerule advance_time false')
  await cmd('/difficulty normal')
  await cmd(`/tp @s ${X0 + 17} ${Y} ${lane}`)
  // @e видит только прогруженные чанки, поэтому чистить арену можно
  // только стоя в ней: kill до /tp вычищает ту, из которой уходим.
  await cmd('/kill @e[type=!player]')
  await sleep(3000) // chunks
  await cmd(`/fill ${X0 - 6} ${Y - 8} ${lane - 3} ${X0 + 40} ${Y + 8} ${lane + 3} minecraft:${material}`)
}

async function equip (gives) {
  await cmd('/clear @s')
  for (const g of gives) await cmd(`/give @s ${g}`)
}

// Health is spent by the case before this one — the zombie in case 3 does not
// stop swinging just because the intent returned, and the fifteen-second pause
// is fifteen seconds of it. Regeneration alone does not always finish before
// the bell (two hp is one zombie hit, which is enough to decide a whole case),
// so instant_health finishes the job and a warning is printed if even that
// does not. Same scheme as try-corridor.js, which learned it the same way.
async function topUp () {
  await cmd('/effect give @s minecraft:regeneration 20 5 true')
  await sleep(5000)
  // Cleared rather than left running: regeneration during case 3's pause would
  // paper over exactly the damage that pause exists to detect.
  await cmd('/effect clear @s')
  for (let i = 0; i < 3; i++) {
    const st: any = await call('status')
    if (st.state.health >= 20) return
    await cmd('/effect give @s minecraft:instant_health 1 10 true')
    await sleep(700)
  }
  const st: any = await call('status')
  if (st.state.health < 20) console.log(`  ВНИМАНИЕ: старт с ${st.state.health} хп, а не с 20`)
}

// Returns false when the case cannot be run honestly. That is not the same as
// the case failing, and the two must not look alike in the output.
async function standAtMouth (lane) {
  await cmd(`/tp @s ${X0}.5 ${Y} ${lane}.5`)
  await sleep(2500)
  await topUp()
  return ready()
}

// ---------------------------------------------------------------- 1. ore

// Ore is placed in the walls, floor and ceiling of cells the drift has not cut
// yet, at coordinates written down here. Most types appear exactly once, so
// `nearest` in the report is a single block and can be compared coordinate for
// coordinate; coal and iron appear more than once, which is what checks the
// count. Nothing is put in the path of the drift itself: a block that gets
// mined turns into a drop and stops being ground truth.
const ORE = [
  // [x, y, dz from the axis, block]
  [602, 50, -1, 'coal_ore'], //  two blocks in: by the end of a 24-block drift
  [602, 51, 1, 'coal_ore'], //   this is 22 blocks behind the body, which is
  [605, 50, -1, 'coal_ore'], //  exactly the ore the old report lost
  [604, 49, 0, 'lapis_ore'], //  floor
  [608, 50, 1, 'iron_ore'],
  [609, 49, 0, 'iron_ore'], //   floor
  [612, 52, 0, 'copper_ore'], // ceiling
  [616, 50, -1, 'gold_ore'],
  [620, 51, -1, 'redstone_ore'],
  [623, 50, 1, 'diamond_ore']
]

// Fog of war, stated as blocks. Neither of these ever gets a face on a cell the
// drift opens, so an honest report does not contain them — findBlocks reads
// both straight out of chunk memory and would.
const HIDDEN = [
  [610, 50, -2, 'coal_ore'], //   one block deeper than the wall we open
  [630, 50, 0, 'emerald_ore'] //  six blocks past the far end of the drift
]

async function sceneOre () {
  const lane: any = LANES.ore
  header('1. руда в стенах: отчёт против списка')
  await base(lane)
  for (const [x, y, dz, block] of [...ORE, ...HIDDEN]) {
    await cmd(`/setblock ${x} ${y} ${lane + dz} minecraft:${block}`)
  }
  await cmd(`/fill ${X0} ${Y} ${lane} ${X0} ${Y + 1} ${lane} minecraft:air`) // the mouth
  await equip(['minecraft:iron_pickaxe 3', 'minecraft:torch 16', 'minecraft:cooked_beef 8'])
  if (!(await standAtMouth(lane))) return

  const r: any = await step(`штрек east ${LEN}`, 'tunnel',
    { direction: 'east', length: LEN, timeoutSeconds: 240 })
  const d = r.detail
  if (!d) { check('штрек вообще отработал', false); return }

  const want = new Map()
  for (const [x, y, dz, block] of ORE) {
    if (!want.has(block)) want.set(block, [])
    want.get(block).push({ x, y, z: lane + dz })
  }
  const got = new Map(d.ores.map(o => [o.name, o]))

  check(`штрек прошёл ${LEN} блоков`, d.walked === LEN, `walked=${d.walked} stopped=${d.stopped || '-'}`)
  check('с оси не сносило', d.offAxis === 0, `offAxis=${d.offAxis}`)
  check('ось z не поехала', d.to.z === d.from.z, `${d.from.z} -> ${d.to.z}`)

  for (const [name, spots] of want) {
    const o: any = got.get(name)
    if (!o) { check(`${name}: найдено`, false, `ждали ${spots.length}, в отчёте нет`); continue }
    check(`${name}: ${spots.length} шт`, o.count === spots.length, `в отчёте ${o.count}`)
    const match = spots.find(s => s.x === o.nearest.x && s.y === o.nearest.y && s.z === o.nearest.z)
    check(`${name}: nearest — реальный блок`, !!match,
      `отчёт ${JSON.stringify(o.nearest)}, истина ${JSON.stringify(spots)}`)
    if (match) {
      const f = d.from
      const truth = Math.round(Math.hypot(match.x - f.x, match.y - f.y, match.z - f.z) * 10) / 10
      check(`${name}: fromMouth`, Math.abs(o.fromMouth - truth) <= 0.15, `${o.fromMouth} против ${truth}`)
    }
  }
  for (const [x, y, dz, block] of HIDDEN) {
    const o: any = got.get(block)
    const leaked = o && want.has(block) ? o.count > want.get(block).length : !!o
    check(`скрытая ${block} на ${x},${y},${lane + dz} не в отчёте`, !leaked,
      o ? `в отчёте ${o.count} шт` : '')
  }
  console.log('  руда:', JSON.stringify(d.ores))
}

// ---------------------------------------------------------------- 2. drops

// One item lying on the line and two lying off it, two blocks into side
// pockets. Two blocks deep, not one: the server hands over anything within a
// block of the body all by itself, and a bait the bot cannot help picking up
// proves nothing about whether it chose to walk over.
//
// The first four cells are cut in advance and the on-axis bait sits in the
// fourth. The version that put that bait one block *behind* the mouth measured
// nothing at all: the drift runs east from X0 and never passes that square, so
// the gold stayed on the floor and the check read it as a lost drop.
async function sceneDrop () {
  const lane = LANES.drop
  header('2. дроп в стороне: штрек не должен за ним ходить')
  await base(lane)
  await cmd(`/fill ${X0} ${Y} ${lane} ${X0 + 4} ${Y + 1} ${lane} minecraft:air`) // mouth + four cells
  for (const [x, dz] of [[606, -1], [606, -2], [614, 1], [614, 2]]) {
    await cmd(`/setblock ${x} ${Y} ${lane + dz} minecraft:air`)
  }
  await equip(['minecraft:iron_pickaxe 3', 'minecraft:torch 16', 'minecraft:cooked_beef 8'])
  if (!(await standAtMouth(lane))) return

  // Distinct item types, so `gained` says which bait was taken without any
  // guessing: cobblestone in the bag is the drift's own rubble.
  await cmd(`/summon minecraft:item ${X0 + 4}.5 ${Y}.2 ${lane}.5 {Item:{id:"minecraft:gold_ingot",count:1}}`)
  await cmd(`/summon minecraft:item 606.5 ${Y}.2 ${lane - 2}.5 {Item:{id:"minecraft:diamond",count:1}}`)
  await cmd(`/summon minecraft:item 614.5 ${Y}.2 ${lane + 2}.5 {Item:{id:"minecraft:emerald",count:1}}`)
  await sleep(2500) // the stacks have to land and reach the bot's entity list

  const seen = await call('observe', { radius: 24, fair: false }).catch(() => null)
  const ents = (seen && seen.detail && seen.detail.entities) || []
  // observe() reports username || displayName || name, and a dropped stack
  // answers that with its display name — "Gold Ingot", never "item". The first
  // version of this counter looked for "item" and printed 0 while the server
  // had already answered "Summoned new Gold Ingot" to all three commands.
  const baits = ents.filter(e => /item|ingot|diamond|emerald/i.test(`${e.name} ${e.kind}`)).length
  check('приманки на месте', baits >= 3, `видно предметов: ${baits} из ${JSON.stringify(ents)}`)

  const r: any = await step(`штрек east ${LEN}`, 'tunnel',
    { direction: 'east', length: LEN, timeoutSeconds: 240 })
  const d = r.detail
  if (!d) { check('штрек вообще отработал', false); return }

  check('с оси не сносило', d.offAxis === 0, `offAxis=${d.offAxis}`)
  check('ось z не поехала', d.to.z === d.from.z, `${d.from.z} -> ${d.to.z}`)
  check('дроп на оси подобран', d.gained.gold_ingot >= 1, `gained=${JSON.stringify(d.gained)}`)
  check('дроп слева оставлен лежать', !d.gained.diamond)
  check('дроп справа оставлен лежать', !d.gained.emerald)
  check('брошенное посчитано', d.leftBehind >= 2, `leftBehind=${d.leftBehind}`)
}

// ---------------------------------------------------------------- 3. the mob

// The corridor is cut in advance and the zombie is put down the far end of it,
// because the point is not the digging. This is the diamond4.log shape exactly:
// an open 1x2 drift, a hostile walking up it, and a body that used to be left
// standing there while the brain thought. After the intent answers, the scene
// does nothing at all for fifteen seconds — that idle window is the test.
//
// The two runs are judged differently on purpose. With blocks in the bag the
// wall is the answer and survival is the verdict. With an empty bag there is no
// answer the drift can give on its own — retreating from melee is measured
// dead — so the verdict is only that it handed the decision back at once and
// spent none of the brain's seconds walking.
async function sceneMob (label, gives, expectSealed) {
  const lane = LANES.mob
  header(`3. зомби в штреке: ${label}`)
  await base(lane)
  await cmd(`/fill ${X0 - 2} ${Y} ${lane} ${X0 + 40} ${Y + 1} ${lane} minecraft:air`)
  await equip(gives)
  if (!(await standAtMouth(lane))) return
  await cmd(`/summon minecraft:zombie ${X0 + 15}.5 ${Y} ${lane}.5 {PersistenceRequired:1b}`)
  await sleep(800)

  const before: any = await call('status')
  const t0 = gameClock.now()
  const r: any = await step(`штрек east ${LEN}`, 'tunnel',
    { direction: 'east', length: LEN, timeoutSeconds: 90 })
  const answeredIn = gameClock.now() - t0
  const d = r.detail
  const afterIntent: any = await call('status')

  // The brain's think time, spent exactly the way the brain spends it: not
  // touching the body. Under the old code this is where the zombie ate it.
  //
  // A respawn reads as "hp 20" from the outside, and the first version of this
  // scene scored one as a recovery and printed ok: the bot had died at
  // 598,50,620 and come back at world spawn with full health. So a death is
  // judged by the death event and by the body leaving the arena, never by the
  // health number. status() drains the event bus, so the events arrive here.
  const home = afterIntent.state.pos
  const track = []
  let died = (r.events || []).some(e => e.type === 'death') || !!(r.by && r.by.type === 'death')
  // The lowest health seen, not the health at the end. Natural regeneration
  // runs at a full food bar and gives back about three hp over fifteen seconds
  // — enough to hide a zombie hit completely if only the endpoints are compared.
  let minHp = afterIntent.state.health
  for (let i = 0; i < 15; i++) {
    await sleep(1000)
    try {
      const res: any = await call('status')
      const st = res.state
      if ((res.events || []).some(e => e.type === 'death')) died = true
      // Nothing in this arena moves the body more than a few blocks. A jump of
      // twenty-four is a teleport, and the only teleport here is a respawn.
      if (Math.abs(st.pos.x - home.x) > 24 || Math.abs(st.pos.z - lane) > 8) died = true
      if (!died) minHp = Math.min(minHp, st.health)
      track.push(`${st.health}@${st.pos.x},${st.pos.z}`)
    } catch {}
  }
  const after: any = await call('status')

  console.log('  пауза мозга:', track.join(' '))
  console.log(`  ответ за ${(answeredIn / 1000).toFixed(1)}с | hp ${before.state.health} -> ${afterIntent.state.health} (интент) -> ${after.state.health} (через 15с, минимум ${minHp}) | умер: ${died ? 'ДА' : 'нет'}`)
  if (!d) { check('штрек вообще отработал', false); return }

  check('доложил про моба', !!d.threat, `threat=${JSON.stringify(d.threat)}`)
  check('в stopped есть моб, дистанция и что сделано',
    !!d.stopped && /зомби|zombie/.test(d.stopped) && /блок/.test(d.stopped), d.stopped)
  check('узнал форму земли: это штрек 1×2', !!(d.threat && d.threat.drift === true),
    JSON.stringify(d.threat))
  if (expectSealed) {
    check('запечатался', !!(d.threat && d.threat.sealed), JSON.stringify(d.threat))
    // The corridor was carved in advance, so a seal that placed nothing would
    // mean the bot claimed a wall the arena had already given it.
    check('стена реально построена', !!(d.threat && d.threat.placed >= 1),
      `placed=${d.threat && d.threat.placed}`)
    check('пережил паузу мозга без единого удара', !died && minHp >= afterIntent.state.health,
      died ? 'умер и возродился' : `${afterIntent.state.health} -> минимум ${minHp}`)
  } else {
    check('честно сказал, что не запечатался', !!(d.threat && d.threat.sealed === false))
    check('назвал, чего не хватило', !!d.need, JSON.stringify(d.need))
    check('сказал, что повтор бесполезен', !!d.note && /то же самое/.test(d.note), d.note)
    check('назвал землю в тексте', !!d.stopped && /штрек 1×2|не в штреке/.test(d.stopped), d.stopped)
    // Backing away from melee is measured dead: seven blocks off a zombie ended
    // in a grave at 598,50,620. The drift no longer tries, so the only thing it
    // owes the brain here is speed — mc_fight has to still be an option by the
    // time the answer lands.
    check('не пошёл гулять от моба', !(d.threat && d.threat.retreatedTo),
      JSON.stringify(d.threat && d.threat.retreatedTo))
    check('ответил сразу, а не через отход', answeredIn < 12000, `${(answeredIn / 1000).toFixed(1)}с`)
    // Nothing in this branch protects the body and nothing is meant to: with no
    // brain answering, dying here is the expected end and is data, not a
    // verdict. The verdict would be the drift spending those seconds itself.
    console.log(`  (мозг не ответил, поэтому бот ${died ? 'погиб — так и должно читаться' : 'выжил'})`)
  }
  await cmd('/kill @e[type=zombie]')
}

// ------------------------------------------------- 4. a mob that cannot reach

// The case that stopped the y=-51 expedition dead. A skeleton five blocks off
// behind untouched deepslate is within any distance-based alarm, and the drift
// used to stop on it — four calls in a row, dug 0, walked 0, the same sentence
// every time. It is not a threat: it has no line of sight and it is not in the
// tube the pickaxe is pointing at. The drift owes it nothing but a mention.
//
// The pocket is dug *under* the corridor rather than beside it, so the arena
// stays inside the 47x17x7 block base() fills and nothing leaks into real
// terrain — the mistake that made half this project's earlier arenas worthless.
async function sceneRockBetween () {
  const lane = LANES.rock
  header('4. скелет за породой сбоку: штрек обязан идти')
  await base(lane)
  await cmd(`/fill ${X0} ${Y} ${lane} ${X0} ${Y + 1} ${lane} minecraft:air`)
  await cmd(`/fill 608 ${Y - 5} ${lane - 1} 611 ${Y - 3} ${lane + 1} minecraft:air`) // sealed pocket, 3 high
  await equip(['minecraft:iron_pickaxe 3', 'minecraft:cobblestone 64', 'minecraft:torch 16',
    'minecraft:cooked_beef 8'])
  if (!(await standAtMouth(lane))) return
  await cmd(`/summon minecraft:skeleton 609.5 ${Y - 5} ${lane}.5 {PersistenceRequired:1b}`)
  await sleep(1200)

  const r: any = await step(`штрек east ${LEN}`, 'tunnel',
    { direction: 'east', length: LEN, timeoutSeconds: 240 })
  const d = r.detail
  if (!d) { check('штрек вообще отработал', false); return }

  check('штрек прошёл насквозь', d.walked === LEN, `walked=${d.walked} stopped=${d.stopped || '-'}`)
  check('копал, а не стоял', d.dug > 0, `dug=${d.dug}`)
  check('не принял скелета за угрозу', !d.threat, JSON.stringify(d.threat))
  check('не встал', !d.stopped, d.stopped)
  // Without this the test would pass just as well if the skeleton never loaded.
  check('но скелета заметил и назвал фоном', !!(d.behindRock && /skeleton/.test(d.behindRock.mob)),
    JSON.stringify(d.behindRock))
  await cmd('/kill @e[type=skeleton]')
}

// ------------------------------------- 5. a mob the drift is digging towards

// The other half of the same judgement. Rock between us means nothing when the
// rock is what we are swinging at: the drift would open its own wall onto the
// skeleton. It has to stop — and, because stopping here answers identically
// every time it is called from this square, it has to say so and name the ways
// out. Four identical refusals is a hang, not a refusal.
async function sceneMobAhead () {
  const lane = LANES.path
  header('5. скелет в забое за породой: звать снова бесполезно')
  await base(lane)
  await cmd(`/fill ${X0} ${Y} ${lane} ${X0} ${Y + 1} ${lane} minecraft:air`)
  await cmd(`/fill 610 ${Y} ${lane - 1} 612 ${Y + 1} ${lane + 1} minecraft:air`) // sealed room on the axis
  await equip(['minecraft:iron_pickaxe 3', 'minecraft:cobblestone 64', 'minecraft:torch 16',
    'minecraft:cooked_beef 8'])
  if (!(await standAtMouth(lane))) return
  await cmd(`/summon minecraft:skeleton 611.5 ${Y} ${lane}.5 {PersistenceRequired:1b}`)
  await sleep(1200)

  const r: any = await step(`штрек east ${LEN}`, 'tunnel',
    { direction: 'east', length: LEN, timeoutSeconds: 240 })
  const d = r.detail
  if (!d) { check('штрек вообще отработал', false); return }

  check('успел покопать до отказа', d.walked >= 3 && d.dug > 0, `walked=${d.walked} dug=${d.dug}`)
  check('встал именно на скелете', !!(d.threat && /skeleton/.test(d.threat.mob)), d.stopped)
  check('понял, что копает в его сторону', !!(d.threat && d.threat.inPath === true),
    JSON.stringify(d.threat))
  check('порода между нами названа', !!(d.threat && d.threat.rockBetween === true))
  // The exact lie that made the y=-51 log unreadable: sealed true, placed zero.
  check('не приписал себе стену', !!(d.threat && d.threat.sealed === undefined),
    `sealed=${d.threat && d.threat.sealed} placed=${d.threat && d.threat.placed}`)
  check('сказал, что повтор бесполезен', !!d.note && /не изменится|бесполезно/.test(d.note), d.note)
  check('назвал свободные направления', !!d.note && /свободно: /.test(d.note), d.note)
  await cmd('/kill @e[type=skeleton]')
}

// Where a mob of this kind stands now, read from the server's entity list
// rather than assumed from the summon: «моба нет» is a broken arena, and a mob
// that has left the cell it was shut in has left the case with it.
async function mobCell (kind) {
  const seen = await call('observe', { radius: 24, fair: false }).catch(() => null)
  const ents = (seen && seen.detail && seen.detail.entities) || []
  return ents.find(e => new RegExp(kind, 'i').test(e.name)) || null
}
const inCell = (e, x, y, z) => !!e && e.pos.x === x && e.pos.y === y && e.pos.z === z

// ------------------------------------- 7. a zombie under a one-block floor

// run-surface-diamond.log 244-257, rebuilt with coordinates this file knows. At
// y=1 over a cave the drift stopped six calls in a row on mobs in the cave under
// its floor — the last a zombie three blocks straight down through ONE block —
// and mine_seen then refused three times with «zombie в 3 блоках вплотную».
// That last zombie is the case the log proves: its wall did not close, and it
// stayed in its cell through three errands and the climb without reaching the
// bot (the earlier stops all ended behind a wall that did close, so they prove
// nothing either way — see reach.js). Both guards asked «within 3 blocks, or a
// ray that forgives 1.2 blocks at the target», and one block of floor over a
// zombie passed both. Now both ask reach.reachOf: can it walk to a square it
// hits me from, or shoot me along a clear line.
//
// A one-cell, two-high pocket straight under the floor with the zombie shut in
// it — one cell on purpose: a zombie that can wander can walk out of the case,
// and then the old code would pass it too. The errand goes first and stands on
// its own: a four-block drift with no mob about writes down the iron ore in its
// wall, the zombie is summoned under that cell, and mine_seen is asked from
// straight above it — three blocks, the log's number. Then the full drift from
// the mouth, over the same zombie. Run offline against the pre-fix mining.js the
// errand answers «zombie в 3 блоках вплотную — добор бросил, взято 0» and the
// drift stops at walked 0: the checks below are red on exactly those two.
async function sceneUnderFloor () {
  const lane = LANES.under
  const P = X0 + 3 // the column over the pocket
  header('7. зомби под полом в один блок: добор и штрек обязаны идти')
  await base(lane)
  await cmd(`/fill ${X0} ${Y} ${lane} ${X0} ${Y + 1} ${lane} minecraft:air`)
  await cmd(`/fill ${P} ${Y - 3} ${lane} ${P} ${Y - 2} ${lane} minecraft:air`) // floor Y-1 stays
  await cmd(`/setblock ${P} ${Y} ${lane - 1} minecraft:iron_ore`)
  await equip(['minecraft:iron_pickaxe 3', 'minecraft:cobblestone 64', 'minecraft:torch 16',
    'minecraft:cooked_beef 8'])
  if (!(await standAtMouth(lane))) return

  // The memory, made with no mob in the world. Not a verdict on the guard:
  // scene 1 judges the ore report, and without the memory there is no errand.
  const first: any = await step('штрек east 4 (без моба)', 'tunnel', { direction: 'east', length: 4, timeoutSeconds: 60 })
  const ore = ((first.detail && first.detail.ores) || []).find(o => o.name === 'iron_ore')
  if (!ore) { skip(caseName, `руду из стены ${P},${Y},${lane - 1} штрек не записал: ${JSON.stringify(first.detail && first.detail.ores)}`); return }

  await cmd(`/tp @s ${P}.5 ${Y} ${lane}.5`)
  await cmd(`/summon minecraft:zombie ${P}.5 ${Y - 3} ${lane}.5 {PersistenceRequired:1b,IsBaby:0b}`)
  await sleep(1500)
  const z0 = await mobCell('zombie')
  if (!inCell(z0, P, Y - 3, lane)) {
    skip(caseName, `зомби в кармане ${P},${Y - 3},${lane} нет (${JSON.stringify(z0 && z0.pos)}) — арена не поставлена`)
    return
  }
  const m: any = await step('добыть по памяти iron_ore', 'mine_seen',
    { at: { x: P, y: Y, z: lane - 1 }, timeoutSeconds: 60 })
  const md = m.detail
  if (!md) { check('добор вообще отработал', false, m.error || m.status); return }
  check(`добор не бросил из-за зомби в ${z0.dist} бл. под ногами`, !md.mob && !/добор бросил/.test(md.stopped || ''),
    `stopped=${md.stopped || '-'} mob=${JSON.stringify(md.mob)}`)
  check(`добыл: dug ${md.dug} из 1`, md.dug === 1, `status=${md.status}`)
  check('назвал его фоном и в доборе: behindRock снизу', !!(md.behindRock && md.behindRock.where === 'снизу'),
    JSON.stringify(md.behindRock))

  // The drift, from the mouth over the same zombie.
  if (!(await standAtMouth(lane))) return
  const z1 = await mobCell('zombie')
  if (!inCell(z1, P, Y - 3, lane)) {
    skip('штрек над зомби', `зомби ушёл из кармана: ${JSON.stringify(z1 && z1.pos)}`)
    return
  }
  const r: any = await step(`штрек east ${LEN}`, 'tunnel',
    { direction: 'east', length: LEN, timeoutSeconds: 240 })
  const d = r.detail
  if (!d) { check('штрек вообще отработал', false); return }
  check(`штрек прошёл над зомби насквозь: walked ${d.walked} из ${LEN}`, d.walked === LEN,
    `stopped=${d.stopped || '-'}`)
  check('не встал из-за зомби под полом', !d.threat, JSON.stringify(d.threat))
  check('назвал его фоном: behindRock zombie снизу', !!(d.behindRock && /zombie/.test(d.behindRock.mob) &&
    d.behindRock.where === 'снизу'), JSON.stringify(d.behindRock))
  await cmd('/kill @e[type=zombie]')
}

// ------------------------------------- 8. across a moat, in plain sight

// The shape run-surface-diamond.log 244-250 may have had: walls built against
// zombies that could see the bot through a hole into the cave. Whether they had
// a way up the log cannot say — every one of those calls ended behind a wall
// that closed — so this arena builds the case where they did not, on purpose.
// Sight is the question for an arrow; for a walker it is whether there is a
// way. So one arena, two mobs: a cave opening off the side of the drift, a moat
// three wide and six deep, and a one-cell island across it, all inside rock this
// scene fills itself. On the island a zombie sees every cell from walked 6 to
// 12 and cannot get off — the drift owes it a mention and nothing else. A
// skeleton on the same cell needs nothing but that sight — the drift must stop,
// say «стреляет», and wall itself off.
//
// Run offline against the pre-fix mining.js the zombie stops the drift at
// walked 6 with «заложился», which is the log's sentence. The skeleton stops
// both versions; what makes that half able to go red is a guard that goes
// blind, and offline a reach.js with ranged mobs asked only the walker's
// question walks the drift straight past it.
async function sceneMoat (who) {
  const lane = LANES.moat
  header(`8. ${who} на островке за рвом, на виду: ${who === 'zombie' ? 'штрек обязан идти' : 'штрек обязан встать'}`)
  await base(lane)
  // base() fills lane±3; the cave side needs six more rows of rock of its own.
  await cmd(`/fill ${X0 - 6} ${Y - 8} ${lane + 4} ${X0 + 40} ${Y + 8} ${lane + 9} minecraft:stone`)
  await cmd(`/fill ${X0} ${Y} ${lane} ${X0} ${Y + 1} ${lane} minecraft:air`)
  await cmd(`/fill ${X0 + 6} ${Y} ${lane + 1} ${X0 + 13} ${Y + 2} ${lane + 7} minecraft:air`) // the cave, open onto the drift
  await cmd(`/fill ${X0 + 6} ${Y - 6} ${lane + 2} ${X0 + 13} ${Y - 1} ${lane + 7} minecraft:air`) // the moat
  await cmd(`/fill ${X0 + 9} ${Y - 6} ${lane + 5} ${X0 + 9} ${Y - 1} ${lane + 5} minecraft:stone`) // the island
  await equip(['minecraft:iron_pickaxe 3', 'minecraft:cobblestone 64', 'minecraft:torch 16',
    'minecraft:cooked_beef 8', 'minecraft:iron_helmet 1', 'minecraft:iron_chestplate 1'])
  if (!(await standAtMouth(lane))) return
  await cmd(`/summon minecraft:${who} ${X0 + 9}.5 ${Y} ${lane + 5}.5 {PersistenceRequired:1b${who === 'zombie' ? ',IsBaby:0b' : ''}}`)
  await sleep(1500)
  const m0 = await mobCell(who)
  if (!inCell(m0, X0 + 9, Y, lane + 5)) {
    skip(caseName, `${who} на островке ${X0 + 9},${Y},${lane + 5} нет (${JSON.stringify(m0 && m0.pos)}) — арена не поставлена`)
    return
  }

  const r: any = await step(`штрек east ${LEN}`, 'tunnel',
    { direction: 'east', length: LEN, timeoutSeconds: 240 })
  const d = r.detail
  if (!d) { check('штрек вообще отработал', false); return }
  const m1 = await mobCell(who)
  if (!inCell(m1, X0 + 9, Y, lane + 5)) {
    skip(caseName, `${who} ушёл с островка за время штрека: ${JSON.stringify(m1 && m1.pos)} — видимости могло не быть`)
    await cmd(`/kill @e[type=${who}]`)
    return
  }
  if (who === 'zombie') {
    check(`штрек прошёл мимо: walked ${d.walked} из ${LEN}`, d.walked === LEN, `stopped=${d.stopped || '-'}`)
    check('не встал из-за зомби, которому не пройти', !d.threat, JSON.stringify(d.threat))
    // The last look inside the six-block radius is from walked 12, and from
    // there the line to the island runs through the opening: «видит меня» is
    // what proves the case had sight in it at all.
    check('назвал его фоном, и он меня видел: behindRock «видит меня»', !!(d.behindRock &&
      d.behindRock.mob === 'zombie' && /видит меня/.test(d.behindRock.why || '')), JSON.stringify(d.behindRock))
  } else {
    const t = d.threat || {} as Record<string, any>
    check(`встал на скелете: walked ${d.walked}, dist ${t.dist}`, /skeleton/.test(t.mob || '') && d.walked < LEN,
      `stopped=${d.stopped || '-'}`)
    check('назвал, чем достаёт: стреляет, пути нет', t.how === 'стреляет' && t.steps === undefined,
      `how=${t.how} steps=${t.steps}`)
    check(`заложился: sealed ${t.sealed}, placed ${t.placed}`, t.sealed === true && t.placed >= 1, JSON.stringify(t))
  }
  await cmd(`/kill @e[type=${who}]`)
}

// ---------------------------------------------------------------- 6. the pit

// A drift over a void with nothing to bridge it. The body of this one is glass
// on purpose: glass drops nothing when it breaks, and that is the only way to
// keep the backpack genuinely empty — a stone drift fills it with its own
// cobblestone by the second cell and then bridges the hole itself.
async function scenePit () {
  const lane = LANES.pit
  header('6. обрыв под ногами с пустым рюкзаком')
  await base(lane)
  await cmd(`/fill ${X0 - 1} ${Y - 2} ${lane - 1} ${X0 + 40} ${Y + 3} ${lane + 1} minecraft:glass`)
  await cmd(`/fill ${X0} ${Y} ${lane} ${X0} ${Y + 1} ${lane} minecraft:air`)
  // The void starts under the fourth cell, so the drift walks three blocks and
  // then meets it — walked 4 with dug 0 is the line from the log this reproduces.
  await cmd(`/fill ${X0 + 4} ${Y - 10} ${lane - 1} ${X0 + 40} ${Y - 1} ${lane + 1} minecraft:air`)
  await equip(['minecraft:iron_pickaxe 1', 'minecraft:torch 8'])
  if (!(await standAtMouth(lane))) return

  const r: any = await step(`штрек east ${LEN}`, 'tunnel',
    { direction: 'east', length: LEN, timeoutSeconds: 90 })
  const d = r.detail
  if (!d) { check('штрек вообще отработал', false); return }

  check('дошёл до обрыва и встал', d.walked === 3, `walked=${d.walked}`)
  check('в отказе есть число', !!d.stopped && /нужно ~\d+/.test(d.stopped), d.stopped)
  check('в отказе есть остаток рюкзака', !!d.stopped && /в рюкзаке 0/.test(d.stopped), d.stopped)
  check('машинный need заполнен', !!d.need && d.need.have === 0 && d.need.count === LEN - 3,
    JSON.stringify(d.need))
  check('сказал, сколько осталось пройти', d.remaining === LEN - 3, `remaining=${d.remaining}`)
}

// ----------------------------------------------------------------

ws.on('open', async () => {
  try {
    await call('connect')
    await sceneOre()
    await sceneDrop()
    await sceneMob('есть чем закрыться',
      ['minecraft:iron_pickaxe 1', 'minecraft:cobblestone 64', 'minecraft:torch 16',
        'minecraft:iron_helmet 1', 'minecraft:iron_chestplate 1'], true)
    await sceneMob('закрыться нечем',
      ['minecraft:iron_pickaxe 1', 'minecraft:torch 16',
        'minecraft:iron_helmet 1', 'minecraft:iron_chestplate 1'], false)
    await sceneRockBetween()
    await sceneMobAhead()
    await sceneUnderFloor()
    await sceneMoat('zombie')
    await sceneMoat('skeleton')
    await scenePit()

    await cmd('/kill @e[type=!player]')
    // Two numbers, never one: a skipped case is an experiment we failed to set
    // up, and reading it as a failed check is what cost three separate
    // investigations into bugs that were not there.
    console.log(`\nитог: ${failures ? failures + ' проверок не прошло' : 'все проверки прошли'}` +
      (skipped ? `, ${skipped} случаев НЕ ПОСТАВЛЕНО (не путать с проваленными)` : ''))
    if (failures) process.exitCode = 1
  } catch (e) {
    console.error('FAILED:', e.message)
    process.exitCode = 1
  } finally {
    ws.close()
  }
})
ws.on('error', e => { console.error('ws:', e.message); process.exitCode = 1 })
