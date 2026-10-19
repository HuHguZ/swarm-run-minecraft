'use strict'
// S1e 07.10: искажённый лес Ада — по видимости, как игрок (решение пользователя 09:19/09:24: без /locate biome и скана копии).
// Раз в несколько игровых секунд в Аду: кандидаты нилия в загруженных клиентом чанках → луч глаз (sight.seesBlock, как
// fortress.look) — видимые блоки сине-бирюзового нилия; плюс «биом под ногами» (экран F3). Лучшее увиденное место (больше всего
// видимого нилия) — в память «искажённый лес (ад)», где его ищет этап эндерменов кампании. Запись по карте копии не трогаем.
import * as gameClock from './game-clock'
import { seesBlock } from './sight'
import { biomeName, canSeePoint } from './perception'

const PLACE = 'искажённый лес (ад)'
// Стебли багрового/искажённого леса — дерево Ада на палки и верстак (nether-supply идёт к ним, если рядом не видно).
const WOOD_PLACE = 'стебли (ад)'
// Откуда видно больше всего эндерменов разом (место тела) — туда охота: окоп отдаёт столько, сколько их видно с места (s1e-L2b:
// seen 17 → 4 жемчуга за вызов, seen 0–1 в том же лесу → 0–1).
const EM_PLACE = 'эндермены (ад)'
const log = (what, o) => console.log('[forest]', new Date().toTimeString().slice(0, 8), what, JSON.stringify(o))

/** Видимый искажённый нилий отсюда: верхняя грань открыта (над ним воздух/растения), луч глаз до блока чист. */
function look (bot, { radius = 96, count = 600, rays = 90, names = ['warped_nylium'], top = true }: any = {}) {
  const reg = bot.registry
  const ids = names.map(n => reg && reg.blocksByName && reg.blocksByName[n] && reg.blocksByName[n].id).filter(id => id != null)
  if (!ids.length) return { cand: 0, seen: [] }
  const cand = bot.findBlocks({ matching: ids, maxDistance: radius, count })
  const step = Math.max(1, cand.length / rays)
  const seen = []
  for (let i = 0; i < cand.length && seen.length < rays; i += step) {
    const p = cand[Math.floor(i)]
    const b = bot.blockAt(p)
    const up = bot.blockAt(p.offset(0, 1, 0))
    if (!b || !up || (top && up.boundingBox === 'block')) continue
    if (seesBlock(bot, b)) seen.push(p)
  }
  let feet = null
  try { feet = biomeName(bot, bot.entity.position.floored()) } catch {}
  return { cand: cand.length, seen, feet }
}

/** Место для записи: видимый нилий у середины увиденного (там, где его гуще), с числом видимых блоков. */
function spot (seen) {
  if (!seen.length) return null
  const c = seen.reduce((a, p) => ({ x: a.x + p.x, y: a.y + p.y, z: a.z + p.z }), { x: 0, y: 0, z: 0 })
  const m = { x: c.x / seen.length, y: c.y / seen.length, z: c.z / seen.length }
  const best = seen.slice().sort((a, b) => Math.hypot(a.x - m.x, a.z - m.z) - Math.hypot(b.x - m.x, b.z - m.z))[0]
  return { x: best.x, y: best.y + 1, z: best.z, seen: seen.length }
}

/** Запомнить увиденное: леса — места в 48 бл. друг от друга; у каждого лучший взгляд (≥ 6 блоков, в 1.25 раза больше прежнего).
 *  Главная запись — лес с наибольшим счётом, остальные — alts (до 6): кампания берёт следующий, когда этот оказался пустым. */
function remember (session, s, feet, place = PLACE, min = 6) {
  const places = (session.journal.state && session.journal.state.places) || {}
  const old = places[place]
  if (old && old.by !== 'sight') return false
  const score = s.seen + (place === PLACE && feet === 'warped_forest' ? 10 : 0)
  if (score < min) return false
  const all = old ? [{ ...old, alts: undefined }, ...(old.alts || [])] : []
  const same = all.find(f => Math.hypot(f.x - s.x, f.z - s.z) < 48)
  if (same && score < (same.score || 0) * 1.25) return false
  const fresh = { x: s.x, y: s.y, z: s.z, score, seen: s.seen, t: gameClock.now(),
    note: place === PLACE ? `искажённый лес: видел ${s.seen} блоков нилия${feet === 'warped_forest' ? ', биом под ногами (F3) — искажённый лес' : ''}` : `стебли: видел ${s.seen}` }
  const list = [...all.filter(f => f !== same), fresh].sort((a, b) => (b.score || 0) - (a.score || 0))
  const [best, ...alts] = list
  session.journal.patch(st => {
    if (!st.places) st.places = {}
    st.places[place] = { ...best, dimension: 'the_nether', by: 'sight', alts: alts.slice(0, 6).map(f => ({ x: f.x, y: f.y, z: f.z, score: f.score, seen: f.seen, t: f.t })) }
  })
  log(place === PLACE ? 'лес увиден' : 'стебли увидены', { at: { x: s.x, y: s.y, z: s.z }, seen: s.seen, feet, was: same ? same.score : null, forests: list.length })
  return true
}

/** Видимые эндермены (луч к середине тела, 64 бл.): больше прежнего рекорда — запомнить место тела. */
function noteEndermen (session) {
  const bot = session.bot
  const me = bot.entity.position
  let n = 0
  for (const e of Object.values(bot.entities || {}) as any[]) {
    if (!e || e.name !== 'enderman' || !e.position || e.isValid === false || e.position.distanceTo(me) > 64) continue
    try { if (canSeePoint(bot, e.position.offset(0, 1.45, 0))) n++ } catch {}
  }
  if (n < 2) return false
  const places = (session.journal.state && session.journal.state.places) || {}
  const old = places[EM_PLACE]
  if (old && old.by !== 'sight') return false
  const f = me.floored()
  if (old && n <= (old.count || 0) && Math.hypot(old.x - f.x, old.z - f.z) > 8) return false
  if (old && n < (old.count || 0)) return false
  session.journal.patch(st => {
    if (!st.places) st.places = {}
    st.places[EM_PLACE] = { x: f.x, y: f.y, z: f.z, dimension: 'the_nether', by: 'sight', count: n, t: gameClock.now(), note: `отсюда видел ${n} эндерменов` }
  })
  log('эндермены видны', { at: { x: f.x, y: f.y, z: f.z }, n, was: old ? old.count : null })
  return true
}

// S1f (проверка S1e (д)): частота глаз леса — только игровым временем (таймер 10 игр. с в install, ND_FOREST_EVERY_MS), без дросселя по реальному:
// на ферме 750 TPS он делал взгляд раз в ~19 игр. с, на 20 TPS — раз в 4 с (поведение зависело от темпа мира).
function tick (session) {
  const bot = session.bot
  if (!bot || !bot.entity || !bot.game || !/nether/.test(String(bot.game.dimension || ''))) return
  const v = look(bot)
  const s = spot(v.seen)
  if (s) remember(session, s, v.feet)
  noteEndermen(session)
  // Стебли: сам видимый стебель (не верх), от 3 блоков; искажённые — первыми (в багровом лесу хоглины).
  for (const names of [['warped_stem'], ['crimson_stem']]) {
    const w = look(bot, { names, radius: 64, count: 200, rays: 40, top: false })
    const ws = w.seen.length ? w.seen.slice().sort((a, b) => a.distanceTo(bot.entity.position) - b.distanceTo(bot.entity.position)) : []
    if (ws.length >= 3) { const n = ws[0]; remember(session, { x: n.x, y: n.y, z: n.z, seen: ws.length + (names[0] === 'warped_stem' ? 4 : 0) }, null, WOOD_PLACE, 3); break }
  }
}

function install (session) {
  if (process.env.ND_FOREST_SIGHT === '0') return
  if (session._forestTimer && !session._forestTimer.clock?.disposed) return
  session._forestTimer = gameClock.setInterval(() => { try { tick(session) } catch {} }, Number(process.env.ND_FOREST_EVERY_MS) || 10000)
  if (session._forestTimer.unref) session._forestTimer.unref()
}

export { install, look, spot, remember, noteEndermen, PLACE, WOOD_PLACE, EM_PLACE }
