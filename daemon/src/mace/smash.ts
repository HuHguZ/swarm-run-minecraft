// Булава (mace.ts): удар с падения — когда взлетать (smashPlan), взлёт на заряде ветра и удар (windSmash), удар со
// своего падения (fallSmashReady).
import * as gameClock from '../game-clock'
import * as edges from '../edges'
import * as pick from '../pick'
import { MACE_BASE, SWAP, KEYS, LAUNCH_BACK, yawTo, smashDamage } from './consts'
import { densityOf, findItem, shieldAtUs, nextTick, install, offWind, windCount, windReady, ensureHotbar, fireWind, selfWindAim, healthOf } from './hands'
import { burnNear, webOnBody, headroom, landingSoon } from './world'
import { descend } from './descend'

// ---------------------------------------------------------------- удар

// Когда взлетать. Он рядом по горизонтали (долететь рулём в воздухе:
// ускорение 0.02 б/т², трение 0.91 — за 25 тиков до ~4 блоков), на нашей
// высоте и на земле; его щит не смотрит на нас (передний щит держит удар
// булавы целиком); над головой есть воздух; вокруг нет ям (снесёт — и сели
// ниже всплеска). Ожидаемый урон — по высоте, какую даст потолок.
// Он в коробке: крыша над головой и стены с трёх сторон — сверху булавой не
// достать, прицел упрётся в крышу или стену (pick.js). Взлетать незачем.
function boxedIn (bot, e) {
  const c = e.position.floored()
  const hard = (p) => { const b = bot.blockAt(p); return !!b && (b.boundingBox === 'block' || b.name === 'cobweb') }
  if (!hard(c.offset(0, 2, 0))) return false
  let walls = 0
  for (const [dx, dz] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) if (hard(c.offset(dx, 1, dz))) walls++
  return walls >= 3
}

// Почему нет (why) или план взлёта: причина отказа — в журнал боя (стенд 21.10: у булавников по одной попытке за раунд,
// а отказ молчал).
export function smashCheck (bot, e, { minRoom = 5 }: any = {}): { plan?: { dh: number; room: number; h: number; expect: number }; why?: string } {
  const b = bot.entity
  if (!b || !landingSoon(bot) || b.isInWater || b.isInLava) return { why: 'не на земле' }
  if (boxedIn(bot, e)) return { why: 'он в коробке' }
  // В паутине всплеск не поднимет (webOnBody ниже, 2026-09-26).
  if (webOnBody(bot)) return { why: 'я в паутине' }
  if (!findItem(bot, 'mace') || !windReady(bot)) return { why: 'нет булавы или заряда' }
  const me = b.position
  const dh = Math.hypot(e.position.x - me.x, e.position.z - me.z)
  const dy = e.position.y - me.y
  if (dh < 0.6 || dh > 4.2) return { why: `до него ${dh.toFixed(1)} бл. по горизонтали` }
  if (Math.abs(dy) > 1.0) return { why: `он на ${dy.toFixed(1)} по высоте` }
  if (shieldAtUs(bot, e)) return { why: 'его щит на меня' }
  const room = headroom(bot, me, 12)
  if (room < minRoom) return { why: `потолок в ${Math.floor(room)} бл.` }
  try {
    const cache = new Map()
    if (edges.hazardAround(bot, me, 3, cache)) return { why: 'край или лава у меня' }
    if (edges.hazardAround(bot, e.position, 3, cache)) return { why: 'край или лава у него' }
  } catch {}
  if (burnNear(bot, me) || burnNear(bot, e.position)) return { why: 'огонь рядом' }
  // Вершина (замер probe-mace 2026-09-26): стоя 6.1 бл., с прыжком 8.3–11.2;
  // потолок срезает. Удар — у самой земли, падение ≈ вершина. Булава к удару
  // заряжена (windSmash держит её с запасом) — крит.
  const top = Math.min(8, room - 0.2)
  const h = Math.max(0, top - 0.3)
  return { plan: { dh, room, h, expect: Math.round(smashDamage(h, { base: SWAP ? 7 : MACE_BASE, charge: 1, density: densityOf(bot) })) } }
}
export function smashPlan (bot, e, opts: any = {}) { return smashCheck(bot, e, opts).plan ?? null }

// varint с позиции off (сырой пакет: номер пакета впереди или нет).
function readVarIntAt (buf, off) {
  let v = 0; let s = 0; let b
  do { b = buf[off++]; v |= (b & 0x7f) << s; s += 7 } while (b & 0x80 && s < 35)
  return v
}
// Разбор неудачного взлёта одной строкой (windSmash).
function diagText (dg) {
  const r = (x) => Math.round(x * 100) / 100
  const bits = [dg.boom ? `всплеск пришёл, vy до него ${dg.boomVy}` : 'всплеска не было']
  if (dg.kicks) bits.push(`скорость от сервера ×${dg.kicks}`)
  if (dg.off !== 'wind_charge') bits.push(`в левой ${dg.off || 'пусто'}`)
  bits.push(dg.vy0 > 0.2 ? 'бросок после отрыва' : 'бросок с земли')
  if (dg.web) bits.push('в паутине')
  bits.push(`vy max ${r(dg.vyMax)}`)
  return bits.join(', ')
}

// Взлёт на заряде ветра и удар с падения. Без свапа (Paper, см. SWAP):
// булава — в правую заранее (крит от заряда > 0.9: 30 тиков из 33), заряды
// ветра — в левую (смена ЛЕВОЙ руки заряд правой не трогает: Player.tick
// сверяет только главную руку), щит или тотем из левой — в рюкзак и обратно
// после посадки. Заряд с земли и сразу прыжок: не наследуем +0.42 вверх.
// Всплеск в 0.25 над полом, толчок «от центра к глазам» — вверх, дальше рулим к нему.
// stillOk() — пока копится заряд булавы, он не ушёл и не поднял щит.
export async function windSmash (bot, ctl, e, { vel, swap = SWAP, stats = null, jump = true, chargeTicks = 9, stillOk = null, telemetryHp = e => healthOf(bot, e), chain = null }: any = {}) {
  const out: any = { launched: false, hit: false, swung: false, note: '' }
  install(bot)
  const sleep = (ms) => new Promise<any>(r => gameClock.setTimeout(r, ms))
  const offBefore = bot.inventory.slots[45] ? bot.inventory.slots[45].name : null
  const restoreOff = async () => {
    if (!offBefore || offBefore === 'wind_charge') return
    const it = findItem(bot, offBefore)
    if (it && !(bot.inventory.slots[45] && bot.inventory.slots[45].name === offBefore)) { try { await bot.equip(it, 'off-hand') } catch {} }
  }
  let armedAt = gameClock.now()
  if (swap) {
    if (!(await ensureHotbar(bot, ['wind_charge', 'mace']))) { out.note = 'булава: заряд или булава не в хотбаре'; return out }
    armedAt = 0
  } else {
    const m = findItem(bot, 'mace')
    if (!m) { out.note = 'булава: нет булавы'; return out }
    if (!bot.heldItem || bot.heldItem.name !== 'mace') { try { await bot.equip(m, 'hand') } catch {} }
    armedAt = gameClock.now()
    if (!offWind(bot)) {
      const w = findItem(bot, 'wind_charge')
      if (w) { try { await bot.equip(w, 'off-hand') } catch {} }
    }
    if (!offWind(bot) || !bot.heldItem || bot.heldItem.name !== 'mace') { await restoreOff(); out.note = 'булава: не взял булаву и заряд в руки'; return out }
  }
  // Заряд булавы до взлёта: сам полёт ~25 тиков.
  while (gameClock.now() - armedAt < chargeTicks * 50 && !ctl.aborted) {
    await sleep(50)
    if (stillOk && !stillOk()) { await restoreOff(); out.note = 'булава: передумал взлетать'; out.cancelled = true; return out }
  }
  // Пока заряжалась булава, его удар мог подбросить: прыжок — только с земли,
  // а всплеск под летящим телом — вдалеке от ног. Ждём землю до 300 мс, иначе
  // не взлетать (2026-09-26).
  const tg = gameClock.now()
  while (!bot.entity.onGround && !ctl.aborted && gameClock.now() - tg < 300) await nextTick(bot)
  if (!bot.entity.onGround) { await restoreOff(); out.note = 'булава: передумал взлетать (не на земле)'; out.cancelled = true; return out }
  // Паутина на теле или блок над головой — всплеск не поднимет: в паутине
  // скорость гасится каждый тик (WebBlock.entityInside → makeStuckInBlock),
  // потолок её обнуляет. Арена 2026-09-26: «всплеск пришёл, vy 1.02 … vy max
  // −0.08» без толчков сервера — ровно (0 − 0.08)·0.98 после обнуления; его
  // «паутина под него» ложится за 9 тиков заряда булавы.
  const webNow = webOnBody(bot)
  if (webNow || headroom(bot, bot.entity.position, 4) < 3) { await restoreOff(); out.note = `булава: передумал взлетать (${webNow ? 'паутина' : 'над головой блок'})`; out.cancelled = true; return out }
  const hpSelf0 = bot.health ?? 20
  const theirHp0 = telemetryHp(e)
  const y0 = bot.entity.position.y
  const toward = yawTo(bot.entity.position, e.position)
  for (const k of KEYS) { try { bot.setControlState(k, false) } catch {} }
  if (stats) stats.launches++
  // Разбор взлёта (2026-09-26: в боях ~1 из 4 — «всплеск не поднял»): пришёл
  // ли всплеск (пакет explosion — mineflayer прибавляет его толчок к скорости),
  // били ли нас в эти тики (entity_velocity себе — сервер ставит скорость
  // целиком и может срезать подъём), что было в левой руке и на земле ли.
  const dg: any = { boom: 0, boomVy: null, kicks: 0, vyMax: -9, off: null, vy0: 0 }
  const onBoom = () => { dg.boom++; if (dg.boomVy == null) dg.boomVy = Math.round(bot.entity.velocity.y * 100) / 100 }
  const onKick = (buf) => { try { if (bot.entity && buf && [0, 1].some(o => buf[o] !== undefined && readVarIntAt(buf, o) === bot.entity.id)) dg.kicks++ } catch {} }
  try { bot._client.on('explosion', onBoom); bot._client.on('raw.entity_velocity', onKick) } catch {}
  const unDiag = () => { try { bot._client.removeListener('explosion', onBoom); bot._client.removeListener('raw.entity_velocity', onKick) } catch {} }
  // Прыжок: тик с отпущенным прыжком — сброс перезарядки автопрыжка
  // (prismarine-physics jumpTicks: пока прыжок зажат, следующий — через 10
  // тиков; бой перед этим мог прыгать за критом). Бросок — с земли,
  // следующий тик уже в прыжке: заряд не наследует скорость отрыва вверх.
  if (jump && bot.entity.onGround) {
    await nextTick(bot)
  }
  const fired: any = await fireWind(bot, moved => selfWindAim(bot, {
    moved, yaw: toward, back: bot.entity.onGround || bot.entity.velocity.y < .2 ? 0 : LAUNCH_BACK
  }), { swap, hand: swap ? 'main' : 'off', before: () => { try { bot.setControlState('jump', jump && bot.entity.onGround); dg.off = bot.inventory.slots[45] ? bot.inventory.slots[45].name : null; dg.vy0 = bot.entity.velocity.y; dg.web = webOnBody(bot) } catch {} } })
  if (fired.fired && jump) await nextTick(bot)
  try { bot.setControlState('jump', false) } catch {}
  if (!fired.fired) { unDiag(); await restoreOff(); out.note = 'булава: заряд не ушёл — ' + fired.why; return out }
  // Точка всплеска для урона от падения: сервер ставит позицию игрока в тик
  // всплеска (onExplosionHit); на подъёме это чуть выше пола — берём пол.
  bot._ndWind = { impactY: y0, until: gameClock.now() + 2000 }
  // Толчок приходит пакетом explosion (mineflayer прибавляет его к скорости):
  // ждём скачок вертикальной скорости.
  let launched = false
  const waitLift = async () => {
    for (let i = 0; i < 10 && !ctl.aborted; i++) {
      await nextTick(bot)
      dg.vyMax = Math.max(dg.vyMax, bot.entity.velocity.y)
      if (bot.entity.velocity.y > 0.55) return true
    }
    return false
  }
  launched = await waitLift()
  // Бой прервали или нас убили посреди взлёта (арена 2026-09-26: «не взлетел»
  // оказался смертью от его булавы в тот же миг) — это не неудача взлёта.
  if (!launched && (ctl.aborted || (bot.health ?? 0) <= 0)) {
    unDiag(); bot._ndWind = null
    if (stats) stats.launches--
    out.aborted = true; out.note = 'булава: взлёт прерван (' + ((bot.health ?? 0) <= 0 ? 'убит' : 'бой прервали') + ')'
    return out
  }
  // Не поднял — второй заряд стоя, строго под ноги (стоя всплеск даёт
  // v ≈ 1.09, замер probe-mace): как сядем (слабый всплеск подкинул на блок),
  // после перезарядки (10 тиков).
  if (!launched) { const t2 = gameClock.now(); while (!bot.entity.onGround && !ctl.aborted && gameClock.now() - t2 < 1500) await nextTick(bot) }
  if (!launched && bot.entity.onGround && windCount(bot) > 0 && !ctl.aborted && (!stillOk || stillOk())) {
    const why1 = diagText(dg)
    const t1 = gameClock.now()
    while (gameClock.now() < (bot._ndWindCd || 0) && gameClock.now() - t1 < 700) await sleep(25)
    const f2: any = await fireWind(bot, moved => selfWindAim(bot, { moved }), { swap, hand: swap ? 'main' : 'off' })
    if (f2.fired) {
      bot._ndWind = { impactY: bot.entity.position.y, until: gameClock.now() + 2000 }
      launched = await waitLift()
      if (launched) { out.retry = why1; if (stats) stats.retries = (stats.retries || 0) + 1 }
    }
  }
  unDiag()
  if (!launched) { bot._ndWind = null; await restoreOff(); out.note = 'булава: всплеск не поднял (' + diagText(dg) + ')'; out.why = diagText(dg); return out }
  out.launched = true
  if (stats) stats.launched++
  const r: any = await descend(bot, ctl, e, { vel, swap, stats, telemetryHp, chain })
  const peak = r.peak - y0
  out.peak = Math.round(peak * 100) / 100
  if (stats) stats.peaks.push(out.peak)
  out.hit = !!r.hit
  out.swung = !!r.hit
  out.hits = r.hits; out.relocated = r.relocated
  if (r.hit) {
    await sleep(200)
    out.fall = r.hit.fall
    out.charged = r.hit.charged
    out.expect = Math.round(smashDamage(r.hit.fall, { base: MACE_BASE, charge: r.hit.charged ? 1 : 0.8, density: densityOf(bot) }))
    // Сколько снял: минимум его здоровья после удара (регенерация при
    // сытости возвращает по 1 хп в 10 тиков — берём самое низкое).
    const hpMin = r.hit.hpMin != null ? r.hit.hpMin : telemetryHp(e)
    out.dealt = theirHp0 != null && hpMin != null ? Math.max(0, theirHp0 - hpMin) : null
    if (stats) { stats.smashHits += r.hits?.length || 1; if (out.dealt != null) stats.dealt.push(out.dealt) }
  }
  await sleep(150)
  out.self = Math.max(0, hpSelf0 - (bot.health ?? 20))
  // Откуда урон себе: в воздухе (его удары, стрелы) или при посадке (падение
  // ниже всплеска, лава, огонь) — для разбора.
  if (out.self > 0.5) {
    const feet = bot.blockAt(bot.entity.position.floored())
    const under = bot.blockAt(bot.entity.position.floored().offset(0, -1, 0))
    out.selfWhy = `в воздухе −${Math.round(Math.max(0, hpSelf0 - (r.hit ? r.hit.selfHp : hpSelf0)) * 10) / 10}, сел на ${under ? under.name : '?'}${feet && feet.name !== 'air' ? ' в ' + feet.name : ''}, от всплеска ${Math.round((bot.entity.position.y - y0) * 10) / 10}`
  }
  if (stats) { stats.selfDmg += out.self; stats.smashes++ }
  await restoreOff()
  out.note = r.hit
    ? `булава: взлёт ${out.peak} бл., удар с падения ${out.fall} бл.${out.charged ? ' (заряжена)' : ''}${out.dealt != null ? ` — снял ${Math.round(out.dealt * 10) / 10} хп` : ''}${out.self ? `, себе −${Math.round(out.self)} (${out.selfWhy || ''})` : ''}`
    : `булава: взлёт ${out.peak} бл., не достал (${r.why})${out.self ? `, себе −${Math.round(out.self)} (${out.selfWhy || ''})` : ''}`
  return out
}

// Падаем сами (со столба, с уступа) — и он внизу рядом: тот же спуск с ударом.
// Булава должна быть в хотбаре; урон — от высоты этого падения.
export function fallSmashReady (bot, e) {
  if (!e || !e.position || !bot.entity) return false
  if (!findItem(bot, 'mace')) return false
  const me = bot.entity.position
  const dy = me.y - e.position.y
  const dh = Math.hypot(e.position.x - me.x, e.position.z - me.z)
  return dy > 2 && dh < 4.5
}
