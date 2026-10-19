'use strict'
// Отбрасывание: куда кинет удар со спринтом, толчок к обрыву (pushPlan), своё отбрасывание из пакета сервера.
// ---------------------------------------------------------------- удары
import { KB_HIT, KB_SPRINT, RESIST_PER_NETHERITE, IDLE, worldOf, support, lethalAt, clearance, hazardAround,
  cloneState, run, stateOf } from './forecast'
const Vec3: typeof import('vec3').Vec3 = require('vec3')
const geometry: typeof import('../navigation/geometry') = require('../navigation/geometry')
function netheriteResist (items) {
  let n = 0
  for (const it of items || []) if (it && /^netherite_(helmet|chestplate|leggings|boots)$/.test(it.name)) n++
  return Math.min(1, n * RESIST_PER_NETHERITE)
}
// Сопротивление отбрасыванию: броня сущности (entity.equipment 2..5) или своя
// (слоты 5..8).
function resistOf (bot, e) {
  if (e === bot.entity) return netheriteResist([5, 6, 7, 8].map(s => bot.inventory.slots[s]))
  return netheriteResist((e.equipment || []).slice(2, 6))
}

// LivingEntity.knockback(s, x, z): скорость = старая/2 − (x, z)/|(x, z)|·s;
// вверх, если на земле, — min(0.4, vy/2 + s).
function knockback (vel, s, x, z, onGround) {
  const n = Math.hypot(x, z) || 1
  return new Vec3(vel.x / 2 - x / n * s, onGround ? Math.min(0.4, vel.y / 2 + s) : vel.y, vel.z / 2 - z / n * s)
}

// Скорость жертвы после удара: сперва 0.4 от бьющего (hurtServer), потом за
// спринт +0.5 по его взгляду (causeExtraKnockback). mineflayer: взгляд =
// (−sin yaw, −cos yaw), так что толчок «по взгляду» — это x = sin, z = cos.
// kb — уровень «Отдачи» на оружии бьющего (арена с чарами): Player.attack
// толкает вторым вызовом с силой 0.5 × (уровень + спринт) — getKnockback даёт
// +1 за уровень (effect minecraft:knockback, linear base 1), спринт ещё +1.
function hitVelocity ({ vel, pos, onGround }: any, from, lookYaw, { sprint = false, resist = 0, kb = 0 }: any = {}) {
  const k = 1 - resist
  let v = knockback(vel || new Vec3(0, 0, 0), KB_HIT * k, from.x - pos.x, from.z - pos.z, onGround)
  const extra = KB_SPRINT * ((sprint ? 1 : 0) + Math.max(0, kb || 0))
  if (extra > 0) v = knockback(v, extra * k, Math.sin(lookYaw), Math.cos(lookYaw), onGround)
  return v
}

// Полёт тела после удара той же физикой. Жертва смотрит на бьющего и держит
// «вперёд» (counter) — так гасят отбрасывание в воздухе; без counter — стоит.
function knockRun (bot, base, pos, vel, onGround, faceYaw, counter, cache, world?: any) {
  const st = cloneState(base, counter ? { ...IDLE, forward: true, sprint: true } : IDLE)
  st.pos = pos.clone()
  st.vel = vel.clone()
  st.onGround = onGround
  st.isInWater = false
  st.isInLava = false
  st.isInWeb = false
  st.yaw = faceYaw
  const groundY = onGround ? pos.y : pos.y - Math.max(0, support(bot, pos, cache).drop)
  // Полёт после удара ~10 тиков, потом скольжение: 28 тиков с запасом.
  return run(bot, st, st.control, { hold: 28, max: 28, groundY, cache, world })
}

function yawFrom (a, b) { return Math.atan2(-(b.x - a.x), -(b.z - a.z)) }

// Нас бьют из foePos со спринтом (взгляд на нас) — не в яму ли. Считаем с
// нашим встречным «вперёд» (рефлекс рулит в полёте) — если и так в яму,
// стоим спиной к обрыву.
function backToDrop (bot, foePos, { sprint = true, kb = 0 }: any = {}) {
  const me = bot.entity
  const cache = new Map()
  if (!hazardAround(bot, me.position, 6, cache)) return null
  const base = stateOf(bot)
  const v = hitVelocity({ vel: me.velocity, pos: me.position, onGround: me.onGround }, foePos, yawFrom(foePos, me.position), { sprint, kb, resist: resistOf(bot, me) })
  // Модель сходится с игрой (try-knock.js, 2026-09-26: толчок 0.4 — 1.99
  // блока и в замере, и в прогоне). Запас 10% — на пинг и на то, что его
  // позицию мы видим с опозданием: для себя берём худший случай.
  v.x *= 1.1; v.z *= 1.1
  const r = knockRun(bot, base, me.position, v, me.onGround, yawFrom(me.position, foePos), true, cache)
  return r.fall ? { fall: true, at: r.at, t: r.t } : null
}

// Яма по линии толчка (2026-09-26): от точки from через нас на dist блоков —
// под рамкой пусто глубже SAFE_FALL или лава (lethalAt). Для «не прыгать у
// края»: его спринт-удар (0.4 + 0.5, LivingEntity.knockback и
// Player.causeExtraKnockback) уносит тело в прыжке на 4–5 блоков — прыжок за
// критом, жест «прыжки», jump-reset к нему — только если по линии чисто.
function dropAlong (bot, from, dist = 4.5) {
  const me = bot.entity && bot.entity.position
  if (!me || !from) return false
  const cache = new Map()
  if (!hazardAround(bot, me, Math.ceil(dist) + 1, cache)) return false
  let dx = me.x - from.x
  let dz = me.z - from.z
  const n = Math.hypot(dx, dz)
  if (n < 1e-3) return hazardAround(bot, me, 2, cache)
  dx /= n; dz /= n
  for (let t = 0.25; t <= dist + 1e-6; t += 0.25) {
    if (lethalAt(bot, new Vec3(me.x + dx * t, me.y, me.z + dz * t), cache)) return true
  }
  return false
}

// Толкнуть его в яму. now — удар отсюда и сейчас сбросит его: 'hit' (хватит
// обычного, даже если он тянет назад), 'sprint' (нужен спринт-удар), null.
// stand — откуда бить (точка за ним на линии «яма → он»), если сейчас не
// выходит, а с другой стороны — да. ours — наш взгляд (yaw) на него.
function pushPlan (bot, foe, { vel = null, reach = 2.7, kb = null }: any = {}) {
  const cache = new Map()
  const fp = foe.position
  if (!hazardAround(bot, fp, 5, cache)) return null
  const world = worldOf(bot)
  const base = stateOf(bot)
  const resist = resistOf(bot, foe)
  const fv = vel ? new Vec3(vel.x, 0, vel.z) : new Vec3(0, 0, 0)
  // onGround чужих сущностей mineflayer не ведёт (всегда undefined — находка
  // mace.js 2026-09-26): на земле ли он — по опоре под рамкой.
  const onGround = support(bot, fp, cache).drop <= 0.05
  const me = bot.entity.position
  // Своя «Отдача» на том, чем бьём (арена с чарами) — толкает дальше.
  if (kb == null) { try { kb = bot.heldItem ? (require('../read') as typeof import('../read')).enchLevel(bot, bot.heldItem, 'knockback') : 0 } catch { kb = 0 } }
  const outcome = (from, sprint, counter) => {
    const look = yawFrom(from, fp)
    const v = hitVelocity({ vel: fv, pos: fp, onGround }, from, look, { sprint, resist, kb })
    return knockRun(bot, base, fp, v, onGround, yawFrom(fp, from), counter, cache, world).fall
  }
  let now = null
  if (outcome(me, false, true)) now = 'hit'
  else if (outcome(me, true, true) || outcome(me, true, false)) now = 'sprint'
  if (now) return { now, stand: null }
  // Откуда бы вышло: 16 сторон вокруг него, бьём с края досягаемости.
  const bearing = yawFrom(me, fp)
  let best = null
  for (let i = 0; i < 16; i++) {
    const yaw = (i / 16) * Math.PI * 2
    // Точка бьющего: от него против направления толчка.
    const from = new Vec3(fp.x + Math.sin(yaw) * reach, fp.y, fp.z + Math.cos(yaw) * reach)
    if (!outcome(from, true, false)) continue
    // Нам там стоять можно: не над ямой и не у самого края.
    // И тело там помещается (Codex 15.10: «sure» давал стойку внутри камня).
    if (!geometry.bodyClear(bot, from) || lethalAt(bot, from, cache) || clearance(bot, from, 0.6, cache) < 0.35) continue
    let dy = Math.abs(yaw - bearing) % (Math.PI * 2)
    if (dy > Math.PI) dy = Math.PI * 2 - dy
    const sure = outcome(from, true, true)
    const sc = dy - (sure ? 0.6 : 0)
    if (!best || sc < best.sc) best = { sc, from, yaw, sure }
  }
  return best ? { now: null, stand: best.from, look: best.yaw, sure: best.sure } : { now: null, stand: null }
}

// ---------------------------------------------------------------- отбрасывание

// mineflayer 4.37 на 1.21.11: скорость в пакете entity_velocity приходит уже
// в блоках за тик (тип lpVec3, minecraft-protocol datatypes/lpVec3.js), а
// mineflayer entities.js делит её на 8000, как старые short-значения. Своё
// отбрасывание бот получал в 8000 раз слабее — удар его не сдвигал вовсе
// (замер 2026-09-26, try-knock.js: /damage … by — сдвиг 0.00 при 1.99 по
// формуле игры). Ставим скорость как есть, после обработчика mineflayer.
// И сам разбор lpVec3 в minecraft-protocol (datatypes/lpVec3.js) читает
// 4 старших байта как little-endian (readUInt32LE), а игра пишет их
// big-endian (LpVec3.write → ByteBuf.writeInt): y и z приходили мусором —
// {x: 3, y: 2.98, z: 2.65} при ударе в 0.4, бота однажды унесло на 86 блоков
// вверх (прогон 2026-09-26). Поэтому скорость читаем из сырого пакета сами.
function readVarInt (buf, off) {
  let v = 0; let shift = 0; let b
  do { b = buf[off++]; v |= (b & 0x7f) << shift; shift += 7 } while (b & 0x80 && shift < 35)
  return { v, off }
}
function readLpVec3BE (buf, off) {
  const a = buf[off]
  if (a === 0) return { x: 0, y: 0, z: 0 }
  const b = buf[off + 1]
  const c = buf.readUInt32BE(off + 2)
  const packed = c * 65536 + b * 256 + a
  let scale = a & 3
  if ((a & 4) === 4) scale += readVarInt(buf, off + 6).v * 4
  // LpVec3.unpack: (min(v & 32767, 32766) * 2 / 32766) − 1.
  const unpack = (shift) => { const v = Math.floor(packed / Math.pow(2, shift)) % 32768; return Math.min(v, 32766) * 2 / 32766 - 1 }
  return { x: unpack(3) * scale, y: unpack(18) * scale, z: unpack(33) * scale }
}

function fixSelfKnockback (bot) {
  if (!bot || !bot._client || bot._ndKbFix) return
  // Только там, где скорость в пакете — lpVec3 (1.21.9+); раньше были short
  // в 1/8000, и их mineflayer считает верно.
  let lp = false
  try { lp = /lpVec3/.test(JSON.stringify(bot.registry.protocol.play.toClient.types.packet_entity_velocity)) } catch {}
  if (!lp) return
  bot._ndKbFix = true
  // minecraft-protocol шлёт raw.* после разобранного пакета — то есть после
  // обработчика mineflayer: здесь его неверная скорость и заменяется.
  bot._client.on('raw.entity_velocity', (buf) => {
    try {
      if (!bot.entity || !buf) return
      // Буфер raw.* — весь пакет с номером впереди (protodef parsePacketBuffer: buffer = пакет целиком), id сущности —
      // после номера. Прежняя попытка «и без номера» (start 0) читала номер пакета 0x63 = 99 как id: у тела с id 99 (слот 31
      // 06.10, S2b: 106 753 «странных скоростей» за 2 мин) ЧУЖИЕ скорости шли в тело — оно прыгало в яме.
      for (const start of [readVarInt(buf, 0).off]) {
        const id = readVarInt(buf, start)
        if (id.v !== bot.entity.id) continue
        const { x, y, z } = readLpVec3BE(buf, id.off)
        // Больше предела тела — не верить, а записать в лог. По вертикали предел — скорость падения (3.92 бл./тик, LivingEntity
        // travel: 0.98 на тик и −0.08): сервер шлёт её в пакете удара посреди падения (c13–c16 14.10: «странная скорость»
        // y −1.9…−2.2 перед каждым падением в лаву — клиент оставлял неверную скорость mineflayer). По горизонтали — взрыв рядом.
        if (Math.hypot(x, z) > 4 || Math.abs(y) > 4 || ![x, y, z].every(Number.isFinite)) {
          console.log('[kb] странная скорость — не применяю', JSON.stringify({ x, y, z }))
          return
        }
        bot.entity.velocity.set(x, y, z)
        return
      }
    } catch {}
  })
}

export { resistOf, knockback, hitVelocity, knockRun, backToDrop, dropAlong, pushPlan, fixSelfKnockback }
