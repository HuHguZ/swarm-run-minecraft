'use strict'
import * as gameClock from '../game-clock'
import { goals } from 'mineflayer-pathfinder'
import { sleep, dimOf, flat, v3, keyOf } from './common'
import { KINDS, TEMPLATE_KINDS } from './kinds'
import { listOf, remember, patchRec, whereNext, lootedSet, readTreasureMaps } from './memory'
import { scan } from './scan'
import { walk, containersNear } from './site'
import { headWet, breathe, underwater, swimming, swimTo, withAir } from './water'
import { templatesOn, templateFit, pickTarget } from './templates'
import { digDown, ladderUp } from './dig'
import { takeOnce, lootAll } from './take'
import { HANDLERS, extras } from './handlers'

// Клад: место — по карте сокровищ в рюкзаке (крестик и своя метка, treasure-map; главная метрика — только так). Точка
// снаружи (поток route в строке «известный сид»: seedtool, клад на (чанк·16 + 9, чанк·16 + 9)) — без карты, не в главной.
// BuriedTreasurePieces 1.21.11: от OCEAN_FLOOR_WG вниз до первой клетки, под которой песчаник/камень/андезит/гранит/
// диорит, — там сундук (песок над ним). Копаю свой столбец сверху, только видимые блоки (bot.dig по верхней грани
// стоя на столбце), пока под ногами не сундук; под водой глубже 2 — не лезу.
async function treasureDig (session, ctl, p) {
  const bot = session.bot
  // По карте сокровищ: вне карты место примерное — дойти к нему и прочитать карту снова (метка игрока станет на карту).
  let byMap = false
  let exact = false
  let mapId = null
  for (let k = 0; k < 4 && !ctl.aborted; k++) {
    // Карта одна на поход (их бывает две — ревью Codex q2).
    const m = readTreasureMaps(session).find(q => mapId !== null ? q.id === mapId : Math.hypot(q.x - p.x, q.z - p.z) < 600)
    if (!m) break
    byMap = true
    mapId = m.id
    exact = !m.rough
    p = { ...p, x: m.x, z: m.z }
    const d = Math.hypot(m.x - bot.entity.position.x, m.z - bot.entity.position.z)
    if (!m.rough && d < 24) break
    try { await walk(session, ctl, new goals.GoalNearXZ(m.x, m.z, m.rough ? 8 : 3), Math.min(240000, 30000 + d * 900)) } catch {}
    if (!m.rough) break
  }
  const out: any = { lines: [], took: {}, chests: [], structure: { kind: 'buried_treasure', name: 'клад', at: { x: p.x, z: p.z } } }
  // Примерное место (я вне карты) — не клетка клада: не копать, пока карта не прочитана точно.
  if (ctl.aborted || (byMap && !exact)) { out.stopped = ctl.aborted ? 'прервано' : 'карта ещё не уточнена — не копаю примерную клетку'; return out }
  const x = Math.floor(p.x); const z = Math.floor(p.z)
  const me0 = bot.entity.position
  if (!byMap && Math.hypot(me0.x - (x + 0.5), me0.z - (z + 0.5)) > (p.maxDistance ?? 96)) { out.stopped = `до клада ${Math.round(Math.hypot(me0.x - x, me0.z - z))} бл. — сначала дойти`; return out }
  try { await walk(session, ctl, new goals.GoalXZ(x, z), 40000) } catch (e) { out.lines.push(`⚠ дорога: ${e.message}`) }
  const feet0 = bot.entity.position.floored()
  if (feet0.x !== x || feet0.z !== z) { out.stopped = `не встал на столбец клада ${x},${z}`; return out }
  if (headWet(bot)) { out.stopped = 'клад под водой — не копаю'; return out }
  // Клад — ровно в клетке (9, 9) чанка (locate_offset buried_treasures), сундук под песком над песчаником/камнем:
  // копать свой столбец сверху, только блок под ногами (виден).
  const dd = await digDown(session, ctl, { maxDepth: 16 })
  const chest = dd.chest
  if (!chest) { out.stopped = dd.stopped || 'сундука клада не нашёл в столбце'; return out }
  out.lines.push(`▸ клад: сундук на ${chest.x},${chest.y},${chest.z}`)
  try {
    const r = await takeOnce(session, ctl, chest, { kind: 'buried_treasure' })
    out.chests.push(r)
    for (const [k, v] of (Object.entries(r.took || {}) as [string, any][])) out.took[k] = (out.took[k] || 0) + v
    if (r.stopped) out.lines.push(`⚠ ${r.stopped}`)
  } catch (e) { out.stopped = `сундук клада: ${e.message}` }
  const tookText = (Object.entries(out.took) as [string, any][]).map(([k, v]) => `${k}×${v}`)
  if (tookText.length) out.lines.push(`▸ взял: ${tookText.join(', ')}`)
  // Взят — только открытый сундук; запись клада в памяти — взята (ревью Codex q2: done ставился и при ошибке открытия).
  out.done = !out.stopped && out.chests.length > 0
  if (out.done) {
    const r0 = listOf(session).find(r => r.kind === 'buried_treasure' && (mapId !== null ? r.map === mapId : Math.hypot(r.x - x, r.z - z) < 3))
    if (r0) patchRec(session, r0, r => { r.done = true })
  }
  return out
}

// Зайти в постройку: дойти, обезвредить, забрать ценное. p: kind, x/y/z,
// loot (true), force, tnt, beds, gold, food, maxDistance, chestsOnly.
async function explore (session, ctl, p: any = {}) {
  const bot = session.bot
  if (p.kind === 'buried_treasure' && Number.isFinite(p.x) && Number.isFinite(p.z)) return treasureDig(session, ctl, p)
  const out: any = { lines: [], disarmed: [], fought: [], chests: [], took: {}, why: {}, left: {}, skipped: [] }
  // Сначала оглядеться: может, видно что-то новое.
  const look0 = scan(session, { radius: 48 })
  let rec = pickTarget(session, p)
  // Место из карты копии этого же мира (поток route: seedtool знает деревню, руины, корабль; AGENTS.md — разрешено):
  // глазами с подхода постройку не узнал (дома заслоняют колокол и грядки — rt-S1 03.10, слот 27: «деревня не знаю
  // рядом» в 24 бл. от её места) — запись по карте, дальше как с увиденной: обработчик, сундуки в её радиусе.
  if (!rec && p.fromMap && p.kind && KINDS[p.kind] && Number.isFinite(p.x) && Number.isFinite(p.z)) {
    const me0 = bot.entity.position
    rec = remember(session, { kind: p.kind, at: { x: Math.round(p.x), y: Math.round(Number.isFinite(p.y) ? p.y : me0.y), z: Math.round(p.z) }, evidence: ['карта копии мира'] }, dimOf(bot)).rec
  }
  if (!rec) {
    const hint: any = p.kind ? whereNext(session, p.kind) : null
    return {
      stopped: p.kind ? `${(KINDS[p.kind] || {}).ru || p.kind} не знаю рядом` : 'ни одной невзятой постройки в памяти этого мира',
      seen: look0.found.map(d => `${d.name} ${d.dist} бл.`),
      where: hint ? hint.text : undefined,
      lines: [`▸ ${hint ? hint.text : 'осмотрись (mc_structure mode=scan) или иди разведкой (mc_explore)'}`]
    }
  }
  const K = KINDS[rec.kind]
  const me = bot.entity.position
  const dist = Math.round(flat(me, rec))
  out.structure = { kind: rec.kind, name: K.ru, at: { x: rec.x, y: rec.y, z: rec.z }, dist }
  out.lines.push(`▸ ${K.ru} на ${rec.x},${rec.y},${rec.z} (${dist} бл.): ${K.value}`)
  if (K.handler === 'avoid' && !p.force) {
    out.stopped = `${K.ru}: ${K.danger} — не лезу без force`
    return out
  }
  if (dist > (p.maxDistance ?? 128)) {
    out.stopped = `до ${K.ru} ${dist} блоков — сначала mc_goto ${rec.x} ${rec.z} (или maxDistance)`
    return out
  }
  out.lines.push(`▸ опасность: ${K.danger}`)
  // Дойти до постройки (близко к центру; дальше обработчик).
  if (dist > 10 && !(swimming(bot) || underwater(bot, rec))) {
    try { await walk(session, ctl, new goals.GoalNear(rec.x, rec.y, rec.z, Math.min(8, K.r)), Math.min(120000, 20000 + dist * 700)) } catch (e) {
      out.lines.push(`⚠ дорога: ${e.message}`)
    }
  } else if (Math.hypot(bot.entity.position.x - rec.x, bot.entity.position.z - rec.z) > 8 && (swimming(bot) || underwater(bot, rec))) {
    // Под водой видно на ~20 бл.: подплыть поверху к точке над постройкой — глазам в ~10 бл. от неё, узнать шаблон.
    // Под сторожем воздуха: swimTo у цели ныряет отвесно.
    await withAir(session, ctl, sub => swimTo(session, sub, { x: rec.x, y: Math.max((rec.y ?? 50) + 8, 60), z: rec.z }, { reach: 4, ms: Math.min(60000, 15000 + dist * 600) }), 1)
  }
  if (ctl.aborted) return out
  // Глазами ещё раз — уточнить центр и улики.
  scan(session, { radius: 48 })
  rec = pickTarget(session, { ...p, kind: rec.kind, x: rec.x, y: rec.y, z: rec.z, again: true }) || rec
  // Рабочая копия: обработчики пишут в неё (плита, центр камеры, заметка),
  // а не в память; запись в памяти ищется по исходной.
  const orig = rec
  // Шаблон — до обработчика: где сундуки, плита храма, люк иглу, дома деревни. Под водой глубоко (корабль на 20 бл. ниже
  // поверхности — ферма 14.10, 642,42,-597: с поверхности «не узнан») — нырнуть к постройке и узнавать там.
  let tf = null
  const wetKind = rec.kind === 'shipwreck' || rec.kind === 'ocean_ruin'
  if (wetKind && templatesOn() && (swimming(bot) || underwater(bot, rec)) && bot.entity.position.offset(0, 1.62, 0).distanceTo(v3(rec).offset(0.5, 0.5, 0.5)) > 14) {
    await withAir(session, ctl, async sub => {
      await swimTo(session, sub, { x: rec.x, y: (rec.y ?? 50) + 6, z: rec.z }, { reach: 3, ms: 20000 })
      tf = templateFit(session, orig, out)
    }, 1)
  }
  rec = { ...rec, tf: K.handler === 'avoid' && !p.force ? null : (tf || templateFit(session, orig, out)) }
  // Не узнан с места подхода (вплотную к стене иглу видно 9 блоков — ферма 14.10, иглу 164,-215) — обойти: до 4 точек
  // вокруг на расстоянии обзора, взглянуть на постройку и узнать снова (увиденное копится в памяти глаз).
  if (!rec.tf && !wetKind && templatesOn() && TEMPLATE_KINDS[rec.kind] && rec.kind !== 'village' && (K.handler !== 'avoid' || p.force)) {
    const ring = Math.max(9, Math.round(TEMPLATE_KINDS[rec.kind] / 2))
    const me0 = bot.entity.position
    const a0 = Math.atan2(me0.x - rec.x, me0.z - rec.z)
    for (let i = 0; i < 4 && !rec.tf && !ctl.aborted; i++) {
      const a = a0 + (i + 1) * Math.PI / 2
      try { await walk(session, ctl, new goals.GoalNear(Math.round(rec.x + Math.sin(a) * ring), Number.isFinite(rec.y) ? rec.y : Math.floor(me0.y), Math.round(rec.z + Math.cos(a) * ring), 2), 15000) } catch {}
      try { await bot.lookAt(v3(rec).offset(0.5, 1, 0.5), true) } catch {}
      await sleep(300)
      const t = templateFit(session, orig, null)
      if (t) { rec = { ...rec, tf: t }; out.lines.push(`▸ шаблон: ${t.name} (сундуков по шаблону ${t.chests.length}) — узнан с обхода, точка ${i + 1}`) }
    }
  }
  const hp = bot.health ?? 20
  if (hp < 10 && !p.force) { out.stopped = `${Math.round(hp)} хп — сначала поесть/отлечиться`; return out }
  await HANDLERS[K.handler](session, ctl, rec, out, p)
  if (!out.abort && !ctl.aborted && p.loot !== false) await lootAll(session, ctl, rec, out, p)
  if (!out.abort && !ctl.aborted && !rec.stay && !p.chestsOnly) await extras(session, ctl, rec, out, p)
  // Подвал иглу — наверх по лестнице.
  if (rec.ladderUp && !ctl.aborted && bot.entity.position.y < rec.ladderUp.y) out.lines.push(await ladderUp(session, ctl, rec.ladderUp) ? '▸ из подвала иглу поднялся' : '⚠ из подвала иглу по лестнице не поднялся')
  // Под водой работу не бросаем: сначала всплыть (автопилот в открытом море
  // берег ищет pathfinder'ом и не находит — бот тонул на месте).
  if (headWet(bot)) await breathe(bot, ctl, 20000, session)
  // Карта сокровищ из сундука корабля или руин — прочитать (крестик и своя метка) и запомнить клад.
  if (out.took.filled_map || out.took.map) {
    await sleep(600)
    for (const m of readTreasureMaps(session)) out.lines.push(`▸ карта сокровищ: клад ${m.rough ? 'примерно ' : ''}на ${m.x},${m.z} (${Math.round(Math.hypot(m.x - bot.entity.position.x, m.z - bot.entity.position.z))} бл.)`)
  }
  // Итог: что взято и зачем.
  const tookText = (Object.entries(out.took) as [string, any][]).map(([k, v]) => `${k}×${v}`)
  if (tookText.length) out.lines.push(`▸ взял: ${tookText.join(', ')}`)
  const reasons = [...new Set((Object.values(out.why) as any[]))].slice(0, 5)
  if (reasons.length) out.lines.push(`▸ зачем: ${reasons.join('; ')}`)
  const left = (Object.entries(out.left) as [string, any][]).map(([k, v]) => `${k}×${v}`)
  if (left.length) out.lines.push(`▸ оставил: ${left.slice(0, 8).join(', ')} — не нужно для победы`)
  for (const d of out.disarmed) out.lines.push(`▸ ${d}`)
  for (const s of out.skipped) out.lines.push(`⚠ не тронул ${s.at.x},${s.at.y},${s.at.z}: ${s.why}`)
  const lootedNow = lootedSet(session)
  const leftPlanned = ((rec.tf && rec.tf.chests) || []).filter(c => Number.isFinite(c.y) && !lootedNow.has(keyOf(c)) && !lootedNow.has(`miss:${keyOf(c)}`)).length
  const leftChests = containersNear(session, rec, rec.lootR || K.lootR || K.r, rec.yR || K.yR || 16).filter(q => !lootedNow.has(keyOf(q))).length + leftPlanned
  // Постройка с шаблоном, а шаблон не узнан и сундуков не видно — не «взята»: узнается с другого места.
  const unknownTemplate = !!TEMPLATE_KINDS[rec.kind] && templatesOn() && !rec.tf && !out.chests.length
  const allDone = !out.abort && !ctl.aborted && !rec.stay && leftChests <= out.skipped.length && !unknownTemplate
  if (allDone) patchRec(session, orig, r => { r.done = true; if (rec.note) r.note = rec.note })
  else if (rec.note) patchRec(session, orig, r => { r.note = rec.note })
  out.done = allDone
  if (!tookText.length && !out.disarmed.length && !out.stopped) out.stopped = out.chests.length ? 'в сундуках ничего ценного' : 'сундуков не нашёл'
  const { abort, ...rest } = out
  return rest
}

// ------------------------------------------------------------------ фоном

// Раз в 8 с — честный осмотр; новая постройка — событие structure_seen.
function install (session) {
  if (session._structuresTimer && !session._structuresTimer.clock?.disposed) return
  session._structuresTimer = gameClock.setInterval(() => {
    try {
      const bot = session.bot
      if (!bot || !bot.entity) return
      ;(require('../treasure-map') as typeof import('../treasure-map')).install(bot) // пакеты карт — до того, как карта попадёт в рюкзак
      if (session.structuresAuto === false) return
      const r = scan(session, { radius: 32 })
      for (const d of r.fresh) {
        const K = KINDS[d.kind]
        session.bus.emit('structure_seen', { kind: d.kind, name: K.ru, at: d.at, dist: d.dist, evidence: d.evidence, value: K.value, danger: K.danger, avoid: K.handler === 'avoid' })
      }
      readTreasureMaps(session)
    } catch {}
  }, 8000)
  if (session._structuresTimer.unref) session._structuresTimer.unref()
}

// Забыть постройки (вид и/или место); looted — заодно и «взятые» сундуки в
// них (сцена перестроила постройку на том же месте).
function forget (session, { kind, x, z, looted = false }: any = {}) {
  let n = 0
  let chests = 0
  session.journal.patch(s => {
    const before = (s.structures || []).length
    const gone = (s.structures || []).filter(r => (!kind || r.kind === kind) && (typeof x !== 'number' || flat(r, { x, z }) < 24))
    s.structures = (s.structures || []).filter(r => !gone.includes(r))
    n = before - s.structures.length
    if (looted && Array.isArray(s.looted)) {
      const was = s.looted.length
      s.looted = s.looted.filter(k => {
        const m = /^(-?\d+),(-?\d+),(-?\d+)$/.exec(k)
        if (!m) return true
        const q = { x: +m[1], z: +m[3] }
        return !gone.some(r => flat(r, q) <= Math.max(24, (KINDS[r.kind] || {}).lootR || 0))
      })
      chests = was - s.looted.length
    }
  })
  return { forgot: n, chests }
}

export { explore, install, forget }
