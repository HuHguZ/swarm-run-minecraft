// Рой (swarm.ts): план боя (planPvp) — остальным бой, сбор, резерв, лут или укрытие; план на доску (то же дело —
// та же аренда).
import * as damage from '../pvp/damage-model'
import type { SwarmTask, SwarmMember, SharedEnemy, SwarmPosition } from './types'
import type { PvpPlan } from './plan-frame'
import { fledAt, markFled } from './board'
import { distance, cellKey, ratio, count } from './common'
import { visibleForce, memberFight, attackBeforeBuild, assessSwarmFight } from './fight'
import { lineRank } from './doctrine'
import { racesForLoot, behindRace, killMeans, MELEE_CAP } from './race'
import { SHOVE, SHOVE_REACH, shoveHits } from './shove'
import { dislodgeSeconds, attackSeconds } from './dislodge'
import { airUnreachable } from './plan-judges'
import { pricedLoot } from './plan-doctrines'
import { closingSpeed, fleePursuit, visiblyWeakened } from './plan-flee'

export function assignFighters(S: PvpPlan): void {
  // Добивание убегающего (командная игра): нас вдвое больше видимых врагов, а цель уходит от нашей середины — без резерва
  // и с окружением по секторам, как в натиске (стенд 15×15, 21.10: 7 красных против последнего синего 2 мин не могли его
  // достать — трое стояли «в резерве», остальные гнались одной кучей за равным по скорости). Стоящего — как прежде.
  const outnumber = !S.aggressive && S.enemies.length > 0 && S.team.length >= 2 * S.enemies.length
  // Живых врагов втрое меньше (лента смертей — plan-frame endgame) — добивание и стоящего: резерв беречь не для кого
  // (стенд 15×15, 21.10: 13 синих против 2 красных минуту не добили — восемь строителей сидели в «резерве-разведке»).
  const crushing = outnumber && S.endgame
  // Сколько бьют в упор каждую цель (без булавы и зелий вреда) — для MELEE_CAP против сильного.
  const meleeOn = new Map<string, number>()
  const rearming = new Set<string>()
  // Связка против сильного (пользователь 22.10: «паутина под него, топор выбивает щит, сразу удар булавой с высоты»): есть
  // свой с булавой и зарядом — топоры в упор без предела MELEE_CAP: щит, поднятый против булавы, выбивают на 5 с.
  const comboMace = !!(S.state.strongFew || S.state.dislodge) && S.team.some(a => killMeans(a).smash)
  const runner = (e: SharedEnemy) => { const v = e.velocity || { x: 0, y: 0, z: 0 }, sp = Math.hypot(v.x, v.z), dx = e.position.x - S.center.x, dz = e.position.z - S.center.z, d = Math.hypot(dx, dz) || 1
    return sp > .15 && (v.x * dx + v.z * dz) / (sp * d) > .5 }
  const { board, team, enemies, plan, options, aggressive, doctrine, center, forward, lineDuty, spots, put, assault, regroup, losing, prey, hunting, untouchable, loads, meanStrength, sectorOf, ringAt, shoveOf, gatherers, diggers, ladderers, campers, hideoutFor, perchFor, rallyFor, outclassed, weak, improvementOf, targetCost, archer, threatReach } = S
  const clues = enemies.length ? [] : board.lastKnownEnemies()
  const duties = board.tasks()
  const previousById = new Map(duties.map(task => [task.id, task]))
  const searches: { clue: typeof clues[number]; ageBlocks: number; radius: number; scouts: number }[] = []
  for (const clue of clues) {
    // Близкие отметки на одном ярусе задают общий сектор поиска.
    if (searches.some(s => Math.abs(s.clue.position.y - clue.position.y) < 2 && distance(s.clue.position, clue.position) < 4)) continue
    const ageBlocks = (S.now - clue.seenAt) * 5.6 / 1000
    searches.push({ clue, ageBlocks, radius: Math.min(32, ageBlocks), scouts: 0 })
  }
  // Две границы ценности (cl28b, 28.10: цель по ярусам Колизея, обрыв под ней 17 ↔ 7–9 бл. — сброс включался и выключался
  // каждую секунду, 189 смен при живом крае, бойцы метались между сбросом и резервом): начинают сброс с SHOVE, начатый на
  // эту цель держат, пока падение вообще ранит; край пропал — снят.
  const shoveFloor = (m: SwarmMember, foe: SharedEnemy) => {
    const was = previousById.get(`pvp:${m.id}`)
    return was?.data?.shove && was.data.target === foe.id ? Number.MIN_VALUE : SHOVE
  }
  const worthShove = (m: SwarmMember, foe: SharedEnemy, attack: number, fight = memberFight(m, foe)) => {
    const edge = S.edgeAt(foe), gap = distance(m.position, foe.position), value = shoveOf(foe)
    if (!edge || value < shoveFloor(m, foe) || gap > 16) return false
    const walk = Math.max(0, gap - 3) / 5.6
    const chain = shoveHits(foe, edge, { sprint: true, kb: m.ench?.knockback || 0 })
    const work = chain * damage.IFRAME_TICKS / 20 + walk
    // Частичный урон оплачивается своей долей; слабый не меняет перевооружение на более быстрый проигрыш.
    const alternative = aggressive && !S.endgame && (weak(m) || fight.rearm) ? Math.min(attack + walk, fight.survival) : attack + walk
    return dislodgeSeconds(S, foe, 'shove', work, attack + walk) < alternative * value
  }
  // Враг у смертельного края, у меня заряды, до него не дальше полёта заряда и подъёма фланга — не прятаться и не «переигран»:
  // на сброс (стенд 25.10: Tester в незерите в 1 бл. от края гребня, у всех по 128 зарядов — «бой 0, сброс 0, лут/укрытие 8»,
  // 18 раз «проигрываем — прячусь»; пользователь: «не выкидывают с колизея ветром»).
  const edgeWind = (m: SwarmMember, foe?: SharedEnemy) => !!foe && !!S.edgeAt(foe) && shoveOf(foe) >= shoveFloor(m, foe) && count(m.inventory, 'wind_charge') > 0
  // Цена бросить начатый бой, в блоках пути (как targetCost): перепрокладка — 4; урон, уже нанесённый цели (оценка хп по своим
  // попаданиям, board), пропадает, если её не добить: 0.8 бл. на каждое снятое хп (полцели ≈ 8 бл. ≈ 1.4 с бега); вплотную в бою —
  // ещё замах и перезапуск боя ~1.5 с ≈ 8 бл. (цикл 20, cl74–76: почти все смены цели — «новая ближе на 4+ бл.»).
  const abandonCost = (m: SwarmMember, prev: SharedEnemy) => {
    const was = previousById.get(`pvp:${m.id}`)
    if (!was || was.data?.target !== prev.id || !/^(fight|goto)$/.test(was.kind)) return 4
    const hurt = Math.max(0, 20 - (prev.hpEstimate ?? 20)) * 0.8
    return 4 + hurt + (was.kind === 'fight' && distance(m.position, prev.position) <= 4.5 ? 8 : 0)
  }
  const investigating = new Set<string>()
  const mayEngage = (m: SwarmMember, e: SharedEnemy) => S.confirmed(e.id) || S.witnesses.get(e.id)?.has(m.id)
  const chooseTarget = (m: SwarmMember, previous?: SharedEnemy) => {
    const candidates = S.endgame ? enemies : enemies.filter(e => !untouchable.has(e.id))
    const ready = candidates.filter(e => mayEngage(m, e))
    const eligible = ready.length ? ready : candidates.filter(e => !investigating.has(e.id))
    if (!eligible.length) return candidates[0]
    if (eligible.length < 2) return eligible[0]
    // Loads can change at the very next assignment. Price each candidate once for this fighter.
    let best = eligible[0], bestCost = targetCost(m, best)
    let previousCost = best === previous ? bestCost : undefined
    for (let i = 1; i < eligible.length; i++) {
      const candidate = eligible[i], cost = targetCost(m, candidate)
      if (candidate === previous) previousCost = cost
      if ((cost - bestCost || candidate.id.localeCompare(best.id)) < 0) { best = candidate; bestCost = cost }
    }
    return previous && previous !== best && previousCost !== undefined && !untouchable.has(previous.id) &&
      previousCost <= bestCost + abandonCost(m, previous) ? previous : best
  }
  for (const m of [...team].sort((a, b) => b.strength - a.strength || a.id.localeCompare(b.id))) {
    const covering = S.endgame && plan.get(m.id)?.kind === 'fight' && plan.get(m.id)?.data?.cover ? plan.get(m.id) : undefined
    if (S.endgame) {
      // Короткая хилка остаётся; резерв, стройка, лут и укрытие больше не отводят здоровых от последнего боя.
      const assigned = plan.get(m.id)
      if (assigned?.kind === 'recover' || assigned?.kind === 'heal' || assigned?.data?.antidoteCover || assigned?.data?.coverShield || assigned?.data?.coverWall) continue
      plan.delete(m.id)
    }
    const near = [...enemies].sort((a, b) => distance(a.position, m.position) - distance(b.position, m.position))[0]
    const personal = near && memberFight(m, near), kit = killMeans(m)
    const shoveUseful = near && worthShove(m, near, attackSeconds(m, near, personal!.attackSeconds), personal!)
    // Не пробивающий и проигрывающий размен получает другое дело; кирка нужна лишь у назначенной живой ямы.
    const needsWeapon = personal?.rearm && !kit.smash && !kit.harm && !(kit.axe && comboMace) && !shoveUseful && !diggers.has(m.id)
    const rearm = aggressive && !S.endgame && needsWeapon
    if (rearm) rearming.add(m.id)
    if (plan.has(m.id)) continue
    if (S.endgame && options.foesLeft === 1 && needsWeapon && !covering && near && S.now - near.seenAt <= 1000 && outclassed(m, near)) {
      const gap = distance(m.position, near.position)
      // Последний противник несётся на нас. Если свои не успеют выиграть размен, сначала оторваться и тогда перевооружиться.
      if (enemies.length === 1 && !near.nametag && !near.glowing && gap <= threatReach(near) && closingSpeed(m, near, gap) > .1 &&
          assessSwarmFight(m, enemies, team).unsafe) {
        fleePursuit(S, m, near, gap, archer(near) && gap > 8)
        continue
      }
      if (options.lootOffer && !visiblyWeakened(near, S.now) && pricedLoot(S, m, near, personal)) continue
    }
    if (diggers.has(m.id)) { const { site: s, foe } = diggers.get(m.id)!; put(m, 'goto', { dig: cellKey(s), undermine: !!(s as any).undermine, blocks: (s as any).blocks, stands: (s as any).stands, drop: (s as any).drop, target: foe.id, enemyPosition: foe.position, reason: (s as any).drop === Infinity ? 'подкоп: под ним пустота' : 'копаю яму-ловушку' }, s); continue }
    if (ladderers.has(m.id)) { const s = ladderers.get(m.id)!; put(m, 'goto', { ladder: s.key, reason: 'ставлю лестницу для своих' }, { x: s.x, y: s.y, z: s.z }); continue }
    if (!S.endgame && campers.has(m.id)) { put(m, 'goto', { hold: 'ambush', camp: cellKey(campers.get(m.id)!), reason: 'засада в углу' }, campers.get(m.id)!); continue }
    // Цель держится, пока жива и видна, а новая не дешевле с запасом (4 — как 4 бл. пути): иначе цель менялась почти
    // каждую секунду, и бот носился между врагами (стенд 15×15, 21.10: d → t → f → ad за 4 с).
    const was = previousById.get(`pvp:${m.id}`), prevId = was?.data?.target
    const prevFoe = prevId ? enemies.find(e => e.id === prevId) : undefined
    const covered = covering && enemies.find(e => e.id === covering.data?.target)
    const foe = covered || (hunting(m) && !untouchable.has(prey!.id) && mayEngage(m, prey!) ? prey! : chooseTarget(m, prevFoe))
    // Ушёл от летящей цели, которую нечем достать, — запомнить (возврат к ней только в досягаемости); вернулся к ней или её нет — забыть.
    const leftAerial = S.state.leftAerial ??= new Map()
    if (prevFoe && foe && foe.id !== prevFoe.id && prevFoe.threat === 'aerial' && airUnreachable(m)) leftAerial.set(m.id, prevFoe.id)
    else if (foe && leftAerial.get(m.id) === foe.id || !enemies.some(e => e.id === leftAerial.get(m.id))) leftAerial.delete(m.id)
    if (!foe && untouchable.size) { put(m, 'goto', { reserve: true, sentry: true }, m.position); continue }
    const nearGap = enemies.length ? Math.min(...enemies.map(e => distance(e.position, m.position))) : Infinity
    // Уже на насесте (элитры) — сидеть на нём, а не перелетать.
    const onPerch = (options.perches || []).some(q => distance(q, m.position) < 2)
    if (!S.endgame && losing && !hunting(m) && nearGap > 6 && !edgeWind(m, foe)) {
      const den = onPerch ? m.position : perchFor(m) ?? hideoutFor(m)
      if (den) { put(m, 'flee', { target: foe?.id, enemyPosition: foe?.position, ...(onPerch || options.perches?.includes(den) ? { perch: true } : { hide: true }), panic: true, reason: 'проигрываем — прячусь' }, den); continue }
    }
    if (!foe) {
      // Прятался, а враг пропал из виду (за стеной, вне прорисовки) — сидеть в укрытии, пока последнее место врага в 22 бл.
      // (арена 40: прятался → не видно → лут → снова виден → прятался, каждые 3–7 с).
      if (!S.endgame && was?.kind === 'flee' && was.position && clues.some(c => S.now - c.seenAt < 6000 && distance(c.position, m.position) < 22)) { put(m, 'flee', was.data || {}, was.position); continue }
      const improvement = improvementOf(m)
      // Врага не видели (или забыли) — недобор снаряжения добирать лутом (сундуки наверху тоже); видели — охота (Codex 15.10).
      // Слабее типичного врага раунда (память снаряжения, race.ts) — лут; раньше — метка «переигран» на 30 с (21.10: по миру).
      if (!S.endgame && (weak(m) || improvement > 0 && (!clues.length || behindRace(S, m)))) { put(m, 'loot', { improvement, reason: 'лут: врага не видно' }); continue }
      // Врага не видели вовсе — прочёсывать, без прокопа: «охота» на своё место копала под себя (ночь 15.10: 1686 прокопов
      // в пустом раунде, ~100 ботов провалились под арену).
      // Поиск веером (21.10: двенадцать красных 4 мин искали двоих синих у одного места): каждому своя точка на кольце вокруг
      // последнего места врага радиусом «сколько он мог пробежать» (5.6 бл/с, до 32 бл.) — только знание, где видели и как
      // быстро бегает; через одного — середина кольца. Первый идёт в само место.
      let chosen: typeof searches[number] | undefined, bestCost = Infinity
      for (const area of searches) {
        // Путь до места, фора пропавшего игрока и уже распределённые радиусы прочёсывания — в блоках.
        const cost = distance(m.position, area.clue.position) + area.ageBlocks + area.scouts * area.radius
        if (cost < bestCost) { bestCost = cost; chosen = area }
      }
      const lastEnemy = chosen?.clue, at = lastEnemy?.position ?? m.position
      const reach = chosen?.radius || 0, k = chosen ? chosen.scouts++ : 0
      const spot = !lastEnemy || k === 0 || reach < 4 ? at : { x: at.x + Math.cos(k * 2.4) * reach * (k % 2 ? 1 : .5), y: at.y, z: at.z + Math.sin(k * 2.4) * reach * (k % 2 ? 1 : .5) }
      put(m, 'goto', { search: true, ...(lastEnemy ? { hunt: true, searchSeenAt: lastEnemy.seenAt, searchEnemy: lastEnemy.id } : {}), ...(S.endgame ? { finishing: true } : {}), enemyPosition: at, searchAt: spot, improvement }, spot); continue
    }
    // Натиск, слабый (weak): ближний враг дальше 16 бл. — лут; 5–16 — к своим по открытому, за спины готовых (пользователь
    // 14.10: «не должны в замкнутые пространства бежать, когда игрок рядом за ними идёт» — комната-тупик с пустыми
    // сундуками); своих рядом нет — в укрытие колизея, там на шифте («если своих нет — прятаться в колизее, в блоках или
    // на высоте, и шифт зажимать, чтобы мы не видели»); близость сама по себе не доказывает, что выхода нет.
    // Перегруппировка после проваленного штурма — так же для всех, кто не в схватке. Голые — и в штурме (пользователь
    // 14.10: «бегут к игроку без вещей»): штурм — для снаряжённых, голому сперва лут.
    // Сброс (shove.ts): он у смертельного обрыва — толкают все, кто в 16 бл. и достаёт (пользователь 21.10: «вместе они
    // толкают жёстко»): в режиме сброса дальнюю цепь считаем по физике, заряд ветра проверяет траекторию сам.
    // Без резерва, смены линий и лута гонки — отброс от удара не зависит от брони бьющего.
    const wind = count(m.inventory, 'wind_charge')
    const edge = S.edgeAt(foe)
    // Дальняя цепь оплачивается окнами удара: сравниваем с гонкой урона, а не запрещаем дальше трёх блоков.
    // Рефлекс ветра действует и при отходе; отказ броска не оплачивает кулачную цепь его ценой.
    const deadly = foe === near ? !!shoveUseful : worthShove(m, foe, attackSeconds(m, foe))
    if (process.env.ND_SWARM_TRACE) {
      if (was?.data?.target === foe.id && !!was.data.shove !== deadly) {
        const e = S.edgeAt(foe), gap = distance(m.position, foe.position), att = attackSeconds(m, foe)
        const v = foe.velocity || { x: 0, y: 0, z: 0 }
        console.log(`[${new Date().toTimeString().slice(0, 8)}] 🫸? ${m.id}→${foe.id}: сброс ${deadly ? 'да' : 'нет'} (было ${was.data.shove ? 'да' : 'нет'}) край ${e ? (e.at ?? 0).toFixed(1) + '/' + (e.lava ? 'лава' : (e.drop ?? '∞')) : 'нет'} ценность ${shoveOf(foe).toFixed(2)} бл. ${gap.toFixed(1)} удар ${att.toFixed(1)}с v ${(v.x * 20).toFixed(1)},${(v.z * 20).toFixed(1)} ближний ${foe === near} ветер ${edgeWind(m, foe)}`)
      }
    }
    // Против сильного (race.ts strongFew): в упор — двое лучших (MELEE_CAP: больше окно неуязвимости не пропустит) и те, кто
    // бьёт иначе — булава с взлёта, зелья вреда; у края — все, кто достаёт. Остальные — как переигранные: лут, укрытие, к своим
    // (вплотную — бой). Стенд 21.10: оба убийства чемпиона — булава с падения и сброс; ближним боем — ни одного.
    const means = aggressive && (S.state.strongFew || S.state.dislodge) ? killMeans(m) : null
    const melee = !!means && !means.smash && !means.harm && !(means.axe && comboMace)
    const surplus = melee && !deadly && !(foe === prey && hunting(m)) && (meleeOn.get(foe.id) || 0) >= MELEE_CAP
    if (aggressive && !S.endgame && !deadly && !(foe === prey && hunting(m)) && (rearm || weak(m) || surplus || outclassed(m, [...enemies].sort((a, b) => distance(a.position, m.position) - distance(b.position, m.position))[0]) || regroup && !assault)) {
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
      const prior = was?.kind
      const edge = prior === 'flee' ? 3.5 : prior === 'fight' ? 6 : 5
      // Близость не делает оружие эффективным: если урон не перекрывает лечение, тело сначала проверяет выход.
      const leave = weak(m) || rearm || gap > edge
      const perch = leave && (onPerch ? m.position : perchFor(m))
      if (perch) { markFled(board, m.id); put(m, 'flee', { target: near.id, enemyPosition: near.position, perch: true, panic: true, reason: `на насест, нечем драться (враг в ${Math.round(gap)} бл.${fled ? ', убегал' : ''})` }, perch); continue }
      // От лучника — сперва за укрытие (своя кучка в чистом поле стрелу не остановит), потом к своим.
      // Только издали (> 8 бл.): вплотную бег «за укрытие» — спиной под его меч (игра пользователя 21.10).
      const cover = gap > Math.max(edge, 8) && archer(near) && hideoutFor(m)
      if (cover) { markFled(board, m.id); put(m, 'flee', { target: near.id, enemyPosition: near.position, hide: true, panic: true, reason: `за укрытие от лучника (враг в ${Math.round(gap)} бл.)` }, cover); continue }
      const rearmHide = rearm && leave && hideoutFor(m)
      if (rearmHide) { markFled(board, m.id); put(m, 'flee', { target: near.id, enemyPosition: near.position, hide: true, panic: true, reason: 'не пробиваю: укрытие и перевооружение' }, rearmHide); continue }
      const group = leave && rallyFor(m, near)
      if (group) { markFled(board, m.id); put(m, 'flee', { target: near.id, enemyPosition: near.position, regroup: true, panic: true, reason: `к своим, нечем драться (враг в ${Math.round(gap)} бл.${fled ? ', убегал' : ''})` }, group); continue }
      const hide = leave && hideoutFor(m)
      if (hide) { markFled(board, m.id); put(m, 'flee', { target: near.id, enemyPosition: near.position, hide: true, panic: true, reason: `прячусь, своих рядом нет (враг в ${Math.round(gap)} бл.${fled ? ', убегал' : ''})` }, hide); continue }
      // Бежать некуда (укрытия и свои — за врагом), а он ещё не вплотную — лут с отходом от него (исполнитель отходит на 8 бл.),
      // а не общий план боя: слабый шёл бы прямо на него.
      if (leave) {
        markFled(board, m.id)
        if (gap <= edge) put(m, 'flee', { target: near.id, enemyPosition: near.position, kite: true, panic: true, reason: 'нечем драться: проверяю выход' }, m.position)
        else put(m, 'loot', { improvement: improvementOf(m), weak: true, reason: `лут: отхожу, укрыться негде (враг в ${Math.round(gap)} бл.)` })
        continue
      }
    }
    if (!mayEngage(m, foe) && !covered) {
      const vacate = S.digVacate?.get(m.id)
      if (vacate) put(m, 'goto', { reserve: true, sentry: true, digAvoid: S.digAvoid, swarmStand: vacate }, vacate)
      else if (!investigating.has(foe.id)) {
        investigating.add(foe.id)
        put(m, 'goto', { verify: true, sentry: true, search: true, searchEnemy: foe.id, searchSeenAt: foe.seenAt, enemyPosition: foe.position, searchAt: foe.position }, foe.position)
      } else put(m, 'goto', { reserve: true, sentry: true }, m.position)
      continue
    }
    const nearby = distance(m.position, foe.position) <= 4.5
    const committed = S.confirmed(foe.id) || !!covered || aggressive || S.endgame || nearby
    // Окно на сундуки и при натиске (пользователь 25.10: «в железке ходят, хотя в сундуках броня лучше, — могли бы выделить время»):
    // враг дальше своей досягаемости с запасом — успею к сундуку раньше, чем он ко мне; ближе — бой, как прежде.
    const closest = aggressive ? [...enemies].sort((a, b) => distance(a.position, m.position) - distance(b.position, m.position))[0] : undefined
    if (!S.endgame && closest && !deadly && !(foe === prey && hunting(m)) && improvementOf(m) >= 2 && distance(m.position, closest.position) > threatReach(closest) + 6) {
      put(m, 'loot', { improvement: improvementOf(m), reason: `лут: враг в ${Math.round(distance(m.position, closest.position))} бл., успею приодеться` }); continue
    }
    // Гонка вооружений (race.ts): слабее типичного врага и враг не рядом — лут, а не бой (голым на любого видимого
    // врага шли 9 из 10: 30 задач лута за раунд 15×15 против 1300 походов к врагу, 21.10).
    if (!aggressive && !deadly && !S.endgame && !(foe === prey && hunting(m)) && !assault) {
      const race = racesForLoot(S, m)
      if (race.loot) { put(m, 'loot', { improvement: improvementOf(m), race: true, reason: `лут: слабее их (${Math.round(race.mine)} против ${Math.round(race.theirs!)})` }); continue }
    }
    // Смена линий: ранг не на смене уходит в тыл и из контакта — иначе старый фронт так и стоит в бою (лаборатория 13.10).
    let line: { line: number; rotation: number } | undefined
    if (!S.endgame && doctrine === 'line' && !deadly) {
      const order = S.state.lineOrder
      const rank = order ? lineRank(order.indexOf(m.id), order.length) : lineRank(team.indexOf(m), team.length)
      line = { line: rank, rotation: lineDuty }
      if (rank !== lineDuty) { put(m, 'goto', { reserve: true, ...line }); continue }
    }
    const demand = visibleForce(foe) * 1.2 / meanStrength
    const engageValue = (1 - (loads.get(foe.id) || 0) / demand) * 15 + 7 - distance(m.position, foe.position) * 0.25
    let reserveValue = (m.role === 'miner-builder' ? 8 : m.role === 'healer' ? 6 : 1) + (1 - ratio(m)) * 8
    // Натиск: резерва нет — на человека идут все (резерв «по модели нужно 2–3» оставлял одиночек без подмоги).
    const finishing = S.endgame || outnumber && (runner(foe) || crushing)
    const i = team.indexOf(m), across = (i - (team.length - 1) / 2) * 2
    const at = doctrine === 'ring' || doctrine === 'weak-center' ? spots.get(m.id) : { x: center.x - forward.x * 5 - forward.z * across, y: m.position.y, z: center.z - forward.z * 5 + forward.x * across }
    const upper = (options.lootZones || []).filter(h => h.tier > 0 && h.y <= m.position.y)
      .sort((a, b) => distance(m.position, a) - distance(m.position, b))[0]
    const holdUpper = upper && distance(m.position, upper) < Math.min(distance(m.position, at), distance(at, upper))
    if (!nearby && !aggressive && !finishing && !deadly && holdUpper && options.travelSeconds) {
      const arrival = options.travelSeconds(m, m.position, foe.position), back = options.travelSeconds(m, foe.position, upper)
      if (Number.isFinite(arrival) && arrival >= 0 && Number.isFinite(back) && back >= 0) {
        const fight = foe === near ? personal! : memberFight(m, foe)
        const cover = team.reduce((sum, a) => {
          const duty = plan.get(a.id) || duties.find(t => t.assignedTo === a.id)
          if (a.id === m.id || weak(a) || duty?.status === 'done' || !duty || !/^(fight|goto)$/.test(duty.kind) || duty.data?.target !== foe.id || duty.data.search) return sum
          const duel = memberFight(a, foe), approach = options.travelSeconds!(a, a.position, foe.position)
          return Number.isFinite(approach) && approach >= 0 && approach + duel.attackSeconds < duel.survival ?
            sum + a.strength / meanStrength * (arrival + fight.attackSeconds) / Math.max(arrival + fight.attackSeconds, approach + duel.attackSeconds) : sum
        }, 0)
        const advantage = fight.survival > fight.attackSeconds ? 1 - fight.attackSeconds / fight.survival : 0
        const value = upper.tier / (1 + distance(m.position, upper))
        // Возврат к занятому верхнему луту оплачивается той же ценой пути; ближний готовый союзник уже держит цель.
        reserveValue += back * 5.6 * .25 * advantage * value / (1 + value) * Math.min(1, cover / demand)
      }
    }
    if (!nearby && !aggressive && !finishing && !deadly && !(m.role === 'miner-builder' && options.lootZones?.length && attackBeforeBuild(m, foe, board.now())) && engageValue < reserveValue) {
      // Резерв не сдаёт занятую высоту, если ближний верхний лут дешевле перехода и этот переход уводит от него.
      if (line) put(m, 'goto', { reserve: true, sentry: true, ...line }, spots.get(m.id))
      else put(m, m.role === 'miner-builder' ? 'scout' : 'goto', { reserve: true, sentry: true }, holdUpper ? m.position : at)
      continue
    }
    const search = board.now() - foe.seenAt > 500
    // Натиск: не в одиночку (пользователь 14.10: «в одиночку прибегают бить двух жёстких игроков»), но и без хоровода
    // («бегают вокруг игроков и не атакуют сразу — мирные как будто»; кольцо ожидания в 14 бл. так и выглядело). Сразу в бой:
    // кто-то из своих уже в схватке с целью, у цели (в 16 бл.) набралось по двое на каждого её врага (не меньше трёх, не
    // больше всех готовых), цель ослабла (ва-банк) или сама идёт на него. Иначе — к ближним готовым своим (до трёх, не у
    // цели): собраться, а не кружить; своих нет — в бой.
    const gapFoe = distance(m.position, foe.position)
    if (aggressive && !S.endgame && !search && gapFoe > 8 && foe !== prey) {
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
    put(m, search || !(committed || nearby) ? 'goto' : 'fight', { target: foe.id, enemyPosition: foe.position, sentry: !committed, search, ...(!search && line), ...(search ? { searchEnemy: foe.id, searchSeenAt: foe.seenAt } : {}), push: wind > 0 && (shove || doctrine === 'wave'), ...(shove ? { shove: true, shoveAt: { x: foe.position.x + edge!.x * (edge!.at ?? SHOVE_REACH), y: foe.position.y, z: foe.position.z + edge!.z * (edge!.at ?? SHOVE_REACH) } } : {}), ...(finishing ? { finishing: true } : {}), ...(covering ? { cover: covering.data!.cover } : {}), ...(assault?.target === foe.id ? { assault: true } : {}), ...(means?.smash ? { smash: true } : {}), ...(means?.axe && comboMace ? { axe: true } : {}), ...(slot !== undefined ? { slot } : {}) }, search ? foe.position : slot !== undefined ? ringAt(foe, slot, 2.5) : aggressive ? foe.position : spots.get(m.id))
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
    const old = duties.find(t => t.assignedTo === id && t.kind === task.kind && t.data?.target === foe.id)?.data?.swarmStand
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
    const unchanged = old?.claim && old.kind === task.kind && ['digAvoid', 'swarmStand'].every(key => JSON.stringify(old.data?.[key]) === JSON.stringify(task.data?.[key])) && (!task.data?.dig || JSON.stringify(old.data?.stands) === JSON.stringify(task.data.stands)) && ['target', 'ally', 'cover', 'coverWall', 'coverShield', 'doctrine', 'role', 'committed', 'search', 'searchSeenAt', 'searchEnemy', 'reserve', 'line', 'rotation', 'panic', 'hold', 'ambush', 'fountain', 'stage', 'regroup', 'hide', 'kite', 'perch', 'rearm', 'gather', 'slot', 'dig', 'undermine', 'camp', 'ladder', 'shove', 'push', 'assault', 'finishing', 'smash', 'axe'].every(key => old.data?.[key] === task.data?.[key])
    if (unchanged && old.data?.perchShot === task.data?.perchShot &&
        (!task.data?.stablePost || old.position && task.position && distance(old.position, task.position) < 1)) { plan.set(id, old); continue }
    if (old?.status === 'done') board.cancel(old.id)
    plan.set(id, board.upsert(task))
  }
  return plan
}
