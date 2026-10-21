'use strict'
// Честный спуск к крепости и штрек к комнате (S5e 07.10; AGENTS.md «как игрок на случайном сиде»: без рентгена толщи).
// Прежний shaftToBricks выбирал ход по пещерам, воде, лаве и капельнику ВНУТРИ толщи (bot.blockAt без луча). Здесь — как
// человек с киркой:
//   • лестница зигзагом 2×1 (туда-обратно; ND_STAIR_SPIRAL=1 — винтовая 2×2): на ступень копаются ноги и ступень впереди (голова —
//     ноги прошлой ступени, уже воздух), каждый блок — только видимый (луч глаз, perception/eyes.seesNow); пол следующей ступени
//     виден в проём ДО шага;
//   • под ступенью пустота — спуск ≤ 3 на видимое твёрдое дно, иначе блок-мост; не видно дна — мост;
//   • жидкость, которую увидел или впустил (проём, соседние клетки проёма), — заложить блоком; не вышло — другой ход;
//   • лава на слух (cast.hearLava: звук клиента, только сторона/дальность) рядом и ниже — осторожно: без платных спусков;
//   • кирпич крепости (каменный кирпич, решётки, рамки), увиденный в забое или в проёме, — пришли.
// Итог — как у endportal.shaftToBricks: { found, at, dug, fromY } | { reached, at, dug, fromY } | { stopped, dug }.
// На уровне знания scan и при ND_HONEST_SHAFT=0 — прежний shaftToBricks (endportal.honestDescent()).
const gameClock: typeof import('./game-clock') = require('./game-clock')
const Vec3: typeof import('vec3').Vec3 = require('vec3')
const { sleep, xyz }: typeof import('./movement') = require('./movement')
const { equipBestTool, missingHarvestTool }: typeof import('./items') = require('./items')
const eyes: typeof import('./perception/eyes') = require('./perception/eyes')
const geometry: typeof import('./navigation/geometry') = require('./navigation/geometry')

const LIQUID = /^(water|lava|bubble_column)$/
const HAZARD_FLOOR = /lava|magma|pointed_dripstone|powder_snow|cactus|campfire|fire/
const ROOM = /^(end_portal_frame|end_portal|spawner)$/
// Восток → юг → запад → север: четыре ступени — круг, тело в квадрате 2×2 над целью.
const SPIRAL = [[1, 0], [0, 1], [-1, 0], [0, -1]]
const N6 = [[1, 0, 0], [-1, 0, 0], [0, 1, 0], [0, -1, 0], [0, 0, 1], [0, 0, -1]]
const MAX_FREE_FALL = 3

const sees = (bot, p) => { try { return eyes.seesNow(bot, p) } catch { return false } }
const waterSource = b => { if (!b || b.name !== 'water') return false; try { return Number((b.getProperties && b.getProperties().level) ?? 0) === 0 } catch { return true } }
// Блок, если его видно сейчас; иначе null («не знаю»). Клетка под ногами видна всегда (стоим на её верхней грани).
function seen (bot, p) {
  const f = bot.entity.position.floored()
  if ((p.x === f.x && p.z === f.z && p.y === f.y - 1) || sees(bot, p)) return bot.blockAt(p)
  return null
}
const solid = b => !!b && b.boundingBox === 'block'
const airish = b => !!b && b.boundingBox === 'empty' && !LIQUID.test(b.name)

// Дно под проёмом по видимому: идём вниз по колонке, пока клетки видны и пусты. { fall, bottom } — fall: сколько блоков
// падать телу, вставшему в cell (ноги на cell.y); bottom — блок дна или null (не видно / глубже 24).
function visibleDrop (bot, cell) {
  for (let k = 1; k <= 24; k++) {
    const q = cell.offset(0, -k, 0)
    const b = seen(bot, q)
    if (!b) return { fall: null, bottom: null }
    if (airish(b)) continue
    return { fall: k - 1, bottom: b }
  }
  return { fall: null, bottom: null }
}

// Решение на одну ступень из клетки ног F в сторону d — только по видимому. Чистая функция (тесты: одинакова в мирах, разных
// лишь за стеной). { act: 'dig'|'seal'|'bridge'|'step'|'brick'|'turn', cell?, name?, fall?, why? }
// wetOk — клетки воды, которые заложить не вышло: вода (не лава) — помеха, не стоп (течёт в лестницу — идём по ней).
function judgeStep (bot, F, d, { bricks = null, careful = false, hp = 20, throughBricks = false, dropUnknown = false, wetOk = null, noDrop = false }: any = {}) {
  const skip = (b, q) => b.name !== 'lava' && wetOk && wetOk.has(`${q.x},${q.y},${q.z}`)
  // Закладывать: лаву (любую) и источник воды. Текущая вода без источника рядом стекает сама — проходима (s5e-Q-1 07.10: заклад
  // текущей воды в своих клетках ступени — копать снова — течёт снова; лестница у озера затопилась).
  const sealIt = (b, q) => (b.name === 'lava' || b.name === 'bubble_column' || waterSource(b)) && !skip(b, q)
  const N = F.offset(d[0], 0, d[1])
  const cells = [N.offset(0, 1, 0), N, N.offset(0, -1, 0)]
  for (const c of cells) {
    const b = seen(bot, c)
    if (!b) return { act: 'turn', why: `забой не виден (${c.x},${c.y},${c.z})` }
    // Жидкость в клетке ступени (натекла сверху/сбоку — источник за ней не виден или выше): заткнуть клетку и в другую сторону
    // (s5e-M-2 07.10: лестница под озером затопилась — «утонул»).
    if (LIQUID.test(b.name)) return { act: 'plug', cell: c, name: b.name }
    if (ROOM.test(b.name)) return { act: 'brick', cell: c, name: b.name, room: true }
    if (b.boundingBox === 'empty') continue
    if (bricks && bricks.test(b.name) && !throughBricks) return { act: 'brick', cell: c, name: b.name }
    // Заражённый кирпич: сквозь крепость — копать при хп ≥ 12 (цена — чешуйница, ~1 урона в железе), иначе другой ход.
    if (/^infested_/.test(b.name) && !(throughBricks && hp >= 12)) return { act: 'turn', why: `${b.name} в забое` }
    if (b.name === 'bedrock') return { act: 'turn', why: 'бедрок' }
    return { act: 'dig', cell: c, name: b.name }
  }
  // Проём открыт: жидкость в соседних клетках проёма, которую видно, — заложить до шага.
  for (const c of cells) {
    for (const [x, y, z] of N6) {
      const q = c.offset(x, y, z)
      if (cells.some(k => k.equals(q))) continue
      const b = seen(bot, q)
      if (b && LIQUID.test(b.name) && sealIt(b, q)) return { act: 'seal', cell: q, name: b.name, by: c }
    }
  }
  // За ступенью обрыв (видимый воздух без пола на уровне ног ступени): walkInto держит «вперёд» до приземления — тело выносит
  // за клетку ступени (d5-5-1/6-1 14.10, Ад: спуск в толщу у края пещеры — падение с y 54–64 в лавовое море). Другой ход.
  const past = seen(bot, N.offset(d[0], -1, d[1]))
  if (past && airish(past) && !solid(seen(bot, N.offset(d[0], -2, d[1])))) return { act: 'turn', why: 'за ступенью обрыв' }
  const land = N.offset(0, -2, 0)
  const lb = seen(bot, land)
  if (!lb) return { act: 'bridge', cell: land, why: 'пол ступени не виден' }
  if (LIQUID.test(lb.name) && sealIt(lb, land)) return { act: 'seal', cell: land, name: lb.name }
  if (lb.name === 'water' && waterSource(lb)) return { act: 'step', fall: 0, wet: true }
  if (solid(lb)) return HAZARD_FLOOR.test(lb.name) ? { act: 'turn', why: `${lb.name} под ступенью` } : { act: 'step', fall: 0 }
  // Под ступенью пустота: видимое дно близко и безопасно — спуск; иначе мост.
  // Цена спуска: до 3 бл. — даром; глубже — урон (fall − 3) из запаса хп сверх 12, не больше 6 (коридор крепости 4–5 бл.,
  // пролёт лестницы старта — до 11). Слышна лава рядом ниже — только даром.
  const drop = visibleDrop(bot, N.offset(0, -1, 0))
  const fall = drop.fall === null ? null : drop.fall + 1
  const dmg = fall === null ? Infinity : Math.max(0, fall - MAX_FREE_FALL)
  const ok = drop.bottom && fall !== null && solid(drop.bottom) && !HAZARD_FLOOR.test(drop.bottom.name) && hp >= 10 &&
    (dmg === 0 || (!careful && dmg <= Math.min(6, hp - 12)))
  // noDrop (закрытый штрек Ада, nether-cover.descend): только ступень на твёрдое прямо под ней — в падении тело несёт вперёд.
  if (ok && !noDrop) return { act: 'step', fall }
  // Внутрь крепости сквозь потолок коридора (honestEnter): дна из проёма 1×1 не видно (свой пол заслоняет крутой луч), а под
  // потолком — коридор 3–5 бл. высотой: спрыгнуть — цена (≤ 2 урона), как человек, пробивший потолок. Лава/вода в видимой части
  // колонки — нет; хп < 14, осторожно (лава на слух) — нет.
  if (dropUnknown && !drop.bottom && !careful && hp >= 14) return { act: 'step', fall: 4, unknown: true }
  return { act: 'bridge', cell: land, why: drop.bottom ? `пустота ${fall === null ? '?' : fall} бл. на ${drop.bottom.name}` : 'дна не видно' }
}

// noDrop judges the future stair only AFTER digging. A toe can still stand on
// N-1 while floor(position) names the next air cell: do not cut that sole support.
function cutsOnlySupport (bot, block) {
  if (process.env.ND_LAVA_FALL_GUARD !== '1' || !/nether/.test(String(bot.game?.dimension || ''))) return false
  const p = bot.entity?.position
  if (!p || !block?.position) return false
  const body = geometry.bodyBox(bot, p), eps = 1e-7
  const holds = geometry.shapeBoxes(block).some(b => b.maxY <= p.y + eps && p.y - b.maxY <= .04 + eps &&
    Math.min(body.maxX, b.maxX) - Math.max(body.minX, b.minX) > eps &&
    Math.min(body.maxZ, b.maxZ) - Math.max(body.minZ, b.minZ) > eps)
  if (!holds) return false
  const remaining = { physics: bot.physics, entity: bot.entity,
    blockAt: q => q.equals(block.position) ? null : seen(bot, q) }
  return !geometry.supportAt(remaining, p, .04)
}

async function digCell (bot, mcData, cell) {
  for (let pass = 0; pass < 6; pass++) {
    const b = bot.blockAt(cell)
    if (!b || b.boundingBox === 'empty') return { ok: true }
    if (!sees(bot, cell)) return { ok: false, why: 'блок не виден' }
    const problem = missingHarvestTool(bot, b, mcData)
    let t = Infinity
    try { t = bot.digTime(b) } catch {}
    if (problem && t > 10000) return { ok: false, why: problem }
    try {
      await equipBestTool(bot, b)
      if (cutsOnlySupport(bot, b)) return { ok: false, why: 'LAVA_FALL_GUARD: единственная опора под телом — сначала отойти на твёрдый пол' }
      await bot.dig(b, true)
    } catch (e) { return { ok: false, why: `не сломал ${b.name}: ${e.message}` } }
    // Гравий/песок над клеткой падает за 1–2 тика: подождать их и проверить снова (больше ждать нечего — 2 игр. тика на блок).
    if (/gravel|sand|powder/.test(String((bot.blockAt(cell.offset(0, 1, 0)) || {}).name))) await sleep(150); else await sleep(50)
  }
  return { ok: false, why: 'сыплется (гравий/песок) — 6 раз' }
}

async function placeAt (bot, cell, ctl = null) {
  const { placeBlockAt }: typeof import('./build') = require('./build')
  try { const r = await placeBlockAt(bot, cell, { timeoutMs: 2000, steady: true, honest: true, ctl }); return !!(r && r.ok) } catch { return false }
}

// early — торможение тем же рулём, что у спуска блоками; шаг подтверждается опорой на своей ступени, не входом в колонну.
async function walkInto (bot, ctl, goal, fall, early = false) {
  const cx = goal.x + 0.5; const cz = goal.z + 0.5
  const t0 = gameClock.now()
  const from = bot.entity.position.floored()
  let centred = false
  try {
    while (!ctl.aborted && gameClock.now() - t0 < 2500) {
      const p = bot.entity.position
      if (early && (p.y < goal.y - 0.1 || bot.entity.isInLava)) break
      if (Math.floor(p.x) === goal.x && Math.floor(p.z) === goal.z && (Math.floor(p.y) <= goal.y && (!early || bot.entity.onGround && Math.hypot(p.x - cx, p.z - cz) < 0.2 && Math.hypot(bot.entity.velocity.x, bot.entity.velocity.z) < 0.03))) break
      // Застрял на углу (тело не по центру своей клетки в проходе 1 бл.): сперва в центр своей клетки, потом снова к цели
      // (s5e-H-1 07.10: «не шагнул в …» ×4 в коридоре крепости у самой комнаты).
      if (!early && !centred && gameClock.now() - t0 > 900) {
        centred = true
        const t1 = gameClock.now()
        while (!ctl.aborted && gameClock.now() - t1 < 700 && Math.hypot(bot.entity.position.x - from.x - 0.5, bot.entity.position.z - from.z - 0.5) > 0.15) {
          await bot.lookAt(new Vec3(from.x + 0.5, bot.entity.position.y + 1.6, from.z + 0.5), true).catch(() => {})
          bot.setControlState('forward', true)
          await sleep(50)
        }
        bot.setControlState('forward', false)
        continue
      }
      if (early) {
        const steer = (require('./blockmoves') as typeof import('./blockmoves')).steerTo(bot, bot.entity, { x: cx, z: cz }, false)
        await bot.look(steer.yaw, 0, true)
        bot.setControlState('forward', steer.forward)
      } else {
        await bot.lookAt(new Vec3(cx, p.y + 1.6, cz), true).catch(() => {})
        bot.setControlState('forward', true)
      }
      await sleep(50)
    }
  } finally { try { bot.setControlState('forward', false) } catch {} }
  const t1 = gameClock.now()
  while (!ctl.aborted && gameClock.now() - t1 < 1000 + fall * 200 && !bot.entity.onGround) await sleep(50)
  const f = bot.entity.position.floored()
  return f.x === goal.x && f.z === goal.z && f.y <= goal.y && (!early || !ctl.aborted && bot.entity.onGround && f.y === goal.y)
}

function lavaNearBelow (bot) {
  if (process.env.ND_OW_HEAR === '0') return false
  try { return (require('./cast') as typeof import('./cast')).hearLava(bot, { radius: 12 }).some(h => h.below && h.flat <= 6) } catch { return false }
}

// Одна ступень вниз из клетки ног: сторона спирали k, при отказе — следующие три. { moved, k, found?, room?, why, dug, placed, fall }
async function stairStep (session, ctl, k, o: any = {}) {
  const bot = session.bot
  const F = bot.entity.position.floored()
  let dug = 0; let placed = 0; let why = null; let wet = 0
  const wetOk = o.wetOk || new Set()
  for (let t = 0; t < 4; t++) {
    const d = SPIRAL[(k + t) % 4]
    // only(d) — разрешённые стороны (nether-cover.descend: ступень только в видимую породу, не к устью пещеры).
    if (o.only && !o.only(d)) { why = why || 'сторона закрыта'; continue }
    let j = null,blocked=null
    const guard=async()=>o.guard?await o.guard(F,d):null
    const move=async(goal,fall,early=false)=>{
      const moveCtl=o.threat?{get aborted(){return ctl.aborted||o.threat()}}:ctl
      const ok=await walkInto(bot,moveCtl,goal,fall,early)
      blocked=await guard()
      return ok&&!blocked
    }
    blocked=await guard()
    if(blocked)return{moved:false,k,dug,placed,...blocked}
    for (let a = 0; a < 10 && !ctl.aborted; a++) {
      j = judgeStep(bot, F, d, { ...o, wetOk, hp: bot.health ?? 20 })
      if (j.act === 'dig') {
        const r = await digCell(bot, session.mcData, j.cell)
        if (!r.ok) { j = { act: 'turn', why: r.why }; break }
        dug++
        blocked=await guard()
        if(blocked)return{moved:false,k,dug,placed,...blocked}
        continue
      }
      if (j.act === 'plug') {
        if (await placeAt(bot, j.cell)) placed++
        wet++
        j = { act: 'turn', why: `${j.name} в забое — заткнул, другой ход` }
        break
      }
      if (j.act === 'seal' || j.act === 'bridge') {
        if (await placeAt(bot, j.cell)) { placed++; continue }
        // Источник не заложил (к нему не прислонить) — заткнуть свою клетку проёма рядом с ним и в другую сторону.
        if (j.act === 'seal') {
          if (j.by && (await placeAt(bot, j.by))) placed++
          wet++
          j = { act: 'turn', why: `${j.name} рядом — не заложил, заткнул проём` }
          break
        }
        // Мост над пустотой не к чему прислонить (широкая пещера): ступень вернуть блоком и шагнуть ровно (тело в той же
        // высоте, спираль обходит пещеру), а не прыгать в невидимое.
        const N = F.offset(d[0], 0, d[1])
        if (j.act === 'bridge' && (await placeAt(bot, N.offset(0, -1, 0)))) {
          placed++
          // noDrop (укрытие Ада): ровный шаг по своему же вернутому блоку над пустотой — не укрытие, а риск: dbg37b-3818 —
          // уступ толщиной в блок над лавовым морем, два «ровных шага» по вернутым блокам, на втором опоры не оказалось — с y79 в
          // лаву y31. Блок вернули — ступень закрыта, дальше другая сторона.
          if (o.noDrop) { j = { act: 'turn', why: 'под ступенью пустота — ступень вернул, по уступу не иду' }; break }
          if (await move(N, 0)) return { moved: true, flat: true, k: (k + t + 1) % 4, fall: 0, dug, placed }
        }
        j = { act: 'turn', why: j.act === 'seal' ? `${j.name} не заложил` : `мост не встал (${j.why})` }
        break
      }
      break
    }
    if(blocked)return{moved:false,k,dug,placed,...blocked}
    if (!j || ctl.aborted) return { moved: false, k, why: 'прервано', dug, placed }
    if (j.act === 'brick') return { moved: false, k, found: j.name, at: j.cell, room: j.room || undefined, dug, placed }
    if (j.act === 'turn') { why = j.why; continue }
    if (j.act === 'step') {
      // Зигзаг 2×1 (следующая ступень — обратно): клетка головы следующей ступени — ноги этой, уже воздух: 2 блока на уровень
      // вместо 3 у спирали 2×2 (s5e-M-1: 80 ступеней по ~3.1 игр. с). Пол следующей ступени так же виден в проём до шага.
      if (await move(F.offset(d[0], -1, d[1]), j.fall, !!o.early)) return { moved: true, k: (k + t + (process.env.ND_STAIR_SPIRAL === '1' ? 1 : 2)) % 4, fall: j.fall, dug, placed }
      if(blocked)return{moved:false,k,dug,placed,...blocked}
      if (!bot.entity.position.floored().equals(F)) return { moved: false, k, why: 'после шага клетка изменилась — нужен новый обзор', dug, placed }
      why = 'не шагнул на ступень'
    }
  }
  return { moved: false, k, why: wet >= 3 ? `вода со всех сторон (${why || ''})` : (why || 'хода нет'), wet: wet >= 3, dug, placed }
}

// Спуск винтовой лестницей до кирпича (bricks), до уровня targetY или до minY.
async function honestShaft (session, ctl, { minY = -58, deadline, targetY = null, bricks = null, log = (_w, _o) => {} }: any) {
  const bot = session.bot
  const mcData = session.mcData
  const fromY = bot.entity.position.floored().y
  const t0 = gameClock.now()
  let dug = 0; let placed = 0; let steps = 0; let turns = 0; let falls = 0
  let k = 0
  let careful = false
  const out = (r) => ({ ...r, dug, fromY, honest: { steps, placed, turns, falls, careful } })
  const brickIds = bricks ? (Object.values(mcData.blocksByName) as any[]).filter((b: any) => bricks.test(b.name)).map((b: any) => b.id) : []
  const mapped = Number.isFinite(targetY)
  for (let guard = 0; guard < 600; guard++) {
    if (ctl.aborted) return out({ stopped: 'прервано' })
    if (gameClock.now() > deadline) return out({ stopped: 'время вышло' })
    const F = bot.entity.position.floored()
    if (mapped && F.y <= targetY) return out(F.y >= targetY - 3 ? { reached: true, at: xyz(F) } : { stopped: `ниже уровня комнаты (${F.y} < ${targetY})` })
    if (F.y <= minY) return out({ stopped: `дошёл до y=${F.y}, кирпича так и не встретил` })
    if ((bot.health ?? 20) < 6) return out({ stopped: `здоровья ${Math.round(bot.health)} — дальше не копаю` })
    // Лестницу заливает сверху (озеро над началом, s5e-H-2: «drowned» в своей лестнице): голова в воде — дальше не копать, наверх.
    {
      const hb = bot.blockAt(F.offset(0, 1, 0))
      if (hb && /water/.test(hb.name) && (bot.oxygenLevel ?? 20) < 16) return out({ stopped: 'лестницу залило — голова в воде', wet: true, drowning: true })
    }
    if (!careful && steps % 4 === 0 && lavaNearBelow(bot)) { careful = true; log('слышу лаву ниже — осторожный спуск', { at: xyz(F) }) }
    if ((require('./tunnel') as typeof import('./tunnel')).lowPicks(bot) < 2) { try { await (require('./tunnel') as typeof import('./tunnel')).restockPicks(session, ctl, 2) } catch {} }
    // Кирпич крепости в проёме (виден лучом рядом) — пришли.
    if (brickIds.length && !mapped) {
      try {
        // Только под землёй (на 4+ ниже начала шахты): кирпич руин портала/тропы у поверхности — не крепость.
        const v = (require('./sight') as typeof import('./sight')).visibleOf(bot, brickIds, 5, { max: 3, rays: 120 }).filter(b => b.position.y < fromY - 4)
        if (v.length) return out({ found: v[0].name, at: xyz(v[0].position) })
      } catch {}
    }
    const r = await stairStep(session, ctl, k, { bricks, careful, throughBricks: mapped })
    dug += r.dug; placed += r.placed
    // Рамка/спавнер комнаты в забое при спуске к её уровню (по карте) — пришли к комнате.
    if (r.found) return out(mapped ? { reached: true, room: true, found: r.found, at: xyz(F) } : { found: r.found, at: xyz(r.at), room: r.room })
    if (!r.moved) return out({ stopped: `спуск встал на ${F.x},${F.y},${F.z}: ${r.why}`, wet: r.wet || undefined })
    k = r.k; steps++
    if (r.fall > 1) falls++
    if (steps % 10 === 0) log('спуск', { y: Math.floor(bot.entity.position.y), steps, dug, placed, turns, sec: Math.round((gameClock.now() - t0) / 100) / 10 })
  }
  return out({ stopped: 'спуск: 600 ступеней' })
}

// Внутрь крепости от кирпича — по видимому: кирпич сбоку — пробить голову и ноги и шагнуть (за ним коридор станет виден);
// иначе ступень вниз сквозь кирпич (потолок коридора: дно видно в проём — спуск по цене или мост). toward — середина лестницы
// старта (уточнено оком): туда раньше. roomy() — «внутри» (просторно). { inside, steps[] }.
async function honestEnter (session, ctl, { deadline, toward = null, bricks, roomy, tries = 10, allowDescent = true }: any) {
  const bot = session.bot
  const steps = []
  let k = 0
  for (let i = 0; i < tries && !ctl.aborted && gameClock.now() < deadline; i++) {
    if (roomy()) return { inside: true, steps }
    const F = bot.entity.position.floored()
    const order = SPIRAL.map((d, n) => ({ d, n, s: toward ? -(d[0] * (toward.x - F.x) + d[1] * (toward.z - F.z)) : n })).sort((a, b) => a.s - b.s)
    let moved = false
    for (const { d, n } of order) {
      const f = F.offset(d[0], 0, d[1])
      const bf = seen(bot, f); const bh = seen(bot, f.offset(0, 1, 0))
      if (!((bf && bricks.test(bf.name)) || (bh && bricks.test(bh.name)))) continue
      const r = await honestTunnelStep(session, ctl, f, { bricks, throughBricks: true })
      steps.push(`сквозь стену ${f.x},${f.y},${f.z}: ${r.ok ? 'шаг' : r.why}`)
      if (r.ok) { moved = true; k = n; break }
    }
    if (moved) continue
    if (!allowDescent) break
    if (toward && Math.abs(toward.x - F.x) + Math.abs(toward.z - F.z) >= 1 && Math.abs(toward.x - F.x) <= 4 && Math.abs(toward.z - F.z) <= 4) {
      k = order[0].n
    }
    const r = await stairStep(session, ctl, k, { bricks, throughBricks: true, dropUnknown: true })
    steps.push(r.moved ? `ступень ${F.x},${F.y},${F.z}${r.fall > 1 ? ` (спуск ${r.fall})` : ''}` : `ступень: ${r.found || r.why}`)
    if (!r.moved) break
    k = r.k
  }
  return { inside: roomy(), steps }
}

// Шаг штрека в соседнюю клетку на своём уровне — по видимому (как ступень, но без спуска): голова и ноги, жидкость рядом —
// заложить, пол — мост, если пустота. { ok, dug, why }.
async function honestTunnelStep (session, ctl, cell, { bricks = null, throughBricks = true }: any = {}) {
  const bot = session.bot
  const F = bot.entity.position.floored()
  const d = [cell.x - F.x, cell.z - F.z]
  let dug = 0
  const wetOk = new Set()
  for (let a = 0; a < 12; a++) {
    // Ступень на своём уровне: «нижняя» клетка ступени — пол (cell.y − 1) уже должен быть твёрдым.
    const cells = [cell.offset(0, 1, 0), cell]
    let j = null
    for (const c of cells) {
      const b = seen(bot, c)
      if (!b) { j = { act: 'turn', why: 'забой не виден' }; break }
      // Жидкость в клетке забоя (натекла) — заткнуть её и отказ этого шага (штрек под водой: tunnelUnder уйдёт глубже).
      if (LIQUID.test(b.name)) { j = { act: 'plug', cell: c, name: b.name }; break }
      if (ROOM.test(b.name) || (/^infested_/.test(b.name) && !(throughBricks && (bot.health ?? 20) >= 12)) || b.name === 'bedrock') { j = { act: 'turn', why: `${b.name} в забое` }; break }
      if (b.boundingBox === 'empty') continue
      if (bricks && bricks.test(b.name) && !throughBricks) { j = { act: 'brick', cell: c, name: b.name }; break }
      j = { act: 'dig', cell: c }; break
    }
    if (!j) {
      for (const c of cells) for (const [x, y, z] of N6) {
        const q = c.offset(x, y, z)
        if (cells.some(k => k.equals(q))) continue
        const b = seen(bot, q)
        if (b && LIQUID.test(b.name) && (b.name === 'lava' || waterSource(b)) && !(b.name !== 'lava' && wetOk.has(`${q.x},${q.y},${q.z}`))) { j = { act: 'seal', cell: q, name: b.name, by: c }; break }
      }
    }
    if (!j) {
      const fl = seen(bot, cell.offset(0, -1, 0))
      if (!fl || !solid(fl)) j = { act: 'bridge', cell: cell.offset(0, -1, 0) }
      else if (HAZARD_FLOOR.test(fl.name)) j = { act: 'turn', why: `${fl.name} под ногами` }
    }
    if (!j) break
    if (j.act === 'turn' || j.act === 'brick') return { ok: false, dug, why: j.why || `${j.name} в забое`, brick: j.act === 'brick' ? j.name : undefined }
    if (j.act === 'dig') { const r = await digCell(bot, session.mcData, j.cell); if (!r.ok) return { ok: false, dug, why: r.why }; dug++; continue }
    if (j.act === 'plug') { await placeAt(bot, j.cell); return { ok: false, dug, wet: true, why: `${j.name} в забое — заткнул` } }
    if (!(await placeAt(bot, j.cell))) {
      // Источник рядом не заложил — заткнуть свою клетку забоя у него и отказ (вода в штреке — утонуть).
      if (j.act === 'seal') { if (j.by) await placeAt(bot, j.by); return { ok: false, dug, wet: true, why: `${j.name} рядом — не заложил, заткнул забой` } }
      return { ok: false, dug, why: 'пол — пустота, мост не встал' }
    }
  }
  const ok = await walkInto(bot, ctl, cell, 0)
  return ok ? { ok, dug } : { ok, dug, why: `не шагнул в ${cell.x},${cell.y},${cell.z} (${d.join(',')})` }
}

// Штрек к точке на своём уровне (к приманке: спавнер по «пирогу», звук лавы) — шагами honestTunnelStep по главной оси, при отказе
// — по второй. Кирпич крепости копается (throughBricks), заражённый — при хп ≥ 12. Ответ в форме nether.bore: { ok, dug, moved, why }.
async function honestBore (session, ctl, target, { deadline, maxSteps = 24, bricks = null }: any) {
  const bot = session.bot
  let dug = 0; let moved = 0; let why = null
  for (let s = 0; s < maxSteps; s++) {
    if (ctl.aborted) return { ok: false, dug, moved, why: 'прервано' }
    if (gameClock.now() > deadline) return { ok: false, dug, moved, why: 'время вышло' }
    const f = bot.entity.position.floored()
    const ddx = target.x - f.x; const ddz = target.z - f.z
    if (Math.abs(ddx) <= 1 && Math.abs(ddz) <= 1) return { ok: true, dug, moved }
    const axes = (Math.abs(ddx) >= Math.abs(ddz) ? [[Math.sign(ddx), 0], [0, Math.sign(ddz)]] : [[0, Math.sign(ddz)], [Math.sign(ddx), 0]]).filter(([x, z]) => x || z)
    let stepped = false
    for (const [sx, sz] of axes) {
      const r = await honestTunnelStep(session, ctl, f.offset(sx, 0, sz), { bricks, throughBricks: true })
      dug += r.dug || 0
      if (r.ok) { moved++; stepped = true; break }
      why = r.why
    }
    if (!stepped) return { ok: false, dug, moved, why: why || 'штрек не пошёл' }
  }
  return { ok: false, dug, moved, why: `за ${maxSteps} шагов не дошёл` }
}

// «Пирог» по вертикали: игрок наклоняет камеру и смотрит, при каком наклоне в доле blockentities есть спавнер (как pieArcs по
// горизонтали, шаг 2°, поле 20°). Наружу — только угол возвышения (центр дуги) → высота по известной горизонтальной дальности
// (оценка пеленгами). null — спавнера в прорисовке нет. { pitch, y } (y — оценка высоты спавнера).
function pieElevation (bot, flat, { range = 64, fov = 20, step = 2 }: any = {}) {
  const e = bot._ndEyes || new eyes.Eyes(bot)
  e.syncDim()
  const read = eyes.reader(bot)
  const p = bot.entity.position
  const o = { x: p.x, y: p.y + 1.62, z: p.z }
  const angles = []
  for (const sc of e.sectionsNear(read, o, range)) {
    const ent = e.section(read, sc.cx, sc.cz, sc.sy)
    if (!ent) continue
    for (const c of ent.cells) {
      if (!c.pie || c.name !== 'spawner') continue
      const dx = c.x + 0.5 - o.x; const dy = c.y + 0.5 - o.y; const dz = c.z + 0.5 - o.z
      if (dx * dx + dy * dy + dz * dz > range * range) continue
      angles.push(Math.atan2(dy, Math.hypot(dx, dz)) * 180 / Math.PI)
    }
  }
  if (!angles.length) return null
  // Дуга наклонов, где сектор fov захватывает спавнер (как у людей: «появился — пропал»), центр — середина дуги.
  const on = []
  for (let a = -90; a <= 90; a += step) if (angles.some(x => Math.abs(x - a) <= fov / 2)) on.push(a)
  const pitch = (on[0] + on[on.length - 1]) / 2
  return { pitch, y: Math.round(o.y + Math.tan(pitch * Math.PI / 180) * flat) }
}

// Ступень вверх в сторону cell (ровно на блок): над головой, голова и ноги ступени — копать видимое, пол ступени — сама клетка
// cell (твёрдая) и прыжок. Жидкость — как у штрека. { ok, dug, why }.
async function upStep (session, ctl, cell, { bricks = null }: any = {}) {
  const bot = session.bot
  const F = bot.entity.position.floored()
  let dug = 0
  for (const c of [F.offset(0, 2, 0), cell.offset(0, 2, 0), cell.offset(0, 1, 0)]) {
    const b = seen(bot, c)
    if (!b) return { ok: false, dug, why: 'забой не виден' }
    if (b.name === 'lava') return { ok: false, dug, why: 'лава' }
    if (b.boundingBox === 'empty') continue
    if (ROOM.test(b.name) || bricks?.test(b.name) || b.name === 'bedrock' || (/^infested_/.test(b.name) && (bot.health ?? 20) < 12)) return { ok: false, dug, why: `${b.name} в забое` }
    const r = await digCell(bot, session.mcData, c)
    if (!r.ok) return { ok: false, dug, why: r.why }
    dug++
  }
  const fl = seen(bot, cell)
  if (!fl) return { ok: false, dug, why: 'опора ступени не видна' }
  if (!fl || fl.boundingBox !== 'block') {
    // Ступени нет (воздух) — поставить её, если есть к чему прислонить.
    if (!(await placeAt(bot, cell))) return { ok: false, dug, why: 'ступень не встала' }
  }
  const t0 = gameClock.now()
  try {
    while (!ctl.aborted && gameClock.now() - t0 < 2000) {
      const f = bot.entity.position.floored()
      if (f.x === cell.x && f.z === cell.z && f.y === cell.y + 1) break
      await bot.lookAt(new Vec3(cell.x + 0.5, cell.y + 2.6, cell.z + 0.5), true).catch(() => {})
      bot.setControlState('forward', true)
      bot.setControlState('jump', true)
      await sleep(50)
    }
  } finally { try { bot.setControlState('forward', false); bot.setControlState('jump', false) } catch {} }
  const f = bot.entity.position.floored()
  return f.x === cell.x && f.z === cell.z && f.y === cell.y + 1 ? { ok: true, dug } : { ok: false, dug, why: 'не поднялся на ступень' }
}

// К высоте ty (оценка «пирога» по вертикали): ступенями вверх/вниз по спирали 2×2 у места, пока |y − ty| > 1.
async function toLevel (session, ctl, ty, { deadline, bricks = null, maxSteps = 12 }: any) {
  const bot = session.bot
  let k = 0; let moved = 0; let dug = 0; let why = null
  for (let s = 0; s < maxSteps && !ctl.aborted && gameClock.now() < deadline; s++) {
    const F = bot.entity.position.floored()
    if (Math.abs(F.y - ty) <= 1) return { ok: true, moved, dug }
    if (F.y > ty) {
      const r = await stairStep(session, ctl, k, { bricks, throughBricks: true })
      dug += r.dug
      if (r.found && r.room) return { ok: true, moved, dug, room: true }
      if (!r.moved) { why = r.why; break }
      k = r.k; moved++
    } else {
      let up = false
      for (let t = 0; t < 4 && !up; t++) {
        const d = SPIRAL[(k + t) % 4]
        const r = await upStep(session, ctl, F.offset(d[0], 0, d[1]))
        dug += r.dug
        if (r.ok) { up = true; k = (k + t + 1) % 4 } else why = r.why
      }
      if (!up) break
      moved++
    }
  }
  return { ok: Math.abs(bot.entity.position.floored().y - ty) <= 1, moved, dug, why }
}

module.exports = { honestShaft, honestEnter, honestTunnelStep, honestBore, stairStep, judgeStep, visibleDrop, seen, SPIRAL, pieElevation, upStep, toLevel, digCell, placeAt, walkInto, waterSource }
export {
  honestShaft, honestEnter, honestTunnelStep, honestBore, stairStep, judgeStep, visibleDrop, seen, SPIRAL,
  pieElevation, upStep, toLevel, digCell, placeAt, walkInto, waterSource
}
