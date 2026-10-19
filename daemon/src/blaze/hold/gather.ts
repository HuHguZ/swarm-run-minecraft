'use strict'
// Бой у спавнера — шаги цикла про добычу: вылазка за стержнями, расчистка спавнера, тишина у спавнера, сбор перед уходом.
import * as gameClock from '../../game-clock'
import { xyz } from '../../movement'
import { countOf } from '../../items'
import { log, ents, droppedRods, isRod, arrowsOnFloor, liveBlazes, arrowsHave } from '../targets'
import { collectRods, walkNear } from '../approach'
import { SHIELD_LEAD_MS, seesMe } from '../radar'
import {
  type HoldState, type Tick, type Turn, p0, fireproof, equipSword, setShield, inBunker, meleeThreat, foesNow
} from './state'

// ND_BLAZE_FP=1 — под огнестойкостью вылазка за стержнями не рвётся шарами (03.10, поток nether).
// По умолчанию вкл. с 03.10 08:10 (B17: ≥ 7 стержней 2/3 со старым боем; до правки — стержни лежали, вылазки рвались);
// откат — ND_BLAZE_FP=0.
const FP_SORTIE = typeof process !== 'undefined' && process.env.ND_BLAZE_FP !== '0'

// --- вылазка: стержни на полу, никто не заряжен — собрать и назад.
export async function stepSortie (hs: HoldState, t: Tick): Promise<Turn> {
  const { bot, ctl, dead, radar, out, setPhase } = hs
  const { now, vis } = t
  const charging = vis.some(e => radar.charged(e))
  // Вылазка: стержень в 4 блоках — хватает 1.5 с тишины (два шага и назад);
  // дальше — 2.5 с и никто не заряжен. Замер 13: из коробки 4 убийства,
  // стержень лежал в 2.7 блока, а тишины в 2.5 с не было ни разу.
  const nearRod = droppedRods(bot, 4, { reachable: true }) > 0
  // Стрел мало, а на полу их хватает — тоже вылазка.
  const arrowRun = arrowsHave(bot) < 10 && arrowsOnFloor(bot, 14).length >= 3
  const quietAll: any = t.quietAll = vis.reduce((m, e) => Math.min(m, radar.untilDanger(e)), Infinity)
  // Под огнестойкостью шар не жжёт вовсе (fireball в #is_fire) — опасен только удар вплотную. neF-XF22-2 03.10: под
  // зельем 24 убийства, 10 стержней в 1–5 бл. на полу, подобрано 0 — каждую вылазку рвал «шар летит».
  const danger = () => (FP_SORTIE && fireproof(hs)) ? !!meleeThreat(hs) : (radar.incoming(gameClock.now()).length > 0 || liveBlazes(bot, dead, 32).some(b => seesMe(bot, b) && radar.untilDanger(b) < 900))
  // Дальняя вылазка — только между волнами (живых блейзов в 20 блоках нет):
  // стержни лежат у спавнера, и при живых её рвало на полпути (замер 27:
  // 2 стержня в 8 блоках, 0 подобрано). Ближний стержень — при тишине.
  // «Между волнами» — ни одного живого в 20 бывает редко: у спавнера кто-то
  // висит всегда (замер 31: 14 убийств, 4 стержня на полу, 0 подобрано).
  // Годится и так: заряженных нет, тишина 2.5 с, у стержня в 6 блоках блейзов
  // нет; вылазка всё равно обрывается по опасности (stopIf).
  const rodsNear = ents(bot).filter((e : any) => e && e.name === 'item' && e.position && isRod(e) && e.position.distanceTo(bot.entity.position) <= 16)
  const calmRod = rodsNear.some((r : any) => !liveBlazes(bot, dead, 32).some((b : any) => b.position.distanceTo(r.position) < 6))
  const clear = !liveBlazes(bot, dead, 20).length || (calmRod && quietAll > 2500)
  // Вылазка — только с 14+ хп; обрыв на < 12 (замеры 34–35: весь урон
  // попыток со смертью — «сбор» и «назад в коробку», 13–26 хп за вызов).
  const sortieStop = () => danger() || (bot.health ?? 20) < 12
  const fpSortie = FP_SORTIE && fireproof(hs) && (bot.health ?? 20) >= 12 && !meleeThreat(hs) && droppedRods(bot, 12, { reachable: true }) > 0
  if (now > hs.sortieAfter && (fpSortie || (!charging && (bot.health ?? 20) >= 14 && ((nearRod && quietAll > 1500) || (clear && (droppedRods(bot, 16, { reachable: true }) > 0 || arrowRun)))))) {
    await setShield(hs, false)
    setPhase('вылазка за стержнями')
    out.sorties++
    const got = countOf(bot, 'blaze_rod')
    let walks = 0
    if (hs.bunker && hs.bunker.window && inBunker(hs)) {
      // Из коробки с окном — дверью: блок под окном выломать, собрать,
      // вернуться, заложить.
      const door = hs.bunker.cell.plus(hs.bunker.front)
      try { await (require('../../tools') as typeof import('../../tools')).breakFast(bot, door, { maxMs: 3000 }) } catch {}
      walks = await collectRods(bot, ctl, 16, 9000, { arrows: arrowRun, stopIf: sortieStop })
      setPhase('назад в коробку')
      await walkNear(bot, ctl, hs.bunker.cell, 0, 6000)
      if (!inBunker(hs)) await walkNear(bot, ctl, hs.bunker.cell, 0, 4000)
      if (inBunker(hs)) {
        await (require('../../fortify') as typeof import('../../fortify')).centerInCell(bot)
        try { await (require('../../build') as typeof import('../../build')).placeBlockAt(bot, door, { timeoutMs: 900 }) } catch {}
      }
    } else {
      walks = await collectRods(bot, ctl, 10, 7000, { arrows: arrowRun, stopIf: sortieStop })
    }
    if (walks < 0) log('вылазка прервана', { walks: -walks - 1 })
    if (walks <= 0 || countOf(bot, 'blaze_rod') === got) hs.sortieAfter = gameClock.now() + 8000
    if (hs.bunker && !inBunker(hs)) { setPhase('назад в шалаш'); await walkNear(bot, ctl, hs.bunker.cell, 0, 8000) }
    return 'next'
  }
}

export async function stepClear (hs: HoldState, t: Tick): Promise<Turn> {
  const { session, bot, ctl, ctx, dead, want, deadline, spawner, radar, out, setPhase } = hs
  const { blazes } = t
  if (spawner && p0(ctx).clearSpawner !== false && process.env.ND_BLAZE_CLEAR !== '0') {
    const workWindow = () => {
      if (meleeThreat(hs) || foesNow(hs).some(e => e.name !== 'blaze')) return 0
      if (fireproof(hs)) return Infinity
      return Math.min(...liveBlazes(bot, dead, 32).filter(e => seesMe(bot, e)).map(e => radar.untilDanger(e)), ...radar.incoming(gameClock.now()).map(b => b.eta)) - SHIELD_LEAD_MS
    }
    // Existing blazes and floor drops satisfy part of the demand before another spawn is useful.
    const remaining = Math.max(0, want - countOf(bot, 'blaze_rod') - droppedRods(bot, 16, { reachable: true }) - blazes.length * .5)
    const at = bot.entity.position
    const inventory = bot.inventory.items().filter(i => /_pickaxe$|^(tnt|flint_and_steel|fire_charge)$/.test(i.name)).map(i => `${i.name}:${i.count}:${i.durabilityUsed}:${JSON.stringify(i.enchants || [])}`).join(',')
    const state = `${hs.clearRevision}/${at.x},${at.y},${at.z}/${remaining}/${inventory}/${fireproof(hs)}/${workWindow() > 0}/${blazes.map(e => `${e.id}:${radar.charged(e)}`).join(',')}/${radar.incoming(gameClock.now()).length}`
    if (remaining && state !== hs.clearChecked) {
      hs.clearChecked = state
      const protectedCells = []
      for (const shelter of [hs.bunker?.cell, hs.boxPlan?.cell, hs.home].filter(Boolean)) {
        for (let x = -1; x <= 1; x++) for (let z = -1; z <= 1; z++) for (let y = -1; y <= 3; y++) protectedCells.push(shelter.floored().offset(x, y, z))
      }
      const clearing: typeof import('../../blaze-clear') = require('../../blaze-clear')
      const plan = clearing.plan(bot, spawner, { rods: remaining, protectedCells, horizon: (deadline - gameClock.now()) / 1000, windowMs: workWindow() })
      if (plan) {
        await setShield(hs, false)
        setPhase('расчистка спавнера')
        const safe = (remainingMs = 0) => countOf(bot, 'blaze_rod') < want && workWindow() > remainingMs && !!bot.entity.onGround && (fireproof(hs) || !(bot.entity.metadata?.[0] & 1))
        const result = await clearing.execute(session, ctl, plan, safe)
        const receipt = { ...result, pos: xyz(plan.pos), mode: plan.mode, gain: plan.gain, beforeUpper: plan.beforeUpper, savedSeconds: plan.savedSeconds, costSeconds: plan.costSeconds, remaining }
        ;(out.clearing || (out.clearing = [])).push(receipt)
        log('расчистка спавнера', receipt)
        await equipSword(hs)
        if (result.ok) hs.clearRevision++
        return 'next'
      }
    }
  }
}

export async function stepIdle (hs: HoldState, t: Tick): Promise<Turn> {
  const { bot, ctl, spawner } = hs
  const { now, blazes } = t
  if (!blazes.length) {
    if (now - hs.idleSince > (spawner ? 50000 : 8000)) {
      if (spawner && hs.silentApproach < 2 && bot.entity.position.distanceTo(spawner.offset(0.5, 0.5, 0.5)) > 15) {
        hs.silentApproach++
        log('спавнер молчит издали — подхожу', { d: Math.round(bot.entity.position.distanceTo(spawner)), n: hs.silentApproach })
        await walkNear(bot, ctl, spawner, 8, 15000)
        hs.idleSince = gameClock.now()
        return 'next'
      }
      hs.stopped = spawner
        ? `спавнер молчит ${Math.round((now - hs.idleSince) / 1000)}с (блейзов нет) — стою в ${Math.round(bot.entity.position.distanceTo(spawner))} бл. от него`
        : 'блейзов в 32 блоках больше не вижу'
      return 'stop'
    }
  } else hs.idleSince = now
}

// Стержни у спавнера — собрать перед уходом (из коробки — дверью: закрытая
// коробка держала тело, 4 стержня так и остались лежать, замер 31).
// Не ниже 12 хп и с обрывом по опасности: этот сбор без проверок брал до
// 26 хп за вызов (замеры 34–35), а стержни пролежат 5 минут — следующий
// вызов их поднимет.
export async function collectBeforeLeave (hs: HoldState) {
  const { bot, ctl, dead, want, radar, setPhase } = hs
  const finalStop = () => (bot.health ?? 20) < 10 || radar.incoming(gameClock.now()).length > 0 || liveBlazes(bot, dead, 32).some(b => seesMe(bot, b) && radar.untilDanger(b) < 900)
  // Набрал — лежащие стержни не нужны; без FR сбор при ифритах в виду — под удары (s1c-L-1 06.10: без FR 12 убийств, 5 стержней,
  // затем «сбор» — 5 ударов вплотную и шары, 20 → 2).
  const calmFloor = fireproof(hs) || !liveBlazes(bot, dead, 10).some(e => seesMe(bot, e))
  if (!hs.bunker?.lowWindow && !ctl.aborted && !hs.bail && droppedRods(bot, 16) > 0 && (bot.health ?? 20) >= 12 && countOf(bot, 'blaze_rod') < want && calmFloor) {
    await setShield(hs, false)
    setPhase('сбор')
    if (hs.bunker && inBunker(hs)) { try { await (require('../../tools') as typeof import('../../tools')).breakFast(bot, hs.bunker.cell.plus(hs.bunker.front), { maxMs: 3000 }) } catch {} }
    await collectRods(bot, ctl, 16, 12000, { stopIf: finalStop })
    if (hs.bunker && !inBunker(hs)) { await walkNear(bot, ctl, hs.bunker.cell, 0, 6000); if (inBunker(hs)) { try { await (require('../../build') as typeof import('../../build')).placeBlockAt(bot, hs.bunker.cell.plus(hs.bunker.front), { timeoutMs: 900 }) } catch {} } }
  }
}
