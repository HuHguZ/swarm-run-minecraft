// Короткая примесь к клавишам дела: цель, путь и владелец рук остаются прежними.
import * as clock from './game-clock'
import { keyDir } from './moves'
import { stepSafe } from './pvp/body'
import { projectileDangers, incomingGliders } from './threats'
import { observeCharge } from './bow/charge'
import { shapeBoxes } from './navigation/geometry'
import * as spear from './spear'
import { seesPlayer } from './pvp/last-seen'
import { gliding } from './elytra/track'

export function install (session, free) {
  const bot = session.bot
  if (!bot || bot._ndProjectileEvasion || typeof bot.setControlState !== 'function' || typeof bot.getControlState !== 'function') return
  const keys = ['forward', 'back', 'left', 'right', 'jump', 'sprint', 'sneak']
  const wanted = Object.fromEntries(keys.map(k => [k, !!bot.getControlState(k)]))
  const raw = bot.setControlState.bind(bot), activate = bot.activateItem?.bind(bot), deactivate = bot.deactivateItem?.bind(bot)
  const reportedGliders = new Set<number>()
  let brace: any = null, equipping = false
  const seen = new Map<number, { x: number, y: number, z: number, t: number }>()
  let mix: Record<string, boolean> = {}, closed = false, shield: any = null, memo: any = null, memoBoost: any, stamp = -Infinity, guard: any, ownUse = false
  // Прогноз исключает только ожидаемые стрелы своих; чужая угроза остаётся угрозой во время разгона.
  const enabled = () => !closed && session.bot === bot && !!bot.entity && (bot.health ?? 20) > 0 && !session.current?.ctl?.aborted &&
    !bot._ndHandLock?.on?.() && !(bot._ndElytra?.driving > 0) && !bot._ndElytra?.boundaryReturn && free()
  const observe = () => {
    const now = clock.now()
    if (stamp === now && memo && memoBoost === bot._ndBoostFrom) return memo
    stamp = now
    memoBoost = bot._ndBoostFrom
    guard = undefined
    const d = projectileDangers(bot, { foes: session._ndFoes ?? null })
    // Тот же наблюдаемый выстрел скелета до первого пакета стрелы; срок уже считает существующая баллистика.
    if (bot.game?.dimension === 'overworld') {
      const g = (require('./ow-shield') as typeof import('./ow-shield')).rangedGuard(bot,
        (Object.values(bot.entities || {}) as any[]).filter(e => e !== bot.entity && !e.username), [])
      if (g && /bow/.test(g.kind)) {
        guard = g
        const dx = bot.entity.position.x - g.point.x, dz = bot.entity.position.z - g.point.z, n = Math.hypot(dx, dz) || 1
        return (memo = { ...d, aims: d.aims.length ? d.aims : [{ id: g.id, name: String(g.id), weapon: 'bow', at: g.point, side: { x: -dz / n, z: dx / n } }] })
      }
    }
    return (memo = d)
  }
  const release = () => {
    const mine = shield; shield = null
    mine?.charge.close()
    if (mine && bot.inventory?.slots?.[45]?.name === 'shield' && (!bot._ndUse?.cur || bot._ndUse.cur === mine.use)) deactivate?.()
  }
  // ND_GLIDER_TRACE: кто сбросил наше копьё чужим use (первый кадр вне этого файла и обёрток) — в трассу.
  let forgotBy: string | null = null
  const forget = () => { if (brace && traceOn) forgotBy = (new Error().stack || '').split('\n').slice(2).find(l => !/projectile-evasion|itemuse|reflex-lock|node:/.test(l))?.trim().replace(/^at /, '').replace(/\(.*[\\/]/, '(').slice(0, 80) || '?'
    shield?.charge.close(); shield = null; brace?.charge.close(); brace = null }
  const lower = () => { const mine = brace; brace = null; if (!mine) return; mine.charge.close(); if (bot._ndUse?.cur === mine.use || !bot._ndUse?.cur && spear.isSpear(bot.heldItem?.name)) deactivate?.() }
  // Чужое использование предмета отбирает только наш щит; поздний конец уворота не опускает еду или лук дела.
  if (activate) bot.activateItem = (...args) => { if (!ownUse) forget(); return activate(...args) }
  if (deactivate) bot.deactivateItem = (...args) => { forget(); return deactivate(...args) }
  const restore = () => { const old = mix; mix = {}; for (const k of Object.keys(old)) raw(k, wanted[k]) }
  bot.setControlState = (key, value) => {
    wanted[key] = value
    // Пауза рефлекса (замок руки, смена дела) — клавиши у другого, отдаём только щит; копьё в use остаётся нашим (cl51: забытое, но
    // поднятое копьё не наводилось и не поднималось заново — 1146 сбросов clearControlStates за 2 раунда). Чужой use — activateItem выше.
    if (!enabled()) { restore(); shield?.charge.close(); shield = null }
    return raw(key, mix[key] ?? value)
  }
  const vector = inputs => {
    let x = 0, z = 0
    for (const k of ['forward', 'back', 'left', 'right']) if (inputs[k]) { const d = keyDir(bot, k); x += d.x; z += d.z }
    const n = Math.hypot(x, z) || 1
    return { x: x / n, z: z / n }
  }
  const safe = (d, reach = .9) => {
    if (!stepSafe(bot, d, { reach })) return false
    // Уворот не меняет этаж пути: даже разрешённый боем спуск на три блока здесь сорвал бы подъём.
    const p = bot.entity.position.offset(d.x * reach, 0, d.z * reach)
    const half = bot.physics?.playerHalfWidth || .3
    // На нижней плите опора в клетке ног; целый блок ниже уже может быть воздух.
    return [-half, half].every(x => [-half, half].every(z => {
      const corner = p.offset(x, -1e-7, z), cell = corner.floored(), block = bot.blockAt(cell)
      return block && shapeBoxes(block, cell).some(box => Math.abs(box.maxY - p.y) <= 1e-7 &&
        corner.x >= box.minX && corner.x <= box.maxX && corner.z >= box.minZ && corner.z <= box.maxZ)
    }))
  }
  // ND_GLIDER_TRACE=1: последние 2 с ближнего врага-летуна и почему рефлекс молчал — в журнал демона при смерти (28.10, разбор таранов).
  const trace: any[] = [], traceOn = process.env.ND_GLIDER_TRACE === '1'
  const note = (why: string, gliders: any[] = []) => {
    if (!traceOn || !bot.entity) return
    const me = bot.entity.position, foes = session._ndFoes ?? null
    const near = (Object.values(bot.entities || {}) as any[]).filter(e => e?.type === 'player' && e !== bot.entity && e.position && (e.elytraFlying || (e.metadata?.[0] & 0x80)) && (!foes || foes.includes(e.username)))
      .map(e => {
        // Угол между взглядом и направлением на него (центр рамки) — попадёт ли встречное копьё (луч 2–4.5 бл. от глаз).
        const eye = me.offset(0, 1.62, 0), dx = e.position.x - eye.x, dy = e.position.y + .3 - eye.y, dz = e.position.z - eye.z, n = Math.hypot(dx, dy, dz) || 1
        const yaw = bot.entity.yaw, pitch = bot.entity.pitch, lx = -Math.sin(yaw) * Math.cos(pitch), ly = Math.sin(pitch), lz = -Math.cos(yaw) * Math.cos(pitch)
        return { n: e.username, d: +e.position.distanceTo(me).toFixed(1), a: Math.round(Math.acos(Math.max(-1, Math.min(1, (dx * lx + dy * ly + dz * lz) / n))) * 180 / Math.PI) }
      }).sort((a, c) => a.d - c.d)[0]
    if (!near || near.d > 32) return
    trace.push({ t: clock.now(), why, ...near, g: bot.entity.onGround, j: !!wanted.jump, th: gliders[0] ? gliders[0].kind + ':' + gliders[0].ticks : null, b: brace ? (brace.ackAt !== undefined && clock.now() - brace.ackAt >= brace.delay * 50 ? 'R' : brace.ackAt !== undefined ? 'a' : 'r') + (brace.charge.why() || '') : equipping ? 'e' : '-', h: bot.heldItem?.name, u: bot._ndUse?.cur?.name || null, ...(forgotBy ? { fg: forgotBy } : {}), c: session.current?.name || null })
    while (trace.length > 40) trace.shift()
  }
  const tick = () => {
    try {
      if (!enabled()) { note('off'); restore(); return }
      // Поднятое готовое копьё ведёт взгляд и в прыжке пути (cl28q: копьё готово, бот прыгал по пути — угрозу не спрашивали, таран).
      const ready0 = !!brace && brace.ackAt !== undefined && clock.now() - brace.ackAt >= brace.delay * 50
      const d = observe(), gliders = (bot.entity.onGround && !wanted.jump && !wanted.sneak || ready0) && !bot.entity.elytraFlying && !bot.vehicle
        ? incomingGliders(bot, { foes: session._ndFoes ?? null }) : []
      note(bot.entity.onGround && !wanted.jump && !wanted.sneak ? 'poll' : 'skip', gliders)
      for (const id of reportedGliders) if (!gliders.some(g => g.id === id)) reportedGliders.delete(id)
      const shot = [...d.arrows, ...d.potions, ...gliders].filter(p => p.ticks <= 12).sort((a, b) => a.ticks - b.ticks)[0]
      const threat = shot || d.aims[0], now = clock.now(), me = bot.entity.position
      if (shield && (now >= shield.until || shield.charge.why())) release()
      // На меня натянут лук, а щит в рюкзаке — в левую руку (игра пользователя 25.10: у 7 из 13 живых щит в рюкзаке, рефлекс
      // ниже его не видел, лук «Сила V» убивал за 2–3 стрелы). Тотем при хп ≤ 16 остаётся (как combat/shield.ts).
      const off = bot.inventory?.slots?.[45]?.name
      if (d.aims.length && off !== 'shield' && !(off === 'totem_of_undying' && (bot.health ?? 20) <= 16) && !bot._ndShieldEquip &&
          !bot.currentWindow && !session.armorBusy && !bot._ndUse?.cur && !bot.usingHeldItem) {
        const sh = bot.inventory.items().find(i => i.name === 'shield')
        if (sh) { bot._ndShieldEquip = true; Promise.resolve(bot.equip(sh, 'off-hand')).catch(() => {}).finally(() => { bot._ndShieldEquip = false }) }
      }
      const shieldShot = [...d.arrows, ...gliders].filter(p => p.blockable && p.ticks <= 12 &&
        (p.name !== 'glider' || p.ticks >= 6 || shield) && p.from &&
        -(p.from.x - me.x) * Math.sin(bot.entity.yaw) - (p.from.z - me.z) * Math.cos(bot.entity.yaw) > 0)
        .sort((a, b) => a.ticks - b.ticks)[0]
      // Лук натянут на меня спереди — щит заранее и держать, пока целится: подъём щита — 5 тиков, а стрела «Силы V» с 20 бл.
      // летит 6–7, ответ на летящую не успевал (игра пользователя 25.10). Сзади — уворот, как раньше.
      const front = q => !!q && -(q.x - me.x) * Math.sin(bot.entity.yaw) - (q.z - me.z) * Math.cos(bot.entity.yaw) > 0
      const aimed = d.aims.find(a => front(a.at) && Math.hypot(a.at.x - me.x, a.at.z - me.z) <= 40)
      const guardFor = shieldShot ? shieldShot.ticks + 2 : aimed ? 6 : 0
      if (guardFor && bot.inventory?.slots?.[45]?.name === 'shield' && now >= (bot._ndShieldDisabledUntil || 0)) {
        if (shield) shield.until = Math.max(shield.until, now + guardFor * 50)
        else if (activate && !bot._ndUse?.cur && !bot.usingHeldItem && !bot.currentWindow && !session.armorBusy) {
          const charge = observeCharge(bot, { item: 'shield', hand: 'off-hand' })
          ownUse = true
          try {
            if (charge.start()) shield = { charge, until: now + guardFor * 50, use: bot._ndUse?.cur }
          } finally { ownUse = false; if (shield?.charge !== charge) charge.close() }
        }
      }
      // Встречное копьё (28.10, 15×15: тараны копьём с элитр — почти все убийства, щитов в наборе нет, копьё у всех): враг-летун
      // в виду идёт на меня — копьё на изготовку заранее. Механика jar 1.21.11: копьё в use — UseEffects(можно бежать, скорость ×1),
      // урон KineticWeapon после задержки (алмазное 10 т.) всё окно урона, rel = его скорость ко мне: на 30 бл/с — 1 + ⌊30·1.075⌋ = 33.
      // На подлёте (угроза ≤ 20 т.) — взгляд на него вместо шага: копьё бьёт по лучу 2–4.5 бл. от глаз. Бой ведёт свой skyDefenseTurn.
      // Ближе пути летуна за подъём копья (2 бл/т — средняя скорость элитр, пике до 4; × задержка + 2 т. подтверждения) курс не важен:
      // кружащий в 8–20 бл. пикирует за 3–6 т., быстрее задержки (cl46tr: 6 из 12 наземных смертей от тарана — копьё в руке, не поднято).
      // Окно урона копья ~11 с (delay + dmgWin, spear.ts) — поднять раньше почти ничего не стоит.
      const held = spear.spearOf(bot), dive = held ? 2 * (Math.round(held.spec.delay * 20) + 2) : 0
      const approach = (() => {
        let best: any = null
        for (const raw of Object.values(bot.entities || {}) as any[]) {
          if (!raw || raw === bot.entity || raw.type !== 'player' || !raw.position || !gliding(raw)) { if (raw?.id !== undefined) seen.delete(raw.id); continue }
          const foes = session._ndFoes ?? null
          if (foes !== null && !foes.includes(raw.username) || (bot._ndSwarmAllies || []).includes(raw.username)) continue
          const d = raw.position.distanceTo(me), was = seen.get(raw.id)
          seen.set(raw.id, { x: raw.position.x, y: raw.position.y, z: raw.position.z, t: now })
          if (d > 40 || !was || now - was.t > 200 || now === was.t) continue
          const k = 50 / (now - was.t), v = { x: (raw.position.x - was.x) * k, y: (raw.position.y - was.y) * k, z: (raw.position.z - was.z) * k }
          const sp = Math.hypot(v.x, v.y, v.z), to = { x: (me.x - raw.position.x) / d, y: (me.y + 1 - raw.position.y) / d, z: (me.z - raw.position.z) / d }
          if (sp < .5 || d > dive && (v.x * to.x + v.y * to.y + v.z * to.z) < .7 * sp || !seesPlayer(bot, raw)) continue
          if (!best || d < best.d) best = { raw, d, v }
        }
        return best
      })()
      // Вне боя — при ходьбе, в прыжке пути и в паутине (оттуда не уйти — копьё единственная защита; резку оно прерывает): бой ведёт свой skyDefenseTurn,
      // полёт и броски (облёт, fly_to, ветер, жемчуг) держат руку сами.
      const fighting = !!session.current?.name && !/^(goto|flee|swarm_hold|assist|follow|center_in|take_cover|clear_web)$/.test(session.current.name)
      if (brace && (brace.charge.why() || fighting || !approach && now - brace.seenAt > 1000 || now - brace.since > brace.window)) lower()
      if (brace && approach) brace.seenAt = now
      const lance = !shield && bot.inventory?.slots?.[45]?.name !== 'shield' && !fighting && approach && !bot.entity.elytraFlying && held
      if (lance && !brace && !bot._ndUse?.cur && !bot.usingHeldItem && !bot.currentWindow && !session.armorBusy && !bot._ndShieldEquip) {
        if (bot.heldItem?.name !== lance.item.name) {
          if (!equipping) { equipping = true; Promise.resolve(bot.equip(lance.item, 'hand')).catch(() => {}).finally(() => { equipping = false }) }
        } else if (!equipping && activate && spear.teamSafe(bot)) {
          const charge = observeCharge(bot, { item: lance.item.name, hand: 'hand' })
          ownUse = true
          try {
            if (charge.start()) bot.emit('nd_guard_reflex', { source: 'glider_brace_up', id: approach.raw.id, d: +approach.d.toFixed(1), during: session.current?.name || null, how: 'raise' })
            if (bot._ndUse?.cur) brace = { charge, use: bot._ndUse?.cur, since: now, seenAt: now, delay: Math.round(lance.spec.delay * 20), window: (lance.spec.delay + lance.spec.dmgWin) * 1000, name: lance.item.name }
          } finally { ownUse = false; if (brace?.charge !== charge) charge.close() }
        }
      }
      const glide = gliders.find(g => g.ticks <= 20)
      // Готовность — от подтверждённого сервером начала use (метаданные), по своим часам: тиков мира из update_time (раз в 20 т.)
      // окно в 10 т. копья не увидеть (cl28p: копьё поднято, «готово» не наступило ни разу за 1.5+ с).
      if (brace && brace.ackAt === undefined && brace.charge.ready(0)) brace.ackAt = now
      const armed = (b: any) => !!b && b.ackAt !== undefined && now - b.ackAt >= b.delay * 50
      const braced = !!glide && armed(brace)
      if (braced) {
        const q = { x: glide.from.x + glide.vel.x, y: glide.from.y + glide.vel.y + .3, z: glide.from.z + glide.vel.z }, eye = me.offset(0, 1.62, 0)
        const yaw = Math.atan2(-(q.x - eye.x), -(q.z - eye.z)), pitch = Math.atan2(q.y - eye.y, Math.hypot(q.x - eye.x, q.z - eye.z))
        if (spear.teamSafe(bot, yaw, pitch)) bot.look?.(yaw, pitch, true)?.catch?.(() => {})
      } else if (brace && approach) {
        // До подлёта — только наклон к нему, курс пути прежний (ходьба идёт по рысканью): луч копья не вдоль пути, где свои, — сторож
        // союзника не снимает use (cl28w–z: «готовое» копьё опускалось за 12 бл. до тарана), и наконечник уже на его высоте.
        const eye = me.offset(0, 1.62, 0), q = approach.raw.position
        const pitch = Math.atan2(q.y + .3 - eye.y, Math.hypot(q.x - eye.x, q.z - eye.z)), yaw = bot.entity.yaw
        if (spear.teamSafe(bot, yaw, pitch)) bot.look?.(yaw, pitch, true)?.catch?.(() => {})
      }
      const next: Record<string, boolean> = {}
      // Полёт, прыжок пути и спасение ведут свою физику; на узком столбе остаётся щит, а не шаг в пустоту.
      if (threat && !(braced && threat === glide) && bot.entity.onGround && !bot.entity.elytraFlying && !bot.vehicle && !wanted.sneak && !wanted.jump) {
        const source = threat.from || threat.at
        const dx = me.x - source.x, dz = me.z - source.z, len = Math.hypot(dx, dz) || 1
        const away = !threat.side && threat.at && me.minus(threat.at)
        const side = threat.side || (away && Math.hypot(away.x, away.z) > .1
          ? { x: away.x / Math.hypot(away.x, away.z), z: away.z / Math.hypot(away.x, away.z) } : { x: -dz / len, z: dx / len })
        const flip = shot ? 1 : Math.floor(now / 300) % 2 ? 1 : -1
        let best: any = null
        for (const key of ['left', 'right', ...(!wanted.forward && !wanted.back ? ['forward', 'back'] : [])]) {
          const axis = key === 'left' || key === 'right' ? ['left', 'right'] : ['forward', 'back']
          const sideways = keyDir(bot, key), input = { ...wanted, [axis[0]]: key === axis[0], [axis[1]]: key === axis[1] }, dir = vector(input)
          if (!safe(sideways) || !safe(dir)) continue
          const actual = axis[0] === 'forward' ? dir : sideways
          const score = (actual.x * side.x + actual.z * side.z) * flip
          // Взгляд поперёк выстрела: left/right идут вдоль луча. Другую ось берём только полезнее прежнего шага.
          if (axis[0] === 'forward' && score <= Math.max(0, best?.score ?? 0)) continue
          if (!best || score > best.score) best = { key, dir, score, axis }
        }
        if (best) {
          for (const key of best.axis) next[key] = key === best.key
          // Когда линия идёт поперёк пути, боковой ключ почти не помогает: безопасный рывок вдоль пути быстрее пересекает её.
          if (shot && Math.abs(best.score) < .25 && wanted.forward && !wanted.back && safe(best.dir, 1.5)) {
            next.sprint = true
          }
        }
      }
      const old = mix; mix = next
      for (const k of new Set([...Object.keys(old), ...Object.keys(next)])) raw(k, mix[k] ?? wanted[k])
      if (braced && !reportedGliders.has(glide.id)) {
        reportedGliders.add(glide.id)
        bot.emit('nd_guard_reflex', { source: 'incoming_glider', id: glide.id, eta: glide.ticks, during: session.current?.name || null, how: 'spear' })
      }
      const shielded = shield && shieldShot?.name === 'glider'
      const response = shielded ? shieldShot : shot?.name === 'glider' &&
        Object.keys(next).some(k => k !== 'sprint' && next[k] && !wanted[k] && bot.getControlState(k)) ? shot : null
      if (response && !reportedGliders.has(response.id)) {
        reportedGliders.add(response.id)
        bot.emit('nd_guard_reflex', { source: 'incoming_glider', id: response.id, eta: response.ticks,
          during: session.current?.name || null, how: shielded ? 'shield' : 'step' })
      }
    } catch { restore(); if (enabled()) release() }
  }
  Object.defineProperty(tick, '_ndLatePacketAim', { value: true })
  bot._ndProjectileEvasion = {
    get pressure () { try { if (closed || !bot.entity) return false; const d = observe(); return !!(d.arrows.length || d.aims.length || d.potions.length) } catch { return false } },
    get guard () { try { if (!closed && bot.entity) { observe(); return guard } } catch {} }
  }
  bot.on('physicTick', tick)
  const cooldown = p => { if (String(p.cooldownGroup || '').split(':').pop() === 'shield' && p.cooldownTicks > 0)
    bot._ndShieldDisabledUntil = Math.max(bot._ndShieldDisabledUntil || 0, clock.now() + p.cooldownTicks * 50) }
  bot._client?.on?.('set_cooldown', cooldown)
  const reset = () => { mix = {}; stamp = -Infinity; memo = null; reportedGliders.clear(); seen.clear(); for (const k of keys) { wanted[k] = false; raw(k, false) }; release(); brace?.charge.close(); brace = null }
  bot.on('death', reset)
  if (traceOn) bot.on('death', () => { if (trace.length) console.log('[glider-trace]', JSON.stringify(trace.splice(0))) })
  bot.once('end', () => { closed = true; bot.removeListener('physicTick', tick); bot._client?.removeListener?.('set_cooldown', cooldown); reset() })
}
