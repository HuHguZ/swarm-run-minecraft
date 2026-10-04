'use strict'
// Короткая проверка общей защиты. Только выделенные миры фермы. Команды
// оператора создают сцену; после fixtureReady измеряется обычный survival.
const fs = require('fs')
const { connect, createKit, sleep } = require('./scene-kit')
const ROOT = 1200
async function main () {
  const slot = Number(process.env.FARM_SLOT)
  if (!(slot >= 1 && slot <= 10) || process.env.ND_WS !== `ws://127.0.0.1:${8800 + slot}` || process.env.MC_USERNAME !== `NeuroFarm${slot}`) throw new Error('только ферма')
  const conn = connect(process.env.ND_WS)
  const result = { labFixture: true, slot, ok: false, method: slot <= 5 ? 'blaze' : 'fight', noFood: slot === 2 || slot === 7,
    healthyEntry: process.env.HEALTHY_ENTRY === '1' }
  const timer = setTimeout(() => conn.ws.terminate(), 150000)
  let poll = null
  try {
    await conn.ready
    await conn.call('connect')
    await conn.call('stop')
    if ((await conn.call('status')).detail.server !== `127.0.0.1:${25600 + slot}`) throw new Error('не сервер фермы')
    const kit = createKit({ call: conn.call, heard: conn.heard, logFile: process.env.ND_SERVER_LOG, player: process.env.MC_USERNAME })
    const cmd = async text => { const r = await kit.cmd(text); if (!r.ok) throw new Error('не подтверждена команда: ' + text) }
    await cmd('/gamemode creative')
    await kit.setDifficulty('normal')
    await kit.gamerule('spawn_mobs', false)
    await kit.gamerule('keep_inventory', false)
    await kit.forceload('the_nether', [[ROOT - 24, 98, ROOT - 24], [ROOT + 24, 106, ROOT + 24]])
    // fillExact делает контрольную заливку камнем. Тело держим выше неё,
    // чтобы подготовка не столкнула игрока под платформу в природную лаву.
    await kit.ensureWorld('the_nether', { tp: `${ROOT}.5 112 ${ROOT}.5` })
    // Замкнутая оболочка удерживает природную лаву за границами сцены.
    await kit.fillExact('the_nether', [[ROOT - 24, 99, ROOT - 24], [ROOT + 24, 107, ROOT + 24]], 'stone')
    await kit.fillExact('the_nether', [[ROOT - 23, 100, ROOT - 23], [ROOT + 23, 106, ROOT + 23]], 'air')
    // Угол даёт реальное укрытие, если бот выберет его вместо коробки.
    await kit.fillExact('the_nether', [[ROOT - 12, 100, ROOT - 12], [ROOT - 12, 103, ROOT + 12]], 'stone')
    await kit.fillExact('the_nether', [[ROOT - 12, 100, ROOT - 12], [ROOT + 12, 103, ROOT - 12]], 'stone')
    await cmd(`/setblock ${ROOT + 5} 100 ${ROOT} minecraft:spawner{SpawnData:{entity:{id:"minecraft:blaze"}},Delay:32767s}`)
    await kit.ensureWorld('the_nether', { floor: 'stone', tp: `${ROOT}.5 100 ${ROOT}.5` })
    await sleep(200)
    let fire = null
    for (let n = 0; n < 18; n++) {
      const witness = await conn.call('ask', { command: '/data get entity @s Fire', match: ': [-\\d]+s$', ms: 1000 })
      const line = witness.detail?.lines?.find(s => /: [-\d]+s$/.test(s))
      if (line) fire = Number(/: ([-\d]+)s$/.exec(line)[1])
      if (fire !== null && fire <= 0) break
      await sleep(1000)
    }
    result.fireBefore = fire
    if (fire === null || fire > 0) throw new Error('перед измерением тело ещё горит от подготовки')
    await cmd('/kill @e[type=minecraft:blaze,distance=..64]')
    await cmd('/clear @s')
    for (const item of ['iron_chestplate', 'iron_boots', 'iron_sword', 'shield', 'stone_pickaxe', 'cobblestone 32', ...(result.noFood ? [] : ['melon_slice 9', 'cooked_mutton 1'])]) await cmd('/give @s minecraft:' + item)
    await conn.call('armor')
    await cmd('/effect clear @s')
    await cmd('/effect give @s minecraft:instant_health 1 10 true')
    await cmd('/effect give @s minecraft:saturation 1 20 true')
    await sleep(150)
    await cmd('/effect clear @s')
    await cmd(`/summon minecraft:blaze ${ROOT}.5 100 ${ROOT + 2}.9 {NoAI:1b,PersistenceRequired:1b,Tags:["nd_safety"]}`)
    if (result.healthyEntry) {
      for (const dx of [-2.4, 2.4]) await cmd(`/summon minecraft:blaze ${ROOT + 0.5 + dx} 100 ${ROOT}.5 {NoAI:1b,PersistenceRequired:1b,Tags:["nd_safety"]}`)
    }
    await cmd('/gamemode survival')
    if (!result.noFood && !result.healthyEntry) {
      await cmd('/damage @s 12 minecraft:magic')
      // Командный ответ приходит раньше клиентского пакета здоровья.
      const until = Date.now() + 1500
      while (Date.now() < until && (await conn.call('status')).state.health > 12) await sleep(50)
    }
    await cmd('/execute as @e[type=blaze,tag=nd_safety] run data merge entity @s {NoAI:0b}')
    result.before = (await conn.call('status')).state
    if (result.before.dimension !== 'the_nether' || result.before.pos.y !== 100 || result.before.health <= 0 ||
      (!result.noFood && !result.healthyEntry && result.before.health > 12) || !result.before.inventory.iron_sword) throw new Error('не готова сцена давления')
    result.fixtureReady = true
    // Начиная отсюда никакой помощи командами. Состояние раз в 250 мс.
    result.minHp = result.before.health
    result.hpMax = result.before.health
    result.maxRan = 0
    let polling = false
    poll = setInterval(async () => {
      if (polling) return
      polling = true
      try {
        const s = (await conn.call('status')).state
        result.minHp = Math.min(result.minHp, s.health)
        result.hpMax = Math.max(result.hpMax, s.health)
        if (s.dimension === result.before.dimension) result.maxRan = Math.max(result.maxRan,
          Math.hypot(s.pos.x - result.before.pos.x, s.pos.z - result.before.pos.z))
      } catch {} finally { polling = false }
    }, 250)
    const t0 = Date.now()
    result.battle = await conn.call(result.method, result.method === 'blaze'
      ? { rods: 1, timeoutSeconds: 30, box: false, restAtHealth: 12 }
      : { target: 'blaze', purpose: 'resource', resourceGoal: { item: 'blaze_rod', count: 1 }, timeoutSeconds: 30 })
    result.elapsedMs = Date.now() - t0
    clearInterval(poll); poll = null
    result.end = (await conn.call('status')).state
    result.minHp = Math.min(result.minHp, result.end.health)
    result.events = conn.heard.filter(e => /death|damage|low_health|flee/.test(e.type))
    result.deaths = Math.max(result.events.filter(e => e.type === 'death').length,
      result.end.lastDeathAt !== result.before.lastDeathAt ? 1 : 0, result.battle.by?.type === 'death' ? 1 : 0)
    const detail = result.battle.detail || {}
    const distance = Math.hypot(result.end.pos.x - result.before.pos.x, result.end.pos.z - result.before.pos.z)
    result.ran = Math.round(distance * 10) / 10
    result.maxRan = Math.max(result.maxRan, result.ran)
    const rejected = /запаса еды|нечем восстановить/.test(detail.stopped || '')
    const recovered = detail.rests?.some(r => r.rested) || result.end.health >= 18
    const escaped = result.maxRan >= 5 || detail.escape?.clear || detail.rests?.some(r => r.escape?.clear && r.rested)
    result.ok = result.deaths === 0 && result.battle.status === 'done' && result.end.dimension === result.before.dimension &&
      result.end.health > 0 && escaped && result.maxRan < 60 &&
      (result.noFood ? rejected : result.method === 'blaze' ? recovered : !!detail.safety)
    // Возврат к спавнеру после лечения не отменяет предыдущего отхода.
    // Дистанция в конце не доказывает отрыв: проверяем весь путь/состояние.
  } catch (e) { result.error = e.message } finally {
    if (poll) clearInterval(poll)
    try { await conn.call('stop'); await conn.call('disconnect') } catch {}
    clearTimeout(timer)
    conn.close()
    fs.appendFileSync(process.env.LAB_OUT, JSON.stringify(result) + '\n')
    console.log(JSON.stringify({ slot, method: result.method, noFood: result.noFood, ok: result.ok,
      fixtureReady: result.fixtureReady, minHp: result.minHp, hp: result.end?.health,
      elapsedMs: result.elapsedMs, deaths: result.deaths, ran: result.ran,
      stopped: result.battle?.detail?.stopped, error: result.error }))
  }
}
main().catch(e => { console.error(e); process.exitCode = 1 })
