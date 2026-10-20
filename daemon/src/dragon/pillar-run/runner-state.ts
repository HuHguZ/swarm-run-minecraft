'use strict'
// Бой с драконом (dragon/pillar-run.ts): бегун по столбу (pillarRun, runner.ts) — состояние прогона. Прежние let и стрелки
// замыкания pillarRun — поля объекта rs (RunState); значения одного оборота цикла — tk (RunTick). Шаги цикла —
// runner-steps.ts, runner-pass.ts, runner-click.ts: шаг возвращает 'next' (прежний continue), 'stop' (прежний break)
// или ничего (дальше по шагам).
import { gameClock, Vec3, stepTo, PHASE, EYE, SITTING, clearControls, box, RUN_SEEN } from '../dig-down-to'
import { doing, r1, podiumTop } from '../fall-guard'
import { countOf, lookAtSafe, DRAD, virtualBot, exposure } from '../evade-raw'
import { pillarHere, smCompile, smDragonSeen, SM_EMPTY } from '../station-plan'
import { pillarCells, faceClick, BED_GAP_MS } from '../pillar-plan'
import { anchorCharges } from '../ts-plan'
import { bedsBoom } from './beds-act'
import { pillarEnter } from './pillar-build'

export type Turn = 'next' | 'stop' | undefined

export interface RunState {
  session: any
  ctl: any
  stats: any
  track: any
  feed: any
  bot: any
  ev: (k: any, o: any) => void
  st: any
  plan: any
  runnerLevels: any
  P: number
  out: any
  t0: number
  H: any
  F: any
  yb: number
  bedHere: () => boolean
  bedCells: any[]
  Apos: any
  Acentre: any
  anMode: string
  anchorAt: () => number
  torchSetP: Set<string>
  torchHitP: (eye: any, d: any, len: any) => boolean
  anClick: (vb: any) => any
  recenter: () => Promise<boolean>
  anchorOk: () => boolean
  noBoom: () => boolean
  cellHit: (st2: any) => boolean
  lastBoom: number
  gapKey: any
  keepKey: any
  supBan: Map<any, any>
  smSnap: any
  smCache: Map<any, any>
  fcNow: any
  seenNote: (k: any) => any
  pushed: any
  placedSince: boolean
  salvage: (tag: any) => Promise<boolean>
  tEnd: number
}

// Значения одного оборота (прежние const/let тела while, нужные нескольким шагам).
export interface RunTick {
  dd?: any
  ph?: any
  hereAn?: number
  useAn?: boolean
  fc?: any
  nowTick?: number
  minTick?: number
  ctr?: any
  placeClick?: boolean
  pass?: any
  win?: any
  clickI?: number
  hit?: any
  pre?: any
  tClick?: number
  rateNow?: number
  tClickMono?: number | null
  dClick?: number
  aimAt?: any
}

// Начало прогона: план, клетки кровати, якорь, мелкие проверки (прежнее начало pillarRun до try).
export function runOpen (session, ctl, stats, track, feed): RunState {
  const bot = session.bot
  const rs = { session, ctl, stats, track, feed, bot } as RunState
  rs.ev = (k, o) => { if (ctl.trace) ctl.trace.ev(k, o) }
  rs.st = ctl.pillar
  rs.plan = rs.st.plan
  rs.runnerLevels = rs.plan.runnerLevels
  rs.P = podiumTop(bot)
  rs.out = { booms: [], why: null }
  rs.t0 = gameClock.now()
  rs.H = rs.plan.H; rs.F = rs.plan.F; rs.yb = rs.plan.yb
  rs.bedHere = () => /_bed$/.test((bot.blockAt(new Vec3(rs.H.x, rs.yb, rs.H.z)) || {}).name || '') && /_bed$/.test((bot.blockAt(new Vec3(rs.F.x, rs.yb, rs.F.z)) || {}).name || '')
  rs.bedCells = [{ x: rs.F.x, y: rs.yb, z: rs.F.z }, { x: rs.H.x, y: rs.yb, z: rs.H.z }]
  // Якорь возрождения (если есть якоря и светокамень): взрыв той же силы, дракон его не ломает (dragon_immune) —
  rs.Apos = new Vec3(rs.F.x, rs.yb, rs.F.z)
  rs.Acentre = new Vec3(rs.F.x + 0.5, rs.yb + 0.5, rs.F.z + 0.5)
  rs.anMode = process.env.ND_PILLAR_ANCHOR || 'last'
  rs.anchorAt = () => anchorCharges(bot, rs.Apos)
  rs.torchSetP = new Set(pillarCells(rs.plan.P ?? rs.yb + 1).torches.map(t => `${t.x},${t.y},${t.z}`))
  rs.torchHitP = (eye, d, len) => { if (rs.runnerLevels) return false; for (let t = 0; t < len; t += 0.1) { const q = eye.plus(d.scaled(t)); if (rs.torchSetP.has(`${Math.floor(q.x)},${Math.floor(q.y)},${Math.floor(q.z)}`)) return true } return false }
  rs.anClick = (vb) => { const eye = bot.entity.position.offset(0, EYE, 0); for (const f of [[1, 0, 0], [-1, 0, 0], [0, 0, 1], [0, 0, -1], [0, -1, 0], [0, 1, 0]]) { const c = faceClick(vb, eye, rs.Apos, new Vec3(f[0], f[1], f[2]), { reach: 4.3, avoidTorch: rs.torchHitP }); if (c) return { point: c.point, face: new Vec3(f[0], f[1], f[2]) } } return null }
  // F ближе к окопу, чем H, и закрыт хуже (pil7-22: 1–1.5 хп нам за якорь против 0.3 за кровать) — при хп < 12 только кровати
  rs.recenter = async () => {
    rs.out.recenter = (rs.out.recenter || 0) + 1
    if (rs.out.recenter > (rs.runnerLevels ? 12 : 3)) return false
    const q = bot.entity.position
    await stepTo(bot, ctl, rs.runnerLevels ? new Vec3(rs.plan.feet.x, q.y, rs.plan.feet.z) : new Vec3(rs.plan.B.x + 0.5, q.y, rs.plan.B.z + 0.5), { ms: 700, sprint: false, stopAt: 0.06, portal: true })
    clearControls(bot)
    // взрыв мог выбить эндерняк у окопа (якорь в F ближе к нам) — тогда окоп заново (глубже — подняться)
    if (!pillarHere(bot, rs.plan)) await pillarEnter(session, ctl, rs.plan)
    return true
  }
  rs.anchorOk = () => !rs.runnerLevels && rs.anMode !== '0' && !rs.st.noAnchor && bot.health >= 12 && countOf(bot, /^respawn_anchor$/) >= 1 && countOf(bot, /^glowstone$/) >= 1
  // Поставленная, но не взорванная кровать — тоже заряд (01.10: последняя из 7 ставилась и бросалась — «кровати кончились»
  // при 0 в рюкзаке, хотя кровать стояла у столба: 6 взрывов из 7 в 41 из 58 вызовов).
  rs.noBoom = () => countOf(bot, /_bed$/) < 1 && !rs.bedHere() && !rs.anchorOk() && rs.anchorAt() < 1
  rs.cellHit = (st2) => {
    // клетки кровати в коробках головы/шеи/тела (checkWalls — по клеткам)
    const M = 0.1
    const hb = box(st2.head.x, st2.head.y - M, st2.head.z, 0.5, 1 + M); const nb = box(st2.neck.x, st2.neck.y - M, st2.neck.z, 1.5, 3 + M)
    const by = box(st2.pos.x + Math.sin(st2.yRot * DRAD) * 0.5, st2.pos.y - M, st2.pos.z - Math.cos(st2.yRot * DRAD) * 0.5, 2.5, 3 + M)
    const cellsOf = b => ({ x0: Math.floor(b.min.x), x1: Math.floor(b.max.x - 1e-7), y0: Math.floor(b.min.y), y1: Math.floor(b.max.y - 1e-7), z0: Math.floor(b.min.z), z1: Math.floor(b.max.z - 1e-7) })
    return [hb, nb, by].some(b => { const c = cellsOf(b); return rs.bedCells.some(q => q.x >= c.x0 && q.x <= c.x1 && q.y >= c.y0 && q.y <= c.y1 && q.z >= c.z0 && q.z <= c.z1) })
  }
  return rs
}

// Вход в окоп и решение о якоре (прежнее начало try): итог — out для немедленного возврата или undefined.
export async function runEnter (rs: RunState) {
  const { bot, session, ctl } = rs
  if (rs.noBoom()) { rs.out.why = 'кровати кончились'; return rs.out }
  doing(ctl, 'pillar:enter')
  if (!(await pillarEnter(session, ctl, rs.plan))) { rs.out.why = 'в окоп не встал'; return rs.out }
  // якорь в H с этого места щёлкается? (иначе — только кровати)
  if (rs.anchorOk() && rs.anchorAt() < 0 && !rs.anClick(virtualBot(bot, new Map([[`${rs.F.x},${rs.yb},${rs.F.z}`, 'block']])))) { rs.st.noAnchor = true; rs.out.anchor = 'не видно' }
  // открытость окопа взрыву в F: > 0.3 — якоря не ставить (урон нам ~2+ за взрыв)
  if (rs.anchorOk() && !rs.st.anExpo) { rs.st.anExpo = exposure(bot, bot.entity.position, rs.Acentre); rs.out.anExpo = r1(rs.st.anExpo * 100) / 100; if (rs.st.anExpo > 0.3) { rs.st.noAnchor = true; rs.out.anchor = 'окоп открыт взрыву в F' } }
}

// Состояние цепочки взрывов: снимок мира для seen, спасение поставленной кровати, срок (прежние let внутри try).
export function runArm (rs: RunState) {
  const { bot, session, ctl, stats } = rs
  rs.lastBoom = stats.lastBoom || 0
  rs.gapKey = null
  rs.keepKey = null
  rs.supBan = new Map()
  // снимок мира у станции R для seen (без клеток кровати и опоры под F — их форма зависит от яруса), один на цепочку
  rs.smSnap = null; rs.smCache = new Map()
  if (rs.runnerLevels && RUN_SEEN()) {
    const t0s = gameClock.now()
    try { rs.smSnap = smCompile(bot, [-16, rs.P - 6, -16, 16, rs.P + 16, 16], (x, y, z) => x === 0 && (z === 0 || z === rs.F.z) && y >= rs.P && y <= rs.P + 1) } catch (e) { rs.smSnap = null }
    rs.out.smMs = gameClock.now() - t0s; rs.out.smN = rs.smSnap ? rs.smSnap.colliders.length : null
  }
  // прогноз seen родителя и высоты тела над ярусом в тик щелчка — в событие bed (сверка с сервером, DragonLab)
  rs.fcNow = null
  rs.seenNote = (k) => {
    try {
      const st0 = rs.fcNow && rs.fcNow.path[k]
      if (!st0) return {}
      const o: any = { bodyDy: r1(st0.pos.y - rs.yb) }
      if (rs.smSnap) { const sp = smDragonSeen(rs.smSnap, new Vec3(0.5, rs.yb + 0.5, 0.5), st0.pos, rs.yb > rs.P ? [[0, rs.P, rs.F.z, 1, rs.P + 1, rs.F.z + 1]] : SM_EMPTY); if (sp != null) o.seenP = Math.round(sp * 1000) / 1000 }
      return o
    } catch (e) { return {} }
  }
  rs.pushed = null
  rs.placedSince = rs.bedHere()
  // Поставленная кровать без прохода (садится/сел) — взорвать сейчас, а не отдать коробкам дракона (st1: «садится без
  rs.salvage = async (tag) => {
    if (!rs.bedHere() || gameClock.now() < (stats.lastBoom || 0) + BED_GAP_MS) return false
    const eye = bot.entity.position.offset(0, EYE, 0)
    let hitCell = new Vec3(rs.plan.click.cell.x, rs.yb, rs.plan.click.cell.z)
    let hit = faceClick(bot, eye, hitCell, new Vec3(rs.plan.click.face.x, rs.plan.click.face.y, rs.plan.click.face.z))
    // плановая грань не видна (толчок сдвинул в окопе) — любая видимая грань кровати
    for (const cell of [rs.F, rs.H]) for (const fc of [[1, 0, 0], [-1, 0, 0], [0, 0, 1], [0, 0, -1], [0, -1, 0], [0, 1, 0]]) { if (!hit) { const c3 = new Vec3(cell.x, rs.yb, cell.z); hit = faceClick(bot, eye, c3, new Vec3(fc[0], fc[1], fc[2])); if (hit) hitCell = c3 } }
    if (!hit) { rs.out.salvageFail = (rs.out.salvageFail || 0) + 1; return false }
    await lookAtSafe(bot, hit.point)
    await new Promise<any>(resolve => bot.once('physicsTick', resolve))
    const r = await bedsBoom(session, ctl, stats, { ...rs.plan, dist: null, expect: null, D: rs.plan.a, y: rs.yb, reuse: true }, { point: hit.point, block: bot.blockAt(hitCell) }, 'снижение', { aimed: true, until: gameClock.now(), uncounted: true, phCheck: p => p === PHASE.LANDING || SITTING.has(p), note: { oc: 'P', salvage: tag } })
    rs.out.booms.push(r.ok ? r.dmg : null)
    rs.out.salvage = (rs.out.salvage || 0) + 1
    if (r.ok) { rs.lastBoom = stats.lastBoom || gameClock.now(); rs.st.booms++; rs.placedSince = false; rs.pushed = null }
    return r.ok
  }
  rs.tEnd = gameClock.now() + 60000
}
