'use strict'
// Угрозы бойцу: выход из опасной области и защита от булавы; уворот от снарядов подмешивает тело.
import { SEG_S } from './context'
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
  const { bots, pos, busy, out, deadNow, log } = ctx
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
  const inspect = async (b, cells) => {
    const batch = await b.c.call('swarm_pose', { cells, inspectOnly: true }).catch(() => null)
    if (!batch || batch.status && batch.status !== 'done') return cells.map(() => null)
    const rows = (batch?.detail || batch)?.cells
    const value = row => row?.existing ? `${row.existing.name}:${row.existing.solid}` : null
    if (Array.isArray(rows)) return cells.map((at, k) => ['x', 'y', 'z'].every(axis => rows[k]?.at?.[axis] === at[axis]) ? value(rows[k]) : null)
    // Older bodies still expose one observed block per request; an absent value remains unknown, never air.
    return Promise.all(cells.map(at => b.c.call('swarm_pose', { at, inspectOnly: true }).then(r => value(r?.detail || r)).catch(() => null)))
  }
  const retry = async (b, key, from, to) => {
    const old = failures.get(b)?.get(key)
    if (!old) return true
    const reopened = () => { failures.get(b)?.delete(key); return true }
    if (old.round !== ctx.round || distance(old.from, from) >= 1.5 || distance(old.to, to) >= 2) return reopened()
    const tactics = pos[b.name]?.tactics
    if (old.interrupted && tactics?.owner === 'Skill' && tactics.action === null && tactics.requireObservation === false) return reopened()
    if (old.resource && (pos[b.name]?.inv?.[old.resource] || 0) > old.count) return reopened()
    const blocks = await inspect(b, old.cells)
    return blocks.some((block, k) => block !== null && block !== old.blocks[k]) ? reopened() : false
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
  return { ctx, bots, pos, busy, out, deadNow, log, reactions, observations, failures, distance, cell, corridor, inspect,
    retry, remember, beginReaction, ownsReaction, endReaction }
}

// Рывок прочь (ctx.dodgeAway): спринт с прыжками, запертому — прокоп выхода; неудачный выход запоминается.
function installDodgeAway (dz: DangerCtx) {
  const { ctx, log, failures, retry, remember, beginReaction, ownsReaction, endReaction } = dz
  ctx.dodgeAway = (o, me, from, dist, then: (() => void) | null = null, look: any = null, dropOk = false, digOk = dropOk, maxDrop = 3, minRun = 0) => {
    let ax = me.x - from.x; let az = me.z - from.z; const L0 = Math.hypot(ax, az)
    if (L0 < 0.5) { const a = Math.random() * 2 * Math.PI; ax = Math.cos(a); az = Math.sin(a) } else { ax /= L0; az /= L0 }
    const to = { x: me.x + ax * dist, y: me.y, z: me.z + az * dist }
    const key = `evade:${Math.round(ax * 4)},${Math.round(az * 4)}:${dropOk}:${digOk}:${maxDrop}`
    const run = () => {
      const token = beginReaction(o)
      // Рывок — спринт с прыжками (тело: evade), а не путь до точки (12.10: «бегать и прыгать при увороте»); прыгучесть — своя.
      const evade = () => o.c.call('evade', { dir: { x: ax, z: az }, ticks: Math.max(4, Math.min(26, dist / 0.33)), jump: Math.random() < (o.dodgeStyle?.jumpy ?? 0.75), look, dropOk, maxDrop, ...(minRun ? { minRun } : {}) })
      return evade().then(async r => {
        if (!ownsReaction(o, token)) return
        let d = r?.detail || r
        // Заперт (своё укрытие, яма) под зельем, облаком, булавой — прокопать выход прочь и снова рывок (14.10: «в укрытии
        // сдох от облака, не стал раскапываться и убегать»).
        if (!d?.ok && digOk && /некуда/.test(d?.why || '')) {
          const dig = await o.c.call('dig_to', { at: { x: me.x + ax * 4, y: me.y, z: me.z + az * 4 }, maxSteps: 3, timeoutSeconds: 4 }).then(x => x?.detail || x).catch(() => null)
          if (!ownsReaction(o, token)) return
          log(`⛏ ${o.name}: заперт — ${dig?.dug ? `прокопал выход (${dig.dug} бл.)` : `не прокопать: ${dig?.why || '?'}`}`)
          if (dig?.dug) { r = await evade().catch(() => null); d = r?.detail || r }
        }
        if (!ownsReaction(o, token)) return
        const ok = !!d?.ok && (!r?.status || r.status === 'done')
        if (!ok) { await remember(o, key, me, to, { ...d, error: r?.error || d?.error, stop: r?.status === 'interrupted' ? r.status : d?.stop }, token); log(`⛔ ${o.name}: рывок не вышел — ${d?.why || r?.error || r?.status || '?'}`) }
        return ownsReaction(o, token) ? ok : undefined
      }).catch(e => { if (ownsReaction(o, token)) { log(`⛔ ${o.name}: рывок — ${e.message}`); return false } })
        .finally(() => { const owned = ownsReaction(o, token); if (endReaction(o, token) && owned && then) then() })
    }
    if (!failures.get(o)?.has(key)) return run()
    else {
      const action = o.last, round = ctx.round
      return retry(o, key, me, to).then(ok => { if (o.last === action && ctx.round === round && !ctx.between) return ok ? run() : false }).catch(() => false)
    }
  }
}

// Сообщение danger от демона: эпизоды угроз, выбор одной и ответ на неё.
function onDanger (dz: DangerCtx, b, m) {
  const { ctx, pos, out, deadNow, log, reactions, observations, failures, distance } = dz
  if (m.descent) { log(`⬇ ${b.name}: спрыгнул на ${Math.round(m.descent.height * 10) / 10} бл. — ${m.descent.technique}`); return }
  if (ctx.between || out.has(b.name) || deadNow.has(b.name)) { observations.delete(b); failures.delete(b); delete b.arrowThreat; delete b.maceDefense; return }
  if (!m.pos) return
  const d = m.dangers || {}
  let seen = observations.get(b)
  if (!seen || seen.round !== ctx.round) { if (seen) failures.delete(b); seen = { round: ctx.round, at: -Infinity, episodes: new Map() }; observations.set(b, seen) }
  const at = m.observedAt ?? Date.now()
  if (at < seen.at) return
  seen.at = at
  // Драйвер читает давление для цены пути и лута; прицел и полёт снаряда не забирают дело у тела.
  b.arrowThreat = { at, active: !!d.aims?.length || !!d.arrows?.length || !!d.potions?.length }
  if (pos[b.name]?.gliding) return
  // Секунда между прыжками на ветре — та же атака: бой/уворот уже отвечает, плану нельзя вставить stop или лечение.
  if (b.maceDefense?.round !== ctx.round || b.maceDefense?.until <= Date.now()) delete b.maceDefense
  if (d.smashes?.length) b.maceDefense = { round: ctx.round, name: d.smashes[0].name, until: Date.now() + 1000 }
  const episodes = new Map<string, any>()
  for (const [kind, sources] of [['fl', d.floor], ['tn', d.blasts], ['wb', d.web], ['sm', d.smashes], ['lv', d.lava?.filter(v => v.d <= 1.5)], ['cl', d.clouds]] as const) for (const src of sources || []) {
    const key = `${kind}:${src.id ?? src.entityId ?? (kind === 'sm' ? src.name + ':' + (src.weapon || '') : JSON.stringify([src.name, src.from || src.at]))}`
    const old = seen.episodes.get(key)
    const episode = old && !(kind !== 'sm' && src.ticks > old.src.ticks) ? old : { key, kind, handled: false, from: { ...m.pos } }
    episode.src = src; episodes.set(key, episode)
  }
  seen.episodes = episodes
  // Ноги всё ещё в лаве и выход кончился «не вышел» — снова выход, где бы ни стоял (иначе тот же эпизод ждёт сдвига на 1.5 бл.).
  // Только по ответу выхода: датчик даёт d = 0 и стоящему на краю ямы (рамка тела над лавой, ноги на полу) — выход отвечал
  // «вышел» сразу, и повтор шёл до 48 раз в секунду, срывая бои (стенд 15×15, a41 21.10: 1981 «🌋 0.0» у одного бота за минуту).
  const ready = kind => [...episodes.values()].find(e => e.kind === kind && !e.queued && (!e.handled || !reactions.has(b) && (kind === 'sm' || distance(e.from, m.pos) >= 1.5 || kind === 'lv' && e.src.d < 0.5 && b.lavaStuck)))
  const flE = ready('fl'), smE = ready('sm'), lvE = ready('lv'), clE = ready('cl')
  const fl = flE?.src, sm = smE?.src, lv = lvE?.src, cl = clE?.src
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
  const maceBusy = b.maceDefense && b.last?.pending !== false &&
    (b.last?.m === 'fight' && b.last.p?.target === b.maceDefense.name || b.last?.m === 'evade' && reactions.has(b) ||
      b.last?.m === 'swarm_hold' && (b.shieldHold && b.shieldHold === reactions.get(b) || b.smashWeb && b.smashWeb === reactions.get(b)))
  if (maceBusy && !(lv && lv.d < 0.5)) return
  // В бою цену выхода считает webTurn; clear_web — внебоевой fallback, без отмены fight каждые 0.4 с.
  const wbE = [...episodes.values()].find(e => e.kind === 'wb'), wb = wbE?.src
  const inv = pos[b.name]?.inv || {}
  const webTools = Object.keys(inv).filter(k => inv[k] > 0 && /_sword$|^shears$|^water_bucket$|^ender_pearl$/.test(k)).sort().map(k => `${k}:${inv[k]}`).join('|')
  const webFight = b.last?.m === 'fight' && b.last.pending !== false
  const webFoes = wb ? ctx.enemiesOf(b, m.pos) : []
  // Контакт принадлежит бою; сближение во время резки считает тело по направленной скорости.
  const webThreat = !!wb && (!!sm || !!d.aims?.length || webFoes.some(e => e.d <= 3))
  const webInputs = `${JSON.stringify(wb)}|${webTools}|${webThreat}|${webFoes.map(e => `${e.n}:${Math.floor(e.p.x)},${Math.floor(e.p.y)},${Math.floor(e.p.z)}`).sort().join(';')}`
  if (wbE && wbE.inputs !== webInputs) { wbE.inputs = webInputs; wbE.handled = false }
  // Враг рядом, а резку вне боя он сорвал (direct_threat) или контакт уже идёт — в бой: выход из паутины под мечом считает
  // webTurn (резка/вода/жемчуг/щит по цене). Игра пользователя 24.10: «застревают в паутине» — clear_web отказывал
  // direct_threat 25 раз подряд, а боя никто не начинал.
  const webFoe = webFoes.filter(e => !e.mob && e.d <= 8).sort((a, c) => a.d - c.d)[0]
  // Резать нечем (рукой — 20 с) или резку срывает враг — позвать ближайшего свободного своего с мечом или ножницами: подойдёт
  // и срежет паутину на мне (пользователь 25.10: «научи просить союзников с оружием вытащить из паутины, особенно если рядом»).
  if (wb && (!/_sword|shears/.test(webTools) || (wbE.refused || 0) >= 1) && !(b.webHelper && ctx.alive?.(b.webHelper.name) !== false)) {
    const helper = dz.bots.filter(o => o !== b && o.team === b.team && ctx.alive?.(o.name) !== false && !dz.busy.has(o.name) && !reactions.has(o) && !o.webRescue && !o.swarmReserved && pos[o.name]?.p &&
        !pos[o.name].rescuing && !pos[o.name].gliding && !pos[o.name].combo && !(o.last?.pending !== false && /^(fight|wind_receive|wind_boost)$/.test(o.last?.m || '')) &&
        Object.keys(pos[o.name].inv || {}).some(k => /_sword$|^shears$/.test(k) && pos[o.name].inv[k] > 0) &&
        ![...(dz.observations.get(o)?.episodes?.values() || [])].some((e: any) => e.kind === 'wb') && !wbE.helpFailed?.has(o.name) && !o.climbing && distance(pos[o.name].p, m.pos) <= 24)
      .sort((x, y) => distance(pos[x.name].p, m.pos) - distance(pos[y.name].p, m.pos))[0]
    if (helper) {
      const rescue = { target: b.name, round: ctx.round }
      const token = dz.beginReaction(helper)
      b.webHelper = helper; helper.webRescue = rescue
      const at = { ...m.pos }
      const helping = () => rescue.round === ctx.round && !ctx.between && ctx.alive?.(b.name) !== false && ctx.alive?.(helper.name) !== false &&
        !out.has(b.name) && !deadNow.has(b.name) && !out.has(helper.name) && !deadNow.has(helper.name) &&
        observations.get(b)?.episodes.get(wbE.key) === wbE && b.webHelper === helper && helper.webRescue === rescue && dz.ownsReaction(helper, token)
      log(`🕸🤝 ${b.name}: застрял в паутине${/_sword|shears/.test(webTools) ? '' : ' без меча'} — зову ${helper.name} (${distance(pos[helper.name].p, at).toFixed(0)} бл.)`)
      ;(async () => {
        if (helper.swarmExecuting) {
          await helper.c.call('stop').catch(() => {})
          const until = Date.now() + 3000
          while (helper.swarmExecuting && helping() && Date.now() < until) await new Promise(resolve => setTimeout(resolve, 50))
          if (!helping()) return
          if (helper.swarmExecuting) { (wbE.helpFailed ||= new Set()).add(helper.name); return }
        }
        if (!helping()) return
        // Не дошёл или не достал — в этой паутине его больше не звать (игра 25.10: f 4 раза подряд «не достаю», пока j резали).
        const g = distance(pos[helper.name].p, at) > 3 ? await helper.c.call('goto', { x: at.x, y: at.y, z: at.z, range: 2.5, timeoutSeconds: 6 }).catch(e => ({ status: e.message })) : null
        if (!helping()) return
        const r = await helper.c.call('cut_ally_web', { target: b.name }).catch(e => ({ detail: { why: e.message } }))
        if (!helping()) return
        const x = r?.detail || r
        if (!x?.ok) (wbE.helpFailed ||= new Set()).add(helper.name)
        log(`🕸🤝 ${helper.name} → ${b.name}: ${x?.ok ? `вырезал (${x.cut})` : `не вырезал — ${x?.why || r?.status || '?'}${g ? `, подход: ${g.detail?.reason || g.status || '?'}` : ''}`}`)
      })().finally(() => { dz.endReaction(helper, token); if (helper.webRescue === rescue) helper.webRescue = null; if (b.webHelper === helper && helper.webRescue?.target !== b.name) b.webHelper = null })
    }
  }
  // Режет паутину, а человек подошёл на удар — резку бросить и драться из паутины: бот 12 с «срезал» силой под булавой и не
  // отвечал (игра пользователя 24.10).
  if (wb && webFoe && webFoe.d <= 4.5 && b.last?.m === 'clear_web' && b.last.pending !== false) wbE.handled = false
  if (wb && !wbE.handled && !webFight && (webThreat || wbE.threatened || webFoe?.d <= 4.5) && webFoe && !(lv && lv.d < 0.5) && !(b.shieldHold && reactions.get(b) === b.shieldHold) && !(b.webRun && reactions.get(b) === b.webRun && !(b.last?.m === 'clear_web' && webFoe.d <= 4.5))) {
    wbE.handled = true; wbE.threatened = false
    log(`🕸⚔ ${b.name}: в паутине, ${webFoe.n} в ${webFoe.d.toFixed(1)} бл. — выход из боя (webTurn)`)
    const token = dz.beginReaction(b); b.webRun = token
    b.c.call('fight', { target: webFoe.n, allowPlayer: true, allowRanged: true, timeoutSeconds: SEG_S, retreatAtHealth: 3 })
      .catch(() => {}).finally(() => { dz.endReaction(b, token); if (b.webRun === token) b.webRun = null })
    return
  }
  if (wb && !wbE.handled && !webFight && !webThreat && !(lv && lv.d < 0.5) && !(b.shieldHold && reactions.get(b) === b.shieldHold) && !(b.webRun && reactions.get(b) === b.webRun)) {
    wbE.handled = true; wbE.from = { ...m.pos }
    log(`🕸 ${b.name}: в паутине (${wb.cells} кл.) — срезаю`)
    const token = dz.beginReaction(b); b.webRun = token
    // Два отказа «direct_threat» подряд без врага в 8 бл. (стрелок издали, огонь) — резать всё равно: стоять в паутине
    // под стрелами хуже (бой роя 24.10: «срезаю» 217 раз, отказ 211 — висели в паутине).
    b.c.call('clear_web', { allies: dz.bots.filter(o => o.team === b.team).map(o => o.name), force: (wbE.refused || 0) >= 2 && !webFoe }).then(r => { const x = r?.detail || r; if (!dz.ownsReaction(b, token)) return; if (r?.status && r.status !== 'done') wbE.handled = false; if (x?.why === 'direct_threat') { wbE.threatened = true; wbE.handled = false; wbE.refused = (wbE.refused || 0) + 1 }; if (x && !x.ok) log(`🕸 ${b.name}: паутину не срезал — ${x.why || `${x.cut} из ${wb.cells}`}${r?.status && r.status !== 'done' ? ' ' + r.status : ''}`) })
      .catch(() => { if (dz.ownsReaction(b, token)) wbE.handled = false }).finally(() => { dz.endReaction(b, token); if (b.webRun === token) b.webRun = null })
    return
  }
  if (b.webRun && reactions.get(b) === b.webRun) return
  // Видно разрушение опоры или слышно близкую копку (датчик тела threats.floorDanger) — сойти сразу,
  // раньше всего, кроме выхода из лавы: в дыру летят за тик (игра пользователя 22.10: «ломаю блоки под ними — они в дырки
  // улетают, ничего не делают»).
  // Щит к булаве уже поднят — не сходить: шаг рвёт щит, а удар сверху — ваншот, дыра — нет (игра пользователя 22.10: «пол
  // уходит — схожу» 12 раз за секунду, щит опускался, убит булавой). Щит ещё не поднят — сперва сойти, как прежде.
  // Не чаще раза в 1.5 с: та же дыра рядом после шага снова «уходит», и сходы шли по 12 за секунду, обрывая бой под его мечом.
  if (fl && !(lv && lv.d < 0.5) && !(b.shieldHold && reactions.get(b) === b.shieldHold) && !(Date.now() - (b.floorAt || 0) < 1500)) {
    flE.handled = true; flE.from = { ...m.pos }; b.floorAt = Date.now()
    log(`🕳 ${b.name}: ${fl.signal === 'sound' ? 'слышу копку рядом' : `вижу, как пол уходит (${fl.holes} событий)`} — схожу`)
    // Прочь от дыры, без спуска и копки: вниз — это и есть его ловушка.
    ctx.dodgeAway(b, m.pos, fl.at, 3, null, null, false, false, 0)
    return
  }
  // Лава под ногами требует отдельного выхода; прицел и снаряды остаются параллельным слоем тела.
  const inLava = !!lv && lv.d < 0.5
  if (b.lavaBusy && reactions.has(b)) return
  const src = inLava ? lv : sm || lv || cl
  if (!src) return
  if (b.climbing && !b.grabbing && !sm && !cl && !inLava) return
  const episode = inLava ? lvE : smE || lvE || clE
  // Вторая рука в состоянии тела — { item, durability }, а не { name }.
  const hand2 = pos[b.name]?.offHand
  const offName = String(typeof hand2 === 'string' ? hand2 : hand2?.item ?? hand2?.name ?? '')
  // Тотем в левой руке при хп ≤ 16 тело на щит не меняет (combat/shield.ts) — щита нет: стойка «щит к нему» без щита стояла
  // 17 с под его булавой в коридоре (игра пользователя 25.10). Тогда — защита боем.
  const shieldNow = /shield/.test(offName) || (pos[b.name]?.inv?.shield || 0) > 0 && !(/totem_of_undying/.test(offName) && (pos[b.name]?.hp ?? 20) <= 16)
  episode.handled = true; episode.from = { ...m.pos }
  if (src !== cl) log(inLava ? `🌋 ${b.name}: лава в ${lv.d.toFixed(1)} бл. — выхожу (lava_escape)` : sm ? `☂ ${b.name}: ${sm.name} падает на меня (сядет через ${sm.ticks} т; ${sm.dbg}) — ${shieldNow ? 'щит к нему' : inv.cobweb > 0 ? 'паутина и защита' : 'защита в бою'}` : `🌋 ${b.name}: лава в ${lv.d.toFixed(1)} бл. — ${(pos[b.name]?.inv?.water_bucket || 0) > 0 ? 'заливаю водой' : 'отхожу'}`)
  if (src === lv) { dangerLava(dz, b, m, lv); return }
  // Булава сверху, а щит есть (14.10: «друг с булавой спокойно их убил в полёте, они даже не смотрели» — рывок за 15 т, а он
  // правит полёт и добивает через секунду: 71 удар замечен, рывки не спасли). mace_smash нет в bypasses_shield (jar 1.21.11):
  // лицом к падающему и щит до посадки, потом бить его же.
  // Щит есть — держать его, пока его удар сверху виден (стойка whileSmash): рывок за 6–16 т его не уводит (правит полёт), а
  // щит держит и удар прямо сверху. Уже держу — не перезапускать: новый подъём — ещё 5 т без блока. Поздно (< 6 т) и идёт
  // бой — не рвать его: maceBusy выше сохраняет ответ тела (mace/defend).
  // До его посадки 10+ тиков и место есть — отскочить от точки удара (пользователь 25.10: «стоял у стен, когда я с булавой летел,
  // а там открытое место — мог отойти»): рывок тела выбирает направление по стенам, нужен чистый пробег ≥ 3 бл. и успеть
  // уйти на 4 бл. от точки. Некуда или не вышло — щит, если удар ещё летит. Поздно (< 10 т) или щит уже поднят — щит, как было.
  const away0 = sm?.at ? Math.hypot(m.pos.x - sm.at.x, m.pos.z - sm.at.z) : 0
  if (sm && sm.ticks >= 10 && sm.at && away0 + sm.ticks * .25 >= 4 && !(b.shieldHold && reactions.get(b) === b.shieldHold)) {
    // Рывок не вышел — щит, пока удар ещё не сел (стенд 25.10: «некуда отскочить на 3 бл.», а щит ждал maceDefense, которую ставит
    // сам щит, — удар в открытого, −9…13 хп).
    const lands = Date.now() + sm.ticks * 50
    const late = () => { if (Date.now() < lands && ctx.alive?.(b.name) !== false && (shieldNow || inv.cobweb > 0)) dangerShieldSmash(dz, b, sm, shieldNow) }
    ctx.dodgeAway(b, m.pos, sm.at, 5, late, null, false, false, 0, 3)
    return
  }
  if (sm && (shieldNow || inv.cobweb > 0)) {
    if (b.shieldHold && reactions.get(b) === b.shieldHold || b.smashWeb && reactions.get(b) === b.smashWeb) return
    dangerShieldSmash(dz, b, sm, shieldNow); return
  }
  // Без щита — непрерывный ответ тела, а не рывок с просветом для лечения или возврата под булаву.
  if (sm) { dangerFightSmash(dz, b, sm); return }
  // Облако уже лежит на земле: выйти из его радиуса — отдельное дело, в отличие от летящего зелья.
  episode.queued = true
  let attempted = false
  Promise.resolve(ctx.dodgeAway(b, m.pos, cl.at, cl.r + 2, () => { attempted = true }, null, false, true)).then(ok => {
    if (observations.get(b)?.episodes.get(episode.key) !== episode) return
    episode.queued = false
    if (ok !== undefined) episode.handled = ok
    if (attempted) log(`🧪☁ ${b.name}: облако зелья — уворот ${ok ? 'выполнен' : 'не вышел'}`)
  })
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

function dangerFightSmash (dz: DangerCtx, b, sm) {
  const token = dz.beginReaction(b)
  b.c.call('fight', { target: sm.name, allowPlayer: true, allowRanged: true, timeoutSeconds: SEG_S, retreatAtHealth: 3 })
    .catch(() => {}).finally(() => dz.endReaction(b, token))
}

function dangerShieldSmash (dz: DangerCtx, b, sm, shield = true) {
  const { bots, pos, beginReaction, ownsReaction, endReaction } = dz
  const token = beginReaction(b)
  if (shield) b.shieldHold = token
  else b.smashWeb = token
  const defend = () => { if (ownsReaction(b, token)) dangerFightSmash(dz, b, sm) }
  // Держать, пока тело видит его удар сверху (whileSmash — датчик threats.smashes), а не по первой оценке посадки: он
  // подскакивает снова (заряд ветра, «Порыв ветра»), щит опускался между прыжками, новый подъём за 1–2 т до удара не держит
  // (5 т задержки), и бот в просвет бежал (игра пользователя 22.10: «до конца щитом прикрываться, пока я не упаду»).
  // seconds — только предохранитель.
  b.c.call('swarm_hold', { shield, requireShield: shield, enemies: [sm.name], allies: bots.filter(o => o.team === b.team).map(o => o.name), whileSmash: sm.name, seconds: 20,
    ...((pos[b.name]?.inv?.cobweb || 0) > 0 ? { webSmash: sm.name } : {}) })
    .then(r => { if (!ownsReaction(b, token)) return; if (!shield) { defend(); return }; const d = r?.detail || r; if (d?.ok === false && !/^(completed|timeout)$/.test(d?.why || '')) { dz.log(`☂✖ ${b.name}: щит к ${sm.name} снят за ${d.heldSeconds ?? '?'} с (блок ${d.shield?.blockingSeconds ?? '?'} с) — ${d.why}${d.shieldWhy ? ' (' + d.shieldWhy + ')' : ''}${r?.by ? ' by ' + JSON.stringify(r.by) : ''}`); defend() } else if (geared(pos[b.name])) b.cur = sm.name })
    .catch(defend).finally(() => { if (b.shieldHold === token) b.shieldHold = null; if (b.smashWeb === token) b.smashWeb = null; endReaction(b, token) })
  return
}
