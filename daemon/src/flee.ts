'use strict'
const gameClock = require('./game-clock')
// Побег от мобов, который смотрит на ВСЕХ, кто рядом, а не на одного.
//
// Старый отход (combat.retreat) считал направление «прочь от этого моба» и
// шёл туда pathfinder'ом без спринта. В живой игре это кончалось одинаково:
// прочь от зомби — значит прямо в скелета за спиной, и зомби, который быстрее
// идущего бота, догонял на полпути. Здесь:
//
//   * у каждого моба своя опасность и свой радиус (DOCTRINE), крипер, который
//     шипит, важнее всех остальных вместе;
//   * куда бежать — выбирается из 24 направлений по сумме опасностей в точке
//     прибытия, по тому, как близко путь проходит мимо каждого моба, и по тому,
//     видят ли нас там стрелки; рельеф проверяется по пути (обрыв, лава, стена);
//   * бежит клавишами и спринтом, пересчитывая направление каждые 300 мс, а не
//     один раз в начале;
//   * от стрел и огненных шаров шагает в сторону (threats.js).
//
// Спринт в pathfinder выключен из-за расхождения физики (session.js), но это
// про длинные маршруты; короткий рывок клавишами сервер принимает.

const Vec3 = require('vec3')
const { sleep, xyz, inWater } = require('./movement')
const { raySees } = require('./perception')
const threats = require('./threats')
const throwMod = require('./throw')
const { stepSafe, keyDir } = require('./moves')

// Доктрина по мобам. radius — докуда моб опасен в ближнем бою (с запасом на
// его скорость), weight — насколько. range — дальность стрельбы (опасен, только
// если видит). blast — радиус взрыва. fast — бегом не оторваться. fight —
// что делать, если прижали (для мозга и для боя).
const DOCTRINE = {
  zombie: { radius: 8, weight: 6, fight: 'бить, отходить в перезарядке' },
  zombie_villager: { radius: 8, weight: 6 },
  husk: { radius: 8, weight: 6 },
  drowned: { radius: 8, weight: 6, range: 14 },
  // Дальности стрелков — по jar 1.21.11 (javap, S4c 07.10): лук скелетов RangedBowAttackGoal(…, 15.0F) — стреляет до 15 при
  // видимости; арбалет разбойника заряжен и стреляет при видимости в пределах FOLLOW_RANGE 32 (RangedCrossbowAttackGoal: 8 —
  // только дистанция подхода); ифрит — BlazeAttackGoal: dist² < FOLLOW_RANGE² (48) и видимость; гаст — GhastShootFireballGoal
  // 4096 = 64²; шалкер — ShulkerAttackGoal 400 = 20². Раньше 20/40 у ифрита/гаста: бег «оторвался» под огнём с 48 бл.
  skeleton: { radius: 5, weight: 4, range: 15, fight: 'сближаться зигзагом или уйти за угол' },
  stray: { radius: 5, weight: 4, range: 15 },
  bogged: { radius: 5, weight: 4, range: 15 },
  // Скелет пустыни 1.21.11 (стрелы замедления); trap3 02.10: «arrow parched» — раньше его не видел ни отход, ни бег.
  parched: { radius: 5, weight: 4, range: 15 },
  pillager: { radius: 5, weight: 5, range: 32 },
  witch: { radius: 5, weight: 5, range: 8, fight: 'рывком, пока пьёт' },
  creeper: { radius: 7, weight: 9, blast: 7, fight: 'спринт-удар и отход, не стоять рядом' },
  spider: { radius: 9, weight: 5, fast: true, fight: 'не убежать — драться' },
  cave_spider: { radius: 8, weight: 6, fast: true },
  enderman: { radius: 8, weight: 8, fast: true, fight: 'не смотреть в глаза; драться под низким потолком' },
  silverfish: { radius: 4, weight: 2 },
  endermite: { radius: 4, weight: 2 },
  slime: { radius: 5, weight: 3 },
  magma_cube: { radius: 5, weight: 4 },
  blaze: { radius: 6, weight: 6, range: 48 },
  ghast: { radius: 0, weight: 5, range: 64 },
  phantom: { radius: 10, weight: 5, fast: true },
  vindicator: { radius: 9, weight: 9 },
  evoker: { radius: 10, weight: 8, range: 12 },
  vex: { radius: 8, weight: 6, fast: true },
  ravager: { radius: 10, weight: 10 },
  piglin_brute: { radius: 9, weight: 9 },
  hoglin: { radius: 9, weight: 8 },
  zoglin: { radius: 9, weight: 8 },
  wither_skeleton: { radius: 8, weight: 8 },
  guardian: { radius: 0, weight: 5, range: 15 },
  elder_guardian: { radius: 0, weight: 7, range: 15 },
  warden: { radius: 20, weight: 20, fast: true, fight: 'никогда' },
  breeze: { radius: 6, weight: 5, range: 16 },
  creaking: { radius: 6, weight: 5 },
  shulker: { radius: 0, weight: 4, range: 20 },
  piglin: { radius: 7, weight: 5, range: 12 },
  // Белый медведь (с медвежатами нападает сам): PolarBear.createAttributes 1.21.11 (константы класса) — MAX_HEALTH 30,
  // ATTACK_DAMAGE 6, MOVEMENT_SPEED 0.25 (как у зомби), FOLLOW_RANGE 20. ow-E2 02.10 слот 14: DEATH_LOOP у спавна —
  // 4 смерти от медведя, отход его не видел («бьёт невидимый»). Не драться — уходить; в бой (combat.HOSTILES) не берём,
  // чтобы не задирать мирного.
  polar_bear: { radius: 8, weight: 8, fight: 'не драться: 30 хп, бьёт 6 — уйти' }
}

// Напавший игрок (id передаёт тактика): бегает как мы, бьёт с 3 бл. и с разгона; с луком/арбалетом/трезубцем — ещё и стрелок.
// ponytail: дальность 48 — оценка (как ифрит), у человека-лучника нет константы в jar; без неё бег от игрока «отрывался»
// за тик (smartFlee его не видел: слот 27, 18 качелей CreateDistance↔Flee).
function playerDoctrine (e) {
  const held = e.heldItem?.name || ''
  return { radius: 10, weight: 8, fast: true, ...(/(^|_)bow$|crossbow|trident/.test(held) ? { range: 48 } : {}) }
}

// Взвешенные враги вокруг: только те, о ком есть доктрина, и напавшие игроки из foes (id сущностей).
function hostilesAround (bot, radius = 32, foes: number[] = []) {
  const me = bot.entity.position
  const out = []
  for (const e of ((Object.values(bot.entities) as any[]) as any)) {
    if (!e || e === bot.entity || !e.position || !e.name) continue
    const doc = e.username ? (foes.includes(e.id) ? playerDoctrine(e) : null) : DOCTRINE[e.name]
    if (!doc) continue
    const d = e.position.distanceTo(me)
    if (d > radius) continue
    out.push({ e, doc, d, swelling: e.name === 'creeper' && creeperSwelling(bot, e) })
  }
  return out.sort((a, b) => a.d - b.d)
}

// Крипер шипит: metadata swell_dir = 1. Индекс читается из реестра.
function creeperSwelling (bot, e) {
  try {
    const keys = bot.registry.entitiesByName.creeper.metadataKeys
    const i = keys.indexOf('swell_dir')
    return e.metadata[i >= 0 ? i : 16] === 1
  } catch { return false }
}

// Опасность точки P от одного моба.
function dangerAt (bot, P, h) {
  const { e, doc } = h
  const d = P.distanceTo(e.position)
  let v = 0
  if (doc.radius && d < doc.radius) v += doc.weight * Math.pow((doc.radius - d) / doc.radius, 2) * 10
  if (doc.blast && d < doc.blast) v += (h.swelling ? 60 : 12) * (doc.blast - d) / doc.blast
  if (doc.range && d < doc.range) {
    // Стрелок опасен, только если из точки видно его глаза.
    const eye = P.offset(0, 1.62, 0)
    const his = e.position.offset(0, (e.height || 1.8) * 0.9, 0)
    if (raySees(bot, eye, his)) v += doc.weight * (1 - d / doc.range) * 4
  }
  return v
}

// Ближайшее расстояние от отрезка A→B до точки M (в плоскости).
function segDist (A, B, M) {
  const ax = B.x - A.x; const az = B.z - A.z
  const len2 = ax * ax + az * az
  let t = len2 ? ((M.x - A.x) * ax + (M.z - A.z) * az) / len2 : 0
  t = Math.max(0, Math.min(1, t))
  return Math.hypot(A.x + ax * t - M.x, A.z + az * t - M.z)
}

const HURTS = new Set(['lava', 'fire', 'soul_fire', 'magma_block', 'cactus', 'sweet_berry_bush', 'campfire', 'soul_campfire', 'powder_snow', 'wither_rose'])

// Сколько блоков можно пробежать по направлению без обрыва (>3), лавы и
// стены выше прыжка. Возвращает длину и точку прибытия.
function runLength (bot, dir, max = 10) {
  const me = bot.entity.position
  let y = Math.floor(me.y)
  let last = me.clone()
  let len = 0
  let wet = 0
  for (let s = 1; s <= max; s++) {
    const x = Math.floor(me.x + dir.x * s)
    const z = Math.floor(me.z + dir.z * s)
    let found = null
    for (const dy of [0, 1, -1, -2, -3]) {
      const yy = y + dy
      const feet = bot.blockAt(new Vec3(x, yy, z))
      const head = bot.blockAt(new Vec3(x, yy + 1, z))
      const ground = bot.blockAt(new Vec3(x, yy - 1, z))
      if (!feet || !head || !ground) continue
      if (HURTS.has(feet.name) || HURTS.has(ground.name) || HURTS.has(head.name)) { found = 'bad'; break }
      const open = b => b.boundingBox === 'empty' && b.name !== 'cobweb'
      if (open(feet) && open(head) && (ground.boundingBox === 'block' || ground.name === 'water')) {
        // Подъём на блок — только если над головой при прыжке свободно.
        if (dy === 1) {
          const over = bot.blockAt(new Vec3(Math.floor(last.x), y + 2, Math.floor(last.z)))
          if (over && over.boundingBox === 'block') continue
        }
        found = yy
        break
      }
    }
    if (found === null || found === 'bad') break
    y = found
    last = new Vec3(x + 0.5, y, z + 0.5)
    len = s
    const wf = bot.blockAt(new Vec3(x, y, z))
    const wg = bot.blockAt(new Vec3(x, y - 1, z))
    if ((wf && wf.name === 'water') || (wg && wg.name === 'water')) wet++
  }
  return { len, end: last, wet }
}

// Обрыв у точки прибытия: клетки в 1–2 бл. от неё без пола на 4 вниз (или с лавой/огнём). Бег кончается там, где его
// догоняют, а удар отбрасывает на 1–2 бл.: от иссушителя на платформе бег «до 17 бл.» упирался в край, и удар сбрасывал
// тело (S4c 07.10, нативный A/B s4c-ab: 4 смерти «fell from a high place / doomed to fall» в фазе wither-skeleton из 8).
const EDGE_RING = [[1, 0], [-1, 0], [0, 1], [0, -1], [2, 0], [-2, 0], [0, 2], [0, -2], [1, 1], [1, -1], [-1, 1], [-1, -1]]
function edgeRisk (bot, E) {
  const x0 = Math.floor(E.x); const y0 = Math.floor(E.y); const z0 = Math.floor(E.z)
  let risk = 0
  for (const [dx, dz] of EDGE_RING) {
    let floor = false
    for (let dy = 1; dy <= 4 && !floor; dy++) {
      const b = bot.blockAt(new Vec3(x0 + dx, y0 - dy, z0 + dz))
      if (!b) { floor = true; break } // незагруженное — не повод бояться
      if (HURTS.has(b.name)) break
      floor = b.boundingBox === 'block' || b.name === 'water'
    }
    if (!floor) risk += Math.abs(dx) + Math.abs(dz) === 1 ? 2 : 1
  }
  return risk
}

// Лучшее направление бегства сейчас. prevYaw — чтобы не дёргаться между
// почти равными вариантами.
function pickDirection (bot, hs, prevYaw = null) {
  const me = bot.entity.position
  let best = null
  const options = []
  const wetStart = inWater(bot)
  for (let k = 0; k < 24; k++) {
    const yaw = (k / 24) * Math.PI * 2
    const dir = { x: -Math.sin(yaw), z: -Math.cos(yaw) }
    const run = runLength(bot, dir, 10)
    if (run.len < 2) continue
    const E = run.end
    let cost = 0
    for (const h of hs) {
      cost += dangerAt(bot, E, h)
      // Пробегать мимо моба ближе его досягаемости — хуже, чем стоять.
      const pass = segDist(me, E, h.e.position)
      if (h.doc.radius && pass < 3) cost += h.doc.weight * (3 - pass) * 6
      if (h.doc.blast && pass < h.doc.blast) cost += (h.swelling ? 40 : 8) * (h.doc.blast - pass) / h.doc.blast
    }
    // Короткий пробег — это тупик впереди.
    cost += (10 - run.len) * 1.5
    // Бег в воду — с суши: в воде тело ~2 бл/с (втрое медленнее спринта), там утопленники, нора и коробка не
    // строятся (trap0 02.10, ночь: отход убежал в озеро, «IN_WATER», утопленник добил). Уже в воде — не штраф.
    if (run.wet && !wetStart) cost += run.wet * 2.5
    if (prevYaw !== null) {
      let dy = Math.abs(yaw - prevYaw) % (Math.PI * 2)
      if (dy > Math.PI) dy = Math.PI * 2 - dy
      cost += dy * 2
    }
    options.push({ yaw, dir, cost, run: run.len, end: E })
  }
  // Край — только у лучших пяти (12 клеток × до 4 blockAt на каждое; на 750 TPS план раз в 300 игровых мс).
  options.sort((a, b) => a.cost - b.cost)
  for (const o of options.slice(0, 5)) o.cost += edgeRisk(bot, o.end) * 3
  for (const o of options.slice(0, 5)) if (!best || o.cost < best.cost) best = o
  return best
}

// Оторвались: ходячие дальше safeDist, а стрелки дальше дальности своего оружия или не видят глаз.
function shaken (bot, hs, safeDist) {
  const eye = bot.entity.position.offset(0, 1.62, 0)
  return !hs.some(h => h.doc.radius && h.d < safeDist ||
    h.doc.range && h.d < h.doc.range && raySees(bot, eye, h.e.position.offset(0, (h.e.height || 1.8) * 0.9, 0)))
}

// Сам побег. Возвращает, когда вокруг безопасно, когда прижали (cornered) или
// по времени. safeDist — дальше скольких блоков от ближайшего ходячего врага
// считаем, что оторвались.
async function smartFlee (session, ctl, { timeoutMs = 12000, safeDist = 14, reason = null, foes = [], chaseExit = false }: any = {}) {
  const bot = session.bot
  try { bot.pathfinder.setGoal(null) } catch {}
  const deadline = gameClock.now() + timeoutMs
  const set = (k, v) => { try { bot.setControlState(k, v) } catch {} }
  const stop = () => { for (const k of ['forward', 'back', 'left', 'right', 'jump', 'sprint']) set(k, false) }
  ctl.onAbort.push(stop)
  // Рефлекс края (edges.js) и на бегу: спринт скользит дальше шага, который
  // проверяет stepSafe, а удар в спину кидает на 2-4 блока (2026-09-25).
  const edgeGuard = require('./edges').guard(bot)
  ctl.onAbort.push(() => edgeGuard.stop())

  const start = xyz(bot.entity.position)
  const fromNames = new Set()
  let prevYaw = null
  let plan = null
  let replanAt = 0
  let dodges = 0
  let dodgeUntil = 0
  let dodgeKey = null
  let cornered = 0
  // S4d (07.10; ND_S4D=0 — прежний бег до срока): бег, за которым ходячий держится в 5 бл., не отрывает — так и сказать
  // через 3 игр. с, а не бежать 12 с к краю. Спринт 5.6 бл/с против зомби ~2.3, иссушителя ~2.75 (скорость моба ~ квадрат
  // атрибута .23/.25, javap) и паука ~4: на открытом месте за 3 с отрыв 5–10 бл.; держится рядом — значит площадка
  // ограничена или бег кружит (S4c, натив s4c-ab/ab2: иссушитель снова в 4 бл. в начале каждого 12-секундного бега,
  // 7 падений с края из 16 фаз). Счёт погонь тактики (escape-progress RUN_FAILURES) после двух таких — бой на месте.
  // Только по просьбе (chaseExit — тактика): у отхода навыков свой расчёт.
  const chase = chaseExit && process.env.ND_S4D !== '0' ? { t0: gameClock.now(), d0: null as number | null } : null

  try {
    while (!ctl.aborted && gameClock.now() < deadline) {
      if (!bot.entity || (bot.health ?? 20) <= 0) return { mode: 'погиб на бегу', from: [...fromNames] }
      // Стрелки — до дальности их оружия по jar (гаст 64): «оторвался» — когда ни один не видит или все дальше своей дальности.
      const hs = hostilesAround(bot, 64, foes)
      for (const h of hs) if (h.d < 16) fromNames.add(h.e.username || h.e.name)
      const walker = hs.find(h => h.doc.radius > 0)
      if (chase && walker) {
        chase.d0 ??= walker.d
        // (S4d опыт «прижат к краю»: преследователь в 3 бл. у обрыва — конец бега как погоня. Натив s4d-ab3: без брони падений B 3 против
        // A 1 — стойка у края под ударами хаска с копьём сбрасывает так же, как бег; откатил.)
        if (gameClock.now() - chase.t0 >= 3000 && walker.d <= 5 && walker.d <= chase.d0 + 0.5) {
          stop()
          return { mode: 'не отрывается', chased: true, from: [...fromNames], pursuer: walker.e.username || walker.e.name,
            distance: Math.round(walker.d * 10) / 10, at: xyz(bot.entity.position),
            ran: Math.round(bot.entity.position.distanceTo(new Vec3(start.x, start.y, start.z))) }
        }
      }

      if (shaken(bot, hs, safeDist)) {
        stop()
        return {
          mode: 'оторвался',
          from: [...fromNames],
          at: xyz(bot.entity.position),
          ran: Math.round(bot.entity.position.distanceTo(new Vec3(start.x, start.y, start.z))),
          dodges: dodges || undefined
        }
      }

      const now = gameClock.now()
      const swell = hs.find(h => h.swelling && h.d < 6)
      if (!plan || now >= replanAt || swell) {
        plan = pickDirection(bot, hs, prevYaw)
        replanAt = now + 300
        if (!plan) {
          cornered++
          // Прижали, а в рюкзаке жемчуг — вылететь через головы (5 хп за
          // жизнь, если их больше шести).
          if (cornered >= 2 && (bot.health ?? 20) > 6) {
            const out = await pearlOut(bot, hs)
            if (out) return { mode: 'прижали — ушёл жемчугом', pearl: out, from: [...fromNames], at: xyz(bot.entity.position) }
          }
          if (cornered >= 3) {
            stop()
            return { mode: 'прижали — бежать некуда', cornered: true, from: [...fromNames], at: xyz(bot.entity.position) }
          }
        } else {
          cornered = 0
          prevYaw = plan.yaw
        }
      }
      if (plan) {
        // Эндермену в глаза не смотрим: взгляд чуть вниз.
        const pitch = hs.some(h => h.e.name === 'enderman' && h.d < 24) ? -0.35 : 0
        bot.look(plan.yaw, pitch, true).catch(() => {})
        const f = keyDir(bot, 'forward')
        const wet = inWater(bot)
        set('forward', stepSafe(bot, f) || wet)
        set('sprint', (bot.food ?? 20) > 6 && !wet)
        // Прыжок: стена по ходу или вода (всплыть).
        const ahead = bot.blockAt(bot.entity.position.offset(f.x * 0.8, 0, f.z * 0.8).floored())
        set('jump', wet || !!(ahead && ahead.boundingBox === 'block'))
      }

      // Стрелы и шары — шаг в сторону поверх бега.
      const inc = threats.incoming(bot).filter(p => p.ticks <= 10)
      if (inc.length && now > dodgeUntil) {
        dodgeKey = threats.dodgeKey(bot, inc[0], k => stepSafe(bot, keyDir(bot, k)))
        if (dodgeKey) { dodgeUntil = now + 300; dodges++ }
      }
      const dodging = dodgeKey && now < dodgeUntil
      set('left', dodging && dodgeKey === 'left')
      set('right', dodging && dodgeKey === 'right')

      await sleep(50)
    }
  } finally {
    stop()
    edgeGuard.stop()
  }
  return { mode: 'бежал до конца срока', from: [...fromNames], at: xyz(bot.entity.position), dodges: dodges || undefined, reason: reason || undefined }
}

// Жемчуг туда, где безопаснее всего. Точка переноса считается честно
// (throw.js: физика броска 1.21, своё движение, перенос в позицию жемчуга на
// тик раньше удара), и отбрасываются лава, пустота и обрывы. Раньше бросок
// шёл «под 20° в самую тихую сторону» — куда он ляжет на самом деле, никто не
// считал.
async function pearlOut (bot, hs) {
  const pearl = bot.inventory.items().find(i => i.name === 'ender_pearl')
  if (!pearl) return null
  try {
    await bot.equip(pearl, 'hand')
    const r = await throwMod.throwAt(bot, null, {
      item: bot.heldItem,
      // В прыжке на месте, если так перенесёт в более тихое место (06.10: +0.42 к вертикали — на 30 % дальше).
      jump: 'auto',
      pick: throwMod.escapePick(bot, (tp) => {
        let cost = 0
        for (const h of hs) cost += dangerAt(bot, tp, h)
        return -cost
      })
    })
    if (!r || !r.thrown) return null
    await sleep(1500)
    return { yawDeg: r.yawDeg, to: r.land || undefined }
  } catch { return null }
}

// Штраф pathfinder'у за клетки рядом с врагами — чтобы обычная ходьба
// (goto, explore, mine) не прокладывала путь сквозь толпу. Позиции врагов
// кэшируются на полсекунды: функция зовётся на каждую клетку поиска.
function mobAvoidance (bot) {
  let cache = { at: 0, list: [] }
  return (block) => {
    // Идти К мобу нарочно (удар-вызов эндермена в pearls.js): обход мобов
    // выключен на время этого шага — иначе в искажённом лесу (20+ эндерменов в
    // 40 блоках) каждая клетка у цели стоила 50+ и тело к ней не подходило.
    if (bot._ndNoMobAvoid) return 0
    const now = gameClock.now()
    if (now - cache.at > 500) {
      cache = { at: now, list: bot.entity ? hostilesAround(bot, 40).map(h => ({ p: h.e.position, doc: h.doc, swelling: h.swelling, name: h.e.name })) : [] }
    }
    if (!cache.list.length) return 0
    let cost = 0
    const P = block.position
    // Клетка из непрогруженного чанка приходит от pathfinder'а заглушкой без
    // position (movements.js getBlock), и обращение к P.x роняло весь демон:
    // исключение летит из physicsTick (замер try-blaze-rods, 2026-09-25).
    if (!P) return 0
    // _ndMobAvoidOnly (Set имён) — обходить только этих: в бастионе с золотым
    // шлемом пиглины нейтральны, а их 19 штук с радиусом 7 делали двор
    // «непроходимым» для поиска пути (ферма 29.09) — обходим брутов и хоглинов.
    const only = bot._ndMobAvoidOnly
    for (const h of cache.list) {
      if (only && !only.has(h.name)) continue
      const dx = P.x + 0.5 - h.p.x
      const dz = P.z + 0.5 - h.p.z
      const dy = P.y - h.p.y
      if (Math.abs(dy) > 6) continue
      const d = Math.hypot(dx, dz)
      const r = Math.max(h.doc.radius || 0, h.doc.blast || 0)
      if (r && d < r) cost += (r - d) * (h.swelling ? 20 : h.doc.weight)
    }
    return cost
  }
}

module.exports = { smartFlee, hostilesAround, shaken, pickDirection, edgeRisk, mobAvoidance, DOCTRINE, creeperSwelling }
