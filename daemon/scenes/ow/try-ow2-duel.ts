'use strict'
// Скамья рукопашной (поток ow2, sr27 27.10): один моб против тела с мечом и щитом, без кампании — RPC fight, как его зовёт
// кампания ({timeoutSeconds 45, retreatAtHealth 7}). Замкнутая каменная комната 11×4×11 высоко (y 150, крыша — без солнца),
// ночь, естественный спавн выключен — в комнате ровно один моб. ROUNDS раундов; итог раунда — строка JSON: убит ли моб,
// хп тела до/после, умер ли, секунды, ответ fight. Флаги тела — в env демона (farm.js up), трасса — ND_TRACE_PVP=1.
// MOBS="zombie,skeleton" (по кругу), HEALTH=12 (хп до раунда), DIST=4, KIT (через ;), HUNGER=1 (сытость ≤ 15: без лечения).
// Точное хп моба — только телеметрия сцены (правило: для мобов можно). Только ферма.
// CAMPAIGN=1 — вместо RPC fight тело отдаётся настоящей кампании (campaign.js) на ROUND_S (60) с: кто владеет телом и
// чем кончается контакт — бой, отход, коробка. SIZE=5 — полуширина комнаты (просторнее — есть куда бежать).
import * as fs from 'fs'
import path = require('path')
import { spawn } from 'child_process'
import { connect, createKit, sleep } from '../lib/scene-kit'
import * as gameClock from '../../src/game-clock'

const ROUNDS = Math.max(1, Number(process.env.ROUNDS || 10))
const MOBS = String(process.env.MOBS || 'zombie').split(',').map(s => s.trim()).filter(Boolean)
const HEALTH = Number(process.env.HEALTH || 12)
const DIST = Number(process.env.DIST || 4)
const KIT = String(process.env.KIT || 'stone_sword;shield;stone_pickaxe;cobblestone 32;torch 4').split(';').map(s => s.trim()).filter(Boolean)
const OUT = process.env.LAB_OUT || 'lab-ow2-duel.jsonl'
const CAMPAIGN = process.env.CAMPAIGN === '1'
const ROUND_S = Number(process.env.ROUND_S || 60)
const SIZE = Math.max(3, Number(process.env.SIZE || 5))
const TUNNEL = process.env.SHAPE === 'tunnel'
// SHAPE=pool — комната залита водой на 2 бл., у края x+ берег (каменная полоса 3 бл. вровень с водой); тело в воде.
const POOL = process.env.SHAPE === 'pool'
const LOG = process.env.ND_SERVER_LOG || ''
const PLAYER = process.env.MC_USERNAME

function deathLines (from: number) {
  try {
    const all = fs.readFileSync(LOG)
    return all.subarray(all.length < from ? 0 : from).toString('utf8').split('\n')
      .filter(l => l.includes(`]: ${PLAYER} `) && /was |died|drowned|burned|fell|blew up|hit the ground|suffocated|starved/.test(l) && !/issued server command/.test(l))
      .map(l => l.replace(/^.*\]: /, '').trim())
  } catch { return [] }
}
const logSize = () => { try { return fs.statSync(LOG).size } catch { return 0 } }

async function main () {
  const slot = Number(process.env.FARM_SLOT)
  if (!(slot >= 1 && slot <= 32) || process.env.ND_WS !== `ws://127.0.0.1:${8800 + slot}`) throw new Error('только ферма')
  const conn = connect(process.env.ND_WS)
  await conn.ready
  const call = conn.call
  const kit = createKit({ call, heard: conn.heard, logFile: LOG, player: PLAYER })
  await call('connect'); await call('stop')
  // Как кампания: режим спидрана (от него зависят правила боя combat-safety).
  await call('play_mode', { mode: 'speedrun', foodTarget: 8 }).catch(() => {})
  const cmd = async (text: string) => { const r = await kit.cmd(text); if (!r.ok) throw new Error('команда не подтверждена: ' + text) }
  const X = 3000 + slot * 64, Y = 150, Z = 3000
  await kit.setDifficulty('normal')
  await kit.gamerule('spawn_mobs', false)
  await kit.gamerule('keep_inventory', true)
  await kit.gamerule('advance_time', false)
  await cmd('/time set 18000')
  await kit.ensureWorld('overworld', { tp: `${X}.5 ${Y + 8} ${Z}.5`, seconds: 20 })
  // Место раунда: комната (SHAPE=room) или штрек 1×2 вдоль x (SHAPE=tunnel) в каменной скорлупе — заново каждый раунд.
  const carve = async () => {
    await kit.fillExact('overworld', [[X - SIZE - 1, Y - 1, Z - SIZE - 1], [X + SIZE + 1, Y + 4, Z + SIZE + 1]], 'stone')
    if (TUNNEL) await kit.fillExact('overworld', [[X - SIZE, Y, Z], [X + SIZE, Y + 1, Z]], 'air')
    else await kit.fillExact('overworld', [[X - SIZE, Y, Z - SIZE], [X + SIZE, Y + 3, Z + SIZE]], 'air')
    if (POOL) {
      await kit.fillExact('overworld', [[X - SIZE, Y, Z - SIZE], [X + SIZE - 3, Y + 1, Z + SIZE]], 'water')
      await kit.fillExact('overworld', [[X + SIZE - 2, Y, Z - SIZE], [X + SIZE, Y + 1, Z + SIZE]], 'stone')
    }
  }
  await carve()
  let diedBefore = false
  for (let round = 1; round <= ROUNDS; round++) {
    const mob = MOBS[(round - 1) % MOBS.length]
    const rec: Record<string, any> = { round, mob, hp0: HEALTH }
    try {
      // После смерти тело (RPC fight) порой не видит новых мобов: «не вижу цель», моб жив — такие раунды не в счёт (died прошлого раунда в rec).
      // Переподключение посреди пошагового мира вешает сцену (peers=0) — не делаю.
      rec.afterDeath = diedBefore
      await call('stop').catch(() => {})
      await cmd('/gamemode creative')
      await kit.cmd(`/kill @e[type=!player,distance=..40,x=${X},y=${Y},z=${Z}]`)
      // Пол и воздух заново (тело могло копать/строить в прошлом раунде); после смерти тело на точке возрождения — сперва сюда.
      await cmd(`/tp @s ${X}.5 ${Y + 8} ${Z}.5`)
      await carve()
      await cmd('/clear @s')
      for (const g of KIT) await cmd(`/give @s minecraft:${g.replace(/\s+/, ' ')}`)
      const yaw = Math.floor(Math.random() * 360)
      await cmd(`/tp @s ${X}.5 ${POOL ? Y + 1 : Y} ${Z}.5 ${yaw} 0`)
      await cmd('/effect clear @s')
      await cmd('/effect give @s minecraft:instant_health 1 10 true')
      await cmd('/effect give @s minecraft:saturation 1 20 true')
      await sleep(300)
      await cmd('/gamemode survival')
      if (process.env.HUNGER !== '0') {
        await cmd('/effect give @s minecraft:hunger 30 200 true')
        const until = gameClock.now() + 15000
        while (gameClock.now() < until && (await call('status')).state.food > 15) await sleep(40)
        await cmd('/effect clear @s minecraft:hunger')
      }
      if (HEALTH < 20) await cmd(`/damage @s ${20 - HEALTH} minecraft:generic`)
      await sleep(500)
      // Мобы: «zombie+skeleton@10» — каждый в своей случайной стороне по горизонтали, в DIST (или @N) бл. (внутри комнаты).
      // В штреке все мобы раунда — с одной стороны (два с разных сторон — отдельный случай «зажали»).
      const side = Math.random() < 0.5 ? 0 : Math.PI
      const summon = async () => {
        for (const spec of mob.split('+')) {
          const [name, at] = spec.split('@')
          const dist = Math.min(SIZE - 0.5, Number(at) || DIST)
          const a = TUNNEL ? side : Math.random() * Math.PI * 2
          const mx = X + 0.5 + Math.cos(a) * dist - (POOL ? 1.5 : 0), mz = Z + 0.5 + Math.sin(a) * dist
          await cmd(`/summon minecraft:${name} ${mx.toFixed(2)} ${Y} ${mz.toFixed(2)} {PersistenceRequired:1b,Tags:["nd_duel"]}`)
        }
      }
      // Кампания (CAMPAIGN=1) стартует до мобов: иначе моб бьёт, пока она подключается (c2: хп 12 → 9 до первой строки журнала).
      const clog = OUT.replace(/\.jsonl$/, '') + `-r${round}.campaign.log`
      let child = null
      if (CAMPAIGN) {
        try { fs.writeFileSync(clog, '') } catch {}
        child = spawn(process.execPath, ['campaign.js'], { cwd: path.join(__dirname, '..', '..'), env: { ...process.env, ND_CAMPAIGN_LOG: clog }, stdio: 'ignore' })
        const until = gameClock.now() + 30000
        while (gameClock.now() < until && !/старт:/.test((() => { try { return fs.readFileSync(clog, 'utf8') } catch { return '' } })())) await sleep(200)
      }
      await summon()
      await sleep(300)
      const size = logSize()
      const t0 = gameClock.now()
      let minHp = 20
      const poll = gameClock.wall.setInterval(async () => {
        try { const pk = await call('peek'); const h = pk?.state?.health; if (typeof h === 'number') minHp = Math.min(minHp, h) } catch {}
      }, 200)
      // Ответ «Test passed» в журнал сервера не пишется — живость по ответу effect (он идёт в журнал).
      // Живы ли мобы раунда — по сущностям, которые видит клиент тела (комната замкнута, других мобов нет; ответы execute в журнал не идут).
      const names = new Set(mob.split('+').map(x => x.split('@')[0]))
      const aliveNow = async () => { try { return ((await call('peek'))?.detail?.foes || []).some(f => names.has(f.name) && f.d < 24) } catch { return true } }
      if (CAMPAIGN) {
        // Кампания владеет телом (тактика, отходы, бой — как в полном проходе); раунд — до гибели мобов + 5 с, смерти или ROUND_S.
        let killedAt = null
        try {
          while (gameClock.now() - t0 < ROUND_S * 1000) {
            await sleep(1000)
            if (deathLines(size).length) break
            if (killedAt === null && !(await aliveNow())) killedAt = gameClock.now()
            if (killedAt !== null && gameClock.now() - killedAt > 5000) break
          }
        } finally { try { child.kill() } catch {} gameClock.wall.clearInterval(poll) }
        rec.sec = Math.round((gameClock.now() - t0) / 100) / 10
        rec.killS = killedAt === null ? null : Math.round((killedAt - t0) / 100) / 10
        let text = ''
        try { text = fs.readFileSync(clog, 'utf8') } catch {}
        rec.tail = text.split('\n').filter(l => / (fight|refuge|flee|shelter|surface|pillar) \{|отход|бой/.test(l)).slice(0, 8).map(l => l.replace(/^\[[^\]]+\] /, '').slice(0, 200))
      } else {
        let r: any
        try { r = await call('fight', { target: mob.split(/[+@]/)[0], timeoutSeconds: 45, retreatAtHealth: 7 }) } catch (e) { r = { error: e.message } } finally { gameClock.wall.clearInterval(poll) }
        rec.sec = Math.round((gameClock.now() - t0) / 100) / 10
        const d = r?.detail || r || {}
        rec.status = r?.status || null
        rec.fight = JSON.stringify({ killed: d.killed, kills: d.kills, swings: d.swings, hits: d.hits, stopped: d.stopped, skipped: d.skipped, retreated: d.retreated, mode: d.mode, lowHealth: d.lowHealth, timeout: d.timeout, lost: d.lost, error: r?.error }).slice(0, 400)
      }
      await call('stop').catch(() => {})
      await sleep(800)
      rec.mobAlive = await aliveNow()
      if (rec.mobAlive) {
        const h = await kit.cmd('/data get entity @e[tag=nd_duel,limit=1] Health', { reply: /has the following entity data|Found no/ })
        const m = /([\d.]+)f/.exec(String(h.reply || ''))
        rec.mobHp = m ? +m[1] : null
      }
      const deaths = deathLines(size)
      rec.died = deaths.length > 0
      rec.death = deaths[0] || null
      const st = (await call('peek').catch(() => null))?.state
      rec.hp1 = st ? Math.round(st.health) : null
      rec.minHp = Math.round(minHp)
    } catch (e) { rec.error = e.message }
    if (rec.died) diedBefore = true
    console.log(JSON.stringify(rec))
    fs.appendFileSync(OUT, JSON.stringify(rec) + '\n')
    await sleep(1500)
  }
  await kit.cmd('/gamerule advance_time true').catch(() => {})
  await call('disconnect', { reason: 'try-ow2-duel окончена' }).catch(() => {})
  process.exit(0)
}
main().catch(e => { console.error(e); process.exit(1) })
