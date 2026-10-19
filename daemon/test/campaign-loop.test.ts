'use strict'
// Кампания: главный цикл — паузы пустых заходов, сторож, смерть посреди этапа, свободный режим, вехи.
import test = require('node:test')
import assert = require('node:assert/strict')
import { campaign } from './campaign-fixture'

test('сохранённый рюкзак после смерти не начинает новый этап до возрождения', async () => {
  const state: Record<string, any> = { health: 0, food: 17, inventory: { stone_pickaxe: 1, melon_slice: 9, blaze_rod: 3 } }
  const calls = []
  const c = campaign(state, { foes: 0 }, method => {
    calls.push(method)
    if (method === 'mine') return { rpcResult: { status: 'interrupted', by: { type: 'death' }, state } }
    return {} as Record<string, any>
  })
  c.stage('nether')
  await assert.rejects(c.act('mine'), /умер/)
  const timer = setTimeout(() => { state.health = 20; state.food = 20 }, 100)
  try {
    await c.recoverGuard()
    assert.equal(state.health, 20, 'наличие вещей не заменяет подтверждение живого тела')
    assert.equal(calls.some(x => /sleep|shelter|eat/.test(x)), false)
  } finally { clearTimeout(timer) }
})

test('пустые заходы — растущая пауза этапа 5/10/20 мин, а не остановка; сторож останавливает через 45 мин без прогресса', async () => {
  const state: Record<string, any> = { health: 20, food: 20, dimension: 'overworld', inventory: {} as Record<string, any> }
  const clock: Record<string, any> = { t: Date.parse('2026-09-30T12:00:00Z') }
  const t0 = clock.t
  const at = []
  let stops = 0
  let disconnects = 0
  const logs = []
  const c = campaign(state, {} as Record<string, any>, (method, params) => {
    if (method === 'wait') clock.t += (params.seconds || 30) * 1000
    if (method === 'stop') stops++
    if (method === 'disconnect') disconnects++
    return {} as Record<string, any>
  }, { logs, clock, argv: ['iron'] })
  c.hooks({ recoverGuard: async () => {} })
  c.ironOnly(async () => { at.push(Math.round((clock.t - t0) / 60000)) })
  await c.boot()
  // Два пустых подряд → пауза 5; после неё каждый пустой → 10, 20; на 45-й минуте — сторож.
  assert.deepEqual(at, [0, 0, 5, 15, 35])
  const text = logs.join('')
  assert.match(text, /пауза 5 мин/)
  assert.match(text, /пауза 10 мин/)
  assert.match(text, /пауза 20 мин/)
  assert.doesNotMatch(text, /нет доступного шага \(.*\); одинаковые попытки прекращаю/)
  assert.match(text, /БЛОКЕР: сторож — 45 мин без прогресса ни в одном этапе \(последний этап iron\)/)
  assert.equal(stops, 1, 'сторож отменяет незавершённое намерение')
  assert.equal(disconnects, 1, 'остановленная кампания убирает тело из мира')
})

test('пауза этапа снимается рассветом и сменой измерения — этап берётся сразу', async () => {
  const state: Record<string, any> = { health: 20, food: 20, dimension: 'overworld', inventory: {} as Record<string, any> }
  const situation: Record<string, any> = { night: true, surface: false }
  const clock: Record<string, any> = { t: Date.parse('2026-09-30T12:00:00Z') }
  const t0 = clock.t
  const at = []
  let waits = 0
  const logs = []
  const c = campaign(state, situation, (method, params) => {
    if (method === 'wait') {
      waits++
      clock.t += (params.seconds || 30) * 1000
      if (waits === 2) situation.night = false
    }
    return {} as Record<string, any>
  }, { logs, clock, argv: ['iron'], env: { ND_WATCHDOG_MIN: '20' } })
  c.hooks({ recoverGuard: async () => {} })
  c.ironOnly(async () => { at.push(Math.round((clock.t - t0) / 60000)) })
  await c.boot()
  assert.deepEqual(at.slice(0, 3), [0, 0, 2], 'рассвет на второй минуте паузы — третий заход сразу, не через 5 мин')
  assert.match(logs.join(''), /паузы этапов сняты: рассвет/)
})

test('переключение в free прекращает кампанию без отмены следующего ручного действия', async () => {
  const state: Record<string, any> = { health: 20, food: 20, inventory: {} as Record<string, any>, dimension: 'overworld', playPolicy: { mode: 'speedrun' } }
  let attempts = 0
  let stops = 0
  const c = campaign(state, {} as Record<string, any>, method => { if (method === 'stop') stops++; return {} as Record<string, any> }, { argv: ['iron'] })
  c.hooks({ recoverGuard: async () => {} })
  c.ironOnly(async () => { attempts++; state.playPolicy.mode = 'free' })
  await c.boot()
  assert.equal(attempts, 1)
  assert.equal(stops, 0, 'free уже отменил старое намерение; кампания не должна трогать новое')
})

test('ВЕХА только по итогу: eyes при 2 очах и 0 жемчуга — этап снят без итога, не ВЕХА', async () => {
  const state: Record<string, any> = { health: 20, food: 20, dimension: 'overworld', pos: { x: 0, y: 64, z: 0 },
    inventory: { ender_pearl: 2, blaze_rod: 3, crafting_table: 1 } }
  const logs = []
  const c = campaign(state, { surface: true, foes: 0 }, (method, params) => {
    if (method === 'craft' && params.item === 'blaze_powder') { state.inventory.blaze_powder = params.count; state.inventory.blaze_rod -= Math.ceil(params.count / 2) }
    if (method === 'craft' && params.item === 'ender_eye') {
      state.inventory.ender_eye = params.count; state.inventory.ender_pearl -= params.count; state.inventory.blaze_powder -= params.count
      if (!state.inventory.ender_pearl) delete state.inventory.ender_pearl
    }
    return {} as Record<string, any>
  }, { logs, argv: ['eyes'] })
  c.hooks({ recoverGuard: async () => {} })
  c.keepStages(['eyes'])
  await c.boot()
  assert.equal(state.inventory.ender_eye, 2)
  const text = logs.join('')
  assert.doesNotMatch(text, /ВЕХА eyes/, 'два ока из двенадцати — не итог этапа')
  assert.match(text, /итог этапа: снят без итога/)
})

test('ВЕХА по итогу: этап без своего done() остаётся вехой, когда он не нужен', async () => {
  const state: Record<string, any> = { health: 20, food: 20, dimension: 'overworld', pos: { x: 0, y: 64, z: 0 }, inventory: {} as Record<string, any> }
  const logs = []
  const c = campaign(state, { surface: true, foes: 0 }, () => ({} as Record<string, any>), { logs, argv: ['iron'] })
  c.hooks({ recoverGuard: async () => {} })
  c.ironOnly(async () => { state.inventory.iron_pickaxe = 1 })
  await c.boot()
  assert.match(logs.join(''), /ВЕХА iron/)
})
