'use strict'
const gameClock = require('./src/game-clock')
// Why this scene exists: diamond4.log has two "поесть RPC null" lines and not a
// word about what went wrong, because eat() rejected the WebSocket call and the
// run printed only `detail`. So the first duty of this file is to print the
// error text — for every status, RPC included, with the stack.
//
// The branches are ordered by how much they can tell apart:
//   * full bar                — must be a note, never an error
//   * hungry, food 17..19     — the autopilot is silent above food 16, so this
//                               is eating with nobody else touching the bag
//   * hungry, food <= 14      — the autopilot bites every second here and
//                               mineflayer's consume() aborts whichever call
//                               came first; the bar still has to go up
//   * only rotten flesh       — the fallback nobody wants but everybody uses
//   * only a fish bucket      — minecraft-data calls it food, the game does not
//   * eating while walking    — eat is not exclusive, so an intent keeps running
//   * eating with a chest open— best effort: the window has to be open at the
//                               exact moment, and that is a race we cannot force
//   * empty bag               — the honest "nothing to eat", not an exception
//
// The food bar cannot be set by command, so it is drained with the hunger
// effect and watched until it reaches the number the branch wants.
const WebSocket = require('ws')

const ws = new WebSocket(process.env.ND_WS || 'ws://127.0.0.1:8765')
let id = 0
const pending = new Map()
const call = (method, params = {}) => new Promise((resolve, reject) => {
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

// The helper the other scenes get wrong: `error` lives on the envelope for
// `failed` AND on the RPC rejection, and dropping it is how diamond4.log ended
// up with two useless lines. Everything is printed, always.
async function step (label, method, params) {
  const r = await call(method, params)
    .catch(e => ({ status: 'RPC', error: e.message, stack: e.stack }))
  const tail = r.error ? ` ← ${r.error}` : (r.status === 'timeout' ? ' ← таймаут' : '')
  console.log(`${label.padEnd(30)} ${String(r.status).padEnd(9)} ${JSON.stringify(r.detail ?? null)}${tail}`)
  if (r.status === 'RPC' && r.stack) {
    console.log(`${''.padEnd(30)} стек: ${String(r.stack).split('\n').slice(1, 4).map(s => s.trim()).join(' <- ')}`)
  }
  if (r.by) console.log(`${''.padEnd(30)} прервано: ${r.by.type}`)
  const ev = (r.events || []).map(e => e.type)
  if (ev.length) console.log(`${''.padEnd(30)} события: ${ev.join(', ')}`)
  return r
}

const state = async () => (await call('status')).state

async function show (label) {
  const s = await state()
  console.log(`${label.padEnd(30)} еда ${String(s.food).padEnd(3)} hp ${String(s.health).padEnd(3)} в руке ${s.held || '-'} | ${JSON.stringify(s.inventory)}`)
  return s
}

// A clean slate on a flat platform: no mobs, no night, no falling. /fill only
// works in loaded chunks, so the teleport comes first and the volume is small.
async function arena () {
  await call('stop')
  await sleep(800)
  await cmd('/gamerule spawn_mobs false')
  await cmd('/kill @e[type=!player,type=!item]')
  await cmd('/time set 6000')
  await cmd('/tp @s 200 70 200')
  // @e видит только прогруженные чанки, поэтому чистить арену можно
  // только стоя в ней: kill до /tp вычищает ту, из которой уходим.
  await cmd('/kill @e[type=!player]')
  await sleep(3000)
  await cmd('/fill 190 68 190 210 69 210 minecraft:stone')
  await cmd('/fill 190 70 190 210 74 210 minecraft:air')
  await cmd('/tp @s 200 70 200')
  await sleep(1500)
  await cmd('/clear @s')
  await cmd('/effect clear @s')
  await cmd('/effect give @s minecraft:saturation 2 20 true')
  await sleep(2500)
}

async function give (...gives) {
  for (const g of gives) await cmd(`/give @s minecraft:${g}`)
  await sleep(700)
}

// Hunger cannot be set, only spent. The exhaustion the effect adds is
// 0.005*(amplifier+1) per tick, so amplifier 20 costs about a point every two
// seconds — amplifier 4 takes eight seconds a point and the drain loses to the
// autopilot. Cleared the moment the bar reaches the target so the number stops
// moving under the test. Always run on an empty bag: below food 16 the
// autopilot eats every second and would undo the drain as fast as it happens.
async function drainTo (target, timeoutMs = 120000) {
  await cmd(`/effect give @s minecraft:hunger 120 20 true`)
  const deadline = gameClock.now() + timeoutMs
  while (gameClock.now() < deadline) {
    const s = await state()
    if (s.food <= target) break
    await sleep(500)
  }
  await cmd('/effect clear @s minecraft:hunger')
  await sleep(400)
  const s = await state()
  console.log(`${'  довёл голод до'.padEnd(30)} еда ${s.food} (цель <=${target})`)
  return s.food
}

async function branch (title, prepare, run) {
  console.log(`\n=== ${title} ===`)
  await arena()
  await prepare()
  await show('  перед')
  await run()
  await show('  после')
}

ws.on('open', async () => {
  try {
    await call('connect')

    await branch('сытый бот',
      async () => { await give('cooked_beef 8') },
      async () => {
        await step('  поесть', 'eat', {})
        // Naming an item at a full bar goes through a different door: it is the
        // one that used to reach the brain as mineflayer's "Food is full".
        await step('  поесть cooked_beef', 'eat', { item: 'cooked_beef' })
      })

    await branch('голодный с мясом, автопилот молчит (еда 18)',
      async () => { await drainTo(18); await give('cooked_beef 8', 'iron_pickaxe 1') },
      async () => {
        // A pickaxe in hand on purpose: the hand has to come back afterwards,
        // and that restore is where a stale item reference used to throw.
        await step('  взять кирку', 'equip', { item: 'iron_pickaxe' })
        await step('  поесть', 'eat', {})
      })

    await branch('голодный с мясом, автопилот тоже ест (еда 12)',
      async () => { await drainTo(12); await give('cooked_beef 8') },
      async () => {
        // Below cfg.eatBelowFood the autopilot eats every second, and
        // bot.consume() cancels whichever call started first. The bar still has
        // to go up, and eat must report that rather than the cancellation.
        await step('  поесть', 'eat', {})
      })

    await branch('только гнилая плоть',
      async () => { await drainTo(12); await give('rotten_flesh 16') },
      async () => { await step('  поесть', 'eat', {}) })

    await branch('только ведро с рыбой (не еда)',
      async () => { await drainTo(12); await give('salmon_bucket 1') },
      async () => {
        // minecraft-data 1.21.11 lists salmon_bucket in foodsByName. The game
        // does not: using it spills a salmon. Expected answer is "еды нет".
        await step('  поесть', 'eat', {})
      })

    await branch('еда во время удерживаемого движения',
      async () => { await drainTo(12); await give('cooked_beef 8') },
      async () => {
        // eat is not exclusive, so goto keeps running underneath it: controls
        // held, pathfinder swapping tools, inventory moving. This is the shape
        // of the diamond4 failure minus the mob.
        const walking = step('  дойти до 210,70,210', 'goto',
          { x: 210, y: 70, z: 210, range: 1, timeoutSeconds: 30 })
        await sleep(1200)
        await step('  поесть на ходу', 'eat', {})
        await walking
      })

    await branch('еда при открытом сундуке (как получится)',
      async () => {
        await cmd('/setblock 202 70 200 minecraft:chest')
        await drainTo(12)
        await give('cooked_beef 8', 'cobblestone 16')
      },
      async () => {
        // Best effort and said so: the window is open only for the moment
        // chest_put is inside it, and nothing here can hold it open on demand.
        // If windowOpen comes back null the branch simply did not land — that
        // is data too, not a pass.
        const putting = step('  сложить камень в сундук', 'chest_put',
          { item: 'cobblestone', x: 202, y: 70, z: 200 })
        await sleep(700)
        await step('  поесть при окне', 'eat', {})
        await putting
      })

    await branch('еды нет вовсе',
      async () => { await drainTo(12); await give('iron_pickaxe 1') },
      async () => {
        await step('  поесть', 'eat', {})
        await step('  поесть golden_apple', 'eat', { item: 'golden_apple' })
      })

    console.log('\nчего ждём: ни одной строки со статусом RPC. Всякий отказ —')
    console.log('это detail с полями note / during / error / held / windowOpen / busy.')
    await arena()
  } catch (e) {
    console.error('FAILED:', e.message)
    console.error(e.stack)
    process.exitCode = 1
  } finally {
    ws.close()
  }
})
ws.on('error', e => { console.error('ws:', e.message); process.exitCode = 1 })
