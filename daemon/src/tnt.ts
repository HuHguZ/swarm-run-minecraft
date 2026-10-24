'use strict'
// Динамит у цели (пользователь 14.10: «динамитом взрывать — достать игрока или разнести колизей к чертям, договариваться в
// команде, больше анархии и хаоса»). Поставить TNT в пустую клетку у точки (у его ног, у опоры столба, у стены укрытия) и
// поджечь огнивом или огненным зарядом: фитиль 80 тиков (PrimedTnt), взрыв силой 4 ломает песчаник и кварц колизея
// (стойкость 0.8). Честно: клетка ставится по видимой грани (build honest), поджиг — взглядом на блок. Отбежать — дело
// вызывающего (драйвер роя: отход и предупреждение своих).
// Итог: { ok, placed, lit, why }.
const Vec3: typeof import('vec3').Vec3 = require('vec3')
import build = require('./build')
import pick = require('./pick')
import { blastTeamRisk } from './combat/ally-safety'

function tntTeamRisk(bot, center) {
  return blastTeamRisk(bot, center, 4)
}

// activateBlock performs another asynchronous smooth look. Keep the final guard and 1.21.11 click in one stack.
function igniteTntNow(bot, c, { reach = 4.5, ctl = null, beforeIgnite = null }: any = {}) {
  if (ctl?.aborted || beforeIgnite && !beforeIgnite() || bot.blockAt(c)?.name !== 'tnt' || !/^(flint_and_steel|fire_charge)$/.test(bot.heldItem?.name))
    return { ok: false, why: 'обстановка изменилась перед поджигом' }
  const eye = pick.eyeOf(bot), { yaw, pitch } = bot.entity
  const dir = new Vec3(-Math.sin(yaw) * Math.cos(pitch), Math.sin(pitch), -Math.cos(yaw) * Math.cos(pitch))
  const hit = pick.blockOnRay(bot, eye, dir, reach)
  if (!hit?.pos.equals(c) || !pick.blockAim(bot, c, { range: reach, seeThrough: null })) return { ok: false, why: 'динамит закрыт прицелом' }
  const cursor = eye.plus(dir.scaled(hit.t)).minus(c)
  const faces = [[1, 'y', 1], [0, 'y', 0], [2, 'z', 0], [3, 'z', 1], [4, 'x', 0], [5, 'x', 1]] as const
  const face = [...faces].sort((a, b) => Math.abs(cursor[a[1]] - a[2]) - Math.abs(cursor[b[1]] - b[2]))[0][0]
  const allyRisk = tntTeamRisk(bot, c.offset(.5, 0, .5))
  if (allyRisk.unsafe) return { ok: false, why: 'союзник под взрывом динамита', allyRisk }
  bot._client.write('block_place', { location: c, direction: face, hand: 0, cursorX: cursor.x, cursorY: cursor.y, cursorZ: cursor.z, insideBlock: false, sequence: 0, worldBorderHit: false })
  return { ok: true }
}

async function tntAt (session, ctl, { at, reach = 4.5, maxOff = 1.6, exact = false, beforeIgnite = null }: any = {}): Promise<{ ok: boolean, placed?: any, lit?: boolean, why?: string, allyRisk?: ReturnType<typeof tntTeamRisk> }> {
  const bot = session.require()
  if (!at || ![at.x, at.y, at.z].every(Number.isFinite)) return { ok: false, why: 'нужна точка at' }
  const items = bot.inventory.items()
  const tnt = items.find(i => i.name === 'tnt')
  const fire = items.find(i => i.name === 'flint_and_steel') || items.find(i => i.name === 'fire_charge')
  if (!tnt || !fire) return { ok: false, why: !tnt ? 'нет динамита' : 'нечем поджечь' }
  const eye = bot.entity.position.offset(0, 1.62, 0)
  const t = new Vec3(Math.floor(at.x), Math.floor(at.y), Math.floor(at.z))
  // Клетки: точка и соседи ±1 (по высоте дороже); пустая, не вода/лава, в досягаемости; ближе к точке — лучше.
  const cells: any[] = []
  for (const dy of exact ? [0] : [-1, 0, 1]) for (let dx = -1; dx <= 1; dx++) for (let dz = -1; dz <= 1; dz++) {
    const c = t.offset(dx, dy, dz); const b = bot.blockAt(c)
    if (!b || b.boundingBox !== 'empty' || /water|lava|fire/.test(b.name)) continue
    if (c.offset(0.5, 0.5, 0.5).distanceTo(eye) > reach) continue
    // Вплотную к точке (ноги цели), не у себя (15.10: «динамит криво — задел своего, а не красного; под игрока прям ставить»).
    const off = Math.hypot(c.x + 0.5 - at.x, c.z + 0.5 - at.z)
    if (off > maxOff || c.offset(0.5, 0, 0.5).distanceTo(bot.entity.position) < 1.2) continue
    if (tntTeamRisk(bot, c.offset(.5, 0, .5)).unsafe) continue
    cells.push({ c, cost: off + Math.abs(dy) * 1.5 })
  }
  cells.sort((a, b) => a.cost - b.cost)
  let why = cells.length ? 'некуда поставить у цели' : 'клетка у его ног вне досягаемости'
  for (const { c } of cells.slice(0, 6)) {
    if (ctl?.aborted) return { ok: false, why: 'прервано' }
    const r = await build.placeBlockAt(bot, c, { item: 'tnt', honest: true, ctl, timeoutMs: 2500 })
    if (!r.ok || r.already) { why = r.reason || why; continue }
    const block = bot.blockAt(c)
    if (!block || block.name !== 'tnt') continue
    const lighter = bot.inventory.items().find(i => i.name === fire.name)
    if (!lighter) return { ok: false, placed: c, why: 'огниво пропало' }
    await bot.equip(lighter, 'hand')
    const aim = pick.blockAim(bot, c, { range: reach, seeThrough: null })
    if (!aim) return { ok: false, placed: c, lit: false, why: 'динамит закрыт прицелом' }
    await bot.lookAt(aim, true)
    const ignition = igniteTntNow(bot, c, { reach, ctl, beforeIgnite })
    if (!ignition.ok) return { ...ignition, placed: c, lit: false }
    await bot.waitForTicks(3)
    // Зажжённый динамит — уже сущность, в клетке пусто.
    const lit = bot.blockAt(c)?.name !== 'tnt'
    return { ok: lit, placed: { x: c.x, y: c.y, z: c.z }, lit, why: lit ? null : 'не загорелся' }
  }
  return { ok: false, why }
}

export { tntAt, tntTeamRisk, igniteTntNow }
