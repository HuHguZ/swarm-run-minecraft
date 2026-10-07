'use strict'
const gameClock = require('./game-clock')
// От «крепость» в памяти до горящего портала в Край: дойти, уточнить точку оком,
// прокопаться вниз, найти портальную комнату по коридорам и вставить глаза в
// рамки (mc_stronghold mode=go / room / fill). Бросок ока и пересечение лучей —
// stronghold.js, здесь — всё, что после.
//
// Факты игры (байткод paper-1.21.11, разобран 2026-09-25):
//   * око летит к ChunkGenerator.findNearestMapStructure → getLocatePos стартового
//     чанка крепости: угол чанка (minBlockX, 0, minBlockZ), locateOffset у колец —
//     ZERO. Не к портальной комнате и не к середине чанка.
//   * EyeOfEnder.signalTo: дальше 12 блоков по горизонтали цель — 12 блоков в ту
//     сторону и +8 вверх; ближе — точная точка (око ныряет к y=0). Живёт 80 тиков,
//     потом падает предметом (80%) или бьётся (20%).
//   * старт крепости — StartPiece (StairsDown) 5x11x5 от (x0+2, 64, z0+2), вся
//     постройка потом сдвинута вниз (moveBelowSeaLevel, верх ниже seaLevel-10).
//     Значит, копать у (x0+4, z0+4) — попадаешь в лестничную башню старта.
//   * портальная комната есть всегда; её дверь не дальше 112 блоков по x и по z
//     от угла старта (generateAndAddPiece), глубина кусков до 50.
//   * комната 11x8x16: 12 рамок end_portal_frame на высоте пола+3, все смотрят
//     внутрь; под центром 3x3 — лава (пол+1), между ней и рамками воздух; лестница
//     к площадке (пол+3) и на средней верхней ступени — спавнер чешуйниц.
//     Каждая рамка с оком с шансом 10% (nextFloat() > 0.9).
//   * EnderEyeItem.useOn: блок end_portal_frame без ока → око встаёт, стак -1;
//     грань клика не проверяется. Когда все 12 с оком и смотрят внутрь — 3x3
//     end_portal на высоте рамок (getOrCreatePortalShape).
//   * end_portal: без коллизии, перенос в Край МГНОВЕННЫЙ (задержка 0), как только
//     хитбокс пересёк плиту y+0.375..0.75. Стоять на рамке безопасно (ноги на
//     +0.8125); опасно уйти хитбоксом целиком за край рамки над 3x3.

const Vec3 = require('vec3')
const { goals } = require('mineflayer-pathfinder')
const { sleep, xyz, travelXZ, stuckGuard } = require('./movement')
const { itemNamed, countOf, equipBestTool, missingHarvestTool } = require('./items')
const { raySees, eyePos } = require('./perception')
const { walkable } = require('./walkable')
const { seesBlock } = require('./sight')
const worlds = require('./worlds')

const PLACE = 'крепость'
const ROOM = 'портал в Край'
// Кирпич крепости. Каменный кирпич в верхнем мире сам по себе не растёт —
// увидел его под землёй, значит, ты в крепости (или в руинах/иглу, что
// отличит только комната).
const BRICKS = /^(stone_bricks|mossy_stone_bricks|cracked_stone_bricks|chiseled_stone_bricks|infested_(stone_bricks|mossy_stone_bricks|cracked_stone_bricks|chiseled_stone_bricks)|stone_brick_stairs|mossy_stone_brick_stairs|stone_brick_slab|iron_bars|end_portal_frame)$/
const REACH = 4.2
const DIRS8 = [[1, 0], [-1, 0], [0, 1], [0, -1], [1, 1], [1, -1], [-1, 1], [-1, -1]]

function clamp (v, lo, hi) { return Math.max(lo, Math.min(hi, v)) }
// Честный спуск (S5e 07.10, AGENTS.md «как на случайном сиде»): решения шахты, штрека и выбора колонки — только по видимому
// (луч глаз) и слышимому; толща не читается. scan («полный скан») и ND_HONEST_SHAFT=0 — прежний ход по прогруженным чанкам.
function honestDescent () { return process.env.ND_HONEST_SHAFT !== '0' && require('./perception/knowledge').level() !== 'scan' }
// Клетка, как её знает игрок: в честном режиме — только видимая сейчас (иначе null — «не знаю»).
function look (bot, p) {
  if (!honestDescent()) return bot.blockAt(p)
  try { return require('./perception/eyes').seesNow(bot, p) ? bot.blockAt(p) : null } catch { return null }
}
const log = (what, o) => console.log('[stronghold]', what, JSON.stringify(o))

function placeOf (session, name) {
  const places = (session.journal.state && session.journal.state.places) || {}
  return places[name] || null
}

function savePlace (session, name, rec, journalText) {
  session.journal.patch(s => {
    if (!s.places) s.places = {}
    s.places[name] = { ...(s.places[name] || {}), ...rec }
  })
  if (journalText) session.journal.append(name, journalText, new Vec3(rec.x, rec.y ?? 0, rec.z))
}

async function walkTo (bot, ctl, target, range, ms) {
  const guard = stuckGuard(bot, ctl, 10000)
  let timer = null
  try {
    await Promise.race([
      bot.pathfinder.goto(new goals.GoalNear(target.x, target.y, target.z, range)),
      guard.promise,
      new Promise<any>((_resolve, reject) => { timer = gameClock.setTimeout(() => reject(new Error('время вышло')), Math.max(500, ms)) }),
      // Обрыв (nether.guarded: ударили по дороге) — не ждать конца пути.
      new Promise<any>((_resolve, reject) => { if (ctl && Array.isArray(ctl.onAbort)) ctl.onAbort.push(() => reject(new Error('прервано'))) })
    ])
    return { ok: true }
  } catch (e) {
    try { bot.pathfinder.setGoal(null) } catch {}
    return { ok: false, error: e.message }
  } finally {
    guard.stop()
    if (timer) gameClock.clearTimeout(timer)
  }
}

// ------------------------------------------------------------------ go

// Шахта вниз 1x1 до первого кирпича крепости. Своя, а не actions.digDown: той
// нечем сказать «стоп, под ногами кирпич» — а здесь это и есть цель.
async function shaftToBricks (session, ctl, { minY, deadline, targetY = null }: any) {
  if (honestDescent()) return require('./endportal-descent').honestShaft(session, ctl, { minY, deadline, targetY, bricks: BRICKS, log })
  const bot = session.bot
  const mcData = session.mcData
  let dug = 0
  let sidesteps = 0
  let stairsTries = 0
  const startY = bot.entity.position.floored().y
  // Сторож хода: 12 витков без смены клетки — стоп (s5d-p5-2 07.10: тело на краю соседнего блока, клетка под ногами пустая,
  // «копать» нечего, тело не падает — 5 вызовов по 500 игр. с на одном месте).
  let lastCell = null
  let still = 0
  for (;;) {
    if (ctl.aborted) return { stopped: 'прервано', dug }
    if (gameClock.now() > deadline) return { stopped: 'время вышло', dug }
    const feet = bot.entity.position.floored()
    if (lastCell && lastCell.equals(feet)) { if (++still >= 12) return { stopped: `шахта не идёт: ${still} витков на ${feet.x},${feet.y},${feet.z}`, dug } } else { still = 0; lastCell = feet }
    if (still >= 3) {
      // Пусто под клеткой, а тело стоит (держит край соседнего блока) — шаг в центр клетки.
      const below0 = bot.blockAt(feet.offset(0, -1, 0))
      if (below0 && below0.boundingBox === 'empty') {
        try {
          await bot.lookAt(new Vec3(feet.x + 0.5, bot.entity.position.y + 1.6, feet.z + 0.5), true).catch(() => {})
          bot.setControlState('forward', true)
          await sleep(200)
        } finally { bot.setControlState('forward', false) }
      }
    }
    // Уровень комнаты — любой в 3 бл. ниже цели (внутри комнаты высота 6; s5d-p4-1: «ниже уровня комнаты (43 < 44)» после
    // пещеры — подход бросался на месте).
    if (Number.isFinite(targetY) && feet.y <= targetY) return feet.y >= targetY - 3
      ? { reached: true, at: xyz(feet), dug, fromY: startY }
      : { stopped: `ниже уровня комнаты (${feet.y} < ${targetY}) — дальше вниз не копаю`, dug }
    // Кирпич рядом (стена коридора сбоку) или под ногами — пришли.
    for (const dy of Number.isFinite(targetY) ? [] : [0, 1, -1]) {
      for (const [dx, dz] of DIRS8) {
        const b = bot.blockAt(feet.offset(dx, dy, dz))
        if (b && BRICKS.test(b.name)) return { found: b.name, at: xyz(b.position), dug, fromY: startY }
      }
    }
    const below = bot.blockAt(feet.offset(0, -1, 0))
    const under = bot.blockAt(feet.offset(0, -2, 0))
    if (!below) return { stopped: 'мир под ногами не прогружен', dug }
    if (Number.isFinite(targetY) && /end_portal|spawner/.test(below.name)) return { stopped: `${below.name} под шахтой — нужен боковой подход`, dug }
    if (feet.y <= minY) return { stopped: `дошёл до y=${feet.y}, кирпича так и не встретил`, dug }
    if (below.name === 'bedrock') return { stopped: 'бедрок — ниже крепости не бывает', dug }
    // Вода вокруг следующей клетки шахты — затопит (лаборатория, прогон 10:
    // шахта в затопленную пещеру, «NeuroBuild drowned»).
    {
      const nx = feet.offset(0, -1, 0)
      const wet = [nx.offset(1, 0, 0), nx.offset(-1, 0, 0), nx.offset(0, 0, 1), nx.offset(0, 0, -1), nx.offset(0, -1, 0)].filter(q => { const b = bot.blockAt(q); return b && /water/.test(b.name) })
      if (wet.length) {
        // Заложить воду блоком (вода заменяется) и копать дальше — как человек у
        // озера: ферма, крепость A — «вода у шахты» в 3 из 5 подходов, а
        // лестница старта под озером. Не вышло — стоп, как раньше.
        const { placeBlockAt } = require('./build')
        let sealed = 0
        for (const q of wet) { try { const r = await placeBlockAt(bot, q, { timeoutMs: 1500 }); if (r && r.ok) sealed++ } catch {} }
        const still = wet.filter(q => { const b = bot.blockAt(q); return b && /water/.test(b.name) })
        // Заложить не вышло — шаг вбок на сухую колонку (sideStepShaft обходит мокрые) и вниз там (SH2 03.10: у комнаты
        // по карте «вода у шахты», потом «время вышло» ×2 на том же месте).
        if (still.length && sidesteps < 8) { const moved = await sideStepShaft(bot, mcData, feet); if (moved) { dug += moved; sidesteps++; continue } }
        if (still.length) return { stopped: `вода у шахты — заложил ${sealed} из ${wet.length}, дальше вниз не копаю (затопит)`, dug, wet: true }
      }
    }
    if (/lava|water/.test(below.name) || (under && /lava/.test(under.name))) {
      // Лава/вода под шахтой — шаг вбок на сухую колонку (sideStepShaft обходит мокрые и лаву), дальше вниз там: SH3
      // 03.10 — комната по карте на y −7, шахта на y 16 упёрлась в лаву, 6 вызовов подряд «под ногами лава».
      if (sidesteps < 10) { const moved = await sideStepShaft(bot, mcData, feet); if (moved) { dug += moved; sidesteps++; continue } }
      return { stopped: `под ногами ${/lava/.test(below.name + (under ? under.name : '')) ? 'лава' : 'вода'} — дальше вниз не копаю`, dug }
    }
    // Заражённый кирпич коридора над комнатой (подход по карте): шаг вбок, а нет — копать и его, если хп ≥ 12 (цена — чешуйница,
    // 1 урона в железе; S5d s5d-N-6 07.10: «заражённый кирпич под шахтой — нужен обход» ×6 на y 4, пауза, 35 мин вышли).
    if (INFESTED.test(below.name) && Number.isFinite(targetY)) {
      if (sidesteps < 12) { const moved = await sideStepShaft(bot, mcData, feet); if (moved) { dug += moved; sidesteps++; continue } }
      if ((bot.health ?? 20) < 12) return { stopped: 'заражённый кирпич под шахтой — нужен обход', dug }
    } else if (INFESTED.test(below.name)) return { found: below.name, at: xyz(below.position), infested: true, dug }
    if (BRICKS.test(below.name) && !Number.isFinite(targetY)) {
      // Потолок крепости под ногами. Сломать и спрыгнуть — только если под ним
      // невысоко: лестничная башня старта высокая, а пол у неё есть на каждом витке.
      let drop = 0
      for (let d = 2; d <= 6; d++) {
        const c = bot.blockAt(feet.offset(0, -d, 0))
        if (!c || c.boundingBox !== 'empty') break
        if (/lava/.test(c.name)) return { stopped: 'под потолком крепости лава', dug }
        drop++
      }
      if (drop > 4) return { found: below.name, at: xyz(below.position), roof: true, dug, stopped: `под кирпичом пустота на ${drop}+ блоков — прыгать не стал` }
    }
    // Под блоком пещера (лаборатория 2026-09-27: «impaled on a stalagmite» —
    // шахта вскрыла пещеру с капельником и тело упало на сталагмит). Сколько
    // воздуха под «below» и на что упадём: больше 2 блоков или острый капельник —
    // не ломать, а сдвинуться вбок на соседнюю колонку и копать там.
    if (!BRICKS.test(below.name) || Number.isFinite(targetY)) {
      let gap = 0
      let land = null
      for (let d = 2; d <= 40; d++) {
        const c = bot.blockAt(feet.offset(0, -d, 0))
        if (!c) break
        if (c.boundingBox === 'empty' && !/water|lava/.test(c.name)) { gap++; continue }
        land = c
        break
      }
      // Капельник в пещере под шахтой (на дне, на потолке, рядом) — не прыгать туда: s5d-N-1/H-1 07.10 «skewered by a falling
      // stalactite» после спуска в пещеру из шахты. Колонки 3×3 вокруг, до дна пещеры.
      let drip = false
      for (let d = 1; d <= gap + 2 && !drip; d++) for (const [dx, dz] of DIRS8.concat([[0, 0]])) {
        const c = bot.blockAt(feet.offset(dx, -d, dz))
        if (c && /pointed_dripstone/.test(c.name)) { drip = true; break }
      }
      const spike = (land && /pointed_dripstone/.test(land.name)) || drip
      // Спуск в пещеру до 4 блоков на твёрдое — цена (0–1 хп), а не стоп (гибкость, s5c-g2-2 06.10: «под ногами пещера
      // (3 блоков) — прыгать не стал» ×6 на одном месте, 20 мин до конца срока). Лава, магма, сталагмит, снег — по-прежнему нет.
      const safeDrop = gap <= 4 && !!land && land.boundingBox === 'block' && !/lava|magma|pointed_dripstone|powder_snow|cactus|campfire/.test(land.name) && (bot.health ?? 20) >= 10
      if ((gap > 2 && !safeDrop) || (gap > 0 && spike) || (Number.isFinite(targetY) && feet.y - gap - 1 < targetY)) {
        const moved = await sideStepShaft(bot, mcData, feet)
        if (moved) { dug += moved; sidesteps++; if (sidesteps > 12) return { stopped: 'пещеры под шахтой со всех сторон', dug }; continue }
        // Сбоку тоже пещера — вниз лесенкой (actions.digDown stairs: уступы и
        // спуски с проверкой падения), дальше снова шахтой.
        if (stairsTries++ < 2) {
          const y0 = feet.y
          const st = await require('./actions').digDown(session, ctl, { mode: 'stairs', depth: Math.min(24, gap + 3, Number.isFinite(targetY) ? feet.y - targetY : 128), timeoutSeconds: Math.max(20, Math.min(120, Math.round((deadline - gameClock.now()) / 1000) - 10)) }).catch(e => ({ stopped: e.message }))
          const y1 = bot.entity.position.floored().y
          if (y1 < y0) { dug += (st && st.dug) || 0; continue }
        }
        return { stopped: `под ногами пещера (${gap} блоков${spike ? ', сталагмиты' : ''}) — прыгать не стал`, dug }
      }
    }
    // Кирки кончились (ход по Аду и шахта к комнате стёрли все: SH5 03.10 — комната найдена на 7-й мин, кирок 0, этап
    // wood увёл наверх, рамки «в 103 блоках») — каменные из булыжника шахты и палок рюкзака (tunnel.restockPicks), запас ≥ 2.
    if (require('./tunnel').lowPicks(bot) < 2) { try { await require('./tunnel').restockPicks(session, ctl, 2) } catch {} }
    const problem = cantDigThrough(bot, below, mcData)
    // Не копается (обсидиан рамы выхода из Ада под шахтой, s5d-R-5 07.10: «для obsidian нужна кирка получше» ×8 на месте) — шаг вбок.
    if (problem && sidesteps < 12) { const moved = await sideStepShaft(bot, mcData, feet); if (moved) { dug += moved; sidesteps++; continue } }
    if (problem) return { stopped: problem, dug }
    let digErr = null
    for (let k = 0; k < 3; k++) {
      try {
        const cur = bot.blockAt(feet.offset(0, -1, 0))
        if (!cur || cur.boundingBox === 'empty') { digErr = null; break }
        if (Number.isFinite(targetY) && !seesBlock(bot, cur)) return { stopped: `${cur.name} под шахтой не виден в прицеле`, dug }
        await equipBestTool(bot, cur)
        await bot.dig(cur)
        digErr = null
        break
      } catch (e) {
        // «Digging aborted»: течение воды или толчок сдвинули тело — встать на
        // место и ещё раз (ферма, крепость A у озера).
        digErr = e
        try { bot.clearControlStates() } catch {}
        await sleep(700)
      }
    }
    if (digErr) return { stopped: `не сломал ${below.name}: ${digErr.message}`, dug }
    dug++
    await sleep(450)
  }
}

// Шаг вбок из шахты: соседняя колонка, где под ногами твёрдо и под тем, что
// будем копать дальше, не пещера. Ноги и голова соседа — выкопать, шагнуть.
async function sideStepShaft (bot, mcData, feet) {
  let dug = 0
  for (const [dx, dz] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
    const n = feet.offset(dx, 0, dz)
    const floor = bot.blockAt(n.offset(0, -1, 0))
    if (!floor || floor.boundingBox !== 'block' || /pointed_dripstone/.test(floor.name)) continue
    let gap = 0
    for (let d = 2; d <= 6; d++) { const c = bot.blockAt(n.offset(0, -d, 0)); if (!c || c.boundingBox !== 'empty') break; gap++ }
    if (gap > 2) continue
    let wet = false
    for (const c of [n, n.offset(0, 1, 0)]) for (const q of [c, c.offset(1, 0, 0), c.offset(-1, 0, 0), c.offset(0, 0, 1), c.offset(0, 0, -1), c.offset(0, 1, 0)]) {
      const b = bot.blockAt(q)
      if (b && /water|lava/.test(b.name)) wet = true
    }
    if (wet) continue
    const s = await digStepInto(bot, mcData, n)
    dug += s.dug
    if (s.ok) return Math.max(1, dug)
  }
  return 0
}

// Копать насквозь (шахта, штрек) — дроп не нужен: снег, землю, лёд руками пробить можно (s5c-g2-3 06.10: snow_block в шахте
// «без лопаты не ломается» — 45 мин на одном месте до конца срока). Стоп — только если удар дольше 10 игр. с (обсидиан и т. п.).
function cantDigThrough (bot, b, mcData) {
  const problem = missingHarvestTool(bot, b, mcData)
  if (!problem) return null
  let t = Infinity
  try { t = bot.digTime(b) } catch {}
  return t <= 10000 ? null : problem
}

// Шаг в соседнюю клетку на своём уровне: голова, потом ноги (каждый удар — по видимому блоку, обёртка dig у вызывающего),
// осыпь (гравий/песок) — до трёх раз, потом шаг. { ok, dug, why }. Свой простой шаг вместо mining.tunnel в штреке к комнате:
// тот на «шаге штрека» молча не двигал тело (s5c-f2-4/f2-5 06.10: «шаг штрека не выполнен» у самой комнаты, 5+ мин на месте).
async function digStepInto (bot, mcData, n) {
  let dug = 0
  for (let pass = 0; pass < 3; pass++) {
    let solid = false
    for (const c of [n.offset(0, 1, 0), n]) {
      const b = bot.blockAt(c)
      if (!b || b.boundingBox === 'empty') continue
      solid = true
      const tool = cantDigThrough(bot, b, mcData)
      if (tool) return { ok: false, dug, why: tool }
      try { await equipBestTool(bot, b); await bot.dig(b); dug++ } catch (e) { return { ok: false, dug, why: `не сломал ${b.name}: ${e.message}` } }
    }
    if (!solid) break
    await sleep(150)
  }
  const t0 = gameClock.now()
  try {
    while (gameClock.now() - t0 < 1500 && !bot.entity.position.floored().equals(n)) {
      await bot.lookAt(n.offset(0.5, 1.6, 0.5), true)
      bot.setControlState('forward', true)
      await sleep(50)
    }
  } finally { bot.setControlState('forward', false) }
  const ok = bot.entity.position.floored().equals(n)
  if (ok) return { ok, dug }
  const at = bot.entity.position.floored()
  const name = q => { const b = bot.blockAt(q); return b ? b.name : '?' }
  return { ok, dug, why: `не шагнул в ${xyz(n).x},${xyz(n).y},${xyz(n).z}: стою ${at.x},${at.y},${at.z}, в ногах ${name(n)}, в голове ${name(n.offset(0, 1, 0))}` }
}

// Шахта остановилась у кирпича — но тело ещё в своей шахте 1x1, а не в
// крепости: разведке оттуда идти некуда (прогон 2026-09-25: «куда идти
// дальше, не вижу» за 0 секунд). Стена крепости в один кирпич, коридор за ней
// высотой 3: пробить ногами и головой в сторону кирпича и шагнуть, пока вокруг
// не станет просторно; кирпич под ногами — потолок, его вниз.
const CARDINAL = [[1, 0], [-1, 0], [0, 1], [0, -1]]

// Кирпич с чешуйницей (infested_*) выглядит как обычный, но сломать его —
// выпустить чешуйницу, а она зовёт соседних (лаборатория 2026-09-27, прогон
// 16: «slain by Silverfish»; первый кирпич шахты у -1024,5680 — infested).
// На время работы в крепости pathfinder их не ломает (blocksCantBreak).
const INFESTED = /^infested_/
function noInfested (bot) {
  const mv = bot.pathfinder && bot.pathfinder.movements
  const added = []
  if (mv && mv.blocksCantBreak) {
    for (const b of ((Object.values(bot.registry.blocksByName) as any[]) as any)) {
      if (INFESTED.test(b.name) && !mv.blocksCantBreak.has(b.id)) { mv.blocksCantBreak.add(b.id); added.push(b.id) }
    }
  }
  return () => { for (const id of added) { try { mv.blocksCantBreak.delete(id) } catch {} } }
}

// Клетка внутри крепости: воздух на ноги и голову, пол — кирпич крепости, и
// вокруг (5x3x5) не меньше 10 блоков крепости (коридор, а не пещера рядом:
// прогон 25 — «внутри» по 13 клеткам пещеры).
const HOLD = /stone_brick|infested_|^iron_bars$|^oak_planks$|^bookshelf$|^end_portal_frame$|_door$/
// Дёшево: воздух на ноги и голову, пол — кирпич, над головой в 2..4 — потолок
// крепости (дно своей шахты на крыше крепости не проходит: над ним шахта).
const FLOOR = /stone_brick|infested_|^oak_planks$|^end_portal_frame$/
function interiorCell (bot, c) {
  const air = q => { const b = bot.blockAt(q); return !!b && b.boundingBox === 'empty' && !/water|lava/.test(b.name) }
  if (!air(c) || !air(c.offset(0, 1, 0))) return 0
  const fl = bot.blockAt(c.offset(0, -1, 0))
  if (!fl || !FLOOR.test(fl.name)) return 0
  let roof = false
  for (let dy = 2; dy <= 4 && !roof; dy++) { const b = bot.blockAt(c.offset(0, dy, 0)); if (b && HOLD.test(b.name)) roof = true }
  if (!roof) return 0
  let n = 0
  for (let dx = -2; dx <= 2; dx++) for (let dy = -1; dy <= 3; dy++) for (let dz = -2; dz <= 2; dz++) {
    const b = bot.blockAt(c.offset(dx, dy, dz))
    if (b && HOLD.test(b.name)) n++
  }
  return n >= 10 ? n : 0
}
// Точно: заливка «куда дойду» от клетки (6 блоков, до 80) — 8+ клеток, и у
// 60%+ из них пол — кирпич крепости (коридор; дно шахты — 2 клетки, пещера —
// камень под ногами). Прогон 26: дно шахты на крыше крепости считалось «внутри».
function insideHold (bot, c) {
  const nodes = walkable(bot, c, { radius: 6, maxNodes: 80, doors: true })
  if (nodes.length < 8) return false
  const brick = nodes.filter(n => { const fl = bot.blockAt(n.pos.offset(0, -1, 0)); return fl && FLOOR.test(fl.name) }).length
  return brick / nodes.length >= 0.6
}

// Внутрь по кирпичу: ближайшая клетка коридора в 8 блоках (по видимому и
// соседнему кирпичу шахты), путь к ней — pathfinder с копанием, но без
// infested; не вышло — следующая (до 4).
async function enterByBricks (session, ctl, { deadline }: any) {
  const bot = session.bot
  const f0 = bot.entity.position.floored()
  if (insideHold(bot, f0)) return { inside: true, already: true }
  const honest = honestDescent()
  let cands = []
  for (let dx = -8; dx <= 8; dx++) for (let dy = -6; dy <= 6; dy++) for (let dz = -8; dz <= 8; dz++) {
    if (!dx && !dz) continue
    const c = f0.offset(dx, dy, dz)
    // Честно — только клетки коридора, которые видно (за стеной шахты коридор не знаем).
    if (honest && !require('./perception/eyes').seesNow(bot, c)) continue
    const n = interiorCell(bot, c)
    if (n) cands.push({ c, n, d: Math.abs(dx) + Math.abs(dy) * 1.5 + Math.abs(dz) })
  }
  cands.sort((a, b) => a.d - b.d)
  const cheap = cands.length
  cands = cands.slice(0, 16).filter(k => insideHold(bot, k.c))
  const tries = []
  for (const k of cands.slice(0, 4)) {
    if (ctl.aborted || gameClock.now() > deadline) break
    const w = await walkTo(bot, ctl, k.c, 0, Math.min(30000, Math.max(3000, deadline - gameClock.now())))
    const f = bot.entity.position.floored()
    const inside = insideHold(bot, f)
    tries.push({ to: xyz(k.c), ok: w.ok, inside, why: w.ok ? undefined : w.error })
    if (inside) return { inside: true, tries, cands: cands.length, cheap }
  }
  return { inside: false, tries, cands: cands.length, cheap }
}

// Факел, если темно (свет блока < 5) и своего факела в 10 блоках нет: мобы
// спавнятся только при свете 0, факел (14) гасит спавн на ~12 блоков.
async function torchIfDark (bot, torches) {
  const t = bot.inventory.items().find(i => i.name === 'torch')
  if (!t) return false
  const f = bot.entity.position.floored()
  const here = bot.blockAt(f)
  if (!here) return false
  if (typeof here.light === 'number' && here.light >= 5) return false
  if (torches.some(q => q.distanceTo(f) < 10)) return false
  const { withTimeout } = require('./build')
  for (const [dx, dz] of [[0, 0], [1, 0], [-1, 0], [0, 1], [0, -1]]) {
    const c = f.offset(dx, 0, dz)
    const cb = bot.blockAt(c)
    const fl = bot.blockAt(c.offset(0, -1, 0))
    if (!cb || !/^(cave_)?air$/.test(cb.name) || !fl || fl.boundingBox !== 'block') continue
    try {
      await bot.equip(t, 'hand')
      await withTimeout(bot.placeBlock(fl, new Vec3(0, 1, 0)), 2500)
    } catch {}
    const got = bot.blockAt(c)
    if (got && /torch/.test(got.name)) { torches.push(c); return true }
  }
  return false
}
async function breakIn (session, ctl, { deadline, tries = 8, toward = null }: any = {}) {
  const bot = session.bot
  const mcData = session.mcData
  const steps = []
  const roomy = () => walkable(bot, bot.entity.position, { radius: 8, maxNodes: 60, doors: true }).length >= 12
  // Честно: за стеной коридор не видно — пробить видимый кирпич и смотреть (endportal-descent.honestEnter).
  if (honestDescent()) {
    // «Внутри» — клетки с полом крепости (кирпич, доски, рамки), а не просторно вообще: винтовая лестница 2×2 сама даёт 10+
    // клеток стояния в 8 бл. (ложное «внутри» — разведка ходила бы по своей лестнице).
    const inHold = () => walkable(bot, bot.entity.position, { radius: 8, maxNodes: 80, doors: true })
      .filter(n => { const fl = bot.blockAt(n.pos.offset(0, -1, 0)); return fl && FLOOR.test(fl.name) }).length >= 6
    const r = await require('./endportal-descent').honestEnter(session, ctl, { deadline, toward, bricks: BRICKS, roomy: inHold, tries: tries + 2 })
    log('внутрь (честно)', { inside: r.inside, at: xyz(bot.entity.position.floored()), toward, steps: r.steps.slice(-6) })
    return r
  }
  const at = p => bot.blockAt(p)
  const isAir = b => !!b && b.boundingBox === 'empty' && !/lava|water|fire|portal/.test(b.name)
  const isBrick = b => !!b && BRICKS.test(b.name)
  const dig = async (c) => {
    const b = at(c)
    if (!b || b.boundingBox === 'empty') return true
    if (/lava|water|end_portal/.test(b.name) || b.name === 'bedrock' || INFESTED.test(b.name)) { steps.push(`стоп: ${b.name}`); return false }
    const problem = missingHarvestTool(bot, b, mcData)
    if (problem) { steps.push(`стоп: ${problem}`); return false }
    try { await equipBestTool(bot, b); await bot.dig(b) } catch (e) { steps.push(`стоп: ${e.message}`); return false }
    steps.push(`${b.name}@${c.x},${c.y},${c.z}`)
    return true
  }
  // Шаг клавишами в соседнюю клетку: pathfinder'у в шахте 1x1 не развернуться.
  const stepInto = async (cell) => {
    const target = cell.offset(0.5, 0, 0.5)
    const t0 = gameClock.now()
    try {
      while (gameClock.now() - t0 < 1500 && bot.entity.position.floored().distanceTo(cell) >= 0.5) {
        await bot.lookAt(target.offset(0, 1.6, 0), true)
        bot.setControlState('forward', true)
        await sleep(50)
      }
    } finally { bot.setControlState('forward', false) }
    await sleep(300)
  }
  // Сколько воздуха под клеткой, прежде чем пол (прыжок в комнату).
  const dropUnder = (c) => {
    let n = 0
    for (let d = 1; d <= 6; d++) {
      const b = at(c.offset(0, -d, 0))
      if (!b) return 99
      if (/lava/.test(b.name)) return 99
      if (b.boundingBox !== 'empty') return n
      n++
    }
    return n
  }
  for (let i = 0; i < tries && !ctl.aborted && gameClock.now() < deadline; i++) {
    if (roomy()) return { inside: true, steps }
    const feet = bot.entity.position.floored()
    const down = feet.offset(0, -1, 0)
    // 1. Потолок крепости прямо под ногами, под ним воздух — вниз.
    if (isBrick(at(down)) && isAir(at(down.offset(0, -1, 0))) && dropUnder(down) <= 4) {
      if (!(await dig(down))) break
      await sleep(600)
      continue
    }
    let done = false
    for (const [dx, dz] of CARDINAL) {
      const f = feet.offset(dx, 0, dz)
      const h = feet.offset(dx, 1, dz)
      const fd = f.offset(0, -1, 0)
      // 2. Потолок наискосок: шагнуть туда (пробив ноги и голову) и вниз.
      if (isBrick(at(fd)) && isAir(at(fd.offset(0, -1, 0))) && dropUnder(fd) <= 4) {
        if (!(await dig(h)) || !(await dig(f))) { done = true; break }
        await stepInto(f)
        if (!bot.entity.position.floored().equals(f)) continue
        if (!(await dig(fd))) { done = true; break }
        await sleep(600)
        done = true
        break
      }
      // 3. Стена сбоку, за ней воздух — пробить ноги и голову и шагнуть.
      const f2 = feet.offset(2 * dx, 0, 2 * dz)
      const h2 = feet.offset(2 * dx, 1, 2 * dz)
      if ((isBrick(at(f)) || isBrick(at(h))) && (isAir(at(f2)) || isAir(at(h2)))) {
        if (!(await dig(h)) || !(await dig(f))) { done = true; break }
        await stepInto(f)
        done = true
        break
      }
    }
    if (!done && toward) {
      // Лестница старта (StrongholdPieces.StartPiece = StairsDown 5x11x5 с
      // началом в углу чанка + 2): стены — весь периметр 5x5 на все 11 высот,
      // середина (угол + 4) — воздух сверху донизу, ступени по краю. Шахта,
      // промахнувшаяся оком на 1–2 блока, идёт вниз внутри стены (лаборатория
      // 2026-09-27, прогон 18: 6 блоков кирпича вниз в 2 блоках от середины,
      // «куда идти дальше, не вижу»). Вбок к середине — в пролёт лестницы.
      const ddx = toward.x - feet.x; const ddz = toward.z - feet.z
      if (Math.abs(ddx) + Math.abs(ddz) >= 1 && Math.abs(ddx) <= 4 && Math.abs(ddz) <= 4) {
        const [sx, sz] = Math.abs(ddx) >= Math.abs(ddz) ? [Math.sign(ddx), 0] : [0, Math.sign(ddz)]
        const f = feet.offset(sx, 0, sz)
        const h = f.offset(0, 1, 0)
        if (!(await dig(h)) || !(await dig(f))) break
        await stepInto(f)
        steps.push(`к середине лестницы ${f.x},${f.z}`)
        continue
      }
    }
    if (!done) {
      // Ничего не подошло: кирпич под ногами — копать вниз, иначе — в сторону
      // ближайшего видимого кирпича.
      if (isBrick(at(down)) || !isAir(at(down))) {
        if (!(await dig(down))) break
        await sleep(600)
      } else break
    }
  }
  const inside = roomy()
  try {
    const f = bot.entity.position.floored()
    const around = []
    for (const [dx, dz] of CARDINAL) for (const dy of [-1, 0, 1]) { const b = bot.blockAt(f.offset(dx, dy, dz)); around.push(b ? b.name.replace(/_bricks?$|stone_brick/, 'B').slice(0, 12) : '?') }
    log('внутрь', { inside, at: xyz(f), toward, nodes: walkable(bot, bot.entity.position, { radius: 8, maxNodes: 60, doors: true }).length, below: (bot.blockAt(f.offset(0, -1, 0)) || {}).name, around: around.join(' '), steps: steps.slice(-6) })
  } catch {}
  return { inside, steps }
}

// Верх земли в колонке: первая клетка сверху, где можно стоять (пол твёрдый или
// вода — её тоже надо увидеть), в окне ±20 от высоты тела.
function surfaceY (bot, x, z, fromY) {
  for (let y = fromY + 20; y >= fromY - 20; y--) {
    const g = look(bot, new Vec3(x, y - 1, z))
    const f = look(bot, new Vec3(x, y, z))
    if (!g || !f) continue
    // Листва и стволы — не земля: крона дерева у озера давала «сушу» на y 86 над
    // водой на y 62 (room-A-7), и шахту копали у самой воды.
    if (/leaves|_log$|_wood$|vine/.test(g.name)) continue
    if (f.boundingBox === 'empty' && !/water|lava/.test(f.name) && (g.boundingBox === 'block' || /water|lava/.test(g.name))) return y
  }
  return null
}

// Жидкость в колонке или рядом в верхних 8 блоках — копать здесь нельзя.
function wetColumn (bot, x, z, topY) {
  // Честно — видимая вода/лава у поверхности (озеро сверху видно, подземная — нет: её покажет копка, заложим).
  const low = honestDescent() ? topY - 1 : topY - 8
  for (let y = topY + 1; y >= low; y--) {
    for (let dx = -1; dx <= 1; dx++) {
      for (let dz = -1; dz <= 1; dz++) {
        const b = look(bot, new Vec3(x + dx, y, z + dz))
        if (b && /water|lava/.test(b.name)) return b.name === 'lava' ? 'лава' : 'вода'
      }
    }
  }
  return null
}

// Ближайшая к входу комнаты сухая колонка: кольца до DRY_FAR бл., точки через 2 бл. по периметру, только прогруженные
// чанки (непрогруженная — не суша). { x, z, r } или null.
// До 96 бл. (s5c-g2-1: комната под морем, суши в 48 нет — 60 мин у воды): дальше 48 — точки через 4 бл. (дешевле), чанки
// в обзоре (8 = 128 бл.) у тела, подошедшего к комнате, прогружены; штрек под дном до 96+ шагов.
const DRY_FAR = 96
// Целая колонка шахты: от поверхности до уровня комнаты всё твёрдое (пещера ≤ 1 клетки — цена), жидкости рядом нет — по
// прогруженным чанкам, как и сухой вход (знание карты: режим MAP_SH). S5d s5d-p4-1 (07.10): шахта у входа вскрыла пещеру
// (11 бл.) — тактика рвала подход ×8, refuge 191 с, тело ниже уровня комнаты; капельник рядом — тоже не колонка (s5d-N-1:
// «skewered by a falling stalactite» на 5-й мин). null — колонка годна, иначе причина.
function shaftFlaw (bot, x, z, topY, toY, maxGap = 1) {
  let gap = 0
  for (let y = topY - 1; y >= toY - 1; y--) {
    const b = bot.blockAt(new Vec3(x, y, z))
    if (!b) return 'не прогружено'
    if (/water|lava|bubble_column|pointed_dripstone/.test(b.name)) return b.name
    if (b.boundingBox === 'block') gap = 0
    else if (++gap > maxGap) return `пещера на y ${y}`
    for (const [dx, dz] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
      const s = bot.blockAt(new Vec3(x + dx, y, z + dz))
      if (s && /water|lava|bubble_column|pointed_dripstone/.test(s.name)) return `${s.name} рядом на y ${y}`
      // Первый круг — шахта в сплошной породе: ниже 3 бл. от поверхности стенки целые (s5d-T-1 07.10: шахта шла по краю пещеры,
      // тактика на y 45 увела тело вбок — падение на 24 бл., капельник). Пещера рядом — второй круг.
      if (maxGap <= 1 && y < topY - 3 && s && s.boundingBox !== 'block') return `пустота рядом на y ${y}`
    }
  }
  return null
}
// Штрек от колонки к цели на уровне комнаты — без жидкости рядом (s5d-p7-1: целая колонка, а на уровне комнаты «water у забоя —
// обход» со всех сторон). Прямая с шагом 0.5 бл.; клетки ног и головы, под и над ними и по бокам.
function tunnelFlaw (bot, from, to) {
  const n = Math.max(1, Math.ceil(Math.hypot(to.x - from.x, to.z - from.z) * 2))
  for (let i = 0; i <= n; i++) {
    const x = Math.floor(from.x + (to.x - from.x) * i / n); const z = Math.floor(from.z + (to.z - from.z) * i / n)
    for (let dy = -1; dy <= 2; dy++) {
      for (const [dx, dz] of [[0, 0], [1, 0], [-1, 0], [0, 1], [0, -1]]) {
        const b = bot.blockAt(new Vec3(x + dx, to.y + dy, z + dz))
        if (!b) return 'не прогружено'
        if (/water|lava|bubble_column/.test(b.name)) return `${b.name} на штреке у ${x + dx},${to.y + dy},${z + dz}`
      }
    }
  }
  return null
}
const SOUND_FAR = 48
function dryEntry (bot, shaft, maxR = DRY_FAR, toY = null, to = null) {
  const fromY = bot.entity.position.floored().y
  // Сначала — сухая И целая до комнаты колонка в SOUND_FAR (лишний штрек на уровне комнаты дешевле пещеры в шахте).
  // Второй круг — пещеры до 4 бл. (спуск в них — цена, shaftToBricks), но без жидкости и капельника (s5d-R-1: целой в 48 нет —
  // сухая колонка в пещеру с капельником, «impaled on a stalagmite»).
  for (const maxGap of Number.isFinite(toY) && process.env.ND_SOUND_SHAFT !== '0' && !honestDescent() ? [1, 4] : []) {
    for (let r = 0; r <= Math.min(SOUND_FAR, maxR); r += r < 24 ? 2 : 4) {
      const step = r < 24 ? 2 : 4
      const pts = r === 0 ? [[0, 0]] : []
      for (let d = -r; d < r; d += step) pts.push([d, -r], [r, d], [-d, r], [-r, -d])
      for (const [dx, dz] of pts) {
        const x = shaft.x + dx; const z = shaft.z + dz
        const y = surfaceY(bot, x, z, fromY)
        if (y !== null && !wetColumn(bot, x, z, y) && !shaftFlaw(bot, x, z, y, toY, maxGap) && !(to && tunnelFlaw(bot, { x: x + 0.5, z: z + 0.5 }, to))) return { x, z, r, sound: maxGap <= 1 ? true : 'caves' }
      }
    }
  }
  for (let r = 0; r <= maxR; r += r < 48 ? 2 : 4) {
    const step = r < 48 ? 2 : 4
    const pts = r === 0 ? [[0, 0]] : []
    for (let d = -r; d < r; d += step) pts.push([d, -r], [r, d], [-d, r], [-r, -d])
    for (const [dx, dz] of pts) {
      const x = shaft.x + dx; const z = shaft.z + dz
      const y = surfaceY(bot, x, z, fromY)
      if (y !== null && !wetColumn(bot, x, z, y)) return { x, z, r }
    }
  }
  return null
}

// Самая низкая жидкость в колонке цели и вокруг (±2), сверху вниз до 40 блоков.
function lowestLiquid (bot, x, z, fromY) {
  let low = null
  for (let dx = -2; dx <= 2; dx++) {
    for (let dz = -2; dz <= 2; dz++) {
      for (let y = fromY + 2; y >= fromY - 40; y--) {
        const b = look(bot, new Vec3(x + dx, y, z + dz))
        if (!b) break
        if (/water|lava/.test(b.name)) low = low === null ? y : Math.min(low, y)
      }
    }
  }
  return low
}

// Сухая клетка рядом → шахта вниз под дно → штрек 1x2 под целью → дальше вниз
// тем же shaftToBricks. Штрек копается только там, где вокруг нет жидкости
// (вода в озере над потолком не течёт сквозь блок).
function wetNear (bot, x, y, z, r) {
  for (let dx = -r; dx <= r; dx++) for (let dz = -r; dz <= r; dz++) for (let dy = -3; dy <= 0; dy++) {
    const b = look(bot, new Vec3(x + dx, y + dy, z + dz))
    if (b && /water/.test(b.name)) return true
  }
  return false
}

// Вода в радиусе r от колонки x,z на глубину depth ниже y (озеро под берегом).
function wetNearDeep (bot, x, y, z, r, depth) {
  for (let dx = -r; dx <= r; dx++) for (let dz = -r; dz <= r; dz++) for (let dy = 1; dy >= -depth; dy--) {
    const b = look(bot, new Vec3(x + dx, y + dy, z + dz))
    if (b && /water/.test(b.name)) return true
  }
  return false
}

async function goAround (session, ctl, target, { deadline, far = 20, fromHere = false, fromY = null }: any) {
  const bot = session.bot
  const mcData = session.mcData
  const me = bot.entity.position.floored()
  // fromHere — продолжение начатого обхода (тело уже в своей шахте/штреке от сухой клетки): без поиска и перехода.
  let from = fromHere ? me.clone() : null
  // Шахта пойдёт ниже дна озера: берег проверять на воду на всю эту глубину, а
  // не на 3 блока. Крепость A (-400,1776): озеро 6+ блоков, под берегом вода на
  // y 57–61 — шахта у кромки упиралась «вода у шахты — заложил 0 из 1» (ферма
  // 29.09, room-A-7: 4 из 4 заходов, по 4 вызова одинаково).
  const bottom0 = lowestLiquid(bot, target.x, target.z, me.y)
  const depth = bottom0 !== null ? Math.min(16, Math.max(4, me.y - bottom0 + 3)) : 4
  // Сначала — сухие клетки, до которых точно дойдём (заливка «куда дойду»):
  // выбранная по кругу клетка бывала за озером или на скале — «до сухой клетки
  // не дошёл: Took to long to decide path» (room-A-9).
  try {
    const { walkable } = require('./walkable')
    const dH = q => Math.hypot(q.x - target.x, q.z - target.z)
    const nodes = walkable(bot, bot.entity.position, { radius: 40, maxNodes: 8000 })
      .map(n => n.pos).filter(q => dH(q) >= 2 && dH(q) <= 20).sort((a, c) => dH(a) - dH(c))
    const avoid = session._wetAvoid || []
    const mr = honestDescent() ? 4 : 2
    for (const q of nodes) {
      if (avoid.some(v => Math.hypot(v.x - q.x, v.z - q.z) < 8)) continue
      if (!wetColumn(bot, q.x, q.z, q.y) && !wetNear(bot, q.x, q.y, q.z, mr) && !wetNearDeep(bot, q.x, q.y, q.z, mr, depth)) { from = q.clone(); break }
    }
  } catch {}
  // far > 20 (крепость под морем, S5e 07.10): суша дальше — кольца через 4 бл.; штрек под дном туда длиннее, но это 1–2 мин
  // против «другой крепости кольца» в 2000+ бл.
  if (!from) for (let r = 2; r <= far && !from; r += r < 20 ? 1 : 4) {
    for (let dx = -r; dx <= r && !from; dx += r < 20 ? 1 : 2) {
      for (const dz of [-r, r]) {
        for (const [x, z] of [[target.x + dx, target.z + dz], [target.x + dz, target.z + dx]]) {
          const y = surfaceY(bot, x, z, me.y)
          // Сухо и в 2 блоках вокруг нет воды: с кромки озера вода течёт в шахту,
          // и копка рвётся («не сломал dirt: Digging aborted» — ферма, крепость
          // A, 2 из 5 подходов). Честно — 4 бл. (лестница 2×2 шире шахты 1×1) и не у залитых мест.
          const mr = honestDescent() ? 4 : 2
          if ((session._wetAvoid || []).some(v => Math.hypot(v.x - x, v.z - z) < 8)) continue
          if (y !== null && !wetColumn(bot, x, z, y) && !wetNear(bot, x, y, z, mr) && !wetNearDeep(bot, x, y, z, mr, depth)) { from = new Vec3(x, y, z); break }
        }
        if (from) break
      }
    }
  }
  if (!from) return { ok: false, why: `сухой земли (без воды в 2 блоках) в ${far} блоках нет` }
  const avoidHere = (why): any => { (session._wetAvoid || (session._wetAvoid = [])).push({ x: from.x, z: from.z }); return { ok: false, from: xyz(from), why, wet: true, dug: 0 } }
  if (!fromHere) {
    session._seaDig = { key: `${target.x},${target.z}`, from: xyz(from) }
    const w = await travelXZ(bot, ctl, from.x, from.z, { range: 0, retries: 2, deadline })
    if (!w.ok) return { ok: false, from: xyz(from), why: `до сухой клетки не дошёл: ${w.error}` }
    // Издали вода у клетки могла быть не видна (честно: суждение по видимому) — пришёл, посмотрел: вода в 4 бл. — другое место.
    if (honestDescent()) {
      const f = bot.entity.position.floored()
      if (wetNear(bot, f.x, f.y, f.z, 4) || wetColumn(bot, f.x, f.z, f.y)) return avoidHere('у сухой клетки вблизи вода — другое место')
    }
  }
  // Вниз — ниже дна: дно видно сквозь воду, его и берём (у -3760,-3408
  // озеро было 10 блоков глубиной, и штрек на «суша минус 10» шёл по дну и
  // затопился). Кирпич раньше — тем лучше.
  const start = bot.entity.position.floored()
  const top = Number.isFinite(fromY) ? fromY : start.y
  const bottom = lowestLiquid(bot, target.x, target.z, top)
  const down = await shaftToBricks(session, ctl, { minY: Math.min(top - 10, bottom !== null ? bottom - 4 : Infinity), deadline })
  if ((down as any).wet) return { ...avoidHere(`спуск у сухой клетки залило: ${down.stopped}`), dug: down.dug || 0 }
  let dug = down.dug || 0
  if (down.found) return { ok: true, from: xyz(from), dug, bricks: down }
  if (down.stopped && !/кирпича так и не встретил/.test(down.stopped)) return { ok: false, from: xyz(from), dug, why: down.stopped }
  // Штрек под целью; упёрся в воду над головой — ещё на 6 глубже и снова
  // (прогон у -3760,-3408: штрек на 10 ниже суши шёл под самым дном озера).
  for (let tries = 0; tries < 5; tries++) {
    const r = await tunnelUnder(session, ctl, target, deadline, Math.max(40, Math.ceil(Math.abs(target.x - bot.entity.position.x) + Math.abs(target.z - bot.entity.position.z)) + 20))
    dug += r.dug || 0
    if (r.ok || r.bricks) return { ok: true, from: xyz(from), dug, bricks: r.bricks }
    if (!r.wet || ctl.aborted || gameClock.now() > deadline) return { ok: false, from: xyz(from), dug, why: r.why }
    const cur = bot.entity.position.floored()
    const deeper = await shaftToBricks(session, ctl, { minY: cur.y - 6, deadline })
    dug += deeper.dug || 0
    if (deeper.found) return { ok: true, from: xyz(from), dug, bricks: deeper }
    if (deeper.stopped && !/кирпича так и не встретил/.test(deeper.stopped)) return { ok: false, from: xyz(from), dug, why: deeper.stopped }
  }
  return { ok: false, from: xyz(from), dug, why: 'под водой пройти не вышло и на 30 блоков ниже' }
}

async function tunnelUnder (session, ctl, target, deadline, maxSteps = 40) {
  const bot = session.bot
  const mcData = session.mcData
  let dug = 0
  let wet = false
  for (let steps = 0; steps < maxSteps && !ctl.aborted && gameClock.now() < deadline; steps++) {
    const f = bot.entity.position.floored()
    const ddx = target.x - f.x
    const ddz = target.z - f.z
    if (ddx === 0 && ddz === 0) return { ok: true, dug }
    const axes = Math.abs(ddx) >= Math.abs(ddz)
      ? [[Math.sign(ddx), 0], [0, Math.sign(ddz)]]
      : [[0, Math.sign(ddz)], [Math.sign(ddx), 0]]
    let moved = false
    for (const [sx, sz] of axes) {
      if (!sx && !sz) continue
      const feet = f.offset(sx, 0, sz)
      const head = feet.offset(0, 1, 0)
      if (honestDescent()) {
        // Честно: копать и смотреть; увиденную воду/лаву — заложить; кирпич в забое — пришли.
        const r = await require('./endportal-descent').honestTunnelStep(session, ctl, feet, { bricks: BRICKS, throughBricks: false })
        dug += r.dug || 0
        if (r.brick) return { ok: true, dug, bricks: { found: r.brick, at: xyz(feet), dug } }
        if (r.ok) { moved = true; break }
        if (r.wet || /заложил|вода|water|lava/.test(r.why || '')) wet = true
        continue
      }
      if (wetColumn(bot, feet.x, feet.z, feet.y + 2) === 'лава') continue
      let bad = null
      for (const c of [head, feet]) {
        for (const n of [c, c.offset(1, 0, 0), c.offset(-1, 0, 0), c.offset(0, 0, 1), c.offset(0, 0, -1), c.offset(0, 1, 0)]) {
          const b = bot.blockAt(n)
          if (b && /water|lava/.test(b.name)) bad = b.name
        }
      }
      if (bad) { wet = true; continue }
      let err = null
      for (const c of [head, feet]) {
        const b = bot.blockAt(c)
        if (!b || b.boundingBox === 'empty') continue
        if (BRICKS.test(b.name)) return { ok: true, dug, bricks: { found: b.name, at: xyz(c), dug } }
        const problem = missingHarvestTool(bot, b, mcData)
        if (problem) { err = problem; break }
        try { await equipBestTool(bot, b); await bot.dig(b); dug++ } catch (e) { err = e.message; break }
      }
      if (err) continue
      const t0 = gameClock.now()
      try {
        while (gameClock.now() - t0 < 1500 && !bot.entity.position.floored().equals(feet)) {
          await bot.lookAt(feet.offset(0.5, 1.6, 0.5), true)
          bot.setControlState('forward', true)
          await sleep(50)
        }
      } finally { bot.setControlState('forward', false) }
      if (bot.entity.position.floored().equals(feet)) { moved = true; break }
    }
    if (!moved) return { ok: false, dug, wet, why: wet ? 'над штреком вода' : 'штрек не пошёл: не шагнуть' }
  }
  return { ok: false, dug, why: `штрек не дошёл за ${maxSteps} шагов` }
}

// Открытая вода без берега в 24 блоках (лаборатория 2026-09-27: тело в
// океане, escapeWater 25 с плавал на месте — берега не видно, и goStronghold
// трижды отвечал «не смог выбраться из воды»). Плыть к цели по поверхности,
// пока в 24 блоках не покажется суша (дальше — обычный выход из воды).
// Вплавь к цели через воду: зайти в воду, держать курс и прыжок (всплывать),
// пока не выйдем на сушу (1.5 с не в воде) или не выйдет время.
async function swimAcross (bot, ctl, target, ms = 90000) {
  const { inWater } = require('./movement')
  const t0 = gameClock.now()
  const start = bot.entity.position.clone()
  let dry = 0
  let wasWet = false
  try {
    while (!ctl.aborted && gameClock.now() - t0 < ms) {
      const me = bot.entity.position
      if (Math.hypot(target.x - me.x, target.z - me.z) <= 6) break
      await bot.lookAt(new Vec3(target.x, me.y + 1.2, target.z), true)
      bot.setControlState('forward', true)
      bot.setControlState('jump', true)
      await sleep(250)
      if (inWater(bot)) { wasWet = true; dry = 0 } else if (wasWet) { dry += 250; if (dry >= 1500) break }
      // Не заходит в воду 8 с (обрыв, стена) — стоп.
      if (!wasWet && gameClock.now() - t0 > 8000) break
    }
  } finally { try { bot.clearControlStates() } catch {} }
  return { moved: Math.round(bot.entity.position.distanceTo(start)), seconds: Math.round((gameClock.now() - t0) / 1000), ashore: wasWet && dry >= 1500 }
}

async function swimToward (bot, ctl, target, ms = 90000) {
  const { inWater, findNearestLand } = require('./movement')
  if (!inWater(bot) || findNearestLand(bot, 24)) return { swam: false }
  const t0 = gameClock.now()
  try {
    while (!ctl.aborted && gameClock.now() - t0 < ms && inWater(bot) && !findNearestLand(bot, 24)) {
      const me = bot.entity.position
      await bot.lookAt(new Vec3(target.x, me.y + 1.2, target.z), true)
      bot.setControlState('forward', true)
      bot.setControlState('jump', true)
      await sleep(400)
    }
  } finally {
    try { bot.clearControlStates() } catch {}
  }
  return { swam: true, seconds: Math.round((gameClock.now() - t0) / 1000), land: !!findNearestLand(bot, 24) }
}

// Мост по воде (лаборатория 2026-09-27: в воду pathfinder заходит, а выходит
// плохо — «не смог выбраться из воды» у двух крепостей из трёх). С берега:
// блок в клетку воды перед ногами на уровне опоры (вода заменяется), шаг на
// него крадучись, дальше — пока впереди не суша. Блоков — сколько дадут.
function surfaceWet (bot, x, z, fromY) {
  for (let y = fromY + 6; y >= fromY - 8; y--) {
    const b = bot.blockAt(new Vec3(x, y, z))
    if (!b) return null
    if (/water/.test(b.name)) return true
    if (b.boundingBox === 'block') return false
  }
  return null
}
// Сколько воды на прямой отсюда до цели (по поверхности, шаг 2), и где берег.
// run — длина первой полосы воды; open — берега за ней не видно (вода до края
// прогруженного или до maxDist, а цель дальше).
function waterOnLine (bot, target, maxDist = 96) {
  const me = bot.entity.position
  const dx = target.x - me.x; const dz = target.z - me.z
  const len = Math.hypot(dx, dz) || 1
  const dist = Math.min(maxDist, len)
  let wet = 0; let firstWet = null; let lastDry = 0
  let run = 0; let runEnded = false; let lastT = 0; let lastWet = false
  for (let t = 2; t <= dist; t += 2) {
    const x = Math.floor(me.x + dx / len * t); const z = Math.floor(me.z + dz / len * t)
    const w = surfaceWet(bot, x, z, Math.floor(me.y))
    if (w === null) break
    lastT = t; lastWet = w
    if (w) { wet += 2; if (firstWet === null) firstWet = t; if (!runEnded) run += 2 } else if (firstWet === null) lastDry = t; else runEnded = true
  }
  const open = firstWet !== null && !runEnded && lastWet && lastT < len - 2
  return { wet, firstWet, lastDry, run, open }
}

// Блоков на мост в рюкзаке (без песка и гравия: падают).
function fillerCount (bot) {
  const { FILLER } = require('./build')
  return bot.inventory.items().filter(i => (FILLER.includes(i.name) && !/sand|gravel/.test(i.name)) || /_planks$/.test(i.name)).reduce((n, i) => n + i.count, 0)
}

// Другие крепости кольца 0 — на ±120° от этой (generateRingPositions: spread 3,
// шаг угла 2π/3; радиус у каждой свой, 1408..2688).
function altStrongholds (corner) {
  const ang = Math.atan2(corner.x, corner.z)
  return [2 * Math.PI / 3, -2 * Math.PI / 3].map(d => ({ bearingDeg: Math.round((ang + d) * 180 / Math.PI), ringFrom: 1408, ringTo: 2688 }))
}
async function bridgeAcross (bot, ctl, target, { maxBlocks = 64, deadline = gameClock.now() + 120000 }: any = {}) {
  const { placeBlockAt, pickFiller } = require('./build')
  let placed = 0
  let dryRun = 0
  try {
    bot.setControlState('sneak', true)
    for (let i = 0; i < 300 && !ctl.aborted && gameClock.now() < deadline; i++) {
      const me = bot.entity.position
      const dx = target.x - me.x; const dz = target.z - me.z
      if (Math.hypot(dx, dz) < 3) break
      const [sx, sz] = Math.abs(dx) >= Math.abs(dz) ? [Math.sign(dx), 0] : [0, Math.sign(dz)]
      const feet = me.floored()
      const next = feet.offset(sx, 0, sz)
      const nb = bot.blockAt(next); const hb = bot.blockAt(next.offset(0, 1, 0))
      const under = next.offset(0, -1, 0)
      const ub = bot.blockAt(under)
      if (!nb || !ub) break
      // Стена впереди — мост кончился, дальше ноги.
      if (nb.boundingBox === 'block' || (hb && hb.boundingBox === 'block')) break
      const wetAhead = /water/.test(ub.name) || /water/.test(nb.name) || (ub.boundingBox === 'empty' && /water/.test((bot.blockAt(under.offset(0, -1, 0)) || {}).name || ''))
      if (!wetAhead && ub.boundingBox === 'block') {
        // Суша: ещё три шага суши — и хватит.
        if (++dryRun >= 3) break
      } else {
        dryRun = 0
        if (placed >= maxBlocks || !pickFiller(bot, { steady: true })) return { ok: false, placed, why: 'блоки на мост кончились' }
        if (ub.boundingBox !== 'block') {
          const r = await placeBlockAt(bot, under, { timeoutMs: 1200, steady: true })
          if (!r.ok) return { ok: false, placed, why: `блок в воду не встал: ${r.reason}` }
          if (!r.already) placed++
        }
        // Вода на уровне ног впереди (глубже на блок) — ещё и туда.
        if (/water/.test(nb.name)) {
          const r2 = await placeBlockAt(bot, next, { timeoutMs: 1200, steady: true })
          if (r2.ok && !r2.already) placed++
        }
      }
      // Шаг вперёд.
      const t0 = gameClock.now()
      const goal = (/water/.test(nb.name) ? next.offset(0, 1, 0) : next)
      while (gameClock.now() - t0 < 1800 && !bot.entity.position.floored().equals(goal) && !bot.entity.position.floored().equals(next)) {
        await bot.lookAt(goal.offset(0.5, 1.6, 0.5), true).catch(() => {})
        bot.setControlState('forward', true)
        if (/water/.test(nb.name)) bot.setControlState('jump', true)
        await sleep(50)
      }
      bot.setControlState('forward', false)
      bot.setControlState('jump', false)
    }
  } finally {
    try { bot.clearControlStates() } catch {}
  }
  return { ok: true, placed }
}

// Прорубиться к цели на несколько блоков (джунгли: тело встаёт в кустах и
// листве, pathfinder «success», а тело стоит — лаборатория, прогон 9, 6 минут
// на одном месте). Ноги и голова впереди — сломать (листва — мгновенно), шаг.
async function chopToward (bot, ctl, mcData, target, steps = 6) {
  let moved = 0
  for (let i = 0; i < steps && !ctl.aborted; i++) {
    const me = bot.entity.position
    const dx = target.x - me.x; const dz = target.z - me.z
    const [sx, sz] = Math.abs(dx) >= Math.abs(dz) ? [Math.sign(dx), 0] : [0, Math.sign(dz)]
    const feet = me.floored()
    const next = feet.offset(sx, 0, sz)
    let up = 0
    // Ступенька: впереди блок, над ним воздух — шагнуть вверх.
    const nb = bot.blockAt(next)
    if (nb && nb.boundingBox === 'block' && !/leaves|log|vine|bush|grass|fern|bamboo/.test(nb.name)) {
      const a1 = bot.blockAt(next.offset(0, 1, 0)); const a2 = bot.blockAt(next.offset(0, 2, 0))
      if (a1 && a1.boundingBox === 'empty' && a2 && a2.boundingBox === 'empty') up = 1
    }
    const goal = next.offset(0, up, 0)
    for (const c of [goal, goal.offset(0, 1, 0), feet.offset(0, 2, 0)]) {
      const b = bot.blockAt(c)
      if (!b || b.boundingBox === 'empty') continue
      if (/water|lava/.test(b.name)) return moved
      if (missingHarvestTool(bot, b, mcData)) return moved
      try { await equipBestTool(bot, b); await bot.dig(b) } catch { return moved }
    }
    const t0 = gameClock.now()
    try {
      while (gameClock.now() - t0 < 1500 && !bot.entity.position.floored().equals(goal)) {
        await bot.lookAt(goal.offset(0.5, 1.6, 0.5), true)
        bot.setControlState('forward', true)
        if (up) bot.setControlState('jump', true)
        await sleep(50)
      }
    } finally { bot.setControlState('forward', false); bot.setControlState('jump', false) }
    if (!bot.entity.position.floored().equals(goal)) return moved
    moved++
  }
  return moved
}

// Дойти до точки: отрезками по 24; на прямой вода — мост; застрял — nether.walkToward
// (обход вбок и штрек).
async function walkOrBridge (session, ctl, corner, deadline) {
  const bot = session.bot
  const legs = []
  let bridged = 0
  let boats = 0
  // Сторож хода: витки без сдвига на 1 бл. — не крутить 40 пустых витков за миг (s5e-A-4 07.10: у воды над лестницей «время
  // вышло» в каждом вызове за 0 с, 25 мин пауз этапа).
  let idle = 0
  let lastAt = null
  for (let k = 0; k < 40 && !ctl.aborted && gameClock.now() < deadline; k++) {
    const me = bot.entity.position
    const dist = Math.hypot(corner.x - me.x, corner.z - me.z)
    if (dist <= 8) return { ok: true, legs, bridged }
    if (lastAt && me.distanceTo(lastAt) < 1) { if (++idle >= 4) return { ok: false, legs, bridged, error: `хода нет: ${idle} витков на месте у ${Math.round(me.x)},${Math.round(me.y)},${Math.round(me.z)} (${Math.round(dist)} бл. до цели)` } } else idle = 0
    lastAt = me.clone()
    const wl = waterOnLine(bot, corner, 96)
    if (wl.firstWet !== null && wl.firstWet <= 6) {
      // Мост — через реку и озеро. Море (берега не видно, 24+ блоков) или воды
      // больше, чем блоков, — не начинать (лаборатория 2026-09-27: крепость под
      // морем, 40 блоков моста в воду и стоп посреди моря в 215 блоках от неё).
      const have = fillerCount(bot)
      if (wl.open && wl.run >= 24) {
        // Море или большое озеро — лодкой, как спидраннеры (ride.js: сделать из 5
        // досок, спустить, плыть к цели, у берега высадка и лодку с собой).
        // Ферма, крепость A: с севера к ней «воды 94–96+ блоков по прямой».
        if (boats < 3 && !ctl.aborted && gameClock.now() < deadline - 30000) {
          boats++
          const before = bot.entity.position.clone()
          let r = null
          try { r = await require('./ride').run(session, ctl, { kind: 'boat', mode: 'go', x: corner.x, z: corner.z, timeoutSeconds: Math.max(30, Math.min(240, Math.round((deadline - gameClock.now()) / 1000) - 10)) }) } catch (e) { r = { stopped: e.message } }
          const moved = Math.round(bot.entity.position.distanceTo(before))
          legs.push({ boat: true, moved, arrived: !!(r && r.arrived), stopped: r && r.stopped })
          log('лодкой', { moved, arrived: !!(r && r.arrived), stopped: r && r.stopped })
          if (moved >= 16) continue
          // Лодку не спустить (у берега мелко, открытой воды в 4 блоках нет) —
          // вплавь поперёк озера, как человек: поверху, прыжком держаться у
          // поверхности, до суши на том берегу (ферма, крепость A: над портальной
          // комнатой озеро ~100 блоков, лодка «спустить некуда» в 2 из 5).
          const sw = await swimAcross(bot, ctl, corner, Math.min(120000, Math.max(0, deadline - gameClock.now() - 20000)))
          legs.push({ swim: true, ...sw })
          log('вплавь', sw)
          if (sw.moved >= 16) continue
        }
        legs.push({ sea: wl.run, open: wl.open, have })
        return { ok: false, legs, bridged, sea: { run: wl.run, open: wl.open, have }, error: `впереди море: воды ${wl.run}+ блоков по прямой, берега не видно (блоков на мост ${have})` }
      }
      const bridgeFailed = legs.some(l => l.bridge !== undefined && !l.ok)
      if (wl.run > have - 6 || bridgeFailed) {
        // Озеро шире, чем блоков, но тот берег виден (прогон 20: «вода 44, блоков
        // 40» — стоп, а прогон 12 отсюда же дошёл): на тот берег ногами —
        // pathfinder обойдёт или переплывёт; не вышло — выбраться и в обход.
        const me2 = bot.entity.position
        const d2 = Math.hypot(corner.x - me2.x, corner.z - me2.z) || 1
        const far = Math.min(d2, wl.firstWet + wl.run + 4)
        const fx = Math.round(me2.x + (corner.x - me2.x) / d2 * far)
        const fz = Math.round(me2.z + (corner.z - me2.z) / d2 * far)
        const w = await require('./nether').guarded(session, ctl, sub => travelXZ(bot, sub, fx, fz, { range: 3, retries: 1, deadline: Math.min(deadline, gameClock.now() + 90000) }))
        legs.push({ acrossWater: wl.run, to: { x: fx, z: fz }, ok: w.ok, error: w.ok ? undefined : w.error })
        if (!w.ok) {
          const { inWater, escapeWater } = require('./movement')
          if (inWater(bot)) await escapeWater(bot, ctl, { timeoutMs: 20000 })
          if (legs.filter(l => l.acrossWater && !l.ok).length >= 2) return { ok: false, legs, bridged, error: `впереди вода ${wl.run} блоков (блоков на мост ${have}): ни обойти, ни переплыть не вышло — ${w.error}` }
        }
        continue
      }
      const b = await bridgeAcross(bot, ctl, corner, { maxBlocks: 64, deadline: Math.min(deadline, gameClock.now() + 120000) })
      bridged += b.placed
      legs.push({ bridge: b.placed, ok: b.ok, why: b.why })
      // Мост не встал (глубоко, не к чему прислонить блок; прогон 23) — дальше
      // ногами/вплавь на тот берег (ветка выше), без второго моста.
      if (!b.ok && /кончились/.test(b.why || '')) return { ok: false, legs, bridged, error: b.why }
      continue
    }
    const step = wl.firstWet !== null ? Math.min(36, Math.max(3, wl.firstWet - 3)) : Math.min(24, dist)
    const tx = Math.round(me.x + (corner.x - me.x) / dist * step)
    const tz = Math.round(me.z + (corner.z - me.z) / dist * step)
    // Под охраной: ударили по дороге (джунгли: зомби, скелеты) — бой и дальше.
    const w = await require('./nether').guarded(session, ctl, sub => travelXZ(bot, sub, tx, tz, { range: 2, retries: 1, deadline: Math.min(deadline, gameClock.now() + 40000) }))
    if (w.fought) { legs.push({ fought: w.fought }); if ((bot.health ?? 20) < 8) { try { await require('./actions').eat(session, {}) } catch {} } continue }
    legs.push({ to: { x: tx, z: tz }, ok: w.ok, error: w.ok ? undefined : w.error })
    if (!w.ok) {
      const { inWater, escapeWater } = require('./movement')
      if (inWater(bot)) await escapeWater(bot, ctl, { timeoutMs: 20000 })
      // Не сдвинулись с места — прорубиться вперёд.
      if (bot.entity.position.distanceTo(me) < 2) {
        const c = await chopToward(bot, ctl, session.mcData, corner, 8)
        legs.push({ chop: c })
        if (c >= 2) continue
      }
      // Обход вбок отрезками и штрек (nether.walkToward) — к самой цели, а не к
      // концу отрезка: для цели ближе 24 он ничего не делает.
      const nw = await require('./nether').walkToward(session, ctl, { x: corner.x, y: Math.floor(bot.entity.position.y), z: corner.z }, Math.min(deadline, gameClock.now() + 90000), { range: 6, xz: true })
      legs.push({ around: true, ok: !!(nw && nw.ok) })
      if (legs.filter(l => l.around && !l.ok).length >= 3) return { ok: false, legs, bridged, error: w.error }
    }
  }
  const me = bot.entity.position
  return { ok: Math.hypot(corner.x - me.x, corner.z - me.z) <= 10, legs, bridged, error: 'время вышло' }
}

// Крепость под морем: у лестницы старта (угол+4) поверхность — вода, и сухой
// земли в 14 блоках нет (goAround копать не с чего). Другие две крепости
// кольца 0 — на ±120° от этой (generateRingPositions: spread 3, шаг угла 2π/3;
// радиус у каждой свой, 1408..2688), их ищут оком оттуда.
function oceanAt (bot, corner) {
  const x = corner.x + 4; const z = corner.z + 4
  const y0 = Math.floor(bot.entity.position.y)
  const wet = surfaceWet(bot, x, z, y0)
  if (wet !== true) return null
  for (let r = 2; r <= 14; r++) {
    for (let d = -r; d <= r; d++) {
      for (const [a, b] of [[x + d, z - r], [x + d, z + r], [x - r, z + d], [x + r, z + d]]) {
        if (surfaceWet(bot, a, b, y0) === false) return null
      }
    }
  }
  return { ocean: true, alternatives: altStrongholds(corner) }
}

// Над головой до высоты мира — ни одного твёрдого блока (небо).
function skyAbove (bot) {
  const f = bot.entity.position.floored()
  for (let y = f.y + 2; y < f.y + 80; y++) {
    const b = bot.blockAt(new Vec3(f.x, y, f.z))
    if (!b) return true
    if (b.boundingBox === 'block') return false
  }
  return true
}

// Локальная безопасность перед каждым шагом штрека к известной комнате.
// Жидкости как в mining.danger: проверить до вскрытия стены, неизвестное — отказ.
function mappedStepRisk (bot, cell) {
  for (const dy of [0, 1]) {
    const b = bot.blockAt(cell.offset(0, dy, 0))
    if (!b) return 'чанк не прогружен'
    if (/end_portal|spawner|infested|bedrock|fire|powder_snow/.test(b.name)) return `${b.name} в забое — обход`
  }
  for (let dy = -1; dy <= 2; dy++) {
    for (const [dx, dz] of [[0, 0], [1, 0], [-1, 0], [0, 1], [0, -1]]) {
      const b = bot.blockAt(cell.offset(dx, dy, dz))
      if (!b) return 'чанк не прогружен'
      if (/water|lava|bubble_column/.test(b.name)) return `${b.name} у забоя — обход`
    }
  }
  const floor = bot.blockAt(cell.offset(0, -1, 0))
  if (/pointed_dripstone|magma_block|cactus|end_portal|campfire/.test(floor.name)) return `${floor.name} под ногами — обход`
  return null
}

async function goMappedRoom (session, ctl, room, deadline) {
  const bot = session.bot
  const original = bot.dig
  const visibleDig = function (block, ...args: any[]) {
    // Заражённый — только при хп ≥ 12 (цена — чешуйница, см. shaftToBricks); рамки и спавнер комнаты — никогда.
    if (!block || /end_portal|spawner/.test(block.name) || (/infested/.test(block.name) && (bot.health ?? 20) < 12) || !seesBlock(bot, block)) return Promise.reject(new Error('забой не виден в прицеле или блок комнаты защищён'))
    return original.call(bot, block, ...args)
  }
  bot.dig = visibleDig
  try { return await goMappedRoomBody(session, ctl, room, deadline) } finally { if (bot.dig === visibleDig) bot.dig = original }
}

async function goMappedRoomBody (session, ctl, room, deadline) {
  const bot = session.bot
  const plan = require('./stronghold').roomApproach(room, bot.entity.position)
  const target = new Vec3(plan.target.x, plan.target.y, plan.target.z)
  const walks = []
  // Под землёй дальше 56 бл. от колонки шахты (целая колонка — в 48; выход из Ада в пещеру: s5d-p5-1 07.10 — шахта прямо из пещеры в 80 бл. от комнаты,
  // вода на y 20 и зомби, смерть на 6-й мин) — сперва наверх, потом сухая и целая колонка как обычно.
  if (!skyAbove(bot) && bot.entity.position.y > target.y + 2 && Math.hypot(plan.shaft.x + 0.5 - bot.entity.position.x, plan.shaft.z + 0.5 - bot.entity.position.z) > 56 &&
    process.env.ND_SHAFT_SURFACE !== '0') {
    const up = await require('./survival/surface-body').surface(session, ctl, { timeoutSeconds: Math.max(20, Math.min(90, Math.round((deadline - gameClock.now()) / 1000) - 30)), preferPillar: true }).catch(e => ({ ok: false, error: e.message }))
    walks.push({ surface: !!(up && (up.ok || up.surfaced)), y: Math.round(bot.entity.position.y) })
  }
  // На поверхности сначала выбираем сухую колонку вне комнаты. При повторном
  // вызове из шахты продолжаем с текущей высоты и не возвращаемся наверх.
  // Неба не видно (крона над выходом из Ада, s5d-p7-1), но до колонки шахты дальше 56 бл. — тоже «наверху»: выбор колонки.
  const farShaft = Math.hypot(plan.shaft.x + 0.5 - bot.entity.position.x, plan.shaft.z + 0.5 - bot.entity.position.z) > 56
  if (bot.entity.position.y > target.y + 2 && (skyAbove(bot) || farShaft) && bot.entity.position.y >= 55) {
    // Сухой вход — ещё с суши, по прогруженным чанкам, до DRY_FAR бл. от входа комнаты (s5c-f1-1, 06.10: комната под
    // океаном у монумента — лодкой к точке над комнатой, сухого в 14 бл. нет, тело в воде у стражей погибло). Дальний
    // сухой вход — шахта там и штрек на уровне комнаты под дном (mappedStepRisk обходит воду и лаву).
    let dry = dryEntry(bot, plan.shaft, DRY_FAR, target.y, target)
    if (!dry) {
      const w = await walkOrBridge(session, ctl, plan.shaft, deadline)
      if (!w.ok) return { went: false, mapped: true, stopped: `к сухому входу комнаты не дошёл: ${w.error}` }
      dry = dryEntry(bot, plan.shaft, DRY_FAR, target.y, target)
    }
    if (!dry) return { went: false, mapped: true, stopped: `над комнатой вода/лава: сухой вход в ${DRY_FAR} бл. не найден` }
    if (Math.hypot(dry.x + 0.5 - bot.entity.position.x, dry.z + 0.5 - bot.entity.position.z) > 8) {
      const w = await walkOrBridge(session, ctl, dry, deadline)
      walks.push({ to: { x: dry.x, z: dry.z }, ok: w.ok, fromShaft: dry.r })
      if (!w.ok) return { went: false, mapped: true, walks, stopped: `к сухому входу (${dry.r} бл. от комнаты) не дошёл: ${w.error}` }
    }
    const approach = await travelXZ(bot, ctl, dry.x, dry.z, { range: 0, retries: 1, deadline })
    walks.push({ to: dry, ok: approach.ok })
    if (!approach.ok) return { went: false, mapped: true, walks, stopped: `до сухой колонки не дошёл: ${approach.error}` }
  }
  const descent = await shaftToBricks(session, ctl, { minY: target.y, targetY: target.y, deadline })
  if (!descent.reached) return { went: false, mapped: true, descent, stopped: descent.stopped }
  const level = bot.entity.position.floored().y
  const seen = new Set()
  let dug = descent.dug
  const dirs = [[1, 0, 'east'], [-1, 0, 'west'], [0, 1, 'south'], [0, -1, 'north']]
  const key = c => `${c.x},${c.y},${c.z}`
  let stopped = null
  // К комнате прямо на её высоте. Лава/вода — обойти по сухому на этом же
  // уровне; пустота — твёрдая подпорка перед шагом, никакого падения к лаве.
  for (let i = 0; i < 260 && !ctl.aborted && gameClock.now() < deadline; i++) {
    const feet = bot.entity.position.floored()
    if (feet.y !== level) { stopped = 'сбило с уровня комнаты — нужен новый подход'; break }
    if (feet.x === target.x && feet.z === target.z) return { went: true, inside: true, mapped: true, room: room.centre, target: xyz(target), dug, walks }
    seen.add(key(feet))
    const candidates = dirs.map(([dx, dz, direction]) => ({ cell: feet.offset(dx, 0, dz), direction }))
      .filter(c => !seen.has(key(c.cell)))
      .sort((a, b) => a.cell.distanceTo(target) - b.cell.distanceTo(target))
    let moved = false
    for (const { cell, direction } of candidates) {
      if (honestDescent()) {
        // Честно: без заглядывания в толщу — копать видимое, увиденную жидкость заложить, пустоту под ногами — мостом.
        const r = await require('./nether').guarded(session, ctl, sub => require('./endportal-descent').honestTunnelStep(session, sub, cell, { bricks: BRICKS, throughBricks: true }))
        dug += r.dug || 0
        if (bot.entity.position.floored().equals(cell)) { moved = true; walks.push({ to: xyz(cell) }); break }
        stopped = r.why || r.stopped || r.error || `шаг штрека ${direction} не выполнен`
        if (r.fought || ctl.aborted) break
        continue
      }
      stopped = mappedStepRisk(bot, cell)
      if (stopped) continue
      const floor = cell.offset(0, -1, 0)
      if (bot.blockAt(floor).boundingBox !== 'block') {
        const build = require('./build')
        const fill = build.pickFiller(bot, { steady: true })
        if (!fill) { stopped = 'пустота: нет твёрдых блоков на пол'; continue }
        const b = await build.placeBlockAt(bot, floor, { item: fill.name, timeoutMs: Math.min(2000, Math.max(1, deadline - gameClock.now())) })
        if (!b.ok) { stopped = `пустота: не поставил опору (${b.reason})`; continue }
      }
      // Видимость проверяет обёртка каждого dig: голова сначала открывает ноги.
      if (require('./tunnel').lowPicks(bot) < 2) await require('./tunnel').restockPicks(session, ctl, 2).catch(() => 0)
      const r = await require('./nether').guarded(session, ctl, () => digStepInto(bot, session.mcData, cell))
      dug += r.dug || 0
      if (bot.entity.position.floored().equals(cell)) { moved = true; walks.push({ to: xyz(cell) }); break }
      stopped = r.why || r.stopped || r.error || `шаг штрека ${direction} не выполнен`
      if (r.fought || ctl.aborted) break
    }
    if (!moved) break
  }
  return { went: false, mapped: true, dug, walks, room: room.centre, stopped: ctl.aborted ? 'прервано' : gameClock.now() >= deadline ? 'время вышло' : stopped || 'прямой штрек к комнате не закончен' }
}

// Сухая по видимому колонка для шахты: кольца rMin..rMax от center (16 точек на кольцо), ближе к prefer; поверхность видна, воды
// у неё нет и в 4 бл. вокруг; дальше 8 бл. от мест, где спуск уже залило (avoid). null — нет.
function pickDryShaft (bot, center, prefer, avoid = [], rMin = 5, rMax = 24) {
  const me = bot.entity.position
  for (let r = rMin; r <= rMax; r += 2) {
    const ring = []
    for (let a = 0; a < 16; a++) ring.push({ x: Math.round(center.x + r * Math.sin(a * Math.PI / 8)), z: Math.round(center.z + r * Math.cos(a * Math.PI / 8)) })
    ring.sort((p1, p2) => Math.hypot(p1.x - prefer.x, p1.z - prefer.z) - Math.hypot(p2.x - prefer.x, p2.z - prefer.z))
    for (const c of ring) {
      if (avoid.some(v => Math.hypot(v.x - c.x, v.z - c.z) < 8)) continue
      const y = surfaceY(bot, c.x, c.z, Math.floor(me.y))
      if (y !== null && !wetColumn(bot, c.x, c.z, y) && !wetNear(bot, c.x, y, c.z, 4)) return c
    }
  }
  return null
}

async function goStronghold (session, ctl, p: any = {}) {
  const bot = session.bot
  const t0 = gameClock.now()
  const deadline = t0 + clamp(p.timeoutSeconds ?? 300, 30, 600) * 1000 - 4000
  if (worlds.worldOf(bot) !== 'overworld') {
    return { went: false, stopped: `крепость — в верхнем мире, а я ${worlds.inWorld(worlds.worldOf(bot))}: сначала портал (mc_portal mode=enter)` }
  }
  const rec = placeOf(session, PLACE)
  if (!rec) return { went: false, stopped: 'крепости в памяти нет — сначала mc_stronghold mode=find (два ока и пересечение лучей)' }
  const mapped = process.env.ND_ROOM_MAP !== '0' && require('./stronghold').mappedRoom(rec)
  if (mapped) return goMappedRoom(session, ctl, mapped, deadline)
  // Уже дошёл до кирпича этой крепости и под землёй рядом (findRoom зовёт go, когда кирпича не видно — из своего штрека к
  // приманке): новый спуск не начинать (s5e-F-1 07.10: «обход воды: продолжаю из своей шахты» из штрека у комнаты — ещё 6 бл. вниз).
  const ent = rec.entered
  if (honestDescent() && ent && Number.isFinite(ent.y) && Math.hypot(bot.entity.position.x - ent.x, bot.entity.position.z - ent.z) <= 96 && bot.entity.position.y < ent.y + 12 && !skyAbove(bot)) {
    return { went: true, already: true, inside: true, corner: { x: rec.x, z: rec.z }, at: xyz(bot.entity.position.floored()), bricks: { name: 'entered', at: ent }, dug: 0, seconds: 0 }
  }

  // --- 1. дойти до точки из памяти
  let corner = { x: rec.x, z: rec.z }
  const walks = []
  let seaAround = null
  // Начатый обход воды над лестницей (шахта у сухой клетки, штрек под дном) — продолжить отсюда, а не идти поверху к лестнице
  // (s5e-P-2 07.10: после обрыва тактикой каждый вызов — walkOrBridge из своей шахты, «хода нет» ×N).
  const sd = session._seaDig
  if (sd && sd.key === `${corner.x + 4},${corner.z + 4}` && Math.hypot(bot.entity.position.x - sd.from.x - 0.5, bot.entity.position.z - sd.from.z - 0.5) <= 10 &&
    bot.entity.position.y < sd.from.y - 1 && !ctl.aborted) {
    const st = await goAround(session, ctl, { x: corner.x + 4, z: corner.z + 4 }, { deadline, far: 96, fromHere: true, fromY: sd.from.y })
    walks.push({ seaResume: sd.from, ok: st.ok, why: st.why, dug: st.dug })
    log('обход воды: продолжаю из своей шахты', { ok: st.ok, why: st.why, dug: st.dug })
    if (st.ok) seaAround = st
  }
  // Место шахты по «пирогу» уже выбрано (сухое, у портальной комнаты) — идти туда, а не к лестнице старта (s5e-B-2 07.10: после
  // обрыва спуска тактикой вызов шёл к лестнице под озером — «крепость под морем» ×N).
  const pd0 = session._pieDig && session._pieDig.key === `${corner.x},${corner.z}` && (session._pieDig.est || session._pieDig.dry) ? session._pieDig : null
  const walkTarget = pd0 ? { x: pd0.shaft.x - 4, z: pd0.shaft.z - 4 } : corner
  const far = seaAround ? 0 : Math.hypot(bot.entity.position.x - walkTarget.x - 4, bot.entity.position.z - walkTarget.z - 4)
  // Ближе 16 — уже у лестницы (дальше — бросок ока и шахта): walkOrBridge у воды над лестницей крутился на месте (s5e-A-4).
  if (far > 16 && pd0) {
    const w = await walkOrBridge(session, ctl, pd0.shaft, deadline)
    walks.push({ toPieShaft: pd0.shaft, ok: w.ok, error: w.error })
    if (!w.ok) return { went: false, walks, stopped: `до места шахты у портальной комнаты не дошёл: ${w.error}` }
  } else if (far > 16) {
    const sw = await swimToward(bot, ctl, corner, Math.min(120000, Math.max(0, deadline - gameClock.now() - 30000)))
    if (sw.swam) walks.push({ swam: sw })
    const w = await walkOrBridge(session, ctl, corner, deadline)
    walks.push({ to: corner, ok: w.ok, error: w.error, bridged: w.bridged || undefined, legs: w.legs.length })
    let sea = oceanAt(bot, corner)
    // Крепость под морем (S5e 07.10, замечание (в) к S5d: сид −7145914149339214824 — «впереди вода 46 бл.» ×N, 35 мин вышли):
    // как человек — с ближней суши (до 96 бл.) шахтой вниз и штреком под дном к лестнице старта (честно: увиденную воду — заложить).
    // ND_SEA_TUNNEL=0 — прежний отказ («другая крепость кольца»).
    if ((sea || (w.sea && w.sea.open)) && process.env.ND_SEA_TUNNEL !== '0' && !ctl.aborted && gameClock.now() < deadline - 60000) {
      const st = await goAround(session, ctl, { x: corner.x + 4, z: corner.z + 4 }, { deadline, far: 96 })
      walks.push({ seaTunnel: st.from, ok: st.ok, why: st.why, dug: st.dug })
      log('крепость под водой — с суши штреком', { ok: st.ok, from: st.from, why: st.why, dug: st.dug })
      if (st.ok) { sea = null; seaAround = st }
    }
    if (!sea && w.sea && w.sea.open && !walks.some(x => x.seaTunnel && x.ok)) {
      const alt = altStrongholds(corner)
      return {
        went: false,
        walks,
        ocean: { ocean: true, onTheWay: w.sea, alternatives: alt },
        awayBlocks: Math.round(Math.hypot(bot.entity.position.x - corner.x, bot.entity.position.z - corner.z)),
        stopped: `на прямой к крепости море: воды ${w.sea.run}+ блоков, берега не видно, блоков на мост ${w.sea.have}. Крепость под морем или за ним — моста не хватит. Другие крепости кольца 0 — на ${alt.map(a => a.bearingDeg + '°').join(' и ')} от 0,0 (радиус 1408..2688): туда и бросать око (через Незер путь в 8 раз короче); или обойти воду берегом`
      }
    }
    if (sea) {
      return {
        went: false,
        walks,
        ocean: sea,
        stopped: `крепость под морем: над лестницей старта вода, сухой земли в 14 блоках нет — копать не с чего. Другие крепости кольца 0 — на ${sea.alternatives.map(a => a.bearingDeg + '°').join(' и ')} от 0,0 (радиус 1408..2688): туда и бросать око`
      }
    }
    if (!w.ok && !seaAround) {
      return {
        went: false,
        walks,
        awayBlocks: Math.round(Math.hypot(bot.entity.position.x - corner.x, bot.entity.position.z - corner.z)),
        stopped: `до крепости не дошёл: ${w.error}. Позови ещё раз — пойду с того же места`
      }
    }
  }

  // --- 2. уточнить оком: ближе 12 блоков оно летит в точный угол чанка старта.
  const throws = []
  let refined = !!rec.refined
  if (!refined && !seaAround && !pd0 && p.refine !== false && itemNamed(bot, 'ender_eye')) {
    const stronghold = require('./stronghold')
    for (let i = 0; i < 4 && !ctl.aborted && gameClock.now() < deadline; i++) {
      const t = await stronghold.throwEye(session, ctl)
      throws.push({ from: t.from, landed: t.landed, flew: t.flew, bearingDeg: t.bearingDeg, below: t.below, broke: t.broke })
      if (!t.thrown) break
      if (t.flew < 11) {
        corner = { x: Math.floor(t.landed.x), z: Math.floor(t.landed.z) }
        refined = true
        break
      }
      // Улетело на полные 12 — до угла дальше 12: пройти за ним и бросить снова.
      if (t.bearing === null || t.bearing === undefined) break
      const tx = Math.round(bot.entity.position.x + Math.sin(t.bearing) * 12)
      const tz = Math.round(bot.entity.position.z + Math.cos(t.bearing) * 12)
      const w = await travelXZ(bot, ctl, tx, tz, { range: 2, retries: 2, deadline })
      walks.push({ to: { x: tx, z: tz }, ok: w.ok, error: w.error })
      if (!itemNamed(bot, 'ender_eye')) break
    }
    if (refined) {
      savePlace(session, PLACE, { x: corner.x, z: corner.z, dimension: 'overworld', refined: true, note: 'угол стартового чанка по оку (±2): лестница старта у x+2..x+6, z+2..z+6, ниже y≈50' },
        `уточнил оком: угол чанка старта ${corner.x},${corner.z}`)
    }
  }

  // --- 3. вниз у лестничной башни старта — или сразу у портальной комнаты, если её спавнер виден «пирогом» F3 с поверхности
  // (как спидраннеры: pie-ray). Два пеленга (здесь и в 10 бл. вбок) → пересечение; в 80 бл. от лестницы — шахта в 5 бл. от оценки
  // в сторону лестницы (не в лаву под рамками). Дальний спавнер (заброшенная шахта, данж) — мимо. ND_PIE_DIG=0 — у лестницы.
  let shaft = { x: corner.x + 4, z: corner.z + 4 }
  const sky0 = skyAbove(bot)
  // Решение «где копать» — одно на крепость (повторный вызов после обрыва тактикой не ходит снова за пеленгами: s5e-P-1 07.10 —
  // 20 вызовов, каждый с отходом на 10 бл.).
  const pieKey = `${corner.x},${corner.z}`
  if (session._pieDig && session._pieDig.key === pieKey) shaft = session._pieDig.shaft
  else if (honestDescent() && process.env.ND_PIE_DIG !== '0' && sky0 && !seaAround && !ctl.aborted && gameClock.now() < deadline - 60000) {
    session._pieDig = { key: pieKey, shaft }
    try {
      const S = require('./perception/senses')
      const sample = () => { const a = S.pieArcs(bot, 'spawner', { fov: 20, step: 2 }); return a.length && !a[0].all && a[0].center !== null ? { x: bot.entity.position.x, z: bot.entity.position.z, yaw: a[0].center } : null }
      const s1 = sample()
      if (s1) {
        const v = S.vecOf(s1.yaw)
        const w = await travelXZ(bot, ctl, Math.round(s1.x - v.z * 10), Math.round(s1.z + v.x * 10), { range: 2, retries: 1, deadline: Math.min(deadline, gameClock.now() + 30000) })
        const s2 = w.ok ? sample() : null
        const est = s2 ? S.triangulate([s1, s2]) : null
        const off = est ? Math.hypot(est.x - shaft.x, est.z - shaft.z) : null
        log('«пирог» с поверхности: спавнер', { s1: s1.yaw, s2: s2 && s2.yaw, est, fromStairs: off && Math.round(off) })
        if (est && est.spread <= 4 && off <= 80) {
          // Высота спавнера — «пирогом» по вертикали; колонка шахты — сухая по видимому (нет воды в 4 бл. на поверхности), в 5–24 бл.
          // от оценки, ближе к лестнице (вода у лестницы: s5e-Q-1/R-1 — лестница у озера затопилась). Спуск — до этой высоты, потом
          // штрек к оценке (без поиска по коридорам).
          const me = bot.entity.position
          const el = require('./endportal-descent').pieElevation(bot, Math.hypot(est.x - me.x, est.z - me.z))
          const stairs = { x: corner.x + 4, z: corner.z + 4 }
          const pick = pickDryShaft(bot, est, stairs, session._wetAvoid || [])
          const k = off > 6 ? 5 / off : 0
          shaft = pick || { x: Math.round(est.x + (shaft.x - est.x) * k), z: Math.round(est.z + (shaft.z - est.z) * k) }
          session._pieDig = { key: pieKey, shaft, est, y: el ? el.y : null }
          walks.push({ pie: { est: { x: est.x, z: est.z }, y: el && el.y, shaft, dry: !!pick } })
          log('«пирог» с поверхности: копаю у оценки', { est: { x: est.x, z: est.z }, y: el && el.y, shaft, dry: !!pick })
        }
      }
    } catch (e) { log('«пирог» с поверхности: ошибка', { error: e.message }) }
  }
  const minY = (bot.game && Number.isFinite(bot.game.minY) ? bot.game.minY : -64) + 6
  let around = null
  // Уже в своей шахте под землёй (второй вызов после «пещера под ногами»):
  // поверхность отсюда не видна, и прежняя проверка находила воду пещеры —
  // «над лестницей старта вода» три вызова подряд (лаборатория, прогон 10).
  const me3 = bot.entity.position
  // Своя шахта открыта в небо — «под землёй» по высоте: ниже уровня моря.
  // В воде (у кромки озера над лестницей) — не «своя шахта»: иначе второй и
  // следующие вызовы копали прямо у воды без обхода (room-A-7: «вода у шахты —
  // заложил 0 из 1» четыре вызова подряд).
  const wetMe = !seaAround && ([0, 1].some(dy => { const b = bot.blockAt(me3.offset(0, dy, 0)); return !!b && /water/.test(b.name) }) || wetNear(bot, me3.x, me3.y + 1, me3.z, 1))
  // Своя винтовая лестница (честный спуск начат здесь же, тело ниже её начала) — «под землёй», даже если в неё натекла вода.
  const own = session._ownShaft
  const inOwn = !!own && own.key === `${corner.x},${corner.z}` && Math.hypot(me3.x - own.x, me3.z - own.z) <= 4 && me3.y < own.y - 2
  const underground = inOwn || (!wetMe && Math.hypot(me3.x - shaft.x - 0.5, me3.z - shaft.z - 0.5) <= 3 && (me3.y < 55 || !skyAbove(bot)))
  const topY = underground || seaAround ? me3.floored().y : surfaceY(bot, shaft.x, shaft.z, bot.entity.position.floored().y)
  const wet = underground || seaAround ? null : session._wetStairs === pieKey && !(session._pieDig && session._pieDig.key === pieKey && session._pieDig.est) ? 'вода (спуск залило)'
    : (topY === null ? 'нет суши' : wetColumn(bot, shaft.x, shaft.z, topY) || (honestDescent() && wetNear(bot, shaft.x, topY, shaft.z, 4) ? 'вода в 4 бл.' : null))
  if (seaAround) {
    around = seaAround
  } else if (wet) {
    // Над лестницей вода (озеро, река): шахта сюда зальётся. Спуститься с
    // ближайшей сухой клетки и подойти под водой штреком ниже её дна
    // (прогон у -3760,-3408: «под ногами вода — дальше вниз не копаю»).
    around = await goAround(session, ctl, shaft, { deadline, why: wet, far: process.env.ND_SEA_TUNNEL !== '0' ? 48 : 20 })
    walks.push({ around: around.from, ok: around.ok, why: around.why })
  } else if (!underground) {
    const w2 = await travelXZ(bot, ctl, shaft.x, shaft.z, { range: 1, retries: 2, deadline })
    walks.push({ to: shaft, ok: w2.ok, error: w2.error })
  }
  const tDescent = gameClock.now()
  if (!around && !inOwn) session._ownShaft = { key: `${corner.x},${corner.z}`, x: bot.entity.position.x, z: bot.entity.position.z, y: bot.entity.position.y }
  const pd = session._pieDig && session._pieDig.key === pieKey && session._pieDig.est && Number.isFinite(session._pieDig.y) && honestDescent() ? session._pieDig : null
  let dig = around && !around.ok
    ? { stopped: `над лестницей старта ${wet}, обойти не вышло: ${around.why}`, dug: around.dug || 0 }
    : (around && around.bricks ? around.bricks : await shaftToBricks(session, ctl, pd && !around ? { minY, deadline, targetY: pd.y + 1 } : { minY, deadline }))
  // Спуск залило (вода со всех сторон ступени, s5e-M-2: лестница под озером, «утонул») — это место бросить: следующий вызов копает в
  // сухой колонке дальше 8 бл. отсюда (у оценки «пирога» или у лестницы старта, до 32 бл.).
  if ((dig as any).wet && !around) {
    const av = session._wetAvoid || (session._wetAvoid = [])
    av.push({ x: Math.round(bot.entity.position.x), z: Math.round(bot.entity.position.z) })
    session._ownShaft = null
    // Голова в воде — сперва наверх (всплыть/столбом), потом новое место.
    if ((dig as any).drowning || require('./movement').inWater(bot)) {
      try { await require('./survival/surface-body').surface(session, ctl, { timeoutSeconds: 40, preferPillar: true }) } catch {}
    }
    if (pd) {
      const next = pickDryShaft(bot, pd.est, { x: corner.x + 4, z: corner.z + 4 }, av, 5, 32)
      session._pieDig = { ...pd, shaft: next || shaft, dry: true }
      log('спуск залило — новое место шахты у оценки «пирога»', { avoid: av, next })
    } else {
      // У лестницы старта — обход воды: сухая клетка дальше 8 бл. от залитого места, шахта ниже дна, штрек под водой (goAround).
      session._wetStairs = pieKey
      log('спуск залило — к лестнице обходом воды', { avoid: av })
    }
  }
  // Спуск к высоте спавнера («пирог») — дальше штрек к оценке на этой высоте; дошёл — «у крепости» (вход и разведка — как от кирпича).
  if (pd && !around && (dig as any).reached && !ctl.aborted) {
    const b = await require('./endportal-descent').honestBore(session, ctl, { x: Math.round(pd.est.x), z: Math.round(pd.est.z) }, { deadline: Math.min(deadline, gameClock.now() + 60000), maxSteps: 40, bricks: BRICKS })
    log('«пирог»: штрек к оценке на её высоте', { moved: b.moved, dug: b.dug, ok: b.ok, why: b.why })
    dig = { found: 'pie', at: xyz(bot.entity.position.floored()), dug: ((dig as any).dug || 0) + (b.dug || 0) } as any
  }
  if (around && around.ok && around.dug) dig.dug = (dig.dug || 0) + around.dug
  let broke = null
  if (dig.found && !dig.stopped) {
    const restore = noInfested(bot)
    try {
      const eb = await enterByBricks(session, ctl, { deadline })
      log('вход по кирпичу', eb)
      broke = eb.inside ? { inside: true, steps: (eb.tries || []).map(t => `к ${t.to.x},${t.to.y},${t.to.z}`) } : await breakIn(session, ctl, { deadline, toward: refined ? shaft : null })
    } finally { restore() }
  }
  const here = bot.entity.position.floored()
  const detail: any = {
    went: !!dig.found,
    corner,
    refined,
    throws,
    walks: walks.length ? walks : undefined,
    shaft,
    dug: dig.dug,
    at: xyz(here),
    bricks: dig.found ? { name: dig.found, at: dig.at } : null,
    inside: broke ? broke.inside : false,
    brokeIn: broke && broke.steps.length ? broke.steps : undefined,
    eyesLeft: countOf(bot, 'ender_eye'),
    seconds: Math.round((gameClock.now() - t0) / 1000),
    descentSeconds: Math.round((gameClock.now() - tDescent) / 1000),
    honest: (dig as any).honest || undefined
  }
  if (dig.found) {
    savePlace(session, PLACE, { x: corner.x, z: corner.z, y: here.y, dimension: 'overworld', entered: xyz(here) },
      `дошёл до кирпича крепости (${dig.found}) на ${here.x},${here.y},${here.z}`)
    detail.note = `Я у крепости: ${dig.found} на ${dig.at.x},${dig.at.y},${dig.at.z}, стою на ${here.x},${here.y},${here.z}. ` +
      'Портальная комната — где-то в 112 блоках по коридорам: mc_stronghold mode=room.'
    if (dig.stopped) detail.stopped = dig.stopped
    else if (broke && !broke.inside) detail.stopped = `кирпич рядом, но внутрь не пробился${broke.stopped ? `: ${broke.stopped}` : ''} — mc_stronghold mode=room попробует ещё`
  } else {
    detail.stopped = `до кирпича не докопался: ${dig.stopped}` + (refined ? '' : '. Точку оком не уточнил — брось око рядом (mc_stronghold mode=throw)')
  }
  return detail
}

// ------------------------------------------------------------------ room

// Рамки, которые ВИДНО (луч от глаз): рамку за стеной честно не замечаем.
function visibleOf (bot, ids, radius, count = 64) {
  const out = []
  const found = bot.findBlocks({ matching: ids, maxDistance: radius, count })
  for (const p of found) {
    const b = bot.blockAt(p)
    if (b && seesBlock(bot, b)) out.push(b)
  }
  return out
}

// Разведка крепости: идти туда, где ещё не был, по клеткам, которые связаны с
// нами (walkable.js, «ощупью») и ВИДНЫ сейчас или были видны раньше (граница
// разведки). Цель — рамки end_portal_frame или спавнер чешуйниц, замеченные
// только лучом. Кирпич за стеной не подсказывает ничего.
async function findRoom (session, ctl, p: any = {}) {
  const bot = session.bot
  const mcData = session.mcData
  const t0 = gameClock.now()
  const deadline = t0 + clamp(p.timeoutSeconds ?? 300, 30, 600) * 1000 - 4000
  if (worlds.worldOf(bot) !== 'overworld') return { found: false, stopped: 'крепости бывают только в верхнем мире' }
  const frameId = mcData.blocksByName.end_portal_frame.id
  const spawnerId = mcData.blocksByName.spawner.id
  const brickIds = (Object.values(mcData.blocksByName) as any[]).filter((b : any) => BRICKS.test(b.name)).map((b : any) => b.id)

  // Позвали прямо с поверхности (директор идёт find → room, минуя go): кирпича
  // рядом не видно, а крепость в памяти есть — сперва go (дойти, уточнить оком,
  // прокопаться к кирпичу), на него — до 60% срока, остальное — коридоры.
  let went = null
  const map = process.env.ND_ROOM_MAP !== '0' && require('./stronghold').mappedRoom(placeOf(session, PLACE))
  if (p.go !== false && ((!visibleOf(bot, brickIds, 12, 4).length && placeOf(session, PLACE)) || (map && !visibleOf(bot, [frameId], 16, 16).length))) {
    const secs = Math.max(30, Math.round((deadline - gameClock.now()) / 1000 * 0.6))
    went = await goStronghold(session, ctl, { ...p, timeoutSeconds: secs })
    if (!went.went) return { found: false, went, stopped: `до крепости не добрался: ${went.stopped}` }
  }

  // Обход крепости помнится между вызовами (ключ — крепость из памяти): раньше
  // каждый вызов room начинал заново от места, где стоит, и ходил теми же
  // коридорами (репетиция на двойнике мира прохождения, 2026-09-28: 85
  // переходов, 730 блоков, все — на восточной половине; комната — в 15 блоках
  // к западу, этажом выше; вызов оборвало low_health).
  const recK = placeOf(session, PLACE)
  const memKey = recK ? `${recK.x},${recK.z}` : 'нет'
  if (!session._roomExplore || session._roomExplore.key !== memKey) session._roomExplore = { key: memKey, visited: [], known: new Map(), failed: new Set() }
  const visited = session._roomExplore.visited
  const frontier = new Map()
  const known = session._roomExplore.known
  const failed = session._roomExplore.failed
  const key = v => `${v.x},${v.y},${v.z}`
  const legs = []
  let walked = 0
  let last = bot.entity.position.clone()
  const mark = () => {
    const f = bot.entity.position.floored()
    if (!visited.some(v => v.distanceTo(f) < 4)) visited.push(f)
    walked += bot.entity.position.distanceTo(last)
    last = bot.entity.position.clone()
  }
  const markTimer = gameClock.setInterval(mark, 500)
  ctl.onAbort.push(() => gameClock.clearInterval(markTimer))

  let seenFrames = []
  let digOuts = 0
  let lure = null
  let lureBest = null
  let lureStale = 0
  let lurePie = false
  let vertTries = 0
  let lureBores = 0
  const usedLures = []
  const picks = new Map()
  let spawner = null
  let bricksSeen = 0
  // Стоим ещё в своей шахте у стены — сначала внутрь.
  const recS = placeOf(session, PLACE)
  // Точка отсчёта обхода — лестница старта (угол чанка старта + 4, высота —
  // где вошли); без крепости в памяти — где стоим.
  const origin = recS && Number.isFinite(recS.x)
    ? new Vec3(recS.x + (recS.refined ? 4 : 0), Number.isFinite(recS.y) ? recS.y : bot.entity.position.y, recS.z + (recS.refined ? 4 : 0))
    : bot.entity.position.clone()
  const restoreInfested = noInfested(bot)
  ctl.onAbort.push(restoreInfested)
  const torches = []
  let pre: any = { steps: [] }
  const eb = await enterByBricks(session, ctl, { deadline })
  log('вход по кирпичу', eb)
  if (!eb.inside) pre = await breakIn(session, ctl, { deadline, tries: 8, toward: recS && recS.refined ? { x: recS.x + 4, z: recS.z + 4 } : null })
  if (pre.steps.length) legs.push({ why: 'пробился внутрь', steps: pre.steps, inside: pre.inside })
  try {
    while (!ctl.aborted && gameClock.now() < deadline) {
      mark()
      // Лечиться, пока не поздно: в тёмных коридорах зомби и скелеты снимают
      // по 2–4 хп за бой, и обход умирал на третьем-четвёртом (репетиция:
      // «slain», хп 6 → 0). Врагов в 10 блоках нет — есть и стоять до 16.
      if ((bot.health ?? 20) < 12 && !require('./combat').nearestHostile(bot, 10)) {
        try { await require('./actions').eat(session, {}) } catch {}
        const tH = gameClock.now()
        while (!ctl.aborted && gameClock.now() - tH < 40000 && (bot.health ?? 20) < 16 && gameClock.now() < deadline && !require('./combat').nearestHostile(bot, 8)) {
          if ((bot.food ?? 20) < 18) { try { await require('./actions').eat(session, {}) } catch {} }
          await sleep(1000)
        }
      }
      // --- глаза
      seenFrames = visibleOf(bot, [frameId], 48, 24)
      if (seenFrames.length) break
      const sp = visibleOf(bot, [spawnerId], 32, 8)
      if (sp.length) {
        spawner = sp[0].position
        // Спавнер в крепости — на лестнице портальной комнаты: подойти к нему,
        // рамки откроются с площадки.
        const w = await walkTo(bot, ctl, spawner, 2, Math.min(20000, deadline - gameClock.now()))
        legs.push({ to: xyz(spawner), why: 'спавнер', ok: w.ok })
        seenFrames = visibleOf(bot, [frameId], 48, 24)
        if (seenFrames.length) break
      }
      bricksSeen = Math.max(bricksSeen, visibleOf(bot, brickIds, 16, 200).length)

      // --- граница: связанные клетки, видимые отсюда, далеко от посещённого
      const eye = eyePos(bot)
      const nodes = walkable(bot, bot.entity.position, { radius: 32, maxNodes: 8000, doors: true })
      // Всё нащупанное — в общую карту: из неё возвращаются к непройденному.
      // Прореженно (каждая четвёртая по сетке 2x2), чтобы карта не пухла.
      for (const n of nodes) {
        if ((n.pos.x & 1) || (n.pos.z & 1)) continue
        if (known.size < 40000) known.set(key(n.pos), n.pos)
      }
      let sampled = 0
      const fresh = []
      for (const n of nodes) {
        if (n.d < 3) continue
        const k = key(n.pos)
        if (failed.has(k)) continue
        if (visited.some(v => v.distanceTo(n.pos) < 5)) continue
        if (sampled++ > 1200) break
        if (raySees(bot, eye, n.pos.offset(0.5, 1.2, 0.5))) { frontier.set(k, n.pos); fresh.push(n) }
      }
      for (const [k, v] of frontier) if (visited.some(x => x.distanceTo(v) < 5)) frontier.delete(k)
      // Куда: самая ДАЛЬНЯЯ из видимых отсюда (в коридоре — его конец: взгляд
      // вдоль и шаг туда, как ходит человек); видимой нет — ближайшая из
      // запомненных (вернуться к непройденному ответвлению). «Ближайшая
      // всегда» топталась у старта: 150 переходов и 936 блоков за 9 минут, а
      // комната была в 45 блоках (прогон 2026-09-25).
      const me = bot.entity.position
      // Ближе к лестнице старта — раньше (обход «слоями» от старта): «самая
      // дальняя видимая» уводила вдоль коридоров за 100+ блоков — репетиция на
      // двойнике: 160 переходов, тело на y=9 в 90 блоках к востоку, а комната —
      // в 25 блоках к западу от лестницы, на её этаже. Счёт клетки: расстояние
      // до лестницы + треть пути от нас (не прыгать через всю крепость).
      // Чешуйницы — «слышно» комнату: спавнер чешуйниц стоит только на лестнице
      // портальной комнаты и работает, пока игрок в 16 блоках от него, — рождённые
      // им ползают рядом (сервер шлёт их позиции в радиусе слежения, как и звук у
      // человека). Видели чешуйниц — идём к ним, а не «слоями от старта».
      // Дошли до приманки, а рамок не видно — она пустая (лава в пещере): забыть.
      if (lure && lure.distanceTo(me) < 5 && !(lurePie && Math.abs(lure.y - me.y) >= 3 && vertTries < 3)) { usedLures.push(lure.clone ? lure.clone() : lure); lure = null }
      // «Пирог» F3 (S10): спавнер чешуйниц — только в портальной комнате крепости; пеленг его дуги из разных мест обхода →
      // пересечение (senses.triangulate) — место без клетки и без высоты (берём свою). Как спидраннеры: pie-ray к комнате.
      // ND_ROOM_PIE=0 — без «пирога».
      let pieLure = null
      if (process.env.ND_ROOM_PIE !== '0') {
        try {
          const S = require('./perception/senses')
          const arcs = S.pieArcs(bot, 'spawner', { fov: 20, step: 2 })
          const ps = session._roomExplore.pie || (session._roomExplore.pie = [])
          if (arcs.length && !arcs[0].all && arcs[0].center !== null) {
            const last = ps[ps.length - 1]
            if (!last || Math.hypot(last.x - me.x, last.z - me.z) >= 4) ps.push({ x: me.x, z: me.z, yaw: arcs[0].center })
            if (ps.length > 8) ps.splice(0, ps.length - 8)
            const est = ps.length >= 2 ? S.triangulate(ps) : null
            // Высота — «пирогом» по вертикали (наклон камеры) при известной горизонтальной дальности (s5e-Q-2: комната на 3 бл. выше
            // штрека — 4 штрека «за 24 шагов не дошёл»).
            let ly = me.y
            if (est && est.spread <= 6) { const el = require('./endportal-descent').pieElevation(bot, Math.hypot(est.x - me.x, est.z - me.z)); if (el) ly = el.y }
            if (est && est.spread <= 6) pieLure = new Vec3(est.x, ly, est.z)
            else { const v = S.vecOf(arcs[0].center); pieLure = new Vec3(me.x + v.x * 24, me.y, me.z + v.z * 24) }
            // Дошёл до оценки, а рамок не видно — спавнер выше/ниже: эту точку не повторять (дальше звук лавы и обход).
            if (usedLures.some(u => Math.hypot(u.x - pieLure.x, u.z - pieLure.z) < 6)) pieLure = null
            if (pieLure && (!lure || pieLure.distanceTo(lure) > 6)) log('«пирог»: спавнер', { yaw: arcs[0].center, samples: ps.length, est: est ? { x: est.x, z: est.z, spread: est.spread } : null, lure: xyz(pieLure.floored()) })
          }
        } catch (e) { log('«пирог»: ошибка', { error: e.message }) }
      }
      // S10 (честное восприятие): чешуйницы — видимые лучом (место) или слышимые (сторона и полоса → точка-оценка), не все
      // в радиусе слежения; на уровне знания scan или ND_HONEST_LURE=0 — как было.
      const honestLure = process.env.ND_HONEST_LURE !== '0' && require('./perception/knowledge').level() !== 'scan'
      const fish = !honestLure
        ? (Object.values(bot.entities) as any[]).filter((e : any) => e && e.name === 'silverfish' && e.position && e.isValid !== false && e.position.distanceTo(me) < 48)
        : require('./perception/eyes').entities(bot, { radius: 48 }).filter((k: any) => k.name === 'silverfish')
          .map((k: any) => { const q = k.pos || k.lastPos || (k.heard && require('./perception/senses').hearPoint(bot, k.heard)); return q ? { position: new Vec3(q.x, q.y, q.z) } : null }).filter(Boolean)
      if (fish.length) {
        const c = (fish.reduce((a: any, e: any) => a.plus(e.position), new Vec3(0, 0, 0)) as any).scaled(1 / fish.length)
        if (!lure || c.distanceTo(lure) > 4) log('чешуйницы', { n: fish.length, at: xyz(c.floored()) })
        lure = c; lurePie = false
      } else if (pieLure) {
        if (!lure || pieLure.distanceTo(lure) > 6) { lure = pieLure; lureBest = null; lureStale = 0 }
        lurePie = true
      }
      // Лава — «слышно» тоже: клиент игры сам играет звуки лавы для лавы в 32
      // блоках (ClientLevel.animateTick → LavaFluid.animateTick), сквозь стены;
      // спидраннеры идут на этот звук — под рамками комнаты бассейн лавы. Берём
      // ближайшую лаву в 32 блоках на высоте крепости (±12 от ног).
      if (!fish.length && !pieLure) {
        const lavaId = bot.registry.blocksByName.lava.id
        let heard = null
        try {
          if (honestLure) {
            // S10: звук лавы клиента — только у лавы с воздухом сверху; наружу — румб 22.5° и дальность до 4 бл. (точка-оценка).
            const h = require('./perception/senses').hearLavaPoint(bot, { radius: 32, maxDy: 12, skip: q => usedLures.some(u => u.distanceTo(new Vec3(q.x, q.y, q.z)) < 12) })
            heard = h ? new Vec3(h.at.x, h.at.y, h.at.z) : null
          } else {
            heard = bot.findBlocks({ matching: [lavaId], maxDistance: 32, count: 60 })
              .filter(q => Math.abs(q.y - me.y) <= 12 && !usedLures.some(u => u.distanceTo(q) < 10))
              .sort((a, b) => a.distanceTo(me) - b.distanceTo(me))[0] || null
          }
        } catch {}
        // Оценка по звуку дрожит на шаг румба/дальности — приманку меняем, только если звук ушёл дальше 12 бл. (честный слух).
        if (heard && (!lure || heard.distanceTo(lure) > (honestLure ? 12 : 6))) { log('слышу лаву', { at: xyz(heard), d: Math.round(heard.distanceTo(me)) }); lure = heard; lurePie = false; lureBest = null; lureStale = 0 }
      }
      // К приманке коридорами не выходит (4 перехода без сближения на 2 блока) —
      // копать к ней штреком: спидраннеры так и делают — на звук сквозь стену
      // (кирпич крепости ~0.4 с железной киркой). Двойник 2: лава комнаты в 12–
      // 20 блоках за стенами, коридоры увели на другой этаж, 150 переходов.
      // У оценки «пирога» по горизонтали, а по высоте далеко — ступенями к её высоте (вверх/вниз), рамки откроются оттуда.
      if (lure && lurePie && honestDescent() && vertTries < 3 && Math.hypot(lure.x - me.x, lure.z - me.z) <= 8 && Math.abs(lure.y - me.y) >= 3 && !ctl.aborted && gameClock.now() < deadline - 20000) {
        vertTries++
        const v = await require('./endportal-descent').toLevel(session, ctl, Math.round(lure.y), { deadline: Math.min(deadline, gameClock.now() + 40000), bricks: BRICKS })
        legs.push({ why: 'к высоте спавнера', to: Math.round(lure.y), moved: v.moved, ok: v.ok, stop: v.why })
        log('к высоте спавнера («пирог»)', { from: Math.round(me.y), to: Math.round(lure.y), ok: v.ok, moved: v.moved, why: v.why })
        continue
      }
      if (lure) {
        const dl = me.distanceTo(lure)
        if (lureBest === null || dl < lureBest - 2) { lureBest = dl; lureStale = 0 } else lureStale++
        // «Пирог» с пересечением пеленгов (≥ 2 точки) — место известно до ~4 бл.: штрек сразу, без обхода коридоров (s5e-M-1:
        // 4.6 игр. мин коридорами и тупиками при оценке с разбросом 0.4).
        const piePrecise = lurePie && (session._roomExplore.pie || []).length >= 2
        const xzNear = Math.hypot(lure.x - me.x, lure.z - me.z) <= 2
        if (!xzNear && lureStale >= (piePrecise ? 0 : lurePie ? 2 : 4) && lureBores < (lurePie ? 6 : 4) && !ctl.aborted && gameClock.now() < deadline - 20000) {
          lureBores++
          lureStale = 0
          const yLvl = Math.floor(lure.y) + 1
          try {
            const b = honestDescent()
              ? await require('./endportal-descent').honestBore(session, ctl, { x: Math.floor(lure.x), z: Math.floor(lure.z) }, { deadline: Math.min(deadline, gameClock.now() + (lurePie ? 90000 : 45000)), maxSteps: lurePie ? 48 : 24, bricks: BRICKS })
              : await require('./nether').bore(session, ctl, { x: Math.floor(lure.x), z: Math.floor(lure.z) }, {
                deadline: Math.min(deadline, gameClock.now() + 45000), maxSteps: 24, minY: yLvl, maxY: yLvl, throughBricks: true
              })
            legs.push({ why: 'к приманке штреком', to: xyz(lure.floored ? lure.floored() : lure), moved: b.moved, dug: b.dug, stop: b.why })
            log('штрек к приманке', { to: xyz(lure.floored ? lure.floored() : lure), moved: b.moved, dug: b.dug, why: b.why })
          } catch (e) { log('штрек к приманке', { error: e.message }) }
          continue
        }
      }
      const goal = lure || origin
      // Честный спуск — винтовая лестница: её клетки (пол — камень, не кирпич) связаны с коридором и видны; обход шёл бы по ней
      // назад к поверхности. Клетки без пола крепости — дороже на 20 (не запрет: проходы бывают и по камню пещер).
      const hold = honestDescent()
      const offHold = v => { if (!hold) return 0; const fl = bot.blockAt(v.offset(0, -1, 0)); return fl && FLOOR.test(fl.name) ? 0 : 20 }
      const score = v => v.distanceTo(goal) + 0.35 * v.distanceTo(me) + offHold(v)
      const live = fresh.filter(n => frontier.has(key(n.pos))).sort((a, b) => score(a.pos) - score(b.pos))
      const next = live.length
        ? live[0].pos
        : [...frontier.values()].sort((a, b) => score(a) - score(b))[0]
      if (!next) {
        // Видимой границы нет: коридор кончился дверью или завалом. Ощупью —
        // любая связанная клетка, где не был.
        const blind = nodes.filter(n => n.d >= 4 && !failed.has(key(n.pos)) && !visited.some(v => v.distanceTo(n.pos) < 5))
          .sort((a, b) => a.d - b.d)[0]
        if (blind) {
          frontier.set(key(blind.pos), blind.pos)
          continue
        }
        // И здесь всё пройдено — назад, к ближайшей из когда-либо нащупанных
        // клеток, где ещё не был (тупиковая библиотека на западе, а комната —
        // на востоке от старта: прогон у -3760,-3408 встал через 38 с).
        const back = [...known.values()]
          .filter(v => !failed.has(key(v)) && !visited.some(x => x.distanceTo(v) < 6))
          .sort((a, b) => (a.distanceTo(lure || origin) + 0.35 * a.distanceTo(me)) - (b.distanceTo(lure || origin) + 0.35 * b.distanceTo(me)))[0]
        if (!back) {
          log('тупик', { at: xyz(bot.entity.position), nodes: nodes.length, fresh: fresh.length, known: known.size, visited: visited.length, failed: failed.size, nodesFar: nodes.filter(n => n.d >= 4).length, ys: [...new Set(nodes.map(n => n.pos.y))].sort((x: any, y: any) => x - y).join(',') })
          // Тупик — пробиться: стенка крепости в один кирпич, за ней коридор
          // (breakIn: вниз по потолку, вбок сквозь стену к воздуху); затем
          // штрек в 12 блоков от лестницы старта — коридоры крепости густые, и
          // прямой штрек их пересекает. Раньше тупик кончал вызов сразу:
          // «куда идти дальше, не вижу» за 0 с (двойник 2, лестница после
          // прошлых обходов — 9 клеток).
          // Тупик, а приманка есть («пирог»/слух/чешуйницы) — штрек к ней на своём уровне, а не вниз сквозь пол (s5e-Q-2 07.10: тупик →
          // пробиться → честный вход ступенями вниз 46 → 30, а спавнер в 40 бл. по пеленгу).
          if (lure && lureBores < 6 && honestDescent() && !ctl.aborted && gameClock.now() < deadline - 20000) {
            lureBores++
            const b = await require('./endportal-descent').honestBore(session, ctl, { x: Math.floor(lure.x), z: Math.floor(lure.z) }, { deadline: Math.min(deadline, gameClock.now() + 45000), maxSteps: 24, bricks: BRICKS })
            legs.push({ why: 'тупик — штрек к приманке', to: xyz(lure.floored ? lure.floored() : lure), moved: b.moved, dug: b.dug, stop: b.why })
            log('тупик — штрек к приманке', { to: xyz(lure.floored ? lure.floored() : lure), moved: b.moved, dug: b.dug, why: b.why })
            if (b.moved) continue
          }
          if (digOuts < 3 && !ctl.aborted && gameClock.now() < deadline - 20000) {
            digOuts++
            const bi = await breakIn(session, ctl, { deadline: Math.min(deadline, gameClock.now() + 40000), tries: 6 })
            legs.push({ why: 'тупик — пробиваюсь', steps: bi.steps.slice(-4), inside: bi.inside })
            if (!bi.inside || walkable(bot, bot.entity.position, { radius: 8, maxNodes: 60, doors: true }).length < 20) {
              const me2 = bot.entity.position
              const ax = Math.abs(me2.x - origin.x) >= Math.abs(me2.z - origin.z)
              const dir = digOuts % 2 ? 1 : -1
              const tgt = ax ? { x: Math.round(me2.x + dir * 12), z: Math.round(me2.z) } : { x: Math.round(me2.x), z: Math.round(me2.z + dir * 12) }
              try {
                const b = honestDescent()
                  ? await require('./endportal-descent').honestBore(session, ctl, tgt, { deadline: Math.min(deadline, gameClock.now() + 40000), maxSteps: 12, bricks: BRICKS })
                  : await require('./nether').bore(session, ctl, tgt, { deadline: Math.min(deadline, gameClock.now() + 40000), maxSteps: 12, minY: Math.floor(me2.y), maxY: Math.floor(me2.y), throughBricks: true })
                legs.push({ why: 'тупик — штрек', to: tgt, moved: b.moved, dug: b.dug })
              } catch {}
            }
            continue
          }
          break
        }
        frontier.set(key(back), back)
        continue
      }
      frontier.delete(key(next))
      // В тёмных коридорах крепости — зомби и скелеты: переход под охраной
      // (nether.guarded: ударили — бой, еда, потом дальше). Лаборатория
      // 2026-09-27, джунгли 1232,2208: в крепость дошёл, 7 минут обходил
      // комнаты и умер от зомби («slain by Zombie»), ни разу не ответив.
      const w = await require('./nether').guarded(session, ctl, sub => walkTo(bot, sub, next, 1, Math.min(25000, deadline - gameClock.now())))
      await torchIfDark(bot, torches).catch(() => false)
      if (w.fought) {
        legs.push({ fought: w.fought })
        log('бой в крепости', w.fought)
        frontier.set(key(next), next)
        if ((bot.health ?? 20) < 8 && !ctl.aborted) {
          // Мало хп — поесть и постоять (сытость 18+ лечит), не ходить дальше вслепую.
          try { await require('./actions').eat(session, {}) } catch {}
          const tH = gameClock.now()
          while (!ctl.aborted && gameClock.now() - tH < 25000 && (bot.health ?? 20) < 14 && gameClock.now() < deadline) await sleep(1000)
        }
        continue
      }
      legs.push({ to: xyz(next), ok: w.ok, error: w.ok ? undefined : w.error })
      // Дошёл — сама цель тоже «пройдена»: mark() пишет клетку тела, только если
      // рядом (4) нет прежней отметки, и цель в 1 блоке от тела, но в 5+ от той
      // отметки, выбиралась снова и снова (двойник 2: 4 одинаковых перехода за
      // секунду). Та же цель трижды — в провал.
      if (w.ok) visited.push(next.floored ? next.floored() : next)
      const tk = key(next)
      picks.set(tk, (picks.get(tk) || 0) + 1)
      if (picks.get(tk) >= 3) failed.add(tk)
      log('переход', { to: xyz(next), ok: w.ok, frontier: frontier.size, visited: visited.length, t: Math.round((gameClock.now() - t0) / 1000) })
      if (!w.ok) failed.add(key(next))
      if (legs.length > 200) break
    }
  } finally {
    gameClock.clearInterval(markTimer)
    restoreInfested()
  }

  const detail: any = {
    found: seenFrames.length > 0,
    frames: seenFrames.length,
    spawner: spawner ? xyz(spawner) : undefined,
    legs: legs.length,
    walked: Math.round(walked),
    visited: visited.length,
    frontierLeft: frontier.size,
    bricksSeen,
    went: went ? { dug: went.dug, refined: went.refined, bricks: went.bricks, inside: went.inside, seconds: went.seconds, descentSeconds: went.descentSeconds, honest: went.honest } : undefined,
    at: xyz(bot.entity.position),
    seconds: Math.round((gameClock.now() - t0) / 1000)
  }
  if (seenFrames.length) {
    const all = bot.findBlocks({ matching: [frameId], maxDistance: 12, point: seenFrames[0].position, count: 24 })
    const withEye = all.filter(pos => { const b = bot.blockAt(pos); return b && String(b.getProperties().eye) === 'true' }).length
    const c = all.reduce((a, v) => a.plus(v), new Vec3(0, 0, 0)).scaled(1 / all.length)
    const centre = { x: Math.floor(c.x), y: all[0].y, z: Math.floor(c.z) }
    detail.room = { centre, frames: all.length, withEye, empty: all.length - withEye }
    savePlace(session, ROOM, { ...centre, dimension: 'overworld', frames: all.length, withEye, note: `портальная комната: рамок ${all.length}, с оком ${withEye}` },
      `нашёл портальную комнату: центр ${centre.x},${centre.y},${centre.z}, рамок ${all.length}, с оком ${withEye}`)
    detail.note = `${went && Number.isFinite(went.descentSeconds) ? `(спуск ${went.descentSeconds} с) ` : ''}Вижу портальную комнату: ${all.length} рамок, с оком уже ${withEye}, пустых ${all.length - withEye}. ` +
      `Вставить: mc_stronghold mode=fill (глаз в рюкзаке ${countOf(bot, 'ender_eye')}).`
  } else {
    detail.stopped = ctl.aborted ? 'прервано' : (gameClock.now() >= deadline ? 'время вышло' : 'куда идти дальше, не вижу')
    detail.note = `${went && Number.isFinite(went.descentSeconds) ? `(спуск ${went.descentSeconds} с) ` : ''}Рамок не увидел: прошёл ${detail.walked} блоков, ${legs.length} переходов, кирпича видно ${bricksSeen}. ` +
      'Позови ещё раз — граница разведки строится заново от того места, где стою.'
  }
  return detail
}

// ------------------------------------------------------------------ fill

function frameState (bot, pos) {
  const b = bot.blockAt(pos)
  if (!b || b.name !== 'end_portal_frame') return null
  const pr = b.getProperties()
  return { pos, eye: String(pr.eye) === 'true', facing: pr.facing }
}

// Спавнер чешуйниц на лестнице комнаты рождает их, пока тело в 16 бл.; укусы рвут вставку глаз аварийным отходом
// автопилота (ферма 02.10, neF-sh-3: оба захода fill прерваны — EMERGENCY, затем хп 7 и LOW_HP, этап «в Энд не вошёл»).
// Сломать его до вставки (кирка — 1–2 с; только видимый: копать сквозь стену нельзя), рождённых рядом — добить.
async function breakRoomSpawner (session, ctl, anchor, deadline) {
  const bot = session.bot
  const id = bot.registry.blocksByName.spawner.id
  const sp = bot.findBlocks({ matching: [id], maxDistance: 20, point: anchor, count: 2 })[0]
  if (!sp) return null
  const out: any = { at: xyz(sp), broken: false }
  const c = sp.offset(0.5, 0.5, 0.5)
  if (eyePos(bot).distanceTo(c) > 4.2) await walkTo(bot, ctl, sp, 3, Math.max(1000, Math.min(20000, deadline - gameClock.now() - 60000)))
  const b = bot.blockAt(sp)
  if (!b || b.name !== 'spawner') { out.broken = true; return out }
  if (eyePos(bot).distanceTo(c) > 4.5 || !seesBlock(bot, b)) { out.why = 'не дотянулся или не видно'; return out }
  try { await equipBestTool(bot, b); await bot.dig(b); out.broken = true } catch (e) { out.why = e.message.slice(0, 80) }
  const fish = () => (Object.values(bot.entities) as any[]).some((e : any) => e && e.name === 'silverfish' && e.position && e.position.distanceTo(bot.entity.position) < 8)
  if (out.broken && fish() && !ctl.aborted) {
    try { await require('./combat').fight(session, ctl, { timeoutSeconds: 20, retreatAtHealth: 6 }) } catch {}
    out.fought = true
  }
  return out
}

async function fillFrames (session, ctl, p: any = {}) {
  const bot = session.bot
  const mcData = session.mcData
  const t0 = gameClock.now()
  const deadline = t0 + clamp(p.timeoutSeconds ?? 180, 20, 600) * 1000 - 3000
  const frameId = mcData.blocksByName.end_portal_frame.id
  const portalId = mcData.blocksByName.end_portal.id
  // Рамки комнаты: сначала видимые, от них — вся дюжина вокруг.
  const seen = visibleOf(bot, [frameId], 24, 24)
  const rec = placeOf(session, ROOM)
  const anchor = seen.length ? seen[0].position : (rec && worlds.worldOfRecord(rec) === worlds.worldOf(bot) ? new Vec3(rec.x, rec.y, rec.z) : null)
  if (!anchor) return { lit: false, stopped: 'рамок портала не вижу и в памяти их нет — сначала mc_stronghold mode=room' }
  // Запись из памяти далеко — это другая комната (или другая крепость): туда
  // вставка глаз не ходит, это работа room/go (прогон 2026-09-25: fill по
  // записи прошлой крепости 30 с шагал к ней за 5000 блоков).
  if (!seen.length && bot.entity.position.distanceTo(anchor) > 48) {
    return { lit: false, stopped: `рамок не вижу, а комната в памяти в ${Math.round(bot.entity.position.distanceTo(anchor))} блоках на ${anchor.x},${anchor.y},${anchor.z} — сначала дойди до неё (mc_stronghold mode=room)` }
  }
  if (bot.entity.position.distanceTo(anchor) > 10) {
    await walkTo(bot, ctl, anchor, 3, Math.min(30000, deadline - gameClock.now()))
  }
  const frames = bot.findBlocks({ matching: [frameId], maxDistance: 8, point: anchor, count: 24 })
    .map(pos => frameState(bot, pos)).filter(Boolean)
  const already = bot.findBlocks({ matching: [portalId], maxDistance: 8, point: anchor, count: 16 })
  if (already.length >= 9) {
    const c = already.reduce((a, v) => a.plus(v), new Vec3(0, 0, 0)).scaled(1 / already.length)
    const portal = { x: Math.floor(c.x), y: already[0].y, z: Math.floor(c.z) }
    if (p.enter) {
      const en: any = await enterPortal(session, ctl, portal, deadline)
      return { lit: true, already: true, portal, entered: en.entered, enter: en, stopped: en.entered ? undefined : `в портал не вошёл: ${en.why}` }
    }
    return {
      lit: true,
      already: true,
      portalBlocks: already.length,
      frames: frames.length,
      withEye: frames.filter(f => f.eye).length,
      placed: 0,
      portal: { x: Math.floor(c.x), y: already[0].y, z: Math.floor(c.z) },
      note: 'портал в Край уже горит — 9 клеток end_portal'
    }
  }
  const empty = frames.filter(f => !f.eye)
  const have = countOf(bot, 'ender_eye')
  if (frames.length < 12) {
    return { lit: false, frames: frames.length, stopped: `вижу только ${frames.length} рамок из 12 — подойди ближе к комнате (mc_stronghold mode=room) и позови снова` }
  }
  if (have < empty.length) {
    return {
      lit: false,
      frames: frames.length,
      withEye: frames.length - empty.length,
      need: { what: 'ender_eye', count: empty.length - have, have },
      stopped: `пустых рамок ${empty.length}, а глаз ${have} — не хватает ${empty.length - have}. ` +
        'Око: mc_craft item=ender_eye (blaze_powder + ender_pearl, бесформенный рецепт).'
    }
  }

  const spawnerRoom = await breakRoomSpawner(session, ctl, anchor, deadline).catch(e => ({ why: e.message }))
  const placed = []
  const failedAt = []
  const me0 = bot.entity.position
  // Ближние сначала, дальше — по кругу от текущего места.
  const order = empty.slice().sort((a, b) => a.pos.distanceTo(me0) - b.pos.distanceTo(me0))
  // Не дотянулся с 2 блоков — встать на уровень рамки (на соседнюю рамку) или
  // туда, откуда её видно (ферма, крепость A: 11 из 12 — одна рамка «не
  // дотянулся: 5 бл.», и портал не загорелся).
  for (const f of order) {
    if (ctl.aborted || gameClock.now() > deadline) break
    const centre = f.pos.offset(0.5, 0.8, 0.5)
    if (eyePos(bot).distanceTo(centre) > REACH) {
      await walkTo(bot, ctl, f.pos, 2, Math.min(20000, deadline - gameClock.now()))
    }
    if (eyePos(bot).distanceTo(centre) > REACH && !f.retried) {
      f.retried = true
      // Не на саму рамку: внутри кольца — бассейн лавы под порталом (ферма,
      // крепость A: «tried to swim in lava» при заливке) — только туда, откуда
      // рамку видно с 4 блоков.
      for (const g of [new goals.GoalLookAtBlock(f.pos, bot.world, { reach: 4 })]) {
        if (eyePos(bot).distanceTo(centre) <= REACH || ctl.aborted) break
        try { await Promise.race([bot.pathfinder.goto(g), sleep(Math.min(15000, Math.max(1000, deadline - gameClock.now())))]) } catch {}
        try { bot.pathfinder.setGoal(null) } catch {}
      }
    }
    if (eyePos(bot).distanceTo(centre) > REACH + 0.3) {
      failedAt.push({ at: xyz(f.pos), why: `не дотянулся: ${Math.round(eyePos(bot).distanceTo(centre) * 10) / 10} бл.` })
      continue
    }
    const eyeItem = itemNamed(bot, 'ender_eye')
    if (!eyeItem) { failedAt.push({ at: xyz(f.pos), why: 'глаза кончились' }); break }
    try {
      await bot.equip(eyeItem, 'hand')
      const block = bot.blockAt(f.pos)
      await bot.lookAt(centre, true)
      await bot.activateBlock(block, new Vec3(0, 1, 0))
    } catch (e) {
      failedAt.push({ at: xyz(f.pos), why: e.message.slice(0, 60) })
      continue
    }
    let ok = false
    for (let i = 0; i < 15 && !ok; i++) {
      await sleep(100)
      const s = frameState(bot, f.pos)
      ok = !!(s && s.eye)
    }
    if (ok) placed.push(xyz(f.pos))
    else failedAt.push({ at: xyz(f.pos), why: 'око не встало (сервер не подтвердил)' })
  }

  await sleep(400)
  const portal = bot.findBlocks({ matching: [portalId], maxDistance: 8, point: anchor, count: 16 })
  const after = bot.findBlocks({ matching: [frameId], maxDistance: 8, point: anchor, count: 24 })
    .map(pos => frameState(bot, pos)).filter(Boolean)
  const withEye = after.filter(f => f.eye).length
  const lit = portal.length >= 9
  const detail: any = {
    lit,
    portalBlocks: portal.length,
    frames: after.length,
    withEye,
    placed: placed.length,
    failed: failedAt.length ? failedAt : undefined,
    eyesLeft: countOf(bot, 'ender_eye'),
    spawner: spawnerRoom || undefined,
    at: xyz(bot.entity.position),
    seconds: Math.round((gameClock.now() - t0) / 1000)
  }
  if (lit) {
    const c = portal.reduce((a, v) => a.plus(v), new Vec3(0, 0, 0)).scaled(1 / portal.length)
    detail.portal = { x: Math.floor(c.x), y: portal[0].y, z: Math.floor(c.z) }
    savePlace(session, ROOM, { ...detail.portal, dimension: 'overworld', lit: true, note: 'портал в Край ГОРИТ: 9 клеток end_portal; шаг внутрь — сразу Край (задержки нет)' },
      `портал в Край горит: центр ${detail.portal.x},${detail.portal.y},${detail.portal.z}`)
    detail.note = `Портал в Край горит: ${portal.length} клеток end_portal над лавой. Вставил ${placed.length} глаз(а). ` +
      'Шаг в портал переносит в Край сразу, без задержки, и назад оттуда только через дракона — не наступай случайно.'
    if (p.enter) {
      const en: any = await enterPortal(session, ctl, detail.portal, deadline + 3000)
      detail.entered = en.entered
      detail.enter = en
      if (!en.entered) detail.stopped = `портал горит, но войти не вышло: ${en.why}`
    }
  } else {
    detail.stopped = `портал не загорелся: с оком ${withEye} рамок из ${after.length}` +
      (failedAt.length ? `; не вышло: ${failedAt.slice(0, 3).map(f => f.why).join('; ')}` : '')
  }
  return detail
}

// Войти в горящий портал (fill enter:true): встать на рамку — её верх на
// +0.8125, портал вровень с рамками и без коллизии — и шагнуть к центру 3x3.
// Перенос мгновенный; свидетель — мир бота сменился на Край.
async function enterPortal (session, ctl, portal, deadline) {
  const bot = session.bot
  const from = worlds.worldOf(bot)
  const out: any = { tries: 0 }
  const frameId = session.mcData.blocksByName.end_portal_frame.id
  const centre = new Vec3(portal.x + 0.5, portal.y, portal.z + 0.5)
  const frames = bot.findBlocks({ matching: [frameId], maxDistance: 6, point: centre, count: 12 })
    .sort((a, b) => a.distanceTo(bot.entity.position) - b.distanceTo(bot.entity.position))
  if (!frames.length) return { entered: false, why: 'рамок у портала не вижу' }
  const switched = new Promise<any>(resolve => {
    const f = () => { if (worlds.worldOf(bot) !== from) { bot.removeListener('respawn', f); resolve(true) } }
    bot.on('respawn', f)
    gameClock.setTimeout(() => { bot.removeListener('respawn', f); resolve(false) }, Math.max(3000, deadline - gameClock.now()))
  })
  for (const f of frames.slice(0, 4)) {
    if (ctl.aborted || gameClock.now() > deadline || worlds.worldOf(bot) !== from) break
    out.tries++
    const w = await walkTo(bot, ctl, f.offset(0.5, 1, 0.5), 0.6, Math.min(20000, deadline - gameClock.now()))
    if (!w.ok && bot.entity.position.distanceTo(f.offset(0.5, 1, 0.5)) > 2) { out.why = `к рамке не подошёл: ${w.error}`; continue }
    const t0 = gameClock.now()
    try {
      while (!ctl.aborted && gameClock.now() - t0 < 4000 && worlds.worldOf(bot) === from) {
        await bot.lookAt(centre.offset(0, 0.5, 0), true).catch(() => {})
        bot.setControlState('forward', true)
        bot.setControlState('jump', bot.entity.onGround && bot.entity.position.y < f.y + 0.7)
        await sleep(50)
      }
    } finally {
      bot.setControlState('forward', false)
      bot.setControlState('jump', false)
    }
    if (worlds.worldOf(bot) !== from) break
  }
  const ok = worlds.worldOf(bot) !== from || await Promise.race([switched, sleep(3000).then(() => false)])
  out.entered = ok && worlds.worldOf(bot) === 'the_end'
  out.world = worlds.worldOf(bot)
  if (!out.entered && !out.why) out.why = 'шагнул к центру, а мир не сменился'
  if (out.entered) {
    savePlace(session, ROOM, { ...portal, dimension: 'overworld', lit: true, entered: true, note: 'портал в Край горит; через него уже входил' }, 'вошёл в портал — я в Краю')
  }
  return out
}

module.exports = { goStronghold, findRoom, fillFrames, enterPortal, shaftToBricks, mappedStepRisk, goMappedRoom, dryEntry, cantDigThrough, BRICKS, PLACE, ROOM }
