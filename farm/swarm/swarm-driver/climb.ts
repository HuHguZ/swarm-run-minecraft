// Рой: натиск — схватить лучшее у врага, подъём к врагу (лестницы, столбы, пролом), пролом.
import { ownedCount } from '../../../daemon/src/swarm'
import { withinArena } from '../../../daemon/src/navigation/parkour/model'
import { BLOCK, distance, cellKey, inDropPile, PILE_MEMORY_MS, underArrowFire } from './common'
import { followLadder, readyLadder, runAscent } from './ascent'
import { currentTurn } from './lifecycle'
import type { SwarmPosition } from '../../../daemon/src/swarm/types'
import type { SwarmDriverCtx } from './common'

export function swarmClimb (sw: SwarmDriverCtx) {
  const { now, pos, log, arena, surfaceY, sandSpot, cooldown, detail, lootSafe, lootStep, bounded, lootArena, blast, go } = sw
  // Неудача — повтор по причине (retry.ts: бот ушёл с места на 2 бл. или подпись другая), а не через N секунд (пользователь
  // 21.10: «убрать костыли по секундам»). Подписи: клетка цели (грубо — сдвиг цели на 2+ бл.), запасы, видимая вещь.
  const failed = (b, key, sig = '') => sw.failed(b, key, sig), blocked = (b, key, sig = '') => sw.blocked(b, key, sig), cleared = key => sw.cleared(key)
  const coarse = p => `${Math.round(p.x / 2)},${Math.round(p.y / 2)},${Math.round(p.z / 2)}`
  const itemKey = (b, it) => `grab:${b.name}:${it.id ?? it.name + Math.round(it.at?.x) + Math.round(it.at?.z)}`
  const itemSig = (it, inv) => `${it.at ? coarse(it.at) : ''}|${Object.keys(inv).length}`
  // Вещи под ногами (пользователь 15.10: «бил деревянным мечом, а рядом трезубец лежал — отбежать, взять и мочить; постоянно
  // поглядывать на предметы на земле»): раз в 1.5 с — что лежит в 7 бл. (items_near: только что видно); лучше своего оружия
  // или брони в том же слоте, тотем, золотое яблоко, элитры — подбежать и взять (броню — надеть). В ближнем бою (враг в 3 бл.)
  // — только если вещь в 1.5 бл.
  const MAT = { wooden: 1, golden: 1.5, stone: 2, copper: 2.5, iron: 3, diamond: 4, netherite: 5 }
  const ARM = { leather: 1, golden: 1.5, chainmail: 2, copper: 2.5, iron: 3, diamond: 4, netherite: 5 }
  const weaponValue = n => n === 'mace' ? 5.5 : n === 'trident' ? 4.5 : /^(\w+)_(sword|axe|spear)$/.test(n) ? (MAT[n.split('_')[0]] || 0) : 0
  const armorOf = n => { const m = /^(\w+)_(helmet|chestplate|leggings|boots)$/.exec(n); return m ? { slot: { helmet: 'head', chestplate: 'torso', leggings: 'legs', boots: 'feet' }[m[2]], v: ARM[m[1]] || 0 } : null }
  const waitTactics = (b, r) => {
    const t = r?.state?.tactics
    if (r?.by?.type !== 'tactical' && !t?.requireObservation && !/^(Tactical|Emergency)$/.test(t?.owner || '')) return false
    b.swarmFightReply = { ...r, status: 'interrupted' }
    return true
  }
  const ascend = async (b, to, method, params) => {
    const pending = runAscent(b, pos[b.name], to,
      () => b.c.call(method, { ...params, _climb: true }).catch(e => ({ status: 'failed', error: e.message })), now)
    const run = b.swarmAscent, raw = await pending
    return run.stalled ? { ...raw, ascentStalled: true } : raw
  }
  async function leaveArrows(b, foe) {
    if (!underArrowFire(b, now())) return false
    const round = sw.generation
    const cover = await b.c.call('take_cover', { from: foe.id, maxRun: 7, localOnly: true, arena }).catch(e => ({ error: e.message }))
    if (round !== sw.generation || !sw.alive(b.name) || waitTactics(b, cover)) return true
    if (!detail(cover).ok) {
      const r = await b.c.call('flee', { from: [foe.id], timeoutSeconds: 3, safeDist: 14, arena }).catch(e => ({ error: e.message }))
      waitTactics(b, r)
    }
    return true
  }
  async function grab(b, board, teamLoot = false) {
    const looting = teamLoot || b.swarmTask?.kind === 'loot'
    if (!pos[b.name]?.p || b.climbing || underArrowFire(b, now()) || (cooldown.get(`grab:${b.name}`) || 0) > now()) return false
    const owner = b.swarmTurnOwner, round = sw.generation
    const owns = () => round === sw.generation && owner === b.swarmTurnOwner
    const active = (reply?) => owns() && currentTurn(sw, b, round) && !!pos[b.name]?.p && !underArrowFire(b, now()) &&
      !reply?.notStarted && reply?.code !== 'RESCUE_BUSY' && reply?.status !== 'interrupted' && reply?.status !== 'skipped'
    cooldown.set(`grab:${b.name}`, now() + 1500)
    const raw = await b.c.call('items_near', { radius: 7 }).catch(() => ({}))
    if (!active(raw)) return false
    const m = pos[b.name], inv = m?.inv || {}
    const pressure = feet => {
      let near = Infinity, exposed = false
      const time = now()
      for (const e of board.enemies()) if (time - e.seenAt < 1500) {
        const gap = distance(e.position, feet)
        near = Math.min(near, gap)
        if (gap <= 40 && e.sources?.includes(b.name)) exposed = true
      }
      return { near, exposed }
    }
    const safe = (it, d, { near, exposed }) => !(near < 5 && (d > 1.5 || armorOf(it.name)) || exposed && d > 1.5) &&
      (!looting || lootSafe(b, it.at, true))
    const risk = pressure(m.p), r = detail(raw)
    // У известного места гибели scavenge делит вещи между подходящими союзниками и сообщает об очищенном полу.
    const piles = teamLoot && r.items?.length ? sw.knownDrops?.(b)?.filter(d =>
      d.p && !d.empty && now() - d.at < PILE_MEMORY_MS && d.p.y > (arena.killY ?? -64) + 3) : null
    const best = Math.max(0, ...Object.keys(inv).map(weaponValue))
    const wear = slot => { const n = m.armor?.[slot]; const a = n && armorOf(n); return a ? a.v : 0 }
    const want = (r.items || []).find(it => {
      // Броня — не под носом у врага: надеть её — пауза, а он рядом бьёт (стенд 21.10, чемпион: «беру diamond_leggings в 0.8 бл.
      // (враг в 3 бл.)» — и смерть, пятеро за раунд); оружие, тотем, яблоко в 1.5 бл. — можно.
      // Под его прицелом (вижу его сейчас — значит, и он меня, до 40 бл.) — за вещами не бежать: выпавшее у убитого —
      // приманка, человек с яруса выше бил подбегающих по одному (игра пользователя 22.10: «на вещи прибежал — я его убил»).
      if (!it.at || !safe(it, it.d, risk)) return false
      if (piles?.some(d => inDropPile(it.at, d.p))) return false
      if (blocked(b, itemKey(b, it), itemSig(it, inv))) return false
      const a = armorOf(it.name)
      return weaponValue(it.name) > best + 0.4 || (a && a.v > wear(a.slot)) || /^(totem_of_undying|golden_apple|enchanted_golden_apple|elytra)$/.test(it.name) && !inv[it.name]
    })
    if (!want) return false
    // Пока бежит за вещью — b.climbing: прочие дела драйвера не рвут короткий забег («булава в 1.2 бл. — goal was changed»).
    const before = ownedCount({ inventory: inv, armor: m.armor }, want.name)
    let g: any = {}, s: any = null
    const claim = {}
    b.climbing = true
    b.grabbing = claim
    lootStep(b, want.at, 'grab')
    try {
      const approach = await b.c.call('goto', { ...bounded(want.at), range: 0.4, timeoutSeconds: 3, arena: lootArena(b), _hunt: true, _climb: true }).catch(e => ({ why: e.message }))
      if (!active(approach)) return false
      g = detail(approach)
      if (approach?.status === 'done' && g.arrived) {
        const feet = approach.state?.pos || (Number.isFinite(g.arrived.x) ? g.arrived : pos[b.name]?.p)
        if (!feet || !safe(want, distance(feet, want.at), pressure(feet))) return false
        const reply = await b.c.call('assist', { mode: 'pickup', item: want.name, ownedTarget: before + 1, maxD: 2, arena: lootArena(b), _climb: true }).catch(e => ({ why: e.message }))
        if (!active(reply)) return false
        const pickup = detail(reply)
        if (!pickup.ok) g.why = pickup.why || 'не подобрал'
      }
      s = await b.c.call('status').catch(() => null)
      if (!active(s)) return false
    } finally {
      if (owns() && b.grabbing === claim) { b.climbing = false; delete b.grabbing }
    }
    const got = !!s?.state && ownedCount(s.state, want.name) > before
    if (s?.state?.inventory) { pos[b.name].inv = s.state.inventory; pos[b.name].armor = s.state.armor || pos[b.name].armor }
    if (!got) failed(b, itemKey(b, want), itemSig(want, inv)); else cleared(itemKey(b, want))
    cooldown.set(`grab:${b.name}`, now() + 1500)
    log(`🫳 ${b.name}: беру ${want.name} в ${want.d} бл.${risk.near < 20 ? ` (враг в ${Math.round(risk.near)} бл.)` : ''} — ${got ? 'взял' : String(g.why || g.error || (g.arrived ? 'дошёл, не поднялось' : 'не дошёл')).slice(0, 40)}`)
    if (got && armorOf(want.name) && pressure(s.state.pos || pos[b.name].p).near >= 5) await b.c.call('armor', {}).catch(() => {})
    return got
  }
  async function climbTo(b, foe, at) {
    const m = pos[b.name], inv = m.inv || {}, dy = foe.position.y - m.p.y
    const blocks = Object.entries(inv).filter(([n]) => BLOCK.test(n)).reduce((s, [, c]: any) => s + c, 0)
    const pick = Object.keys(inv).some(n => /_pickaxe$/.test(n))
    // Под луком сначала короткий рассчитанный прыжок на уступ, а не стройка под стрелами.
    if (underArrowFire(b, now()) && (inv.wind_charge || 0) > 0 && !blocked(b, `wind:${b.name}`, coarse(at))) {
      const raw = await ascend(b, at, 'wind_leap', { toward: at, arena }), r = detail(raw)
      if (waitTactics(b, raw)) return true
      if (r.ok) return true
      failed(b, `wind:${b.name}`, coarse(at))
      if (raw.ascentStalled && await leaveArrows(b, foe)) return true
    }
    // Он на столбе или уступе прямо над нами (по горизонтали ≤ 4, выше на 3–14): динамит под его опору — взрыв ломает
    // столб/песчаник, он падает к нам.
    if (dy <= 4 && Math.hypot(foe.position.x - m.p.x, foe.position.z - m.p.z) <= 4 && await blast(b, foe.position, `под ${foe.id}`)) return true
    if ((inv.elytra || m.armor?.torso === 'elytra') && (inv.firework_rocket || 0) >= 5 && !blocked(b, `fly:${b.name}`, coarse(at))) {
      const raw = await ascend(b, at, 'fly_to', { at, timeoutSeconds: 15, arena }), r = detail(raw)
      if (waitTactics(b, raw)) return true
      if (!r.ok) failed(b, `fly:${b.name}`, coarse(at))
      log(`🪽 ${b.name}: лечу к ${foe.id} (+${Math.round(dy)}) — ${r.ok ? 'долетел' : String(r.why || 'нет').slice(0, 60)}`)
      if (r.ok) return true
      if (raw.ascentStalled && await leaveArrows(b, foe)) return true
    }
    // Жемчуг поднимается на 15–18 бл. (бросок 1.5 бл/т, гравитация 0.03): выше +16 — сперва лезть, бросать с яруса.
    // Жемчуг — 5 хп (ThrownEnderpearl.onHit, без брони): раненый им не лезет (бой роя 24.10: бросок с 7.4 хп → 2.4).
    if ((inv.ender_pearl || 0) > 0 && (m.hp ?? 20) > 10 && dy <= 16 && distance(m.p, foe.position) < 40 && !blocked(b, `pearl:${b.name}`, `${coarse(at)}|${inv.ender_pearl}`)) {
      const raw = await ascend(b, at, 'pearl_to', { to: at, observed: true, arena }), r = detail(raw)
      if (waitTactics(b, raw)) return true
      if (!r.ok) failed(b, `pearl:${b.name}`, `${coarse(at)}|${inv.ender_pearl}`)
      log(`🟣 ${b.name}: жемчуг к ${foe.id} (+${Math.round(dy)}) — ${r.ok ? 'долетел' : (typeof r.why === 'object' ? JSON.stringify(r.why) : String(r.stop || r.why || 'нет')).slice(0, 80)}`)
      if (r.ok) return true
      if (raw.ascentStalled && await leaveArrows(b, foe)) return true
    }
    // Готовая лестница своих, верх которой у цели (в 8 бл.), — по ней: строитель путей лезет по ступеням сам, блоки не нужны.
    const lad = readyLadder(sw, b, foe.position)
    if (lad) {
      const raw = await followLadder(sw, b, lad, arena), r = detail(raw)
      if (waitTactics(b, raw) || raw?.status === 'interrupted') return true
      const end = raw?.state?.pos || r.arrived || r.at || pos[b.name]?.p
      if (!(end?.y >= lad.top.y - .5)) {
        failed(b, `ladder:${b.name}:${cellKey(lad.base)}`)
        if (await leaveArrows(b, foe)) return true
      }
      log(`🪜 ${b.name}: по лестнице своих к ${foe.id} — ${r.arrived ? 'наверху' : String(r.why || r.error || 'нет').slice(0, 60)}`)
      return true
    }
    // Короткий столбик к нему (он рядом, выше на 2–3: край крыши) — блоков на высоту + 1; к далёкой цели — с запасом.
    const needBlocks = Math.hypot(foe.position.x - m.p.x, foe.position.z - m.p.z) < 4 && dy <= 4 ? Math.ceil(dy) + 1 : Math.min(dy + 4, 20)
    // Маршрут не нашёлся (отказ за доли секунды) — не повторять тот же подъём с того же места (иначе сотни попыток в минуту),
    // пока цель не сдвинулась и запасов столько же: с киркой — прокоп ступенями к цели, без — добыча блоков ниже.
    const climbSig = `${coarse(at)}|${blocks >= needBlocks}|${pick}`
    const climbOk = !blocked(b, `climb:${b.name}`, climbSig)
    if ((blocks >= needBlocks || pick) && climbOk) {
      // Сектор у цели наверху бывает в воздухе (над рядами) — после отказа прямо к цели. Пока лезет — b.climbing: обмены, лут,
      // «прикрываю» и уворот от прицела его не дёргают (watch.ts, dangers.ts).
      const t0 = now(), goal = b.climbMiss ? foe.position : at, from = { ...m.p }
      // Отрезками по 8 бл. к цели (стенд 14.10: одним походом на +30 — «пути нет»; пешком с песка выше первого пояса не дойти):
      // короткий поиск со стройкой и прокопом дешёвый — стенку пояса перескочит столбиком, где пусто — столб.
      const span = distance(m.p, goal), k = Math.min(1, 8 / Math.max(span, 1))
      const wp = { x: m.p.x + (goal.x - m.p.x) * k, y: m.p.y + (goal.y - m.p.y) * k, z: m.p.z + (goal.z - m.p.z) * k }
      // Точка отрезка — на поверхность (ступень, проход), а не внутрь засыпки рядов на прямой.
      if (k < 1 && surfaceY) { const sy = surfaceY(wp.x, wp.z, goal.y); if (sy != null) wp.y = sy }
      // Последний отрезок — к нему самому (его пол точно есть), ровно на его высоту: сектор рядом бывает в стене коридора или
      // в воздухе у края крыши, и «дошёл» засчитывался внизу. Промежуточные — по поверхности модели (ступени, проходы) без
      // exactY: точка в воздухе на прямой заставляла строить столбы в коридоре с потолком (галерея: контакт 92 → 157 с).
      const last = k >= 1, dest = last ? foe.position : wp
      const raw = await ascend(b, dest, 'goto', { ...bounded(dest), range: 1.5, timeoutSeconds: 15, arena, climb: true, exactY: last, _hunt: true }), r = detail(raw)
      if (waitTactics(b, raw)) return true
      const failed = !r.arrived && (now() - t0 < 1500 || /no path|пути нет/i.test(String(r.why || r.error || r.stopped || '')))
      // Поднялся на 3+ почти на месте — построил столб: место под лестницу своим (ladder_up).
      const end = raw?.state?.pos || r.arrived || r.at || pos[b.name]?.p
      if (end && end.y - from.y >= 3 && Math.hypot(end.x - from.x, end.z - from.z) <= 1.5) {
        // (столбы лезущих больше не места лестниц — места из модели)
      }
      b.climbMiss = failed && !b.climbMiss
      // Точка вне арены — повтор той же точки бессмыслен: пауза сразу (31aj, выступ 15.10: 33 отказа «outside arena bounds» за 83 с).
      const boundary = /arena bounds/.test(String(r.why || r.error || ''))
      if (failed && (!b.climbMiss || boundary)) sw.failed(b, `climb:${b.name}`, climbSig)
      if (boundary) log(`🧗 ${b.name}: точка подъёма вне арены — ${[dest.x, dest.y, dest.z].map(v => Math.round(v)).join(',')} (цель ${[foe.position.x, foe.position.y, foe.position.z].map(v => Math.round(v)).join(',')})`)
      // Пришёл, а выше не стал (на 1+ бл.) — 4 с без подъёма: бить/копать/ждать своих, а не тот же поход по кругу.
      const gain = (end?.y ?? from.y) - from.y
      if (!failed && gain < 1 && foe.position.y - (end?.y ?? from.y) > 3) sw.failed(b, `climb:${b.name}`, climbSig)
      // В журнал — отказ и приход наверх (отрезки по 8 бл. — сотни строк за прогон).
      if (failed || k >= 1) log(`🧗 ${b.name}: лезу к ${foe.id} (+${Math.round(dy)}, блоков ${blocks}${pick ? ', кирка' : ''}) — ${r.arrived ? `дошёл, ${Math.round(r.arrived.y - foe.position.y)} по высоте от него` : String(r.why || r.stopped || r.error || (failed ? 'пути нет' : 'не дошёл')).slice(0, 60)}`)
      if (underArrowFire(b, now()) && (!r.arrived || gain < 1 && foe.position.y - (end?.y ?? from.y) > 3)) {
        sw.failed(b, `climb:${b.name}`, climbSig)
        await leaveArrows(b, foe)
      }
      return true
    }
    // Повтор отказавшего подъёма и добыча блоков на линии стрелка дороже короткого выхода за угол.
    if (await leaveArrows(b, foe)) return true
    if (pick && !climbOk && await breach(b, at)) return true
    if (blocks >= needBlocks) return false
    if ((cooldown.get(`dig:${b.name}`) || 0) > now() || blocked(b, `dig:${b.name}`)) return false
    cooldown.set(`dig:${b.name}`, now() + 3000) // частота опроса, не неудача
    const raw = await b.c.call('mine', { block: 'sand,red_sand,dirt,grass_block,coarse_dirt', count: Math.min(32, Math.ceil(dy) + 6), radius: 32, timeoutSeconds: 20 }).catch(e => ({ why: e.message }))
    const r = detail(raw)
    log(`🏖 ${b.name}: блоков на подъём нет — копаю руками (${foe.id} на +${Math.round(dy)}): ${r.dug ?? 0} шт.${r.why ? ` (${String(r.why).slice(0, 60)})` : ''}${r.dug ? '' : ` [${raw?.status || '-'}${r.stopped ? ' ' + r.stopped : ''}${r.problems ? ' ' + String(r.problems.at(-1)).slice(0, 50) : ''}${raw?.error ? ' ' + String(raw.error).slice(0, 50) : ''}]`}`)
    if (!r.dug) { failed(b, `dig:${b.name}`); if (sandSpot && distance(m.p, sandSpot) > 12) { await go(b, sandSpot, 6, 8); return true } }
    return (r.dug || 0) > 0
  }
  async function breach(b, at, visibleEntrance?: string) {
    const key = `breach:${b.name}`, sig = visibleEntrance ? cellKey(at) + ':' + visibleEntrance : coarse(at)
    if ((cooldown.get(key) || 0) > now() || blocked(b, key, sig)) return false
    const me = pos[b.name]?.p, inv = pos[b.name]?.inv || {}
    if (me && !Object.keys(inv).some(n => /_pickaxe$/.test(n) && inv[n] > 0)) {
      if (visibleEntrance) return false
      const d = distance(me, at) || 1
      if (await blast(b, { x: me.x + (at.x - me.x) / d * 2, y: me.y, z: me.z + (at.z - me.z) / d * 2 }, 'в стену к цели')) return true
    }
    cooldown.set(key, now() + 2000) // частота опроса, не неудача
    const raw = await b.c.call('dig_to', { at: { x: at.x, y: at.y, z: at.z }, arena, maxSteps: visibleEntrance ? 1 : 6, timeoutSeconds: 8 }).catch(e => ({ why: e.message }))
    const r = detail(raw)
    if (!r.dug) {
      if (!r.ok && !raw?.notStarted && raw?.status !== 'interrupted' && raw?.status !== 'skipped') failed(b, key, sig)
      return false
    }
    log(`⛏ ${b.name}: прокапываюсь к цели — ${r.dug} бл.${r.ok ? ', дошёл' : r.why ? ` (${r.why})` : ''}`)
    return true
  }
  // Место броска под верхней целью h — по линии от цели к середине арены: поле у подножия рядов (24–30 бл. от неё по
  // горизонтали: туда дойти просто, а одиночный бросок в прыжке по высокой дуге берёт +30 — стенд 21.10: 8 из 8 с первого
  // раза, посадка в 1 бл. от сундука крыши) или ряды ближе к цели, если с поля выше +30 (венец +33 — с поля 0 из 2). Высота —
  // по поверхности модели. Место, откуда броска не нашлось или куда не дошёл, — своей записью неудачи (retry.ts).
  const spotKey = (b, c) => `pearlSpot:${b.name}:${c.x},${c.y},${c.z}`
  const avoidKey = bounds => (bounds?.avoid || []).map(e => coarse(e) + '/' + Math.round(e.r)).sort().join('|')
  const loggedFeet = (p: SwarmPosition) => [p.x, p.y, p.z].map(n => Math.round(n * 100) / 100).join(',')
  const launches = new Map<string, SwarmPosition[]>()
  // Клетки, откуда уже было «нет броска» или куда не удалось дойти ради этой цели в этом раунде (гасит цикл 800×).
  const deadSpots = new Map<string, Set<string>>()
  let launchRound = sw.generation
  const deadFor = (targetKey: string) => {
    let set = deadSpots.get(targetKey)
    if (!set) deadSpots.set(targetKey, set = new Set())
    return set
  }
  const launchSpot = (b, h, from, bounds, danger: string, reports: SwarmPosition[] = [], dead?: Set<string>) => {
    const center = arena ?? from
    const dx = center.x - h.x, dz = center.z - h.z, d = Math.hypot(dx, dz) || 1
    const spots: any[] = []
    for (const r of surfaceY ? [26, 24, 28, 22, 30, 18, 14, 10] : []) {
      const x = h.x + dx / d * r, z = h.z + dz / d * r, y = surfaceY(x, z, h.y - 4)
      if (y == null || h.y - y < 4 || h.y - y > 33) continue
      const cell = { x: Math.floor(x), y, z: Math.floor(z) }
      const spot = { x: cell.x + .5, y, z: cell.z + .5, cell }
      if (distance(spot, from) <= 1.5 || !withinArena(b, spot, bounds) || blocked(b, spotKey(b, cell)) || dead?.has(cellKey(cell))) continue
      spots.push({ spot, high: h.y - y > 30 })
    }
    let best = spots.sort((p, q) => Number(p.high) - Number(q.high) || distance(p.spot, from) - distance(q.spot, from))[0]?.spot
    for (const report of reports) {
      const gap = distance(report, from)
      if (best && gap > distance(best, from) || !withinArena(b, report, bounds)) continue
      const cell = { x: Math.floor(report.x), y: Math.floor(report.y), z: Math.floor(report.z) }
      const fine = Math.hypot(report.x - from.x, report.z - from.z) <= 2 && Math.abs(report.y - from.y) <= .08
      const retry = fine ? `pearlStand:${b.name}:${cellKey(report)}` : `pearlWalk:${b.name}:${cellKey(cell)}`
      if (!blocked(b, retry, fine ? danger : '')) best = { ...report, cell, fine, retry }
    }
    return best
  }
  // Наверх жемчугом (пользователь 21.10: «каждый с первого раза точно математическим расчётом закидывает на самый верх, берёт
  // незерит»): отсюда есть бросок (pearl_plan: посадка у цели, дуга по блокам, разброс, бросок в прыжке) — бросить (pearl_up);
  // нет — к месту броска (launchSpot), бросит следующий ход. null — жемчуга нет или этот подъём отсюда уже не вышел.
  // Ответ: { arrived } — долетел; { moved } — идёт к месту броска; { arrived: false, why } — бросок не удался.
  async function pearlUp (b, h) {
    const inv = pos[b.name]?.inv || {}, me = pos[b.name]?.p
    if (!me || me.y <= arena?.killY || !((inv.ender_pearl || 0) > 0) || (pos[b.name]?.hp ?? 20) <= 10) return null
    const round = sw.generation, owner = b.swarmTurnOwner
    const ownsTurn = () => round === sw.generation && owner === b.swarmTurnOwner
    const stopped = () => !ownsTurn() || !currentTurn(sw, b, round) || underArrowFire(b, now())
    if (launchRound !== round) { launches.clear(); deadSpots.clear(); launchRound = round }
    const to = { x: h.x, y: h.y, z: h.z }, key = `pearlUp:${b.name}:${cellKey(to)}`
    const hopMode = (inv.ender_pearl || 0) >= 2 ? 2 : 1
    const reportKey = `${b.team || b.name}:${cellKey(to)}`, reports = launches.get(reportKey)
    const reportCount = reports?.length || 0
    const routeArena = () => lootArena?.(b) ?? arena
    const signature = bounds => [inv.ender_pearl, reportCount, avoidKey(bounds)].join('|')
    const bounds = routeArena()
    if (stopped()) return { moved: true }
    if (blocked(b, key, signature(bounds)) || !withinArena(b, to, bounds)) return null
    const here = { x: Math.floor(me.x), y: Math.floor(me.y), z: Math.floor(me.z) }
    const dangerNow = avoidKey(bounds)
    const teamTag = b.team || b.name
    const targetKey = `${teamTag}:${cellKey(to)}:${hopMode}:${dangerNow}`
    const dead = deadFor(targetKey)
    // Два жемчуга и больше — сразу бросок с цепочкой до двух (pearl-hop.planRoute: промежуточная посадка на ярусе); один —
    // только если отсюда есть одиночный бросок (pearl_plan). Броска нет — к месту броска (следующий ход бросит оттуда).
    const preview = (inv.ender_pearl || 0) === 1
    const check = preview ? await b.c.call('pearl_plan', { to, arena: bounds }).catch(e => ({ why: e.message })) : null
    if (stopped() || check?.notStarted || check?.status === 'interrupted' || check?.status === 'skipped') return { moved: true }
    const plan = preview ? detail(check) : { ok: true, arc: 'цепочка', jump: '' }
    const launchBounds = preview ? routeArena() : bounds
    if (!withinArena(b, to, launchBounds)) return null
    let why = plan.why
    if (plan.ok) {
      b.climbing = true
      delete b.swarmPearlPost
      const raw = await b.c.call('pearl_up', { to, arena: launchBounds, maxHops: 2, _climb: true }).catch(e => ({ why: e.message })).finally(() => { if (ownsTurn()) b.climbing = false })
      if (stopped() || raw?.notStarted || raw?.status === 'interrupted' || raw?.status === 'skipped') return { moved: true }
      const r = detail(raw)
      const footing = (!raw?.status || raw.status === 'done') && !r.ok && r.hops > 0 && r.stop === 'нет броска' && r.partialLanding
      const partial = footing && [footing.x, footing.y, footing.z].every(Number.isFinite) && withinArena(b, footing, launchBounds)
      const outcome = r.ok ? 'долетел' : partial ? 'сел на промежуточную опору, дальше нет броска' : String(r.stop || (typeof r.why === 'object' ? JSON.stringify(r.why) : r.why) || 'нет').slice(0, 80)
      log(`🟣 ${b.name}: жемчугом наверх (+${Math.round(h.y - me.y)}, ${plan.jump || 'с места'}, ${plan.arc}) — ${outcome}${r.at ? ' → ' + cellKey(r.at) : ''}, цель ${cellKey(to)}`)
      if (r.ok) {
        delete b.swarmPearlSpot
        if (r.hops > 0 && r.landing?.y > me.y && [r.landing.x, r.landing.y, r.landing.z].every(Number.isFinite) && withinArena(b, r.landing, launchBounds))
          b.swarmPearlPost = { at: r.landing, round }
        if (r.hops > 0 && r.launchAt && [r.launchAt.x, r.launchAt.y, r.launchAt.z].every(Number.isFinite)) {
          const sites = launches.get(reportKey) ?? []
          // Two certified positions can have different arcs inside one block. Coalesce overlapping .08-block stances.
          if (!sites.some(p => distance(p, r.launchAt) <= .16)) {
            sites.push({ ...r.launchAt })
            launches.set(reportKey, sites)
          }
        }
        cleared(key); return { arrived: true, at: r.at }
      }
      // Бросил и не долетел — неудача с этого места; не нашёл броска (жемчуг цел) — к месту броска.
      if (r.hops || r.stop !== 'нет броска') {
        delete b.swarmPearlSpot
        failed(b, key, signature(launchBounds))
        return { arrived: false, why: r.stop || r.why, ...(partial && { at: footing }) }
      }
      // «Нет броска» после подхода к выбранной стойке: закрываем эту стойку, чтобы не зацикливаться 800×.
      // Делимся пустыми клетками пола внутри команды (hopMode=2), чтобы 6 союзников на старте не долбили одни и те же клетки.
      if (hopMode === 2) dead.add(cellKey(here))
      if (b.swarmPearlSpot?.targetKey === targetKey) {
        dead.add(b.swarmPearlSpot.spotCell)
        failed(b, spotKey(b, b.swarmPearlSpot.cell))
        delete b.swarmPearlSpot
      }
      why = r.why || r.stop
    }
    failed(b, spotKey(b, here)) // отсюда броска нет — это место броска не годится (пока стоим тут)
    const walkBounds = routeArena()
    if (!withinArena(b, to, walkBounds)) return null
    const danger = avoidKey(walkBounds)
    const walkDead = deadFor(`${teamTag}:${cellKey(to)}:${hopMode}:${danger}`)
    const spot = launchSpot(b, h, me, walkBounds, danger, reports, walkDead)
    if (!spot) { failed(b, key, signature(walkBounds)); log(`🟣 ${b.name}: наверх (+${Math.round(h.y - me.y)}) броска нет — ${JSON.stringify(why || '?').slice(0, 90)}, цель ${cellKey(to)}`); return null }
    // К месту броска — с подъёмом (ряды ступенями: без climb путь по ним часто «не найден»).
    b.climbing = true
    const at = { x: spot.x, y: spot.y, z: spot.z }
    const walk = spot.fine
      ? b.c.call('pearl_stand', { at, arena: walkBounds, _climb: true })
      : b.c.call('goto', { ...at, range: spot.retry ? 0 : .75, timeoutSeconds: 16, arena: walkBounds, climb: true, exactY: true, _climb: true, _hunt: true })
    const raw: any = await walk.catch(e => ({ status: 'failed', why: e.message })).finally(() => { if (ownsTurn()) b.climbing = false })
    const r = detail(raw)
    // Поход оборвали (смена фазы, тревога) — не неудача места.
    if (raw?.notStarted || raw?.status === 'interrupted' || raw?.status === 'skipped' || stopped()) return { moved: true }
    const arrived = spot.fine ? r.ok : r.arrived
    log(`🟣 ${b.name}: к месту броска наверх ${loggedFeet(at)} (цель +${Math.round(h.y - spot.y)}) — ${arrived ? 'на месте' : String(r.why || r.stopped || 'не дошёл').slice(0, 50)}, цель ${cellKey(to)}${spot.fine && r.at ? ', ноги ' + loggedFeet(r.at) : ''}`)
    const endPos = raw?.state?.pos || (typeof r.arrived === 'object' ? r.arrived : null) || r.at || pos[b.name]?.p
    const stayedInPlace = !spot.retry && !!arrived && !!endPos && distance(endPos, me) < .25
    // A reported arrival can still be off the footing. Reprice the shot, then try another approach if nothing changed.
    if (spot.retry || !arrived || stayedInPlace) {
      failed(b, spot.retry ?? spotKey(b, spot.cell), spot.fine ? danger : '')
      if (!spot.retry && (!arrived || stayedInPlace)) walkDead.add(cellKey(spot.cell))
    }
    if (!spot.retry && arrived && !stayedInPlace) b.swarmPearlSpot = { targetKey: `${teamTag}:${cellKey(to)}:${hopMode}:${danger}`, spotCell: cellKey(spot.cell), cell: spot.cell }
    return { moved: true }
  }
  return { MAT, ARM, weaponValue, armorOf, grab, climbTo, breach, pearlUp }
}
