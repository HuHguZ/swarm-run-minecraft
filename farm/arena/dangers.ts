'use strict'
// Угрозы бойцу (сообщения danger от демона): рывок прочь, стрейф и джук от прицела, заливка лавы, ответ тем, что в руках.
import { SEG_S, SOLO } from './context'
import { geared } from './gear'
import type { ArenaContext } from './context'

export function installDangers (ctx: ArenaContext) {
  const dz = dangerContext(ctx)
  const { bots } = dz
  installDodgeAway(dz)
  for (const b of bots) b.c.onDanger = (m) => onDanger(dz, b, m)
}

type DangerCtx = ReturnType<typeof dangerContext>

// Общее для реакций (прежние const installDangers): поля арены, текущая реакция бойца и её владение, эпизоды угроз,
// неудавшиеся выходы и их перепроверка по видимым клеткам.
function dangerContext (ctx: ArenaContext) {
  const { arms, bots, pos, busy, out, deadNow, X, Y, Z, R, L, log } = ctx
  // Поздний ответ не освобождает руки и не продолжает реакцию, уже заменённую другой.
  const reactions = new WeakMap<object, { round: number }>()
  const observations = new WeakMap<object, any>()
  const failures = new WeakMap<object, Map<string, any>>()
  const distance = (a, c) => Math.hypot(a.x - c.x, a.y - c.y, a.z - c.z)
  const cell = p => [Math.floor(p.x), Math.floor(p.y), Math.floor(p.z)].join(',')
  // Проверяем только видимые клетки подхода, без blocks_around с его обзором сквозь стены.
  const corridor = (from, to, key) => {
    const dx = to.x - from.x, dz = to.z - from.z, len = Math.hypot(dx, dz) || 1
    const cells = new Map<string, any>()
    for (let step = 0; step <= Math.min(4, Math.ceil(len)); step++) for (const dy of [-1, 0, 1, 2]) {
      const at = { x: Math.floor(from.x + dx / len * step), y: Math.floor(from.y) + dy, z: Math.floor(from.z + dz / len * step) }
      cells.set(cell(at), at)
    }
    for (const dy of [-1, 0, 1]) { const at = { x: Math.floor(to.x), y: Math.floor(to.y) + dy, z: Math.floor(to.z) }; cells.set(cell(at), at) }
    if (key === 'wind' || key === 'fly') for (const dy of [3, 4, 5, 6]) { const at = { x: Math.floor(from.x), y: Math.floor(from.y) + dy, z: Math.floor(from.z) }; cells.set(cell(at), at) }
    return [...cells.values()]
  }
  const inspect = (b, cells) => Promise.all(cells.map(at => b.c.call('swarm_pose', { at, inspectOnly: true }).then(r => {
    const block = (r?.detail || r)?.existing
    return block ? `${block.name}:${block.solid}` : null
  }).catch(() => null)))
  const retry = async (b, key, from, to) => {
    const old = failures.get(b)?.get(key)
    if (!old) return true
    const reopened = () => { failures.get(b)?.delete(key); return true }
    if (old.round !== ctx.round || distance(old.from, from) >= 1.5 || distance(old.to, to) >= 2) return reopened()
    const tactics = pos[b.name]?.tactics
    if (old.interrupted && tactics?.owner === 'Skill' && tactics.action === null && tactics.requireObservation === false) return reopened()
    if (old.resource && (pos[b.name]?.inv?.[old.resource] || 0) > old.count) return reopened()
    const blocks = await inspect(b, old.cells)
    return blocks.some((block, k) => block !== null && old.blocks[k] !== null && block !== old.blocks[k]) ? reopened() : false
  }
  const remember = async (b, key, from, to, detail, token) => {
    const why = [detail?.why, detail?.stop, detail?.stopped, detail?.error].filter(Boolean).join(' ')
    // Native item readiness is rechecked by the body; it is not a failed strategic route.
    if (/cooldown|перезаряд|только что/.test(why)) return
    const cells = corridor(from, to, key), blocks = await inspect(b, cells)
    if (!ownsReaction(b, token)) return
    const resource = /нет|не хватает|unavailable/.test(why) ? /лука|bow/.test(why) ? 'bow' : /элитр|elytra/.test(why) ? 'elytra' : ({ pearl: 'ender_pearl', fly: 'firework_rocket', wind: 'wind_charge', peek: 'arrow' })[key] : null
    if (!failures.has(b)) failures.set(b, new Map())
    failures.get(b)!.set(key, { round: ctx.round, from: { ...from }, to: { ...to }, cells, blocks,
      interrupted: /interrupt|cancel|прерван|занят/.test(why), resource, count: pos[b.name]?.inv?.[resource] || 0 })
  }
  const beginReaction = b => {
    const token = { round: ctx.round }
    reactions.set(b, token); busy.add(b.name)
    b.juking = b.lavaBusy = false
    return token
  }
  const ownsReaction = (b, token) => reactions.get(b) === token && token.round === ctx.round && !ctx.between && !out.has(b.name) && !deadNow.has(b.name)
  const endReaction = (b, token) => {
    if (reactions.get(b) !== token) return false
    reactions.delete(b); busy.delete(b.name)
    b.juking = b.lavaBusy = false
    return true
  }
  return { ctx, arms, bots, pos, busy, out, deadNow, X, Y, Z, R, L, log, reactions, observations, failures, distance, cell, corridor, inspect,
    retry, remember, beginReaction, ownsReaction, endReaction }
}

// Рывок прочь (ctx.dodgeAway): спринт с прыжками, запертому — прокоп выхода; неудачный выход запоминается.
function installDodgeAway (dz: DangerCtx) {
  const { ctx, log, failures, retry, remember, beginReaction, ownsReaction, endReaction } = dz
  ctx.dodgeAway = (o, me, from, dist, then: (() => void) | null = null, look: any = null, dropOk = false, digOk = dropOk) => {
    let ax = me.x - from.x; let az = me.z - from.z; const L0 = Math.hypot(ax, az)
    if (L0 < 0.5) { const a = Math.random() * 2 * Math.PI; ax = Math.cos(a); az = Math.sin(a) } else { ax /= L0; az /= L0 }
    const to = { x: me.x + ax * dist, y: me.y, z: me.z + az * dist }
    const key = `evade:${Math.round(ax * 4)},${Math.round(az * 4)}:${dropOk}:${digOk}`
    const run = () => {
      const token = beginReaction(o)
      // Рывок — спринт с прыжками (тело: evade), а не путь до точки (12.10: «бегать и прыгать при увороте»); прыгучесть — своя.
      const evade = () => o.c.call('evade', { dir: { x: ax, z: az }, ticks: Math.max(4, Math.min(26, dist / 0.33)), jump: Math.random() < (o.dodgeStyle?.jumpy ?? 0.75), look, dropOk })
      evade().then(async r => {
        if (!ownsReaction(o, token)) return
        let d = r?.detail || r
        // Заперт (своё укрытие, яма) под зельем, облаком, булавой — прокопать выход прочь и снова рывок (14.10: «в укрытии
        // сдох от облака, не стал раскапываться и убегать»).
        if (!d?.ok && digOk && /некуда/.test(d?.why || '')) {
          const dig = await o.c.call('dig_to', { at: { x: me.x + ax * 4, y: me.y, z: me.z + az * 4 }, maxSteps: 3, timeoutSeconds: 4 }).then(x => x?.detail || x).catch(() => null)
          if (!ownsReaction(o, token)) return
          log(`⛏ ${o.name}: заперт — ${dig?.dug ? `прокопал выход (${dig.dug} бл.)` : `не прокопать: ${dig?.why || '?'}`}`)
          if (dig?.dug) d = await evade().then(x => x?.detail || x).catch(() => null)
        }
        if (!ownsReaction(o, token)) return
        if (!d?.ok) { await remember(o, key, me, to, d, token); log(`⛔ ${o.name}: рывок не вышел — ${d?.why || r?.error || r?.status || '?'}`) }
      }).catch(e => { if (ownsReaction(o, token)) log(`⛔ ${o.name}: рывок — ${e.message}`) })
        .finally(() => { const owned = ownsReaction(o, token); if (endReaction(o, token) && owned && then) then() })
    }
    if (!failures.get(o)?.has(key)) run()
    else {
      const action = o.last, round = ctx.round
      retry(o, key, me, to).then(ok => { if (ok && o.last === action && ctx.round === round && !ctx.between) run() }).catch(() => {})
    }
  }
}

// Сообщение danger от демона: эпизоды угроз, выбор одной и ответ на неё.
function onDanger (dz: DangerCtx, b, m) {
  const { ctx, pos, busy, out, deadNow, log, reactions, observations, failures, distance } = dz
  if (ctx.between || out.has(b.name) || deadNow.has(b.name)) { observations.delete(b); failures.delete(b); return }
  if (!m.pos) return
  // На элитрах уворот клавишами пуст, а его вызов обрывает таран и перелёт (стенд 21.10, слот 30: «cancelled by evade»
  // в воздухе); от стрел и зелий в полёте уходит само тело (руль тарана).
  if (pos[b.name]?.gliding) return
  const d = m.dangers || {}
  let seen = observations.get(b)
  if (!seen || seen.round !== ctx.round) { if (seen) failures.delete(b); seen = { round: ctx.round, at: -Infinity, episodes: new Map() }; observations.set(b, seen) }
  const at = m.observedAt ?? Date.now()
  if (at < seen.at) return
  seen.at = at
  const episodes = new Map<string, any>()
  for (const [kind, sources] of [['fl', d.floor], ['tn', d.blasts], ['wb', d.web], ['sm', d.smashes], ['pt', d.potions], ['ar', d.arrows], ['am', d.aims], ['lv', d.lava?.filter(v => v.d <= 1.5)], ['cl', d.clouds]] as const) for (const src of sources || []) {
    // shortcut: wire danger has no projectile ID; launch position plus reset flight ETA distinguishes repeated throws until the protocol includes IDs.
    const key = `${kind}:${src.id ?? src.entityId ?? (kind === 'am' || kind === 'sm' ? src.name + ':' + (src.weapon || '') : JSON.stringify([src.name, src.from || src.at]))}`
    const old = seen.episodes.get(key)
    const episode = old && !(kind !== 'am' && src.ticks > old.src.ticks) ? old : { key, kind, handled: false, from: { ...m.pos } }
    episode.src = src; episodes.set(key, episode)
  }
  seen.episodes = episodes
  // Ноги всё ещё в лаве и выход кончился «не вышел» — снова выход, где бы ни стоял (иначе тот же эпизод ждёт сдвига на 1.5 бл.).
  // Только по ответу выхода: датчик даёт d = 0 и стоящему на краю ямы (рамка тела над лавой, ноги на полу) — выход отвечал
  // «вышел» сразу, и повтор шёл до 48 раз в секунду, срывая бои (стенд 15×15, a41 21.10: 1981 «🌋 0.0» у одного бота за минуту).
  const ready = kind => [...episodes.values()].find(e => e.kind === kind && !e.queued && (!e.handled || !reactions.has(b) && (distance(e.from, m.pos) >= 1.5 || kind === 'lv' && e.src.d < 0.5 && b.lavaStuck || m.status && kind === 'am' && failures.get(b)?.size)))
  const flE = ready('fl'), smE = ready('sm'), ptE = ready('pt'), arE = ready('ar'), amE = ready('am'), lvE = ready('lv'), clE = ready('cl')
  const fl = flE?.src, sm = smE?.src, pt = ptE?.src, ar = arE?.src, am = amE?.src, lv = lvE?.src, cl = clE?.src
  // Горящий динамит или блоки его цепочки рядом (датчик threats.blasts) — бег прочь от всех зарядов разом, пока они в
  // досягаемости (dodge_blast: конец по миру). Раньше арена динамит не видела вовсе: уходил только бой, и то от вагонетки
  // (пользователь 22.10: «взрываю динамит цепочкой, ставлю за ним — он не сворачивает вбок»). Идущий уход новые заряды
  // видит сам — его не перезапускать.
  const tnE = ready('tn')
  const blastBusy = !!b.blastRun && reactions.get(b) === b.blastRun
  if (tnE && !(lv && lv.d < 0.5) && !blastBusy) {
    for (const e of episodes.values()) if (e.kind === 'tn') { e.handled = true; e.from = { ...m.pos } }
    const all = d.blasts || []
    log(`💣 ${b.name}: динамит рядом (горит ${all.filter(c => c.primed).length}, в цепочке ${all.filter(c => !c.primed).length}, ближний фитиль ${Math.min(...all.map(c => c.fuse))} т) — ухожу от всех`)
    const token = dz.beginReaction(b); b.blastRun = token
    b.c.call('dodge_blast', {}).then(r => { const x = r?.detail || r; if (dz.ownsReaction(b, token) && x && !x.clear) log(`💣 ${b.name}: от динамита не ушёл — ${x.cornered ? 'некуда' : x.distance != null ? `в ${x.distance} бл. (${x.ended}, ${x.seconds} с)` : `${r?.status} ${JSON.stringify(r?.by || r?.error || '')}`}`) })
      .catch(() => {}).finally(() => { dz.endReaction(b, token); if (b.blastRun === token) b.blastRun = null })
    return
  }
  // Уход от динамита идёт — его не рвать: воронки от взрыва он обходит сам (stepSafe), прочее подождёт.
  if (blastBusy && !(lv && lv.d < 0.5)) return
  // Паутина на теле — срезать (clear_web): в ней шаг вчетверо медленнее, ни уйти, ни догнать, а прочие реакции бесполезны
  // (стенд бота-противника 22.10: паутина на боте — 10 с на месте под ударами, «бой ↔ бегство» каждую секунду). Пока
  // режет — не перезапускать; нечем (ни меча, ни ножниц) — не браться.
  const wb = [...episodes.values()].find(e => e.kind === 'wb')?.src
  const inv = pos[b.name]?.inv || {}
  if (wb && !(lv && lv.d < 0.5) && !(b.webRun && reactions.get(b) === b.webRun) && Object.keys(inv).some(k => inv[k] > 0 && /_sword$|^shears$/.test(k))) {
    log(`🕸 ${b.name}: в паутине (${wb.cells} кл.) — срезаю`)
    const token = dz.beginReaction(b); b.webRun = token
    b.c.call('clear_web', {}).then(r => { const x = r?.detail || r; if (dz.ownsReaction(b, token) && x && !x.ok) log(`🕸 ${b.name}: паутину не срезал — ${x.why || `${x.cut} из ${wb.cells}`}${r?.status && r.status !== 'done' ? ' ' + r.status : ''}`) })
      .catch(() => {}).finally(() => { dz.endReaction(b, token); if (b.webRun === token) b.webRun = null })
    return
  }
  if (b.webRun && reactions.get(b) === b.webRun) return
  // Пол уходит из-под ног при враге рядом (датчик тела threats.floorDanger: опора исчезла или трескается) — сойти сразу,
  // раньше всего, кроме выхода из лавы: в дыру летят за тик (игра пользователя 22.10: «ломаю блоки под ними — они в дырки
  // улетают, ничего не делают»).
  if (fl && !(lv && lv.d < 0.5)) {
    flE.handled = true; flE.from = { ...m.pos }
    log(`🕳 ${b.name}: пол уходит (${fl.holes} бл.), рядом ${fl.name} — схожу`)
    // Прочь от дыры, без спуска и копки: вниз — это и есть его ловушка.
    ctx.dodgeAway(b, m.pos, fl.at, 3, null, null, false, false)
    return
  }
  // Ноги в лаве (d < 0.5) — выход раньше всего: уворот от зелья, стрейф от прицела и шаг от стрелы, пока тело горит, —
  // смерть (a39: «🌋 0.0 → 🧪↯ рывок → ☠ tried to swim in lava»). Пока выход идёт (lavaBusy), других реакций не начинаю.
  const inLava = !!lv && lv.d < 0.5
  if (b.lavaBusy && reactions.has(b)) return
  const src = inLava ? lv : sm || pt || ar || am || lv || cl
  // Повтор той же опасности уже отсеян эпизодом; другая лава/облако тоже могут потребовать нового выхода.
  if (!src) return
  if (src === am && (busy.has(b.name) || seen.checking)) return
  if (reactions.has(b) && /^(pearl_to|fly_to|wind_jump)$/.test(b.last?.m || '') && !sm && !pt && !cl && !lv) return
  if (b.juking && !sm && !pt && !cl && !lv) return
  // Лезет к цели (столб, прокоп): от прицела и стрелы не дёргаться — рывок со столба хуже попадания; зелье и булава — да.
  if (b.climbing && !sm && !pt && !cl && !inLava) return
  const st = b.dodgeStyle || (b.dodgeStyle = { delay: 40 + Math.random() * 160, skip: 0.05 + Math.random() * 0.15, jumpy: 0.5 + Math.random() * 0.5 })
  const episode = inLava ? lvE : smE || ptE || arE || amE || lvE || clE
  // Вторая рука в состоянии тела — { item, durability } (armor.readOffHand). Чтение .name давало «нет щита», как только щит
  // надет: первая реакция на булаву поднимала щит, следующая — рывок (пользователь 21.10: «в последний момент вместо щита
  // убегать начинают — достаю и ваншот»; 31 смерть от булавы за 15 мин).
  const hand2 = pos[b.name]?.offHand
  const shieldNow = (pos[b.name]?.inv?.shield || 0) > 0 || /shield/.test(String(typeof hand2 === 'string' ? hand2 : hand2?.item ?? hand2?.name ?? ''))
  // В рукопашной (бой и враг ближе 4.5 бл.) от прицела и стрел не стрейфить: уворот рвёт бой (арена 14.10: один лучник
  // прицелился — трое бросили свои схватки, ни одного удара; пользователь: «рои вырезают друг друга до конца»).
  if ((src === am || src === ar) && b.last?.m === 'fight' && ctx.enemiesOf(b, m.pos).some(e => e.d <= 4.5 && !e.mob)) return
  // Штурм, добивание, сброс — идущий в атаку не бросает её ради уворота от прицела и стрелы: бой сам держит щит и шаг (стенд
  // 21.10, чемпион с луком: за 4 мин штурма 139 боёв синих оборвали evade/juke/wind_jump/peek_shot — урона ему ноль).
  const t = b.swarmTask
  if ((src === am || src === ar) && b.last?.m === 'fight' && t?.kind === 'fight' && (t.data?.assault || t.data?.finishing || t.data?.shove)) return
  // Вплотную — бить; недоступный выход запоминается отдельно от других способов реакции.
  if (src === am && (Math.random() < st.skip * 0.5 || distance(am.at, m.pos) <= 3)) return
  const recheck = episode.handled && distance(episode.from, m.pos) < 1.5
  episode.handled = true; episode.from = { ...m.pos }
  log(inLava ? `🌋 ${b.name}: лава в ${lv.d.toFixed(1)} бл. — выхожу (lava_escape)` : sm ? `☂ ${b.name}: ${sm.name} падает на меня (сядет через ${sm.ticks} т; ${sm.dbg}) — ${shieldNow ? 'щит к нему' : 'рывок'}` : pt ? `🧪↯ ${b.name}: летит ${pt.name}${pt.role ? ' (' + pt.role + ')' : ''}, ляжет через ${pt.ticks} т — рывок` : lv ? `🌋 ${b.name}: лава в ${lv.d.toFixed(1)} бл. — ${(pos[b.name]?.inv?.water_bucket || 0) > 0 ? 'заливаю водой' : 'отхожу'}` : am ? `🎯↔ ${b.name}: ${am.name} целится в меня (${am.weapon}) — стрейф` : ar ? `🏹↯ ${b.name}: летит ${ar.name}, через ${ar.ticks} т — шаг поперёк` : `🧪☁ ${b.name}: облако зелья — выхожу`)
  // Стрела — шаг поперёк её полёта (side от тела), на 3 бл.
  // Целится — зигзаг: шаг поперёк его линии, каждый раз в другую сторону (12.10: «стрейфить заранее, как только нацеливаюсь»).
  // Лава рядом (12.10: «лаву водой — заранее»): ведро воды есть — залить и забрать воду, нет — отойти. Только соседняя клетка
  // (≤ 1.5 бл.): ямы лавы на поле в 2–3 бл. рвали каждый поход мимо них рывком «отхожу» (арены 37–38, десятки за раунд) —
  // путь pathfinder'а и так лаву обходит.
  if (src === lv) { dangerLava(dz, b, m, lv); return }
  if (src === am) { dangerAim(dz, b, m, { am, st, seen, episode, recheck }); return }
  if (src === ar) { ctx.dodgeAway(b, m.pos, { x: m.pos.x - ar.side.x, z: m.pos.z - ar.side.z }, 3, null, ar.from); return }
  // Булава сверху, а щит есть (14.10: «друг с булавой спокойно их убил в полёте, они даже не смотрели» — рывок за 15 т, а он
  // правит полёт и добивает через секунду: 71 удар замечен, рывки не спасли). mace_smash нет в bypasses_shield (jar 1.21.11):
  // лицом к падающему и щит до посадки, потом бить его же. Щит встаёт за 5 т — позже, или щита нет, — рывок, как прежде.
  // Щит есть — держать его, пока его удар сверху виден (стойка whileSmash): рывок за 6–16 т его не уводит (правит полёт), а
  // щит держит и удар прямо сверху. Уже держу — не перезапускать: новый подъём — ещё 5 т без блока. Поздно (< 6 т) и идёт
  // бой — не рвать его: бой сам держит щит против булавы (mace/defend).
  if (sm && shieldNow) {
    if (b.shieldHold && reactions.get(b) === b.shieldHold || sm.ticks < 6 && b.last?.m === 'fight') return
    dangerShieldSmash(dz, b, m, sm); return
  }
  // Брызги ложатся в радиусе 4 (ThrownSplashPotion.applySplash), удар булавой — в 3.5: уйти надо на 4.5+ от точки. Ляжет
  // скоро (≤ 12 тиков) — спринт лицом по ходу (спиной вперёд — шагом, замер potion-above-3: 56 % зелий в цель); есть
  // время — пятиться, глядя на угрозу. От булавы — бежать, пока он не сел (mace-4: бой после рывка вёл назад под удар).
  const off = Math.hypot(m.pos.x - src.at.x, m.pos.z - src.at.z)
  // Без щита от булавы — бежать, только пока успеваем выйти из его досягаемости: 5 бл. от точки посадки спринтом 0.28 б/т
  // и 4 т на разгон. В последний миг рывок не уводит — он правит полёт и бьёт в спину (игра пользователя 22.10: «либо
  // убегать, но сразу, пока я ещё вверху»). Не успеваем — не дёргаться: идущий бой продолжается.
  if (sm && sm.ticks < Math.max(0, 5 - off) / 0.28 + 4) return
  const urgent = !!sm || (src.ticks ?? 99) <= 12
  ctx.dodgeAway(b, m.pos, src.at, src === cl ? cl.r + 2 : Math.max(2.5, 4.8 - off, sm ? (sm.ticks + 3) * 0.3 : 0) + Math.random(), sm ? () => { if (geared(pos[b.name])) b.cur = sm.name } : null, urgent ? null : sm ? sm.from : pt ? pt.at : null, !!(sm || pt), true)
}

function dangerLava (dz: DangerCtx, b, m, lv) {
  const { ctx, pos, beginReaction, endReaction } = dz
  // Уже в лаве (яма поля, 1 бл. глубиной): рывок по ровному «некуда» — край ямы на блок выше; путь pathfinder'а
  // выпрыгивает сам (арена 40: 31an 20 с в лаве — «рывок не вышел»).
  // Рывок у ям лавы поля часто «некуда» (край ямы, стены рядов) — и так каждые 1.5 с (ворота s13: 11 раз за 21 с); путь
  // pathfinder'а на 3 бл. прочь от лавы лаву обходит и выпрыгивает из неё.
  // Поток «окружение», 21.10 (DeepSeek t3, a27: 5 из 16 смертей в лаве; «goto на 3 бл.» — A* и запуск пути, пока лава
  // снимает 4 хп за 0.5 с, и отмена боя на кромке): в лаве (d < 0.5) или на кольце магмы (d ≤ 1.2) — быстрый выход демона
  // lava_escape (pvp/lava-exit: к ближайшей клетке поля, вперёд + прыжок + спринт, пока под ногами горит, без pathfinder'а);
  // в бою и дальше кромки — ничего: бой сам не шагает к лаве и не стоит к ней спиной (pvp/turn-melee edgeTurn, body.stepSafe).
  // Вода заранее — только вне боя (douse_lava отменяет бой: by "douse_lava").
  const fighting = b.last?.m === 'fight'
  // Враг рядом (16 бл.) — не заливать: прерванный залив оставляет воду, и в узкой комнате она держит бота под его мечом
  // (игра пользователя 22.10: «выливают воду в узком пространстве и не могут убежать из комнаты»).
  const foeNear = ctx.enemiesOf(b, m.pos).some(e => e.d < 16 && !e.mob)
  if (lv.d > 1.2 && !fighting && !foeNear && (pos[b.name]?.inv?.water_bucket || 0) > 0) { const token = beginReaction(b); b.lavaBusy = true; b.c.call('douse_lava', { at: lv.at }).catch(() => {}).finally(() => endReaction(b, token)) }
  else if (lv.d < 0.5 || (lv.d <= 1.2 && !fighting)) {
    const token = beginReaction(b); b.lavaBusy = true
    b.c.call('lava_escape', { limitMs: 2500 }).then(r => { const d = r?.detail || r; b.lavaStuck = d?.ok === false }).catch(() => { b.lavaStuck = false }).finally(() => endReaction(b, token))
  }
  return
}

function dangerAim (dz: DangerCtx, b, m, { am, st, seen, episode, recheck }) {
  const { ctx, arms, bots, pos, busy, out, deadNow, X, Y, Z, R, L, log, failures, retry, remember, beginReaction, ownsReaction, endReaction } = dz
  b.strafe = Math.random() < 0.7 ? -(b.strafe || (Math.random() < 0.5 ? 1 : -1)) : (b.strafe || 1)
  // Под обстрелом без ответа: уход определяется доступностью стрелка и оценкой боя.
  const ranged = Object.keys(pos[b.name]?.inv || {}).some(n => /^(bow|crossbow)$/.test(n)) && (pos[b.name]?.inv?.arrow || 0) > 0
  // Соло (люди против роя, 14.10: «с лука расстрелял — не уворачивались»): прочь — только от недосягаемого (выше 4+),
  // иначе зигзагом на него (juke advance): бегство по прямой и стрейф на месте — тир для лучника.
  // Слабый (лут, бегство, погоня) — только прочь: рывок к нему, жемчуг и бой из уворота ломали подготовку (Codex 15.10).
  const prep = b.swarmTask?.kind === 'flee' || !!b.swarmTask?.data?.weak
  const retreat = prep || !ranged && (am.at.y - m.pos.y > 4 || !SOLO && !ctx.swarmDriver.canEngage(b, am.name))
  const advance = SOLO && !retreat
  // Непрерывный джук тела (juke), пока он целится: рывки с паузами давали 80 % попаданий с 8 бл. (archer-roof-5).
  const juke = () => {
    if (retreat && Math.random() < 0.3) log(`🏃 ${b.name}: ${am.name} стреляет, а мне нечем — ухожу зигзагом`)
    const token = beginReaction(b); b.juking = true
    b.c.call('juke', { from: am.name, retreat, advance, jumpy: st.jumpy, maxTicks: advance ? 120 : 80 }).then(async r => { const d = r?.detail || r; if (ownsReaction(b, token) && (d?.ok === false || d?.segments === 0)) await remember(b, 'juke', m.pos, am.at, d, token) }).catch(() => {})
      .finally(() => endReaction(b, token))
  }
  // Что в руках — то и в ход (12.10: «ветер — ускорять себя, жемчуг — ближе к стрелку и резко атаковать, блоками
  // заставиться, на элитрах — если стоит тратить фейерверки; просто стрейфы — мало»). Вес — от положения (он выше,
  // далеко) и запаса, и у каждого броска — свой случай: одинаково не ходят.
  // Бой из уворота держит busy до ответа (иначе следующий уворот рвёт его; Codex 15.10).
  const fightHim = () => {
    const token = beginReaction(b)
    return (ctx.swarmDriver.canEngage(b, am.name)
      ? b.c.call('fight', { target: am.name, allowPlayer: true, allowRanged: true, timeoutSeconds: SEG_S, retreatAtHealth: 3, arena: { x: X + 0.5, y: Y, z: Z + 0.5, r: R, killY: arms ? Y + L.y0 - 3 : undefined } })
      : b.c.call('flee', { from: [am.name], timeoutSeconds: 3, safeDist: 14 })).catch(() => {}).finally(() => endReaction(b, token))
  }
  const act = (key, k, call, ok, after) => {
    const token = beginReaction(b)
    call().then(async r => { if (!ownsReaction(b, token)) return false; const d = r?.detail || r || {}; log(`${k} ${b.name} от прицела ${am.name}: ${ok(d) ? 'вышло' : 'нет'} — ${[d.how, d.stop, d.why, d.error].filter(Boolean).map(x => typeof x === 'object' ? JSON.stringify(x).slice(0, 160) : x).join(' ') || (d.rise != null ? 'взлёт ' + d.rise : '')}`); if (!ok(d)) await remember(b, key, m.pos, am.at, d, token); return ok(d) })
      .catch(async e => { if (ownsReaction(b, token)) await remember(b, key, m.pos, am.at, { error: e.message }, token); return false }).then(async good => {
        const owned = ownsReaction(b, token)
        if (!endReaction(b, token) || !owned || b.last?.m === 'fight' || seen.episodes.get(episode.key) !== episode) return
        if (good && after) after()
        else if (!good) {
          const action = b.last
          const canJuke = !failures.get(b)?.has('juke') || await retry(b, 'juke', pos[b.name]?.p || m.pos, am.at)
          if (canJuke && b.last === action && !busy.has(b.name) && ctx.round === seen.round && !ctx.between && seen.episodes.get(episode.key) === episode) juke()
        }
      }).catch(() => {})
  }
  const go = async () => {
    if (ctx.between || ctx.round !== seen.round || seen.episodes.get(episode.key) !== episode || out.has(b.name) || deadNow.has(b.name)) return
    if (busy.has(b.name) || seen.checking) { episode.handled = false; return }
    // За задержку уворота мог начаться бой вплотную — не рвать его (Codex 15.10: «целится → стрейф → 0/0 cancelled»).
    if (b.last?.m === 'fight' && ctx.enemiesOf(b, pos[b.name]?.p || m.pos).some(e => e.d <= 4.5 && !e.mob)) return
    if (prep) {
      if (!failures.get(b)?.has('juke')) { juke(); return }
      seen.checking = true
      const action = b.last
      try {
        const canJuke = await retry(b, 'juke', m.pos, am.at)
        const canCover = !canJuke && (!recheck || failures.get(b)?.has('cover')) && await retry(b, 'cover', m.pos, am.at)
        if (b.last !== action || busy.has(b.name) || ctx.round !== seen.round || seen.episodes.get(episode.key) !== episode) return
        if (canJuke) juke()
        else if (canCover) act('cover', '🧱', () => b.c.call('take_cover', { from: am.name, maxRun: 7 }), d => !!d.ok, null)
      } finally { seen.checking = false }
      return
    }
    if (ctx.swarmDriver.panic(b)) {
      const token = beginReaction(b)
      b.c.call('flee', { from: [am.name], timeoutSeconds: 3, safeDist: 14 }).catch(() => {}).finally(() => endReaction(b, token))
      return
    }
    const me = pos[b.name] || {}; const inv = me.inv || {}
    const dH = Math.hypot(am.at.x - m.pos.x, am.at.z - m.pos.z); const above = am.at.y - m.pos.y; const dist = Math.hypot(dH, above)
    const opts: { k: string, w: number }[] = [{ k: 'juke', w: 2 }]
    if ((inv.ender_pearl || 0) > 0 && dist >= 8 && dist <= 45 && (above > 3 || dH > 14)) opts.push({ k: 'pearl', w: above > 3 ? 5 : 3 })
    if ((inv.elytra || me.armor?.torso === 'elytra') && (inv.firework_rocket || 0) >= 4 && dist > 14) opts.push({ k: 'fly', w: 1.5 + (above > 6 ? 1.5 : 0) })
    // Против людей (соло) ветер — только вверх к нему: рывок вбок от трезубца уводил из боя (стенд 14.10, поле: 39 рывков,
    // контакт 18 % времени); уворот — зигзагом на него (juke advance).
    // У булавы заряды — на взлёт и удар с падения (стенд 21.10, чемпион: «не взлетаю — нет булавы или заряда», а заряды ушли
    // на уворот от прицела): уворот ветром — только из лишних, сверх двух на взлёт с повтором.
    if ((inv.wind_charge || 0) > (inv.mace ? 2 : 0) && (!SOLO || above > 2 && above < 8 && dH < 10)) opts.push({ k: 'wind', w: above > 2 && above < 8 && dH < 10 ? 4 : 1.5 })
    if (above > 3 || !ranged && !SOLO) opts.push({ k: 'cover', w: above > 3 ? 3.5 : 1.5 })
    // Есть лук — ответить из-за стенки в прыжке (13.10: «ставит блоки, прыгает и стреляет — очень крутой приём»).
    if (ranged && dist >= 8 && dist <= 35) opts.push({ k: 'peek', w: 3 })
    // Щит к нему (DeepSeek t7, стенд 21.10: стрелы — главный убийца синих, 60 из 131): стрела без Пронзания в щит не проходит
    // целиком (damage-model shieldBlocks), а зигзаг с 8 бл. ловил 80 % выстрелов. Щит встаёт за 5 т — до выстрела успевает.
    // Вплотную (≤ 6 бл.) — не стойка со щитом: он с луком в упор переключается на меч, а бот стоял под ударами и только
    // после них бежал (игра пользователя 22.10: «просто стоят, когда их атакуют, чего-то ждут»; 18 боёв за 2 раунда
    // оборвал «щит к нему»). Вторая рука в состоянии тела — { item }.
    const shield = (inv.shield || 0) > 0 || /shield/.test(String(me.offHand?.item ?? me.offHand?.name ?? me.offHand ?? ''))
    if (shield && dist > 6) opts.push({ k: 'shield', w: 6 })
    if (failures.get(b)?.size) {
      seen.checking = true
      const action = b.last
      try {
        const failed = opts.map(o => failures.get(b)?.has(o.k))
        const allowed = await Promise.all(opts.map(o => retry(b, o.k, m.pos, am.at)))
        if (b.last !== action || busy.has(b.name) || ctx.round !== seen.round || seen.episodes.get(episode.key) !== episode || ctx.between) return
        for (let k = opts.length - 1; k >= 0; k--) if (!allowed[k] || recheck && !failed[k]) opts.splice(k, 1)
      } finally { seen.checking = false }
      if (!opts.length) return
    }
    let sum = 0; for (const o of opts) { o.w *= 0.5 + Math.random(); sum += o.w }
    let r = Math.random() * sum; const pick = opts.find(o => (r -= o.w) <= 0) || opts[0]
    const at = { x: am.at.x, y: am.at.y, z: am.at.z }
    if (pick.k === 'pearl') act('pearl', '🟣', () => b.c.call('pearl_to', { to: at, edgeOk: true, yTop: 45 }), d => !!d.ok, fightHim)
    else if (pick.k === 'fly') act('fly', '🪽', () => b.c.call('fly_to', { at, timeoutSeconds: 20 }), d => !!d.ok, fightHim)
    else if (pick.k === 'wind') {
      const up = above > 2 && above < 8 && dH < 10
      const sd = Math.random() < 0.5 ? 1 : -1
      const to = up ? at : { x: m.pos.x + am.side.x * sd * 6, z: m.pos.z + am.side.z * sd * 6 }
      act('wind', '💨', () => b.c.call('wind_jump', up ? { up: true, toward: to } : { toward: to }), d => (d.used || 0) > 0, up ? fightHim : null)
    } else if (pick.k === 'cover') act('cover', '🧱', () => b.c.call('take_cover', { from: am.name, maxRun: 7 }), d => !!d.ok, null)
    else if (pick.k === 'peek') act('peek', '🏹🧱', () => b.c.call('peek_shot', { target: am.name, shots: 2 }), d => !!d.ok, null)
    else if (pick.k === 'shield') act('shield', '🛡', () => b.c.call('swarm_hold', { shield: true, requireShield: true, enemies: [am.name], allies: bots.filter(o => o.team === b.team).map(o => o.name), seconds: 1.5 }), d => d.ok !== false && (d.shield?.blockingSeconds ?? 0) > 0, null)
    else juke()
  }
  episode.queued = true
  setTimeout(() => { episode.queued = false; go().catch(() => {}) }, Math.random() * st.delay)
  return
}

function dangerShieldSmash (dz: DangerCtx, b, m, sm) {
  const { ctx, bots, pos, beginReaction, ownsReaction, endReaction } = dz
  const token = beginReaction(b)
  b.shieldHold = token
  // Держать, пока тело видит его удар сверху (whileSmash — датчик threats.smashes), а не по первой оценке посадки: он
  // подскакивает снова (заряд ветра, «Порыв ветра»), щит опускался между прыжками, новый подъём за 1–2 т до удара не держит
  // (5 т задержки), и бот в просвет бежал (игра пользователя 22.10: «до конца щитом прикрываться, пока я не упаду»).
  // seconds — только предохранитель.
  b.c.call('swarm_hold', { shield: true, requireShield: true, enemies: [sm.name], allies: bots.filter(o => o.team === b.team).map(o => o.name), whileSmash: sm.name, seconds: 20 })
    .then(r => { if (!ownsReaction(b, token)) return; const d = r?.detail || r; if (d?.ok === false && sm.ticks >= 12) ctx.dodgeAway(b, m.pos, sm.at, 3.5, null, null, true, true); else if (geared(pos[b.name])) b.cur = sm.name })
    .catch(() => {}).finally(() => { if (b.shieldHold === token) b.shieldHold = null; endReaction(b, token) })
  return
}
