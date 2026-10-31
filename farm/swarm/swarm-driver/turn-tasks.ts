// Рой: задачи хода бота — бегство (насест, укрытие, отрыв), отход раненого, стойка (щиты, засада, кемпер), стройка у цели.
import { blockCount, distance, cellKey } from './common'
import { currentTurn } from './lifecycle'
import type { SwarmDriverCtx, TurnCtx } from './common'

export function swarmTurnTasks (sw: SwarmDriverCtx) {
  const { now, alive, log, pos, arena, cooldown, boxed, boxTries, execute, reactCamp, go, loot, detail, rangedAdvantage, positionStep, search, buildStep, bounded } = sw
  async function turnFlee (tc: TurnCtx) {
    const { b, context, board, task, round, m, enemies } = tc
    // Наверху (ярус, крыша, насест), а человек пришёл на мой уровень в 8 бл. — вниз: край с дешёвым падением (jump_down), нет —
    // на элитрах к полю прочь от него (пользователь 25.10: «не спрыгивают сверху — легко умирают»). С этого места уже пробовал —
    // снова только с другого (повтор по месту, retry.ts).
    const close = enemies.filter(e => now() - e.seenAt < 1000 && distance(e.position, m.p) <= 8 && e.position.y > m.p.y - 3)
      .sort((a, c) => distance(a.position, m.p) - distance(c.position, m.p))[0]
    if (close && m.p.y > arena.y + 4 && sw.blocked && !sw.blocked(b, `jump:${b.name}`)) {
      const r = detail(await b.c.call('jump_down', { from: close.position, arena }).catch(e => ({ why: e.message })))
      if (!currentTurn(sw, b, round)) return
      let how = r.ok ? `спрыгнул ${r.drop} бл.${r.mlg ? ' (ведро)' : ''}, хп ${r.hp}` : r.why || r.error || '?'
      if (!r.ok && (m.inv?.elytra || m.armor?.torso === 'elytra') && (m.inv?.firework_rocket || 0) >= 5) {
        const d = Math.hypot(m.p.x - close.position.x, m.p.z - close.position.z) || 1
        const at = bounded({ x: m.p.x + (m.p.x - close.position.x) / d * 14, y: arena.y, z: m.p.z + (m.p.z - close.position.z) / d * 14 })
        let reply = await b.c.call('fly_to', { at, timeoutSeconds: 10, arena }).catch(e => ({ why: e.message }))
        if (!currentTurn(sw, b, round)) return
        if (reply?.code === 'RESCUE_BUSY') return
        if (reply?.status === 'interrupted') { b.swarmFightReply = reply; cooldown.set(`fight:${b.name}`, now() + 500); return }
        let f = detail(reply)
        // Под карнизом не сесть: поле проверяет тот же полёт, без повторного взлёта после промаха.
        if (reply?.status === 'done' && f.ok === false && f.why === 'негде сесть у цели (под навесом или занято)' && (at.x !== arena.x || at.z !== arena.z)) {
          reply = await b.c.call('fly_to', { at: { x: arena.x, y: arena.y, z: arena.z }, timeoutSeconds: 10, arena }).catch(e => ({ why: e.message }))
          if (!currentTurn(sw, b, round)) return
          if (reply?.code === 'RESCUE_BUSY') return
          if (reply?.status === 'interrupted') { b.swarmFightReply = reply; cooldown.set(`fight:${b.name}`, now() + 500); return }
          f = detail(reply)
        }
        how += `; элитры к полю — ${f.ok ? 'сел' : f.why || f.error || '?'}`
        if (f.ok) r.ok = true
      }
      log(`🪂 ${b.name}: ${close.id} в ${distance(close.position, m.p).toFixed(1)} бл. наверху (+${Math.round(m.p.y - arena.y)}) — ${how}`)
      if (r.ok) return
      sw.failed(b, `jump:${b.name}`)
    }
    // Отход с элитрами и ракетами, враг в 12 бл. — улететь на 30 бл. от него, а не бежать «за укрытие» (пользователь 25.10:
    // «убил, хотя у него элитры и фейерверки» — пешком от «Скорости II» не уйти). С этого места не вышло — пешком, как раньше.
    const chaser = enemies.filter(e => now() - e.seenAt < 1000 && distance(e.position, m.p) <= 12)
      .sort((a, c) => distance(a.position, m.p) - distance(c.position, m.p))[0]
    // Уже на насесте — только если он поднялся ко мне на 6 бл.: дальше насест держит лук (игра 25.10: на насесте 30 с стоял под ним, убит).
    if (chaser && (!task.data?.perch || distance(m.p, task.position) <= 3 && distance(chaser.position, m.p) <= 6) && (m.inv?.elytra || m.armor?.torso === 'elytra') && (m.inv?.firework_rocket || 0) >= 5 && sw.blocked && !sw.blocked(b, `airflee:${b.name}`)) {
      const d = Math.hypot(m.p.x - chaser.position.x, m.p.z - chaser.position.z) || 1
      const at = bounded({ x: m.p.x + (m.p.x - chaser.position.x) / d * 30, y: arena.y, z: m.p.z + (m.p.z - chaser.position.z) / d * 30 })
      const f = detail(await b.c.call('fly_to', { at, timeoutSeconds: 10, arena }).catch(e => ({ why: e.message })))
      if (!currentTurn(sw, b, round)) return
      log(`🪽↩ ${b.name}: ${chaser.id} в ${distance(chaser.position, m.p).toFixed(1)} бл. — улетаю на 30 бл. — ${f.ok ? 'сел' : f.why || f.error || '?'}`)
      if (f.ok) return
      sw.failed(b, `airflee:${b.name}`)
    }
    // Догоняет (8 бл.), а элитр нет или не вышло — прыжок на заряде ветра прочь от него (пользователь 25.10: «пусть кидают ветер
    // себе под ноги, чтобы убегать, если догоняю»): разбег от него, заряд под ноги — толчок вперёд и вверх, до 2 подряд.
    if (chaser && distance(chaser.position, m.p) <= 8 && (m.inv?.wind_charge || 0) > 0 && sw.blocked && !sw.blocked(b, `windflee:${b.name}`)) {
      // Прочь от него, а упёрлось в стену — под углом 45° и 90° (стенд 25.10: «стена впереди в 1 бл.» — прыжка не было).
      const base = Math.atan2(m.p.z - chaser.position.z, m.p.x - chaser.position.x)
      let w: any = null
      for (const a of [0, Math.PI / 4, -Math.PI / 4, Math.PI / 2, -Math.PI / 2]) {
        const toward = bounded({ x: m.p.x + Math.cos(base + a) * 12, y: m.p.y, z: m.p.z + Math.sin(base + a) * 12 })
        w = detail(await b.c.call('wind_jump', { toward, times: 2 }).catch(e => ({ why: e.message })))
        if (!currentTurn(sw, b, round)) return
        if (w.used || !/^стена впереди/.test(w.why || '')) break
      }
      log(`🌬↩ ${b.name}: ${chaser.id} в ${distance(chaser.position, m.p).toFixed(1)} бл. — прыжок на ветре прочь — ${w.used ? `зарядов ${w.used}, подъём ${(+w.rise || 0).toFixed(1)}` : w.why || w.error || '?'}`)
      if (w.used) return
      sw.failed(b, `windflee:${b.name}`)
    }
    // Колонна в двух секундах хода дешевле далёкого насеста; луч и путь проверяет само тело.
    const archer = !enemies.some(e => now() - e.seenAt < 1000 && distance(e.position, m.p) <= 6) && enemies.filter(e => e.threat === 'bow' && now() - e.seenAt < 1000)
      .sort((a, c) => distance(a.position, m.p) - distance(c.position, m.p))[0]
    if (archer) {
      const reply = await b.c.call('take_cover', { from: archer.id, localOnly: true, nearerThan: task.data?.perch ? task.position : undefined, arena })
      if (!currentTurn(sw, b, round)) return
      if (reply?.status === 'interrupted') { b.swarmFightReply = reply; cooldown.set(`fight:${b.name}`, now() + 500); return }
      if (detail(reply)?.ok) return
      // Прятаться не за что — стенка из блоков на месте, в его сторону.
      if (blockCount(m.inv) >= 2) {
        const wall = detail(await b.c.call('take_cover', { from: archer.id, wall: true, arena }).catch(e => ({ why: e.message })))
        if (!currentTurn(sw, b, round)) return
        log(`🧱🏹 ${b.name}: от лучника ${archer.id} (${distance(archer.position, m.p).toFixed(0)} бл.) — ${wall.ok ? wall.how : wall.why || wall.error || '?'}`)
        if (wall.ok) return
      }
    }
    // Насест на элитрах (perch, пользователь 14.10: «могут наверх улетать и там сидеть, кемперить или с лука палить»):
    // далеко — долететь (fly_to: над гребнем, посадка с открытым небом; не вышло — бежать, как обычно); на месте — лук
    // из-за своей стенки в прыжке (peek_shot, с места не сходит), без лука — есть и сидеть на шифте.
    if (task.data?.perch) {
      const landed = b.swarmPerch?.round === round && distance(b.swarmPerch.target, task.position) < 1 &&
        Math.abs(m.p.y - b.swarmPerch.at.y) <= 1 && distance(m.p, b.swarmPerch.at) <= 3
      if (distance(m.p, task.position) > 3 && !landed) {
        // Не долетел — к тому же насесту с того же места снова не лететь (повтор по причине, а не через 8 с).
        const perch = cellKey({ x: Math.floor(task.position.x), y: Math.floor(task.position.y), z: Math.floor(task.position.z) })
        // Отказ «не перелететь / негде сесть / над головой блок» — про место взлёта, а не про насест: с этого места не лететь ни к
        // какому (игра 25.10: 26 попыток к соседним насестам подряд, бот висел).
        if (!sw.blocked(b, `fly:${b.name}`, perch) && !sw.blocked(b, `flyfrom:${b.name}`)) {
          const reply = await b.c.call('fly_to', { at: task.position, timeoutSeconds: 15, arena }), r = detail(reply)
          if (!currentTurn(sw, b, round)) return
          if (reply?.code === 'RESCUE_BUSY') return
          // Ответ уже знает, где закончен полёт; округлённый старый опрос ещё может помнить место взлёта.
          const actual = r.at || reply?.state?.pos
          if (actual && [actual.x, actual.y, actual.z].every(Number.isFinite)) m.p = { ...actual }
          if (reply?.state?.inventory) m.inv = reply.state.inventory
          if (reply?.status === 'interrupted') { b.swarmFightReply = reply; cooldown.set(`fight:${b.name}`, now() + 500); return }
          log(`🪽 ${b.name}: на насест ${perch} — ${r.ok ? 'долетел' : r.why || r.error || r.status || '?'}`)
          if (r.ok) {
            // fly_to выбирает реальную опору рядом с запросом; следующий ход держит её, а не взлетает снова.
            const at = r.ground || r.at
            if (at && [at.x, at.y, at.z].every(Number.isFinite)) b.swarmPerch = { round, target: { ...task.position }, at: { ...at } }
            return
          }
          delete b.swarmPerch
          // Коротко запоминаем отказ полёта в плане: зигзаг на 2 бл. не делает тот же насест достижимым.
          board.recordFact(b.name, now(), { id: `perch-failed:${b.name}:${perch}`, kind: 'mark', position: task.position }, 15000)
          sw.failed(b, `fly:${b.name}`, perch)
          if (/перелететь|негде сесть|над головой/.test(r.why || '')) sw.failed(b, `flyfrom:${b.name}`)
        }
      } else {
        const rescue = b.webRescue
        const owns = (action, reply) => round === sw.generation && alive(b.name) && b.last === action && b.webRescue === rescue && (!b.swarmTask || b.swarmTask === task) &&
          (!reply?.status || reply.status === 'done') && reply?.code !== 'RESCUE_BUSY' && !reply?.state?.tactics?.action && !reply?.state?.tactics?.requireObservation &&
          !['Tactical', 'Emergency'].includes(reply?.state?.tactics?.owner)
        const foe = enemies.find(e => e.id === task.data.target)
        if (foe && now() - foe.seenAt < 1000 && m.inv?.bow && (m.attackArrows ?? (m.inv?.arrow || 0) + (m.inv?.spectral_arrow || 0))) {
          const before = { ...(pos[b.name]?.p || m.p) }, pending = b.c.call('peek_shot', { target: foe.id, shots: 3 }), action = b.last
          const reply = await pending, r = detail(reply)
          // Союзник видит далёкого врага, а стрелять с этого насеста нечем: отказ не заменяет еду и безопасную стойку.
          if (!owns(action, reply) || reply?.status !== 'done' || r?.ok !== false || r.fired || r.hits || r.wall || distance(pos[b.name]?.p || m.p, before) > .1) return
        }
        const meal = b.c.call('eat', { timeoutSeconds: 2 }).catch(() => null), action = b.last
        const reply = await meal
        if (!reply || !owns(action, reply)) return
        await b.c.call('swarm_hold', { sneak: true, enemies: enemies.map(e => e.id), allies: context.members.map(a => a.id), timeoutSeconds: 2, arena })
        return
      }
    }
    // Укрытие без своих (пользователь 14.10: «если своих нет — прятаться в колизее, в блоках или на высоте, и шифт
    // зажимать, чтобы мы не видели его»): дошёл — сидеть на шифте, ник за блоками не виден.
    if ((task.data?.hide || task.data?.regroup) && !enemies.length && distance(m.p, task.position) >= 3) { await go(b, task.position, 2); return }
    // Нашёл в укрытии — сначала оценить выход вниз и прорыв; близость ещё не означает, что бежать некуда.
    const atMe = task.data?.hide && enemies.find(e => now() - e.seenAt < 1000 && distance(e.position, m.p) < 6)
    if (!atMe && task.data?.hide && distance(m.p, task.position) < 3) { await b.c.call('swarm_hold', { sneak: true, enemies: enemies.map(e => e.id), allies: context.members.map(a => a.id), timeoutSeconds: 3, arena }); return }
    if (!atMe && rangedAdvantage(b)) { await b.c.call('fight', { target: task.data.target, targets: enemies.map(e => e.id), allowPlayer: true, allowRanged: true, timeoutSeconds: 3, retreatAtHealth: 8, arena }); return }
    // Погоня (kite): отрыв по открытому без точки (smartFlee сам обходит тупики), до 22 бл.; к своим — к ним.
    const outcome = detail(await b.c.call('flee', { from: enemies.map(e => e.id), toward: [...(task.data?.kite && !task.data?.regroup ? [] : [task.position]), ...context.members.filter(a => a.id !== b.name && a.health > 0).map(a => a.position)], timeoutSeconds: 3, safeDist: task.data?.kite ? 22 : 14, reason: task.data?.reason, arena }))
    if (!currentTurn(sw, b, round)) return
    if (outcome.cornered && (atMe || task.data?.target)) {
      const target = atMe?.id || task.data.target
      log(`⚔ ${b.name}: физически зажат, отвечаю ${target}`)
      await b.c.call('fight', { target, allowPlayer: true, allowRanged: true, lastStand: true, timeoutSeconds: 3, retreatAtHealth: 0, arena })
    } else if (outcome.mode === 'оторвался') {
      if (outcome.at) m.p = outcome.at
      // «Оторвался», не сделав шага: тело его не видит (стена, яма), а доска видела его рядом только что — бег смотрит только
      // на видимых и сразу отпускал, и бот стоял в 3 бл. от человека 39 с (стенд бота-противника 22.10). Уйти от места, где его
      // видели, как лут с отходом.
      const foe = enemies.filter(e => now() - e.seenAt < 3000).sort((a, c) => distance(a.position, m.p) - distance(c.position, m.p))[0]
      if (!(outcome.ran >= 1) && foe && distance(foe.position, m.p) < 14) {
        const d = Math.hypot(m.p.x - foe.position.x, m.p.z - foe.position.z) || 1
        await go(b, bounded({ x: m.p.x + (m.p.x - foe.position.x) / d * 8, y: m.p.y, z: m.p.z + (m.p.z - foe.position.z) / d * 8 }), 3, 4)
        return
      }
      // Оторвался от погони — дальше решает планировщик (лут за 22 бл.), а не поход к группе или лут исполнителя.
      if (task.data?.kite) return
      if (task.data?.hide || task.data?.regroup) { await go(b, task.position, 2); return }
      // Готовится (лут, позиция) — пока это его дело: паника не рвёт его, пока враги дальше 14 и без луков (safety.ts).
      b.swarmPreparing = true
      const looted = await loot(b, board)
      if (!currentTurn(sw, b, round) || looted) return
      const positioned = await positionStep(b, context, m.inv?.bow ? 'ranged' : 'escape')
      if (!currentTurn(sw, b, round) || positioned) return
      await search(b, context, enemies)
    }
    return
  }

  async function turnRecover (tc: TurnCtx) {
    const { b, context, task, round, m, enemies, contact } = tc
    if (task.data?.antidote) {
      const result = detail(await b.c.call('antidote', { ...task.data.antidote, allies: context.members.map(a => a.id), enemies: enemies.map(e => e.id), arena }).catch(() => ({})))
      if (!currentTurn(sw, b, round) || result.consumed) return
    }
    if (contact) {
      const out = detail(await b.c.call('flee', { from: enemies.map(e => e.id), timeoutSeconds: 3, safeDist: 14, arena }))
      if (!currentTurn(sw, b, round)) return
      if (out.mode !== 'оторвался') return
    }
    // В кольце и «стаде» место раненого — середина строя: поиск укрытия подальше уводил его из-за щитов (ревью 13.10).
    else if (['ring', 'weak-center'].includes(task.data?.doctrine)) { if (distance(m.p, task.position) > 1) await go(b, task.position, .6) }
    else {
      const positioned = await positionStep(b, context, 'recover')
      if (!currentTurn(sw, b, round)) return
      if (!positioned && distance(m.p, task.position) > 3) await go(b, task.position)
    }
    if (!currentTurn(sw, b, round)) return
    await b.c.call('eat', { timeoutSeconds: 4 }).catch(() => {})
    return
  }

  async function turnHold (tc: TurnCtx) {
    const { b, context, task, round, m, enemies } = tc
    const range = task.data.range ?? .8
    // Не дошёл до засады и не приблизился — она ему 15 с недоступна (Codex 15.10: сторож сбрасывал поход, а ход вёл туда же).
    if (distance(m.p, task.position) > range + .4) {
      const before = distance(m.p, task.position)
      const walked = detail(await go(b, task.position, range).catch(e => ({ why: e.message })))
      if (!currentTurn(sw, b, round)) return
      if (task.data.camp && !walked.arrived && distance(pos[b.name]?.p || m.p, task.position) > before - 1) sw.siteFailed(b, 'camp:' + task.data.camp)
      return
    }
    // Кемпер на месте — замуроваться (стены и крыша); раскопают — увидит врага в упор, и контакт поднимет бой.
    // Не замуровался — снова, когда пришли блоки или он на другом месте (retry.ts), а не через 10 с.
    if (task.data.camp && !task.data.ramWall && !boxed.has(`${b.name}:${task.data.camp}`) && !sw.blocked(b, `box:${b.name}`, String(blockCount(m.inv))) && blockCount(m.inv) >= 10) {
      const r = detail(await b.c.call('box_in', {}).catch(e => ({ why: e.message })))
      if (!currentTurn(sw, b, round)) return
      const tries = (boxTries.get(`${b.name}:${task.data.camp}`) || 0) + 1; boxTries.set(`${b.name}:${task.data.camp}`, tries)
      if (r.sealed || tries >= 2) boxed.add(`${b.name}:${task.data.camp}`); else sw.failed(b, `box:${b.name}`, String(blockCount(pos[b.name]?.inv || m.inv)))
      if (r.sealed) b.boxedCamp = task.data.camp
      log(`🧱 ${b.name}: кемпер замуровался у ${task.data.camp} — ${r.sealed ? `готово (${r.placed} бл., ${r.material || '?'})` : String(r.why || `стен ${r.walls ?? '?'}`).slice(0, 60)}`)
      // Коробка от тарана не встала (клетка не закрывается, нечем выйти) — с этой клетки план её не предлагает (факт на доске по клетке),
      // и не стоять на месте под ним: следующий ход — отход, как без коробки (cl29j 28.10: 4 попытки, 0 закрытых).
      if (!r.sealed && task.data.ramBox) context.board?.recordFact?.(b.name, now(), { id: `box-failed:${b.name}:${task.data.camp}`, kind: 'mark', position: task.position }, 60000)
      return
    }
    // Стенка от тарана (или коробка не встала): стенка в его сторону на месте; луч закрыт — стоять за ней на шифте, пока план не даст
    // другое дело (угроза ушла); не вышло — с этой клетки не предлагать (факт по клетке), ход — отход.
    if ((task.data.ramWall || task.data.ramBox && !b.boxedCamp) && !b.ramWallAt?.[task.data.camp]) {
      const foe = enemies.find(e => e.id === task.data.target)
      const w = foe ? detail(await b.c.call('take_cover', { from: foe.id, wall: true, fromAt: foe.position, arena }).catch(e => ({ why: e.message }))) : { why: 'цели нет' }
      if (!currentTurn(sw, b, round)) return
      log(`🧱 ${b.name}: стенка от тарана ${task.data.target} — ${w.ok ? w.how : String(w.why || '?').slice(0, 50)}`)
      if (w.ok) (b.ramWallAt ||= {})[task.data.camp] = true
      else { context.board?.recordFact?.(b.name, now(), { id: `wall-failed:${b.name}:${task.data.camp}`, kind: 'mark', position: task.position }, 60000); return }
    }
    if ((task.data.ramWall || task.data.ramBox) && !b.boxedCamp && !b.ramWallAt?.[task.data.camp]) return
    const held = await execute(b, 'swarm_hold', { camp: !!b.boxedCamp, ...(task.data.hold === 'shield' ? { shield: true, face: task.data.face, timeoutSeconds: 4 } : { sneak: true, timeoutSeconds: 2 }),
      enemies: enemies.map(e => e.id), allies: context.members.map(a => a.id), arena })
    if (!currentTurn(sw, b, round)) return
    await reactCamp(b, held)
    return
  }

  async function turnBuildSite (tc: TurnCtx) {
    const { b, context, task, round, m, enemies } = tc
    const enemy = enemies.find(e => e.id === task.data.target), o = task.data.origin
    // Кокон — пока цель в своей клетке; отсечка — пока цель ещё перед стеной (она стоит на её пути, а не вокруг неё).
    const ready = enemy && now() - enemy.seenAt <= 1000 && (task.data.buildKind === 'cutoff'
      ? distance(enemy.position, o) <= 10
      : Math.floor(enemy.position.x) === o.x && Math.floor(enemy.position.z) === o.z && Math.abs(enemy.position.y - o.y) < 1)
    // Строитель работает в шаге от цели, «контакт» его не останавливает: угрозу у клетки проверяет сама кладка (прицел
    // врага, урон) — иначе в 3.5 бл. от цели стройка не шла вовсе, а строитель уходил бродить.
    // Цель в клетке кокона заперта: её тычок сквозь щель — цена, а не повод бросать кладку (swarm_work contained).
    const contained = task.data.buildKind === 'cocoon' && ready ? [task.data.target] : []
    if (ready && await buildStep(b, context, { kind: task.data.buildKind, origin: o, direction: task.data.direction, contained })) return
    if (!currentTurn(sw, b, round)) return
    // Класть пока нечего (клетки у другого, крыша ждёт стен) — стоять у стройки, а не бродить. Но не в коробке кокона:
    // строитель, доложивший свои клетки, стоял в щели и закрывал телом последнюю клетку крыши (лаборатория 14.10, 22/23).
    const site = { x: o.x + .5, y: o.y, z: o.z + .5 }
    const inBox = task.data.buildKind === 'cocoon' && m.p.y < o.y + 3 && [['x', o.x], ['z', o.z]].every(([k, c]: any) => m.p[k] + .3 > c - 1 && m.p[k] - .3 < c + 2)
    const away = Math.hypot(m.p.x - site.x, m.p.z - site.z)
    if (inBox) await go(b, away > .1 ? { x: site.x + (m.p.x - site.x) / away * 3.2, y: o.y, z: site.z + (m.p.z - site.z) / away * 3.2 } : { x: site.x + 3.2, y: o.y, z: site.z }, .8)
    else if (distance(m.p, site) > 5) await go(b, site, 3)
    else await b.c.call('swarm_hold', { sneak: true, timeoutSeconds: 1, enemies: enemies.map(e => e.id), allies: context.members.map(a => a.id), arena })
    return
  }

  return { turnFlee, turnRecover, turnHold, turnBuildSite }
}
