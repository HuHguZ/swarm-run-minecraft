// Рой (swarm.ts): план боя (planPvp) — остальным бой, сбор, резерв, лут или укрытие; план на доску (то же дело —
// та же аренда).
import * as damage from '../pvp/damage-model'
import type { SwarmTask, SwarmMember, SharedEnemy, SwarmPosition } from './types'
import type { PvpPlan } from './plan-frame'
import { fledAt, markFled } from './board'
import { distance, cellKey, ratio, count } from './common'
import { visibleForce, memberFight } from './fight'
import { lineRank } from './doctrine'
import { racesForLoot, behindRace, killMeans, MELEE_CAP } from './race'
import { SHOVE, SHOVE_REACH, shoveHits } from './shove'
import { dislodgeSeconds, attackSeconds } from './dislodge'

export function assignFighters(S: PvpPlan): void {
  // Добивание убегающего (командная игра): нас вдвое больше видимых врагов, а цель уходит от нашей середины — без резерва
  // и с окружением по секторам, как в натиске (стенд 15×15, 21.10: 7 красных против последнего синего 2 мин не могли его
  // достать — трое стояли «в резерве», остальные гнались одной кучей за равным по скорости). Стоящего — как прежде.
  const outnumber = !S.aggressive && S.enemies.length > 0 && S.team.length >= 2 * S.enemies.length
  // Живых врагов втрое меньше (лента смертей — plan-frame endgame) — добивание и стоящего: резерв беречь не для кого
  // (стенд 15×15, 21.10: 13 синих против 2 красных минуту не добили — восемь строителей сидели в «резерве-разведке»).
  const crushing = outnumber && S.endgame
  let searchers = 0
  // Сколько бьют в упор каждую цель (без булавы и зелий вреда) — для MELEE_CAP против сильного.
  const meleeOn = new Map<string, number>()
  const rearming = new Set<string>()
  // Связка против сильного (пользователь 22.10: «паутина под него, топор выбивает щит, сразу удар булавой с высоты»): есть
  // свой с булавой и зарядом — топоры в упор без предела MELEE_CAP: щит, поднятый против булавы, выбивают на 5 с.
  const comboMace = !!(S.state.strongFew || S.state.dislodge) && S.team.some(a => killMeans(a).smash)
  const runner = (e: SharedEnemy) => { const v = e.velocity || { x: 0, y: 0, z: 0 }, sp = Math.hypot(v.x, v.z), dx = e.position.x - S.center.x, dz = e.position.z - S.center.z, d = Math.hypot(dx, dz) || 1
    return sp > .15 && (v.x * dx + v.z * dz) / (sp * d) > .5 }
  const { board, team, enemies, plan, options, aggressive, doctrine, committed, center, forward, lineDuty, spots, put, assault, regroup, losing, prey, hunting, untouchable, loads, meanStrength, sectorOf, ringAt, shoveOf, gatherers, lastEnemy, diggers, ladderers, campers, hideoutFor, perchFor, rallyFor, outclassed, weak, improvementOf, targetCost, archer, threatReach } = S
  const worthShove = (m: SwarmMember, foe: SharedEnemy, attack: number) => {
    const edge = S.edgeAt(foe), gap = distance(m.position, foe.position)
    if (!edge || shoveOf(foe) < SHOVE || gap > 16) return false
    const walk = Math.max(0, gap - 3) / 5.6, wind = count(m.inventory, 'wind_charge') > (count(m.inventory, 'mace') ? 2 : 0)
    const chain = shoveHits(foe, edge, { sprint: true, kb: m.ench?.knockback || 0 })
    const work = (wind || (edge.at ?? 0) <= SHOVE_REACH ? damage.IFRAME_TICKS / 20 : chain * damage.IFRAME_TICKS / 20) + (wind ? 0 : walk)
    return dislodgeSeconds(S, foe, 'shove', work, attack + walk) < attack + walk
  }
  for (const m of [...team].sort((a, b) => b.strength - a.strength || a.id.localeCompare(b.id))) {
    const near = [...enemies].sort((a, b) => distance(a.position, m.position) - distance(b.position, m.position))[0]
    const personal = near && memberFight(m, near), kit = killMeans(m)
    const shoveUseful = near && worthShove(m, near, attackSeconds(m, near, personal!.attackSeconds))
    // Не пробивающий и проигрывающий размен получает другое дело; кирка нужна лишь у назначенной живой ямы.
    const rearm = aggressive && personal?.rearm && !kit.smash && !kit.harm && !(kit.axe && comboMace) && !shoveUseful && !diggers.has(m.id)
    if (rearm) rearming.add(m.id)
    if (plan.has(m.id)) continue
    if (diggers.has(m.id)) { const { site: s, foe } = diggers.get(m.id)!; put(m, 'goto', { dig: cellKey(s), undermine: !!(s as any).undermine, blocks: (s as any).blocks, stands: (s as any).stands, drop: (s as any).drop, target: foe.id, enemyPosition: foe.position, reason: (s as any).drop === Infinity ? 'подкоп: под ним пустота' : 'копаю яму-ловушку' }, s); continue }
    if (ladderers.has(m.id)) { const s = ladderers.get(m.id)!; put(m, 'goto', { ladder: s.key, reason: 'ставлю лестницу для своих' }, { x: s.x, y: s.y, z: s.z }); continue }
    if (campers.has(m.id)) { put(m, 'goto', { hold: 'ambush', camp: cellKey(campers.get(m.id)!), reason: 'засада в углу' }, campers.get(m.id)!); continue }
    // Цель держится, пока жива и видна, а новая не дешевле с запасом (4 — как 4 бл. пути): иначе цель менялась почти
    // каждую секунду, и бот носился между врагами (стенд 15×15, 21.10: d → t → f → ad за 4 с).
    const best = [...enemies].filter(e => !untouchable.has(e.id)).sort((a, b) => targetCost(m, a) - targetCost(m, b) || a.id.localeCompare(b.id))[0]
    const prevId = board.tasks().find(t => t.id === `pvp:${m.id}`)?.data?.target
    const prev = prevId && best && prevId !== best.id ? enemies.find(e => e.id === prevId && !untouchable.has(e.id)) : undefined
    const foe = hunting(m) && !untouchable.has(prey!.id) ? prey! : prev && targetCost(m, prev) <= targetCost(m, best!) + 4 ? prev : best
    if (!foe && untouchable.size) { put(m, 'goto', { reserve: true, sentry: true }, m.position); continue }
    const nearGap = enemies.length ? Math.min(...enemies.map(e => distance(e.position, m.position))) : Infinity
    // Уже на насесте (элитры) — сидеть на нём, а не перелетать.
    const onPerch = (options.perches || []).some(q => distance(q, m.position) < 2)
    if (losing && !hunting(m) && nearGap > 6) {
      const den = onPerch ? m.position : perchFor(m) ?? hideoutFor(m)
      if (den) { put(m, 'flee', { target: foe?.id, enemyPosition: foe?.position, ...(onPerch || options.perches?.includes(den) ? { perch: true } : { hide: true }), panic: true, reason: 'проигрываем — прячусь' }, den); continue }
    }
    if (!foe) {
      // Прятался, а враг пропал из виду (за стеной, вне прорисовки) — сидеть в укрытии, пока последнее место врага в 22 бл.
      // (арена 40: прятался → не видно → лут → снова виден → прятался, каждые 3–7 с).
      const was = board.tasks().find(t => t.id === `pvp:${m.id}` && t.kind === 'flee' && t.position)
      if (was && lastEnemy && board.now() - lastEnemy.seenAt < 6000 && distance(lastEnemy.position, m.position) < 22) { put(m, 'flee', was.data || {}, was.position); continue }
      const improvement = improvementOf(m)
      // Врага не видели (или забыли) — недобор снаряжения добирать лутом (сундуки наверху тоже); видели — охота (Codex 15.10).
      // Слабее типичного врага раунда (память снаряжения, race.ts) — лут; раньше — метка «переигран» на 30 с (21.10: по миру).
      if (weak(m) || improvement > 0 && (!lastEnemy || behindRace(S, m))) { put(m, 'loot', { improvement, reason: 'лут: врага не видно' }); continue }
      // Врага не видели вовсе — прочёсывать, без прокопа: «охота» на своё место копала под себя (ночь 15.10: 1686 прокопов
      // в пустом раунде, ~100 ботов провалились под арену).
      // Поиск веером (21.10: двенадцать красных 4 мин искали двоих синих у одного места): каждому своя точка на кольце вокруг
      // последнего места врага радиусом «сколько он мог пробежать» (5.6 бл/с, до 32 бл.) — только знание, где видели и как
      // быстро бегает; через одного — середина кольца. Первый идёт в само место.
      const at = lastEnemy?.position ?? m.position, k = searchers++
      const reach = lastEnemy ? Math.min(32, 5.6 * Math.max(0, board.now() - lastEnemy.seenAt) / 1000) : 0
      const spot = !lastEnemy || k === 0 || reach < 4 ? at : { x: at.x + Math.cos(k * 2.4) * reach * (k % 2 ? 1 : .5), y: at.y, z: at.z + Math.sin(k * 2.4) * reach * (k % 2 ? 1 : .5) }
      put(m, 'goto', { search: true, ...(lastEnemy ? { hunt: true } : {}), ...(S.endgame ? { finishing: true } : {}), enemyPosition: at, searchAt: spot, improvement }, spot); continue
    }
    // Натиск, слабый (weak): ближний враг дальше 16 бл. — лут; 5–16 — к своим по открытому, за спины готовых (пользователь
    // 14.10: «не должны в замкнутые пространства бежать, когда игрок рядом за ними идёт» — комната-тупик с пустыми
    // сундуками); своих рядом нет — в укрытие колизея, там на шифте («если своих нет — прятаться в колизее, в блоках или
    // на высоте, и шифт зажимать, чтобы мы не видели»); ближе 5 бл. не убежать (он быстрее) — драться со всеми.
    // Перегруппировка после проваленного штурма — так же для всех, кто не в схватке. Голые — и в штурме (пользователь
    // 14.10: «бегут к игроку без вещей»): штурм — для снаряжённых, голому сперва лут.
    // Сброс (shove.ts): он у смертельного обрыва — толкают все, кто в 16 бл. и достаёт (пользователь 21.10: «вместе они
    // толкают жёстко»): в режиме сброса дальнюю цепь считаем по физике, заряд ветра проверяет траекторию сам.
    // Без резерва, смены линий и лута гонки — отброс от удара не зависит от брони бьющего.
    const wind = count(m.inventory, 'wind_charge')
    const edge = S.edgeAt(foe)
    // Дальняя цепь оплачивается окнами удара: сравниваем с гонкой урона, а не запрещаем дальше трёх блоков.
    const deadly = foe === near ? !!shoveUseful : worthShove(m, foe, attackSeconds(m, foe))
    // Против сильного (race.ts strongFew): в упор — двое лучших (MELEE_CAP: больше окно неуязвимости не пропустит) и те, кто
    // бьёт иначе — булава с взлёта, зелья вреда; у края — все, кто достаёт. Остальные — как переигранные: лут, укрытие, к своим
    // (вплотную — бой). Стенд 21.10: оба убийства чемпиона — булава с падения и сброс; ближним боем — ни одного.
    const means = aggressive && (S.state.strongFew || S.state.dislodge) ? killMeans(m) : null
    const melee = !!means && !means.smash && !means.harm && !(means.axe && comboMace)
    const surplus = melee && !deadly && !(foe === prey && hunting(m)) && (meleeOn.get(foe.id) || 0) >= MELEE_CAP
    if (aggressive && !deadly && !(foe === prey && hunting(m)) && (rearm || weak(m) || surplus || outclassed(m, [...enemies].sort((a, b) => distance(a.position, m.position) - distance(b.position, m.position))[0]) || regroup && !assault)) {
      const near = [...enemies].sort((a, b) => distance(a.position, m.position) - distance(b.position, m.position))[0], gap = distance(m.position, near.position)
      if (gatherers.has(m.id)) { put(m, 'goto', { gather: options.gather!.item, count: 32, reason: 'добываю блоки для подъёма' }, options.gather!.spot); continue }
      // На насесте — сидеть, пока враг в 28 бл.: оттуда лук и еда; ушёл дальше — вниз за лутом.
      // Запас по расстоянию: убегавший вернётся к луту только за 22 бл. (на 16 туда-сюда каждые 3 с — арены 37–38).
      // Память — на доске, а не в задаче: дошёл до укрытия — задача снята, и порог снова 16 (поле, s6: 24 смены за 28 с).
      // Снимается только лутом за 22 бл. — не сроком (было 15 с: убежавший за 16 с снова лутался на 17 бл. и бежал опять).
      const fled = !!fledAt.get(board)?.has(m.id)
      // Две границы: бегство — с 16 бл. и ближе, лут — только дальше 22; между ними — что было (отметка снимается с лутом,
      // иначе граница одна — 22 — и на 22↔23 бл. смена каждые 2 с, поле s8).
      // От лучника — дальше (threatReach 32): в 16–22 бл. «Сила V» добивала голого за две стрелы (стенд 21.10).
      const far = threatReach(near)
      if (gap > (fled ? far + 6 : far) && !(onPerch && gap < 28)) { fledAt.get(board)?.delete(m.id); put(m, 'loot', { improvement: improvementOf(m), weak: true, reason: `лут: враг в ${Math.round(gap)} бл.${fled ? ' (убегал)' : ''}` }); continue }
      // Граница «не убежать» с запасом от прежней задачи (стенд rush 15.10: на 5–6 бл. «прячусь ↔ бой» каждые 1–2 с, 45 смен
      // у одного бота): убегавший дерётся только вплотную (3.5), дерущийся уходит дальше 6.
      const prior = board.tasks().find(t => t.id === `pvp:${m.id}`)?.kind
      const edge = prior === 'flee' ? 3.5 : prior === 'fight' ? 6 : 5
      const perch = gap > edge && (onPerch ? m.position : perchFor(m))
      if (perch) { markFled(board, m.id); put(m, 'flee', { target: near.id, enemyPosition: near.position, perch: true, panic: true, reason: `на насест, нечем драться (враг в ${Math.round(gap)} бл.${fled ? ', убегал' : ''})` }, perch); continue }
      // От лучника — сперва за укрытие (своя кучка в чистом поле стрелу не остановит), потом к своим.
      // Только издали (> 8 бл.): вплотную бег «за укрытие» — спиной под его меч (игра пользователя 21.10).
      const cover = gap > Math.max(edge, 8) && archer(near) && hideoutFor(m)
      if (cover) { markFled(board, m.id); put(m, 'flee', { target: near.id, enemyPosition: near.position, hide: true, panic: true, reason: `за укрытие от лучника (враг в ${Math.round(gap)} бл.)` }, cover); continue }
      const rearmHide = rearm && gap > edge && hideoutFor(m)
      if (rearmHide) { markFled(board, m.id); put(m, 'flee', { target: near.id, enemyPosition: near.position, hide: true, panic: true, reason: 'не пробиваю: укрытие и перевооружение' }, rearmHide); continue }
      const group = gap > edge && rallyFor(m, near)
      if (group) { markFled(board, m.id); put(m, 'flee', { target: near.id, enemyPosition: near.position, regroup: true, panic: true, reason: `к своим, нечем драться (враг в ${Math.round(gap)} бл.${fled ? ', убегал' : ''})` }, group); continue }
      const hide = gap > edge && hideoutFor(m)
      if (hide) { markFled(board, m.id); put(m, 'flee', { target: near.id, enemyPosition: near.position, hide: true, panic: true, reason: `прячусь, своих рядом нет (враг в ${Math.round(gap)} бл.${fled ? ', убегал' : ''})` }, hide); continue }
      // Бежать некуда (укрытия и свои — за врагом), а он ещё не вплотную — лут с отходом от него (исполнитель отходит на 8 бл.),
      // а не общий план боя: слабый шёл бы прямо на него.
      if (gap > edge) { markFled(board, m.id); put(m, 'loot', { improvement: improvementOf(m), weak: true, reason: `лут: отхожу, укрыться негде (враг в ${Math.round(gap)} бл.)` }); continue }
    }
    const nearby = distance(m.position, foe.position) <= 4.5
    // Гонка вооружений (race.ts): слабее типичного врага и враг не рядом — лут, а не бой (голым на любого видимого
    // врага шли 9 из 10: 30 задач лута за раунд 15×15 против 1300 походов к врагу, 21.10).
    if (!aggressive && !deadly && !S.endgame && !(foe === prey && hunting(m)) && !assault) {
      const race = racesForLoot(S, m)
      if (race.loot) { put(m, 'loot', { improvement: improvementOf(m), race: true, reason: `лут: слабее их (${Math.round(race.mine)} против ${Math.round(race.theirs!)})` }); continue }
    }
    // Смена линий: ранг не на смене уходит в тыл и из контакта — иначе старый фронт так и стоит в бою (лаборатория 13.10).
    if (doctrine === 'line' && !deadly && lineRank(team.indexOf(m), team.length) !== lineDuty) {
      put(m, 'goto', { reserve: true, line: lineRank(team.indexOf(m), team.length), rotation: lineDuty }); continue
    }
    const demand = visibleForce(foe) * 1.2 / meanStrength
    const engageValue = (1 - (loads.get(foe.id) || 0) / demand) * 15 + 7 - distance(m.position, foe.position) * 0.25
    const reserveValue = (m.role === 'miner-builder' ? 8 : m.role === 'healer' ? 6 : 1) + (1 - ratio(m)) * 8
    // Натиск: резерва нет — на человека идут все (резерв «по модели нужно 2–3» оставлял одиночек без подмоги).
    const finishing = outnumber && (runner(foe) || crushing)
    if (!nearby && !aggressive && !finishing && !deadly && engageValue < reserveValue) {
      const i = team.indexOf(m); const across = (i - (team.length - 1) / 2) * 2
      const at = doctrine === 'ring' || doctrine === 'weak-center' ? spots.get(m.id) : { x: center.x - forward.x * 5 - forward.z * across, y: m.position.y, z: center.z - forward.z * 5 + forward.x * across }
      put(m, m.role === 'miner-builder' ? 'scout' : 'goto', { reserve: true, sentry: true }, at)
      continue
    }
    const search = board.now() - foe.seenAt > 500
    // Натиск: не в одиночку (пользователь 14.10: «в одиночку прибегают бить двух жёстких игроков»), но и без хоровода
    // («бегают вокруг игроков и не атакуют сразу — мирные как будто»; кольцо ожидания в 14 бл. так и выглядело). Сразу в бой:
    // кто-то из своих уже в схватке с целью, у цели (в 16 бл.) набралось по двое на каждого её врага (не меньше трёх, не
    // больше всех готовых), цель ослабла (ва-банк) или сама идёт на него. Иначе — к ближним готовым своим (до трёх, не у
    // цели): собраться, а не кружить; своих нет — в бой.
    const gapFoe = distance(m.position, foe.position)
    if (aggressive && !search && gapFoe > 8 && foe !== prey) {
      const ready = team.filter(a => a.id !== m.id && !weak(a) && !['flee', 'recover', 'heal'].includes(plan.get(a.id)?.kind ?? ''))
      const engaged = ready.some(a => distance(a.position, foe.position) <= 8)
      const staged = ready.filter(a => distance(a.position, foe.position) <= 16).length + (gapFoe <= 16 ? 1 : 0)
      const need = Math.min(ready.length + 1, Math.max(3, 2 * enemies.filter(e => distance(e.position, foe.position) <= 12).length))
      const v = foe.velocity || { x: 0, y: 0, z: 0 }
      const coming = ((m.position.x - foe.position.x) * v.x + (m.position.z - foe.position.z) * v.z) / gapFoe > 0.1
      // Сбор — на своём секторе кольца в 10 бл. от цели (не в кучке у своих: кучку у подножия выбивали зельем и молнией).
      if (!engaged && staged < need && !coming && Math.abs(foe.position.y - m.position.y) < 4) {
        const k = sectorOf(m, foe)
        put(m, 'goto', { target: foe.id, enemyPosition: foe.position, sentry: true, stage: `s${k}`, slot: k }, ringAt(foe, k, 10))
        continue
      }
    }
    // Натиск: бой — прямо на цель, а не на место в строю (строй ползёт за толпой, и бойцы кружили вокруг человека, 14.10).
    // Натиск: место — свой сектор в 2.5 бл. от цели (окружение): драйвер ведёт туда, пока до места дальше 6 бл., потом бой.
    // Сброс (shove.ts): он у смертельного обрыва — место в секторе напротив обрыва при любом приёме, заряд ветра у всех,
    // у кого он есть (иначе — только «волна» с запасом зарядов и без булавы).
    const shove = !search && deadly
    const slot = (aggressive || finishing || shove) && !search ? sectorOf(m, foe) : undefined
    // Булавник толкает ветром только сверх двух зарядов: они — на взлёт (стенд 22.10: «нет заряда» — 59 отказов за 3 раунда).
    put(m, search || !(committed || nearby) ? 'goto' : 'fight', { target: foe.id, enemyPosition: foe.position, sentry: !committed, search, push: wind > (count(m.inventory, 'mace') ? 2 : 0) && (shove || doctrine === 'wave' && wind > 2 && !count(m.inventory, 'mace')), ...(shove ? { shove: true, shoveAt: { x: foe.position.x + edge!.x * (edge!.at ?? SHOVE_REACH), y: foe.position.y, z: foe.position.z + edge!.z * (edge!.at ?? SHOVE_REACH) } } : {}), ...(finishing ? { finishing: true } : {}), ...(assault ? { assault: true } : {}), ...(means?.smash ? { smash: true } : {}), ...(means?.axe && comboMace ? { axe: true } : {}), ...(slot !== undefined ? { slot } : {}) }, search ? foe.position : slot !== undefined ? ringAt(foe, slot, 2.5) : aggressive ? foe.position : spots.get(m.id))
    loads.set(foe.id, (loads.get(foe.id) || 0) + m.strength / meanStrength)
    if (melee) meleeOn.set(foe.id, (meleeOn.get(foe.id) || 0) + 1)
  }
  const guardStands: SwarmPosition[] = []
  for (const [id, task] of plan) if (S.digAvoid?.length && task.data?.target && (task.kind === 'fight' || task.kind === 'goto' && !task.data.dig && !task.data.ladder && !task.data.hold && !task.data.gather)) {
    const m = team.find(m => m.id === id)!, foe = enemies.find(e => e.id === task.data!.target)
    if (!foe) continue
    const slot = task.data!.slot ?? sectorOf(m, foe)
    const vacate = S.digVacate.get(id)
    const proposed = vacate && !guardStands.some(q => distance(q, vacate) < .6) ? vacate : ringAt(foe, slot, 2.5, guardStands)
    const old = board.tasks().find(t => t.assignedTo === id && t.kind === task.kind && t.data?.target === foe.id)?.data?.swarmStand
    // Безопасная прежняя стойка не рвёт бой при перераздаче соседних ям.
    const keep = old && distance(old, foe.position) <= Math.max(SHOVE_REACH, distance(proposed, foe.position)) &&
      !S.digAvoid.some(s => s.y === Math.floor(old.y - .01) && old.x + .3 > s.x && old.x - .3 < s.x + 1 && old.z + .3 > s.z && old.z - .3 < s.z + 1) &&
      ![...diggers.values()].some(d => (d.site as any).stands?.some(q => distance(q, old) < .6)) && !guardStands.some(q => distance(q, old) < .6)
    task.position = keep ? old : proposed
    guardStands.push(task.position)
    task.data = { ...task.data, slot, digAvoid: S.digAvoid, swarmStand: task.position }
  }
  for (const id of rearming) { const task = plan.get(id); if (task) task.data = { ...task.data, rearm: true } }
}

export function commitPlan(S: PvpPlan): Map<string, SwarmTask> {
  const { board, plan } = S
  const previous = board.tasks().filter(t => t.id.startsWith('pvp:'))
  for (const old of previous) if (![...plan.values()].some(t => t.id === old.id)) board.cancel(old.id)
  for (const [id, task] of plan) {
    const old = previous.find(t => t.id === task.id)
    const unchanged = old?.claim && old.kind === task.kind && ['digAvoid', 'swarmStand'].every(key => JSON.stringify(old.data?.[key]) === JSON.stringify(task.data?.[key])) && (!task.data?.dig || JSON.stringify(old.data?.stands) === JSON.stringify(task.data.stands)) && ['target', 'ally', 'cover', 'doctrine', 'role', 'committed', 'search', 'reserve', 'panic', 'hold', 'ambush', 'fountain', 'stage', 'regroup', 'hide', 'kite', 'perch', 'rearm', 'gather', 'slot', 'dig', 'undermine', 'camp', 'ladder', 'shove', 'push', 'assault', 'finishing', 'smash', 'axe'].every(key => old.data?.[key] === task.data?.[key])
    if (unchanged) { plan.set(id, old); continue }
    if (old?.status === 'done') board.cancel(old.id)
    plan.set(id, board.upsert(task))
  }
  return plan
}
