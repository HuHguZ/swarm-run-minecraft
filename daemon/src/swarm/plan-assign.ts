// Рой (swarm.ts): план боя (planPvp) — остальным бой, сбор, резерв, лут или укрытие; план на доску (то же дело —
// та же аренда).
import * as damage from '../pvp/damage-model'
import type { SwarmTask } from './types'
import type { PvpPlan } from './plan-frame'
import { fledAt, markFled } from './board'
import { distance, cellKey, ratio, count } from './common'
import { visibleForce } from './fight'
import { lineRank, lineDuty } from './doctrine'

export function assignFighters(S: PvpPlan): void {
  const { board, team, enemies, plan, options, aggressive, doctrine, committed, center, forward, lineClock, spots, put, assault, regroup, losing, prey, hunting, untouchable, loads, meanStrength, sectorOf, ringAt, gatherers, lastEnemy, diggers, ladderers, campers, hideoutFor, perchFor, rallyFor, outclassed, weak, improvementOf, targetCost } = S
  for (const m of team.filter(m => !plan.has(m.id)).sort((a, b) => b.strength - a.strength || a.id.localeCompare(b.id))) {
    if (diggers.has(m.id)) { const { site: s, foe } = diggers.get(m.id)!; put(m, 'goto', { dig: cellKey(s), blocks: (s as any).blocks, stands: (s as any).stands, target: foe.id, enemyPosition: foe.position, reason: 'копаю яму-ловушку' }, s); continue }
    if (ladderers.has(m.id)) { const s = ladderers.get(m.id)!; put(m, 'goto', { ladder: s.key, reason: 'ставлю лестницу для своих' }, { x: s.x, y: s.y, z: s.z }); continue }
    if (campers.has(m.id)) { put(m, 'goto', { hold: 'ambush', camp: cellKey(campers.get(m.id)!), reason: 'засада в углу' }, campers.get(m.id)!); continue }
    const foe = hunting(m) && !untouchable.has(prey!.id) ? prey! : [...enemies].filter(e => !untouchable.has(e.id)).sort((a, b) => targetCost(m, a) - targetCost(m, b) || a.id.localeCompare(b.id))[0]
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
      if (weak(m) || improvement > 0 && (!lastEnemy || board.facts().some(f => f.id === 'outmatched' || f.id === 'outmatched:' + m.id))) { put(m, 'loot', { improvement, reason: 'лут: врага не видно' }); continue }
      // Врага не видели вовсе — прочёсывать, без прокопа: «охота» на своё место копала под себя (ночь 15.10: 1686 прокопов
      // в пустом раунде, ~100 ботов провалились под арену).
      const at = lastEnemy?.position ?? m.position
      put(m, 'goto', { search: true, ...(lastEnemy ? { hunt: true } : {}), enemyPosition: at, improvement }, at); continue
    }
    // Натиск, слабый (weak): ближний враг дальше 16 бл. — лут; 5–16 — к своим по открытому, за спины готовых (пользователь
    // 14.10: «не должны в замкнутые пространства бежать, когда игрок рядом за ними идёт» — комната-тупик с пустыми
    // сундуками); своих рядом нет — в укрытие колизея, там на шифте («если своих нет — прятаться в колизее, в блоках или
    // на высоте, и шифт зажимать, чтобы мы не видели»); ближе 5 бл. не убежать (он быстрее) — драться со всеми.
    // Перегруппировка после проваленного штурма — так же для всех, кто не в схватке. Голые — и в штурме (пользователь
    // 14.10: «бегут к игроку без вещей»): штурм — для снаряжённых, голому сперва лут.
    if (aggressive && !(foe === prey && hunting(m)) && (weak(m) || outclassed(m, [...enemies].sort((a, b) => distance(a.position, m.position) - distance(b.position, m.position))[0]) || regroup && !assault)) {
      const near = [...enemies].sort((a, b) => distance(a.position, m.position) - distance(b.position, m.position))[0], gap = distance(m.position, near.position)
      if (gatherers.has(m.id)) { put(m, 'goto', { gather: options.gather!.item, count: 32, reason: 'добываю блоки для подъёма' }, options.gather!.spot); continue }
      // На насесте — сидеть, пока враг в 28 бл.: оттуда лук и еда; ушёл дальше — вниз за лутом.
      // Запас по расстоянию: убегавший вернётся к луту только за 22 бл. (на 16 туда-сюда каждые 3 с — арены 37–38).
      // Память — на доске, а не в задаче: дошёл до укрытия — задача снята, и порог снова 16 (поле, s6: 24 смены за 28 с).
      // Снимается только лутом за 22 бл. — не сроком (было 15 с: убежавший за 16 с снова лутался на 17 бл. и бежал опять).
      const fled = !!fledAt.get(board)?.has(m.id)
      // Две границы: бегство — с 16 бл. и ближе, лут — только дальше 22; между ними — что было (отметка снимается с лутом,
      // иначе граница одна — 22 — и на 22↔23 бл. смена каждые 2 с, поле s8).
      if (gap > (fled ? 22 : 16) && !(onPerch && gap < 28)) { fledAt.get(board)?.delete(m.id); put(m, 'loot', { improvement: improvementOf(m), weak: true, reason: `лут: враг в ${Math.round(gap)} бл.${fled ? ' (убегал)' : ''}` }); continue }
      // Граница «не убежать» с запасом от прежней задачи (стенд rush 15.10: на 5–6 бл. «прячусь ↔ бой» каждые 1–2 с, 45 смен
      // у одного бота): убегавший дерётся только вплотную (3.5), дерущийся уходит дальше 6.
      const prior = board.tasks().find(t => t.id === `pvp:${m.id}`)?.kind
      const edge = prior === 'flee' ? 3.5 : prior === 'fight' ? 6 : 5
      const perch = gap > edge && (onPerch ? m.position : perchFor(m))
      if (perch) { markFled(board, m.id); put(m, 'flee', { target: near.id, enemyPosition: near.position, perch: true, panic: true, reason: `на насест, нечем драться (враг в ${Math.round(gap)} бл.${fled ? ', убегал' : ''})` }, perch); continue }
      const group = gap > edge && rallyFor(m, near)
      if (group) { markFled(board, m.id); put(m, 'flee', { target: near.id, enemyPosition: near.position, regroup: true, panic: true, reason: `к своим, нечем драться (враг в ${Math.round(gap)} бл.${fled ? ', убегал' : ''})` }, group); continue }
      const hide = gap > edge && hideoutFor(m)
      if (hide) { markFled(board, m.id); put(m, 'flee', { target: near.id, enemyPosition: near.position, hide: true, panic: true, reason: `прячусь, своих рядом нет (враг в ${Math.round(gap)} бл.${fled ? ', убегал' : ''})` }, hide); continue }
      // Бежать некуда (укрытия и свои — за врагом), а он ещё не вплотную — лут с отходом от него (исполнитель отходит на 8 бл.),
      // а не общий план боя: слабый шёл бы прямо на него.
      if (gap > edge) { markFled(board, m.id); put(m, 'loot', { improvement: improvementOf(m), weak: true, reason: `лут: отхожу, укрыться негде (враг в ${Math.round(gap)} бл.)` }); continue }
    }
    const nearby = distance(m.position, foe.position) <= 4.5
    // Смена линий: ранг не на смене уходит в тыл и из контакта — иначе старый фронт так и стоит в бою (лаборатория 13.10).
    if (doctrine === 'line' && lineRank(team.indexOf(m), team.length) !== lineDuty(lineClock, team.length)) {
      put(m, 'goto', { reserve: true, line: lineRank(team.indexOf(m), team.length), rotation: lineDuty(lineClock, team.length) }); continue
    }
    const demand = visibleForce(foe) * 1.2 / meanStrength
    const engageValue = (1 - (loads.get(foe.id) || 0) / demand) * 15 + 7 - distance(m.position, foe.position) * 0.25
    const reserveValue = (m.role === 'miner-builder' ? 8 : m.role === 'healer' ? 6 : 1) + (1 - ratio(m)) * 8
    // Натиск: резерва нет — на человека идут все (резерв «по модели нужно 2–3» оставлял одиночек без подмоги).
    if (!nearby && !aggressive && engageValue < reserveValue) {
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
    const slot = aggressive && !search ? sectorOf(m, foe) : undefined
    put(m, search || !(committed || nearby) ? 'goto' : 'fight', { target: foe.id, enemyPosition: foe.position, sentry: !committed, search, push: doctrine === 'wave' && count(m.inventory, 'wind_charge') > 2 && !count(m.inventory, 'mace'), ...(assault ? { assault: true } : {}), ...(slot !== undefined ? { slot } : {}) }, search ? foe.position : slot !== undefined ? ringAt(foe, slot, 2.5) : aggressive ? foe.position : spots.get(m.id))
    loads.set(foe.id, (loads.get(foe.id) || 0) + m.strength / meanStrength)
  }
}

export function commitPlan(S: PvpPlan): Map<string, SwarmTask> {
  const { board, plan } = S
  const previous = board.tasks().filter(t => t.id.startsWith('pvp:'))
  for (const old of previous) if (![...plan.values()].some(t => t.id === old.id)) board.cancel(old.id)
  for (const [id, task] of plan) {
    const old = previous.find(t => t.id === task.id)
    const unchanged = old?.claim && old.kind === task.kind && ['target', 'ally', 'cover', 'doctrine', 'role', 'committed', 'search', 'reserve', 'panic', 'hold', 'ambush', 'fountain', 'stage', 'regroup', 'hide', 'kite', 'perch', 'gather', 'slot', 'dig', 'camp', 'ladder'].every(key => old.data?.[key] === task.data?.[key])
    if (unchanged) { plan.set(id, old); continue }
    if (old?.status === 'done') board.cancel(old.id)
    plan.set(id, board.upsert(task))
  }
  return plan
}
