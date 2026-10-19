'use strict'
// Бой с драконом (dragon/pillar-run.ts): раскладка кроватей у головы на насесте (одна и двойная).
const { Vec3, overlap, playerBox, inflate, nearPortal, cloudsOf, isSolid, phaseOf, PHASE, EYE, SITTING, isAirish, pick, BREATH_R, cloudHits }: typeof import('../dig-down-to') = require('../dig-down-to')
const { inClouds, r1, breathOf, standY }: typeof import('../fall-guard') = require('../fall-guard')
const { virtualBot, bedDamage, SNEAK_EYE, hurtNear, bedCellFree, BED_TOP, fillPlaceable, dragonSeen }: typeof import('../evade-raw') = require('../evade-raw')
const { cardOf, cellsOnSeg, bedPointFrom, lowRowsOpen }: typeof import('../pillar-plan') = require('../pillar-plan')
const { turnSafe, AXES }: typeof import('../ts-plan') = require('../ts-plan')
import { sitRec, blindKnown } from './sight-zones'

function bedsLayout (bot, d, parts, { headAt = null, stayAt = null, brave = false, cap = null, skip = null, noTurn = false, liftMax = 0, hurry = false }: any = {}) {
  const me = bot.entity.position
  const hp = headAt || new Vec3(parts.headC.x, parts.head.min.y, parts.headC.z)
  const clouds = cloudsOf(bot)
  const ph = phaseOf(bot, d)
  const blind = SITTING.has(ph) && blindKnown(sitRec)
  const breath = SITTING.has(ph) && !blind ? breathOf(bot, d, parts) : null
  const why = {}
  const no = k => { why[k] = (why[k] || 0) + 1 }
  const at = (x, y, z) => bot.blockAt(new Vec3(x, y, z))
  const solidOk = b => isSolid(b) && !/_bed$|portal|gateway/.test(b.name)
  let best = null
  const cands = []
  const nearY = Math.floor(hp.y) - 3
  for (const D of AXES) {
    // ±2 от головы: после первой кровати у головы воронка (эндерняк под изножьем
    // снесён, досыпку не видно) — вторая ложится на целый пол рядом.
    for (let ox = -2; ox <= 2; ox++) {
      for (let oz = -2; oz <= 2; oz++) {
        const H = { x: Math.floor(hp.x) + ox, z: Math.floor(hp.z) + oz }
        const F = { x: H.x - D.x, z: H.z - D.z }
        const W = { x: H.x - 2 * D.x, z: H.z - 2 * D.z }
        const B = { x: H.x - 3 * D.x, z: H.z - 3 * D.z }
        if (stayAt && (B.x !== stayAt.x || B.z !== stayAt.z)) continue
        const key = `${H.x},${H.z},${D.x},${D.z}`
        if (skip && skip.has(key)) { no('не вышло только что'); continue }
        const y0 = standY(bot, B.x + 0.5, B.z + 0.5, nearY, 2, 3)
        if (y0 == null) { no('нет земли'); continue }
        // lift 1 — всё на блок выше: мы на своём блоке у B, кровать на опоре у F (центр
        // взрыва в 0.5 под головой сидящего вместо 1.5; сидячий крыльями не бьёт).
        for (const lift of (liftMax && SITTING.has(ph) ? [0, 1] : [0])) {
        const y = y0 + lift
        if (lift && !isAirish(at(B.x, y + 1, B.z))) { no('над своим блоком'); continue }
        if (/fire/.test((at(B.x, y, B.z) || {}).name || '')) { no('огонь на месте'); continue }
        // У задней кромки клетки — если за ней свободно (иначе по центру).
        const backFree = !isSolid(at(B.x - D.x, y, B.z - D.z)) && !isSolid(at(B.x - D.x, y + 1, B.z - D.z))
        const back = backFree ? 0.22 : 0
        const feet = new Vec3(B.x + 0.5 - D.x * back, y, B.z + 0.5 - D.z * back)
        if (nearPortal(feet)) { no('чаша портала'); continue }
        if (hurtNear(playerBox(feet), parts)) { no('коробки дракона'); continue }
        if (!blind && !noTurn && !turnSafe(d, feet)) { no('в круге поворота головы'); continue }
        // В облако не вставать и смелому: рефлекс «на блок» поднимает тело, щелчок
        if (inClouds(clouds, feet, 1.0)) { no('облако'); continue }
        const breathHit = !!breath && cloudHits(breath, feet, 0.6)
        // Огонь уже идёт — в его круг нельзя; ревёт (облако через ≤ 2.5 с) — можно,
        // если место в паре шагов: кровать успевает раньше облака.
        if (breathHit && ph === PHASE.FLAMING) { no('облако огня'); continue }
        if (breathHit && ph === PHASE.ROARING && Math.hypot(feet.x - me.x, feet.z - me.z) > 3) { no('облако огня скоро'); continue }
        // Клетки кровати, заслона и вида поверх него.
        const hB = at(H.x, y, H.z); const fB = at(F.x, y, F.z)
        const reuse = !!hB && !!fB && /_bed$/.test(hB.name) && /_bed$/.test(fB.name)
        if (!reuse && (!bedCellFree(hB) || !bedCellFree(fB))) { no('клетки кровати'); continue }
        const wB = at(W.x, y, W.z)
        const wallUp = solidOk(wB)
        if (!wallUp && !bedCellFree(wB)) { no('клетка заслона'); continue }
        if (wallUp && !reuse) { no('заслон уже стоит — пол под кроватью не видно'); continue }
        if (!isAirish(at(W.x, y + 1, W.z)) || !isAirish(at(F.x, y + 1, F.z))) { no('над заслоном блок'); continue }
        // Пол: под изножьем — твёрдый (или досыпать один), под заслоном — тоже.
        const fills = []
        for (const c of [W, F]) {
          const fl = at(c.x, y - 1, c.z)
          if (!fl) { fills.push(null); break }
          if (solidOk(fl)) continue
          if (!isAirish(fl) && !/fire/.test(fl.name)) { fills.push(null); break }
          // Досыпать есть к чему прислонить: снизу или сбоку твёрдое (или
          // досыпка перед ней).
          const prev = fills[fills.length - 1]
          const nb = [[0, -1, 0], [1, 0, 0], [-1, 0, 0], [0, 0, 1], [0, 0, -1]].some(([a, b, e]) => solidOk(at(c.x + a, y - 1 + b, c.z + e)) || (prev && prev.x === c.x + a && prev.y === y - 1 + b && prev.z === c.z + e))
          if (!nb) { fills.push(null); break }
          fills.push(new Vec3(c.x, y - 1, c.z))
        }
        if (fills.includes(null)) { no('пол'); continue }
        // Каждую досыпку — на «мире как будет» (после предыдущих): вторая (под
        // изножьем) за первой часто не видна (b4/b5: «пол не встал» ×20).
        {
          const ex = new Map()
          let hidden = false
          for (const f of fills) {
            if (!fillPlaceable(ex.size ? virtualBot(bot, ex) : bot, f, feet.offset(0, SNEAK_EYE, 0))) { hidden = true; break }
            ex.set(`${f.x},${f.y},${f.z}`, 'block')
          }
          if (hidden) { no('досыпку не видно'); continue }
        }
        if (!lift && !solidOk(at(B.x, y - 1, B.z))) { no('пол под нами'); continue }
        // Кровать не в коробках дракона (checkWalls снёс бы её без взрыва).
        const bedBox = { min: new Vec3(Math.min(H.x, F.x), y, Math.min(H.z, F.z)), max: new Vec3(Math.max(H.x, F.x) + 1, y + BED_TOP, Math.max(H.z, F.z) + 1) }
        if (overlap(bedBox, inflate(parts.head, 0.1)) || overlap(bedBox, inflate(parts.neck, 0.1)) || overlap(bedBox, inflate(parts.body, 0.1))) { no('в драконе'); continue }
        const centre = new Vec3(H.x + 0.5, y + 0.5, H.z + 0.5)
        const dist = centre.distanceTo(hp)
        if (dist > 5.5) { no('далеко от головы'); continue }
        const expect = bedDamage(dist)
        const walk = Math.hypot(feet.x - me.x, feet.z - me.z) + Math.abs(feet.y - me.y) * 2
        const over = cap != null && expect > cap ? (expect - cap) * 3 : 0
        const cost = -expect + over + walk * 1.2 + fills.length * 6 + (breathHit ? 6 : 0) + (back ? 0 : 3)
        cands.push({ key: key + (lift ? ':1' : ''), H, F, W, B, D, y, feet, centre, dist: r1(dist), expect, fills, reuse, wallUp, cost: lift ? cost - fills.length * 6 + 3 : cost, breathHit, walk, back, lift })
        }
      }
    }
  }
  // Видимость дракона из центра взрыва (свои блоки у кровати — заслон, досыпка, яма и
  cands.sort((p, q) => p.cost - q.cost)
  for (const c of cands.slice(0, 6)) {
    const ex = new Map([[`${c.W.x},${c.y},${c.W.z}`, 'block']])
    for (const f of c.fills) ex.set(`${f.x},${f.y},${f.z}`, 'block')
    const seen = dragonSeen(virtualBot(bot, ex), c.centre, parts.pos)
    c.seen = Math.round(seen * 100) / 100
    c.expect = bedDamage(c.centre.distanceTo(hp), seen)
    const over = cap != null && c.expect > cap ? (c.expect - cap) * 3 : 0
    // На своём блоке досыпка под заслон и изножье — часть раскладки (не штраф «воронки»).
    c.cost = -c.expect + over + c.walk * 1.2 + (c.lift ? 3 : c.fills.length * 6) + (c.breathHit ? 6 : 0) + (c.back ? 0 : 3)
    // Слепой вот-вот взлетит сам (на 99-м тике): любая кровать ближе — лишь бы сидячий
    // счёт перевалил 50 и обнулился (иначе он перейдёт на следующую посадку: oc7-12).
    if (hurry) c.cost = -c.expect * 0.3 + c.walk * 3 + c.fills.length * 6
    if (!best || c.cost < best.cost) best = c
  }
  bedsLayout.why = best ? null : why
  return best
}
declare namespace bedsLayout {
  let why: any
}

function bedsDouble (bot, d, parts, { brave = false, skip = null, fixS = null, cap = null }: any = {}) {
  const me = bot.entity.position
  const at = (x, y, z) => bot.blockAt(new Vec3(x, y, z))
  const solidOk = b => isSolid(b) && !/_bed$|portal|gateway/.test(b.name)
  const hp0 = new Vec3(parts.headC.x, parts.head.min.y, parts.headC.z)
  // Взлёт (трассы, 1300 взлётов, an-takeoffdir.js): первые 0.5 с тело почти на
  const hpC = new Vec3(hp0.x, hp0.y + 0.4, hp0.z)
  const mid = { x: (hp0.x + hpC.x) / 2, z: (hp0.z + hpC.z) / 2 }
  const nearY = Math.floor(hp0.y) - 3
  const clouds = cloudsOf(bot)
  const ph = phaseOf(bot, d)
  const breath = SITTING.has(ph) && !blindKnown(sitRec) ? breathOf(bot, d, parts) : null
  const why = {}
  const no = k => { why[k] = (why[k] || 0) + 1 }
  const bodyBoxes = [inflate(parts.head, 0.1), inflate(parts.neck, 0.1), inflate(parts.body, 0.1)]
  // Кровать на (foot, head) уровня y: клетки свободны, пол под изножьем есть или
  // досыпается, не в коробках дракона.
  const bedCells = (F, H, y) => {
    const fb = at(F.x, y, F.z); const hb = at(H.x, y, H.z)
    // Своя кровать уже лежит так, как надо (изголовье в H) — взять её.
    if (fb && hb && /_bed$/.test(fb.name) && /_bed$/.test(hb.name)) {
      let part = null
      try { part = hb.getProperties ? hb.getProperties().part : null } catch {}
      return part === 'head' || part == null ? { fill: null, reuse: true } : null
    }
    if (!bedCellFree(fb) || !bedCellFree(hb)) return null
    const bb = { min: new Vec3(Math.min(H.x, F.x), y, Math.min(H.z, F.z)), max: new Vec3(Math.max(H.x, F.x) + 1, y + BED_TOP, Math.max(H.z, F.z) + 1) }
    if (bodyBoxes.some(b => overlap(bb, b))) return null
    const fl = at(F.x, y - 1, F.z)
    if (!fl) return null
    if (solidOk(fl)) return { fill: null }
    if (!isAirish(fl) && !/fire/.test(fl.name)) return null
    const nb = [[0, -1, 0], [1, 0, 0], [-1, 0, 0], [0, 0, 1], [0, 0, -1]].some(([a, b, e]) => solidOk(at(F.x + a, y - 1 + b, F.z + e)))
    return nb ? { fill: new Vec3(F.x, y - 1, F.z) } : null
  }
  // Лучшие варианты кровати у точки hp (голова) для места с глазами eye.
  const bedOpts = (hp, feet, y, lim) => {
    const out = []
    for (let ox = -2; ox <= 2; ox++) {
      for (let oz = -2; oz <= 2; oz++) {
        const F = { x: Math.floor(hp.x) + ox, z: Math.floor(hp.z) + oz }
        // Изголовье ляжет по взгляду от нас на пол под изножьем (BedBlock.getStateForPlacement).
        const f = cardOf(F.x + 0.5 - feet.x, F.z + 0.5 - feet.z)
        const H = { x: F.x + f.x, z: F.z + f.z }
        const centre = new Vec3(H.x + 0.5, y + 0.5, H.z + 0.5)
        const dist = centre.distanceTo(hp)
        if (dist > lim) continue
        if (Math.max(Math.abs(F.x - Math.floor(feet.x)), Math.abs(F.z - Math.floor(feet.z))) < 2) continue
        const c = bedCells(F, H, y)
        if (!c) continue
        if (c.fill && !fillPlaceable(bot, c.fill, feet.offset(0, SNEAK_EYE, 0))) continue
        out.push({ F, H, f, centre, dist: r1(dist), expect: bedDamage(dist), fill: c.fill, reuse: !!c.reuse })
      }
    }
    return out.sort((a, b) => b.expect - a.expect)
  }
  let best = null
  for (let ox = -6; ox <= 6; ox++) {
    for (let oz = -6; oz <= 6; oz++) {
      const S = { x: Math.floor(mid.x) + ox, z: Math.floor(mid.z) + oz }
      if (fixS && (S.x !== fixS.x || S.z !== fixS.z)) continue
      const rS = Math.hypot(S.x + 0.5 - mid.x, S.z + 0.5 - mid.z)
      if (!fixS && (rS < 2.5 || rS > 5.2)) continue
      const y = standY(bot, S.x + 0.5, S.z + 0.5, nearY, 2, 3)
      if (y == null) { no('нет земли'); continue }
      if (/fire/.test((at(S.x, y, S.z) || {}).name || '')) { no('огонь'); continue }
      if (!solidOk(at(S.x, y - 1, S.z))) { no('пол под нами'); continue }
      // Задняя кромка — прочь от середины между кроватями.
      const ux = (S.x + 0.5 - mid.x) / (rS || 1); const uz = (S.z + 0.5 - mid.z) / (rS || 1)
      const bx = Math.round(ux); const bz = Math.round(uz)
      const backFree = !isSolid(at(S.x + bx, y, S.z + bz)) && !isSolid(at(S.x + bx, y + 1, S.z + bz))
      const feet = new Vec3(S.x + 0.5 + (backFree ? ux * 0.2 : 0), y, S.z + 0.5 + (backFree ? uz * 0.2 : 0))
      if (nearPortal(feet)) { no('чаша портала'); continue }
      if (hurtNear(playerBox(feet), parts)) { no('коробки дракона'); continue }
      if (!(SITTING.has(ph) && blindKnown(sitRec)) && !turnSafe(d, feet)) { no('в круге поворота головы'); continue }
      if (!brave && inClouds(clouds, feet, 1.0)) { no('облако'); continue }
      const eye = feet.offset(0, EYE, 0)
      // Первая кровать посадки — не выше cap (сидячий счёт > 50 — сразу взлёт).
      const xs = bedOpts(hp0, feet, y, 3.6).sort((a, b) => (b.expect - (cap != null && b.expect > cap ? (b.expect - cap) * 3 : 0)) - (a.expect - (cap != null && a.expect > cap ? (a.expect - cap) * 3 : 0))).slice(0, 4)
      const csAll = bedOpts(hpC, feet, y, 4.2)
      if (!xs.length) { no('нет места под головой'); continue }
      if (!csAll.length) { no('нет места для C'); continue }
      const walk = Math.hypot(feet.x - me.x, feet.z - me.z) + Math.abs(feet.y - me.y) * 2
      for (const X of xs) {
        // C — не ближе двух клеток к X (между ними щит).
        const cs = csAll.filter(C => ![C.F, C.H].some(a => [X.F, X.H].some(b => Math.max(Math.abs(a.x - b.x), Math.abs(a.z - b.z)) < 2))).slice(0, 4)
        for (const C of cs) {
          if (skip && skip.has(`${X.H.x},${X.H.z}|${C.H.x},${C.H.z}`)) continue
          const xc = [X.F, X.H]; const cc = [C.F, C.H]
          if (xc.some(a => cc.some(b => Math.max(Math.abs(a.x - b.x), Math.abs(a.z - b.z)) < 2))) { no('кровати тесно'); continue }
          const key = c => `${c.x},${c.z}`
          const taken = new Set([...xc, ...cc, S].map(key))
          // Стенка — клетки у нашей (8 соседей), через которые идут отрезки к кроватям.
          const walls = new Map()
          for (const t of [...xc, ...cc]) {
            for (const w of cellsOnSeg({ x: feet.x, z: feet.z }, { x: t.x + 0.5, z: t.z + 0.5 })) {
              if (Math.max(Math.abs(w.x - S.x), Math.abs(w.z - S.z)) === 1 && !taken.has(key(w))) walls.set(key(w), w)
            }
          }
          // Щит между X и C — клетки на отрезках от центра X к клеткам C.
          const shield = new Map()
          for (const t of cc) for (const w of cellsOnSeg({ x: X.H.x + 0.5, z: X.H.z + 0.5 }, { x: t.x + 0.5, z: t.z + 0.5 })) if (!taken.has(key(w)) && !walls.has(key(w))) shield.set(key(w), w)
          for (const t of cc) for (const w of cellsOnSeg({ x: X.F.x + 0.5, z: X.F.z + 0.5 }, { x: t.x + 0.5, z: t.z + 0.5 })) if (!taken.has(key(w)) && !walls.has(key(w))) shield.set(key(w), w)
          if (!shield.size) { no('щиту нет места'); continue }
          // Крышка облака огня: мы в круге облака — его колонка в два блока (облако
          // ляжет на её верх, выше нас).
          let lid = null
          if (breath && Math.hypot(feet.x - breath.pos.x, feet.z - breath.pos.z) < BREATH_R + 1) {
            const bc = breath.column
            if (taken.has(key(bc)) || walls.has(key(bc))) { no('крышка на клетке станции'); continue }
            const gy = standY(bot, bc.x + 0.5, bc.z + 0.5, y, 2, 3)
            if (gy == null) { no('крышка: нет земли'); continue }
            const h = Math.max(2, Math.ceil(y + 1.85 - gy))
            lid = { x: bc.x, z: bc.z, y: gy, h }
          }
          // Что поставить: всё должно встать в воздух (или уже стоять).
          const place = []
          let bad = false
          const want = (x, yy, z) => { const b = at(x, yy, z); if (!b) { bad = true; return } if (solidOk(b)) return; if (!bedCellFree(b)) { bad = true; return } place.push(new Vec3(x, yy, z)) }
          for (const w of walls.values()) want(w.x, y, w.z)
          for (const w of shield.values()) want(w.x, y, w.z)
          if (lid) for (let k = 0; k < lid.h; k++) want(lid.x, lid.y + k, lid.z)
          if (bad) { no('клетка стенки/щита занята'); continue }
          for (const w of walls.values()) if (!isAirish(at(w.x, y + 1, w.z))) bad = true
          if (bad) { no('над стенкой блок'); continue }
          // Каждый блок ставится честно: грань опоры видно из глаз и до неё ≤ 4.5
          const placeSet = new Set(place.map(p => `${p.x},${p.y},${p.z}`))
          const lidSet = new Set(lid ? Array.from({ length: lid.h }, (_, k) => `${lid.x},${lid.y + k},${lid.z}`) : [])
          const seye = feet.offset(0, SNEAK_EYE, 0)
          if (place.some(p => lidSet.has(`${p.x},${p.y},${p.z}`) && !placeSet.has(`${p.x},${p.y - 1},${p.z}`) && !fillPlaceable(bot, p, seye))) { no('до крышки не дотянуться'); continue }
          // Виртуальный мир: стенка, щит, крышка, кровати.
          const extra = new Map()
          const put = (x, yy, z, v) => extra.set(`${x},${yy},${z}`, v)
          // Кровати ставятся после крышки и досыпки, до щита и стенки: пол под
          // изножьями должен быть виден и с крышкой (b3-25: «C: пол под изножьем не видно»).
          if (lid) for (let k = 0; k < lid.h; k++) put(lid.x, lid.y + k, lid.z, 'block')
          for (const f of [X.fill, C.fill]) if (f) put(f.x, f.y, f.z, 'block')
          {
            const vb0 = virtualBot(bot, extra)
            const up = new Vec3(0, 1, 0)
            if (!C.reuse && !pick.faceAim(vb0, new Vec3(C.F.x, y - 1, C.F.z), up, { eye, avoid: [] })) { no('пол под C не видно'); continue }
            for (const c of cc) put(c.x, y, c.z, 'bed')
            if (!X.reuse && !pick.faceAim(virtualBot(bot, extra), new Vec3(X.F.x, y - 1, X.F.z), up, { eye, avoid: [] })) { no('пол под X не видно'); continue }
            // Щит и стенка — после кроватей: грань опоры каждого видна и ≤ 4.5
            // (b3: «щит не встал — не к чему прислонить», щит за кроватью).
            for (const c of xc) put(c.x, y, c.z, 'bed')
            const vb1 = virtualBot(bot, extra)
            const later = place.filter(p => !lidSet.has(`${p.x},${p.y},${p.z}`)).sort((a, b) => (walls.has(`${a.x},${a.z}`) ? 1 : 0) - (walls.has(`${b.x},${b.z}`) ? 1 : 0))
            let unreach = false
            for (const p of later) {
              if (!fillPlaceable(vb1, p, feet.offset(0, SNEAK_EYE, 0))) { unreach = true; break }
              put(p.x, p.y, p.z, 'block')
            }
            if (unreach) { no('до щита/стенки не дотянуться'); continue }
          }
          for (const p of place) put(p.x, p.y, p.z, 'block')
          for (const f of [X.fill, C.fill]) if (f) put(f.x, f.y, f.z, 'block')
          for (const c of xc) put(c.x, y, c.z, 'bed')
          for (const c of cc) put(c.x, y, c.z, 'bed')
          const vb = virtualBot(bot, extra)
          const far = (T) => cardOf(T.H.x + 0.5 - feet.x, T.H.z + 0.5 - feet.z)
          if (!bedPointFrom(vb, eye, [X.H, X.F], y, far(X))) { no('X не видно'); continue }
          // X взорвалась: её клетки — воздух.
          for (const c of xc) put(c.x, y, c.z, 'air')
          if (!bedPointFrom(vb, eye, [C.H, C.F], y, far(C))) { no('C не видно'); continue }
          if (lowRowsOpen(vb, feet, X.centre) > 0) { no('взрыв X видит нас'); continue }
          // C цела после X: все лучи от центра X к кровати C упираются в блоки.
          let cOpen = false
          for (const c of cc) for (const hy of [0.12, 0.45]) {
            const q = new Vec3(c.x + 0.5, y + hy, c.z + 0.5)
            const dv = q.minus(X.centre); const len = dv.norm()
            const hit = pick.blockOnRay(vb, X.centre, dv.scaled(1 / len), len - 0.05)
            if (!hit || /_bed$/.test(hit.block.name)) cOpen = true
          }
          if (cOpen) { no('щит не закрывает C'); continue }
          for (const c of cc) put(c.x, y, c.z, 'air')
          if (lowRowsOpen(vb, feet, C.centre) > 0) { no('взрыв C видит нас'); continue }
          const nPlace = place.length + (X.fill ? 1 : 0) + (C.fill ? 1 : 0)
          const xOver = cap != null && X.expect > cap ? (X.expect - cap) * 3 : 0
          const cost = -(X.expect + C.expect) + xOver + nPlace * 0.7 + walk * 1.2
          if (!best || cost < best.cost) {
            best = { S, y, feet, X, C, walls: [...walls.values()], shield: [...shield.values()], lid, place, nPlace, walk: r1(walk), cost, key: `${X.H.x},${X.H.z}|${C.H.x},${C.H.z}` }
          }
        }
      }
    }
  }
  bedsDouble.why = best ? null : why
  return best
}
declare namespace bedsDouble {
  let why: any
}

export {
  bedsLayout, bedsDouble
}
