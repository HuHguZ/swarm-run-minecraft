'use strict'
const gameClock: typeof import('./game-clock') = require('./game-clock')
// Крепость из блоков — «кошки-мышки» из PvP-роликов: закрыться в своей
// клетке (стены по 2 блока с 4 сторон и крыша), отлечиться, латать дыры,
// которые выламывает противник, выйти с нужной стороны. И обратное — осада:
// противник закрылся — подойти и выломать блок у его головы киркой, бить
// через дыру.
//
// Геометрия. Клетка — блок, где ноги. Стены — 4 соседние клетки на уровне ног
// и головы. Крыше (над головой, y+2) опереться не на что: соседи на y+2 —
// воздух, стены кончаются на y+1. Поэтому в тылу ставится третий блок (y+2),
// и крыша упирается в его бок: 10 блоков. Выломать стену булыжника рукой —
// 10 с на блок (твёрдость 2 без инструмента), железной киркой — 0.5 с, так
// что закрываться булыжником можно только с киркой, иначе это ловушка для
// себя; землю (0.5) руками — ~0.75 с.

const Vec3: typeof import('vec3').Vec3 = require('vec3')
const { placeBlockAt, pickFiller, withTimeout, FACES, occupiedByEntity }: typeof import('./build') = require('./build')
const { sleep }: typeof import('./movement') = require('./movement')
const tools: typeof import('./tools') = require('./tools')

const SIDES = [new Vec3(1, 0, 0), new Vec3(-1, 0, 0), new Vec3(0, 0, 1), new Vec3(0, 0, -1)]
const PICKS = ['netherite_pickaxe', 'diamond_pickaxe', 'iron_pickaxe', 'stone_pickaxe', 'golden_pickaxe', 'wooden_pickaxe']
const SOFT = /^(dirt|coarse_dirt|grass_block|sand|red_sand|gravel|clay|snow_block|soul_sand|soul_soil|mud)$/
// Крепость против кирки (2026-09-26, пользователь: «крепость бессмысленна, он
// её всё равно пробивает — надо, чтобы сопернику пришлось ломать киркой»).
// Удар сквозь блок закрыт (pick.js), и коробку теперь вскрывают: булыжник
// алмазной киркой ~0.4 с, обсидиан 9.4 с (с «Эффективностью V» 2.2 с). Есть
// обсидиан — лицо, бока и крыша из него; тыл (свой выход) и опора крыши — из
// обычного: самим выходить быстро, а ему — обходить к тылу под нашим взглядом.
const HARD = ['obsidian', 'crying_obsidian']

// Клетка ног: y стоящего на блоке бывает 149.99999… — floored() дал бы
// клетку под полом, и коробка строилась бы не там, а «место» не находилось.
function feetCell (bot) {
  const p = bot.entity.position
  return new Vec3(Math.floor(p.x), Math.floor(p.y + 1e-3), Math.floor(p.z))
}

function solidAt (bot, p) {
  const b = bot.blockAt(p)
  return !!b && b.boundingBox === 'block'
}

function countItem (bot, name) {
  return bot.inventory.items().filter(i => i.name === name).reduce((n, i) => n + i.count, 0)
}

function hardFiller (bot) {
  for (const n of HARD) {
    const it = bot.inventory.items().find(i => i.name === n)
    if (it) return it
  }
  return null
}

// Из чего каждая клетка плана (boxPlan): 0..5 — лицо и бока (ноги, голова),
// 6..7 — тыл, 8 — опора крыши, 9 — крыша. null — обычный наполнитель.
function boxMaterials (bot, plan) {
  const hard = hardFiller(bot)
  let left = hard ? countItem(bot, hard.name) : 0
  return plan.map((p, i) => {
    if ((i < 6 || i === 9) && left > 0) { left--; return hard.name }
    return null
  })
}

function pickaxeOf (bot) {
  const items = bot.inventory.items()
  for (const n of PICKS) {
    const it = items.find(i => i.name === n)
    if (it) return it
  }
  return null
}

// Сможем ли выйти из своей коробки: стену из filler ломаем быстрее 2 с тем,
// что есть (tools.bestFor — время по правилам игры). Булыжник без кирки — 10 с
// на блок: это ловушка для себя.
function canBreakOut (bot, filler) {
  if (!filler) return false
  const block = bot.registry.blocksByName[filler.name]
  if (!block) return !!pickaxeOf(bot) || SOFT.test(filler.name)
  try {
    const Block = (require('prismarine-block') as typeof import('prismarine-block'))(bot.registry)
    const b = new Block(block.id, 0, 0)
    // 3.5 с: доски и брёвна рукой — 3 с на блок (выход — 2 блока, 6 с, когда снаружи уже тихо); булыжник рукой —
    // 10 с, ловушка для себя.
    return tools.bestFor(bot, b).ms <= 3500
  } catch {
    return !!pickaxeOf(bot) || SOFT.test(filler.name)
  }
}

// Оценка и стройка используют один материал: булыжник без кирки не отменяет землю в рюкзаке.
function refugeFiller (bot, needed = 10) {
  const filler = pickFiller(bot, { steady: true })
  if ((require('./worlds') as typeof import('./worlds')).worldOf(bot) !== 'overworld' || !filler || canBreakOut(bot, filler)) return filler
  return bot.inventory.items().find(i => i.count >= needed &&
    /^(dirt|coarse_dirt|grass_block|clay|snow_block)$|_planks$/.test(i.name) && canBreakOut(bot, i)) || filler
}

// Насколько закрыта клетка cell (ноги): сколько сторон заложены целиком (ноги
// и голова), есть ли крыша, какие стороны открыты и чем.
function enclosure (bot, cell) {
  let walls = 0
  const open = []
  for (const s of SIDES) {
    const side = cell.plus(s)
    const feet = solidAt(bot, side)
    const head = solidAt(bot, side.offset(0, 1, 0))
    if (feet && head) walls++
    else open.push({ side: s, feet: !feet, head: !head })
  }
  const roof = solidAt(bot, cell.offset(0, 2, 0))
  return { walls, roof, open, sealed: walls === 4 && roof }
}

// Встать в центр своей клетки: хитбокс 0.6 шириной, и если стоять у края,
// он залезает в соседнюю клетку — туда блок не поставить.
async function centerInCell (bot, ms = 700, at = null, ctl = null) {
  const cell = at || feetCell(bot)
  const c = { x: cell.x + 0.5, z: cell.z + 0.5 }
  const t0 = gameClock.now()
  try {
    while (gameClock.now() - t0 < ms && !ctl?.aborted) {
      const p = bot.entity.position
      const dx = c.x - p.x
      const dz = c.z - p.z
      if (Math.hypot(dx, dz) < 0.1) break
      await bot.look(Math.atan2(-dx, -dz), 0, true).catch(() => {})
      if (ctl?.aborted) break
      bot.setControlState('sneak', true)
      bot.setControlState('forward', Math.hypot(dx, dz) > 0.06)
      await sleep(50)
    }
  } finally {
    if (!ctl?.aborted) { bot.setControlState('forward', false); bot.setControlState('sneak', false) }
  }
  if (!ctl?.aborted) await sleep(100)
  const p = bot.entity.position
  return Math.hypot(c.x - p.x, c.z - p.z) < 0.2
}

// Что ставить для коробки: стены по сторонам — сначала к врагу (оттуда бьют),
// потом бока, тыл последним; на тылу — опора крыше и крыша.
function boxPlan (cell, toward, roof) {
  const score = s => toward ? s.x * (toward.x - cell.x - 0.5) + s.z * (toward.z - cell.z - 0.5) : 0
  const sides = SIDES.slice().sort((a, b) => score(b) - score(a))
  const plan = []
  for (const s of sides) plan.push(cell.plus(s), cell.plus(s).offset(0, 1, 0))
  if (roof) {
    const back = sides[sides.length - 1]
    plan.push(cell.plus(back).offset(0, 2, 0), cell.offset(0, 2, 0))
  }
  return plan
}

function boxCheck (bot, { cell = feetCell(bot), toward = null, roof = true, material = null }: any = {}) {
  const need = refugeNeed(bot, cell), plan = boxPlan(cell, toward, roof)
  if (!need) return { ok: false, why: 'клетка не закрывается целыми стенами', plan, blocks: Infinity, ms: Infinity }
  const pick: typeof import('./pick') = require('./pick'), predicted = new Map(), center = cell.offset(.5, 0, .5)
  const entities = Object.fromEntries((Object.values(bot.entities || {}) as any[]).filter(e => e && e !== bot.entity && (require('./pvp/last-seen') as typeof import('./pvp/last-seen')).seesPlayer(bot, e)).map(e => [e.id, e]))
  const view = { ...bot, entity: { ...bot.entity, position: center }, entities, blockAt: p => predicted.get(p.toString()) || bot.blockAt(p) }
  let blocks = 0
  for (let i = 0; i < plan.length; i++) {
    const p = plan[i]
    if (fullCube(view.blockAt(p)) || roof && i === plan.length - 2 && need.roofSolid) continue
    const occupied = occupiedByEntity(view, p)
    if (occupied) return { ok: false, why: `в клетке стоит ${occupied}`, plan, blocks, ms: Infinity }
    if (!openCell(view.blockAt(p))) return { ok: false, why: 'клетка стены занята', plan, blocks, ms: Infinity }
    let eye = pick.eyeOf(view)
    if (roof && i === plan.length - 2) {
      const lift = (require('./navigation/geometry') as typeof import('./navigation/geometry')).verticalLift(view, center, 1)
      eye = eye.offset(0, lift || 0, 0)
    }
    if (!FACES.some(face => pick.faceAim(view, p.minus(face), face, { eye }))) return { ok: false, why: 'нет видимой опоры стены или крыши', plan, blocks, ms: Infinity }
    predicted.set(p.toString(), { name: 'dirt', boundingBox: 'block', position: p, shapes: [[0, 0, 0, 1, 1, 1]] }); blocks++
  }
  // Строят выбранным материалом (коробка кемпера) — его запас и считать (Codex 15.10: земля ×10 + булыжник — «не хватит»).
  const filler = material ? { name: material } : pickFiller(bot, { steady: true })
  const have = bot.inventory.items().filter(i => i.name === filler?.name || !material && HARD.includes(i.name)).reduce((n, i) => n + i.count, 0)
  if (have < blocks) return { ok: false, why: 'не хватит блоков закрыть все стены и крышу', plan, blocks, ms: Infinity }
  return { ok: true, plan, blocks, ms: refugeBuildMs({ ...need, blocks }) }
}

// Every cell must have an honest construction route before the body puts its weapon away.
async function boxIn (bot, { toward = null, roof = true, ctl = null, timeoutMs = 700, hard = true, abortIf = null, material = null }: any = {}) {
  const cell = feetCell(bot), check = boxCheck(bot, { cell, toward, roof, material }), plan = check.plan
  const mats = material ? plan.map(() => material) : hard ? boxMaterials(bot, plan) : plan.map(() => null)
  let placed = 0
  const failed = []
  let why = check.ok ? null : check.why, wake
  const interrupted = new Promise(resolve => { wake = resolve })
  const local = { get aborted () { return !!why || !!ctl?.aborted } }
  const stop = reason => { if (why) return; why = reason; try { bot.clearControlStates() } catch {}; wake() }
  const guard = () => { if (ctl?.aborted) stop('прервано'); else { const reason = abortIf?.(Math.max(0, check.ms - placed * 180)); if (reason) stop(reason) } }
  let hp = bot.health
  const health = () => { if (bot.health < hp) stop('по мне попали во время стройки'); hp = bot.health }
  const cancel = () => stop('прервано')
  if (check.ok) {
    bot.on('physicsTick', guard); bot.on('health', health); ctl?.onAbort?.push(cancel)
    try {
      guard()
      await Promise.race([(async () => {
        if (local.aborted) return
        await centerInCell(bot, 700, cell, local)
        for (let i = 0; i < plan.length && !local.aborted; i++) {
          const p = plan[i]
          if (roof && i === plan.length - 2 && solidAt(bot, cell.offset(0, 2, 0))) continue
          try {
            guard(); if (local.aborted) break
            const item = mats[i] && countItem(bot, mats[i]) > 0 ? mats[i] : null
            const r = roof && i === plan.length - 2 && !solidAt(bot, p)
              ? await jumpPlace(bot, p, { ctl: local, timeoutMs, item })
              : await placeBlockAt(bot, p, { timeoutMs, item, honest: true, steady: true, ctl: local })
            if (local.aborted) break
            if (r.ok && !r.already) placed++
            else if (!r.ok) {
              // sr27 full: где именно отказал сервер (клетка плана, смещение тела в клетке, пол) — 520+ безымянных отказов.
              const b = bot.entity.position, under = bot.blockAt(b.offset(0, -0.2, 0))?.name
              failed.push(`${r.reason} [клетка ${p.x - cell.x},${p.y - cell.y},${p.z - cell.z}; тело ${(b.x - cell.x - .5).toFixed(2)},${(b.y - cell.y).toFixed(2)},${(b.z - cell.z - .5).toFixed(2)}; пол ${under}]`)
              why = r.reason; break
            }
          } catch (e) { failed.push(e.message); why = e.message; break }
        }
      })(), interrupted])
    } finally {
      bot.removeListener('physicsTick', guard); bot.removeListener('health', health)
      const index = ctl?.onAbort?.indexOf(cancel); if (index >= 0) ctl.onAbort.splice(index, 1)
      try { bot.clearControlStates() } catch {}
    }
  }
  const hardN = mats.filter(Boolean).length
  return { placed, cell, plan, mats, hard: hardN ? mats.find(Boolean) : null, hardN, aborted: !!why || !!ctl?.aborted, why, failed: failed.length ? failed : undefined, ...enclosure(bot, cell) }
}

// Залатать то, что выломали: пройти по плану коробки и поставить недостающее.
// В клетке стоит он — туда не ставим (сервер откажет), это дыра для удара.
async function patch (bot, plan, { timeoutMs = 600, mats = null, ctl = null }: any = {}) {
  let placed = 0
  for (let i = 0; i < plan.length; i++) {
    if (ctl?.aborted) break
    const p = plan[i]
    if (solidAt(bot, p)) continue
    try {
      const want = mats && mats[i]
      const item = want && countItem(bot, want) > 0 ? want : null
      const r = await placeBlockAt(bot, p, { timeoutMs, item, honest: true, steady: true, ctl })
      if (r.ok && !r.already) placed++
      else if (!r.ok) break
    } catch { break }
  }
  return placed
}

// ------------------------------------------------------------ аварийная коробка
//
// Аварийный отход вне боя (survival.refuge, research/05-synthesis.md F.5):
// коробка «у стены». Логика клетки — копия cellOk/fortSpot из pvp.js (pvp.js
// не меняется, бой проверен на арене), с одним отличием по смыслу: в бою
// стены вокруг мешали (коробка строилась с дырами у паутины и чужих блоков),
// а при отходе целый блок рядом — это уже готовая стена. Прижаться к стене,
// встать в угол или в тупик хода — меньше блоков, быстрее стройка, меньше
// сторон, откуда бьют. Клетка, где над головой на y+2 порода, закрыта сверху
// сама; клетка под навесом или у стены в 3 блока — крыше есть на что опереться
// без подпорки.
//
// Честная установка (правило пользователя, pick.js): блок ставится только в
// грань, которую видит прицел клиента. Изнутри клетки глаза на 1.62, и верх
// стены на уровне головы (плоскость y+2) снизу не виден: подпорку крыши игрок
// ставит в прыжке (на вершине прыжка глаза ~2.9), и бот тоже (jumpPlace).
// Сама крыша потом ставится в бок подпорки — он смотрит в клетку и виден.

const LIQUID = /water|lava|bubble_column/
// В клетку тела, на пол или в стену — нельзя: жжёт, держит или падает.
const REFUGE_BAD = /^(lava|fire|soul_fire|magma_block|campfire|soul_campfire|cactus|sweet_berry_bush|wither_rose|powder_snow|cobweb|pointed_dripstone|scaffolding)$/
const UP = new Vec3(0, 1, 0)

// Целый куб: плита, забор, ступенька, дверь — не стена (зомби встаёт на
// плиту и бьёт через неё). Без формы (заглушки тестов) — по boundingBox.
function fullCube (b) {
  if (!b || b.boundingBox !== 'block' || LIQUID.test(b.name) || REFUGE_BAD.test(b.name)) return false
  const s = b.shapes
  if (!Array.isArray(s) || !s.length) return true
  return s.length === 1 && s[0][0] <= 0 && s[0][1] <= 0 && s[0][2] <= 0 && s[0][3] >= 1 && s[0][4] >= 1 && s[0][5] >= 1
}
// Клетка, куда можно встать или поставить блок: пусто, не жидкость, не жжёт.
function openCell (b) {
  return !!b && b.boundingBox === 'empty' && !LIQUID.test(b.name) && !REFUGE_BAD.test(b.name)
}

// Есть ли нижнему блоку стены (клетка c+s) на что опереться гранью, видной из глаз: пол под ним (верх), целый блок
// дальше по стороне или сбоку (их грани к клетке стены). Низ блока над ней из глаз не виден. Наша клетка c — пустая.
function wallLeans (bot, c, s) {
  const w = c.plus(s)
  if (fullCube(bot.blockAt(w.offset(0, -1, 0)))) return true
  if (fullCube(bot.blockAt(w.plus(s)))) return true
  const perp = s.x !== 0 ? [new Vec3(0, 0, 1), new Vec3(0, 0, -1)] : [new Vec3(1, 0, 0), new Vec3(-1, 0, 0)]
  return perp.some(p => fullCube(bot.blockAt(w.plus(p))))
}

// Годится ли клетка c под коробку и сколько блоков на неё уйдёт.
// null — не годится: пола нет, тело не встанет, рядом полублок или жидкость.
function refugeNeed (bot, c) {
  const floor = bot.blockAt(c.offset(0, -1, 0))
  if (!fullCube(floor)) return null
  for (const y of [0, 1]) if (!openCell(bot.blockAt(c.offset(0, y, 0)))) return null
  const top = bot.blockAt(c.offset(0, 2, 0))
  if (!top) return null
  const roofSolid = fullCube(top)
  if (!roofSolid && !openCell(top)) return null
  let walls = 0
  let wallBlocks = 0
  for (const s of SIDES) {
    let whole = true
    for (const y of [0, 1]) {
      const b = bot.blockAt(c.plus(s).offset(0, y, 0))
      if (fullCube(b)) continue
      if (!openCell(b)) return null
      // Нижнему блоку стены нужна опора: пол под ним или целый сосед (не наша клетка). Клетка у обрыва (пещера,
      // уступ) — стену «не к чему прислонить» (base1 02.10 слот 17: коробка 1/4 у края, бегство, смерть).
      if (y === 0 && !wallLeans(bot, c, s)) return null
      whole = false
      wallBlocks++
    }
    if (whole) walls++
  }
  // Крыше есть на что опереться без подпорки: целый блок сбоку на y+2 или
  // над ней на y+3 (грани смотрят в клетку и видны снизу).
  const leans = !roofSolid && (SIDES.some(s => fullCube(bot.blockAt(c.plus(s).offset(0, 2, 0)))) ||
    fullCube(bot.blockAt(c.offset(0, 3, 0))))
  const roofBlocks = roofSolid ? 0 : leans ? 1 : 2
  return { walls, wallBlocks, roofSolid, leans, blocks: wallBlocks + roofBlocks }
}

// Сколько стоит стройка по времени: центровка ~0.3 с, блок ~0.18 с (pvp.js
// BOX_MS 2500 на 10 блоков с центровкой), подпорка в прыжке ~0.45 с.
function refugeBuildMs (need) {
  if (!need) return Infinity
  return 300 + need.blocks * 180 + (!need.roofSolid && !need.leans ? 270 : 0)
}

// Клетка под коробку рядом с телом (копия fortSpot, pvp.js:1439): здесь, если
// годится, иначе ближняя в радиусе. awayFrom — от кого отходим: клетки к нему
// дороже. have — сколько блоков в рюкзаке: клетка, которой не хватит, не в
// счёт. foes — сущности: клетка, у стены которой стоит моб, не закроется
// (в его клетку блок не поставить).
function refugeCell (bot, awayFrom = null, { radius = 4, have = Infinity, foes = [] }: any = {}) {
  const here = feetCell(bot)
  let away = null
  if (awayFrom) {
    const ax = bot.entity.position.x - awayFrom.x
    const az = bot.entity.position.z - awayFrom.z
    const n = Math.hypot(ax, az)
    if (n > 1e-3) away = { x: ax / n, z: az / n }
  }
  const crowded = (c) => foes.some(e => e && e.position && Math.abs(e.position.y - c.y) < 2 &&
    Math.hypot(e.position.x - (c.x + 0.5), e.position.z - (c.z + 0.5)) < 1.6)
  let best = null
  for (let dx = -radius; dx <= radius; dx++) {
    for (let dz = -radius; dz <= radius; dz++) {
      const dist = Math.hypot(dx, dz)
      if (dist > radius + 0.01) continue
      for (const dy of [0, -1, 1]) {
        const c = here.offset(dx, dy, dz)
        const need = refugeNeed(bot, c)
        if (!need || need.blocks > have) continue
        // Время: дойти (4.3 бл/с шагом, tempo WALK_BPT) и построить.
        let cost = dist / 4.3 + Math.abs(dy) * 0.3 + refugeBuildMs(need) / 1000
        // Навстречу ему — хуже, от него — чуть лучше (как fortSpot: toward×0.6).
        if (away && dist > 0) cost -= ((dx * away.x + dz * away.z) / dist) * dist * 0.15
        if (crowded(c)) cost += 3
        if (!best || cost < best.cost) best = { cell: c, dist: Math.round(dist * 10) / 10, cost: Math.round(cost * 100) / 100, ...need }
      }
    }
  }
  return best
}

// Что ставить: стены по сторонам, лицом к нему первым (boxPlan), тыл
// последним; подпорка крыши на тылу (если опереться не на что) и крыша.
function refugePlan (bot, cell, toward = null) {
  const score = s => toward ? s.x * (toward.x - cell.x - 0.5) + s.z * (toward.z - cell.z - 0.5) : 0
  const sides = SIDES.slice().sort((a, b) => score(b) - score(a))
  const plan = []
  for (const s of sides) {
    for (const y of [0, 1]) {
      const p = cell.plus(s).offset(0, y, 0)
      if (!fullCube(bot.blockAt(p))) plan.push({ pos: p, kind: 'wall' })
    }
  }
  const need = refugeNeed(bot, cell)
  if (need && !need.roofSolid) {
    if (!need.leans) {
      // Подпорка — на той стене, которая уже стоит или встанет раньше крыши:
      // сперва целые стены (своя порода), иначе тыл.
      const natural = sides.find(s => fullCube(bot.blockAt(cell.plus(s).offset(0, 1, 0))))
      const back = natural || sides[sides.length - 1]
      plan.push({ pos: cell.plus(back).offset(0, 2, 0), kind: 'support' })
    }
    plan.push({ pos: cell.offset(0, 2, 0), kind: 'roof' })
  }
  return plan
}

// Подпорка в прыжке: верх стены (плоскость y+2) виден, только когда глаза
// выше неё. Прыжок — и на подъёме, как только прицел (faceAim) берёт верхнюю
// грань, — установка в неё. Возвращает как placeBlockAt: { ok, reason }.
async function jumpPlace (bot, pos, { ctl = null, timeoutMs = 900, item = null }: any = {}) {
  const { waitForBlock }: typeof import('./build') = require('./build')
  const { faceAim }: typeof import('./pick') = require('./pick')
  if (ctl?.aborted) return { ok: false, reason: 'прервано' }
  if (solidAt(bot, pos)) return { ok: true, already: bot.blockAt(pos).name }
  const ref = bot.blockAt(pos.offset(0, -1, 0))
  if (!ref || ref.boundingBox !== 'block') return { ok: false, reason: 'под подпоркой нет блока' }
  const stack = item ? bot.inventory.items().find(i => i.name === item) : pickFiller(bot, { steady: true })
  if (!stack) return { ok: false, reason: 'нечем строить' }
  try { if (!bot.heldItem || bot.heldItem.type !== stack.type) await withTimeout(bot.equip(stack, 'hand'), 2000) } catch (e) { return { ok: false, reason: e.message } }
  if (ctl?.aborted) return { ok: false, reason: 'прервано' }
  if (!bot.entity.onGround) { for (let i = 0; i < 10 && !bot.entity.onGround && !ctl?.aborted; i++) await sleep(50) }
  if (ctl?.aborted) return { ok: false, reason: 'прервано' }
  let point = null
  try {
    bot.setControlState('jump', true)
    for (let t = 0; t < 16 && !point && !(ctl && ctl.aborted); t++) {
      await sleep(25)
      if (t > 3) bot.setControlState('jump', false)
      point = faceAim(bot, ref.position, UP)
    }
  } finally { if (!ctl?.aborted) { try { bot.setControlState('jump', false) } catch {} } }
  if (ctl?.aborted) return { ok: false, reason: 'прервано' }
  if (!point) { await landed(bot); return { ok: false, reason: 'в прыжке верх стены так и не попал в прицел' } }
  try {
    await bot.lookAt(point, true)
    if (ctl?.aborted) return { ok: false, reason: 'прервано' }
    await bot._genericPlace(ref, UP, { forceLook: 'ignore', swingArm: 'right', delta: point.minus(ref.position) })
  } catch (e) { await landed(bot); return { ok: false, reason: e.message } }
  const ok = await waitForBlock(bot, pos, timeoutMs)
  // Крыша — в клетку над головой: пока тело в прыжке, это «моя же клетка»
  // (build.isOurOwnSpace по floored), сервер откажет. Сперва приземлиться.
  await landed(bot)
  if (ok) return { ok: true, placed: bot.blockAt(pos).name, jump: true }
  return { ok: false, reason: 'сервер не поставил подпорку' }
}

// Дождаться, пока тело на полу (после прыжка, толчка) — до ms.
async function landed (bot, ms = 900) {
  const until = gameClock.now() + ms
  while (gameClock.now() < until && !bot.entity.onGround) await sleep(25)
  return !!bot.entity.onGround
}

// Ударить ближнего моба у клетки pos (честно — только если он в прицеле,
// pick.aim), чтобы отбросило. true — ударил.
const SHOVE_MOBS = /^(zombie|husk|drowned|zombie_villager|skeleton|stray|bogged|parched|spider|cave_spider|witch|piglin_brute|hoglin|zoglin|wither_skeleton|vindicator|pillager|silverfish|endermite|magma_cube|slime|creaking)$/
async function shove (bot, pos, r = 1.9) {
  const pick: typeof import('./pick') = require('./pick')
  const c = { x: pos.x + 0.5, z: pos.z + 0.5 }
  const e = (Object.values(bot.entities || {}) as any[])
    .filter((m : any) => m && m !== bot.entity && m.position && SHOVE_MOBS.test(m.name || '') && Math.abs(m.position.y - pos.y) < 2.5 &&
      Math.hypot(m.position.x - c.x, m.position.z - c.z) < r)
    .sort((a: any, b: any) => Math.hypot(a.position.x - c.x, a.position.z - c.z) - Math.hypot(b.position.x - c.x, b.position.z - c.z))[0]
  if (!e) return false
  const a = pick.aim(bot, e)
  if (!a || !a.point) return false
  try {
    const w = (require('./items') as typeof import('./items')).bestWeapon(bot)
    if (w && (!bot.heldItem || bot.heldItem.type !== w.type)) await withTimeout(bot.equip(w, 'hand'), 1500)
    await bot.lookAt(a.point, true)
    bot.attack(e)
  } catch { return false }
  await sleep(150) // отброс — пара тиков
  return true
}

// Отбросить ближнего моба, стоящего вплотную к телу (столб, коробка).
async function shoveNear (bot, r = 1.6) {
  return shove(bot, feetCell(bot), r)
}

// Рамка тела (полуширина 0.3) заходит в клетку pos.
function bodyIn (bot, pos) {
  const p = bot.entity.position
  return p.x + 0.3 > pos.x && p.x - 0.3 < pos.x + 1 && p.z + 0.3 > pos.z && p.z - 0.3 < pos.z + 1 &&
    p.y + 1.8 > pos.y && p.y < pos.y + 1
}

// Закрыться в клетке cell (тело уже в ней): план refugePlan, честная
// установка. Возвращает, сколько поставлено и что вышло (enclosure).
async function refugeBox (bot, cell, { toward = null, ctl = null, timeoutMs = 800, honest = true, budgetMs = 4500 }: any = {}) {
  const t0 = gameClock.now()
  await centerInCell(bot)
  // Тело сползло в соседнюю клетку (толчок, шаг по инерции) — строить вокруг той,
  // где стоит: иначе стена плана приходится на свою же клетку («это моя же
  // клетка», s7: 3 коробки из 12 с дырой).
  const here = feetCell(bot)
  if (!here.equals(cell) && refugeNeed(bot, here)) cell = here
  const plan = refugePlan(bot, cell, toward)
  const filler = refugeFiller(bot, plan.length)
  const item = filler?.name !== pickFiller(bot, { steady: true })?.name ? filler?.name : null
  let placed = 0
  const failed = []
  for (const step of plan) {
    if (ctl && ctl.aborted) break
    // Стройка затянулась (толкают, сервер молчит) — дальше по списку отхода, а
    // не стоять под ударами (J: коробка 9.8 с).
    if (gameClock.now() - t0 > budgetMs) { failed.push('стройка дольше ' + Math.round(budgetMs / 1000) + ' с'); break }
    if (solidAt(bot, step.pos)) continue
    try {
      const steady = step.kind !== 'wall'
      if (step.kind !== 'support') await landed(bot, 600)
      // Тело сползло к стене (толкнул зомби) — его рамка залезает в клетку
      // стены, и сервер молча не ставит («ответа от сервера нет»): в центр.
      // (at: cell — в центр СВОЕЙ клетки, даже если тело уже в соседней:
      // «это моя же клетка», E.)
      if (bodyIn(bot, step.pos)) await centerInCell(bot, 800, cell)
      let r = step.kind === 'support'
        ? await jumpPlace(bot, step.pos, { ctl, item })
        : await placeBlockAt(bot, step.pos, { timeoutMs, honest, steady, item, ctl })
      if (!r.ok && /ответа от сервера нет|моя же клетка/.test(r.reason || '') && !(ctl && ctl.aborted)) {
        await centerInCell(bot, 800, cell)
        r = await placeBlockAt(bot, step.pos, { timeoutMs, honest, steady, item, ctl })
      }
      // Моб вплотную у стены или крыши: стоит в её клетке или его рамка перекрыла прицел
      // (клиент в таком случае бьёт моба, а не ставит блок — «не к чему
      // прислонить», D: 5 столбов из 5 после такой коробки). Как игрок: ударить —
      // отбросит — и сразу блок в освободившуюся клетку.
      if (!r.ok && (step.kind === 'wall' || step.kind === 'roof' && refugeNeed(bot, cell)?.leans) && !(ctl && ctl.aborted) && /в клетке стоит|не к чему прислонить|ответа от сервера нет/.test(r.reason || '')) {
        if (await shove(bot, step.pos)) r = await placeBlockAt(bot, step.pos, { timeoutMs, honest, steady, item, ctl })
      }
      // Подпорка не встала в прыжке — ещё раз: первый прыжок бывает из
      // неотцентрованного тела или с зомби, толкнувшим в бок.
      if (step.kind === 'support' && !r.ok && !(ctl && ctl.aborted)) r = await jumpPlace(bot, step.pos, { ctl, item })
      if (r.ok && !r.already) placed++
      else if (!r.ok) failed.push(`${step.kind} ${step.pos.x - cell.x},${step.pos.y - cell.y},${step.pos.z - cell.z}: ${r.reason}${r.noFooting ? ` (тело ${bot.entity.position.x.toFixed(2)},${bot.entity.position.y.toFixed(2)},${bot.entity.position.z.toFixed(2)})` : ''}`)
    } catch (e) { failed.push(`${step.kind}: ${e.message}`) }
  }
  return { placed, cell, item, plan: plan.map(s => s.pos), kinds: plan.map(s => s.kind), failed: failed.length ? failed : undefined, ...enclosure(bot, cell) }
}

// Осесть на блок в своей коробке и закрыться крышкой на уровне головы: снизу
// её клетке есть опора — стены коробки на том же уровне (бок виден из глаз).
// Годится, если под ногами целый блок, под ним пол, а кольцо вокруг нижней
// клетки — порода (иначе внизу открыто). Возвращает новую клетку ног или null.
async function sinkRoof (bot, cell, { ctl = null, why = () => {} }: any = {}) {
  const no = w => { why(w); return null }
  const below = bot.blockAt(cell.offset(0, -1, 0))
  const floor = bot.blockAt(cell.offset(0, -2, 0))
  if (!fullCube(below) || below.name === 'bedrock') return no(`под ногами ${below ? below.name : '?'}`)
  if (!floor || floor.boundingBox !== 'block' || LIQUID.test(floor.name)) return no(`ниже ${floor ? floor.name : '?'}`)
  for (const s of SIDES) {
    const b = bot.blockAt(cell.plus(s).offset(0, -1, 0))
    if (!fullCube(b)) return no(`сбоку внизу ${b ? b.name : '?'}`)
  }
  await centerInCell(bot, 500, cell)
  if (!(await breakBlock(bot, cell.offset(0, -1, 0), { maxMs: 3000 }))) return no('блок под ногами не сломался')
  const low = cell.offset(0, -1, 0)
  for (let i = 0; i < 12 && !feetCell(bot).equals(low); i++) { await centerInCell(bot, 200, cell); await sleep(50) }
  await landed(bot, 800)
  if (!feetCell(bot).equals(low)) return no(`не осел: ноги ${bot.entity.position.y.toFixed(2)}`)
  if (ctl && ctl.aborted) return null
  const r = await placeBlockAt(bot, cell.offset(0, 1, 0), { timeoutMs: 800, honest: true, steady: true })
  return r.ok ? low : no(`крышка: ${r.reason}`)
}

// Латать аварийную коробку: стены и крыша честно, подпорка — в прыжке.
async function refugePatch (bot, box, { ctl = null, timeoutMs = 700 }: any = {}) {
  let placed = 0
  for (let i = 0; i < box.plan.length; i++) {
    if (ctl && ctl.aborted) break
    const p = box.plan[i]
    if (solidAt(bot, p)) continue
    const kind = box.kinds ? box.kinds[i] : 'wall'
    // Подпорка нужна только ради крыши: крыша цела — не прыгать.
    if (kind === 'support' && solidAt(bot, box.cell.offset(0, 2, 0))) continue
    try {
      if (kind !== 'support') await landed(bot, 600)
      const r = kind === 'support'
        ? await jumpPlace(bot, p, { ctl, item: box.item })
        : await placeBlockAt(bot, p, { timeoutMs, honest: true, steady: kind !== 'wall', item: box.item, ctl })
      if (r.ok && !r.already) placed++
    } catch {}
  }
  return placed
}

// Выломать блок (киркой, если есть). Возвращает, получилось ли.
// Самым быстрым инструментом (tools.js): земля — лопатой, дерево — топором,
// камень — киркой, паутина — мечом или ножницами.
async function breakBlock (bot, pos, { maxMs = 8000 }: any = {}) {
  const r = await tools.breakFast(bot, pos, { maxMs })
  return r.ok
}

// Выйти: выломать стену с выбранной стороны (голова, потом ноги). away — от
// кого уходим (выходим с противоположной стороны), toward — на кого выскочить
// (сбоку от него: в лоб он ждёт у дыры).
async function breakOut (bot, cell, { away = null, toward = null }: any = {}, { onHole = null }: any = {}) {
  const c = { x: cell.x + 0.5, z: cell.z + 0.5 }
  let best = null
  for (const s of SIDES) {
    // Пролом своей стены перед следующей стеной/лавой не выпускает тело.
    // Проверяем клетку за стеной до копки: воздух для ног и головы, опора.
    const outside = cell.plus(s.scaled(2))
    if (!(require('./walkable') as typeof import('./walkable')).standable(bot, outside)) continue
    let sc = 0
    if (away) {
      const ax = away.x - c.x; const az = away.z - c.z
      sc -= (s.x * ax + s.z * az) / (Math.hypot(ax, az) || 1)
    }
    // Своя стена из обсидиана — 9 с киркой: выходить там, где ломается
    // быстро (тыл коробки из обычного блока), секунда ломки — очко.
    let digMs = 0
    for (const w of [cell.plus(s), cell.plus(s).offset(0, 1, 0)]) {
      if (solidAt(bot, w)) digMs += Math.min(20000, tools.bestFor(bot, bot.blockAt(w)).ms)
    }
    sc -= digMs / 1000
    if (toward) {
      const tx = toward.x - c.x; const tz = toward.z - c.z
      const n = Math.hypot(tx, tz) || 1
      const dot = (s.x * tx + s.z * tz) / n
      // Лучше всего — сбоку от него (dot около 0.5), хуже всего — прямо в лоб
      // или спиной.
      sc += 1 - Math.abs(dot - 0.5)
    }
    // Снаружи должно быть куда встать.
    const out = cell.plus(s).plus(s)
    if (!solidAt(bot, out.offset(0, -1, 0)) && !solidAt(bot, cell.plus(s).offset(0, -1, 0))) sc -= 5
    if (!best || sc > best.sc) best = { s, sc }
  }
  // Запасной выход: за стеной обрыв или край помоста — выйти хотя бы в сам
  // пролом, если под ним твёрдо и вокруг нет лавы. 2026-09-29 14:25 коробка
  // у края зала «без безопасного прохода»: бой брошен, тело заперто рядом с
  // ифритами и погибло, выбираясь другим путём.
  let near = false
  if (!best) {
    const lavaAt = p => { const b = bot.blockAt(p); return !!b && /lava/.test(b.name) }
    const open = p => { const b = bot.blockAt(p); return !!b && b.boundingBox === 'empty' && !/lava|fire/.test(b.name) }
    for (const s of SIDES) {
      const mid = cell.plus(s)
      // За проломом — воздух (обрыв можно), не следующая стена: иначе тело
      // останется запертым в кармане пролома.
      const out2 = cell.plus(s.scaled(2))
      if (!open(out2) || !open(out2.offset(0, 1, 0))) continue
      const under = bot.blockAt(mid.offset(0, -1, 0))
      if (!under || under.boundingBox !== 'block' || /magma/.test(under.name)) continue
      if ([mid, mid.offset(0, 1, 0), mid.offset(0, -1, 0)].some(p => SIDES.some(t => lavaAt(p.plus(t))) || lavaAt(p.offset(0, 1, 0)))) continue
      let sc = 0
      if (toward) {
        const tx = toward.x - c.x; const tz = toward.z - c.z
        sc += 1 - Math.abs((s.x * tx + s.z * tz) / (Math.hypot(tx, tz) || 1) - 0.5)
      }
      if (!best || sc > best.sc) best = { s, sc }
    }
    near = !!best
  }
  if (!best) return { ok: false, steps: ['за стенами нет безопасного прохода'] }
  const side = best.s
  const head = cell.plus(side).offset(0, 1, 0)
  const feet = cell.plus(side)
  const steps = []
  const headOk = await breakBlock(bot, head)
  steps.push(`голова ${headOk ? 'выломана' : 'не далась'}`)
  // Дыра в голове открыта — если он прямо за ней, onHole бьёт его (до трёх
  // ударов), и только потом доламываем ноги.
  if (headOk && onHole) {
    for (let i = 0; i < 3; i++) { if (!(await onHole())) break; steps.push('удар в дыру') }
  }
  const feetOk = headOk && (await breakBlock(bot, feet))
  if (headOk) steps.push(`ноги ${feetOk ? 'выломаны' : 'не дались'}`)
  if (near) steps.push('выход в пролом: за стеной опоры нет')
  return { ok: headOk && feetOk, side, exit: feet, outside: near ? feet : cell.plus(side.scaled(2)), steps }
}

// Запертая клетка (своя коробка тактики BlockOff, refuge stayIn, нора с крышей): путь без копки (goto strict, explore
// поверху) из неё не находится — goto отказывали 43 мин (cl-a 14.10), explore «пути нет ни в одну из 8 сторон» 22 мин
// (cl-j 14.10). Как игрок: выломать стену в сторону цели; не вышло (нора в породе) — наверх, как shelter exit.
async function leaveSealedCell (session, ctl, toward) {
  const bot = session.bot
  if (!bot || typeof bot.blockAt !== 'function' || !bot.entity) return false
  const cell = feetCell(bot)
  if (!enclosure(bot, cell).sealed) return false
  if (process.env.ND_BRUTE_MEMORY === '1') {
    const memory = await (require('./brute-shelter') as typeof import('./brute-shelter')).ensureShelterExit(session, ctl, toward, { knownShelter: true })
    if (memory) throw Object.assign(new Error('brute memory: covered exit requires replan'), { code: 'BRUTE_MEMORY_REPLAN', bruteMemory: memory })
  }
  const out = await breakOut(bot, cell, { toward })
  if (ctl.aborted) throw new Error('прервано')
  const up = out.ok ? null : await (require('./survival/enter-shelter') as typeof import('./survival/enter-shelter')).exitShelter(session, ctl, { depth: 3 })
  if (out.ok) session.shelterBox = null
  console.log('[goto] заперт в клетке', JSON.stringify({ cell: { x: cell.x, y: cell.y, z: cell.z }, side: out.ok, steps: out.steps, up: up ? { out: up.out, stopped: up.stopped } : undefined }))
  if (ctl.aborted) throw new Error('прервано')
  return true
}

// Осада: клетка противника закрыта — какой блок ломать и где для этого стоять.
// Блок — на уровне его головы, со стороны, что ближе к нам: через дыру в
// голове он виден и достаётся рукой, а сам он через неё выйти не может.
// Сторона выбирается по цене: путь до места (≈ 0.25 с на блок) плюс время
// ломки её блока тем, что у нас есть (обсидиан в его стене мы обойдём и
// вскроем булыжник рядом).
function siegePlan (bot, targetCell, from) {
  let best = null
  for (const s of SIDES) {
    const wallHead = targetCell.plus(s).offset(0, 1, 0)
    const wallFeet = targetCell.plus(s)
    if (!solidAt(bot, wallHead) && !solidAt(bot, wallFeet)) continue
    const stand = targetCell.plus(s).plus(s)
    if (solidAt(bot, stand) || solidAt(bot, stand.offset(0, 1, 0)) || !solidAt(bot, stand.offset(0, -1, 0))) continue
    const d = Math.hypot(stand.x + 0.5 - from.x, stand.z + 0.5 - from.z)
    const breakAt = solidAt(bot, wallHead) ? wallHead : wallFeet
    const dig = tools.bestFor(bot, bot.blockAt(breakAt))
    const cost = d * 250 + dig.ms
    if (!best || cost < best.cost) best = { d, cost, stand, breakAt, side: s, digMs: Math.round(dig.ms), tool: dig.item ? dig.item.name : 'рука' }
  }
  return best
}

// Ниша в стене (ND_REFUGE_NICHE=1): вкопаться в соседнюю стену на клетку (ноги и голова — 2 блока), шагнуть туда и
// заложить проём 2 блоками. Три стены, пол и потолок — порода; спереди — свои 2 блока. Быстрее коробки в пещере и у
// склона (2 копки + 2 блока против 5–8 блоков), обычный паук (1.4 шириной) в проём не лезет, зомби бьёт только из
// клетки проёма — её и закладываем (codex-lab/surv-mobs/MOBS.md §4, §6). Годится сторона s, если клетка w = c+s
// (ноги, голова) — порода, которую копать ≤ 1.2 с, не сыпучее и не руда-ценность, а вокруг w (дальше по s, оба бока
// на двух уровнях, потолок над головой, пол) — целые блоки без жидкости. Вернёт лучшую сторону или null.
const NICHE_BAD = /^(sand|red_sand|gravel|suspicious_sand|suspicious_gravel|bedrock|obsidian|crying_obsidian|reinforced_deepslate|spawner|chest|barrel|.*_ore|ancient_debris|.*shulker_box)$/
function nichePlan (bot, c, { away = null, maxMs = 1200 }: any = {}) {
  const Block = (() => { try { return (require('prismarine-block') as typeof import('prismarine-block'))(bot.registry) } catch { return null } })()
  let best = null
  for (const s of SIDES) {
    const w = c.plus(s)
    let ms = 0
    let ok = true
    for (const y of [0, 1]) {
      const b = bot.blockAt(w.offset(0, y, 0))
      if (!fullCube(b) || NICHE_BAD.test(b.name)) { ok = false; break }
      try { ms += tools.bestFor(bot, b).ms } catch { ok = false; break }
    }
    if (!ok || ms > maxMs * 2) continue
    // Потолок ниши — не сыпучий: песок/гравий над головой упадёт в выкопанную клетку (ревью Codex 02.10).
    const ceil = bot.blockAt(w.offset(0, 2, 0))
    if (!ceil || /^(sand|red_sand|gravel|suspicious_sand|suspicious_gravel)$|concrete_powder$|anvil$/.test(ceil.name)) continue
    const perp = s.x !== 0 ? [new Vec3(0, 0, 1), new Vec3(0, 0, -1)] : [new Vec3(1, 0, 0), new Vec3(-1, 0, 0)]
    const around = [w.plus(s), w.plus(s).offset(0, 1, 0), w.offset(0, 2, 0), w.offset(0, -1, 0)]
    for (const p of perp) around.push(w.plus(p), w.plus(p).offset(0, 1, 0))
    if (!around.every(p => fullCube(bot.blockAt(p)))) continue
    // Проём (наша клетка c): чтобы заложить его изнутри, у c нужен пол (верх пола виден из ниши).
    if (!fullCube(bot.blockAt(c.offset(0, -1, 0)))) continue
    let cost = ms / 1000
    if (away) {
      // От врага — лучше: ниша спиной к нему, проём к нему ближе — хуже на полсекунды.
      const dot = s.x * (c.x + 0.5 - away.x) + s.z * (c.z + 0.5 - away.z)
      cost -= Math.sign(dot) * 0.3
    }
    if (!best || cost < best.cost) best = { side: s, cell: w, digMs: Math.round(ms), cost }
  }
  return best
}

async function takeNicheBody (bot, c, plan, { ctl = null, toward = null }: any = {}) {
  const w = plan.cell
  const out: any = { dug: 0, placed: 0, steps: [] }
  // Голова, потом ноги: так тело не проваливается и не тянет за собой песок сверху (его исключили выше).
  for (const y of [1, 0]) {
    if (ctl && ctl.aborted) return out
    const r = await tools.breakFast(bot, w.offset(0, y, 0), { maxMs: 2500 })
    if (!r.ok) { out.steps.push(`копка ${y ? 'головы' : 'ног'}: ${r.why || 'не вышло'}`); return out }
    out.dug++
  }
  // Шагнуть в нишу (по прямой, как stepTo).
  const until = gameClock.now() + 1200
  try {
    while (gameClock.now() < until && !(ctl && ctl.aborted) && !feetCell(bot).equals(w)) {
      const p = bot.entity.position
      await bot.look(Math.atan2(-(w.x + 0.5 - p.x), -(w.z + 0.5 - p.z)), 0, true).catch(() => {})
      bot.setControlState('forward', true)
      await sleep(50)
    }
  } finally { try { bot.setControlState('forward', false) } catch {} }
  await landed(bot, 600)
  if (!feetCell(bot).equals(w)) { out.steps.push('в нишу не вошёл'); return out }
  await centerInCell(bot, 500, w)
  // Заложить проём: refugeBox вокруг w — стены там только со стороны проёма (остальное — порода), крыша — порода.
  const b: any = await refugeBox(bot, w, { toward: toward || c.offset(0.5, 0, 0.5), ctl, budgetMs: 3000 })
  out.placed = b.placed
  // Выход — тем же проёмом: за остальными стенами ниши порода (breakOut их не выберет, а «вверх» — ломать потолок).
  b.front = c
  out.box = b
  if (b.failed) out.steps.push(...b.failed.slice(0, 2))
  return out
}

module.exports = {
  SIDES, HARD, feetCell, solidAt, pickaxeOf, hardFiller, boxMaterials, canBreakOut, refugeFiller, enclosure, centerInCell, boxPlan, boxCheck, boxIn, patch, breakBlock, breakOut, leaveSealedCell, siegePlan, pickFiller,
  fullCube, openCell, refugeNeed, refugeBuildMs, refugeCell, refugePlan, jumpPlace, refugeBox, refugePatch, landed, shove, shoveNear, sinkRoof,
  nichePlan, takeNicheBody
}
export {
  SIDES, HARD, feetCell, solidAt, pickaxeOf, hardFiller, boxMaterials, canBreakOut, refugeFiller, enclosure,
  centerInCell, boxPlan, boxCheck, boxIn, patch, breakBlock, breakOut, leaveSealedCell, siegePlan, pickFiller,
  fullCube, openCell, refugeNeed, refugeBuildMs, refugeCell, refugePlan, jumpPlace, refugeBox, refugePatch,
  landed, shove, shoveNear, sinkRoof, nichePlan, takeNicheBody
}
