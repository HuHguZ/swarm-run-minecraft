'use strict'
// Кристаллы (crystal.ts): план хода — что видно (planView), его кристаллы и якоря у меня (planThreats, planDefend),
// удар по нему (planOffense: кристалл, обсидиан под кристалл, якорь), остальное (planFallback: еда, починка,
// обсидиан вокруг ног, держать место).

import { Vec3 } from './geometry'
import * as pick from '../pick'
import { P, EYE, HIT_R, PLACE_R, IFRAME_MS, SIDES, ANCHOR_P, anchorReady, r1, shieldUpOf, without, boxOf, intersects, crystalBox, boxDist, blockAt, isAirB, solidB, baseFree, centerOf, pickBlockers, faceFor, hitAim, losClear, surrounded, feetCell } from './geometry'
import { effHp, countOf, kitOf, armorWear, landed, worthHit } from './scoring'
import type { CrystalDeps, CrystalState } from './state'

// ------------------------------------------------------------ план
// Что видно на этот план: он, я, набор, броня, защита, окна неуязвимости, его кристаллы в поле зрения.
type PlanView = ReturnType<typeof planView>

function planView (S: CrystalState, deps: CrystalDeps, ctx: any) {
  const { bot, enemy, hisHp, anchorsAt, crystalSeen, foeVisible, inWin, heShows } = S
  const { gameClock, boom, CX2 } = deps
  const foe = enemy()
  if (!foe || !foe.position || foe.isValid === false) return null
  const now = gameClock.now()
  const me = bot.entity.position
  const eye = me.offset(0, EYE, 0)
  const k = kitOf(bot)
  const cache = new Map()
  const dMe = boom.defenseOf(bot, bot.entity)
  const dHim = boom.defenseOf(bot, foe)
  const myEff = effHp(bot, bot.entity)
  const hisEff = hisHp(foe)
  const himShield = CX2 && shieldUpOf(bot, foe)
  const v = ctx.vel || { x: 0, y: 0, z: 0 }
  const himAt = foe.position.offset(v.x * 3, 0, v.z * 3)
  const hisW = inWin(S.hisWin)
  const myW = inWin(S.myWin, IFRAME_MS - 60)
  const dist = me.distanceTo(foe.position)
  const hisEye = foe.position.offset(0, EYE, 0)
  const foeSeenNow = foeVisible(foe)
  const hisHand = foeSeenNow && foe.equipment && foe.equipment[0] ? foe.equipment[0].name : ''
  const hisBow = /^(bow|crossbow)$/.test(hisHand)
  if (hisBow) S.bowSeenAt = now
  const crystals = (Object.values(bot.entities) as any[]).filter((e : any) => e && e.name === 'end_crystal' && e.position && e.isValid !== false &&
    (e.position.distanceTo(me) < 13 || e.position.distanceTo(foe.position) < 13) && crystalSeen(e))
  if (!crystals.length && !k.crystals && !anchorReady(bot, k) && !anchorsAt.size) return null
  const shows = heShows(foe)
  const press = !!ctx.press
  const eqF = foe.equipment || []
  const hisTotem = !!((eqF[0] && eqF[0].name === 'totem_of_undying') || (eqF[1] && eqF[1].name === 'totem_of_undying'))
  return { foe, now, me, eye, k, cache, dMe, dHim, myEff, hisEff, himShield, himAt, hisW, myW, dist, hisEye, hisBow, crystals, shows, press, hisTotem }
}

function planThreats (S: CrystalState, deps: CrystalDeps, p: PlanView) {
  const { bot } = S
  const { trade, CX2 } = deps
  const { foe, now, cache, dMe, dHim, himShield, hisEye, hisBow, crystals } = p
  // 1. Его (и любой) кристалл у меня: сбить выгодно или в своё окно; иначе
  //    отойти, если он его достаёт.
  let danger = null
  const threats = []
  for (const c of (crystals as any)) {
    const t = trade(bot, c.position, foe, bot.entity, dHim, dMe, cache, { himShield })
    // Прикрыт (лучей почти нет), а в открытую было бы ≥ 4 — в угрозы для «держать укрытие», не в «опасность».
    const covered = CX2 && t.me < 2 && (t.meMax ?? 0) >= 4
    if (t.me < 2 && !covered) continue
    if (boxDist(hisEye, crystalBox(c.position)) <= HIT_R + 0.4 || hisBow || (CX2 && now - S.bowSeenAt < 60000 && c.position.distanceTo(hisEye) < 24 && losClear(bot, hisEye, c.position.offset(0, 1, 0)))) threats.push({ c, t })
    if (!covered && (!danger || t.me > danger.t.me)) danger = { c, t }
  }
  return { danger, threats }
}

function planDefend (S: CrystalState, deps: CrystalDeps, p: PlanView, danger, threats) {
  const { bot, anchorsAt, anchorSeen, cellKey, coverHold, evade } = S
  const { trade, CX2 } = deps
  const { foe, now, me, eye, cache, dMe, dHim, myEff, himShield, hisW, myW, dist, hisEye, hisBow } = p
  // Его якоря у меня (S7c): заряженный он подорвёт одним кликом, пустой — двумя (светокамень, клик). Достаёт,
  // если центр в 4.5 от его глаз. Свой клик по его заряженному якорю — подрыв, когда размен в мою пользу
  // (взрыв ни на кого не записан, но бьёт его сильнее); иначе — уклонение ценой, как от кристалла.
  if (CX2) {
    for (const a of anchorsAt.values()) {
      if (!anchorSeen(a)) continue
      if (a.mine || a.pos.distanceTo(me) > 8) continue
      const charges = a.charges || 0
      const center = a.pos.offset(0.5, 0.5, 0.5)
      const t = trade(bot, center, foe, bot.entity, dHim, dMe, without(cache, a.pos), { power: ANCHOR_P, himShield })
      if (t.me < 2 && !((t.meMax ?? 0) >= 4)) continue
      const th = { c: { position: center, id: 'a' + cellKey(a.pos), isValid: true }, t, power: ANCHOR_P, cell: a.pos, charges }
      if (center.distanceTo(hisEye) <= PLACE_R + 0.5) threats.push(th)
      const hisLand = landed(t, hisW, dHim)
      const worstMe = Math.max(t.me, t.meMax ?? t.me)
      if (charges > 0 && !t.allyRisk && worstMe < myEff - 3 && hisLand >= t.me * 1.2 + 1 && now - S.lastAnchor > 600) {
        const ff = faceFor(bot, a.pos, eye, pickBlockers(bot, eye))
        if (ff) return { kind: 'anchorPop', cell: a.pos, t, note: `его якорь у нас — подорвал сам, ему больнее (${r1(hisLand)} против ${r1(t.me)})` }
      }
    }
    if (!danger && threats.length && now - S.lastDodge > 400) {
      const ev = evade(threats, { dMe, myEff, cache, foe })
      if (ev) return ev
      const ch = coverHold(threats, { dMe, myEff, cache, eye, now, far: dist > 3.6 })
      if (ch) return ch
    }
  }
  if (danger) {
    const { c, t } = danger
    const aim = hitAim(bot, c.position, eye)
    const free = myW && t.meRaw <= myW.raw - 0.5
    const hisLand = landed(t, hisW, dHim)
    // Своё окно: сырой удар мне не больше того, что только что пришёл, — мне 0.
    const worstMe = Math.max(t.me, t.meMax ?? t.me)
    if (aim && !t.allyRisk && free && hisLand >= 1.5 && worstMe < myEff - 3) return { kind: 'defuse', c, t, aim, why: 'free', note: `его кристалл — в своё окно неуязвимости (ему ${r1(hisLand)}, мне 0)` }
    if (aim && !t.allyRisk && worstMe < myEff - 3 && hisLand >= t.me * 1.2 + 1) return { kind: 'defuse', c, t, aim, why: 'trade', note: `сбил кристалл у нас — ему больнее (${r1(hisLand)} против ${r1(t.me)})` }
    const hisReach = boxDist(hisEye, crystalBox(c.position)) <= HIT_R + 0.4 || hisBow
    const lethal = t.me >= myEff - 1
    // S7c: защита ценой — щит лицом к кристаллу, укрытие (клетка, где лучей к телу нет), блок между —
    // против «стоять» по ожидаемому урону (evade). Сбить его кристалл сам — выше, когда размен в мою пользу.
    if (CX2 && threats.length && now - S.lastDodge > 400) {
      const ev = evade(threats, { dMe, myEff, cache, foe })
      if (ev) return ev
      const ch = coverHold(threats, { dMe, myEff, cache, eye, now, far: dist > 3.6 })
      if (ch) return ch
    }
    if (hisReach && (lethal || t.me >= Math.max(5, myEff * 0.45)) && now - S.lastDodge > 700) {
      return { kind: 'dodge', from: c.position, t, note: `ухожу от его кристалла (прогноз ${r1(t.me)} из ${r1(myEff)})` }
    }
  }
  return null
}

function planOffense (S: CrystalState, deps: CrystalDeps, p: PlanView) {
  const { bot, mine, guardFor } = S
  const { boom, trade, CX2 } = deps
  const { foe, now, me, eye, k, cache, dMe, dHim, myEff, hisEff, himShield, himAt, hisW, dist, crystals, press, hisTotem } = p
  // 2. Удар по нему: готовый кристалл у него — рукой или стрелой; новый —
  //    на обсидиан у его ног (рукой сразу, заранее в его окно, или «поставил
  //    — отошёл — стрела»).
  let best = null
  // Край, яма, лава рядом с ним (S7c): толчок взрыва (1−d)·вид. по «центр → глаза» сбросит его — к цене +5.
  const edgy = CX2 && (() => { try { return (require('../edges') as typeof import('../edges')).hazardAround(bot, foe.position, 5, new Map()) } catch { return false } })()
  // Толпа (ND_CRYSTAL_RECKLESS=1, арена 10.10: «взорвал — следующий сразу, пока не убьёшь кучу врагов»): за каждого
  // чужого игрока в 6 бл. от кристалла, кроме цели, — к цене (6 − d)·1.2; свои по команде (teamMap) не в счёт.
  const crowd = (pos) => {
    if (!pos || process.env.ND_CRYSTAL_RECKLESS !== '1') return 0
    const mine = bot.teamMap?.[bot.username]?.team
    let s = 0
    for (const e of Object.values(bot.entities || {}) as any[]) {
      if (!e || e.type !== 'player' || e === foe || e === bot.entity || !e.position) continue
      if (mine && bot.teamMap?.[e.username]?.team === mine) continue
      const d = e.position.distanceTo(pos)
      if (d < 6) s += (6 - d) * 1.2
    }
    return s
  }
  const consider = (o) => {
    if (o.t?.allyRisk) return
    const at0 = o.c?.position || (o.c && Number.isFinite(o.c.x) ? o.c : null)
    if (at0 && /^(hit|shoot|place|place-hit|place-shoot)$/.test(o.kind)) o.score += crowd(at0)
    if (edgy && o.c && (o.land ?? 0) >= 1.5 && o.kind !== 'obby') {
      let off = false
      try { off = boom.judge(bot, foe, o.c.position || o.c, P, { cache, foeAt: himAt }).off } catch {}
      if (off) { o.score += 5; o.knock = true; o.note = (o.note || '') + ' — толчком за край' }
    }
    if (!best || o.score > best.score) best = o
  }
  const bonus = (land) => (land >= hisEff - 0.5 ? 6 : 0)
  // Цена своего урона — от состояния (S7d): 1.3 при запасе, дороже по мере того, как мой запас хп тает (у края
  // смерти каждый свой хп дороже его хп): 12 эфф. хп и ниже — +1/6 за каждый недостающий (s7c4: себе 730 на 2387 ему).
  const wMe = CX2 ? 1.3 + Math.max(0, 12 - myEff) / 6 : 1.3
  for (const c of (crystals as any)) {
    if (c.position.distanceTo(foe.position) > 7) continue
    const t = trade(bot, c.position, foe, bot.entity, dHim, dMe, cache, { himAt, himShield })
    const land = landed(t, hisW, dHim)
    const aim = hitAim(bot, c.position, eye)
    if (aim && worthHit(t, { myEff, hisEff, hisLand: land, press, hisTotem })) consider({ kind: 'hit', c, t, aim, land, score: land - wMe * t.me + bonus(land) + 1 })
    // Стрелой — рукой не достать, а размен с места выгодный.
    if (k.bow && k.arrows && !aim && worthHit(t, { myEff, hisEff, hisLand: land, press, hisTotem }) && c.position.distanceTo(eye) < 24 && losClear(bot, eye, c.position.offset(0, 1, 0))) {
      consider({ kind: 'shoot', c, t, land, score: land - wMe * t.me + bonus(land) - 0.5 })
    }
  }
  // Готовый свой кристалл у него в руке досягаемости ждёт конца его окна —
  // не ставить новый рядом.
  const waiting = crystals.some((c : any) => mine.has(c.id) && c.position.distanceTo(foe.position) < 3.5 && hitAim(bot, c.position, eye))
  if (k.crystals > 0 && !waiting && dist < 8.5) {
    const avoid = pickBlockers(bot, eye)
    const ents = (Object.values(bot.entities) as any[])
    const fc = feetCell(foe.position)
    for (let dx = -2; dx <= 2; dx++) {
      for (let dz = -2; dz <= 2; dz++) {
        for (let dy = -2; dy <= 0; dy++) {
          const base = new Vec3(fc.x + dx, fc.y + dy, fc.z + dz)
          const c = centerOf(base)
          if (c.distanceTo(eye) > PLACE_R + 0.6) continue
          if (!baseFree(bot, base, { cache, ents })) continue
          const t = trade(bot, c, foe, bot.entity, dHim, dMe, cache, { himAt, himShield })
          if (t.him < 2.5) continue
          const land = landed(t, hisW, dHim)
          const aim = hitAim(bot, c, eye, HIT_R - 0.25)
          const faceP = () => faceFor(bot, base, eye, avoid)
          if (aim && worthHit(t, { myEff, hisEff, hisLand: land, press, hisTotem })) {
            const f = faceP(); if (!f) continue
            consider({ kind: 'place-hit', base, c, f, t, land, score: land - wMe * t.me + bonus(land) })
          } else if (aim && hisW && worthHit(t, { myEff, hisEff, hisLand: t.him, press, hisTotem })) {
            const f = faceP(); if (!f) continue
            consider({ kind: 'place', base, c, f, t, land: t.him, score: t.him - wMe * t.me - 1.5 })
          } else if (k.bow && k.arrows && t.him >= 4 && myEff > 8 && now - S.lastPlaceShoot > 2500 && (!aim || (t.me > myEff * 0.45 && dist >= 3.5))) {
            // Рукой не достать или себе дорого: поставить, при нужде отойти, стрелой.
            // Вплотную (он в 3.5) — не кристалл, а меч: кристалл у него будет и
            // у меня, а удар мечом его отбросит на дистанцию кристалла.
            const f = faceP(); if (!f) continue
            consider({ kind: 'place-shoot', base, c, f, t, land, score: t.him * 0.6 - 2 })
          }
        }
      }
    }
  }
  // 2а. Основы у него нет (пол не обсидиан: светокамень, камень, его столб) —
  //     свой обсидиан у его ног, кристалл на него — следующим проходом. Клетка
  //     пола рядом с ним (выбитая взрывом, дыра) лучше всего: центр взрыва на
  //     уровне его ног, рамка открыта; на уровне ног — основа сама закрывает
  //     ему низ (~40% видимости). Модель ставит блок в кэш лучей и считает.
  if (k.crystals > 0 && k.obsidian > 0 && !waiting && dist < 7 && (!best || best.score < 3) && now - S.lastObby > 900) {
    const fc = feetCell(foe.position)
    const ents = (Object.values(bot.entities) as any[])
    const blocks = ents.filter((e : any) => e && e.position && e.isValid !== false && (e.type === 'player' || e.name === 'end_crystal' || /mob|hostile|animal|passive/.test(e.type || '')))
    for (let dx = -2; dx <= 2; dx++) {
      for (let dz = -2; dz <= 2; dz++) {
        for (const dy of [-1, 0]) {
          if (!dx && !dz) continue
          const cell = new Vec3(fc.x + dx, fc.y + dy, fc.z + dz)
          if (!isAirB(blockAt(bot, cache, cell.x, cell.y, cell.z))) continue
          if (!isAirB(blockAt(bot, cache, cell.x, cell.y + 1, cell.z))) continue
          const cellBox = { minX: cell.x, minY: cell.y, minZ: cell.z, maxX: cell.x + 1, maxY: cell.y + 1, maxZ: cell.z + 1 }
          if (blocks.some(e => intersects(cellBox, boxOf(e)))) continue
          const col = { minX: cell.x, minY: cell.y + 1, minZ: cell.z, maxX: cell.x + 1, maxY: cell.y + 3, maxZ: cell.z + 1 }
          if (ents.some((e : any) => e && e.position && e.isValid !== false && intersects(col, boxOf(e)))) continue
          const c = centerOf(cell)
          if (c.distanceTo(eye) > PLACE_R - 0.2) continue
          // Блок встанет — лучам он преграда (его собственная рамка — нет).
          const sim = new Map(cache)
          sim.set(`${cell.x},${cell.y},${cell.z}`, [[0, 0, 0, 1, 1, 1]])
          const t = trade(bot, c, foe, bot.entity, dHim, dMe, sim, { himAt, himShield })
          if (t.him < 4) continue
          const aim = hitAim(bot, c, eye, HIT_R - 0.25)
          const byHand = !!aim && worthHit(t, { myEff, hisEff, hisLand: t.him, press, hisTotem })
          const byBow = k.bow && k.arrows && t.me < myEff * 0.45
          if (!byHand && !byBow) continue
          // Цена — как у следующего хода (удар или стрела) минус лишний блок.
          const next = byHand ? t.him - wMe * t.me + bonus(t.him) : t.him * 0.6 - 2
          // Грань, к которой прислонить обсидиан, — видна (build.placeBlockAt honest).
          let face = false
          for (const n of [new Vec3(0, -1, 0), ...SIDES]) {
            const ref = cell.plus(n)
            if (!solidB(blockAt(bot, cache, ref.x, ref.y, ref.z))) continue
            if (pick.faceAim(bot, ref, n.scaled(-1), { eye, range: PLACE_R - 0.05 })) { face = true; break }
          }
          if (!face) continue
          consider({ kind: 'obby', cell, t, land: t.him, score: next - 0.5, note: `обсидиан у его ног под кристалл (прогноз ему ${r1(t.him)})` })
        }
      }
    }
  }
  // 2в. Якорь возрождения (бонус, 2026-09-30; RespawnAnchorBlock 1.21.11): в
  //     верхнем мире «использовать» заряженный якорь не светокамнем — блок
  //     снимается и взрыв силы 5 с огнём в его центре, ни на кого не записан.
  //     Якорь у его ног (клетка воздуха рядом, грань видна), светокамень,
  //     и ещё раз — мечом. Рамка кристалла не нужна, но три клика — дольше.
  // Якорь — не только когда кристаллу нечего делать: при годном размене — то
  //     якорь, то кристалл (разнообразие для зрителя), лучший — всегда.
  let anchorBest = null
  if (anchorReady(bot, k) && dist < 6.5 && now - S.lastAnchor > 2500 && !hisW) {
    const fc = feetCell(foe.position)
    const mc = feetCell(me)
    const ents = (Object.values(bot.entities) as any[])
    const living = ents.filter((e : any) => e && e.position && e.isValid !== false && (e.type === 'player' || e.name === 'end_crystal' || /mob|hostile|animal|passive/.test(e.type || '')))
    for (let dx = -2; dx <= 2; dx++) {
      for (let dz = -2; dz <= 2; dz++) {
        const cell = new Vec3(fc.x + dx, fc.y, fc.z + dz)
        if (cell.equals(fc) || cell.equals(mc)) continue
        if (!isAirB(blockAt(bot, cache, cell.x, cell.y, cell.z))) continue
        if (!solidB(blockAt(bot, cache, cell.x, cell.y - 1, cell.z))) continue
        const cb = { minX: cell.x, minY: cell.y, minZ: cell.z, maxX: cell.x + 1, maxY: cell.y + 1, maxZ: cell.z + 1 }
        if (living.some(e => intersects(cb, boxOf(e)))) continue
        const c = cell.offset(0.5, 0.5, 0.5)
        if (c.distanceTo(eye) > PLACE_R - 0.4) continue
        // Блок снимается до взрыва — лучам он не преграда (кэш как есть).
        let t = trade(bot, c, foe, bot.entity, dHim, dMe, without(cache, cell), { himAt, power: ANCHOR_P, himShield })
        // Себе дорого — «щит из светокамня» (S7c): блок между мной и якорем (взрыв бьёт сущности раньше, чем
        // ломает блоки — ServerExplosion.explode: hurtEntities до interactWithBlocks), тогда размен — заново.
        let guard = null
        if (!worthHit(t, { myEff, hisEff, hisLand: t.him, press, hisTotem })) {
          if (!CX2 || k.glowstone < 2) continue
          const g = guardFor(cell, c, cache, living, { himAt, dHim, dMe, foe, himShield })
          if (!g || !worthHit(g.t, { myEff, hisEff, hisLand: g.t.him, press, hisTotem })) continue
          t = g.t; guard = g.cell
        }
        // Опора под якорем видна (ставить) — грань самого якоря потом та же сторона.
        if (!pick.faceAim(bot, cell.offset(0, -1, 0), new Vec3(0, 1, 0), { eye, range: PLACE_R - 0.05 })) continue
        const sc = t.him - wMe * t.me + bonus(t.him) - 1 - (guard ? 0.5 : 0)
        if (!anchorBest || sc > anchorBest.score) anchorBest = { kind: 'anchor', cell, guard, t, land: t.him, score: sc, note: `якорь у его ног${guard ? ' за светокамнем' : ''} (прогноз ему ${r1(t.him)}, мне ${r1(t.me)})` }
      }
    }
  }
  if (anchorBest && anchorBest.score > 0.5 && (!best || anchorBest.score >= best.score || (Math.random() < 0.35 && anchorBest.score >= best.score - 2))) best = anchorBest
  return best
}

function planFallback (S: CrystalState, deps: CrystalDeps, p: PlanView, best, danger) {
  const { bot, worstVsMe } = S
  const { foe, now, me, k, cache, dMe, myEff, hisEff, dist, hisBow, crystals, shows, press } = p
  // Добить (или сбить его тотем) — прежде еды.
  if (best && best.score > 0.5 && best.land >= hisEff - 0.5 && best.kind !== 'obby') return best
  // 2б. Яблоко на месте: хп мало, его кристалл мне сейчас не смертелен, он не
  //     в руке (или я в окружении) — есть здесь, а не бегать по арене (прогон
  //     t1: «не ем под ударами — отрываюсь» уводил бой в перестрелку).
  const cell0 = feetCell(me)
  const walled = surrounded(bot, cell0, cache)
  const abs = myEff - (bot.health ?? 20)
  const gold = bot.inventory.items().find(i => i.name === 'golden_apple')
  const egap = bot.inventory.items().find(i => i.name === 'enchanted_golden_apple')
  const apple = ((bot.health ?? 20) <= 8 && egap) || (abs < 3 && gold) || (abs < 3 && egap) || null
  const safeNow = !(danger && danger.t.me >= myEff - 1)
  if (apple && now - S.lastEat > 2500 && myEff <= 13 && safeNow && (dist > 3.8 || walled) && !(hisBow && !walled)) {
    return { kind: 'eat', item: apple.name, note: `ем ${apple.name === 'enchanted_golden_apple' ? 'зачарованное яблоко' : 'золотое яблоко'} на месте (${r1(myEff)} хп${walled ? ', в окружении' : ''})` }
  }
  // 2г. «Починка» бутылками опыта (просьба 2026-09-30: броня к ~20-му взрыву
  //     у ног ломалась — дальше каждый кристалл 25+): износ вещи ≥ 35%, его
  //     кристалл мне не смертелен, он не в руке (или я в окружении) — бутылки
  //     себе под ноги, сферы опыта чинят вещи с «Починкой» (2 прочности за очко).
  const wear = armorWear(bot)
  const bottles = countOf(bot, 'experience_bottle')
  if (wear.mending && bottles > 0 && wear.worst >= 0.35 && now - S.lastMend > 4000 && safeNow && (dist > 4.5 || walled) && !(hisBow && !walled) && !(best && best.land >= hisEff - 0.5)) {
    return { kind: 'mend', n: Math.min(bottles, 12, Math.max(4, Math.ceil(wear.missing / 14))), wear, note: `чиню броню опытом (износ до ${Math.round(wear.worst * 100)}%${walled ? ', в окружении' : ''})` }
  }
  if (best && best.score > 0.5) return best

  // 3. Защита заранее: он с кристаллами рядом, а мне отсюда светит много —
  //    обсидиан вокруг ног (surround).
  if (shows && k.obsidian >= 4 && dist < 6.5 && now - S.lastSurround > 2500) {
    const cell = feetCell(me)
    if (!surrounded(bot, cell, cache) && bot.entity.onGround) {
      const w = worstVsMe(foe, cache, dMe)
      if (w >= Math.max(6, myEff * 0.4)) return { kind: 'surround', w, note: `обсидиан вокруг ног (его кристалл мне сейчас до ${r1(w)})` }
    }
  }
  // 4. В окружении и он рядом, но не в руке — держать место (не выпрыгивать
  //    за ударом меча под его кристаллы); в нажиме — нет.
  if (walled && !press && dist > 3.4 && dist < 7.5 && shows && (k.crystals > 0 || crystals.length)) return { kind: 'hold' }
  return null
}

function createPlanner (S: CrystalState, deps: CrystalDeps) {
  const { bot, st } = S
  const { ON } = deps
  // ctx: { vel } — его скорость (б/т) для упреждения на 3 тика.
  // Время плана (лучи видимости — десятки на клетку): в отчёт среднее и худшее.
  function plan (ctx: any = {}) {
    const t0 = process.hrtime.bigint()
    try { return planBody(ctx) } finally {
      const ms = Number(process.hrtime.bigint() - t0) / 1e6
      st.planN = (st.planN || 0) + 1
      st.planMsSum = (st.planMsSum || 0) + ms
      if (ms > (st.planMsMax || 0)) st.planMsMax = Math.round(ms * 10) / 10
    }
  }
  function planBody (ctx: any = {}) {
    S.lastPress = !!ctx.press
    if (!ON || !bot.entity) return null
    const p = planView(S, deps, ctx)
    if (!p) return null
    const { danger, threats } = planThreats(S, deps, p)
    const defend = planDefend(S, deps, p, danger, threats)
    if (defend) return defend
    const best = planOffense(S, deps, p)
    return planFallback(S, deps, p, best, danger)
  }
  return { plan, planBody }
}

export { createPlanner, planView, planThreats, planDefend, planOffense, planFallback }
export type { PlanView }
