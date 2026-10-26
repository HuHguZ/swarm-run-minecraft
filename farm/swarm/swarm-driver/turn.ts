// Рой: ход бота — фаза задачи, упреждающее перепланирование, шаг задачи.
import { WEAPON, blockCount, distance, cellKey } from './common'
import { assessSwarmFight } from '../../../daemon/src/swarm'
import { ascentActive } from './ascent'
import { rayBox } from '../../../daemon/src/pick'
import { earlyFightMove } from './turn-work'
import type { SwarmDriverCtx, TurnCtx } from './common'

export function swarmTurn (sw: SwarmDriverCtx) {
  const { now, alive, log, pos, arena, cooldown, refresh, say, execute, reactCamp, forgetCamp, go, chestAtHand, loot, grab, detail, positionStep, search, transfer, buildStep, mineStep, bounded, tour, turnFlee, turnRecover, turnHold, turnBuildSite, turnDig, turnLadder, turnGoto, turnFight } = sw
  // Фаза приёма: смена её посреди долгого дела (бой — до 12 игровых с) обрывает дело — иначе старый фронт линии
  // дерётся после смены, фонтан не смыкается, засада не бьёт.
  // Только фазы приёмов: обычное перераспределение (бой ↔ резерв) не обрывает начатое, иначе бой дёргается.
  // Раненый, которому велено отходить (recover), — тоже фаза: бой до 12 с добивал его (лаборатория 13.10, линия: 1 хп → смерть).
  // Отход раненого и бегство от неравного боя — одна фаза «уход»: переключения между ними рвали сам отход (лаборатория 13.10).
  const standCell = p => p ? `${Math.floor(p.x)},${Math.floor(p.y)},${Math.floor(p.z)}` : ''
  const vacatePhase = (t, at) => {
    // goto carries only its destination, not a frozen digAvoid snapshot. New neighbouring work cannot invalidate it.
    if (t.kind === 'goto' && !t.data?.dig) return t.data?.swarmStand ? `vacate:${t.data.swarmStand.x},${t.data.swarmStand.y},${t.data.swarmStand.z}` : ''
    if (!t.data?.digAvoid?.length) return ''
    const stand = t.data.swarmStand, to = stand || at
    // Дальние ямы не отменяют бой; новый резерв на пути рамки к стойке требует свежего digAvoid в RPC.
    const cells = at ? t.data.digAvoid.filter(s => {
      const feet = s.feetY ?? s.y + 1
      return rayBox(at, { x: to.x - at.x, y: to.y - at.y, z: to.z - at.z },
        { x: s.x - .3, y: feet - .6, z: s.z - .3 }, { x: s.x + 1.3, y: feet + .6, z: s.z + 1.3 }, 1) != null
    }).map(cellKey).sort().join(';') : ''
    // Ни ям на пути, ни стойки — то же, что без digAvoid: «vacate::» ↔ «» рвало бой каждую секунду (игра 25.10: 46 из 112
    // боёв оборвал goto, бот под мечом стоял).
    if (!cells && !stand) return ''
    return `vacate:${cells}:${standCell(stand)}`
  }
  const phase = (t, at = null, guard = true) => t ? [t.kind === 'recover' || t.kind === 'flee' || t.data?.panic ? 'retreat' : '', t.data?.hold, t.data?.fountain, t.data?.ambush && t.kind, t.data?.line !== undefined ? 'line' : '', t.data?.rotation, t.data?.dig ? `dig:${t.data.dig}:${!!t.data.undermine}` : '', guard && t.data?.shove ? `shove:${t.data.target}` : '', guard ? vacatePhase(t, at) : ''].join('|') : ''
  const guardKey = t => JSON.stringify([(t.data?.digAvoid || []).map(p => `${cellKey(p)}:${p.feetY ?? p.y + 1}`).sort(), t.data?.swarmStand ? [t.data.swarmStand.x, t.data.swarmStand.y, t.data.swarmStand.z] : null, t.data?.shove && t.data?.shoveAt ? [t.data.shoveAt.x, t.data.shoveAt.y, t.data.shoveAt.z] : null])
  // Тело горит — идёт выход из лавы (arena dangers → lava_escape): ни стопа смены фазы, ни нового дела — любой вызов
  // отменял выход, и бот стоял в лаве (поток enc, 21.10: «🌋 отхожу» ×5 за 3 с и смерть). Так же уход от динамита
  // (dodge_blast): goto дела отменял его через 0.1–0.7 с, и бот оставался у горящего заряда (стенд бота-противника 22.10).
  // Щит к падающему с булавой (dangers → swarm_hold whileSmash) — тоже: смена фазы «проигрываем — прячусь» и новое дело
  // опускали щит за тики до удара, новый подъём не держит 5 т (игра пользователя 22.10: 14 из 18 смертей — «smashed», в журнале
  // «щит к нему» по 3 раза за секунду перед каждой).
  // Спасение держит тело до квитанции окончания, а не до отказа очередному приказу драйвера.
  const burning = b => b.webRescue || pos[b.name]?.rescuing || b.maceDefense?.until > now() ||
    (/^(lava_escape|dodge_blast|clear_web)$/.test(b.last?.m || '') || !!b.shieldHold && b.last?.m === 'swarm_hold') && b.last.pending !== false
  const price = r => r && (r.duelKillSeconds ?? r.killSeconds) / Math.max(.05, r.duelSurvivalSeconds ?? r.survivalSeconds)
  // Цена отмены держит обе стороны смены: стройку не рвёт мелкий пересчёт, а отход не кончается тем же новым goto.
  function ladderTask(b, context) {
    const { task, board, member, members } = context, running = b.swarmTask
    if (!task || !running || !member) return task
    const exit = running.data?.ladderRetreat, leaving = running.data?.ladder && task.kind === 'flee'
    if (!leaving && !exit) return task
    const foes = board.enemies(), risk = task.data?.risk || assessSwarmFight(member, foes, members)
    const after = price(risk), maxHp = member.maxHealth ?? b.swarmLadder?.maxHp ?? exit?.maxHp ?? 20
    const bow = e => e.threat === 'bow' || /^(bow|crossbow)$/.test(e.equipment?.weapon || '')
    const exposed = foes.some(e => now() - e.seenAt < 1500 && (distance(e.position, member.position) <= 8 ||
      (e.sources || []).includes(b.name) && bow(e)))
    if (leaving) {
      const work = b.swarmLadder, before = price(work?.risk)
      // Рана, смертельный залп, контакт и свежий лучник дороже продолжения работы при любой принятой цене.
      if (work && !exposed && !risk.lethal && !risk.burst && member.health >= work.hp &&
          member.health / maxHp >= work.hp / work.maxHp && Number.isFinite(before) && Number.isFinite(after) &&
          after <= before * 1.25) return running
      return Number.isFinite(after) ? { ...task, data: { ...task.data, ladderRetreat: {
        key: running.data.ladder, target: task.data?.target ?? risk.target, price: after, hp: member.health, maxHp } } } : task
    }
    // Память живёт в текущем flee: смена цели или раунда очищает её вместе с самой задачей.
    if (task.kind === 'flee') return !task.data?.target || task.data.target === exit.target ? { ...task, data: { ...task.data, ladderRetreat: exit } } : task
    if (task.data?.ladder !== exit.key || !Number.isFinite(exit.price) || !Number.isFinite(after)) return task
    const foe = foes.find(e => e.id === exit.target)
    const facing = foe && now() - foe.seenAt < 1500 && (foe.sources || []).includes(b.name) &&
      distance(foe.position, member.position) <= (bow(foe) ? 40 : 16)
    const healed = member.health > exit.hp && member.health / maxHp > exit.hp / exit.maxHp
    return exposed || facing && (risk.lethal || risk.burst || !healed && after >= exit.price / 1.25) ? running : task
  }
  function stopForTask(b, running, task, before, after) {
    // Смена цели при той же фазе — видна в журнале (15×15 26.10: «обычный бой → обычный бой» 108 раз, причина не видна).
    if (running.data?.target !== task.data?.target && before === after) after = `${after}|цель ${running.data?.target ?? '—'}→${task.data?.target ?? '—'}`
    b.swarmTask = task; b.swarmTaskAt = now()
    if (b.swarmFight) b.swarmFight.stopping = true
    log(`↪ ${b.name}: смена фазы ${running.kind}${running.data?.fountain ? '/' + running.data.fountain : ''} → ${task.kind}${task.data?.fountain ? '/' + task.data.fountain : ''}${task.data?.hold ? '/' + task.data.hold : ''} (${before.split('|').filter(Boolean).join(', ') || 'обычный бой'} → ${after.split('|').filter(Boolean).join(', ') || 'обычный бой'}) — обрываю дело [${b.last?.m || '-'}]`)
    b.c.call('stop', running.data?.dig || task.data?.dig || b.swarmAscent ? { _climb: true } : undefined).catch(() => {})
  }
  function preempt(b) {
    const running = b.swarmTask
    if (burning(b)) return false
    // Без «первой секунды неприкосновенности» (21.10): план сам держит решения по миру (retreat.ts, гистерезис доктрины и
    // цели), и смена фазы — это настоящая смена обстановки.
    if (b.campReacting || !b.swarmExecuting || !running || !alive(b.name)) return false
    // В воздухе на элитрах дело не обрываем: «стоп» посреди тарана сажал бота без удара (стенд 21.10, слот 30: 5 из 6
    // таранов «бой кончился в воздухе» — смена фазы fight → flee). Новая фаза начнётся после посадки.
    if (pos[b.name]?.gliding) return false
    // Действующий подъём не меняет фазу от очередного пересчёта плана.
    if (ascentActive(b, pos[b.name], now())) return false
    const context = refresh(b), task = ladderTask(b, context)
    const before = phase(running, pos[b.name]?.p), after = phase(task, pos[b.name]?.p)
    const fight = b.swarmFight
    if (!task || fight?.stopping) return false
    const targetChanged = /^(fight|goto)$/.test(running.kind) && /^(fight|goto)$/.test(task.kind) &&
      running.data?.target && task.data?.target && running.data.target !== task.data.target
    const move = b.swarmReposition
    if (move && move.round === sw.generation && move.target === task.data?.target && b.last === move.intent &&
        b.last?.m === 'goto' && b.last.pending !== false && running.kind === 'fight' && task.kind === 'fight' &&
        !targetChanged && phase(running, null, false) === phase(task, null, false)) {
      const foe = context.board?.enemies().find(e => e.id === move.target), m = pos[b.name]
      const next = foe && m?.p && earlyFightMove(m, task, foe)
      if (next && next.reason === move.reason && next.range === move.range &&
          next.at.x === move.at.x && next.at.y === move.at.y && next.at.z === move.at.z) {
        b.swarmTask = task
        return false
      }
      if (guardKey(running) !== guardKey(task)) {
        stopForTask(b, running, task, before, after)
        return true
      }
    }
    if (fight && fight.round === sw.generation && fight.target === task.data?.target && b.last === fight.intent &&
        running.kind === 'fight' && task.kind === 'fight' && !targetChanged && phase(running, null, false) === phase(task, null, false) && guardKey(running) !== guardKey(task)) {
      if (fight.pending) return false
      fight.pending = true
      const current = () => fight.round === sw.generation && b.swarmFight === fight && b.swarmTask === running &&
        b.last === fight.intent && b.swarmExecuting && alive(b.name)
      const reject = () => { if (current()) stopForTask(b, running, task, before, after) }
      b.c.call('fight_guard', { target: fight.target, roundScope: fight.roundScope, fightId: fight.id,
        digAvoid: task.data?.digAvoid || [], swarmStand: task.data?.swarmStand || null,
        shoveAt: task.data?.shove ? task.data.shoveAt || null : null }).then(r => {
        if (!current()) return
        if (detail(r)?.accepted === true) b.swarmTask = task
        else reject()
      }, reject).finally(() => { fight.pending = false })
      return false
    }
    // Идёт рукопашная и цель в досягаемости — не рвём её сменой цели, толчка или клетки: бой роя 24.10 — 33 из 35 боёв
    // «прервано» пересчётом плана, попаданий 14 на 35 боёв. Обрывает только отход, щит или копка.
    if (running.kind === 'fight' && task.kind === 'fight' && !task.data?.commanded && b.last?.m === 'fight' && b.last.pending !== false &&
        !/retreat|dig:/.test(after) && after.split('|')[1] === before.split('|')[1]) {
      const foe = context.board?.enemies().find(e => e.id === running.data?.target), m = pos[b.name]?.p
      if (foe && m && now() - foe.seenAt < 1500 && distance(foe.position, m) <= 4.5) return false
    }
    // Бой с ним идёт, а план зовёт к той же цели походом (open/cork/shield) — враг в 6 бл., бой не рвать: сильный бот за 40 с
    // 8 раз менял fight ↔ goto, по удару за бой, и умер (игра пользователя 25.10).
    if (running.kind === 'fight' && task.kind === 'goto' && !task.data?.commanded && !targetChanged && b.last?.m === 'fight' && !task.data?.rotation && task.data?.line === undefined &&
        b.last.pending !== false && !/retreat|dig:/.test(after)) {
      const foe = context.board?.enemies().find(e => e.id === running.data?.target), m = pos[b.name]?.p
      if (foe && m && now() - foe.seenAt < 1500 && distance(foe.position, m) <= 6) return false
    }
    // Тот же поход, стойка сдвинулась меньше чем на 0.5 бл. — не рвать: пересчёт сдвигал её на доли блока каждую секунду, и рой
    // топтался (игра пользователя 25.10: 240 обрывов goto → goto за 3 мин).
    const s0 = running.data?.swarmStand, s1 = task.data?.swarmStand
    if (running.kind === 'goto' && task.kind === 'goto' && !targetChanged && s0 && s1 && distance(s0, s1) < .5 &&
        phase({ ...running, data: { ...running.data, swarmStand: s1 } }, pos[b.name]?.p) === after) { b.swarmTask = task; return false }
    // Сменилась только стойка (тот же род дела, цель, отход/щит/копка/толчок): смена приёма переназначала стойки всем разом и
    // рвала 29 дел за секунду, человек бил стоящих (игра пользователя 25.10). Враг уже в 6 бл. — дело идёт, стойка подождёт.
    const noStand = (ph: string) => ph.replace(/vacate:[^|]*/, '')
        if (running.kind === task.kind && /^(fight|goto)$/.test(task.kind) && !targetChanged && s0 && s1 && noStand(before) === noStand(after)) {
      const foe = context.board?.enemies().find(e => e.id === task.data?.target), me = pos[b.name]?.p
      if (foe && me && now() - foe.seenAt < 1500 && distance(foe.position, me) <= 6) { b.swarmTask = task; return false }
    }
    // Смена цели при той же фазе: прежняя видна и не дальше новой на 6 бл. — подход к ней не рвать (15×15 26.10: 100 из 369 обрывов —
    // цель y→u→w за секунду, до боя не доходили). Обрывают отход, щит, копка и далёкая/пропавшая цель, как прежде.
    if (targetChanged && after === before) {
      const foes = context.board?.enemies() || [], me = pos[b.name]?.p
      const old = foes.find(e => e.id === running.data.target), next = foes.find(e => e.id === task.data.target)
      if (old && next && me && now() - old.seenAt < 1500 && distance(old.position, me) <= distance(next.position, me) + 6) return false
    }
    if (after === before && !targetChanged) return false
    stopForTask(b, running, task, before, after)
    return true
  }
  async function turn(b) {
    if (burning(b)) return
    const context = refresh(b), { board, member } = context, task = ladderTask(b, context), round = sw.generation
    if (!member || !task) return
    // Участник чужого дела (ждёт передачу, подброс ветром) стоит, пока дело занято (до 15 с), — но не под врагом: стенд
    // бота-противника 22.10, бот с лутом 6 с стоял «вне хода» в 5 бл. от человека.
    const threat = !!pos[b.name] && board.enemies().some(e => now() - e.seenAt < 1500 && distance(e.position, pos[b.name].p) < 8)
    const receiving = !threat && board.tasks().find(t => t.status === 'claimed' && t.claim.owner !== b.name && t.participants?.includes(b.name))
    if (receiving) {
      if (receiving.kind === 'transfer' && !b.swarmBusyUntil) await b.c.call('swarm_hold', { sneak: true, enemies: board.enemies().map(e => e.id), allies: context.members.map(a => a.id), timeoutSeconds: 1, arena })
      return
    }
    if (phase(task, pos[b.name]?.p) !== phase(b.swarmTask, pos[b.name]?.p)) b.swarmTaskAt = now()
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
    if (!/^(flee|recover)$/.test(task.kind) && !task.data?.commanded && !task.data?.finishing && chestAtHand(b) && await loot(b, board, true)) return
    const onslaught = sw.onslaught(b)
    if (onslaught && task.kind !== 'flee' && !task.data?.commanded && !task.data?.dig && !task.data?.ladder && await grab(b, enemies)) return
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
    if (!contact && !exposed && !['flee', 'recover', 'heal'].includes(task.kind) && !task.data?.commanded && !task.data?.finishing && !task.data?.fountain && !task.data?.ambush && !task.data?.hold && task.data?.line === undefined && !task.data?.bait && !task.data?.cordon && !task.data?.buildKind && !task.data?.dig && !task.data?.ladder && await sw.cacheTurn(b, board)) return
    // Манёвр приёма (линия, фонтан, засада, кольцо, приманка, оцепление, стройка) важнее ролевых привычек: обмен, сундуки,
    // поиск позиции, маяки и укрытия его не перебивают (разбор 13.10: строитель кокона уходил класть маяк, часовой без лука
    // по 10 с искал позицию для стрельбы).
    // Добивание и сброс — тоже манёвр команды: обмен, лут, позиция лучника и стройка строителя их не перебивают (DeepSeek,
    // разбор погони 21.10: половина команды при 13 против 2 делала ролевые привычки).
    const maneuver = !!(task.data?.commanded || task.data?.fountain || task.data?.ambush || task.data?.hold || task.data?.line !== undefined || task.data?.bait || task.data?.cordon || task.data?.buildKind || task.data?.dig || task.data?.ladder || task.data?.finishing || task.data?.shove)
    tc.maneuver = maneuver
    const armed = Object.keys(m.inv || {}).some(n => WEAPON.test(n))
    const engage = () => task.data?.digAvoid?.length ? turnFight({ ...tc, foe: nearest, task: { ...task, kind: 'fight', data: { ...task.data, target: nearest.id, committed: true } } }) :
      b.c.call('fight', { target: nearest.id, targets: enemies.map(e => e.id), allowPlayer: true, allowRanged: true, timeoutSeconds: 3, retreatAtHealth: 3, arena })
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
    if (task.data?.dig && (!contact || task.data.undermine)) {
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
    const bow = !!(m.inv?.bow || m.inv?.crossbow) && !!(m.attackArrows ?? (m.inv?.arrow || 0) + (m.inv?.spectral_arrow || 0))
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
      if (Object.keys(m.inv || {}).some(name => /_spear$/.test(name)) && sw.positionQueries < 2) {
        const risk = task.data?.risk || assessSwarmFight(member, enemies, context.members)
        const incomingDps = Number.isFinite(risk.duelSurvivalSeconds) ? member.health / risk.duelSurvivalSeconds : 0
        sw.positionQueries++
        try { if (await sw.pairedWind(b, context, foe.position, { enemy: foe.id, incomingDps }).catch(() => false)) return }
        finally { sw.positionQueries-- }
      }
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
