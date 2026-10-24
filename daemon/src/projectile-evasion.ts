// Короткая примесь к клавишам дела: цель, путь и владелец рук остаются прежними.
import * as clock from './game-clock'
import { keyDir } from './moves'
import { stepSafe } from './pvp/body'
import { projectileDangers } from './threats'
import { observeCharge } from './bow/charge'

export function install (session, free) {
  const bot = session.bot
  if (!bot || bot._ndProjectileEvasion || typeof bot.setControlState !== 'function' || typeof bot.getControlState !== 'function') return
  const keys = ['forward', 'back', 'left', 'right', 'jump', 'sprint', 'sneak']
  const wanted = Object.fromEntries(keys.map(k => [k, !!bot.getControlState(k)]))
  const raw = bot.setControlState.bind(bot), activate = bot.activateItem?.bind(bot), deactivate = bot.deactivateItem?.bind(bot)
  let mix: Record<string, boolean> = {}, closed = false, shield: any = null, memo: any = null, stamp = -Infinity, guard: any, ownUse = false
  // Ждёт толчка стрелой своего (combat/arrow-boost) — сам встал под выстрел: шаг с линии сорвёт разгон.
  const enabled = () => !closed && session.bot === bot && !!bot.entity && (bot.health ?? 20) > 0 && !session.current?.ctl?.aborted && !bot._ndBoostFrom && free()
  const observe = () => {
    const now = clock.now()
    if (stamp === now && memo) return memo
    stamp = now
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
  const forget = () => { shield?.charge.close(); shield = null }
  // Чужое использование предмета отбирает только наш щит; поздний конец уворота не опускает еду или лук дела.
  if (activate) bot.activateItem = (...args) => { if (!ownUse) forget(); return activate(...args) }
  if (deactivate) bot.deactivateItem = (...args) => { forget(); return deactivate(...args) }
  const restore = () => { const old = mix; mix = {}; for (const k of Object.keys(old)) raw(k, wanted[k]) }
  bot.setControlState = (key, value) => {
    wanted[key] = value
    if (!enabled()) { restore(); forget() }
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
    return [-half, half].every(x => [-half, half].every(z => bot.blockAt(p.offset(x, -1, z).floored())?.boundingBox === 'block'))
  }
  const tick = () => {
    try {
      if (!enabled()) { restore(); return }
      const d = observe(), shot = [...d.arrows, ...d.potions].filter(p => p.ticks <= 12).sort((a, b) => a.ticks - b.ticks)[0]
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
      const shieldShot = d.arrows.find(p => p.blockable && p.ticks <= 12 && p.from &&
        -(p.from.x - me.x) * Math.sin(bot.entity.yaw) - (p.from.z - me.z) * Math.cos(bot.entity.yaw) > 0)
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
      const next: Record<string, boolean> = {}
      // Полёт, прыжок пути и спасение ведут свою физику; на узком столбе остаётся щит, а не шаг в пустоту.
      if (threat && bot.entity.onGround && !bot.entity.elytraFlying && !bot.vehicle && !wanted.sneak && !wanted.jump) {
        const source = threat.from || threat.at
        const dx = me.x - source.x, dz = me.z - source.z, len = Math.hypot(dx, dz) || 1
        const away = !threat.side && threat.at && me.minus(threat.at)
        const side = threat.side || (away && Math.hypot(away.x, away.z) > .1
          ? { x: away.x / Math.hypot(away.x, away.z), z: away.z / Math.hypot(away.x, away.z) } : { x: -dz / len, z: dx / len })
        const flip = shot ? 1 : Math.floor(now / 300) % 2 ? 1 : -1
        let best: any = null
        for (const key of ['left', 'right']) {
          const sideways = keyDir(bot, key), input = { ...wanted, left: key === 'left', right: key === 'right' }, dir = vector(input)
          if (!safe(sideways) || !safe(dir)) continue
          const score = (sideways.x * side.x + sideways.z * side.z) * flip
          if (!best || score > best.score) best = { key, dir, score }
        }
        if (best) {
          next.left = best.key === 'left'; next.right = best.key === 'right'
          // Когда линия идёт поперёк пути, боковой ключ почти не помогает: безопасный рывок вдоль пути быстрее пересекает её.
          if (shot && Math.abs(best.score) < .25 && wanted.forward && !wanted.back && safe(best.dir, 1.5)) {
            next.sprint = true
          }
        }
      }
      const old = mix; mix = next
      for (const k of new Set([...Object.keys(old), ...Object.keys(next)])) raw(k, mix[k] ?? wanted[k])
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
  const reset = () => { mix = {}; stamp = -Infinity; memo = null; for (const k of keys) { wanted[k] = false; raw(k, false) }; release() }
  bot.on('death', reset)
  bot.once('end', () => { closed = true; bot.removeListener('physicTick', tick); bot._client?.removeListener?.('set_cooldown', cooldown); reset() })
}
