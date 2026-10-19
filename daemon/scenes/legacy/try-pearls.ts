'use strict'
import { REPO_ROOT } from '../../src/paths'
import * as gameClock from '../../src/game-clock'
// Жемчуг эндера (pearls.js, RPC pearls / mc_pearls). Ложь, которую ловит сцена:
// «убил — значит, жемчуг» и «бросил слиток — значит, выменял». Лут эндермена —
// 0..1 жемчуга, бартер даёт жемчуг в 2.1% сделок, поэтому прибыль меряется
// разницей рюкзака, а убийства и броски — отдельными числами.
//
// Арена в Аду (x -410..-390, z 400..420): пол из netherrack в 6 слоёв (шахта
// в 3 и штрек копаются), стены и крыша polished_blackstone. spawn_mobs false.
// (а) hunt: один эндермен с ИИ в 8 блоках, набор — железо, меч, кирка.
//     [ OK ] эндермена нет в мире (observe fair:false), бот жив, прибыль
//     жемчуга в отчёте равна разнице рюкзака; в штреке урона нет
//     (hurtInHide = 0 — укрытие держит; удары, пока копал, печатаются числом:
//     замеры 3–8 хп). Первый прогон с голой ямой в 2 блока кончился «slain by
//     Enderman» — он спрыгнул в яму.
// (в) barter без золотой брони: [ OK ] отказ с need golden_helmet, ни одного
//     слитка не брошено.
// (б) barter: два взрослых пиглина, золотой шлем, 6 слитков: [ OK ] брошено 6,
//     что-то выменяно и подобрано, урона от пиглинов нет (они мирные).
//
// Запуск: node try-pearls.js [авб] (демон NeuroNether на 8772).
import path = require('path')
import { connect, createKit, sleep } from '../lib/scene-kit'

const WS = process.env.ND_WS || 'ws://127.0.0.1:8772'
const PLAYER = process.env.MC_USERNAME || 'NeuroNether'
const LOG = process.env.ND_SERVER_LOG || path.join(REPO_ROOT, 'server-nether/logs/latest.log')
const conn = connect(WS)
const call = conn.call
const kit = createKit({ call, heard: conn.heard, logFile: LOG, player: PLAYER })
const ONLY = process.argv[2] || 'авб'
const N = 'the_nether'
const nether = c => `/execute in minecraft:the_nether run ${c.replace(/^\//, '')}`
const CX = -400
const CZ = 410
const FY = 70
const START = `${CX + 0.5} ${FY + 1} ${CZ + 0.5}`
const BOX = `x=${CX - 12},y=${FY - 5},z=${CZ - 12},dx=24,dy=16,dz=24`

let failures = 0
function check (what, ok, saw) {
  if (!ok) failures++
  console.log(`   [${ok ? ' OK ' : 'ПЛОХО'}] ${what}${saw === undefined ? '' : ` — вижу ${typeof saw === 'string' ? saw : JSON.stringify(saw)}`}`)
  return ok
}
const header = async () => ((await call('status')) || {} as Record<string, any>).state || {} as Record<string, any>
const inv = async n => ((await header()).inventory || {} as Record<string, any>)[n] || 0
async function mobs (re) {
  const o = await call('observe', { radius: 24, fair: false })
  return (((o && o.detail) || {} as Record<string, any>).entities || []).filter(e => re.test(e.name))
}

async function arena () {
  await kit.gamerule('spawn_mobs', 'false')
  await kit.gamerule('mob_griefing', 'true')
  await kit.setDifficulty('normal')
  await kit.forceload(N, [[CX - 12, FY, CZ - 12], [CX + 12, FY, CZ + 12]])
  await kit.fillExact(N, [[CX - 10, FY - 6, CZ - 10], [CX + 10, FY + 8, CZ + 10]], 'polished_blackstone')
  await kit.fillExact(N, [[CX - 9, FY - 5, CZ - 9], [CX + 9, FY, CZ + 9]], 'netherrack')
  await kit.fillExact(N, [[CX - 9, FY + 1, CZ - 9], [CX + 9, FY + 7, CZ + 9]], 'air')
}

async function reset (extra = []) {
  await kit.cmd(nether(`kill @e[type=!minecraft:player,${BOX}]`))
  await kit.fillExact(N, [[CX - 9, FY - 5, CZ - 9], [CX + 9, FY, CZ + 9]], 'netherrack')
  await kit.fillExact(N, [[CX - 9, FY + 1, CZ - 9], [CX + 9, FY + 7, CZ + 9]], 'air')
  await kit.cmd('/effect give @s minecraft:slow_falling 10 0 true')
  await kit.ensureWorld(N, { tp: START, floor: 'netherrack' })
  await kit.cmd('/clear @s')
  for (const g of extra) await kit.cmd(`/give @s minecraft:${g}`)
  await kit.cmd('/effect clear @s')
  await kit.cmd('/effect give @s minecraft:instant_health 1 5 true')
  await sleep(1200)
}

async function run (label, params) {
  const t0 = gameClock.now()
  const r = await call('pearls', params)
  const d = r.detail || {} as Record<string, any>
  console.log(`   ${label}: ${r.status}${r.error ? ' ' + r.error : ''} за ${Math.round((gameClock.now() - t0) / 1000)}с — ${d.stopped || ''} ${d.note || ''}`)
  return { r, d, t0 }
}

conn.ready.then(async () => {
  await call('connect')
  await call('stop')
  try {
    await kit.cmd('/effect give @s minecraft:slow_falling 20 0 true')
    await arena()

    if (ONLY.includes('а')) {
      console.log('(а) hunt: эндермен, яма')
      await reset(['iron_sword', 'iron_pickaxe', 'iron_helmet', 'iron_chestplate', 'iron_leggings', 'iron_boots', 'cooked_beef 16'])
      await call('armor', {} as Record<string, any>)
      await kit.cmd(nether(`summon minecraft:enderman ${CX + 8.5} ${FY + 1} ${CZ + 0.5}`))
      await sleep(1000)
      const seen = await mobs(/enderman/i)
      check('(а) эндермен в мире перед замером', seen.length === 1, seen.map(e => `${e.name} ${e.dist}`))
      const p0 = await inv('ender_pearl')
      const hp0 = (await header()).health
      const { r, d, t0 } = await run('hunt', { mode: 'hunt', count: 1, timeoutSeconds: 150 })
      const p1 = await inv('ender_pearl')
      const h = await header()
      const left = await mobs(/enderman/i)
      const deaths = kit.between(t0, gameClock.now(), 'death').length + (r.by && r.by.type === 'death' ? 1 : 0)
      console.log(`   раунды ${JSON.stringify(d.rounds)}; хп ${hp0} → ${h.health}`)
      check('(а) эндермена больше нет в мире', left.length === 0, left.map(e => `${e.name} ${e.dist}`))
      check('(а) бот жив', deaths === 0 && h.health > 0, `смертей ${deaths}`)
      check('(а) прибыль жемчуга в отчёте = разница рюкзака', d.pearls && d.pearls.gained === p1 - p0, d.pearls)
      // Свидетель укрытия — хп, потерянные уже в штреке (пока копает, эндермен
      // может ударить раз-другой: это цена приёма, её печатаем числом).
      const hurt = (d.rounds || []).map(r => r.hurtInHide).filter(v => typeof v === 'number')
      check('(а) в штреке урона нет — укрытие держит', hurt.length > 0 && hurt.every(v => v === 0), { hurtInHide: hurt, hpLostAll: d.hpLost })
      console.log(`   жемчуга +${p1 - p0} (игра: 0..1 с эндермена)`)
    }

    if (ONLY.includes('в')) {
      console.log('(в) barter без золотой брони')
      await reset(['gold_ingot 6'])
      await kit.cmd(nether(`summon minecraft:piglin ${CX + 4.5} ${FY + 1} ${CZ + 0.5} {IsImmuneToZombification:1b}`))
      await sleep(800)
      const { d } = await run('barter без золота', { mode: 'barter', count: 6, timeoutSeconds: 40 })
      check('(в) отказ с need golden_helmet, слитков не брошено', d.need && d.need.what === 'golden_helmet' && !d.thrown && (await inv('gold_ingot')) === 6, d.need)
    }

    if (ONLY.includes('б')) {
      console.log('(б) barter: два пиглина, золотой шлем, 6 слитков')
      await reset(['golden_helmet', 'gold_ingot 6'])
      await call('armor', {} as Record<string, any>)
      await kit.cmd(nether(`summon minecraft:piglin ${CX + 4.5} ${FY + 1} ${CZ + 0.5} {IsImmuneToZombification:1b}`))
      await kit.cmd(nether(`summon minecraft:piglin ${CX - 4.5} ${FY + 1} ${CZ + 0.5} {IsImmuneToZombification:1b}`))
      await sleep(1500)
      const pigs = await mobs(/piglin/i)
      check('(б) два пиглина в мире', pigs.length === 2, pigs.map(e => `${e.name} ${e.dist}`))
      const hp0 = (await header()).health
      // Без mode — как зовёт автомат (director: pearls {count}): видит пиглина и
      // слитки в Аду — сам выбирает бартер всеми слитками.
      const { d, t0 } = await run('barter (auto)', { count: 12, timeoutSeconds: 120 })
      check('(б) без mode выбран бартер', d.auto === true && d.mode === 'barter', `${d.mode} auto=${d.auto}`)
      const h = await header()
      const dmg = kit.between(t0, gameClock.now(), 'damage')
      console.log(`   выменял ${JSON.stringify(d.gained)}; жемчуга ${d.pearls}; хп ${hp0} → ${h.health}`)
      check('(б) отдано 6 слитков (по рюкзаку, не по броскам)', d.spent === 6 && (await inv('gold_ingot')) === 0, `отдано ${d.spent}, бросков ${d.thrown}, осталось ${d.ingotsLeft}`)
      check('(б) что-то выменяно и подобрано', Object.keys(d.gained || {} as Record<string, any>).length > 0, d.gained)
      check('(б) урона нет — пиглины мирные при золотом шлеме', dmg.length === 0 && (d.hpLost || 0) === 0, dmg.map(e => e.lost))
    }
  } catch (e) {
    failures++
    console.log('   [ПЛОХО] сцена оборвалась:', e.message)
  } finally {
    try { await call('stop') } catch {}
    try { await kit.cmd(nether(`kill @e[type=!minecraft:player,${BOX}]`)) } catch {}
    try { await kit.gamerule('spawn_mobs', 'true') } catch {}
    console.log(failures ? `\nИТОГ: ПЛОХО — ${failures}` : '\nИТОГ: всё зелёное')
    if (failures) process.exitCode = 1
    conn.close()
  }
}).catch(e => { console.error('ws:', e.message); process.exitCode = 1 })
