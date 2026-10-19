'use strict'
// Бой у спавнера — последние шаги оборота в тишине: потушить огонь у ног, поесть, коробка под меч без стрел, конец
// захода без стрел, ожидание под щитом.
import { sleep, xyz } from '../../movement'
import { log, blocksHave, arrowsHave } from '../targets'
import { losClearBut, myEye, blazeEye } from '../radar'
import { planKillBox, buildBunker } from '../bunker'
import { type HoldState, type Tick, type Turn, p0, fireproof, equipSword, setShield, doorPoint } from './state'

// Огонь у ног (шары, прошедшие мимо, жгут пол помоста): в тишине — затушить
// рукой, как игрок (огонь ломается мгновенно). Шаг в огонь — 8 с горения.
export async function stepChores (hs: HoldState, t: Tick): Promise<Turn> {
  const { session, bot, actions, out, setPhase } = hs
  const { now, quiet } = t
  if (!hs.bunker && quiet > 2000 && now - (out.fireAt || 0) > 1500) {
    const feet = bot.entity.position.floored()
    let fire = null
    for (let x = -2; x <= 2 && !fire; x++) for (let z = -2; z <= 2 && !fire; z++) for (const y of [0, 1, -1]) {
      const b = bot.blockAt(feet.offset(x, y, z))
      if (b && b.name === 'fire') { fire = b; break }
    }
    out.fireAt = now
    if (fire && fire.position.offset(0.5, 0.5, 0.5).distanceTo(myEye(bot)) < 4.2 && losClearBut(bot, myEye(bot), fire.position.offset(0.5, 0.3, 0.5), [fire.position])) {
      await setShield(hs, false)
      setPhase('тушу огонь')
      try { await bot.lookAt(fire.position.offset(0.5, 0.2, 0.5), true); await bot.dig(fire, true); out.fires = (out.fires || 0) + 1 } catch {}
      await equipSword(hs)
      return 'next'
    }
  }
  if ((bot.food ?? 20) < 18 && quiet > 2500) {
    await setShield(hs, false)
    setPhase('еда')
    try { await actions.eat(session, {}) } catch {}
    await equipSword(hs)
    return 'next'
  }
}

// Стрел нет, а к окну за 30 с никто не подлетел — из коробки их не
// взять (замер 16: 7 убийств за 32 стрелы, потом ни одного). Выйти
// дверью и драться у спавнера мечом; отдых — снова коробкой.
// Стрел нет — новая коробка вплотную к спавнеру (1.4..3 блока): новые
// блейзы появляются в ±4 от него, и меч через окно их достаёт. Выход в
// открытый бой без стрел кончался смертью (замеры 19, 26: иссушитель).
// По желанию (meleeBox: true): замер 30 — путь к коробке у спавнера шёл по
// горящему помосту мимо иссушителя, 24 хп за переход, смерть. По умолчанию
// без стрел — стоп словами (стрелы кончились), тело в коробке.
export async function stepArrows (hs: HoldState, t: Tick): Promise<Turn> {
  const { session, bot, ctl, ctx, spawner, out, setPhase } = hs
  const { now, bowOk, quietAll } = t
  if (p0(ctx).meleeBox === true && hs.bunker && hs.bunker.window && !bowOk && !hs.bunker.melee && now - hs.lastSwing > 20000 && now - hs.lastBow > 20000 && quietAll > 3000) {
    // Дверь сначала: из закрытой коробки заливка «куда дойти» видит одну клетку.
    const door = hs.bunker.cell.plus(hs.bunker.front)
    try { await (require('../../tools') as typeof import('../../tools')).breakFast(bot, door, { maxMs: 3000 }) } catch {}
    const plan = planKillBox(bot, spawner, blocksHave(bot), { hMin: 1.4, hMax: 3.2, hBest: 2 })
    log('коробка для меча', plan.none ? { none: true, tried: plan.tried } : { cell: xyz(plan.cell), h: plan.h, seen: plan.seen })
    if (!plan.none) {
      const b = await buildBunker(session, ctl, plan, setPhase)
      if (b.ok) { hs.bunker = { cell: plan.cell, front: plan.front, window: true, melee: true }; hs.home = plan.cell; out.meleeBox = xyz(plan.cell) } else { hs.boxPlan = plan; hs.boxTries = 0; hs.bunker = null; hs.home = plan.cell }
      return 'next'
    }
    // Места нет — дверь назад.
    try { await (require('../../build') as typeof import('../../build')).placeBlockAt(bot, door, { timeoutMs: 900 }) } catch {}
    hs.bunker.melee = true
  }
  if (hs.bunker && !bowOk && now - hs.lastSwing > 30000 && now - hs.lastBow > 30000) {
    hs.stopped = arrowsHave(bot) > 0
      ? 'стрелы оставлены в резерве, а к окну коробки блейзы не подлетают — нужен ближний бой или явное разрешение стрелять; стою в коробке'
      : 'стрелы кончились, а к окну коробки блейзы не подлетают — нужны стрелы (или снежки); стою в коробке'
    out.needArrows = true
    return 'stop'
  }
}

export async function stepWait (hs: HoldState, t: Tick): Promise<void> {
  const { spawner, setPhase } = hs
  const { vis } = t
  setPhase('ожидание')
  const face = hs.bunker ? doorPoint(hs) : (vis.length ? blazeEye(vis[0]) : (spawner ? spawner.offset(0.5, 0.5, 0.5) : null))
  await setShield(hs, !fireproof(hs) && (vis.length > 0 || !!spawner), face)
  await sleep(100)
}
