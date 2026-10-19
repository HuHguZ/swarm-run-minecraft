import test from 'node:test'
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { Vec3 } from 'vec3'
import { swatInstall } from '../src/ne-guard'

// Шар гаста: сервер шлёт его позицию раз в 10 тиков (EntityType.FIREBALL updateInterval 10), тело ведёт его само
// (AbstractHurtingProjectile: v = (v + норм(v)·0.1)·0.95, pos += v) и бьёт в первый тик досягаемости — взгляд тиком раньше,
// на поздней границе тика: навык, ставящий свой взгляд в physicsTick, его не перебивает.
const step = (s: any) => {
  const n = Math.hypot(s.vx, s.vy, s.vz)
  for (const a of ['x', 'y', 'z']) s['v' + a] = (s['v' + a] + s['v' + a] / n * 0.1) * 0.95
  s.x += s.vx; s.y += s.vy; s.z += s.vz
}
// От глаз до рамки шара 1×1; g — раздутие рамки прицела (Projectile.getPickRadius 1.0).
const reach = (eye: any, s: any, g = 0) => Math.hypot(Math.max(s.x - 0.5 - g - eye.x, 0, eye.x - s.x - 0.5 - g),
  Math.max(s.y - g - eye.y, 0, eye.y - s.y - 1 - g), Math.max(s.z - 0.5 - g - eye.z, 0, eye.z - s.z - 0.5 - g))
function body(fireball: any) {
  const bot: any = new EventEmitter()
  bot._client = new EventEmitter()
  bot.registry = { entitiesByName: { fireball: { id: 7 }, player: { metadataKeys: [] } } }
  bot.entity = { id: 1, position: new Vec3(0.5, 64, 0.5), height: 1.8, metadata: [], yaw: 0, pitch: 0 }
  bot.entities = { 2: { id: 2, name: 'ghast', position: new Vec3(20.5, 66, 0.5) },
    9: { id: 9, name: 'fireball', position: new Vec3(fireball.x, fireball.y, fireball.z), width: 1, height: 1 } }
  bot.nearestEntity = (f: any) => Object.values(bot.entities).find(f) || null
  bot.usingHeldItem = false
  return bot
}

for (const shield of [false, true]) test(`шар гаста отбивается в досягаемости, щит ${shield ? 'опускается' : 'не поднят'}`, () => {
  const events: string[] = []
  const server: any = { x: 16.5, y: 68.5, z: 0.5 }
  const bot = body(server)
  bot.usingHeldItem = shield
  bot.deactivateItem = () => { bot.usingHeldItem = false; events.push('down') }
  bot.look = async (yaw: number, pitch: number) => { events.push('look'); bot.entity.yaw = yaw; bot.entity.pitch = pitch }
  // Взгляд, ушедший пакетом в конце прошлого тика: по нему сервер отклоняет шар (AIM_DEFLECT).
  let sent = { yaw: 0, pitch: 0 }
  let atAttack: any = null
  bot.attack = (e: any) => { events.push('attack'); atAttack = { server: { ...server }, seen: e.position.clone(), look: sent } }
  swatInstall(bot)
  // Навык после сторожа каждый тик смотрит себе под ноги.
  bot.on('physicsTick', () => { bot.entity.yaw = 0; bot.entity.pitch = -1.5 })
  // Гаст целит в середину тела (GhastShootFireballGoal), стартовая скорость — направление × 0.1.
  const dir = new Vec3(0.5 - server.x, 64.9 - server.y, 0.5 - server.z).normalize()
  Object.assign(server, { vx: dir.x * 0.1, vy: dir.y * 0.1, vz: dir.z * 0.1 })
  bot._client.emit('spawn_entity', { entityId: 9, type: 7, x: server.x, y: server.y, z: server.z })
  bot._client.emit('sync_entity_position', { entityId: 9, x: server.x, y: server.y, z: server.z, dx: server.vx, dy: server.vy, dz: server.vz })
  const eye = bot.entity.position.offset(0, 1.62, 0)
  for (let tick = 1; tick <= 60 && !atAttack; tick++) {
    step(server)
    // Сервер поправляет позицию раз в 10 тиков, между ними тело знает только свой расчёт.
    if (tick % 10 === 0) bot._client.emit('sync_entity_position', { entityId: 9, x: server.x, y: server.y, z: server.z, dx: server.vx, dy: server.vy, dz: server.vz })
    bot.emit('physicsTick')
    if (atAttack) break
    bot.emit('physicTick')
    sent = { yaw: bot.entity.yaw, pitch: bot.entity.pitch }
  }
  assert.ok(atAttack, `удара нет: ${events.join(',')}`)
  // Прицел клиента — по видимому шару (3 бл. до рамки прицела), сервер принимает удар до 3 + 3 бл. (canInteractWithEntity) и до касания тела.
  assert.ok(reach(eye, atAttack.seen, 1) <= 3, `удар вне досягаемости прицела: ${reach(eye, atAttack.seen, 1).toFixed(2)}`)
  assert.ok(reach(eye, atAttack.server) <= 6, `сервер не примет удар: ${reach(eye, atAttack.server).toFixed(2)}`)
  assert.ok(Math.abs(atAttack.server.x - 0.5) >= 0.6, 'шар уже в рамке тела')
  assert.deepEqual(events.slice(shield ? -3 : -2), shield ? ['down', 'look', 'attack'] : ['look', 'attack'])
  // Шар уходит по взгляду — к гасту, а не под ноги.
  const { yaw, pitch } = atAttack.look
  const look = new Vec3(-Math.sin(yaw) * Math.cos(pitch), Math.sin(pitch), -Math.cos(yaw) * Math.cos(pitch))
  assert.ok(look.dot(new Vec3(20.5, 68, 0.5).minus(eye).normalize()) > 0.95, `взгляд удара не на гаста: ${JSON.stringify(atAttack.look)}`)
  assert.equal(bot._ndSwat.n, 1)
})

test('шар мимо тела не отбивается', () => {
  const bot = body({ x: 16.5, y: 68.5, z: 6.5 })
  let attacks = 0
  bot.look = async () => {}
  bot.attack = () => { attacks++ }
  swatInstall(bot)
  bot._client.emit('spawn_entity', { entityId: 9, type: 7, x: 16.5, y: 68.5, z: 6.5 })
  bot._client.emit('sync_entity_position', { entityId: 9, x: 16.5, y: 68.5, z: 6.5, dx: -0.1, dy: 0, dz: 0 })
  for (let tick = 0; tick < 40; tick++) { bot.emit('physicsTick'); bot.emit('physicTick') }
  assert.equal(attacks, 0)
})
