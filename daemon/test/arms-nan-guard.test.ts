import test from 'node:test'
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import * as melee from '../src/melee'

// Ход с NaN не уходит на сервер (Paper кикает «Invalid move player packet received»), обычный — уходит.
test('nan-guard: position/look с NaN не отправляются, конечные — отправляются', async () => {
  const sent: string[] = []
  const bot: any = new EventEmitter()
  bot._client = new EventEmitter()
  bot._client.write = (name: string) => { sent.push(name) }
  bot.inventory = { slots: [] }
  bot.entity = { position: { x: 0, y: 64, z: 0 }, velocity: { x: 0, y: 0, z: 0 }, yaw: 0, pitch: 0 }
  const looks: number[][] = []
  bot.look = async (yaw: number, pitch: number) => { looks.push([yaw, pitch]) }
  const ats: any[] = []
  bot.lookAt = async (p: any) => { ats.push(p) }
  const log = console.log
  console.log = () => {}
  try {
    const M = melee.install(bot)
    bot._client.write('position_look', { x: NaN, y: 64, z: 0, yaw: 0, pitch: 0, flags: 0 })
    bot._client.write('look', { yaw: Infinity, pitch: 0, flags: 0 })
    bot._client.write('position', { x: 1, y: 64, z: 2, flags: 1 })
    assert.deepEqual(sent, ['position'])
    assert.equal(M.nanDropped, 2)
    bot.entity.yaw = 1.5; bot.entity.yaw = NaN; bot.entity.pitch = -Infinity
    assert.equal(bot.entity.yaw, 1.5, 'NaN во взгляд не записывается')
    assert.equal(bot.entity.pitch, 0)
    assert.equal(bot.entity._ndAngleRejects, 2)
    await bot.look(NaN, 0, true); await bot.look(0.5, 0.1, true)
    assert.deepEqual(looks, [[0.5, 0.1]], 'look(NaN) не доходит до физики')
    await bot.lookAt({ x: NaN, y: 1, z: 2 }); await bot.lookAt({ x: 1, y: 1, z: 2 })
    assert.equal(ats.length, 1, 'lookAt на точку с NaN не доходит')
  } finally { console.log = log }
})


// S7d (пункт H): щит против топора — не запрет, а подъём ровно под его взмах (jar: удар топором по поднятому щиту
// гасится целиком, щит выключается на 5 с); заранее не держит, после взмаха — вниз. ND_SHIELD_AXE=0 — прежний запрет.
test('щит против топора: поднять под его взмах (5 т), заранее и после — вниз; ND_SHIELD_AXE=0 — всегда вниз', () => {
  const bot: any = new EventEmitter()
  bot._client = new EventEmitter()
  bot._client.write = () => {}
  bot.inventory = { slots: [] }
  bot.entity = { position: { x: 0, y: 64, z: 0 }, velocity: { x: 0, y: 0, z: 0 }, yaw: 0, pitch: 0 }
  bot.look = async () => {}
  bot.lookAt = async () => {}
  const log = console.log
  console.log = () => {}
  try {
    const f = melee.fight(bot, { target: () => null })
    const axe = { theirR: 2.8, hisHand: 'diamond_axe', myLeftMs: 400, inMyReach: true }
    assert.equal(f.shield({ ...axe, hisReadyMs: 200 }), 'raise', 'его взмах через 4 т — щит вверх')
    assert.equal(f.shield({ ...axe, hisReadyMs: 400 }), 'lower', 'до взмаха 8 т — не держу заранее')
    assert.equal(f.shield({ ...axe, hisReadyMs: 900 }), 'lower', 'после взмаха — вниз')
    assert.equal(f.shield({ ...axe, hisReadyMs: 200, myLeftMs: 0 }), 'lower', 'мой удар готов и он в руке — бью, не закрываюсь')
    process.env.ND_SHIELD_AXE = '0'
    try { assert.equal(f.shield({ ...axe, hisReadyMs: 200 }), 'lower') } finally { delete process.env.ND_SHIELD_AXE }
  } finally { console.log = log }
})
