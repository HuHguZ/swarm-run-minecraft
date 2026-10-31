// Рой (swarm.ts): план боя (planPvp) — ва-банк и бегство (погоня, паника, перегруппировка), затем раненые и лекари.
import * as damage from '../pvp/damage-model'
import type { SwarmMember, SwarmPosition, SharedEnemy } from './types'
import type { PvpPlan } from './plan-frame'
import { markFled, pvpState } from './board'
import { distance, ratio, count, cellKey } from './common'
import { assessSwarmFight, assessTeamFight, groupOf, TEAM_LINK, REINFORCE_LINK } from './fight'
import { retreatWhy, retreatStep, retreatHolds, inContact, alliesNear, caughtBy, nearestGap, SAFE } from './retreat'
import { behindRace } from './race'

// Срок до укрытия: ходьба спринтом 5.6 бл/с + 1 с на блок подъёма (как travelCost драйвера) против подлёта летуна. Для крыши
// проверку срока убрали: A/B cl30 (29.10, по 3 раунда) — с ней смертей в отходе 8 против 6, всего 70 против 64.
const walkSeconds = (m: SwarmMember, at: SwarmPosition) => distance(at, m.position) / 5.6 + Math.max(0, at.y - m.position.y)
// Через сколько он у меня: по скорости сближения (не полной) — кружащий в стороне долетит не раньше разворота, тогда не быстрее ходьбы.
function arrivalSeconds(m: SwarmMember, foe: SharedEnemy): number {
  const v = foe.velocity, gap = distance(foe.position, m.position) || 1
  const closing = v ? ((m.position.x - foe.position.x) * v.x + (m.position.y - foe.position.y) * v.y + (m.position.z - foe.position.z) * v.z) / gap * 20 : 0
  return gap / Math.max(closing, 5.6)
}

// Коробка на месте (fortify.boxIn через box_in: стены в два блока и крыша, до 9 блоков по ≈ 0.18 с + центровка 0.35 с); драйвер
// строит её только при 10+ блоках (turn-tasks turnHold). Блоки — как BLOCK драйвера (farm/swarm/swarm-driver/common.ts).
const BOX_SECONDS = 9 * .18 + .35, WALL_SECONDS = 2 * .25
const anyBlocks = (m: SwarmMember) => Object.entries(m.inventory || {}).filter(([n]) => /^(cobblestone|stone|dirt|smooth_sandstone|cut_sandstone|sandstone|sand|red_sand|netherrack|.*_planks)$/.test(n)).reduce((s, [, c]) => s + (c as number), 0)
// Выйти из коробки нужно уметь (box_in иначе отказывает: «выйти не смогу: нет мягких блоков и кирки» — 13 из 19 попыток cl29j–m):
// с киркой — любые блоки, без неё — только мягкие (земля, доски, песок — рукой быстро), как fortify.refugeFiller/canBreakOut.
const boxBlocks = (m: SwarmMember) => {
  const inv = m.inventory || {}, pick = Object.keys(inv).some(n => /_pickaxe$/.test(n) && inv[n] > 0)
  const ok = pick ? /^(cobblestone|stone|dirt|smooth_sandstone|cut_sandstone|sandstone|sand|red_sand|netherrack|.*_planks)$/ : /^(dirt|sand|red_sand|.*_planks)$/
  return Object.entries(inv).filter(([n]) => ok.test(n)).reduce((s, [, c]) => s + (c as number), 0)
}
export function pvpFlee(S: PvpPlan): void {
  const { board, team, enemies, aggressive, assault, forward, groups, futile, outnumbered, hopeless, put, weak, outclassed, perchFor, rallyFor, hideoutFor, archer, threatReach } = S
  // Ва-банк (пользователь 14.10: «когда мало хп, я начинаю убегать, а они не гонятся добивать — если чувствуют слабость,
  // должны ва-банк идти и добивать»): цель с оценкой хп ≤ 10 (по нашим попаданиям и видимому лечению, не метаданные),
  // виденная за 3 с, — добивание: все, у кого есть оружие, в 32 бл. — прямо на неё; бегства и лечения у них нет, кроме
  // смертельного залпа.
  const prey = aggressive ? enemies.filter(e => (e.hpEstimate ?? 20) <= 10 && board.now() - e.seenAt < 3000).sort((a, b) => (a.hpEstimate ?? 20) - (b.hpEstimate ?? 20))[0] : undefined
  const hunting = (m: SwarmMember) => !!prey && distance(m.position, prey.position) <= 32 && Object.keys(m.inventory || {}).some(n => count(m.inventory, n) > 0 && (damage.isMeleeWeapon(n) || /^(bow|crossbow|trident)$/.test(n)))
  const retreats = pvpState(board).retreats
  for (const [i, m] of team.entries()) {
    // Финал — последний бой, не сохранение команды в укрытии. Рана остаётся фазе pvpRecover; аварии — телу.
    if (S.endgame) { retreats.delete(m.id); continue }
    const risk = assessSwarmFight(m, enemies, team)
    // Ракеты разрывают и ближний контакт: смертельный размен (его ближний удар добьёт до моего) — на безопасный насест, даже без
    // хилки. Только смертельный: «проигранный» (выжить < убить) против человека в незерите — почти любой контакт с полным хп, и рой
    // бросал бой ради насеста за гребнем, куда не долететь (игра пользователя 23.10: «бегут навстречу и ничего не делают», хп 20).
    const airExit = risk.lethal && inContact(m, enemies, true, aggressive) ? perchFor(m) : null
    if (airExit) {
      put(m, 'flee', { target: risk.target, perch: true, panic: true, risk, reason: 'воздушный отход, ' + risk.reason }, airExit)
      continue
    }
    if (hunting(m) && !risk.lethal) continue
    // Погоня за слабым или переигранным (стенд rush 15.10: «прячусь» вело в тупик-камеру, он догонял — бой 1–2 удара и смерть):
    // к своим (и слабым — толпа бьёт его со спины) или в отрыв по открытому (smartFlee тела сам обходит тупики); последний
    // бой — только физически зажатым (исполнитель: cornered); оторвался дальше 22 — лут (Codex 15.10).
    const near = aggressive ? [...enemies].sort((a, b) => distance(a.position, m.position) - distance(b.position, m.position))[0] : undefined
    const gap = near ? distance(m.position, near.position) : Infinity
    const v = near?.velocity
    const coming = !!near && board.now() - near.seenAt < 1000 && ((m.position.x - near.position.x) * (v?.x || 0) + (m.position.z - near.position.z) * (v?.z || 0)) / (gap || 1) > .1
    // Лучник в виду — уже погоня: ему не нужно подходить (стенд 21.10: стрелы на бегу в 11–14 бл.). Только издали (> 8 бл.):
    // вплотную лучник — тот же рукопашник, а бег «за укрытие» в 0–1 бл. от него — смерть спиной (игра пользователя 21.10:
    // у людей лук в наборе — 19 из 38 смертей от меча с «ухожу от лучника за укрытие (враг в 1 бл.)»).
    // Граница — не 8 бл., а его бег за 1.5 с: человек со «Скоростью» догонял за секунду (игра пользователя 24.10: элитровый
    // сел в 8 бл., «ухожу от лучника за укрытие» — смерть спиной через 4 с).
    const ranged = !!near && gap > Math.max(8, 4.5 + Math.hypot(v?.x || 0, v?.z || 0) * 30) && archer(near)
    // Погоня помнит своё начало отдельно от способа ухода: остановка врага не отправляет нас в копатели.
    const pursuing = coming || ranged && board.now() - near.seenAt < 1000 || board.tasks().some(t => t.assignedTo === m.id && t.kind === 'flee' && (t.data?.kite || t.data?.pursuit) && t.data.target === near?.id)
    // Начатая рукопашная не рвётся погоней (в контакте он всегда «идёт на меня»; стенд rush 15.10: fight → flee 66 раз, каждый —
    // stop боя): дерущийся уходит, только когда он дальше 6 бл.
    const prevKind = board.tasks().find(t => t.id === `pvp:${m.id}`)?.kind
    // Лутающий уходит от погони с той же границы 16, что и ветка слабых (Codex 15.10: правило погони с 22 обходило
    // гистерезис 16/22 — «лут ↔ бегство» на 17–22 бл.).
    const far = near ? threatReach(near) : 16
    // Скорость погони не исключает спуск и прокоп: последний бой решает тело после реальной проверки выходов.
    // Он быстрее (Скорость: > 0.3 бл/т, спринт без зелья — 0.28) и уже в 6 бл. — пешком не уйти, только спиной под меч: драться
    // (игра пользователя 25.10: «ухожу от погони (враг в 5 бл.)» — убит через 2 с, не ударив).
    // Безоружному — уходить, как прежде (спуск, прорыв тела); есть чем уйти (жемчуг, элитры с ракетами, заряд ветра) — уходить им
    // сразу (отход ниже), а не ждать, пока догонит.
    const inv = m.inventory || {}
    const escapes = (inv.ender_pearl || 0) > 0 || (inv.wind_charge || 0) > 0 || (inv.chorus_fruit || 0) > 0 || (!!inv.elytra || Object.values(m.armor || {}).includes('elytra')) && (inv.firework_rocket || 0) >= 5
    // Когда догонит — по его скорости на меня против моего спринта (0.28 бл/т): до удара (3 бл.) за t = (gap − 3)/(vк − 0.28).
    // Меньше 3 с — бегом не уйти (пользователь 25.10: «по вектору скорости моему и своему считать, когда догоню»).
    const closing = near ? ((m.position.x - near.position.x) * (v?.x || 0) + (m.position.z - near.position.z) * (v?.z || 0)) / (gap || 1) : 0
    const catchS = closing > .28 ? Math.max(0, gap - 3) / (closing - .28) / 20 : Infinity
    const outrun = catchS < 3 && !escapes && Object.keys(inv).some(k => /_sword$|_axe$|^mace$|_spear$/.test(k))
    if (near && gap <= (prevKind === 'loot' ? far : far + 6) && pursuing && !outrun && !(prevKind === 'fight' && gap <= 6) && !assault?.voters.includes(m.id) && (weak(m) || outclassed(m, near))) {
      // От лучника — за укрытие (стена ломает линию выстрела), иначе к своим или в отрыв.
      // От лучника и от тарана — за укрытие (стена ломает выстрел и луч копья); к летуну на насест не лететь.
      const rammer = near.threat === 'aerial', perch = rammer ? null : perchFor(m), den = !perch && (ranged || rammer) ? hideoutFor(m) : null
      const cover = den || null, group = !perch && !cover && rallyFor(m, near)
      markFled(board, m.id)
      put(m, 'flee', { target: near.id, enemyPosition: near.position, panic: true, pursuit: true, ...(perch ? { perch: true } : cover ? { hide: true } : { kite: true, regroup: !!group }), reason: `ухожу от ${cover ? 'лучника за укрытие' : 'погони'} (враг в ${Math.round(gap)} бл.)` }, perch || cover || group || m.position)
      continue
    }
    // Отход по миру (retreat.ts): начатый держится, пока мир его не кончит (догнал, оторвался, дошёл до своих, зажило),
    // а не 3 с паники — она мигала с оценкой «бой ↔ бегство» каждые 1–2 с (стенд 15×15, 21.10).
    const mine = groupOf(team, m, aggressive ? undefined : TEAM_LINK), allies = alliesNear(m, team), group = mine.length
    // Самая большая группа своих, что не в безнадёжной схватке, — куда отходить.
    const shelter = groups.filter(g => !g.includes(m) && !g.some(a => hopeless.has(a.id))).sort((p, q) => q.length - p.length)[0]
    let held = retreats.get(m.id)
    const verdict = { allies, futile: futile.has(m.id), outnumbered: outnumbered.has(m.id), aggressive, shelter: !!shelter, alone: (aggressive ? group : groupOf(team, m, REINFORCE_LINK).length) === 1, behind: behindRace(S, m), blast: enemies.some(e => e.threat === 'blast' && distance(e.position, m.position) <= 8) }
    // Повод начатого отхода — по тем же врагам и без учёта расстояния (вдали группа «не видит» их в 12 бл.), со своим
    // порогом конца (retreatHolds). Враги пропали из виду: рана и залп кончены (оторвался), а отход от силы («один», пустой
    // размен, нас меньше) держится, пока есть к кому отойти, — иначе бот шёл назад к тем же врагам (стенд 15×15, 21.10:
    // «бегу → иду к ним» 107 раз за раунд); кончается, когда дошёл до своих (retreatStep: группа +2).
    const was = held && enemies.filter(e => held!.foes.includes(e.id))
    const unseen = !!held && !was?.length
    const holds = !!held && retreatHolds(held, assessSwarmFight(m, was || [], team), { score: assessTeamFight(mine, was || []), allies, shelter: !!shelter, alone: group === 1 })
    const still = !!held && (unseen ? !!shelter && held.why !== 'рана' && held.why !== 'залп' && (held.why !== 'один' || holds) : holds)
    const wasTurned = held?.turned
    const step = held && !assault ? retreatStep(m, held, enemies, { allies, group, still, blast: verdict.blast }) : 'end'
    if (held && (step === 'end' || step === 'turn' && !wasTurned) && process.env.ND_SWARM_TRACE) console.log(`[${new Date().toTimeString().slice(0, 8)}] 🔚 ${m.id}: ${held.why} → ${step}${assault ? ' (штурм)' : ''} still=${still} gap=${nearestGap(m, enemies).toFixed(1)} group=${group}/${held.group} allies=${allies} hp=${Math.round(ratio(m) * 100)}%${held.turned ? ' turned' : ''}`)
    if (held && step === 'end') { retreats.delete(m.id); held = undefined }
    // Догнали — бой с догнавшим сразу (иначе фаза раненых уводила его «в середину» спиной к нему; DeepSeek, ревью 21.10).
    if (step === 'turn') { const catcher = [...enemies].sort((a, b) => distance(a.position, m.position) - distance(b.position, m.position))[0]; if (catcher) put(m, 'fight', { target: catcher.id, enemyPosition: catcher.position, turned: true }, catcher.position); continue }
    const why = held?.why ?? (assault ? null : retreatWhy(m, risk, { ...verdict, contact: inContact(m, enemies, prevKind === 'fight', aggressive), caught: caughtBy(m, enemies), headstart: nearestGap(m, enemies) }))
    if (!why) continue
    // Враги отхода — те же, по кому вынесен приговор: группе — враги у любого из группы (groupVerdict), себе — в 16 бл.
    // (стенд 21.10: пустой размен начинался по 15 врагам группы, держался по четверым у бота — и кончался через секунду).
    const byGroup = why === 'пустой размен' || why === 'нас меньше'
    if (!held) retreats.set(m.id, { why, group, foes: enemies.filter(e => byGroup ? mine.some(a => distance(a.position, e.position) <= TEAM_LINK) : distance(e.position, m.position) <= 16 || e.id === risk.target).map(e => e.id) })
    const middle = (g: SwarmMember[]) => ({ x: g.reduce((sum, a) => sum + a.position.x, 0) / g.length, y: g[0].position.y, z: g.reduce((sum, a) => sum + a.position.z, 0) / g.length })
    // Оторвался от смертельного залпа — лечиться вдали, пока залп не перестанет убивать (иначе «бегу ↔ иду к ним»: стенд
    // 15×15, 21.10 — 40 миганий за раунд); лечиться некуда (90 %+) — retreatStep кончил отход, бой.
    if (why === 'залп' && held && nearestGap(m, enemies) > SAFE) { put(m, 'recover', { ally: m.id, reason: 'держу залп, лечусь' }, shelter ? middle(shelter) : m.position); continue }
    const threat = enemies.find(e => e.id === risk.target) || [...enemies].sort((a, b) => distance(a.position, m.position) - distance(b.position, m.position))[0]
    // Оторвался — дальше к своим и без врагов в виду (исполнитель идёт к точке), а не назад к ним.
    if (!threat && held && shelter) { put(m, 'flee', { target: held.foes[0], panic: true, regroup: true, reason: `держу ${why}, к своим` }, middle(shelter)); continue }
    if (!threat) continue
    let dx = m.position.x - threat.position.x; let dz = m.position.z - threat.position.z
    if (Math.hypot(dx, dz) < 0.1) { dx = -forward.x; dz = -forward.z }
    const length = Math.hypot(dx, dz) || 1
    const turn = (i - (team.length - 1) / 2) / Math.max(1, team.length) * Math.PI * 0.75
    const x = (dx * Math.cos(turn) - dz * Math.sin(turn)) / length
    const z = (dx * Math.sin(turn) + dz * Math.cos(turn)) / length
    // Перегруппировка: целый, но в безнадёжной местной схватке — бежать к своим, к середине самой большой группы, что не
    // в безнадёжной схватке, а не куда глаза глядят: так группа растёт и бой продолжается (арена 14.10: отход «прочь от
    // угрозы» рассыпал строй, и вместо сбора было 300 бегств при полном хп). Раненый и смертельный залп — прочь, как прежде.
    const home = why === 'один' || !risk.lethal && ratio(m) >= .35 ? shelter : undefined
    const away = { x: m.position.x + x * 12, y: m.position.y, z: m.position.z + z * 12 }
    // Причина отхода — в журнал драйвера; «держу» — начатый отход, который мир ещё не кончил.
    const cause = held ? 'держу ' + why : why
    // Один — к своим, а не на насест: отход «один» кончается, когда дошёл до группы (retreatStep), а с насеста он к ним не
    // подходит и держится вечно (Codex 26.10, AA-N-HOLD-NEXT: здоровый n 196 с на насесте до конца раунда, вайпа нет).
    // Начатый пустой размен тоже кончается у своих; насест не увеличивает группу.
    // От тарана (он на элитрах): бег по открытому не спасает — он проходит 12 бл. меньше чем за секунду, насест — полёт ему навстречу;
    // под крышей (камера, галерея) его копьё не достаёт (луч KineticWeapon обрывают блоки). Свои ближе крыши — к ним, как прежде
    // (cl28 28.10: 35 из 127 наземных смертей — в этом отходе, почти все с полным хп и одни).
    const den = threat.threat === 'aerial' ? hideoutFor(m) : null
    const roof = den && (!home || distance(den, m.position) < distance(middle(home), m.position)) ? den : null
    // Ни крыши, ни своих в срок, а блоки есть — коробка на месте, если успею до его подлёта (пользователь 28.10: «укрытия умеют строить …
    // если не можешь убежать быстро»). Выход — box_out, когда план даст другое дело (угроза ушла), не по таймеру.
    // Коробка не встаёт или из неё не выйти — стенка на линии подлёта (take_cover wall: 2 бл. высотой в 1.5 бл. в его сторону, при
    // пикировании — 3): луч копья обрывают блоки (ProjectileUtil.getHitEntitiesAlong — COLLIDER, jar 1.21.11), выходить не нужно.
    const boxFailed = board.facts().some(f => f.id === `box-failed:${m.id}:${cellKey(m.position)}`)
    const box = !boxFailed && boxBlocks(m) >= 10 && BOX_SECONDS <= arrivalSeconds(m, threat)
    const wall = !box && !board.facts().some(f => f.id === `wall-failed:${m.id}:${cellKey(m.position)}`) && anyBlocks(m) >= 2 && WALL_SECONDS <= arrivalSeconds(m, threat)
    // Выбор по времени: построить на месте (коробка ≈ 2 с, стенка ≈ 0.5 с) быстрее, чем дойти до готовой крыши, — строить; свои
    // рядом в срок подлёта — к ним, как прежде.
    const build = box ? BOX_SECONDS : wall ? WALL_SECONDS : Infinity
    if (threat.threat === 'aerial' && build < (roof ? walkSeconds(m, roof) : Infinity) && !(home && walkSeconds(m, middle(home)) <= arrivalSeconds(m, threat))) {
      put(m, 'goto', { hold: 'ambush', camp: cellKey(m.position), ...(box ? { ramBox: true } : { ramWall: true }), target: threat.id, range: .8, reason: `${cause}, ${box ? 'коробка' : 'стенка'} от тарана` }, { ...m.position })
      continue
    }
    const perch = roof || threat.threat === 'aerial' || home && (why === 'один' || held?.why === 'пустой размен') ? null : perchFor(m)
    put(m, 'flee', { target: threat.id, enemyPosition: threat.position, panic: true, risk, reason: cause + ', ' + risk.reason + (roof ? ', под крышу от тарана' : ''), ...(roof ? { hide: true } : perch ? { perch: true } : home ? { regroup: true } : {}) },
      roof ?? perch ?? (home ? middle(home) : away))
  }
  Object.assign(S, { prey, hunting })
}

// Есть ли чем лечиться: голод 18+ (естественная регенерация, FoodData 1.21.11), еда в запасе или зелье лечения/регенерации.
// Голод неизвестен — как раньше, считаем, что есть.
const EDIBLE = /^(bread|cooked_\w+|golden_apple|enchanted_golden_apple|apple|baked_potato|golden_carrot|carrot|melon_slice|\w+_stew|pumpkin_pie|cookie|sweet_berries)$/
export const canMend = (m: SwarmMember) => m.food === undefined || m.food >= 18 ||
  Object.entries(m.inventory || {}).some(([n, c]) => EDIBLE.test(n) && c > 0) || Object.entries(m.potions || {}).some(([n, c]) => /(healing|regeneration)$/.test(n) && c > 0)

export function pvpRecover(S: PvpPlan): void {
  const { board, team, plan, enemies, aggressive, assault, doctrine, center, forward, hunting, put } = S
  const hurt = team.filter(m => {
    if (plan.has(m.id)) return false
    // Лечиться нечем — отход не даёт ни хп (cl86: в хвосте у всех 0 еды в запасе и голод 7–17, 88 из 88 «recover» без
    // регенерации; стороны минутами отходили друг от друга, раунд до 600 с) — бой дальше. Цена, не запрет: появилась еда или
    // зелье, голод 18+ — снова отход.
    if (!canMend(m)) return false
    // Натиск: у врага под носом не есть и не отходить — добьёт в спину; лечиться — оторвавшись (дальше 8 бл.).
    // Но если его один ближний удар меня убивает — сперва лечиться и при натиске (игра пользователя 25.10: h с 7 хп по голосу
    // штурма полетел к нему на элитрах и умер за 1 с; NeuroFarm30 так же с 2 хп).
    if ((aggressive || S.endgame) && (enemies.some(e => distance(e.position, m.position) <= 8) || (assault || hunting(m)) && !assessSwarmFight(m, enemies, team).burst)) return false
    // Врагов не видно — отход только от настоящей раны (< 70 %): царапина от падения не срывает лут (ревью 13.10).
    if (!enemies.length) return ratio(m) < .7
    const nearby = enemies.filter(e => distance(m.position, e.position) < 12).length
    // Ушедший лечиться — до 70 % при любом приёме (гистерезис по миру; ниже — порог входа).
    if (board.tasks().find(t => t.id === `pvp:${m.id}`)?.kind === 'recover' && ratio(m) < .7) return true
    // Кольцо и «стадо» для того и строятся, чтобы раненый ушёл в середину, — там прежний счёт (с 62–70 %).
    if (doctrine === 'ring' || doctrine === 'weak-center') return (1 - ratio(m)) * (8 + nearby * 2) - ratio(m) * 2 > ratio(m) * 4
    // В остальном бою — на хилку с половины хп (больше врагов рядом — чуть раньше, до 60 %), и сразу назад: с 62–70 % бой
    // распадался на отходы (пользователь 14.10: «отступать тактически на хилку быстро»). Ушедший лечиться — до 70 %
    // (гистерезис по миру): иначе сердечко регенерации возвращало его в бой у порога и следующий удар уводил обратно
    // (стенд 15×15, 21.10: «бой ↔ лечиться» 38 раз за 2 мин).
    return ratio(m) < .45 + .05 * Math.min(3, nearby)
  }).sort((a, b) => ratio(a) - ratio(b))
  for (const [i, m] of hurt.entries()) {
    const side = (i - (hurt.length - 1) / 2) * 1.5
    // В кольце раненый — в самой середине, за щитами; иначе — за спинами своих.
    const back = doctrine === 'ring' ? 0 : 2
    put(m, 'recover', { ally: m.id }, { x: center.x - forward.x * back - forward.z * side, y: m.position.y, z: center.z - forward.z * back + forward.x * side })
  }
  const healing = new Set<string>()
  for (const healer of team.filter(m => m.role === 'healer' && m.canHeal && !plan.has(m.id))) {
    const ally = team.filter(m => m.id !== healer.id && ratio(m) < 1 && !healing.has(m.id)).sort((a, b) => (1 - ratio(b)) * 20 - distance(healer.position, b.position) - ((1 - ratio(a)) * 20 - distance(healer.position, a.position)))[0]
    if (ally && (1 - ratio(ally)) * 20 > distance(healer.position, ally.position) * 0.3) { healing.add(ally.id); put(healer, 'heal', { ally: ally.id }, ally.position) }
  }
  S.hurt = hurt
}
