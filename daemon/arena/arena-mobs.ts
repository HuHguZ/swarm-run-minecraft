import { REPO_ROOT } from '../src/paths'
import * as gameClock from '../src/game-clock'
﻿'use strict'
// Арена против мобов на тестовом Paper: волны по типам, у бота — набор под
// волну. Бот зачищает арену одним fight с clearArea (pvp.js duel).
//   ND_WS=ws://127.0.0.1:8767 node arena-mobs.js [фильтр волны]
// Смотреть: клиент 1.21.11 -> 127.0.0.1:25565. Кто зайдёт, того скрипт
// переводит в наблюдатели и ставит над ареной.
import WebSocket = require('ws')
import * as fs from 'fs'
import path = require('path')

const URL = process.env.ND_WS || 'ws://127.0.0.1:8767'
const ONLY = process.argv[2] || null
const LOG = path.join(REPO_ROOT, 'daemon/arena-mobs.log')
const WATCHERS = (process.env.ARENA_WATCH || 'HuHguZ').split(',')
// Люди в команде с ботом: получают тот же набор и встают рядом.
const PLAYERS = (process.env.ARENA_PLAYERS || '').split(',').map(x => x.trim()).filter(Boolean)

const ws = new WebSocket(URL)
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
const log = (...a) => {
  const line = `[${new Date().toISOString().slice(11, 19)}] ${a.join(' ')}`
  console.log(line)
  fs.appendFileSync(LOG, line + '\n')
}
// Пауза между командами растягивала выдачу наборов на минуты. В LAN с читами
// бот оператор, и антиспам его не кикает (2026-09-25 ни одного кика за спам) —
// пауза нужна только на чужом сервере: ARENA_THROTTLE=1.
const THROTTLE = !!process.env.ARENA_THROTTLE
async function cmd (text) { await call('say', { text }); if (THROTTLE) await sleep(300) }

// ARENA_POS="x y z" — центр и уровень пола. ARENA_GENTLE=1 — чужой мир: время,
// правила и режимы игроков не трогаем, убираем только своё (метка arena).
const POS = (process.env.ARENA_POS || '200 100 200').split(/\s+/).map(Number)
const X = POS[0]; const Y = POS[1]; const Z = POS[2]
const GENTLE = !!process.env.ARENA_GENTLE
// Полуразмер и высота: гастам нужно небо (4×4×4 блока, стреляют сверху).
const R = Number(process.env.ARENA_R || 30)
const H = Number(process.env.ARENA_H || 20)
const BOX = `x=${X - R},y=${Y - 1},z=${Z - R},dx=${2 * R},dy=${H + 1},dz=${2 * R}`

// /fill берёт не больше 32768 блоков — большие объёмы режем по высоте.
async function fillBox (x1, y1, z1, x2, y2, z2, block) {
  const area = (Math.abs(x2 - x1) + 1) * (Math.abs(z2 - z1) + 1)
  const step = Math.max(1, Math.floor(32768 / area))
  for (let y = Math.min(y1, y2); y <= Math.max(y1, y2); y += step) {
    const top = Math.min(Math.max(y1, y2), y + step - 1)
    await cmd(`/fill ${x1} ${y} ${z1} ${x2} ${top} ${z2} ${block}`)
  }
}

async function buildArena () {
  const x1 = X - R; const x2 = X + R; const z1 = Z - R; const z2 = Z + R
  await fillBox(x1, Y, z1, x2, Y + H - 1, z2, 'minecraft:air')
  await fillBox(x1, Y - 1, z1, x2, Y - 1, z2, 'minecraft:smooth_stone')
  // Стены из стекла — смотреть сбоку, крыша из тонированного — солнце не
  // проходит, и нежить не горит.
  await fillBox(x1 - 1, Y - 1, z1 - 1, x1 - 1, Y + H, z2 + 1, 'minecraft:glass')
  await fillBox(x2 + 1, Y - 1, z1 - 1, x2 + 1, Y + H, z2 + 1, 'minecraft:glass')
  await fillBox(x1 - 1, Y - 1, z1 - 1, x2 + 1, Y + H, z1 - 1, 'minecraft:glass')
  await fillBox(x1 - 1, Y - 1, z2 + 1, x2 + 1, Y + H, z2 + 1, 'minecraft:glass')
  await fillBox(x1, Y + H, z1, x2, Y + H, z2, 'minecraft:tinted_glass')
}

async function resetArena () {
  await fillBox(X - R, Y, Z - R, X + R, Y + H - 1, Z + R, 'minecraft:air')
  await fillBox(X - R, Y - 1, Z - R, X + R, Y - 1, Z + R, 'minecraft:smooth_stone')
  // Опасности: лужа лавы и бассейн воды в полу, по бокам от линии боя. Бот
  // должен обходить лаву, в бою не лезть в воду и бежать к ней, если горит.
  // Под ними — камень, чтобы не протекли вниз (на тестовом сервере арена висит).
  const lx = X + Math.round(R * 0.4); const wx = X - Math.round(R * 0.4)
  await cmd(`/fill ${lx - 2} ${Y - 2} ${Z - 2} ${lx + 2} ${Y - 2} ${Z + 2} minecraft:stone`)
  await cmd(`/fill ${lx - 1} ${Y - 1} ${Z - 1} ${lx + 1} ${Y - 1} ${Z + 1} minecraft:lava`)
  await cmd(`/fill ${wx - 2} ${Y - 3} ${Z - 2} ${wx + 2} ${Y - 3} ${Z + 2} minecraft:stone`)
  await cmd(`/fill ${wx - 2} ${Y - 2} ${Z - 2} ${wx + 2} ${Y - 1} ${Z + 2} minecraft:water`)
}

// Летуны появляются в воздухе, а не на полу.
const AIR = { ghast: 12, phantom: 10, blaze: 4, vex: 6 }
const ME = 'NeuroDown'
const IRON = ['iron_helmet', 'iron_chestplate', 'iron_leggings', 'iron_boots']

const WAVES = [
  { name: 'три зомби', kit: ['iron_sword', ...IRON], mobs: ['zombie', 'zombie', 'husk'] },
  { name: 'два скелета', kit: ['iron_sword', 'shield', ...IRON], mobs: ['skeleton', 'skeleton'] },
  { name: 'криперы', kit: ['iron_sword', ...IRON], mobs: ['creeper', 'creeper'] },
  { name: 'пауки', kit: ['iron_sword', 'cobweb 4', ...IRON], mobs: ['spider', 'spider', 'cave_spider'] },
  { name: 'ведьма и зомби', kit: ['iron_sword', 'shield', ...IRON], mobs: ['witch', 'zombie', 'zombie'] },
  {
    name: 'орда',
    kit: ['diamond_sword', 'shield', 'bow', 'arrow 32', 'golden_apple 3', 'cooked_beef 16', ...IRON],
    mobs: ['zombie', 'zombie', 'husk', 'skeleton', 'skeleton', 'creeper', 'spider']
  },
  { name: 'гасты', kit: ['bow', 'arrow 64', 'iron_sword', 'golden_apple 2', ...IRON], mobs: ['ghast', 'ghast'] },
  { name: 'гасты: четыре', kit: ['bow', 'arrow 64', 'iron_sword', 'shield', 'golden_apple 3', 'cooked_beef 8', ...IRON], mobs: ['ghast', 'ghast', 'ghast', 'ghast'] },
  { name: 'гасты: шесть', kit: ['bow', 'arrow 64', 'iron_sword', 'shield', 'golden_apple 3', 'cooked_beef 8', ...IRON], mobs: ['ghast', 'ghast', 'ghast', 'ghast', 'ghast', 'ghast'] },
  { name: 'гасты: десять', kit: ['bow', 'arrow 128', 'iron_sword', 'shield', 'golden_apple 4', 'cooked_beef 8', ...IRON], mobs: Array(10).fill('ghast') },
  { name: 'гасты: пятнадцать и скелеты', kit: ['bow', 'arrow 192', 'diamond_sword', 'shield', 'golden_apple 5', 'cooked_beef 8', 'diamond_helmet', 'diamond_chestplate', 'diamond_leggings', 'diamond_boots'], mobs: [...Array(15).fill('ghast'), 'skeleton', 'skeleton', 'skeleton'] },
  {
    name: 'месиво',
    kit: ['bow', 'arrow 192', 'diamond_sword', 'diamond_axe', 'shield', 'golden_apple 6', 'enchanted_golden_apple 1', 'cooked_beef 16', 'cobweb 8', 'water_bucket', 'ender_pearl 4', 'totem_of_undying', 'diamond_helmet', 'diamond_chestplate', 'diamond_leggings', 'diamond_boots'],
    mobs: [...Array(8).fill('ghast'), 'zombie', 'zombie', 'husk', 'husk', 'skeleton', 'skeleton', 'stray', 'bogged', 'creeper', 'creeper', 'spider', 'cave_spider', 'witch', 'witch', 'vindicator', 'vindicator', 'pillager', 'pillager', 'blaze', 'blaze', 'wither_skeleton', 'wither_skeleton', 'piglin_brute', 'zombie_villager']
  },
  { name: 'гасты и ближники', kit: ['bow', 'arrow 64', 'diamond_sword', 'shield', 'golden_apple 2', ...IRON], mobs: ['ghast', 'zombie', 'zombie', 'skeleton'] },
  // Эндермены телепортируются сквозь стены — только на тестовом сервере.
  { name: 'эндермены', kit: ['diamond_sword', ...IRON], mobs: ['enderman', 'enderman'], testOnly: true }
]

// Выживание: волна n — больше мобов и злее. Пул расширяется с номером волны.
const POOLS = [
  ['zombie', 'husk', 'skeleton'],
  ['zombie', 'husk', 'skeleton', 'spider', 'creeper'],
  ['zombie', 'skeleton', 'stray', 'spider', 'creeper', 'witch', 'cave_spider'],
  ['zombie', 'skeleton', 'creeper', 'witch', 'vindicator', 'pillager', 'bogged', 'ghast'],
  ['vindicator', 'pillager', 'wither_skeleton', 'skeleton', 'creeper', 'witch', 'piglin_brute', 'blaze', 'ghast']
]
function survivalWave (n) {
  const pool = POOLS[Math.min(POOLS.length - 1, Math.floor((n - 1) / 2))]
  const count = Math.min(14, 3 + n)
  const mobs = []
  for (let i = 0; i < count; i++) mobs.push(pool[Math.floor(Math.random() * pool.length)])
  return { name: `выживание, волна ${n} (${count} мобов)`, mobs, keepKit: n > 1, gear: n >= 3 ? Math.min(0.9, 0.15 * (n - 2)) : 0, tier: n }
}

// Снаряжение мобам: броня и оружие. Только тем, кто носит (гуманоиды);
// шанс и уровень растут с волной. Синтаксис 1.21.5+: equipment{slot:{id,count}}.
const WEARS = new Set(['zombie', 'husk', 'drowned', 'skeleton', 'stray', 'bogged', 'wither_skeleton', 'piglin', 'zombified_piglin', 'vindicator', 'pillager', 'zombie_villager'])
const TIERS = ['leather', 'chainmail', 'golden', 'iron', 'diamond', 'netherite']
function gearNbt (mob, chance, wave) {
  if (!chance || !WEARS.has(mob)) return ''
  const top = Math.min(TIERS.length - 1, Math.floor(wave / 3))
  const pick = () => TIERS[Math.max(0, top - Math.floor(Math.random() * 3))]
  const parts = []
  for (const [slot, piece] of [['head', 'helmet'], ['chest', 'chestplate'], ['legs', 'leggings'], ['feet', 'boots']]) {
    if (Math.random() < chance) parts.push(`${slot}:{id:"minecraft:${pick()}_${piece}",count:1}`)
  }
  // Лучникам лук оставляем (иначе они ближники), остальным — меч или топор.
  if (!/skeleton|stray|bogged|pillager/.test(mob) && Math.random() < chance) {
    const w = ['wooden', 'stone', 'iron', 'iron', 'diamond', 'netherite'][Math.min(5, Math.floor(wave / 2))]
    parts.push(`mainhand:{id:"minecraft:${w}_${Math.random() < 0.5 ? 'sword' : 'axe'}",count:1}`)
  }
  return parts.length ? `,equipment:{${parts.join(',')}}` : ''
}
const SURVIVAL_KIT = ['diamond_sword', 'diamond_axe', 'shield', 'bow', 'arrow 64', 'golden_apple 4', 'cooked_beef 32',
  'cobweb 8', 'water_bucket', 'ender_pearl 4', 'totem_of_undying',
  'diamond_helmet', 'diamond_chestplate', 'diamond_leggings', 'diamond_boots']

async function watchers () {
  const st: any = await call('status')
  const online = (st.state && st.state.playersOnline) || []
  if (GENTLE) return
  for (const w of WATCHERS) {
    if (!online.includes(w)) continue
    await cmd(`/gamemode spectator ${w}`)
    await cmd(`/tp ${w} ${X} ${Y + 12} ${Z - 18} 0 30`)
  }
}

async function wave (w) {
  log(`=== волна: ${w.name} ===`)
  // Только своё: мобы с меткой arena и дроп внутри коробки.
  await cmd('/kill @e[tag=arena]')
  // Дикие враги у арены: бот цепляет ближайшего и полез бы к зомби за стеклом.
  for (const t of ['zombie', 'husk', 'drowned', 'skeleton', 'stray', 'creeper', 'spider', 'cave_spider', 'witch', 'zombie_villager']) {
    await cmd(`/kill @e[type=${t},x=${X},y=${Y},z=${Z},distance=..${R + 16}]`)
  }
  await cmd(`/kill @e[type=item,${BOX}]`)
  await cmd(`/kill @e[type=arrow,${BOX}]`)
  await resetArena()
  if (w.keepKit) {
    // Выживание: снаряжение и раны переходят из волны в волну; между
    // волнами — только +4 хп и пополнение стрел и еды.
    await cmd(`/effect give ${ME} minecraft:instant_health 1 0 true`)
    await cmd(`/give ${ME} minecraft:arrow 16`)
    await cmd(`/give ${ME} minecraft:cooked_beef 4`)
  } else {
    await cmd(`/clear ${ME}`)
    await cmd(`/effect clear ${ME}`)
    for (const it of w.kit) {
      const [name, n] = it.split(' ')
      await cmd(`/give ${ME} minecraft:${name} ${n || 1}`)
    }
    await cmd(`/effect give ${ME} minecraft:instant_health 1 10 true`)
    await cmd(`/effect give ${ME} minecraft:saturation 1 20 true`)
  }
  // Бот у одного края, мобы — у дальнего, веером; летуны — в воздухе.
  const back = Math.round(R * 0.6)
  await cmd(`/tp ${ME} ${X} ${Y} ${Z - back} 0 0`)
  await call('armor')
  // Вышедший из игры выбывает: ему не выдаём и не телепортируем (просьба
  // 2026-09-25 — «если игрок вышел, арена работает без него»).
  const st0 = await call('status').catch(() => null)
  const on = st0 && st0.state && st0.state.playersOnline
  const players = Array.isArray(on) ? PLAYERS.filter(p => on.includes(p)) : PLAYERS
  const gone = PLAYERS.filter(p => !players.includes(p))
  if (gone.length) log(`вышли: ${gone.join(', ')} — волна без них`)
  for (let i = 0; i < players.length; i++) {
    const p = players[i]
    await cmd(`/gamemode survival ${p}`)
    await cmd(`/clear ${p}`)
    for (const it of (w.kit || SURVIVAL_KIT)) {
      const [name, n] = it.split(' ')
      await cmd(`/give ${p} minecraft:${name} ${n || 1}`)
    }
    await cmd(`/effect give ${p} minecraft:instant_health 1 10 true`)
    await cmd(`/effect give ${p} minecraft:saturation 1 20 true`)
    await cmd(`/tp ${p} ${X + (i % 2 ? 4 : -4) * (1 + Math.floor(i / 2))} ${Y} ${Z - back} 0 0`)
  }
  if (players.length) await cmd(`/say Волна: ${w.name}! Фаерболы отбивайте ударом.`)
  await watchers()
  const n = w.mobs.length
  const spread = Math.min(R - 3, 14)
  for (let i = 0; i < n; i++) {
    const dx = n === 1 ? 0 : Math.round(-spread + (2 * spread * i) / (n - 1))
    const dz = Math.round(R * 0.4) + (i % 3) * 2
    const up = AIR[w.mobs[i]] || 0
    const nbt = `{PersistenceRequired:1b,Tags:["arena"]${gearNbt(w.mobs[i], w.gear || 0, w.tier || 0)}}`
    await cmd(`/summon minecraft:${w.mobs[i]} ${X + dx} ${Y + up} ${Z + dz} ${nbt}`)
  }
  await sleep(1200)
  const before: any = await call('status')
  const r: any = await call('fight', { timeoutSeconds: 280, retreatAtHealth: 5, clearArea: R * 2 + 6 }).catch(e => ({ status: 'failed', error: e.message }))
  const after: any = await call('status')
  const d = r.detail || {} as Record<string, any>
  const bits = [r.status]
  if (d.kills) bits.push(`убил: ${d.kills.join(', ')}`)
  else if (d.killed) bits.push(`убил: ${d.killed}`)
  if (d.retreated) bits.push(`отступил: ${d.mode || ''}`)
  if (d.timeout) bits.push('время вышло')
  if (r.error) bits.push(r.error)
  bits.push(`хп ${before.state.health} -> ${after.state.health}`, `удары ${d.swings ?? '?'}/${d.landed ?? '?'}`, `криты ${d.crits ?? 0}`, `спринт ${d.sprintHits ?? 0}`)
  if (d.dodges) bits.push(`уклонов ${d.dodges}`)
  if (d.tricks) bits.push('приёмы ' + Object.entries<any>(d.tricks).map(([k, v]: any) => `${k}×${v}`).join(', '))
  if (d.healed) bits.push('лечился ' + d.healed.join(', '))
  log(bits.join(' | '))
  if (d.assessment) log(`  разбор: ${d.assessment}`)
  await sleep(3000)
  const died = d.died || (r.status === 'interrupted' && r.by && r.by.type === 'death') || !(after.state && after.state.health > 0)
  return { died, r }
}

async function survival () {
  await call('say', { text: 'Режим выживания: волны будут расти, пока я не лягу. Засекай!' })
  let n = 0
  while (true) {
    n++
    const w: any = survivalWave(n)
    if (n === 1) w.kit = SURVIVAL_KIT
    const res = await wave(w)
    if (res.died) {
      log(`ИТОГ ВЫЖИВАНИЯ: погиб на волне ${n}, пройдено волн: ${n - 1}`)
      await call('say', { text: `Лёг на волне ${n}. Рекорд: ${n - 1} волн. Реванш будет!` }).catch(() => {})
      return
    }
    if (n % 3 === 0) await call('say', { text: `Волна ${n} пройдена, дальше жёстче.` }).catch(() => {})
    if (n >= 30) { log('ИТОГ ВЫЖИВАНИЯ: 30 волн, хватит'); return }
  }
}

ws.on('open', async () => {
  try {
    await call('connect')
    await call('temper', { enabled: false })
    if (!GENTLE) {
      await cmd('/difficulty normal')
      await cmd('/time set 18000')
      await cmd('/gamerule do_daylight_cycle false')
      await cmd('/gamerule spawn_mobs false')
    }
    // Фаерболы гастов и криперы рвут блоки — на время арены мобы мир не
    // ломают, в конце правило возвращается.
    await cmd('/gamerule mob_griefing false')
    await cmd(`/tp ${ME} ${X} ${Y + 2} ${Z}`)
    await sleep(2500)
    await buildArena()
    if (ONLY === 'выживание') {
      await survival()
    } else {
      for (const w of WAVES) {
        if (ONLY && !ONLY.split(',').some(f => w.name.includes(f))) continue
        if (GENTLE && w.testOnly) continue
        await wave(w)
      }
    }
    await cmd('/kill @e[tag=arena]')
    log('ВСЁ')
  } catch (e) {
    log('FAILED:', e.stack || e.message)
    process.exitCode = 1
  } finally {
    await cmd('/gamerule mob_griefing true').catch(() => {})
    await call('temper', { enabled: true, firstHitChance: 1, fightSeconds: 300, calmSeconds: 30, retreatAtHealth: 3 }).catch(() => {})
    ws.close()
  }
})
ws.on('error', e => { console.error('ws:', e.message); process.exitCode = 1 })
