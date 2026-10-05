'use strict'
const gameClock = require('./src/game-clock')
const { createGameBot } = require('./scene-kit')
// Атрибут-свап в 1.21.11 (PVP-RESEARCH б.3, MC-28289) — проверка на Paper.
// Два голых mineflayer-клиента (не демоны: их имена NeuroDown/NeuroDown2
// заняты ареной; NeuroNether и NeuroEnd — опы тестового сервера nether):
//  A — с мечом и топором в хотбаре, B — со щитом в левой руке.
//  1. щит B поднят, A бьёт свапом «меч → топор → меч» в одном тике: щит B
//     выключен (set_cooldown minecraft:shield на 100 тиков у B, звук
//     item.shield.break), в руке A снова меч;
//  2. заряд: удар мечом, через 6 тиков свап туда-обратно без удара, ещё через
//     6 — удар: сильный (strong/sweep/knockback), значит свап заряд не сбросил;
//     для сравнения то же с честной сменой (топор, тик, меч) — слабый (weak);
//  3. урон свап-удара по B без щита: 7 (атрибут меча), а не 9 (топор).
//   MC_PORT=25567 node try-swap.js
const Vec3 = require('vec3')
const edges = require('./src/edges')
const melee = require('./src/melee')

const PORT = Number(process.env.MC_PORT || 25567)
const sleep = ms => gameClock.sleep(ms)
const X = 60; const Y = 150; const Z = 60

function join (username) {
  return new Promise((resolve, reject) => {
    const bot = createGameBot({ host: '127.0.0.1', port: PORT, username, version: '1.21.11', auth: 'offline' }, { primary: true })
    bot.once('spawn', () => resolve(bot))
    bot.once('error', reject)
    bot.once('kicked', (r) => reject(new Error('kicked ' + JSON.stringify(r))))
  })
}
const ticks = (bot, n) => new Promise(resolve => { let k = 0; const f = () => { if (++k >= n) { bot.removeListener('physicsTick', f); resolve() } }; bot.on('physicsTick', f) })

;(async () => {
  const A = await join('NeuroNether')
  const B = await join('NeuroEnd')
  for (const b of [A, B]) { edges.fixSelfKnockback(b); melee.install(b) }
  const cmd = async (t) => { A.chat(t); await sleep(120) }
  const sounds = []
  // Имя звука — с поправкой номера (melee.soundName, 2026-09-26): soundEffectHeard
  // mineflayer на 1.21.11 называет звуки соседним именем.
  A._client.on('sound_effect', (p) => { const n = melee.soundName(A, p); const pt = new Vec3(p.x / 8, p.y / 8, p.z / 8); if (/attack|shield/.test(n)) sounds.push({ n: String(n).replace(/^.*?(entity|item)\./, '$1.'), t: gameClock.now(), d: pt.distanceTo(A.entity.position).toFixed(1) }) })
  const cooldowns = []
  B._client.on('set_cooldown', (p) => cooldowns.push({ g: p.cooldownGroup, ticks: p.cooldownTicks, t: gameClock.now() }))
  const hpB = () => B.health
  try {
    await cmd(`/fill ${X - 6} ${Y - 1} ${Z - 6} ${X + 6} ${Y - 1} ${Z + 6} minecraft:stone`)
    await cmd(`/fill ${X - 6} ${Y} ${Z - 6} ${X + 6} ${Y + 4} ${Z + 6} minecraft:air`)
    for (const who of ['NeuroNether', 'NeuroEnd']) { await cmd(`/clear ${who}`); await cmd(`/effect clear ${who}`); await cmd(`/gamemode survival ${who}`) }
    await cmd('/item replace entity NeuroNether hotbar.0 with minecraft:diamond_sword')
    await cmd('/item replace entity NeuroNether hotbar.1 with minecraft:diamond_axe')
    await cmd('/item replace entity NeuroEnd weapon.offhand with minecraft:shield')
    await cmd(`/tp NeuroNether ${X + 0.5} ${Y} ${Z + 0.5} 0 0`)
    await cmd(`/tp NeuroEnd ${X + 0.5} ${Y} ${Z + 2.8} 180 0`)
    await cmd('/effect give NeuroEnd minecraft:resistance 300 4 true')
    await sleep(1500)
    A.setQuickBarSlot(0)
    await A.lookAt(B.entity.position.offset(0, 1.4, 0), true)
    await B.lookAt(A.entity.position.offset(0, 1.4, 0), true)
    await sleep(800)

    // 1. Свап по поднятому щиту.
    B.activateItem(true)
    await sleep(600) // щит держит через 5 тиков
    const flags = () => { const f = B.entity.metadata[8]; return typeof f === 'number' ? f : 0 }
    console.log('щит B поднят:', (flags() & 3) === 3, 'в руке A:', A.heldItem && A.heldItem.name)
    const M = A._ndMelee
    await ticks(A, 1)
    const c0 = M.charge(0)
    const hp0 = hpB()
    sounds.length = 0; cooldowns.length = 0
    // Три пакета в одном тике: слот топора, удар, слот меча.
    A.setQuickBarSlot(1); A.attack(B.entity); A.setQuickBarSlot(0)
    await sleep(700)
    const shieldCd = cooldowns.find(c => /shield/.test(c.g))
    console.log(`[1] свап-удар по щиту: заряд меча ${c0.toFixed(2)}, у B set_cooldown ${shieldCd ? `${shieldCd.g} ${shieldCd.ticks} тиков` : 'НЕТ'}; звуки ${sounds.map(s => s.n).join(', ') || '-'}; хп B ${hp0} -> ${hpB()}; в руке A ${A.heldItem && A.heldItem.name}; щит B поднят ${(flags() & 1) === 1}`)
    B.deactivateItem()
    await sleep(5500) // щит выключен 5 с — ждём, чтобы дальше бить без щита

    // 2. Заряд: свап туда-обратно без удара посреди перезарядки.
    const probe = async (label, midSwap) => {
      await ticks(A, 14)
      A.attack(B.entity) // сброс заряда (onAttack)
      await ticks(A, 6)
      await midSwap()
      await ticks(A, 6)
      sounds.length = 0
      await ticks(A, 1) // 13 тиков после удара — полный заряд, если не сброшен
      A.attack(B.entity)
      await sleep(400)
      const s = sounds.map(x => x.n)
      console.log(`[2] ${label}: после — ${s.join(', ') || 'звука нет'}`)
      return s
    }
    await sleep(600)
    await probe('свап туда-обратно в одном тике', async () => { A.setQuickBarSlot(1); A.setQuickBarSlot(0) })
    await sleep(600)
    await probe('честная смена (топор, тик, меч)', async () => { A.setQuickBarSlot(1); await ticks(A, 1); A.setQuickBarSlot(0) })

    // 3. Урон свап-удара без щита (B с сопротивлением IV: урон ×0.2 — считаем по
    // соотношению): свап против чистого топора.
    await cmd('/effect clear NeuroEnd')
    await cmd('/effect give NeuroEnd minecraft:instant_health 1 5 true')
    await sleep(900)
    const dmgOf = async (label, fn) => {
      await cmd('/effect give NeuroEnd minecraft:instant_health 1 5 true')
      await sleep(700)
      await ticks(A, 26)
      const h0 = hpB()
      await fn()
      await sleep(600)
      console.log(`[3] ${label}: хп B ${h0} -> ${hpB()} (−${(h0 - hpB()).toFixed(1)})`)
    }
    await dmgOf('меч', async () => { A.attack(B.entity) })
    await dmgOf('свап меч→топор', async () => { A.setQuickBarSlot(1); A.attack(B.entity); A.setQuickBarSlot(0) })
    await dmgOf('топор честно', async () => { A.setQuickBarSlot(1); await ticks(A, 26); A.attack(B.entity); await ticks(A, 1); A.setQuickBarSlot(0) })
  } catch (e) {
    console.error('FAILED', e.stack || e.message)
    process.exitCode = 1
  } finally {
    A.quit(); B.quit()
    gameClock.wall.setTimeout(() => process.exit(), 500)
  }
})()
