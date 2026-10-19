'use strict'
// Кристаллы (crystal.ts): наблюдение — появление и пропажа кристаллов, взрывы (окна неуязвимости, счёт размена),
// «попы» тотемов, урон, якоря по blockUpdate; слушатели ставятся при создании, close() их снимает.

import { Vec3 } from './geometry'
import { P, IFRAME_MS, r1 } from './geometry'
import { effHp } from './scoring'
import type { CrystalDeps, CrystalState } from './state'

function createObserver (S: CrystalState, deps: CrystalDeps) {
  const { bot, st, enemy, used, telemetryHp, mine, exploded, winUpdate, anchorsAt, myAnchorCells, crystalSeen, anchorSeen, cellKey } = S
  const { gameClock, boom, DEBUG } = deps
  const gone = []
  const onGone = (e) => {
    try {
      if (!e || e.name !== 'end_crystal' || !e.position) return
      gone.push({ id: e.id, pos: e.position.clone(), at: gameClock.now() })
      while (gone.length > 30) gone.shift()
    } catch {}
  }
  // Когда кристалл появился: его подрыв «сразу» (≤ 6 тиков — поставил и ударил) от него не уйти, «потом»
  // (заранее в моё окно, стрелой издалека) — уклонению время есть. Счёт уклонений — по обоим.
  const spawnAt = new Map()
  const onSpawn = (e) => {
    try {
      if (!e || e.name !== 'end_crystal') return
      spawnAt.set(e.id, gameClock.now())
      if (spawnAt.size > 60) spawnAt.delete(spawnAt.keys().next().value)
      if (!mine.has(e.id)) {
        const foe = enemy()
        if (foe && foe.position && e.position.distanceTo(foe.position) < 6 && crystalSeen(e)) S.sawHis = gameClock.now()
      }
    } catch {}
  }
  // Его окно и от удара рукой: сырой крит мечом с «Остротой» ~13 — кристалл
  // (40–75 сырого) пройдёт разницей; взрыв ставит окно сам (onExplosion).
  const onHurt = (e) => {
    try {
      const foe = enemy()
      const now = gameClock.now()
      if (bot.entity && e && e.id === bot.entity.id) S.myHurtAt = now
      else if (foe && e && e.id === foe.id) {
        S.hisHurtAt = now
        const boomNow = exploded.length && now - exploded[exploded.length - 1].at < 120
        if (!boomNow && !(S.hisWin && now - S.hisWin.at < IFRAME_MS)) S.hisWin = { at: now, raw: 13 }
      }
    } catch {}
  }
  // Взрыв: чей кристалл (сущность ещё в мире — пакет взрыва приходит раньше
  // remove_entities), сырой удар мне и ему по модели — окна неуязвимости; урон
  // и «поп» — за 400 мс после.
  const onExplosion = (pkt) => {
    try {
      const c = pkt && pkt.center
      // Якорь (сила 5): счёт и окна неуязвимости; остальное — только кристаллы.
      if (c && pkt.radius > 4.5 && pkt.radius < 5.5) {
        st.anchorSeen = (st.anchorSeen || 0) + 1
        const at5 = new Vec3(c.x, c.y, c.z)
        const f5 = enemy()
        const now5 = gameClock.now()
        if (bot.entity) { const m = boom.blast(bot, at5, 5, bot.entity.position, { def: boom.defenseOf(bot, bot.entity) }); if (m.raw > 1.01) S.myWin = winUpdate(S.myWin, now5, m.raw) }
        if (f5 && f5.position) { const h = boom.blast(bot, at5, 5, f5.position, { def: boom.defenseOf(bot, f5) }); if (h.raw > 1.01) S.hisWin = winUpdate(S.hisWin, now5, h.raw) }
        // Счёт якорей (телеметрия, точное хп): мой клик по этой клетке за 600 мс — мой подрыв (свой якорь или
        // его, сбитый первым); иначе — его подрыв у меня: прогноз при полной видимости и что пришло.
        const k5 = cellKey(new Vec3(Math.floor(c.x), Math.floor(c.y), Math.floor(c.z)))
        const own5 = !!(S.anchorClick && S.anchorClick.key === k5 && now5 - S.anchorClick.at < 600)
        const his0 = f5 && f5.position ? telemetryHp(f5) : null
        const my0 = bot.entity ? effHp(bot, bot.entity) : 0
        let thr5 = 0
        if (!own5 && bot.entity) { try { thr5 = boom.blast(bot, at5, 5, bot.entity.position, { def: boom.defenseOf(bot, bot.entity), seen: 1 }).dmg } catch {} }
        gameClock.setTimeout(() => {
          try {
            const popHim = pops.some(p => p.who === 'him' && p.at >= now5 - 150 && p.at <= now5 + 400)
            const popMe = pops.some(p => p.who === 'me' && p.at >= now5 - 150 && p.at <= now5 + 400)
            const f = enemy()
            const my1 = effHp(bot, bot.entity)
            if (own5) {
              const his1 = f && f.isValid !== false ? telemetryHp(f) : 0
              if (his0 != null && (popHim || his1 != null)) (st.anchorDealt = st.anchorDealt || []).push(r1(popHim ? Math.max(0, his0) : Math.max(0, his0 - his1)))
              st.anchorSelf = r1((st.anchorSelf || 0) + (popMe ? my0 : Math.max(0, my0 - my1)))
              if (popMe) st.anchorSelfPops = (st.anchorSelfPops || 0) + 1
            } else if (thr5 >= 4) {
              const took = popMe ? my0 : Math.max(0, my0 - my1)
              st.anchorThreats = (st.anchorThreats || 0) + 1
              st.anchorThreatMax = r1((st.anchorThreatMax || 0) + thr5)
              st.anchorThreatTaken = r1((st.anchorThreatTaken || 0) + took)
              if (took <= Math.max(1.5, thr5 * 0.25)) st.anchorEvaded = (st.anchorEvaded || 0) + 1
            }
          } catch {}
        }, 400)
        return
      }
      if (!c || !(pkt.radius > 5.5 && pkt.radius < 6.5)) return
      const at = new Vec3(c.x, c.y, c.z)
      // Сущность снята раньше пакета взрыва (remove → ClientboundRemoveEntities
      // сразу, взрыв — после explode): ищем и среди только что снятых.
      let ent = null
      for (const e of ((Object.values(bot.entities) as any[]) as any)) if (e && e.name === 'end_crystal' && e.position && e.position.distanceTo(at) < 0.2) { ent = e; break }
      if (!ent) { const g = gone.find(x => gameClock.now() - x.at < 1000 && x.pos.distanceTo(at) < 0.2); if (g) ent = { id: g.id } }
      const rec = ent && mine.get(ent.id)
      const age = ent && spawnAt.has(ent.id) ? gameClock.now() - spawnAt.get(ent.id) : null
      const own = !!(rec && rec.hitAt && gameClock.now() - rec.hitAt < 600)
      st.booms++
      if (own) st.mine++; else st.his++
      const foe = enemy()
      const cache = new Map()
      const now = gameClock.now()
      if (bot.entity) {
        const m = boom.blast(bot, at, P, bot.entity.position, { def: boom.defenseOf(bot, bot.entity), cache })
        if (m.raw > 1.01) S.myWin = winUpdate(S.myWin, now, m.raw)
      }
      let hisBefore = null
      if (foe && foe.position) {
        const h = boom.blast(bot, at, P, foe.position, { def: boom.defenseOf(bot, foe), cache })
        if (h.raw > 1.01) S.hisWin = winUpdate(S.hisWin, now, h.raw)
        hisBefore = telemetryHp(foe)
      }
      const myBefore = effHp(bot, bot.entity)
      // Его подрыв рядом со мной: что дал бы при полной видимости (без щита и укрытия).
      let threat = 0
      if (!own && bot.entity) { try { threat = boom.blast(bot, at, P, bot.entity.position, { def: boom.defenseOf(bot, bot.entity), seen: 1 }).dmg } catch {} }
      const ev: any = { at: now, center: at, own, hisBefore, myBefore, popHim: false, popMe: false, threat, slow: age != null && age > 300 }
      exploded.push(ev)
      while (exploded.length > 40) exploded.shift()
      gameClock.setTimeout(() => {
        try {
          // «Поп» тотема (событие 35) сервер шлёт из hurtServer — РАНЬШЕ пакета
          // взрыва (ServerLevel.explode: explode(), потом ClientboundExplode).
          const popAt = (who) => pops.some(p => p.who === who && p.at >= ev.at - 150 && p.at <= ev.at + 400)
          ev.popHim = popAt('him')
          ev.popMe = popAt('me')
          if (ev.popHim && own) st.popsDealt++
          if (ev.popMe && !own) st.popsTaken++
          const f = enemy()
          const hisAfter = f && f.isValid !== false ? telemetryHp(f) : 0
          const myAfter = effHp(bot, bot.entity)
          if (own) {
            const dealt = hisBefore == null || (!ev.popHim && hisAfter == null) ? null : ev.popHim ? Math.max(0, hisBefore) : Math.max(0, hisBefore - hisAfter)
            if (dealt != null) st.dealt.push(r1(dealt))
            const self = ev.popMe ? myBefore : Math.max(0, myBefore - myAfter)
            st.self = r1(st.self + self)
            if (DEBUG) console.log('[crystal] мой взрыв:', JSON.stringify({ dealt: dealt == null ? null : r1(dealt), self: r1(self), popHim: ev.popHim, popMe: ev.popMe }))
          }
          // Всё, что пришло от его подрывов (и тех, от которых ушёл дальше «угрозы»): урон на его подрыв.
          if (!own) st.hisTaken = r1((st.hisTaken || 0) + (ev.popMe ? myBefore : Math.max(0, myBefore - myAfter)))
          if (!own && ev.threat >= 4) {
            const took = ev.popMe ? myBefore : Math.max(0, myBefore - myAfter)
            st.threats++
            st.threatMax = r1(st.threatMax + ev.threat)
            st.threatTaken = r1(st.threatTaken + took)
            const ok = took <= Math.max(1.5, ev.threat * 0.25)
            if (ok) st.evaded++
            if (ev.slow) { st.threatsSlow = (st.threatsSlow || 0) + 1; if (ok) st.evadedSlow = (st.evadedSlow || 0) + 1; st.threatSlowMax = r1((st.threatSlowMax || 0) + ev.threat); st.threatSlowTaken = r1((st.threatSlowTaken || 0) + took) }
            if (DEBUG) console.log('[crystal] его взрыв у меня:', JSON.stringify({ threat: r1(ev.threat), took: r1(took), shield: S.shieldUntil > ev.at }))
          }
        } catch {}
      }, 400)
    } catch {}
  }
  const pops = []
  // Кто меня ранил последним (damage_event: sourceCauseId = id + 1): «поп»
  // тотема сервер шлёт в том же hurtServer сразу после — самоподрыв это мой
  // тотем от урона, причина которого — я сам (свой кристалл), и только он.
  S.lastDmg = null
  const onDamage = (p) => {
    try {
      if (!bot.entity || p.entityId !== bot.entity.id) return
      S.lastDmg = { at: gameClock.now(), self: p.sourceCauseId === bot.entity.id + 1 }
    } catch {}
  }
  const onStatus = (p) => {
    try {
      if (p.entityStatus !== 35) return
      const foe = enemy()
      const now = gameClock.now()
      if (bot.entity && p.entityId === bot.entity.id) {
        st.myPops++
        pops.push({ at: now, who: 'me' })
        if (S.lastDmg && S.lastDmg.self && now - S.lastDmg.at < 120) { st.selfPops++; try { used('САМОПОДРЫВ: свой тотем от своего взрыва') } catch {} }
      } else if (foe && p.entityId === foe.id) { st.hisPops++; pops.push({ at: now, who: 'him' }) }
      while (pops.length > 40) pops.shift()
    } catch {}
  }
  const onBlock = (oldB, newB) => {
    try {
      const b = newB || oldB
      if (!b || !b.position) return
      const k = cellKey(b.position)
      if (newB && newB.name === 'respawn_anchor' && !anchorsAt.has(k)) anchorsAt.set(k, { pos: newB.position.clone(), mine: myAnchorCells.has(k), at: gameClock.now() })
      const a = anchorsAt.get(k)
      if (a) { a.checkAt = -Infinity; anchorSeen(a) }
    } catch {}
  }
  bot.on('entitySpawn', onSpawn)
  bot.on('entityGone', onGone)
  bot.on('entityHurt', onHurt)
  bot.on('blockUpdate', onBlock)
  try { bot._client.on('explosion', onExplosion) } catch {}
  try { bot._client.on('entity_status', onStatus) } catch {}
  try { bot._client.on('damage_event', onDamage) } catch {}
  const close = () => {
    bot.removeListener('entitySpawn', onSpawn)
    bot.removeListener('entityGone', onGone)
    bot.removeListener('entityHurt', onHurt)
    bot.removeListener('blockUpdate', onBlock)
    try { bot._client.removeListener('explosion', onExplosion) } catch {}
    try { bot._client.removeListener('entity_status', onStatus) } catch {}
    try { bot._client.removeListener('damage_event', onDamage) } catch {}
  }
  return { onGone, onSpawn, onHurt, onExplosion, onDamage, onStatus, onBlock, close }
}

export { createObserver }
