// Рой: задачи хода бота — яма-ловушка, лестница у стены, поход к месту или врагу, бой с целью.
import { canDigTrap, assessSwarmFight } from '../../../daemon/src/swarm'
import { noteDigProgress, noteDigFailure } from '../../../daemon/src/swarm/dislodge'
import { digCells } from '../../../daemon/src/swarm/plan-jobs'
import { distance, cellKey } from './common'
import { currentTurn } from './lifecycle'
import type { SwarmDriverCtx, TurnCtx } from './common'
import { runAscent } from './ascent'
import { randomUUID } from 'node:crypto'

// The first physical move is shared with preempt: a changed later fight order must not restart this same walk.
export function earlyFightMove(m, task, foe) {
  const stand = task.data?.digAvoid?.length && task.data.swarmStand
  const onDig = stand && task.data.digAvoid.some(s => Math.abs(m.p.y - (s.feetY ?? s.y + 1)) <= .6 && m.p.x + .3 > s.x && m.p.x - .3 < s.x + 1 && m.p.z + .3 > s.z && m.p.z - .3 < s.z + 1)
  if (onDig && Math.abs(m.p.y - stand.y) <= 1.5) return { at: stand, range: .15, reason: 'vacate' }
  const to = task.data?.shoveAt
  if (task.data?.shove && to) {
    const dx = to.x - foe.position.x, dz = to.z - foe.position.z, n = Math.hypot(dx, dz)
    const side = ((foe.position.x - m.p.x) * dx + (foe.position.z - m.p.z) * dz) / (n * (Math.hypot(foe.position.x - m.p.x, foe.position.z - m.p.z) || 1))
    if (n > .3 && side <= .5) return { at: { x: foe.position.x - dx / n * 2.5, y: foe.position.y, z: foe.position.z - dz / n * 2.5 }, range: .8, reason: 'shove' }
  }
  return null
}
export function swarmTurnWork (sw: SwarmDriverCtx) {
  const { now, alive, log, pos, bots, arena, home, cooldown, holes, planned, walls, ladderRoutes, go, detail, rangedAdvantage, search, teamOf, ownProtection, say2, breach, climbTo, bounded, blast } = sw
  async function turnDig (tc: TurnCtx) {
    const { b, context, board, task, round, m } = tc
    const active = () => currentTurn(sw, b, round) && (!b.swarmTask || b.swarmTask.data?.dig === task.data.dig && b.swarmTask.data?.undermine === task.data.undermine)
    const s = task.position, key = cellKey(s)
    if (holes.some(h => cellKey(h) === key)) return
    const status = await b.c.call('status', { physics: true }).catch(() => null)
    let p = status?.detail?.physics?.pos || status?.state?.pos || m.p
    if (!active()) return
    m.p = p
    if (!canDigTrap(p, s) && !task.data.undermine) { planned.delete(teamOf(b)); return }
    let dug = 0, why = '', stepped = false
    const step = async () => {
      // Не вставать в готовую яму или на опору, которую сейчас разбирает другой копатель.
      const open = new Set([...holes.flatMap(h => Array.from({ length: h.y - (h.bottomY ?? h.y) + 1 }, (_, k) => ({ x: h.x, y: h.y - k, z: h.z }))),
        ...board.tasks().filter(t => t.data?.dig && t.position).flatMap(t => digCells({ ...t.position, blocks: t.data.blocks }))].map(cellKey))
      const stand = !stepped && [...(task.data.stands || [])].filter(a => !open.has(cellKey({ x: Math.floor(a.x), y: Math.ceil(a.y) - 1, z: Math.floor(a.z) }))).sort((a, c) => distance(a, p) - distance(c, p))[0]
      if (!stand) return false
      stepped = true
      if (Math.hypot(p.x - stand.x, p.z - stand.z) > 1.6) {
        const moved: any = await b.c.call('goto', { ...stand, range: 1, timeoutSeconds: 4, arena, climb: true, _hunt: true, _climb: true }).catch(() => null)
        if (!active()) return false
        if (moved?.status === 'interrupted') { b.swarmFightReply = moved; cooldown.set(`fight:${b.name}`, now() + 500); return false }
      }
      if (!active()) return false
      const moved: any = await b.c.call('center_in', { ...stand, ms: 2000, _climb: true, _hunt: true }).catch(e => ({ status: 'failed', error: e.message }))
      if (!active()) return false
      if (moved?.status === 'interrupted') { b.swarmFightReply = moved; cooldown.set(`fight:${b.name}`, now() + 500); return false }
      const centered = detail(moved)
      // status даёт клетку F3; только квитанция center_in сохраняет точность стойки ±0.2.
      if (!centered?.ok || ![centered.at?.x, centered.at?.y, centered.at?.z].every(Number.isFinite)) return false
      p = centered.at
      m.p = p
      return distance(p, stand) <= .2 && canDigTrap(p, s)
    }
    b.climbing = true
    try {
      // Дальность до верхнего блока не гарантирует луч к нижнему: соседняя стойка нужна до первого взмаха.
      if (task.data.undermine && task.data.stands?.length || !canDigTrap(p, s)) {
        const ready = await step()
        if (!active()) return
        if (!ready) { planned.delete(teamOf(b)); return }
      }
      for (let k = 0; k < (task.data.blocks || [0, 1]).length; k++) {
        // Сектор уже назначен бойцам, но ещё не освобождён физически: ждём в общем бюджете подкопа.
        if (task.data.undermine && context.members.some(a => {
          const q = pos[a.id]?.p ?? a.position
          return a.id !== b.name && q && alive(a.id) && Math.floor(q.y - .01) === s.y - k && q.x + .3 > s.x && q.x - .3 < s.x + 1 && q.z + .3 > s.z && q.z - .3 < s.z + 1
        })) return
        const reply: any = await b.c.call('swarm_work', { kind: 'dig', at: { x: s.x, y: s.y - k, z: s.z },
          protected: ownProtection(board), allies: context.members.map(a => a.id),
          // Бюджет — на блок: подход к нижнему слою не съедает 9.4 с копки обсидиана.
          timeoutSeconds: 12, undermine: !!task.data.undermine, _climb: true, _hunt: true
        }).catch(e => ({ status: 'failed', error: e.message }))
        if (!active()) return
        if (reply.status === 'interrupted') {
          b.swarmFightReply = reply
          cooldown.set(`fight:${b.name}`, now() + 500)
          return
        }
        const r = detail(reply)
        if (r.ok) { dug++; noteDigProgress(board, task.data.target, key, dug); continue }
        if (!/occluded|reach/.test(r.why || '') || !(await step())) { why = r.why || reply.error || reply.status || 'no_receipt'; if (r.ms !== undefined) why += ` ms=${r.ms} tool=${r.tool} before=${r.before}`; break }
        k--
      }
    } finally { if (round === sw.generation) b.climbing = false }
    if (!active()) return
    const need = (task.data.blocks || [0, 1]).length
    if (dug >= need) {
      holes.push({ x: s.x, y: s.y, z: s.z, bottomY: s.y - need + 1, feetY: (s as any).feetY ?? s.y + 1, drop: task.data.drop, at: now() })
      say2(`🕳 ${b.name.replace(/^NeuroFarm/, '')}: ${task.data.drop === Infinity ? 'подкоп — пустота' : 'яма-ловушка'} у ${String(task.data.target).replace(/^NeuroFarm/, '')} — толкайте туда!`, 'gold', true)
    } else { noteDigFailure(board, task.data.target, key); sw.siteFailed(b, 'hole:' + key) }
    planned.delete(teamOf(b))
    log(`🕳 ${b.name}: ${task.data.drop === Infinity ? 'подкоп' : 'яма'} у ${task.data.target} (${s.x} ${s.y} ${s.z}) — вскрыл ${dug}${why ? ` (${String(why).slice(0, 70)})` : ''}`)
    return
  }

  async function turnLadder (tc: TurnCtx) {
    const { b, task, round, member, enemies, context } = tc
    const t = walls.get(task.data.ladder)
    if (!t || t.done || !sw.siteOpen('ladder:' + t.key)) return
    const { x: fx, z: fz } = t.face
    const stand = { x: t.x + .5 + fx * 2, y: t.y, z: t.z + .5 + fz * 2 }
    const need = t.top - t.y + 1
    b.climbing = true
    try {
      let state = (await b.c.call('status', {}).catch(() => null))?.state
      if (!currentTurn(sw, b, round)) return
      if (!state?.pos) return
      b.swarmLadder = { hp: state.health ?? member.health, maxHp: state.maxHealth ?? member.maxHealth ?? 20,
        risk: assessSwarmFight(member, enemies, context.members) }
      if (distance(state.pos, stand) > .6) {
        const g = detail(await b.c.call('goto', { ...stand, range: 1, timeoutSeconds: 10, arena, climb: true, _hunt: true, _climb: true }).catch(e => ({ why: e.message })))
        if (!currentTurn(sw, b, round)) return
        if (g.arrived && Math.abs(g.arrived.y - stand.y) < .6) await b.c.call('center_in', { ...stand, ms: 1500, _climb: true }).catch(() => null)
        else { sw.siteFailed(b, 'ladder:' + t.key); log(`🪜 ${b.name}: к стене ${t.key} не подойти — ${String(g.why || g.error || 'нет').slice(0, 60)}`) }
        return
      }
      if ((state.inventory?.ladder || 0) < need) {
        const r = detail(await b.c.call('craft', { item: 'ladder', count: need - (state.inventory?.ladder || 0), _climb: true }).catch(e => ({ why: e.message })))
        if (!currentTurn(sw, b, round)) return
        state = (await b.c.call('status', {}).catch(() => null))?.state
        if (!currentTurn(sw, b, round)) return
        if ((state?.inventory?.ladder || 0) < need) { sw.siteFailed(b, 'ladder:' + t.key); log(`🪜 ${b.name}: лестниц для ${t.key} не хватило (${state?.inventory?.ladder || 0}/${need}) — ${String(r.why || r.error || r.note || '').slice(0, 50)}`); return }
      }
      const r = detail(await runAscent(b, { p: state.pos, hp: state.health, inv: state.inventory },
        { x: stand.x, y: t.top + 1, z: stand.z }, () => b.c.call('ladder_up', { wall: { x: t.x, y: t.y, z: t.z }, face: t.face, top: t.top, timeoutSeconds: 40, _climb: true }).catch(e => ({ why: e.message })), now))
      if (!currentTurn(sw, b, round)) return
      log(`🪜 ${b.name}: лестница у ${t.key} (${need} бл.) — ${r.complete ? `готова, ступеней ${r.placed}` : String(r.why || 'нет').slice(0, 70)}`)
      if (r.complete) {
        t.done = true
        if (!ladderRoutes.some(l => l.key === t.key)) ladderRoutes.push({ key: t.key, base: { x: t.x + .5 + fx, y: t.y, z: t.z + .5 + fz }, top: { x: t.x + .5, y: t.top + 1, z: t.z + .5 } })
        say2(`🪜 ${b.name.replace(/^NeuroFarm/, '')}: лестница наверх готова — лезьте`, 'green', true)
      } else sw.siteFailed(b, 'ladder:' + t.key)
    } finally { if (round === sw.generation) { b.climbing = false; delete b.swarmLadder } }
    return
  }

  async function turnGoto (tc: TurnCtx) {
    const { b, context, task, round, m, contact, foe } = tc
    // Охота: дошёл до места, где врага видели последним, — прочёсывать арену, а не стоять.
    // Дошёл туда, где врага видели последним, а его не видно — замуровался рядом: копать туда, а не бродить (натиск).
    // Своя точка поиска веером (searchAt, план) — туда; дошёл — прочёсывать (а прокоп — только к самому месту врага).
    const searchAt = task.data?.searchAt ?? task.data?.enemyPosition
    if (task.data?.search && distance(m.p, searchAt) < 4) { if (task.data.hunt && (sw.onslaught(b) || task.data.finishing) && await breach(b, task.data.enemyPosition)) return; if (!currentTurn(sw, b, round)) return; await search(b, context); return }
    // Сбор на своём секторе (окружение): место — от живой позиции цели (план держит старое место, пока данные те же).
    const sf = task.data?.slot !== undefined && foe
    const at = task.data?.search ? searchAt : task.data?.swarmStand || (sf ? { x: sf.position.x + Math.cos(task.data.slot * Math.PI / 4) * 10, y: sf.position.y, z: sf.position.z + Math.sin(task.data.slot * Math.PI / 4) * 10 } : task.position)
    // Сторож уже отказал этому подходу с той же стойки: меняем путь, сохраняя цель охоты.
    if ((b.badSpots || []).some(p => p.from && distance(p.from, m.p) < 2 && distance(p, bounded(at)) < 1)) {
      if (task.data?.hunt && (sw.onslaught(b) || task.data.finishing) && distance(m.p, task.data.enemyPosition) < 12 && await breach(b, task.data.enemyPosition)) return
      if (!currentTurn(sw, b, round)) return
      await search(b, context)
      return
    }
    const walked = detail(await go(b, at, task.data?.swarmStand && !task.data?.search ? .15 : task.data?.range ?? 2).catch(e => ({ why: e.message })))
    if (!currentTurn(sw, b, round)) return
    // Охота: к месту врага не дойти (замуровался за стеной дальше 4 бл.) — прокоп к нему (Codex 15.10: три отказа пути, ноль прокопов).
    if (task.data?.hunt && (sw.onslaught(b) || task.data.finishing) && !walked?.arrived && distance(pos[b.name]?.p || m.p, task.data.enemyPosition) < 12 && await breach(b, task.data.enemyPosition)) return
    if (!currentTurn(sw, b, round)) return
    if (task.data?.bait && !contact) await b.c.call('eat', { timeoutSeconds: 2 }).catch(() => {})
    return
  }

  async function turnFight (tc: TurnCtx) {
    const { b, board, task, round, m, enemies, contact, foe } = tc
    if (b.cur !== foe.id) b.noReach = 0
    b.cur = foe.id
    // Ближний бой прежде игнорировал сектор: свои вставали на опоры уже назначенной ямы.
    const stand = task.data.digAvoid?.length && task.data.swarmStand
    const move = earlyFightMove(m, task, foe)
    if (move) {
      const owner = { ...move, at: { ...move.at }, round, target: foe.id, intent: null }
      b.swarmReposition = owner
      try { const pending = go(b, move.at, move.range); owner.intent = b.last; await pending }
      finally { if (b.swarmReposition === owner) delete b.swarmReposition }
      return
    }
    const to = task.data.shoveAt
    if (task.data.push && now() - foe.seenAt < 500) {
      const push = detail(await b.c.call('wind_push', { target: foe.id, force: !!task.data.shove, arena, allies: tc.context.members.map(a => a.id).filter(id => id !== b.name) }))
      if (!currentTurn(sw, b, round)) return
      if (push.fired) { log(`💨 ${b.name} → ${foe.id}: заряд ветра${task.data.shove ? ' — сброс' : ''}`); return }
    }
    const stale = now() - foe.seenAt > 1000, far = distance(m.p, foe.position) > 18 && !rangedAdvantage(b)
    // Окружение: своё место — сектор в 2.5 бл. от живой позиции цели (план — data.slot), а не прямо на неё одной толпой.
    const potionFirst = Object.entries(m.potions || {}).some(([k, n]: any) => n > 0 && /^splash_(?:(?:long|strong)_)?(?:harming|poison|slowness|weakness)$/.test(k))
    const ringR = potionFirst ? 5.75 : 2.5
    // Добивание бегущего — перехват: кольцо вокруг точки, где он будет, когда я добегу (упреждение по его скорости, до 1.5 с),
    // а не вокруг живой позиции — сзади равного по скорости не догнать (DeepSeek, разбор погони 21.10).
    const fv = foe.velocity || { x: 0, y: 0, z: 0 }, fsp = Math.hypot(fv.x, fv.z)
    const lead = task.data.finishing && fsp > .15 ? Math.min(30, distance(m.p, foe.position) / 5.6 * 20) : 0
    const aim = { x: foe.position.x + fv.x * lead, y: foe.position.y, z: foe.position.z + fv.z * lead }
    const slotAt = stand || (task.data.slot !== undefined ? { x: aim.x + Math.cos(task.data.slot * Math.PI / 4) * ringR, y: aim.y, z: aim.z + Math.sin(task.data.slot * Math.PI / 4) * ringR } : lead ? aim : foe.position)
    // Он на элитрах (swarm-senses: elytraFlying → threat aerial). Столб, шаг и прокоп к летуну пусты: пока строишь, он уже
    // в другом месте; кольцо и место вокруг точки в воздухе — тоже. В виду и ближе 48 — сразу бой: тело стреляет по летуну,
    // бежит под него или идёт на таран со своими элитрами (turn-air). Не видно или дальше — бег по земле под точку, где он
    // будет через секунду (пользователь 21.10: «преследования игроков, которые убегают элитрами»).
    const flyer = foe.threat === 'aerial'
    const under = { x: foe.position.x + fv.x * 20, y: undefined, z: foe.position.z + fv.z * 20 }
    // Цель выше 3+ бл. — подъём (видно её или нет: снизу крышу не видно, лезть к последнему месту).
    // Рядом, но ниже на 1.8+ (столб у края крыши: удар не достаёт — стенд 15.10, «пауза»: синий в 3 бл. на 2.5 ниже) — тоже
    // подъём: короткий столбик к нему.
    const below = foe.position.y - m.p.y, nearH = Math.hypot(foe.position.x - m.p.x, foe.position.z - m.p.z) < 4
    // Добивание рой на рой (finishing, plan-frame endgame) — тоже к нему наверх и сквозь стену: засевшего на столбе 13 синих не
    // могли достать до конца раунда (стенд 15×15, 21.10).
    const reach = sw.onslaught(b) || !!task.data.finishing
    if (!flyer && reach && below > 3 && !contact && await climbTo(b, foe, slotAt)) return
    if (!currentTurn(sw, b, round)) return
    // Рядом, ниже на 1.8+: шаг на его уровень (клетка рядом с ним, допуск 1 бл.); «дошёл», а всё ещё ниже (допуск 2.5 засчитывал
    // стоящего на 2 ниже — десятки попыток в секунду, удара нет) — 1.5 с без попыток, бить тем, что достаёт.
    // Шаг не вышел — повтор, когда он сдвинулся на другую клетку или я ушёл с места (retry.ts), а не через 1.5 с.
    const foeCell = cellKey({ x: Math.floor(foe.position.x), y: Math.floor(foe.position.y), z: Math.floor(foe.position.z) })
    if (!flyer && reach && below > 1.8 && nearH && !sw.blocked(b, `step:${b.name}`, foeCell)) {
      // В 3 бл. от него — столбик на месте до его уровня (удар достаёт 3); дальше — клетка в 1.2 бл. от него. exactY: ровно его
      // высота, а не пол под ней (иначе «дошёл» внизу).
      // Не вышло к нему — следующая попытка столбиком на месте (и наоборот): край крыши над стеной галереи — к клетке у него
      // путь ищется долго, а столб в 3.3 бл. достаёт (стенд s5: пауза 13 с на −2.5).
      b.stepTry = (b.stepTry || 0) + 1
      const d = Math.hypot(m.p.x - foe.position.x, m.p.z - foe.position.z) || 1, k = d <= 3 || b.stepTry % 2 === 0 ? d : 1.2
      const at = { x: foe.position.x + (m.p.x - foe.position.x) / d * k, y: foe.position.y, z: foe.position.z + (m.p.z - foe.position.z) / d * k }
      b.climbing = true
      const r = detail(await b.c.call('goto', { ...bounded(at), range: 1, timeoutSeconds: 4, arena, climb: true, exactY: true, _hunt: true, _climb: true }).catch(e => ({ why: e.message })).finally(() => { if (round === sw.generation) b.climbing = false }))
      if (!currentTurn(sw, b, round)) return
      if (!r.arrived || foe.position.y - (pos[b.name]?.p?.y ?? m.p.y) > 1.5) sw.failed(b, `step:${b.name}`, foeCell)
      else return
    }
    // Натиск: он ближе 10 бл. и не над нами (не в прыжке с булавой), а его не видно (замуровался) или два боя без удара —
    // (и вплотную: «бой 0/0 в 2.8 бл.» за стенкой — прокоп; виден — dig_to сразу «дошёл», ничего не ломает; Codex 15.10)
    // не дойти: прокоп к нему (14.10: «из укрытия не достают, а кирками раскопать — и все пройдут»).
    const reachGap = distance(m.p, foe.position), grounded = foe.position.y - m.p.y < 2.5
    if (!flyer && reach && reachGap < 10 && grounded && (stale || (b.noReach || 0) >= 2)) {
      const breached = await breach(b, foe.position)
      if (!currentTurn(sw, b, round)) return
      if (breached) { b.noReach = 0; return }
    }
    if (!currentTurn(sw, b, round)) return
    const flyerAway = flyer && (stale || reachGap > 48)
    if (flyerAway || stale || !task.data.committed || far && !flyer) {
      await go(b, flyerAway && task.data.committed ? under : stale ? foe.position : task.data.committed && far ? slotAt : task.position, 3)
      return
    }
    // Смыкание фонтана — сперва своё место по кругу (иначе все догоняют его со спины одной кучей), потом удар.
    if (task.data.fountain === 'close' && distance(m.p, task.position) > 1.5 && !contact) { await go(b, task.position, .8); return }
    const place = task.data.slot !== undefined ? slotAt : task.position
    if (!flyer && distance(m.p, place) > 6 && !contact && !rangedAdvantage(b)) { await go(b, place); return }
    if (!flyer && foe.position.y - m.p.y > 4 && (m.inv.elytra || m.armor?.torso === 'elytra') && m.inv.firework_rocket >= 5 && !sw.blocked(b, `fly:${b.name}`, foeCell)) {
      const r = detail(await b.c.call('fly_to', { at: foe.position, timeoutSeconds: 15, arena }).catch(e => ({ why: e.message })))
      if (!currentTurn(sw, b, round)) return
      if (!r.ok) sw.failed(b, `fly:${b.name}`, foeCell)
      return
    }
    // Динамит к его ногам (пользователь 15.10: «под игрока прям ставить»): в 2.5–4.5 бл., он на нашем уровне ±1, своих у него
    // нет; поставил — отбежать (blast).
    if (!flyer && sw.onslaught(b) && reachGap >= 2.5 && reachGap <= 4.5 && Math.abs(foe.position.y - m.p.y) <= 1.2 && now() - foe.seenAt < 500 && await blast(b, foe.position, `к ногам ${foe.id}`)) return
    if (!currentTurn(sw, b, round)) return
    // Он выше на 1.8+ рядом (край крыши): бой коротко — 3 с, дальше снова шаг/столбик к нему (бой сам на 2–2.5 не строится).
    // Очередь ударов по окнам неуязвимости (pvp/strike-order, поток enc 21.10): свои, кто бьёт ту же цель у неё (6 бл.), —
    // по имени, одинаково у всех; удар в чужое окно — пустой взмах и сброс своей зарядки.
    const strikers = bots.filter(o => alive(o.name) && teamOf(o) === teamOf(b) && (o === b || o.swarmTask?.kind === 'fight' && o.swarmTask.data?.target === foe.id) && pos[o.name]?.p && distance(pos[o.name].p, foe.position) <= 6).map(o => o.name).sort()
    const fight = { id: randomUUID(), round, target: foe.id, roundScope: `${teamOf(b)}:${round}`, intent: null }
    b.swarmFight = fight
    let reply
    try {
      const pending = b.c.call('fight', { target: foe.id, targets: enemies.map(e => e.id), ...(strikers.length > 1 ? { strikeOrder: strikers } : {}), shoveAt: task.data.shove ? task.data.shoveAt || null : null, digAvoid: task.data.digAvoid || [], swarmStand: stand || null, relocateTo: home(b), allowPlayer: true, allowRanged: true, potionFirst, timeoutSeconds: task.data.fountain === 'close' ? 4 : sw.onslaught(b) && below > 1.8 && nearH ? 3 : 12, retreatAtHealth: sw.onslaught(b) ? 0 : 3, roundScope: fight.roundScope, fightId: fight.id, arena })
      fight.intent = b.last
      reply = await pending
    } finally { if (b.swarmFight === fight) delete b.swarmFight }
    if (!currentTurn(sw, b, round)) return
    const result = detail(reply)
    // Бой перебит (тактика, отмена) — не повторять сразу тот же бой: до освобождения тактики (guardedTurn; Codex 15.10:
    // «fight → interrupted → fight» по 5–8 раз за секунду).
    if (reply?.status === 'interrupted') { b.swarmFightReply = reply; cooldown.set(`fight:${b.name}`, now() + 500) }
    if (result.killed || result.kills?.length) board.noteTacticOutcome(b.name, task.data.doctrine, true)
    const gapAfter = pos[b.name]?.p ? distance(pos[b.name].p, foe.position) : 0
    b.noReach = (reply?.status === 'done' || reply?.status === 'timeout') && result.landed === 0 && gapAfter < 10 && foe.position.y - (pos[b.name]?.p?.y ?? 0) < 2.5 ? (b.noReach || 0) + 1 : 0
    // Итог боя в журнал (арена 14.10: убийств почти нет — видно, чем кончается схватка: попадания, хп, причина конца).
    // Чем бил (пользователь 14.10: «булавой, копьём, элитрами не атакуют») — выбор графа боя и приёмы особого оружия.
    const special = Object.keys(result.tricks || {}).filter(k => /булав|копь|элитр|пике|таран|трезуб|удочк|молни|заряд|зель|щит|опор|яму|столкн|вод|потуш|огн|паутин/.test(k)).slice(0, 5)
    // Сломать опору под ним (pvp.ts breakUnder): попыток/сломал/упал — видно, работает ли сброс на краю.
    if (result.breakUnder?.tries) special.unshift(`опора ${result.breakUnder.ok}/${result.breakUnder.tries}${result.breakUnder.fell ? `, упал ${result.breakUnder.fell}` : ''}`)
    log(`⚔ ${b.name} → ${foe.id}: попаданий ${result.landed ?? '?'}/${result.swings ?? '?'}, хп ${result.hp ?? '?'}${result.killed || result.kills?.length ? ', убил' : ''}${result.stopped || result.why ? ' — ' + String(result.stopped || result.why).slice(0, 70) : ''}${result.calc?.picks ? ` | граф ${Object.entries(result.calc.picks).map(([k, n]) => `${k}:${n}`).join(',')}` : ''}${special.length ? ` | ${special.join('; ')}` : ''}${reply?.status === 'interrupted' ? ` | interrupted ${JSON.stringify(reply.by)}` : ''}`)
    return
  }

  return { turnDig, turnLadder, turnGoto, turnFight }
}
