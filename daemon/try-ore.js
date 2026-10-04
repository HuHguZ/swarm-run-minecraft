'use strict'
// Coming back for ore the bot has already seen.
//
// The failure this scene exists for, copied out of the y=-59 run of 2026-08-31:
//
//   штрек east 24  done {..."ores":[{"name":"deepslate_diamond_ore","count":2,
//                  "nearest":{"x":139,"y":-57,"z":159},"fromMouth":16.1}]}
//   ... три штрека спустя, бот в сорока блоках ...
//   добыть deepslate_diamond_ore  failed ← не вижу deepslate_diamond_ore
//                                          в радиусе 24 (смотрю честно,
//                                          только по прямой видимости)
//
// The drift was right to report the wall it had opened, and `mine` was right
// that nothing was visible from where the body was standing. Between them they
// left two diamonds in the rock with the coordinates in the brain's own hands.
//
// Six cases, and the fourth is the one that keeps the other five honest:
//   а  ore in the wall of the drift, two blocks up from its floor — walk back
//      and take it, diamond in the backpack;
//   б  ore 16 blocks behind down a corridor already cut — walked, not re-dug,
//      and the pickaxe cost of the road is a number this scene prints;
//   в  the ore was there and is not any more (the scene replaces it itself,
//      after the drift has reported it) — an honest "пусто", no lie and no crash;
//   г  CONTROL: a real ore block the bot has never seen. Must be refused, the
//      refusal must say what to do instead, and — the part that proves fair
//      play is intact — the block must still be sitting in the wall afterwards;
//   д  a four-block vein: all four, not one, and the drift must have reported
//      only the one block whose face it actually opened;
//   е  the memory listing, which must say out loud that it is memory.
//
// ---------------------------------------------------------------------------
// WHY THE FIRST RUN OF THIS SCENE WENT 13 RED, AND WHAT CHANGED
//
// Not one ore block was ever placed. Every /setblock in the file was written as
//     /setblock 1704,-58,1701 minecraft:deepslate_diamond_ore
// because the coordinate went through spot(), which formats a position for a
// PERSON to read. The server takes coordinates separated by SPACES, rejects the
// comma form, and says so only in the bot's own chat, which nobody was reading.
// /fill and /tp were written out by hand with spaces, so the box got built and
// the drift dug its eighteen blocks — and every later check then blamed the
// code under test for an arena that had never been built.
//
// Two changes, and the second one is the general cure:
//   1. cs() for sentences, mc() for commands. They are never the same helper.
//   2. Nothing is asked of the bot until the arena has proved itself: after
//      every placement the scene READS THE WORLD BACK and prints what is
//      actually lying there. A placement that did not land is ПРОП — an
//      experiment we failed to set up — never a red check.
// ---------------------------------------------------------------------------
//
// The read-back is god mode (fair:false), and that is allowed here for the same
// reason the coordinates are: the scene holds the truth, the bot is judged
// against it. To keep that truth clean the geometry is arranged so the sphere
// it looks through is entirely inside rock this file placed: lanes are 30 apart
// and the god-mode radius is 12, so it can reach neither another lane nor any
// natural ore outside the box. /fill only works in loaded chunks, so the bot is
// teleported into a lane before it is filled, and every volume is well under
// the 32768 /fill refuses past.
//
// NEEDS the diffs from this task applied (daemon/src/session.js — mineSeen,
// daemon/src/index.js — the mine_seen RPC). Without them the daemon answers
// "неизвестный метод: mine_seen" and the scene says so and stops.
const WebSocket = require('ws')
const fs = require('fs')
const path = require('path')

const STATE = path.resolve(__dirname, '..', 'memory', 'state.json')

const ws = new WebSocket(process.env.ND_WS || 'ws://127.0.0.1:8765')
let id = 0
const pending = new Map()
const call = (method, params = {}) => new Promise((resolve, reject) => {
  const rid = ++id
  pending.set(rid, { resolve, reject })
  ws.send(JSON.stringify({ id: rid, method, params }))
})

ws.on('message', raw => {
  const m = JSON.parse(raw.toString())
  const p = pending.get(m.id)
  if (!p) return
  pending.delete(m.id)
  m.ok ? p.resolve(m.result) : p.reject(new Error(m.error))
})

const sleep = ms => new Promise(r => setTimeout(r, ms))

async function cmd (text) {
  await call('say', { text })
  await sleep(600)
}

async function step (label, method, params) {
  const r = await call(method, params).catch(e => ({ status: 'RPC', error: e.message }))
  const problem = r.status === 'failed' ? ` ← ${r.error}`
    : r.status === 'RPC' ? ` ← RPC: ${r.error}`
      : r.status === 'timeout' ? ' ← таймаут' : ''
  console.log(`${label.padEnd(30)} ${String(r.status).padEnd(11)}${problem}`)
  if (r.by) console.log(`${''.padEnd(30)} прервано: ${r.by.type}`)
  return r
}

// ---------------------------------------------------------------- coordinates

// Two formatters, and the thirteen red lines of the first run are the whole
// argument for never letting them be one. cs() is for a sentence a person
// reads. mc() is for the server, which wants spaces and silently drops
// anything else.
const cs = p => `${p.x},${p.y},${p.z}`
const mc = p => `${p.x} ${p.y} ${p.z}`

// ---------------------------------------------------------------- verdicts

let failures = 0
let skipped = 0
function check (label, ok, note = '') {
  if (!ok) failures++
  console.log(`  ${ok ? 'ok  ' : 'ПЛОХО'} ${label}${note ? ' — ' + note : ''}`)
}

// "The code did the wrong thing" and "we failed to set the experiment up" are
// different news, and a scene that prints them the same way costs an afternoon
// arguing about the wrong bug. The comma bug printed thirteen of the second
// kind wearing the face of the first.
function skip (label, why) {
  skipped++
  console.log(`  ПРОП  ${label} — ${why}`)
}

// dug против picked против leftBehind. Это та самая арифметика, ради которой
// весь вечер: «сломал 4, в рюкзаке пусто» — это не результат, это молчание.
// Считать dug === picked + leftBehind в лоб нельзя: блок лазурита платит
// четырьмя предметами и больше, так что инвариант тут другой и он важнее —
// про любой недобор должно быть сказано словами и координатами.
function checkTally (m) {
  const explained = (m.picked || 0) > 0 || (m.leftBehind || 0) > 0 || !!m.note
  check('недобор не молчит', !(m.dug > 0) || explained,
    `dug=${m.dug} picked=${m.picked} leftBehind=${m.leftBehind || 0} note=${m.note || '-'}`)
  if (m.leftBehind) {
    check('у оставшегося лежать есть координаты и что делать',
      !!m.leftAt && !!m.note && /лежат на/.test(m.note),
      `leftAt=${JSON.stringify(m.leftAt)} note=${m.note || '-'}`)
  }
}

let caseName = ''
function header (name) {
  caseName = name
  console.log('\n=== ' + name + ' ===')
}

async function ready () {
  const st = await call('status')
  if (st.state.health >= 18) return true
  skip(caseName, `вошёл с ${st.state.health} хп — опыт не поставлен, а не провален`)
  return false
}

// ---------------------------------------------------------------- the arena

// x=1700 at the depth the real run failed at. Lanes are 30 apart so the
// god-mode sphere below (radius 12, centred in a lane) cannot reach the next
// one. Every other scene's arena is elsewhere (z -26..-4, 190..210, 300..329,
// 400..429, 600..630, 686..783), so a leftover from one run cannot be read as
// terrain in another.
const X0 = 1700   // the mouth: where the bot stands when a drift starts
const Y = -59     // the diamond layer, and the y of the run this reproduces
const YLO = -63   // one above the bedrock floor
const YHI = -47
const XLO = X0 - 2
const XHI = X0 + 22 // the longest drift here is 18 blocks, plus the buried control at +20
const BOXZ = 12
const OBSX = X0 + 10 // where the scene stands to look at the world
const OBSR = 12      // reaches every placement, reaches nothing outside the box
const LANES = { wall: 1700, behind: 1730, vanished: 1760, never: 1790, vein: 1820 }

// 25 x 17 x 25 = 10625 blocks, well under what /fill refuses, and filled only
// after the bot is standing in the middle of it — /fill into unloaded chunks
// fails silently and half the "controlled" arenas in this project turned out to
// be ordinary hillside.
async function base (lane) {
  await call('stop')
  await sleep(800)
  await cmd('/kill @e[type=!player]')
  await cmd('/gamerule spawn_mobs false')
  await cmd('/gamerule advance_time false')
  await cmd('/difficulty normal')
  await cmd(`/tp @s ${OBSX}.5 ${Y} ${lane}.5`)
  // @e видит только прогруженные чанки, поэтому чистить арену можно
  // только стоя в ней: kill до /tp вычищает ту, из которой уходим.
  await cmd('/kill @e[type=!player]')
  await sleep(3000) // chunks
  await cmd(`/fill ${XLO} ${YLO} ${lane - BOXZ} ${XHI} ${YHI} ${lane + BOXZ} minecraft:deepslate`)
  // The fill encases the body. Two blocks of air where it stands, so the
  // seconds spent building and checking the arena are not suffocation damage
  // that later gets blamed on the code under test. Sealed again in
  // standAtMouth: the drift must meet the same deepslate in every cell.
  await cmd(`/fill ${OBSX} ${Y} ${lane} ${OBSX} ${Y + 1} ${lane} minecraft:air`)
  await sleep(800)
}

async function equip (gives) {
  await cmd('/clear @s')
  for (const g of gives) await cmd(`/give @s ${g}`)
}

// Health is spent by the case before this one. Regeneration alone does not
// always finish before the bell, so instant_health finishes the job and a
// warning is printed if even that does not. Same scheme as try-tunnel.js.
async function topUp () {
  await cmd('/effect give @s minecraft:regeneration 20 5 true')
  await sleep(5000)
  await cmd('/effect clear @s')
  for (let i = 0; i < 3; i++) {
    const st = await call('status')
    if (st.state.health >= 20) return
    await cmd('/effect give @s minecraft:instant_health 1 10 true')
    await sleep(700)
  }
  const st = await call('status')
  if (st.state.health < 20) console.log(`  ВНИМАНИЕ: старт с ${st.state.health} хп, а не с 20`)
}

async function standAtMouth (lane) {
  await cmd(`/fill ${X0} ${Y} ${lane} ${X0} ${Y + 1} ${lane} minecraft:air`) // the mouth
  await cmd(`/tp @s ${X0}.5 ${Y} ${lane}.5`)
  await sleep(1200)
  // The observation pocket goes back to solid rock. A pre-dug square in the
  // middle of the drift would quietly change what `dug` and `walked` mean.
  await cmd(`/fill ${OBSX} ${Y} ${lane} ${OBSX} ${Y + 1} ${lane} minecraft:deepslate`)
  await sleep(1300)
  await topUp()
  return ready()
}

const KIT = ['minecraft:iron_pickaxe 2', 'minecraft:torch 16', 'minecraft:cooked_beef 8']

// ---------------------------------------------------------------- ground truth

// God mode, and only for the scene: it is allowed to look through stone because
// it is the one holding the truth. Nothing the bot does is judged BY this — it
// is judged AGAINST it. The bot is parked in the observation pocket first so
// the sphere is centred where the geometry above guarantees it stays inside the
// rock this file placed.
async function worldAt (lane, name) {
  await cmd(`/fill ${OBSX} ${Y} ${lane} ${OBSX} ${Y + 1} ${lane} minecraft:air`)
  await cmd(`/tp @s ${OBSX}.5 ${Y} ${lane}.5`)
  await sleep(1200)
  const seen = await call('observe', { radius: OBSR, fair: false }).catch(() => null)
  const blocks = (seen && seen.detail && seen.detail.blocks) || []
  return { hit: blocks.find(b => b.name === name) || null, all: blocks }
}

// Read the world back after every /setblock, before one thing is asked of the
// bot. This is the check whose absence cost the first run: the placements were
// rejected by the server and the scene went on to measure a bot in an empty
// box. Prints what is actually lying there, right or wrong.
async function armed (lane, wants) {
  const lines = []
  for (const w of wants) {
    const { hit, all } = await worldAt(lane, w.name)
    const spots = Array.isArray(w.at) ? w.at : [w.at]
    if (!hit) {
      const other = all.map(b => `${b.name}x${b.count}`).join(', ') || 'ничего примечательного'
      skip(caseName, `арена не построилась: ${w.name} в мире НЕ ВИДНО ВОВСЕ ` +
        `(ставили на ${spots.map(cs).join(' / ')}; /setblock не прошёл?). ` +
        `В радиусе ${OBSR} лежит: ${other}`)
      return false
    }
    if (hit.count !== spots.length) {
      skip(caseName, `арена не построилась: ${w.name} — в мире ${hit.count} шт, ставили ${spots.length} ` +
        `(${spots.map(cs).join(' / ')}), ближайший в мире ${cs(hit.nearest)}`)
      return false
    }
    if (!spots.some(p => p.x === hit.nearest.x && p.y === hit.nearest.y && p.z === hit.nearest.z)) {
      skip(caseName, `арена не построилась: ${w.name} лежит на ${cs(hit.nearest)}, ` +
        `а ставили на ${spots.map(cs).join(' / ')}`)
      return false
    }
    lines.push(`${w.name} x${hit.count} на ${cs(hit.nearest)}`)
  }
  console.log('  арена проверена в мире:', lines.join('; '))
  return true
}

// ---------------------------------------------------------------- the ledger

// Read straight off disk, not out of the answer. "Память живёт в
// memory/state.json" is a claim about a file, so the scene opens the file — an
// in-memory ledger that never lands would pass every other check here and lose
// everything the moment the daemon restarts.
function onDisk () {
  try {
    const s = JSON.parse(fs.readFileSync(STATE, 'utf8'))
    return Array.isArray(s.ore) ? s.ore : []
  } catch {
    return null
  }
}

function inLedger (p) {
  const rows = onDisk()
  if (!rows) return null
  return rows.find(r => r.x === p.x && r.y === p.y && r.z === p.z) || null
}

// ---------------------------------------------------------- а. ore in the wall

// The literal geometry of the failing run: the drift floor at y=-59, the ore at
// y=-57 — two blocks up, in a wall the drift opened and then walked away from.
// Two kinds, so `gained` says which one came out without any guessing.
async function sceneWall () {
  const lane = LANES.wall
  header('а. руда в стене штрека: вернуться и добыть')
  await base(lane)

  const side = { x: X0 + 4, y: Y + 1, z: lane + 1 }  // боковая стена, на уровне головы
  const above = { x: X0 + 6, y: Y + 2, z: lane }     // два блока вверх от пола: y=-57
  await cmd(`/setblock ${mc(side)} minecraft:deepslate_diamond_ore`)
  await cmd(`/setblock ${mc(above)} minecraft:deepslate_lapis_ore`)
  if (!(await armed(lane, [
    { name: 'deepslate_diamond_ore', at: side },
    { name: 'deepslate_lapis_ore', at: above }
  ]))) return

  await equip(KIT)
  if (!(await standAtMouth(lane))) return

  const t = await step('штрек east 10', 'tunnel', { direction: 'east', length: 10, timeoutSeconds: 180 })
  const d = t.detail
  if (!d) { check('штрек вообще отработал', false, t.error || ''); return }
  console.log('  руда в отчёте:', JSON.stringify(d.ores))
  check('штрек прошёл 10 блоков', d.walked === 10, `walked=${d.walked} stopped=${d.stopped || '-'}`)
  check('штрек доложил обе руды', d.ores.length === 2, JSON.stringify(d.ores.map(o => o.name)))

  // The hole the whole task is about: the coordinates have to outlive the tool
  // result they arrived in.
  check('память легла на диск', !!inLedger(side) && !!inLedger(above),
    `в memory/state.json: ${onDisk() ? onDisk().length + ' записей' : 'файл не прочитался'}`)
  const row = inLedger(side)
  check('в записи сказано, откуда знание', !!row && row.why === 'стена штрека', row ? row.why : '-')
  check('в записи есть дата', !!row && !!row.seen, row ? row.seen : '-')

  const from = (await call('status')).state.pos
  check('бот ушёл от руды', Math.abs(from.x - side.x) >= 4, `бот на ${cs(from)}, руда на ${cs(side)}`)

  const r = await step('добыть виденное (стена)', 'mine_seen', { at: side, timeoutSeconds: 120 })
  if (r.status === 'RPC') {
    skip(caseName, 'демон не знает mine_seen — не применены диффы session.js / index.js')
    return
  }
  const m = r.detail
  if (!m) { check('добор отработал', false, r.error || ''); return }
  console.log('  дорога:', JSON.stringify(m.travel), 'взял:', JSON.stringify(m.vein))

  check('статус «добыл»', m.status === 'добыл', `status=${m.status} stopped=${m.stopped || '-'}`)
  check('АЛМАЗ В РЮКЗАКЕ', (m.gained.diamond || 0) >= 1, `gained=${JSON.stringify(m.gained)}`)
  check('в ответе сказано, что это память', !!m['помнил'] && !!m['помнил']['видел'], JSON.stringify(m['помнил']))
  check('дорогу не прокапывал заново', m.travel.swings === 0 && !m.travel.dugOnTheWay,
    `swings=${m.travel.swings} dugOnTheWay=${m.travel.dugOnTheWay}`)
  checkTally(m)
  check('запись вычеркнута из памяти', !inLedger(side))

  // The y=-57 half, asked by name rather than by coordinate: the exact call
  // that failed in the real run, now answered from memory instead of eyesight.
  const r2 = await step('добыть виденное (по имени)', 'mine_seen',
    { block: 'deepslate_lapis_ore', timeoutSeconds: 120 })
  const m2 = r2.detail
  if (!m2) { check('добор по имени отработал', false, r2.error || ''); return }
  check('нашёл по имени, без координат', m2.status === 'добыл', `status=${m2.status} stopped=${m2.stopped || '-'}`)
  check('лазурит в рюкзаке', (m2.gained.lapis_lazuli || 0) >= 1, `gained=${JSON.stringify(m2.gained)}`)
  check('добыл именно ту, что помнил', m2.target.y === above.y && m2.target.x === above.x,
    `target=${cs(m2.target)}, ждали ${cs(above)}`)
}

// ------------------------------------------------------- б. 16 blocks behind

// The corridor is already cut, lit and flat. Coming back down it should cost
// walking and nothing else — the number to watch is travel.swings, and zero is
// the whole point: pathfinder with canDig on cuts a fresh diagonal through the
// wall and spends the pickaxe the ore is waiting for.
async function sceneBehind () {
  const lane = LANES.behind
  header('б. руда в 16 блоках позади по своему же штреку')
  await base(lane)

  const ore = { x: X0 + 2, y: Y + 1, z: lane + 1 }
  await cmd(`/setblock ${mc(ore)} minecraft:deepslate_diamond_ore`)
  if (!(await armed(lane, [{ name: 'deepslate_diamond_ore', at: ore }]))) return

  await equip(KIT)
  if (!(await standAtMouth(lane))) return

  const t = await step('штрек east 18', 'tunnel', { direction: 'east', length: 18, timeoutSeconds: 240 })
  const d = t.detail
  if (!d) { check('штрек вообще отработал', false, t.error || ''); return }
  check('штрек прошёл 18 блоков', d.walked === 18, `walked=${d.walked} stopped=${d.stopped || '-'}`)
  check('руда записана', !!inLedger(ore))

  const before = (await call('status')).state
  const gap = Math.abs(before.pos.x - ore.x)
  check('руда осталась в 16 блоках позади', gap >= 14 && gap <= 18, `разрыв ${gap} блоков`)

  const r = await step('добыть виденное', 'mine_seen', { at: ore, timeoutSeconds: 150 })
  const m = r.detail
  if (!m) { check('добор отработал', false, r.error || ''); return }
  console.log(`  ЦЕНА ДОРОГИ: ${m.travel.meters} блоков, ${m.travel.seconds} с, кирка ${m.travel.swings} ударов, ` +
    `копал по пути: ${m.travel.dugOnTheWay}`)

  check('дошёл и добыл', m.status === 'добыл', `status=${m.status} stopped=${m.stopped || '-'}`)
  check('алмаз в рюкзаке', (m.gained.diamond || 0) >= 1, `gained=${JSON.stringify(m.gained)}`)
  checkTally(m)
  // Алмазная руда платит ровно одним алмазом за блок, поэтому тут арифметика
  // сходится в лоб — в отличие от лазурита в случае (а).
  check('сломано = поднято + осталось', m.dug === (m.picked || 0) + (m.leftBehind || 0),
    `dug=${m.dug} picked=${m.picked} leftBehind=${m.leftBehind || 0}`)
  // The three numbers that make "разумно" a measurement rather than an opinion.
  check('прошёл именно те ~16 блоков', m.travel.meters >= 10 && m.travel.meters <= 22, `${m.travel.meters}`)
  check('КИРКОЙ НА ДОРОГУ ПОТРАЧЕНО 0', m.travel.swings === 0, `swings=${m.travel.swings}`)
  check('шёл коридором, а не рыл новый', m.travel.dugOnTheWay === false, `dugOnTheWay=${m.travel.dugOnTheWay}`)
  check('дорога уложилась в 30 с', m.travel.seconds <= 30, `${m.travel.seconds} с`)
}

// --------------------------------------------------------- в. the ore is gone

// The block is replaced with plain deepslate, not with air: "пусто" is easy to
// get right when the square is empty, and the case that actually happens
// underground — a cave-in, another player, lava — leaves something else in it.
async function sceneVanished () {
  const lane = LANES.vanished
  header('в. руда была, а её уже нет')
  await base(lane)

  const ore = { x: X0 + 4, y: Y + 1, z: lane + 1 }
  await cmd(`/setblock ${mc(ore)} minecraft:deepslate_diamond_ore`)
  if (!(await armed(lane, [{ name: 'deepslate_diamond_ore', at: ore }]))) return

  await equip(KIT)
  if (!(await standAtMouth(lane))) return

  const t = await step('штрек east 10', 'tunnel', { direction: 'east', length: 10, timeoutSeconds: 180 })
  if (!t.detail) { check('штрек вообще отработал', false, t.error || ''); return }
  check('руда записана в память', !!inLedger(ore))

  // The scene breaks it, after the drift has already reported it. This is the
  // whole experiment: memory now disagrees with the world.
  await cmd(`/setblock ${mc(ore)} minecraft:deepslate`)
  await sleep(1500)

  const r = await step('добыть виденное', 'mine_seen', { at: ore, timeoutSeconds: 120 })
  check('НЕ УПАЛ', r.status === 'done', `status=${r.status} ${r.error || ''}`)
  const m = r.detail
  if (!m) { check('добор ответил деталью', false, r.error || ''); return }
  console.log('  ответ:', JSON.stringify({ status: m.status, gone: m.gone, note: m.note }))

  check('честный ответ «пусто»', m.status === 'пусто', `status=${m.status}`)
  check('ничего не приписал себе', m.dug === 0 && !(m.gained && m.gained.diamond),
    `dug=${m.dug} gained=${JSON.stringify(m.gained)}`)
  check('сказал, что там теперь', !!m.gone && /deepslate/.test(String(m.gone[0]['сейчас'])),
    JSON.stringify(m.gone))
  check('сказал, что вычеркнул', !!m.note && /вычеркнул/.test(m.note), m.note || '-')
  check('и правда вычеркнул с диска', !inLedger(ore))

  // A ledger that keeps offering a square the body has already stood on and
  // found bare is the same hang the y=-51 log is made of.
  const again = await step('спросить ещё раз', 'mine_seen', { at: ore, timeoutSeconds: 60 })
  check('повтор отказан, а не повторён', again.status === 'failed' && /не помню/.test(again.error || ''),
    `${again.status}: ${again.error || ''}`)
}

// -------------------------------------------------------------- г. the CONTROL

// The case that keeps every other one honest. A real ore block, buried three
// blocks off the axis and ten past the end of the drift, so no face of it is
// ever opened and no ray ever reaches it. The bot must refuse — and the block
// must still be there afterwards, which is the whole difference between
// "отказался" and "не смог".
async function sceneNeverSeen () {
  const lane = LANES.never
  header('г. КОНТРОЛЬ: руда, которую бот никогда не видел')
  await base(lane)

  const buried = { x: X0 + 20, y: Y, z: lane + 3 }
  await cmd(`/setblock ${mc(buried)} minecraft:deepslate_emerald_ore`)
  // The control is worthless if the block is not really there, and the first
  // run of this scene is exactly what that looks like: the bot refused, the
  // scene called it fair play, and the wall was empty all along.
  if (!(await armed(lane, [{ name: 'deepslate_emerald_ore', at: buried }]))) return

  await equip(KIT)
  if (!(await standAtMouth(lane))) return

  const t = await step('штрек east 10', 'tunnel', { direction: 'east', length: 10, timeoutSeconds: 180 })
  const d = t.detail
  if (!d) { check('штрек вообще отработал', false, t.error || ''); return }
  check('штрек изумруд не увидел', !d.ores.some(o => /emerald/.test(o.name)), JSON.stringify(d.ores))
  check('и в память не записал', !inLedger(buried))

  const byPos = await step('добыть по координатам', 'mine_seen', { at: buried, timeoutSeconds: 60 })
  check('ОТКАЗ по координатам', byPos.status === 'failed', `status=${byPos.status}`)
  check('в отказе сказано «не помню»', /не помню/.test(byPos.error || ''), byPos.error || '')
  check('в отказе сказано, что сквозь камень не смотрит', /сквозь камень/.test(byPos.error || ''), byPos.error || '')
  check('в отказе сказано, ЧТО ДЕЛАТЬ', /mc_tunnel/.test(byPos.error || ''), byPos.error || '')
  check('в отказе сказано, ГДЕ ИСКАТЬ', /-59|глубин/.test(byPos.error || ''), byPos.error || '')

  const byName = await step('добыть по имени', 'mine_seen',
    { block: 'deepslate_emerald_ore', timeoutSeconds: 60 })
  check('ОТКАЗ по имени', byName.status === 'failed', `status=${byName.status}`)
  check('и тут сказано, что делать', /mc_tunnel/.test(byName.error || ''), byName.error || '')

  // The proof that this was a refusal and not a failure: the emerald is still
  // in the wall. If fair play were broken the bot would be holding it.
  const { hit } = await worldAt(lane, 'deepslate_emerald_ore')
  check('ИЗУМРУД ВСЁ ЕЩЁ В СТЕНЕ', !!hit && hit.nearest.x === buried.x &&
    hit.nearest.y === buried.y && hit.nearest.z === buried.z,
    hit ? `мир: ${cs(hit.nearest)}, ждали ${cs(buried)}` : 'мир его не показывает вовсе')
  const inv = (await call('status')).state.inventory
  check('изумруда в рюкзаке нет', !inv.emerald, JSON.stringify(inv))
}

// ------------------------------------------------------------------ д. the vein

// Four blocks, face-connected, of which the drift opens exactly one. So this
// case measures two things at once: that the report does NOT contain the three
// still buried (fog of war), and that the добор takes all four anyway — because
// breaking the first one is what puts the second in plain sight, which is what
// a person with a pickaxe experiences.
//
// All four sit in the plane z = lane+1, and that is a correction, not a
// preference. The first version of this vein reached out to lane+2, and three
// of its four drops then landed in cells with no floor the body could stand on
// and no walking route to them — (X0+4,-59,lane+1) is untouched deepslate, so
// there is no way through. Measured against a simulated world: 1 of 4 drops
// reachable, which is exactly the picked=1 / leftBehind=3 the fixed code
// reports. That made "4 алмаза в рюкзаке" a check demanding the impossible, and
// a scene that asks for the impossible tells you nothing about the code.
// So the vein is a column standing on the one exposed block. As each block
// comes out the column empties beneath the next, so all four drops fall to the
// SAME square — one block off the corridor, floor under it, no step needed:
// 4 of 4 within vanilla pickup, 4 of 4 within pickaxe reach (3.05 at worst),
// one block exposed to the drift, still face-connected from V1. Checked by
// arithmetic against this geometry, not by eye.
async function sceneVein () {
  const lane = LANES.vein
  header('д. жила из 4 блоков: забрать все')
  await base(lane)

  const vein = [
    { x: X0 + 4, y: Y + 1, z: lane + 1 }, // единственный с гранью на штрек
    { x: X0 + 4, y: Y + 2, z: lane + 1 }, // выше — грани на штрек уже нет
    { x: X0 + 4, y: Y + 3, z: lane + 1 },
    { x: X0 + 4, y: Y + 4, z: lane + 1 }
  ]
  for (const v of vein) await cmd(`/setblock ${mc(v)} minecraft:deepslate_diamond_ore`)
  if (!(await armed(lane, [{ name: 'deepslate_diamond_ore', at: vein }]))) return

  await equip(KIT)
  if (!(await standAtMouth(lane))) return

  const t = await step('штрек east 10', 'tunnel', { direction: 'east', length: 10, timeoutSeconds: 180 })
  const d = t.detail
  if (!d) { check('штрек вообще отработал', false, t.error || ''); return }

  const reported = d.ores.find(o => o.name === 'deepslate_diamond_ore')
  check('штрек доложил ровно 1 блок жилы', !!reported && reported.count === 1,
    reported ? `count=${reported.count}` : 'не доложил вовсе')
  check('три остальных не записаны', !inLedger(vein[1]) && !inLedger(vein[2]) && !inLedger(vein[3]))

  const r = await step('добыть виденное', 'mine_seen', { at: vein[0], count: 8, timeoutSeconds: 150 })
  const m = r.detail
  if (!m) { check('добор отработал', false, r.error || ''); return }
  console.log('  взято:', JSON.stringify(m.vein))

  check('ЗАБРАЛ ВСЕ 4', m.dug === 4, `dug=${m.dug} vein=${JSON.stringify(m.vein)} stopped=${m.stopped || '-'}`)
  check('4 АЛМАЗА В РЮКЗАКЕ', (m.gained.diamond || 0) === 4, `gained=${JSON.stringify(m.gained)}`)
  checkTally(m)
  check('сломано = поднято + осталось', m.dug === (m.picked || 0) + (m.leftBehind || 0),
    `dug=${m.dug} picked=${m.picked} leftBehind=${m.leftBehind || 0}`)
  const { hit } = await worldAt(lane, 'deepslate_diamond_ore')
  check('в стене алмазов не осталось', !hit, hit ? `в мире ещё ${hit.count} на ${cs(hit.nearest)}` : '')
}

// ------------------------------------------------------------ the memory list

// The brain has to be able to ask "что ты вообще помнишь" without spending an
// intent on it, and the answer has to say out loud that it is memory.
async function sceneRecall () {
  header('е. список памяти: что помню и чем это отличается от «вижу»')
  const r = await step('mine_seen без аргументов', 'mine_seen', {})
  const m = r.detail
  if (!m) { check('список отработал', false, r.error || ''); return }
  console.log('  ', JSON.stringify({ remembered: m.remembered, kinds: m.kinds, note: m.note }))
  check('это не интент, а справка', r.status === 'done')
  check('сказано, что это память, а не зрение',
    !!m.note && /память, а не зрение|не помню вообще/.test(m.note), m.note || '-')
  check('число записей есть', typeof m.remembered === 'number', `${m.remembered}`)
}

// ----------------------------------------------------------------

ws.on('open', async () => {
  try {
    await call('connect')
    if (!onDisk()) {
      console.log(`ВНИМАНИЕ: не читается ${STATE} — проверки памяти на диске будут красными`)
    }
    await sceneWall()
    await sceneBehind()
    await sceneVanished()
    await sceneNeverSeen()
    await sceneVein()
    await sceneRecall()

    await cmd('/kill @e[type=!player]')
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
