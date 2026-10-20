'use strict'
// Лагерь у спавнера — campSpawner: оркестр лагеря. Состояние — camp/state.ts (объект cs), ходы тела (столб, чашка, лук,
// спуск) — camp/moves.ts, оборот цикла — шаги по порядку (camp/steps.ts), яма у спавнера — camp/hole.ts.
import * as gameClock from '../game-clock'
import { countOf } from '../items'
import { log } from './targets'
import { type CampState, openCamp } from './camp/state'
import { campDescend } from './camp/moves'
import { holeCamp } from './camp/hole'
import {
  type Turn, type CampTick, campPotion, campEat, campLook, campMelee, campWither, campSword, campDown, campRods, campChase,
  campBow, campHug, campIdle
} from './camp/steps'

// Порядок шагов оборота — порядок веток прежнего тела while: первая сработавшая ветка решает оборот.
const CAMP_STEPS: ((cs: CampState, tk: CampTick) => Promise<Turn | void>)[] = [
  campPotion, campEat, campLook, campMelee, campWither, campSword, campDown, campRods, campChase, campBow, campHug, campIdle
]

// Бой «у самого спавнера» под огнестойкостью (ND_BLAZE_CAMP=1, поток nether 03.10). Под зельем шар блейза не жжёт
// вовсе (fireball в #is_fire, LivingEntity.hurt), опасен только удар вплотную (6, в железе ~3.4 — BlazeAttackGoal).
// Блейзы спавнера появляются в ±4 от него и по высоте −1..+1 (BaseSpawner spawnRange 4) — стоять у самого спавнера.
// Иссушители спавнятся на кирпиче помоста и бьют вплотную (neF-B5f22-1 03.10: 3 блейза за 16 с, потом два иссушителя
// — 18 урона ударами и 6 иссушением за 16 с, смерть). Поэтому — столб в 3 блока на помосте: рамка удара моба — его
// рамка, раздутая по горизонтали (Mob.getAttackBoundingBox, 1.20.5+), по высоте — нет; иссушитель 2.4 в высоту, ноги
// тела на +3 — не достаёт. С вершины: меч по блейзам в досягаемости, лук по дальним. Стержни падают на помост — слезть
// (шаг со столба, 3 блока без урона), собрать, снова столб; иссушитель на помосте — сперва его луком сверху.
async function campSpawner (session, ctl, opts: any) {
  const cs = openCamp(session, ctl, opts)
  const { bot, spawner, want, deadline, dead, setPhase } = cs
  // Основное место — на помосте у спавнера (блейзы появляются в ±4 и по высоте −1..+1 — там их и бить: B5f23 03.10,
  // на полу 14 убийств за 278 с; со столба +3 — 0–6 за 5–6 мин, B9f21/B9f23: блейз с лучом к цели не подлетает,
  // BlazeAttackGoal только стреляет). Столб с чашкой — укрытие от иссушителя (он не достаёт ноги на +3): забраться,
  // луком его сверху, слезть.
  // Место под стержни (рюкзак, набитый незераком после хода, не подбирал стержень в 1 бл.: B16f21 03.10).
  try { await (require('../nether-route') as typeof import('../nether-route')).makeRoom(bot, 6) } catch {}
  await cs.equipSword()
  // Яма у спавнера (ND_BLAZE_HOLE=1): сверху — сперва вниз, потом яма; вышло мало — дальше гибрид как был.
  if (process.env.ND_BLAZE_HOLE === '1' && spawner) {
    if (cs.onTop()) await campDescend(cs)
    if (!cs.onTop()) {
      cs.out.want = want
      const hr = await holeCamp(session, ctl, { spawner, want, deadline, dead, setPhase, out: cs.out, equipSword: cs.equipSword, shield: cs.shield, frLeft: cs.frLeft })
      cs.out.holeResult = hr && hr.why
      // Остались в яме (время/без убийств/мало хп при живой огнестойкости) — лагерь на столбе не начинать, вернуть управление.
      if (bot.entity.position.y < cs.floorY - 0.5 && cs.out.hole && cs.out.stopped !== 'набрал') { cs.out.inHole = true; cs.out.stopped = cs.out.stopped || 'время вышло'; cs.out.rods = countOf(bot, 'blaze_rod'); cs.out.seconds = Math.round((gameClock.now() - cs.t0) / 1000); cs.out.kills = dead.size; log('лагерь итог', cs.out); return cs.out }
    }
  }
  cs.up = cs.onTop()
  setPhase('лагерь у спавнера')
  turn: while (!ctl.aborted && gameClock.now() < deadline) {
    const tk: CampTick = {}
    for (const step of CAMP_STEPS) {
      const r = await step(cs, tk)
      if (r === 'stop') break turn
      if (r === 'next') continue turn
    }
  }
  try { await cs.shield(false) } catch {}
  bot.setControlState('sneak', false)
  cs.out.rods = countOf(bot, 'blaze_rod') - cs.out.rods0
  cs.out.seconds = Math.round((gameClock.now() - cs.t0) / 1000)
  cs.out.kills = dead.size
  if (!cs.out.stopped) cs.out.stopped = ctl.aborted ? 'прервано' : 'время вышло'
  log('лагерь итог', cs.out)
  return cs.out
}

export { campSpawner }
