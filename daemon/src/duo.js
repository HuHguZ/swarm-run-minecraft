'use strict'
const gameClock = require('./game-clock')
// 1 против 2 (2026-09-26: пользователь с другом часто бьют одного бота вдвоём;
// PVP-RESEARCH б.21, в.9). Что делает про-игрок против двоих:
//  · держит обоих в передней полусфере: угол между ними из его точки больше
//    100° — это клещи, уходить наружу, пока не станет меньше 60°;
//  · выстраивает их в линию: ближний закрывает дальнего, у дальнего нет ни
//    руки, ни стрелы, ему надо обходить;
//  · бьёт слабого (здоровье + поглощение), занятого (ест, пьёт, тянет лук) и
//    стоящего у края — но не мечется: цель меняет сразу после своего удара
//    (заряд всё равно пуст) или когда второй в руке, а заряд готов;
//  · спина к стене — только если рядом нет обрыва; узкое место и столб между
//    ним и вторым — второй идёт в обход;
//  · оба на нём — рвёт контакт спринтом, пока они не растянутся, и берёт
//    первого догнавшего один на один;
//  · паутина под ноги второму — он отстаёт, первый остаётся один.
// ND_DUO=0 — без нового поведения (прогон «до»); счёт для отчёта идёт всегда.
//
// Числа — код игры 1.21.11 (github extremeheat/extracted_minecraft_data, ветка
// client1.21.11):
//  * Player.createAttributes: entity_interaction_range 3.0 — рука от глаз до рамки;
//  * LivingEntity.applyItemBlocking: щит держит удар в 90° от взгляда по
//    горизонтали — «передняя полусфера» = ±90°, двое в ней при угле < 180°,
//    с запасом на их шаг — < 100°;
//  * WebBlock.entityInside: makeStuckInBlock(0.25, 0.05, 0.25) — в паутине
//    вчетверо медленнее;
//  * LivingEntity.travel: спринт 0.28 бл/тик (tempo.SPRINT_BPT) — догоняют с той
//    же скоростью, поэтому рывок — не побег, а способ растянуть их.

const Vec3 = require('vec3')
const edges = require('./edges')
const tempo = require('./tempo')
const read = require('./read')
const mace = require('./mace')
const assess = require('./assess')
const { raySees } = require('./perception')
const { solid, stepSafe, keyDir } = require('./moves')

const ON = process.env.ND_DUO !== '0'
const EYE = 1.62
const HIT_REACH = 2.9
const FOE_REACH = tempo.PLAYER_REACH
const PINCER = 100 * Math.PI / 180
const LINE = 30 * Math.PI / 180
// Арена зовёт fight кусками: второго, кто бил нас, помним между кусками.
const MEMORY_MS = 60000
const RADIUS = 16

function isPlayer (e) { return !!e && (e.type === 'player' || !!e.username) }
function reachFrom (eye, e) {
  const hw = (e.width || 0.6) / 2
  const h = e.height || 1.8
  const p = e.position
  const cx = Math.max(p.x - hw, Math.min(p.x + hw, eye.x))
  const cy = Math.max(p.y, Math.min(p.y + h, eye.y))
  const cz = Math.max(p.z - hw, Math.min(p.z + hw, eye.z))
  return Math.hypot(eye.x - cx, eye.y - cy, eye.z - cz)
}
function unit (x, z) { const n = Math.hypot(x, z) || 1; return { x: x / n, z: z / n } }
function angleOf (a, b) { return Math.acos(Math.max(-1, Math.min(1, a.x * b.x + a.z * b.z))) }
const BAD = /lava|fire|magma|cactus|campfire|sweet_berry|powder_snow|cobweb/

function create (bot, { target, attackers = new Map(), dead = new Set(), used = () => {}, tt = null, clock = null, holdWeapon = async () => {}, setAim = () => {}, potionOf = () => null } = {}) {
  if (!bot._ndDuo) bot._ndDuo = { seen: new Map() }
  const mem = bot._ndDuo
  const st = {
    t2: 0, tBoth: 0, tPincer: 0, tLine: 0, ticks2: 0,
    switches: {}, resets: 0, splits: 0, webs: 0, escapes: 0, spots: 0,
    hurt: [], dmg2: 0, hitsOn: {}
  }
  const cd = {}
  const ready = (k) => gameClock.now() >= (cd[k] || 0)
  const rest = (k, ms) => { cd[k] = gameClock.now() + ms }
  // Одна надпись на приём раз в ms — чтобы лог читался, а счёт шёл.
  const note = (what, ms = 3000) => { if (ready('note:' + what)) { rest('note:' + what, ms); used(what) } }
  let lastSwitch = 0
  let prevTarget = null
  // Фокус до смерти (2026-09-26, try-duo 8 раундов: жил дольше и снимал
  // больше, но ни одного убийства — «попал по NeuroDown2 5, NeuroBuild 4»:
  // урон размазан по двоим, а сытый регенерирует 1 хп за 10 тиков
  // (FoodData.tick: насыщение и полная сытость). Один — «добиваемый»: его и
  // бить, пока не умрёт; второй — только разворотом, когда добиваемый вне руки,
  // а наш заряд готов (иначе заряд пропадёт), и сразу обратно.
  let focus = null // { id, at }
  let turned = null // { from, at } — разворот на второго
  const focusStats = { commits: 0, backs: 0, holdReset: 0 }
  st.focus = focusStats
  let spot = null
  let spotAt = 0
  let failedResets = 0
  let closed = false

  const lookDead = (e) => { const h = read.healthRaw(bot, e); return typeof h === 'number' && h <= 0 }
  // Враги этого боя: цель, кто бил последние 10 с, кто бил нас минуту назад (прошлый кусок).
  const foes = () => {
    if (!bot.entity) return []
    const now = gameClock.now()
    const out = new Map()
    const t = target()
    if (t && t.position && t.isValid !== false) out.set(t.id, t)
    for (const [id, a] of attackers) if (a && a.e && now - a.at < 10000 && !dead.has(id)) out.set(id, a.e)
    for (const [name, at] of mem.seen) {
      if (now - at > MEMORY_MS) { mem.seen.delete(name); continue }
      const pl = bot.players[name]
      const e = pl && pl.entity
      if (e && e.position && !dead.has(e.id)) out.set(e.id, e)
    }
    const me = bot.entity.position
    return [...out.values()].filter(e => e.isValid !== false && isPlayer(e) && e.id !== bot.entity.id &&
      e.username !== bot.username && !lookDead(e) && e.position.distanceTo(me) < RADIUS)
  }

  // Кто бьёт нас — в память (и между кусками боя); сколько раз за 2.5 с.
  const onHurt = (victim, source) => {
    try {
      if (!bot.entity) return
      if (victim === bot.entity) {
        st.hurt.push(gameClock.now())
        while (st.hurt.length > 8) st.hurt.shift()
        if (source && isPlayer(source) && source.id !== bot.entity.id && source.username && source.username !== bot.username) mem.seen.set(source.username, gameClock.now())
      } else if (source && source.id === bot.entity.id && isPlayer(victim)) {
        const k = victim.username || String(victim.id)
        st.hitsOn[k] = (st.hitsOn[k] || 0) + 1
      }
    } catch {}
  }
  let hpLast = bot.health ?? 20
  let two = false
  const onHealth = () => {
    const h = bot.health ?? 20
    if (two && h < hpLast) st.dmg2 += hpLast - h
    hpLast = h
  }
  // Счёт по тикам: сколько времени их двое рядом, оба достают, клещи, линия.
  const onTick = () => {
    try {
      const fs = foes()
      const me = bot.entity.position
      const near = fs.filter(e => Math.hypot(e.position.x - me.x, e.position.z - me.z) < 10)
      two = near.length >= 2
      if (!two) return
      st.ticks2++
      const [a, b] = near
      const ua = unit(a.position.x - me.x, a.position.z - me.z)
      const ub = unit(b.position.x - me.x, b.position.z - me.z)
      const th = angleOf(ua, ub)
      const da = Math.hypot(a.position.x - me.x, a.position.z - me.z)
      const db = Math.hypot(b.position.x - me.x, b.position.z - me.z)
      const ra = reachFrom(a.position.offset(0, EYE, 0), bot.entity)
      const rb = reachFrom(b.position.offset(0, EYE, 0), bot.entity)
      if (ra <= FOE_REACH && rb <= FOE_REACH) st.tBoth++
      if (th > PINCER && Math.min(da, db) < 6) st.tPincer++
      if (th < LINE && Math.abs(da - db) > 1.5) st.tLine++
    } catch {}
  }
  bot.on('entityHurt', onHurt)
  bot.on('health', onHealth)
  bot.on('physicsTick', onTick)

  // Что о нём знаем для выбора цели.
  const info = (e) => {
    const me = bot.entity.position
    const eye = me.offset(0, EYE, 0)
    const hp = read.healthRaw(bot, e)
    const ehp = (hp == null ? 20 : hp) + read.absorptionOf(bot, e)
    const s = tt && tt.state ? tt.state(e) : {}
    const busy = s.consuming ? 'ест или пьёт' : s.drawing ? 'тянет лук' : s.inWeb ? 'в паутине' : null
    const fsx = tt && tt.foes ? tt.foes.get(e.id) : null
    const held = e.equipment && e.equipment[0] ? e.equipment[0].name : null
    const readyMs = fsx && fsx.swungAt ? Math.max(0, fsx.swungAt + tempo.swingCooldownMs(held) - gameClock.now()) : 0
    return {
      e, ehp, busy, readyMs,
      d: Math.hypot(e.position.x - me.x, e.position.z - me.z),
      r: reachFrom(eye, e),
      theirR: reachFrom(e.position.offset(0, EYE, 0), bot.entity),
      shield: shieldAtUs(e)
    }
  }
  const shieldAtUs = (e) => {
    try {
      const f = e.metadata[8]
      if (typeof f !== 'number' || !(f & 1)) return false
      const it = (e.equipment || [])[(f & 2) ? 1 : 0]
      if (!it || it.name !== 'shield') return false
      const me = bot.entity.position
      const fx = -Math.sin(e.yaw || 0); const fz = -Math.cos(e.yaw || 0)
      const tx = me.x - e.position.x; const tz = me.z - e.position.z
      return (fx * tx + fz * tz) / (Math.hypot(tx, tz) || 1) > 0
    } catch { return false }
  }
  // Толкнуть к краю можно (edges.pushPlan) — раз в 600 мс на врага: прогон физики не бесплатный.
  const pushCache = new Map()
  const pushable = (e) => {
    const c = pushCache.get(e.id)
    if (c && gameClock.now() - c.at < 600) return c.v
    let v = false
    try { const p = edges.pushPlan(bot, e, {}); v = !!(p && p.now) } catch {}
    pushCache.set(e.id, { at: gameClock.now(), v })
    return v
  }
  // Чем меньше, тем лучше бить его: слабый, занятый, у края, в руке; щит к нам без топора — хуже.
  const score = (x, hasAxe) => {
    let s = x.ehp
    if (x.busy) s -= 5
    if (x.d < 6 && pushable(x.e)) s -= 8
    if (x.shield && !hasAxe) s += 6
    s += Math.max(0, x.r - HIT_REACH) * 2.5
    return s
  }

  // ------------------------------------------------------------ решение цикла
  //
  // ctx: { entity, charge, justSwung, hp, hasAxe, meInWeb, perch, fort, cooldownLeft }
  // Возвращает { kind: 'focus', e, why } | { kind: 'reset', ms, why } | { kind: 'web', e, why } | null.
  const decide = (ctx) => {
    if (!ON || closed || !bot.entity) return null
    const fs = foes()
    if (fs.length < 2) return null
    const now = gameClock.now()
    const cur = ctx.entity
    const xs = fs.map(info)
    const curX = xs.find(x => x.e.id === (cur && cur.id)) || null
    const others = xs.filter(x => x !== curX)
    // Добиваемый: слабейший по score (здоровье с поглощением, занят, у края);
    // держим, пока жив и рядом; сменить — только если другой слабее на 6+ хп.
    let fx = focus ? xs.find(x => x.e.id === focus.id) || null : null
    const weakest = xs.slice().sort((a, b) => score(a, ctx.hasAxe) - score(b, ctx.hasAxe))[0]
    if (weakest && (!fx || (weakest.e.id !== fx.e.id && weakest.ehp <= fx.ehp - 6))) {
      focus = { id: weakest.e.id, at: now }
      fx = weakest
      focusStats.commits++
    }
    // Оба на нём: оба достают, и бьют (два удара за 2.5 с) или оба заряжены.
    const both = xs.filter(x => x.theirR <= FOE_REACH + 0.2)
    const recentHits = st.hurt.filter(t => now - t < 2500).length
    // Добиваемый ослаб (≤ 12 хп с поглощением, в 5 бл.) и мы не при смерти —
    // не рвать контакт: рывок прочь — 1.1–1.6 с его регенерации (до 3 хп).
    const finishing = (curX && curX.ehp <= 6 && curX.r <= HIT_REACH && ctx.charge >= 0.9) ||
      (fx && fx.ehp <= 12 && fx.d <= 5 && (ctx.hp ?? 20) > 6)
    if (both.length >= 2 && !ctx.meInWeb && !ctx.perch && !ctx.fort && ready('reset') &&
        (recentHits >= 2 || both.every(x => x.readyMs <= 100))) {
      if (finishing) {
        if (ready('holdResetNote')) { rest('holdResetNote', 3000); focusStats.holdReset++; used(`1 против 2: не рву контакт — добиваю (${Math.round(fx ? fx.ehp : curX.ehp)} хп)`) }
      } else {
        rest('reset', failedResets >= 2 ? 9000 : 4000)
        return { kind: 'reset', ms: 1100 + Math.random() * 500, why: recentHits >= 2 ? `оба бьют (${recentHits} удара за 2.5 с)` : 'оба рядом и заряжены' }
      }
    }
    // Разворот «ударил одного — развернулся — ударил второго»: текущий вне руки,
    // второй в руке, наш заряд готов — бить второго сейчас, заряд не пропадает.
    // После удара — обратно к добиваемому (ниже). Добиваемый ослаб (≤ 10 хп) и
    // в полутора блоках от руки — заряд ждёт его (try-duo 2026-09-26: разворот
    // при «чуть вне руки» делил удары 5 на 5, а сытый добиваемый отлечивался —
    // 1 хп за 10 тиков, пока есть насыщение, FoodData.tick; но и держать заряд
    // всегда — минус четверть урона: 18 хп за раунд против 24).
    // Качели (2026-09-26, try-duo без насыщения, раунд 6: «смен цели 1963047»
    // за 76 с): разворот брал второго при добиваемом дальше 3.1, а возврат —
    // при добиваемом ближе 3.4; в полосе 3.1–3.4 решение переключалось каждый
    // проход цикла без единого тика между ними — цикл боя не отдавал ход
    // событиям, демон молчал. Теперь: разворот — не чаще раза в 700 мс, и после
    // него — к добиваемому, только когда ударили, второй ушёл, добиваемый уже в
    // руке (≤ 2.9, а не «почти») или прошло 1.5 с: полосы «разворот» (> 3.1) и
    // «назад» (≤ 2.9) больше не перекрываются. (Порог разворота 3.5 вместо 3.1
    // срезал удары по второму: iron 8 раундов — 11.3 хп против 16.7.)
    const farFocus = !fx || !curX || curX.e.id !== fx.e.id || fx.r > HIT_REACH + 1.5 || fx.ehp > 10
    if (curX && curX.r > HIT_REACH + 0.2 && ctx.charge >= 0.9 && farFocus && ready('turn')) {
      const opp = others.filter(x => x.r <= HIT_REACH && !x.shield).sort((a, b) => a.r - b.r)[0]
      if (opp) { rest('turn', 700); turned = { from: fx ? fx.e.id : null, at: now }; return { kind: 'focus', e: opp.e, why: 'разворот: второй в руке, удар заряжен' } }
    }
    // К добиваемому: сразу после своего удара по второму (разворот — заряд
    // пуст), или добиваемый снова в руке, или второй ушёл из руки.
    if (fx && curX && curX.e.id !== fx.e.id) {
      // Добиваемый ест или пьёт в 8 бл. — это окно его лечения: к нему, даже
      // если второй в руке (рывок на занятого — pvp.js, темп).
      const regen = fx.busy && fx.busy !== 'в паутине' && fx.d < 8
      // Свежий разворот ради заряженного удара: назад — только когда удар
      // ушёл, второй вышел из руки или добиваемый уже в руке (не «почти»).
      const fresh = turned && now - turned.at < 1500 && !ctx.justSwung
      const backNear = fresh ? fx.r <= HIT_REACH : fx.r <= HIT_REACH + 0.5
      if (ctx.justSwung || backNear || curX.r > HIT_REACH + 1.5 || regen || (turned && now - turned.at > 1500)) {
        focusStats.backs++
        if (regen) focusStats.regen = (focusStats.regen || 0) + 1
        turned = null
        return { kind: 'focus', e: fx.e, why: regen ? `добиваю ${fx.e.username || 'его'}: ${fx.busy}` : `добиваю ${fx.e.username || 'его'} (${Math.round(fx.ehp)} хп)` }
      }
      return null
    }
    // Паутина под второго: он подходит (2.8–5.5 бл.), первый рядом со мной, свой
    // заряд почти пуст (смена предмета обнуляет заряд — терять нечего). Не когда
    // добиваем: смена предмета — лишний тик без удара.
    if (!finishing && curX && ready('web') && ctx.cooldownLeft > 300 && bot.inventory.items().some(i => i.name === 'cobweb')) {
      const far = others.find(x => x.d > 2.8 && x.d < 5.5 && !x.busy && x.theirR > FOE_REACH)
      if (far && curX.d < far.d - 1 && webSpot(far.e)) {
        rest('web', 6000)
        return { kind: 'web', e: far.e, why: 'паутина под второго — пусть отстанет' }
      }
    }
    // Текущий не из двоих (или его нет) — к добиваемому. Прежняя смена «по
    // выгоде» (score на 4+) — теперь выбор добиваемого выше: цель меняется
    // только на того, кто слабее на 6+ хп, и не туда-обратно.
    if (!curX) return fx ? { kind: 'focus', e: fx.e, why: 'цель — добиваемый из двоих' } : null
    void prevTarget
    return null
  }
  const switched = (from, to, why) => {
    lastSwitch = gameClock.now()
    prevTarget = from ? from.id : null
    const k = why.replace(/ \(.*$/, '')
    st.switches[k] = (st.switches[k] || 0) + 1
    note('1 против 2: ' + why, 1500)
  }

  // ------------------------------------------------------------ рывок из-под двоих
  //
  // Бегом прочь (tempo.kite: мимо стен, обрывов, лавы) до ms, пока они не
  // растянутся: ближний на 3 бл. ближе дальнего, или оба отстали на 6+. Потом —
  // ближнего один на один. Два рывка подряд без растяжки — драться (не бегать по
  // кругу): решение выше ставит паузу 9 с.
  const runReset = async (ctl, plan) => {
    st.resets++
    note('1 против 2: оба на мне — рву контакт (' + plan.why + ')', 1500)
    setAim('free')
    const fsNow = () => foes()
    const split = () => {
      const me = bot.entity.position
      const ds = fsNow().map(e => Math.hypot(e.position.x - me.x, e.position.z - me.z)).sort((a, b) => a - b)
      if (ds.length < 2) return true
      return ds[1] - ds[0] >= 3 || ds[0] >= 6
    }
    let how = 'время'
    try {
      how = await tempo.kite(bot, ctl, fsNow, { ms: plan.ms, until: split })
    } catch {}
    setAim('target')
    const ok = how === 'оторвался' || split()
    if (ok) { st.splits++; failedResets = 0; note('1 против 2: растянул их — беру первого', 1500) } else failedResets++
    const me = bot.entity.position
    const all = fsNow()
    // После рывка — добиваемого, если он в 8 бл. (растянул — он и отстаёт или
    // догоняет первым); иначе ближнего.
    const fe = focus ? all.find(e => e.id === focus.id && e.position.distanceTo(me) < 8) : null
    const near = fe || all.sort((a, b) => a.position.distanceTo(me) - b.position.distanceTo(me))[0] || null
    await holdWeapon()
    return { ok, pick: near, how }
  }

  // ------------------------------------------------------------ паутина под второго
  const webSpot = (e) => {
    const cell = e.position.floored()
    const below = bot.blockAt(cell.offset(0, -1, 0))
    const here = bot.blockAt(cell)
    if (!below || below.boundingBox !== 'block' || !here || here.name !== 'air') return null
    const eye = bot.entity.position.offset(0, EYE, 0)
    const face = below.position.offset(0.5, 1, 0.5)
    if (face.distanceTo(eye) > 4.4) return null
    return below
  }
  const webSecond = async (e) => {
    const below = webSpot(e)
    const web = bot.inventory.items().find(i => i.name === 'cobweb')
    if (!below || !web) return false
    setAim('free')
    let ok = false
    try {
      await bot.equip(web, 'hand')
      await bot.lookAt(below.position.offset(0.5, 1, 0.5), true)
      await Promise.race([bot.placeBlock(below, new Vec3(0, 1, 0)), new Promise((resolve, reject) => gameClock.setTimeout(() => reject(new Error('timeout')), 600))])
    } catch {}
    const b = bot.blockAt(below.position.offset(0, 1, 0))
    ok = !!(b && b.name === 'cobweb')
    setAim('target')
    await holdWeapon()
    if (ok) { st.webs++; note('1 против 2: паутина под второго', 1500) }
    return ok
  }

  // ------------------------------------------------------------ движение
  //
  // Клещи (угол > 100°, кто-то ближе 6) — наружу: прочь от обоих по биссектрисе,
  // а если они строго напротив друг друга — вбок от их линии, туда, где от края
  // дальше. Иначе — к лучшей клетке рядом (bestSpot): оба спереди, ближний
  // закрывает дальнего, спина к стене без обрыва, столб между мной и вторым.
  // Удар не трогаем: ход — пока свой заряд копится или цель вне руки.
  const steer = (keys, ctx) => {
    if (!ON || closed || !bot.entity) return keys
    const fs = foes()
    if (fs.length < 2) return keys
    const me = bot.entity.position
    const cur = ctx.entity
    const t = fs.find(e => e.id === (cur && cur.id)) || fs[0]
    const o = fs.filter(e => e !== t).sort((a, b) => a.position.distanceTo(me) - b.position.distanceTo(me))[0]
    if (!o) return keys
    const ua = unit(t.position.x - me.x, t.position.z - me.z)
    const ub = unit(o.position.x - me.x, o.position.z - me.z)
    const da = Math.hypot(t.position.x - me.x, t.position.z - me.z)
    const db = Math.hypot(o.position.x - me.x, o.position.z - me.z)
    if (Math.max(da, db) > 12) return keys
    const th = angleOf(ua, ub)
    let w = null
    let strong = false
    if (th > PINCER && Math.min(da, db) < 6) {
      const sx = -(ua.x + ub.x); const sz = -(ua.z + ub.z)
      if (Math.hypot(sx, sz) > 0.35) w = unit(sx, sz)
      else {
        // Строго напротив: вбок от их линии — где от края дальше.
        const n1 = unit(-(o.position.z - t.position.z), o.position.x - t.position.x)
        const n2 = { x: -n1.x, z: -n1.z }
        const cache = new Map()
        const c1 = edges.clearance(bot, me.offset(n1.x * 1.5, 0, n1.z * 1.5), 2.5, cache)
        const c2 = edges.clearance(bot, me.offset(n2.x * 1.5, 0, n2.z * 1.5), 2.5, cache)
        w = c1 >= c2 ? n1 : n2
      }
      strong = true
      if (ready('pincerNote')) { rest('pincerNote', 3000); st.escapes++; used('1 против 2: ухожу из клещей') }
    } else if (ctx.cooldownLeft > 150 || ctx.r > HIT_REACH + 0.5) {
      const now = gameClock.now()
      if (now >= spotAt) { spotAt = now + 400; spot = bestSpot(t, o) }
      if (spot && Math.hypot(spot.x - me.x, spot.z - me.z) > 0.6) {
        w = unit(spot.x - me.x, spot.z - me.z)
        if (spot.why && ready('spotNote:' + spot.why)) { rest('spotNote:' + spot.why, 4000); st.spots++; used('1 против 2: ' + spot.why) }
      }
    }
    if (!w) return keys
    const f = keyDir(bot, 'forward'); const r = keyDir(bot, 'right')
    const fd = w.x * f.x + w.z * f.z
    const rd = w.x * r.x + w.z * r.z
    const out = { ...keys }
    // Удар готов и цель почти в руке — вперёд не отнимаем (подойти и ударить).
    const wantsHit = ctx.cooldownLeft <= 150 && keys.forward
    if (fd > 0.35) { out.forward = true; out.back = false } else if (fd < -0.35 && !wantsHit) { out.forward = false; out.back = true } else if (strong && !wantsHit) { out.forward = false; out.back = false }
    if (Math.abs(rd) > 0.3) out.strafe = rd > 0 ? 'right' : 'left'
    else if (strong) out.strafe = null
    out.sprint = !!out.forward && (keys.sprint || strong)
    if (out.forward && !stepSafe(bot, keyDir(bot, 'forward'))) out.forward = keys.forward && stepSafe(bot, keyDir(bot, 'forward'))
    if (out.back && !stepSafe(bot, keyDir(bot, 'back'))) out.back = false
    if (out.strafe && !stepSafe(bot, keyDir(bot, out.strafe))) out.strafe = keys.strafe
    return out
  }

  // Клетка рядом (до 3 бл.), где с двоими удобнее всего. Оценка:
  //  · угол между ними оттуда: больше 100° — клещи (штраф), меньше — лучше;
  //  · дальний за ближним (угол < 30°) или за блоком (луча нет) — он не
  //    достаёт и должен обходить: столб, узкое место;
  //  · до цели 2.6–3.6 (край своей руки), до второго не ближе 2.6;
  //  · спина к стене — плюс, но только если до обрыва от клетки не меньше 1.5;
  //  · свободных мест, откуда можно ударить, меньше — лучше (угол, проход);
  //  · путь — минус 0.8 за блок.
  const standable = (c) => {
    const f = bot.blockAt(c); const h = bot.blockAt(c.offset(0, 1, 0)); const g = bot.blockAt(c.offset(0, -1, 0))
    if (!f || !h || !g) return false
    if (f.boundingBox !== 'empty' || h.boundingBox !== 'empty' || g.boundingBox !== 'block') return false
    return !BAD.test(f.name) && !BAD.test(h.name) && !BAD.test(g.name)
  }
  const bestSpot = (t, o) => {
    const me = bot.entity.position
    const base = me.floored()
    const cache = new Map()
    const evalAt = (S, travel) => {
      const dN = Math.hypot(t.position.x - S.x, t.position.z - S.z)
      const dF = Math.hypot(o.position.x - S.x, o.position.z - S.z)
      if (dN < 2.2 || dF < 2.6) return null
      const clr = edges.clearance(bot, S, 1.6, cache)
      if (clr < 0.5) return null
      const uN = unit(t.position.x - S.x, t.position.z - S.z)
      const uF = unit(o.position.x - S.x, o.position.z - S.z)
      const th = angleOf(uN, uF)
      let s = 0
      const why = []
      if (th > PINCER) s -= 8 + (th - PINCER) * 4
      else s += (PINCER - th) / PINCER * 3
      if (dF > dN && th < LINE) { s += 3; why.push('в линию') }
      const eye = S.offset(0, EYE, 0)
      if (!raySees(bot, eye, o.position.offset(0, 1.2, 0)) && raySees(bot, eye, t.position.offset(0, 1.2, 0))) { s += 3.5; why.push('второй за блоком') }
      s -= Math.abs(dN - 3.1) * 1.2
      if (clr < 1.5) s -= (1.5 - clr) * 4
      else {
        // Спина к стене: блоки за спиной (от обоих) на уровне ног или головы.
        const bx = -(uN.x + uF.x); const bz = -(uN.z + uF.z)
        const bu = unit(bx, bz)
        let wall = 0
        for (const [ox, oz] of [[bu.x, bu.z], [bu.x - bu.z * 0.7, bu.z + bu.x * 0.7], [bu.x + bu.z * 0.7, bu.z - bu.x * 0.7]]) {
          const c = new Vec3(Math.floor(S.x + ox), Math.floor(S.y), Math.floor(S.z + oz))
          if (solid(bot, c) || solid(bot, c.offset(0, 1, 0))) wall++
        }
        if (wall) { s += Math.min(3, wall * 1.2); if (wall >= 2) why.push('спина к стене') }
      }
      // Сколько мест вокруг, откуда можно ударить (на 2 бл., 8 сторон).
      let open = 0
      for (let k = 0; k < 8; k++) {
        const a = k * Math.PI / 4
        const c = new Vec3(Math.floor(S.x + Math.cos(a) * 2), Math.floor(S.y), Math.floor(S.z + Math.sin(a) * 2))
        if (standable(c)) open++
      }
      s -= open * 0.4
      if (open <= 4 && !why.includes('спина к стене')) why.push('узкое место')
      s -= travel * 0.8
      return { s, why }
    }
    const here = evalAt(me, 0)
    let best = null
    for (let dx = -3; dx <= 3; dx++) {
      for (let dz = -3; dz <= 3; dz++) {
        if (!dx && !dz) continue
        if (dx * dx + dz * dz > 10) continue
        let c = null
        for (const dy of [0, 1, -1]) { const q = base.offset(dx, dy, dz); if (standable(q)) { c = q; break } }
        if (!c) continue
        const S = new Vec3(c.x + 0.5, c.y, c.z + 0.5)
        const travel = Math.hypot(S.x - me.x, S.z - me.z)
        // Дойти по прямой: середина пути проходима, стены на уровне колен нет.
        const mid = new Vec3(Math.floor((S.x + me.x) / 2), Math.floor(me.y), Math.floor((S.z + me.z) / 2))
        if (!standable(mid) && !standable(mid.offset(0, 1, 0)) && !standable(mid.offset(0, -1, 0))) continue
        const v = evalAt(S, travel)
        if (v && (!best || v.s > best.s)) best = { x: S.x, y: S.y, z: S.z, s: v.s, why: v.why }
      }
    }
    if (!best) return null
    if (here && best.s < here.s + 1.5) return null
    return { x: best.x, y: best.y, z: best.z, why: best.why.length ? best.why.join(', ') : null }
  }

  // ------------------------------------------------------------ всплеск в добиваемого
  //
  // Урон размазан по двоим — убийства нет (try-duo 2026-09-26: 8 раундов по
  // 15–31 хп, 0 убийств). Добить — только всплеском в одного:
  //  * вред II броском — 12 магией мимо брони (HealOrHarmMobEffect: 6 << уровень;
  //    прямое попадание ×1, рядом ×(1 − √d/4) — AbstractThrownPotion.applySplash),
  //    два подряд — 24, но второй не раньше 10 тиков (LivingEntity.hurtServer:
  //    пока invulnerableTime > 10, проходит лишь разница с lastHurt) — пауза
  //    600 мс; бросок — с 3.3–5.2 бл. (дальше не долетит, ближе облако бьёт нас);
  //  * булава с падения (mace.smashPlan): по железу ≈ 30 после брони — броня
  //    15 против удара 39 режет только до armor/5 (CombatRules.
  //    getDamageAfterAbsorb) — убийство с полного; взлёт ~10 тиков у земли, и
  //    удар второго в эти тики срезает подъём (LivingEntity.knockback) — только
  //    когда второй не достанет или его удар не готов;
  //  * заряженный арбалет добивает сам (ranged.plan, «добиваю»).
  // Возвращает { kind: 'harm', e, item, why } | { kind: 'smash', e, why } | null.
  const HARM = { strong_harming: 12, harming: 6 }
  const harmsOf = () => bot.inventory.items()
    .filter(i => i.name === 'splash_potion' && HARM[potionOf(i)])
    .map(i => ({ item: i, dmg: HARM[potionOf(i)] }))
    .sort((a, b) => b.dmg - a.dmg)
  const burstStats = { harm: 0, smash: 0 }
  st.burst = burstStats
  const secondBusy = (fx, xs, lead = 0.8) => {
    // Второй (не добиваемый): достанет ли нас за время приёма и готов ли его удар.
    const o = xs.filter(x => x !== fx).sort((a, b) => a.theirR - b.theirR)[0]
    if (!o) return false
    const soon = o.theirR <= FOE_REACH + lead
    return soon && o.readyMs < 700
  }
  const burst = (ctx = {}) => {
    if (!ON || closed || !bot.entity) return null
    const fs = foes()
    if (fs.length < 2) return null
    const xs = fs.map(info)
    const fx = focus ? xs.find(x => x.e.id === focus.id) : null
    if (!fx) return null
    const eye = bot.entity.position.offset(0, EYE, 0)
    const sees = raySees(bot, eye, fx.e.position.offset(0, (fx.e.height || 1.8) * 0.55, 0))
    // Вред: сколько снимут все броски, что есть (по два за окно).
    const hs = harmsOf()
    // Окно броска — 3.3–5.2 бл.: зелье до середины его тела долетает лишь на
    // ~4.5 (throw.aim; 0.5 бл/тик, −20°, тяжесть 0.05), а облако ближе 3.3 к
    // нам бьёт и нас (pvp.throwAt minLand). Прежнее окно 4.6–8 почти всегда
    // было «не долетит» (after-burst: «вред 10» решений — 1 бросок).
    if (hs.length && sees && ready('burstHarm') && fx.d >= 3.3 && fx.d <= 5.2 && !ctx.meInWeb) {
      const total = hs.slice(0, 2).reduce((s, h) => s + h.dmg, 0)
      if (fx.ehp <= total + 1) {
        rest('burstHarm', 600)
        burstStats.harm++
        return { kind: 'harm', e: fx.e, item: hs[0].item, why: `вред в добиваемого ${fx.e.username || ''} (${Math.round(fx.ehp)} хп, снимет до ${total})` }
      }
    }
    // Булава: взлёт на добиваемого, пока второй не мешает.
    if (!ctx.meInWeb && !ctx.perch && !ctx.fort && (ctx.hp ?? 20) > 6 && ready('burstSmash')) {
      let sp = null
      try { sp = mace.smashPlan(bot, fx.e) } catch {}
      if (sp) {
        const g = assess.gearOf(((fx.e.equipment) || []).slice(2))
        const exp = assess.afterArmor(sp.expect, g.armor, g.tough)
        // Второй не должен успеть: за заряд булавы и взлёт (~12 тиков) он
        // пробегает ~3 бл. — его рука дальше 3 + 3.2 (after-burst: «передумал»
        // ×4 — каждый отказ стоил смены предмета).
        if (fx.ehp <= exp + 2 && !fx.shield && !secondBusy(fx, xs, 3.2) && !(fx.theirR <= FOE_REACH && fx.readyMs < 100)) {
          rest('burstSmash', 2500)
          burstStats.smash++
          return { kind: 'smash', e: fx.e, why: `булава в добиваемого ${fx.e.username || ''} (${Math.round(fx.ehp)} хп, жду ~${Math.round(exp)})` }
        }
      }
    }
    return null
  }
  // Удар второго придёт в тики взлёта булавы (для общего блока булавы в pvp.js).
  const secondThreat = () => {
    if (!ON || closed || !bot.entity) return false
    const fs = foes()
    if (fs.length < 2) return false
    const xs = fs.map(info)
    const cur = target()
    const fx = xs.find(x => x.e.id === (cur && cur.id)) || xs[0]
    return secondBusy(fx, xs)
  }

  const close = () => {
    if (closed) return
    closed = true
    bot.removeListener('entityHurt', onHurt)
    bot.removeListener('health', onHealth)
    bot.removeListener('physicsTick', onTick)
    if (!st.ticks2) return
    const pct = n => Math.round(n / st.ticks2 * 100)
    used(`1 против 2${ON ? '' : ' (выкл)'}: двое рядом ${Math.round(st.ticks2 / 20)} с — оба достают ${pct(st.tBoth)}%, клещи ${pct(st.tPincer)}%, в линию ${pct(st.tLine)}%, урон от двоих ${Math.round(st.dmg2)}`)
    const sw = Object.entries(st.switches).map(([k, v]) => `${k}×${v}`).join(', ')
    if (ON && (sw || st.resets || st.webs)) used(`1 против 2: смен цели ${Object.values(st.switches).reduce((a, b) => a + b, 0)}${sw ? ' (' + sw + ')' : ''}, рывков ${st.resets} (растянул ${st.splits}), паутина под второго ${st.webs}`)
    const hits = Object.entries(st.hitsOn).map(([k, v]) => `${k} ${v}`).join(', ')
    if (hits) used('1 против 2: попал по ' + hits)
    if (ON && focusStats.commits) used(`1 против 2: добиваемых ${focusStats.commits}, обратно к нему ${focusStats.backs} (он лечился ${focusStats.regen || 0}), не рвал контакт ради добивания ${focusStats.holdReset}`)
    if (ON && (burstStats.harm || burstStats.smash)) used(`1 против 2: всплеск в добиваемого — вред ${burstStats.harm}, булава ${burstStats.smash}`)
  }

  return {
    ON,
    active: () => ON && !closed && foes().length >= 2,
    foes,
    decide,
    switched,
    runReset,
    webSecond,
    steer,
    burst,
    // Бросок не состоялся (облако легло бы на нас, нечем) — не пробовать 1.5 с.
    burstFailed: (kind) => rest(kind === 'harm' ? 'burstHarm' : 'burstSmash', 1500),
    secondThreat,
    focusId: () => (focus ? focus.id : null),
    stats: st,
    close
  }
}

module.exports = { create, ON }
