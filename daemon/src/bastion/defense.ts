const { foesNear, pocketOpen }: typeof import('./tower-scan') = require('./tower-scan')
const { log, sleep, xyz, mobs, seesMob, goals, walkGoal, gameClock, inOwnTunnel, Vec3, fullCover, centerIn, SIDES4, aggressive }: typeof import('./take-gold-block') = require('./take-gold-block')
const { eatIfHungry }: typeof import('./predict-gold') = require('./predict-gold')
const { goldMode }: typeof import('./gold-mode') = require('./gold-mode')

async function bruteDefense (session, ctl, st, forced = null) {
  const bot = session.bot
  const pick: typeof import('.././pick') = require('.././pick')
  // Столб — только от того, кто идёт на нас: агрессивен (mob_flags бит 2 —
  const me0 = bot.entity.position
  // В своём закрытом штреке брут за стеной не страшен (нет луча — нет пути к нам): столба в штреке нет (потолок), а
  // «отхожу» pathfinder'ом выводил наружу (neF-R25-1 02.10: 40 вызовов «столба нет — отхожу» за секунду).
  if (!forced && inOwnTunnel(bot, st.sealedState) && !mobs(bot, 'piglin_brute', 12).some(e => seesMob(bot, e))) return false
  // Видит нас в своём штреке (пролом) — заложиться, а не столб.
  if (!forced && inOwnTunnel(bot, st.sealedState)) {
    const seer: any = mobs(bot, 'piglin_brute', 12).find(e => seesMob(bot, e))
    // ND_BRUTE_HUNKER=1: ход закрыт (пробоев нет), брут виден сквозь щель/неполный блок — пути к нам у него нет, и
    // закладывать нечего (D6-22 03.10: 19 раз «заложился» с n 0, exposed false — 13 мин стояния до конца этапа).
    if (seer && process.env.ND_BRUTE_HUNKER === '1' && seer.position.distanceTo(bot.entity.position) > 3.5 && !(require('.././sealed') as typeof import('.././sealed')).exposure(bot, st.sealedState.own).length) return false
    if (seer && await hunker(session, ctl, st, 'брут видит в штреке', seer)) return true
  }
  const brute = forced || mobs(bot, 'piglin_brute', 12).find((e : any) => {
    const d = e.position.distanceTo(me0)
    if (d < 6) return true
    if (!aggressive(bot, e) || !seesMob(bot, e)) return false
    // Идёт к нам: за последнюю секунду ближе на 1+ блок (st.bruteSeen — прошлые расстояния).
    const prev = st.bruteSeen.get(e.id)
    st.bruteSeen.set(e.id, { d, at: gameClock.now() })
    return prev && gameClock.now() - prev.at < 2500 && prev.d - d > 1
  })
  if (!brute) return false
  st.brutes++
  const t0 = gameClock.now()
  const base = bot.entity.position.floored()
  let pil = null
  try { pil = await (require('.././pearls') as typeof import('.././pearls')).emergencyPillar(bot, ctl) } catch (e) { pil = { ok: false, why: e.message } }
  if (!pil || !pil.ok) {
    // Столба не вышло (потолок, лава) — уйти от него.
    if (process.env.ND_GUARD !== '0') {
      const G: typeof import('.././ne-guard') = require('.././ne-guard')
      const bx: Awaited<ReturnType<typeof G.boxIn>> = await G.boxIn(bot, brute, { ctl }).catch(e => ({ ok: false, why: e.message }))
      if (bx.ok) {
        const sat = await G.sit(session, ctl, 25000)
        log('брут: коробка вместо столба', { placed: bx.placed, sat, hp: Math.round(bot.health ?? 0) })
        return true
      }
      log('брут: коробки нет', { why: bx.why, left: bx.left })
    }
    const me = bot.entity.position
    const dx = me.x - brute.position.x
    const dz = me.z - brute.position.z
    const n = Math.hypot(dx, dz) || 1
    log('брут: столба нет — отхожу', { why: pil && pil.why })
    await walkGoal(session, ctl, new goals.GoalNearXZ(Math.round(me.x + dx / n * 16), Math.round(me.z + dz / n * 16), 3), 12000)
    return true
  }
  const sword = bot.inventory.items().filter(i => /_sword$/.test(i.name)).sort((a, c) => (/netherite/.test(c.name) ? 4 : /diamond/.test(c.name) ? 3 : /iron/.test(c.name) ? 2 : 1) - (/netherite/.test(a.name) ? 4 : /diamond/.test(a.name) ? 3 : /iron/.test(a.name) ? 2 : 1))[0]
  let swings = 0
  let arrows = 0
  let lastSwing = 0
  let away = 0
  let close = 0
  while (!ctl.aborted && gameClock.now() - t0 < 60000) {
    const e = bot.entities[brute.id]
    if (!e || e.isValid === false) { st.fights.push('брут убит со столба'); break }
    const d = e.position.distanceTo(bot.entity.position)
    const flat = Math.hypot(e.position.x - bot.entity.position.x, e.position.z - bot.entity.position.z)
    if (flat < 4) close = gameClock.now()
    // Ушёл, или 12 с не подходит к столбу и не злится — слезть и дальше.
    if (d > 12) { if (!away) away = gameClock.now(); if (gameClock.now() - away > 6000) break } else away = 0
    if (gameClock.now() - Math.max(t0, close) > 12000 && !aggressive(bot, e)) break
    if (gameClock.now() - Math.max(t0, close) > 20000 && !arrows) break
    if (gameClock.now() - t0 > 45000 && !swings) break
    if ((bot.health ?? 20) < 6) break
    const below = e.position.y <= bot.entity.position.y - 1.5
    const a = below ? pick.aim(bot, e) : null
    if (a && a.point && gameClock.now() - lastSwing >= 650) {
      try {
        if (sword && (!bot.heldItem || bot.heldItem.name !== sword.name)) await bot.equip(sword, 'hand')
        await bot.lookAt(a.point, true)
        bot.attack(e)
        swings++
        lastSwing = gameClock.now()
      } catch {}
    } else if (!a && flat >= 3 && d <= 20 && seesMob(bot, e) && bot.inventory.items().some(i => i.name === 'bow') && bot.inventory.items().some(i => /arrow$/.test(i.name))) {
      // Не под столбом — лук: брут до нас не достаёт, а стрела достаёт его.
      try {
        const r = await (require('.././bow') as typeof import('.././bow')).shoot(bot, e, { shouldStop: () => ctl.aborted || !bot.entities[brute.id] })
        if (r && r.shot) arrows++
      } catch {}
    }
    await sleep(100)
  }
  log('брут со столба', { swings, arrows, hp: Math.round(bot.health ?? 0), alive: !!bot.entities[brute.id], s: Math.round((gameClock.now() - t0) / 1000) })
  // Слезть: копать столб под собой (блоки назад в рюкзак).
  try { await (require('.././pearls') as typeof import('.././pearls')).pillarDown(bot, ctl, session.mcData, base) } catch {}
  return true
}

function goldExposes (bot, S, pos) {
  const SL: typeof import('.././sealed') = require('.././sealed')
  for (const [dx, dy, dz] of SL.FACES) {
    const n = pos.offset(dx, dy, dz)
    if (S.own.has(SL.keyV(n))) continue
    const b = bot.blockAt(n)
    if (goldMode.fastSafe ? !fullCover(b) : (!b || b.boundingBox === 'empty' || /lava|water/.test(b.name))) return true
  }
  return false
}

async function hunker (session, ctl, st, why, attacker = null) {
  const bot = session.bot
  const SL: typeof import('.././sealed') = require('.././sealed')
  const S = st.sealedState
  if (!inOwnTunnel(bot, S) || SL.fillerCount(bot) < 3) return false
  try { bot.pathfinder.setGoal(null) } catch {}
  bot.clearControlStates()
  const t0 = gameClock.now()
  const seal = async () => {
    const r = await sealBody(bot, S)
    const top = bot.entity.position.floored().offset(0, 2, 0)
    const tb = bot.blockAt(top)
    if (tb && tb.boundingBox === 'empty' && !/lava|water/.test(tb.name) && await SL.fillCell(bot, top)) { S.own.delete(SL.keyV(top)); r.n++; (S.filled || (S.filled = new Set())).add(SL.keyV(top)) }
    return r
  }
  // В безопасном режиме сначала сохранить возможность отступления: sealBody закладывает и свой ход.
  let r = st.fastSafe ? { n: 0, left: [], risky: ['до заделки'] } : await seal()
  let stepped = false
  // Враг в соседней клетке (заложить нельзя) — шаг вглубь своего штрека, прочь от него, и заложиться снова.
  const foe = attacker || foesNear(bot, 4).sort((a: any, b: any) => a.position.distanceTo(bot.entity.position) - b.position.distanceTo(bot.entity.position))[0]
  if (r.risky.length && foe && foe.position.distanceTo(bot.entity.position) < 3.5) {
    const f = bot.entity.position.floored()
    const opts = []
    for (const [dx, dz] of SIDES4) {
      const c = f.offset(dx, 0, dz)
      const h = c.offset(0, 1, 0)
      const fl = c.offset(0, -1, 0)
      const bc = bot.blockAt(c); const bh = bot.blockAt(h); const bf = bot.blockAt(fl)
      if (!bc || !bh || !bf || bc.boundingBox !== 'empty' || bh.boundingBox !== 'empty' || bf.boundingBox !== 'block') continue
      if (!S.own.has(SL.keyV(c)) && !S.own.has(SL.keyV(h))) continue
      opts.push({ c, d: c.distanceTo(foe.position) })
    }
    opts.sort((a, b) => b.d - a.d)
    if (opts.length && opts[0].d > f.distanceTo(foe.position)) {
      const back = f
      stepped = await centerIn(bot, opts[0].c, 1500)
      if (stepped) {
        // Клетки, откуда ушли, — заложить (между нами и врагом).
        for (const v of [back.offset(0, 1, 0), back]) if (await SL.fillCell(bot, v)) { S.own.delete(SL.keyV(v)); (S.filled || (S.filled = new Set())).add(SL.keyV(v)) }
        r = await seal()
      }
    }
  }
  if (st.fastSafe && !stepped) r = await seal()
  S.exposed = SL.exposure(bot, S.own).length > 0
  st.hunkers = (st.hunkers || 0) + 1
  log('штрек: удар — заложился', { why, n: r.n, left: r.left.length, risky: r.risky.length, stepped, exposed: S.exposed, hp: Math.round(bot.health ?? 0), foe: foe ? foe.name : null })
  // Сидеть, пока злые рядом. Бьют и в кармане (враг уже внутри: R26 02.10 — пиглин в 0.3 бл., «заложился», 4 удара
  // за 4 с, 20 → 0) — не сидеть: бой с ближним (обычный пиглин — 16 хп, три удара железным мечом).
  let hp0 = bot.health ?? 20
  while (!ctl.aborted && gameClock.now() - t0 < 25000) {
    if (!foesNear(bot, 10).length && gameClock.now() - t0 > 4000) break
    const hp = bot.health ?? 20
    const inside: any = foesNear(bot, 2.2)[0]
    if (inside || hp <= hp0 - 3) {
      log('штрек: бьют в кармане — бой', { foe: inside ? inside.name : null, hp: Math.round(hp), was: Math.round(hp0) })
      return false
    }
    hp0 = Math.max(hp0, hp)
    if (hp < 16) await eatIfHungry(session, ctl)
    await sleep(400)
  }
  return true
}

function burrowColumn (bot, f) {
  const SL: typeof import('.././sealed') = require('.././sealed')
  const cls = v => SL.classOf(bot.blockAt(v))
  const safe = goldMode.fastSafe
  const cover = v => !safe || fullCover(bot.blockAt(v))
  const c = [f.offset(0, -1, 0), f.offset(0, -2, 0), f.offset(0, -3, 0)]
  if (!c.every(v => cls(v) === SL.SOLID && cover(v))) return false
  const fl = cls(f.offset(0, -4, 0))
  if (!(fl === SL.SOLID || fl === SL.HARD || fl === SL.GUARD) || !cover(f.offset(0, -4, 0))) return false
  for (const v of c) {
    for (const [dx, dy, dz] of SL.FACES) {
      if (dx === 0 && dz === 0) continue
      const k = cls(v.offset(dx, dy, dz))
      if ((k !== SL.SOLID && k !== SL.HARD && k !== SL.GUARD && k !== SL.FALL) || !cover(v.offset(dx, dy, dz))) return false
    }
  }
  // Ни лавы, ни воды в клетке под полом и вокруг пола.
  for (const [dx, dz] of [[0, 0], ...SIDES4]) if (cls(f.offset(dx, -4, dz)) === SL.FLUID || cls(f.offset(dx, -5, dz)) === SL.FLUID) return false
  return true
}

async function burrow (session, ctl, st, why = '') {
  // Вслепую — по видимому (nether-cover.coverHere): колонна burrowColumn выбиралась по скрытым блокам (Codex q9).
  if ((require('.././nether-cover') as typeof import('.././nether-cover')).blind()) return (require('.././nether-cover') as typeof import('.././nether-cover')).coverHere(session, ctl)
  const bot = session.bot
  const SL: typeof import('.././sealed') = require('.././sealed')
  if (SL.fillerCount(bot) < 2) return { ok: false, why: 'нечем заложить шахту' }
  if (!bot.entity.onGround) return { ok: false, why: 'не на земле' }
  const me = bot.entity.position.floored()
  // Уже в своём штреке/кармане — глубже не закапываться: штрек отсюда не начался не из-за открытого места, а повтор
  // спускал тело по 3 клетки за ход до самого дна Ада (neF-R21-1 02.10: тело на y 5, «пути нет» ×5000 ходов).
  const own0 = (require('.././tunnel') as typeof import('.././tunnel')).ownSet(session)
  if (own0.has(SL.keyV(me)) || own0.has(SL.keyV(me.offset(0, 1, 0))) || (st.sealedState && st.sealedState.own && st.sealedState.own.has(SL.keyV(me)))) return { ok: false, why: 'уже в своём штреке — закапываться глубже незачем' }
  if (me.y < 30) return { ok: false, why: `низко (y ${me.y}) — у дна Ада лава` }
  let f = burrowColumn(bot, me) ? me : null
  if (!f) {
    const cands = []
    for (let dx = -6; dx <= 6; dx++) {
      for (let dz = -6; dz <= 6; dz++) {
        for (let dy = -3; dy <= 3; dy++) {
          const v = me.offset(dx, dy, dz)
          const b = bot.blockAt(v); const h = bot.blockAt(v.offset(0, 1, 0))
          if (!b || !h || b.boundingBox !== 'empty' || h.boundingBox !== 'empty' || /lava|water|fire/.test(b.name + h.name)) continue
          if (!burrowColumn(bot, v)) continue
          cands.push({ v, d: Math.abs(dx) + Math.abs(dz) + 2 * Math.abs(dy) })
        }
      }
    }
    cands.sort((a, b) => a.d - b.d)
    for (const c of cands.slice(0, 3)) {
      const w = await walkGoal(session, ctl, new goals.GoalBlock(c.v.x, c.v.y, c.v.z), 12000, { dig: false })
      const at = bot.entity.position.floored()
      if (at.equals(c.v) && burrowColumn(bot, at)) { f = at; break }
      log('закопаться: к колонне не дошёл', { to: xyz(c.v), at: xyz(at), ok: w && w.ok })
    }
    if (!f) return { ok: false, why: cands.length ? 'к колонне не дошёл' : 'колонны в толще рядом нет' }
  }
  const safe = goldMode.fastSafe
  if (safe) { try { bot.pathfinder.setGoal(null) } catch {} ; bot.clearControlStates() }
  const centered = await centerIn(bot, f, 1500)
  if (safe && (!centered || !burrowColumn(bot, f))) return { ok: false, why: 'колонна изменилась или не встал' }
  for (let i = 1; i <= 3; i++) {
    if (safe && (ctl.aborted || (bot.health ?? 20) <= 0)) return { ok: false, why: 'закопаться: прервано' }
    const v = f.offset(0, -i, 0)
    const r = await SL.digCell(bot, v)
    if (r !== 'ok' && r !== 'air') return { ok: false, why: `копка ${xyz(v).x},${xyz(v).y},${xyz(v).z}: ${r}` }
    for (let k = 0; k < 20 && bot.entity.position.y > v.y + 0.2; k++) await sleep(50)
  }
  for (let k = 0; k < 20 && !bot.entity.onGround; k++) await sleep(50)
  if (safe && (!bot.entity.onGround || bot.entity.position.distanceTo(f.offset(0.5, -3, 0.5)) > 0.25)) return { ok: false, why: 'не приземлился на дно шахты' }
  const top = f.offset(0, -1, 0)
  const sealed = await SL.fillCell(bot, top)
  if (safe && (!sealed || !fullCover(bot.blockAt(top)))) return { ok: false, why: 'пробка не закрыла шахту' }
  const cells = [f.offset(0, -3, 0), f.offset(0, -2, 0)].map(v => SL.keyV(v))
  try { (require('.././tunnel') as typeof import('.././tunnel')).rememberOwn(session, new Set(cells)) } catch {}
  if (st.sealedState && st.sealedState.own) for (const k of cells) st.sealedState.own.add(k)
  st.burrows = (st.burrows || 0) + 1
  log('закопался', { why, at: xyz(bot.entity.position.floored()), sealed, moved: !f.equals(me) })
  return { ok: sealed, sealed, at: xyz(bot.entity.position.floored()) }
}

async function answerAttack (session, ctl, st) {
  const bot = session.bot
  const combat: typeof import('.././combat') = require('.././combat')
  const a = combat.liveAttacker(session)
  if (!a || !a.position || a.position.distanceTo(bot.entity.position) > 8) {
    // ND_BRUTE_HUNKER=1: брут ближе 9 бл., а ход вскрыт — заложиться до удара (D6-24 03.10: выход штреком после
    // бартера, брут — 3 удара за 2 с, 20 → 0; ответ на удар запаздывает). Не чаще раза в 8 с.
    const S = st.sealedState
    if (process.env.ND_BRUTE_HUNKER === '1' && S && S.exposed && gameClock.now() - (st.bruteHunkAt || 0) > 8000 && inOwnTunnel(bot, S)) {
      const b: any = mobs(bot, 'piglin_brute', 9).sort((x: any, y: any) => x.position.distanceTo(bot.entity.position) - y.position.distanceTo(bot.entity.position))[0]
      if (b) {
        st.bruteHunkAt = gameClock.now()
        st.preHunkers = (st.preHunkers || 0) + 1
        if (await hunker(session, ctl, st, `брут в ${b.position.distanceTo(bot.entity.position).toFixed(1)} бл.`, b)) return true
      }
    }
    return false
  }
  // В своём закрытом штреке — не бой и не столб: заложиться (hunker). Пиглин/брут/хоглин — у пролома к двору.
  // Обычный пиглин уже вплотную (≤ 2.5 бл.) — бой, а не заложиться: он в нашем ходу, клетку с ним не заложить.
  const close = a.position.distanceTo(bot.entity.position) < 2.5
  // Скелет (долина песка душ у бастиона) стреляет в наш ход: бой с ним из штрека — 25 с без удара (он ниже/за углом), 10
  // стрел за 27 с, 20 → 0 (neF-Sc26-2 02.10). Заложиться — луча нет, стрел нет.
  if (/^(piglin_brute|piglin|hoglin|zoglin|skeleton)$/.test(a.name || '') && !(a.name === 'piglin' && close) && inOwnTunnel(bot, st.sealedState) && await hunker(session, ctl, st, 'удар ' + a.name, a)) return true
  if (a.name === 'piglin_brute') { await bruteDefense(session, ctl, st, a); return true }
  if (process.env.ND_GUARD !== '0') {
    const G: typeof import('.././ne-guard') = require('.././ne-guard')
    if (G.HIDE_FROM.test(a.name || '') || G.meleeFoes(bot, 6).length >= 3 || (bot.health ?? 20) < 9) {
      const rr = await G.react(session, ctl, { force: { e: a, why: 'удар ' + a.name }, onOwn: cells => { if (st.sealedState && st.sealedState.own) for (const k of cells) st.sealedState.own.add(k) } })
      if (rr.cancelled || rr.acted === false) return false
      st.fights.push(a.name + ': ' + (rr.how || 'ответ'))
      return true
    }
  }
  try {
    const f = await combat.fight(session, ctl, { target: '#' + a.id, timeoutSeconds: 25, retreatAtHealth: 6, clearArea: 0 })
    st.fights.push(`${a.name}${f && (f.killed || (f.kills && f.kills.length)) ? ' убит' : ''}`)
  } catch (e) { st.fights.push(`${a.name}: ${e.message}`) }
  return true
}

async function sealBody (bot, S, keep: any = [], open: any = [], mouth = null, canContinue = () => true) {
  const SL: typeof import('.././sealed') = require('.././sealed')
  const f = bot.entity.position.floored()
  const body = [f, f.offset(0, 1, 0)]
  const K = q => SL.key(q.x, q.y, q.z)
  const inside = new Set([...body, ...keep, ...open].map(K))
  const want = new Map()
  const add = (q, pri) => {
    const k = K(q)
    if (inside.has(k) || want.has(k)) return
    const b = bot.blockAt(q)
    if (!b || b.boundingBox !== 'empty' || /lava|water/.test(b.name)) return
    want.set(k, { q, pri })
  }
  for (const c of body) for (let dx = -1; dx <= 1; dx++) for (let dz = -1; dz <= 1; dz++) if (dx || dz) add(c.offset(dx, 0, dz), dx && dz ? 2 : 1)
  for (const c of keep) for (const [dx, dy, dz] of SL.FACES) add(new Vec3(c.x + dx, c.y + dy, c.z + dz), 0)
  // Бока и зад рта (клетка над головой): наш штрек рядом со ртом давал бруту луч сквозь угол
  // (pit-v4-3 30.09: брут в угловой клетке на уровне головы, rel [0.94, 1, −1], два удара, хп 20→5).
  if (mouth) for (const [dx, dz] of [[mouth.d[1], mouth.d[0]], [-mouth.d[1], -mouth.d[0]], [-mouth.d[0], -mouth.d[1]]]) add(new Vec3(mouth.M.x + dx, mouth.M.y, mouth.M.z + dz), 1)
  let n = 0
  const left = []
  for (const { q } of [...want.values()].sort((a, b) => b.pri - a.pri)) {
    if (!canContinue()) { left.push(K(q)); break }
    if (await SL.fillCell(bot, q)) {
      S.own.delete(K(q)); n++
      if (goldMode.fastSafe) (S.filled || (S.filled = new Set())).add(K(q))
    } else left.push(K(q))
  }
  // Незаложенное — опасно, только если оттуда воздухом можно выйти наружу (туда придёт брут).
  const skip = new Set([...body, ...keep, ...open].map(K))
  if (mouth) skip.add(K(mouth.M))
  const risky = left.filter(k => pocketOpen(bot, k, skip))
  return { n, left, risky, breaches: SL.exposure(bot, S.own).length }
}

export { bruteDefense, goldExposes, hunker, burrowColumn, burrow, answerAttack, sealBody }
