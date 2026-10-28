'use strict'
// ND_SH_VPROBE (sr27-end): у надёжной оценки «пирога» по x/z, рамок не видно — ступенями вверх по 3 до +12, потом вниз до −12,
// сквозь кирпич (bricks: null); без флага, без точной оценки или далеко по x/z — шаг не делает ничего.
import test = require('node:test')
import assert = require('node:assert/strict')
const Vec3: typeof import('vec3').Vec3 = require('vec3')

function scene (lure, { precise = true } = {}) {
  const D: any = require('../src/endportal-descent')
  const saved = D.toLevel
  const bot: any = { entity: { position: new Vec3(0.5, -16, 0.5) } }
  const calls = []
  D.toLevel = async (_s, _c, ty, o) => { calls.push({ ty, bricks: o.bricks }); bot.entity.position = new Vec3(0.5, ty, 0.5); return { ok: true, moved: 1 } }
  const rx: any = { session: { bot, _roomExplore: {} }, ctl: { aborted: false }, bot, deadline: Infinity, legs: [], lure: lure && new Vec3(lure.x, lure.y, lure.z), lurePie: true, lurePrecise: precise }
  return { rx, bot, calls, restore () { D.toLevel = saved } }
}

test('probe climbs in steps of 3 up to +12, then turns down to −12 below the start, through bricks', async () => {
  const env = process.env.ND_SH_VPROBE; process.env.ND_SH_VPROBE = '1'
  const s = scene({ x: 2, y: -16, z: 1 })
  try {
    const { roomVProbe } = require('../src/endportal/room-steps')
    const turns = []
    for (let i = 0; i < 16; i++) turns.push(await roomVProbe(s.rx, {}))
    const ys = s.calls.map(c => c.ty)
    assert.deepEqual(ys.slice(0, 4), [-13, -10, -7, -4], 'вверх по 3')
    assert.ok(ys.includes(-28) || ys.some(y => y <= -25), `вниз до −12 от старта: ${ys}`)
    assert.ok(s.calls.every(c => c.bricks === null), 'кирпич крепости копается')
    assert.equal(turns.filter(t => t === 'next').length, s.calls.length)
    assert.ok(s.calls.length <= 14, 'не больше 14 оборотов на одну оценку')
  } finally { s.restore(); if (env === undefined) delete process.env.ND_SH_VPROBE; else process.env.ND_SH_VPROBE = env }
})

test('probe is idle without the flag, with an imprecise estimate, or far from it', async () => {
  const env = process.env.ND_SH_VPROBE
  const { roomVProbe } = require('../src/endportal/room-steps')
  try {
    delete process.env.ND_SH_VPROBE
    let s = scene({ x: 2, y: -16, z: 1 }); assert.equal(await roomVProbe(s.rx, {}), undefined); s.restore()
    process.env.ND_SH_VPROBE = '1'
    s = scene({ x: 2, y: -16, z: 1 }, { precise: false }); assert.equal(await roomVProbe(s.rx, {}), undefined); s.restore()
    s = scene({ x: 20, y: -16, z: 1 }); assert.equal(await roomVProbe(s.rx, {}), undefined); assert.equal(s.calls.length, 0); s.restore()
  } finally { if (env === undefined) delete process.env.ND_SH_VPROBE; else process.env.ND_SH_VPROBE = env }
})
