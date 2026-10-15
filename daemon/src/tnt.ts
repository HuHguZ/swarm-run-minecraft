'use strict'
// Динамит у цели (пользователь 14.10: «динамитом взрывать — достать игрока или разнести колизей к чертям, договариваться в
// команде, больше анархии и хаоса»). Поставить TNT в пустую клетку у точки (у его ног, у опоры столба, у стены укрытия) и
// поджечь огнивом или огненным зарядом: фитиль 80 тиков (PrimedTnt), взрыв силой 4 ломает песчаник и кварц колизея
// (стойкость 0.8). Честно: клетка ставится по видимой грани (build honest), поджиг — взглядом на блок. Отбежать — дело
// вызывающего (драйвер роя: отход и предупреждение своих).
// Итог: { ok, placed, lit, why }.
const Vec3 = require('vec3')
const build = require('./build')

async function tntAt (session, ctl, { at, reach = 4.5, maxOff = 1.6 }: any = {}) {
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
  for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) for (let dz = -1; dz <= 1; dz++) {
    const c = t.offset(dx, dy, dz); const b = bot.blockAt(c)
    if (!b || b.boundingBox !== 'empty' || /water|lava|fire/.test(b.name)) continue
    if (c.offset(0.5, 0.5, 0.5).distanceTo(eye) > reach) continue
    // Вплотную к точке (ноги цели), не у себя (15.10: «динамит криво — задел своего, а не красного; под игрока прям ставить»).
    const off = Math.hypot(c.x + 0.5 - at.x, c.z + 0.5 - at.z)
    if (off > maxOff || c.offset(0.5, 0, 0.5).distanceTo(bot.entity.position) < 1.2) continue
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
    await bot.lookAt(c.offset(0.5, 0.5, 0.5), true)
    await bot.activateBlock(block).catch(() => {})
    await bot.waitForTicks(3)
    // Зажжённый динамит — уже сущность, в клетке пусто.
    const lit = bot.blockAt(c)?.name !== 'tnt'
    return { ok: lit, placed: { x: c.x, y: c.y, z: c.z }, lit, why: lit ? null : 'не загорелся' }
  }
  return { ok: false, why }
}

module.exports = { tntAt }
