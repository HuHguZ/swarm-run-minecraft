'use strict'
import * as gameClock from '../game-clock'
import { countItems } from '../items'
import * as bp from '../blueprint'
import { JOB, isDone } from './world'
import { hasName, cleanParams, makeParts, place, sigOf, entranceOf } from './plan'
import { jobOf, saveJob, pickaxeIn, scaffoldItem, peekChests, takeFromChests, shortfall, say, remember } from './estimate'
import { execute } from './execute'
import { prepare } from './prepare'

async function preview (session, ctl, p) {
  const bot = session.bot
  p = cleanParams(p)
  const pr = await prepare(session, ctl, { ...p, mode: 'preview' })
  if (pr.refused) return { mode: 'preview', ok: false, ...pr.refused }
  const { plan, kind, spec, front, origin, site, L, tally: t, lift, stock } = pr
  const needAll = { ...t.need }
  let chests = []
  let { short } = shortfall(bot, session.mcData, needAll, stock, [])
  if (short.length && p.chests !== false) {
    chests = await peekChests(session, ctl)
    short = shortfall(bot, session.mcData, needAll, stock, chests).short
  }
  const optShort = shortfall(bot, session.mcData, t.optional, stock, chests).short
  const scaff = lift ? scaffoldItem(bot, needAll) : null
  const eta = Math.round(t.digs * 0.8 + t.hard * 1.2 + (Object.values(needAll) as any[]).reduce((a: any, b) => a + b, 0) * 0.7 + (Object.values(t.optional) as any[]).reduce((a: any, b) => a + b, 0) * 0.9 + lift * 3 + 5)
  const job = {
    kind,
    sig: sigOf(kind, p),
    status: 'preview',
    name: p.name || spec.ru,
    material: plan.material,
    parts: plan.parts,
    subs: plan.subs,
    labels: plan.labels,
    front,
    origin,
    size: L.size,
    towers: [],
    at: new Date().toISOString()
  }
  if (!pr.reused || (jobOf(session) && jobOf(session).status === 'preview')) saveJob(session, job)
  else saveJob(session, { ...jobOf(session), origin, front })
  const verdict = t.hazards.length ? 'нельзя' : short.length ? 'не хватает' : 'хватает'
  return {
    mode: 'preview',
    kind,
    name: job.name,
    material: plan.material || undefined,
    front,
    at: origin,
    size: { w: L.size.w, d: L.size.d, h: L.size.y2 },
    entrance: entranceOf(pr.cells),
    site,
    blocks: t.work + t.standing,
    standing: t.standing || undefined,
    materials: needAll,
    optional: Object.keys(t.optional).length ? t.optional : undefined,
    have: Object.fromEntries(Object.keys({ ...needAll, ...t.optional }).map(n => [n, stock[n] || 0])),
    chests: chests.length ? chests.map(c => ({ at: c.at, items: Object.keys(c.contents).length })) : undefined,
    short: short.length ? short : undefined,
    shortOptional: optShort.length ? optShort.map(s => `${s.what} ${s.count}`) : undefined,
    need: short[0] ? { what: short[0].what, count: short[0].count, have: short[0].have } : undefined,
    substitutions: plan.subs.length ? plan.subs : undefined,
    dig: t.digs || undefined,
    digNeedsPickaxe: t.hard && !pickaxeIn(bot) ? t.hard : undefined,
    scaffold: lift ? { height: lift, item: scaff || 'нечем', returns: true } : undefined,
    hazards: t.hazards.length ? t.hazards : undefined,
    etaSeconds: eta,
    verdict,
    say: say(spec.ru || 'постройка', L, plan.material, needAll, short),
    note: verdict === 'нельзя'
      ? `Строить тут нельзя: ${t.hazards.join('; ')}. Другое место — origin или radius.`
      : `Место и план запомнил: mc_build mode=build с теми же параметрами строит ровно это (или mode=resume). ${short.length ? 'Сначала принеси недостающее — стройка без него откажет, не тронув мир.' : ''}`.trim()
  }
}

async function build (session, ctl, p) {
  const bot = session.bot
  p = cleanParams(p)
  const deadline = gameClock.now() + Math.min(600, p.timeoutSeconds ?? 240) * 1000
  const pr = await prepare(session, ctl, p)
  if (pr.refused) return { mode: 'build', built: false, ...pr.refused }
  const { plan, kind, spec, front, origin, site, L, cells, tally: t, lift, stock } = pr

  // --- 1. отказ до того, как тронуть мир.
  if (t.hazards.length) {
    return { mode: 'build', built: false, kind, at: origin, site, hazards: t.hazards, stopped: `НЕ СТРОЮ: в пятне стройки ${t.hazards.join('; ')} — в воде и у лавы не строю. Другое место: origin или radius.` }
  }
  if (t.hard > 4 && !pickaxeIn(bot)) {
    return { mode: 'build', built: false, kind, at: origin, site, need: { what: 'wooden_pickaxe', count: 1, have: 0 }, stopped: `НЕ СТРОЮ: копать ${t.hard} блоков камня, а кирки нет — руками это по 7с на блок.` }
  }
  let chests = []
  let { short } = shortfall(bot, session.mcData, t.need, stock, [])
  if (short.length && p.chests !== false) {
    chests = await peekChests(session, ctl)
    short = shortfall(bot, session.mcData, t.need, stock, chests).short
  }
  const scaff = lift ? scaffoldItem(bot, t.need) : null
  if (lift && !scaff && !short.length) {
    short = [{ what: 'dirt', count: lift, have: 0, why: 'на леса (вернутся)' }]
  }
  if (short.length) {
    const job = jobOf(session)
    if (!job || job.sig !== sigOf(kind, p) || pr.reused === false) {
      saveJob(session, { kind, sig: sigOf(kind, p), status: 'preview', name: p.name || spec.ru, material: plan.material, parts: plan.parts, subs: plan.subs, labels: plan.labels, front, origin, size: L.size, towers: [], at: new Date().toISOString() })
    }
    return {
      mode: 'build',
      built: false,
      kind,
      at: origin,
      front,
      site,
      need: { what: short[0].what, count: short[0].count, have: short[0].have },
      short,
      materials: t.need,
      stopped: `НЕ СТРОЮ: не хватает ${short.map(s => `${s.what} ×${s.count} (есть ${s.have}${s.inChests ? `, в сундуках ${s.inChests}` : ''})`).join(', ')}. Мир не тронут.`,
      note: [short.map(s => s.craft).filter(Boolean).join('; '), 'Место запомнил: принесёшь — позови тот же mc_build, встанет сюда же.'].filter(Boolean).join(' ')
    }
  }

  // --- 2. взять недостающее из сундуков рядом.
  let fromChests
  if (chests.length) {
    const want = {}
    for (const [n, c] of ((Object.entries(t.need) as [string, any][]) as any)) {
      const lack = c - (countItems(bot)[n] || 0)
      if (lack > 0) want[n] = lack
    }
    for (const [n, c] of ((Object.entries(t.optional) as [string, any][]) as any)) {
      const lack = c - (countItems(bot)[n] || 0) - (want[n] || 0)
      if (lack > 0) want[n] = (want[n] || 0) + lack
    }
    if (Object.keys(want).length) fromChests = await takeFromChests(session, ctl, chests, want)
  }

  // --- 3. строить.
  const prev = jobOf(session)
  const same = prev && prev.origin && prev.origin.x === origin.x && prev.origin.y === origin.y && prev.origin.z === origin.z &&
    (pr.reused || prev.sig === sigOf(kind, p))
  const job = same
    ? prev
    : { kind, sig: sigOf(kind, p), name: p.name || spec.ru, material: plan.material, parts: plan.parts, subs: plan.subs, labels: plan.labels, front, origin, size: L.size, towers: [], at: new Date().toISOString() }
  if (!job.towers) job.towers = []
  job.status = 'building'
  job.calls = (job.calls || 0) + 1
  saveJob(session, job)

  const r = await execute(session, ctl, job, cells, { deadline })
  const finished = r.left === 0
  job.status = finished ? 'done' : 'partial'
  job.placed = (job.placed || 0) + r.placed
  job.updated = new Date().toISOString()
  saveJob(session, job)
  if (finished || r.placed > 0) remember(session, job, cells)

  const detail: any = {
    mode: 'build',
    built: finished,
    kind,
    name: job.name,
    material: plan.material || undefined,
    at: origin,
    front,
    size: { w: L.size.w, d: L.size.d, h: L.size.y2 },
    entrance: entranceOf(cells),
    site,
    total: t.work + t.standing,
    standing: t.standing || undefined,
    ...r,
    fromChests,
    substitutions: plan.subs.length ? plan.subs : undefined,
    calls: job.calls
  }
  const essential = (r.missing || []).filter((n): n is string => typeof n === 'string' && cells.some(c => c.item === n && !c.optional && !isDone(bot, c)))
  if (essential.length) {
    const lack = essential[0]
    detail.need = { what: lack, count: cells.filter(c => c.item === lack && !isDone(bot, c)).length, have: (((((countItems(bot) as any) as any) as any) as any) as any)[lack] || 0 }
  }
  if (finished) {
    detail.note = `Готово: ${job.name} ${L.size.w}×${L.size.d} на ${origin.x},${origin.y},${origin.z}` +
      `${r.placed ? `, поставил ${r.placed}` : ', всё уже стояло'}${r.dug ? `, выкопал ${r.dug}` : ''} за ${r.seconds}с. Записал в память как «${job.name}».` +
      (r.optionalMissing ? ` Без: ${(Object.entries(r.optionalMissing) as [string, any][]).map(([n, k]) => `${n} ×${k}`).join(', ')} — нет в рюкзаке, принесёшь — позови снова, доставлю.` : '')
  } else {
    const reasons = r.why ? (Object.entries(r.why) as [string, any][]).map(([w, n]) => `${w} ×${n}`).slice(0, 3).join('; ') : ''
    detail.stopped = r.stopped === 'время вышло'
      ? `время вышло: осталось ${r.left} клеток из ${t.work + t.standing}`
      : r.walledIn ? 'ЗАМУРОВАН: выхода нет — план без двери/проёма' : `не всё встало: осталось ${r.left} (${reasons})`
    detail.note = r.skipped
      ? `Пропустил ${r.skipped} клеток с причинами (why). Позови mc_build mode=resume — доделает остальное; поставленное не ломает.`
      : 'Позови mc_build mode=resume (или тот же вызов) — продолжит отсюда, поставленное не трогает.'
  }
  return detail
}

// Справка без мира: какие постройки есть и как выглядит план частями.
function kinds (session, p: any = {}) {
  const has = session.mcData ? hasName(session.mcData) : () => true
  const stock = session.bot ? countItems(session.bot) : {}
  if (p.kind || p.plan) {
    const kind = p.plan ? 'plan' : String(p.kind).toLowerCase()
    const plan = makeParts(session, { ...p, kind }, stock)
    const L = bp.layout(plan.parts, { front: p.front || 'south', has })
    const need = {}
    for (const c of L.rel) if (c.kind !== 'air' && c.kind !== 'part' && c.kind !== 'seal') need[c.item] = (need[c.item] || 0) + 1
    return {
      mode: 'plan',
      kind,
      material: plan.material || undefined,
      size: { w: L.size.w, d: L.size.d, h: L.size.y2 },
      parts: plan.parts,
      materials: need,
      substitutions: plan.subs.length ? plan.subs : undefined,
      note: 'Это чертёж без места и без мира: seal (фундамент, заделка) считается в смете только там, где дыра. ' +
        'Правь части и отдавай обратно как plan — или mc_build mode=preview kind=… посчитает смету на месте.'
    }
  }
  return {
    mode: 'kinds',
    kinds: Object.fromEntries((Object.entries(bp.KINDS) as [string, any][]).map(([k, v]: any) => [k, { ru: v.ru, defaults: v.defaults, what: v.note }])),
    materials: { wood: bp.WOODS, stone: bp.STONES },
    parts: ['box', 'walls', 'floor', 'line', 'clear', 'seal', 'block', 'stairs', 'slab', 'door', 'window', 'torch', 'lantern', 'bed', 'chest', 'sign', 'ladder', 'crenel', 'roof'],
    last: jobOf(session) ? { kind: jobOf(session).kind, status: jobOf(session).status, at: jobOf(session).origin } : undefined
  }
}
declare namespace kinds {
  let get: any
  let set: any
}


function status (session) {
  const job = jobOf(session)
  if (!job) return { mode: 'status', job: null, note: 'начатой стройки в памяти нет' }
  const { parts, ...rest } = job
  const bot = session.bot
  let left = null
  if (bot && bot.entity && job.origin && parts) {
    try {
      const L = bp.layout(parts, { front: job.front || 'south', has: hasName(session.mcData) })
      const cells = place(L, job.origin)
      left = cells.filter(c => c.kind !== 'part' && bot.blockAt(c.pos) && !isDone(bot, c)).length
    } catch {}
  }
  return { mode: 'status', job: { ...rest, parts: parts ? parts.length : 0 }, left: left ?? undefined }
}

function forget (session) {
  const had = !!jobOf(session)
  session.journal.patch(s => { delete s[JOB] })
  return { mode: 'forget', forgot: had }
}

const kindsExport = kinds

export { preview, build, status, forget, kindsExport }
