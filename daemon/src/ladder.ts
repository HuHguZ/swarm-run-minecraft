'use strict'
// Приставная лестница на стену (пользователь 14.10: «лестницу строить не одноразовым столбом, а такую, по которой другие
// смогут залезть: найти дерево, скрафтить лестницу, ставить на блоки — по ней лезут несколько раз»). Стена — столбец
// твёрдых блоков (столб, что построил первый лезущий, или стена постройки): лестницы — в столбец клеток перед её гранью
// face, снизу доверху. Строитель путей лезет по лестницам сам (movements.climbables), в том числе без своих блоков.
// Честно, как игрок: первая ступень — с клетки за лестницей (грань стены перед глазами), дальше — изнутри лестницы:
// следующая над головой, на грань стены перед лицом (pick.faceAim); лезть — вперёд в стену и прыжок.
// Вход: wall {x,y,z} — нижний блок стены; face {x,z} — сторона лестницы (единичная по оси); top — верхний y стены.
// Итог: { ok, placed, at, why }; ok — стоит на верху стены или у верхней ступени.
const Vec3: typeof import('vec3').Vec3 = require('vec3')

async function ladderUp (session, ctl, { wall, face, top, timeoutSeconds = 40 }: any = {}) {
  const bot = session.require()
  if (!wall || !face || !Number.isFinite(top)) return { ok: false, why: 'нужны wall, face, top' }
  const dir = new Vec3(Math.sign(face.x) || 0, 0, Math.sign(face.z) || 0)
  if (Math.abs(dir.x) + Math.abs(dir.z) !== 1) return { ok: false, why: 'face — по одной оси' }
  const pick: typeof import('./pick') = require('./pick')
  const wallAt = y => new Vec3(wall.x, y, wall.z)
  const cellAt = y => wallAt(y).plus(dir)
  const solid = p => { const b = bot.blockAt(p); return !!b && b.boundingBox === 'block' }
  const isLadder = p => bot.blockAt(p)?.name === 'ladder'
  const deadline = Date.now() + timeoutSeconds * 1000
  let placed = 0
  const clear = () => { for (const k of ['forward', 'jump', 'sneak']) bot.setControlState(k, false) }
  ctl?.onAbort?.push(clear)
  // Ступень в клетку перед гранью стены на высоте y — по видимой грани.
  let why = ''
  const put = async (y) => {
    if (isLadder(cellAt(y))) return true
    if (!solid(wallAt(y))) { why = 'стена кончилась'; return false }
    const b = bot.blockAt(cellAt(y)); if (!b || b.boundingBox !== 'empty') { why = `клетка занята: ${b?.name}`; return false }
    const item = bot.inventory.items().find(i => i.name === 'ladder'); if (!item) { why = 'лестницы кончились'; return false }
    const aim = pick.faceAim(bot, wallAt(y), dir)
    if (!aim) { why = 'грань стены не видна'; return false }
    if (bot.heldItem?.name !== 'ladder') await bot.equip(item, 'hand')
    await bot.lookAt(aim, true)
    try { await bot.placeBlock(bot.blockAt(wallAt(y)), dir) } catch (e: any) { why = 'placeBlock: ' + String(e?.message || e).slice(0, 80) }
    await bot.waitForTicks(2)
    if (isLadder(cellAt(y))) { placed++; return true }
    why ||= 'сервер не поставил'
    return false
  }
  const lookWall = y => bot.lookAt(wallAt(y).offset(0.5, 0.5, 0.5).minus(dir.scaled(0.45)), true)
  try {
    const y0 = wall.y
    // 1. Первая ступень — у ног: стоя за лестницей (клетка в 2 бл. от стены).
    if (!isLadder(cellAt(y0)) && !(await put(y0))) return { ok: false, placed, why: 'первая ступень: ' + why }
    // 2. Войти в клетку лестницы.
    for (let t = 0; t < 30 && bot.entity.position.distanceTo(cellAt(y0).offset(0.5, 0, 0.5)) > 0.45; t++) {
      if (ctl?.aborted) return { ok: false, placed, why: 'прервано' }
      await lookWall(y0 + 1); bot.setControlState('forward', true); await bot.waitForTicks(1)
    }
    clear()
    // 3. Лезть: над головой нет ступени — поставить (стена кончилась — дальше вверх на неё), вперёд в стену и прыжок.
    while (Date.now() < deadline && !ctl?.aborted) {
      const feet = Math.floor(bot.entity.position.y + 0.05)
      if (feet > top) break
      const next = feet + 1
      if (next <= top && !isLadder(cellAt(next)) && solid(wallAt(next))) { clear(); if (!(await put(next))) return { ok: false, placed, why: `ступень на ${next}: ${why}`, at: bot.entity.position.floored() } }
      await lookWall(Math.min(next, top))
      bot.setControlState('forward', true); bot.setControlState('jump', true)
      const was = bot.entity.position.y
      for (let t = 0; t < 20 && bot.entity.position.y < was + 0.9; t++) await bot.waitForTicks(1)
      if (bot.entity.position.y < was + 0.3) { clear(); return { ok: false, placed, why: 'не лезу — нет ступени или упёрся', at: bot.entity.position.floored() } }
    }
    // 4. На верх стены: вперёд, пока не встал на неё, — и стоп над серединой блока (дальше — свалиться с той стороны).
    const mid = wallAt(top).offset(0.5, 0, 0.5)
    for (let t = 0; t < 30; t++) {
      const p = bot.entity.position
      if (p.y >= top + 0.9 && Math.abs((p.x - mid.x) * dir.x + (p.z - mid.z) * dir.z) < 0.25) break
      await lookWall(top); bot.setControlState('forward', true); bot.setControlState('jump', p.y < top + 0.9); await bot.waitForTicks(1)
    }
    clear()
    const at = bot.entity.position.floored()
    // Готова — когда стоит вся колонна (по ней полезут другие), а не только когда сам наверху.
    const complete = Array.from({ length: top - wall.y + 1 }, (_, k) => isLadder(cellAt(wall.y + k))).every(Boolean)
    return { ok: complete && at.y >= top + 1, complete, placed, at: { x: at.x, y: at.y, z: at.z }, why: !complete ? 'лестница не достроена' : at.y < top + 1 ? 'не вышел наверх' : null }
  } finally { clear() }
}

export { ladderUp }
