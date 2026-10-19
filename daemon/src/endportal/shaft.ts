'use strict'
// Крепость и портал в Край (endportal.ts): шахта вниз до кирпича, шаг вбок, что не прокопать, шаг в соседнюю клетку.
import * as gameClock from '../game-clock'
import { Vec3 } from 'vec3'
import { sleep, xyz } from '../movement'
import { equipBestTool, missingHarvestTool } from '../items'
import { seesBlock } from '../sight'
import { BRICKS, honestDescent, log, INFESTED } from './common'

const DIRS8 = [[1, 0], [-1, 0], [0, 1], [0, -1], [1, 1], [1, -1], [-1, 1], [-1, -1]]

// ------------------------------------------------------------------ go

// Шахта вниз 1x1 до первого кирпича крепости. Своя, а не actions.digDown: той
// нечем сказать «стоп, под ногами кирпич» — а здесь это и есть цель.
async function shaftToBricks (session, ctl, { minY, deadline, targetY = null }: any) {
  if (honestDescent()) return (require('../endportal-descent') as typeof import('../endportal-descent')).honestShaft(session, ctl, { minY, deadline, targetY, bricks: BRICKS, log })
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
        const { placeBlockAt }: typeof import('../build') = require('../build')
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
          const st = await (require('../actions') as typeof import('../actions')).digDown(session, ctl, { mode: 'stairs', depth: Math.min(24, gap + 3, Number.isFinite(targetY) ? feet.y - targetY : 128), timeoutSeconds: Math.max(20, Math.min(120, Math.round((deadline - gameClock.now()) / 1000) - 10)) }).catch(e => ({ stopped: e.message }))
          const y1 = bot.entity.position.floored().y
          if (y1 < y0) { dug += (st && st.dug) || 0; continue }
        }
        return { stopped: `под ногами пещера (${gap} блоков${spike ? ', сталагмиты' : ''}) — прыгать не стал`, dug }
      }
    }
    // Кирки кончились (ход по Аду и шахта к комнате стёрли все: SH5 03.10 — комната найдена на 7-й мин, кирок 0, этап
    // wood увёл наверх, рамки «в 103 блоках») — каменные из булыжника шахты и палок рюкзака (tunnel.restockPicks), запас ≥ 2.
    if ((require('../tunnel') as typeof import('../tunnel')).lowPicks(bot) < 2) { try { await (require('../tunnel') as typeof import('../tunnel')).restockPicks(session, ctl, 2) } catch {} }
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

export {
  DIRS8, shaftToBricks, sideStepShaft, cantDigThrough, digStepInto
}
