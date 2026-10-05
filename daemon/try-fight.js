'use strict'
const gameClock = require('./src/game-clock')
// Combat repro, aimed at the one thing that never worked: retreating from a
// shooter. Running in a straight line from a skeleton just presents your back,
// so the retreat has to end with something solid in the line of fire.
//
// retreatAtHealth is set absurdly high on purpose — the point is to reach the
// retreat branch on the first arrow, not to watch a full fight.
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
  await sleep(700)
}

// A flat dry arena, rebuilt before every round. The first runs were fought
// standing in a lake, where pathfinder cannot move and there is nothing solid
// to build a wall against - every round died to the water, not to the mob.
// It is reset each time because a round leaves walls and pillars behind.
async function arena () {
  await cmd('/kill @e[type=!player,type=!item]')
  await cmd('/tp @s -15 81 62')
  // Своя сложность, а не унаследованная: на peaceful призванный моб исчезает
  // следующим тиком, и боевая сцена молча меряет пустоту.
  await cmd('/difficulty normal')
  // @e видит только прогруженные чанки, поэтому чистить арену можно
  // только стоя в ней: kill до /tp вычищает ту, из которой уходим.
  await cmd('/kill @e[type=!player]')
  await cmd('/fill -23 79 54 -7 79 70 minecraft:stone')
  await cmd('/fill -23 80 54 -7 84 70 minecraft:air')
  await cmd('/tp @s -15 80 62')
  await cmd('/effect give @s minecraft:instant_health 1 20 true')
  await cmd('/give @s minecraft:cobblestone 64')
  await cmd('/give @s minecraft:stone_sword 1')
}

async function round (label, mob, params) {
  console.log(`\n=== ${label} ===`)
  await arena()
  await cmd(`/summon minecraft:${mob} ~5 ~ ~1`)
  await sleep(800)

  const before = await call('status')

  // A death interrupt throws away the intent's own detail, so the only way to
  // see what the retreat actually did is to watch the body while it happens.
  let watching = true
  const track = []
  const watcher = (async () => {
    while (watching) {
      try {
        const st = await call('status')
        track.push(`hp${st.state.health}@${st.state.pos.x},${st.state.pos.y},${st.state.pos.z}`)
      } catch {}
      await sleep(800)
    }
  })()

  const r = await call('fight', params)
  watching = false
  await watcher
  const after = await call('status')
  console.log('трасса:', track.join(' '))

  console.log(`статус: ${r.status}${r.error ? ' — ' + r.error : ''}`)
  console.log('детали:', JSON.stringify(r.detail))
  console.log(`hp ${before.state.health} -> ${after.state.health}`,
    `| ${JSON.stringify(before.state.pos)} -> ${JSON.stringify(after.state.pos)}`)
  if (r.events && r.events.length) console.log('события:', JSON.stringify(r.events.map(e => e.type)))
  return r
}

ws.on('open', async () => {
  try {
    await call('connect')
    await cmd('/time set 13000')
    await cmd('/weather clear')
    await cmd('/gamerule spawn_mobs false')
    await cmd('/give @s minecraft:cobblestone 64')
  await cmd('/give @s minecraft:stone_sword 1')

    if (!process.env.DIAG) {
    // Bails on the first arrow: exercises the cover search, not the swinging.
    await round('скелет, отступление сразу', 'skeleton',
      { target: 'skeleton', retreatAtHealth: 19, timeoutSeconds: 45 })

    // Same mob, fight it out: the shield should go up on the approach.
    await round('скелет, драка до конца', 'skeleton',
      { target: 'skeleton', retreatAtHealth: 4, timeoutSeconds: 45 })

    // Melee threat: plain distance is the right answer here, no cover hunt.
    await round('зомби, отступление сразу', 'zombie',
      { target: 'zombie', retreatAtHealth: 19, timeoutSeconds: 45 })
    }

    // Same zombie round, but unkillable: a death interrupt throws the intent's
    // own detail away, and the detail is the whole point when the retreat is
    // silently doing nothing.
    await arena()
    await cmd('/effect give @s minecraft:resistance 60 4 true')
    await cmd('/effect give @s minecraft:regeneration 60 3 true')
    // retreatAtHealth at full health forces the retreat branch on tick one,
    // so the returned detail is about the retreat and nothing else.
    await round('зомби, под резистом (диагностика)', 'zombie',
      { target: 'zombie', retreatAtHealth: 20, timeoutSeconds: 45 })

    await cmd('/kill @e[type=!player,type=!item]')
    await cmd('/effect clear @s')
  } catch (e) {
    console.error('FAILED:', e.message)
    process.exitCode = 1
  } finally {
    ws.close()
  }
})
ws.on('error', e => { console.error('ws:', e.message); process.exitCode = 1 })
