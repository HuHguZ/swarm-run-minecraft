// Рой: ход бота — фаза задачи, упреждающее перепланирование, шаг задачи.
import { WEAPON, blockCount, distance, cellKey } from './common'
import type { SwarmDriverCtx, TurnCtx } from './common'

export function swarmTurn (sw: SwarmDriverCtx) {
  const { now, alive, log, pos, arena, cooldown, refresh, say, execute, reactCamp, forgetCamp, go, chestAtHand, loot, grab, detail, positionStep, search, transfer, buildStep, mineStep, bounded, tour, turnFlee, turnRecover, turnHold, turnBuildSite, turnDig, turnLadder, turnGoto, turnFight } = sw
  // Фаза приёма: смена её посреди долгого дела (бой — до 12 игровых с) обрывает дело — иначе старый фронт линии
  // дерётся после смены, фонтан не смыкается, засада не бьёт. Смена цели в том же бою фазой не считается.
  // Только фазы приёмов: обычное перераспределение (бой ↔ резерв) не обрывает начатое, иначе бой дёргается.
  // Раненый, которому велено отходить (recover), — тоже фаза: бой до 12 с добивал его (лаборатория 13.10, линия: 1 хп → смерть).
  // Отход раненого и бегство от неравного боя — одна фаза «уход»: переключения между ними рвали сам отход (лаборатория 13.10).
  const phase = t => t ? [t.kind === 'recover' || t.data?.panic ? 'retreat' : '', t.data?.hold, t.data?.fountain, t.data?.ambush && t.kind, t.data?.line !== undefined ? 'line' : '', t.data?.rotation].join('|') : ''
  // Тело горит — идёт выход из лавы (arena dangers → lava_escape): ни стопа смены фазы, ни нового дела — любой вызов
  // отменял выход, и бот стоял в лаве (поток enc, 21.10: «🌋 отхожу» ×5 за 3 с и смерть). Так же уход от динамита
  // (dodge_blast): goto дела отменял его через 0.1–0.7 с, и бот оставался у горящего заряда (стенд бота-противника 22.10).
  const burning = b => /^(lava_escape|dodge_blast|clear_web)$/.test(b.last?.m || '') && b.last.pending !== false
  function preempt(b) {
    const running = b.swarmTask
    if (burning(b)) return false
    // Без «первой секунды неприкосновенности» (21.10): план сам держит решения по миру (retreat.ts, гистерезис доктрины и
    // цели), и смена фазы — это настоящая смена обстановки.
    if (b.campReacting || !b.swarmExecuting || !running || !alive(b.name)) return false
    // В воздухе на элитрах дело не обрываем: «стоп» посреди тарана сажал бота без удара (стенд 21.10, слот 30: 5 из 6
    // таранов «бой кончился в воздухе» — смена фазы fight → flee). Новая фаза начнётся после посадки.
    if (pos[b.name]?.gliding) return false
    const { task } = refresh(b)
    if (!task || phase(task) === phase(running)) return false
    b.swarmTask = task; b.swarmTaskAt = now()
    log(`↪ ${b.name}: смена фазы ${running.kind}${running.data?.fountain ? '/' + running.data.fountain : ''} → ${task.kind}${task.data?.fountain ? '/' + task.data.fountain : ''}${task.data?.hold ? '/' + task.data.hold : ''} — обрываю дело`)
    b.c.call('stop').catch(() => {})
    return true
  }
  async function turn(b) {
    if (burning(b)) return
    const context = refresh(b), { board, member, task } = context, round = sw.generation
    if (!member || !task) return
    // Участник чужого дела (ждёт передачу, подброс ветром) стоит, пока дело занято (до 15 с), — но не под врагом: стенд
    // бота-противника 22.10, бот с лутом 6 с стоял «вне хода» в 5 бл. от человека.
    const threat = !!pos[b.name] && board.enemies().some(e => now() - e.seenAt < 1500 && distance(e.position, pos[b.name].p) < 8)
    if (!threat && board.tasks().some(t => t.status === 'claimed' && t.claim.owner !== b.name && t.participants?.includes(b.name))) return
    if (phase(task) !== phase(b.swarmTask)) b.swarmTaskAt = now()
    b.swarmTask = task
    say(b, task)
    const m = pos[b.name], enemies = board.enemies()
    const tc: TurnCtx = { b, context, board, member, task, round, m, enemies }
    // Кемпер в коробке: урон и вскрытие — до смены дела (ранение не теряется при переходе в recover).
    if (b.boxedCamp) {
      const r = await execute(b, 'swarm_hold', { camp: true, checkOnly: true, enemies: enemies.map(e => e.id), allies: context.members.map(a => a.id), arena })
      // Поздний ответ после сброса раунда не оживляет старую засаду (Codex 15.10).
      if (round !== sw.generation || !alive(b.name)) return
      if (await reactCamp(b, r)) return
    }
    // Кемпер в своей коробке получил другое дело — сперва выйти (пролом в сторону дела), иначе лез по кругу из запертой клетки.
    if (b.boxedCamp && task.data?.camp !== b.boxedCamp) {
      const was = b.boxedCamp
      b.campReacting = true
      let r: any
      try { r = await execute(b, 'box_out', { toward: task.position || null, timeoutSeconds: 24, _climb: true, arena }) } finally { delete b.campReacting }
      if (round !== sw.generation || !alive(b.name)) return
      // Тело помнит коробку, пока не вышел: забыть только по выходу (иначе драйвер и тело расходились — Codex 15.10).
      // Пять неудач подряд — забыть (иначе вечный «выхожу — не вышел»; тело само отпустит коробку со смертью или новым раундом).
      if (r.left || r.why === 'не заперт' || (b.boxOutTries = (b.boxOutTries || 0) + 1) >= 5) forgetCamp(b)
      log(`🧱 ${b.name}: кемпер выходит из коробки ${was} (${task.kind}${task.data?.camp ? ' ' + task.data.camp : ''}) — ${r.left ? 'вышел' : String(r.why || 'не вышел').slice(0, 60)}`)
      return
    }
    // Свой горящий динамит рядом (факт tnt, 4.5 с): отойти на 7+ бл., всё остальное подождёт.
    const boom = board.facts().find(f => f.id.startsWith('tnt:') && f.position && distance(f.position, m.p) < 6)
    if (boom) { const d = Math.hypot(m.p.x - boom.position.x, m.p.z - boom.position.z) || 1; await go(b, { x: m.p.x + (m.p.x - boom.position.x) / d * 7, y: m.p.y, z: m.p.z + (m.p.z - boom.position.z) / d * 7 }, 1.5, 3); return }
    if (!/^(flee|recover)$/.test(task.kind) && chestAtHand(b) && await loot(b, board, true)) return
    const onslaught = sw.onslaught(b)
    if (onslaught && task.kind !== 'flee' && !task.data?.dig && !task.data?.ladder && await grab(b, enemies)) return
    if (task.kind === 'flee') {
      await turnFlee(tc)
      return
    }
    const nearest = [...enemies].sort((a, c) => distance(a.position, m.p) - distance(c.position, m.p))[0]
    const gap = nearest ? distance(nearest.position, m.p) : Infinity
    const toward = nearest && gap ? ((nearest.velocity?.x || 0) * (m.p.x - nearest.position.x) + (nearest.velocity?.z || 0) * (m.p.z - nearest.position.z)) / gap * 20 : 0
    const contact = nearest && now() - nearest.seenAt < 1000 && (gap <= 3.5 || toward > 0 && (gap - 3) / toward < .8)
    Object.assign(tc, { nearest, gap, contact })
    // В досягаемости его секунды бега (4.5 бл. удара плюс его бег за секунду, не меньше 5.6 бл/с; со Скоростью — больше) стоять
    // нельзя: резерв, часовой и стройка в 6 бл. от человека сидели на шифте у него под мечом по 30 с (стенд бота-противника
    // 22.10). Вооружённый часовой и ждущий сбора — в бой с ним (стройка и копка у цели — их дело); копка тайника и обмен — не здесь.
    const reach = nearest ? 4.5 + Math.max(5.6, Math.hypot(nearest.velocity?.x || 0, nearest.velocity?.z || 0) * 20) : 0
    const exposed = !!nearest && now() - nearest.seenAt < 1000 && gap <= reach
    // Вода (пользователь 14.10: «из-за воды тупят — против течения стоят»; «круто, если воду будут убирать блоками или
    // вёдрами, если мешает»): в воде и не в схватке — убрать источник рядом ведром или блоком, нечего — выплыть.
    // С этого места уже пробовал (убрал или нечем) — снова только с другого места (повтор по причине, retry.ts), а не через 4 с.
    if (m.water && !contact && !sw.blocked(b, `water:${b.name}`)) {
      const r = detail(await b.c.call('clear_water', {}).catch(e => ({ why: e.message })))
      sw.failed(b, `water:${b.name}`)
      if (r.how || r.why) log(`💧 ${b.name}: ${r.how || r.why}`)
      if (r.ok) return
    }
    if (task.kind === 'recover') {
      await turnRecover(tc)
      return
    }
    if (task.kind === 'heal') {
      if (distance(m.p, task.position) > 4.5) await go(b, task.position, 3)
      await b.c.call('assist', { mode: 'heal', ally: task.data.ally })
      return
    }
    // Стойка на месте: кольцо щитов (щит поднят, лицом наружу), засада флангов или оцепление кокона (присед, взгляд на цель).
    if (task.kind === 'goto' && ['shield', 'ambush', 'cordon'].includes(task.data?.hold)) {
      await turnHold(tc)
      return
    }
    // Тайники в толще (поток «тайники», swarm-driver/caches.ts): копатель, выбранный числами (plan-jobs.cacheJobs: копка
    // дороже боя/лута/охоты), копает, если не в схватке и задача — не бой и не приём строя. false — обычный ход дальше.
    // Боец тоже может копать тайник, когда враг дальше 16 бл. — цену против боя считает cacheJobs, отказ — сам cacheTurn.
    if (!contact && !exposed && !['flee', 'recover', 'heal'].includes(task.kind) && !task.data?.fountain && !task.data?.ambush && !task.data?.hold && task.data?.line === undefined && !task.data?.bait && !task.data?.cordon && !task.data?.buildKind && !task.data?.dig && !task.data?.ladder && await sw.cacheTurn(b, board)) return
    // Манёвр приёма (линия, фонтан, засада, кольцо, приманка, оцепление, стройка) важнее ролевых привычек: обмен, сундуки,
    // поиск позиции, маяки и укрытия его не перебивают (разбор 13.10: строитель кокона уходил класть маяк, часовой без лука
    // по 10 с искал позицию для стрельбы).
    // Добивание и сброс — тоже манёвр команды: обмен, лут, позиция лучника и стройка строителя их не перебивают (DeepSeek,
    // разбор погони 21.10: половина команды при 13 против 2 делала ролевые привычки).
    const maneuver = !!(task.data?.fountain || task.data?.ambush || task.data?.hold || task.data?.line !== undefined || task.data?.bait || task.data?.cordon || task.data?.buildKind || task.data?.dig || task.data?.ladder || task.data?.finishing || task.data?.shove)
    tc.maneuver = maneuver
    const armed = Object.keys(m.inv || {}).some(n => WEAPON.test(n))
    const engage = () => b.c.call('fight', { target: nearest.id, targets: enemies.map(e => e.id), allowPlayer: true, allowRanged: true, timeoutSeconds: 3, retreatAtHealth: 3, arena })
    if (!maneuver && !contact && !exposed && await transfer(b, context)) return
    if (task.data?.buildKind) {
      await turnBuildSite(tc)
      return
    }
    // Добытчик (gather, планировщик): к месту добычи и копать руками (песок поля 16 бл. ≈ 15 с); добытое разнесут передачи.
    if (task.data?.gather && !contact) {
      if (distance(m.p, task.position) > 24) { await go(b, task.position, 8, 8); return }
      const r = detail(await b.c.call('mine', { block: task.data.gather, count: task.data.count || 32, radius: 24, timeoutSeconds: 20 }).catch(e => ({ why: e.message })))
      log(`🏖 ${b.name}: добываю ${task.data.gather} команде на подъём — ${r.dug ?? 0} шт.${r.why ? ` (${String(r.why).slice(0, 60)})` : ''}`)
      return
    }
    // Яма-ловушка (dig, планировщик; Codex 15.10): верх пола — с места, где стоит (планировщик берёт копателя, у кого яма в
    // досягаемости, — поход к стойке рвали тактика, тревога и тайм-аут: 0 ям за 7 прогонов). Нижний слой двойного пола виден
    // сквозь дыру только из соседней клетки (луч с высоты глаз 1.62 входит в дыру шириной 1 круче 45°) — за ним (и за невидимым
    // верхом: перила, плиты) шаг на стойку.
    // Готовую дыру — в holes: сектор удара (edgeNear) ставит бьющих так, чтобы отбросило в неё.
    if (task.data?.dig && !contact) {
      await turnDig(tc)
      return
    }
    // Лестница у стены пояса (ladder, планировщик; место — модель): встать за колонной лестницы (W + 2·грань), скрафтить, сколько
    // нужно, подняться, ставя ступени (ladder_up); вся колонна стоит — общий путь наверх (ladderRoutes), лезущие идут по нему.
    if (task.data?.ladder && !contact) {
      await turnLadder(tc)
      return
    }
    // Натиск: у кого из своих нечем драться — сильный по пути забирает увиденные сундуки (враг дальше 16 бл.), лишнее
    // раздадут передачи (пользователь 14.10: «сильные могут сразу много лута брать и передавать своим»).
    const carrier = onslaught && armed && gap > 16 && context.members.some(a => a.id !== b.name && !Object.keys(a.inventory || {}).some(n => WEAPON.test(n)))
    if (!maneuver && !contact && (task.kind === 'loot' || !armed || carrier) && await loot(b, board)) return
    const bow = !!(m.inv?.bow || m.inv?.crossbow) && !!m.inv?.arrow
    // Натиск: строителю не до вышек и маяков — бой (14.10: «бегают вокруг меня»).
    if (!maneuver && !contact && (member.role === 'ranged' && bow || member.role === 'miner-builder' && !onslaught || task.data?.sentry && bow) && await positionStep(b, context, member.role === 'miner-builder' ? 'build' : 'ranged')) return
    if (!maneuver && !contact && (task.data?.sentry || b.swarmPosition?.purpose === 'recover') && b.swarmPosition && distance(m.p, b.swarmPosition.at) < 1.5) { if (exposed && armed) { await engage(); return } await b.c.call('swarm_hold', { sneak: b.swarmPosition?.cover > .5, enemies: enemies.map(e => e.id), allies: context.members.map(a => a.id), timeoutSeconds: 3 }); return }
    if (!maneuver && member.role === 'miner-builder' && !onslaught && !contact && !sw.blocked(b, `work:${b.name}`, String(blockCount(m.inv)))) {
      if (nearest && nearest.position.y > m.p.y + 2 && await mineStep(b, context, nearest)) return
      if (b.swarmPosition?.purpose === 'build' && b.swarmPosition.highGround >= 3 && distance(m.p, b.swarmPosition.at) < 2 && await buildStep(b, context, { kind: 'outpost', origin: b.swarmPosition.at })) return
      // Маяк «враг был здесь» — один на клетку, а не на дробную позицию (иначе новый маяк почти каждый ход).
      const trail = nearest && 'trail:' + cellKey({ x: Math.floor(nearest.position.x), y: Math.floor(nearest.position.y), z: Math.floor(nearest.position.z) })
      if (nearest && !board.facts().some(f => f.id === trail) && (m.inv.cobblestone || 0) > 18) {
        const origin = { x: Math.floor(m.p.x) + 1, y: Math.floor(m.p.y), z: Math.floor(m.p.z) }
        if (await buildStep(b, context, { kind: 'beacon', origin })) { board.recordFact(b.name, now(), { id: trail, kind: 'mark', position: nearest.position }, 30000); return }
      }
      if (!task.data.cover && await buildStep(b, context)) return
      if (!nearest && await mineStep(b, context, nearest)) return
    }
    const foe = enemies.find(e => e.id === task.data?.target)
    tc.foe = foe
    // Копатель в контакте (план держит своего до 3 бл., контакт — 3.5) — бой, а не шаг в клетку ямы (Codex 15.10).
    if (exposed && armed && task.kind === 'goto' && !task.data?.search && !maneuver) { await engage(); return }
    if ((task.kind === 'goto' || task.data?.search) && !(task.data?.dig && contact)) {
      await turnGoto(tc)
      return
    }
    if (foe && (task.kind === 'fight' || task.data?.dig && contact)) {
      await turnFight(tc)
      return
    }
    // Обход мест за лутом — и в командной гонке (21.10): лутающему без известных сундуков незачем бродить наугад.
    if (task.kind === 'loot' && await tour(b, board)) return
    // Лут, а брать нечего (сундуки у врага, обход занят) и враг виден в 30 бл. — отойти от него, а не «искать» (поиск вёл прямо
    // к нему: поле s10 — 24 → 13 бл. за 3 с, и снова бегство; «лут ↔ бегство» по кругу).
    if (task.kind === 'loot') {
      const foe = enemies.filter(e => now() - e.seenAt < 3000).sort((a, c) => distance(a.position, m.p) - distance(c.position, m.p))[0]
      if (foe && distance(foe.position, m.p) < 30) {
        const d = Math.hypot(m.p.x - foe.position.x, m.p.z - foe.position.z) || 1
        await go(b, bounded({ x: m.p.x + (m.p.x - foe.position.x) / d * 8, y: m.p.y, z: m.p.z + (m.p.z - foe.position.z) / d * 8 }), 3, 4)
        return
      }
    }
    await search(b, context)
  }
  return { phase, preempt, turn }
}
