'use strict'
// Лук с «Отдачей» — сброс с края (пользователь 24.10: «луком откидывать, чтобы убить»). Манекен — mineflayer-бот сцены,
// смертный, стоит у края площадки над пропастью (вниз ~130 бл.); бот демона в 14 бл. от него — только лук «Сила V, Отдача
// <уровень>» и стрелы, из ближнего — деревянный меч, бой RPC fight (тот же, что в рое). Итог — сколько раз манекен упал в
// пропасть; в журнале боя — «лук «Отдача»: … выстрел в тик, когда сбросит».
//   node dist/farm/farm.js run try-punch-edge.js --slots 1 --tick-rate 20 [-- заходов [отдача] [от края]]
import type { Bot } from 'mineflayer'
import { connect, createKit, normBox, splitBox } from '../lib/scene-kit'
import * as clock from '../../src/game-clock'

const X = 3200; const Y = 200; const Z = 3200

async function main () {
  const slot = process.env.FARM_SLOT
  const me = process.env.MC_USERNAME
  ;(require('../lib/arms-guard') as typeof import('../lib/arms-guard')).farmOnly({ ws: [process.env.ND_WS], mc: [process.env.MC_PORT] })
  if (!slot || !me) throw new Error('сцену запускает farm.js run (FARM_SLOT, MC_USERNAME)')
  const N = Number(process.argv[2] || 10), PUNCH = Number(process.argv[3] || 2), EDGE = Number(process.argv[4] || 1.5)
  const dummyName = `NeuroPunch${slot}`
  const c = connect(process.env.ND_WS)
  let dummy: Bot | null = null
  const kit: any = { cmd: null }
  try {
    await c.ready
    await c.call('connect'); await c.call('stop')
    await c.call('play_mode', { mode: 'free' })
    await c.call('temper', { enabled: false }).catch(() => {})
    Object.assign(kit, createKit({ call: c.call, heard: c.heard, logFile: process.env.ND_SERVER_LOG, player: me }))
    await kit.must('/tick unfreeze', null, 'часы идут')
    await kit.cmd('/gamerule send_command_feedback true')
    await kit.gamerule('spawn_mobs', false); await kit.gamerule('immediate_respawn', true)
    await kit.cmd('/time set day'); await kit.cmd('/weather clear')
    await kit.setDifficulty('normal')
    await kit.forceload('overworld', [[X - 24, 0, Z - 24], [X + 24, 0, Z + 24]])
    await kit.must(`/tp ${me} ${X + 0.5} ${Y + 5} ${Z + 0.5}`, null, 'бот к площадке')
    // Площадка 9×30 (x — поперёк, z — вдоль): дальний край z = Z + 15 над пропастью; вокруг — воздух.
    for (const b of splitBox(normBox([[X - 24, Y - 1, Z - 24], [X + 24, Y + 20, Z + 24]]))) await kit.cmd(`/fill ${b.x1} ${b.y1} ${b.z1} ${b.x2} ${b.y2} ${b.z2} minecraft:air`)
    await kit.fillExact('overworld', [[X - 4, Y - 1, Z - 14], [X + 4, Y - 1, Z + 15]], 'smooth_stone')
    // Обычный mineflayer со своей физикой реального времени: отброс стрелы (entity_velocity) он применяет, как клиент игрока.
    dummy = (require('mineflayer') as typeof import('mineflayer')).createBot({ host: '127.0.0.1', port: Number(process.env.MC_PORT), username: dummyName, auth: 'offline', version: '1.21.11' })
    await new Promise<void>((resolve, reject) => { dummy!.once('spawn', () => resolve()); dummy!.once('error', reject); dummy!.once('kicked', r => reject(new Error('манекен: ' + String(r)))) })
    let deaths = 0, fell = 0
    dummy.on('death', () => { deaths++; if ((dummy!.entity?.position?.y ?? Y) < Y - 3) fell++ })
    // mineflayer читает скорость 1.21.11 (LpVec3) по-старому, делением на 8000, и отброс к себе не применяет: манекен не
    // отлетал ни от стрелы, ни от меча (живой клиент игрока отлетел бы). Та же подмена, что у ботов демона (tick-plugins
    // nativeVelocity), но и для себя: точная скорость из сырых байтов — в единицах, которых ждёт плагин entities.
    const drops: typeof import('../../src/drops') = require('../../src/drops')
    dummy._client.on('packet', (pk: any, meta: any, bytes: any) => {
      if (meta?.name !== 'entity_velocity' || pk?.entityId !== dummy!.entity?.id) return
      const v = drops.velocityFromRaw(bytes, 'velocity')
      if (v) pk.velocity = { x: v.x * 8000, y: v.y * 8000, z: v.z * 8000 }
    })
    // Замер: попадание в манекена — его скорость и путь 12 тиков (применил ли отброс, куда унесло).
    dummy.on('entityHurt', (e: any) => {
      if (e !== dummy!.entity) return
      const p0 = dummy!.entity.position.clone(), path: string[] = []
      let n = 0
      const tick = () => { path.push(`${(dummy!.entity.position.z - p0.z).toFixed(2)}/${dummy!.entity.position.y.toFixed(1)}`); if (++n >= 12) { dummy!.removeListener('physicsTick', tick); console.log(`[удар] z0 ${p0.z.toFixed(2)} v ${dummy!.entity.velocity.z.toFixed(2)} путь dz/y: ${path.join(' ')}`) } }
      dummy!.on('physicsTick', tick)
    })
    let kills = 0, shots = 0, punchOut = 0
    for (let k = 0; k < N; k++) {
      await kit.cmd(`/gamemode survival ${dummyName}`); await kit.cmd(`/clear ${dummyName}`)
      await kit.cmd(`/effect give ${dummyName} minecraft:instant_health 1 10 true`)
      for (const [sl, it] of [['armor.chest', 'iron_chestplate'], ['armor.legs', 'iron_leggings']]) await kit.cmd(`/item replace entity ${dummyName} ${sl} with minecraft:${it}`)
      await kit.cmd(`/clear ${me}`); await kit.cmd(`/effect give ${me} minecraft:instant_health 1 10 true`)
      await kit.cmd(`/give ${me} minecraft:bow[enchantments={power:5,punch:${PUNCH}}] 1`); await kit.cmd(`/give ${me} minecraft:arrow 64`)
      // Бой без оружия ближнего боя не начинается — деревянный меч: рукопашная слабая, сброс видно по журналу боя.
      await kit.cmd(`/give ${me} minecraft:wooden_sword 1`); await kit.cmd(`/give ${me} minecraft:bread 16`); await kit.cmd(`/effect give ${me} minecraft:saturation 1 20 true`)
      await kit.cmd(`/tp ${dummyName} ${X + 0.5} ${Y} ${Z + 15.5 - EDGE + 0.5} 180 0`)
      await kit.cmd(`/tp ${me} ${X + 0.5} ${Y} ${Z + 15.5 - EDGE - 13.5} 0 0`)
      await clock.sleep(1500)
      const before = deaths
      const r = await c.call('fight', { target: dummyName, allowPlayer: true, allowRanged: true, timeoutSeconds: 12, retreatAtHealth: 0 }).catch((e: any) => ({ detail: { why: e.message } }))
      const d = r?.detail || r || {}
      await clock.sleep(2500)
      const killed = deaths > before
      if (killed) kills++
      shots += d.stats?.arrows || 0; punchOut += d.stats?.punchOut || 0
      const tricks = Object.keys(d.tricks || {}).filter(t => /Отдача|лук/.test(t))
      console.log(`[${k + 1}/${N}] ${killed ? 'упал в пропасть' : 'устоял'}; ${tricks.join('; ').slice(0, 160) || d.stopped || d.why || ''}`)
    }
    console.log(`ИТОГ Отдача ${PUNCH}, от края ${EDGE} бл.: сбросил ${kills}/${N} (падений ${fell}, смертей ${deaths})`)
  } finally {
    await c.call('stop').catch(() => {})
    try { await kit.unforceload?.('overworld', [[X - 24, 0, Z - 24], [X + 24, 0, Z + 24]]) } catch {}
    dummy?.quit('try-punch-edge done')
    c.close()
  }
}

if (require.main === module) main().then(() => clock.wall.setTimeout(() => process.exit(0), 300)).catch(e => { console.error('FAILED', e?.stack || e); process.exit(1) })
