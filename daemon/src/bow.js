'use strict'
// Лук. Один модуль и для боя (pvp.js), и для тира (try-bow.js), чтобы то,
// что проверено в тире, и было тем, что стреляет в бою.
//
// Физика стрелы — как в AbstractArrow.tick (Java 1.21): стрела появляется на
// высоте глаз − 0.1, скорость = направление × 3 × сила (сила 1 при полном
// натяжении, 20 тиков); каждый тик позиция += скорость, потом скорость ×= 0.99,
// потом y −= 0.05. Разброс лука ~1° (inaccuracy 1.0) — его не убрать, но всё
// остальное должно быть точным. Прошлый прицел перебирал угол шагом 1° (на 30
// блоках это полблока), упреждал по «дистанция / 3» и держал тетиву ровно 1.05 с —
// на лаге стрела уходила недотянутой и падала короче.

const Vec3 = require('vec3')
const { sleep } = require('./movement')

const SPEED = 3.0
const GRAVITY = 0.05
const DRAG = 0.99
const DRAW_MS = 1150

// Летит стрела под углом pitch (вверх +). Возвращает высоту (относительно
// точки вылета) на горизонтальном расстоянии dx и число тиков, или null.
function flight (pitch, dx, speed = SPEED, g = GRAVITY, drag = DRAG) {
  let x = 0; let y = 0
  let vx = Math.cos(pitch) * speed
  let vy = Math.sin(pitch) * speed
  for (let t = 1; t <= 200; t++) {
    const nx = x + vx
    const ny = y + vy
    if (nx >= dx) {
      // Точка на отрезке тика, где пересекли dx.
      const f = (dx - x) / (nx - x)
      return { y: y + (ny - y) * f, ticks: t - 1 + f }
    }
    x = nx; y = ny
    vx *= drag
    vy = vy * drag - g
    if (vx < 1e-3) return null
  }
  return null
}

// Угол, при котором стрела на дистанции dx окажется на высоте dy. Низкая
// траектория: между -45° и углом максимальной дальности высота на dx растёт
// монотонно, так что деление пополам сходится.
// Низ — до −80°: со столба (pvp perch) цель бывает круто под ногами, а при
// −45° решатель молча возвращал сам край и стрела уходила поверх головы.
const LOW = -80 * Math.PI / 180
// Крутой выстрел (steep): цель высоко над головой и близко — кристалл на
// обелиске в сорок блоков высотой с двадцати блоков по земле. Потолок 43°
// такой выстрел отвергал как «не долетит», хотя стрела долетает: высота на
// дистанции dx растёт с углом до своего пика и потом падает, так что верхняя
// граница поиска — это угол пика для этой dx, а не угол максимальной дальности.
// По умолчанию выключено: у всех прежних вызовов поведение прежнее.
const TOP = 1.45
function peakPitch (dx, speed = SPEED, g = GRAVITY) {
  let lo = Math.PI / 4.2
  let hi = TOP
  const at = p => { const f = flight(p, dx, speed, g); return f ? f.y : -Infinity }
  for (let i = 0; i < 50; i++) {
    const m1 = lo + (hi - lo) / 3
    const m2 = hi - (hi - lo) / 3
    if (at(m1) < at(m2)) lo = m1
    else hi = m2
  }
  return (lo + hi) / 2
}
// steep = 'lob' — навесом: ветка за пиком, где высота на dx с углом падает.
// Стрела приходит сверху — так бьют кристалл на высоком обелиске, чей край
// закрывает его от пологой стрелы с земли.
function solvePitch (dx, dy, speed = SPEED, g = GRAVITY, steep = false) {
  if (steep === 'lob') {
    const at = p => { const f = flight(p, dx, speed, g); return f ? f.y : -Infinity }
    let lo = peakPitch(dx, speed, g)
    let hi = TOP
    if (at(lo) < dy || at(hi) > dy) return null
    for (let i = 0; i < 40; i++) {
      const mid = (lo + hi) / 2
      if (at(mid) > dy) lo = mid
      else hi = mid
    }
    const pitch = (lo + hi) / 2
    const f = flight(pitch, dx, speed, g)
    return f ? { pitch, ticks: f.ticks } : null
  }
  let lo = LOW
  let hi = steep ? peakPitch(dx, speed, g) : Math.PI / 4.2
  const at = p => { const f = flight(p, dx, speed, g); return f ? f.y : -Infinity }
  if (at(hi) < dy) return null // не долетает
  if (at(lo) > dy) return null // круче, чем можно наклонить голову
  for (let i = 0; i < 40; i++) {
    const mid = (lo + hi) / 2
    if (at(mid) < dy) lo = mid
    else hi = mid
  }
  const pitch = (lo + hi) / 2
  const f = flight(pitch, dx, speed, g)
  return f ? { pitch, ticks: f.ticks } : null
}

// Прицел по движущейся цели: где она будет, когда долетит стрела. Итерируем
// время полёта — три прохода сходятся до долей тика.
// targetAt(ticks) -> Vec3 точки, куда целимся.
function aim (from, targetAt, speed = SPEED, g = GRAVITY, steep = false) {
  let ticks = from.distanceTo(targetAt(0)) / (speed * 0.95)
  let sol = null
  let P = null
  for (let i = 0; i < 4; i++) {
    P = targetAt(ticks)
    const dx = Math.hypot(P.x - from.x, P.z - from.z)
    sol = solvePitch(dx, P.y - from.y, speed, g, steep)
    if (!sol) return null
    ticks = sol.ticks
  }
  return {
    yaw: Math.atan2(-(P.x - from.x), -(P.z - from.z)),
    pitch: sol.pitch,
    ticks: Math.round(sol.ticks * 10) / 10,
    at: P
  }
}

// Прицел на ходу. Сервер прибавляет к стреле скорость стрелка (u, блоки за
// тик; вертикальную — только в воздухе). Значит, направление выстрела d надо
// выбрать так, чтобы 3·d + u летело в цель. По горизонтали это решается
// точно: поперечную цели часть u гасим поворотом (d⊥ = −u⊥/h, h — горизонтальная
// скорость стрелы), продольная просто прибавляется к скорости. По вертикали —
// тот же перебор угла, но с этими скоростями.
function flightV (vh, vy, dx, g = GRAVITY, drag = DRAG) {
  let x = 0; let y = 0
  for (let t = 1; t <= 200; t++) {
    const nx = x + vh
    const ny = y + vy
    if (nx >= dx) {
      const f = (dx - x) / (nx - x)
      return { y: y + (ny - y) * f, ticks: t - 1 + f }
    }
    x = nx; y = ny
    vh *= drag
    vy = vy * drag - g
    if (vh < 1e-3) return null
  }
  return null
}

function aimMoving (from, targetAt, u, airborne = false, speed = SPEED, g = GRAVITY, steep = false) {
  const still = aim(from, targetAt, speed, g, steep)
  if (!still) return null
  if (steep === 'lob') return still
  const uy = airborne ? u.y : 0
  let ticks = still.ticks
  let out = null
  for (let iter = 0; iter < 4; iter++) {
    const P = targetAt(ticks)
    const tx = P.x - from.x
    const tz = P.z - from.z
    const dx = Math.hypot(tx, tz)
    if (dx < 0.5) return still
    const T = { x: tx / dx, z: tz / dx }
    const N = { x: -T.z, z: T.x } // поперёк цели
    const uPar = u.x * T.x + u.z * T.z
    const uPerp = u.x * N.x + u.z * N.z
    // Угол вверх p: горизонтальная скорость стрелы h = speed·cos p.
    const at = (p) => {
      const h = speed * Math.cos(p)
      const s = -uPerp / h
      if (Math.abs(s) >= 1) return null
      const vh = h * Math.sqrt(1 - s * s) + uPar
      if (vh <= 0.05) return null
      const f = flightV(vh, speed * Math.sin(p) + uy, dx, g)
      return f ? { ...f, s } : null
    }
    let lo = LOW
    let hi = steep ? peakPitch(dx, speed, g) : Math.PI / 4.2
    const top = at(hi)
    if (!top || top.y < P.y - from.y) return still
    for (let i = 0; i < 40; i++) {
      const mid = (lo + hi) / 2
      const r = at(mid)
      if (!r || r.y < P.y - from.y) lo = mid
      else hi = mid
    }
    const p = (lo + hi) / 2
    const r = at(p)
    if (!r) return still
    // Направление взгляда: вдоль цели с поправкой поперёк на s.
    const a = Math.sqrt(1 - r.s * r.s)
    const dir = { x: T.x * a + N.x * r.s, z: T.z * a + N.z * r.s }
    out = { yaw: Math.atan2(-dir.x, -dir.z), pitch: p, ticks: Math.round(r.ticks * 10) / 10, at: P, comp: true }
    ticks = r.ticks
  }
  return out || still
}

// Свободна ли траектория: стрела по тикам (та же физика), каждый отрезок —
// лучом по блокам. Живой прогон: бот вышел из арены через пробитую дыру и
// стрелял в стеклянную стену, потому что целился только по цели, не по пути.
// Возвращает null — путь чист, или точку, где стрела упрётся.
function blockedAt (bot, from, sol, u = { x: 0, y: 0, z: 0 }, speed = SPEED) {
  const dir = { x: -Math.sin(sol.yaw) * Math.cos(sol.pitch), y: Math.sin(sol.pitch), z: -Math.cos(sol.yaw) * Math.cos(sol.pitch) }
  let p = from.clone()
  let v = { x: dir.x * speed + u.x, y: dir.y * speed, z: dir.z * speed + u.z }
  const ticks = Math.ceil(sol.ticks || 20)
  for (let t = 0; t < ticks; t++) {
    const step = new Vec3(v.x, v.y, v.z)
    const len = step.norm()
    if (len < 1e-3) break
    // Последний отрезок — до самой цели, не дальше: цель стоит в своём блоке.
    // Цель на дробном тике (ticks 3.4) — от последнего шага нужна только доля
    // (0.4): полный шаг минус 0.8 пролетал цель и упирался в стену за ней
    // (лаборатория 2026-09-27: блейз у стены — «на линии стрельбы блок» 40 раз).
    const frac = (sol.ticks || 0) - Math.floor(sol.ticks || 0)
    const reach = t === ticks - 1 ? Math.max(0, (frac > 0.05 ? len * frac : len) - 0.8) : len
    try {
      // Направление — копией: Vec3.normalize() меняет сам вектор (vec3), и
      // раньше step после проверки становился единичным — стрела в симуляции
      // шла блок за тик вместо трёх, и проверялась лишь первая треть пути.
      const hit = bot.world.raycast(p, step.scaled(1 / len), reach, b => b && b.boundingBox === 'block')
      if (hit) return hit.position
    } catch { return null }
    p = p.plus(step)
    v = { x: v.x * DRAG, y: v.y * DRAG - GRAVITY, z: v.z * DRAG }
  }
  return null
}

// Цель с упреждением: скорость по двум последним позициям. Высота точки —
// середина туловища (0.55 роста): туда стрела ложится при любой ошибке по
// высоте в пределах полблока.
function leadTarget (entity, velFn) {
  return (ticks) => {
    const v = velFn ? velFn() : { x: 0, y: 0, z: 0 }
    const p = entity.position
    // Вертикальная скорость на земле — это прыжки и шум, её не экстраполируем.
    const vy = entity.onGround === false ? v.y : 0
    return new Vec3(p.x + v.x * ticks, p.y + vy * ticks + (entity.height || 1.8) * 0.55, p.z + v.z * ticks)
  }
}

// Выстрел. Натягивает DRAW_MS, всё это время ведя прицел; перед спуском —
// последний пересчёт. onDraw(tick) — чем занять ноги (стрейф). Возвращает
// прицел и, если follow, — чем кончилась стрела (hit / промах в блоках).
// Сервер 1.21 прибавляет к стреле скорость стрелка (shootFromRotation:
// getKnownMovement — то, что клиент сообщил о своём движении). Стрейф во время
// натяжения уводил стрелу вбок: в бою по зомби бот мазал через раз, хотя в
// тире стоя попадал всегда. Поэтому последние SETTLE_MS перед спуском тело
// стоит (onSettle), и скорость успевает погаснуть: трение на земле ×0.546 за тик.
const SETTLE_MS = 250

// mode: 'compensate' (по умолчанию) — не останавливаться, а учесть свою
// скорость в прицеле (aimMoving): стрейф идёт до самого спуска, и попасть в
// такого стрелка труднее; 'settle' — замереть перед спуском; 'raw' — ни то ни
// другое (для сравнения в тире).
// point(ticks) -> Vec3 — своя точка прицела вместо середины туловища (у
// дракона бьётся не сущность, а её части: голова, тело, крылья — dragon.js);
// steep — разрешить крутой выстрел вверх (см. peakPitch).
async function shoot (bot, entity, { velFn = null, onDraw = null, onSettle = null, onRelease = null, onHit = null, shouldStop = null, follow = true, mode = 'compensate', point = null, steep = false, drawMs = DRAW_MS, holdWhile = null, holdMaxMs = 2500 } = {}) {
  const bow = bot.inventory.items().find(i => i.name === 'bow')
  const arrows = bot.inventory.items().find(i => /arrow$/.test(i.name))
  if (!bow || !arrows) return { shot: false, why: !bow ? 'лука нет' : 'стрел нет' }
  // Отменить натяжение без выстрела (ревью Codex 2026-09-30): deactivateItem —
  // это «отпустить кнопку», сервер на нём и стреляет (BowItem.releaseUsing) —
  // «отменил натяжение» выпускал стрелу. Смена слота снимает использование
  // предмета без releaseUsing (как при закрытом пути ниже).
  const cancelDraw = () => { try { bot.setQuickBarSlot((bot.quickBarSlot + 1) % 9) } catch {} /* не deactivateItem: это спуск тетивы */ }

  // Короткое натяжение (стрела вреда, ranged.harmDrawMs, 2026-09-26): сила лука
  // (f² + 2f)/3 при f = тики/20 (BowItem.getPowerForTime), скорость стрелы 3 × сила.
  // Тиков у сервера — на один меньше, чем прошло: пакет начала и пакет спуска
  // сами съедают по полтика (оценка; ошибка в тик — ±15% скорости).
  const short = drawMs < DRAW_MS
  const drawTicks = Math.max(2, Math.round(drawMs / 50) - 1)
  const speed = short ? SPEED * Math.min(1, ((drawTicks / 20) ** 2 + 2 * drawTicks / 20) / 3) : SPEED
  const target = point || leadTarget(entity, velFn)
  const eye = () => bot.entity.position.offset(0, 1.62 - 0.1, 0)
  // Путь закрыт ещё до натяжения — не тратить секунду: вызывающий должен
  // сменить позицию (или идти в ближний бой).
  const pre = aim(eye(), target, speed, GRAVITY, steep)
  if (!pre) return { shot: false, why: 'не долетит' }
  const wall = blockedAt(bot, eye(), pre, undefined, speed)
  if (wall) return { shot: false, blocked: true, why: `на линии стрельбы блок ${wall.x},${wall.y},${wall.z}` }
  if (!bot.heldItem || bot.heldItem.name !== 'bow') await bot.equip(bow, 'hand')
  let sol = null
  bot.activateItem()
  const t0 = Date.now()
  // Что сервер прибавит к стреле — это смещение стрелка за последний тик
  // (замер /data get entity Motion: лишняя скорость стрелы ≈ 2 × velocity
  // mineflayer). velocity в mineflayer — уже после трения за тик (×0.546 на
  // земле), а смещение — до него. Поэтому меряем само смещение.
  let lastPos = bot.entity.position.clone()
  let moved = { x: 0, y: 0, z: 0 }
  const onTick = () => {
    const p = bot.entity.position
    moved = { x: p.x - lastPos.x, y: p.y - lastPos.y, z: p.z - lastPos.z }
    lastPos = p.clone()
  }
  bot.on('physicsTick', onTick)
  const stopTick = () => bot.removeListener('physicsTick', onTick)
  const myVel = () => moved
  const solve = () => mode === 'compensate'
    ? aimMoving(eye(), target, myVel(), !bot.entity.onGround, speed, GRAVITY, steep)
    : aim(eye(), target, speed, GRAVITY, steep)
  let settled = false
  while (Date.now() - t0 < drawMs) {
    if (shouldStop && shouldStop()) { stopTick(); cancelDraw(); return { shot: false, why: 'отменил натяжение' } }
    sol = solve()
    if (sol) await bot.look(sol.yaw, sol.pitch, true).catch(() => {})
    if (mode !== 'settle' || Date.now() - t0 < drawMs - SETTLE_MS) {
      if (onDraw) onDraw(Date.now() - t0)
    } else if (!settled) {
      settled = true
      for (const k of ['forward', 'back', 'left', 'right', 'jump', 'sprint']) { try { bot.setControlState(k, false) } catch {} }
      if (onSettle) onSettle()
    }
    await sleep(50)
  }
  // Держать натянутым, пока holdWhile() — его щит поднят к нам, и стрела в щит
  // пропала бы (LivingEntity.applyItemBlocking). Сила уже полная и не растёт
  // (BowItem.getPowerForTime ≤ 1): выстрел в тот тик, когда он опустит щит —
  // а щит он опустит, чтобы ударить. Короткое натяжение (вред) не держим: сила
  // выросла бы. Не дольше holdMaxMs (2026-09-26).
  if (holdWhile && !short) {
    const until = Date.now() + holdMaxMs
    while (Date.now() < until && holdWhile()) {
      if (shouldStop && shouldStop()) { stopTick(); cancelDraw(); return { shot: false, why: 'отменил натяжение' } }
      sol = solve()
      if (sol) await bot.look(sol.yaw, sol.pitch, true).catch(() => {})
      if (onDraw) onDraw(Date.now() - t0)
      await sleep(50)
    }
  }
  if (mode === 'settle') {
    // Ещё скользим — дождаться, пока гаснет, но не дольше 150 мс.
    const still = Date.now() + 150
    while (Date.now() < still && bot.entity.velocity && Math.hypot(bot.entity.velocity.x, bot.entity.velocity.z) > 0.02) await sleep(25)
  }
  if (mode === 'snap' || mode === 'snap2') {
    // Эксперимент: клавиши отпустить в момент спуска (snap) или за тик (snap2).
    for (const k of ['forward', 'back', 'left', 'right', 'jump', 'sprint']) { try { bot.setControlState(k, false) } catch {} }
    if (mode === 'snap2') await sleep(60)
  }
  // Спуск. Сервер берёт для стрелы взгляд, позицию и «известное смещение» из
  // последнего пакета движения (ServerGamePacketListenerImpl.handleMovePlayer →
  // setKnownMovement; Projectile.shootFromRotation, декомпиляция 1.21.11), а
  // mineflayer шлёт этот пакет в конце тика физики, сразу после события
  // physicsTick. Раньше тетива отпускалась до пакета — сервер стрелял по взгляду
  // прошлого тика. Теперь финальный прицел считается внутри physicsTick (позиция
  // этого тика уже посчитана, moved — ровно то смещение, что уйдёт в пакете),
  // взгляд ставится туда же, а тетива отпускается следующей задачей, после пакета.
  const fin = await new Promise(resolve => {
    let done = false
    const onT = () => {
      if (done) return
      done = true
      bot.removeListener('physicsTick', onT)
      const s = solve()
      const shut = s ? blockedAt(bot, eye(), s, mode === 'compensate' ? myVel() : undefined, speed) : null
      if (s && !shut) bot.look(s.yaw, s.pitch, true).catch(() => {})
      setImmediate(() => resolve({ s, shut }))
    }
    bot.on('physicsTick', onT)
    // Физика стоит (чанк не прогружен) — по-старому, без привязки к тику.
    setTimeout(() => { if (!done) { done = true; bot.removeListener('physicsTick', onT); resolve(null) } }, 300)
  })
  sol = fin ? fin.s : solve()
  // Путь закрылся за время натяжения (сдвинулись за угол, цель ушла за
  // стену) — не спускать тетиву: смена слота отменяет натяжение без выстрела.
  const shut = fin ? fin.shut : (sol ? blockedAt(bot, eye(), sol, mode === 'compensate' ? myVel() : undefined, speed) : null)
  if (!sol || shut) {
    stopTick()
    try { bot.setQuickBarSlot((bot.quickBarSlot + 1) % 9) } catch {} /* не deactivateItem: это спуск тетивы */
    return { shot: false, blocked: !!shut, why: shut ? `на линии стрельбы блок ${shut.x},${shut.y},${shut.z}` : 'не долетит' }
  }
  if (!fin) await bot.look(sol.yaw, sol.pitch, true).catch(() => {})

  // Ловим свою стрелу: появится у глаз в ближайшие тики.
  let arrow = null
  const me = bot.entity.position.clone()
  const onSpawn = (e) => {
    if (!arrow && e && /arrow$/.test(e.name) && e.position && e.position.distanceTo(me) < 3) arrow = e
  }
  bot.on('entitySpawn', onSpawn)
  // Настоящая начальная скорость стрелы — из пакета появления: позиции летящей
  // стрелы mineflayer почти не обновляет, по ним ничего не измерить.
  // Только для разбора (follow): в бою без него каждый выстрел оставлял
  // слушателя висеть — MaxListenersExceededWarning после десятка стрел.
  let spawnPkt = null
  const onRaw = (pkt) => {
    if (spawnPkt || !pkt) return
    const px = pkt.x; const pz = pkt.z
    if (typeof px !== 'number' || Math.hypot(px - me.x, pz - me.z) > 3) return
    spawnPkt = pkt
  }
  if (follow) { try { bot._client.on('spawn_entity', onRaw) } catch {} }
  let hit = false
  // Урон цели в ближайшие ~2 с после спуска — наша стрела (ближний бой в это
  // время не идёт: стреляем с дистанции).
  const onHurt = (victim) => {
    if (victim !== entity || hit) return
    hit = true
    if (onHit) { try { onHit() } catch {} }
  }
  bot.on('entityHurt', onHurt)
  // Последняя проверка «стоп» перед самим спуском: за финальный тик физики всё
  // могло измениться (ревью Codex: опасность=true, а стрела ушла).
  if (shouldStop && shouldStop()) { stopTick(); bot.removeListener('entitySpawn', onSpawn); bot.removeListener('entityHurt', onHurt); if (follow) { try { bot._client.removeListener('spawn_entity', onRaw) } catch {} } cancelDraw(); return { shot: false, why: 'отменил натяжение' } }
  if (onRelease) { try { onRelease(moved) } catch {} }
  stopTick()
  bot.deactivateItem()

  const out = {
    shot: true,
    dist: Math.round(me.distanceTo(entity.position) * 10) / 10,
    pitchDeg: Math.round(sol.pitch * 1800 / Math.PI) / 10,
    flightTicks: sol.ticks,
    speed: short ? Math.round(speed * 100) / 100 : undefined
  }
  if (!follow) {
    // Стрела на 40 блоков летит ~20 тиков: 2.5 с хватает.
    setTimeout(() => { bot.removeListener('entitySpawn', onSpawn); bot.removeListener('entityHurt', onHurt) }, Math.min(3000, sol.ticks * 50 + 1000))
    return out
  }
  // Диагностика: куда реально полетела стрела в первые тики против того, куда
  // целились. Отличает «прицел неверный» от «сервер добавил чужую скорость».
  const firstPos = []
  // Следим за стрелой: попала, или где ближе всего прошла мимо цели.
  let closest = Infinity
  const deadline = Date.now() + Math.max(1500, sol.ticks * 50 + 1200)
  while (Date.now() < deadline && !hit) {
    if (arrow && arrow.position && entity.position) {
      if (firstPos.length < 3) firstPos.push({ p: arrow.position.clone(), t: Date.now() })
      const c = point ? point(0) : entity.position.offset(0, (entity.height || 1.8) / 2, 0)
      const dd = arrow.position.distanceTo(c)
      if (dd < closest) closest = dd
      if (arrow.isValid === false) break
    }
    await sleep(50)
  }
  try { bot._client.removeListener('spawn_entity', onRaw) } catch {}
  if (spawnPkt) {
    // Скорость в пакете: старые версии — velocityX/Y/Z в 1/8000 блока за тик,
    // 1.21.9+ — вектор velocity. Берём, что есть.
    let v = null
    const pv = spawnPkt.velocity
    if (pv && typeof pv.x === 'number') v = { x: pv.x, y: pv.y, z: pv.z }
    else if (typeof spawnPkt.velocityX === 'number') v = { x: spawnPkt.velocityX / 8000, y: spawnPkt.velocityY / 8000, z: spawnPkt.velocityZ / 8000 }
    out.diag = {
      wantYaw: Math.round(sol.yaw * 180 / Math.PI),
      wantPitch: Math.round(sol.pitch * 180 / Math.PI),
      flewYaw: v ? Math.round(Math.atan2(-v.x, -v.z) * 180 / Math.PI) : null,
      flewPitch: v ? Math.round(Math.atan2(v.y, Math.hypot(v.x, v.z)) * 180 / Math.PI) : null,
      speed: v ? Math.round(Math.hypot(v.x, v.y, v.z) * 100) / 100 : null,
      mySpeed: bot.entity.velocity ? Math.round(Math.hypot(bot.entity.velocity.x, bot.entity.velocity.z) * 100) / 100 : null,
      raw: v ? undefined : Object.keys(spawnPkt).join(',')
    }
  } else if (follow) {
    out.diag = { note: 'пакета появления стрелы не поймал' }
  }
  bot.removeListener('entitySpawn', onSpawn)
  bot.removeListener('entityHurt', onHurt)
  out.hit = hit
  if (!hit && closest < Infinity) out.missBy = Math.round(closest * 10) / 10
  if (!arrow) out.note = 'свою стрелу не увидел'
  return out
}

module.exports = { shoot, aim, aimMoving, solvePitch, peakPitch, flight, leadTarget, blockedAt, DRAW_MS, SPEED, GRAVITY }
