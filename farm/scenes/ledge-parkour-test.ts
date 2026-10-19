import { REPO_ROOT } from '../../daemon/src/paths'
// Native receipt test on an already running, EMPTY farm slot. Starts no server/daemon.
// node dist/farm/scenes/ledge-parkour-test.js <slot> [daemon-port=8800+slot] [bot=NeuroFarm<slot>]
import * as fs from 'node:fs'
import path = require('node:path')
import assert = require('node:assert/strict')
import { execFileSync } from 'node:child_process'
const ROOT = REPO_ROOT
const WebSocket = require(path.join(ROOT, 'daemon/node_modules/ws'))
const slot = Number(process.argv[2])
assert.ok(Number.isInteger(slot) && slot >= 1 && slot <= 32, 'an explicit farm slot 1..32 is required')
const port = Number(process.argv[3] || 8800 + slot), name = process.argv[4] || `NeuroFarm${slot}`
assert.ok(Number.isInteger(port) && port >= 8801 && port <= 8999 && /^\w{1,16}$/.test(name), 'invalid farm daemon port/name')
const X = 6000, Y = 200, Z = 6000
const rcon = command => execFileSync(process.execPath, [path.join(__dirname, '..', 'farm.js'), 'rcon', String(slot), command],
  { cwd: ROOT, encoding: 'utf8', timeout: 15000, windowsHide: true }).trim()
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms))
const detail = result => result.detail ?? result

function client() {
  const ws = new WebSocket(`ws://127.0.0.1:${port}`), pending = new Map<number, any>()
  let id = 0
  const ready = new Promise<void>((resolve, reject) => { ws.once('open', resolve); ws.once('error', reject) })
  const fail = error => { for (const p of pending.values()) { clearTimeout(p.timer); p.reject(error) } pending.clear() }
  ws.on('error', fail); ws.on('close', () => fail(new Error('RPC closed')))
  ws.on('message', raw => {
    const m = JSON.parse(String(raw)), p = pending.get(m.id)
    if (!p) return
    pending.delete(m.id); clearTimeout(p.timer)
    m.ok ? p.resolve(m.result) : p.reject(new Error(m.error || 'RPC rejected'))
  })
  return { call: async (method, params: any = {}) => {
    await ready
    return new Promise<any>((resolve, reject) => {
      const rid = ++id, timer = setTimeout(() => { pending.delete(rid); reject(new Error(`${method} timeout`)) }, 45000)
      pending.set(rid, { resolve, reject, timer }); ws.send(JSON.stringify({ id: rid, method, params }))
    })
  }, close: () => ws.terminate() }
}

async function main() {
  assert.ok(!/passed/i.test(rcon('execute if entity @a')), 'native ledge fixture requires an empty farm slot')
  const c = client(), rows: any[] = [], restore = new Map<string, string>()
  let fixture = false, connected = false, passed = false
  const arena = { x: X + 2, y: Y + 1, z: Z + 2, r: 4, killY: Y - 8 }
  try {
    await c.call('connect', { bootstrapPaused: true }); connected = true
    await c.call('temper', { enabled: false }); await c.call('stop')
    const status = await c.call('status', { physics: true })
    assert.equal(status.detail.server, `127.0.0.1:${25600 + slot}`, 'daemon must target the selected farm slot')
    assert.ok(/passed/i.test(rcon(`execute if entity ${name}`)), 'configured fixture bot must be present')
    for (const rule of ['fall_damage', 'keep_inventory', 'natural_health_regeneration']) {
      const value = /\b(true|false)\b/i.exec(rcon(`gamerule ${rule}`))?.[1]
      assert.ok(value, `cannot read ${rule}`); restore.set(rule, value)
      rcon(`gamerule ${rule} ${rule === 'fall_damage' ? 'true' : 'false'}`)
    }
    rcon(`forceload add ${X - 8} ${Z - 8} ${X + 12} ${Z + 12}`); fixture = true
    await sleep(3000)
    for (const cs of [{ name: 'rim', corner: false }, { name: 'corner', corner: true }, { name: 'underlip3', drop: 3, damage: 0 }, { name: 'underlip3_corner', drop: 3, corner: true, damage: 0 }, { name: 'occupied', blocked: true }, { name: 'low_hp', hp: 12 }, { name: 'boundary', radius: 3.3 }]) {
      rcon(`gamemode spectator ${name}`) // fixture rebuilding must not drop the previous case's body
      rcon(`fill ${X - 8} ${Y - 11} ${Z - 8} ${X + 12} ${Y + 5} ${Z + 12} air`)
      rcon(`fill ${X - 8} ${Y - 11} ${Z - 8} ${X + 12} ${Y - 11} ${Z + 12} stone`)
      rcon(`fill ${X} ${Y} ${Z} ${X + 3} ${Y} ${Z + 3} stone`)
      const to = { x: X + 3.5, y: Y + 1 - (cs.drop ?? 4), z: Z + (cs.corner ? 1.5 : 2.5) }
      rcon(`setblock ${X + 3} ${to.y - 1} ${Math.floor(to.z)} stone`)
      if (cs.corner) rcon(`fill ${X + 3} ${Y + 1} ${Z + 1} ${X + 3} ${Y + 3} ${Z + 1} stone`)
      if (cs.blocked) rcon(`setblock ${X + 3} ${to.y} ${Math.floor(to.z)} stone`)
      rcon(`tp ${name} ${X + 2.5} ${Y + 1} ${Z + 2.5} -90 0`)
      rcon(`gamemode survival ${name}`); rcon(`clear ${name}`); rcon(`effect clear ${name}`)
      rcon(`effect give ${name} instant_health 1 5 true`)
      await sleep(600)
      if (cs.hp) { rcon(`damage ${name} ${20 - cs.hp} minecraft:generic`); await sleep(250) }
      const before = await c.call('status', { physics: true })
      assert.equal(before.state.health, cs.hp ?? 20, 'native fixture health must be ready before asking the skill')
      assert.ok(Math.hypot(before.detail.physics.pos.x - X - 2.5, before.detail.physics.pos.z - Z - 2.5) < .1 &&
        Math.abs(before.detail.physics.pos.y - Y - 1) < .03, 'native fixture teleport must reach the supported roof before asking the skill')
      const result = detail(await c.call('ledge_to', { at: to, maxFallDamage: cs.damage ?? 1, timeoutSeconds: 8, arena: { ...arena, r: cs.radius ?? arena.r } }))
      const serverPos = rcon(`data get entity ${name} Pos`), serverHp = rcon(`data get entity ${name} Health`)
      const after = await c.call('status', { physics: true })
      const expected = !cs.blocked && !cs.hp && !cs.radius
      rows.push({ case: cs.name, expected, beforeHealth: before.state.health, before: before.detail.physics, result, after: after.detail.physics, serverPos, serverHp })
      assert.equal(result.ok, expected, `${cs.name}: ${JSON.stringify(result)}`)
      if (expected) {
        const pos = /\[([^\]]+)\]/.exec(serverPos)?.[1].split(',').map(v => Number(v.trim().replace(/d$/i, '')))
        assert.ok(pos && Math.hypot(pos[0] - to.x, pos[2] - to.z) < .35 && Math.abs(pos[1] - to.y) < .03, 'server must confirm the shelf landing')
        assert.ok(result.samples.length > 20 && result.samples.some(s => !s.onGround && s.pos.x > X + 4.3), 'native trace must include the exterior air phase')
        assert.ok(result.samples.every(s => Math.abs(s.pos.x - arena.x) + .3 <= arena.r - 1 && Math.abs(s.pos.z - arena.z) + .3 <= arena.r - 1 && s.pos.y > arena.killY))
        assert.equal(result.forecast?.fall?.damage ?? 0, cs.damage ?? 1, 'fall receipt must match the approved native forecast')
        assert.ok(new RegExp(`\\b${20 - (cs.damage ?? 1)}(?:\\.0)?f?\\s*$`).test(serverHp), 'server must confirm actual fall damage')
      } else assert.equal(result.ticks, 0, 'a refused launch must keep the body on the roof')
      assert.ok(!/No entity|found no/i.test(serverHp), 'death is a failed native case')
      console.log(JSON.stringify({ case: cs.name, ok: result.ok, expected, why: result.why, ticks: result.ticks, at: result.at }))
    }
    passed = true
  } finally {
    if (connected) { await c.call('stop').catch(() => {}); await c.call('disconnect', { reason: 'ledge fixture complete' }).catch(() => {}) }
    c.close()
    for (const [rule, value] of restore) rcon(`gamerule ${rule} ${value}`)
    if (fixture) {
      rcon(`fill ${X - 8} ${Y - 11} ${Z - 8} ${X + 12} ${Y + 5} ${Z + 12} air`)
      rcon(`forceload remove ${X - 8} ${Z - 8} ${X + 12} ${Z + 12}`)
    }
    const out = path.join(REPO_ROOT, 'farm/results', `ledge-native-${Date.now()}.json`)
    fs.mkdirSync(path.dirname(out), { recursive: true }); fs.writeFileSync(out, JSON.stringify({ slot, port, name, rows, passed }, null, 2))
    console.log(out)
  }
}
main().catch(error => { console.error(error); process.exitCode = 1 })
