// S1e 07.10 (проверка S1d (б)): пауза бастиона и ифриты без огнестойкости — цена, а не запрет «только с FR».
// Ифриты обязательны (стержни), поэтому вопрос один: идти к ним сейчас или переждать паузу бастиона, где следующие сделки могут
// принести огнестойкость. Риск этапа — та же калибровка s1c, что в графе (core/speedrun blazeRisk): 0.35 с FR, 0.7 без,
// +0.04 без щита, ×2 ниже 10 хп. Цена смерти — час (как shortfallTicks графа: проигранный прогон).
// Ждать стоит, только если ожидаемое снижение риска × цена смерти больше оставшейся паузы.
import { chanceAll } from '../core/barter-model'

export interface PauseChoiceInput {
  fireRes: boolean
  pauseLeftSeconds: number
  /** Слитки, которые после паузы ещё уйдут пиглинам: в рюкзаке + ожидаемые из бастиона. */
  ingotsAfterPause: number
  shield?: boolean
  hp?: number
  delivery?: number
  deathSeconds?: number
}
export interface PauseChoice { wait: boolean; rNow: number; rLater: number; pFR: number; gainSeconds: number; why: string }

export function blazeStageRisk(fireRes: boolean, shield = true, hp = 20): number {
  return Math.min(1, ((fireRes ? 0.35 : 0.7) + (shield ? 0 : 0.04)) * (hp < 10 ? 2 : 1))
}

export function pauseBlazeChoice(s: PauseChoiceInput): PauseChoice {
  const shield = s.shield !== false
  const hp = s.hp ?? 20
  const left = Math.max(0, s.pauseLeftSeconds)
  const rNow = blazeStageRisk(s.fireRes, shield, hp)
  if (s.fireRes || left <= 0) return { wait: false, rNow, rLater: rNow, pFR: s.fireRes ? 1 : 0, gainSeconds: 0, why: s.fireRes ? 'огнестойкость есть — ифриты сейчас, пауза бастиона не ждётся' : 'паузы нет' }
  const pFR = chanceAll(Math.max(0, Math.floor(s.ingotsAfterPause)), { fire_resistance: 1 }, s.delivery ?? 0.85)
  const rLater = pFR * blazeStageRisk(true, shield, hp) + (1 - pFR) * rNow
  const gainSeconds = (rNow - rLater) * (s.deathSeconds ?? 3600)
  const wait = gainSeconds > left
  return { wait, rNow, rLater, pFR, gainSeconds, why: `без FR: риск ${rNow.toFixed(2)} сейчас против ${rLater.toFixed(2)} после паузы (P(FR) ${pFR.toFixed(2)} за ${Math.floor(s.ingotsAfterPause)} сл.) — выигрыш ${Math.round(gainSeconds)} с ${wait ? '>' : '≤'} паузы ${Math.round(left)} с → ${wait ? 'жду бастион' : 'ифриты сейчас'}` }
}


// S1e: выход из Ада — пешком к своему порталу или новый портал из своего обсидиана на месте (10 блоков + огниво). Цена пути —
// время хода (2.5 бл/с, как route.ts) + риск хода по Аду (J22-3 S1d: 13 жемчуга, 12 очей — шар гаста на пешем ходе домой) × час;
// цена рамы — ~60 с стройки и 0.01 риска. ponytail: риск 0.02 на 100 бл. — грубая оценка по смертям «на выходе» S1c/S1d; уточнять
// телеметрией этапа LeaveNether (фаза «выход» в s1e/phases.js).
export interface ExitChoiceInput { homeDistance: number; obsidian: number; lighter: boolean; deathSeconds?: number; riskPer100?: number }
export function exitChoice(s: ExitChoiceInput): { build: boolean; walkSeconds: number; buildSeconds: number; why: string } {
  const death = s.deathSeconds ?? 3600
  const walkSeconds = s.homeDistance / 2.5 + (s.homeDistance / 100) * (s.riskPer100 ?? 0.02) * death
  const buildSeconds = 60 + 0.01 * death
  const can = s.obsidian >= 10 && s.lighter
  const build = can && buildSeconds < walkSeconds
  return { build, walkSeconds, buildSeconds, why: `домой ${Math.round(s.homeDistance)} бл. ≈ ${Math.round(walkSeconds)} с с риском, рама на месте ≈ ${Math.round(buildSeconds)} с${can ? '' : ' (обсидиана/огнива нет)'} → ${build ? 'новый портал здесь' : 'к своему порталу'}` }
}
