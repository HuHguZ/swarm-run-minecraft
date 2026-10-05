'use strict'
const gameClock = require('./src/game-clock')
// The fight that killed the expedition: a mob in a mine drift at diamond depth.
//
// What the first run of this scene established, and what the doctrine is now
// built on:
//
//   * against an archer the wall is perfect — skeleton ten blocks down the
//     drift, two blocks placed, zero damage, zero swings;
//   * against a walker the wall only lands if the square in front is free, and
//     it stops being free the moment contact is made;
//   * breaking contact with a walker does not work at all. The runs that
//     stepped back or walked the axis ended at 1, 3 and 4 hp with the mob
//     still chewing; the runs that just swung killed it for 2 and 9 hp.
//
// So the scene now asserts two different doctrines: seal against shooters,
// fight against walkers, and never trade hp for distance underground.
//
// The arena is cut out of solid deepslate at y=-29, the depth the bot actually
// died at, so nothing is polluted by natural terrain. /fill only works in
// loaded chunks and silently refuses over 32768 blocks, so the bot is
// teleported into place first and every volume is small (30x21x30 = 18900).
//
//   node daemon/try-corridor.js
//
// Needs the daemon up (start-all.ps1) and the bot able to connect. Exit code is
// non-zero if any case comes back ПЛОХО.
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

// ------------------------------------------------------------------- arena

const Y = -29                 // the depth the run actually died at
const Z = 415                 // the drift runs along x at this z
const X0 = 405                // west end of the drift
const X1 = 425                // east end
const START = 406             // where the bot stands, one cell in from the end

const KIT = [
  'minecraft:iron_sword 1', 'minecraft:iron_pickaxe 1',
  'minecraft:torch 16', 'minecraft:cooked_beef 16',
  'minecraft:iron_helmet 1', 'minecraft:iron_chestplate 1'
]

// kind:
//   drift   — straight 1x2 drift in solid rock, bot one cell in from the west end
//   deadend — same, but rock starts right behind the bot: nowhere to fall back
//   cave    — what actually killed the expedition: the open underground
//             cave a drift breaks into. Roof three blocks up, so a pillar can
//             place exactly one block and never the two that count as a
//             pillar; uneven floor; solid rock past the walls, so there is no
//             cover to walk to and nowhere to run. A room with a five-block
//             ceiling is not this, and a bot survives in one.
//   sky     — a bare platform under open sky. The real control for the
//             open-ground doctrine, now that the cave has taken case 7.
async function arena (kind, { blocks = true, standAt = null } = {}) {
  await call('stop')
  await sleep(800)
  await cmd('/gamerule spawn_mobs false')
  await cmd('/difficulty normal')
  await cmd('/kill @e[type=!player,type=!item]')

  if (kind === 'sky') {
    await cmd('/tp @s 415 82 415')
    // @e видит только прогруженные чанки, поэтому чистить арену можно
    // только стоя в ней: kill до /tp вычищает ту, из которой уходим.
    await cmd('/kill @e[type=!player]')
    await sleep(3000)
    await cmd('/fill 405 80 405 425 95 425 minecraft:air')   // 7056, under the cap
    await cmd('/fill 405 79 405 425 79 425 minecraft:stone') // 441
    await kit(blocks)
    await cmd(`/tp @s ${standAt || '415.5 80 415.5'}`)
    await sleep(2500)
    return topUp()
  }

  await cmd(`/tp @s 415 ${Y + 2} 415`)
  await sleep(3000) // let the chunks arrive before filling them

  await cmd(`/fill 400 ${Y - 11} 400 429 ${Y + 9} 429 minecraft:deepslate`)
  const west = kind === 'deadend' ? START : X0
  await cmd(`/fill ${west} ${Y} ${Z} ${X1} ${Y + 1} ${Z} minecraft:air`)
  if (kind === 'cave') {
    // Three open cells, roof at Y+3: exactly the geometry where towerUp places
    // one block and retreat then falls through to the run. 19x3x10 = 570.
    await cmd(`/fill 410 ${Y} 405 428 ${Y + 2} 414 minecraft:air`)
    // Uneven floor. A flat box is not a cave, and a flat box hides how a body
    // drifts while it is being hit.
    await cmd(`/fill 414 ${Y} 407 415 ${Y} 408 minecraft:deepslate`)
    await cmd(`/fill 420 ${Y} 411 421 ${Y} 412 minecraft:deepslate`)
    await cmd(`/setblock 424 ${Y} 406 minecraft:deepslate`)
  }

  await kit(blocks)
  await cmd(`/tp @s ${standAt || `${START}.5 ${Y} ${Z}.5`}`)
  await sleep(2500)
  return topUp()
}

// Always first: /give into a full backpack drops the item on the floor, and
// then half an hour goes into "why does it say there is no pickaxe".
async function kit (blocks) {
  await cmd('/clear @s')
  for (const give of KIT) await cmd(`/give @s ${give}`)
  if (blocks) await cmd('/give @s minecraft:cobblestone 64')
}

async function topUp () {
  await cmd('/effect give @s minecraft:regeneration 20 5 true')
  await sleep(5000)
  await cmd('/effect clear @s')
  return quickHeal()
}

// Instant, so it can also be used after the mobs are already in the world.
// Regeneration does not always finish before the bell (a bout started at 18
// instead of 20, and 2 hp is one zombie hit), and a skeleton summoned ten
// blocks down a straight drift starts shooting during the summon commands
// themselves — case 3b opened at 17 hp for exactly that reason, which made it
// measure something other than what its name says.
async function quickHeal (label = '') {
  for (let i = 0; i < 3; i++) {
    const st = await call('status')
    if (st.state.health >= 20) return
    await cmd('/effect give @s minecraft:instant_health 1 10 true')
    await sleep(400)
  }
  const st = await call('status')
  if (st.state.health < 20) console.log(`   ВНИМАНИЕ${label}: старт с ${st.state.health} хп, а не с 20`)
}

const stones = st => (st.inventory && st.inventory.cobblestone) || 0

// ------------------------------------------------------------------ verdict

let bad = 0
let skipped = 0

function verdict (label, problem, skip = false) {
  if (skip) {
    skipped++
    console.log(`[ПРОП] ${label} — ${problem}`)
  } else if (problem) {
    bad++
    console.log(`[ПЛОХО] ${label} — ${problem}`)
  } else {
    console.log(`[ OK ]  ${label}`)
  }
}

// ------------------------------------------------------------------- bouts

// The arena lives in a 30x30 box. A body outside it came back from the world
// spawn, which is the only way it gets there.
const ARENA = (p) => p.x >= 395 && p.x <= 435 && p.z >= 395 && p.z <= 435

async function bout ({ label, expect, setup, summon, params, check }, { quiet = false } = {}) {
  console.log(`\n=== ${label} ===`)
  console.log(`ждём: ${expect}`)
  await arena(setup.kind, setup)
  for (const s of summon) await cmd(`/summon minecraft:${s}`)
  await sleep(1200)
  // Anything with a bow has been shooting since the moment it was summoned.
  await quickHeal(' перед боем')

  const before = await call('status')
  let watching = true
  const track = []
  const watcher = (async () => {
    while (watching) {
      try {
        const st = await call('status')
        track.push(`hp${st.state.health}@${st.state.pos.x},${st.state.pos.z}`)
      } catch {}
      await sleep(900)
    }
  })()

  const r = await call('fight', params).catch(e => ({ status: 'RPC', error: e.message }))
  watching = false
  await watcher

  const after = await call('status')
  const died = (r.by && r.by.type === 'death') ||
    (r.events || []).some(e => e.type === 'death') ||
    !ARENA(after.state.pos)
  const problem = r.status === 'failed' ? ` ← ${r.error}` : r.status === 'timeout' ? ' ← таймаут' : ''
  console.log(`драка ${String(r.status).padEnd(11)} ${JSON.stringify(r.detail ?? null)}${problem}${died ? '  ← УМЕР' : ''}`)
  console.log('трасса:', track.join(' '))
  console.log(
    `hp ${before.state.health} -> ${after.state.health} | ` +
    `${JSON.stringify(before.state.pos)} -> ${JSON.stringify(after.state.pos)} | ` +
    `камня ${stones(before.state)} -> ${stones(after.state)}`)

  // The honest test of a seal: stand still and see whether anything still
  // reaches us. A wall that is up but leaky shows here and nowhere else.
  await sleep(6000)
  const rest = await call('status')
  const bled = after.state.health - rest.state.health
  console.log(`после боя, 6с покоя: hp ${after.state.health} -> ${rest.state.health}` +
    (bled > 0 ? '  ← до бота всё ещё достают' : ''))

  // Death first, always. The report on a corpse last time was "не похоже на
  // старое поведение: {}", and working out that it was a corpse cost a round
  // trip through the coordinator.
  const info = {
    status: r.status,
    d: r.detail || {},
    died,
    before: before.state,
    after: after.state,
    rest: rest.state,
    spent: died ? null : stones(before.state) - stones(after.state),
    bled
  }
  info.problem = died
    ? `умер (тело вернулось на ${after.state.pos.x},${after.state.pos.y},${after.state.pos.z})`
    : check(info)
  if (!quiet) verdict(label, info.problem)
  return info
}

// One fight between two mobs is a coin flip, not a control: which of them
// findTarget picks decides which doctrine runs, and the two are opposites.
// Repeat it and judge the set.
async function repeated (spec, times) {
  const runs = []
  for (let i = 1; i <= times; i++) {
    runs.push(await bout({ ...spec, label: `${spec.label} (${i}/${times})` }, { quiet: true }))
  }
  console.log(`
сводка «${spec.label}»:`)
  for (const [i, r] of runs.entries()) {
    console.log(`  ${i + 1}: ${r.died ? 'УМЕР' : (r.d.mode || (r.d.killed ? 'убил ' + r.d.killed : r.status))}` +
      `, цель ${r.d.from || r.d.killed || r.d.target || '?'}, hp ${r.before.health} -> ${r.died ? 0 : r.after.health}`)
  }
  const deaths = runs.filter(r => r.died).length
  verdict(spec.label, deaths ? `умер в ${deaths} из ${times}` : null)
}

// The one path where the bot is NOT chasing: the autopilot notices low health
// with a mob nearby and calls retreat() on its own. This is the only way a
// melee seal ever gets attempted at range, so it is the only way to measure
// whether it fits at all.
async function autopilotBout () {
  const label = '9. автопилот на низком хп, зомби в десяти блоках'
  console.log(`\n=== ${label} ===`)
  console.log('ждём: запечатал штрек (или убил), хп не падает дальше')
  await arena('drift', {})
  await cmd(`/summon minecraft:zombie ${START + 10}.5 ${Y} ${Z}.5`)
  await sleep(800)

  // lowHealth is 8 in config. starve bypasses armour, so the number lands
  // where it is aimed instead of being eaten by the iron chestplate.
  await cmd('/damage @s 13 minecraft:starve')
  await sleep(600)
  const hurt = await call('status')
  if (hurt.state.health > 8) {
    verdict(label, `/damage не сработал, хп ${hurt.state.health} — автопилот не проснётся`, true)
    return
  }

  const r = await call('wait', { seconds: 15 })
  const after = await call('status')
  const fled = (r.events || []).filter(e => e.type === 'fleeing')
  console.log(`события: ${(r.events || []).map(e => e.type).join(', ') || '—'}`)
  console.log(`hp ${hurt.state.health} -> ${after.state.health} | камня ${stones(hurt.state)} -> ${stones(after.state)}`)

  await sleep(6000)
  const rest = await call('status')
  console.log(`ещё 6с покоя: hp ${after.state.health} -> ${rest.state.health}`)

  if (!fled.length) return verdict(label, 'автопилот не сработал (нет события fleeing)')
  if (rest.state.health <= 0) return verdict(label, 'умер')
  if (rest.state.health < hurt.state.health) {
    return verdict(label, `хп продолжало падать ${hurt.state.health} -> ${rest.state.health}: ни стены, ни победы`)
  }
  verdict(label, null)
}

// -------------------------------------------------------------------- run

const OPEN_GROUND = ['заложился блоком', 'встал на столб', 'ушёл за укрытие']

ws.on('open', async () => {
  try {
    await call('connect')

    // 1. The literal case from diamond4.log. Before the doctrine changed this
    //    one went 20 hp to 1 without placing a single block out of 64.
    await bout({
      label: '1. штрек: зомби в шести блоках',
      expect: 'убил (или запечатал), хп не ниже 8',
      setup: { kind: 'drift' },
      summon: [`zombie ${START + 6}.5 ${Y} ${Z}.5`],
      params: { target: 'zombie', retreatAtHealth: 19, timeoutSeconds: 45 },
      check: ({ d, after }) => {
        if (!d.killed && !d.sealed) return `ни убил, ни запечатал: ${d.mode || JSON.stringify(d)}`
        if (/отош|тупик|столб|укрыт/.test(d.mode || '')) return `отступал в штреке: ${d.mode}`
        if (after.health < 8) return `выжил на ${after.health} хп — слишком дорого`
        return null
      }
    })

    // 2. Contact already made: the square the wall needs is occupied, so the
    //    only answer left is the sword.
    await bout({
      label: '2. штрек: зомби вплотную',
      expect: 'убил, потеряв не больше 10 хп',
      setup: { kind: 'drift' },
      summon: [`zombie ${START + 1}.5 ${Y} ${Z}.5`],
      params: { target: 'zombie', retreatAtHealth: 19, timeoutSeconds: 45 },
      check: ({ d, before, after }) => {
        if (!d.killed) return `не убил: ${d.mode || JSON.stringify(d)}`
        const lost = before.health - after.health
        return lost > 10 ? `потерял ${lost} хп` : null
      }
    })

    // 3. The archer. This one worked on the first run and must keep working:
    //    it is the entire reason the seal exists.
    await bout({
      label: '3. штрек: скелет в десяти блоках',
      expect: 'запечатал С МЕСТА: swings 0, стена у ' + (START + 1) + ', ноль урона',
      setup: { kind: 'drift' },
      summon: [`skeleton ${START + 10}.5 ${Y} ${Z}.5`],
      params: { target: 'skeleton', retreatAtHealth: 19, timeoutSeconds: 45 },
      // Where the wall went up matters as much as that it went up. The run
      // that walked nine blocks into the line still reported sealed: true, and
      // only the coordinates gave it away.
      check: ({ d, spent, bled, before, after }) => {
        if (!d.sealed) return `не запечатал: ${d.mode || JSON.stringify(d)}`
        if (d.swings) return `сначала полез в ближний бой: ${d.swings} взмаха`
        if (!d.at || d.at.x > START + 2) {
          return `стена у ${d.at ? d.at.x : '?'}, а не у ${START + 1}: шёл навстречу стрелку`
        }
        if (spent < 2) return `потратил ${spent} блока — стрелок стреляет поверх одного`
        if (before.health - after.health > 0) return `получил ${before.health - after.health} урона`
        return bled > 0 ? `в покое потерял ещё ${bled} хп — стена дырявая` : null
      }
    })

    // The other half of the same rule: told to actually kill it, the bot must
    // still go and kill it rather than hiding behind a wall.
    await bout({
      label: '3b. штрек: скелет, приказано убить (порог 6)',
      expect: 'пошёл в бой, а не заложился с места; стена только если добрался до порога 6',
      setup: { kind: 'drift' },
      summon: [`skeleton ${START + 10}.5 ${Y} ${Z}.5`],
      params: { target: 'skeleton', retreatAtHealth: 6, timeoutSeconds: 60 },
      // The first version of this check asserted "не заложился" outright and
      // failed on a run that had obeyed perfectly: the bot walked fifteen
      // blocks, landed two swings and only then hit retreatAtHealth, where
      // sealing is what the doctrine says to do. What has to be asserted is
      // that it went, not that it never built anything.
      check: ({ d }) => {
        const startedAtWall = d.sealed && d.at && d.at.x <= START + 2
        if (startedAtWall) return `заложился с места (${d.at.x}) вместо приказанного боя: ${d.why || ''}`
        if (d.killed) return null
        if (d.sealed) {
          return d.health > 6
            ? `заложился на ${d.health} хп, хотя порог 6: ${d.why || d.mode}`
            : null
        }
        return `ни боя, ни стены: ${d.mode || JSON.stringify(d)}`
      }
    })

    // 4. Nothing to build with. Running is the measured death, so: fight.
    await bout({
      label: '4. штрек: строить нечем',
      expect: 'убил, stoodGround объясняет почему не отступал',
      setup: { kind: 'drift', blocks: false },
      summon: [`zombie ${START + 4}.5 ${Y} ${Z}.5`],
      params: { target: 'zombie', retreatAtHealth: 19, timeoutSeconds: 60 },
      check: ({ d }) => (d.killed ? null : `не убил: ${d.mode || JSON.stringify(d)}`)
    })

    // 5. Was the axis walk. It is gone now: runs 5 and 6 of the first pass
    //    walked away and were eaten standing, 17 -> 3 and 14 -> 4.
    await bout({
      label: '5. штрек: строить нечем, зомби в четырёх блоках',
      expect: 'убил и НЕ отходил по штреку',
      setup: { kind: 'drift', blocks: false },
      summon: [`zombie ${START + 4}.5 ${Y} ${Z}.5`],
      params: { target: 'zombie', retreatAtHealth: 19, timeoutSeconds: 60 },
      check: ({ d }) => {
        if (/отош/.test(d.mode || '')) return `всё ещё отходит: ${d.mode}`
        return d.killed ? null : `не убил: ${d.mode || JSON.stringify(d)}`
      }
    })

    // 6. Dead end behind, nothing to build with. The honest answer is the same
    //    one: fight. "Тупик" as a verdict was a way of dying politely.
    await bout({
      label: '6. тупик, строить нечем',
      expect: 'убил, без вердикта «тупик»',
      setup: { kind: 'deadend', blocks: false },
      summon: [`zombie ${START + 4}.5 ${Y} ${Z}.5`],
      params: { target: 'zombie', retreatAtHealth: 19, timeoutSeconds: 60 },
      check: ({ d }) => {
        if (/тупик/.test(d.mode || '')) return `сдался вердиктом «тупик»: ${d.mode}`
        return d.killed ? null : `не убил: ${d.mode || JSON.stringify(d)}`
      }
    })

    // 7. The cave. This is where the expedition actually died: the drift broke
    //    into an open underground room at y=-31 and the open-ground doctrine
    //    ran there, spending fourteen seconds on a pillar that cannot go up
    //    under a three-block roof and a run the pathfinder has to dig. The bot
    //    took fourteen hits in full iron without swinging once.
    const CAVE = `419.5 ${Y} 409.5`

    await bout({
      label: '7a. пещера: один зомби',
      expect: 'убил, блоков не тратил (одна сторона контакта и так одна)',
      setup: { kind: 'cave', standAt: CAVE },
      summon: [`zombie 423.5 ${Y} 409.5`],
      params: { target: 'zombie', retreatAtHealth: 19, timeoutSeconds: 60 },
      check: ({ d, after, spent }) => {
        if (!d.killed) return `не убил: ${d.mode || JSON.stringify(d)}`
        if (spent > 2) return `потратил ${spent} блока на одного моба`
        return after.health < 10 ? `выжил на ${after.health} хп` : null
      }
    })

    // Two walkers from opposite sides: the case where standing and swinging is
    // supposed to either hold or say plainly that it cannot.
    await bout({
      label: '7b. пещера: два зомби с разных сторон',
      expect: 'закрылся с флангов (sides <= 2) и убил',
      setup: { kind: 'cave', standAt: CAVE },
      summon: [`zombie 423.5 ${Y} 409.5`, `zombie 415.5 ${Y} 409.5`],
      params: { retreatAtHealth: 19, timeoutSeconds: 90 },
      check: ({ d, after }) => {
        console.log(`   мобов ${d.mobs ?? '?'}, потолок ${d.roof ?? '?'}, ` +
          `сторон осталось ${d.sides ?? '?'}, заложил ${d.shielded ?? 0}`)
        if (!d.cave && !d.killed) return `не узнал пещеру: ${d.mode || JSON.stringify(d)}`
        if (!d.killed && d.sides > 2) return `не закрылся: сторон ${d.sides}, заложил ${d.shielded}`
        return after.health < 6 ? `выжил на ${after.health} хп` : null
      }
    })

    // The archer underground. Its doctrine is untouched by any of this and has
    // to stay untouched.
    await bout({
      label: '7c. пещера: скелет',
      expect: 'заложился блоком или ушёл за укрытие, выжил',
      setup: { kind: 'cave', standAt: CAVE },
      summon: [`skeleton 427.5 ${Y} 409.5`],
      params: { target: 'skeleton', retreatAtHealth: 19, timeoutSeconds: 60 },
      check: ({ d }) => {
        if (d.killed) return null
        return OPEN_GROUND.includes(d.mode) || /убеж|отош/.test(d.mode || '')
          ? null
          : `не похоже на дальнобойную ветку: ${d.mode || JSON.stringify(d)}`
      }
    })

    // Three at once with nothing to build: the doctrine has to come back with
    // an honest report rather than dying quietly. Repeated, because which mob
    // findTarget picks still varies.
    await repeated({
      label: '7d. пещера: трое, строить нечем',
      expect: 'выжил во всех трёх (или честно доложил, что место плохое)',
      setup: { kind: 'cave', standAt: CAVE, blocks: false },
      summon: [`zombie 422.5 ${Y} 409.5`, `zombie 416.5 ${Y} 409.5`, `zombie 419.5 ${Y} 412.5`],
      params: { retreatAtHealth: 19, timeoutSeconds: 90 },
      check: () => null
    }, 3)

    // 7e. Open sky, which is the only honest control for the open-ground
    //     doctrine now that case 7 has become a cave. Nothing above the bot,
    //     terrain to walk on, a pillar that can actually go up.
    await bout({
      label: '7e. контроль: открытое небо, зомби и скелет',
      expect: 'старое поведение: заложился блоком / столб / укрытие; cave не выставлен',
      setup: { kind: 'sky' },
      summon: ['zombie 419.5 80 415.5', 'skeleton 411.5 80 415.5'],
      params: { retreatAtHealth: 19, timeoutSeconds: 60 },
      check: ({ d }) => {
        if (d.cave || d.corridor) return `небо приняло за подземелье: ${JSON.stringify(d)}`
        if (d.killed) return null
        return OPEN_GROUND.includes(d.mode) || /убеж|отош/.test(d.mode || '')
          ? null
          : `не похоже на старое поведение: ${d.mode || JSON.stringify(d)}`
      }
    })

    // 8. Does the melee seal ever fit inside fight()? fight() chases, so the
    //    distance is spent before health ever drops — this run is here to show
    //    that plainly rather than leave it assumed.
    await bout({
      label: '8. штрек: зомби в десяти блоках, камня 64',
      expect: 'убил или запечатал; печать успевает только если бот не бежал навстречу',
      setup: { kind: 'drift' },
      summon: [`zombie ${START + 10}.5 ${Y} ${Z}.5`],
      params: { target: 'zombie', retreatAtHealth: 19, timeoutSeconds: 60 },
      check: ({ d, after, spent }) => {
        console.log(`   печать сработала: ${d.sealed ? 'да, блоков ' + spent : 'нет'}; stoodGround: ${d.stoodGround || '—'}`)
        if (!d.killed && !d.sealed) return `ни убил, ни запечатал: ${d.mode || JSON.stringify(d)}`
        return after.health < 8 ? `выжил на ${after.health} хп` : null
      }
    })

    // 9. The autopilot path, where the bot is standing still and the seal gets
    //    a fair chance at range.
    await autopilotBout()

    await cmd('/kill @e[type=!player,type=!item]')
  } catch (e) {
    console.error('FAILED:', e.message)
    bad++
  } finally {
    console.log(`\nитог: ${bad ? bad + ' ПЛОХО' : 'всё OK'}${skipped ? `, пропущено ${skipped}` : ''}`)
    process.exitCode = bad ? 1 : 0
    ws.close()
  }
})
ws.on('error', e => { console.error('ws:', e.message); process.exitCode = 1 })
