'use strict'
// Рефлекс уклонения от шаров ифрита (ND_BLZ_REFLEX=1, поток blaze 27.10). Старое уклонение ND_BLZ_DODGE (blaze-melee) меняло сторону
// на каждом срабатывании (out.dodgeSide = −dodgeSide), а тот же шар радар видел и на следующем обороте цикла — тело бежало назад,
// в линию огня; плюс шаг был лишь между ожиданиями цикла (еда, взгляд, путь — шар долетал, пока цикл занят).
// Здесь: каждый игровой тик (physicsTick) — модель полёта всех видимых шаров (AbstractHurtingProjectile 1.21.11: v0 0.1,
// v ← (v + 0.1)·0.95, без упреждения) против модели хода тела по 8 направлениям и «стоять»; выбирается ход с наибольшим
// зазором коробок (тело 0.6×1.8, шар 0.3125). Клавиши — относительно текущего взгляда (тело может смотреть на ифрита и бить,
// пока ноги уходят вбок), шаг — только туда, где пол без лавы/обрыва (canMove).

// Путь шара за n тиков от вылета (как radar.FB_PATH).
const FB_PATH = (() => { const out = [0]; let v = 0.1; let s = 0; for (let k = 1; k <= 120; k++) { v = (v + 0.1) * 0.95; s += v; out.push(s) } return out })()
// Попадание (ProjectileUtil.getHitResultOnMoveVector 1.21.11): луч из позиции шара на шаг против коробки тела 0.6×1.8, раздутой на
// margin = clamp((возраст − 2)/20, 0, 0.3) — с 8-го тика полёта полуширина 0.6.
const margin = (age: number) => Math.max(0, Math.min(0.3, (age - 2) / 20))
const HORIZON = 50 // тиков вперёд (шар с 48 бл. летит ~42 т)

export type Ball = { p0: { x: number, y: number, z: number }, dir: { x: number, y: number, z: number }, age: number }
export type Body = { x: number, y: number, z: number, vx: number, vz: number }

// Наземный ход: v ← 0.546·v + a·u (трение 0.6·0.91; ходьба ~0.216 бл/т, бег ×1.3).
function bodyPath (b: Body, ux: number, uz: number, a: number, n: number) {
  const out = []
  let x = b.x, z = b.z, vx = b.vx, vz = b.vz
  for (let k = 0; k <= n; k++) {
    out.push([x, z])
    vx = vx * 0.546 + a * ux; vz = vz * 0.546 + a * uz
    x += vx; z += vz
  }
  return out
}

// Наименьший зазор (бл.) между коробками тела и шара за горизонт при ходе по (ux, uz); Infinity — шар нас не задевает по высоте.
export function clearance (b: Body, balls: Ball[], ux: number, uz: number, a = 0.098) {
  const path = bodyPath(b, ux, uz, a, HORIZON)
  let worst = Infinity
  for (const ball of balls) {
    const age = Math.max(0, Math.floor(ball.age))
    // Шар за тик проходит отрезок до 1.9 бл. (сервер проверяет весь отрезок) — по 8 точек на тик, а не одна: точки тиков
    // перешагивали коробку тела, и зазор 0.3–0.6 «мимо» оказывался попаданием (rx9/rx10: прямая шара верна до 0.01 бл.).
    for (let k = 0; k < HORIZON; k++) {
      const s0 = FB_PATH[Math.min(FB_PATH.length - 1, age + k)], s1 = FB_PATH[Math.min(FB_PATH.length - 1, age + k + 1)]
      const m = margin(age + k)
      const [px, pz] = path[k]
      for (let j = 0; j < 8; j++) {
        const s = s0 + (s1 - s0) * j / 8
        const by = ball.p0.y + ball.dir.y * s
        if (by < b.y - m - 0.1 || by > b.y + 1.8 + m + 0.1) continue
        const bx = ball.p0.x + ball.dir.x * s, bz = ball.p0.z + ball.dir.z * s
        const c = Math.max(Math.abs(bx - px), Math.abs(bz - pz)) - 0.3 - m
        if (c < worst) worst = c
      }
    }
  }
  return worst
}

const DIRS = [[0, 0], [1, 0], [-1, 0], [0, 1], [0, -1], [0.7071, 0.7071], [0.7071, -0.7071], [-0.7071, 0.7071], [-0.7071, -0.7071]]
// Лучший ход: null — шаров нет или все проходят дальше watch от тела, стоящего на месте; иначе { ux, uz, clear } — ux = uz = 0:
// стоять (не идти дальше путём цикла: rx1-s15 — шар с 48.8 бл. «мимо на 1.1» попал, пока путь «к спавнеру» вёл тело в его линию).
// prev — ход прошлого тика: держать его, пока другой не лучше на 0.15 (rx8: план прыгал между сторонами каждый тик — скорость
// падала до 0, тело стояло под шаром). Стоять — только если стоя зазор ≥ 0.35 и не хуже хода: зазор < 0 у всех — всё равно идти
// лучшим ходом (модель неточна, стоя — попадание наверняка: rx8 «стою, зазор −0.08» ×6).
export function planDodge (b: Body, balls: Ball[], canMove: (ux: number, uz: number) => boolean, watch = 1.2, prev: [number, number] | null = null) {
  if (!balls.length) return null
  const still = clearance(b, balls, 0, 0)
  if (still >= watch) return null
  let best = { ux: 0, uz: 0, clear: still }, move = null
  for (const [ux, uz] of DIRS) {
    if (!ux && !uz) continue
    if (!canMove(ux, uz)) continue
    const c = clearance(b, balls, ux, uz) + (prev && Math.abs(prev[0] - ux) < 0.01 && Math.abs(prev[1] - uz) < 0.01 ? 0.15 : 0)
    if (!move || c > move.clear) move = { ux, uz, clear: c }
  }
  if (move && (move.clear > still + 0.05 || still < 0.35)) best = move
  return best
}

// Клавиши для хода по миру (ux, uz) при взгляде yaw (prismarine-physics: Y = π − yaw, вперёд (−sinY, cosY), вправо (−cosY, −sinY)).
export function keysFor (yaw: number, ux: number, uz: number) {
  const Y = Math.PI - yaw, s = Math.sin(Y), c = Math.cos(Y)
  const fwd = ux * -s + uz * c, right = ux * -c + uz * -s
  return { forward: fwd > 0.38, back: fwd < -0.38, right: right > 0.38, left: right < -0.38 }
}

// Рефлекс на теле: каждый тик — план по шарам радара (radar.flying), клавиши хода; active() — тело сейчас уклоняется (цикл боя
// не ходит и не ставит клавиши сам). stats — разбор: тиков уклонения, срабатываний, «некуда».
// opts.preempt — точка ифрита, который вот-вот даст очередь (заряд, окно залпа): шаров ещё нет, а ход уже поперёк его луча —
// шар метит в тело в миг выстрела, с 2–4 бл. он долетает за 5–8 т, и реакции на вылет мало (rx1-s16: попадания с 2–4 бл.).
// opts.near — ноги ифритов, чей удар вплотную близко (BlazeAttackGoal: d² < 4 по ногам и луч → удар 6 раз в 20 т и полёт к цели):
// шаров нет — шаг прочь, пока дальний не дальше SPACE (rx3: урон «меч» 12 из ~35 за сцену — ифриты вплотную, пока тело бьёт).
const SPACE = 2.7
export function attachReflex (bot: any, radar: any, canMove: (ux: number, uz: number) => boolean, opts: { onStart?: () => void, preempt?: () => any, near?: () => any[] } = {}) {
  const KEYS = ['forward', 'back', 'left', 'right'] as const
  const stats = { ticks: 0, starts: 0, stuck: 0, preTicks: 0, spaceTicks: 0 }
  let on = false, lastDir: [number, number] | null = null, side = 1
  const trace: any[] = []
  const r2 = (x: number) => Math.round(x * 100) / 100
  const release = () => { for (const k of KEYS) bot.setControlState(k, false); bot.setControlState('sprint', false) }
  const onTick = () => {
    let plan = null, balls: Ball[] = []
    try {
      const p = bot.entity.position, v = bot.entity.velocity
      balls = radar.flying()
      // Скорость тела из mineflayer — после трения (0.546): шаг следующего тика без клавиш — она же; модель ждёт шаг до трения.
      plan = balls.length ? planDodge({ x: p.x, y: p.y, z: p.z, vx: v.x / 0.546, vz: v.z / 0.546 }, balls, canMove, 1.2, lastDir) : null
      if (plan && plan.clear < 0) stats.stuck++
    } catch { plan = null }
    if ((!plan || !plan.ux && !plan.uz && plan.clear >= 0.35) && opts.preempt) {
      try {
        const t = opts.preempt(), p = bot.entity.position
        if (t) {
          const dx = t.x - p.x, dz = t.z - p.z, L = Math.hypot(dx, dz) || 1
          for (const sd of [side, -side]) {
            const ux = -dz / L * sd, uz = dx / L * sd
            if (canMove(ux, uz) && (!balls.length || clearance({ x: p.x, y: p.y, z: p.z, vx: bot.entity.velocity.x / 0.546, vz: bot.entity.velocity.z / 0.546 }, balls, ux, uz) >= 0.35)) { plan = { ux, uz, clear: 0 }; side = sd; stats.preTicks++; break }
          }
        }
      } catch { plan = null }
    }
    if ((!plan || !plan.ux && !plan.uz && plan.clear >= 0.35) && opts.near) {
      try {
        const p = bot.entity.position
        const close = opts.near().filter(q => q.distanceTo(p) < SPACE)
        if (close.length) {
          let ax = 0, az = 0
          for (const q of close) { const dx = p.x - q.x, dz = p.z - q.z, L = Math.hypot(dx, dz) || 1; ax += dx / L; az += dz / L }
          const L = Math.hypot(ax, az) || 1
          const away = [[ax / L, az / L], [(ax - az) / L * 0.7071, (az + ax) / L * 0.7071], [(ax + az) / L * 0.7071, (az - ax) / L * 0.7071], [-az / L, ax / L], [az / L, -ax / L]]
          for (const [ux, uz] of away) {
            if (canMove(ux, uz) && (!balls.length || clearance({ x: p.x, y: p.y, z: p.z, vx: bot.entity.velocity.x / 0.546, vz: bot.entity.velocity.z / 0.546 }, balls, ux, uz) >= 0.35)) { plan = { ux, uz, clear: 0 }; stats.spaceTicks++; break }
          }
        }
      } catch {}
    }
    if (!plan) {
      if (on) { on = false; lastDir = null; release() }
      return
    }
    if (!on) { on = true; stats.starts++; try { opts.onStart?.() } catch {} }
    stats.ticks++
    lastDir = [plan.ux, plan.uz]
    const p0 = bot.entity.position, v0 = bot.entity.velocity
    trace.push({ t: (trace.at(-1)?.t ?? 0) + 1, p: [r2(p0.x), r2(p0.y), r2(p0.z)], v: [r2(v0.x), r2(v0.z)], og: !!bot.entity.onGround, dir: [r2(plan.ux), r2(plan.uz)], clear: r2(plan.clear), n: balls.length,
      b: balls.slice(0, 4).map(b => [r2(b.p0.x), r2(b.p0.y), r2(b.p0.z), r2(b.age)]) })
    if (trace.length > 8) trace.shift()
    const k = keysFor(bot.entity.yaw, plan.ux, plan.uz)
    for (const key of KEYS) bot.setControlState(key, k[key])
    bot.setControlState('sprint', k.forward && !k.left && !k.right)
  }
  bot.on('physicsTick', onTick)
  // Разбор: урон, пока рефлекс ведёт ноги, — последние тики плана в лог (до 12 раз за бой).
  let hp = bot.health ?? 20, logged = 0
  const onHealth = () => {
    const h = bot.health ?? 20
    if (h < hp && on && logged++ < 12) console.log('[reflex]', JSON.stringify({ lost: r2(hp - h), trace }))
    hp = h
  }
  bot.on('health', onHealth)
  return {
    stats,
    active: () => on,
    // Клавиши заново по текущему взгляду (цикл повернул голову к цели удара — старые клавиши повели бы не туда).
    reapply () { if (on && lastDir) { const k = keysFor(bot.entity.yaw, lastDir[0], lastDir[1]); for (const key of KEYS) bot.setControlState(key, k[key]); bot.setControlState('sprint', k.forward && !k.left && !k.right) } },
    dir: () => lastDir,
    stop () { bot.removeListener('physicsTick', onTick); bot.removeListener('health', onHealth); if (on) release(); on = false }
  }
}
