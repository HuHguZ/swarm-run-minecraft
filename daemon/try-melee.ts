'use strict'
const gameClock = require('./src/game-clock')
const { createGameBot } = require('./scene-kit')
// Замеры ядра ближнего боя (2026-09-26), два голых mineflayer-клиента
// (NeuroNether и NeuroEnd — опы тестового сервера nether), вдали от арены:
//  1. честность: скорость хода с предметом в руке (itemuse.js) — идёт вперёд,
//     потом ест золотое яблоко на ходу, потом поднимает щит; и спринт, начатый
//     во время еды (должен не начаться: LocalPlayer.canStartSprinting);
//  2. отброс от спринт-удара B по A: без jump-reset и с ним (melee.fight,
//     skill.jumpReset 0 и 1) — путь A по направлению удара за 12 тиков.
//   MC_PORT=25567 node try-melee.js
const edges = require('./src/edges')
const melee = require('./src/melee')
const itemuse = require('./src/itemuse')

const PORT = Number(process.env.MC_PORT || 25567)
const sleep = ms => gameClock.sleep(ms)
const X = 300; const Y = 150; const Z = 300
const ONLY = process.env.ONLY || ''

function join (username) {
  return new Promise<any>((resolve, reject) => {
    const bot = createGameBot({ host: '127.0.0.1', port: PORT, username, version: '1.21.11', auth: 'offline' }, { primary: true })
    bot.once('spawn', () => resolve(bot))
    bot.once('error', reject)
  })
}
const ticks = (bot, n) => new Promise<void>(resolve => { let k = 0; const f = () => { if (++k >= n) { bot.removeListener('physicsTick', f); resolve() } }; bot.on('physicsTick', f) })

;(async () => {
  const A = await join('NeuroNether')
  const B = await join('NeuroEnd')
  for (const b of [A, B]) { edges.fixSelfKnockback(b); itemuse.install(b); melee.install(b) }
  const cmd = async (t) => { A.chat(t); await sleep(130) }
  try {
    await cmd(`/fill ${X - 12} ${Y - 1} ${Z - 30} ${X + 12} ${Y - 1} ${Z + 30} minecraft:stone`)
    await cmd(`/fill ${X - 12} ${Y} ${Z - 30} ${X + 12} ${Y + 4} ${Z + 30} minecraft:air`)
    for (const who of ['NeuroNether', 'NeuroEnd']) { await cmd(`/clear ${who}`); await cmd(`/effect clear ${who}`); await cmd(`/gamemode survival ${who}`) }

    if (!ONLY || ONLY === 'speed') {
      // 1. Скорость с предметом в руке.
      await cmd('/item replace entity NeuroNether hotbar.0 with minecraft:golden_apple 16')
      await cmd('/item replace entity NeuroNether weapon.offhand with minecraft:shield')
      await cmd('/effect give NeuroNether minecraft:hunger 3 200 true') // сытость < 20 — не обязательно для яблока
      A.setQuickBarSlot(0)
      const run = async (label, { sprint = false, use = null, sprintDuring = false }: any) => {
        await cmd(`/tp NeuroNether ${X + 0.5} ${Y} ${Z - 25.5} 0 0`)
        await sleep(700)
        await A.look(Math.PI, 0, true) // на +z
        A.setControlState('forward', true)
        if (sprint) A.setControlState('sprint', true)
        await ticks(A, 20)
        const p0 = A.entity.position.clone()
        await ticks(A, 10)
        const before = A.entity.position.distanceTo(p0) / 10
        if (use === 'eat') A.activateItem()
        if (use === 'shield') A.activateItem(true)
        await ticks(A, 6)
        if (sprintDuring) A.setControlState('sprint', true)
        const p1 = A.entity.position.clone()
        await ticks(A, 16)
        const during = A.entity.position.distanceTo(p1) / 16
        const sprintOn = A.getControlState('sprint')
        const U = A._ndUse
        const using = !!U.cur
        A.deactivateItem()
        await ticks(A, 12)
        const p2 = A.entity.position.clone()
        await ticks(A, 10)
        const after = A.entity.position.distanceTo(p2) / 10
        A.clearControlStates()
        console.log(`[скорость] ${label}: до ${before.toFixed(3)} б/т, с предметом ${during.toFixed(3)} б/т (×${(during / before).toFixed(2)}; в ходу ${using}, спринт ${sprintOn}), после ${after.toFixed(3)} б/т`)
        await sleep(300)
      }
      await run('шаг + яблоко', { use: 'eat' })
      await run('спринт + яблоко (спринт начат до еды)', { sprint: true, use: 'eat' })
      await run('шаг + яблоко, спринт нажат во время еды', { use: 'eat', sprintDuring: true })
      await run('шаг + щит', { use: 'shield' })
      console.log('[скорость] itemuse:', JSON.stringify(A._ndUse.stats))
    }

    if (!ONLY || ONLY === 'totem') {
      // 3. Тотем по событию 35: два смертельных удара подряд через 12 тиков (после
      // кадров неуязвимости, LivingEntity.hurtServer: 10 тиков) —
      // второй спасает только тотем, надетый сразу после первого.
      const totem = require('./src/totem')
      const T = totem.install(A)
      await cmd('/clear NeuroNether')
      await cmd('/item replace entity NeuroNether weapon.offhand with minecraft:totem_of_undying')
      await cmd('/item replace entity NeuroNether hotbar.4 with minecraft:totem_of_undying')
      await cmd('/item replace entity NeuroNether hotbar.0 with minecraft:diamond_sword')
      A.setQuickBarSlot(0)
      await cmd(`/tp NeuroNether ${X + 0.5} ${Y} ${Z + 0.5} 0 0`)
      await sleep(1200)
      const t0 = gameClock.now()
      let dead = false
      A.once('death', () => { dead = true })
      await cmd('/damage NeuroNether 100 minecraft:generic')
      await ticks(A, 3)
      const off1 = A.inventory.slots[45] && A.inventory.slots[45].name
      await ticks(A, 10)
      await cmd('/damage NeuroNether 100 minecraft:generic')
      await sleep(800)
      console.log(`[тотем] сработал ${T.pops} раз, снова в руке ${T.reequips} (быстро ${T.fast}, кликами ${T.slow}); в левой руке через 3 тика после первого: ${off1}; второй смертельный удар — ${dead ? 'УМЕР' : 'жив, хп ' + A.health}; в руке ${A.heldItem && A.heldItem.name}; ${gameClock.now() - t0} мс`)
    }

    if (!ONLY || ONLY === 'kb') {
      // 2. Отброс от спринт-удара: без jump-reset и с ним.
      await cmd('/item replace entity NeuroEnd hotbar.0 with minecraft:diamond_sword')
      await cmd('/effect give NeuroNether minecraft:resistance 600 4 true')
      await cmd('/effect give NeuroNether minecraft:saturation 600 1 true')
      B.setQuickBarSlot(0)
      const trial = async (reset) => {
        const F = melee.fight(A, { target: () => A.entities[B.entity.id], style: { jumpReset: reset ? 1 : 0, counter: 0 } })
        for (let i = 0; i < 5; i++) {
          await cmd(`/tp NeuroNether ${X + 0.5} ${Y} ${Z + 0.5} 180 0`)
          await cmd(`/tp NeuroEnd ${X + 0.5} ${Y} ${Z - 2.3} 0 0`)
          await sleep(900)
          await A.lookAt(B.entity.position.offset(0, 1.5, 0), true)
          await B.lookAt(A.entity.position.offset(0, 1.5, 0), true)
          B.setControlState('sprint', false); await ticks(B, 2)
          B.setControlState('sprint', true); await ticks(B, 14)
          B.attack(B.entities[A.entity.id])
          // Оба режима держат «вперёд» со спринтом к нему (обычный встречный
          // ход), разница — только прыжок.
          A.setControlState('forward', true); A.setControlState('sprint', true)
          await ticks(A, 16)
          A.clearControlStates()
          B.setControlState('sprint', false)
          await sleep(300)
        }
        const r = F.report()
        F.close()
        return r
      }
      const plain = await trial(false)
      const reset = await trial(true)
      console.log(`[отброс] без прыжка: получил ${plain.knocks || 0}, путь ${plain.kbPlain ?? '-'} бл. | с jump-reset: получил ${reset.knocks || 0}, прыжков ${reset.jumpResets || 0}, путь ${reset.kbReset ?? '-'} бл.`)
    }
  } catch (e) {
    console.error('FAILED', e.stack || e.message)
    process.exitCode = 1
  } finally {
    A.quit(); B.quit()
    gameClock.wall.setTimeout(() => process.exit(), 500)
  }
})()
