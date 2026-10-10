'use strict'
const gameClock = require('./game-clock')
const fastblocks = require('./fastblocks')
// В каком мире тело и какому миру принадлежит запись памяти. Одно определение
// на весь демон (NETHER.md срез 1 и 2).
//
// Зачем. До перехода через портал память мест мира не знала: places, смерти и
// руда писались {x,y,z}, и всё, что читало их, шло к числам. В Аду x/z сжаты в
// восемь раз (dimension_type the_nether: coordinate_scale 8), так что «база на
// 300,64,-120» в Аду — это чужая точка у лавы, а не дом.
//
// Правило для записей: нет поля dimension — верхний мир. Это честно, а не
// удобно: до этой правки ни один писатель демона не бывал за порталом
// (nether.js WHY_NOT_THROUGH стоял на входе в каждую раму).
//
// Трекер. Свидетель — пакет respawn: mineflayer пишет по нему
// bot.game.dimension (game.js handleRespawnPacketData) и выгружает все колонки
// (blocks.js switchWorld). Снимок «откуда и стоял ли в портале» снимается ДО
// них (prependListener): после — колонок нет и позиция ещё старая. Событие
// уходит не на respawn, а на «устроился»: пришёл пакет позиции (physics.js
// эмитит forcedMove), тело живо, блок под ногами прочитан. Позиция и пол на
// самом respawn принадлежат прошлому миру.
//
// Сущности. mineflayer чистит bot.entities только на login (entities.js), а
// при смене мира моб старого мира остаётся в списке со своими координатами —
// бой и зрение видели бы призраков, стоящих «рядом» в чужом мире. Чистим в
// том же обработчике respawn, до пакетов о новых сущностях: сервер шлёт их
// после respawn, и они обрабатываются по очереди.

const WORLD_NAMES = { overworld: 'верхний мир', the_nether: 'Ад', the_end: 'Край' }
const IN_WORLD = { overworld: 'в верхнем мире', the_nether: 'в Аду', the_end: 'в Крае' }
const OF_WORLD = { overworld: 'верхнего мира', the_nether: 'Ада', the_end: 'Края' }
// Ключ портала в памяти по миру. Верхний мир — прежнее имя «портал»: форму этой
// записи читают mc_recall, try-portal.js и мозг, который уже знает это слово.
const PORTAL_KEYS = { overworld: 'портал', the_nether: 'портал (ад)', the_end: 'портал (край)' }

// minecraft-data 1.21.11 dimension_type: coordinate_scale у the_nether 8, у
// остальных 1. Живой registry_data mineflayer не хранит (prismarine-registry
// берёт от dimension_type только name/minY/height), поэтому число — отсюда.
const SCALE = { overworld: 1, the_nether: 8, the_end: 1 }

const READY_MS = 15000

function worldOf (bot) {
  return (bot && bot.game && bot.game.dimension) || 'overworld'
}

function worldOfRecord (rec) {
  return (rec && rec.dimension) || 'overworld'
}

function sameWorld (bot, rec) {
  return worldOf(bot) === worldOfRecord(rec)
}

function worldName (dim) {
  return WORLD_NAMES[dim] || String(dim)
}

function inWorld (dim) {
  return IN_WORLD[dim] || `в мире ${dim}`
}

function ofWorld (dim) {
  return OF_WORLD[dim] || String(dim)
}

function portalKey (dim) {
  return PORTAL_KEYS[dim] || `портал (${dim})`
}

function scaleOf (dim) {
  return SCALE[dim] || 1
}

// Отказ идти или мерить до записи из другого мира — текст или null.
// what — как назвать запись для мозга: «база», «смерть №3», «nether_quartz_ore».
function refuseOtherWorld (bot, rec, what) {
  if (!rec) return null
  const here = worldOf(bot)
  const there = worldOfRecord(rec)
  if (here === there) return null
  const at = [rec.x, rec.y, rec.z].every(Number.isFinite) ? ` на ${rec.x},${rec.y},${rec.z}` : ''
  return `${what}${at} — это ${inWorld(there)}, а я ${inWorld(here)}: пешком туда не дойти, у миров разные ` +
    'координаты (в Аду x/z в 8 раз меньше). Только через портал: mc_portal mode=enter.'
}

// Порталы, огонь душ и портал в Край проходимы по форме блока (boundingBox
// 'empty' в minecraft-data 1.21.11), и pathfinder шагал бы сквозь них:
// Movements.safe — это «пусто и не в blocksToAvoid». Четыре секунды в портале
// Ада — смена мира, шаг в end_portal — Край. Входит в портал только mc_portal
// mode=enter, и последний шаг он делает клавишами, а не pathfinder'ом.
// Магма — пол, но жжёт стоящего (hot_floor): не запрещена, просто дороже.
// Постановка блока для pathfinder (столб «прыжок + блок под себя», мост). Пользователь 10.10: «прыгают на месте, блоки
// не ставятся». Две причины в mineflayer: (1) pathfinder шлёт постановку, едва ноги поднялись над полом клетки, а тело
// ещё в ней — сервер отказывает (своя рамка в клетке), блок не встаёт; (2) placeBlock ждёт события blockUpdate до 5 с,
// а 1.21.11 его шлёт не всегда — 5 с прыжков на месте и place_error. Здесь: дождаться, пока своя рамка выйдет из
// клетки (≤ 12 тиков прыжка), поставить и проверить блок опросом мира (≤ 10 тиков), без ожидания события.
function wrapPlaceBlock (bot) {
  if (bot._ndPlaceWrapped || typeof bot._genericPlace !== 'function') return
  bot._ndPlaceWrapped = true
  const inMe = (dest) => {
    const p = bot.entity.position
    return p.x + 0.3 > dest.x && p.x - 0.3 < dest.x + 1 && p.z + 0.3 > dest.z && p.z - 0.3 < dest.z + 1 && p.y < dest.y + 1 && p.y + 1.8 > dest.y
  }
  bot.placeBlock = async (ref, face) => {
    const dest = ref.position.plus(face)
    for (let t = 0; t < 12 && inMe(dest); t++) await bot.waitForTicks(1)
    if (inMe(dest)) throw new Error('своя рамка в клетке постановки')
    const old = bot.blockAt(dest)
    await bot._genericPlace(ref, face, { swingArm: 'right' })
    for (let t = 0; t < 10; t++) {
      const now = bot.blockAt(dest)
      if (now && old && now.type !== old.type) { bot.emit('blockPlaced', old, now); return }
      await bot.waitForTicks(1)
    }
    throw new Error(`No block has been placed : the block is still ${old?.name}`)
  }
}

function tuneMovements (bot, movements) {
  const reg = bot.registry
  const defAt = fastblocks.defReader(bot)
  wrapPlaceBlock(bot)
  // Жёсткий пол для разведки в Аду (bot._ndNetherFloor ставит fortress.scout):
  // ни один ход не кончается ниже него. Штраф 12 за клетку ниже y=40 (ниже)
  // разведку не держал: GoalNearXZ высоты не спрашивает, и дважды за день
  // обход регионов кончился в лавовом море — y=24 и y=22, «tried to swim in
  // lava» (2026-09-26, 14:38 и 18:07). Крепость стоит на 48..70 (NetherBridge),
  // бастион стартует с 33 — ниже пола искать нечего. Фильтр по клетке НАЗНАЧЕНИЯ
  // хода: спрыг на 4 вниз проверяет клетки старта, а приземление — нет.
  const neighbors = movements.getNeighbors
  if (typeof neighbors === 'function') {
    movements.getNeighbors = function (node) {
      const out = neighbors.call(this, node)
      if (worldOf(bot) !== 'the_nether') return out
      // Не только разведка: дорога к порталу тоже спускалась к морю — y=27,
      // «tried to swim in lava» (2026-09-26, 23:06). Всегда в Аду: не ниже
      // min(40, где стоишь) — снизу можно только подниматься.
      const floor = bot._ndNetherFloor || Math.min(40, Math.floor(bot.entity.position.y))
      return out.filter(m => m.y >= floor)
    }
  }
  // Верхний мир: вода дороже (S8b 07.10: в s8b-c 3 смерти из 9 — в воде: утопленник с трезубцем на 3.5 мин на пути через
  // реку, утопленник и страж ночью; плыть ещё и медленнее идти). Переплыть, где обхода нет, можно. ND_OW_LIQUID=0 — как было.
  if (worldOf(bot) === 'overworld' && process.env.ND_OW_LIQUID !== '0') movements.liquidCost = Math.max(movements.liquidCost ?? 1, 3)
  // Порошковый снег — тоже пусто по форме (minecraft-data: boundingBox 'empty'): pathfinder вёл сквозь него, тело вязло и
  // замерзало (s8-f1-11: «froze to death» на 8.9 мин по пути к воде в снежных горах).
  const avoid = ['nether_portal', 'end_portal', 'end_gateway', 'soul_fire', 'powder_snow']
  for (const name of avoid) {
    const b = reg.blocksByName[name]
    if (b && movements.blocksToAvoid) movements.blocksToAvoid.add(b.id)
  }
  // #guarded_by_piglins pathfinder не ломает никогда: сломанный по дороге
  // золотой блок, позолоченный чернокамень, бочка или золотая руда злят ВСЕХ
  // взрослых пиглинов вокруг без взгляда (Block.playerWillDestroy →
  // PiglinAi.angerNearbyPiglins(…, false); исходники 1.21.11, 2026-09-28).
  // Такие блоки ломает только тот, кто проверил пиглинов (bastion.js).
  if (movements.blocksCantBreak) {
    for (const b of ((Object.values(reg.blocksByName) as any[]) as any)) {
      if (b && /^(gold_block|gilded_blackstone|chest|trapped_chest|barrel|ender_chest|raw_gold_block|gold_ore|deepslate_gold_ore|nether_gold_ore|[a-z_]*shulker_box|[a-z_]*copper_chest)$/.test(b.name)) movements.blocksCantBreak.add(b.id)
    }
  }
  const magma = reg.blocksByName.magma_block
  if (magma && Array.isArray(movements.exclusionAreasStep)) {
    movements.exclusionAreasStep.push(block => {
      try {
        // Номер состояния, не Block (fastblocks.defReader, S9): у описания реестра id — то же, что Block.type.
        const p = block.position
        const under = defAt(p.x, p.y - 1, p.z)
        return under && (under.type ?? under.id) === magma.id ? 20 : 0
      } catch { return 0 }
    })
  }
  // Подмости pathfinder'а по умолчанию — dirt и cobblestone; в Аду булыжник
  // кончился за первые полчаса (прогон 6: 64 штуки на мосты), а в рюкзаке
  // лежало 110 netherrack, накопанных по дороге.
  const rack = reg.itemsByName.netherrack
  if (rack && Array.isArray(movements.scafoldingBlocks) && !movements.scafoldingBlocks.includes(rack.id)) {
    movements.scafoldingBlocks.push(rack.id)
  }
  // В Аду булыжник — не на подмости: это запасные кирки (3 булыжника + 2
  // палки), а незерак стирает их десятками. Кампания 2026-09-28 (16:20–16:25):
  // вошла с 85 булыжника и двумя кирками, через 5 минут дороги к крепости — 2
  // булыжника, 626 незерака и ни одной кирки. Pathfinder берёт первый подходящий
  // предмет рюкзака, поэтому булыжник из списка убирается совсем.
  if (worldOf(bot) === 'the_nether' && Array.isArray(movements.scafoldingBlocks)) {
    const keep = new Set(['netherrack', 'dirt', 'basalt', 'soul_soil', 'nether_bricks'].map(n => reg.itemsByName[n] && reg.itemsByName[n].id).filter(Boolean))
    movements.scafoldingBlocks = movements.scafoldingBlocks.filter(id => keep.has(id))
    for (const id of keep) if (!movements.scafoldingBlocks.includes(id)) movements.scafoldingBlocks.push(id)
  }
  // В Аду — не спускаться к лавовому морю (y 31): GoalNearXZ высоты не
  // спрашивает, и pathfinder, не найдя дороги на y=84, прокопал вниз до y=27 —
  // на берег лавы, где тело и сгорело (прогон 5, 2026-09-25). Крепость стоит на
  // y 48..70, ниже 40 там делать нечего. 12 за клетку — не запрет: при 60
  // тело, уже стоявшее внизу на y=34, не находило за 5 с поиска подъёма на
  // мост крепости (каждая клетка снизу стоила как 60 шагов — прогон 10).
  if (Array.isArray(movements.exclusionAreasStep)) {
    movements.exclusionAreasStep.push(block => {
      try { return worldOf(bot) === 'the_nether' && block.position.y < 40 ? 12 : 0 } catch { return 0 }
    })
  }
  // В Аду — не прыгать паркуром над пропастью: прыжок с y=64 через щель
  // кончился на y=28 в лаве (прогон 13, «tried to swim in lava»). exclusionStep
  // паркур спрашивает только про клетку приземления, поэтому сам ход
  // (Movements.getMoveParkourForward) пропускается, если под щелью 5 клеток
  // пустоты или лавы. Паркур над твёрдым дном остаётся.
  const parkour = movements.getMoveParkourForward
  if (typeof parkour === 'function') {
    movements.getMoveParkourForward = function (node, dir, neighbors) {
      try {
        if (worldOf(bot) === 'the_nether') {
          let deep = true
          for (let d = 1; d <= 5; d++) {
            if (this.getBlock(node, dir.x, -d, dir.z).physical) { deep = false; break }
          }
          if (deep) return
        }
      } catch {}
      return parkour.call(this, node, dir, neighbors)
    }
  }
  // В Аду — без столба 1x1 (прыжок + блок под себя): pathfinder ставит блок
  // через bot.placeBlock, а тот на 1.21.11 ждёт обновления блока, которого
  // сервер не всегда шлёт (build.js withTimeout) — «place_error» раз за разом,
  // и тело с y=57 упало на y=41 насмерть (прогон 14, «fell from a high
  // place»). Подъём в Аду — ступеньками штрека (nether.js bore, maxY), где блок
  // ставит наш placeBlockAt.
  const up = movements.getMoveUp
  if (typeof up === 'function') {
    movements.getMoveUp = function (node, neighbors) {
      try {
        if (worldOf(bot) === 'the_nether' && !this.getBlock(node, 0, 0, 0).climbable) return
      } catch {}
      return up.call(this, node, neighbors)
    }
  }
  // В Аду — не мостить над пропастью: блок, под которым 3+ клетки пустоты.
  // Постановка сорвалась (place_error) — и тело, уже шагнувшее к краю, упало
  // с y=83 в лавовое море на y=31 (try-nether-trip 2026-09-25, смерть).
  // Цена 1000, а не запрет: без другой дороги pathfinder всё же построит мост.
  if (Array.isArray(movements.exclusionAreasPlace)) {
    movements.exclusionAreasPlace.push(block => {
      try {
        if (worldOf(bot) !== 'the_nether') return 0
        const p = block.position
        for (let d = 1; d <= 3; d++) {
          const b = defAt(p.x, p.y - d, p.z)
          if (!b || b.boundingBox === 'block') return 0
        }
        return 1000
      } catch { return 0 }
    })
  }
}

function snapshot (bot) {
  const pos = bot.entity ? bot.entity.position.clone() : null
  let portal = null
  try {
    for (const dy of [0, 1, 0.5]) {
      const b = pos && bot.blockAt(pos.offset(0, dy, 0))
      if (b && /^(nether_portal|end_portal|end_gateway)$/.test(b.name)) { portal = b.name; break }
    }
  } catch {}
  return { from: worldOf(bot), pos, portal, t0: gameClock.wall.now() }
}

function purgeEntities (bot) {
  let n = 0
  for (const id of Object.keys(bot.entities)) {
    const e = bot.entities[id]
    if (!e || e === bot.entity) continue
    e.isValid = false
    try { bot.emit('entityGone', e) } catch {}
    delete bot.entities[id]
    n++
  }
  for (const p of ((Object.values(bot.players || {}) as any[]) as any)) {
    if (p && p.username !== bot.username) p.entity = null
  }
  return n
}

// Ставится один раз на бота (session.wire). session.worldChange — последнее
// наблюдённое «сменился мир»: {seq, from, to, via, ready, at, pos, standingOn}.
// Портал ждёт именно его (nether.js enter): одно определение «устроился» на
// весь демон.
function installWorldTracker (session, bot) {
  let snap = null
  let deathAt = 0
  // Session survives reconnects; enter compares against the previous sequence.
  let seq = session.worldChange?.seq || 0
  let watch = null

  bot.on('death', () => { deathAt = gameClock.now() })
  bot._client.prependListener('respawn', () => { snap = session.bot === bot ? snapshot(bot) : null })
  bot._client.on('respawn', () => {
    const s = snap
    snap = null
    if (!s || session.bot !== bot) return
    const to = worldOf(bot)
    if (to === s.from) return
    const purged = purgeEntities(bot)
    const via = s.portal ? 'portal' : (gameClock.now() - deathAt < 60000 ? 'death' : 'teleport')
    if (watch) gameClock.clearInterval(watch.timer)
    const w: any = { seq: ++seq, from: s.from, to, via, portal: s.portal, purged, t0: s.t0, moved: false, fromPos: s.pos }
    session.worldChange = { seq: w.seq, from: w.from, to, via, ready: false, at: gameClock.now() }
    w.timer = gameClock.wall.setInterval(() => settle(w), 100)
    watch = w
  })
  bot.on('forcedMove', () => { if (watch) watch.moved = true })
  bot.on('end', () => { if (watch) gameClock.clearInterval(watch.timer); watch = null })

  function settle (w) {
    if (!session.bot || session.bot !== bot) { gameClock.clearInterval(w.timer); return }
    let under = null
    try { under = bot.entity && bot.blockAt(bot.entity.position.offset(0, -1, 0)) } catch {}
    const ready = w.moved && bot.isAlive !== false && (bot.health ?? 0) > 0 && !!under
    const late = gameClock.wall.now() - w.t0 > READY_MS
    if (!ready && !late) return
    gameClock.clearInterval(w.timer)
    if (watch === w) watch = null
    const pos = bot.entity ? bot.entity.position.floored() : null
    const standingOn = under ? under.name : null
    const ms = gameClock.wall.now() - w.t0
    session.worldChange = {
      seq: w.seq, from: w.from, to: w.to, via: w.via, ready, at: gameClock.now(),
      pos: pos ? { x: pos.x, y: pos.y, z: pos.z } : null, standingOn, ms
    }
    try { session.updateMovements(true) } catch {}
    const how = { portal: 'через портал', death: 'после смерти', teleport: 'телепортом' }[w.via] || w.via
    const place = pos ? `стою на ${pos.x},${pos.y},${pos.z}${standingOn ? ` на ${standingOn}` : ''}` : 'где стою — не знаю'
    const warn = scaleOf(w.to) !== scaleOf(w.from)
      ? ` Координаты из памяти про ${worldName(w.from)} здесь не годятся: x/z ${w.to === 'the_nether' ? 'в Аду в 8 раз меньше' : 'здесь в 8 раз больше'}.`
      : ''
    const text = ready
      ? `СМЕНИЛСЯ МИР: ${worldName(w.from)} → ${worldName(w.to)} (${how}), ${place}.${warn}`
      : `СМЕНИЛСЯ МИР: ${worldName(w.from)} → ${worldName(w.to)} (${how}), но за ${Math.round(READY_MS / 1000)}с не устроился: ` +
        `${w.moved ? '' : 'позиции от сервера нет, '}${under ? '' : 'мир под ногами не прогружен'}.`
    session.bus.emit('dimension', {
      from: w.from, to: w.to, via: w.via, ready, pos: session.worldChange.pos, standingOn, ms, purged: w.purged, text
    })
    try { session.journal.append('мир', text, bot.entity && bot.entity.position) } catch {}
  }
}

module.exports = {
  worldOf,
  worldOfRecord,
  sameWorld,
  worldName,
  inWorld,
  ofWorld,
  portalKey,
  scaleOf,
  refuseOtherWorld,
  tuneMovements,
  installWorldTracker,
  purgeEntities,
  PORTAL_KEYS,
  WORLD_NAMES
}
