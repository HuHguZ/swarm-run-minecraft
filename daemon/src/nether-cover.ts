'use strict'
// Закрытый штрек Ада (агент Ада 14.10, план координатора: корень смертей c2–c19 — ход по поверхности Ада; осторожный человек
// без брони роет ходы в незераке: внутри его не видят пиглины, гасты и скелеты, под ним нет обрыва). Ход 1×2 на своей высоте,
// только по видимому (endportal-descent: копка и установка — гранью из глаз, рентгена нет):
//   • забой копается; жидкость в забое — заткнуть и другой ход; лава и источник воды рядом с новыми клетками — заложить;
//   • видимый воздух вокруг новых клеток тела (бока, крыша, пол) — закрыть блоком: штрек от старта замкнут;
//   • устье в пещеру (воздух впереди или больше трёх проёмов) — окно: onOpen (взгляд из устья), забой заложить, другой ход;
//     обе оси — устья: ступенями вниз под пол пещеры (не ниже minY — над лавовым морем y 31);
//   • старт на открытом (больше трёх проёмов у тела) — сперва вниз на 3 ступени в толщу пола, ход над головой заложить;
//   • руда золота Ада в стенах (goldOk) — копать: самородки падают в штрек, проём за ней закрыть.
// Ответ в форме nether.bore: { ok, dug, moved, placed, mouths, gold, down, why, view }.
const gameClock = require('./game-clock')
const Vec3 = require('vec3')
const D = require('./endportal-descent')
const { sleep, xyz } = require('./movement')

const N6 = [[1, 0, 0], [-1, 0, 0], [0, 1, 0], [0, -1, 0], [0, 0, 1], [0, 0, -1]].map(([x, y, z]) => new Vec3(x, y, z))
const SPIRAL = D.SPIRAL
const LIQUID = /^(water|lava|bubble_column)$/
const GOLD = /^(nether_gold_ore|gilded_blackstone)$/
const BAD_FLOOR = /magma|fire|campfire/
const STOP = /^(bedrock|spawner|nether_portal|end_portal|end_portal_frame)$|^infested_/
const FOES = /^(piglin|piglin_brute|hoglin|zoglin|skeleton|wither_skeleton|ghast|blaze|magma_cube)$/
const key = p => `${p.x},${p.y},${p.z}`
const airish = b => !!b && b.boundingBox === 'empty' && !LIQUID.test(b.name) && b.name !== 'nether_portal'
// Клетка ног над низким полом (песок душ 0.875): floored — клетка самого песка, голова тогда в трёх клетках, и шаг в вырытые две
// не проходит (d8-7-1, долина душ: «в забой не шагнул» ×43). Как nether.bore — над верхом опоры.
const feetCell = bot => {
  const f = require('./fortify').feetCell(bot)
  try { const s = require('./navigation/geometry').supportAt(bot, bot.entity.position, 0.04); if (s && Math.ceil(s.top - 1e-3) > f.y) f.y = Math.ceil(s.top - 1e-3) } catch {}
  return f
}
const bodyOf = F => [F, F.offset(0, 1, 0)]
const lavaBelow = bot => { try { return require('./cast').hearLava(bot, { radius: 12 }).some(h => h.below && h.flat <= 6) } catch { return false } }

// Что видно вокруг клеток cells (кроме них самих и except): проёмы (воздух), жидкость под заклад, золото в стенах.
function around (bot, cells, except = []) {
  const skip = new Set([...cells, ...except].map(key))
  const open = []; const wet = []; const gold = []
  for (const c of cells) {
    for (const n of N6) {
      const q = c.plus(n)
      if (skip.has(key(q))) continue
      skip.add(key(q))
      const b = D.seen(bot, q)
      if (!b) continue
      if (LIQUID.test(b.name)) { if (b.name === 'lava' || D.waterSource(b)) wet.push(q); continue }
      if (airish(b)) open.push(q)
      else if (GOLD.test(b.name)) gold.push(q)
    }
  }
  // Снизу вверх: блок сбоку встаёт на пол, крыша — на стену.
  open.sort((a, b) => a.y - b.y)
  return { open, wet, gold }
}

// Закрыть видимое вокруг cells: жидкость, затем проёмы. Сколько не закрылось.
async function seal (bot, cells, except, out) {
  const a = around(bot, cells, except)
  let left = 0
  for (const q of [...a.wet, ...a.open]) {
    if (await D.placeAt(bot, q)) out.placed++
    else left++
  }
  return left
}

// Шаг штрека из клетки ног в сторону d. { ok } | { mouth, why } | { why }.
async function closedStep (session, ctl, d, opts, out) {
  const bot = session.bot
  const F = feetCell(bot)
  const N = F.offset(d[0], 0, d[1])
  const cells = [N.offset(0, 1, 0), N]
  const refill = async () => { for (const c of [N, N.offset(0, 1, 0)]) if (await D.placeAt(bot, c)) out.placed++ }
  // Устье, вскрытое и заложенное в этом же ходе, второй раз не вскрывать (d5-6-2: одно устье ×3 — пиглины заметили). Память — на
  // вызов закрытого хода: общая на сессию запирала тело навсегда (d9: «устье (уже видел)» ×2576, 90 мин у портала).
  const mouths = opts.mouths || new Set()
  if (mouths.has(key(N)) && !opts.corridor) return { mouth: true, why: 'устье (уже видел)' }
  for (const c of cells) {
    const b = D.seen(bot, c)
    if (!b) return { why: 'забой не виден' }
    if (LIQUID.test(b.name)) { if (await D.placeAt(bot, c)) out.placed++; return { why: `${b.name} в забое — заткнул` } }
    if (STOP.test(b.name)) return { why: `${b.name} в забое` }
    if (b.boundingBox === 'empty') continue
    const r = await D.digCell(bot, session.mcData, c)
    if (!r.ok) return { why: r.why }
    out.dug++
  }
  if (ctl.aborted) return { why: 'прервано' }
  const a = around(bot, cells, bodyOf(F))
  const front = cells.map(c => c.offset(d[0], 0, d[1]))
  if (a.open.some(q => front.some(f => f.equals(q))) || a.open.length > 3) {
    const known = mouths.has(key(N))
    if (!known) {
      out.mouths++
      mouths.add(key(N))
      if (opts.onOpen) { try { const v = await opts.onOpen({ at: xyz(N), open: a.open.length }); if (v) out.view = v } catch {} }
    }
    // Закрытый коридор по полу пещеры (Codex q9: короткий закрытый пролёт): пол под забоем — видимый твёрдый, бока — блоками
    // отсюда, крыша — из новой клетки (грань прежней крыши видна оттуда). Фронт открыт — цена (окно 1×2 вперёд). Пол над пустотой
    // не мостим (честная грань пола из своей клетки не видна): там — закладка и другой ход.
    const flr = D.seen(bot, N.offset(0, -1, 0))
    // Враги на виду (пиглины без нашего золота, бруты, хоглины, скелеты, гасты) — коридор с открытым фронтом не строить: они идут
    // к нему (g2-5-2, g2-7-2: прибытие, коридор, пиглины — смерть на 1-й мин). Закладка и другой ход.
    const foes = (() => { try { return require('./perception/eyes').entities(bot, { radius: 32 }).some(e => e.seen && e.dist != null && e.dist <= 24 && FOES.test(e.name)) } catch { return false } })()
    if (opts.corridor && !foes && !(opts.stop && out.view && opts.stop(out.view)) && flr && flr.boundingBox === 'block' && !BAD_FLOOR.test(flr.name) &&
      require('./sealed').fillerCount(bot) >= 24 && !a.wet.length) {
      const sides = a.open.filter(q => q.y <= N.y + 1 && q.y >= N.y && !front.some(f => f.equals(q)))
      let ok = true
      for (const q of sides) { if (await D.placeAt(bot, q)) out.placed++; else { ok = false; break } }
      if (ok && await D.walkInto(bot, ctl, N, 0)) {
        out.moved++
        out.corridor = (out.corridor || 0) + 1
        const roof = N.offset(0, 2, 0)
        const rb = D.seen(bot, roof)
        if (rb && airish(rb)) { if (await D.placeAt(bot, roof)) out.placed++; else out.unsealed++ }
        return { ok: true, corridor: true }
      }
    }
    await refill()
    return { mouth: true, why: known ? 'устье (уже видел)' : `устье в пещеру (проёмов ${a.open.length})` }
  }
  const fl = D.seen(bot, N.offset(0, -1, 0))
  if (fl && BAD_FLOOR.test(fl.name)) { await refill(); return { why: `${fl.name} под ногами` } }
  for (const q of a.wet) {
    if (await D.placeAt(bot, q)) { out.placed++; continue }
    await refill()
    return { why: 'жидкость у забоя не заложил' }
  }
  const floor = N.offset(0, -1, 0)
  if (a.open.some(q => q.equals(floor))) {
    if (!(await D.placeAt(bot, floor))) { await refill(); return { why: 'пол забоя не встал' } }
    out.placed++
  }
  // Не шагнул (угол, низкий потолок) — забой заложить: открытый проём у тела следующий старт считал «открытым» (d8-7-1).
  if (!(await D.walkInto(bot, ctl, N, 0))) { if (!ctl.aborted) await refill(); return { why: 'в забой не шагнул' } }
  out.moved++
  out.unsealed += await seal(bot, cells, bodyOf(F), out)
  // Золото в стенах: самородки падают в штрек (подбор — рамка тела +1 бл.); вскрытое за рудой — закрыть.
  if (opts.goldOk && opts.goldOk()) {
    // Только стены и потолок: руда в полу под телом — это сам пол (d9-7-2: копнул руду под ногами — падение с y 87 на 49).
    for (const q of around(bot, cells, bodyOf(F)).gold.filter(q => q.y >= N.y)) {
      const r = await D.digCell(bot, session.mcData, q)
      if (!r.ok) continue
      out.gold++
      await sleep(300, ctl)
      out.unsealed += await seal(bot, [q], cells, out)
    }
  }
  return { ok: true }
}

// Вниз на n ступеней честной лестницей (endportal-descent.stairStep, без платных спусков) и закрыть ход над собой.
async function descend (session, ctl, n, d, out, minY) {
  const bot = session.bot
  let k = Math.max(0, SPIRAL.findIndex(s => s[0] === d[0] && s[1] === d[1]))
  let went = 0
  for (let i = 0; i < n && !ctl.aborted; i++) {
    // Ступень проваливается до 3 бл. (видимое дно) — запас к minY; лава слышна ниже рядом — не вниз (d2-7-1: спуски до y 31, лава).
    if (feetCell(bot).y - 4 < minY) { out.downWhy = `ниже ${minY} не иду`; break }
    if (lavaBelow(bot)) { out.downWhy = 'лава слышна ниже'; break }
    // Ступень — только в видимый твёрдый пол рядом (клетка ступени F+d−1) и не к устью: к пещере ступень вскрывала устье и тело
    // уносило вниз (d7-7-1).
    const F = feetCell(bot)
    const only = d => { const b = D.seen(bot, F.offset(d[0], -1, d[1])); return !!b && b.boundingBox === 'block' && !(out.mouthSet && out.mouthSet.has(key(F.offset(d[0], 0, d[1])))) }
    const r = await D.stairStep(session, ctl, k, { careful: true, noDrop: true, early: true, only })
    out.dug += r.dug || 0
    out.placed += r.placed || 0
    if (!r.moved) { out.downWhy = r.why; break }
    k = r.k
    went++
  }
  out.down += went
  if (went) out.unsealed += await seal(bot, bodyOf(feetCell(bot)), [], out)
  return went
}

async function closedBore (session, ctl, target, { deadline = gameClock.now() + 40000, maxSteps = 24, onOpen = null, goldOk = null, minY = 40, stop = null }: any = {}) {
  const bot = session.bot
  const out: any = { dug: 0, placed: 0, moved: 0, mouths: 0, gold: 0, down: 0, unsealed: 0 }
  const mouthSet = new Set()
  Object.defineProperty(out, 'mouthSet', { value: mouthSet, enumerable: false })
  const done = (ok, why = undefined) => ({ ok, ...out, why, at: xyz(bot.entity.position) })
  try { bot.pathfinder.setGoal(null) } catch {}
  const same = (a, b) => !!a && !!b && a[0] === b[0] && a[1] === b[1]
  const axesNow = () => {
    const F = feetCell(bot)
    const dx = target.x - F.x; const dz = target.z - F.z
    const main = Math.abs(dx) >= Math.abs(dz) ? [Math.sign(dx), 0] : [0, Math.sign(dz)]
    const side = main[0] ? [0, Math.sign(dz) || 1] : [Math.sign(dx) || 1, 0]
    return { main, side }
  }
  const toward = () => [axesNow().main]
  // Обход пещеры вдоль стены (Codex q9: «обход по вскрытой стене»): выбранная сторона держится, пока главная ось не откроется;
  // главную — не чаще раза в 3 шага обхода (иначе туда-сюда у устья: d3-5-1, 24 шага на месте, 72 блока). Назад — нет.
  let detour = null
  let skipMain = 0
  let last = null
  // Клетки, пройденные этим вызовом: в них не возвращаться — обход у устьев ходил по кругу (g7-6-1: «24 шага» на месте, кирки на ветер).
  const visited = new Set([key(feetCell(bot))])
  const order = () => {
    const { main, side } = axesNow()
    const F0 = feetCell(bot)
    const fresh = d => !visited.has(key(F0.offset(d[0], 0, d[1])))
    const sides = detour ? [detour, [-detour[0], -detour[1]]] : [side, [-side[0], -side[1]]]
    const list = skipMain > 0 ? [...sides, main] : [main, ...sides]
    const fwd = list.filter((d, i) => (d[0] || d[1]) && !(last && d[0] === -last[0] && d[1] === -last[1]) && list.findIndex(q => same(q, d)) === i)
    // Назад — последним: у портала (рамка, «nether_portal в забое») и в тупике между устьями вперёд хода нет (d9: ×500 на месте).
    const back = [-main[0], -main[1]]
    return (fwd.some(d => same(d, back)) ? fwd : [...fwd, back]).filter(fresh)
  }
  // Коридор (закрытый пролёт по полу пещеры) — когда вперёд и вбок только устья: держится своего направления до породы.
  let corridorDir = null
  // Старт: на открытом — в толщу пола; иначе закрыть то, что видно вокруг тела.
  const a0 = around(bot, bodyOf(feetCell(bot)))
  if (a0.open.length > 3 && !(await descend(session, ctl, 3, toward()[0] || [1, 0], out, minY))) {
    // Вниз нельзя (обрыв за ступенью, лава, низко) — в стену рядом: шаг туда, где забой — видимая порода (не воздух).
    const { main, side } = axesNow()
    const F = feetCell(bot)
    const rock = d => [F.offset(d[0], 0, d[1]), F.offset(d[0], 1, d[1])].every(c => { const b = D.seen(bot, c); return !!b && b.boundingBox === 'block' })
    let entered = false
    for (const d of [main, side, [-side[0], -side[1]], [-main[0], -main[1]]].filter(rock)) {
      if ((await closedStep(session, ctl, d, { onOpen, goldOk, mouths: mouthSet }, out)).ok) { entered = true; break }
    }
    // Ни вниз, ни в стену (площадка портала в пещере, d11-5-1) — коридором по полу к цели.
    if (!entered && (await closedStep(session, ctl, main, { onOpen, goldOk, mouths: mouthSet, corridor: true, stop }, out)).ok) { entered = true; corridorDir = main }
    if (!entered) {
      // На открытом без хода в толщу — закрыться на месте (коробка из видимых проёмов), не идти поверху (d7-6-1: уступ, падение).
      out.unsealed += await seal(bot, bodyOf(feetCell(bot)), [], out)
      return done(false, `на открытом: ни вниз (${out.downWhy || 'ступени нет'}), ни в стену — закрылся на месте`)
    }
  } else out.unsealed += await seal(bot, bodyOf(feetCell(bot)), [], out)
  let downs = 0
  for (let s = 0; s < maxSteps; s++) {
    // Тело в своём закрытом ходе: тактика не бежит из него (бег из хода 1×2 — к устьям, в пещеру: d12-5-2 Flee → лава), а бьётся
    // или закладывает проём на месте (tactics escapeRoute).
    session._ndCoverUntil = gameClock.now() + 4000
    if (ctl.aborted) return done(false, 'прервано')
    if (gameClock.now() > deadline) return done(false, 'время вышло')
    const F = feetCell(bot)
    if (Math.abs(target.x - F.x) <= 1 && Math.abs(target.z - F.z) <= 1) return done(true)
    if (corridorDir) {
      const rc: any = await closedStep(session, ctl, corridorDir, { onOpen, goldOk, mouths: mouthSet, corridor: true, stop }, out)
      if (out.view && stop && stop(out.view)) return done(false, 'постройка видна из коридора')
      if (rc.ok) { last = corridorDir; if (!rc.corridor) corridorDir = null; continue }
      corridorDir = null
    }
    let why = null
    let stepped = false
    const main = axesNow().main
    let mainFailed = false
    for (const d of order()) {
      const r: any = await closedStep(session, ctl, d, { onOpen, goldOk, mouths: mouthSet }, out)
      if (r.ok) {
        visited.add(key(feetCell(bot)))
        if (same(d, main)) { detour = null; skipMain = 0 } else { detour = d; skipMain = mainFailed ? 3 : Math.max(0, skipMain - 1) }
        last = d
        stepped = true
        break
      }
      if (same(d, main)) mainFailed = true
      why = r.why
      // Из устья видно то, что ищет вызов (stop) — ответ ему; иное увиденное (крепость при поиске бастиона) — дальше штреком.
      if (out.view && stop && stop(out.view)) return done(false, 'постройка видна из устья')
    }
    if (stepped) continue
    // Вперёд и вбок только устья — коридором по полу пещеры к цели (5 блоков за шаг), потом — под пол.
    {
      const m = axesNow().main
      const rc: any = await closedStep(session, ctl, m, { onOpen, goldOk, mouths: mouthSet, corridor: true, stop }, out)
      if (rc.ok) { last = m; if (rc.corridor) corridorDir = m; continue }
      if (out.view && stop && stop(out.view)) return done(false, 'постройка видна из устья')
    }
    // Обе оси — устья или стена: под пол пещеры (по 2 ступени, до 3 раз за вызов).
    if (downs < 3 && (await descend(session, ctl, 2, toward()[0] || [1, 0], out, minY))) { downs++; continue }
    return done(false, why || 'штрек не пошёл')
  }
  return done(false, `за ${maxSteps} шагов не дошёл`)
}

// «В толщу» по видимому — замена burrow вслепую (та выбирала колонну по скрытым блокам, Codex q9): на открытом — вниз на 3 ступени
// и закрыть ход над собой; не вышло вниз или уже у стены — закрыть видимые проёмы вокруг тела (это и есть коробка на месте).
async function coverHere (session, ctl, { minY = 40 }: any = {}) {
  const bot = session.bot
  session._ndCoverUntil = gameClock.now() + 4000
  const out: any = { dug: 0, placed: 0, moved: 0, mouths: 0, gold: 0, down: 0, unsealed: 0 }
  if (around(bot, bodyOf(feetCell(bot))).open.length > 3) await descend(session, ctl, 3, [1, 0], out, minY)
  out.unsealed += await seal(bot, bodyOf(feetCell(bot)), [], out)
  const left = around(bot, bodyOf(feetCell(bot))).open.length
  return { ok: left === 0, sealed: left === 0, how: out.down ? 'в толщу ступенями' : 'проёмы вокруг закрыл', ...out, at: xyz(bot.entity.position), why: left ? `проёмов осталось ${left}` : undefined }
}

// Ход к точке закрытым штреком отрезками (nether_tunnel вслепую: tunnelTo планирует по скрытому объёму — Codex q9).
async function coveredTo (session, ctl, target, { deadline, radius = 2 }: any) {
  const bot = session.bot
  let moved = 0; let dug = 0; let placed = 0; let segs = 0; let why = null
  while (!ctl.aborted && gameClock.now() < deadline) {
    const c: any = await closedBore(session, ctl, target, { deadline: Math.min(deadline, gameClock.now() + 60000), maxSteps: 48 })
    segs++; moved += c.moved; dug += c.dug; placed += c.placed
    const p = bot.entity.position
    if (c.ok || Math.hypot(target.x - p.x, target.z - p.z) <= radius + 1) return { ok: true, segs, moved, dug, placed, at: xyz(p) }
    why = c.why
    if (!c.moved) break
  }
  return { ok: false, segs, moved, dug, placed, why: why || (ctl.aborted ? 'прервано' : 'время вышло'), at: xyz(bot.entity.position) }
}

const blind = () => process.env.ND_NE_COVER !== '0' && require('./perception/knowledge').level() !== 'scan'

module.exports = { closedBore, closedStep, around, seal, descend, coverHere, coveredTo, blind }
