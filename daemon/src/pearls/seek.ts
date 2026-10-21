'use strict'
// ND_BARTER_SEEK (поток ne 21.10; по умолчанию вкл., =0 — выкл.): золото в рюкзаке → жемчуг у любых видимых пиглинов на открытом, как у спидраннера в золотой
// броне. Бастион из своего штрека торговцев не видит (nbs32-5974: 27 слитков, «ни ямы, ни окна» → бартер исчерпан; nbt29a/b: 144
// слитка, 0 сделок за 20 мин), а открытый торг (barter) с видимыми взрослыми — 14–22 сделки/мин (obr24a/b). Здесь только поиск
// торговца и место без брутов: видимые взрослые не злые пиглины, брутов/хоглинов в 20 бл. нет (видимых и запомненных), иначе —
// прочь от них; никого не видно — на звук пиглина, потом по румбам обход. Знание — глаза (луч) и слух, без карты и рентгена.
import * as gameClock from '../game-clock'
import { countOf } from '../items'
import * as worlds from '../worlds'
import { walkTo, log } from './common'
import { barter } from './barter'

const DIRS = [[1, 0], [0.7071, 0.7071], [0, 1], [-0.7071, 0.7071], [-1, 0], [-0.7071, -0.7071], [0, -1], [0.7071, -0.7071]]
const FOES = /^(piglin_brute|hoglin|zoglin)$/
const FOE_R = 20 // barter.bastionThreats: брут в 20 по лучу — сделки не начинаются

export const enabled = () => process.env.ND_BARTER_SEEK !== '0'
// Неудачные торговцы — между вызовами (кампания зовёт seek снова и снова: nbk34-3818 — те же 5 пиглинов за мостом в каждом вызове).
const skipUntil = new Map<number, number>()
// Ходьба без мостов и столбов: над провалом свой мост вставал на узле (nbk34-3818: 269 «stuck» на одном узле-мосте за 30 мин),
// а мост над лавовым морем Ада — риск смерти; копать pathfinder может.
// Зоны бастиона/домов брутов — дороже на ходу (не запрет: выйти из зоны можно): nbk40-5408 — путь к торговцу прошёл в 16 бл. от
// записи бастиона, брут вплотную, смерть.
async function walk (bot, ctl, target, range, ms, stopIf = null, xz = false, zoneCost: ((p: any) => number) | null = null) {
  const mv = bot.pathfinder?.movements, keep = mv && { s: mv.scafoldingBlocks, t: mv.allow1by1towers }
  if (mv) { mv.scafoldingBlocks = []; mv.allow1by1towers = false }
  const area = zoneCost && Array.isArray(mv?.exclusionAreasStep) ? (block => block?.position ? zoneCost(block.position) : 0) : null
  if (area) mv.exclusionAreasStep.push(area)
  bot._ndNoBruteHold = true
  try { return await walkTo(bot, ctl, target, range, ms, stopIf, xz) } finally {
    bot._ndNoBruteHold = false
    if (mv) { mv.scafoldingBlocks = keep.s; mv.allow1by1towers = keep.t; if (area) { const i = mv.exclusionAreasStep.indexOf(area); if (i >= 0) mv.exclusionAreasStep.splice(i, 1) } }
  }
}
const gold = bot => countOf(bot, 'gold_ingot') + 9 * countOf(bot, 'gold_block')

// ND_BASTION_HYP_FOCUS: тело в своём закрытом штреке бастиона (золото стены) — сперва к его входу (клетка, с которой штрек начался из
// открытого: bot._ndBastionExit, пишет bastion в конце вызова), по своим клеткам; оттуда — поиск торговцев как обычно.
async function leaveTunnel (session, ctl, bot) {
  const o = bot._ndBastionOrigin
  const ex = o && o.world === bot.world ? o : bot._ndBastionExit
  if (process.env.ND_BASTION_HYP_FOCUS === '0' || !ex || ex.world !== bot.world) return
  const SL: typeof import('../sealed') = require('../sealed')
  const own = (require('../tunnel') as typeof import('../tunnel')).ownSet(session)
  const f = SL.bodyCells(bot)[0]
  const d = Math.hypot(f.x - ex.at.x, f.y - ex.at.y, f.z - ex.at.z)
  // Своя клетка — по памяти штреков; память могла не записаться (закладки, новый вызов) — тогда признак штрека: над головой твёрдое.
  const head = bot.blockAt(f.offset(0, 2, 0), false)
  if (d < 2 || d > 96 || !(own.has(SL.key(f.x, f.y, f.z)) || head?.boundingBox === 'block')) { log('seek: выход из штрека не нужен', { d: Math.round(d), own: own.has(SL.key(f.x, f.y, f.z)), head: head?.name }); return }
  const mv = bot.pathfinder?.movements
  const keep = mv && { s: mv.scafoldingBlocks, t: mv.allow1by1towers }
  if (mv) { mv.scafoldingBlocks = []; mv.allow1by1towers = false }
  const floor0 = bot._ndNetherFloor
  bot._ndNetherFloor = Math.min(floor0 ?? 40, f.y - 1, ex.at.y - 1)
  try {
    // ND_SEEK_OWN_EXIT: брут/хоглин в виду в 16 — ходьбу оборвать (дальше — ветка врагов seek), не идти на него: nl71b, nlo74b, nlo75a/c —
    // смерть на выходе из стены (12.9 + 8). Свой след назад (n74/n77) не держит путь: «No path» и livelock seek↔bastion↔ne_recover.
    const E: typeof import('../perception/eyes') = require('../perception/eyes')
    const foe = process.env.ND_SEEK_OWN_EXIT === '1' ? () => E.entities(bot, { radius: 16, rememberMs: 0, hearMs: 0 }).some(e => e.seen && FOES.test(e.name)) : null
    // Ходьба к месту прихода из стены идёт этажом брутов (nlo78i/l-5408: «опасность рядом» сработала, брут всё равно 12.9 + 7.7): к нему —
    // закрытым штреком по Аду (tunnel.tunnelTo: план по толще, вскрытие — не у брутов/хоглинов), как ходит кампания nether_tunnel.
    if (process.env.ND_SEEK_OWN_EXIT === '1') {
      const T: typeof import('../tunnel') = require('../tunnel')
      const tr: any = await T.tunnelTo(session, ctl, ex.at, { radius: 3, deadline: gameClock.now() + 150000 }).catch(e => ({ ok: false, why: e.message }))
      log('seek: из стены закрытым штреком', { from: f, to: ex.at, ok: tr.ok, why: tr.why, dug: tr.dug, at: tr.at })
      if (tr.ok) return
    }
    const r = await walkTo(bot, ctl, ex.at, 2, 90000, foe)
    log('seek: из штрека к его входу', { from: f, to: ex.at, ok: r.ok, why: r.error, at: SL.bodyCells(bot)[0] })
  } finally { bot._ndNetherFloor = floor0; if (mv) { mv.scafoldingBlocks = keep.s; mv.allow1by1towers = keep.t } }
}

// Выбор торговца — чистая функция (тест): ближайший видимый взрослый не злой пиглин, вокруг которого нет врага в FOE_R.
export function pickTrader (seen, foes, skip: { has: (id: any) => boolean } = new Set()) {
  const d = (a, b) => Math.hypot(a.x - b.x, a.y - b.y, a.z - b.z)
  return seen.filter(e => e.name === 'piglin' && !e.baby && !e.angry && !skip.has(e.id) && !foes.some(f => d(f.pos, e.pos) < FOE_R))
    .sort((a, b) => a.dist - b.dist)[0] || null
}

export async function seek (session, ctl, p: any = {}) {
  const bot = session.bot
  const C: typeof import('../bastion/take-gold-block') = require('../bastion/take-gold-block')
  const E: typeof import('../perception/eyes') = require('../perception/eyes')
  const S: typeof import('../perception/senses') = require('../perception/senses')
  const BM: typeof import('../brute-memory') = require('../brute-memory')
  const t0 = gameClock.now()
  const deadline = t0 + Math.max(30, Math.min(600, p.timeoutSeconds ?? 360)) * 1000
  const want = Math.max(1, p.pearls ?? 12), keep = Math.max(0, p.keep ?? 0)
  const out: any = { mode: 'seek', spent: 0, pearls0: countOf(bot, 'ender_pearl'), rounds: 0, walks: 0, wander: 0, retreats: 0, gained: {} }
  if (worlds.worldOf(bot) !== 'the_nether') return { ...out, stopped: 'пиглины — в Аду' }
  if (!C.goldWorn(bot) && !(await C.wearGold(bot))) return { ...out, stopped: 'без золотой брони к пиглинам не иду' }
  const skip = { has: (id: number) => (skipUntil.get(id) || 0) > gameClock.now(), add: (id: number) => skipUntil.set(id, gameClock.now() + 120000) }
  // Злость от сломанного золота: PiglinAi.angerNearbyPiglins(player, false) — все праздные пиглины в ±16 без луча, ANGRY_AT 600 тиков
  // (30 с). Выйти к торговцам раньше — к злым (nbf52-5408: 31 слиток, удары пиглина 7.9 ×2). Ждать в своём закрытом штреке.
  const since = gameClock.now() - (bot._ndGoldBreakAt ?? -1e12)
  if (process.env.ND_BASTION_HYP_FOCUS !== '0' && since < 33000) { log('seek: пиглины злы от золота — жду в штреке', { s: Math.round((33000 - since) / 1000) }); await gameClock.sleep(33000 - since) }
  await leaveTunnel(session, ctl, bot)
  let stuck = 0, from = bot.entity.position.clone()
  const visited: Array<{ x: number, z: number }> = []
  let dirK = Math.floor(Math.random() * 8), blind = 0
  const look = () => E.entities(bot, { radius: 48, rememberMs: 0, hearMs: 6000 }).map(e => {
    const ent = bot.entities[e.id]
    return { ...e, baby: !!ent && C.isBaby(bot, ent), angry: !!ent && e.name === 'piglin' && C.aggressive(bot, ent) }
  })
  const foesOf = all => [...all.filter(e => e.seen && e.pos && FOES.test(e.name)).map(e => ({ id: e.id, name: e.name, pos: e.pos, dist: e.dist })),
    ...BM.spots(bot).filter(s => gameClock.now() - s.seenAt < 120000).map(s => ({ id: s.id, name: 'piglin_brute', pos: s, dist: bot.entity.position.distanceTo(s as any) }))]
  const threatNear = () => { try { return foesOf(look()).some(f => f.dist <= 14) } catch { return false } }
  const stopped = why => { out.stopped = why; return why }
  // Брутов не видно — ещё не значит, что их нет: бастион (место записи) и их дома (где впервые увидены) — не место для торга и обхода
  // (nbs37-5408: 27 слитков, поиск из-под бастиона вывел к бруту из-за угла — смерть). Бруты держатся дома (PiglinBruteAi).
  // ND_SEEK_BASTION_PIGLINS=1 (поток ne 21.10, выкл.): торговцы бастиона — тоже торговцы (у спидраннера это главные), запрет — только
  // дома брутов (память брутов) и брут в 20 от торговца (pickTrader); блуждание — в 48 бл. от начала, а не прочь от бастиона:
  // seek 87.7 мин → 20 жемчуга (4.4 мин/жемчуг), тело уходило на 100+ бл. от бастиона («пиглинов не нашёл»).
  const near = process.env.ND_SEEK_BASTION_PIGLINS === '1'
  const home0 = bot.entity.position.clone()
  const zones = () => [...(!near && p.avoid && Number.isFinite(p.avoid.x) ? [{ x: p.avoid.x, z: p.avoid.z, r: p.avoid.r ?? 20 }] : []),
    ...BM.spots(bot).map(s => ({ x: s.assumedPatrolAnchor.x, z: s.assumedPatrolAnchor.z, r: 16 })),
    // ND_NE_BRUTE_POSTS: и посты брутов шаблона (у сундуков стен и валов) — не место для торга и обхода.
    ...(process.env.ND_NE_BRUTE_POSTS === '1' ? (require('../bastion/hyp-focus') as typeof import('../bastion/hyp-focus')).brutePosts(bot).map(v => ({ x: v.x, z: v.z, r: 10 })) : [])]
  const inZone = (q, zs = zones()) => zs.some(z => Math.hypot(q.x - z.x, q.z - z.z) < z.r)
  let zsNow = zones()
  const zoneCost = q => inZone(q, zsNow) ? 30 : 0 // A* зовёт на каждую клетку — зоны снимком на оборот, не пересчёт
  while (!ctl.aborted && gameClock.now() < deadline - 15000) {
    if (countOf(bot, 'ender_pearl') >= want) { stopped('жемчуга хватает'); break }
    if (gold(bot) <= keep) { stopped('золото кончилось'); break }
    if ((bot.health ?? 20) < 10) { stopped(`хп ${Math.round(bot.health ?? 0)} — лечиться`); break }
    if (C.inLava(bot)) { stopped('в лаве'); break }
    // Тело не сдвигается (ни шага, ни сделки за 4 захода) — не крутить те же цели: кампания решит другое.
    if (bot.entity.position.distanceTo(from) < 1.5) { if (++stuck > 4) { stopped('не сдвинуться с места' + (out.lastWalk ? `: ${out.lastWalk}` : '')); break } } else { stuck = 0; from = bot.entity.position.clone() }
    BM.observe(bot, true)
    const all = look(), foes = foesOf(all), me = bot.entity.position
    const near = foes.filter(f => f.dist <= FOE_R)
    if (near.length) {
      // Вплотную (< 10) уходить спиной поздно: брут догонял в штреке, 12.9 + 7.1 за 1 с (nbs37-5408 — 27 слитков, смерть на
      // отходе). Тут — тактика (укрытие/бой) и защищённый бартер бастиона, а не ходьба.
      if (Math.min(...near.map(f => f.dist)) < 10) { stopped(`${near[0].name} вплотную — не отворачиваюсь`); break }
      // Прочь от врагов: точка в 24 бл. от их середины (по видимому — путь строит pathfinder по прогруженному миру).
      out.retreats++
      const cx = near.reduce((n, f) => n + f.pos.x, 0) / near.length, cz = near.reduce((n, f) => n + f.pos.z, 0) / near.length
      let dx = me.x - cx, dz = me.z - cz; const l = Math.hypot(dx, dz) || 1; dx /= l; dz /= l
      log('seek: прочь от врагов', { foes: near.map(f => `${f.name} ${Math.round(f.dist)}`) })
      const r = await walk(bot, ctl, me.offset(dx * 24, 0, dz * 24).floored(), 4, 15000, null, true)
      out.lastWalk = r.ok ? null : `прочь от врагов: ${String(r.error || '').slice(0, 60)}`
      if (!r.ok && out.retreats > 6) { stopped(`от врагов не отойти: ${r.error}`); break }
      continue
    }
    const zs = zsNow = zones()
    const seen = all.filter(e => e.seen && e.pos && !inZone(e.pos, zs))
    const pg = pickTrader(seen, foes, skip)
    if (pg) {
      // ND_SEEK_LURE=1 (поток ne 21.10, выкл.): торговец в 4–12 бл. — сперва приманка: слиток на пол в 2.5 бл. к нему (пиглин идёт к
      // видимому золоту в 9 бл., GoToWantedItem; добыча летит к видимому игроку). Ходьба к торговцам в бастионе рвётся: «застрял … за 8 с»,
      // «время вышло» (nbB64-5408-2: 5 из 6 подходов). Не взяли за 12 с — прежний подход ногами.
      if (process.env.ND_SEEK_LURE === '1' && pg.dist > 4 && pg.dist <= 12 && gold(bot) > keep) {
        const L: typeof import('./lure') = require('./lure')
        const SL: typeof import('../sealed') = require('../sealed')
        const me = bot.entity.position, to = bot.entities[pg.id]?.position || pg.pos
        const l = Math.hypot(to.x - me.x, to.z - me.z) || 1
        const drop = me.offset((to.x - me.x) / l * 2.5, 0, (to.z - me.z) / l * 2.5)
        if ((countOf(bot, 'gold_ingot') - keep) < 1) await C.unpackGold(session, ctl, Math.min(27, gold(bot) - keep))
        const lt = await L.lureTrade(session, ctl, bot, drop, SL.bodyCells(bot)[0], deadline - 15000, keep, want, 12000)
        out.lures = (out.lures || 0) + 1; out.spent += lt.taken; out.lureTaken = (out.lureTaken || 0) + lt.taken
        log('seek: приманка', { id: pg.id, dist: Math.round(pg.dist), tossed: lt.tossed, taken: lt.taken, pearls: lt.pearls, stopped: lt.stopped, s: lt.seconds })
        if (lt.taken > 0) { stuck = 0; from = bot.entity.position.clone(); blind = 0; continue }
      }
      out.walks++
      if (pg.dist > 5) {
        const r = await walk(bot, ctl, bot.entities[pg.id]?.position?.floored() || pg.pos, 3, 20000, threatNear, false, zoneCost)
        if (!r.ok && r.error !== 'опасность рядом') { skip.add(pg.id); log('seek: к пиглину не дошёл', { id: pg.id, why: r.error }); continue }
        if (!r.ok) continue
      }
      const left = Math.round((deadline - gameClock.now()) / 1000) - 10
      if (left < 25) break
      await C.unpackGold(session, ctl, Math.min(64, gold(bot) - keep))
      const count = countOf(bot, 'gold_ingot') - keep
      if (count <= 0) { stopped('слитки не распаковались'); break }
      const r: any = await barter(session, ctl, { timeoutSeconds: Math.min(180, left), count })
      out.rounds++
      out.spent += r.spent || 0
      for (const [k, v] of Object.entries<any>(r.gained || {})) out.gained[k] = (out.gained[k] || 0) + v
      log('seek: бартер', { spent: r.spent, pearls: r.pearls, stopped: r.stopped, seconds: r.seconds })
      if (!(r.spent > 0)) skip.add(pg.id); else { stuck = 0; from = bot.entity.position.clone() }
      blind = 0
      continue
    }
    // Никого не видно: на звук пиглина, иначе следующий румб, где ещё не были (шаг 20 бл.).
    const heard = all.find(e => e.name === 'piglin' && !e.seen && e.heard)
    let to = heard ? S.hearPoint(bot, heard.heard) : null
    if (to && inZone(to, zs)) to = null
    // Сам в зоне бастиона/брутов — сперва прочь из неё (от ближайшей зоны на её радиус + 12).
    const z0 = zs.find(z => Math.hypot(me.x - z.x, me.z - z.z) < z.r)
    if (!to && z0) { const dx = me.x - z0.x, dz = me.z - z0.z, l = Math.hypot(dx, dz) || 1; to = { x: z0.x + dx / l * (z0.r + 12), y: me.y, z: z0.z + dz / l * (z0.r + 12) } }
    if (!to) {
      for (let k = 0; k < 8 && !to; k++) {
        const d = DIRS[(dirK + k) % 8], q = { x: me.x + d[0] * 20, y: me.y, z: me.z + d[1] * 20 }
        if (visited.some(v => Math.hypot(v.x - q.x, v.z - q.z) < 12) || BM.riskNear(bot, q).cost > 2 || inZone(q, zs)) continue
        if (near && Math.hypot(q.x - home0.x, q.z - home0.z) > 48) continue
        to = q; dirK = (dirK + k) % 8
      }
    }
    if (!to || ++blind > 12) { stopped('пиглинов не нашёл'); break }
    visited.push({ x: me.x, z: me.z })
    out.wander++
    const pigSeen = () => { try { return !!pickTrader(look().filter(e => e.seen && e.pos && !inZone(e.pos, zs)), [], skip) || threatNear() } catch { return false } }
    const r = await walk(bot, ctl, { x: Math.floor(to.x), y: Math.floor(to.y), z: Math.floor(to.z) }, 3, 15000, pigSeen, true, zoneCost)
    out.lastWalk = r.ok ? null : `${z0 ? 'из зоны' : heard ? 'на звук' : 'обход'} → ${Math.floor(to.x)},${Math.floor(to.z)}: ${String(r.error || '').slice(0, 60)}`
    // ND_SEEK_OWN_EXIT: ногами не вышло (пути нет, застрял) — туда же закрытым штреком (tunnel.tunnelTo: план по толще): из бастиона/зоны
    // постов ногами выхода нет, и seek кончался «не сдвинуться с места» за секунды (c92-int10-s21: 0 сделок, слитки в рюкзаке).
    if (!r.ok && r.error !== 'опасность рядом' && process.env.ND_SEEK_OWN_EXIT === '1' && bot.entity.position.distanceTo(from) < 1.5) {
      const T: typeof import('../tunnel') = require('../tunnel')
      const tr: any = await T.tunnelTo(session, ctl, new (require('vec3').Vec3)(Math.floor(to.x), Math.floor(to.y), Math.floor(to.z)), { radius: 3, deadline: Math.min(deadline - 15000, gameClock.now() + 60000) }).catch(e => ({ ok: false, why: e.message }))
      log('seek: ногами не вышло — штреком', { to: { x: Math.floor(to.x), z: Math.floor(to.z) }, ok: tr.ok, why: tr.why, dug: tr.dug })
      if (!tr.ok) out.lastWalk += ` | штрек: ${String(tr.why || '').slice(0, 40)}`
    }
    if (!r.ok && r.error !== 'опасность рядом') dirK = (dirK + 1) % 8
  }
  out.pearls = countOf(bot, 'ender_pearl') - out.pearls0
  out.ingotsLeft = gold(bot)
  out.seconds = Math.round((gameClock.now() - t0) / 1000)
  out.note = `Поиск торговцев: сделок ${out.spent} слитков за ${out.rounds} раундов, жемчуга +${out.pearls}; ${out.stopped || 'время'}`
  return out
}
