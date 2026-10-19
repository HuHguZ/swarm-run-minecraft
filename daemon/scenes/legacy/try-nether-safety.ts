'use strict'
import { REPO_ROOT } from '../../src/paths'
// Тело в Аду: золото на голове и нейтральные, которых «ближайший» не трогает
// (NETHER.md срез 4а). Ложь, которую ловит сцена: автопилот «одел лучшее» и
// снял последнюю золотую вещь, после чего пиглины нападают сами; бой «с
// ближайшим» бьёт мирного пиглина или эндермена и поднимает толпу.
//
// (а) Броня в Аду: на голове golden_helmet, в рюкзаке iron_helmet (оба по 2
//     очка, ничью решает прочность — железо). RPC armor: [ OK ] на голове
//     осталось золото. Контроль, который обязан покраснеть: то же в верхнем
//     мире — на голову встаёт железо (иначе проверка ничего не доказывает).
// (б) Пиглин {NoAI} в 3 блоках, на мне золото: fight без цели — [ OK ] «не вижу
//     цель», здоровье пиглина не изменилось.
// (в) Эндермен {NoAI} в 3 блоках, не злой: fight без цели — [ OK ] не бьёт.
//
// Запуск: node try-nether-safety.js (демон NeuroNether на 8772).
import path = require('path')
import { connect, createKit, sleep } from '../lib/scene-kit'

const WS = process.env.ND_WS || 'ws://127.0.0.1:8772'
const PLAYER = process.env.MC_USERNAME || 'NeuroNether'
const LOG = process.env.ND_SERVER_LOG || path.join(REPO_ROOT, 'server-nether/logs/latest.log')
const conn = connect(WS)
const call = conn.call
const kit = createKit({ call, heard: conn.heard, logFile: LOG, player: PLAYER })
const N = 'the_nether'
const nether = c => `/execute in minecraft:the_nether run ${c.replace(/^\//, '')}`
const CX = -400
const CZ = 440
const FY = 70
const BOX = `x=${CX - 10},y=${FY - 3},z=${CZ - 10},dx=20,dy=12,dz=20`

let failures = 0
function check (what, ok, saw) {
  if (!ok) failures++
  console.log(`   [${ok ? ' OK ' : 'ПЛОХО'}] ${what}${saw === undefined ? '' : ` — вижу ${typeof saw === 'string' ? saw : JSON.stringify(saw)}`}`)
  return ok
}
const header = async () => ((await call('status')) || {} as Record<string, any>).state || {} as Record<string, any>
async function mob (re) {
  const o = await call('observe', { radius: 12, fair: false })
  return (((o && o.detail) || {} as Record<string, any>).entities || []).find(e => re.test(e.name)) || null
}
// Здоровье моба — ответом сервера (data get), а не глазами бота.
async function mobHealth (type) {
  const r = await call('ask', { command: nether(`data get entity @e[type=minecraft:${type},limit=1,sort=nearest] Health`), match: 'Health|entity data', ms: 3000 })
  const line = (((r && r.detail) || {} as Record<string, any>).lines || []).join(' ')
  const m = /(-?\d+(?:\.\d+)?)f/.exec(line)
  return m ? Number(m[1]) : null
}

conn.ready.then(async () => {
  await call('connect')
  await call('stop')
  try {
    await kit.gamerule('spawn_mobs', 'false')
    await kit.setDifficulty('normal')
    await kit.cmd('/effect give @s minecraft:slow_falling 20 0 true')
    await kit.forceload(N, [[CX - 10, FY, CZ - 10], [CX + 10, FY, CZ + 10]])
    await kit.fillExact(N, [[CX - 8, FY - 1, CZ - 8], [CX + 8, FY + 6, CZ + 8]], 'polished_blackstone')
    await kit.fillExact(N, [[CX - 7, FY, CZ - 7], [CX + 7, FY + 5, CZ + 7]], 'air')
    await kit.ensureWorld(N, { tp: `${CX + 0.5} ${FY} ${CZ + 0.5}`, floor: 'polished_blackstone' })
    await kit.cmd(nether(`kill @e[type=!minecraft:player,${BOX}]`))

    console.log('(а) броня в Аду: золото остаётся')
    await kit.cmd('/clear @s')
    await kit.cmd('/item replace entity @s armor.head with minecraft:golden_helmet')
    await kit.cmd('/give @s minecraft:iron_helmet')
    await kit.cmd('/give @s minecraft:iron_sword')
    await sleep(800)
    await call('armor', {} as Record<string, any>)
    await sleep(800)
    const hN = await header()
    check('(а) в Аду на голове осталось золото', hN.armor && hN.armor.head === 'golden_helmet', hN.armor)
    // Контроль в верхнем мире.
    await kit.cmd('/effect give @s minecraft:slow_falling 20 0 true')
    await kit.cmd('/execute in minecraft:overworld run tp @s 800.5 121 796.5')
    await sleep(2500)
    await call('armor', {} as Record<string, any>)
    await sleep(800)
    const hO = await header()
    check('(а) контроль: в верхнем мире на голову встаёт железо', hO.armor && hO.armor.head === 'iron_helmet', hO.armor)
    await kit.cmd('/effect give @s minecraft:slow_falling 20 0 true')
    await kit.ensureWorld(N, { tp: `${CX + 0.5} ${FY} ${CZ + 0.5}`, floor: 'polished_blackstone' })
    await kit.cmd('/item replace entity @s armor.head with minecraft:golden_helmet')
    await kit.cmd('/clear @s minecraft:iron_helmet')
    await sleep(600)

    console.log('(б) пиглин рядом, на мне золото')
    await kit.cmd(nether(`summon minecraft:piglin ${CX + 3.5} ${FY} ${CZ + 0.5} {NoAI:1b,IsImmuneToZombification:1b,PersistenceRequired:1b}`))
    await sleep(1000)
    const pg = await mob(/piglin/i)
    check('(б) пиглин в мире', !!pg, pg && `${pg.name} ${pg.dist}`)
    const pgHp0 = await mobHealth('piglin')
    const f1 = await call('fight', { timeoutSeconds: 10 })
    const pgHp1 = await mobHealth('piglin')
    console.log(`   fight: ${f1.status} ${f1.error || ''}`)
    check('(б) бой без цели не начался', f1.status === 'failed' && /не вижу цель/.test(f1.error || ''), f1.error || f1.status)
    check('(б) здоровье пиглина не изменилось', pgHp0 !== null && pgHp0 === pgHp1, `${pgHp0} → ${pgHp1}`)
    await kit.cmd(nether(`kill @e[type=minecraft:piglin,${BOX}]`))

    console.log('(в) эндермен рядом, не злой')
    await kit.cmd(nether(`summon minecraft:enderman ${CX + 3.5} ${FY} ${CZ + 0.5} {NoAI:1b,PersistenceRequired:1b}`))
    await sleep(1000)
    const em = await mob(/enderman/i)
    check('(в) эндермен в мире', !!em, em && `${em.name} ${em.dist}`)
    await call('look_at', { x: CX + 10, y: FY, z: CZ + 10 })
    const emHp0 = await mobHealth('enderman')
    const f2 = await call('fight', { timeoutSeconds: 10 })
    const emHp1 = await mobHealth('enderman')
    console.log(`   fight: ${f2.status} ${f2.error || ''}`)
    check('(в) эндермена «ближайшим» не бьёт', f2.status === 'failed' && emHp0 !== null && emHp0 === emHp1, `${f2.error || f2.status}; хп ${emHp0} → ${emHp1}`)
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
