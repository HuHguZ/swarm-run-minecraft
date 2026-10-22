// Рой: отход по обстановке мира (пользователь 15.10: «режимы по миру, а не по N секундам»). Одно правило для плана
// (plan-flee) и для мгновенной паники драйвера (mustFlee).
//
// Начало — только когда бег что-то даёт: оторваться, пока враг ещё не вплотную; уйти раненым за своих; из безнадёжного
// размена (нечем его ранить) и от толпы — и из контакта: рывок растягивает погоню (duo.ts). В равной рукопашной с врагом
// той же скорости бег — удары в спину (арена 14.10: 9 из 10 смертей на бегу), там бой до конца.
// Конец — тоже по миру, а не через 3 с (стенд 15×15, 21.10: «держу» 141 раз, бой ↔ бегство каждые 1–2 с при полном хп,
// 63 из 75 боёв оборваны, 0 убийств за 11 игровых минут): догнал вплотную — разворот и бой с первым догнавшим, и
// новый бег не начинается, пока он рядом (8 бл.); никого ближе 16 бл. — оторвался; группа стала больше — дошёл до
// своих; рана зажила до 60 %.
import type { SwarmMember, SharedEnemy } from './types'
import type { SwarmFightRisk } from './fight'
import { distance, ratio } from './common'

export type RetreatWhy = 'залп' | 'рана' | 'пустой размен' | 'нас меньше' | 'один'
// turned — догнали: стоит и дерётся, пока догнавший рядом. foes — от кого начат (повод «по силе» проверяется по ним).
export type Retreat = { why: RetreatWhy; group: number; foes: string[]; turned?: boolean }
type Risk = Pick<SwarmFightRisk, 'unsafe' | 'lethal' | 'killSeconds' | 'survivalSeconds' | 'ready' | 'duelKillSeconds' | 'duelSurvivalSeconds'> & { burst?: boolean }

const CONTACT = 4 // бл.: враг ближе — схватка
const ENGAGED = 8 // начатая рукопашная держится, пока враг не дальше (отбросило, отскочил — та же схватка)
const RUSH = 8 // натиск: «контакт» шире — человек со Скоростью II быстрее спринта бота
const CAUGHT = 2.5 // догнал: бежать дальше — подставлять спину
const HEADSTART = 6 // фора для отхода «по силе»: ближе — догонит раньше, чем бег что-то даст (в свалке 15×15 — за секунду)
const TURNED = 12 // развернувшийся дерётся, пока догнавший ближе (отброс удара уносит на 6–8 бл. — это та же схватка)
export const SAFE = 16 // оторвался
const COVER = 10 // свои рядом: раненому есть за кого уйти
const WOUNDED = 0.35
const HEALED = 0.6

export const nearestGap = (m: SwarmMember, enemies: SharedEnemy[]) => Math.min(Infinity, ...enemies.map(e => distance(e.position, m.position)))
export function inContact(m: SwarmMember, enemies: SharedEnemy[], fighting: boolean, aggressive = false): boolean {
  return nearestGap(m, enemies) <= (aggressive ? RUSH : fighting ? ENGAGED : CONTACT)
}
export const caughtBy = (m: SwarmMember, enemies: SharedEnemy[]) => nearestGap(m, enemies) <= CAUGHT
export const alliesNear = (m: SwarmMember, team: SwarmMember[]) => team.some(a => a.id !== m.id && a.health > 0 && distance(a.position, m.position) <= COVER)

// Повод начать отход или null — драться.
export function retreatWhy(m: SwarmMember, risk: Risk, { contact, caught = false, headstart = Infinity, allies = false, futile = false, outnumbered = false, aggressive = false, shelter = true, alone = !allies, behind = true, blast = false }: { contact: boolean; caught?: boolean; headstart?: number; allies?: boolean; futile?: boolean; outnumbered?: boolean; aggressive?: boolean; shelter?: boolean; alone?: boolean; behind?: boolean; blast?: boolean }): RetreatWhy | null {
  // Натиск (соло-арена против людей): бегут только на хилку и не из схватки.
  if (aggressive) return !contact && risk.unsafe && ratio(m) < WOUNDED ? 'рана' : null
  // Взрыв рядом (кристалл, якорь — blast) не догоняет, он взрывается, где стоит: от него — всегда и без форы, при любой оценке
  // боя (DeepSeek, ревью 21.10: ранний выход «безопасно» стоял раньше и глушил эту ветку).
  if (blast) return 'залп'
  if (!risk.unsafe && !risk.lethal) return null
  if (ratio(m) < WOUNDED && (!contact || allies)) return 'рана'
  // Безнадёжный размен (нечем его ранить) — бежать и вплотную: драться там нечем, шанс только в беге. Задавили числом — к
  // своим и без форы (рывок растягивает погоню, duo.ts), но не когда уже догнали. Бег должен что-то давать: своих, к кому
  // отойти (shelter), или — пустому размену — лут, которым он отстаёт от врага (behind, race.ts). Иначе последние на ногах
  // бегали от толпы до конца раунда — прятки вместо боя (стенд 15×15, 21.10: 2 красных против 13 синих).
  if (futile && risk.unsafe && (shelter || behind)) return 'пустой размен'
  if (outnumbered && risk.unsafe && !caught && shelter) return 'нас меньше'
  // Один на один — без форы (враг ближе 6 бл.) отход сразу кончился бы «догнал»: в свалке 15×15 это давало «бегство →
  // бой» каждую секунду (стенд 21.10: 171 смена за 113 с, 313 за 179 с). Рвать контакт — когда есть фора.
  if (caught || headstart <= HEADSTART) return null
  if (risk.lethal && !contact) return 'залп'
  if (!risk.unsafe || contact) return null
  // Один — своих нет в 10 бл. (буквально один: «успеют ли помочь» по времени выживания в свалке давало «один» при пятерых
  // своих рядом, стенд 21.10) — против того, кто в схватке без подхода убивает вдвое быстрее и больше чем на секунду (а не
  // «убить > 3 с»: каменный меч голышом против железа с алмазом — 2.9 с против 0.6 с — шёл в бой).
  // Отход «один» — к своей группе (shelter): идти не к кому (последний на ногах, все свои в безнадёжных схватках) — бой
  // до конца, а не прятки (пользователь 14.10: «рои вырезают друг друга, не прячутся»). Один — сам себе группа (alone,
  // цепочка своих в 16 бл.): в растянутой группе без соседа в 10 бл. «один» бежал к другой группе от своей (стенд 21.10).
  const kill = risk.duelKillSeconds ?? risk.killSeconds, live = risk.duelSurvivalSeconds ?? risk.survivalSeconds
  if (alone && shelter && kill > 2 * live && kill > live + 1) return 'один'
  return null
}

// Держится ли повод начатого отхода (против тех же врагов, без учёта расстояния) — со своим порогом конца, ниже порога
// начала (гистерезис по миру): «один» начинается при проигранной вдвое дуэли без помощников, а кончается, когда помощник
// успевает или дуэль проиграна меньше чем в 1.5 раза — иначе мигал с оценкой прихода помощников (лекарь «лечу ↔ бегу»
// каждую секунду, стенд 21.10). Групповой повод — по счёту текущей группы против тех же врагов (assessTeamFight), с запасом:
// пустой размен начинается, когда наши потери втрое больше их, а кончается, когда меньше полутора раз (проходящий мимо свой
// давал «2 против 1» и конец, отошёл — снова «пустой»); «нас меньше» — пока нас выносят. score — null, если их не видно.
type GroupScore = { ourLoss: number; theirLoss: number; wipedUs: boolean; theirs: number } | null
export function retreatHolds(held: Retreat, risk: Risk, { score, allies = false, shelter = true, alone = !allies }: { score: GroupScore; allies?: boolean; shelter?: boolean; alone?: boolean }): boolean {
  // Залп — пока их первый залп вплотную убивает (burst), без гонки подхода: бегущий сам растягивает их подход, и «уже не
  // смертельно» кончало отход от собственного бега (стенд 15×15, 21.10: «иду ↔ бегу от залпа» 58 раз за раунд).
  if (held.why === 'залп') return !!(risk.burst ?? risk.lethal)
  // «Один» — до своих: пересчёт дуэли гуляет с тем, кого из врагов видно, и конец по нему возвращал бота к тем же врагам
  // одного (стенд 15×15, 21.10: «один» кончался через 1–2 с в 40 из 105 отходов, бой ↔ бегство 30 раз за 2 мин).
  if (held.why === 'один') return alone && !allies && shelter
  if (held.why === 'пустой размен') return !!score && (score.ourLoss > 1.5 * Math.max(score.theirLoss, .5) || score.wipedUs && score.theirLoss < score.theirs / 2)
  if (held.why === 'нас меньше') return !!score && score.wipedUs
  return true
}

// Ход отхода: 'run' — продолжать; 'turn' — догнали, стоять и драться; 'end' — кончился (запись стереть).
// group — размер своей группы сейчас (groupOf); still — повод отхода есть и сейчас, без учёта расстояния (retreatWhy
// с contact: false). Отход «по силе» (один, пустой размен, нас меньше, залп) кончается, когда изменилась сила — свои
// подошли, снаряжение, враг ранен или пропал, а не расстояние: оторвавшийся на 16 бл. шёл назад к тому же врагу и у
// 16 бл. снова бежал (стенд 15×15, 21.10: «бегство → поход» 242 раза за раунд). Вдали отход — это лут и подготовка.
export function retreatStep(m: SwarmMember, held: Retreat, enemies: SharedEnemy[], { allies = false, group = 1, still = true, blast = false }: { allies?: boolean; group?: number; still?: boolean; blast?: boolean } = {}): 'run' | 'turn' | 'end' {
  const gap = nearestGap(m, enemies)
  // Развернулся: дерётся, пока догнавший рядом; рана при своих рядом — снова за них.
  if (held.turned) return gap > TURNED ? 'end' : held.why === 'рана' && allies ? 'run' : 'turn'
  if (held.why === 'рана' ? ratio(m) >= HEALED || gap > SAFE && !still : held.why === 'залп' ? !still || gap > SAFE && ratio(m) >= .9 : !still) return 'end'
  // Взрыв вплотную — не «догнал»: от него прочь, а не в бой (DeepSeek, ревью 21.10).
  if (gap <= CAUGHT && !blast && held.why !== 'пустой размен' && !(held.why === 'рана' && allies)) { held.turned = true; return 'turn' }
  // Дошёл до своих — группа выросла хотя бы на двоих: в свалке группа гуляет на одного каждые полсекунды.
  if (held.why !== 'рана' && held.why !== 'залп' && group >= held.group + 2) return 'end'
  return 'run'
}
