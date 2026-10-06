'use strict'
const gameClock = require('./game-clock')
// Броски: жемчуг, взрывные и оседающие зелья, снежки. Задача та же, что у лука
// (bow.js), но физика своя, и прошлый прицел (pvp.ballisticPitch) её не знал:
//   * порядок тика другой: у брошенного предмета (ThrowableProjectile.tick,
//     1.21.2+) сначала гравитация, потом трение, потом сдвиг — у стрелы сдвиг
//     первым;
//   * зелья летят не туда, куда смотришь: предмет бросает с поправкой zRot=-20°,
//     а shootFromRotation подмешивает её только в вертикаль
//     (y = -sin(xRot + zRot)) — бросок выше взгляда;
//   * сервер прибавляет к снаряду смещение бросающего из последнего пакета
//     движения (getKnownMovement; вертикаль — только в воздухе), как и стреле.
//     У жемчуга скорость 1.5, а бег — 0.28 блока за тик: без поправки бросок на
//     бегу уходит на метры.
// Вылет — с высоты глаз − 0.1, как у стрелы.

const Vec3 = require('vec3')
const { sleep } = require('./movement')

const DEG = Math.PI / 180

// speed — сила броска, g — гравитация за тик, roll — zRot в градусах.
const KINDS = {
  ender_pearl: { speed: 1.5, g: 0.03, roll: 0 },
  snowball: { speed: 1.5, g: 0.03, roll: 0 },
  egg: { speed: 1.5, g: 0.03, roll: 0 },
  splash_potion: { speed: 0.5, g: 0.05, roll: -20 },
  lingering_potion: { speed: 0.5, g: 0.05, roll: -20 },
  experience_bottle: { speed: 0.7, g: 0.07, roll: -20 }
}
const DRAG = 0.99

// Бросок в прыжке (06.10, просьба пользователя). Сверено с paper-1.21.11 (javap): Projectile.shootFromRotation
// прибавляет к снаряду getKnownMovement бросающего — у ServerPlayer это сдвиг из последнего пакета движения
// (handleMovePlayer: новая позиция − старая; без пакета за тик tick_end обнуляет), вертикаль — только если в
// этом пакете onGround = false. Прыжок (LivingEntity.jumpFromGround / travelInAir, тело — prismarine-physics):
// тик отрыва сдвигает вверх на 0.42, со спринтом ещё +0.2 по взгляду поверх скорости бега. Лучший тик броска —
// тик отрыва: +0.42 к вертикали снаряда дают больше, чем +1.25 высоты на вершине (дальность при dy 0: с места
// 51.3, тик отрыва 65.8, вершина 52.4; разбег 6 тиков и отрыв — 90.9; research/claude-1006/pearl-jump.md).
const JUMP_VY = 0.42
const RUN_TICKS = 6 // разбег из покоя до прыжка
const RUN_H = 0.4766 // сдвиг тика отрыва по горизонтали после разбега RUN_TICKS из покоя (прогон prismarine-physics)
const RUN_AHEAD = 1.832 // ноги на тике отрыва впереди старта
const RUNWAY = 4 // старт → посадка тела (разбег, отрыв, полёт с отпущенными клавишами — 3.7 бл.)
const EYE = 1.62 - 0.1

// Точка вылета и сдвиг тика отрыва по модели (для планировщиков): kind 'stand' (прыжок на месте) или 'run'
// (разбег по dir — единичный {x, z}), eye — высота вылета над ногами.
function jumpLaunch (feet, kind, dir = null, eye = EYE) {
  const run = kind === 'run' && dir
  const a = run ? RUN_AHEAD : 0
  const h = run ? RUN_H : 0
  return {
    from: new Vec3(feet.x + (run ? dir.x * a : 0), feet.y + JUMP_VY + eye, feet.z + (run ? dir.z * a : 0)),
    moved: { x: run ? dir.x * h : 0, y: JUMP_VY, z: run ? dir.z * h : 0 }
  }
}

// Можно ли прыгнуть (и разбежаться по dir на len): под каждой клеткой пути твёрдый пол без огня/лавы/магмы,
// над ним 2 клетки и голова в прыжке свободны (потолок срезает 0.42), а вокруг пути не край — у соседей земля не
// глубже 3 блоков или стена, и нет лавы. world(x, y, z) -> блок | null. -> null (можно) или причина.
const WET = /lava|water|fire|cobweb|powder_snow|bubble_column|portal/
function jumpRoom (world, feet, dir = null, len = RUNWAY) {
  const solid = b => !!b && b.boundingBox === 'block'
  const open = b => !!b && b.boundingBox === 'empty' && !WET.test(b.name)
  const fy = Math.floor(feet.y - 0.01) + 1
  const headY = Math.floor(feet.y + 1.8 + JUMP_VY)
  const cells = new Map()
  const n = dir ? Math.ceil(len * 2) : 0
  for (let i = 0; i <= n; i++) {
    for (const s of dir ? [-0.3, 0, 0.3] : [0]) {
      const x = Math.floor(feet.x + (dir ? dir.x * i / 2 - dir.z * s : 0))
      const z = Math.floor(feet.z + (dir ? dir.z * i / 2 + dir.x * s : 0))
      cells.set(x + ',' + z, [x, z])
    }
  }
  for (const [x, z] of cells.values()) {
    const floor = world(x, fy - 1, z)
    if (!solid(floor)) return dir ? 'разбег: нет пола' : 'нет пола'
    if (HURT.test(floor.name)) return `пол ${floor.name}`
    for (let y = fy; y <= Math.max(fy + 1, headY); y++) if (!open(world(x, y, z))) return 'потолок'
    for (let dx = -1; dx <= 1; dx++) {
      for (let dz = -1; dz <= 1; dz++) {
        if (!dx && !dz) continue
        if (solid(world(x + dx, fy, z + dz))) continue
        let ground = false
        for (let k = 1; k <= 4 && !ground; k++) {
          const b = world(x + dx, fy - k + 1, z + dz)
          if (!b) return 'не прогружено'
          if (HURT.test(b.name)) return `рядом ${b.name}`
          ground = k > 1 && solid(b)
        }
        if (!ground) return 'край'
      }
    }
  }
  return null
}

function kindOf (name) {
  return KINDS[name] || null
}

// Скорость вылета при взгляде с наклоном p (радианы, вверх +, как в
// mineflayer): горизонталь и вертикаль до нормировки — cos p и sin(p − roll).
function launch (p, k) {
  const h = Math.cos(p)
  const v = Math.sin(p - k.roll * DEG)
  const n = Math.hypot(h, v)
  return { vh: k.speed * h / n, vy: k.speed * v / n }
}

// Полёт по горизонтали dx: высота на dx и тики. Порядок тика — как у
// ThrowableProjectile: гравитация, трение, сдвиг.
function flight (vh, vy, dx, k) {
  let x = 0; let y = 0
  for (let t = 1; t <= 300; t++) {
    vy = (vy - k.g) * DRAG
    vh *= DRAG
    const nx = x + vh
    const ny = y + vy
    if (nx >= dx) {
      const f = (dx - x) / (nx - x)
      return { y: y + (ny - y) * f, ticks: t - 1 + f }
    }
    x = nx; y = ny
    if (vh < 1e-3 || y < -200) return null
  }
  return null
}

// Наклон взгляда, при котором снаряд на dx окажется на высоте dy (низкая
// траектория). Высота на dx растёт с наклоном только до угла наибольшей
// дальности, поэтому сначала шагом ищем первое пересечение снизу вверх, потом
// делим пополам. extra(p) -> {dvh, dvy} — прибавка скорости (своё движение).
function solve (dx, dy, k, extra = null) {
  const at = (p) => {
    const l = launch(p, k)
    const e = extra ? extra(p, l) : null
    if (e === false) return null
    const vh = l.vh + (e ? e.dvh : 0)
    if (vh <= 0.02) return null
    const f = flight(vh, l.vy + (e ? e.dvy : 0), dx, k)
    return f
  }
  const step = 0.5 * DEG
  let prev = null
  let prevP = null
  for (let p = -80 * DEG; p <= 80 * DEG; p += step) {
    const f = at(p)
    if (f && f.y >= dy) {
      if (!prev) {
        // Уже на самом низком наклоне выше цели — цель круто под ногами.
        if (p <= -80 * DEG + 1e-9) return { pitch: p, ticks: f.ticks }
        // Нижний соседний наклон не долетал — ищем границу между ними.
        let lo = prevP === null ? p - step : prevP
        let hi = p
        for (let i = 0; i < 30; i++) {
          const mid = (lo + hi) / 2
          const m = at(mid)
          if (m && m.y >= dy) hi = mid
          else lo = mid
        }
        const g = at(hi)
        return g ? { pitch: hi, ticks: g.ticks } : null
      }
      let lo = prevP
      let hi = p
      for (let i = 0; i < 30; i++) {
        const mid = (lo + hi) / 2
        const m = at(mid)
        if (m && m.y >= dy) hi = mid
        else lo = mid
      }
      const g = at(hi)
      return g ? { pitch: hi, ticks: g.ticks } : null
    }
    prev = f
    prevP = p
  }
  return null
}

// Прицел в точку target (Vec3 или fn(ticks) -> Vec3 для движущейся цели) из
// from (точка вылета), с учётом своего движения u (блоки за тик; вертикаль —
// только airborne). Возвращает { yaw, pitch, ticks, at }.
function aim (from, target, k, u = null, airborne = false) {
  const targetAt = typeof target === 'function' ? target : () => target
  const uy = u && airborne ? u.y : 0
  let ticks = from.distanceTo(targetAt(0)) / k.speed
  let out = null
  for (let iter = 0; iter < 5; iter++) {
    const P = targetAt(ticks)
    const tx = P.x - from.x
    const tz = P.z - from.z
    const dx = Math.hypot(tx, tz)
    if (dx < 0.3) return null
    const T = { x: tx / dx, z: tz / dx }
    const N = { x: -T.z, z: T.x }
    const uPar = u ? u.x * T.x + u.z * T.z : 0
    const uPerp = u ? u.x * N.x + u.z * N.z : 0
    // Поперечную часть своего движения гасим поворотом: s — синус отклонения
    // взгляда от линии на цель; продольная просто прибавляется.
    const extra = (p, l) => {
      const s = -uPerp / l.vh
      if (Math.abs(s) >= 0.95) return false
      return { dvh: l.vh * (Math.sqrt(1 - s * s) - 1) + uPar, dvy: uy }
    }
    const sol = solve(dx, P.y - from.y, k, extra)
    if (!sol) return null
    const l = launch(sol.pitch, k)
    const s = -uPerp / l.vh
    const a = Math.sqrt(1 - s * s)
    const dir = { x: T.x * a + N.x * s, z: T.z * a + N.z * s }
    out = { yaw: Math.atan2(-dir.x, -dir.z), pitch: sol.pitch, ticks: Math.round(sol.ticks * 10) / 10, at: P }
    ticks = sol.ticks
  }
  return out
}

// Куда упадёт: тот же полёт в 3D с лучом по блокам на каждом отрезке.
// at — где разобьётся (зелье: облако и брызги отсюда). tp — куда перенесёт
// жемчуг: не точка удара, а позиция жемчуга в начале тика, в котором он
// ударился (ThrownEnderpearl.onHit → oldPosition()), до полутора блоков раньше
// по пути и выше пола; падение после переноса обнуляется.
function landing (bot, from, yaw, pitch, k, u = null, airborne = false) {
  const l = launch(pitch, k)
  let v = new Vec3(-Math.sin(yaw) * l.vh, l.vy, -Math.cos(yaw) * l.vh)
  if (u) v = v.plus(new Vec3(u.x, airborne ? u.y : 0, u.z))
  let p = from.clone()
  for (let t = 0; t < 300; t++) {
    v = new Vec3(v.x * DRAG, (v.y - k.g) * DRAG, v.z * DRAG)
    const len = v.norm()
    if (len < 1e-4) return { at: p, tp: p, ticks: t }
    try {
      // Копией: Vec3.normalize() меняет сам вектор — скорость стала бы единичной.
      const hit = bot.world.raycast(p, v.scaled(1 / len), len, b => b && b.boundingBox === 'block')
      if (hit) return { at: hit.intersect || hit.position.offset(0.5, 1, 0.5), tp: p, block: hit, ticks: t + 1 }
    } catch { return null }
    p = p.plus(v)
    if (p.y < -64) return { at: p, tp: p, void: true, ticks: t + 1 }
  }
  return null
}

// Прыгать ли перед броском. jump: true — прыгнуть, если есть место (jumpRoom); 'auto' — только если с места цель
// не достать или pick с прыжком даёт заметно больше очков (pick вернул sc; без sc — прыжок, только если с места
// pick ничего не нашёл). sprint — можно с разбегом: к цели или по runYaw (для pick). -> null | { kind, yaw }.
// Для 'auto' pick зовётся и здесь, с предсказанным ctx (ноги в покое) — он должен быть без побочных эффектов.
function jumpChoice (bot, target, k, { jump, sprint = false, runYaw = null, pick = null }: any = {}) {
  const e = bot.entity
  if (!jump || !e || !e.onGround || e.isInWater || e.isInLava || e.elytraFlying) return null
  const feet = e.position
  const eye = require('./pick').eyeHeight(bot) - 0.1
  const world = (x, y, z) => bot.blockAt(new Vec3(x, y, z))
  const P = target == null ? null : typeof target === 'function' ? target(0) : target
  const yaw = P ? Math.atan2(-(P.x - feet.x), -(P.z - feet.z)) : runYaw
  const dir = yaw == null ? null : { x: -Math.sin(yaw), z: -Math.cos(yaw) }
  const run = sprint && dir && (bot.food ?? 20) > 6 && !bot.getControlState?.('sneak')
  let best = null
  for (const kind of [...(jump === 'auto' ? ['none'] : []), 'stand', ...(run ? ['run'] : [])]) {
    if (kind !== 'none' && jumpRoom(world, feet, kind === 'run' ? dir : null)) continue
    if (jump === true) { best = { kind }; continue } // разбег, если можно, иначе на месте
    const air = kind !== 'none'
    const L = air ? jumpLaunch(feet, kind, dir, eye) : { from: feet.offset(0, eye, 0), moved: null }
    if (P) {
      if (aim(L.from, P, k, L.moved, air)) return air ? { kind, yaw } : null
      continue
    }
    if (!pick) break
    const moved = L.moved || { x: 0, y: 0, z: 0 }
    const s = pick({ from: L.from, moved, airborne: air, landing: (yw, pt) => landing(bot, L.from, yw, pt, k, moved, air) })
    if (s && (!best || (s.sc ?? 0) > best.sc + 0.5)) best = { kind, sc: s.sc ?? 0 }
  }
  return best && best.kind !== 'none' ? { kind: best.kind, yaw } : null
}

// Бросок: держим предмет в руке, прицел по последнему тику физики. Сервер
// ставит снаряд в позицию и прибавляет смещение из последнего пакета движения,
// а наклон берёт из пакета use_item (1.21: поворот едет в нём же). Поэтому:
// в physicsTick (позиция этого тика уже посчитана, смещение — то, что уйдёт в
// пакете) считаем прицел и ставим взгляд — пакет движения уйдёт уже с ним, —
// а бросаем следующей задачей, после пакета.
// target — точка (Vec3), fn(ticks) -> Vec3 для движущейся цели, или null с
// pick(ctx) -> {yaw, pitch} | null: выбрать направление самому (побег жемчугом),
// где ctx = { from, moved, airborne, landing(yaw, pitch) } — посчитано на том
// же тике, что и бросок.
// jump: false | true | 'auto', sprint, runYaw — бросок в прыжке (jumpChoice): прыжок/разбег делает сам throwAt,
// бросок — на тике отрыва; в ответе jump: 'stand' | 'run' | null.
async function throwAt (bot, target, { item = null, mode = 'exact', onAim = null, pick = null, preferOffhand = false, jump = false, sprint = false, runYaw = null }: any = {}) {
  const held = bot.heldItem
  const it = item || held
  if (!it) return { thrown: false, why: 'нечего бросать' }
  const k = kindOf(it.name)
  if (!k) return { thrown: false, why: `${it.name} не бросается` }
  const hand = require('./combat/throw-hand').throwHand({ item: it.name, mainItem: held?.name ?? null,
    usingItem: !!bot.usingHeldItem, preferOffhand })
  const offBefore = bot.inventory.slots[45]?.name ?? null
  const equipped = hand === 'off-hand' ? bot.inventory.slots[45] : held
  if (!equipped || equipped.type !== it.type || equipped.slot !== it.slot) {
    try { await bot.equip(it, hand) } catch (e) { return { thrown: false, why: e.message } }
  }
  const restoreOffhand = async () => {
    if (hand !== 'off-hand' || !offBefore || offBefore === it.name) return
    const previous = bot.inventory.items().find(i => i.name === offBefore)
    if (previous) await bot.equip(previous, 'off-hand').catch(() => {})
  }
  const hop = mode === 'old' ? null : jumpChoice(bot, target, k, { jump, sprint, runYaw, pick })
  const set = (c, v) => { try { bot.setControlState(c, v) } catch {} }
  const release = () => { if (hop) for (const c of ['forward', 'sprint', 'jump']) set(c, false) }
  try {
  let lastPos = bot.entity.position.clone()
  let moved = { x: 0, y: 0, z: 0 }
  // Прыжок: на первом тике клавиши (разбег — вперёд со спринтом по hop.yaw, RUN_TICKS тиков, потом прыжок), бросок
  // — на тике отрыва, когда этот же пакет движения несёт onGround = false и сдвиг (h, 0.42). Не оторвался за
  // RUN_TICKS + 4 тика — бросок с земли (прицел честный и так).
  let pressed = false
  let n = 0
  const lifted = () => {
    n++
    if (!bot.entity.onGround && (pressed || moved.y < -0.05)) return true
    if (!pressed && n >= RUN_TICKS) { set('jump', true); pressed = true }
    return n > RUN_TICKS + 4
  }
  const res: any = await new Promise<any>(resolve => {
    let done = false
    const onT: any = require('node:async_hooks').AsyncResource.bind(() => {
      if (done) return
      const p = bot.entity.position
      moved = { x: p.x - lastPos.x, y: p.y - lastPos.y, z: p.z - lastPos.z }
      lastPos = p.clone()
      // Первый тик — только чтобы узнать смещение; бросаем на втором.
      if (!onT.primed) {
        onT.primed = true
        if (hop) {
          for (const c of ['back', 'left', 'right', 'sneak']) set(c, false)
          const r = hop.kind === 'run'
          if (r) { bot.entity.yaw = hop.yaw; bot.look(hop.yaw, 0, true).catch(() => {}) }
          set('forward', r); set('sprint', r); set('jump', !r); pressed = !r
        }
        return
      }
      if (hop && !lifted()) return
      release()
      done = true
      bot.removeListener('physicsTick', onT)
      const eyeHeight = require('./pick').eyeHeight(bot)
      const from = p.offset(0, eyeHeight - 0.1, 0)
      const airborne = !bot.entity.onGround
      let sol
      if (pick) {
        const mv = { ...moved }
        sol = pick({ from, moved: mv, airborne, landing: (yaw, pitch) => landing(bot, from, yaw, pitch, k, mv, airborne) })
      } else {
        sol = mode === 'old'
          ? oldAim(from, typeof target === 'function' ? target(0) : target, k)
          : aim(from, target, k, moved, airborne)
      }
      if (sol) bot.look(sol.yaw, sol.pitch, true).catch(() => {})
      const land = sol ? landing(bot, from, sol.yaw, sol.pitch, k, mode === 'old' ? null : moved, airborne) : null
      const shot = { sol, land, from, airborne, moved: { ...moved } }
      require('./edges').afterPacket(bot, () => {
        if (!sol) { resolve(shot); return }
        if (onAim && onAim(shot) === false) { resolve({ ...shot, cancelled: true }); return }
        bot.look(sol.yaw, sol.pitch, true).catch(() => {})
        // 750 TPS (s5, 06.10, свидетель DragonLab): bot.look под замком рефлексов асинхронный — поворот доезжал после броска,
        // а use_item несёт поворот из bot.entity: жемчуг улетал со старым взглядом (yaw 0/pitch 0 после tp — в пустоту;
        // pitch +34 — в блок у ног, перенос на 1 бл.). Взгляд броска — в bot.entity синхронно.
        if (bot.entity) { bot.entity.yaw = sol.yaw; bot.entity.pitch = sol.pitch }
        bot.activateItem(hand === 'off-hand')
        if (hand === 'off-hand') bot.usingHeldItem = false
        resolve(shot)
      })
    })
    bot.on('physicsTick', onT)
    // 750 TPS (s5, 06.10): CPU-план > 8 тиков реального времени — часы догоняют сервер скачком, и таймер срабатывает в том же
    // такте, что первый physicsTick («физика стоит» при живой физике). Первый тик был — ждать второй, не дольше 3 раз.
    let rearm = 3
    const stall = () => { if (done) return; if (onT.primed && rearm-- > 0) { gameClock.setTimeout(stall, 400); return } done = true; bot.removeListener('physicsTick', onT); resolve(null) }
    gameClock.setTimeout(stall, 400)
  })
  if (!res || !res.sol) return { thrown: false, why: res ? 'не долетит' : 'физика стоит', jump: hop?.kind ?? null }
  if (res.cancelled) return { thrown: false, why: 'отменил', land: res.land, jump: hop?.kind ?? null }
  return {
    thrown: true,
    jump: hop ? hop.kind : null,
    hand,
    yawDeg: Math.round(res.sol.yaw / DEG * 10) / 10,
    pitchDeg: Math.round(res.sol.pitch / DEG * 10) / 10,
    ticks: res.sol.ticks,
    airborne: res.airborne,
    moved: res.moved,
    land: pointOf(res.land, it.name)
  }
  } finally { release(); await restoreOffhand() }
}

// Где окажется результат броска: жемчуг — куда перенесёт, остальное — где разобьётся.
function pointOf (land, name) {
  if (!land) return null
  const q = name === 'ender_pearl' ? land.tp : land.at
  return q ? { x: +q.x.toFixed(2), y: +q.y.toFixed(2), z: +q.z.toFixed(2), void: land.void || undefined } : null
}

// Прошлый прицел (pvp.ballisticPitch) — для сравнения в тире: порядок тика
// стрелы, без zRot, без своего движения, перебор по градусу.
function oldAim (from, to, k) {
  const dx = Math.hypot(to.x - from.x, to.z - from.z)
  const dy = to.y - from.y
  let best = null
  for (let deg = -40; deg <= 60; deg += 1) {
    const a = deg * DEG
    let x = 0; let y = 0
    let vx = Math.cos(a) * k.speed; let vy = Math.sin(a) * k.speed
    for (let t = 0; t < 120; t++) {
      x += vx; y += vy
      vx *= DRAG; vy = vy * DRAG - k.g
      if (x >= dx) {
        const err = Math.abs(y - dy)
        if (!best || err < best.err) best = { pitch: a, err }
        break
      }
      if (y < dy - 30) break
    }
  }
  if (!best || best.err >= 1.5) return null
  return { yaw: Math.atan2(-(to.x - from.x), -(to.z - from.z)), pitch: best.pitch, ticks: null, at: to }
}

// Куда можно перенестись: под точкой переноса в пределах 4 блоков твёрдый пол
// (дальше — урон от падения, счётчик падения обнуляется в момент переноса), и
// это не лава, не огонь, не магма и не кактус; сама клетка не в лаве.
const HURT = /lava|fire|magma|cactus|campfire|sweet_berry|powder_snow/
function safeLanding (bot, tp) {
  if (!tp) return null
  const cell = tp.floored()
  const here = bot.blockAt(cell)
  if (!here || HURT.test(here.name)) return null
  for (let k = 0; k <= 4; k++) {
    const b = bot.blockAt(cell.offset(0, -k, 0))
    if (!b) return null
    if (HURT.test(b.name)) return null
    if (b.name === 'water') return { floorY: cell.y - k + 1, water: true }
    if (b.boundingBox === 'block') return k === 0 ? null : { floorY: cell.y - k + 1, fall: Math.max(0, tp.y - (cell.y - k + 1)) }
  }
  return null
}

// Выбор броска жемчуга на побег: 16 направлений × 4 наклона, для каждого —
// честная точка переноса (landing, с тем же смещением бросающего, что уйдёт в
// пакете), отбрасываем небезопасные, остальное оцениваем score(tp) -> число
// (больше — лучше). Возвращает pick для throwAt.
// maxDrop — насколько ниже своих ног можно оказаться: в бою на арене в небе
// жемчуг «подальше от него» улетал в дыру и переносил на землю в полусотне
// блоков внизу — вылет с ринга (прогон 2026-09-26).
function escapePick (bot, score, { minDist = 8, maxDrop = Infinity }: any = {}) {
  return (ctx) => {
    let best = null
    for (let i = 0; i < 16; i++) {
      const yaw = (i / 16) * Math.PI * 2
      for (const deg of [5, 15, 25, 35]) {
        const pitch = deg * DEG
        const land = ctx.landing(yaw, pitch)
        if (!land || land.void || !land.tp) continue
        const tp = land.tp
        if (Math.hypot(tp.x - ctx.from.x, tp.z - ctx.from.z) < minDist) continue
        const ground = safeLanding(bot, tp)
        if (!ground) continue
        if (bot.entity && bot.entity.position.y - ground.floorY > maxDrop) continue
        const sc = score(tp, land) - (ground.fall || 0) * 0.5
        if (!best || sc > best.sc) best = { yaw, pitch, sc, tp }
      }
    }
    return best ? { yaw: best.yaw, pitch: best.pitch, ticks: null, at: best.tp, sc: best.sc } : null
  }
}

module.exports = { KINDS, kindOf, launch, flight, solve, aim, landing, throwAt, safeLanding, escapePick, jumpLaunch, jumpRoom, jumpChoice, JUMP_VY, RUN_TICKS, RUN_H, RUN_AHEAD, RUNWAY }
