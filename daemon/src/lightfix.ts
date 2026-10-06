'use strict'
// Свет в чанках читается со сдвигом (найдено при проверке Колизея 2026-09-26:
// свет, который видел бот, совпал с расчётом и с сервером, только если
// переставить столбцы x). prismarine-chunk 1.41 (pc/1.18 ChunkColumn.
// loadParsedLight) кладёт 2048 байт света из пакета в BitArray.readBuffer —
// тот читает их как 64-битные числа старшим байтом вперёд, а свет в пакете —
// просто полубайты подряд (DataLayer: индекс i — байт i/2, младший полубайт
// для чётного). Порядок байтов в каждом восьмибайтовом слове переворачивается,
// и значение для x (младшие 4 бита индекса (y << 8 | z << 4 | x)) лежит на
// месте x' = 14 − 2·⌊x/2⌋ + x mod 2: пары столбцов в обратном порядке.
// Так бот считал, что стоит под небом (skyLight у головы), по соседнему
// столбцу в 1–15 блоках — у стены, у пещеры, под навесом.
//
// Чиним чтение: getSkyLight/getBlockLight того класса столбца, который создаёт
// мир бота, смотрят в переставленный x. Запись (пакеты света) идёт тем же
// путём, так что всё согласовано. Проверка: daemon/try-light.js.
//   ND_LIGHT_FIX=0 — без поправки.
const flipX = (x) => { const l = x & 15; return x - l + (14 - 2 * (l >> 1) + (l & 1)) }

function patch (proto) {
  if (!proto || proto._ndLightFix) return false
  const sky = proto.getSkyLight
  const blk = proto.getBlockLight
  if (typeof sky !== 'function' || typeof blk !== 'function') return false
  proto._ndLightFix = true
  proto.getSkyLight = function (pos) { return sky.call(this, { x: flipX(pos.x), y: pos.y, z: pos.z }) }
  proto.getBlockLight = function (pos) { return blk.call(this, { x: flipX(pos.x), y: pos.y, z: pos.z }) }
  return true
}

function install (bot) {
  if (!bot || bot._ndLightFixHook || process.env.ND_LIGHT_FIX === '0') return
  bot._ndLightFixHook = true
  const tryCol = (pos) => {
    try {
      const col = bot.world.getColumnAt(pos)
      if (!col) return false
      // Класс столбца (версия 1.18+ — чтение через BitArray.readBuffer); у
      // старых версий этого пути нет — не трогаем.
      if (!col.skyLightSections) return true
      patch(Object.getPrototypeOf(col))
      return true
    } catch { return false }
  }
  const onLoad = (pos) => {
    if (tryCol(pos)) bot.removeListener('chunkColumnLoad', onLoad)
  }
  // Событие тела (mineflayer blocks.js пересылает его из мира) — первый же
  // загруженный столбец даёт класс.
  bot.on('chunkColumnLoad', onLoad)
}

module.exports = { install, flipX, patch }
