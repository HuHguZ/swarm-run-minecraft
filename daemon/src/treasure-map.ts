'use strict'
// Карта сокровищ — честно, как у человека с картой в рюкзаке (пользователь 14.10). Сундук map_chest корабля даёт её всегда
// (loot_table/chests/shipwreck_map.json: пул 1 — exploration_map, red_x, zoom 1), карты бывают и в подводных руинах.
// Читается то, что видит держащий карту: пакет карты (ClientboundMapItemDataPacket → mineflayer 'map') — крестик и метка
// игрока в байтах карты; свою точку бот знает по F3. Координаты крестика из компонента предмета (map_decorations) не берём —
// их человек не видит.
//
// Механика 1.21.11 (MapItemSavedData):
//   createFresh: центр карты масштаба s — floor((x + 64) / 128·2^s)·128·2^s + 64·2^s − 64 (сетка; для s = 1 — 256k + 64);
//   addDecoration: f = (мир − центр) / 2^s; clampMapCoordinate: байт = (int)(f·2 + 0.5), за ±63 — край (−128 / 127);
//   tickCarriedBy: метка PLAYER — пока карта в инвентаре (любой слот), вне карты — PLAYER_OFF_MAP/OFF_LIMITS на краю.
// Центр — из своей точки и метки игрока (ошибка ≤ 2^s/2 блока, а центры стоят через 128·2^s — центр точный); крестик —
// центр + байт·2^(s−1) (±1 на округлении), затем привязка к клетке 9 чанка: клад ставится в locate_offset [9, 0, 9]
// (worldgen/structure_set/buried_treasures.json) — ExplorationMapFunction кладёт крестик в точку поиска постройки.
import * as gameClock from './game-clock'

const T = { player: 0, red_x: 26, off_map: 6, off_limits: 7 }

function install (bot) {
  if (!bot || bot._ndMaps) return bot && bot._ndMaps
  const maps = new Map()
  bot._ndMaps = maps
  if (bot._client && typeof bot._client.on === 'function') {
    bot._client.on('map', p => {
      const prev = maps.get(p.itemDamage) || {}
      // Метка игрока — на миг пакета: своё место берётся то же (иначе после шагов старый байт даёт чужой центр).
      const me = p.icons && bot.entity ? { x: bot.entity.position.x, z: bot.entity.position.z } : prev.me
      maps.set(p.itemDamage, { scale: p.scale ?? prev.scale ?? 1, icons: p.icons ?? prev.icons ?? null, me, t: gameClock.now() })
    })
  }
  return maps
}

function mapIdOf (item) {
  try { const c = item && item.componentMap && item.componentMap.get('map_id'); return c ? Number(c.data) : null } catch { return null }
}

// Байты карты → мировые координаты крестика. me — {x, z} тела. { x, z } (клетка сундука), или { toward, why } вне карты.
// Чтение карты: x, z — клад; toward — к краю карты, пока я вне её; why — почему не прочитать.
interface MapRead { x?: number; z?: number; toward?: { x: number; z: number }; why?: string; center?: { x: number; z: number }; scale?: number }
function decode (m, me): MapRead {
  if (!m || !m.icons) return { why: 'карта ещё не пришла' }
  const s = m.scale ?? 1
  const size = 128 * (1 << s)
  const off = 64 * (1 << s) - 64
  const unit = (1 << s) / 2
  const x = m.icons.find(i => i.type === T.red_x)
  if (!x) return { why: 'крестика на карте нет' }
  const p = m.icons.find(i => i.type === T.player)
  const edge = p || m.icons.find(i => i.type === T.off_map || i.type === T.off_limits)
  if (!edge) return { why: 'своей метки на карте нет' }
  // По оси, где метка не на краю, центр точен; на краю (−128/127) — ближняя ячейка сетки по ту сторону края.
  const axis = (b, mine, mark) => {
    const clamped = !p && (b <= -127 || b >= 127)
    let c
    if (!clamped) c = Math.round((mine - b * unit - off) / size) * size + off
    else c = b > 0 ? Math.floor((mine - 126 * unit - off) / size) * size + off : Math.ceil((mine + 126 * unit - off) / size) * size + off
    const est = c + mark * unit
    return { c, est, clamped }
  }
  const ax = axis(edge.x, me.x, x.x)
  const az = axis(edge.z, me.z, x.z)
  const snap = v => Math.floor((v - 9 + 8) / 16) * 16 + 9 // ближайшее значение ≡ 9 (mod 16)
  const at = { x: snap(ax.est), z: snap(az.est) }
  if (ax.clamped || az.clamped) return { toward: at, why: 'я вне карты — иду к её краю и читаю снова', center: { x: ax.c, z: az.c } }
  return { ...at, center: { x: ax.c, z: az.c }, scale: s }
}

// Карты в рюкзаке → клады: [{ id, x, z } | { id, toward } | { id, why }].
function read (bot) {
  install(bot)
  const out = []
  const me = bot.entity && bot.entity.position
  if (!me) return out
  for (const it of bot.inventory.items()) {
    if (it.name !== 'filled_map') continue
    const id = mapIdOf(it)
    if (id === null) { out.push({ id, why: 'номер карты неизвестен' }); continue }
    const m = bot._ndMaps.get(id)
    const decoded = decode(m, (m && m.me) || me)
    out.push({ id, ...(decoded.toward ? decode(m, me) : decoded) })
  }
  return out
}

export { install, read, decode, mapIdOf, T }
