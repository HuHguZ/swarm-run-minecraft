'use strict'
const gameClock = require('./game-clock')
// Снимок для замеров (A/B, 2026-09-30): ND_DRAGON_IMPL=<файл рядом> — демон берёт бой из
// замороженной копии, пока этот файл правится. Без переменной — как обычно.
{
  const impl = process.env.ND_DRAGON_IMPL
  if (impl) {
    const p = require('path').resolve(__dirname, impl)
    if (p !== __filename) { module.exports = require(p); return }
  }
}
// Бой с Эндер-драконом — то, что делает сильный игрок, от платформы до
// выходного портала: дойти с обсидиановой платформы до острова, сбить луком
// кристаллы на обелисках (клетки из железных прутьев вскрыть со столба),
// не смотреть эндерменам в глаза, уклоняться от фаерболов и облаков дыхания,
// сидящему дракону бить в голову критами, летающему — стрелять с упреждением,
// лечиться, а после победы взять яйцо и уйти домой через выходной портал.
//
// Все числа механики сняты с байткода paper-1.21.11 (мохьянг-маппинги,
// javap -c по server/versions/1.21.11/paper-1.21.11.jar), а не подобраны:
//
//   EnderDragon.<init>       части по порядку: head 1×1, neck 3×3, body 5×3,
//                            tail ×3 2×2, wing ×2 4×2. Сервер не зовёт setId —
//                            части получают id подряд из общего счётчика сразу
//                            за драконом, а клиент (recreateFromPacket) ставит им
//                            id дракона + i + 1. Голова = id + 1.
//   EnderDragon.aiStep       голова = позиция + (sin yRot·6.5·cos p, off + sin p·6.5,
//                            −cos yRot·6.5·cos p), шея то же с 5.5; сидя off = −1,
//                            p = 0 (getHeadYOffset). В углах mineflayer это
//                            (sin yaw, cos yaw) — проверено по направлению полёта.
//                            Каждый тик при hurtTime == 0: крылья (коробка крыла,
//                            раздутая на 4,2,4 и опущенная на 2) толкают прочь на
//                            4/d² и +0.2 вверх, в полёте ещё 5 урона; голова и шея,
//                            раздутые на 1, бьют на 10 — и сидя тоже.
//   EnderDragon.hurt(part)   не голова: урон/4 + min(урон, 1). Удар по самой
//                            сущности дракона (hurtServer) засчитывается как тело.
//                            Сидя: sittingDamageReceived > 0.25·200 = 50 → взлёт.
//   AbstractDragonSittingPhase.onHurt   сидящему стрелы урона не наносят (0, поджигает).
//   DragonSittingScanningPhase  ищет игрока в 20 блоках, поворачивает голову к нему;
//                            через 25 тиков — рёв (SittingAttacking, 40 тиков) → огонь.
//   DragonSittingFlamingPhase  на 10-м тике огня — облако: центр в 2.5 блока дальше
//                            головы, по высоте — верх первого непустого блока под
//                            головой; радиус 5, 200 тиков, мгновенный урон I;
//                            огней не больше 4, потом взлёт.
//   DragonFireball.onHit     облако радиуса 3 → 7 за 600 тиков, мгновенный урон II,
//                            и если живое ближе 4 блоков (коробка 4,2,4) — облако
//                            переезжает ему ПОД НОГИ.
//   AreaEffectCloud          первые 20 тиков ждёт, потом раз в 20 тиков на живое;
//                            высота облака 0.5: кто стоит на блок выше — не задет.
//                            Мгновенный урон из облака ×0.5: 3 (I) и 6 (II), магия,
//                            броня не режет.
//   EndCrystal.hurtServer    любой урон (кроме от дракона) → взрыв мощности 6 без
//                            огня. ExplosionDamageCalculator: радиус 12, урон
//                            ((1−d/12)·видимость)² + …)/2·7·12 + 1 — вплотную 85,
//                            с 10 блоков ~9, дальше 12 — ноль.
//   SpikeFeature             обелиски на 42 блока от центра, высота 76 + 3·j,
//                            кристалл на bedrock наверху, клетка (j = 1, 2) —
//                            прутья на |dx| = 2 или |dz| = 2 или верх, от уровня
//                            bedrock до +3.
//   EnderMan.isBeingStaredBy → isLookingAtMe(игрок, 0.025, по расстоянию):
//                            взгляд · (глаз эндермена − наш глаз)/len > 1 − 0.025/len
//                            и прямая видимость. Глаза эндермена на 2.55.
//   BedBlock.explodeBed      в Энде кровать — взрыв 5.0 с огнём в центре
//                            изголовья; ServerExplosion (Paper) бьёт дракона
//                            по каждой его части в зоне, голова — полным уроном;
//                            bad_respawn_point ∈ #always_hurts_ender_dragons.
//                            В игре: 35–40 урона за кровать у головы (см. bedBlast).
//   AreaEffectCloud          blocksBuilding не ставит — блок в клетку облака
//                            ставится (build.js это знает).
//   BucketItem.use           луч от глаз на 4.5 по позиции прошлого пакета —
//                            ведро под ноги в падении (fallGuard).
//   spigot.yml (этот сервер) other: 64 — кристаллы видно только с 64 блоков,
//                            дракона — на всю дальность прорисовки. Отсюда «подойти к
//                            центру, чтобы увидеть все кристаллы».

const Vec3 = require('vec3')
const { Movements, goals } = require('mineflayer-pathfinder')
const { sleep } = require('./movement')
const bow = require('./bow')
const build = require('./build')
const threats = require('./threats')
const pvp = require('./pvp')
const items = require('./items')
const armor = require('./armor')
const actions = require('./actions')
const pick = require('./pick')
const pearlHop = require('./pearl-hop')

const DEBUG = !!process.env.ND_DEBUG_DRAGON
// Отдать очередь вводу-выводу. Каждый долгий цикл здесь начинается с этого:
// одна ветка «continue» без настоящего ожидания однажды крутилась синхронно,
// демон переставал отвечать на keep-alive, и сервер рвал связь посреди боя.
const yieldTick = () => new Promise(resolve => setImmediate(resolve))
const dbg = (...a) => { if (DEBUG) console.log(`[dragon ${new Date().toISOString().slice(11, 19)}]`, ...a) }

// ------------------------------------------------------------ числа игры

const PHASE = { HOLDING: 0, STRAFE: 1, APPROACH: 2, LANDING: 3, TAKEOFF: 4, FLAMING: 5, SCANNING: 6, ROARING: 7, CHARGING: 8, DYING: 9, HOVER: 10 }
const PHASE_RU = ['кружит', 'заходит на игрока с фаерболом', 'заходит на посадку', 'садится', 'взлетает',
  'сидит и дышит огнём', 'сидит, высматривает', 'сидит, ревёт', 'таранит', 'умирает', 'висит']
const SITTING = new Set([PHASE.FLAMING, PHASE.SCANNING, PHASE.ROARING])
// Высота подушки станции у столба над верхом столба P (pillarPlan dy): ND_PILLOW_DY. По умолчанию 0 — над верхом
// столба (hb3, 6 кроватей, одни сиды: 7 побед из 14 без смертей против 0 из 14 у прежней −1; урон p50 39.6 против
// 30.3, голова по серверу 2.57 против 2.91, видимость 0.93 против 0.81). ND_PILLOW_DY=-1 — прежняя станция.
const PILLOW_DY = process.env.ND_PILLOW_DY != null ? Number(process.env.ND_PILLOW_DY) : 0
// Столбик к опоре станции — и не только пока кружит: дракон дальше стольких блоков от бота и фаербола нет (0 — только HOLDING).
const TOWER_FAR = Number(process.env.ND_TOWER_FAR ?? 40)
// R (02.10): опоры K на P и P + 1 — с одного столбика (ND_RUN_TOWER1=0 — как было, столбик на каждую)
const RUN_TOWER1 = () => envv('ND_RUN_TOWER1') !== '0'
// R: точка ставки кровати с запасом по углу изголовья (faceClickFacing; ND_RUN_FACING=0 — как было, край грани)
const RUN_FACING = () => envv('ND_RUN_FACING') !== '0'
// R: стрела в голову на снижении, когда кровати кончились (runnerArrow; ND_RUN_ARROW=1 — вкл., пока не замерено)
const RUN_ARROW = () => envv('ND_RUN_ARROW') === '1'
// R: ярус P + 1, когда он готов к проходу (Codex dragon-seen, 02.10: seen считается по коробке РОДИТЕЛЯ 16×8×16 — ServerExplosion
// hurtEntities, — а не по голове; на P обе опоры K0/K1 закрывают лучи с уровня кровати и выше. labR3 офлайн: Σ первых 4 ≥ 200 —
// 119 → 137 из 162; ≥ 210 (лечение кристаллами ~9 за цепочку) — 71 → 84). ND_RUN_HIGH=1 — вкл., пока не замерено боями.
const RUN_HIGH = () => envv('ND_RUN_HIGH') === '1'
// R: добить мечом сидящего, когда кровати кончились (ND_RUN_MELEE=1 — вкл., пока не замерено)
const RUN_MELEE = () => envv('ND_RUN_MELEE') === '1'
// R: не щёлкать в тик, когда коробка тела дракона закрывает F (bodyBlocksBed; ND_RUN_BOX=0 — выкл.)
const RUN_BOX = () => envv('ND_RUN_BOX') !== '0'
// R: ярус — по прогнозному урону bedDamage(расстояние, seen родителя) (smDragonSeen; ND_RUN_SEEN=0 — по расстоянию)
const RUN_SEEN = () => envv('ND_RUN_SEEN') !== '0'
// R: стрелы в промежутках цепочки (runnerGapArrow; ND_RUN_GAPARROW=1 — вкл., пока не замерено)
const RUN_GAPARROW = () => envv('ND_RUN_GAPARROW') === '1'
// R: булыжник под F (ярус P + 1) — ставить сразу после взрыва (ND_RUN_KEEPCOB=0 — выкл.)
const RUN_KEEPCOB = () => envv('ND_RUN_KEEPCOB') !== '0'
// R: тик щелчка — по прогнозному урону (расстояние и seen) среди тика прохода и 3 ранних (ND_RUN_TICKSEEN=0 — выкл.)
const RUN_TICKSEEN = () => envv('ND_RUN_TICKSEEN') !== '0'
// R: поздняя проверка — голова по свежему прогнозу в тик взрыва дальше 4.6 — не щёлкать (ND_RUN_LATEHEAD=0 — выкл.)
const RUN_LATEHEAD = () => envv('ND_RUN_LATEHEAD') !== '0'
// Попыток станции за бой: A — 10; R — ND_RUN_TRIES (25): до готовой станции кровати сидящему не тратятся (fr1: 32 кровати
// ушли до станции — 10 попыток кончились на «к столбику не дошёл»)
function pillarTriesMax () { return runnerOn() ? envNum('ND_RUN_TRIES', 25) : 10 }
// Кровати не тратить на сидящего/снижение без станции, пока их не больше KEEP_N и станция ещё будет (ND_KEEP_BEDS=0 — выкл.).
const KEEP_ON = process.env.ND_KEEP_BEDS !== '0'
const KEEP_N = Number(process.env.ND_KEEP_N ?? 7)
// Первая кровать снижения — голова не дальше стольких блоков от подушки (дальше — ждать прохода ближе или посадки).
const FIRST_MAX = Number(process.env.ND_FIRST_MAX ?? 4.0)
// Одна попытка стройки станции — не дольше (мс); 0 — без предела. Итерация st3 (01.10): с пределом 30 с и памятью неудачных
// планов (ND_PILLAR_BAD=1) станция p50 124 с против 26 с в st2 («опора: негде встать» ×14 — уход на худший план) — выкл.
const BUILD_MAX_MS = Number(process.env.ND_BUILD_MAX_MS ?? 0)
// Кровать станции — за столько тиков до щелчка (не раньше начала свободного окна).
const PLACE_LEAD = Number(process.env.ND_PLACE_LEAD ?? 6)
const PILLAR_BAD = process.env.ND_PILLAR_BAD === '1'
// Макушка бота в окопе станции не выше P − HEAD_ROOM (голова/шея/крыло на снижении не достают): ND_PILLAR_HEADROOM, 2.6.
const HEAD_ROOM = Number(process.env.ND_PILLAR_HEADROOM ?? 2.6)
// Лаборатория взрыва (try-lab-dragon-blast.js, 01.10): переключатели на один вызов labPlan/labRun поверх process.env —
// плечи гипотез чередуются в одном демоне. Вне лаборатории LABENV пуст — читается process.env.
const LABENV = {}
function envv (k) { return Object.prototype.hasOwnProperty.call(LABENV, k) ? LABENV[k] : process.env[k] }
// Станция раннера R (бот в чаше у столба) — по умолчанию ВКЛ. с 03.10 (проверка vdr1–6: 4 кровати + меч 78/111 = 70 %,
// 5 кроватей 40/42; старая станция A на 4 кроватях — 0/7). ND_RUNNER=0 — старая станция.
function runnerOn () { return envv('ND_RUNNER') !== '0' }
function envNum (k, d) { const v = envv(k); return v != null && v !== '' ? Number(v) : d }
const HEAD_AHEAD = 6.5
// Запас к раздутым на 1 голове и шее (EnderDragon.aiStep → hurt) для «сюда нельзя»: наша
// оценка положения головы сидящего ошибается на ~0.5 (c1-28, 30.09, 442.7 с: кровать
// «в 0.3 от головы» — удар головой, 6).
const HURT_PAD = 1.5
const NECK_AHEAD = 5.5
const SIT_HEAD_DY = -1
const PART = { head: 1, neck: 2, body: 3 }
const SIT_TAKEOFF = 50
const CRYSTAL_BLAST = 12
const SAFE_FROM_CRYSTAL = 12.8
const BREATH_R = 5
const BREATH_AHEAD = 2.5
const FIREBALL_SNAP = 4
const CLOUD_SLAB = 0.5
const STARE_TOL = 0.025
const STARE_MARGIN = 3
const ENDERMAN_EYE = 2.55
const MELEE_REACH = 2.9
const EYE = 1.62
const CENTER = { x: 0.5, z: 0.5 }
// Java 1.21.11: сначала perch, затем два nextInt через OR с коротким замыканием.
// podium — центр getHeightmapPos(...), с +0.5 по всем координатам; расстояние трёхмерное.
function holdingOdds (alive, feet, podium) {
  const distanceBound = Math.floor(feet.distanceSquared(podium) / 512 + 2)
  const perch = 1 / (alive + 3)
  const strafeGivenNoPerch = 1 / distanceBound + (1 - 1 / distanceBound) / (alive + 2)
  return { distanceBound, perch, strafeGivenNoPerch, strafe: (1 - perch) * strafeGivenNoPerch }
}
function dragonWaitBand ({ station, crystalActive, holdOut, ph }) {
  if (envv('ND_WAIT_BUCKET') !== '1' || !station || crystalActive || holdOut ||
      ![PHASE.HOLDING, PHASE.STRAFE, PHASE.CHARGING].includes(ph)) return null
  // Прежний допуск кольца -0.7: даже его внутренний край должен иметь горизонтальный d² >= 512.
  // 0.1 — запас координат; максимальный радиус менее 27, чтобы не удлинять вход как ND_WAIT_FAR.
  return [Math.sqrt(512) + 0.7 + 0.1, 25.5]
}
function dragonWaitStop (ph) {
  return [PHASE.HOLDING, PHASE.STRAFE, PHASE.CHARGING].includes(ph) ? null : 'окно посадки'
}

// Что брать с собой (проверяется ДО входа — need {what, count, have}).
const KIT = { arrows: 32, blocks: 64, food: 6 }
// Кроватей на бой «только кровати»: 2–3 за посадку, посадок 3–5 (лечение от
// кристаллов между ними ~120 хп) — research/dev-C-dragon.md.
const BEDS_KIT = 12
const FILLER_RE = /^(cobblestone|cobbled_deepslate|dirt|netherrack|stone|deepslate|andesite|diorite|granite|tuff|blackstone|end_stone|oak_planks|spruce_planks|birch_planks)$/

// ------------------------------------------------------------ восприятие

function metaOf (bot, e, key) {
  try {
    const keys = bot.registry.entitiesByName[e.name].metadataKeys
    const i = keys.indexOf(key)
    return i >= 0 && e.metadata ? e.metadata[i] : undefined
  } catch { return undefined }
}

function dragonOf (bot) {
  let best = null
  for (const e of Object.values(bot.entities)) {
    if (e && e.name === 'ender_dragon' && e.position && e.isValid !== false) best = e
  }
  return best
}
function phaseOf (bot, d) { const v = d && metaOf(bot, d, 'phase'); return typeof v === 'number' ? v : null }
function hpOf (bot, d) { const v = d && metaOf(bot, d, 'health'); return typeof v === 'number' ? v : null }
// Куда смотрит голова (гориз.): в углах mineflayer (sin yaw, cos yaw).
function headDir (d) { return { x: Math.sin(d.yaw), z: Math.cos(d.yaw) } }

// История позиций дракона по тикам физики: скорость для упреждения и высоты
// «5 и 10 тиков назад», из которых игра считает наклон шеи (DragonFlightHistory).
function makeTrack (bot) {
  const hist = []
  let id = null
  return {
    tick () {
      const d = dragonOf(bot)
      if (!d) { hist.length = 0; id = null; return null }
      if (d.id !== id) { hist.length = 0; id = d.id }
      const p = d.position
      hist.push({ x: p.x, y: p.y, z: p.z, t: gameClock.now() })
      if (hist.length > 80) hist.shift()
      return d
    },
    // Средняя скорость за ~0.5 с, блоки за тик.
    vel () {
      if (hist.length < 2) return { x: 0, y: 0, z: 0 }
      const b = hist[hist.length - 1]
      let a = hist[0]
      for (let i = hist.length - 1; i >= 0; i--) { if (b.t - hist[i].t >= 500) { a = hist[i]; break } }
      const dt = (b.t - a.t) / 50
      if (dt < 0.5) return { x: 0, y: 0, z: 0 }
      return { x: (b.x - a.x) / dt, y: (b.y - a.y) / dt, z: (b.z - a.z) / dt }
    },
    yAgo (ticks) {
      if (!hist.length) return null
      const want = gameClock.now() - ticks * 50
      for (let i = hist.length - 1; i >= 0; i--) if (hist[i].t <= want) return hist[i].y
      return null
    }
  }
}

function box (cx, y, cz, half, height) {
  return { min: new Vec3(cx - half, y, cz - half), max: new Vec3(cx + half, y + height, cz + half) }
}
function inflate (b, r) {
  return { min: b.min.offset(-r, -r, -r), max: b.max.offset(r, r, r) }
}
function boxDist (p, b) {
  const dx = Math.max(b.min.x - p.x, 0, p.x - b.max.x)
  const dy = Math.max(b.min.y - p.y, 0, p.y - b.max.y)
  const dz = Math.max(b.min.z - p.z, 0, p.z - b.max.z)
  return Math.hypot(dx, dy, dz)
}
function overlap (a, b) {
  return a.min.x < b.max.x && a.max.x > b.min.x && a.min.y < b.max.y && a.max.y > b.min.y && a.min.z < b.max.z && a.max.z > b.min.z
}
function playerBox (feet) { return box(feet.x, feet.y, feet.z, 0.3, 1.8) }

// Части дракона там, где их считает сервер (EnderDragon.aiStep). Сидя наклона
// нет и голова опущена на блок; в полёте — по истории высот.
// predict {pos} — где сядет (на заходе на посадку): части как у сидящего там.
function partsOf (bot, d, track, predict = null) {
  const sit = predict ? true : SITTING.has(phaseOf(bot, d))
  let dir = headDir(d)
  // Сидя голова отстаёт от yaw на замороженный yRotA·0.01 рад (tickPart головы) —
  // угол из прогноза посадки, пока yaw тот же (видящий, повернувшись, почти не отстаёт).
  if (sit && !predict) {
    const f = sitFix.get(d.id)
    if (f && Math.abs(Math.atan2(Math.sin(d.yaw - f.yaw), Math.cos(d.yaw - f.yaw))) < 0.03) { const a = d.yaw + f.yRotA * 0.01; dir = { x: Math.sin(a), z: Math.cos(a) } }
  }
  let c = 1; let s = 0; let off = SIT_HEAD_DY
  if (!sit) {
    off = 0
    if (track) {
      const y5 = track.yAgo(5); const y10 = track.yAgo(10)
      if (y5 != null && y10 != null) { const p = (y5 - y10) * 10 * Math.PI / 180; c = Math.cos(p); s = Math.sin(p) }
      if (y5 != null) off = y5 - d.position.y
    }
  }
  const P = predict ? predict.pos : d.position
  const hx = P.x + dir.x * HEAD_AHEAD * c; const hz = P.z + dir.z * HEAD_AHEAD * c
  const nx = P.x + dir.x * NECK_AHEAD * c; const nz = P.z + dir.z * NECK_AHEAD * c
  const head = box(hx, P.y + off + s * HEAD_AHEAD, hz, 0.5, 1)
  const neck = box(nx, P.y + off + s * NECK_AHEAD, nz, 1.5, 3)
  const body = box(P.x + dir.x * 0.5, P.y, P.z + dir.z * 0.5, 2.5, 3)
  const center = b => b.min.plus(b.max).scaled(0.5)
  return { sit, dir, pos: P, head, neck, body, headC: center(head), bodyC: center(body) }
}

function isSolid (b) { return !!b && b.boundingBox === 'block' }
function isAirish (b) { return !!b && b.boundingBox === 'empty' && !/lava|water|fire|portal/.test(b.name) }

// Пустота под точкой: ни одного твёрдого блока на depth вниз. Непрогруженное —
// тоже пустота: в Энде лучше перестраховаться.
function voidBelow (bot, x, y, z, depth = 64) {
  const fx = Math.floor(x); const fz = Math.floor(z)
  for (let yy = Math.floor(y) - 1; yy >= Math.max(0, Math.floor(y) - depth); yy--) {
    const b = bot.blockAt(new Vec3(fx, yy, fz))
    if (!b) return true
    if (isSolid(b)) return false
  }
  return true
}
// Блок, на котором тело стоит на самом деле. Под центром бывает воздух: хитбокс
// (±0.3) держится за соседнюю колонку. ab-23 (30.09): после столба на платформе
// центр висел над воздухом, мост от «своей» клетки ставил блок по диагонали от
// столба — «не к чему прислонить», а следующий вызов, глядя под центр, моста не
// строил вовсе. null — под хитбоксом твёрдого нет.
// Площадка 3×3 из булыжника вокруг опоры sup (02.10): мост в блок шириной над пустотой — дальше путь с копкой, сорваться некуда.
// Бок своей опоры виден только с края: крадучись к краю (крадущегося физика с края не роняет), глаза за плоскостью грани — ставка.
// Сквозь нависший над платформой остров (02.10 вечер, ND_DIGUP=0 — выкл.): только если над нами в 6 блоках есть end_stone, а под
// ногами (или блоком под ногами) — обсидиан платформы 5×5 (y 48, x 98…102, z −2…2): к середине платформы, потом шахта 1×1 вверх:
// копать два блока над ногами (голова и выше), прыжок с блоком под себя; конец — стоим, над головой ≥ 3 воздуха, под ногами
// свой блок вровень с остовом острова рядом (сбоку end_stone на уровне ног − 1). Копать — только end_stone/свои блоки.
async function digUpThrough (session, ctl, maxUp = 24) {
  const bot = session.bot
  const out = { ok: false, dug: 0, up: 0, why: null }
  const p0 = bot.entity.position
  const ceil = (() => { for (let k = 2; k <= 7; k++) { const b = bot.blockAt(p0.floored().offset(0, k, 0)); if (b && b.name === 'end_stone') return true } return false })()
  if (!ceil) { out.why = 'над головой нет острова'; return out }
  let plat = false
  for (let k = 1; k <= 3 && !plat; k++) { const b = bot.blockAt(p0.floored().offset(0, -k, 0)); if (b && b.name === 'obsidian' && Math.abs(b.position.x - 100) <= 2 && Math.abs(b.position.z) <= 2) plat = true }
  if (!plat) { out.why = 'не на платформе'; return out }
  // к середине платформы (вокруг — обсидиан: шаг в сторону не в пустоту)
  const mid = new Vec3(100.5, p0.y, 0.5)
  if (Math.hypot(p0.x - mid.x, p0.z - mid.z) > 0.4) {
    // свой блок под ногами на краю — спуститься на платформу
    if (p0.y > 49.5) { await digDownTo(bot, ctl, 49, 3).catch(() => {}); clearControls(bot) }
    await stepTo(bot, ctl, new Vec3(100.5, bot.entity.position.y, 0.5), { ms: 3000, sprint: false, stopAt: 0.15, clouds: false })
    clearControls(bot)
  }
  if (Math.hypot(bot.entity.position.x - mid.x, bot.entity.position.z - mid.z) > 0.6) { out.why = 'к середине платформы не дошёл'; return out }
  const pick = findItem(bot, /_pickaxe$/)
  const okDig = b => b && /^(end_stone|cobblestone|cobbled_deepslate|netherrack|dirt|stone|.*_planks)$/.test(b.name)
  for (let i = 0; i < maxUp && !ctl.aborted; i++) {
    const f = bot.entity.position.floored()
    const h1 = bot.blockAt(f.offset(0, 1, 0)); const h2 = bot.blockAt(f.offset(0, 2, 0)); const h3 = bot.blockAt(f.offset(0, 3, 0))
    // вышли: над головой воздух на 3, а на ярусе ног сбоку — остров (стоим вровень с его поверхностью)
    if (isAirish(h1) && isAirish(h2) && isAirish(h3)) {
      let side = false
      for (const [dx, dz] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) { const b = bot.blockAt(f.offset(dx, -1, dz)); if (b && b.name === 'end_stone') side = true }
      if (side && i > 0) { out.ok = true; break }
    }
    // 03.10 (ca1-s10, смерть): потолок на ноги + 3 — прыжок упирался в него (ноги поднимались на ~1.2 вместо 1.25), блок под
    // себя не вставал («столб: не встал» на 2-м ярусе) — дальше путь прокопом на уровне платформы и облако в тоннеле. Копать
    // и третий блок (когда он копаемый), столб — до трёх попыток.
    for (const hb of [h1, h2, h3]) {
      if (!hb || isAirish(hb)) continue
      if (hb === h3 && !okDig(hb)) continue
      if (!okDig(hb)) { out.why = `над головой ${hb.name}`; return out }
      try { if (pick) await bot.equip(pick, 'hand'); await build.withTimeout(bot.dig(hb, true, 'raycast'), 3000); out.dug++ } catch (e) { bot.stopDigging(); out.why = 'копать: ' + e.message; return out }
    }
    let t = null
    for (let k = 0; k < 3 && !ctl.aborted; k++) {
      t = await build.towerUp(bot, ctl, 1).catch(e => ({ ok: false, reason: e.message }))
      clearControls(bot)
      if (t && t.placed) break
      out.towerRetry = (out.towerRetry || 0) + 1
      await sleep(250)
    }
    if (!t || !t.placed) { out.why = 'столб: ' + ((t && t.reason) || 'не встал'); return out }
    out.up++
  }
  if (!out.ok && !out.why) out.why = 'не вышел'
  return out
}
async function padOverVoid (bot, sup) {
  const out = { placed: 0, ok: false }
  const centre = new Vec3(sup.x + 0.5, sup.y + 1, sup.z + 0.5)
  const sideOf = d => sup.offset(d[0], 0, d[1])
  try {
    for (const d of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
      const c = sideOf(d)
      if (isSolid(bot.blockAt(c))) continue
      // к краю крадучись ~0.8 от середины опоры в сторону d
      bot.setControlState('sneak', true)
      const goal = centre.offset(d[0] * 0.8, 0, d[1] * 0.8)
      const t0 = gameClock.now()
      while (gameClock.now() - t0 < 1500) {
        const q = bot.entity.position
        if (Math.abs(q.x - goal.x) < 0.12 && Math.abs(q.z - goal.z) < 0.12) break
        await lookSafe(bot, Math.atan2(-(goal.x - q.x), -(goal.z - q.z)), -0.6)
        bot.setControlState('forward', true)
        await sleep(50)
        bot.setControlState('forward', false)
        if (bot.entity.position.y < sup.y + 0.9) break
      }
      bot.setControlState('forward', false)
      if (bot.entity.position.y < sup.y + 0.9) { out.fell = true; break }
      const r = await placeItemAt(bot, c, FILLER_RE).catch(() => ({ ok: false }))
      if (r && r.ok) out.placed++
      // назад в середину крадучись
      const t1 = gameClock.now()
      while (gameClock.now() - t1 < 1200) {
        const q = bot.entity.position
        if (Math.hypot(q.x - centre.x, q.z - centre.z) < 0.15) break
        await lookSafe(bot, Math.atan2(-(centre.x - q.x), -(centre.z - q.z)), -0.3)
        bot.setControlState('forward', true)
        await sleep(50)
        bot.setControlState('forward', false)
      }
    }
    // углы — к уже стоящим соседям, с середины
    for (const d of [[1, 1], [1, -1], [-1, 1], [-1, -1]]) {
      const c = sideOf(d)
      if (isSolid(bot.blockAt(c))) continue
      const r = await placeItemAt(bot, c, FILLER_RE).catch(() => ({ ok: false }))
      if (r && r.ok) out.placed++
    }
  } finally { clearControls(bot) }
  const sides = [[1, 0], [-1, 0], [0, 1], [0, -1]].map(sideOf)
  out.missing = sides.filter(c => !isSolid(bot.blockAt(c))).length
  out.ok = out.missing === 0 && !out.fell
  return out
}
function supportCell (bot) {
  const p = bot.entity.position
  const f = new Vec3(Math.floor(p.x), Math.floor(p.y + 0.01) - 1, Math.floor(p.z))
  if (isSolid(bot.blockAt(f))) return f
  let best = null
  for (let dx = -1; dx <= 1; dx++) {
    for (let dz = -1; dz <= 1; dz++) {
      if (!dx && !dz) continue
      const q = f.offset(dx, 0, dz)
      const cx = Math.max(q.x, Math.min(p.x, q.x + 1)); const cz = Math.max(q.z, Math.min(p.z, q.z + 1))
      if (Math.abs(cx - p.x) > 0.3 + 1e-6 || Math.abs(cz - p.z) > 0.3 + 1e-6) continue
      if (!isSolid(bot.blockAt(q))) continue
      const d = Math.hypot(q.x + 0.5 - p.x, q.z + 0.5 - p.z)
      if (!best || d < best.d) best = { q, d }
    }
  }
  return best ? best.q : null
}
// Опора не на острове: в колонке под ней до пустоты нет эндерняка, и пустота
// есть (платформа, свой мост, столб на платформе). Шип из обсидиана — до самого
// низа без пустоты, остров — эндерняк: не мост.
function offIsland (bot, sup) {
  let air = false
  for (let y = sup.y; y >= Math.max(0, sup.y - 70); y--) {
    const b = bot.blockAt(new Vec3(sup.x, y, sup.z))
    if (!b) break
    if (b.name === 'end_stone') return false
    if (!isSolid(b)) air = true
  }
  return air
}
// Нет ли рядом края (обрыва в пустоту) в радиусе r.
function nearEdge (bot, pos, r = 3) {
  for (let dx = -r; dx <= r; dx++) {
    for (let dz = -r; dz <= r; dz++) {
      if (dx * dx + dz * dz > r * r) continue
      if (voidBelow(bot, pos.x + dx, pos.y + 1, pos.z + dz, 24)) return true
    }
  }
  return false
}
// Пол колонки для шага клавишами от высоты ног feetY: ступенька вверх на блок,
// ровно или спуск не глубже depth. Возвращает высоту ног на этом полу, 'wall'
// (два блока стены — дальше не пройти, но и не упасть) или null — обрыв.
function floorAt (bot, x, feetY, z, depth = 3) {
  const fx = Math.floor(x); const fz = Math.floor(z); const fy = Math.floor(feetY + 0.01)
  const at = y => bot.blockAt(new Vec3(fx, y, fz))
  const b0 = at(fy)
  if (!b0) return null
  if (isSolid(b0)) return isSolid(at(fy + 1)) ? 'wall' : fy + 1
  for (let y = fy - 1; y >= fy - 1 - depth; y--) {
    const b = at(y)
    if (!b) return null
    if (isSolid(b)) return y + 1
  }
  return null
}
// Сколько можно пройти по прямой (ux, uz) от p: у каждой точки пути пол не
// глубже depth ниже прошлой. Расстояние до первой точки обрыва или null — до
// upto обрыва нет (или раньше стена).
function runwayAhead (bot, p, ux, uz, upto, depth = 3) {
  let y = p.y
  for (let s = 0.4; s <= upto + 1e-6; s += 0.4) {
    const f = floorAt(bot, p.x + ux * s, y, p.z + uz * s, depth)
    if (f === 'wall') return null
    if (f == null) return Math.round(s * 10) / 10
    y = f
  }
  return null
}
// Клавиши одного тика шага к target (stepTo). Обрыв смотрится на столько,
// сколько тело пролетит: пешком после отпуска клавиш — меньше блока, с разбега
// и в прыжке — до двух (в воздухе скорость гаснет лишь ×0.91 за тик). Прогон
// dtr-1-1 (2026-09-29): у края острова разбег, прыжок на ступеньку в блок
// шириной — тело пролетело её и ушло в пустоту; прежняя проверка смотрела на
// 0.9 вперёд и только «пустоту на 12 вниз». Теперь: обрыв (пол ниже трёх
// блоков) ближе блока — стоп; обрыв в 2.8 — без бега; прыжок на ступеньку —
// только если за ней до 2.3 блока пол есть.
function stepKeys (bot, p, target, { sprint = true, onGround = true, lidOver = false, portal = false, zones = null } = {}) {
  const dx = target.x - p.x; const dz = target.z - p.z
  const dist = Math.hypot(dx, dz) || 1e-9
  const ux = dx / dist; const uz = dz / dist
  const cliff = runwayAhead(bot, p, ux, uz, Math.min(2.8, dist + 0.6))
  if (cliff != null && cliff <= 1.0) return { stop: 'впереди обрыв', cliff }
  if (zones && zones.length) {
    const s1 = Math.min(1.0, dist)
    const fl = floorAt(bot, p.x + ux * s1, p.y, p.z + uz * s1)
    const z = stepIntoZone(zones, p, new Vec3(p.x + ux * s1, typeof fl === 'number' ? fl : p.y, p.z + uz * s1))
    if (z) return { stop: `впереди ${z.kind}`, zone: z }
  }
  const ax = p.x + ux * 0.9; const az = p.z + uz * 0.9
  // Шаг в выходной портал (или шлюз) уносит из Энда — только если туда и шли.
  if (!portal && nearPortal(new Vec3(ax, p.y, az)) && !nearPortal(p)) return { stop: 'впереди чаша портала' }
  if (!portal) {
    const pb = bot.blockAt(new Vec3(Math.floor(ax), Math.floor(p.y), Math.floor(az)))
    const pb2 = bot.blockAt(new Vec3(Math.floor(ax), Math.floor(p.y) - 1, Math.floor(az)))
    if ((pb && /end_portal|end_gateway/.test(pb.name)) || (pb2 && /^end_portal$/.test(pb2.name))) return { stop: 'впереди портал' }
  }
  const front = bot.blockAt(new Vec3(Math.floor(ax), Math.floor(p.y), Math.floor(az)))
  // Цель рядом и на нашем ярусе — блок «в 0.9 впереди» уже за ней (стенка за целью): не прыгать (02.10, fr1-s18: точная
  // доводка к клетке у обода чаши — каждый шаг прыжком, тело запрыгивало на обод — «к столбику не дошёл» 83 раза за серию).
  const nearSame = dist < 0.9 && typeof target.y === 'number' && target.y <= p.y + 0.5
  const jump = !nearSame && isSolid(front) && onGround && !lidOver && (cliff == null || cliff > 2.3)
  return { stop: null, cliff, sprint: !!sprint && dist > 2.5 && cliff == null, jump, yaw: Math.atan2(-dx, -dz) }
}
// Прочь от точки удара по прямой, когда чистой клетки рядом нет (evade):
// направления от удара (±0.6, ±1.2 рад) и к центру острова, дальние цели
// первыми; путь — весь по земле (runwayAhead), цель — не у края, и дальше от
// удара хотя бы на 2. Нет такого — null: стоять и принять облако (рефлекс
// поставит блок под себя) дешевле пустоты (dtr-1-1: цель за выемкой «не у
// края», путь к ней — через пустоту).
function straightOut (bot, me, away, lens = [10, 7, 5, 3.5]) {
  const d0 = Math.hypot(me.x - away.x, me.z - away.z)
  const base = Math.atan2(me.z - away.z, me.x - away.x)
  const dirs = [0, 0.6, -0.6, 1.2, -1.2].map(t => base + t)
  dirs.push(Math.atan2(CENTER.z - me.z, CENTER.x - me.x))
  let best = null
  for (const a of dirs) {
    const ux = Math.cos(a); const uz = Math.sin(a)
    for (const L of lens) {
      if (runwayAhead(bot, me, ux, uz, L + 0.6) != null) continue
      const t = me.offset(ux * L, 0, uz * L)
      if (!straightWalkable(bot, me, t, cloudZones(bot))) continue
      if (nearEdge(bot, t, 2) || nearPortal(t)) continue
      const gain = Math.hypot(t.x - away.x, t.z - away.z) - d0
      if (gain < 2) continue
      if (!best || gain > best.gain) best = { t, gain }
      break
    }
  }
  return best ? best.t : null
}
// Чаша выходного портала: bedrock-кольцо радиуса 3 вокруг центра, порталы —
// внутри на уровне кольца. Воронка от взрыва у края или соскальзывание с
// кольца — и хитбокс в плите портала (прогон 2026-09-25: тело ушло в верхний
// мир посреди воскрешения и погибло там от эндерменов ночью). Ходьба и шаги
// в Энде обходят круг 3.8 от центра ниже y 63 (плита портала — 61.4–61.75,
// кольцо — до 62; верх фонтана и яйцо — выше).
function nearPortal (pos) {
  return Math.hypot(pos.x - CENTER.x, pos.z - CENTER.z) < 3.8 && pos.y < 63
}
// Поверхность колонки: первый твёрдый блок сверху (в Энде над землёй пещер
// нет — только обелиски и наши мосты). Возвращает высоту ног и что под ними.
function surfaceY (bot, x, z, from = 110) {
  const fx = Math.floor(x); const fz = Math.floor(z)
  for (let y = from; y >= 1; y--) {
    const b = bot.blockAt(new Vec3(fx, y, fz))
    if (!b) return null
    if (isSolid(b)) return { y: y + 1, name: b.name }
    if (!isAirish(b) && b.name !== 'air') return null
  }
  return null
}
// Где можно стоять в колонке x,z около высоты nearY: твёрдое под ногами, два
// блока воздуха. Возвращает высоту ног или null.
function standY (bot, x, z, nearY, up = 8, down = 14) {
  const fx = Math.floor(x); const fz = Math.floor(z)
  for (let y = Math.floor(nearY) + up; y >= Math.floor(nearY) - down; y--) {
    const under = bot.blockAt(new Vec3(fx, y - 1, fz))
    if (!under) continue
    if (!isSolid(under)) continue
    if (isAirish(bot.blockAt(new Vec3(fx, y, fz))) && isAirish(bot.blockAt(new Vec3(fx, y + 1, fz)))) return y
  }
  return null
}

// Кристаллы, которые видно. Клетка — прутья вокруг на уровне кристалла.
function cageBars (bot, cx, top, cz) {
  const out = []
  for (let dy = 0; dy <= 3; dy++) {
    for (let dx = -2; dx <= 2; dx++) {
      for (let dz = -2; dz <= 2; dz++) {
        if (Math.abs(dx) !== 2 && Math.abs(dz) !== 2 && dy !== 3) continue
        const p = new Vec3(cx + dx, top + dy, cz + dz)
        const b = bot.blockAt(p)
        if (b && b.name === 'iron_bars') out.push(p)
      }
    }
  }
  return out
}
function crystalsOf (bot) {
  const out = []
  for (const e of Object.values(bot.entities)) {
    if (!e || e.name !== 'end_crystal' || !e.position || e.isValid === false) continue
    const cx = Math.floor(e.position.x); const cz = Math.floor(e.position.z)
    const top = Math.floor(e.position.y) - 1
    out.push({
      e,
      id: e.id,
      pos: e.position.clone(),
      aim: e.position.offset(0, 1, 0),
      cx,
      cz,
      top,
      bars: cageBars(bot, cx, top, cz).length,
      pillar: Math.hypot(e.position.x - CENTER.x, e.position.z - CENTER.z) > 20
    })
  }
  return out
}

// ------------------------------------------------------------ облака на пути
// Одна проверка пути для всех ходов в бою (2026-09-30): облака (с запасом на рост —
// облако фаербола растёт 3 → 7 за 30 с) и места падения летящих фаерболов (облако
// переедет на того, кто ближе 4 блоков к точке удара). Облака — главная причина
// смертей в сериях d4–d14n (12 из 34): ходьба сквозь свежее облако к голове, от
// головы, к месту у фонтана, на отдых. Её зовут stepTo (каждый тик — клетка на
// блок вперёд), walkTo (узлы пути впереди; путь через облако — заново) и цена
// шага pathfinder'а.
const zoneCache = { t: 0, z: [], bot: null }
function cloudZones (bot) {
  const now = gameClock.now()
  if (zoneCache.bot === bot && now - zoneCache.t < 100) return zoneCache.z
  const out = zonesOf(cloudsOf(bot), fireballsOf(bot))
  zoneCache.t = now; zoneCache.z = out; zoneCache.bot = bot
  return out
}
// Зоны из списков облаков и фаерболов (для проверок пути по снимку опасностей).
function zonesOf (clouds, fireballs = []) {
  const out = []
  for (const c of clouds) out.push({ x: c.pos.x, y: c.pos.y, z: c.pos.z, r: c.r + 0.8, kind: 'облако', id: c.e ? c.e.id : null })
  for (const f of fireballs) {
    const at = f.line ? f.ground : f.at
    if (at && f.ticks < 60) out.push({ x: at.x, y: at.y, z: at.z, r: FIREBALL_SNAP + 1.5, kind: 'место фаербола', fb: true, id: f.e ? f.e.id : null })
  }
  return out
}
function inZone (z, feet, grow = 0) {
  if (Math.hypot(feet.x - z.x, feet.z - z.z) > z.r + grow) return false
  if (z.fb) return Math.abs(feet.y - z.y) < 3.5
  return feet.y < z.y + CLOUD_SLAB && feet.y + 1.8 > z.y
}
// Шаг из here в next: нельзя войти в зону, в которой не стоим, и нельзя идти
// вглубь той, в которой стоим (из неё — только наружу).
function stepIntoZone (zones, here, next) {
  for (const z of zones) {
    if (!inZone(z, next)) continue
    if (!inZone(z, here)) return z
    if (Math.hypot(next.x - z.x, next.z - z.z) < Math.hypot(here.x - z.x, here.z - z.z) - 0.05) return z
  }
  return null
}
// Стоит над облаком: оно под нами в своём радиусе, а мы на блок выше его коробки.
function overCloud (bot) {
  const me = bot.entity.position
  return cloudsOf(bot).some(c => Math.hypot(me.x - c.pos.x, me.z - c.pos.z) < c.r + 1 && me.y >= c.pos.y + CLOUD_SLAB - 0.01 && me.y < c.pos.y + 3)
}
function cloudsOf (bot) {
  const out = []
  for (const e of Object.values(bot.entities)) {
    if (!e || e.name !== 'area_effect_cloud' || !e.position || e.isValid === false) continue
    const r = metaOf(bot, e, 'radius')
    if (!cloudBorn.has(e.id)) cloudBorn.set(e.id, gameClock.now())
    out.push({ e, pos: e.position, r: typeof r === 'number' && r > 0 ? r : 3 })
  }
  return out
}
// Заденет ли облако того, кто стоит ногами в feet (AreaEffectCloud: коробка
// облака высотой 0.5, потом центр игрока в радиусе по горизонтали).
function cloudHits (c, feet, margin = 0.7) {
  const h = Math.hypot(feet.x - c.pos.x, feet.z - c.pos.z)
  if (h > c.r + margin) return false
  return feet.y < c.pos.y + CLOUD_SLAB && feet.y + 1.8 > c.pos.y
}
function inClouds (clouds, feet, margin) { return clouds.find(c => cloudHits(c, feet, margin)) || null }

// Где встанет облако сидячего огня, если огонь начнётся сейчас
// (DragonSittingFlamingPhase.doServerTick, тик 10).
function breathOf (bot, d, parts) {
  const hc = parts.headC
  const cx = hc.x + parts.dir.x * BREATH_AHEAD
  const cz = hc.z + parts.dir.z * BREATH_AHEAD
  let y = Math.floor(parts.head.min.y + 0.5)
  for (; y > 0; y--) {
    const b = bot.blockAt(new Vec3(Math.floor(cx), y, Math.floor(cz)))
    if (!b) break
    if (b.name !== 'air' && b.name !== 'cave_air' && b.name !== 'void_air') break
  }
  return { pos: new Vec3(cx, y + 1, cz), r: BREATH_R, predicted: true, column: { x: Math.floor(cx), z: Math.floor(cz) } }
}

// ------------------------------------------------------------ эндермены

// Смотрит ли бот (с таким взглядом) эндермену в глаза. Условие игры с запасом
// ×3 на задержку: у дальнего эндермена конус узкий, у ближнего — широкий.
function starer (bot, yaw, pitch, tol = STARE_TOL * STARE_MARGIN) {
  const eye = bot.entity.position.offset(0, EYE, 0)
  const lx = -Math.sin(yaw) * Math.cos(pitch); const ly = Math.sin(pitch); const lz = -Math.cos(yaw) * Math.cos(pitch)
  for (const e of Object.values(bot.entities)) {
    if (!e || e.name !== 'enderman' || !e.position) continue
    const tx = e.position.x - eye.x; const ty = e.position.y + ENDERMAN_EYE - eye.y; const tz = e.position.z - eye.z
    const len = Math.hypot(tx, ty, tz)
    if (len > 64 || len < 0.3) continue
    if ((lx * tx + ly * ty + lz * tz) / len > 1 - tol / len) return e
  }
  return null
}
// Наклон, при котором никому не смотрим в глаза: сначала ниже, потом выше.
function safePitch (bot, yaw, pitch) {
  if (!starer(bot, yaw, pitch)) return pitch
  for (const d of [0.1, 0.2, 0.35, 0.5, 0.7, 0.95, 1.2]) {
    const p = Math.max(-1.55, pitch - d)
    if (!starer(bot, yaw, p)) return p
  }
  for (const d of [0.15, 0.3, 0.5]) {
    const p = Math.min(1.55, pitch + d)
    if (!starer(bot, yaw, p)) return p
  }
  return -1.55
}
// Сторож взгляда: каждый тик физики, до отправки пакета (physics.js шлёт взгляд
// сразу после события physicsTick), опускает голову, если взгляд упёрся в глаза.
function lookGuard (bot, stats) {
  const onTick = () => {
    if (!bot.entity) return
    const y = bot.entity.yaw; const p = bot.entity.pitch
    if (!starer(bot, y, p)) return
    const np = safePitch(bot, y, p)
    stats.guarded = (stats.guarded || 0) + 1
    bot.look(y, np, true).catch(() => {})
  }
  bot.on('physicsTick', onTick)
  return () => bot.removeListener('physicsTick', onTick)
}
// Сторож падения: крыло дракона бросает на 4 блока за тик вбок и +0.2 вверх
// (EnderDragon.knockBack), со столба у клетки падать двадцать блоков. Ведро
// воды под ноги в последний момент. Почему это надёжно (исходники 1.21.11):
// Entity.move, пройдя за шаг блок и больше, пускает луч по пути с
// ClipContext.Fluid.WATER и сбрасывает fallDistance, если луч задел воду, —
// сервер делает этот move по нашему пакету позиции (handleMovePlayer →
// player.move), так что вода в клетке над землёй гасит падение даже на
// скорости, с которой тело за тик проскакивает её насквозь.
// Когда лить (BucketItem.use: луч от глаз на 4.5 по той позиции, что сервер
// уже знает): раньше ведро шло в том же тике до пакета позиции, сервер
// считал луч от позиции ПРОШЛОГО тика, и на скорости больше 1.35 блока за тик
// (падение с 20+ блоков) окна «прошлая позиция в 2.7 от земли, а тело ещё не
// на земле» могло не случиться вовсе. Теперь ведро уходит после пакета этого
// тика (physicsTick → setImmediate: пакет позиции пишется сразу после
// события), и условие — по нынешней позиции: ноги не выше 2.75 над землёй и
// ещё не на ней. Потом воду — обратно в ведро. Без ведра — медленное падение,
// если его можно выпить (1.6 с: только когда падать долго).
// Не setImmediate, а сразу после пакета позиции этого тика (afterPositionPacket):
// под нагрузкой mineflayer догоняет до 4 тиков физики подряд в одном проходе
// цикла событий (physics.js: PHYSICS_CATCHUP_TICKS), и setImmediate уходил после
// пакетов всех — тело «приземлялось» у сервера раньше, чем приходило ведро:
// dtr-2-1 (30.09 00:39, ферма под полной нагрузкой) — два прыжка со столба у
// клетки, вода «вылита» оба раза, падение −17 и смерть.
function fallGuard (bot, stats, ctl = null) {
  const ev = (k, o) => { if (ctl && ctl.trace) ctl.trace.ev(k, o) }
  let peak = null
  let placed = null
  let steering = false
  let drinking = false
  const hotbar = name => bot.inventory.slots.findIndex((it, i) => i >= 36 && i <= 44 && it && it.name === name)
  const onTick = () => {
    const e = bot.entity
    if (!e || !e.position) return
    const p = e.position
    // Приземлились в свою воду — забрать её назад, пустым ведром вниз.
    if (placed && (e.onGround || e.isInWater)) {
      // Приземлились — высота падения с нуля: иначе старая вершина жила, пока
      // не заберём воду, и после подбора первое же «в воздухе» (выход из воды)
      // считалось падением в 10 блоков — второе ведро впритык, вода не
      // вернулась, ведро пустое до конца боя (c2-27, 30.09, 213 с → 252 с:
      // падение со столба у клетки без ведра, смерть).
      peak = null
      if (!placed.landed) { placed.landed = true; const w0 = bot.blockAt(placed.pos); ev('clutchLand', { y: r1(p.y), x: r1(p.x), z: r1(p.z), at: [placed.pos.x, placed.pos.y, placed.pos.z], block: w0 ? w0.name : null, water: !!e.isInWater, hp: r1(bot.health ?? 0) }) }
      if (gameClock.now() - placed.t > 3000) { placed = null; return }
      if (placed.picking) return
      const w = bot.blockAt(placed.pos)
      if (!w || w.name !== 'water') { if (gameClock.now() - placed.t > 600) placed = null; return }
      const b = hotbar('bucket')
      if (b < 0) return
      // Взгляд — на середину источника (не прямо вниз): отнесло на блок — и луч
      // вниз шёл мимо воды, ведро оставалось пустым до следующего падения
      // (d9-4, 30.09: восемь попыток мимо, следующий сброс со столба — смерть).
      const eyeW = e.position.offset(0, EYE, 0)
      if (eyeW.distanceTo(placed.pos.offset(0.5, 0.5, 0.5)) > 4.3) { if (gameClock.now() - placed.t > 600) placed = null; return }
      placed.picking = true
      if (bot.quickBarSlot !== b - 36) bot.setQuickBarSlot(b - 36)
      const at = placed
      const aimW = () => {
        const q = e.position.offset(0, EYE, 0)
        const tx = at.pos.x + 0.5 - q.x; const ty = at.pos.y + 0.5 - q.y; const tz = at.pos.z + 0.5 - q.z
        const h = Math.hypot(tx, tz)
        if (h < 0.25) { e.pitch = -Math.PI / 2; return }
        e.yaw = Math.atan2(-tx, -tz); e.pitch = Math.atan2(ty, h)
      }
      aimW()
      afterPositionPacket(bot, () => {
        aimW()
        bot.activateItem()
        stats.clutch.pickedUp = (stats.clutch.pickedUp || 0) + 1
        gameClock.setTimeout(() => {
          if (placed !== at) return
          const w2 = bot.blockAt(at.pos)
          if (w2 && w2.name === 'water') at.picking = false
          else placed = null
        }, 400)
      })
      return
    }
    if (e.onGround || e.isInWater) { peak = null; stats.clutch.noBucketAt = 0; return }
    if (peak == null || p.y > peak) peak = p.y
    if (e.velocity.y > -0.25) return
    let gy = null
    for (let y = Math.floor(p.y); y >= Math.floor(p.y) - 48 && y >= -64; y--) {
      const b = bot.blockAt(new Vec3(Math.floor(p.x), y, Math.floor(p.z)))
      if (!b) return
      if (/water/.test(b.name)) return
      if (isSolid(b)) { gy = y + 1; break }
    }
    if (gy == null) {
      if (peak - p.y > 4 && !placed) { placed = { t: gameClock.now(), pos: new Vec3(0, -999, 0) }; stats.clutch.void = (stats.clutch.void || 0) + 1 }
      return
    }
    const fall = peak - gy
    // Урон падения — fallDistance − 3; до 4 хп терпимо, дальше — спасаться.
    if (fall < 7 || placed) return
    const wb = hotbar('water_bucket')
    if (wb >= 0) {
      // Приземлится тело на самую высокую из колонок под хитбоксом (0.6): краем
      // на соседней, более высокой, — встаёт на неё, и путь центра до воды в
      // своей колонке не доходит (сцена cage-1, 30.09 00:56: вода на 60 под
      // центром, приземлился на 61 соседней — падение −16; так же d3-24, d3-28,
      // d4-17, d4-22: смерти на спуске со столба у клетки). Цель — эта колонка:
      // в воздухе клавиши к её середине (центр — над ней), вода — на её верх.
      let land = null
      for (const [ox, oz] of [[0, 0], [-0.3, -0.3], [-0.3, 0.3], [0.3, -0.3], [0.3, 0.3]]) {
        const x = Math.floor(p.x + ox); const z = Math.floor(p.z + oz)
        if (land && land.x === x && land.z === z) continue
        for (let y = Math.floor(p.y); y >= gy - 1; y--) {
          const b = bot.blockAt(new Vec3(x, y, z))
          if (b && isSolid(b)) { if (!land || y + 1 > land.top) land = { x, z, top: y + 1 }; break }
        }
      }
      if (!land) land = { x: Math.floor(p.x), z: Math.floor(p.z), top: gy }
      const cx = land.x + 0.5; const cz = land.z + 0.5
      const off = Math.hypot(cx - p.x, cz - p.z)
      if (off > 0.08) {
        e.yaw = Math.atan2(-(cx - p.x), -(cz - p.z))
        bot.setControlState('forward', true)
        bot.setControlState('sprint', false)
        steering = true
      } else if (steering) { bot.setControlState('forward', false); steering = false }
      const gyBox = land.top
      const above = p.y - gyBox
      if (above > 2.75 || above < 0.02) return
      if (land.x !== Math.floor(p.x) || land.z !== Math.floor(p.z)) stats.clutch.uneven = (stats.clutch.uneven || 0) + 1
      steering = false
      // pathfinder в полёте (шли, и крылом подбросило) держит в руке блок
      // для моста и сам его перекладывает — ведро уходило бы булыжником
      // (сцена clutch 2026-09-26: «вылил», а в клетке воздух, смерть с 28
      // блоков). Путь — стоп, руку — ведру, и ещё раз прямо перед пакетом.
      try { bot.pathfinder.setGoal(null) } catch {}
      clearControls(bot)
      if (bot.quickBarSlot !== wb - 36) bot.setQuickBarSlot(wb - 36)
      placed = { t: gameClock.now(), pos: new Vec3(land.x, gyBox, land.z) }
      stats.clutch.water = (stats.clutch.water || 0) + 1
      stats.clutch.above = r1(above)
      ev('clutch', { y: r1(p.y), x: r1(p.x), z: r1(p.z), gy: gyBox, land: [land.x, land.z], above: r1(above), vy: r1(e.velocity.y), vx: +e.velocity.x.toFixed(2), vz: +e.velocity.z.toFixed(2), held: bot.heldItem ? bot.heldItem.name : null, fall: r1(fall) })
      // Взгляд — на верх колонки приземления (центр над ней — прямо вниз), до
      // пакета позиции этого тика (уйдёт в нём же).
      const aim = () => {
        const eye = e.position.offset(0, EYE, 0)
        const tx = land.x + 0.5 - eye.x; const ty = gyBox - eye.y; const tz = land.z + 0.5 - eye.z
        const h = Math.hypot(tx, tz)
        if (h < 0.3) { e.pitch = -Math.PI / 2; return }
        e.yaw = Math.atan2(-tx, -tz); e.pitch = Math.atan2(ty, h)
      }
      aim()
      afterPositionPacket(bot, () => {
        const slot = hotbar('water_bucket')
        if (slot >= 0 && bot.quickBarSlot !== slot - 36) bot.setQuickBarSlot(slot - 36)
        aim()
        bot.activateItem()
        ev('clutchUse', { y: r1(e.position.y), held: bot.heldItem ? bot.heldItem.name : null })
        dbg('clutch water', 'fall', fall.toFixed(1), 'above', above.toFixed(2), 'v', e.velocity.y.toFixed(2), 'at', placed && placed.pos.toString(), 'held', bot.heldItem && bot.heldItem.name)
      })
      return
    }
    // Ведра в хотбаре нет: свидетель для разбора (e2e3, 303 с: падение с 23
    // блоков без попытки ведра) — где оно было в этот миг.
    if (peak - p.y > 3 && !stats.clutch.noBucketAt) {
      stats.clutch.noBucketAt = gameClock.now()
      const where = bot.inventory.slots.map((it, k) => it && /bucket/.test(it.name) ? `${k}:${it.name}` : null).filter(Boolean)
      stats.clutch.noBucket = (stats.clutch.noBucket || 0) + 1
      ev('noBucket', { where, held: bot.heldItem ? bot.heldItem.name : null, fall: r1(fall) })
      dbg('clutch: в хотбаре нет ведра воды', JSON.stringify(where), 'в руке', bot.heldItem && bot.heldItem.name, 'падать', fall.toFixed(1))
    }
    if (!drinking && fall > 12 && !hasEffect(bot, 'slow_falling')) {
      const pot = potionItem(bot, 'slow_falling', { splash: false })
      if (!pot) return
      drinking = true
      stats.clutch.slowFalling = (stats.clutch.slowFalling || 0) + 1
      bot.equip(pot, 'hand').then(() => bot.consume()).catch(() => {}).finally(() => { drinking = false })
    }
  }
  stats.clutch = stats.clutch || {}
  bot.on('physicsTick', onTick)
  return () => bot.removeListener('physicsTick', onTick)
}
// Выполнить fn сразу после ближайшего пакета позиции/взгляда (его пишет
// mineflayer в конце тика физики, после события physicsTick). Запасной путь —
// через 120 мс, если пакета нет (стоим, позиция не менялась).
function afterPositionPacket (bot, fn) {
  const c = bot._client
  if (!c._ndAfterPos) {
    c._ndAfterPos = []
    const orig = c.write
    c.write = function (name) {
      const r = orig.apply(this, arguments)
      if (c._ndAfterPos.length && (name === 'position' || name === 'position_look' || name === 'look' || name === 'flying')) {
        const q = c._ndAfterPos.splice(0)
        for (const f of q) { try { f() } catch {} }
      }
      return r
    }
  }
  let done = false
  const once = () => { if (done) return; done = true; fn() }
  c._ndAfterPos.push(once)
  gameClock.setTimeout(() => { const i = c._ndAfterPos.indexOf(once); if (i >= 0) c._ndAfterPos.splice(i, 1); once() }, 120)
}
// Рефлекс облака: ноги в облаке (фаербол, огонь) — блок под себя тут же, чем
// бы ни было занято тело. Облако высотой полблока (AreaEffectCloud), на блок
// выше — мимо. Раньше уход от облака жил только в проверках между шагами, а
// шаг бывает долгим (копка, путь, столб): camp2/camp3 (2026-09-27) — три
// смерти подряд по 4–5 ударов облака фаербола, тело «занято» (мост, эндерняк,
// воронка). Реагирует через 100 мс в облаке старше 0.3 с (бьёт с 1 с, а
// прыжок на блок — ~6 тиков; было «старше 0.7 с + 150 мс» — столб вставал к
// 1.15 с, уже после удара: dtr-1-2, 76 с, −6). Пока идёт уход (evade) — как
// раньше, с 0.7 с: уход сам решает, бежать или встать на блок.
// Докуда подняться, чтобы облако c не задевало: ноги не ниже его верха (y + 0.5).
function aboveCloudY (me, c) {
  return Math.max(Math.floor(me.y + 0.01) + 1, Math.ceil(c.pos.y + CLOUD_SLAB - 0.01))
}
// Тревога фаербола (01.10, st3: s4, s6, s18 — точка падения в 1–2 бл. от бота за 1.4–2.4 с, а бот ещё 2–8 с стоял в
// стройке, окопе или еде: опасность проверяли только между шагами — смерть в облаке). Снаряд, что ляжет в ≤ FB_ALARM_R
// от нас (или прямо в нас) за ≤ 60 тиков, — сразу прервать текущее дело (путь, копание, еду, клавиши); уводит бой (evade).
// Длинные шаги (standAt, placeItemAt, tsTrench, heal) смотрят fbAlarm и выходят. ND_FB_ALARM=0 — выкл.
const FB_ALARM_R = Number(process.env.ND_FB_ALARM_R ?? 5)
const fbAlarmAt = new WeakMap()
function fbAlarm (bot) { const a = fbAlarmAt.get(bot); return a && gameClock.now() < a.until ? a : null }
function fireballAlarm (bot, ctl, stats) {
  if (process.env.ND_FB_ALARM === '0') return () => {}
  const seen = new Set()
  const iv = gameClock.setInterval(() => {
    try {
      const e = bot.entity
      if (!e || !e.position || ctl.aborted) return
      const me = e.position
      for (const fb of fireballsOf(bot)) {
        if (!fb.at || fb.ticks > 60) continue
        const h = Math.hypot(fb.at.x - me.x, fb.at.z - me.z)
        if (!fb.direct && !(h < FB_ALARM_R && Math.abs(fb.at.y - me.y) < 4)) continue
        fbAlarmAt.set(bot, { t: gameClock.now(), until: gameClock.now() + fb.ticks * 50 + 800, at: fb.at, id: fb.e.id })
        if (seen.has(fb.e.id)) continue
        seen.add(fb.e.id)
        if (seen.size > 200) seen.clear()
        stats.fbAlarm = (stats.fbAlarm || 0) + 1
        if (ctl.trace) ctl.trace.ev('fbAlarm', { id: fb.e.id, h: r1(h), ticks: fb.ticks, direct: !!fb.direct, doing: ctl.doing, evading: !!ctl.evading })
        // уход — дело боя; мост/край (крадучись, далеко от центра) не трогать: отпущенный «крадучись» на краю — падение
        if (ctl.evading || bot.getControlState('sneak') || Math.hypot(me.x - CENTER.x, me.z - CENTER.z) > 40) continue
        try { if (bot.pathfinder) bot.pathfinder.setGoal(null) } catch {}
        try { bot.stopDigging() } catch {}
        try { bot.deactivateItem() } catch {}
        clearControls(bot)
      }
    } catch {}
  }, 100)
  return () => gameClock.clearInterval(iv)
}
function cloudReflex (bot, ctl, stats) {
  let inSince = 0
  let busy = false
  const onTick = () => {
    const e = bot.entity
    if (busy || !e || !e.position || !e.onGround || ctl.aborted) { if (!busy) inSince = 0; return }
    // Стоим на месте у кроватей (двойная станция) с запасом хп — не лезть на блок:
    // подъём ломает щелчок поверх стенки, а облако — 3 в секунду.
    if (ctl.holdStation && bot.health >= 12) { inSince = 0; return }
    const me = e.position
    const age = ctl.evading ? 700 : 300
    const c = cloudsOf(bot).find(k => cloudHits(k, me, 0.2) && cloudAgeMs(k) > age)
    if (!c) { inSince = 0; return }
    if (!inSince) { inSince = gameClock.now(); return }
    if (gameClock.now() - inSince < 100) return
    if (!bot.inventory.items().some(i => FILLER_RE.test(i.name))) return
    if (!isAirish(bot.blockAt(me.floored().offset(0, 2, 0)))) return
    busy = true
    stats.dodges.рефлекс = (stats.dodges.рефлекс || 0) + 1
    if (ctl.trace) ctl.trace.ev('reflex', { at: [r1(me.x), r1(me.y), r1(me.z)], cloud: c.e.id, r: r1(c.r) })
    const toY = aboveCloudY(me, c)
    ;(async () => {
      try {
        try { bot.stopDigging() } catch {}
        try { bot.pathfinder.setGoal(null) } catch {}
        clearControls(bot)
        await fastTower(bot, ctl, toY, { maxMs: 1500 })
      } catch {} finally { busy = false; inSince = 0 }
    })()
  }
  bot.on('physicsTick', onTick)
  return () => bot.removeListener('physicsTick', onTick)
}

// Ведро опустело (вода не вернулась после падения) — набрать из своей же лужи
// рядом: без ведра спуск со столба у клетки — копкой, а сброс — насмерть
// (c2-27, 30.09: ведро пустое с 213 с, на 252 с падение с 21 блока).
async function refillBucket (session, ctl, stats) {
  const bot = session.bot
  if (findItem(bot, /^water_bucket$/)) return true
  const empty = findItem(bot, /^bucket$/)
  if (!empty) return false
  const me = bot.entity.position
  const srcs = bot.findBlocks({ matching: b => !!b && b.name === 'water' && b.metadata === 0, maxDistance: 24, count: 12 })
    .sort((a, b) => a.distanceTo(me) - b.distanceTo(me))
  const clouds = cloudsOf(bot)
  for (const w of srcs.slice(0, 4)) {
    if (ctl.aborted) break
    doing(ctl, 'refill')
    // Встать рядом с водой (не в ней): клетка в 1–3 блоках, на земле, не в облаке.
    let spot = null
    for (let r = 1; r <= 3 && !spot; r++) {
      for (const [dx, dz] of [[r, 0], [-r, 0], [0, r], [0, -r], [r, r], [-r, r], [r, -r], [-r, -r]]) {
        const y = standY(bot, w.x + dx + 0.5, w.z + dz + 0.5, w.y, 2, 3)
        if (y == null) continue
        const feet = new Vec3(w.x + dx + 0.5, y, w.z + dz + 0.5)
        if (inClouds(clouds, feet, 1) || nearEdge(bot, feet, 2)) continue
        spot = feet; break
      }
    }
    if (!spot) continue
    if (spot.distanceTo(bot.entity.position) > 1.2) {
      const wk = await walkTo(session, ctl, spot, { range: 1, timeoutMs: 12000 })
      if (!wk.ok) continue
    }
    const b = findItem(bot, /^bucket$/)
    if (!b) break
    try {
      await bot.equip(b, 'hand')
      await bot.lookAt(w.offset(0.5, 0.5, 0.5), true)
      bot.activateItem()
    } catch (e) { dbg('refill', e.message) }
    const t0 = gameClock.now()
    while (!findItem(bot, /^water_bucket$/) && gameClock.now() - t0 < 800) await sleep(50)
    const ok = !!findItem(bot, /^water_bucket$/)
    stats.refill = (stats.refill || 0) + (ok ? 1 : 0)
    if (ctl.trace) ctl.trace.ev('refill', { at: [w.x, w.y, w.z], ok })
    if (ok) { await waterToHotbar(bot); const wpn = items.bestWeapon(bot); if (wpn) await bot.equip(wpn, 'hand').catch(() => {}); return true }
  }
  return false
}

// Ведро воды — в хотбар заранее: в падении на перекладку из рюкзака (клик в
// окне) времени нет, есть только смена слота.
async function waterToHotbar (bot) {
  const i = bot.inventory.slots.findIndex((it, k) => k >= 36 && k <= 44 && it && it.name === 'water_bucket')
  if (i >= 0) return true
  const wb = findItem(bot, /^water_bucket$/)
  if (!wb) return false
  // Не через equip: тот меняет местами с выбранным слотом, и «взять меч
  // обратно» уносит ведро назад в рюкзак (прогон: ведро так и не попало в
  // хотбар, тело разбилось с 30 блоков). Пустой слот хотбара или самый
  // дешёвый (не оружие, не лук, не кирка) и не тот, что в руке.
  const sel = 36 + bot.quickBarSlot
  const keep = /sword|axe|bow|pickaxe|golden_apple|_bed$|potion/
  let dest = -1
  for (let k = 36; k <= 44; k++) if (k !== sel && !bot.inventory.slots[k]) { dest = k; break }
  if (dest < 0) for (let k = 36; k <= 44; k++) if (k !== sel && !keep.test(bot.inventory.slots[k].name)) { dest = k; break }
  if (dest < 0) return false
  try { await bot.moveSlotItem(wb.slot, dest) } catch (e) { dbg('water to hotbar', e.message) }
  return bot.inventory.slots.some((it, k) => k >= 36 && k <= 44 && it && it.name === 'water_bucket')
}

// Кто нас бьёт: пакет damage_event несёт id причины урона (+1, 0 — никто).
// «Злой» (creepy) эндермен — не обязательно злой НА НАС: облако дракона ранит
// эндерменов, и их цель — дракон. Ударить такого — сделать его своим врагом
// (прогоны 2026-09-25: три-четыре драки за бой, в железе — смерть). Драться
// только с тем, кто бил нас сам за последние 6 с, или кто уже вплотную.
const hitBy = new Map()
function hitTracker (bot) {
  const f = (pk) => {
    // Только прямой удар (кто бил, тот и ударил): облако огня или фаербола несёт
    // причиной дракона, а прямым — само облако; такое «дракон нас ударил» уводило
    // тело от головы на всю посадку (c1-27, 30.09: дракон с 1.3 хп сидел 45 с,
    // тело ушло после облака на 3 и так и стояло в стороне).
    if (bot.entity && pk && pk.entityId === bot.entity.id && pk.sourceCauseId > 0 && (!pk.sourceDirectId || pk.sourceDirectId === pk.sourceCauseId)) hitBy.set(pk.sourceCauseId - 1, gameClock.now())
  }
  bot._client.on('damage_event', f)
  return () => bot._client.removeListener('damage_event', f)
}
// ------------------------------------------------------------ трасса
// ND_DRAGON_TRACE=<папка> — каждый вызов пишет <папка>/dragon-<время>.jsonl:
// срез раз в 250 мс (тело, хп, дракон, облака рядом, чем занято тело) и
// события (урон с типом из damage_event, смена фазы, новое облако, смерть).
// Свидетель разбора смертей (2026-09-26): сервер пишет только «killed by
// Ender Dragon using magic» — и облако фаербола, и облако сидячего огня
// принадлежат дракону, а что тело делало в тот момент, лог не знает.
// Типы урона — номер в реестре damage_type, реестр по алфавиту имён
// (data/minecraft/damage_type/*.json в server-1.21.11.jar; как и реестр чар —
// SPEEDRUN.md): 1 кровать, 9 взрыв кристалла, 10 падение, 23 облако, 28 удар моба.
const DAMAGE_TYPES = ['arrow', 'bad_respawn_point', 'cactus', 'campfire', 'cramming', 'dragon_breath', 'drown', 'dry_out',
  'ender_pearl', 'explosion', 'fall', 'falling_anvil', 'falling_block', 'falling_stalactite', 'fireball', 'fireworks',
  'fly_into_wall', 'freeze', 'generic', 'generic_kill', 'hot_floor', 'in_fire', 'in_wall', 'indirect_magic', 'lava',
  'lightning_bolt', 'mace_smash', 'magic', 'mob_attack', 'mob_attack_no_aggro', 'mob_projectile', 'on_fire',
  'out_of_world', 'outside_border', 'player_attack', 'player_explosion', 'sonic_boom', 'spear', 'spit', 'stalagmite',
  'starve', 'sting', 'sweet_berry_bush', 'thorns', 'thrown', 'trident', 'unattributed_fireball', 'wind_charge',
  'wither', 'wither_skull']
const TRACE_DIR = process.env.ND_DRAGON_TRACE || null
const r1 = v => Math.round(v * 10) / 10
const r3 = v => Math.round(v * 1000) / 1000
function makeTrace (bot, ctl, stats) {
  if (!TRACE_DIR) return { ev () {}, close () {}, file: null }
  const fs = require('fs')
  const path = require('path')
  try { fs.mkdirSync(TRACE_DIR, { recursive: true }) } catch {}
  const file = path.join(TRACE_DIR, `dragon-${new Date().toISOString().replace(/[:.]/g, '-')}.jsonl`)
  const t0 = gameClock.now()
  let buf = []
  const put = o => { buf.push(JSON.stringify({ t: gameClock.now() - t0, ...o })) }
  const flush = () => { if (!buf.length) return; const s = buf.join('\n') + '\n'; buf = []; fs.appendFile(file, s, () => {}) }
  const nameOf = id => { const e = bot.entities[id]; return e ? (e.name || e.username || e.type) : (id >= 0 ? `#${id}` : null) }
  const seenClouds = new Set()
  const loggedFb = new Set()
  let lastPhase = null
  // Эндермены: кто и когда разозлился (метаданные creepy) и что было перед
  // этим — наш взгляд в игровом конусе (EnderMan.isBeingStaredBy: допуск
  // 0.025/расстояние, пять тиков подряд — EndermanLookForPlayerGoal aggroTime)
  // или урон по нему (damage_event с причиной).
  const angry = new Map()
  const enderHurt = new Map()
  const stareTicks = new Map()
  const onTickStare = () => {
    const me = bot.entity && bot.entity.position
    if (!me) return
    const eye = me.offset(0, EYE, 0)
    const yaw = bot.entity.yaw; const pitch = bot.entity.pitch
    const lx = -Math.sin(yaw) * Math.cos(pitch); const ly = Math.sin(pitch); const lz = -Math.cos(yaw) * Math.cos(pitch)
    for (const en of Object.values(bot.entities)) {
      if (!en || en.name !== 'enderman' || !en.position) continue
      const tx = en.position.x - eye.x; const ty = en.position.y + ENDERMAN_EYE - eye.y; const tz = en.position.z - eye.z
      const len = Math.hypot(tx, ty, tz)
      if (len > 64 || len < 0.3) { stareTicks.delete(en.id); continue }
      const inCone = (lx * tx + ly * ty + lz * tz) / len > 1 - 0.025 / len
      const n = inCone ? (stareTicks.get(en.id) || 0) + 1 : 0
      stareTicks.set(en.id, n)
      if (n === 3) put({ k: 'stare', id: en.id, dist: r1(len), doing: ctl.doing || null })
    }
  }
  const sample = () => {
    const e = bot.entity
    if (!e || !e.position) return
    const me = e.position
    const d = dragonOf(bot)
    const o = { k: 's', p: [r1(me.x), r1(me.y), r1(me.z)], hp: r1(bot.health ?? 0), f: bot.food, g: e.onGround ? 1 : 0, doing: ctl.doing || null }
    if (d) {
      const ph = phaseOf(bot, d)
      o.d = { ph, hp: r1(hpOf(bot, d) ?? -1), p: [r1(d.position.x), r1(d.position.y), r1(d.position.z)], yaw: +d.yaw.toFixed(2) }
      if (ph !== lastPhase) { put({ k: 'phase', ph, name: PHASE_RU[ph] ?? ph, hp: o.d.hp, at: o.d.p }); lastPhase = ph }
    }
    const cl = []
    for (const c of cloudsOf(bot)) {
      if (!seenClouds.has(c.e.id)) {
        seenClouds.add(c.e.id)
        put({ k: 'cloud', id: c.e.id, at: [r1(c.pos.x), r1(c.pos.y), r1(c.pos.z)], r: r1(c.r), me: [r1(me.x), r1(me.y), r1(me.z)], dist: r1(Math.hypot(c.pos.x - me.x, c.pos.z - me.z)), dragonPh: d ? phaseOf(bot, d) : null })
      }
      const h = Math.hypot(c.pos.x - me.x, c.pos.z - me.z)
      if (h < 14) cl.push([c.e.id, r1(h), r1(me.y - c.pos.y), r1(c.r)])
    }
    if (cl.length) o.cl = cl
    for (const [id, info] of fbSpawn) {
      if (loggedFb.has(id)) continue
      loggedFb.add(id)
      const hit = info.dir ? fbLineHit(bot, info.p0, info.dir) : null
      // Проверка декодера: фаербол летит в середину тела цели (мы — единственный
      // игрок): угол между его направлением и направлением на нас.
      const to = me.offset(0, 0.9, 0).minus(info.p0)
      const aimErr = info.dir ? Math.round(Math.acos(Math.max(-1, Math.min(1, (to.x * info.dir.x + to.y * info.dir.y + to.z * info.dir.z) / (to.norm() || 1)))) * 573) / 10 : null
      put({ k: 'fireball', id, aimErr, p0: [r1(info.p0.x), r1(info.p0.y), r1(info.p0.z)], dir: info.dir ? [+info.dir.x.toFixed(3), +info.dir.y.toFixed(3), +info.dir.z.toFixed(3)] : null, ground: hit ? [r1(hit.at.x), r1(hit.at.y), r1(hit.at.z)] : null, eta: hit ? fbTicksTo(hit.dist) : null, me: [r1(me.x), r1(me.y), r1(me.z)] })
    }
    const fb = Object.values(bot.entities).filter(x => x && x.name === 'dragon_fireball' && x.position && x.position.distanceTo(me) < 40).length
    if (fb) o.fb = fb
    for (const en of Object.values(bot.entities)) {
      if (!en || en.name !== 'enderman' || !en.position) continue
      const c = metaOf(bot, en, 'creepy') === true
      if (c && !angry.get(en.id)) {
        const h = enderHurt.get(en.id)
        put({ k: 'angry', id: en.id, at: [r1(en.position.x), r1(en.position.y), r1(en.position.z)], dist: r1(en.position.distanceTo(me)), stared: stareTicks.get(en.id) || 0, hurt: h && gameClock.now() - h.t < 3000 ? h : null, doing: ctl.doing || null })
      }
      angry.set(en.id, c)
    }
    put(o)
  }
  const onDmg = pk => {
    if (!bot.entity || !pk) return
    const victim = bot.entities[pk.entityId]
    if (victim && victim.name === 'enderman' && pk.entityId !== bot.entity.id) {
      enderHurt.set(pk.entityId, { t: gameClock.now(), type: DAMAGE_TYPES[pk.sourceTypeId] || pk.sourceTypeId, cause: nameOf(pk.sourceCauseId - 1), byMe: pk.sourceCauseId - 1 === bot.entity.id })
      return
    }
    if (pk.entityId !== bot.entity.id) return
    put({ k: 'hurt', type: DAMAGE_TYPES[pk.sourceTypeId] || pk.sourceTypeId, cause: nameOf(pk.sourceCauseId - 1), direct: nameOf(pk.sourceDirectId - 1), hpBefore: r1(bot.health ?? 0), doing: ctl.doing || null })
  }
  const onHealth = () => put({ k: 'hp', hp: r1(bot.health ?? 0), f: bot.food })
  const onDeath = () => { put({ k: 'death', doing: ctl.doing || null }); flush() }
  const onGone = en => { if (en && en.name === 'end_crystal') put({ k: 'crystalGone', id: en.id, at: [r1(en.position.x), r1(en.position.y), r1(en.position.z)] }) }
  // Каждый пакет движения дракона (сервер шлёт раз в 3 тика) — для прогноза головы.
  const onMoved = en => { if (en && en.name === 'ender_dragon') put({ k: 'dm', p: [r3(en.position.x), r3(en.position.y), r3(en.position.z)], yaw: +en.yaw.toFixed(3), ph: phaseOf(bot, en) }) }
  const onVel = pk => { const en = bot.entities[pk.entityId]; if (en && en.name === 'ender_dragon') put({ k: 'dv', v: pk.velocity ? [pk.velocity.x, pk.velocity.y, pk.velocity.z] : [pk.velocityX, pk.velocityY, pk.velocityZ] }) }
  bot.on('entityMoved', onMoved)
  bot._client.on('entity_velocity', onVel)
  bot._client.on('damage_event', onDmg)
  bot.on('physicsTick', onTickStare)
  bot.on('health', onHealth)
  bot.on('death', onDeath)
  bot.on('entityGone', onGone)
  const iv = gameClock.setInterval(sample, 250)
  const fl = gameClock.setInterval(flush, 1000)
  put({ k: 'start', kit: kitOf(bot), p: bot.entity ? [r1(bot.entity.position.x), r1(bot.entity.position.y), r1(bot.entity.position.z)] : null })
  return {
    file,
    ev (k, o = {}) { put({ k, ...o }) },
    close (extra = {}) {
      gameClock.clearInterval(iv); gameClock.clearInterval(fl)
      bot._client.removeListener('damage_event', onDmg)
      bot.removeListener('entityMoved', onMoved)
      bot._client.removeListener('entity_velocity', onVel)
      bot.removeListener('physicsTick', onTickStare)
      bot.removeListener('health', onHealth)
      bot.removeListener('death', onDeath)
      bot.removeListener('entityGone', onGone)
      put({ k: 'end', ...extra })
      flush()
    }
  }
}
// Чем занято тело — для трассы (и только для неё).
const doing = (ctl, what) => { if (ctl) ctl.doing = what }

// Драться — только с тем, кто бил нас сам за последние 8 с. Раньше сюда же
// шёл любой злой в 1.5 блока, а злой у дракона — обычно злой НА ДРАКОНА
// (облако огня ранит его, HurtByTargetGoal) — удар делал его нашим врагом:
// прогон 2026-09-26 (repro1, 75 с): бот сам начал драку с эндерменом, который
// к нему только подошёл.
function hunters (bot, r = 24) {
  return angryEndermen(bot, r).filter(e => {
    const t = hitBy.get(e.id)
    return t && gameClock.now() - t < 8000
  })
}

function angryEndermen (bot, r = 24) {
  const me = bot.entity.position
  return Object.values(bot.entities).filter(e => e && e.name === 'enderman' && e.position &&
    e.position.distanceTo(me) < r && metaOf(bot, e, 'creepy') === true)
}

async function lookSafe (bot, yaw, pitch) {
  await bot.look(yaw, safePitch(bot, yaw, pitch), true).catch(() => {})
}
async function lookAtSafe (bot, point) {
  const eye = bot.entity.position.offset(0, EYE, 0)
  const d = point.minus(eye)
  const yaw = Math.atan2(-d.x, -d.z)
  const pitch = Math.atan2(d.y, Math.hypot(d.x, d.z))
  await lookSafe(bot, yaw, pitch)
}

// ------------------------------------------------------------ инвентарь

const countOf = (bot, re) => bot.inventory.items().filter(i => re.test(i.name)).reduce((n, i) => n + i.count, 0)
const findItem = (bot, re) => bot.inventory.items().find(i => re.test(i.name)) || null
function kitOf (bot) {
  return {
    bow: countOf(bot, /^bow$/),
    arrows: countOf(bot, /arrow$/),
    blocks: countOf(bot, FILLER_RE),
    weapon: items.bestWeapon(bot) ? items.bestWeapon(bot).name : null,
    pickaxe: findItem(bot, /_pickaxe$/) ? findItem(bot, /_pickaxe$/).name : null,
    food: countOf(bot, /^(cooked_|bread|baked_potato|golden_carrot|golden_apple|enchanted_golden_apple|apple|carrot|pumpkin_pie|steak|mushroom_stew|rabbit_stew|beetroot_soup)/),
    gapples: countOf(bot, /golden_apple$/),
    water: countOf(bot, /^water_bucket$/),
    torches: countOf(bot, /^torch$/),
    beds: countOf(bot, /_bed$/)
  }
}
// Чего не хватает для режима. Отказ — до того, как тело что-то тронет.
// at {crystals, caged} — тело у центра острова и видит все обелиски (64
// блока): повторный вызов посреди боя требует по оставшимся кристаллам, а не
// набор на весь бой (прогон 2026-09-25: вызов после тайм-аута отказал на
// «arrow 31/32» с драконом на 70 хп).
// Конец фазы кристаллов — знание этого боя, а не вывод по пустому списку
// сущностей у далёкой клетки. Повторный full после timeout сохраняет его;
// новое тело/дракон/измерение или воскрешение требуют набор заново.
const clearedCrystals = new WeakMap()
function clearCrystalKnowledge (bot) { clearedCrystals.delete(bot) }
function noteCrystalClear (bot, report) {
  if (report && report.left > 0) clearCrystalKnowledge(bot)
  if (!report || report.left !== 0 || !(report.seen > 0) || !bot.entity || !/end/.test(bot.game.dimension)) return
  const d = dragonOf(bot)
  clearedCrystals.set(bot, { me: bot.entity.id, dragon: d ? d.id : null, dimension: bot.game.dimension })
}
function crystalKitState (bot, at, onIsland) {
  const rec = clearedCrystals.get(bot)
  if (rec) {
    const d = dragonOf(bot)
    if (!bot.entity || bot.entity.id !== rec.me || bot.game.dimension !== rec.dimension ||
        (d && rec.dragon != null && d.id !== rec.dragon) || (at && at.crystals > 0)) clearCrystalKnowledge(bot)
    else {
      if (d && rec.dragon == null) rec.dragon = d.id
      return { crystals: 0, caged: 0, island: true }
    }
  }
  return at || (onIsland ? { crystals: 10, caged: 2, island: true } : null)
}

function missing (kit, mode, at = null) {
  const need = []
  const full = mode === 'full' || mode === 'crystals'
  const arrows = at ? Math.min(KIT.arrows, 3 * at.crystals + 4) : KIT.arrows
  // У центра без клеток блоки нужны только станции кроватей; без кроватей —
  // меч и лук, блоков не надо вовсе (e2e5: второй вызов отказал «cobblestone
  // 0/16», хотя кристаллы сбиты и дракон летал).
  // С киркой блоки добываются на острове (эндерняк, mineEndStone) — с собой
  // нужно на мост с платформы (~35–40) с запасом.
  const blocks = at ? Math.min(KIT.blocks, (kit.pickaxe ? 0 : 24 * at.caged) + (kit.beds && !kit.pickaxe ? 8 : 0)) : (kit.pickaxe ? 44 : KIT.blocks)
  if (full && !kit.bow && (!at || at.crystals > 0)) need.push({ what: 'bow', count: 1, have: 0 })
  if (full && kit.arrows < arrows && (!at || at.crystals > 0)) need.push({ what: 'arrow', count: arrows, have: kit.arrows })
  if (full && kit.blocks < blocks) need.push({ what: 'cobblestone', count: blocks, have: kit.blocks })
  if (mode === 'dragon' && kit.blocks < 16) need.push({ what: 'cobblestone', count: 16, have: kit.blocks })
  if ((full || mode === 'dragon') && !kit.weapon) need.push({ what: 'diamond_sword', count: 1, have: 0 })
  if (full && !kit.pickaxe) need.push({ what: 'iron_pickaxe', count: 1, have: 0 })
  // Еда — только на вход: уже на острове (бой идёт) отказ за еду оставлял тело
  // стоять под драконом (ab-22, 30.09: «cooked_beef 2/6 — ни шагу не сделал»,
  // вызов за вызовом, смерть).
  if ((full || mode === 'dragon') && kit.food < KIT.food && !at) need.push({ what: 'cooked_beef', count: KIT.food, have: kit.food })
  // Только кровати: кровати, блоки (мост с платформы; у центра — заслоны и
  // досыпка пола), еда на вход. Лук и стрелы не нужны.
  if (mode === 'beds') {
    if (!kit.beds) need.push({ what: 'red_bed', count: BEDS_KIT, have: 0 })
    const bl = at ? 12 : (kit.pickaxe ? 44 : 64)
    if (kit.blocks < bl) need.push({ what: 'cobblestone', count: bl, have: kit.blocks })
    if (kit.food < KIT.food && !at) need.push({ what: 'cooked_beef', count: KIT.food, have: kit.food })
  }
  return need
}

async function equipName (bot, re) {
  const it = findItem(bot, re)
  if (!it) return null
  if (!bot.heldItem || bot.heldItem.type !== it.type) await bot.equip(it, 'hand').catch(() => {})
  return it
}

// ------------------------------------------------------------ ходьба

// sprint — бег (03.10, указание пользователя: к центру и к станции бегом; в Энде goto по умолчанию шагом), сытость > 6;
// digCost — цена копки (pathfinder: (1 + 3·t/1000)·digCost): к центру копать только если иначе никак (тоннель — плохо).
function endMovements (bot, clouds = null, { maxDrop = 3, portal = false, noDig = false, sprint = false, digCost = 1 } = {}) {
  const m = new Movements(bot)
  m.canDig = !noDig && !!findItem(bot, /_pickaxe$/)
  m.allowParkour = false
  m.allowSprinting = !!sprint && (bot.food ?? 20) > 6
  m.digCost = digCost
  // Прыжок вниз pathfinder планирует только на твёрдое (в пустоту не
  // прыгнет), так что глубина — это только цена в хп падения.
  m.maxDropDown = maxDrop
  m.infiniteLiquidDropdownDistance = false
  // Не копать и не ходить к низу острова: fin3-11 — платформа в толще острова (y 49), путь к
  // центру прокопом ушёл вниз до y 36, к нижнему краю, и следующий прокоп открыл пустоту.
  m.exclusionAreasBreak.push(b => (b && b.position && b.position.y < 44 ? Infinity : 0))
  m.exclusionAreasStep.push(b => (b && b.position && b.position.y < 43 ? Infinity : 0))
  // Столб 1×1 у pathfinder'а медленный и срывается (прыжок и установка не в
  // такт): 5 с на блок против 0.6 с на прокоп ступеньки в эндерняке алмазной киркой.
  m.allow1by1towers = false
  const reg = bot.registry
  m.scafoldingBlocks = bot.inventory.items().filter(i => FILLER_RE.test(i.name)).map(i => i.type)
  for (const n of ['obsidian', 'bedrock', 'iron_bars', 'end_portal_frame', 'crying_obsidian']) {
    if (reg.blocksByName[n]) m.blocksCantBreak.add(reg.blocksByName[n].id)
  }
  // Выходной портал и шлюз — не пол: шаг в них уносит из Энда.
  for (const n of ['end_portal', 'end_gateway']) {
    if (reg.blocksByName[n]) m.blocksToAvoid.add(reg.blocksByName[n].id)
  }
  // Мостить над пустотой pathfinder'у не даём: это делает свой мост, осторожно.
  m.exclusionAreasPlace.push(b => (b && b.position && voidBelow(bot, b.position.x, b.position.y + 1, b.position.z, 40)) ? 1000 : 0)
  // Облака растут (фаербол: 3 → 7 за 30 с) — путь сквозь них не прокладывать вовсе.
  // Клетка внутри облака (радиус + 0.4) — почти запрет: путь вдоль облака по
  // блоку выше и шаг вниз в него стоил смерти (camp2, 142–147 с: 5 ударов по 6).
  if (clouds) {
    m.exclusionAreasStep.push(b => {
      if (!(b && b.position)) return 0
      const feet = new Vec3(b.position.x + 0.5, b.position.y, b.position.z + 0.5)
      const zs = cloudZones(bot)
      if (zs.some(z => inZone(z, feet))) return 20000
      return zs.some(z => inZone(z, feet, 1.2)) ? 500 : 0
    })
  }
  m.exclusionAreasStep.push(b => (b && b.position) ? dragonStepCost(bot, b.position) : 0)
  if (!portal) m.exclusionAreasStep.push(b => (b && b.position && nearPortal(new Vec3(b.position.x + 0.5, b.position.y, b.position.z + 0.5))) ? 1000 : 0)
  return m
}

function runnerBowl (bot, ctl) {
  const p = ctl.pillar && ctl.pillar.plan, q = bot.entity.position
  return runnerOn() && !!p && p.runner && q.y <= p.P - 3 + 0.3 && Math.hypot(q.x - 0.5, q.z - 0.5) < 4
}
async function walkTo (session, ctl, target, opts = {}) {
  let last = null
  for (let attempt = 0; attempt < 4 && !ctl.aborted; attempt++) {
    if (embeddedNow(session.bot)) await unembed(session.bot, ctl)
    await guard(session, ctl)
    // Уже в облаке — сперва выйти: noPath отвечает мгновенно, и без этого
    // тело так и стоит в нём, пока вызывающий перебирает цели.
    if (opts.hazards !== false) {
      const bad = hazardNow(session.bot)
      if (bad && !(opts.hazards === 'noclouds' && /облако/.test(bad.kind))) await evade(session.bot, ctl, opts.stats || ctl.stats || { dodges: {} }, bad)
    }
    if (opts.stopIf) { const w = opts.stopIf(); if (w) return { ok: false, why: w, stopped: true } }
    last = await walkOnce(session, ctl, target, opts)
    if (last.stopped) return last
    if (last.embedded) { await unembed(session.bot, ctl); continue }
    if (last.stalled) { await unstick(session.bot, ctl, opts.stats || ctl.stats || { dodges: {} }); continue }
    if (last.enderman) { attempt--; continue }
    // Облако на пути — рассчитать заново (облака уже в цене шага); цель сама в
    // облаке — вернуть вызывающему.
    if (last.blocked) { if (cloudZones(session.bot).some(z => inZone(z, target))) return { ok: false, why: 'цель в облаке', cloud: true }; await sleep(150); continue }
    // Застрял наверху (мосток над порталом, свой столб): вниз разрешить
    // спрыгнуть глубже — до 8 блоков, это до ~5 хп, а не пустота.
    if (!last.ok && !last.hazard && !last.cloud && !opts.maxDrop && session.bot.entity.position.y - target.y > 3 && session.bot.health > 12) {
      last = await walkOnce(session, ctl, target, { ...opts, maxDrop: 8 })
      if (last.ok) return last
    }
    if (last.ok || !last.hazard) return last
    await evade(session.bot, ctl, opts.stats || ctl.stats || { dodges: {} }, last.hazard)
    // Цель сама в облаке — возвращаться туда значит снова стоять в нём: пусть
    // вызывающий выберет другое место.
    if (inClouds(cloudsOf(session.bot), target, 2.5)) return { ok: false, why: 'цель в облаке', cloud: true }
  }
  return last || { ok: false, why: 'прервано' }
}

// Между шагами любого долгого дела: злой эндермен рядом — отбиться; мало хп —
// поесть (золотое яблоко первым), совсем мало — яма с крышкой.
let guarding = false
async function guard (session, ctl) {
  if (guarding) return
  guarding = true
  try {
    const bot = session.bot
    const stats = ctl.stats || { dodges: {}, ate: [], hid: [] }
    const d = dragonOf(bot)
    const ph = d ? phaseOf(bot, d) : null
    const landing = SITTING.has(ph) || ph === PHASE.LANDING || ph === PHASE.APPROACH
    // Дракон садится — окно дороже эндермена: драться, только если тот уже бьёт.
    // «Злой» (creepy) значит «у него есть цель», а цель бывает и не мы — облако
    // дракона злит эндерменов на дракона. Драться только с тем, кто вплотную.
    const e = hunters(bot, landing ? 2.5 : 3.5).sort((a, b) => a.position.distanceTo(bot.entity.position) - b.position.distanceTo(bot.entity.position))[0]
    if (e) {
      await fightEnderman(session, ctl, stats, e, () => {
        const p2 = phaseOf(bot, dragonOf(bot))
        return !landing && (SITTING.has(p2) || p2 === PHASE.LANDING)
      })
    }
    // Окно посадки (сидит/садится) дороже еды: уход от облака «с запасом 4» и яблоко на 13 хп
    // съедали всю посадку слепого (fin2-28: 3 с из 5 — ни одной кровати). В окне — только из
    // самого облака и есть при ≤ 10.
    const win = SITTING.has(ph) || ph === PHASE.LANDING
    if (bot.health <= 14) await clearOfClouds(session, ctl, stats, win ? 1 : 4)
    if (bot.health <= 7) await hideAndHeal(session, ctl, null, stats, { until: 16 })
    else if (win ? bot.health <= 10 : (bot.health <= 14 || bot.food < 14)) await heal(session, ctl, null, stats, { hard: bot.health <= 14 })
  } finally { guarding = false }
}

// Замурован в блок: сервер считает, что хитбокс в блоке, и каждый наш шаг
// отбивает телепортом назад (ServerGamePacketListenerImpl.handleMovePlayer →
// isEntityCollidingWithAnythingNew → teleport). Так бывает, если блок встал
// под ноги в прыжке не в такт (столб), или после переподключения посреди
// столба. Лечится одним: выкопать блок, в котором сидят ноги.
async function unembed (bot, ctl) {
  clearControls(bot)
  for (let i = 0; i < 4 && !ctl.aborted; i++) {
    const b = embeddedNow(bot)
    if (!b || /bedrock|obsidian|end_portal/.test(b.name)) break
    try {
      await items.equipBestTool(bot, b)
      await build.withTimeout(bot.dig(b, true), 5000)
      dbg('unembed', b.name, b.position.toString())
    } catch (e) { dbg('unembed failed', e.message) }
  }
  await sleep(300)
}

// Выбраться из ямы/угла, где pathfinder упёрся: ближайшая клетка в 2–3
// блоках, на которую можно встать не глубже, — клавишами, с прыжком на
// ступеньку (stepTo прыгает сам, если впереди блок).
async function unstick (bot, ctl, stats) {
  stats.dodges = stats.dodges || {}
  stats.dodges.застрял = (stats.dodges.застрял || 0) + 1
  clearControls(bot)
  const me = bot.entity.position
  const opts = []
  for (let r = 2; r <= 3; r++) {
    for (let k = 0; k < 8; k++) {
      const a = Math.PI * k / 4
      const x = me.x + Math.cos(a) * r; const z = me.z + Math.sin(a) * r
      const y = standY(bot, x, z, me.y, 2, 1)
      if (y == null || nearEdge(bot, new Vec3(x, y, z), 2)) continue
      opts.push({ feet: new Vec3(Math.floor(x) + 0.5, y, Math.floor(z) + 0.5), up: y - Math.floor(me.y) })
    }
  }
  opts.sort((a, b) => b.up - a.up)
  for (const o of opts.slice(0, 3)) {
    const r = await stepTo(bot, ctl, o.feet, { ms: 1500, sprint: false, stopAt: 0.5 })
    dbg('unstick', o.feet.toString(), r.ok ? 'ok' : r.why)
    if (r.ok || bot.entity.position.distanceTo(me) > 1) return true
  }
  return false
}

// Хитбокс в полном блоке — состояние, а не событие: читается в любой момент.
function embeddedNow (bot) {
  const p = bot.entity.position
  for (const x of [p.x - 0.29, p.x + 0.29]) {
    for (const z of [p.z - 0.29, p.z + 0.29]) {
      for (const y of [p.y + 0.05, p.y + 0.9, p.y + 1.75]) {
        const b = bot.blockAt(new Vec3(Math.floor(x), Math.floor(y), Math.floor(z)))
        if (b && b.boundingBox === 'block' && b.shapes && b.shapes.length === 1) {
          const [x0, y0, z0, x1, y1, z1] = b.shapes[0]
          if (x0 === 0 && y0 === 0 && z0 === 0 && x1 === 1 && y1 === 1 && z1 === 1) return b
        }
      }
    }
  }
  return null
}

// Сколько раз сервер вернул нас на место за последние 2 с (пакет position).
function makeRubberband (bot) {
  const times = []
  const f = () => { times.push(gameClock.now()); while (times.length && gameClock.now() - times[0] > 2000) times.shift() }
  bot._client.on('position', f)
  return { count: () => { while (times.length && gameClock.now() - times[0] > 2000) times.shift(); return times.length }, close: () => bot._client.removeListener('position', f) }
}

async function walkOnce (session, ctl, target, { range = 1, timeoutMs = 30000, xz = false, hazards = true, maxDrop = 3, portal = false, stopIf = null, noDig = false, sprint = false, digCost = 1 } = {}) {
  const bot = session.bot
  // Уже прервано — не начинать: stop() в onAbort после abort не позовут, и
  // такой ход жил бы свои 30 с за спиной ответа (прогон: тело после смерти
  // «шло» к кристаллу в верхнем мире).
  if (ctl.aborted) return { ok: false, why: 'прервано' }
  if (ctl.deadline) timeoutMs = Math.max(1000, Math.min(timeoutMs, ctl.deadline - gameClock.now()))
  if (runnerBowl(bot, ctl)) portal = true
  bot.pathfinder.setMovements(endMovements(bot, hazards === 'noclouds' ? null : () => cloudsOf(bot), { maxDrop, portal, noDig, sprint, digCost }))
  const goal = xz ? new goals.GoalNearXZ(target.x, target.z, range) : new goals.GoalNear(target.x, target.y, target.z, range)
  const stop = () => { try { bot.pathfinder.setGoal(null) } catch {} }
  ctl.onAbort.push(stop)
  let timer = null
  let hazard = null
  // Путь впереди (массив pathfinder'а, он сдвигает его сам по мере хода) — для
  // проверки облаков на пути: облако, упавшее после расчёта, — путь заново.
  let curPath = null
  let blocked = null
  const onPath = r => {
    if (r && r.path) curPath = r.path
    if (!DEBUG || !r || !r.path) return
    dbg('path', r.status, r.path.slice(0, 6).map(n => `${n.x},${n.y},${n.z}${n.toBreak && n.toBreak.length ? ' dig' + n.toBreak.length : ''}${n.toPlace && n.toPlace.length ? ' place' + n.toPlace.length : ''}`).join(' → '))
  }
  bot.on('path_update', onPath)
  // Пока идём — следить за фаерболами и облаками: путь рвётся, тело уходит.
  const band = makeRubberband(bot)
  let embedded = false
  let pest = null
  // Встал: жмёт «вперёд» в стену и не двигается (прогон 2026-09-25: 20 с в
  // воронке от взрыва у портала, x = ровно полуширина хитбокса, путь не
  // обновлялся; облако фаербола добило). Копка — не застревание.
  let stalled = false
  let moved = { p: bot.entity.position.clone(), t: gameClock.now() }
  let stopped = null
  const poll = gameClock.setInterval(() => {
    if (hazard || embedded || pest || stalled || blocked || stopped) return
    if (stopIf) { const w = stopIf(); if (w) { stopped = w; stop(); return } }
    if (band.count() >= 4) { embedded = true; stop(); return }
    const here = bot.entity.position
    if (here.distanceTo(moved.p) > 0.25 || bot.targetDigBlock || !bot.getControlState('forward')) moved = { p: here.clone(), t: gameClock.now() }
    else if (gameClock.now() - moved.t > 2500) { stalled = true; stop(); return }
    // Злой эндермен вплотную: остановиться и отбиться, а не идти с ним на спине.
    const e = hunters(bot, 3)[0]
    if (e) { pest = e; stop(); return }
    if (!hazards) return
    const bad = hazardNow(bot)
    // noclouds — сквозь облако идём сознательно (к подставке у головы), но
    // от фаербола и головы уходим.
    if (bad && !(hazards === 'noclouds' && /облако/.test(bad.kind))) { hazard = bad; stop(); return }
    if (hazards !== 'noclouds' && curPath && curPath.length) {
      const zs = cloudZones(bot)
      let prev = here
      for (const n of curPath.slice(0, 8)) {
        const f = new Vec3(n.x + 0.5, n.y, n.z + 0.5)
        const z = stepIntoZone(zs, prev, f)
        if (z) { blocked = z; stop(); return }
        prev = f
      }
    }
  }, 150)
  const sampler = DEBUG
    ? gameClock.setInterval(() => {
      const e = bot.entity
      const c = ['forward', 'jump', 'sprint', 'sneak'].filter(k => bot.getControlState(k)).join('+')
      const blk = bot.blockAt(e.position)
      dbg('walk', e.position.toString(), 'v', e.velocity.toString(), 'ground', e.onGround, 'keys', c || '-', 'blk', blk ? blk.name : 'NULL', 'veh', bot.vehicle ? (bot.vehicle.name || bot.vehicle.id) : '-')
    }, 1000)
    : null
  try {
    await Promise.race([
      bot.pathfinder.goto(goal),
      new Promise((_resolve, reject) => { timer = gameClock.setTimeout(() => reject(new Error(`не дошёл за ${Math.round(timeoutMs / 1000)}с`)), timeoutMs) })
    ])
    // «Дошёл» от pathfinder'а — не свидетель: goal_reached от прошлой цели
    // резолвит новый goto сразу (бот на мостке в 8 блоках над краем портала
    // «дошёл» до края). Свидетель — расстояние.
    const p = bot.entity.position
    const left = xz ? Math.hypot(p.x - target.x, p.z - target.z) : p.distanceTo(target)
    if (left > range + 1) return { ok: false, why: `pathfinder сказал «дошёл», а до цели ${left.toFixed(1)}` }
    return { ok: true }
  } catch (e) {
    stop()
    if (stopped) return { ok: false, why: stopped, stopped: true }
    return { ok: false, why: embedded ? 'замурован: сервер отбивает шаги' : pest ? 'напал эндермен' : hazard ? `опасность: ${hazard.kind}` : blocked ? `на пути ${blocked.kind}` : stalled ? 'встал: упёрся и не двигается' : String((e && e.message) || e), hazard, embedded, stalled, enderman: !!pest, blocked }
  } finally {
    gameClock.clearTimeout(timer)
    band.close()
    gameClock.clearInterval(poll)
    if (sampler) gameClock.clearInterval(sampler)
    bot.removeListener('path_update', onPath)
    for (const k of ['forward', 'back', 'left', 'right', 'jump', 'sprint', 'sneak']) { try { bot.setControlState(k, false) } catch {} }
  }
}

function clearControls (bot) {
  for (const k of ['forward', 'back', 'left', 'right', 'jump', 'sprint', 'sneak']) { try { bot.setControlState(k, false) } catch {} }
}

// Короткий манёвр клавишами по прямой (уклон, шаг к голове). Перед каждым
// шагом смотрит, есть ли впереди земля: в Энде шаг в пустоту — смерть.
async function stepTo (bot, ctl, target, { ms = 2500, sprint = true, stopAt = 0.3, stop = null, portal = false, clouds = true, stuckMs = 700 } = {}) {
  if (runnerBowl(bot, ctl)) portal = true
  const t0 = gameClock.now()
  let why = null
  // Упёрся (стенка в 2 блока, яма-воронка: прыгает на месте — fin3-26, 1.5 с прыжков у ямы)
  // — бросить: пусть ведёт pathfinder.
  let best = Infinity; let bestT = t0
  try {
    while (!ctl.aborted && gameClock.now() - t0 < ms) {
      if (stop && stop()) { why = 'прервал'; break }
      const p = bot.entity.position
      const dx = target.x - p.x; const dz = target.z - p.z
      const dist = Math.hypot(dx, dz)
      if (dist < stopAt) break
      if (dist < best - 0.25) { best = dist; bestT = gameClock.now() } else if (stuckMs && gameClock.now() - bestT > stuckMs) { why = 'застрял'; break }
      // Облако над головой (легло на стенку станции, на столб) не трогает, пока
      // стоим: его коробка — полблока от его y. Прыжок (+1.25) поднимает нас в
      // неё: сцена station (2026-09-26) — два удара по 3, тело прыгало через
      // блоки станции под облаком огня на её стенке.
      const lidOver = cloudsOf(bot).some(c => Math.hypot(p.x - c.pos.x, p.z - c.pos.z) < c.r + 0.8 && c.pos.y >= p.y + 0.5 && c.pos.y < p.y + 1.8 + 1.3)
      // clouds: true — все зоны; 'fb' — только места фаерболов (уход краем облака); false — никаких.
      const k = stepKeys(bot, p, target, { sprint, onGround: bot.entity.onGround, lidOver, portal, zones: clouds === 'fb' ? zonesOf([], fireballsOf(bot)) : clouds ? cloudZones(bot) : null })
      if (k.stop) { why = k.stop; break }
      await lookSafe(bot, k.yaw, -0.35)
      bot.setControlState('forward', true)
      bot.setControlState('sprint', k.sprint)
      bot.setControlState('jump', k.jump)
      await sleep(50)
    }
  } finally {
    clearControls(bot)
  }
  const left = Math.hypot(target.x - bot.entity.position.x, target.z - bot.entity.position.z)
  if (!why && left > stopAt + 0.5) why = `не дошёл: ${left.toFixed(1)} блока`
  return { ok: !why, why, dist: Math.round(left * 10) / 10 }
}

// ------------------------------------------------------------ прибытие

// С обсидиановой платформы до острова: мост по прямой к центру на уровне
// платформы, пока впереди не окажется земля, на которую можно шагнуть или
// спрыгнуть не больше чем на 3 блока. Дальше ведёт pathfinder.
async function bridgeToIsland (session, ctl, rep) {
  const bot = session.bot
  doing(ctl, 'bridge')
  const out = { placed: 0, steps: 0 }
  const p0 = bot.entity.position
  const toC = { x: CENTER.x - p0.x, z: CENTER.z - p0.z }
  const d = Math.abs(toC.x) >= Math.abs(toC.z) ? { x: Math.sign(toC.x), z: 0 } : { x: 0, z: Math.sign(toC.z) }
  out.dir = d
  const stats = ctl.stats || { dodges: {} }
  // Мост — сразу на высоте верха острова (2026-09-30): край по линии моста —
  // стена от уровня платформы до верха в 5–7 блоках выше (мир фермы: мост на 48
  // упирался в стену у x 82, верх — 54–55), и pathfinder лез на неё 25–27 с у
  // самого края (dtr-1-1, dtr-2-1; в dtr-1-1 там же уход в пустоту). Поднять
  // мост столбом на самой платформе: сорваться со столба можно только на
  // обсидиан. Верх острова по линии моста видно с платформы.
  const under0 = bot.blockAt(p0.floored().offset(0, -1, 0))
  if (under0 && under0.name === 'obsidian') {
    // Злой эндермен у платформы — сперва отбиться, и столб — из середины
    // платформы: со столба на её краю удар сбрасывает в пустоту (d5-19,
    // 30.09: эндермен бил на подъёме, тело на краю платформы, смерть на 8 с).
    for (let k = 0; k < 3 && !ctl.aborted; k++) {
      const pest = angryEndermen(bot, 6).sort((a, b) => a.position.distanceTo(bot.entity.position) - b.position.distanceTo(bot.entity.position))[0]
      if (!pest) break
      out.endermen = (out.endermen || 0) + 1
      await fightEnderman(session, ctl, stats, pest, null)
    }
    const inner = platformInner(bot)
    if (inner && Math.hypot(inner.x - bot.entity.position.x, inner.z - bot.entity.position.z) > 0.3) await stepTo(bot, ctl, inner, { ms: 2500, sprint: false, stopAt: 0.2 })
  }
  const p1 = bot.entity.position
  const under1 = bot.blockAt(p1.floored().offset(0, -1, 0))
  // rise: false — мост на уровне платформы, как раньше (опыт: при медленном подходе дракон
  // чаще «слепой» — первая проверка видимости застаёт нас за обелиском на склоне).
  if (!ctl.noRise && under1 && under1.name === 'obsidian' && platformInner(bot, 0)) {
    const edge = islandEdgeTop(bot, p1, d)
    const rise = edge ? edge.top - Math.floor(p1.y + 0.01) : 0
    out.edge = edge
    if (rise >= 1 && rise <= 10 && countOf(bot, FILLER_RE) >= rise + edge.k + 6) {
      doing(ctl, 'bridge:rise')
      const t = await fastTower(bot, ctl, edge.top, { maxMs: 12000, abortIf: () => angryEndermen(bot, 3).length ? 'эндермен рядом' : null })
      out.rise = { want: rise, ok: t.ok, placed: t.placed, why: t.why || null }
      if (ctl.trace) ctl.trace.ev('bridgeRise', out.rise)
      doing(ctl, 'bridge')
    }
  }
  for (let i = 0; i < 120 && !ctl.aborted; i++) {
    await yieldTick()
    // На мосту в блок шириной уходить вбок некуда (evade ищет клетку не у
    // края — на мосту таких нет, прогон repro1: облако фаербола легло на мост,
    // −2 хп). Фаербол летит — назад по своему мосту, прочь от точки
    // попадания; облако уже на нас — блок под себя (облако высотой 0.5), мост
    // дальше пойдёт с новой высоты.
    // Облако фаербола на мосту впереди (или на нас): живёт 30 с и растёт 3 → 7
    // (DragonFireball.onHit), обойти на мосту в блок шириной нельзя, а идти
    // сквозь — 6 за удар (e2e4, e2e15: две смерти на мосту, 5 ударов подряд).
    // Отойти назад по мосту за его край с запасом и ждать, пока исчезнет.
    const me0 = bot.entity.position
    const blocking = cloudsOf(bot).find(c => {
      // Облако задевает только тех, чья коробка пересекает его полблока: кто
      // идёт на блок выше его y — мимо (мост над облаком, см. ниже).
      if (!(c.pos.y + CLOUD_SLAB > me0.y && c.pos.y < me0.y + 1.8)) return false
      for (let k = 0; k <= 6; k++) {
        const x = me0.x + d.x * k; const z = me0.z + d.z * k
        if (Math.hypot(x - c.pos.x, z - c.pos.z) < c.r + 1.6) return true
      }
      return false
    })
    // Мост дальше — на блок выше: над облаком (его коробка — полблока от его
    // y) тело на y+1 не задевает, а ждать облака на мосту — 30 с, и за это
    // время дракон кидает новые (camp2: ждал 45 с трёх облаков подряд, пошёл
    // сквозь четвёртое — смерть). Блок под себя — там, где стоим, пока облако
    // впереди; дальше мост сам кладёт блоки на уровень выше.
    if (blocking && bot.entity.onGround && countOf(bot, FILLER_RE) > 0 && isAirish(bot.blockAt(me0.floored().offset(0, 2, 0)))) {
      out.overCloud = (out.overCloud || 0) + 1
      bot.setControlState('sneak', true)
      const t = await build.towerUp(bot, ctl, 1, { item: fillerItem(bot) })
      if (t.placed) continue
    }
    if (blocking && (out.waitMs || 0) < 45000) {
      const tw = gameClock.now()
      i--
      const need = blocking.r + 3
      let back = null
      for (let k = 0; k <= 16; k++) {
        const q = me0.floored().offset(-d.x * k, -1, -d.z * k)
        const b = bot.blockAt(q)
        if (!b || !isSolid(b)) break
        back = q
        if (Math.hypot(q.x + 0.5 - blocking.pos.x, q.z + 0.5 - blocking.pos.z) > need) break
      }
      if (back && Math.hypot(me0.x - back.x - 0.5, me0.z - back.z - 0.5) > 0.4) {
        bot.setControlState('sneak', false)
        await stepTo(bot, ctl, new Vec3(back.x + 0.5, back.y + 1, back.z + 0.5), { ms: 3000, stopAt: 0.25, portal: true })
      }
      await sleep(500)
      out.waitMs = (out.waitMs || 0) + (gameClock.now() - tw)
      continue
    }
    const bad = hazardNow(bot)
    if (bad) {
      out.dodged = (out.dodged || 0) + 1
      const me = bot.entity.position
      if (bad.f) {
        const land = bad.f.ground || bad.f.at
        let back = null
        for (let k = 1; k <= 8; k++) {
          const q = me.floored().offset(-d.x * k, -1, -d.z * k)
          const b = bot.blockAt(q)
          if (!b || !isSolid(b)) break
          back = q
          if (land && Math.hypot(q.x + 0.5 - land.x, q.z + 0.5 - land.z) > FIREBALL_SNAP + 2) break
        }
        if (back) {
          stats.dodges.фаербол = (stats.dodges.фаербол || 0) + 1
          bot.setControlState('sneak', false)
          await stepTo(bot, ctl, new Vec3(back.x + 0.5, back.y + 1, back.z + 0.5), { ms: 2500, stopAt: 0.25, portal: true })
          await sleep(300)
          continue
        }
      }
      await sleep(100)
    }
    // Клетка — та, на которой стоим (под хитбоксом): свесившись со столба, центр
    // над воздухом, и блок «от своей клетки» встал бы по диагонали от опоры (ab-23).
    let sup = supportCell(bot)
    if (sup && (sup.x !== Math.floor(bot.entity.position.x) || sup.z !== Math.floor(bot.entity.position.z))) {
      await stepOnto(bot, ctl, sup.x, sup.z)
      sup = supportCell(bot) || sup
    }
    const p = bot.entity.position
    const cell = sup ? sup.offset(0, 1, 0) : p.floored()
    const fy = cell.y - 1
    const nx = cell.x + d.x; const nz = cell.z + d.z
    const floorN = bot.blockAt(new Vec3(nx, fy, nz))
    const feetN = bot.blockAt(new Vec3(nx, fy + 1, nz))
    const headN = bot.blockAt(new Vec3(nx, fy + 2, nz))
    if (!floorN || !feetN) { out.stopped = 'мир впереди не прогружен'; break }
    // Стена впереди — это остров (или его край): дальше pathfinder, он умеет
    // подниматься и прокапывать.
    if (isSolid(feetN)) { out.land = 'стена острова'; break }
    // Земля внизу в пределах безопасного прыжка — остров.
    let landBelow = null
    for (let k = 0; k <= 3; k++) {
      const b = bot.blockAt(new Vec3(nx, fy - k, nz))
      if (isSolid(b)) { landBelow = k; break }
    }
    if (landBelow !== null && landBelow > 0) {
      // Земля ниже на landBelow — это остров, если это эндерняк толщиной больше
      // блока: наш же мост (один блок над пустотой) — не земля (e2e4: мост,
      // поднятый над облаком, «нашёл землю» — свой старый мост — и кончился).
      const gyN = fy - landBelow
      const top = bot.blockAt(new Vec3(nx, gyN, nz)); const under = bot.blockAt(new Vec3(nx, gyN - 1, nz))
      if (top && top.name === 'end_stone' && isSolid(under)) { out.land = `земля ниже на ${landBelow}`; break }
    }
    if (landBelow === 0) {
      // Под следующей клеткой твёрдое: если это наш же мост или платформа —
      // идём дальше; если остров (под ним не пустота на 3 блока вниз) — стоп.
      if (!isAirish(headN)) { out.stopped = 'впереди потолок'; break }
      const island = floorN.name === 'end_stone' && !nearEdge(bot, new Vec3(nx, fy, nz), 1)
      await stepOnto(bot, ctl, nx, nz)
      out.steps++
      if (island) { out.land = 'стою на острове'; break }
      continue
    }
    // Впереди пусто — ставим блок под следующую клетку, прислоняя к боку своей.
    // Над головой впереди — нависший край острова (эндерняк), ноги свободны: срыть его и
    // мостить дальше (fin2-15: сид с навесом у платформы — 12 мин «впереди не пройти», смерть
    // в облаке на платформе).
    if (isAirish(feetN) && headN && headN.name === 'end_stone' && (out.dugHead || 0) < 6) {
      clearControls(bot)
      try { await items.equipBestTool(bot, headN); await build.withTimeout(bot.dig(headN, true), 4000) } catch {}
      if (isAirish(bot.blockAt(headN.position))) { out.dugHead = (out.dugHead || 0) + 1; continue }
    }
    if (!isAirish(headN) || !isAirish(feetN)) { out.stopped = 'впереди не пройти'; break }
    bot.setControlState('sneak', true)
    const r = await build.placeBlockAt(bot, new Vec3(nx, fy, nz), { steady: true, timeoutMs: 3000 })
    if (!r.ok) {
      // Ещё раз, подойдя к самому краю (крадучись с края не падаем).
      await creepToEdge(bot, ctl, d)
      const r2 = await build.placeBlockAt(bot, new Vec3(nx, fy, nz), { steady: true, timeoutMs: 3000 })
      if (!r2.ok) { out.stopped = `мост: блок не встал — ${r2.reason}`; break }
    }
    out.placed++
    await stepOnto(bot, ctl, nx, nz)
    out.steps++
  }
  clearControls(bot)
  rep.bridge = out
  return out
}
// Клетка платформы, вокруг которой все восемь соседей — обсидиан (середина
// 5×5): ближайшая к телу в r клетках или null.
function platformInner (bot, r = 2) {
  const p = bot.entity.position
  const fx = Math.floor(p.x); const fz = Math.floor(p.z); const y = Math.floor(p.y + 0.01) - 1
  let best = null
  for (let dx = -r; dx <= r; dx++) {
    for (let dz = -r; dz <= r; dz++) {
      let ok = true
      for (let ax = -1; ax <= 1 && ok; ax++) for (let az = -1; az <= 1 && ok; az++) {
        const b = bot.blockAt(new Vec3(fx + dx + ax, y, fz + dz + az))
        if (!b || b.name !== 'obsidian') ok = false
      }
      if (!ok) continue
      const c = new Vec3(fx + dx + 0.5, p.y, fz + dz + 0.5)
      if (!best || c.distanceTo(p) < best.distanceTo(p)) best = c
    }
  }
  return best
}
// Верх острова по линии моста: первая колонка с эндерняком сверху в 45 блоках
// от p0 по d — высота ног на её верху и сколько до неё колонок. null — не
// прогружено или острова по линии нет.
function islandEdgeTop (bot, p0, d, range = 45) {
  const cx = Math.floor(p0.x); const cz = Math.floor(p0.z); const fy = Math.floor(p0.y + 0.01)
  for (let k = 1; k <= range; k++) {
    const x = cx + d.x * k; const z = cz + d.z * k
    for (let y = fy + 16; y >= fy - 8; y--) {
      const b = bot.blockAt(new Vec3(x, y, z))
      if (!b) return null
      if (isSolid(b)) {
        if (b.name === 'end_stone') return { k, top: y + 1 }
        break
      }
    }
  }
  return null
}
async function creepToEdge (bot, ctl, d) {
  const yaw = Math.atan2(-d.x, -d.z)
  await lookSafe(bot, yaw, -1.2)
  bot.setControlState('sneak', true)
  bot.setControlState('forward', true)
  await sleep(350)
  bot.setControlState('forward', false)
}
// Шагнуть крадучись на соседнюю клетку (центр). Крадучись с края не упасть.
async function stepOnto (bot, ctl, x, z) {
  const target = new Vec3(x + 0.5, 0, z + 0.5)
  const t0 = gameClock.now()
  bot.setControlState('sneak', true)
  try {
    while (!ctl.aborted && gameClock.now() - t0 < 2500) {
      const p = bot.entity.position
      const dx = target.x - p.x; const dz = target.z - p.z
      if (Math.hypot(dx, dz) < 0.2) break
      await lookSafe(bot, Math.atan2(-dx, -dz), -0.6)
      bot.setControlState('forward', true)
      await sleep(50)
    }
  } finally {
    bot.setControlState('forward', false)
  }
}

// Напролом к цели, когда pathfinder не справился (обрыв острова над мостом,
// крутой склон): по прямой вдоль главной оси, ступенька за ступенькой —
// выше земля — прокопать проход и шагнуть вверх, пусто под ногами —
// подложить блок, ниже на 1–3 — шагнуть вниз. Каждые шесть ступенек снова
// спросить pathfinder: вдруг дальше ровно.
async function burrowTo (session, ctl, target, { near = 18, steps = 140 } = {}) {
  const bot = session.bot
  const out = { steps: 0, dug: 0, placed: 0 }
  const digAt = async (pos) => {
    const b = bot.blockAt(pos)
    if (!b || b.boundingBox === 'empty') return true
    if (/bedrock|obsidian|end_portal|iron_bars/.test(b.name)) { out.wall = `${b.name} ${pos.x},${pos.y},${pos.z}`; return false }
    try { await items.equipBestTool(bot, b); await build.withTimeout(bot.dig(b, true), 6000); out.dug++; return true } catch (e) { out.wall = `${b.name} ${pos.x},${pos.y},${pos.z}: ${e.message}`; return false }
  }
  for (let i = 0; i < steps && !ctl.aborted; i++) {
    await yieldTick()
    const p = bot.entity.position
    if (Math.hypot(target.x - p.x, target.z - p.z) < near) { out.arrived = true; break }
    if (i && i % 6 === 0) {
      const w = await walkTo(session, ctl, target, { range: near - 2, xz: true, timeoutMs: 12000 })
      if (w.ok) { out.arrived = true; out.walked = true; break }
    }
    const dx = target.x - p.x; const dz = target.z - p.z
    const d = Math.abs(dx) >= Math.abs(dz) ? { x: Math.sign(dx), z: 0 } : { x: 0, z: Math.sign(dz) }
    const f = p.floored()
    const ax = f.x + d.x; const az = f.z + d.z
    const at = (x, y, z) => bot.blockAt(new Vec3(x, y, z))
    const A0 = at(ax, f.y, az); const A1 = at(ax, f.y + 1, az)
    if (!A0 || !A1) { out.why = 'впереди не прогружено'; break }
    if (isSolid(A0)) {
      // Выше: проход над ступенькой и потолок над собой для прыжка.
      if (!(await digAt(new Vec3(ax, f.y + 1, az))) || !(await digAt(new Vec3(ax, f.y + 2, az))) || !(await digAt(new Vec3(f.x, f.y + 2, f.z)))) { out.why = 'стену не прокопать'; break }
      const r = await stepTo(bot, ctl, new Vec3(ax + 0.5, f.y + 1, az + 0.5), { ms: 2500, stopAt: 0.3, sprint: false })
      if (!r.ok) { out.why = `на ступеньку не встал: ${r.why}`; break }
    } else {
      if (!isAirish(A1) && isSolid(A1) && !(await digAt(new Vec3(ax, f.y + 1, az)))) { out.why = 'проход не прокопать'; break }
      let drop = null
      for (let k = 1; k <= 4; k++) { if (isSolid(at(ax, f.y - k, az))) { drop = k - 1; break } }
      if (drop === null) {
        bot.setControlState('sneak', true)
        const r = await build.placeBlockAt(bot, new Vec3(ax, f.y - 1, az), { steady: true, timeoutMs: 3000 })
        bot.setControlState('sneak', false)
        if (!r.ok) { out.why = `под ногами пусто, блок не встал: ${r.reason}`; break }
        out.placed++
      }
      await stepOnto(bot, ctl, ax, az)
      clearControls(bot)
    }
    out.steps++
  }
  clearControls(bot)
  return out
}

// ------------------------------------------------------------ точки

// Место, где стоять: кольцо радиусов вокруг center, ближайшее к prefer.
// Твёрдо под ногами, края нет в edge блоках, не в облаке, не в обелиске.
function pickSpot (bot, center, { rMin = 10, rMax = 16, prefer = null, edge = 3, avoid = null, nearY = null, step = 2 } = {}) {
  const me = prefer || bot.entity.position
  const clouds = cloudsOf(bot)
  let best = null
  for (let r = rMin; r <= rMax; r += step) {
    const n = Math.max(12, Math.round(2 * Math.PI * r / 2))
    for (let k = 0; k < n; k++) {
      const a = 2 * Math.PI * k / n
      const x = center.x + Math.cos(a) * r; const z = center.z + Math.sin(a) * r
      let y = null
      if (nearY != null) y = standY(bot, x, z, nearY, 4, 6)
      else {
        const sf = surfaceY(bot, x, z)
        if (sf && /^(end_stone|cobblestone)$/.test(sf.name)) y = sf.y
      }
      if (y == null) continue
      const feet = new Vec3(Math.floor(x) + 0.5, y, Math.floor(z) + 0.5)
      if (nearPortal(feet)) continue
      if (inClouds(clouds, feet, 1.5)) continue
      if (edge && nearEdge(bot, feet, edge)) continue
      if (avoid && avoid(feet)) continue
      const score = feet.distanceTo(me)
      if (!best || score < best.score) best = { feet, score, r }
    }
  }
  return best
}

// ------------------------------------------------------------ кристаллы

// Откуда стрелять в кристалл: с земли, не ближе безопасного к взрыву, так,
// чтобы стрела (крутая траектория — steep) прошла мимо блоков и прутьев.
function crystalShotSpot (bot, cr) {
  const me = bot.entity.position
  const clouds = cloudsOf(bot)
  const toC = { x: CENTER.x - cr.pos.x, z: CENTER.z - cr.pos.z }
  const base = Math.atan2(toC.z, toC.x)
  let best = null
  for (const R of [12, 15, 18, 22, 26, 30, 34, 38]) {
    for (let k = -8; k <= 8; k++) {
      const a = base + k * Math.PI / 12
      const x = cr.pos.x + Math.cos(a) * R; const z = cr.pos.z + Math.sin(a) * R
      const sf = surfaceY(bot, x, z)
      if (!sf || sf.name !== 'end_stone') continue
      const feet = new Vec3(Math.floor(x) + 0.5, sf.y, Math.floor(z) + 0.5)
      if (feet.distanceTo(cr.pos) < SAFE_FROM_CRYSTAL) continue
      if (inClouds(clouds, feet, 3)) continue
      if (nearEdge(bot, feet, 2)) continue
      const eye = feet.offset(0, EYE - 0.1, 0)
      // Пологая (крутая, но с подъёмом) или навесом: высокий обелиск своим
      // краем закрывает кристалл от стрелы снизу, навесная приходит сверху.
      for (const mode of [true, 'lob']) {
        const sol = bow.aim(eye, () => cr.aim, bow.SPEED, bow.GRAVITY, mode)
        if (!sol) continue
        if (bow.blockedAt(bot, eye, sol)) continue
        // Встанем не точно в центр клетки: путь должен быть чист и в треть
        // блока от неё, иначе на месте стрела зацепит край обелиска.
        const robust = [[0.35, 0], [-0.35, 0], [0, 0.35], [0, -0.35]].every(([ox, oz]) => {
          const e2 = eye.offset(ox, 0, oz)
          const s2 = bow.aim(e2, () => cr.aim, bow.SPEED, bow.GRAVITY, mode)
          return s2 && !bow.blockedAt(bot, e2, s2)
        })
        if (!robust) continue
        // Цена: дорога + крутизна + время полёта (дольше летит — шире разлёт).
        const cost = feet.distanceTo(me) + Math.max(0, sol.pitch - 1.0) * 20 + sol.ticks * 0.3 + (mode === 'lob' ? 10 : 0)
        if (!best || cost < best.cost) best = { feet, sol, cost, mode }
      }
    }
  }
  return best
}

// Дракон заходит на нас с фаерболом (StrafePlayer: стреляет, когда видит цель
// в 64 блоках пять тиков подряд) или таранит — не время стоять на месте.
function strafeThreat (bot) {
  const d = dragonOf(bot)
  if (!d) return false
  const ph = phaseOf(bot, d)
  return (ph === PHASE.STRAFE || ph === PHASE.CHARGING) && d.position.distanceTo(bot.entity.position) < 64
}
// Уйти вбок и не стоять: фаербол летит туда, где мы были в момент выстрела.
async function juke (session, ctl, stats, ms = 3000) {
  const bot = session.bot
  doing(ctl, 'juke')
  stats.dodges.заход = (stats.dodges.заход || 0) + 1
  const t0 = gameClock.now()
  let side = 1
  while (!ctl.aborted && gameClock.now() - t0 < ms) {
    await yieldTick()
    const bad = hazardNow(bot)
    if (bad) { await evade(bot, ctl, stats, bad); continue }
    const d = dragonOf(bot)
    const me = bot.entity.position
    const from = d ? d.position.minus(me) : new Vec3(1, 0, 0)
    const n = Math.hypot(from.x, from.z) || 1
    // Поперёк линии на дракона, 4 блока; если там край — в другую сторону.
    let target = me.offset(-from.z / n * 4 * side, 0, from.x / n * 4 * side)
    if (nearEdge(bot, target, 2) || inClouds(cloudsOf(bot), target, 2)) { side = -side; target = me.offset(-from.z / n * 4 * side, 0, from.x / n * 4 * side) }
    await stepTo(bot, ctl, target, { ms: 900, stopAt: 0.5 })
    side = -side
    if (!strafeThreat(bot)) break
  }
  clearControls(bot)
}

async function shootCrystal (session, ctl, cr, rep, stats) {
  const bot = session.bot
  const spot = crystalShotSpot(bot, cr)
  if (!spot) return { ok: false, why: 'нет места, откуда стрела долетит мимо блоков' }
  dbg('crystal', cr.id, 'spot', spot.feet.toString(), 'pitch', (spot.sol.pitch * 57.3).toFixed(0), spot.mode === 'lob' ? 'навесом' : '', 'ticks', spot.sol.ticks)
  doing(ctl, 'crystal:walk')
  if (spot.feet.distanceTo(bot.entity.position) > 1.5) {
    const w = await walkTo(session, ctl, spot.feet, { range: 0.8, timeoutMs: 45000 })
    if (!w.ok && spot.feet.distanceTo(bot.entity.position) > 3) return { ok: false, why: `не дошёл до точки выстрела: ${w.why}` }
  }
  const alive = () => !!bot.entities[cr.id] && bot.entities[cr.id].isValid !== false
  let stopWhy = null
  for (let shot = 0; shot < 6 && alive() && !ctl.aborted; shot++) {
    doing(ctl, 'crystal:shoot')
    stopWhy = null
    if (countOf(bot, /arrow$/) < 1) return { ok: false, why: 'стрелы кончились' }
    if (bot.entity.position.distanceTo(cr.pos) < SAFE_FROM_CRYSTAL) return { ok: false, why: 'слишком близко к кристаллу — взрыв' }
    // Заход с фаерболом сам по себе не повод бросать лук: фаербол виден с
    // первого пакета, и hazardNow уводит тело, когда он уже летит и упадёт
    // рядом (раньше каждый заход стоил ухода на 4 блока и 3.5 с).
    const bad0 = hazardNow(bot)
    if (bad0) { await evade(bot, ctl, stats, bad0); return { ok: false, why: `опасность: ${bad0.kind}`, moved: true } }
    const r = await bow.shoot(bot, cr.e, {
      point: () => cr.aim,
      steep: spot.mode,
      follow: false,
      mode: 'settle',
      shouldStop: () => {
        const why = ctl.aborted ? 'прервано' : !alive() ? 'кристалла нет' : starer(bot, bot.entity.yaw, bot.entity.pitch) ? 'взгляд в глаза эндермену' : hunters(bot, 4).length ? 'эндермен бьёт' : (hazardNow(bot) || {}).kind || null
        if (why) stopWhy = why
        return !!why
      }
    })
    if (hunters(bot, 4).length) await guard(session, ctl)
    if (!r.shot) {
      dbg('crystal shot refused', r.why, stopWhy)
      if (ctl.trace) ctl.trace.ev('shotRefused', { id: cr.id, why: r.why, stop: stopWhy })
      if (r.blocked) return { ok: false, why: r.why, blocked: true }
      continue
    }
    stats.arrows++
    // Стрела в полёте (навесом — до четырёх секунд): стоять можно, пока тихо.
    const wait = gameClock.now() + Math.min(6000, (r.flightTicks || 20) * 50 + 700)
    while (gameClock.now() < wait && alive() && !ctl.aborted) {
      const bad = hazardNow(bot)
      if (bad) { await evade(bot, ctl, stats, bad); break }
      await sleep(50)
    }
  }
  if (!alive()) { stats.crystals++; return { ok: true } }
  return { ok: false, why: 'шесть стрел — кристалл цел' }
}

// ------------------------------------------------------------ кристаллы с места ожидания (бой кроватями, 03.10)
// Решение пользователя (02.10 22:17): сбивать, если легко и не мешает убить быстрее, — луком. Пока дракон кружит (или заходит
// с фаерболом издалека) и станция готова: открытые кристаллы (без клетки) — стрелой с места ожидания у центра, по линии огня
// (траектория по тикам — bow.blockedAt; кристалл — сущность, которую видит клиент: трекинг 64). Клетки не трогаем.
// Механика (байткод paper 1.21.11, farm/dragon/javap-1.21.11):
//   · DragonHoldingPatternPhase.findNewTarget: в конце пути nextInt(живых + 3) == 0 → LANDING_APPROACH (10 живых — 1/13,
//     2 — 1/5); иначе STRAFE, если nextInt(⌊d²/512⌋ + 2) == 0 (d — от центра верха фонтана до игрока) или nextInt(живых + 2) == 0.
//   · DragonHoldingPatternPhase.onCrystalDestroyed: сбил игрок, пока кружит, — сразу STRAFE на него (фаербол); в других фазах
//     (заход с фаерболом, посадка) — ничего: следующие кристаллы во время захода «бесплатны».
//   · EnderDragon.onCrystalDestroyed: сбит тот, от которого он лечится (nearestCrystal), — голове 10 урона (взрыв).
//   · EnderDragon.checkCrystals: +1 хп раз в 10 тиков, пока nearestCrystal жив; выбор — раз в ~10 тиков среди кристаллов в его
//     коробке + 32. Сидящему у фонтана достают 8 обелисков из 10 — клетки (2) почти всегда среди них: лечение сидящего
//     остаётся, а в облёте — только у клеток; посадки чаще в 2.6 раза.
// ND_CRYSTALS=0 — не сбивать; ND_CRYS_KEEP — стрел оставить (6); ND_CRYS_TRIES — стрел на кристалл (4).
function crysOn () { return envv('ND_CRYSTALS') !== '0' }
const CRYS_BAND = [13, 30]
// Эксперимент r4, по умолчанию выкл. ND_CRYS_STRAFE_ONLY=1: не сбрасывать путь кружения своими кристаллами.
// Фаза на спуске проверяется снова; фазу в момент попадания гарантировать нельзя (стрела ещё летит).
function crystalTimingAllowed (ph, distance) {
  if (envv('ND_CRYS_STRAFE_ONLY') === '1') return ph === PHASE.STRAFE && distance > envNum('ND_CRYS_STRAFE_D', 24)
  return ph === PHASE.HOLDING || (ph === PHASE.STRAFE && distance > envNum('ND_CRYS_STRAFE_D', 24))
}
// До станции — только уже начатый STRAFE: выстрелы вместо повторной опасной стройки у фонтана.
// Снижение всегда получает управление; не ждём всех восьми кристаллов перед цепочкой кроватей.
async function earlyCrystalStep (session, ctl, stats, d, ph) {
  const bot = session.bot
  if (envv('ND_CRYS_EARLY') !== '1' || !crysOn() || !ctl.pillarMode || (ctl.pillar && ctl.pillar.built) ||
      ph !== PHASE.STRAFE || !d || bot.health < 12 || countOf(bot, /_bed$/) < 1 ||
      Math.hypot(bot.entity.position.x - CENTER.x, bot.entity.position.z - CENTER.z) >= 30) return false
  return crystalWait(session, ctl, stats, d, ph)
}
function crystalShotFrom (bot, cr, feet) {
  const dist = feet.distanceTo(cr.pos)
  if (dist < SAFE_FROM_CRYSTAL + 0.5 || Math.hypot(cr.pos.x - feet.x, cr.pos.z - feet.z) > 60) return null
  const eye = feet.offset(0, EYE - 0.1, 0)
  for (const mode of [true, 'lob']) {
    const sol = bow.aim(eye, () => cr.aim, bow.SPEED, bow.GRAVITY, mode)
    if (!sol || bow.blockedAt(bot, eye, sol)) continue
    // запас: глаза в 0.3 вбок и цель на 0.6 ниже (край обелиска снизу) — путь тоже чист
    const low = cr.aim.offset(0, -0.6, 0)
    const sLow = bow.aim(eye, () => low, bow.SPEED, bow.GRAVITY, mode)
    if (!sLow || bow.blockedAt(bot, eye, sLow)) continue
    const robust = [[0.3, 0], [-0.3, 0], [0, 0.3], [0, -0.3]].every(([ox, oz]) => {
      const e2 = eye.offset(ox, 0, oz)
      const s2 = bow.aim(e2, () => cr.aim, bow.SPEED, bow.GRAVITY, mode)
      return s2 && !bow.blockedAt(bot, e2, s2)
    })
    if (!robust) continue
    return { sol, mode, ticks: sol.ticks, cost: sol.ticks + (mode === 'lob' ? 25 : 0) }
  }
  return null
}
// Память о кристаллах боя: id → {pos, bars, gone}. Сбит — исчез, пока до него по горизонтали < 58 (трекинг сервера — 64).
function crysState (bot, ctl) {
  const C = ctl.crys || (ctl.crys = { known: new Map(), tries: new Map(), pending: new Map(), ban: new Map(), noSpotUntil: 0, shots: 0, hits: 0, moves: 0, active: false, firstShot: null })
  const me = bot.entity.position
  const seen = new Set()
  // клетка кристалла не меняется — прутья считать один раз на кристалл (cageBars — 100 блоков)
  for (const e of Object.values(bot.entities)) {
    if (!e || e.name !== 'end_crystal' || !e.position || e.isValid === false) continue
    if (Math.hypot(e.position.x - CENTER.x, e.position.z - CENTER.z) <= 20) continue
    seen.add(e.id)
    const k = C.known.get(e.id)
    if (k && !k.gone) continue
    const cx = Math.floor(e.position.x); const cz = Math.floor(e.position.z); const top = Math.floor(e.position.y) - 1
    C.known.set(e.id, { id: e.id, pos: e.position.clone(), aim: e.position.offset(0, 1, 0), bars: cageBars(bot, cx, top, cz).length, gone: false, cx, cz, top })
    if (!k && ctl.trace) { const ks = [...C.known.values()]; ctl.trace.ev('crysKnown', { id: e.id, y: r1(e.position.y), caged: C.known.get(e.id).bars > 0, n: ks.length, open: ks.filter(x => x.bars === 0).length }) }
  }
  for (const k of C.known.values()) {
    if (k.gone || seen.has(k.id)) continue
    if (Math.hypot(k.pos.x - me.x, k.pos.z - me.z) < 58) {
      k.gone = true
      const ours = C.pending.has(k.id)
      if (ours) { C.hits++; if (ctl.stats) ctl.stats.crystals = (ctl.stats.crystals || 0) + 1 }
      if (ctl.trace) ctl.trace.ev('crysGone', { id: k.id, ours, at: [r1(k.pos.x), r1(k.pos.y), r1(k.pos.z)], left: [...C.known.values()].filter(x => !x.gone).length })
    }
  }
  return C
}
function crysAlive (ctl) { return ctl.crys ? [...ctl.crys.known.values()].filter(k => !k.gone).length : null }
// Открытые живые кристаллы, по которым ещё стоит стрелять.
function crysTargets (bot, ctl) {
  const C = crysState(bot, ctl)
  const tries = envNum('ND_CRYS_TRIES', 4)
  return [...C.known.values()].filter(k => !k.gone && k.bars === 0 && (C.tries.get(k.id) || 0) < tries)
}
// Точка у центра (кольца 14–29), откуда есть выстрел хоть по одному из целей; ближайшая к нам.
async function crystalSpot (bot, targets, me, bad = []) {
  const P0 = podiumTop(bot)
  const clouds = cloudsOf(bot)
  const cand = []
  for (let r = 14; r <= 29; r += 2.5) {
    const n = Math.round(2 * Math.PI * r / 2.2)
    for (let k = 0; k < n; k++) {
      const a = 2 * Math.PI * k / n
      const x = CENTER.x + Math.cos(a) * r; const z = CENTER.z + Math.sin(a) * r
      if (Math.hypot(x - me.x, z - me.z) > 30) continue
      const sf = surfaceY(bot, x, z)
      if (!sf || !/^(end_stone|cobblestone)$/.test(sf.name)) continue
      const feet = new Vec3(Math.floor(x) + 0.5, sf.y, Math.floor(z) + 0.5)
      if (P0 != null && feet.y > P0 + 4) continue
      // где стоим — уже проверено (выстрела нет); точки, где «дошёл, а выстрела нет», — тоже (ca1-s14: 1034 перехода
      // на 0.1–0.2 бл. за 19 с — точка по центру клетки годна, с места в 0.2 от неё — нет)
      if (feet.distanceTo(me) < 1.2 || bad.some(b => b.distanceTo(feet) < 1.5)) continue
      cand.push({ feet, d: feet.distanceTo(me) })
    }
  }
  cand.sort((a, b) => a.d - b.d)
  let n = 0
  for (const c of cand) {
    if (++n > 90) break
    if (n % 6 === 0) await yieldTick()
    if (nearPortal(c.feet) || inClouds(clouds, c.feet, 2) || nearEdge(bot, c.feet, 2) || nearPillar(bot, c.feet, 3)) continue
    let best = null
    for (const t of targets) {
      const s = crystalShotFrom(bot, t, c.feet)
      if (s && (!best || s.cost < best.s.cost)) best = { t, s }
    }
    if (best) return { feet: c.feet, id: best.t.id, ticks: best.s.ticks, mode: best.s.mode }
  }
  return null
}
// Один шаг: выстрел отсюда или переход к точке выстрела. true — что-то сделал (цикл боя — заново), false — нечего.
async function crystalWait (session, ctl, stats, d, ph) {
  const bot = session.bot
  const C = crysState(bot, ctl)
  const keep = envNum('ND_CRYS_KEEP', 6)
  if (!findItem(bot, /^bow$/) || countOf(bot, /arrow$/) <= keep) { C.active = false; return false }
  const targets = crysTargets(bot, ctl)
  if (!targets.length) { C.active = false; return false }
  C.active = true
  const now = gameClock.now()
  // свои стрелы в полёте — ждать (промах — после полёта + 0.6 с: кристалл цел)
  const free = targets.filter(t => !((C.pending.get(t.id) || 0) > now))
  // почему не стреляем (трасса, не чаще раза в 3 с на причину)
  const idle = (why, o = {}) => { C.idleT = C.idleT || {}; if (ctl.trace && now - (C.idleT[why] || 0) > 3000) { C.idleT[why] = now; ctl.trace.ev('crysIdle', { why, left: targets.length, free: free.length, ph, ...o }) } return false }
  if (!free.length) return idle('стрелы в полёте')
  if (bot.health < 10) return idle('мало хп')
  if (hunters(bot, 6).length) return idle('эндермен')
  { const hz = hazardNow(bot); if (hz) return idle('опасность', { kind: hz.kind }) }
  // Заход с фаерболом (STRAFE): сбитый сейчас кристалл нового захода не вызывает — стрелять, пока дракон не ближе
  // ND_CRYS_STRAFE_D (24); фаербол в полёте — hazardNow выше и shouldStop при натяжении.
  const dD = d.position.distanceTo(bot.entity.position)
  if (!crystalTimingAllowed(ph, dD)) return idle('фаза', { dD: r1(dD) })
  const me = bot.entity.position
  const feet = new Vec3(me.x, me.y, me.z)
  let best = null
  let stareSkip = 0
  for (const t of free) {
    const live = bot.entities[t.id]
    if (!live || live.isValid === false) continue
    const ban = C.ban.get(t.id)
    if (ban && ban.distanceTo(feet) < 1.5) continue
    const s = crystalShotFrom(bot, t, feet)
    // прицел на этот кристалл смотрит эндермену в глаза — не начинать натяжение (ca2-s17: 122 отмены «взгляд в глаза» за 16 с)
    if (s && starer(bot, s.sol.yaw, s.sol.pitch)) { stareSkip = (stareSkip || 0) + 1; continue }
    if (s && (!best || s.cost < best.s.cost)) best = { t, s, e: live }
  }
  if (!best && stareSkip) return idle('эндермен на линии')
  if (best) {
    doing(ctl, 'crystal:wait-shot')
    const { t, s, e } = best
    const alive = () => !!bot.entities[t.id] && bot.entities[t.id].isValid !== false
    let stopWhy = null
    let releasePh = null; let releaseAt = null
    const hp0 = d ? hpOf(bot, d) : null
    const r = await bow.shoot(bot, e, {
      point: () => t.aim,
      steep: s.mode,
      follow: false,
      mode: 'settle',
      onRelease: () => { const dd = dragonOf(bot); releasePh = dd ? phaseOf(bot, dd) : null; releaseAt = gameClock.now() },
      shouldStop: () => {
        const dd = dragonOf(bot); const p2 = dd ? phaseOf(bot, dd) : null
        const why = ctl.aborted ? 'прервано' : !alive() ? 'кристалла нет'
          : (envv('ND_CRYS_STRAFE_ONLY') === '1' ? !dd || !crystalTimingAllowed(p2, dd.position.distanceTo(bot.entity.position)) : p2 !== PHASE.HOLDING && p2 !== PHASE.STRAFE) ? 'фаза/дистанция ' + (PHASE_RU[p2] ?? p2)
            : starer(bot, bot.entity.yaw, bot.entity.pitch) ? 'взгляд в глаза эндермену' : hunters(bot, 4).length ? 'эндермен бьёт' : (hazardNow(bot) || {}).kind || null
        if (why) stopWhy = why
        return !!why
      }
    })
    if (!r.shot) {
      if (r.blocked) C.ban.set(t.id, feet.clone())
      if (ctl.trace) ctl.trace.ev('crysRefused', { id: t.id, why: r.why, stop: stopWhy })
      return !!stopWhy
    }
    C.shots++
    stats.arrows++
    stats.crysArrows = (stats.crysArrows || 0) + 1
    C.tries.set(t.id, (C.tries.get(t.id) || 0) + 1)
    C.pending.set(t.id, gameClock.now() + (r.flightTicks || s.ticks || 20) * 50 + 600)
    if (C.firstShot == null) C.firstShot = gameClock.now()
    if (ctl.trace) ctl.trace.ev('crysShot', { id: t.id, y: r1(t.pos.y), mode: s.mode === 'lob' ? 'lob' : 'steep', ticks: r1(s.ticks), dist: r1(feet.distanceTo(t.pos)), pitch: r.pitchDeg, ph, releasePh, releaseAt, dHp: hp0 != null ? r1(hp0) : null, at: [r1(feet.x), r1(feet.y), r1(feet.z)], n: C.tries.get(t.id), arrows: countOf(bot, /arrow$/) })
    return true
  }
  if (now < C.noSpotUntil) return idle('нет точки (пауза)')
  // пришли к точке выстрела, а выстрела с места нет — точку в «плохие»
  C.bad = C.bad || []
  if (C.lastMove && C.lastMove.distanceTo(me) < 1.2) { C.bad.push(C.lastMove); C.lastMove = null }
  const spot = await crystalSpot(bot, free, me, C.bad)
  if (!spot) { C.noSpotUntil = now + 10000; if (ctl.trace) ctl.trace.ev('crysNoSpot', { left: free.length }); return false }
  doing(ctl, 'crystal:wait-move')
  C.moves++
  C.lastMove = spot.feet
  if (ctl.trace) ctl.trace.ev('crysMove', { to: [r1(spot.feet.x), spot.feet.y, r1(spot.feet.z)], d: r1(spot.feet.distanceTo(me)), id: spot.id, mode: spot.mode === 'lob' ? 'lob' : 'steep' })
  if (spot.feet.distanceTo(me) > 6) await walkTo(session, ctl, spot.feet, { range: 0.8, timeoutMs: 12000, sprint: true, digCost: 4 })
  else await stepTo(bot, ctl, spot.feet, { ms: 2500, stopAt: 0.4 })
  clearControls(bot)
  // не дошли (облако, путь) — к этой точке 10 с не возвращаться
  if (bot.entity.position.distanceTo(spot.feet) > 2) C.noSpotUntil = gameClock.now() + 10000
  return true
}

// Быстрый столб: прыжок зажат, блок под ноги, как только ноги поднялись на
// 1.02 над будущим блоком. Сервер ставит блок, только если наш хитбокс уже
// над клеткой — по позиции нашего последнего пакета (BlockItem.canPlace →
// isUnobstructed), поэтому установка уходит после пакета позиции этого тика
// (setImmediate), а не до. Около 10 тиков на блок — задержка автопрыжка
// (LivingEntity.noJumpDelay = 10); build.towerUp — вдвое медленнее: пауза
// 250 мс и ожидание подтверждения на каждый блок. abortIf() — причина бросить.
async function fastTower (bot, ctl, toY, { abortIf = null, maxMs = 40000 } = {}) {
  const filler = () => bot.inventory.items().find(i => FILLER_RE.test(i.name))
  let it = filler()
  if (!it) return { ok: false, why: 'нечем строить', placed: 0 }
  clearControls(bot)
  await bot.equip(it, 'hand').catch(() => {})
  await bot.look(bot.entity.yaw, -Math.PI / 2, true).catch(() => {})
  const fx = Math.floor(bot.entity.position.x); const fz = Math.floor(bot.entity.position.z)
  let top = Math.floor(bot.entity.position.y + 0.01)
  const t0 = gameClock.now()
  let placed = 0
  let pending = 0
  let why = null
  bot.setControlState('sneak', true)
  bot.setControlState('jump', true)
  try {
    while (!ctl.aborted && top < toY && gameClock.now() - t0 < maxMs) {
      await new Promise(resolve => bot.once('physicsTick', resolve))
      why = abortIf ? abortIf() : null
      if (why) break
      const cell = bot.blockAt(new Vec3(fx, top, fz))
      if (cell && isSolid(cell)) { top++; placed++; pending = 0; continue }
      const head = bot.blockAt(new Vec3(fx, top + 2, fz))
      if (head && isSolid(head)) { why = `потолок ${head.name}`; break }
      if (pending && gameClock.now() - pending < 450) continue
      if (bot.entity.position.y - top < 1.02) continue
      if (!bot.heldItem || !FILLER_RE.test(bot.heldItem.name)) {
        it = filler()
        if (!it) { why = 'кончились блоки'; break }
        await bot.equip(it, 'hand').catch(() => {})
        continue
      }
      const ref = bot.blockAt(new Vec3(fx, top - 1, fz))
      if (!ref || !isSolid(ref)) { why = 'под столбом пусто'; break }
      pending = gameClock.now()
      afterPositionPacket(bot, () => { bot._genericPlace(ref, new Vec3(0, 1, 0), { forceLook: 'ignore', swingArm: 'right' }).catch(() => {}) })
    }
  } finally {
    bot.setControlState('jump', false)
    bot.setControlState('forward', false); bot.setControlState('back', false)
    bot.setControlState('left', false); bot.setControlState('right', false)
    // Встать на поставленный блок крадучись — потом отпускать.
    const tl = gameClock.now()
    while (!ctl.aborted && !bot.entity.onGround && gameClock.now() - tl < 600) await sleep(50)
    bot.setControlState('sneak', false)
  }
  if (!why && top < toY) why = ctl.aborted ? 'прервано' : 'не успел'
  return { ok: top >= toY, placed, y: top, why, ms: gameClock.now() - t0 }
}

// Выстрел в упор по точке: натянуть 1.15 с, глядя в точку, отпустить. Сервер
// пускает стрелу по нашему последнему взгляду (BowItem.releaseUsing →
// shootFromRotation), а взгляд мы шлём каждый тик — к спуску он уже у сервера.
async function pointBlank (bot, ctl, pointOf, stop = null) {
  const point = typeof pointOf === 'function' ? pointOf : () => pointOf
  const bowItem = findItem(bot, /^bow$/)
  if (!bowItem) return { shot: false, why: 'лука нет' }
  if (countOf(bot, /arrow$/) < 1) return { shot: false, why: 'стрел нет' }
  clearControls(bot)
  try { await bot.equip(bowItem, 'hand') } catch (e) { return { shot: false, why: e.message } }
  await bot.lookAt(point(), true).catch(() => {})
  bot.activateItem()
  const t0 = gameClock.now()
  while (gameClock.now() - t0 < 1200) {
    if (ctl.aborted || (stop && stop())) { bot.deactivateItem(); return { shot: false, why: 'отменил натяжение' } }
    await bot.lookAt(point(), true).catch(() => {})
    await sleep(50)
  }
  await new Promise(resolve => bot.once('physicsTick', resolve))
  bot.deactivateItem()
  return { shot: true }
}

// Сойти со столба шагом в сторону (dir) и упасть: ведро воды под ноги кладёт
// fallGuard (Entity.move гасит падение сквозь воду). Шаг клавишами без проверки
// «впереди обрыв» — обрыв здесь и нужен. Земля под точкой падения — проверить
// заранее: не пустота и не лава.
function dropSpot (bot, dir) {
  const p = bot.entity.position
  for (const k of [1, 2]) {
    const x = Math.floor(p.x) + dir.x * k; const z = Math.floor(p.z) + dir.z * k
    const land = surfaceY(bot, x + 0.5, z + 0.5, Math.floor(p.y) - 1)
    if (!land || voidBelow(bot, x + 0.5, land.y + 0.5, z + 0.5, 4)) continue
    if (/lava|fire|portal/.test(land.name)) continue
    if (inClouds(cloudsOf(bot), new Vec3(x + 0.5, land.y, z + 0.5), 1.5)) continue
    // Сбоку по пути падения — воздух (иначе зацепимся за свой же мост).
    let clear = true
    for (let y = land.y; y < Math.floor(p.y) + 2 && clear; y++) {
      const b = bot.blockAt(new Vec3(x, y, z))
      if (b && isSolid(b)) clear = false
    }
    if (clear) return { x: x + 0.5, z: z + 0.5, landY: land.y, k }
  }
  return null
}
async function dropOff (bot, ctl, stats, dir, why) {
  const spot = dropSpot(bot, dir)
  if (!spot) return { ok: false, why: 'спрыгнуть некуда' }
  const water = bot.inventory.slots.some((it, k) => k >= 36 && k <= 44 && it && it.name === 'water_bucket')
  const fall = bot.entity.position.y - spot.landY
  if (!water && fall > 6) return { ok: false, why: 'без ведра в хотбаре со столба не прыгаю' }
  stats.drops = (stats.drops || 0) + 1
  if (ctl.trace) ctl.trace.ev('drop', { why, fall: r1(fall), water })
  clearControls(bot)
  const yaw = Math.atan2(-(spot.x - bot.entity.position.x), -(spot.z - bot.entity.position.z))
  await bot.look(yaw, 0, true).catch(() => {})
  const hp0 = bot.health
  const y0 = bot.entity.position.y
  // Сперва на ноги: сброс, начатый в прыжке (последний блок столба), сразу видел
  // «не на земле», шагал 120 мс и оставался на краю — «спрыгнул», а стоял
  // на столбе в 20 блоках (v2-26, 30.09, 188 с; дальше облако, крылья, смерть).
  const tg = gameClock.now()
  while (!ctl.aborted && !bot.entity.onGround && gameClock.now() - tg < 800) await sleep(50)
  bot.setControlState('sneak', false)
  bot.setControlState('forward', true)
  const t0 = gameClock.now()
  while (!ctl.aborted && gameClock.now() - t0 < 1500 && bot.entity.onGround) await sleep(50)
  await sleep(120)
  bot.setControlState('forward', false)
  const t1 = gameClock.now()
  while (!ctl.aborted && gameClock.now() - t1 < 4000 && !bot.entity.onGround && !bot.entity.isInWater) await sleep(50)
  await sleep(600)
  await waterToHotbar(bot).catch(() => {})
  if (y0 - bot.entity.position.y < 2) return { ok: false, why: 'не спрыгнул — стою на столбе' }
  return { ok: true, fall: r1(fall), lost: r1(Math.max(0, hp0 - bot.health)) }
}

// Стоим на обелиске (сбросило со столба у клетки на соседний шип — c3-19,
// 30.09): обсидиан киркой не взять, pathfinder вниз на 15–20 блоков не ходит.
// К краю верхушки в сторону центра (крадучись) и спрыгнуть: с ведром — как со
// столба, без ведра — только если падение оставит 4 хп.
// Стоим на своём столбе (4+ блока наполнителя до земли острова): сброс со столба у
// клетки не удался, бой пошёл прямо с верхушки (v2-26, 30.09: «стрелял» с 21
// блока, крылья, облако, смерть). Верх земли под столбом или null.
function onOwnPillar (bot) {
  const sup = supportCell(bot)
  if (!sup) return null
  let y = sup.y; let n = 0
  for (; y > sup.y - 40; y--) {
    const b = bot.blockAt(new Vec3(sup.x, y, sup.z))
    if (!b || !isSolid(b) || !FILLER_RE.test(b.name) || b.name === 'end_stone') break
    n++
  }
  if (n < 4) return null
  const g = bot.blockAt(new Vec3(sup.x, y, sup.z))
  if (!g || g.name !== 'end_stone') return null
  return { gy: y + 1, n }
}
function onSpike (bot) {
  const sup = supportCell(bot)
  if (!sup) return false
  const b = bot.blockAt(sup)
  if (!b || b.name !== 'obsidian') return false
  if (Math.hypot(sup.x + 0.5 - CENTER.x, sup.z + 0.5 - CENTER.z) < 30 || offIsland(bot, sup)) return false
  const g = surfaceY(bot, sup.x + 0.5 + Math.sign(CENTER.x - sup.x) * 7, sup.z + 0.5 + Math.sign(CENTER.z - sup.z) * 7, sup.y)
  return !g || sup.y + 1 - g.y > 5
}
async function getDown (session, ctl, stats) {
  const bot = session.bot
  doing(ctl, 'spike:down')
  const me = bot.entity.position
  const toC = { x: CENTER.x - me.x, z: CENTER.z - me.z }
  const dirs = Math.abs(toC.x) >= Math.abs(toC.z)
    ? [{ x: Math.sign(toC.x), z: 0 }, { x: 0, z: Math.sign(toC.z) || 1 }, { x: 0, z: -(Math.sign(toC.z) || 1) }]
    : [{ x: 0, z: Math.sign(toC.z) }, { x: Math.sign(toC.x) || 1, z: 0 }, { x: -(Math.sign(toC.x) || 1), z: 0 }]
  await waterToHotbar(bot)
  for (const dir of dirs) {
    if (ctl.aborted) break
    // К краю: крадучись по dir, пока следующая клетка — верхушка.
    bot.setControlState('sneak', true)
    for (let k = 0; k < 8; k++) {
      const p = bot.entity.position
      const nx = Math.floor(p.x) + dir.x; const nz = Math.floor(p.z) + dir.z
      if (!isSolid(bot.blockAt(new Vec3(nx, Math.floor(p.y + 0.01) - 1, nz)))) break
      await stepOnto(bot, ctl, nx, nz)
    }
    bot.setControlState('sneak', false)
    const spot = dropSpot(bot, dir)
    if (!spot) continue
    const water = bot.inventory.slots.some((it, k) => k >= 36 && k <= 44 && it && it.name === 'water_bucket')
    const fall = bot.entity.position.y - spot.landY
    if (!water && fall - 3 > bot.health - 4) continue
    if (ctl.trace) ctl.trace.ev('spikeDown', { fall: r1(fall), water })
    if (water) { const r = await dropOff(bot, ctl, stats, dir, 'обелиск'); if (r.ok) return true; continue }
    // Без ведра — шагом с края (урон падения — высота − 3).
    const yaw = Math.atan2(-(spot.x - bot.entity.position.x), -(spot.z - bot.entity.position.z))
    await bot.look(yaw, 0, true).catch(() => {})
    bot.setControlState('forward', true)
    const t0 = gameClock.now()
    while (!ctl.aborted && gameClock.now() - t0 < 900 && bot.entity.onGround) await sleep(50)
    bot.setControlState('forward', false)
    const t1 = gameClock.now()
    while (!ctl.aborted && gameClock.now() - t1 < 4000 && !bot.entity.onGround) await sleep(50)
    return true
  }
  return false
}

// Вниз со своего столба, выкапывая блок под ногами. Дракон мог пролететь
// сквозь столб и выбить середину (EnderDragon.checkWalls): тогда под ногами
// висит блок над пустотой, и копать его — упасть на всю высоту (прогон
// repro1, 207 с: 16 блоков, 9 хп). Поэтому перед каждым блоком — блок ниже:
// пусто — подложить его к нижней грани того, на котором стоим (сервер
// проверяет только дальность до грани, handleUseItemOn).
async function digDownTo (bot, ctl, gy, max = 40, abortIf = null) {
  let dug = 0; let fails = 0; let patched = 0
  clearControls(bot)
  let cloudWait = 0
  while (!ctl.aborted && Math.floor(bot.entity.position.y + 0.01) > gy && dug < max && fails < 4) {
    await yieldTick()
    const stopWhy = abortIf && abortIf()
    if (stopWhy) return { dug, patched, why: stopWhy }
    const feet = bot.entity.position.floored()
    // Облако под столбом (фаербол лёг у ног): блок вниз — ноги в его полблоке,
    // удар 6 и отбрасывание от центра облака — со столба 1×1 в падение (c2-27,
    // 30.09, 252 с: копал сквозь облако, удар, сброс с 21 блока). Стоять на
    // блок выше облака, пока не уйдёт (живёт 30 с).
    const lower = new Vec3(bot.entity.position.x, feet.y - 1, bot.entity.position.z)
    if (cloudsOf(bot).some(c => cloudHits(c, lower, 0.6) || cloudHits(c, lower.offset(0, -1, 0), 0.6))) {
      if (cloudWait === 0) cloudWait = gameClock.now()
      if (gameClock.now() - cloudWait > 32000) return { dug, patched, why: 'облако под столбом' }
      clearControls(bot)
      await sleep(250)
      continue
    }
    cloudWait = 0
    const under = bot.blockAt(feet.offset(0, -1, 0))
    if (!under) return { dug, patched, why: 'под ногами не прогружено' }
    if (!isSolid(under)) {
      // клетка под серединой уже вырыта, а тело висит на краю соседней (коробка 0.6 — hb3: «окоп: не спустился» 9 раз,
      // ноги в 0.3 от середины): шаг к середине своей клетки, без «крадучись» — и падает в яму
      if (bot.entity.onGround) {
        const cx = feet.x + 0.5; const cz = feet.z + 0.5
        const p = bot.entity.position
        clearControls(bot)
        await bot.look(Math.atan2(-(cx - p.x), -(cz - p.z)), 0, true).catch(() => {})
        bot.setControlState('forward', true)
        await sleep(110)
        bot.setControlState('forward', false)
        const tn = gameClock.now()
        while (bot.entity.onGround && Math.floor(bot.entity.position.y + 0.01) === feet.y && gameClock.now() - tn < 400) await sleep(50)
        while (!bot.entity.onGround && gameClock.now() - tn < 1200) await sleep(50)
        if (Math.floor(bot.entity.position.y + 0.01) < feet.y) continue
      }
      await sleep(150); fails++; continue
    }
    if (!FILLER_RE.test(under.name) && under.name !== 'end_stone') return { dug, patched, why: `под ногами ${under.name}` }
    const below = bot.blockAt(feet.offset(0, -2, 0))
    // и на последнем шаге: пол под целью (pil5-19: окоп на 2 — провалился на 3, «не спустился» каждую посадку)
    if (feet.y - 1 >= gy && below && !isSolid(below) && !/water|lava/.test(below.name)) {
      const r = await build.placeBlockAt(bot, below.position, { timeoutMs: 2000, item: fillerItem(bot) })
      if (!r.ok) return { dug, patched, why: `дыра под столбом, подложить не вышло: ${r.reason}` }
      patched++
    }
    try {
      await items.equipBestTool(bot, under)
      await bot.look(bot.entity.yaw, -Math.PI / 2, true)
      await build.withTimeout(bot.dig(under, true), 6000)
      dug++
      const t0 = gameClock.now()
      while (bot.entity.position.y > under.position.y + 0.05 && gameClock.now() - t0 < 1500) await sleep(50)
      const t1 = gameClock.now()
      while (!bot.entity.onGround && gameClock.now() - t1 < 1000) await sleep(50)
    } catch (e) { dbg('down', e.message); fails++; await sleep(200) }
  }
  return { dug, patched, why: Math.floor(bot.entity.position.y + 0.01) > gy ? 'не спустился до земли' : null }
}

// Когда лезть на столб у клетки нельзя: дракон сидит (а мы дальше 20 блоков —
// через 100 тиков он взлетит тараном прямо в нас, DragonSittingScanningPhase),
// таранит, садится рядом, или заходит на нас с фаерболом в 64 блоках.
function towerUnsafe (bot) {
  const d = dragonOf(bot)
  if (!d) return null
  const ph = phaseOf(bot, d)
  const dist = d.position.distanceTo(bot.entity.position)
  if (SITTING.has(ph)) return 'дракон сидит — будет таран'
  if (ph === PHASE.CHARGING) return 'таран'
  if (ph === PHASE.STRAFE && dist < 70) return 'заходит с фаерболом'
  if (ph === PHASE.LANDING) return 'садится'
  return null
}

// Кристалл в клетке (обелиски j = 1, 2 — высота 79 и 82, радиус 2, SpikeFeature):
// прутья на |dx| = 2 или |dz| = 2 от уровня bedrock (top) до top+3 и сплошная
// решётка сверху (top+3). Приём (2026-09-26): столб вплотную к стене клетки до
// ног на top+2, один прут — средний столбец стены, верхний ряд (top+3), — и
// выстрел в эту дыру с двух блоков чуть вниз, в верх коробки кристалла (2×2×2
// от top+1). Взрыв (мощность 6, центр — ноги кристалла на top+1) бьёт нас
// только лучами, дошедшими до точек нашей коробки (ServerExplosion.
// getSeenPercent): тело от top+2 до top+3.8, а лучи к top+1 режут стену клетки
// ниже top+3 — там целые прутья (сопротивление 6), лучи гаснут, урон —
// единица. Раньше: столб до уровня bedrock, девять прутьев киркой по 1.25 с,
// спуск, отход на 13+ блоков и выстрел снизу в дыру — 60–100 с на клетку; в
// трёх прогонах из трёх дракон за это время садился и взлетал тараном в тело на
// столбе или сносил столб (EnderDragon.checkWalls: булыжник не в
// #dragon_immune). Любая угроза на столбе — шаг вниз (ведро гасит падение).
async function openCage (session, ctl, cr, rep, stats) {
  const bot = session.bot
  const t0 = gameClock.now()
  const toC = { x: CENTER.x - cr.pos.x, z: CENTER.z - cr.pos.z }
  // Сторона — к центру острова (там земля и туда же прыгать вниз), потом
  // боковые, потом дальняя. Сторону, где уже стоит наш столб от прошлой
  // попытки (4+ блока булыжника над землёй), пропустить: встать на него нельзя,
  // а его верх сбивал расчёт земли (сцена cage 2026-09-26: «потолок»).
  const main = Math.abs(toC.x) >= Math.abs(toC.z) ? { x: Math.sign(toC.x), z: 0 } : { x: 0, z: Math.sign(toC.z) }
  // Место столба — стена клетки, по три клетки вдоль каждой стороны (сдвиг
  // вбок off = −1, 0, 1: дыра тогда в пруте того же сдвига, стена клетки —
  // пять прутьев в ширину), сперва середины сторон.
  const faces = [main, { x: -main.z, z: main.x }, { x: main.z, z: -main.x }, { x: -main.x, z: -main.z }]
  const sides = []
  for (const off of [0, 1, -1]) for (const f of faces) sides.push({ ...f, off })
  let s = null; let tx = 0; let tz = 0; let sf = null; let off = 0
  const skipped = []
  for (const cand of sides) {
    const x = cr.cx + 3 * cand.x - cand.z * cand.off; const z = cr.cz + 3 * cand.z + cand.x * cand.off
    const top = surfaceY(bot, x + 0.5, z + 0.5, cr.top + 3)
    if (!top) { skipped.push(`${x},${z}: пусто`); continue }
    let ground = top
    // Наш блок — наполнитель, но не эндерняк (эндерняк — сама земля острова).
    const ours = n => FILLER_RE.test(n) && n !== 'end_stone'
    if (ours(top.name)) {
      // Столб из наших блоков: спуститься по нему до естественной земли.
      let y = top.y - 1
      while (y > 0 && bot.blockAt(new Vec3(x, y, z)) && ours(bot.blockAt(new Vec3(x, y, z)).name)) y--
      if (top.y - (y + 1) >= 4) { skipped.push(`${x},${z}: наш столб`); continue }
      const nat = bot.blockAt(new Vec3(x, y, z))
      ground = nat && isSolid(nat) ? { y: top.y, name: nat.name } : null
    }
    if (!ground || !/^(end_stone|cobblestone|cobbled_deepslate|dirt|stone|netherrack)$/.test(ground.name)) { skipped.push(`${x},${z}: ${ground ? ground.name : 'пусто'}`); continue }
    if (voidBelow(bot, x + 0.5, ground.y, z + 0.5, 6)) { skipped.push(`${x},${z}: пустота`); continue }
    // Облако у основания столба: и столб растёт из него, и спрыгнуть придётся в
    // него (d3-22, 30.09: столб в облаке фаербола, спуск в него же — смерть).
    if (inClouds(cloudsOf(bot), new Vec3(x + 0.5, ground.y, z + 0.5), 2)) { skipped.push(`${x},${z}: облако`); continue }
    s = { x: cand.x, z: cand.z }; tx = x; tz = z; sf = ground; off = cand.off
    break
  }
  if (!s) return { ok: false, why: `под столб нет места: ${skipped.join('; ')}` }
  const gy = sf.y
  const topY = cr.top + 2
  const need = topY - gy
  if (countOf(bot, FILLER_RE) < need + 6) await mineEndStone(session, ctl, need + 12, stats)
  if (countOf(bot, FILLER_RE) < need + 6) return { ok: false, why: `на столб нужно ${need + 6} блоков, есть ${countOf(bot, FILLER_RE)}` }
  const base = new Vec3(tx + 0.5, gy, tz + 0.5)
  doing(ctl, 'cage:walk')
  const w = await walkTo(session, ctl, base, { range: 0.5, timeoutMs: 45000 })
  if (!w.ok && Math.hypot(bot.entity.position.x - base.x, bot.entity.position.z - base.z) > 1.2) return { ok: false, why: `не дошёл до столба: ${w.why}` }
  const cage = { at: { x: cr.cx, y: cr.top, z: cr.cz }, tower: need }
  rep.cages = rep.cages || []
  rep.cages.push(cage)
  // Окно: на столбе от тарана и фаербола не уйти — только вниз.
  doing(ctl, 'cage:wait')
  const tw = gameClock.now()
  let stage = null
  while (!ctl.aborted && towerUnsafe(bot) && gameClock.now() - tw < 60000) {
    await yieldTick()
    const bad = hazardNow(bot)
    if (bad) { await evade(bot, ctl, stats, bad); continue }
    const pest = hunters(bot, 4)[0]
    if (pest) { await fightEnderman(session, ctl, stats, pest, null); continue }
    if (!stage) {
      const zs = cloudZones(bot)
      const toCx = CENTER.x - base.x; const toCz = CENTER.z - base.z; const L = Math.hypot(toCx, toCz) || 1
      const want = new Vec3(base.x + toCx / L * 9, base.y, base.z + toCz / L * 9)
      const sp = pickSpot(bot, base, { rMin: 7, rMax: 12, step: 1, edge: 4, prefer: want, avoid: f => nearPillar(bot, f, 3) || zs.some(z => Math.hypot(f.x - z.x, f.z - z.z) < z.r + 3 && Math.abs(f.y - z.y) < 4) })
      stage = sp ? sp.feet : base
    }
    if (Math.hypot(bot.entity.position.x - stage.x, bot.entity.position.z - stage.z) > 1.5) await walkTo(session, ctl, stage, { range: 1, timeoutMs: 8000 })
    else await sleep(250)
  }
  cage.waited = Math.round((gameClock.now() - tw) / 1000)
  if (towerUnsafe(bot)) return { ok: false, why: `ждал окна минуту: ${towerUnsafe(bot)}`, moved: true }
  // Пока ждали, могли уйти от облака далеко: столб строится только у клетки
  // (прогон e2e3, 283 с: уклон увёл на 13 блоков, столб вырос в стороне,
  // облако фаербола на верхушке, дракон снёс низ — смерть от падения).
  if (Math.hypot(bot.entity.position.x - base.x, bot.entity.position.z - base.z) > 1.2) {
    await walkTo(session, ctl, base, { range: 0.5, timeoutMs: 15000 })
  }
  await stepTo(bot, ctl, base, { ms: 1500, sprint: false, stopAt: 0.15 })
  if (Math.hypot(bot.entity.position.x - base.x, bot.entity.position.z - base.z) > 0.8 || Math.abs(bot.entity.position.y - gy) > 0.6) {
    return { ok: false, why: 'не встал на место столба', moved: true }
  }
  // На столбе бросать всё — только когда уже летит: фаербол упадёт рядом,
  // облако на нас, таран в нашу сторону (hazardNow), — тогда шаг вниз (ведро).
  // Сел — таран будет через 100 тиков (DragonSittingScanningPhase) плюс полёт:
  // прут и выстрел успеваются, а сам таран увидит hazardNow.
  const threat = () => {
    const bad = hazardNow(bot)
    if (bad) return bad.kind
    const d = dragonOf(bot)
    return d && phaseOf(bot, d) === PHASE.CHARGING ? 'таран' : null
  }
  // Ведро — в хотбар перед столбом (его выталкивает из хотбара любой equip из
  // рюкзака, если ведро в выбранном слоте; c3-19, 30.09: сброшен со столба
  // драконом без ведра, потом смерть на обелиске). Без воды — не лезть.
  await waterToHotbar(bot)
  if (!bot.inventory.slots.some((it, k) => k >= 36 && k <= 44 && it && it.name === 'water_bucket')) return { ok: false, why: 'нет ведра воды — на столб не лезу' }
  doing(ctl, 'cage:tower')
  {
    const pest = hunters(bot, 5)[0]
    if (pest) { await fightEnderman(session, ctl, stats, pest, null); return { ok: false, why: 'эндермен у клетки', moved: true } }
  }
  const up = await fastTower(bot, ctl, topY, { abortIf: () => threat() || (hunters(bot, 4).length ? 'эндермен бьёт' : null) || (perchFar(bot) && phaseOf(bot, dragonOf(bot)) === PHASE.SCANNING ? 'сел — будет таран' : null) })
  cage.towerMs = up.ms
  const bailOut = async (why) => {
    cage.bailed = why
    const d = await dropOff(bot, ctl, stats, s, why)
    if (!d.ok) { const dn = await digDownTo(bot, ctl, gy, need + 6); cage.down = dn }
    else cage.drop = d
  }
  if (!up.ok) {
    if (Math.floor(bot.entity.position.y + 0.01) - gy >= 3) await bailOut(up.why || 'столб не дорос')
    return { ok: false, why: `столб не дорос: ${up.why}`, moved: true }
  }
  // Прут: средний столбец стены клетки, верхний ряд. Копать — стоя: в прыжке
  // копка впятеро медленнее (Player.getDestroySpeed: не на земле ÷5), а
  // столб кончается в воздухе — прут ковырялся 4.6 с вместо 0.9.
  const tl = gameClock.now()
  while (!bot.entity.onGround && gameClock.now() - tl < 800) await sleep(50)
  doing(ctl, 'cage:bar')
  const barPos = new Vec3(cr.cx + 2 * s.x - s.z * off, cr.top + 3, cr.cz + 2 * s.z + s.x * off)
  const bar = bot.blockAt(barPos)
  if (bar && bar.name === 'iron_bars') {
    try {
      await items.equipBestTool(bot, bar)
      await build.withTimeout(bot.dig(bar, true), 6000)
    } catch (e) { dbg('bar', e.message) }
  }
  cage.hole = !bot.blockAt(barPos) || bot.blockAt(barPos).name !== 'iron_bars'
  const alive = () => !!bot.entities[cr.id] && bot.entities[cr.id].isValid !== false
  if (cage.hole && alive()) {
    doing(ctl, 'cage:shoot')
    // Путь стрелы (u — расстояние от центра кристалла к нам по оси s, у нас
    // u ≈ 3): плоскость прутьев стены — u = 2 ± 1/16, там стрела должна идти
    // выше top+3 (нижний прут dy = 2 цел, дыра — dy = 3); ближняя грань
    // кристалла и поперечная планка креста верхней решётки — u = 1 ± 1/16, там
    // уже ниже top+3 (решётка top+3…top+4). Стрела вылетает из глаз − 0.1
    // (AbstractArrow: getEyeY() − 0.1) по направлению взгляда — значит, взгляд
    // должен быть параллелен нужной прямой, а не смотреть в точку: сцена cage
    // (2026-09-26) — 12 выстрелов «в точку» из четырёх сторон мимо, прямая
    // шла на 0.1 ниже и ложилась в нижний прут. Уклон вниз k: над прутом
    // 3.52 − k·d₁ > 3, под решёткой 3.52 − k·d₂ < 3 (d₁ ≈ 0.94, d₂ ≈ 1.94) —
    // k от 0.27 до 0.55, берём середину; вбок на 0.25 к грани — мимо продольной
    // планки креста (она по центру клетки). Гравитация (0.05 за тик) и разброс
    // (±0.017 рад) на двух блоках не в счёт: до грани — первый же тик полёта.
    // Вбок — к оси кристалла: при сдвиге столба (off = ±1) стрела уходит к
    // середине коробки, без сдвига — на 0.26 в сторону от продольной планки.
    const lat = off ? { x: s.z * off, z: -s.x * off } : { x: -s.z, z: s.x }
    const uB = (bot.entity.position.x - (cr.cx + 0.5)) * s.x + (bot.entity.position.z - (cr.cz + 0.5)) * s.z
    const d1 = uB - 2.0625; const d2 = uB - 1.0625
    const h = bot.entity.position.y + EYE - 0.1 - (cr.top + 3)
    const slope = d1 > 0.3 && d2 > d1 && h > 0.2 ? (h / d1 + h / d2) / 2 : 0.41
    const eyeNow = () => bot.entity.position.offset(0, EYE, 0)
    const aimAt = () => eyeNow().offset(-s.x * 2 + lat.x * 0.26, -slope * 2, -s.z * 2 + lat.z * 0.26)
    cage.slope = r1(slope)
    for (let k = 0; k < 3 && alive() && !ctl.aborted; k++) {
      const why = threat()
      if (why) break
      const r = await pointBlank(bot, ctl, aimAt, () => !alive() || !!threat())
      if (!r.shot) { cage.refused = r.why; continue }
      stats.arrows++
      const tw2 = gameClock.now()
      while (alive() && gameClock.now() - tw2 < 1500) await sleep(50)
    }
  }
  const destroyed = !alive()
  if (destroyed) stats.crystals++
  cage.destroyed = destroyed
  // Вниз: шагом в сторону острова (ведро), без ведра — копать.
  doing(ctl, 'cage:down')
  if (Math.floor(bot.entity.position.y + 0.01) - gy >= 3) await bailOut(destroyed ? 'сбит' : (threat() || 'не сбит'))
  cage.secs = Math.round((gameClock.now() - t0) / 1000)
  if (ctl.trace) ctl.trace.ev('cage', cage)
  return destroyed ? { ok: true, destroyed: true } : { ok: false, why: cage.bailed && cage.bailed !== 'не сбит' ? `слез со столба: ${cage.bailed}` : (cage.refused || 'кристалл цел'), moved: !!cage.bailed }
}

async function destroyCrystals (session, ctl, rep, stats, { deadline = Infinity } = {}) {
  const bot = session.bot
  const tried = new Map()
  // Живой кристалл лечит дракона на 2 хп/с — бой без его сбития не выиграть
  // (d5-17, d5-22: 9 из 10, дракон 200 через 8 минут боя). Кругов — три.
  let reprieve = 3
  const note = t => { if (!rep.crystals.notes.includes(t)) rep.crystals.notes.push(t) }
  for (let round = 0; round < 60 && !ctl.aborted && gameClock.now() < deadline; round++) {
    await yieldTick()
    doing(ctl, 'crystals')
    // Сначала — не стоять в облаке. Прогон 2026-09-25: pathfinder дважды ответил
    // noPath, пока тело стояло в облаке фаербола, и между попытками к другим
    // кристаллам его никто не выводил — 6 магией в секунду, смерть за три.
    for (let k = 0; k < 4 && !ctl.aborted; k++) {
      const bad = hazardNow(bot)
      if (!bad) break
      await evade(bot, ctl, stats, bad)
    }
    await waterToHotbar(bot)
    if (!overCloud(bot) && onSpike(bot)) { await getDown(session, ctl, stats); continue }
    if (bot.health < 14 && !overCloud(bot)) {
      await clearOfClouds(session, ctl, stats)
      const ate = await heal(session, ctl, rep, stats, { hard: true })
      if (!ate) await sleep(400)
      if (bot.health < 12) continue
    }
    {
      const pil = onOwnPillar(bot)
      if (pil) { doing(ctl, 'pillar:down'); if (ctl.trace) ctl.trace.ev('pillarDown', { n: pil.n, gy: pil.gy }); await digDownTo(bot, ctl, pil.gy, pil.n + 2); continue }
    }
    // Садится или сел и высматривает, а мы дальше STAY_R от фонтана — ближе, иначе
    // таран (см. SCAN_RANGE). Садится — к кругу 15–16.5 (вне круга посадки 14.5):
    // клетки у обелисков в 36–40 блоках (v2, 30.09: столб и путь к клетке на посадке).
    if (await perchApproach(session, ctl, stats)) continue
    let list = crystalsOf(bot).filter(c => c.pillar)
    // Кристаллы видно только с 64 блоков: пока все обелиски не ближе, подойти
    // к центру, чтобы видеть все.
    const me = bot.entity.position
    const fromCenter = Math.hypot(me.x - CENTER.x, me.z - CENTER.z)
    if (!list.length) {
      if (fromCenter > 20) {
        const spot = pickSpot(bot, CENTER, { rMin: 8, rMax: 18 })
        if (spot) await walkTo(session, ctl, spot.feet, { range: 1.5, timeoutMs: 40000 })
        list = crystalsOf(bot).filter(c => c.pillar)
      }
      if (!list.length) break
    }
    rep.crystals.seen = Math.max(rep.crystals.seen, list.length + stats.crystals)
    // Открытые — первыми (ближний), клетки — потом.
    list.sort((a, b) => ((a.bars > 0) - (b.bars > 0)) || (a.pos.distanceTo(me) - b.pos.distanceTo(me)))
    let cr = list.find(c => (tried.get(c.id) || 0) < 4)
    // Все испробованы — ещё круг: кристалл, оставленный жить, лечит дракона
    // (EnderDragon.checkCrystals: +1 хп раз в 10 тиков) — прогоны repro2: 9 из 10,
    // и дракон после посадки снова 200.
    if (!cr && reprieve-- > 0) { tried.clear(); cr = list[0] }
    if (!cr) { rep.crystals.stuck = list.map(c => ({ x: c.cx, y: c.top + 1, z: c.cz, caged: c.bars > 0 })); break }
    tried.set(cr.id, (tried.get(cr.id) || 0) + 1)
    await guard(session, ctl)
    await tidy(session, ctl, rep, stats)
    if (cr.bars > 0) {
      // Столб у клетки — только с ведром: пустое — сперва набрать.
      if (!findItem(bot, /^water_bucket$/) && findItem(bot, /^bucket$/)) await refillBucket(session, ctl, stats)
      const o = await openCage(session, ctl, cr, rep, stats)
      if (!o.ok && o.moved) tried.set(cr.id, (tried.get(cr.id) || 1) - 0.5)
      if (!o.ok) note(`клетка ${cr.cx},${cr.top + 1},${cr.cz}: ${o.why}`)
      continue
    }
    const r = await shootCrystal(session, ctl, crystalsOf(bot).find(c => c.id === cr.id) || cr, rep, stats)
    // Ушёл от фаербола — это не попытка, а помеха: попытку не списывать.
    if (!r.ok && r.moved) tried.set(cr.id, (tried.get(cr.id) || 1) - 1)
    else if (!r.ok) note(`${cr.cx},${cr.top + 1},${cr.cz}: ${r.why}`)
  }
  rep.crystals.destroyed = stats.crystals
  rep.crystals.left = crystalsOf(bot).filter(c => c.pillar).length
}

// ------------------------------------------------------------ здоровье

async function tidy (session, ctl, rep, stats) {
  const bot = session.bot
  if (bot.food < 17 || (bot.health < 14 && bot.food < 20)) {
    const r = await actions.eat(session, {}).catch(e => ({ note: e.message }))
    if (r && r.ate) stats.ate.push(r.ate)
  }
}

// Зелья. Имя — из компонента potion_contents (pvp.potionOf); long_/strong_ —
// та же роль. Взрывное — сразу под ноги (мгновенно), питьё — 1.6 с.
function hasEffect (bot, name) {
  try {
    const pascal = String(name).split('_').map(s => s.charAt(0).toUpperCase() + s.slice(1)).join('')
    const eff = bot.registry.effectsByName[name] || bot.registry.effectsByName[pascal]
    return !!(eff && bot.entity.effects && bot.entity.effects[eff.id])
  } catch { return false }
}
function potionItem (bot, kind, { splash = null } = {}) {
  return bot.inventory.items().find(i => (splash === true ? i.name === 'splash_potion' : splash === false ? i.name === 'potion' : /^(splash_)?potion$/.test(i.name)) &&
    (pvp.potionOf(i) || '').replace(/^(long|strong)_/, '') === kind) || null
}
async function usePotion (bot, stats, kind, effect = kind) {
  if (effect && hasEffect(bot, effect)) return false
  const it = potionItem(bot, kind, { splash: true }) || potionItem(bot, kind, { splash: false })
  if (!it) return false
  try {
    await bot.equip(it, 'hand')
    if (it.name === 'splash_potion') {
      await bot.look(bot.entity.yaw, -Math.PI / 2, true)
      bot.activateItem()
      await sleep(150)
    } else {
      await build.withTimeout(bot.consume(), 4000)
    }
    stats.potions = stats.potions || []
    stats.potions.push(`${it.name === 'splash_potion' ? 'взрывное ' : ''}${kind}`)
    return true
  } catch (e) { dbg('potion', kind, e.message); return false }
}

// Есть — 1.6 с, и всё это время тело стоит: в облаке не есть, а облако, упавшее
// на нас посреди еды, еду обрывает (d4-18, 30.09, 332–341 с: ел в облаке
// фаербола, рефлекс не мог поставить блок — в руке еда, смерть с 15 хп).
async function heal (session, ctl, rep, stats, { hard = false } = {}) {
  const bot = session.bot
  // В облаке не есть — сперва выйти (oc5-20, 00:10: облако фаербола на месте, «лечение»
  // четыре раза подряд в нём, 19 → 0 хп): прочь от центра облака клавишами.
  const inC = inClouds(cloudsOf(bot), bot.entity.position, 1.0)
  if (inC) {
    const me = bot.entity.position
    const dx = me.x - inC.pos.x; const dz = me.z - inC.pos.z; const h = Math.hypot(dx, dz) || 1
    const tx = inC.pos.x + dx / h * (inC.r + 2.5); const tz = inC.pos.z + dz / h * (inC.r + 2.5)
    const ty = standY(bot, tx, tz, me.y, 2, 4)
    doing(ctl, 'heal:out-of-cloud')
    if (ty != null && !nearEdge(bot, new Vec3(tx, ty, tz), 2)) await stepTo(bot, ctl, new Vec3(tx, ty, tz), { ms: 1500, stopAt: 0.5, clouds: false })
    else await clearOfClouds(session, ctl, stats, 2)
    if (inClouds(cloudsOf(bot), bot.entity.position, 0.3)) return false
  }
  if (fbAlarm(bot)) return false
  const was = ctl.doing
  doing(ctl, 'heal')
  const iv = gameClock.setInterval(() => {
    const c = inClouds(cloudsOf(bot), bot.entity.position, 0.2)
    if (c && cloudAgeMs(c) > 300) { try { bot.deactivateItem() } catch {} }
  }, 100)
  try { return await healRaw(session, ctl, rep, stats, { hard }) } finally { gameClock.clearInterval(iv); doing(ctl, was) }
}
async function healRaw (session, ctl, rep, stats, { hard = false } = {}) {
  const bot = session.bot
  // Совсем мало — мгновенное лечение первым (яблоко — это 1.6 с и лечит
  // медленно), потом регенерация.
  if (bot.health <= 8 && await usePotion(bot, stats, 'healing', null)) return true
  if (bot.health <= 10 && !findItem(bot, /golden_apple$/) && await usePotion(bot, stats, 'regeneration')) return true
  if (findItem(bot, /golden_apple$/) && (hard || bot.health <= 14)) {
    const r = await actions.eat(session, { item: findItem(bot, /golden_apple$/).name }).catch(e => ({ note: e.message }))
    if (r && r.ate) { stats.ate.push(r.ate); return true }
  }
  if (bot.food < 20) {
    const r = await actions.eat(session, {}).catch(e => ({ note: e.message }))
    if (r && r.ate) { stats.ate.push(r.ate); return true }
  }
  return false
}

async function clearOfClouds (session, ctl, stats, margin = 4) {
  const bot = session.bot
  // Не в падении: уход клавишами в воздухе уносил тело от своей воды (v13-26, 30.09,
  // 439 с: ведро поставлено, «прочь от облаков» сдвинуло на 5 блоков — падение 17, смерть).
  if (!bot.entity.onGround || bot.entity.isInWater) return false
  const me = bot.entity.position
  const zs = cloudZones(bot)
  const near = zs.some(z => Math.hypot(me.x - z.x, me.z - z.z) < z.r + margin && Math.abs(me.y - z.y) < 4)
  if (!near) return false
  const far = f => zs.some(z => Math.hypot(f.x - z.x, f.z - z.z) < z.r + margin + 1 && Math.abs(f.y - z.y) < 4)
  const spot = pickSpot(bot, me, { rMin: 5, rMax: 17, step: 2, edge: 3, avoid: f => far(f) || nearPillar(bot, f, 2) })
  if (!spot) return false
  const was = ctl.doing
  doing(ctl, 'retreat')
  if (ctl.trace) ctl.trace.ev('retreat', { to: [r1(spot.feet.x), spot.feet.y, r1(spot.feet.z)], hp: r1(bot.health) })
  try { await walkTo(session, ctl, spot.feet, { range: 1, timeoutMs: 8000 }) } finally { doing(ctl, was) }
  return true
}

// Яма на отдых: четыре блока вниз и крышка над головой. Четыре — потому что
// облако фаербола переезжает на живое в коробке 4×2×4 от места удара: с двух и
// трёх блоков глубины его ещё тянет под ноги, с четырёх — уже нет. Эндермен
// (2.9 ростом) в щель в два блока не пролезает.
async function hideAndHeal (session, ctl, rep, stats, { until = 16, maxMs = 60000 } = {}) {
  const bot = session.bot
  // Сперва приземлиться (ведро в падении делает своё): путь в воздухе уносит от воды.
  { const tg = gameClock.now(); while (!ctl.aborted && !bot.entity.onGround && !bot.entity.isInWater && gameClock.now() - tg < 3000) await sleep(50) }
  // Бьёт эндермен — в яму от него не уйти (он лезет следом и бьёт в яме:
  // d4-4, 30.09, 203–206 с — три удара в яме, смерть). Сперва отбиться.
  const pest = hunters(bot, 5).sort((a, b) => a.position.distanceTo(bot.entity.position) - b.position.distanceTo(bot.entity.position))[0]
  if (pest) await fightEnderman(session, ctl, stats, pest, null)
  // 02.10 (rs16-s10, смерть): 6.7 хп, еды 17 (регенерации нет), бот 8 с шёл/копал яму и не ел — второй фаербол в яму, два удара
  // облака. Сперва поесть (золотое яблоко при ≤ 10), если опасности нет прямо сейчас.
  if (bot.health <= 10 && !hazardNow(bot)) await heal(session, ctl, rep, stats, { hard: true }).catch(() => {})
  doing(ctl, 'hide')
  // Сидит — место отдыха не в коридоре взлёта (c2-27, 30.09, 425–437 с: «прятался»
  // в 13.7 блока прямо перед мордой, после четвёртого огня взлёт — три удара).
  const dS = dragonOf(bot)
  const boxesS = dS && SITTING.has(phaseOf(bot, dS)) ? takeoffBoxes(dS.position, dS.yaw) : null
  // И не дальше STAY_R от сидящего видящего (или пока не ясно): иначе таран.
  const nearS = !!boxesS && !blindKnown(sitRec)
  const zsH = cloudZones(bot)
  const spot = pickSpot(bot, CENTER, { rMin: nearS ? 10 : 16, rMax: nearS ? 15 : 30, edge: nearS ? 3 : 5, avoid: f => nearPillar(bot, f) || (!!boxesS && boxesS.some(b => overlap(playerBox(f), inflate(b, 1.5)))) || (nearS && f.distanceTo(dS.position) > STAY_R) || zsH.some(z => Math.hypot(f.x - z.x, f.z - z.z) < z.r + 4 && Math.abs(f.y - z.y) < 4) })
  if (spot) await walkTo(session, ctl, spot.feet, { range: 1, timeoutMs: 20000 })
  const pick = findItem(bot, /_pickaxe$/)
  const hole = { dug: 0 }
  if (pick) {
    for (let i = 0; i < 4 && !ctl.aborted; i++) {
      // фаербол летит сюда / облако рядом — яму бросить, уйти (ниже цикл отдыха уводит от опасности)
      if (hazardNow(bot) || fbAlarm(bot)) { hole.abort = 'опасность'; break }
      const under = bot.blockAt(bot.entity.position.floored().offset(0, -1, 0))
      if (!under || !isSolid(under) || /bedrock|obsidian/.test(under.name)) break
      const lower = new Vec3(bot.entity.position.x, Math.floor(bot.entity.position.y + 0.01) - 1, bot.entity.position.z)
      if (cloudsOf(bot).some(c => cloudHits(c, lower, 0.6) || cloudHits(c, lower.offset(0, -1, 0), 0.6))) break
      if (voidBelow(bot, bot.entity.position.x, bot.entity.position.y - 1, bot.entity.position.z, 6)) break
      try {
        await items.equipBestTool(bot, under)
        await bot.look(bot.entity.yaw, -Math.PI / 2, true)
        await build.withTimeout(bot.dig(under, true), 6000)
        hole.dug++
        const t0 = gameClock.now()
        while (!bot.entity.onGround && gameClock.now() - t0 < 1500) await sleep(50)
      } catch { break }
    }
    const lid = bot.entity.position.floored().offset(0, 2, 0)
    const l = await build.placeBlockAt(bot, lid, { timeoutMs: 3000 })
    hole.lid = !!l.ok
  }
  const t0 = gameClock.now()
  while (!ctl.aborted && gameClock.now() - t0 < maxMs && bot.health < until) {
    // Отдых — не глухой: облако, фаербол, коридор взлёта сидящего — уйти.
    const bad = hazardNow(bot)
    if (bad) { await evade(bot, ctl, stats, bad); continue }
    // Злой эндермен вернулся (отбились не до конца, телепортировался и снова бьёт)
    // — драться, а не есть под ударами: v6-18 (30.09, 152–157 с) — дракон 22.8 хп,
    // эндермен бил тело на «отдыхе» трижды по 3.8, смерть.
    const pest = hunters(bot, 4)[0]
    if (pest) { await fightEnderman(session, ctl, stats, pest, null); continue }
    await heal(session, ctl, rep, stats, { hard: bot.health < 8 })
    await sleep(300)
  }
  // Наверх: убрать крышку, столбом до поверхности.
  if (hole.dug) {
    const lid = bot.blockAt(bot.entity.position.floored().offset(0, 2, 0))
    if (lid && isSolid(lid)) { try { await items.equipBestTool(bot, lid); await build.withTimeout(bot.dig(lid, true), 5000) } catch {} }
    await build.towerUp(bot, ctl, hole.dug)
  }
  hole.hp = Math.round(bot.health)
  hole.seconds = Math.round((gameClock.now() - t0) / 1000)
  stats.hid.push(hole)
}

function nearPillar (bot, feet, r = 4) {
  for (let dx = -r; dx <= r; dx++) {
    for (let dz = -r; dz <= r; dz++) {
      const b = bot.blockAt(new Vec3(Math.floor(feet.x) + dx, Math.floor(feet.y) + 1, Math.floor(feet.z) + dz))
      if (b && b.name === 'obsidian') return true
    }
  }
  return false
}

// ------------------------------------------------------------ угрозы

// Что сейчас опасно для того, кто стоит в feet: облака (свои и предсказанное
// облако сидячего огня), фаербол, который упадёт ближе 4 блоков, голова/шея.
function dangerAt (bot, feet, ctx) {
  const clouds = ctx.clouds
  const c = inClouds(clouds, feet, 0.8)
  if (c) return { kind: 'облако', c }
  if (ctx.breath && cloudHits(ctx.breath, feet, 0.8)) return { kind: 'будет облако огня', c: ctx.breath }
  for (const f of ctx.fireballs) {
    if (!f.at) continue
    // Облако переедет на того, кто ближе 4 блоков к точке попадания (по ногам,
    // в трёх измерениях); запас полтора блока — на неточность точки.
    const land = f.line ? f.ground : f.at
    if (land && feet.distanceTo(land) < FIREBALL_SNAP + 1.5) return { kind: 'фаербол', f }
    if (!f.line && Math.hypot(feet.x - f.at.x, feet.z - f.at.z) < FIREBALL_SNAP + 1.2 && Math.abs(feet.y - f.at.y) < 3.5) return { kind: 'фаербол', f }
    // Стоять на самой прямой полёта — поймать фаербол телом.
    if (f.line) {
      const q = lineDist(f.line.p0, f.line.dir, feet.offset(0, 0.9, 0))
      if (q.s > 0 && q.s < f.line.dist && q.d < 1.6) return { kind: 'фаербол', f }
    }
  }
  if (ctx.charge && inCharge(ctx.charge, feet)) return { kind: 'таран' }
  if (ctx.sweep) {
    // Сидя дракон поворачивает голову к игроку (DragonSittingScanningPhase:
    // yRotA к цели): голова с шеей метут дугу радиусом ~8 на своей высоте, и
    // кто сбоку в этой дуге — под 10 урона каждые полсекунды. Безопасно
    // только прямо перед мордой (куда она уже смотрит) или дальше дуги.
    const w = ctx.sweep
    const rx = feet.x - w.pos.x; const rz = feet.z - w.pos.z
    const h = Math.hypot(rx, rz)
    const ang = h > 0.1 ? Math.acos(Math.max(-1, Math.min(1, (rx * w.dir.x + rz * w.dir.z) / h))) : Math.PI
    // И под самим драконом не стоять: крылья толкают на 4/d² от центра тела
    // (EnderDragon.knockBack) — вплотную это выброс прямо под шею. Безопасно
    // рядом только спереди, дальше головы.
    const front = ang <= 0.4 && h >= HEAD_AHEAD + 1
    // По высоте — до низа коробок удара (голова и шея, раздутые на 1: Y − 2):
    // кто в яме ниже (ноги ≤ Y − 3.8), того дуга не задевает.
    if (h < HEAD_AHEAD + 2.8 && !front && feet.y + 1.8 > w.pos.y - 2.1 && feet.y < w.pos.y + 3) return { kind: h > 2.5 ? 'дуга головы' : 'под драконом' }
  }
  if (ctx.parts) {
    const pb = playerBox(feet)
    // Игра бьёт на 10 всех, чей хитбокс в голове или шее, раздутых на 1
    // (EnderDragon.aiStep → hurt); +0.05 на неточность нашей оценки положения.
    if (overlap(pb, inflate(ctx.parts.head, HURT_PAD)) || overlap(pb, inflate(ctx.parts.neck, HURT_PAD))) return { kind: 'голова дракона' }
  }
  // Крылья на посадке, взлёте и в низком полёте (5 урона и отброс); сидя —
  // только коридор скорого взлёта (толчок сидящего до клиента не доходит).
  if (ctx.wings && ctx.wings.length) {
    const pb = playerBox(feet)
    // Уходить от коридора взлёта — поперёк (от ближней точки его оси), не вдоль.
    const away = ctx.wingAxis ? (() => { const a = ctx.wingAxis; const t = Math.max(0, (feet.x - a.p.x) * a.dir.x + (feet.z - a.p.z) * a.dir.z); return new Vec3(a.p.x + a.dir.x * t, feet.y, a.p.z + a.dir.z * t) })() : (ctx.wingAway || null)
    for (const b of ctx.wings) if (overlap(pb, b)) return { kind: ctx.wingKind || 'крыло', away }
  }
  // Садится: куда бы ни лёг, коробки крыльев в 13.3 от центра тела (угол AABB
  // крыла при взгляде по диагонали: 4.5 + 6·√2) и до низа Y − 2 ≈ верх
  // фонтана − 2.2.
  if (ctx.landing) {
    const L = ctx.landing
    if (Math.hypot(feet.x - L.c.x, feet.z - L.c.z) < L.r && feet.y + 1.8 > L.yMin + 0.01) return { kind: 'посадка', away: L.c }
  }
  return null
}

// ------------------------------------------------------------ тело дракона
// Коробки удара (EnderDragon.aiStep, байткод 1.21.11): каждый тик при
// hurtTime == 0 — крылья: часть 4×2 в ±4.5 поперёк взгляда и +2 по высоте,
// раздутая на (4, 2, 4) и опущенная на 2, — AABB [c ± 6] × [Y − 2, Y + 4]; всех
// живых там толкает (4/d от центра тела, +0.2 вверх) и, если дракон НЕ сидит,
// бьёт на 5 (knockBack). Голова и шея, раздутые на 1, бьют на 10 всегда.
// Толчок сидящего без урона до клиента не доходит (push не помечает
// hurtMarked; dtr-1-2: тело стояло в коробке крыла сидящего и не сдвинулось),
// а посадка и взлёт — удар 5 (2.5 в железе) и отброс: dtr-1-2, 300 с — пять
// заходов в эти коробки, по три удара, подброс на 5 блоков, падение, смерть.
function wingBoxes (pos, yaw, grow = 0) {
  const hx = Math.sin(yaw); const hz = Math.cos(yaw)
  return [1, -1].map(s => {
    const cx = pos.x - hz * 4.5 * s; const cz = pos.z + hx * 4.5 * s
    return { min: new Vec3(cx - 6 - grow, pos.y - 2, cz - 6 - grow), max: new Vec3(cx + 6 + grow, pos.y + 4, cz + 6 + grow) }
  })
}
// Скорость дракона по последним позициям (блоки за тик): на взлёте он проходит
// до блока за тик, а позицию сервер шлёт раз в 3 тика (dtr-1-2, 447.8 с: удар
// крылом, когда по нашим данным коробка не доставала на 0.7).
const dragonHist = []
function dragonVel (d, now) {
  const last = dragonHist[dragonHist.length - 1]
  if (!last || last.id !== d.id || now - last.t >= 40) dragonHist.push({ id: d.id, t: now, x: d.position.x, y: d.position.y, z: d.position.z })
  while (dragonHist.length > 1 && (dragonHist[0].id !== d.id || now - dragonHist[0].t > 600)) dragonHist.shift()
  const a = dragonHist[0]; const b = dragonHist[dragonHist.length - 1]
  const dt = (b.t - a.t) / 50
  if (dt < 2) return { x: 0, y: 0, z: 0 }
  return { x: (b.x - a.x) / dt, y: (b.y - a.y) / dt, z: (b.z - a.z) / dt }
}
// Посадка: когда сел, ревел ли (видит нас), сколько огней. Слепой дракон
// (Sensing у него не очищается: первое «не видно» — навсегда) высматривает
// 100 тиков и взлетает (DragonSittingScanningPhase: scanningTime ≥ 100) —
// dtr-1-2: девять посадок, все 4.6–5.0 с от первого «высматривает» до взлёта,
// ни одного рёва. Видящий ревёт на 25-м тике, огонь 200 тиков, до 4 огней.
let sitRec = null
// Видит ли этот дракон это тело — решается один раз и навсегда (Sensing у
// дракона не очищается): первый рёв — видящий, первая «слепая» посадка — слепой.
// Со второй посадки ждать 1.7 с «ясно ли» не нужно (c1-28, 30.09: 14 слепых
// посадок подряд, к голове шёл с 1.6 с и к взлёту не успевал — ни одного удара).
// Ключ — id дракона и id тела (после смерти у тела новый id — новая проверка).
const sight = new Map()
let sightMe = null
function sightKey (dId) { return dId + ':' + sightMe }
function sitState (d, ph, now) {
  if (d && SITTING.has(ph)) {
    if (!sitRec || sitRec.id !== d.id || sitRec.ended) {
      const known = sight.get(sightKey(d.id))
      sitRec = { id: d.id, t0: now, roared: known === 'seeing', blind: known === 'blind', flames: 0, lastPh: null }
    }
    if (ph === PHASE.ROARING || ph === PHASE.FLAMING) { sitRec.roared = true; sitRec.blind = false; sight.set(sightKey(d.id), 'seeing') }
    if (ph === PHASE.FLAMING && sitRec.lastPh !== PHASE.FLAMING) { sitRec.flames++; sitRec.flameAt = now }
    sitRec.lastPh = ph
    sitRec.pos = d.position.clone(); sitRec.yaw = d.yaw
    return sitRec
  }
  if (sitRec && !sitRec.ended) sitRec.ended = now
  return null
}
// Взлёт скоро: слепой — с 3.8 с (взлёт на 4.6–5 с; к 3.4 с perchAttack уже
// нырнул в яму); видящий — на исходе четвёртого огня.
function takeoffSoon (rec, now) {
  if (!rec || rec.ended) return false
  if (!rec.roared) return now - rec.t0 > 3800
  return rec.flames >= 4 && !!rec.flameAt && now - rec.flameAt > 8500
}
// Высматривая, сидящий находит игрока, только если ноги в 20 блоках от него
// (3D, крадучись — 16: getVisibilityPercent ×0.8) и |dy| ≤ 10
// (DragonSittingScanningPhase.scanTargeting). Не нашёл за 100 тиков — берёт
// CHARGE_TARGETING (150 блоков, с LOS) и таранит. Поэтому «слепой» (не ревёт) —
// только если мы были в этом круге после 25-го тика, а рёва так и не было; и
// видящему (или пока не ясно) — не дальше STAY_R. ab-23 (30.09, 284–292 с):
// отход на 20.06 блока от сидящего, через 100 тиков таран, пять ударов
// крыльями за 2 с, смерть.
const SCAN_RANGE = 20
const STAY_R = 17
function noteNear (rec, d, bot, now) {
  if (!rec || (rec.lastPh != null && rec.lastPh !== PHASE.SCANNING) || now - rec.t0 < 1250) return
  const me = bot.entity.position
  const sneak = typeof bot.getControlState === 'function' && bot.getControlState('sneak')
  const r = (sneak ? SCAN_RANGE * 0.8 : SCAN_RANGE) - 0.7
  // Непрерывно в круге: вышли — отсчёт заново.
  rec.nearAt = me.distanceTo(d.position) <= r && Math.abs(me.y - d.position.y) <= 9.5 ? (rec.nearAt || now) : null
}
function blindKnown (rec, now = gameClock.now()) {
  if (!rec || rec.roared) return false
  if (rec.blind) return true
  const b = !!rec.nearAt && now - rec.nearAt > 450
  if (b && rec.id != null) { rec.blind = true; sight.set(sightKey(rec.id), 'blind') }
  return b
}
// Сидячий урон копится у дракона на ВСЕ посадки: EnderDragon.hurt прибавляет
// потерю хп в сидячих фазах к sittingDamageReceived и обнуляет его, только
// перевалив за 50 (тогда же TAKEOFF); других записей поля нет (javap). Значит,
// взлёт может начаться от первого же удара новой посадки: c1-27 (30.09, 266 с) —
// 1.3 урона, взлёт с телом перед головой, три удара (голова и крылья), 20 → 9.4.
let sitAcc = { id: null, dmg: 0, hp: null, sitting: false }
function noteSitDamage (bot, d, ph) {
  const hp = hpOf(bot, d)
  if (sitAcc.id !== d.id) sitAcc = { id: d.id, dmg: 0, hp, sitting: SITTING.has(ph) }
  if (hp != null && sitAcc.hp != null && hp < sitAcc.hp - 0.01 && (sitAcc.sitting || SITTING.has(ph))) {
    sitAcc.dmg += sitAcc.hp - hp
    if (sitAcc.dmg > 50) sitAcc.dmg = 0
  }
  if (hp != null) sitAcc.hp = hp
  sitAcc.sitting = SITTING.has(ph)
}
// Следующий удар меча (крит по голове ~9) может поднять его на взлёт.
function takeoffOnHit () { return sitAcc.dmg + 9.5 > 50 }
// Взлёт идёт низко вперёд по взгляду (±40°): dtr-1-2 — девять взлётов, на
// 20 блоках высота 64 → 65.5. Коридор — коробки крыльев вдоль трёх лучей.
function takeoffBoxes (pos, yaw, len = 24) {
  const out = []
  for (const turn of [0, 0.6, -0.6]) {
    const a = yaw + turn
    for (let k = 0; k <= len; k += 4) {
      const p = new Vec3(pos.x + Math.sin(a) * k, pos.y + k * 0.06, pos.z + Math.cos(a) * k)
      out.push(...wingBoxes(p, a, 0.5))
    }
  }
  return out
}
// Верх фонтана (где садится дракон): ноги на нём. Кэш — фонтан не меняется.
let podiumCache = null
function podiumTop (bot) {
  if (podiumCache && gameClock.now() - podiumCache.t < 30000) return podiumCache.y
  const s = surfaceY(bot, CENTER.x - 0.5, CENTER.z - 0.5, 90)
  if (!s) return podiumCache ? podiumCache.y : null
  // верх столба — бедрок: над ним бывает чужое (кровать R, блок) — тогда ниже, до 4 блоков (rs6-s3: P 66 вместо 65, план R пуст)
  let y = s.y
  if (s.name !== 'bedrock') {
    for (let k = 1; k <= 4; k++) { const b = bot.blockAt(new Vec3(Math.floor(CENTER.x - 0.5), s.y - 1 - k, Math.floor(CENTER.z - 0.5))); if (b && b.name === 'bedrock') { y = s.y - k; break } }
  }
  podiumCache = { y, t: gameClock.now() }
  return y
}

// Фаерболы дракона: где и через сколько тиков упадут.
// Летят по прямой: AbstractHurtingProjectile ускоряет вдоль своей же скорости
// и гравитации не знает — v ← (v + 0.1·v̂)·0.95, v₀ = 0.1 блока за тик (за
// 10 тиков 5.3 блока, за 20 — 16, за 30 — 30). Летит туда, где цель была в
// миг выстрела (DragonStrafePlayerPhase: от головы к середине тела игрока).
// Направление — из первого же пакета: spawn_entity несёт скорость (lpVec3),
// а mineflayer её выбрасывает (entities.js addNewNonPlayer), позицию же
// фаербола сервер шлёт раз в 10 тиков (EntityType DRAGON_FIREBALL:
// updateInterval 10) — по двум устаревшим позициям скорость врёт (прогон
// 2026-09-26 repro2, 79 с: «ушёл» от фаербола на 4 блока, облако легло под
// ноги). Поэтому точка попадания — первый твёрдый блок на прямой от точки
// появления (или мы сами, если стоим на прямой), время — по таблице пути.
// Облако встаёт в точке попадания, а если живое ближе 4 блоков (по ногам,
// DragonFireball.onHit: distanceToSqr < 16) — переезжает ему под ноги.
const fbSpawn = new Map()
// Скорость в spawn_entity — lpVec3 (1.21.9+): 48 бит, из них старшие 32 —
// Netty readUnsignedInt, то есть big-endian (LpVec3.read). minecraft-protocol
// читает их readUInt32LE (datatypes/lpVec3.js) — направления выходят мусором:
// прогоны 2026-09-26 (station4, e2e3): «фаербол упадёт в 26 блоках», а облако
// легло нам под ноги. Поэтому сами — из сырого пакета: id, entityId (varint),
// UUID (16), type (varint), x y z (f64 BE), lpVec3.
function readVarIntAt (buf, off) {
  let v = 0; let s = 0; let b
  do { b = buf[off++]; v += (b & 0x7f) * 2 ** s; s += 7 } while (b & 0x80 && s < 35)
  return [v, off]
}
function spawnVelocityRaw (buf) {
  let off = 0
  let v
  ;[v, off] = readVarIntAt(buf, off) // id пакета
  let entityId
  ;[entityId, off] = readVarIntAt(buf, off)
  off += 16
  let type
  ;[type, off] = readVarIntAt(buf, off)
  const x = buf.readDoubleBE(off); const y = buf.readDoubleBE(off + 8); const z = buf.readDoubleBE(off + 16)
  off += 24
  const a = buf[off]
  if (a === 0) return { entityId, type, pos: { x, y, z }, vel: { x: 0, y: 0, z: 0 } }
  const packed = buf.readUInt32BE(off + 2) * 65536 + buf[off + 1] * 256 + a
  let scale = a & 3
  if ((a & 4) === 4) { const [c] = readVarIntAt(buf, off + 6); scale += c * 4 }
  const un = sh => Math.min(Math.floor(packed / 2 ** sh) % 32768, 32766) * 2 / 32766 - 1
  return { entityId, type, pos: { x, y, z }, vel: { x: un(3) * scale, y: un(18) * scale, z: un(33) * scale } }
}
function fireballTracker (bot) {
  const f = (buf) => {
    try {
      const r = spawnVelocityRaw(buf)
      const info = bot.registry.entities[r.type]
      if (!info || info.name !== 'dragon_fireball') return
      const v = r.vel
      const n = Math.hypot(v.x, v.y, v.z)
      fbSpawn.set(r.entityId, { p0: new Vec3(r.pos.x, r.pos.y, r.pos.z), dir: n > 1e-6 ? new Vec3(v.x / n, v.y / n, v.z / n) : null, t0: gameClock.now(), hit: null, hitAt: 0 })
    } catch {}
  }
  // Облака — когда родились: первый удар через 20 тиков (evade считает запас).
  const g = e => {
    if (!e || e.name !== 'area_effect_cloud') return
    cloudBorn.set(e.id, gameClock.now())
    if (cloudBorn.size > 200) for (const [id, t] of cloudBorn) if (gameClock.now() - t > 60000) cloudBorn.delete(id)
  }
  bot._client.on('raw.spawn_entity', f)
  bot.on('entitySpawn', g)
  return () => { bot._client.removeListener('raw.spawn_entity', f); bot.removeListener('entitySpawn', g) }
}
// Путь фаербола от точки появления за n тиков (таблица до 8 секунд).
const FB_PATH = (() => { const out = [0]; let v = 0.1; let s = 0; for (let k = 1; k <= 160; k++) { v = (v + 0.1) * 0.95; s += v; out.push(s) } return out })()
function fbTicksTo (dist) { for (let k = 0; k < FB_PATH.length; k++) if (FB_PATH[k] >= dist) return k; return FB_PATH.length }
// Первый твёрдый блок на прямой (точка сущности фаербола — низ-центр его
// коробки; с блоками он сталкивается по этой точке — ProjectileUtil.
// getHitResultOnMoveVector → level.clip от position()). null — улетит в
// непрогруженное (там его сервер просто уберёт) или в пустоту.
function fbLineHit (bot, p0, dir, maxDist = 160) {
  for (let s = 0.25; s < maxDist; s += 0.25) {
    const p = p0.offset(dir.x * s, dir.y * s, dir.z * s)
    if (p.y < -64) return null
    const b = bot.blockAt(p.floored())
    if (!b) return null
    if (isSolid(b)) return { at: p, dist: s }
  }
  return null
}
// Сколько от точки до прямой полёта и где на прямой ближайшая точка.
function lineDist (p0, dir, q) {
  const rx = q.x - p0.x; const ry = q.y - p0.y; const rz = q.z - p0.z
  const s = rx * dir.x + ry * dir.y + rz * dir.z
  return { s, d: Math.hypot(rx - dir.x * s, ry - dir.y * s, rz - dir.z * s) }
}
const fbSeen = new Map()
function fireballsOf (bot) {
  const out = []
  const me = bot.entity.position
  const now = gameClock.now()
  const alive = new Set()
  for (const e of Object.values(bot.entities)) {
    if (!e || e.name !== 'dragon_fireball' || !e.position) continue
    alive.add(e.id)
    const info = fbSpawn.get(e.id)
    if (info && info.dir) {
      if (!info.hit || now - info.hitAt > 500) { info.hit = fbLineHit(bot, info.p0, info.dir); info.hitAt = now }
      const flown = (now - info.t0) / 50
      // Прямое попадание в нас: прямая проходит сквозь наше тело раньше земли.
      const body = lineDist(info.p0, info.dir, me.offset(0, 0.9, 0))
      let at = info.hit ? info.hit.at : null
      let dist = info.hit ? info.hit.dist : null
      let direct = false
      if (body.s > 0 && body.d < 1.2 && (dist == null || body.s < dist)) { at = me.clone(); dist = body.s; direct = true }
      if (at == null) continue
      const ticks = Math.max(0, fbTicksTo(dist) - flown)
      out.push({ e, at, ticks, line: { p0: info.p0, dir: info.dir, dist: info.hit ? info.hit.dist : 160 }, ground: info.hit ? info.hit.at : null, direct, exact: true })
      continue
    }
    // Точки появления не видели (фаербол родился до начала боя) — по двум
    // замерам позиции, как раньше; свежий без скорости считаем летящим в нас.
    let h = fbSeen.get(e.id)
    if (!h) { h = []; fbSeen.set(e.id, h) }
    const last = h[h.length - 1]
    if (!last || now - last.t >= 40) h.push({ x: e.position.x, y: e.position.y, z: e.position.z, t: now })
    while (h.length > 8) h.shift()
    let vel = null
    const a = h[0]; const b = h[h.length - 1]
    if (h.length >= 2 && b.t - a.t >= 80) {
      const dt = (b.t - a.t) / 50
      vel = { x: (b.x - a.x) / dt, y: (b.y - a.y) / dt, z: (b.z - a.z) / dt }
    }
    if (!vel || Math.hypot(vel.x, vel.y, vel.z) < 0.02) {
      const to = me.offset(0, 0.9, 0).minus(e.position)
      const n = to.norm() || 1
      vel = { x: to.x / n * 0.6, y: to.y / n * 0.6, z: to.z / n * 0.6 }
    }
    let p = e.position.clone(); let w = { x: vel.x, y: vel.y, z: vel.z }
    let at = null; let ticks = 0
    for (let t = 1; t <= 90; t++) {
      const len = Math.hypot(w.x, w.y, w.z) || 1
      p = p.offset(w.x, w.y, w.z)
      w = { x: (w.x + 0.1 * w.x / len) * 0.95, y: (w.y + 0.1 * w.y / len) * 0.95, z: (w.z + 0.1 * w.z / len) * 0.95 }
      const bl = bot.blockAt(p.floored())
      if ((bl && isSolid(bl)) || p.distanceTo(me.offset(0, 0.9, 0)) < 1.2 || p.y < 0) { at = p; ticks = t; break }
    }
    if (at) out.push({ e, at, ticks })
  }
  for (const id of fbSeen.keys()) if (!alive.has(id)) fbSeen.delete(id)
  for (const [id, info] of fbSpawn) if (!alive.has(id) && now - info.t0 > 3000) fbSpawn.delete(id)
  return out
}

// Опасно ли прямо сейчас там, где стоим: облако под ногами или фаербол,
// который упадёт ближе 4 блоков в ближайшие 45 тиков.
function hazardNow (bot, extra = {}) {
  const ctx = { clouds: cloudsOf(bot), fireballs: fireballsOf(bot).filter(f => f.ticks < 60), parts: extra.parts || null, breath: extra.breath || null }
  Object.assign(ctx, dragonZones(bot))
  const bad = dangerAt(bot, bot.entity.position, ctx)
  return bad ? { ...bad, ctx } : null
}

// Что опасно рядом с сидящим (или садящимся) драконом: голова и шея (10 урона
// каждые полсекунды) и дуга, которую голова метёт, поворачиваясь. Любой уход
// от облака или фаербола должен знать об этом — иначе «безопасная» клетка
// оказывается у морды (так бот и погиб: ушёл от облака под поворот головы).
function dragonZones (bot, now = gameClock.now()) {
  if (bot.entity) sightMe = bot.entity.id
  const d = dragonOf(bot)
  if (!d) { sitState(null, null, now); return {} }
  const ph = phaseOf(bot, d)
  const v = dragonVel(d, now)
  const rec = sitState(d, ph, now)
  if (rec) noteNear(rec, d, bot, now)
  noteSitDamage(bot, d, ph)
  const ch = chargeOf(bot, d, ph)
  if (ch) return { charge: ch }
  const out = {}
  const me = bot.entity.position
  const near = Math.hypot(d.position.x - me.x, d.position.z - me.z) < 40
  // Крылья на посадке, взлёте и в низком полёте: коробки сейчас и через 3, 6,
  // 9 тиков по скорости (на взлёте — до блока за тик).
  if (near && !SITTING.has(ph) && (ph === PHASE.LANDING || ph === PHASE.TAKEOFF || d.position.y - me.y < 10)) {
    out.wings = []
    for (const k of [0, 3, 6, 9]) out.wings.push(...wingBoxes(new Vec3(d.position.x + v.x * k, d.position.y + v.y * k, d.position.z + v.z * k), d.yaw, 0.6))
    out.wingKind = ph === PHASE.TAKEOFF ? 'взлёт' : 'крыло'
    out.wingAway = d.position.clone()
    if (ph === PHASE.TAKEOFF) {
      const n = Math.hypot(v.x, v.z)
      out.wingAxis = { p: d.position.clone(), dir: n > 0.05 ? { x: v.x / n, z: v.z / n } : { x: Math.sin(d.yaw), z: Math.cos(d.yaw) } }
      // Начало взлёта (скорость ещё мала): коробки по скорости стоят на месте, и
      // уход выбирал клетку впереди, на пути (c1-27, 266.6 с). Коридор взлёта —
      // вперёд по взгляду ±0.6 рад, пока не разогнался.
      if (n < 0.5) out.wings.push(...takeoffBoxes(d.position, n > 0.05 ? Math.atan2(v.x, v.z) : d.yaw, 16))
    }
  }
  // Сидит, а взлёт скоро (слепой — 100 тиков): коридор взлёта вперёд по взгляду.
  if (rec && near && takeoffSoon(rec, now)) {
    out.wings = takeoffBoxes(d.position, d.yaw)
    out.wingKind = 'взлёт скоро'
    out.wingAxis = { p: d.position.clone(), dir: { x: Math.sin(d.yaw), z: Math.cos(d.yaw) } }
  }
  if (ph === PHASE.LANDING) {
    const P = podiumTop(bot)
    if (P != null && d.position.y < P + 12) out.landing = { c: new Vec3(CENTER.x, P, CENTER.z), r: 14.5, yMin: P - 2.2 }
  }
  if (!SITTING.has(ph) && ph !== PHASE.LANDING) return out
  const parts = partsOf(bot, d, null)
  out.parts = parts
  // Дуга головы — пока видящий доворачивает к нам (высматривая, первые 25
  // тиков); слепой (высматривает дольше 1.6 с без рёва) не поворачивается.
  if (ph === PHASE.SCANNING && !blindKnown(rec, now)) out.sweep = { pos: d.position, dir: parts.dir }
  return out
}
// Таран (DragonChargePlayerPhase): после посадки, на которой в 20 блоках не
// было игрока, дракон 100 тиков сидит, взлетает и летит со скоростью 3 в
// точку, где игрок стоял в этот миг (DragonSittingScanningPhase:
// setTarget(позиция игрока)), и, подлетев на 10 блоков, ещё 10 тиков летит по
// инерции. Крыло бьёт на 5 и толкает (EnderDragon.knockBack: коробка крыла,
// раздутая на 4,2,4 и опущенная на 2, — до 10.5 блока вбок от оси и от −2 до
// +4 по высоте), голова и шея — на 10. Три прогона 2026-09-26 из трёх:
// таран, пока тело сбивало кристаллы в 40 блоках, — 5–11 хп и сброс со
// столба у клетки. Коридор: от точки взлёта через цель и 15 блоков дальше,
// 11 вбок, ±4 по высоте от прямой.
let chargeRec = null
function chargeOf (bot, d, ph) {
  if (ph !== PHASE.CHARGING) { chargeRec = null; return null }
  if (!chargeRec || chargeRec.id !== d.id || gameClock.now() - chargeRec.t0 > 8000) {
    chargeRec = { id: d.id, t0: gameClock.now(), from: d.position.clone(), target: bot.entity.position.clone(), yaw: d.yaw }
  }
  return chargeRec
}
function inCharge (ch, feet) {
  const ax = ch.target.x - ch.from.x; const az = ch.target.z - ch.from.z
  const L = Math.hypot(ax, az) || 1
  const ux = ax / L; const uz = az / L
  const rx = feet.x - ch.from.x; const rz = feet.z - ch.from.z
  const along = rx * ux + rz * uz
  if (along < -5 || along > L + 15) return false
  const side = Math.abs(rx * uz - rz * ux)
  if (side > 11) return false
  const lineY = ch.from.y + (ch.target.y - ch.from.y) * Math.min(1, Math.max(0, along / L))
  return feet.y > lineY - 5.8 && feet.y < lineY + 4
}
// Для pathfinder'а: не прокладывать путь через дракона и его голову.
let zonesCache = { t: 0, z: {} }
function dragonStepCost (bot, pos) {
  if (gameClock.now() - zonesCache.t > 250) zonesCache = { t: gameClock.now(), z: dragonZones(bot) }
  const z = zonesCache.z
  if (z.charge) return inCharge(z.charge, new Vec3(pos.x + 0.5, pos.y, pos.z + 0.5)) ? 200 : 0
  if (!z.parts && !z.wings && !z.landing) return 0
  const feet = new Vec3(pos.x + 0.5, pos.y, pos.z + 0.5)
  if (dangerAt(bot, feet, { clouds: [], fireballs: [], parts: z.parts, sweep: z.sweep, wings: z.wings, landing: z.landing })) return 200
  if (z.parts && overlap(playerBox(feet), inflate(z.parts.body, 1))) return 200
  return 0
}

async function evade (bot, ctl, stats, bad, prefer = null) {
  const was = ctl.doing
  doing(ctl, `evade:${bad.kind}`)
  ctl.evading = (ctl.evading || 0) + 1
  try {
    const r = await evadeRaw(bot, ctl, stats, bad, prefer)
    // Уйти некуда, а стоим в облаке (fin1-25: яма у края острова, «evade: облако → null» ×12,
    // 19 → 0 хп): облако — пол в 0.5 высотой, над ним не бьёт — на блок-два вверх столбом.
    const c = inClouds(cloudsOf(bot), bot.entity.position, 0.3)
    if (c && !ctl.aborted && bot.entity.onGround && countOf(bot, FILLER_RE) > 0) {
      const need = Math.max(1, Math.ceil(c.pos.y + CLOUD_SLAB + 0.05 - bot.entity.position.y))
      if (ctl.trace) ctl.trace.ev('cloudUp', { need, hp: r1(bot.health) })
      await build.towerUp(bot, ctl, Math.min(3, need)).catch(() => {})
      clearControls(bot)
    }
    return r
  } finally { doing(ctl, was); ctl.evading-- }
}
async function evadeRaw (bot, ctl, stats, bad, prefer = null) {
  if (embeddedNow(bot)) await unembed(bot, ctl)
  const ctx = { ...bad.ctx, prefer }
  const me = bot.entity.position
  // Голова и шея сидящего (10 за удар раз в полсекунды) — прежде всего, даже из
  // облака и сквозь него: ab-25 (30.09, 188–191 с) — «уход от облака» некуда,
  // тело стояло у морды, четыре удара головой по 6, смерть.
  if (ctx.parts) {
    const pb = playerBox(me)
    if (overlap(pb, inflate(ctx.parts.head, HURT_PAD)) || overlap(pb, inflate(ctx.parts.neck, HURT_PAD))) {
      const dh = dragonOf(bot)
      if (dh) {
        stats.dodges['от головы'] = (stats.dodges['от головы'] || 0) + 1
        const t = awayFromHead(dh, ctx.parts, me, 4)
        if (ctl.trace) ctl.trace.ev('evade', { kind: 'голова дракона', to: [r1(t.x), r1(t.y), r1(t.z)], first: bad.kind })
        const r = await stepTo(bot, ctl, t, { ms: 1200, stopAt: 0.4, clouds: false })
        return r.ok
      }
    }
  }
  // Таран: бегом поперёк его линии, прочь от неё (коридор — 11 блоков вбок).
  if (bad.kind === 'таран' && ctx.charge) {
    stats.dodges.таран = (stats.dodges.таран || 0) + 1
    const ch = ctx.charge
    const ax = ch.target.x - ch.from.x; const az = ch.target.z - ch.from.z
    const L = Math.hypot(ax, az) || 1
    let side = Math.sign((me.x - ch.from.x) * (az / L) - (me.z - ch.from.z) * (ax / L)) || 1
    // Разворачивается он широко (радиус ~19: 0.06 за тик вперёд, поворот не
    // больше ~3.6° за тик на скорости): дуга выгибается в ту сторону, куда он
    // смотрел, взлетая, и дальше кружит у точки тарана. ab-23 (30.09, 289–292 с):
    // уход вбок на ту же сторону, куда выгнулась дуга, — пять ударов крыльями.
    // Уходить — на другую сторону и дальше.
    if (ch.yaw != null) {
      const bulge = Math.sin(ch.yaw) * (az / L) + Math.cos(ch.yaw) * (-ax / L)
      if (Math.abs(bulge) > 0.2) side = -Math.sign(bulge)
    }
    // Вбок не успеть (он здесь раньше, чем мы в 11 блоках от его линии) — нырнуть:
    // низ коробок крыльев и головы — Y − 2, а Y тела на таране держится у высоты
    // посадки (к цели вниз — ~0.01 блока за тик²). c2-4 (30.09, 68.6–70.2 с):
    // таран с 27 блоков, вбок успел на 5 — два удара крыльями, ноги на 60, тело
    // дракона на 63.2–63.6: блок вниз — мимо.
    {
      const dn = dragonOf(bot)
      if (dn) {
        const v = dragonVel(dn, gameClock.now())
        const sp = Math.max(0.8, Math.hypot(v.x, v.z))
        const etaMs = Math.hypot(dn.position.x - me.x, dn.position.z - me.z) / sp * 50
        const lat = Math.abs((me.x - ch.from.x) * (az / L) - (me.z - ch.from.z) * (ax / L))
        const runMs = Math.max(0, 11 - lat) / 5.5 * 1000 + 300
        const F = Math.floor(dn.position.y - 0.6 - HOLE_TOP - 0.15)
        const plan = duckPlan(bot, F)
        // Уже в яме (или успеем докопать) — сидеть: вылезти и бежать — под крылья
        // (v2-18, v2-26, 30.09: из ямы «вбок», три удара). Бег — только если нырнуть
        // нельзя (обсидиан, чаша портала, пустота) или копать дольше, чем он летит.
        if (plan && (plan.dig === 0 || plan.dig * 800 < etaMs + 300 || runMs > etaMs)) {
          if (plan.dig <= (etaMs > 1700 ? 2 : 1)) {
            stats.dodges['нырок'] = (stats.dodges['нырок'] || 0) + 1
            if (ctl.trace) ctl.trace.ev('duck', { kind: 'таран', F, dig: plan.dig, etaMs: Math.round(etaMs) })
            if (plan.dig === 0) { await sleep(100); return true }
            if (await duck(bot, ctl, F)) return true
          }
        }
      }
    }
    for (const s2 of [side, -side]) {
      for (const k of [16, 13, 10, 7]) {
        const t = me.offset(az / L * s2 * k, 0, -ax / L * s2 * k)
        const y = standY(bot, t.x, t.z, me.y, 2, 4)
        if (y == null) continue
        const feet = new Vec3(Math.floor(t.x) + 0.5, y, Math.floor(t.z) + 0.5)
        if (nearEdge(bot, feet, 3) || nearPortal(feet) || inClouds(cloudsOf(bot), feet, 1.5)) continue
        if (ctl.trace) ctl.trace.ev('evade', { kind: 'таран', to: [r1(feet.x), feet.y, r1(feet.z)] })
        const r = await stepTo(bot, ctl, feet, { ms: 3000, stopAt: 0.6 })
        return r.ok
      }
    }
    await sleep(100)
    return false
  }
  // Скорый взлёт (слепой на 3.8 с): вбок на 11+ блоков не успеть — нырнуть на
  // блок, если под ногами копается (коробки взлёта пройдут поверх).
  if (/взлёт/.test(bad.kind)) {
    const d = dragonOf(bot)
    const P = podiumTop(bot)
    const F = d ? Math.floor(Math.min(d.position.y, P != null ? P - 0.2 : d.position.y) - HOLE_TOP - 0.15) : null
    const plan = F != null ? duckPlan(bot, F) : null
    if (plan && plan.dig <= 1) {
      stats.dodges['нырок'] = (stats.dodges['нырок'] || 0) + 1
      if (ctl.trace) ctl.trace.ev('duck', { kind: bad.kind, F, dig: plan.dig })
      if (await duck(bot, ctl, F)) return true
    }
  }
  // Облако уже на нас: сколько осталось до первого удара. Облако ждёт 20 тиков
  // от рождения (AreaEffectCloud: waitTime 20), потом бьёт всех внутри раз в
  // 20 тиков; проверка — каждые 5 тиков. Свежее облако фаербола (радиус 3,
  // переехало под ноги) — выбежать за 3.5 блока успеваем, старое — нет.
  const cloudOnMe = !!(bad.c && /облако/.test(bad.kind) && cloudHits(bad.c, me, 0.3))
  const graceMs = cloudOnMe ? Math.max(0, 1000 - cloudAgeMs(bad.c) - 150) : null
  const away = bad.c ? bad.c.pos : bad.f ? (bad.f.ground || bad.f.at) : (bad.away || null)
  const budgetMs = bad.f ? bad.f.ticks * 50 - 150 : cloudOnMe ? graceMs : 3000
  // Сквозь край чужого облака — только когда само бьёт: фаербол летит или
  // облако уже на нас.
  // Куда уже пробовали и не сдвинулись (упёрлись) — не туда (ab-25: пять раз
  // подряд одна и та же цель, тело на месте).
  ctl.evadeBad = (ctl.evadeBad || []).filter(b => gameClock.now() - b.t < 8000)
  const esc = escapeSpot(bot, ctx, { away, budgetMs, cloudMargin: cloudOnMe && bad.c.r < 4 ? 1.0 : 2.2, through: !!(bad.f || cloudOnMe), skip: ctl.evadeBad.map(b => b.feet) })
  stats.dodges[bad.kind] = (stats.dodges[bad.kind] || 0) + 1
  dbg('evade', bad.kind, esc ? `${esc.feet} за ${esc.etaMs} мс, бюджет ${budgetMs}` : 'некуда')
  if (ctl.trace) ctl.trace.ev('evade', { kind: bad.kind, to: esc ? [r1(esc.feet.x), esc.feet.y, r1(esc.feet.z)] : null, etaMs: esc ? esc.etaMs : null, budgetMs, cloudOnMe, through: esc && esc.through ? esc.exposure : undefined })
  // Облако уже на нас, а выбежать до удара не успеть — блок под себя: облако
  // высотой полблока (AreaEffectCloud), кто стоит на блок выше, того не
  // трогает; полсекунды против трёх секунд бега (прогон 2026-09-25: 17 хп →
  // смерть, трижды «ушёл» на клетку двумя блоками выше — не допрыгнуть).
  // Блоков нет, а облако на нас — выломать соседний блок киркой (эндерняк
  // стенки ямы или земли рядом, ~0.75 с) и встать на него: camp3 (277–284 с) —
  // тело в воронке от кроватей, блоки кончились, выхода «некуда», 4 удара.
  if (cloudOnMe && (!esc || esc.etaMs > graceMs) && countOf(bot, FILLER_RE) === 0) {
    const pick = findItem(bot, /_pickaxe$/)
    const f = bot.entity.position.floored()
    const cand = pick && [[1, 0], [-1, 0], [0, 1], [0, -1]].flatMap(([dx, dz]) => [f.offset(dx, 0, dz), f.offset(dx, 1, dz), f.offset(dx, -1, dz)])
      .map(p => bot.blockAt(p)).find(b => b && isSolid(b) && /^(end_stone|cobblestone|stone|dirt)$/.test(b.name))
    if (cand) {
      try { await bot.equip(pick, 'hand'); await build.withTimeout(bot.dig(cand, true), 2500) } catch {}
      const tp = gameClock.now()
      while (countOf(bot, FILLER_RE) === 0 && gameClock.now() - tp < 700) await sleep(50)
      stats.dodges['выломал блок'] = (stats.dodges['выломал блок'] || 0) + 1
    }
  }
  // На земле ли — подождать до 0.4 с: тело в облаке часто в прыжке (шаг на
  // ступеньку), и правило молчало, пока шли удары (camp2, 144–147 с).
  if (cloudOnMe && (!esc || esc.etaMs > graceMs) && countOf(bot, FILLER_RE) > 0 && !bot.entity.onGround) {
    clearControls(bot)
    const tg = gameClock.now()
    while (!bot.entity.onGround && gameClock.now() - tg < 400) await sleep(50)
  }
  if (cloudOnMe && (!esc || esc.etaMs > graceMs) && countOf(bot, FILLER_RE) > 0 && bot.entity.onGround &&
      isAirish(bot.blockAt(bot.entity.position.floored().offset(0, 2, 0)))) {
    // Быстрый столб (≈6 тиков), а не build.towerUp (пауза и ожидание
    // подтверждения — до секунды): dtr-1-2, 75–76 с — «на блок» не успел до
    // первого удара облака (6 хп).
    const t = await fastTower(bot, ctl, aboveCloudY(bot.entity.position, bad.c), { maxMs: 2500 })
    if (t.placed) {
      stats.dodges['на блок'] = (stats.dodges['на блок'] || 0) + 1
      const w = items.bestWeapon(bot)
      if (w) await bot.equip(w, 'hand').catch(() => {})
      return true
    }
  }
  // Всегда отдать тик: вызывающие циклы крутятся на этом ответе, и «некуда»
  // без ожидания подвешивало весь демон (сервер рвал связь по тайм-ауту).
  if (!esc) {
    // В 9 блоках чистого нет (облака слились) — прочь от центра того, что
    // жжёт, по прямой: из облака радиуса 7 выходят за три секунды, стоя — нет.
    // Путь — только целиком по земле (straightOut): у края лучше принять облако.
    const t = away ? straightOut(bot, me, away) : null
    if (t) {
      stats.dodges.напрямик = (stats.dodges.напрямик || 0) + 1
      if (ctl.trace) ctl.trace.ev('straightOut', { to: [r1(t.x), r1(t.y), r1(t.z)], kind: bad.kind })
      const r = await stepTo(bot, ctl, t, { ms: 2500, stopAt: 0.5 })
      return r.ok
    }
    if (away) stats.dodges['некуда (край)'] = (stats.dodges['некуда (край)'] || 0) + 1
    await sleep(150)
    return false
  }
  const before = bot.entity.position.clone()
  const r = await stepTo(bot, ctl, esc.feet, { ms: Math.max(1500, esc.etaMs + 800), stopAt: 0.5, clouds: esc.through ? 'fb' : true })
  if (!r.ok && Math.hypot(bot.entity.position.x - before.x, bot.entity.position.z - before.z) < 0.5) {
    ctl.evadeBad.push({ feet: esc.feet, t: gameClock.now() })
    if (ctl.trace) ctl.trace.ev('evadeStuck', { to: [r1(esc.feet.x), esc.feet.y, r1(esc.feet.z)], why: r.why })
  }
  return r.ok
}

// Сколько живёт облако (по первому пакету о нём).
const cloudBorn = new Map()
function cloudAgeMs (c) {
  if (!c || !c.e) return 0
  const t = cloudBorn.get(c.e.id)
  return t ? gameClock.now() - t : 5000
}

// Можно ли пройти по прямой клавишами (stepTo): под каждой точкой пути — пол
// не глубже трёх блоков, впереди — не выше ступеньки в блок, над ней два блока
// воздуха. stepTo сам прыгает на ступеньку, в пустоту не шагает.
// Облака и места фаерболов по пути — та же проверка шага, что у stepTo
// (stepIntoZone): войти в чужую зону нельзя, в своей — только наружу. Иначе
// путь, принятый здесь, stepTo обрывал на полпути (зоны у него шире). d4-26
// (30.09, 393–397 с) — уход от посадки напрямик сквозь два облака фаерболов,
// четыре удара по 6, смерть. zones — из cloudZones/zonesOf.
function straightWalkable (bot, from, to, zones = null) {
  const dx = to.x - from.x; const dz = to.z - from.z
  const len = Math.hypot(dx, dz)
  let y = Math.floor(from.y + 0.01)
  let prev = from
  for (let s = 0.5; s <= len; s += 0.5) {
    const x = from.x + dx / len * s; const z = from.z + dz / len * s
    const ny = standY(bot, x, z, y, 1, 3)
    if (ny == null) return false
    if (ny > y + 1) return false
    if (ny > y && !headroom(bot, prev, y)) return false
    if (voidBelow(bot, x, ny + 0.5, z, 12)) return false
    const cur = new Vec3(x, ny, z)
    if (zones && zones.length && stepIntoZone(zones, prev, cur)) return false
    prev = cur
    y = ny
  }
  return true
}

// Сколько блоков прямого пути лежит в чужих облаках (кроме тех, где стоим);
// null — прямой нет (пустота, ступень выше блока).
function straightExposure (bot, from, to, clouds) {
  const dx = to.x - from.x; const dz = to.z - from.z
  const len = Math.hypot(dx, dz)
  const cs = clouds.filter(c => !cloudHits(c, from, 0.3))
  let y = Math.floor(from.y + 0.01)
  let inside = 0
  let prev = from
  for (let s = 0.5; s <= len; s += 0.5) {
    const x = from.x + dx / len * s; const z = from.z + dz / len * s
    const ny = standY(bot, x, z, y, 1, 3)
    if (ny == null || ny > y + 1) return null
    if (ny > y && !headroom(bot, prev, y)) return null
    if (voidBelow(bot, x, ny + 0.5, z, 12)) return null
    if (inClouds(cs, new Vec3(x, ny, z), 0.2)) inside += 0.5
    prev = new Vec3(x, ny, z)
    y = ny
  }
  return inside
}
// Запрыгнуть на ступеньку можно, только если над головой в своей колонке есть
// блок воздуха (голова на прыжке доходит до y + 2.8). ab-25 (30.09, 269–297 с):
// уход «на блок выше» из щели высотой в два блока — 28 с прыжков в потолок на
// месте, облако выросло до тела, три удара по 6, смерть.
function headroom (bot, at, y) {
  const b = bot.blockAt(new Vec3(Math.floor(at.x), y + 2, Math.floor(at.z)))
  return !b || !isSolid(b)
}

// Куда отойти от опасности: ближайшая безопасная клетка в 2..9 блоках, не у
// края, куда можно дойти по прямой; с away — дальше от точки удара лучше;
// с budgetMs — успеть до удара (бег ~5 блоков в секунду с разгоном).
// through — чистого пути нет: можно пройти краем чужого облака (до 2 блоков
// пути в нём; облако бьёт раз в 5 тиков, полсекунды в нём — удар не всегда),
// чем стоять под фаерболом. ab-24 (30.09, 208–213 с): тело на блоке над краем
// старого облака, фаербол летит, 2 с «некуда» (любой шаг вниз — в облако),
// новое облако переехало на ноги — три удара по 6, смерть.
function escapeSpot (bot, ctx, { away = null, budgetMs = null, cloudMargin = 2.2, through = false, skip = null } = {}) {
  const me = bot.entity.position
  const zones = zonesOf(ctx.clouds, ctx.fireballs || [])
  let best = null
  for (const pass of through ? [0, 1] : [0]) {
    for (let r = 2; r <= 9; r++) {
      for (let k = 0; k < 16; k++) {
        const a = 2 * Math.PI * k / 16
        const x = me.x + Math.cos(a) * r; const z = me.z + Math.sin(a) * r
        // Вверх — не больше блока: выше прыжком не взять (stepTo прыгает на 1).
        const y = standY(bot, x, z, me.y, 1, 3)
        if (y == null) continue
        const feet = new Vec3(Math.floor(x) + 0.5, y, Math.floor(z) + 0.5)
        if (nearPortal(feet)) continue
        if (dangerAt(bot, feet, ctx)) continue
        if (inClouds(ctx.clouds, feet, cloudMargin)) continue
        if (nearEdge(bot, feet, 3)) continue
        if (skip && skip.some(b => Math.hypot(b.x - feet.x, b.z - feet.z) < 1.6)) continue
        let exp = 0
        if (pass === 0) {
          if (!straightWalkable(bot, me, feet, zones)) continue
        } else {
          exp = straightExposure(bot, me, feet, ctx.clouds)
          if (exp == null || exp > 2) continue
          if (!straightWalkable(bot, me, feet, zones.filter(z => z.fb))) continue
        }
        const dist = Math.hypot(feet.x - me.x, feet.z - me.z)
        const etaMs = 150 + dist / 5 * 1000
        if (budgetMs != null && etaMs > budgetMs + 400) continue
        let score = dist + exp * 4 + (ctx.prefer ? feet.distanceTo(ctx.prefer) * 0.3 : 0)
        if (away) score -= Math.min(4, Math.hypot(feet.x - away.x, feet.z - away.z) - Math.hypot(me.x - away.x, me.z - away.z)) * 0.5
        if (ctx.sweep && Math.hypot(feet.x - ctx.sweep.pos.x, feet.z - ctx.sweep.pos.z) < 11) score += 6
        if (!best || score < best.score) best = { feet, score, etaMs: Math.round(etaMs), through: pass === 1, exposure: exp }
      }
      if (best && r >= 4) break
    }
    if (best) break
  }
  return best
}

// ------------------------------------------------------------ бой с драконом

// Злой эндермен (бил нас сам — hunters) — ближний бой критами на месте.
// pvp.duel здесь проигрывал: прогон 2026-09-26 (repro1, 276–282 с) — четыре
// взмаха за шесть секунд, семь ударов эндермена по 3.4–3.7 в железе, смерть.
// Водяной щит (ведро под ноги) убран: за три прогона он дважды оставил тело
// без ведра (вода не вернулась в ведро — тело сдвинулось с источника), а без
// ведра падение со столба у клетки стоило 9 хп (repro1, 207 с).
// Механика (исходники 1.21.11): эндермен от удара игрока не телепортируется
// (EnderMan.hurtServer: телепорт, только если источник урона не живое
// существо или это снаряд), 40 хп, бьёт на 7 раз в 20 тиков
// (MeleeAttackGoal), в железе это ~3.8. Крит — ×1.5 в падении
// (Player.attack: fallDistance > 0, не на земле, заряд > 0.9): железный меч
// 9, алмазный 10.5 — пять критов, около трёх секунд. Эндермены — живые
// (LivingEntity), для них крит есть; у частей дракона — нет.
async function fightEnderman (session, ctl, stats, e, stop) {
  const bot = session.bot
  doing(ctl, 'enderman')
  stats.endermen++
  const id = e.id
  const t0 = gameClock.now()
  let ready = gameClock.now() + 100
  let swings = 0
  let killed = false
  if (ctl.trace) ctl.trace.ev('endermanFight', { id, dist: +e.position.distanceTo(bot.entity.position).toFixed(1), hp: bot.health })
  try {
    while (!ctl.aborted && gameClock.now() - t0 < 15000) {
      await yieldTick()
      if (stop && stop()) break
      const en = bot.entities[id]
      if (!en || en.isValid === false || !en.position) { killed = true; break }
      const me = bot.entity.position
      if (en.position.distanceTo(me) > 10) break
      // Облако и фаербол — прежде эндермена: 6 магией раз в секунду хуже его 3.8.
      const bad = hazardNow(bot)
      if (bad) { clearControls(bot); await evade(bot, ctl, stats, bad); continue }
      // Мало хп — яблоко (1.6 с под ударами, но поглощение 4 и регенерация II).
      if (bot.health <= 9 && !hasEffect(bot, 'absorption') && findItem(bot, /golden_apple$/)) {
        clearControls(bot)
        await heal(session, ctl, null, stats, { hard: true })
        ready = gameClock.now() + 100
        continue
      }
      const w = items.bestWeapon(bot)
      if (w && (!bot.heldItem || bot.heldItem.name !== w.name)) {
        await bot.equip(w, 'hand').catch(() => {})
        ready = gameClock.now() + pvp.cooldownMs(w)
        continue
      }
      const box = { min: en.position.offset(-0.3, 0, -0.3), max: en.position.offset(0.3, 2.9, 0.3) }
      const reach = boxDist(me.offset(0, EYE, 0), box)
      // Смотреть в туловище, не в глаза: он и так зол, а сторож взгляда
      // опускает голову от любых глаз эндермена в конусе.
      await bot.lookAt(en.position.offset(0, 1.3, 0), true).catch(() => {})
      // Обрыв впереди — как у stepTo: шаг и прыжок за крит несут тело на 1–2 блока.
      const cliff = runwayAhead(bot, me, -Math.sin(bot.entity.yaw), -Math.cos(bot.entity.yaw), 2.4)
      // И не в облако за эндерменом (общая проверка пути).
      const fx = -Math.sin(bot.entity.yaw); const fz = -Math.cos(bot.entity.yaw)
      const intoCloud = !!stepIntoZone(cloudZones(bot), me, new Vec3(me.x + fx, me.y, me.z + fz))
      const safeStep = (cliff == null || cliff > 1.2) && !intoCloud
      bot.setControlState('forward', reach > 2.6 && safeStep)
      const now = gameClock.now()
      bot.setControlState('jump', now >= ready - 300 && bot.entity.onGround && reach < 3.8 && cliff == null)
      const falling = !bot.entity.onGround && bot.entity.velocity.y < -0.04
      if (now >= ready && reach <= 2.95 && (falling || now >= ready + 450)) {
        bot.attack(en)
        swings++
        ready = now + pvp.cooldownMs(bot.heldItem)
      }
      await sleep(50)
    }
  } finally {
    clearControls(bot)
    if (killed) stats.endermenKilled = (stats.endermenKilled || 0) + 1
    if (ctl.trace) ctl.trace.ev('endermanDone', { id, killed, swings, secs: Math.round((gameClock.now() - t0) / 100) / 10, hp: bot.health })
    dbg('enderman', JSON.stringify({ killed, swings }))
  }
}

// Где стоять, пока дракон сидит: клетка, с которой глаз достаёт до коробки
// головы (≤ 2.9), не в раздутых на 1 голове и шее (там 10 урона каждый тик),
// не в столбце, где встанет облако огня. На неё ставим блок и встаём сверху:
// облако высотой 0.5 лежит на земле — кто на блок выше, того оно не трогает.
// blind — слепой (голова не поворачивается, огня нет): можно и сбоку от головы —
// ближе к нам, чем место строго перед мордой (c1-28, 30.09: к «морде» через весь
// фонтан за 5-секундную посадку не успевал ни разу).
function meleeSpot (bot, d, parts, { blind = false } = {}) {
  const breath = breathOf(bot, d, parts)
  const hc = parts.headC
  let best = null
  for (let dx = -4; dx <= 4; dx++) {
    for (let dz = -4; dz <= 4; dz++) {
      const x = Math.floor(hc.x) + dx; const z = Math.floor(hc.z) + dz
      const gy = standY(bot, x + 0.5, z + 0.5, parts.head.min.y - 1, 3, 6)
      if (gy == null) continue
      if (x === breath.column.x && z === breath.column.z) continue
      // Сколько блоков под себя, чтобы стоять над облаком огня: облако ляжет
      // по земле В ЕГО СТОЛБЦЕ, а земля неровная — его низ бывает выше нашего.
      const inBreath = Math.hypot(x + 0.5 - breath.pos.x, z + 0.5 - breath.pos.z) < BREATH_R + 0.8
      const lift = inBreath ? Math.max(1, Math.ceil(breath.pos.y + CLOUD_SLAB - gy)) : 1
      if (lift > 2) continue
      const pedestal = gy + lift
      const feet = new Vec3(x + 0.5, pedestal, z + 0.5)
      const pb = playerBox(feet)
      if (overlap(pb, inflate(parts.head, HURT_PAD)) || overlap(pb, inflate(parts.neck, HURT_PAD)) || overlap(pb, inflate(parts.body, 0.6))) continue
      // Только перед мордой: сбоку голова метёт дугой, когда дракон
      // поворачивается к игроку.
      // Почти на оси морды: сидящий поворачивает голову к игроку, и кто
      // стоит сбоку даже на 20°, того шея заденет на повороте (так бот погиб:
      // 21° от оси, запас до раздутой шеи 5 сантиметров).
      const rx = feet.x - parts.pos.x; const rz = feet.z - parts.pos.z
      const rh = Math.hypot(rx, rz)
      if (rh < (blind ? 5.5 : HEAD_AHEAD + 1.9)) continue
      if (Math.acos(Math.max(-1, Math.min(1, (rx * parts.dir.x + rz * parts.dir.z) / rh))) > (blind ? 1.3 : 0.14)) continue
      // Голову бьём и с прыжка: проверяем от глаз стоя и в верхней точке.
      const eye = feet.offset(0, EYE, 0)
      const reach = boxDist(eye, parts.head)
      if (reach > MELEE_REACH - 0.2) continue
      // Над головой свободно для прыжка.
      if (!isAirish(bot.blockAt(new Vec3(x, pedestal + 2, z)))) continue
      const along = (feet.x - hc.x) * parts.dir.x + (feet.z - hc.z) * parts.dir.z
      const cost = reach + (along < 0 ? 1.5 : 0) + feet.distanceTo(bot.entity.position) * 0.05
      if (!best || cost < best.cost) best = { feet, ground: new Vec3(x + 0.5, gy, z + 0.5), reach, cost, breath, lift }
    }
  }
  return best
}

// Кровать у головы сидящего — только если кровати с собой. В Энде кровать
// взрывается (BedBlock.explodeBed: Level.explode мощности 5.0, огонь — да) в
// центре изголовья; урон по дракону (bad_respawn_point ∈ #is_explosion ⊂
// #always_hurts_ender_dragons) Paper раздаёт по каждой части дракона в зоне
// (ServerExplosion.hurtEntities → EnderDragonPart.hurtServer), голова — первой
// и полным уроном: ((1−d/10)·видимость)² + …)/2·70 + 1, у головы ~35–55.
// Сидящий засчитывает его (AbstractDragonSittingPhase.onHurt режет только
// стрелы и заряды ветра) и взлетает после 50. Себя — за заслон:
//   B (стоим) — W (блок высотой 1) — F (изножье) — H (изголовье под головой),
// всё по одной оси D к голове. Кровать ставим ДО заслона (клик по верху пола
// под F), заслон — после, щёлкаем изголовье поверх заслона (луч от глаз
// проходит над ним). Лучи взрыва к нижней части тела упираются в W: по оценке
// 2–6 урона в алмазной броне вместо ~19 в открытую.
function bedPlan (bot, d, parts, { brave = false } = {}) {
  const hc = parts.headC
  const me = bot.entity.position
  const zones = { clouds: cloudsOf(bot), fireballs: [], parts, sweep: { pos: d.position, dir: parts.dir } }
  const headPos = new Vec3(hc.x, parts.head.min.y, hc.z)
  const why = {}
  const no = k => { why[k] = (why[k] || 0) + 1 }
  let best = null
  for (const [dx, dz] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
    // D — от нас к голове, то есть против взгляда морды (стоим перед ней).
    if (dx * parts.dir.x + dz * parts.dir.z > -0.5) continue
    for (let ox = -2; ox <= 2; ox++) {
      for (let oz = -2; oz <= 2; oz++) {
        const hx = Math.floor(hc.x) + ox; const hz = Math.floor(hc.z) + oz
        // Уровень — по изножью (его ставим кликом по полу); изголовью пол не
        // нужен: кровать не проверяет опору (BedBlock без canSurvive).
        const g = standY(bot, hx - dx + 0.5, hz - dz + 0.5, parts.head.min.y - 1, 1, 6)
        if (g == null) { no('земля'); continue }
        const cells = [0, 1, 2, 3].map(k => ({ x: hx - k * dx, z: hz - k * dz }))
        let ok = true
        for (let i = 0; i < 4 && ok; i++) {
          const c = cells[i]
          const floor = bot.blockAt(new Vec3(c.x, g - 1, c.z))
          const at = bot.blockAt(new Vec3(c.x, g, c.z))
          if (i > 0 && (!isSolid(floor) || /portal|bed$/.test(floor.name))) ok = false
          else if (i === 2) ok = isAirish(at) || (isSolid(at) && FILLER_RE.test(at.name))
          else ok = isAirish(at) || (!!at && /^fire$/.test(at.name) && i < 2)
          if (ok && i === 3) ok = isAirish(bot.blockAt(new Vec3(c.x, g + 1, c.z)))
        }
        if (!ok) { no('клетки'); continue }
        const centre = new Vec3(hx + 0.5, g + 0.5, hz + 0.5)
        const dist = centre.distanceTo(headPos)
        if (dist > 4) { no('далеко от головы'); continue }
        const feet = new Vec3(cells[3].x + 0.5, g, cells[3].z + 0.5)
        const bad = dangerAt(bot, feet, zones)
        if (bad && !(brave && /облако/.test(bad.kind))) { no(bad.kind); continue }
        // Запас как у walkTo (цель ближе 2.5 к облаку он отвергает). Смелый —
        // идёт и в облако: дыхание — 3 в секунду, кровать — секунда-полторы.
        if (!brave && inClouds(zones.clouds, feet, 2.5)) { no('у облака'); continue }
        if (overlap(playerBox(feet), inflate(parts.body, 0.6))) { no('тело'); continue }
        if (feet.offset(0, EYE, 0).distanceTo(centre) > 4.2) { no('не дотянуться'); continue }
        const cost = dist + feet.distanceTo(me) * 0.1
        if (!best || cost < best.cost) best = { H: cells[0], F: cells[1], W: cells[2], B: cells[3], g, D: { x: dx, z: dz }, feet, centre, dist, cost }
      }
    }
  }
  if (!best) bedPlan.why = why
  return best
}

async function bedBlast (session, ctl, rep, stats, track) {
  const bot = session.bot
  const d0 = dragonOf(bot)
  if (!d0) return null
  const sitting = () => { const dd = dragonOf(bot); return !!dd && SITTING.has(phaseOf(bot, dd)) }
  const blast = { at: Math.round(hpOf(bot, d0) ?? 0), beds: 0, dmg: 0, dist: [] }
  // Дракон ударил, пока шли к месту кровати (голова довернулась) — бросить:
  // d8-22 (30.09, 269–270 с) — два удара по 6 на пути к кровати, смерть позже.
  const tBed = gameClock.now()
  const struck = () => (hitBy.get(d0.id) || 0) > tBed
  // Взрыв кровати поджигает (fire = true): огнестойкость, если есть.
  if (bot.entity.position.distanceTo(d0.position) > HEAD_AHEAD + 4) await usePotion(bot, stats, 'fire_resistance')
  // Каждая кровать — по новому плану: взрыв выбивает пол под изножьем и
  // заслон (прогон: вторая кровать на старое место — «ответа от сервера нет»).
  for (let n = 0; n < 4 && !ctl.aborted && sitting() && countOf(bot, /_bed$/) > 0; n++) {
    await yieldTick()
    const d = dragonOf(bot)
    const parts = partsOf(bot, d, track)
    // Смелый (идёт к месту кровати сквозь облако огня, 3 за удар) — только с
    // запасом: жать кровать можно с 16 хп и выше (см. ниже).
    const brave = bot.health >= 19 || (hasEffect(bot, 'absorption') && bot.health >= 14)
    const plan = bedPlan(bot, d, parts, { brave })
    if (!plan) { if (!n) stats.bedNoSpot = (stats.bedNoSpot || 0) + 1; blast.why = blast.why || 'нет места под кровать'; break }
    if (!n) stats.beds.push(blast)
    blast.dist.push(+plan.dist.toFixed(1))
    doing(ctl, 'bed:walk')
    if (Math.hypot(bot.entity.position.x - plan.feet.x, bot.entity.position.z - plan.feet.z) > 0.5) {
      // Рядом и на одной высоте — клавишами (pathfinder с ценой облаков и зон
      // головы на 7 с не успевал: «не дошёл за 7с» три посадки подряд).
      const near = bot.entity.position.distanceTo(plan.feet) < 7 && Math.abs(bot.entity.position.y - plan.feet.y) < 1.2
      const s1 = near ? await stepTo(bot, ctl, plan.feet, { ms: 3000, sprint: false, stopAt: 0.3, stop: struck }) : { ok: false }
      if (struck()) { blast.why = 'ударил дракон'; const rs = sitRec && !sitRec.ended ? sitRec : null; if (rs) rs.hitBack = gameClock.now(); break }
      const w = s1.ok ? s1 : await walkTo(session, ctl, plan.feet, { range: 0, timeoutMs: 12000, hazards: brave ? 'noclouds' : true })
      if (struck()) { blast.why = 'ударил дракон'; const rs = sitRec && !sitRec.ended ? sitRec : null; if (rs) rs.hitBack = gameClock.now(); break }
      if (!w.ok && Math.hypot(bot.entity.position.x - plan.feet.x, bot.entity.position.z - plan.feet.z) > 0.9) { blast.why = `не дошёл до места: ${w.why}`; break }
      await stepTo(bot, ctl, plan.feet, { ms: 800, sprint: false, stopAt: 0.15 })
    }
    clearControls(bot)
    if (!sitting()) break
    const hz = hazardNow(bot, { parts: partsOf(bot, dragonOf(bot), track) })
    if (hz && !(brave && /облако/.test(hz.kind))) { blast.left = `опасность: ${hz.kind}`; break }
    const hAt = new Vec3(plan.H.x, plan.g, plan.H.z)
    const wAt = new Vec3(plan.W.x, plan.g, plan.W.z)
    // Кровать: изножье на F, изголовье — туда, куда смотрим (D).
    doing(ctl, 'bed:place')
    try {
      await bot.equip(findItem(bot, /_bed$/), 'hand')
      await build.withTimeout(bot.placeBlock(bot.blockAt(new Vec3(plan.F.x, plan.g - 1, plan.F.z)), new Vec3(0, 1, 0)), 2500)
    } catch (e) { dbg('bed place', e.message) }
    await sleep(100)
    const hb = bot.blockAt(hAt)
    if (!hb || !/_bed$/.test(hb.name)) { blast.why = `кровать не встала (${hb ? hb.name : '?'})`; break }
    // Заслон после кровати: с ним клик по полу под F уже не виден. Два блока
    // в высоту: через заслон в один лучи взрыва шли к верху тела над ним —
    // e2e12, 355 с: вторая кровать за 1.4 с сняла 16 хп в железе, смерть
    // (сервер клик поверх заслона видимостью не проверяет — handleUseItemOn).
    for (const w of [wAt, wAt.offset(0, 1, 0)]) {
      if (isSolid(bot.blockAt(w))) continue
      const r = await sneakPlace(bot, w, { timeoutMs: 2500 })
      if (!r.ok) { blast.why = `заслон не встал: ${r.reason || r.why}`; break }
    }
    if (blast.why) break
    // Хп — с запасом на неудачный взрыв (~16 в открытую с трёх блоков).
    if (bot.health < 16 && !hasEffect(bot, 'absorption')) { blast.why = `мало хп (${Math.round(bot.health)}) для кровати`; break }
    // Щёлкать — только стоя на своём месте за заслоном: рефлекс «на блок» (облако
    // огня под ногами) поднимал тело над заслоном, и взрыв бил в открытую —
    // v3-25 (30.09, 234.9 с): 17 хп → смерть от своей кровати.
    {
      const pp = bot.entity.position
      if (Math.hypot(pp.x - plan.feet.x, pp.z - plan.feet.z) > 0.6 || Math.abs(pp.y - plan.feet.y) > 0.3) { blast.why = 'не за заслоном — не щёлкаю'; break }
    }
    // Щёлкнуть изголовье поверх заслона: в руке — не кровать (иначе клик
    // может уйти в установку второй), не крадучись.
    const w = items.bestWeapon(bot)
    if (w) await bot.equip(w, 'hand').catch(() => {})
    bot.setControlState('sneak', false)
    const before = hpOf(bot, dragonOf(bot))
    const myHp = bot.health
    doing(ctl, 'bed:click')
    if (ctl.trace) ctl.trace.ev('bed', { dragonHp: before, me: myHp, dist: +plan.dist.toFixed(1) })
    try { await bot.activateBlock(hb, new Vec3(0, 1, 0), new Vec3(0.5, 0.56, 0.5)) } catch (e) { dbg('bed use', e.message) }
    await sleep(300)
    const gone = !bot.blockAt(hAt) || !/_bed$/.test(bot.blockAt(hAt).name)
    if (!gone) { blast.why = 'щёлкнул — не взорвалась'; break }
    blast.beds++
    stats.bedsUsed = (stats.bedsUsed || 0) + 1
    const dd = dragonOf(bot)
    const after = dd ? hpOf(bot, dd) : 0
    if (before != null && after != null && after < before) { blast.dmg += before - after; stats.dmg += before - after; if (sitRec && !sitRec.ended) sitRec.dmg = (sitRec.dmg || 0) + before - after }
    blast.selfDmg = Math.round(((blast.selfDmg || 0) + Math.max(0, myHp - bot.health)) * 10) / 10
    dbg('bed', 'dragon', before, '->', after, 'me', myHp, '->', bot.health)
    // Взрыв перевалил сидячий урон за 50 — взлёт, а мы у головы: сразу вбок от оси.
    if (dd && phaseOf(bot, dd) === PHASE.TAKEOFF) { await takeoffSidestep(bot, ctl, dd, 'взлёт от кровати'); break }
    // Огонь под ногами — шаг назад, прочь от заслона.
    const fire = bot.blockAt(bot.entity.position.floored())
    if (fire && /fire/.test(fire.name)) await stepTo(bot, ctl, bot.entity.position.offset(-plan.D.x * 2, 0, -plan.D.z * 2), { ms: 900, stopAt: 0.4 })
    if (bot.health < 16) break
  }
  blast.dmg = Math.round(blast.dmg)
  return blast.beds || blast.why ? blast : null
}

// Взлёт начался, а мы у головы (свой удар или кровать перевалили сидячий урон за
// 50): вбок от оси взгляда на 6 блоков, не ожидая круга боя — он летит вперёд
// низко, крылья по 10.5 вбок (c1-27, 30.09, 266 с: 20 → 9.4 за секунду).
async function takeoffSidestep (bot, ctl, d, kind) {
  const me = bot.entity.position
  const ax = Math.sin(d.yaw); const az = Math.cos(d.yaw)
  const side = Math.sign((me.x - d.position.x) * az - (me.z - d.position.z) * ax) || 1
  // Из двух сторон — где земля (без обрыва) и не облако; своя сторона первой.
  for (const sd of [side, -side]) {
    const t = me.offset(az * sd * 6, 0, -ax * sd * 6)
    const y = standY(bot, t.x, t.z, me.y, 1, 3)
    if (y == null) continue
    const feet = new Vec3(t.x, y, t.z)
    if (inClouds(cloudsOf(bot), feet, 0.5)) continue
    if (ctl.trace) ctl.trace.ev('evade', { kind, to: [r1(feet.x), feet.y, r1(feet.z)] })
    await stepTo(bot, ctl, feet, { ms: 1400, stopAt: 0.5, clouds: false })
    return true
  }
  return false
}
// Яма под собой (2026-09-30): ноги на F ≤ Y − 3.8 — ниже коробок удара
// крыльев, головы и шеи (низ Y − 2). 1–2 блока копаемого, пол под F твёрдый,
// не у чаши портала и не над пустотой.
const HOLE_TOP = 3.8
const DIGGABLE_RE = /^(end_stone|cobblestone|cobbled_deepslate|dirt|stone|netherrack|andesite|diorite|granite|tuff|blackstone)$/
function duckPlan (bot, F) {
  const p = bot.entity.position
  const fy = Math.floor(p.y + 0.01); const x = Math.floor(p.x); const z = Math.floor(p.z)
  if (fy <= F) return { dig: 0 }
  if (fy - F > 2 || Math.hypot(x + 0.5 - CENTER.x, z + 0.5 - CENTER.z) < 4.6) return null
  for (let y = F; y < fy; y++) {
    const b = bot.blockAt(new Vec3(x, y, z))
    if (!b || !(isAirish(b) || DIGGABLE_RE.test(b.name))) return null
  }
  if (!isSolid(bot.blockAt(new Vec3(x, F - 1, z))) || voidBelow(bot, x + 0.5, F, z + 0.5, 6)) return null
  return { dig: fy - F }
}
async function duck (bot, ctl, F) {
  const p = bot.entity.position
  const c = new Vec3(Math.floor(p.x) + 0.5, p.y, Math.floor(p.z) + 0.5)
  if (Math.hypot(p.x - c.x, p.z - c.z) > 0.15) await stepTo(bot, ctl, c, { ms: 700, sprint: false, stopAt: 0.12, clouds: false })
  await digDownTo(bot, ctl, F, 3)
  return Math.floor(bot.entity.position.y + 0.01) <= F
}
// Уйти от морды до взлёта: на 14–20 от тела, вне коридора взлёта (вперёд по
// взгляду ±0.6 рад, крылья по 10.5 вбок), не у края и не в облаке.
async function leaveFront (session, ctl, stats, d, rec) {
  const bot = session.bot
  doing(ctl, 'perch:leave')
  const boxes = takeoffBoxes(d.position, d.yaw)
  const me0 = bot.entity.position
  const farOk = blindKnown(rec) || me0.distanceTo(d.position) <= STAY_R + 0.5
  if (!boxes.some(b => overlap(playerBox(me0), b)) && farOk) { doing(ctl, 'perch:away'); await lookAtSafe(bot, d.position.offset(0, 2, 0)); await sleep(150); return true }
  // Сперва — вбок от головы и шеи (awayFromHead), потом место на СВОЕЙ стороне
  // оси дракона: путь не через морду (d13-18, 30.09, 460–462 с: отход к месту
  // по ту сторону — мимо головы, четыре удара по 6, смерть).
  const parts = partsOf(bot, d, null)
  if (Math.hypot(me0.x - parts.headC.x, me0.z - parts.headC.z) < 6.5) await stepTo(bot, ctl, awayFromHead(d, parts, me0, 3.5), { ms: 1100, stopAt: 0.4 })
  const dir = parts.dir
  const sideOf = f => Math.sign((f.x - d.position.x) * dir.z - (f.z - d.position.z) * dir.x) || 1
  const me = bot.entity.position
  const mySide = sideOf(me)
  const far = f => !blindKnown(rec) && f.distanceTo(d.position) > STAY_R
  // Путь к месту — не мимо головы: c2-4 (30.09, 227–231 с) — от морды к месту
  // за телом вдоль бока, удар головой на 6.
  // Порог — не больше, чем мы уже от головы: стоя у морды, любой путь «рядом с
  // головой» (v1-17, 30.09, 199–220 с: 182 раза «места нет», тело так и стояло
  // перед мордой). Нельзя только ПРИБЛИЖАТЬСЯ к ней по пути.
  const hd0 = Math.hypot(me.x - parts.headC.x, me.z - parts.headC.z)
  const byHead = f => segPoint2(me, f, parts.headC) < Math.min(5.5, hd0 - 0.3)
  const spot = pickSpot(bot, { x: d.position.x, z: d.position.z }, { rMin: 10, rMax: blindKnown(rec) ? 20 : 15, prefer: me, avoid: f => sideOf(f) !== mySide || boxes.some(b => overlap(playerBox(f), inflate(b, 1))) || nearPillar(bot, f, 2) || far(f) || byHead(f) }) ||
    pickSpot(bot, { x: d.position.x, z: d.position.z }, { rMin: 10, rMax: blindKnown(rec) ? 20 : 15, prefer: me, avoid: f => boxes.some(b => overlap(playerBox(f), inflate(b, 1))) || nearPillar(bot, f, 2) || far(f) || byHead(f) })
  stats.leftFront = (stats.leftFront || 0) + 1
  if (ctl.trace) ctl.trace.ev('leaveFront', { to: spot ? [r1(spot.feet.x), spot.feet.y, r1(spot.feet.z)] : null, flames: rec.flames, dmg: Math.round(rec.dmg || 0) })
  if (!spot) { await sleep(150); return false }
  const w = await walkTo(session, ctl, spot.feet, { range: 1, timeoutMs: 8000 })
  return w.ok
}
// Садится или сел (не слепой), а мы дальше круга от фонтана — будет таран.
function perchFar (bot) {
  const dd = dragonOf(bot)
  if (!dd) return null
  const ph = phaseOf(bot, dd)
  if (!(SITTING.has(ph) || ph === PHASE.LANDING)) return null
  if (sight.get(sightKey(dd.id)) === 'blind' || (SITTING.has(ph) && blindKnown(sitRec))) return null
  return Math.hypot(bot.entity.position.x - CENTER.x, bot.entity.position.z - CENTER.z) > STAY_R + 0.5 ? 'садится/сел — дальше круга, будет таран' : null
}
async function perchApproach (session, ctl, stats) {
  const bot = session.bot
  const dd = dragonOf(bot)
  if (!dd) return false
  const ph = phaseOf(bot, dd)
  if (ph !== PHASE.SCANNING) return false
  { const rc = sitState(dd, ph, gameClock.now()); if (rc) noteNear(rc, dd, bot, gameClock.now()) }
  if (!perchFar(bot)) return false
  {
    const P = podiumTop(bot)
    const Y = ph === PHASE.SCANNING || SITTING.has(ph) ? dd.position.y : (P != null ? P + 0.5 : dd.position.y)
    const F = Math.floor(Y - 0.6 - HOLE_TOP - 0.15)
    const plan = duckPlan(bot, F)
    if (plan) {
      doing(ctl, 'perch:duck')
      if (plan.dig === 0) { await sleep(250); return true }
      stats.dodges['нырок'] = (stats.dodges['нырок'] || 0) + 1
      if (ctl.trace) ctl.trace.ev('duck', { kind: 'посадка у клеток', F, dig: plan.dig })
      await duck(bot, ctl, F)
      return true
    }
  }
  if (ph === PHASE.SCANNING) { await keepInScan(session, ctl, stats, dd, partsOf(bot, dd, null)); return true }
  if (ph !== PHASE.LANDING) return false
  doing(ctl, 'perch:close')
  const spot = pickSpot(bot, CENTER, { rMin: 15, rMax: 16.5, prefer: bot.entity.position, avoid: f => nearPillar(bot, f, 2) })
  if (ctl.trace) ctl.trace.ev('keepInScan', { to: spot ? [r1(spot.feet.x), spot.feet.y, r1(spot.feet.z)] : null, landing: true })
  if (spot) await walkTo(session, ctl, spot.feet, { range: 1.5, timeoutMs: 8000 })
  else await sleep(200)
  return true
}
// Ближе к сидящему видящему (или ещё не ясно): место в 10–15 блоках от него,
// не в коридоре взлёта (там же огонь), своей стороной оси, и путь — обычный
// walkTo (облака обходит). Нет места — стоять.
async function keepInScan (session, ctl, stats, d, parts) {
  const bot = session.bot
  doing(ctl, 'perch:close')
  // Дальше ~27 — за 100 тиков в круг 20 не успеть (v1, 30.09: «ближе» с 36–40
  // блоков — таран на полпути по открытому). Тогда нырнуть на месте на 1–2 блока:
  // тело на таране идёт почти на высоте посадки, низ коробок — Y − 2.
  if (bot.entity.position.distanceTo(d.position) > 27) {
    const F = Math.floor(d.position.y - 0.6 - HOLE_TOP - 0.15)
    const plan = duckPlan(bot, F)
    if (plan) {
      if (plan.dig === 0) { await sleep(200); return true }
      stats.dodges['нырок'] = (stats.dodges['нырок'] || 0) + 1
      if (ctl.trace) ctl.trace.ev('duck', { kind: 'далеко от сидящего', F, dig: plan.dig })
      return await duck(bot, ctl, F)
    }
  }
  const boxes = takeoffBoxes(d.position, d.yaw)
  const me = bot.entity.position
  const dir = parts.dir
  const sideOf = f => Math.sign((f.x - d.position.x) * dir.z - (f.z - d.position.z) * dir.x) || 1
  const mySide = sideOf(me)
  const hd0 = Math.hypot(me.x - parts.headC.x, me.z - parts.headC.z)
  const ok = f => !boxes.some(b => overlap(playerBox(f), inflate(b, 1))) && !nearPillar(bot, f, 2) && f.distanceTo(d.position) <= STAY_R && Math.abs(f.y - d.position.y) <= 8 && segPoint2(me, f, parts.headC) >= Math.min(5.5, hd0 - 0.3)
  const spot = pickSpot(bot, { x: d.position.x, z: d.position.z }, { rMin: 10, rMax: 15, prefer: me, avoid: f => !ok(f) || sideOf(f) !== mySide }) ||
    pickSpot(bot, { x: d.position.x, z: d.position.z }, { rMin: 10, rMax: 15, prefer: me, avoid: f => !ok(f) })
  stats.keptInScan = (stats.keptInScan || 0) + 1
  if (ctl.trace) ctl.trace.ev('keepInScan', { to: spot ? [r1(spot.feet.x), spot.feet.y, r1(spot.feet.z)] : null, dist: r1(me.distanceTo(d.position)) })
  if (!spot) {
    // Места нет, а мы и так в круге (с запасом) — стоять; нет — к центру фонтана
    // обычным путём (дальше 20 — таран).
    if (me.distanceTo(d.position) <= SCAN_RANGE - 2) { await sleep(250); return true }
    await sleep(150)
    return false
  }
  const w = await walkTo(session, ctl, spot.feet, { range: 1.5, timeoutMs: 6000 })
  return w.ok
}
// Горизонтальное расстояние от точки c до отрезка a–b.
function segPoint2 (a, b, c) {
  const vx = b.x - a.x; const vz = b.z - a.z
  const L2 = vx * vx + vz * vz
  const t = L2 > 1e-9 ? Math.max(0, Math.min(1, ((c.x - a.x) * vx + (c.z - a.z) * vz) / L2)) : 0
  return Math.hypot(a.x + vx * t - c.x, a.z + vz * t - c.z)
}
// Куда отступить от головы и шеи: перед мордой — дальше вперёд по оси, сбоку
// от шеи — вбок от оси (не вдоль: d8-17, 30.09, 358–359 с — «назад по оси
// морды» из-под шеи вёл прямо к голове, четыре удара подряд).
function awayFromHead (d, parts, feet, dist) {
  const ax = parts.dir.x; const az = parts.dir.z
  const rx = feet.x - d.position.x; const rz = feet.z - d.position.z
  const along = rx * ax + rz * az
  const px = rx - along * ax; const pz = rz - along * az
  const pl = Math.hypot(px, pz)
  let ux; let uz
  if (along > HEAD_AHEAD + 0.5 && pl < 1.5) { ux = ax; uz = az } else if (pl > 0.3) { ux = px / pl; uz = pz / pl } else { ux = -ax; uz = -az }
  return feet.offset(ux * dist, 0, uz * dist)
}
// Ударить сидящего в голову: прыжок, удар на падении (крит), по id головы.
async function perchAttack (session, ctl, rep, stats, track) {
  const bot = session.bot
  doing(ctl, 'perch')
  let d = dragonOf(bot)
  if (!d) return
  let parts = partsOf(bot, d, track)
  // Посадка (2026-09-30). Видящий (ревёт на 25-м тике) сидит до четырёх огней
  // или до > 50 урона — уйти от морды заранее: начался четвёртый огонь, снято
  // ≥ 44 или дракон нас ударил. Слепой (1.6 с без рёва: Sensing у дракона не
  // очищается) сидит 100 тиков и взлетает низко вперёд по взгляду (dtr-1-2:
  // девять слепых посадок, взлёт на 4.6–5 с, пять заходов под крылья) — к нему
  // тоже, но без подставки (огня не будет), а к 3.4 с — нырнуть в яму под
  // собой: коробки взлёта (крылья, шея: низ Y − 2) пройдут поверх.
  const rec = sitState(d, phaseOf(bot, d), gameClock.now())
  // Дракон бил нас в эту посадку (где угодно: у кровати, на подходе) — к голове
  // больше не лезть.
  const hitAt0 = hitBy.get(d.id)
  if (rec && hitAt0 && hitAt0 > rec.t0 && !rec.hitBack) rec.hitBack = hitAt0
  // Подставки не было, а видящий ревёт или дышит — к голове не идти до «высматривает».
  if (rec && rec.noPedestal && rec.roared && (phaseOf(bot, d) === PHASE.ROARING || phaseOf(bot, d) === PHASE.FLAMING) && countOf(bot, FILLER_RE) < 1) {
    doing(ctl, 'perch:wait-flame')
    const bad = hazardNow(bot)
    if (bad) await evade(bot, ctl, stats, bad)
    else { await lookAtSafe(bot, parts.headC); await sleep(150) }
    return
  }
  // Видящий высматривает (25 тиков каждого круга) — голова поворачивается к нам
  // и метёт дугу: к голове — только на рёве и огне (голова стоит 12 с), а пока
  // высматривает — ждать поодаль. Первые 1.6 с посадки — тоже ждать: слепой он
  // или видящий, ещё не ясно (d8-17, d10-26, d7-21: удары головой на
  // повороте). Слепой — к голове сразу, как стало ясно.
  if (rec) noteNear(rec, d, bot, gameClock.now())
  // Видящий (или пока не ясно) высматривает, а мы дальше STAY_R — ближе, в
  // сторону от морды: иначе через 100 тиков таран (см. SCAN_RANGE).
  if (rec && phaseOf(bot, d) === PHASE.SCANNING && !blindKnown(rec) && bot.entity.position.distanceTo(d.position) > STAY_R + 0.5) {
    await keepInScan(session, ctl, stats, d, parts)
    return
  }
  {
    const phNow = phaseOf(bot, d)
    if (rec && phNow === PHASE.SCANNING && (rec.roared || !blindKnown(rec))) {
      doing(ctl, 'perch:scan')
      const bad = hazardNow(bot, { parts })
      if (bad) await evade(bot, ctl, stats, bad)
      else {
        const rx = bot.entity.position.x - d.position.x; const rz = bot.entity.position.z - d.position.z
        const inPit = bot.entity.position.y <= d.position.y - HOLE_TOP + 0.05
        if (Math.hypot(rx, rz) < HEAD_AHEAD + 3.5 && !inPit) await stepTo(bot, ctl, awayFromHead(d, parts, bot.entity.position, 3), { ms: 900, stopAt: 0.4 })
        else { await lookAtSafe(bot, parts.headC); await sleep(100) }
      }
      return
    }
  }
  // Нырнули до взлёта слепого — сидеть в яме до конца посадки.
  if (rec && rec.ducked) { doing(ctl, 'perch:ducked'); await lookAtSafe(bot, parts.headC); await sleep(150); return }
  if (rec && (rec.flames >= 4 || (rec.dmg || 0) >= 44 || rec.hitBack)) {
    await leaveFront(session, ctl, stats, d, rec)
    return
  }
  // С малым хп к голове не идти: сидячий огонь — 3 магией в секунду сквозь
  // броню, и одна ошибка с подставкой стоит жизни. Сперва еда.
  // Яблоко — заранее, пока до головы далеко: поглощение (4) и регенерация II
  // приходят через 1.6 с и держат сквозь огонь, а вплотную на еду времени нет.
  if (bot.health < 16 && findItem(bot, /golden_apple$/) && !hasEffect(bot, 'absorption') &&
      bot.entity.position.distanceTo(d.position) > HEAD_AHEAD + 3) {
    await heal(session, ctl, rep, stats, { hard: true })
  }
  if (bot.health < 12) {
    await heal(session, ctl, rep, stats, { hard: true })
    if (bot.health < 10) { stats.skippedPerch = (stats.skippedPerch || 0) + 1; await sleep(300); return }
  }
  // Удар может поднять его на взлёт (накопленный сидячий урон у 50), а у головы
  // мы в коридоре взлёта: голова и крылья — до 11 хп. Только с запасом хп.
  if (takeoffOnHit() && bot.health < 16) {
    await heal(session, ctl, rep, stats, { hard: true })
    if (bot.health < 16) { stats.skippedPerch = (stats.skippedPerch || 0) + 1; await sleep(300); return }
  }
  // Кровати с собой — сперва они (урон сразу, у головы не стоять). Не вышло
  // трижды подряд без единого взрыва — дальше только меч.
  const ph0 = phaseOf(bot, d)
  // Слепому (посадка 5 с) — не кровать: поставить её, заслон и щёлкнуть к взлёту не
  // успеть, а стоим с ней по оси морды — в коридоре взлёта. Меч быстрее.
  if (ctl.beds && !blindKnown(rec) && countOf(bot, /_bed$/) > 0 && bot.health >= 12 && !((stats.bedTried || 0) >= 3 && !stats.bedsUsed)) {
    const soonFlame = ph0 === PHASE.ROARING ? breathOf(bot, d, parts) : null
    const plan = bedPlan(bot, d, parts, { brave: bot.health >= 19 || (hasEffect(bot, 'absorption') && bot.health >= 14) })
    if (!plan) { stats.bedNoPlan = stats.bedNoPlan || {}; for (const [k, v] of Object.entries(bedPlan.why || {})) stats.bedNoPlan[k] = (stats.bedNoPlan[k] || 0) + v; if (DEBUG && gameClock.now() - (stats.bedPlanLog || 0) > 2000) { stats.bedPlanLog = gameClock.now(); dbg('bed plan', PHASE_RU[ph0], JSON.stringify(bedPlan.why)) } }
    if (plan && !(soonFlame && cloudHits(soonFlame, plan.feet, 0.8))) {
      stats.bedTried = (stats.bedTried || 0) + 1
      const b = await bedBlast(session, ctl, rep, stats, track)
      if (b && b.beds) return
    }
  }
  const spot = meleeSpot(bot, d, parts, { blind: blindKnown(rec) })
  if (!spot) { stats.noSpot++; return }
  // Облака фаерболов у фонтана (живут 30 с, растут до 7) — к голове сквозь
  // них не идти: d8-19, d10-20, d10-26 (30.09) — подход к голове через облака,
  // 2–4 удара по 6, добивала голова. Прямой путь или место у головы в чужом
  // облаке (не в огне, который встанет под подставку) — пропустить посадку.
  {
    const fb = cloudsOf(bot).filter(c => c.r < BREATH_R - 0.3 || c.pos.distanceTo(parts.headC) > BREATH_AHEAD + 3)
    const me1 = bot.entity.position
    if (inClouds(fb, spot.ground, 1) || !straightWalkable(bot, me1, spot.ground, zonesOf(fb))) {
      stats.perchCloudy = (stats.perchCloudy || 0) + 1
      doing(ctl, 'perch:cloudy')
      const bad = hazardNow(bot)
      if (bad) await evade(bot, ctl, stats, bad)
      else await sleep(200)
      return
    }
  }
  // Огонь уже лежит — к голове идти сквозь него (подставка ставится на месте,
  // а дорога до неё — по облаку). Ждать снаружи конца выдоха (200 тиков), а
  // подходить в окне «высматривает/ревёт» — до следующего огня ~3 с.
  const onSpot = Math.hypot(bot.entity.position.x - spot.ground.x, bot.entity.position.z - spot.ground.z) < 0.8 && bot.entity.position.y >= spot.feet.y - 0.01
  const flame = cloudsOf(bot).find(c => c.pos.distanceTo(parts.headC) < BREATH_AHEAD + 3 && c.r >= BREATH_R - 0.5)
  let through = false
  if (flame && !onSpot && Math.hypot(spot.ground.x - flame.pos.x, spot.ground.z - flame.pos.z) < flame.r + 1) {
    // Облако огня живёт 10 с, а огонь повторяется каждые ~13 с: ждать его
    // конца значит пропустить всю посадку (прогон: четыре выдоха, ни одного
    // удара — тело металось между облаком и предсказанным облаком). Облако
    // дыхания — 3 магией в секунду (мгновенный урон I ×0.5, раз в 20 тиков),
    // до подставки в 3–5 блоках — 3–9 хп. Сквозь него — если здоровья хватает.
    // Сквозь огонь к голове — только с полным хп: e2e14 (274–279 с) — с 20 хп
    // сквозь облако (3, 3), у головы удар шеи на 10 — смерть. С кроватями
    // ближний бой — последнее средство.
    const brave = (bot.health >= 19 || (hasEffect(bot, 'absorption') && bot.health >= 16)) && !(ctl.beds && countOf(bot, /_bed$/) > 0) &&
      bot.entity.position.distanceTo(spot.ground) < 9 && countOf(bot, FILLER_RE) >= spot.lift
    if (!brave) {
      stats.waitedFlame = (stats.waitedFlame || 0) + 1
      await sleep(300)
      return
    }
    through = true
  }
  const perch = { at: Math.round(hpOf(bot, d)), hits: 0, dmg: 0, head: 0, body: 0 }
  doing(ctl, 'perch:approach')
  if (through) perch.throughFlame = true
  stats.perches.push(perch)
  const hz = through ? 'noclouds' : true
  // Подойти к клетке у головы: по прямой, если близко и путь ровный, иначе
  // pathfinder (между ботом и головой часто чаша портала и столб).
  let me = bot.entity.position
  const standing = () => SITTING.has(phaseOf(bot, dragonOf(bot))) || phaseOf(bot, dragonOf(bot)) === PHASE.LANDING
  // Шаг к подставке — не в голову и не в шею: пока идём, дракон доворачивает
  // голову к нам (прогон 2026-09-25: шаг клавишами в раздутую шею — два удара
  // по 10, смерть с 20 в железе). Раздутые на 1.4 — стоп.
  const nearHead = () => {
    const dd = dragonOf(bot)
    if (!dd) return false
    const pp = partsOf(bot, dd, track)
    const pb = playerBox(bot.entity.position)
    return overlap(pb, inflate(pp.head, 1.4)) || overlap(pb, inflate(pp.neck, 1.4))
  }
  // Сбоку к голове не подходить — её дуга (см. dangerAt, sweep): сначала выйти
  // на ось морды подальше, потом шагнуть к ней спереди.
  {
    const rx = me.x - d.position.x; const rz = me.z - d.position.z
    const h = Math.hypot(rx, rz)
    const ang = h > 0.1 ? Math.acos(Math.max(-1, Math.min(1, (rx * parts.dir.x + rz * parts.dir.z) / h))) : Math.PI
    // Слепому голову не поворачивать — к месту сбоку напрямую.
    if (!blindKnown(rec) && (ang > 0.45 || h < HEAD_AHEAD)) {
      const front = d.position.offset(parts.dir.x * (HEAD_AHEAD + 5), 0, parts.dir.z * (HEAD_AHEAD + 5))
      const fy = standY(bot, front.x, front.z, spot.ground.y, 4, 6)
      if (fy != null) {
        perch.viaFront = true
        await walkTo(session, ctl, new Vec3(front.x, fy, front.z), { range: 1.5, timeoutMs: 8000, hazards: hz })
        me = bot.entity.position
      }
    }
  }
  if (Math.hypot(me.x - spot.ground.x, me.z - spot.ground.z) > 0.6) {
    let r = me.distanceTo(spot.ground) < 5 ? await stepTo(bot, ctl, spot.ground, { ms: 2000, stopAt: 0.25, sprint: false, clouds: !through, stop: () => !standing() || nearHead() || (!through && !!inClouds(cloudsOf(bot), bot.entity.position, 0.3)) }) : { ok: false }
    if (nearHead()) { perch.why = 'шея довернулась к нам'; await stepTo(bot, ctl, awayFromHead(d, parts, bot.entity.position, 3), { ms: 900, stopAt: 0.4 }); return }
    if (!r.ok && standing()) r = await walkTo(session, ctl, spot.ground, { range: 0, timeoutMs: 9000, hazards: hz })
    if (!r.ok && Math.hypot(bot.entity.position.x - spot.ground.x, bot.entity.position.z - spot.ground.z) > 0.8) { perch.why = r.why; return }
    await stepTo(bot, ctl, spot.ground, { ms: 800, sprint: false, stopAt: 0.12, stop: nearHead, clouds: !through })
  }
  perch.reached = true
  doing(ctl, 'perch:melee')
  // Блок (или два) под себя — стоять над облаком огня.
  const blindNow = () => blindKnown(rec)
  for (let tries = 0; tries < 2 && !blindNow() && countOf(bot, FILLER_RE) >= spot.lift && Math.floor(bot.entity.position.y + 0.01) < spot.feet.y; tries++) {
    const t = await build.towerUp(bot, ctl, Math.max(1, spot.feet.y - Math.floor(bot.entity.position.y + 0.01)))
    perch.pedestal = (perch.pedestal || 0) + t.placed
  }
  // Подставка не встала: пока дракон дышит, облако ляжет прямо под ноги — стоять
  // рядом с головой можно только до огня.
  perch.low = Math.floor(bot.entity.position.y + 0.01) < spot.feet.y
  const weapon = items.bestWeapon(bot)
  if (weapon) await bot.equip(weapon, 'hand').catch(() => {})
  let nextReady = gameClock.now() + 100
  let lastSwing = 0
  let lastHp = hpOf(bot, d)
  const t0 = gameClock.now()
  while (!ctl.aborted && gameClock.now() - t0 < 30000) {
    await yieldTick()
    d = track.tick()
    if (!d) break
    const ph = phaseOf(bot, d)
    if (!SITTING.has(ph)) {
      // Взлёт от нашего удара (сидячий урон перевалил за 50 — он копится на все
      // посадки): мы у морды, на его пути. Сразу вбок от оси, с подставки вниз —
      // не ждать круга боя (c1-27, 30.09, 266 с: 20 → 9.4 за секунду).
      if (ph === PHASE.TAKEOFF) { perch.left = 'взлёт — вбок'; await takeoffSidestep(bot, ctl, d, 'взлёт от удара') }
      break
    }
    const rc = sitState(d, ph, gameClock.now())
    // Подставки нет (кончились блоки), а видящий ревёт или дышит — облако огня
    // ляжет под ноги у морды: уйти до следующего «высматривает» (d7-26, 30.09,
    // 569–573 с: у головы без подставки — пять ударов огнём и голова, смерть).
    if (perch.low && !blindNow() && (ph === PHASE.ROARING || ph === PHASE.FLAMING)) { perch.left = 'огонь, подставки нет'; if (rc) rc.noPedestal = gameClock.now(); break }
    // Видящий снова высматривает — голова пойдёт по дуге: отойти до рёва.
    if (ph === PHASE.SCANNING && rc && rc.roared) { perch.left = 'высматривает — отойти'; await stepTo(bot, ctl, awayFromHead(d, parts, bot.entity.position, 3), { ms: 900, stopAt: 0.4 }); break }
    // Четвёртый огонь или ≥ 44 за посадку — уходить от морды до взлёта.
    if (rc && (rc.flames >= 4 || (rc.dmg || 0) >= 44)) { perch.left = rc.flames >= 4 ? 'четвёртый огонь' : 'снято 44'; break }
    // Слепой взлетит на ~4.6 с — к 3.4 с нырнуть (или уйти, если не копается).
    if (rc && !rc.roared && gameClock.now() - rc.t0 > 3400) {
      clearControls(bot)
      const F = Math.floor(d.position.y - HOLE_TOP - 0.15)
      perch.ducked = duckPlan(bot, F) ? await duck(bot, ctl, F) : false
      if (perch.ducked) rc.ducked = true
      else rc.hitBack = gameClock.now()
      perch.left = perch.ducked ? 'нырнул до взлёта' : 'взлёт скоро, нырнуть нельзя'
      break
    }
    parts = partsOf(bot, d, track)
    const feet = bot.entity.position
    const eye = feet.offset(0, EYE, 0)
    // Облако уже под ногами или голова наехала — сойти.
    const ctx = { clouds: cloudsOf(bot), fireballs: fireballsOf(bot).filter(f => f.ticks < 30), parts, breath: null }
    const bad = dangerAt(bot, feet, ctx)
    if (bad) { perch.left = bad.kind; break }
    // Ударил сам дракон (голова, шея — наша оценка их коробок разошлась с
    // сервером) — сразу назад по оси морды и больше к этой посадке не лезть:
    // d4-20 (30.09, 527–529 с) — четыре удара по 5.5 за 1.5 с у головы, смерть.
    const hitAt = hitBy.get(d.id)
    if (hitAt && hitAt > t0) {
      perch.left = 'ударил дракон'
      if (rc) rc.hitBack = gameClock.now()
      clearControls(bot)
      await stepTo(bot, ctl, awayFromHead(d, parts, feet, 4), { ms: 1200, stopAt: 0.4 })
      break
    }
    const reach = boxDist(eye, parts.head)
    // Дракон довернул голову — раздутые голова и шея уже рядом: отступить
    // сразу, по оси морды назад, и выбрать место заново.
    const pbNow = playerBox(feet)
    if (overlap(pbNow, inflate(parts.head, 1.2)) || overlap(pbNow, inflate(parts.neck, 1.2))) {
      perch.backed = (perch.backed || 0) + 1
      clearControls(bot)
      const back = awayFromHead(d, parts, feet, 3)
      await stepTo(bot, ctl, back, { ms: 900, stopAt: 0.4 })
      if (perch.backed > 3) break
      continue
    }
    if (DEBUG && (!perch.dbgAt || gameClock.now() - perch.dbgAt > 1000)) {
      perch.dbgAt = gameClock.now()
      dbg('perch', 'phase', PHASE_RU[ph], 'head', parts.headC.toString(), 'me', feet.toString(), 'reach', reach.toFixed(2), 'hp', hpOf(bot, d), 'yaw', d.yaw.toFixed(2))
    }
    if (reach > 3.4) {
      // Дракон повернулся: переставиться.
      perch.moved = (perch.moved || 0) + 1
      if (perch.moved > 3) break
      const again = meleeSpot(bot, d, parts)
      if (!again) break
      // Голова ушла далеко (довернулся) — не бегать за ней вокруг дракона сквозь
      // его огонь: d10-26 (30.09, 490–498 с) — 15 блоков «переставиться» за
      // поворачивающейся головой, через облако огня, два удара головой, смерть.
      if (Math.hypot(again.ground.x - feet.x, again.ground.z - feet.z) > 3 || inClouds(cloudsOf(bot), again.ground, 1)) { perch.left = 'голова ушла далеко'; break }
      clearControls(bot)
      await stepTo(bot, ctl, again.ground, { ms: 2500, stopAt: 0.2, stop: () => (hitBy.get(d.id) || 0) > t0 })
      if (countOf(bot, FILLER_RE) > 0) await build.towerUp(bot, ctl, 1)
      continue
    }
    // Злой эндермен вплотную посреди посадки: ударить его в перезарядку головы,
    // не сходя с места (его 7 урона за удар против окна посадки).
    const pest = hunters(bot, 3.2)[0]
    if (pest && gameClock.now() >= nextReady) {
      await bot.lookAt(pest.position.offset(0, 1.5, 0), true).catch(() => {})
      bot.attack(pest)
      perch.pests = (perch.pests || 0) + 1
      nextReady = gameClock.now() + pvp.cooldownMs(bot.heldItem)
      await sleep(50)
      continue
    }
    await lookAtSafe(bot, parts.headC)
    // Крита по дракону НЕТ: Player.canCriticalAttack требует, чтобы цель была
    // LivingEntity, а часть дракона — EnderDragonPart (сверено по байткоду;
    // в игре «крит» в прыжке дал ровно 7, как без него). Прыгаем ради другого:
    // в воздухе нет размашистого удара мечом, который задел бы эндерменов у
    // головы и разозлил их. Бьём по перезарядке, как только оторвались от земли.
    const now = gameClock.now()
    const hp = hpOf(bot, d)
    if (hp != null && lastHp != null && hp < lastHp) {
      const lost = lastHp - hp
      perch.dmg += lost
      stats.dmg += lost
      if (sitRec && sitRec.id === d.id && !sitRec.ended) sitRec.dmg = (sitRec.dmg || 0) + lost
      lastHp = hp
    }
    if (now >= nextReady - 350 && bot.entity.onGround) bot.setControlState('jump', true)
    else bot.setControlState('jump', false)
    const airborne = !bot.entity.onGround
    if (now >= nextReady && (airborne || now >= nextReady + 300)) {
      // Столб под ноги (переставились) берёт в руку булыжник — и удар
      // булыжником по голове дракона это 1 урона вместо 7 (так прошла целая
      // посадка: 39 ударов по 1). Меч — перед каждым ударом.
      const w = items.bestWeapon(bot)
      if (w && (!bot.heldItem || bot.heldItem.name !== w.name)) {
        await bot.equip(w, 'hand').catch(() => {})
        nextReady = gameClock.now() + pvp.cooldownMs(w)
        await sleep(50)
        continue
      }
      if (reach <= 3.0) {
        bot.attack({ id: d.id + PART.head })
        perch.hits++
        stats.melee++
        nextReady = now + pvp.cooldownMs(bot.heldItem)
        // Урон головой или телом — по тому, на сколько упало здоровье.
        const before = hpOf(bot, d)
        gameClock.setTimeout(() => {
          const dd = dragonOf(bot)
          const after = dd ? hpOf(bot, dd) : null
          if (before != null && after != null) {
            const lost = before - after
            if (lost >= 4) perch.head++
            else if (lost > 0) perch.body++
            if (DEBUG) dbg('hit', 'lost', lost.toFixed(2), 'air', airborne, 'reach', reach.toFixed(2), 'held', bot.heldItem && bot.heldItem.name)
          }
        }, 250)
        lastSwing = now
      }
    }
    await sleep(50)
  }
  clearControls(bot)
  perch.hpAfter = d ? Math.round(hpOf(bot, d) ?? 0) : 0
}

// Выстрел по летящему: точка — тело (5×3, с крыльями по бокам) с упреждением
// по средней скорости. Сидящему стрелы не страшны (onHurt → 0), не тратим.
async function rangedShot (session, ctl, stats, track, d, hazardSoon) {
  const bot = session.bot
  if (countOf(bot, /arrow$/) < 1 || !findItem(bot, /^bow$/)) return false
  const eye = bot.entity.position.offset(0, EYE, 0)
  const dist = d.position.distanceTo(eye)
  if (dist > 48 || dist < 8) return false
  const v = track.vel()
  const parts = partsOf(bot, d, track)
  const toMe = { x: eye.x - d.position.x, z: eye.z - d.position.z }
  const len = Math.hypot(toMe.x, toMe.z) || 1
  // Голова, если летит на нас (она впереди тела), иначе тело.
  const headOn = (parts.dir.x * toMe.x + parts.dir.z * toMe.z) / len > 0.85
  const base = headOn ? parts.headC : parts.bodyC
  const off = base.minus(d.position)
  const point = (ticks) => {
    const tt = Math.min(ticks, 30)
    return new Vec3(d.position.x + off.x + v.x * tt, d.position.y + off.y + v.y * tt, d.position.z + off.z + v.z * tt)
  }
  const hp0 = hpOf(bot, d)
  const r = await bow.shoot(bot, d, { point, follow: false, mode: 'compensate', shouldStop: () => ctl.aborted || hazardSoon() || SITTING.has(phaseOf(bot, dragonOf(bot))) })
  if (!r.shot) return false
  stats.arrows++
  if (headOn) stats.headShots++
  // Попадание — по здоровью из метаданных, когда стрела долетит.
  gameClock.setTimeout(() => {
    const dd = dragonOf(bot)
    const hp = dd ? hpOf(bot, dd) : null
    if (hp0 != null && hp != null && hp < hp0) { stats.arrowHits++; stats.dmg += hp0 - hp }
  }, Math.min(2500, (r.flightTicks || 20) * 50 + 400))
  return true
}

// ------------------------------------------------------------ один цикл: физика дракона
//
// Полёт дракона по байткоду Paper 1.21.11 (EnderDragon.aiStep, ветка «есть цель
// полёта»), сверено с записью сервера по тикам (farm/dragon/rec-dragon.js,
// an-simcheck.js: посадка — ошибка 0.00 блока на 2–12 тиков вперёд). Состояние —
// как у сервера: позиция, скорость (deltaMovement), yRot в градусах сервера
// (голова — по (sin yRot, −cos yRot)) и yRotA — «скорость поворота», которой
// клиенту не шлют. Голова отстаёт от yRot на yRotA·0.01 рад (tickPart головы:
// sin(yRot·π/180 − yRotA·0.01)); сидя (и слепой, и видящий после поворота) yRotA
// ЗАМОРОЖЕН — голова сидящего в 1.3–2.9 блока вбок от «головы по yaw» (yRotA на
// посадке 20–45 по записи). Посадка — полёт к (0.5, P, 0.5) со скоростью 1.5 и
// поворотом 1 (DragonLandingPhase), садится, когда центр ближе блока, — клиент по
// двум пакетам (позиция, скорость, yaw) видит, где и в какой тик сядет и где будет
// голова, за 1.5 с и раньше (/c/tmp/landpred: медиана 0.1–0.2 блока).
const OC_ON = process.env.ND_BEDS_OC !== '0'
const MSIN = (() => { const t = new Float32Array(65536); for (let i = 0; i < 65536; i++) t[i] = Math.fround(Math.sin(i * Math.PI * 2 / 65536)); return t })()
const mIdx = v => { let n = Math.trunc(v) % 65536; if (n < 0) n += 65536; return n }
const msin = d => MSIN[mIdx(d * 10430.378350470453)]
const mcos = d => MSIN[mIdx(d * 10430.378350470453 + 16384)]
const DRAD = 0.017453292
const wrapDeg = f => { f %= 360; if (f >= 180) f -= 360; if (f < -180) f += 360; return f }
const clampN = (v, a, b) => v < a ? a : v > b ? b : v
function nrm3 (x, y, z) { const l = Math.sqrt(x * x + y * y + z * z); return l < 1e-4 ? [0, 0, 0] : [x / l, y / l, z / l] }
// Тик полёта к цели T: flySpeed и turn(s) — getFlySpeed/getTurnSpeed фазы.
function simStep (s, T, flySpeed, turn) {
  s.hist.unshift(s.y); if (s.hist.length > 12) s.hist.length = 12
  const dx = T.x - s.x; const dy = T.y - s.y; const dz = T.z - s.z
  const g = dx * dx + dy * dy + dz * dz
  const j = Math.sqrt(dx * dx + dz * dz)
  const e = j > 0 ? clampN(dy / j, -flySpeed, flySpeed) : dy
  s.vy += e * 0.01
  s.yRot = wrapDeg(s.yRot)
  const v32 = nrm3(dx, dy, dz)
  const v33 = nrm3(msin(s.yRot * DRAD), s.vy, -mcos(s.yRot * DRAD))
  const k = Math.max((v33[0] * v32[0] + v33[1] * v32[1] + v33[2] * v32[2] + 0.5) / 1.5, 0)
  if (Math.abs(dx) > 1e-5 || Math.abs(dz) > 1e-5) {
    const l = clampN(wrapDeg(180 - Math.atan2(dx, dz) * 57.295776 - s.yRot), -50, 50)
    s.yRotA = s.yRotA * 0.8 + l * turn(s)
    s.yRot += s.yRotA * 0.1
  }
  const l2 = 2 / (g + 1)
  const sp = 0.06 * (k * l2 + (1 - l2))
  s.vx += sp * msin(s.yRot * DRAD); s.vz += -sp * mcos(s.yRot * DRAD)
  const m = s.inWall ? 0.8 : 1
  s.x += s.vx * m; s.y += s.vy * m; s.z += s.vz * m
  const v34 = nrm3(s.vx, s.vy, s.vz)
  const n = 0.8 + 0.15 * (v34[0] * v33[0] + v34[1] * v33[1] + v34[2] * v33[2] + 1) / 2
  s.vx *= n; s.vy *= 0.91; s.vz *= n
  return s
}
const turnLanding = s => { const f = Math.hypot(s.vx, s.vz) + 1; return Math.min(f, 40) / f }
const simClone = s => ({ ...s, hist: s.hist.slice() })
// Низ-центр коробки головы (1×1×1) / шеи (3×3×3) после тика; sitting — сидячие фазы.
function simPart (s, len, sitting) {
  const h = s.hist
  const y0 = h[0] ?? s.y; const y5 = h[5] ?? y0; const y10 = h[10] ?? y5
  const f16 = (y5 - y10) * 10 * DRAD
  const f17 = mcos(f16); const f18 = msin(f16)
  const a = s.yRot * DRAD - s.yRotA * 0.01
  const off = sitting ? -1 : (y5 - y0)
  return new Vec3(s.x + msin(a) * len * f17, s.y + off + f18 * len, s.z - mcos(a) * len * f17)
}
const simHead = (s, sitting = false) => simPart(s, 6.5, sitting)
// Видящий высматривает (DragonSittingScanningPhase, 25 вызовов, Codex 01.10 по байткоду): тело
// поворачивается к игроку, пока угол между взглядом и направлением на игрока > ~9.5°:
// A = 0.8A + h·0.7/i/j, yaw += A (целиком), h — к игроку от прошлой головы (±100°), j = dist+1,
// i = min(j, 40). Игрок неподвижен — голова к концу предсказывается до сотых блока (по rec).
function scanPredict (sit, player, calls = 25) {
  const F = Math.fround
  const s = simClone(sit)
  s.hist = s.hist && s.hist.length >= 11 ? s.hist : new Array(12).fill(s.y)
  for (let t = 0; t < calls; t++) {
    const prior = simHead(s, true)
    s.yRot = F(wrapDeg(s.yRot))
    const dx = player.x - s.x; const dz = player.z - s.z
    const dl = Math.hypot(dx, dz) || 1e-6
    const a = F(F(s.yRot) * F(Math.PI / 180))
    const sx = msin(a); const sz = -mcos(a)
    const dot = Math.max(-1, Math.min(1, F((sx * dx + sz * dz) / Math.hypot(sx, sz) / dl)))
    const g = F(F(Math.acos(dot) * 180 / Math.PI) + 0.5)
    if (g < 0 || g > 10) {
      const hx = player.x - prior.x; const hz = player.z - prior.z
      const err = Math.max(-100, Math.min(100, wrapDeg(180 - Math.atan2(hx, hz) * 180 / Math.PI - s.yRot)))
      const j = F(F(Math.hypot(hx, hz)) + 1)
      const i = Math.min(j, 40)
      s.yRotA = F(F(s.yRotA * F(0.8)) + F(F(err) * F(F(F(0.7) / i) / j)))
      s.yRot = F(s.yRot + s.yRotA)
    }
  }
  return { s, head: simHead(s, true), neck: simNeck(s, true) }
}
const simNeck = (s, sitting = false) => simPart(s, 5.5, sitting)
// Сервер → mineflayer: yaw = π − yRot (рад). Голова по (sin(yaw + yRotA·0.01), cos(…)).
const yRotOf = yaw => wrapDeg(180 - yaw * 180 / Math.PI)

// LpVec3 (1.21.9+) из сырого буфера с позиции off (см. spawnVelocityRaw).
function lpVec3At (buf, off) {
  const a = buf[off]
  if (a === 0) return { x: 0, y: 0, z: 0 }
  const packed = buf.readUInt32BE(off + 2) * 65536 + buf[off + 1] * 256 + a
  let scale = a & 3
  if ((a & 4) === 4) { const [c] = readVarIntAt(buf, off + 6); scale += c * 4 }
  const un = sh => Math.min(Math.floor(packed / 2 ** sh) % 32768, 32766) * 2 / 32766 - 1
  return { x: un(3) * scale, y: un(18) * scale, z: un(33) * scale }
}
// Пакеты дракона (раз в 3 тика): позиция и yaw (entityMoved — mineflayer шлёт его
// дважды на пакет), скорость (сырой entity_velocity: mineflayer читает LpVec3
// не тем порядком байт), фаза. list — последние 40.
// Последний удар дракона (голова/шея/крыло — mob_attack от ender_dragon): стройка у сидящего
// бросается сразу (fin5-19: три удара по 4 на «ts:stand» у шеи — смерть).
let lastDragonHit = 0
function makeDragonFeed (bot) {
  const onHit = pk => {
    if (!pk || !bot.entity || pk.entityId !== bot.entity.id) return
    const src = bot.entities[pk.sourceCauseId - 1]
    if (DAMAGE_TYPES[pk.sourceTypeId] === 'mob_attack' && src && src.name === 'ender_dragon') lastDragonHit = gameClock.now()
  }
  bot._client.on('damage_event', onHit)
  const list = []
  let vel = null
  // Снижение — прогноз посадки (по двум последним пакетам со скоростью).
  const refresh = id => {
    const r = list[list.length - 1]
    if (!r || r.id !== id || r.ph !== PHASE.LANDING || r.vx == null) return
    try { const f = landingForecast(feed, podiumTop(bot)); if (f) feed.fc = { ...f, id } } catch (err) { dbg('forecast', err.message) }
  }
  const onVel = buf => {
    try {
      let off = 0; let id
      ;[, off] = readVarIntAt(buf, off)
      ;[id, off] = readVarIntAt(buf, off)
      const e = bot.entities[id]
      if (!e || e.name !== 'ender_dragon') return
      vel = { t: gameClock.now(), id, ...lpVec3At(buf, off) }
      const last = list[list.length - 1]
      if (last && last.id === id && vel.t - last.t < 25 && last.vx == null) { last.vx = vel.x; last.vy = vel.y; last.vz = vel.z; refresh(id) }
    } catch {}
  }
  const onMoved = e => {
    if (!e || e.name !== 'ender_dragon') return
    const t = gameClock.now()
    const last = list[list.length - 1]
    const p = e.position
    if (last && last.id === e.id && t - last.t < 25 && Math.abs(last.x - p.x) < 1e-6 && Math.abs(last.z - p.z) < 1e-6 && Math.abs(last.y - p.y) < 1e-6) { last.yRot = yRotOf(e.yaw); return }
    const r = { t, wallMs: gameClock.wall.now(), id: e.id, x: p.x, y: p.y, z: p.z, yRot: yRotOf(e.yaw), ph: phaseOf(bot, e), vx: null, vy: null, vz: null }
    if (vel && vel.id === e.id && t - vel.t < 25) { r.vx = vel.x; r.vy = vel.y; r.vz = vel.z }
    list.push(r)
    if (list.length > 40) list.shift()
    refresh(e.id)
  }
  // Сел (метаданные фазы; сидящий не двигается — пакетов движения нет): угол головы
  // по последнему прогнозу — yRotA заморожен.
  const onUpd = e => {
    if (!e || e.name !== 'ender_dragon') return
    const ph = phaseOf(bot, e)
    const last = list[list.length - 1]
    if (last && last.id === e.id && gameClock.now() - last.t < 25) last.ph = ph
    const f = feed.fc
    if (!SITTING.has(ph) || !f || f.id !== e.id || gameClock.now() - f.t > 700 || feed.fixed === f.t) return
    feed.fixed = f.t
    sitFix.set(e.id, { yRotA: f.yRotA, yaw: e.yaw, t: gameClock.now(), head: f.head, sit: simClone(f.sit), pos: e.position.clone(), pushes: [], me: bot.entity && bot.entity.position.clone() })
    if (feed.onSit) feed.onSit({ pred: [r3(f.sit.x), r3(f.sit.y), r3(f.sit.z), r1(f.sit.yRot)], act: [r3(e.position.x), r3(e.position.y), r3(e.position.z), r1(yRotOf(e.yaw))], yRotA: r1(f.yRotA), n: f.n, late: gameClock.now() - f.t, head: [r1(f.head.x), r1(f.head.y), r1(f.head.z)] })
  }
  const feed = { list, fc: null, fixed: null, onSit: null, close () { bot._client.removeListener('raw.entity_velocity', onVel); bot.removeListener('entityMoved', onMoved); bot.removeListener('entityUpdate', onUpd); bot._client.removeListener('damage_event', onHit) } }
  bot._client.on('raw.entity_velocity', onVel)
  bot.on('entityMoved', onMoved)
  bot.on('entityUpdate', onUpd)
  return feed
}
// Прогноз посадки по двум последним пакетам LANDING: yRotA пакета a подбираем так,
// чтобы за n тиков пришли к yaw пакета b; дальше от b — тик за тиком до «сел».
// { t (приход b), n (тиков от b до тика посадки), sit (состояние сидящего),
//   head (низ-центр головы сидящего), path: [{k, head, y}] — голова в полёте после тика b+k }.
function landingForecast (feed, P) {
  const L = feed.list
  const b = L[L.length - 1]; const a = L[L.length - 2]
  if (!a || !b || a.id !== b.id || b.ph !== PHASE.LANDING || a.ph !== PHASE.LANDING) return null
  if (a.vx == null || b.vx == null || P == null) return null
  const n = Math.round((b.t - a.t) / 50)
  if (n < 1 || n > 6) return null
  const T = { x: 0.5, y: P, z: 0.5 }
  const from = q => ({ x: a.x, y: a.y, z: a.z, vx: a.vx, vy: a.vy, vz: a.vz, yRot: a.yRot, yRotA: q, hist: new Array(11).fill(a.y), inWall: false })
  const fit = q => { const s = from(q); for (let k = 0; k < n; k++) simStep(s, T, 1.5, turnLanding); return { s, e: Math.abs(wrapDeg(s.yRot - b.yRot)) } }
  let best = null
  for (let q = -300; q <= 300; q += 3) { const r = fit(q); if (!best || r.e < best.e) best = { ...r, q } }
  for (let q = best.q - 3; q <= best.q + 3; q += 0.1) { const r = fit(q); if (r.e < best.e) best = { ...r, q } }
  const s = { x: b.x, y: b.y, z: b.z, vx: b.vx, vy: b.vy, vz: b.vz, yRot: b.yRot, yRotA: best.s.yRotA, hist: best.s.hist.slice(), inWall: false }
  const path = []
  for (let k = 1; k <= 400; k++) {
    const dx = s.x - T.x; const dy = s.y - T.y; const dz = s.z - T.z
    if (dx * dx + dy * dy + dz * dz < 1) {
      const sit = simClone(s)
      return { t: b.t, wallMs: b.wallMs, n: k - 1 + 1, fitErr: best.e, sit, head: simHead(sit, true), neck: simNeck(sit, true), path, yRotA: s.yRotA }
    }
    simStep(s, T, 1.5, turnLanding)
    path.push({ k, head: simHead(s, false), neck: simNeck(s, false), pos: new Vec3(s.x, s.y, s.z), yRot: s.yRot, st: simClone(s) })
  }
  return null
}
// Прогноз посадки после толчка взрыва на тике path[i0] (кровать L0: щелчок обработан после
// тика g + i0 + 1 — толчок к скорости после него; ServerExplosion: к глазам дракона, (1 − d/10)·видимость).
// oc8-26: L0 без этого — «прогноз ушёл на 12.4»: толчок ~0.3 блока/тик меняет всю посадку.
function pushedForecast (fc, i0, centre, seen, P) {
  const base = fc.path[i0]
  if (!base || !base.st) return null
  const s = simClone(base.st)
  const push = blastPush(s, centre, seen)
  s.vx += push.x; s.vy += push.y; s.vz += push.z
  const T = { x: 0.5, y: P, z: 0.5 }
  const path = fc.path.slice(0, i0 + 1)
  for (let k = i0 + 2; k <= i0 + 400; k++) {
    const dx = s.x - T.x; const dy = s.y - T.y; const dz = s.z - T.z
    if (dx * dx + dy * dy + dz * dz < 1) {
      const sit = simClone(s)
      return { t: fc.t, wallMs: fc.wallMs, n: k, fitErr: fc.fitErr, sit, head: simHead(sit, true), neck: simNeck(sit, true), path, yRotA: s.yRotA, pushed: push }
    }
    simStep(s, T, 1.5, turnLanding)
    path.push({ k, head: simHead(s, false), neck: simNeck(s, false), pos: new Vec3(s.x, s.y, s.z), yRot: s.yRot, st: simClone(s) })
  }
  return null
}
// Замороженное состояние сидящего: id дракона → { yRotA, head, neck, pos, yRot, t } —
// из последнего прогноза посадки; partsOf берёт отсюда угол головы.
const sitFix = new Map()

// Узлы пути дракона (EnderDragon.findClosestNode, первая инициализация) и A*
// (findPath) — для прогноза взлёта: DragonTakeoffPhase берёт узел №1 пути от
// ближайшего к себе узла к узлу «по голове» (j = ближайший к −look·40 по модулю 12,
// пока кристаллы живы). y узла — max(73, высота колонки + 5/15). Сверено с записью
// сервера: взлёт после кровати — точно (ошибка 0.0001) с толчком взрыва.
const NODE_ADJ = [6146, 8197, 8202, 16404, 32808, 32848, 65696, 131392, 131712, 263424, 526848, 525313, 1581057, 3166214, 2138120, 6373424, 4358208, 12910976, 9044480, 9706496, 15216640, 13688832, 11763712, 8257536]
let nodesCache = null
function dragonNodes (bot) {
  if (nodesCache && nodesCache.dim === bot.game.dimension && gameClock.now() - nodesCache.t < 600000) return nodesCache.nodes
  const h = (x, z) => { const s = surfaceY(bot, x + 0.5, z + 0.5, 200); return s ? s.y : null }
  const out = []
  for (let i = 0; i < 24; i++) {
    let k; let l; let j = 5
    // Угол — во float, как в Java (узлы 6/16/22: sin(−π) во float даёт z = 0, в double — −1; Codex, 01.10).
    const F = Math.fround
    const ang = (step, m) => F(F(2) * F(F(-3.1415927) + F(F(step) * F(m))))
    if (i < 12) { const a = ang(0.2617994, i); k = Math.floor(F(60 * mcos(a))); l = Math.floor(F(60 * msin(a))) } else if (i < 20) { const m = i - 12; const a = ang(0.3926991, m); k = Math.floor(F(40 * mcos(a))); l = Math.floor(F(40 * msin(a))); j += 10 } else { const m = i - 20; const a = ang(0.7853982, m); k = Math.floor(F(20 * mcos(a))); l = Math.floor(F(20 * msin(a))) }
    // Колонка не прогружена (кольцо 60 — за дальностью прорисовки): высота острова там ~60–64.
    let hy = h(k, l)
    if (hy == null) hy = i < 12 ? 0 : 62
    out.push({ i, x: k, y: Math.max(73, hy + j), z: l })
  }
  nodesCache = { nodes: out, t: gameClock.now(), dim: bot.game.dimension }
  return out
}
const nd2 = (a, b) => { const x = a.x - b.x; const y = a.y - b.y; const z = a.z - b.z; return Math.fround(x * x + y * y + z * z) }
const ndist = (a, b) => Math.fround(Math.sqrt(nd2(a, b)))
function closestNode (nodes, x, y, z, crystals = 10) {
  const p = { x: Math.floor(x), y: Math.floor(y), z: Math.floor(z) }
  let f = 10000; let best = 0
  for (let k = crystals === 0 ? 12 : 0; k < 24; k++) { const g = nd2(nodes[k], p); if (g < f) { f = g; best = k } }
  return best
}
function findNodePath (nodes, start, end, crystals = 10) {
  const N = nodes.map(n => ({ ...n, closed: false, f: 0, g: 0, h: 0, from: null, heap: -1 }))
  const heap = []
  const up = i => { const n = heap[i]; const f = n.f; while (i > 0) { const p = (i - 1) >> 1; const q = heap[p]; if (!(f < q.f)) break; heap[i] = q; q.heap = i; i = p } heap[i] = n; n.heap = i }
  const down = i => {
    const n = heap[i]; const f = n.f
    for (;;) {
      const a = 1 + (i << 1); const b = a + 1
      if (a >= heap.length) break
      const na = heap[a]; const fa = na.f
      let nb = null; let fb = Infinity
      if (b < heap.length) { nb = heap[b]; fb = nb.f }
      if (fa < fb) { if (!(fa < f)) break; heap[i] = na; na.heap = i; i = a } else { if (!(fb < f)) break; heap[i] = nb; nb.heap = i; i = b }
    }
    heap[i] = n; n.heap = i
  }
  const insert = n => { heap.push(n); n.heap = heap.length - 1; up(n.heap) }
  const pop = () => { const n = heap[0]; const last = heap.pop(); if (heap.length) { heap[0] = last; last.heap = 0; down(0) } n.heap = -1; return n }
  const change = (n, f) => { const o = n.f; n.f = f; if (f < o) up(n.heap); else down(n.heap) }
  const recon = e => { const out = [e]; while (e.from) { e = e.from; out.unshift(e) } return out.map(q => q.i) }
  const s = N[start]; const t = N[end]
  s.g = 0; s.h = ndist(s, t); s.f = s.h
  insert(s)
  let best = s
  const from = crystals === 0 ? 12 : 0
  while (heap.length) {
    const n = pop()
    if (n.i === t.i) return recon(t)
    if (ndist(n, t) < ndist(best, t)) best = n
    n.closed = true
    for (let k = from; k < 24; k++) {
      if (!((NODE_ADJ[n.i] & (1 << k)) > 0)) continue
      const m = N[k]
      if (m.closed) continue
      const g = Math.fround(n.g + ndist(n, m))
      if (m.heap >= 0 && !(g < m.g)) continue
      m.from = n; m.g = g; m.h = ndist(m, t)
      if (m.heap >= 0) change(m, Math.fround(m.g + m.h))
      else { m.f = Math.fround(m.g + m.h); insert(m) }
    }
  }
  return best === s ? null : recon(best)
}
// Куда полетит на взлёте: узел №1 пути (DragonTakeoffPhase.navigateToNextPathNode: advance, next, advance).
function takeoffNode (nodes, s, crystals = 10, P = null) {
  const i = closestNode(nodes, s.x, s.y, s.z, crystals)
  // getHeadLookVector: у фонтана (тело ближе 4 к центру) наклон −45° — по XZ радиус 40·cos(45°)
  // ≈ 28.28, а не 40 (EnderDragon.getHeadLookVector, Codex 01.10).
  const dist = P != null ? Math.hypot(s.x - 0.5, s.y - P, s.z - 0.5) : 0
  const pitch = -45 / Math.max(dist / 4, 1) * DRAD
  const cp = Math.cos(pitch)
  const hx = msin(s.yRot * DRAD) * cp; const hz = -mcos(s.yRot * DRAD) * cp
  let j = closestNode(nodes, hx * 40, 105, hz * 40, crystals)
  if (crystals > 0) { j %= 12; if (j < 0) j += 12 } else { j -= 12; j &= 7; j += 12 }
  const path = findNodePath(nodes, i, j, crystals)
  if (!path || path.length < 2) return null
  return nodes[path[1]]
}
// Толчок взрыва по дракону (ServerExplosion.hurtEntities): от центра к глазам (Y + 6.8),
// сила (1 − d/10)·видимость, d — от центра до низа-центра дракона.
function blastPush (s, centre, seen = 1) {
  const d = Math.hypot(s.x - centre.x, s.y - centre.y, s.z - centre.z) / 10
  if (d > 1) return { x: 0, y: 0, z: 0 }
  const ex = s.x - centre.x; const ey = s.y + 6.8 - centre.y; const ez = s.z - centre.z
  const l = Math.hypot(ex, ey, ez) || 1
  const m = (1 - d) * seen
  return { x: ex / l * m, y: ey / l * m, z: ez / l * m }
}
// Прогноз взлёта из сидячего состояния sit (после толчков): голова по тикам взлёта.
// Цель — узел (y цели = y узла + случайное 0…20; берём +10: влияет только на подъём).
function takeoffForecast (sit, node, ticks = 30) {
  const s = simClone(sit)
  const T = { x: node.x, y: node.y + 10, z: node.z }
  const turn = st => { const f = Math.hypot(st.vx, st.vz) + 1; return 0.7 / Math.min(f, 40) / f }
  const path = []
  for (let k = 0; k < ticks; k++) {
    simStep(s, T, 0.6, turn)
    path.push({ k, head: simHead(s, false), neck: simNeck(s, false), pos: new Vec3(s.x, s.y, s.z), yRot: s.yRot })
  }
  return path
}
// Сидячие части по прогнозу посадки — для bedsLayout.
function predParts (fc) {
  const s = fc.sit
  const pos = new Vec3(s.x, s.y, s.z)
  const h = fc.head; const n = fc.neck
  const head = box(h.x, h.y, h.z, 0.5, 1)
  const neck = box(n.x, n.y, n.z, 1.5, 3)
  const body = box(s.x + msin(s.yRot * DRAD) * 0.5, s.y, s.z - mcos(s.yRot * DRAD) * 0.5, 2.5, 3)
  const dx = h.x - s.x; const dz = h.z - s.z; const l = Math.hypot(dx, dz) || 1
  const center = b => b.min.plus(b.max).scaled(0.5)
  return { sit: true, dir: { x: dx / l, z: dz / l }, pos, head, neck, body, headC: center(head), bodyC: center(body) }
}
// Бьёт ли снижающийся (по прогнозу, до посадки) тело в feet: голова и шея (+1) и
// крылья (knockBack, пока не сидит: [c ± 6] × [Y − 2, Y + 4], 5 урона и отброс).
function landingHits (fc, feet, pad = 0.4) {
  const pb = playerBox(feet)
  const grow = (b, h, v) => ({ min: b.min.offset(-h, -v, -h), max: b.max.offset(h, v, h) })
  for (const st of fc.path) {
    if (overlap(pb, grow(box(st.head.x, st.head.y, st.head.z, 0.5, 1), 1 + pad, 1 + pad))) return { k: st.k, what: 'голова' }
    if (overlap(pb, grow(box(st.neck.x, st.neck.y, st.neck.z, 1.5, 3), 1 + pad, 1 + pad))) return { k: st.k, what: 'шея' }
    const cx = Math.cos(st.yRot * DRAD) * 4.5; const cz = Math.sin(st.yRot * DRAD) * 4.5
    for (const sg of [1, -1]) {
      const wx = st.pos.x + cx * sg; const wz = st.pos.z + cz * sg
      const wb = { min: new Vec3(wx - 6 - pad, st.pos.y - 2, wz - 6 - pad), max: new Vec3(wx + 6 + pad, st.pos.y + 4, wz + 6 + pad) }
      if (overlap(pb, wb)) return { k: st.k, what: 'крыло' }
    }
  }
  return null
}
// Кровать на снижении (L): сядет он — голова встанет в fc.head; за тик до посадки
// голова над тем же местом, на блок выше (в полёте смещение головы — y5 − y0, а
// не −1). Урон на снижении в сидячий счёт не идёт (EnderDragon.hurt: только
// isSitting). Станцию (кровать у места головы сидящего, заслон) строим, пока
// снижается, если место не под его коробками по всему пути до посадки; щёлкаем в
// тик до посадки: пакет b (состояние после тика g) — щелчок, обработанный после
// тика g + n − 1, бьёт по частям последнего тика снижения.
const FACE_IDX = (f) => f.y < 0 ? 0 : f.y > 0 ? 1 : f.z < 0 ? 2 : f.z > 0 ? 3 : f.x < 0 ? 4 : 5
async function ocLanding (session, ctl, rep, stats, track, feed, { blindLid = false } = {}) {
  const bot = session.bot
  const P = podiumTop(bot)
  const fc = landingForecast(feed, P)
  if (!fc || fc.n < 40 || fc.n > 190) { if (ctl.trace) ctl.trace.ev('ocL', { why: fc ? `n ${fc.n}` : 'нет прогноза', blindLid: blindLid || undefined }); return false }
  // Режим «видящий» (ND_SEE=1): на первой посадке L нет — окоп спрятал бы нас от первого
  // «высматривает», и дракон остался бы слепым навсегда (Sensing не чистится).
  if (process.env.ND_SEE === '1' && !blindLid) {
    const dd0 = dragonOf(bot)
    if (dd0 && !sight.get(dd0.id + ':' + bot.entity.id)) { if (ctl.trace) ctl.trace.ev('ocL', { why: 'видящий: первая посадка без L', n: fc.n }); return false }
  }
  const anchorsOk = process.env.ND_OC_ANCHOR !== '0' && !blindLid && countOf(bot, /^respawn_anchor$/) >= 1 && countOf(bot, /^glowstone$/) >= 1
  if ((countOf(bot, /_bed$/) < 2 && !anchorsOk) || countOf(bot, FILLER_RE) < 3) return false
  const d = dragonOf(bot)
  if (!d) return false
  const ev = (k, o) => { if (ctl.trace) ctl.trace.ev(k, o) }
  stats.oc = stats.oc || { tries: 0, built: 0, booms: 0, why: {} }
  const no = w => { stats.oc.why[w] = (stats.oc.why[w] || 0) + 1; ev('ocL', { why: w, n: fc.n }); return false }
  stats.oc.tries++
  const tPlan0 = gameClock.now()
  const tgt = (fc.path[fc.n - 3] || fc.path[fc.path.length - 1]).head
  let plan = null
  const whyAll = {}
  const cands = []
  // Кровать на блок или два выше земли (на два — центр взрыва у самой головы; кровать не
  // должна попасть в коробки головы/шеи на пути снижения — проверка в tsPlan: oc3-22).
  for (const lift of [2, 1]) {
    if (countOf(bot, /_bed$/) < 1) break
    const p2 = tsPlan(bot, tgt, { lift, fc, dpos: new Vec3(fc.sit.x, fc.sit.y, fc.sit.z), lid: blindLid })
    for (const [k, v] of Object.entries(tsPlan.why || {})) whyAll[k] = (whyAll[k] || 0) + v
    cands.push(...(tsPlan.all || []))
    if (p2 && (!plan || p2.cost < plan.cost)) plan = p2
  }
  // Якорь возрождения (есть в рюкзаке): прямо на путь головы — взрыв ближе (до ~0.5 от низа головы).
  if (anchorsOk) {
    let pa = null
    for (const lift of [3, 2, 1]) {
      const p3 = tsPlan(bot, tgt, { lift, fc, dpos: new Vec3(fc.sit.x, fc.sit.y, fc.sit.z), anchor: true })
      for (const [k, v] of Object.entries(tsPlan.why || {})) whyAll['я:' + k] = (whyAll['я:' + k] || 0) + v
      if (p3 && (!pa || p3.cost < pa.cost)) pa = p3
    }
    if (pa && (!plan || pa.expect > plan.expect + 3)) plan = pa
  }
  tsPlan.why = whyAll
  if (!plan) { ev('ocNoPlan', { no: tsPlan.why }); return no('нет станции у головы') }
  // Вторая кровать снижения (L0) с другой стороны того же окопа — за ≥ 10 тиков до L.
  // Пара L0 + L: окоп общий; L0 — на голову снижающегося (тик i0 ≤ n − 13) с любой стороны,
  // кроме стороны L; L — на голову ПОСЛЕ толчка взрыва L0 (прогноз с толчком: oc8-26 — без
  // него посадка ушла на 12 блоков). Кровать L переживает взрыв L0 (лучи). Выигрыш — сумма.
  let refHead = fc.head
  if (process.env.ND_OC_L0 === '1' && !blindLid && fc.n >= 60) {
    const dpos = new Vec3(fc.sit.x, fc.sit.y, fc.sit.z)
    const P = podiumTop(bot)
    const seenKeys = new Set()
    const top = cands.sort((p, q) => p.cost - q.cost).filter(c => { const k = `${c.B.x},${c.B.z}`; if (seenKeys.has(k)) return false; seenKeys.add(k); return true }).slice(0, 3)
    let bestPair = null; const why0 = {}
    const note = k => { why0[k] = (why0[k] || 0) + 1 }
    for (const c of top) {
      const sides = DIRS4.filter(d2 => !(d2.x === c.u.x && d2.z === c.u.z))
      const s2 = tsSecond(bot, c, fc, { dpos, sides })
      for (const [k, v] of Object.entries(tsSecond.why || {})) why0[k] = (why0[k] || 0) + v
      if (!s2) continue
      const fc2 = pushedForecast(fc, s2.i0, s2.centre, s2.seen || 1, P)
      if (!fc2) { note('толчок: нет посадки'); continue }
      if ((fc2.n - 2) - (s2.i0 + 1) < 10) { note('толчок: L раньше 10 тиков'); continue }
      const tgt2 = (fc2.path[fc2.n - 3] || fc2.path[fc2.path.length - 1]).head
      const avoid = new Set([s2.F, s2.W, s2.V, s2.PS, s2.H].map(q => `${q.x},${q.z}`))
      const extra = new Map()
      for (const y of s2.sCells) extra.set(`${s2.F.x},${y},${s2.F.z}`, 'block')
      for (const y of s2.wCells) extra.set(`${s2.W.x},${y},${s2.W.z}`, 'block')
      let L2 = null
      for (const lift of [2, 1]) {
        const q = tsPlan(bot, tgt2, { lift, fc: fc2, dpos: new Vec3(fc2.sit.x, fc2.sit.y, fc2.sit.z), fixedB: c.B, avoid, extra })
        if (q && (!L2 || q.cost < L2.cost)) L2 = q
      }
      if (!L2) { note('L после толчка: нет станции у того же окопа'); continue }
      // L переживает взрыв L0; бок L0 виден из окопа в мире со станцией L2
      const exW = new Map(L2.world); exW.set(`${L2.F.x},${L2.yb},${L2.F.z}`, 'bed'); exW.set(`${L2.H.x},${L2.yb},${L2.H.z}`, 'bed')
      if (blastReaches(virtualBot(bot, exW), bot, s2.centre, [{ x: L2.F.x, y: L2.yb, z: L2.F.z }, { x: L2.H.x, y: L2.yb, z: L2.H.z }])) { note('L0 снесёт кровать L'); continue }
      const ex0 = new Map(exW); ex0.set(`${s2.F.x},${s2.yb},${s2.F.z}`, 'bed'); ex0.set(`${s2.H.x},${s2.yb},${s2.H.z}`, 'bed')
      if (!tsClickPoint(virtualBot(bot, ex0), L2.trench.offset(0, EYE, 0), s2)) { note('бок L0 закрыт станцией L'); continue }
      if (exposure(virtualBot(bot, L2.world), L2.trench, s2.centre) > 0.02) { note('взрыв L0 видит окоп'); continue }
      const sum = s2.expect + L2.expect
      if (!bestPair || sum > bestPair.sum) bestPair = { L2, s2, fc2, sum }
    }
    ev('ocPlan0', bestPair ? { i0: bestPair.s2.i0, n: fc.n, n2: bestPair.fc2.n, H0: [bestPair.s2.H.x, bestPair.s2.yb, bestPair.s2.H.z], L0: bestPair.s2.expect, H: [bestPair.L2.H.x, bestPair.L2.yb, bestPair.L2.H.z], L: bestPair.L2.expect, alone: plan.expect, push: [r1(bestPair.fc2.pushed.x * 100) / 100, r1(bestPair.fc2.pushed.y * 100) / 100, r1(bestPair.fc2.pushed.z * 100) / 100] } : { no: why0, tried: top.length })
    if (bestPair && bestPair.sum > plan.expect + 25) {
      plan = bestPair.L2; plan.second = bestPair.s2; plan.gapTicks = (bestPair.fc2.n - 2) - (bestPair.s2.i0 + 1); plan.nPlan = fc.n
      refHead = bestPair.fc2.head
    }
  }
  // Взлёт слепого (сам, на 99-м тике после посадки — без толчка B): голова первые ~15 тиков
  // низко (G + 3), путь — физика из сидячего состояния (скорость посадки + толчки L и A,
  // узел пути — граф узлов). Две кровати вне сидячего счёта: T1 — станция L заново (голова на
  // 1-м тике взлёта рядом с местом L), T2 — вторая станция у того же окопа на голову через
  // 10+ тиков. Цикл: L + A (≤ 46) + T1 + T2 вместо L + A + B.
  // fin3: план не сложился ни разу — T1: станция L у шеи сидящего (заново её не поставить),
  // T2: голова взлёта на 11–18-м тике не проходит над клетками в досягаемости окопа (24 из 24).
  // Только по ND_OC_TK=1.
  let tk = null
  if (process.env.ND_OC_TK === '1' && !blindLid && sight.get(d.id + ':' + bot.entity.id) === 'blind') {
    const why1 = {}
    const n1 = k => { why1[k] = (why1[k] || 0) + 1 }
    const fcL = pushedForecast(fc, fc.n - 3, plan.centre, plan.seen || 1, P)
    if (!fcL) n1('посадка после L не считается')
    else if (hurtNear(playerBox(plan.ground), predParts(fcL)) || hurtNear(playerBox(new Vec3(plan.B.x + 0.5, plan.G, plan.B.z + 0.5)), predParts(fcL))) n1('станция L у шеи сидящего (T1 заново не поставить)')
    else {
      const A = bedsLayout(bot, d, predParts(fcL), { headAt: fcL.head, noTurn: true, brave: true, cap: 46 })
      const S = simClone(fcL.sit)
      if (A) { const pu = blastPush(S, A.centre, A.seen != null ? A.seen : 1); S.vx += pu.x; S.vy += pu.y; S.vz += pu.z }
      S.hist = new Array(12).fill(S.y)
      const nodes = dragonNodes(bot)
      const node = nodes && takeoffNode(nodes, S)
      if (!node) n1('узел взлёта не найден')
      else {
        const path = takeoffForecast(S, node, 30)
        const t1 = path[1]
        const t1exp = bedDamage(t1.head.distanceTo(plan.centre), plan.seen || 1)
        const sides = DIRS4.filter(q => !(q.x === plan.u.x && q.z === plan.u.z))
        const T2 = tsSecond(bot, plan, { n: 99, path }, { dpos: new Vec3(S.x, S.y, S.z), sides, imin: 11, imax: 18, primaryFirst: true })
        if (!T2) Object.assign(why1, tsSecond.why || {})
        else {
          // Клетки станции T2 (кровать, опора, заслон) не на пути снижения (checkWalls снесёт) и
          // переживут взрыв A (A — сидя, до T1/T2).
          const cells = [{ x: T2.F.x, y: T2.yb, z: T2.F.z }, { x: T2.H.x, y: T2.yb, z: T2.H.z }, ...T2.sCells.map(y => ({ x: T2.F.x, y, z: T2.F.z })), ...T2.wCells.map(y => ({ x: T2.W.x, y, z: T2.W.z }))]
          let onPath = false
          for (const st of fc.path) {
            const boxes = [inflate(box(st.head.x, st.head.y, st.head.z, 0.5, 1), 0.2), inflate(box(st.neck.x, st.neck.y, st.neck.z, 1.5, 3), 0.2), inflate(box(st.pos.x + Math.sin(st.yRot * DRAD) * 0.5, st.pos.y, st.pos.z - Math.cos(st.yRot * DRAD) * 0.5, 2.5, 3), 0.2)]
            if (cells.some(c => boxes.some(b => overlap(b, { min: new Vec3(c.x, c.y, c.z), max: new Vec3(c.x + 1, c.y + 1, c.z + 1) })))) { onPath = true; break }
          }
          const ex = new Map(plan.world)
          for (const y of T2.sCells) ex.set(`${T2.F.x},${y},${T2.F.z}`, 'block')
          for (const y of T2.wCells) ex.set(`${T2.W.x},${y},${T2.W.z}`, 'block')
          ex.set(`${T2.F.x},${T2.yb},${T2.F.z}`, 'bed'); ex.set(`${T2.H.x},${T2.yb},${T2.H.z}`, 'bed')
          if (onPath) n1('станция T2 на пути снижения')
          else if (A && blastReaches(virtualBot(bot, ex), bot, A.centre, cells)) n1('взрыв A заденет станцию T2')
          else tk = { A, T2, path, node, t1exp, sum: t1exp + T2.expect, S }
        }
      }
    }
    ev('ocTk', tk ? { node: [tk.node.x, tk.node.z], A: tk.A ? tk.A.expect : null, T1: tk.t1exp, T2: tk.T2.expect, i2: tk.T2.i0, H2: [tk.T2.H.x, tk.T2.yb, tk.T2.H.z] } : { no: why1 })
    if (tk && tk.sum < 70) tk = null
    if (tk) { plan.second = tk.T2 }
  }  // Кровать A заранее в СВОЁМ окопе у головы сидящего (слепой: голова сидящего не поворачивается):
  // после L — к окопу A, щелчок через ≥ 10 тиков после L, в сидячий счёт (≤ cap). Темп спидраннеров:
  // кровати стоят до посадки, в нужный миг — только щелчок.
  // fin4 (01.10): с настоящей стойкостью кровати (0.2) взрыв L сносит A почти всегда (офлайн по
  // 16 посадкам — 1 из 16; в мирах fin4 — ни одной), а перебор шёл 1–3.5 с. Только по ND_OC_A=1.
  let fcA = null
  let ownA = null
  let ownB = null
  if (process.env.ND_OC_A === '1' && !blindLid && !plan.second && fc.n >= 120 && sight.get(d.id + ':' + bot.entity.id) === 'blind') {
    fcA = pushedForecast(fc, fc.n - 3, plan.centre, plan.seen || 1, P)
    if (fcA) {
      const acc = sitAcc.id === d.id ? sitAcc.dmg : 0
      const cap = acc < 25 ? 49 - acc : null
      const tA = gameClock.now()
      ownA = tsOwnPlan(bot, plan, fcA, { cap, dpos: new Vec3(fcA.sit.x, fcA.sit.y, fcA.sit.z) })
      ev('ocA', ownA ? { ms: gameClock.now() - tA, H: [ownA.H.x, ownA.yb, ownA.H.z], B: [ownA.B.x, ownA.G, ownA.B.z], depth: ownA.depth, expect: ownA.expect, dist: r1(ownA.centre.distanceTo(fcA.head)), seen: ownA.seen, cap, acc: r1(acc) } : { ms: gameClock.now() - tA, no: tsOwnPlan.why, cap, acc: r1(acc) })
      // B — тоже свой окоп у головы сидящего, без потолка (её взрыв поднимет на взлёт); цела после
      // взрывов L и A, её окоп не в их воронках.
      if (ownA && process.env.ND_OC_B !== '0') {
        const tB = gameClock.now()
        const world = stationWorld(ownA, stationWorld(plan, plan.world))
        ownB = tsOwnStation(bot, fcA.head, { fc: { ...fcA, n: fcA.n + 3 }, dpos: new Vec3(fcA.sit.x, fcA.sit.y, fcA.sit.z), world, priors: [plan, ownA], avoid: [plan, ownA], sitP: predParts(fcA) })
        if (ownB) ownB.role = 'B'
        ev('ocB', ownB ? { ms: gameClock.now() - tB, H: [ownB.H.x, ownB.yb, ownB.H.z], B: [ownB.B.x, ownB.G, ownB.B.z], depth: ownB.depth, expect: ownB.expect, dist: r1(ownB.centre.distanceTo(fcA.head)), seen: ownB.seen } : { ms: gameClock.now() - tB, no: tsOwnStation.why })
      }
    } else ev('ocA', { no: { 'посадка после L не считается': 1 } })
  }

  ev('ocPlan', { ms: gameClock.now() - tPlan0, anchor: plan.anchor || undefined, n: fc.n, head: [r1(tgt.x), r1(tgt.y), r1(tgt.z)], sitHead: [r1(fc.head.x), r1(fc.head.y), r1(fc.head.z)], yRotA: r1(fc.yRotA), H: [plan.H.x, plan.yb, plan.H.z], lift: plan.lift, depth: plan.depth, dist: plan.dist, seen: plan.seen, expect: plan.expect, u: [plan.u.x, plan.u.z], a: [plan.a.x, plan.a.z], no: whyAll })
  doing(ctl, 'oc:build')
  // Опасно стоять там, где мы сейчас: коробки снижающегося по свежему прогнозу на ~1.5 с вперёд.
  const danger = () => {
    const dd = dragonOf(bot)
    const ph = dd ? phaseOf(bot, dd) : null
    if (ph !== PHASE.LANDING) return `фаза ${PHASE_RU[ph] ?? ph}`
    const f = feed.fc && feed.fc.id === d.id ? feed.fc : fc
    if (f.n - Math.round((gameClock.now() - f.t) / 50) < 8) return 'не успеть до посадки'
    const soon = { ...f, path: f.path.slice(0, 30) }
    const h = landingHits(soon, bot.entity.position, 0.5)
    return h ? `${h.what} через ${h.k} тиков` : null
  }
  ctl.holdStation = true
  let b
  const leftTicks = () => { const f = feed.fc && feed.fc.id === d.id ? feed.fc : fc; return f.n - Math.round((gameClock.now() - f.t) / 50) }
  try {
    if (!ownA) b = await tsBuild(session, ctl, stats, plan, danger, leftTicks)
    else {
      b = await tsBuild(session, ctl, stats, plan, danger, leftTicks, { skipTrench: true })
      if (b.ok) {
        // A — пока до посадки ≥ 70 тиков; бросить, если меньше 45 (успеть в окоп L).
        if (leftTicks() >= 70) {
          const dangerA = () => (leftTicks() < 45 ? 'некогда (A)' : danger())
          const bA = await tsBuild(session, ctl, stats, ownA, dangerA, leftTicks, { skipTrench: true })
          if (!bA.ok) { ev('ocA', { fail: `стройка A: ${bA.why}` }); ownA = null; ownB = null }
          if (ownB && leftTicks() >= 70) {
            const bB = await tsBuild(session, ctl, stats, ownB, dangerA, leftTicks, { skipTrench: true })
            if (bB.ok) ownB.built = true
            else { ev('ocB', { fail: `стройка B: ${bB.why}` }); ownB = null }
          }
        } else { ev('ocA', { fail: 'некогда строить A' }); ownA = null; ownB = null }
        b = await tsBuild(session, ctl, stats, plan, danger, leftTicks, { onlyTrench: true })
      }
    }
  } finally { ctl.holdStation = false }
  if (!b.ok) return no(`стройка: ${b.why}`)
  stats.oc.built++
  // L0: щелчок за gapTicks тиков до L (прогноз — свежий).
  if (plan.second && plan.gapTicks >= 10) {
    const s2 = plan.second
    const hit0 = tsClickPoint(bot, bot.entity.position.offset(0, EYE, 0), s2)
    if (hit0) {
      await lookAtSafe(bot, hit0.point)
      await new Promise(resolve => bot.once('physicsTick', resolve))
      doing(ctl, 'oc:wait0')
      let t0c = 0; let last0 = fc; let okWait = true
      for (;;) {
        if (ctl.aborted) return false
        const dd = dragonOf(bot)
        if (!dd || phaseOf(bot, dd) !== PHASE.LANDING) { okWait = false; break }
        const f2 = feed.fc && feed.fc.id === d.id ? feed.fc : null
        if (f2) last0 = f2
        // До L0 дракон летит по прогнозу без толчка: тик L0 — i0 + 1 от пакета плана, сдвиг —
        // по свежему прогнозу того же (ещё не толкнутого) полёта.
        t0c = plan.nPlan ? last0.t + 50 * (last0.n - plan.nPlan + s2.i0 + 1) - 30 : last0.t + 50 * (last0.n - 2) - 30 - 50 * plan.gapTicks
        if (t0c - gameClock.now() < 70) break
        await sleep(15)
      }
      if (okWait && t0c > gameClock.now() - 30) {
        const at0 = plan.nPlan ? last0.path[last0.n - plan.nPlan + s2.i0] : last0.path[last0.n - 3 - plan.gapTicks]
        const hd0 = at0 ? r1(at0.head.distanceTo(s2.centre)) : null
        const b0 = await bedsBoom(session, ctl, stats, { ...s2, reuse: true }, hit0, 'снижение', { aimed: true, until: t0c, uncounted: true, phCheck: p => p === PHASE.LANDING, note: { headDist: hd0, oc: 'L0' } })
        stats.oc.L0 = stats.oc.L0 || []
        stats.oc.L0.push({ ok: b0.ok, dmg: b0.dmg, headDist: hd0 })
      } else ev('ocL', { why: 'L0: не дождался' })
    } else ev('ocL', { why: 'L0: бок не видно' })
  }
  const hitPt = plan.anchor ? anClickPoint(bot, bot.entity.position.offset(0, EYE, 0), plan) : tsClickPoint(bot, bot.entity.position.offset(0, EYE, 0), plan)
  if (!hitPt) return no(plan.anchor ? 'якорь из окопа не видно' : 'бок кровати из окопа не видно')
  await lookAtSafe(bot, hitPt.point)
  await new Promise(resolve => bot.once('physicsTick', resolve))
  // Ждать миг: прогноз по свежим пакетам; голова должна лечь у кровати.
  doing(ctl, 'oc:wait')
  let tClick = 0; let last = fc
  for (;;) {
    if (ctl.aborted) return false
    const dd = dragonOf(bot)
    if (!dd) return false
    const ph = phaseOf(bot, dd)
    if (ph !== PHASE.LANDING) return no(`фаза ${PHASE_RU[ph] ?? ph} до щелчка`)
    const f2 = landingForecast(feed, P)
    if (f2) last = f2
    const miss = last.head.distanceTo(refHead)
    if (miss > 1.2) return no(`прогноз ушёл на ${r1(miss)}`)
    if (landingHits(last, bot.entity.position, 0.2)) return no('коробки дракона на месте')
    // Щелчок, обработанный после тика g + n − 2 (за два тика до посадки): опоздание на тик
    // — ещё снижение; на тик раньше «в самый раз» — уже сидит (урон в сидячий счёт; oc2-26).
    tClick = last.t + 50 * (last.n - 2) - 55
    if (tClick - gameClock.now() < 70) break
    await sleep(15)
  }
  const at = last.path[last.n - 3] || last.path[last.path.length - 1]
  const cen = plan.centre
  const headDist = at ? r1(Math.hypot(at.head.x - cen.x, at.head.y - cen.y, at.head.z - cen.z)) : null
  // Первая посадка: сразу за L — крышка над головой к упору K (обработается через тик, до
  // тика посадки: первое «высматривает» спросит видимость — окоп закрыт, и дракон слепой навсегда).
  let lidSent = false
  const placeLid = async () => {
    const K = new Vec3(plan.K.x, plan.G, plan.K.z)
    const face = new Vec3(-plan.K.d.x, 0, -plan.K.d.z)
    const aim = pick.faceAim(bot, K, face, { avoid: [] })
    if (!aim) return
    await lookAtSafe(bot, aim)
    await new Promise(resolve => bot.once('physicsTick', resolve))
    const cur = aim.minus(K)
    bot._client.write('block_place', { location: K, direction: FACE_IDX(face), hand: 0, cursorX: cur.x, cursorY: cur.y, cursorZ: cur.z, insideBlock: false, sequence: 0, worldBorderHit: false })
    bot.swingArm()
    lidSent = true
  }
  if (blindLid) {
    const f = fillerItem(bot)
    const it = f && bot.inventory.items().find(i => i.name === f)
    if (it) await bot.equip(it, 'hand').catch(() => {})
    await lookAtSafe(bot, hitPt.point)
    await new Promise(resolve => bot.once('physicsTick', resolve))
  }
  const boom = await bedsBoom(session, ctl, stats, plan, hitPt, 'снижение', { aimed: true, until: tClick, uncounted: true, phCheck: p => p === PHASE.LANDING, note: { headDist, n: last.n, oc: 'L', lid: blindLid || undefined }, keepHand: blindLid, afterClick: blindLid ? placeLid : null })
  if (blindLid) {
    // Дождаться «высматривает» (запрос видимости — в тик посадки), потом вылезти.
    const lidPos = new Vec3(plan.B.x, plan.G, plan.B.z)
    const t0 = gameClock.now(); let sat = 0; let roared = false
    while (!ctl.aborted && gameClock.now() - t0 < 4000) {
      const dd = dragonOf(bot); const ph = dd ? phaseOf(bot, dd) : null
      if (ph === PHASE.ROARING || ph === PHASE.FLAMING) { roared = true; break }
      if (SITTING.has(ph)) { if (!sat) sat = gameClock.now(); if (gameClock.now() - sat > 150) break }
      await sleep(20)
    }
    const lidUp = isSolid(bot.blockAt(lidPos))
    ev('blind:lid', { sent: lidSent, lid: lidUp, sat: !!sat, roared })
    if (sat && lidUp && !roared && dragonOf(bot)) sight.set(dragonOf(bot).id + ':' + bot.entity.id, 'blind')
    if (lidUp) { await items.equipBestTool(bot, bot.blockAt(lidPos)); await build.withTimeout(bot.dig(bot.blockAt(lidPos), true), 3000).catch(() => {}) }
  }
  if (!boom.ok) return no(`щелчок: ${boom.why}`)
  stats.oc.booms++
  stats.oc.L = stats.oc.L || []
  stats.oc.L.push({ dmg: boom.dmg, headDist, took: boom.ph })
  if (tk && plan.second) ctl.ocTk = { dId: d.id, t: gameClock.now(), plan: { ...plan, second: null }, T2: tk.T2, A: tk.A, path: tk.path, S: tk.S }
  // Видящий: «высматривает» 25 тиков поворачивает голову к нам — переждать в окопе (в окопе в 2
  // голова/шея и облако не достают), неподвижно: тогда конечное положение головы точно считается
  // (seeCalibrate по нашему месту на посадке). Вылезти — когда рёв/огонь.
  {
    const dd = dragonOf(bot)
    if (dd && sight.get(dd.id + ':' + bot.entity.id) === 'seeing') {
      doing(ctl, 'oc:scanWait')
      const tw = gameClock.now()
      while (!ctl.aborted && gameClock.now() - tw < 3500) {
        const d2 = dragonOf(bot); const ph2 = d2 ? phaseOf(bot, d2) : null
        if (!d2 || ph2 === PHASE.ROARING || ph2 === PHASE.FLAMING) break
        if (!SITTING.has(ph2) && ph2 !== PHASE.LANDING) break
        await sleep(25)
      }
    }
  }
  // Из окопа — сразу на землю (блок под себя): выход шагами из ямы в блок шёл по 4 с
  // (oc7-15: «beds:walk» до самого взлёта — ни A, ни B).
  const q = bot.entity.position
  if (Math.floor(q.y + 0.01) < plan.G) { doing(ctl, 'oc:out'); await build.towerUp(bot, ctl, plan.G - Math.floor(q.y + 0.01)).catch(() => {}); clearControls(bot) }
  if (ownA) {
    const rA = await ocOwnClick(session, ctl, stats, ownA, fcA, track, { tag: 'A' })
    // B: построена на снижении — дойти и щёлкнуть; нет — построить сейчас (слепой сидит 99 тиков).
    if (rA && ownB) await ocOwnClick(session, ctl, stats, ownB, fcA, track, { tag: 'B', build: !ownB.built })
  }
  return true
}
// Кровать в своём окопе (A, B — построены на снижении, или B строится сейчас): дойти до окопа,
// вкопаться, дождаться «сел» и ≥ 10 тиков после прошлого взрыва, щелчок (в сидячий счёт), вылезти.
async function ocOwnClick (session, ctl, stats, st, fcA, track, { tag = 'A', build: doBuild = false } = {}) {
  const bot = session.bot
  const ev = (k, o) => { if (ctl.trace) ctl.trace.ev(k, o) }
  const t0 = gameClock.now()
  let why = null
  let ok = false
  const sittingNow = () => { const dd = dragonOf(bot); return !!dd && SITTING.has(phaseOf(bot, dd)) }
  try {
    const d0 = dragonOf(bot)
    if (!d0) { why = 'нет дракона'; return false }
    if (doBuild) {
      if (!sittingNow()) { why = 'не сидит — строить некогда'; return false }
      if (!st.psSafe) { why = 'место ставки у шеи сидящего'; return false }
      ctl.holdStation = true
      let b
      try { b = await tsBuild(session, ctl, stats, st, () => (!sittingNow() ? 'взлетел' : null), null, { skipTrench: true, parts: () => partsOf(bot, dragonOf(bot), track) }) } finally { ctl.holdStation = false }
      if (!b.ok) { why = `стройка: ${b.why}`; return false }
    }
    const bedOk = /_bed$/.test((bot.blockAt(new Vec3(st.H.x, st.yb, st.H.z)) || {}).name || '')
    if (!bedOk) { why = 'кровати нет (снесло?)'; return false }
    doing(ctl, `oc:to${tag}`)
    const feet = new Vec3(st.B.x + 0.5, st.G, st.B.z + 0.5)
    const g = await bedsGo(session, ctl, { feet, y: st.G, B: st.B, lift: 0 }, true, partsOf(bot, d0, track))
    if (!g.ok) { why = `не дошёл: ${g.why}`; return false }
    const tr = await tsTrench(bot, ctl, st, k => doing(ctl, `oc${tag}:` + k), session)
    if (!tr.ok) { why = `окоп: ${tr.why}`; return false }
    const hit = tsClickPoint(bot, bot.entity.position.offset(0, EYE, 0), st)
    if (!hit) { why = 'бок не видно'; return false }
    await lookAtSafe(bot, hit.point)
    await new Promise(resolve => bot.once('physicsTick', resolve))
    doing(ctl, `oc:wait${tag}`)
    const tw = gameClock.now()
    let sat = false
    while (!ctl.aborted && gameClock.now() - tw < 3000) {
      const dd = dragonOf(bot); const ph = dd ? phaseOf(bot, dd) : null
      if (SITTING.has(ph)) { sat = true; break }
      if (ph !== PHASE.LANDING) break
      await sleep(10)
    }
    if (!sat) { why = 'не сидит'; return false }
    const hd = fcA ? r1(fcA.head.distanceTo(st.centre)) : null
    const r = await bedsBoom(session, ctl, stats, { ...st, reuse: true }, hit, 'сидит', { aimed: true, until: Math.max(gameClock.now(), (stats.lastBoom || 0) + BED_GAP_MS), phCheck: p => SITTING.has(p), note: { oc: tag, headDist: hd, ms: gameClock.now() - t0, prebuilt: !doBuild } })
    stats.oc[tag] = stats.oc[tag] || []
    stats.oc[tag].push({ ok: r.ok, dmg: r.dmg, headDist: hd })
    if (!r.ok) { why = `щелчок: ${r.why}`; return false }
    ok = true
    return true
  } finally {
    ev('oc' + tag, { done: ok, why, ms: gameClock.now() - t0 })
    const q = bot.entity.position
    if (Math.floor(q.y + 0.01) < st.G && Math.floor(q.x) === st.B.x && Math.floor(q.z) === st.B.z) { doing(ctl, `oc:out${tag}`); await build.towerUp(bot, ctl, st.G - Math.floor(q.y + 0.01)).catch(() => {}); clearControls(bot) }
  }
}

// ------------------------------------------------------------ один цикл: станция в окопе (L)
//
// Снижающийся бьёт крыльями (knockBack: [c ± 6] × [Y − 2, Y + 4], 5 урона и отброс на
// десяток блоков) всех, кто рядом с местом посадки на земле: у фонтана Y на последних
// тиках ≈ G + 3 (G — уровень ног на земле), низ коробок крыльев ≈ G + 1, голова и шея
// (+1) — от G + 1.9. Окоп глубиной в блок (ноги G − 1, макушка G + 0.8) — ниже всех.
// Раскладка (u — от окопа к изножью, a — от изножья к изголовью, a ⟂ u):
//   B (окоп) — V (просвет) — F (изножье на опоре), H = F + a (изголовье, под головой);
//   W = H − u — заслон в два блока (G, G+1): лучи взрыва из H к точкам нашей коробки
//   идут через W (или под землёй), а взгляд из окопа на бок F — через V.
// Кровать ложится изголовьем по взгляду (BedBlock: FACING — горизонталь взгляда):
// ставим её с PS = F − 2a (смотрим вдоль a на верх опоры), потом — в окоп.
const SEEN_Y5 = [0, 0.391, 0.783, 1.174, 1.565]
function exposure (vbot, feet, centre) {
  let open = 0; let all = 0
  for (const fy of SEEN_Y5) {
    for (const ox of SEEN_XZ) {
      for (const oz of SEEN_XZ) {
        all++
        const p = new Vec3(feet.x + ox, feet.y + fy, feet.z + oz)
        const dv = centre.minus(p); const len = dv.norm()
        if (len < 0.1) { open++; continue }
        if (!pick.blockOnRay(vbot, p, dv.scaled(1 / len), len - 0.02)) open++
      }
    }
  }
  return open / all
}
const DIRS4 = [{ x: 1, z: 0 }, { x: -1, z: 0 }, { x: 0, z: 1 }, { x: 0, z: -1 }]
const addc = (c, d, k = 1) => ({ x: c.x + d.x * k, z: c.z + d.z * k })
// Точка на боку изножья (грань к окопу), видимая из глаз eye в мире vbot.
function tsClickPoint (vbot, eye, plan) {
  const F = plan.F; const u = plan.u; const yb = plan.yb
  // грань F, обращённая к −u: плоскость x = F.x (+1 если −u = +x) …
  const fx = u.x > 0 ? F.x : u.x < 0 ? F.x + 1 : null
  const fz = u.z > 0 ? F.z : u.z < 0 ? F.z + 1 : null
  const pts = []
  for (const s of [0.5, 0.3, 0.7, 0.15, 0.85]) {
    for (const h of [0.3, 0.15, 0.45]) {
      const y = yb + h
      if (fx != null) pts.push(new Vec3(fx - u.x * 0.001, y, F.z + s)); else pts.push(new Vec3(F.x + s, y, fz - u.z * 0.001))
    }
  }
  for (const P of pts) {
    const dv = P.minus(eye); const len = dv.norm()
    if (len > 4.3 || len < 0.5) continue
    const hit = pick.blockOnRay(vbot, eye, dv.scaled(1 / len), len + 0.1)
    if (hit && /_bed$/.test(hit.block.name) && hit.pos.x === F.x && hit.pos.z === F.z && hit.pos.y === yb) return { point: P, block: hit.block }
  }
  return null
}
// Точка щелчка по якорю в H (yb) из глаз eye: любая видимая грань, первым на луче — сам якорь.
function anClickPoint (vbot, eye, st) {
  const P0 = new Vec3(st.H.x, st.yb, st.H.z)
  const faces = [[0, 0, -1], [0, 0, 1], [-1, 0, 0], [1, 0, 0], [0, 1, 0], [0, -1, 0]]
  for (const [fx, fy, fz] of faces) {
    for (const [a, b] of [[0.5, 0.5], [0.3, 0.5], [0.7, 0.5], [0.5, 0.3], [0.5, 0.7], [0.25, 0.25], [0.75, 0.75], [0.25, 0.75], [0.75, 0.25]]) {
      const p = fx ? new Vec3(P0.x + (fx > 0 ? 1.001 : -0.001), P0.y + a, P0.z + b) : fy ? new Vec3(P0.x + a, P0.y + (fy > 0 ? 1.001 : -0.001), P0.z + b) : new Vec3(P0.x + a, P0.y + b, P0.z + (fz > 0 ? 1.001 : -0.001))
      const dv = p.minus(eye); const len = dv.norm()
      if (len > 4.3 || len < 0.5) continue
      if (dv.x * fx + dv.y * fy + dv.z * fz >= 0) continue
      const hit = pick.blockOnRay(vbot, eye, dv.scaled(1 / len), len + 0.1)
      if (hit && hit.pos.x === P0.x && hit.pos.y === P0.y && hit.pos.z === P0.z) return { point: p, block: hit.block, face: new Vec3(fx, fy, fz) }
    }
  }
  return null
}
// Станция под точку target (низ-центр головы в миг взрыва). lift — кровать на lift
// блоков выше земли. fc — прогноз посадки (проверка крыльев/головы по пути).
function tsPlan (bot, target, { lift = 1, fc = null, skip = null, dpos = null, fixedB = null, avoid = null, extra = null, lid = false, radius = 2.6, anchor = false, portalOk = false } = {}) {
  const all = []
  const at = (x, y, z) => bot.blockAt(new Vec3(x, y, z))
  const solidOk = b => isSolid(b) && !/_bed$|portal|gateway|bedrock/.test(b.name)
  const why = {}
  const no = k => { why[k] = (why[k] || 0) + 1 }
  // Верх земли в колонке c около G (G + 1 … G − 2): y первого воздуха над твёрдым.
  const gTop = (c, G) => { for (let y = G + 1; y >= G - 2; y--) { if (solidOk(at(c.x, y - 1, c.z)) && !isSolid(at(c.x, y, c.z))) return y } return null }
  let best = null
  const H0 = { x: Math.floor(target.x), z: Math.floor(target.z) }
  // ±2 клетки от головы (fin1: «нет станции у головы» ×9 при ±1): дальше — меньше урона,
  // но лучше, чем ничего; стоимость выбирает ближнюю, если есть.
  const R = Math.ceil(radius)
  for (let ox = -R; ox <= R; ox++) {
    for (let oz = -R; oz <= R; oz++) {
      const H = { x: H0.x + ox, z: H0.z + oz }
      if (Math.hypot(H.x + 0.5 - target.x, H.z + 0.5 - target.z) > radius) continue
      const sH = surfaceY(bot, H.x, H.z, Math.floor(target.y) + 2)
      if (!sH) { no('нет земли у головы'); continue }
      for (const u of DIRS4) {
        for (const a of DIRS4) {
          if (a.x * u.x + a.z * u.z !== 0) continue
          const F = addc(H, a, -1); const B = addc(F, u, -2); const V = addc(F, u, -1); const W = addc(H, u, -1); const PS = addc(F, a, -2)
          const key = `${H.x},${H.z},${u.x},${u.z},${a.x},${a.z}`
          if (skip && skip.has(key)) continue
          if (fixedB && (B.x !== fixedB.x || B.z !== fixedB.z)) continue
          if (avoid && [F, W, V, PS, H].some(c => avoid.has(`${c.x},${c.z}`))) { no('клетки второй станции'); continue }
          // G — земля у окопа (ноги стоящего у B); кровать на G + lift
          const G = gTop(B, sH.y)
          if (G == null) { no('у окопа нет земли'); continue }
          const yb = G + lift
          // Якорь (dragon_immune: коробка головы его не сносит) — можно прямо на пути головы.
          if (!anchor && target.y - yb < 0.6) { no('голова низко'); continue }
          const gF = gTop(F, G); const gV = gTop(V, G); const gW = gTop(W, G)
          if (!anchor && (gF == null || gF > G || gF < G - 1)) { no('под изножьем'); continue }
          if (gV == null || gV > G) { no('просвет: земля выше'); continue }
          if (gW == null || gW > G) { no('заслон: земля выше'); continue }
          if (!bedCellFree(at(H.x, yb, H.z)) || !bedCellFree(at(F.x, yb, F.z))) { no('клетки кровати'); continue }
          if ([...Array(lift + 1).keys()].some(k => !isAirish(at(V.x, G + k, V.z)))) { no('просвет закрыт'); continue }
          const wCells = []; for (let y = gW; y <= G + lift; y++) { const w = at(W.x, y, W.z); if (!(isAirish(w) || solidOk(w))) { wCells.length = 0; wCells.push(null); break } wCells.push(y) }
          if (wCells[0] === null) { no('клетка заслона'); continue }
          const sCells = []; if (!anchor) for (let y = gF; y < yb; y++) sCells.push(y)
          if (sCells.some(y => !(isAirish(at(F.x, y, F.z)) || solidOk(at(F.x, y, F.z))))) { no('клетка опоры'); continue }
          if (!portalOk && [F, W, V, B, PS, H].some(c => nearPortal(new Vec3(c.x + 0.5, G, c.z + 0.5)))) { no('чаша портала'); continue }
          const gPS = gTop(PS, G)
          if (gPS == null || Math.abs(gPS - G) > 1 || !isAirish(at(PS.x, gPS + 1, PS.z))) { no('место ставки'); continue }
          if (!isAirish(at(B.x, G, B.z)) || !isAirish(at(B.x, G + 1, B.z))) { no('над окопом блок'); continue }
          // lid (первая посадка — ослепить): окоп в 2, крышка над головой (B, G) к упору K — сосед
          // окопа на уровне земли (не просвет V); упор должен пережить взрыв L (fin2-10: упор
          // снесло — крышка не встала, дракон увидел).
          let K = null
          if (lid) {
            for (const kd of [{ x: -u.x, z: -u.z }, a, { x: -a.x, z: -a.z }]) {
              const c = addc(B, kd)
              if (solidOk(at(c.x, G - 1, c.z)) && (isAirish(at(c.x, G, c.z)) || solidOk(at(c.x, G, c.z)))) { K = c; K.d = kd; break }
            }
            if (!K) { no('нет упора крышки'); continue }
          }
          for (const depth of (lid ? [2] : [1, 2])) {
            // окоп: копаем G − 1 … G − depth, пол — твёрдый
            const digs = []; let okDig = true
            for (let k = 1; k <= depth; k++) { const b = at(B.x, G - k, B.z); if (!b || !/end_stone|cobble|stone|dirt|netherrack|andesite|diorite|granite|tuff/.test(b.name)) okDig = false; digs.push(G - k) }
            if (!okDig || !solidOk(at(B.x, G - depth - 1, B.z))) { no('окоп не выкопать'); continue }
            const trench = new Vec3(B.x + 0.5, G - depth, B.z + 0.5)
            if (fc && landingHits(fc, trench, 0.15)) { no('окоп под драконом'); continue }
            // Вылезти из окопа после посадки — не в коробки головы/шеи сидящего (oc7-6:
            // удар шеей на выходе из окопа к кровати A).
            if (fc && hurtNear(playerBox(new Vec3(B.x + 0.5, G, B.z + 0.5)), predParts(fc))) { no('окоп у шеи сидящего'); continue }
            // Кровать не в коробках головы/шеи/тела снижающегося до мига щелчка (checkWalls
            // снесёт её без взрыва: oc3-22 — кровать на два блока пропала).
            if (fc) {
              // Кровать — или (у якоря) клетки заслона: не в коробках до мига щелчка.
              const boxes = anchor ? wCells.map(y => ({ min: new Vec3(W.x, y, W.z), max: new Vec3(W.x + 1, y + 1, W.z + 1) })) : [{ min: new Vec3(Math.min(F.x, H.x), yb, Math.min(F.z, H.z)), max: new Vec3(Math.max(F.x, H.x) + 1, yb + BED_TOP, Math.max(F.z, H.z) + 1) }]
              const upto = Math.max(1, fc.n - 3)
              let hitBed = false
              for (const st of fc.path) {
                if (st.k > upto) break
                const hb = box(st.head.x, st.head.y, st.head.z, 0.5, 1); const nb = box(st.neck.x, st.neck.y, st.neck.z, 1.5, 3)
                const by = box(st.pos.x + Math.sin(st.yRot * DRAD) * 0.5, st.pos.y, st.pos.z - Math.cos(st.yRot * DRAD) * 0.5, 2.5, 3)
                if (boxes.some(bb => overlap(bb, inflate(hb, 0.15)) || overlap(bb, inflate(nb, 0.15)) || overlap(bb, inflate(by, 0.15)))) { hitBed = true; break }
              }
              if (hitBed) { no(anchor ? 'заслон якоря на пути головы' : 'кровать на пути головы'); continue }
            }
            // мир «как будет»: опора F, заслон W, окоп (и вторая станция, если есть)
            const ex = new Map(extra || [])
            for (const y of sCells) ex.set(`${F.x},${y},${F.z}`, 'block')
            for (const y of wCells) ex.set(`${W.x},${y},${W.z}`, 'block')
            for (const y of digs) ex.set(`${B.x},${y},${B.z}`, 'air')
            if (lid && !solidOk(at(K.x, G, K.z))) ex.set(`${K.x},${G},${K.z}`, 'block')
            const vb = virtualBot(bot, ex)
            const centre = new Vec3(H.x + 0.5, yb + 0.5, H.z + 0.5)
            const expo = exposure(vb, trench, centre)
            if (expo > 0.02) { no('взрыв видит окоп'); continue }
            const ex2 = new Map(ex)
            if (anchor) ex2.set(`${H.x},${yb},${H.z}`, 'block'); else { ex2.set(`${F.x},${yb},${F.z}`, 'bed'); ex2.set(`${H.x},${yb},${H.z}`, 'bed') }
            const cp = anchor ? anClickPoint(virtualBot(bot, ex2), trench.offset(0, EYE, 0), { H, yb }) : tsClickPoint(virtualBot(bot, ex2), trench.offset(0, EYE, 0), { F, u, yb })
            if (!cp) { no(anchor ? 'якорь из окопа не видно' : 'бок кровати не видно'); continue }
            // Кровать на два блока: верх опоры (G + 2) выше глаз стоящего на земле — ставим с блока
            // у PS (psLift): встать на свой блок, как столбом. Якорь ставим к боку заслона — не нужно.
            const psLift = !anchor && yb - gPS >= 2 ? 1 : 0
            if (psLift && (!isAirish(at(PS.x, gPS + 2, PS.z)) || !isAirish(at(PS.x, gPS + 1, PS.z)))) { no('над местом ставки блок'); continue }
            const ground = new Vec3(PS.x + 0.5, gPS + psLift, PS.z + 0.5)
            if (psLift) { ex.set(`${PS.x},${gPS},${PS.z}`, 'block') }
            if (anchor) {
              // якорь — к грани +u верхнего блока заслона (W + u = H), с места ставки, крадучись
              if (!pick.faceAim(virtualBot(bot, ex), new Vec3(W.x, yb, W.z), new Vec3(u.x, 0, u.z), { eye: ground.offset(0, SNEAK_EYE, 0), avoid: [] })) { no('грань заслона для якоря не видно'); continue }
            } else if (!pick.faceAim(virtualBot(bot, ex), new Vec3(F.x, yb - 1, F.z), new Vec3(0, 1, 0), { eye: ground.offset(0, EYE, 0), avoid: [] })) { no('верх опоры не видно с места ставки'); continue }
            // Честная ставка каждого блока по порядку стройки (опора, заслон — с PS или с B
            // до окопа): грань соседа видна из глаз (крадучись) на «мире как будет».
            {
              // Уже стоящие блоки других станций (extra) — в «мире стройки» с самого начала.
              const exB = new Map(extra || []); let bad = null
              const eyePS = ground.offset(0, SNEAK_EYE, 0); const eyeB = new Vec3(B.x + 0.5, G + SNEAK_EYE, B.z + 0.5)
              for (const y of sCells) { const c = new Vec3(F.x, y, F.z); if (!fillPlaceable(exB.size ? virtualBot(bot, exB) : bot, c, eyePS, { robust: true })) { bad = 'опору не поставить честно'; break } exB.set(`${F.x},${y},${F.z}`, 'block') }
              if (!bad) for (const y of wCells) { const c = new Vec3(W.x, y, W.z); const vv = virtualBot(bot, exB); if (!fillPlaceable(vv, c, eyePS, { robust: true }) && (psLift || !fillPlaceable(vv, c, eyeB, { robust: true }))) { bad = 'заслон не поставить честно'; break } exB.set(`${W.x},${y},${W.z}`, 'block') }
              if (!bad && lid && !solidOk(at(K.x, G, K.z))) { const vv = virtualBot(bot, exB); if (!fillPlaceable(vv, new Vec3(K.x, G, K.z), eyePS) && !fillPlaceable(vv, new Vec3(K.x, G, K.z), eyeB)) bad = 'упор крышки не поставить честно' }
              if (!bad && lid && !pick.faceAim(vb, new Vec3(K.x, G, K.z), new Vec3(-K.d.x, 0, -K.d.z), { eye: trench.offset(0, EYE, 0), avoid: [] })) bad = 'крышку из окопа не поставить'
              if (!bad && lid && blastReaches(vb, bot, centre, [{ x: K.x, y: G, z: K.z }])) bad = 'упор крышки снесёт взрыв L'
              if (bad) { no(bad); continue }
            }
            const dist = centre.distanceTo(target)
            // видимость дракона — позже, для лучших (дорого)
            const seen = 1
            const expect = bedDamage(dist, seen)
            const me = bot.entity.position
            const walk = Math.hypot(PS.x + 0.5 - me.x, PS.z + 0.5 - me.z)
            // Место ставки и клетка окопа под крылом/головой на последних ~2.5 с снижения — стройка
            // там обрывается («дракон рядом: крыло через N тиков», 16 из 29 обрывов fin3–fin5).
            let wingPen = 0
            if (fc && fc.path && fc.path.length) {
              const tail = { ...fc, path: fc.path.filter(st => st.k >= fc.n - 50) }
              if (landingHits(tail, ground, 0.3) || landingHits(tail, new Vec3(B.x + 0.5, G, B.z + 0.5), 0.3)) wingPen = 25
            }
            const cost = -expect + walk * 0.8 + (sCells.length + wCells.length) * 1.5 + depth * 2 + wingPen
            const cand = { key, H, F, W, V, B, PS, u, a, G, yb, lift, depth, sCells, wCells, digs, trench, ground, centre, dist: r1(dist), expect, seen: Math.round(seen * 100) / 100, cost: cost + psLift * 3, y: yb, D: a, expo, world: ex, psLift, gPS, K: lid ? K : null, anchor: anchor || undefined }
            all.push(cand)
            if (!best || cost < best.cost) best = cand
            break
          }
        }
      }
    }
  }
  // Видимость дракона из центра взрыва (свои блоки режут урон) — для лучших 5 по стоимости.
  if (dpos && all.length) {
    all.sort((p, q) => p.cost - q.cost)
    best = null
    for (const c of all.slice(0, 5)) {
      const seen = dragonSeen(virtualBot(bot, c.world), c.centre, dpos)
      c.seen = Math.round(seen * 100) / 100
      const e2 = bedDamage(c.centre.distanceTo(target), seen)
      c.cost += c.expect - e2
      c.expect = e2
      if (!best || c.cost < best.cost) best = c
    }
  }
  tsPlan.why = why
  tsPlan.all = all
  return best
}
// Разрушит ли взрыв (кровать: мощность 5) хоть одну из клеток cells — лучи
// ServerExplosion.calculateExplodedPositions: 16³ направлений по поверхности куба,
// сила 5·(0.7…1.3) — берём худшее 1.3, шаг 0.3: −(стойкость + 0.3)·0.3 в блоке, −0.225
// за шаг. Кровать (0.2) рушится, если луч дошёл до неё с силой > 0.15.
const RES_CACHE = new Map()
function blockRes (bot, b) {
  if (!b || b.boundingBox === 'empty') return /water|lava/.test((b && b.name) || '') ? 100 : 0
  if (RES_CACHE.has(b.name)) return RES_CACHE.get(b.name)
  const info = bot.registry && bot.registry.blocksByName[b.name]
  const r = info && typeof info.resistance === 'number' ? info.resistance : 6
  RES_CACHE.set(b.name, r)
  return r
}
function blastReaches (vbot, bot, centre, cells, power = 5) {
  const want = new Set(cells.map(c => `${c.x},${c.y},${c.z}`))
  for (let i = 0; i < 16; i++) {
    for (let j = 0; j < 16; j++) {
      for (let k = 0; k < 16; k++) {
        if (!(i === 0 || i === 15 || j === 0 || j === 15 || k === 0 || k === 15)) continue
        let dx = i / 15 * 2 - 1; let dy = j / 15 * 2 - 1; let dz = k / 15 * 2 - 1
        const l = Math.sqrt(dx * dx + dy * dy + dz * dz); dx /= l; dy /= l; dz /= l
        let h = power * 1.3
        let x = centre.x; let y = centre.y; let z = centre.z
        while (h > 0) {
          const bx = Math.floor(x); const by = Math.floor(y); const bz = Math.floor(z)
          const key = `${bx},${by},${bz}`
          const b = vbot.blockAt(new Vec3(bx, by, bz))
          const res = blockRes(bot, b)
          if (b && b.boundingBox !== 'empty') h -= (res + 0.3) * 0.3
          if (h > 0 && want.has(key)) return true
          x += dx * 0.3; y += dy * 0.3; z += dz * 0.3
          h -= 0.225
        }
      }
    }
  }
  return false
}
// Вторая кровать на снижении (L0) — с другой стороны того же окопа: F0 = B − d0·u,
// H0 = F0 + a0, заслон W0 = H0 + u (закрывает и окоп, и кровать L за ним), просвет
// V0 = B − u. Мишень — голова снижающегося на тике i0 ≤ n − 13 (за ≥ 10 тиков до L:
// неуязвимость дракона 10 тиков). Кровать L должна пережить взрыв L0 (лучи).
function tsSecond (bot, plan, fc, { dpos = null, sides = null, imin = null, imax = null, primaryFirst = false } = {}) {
  const at = (x, y, z) => bot.blockAt(new Vec3(x, y, z))
  const solidOk = b => isSolid(b) && !/_bed$|portal|gateway|bedrock/.test(b.name)
  const gTop = (c, G) => { for (let y = G + 1; y >= G - 2; y--) { if (solidOk(at(c.x, y - 1, c.z)) && !isSolid(at(c.x, y, c.z))) return y } return null }
  const why = {}
  const no = k => { why[k] = (why[k] || 0) + 1 }
  const { B, u, G } = plan
  let best = null
  const pend = []
  // Стороны окопа: для L0 — напротив станции L (−u); для C (взлёт) — любая, кроме +u.
  const sideList = sides || [{ x: -u.x, z: -u.z }]
  for (const nu of sideList) {
  for (const d0 of [2, 3]) {
    const F0 = addc(B, nu, d0); const V0 = addc(B, nu, 1)
    const gF = gTop(F0, G)
    if (gF == null || gF > G || gF < G - 1) { no('под изножьем L0'); continue }
    const gV = gTop(V0, G)
    if (gV == null || gV > G) { no('просвет L0'); continue }
    for (const a0 of DIRS4) {
      if (a0.x * nu.x + a0.z * nu.z !== 0) continue
      const H0 = addc(F0, a0); const W0 = addc(H0, nu, -1); const PS0 = addc(F0, a0, -2)
      const gW = gTop(W0, G)
      if (gW == null || gW > G) { no('заслон L0: земля'); continue }
      const gPS = gTop(PS0, G)
      if (gPS == null || Math.abs(gPS - G) > 1 || !isAirish(at(PS0.x, gPS + 1, PS0.z))) { no('место ставки L0'); continue }
      if ([F0, W0, V0, PS0, H0].some(c => nearPortal(new Vec3(c.x + 0.5, G, c.z + 0.5)))) { no('чаша портала'); continue }
      for (const lift0 of [2, 1]) {
        const yb0 = G + lift0
        if (d0 === 3 && [0, 1, 2].slice(0, lift0 + 1).some(k => !isAirish(at(B.x + nu.x * 2, G + k, B.z + nu.z * 2)))) { no('вид L0 закрыт'); continue }
        if ([...Array(lift0 + 1).keys()].some(k => !isAirish(at(V0.x, G + k, V0.z)))) { no('просвет L0 закрыт'); continue }
        if (!bedCellFree(at(H0.x, yb0, H0.z)) || !bedCellFree(at(F0.x, yb0, F0.z))) { no('клетки кровати L0'); continue }
        // мишень: тик i0 ≤ n − 13, голова над H0 (гориз. ≤ 1.6), низ головы выше центра взрыва на 0.2…1.8
        const cen0 = new Vec3(H0.x + 0.5, yb0 + 0.5, H0.z + 0.5)
        let tgt = null
        const iHi = imax != null ? imax : fc.n - 13; const iLo = imin != null ? imin : Math.max(0, fc.n - 26)
        for (let i0 = iHi; i0 >= iLo; i0--) {
          const st = fc.path[i0]; if (!st) continue
          const hh = Math.hypot(st.head.x - cen0.x, st.head.z - cen0.z); const dy = st.head.y - cen0.y
          if (hh > 1.6 || dy < 0.2 || dy > 1.8) continue
          const dist = st.head.distanceTo(cen0)
          if (!tgt || dist < tgt.dist) tgt = { i0, dist, head: st.head }
        }
        if (!tgt) { no('голова L0 не над станцией'); continue }
        // кровать L0 не в коробках снижающегося до её тика
        const bb = { min: new Vec3(Math.min(F0.x, H0.x), yb0, Math.min(F0.z, H0.z)), max: new Vec3(Math.max(F0.x, H0.x) + 1, yb0 + BED_TOP, Math.max(F0.z, H0.z) + 1) }
        let hitBed = false
        for (const st of fc.path) {
          if (st.k > tgt.i0 + 1) break
          if (overlap(bb, inflate(box(st.head.x, st.head.y, st.head.z, 0.5, 1), 0.15)) || overlap(bb, inflate(box(st.neck.x, st.neck.y, st.neck.z, 1.5, 3), 0.15))) { hitBed = true; break }
        }
        if (hitBed) { no('кровать L0 на пути головы'); continue }
        // мир «как будет»: обе станции + окоп
        const sCells = []; for (let y = gF; y < yb0; y++) sCells.push(y)
        const wCells = []; for (let y = gW; y <= G + lift0; y++) wCells.push(y)
        if ([...sCells.map(y => at(F0.x, y, F0.z)), ...wCells.map(y => at(W0.x, y, W0.z))].some(b => !(isAirish(b) || solidOk(b)))) { no('клетки опоры/заслона L0'); continue }
        const ex = new Map(plan.world)
        for (const y of sCells) ex.set(`${F0.x},${y},${F0.z}`, 'block')
        for (const y of wCells) ex.set(`${W0.x},${y},${W0.z}`, 'block')
        const vb = virtualBot(bot, ex)
        const expo = exposure(vb, plan.trench, cen0)
        if (expo > 0.02) { no('взрыв L0 видит окоп'); continue }
        // взрыв L L ещё не был; мир на миг L0: кровать L стоит, кровать L0 уже убрана
        const exL = new Map(ex); exL.set(`${plan.F.x},${plan.yb},${plan.F.z}`, 'bed'); exL.set(`${plan.H.x},${plan.yb},${plan.H.z}`, 'bed')
        const vbL = virtualBot(bot, exL)
        // и взрыв L не видит окоп в мире со станцией L0
        if (exposure(vb, plan.trench, plan.centre) > 0.02) { no('взрыв L видит окоп при L0'); continue }
        const ex2 = new Map(exL); ex2.set(`${F0.x},${yb0},${F0.z}`, 'bed'); ex2.set(`${H0.x},${yb0},${H0.z}`, 'bed')
        const cp = tsClickPoint(virtualBot(bot, ex2), plan.trench.offset(0, EYE, 0), { F: F0, u: nu, yb: yb0 })
        if (!cp) { no('бок L0 не видно'); continue }
        const ground0 = new Vec3(PS0.x + 0.5, gPS, PS0.z + 0.5)
        if (!pick.faceAim(vb, new Vec3(F0.x, yb0 - 1, F0.z), new Vec3(0, 1, 0), { eye: ground0.offset(0, EYE, 0), avoid: [] })) { no('верх опоры L0 не видно'); continue }
        {
          const exB = new Map(plan.world); let bad = null
          const eyePS = ground0.offset(0, SNEAK_EYE, 0); const eyeB = new Vec3(B.x + 0.5, G + SNEAK_EYE, B.z + 0.5)
          for (const y of sCells) { const c = new Vec3(F0.x, y, F0.z); if (!fillPlaceable(virtualBot(bot, exB), c, eyePS)) { bad = 'опору L0 не поставить честно'; break } exB.set(`${F0.x},${y},${F0.z}`, 'block') }
          if (!bad) for (const y of wCells) { const c = new Vec3(W0.x, y, W0.z); const vv = virtualBot(bot, exB); if (!fillPlaceable(vv, c, eyePS) && !fillPlaceable(vv, c, eyeB)) { bad = 'заслон L0 не поставить честно'; break } exB.set(`${W0.x},${y},${W0.z}`, 'block') }
          if (bad) { no(bad); continue }
        }
        // Дорогие проверки (лучи взрыва по блокам, видимость дракона) — потом, по порядку
        // ожидания (oc8-19: перебор с лучами на каждую — 7 с без тиков, прогноз устарел).
        const expect1 = bedDamage(tgt.dist, 1)
        pend.push({ F: F0, H: H0, W: W0, V: V0, PS: PS0, u: nu, a: a0, G, yb: yb0, y: yb0, lift: lift0, sCells, wCells, ground: ground0, centre: cen0, dist: r1(tgt.dist), i0: tgt.i0, D: a0, vb, vbL, ex2, cost1: -expect1 + (sCells.length + wCells.length) * 1.5 })
      }
    }
  }
  }
  pend.sort((p, q) => p.cost1 - q.cost1)
  for (const c of pend.slice(0, 4)) {
    // Кровать, взрывающаяся второй, переживает первый взрыв (лучи ServerExplosion).
    if (!primaryFirst && blastReaches(c.vbL, bot, c.centre, [{ x: plan.F.x, y: plan.yb, z: plan.F.z }, { x: plan.H.x, y: plan.yb, z: plan.H.z }])) { no('взрыв L0 снесёт кровать L'); continue }
    if (primaryFirst && blastReaches(virtualBot(bot, c.ex2), bot, plan.centre, [{ x: c.F.x, y: c.yb, z: c.F.z }, { x: c.H.x, y: c.yb, z: c.H.z }])) { no('первый взрыв снесёт вторую кровать'); continue }
    const seen = dpos ? dragonSeen(c.vb, c.centre, dpos) : 1
    const expect = bedDamage(c.dist, seen)
    const cost = -expect + (c.sCells.length + c.wCells.length) * 1.5
    if (!best || cost < best.cost) { const { vb, vbL, ex2, cost1, ...rest } = c; best = { ...rest, expect, seen: r1(seen), cost } }
    if (best && best.expect >= 40) break
  }
  tsSecond.why = why
  return best
}

// Какие блоки снесёт взрыв (худший случай — сила 1.3·P): ключи «x,y,z». Кровати (обе половины)
// и сам центр — тоже. Для «мира после взрыва»: что останется от заслонов и опор.
function blastDestroyed (vbot, bot, centre, power = 5) {
  const out = new Set()
  for (let i = 0; i < 16; i++) {
    for (let j = 0; j < 16; j++) {
      for (let k = 0; k < 16; k++) {
        if (!(i === 0 || i === 15 || j === 0 || j === 15 || k === 0 || k === 15)) continue
        let dx = i / 15 * 2 - 1; let dy = j / 15 * 2 - 1; let dz = k / 15 * 2 - 1
        const l = Math.sqrt(dx * dx + dy * dy + dz * dz); dx /= l; dy /= l; dz /= l
        let h = power * 1.3
        let x = centre.x; let y = centre.y; let z = centre.z
        while (h > 0) {
          const bx = Math.floor(x); const by = Math.floor(y); const bz = Math.floor(z)
          const b = vbot.blockAt(new Vec3(bx, by, bz))
          if (b && b.boundingBox !== 'empty') {
            h -= (blockRes(bot, b) + 0.3) * 0.3
            if (h > 0 && !/bedrock|obsidian|end_portal|gateway|barrier|respawn_anchor/.test(b.name)) out.add(`${bx},${by},${bz}`)
          }
          x += dx * 0.3; y += dy * 0.3; z += dz * 0.3
          h -= 0.225
        }
      }
    }
  }
  return out
}
// Клетки станции: кровать, опора, заслон.
function stationCells (st) {
  return [{ x: st.F.x, y: st.yb, z: st.F.z }, { x: st.H.x, y: st.yb, z: st.H.z }, ...(st.sCells || []).map(y => ({ x: st.F.x, y, z: st.F.z })), ...(st.wCells || []).map(y => ({ x: st.W.x, y, z: st.W.z }))]
}
// Мир станции (блоки и кровать) как Map для virtualBot.
function stationWorld (st, base = null, { bed = true } = {}) {
  const ex = new Map(base || [])
  for (const y of st.sCells || []) ex.set(`${st.F.x},${y},${st.F.z}`, 'block')
  for (const y of st.wCells || []) ex.set(`${st.W.x},${y},${st.W.z}`, 'block')
  if (bed) { ex.set(`${st.F.x},${st.yb},${st.F.z}`, 'bed'); ex.set(`${st.H.x},${st.yb},${st.H.z}`, 'bed') }
  return ex
}
// Ещё одна станция у уже выбранного окопа base.B (общий окоп — щелчки подряд без ходьбы).
// world — все наши блоки и кровати до этого щелчка (Map для virtualBot); prior — центры взрывов,
// которые будут ДО щелчка этой кровати (каждый не должен снести её клетки; мир после них — для
// проверки окопа и бока). cap/minExpect — по ожидаемому урону (видимость дракона — без своей
// кровати). sitP — сидячие коробки (checkWalls). Возвращает станцию с полем world (мир с ней).
function tsAddStation (bot, base, target, { fc = null, dpos = null, world, prior = [], cap = null, minExpect = 30, sitP = null, avoidCells = [], lifts = [1, 0, 2], radius = 3.8, protect = [] } = {}) {
  const why = {}
  const no = k => { why[k] = (why[k] || 0) + 1 }
  tsAddStation.why = why
  const avoid = new Set(avoidCells.map(q => `${q.x},${q.z}`))
  const cands = []
  for (const lift of lifts) {
    tsPlan(bot, target, { lift, fc, dpos, fixedB: base.B, avoid, extra: world, radius })
    for (const [k, v] of Object.entries(tsPlan.why || {})) why[k] = (why[k] || 0) + v
    cands.push(...(tsPlan.all || []))
  }
  if (!cands.length) { no('нет станции у окопа'); return null }
  let best = null
  for (const c of cands.filter(q => !q.psLift && q.depth === base.depth).sort((p, q) => q.expect - p.expect).slice(0, 12)) {
    if (sitP) {
      const bb = { min: new Vec3(Math.min(c.F.x, c.H.x), c.yb, Math.min(c.F.z, c.H.z)), max: new Vec3(Math.max(c.F.x, c.H.x) + 1, c.yb + 1, Math.max(c.F.z, c.H.z) + 1) }
      if (overlap(bb, inflate(sitP.head, 0.05)) || overlap(bb, inflate(sitP.neck, 0.05)) || overlap(bb, inflate(sitP.body, 0.05))) { no('кровать в сидячих коробках'); continue }
    }
    const cells = [{ x: c.F.x, y: c.yb, z: c.F.z }, { x: c.H.x, y: c.yb, z: c.H.z }, ...c.sCells.map(y => ({ x: c.F.x, y, z: c.F.z })), ...c.wCells.map(y => ({ x: c.W.x, y, z: c.W.z }))]
    const mine = stationWorld(c, world)
    // наш взрыв не сносит то, что взорвётся позже (protect — клетки кроватей/опор/заслонов)
    if (protect.length && blastReaches(virtualBot(bot, mine), bot, c.centre, protect)) { no('снесёт следующую'); continue }
    // по порядку взрывов: каждый не сносит наши клетки; мир после — снесённое воздух
    let post = new Map(mine); let bad = null
    for (const pr of prior) {
      const vb = virtualBot(bot, post)
      if (blastReaches(vb, bot, pr.centre, cells)) { bad = 'прежний взрыв снесёт'; break }
      const des = blastDestroyed(vb, bot, pr.centre)
      post = new Map(post)
      for (const k of des) post.set(k, 'air')
      if (pr.F) { post.set(`${pr.F.x},${pr.yb},${pr.F.z}`, 'air'); post.set(`${pr.H.x},${pr.yb},${pr.H.z}`, 'air') }
    }
    if (bad) { no(bad); continue }
    for (let k = 1; k <= base.depth; k++) post.set(`${base.B.x},${base.G - k},${base.B.z}`, 'air')
    const vPost = virtualBot(bot, post)
    if (exposure(vPost, base.trench, c.centre) > 0.02) { no('после прежних окоп открыт'); continue }
    if (!tsClickPoint(vPost, base.trench.offset(0, EYE, 0), c)) { no('после прежних бок не видно'); continue }
    const noBed = new Map(post); noBed.set(`${c.F.x},${c.yb},${c.F.z}`, 'air'); noBed.set(`${c.H.x},${c.yb},${c.H.z}`, 'air')
    const seen = dpos ? dragonSeen(virtualBot(bot, noBed), c.centre, dpos) : (c.seen || 1)
    const expect = bedDamage(c.centre.distanceTo(target), seen)
    if (cap != null && expect > cap) { no('больше потолка'); continue }
    if (expect < minExpect) { no('мала'); continue }
    const score = expect - (c.sCells.length + c.wCells.length) * 1.5
    if (!best || score > best.score) best = { ...c, expect, seen: Math.round(seen * 100) / 100, score, world: mine }
  }
  return best
}
// Станция в своём окопе у мишени target (общий случай): world — наши блоки и кровати к моменту
// её стройки; priors — станции, взрывы которых будут ДО её щелчка (по порядку: её клетки целы,
// земля окопа и просвета не в воронке; мир после них — для окопа/бока/видимости); protect —
// клетки станций, которые взорвутся ПОСЛЕ (её взрыв их не сносит); avoid — станции, на чьи
// клетки и окопы нельзя.
function tsOwnStation (bot, target, { fc = null, dpos = null, world = new Map(), priors = [], protect = [], avoid = [], cap = null, minExpect = 30, sitP = null, lifts = [1, 0, 2], radius = 3.2 } = {}) {
  const why = {}
  const no = k => { why[k] = (why[k] || 0) + 1 }
  tsOwnStation.why = why
  const av = new Set()
  for (const st of avoid) for (const q of [st.F, st.W, st.V, st.PS, st.H, st.B]) av.add(`${q.x},${q.z}`)
  const cands = []
  for (const lift of lifts) {
    tsPlan(bot, target, { lift, fc, dpos, avoid: av, extra: world, radius })
    for (const [k, v] of Object.entries(tsPlan.why || {})) why[k] = (why[k] || 0) + v
    cands.push(...(tsPlan.all || []))
  }
  if (!cands.length) { no('нет станции'); return null }
  let best = null
  for (const c of cands.filter(q => !q.psLift && !av.has(`${q.B.x},${q.B.z}`)).sort((p, q) => q.expect - p.expect).slice(0, 14)) {
    if (sitP) {
      const bb = { min: new Vec3(Math.min(c.F.x, c.H.x), c.yb, Math.min(c.F.z, c.H.z)), max: new Vec3(Math.max(c.F.x, c.H.x) + 1, c.yb + 1, Math.max(c.F.z, c.H.z) + 1) }
      if (overlap(bb, inflate(sitP.head, 0.05)) || overlap(bb, inflate(sitP.neck, 0.05)) || overlap(bb, inflate(sitP.body, 0.05))) { no('кровать в сидячих коробках'); continue }
    }
    const cells = stationCells(c)
    const mine = stationWorld(c, world)
    if (protect.length && blastReaches(virtualBot(bot, mine), bot, c.centre, protect)) { no('снесёт следующую'); continue }
    let post = new Map(mine); let bad = null
    const ground = [{ x: c.B.x, y: c.G - 1, z: c.B.z }, { x: c.B.x, y: c.G - 1 - c.depth, z: c.B.z }, { x: c.V.x, y: c.G - 1, z: c.V.z }]
    for (const pr of priors) {
      const vb = virtualBot(bot, post)
      if (blastReaches(vb, bot, pr.centre, cells)) { bad = 'прежний взрыв снесёт'; break }
      const des = blastDestroyed(vb, bot, pr.centre)
      if (ground.some(q => des.has(`${q.x},${q.y},${q.z}`))) { bad = 'окоп в воронке'; break }
      post = new Map(post)
      for (const k of des) post.set(k, 'air')
      post.set(`${pr.F.x},${pr.yb},${pr.F.z}`, 'air'); post.set(`${pr.H.x},${pr.yb},${pr.H.z}`, 'air')
    }
    if (bad) { no(bad); continue }
    for (let k = 1; k <= c.depth; k++) post.set(`${c.B.x},${c.G - k},${c.B.z}`, 'air')
    const vPost = virtualBot(bot, post)
    if (exposure(vPost, c.trench, c.centre) > 0.02) { no('после прежних окоп открыт'); continue }
    if (!tsClickPoint(vPost, c.trench.offset(0, EYE, 0), c)) { no('после прежних бок не видно'); continue }
    const noBed = new Map(post); noBed.set(`${c.F.x},${c.yb},${c.F.z}`, 'air'); noBed.set(`${c.H.x},${c.yb},${c.H.z}`, 'air')
    const seen = dpos ? dragonSeen(virtualBot(bot, noBed), c.centre, dpos) : (c.seen || 1)
    const expect = bedDamage(c.centre.distanceTo(target), seen)
    if (cap != null && expect > cap) { no('больше потолка'); continue }
    if (expect < minExpect) { no('мала'); continue }
    const score = expect - (c.sCells.length + c.wCells.length) * 1.5 - c.depth * 3
    const psSafe = !(sitP && hurtNear(playerBox(c.ground), sitP))
    if (!best || score > best.score) best = { ...c, expect, seen: Math.round(seen * 100) / 100, score, own: true, world: mine, psSafe }
  }
  return best
}
// ------------------------------------------------------------ станция у центрального столба
//
// Спидраннеры держат дракона в LANDING: кровать с изголовьем у бедрок-столба фонтана, взрыв на проходе
// головы (за ~12–15 тиков до «сел» голова проходит в p50 1.65 бл от «подушки» — 123 из 125 посадок,
// an-pillow.js), толчок взрыва уводит дракона, он заходит снова — новая кровать на то же место
// (an-landchain.js: одна неподвижная подушка на P − 1 рядом со столбом — ≥ 200 до «сел» в 33–39 из 40
// посадок по модели). Опора и укрытие — обсидиан (стойкость 1200, dragon_immune: ни взрыв, ни коробки
// дракона его не снесут) и сам столб. pillarPlan ищет: место бота (окоп за ободом, чаша, обод), клетку
// изножья F рядом с подушкой H, блок K (столб/обсидиан) с гранью к F, по которой кровать ставится С ТОГО
// ЖЕ места (направление кровати — по взгляду: горизонталь взгляда вдоль a = H − F), видимую грань F для
// щелчка, и обсидиан-заслоны так, чтобы взрыв в H видел ≤ 2 % точек коробки бота. Всё — на «мире как будет».
const OBS = 'obsidian'
const OBS_ANY = /^(obsidian|crying_obsidian)$/
function pillarCells (P) {
  // столб (0,0) от P − 4 до P − 1; факелы на P − 2 по 4 сторонам
  return { pillar: [0, 1, 2, 3].map(k => ({ x: 0, y: P - 4 + k, z: 0 })), torches: [[1, 0], [-1, 0], [0, 1], [0, -1]].map(([x, z]) => ({ x, y: P - 2, z })) }
}
// Точка на грани блока blockPos (нормаль face), видимая из eye: первым на луче — этот блок.
// ND_PILLAR_REACH — дальность щелчка (4.3; у клиента ванили 4.5 — больше не брать: честная игра)
function faceClick (vbot, eye, blockPos, face, { reach = Math.min(4.5, envNum('ND_PILLAR_REACH', 4.3)), avoidTorch = null } = {}) {
  const ax = face.x ? 'x' : face.y ? 'y' : 'z'
  const plane = blockPos[ax] + (face[ax] > 0 ? 1.001 : -0.001)
  const us = ax === 'x' ? ['y', 'z'] : ax === 'y' ? ['x', 'z'] : ['x', 'y']
  const isBed = vbot.blockAt(blockPos) && /_bed$/.test(vbot.blockAt(blockPos).name || '')
  for (const [a, b] of [...(runnerOn() ? [[0.5, 0.01], [0.5, 0.99], [0.01, 0.5], [0.99, 0.5]] : []), [0.5, 0.5], [0.3, 0.3], [0.7, 0.3], [0.3, 0.7], [0.7, 0.7], [0.5, 0.2], [0.5, 0.8], [0.2, 0.5], [0.8, 0.5]]) {
    const pt = { x: 0, y: 0, z: 0 }; pt[ax] = plane; pt[us[0]] = blockPos[us[0]] + a; pt[us[1]] = blockPos[us[1]] + b
    // у кровати бок — только нижние 0.56
    if (isBed && ax !== 'y' && pt.y - blockPos.y > 0.5) pt.y = blockPos.y + 0.3
    if (isBed && ax === 'y' && face.y > 0) pt.y = blockPos.y + 0.5635
    const P0 = new Vec3(pt.x, pt.y, pt.z)
    const dv = P0.minus(eye); const len = dv.norm()
    if (len > reach || len < 0.4) continue
    if (dv.x * face.x + dv.y * face.y + dv.z * face.z >= 0) continue
    const d = dv.scaled(1 / len)
    const hit = pick.blockOnRay(vbot, eye, d, len + 0.05)
    if (!hit || !hit.pos.equals(blockPos)) continue
    if (avoidTorch && avoidTorch(eye, d, len)) continue
    return { point: P0, dir: d, len }
  }
  return null
}
// Точка на грани для ставки кровати (R, 02.10): изголовье сервер кладёт по горизонтали взгляда (BedBlock.getStateForPlacement
// ← context.getHorizontalDirection), а faceClick в R брал край грани K у бота — взгляд ~44° к оси F→H: сдвиг ног на 0.01–0.1
// поворачивал кровать к опоре K (изголовье в обсидиан — ставка не проходит). rs1: 14 из 25 ставок+щелчков без взрыва;
// fr1: 30 из 70. Здесь — видимая точка с наибольшим запасом по углу к want (единичный горизонтальный F→H), cos ≥ minCos.
function faceClickFacing (vbot, eye, blockPos, face, want, { reach = Math.min(4.5, envNum('ND_PILLAR_REACH', 4.3)), minCos = 0.8 } = {}) {
  const ax = face.x ? 'x' : face.y ? 'y' : 'z'
  const plane = blockPos[ax] + (face[ax] > 0 ? 1.001 : -0.001)
  const us = ax === 'x' ? ['y', 'z'] : ax === 'y' ? ['x', 'z'] : ['x', 'y']
  let best = null
  for (const a of [0.15, 0.3, 0.5, 0.7, 0.85]) {
    for (const b of [0.05, 0.2, 0.35, 0.5, 0.65, 0.8, 0.95]) {
      const pt = { x: 0, y: 0, z: 0 }; pt[ax] = plane; pt[us[0]] = blockPos[us[0]] + a; pt[us[1]] = blockPos[us[1]] + b
      const P0 = new Vec3(pt.x, pt.y, pt.z)
      const dv = P0.minus(eye); const len = dv.norm()
      if (len > reach || len < 0.4) continue
      if (dv.x * face.x + dv.y * face.y + dv.z * face.z >= 0) continue
      const h = Math.hypot(dv.x, dv.z); if (h < 1e-6) continue
      const cos = (dv.x * want.x + dv.z * want.z) / h
      if (cos < minCos || (best && cos <= best.cos)) continue
      const d = dv.scaled(1 / len)
      const hit = pick.blockOnRay(vbot, eye, d, len + 0.05)
      if (!hit || !hit.pos.equals(blockPos)) continue
      best = { point: P0, dir: d, len, cos }
    }
  }
  return best
}
// dy — высота подушки над верхом столба P (01.10): −1 — рядом с верхним блоком столба (как было), 0 — над ним (на опоре
// из обсидиана, приставленной к верхнему блоку столба): видимость дракона из взрыва ~1 вместо ~0.8, голова ближе.
// ND_RUNNER (по умолчанию вкл., =0 — выкл.): та же геометрия R в лаборатории и полном бою.
function runnerPlan (bot, P) {
  const options = []
  const why = {}; const no = k => { why[k] = (why[k] || 0) + 1 }
  runnerPlan.why = why
  // Ноги сдвинуты к опоре K (02.10, rs2: на P + 1 видна только ближняя к боту кромка грани K — булыжник под F закрывает
  // остальное; из середины клетки взгляд на неё ~40–45° к оси F→H, изголовье уходило в K — «K 1: грань не видно» при
  // запасе cos ≥ 0.8). Сдвиг 0.2 к K: взгляд ~29°, запас 16°.
  for (const s of [-1, 1]) for (const side of [-1, 1]) for (const shift of (RUN_FACING() ? [0.3, 0.2, 0.12, 0] : [0])) {
    if (options.length) break
    const feet = new Vec3(0.5 + shift * side, P - 4, 2 * s + 0.5)
    if ((bot.blockAt(feet.offset(0, -1, 0)) || {}).name !== 'bedrock' || !isAirish(bot.blockAt(feet)) || !isAirish(bot.blockAt(feet.offset(0, 1, 0)))) { no(`чаша ${s}: ${(bot.blockAt(feet.offset(0, -1, 0)) || {}).name}/${(bot.blockAt(feet) || {}).name}/${(bot.blockAt(feet.offset(0, 1, 0)) || {}).name}`); continue }
    const baseCells = [[side, P - 1, 0, OBS], [side, P - 1, s, OBS], [side, P, s, OBS], [side, P + 1, s, OBS]]
    const torch = [0, P - 2, s, 'air'] // снять факел при подготовке, прежде чем занимать чашу
    const cells = [...baseCells, torch]
    const busy = baseCells.find(c => { const b = bot.blockAt(new Vec3(...c.slice(0, 3))); return !(isAirish(b) || (b && OBS_ANY.test(b.name))) })
    if (busy) { no(`занято ${busy.slice(0, 3).join(',')}: ${(bot.blockAt(new Vec3(...busy.slice(0, 3))) || {}).name}`); continue }
    const w = new Map([...baseCells, torch].map(c => [c.slice(0, 3).join(','), c[3] === 'air' ? 'air' : 'block']))
    const levels = []
    for (const dy of [0, 1]) {
      const yb = P + dy, H = { x: 0, y: yb, z: 0 }, F = { x: 0, y: yb, z: s }
      const world = new Map(w)
      if (dy) world.set(`0,${P},${s}`, 'block') // расходный блок под изножьем
      const K = new Vec3(side, yb, s), face = new Vec3(-side, 0, 0), eye = feet.offset(0, EYE, 0)
      const place = RUN_FACING() ? faceClickFacing(virtualBot(bot, world), eye, K, face, { x: 0, z: -s }) : faceClick(virtualBot(bot, world), eye, K, face)
      if (!place || Math.abs(place.dir.z) <= Math.abs(place.dir.x) || Math.sign(place.dir.z) !== -s) { no(`K ${dy}: ${place ? 'не вдоль' : 'грань не видно'}`); break }
      const centre = new Vec3(0.5, yb + 0.5, 0.5)
      const vb = virtualBot(bot, world), expo = exposure(vb, feet, centre)
      if (expo > 0.02 || lowRowsOpen(vb, feet, centre)) { no(`открыто ${dy}: ${r1(expo * 100) / 100}`); break }
      const wb = new Map(world); wb.set(`0,${yb},0`, 'bed'); wb.set(`0,${yb},${s}`, 'bed')
      const clickFace = new Vec3(0, 0, s), hit = faceClick(virtualBot(bot, wb), eye, new Vec3(0, yb, s), clickFace)
      if (!hit) { no(`бок кровати ${dy}`); break }
      levels.push({ P, H, F, a: { x: 0, z: -s }, yb, centre, B: { x: 0, z: 2 * s }, feet, G: P - 4, dig: 0,
        place: { K: { x: side, y: yb, z: s }, face, point: place.point, obsidian: false },
        click: { cell: F, face: clickFace, point: hit.point, len: hit.len }, obs: [], sup: [], supCob: [], nObs: 4,
        seen: dragonSeen(vb, centre, new Vec3(0.5, P, 0.5)), expo, runner: true, cells })
    }
    if (levels.length === 2) { const p = levels[0]; p.runnerLevels = levels; p.labExtra = cells; options.push(p) }
  }
  return options[0] || null
}

function runnerAim (bot, point) {
  const d = point.minus(bot.entity.position.offset(0, EYE, 0))
  bot.entity.yaw = Math.atan2(-d.x, -d.z)
  bot.entity.pitch = Math.atan2(d.y, Math.hypot(d.x, d.z))
  bot._client.write('look', { yaw: Math.atan2(-d.x, d.z) * 180 / Math.PI, pitch: -bot.entity.pitch * 180 / Math.PI,
    onGround: bot.entity.onGround, flags: { onGround: bot.entity.onGround, hasHorizontalCollision: false } })
}

// Честная подготовка расходной опоры; завершить/подтвердить ДО окна bed+click.
async function runnerSupport (bot, plan, dy) {
  const why = w => { runnerSupport.why = w; return false }
  runnerSupport.why = null
  const pos = new Vec3(0, plan.P, plan.F.z), b = bot.blockAt(pos)
  if (!dy) {
    if (isAirish(b)) return true
    if (!b || b.name !== 'cobblestone') return why(`снять: там ${b && b.name}`)
    const eye = bot.entity.position.offset(0, EYE, 0)
    const hit = faceClick(bot, eye, pos, new Vec3(0, 0, Math.sign(plan.B.z)))
    const tool = findItem(bot, /^(iron|diamond|netherite)_pickaxe$/)
    if (!hit || !tool) return why(!hit ? 'снять: грань не видно' : 'нет кирки')
    await bot.equip(tool, 'hand')
    if (bot.digTime(b) > 650) return why(`снять: долго ${bot.digTime(b)}`)
    runnerAim(bot, hit.point)
    const stop = gameClock.setTimeout(() => bot.stopDigging(), 800)
    try { await bot.dig(b, true) } catch (e) { return why('снять: ' + e.message) } finally { gameClock.clearTimeout(stop) }
    return isAirish(bot.blockAt(pos)) || why('снять: осталась')
  }
  if (b && b.name === 'cobblestone') return true
  if (!isAirish(b)) return why(`поставить: там ${b && b.name}`)
  const low = plan.runnerLevels[0], K = new Vec3(low.place.K.x, plan.P, low.place.K.z)
  const hit = faceClick(bot, bot.entity.position.offset(0, EYE, 0), K, low.place.face)
  const item = findItem(bot, /^cobblestone$/)
  if (!hit || !item) return why(!hit ? 'поставить: грань K0 не видно' : 'нет булыжника')
  await bot.equip(item, 'hand'); runnerAim(bot, hit.point)
  const pc = hit.point.minus(K)
  bot._client.write('block_place', { location: K, direction: FACE_IDX(low.place.face), hand: 0,
    cursorX: pc.x, cursorY: pc.y, cursorZ: pc.z, insideBlock: false, sequence: 0, worldBorderHit: false })
  const end = gameClock.now() + 400
  while (gameClock.now() < end && (bot.blockAt(pos) || {}).name !== 'cobblestone') await sleep(20)
  if ((bot.blockAt(pos) || {}).name === 'cobblestone') return true
  const dd = dragonOf(bot)
  return why(`поставить: не встал${dd ? ` (тело ${r1(dd.position.x)},${r1(dd.position.y)},${r1(dd.position.z)})` : ''}`)
}

function pillarPlan (bot, P, { maxObs = 6, pillow = null, dy = PILLOW_DY, aOnly = null } = {}) {
  const why = {}
  const no = k => { why[k] = (why[k] || 0) + 1 }
  pillarPlan.why = why
  const at = (x, y, z) => bot.blockAt(new Vec3(x, y, z))
  const { torches } = pillarCells(P)
  const torchSet = new Set(torches.map(t => `${t.x},${t.y},${t.z}`))
  // луч через клетку факела — прицел клиента зацепит факел: такие лучи не годятся
  const torchHit = (eye, d, len) => { for (let t = 0; t < len; t += 0.1) { const q = eye.plus(d.scaled(t)); if (torchSet.has(`${Math.floor(q.x)},${Math.floor(q.y)},${Math.floor(q.z)}`)) return true } return false }
  const yb = P + dy
  const pillows = pillow ? [pillow] : [{ x: 1, z: 0 }, { x: -1, z: 0 }, { x: 0, z: 1 }, { x: 0, z: -1 }]
  const out = []
  for (const Hc of pillows) {
    const H = { x: Hc.x, y: yb, z: Hc.z }
    if (!isAirish(at(H.x, yb, H.z))) { no('подушка занята'); continue }
    for (const a of DIRS4) {
      if (aOnly && (a.x !== aOnly.x || a.z !== aOnly.z)) continue
      const F = { x: H.x - a.x, y: yb, z: H.z - a.z }
      if (F.x === 0 && F.z === 0) continue
      if (!isAirish(at(F.x, yb, F.z))) { no('изножье занято'); continue }
      const centre = new Vec3(H.x + 0.5, yb + 0.5, H.z + 0.5)
      // подушка над столбом: опора под изголовьем — обсидиан к боку верхнего блока столба (не висит)
      // опора под изголовьем — столбиком от яруса верхнего блока столба (P − 1) до yb − 1
      const sup = []
      for (let y = P - 1; y <= yb - 1; y++) sup.push([H.x, y, H.z])
      if (sup.some(c => !(isAirish(at(...c)) || isSolid(at(...c))))) { no('под подушкой занято'); continue }
      const uA = { x: a.z, z: -a.x }
      const Ks = [{ c: { x: F.x - a.x, y: yb, z: F.z - a.z }, n: { x: a.x, y: 0, z: a.z } }, { c: { x: F.x + uA.x, y: yb, z: F.z + uA.z }, n: { x: -uA.x, y: 0, z: -uA.z } }, { c: { x: F.x - uA.x, y: yb, z: F.z - uA.z }, n: { x: uA.x, y: 0, z: uA.z } }, { c: { x: F.x, y: yb - 1, z: F.z }, n: { x: 0, y: 1, z: 0 } }]
      // над столбом опора под изножьем держится за опору под изголовьем (не висит) — её первой
      if (dy >= 0) Ks.unshift(Ks.pop())
      // ND_PILLAR_K=above — опора над изножьем (клик по нижней грани, видна из окопа): боковая опора на ярусе кровати
      // закрывает от взрыва коробку дракона — в лаборатории 02.10 seen < 0.95 у 29 % взрывов, −8 урона (обсидиан r 2 на ярусе
      // кровати — главный заслон). above — только эта опора.
      if (envv('ND_PILLAR_K') === 'above') Ks.splice(0, Ks.length, { c: { x: F.x, y: yb + 1, z: F.z }, n: { x: 0, y: -1, z: 0 } })
      for (let bx = -6; bx <= 6; bx++) {
        for (let bz = -6; bz <= 6; bz++) {
          const r2 = bx * bx + bz * bz
          if (r2 < 1 || r2 > 40) continue
          // окоп — на стороне подушки (151 из 151 построенных станций st2–hb7): вдвое меньше перебора — план считался
          // синхронно p50 1.8 с, p90 5.8 с, до 14 с под нагрузкой фермы, и тело стояло в облаке (st5-s7: 12.5 с без пакетов)
          // ND_PILLAR_SIDE=1 — окоп сбоку от подушки (поперёк): дракон заходит от узла напротив бота, голова проходит мимо
          // подушки, а не над ней (Codex dragon-blast lab2: боковые клетки P+1 — ≥50 в 28.6 % проходов против 8.9 % со стороны окопа)
          if (envv('ND_PILLAR_SIDE') === '1') { if (Math.abs(bx * Hc.x + bz * Hc.z) > 1 || Math.abs(bx * Hc.z - bz * Hc.x) < 3) continue } else if (bx * Hc.x + bz * Hc.z <= 0) continue
          const s0 = surfaceY(bot, bx + 0.5, bz + 0.5, P + 2)
          if (!s0) continue
          const feetOpts = [{ y: s0.y, dig: 0 }]
          const diggable = y => /end_stone|cobble|stone|dirt|netherrack/.test((at(bx, y, bz) || {}).name || '')
          if (diggable(s0.y - 1)) { feetOpts.push({ y: s0.y - 1, dig: 1 }); if (diggable(s0.y - 2) && diggable(s0.y - 3)) { feetOpts.push({ y: s0.y - 2, dig: 2 }); if (diggable(s0.y - 4)) feetOpts.push({ y: s0.y - 3, dig: 3 }) } }
          for (const fo of feetOpts) {
            // голова/шея/крыло на снижении не достают: макушка ≤ P − 2.6
            if (fo.y + 1.8 > P - envNum('ND_PILLAR_HEADROOM', HEAD_ROOM)) { no('высоко (голова/крыло)'); continue }
            if (Math.hypot(bx - F.x, bz - F.z) < 1.2) continue
            const base = new Map()
            for (let k = 1; k <= fo.dig; k++) base.set(`${bx},${s0.y - k},${bz}`, 'air')
            for (const c of sup) base.set(c.join(','), 'block')
            const feet = new Vec3(bx + 0.5, fo.y, bz + 0.5)
            const eye = feet.offset(0, EYE, 0)
            let place = null
            for (const K of Ks) {
              const kb = at(K.c.x, K.c.y, K.c.z)
              const isPillar = K.c.x === 0 && K.c.z === 0 && K.c.y >= P - 4 && K.c.y <= P - 1
              if (!isPillar && !(isAirish(kb) || (kb && OBS_ANY.test(kb.name)))) continue
              if (torchSet.has(`${K.c.x},${K.c.y},${K.c.z}`)) continue
              const w = new Map(base); if (!isPillar) w.set(`${K.c.x},${K.c.y},${K.c.z}`, 'block')
              const vb = virtualBot(bot, w)
              const fcl = faceClick(vb, eye, new Vec3(K.c.x, K.c.y, K.c.z), new Vec3(K.n.x, K.n.y, K.n.z), { avoidTorch: torchHit })
              if (!fcl) continue
              const hx = fcl.dir.x; const hz = fcl.dir.z
              const dom = Math.abs(hx) >= Math.abs(hz) ? { x: Math.sign(hx), z: 0 } : { x: 0, z: Math.sign(hz) }
              if (dom.x !== a.x || dom.z !== a.z) continue
              place = { K: K.c, face: new Vec3(K.n.x, K.n.y, K.n.z), point: fcl.point, obsidian: !isPillar && !(kb && OBS_ANY.test(kb.name)) }
              break
            }
            if (!place) { no('кровать с места не поставить'); continue }
            const w1 = new Map(base); if (place.obsidian) w1.set(`${place.K.x},${place.K.y},${place.K.z}`, 'block')
            w1.set(`${F.x},${yb},${F.z}`, 'bed'); w1.set(`${H.x},${yb},${H.z}`, 'bed')
            let click = null
            for (const f of [{ x: 1, y: 0, z: 0 }, { x: -1, y: 0, z: 0 }, { x: 0, y: 0, z: 1 }, { x: 0, y: 0, z: -1 }, { x: 0, y: -1, z: 0 }]) {
              for (const cell of [F, H]) {
                const c = faceClick(virtualBot(bot, w1), eye, new Vec3(cell.x, yb, cell.z), new Vec3(f.x, f.y, f.z), { avoidTorch: torchHit })
                if (c) { click = { cell, face: f, point: c.point, len: c.len }; break }
              }
              if (click) break
            }
            if (!click) { no('кровать с места не видно'); continue }
            const wS = new Map(base); if (place.obsidian) wS.set(`${place.K.x},${place.K.y},${place.K.z}`, 'block')
            const keep = new Set([`${F.x},${yb},${F.z}`, `${H.x},${yb},${H.z}`, `${place.K.x},${place.K.y},${place.K.z}`])
            for (let y = fo.y; y <= fo.y + 2; y++) keep.add(`${bx},${y},${bz}`)
            const sightCells = new Set()
            for (const pt of [place.point, click.point]) { const dv = pt.minus(eye); const L = dv.norm(); for (let t = 0; t <= L; t += 0.05) { const q = eye.plus(dv.scaled(t / L)); sightCells.add(`${Math.floor(q.x)},${Math.floor(q.y)},${Math.floor(q.z)}`) } }
            const obs = []
            let expo = exposure(virtualBot(bot, wS), feet, centre)
            while (expo > 0.02 && obs.length < maxObs) {
              const count = new Map()
              const vS = virtualBot(bot, wS)
              for (const fy of SEEN_Y5) for (const ox of SEEN_XZ) for (const oz of SEEN_XZ) {
                const p0 = new Vec3(feet.x + ox, feet.y + fy, feet.z + oz)
                const dv = centre.minus(p0); const L = dv.norm()
                if (pick.blockOnRay(vS, p0, dv.scaled(1 / L), L - 0.02)) continue
                const seen = new Set()
                for (let t = 0.3; t < L - 0.3; t += 0.1) {
                  const q = p0.plus(dv.scaled(t / L)); const k = `${Math.floor(q.x)},${Math.floor(q.y)},${Math.floor(q.z)}`
                  if (seen.has(k) || keep.has(k) || sightCells.has(k)) continue
                  seen.add(k)
                  const bq = vS.blockAt(new Vec3(Math.floor(q.x), Math.floor(q.y), Math.floor(q.z)))
                  if (!isAirish(bq) || torchSet.has(k)) continue
                  if (Math.floor(q.x) === 0 && Math.floor(q.z) === 0) continue
                  count.set(k, (count.get(k) || 0) + 1)
                }
              }
              // при равенстве — клетка с твёрдым соседом (ставится без лесов)
              const anchored = k => { const [x, y, z] = k.split(',').map(Number); return [[1, 0, 0], [-1, 0, 0], [0, 1, 0], [0, -1, 0], [0, 0, 1], [0, 0, -1]].some(([dx, dy, dz]) => isSolid(vS.blockAt(new Vec3(x + dx, y + dy, z + dz)))) }
              let bestK = null; let bestN = 0
              for (const [k, n] of count) { const sc = n + (anchored(k) ? 0.5 : 0); if (sc > bestN) { bestN = sc; bestK = k } }
              if (!bestK) break
              wS.set(bestK, 'block'); obs.push(bestK.split(',').map(Number))
              expo = exposure(virtualBot(bot, wS), feet, centre)
            }
            if (expo > 0.02) { no('заслоны не закрыли'); continue }
            if (!faceClick(virtualBot(bot, wS), eye, new Vec3(place.K.x, place.K.y, place.K.z), place.face, { avoidTorch: torchHit })) { no('заслон закрыл ставку'); continue }
            const wB = new Map(wS); wB.set(`${F.x},${yb},${F.z}`, 'bed'); wB.set(`${H.x},${yb},${H.z}`, 'bed')
            if (!faceClick(virtualBot(bot, wB), eye, new Vec3(click.cell.x, yb, click.cell.z), new Vec3(click.face.x, click.face.y, click.face.z), { avoidTorch: torchHit })) { no('заслон закрыл щелчок'); continue }
            const seenD = dragonSeen(virtualBot(bot, wS), centre, new Vec3(0.5, P, 0.5))
            const supNew = sup.filter((c, i) => !(i === sup.length - 1 ? OBS_ANY.test((at(c[0], c[1], c[2]) || {}).name || '') : isSolid(at(c[0], c[1], c[2]))))
            // у взрыва — только верхняя клетка опоры (обсидиан), нижние — булыжник (их снесёт, подушке не нужны)
            const supObs = supNew.slice(-1); const supCob = supNew.slice(0, -1)
            const nObs = obs.length + (place.obsidian ? 1 : 0) + supObs.length
            // висячие клетки (нужны леса: в pil4 «лес: не дошёл» — 2 боя без станции) — дороже
            const cellsAll = [...supNew, ...(place.obsidian ? [[place.K.x, place.K.y, place.K.z]] : []), ...obs]
            const solidAt = (x, y, z, w) => isSolid(virtualBot(bot, w).blockAt(new Vec3(x, y, z)))
            let floating = 0
            { const w = new Map(base); for (const c of supNew) w.delete(c.join(',')); for (const c of cellsAll) { const ok = [[1, 0, 0], [-1, 0, 0], [0, 1, 0], [0, -1, 0], [0, 0, 1], [0, 0, -1]].some(([dx, dy, dz]) => solidAt(c[0] + dx, c[1] + dy, c[2] + dz, w)); if (!ok) floating++; w.set(c.join(','), 'block') } }
            const cost = nObs * 2 + fo.dig * 1.5 - seenD * 10 + Math.hypot(bx, bz) * 0.2 + floating * 6
            out.push({ P, H, F, a, yb, centre, B: { x: bx, z: bz }, feet, dig: fo.dig, G: s0.y, place, click, obs, sup: supObs, supCob, nObs, floating, expo: r1(expo * 100) / 100, seen: r1(seenD * 100) / 100, cost })
          }
        }
      }
    }
  }
  out.sort((p, q) => p.cost - q.cost)
  pillarPlan.all = out
  return out[0] || null
}

// Кровать A заранее — СВОЙ окоп у головы сидящего (у окопа L места нет: станции окопа L в 3+ от
// головы — офлайн по 40 записанным посадкам, an-tkpair/simA2). Строится на снижении вместе с L
// (сперва L без окопа, потом A без окопа, потом окоп L); после L — из окопа L к окопу A (копать
// 1–2 блока под собой), щелчок через ≥ 10 тиков после L, в сидячий счёт (урон ≤ cap). Условия:
// A переживает взрыв L; в мире после L окоп A закрыт от взрыва A и бок A виден; кровать A — не в
// коробках снижающегося и сидящего; клетки A не на клетках станции L и её окопа.
function tsOwnPlan (bot, plan, fcL, { cap = null, dpos = null } = {}) {
  const why = {}
  const no = k => { why[k] = (why[k] || 0) + 1 }
  tsOwnPlan.why = why
  tsOwnPlan.small = []
  const target = fcL.head
  const exL = stationWorld(plan, plan.world)
  const avoid = new Set([plan.F, plan.W, plan.V, plan.PS, plan.H, plan.B].map(q => `${q.x},${q.z}`))
  const fcA = { ...fcL, n: fcL.n + 3 }
  const sitP = predParts(fcL)
  const cands = []
  for (const lift of [1, 0, 2]) {
    tsPlan(bot, target, { lift, fc: fcA, dpos, avoid, extra: exL, radius: 3.2 })
    for (const [k, v] of Object.entries(tsPlan.why || {})) why[k] = (why[k] || 0) + v
    cands.push(...(tsPlan.all || []))
  }
  if (!cands.length) { no('нет своей станции у головы'); return null }
  const vbL = virtualBot(bot, exL)
  const destroyed = blastDestroyed(vbL, bot, plan.centre)
  let best = null
  for (const c of cands.filter(q => !q.psLift && !avoid.has(`${q.B.x},${q.B.z}`)).sort((p, q) => q.expect - p.expect).slice(0, 14)) {
    const bb = { min: new Vec3(Math.min(c.F.x, c.H.x), c.yb, Math.min(c.F.z, c.H.z)), max: new Vec3(Math.max(c.F.x, c.H.x) + 1, c.yb + 1, Math.max(c.F.z, c.H.z) + 1) }
    if (overlap(bb, inflate(sitP.head, 0.05)) || overlap(bb, inflate(sitP.neck, 0.05)) || overlap(bb, inflate(sitP.body, 0.05))) { no('кровать A в коробках сидящего'); continue }
    // L не должна видеть окоп A? нет: в окопе A нас при L нет. Клетки A — целы после L.
    const cells = [{ x: c.F.x, y: c.yb, z: c.F.z }, { x: c.H.x, y: c.yb, z: c.H.z }, ...c.sCells.map(y => ({ x: c.F.x, y, z: c.F.z })), ...c.wCells.map(y => ({ x: c.W.x, y, z: c.W.z }))]
    const exBoth = stationWorld(c, exL)
    if (blastReaches(virtualBot(bot, exBoth), bot, plan.centre, cells)) { no('взрыв L снесёт A'); continue }
    // земля окопа A и просвета — не в воронке L
    const ground = [{ x: c.B.x, y: c.G - 1, z: c.B.z }, { x: c.B.x, y: c.G - 1 - c.depth, z: c.B.z }, { x: c.V.x, y: c.G - 1, z: c.V.z }]
    if (ground.some(q => destroyed.has(`${q.x},${q.y},${q.z}`))) { no('окоп A в воронке L'); continue }
    const post = new Map(exBoth)
    for (const k of destroyed) post.set(k, 'air')
    post.set(`${plan.F.x},${plan.yb},${plan.F.z}`, 'air'); post.set(`${plan.H.x},${plan.yb},${plan.H.z}`, 'air')
    for (const q of cells) post.set(`${q.x},${q.y},${q.z}`, q.y === c.yb && ((q.x === c.F.x && q.z === c.F.z) || (q.x === c.H.x && q.z === c.H.z)) ? 'bed' : 'block')
    for (let k = 1; k <= c.depth; k++) post.set(`${c.B.x},${c.G - k},${c.B.z}`, 'air')
    const vPost = virtualBot(bot, post)
    if (exposure(vPost, c.trench, c.centre) > 0.02) { no('после L окоп A открыт взрыву A'); continue }
    if (!tsClickPoint(vPost, c.trench.offset(0, EYE, 0), c)) { no('после L бок A не видно'); continue }
    if (!tsClickPoint(virtualBot(bot, exBoth), plan.trench.offset(0, EYE, 0), plan)) { no('A закрыла бок L'); continue }
    // видимость дракона из центра A — без самой кровати A (её убирают до взрыва)
    const noBed = new Map(post); noBed.set(`${c.F.x},${c.yb},${c.F.z}`, 'air'); noBed.set(`${c.H.x},${c.yb},${c.H.z}`, 'air')
    const seen = dpos ? dragonSeen(virtualBot(bot, noBed), c.centre, dpos) : (c.seen || 1)
    const expect = bedDamage(c.centre.distanceTo(target), seen)
    if (cap != null && expect > cap) { no('A больше потолка'); continue }
    if (expect < 30) { no('A мала'); (tsOwnPlan.small = tsOwnPlan.small || []).push({ d: r1(c.centre.distanceTo(target)), seen: r1(seen), e0: c.expect, lift: c.lift }); continue }
    const score = expect - (c.sCells.length + c.wCells.length) * 1.5 - c.depth * 3
    if (!best || score > best.score) best = { ...c, expect, seen: Math.round(seen * 100) / 100, score, role: 'A', own: true }
  }
  return best
}
// Кровать A заранее, у того же окопа, что L (темп, как у спидраннеров: кровати стоят до посадки,
// в нужный тик — только щелчок). Мишень — голова СИДЯЩЕГО после толчка L (fcL). Щелчок из окопа
// через ≥ 10 тиков после L — в сидячий счёт, поэтому урон ≤ cap (иначе сразу взлёт и второй
// кровати сидя не будет); cap = null — без потолка (одна кровать сидя: перенесённый счёт).
// Условия: A переживает взрыв L (лучи); в мире ПОСЛЕ взрыва L (снесённое — воздух) окоп закрыт
// от взрыва A (≤ 2 % точек) и бок A виден из окопа; кровать A не в коробках головы/шеи/тела ни
// на снижении, ни сидя (checkWalls сносит любой не-«dragon_immune» блок).
function tsAPlan (bot, plan, fcL, { cap = null, dpos = null } = {}) {
  const why = {}
  const no = k => { why[k] = (why[k] || 0) + 1 }
  tsAPlan.why = why
  const target = fcL.head
  const exL = stationWorld(plan, plan.world)
  const avoid = new Set([plan.F, plan.W, plan.V, plan.PS, plan.H].map(q => `${q.x},${q.z}`))
  // путь до самой посадки (n + 3: tsPlan проверяет до n − 3) — и сидячие коробки
  const fcA = { ...fcL, n: fcL.n + 3 }
  const sitP = predParts(fcL)
  const cands = []
  for (const lift of [1, 0, 2]) {
    tsPlan(bot, target, { lift, fc: fcA, dpos, fixedB: plan.B, avoid, extra: exL, radius: 3.8 })
    for (const [k, v] of Object.entries(tsPlan.why || {})) why[k] = (why[k] || 0) + v
    cands.push(...(tsPlan.all || []))
  }
  if (!cands.length) { no('нет станции у того же окопа'); return null }
  const vbL = virtualBot(bot, exL)
  const destroyed = blastDestroyed(vbL, bot, plan.centre)
  let best = null
  const dbgList = []
  tsAPlan.cands = dbgList
  const no0 = no
  for (const c of cands.filter(q => !q.psLift).sort((p, q) => q.expect - p.expect).slice(0, 10)) {
    const rec = { H: [c.H.x, c.yb, c.H.z], e0: c.expect, d: r1(c.centre.distanceTo(target)) }
    dbgList.push(rec)
    const no = k => { rec.why = k; no0(k) }
    const bb = { min: new Vec3(Math.min(c.F.x, c.H.x), c.yb, Math.min(c.F.z, c.H.z)), max: new Vec3(Math.max(c.F.x, c.H.x) + 1, c.yb + 1, Math.max(c.F.z, c.H.z) + 1) }
    if (overlap(bb, inflate(sitP.head, 0.05)) || overlap(bb, inflate(sitP.neck, 0.05)) || overlap(bb, inflate(sitP.body, 0.05))) { no('кровать A в коробках сидящего'); continue }
    const cells = [{ x: c.F.x, y: c.yb, z: c.F.z }, { x: c.H.x, y: c.yb, z: c.H.z }, ...c.sCells.map(y => ({ x: c.F.x, y, z: c.F.z })), ...c.wCells.map(y => ({ x: c.W.x, y, z: c.W.z }))]
    const exBoth = stationWorld(c, exL)
    if (blastReaches(virtualBot(bot, exBoth), bot, plan.centre, cells)) { no('взрыв L снесёт A'); continue }
    // мир после L: снесённое — воздух (станция A — цела по проверке выше)
    const post = new Map(exBoth)
    for (const k of destroyed) post.set(k, 'air')
    post.set(`${plan.F.x},${plan.yb},${plan.F.z}`, 'air'); post.set(`${plan.H.x},${plan.yb},${plan.H.z}`, 'air')
    for (const q of cells) post.set(`${q.x},${q.y},${q.z}`, q.y === c.yb && ((q.x === c.F.x && q.z === c.F.z) || (q.x === c.H.x && q.z === c.H.z)) ? 'bed' : 'block')
    const vPost = virtualBot(bot, post)
    if (exposure(vPost, plan.trench, c.centre) > 0.02) { no('после L окоп открыт взрыву A'); continue }
    if (!tsClickPoint(vPost, plan.trench.offset(0, EYE, 0), c)) { no('после L бок A не видно'); continue }
    // L по-прежнему видно и закрыто, когда стоит A
    if (!tsClickPoint(virtualBot(bot, exBoth), plan.trench.offset(0, EYE, 0), plan)) { no('A закрыла бок L'); continue }
    const noBed = new Map(post); noBed.set(`${c.F.x},${c.yb},${c.F.z}`, 'air'); noBed.set(`${c.H.x},${c.yb},${c.H.z}`, 'air')
    const seen = dpos ? dragonSeen(virtualBot(bot, noBed), c.centre, dpos) : (c.seen || 1)
    const expect = bedDamage(c.centre.distanceTo(target), seen)
    if (cap != null && expect > cap) { no('A больше потолка'); continue }
    if (expect < 25) { no('A мала'); continue }
    const score = expect - (c.sCells.length + c.wCells.length) * 1.5
    if (!best || score > best.score) best = { ...c, expect, seen: Math.round(seen * 100) / 100, score, role: 'A' }
  }
  return best
}

// Дойти до точки вокруг фонтана: прямая через чашу/столб (ближе 4.5 к центру) — по
// дуге r = 7.5; шаги клавишами (pathfinder у фонтана стоял по 4 с: oc3-25), не вышло — walkTo.
async function walkAround (session, ctl, target, { timeoutMs = 8000, stop = null } = {}) {
  const bot = session.bot
  const t0 = gameClock.now()
  const me = bot.entity.position
  const pts = []
  const segNear = (a, b) => segPoint2({ x: a.x, z: a.z }, { x: b.x, z: b.z }, CENTER)
  if (segNear(me, target) < 4.5) {
    const a0 = Math.atan2(me.z - CENTER.z, me.x - CENTER.x); const a1 = Math.atan2(target.z - CENTER.z, target.x - CENTER.x)
    const da = Math.atan2(Math.sin(a1 - a0), Math.cos(a1 - a0))
    const n = Math.max(1, Math.ceil(Math.abs(da) / 0.6))
    for (let k = 1; k < n; k++) { const a = a0 + da * k / n; pts.push(new Vec3(CENTER.x + Math.cos(a) * 7.5, target.y, CENTER.z + Math.sin(a) * 7.5)) }
  }
  pts.push(target)
  for (let i = 0; i < pts.length; i++) {
    if (ctl.aborted || gameClock.now() - t0 > timeoutMs) break
    const p = pts[i]
    const last = i === pts.length - 1
    const y = standY(bot, p.x, p.z, bot.entity.position.y, 3, 4)
    const q = new Vec3(p.x, y != null ? y : p.y, p.z)
    if (stop && stop()) break
    const r = await stepTo(bot, ctl, q, { ms: 2500, sprint: true, stopAt: last ? 0.3 : 1.0, stop })
    if (stop && stop()) break
    if (!r.ok && Math.hypot(bot.entity.position.x - q.x, bot.entity.position.z - q.z) > (last ? 0.6 : 2)) {
      await walkTo(session, ctl, q, { range: last ? 0.35 : 1.5, timeoutMs: Math.max(1500, timeoutMs - (gameClock.now() - t0)), hazards: true, stopIf: stop ? () => (stop() ? 'опасно' : null) : undefined })
    }
  }
  clearControls(bot)
  const m = bot.entity.position
  return { ok: Math.hypot(m.x - target.x, m.z - target.z) <= 0.6, why: gameClock.now() - t0 > timeoutMs ? 'не успел' : null }
}
// Стройка станции: опора F, заслон W, кровать с PS (взгляд вдоль a), окоп B.
async function tsBuild (session, ctl, stats, plan, danger = null, left = null, { skipTrench = false, onlyTrench = false, parts = null } = {}) {
  const bot = session.bot
  const v = (c, y) => new Vec3(c.x, y, c.z)
  const t0 = gameClock.now()
  const lap = {}
  const mark = k => { lap[k] = gameClock.now() - t0; doing(ctl, 'ts:' + k) }
  const risky = () => { const w = (gameClock.now() - lastDragonHit < 1500 ? 'удар дракона' : null) || (danger && danger()); if (w) { lap.danger = w; return true } return false }
  const res = r => { if (ctl.trace) ctl.trace.ev('tsBuild', { ok: r.ok, why: r.why, lap, role: plan.role || undefined, part: skipTrench ? 'стройка' : onlyTrench ? 'окоп' : undefined }); return r }
  const trench = async () => { const r = await tsTrench(bot, ctl, plan, mark, session); Object.assign(lap, r.lap || {}); delete r.lap; return res(r) }
  if (onlyTrench) return trench()
  mark('walk')
  if (risky()) return res({ ok: false, why: 'дракон рядом' })
  const low = plan.psLift ? new Vec3(plan.ground.x, plan.gPS, plan.ground.z) : plan.ground
  // Дракон сидит (parts) — идти в обход его коробок (bedsGo), а не дугой у фонтана.
  // Идти — пока не опасно: сел/крыло/голова рядом — стоп (see1-30: шёл к месту ставки L, дракон
  // сел, четыре удара головой на ходу — смерть).
  const walkStop = () => {
    if (gameClock.now() - lastDragonHit < 1500) return true
    const dd = dragonOf(bot)
    if (dd && SITTING.has(phaseOf(bot, dd))) { const pp = partsOf(bot, dd, null); if (hurtNear(playerBox(bot.entity.position), pp)) return true }
    return !!(danger && danger())
  }
  const g = parts ? await bedsGo(session, ctl, { feet: low, y: low.y, B: { x: Math.floor(low.x), z: Math.floor(low.z) }, lift: 0 }, true, parts()) : await walkAround(session, ctl, low, { timeoutMs: 7000, stop: walkStop })
  if (!g.ok) return res({ ok: false, why: `не дошёл до места ставки: ${g.why || ''}` })
  clearControls(bot)
  // Ставить с середины клетки: план проверял грани из неё (касательные взгляды с края — «грань
  // не видно», fin1).
  for (let k = 0; k < 3 && Math.hypot(bot.entity.position.x - low.x, bot.entity.position.z - low.z) > 0.12; k++) { await stepTo(bot, ctl, low, { ms: 600, sprint: false, stopAt: 0.06 }); clearControls(bot) }
  // Ставить стоя на земле: fin2-28 — опора и заслон ставились в прыжке (y 61.4→62.2, g 0),
  // грани из воздуха «не видно».
  const settle = async () => { clearControls(bot); for (let j = 0; j < 16 && !bot.entity.onGround; j++) await sleep(50) }
  await settle()
  if (plan.psLift) {
    if (risky()) return res({ ok: false, why: 'дракон рядом' })
    mark('stand')
    await stepTo(bot, ctl, low, { ms: 700, sprint: false, stopAt: 0.1 }); clearControls(bot)
    // Встал — значит стоит на своём блоке (на земле), а не в прыжке: fin2-28 — проверка прошла
    // в воздухе (y 64.2), блока не было, тело упало, и заслон «грань не видно».
    const onStand = () => bot.entity.onGround && Math.abs(bot.entity.position.y - plan.ground.y) <= 0.3 && isSolid(bot.blockAt(new Vec3(low.x, plan.gPS, low.z)))
    for (let k = 0; k < 2 && !onStand(); k++) {
      if (k) { await stepTo(bot, ctl, low, { ms: 700, sprint: false, stopAt: 0.1 }); clearControls(bot) }
      await build.towerUp(bot, ctl, 1).catch(() => {})
      clearControls(bot)
      for (let j = 0; j < 15 && !bot.entity.onGround; j++) await sleep(50)
    }
    if (!onStand()) return res({ ok: false, why: 'на блок у места ставки не встал' })
  }
  mark('support')
  for (const y of plan.sCells) {
    if (risky()) return res({ ok: false, why: 'дракон рядом' })
    await settle()
    let r = await placeNoBed(bot, v(plan.F, y), { timeoutMs: 1200 })
    // Грань опоры видна с середины клетки ставки (так считал план) — встать точно и ещё раз.
    if (!r.ok) { await stepTo(bot, ctl, plan.ground, { ms: 900, sprint: false, stopAt: 0.08 }); clearControls(bot); r = await placeNoBed(bot, v(plan.F, y), { timeoutMs: 1200 }) }
    if (!r.ok) return res({ ok: false, why: `опора: ${r.reason || r.why}` })
  }
  // заслон — отсюда, если видно; нет — с B
  mark('wall')
  let moved = false
  for (const y of plan.wCells) {
    if (risky()) return res({ ok: false, why: 'дракон рядом' })
    await settle()
    let r = await placeNoBed(bot, v(plan.W, y), { timeoutMs: 1200 })
    // С места ставки не вышло — сперва встать точно туда (стоя), потом уже с B.
    if (!r.ok && !moved && !plan.psLift) { await stepTo(bot, ctl, plan.ground, { ms: 900, sprint: false, stopAt: 0.06 }); await settle(); r = await placeNoBed(bot, v(plan.W, y), { timeoutMs: 1200 }) }
    if (!r.ok && !moved) {
      moved = true
      await stepTo(bot, ctl, new Vec3(plan.B.x + 0.5, plan.G, plan.B.z + 0.5), { ms: 2000, stopAt: 0.08 })
      await settle()
      r = await placeNoBed(bot, v(plan.W, y), { timeoutMs: 1200 })
    }
    if (!r.ok) { const q = bot.entity.position; lap.wallAt = [plan.W.x, y, plan.W.z]; lap.me = [r1(q.x), r1(q.y), r1(q.z)]; lap.ps = [plan.ground.x, plan.ground.y, plan.ground.z]; return res({ ok: false, why: `заслон: ${r.reason || r.why}` }) }
  }
  if (plan.K && !isSolid(bot.blockAt(v(plan.K, plan.G)))) {
    mark('anchor')
    let r = await placeNoBed(bot, v(plan.K, plan.G), { timeoutMs: 1200 })
    if (!r.ok) { await stepTo(bot, ctl, new Vec3(plan.B.x + 0.5, plan.G, plan.B.z + 0.5), { ms: 2000, stopAt: 0.2 }); r = await placeNoBed(bot, v(plan.K, plan.G), { timeoutMs: 1200 }); moved = true }
    if (!r.ok) return res({ ok: false, why: `упор крышки: ${r.reason || r.why}` })
  }
  if (moved) await stepTo(bot, ctl, plan.ground, { ms: 2000, stopAt: 0.2 })
  if (plan.anchor) {
    mark('anchor')
    if (risky()) return res({ ok: false, why: 'дракон рядом' })
    await settle()
    const r = await placeAnchorAt(bot, plan)
    if (!r.ok) return res({ ok: false, why: `якорь: ${r.why}` })
    mark('charge')
    const c = await chargeAnchor(bot, plan)
    if (!c.ok) return res({ ok: false, why: `заряд: ${c.why}` })
  } else {
  mark('bed')
  const bedAt = bot.blockAt(v(plan.F, plan.yb))
  if (!(bedAt && /_bed$/.test(bedAt.name))) {
    if (risky()) return res({ ok: false, why: 'дракон рядом' })
    const r = await placeBedAt(bot, plan.F, plan.H, plan.yb)
    if (!r.ok) return res(r)
  }
  const hb = bot.blockAt(v(plan.H, plan.yb))
  if (!hb || !/_bed$/.test(hb.name)) return res({ ok: false, why: 'изголовье не там (взгляд не вдоль a)' })
  }
  if (plan.second && (!left || left() >= 70)) {
    const s2 = plan.second
    mark('walk0')
    const g0 = risky() ? { ok: false } : await walkAround(session, ctl, s2.ground, { timeoutMs: 6000 })
    if (g0.ok) {
      mark('build0')
      let ok0 = true
      for (const y of s2.sCells) { if (risky()) { ok0 = false; break } const r = await placeNoBed(bot, v(s2.F, y), { timeoutMs: 1200 }); if (!r.ok) { ok0 = false; break } }
      for (const y of ok0 ? s2.wCells : []) {
        if (risky()) { ok0 = false; break }
        let r = await placeNoBed(bot, v(s2.W, y), { timeoutMs: 1200 })
        if (!r.ok) { await stepTo(bot, ctl, new Vec3(plan.B.x + 0.5, plan.G, plan.B.z + 0.5), { ms: 2000, stopAt: 0.2 }); r = await placeNoBed(bot, v(s2.W, y), { timeoutMs: 1200 }); await stepTo(bot, ctl, s2.ground, { ms: 2000, stopAt: 0.2 }) }
        if (!r.ok) { ok0 = false; break }
      }
      if (ok0 && !risky()) { const r = await placeBedAt(bot, s2.F, s2.H, s2.yb); ok0 = r.ok } else ok0 = false
      const hb0 = bot.blockAt(v(s2.H, s2.yb))
      lap.second = ok0 && hb0 && /_bed$/.test(hb0.name) ? 'ok' : 'нет'
      if (lap.second !== 'ok') plan.second = null
    } else { lap.second = 'не дошёл'; plan.second = null }
  }
  else if (plan.second) { lap.second = 'некогда'; plan.second = null }
  if (skipTrench) { mark('done'); return res({ ok: true }) }
  return trench()
}
// Якорь возрождения в H (yb) — к грани +u верхнего блока заслона W (W + u = H), крадучись.
async function placeAnchorAt (bot, plan) {
  const Hp = new Vec3(plan.H.x, plan.yb, plan.H.z)
  const cur = bot.blockAt(Hp)
  if (cur && cur.name === 'respawn_anchor') return { ok: true, already: true }
  const it = bot.inventory.items().find(i => i.name === 'respawn_anchor')
  if (!it) return { ok: false, why: 'нет якоря' }
  const Wb = bot.blockAt(new Vec3(plan.W.x, plan.yb, plan.W.z))
  if (!Wb || !isSolid(Wb)) return { ok: false, why: 'нет блока заслона на высоте якоря' }
  const face = new Vec3(plan.u.x, 0, plan.u.z)
  const was = bot.getControlState('sneak')
  bot.setControlState('sneak', true)
  try {
    await bot.equip(it, 'hand')
    await new Promise(resolve => bot.once('physicsTick', resolve))
    const aim = pick.faceAim(bot, Wb.position, face)
    if (!aim) return { ok: false, why: 'грань заслона не видно' }
    await bot.lookAt(aim, true)
    try { await build.withTimeout(bot.placeBlock(Wb, face), 1500) } catch (e) { dbg('anchor place', e.message) }
  } finally { if (!was) bot.setControlState('sneak', false) }
  const b = bot.blockAt(Hp)
  return b && b.name === 'respawn_anchor' ? { ok: true } : { ok: false, why: `не встал (${b ? b.name : '?'})` }
}
function anchorCharges (bot, p) {
  const b = bot.blockAt(p)
  if (!b || b.name !== 'respawn_anchor') return -1
  try { const pr = b.getProperties(); return Number(pr.charges || 0) } catch { return 0 }
}
// Зарядить якорь светокамнем: щелчок с светокамнем в руке, НЕ крадучись (крадучись с предметом
// блок не «используется» — светокамень встал бы рядом). Взрывать — потом рукой без светокамня.
async function chargeAnchor (bot, plan, n = 1, clickFn = null) {
  const Hp = new Vec3(plan.H.x, plan.yb, plan.H.z)
  for (let k = 0; k < 3 && anchorCharges(bot, Hp) < n; k++) {
    if (anchorCharges(bot, Hp) < 0) return { ok: false, why: 'якоря нет' }
    const glow = bot.inventory.items().find(i => i.name === 'glowstone')
    if (!glow) return { ok: false, why: 'нет светокамня' }
    bot.setControlState('sneak', false)
    await bot.equip(glow, 'hand')
    const hit = clickFn ? clickFn() : anClickPoint(bot, bot.entity.position.offset(0, EYE, 0), plan)
    if (!hit) return { ok: false, why: 'якорь не видно' }
    await lookAtSafe(bot, hit.point)
    await new Promise(resolve => bot.once('physicsTick', resolve))
    const cur = hit.point.minus(hit.block.position)
    bot._client.write('block_place', { location: hit.block.position, direction: FACE_IDX(hit.face), hand: 0, cursorX: cur.x, cursorY: cur.y, cursorZ: cur.z, insideBlock: false, sequence: 0, worldBorderHit: false })
    bot.swingArm()
    const t0 = gameClock.now()
    while (gameClock.now() - t0 < 600 && anchorCharges(bot, Hp) < n) await sleep(30)
  }
  const wpn = items.bestWeapon(bot)
  if (wpn) await bot.equip(wpn, 'hand').catch(() => {})
  return anchorCharges(bot, Hp) >= n ? { ok: true } : { ok: false, why: `заряд ${anchorCharges(bot, Hp)}` }
}
// В окоп станции: встать над клеткой B точно посередине, выкопать до G − depth.
async function tsTrench (bot, ctl, plan, mark, session) {
  const lap = {}
  mark('trench')
  const runner0 = runnerOn() && plan.runner
  const bc = runner0 && plan.feet ? new Vec3(plan.feet.x, plan.G, plan.feet.z) : new Vec3(plan.B.x + 0.5, plan.G, plan.B.z + 0.5)
  // portal: окоп станции у столба — в 3–5 от середины: шаг к середине клетки смотрит на 0.9 вперёд и
  // упирался в «чашу портала» (pil5-15: «не встал в середину клетки» ×5 за 1.5 с)
  const portal = !!plan.portal
  const runner = runnerOn() && plan.runner
  // depth 0: спуститься с обода P−3 в чашу P−4 маршрутом, а не копкой под собой.
  if (runner && plan.depth === 0) await walkTo(session, ctl, bc, { range: 0.3, timeoutMs: 8000, portal })
  // R: в клетке ног чаши — свой блок (рефлекс от облака/фаербола, rs8-s1), бот стоит на нём на ярус выше — снять под собой
  if (runner && plan.depth === 0) {
    for (let k = 0; k < 2; k++) {
      const q0 = bot.entity.position
      const under = bot.blockAt(new Vec3(Math.floor(q0.x), Math.floor(q0.y + 0.01) - 1, Math.floor(q0.z)))
      if (Math.floor(q0.y + 0.01) <= plan.G || Math.hypot(q0.x - bc.x, q0.z - bc.z) > 0.6 || !under || !FILLER_RE.test(under.name)) break
      lap.unfill = (lap.unfill || 0) + 1
      await digDownTo(bot, ctl, plan.G, 2, plan.abortIf || null).catch(() => {})
    }
  }
  await stepTo(bot, ctl, bc, { ms: 2000, stopAt: 0.15, portal })
  clearControls(bot)
  // R: ноги сдвинуты к краю клетки (x 0.2/0.8) — floor(x) на шаге за край врёт; годится ≤ 0.35 от точки ног (rs3: 37 «не встал над окопом»)
  const inCell = () => { const q = bot.entity.position; return runner0 && plan.feet ? Math.hypot(q.x - bc.x, q.z - bc.z) <= 0.35 : Math.floor(q.x) === plan.B.x && Math.floor(q.z) === plan.B.z && Math.hypot(q.x - bc.x, q.z - bc.z) <= 0.45 }
  for (let k = 0; k < 2 && !inCell(); k++) {
    if (k === 0) await walkTo(session, ctl, bc, { range: 0.3, timeoutMs: 4000, hazards: true, portal })
    await stepTo(bot, ctl, bc, { ms: 900, sprint: false, stopAt: 0.1, portal })
    clearControls(bot)
  }
  if (plan.abortIf && plan.abortIf()) return { ok: false, why: plan.abortIf(), lap }
  if (!inCell()) return { ok: false, why: 'не встал над окопом', lap }
  // Копать под собой — только стоя целиком над клеткой (коробка 0.6: смещение ≤ 0.18),
  // иначе после выкопанного блока тело висит на краю соседней клетки (oc5: «окоп: не
  // спустился до земли» ×3).
  const centred = () => { const q = bot.entity.position; return Math.max(Math.abs(q.x - bc.x), Math.abs(q.z - bc.z)) <= 0.18 }
  for (let k = 0; k < 4 && !centred(); k++) { await stepTo(bot, ctl, bc, { ms: 600, sprint: false, stopAt: 0.05, portal }); clearControls(bot); await sleep(60) }
  if (!centred()) return { ok: false, why: 'не встал в середину клетки окопа', lap }
  for (let k = 0; k < 2 && (!runner || plan.depth > 0) && Math.floor(bot.entity.position.y + 0.01) > plan.G - plan.depth; k++) {
    const stopWhy = plan.abortIf && plan.abortIf()
    if (stopWhy) return { ok: false, why: stopWhy, lap }
    const down = await digDownTo(bot, ctl, plan.G - plan.depth, plan.depth, plan.abortIf || null)
    lap['dig' + k] = { dug: down.dug, why: down.why || null, y: r1(bot.entity.position.y), off: r1(Math.hypot(bot.entity.position.x - bc.x, bot.entity.position.z - bc.z) * 100) / 100 }
    if (Math.floor(bot.entity.position.y + 0.01) > plan.G - plan.depth) { clearControls(bot); bot.setControlState('sneak', false); for (let j = 0; j < 3 && !centred(); j++) { await stepTo(bot, ctl, bc, { ms: 600, sprint: false, stopAt: 0.05, portal }); clearControls(bot) } }
  }
  // глубже, чем надо (провалился) — подняться на свой блок
  const under = plan.G - plan.depth - Math.floor(bot.entity.position.y + 0.01)
  if (!runner && under > 0 && under <= 2 && inCell()) { lap.up = under; await build.towerUp(bot, ctl, under).catch(() => {}); clearControls(bot) }
  // st2-s1: «не спустился» ×6 подряд за 1.5 с — тело ещё падало/подпрыгивало в яме (y 61.4 при цели 61): ждать земли
  for (let j = 0; j < 16 && !bot.entity.onGround; j++) await sleep(50)
  lap.end = { y: r1(bot.entity.position.y), want: plan.G - plan.depth, ground: !!bot.entity.onGround }
  if (Math.floor(bot.entity.position.y + 0.01) !== plan.G - plan.depth) return { ok: false, why: 'окоп: не спустился', lap }
  mark('done')
  return { ok: true, lap }
}

// Добить мечом (просьба пользователя: кровати — основной урон, но не до абсурда).
// Сидящий засчитывает удары меча (7 — крита по части дракона нет: EnderDragonPart не
// LivingEntity) в тот же сидячий счёт: до > 50 он не взлетит. Значит, если хп дракона
// ≤ остатка счёта (50 − уже снятое), удары его добивают, не поднимая; и когда кровать
// сейчас не поставить, а хп мало. Только слепому (голова стоит, огня нет).
async function meleeFinish (session, ctl, stats, track, { blind = true } = {}) {
  const bot = session.bot
  const w = items.bestWeapon(bot)
  if (!w) return { ok: false, why: 'нет меча' }
  let d = track.tick()
  if (!d || !SITTING.has(phaseOf(bot, d))) return { ok: false, why: 'не сидит' }
  let parts = partsOf(bot, d, track)
  // видящему — только почти на оси морды (голова поворачивается к нам); нет такого места — как слепому
  const spot = meleeSpot(bot, d, parts, { blind }) || (blind ? null : meleeSpot(bot, d, parts, { blind: true }))
  if (!spot) return { ok: false, why: 'нет места у головы' }
  doing(ctl, 'finish:go')
  if (ctl.trace) ctl.trace.ev('finish', { hp: r1(hpOf(bot, d)), acc: r1(sitAcc.dmg), at: [r1(spot.ground.x), spot.ground.y, r1(spot.ground.z)] })
  const g = await bedsGo(session, ctl, { feet: spot.ground, B: { x: Math.floor(spot.ground.x), z: Math.floor(spot.ground.z) }, y: spot.ground.y }, true, parts)
  if (!g.ok) return { ok: false, why: g.why }
  await bot.equip(w, 'hand').catch(() => {})
  let next = gameClock.now() + 100; let hits = 0
  stats.melee = stats.melee || 0
  while (!ctl.aborted) {
    d = track.tick()
    if (!d) break
    const ph = phaseOf(bot, d)
    const hp = hpOf(bot, d)
    if (!SITTING.has(ph) || (hp != null && hp <= 0) || bot.health < 8) break
    parts = partsOf(bot, d, track)
    const eye = bot.entity.position.offset(0, EYE, 0)
    const reach = boxDist(eye, parts.head)
    if (reach > 3.0 || hurtNear(playerBox(bot.entity.position), parts)) break
    await lookAtSafe(bot, parts.headC)
    if (gameClock.now() >= next) {
      bot.attack({ id: d.id + PART.head })
      hits++; stats.melee++
      next = gameClock.now() + pvp.cooldownMs(bot.heldItem)
      gameClock.setTimeout(() => { const dd = dragonOf(bot); if (dd) noteSitDamage(bot, dd, phaseOf(bot, dd)) }, 150)
    }
    await sleep(50)
  }
  if (ctl.trace) ctl.trace.ev('finishDone', { hits, hp: d ? r1(hpOf(bot, d)) : 0 })
  return { ok: true, hits }
}

// R (02.10 вечер, ND_RUN_SWORD=1): кровати кончились — меч из чаши, не выходя из защищённой клетки. После 4-й кровати дракону
// остаётся 1–36 хп (rs9 p50 ~20), он делает ещё проход и садится через ~4 с; голова сидящего — в 6.5 от центра (из чаши не
// достать), но тело (5×3 над столбом) и шея видящего (к нам) — в 2.3–3 от глаз. Не голова — урон/4 + 1 (железный меч 2.5),
// ~4 урона/с против лечения кристаллами 2/с; сидячий счёт > 50 — взлёт (EnderDragon.hurt). Чаша ниже раздутых на 1 головы, шеи и
// зоны крыльев сидящего (макушка P − 2.2 против Y − 2), облако огня — в 9 ± 5 от центра. Удар честный: луч от глаз входит в
// коробку части (≤ 3) раньше любого блока и раньше других частей (их бьёт и прицел клиента — GameRenderer.pick).
// ND_RUN_SWORD=2 (rs11, 02.10 20:10): удар ровно по перезарядке (было ~680 мс из-за цикла — 3.7 урона/с вместо 4), и добивание
// на взлёте: сидячий счёт > 50 поднимает его (rs11: остаток 2.8 и 5.5) — пока тело/шея в досягаемости, бить и на взлёте (там
// счёта нет). Крита по дракону нет (Player.canCriticalAttack: цель instanceof LivingEntity — часть дракона не LivingEntity).
// По умолчанию — v2 (02.10 21:45, замер rs11–rs14 на 4 кроватях, пул pool21: 6/21 без меча → 11, 13, 15, 15/21 с мечом, смертей 0
// за 84 боя). Работает только при станции R (ND_RUNNER=1). ND_RUN_SWORD=0 — выкл., =1 — первая версия.
const RUN_SWORD = () => envv('ND_RUN_SWORD') !== '0'
const SWORD_V2 = () => envv('ND_RUN_SWORD') !== '0' && envv('ND_RUN_SWORD') !== '1'
// Блок под ноги в чаше (ND_RUN_SWORD_PED=1, rs12-s12: сел на Y = P + 0.9 — тело в 3.3 от глаз, шея в 3.03, 0 ударов за 45 с при
// 5.8 хп): сидит, целей нет 1.2 с, Y ≥ P + 0.7 — встать на блок (глаза +1). Макушка P − 1.2 — ниже раздутых головы/шеи (Y − 2) и
// на краю зоны крыльев (толчок сидящего без урона); на снижении и взлёте не ставим.
// 03.10: по умолчанию ВКЛ. (ND_RUN_SWORD_PED=0 — выкл.): проверка vdr — 6/111 «сел с 1.5–11.4 хп, меч 0 ударов за 45 с»
// (сидит на 4.9 выше ног бота), ca1-s17 — то же: 18.7 хп после 4 кроватей, 0 ударов, клетки отлечили до 128; в rs14/rs16
// не срабатывала ни разу (без вреда).
const SWORD_PED = () => envv('ND_RUN_SWORD_PED') !== '0'
const SWORD_REACH = 2.95
function swordPick (bot, parts, eye) {
  const boxes = [['head', parts.head, PART.head], ['neck', parts.neck, PART.neck], ['body', parts.body, PART.body]]
  // прицел — во внутреннюю часть коробки (модель частей в полёте ошибается на ~0.2–0.5)
  const shrink = (b, m) => ({ min: b.min.offset(m, m, m), max: b.max.offset(-m, -m, -m) })
  for (const [name, b0, id] of boxes) {
    const m = name === 'head' ? 0.2 : 0.35
    const b = shrink(b0, m)
    const near = new Vec3(Math.max(b.min.x, Math.min(eye.x, b.max.x)), Math.max(b.min.y, Math.min(eye.y, b.max.y)), Math.max(b.min.z, Math.min(eye.z, b.max.z)))
    const c = b.min.plus(b.max).scaled(0.5)
    for (const tp of [near, near.plus(c).scaled(0.5), c]) {
      const dv = tp.minus(eye); const len = dv.norm()
      if (len < 1e-6 || len > SWORD_REACH + 1.5) continue
      const dir = dv.scaled(1 / len)
      const tIn = pick.rayBox(eye, dir, b.min, b.max, SWORD_REACH)
      if (tIn == null || tIn > SWORD_REACH) continue
      // другая часть раньше на луче — прицел клиента взял бы её
      let first = true
      for (const [n2, o] of boxes) { if (n2 === name) continue; const t2 = pick.rayBox(eye, dir, o.min, o.max, tIn); if (t2 != null && t2 < tIn - 1e-3) { first = false; break } }
      if (!first) continue
      if (pick.blockOnRay(bot, eye, dir, tIn + 0.01)) continue
      return { name, id, point: eye.plus(dir.scaled(tIn + 0.05)), dist: tIn }
    }
  }
  return null
}
async function runnerSword (session, ctl, stats, track, feed, plan) {
  const bot = session.bot
  const out = { hits: 0, by: {}, hp0: null, hpMin: null, phases: [], why: null, ms: 0, back: 0 }
  const w = items.bestWeapon(bot)
  if (!w) { out.why = 'нет меча'; return out }
  const t0 = gameClock.now()
  try { await bot.equip(w, 'hand') } catch (e) { out.why = 'меч: ' + e.message; return out }
  // смена предмета обнуляет силу удара (attackStrengthTicker): первый удар — через полную перезарядку
  let next = gameClock.now() + pvp.cooldownMs(bot.heldItem)
  let lastPh = null; let sitT = null
  const P = plan.P
  while (!ctl.aborted && gameClock.now() - t0 < envNum('ND_RUN_SWORD_MS', 45000)) {
    const d = track.tick()
    if (!d) { out.why = 'дракона нет'; break }
    const ph = phaseOf(bot, d); const hp = hpOf(bot, d)
    if (out.hp0 == null && hp != null) out.hp0 = r1(hp)
    if (hp != null) out.hpMin = out.hpMin == null ? r1(hp) : Math.min(out.hpMin, r1(hp))
    if (ph !== lastPh) { out.phases.push(PHASE_RU[ph] ?? ph); lastPh = ph }
    if (hp != null && hp <= 0) { out.why = 'убит'; break }
    if (ph === PHASE.DYING) { out.why = 'умирает'; break }
    // v2: на взлёте — пока есть кого бить (до 2.5 с без цели — конец)
    const takeoff = SWORD_V2() && ph === PHASE.TAKEOFF
    if (takeoff) { out.toT = out.toT || gameClock.now(); if (gameClock.now() - (out.lastTgt || out.toT) > 2500 || gameClock.now() - out.toT > 6000) { out.why = 'взлетел'; break } }
    if (ph !== PHASE.LANDING && !SITTING.has(ph) && !takeoff) { out.why = `фаза ${PHASE_RU[ph] ?? ph}`; break }
    if (bot.health < 8) { out.why = 'мало хп'; break }
    const now = gameClock.now()
    if (SITTING.has(ph)) { const rc = sitState(d, ph, now); if (rc) noteNear(rc, d, bot, now); noteSitDamage(bot, d, ph); if (!sitT) sitT = now } else sitT = null
    const q = bot.entity.position
    const home = out.ped ? plan.feet.offset(0, 1, 0) : plan.feet
    // сидит, а достать некого — встать на блок (ND_RUN_SWORD_PED)
    if (SWORD_PED() && !out.ped && !out.pedTried && sitT && now - Math.max(sitT, out.lastTgt || 0) > 1200 && bot.entity.onGround && q.distanceTo(plan.feet) < 0.4 && d.position.y >= P + 0.7 && bot.health >= 12) {
      const tw = await build.towerUp(bot, ctl, 1).catch(e => ({ placed: 0, reason: e.message }))
      clearControls(bot)
      out.ped = !!(tw && tw.placed); out.pedWhy = out.ped ? null : (tw && tw.reason) || 'не встал'
      if (!out.ped) out.pedTried = true
      try { await bot.equip(w, 'hand') } catch {}
      next = gameClock.now() + 600
      if (ctl.trace) ctl.trace.ev('swPed', { ok: out.ped, why: out.pedWhy || null, Y: r1(d.position.y - P) })
      continue
    }
    // толчок сдвинул из защищённой клетки — назад (в чаше шаг-другой)
    if (q.distanceTo(home) > 0.5 && !(out.ped && q.distanceTo(plan.feet) <= 0.5)) {
      if (++out.back > 12) { out.why = 'не вернулся в клетку'; break }
      await stepTo(bot, ctl, home, { ms: 900, sprint: false, stopAt: 0.15, clouds: false })
      clearControls(bot)
      continue
    }
    // на снижении прогноз пути задевает клетку — как в цепочке R, не стоять (решает основной цикл)
    if (ph === PHASE.LANDING && feed) {
      const fc = landingForecast(feed, P)
      if (fc) { const k = Math.max(0, Math.round((now - fc.t) / 50)); const hit = landingHits({ path: fc.path.slice(k, k + 4) }, q); if (hit) { out.why = 'R: ' + hit.what; break } }
    }
    // взлёт: голова/шея/тело рядом с нами (модель с запасом) — не стоять под ними, выход
    if (takeoff && hurtNear(playerBox(q), partsOf(bot, d, track))) { out.why = 'взлёт: части над нами'; break }
    if (now >= next) {
      const parts = partsOf(bot, d, track)
      const t = swordPick(bot, parts, q.offset(0, EYE, 0))
      if (t) {
        if (!bot.heldItem || bot.heldItem.name !== w.name) { try { await bot.equip(w, 'hand') } catch {} next = gameClock.now() + pvp.cooldownMs(bot.heldItem); continue }
        runnerAim(bot, t.point)
        bot.attack({ id: d.id + t.id })
        out.hits++; out.by[t.name] = (out.by[t.name] || 0) + 1
        stats.swordHits = (stats.swordHits || 0) + 1
        if (ctl.trace) ctl.trace.ev('sw', { part: t.name, dist: r1(t.dist * 100) / 100, hp: hp != null ? r1(hp) : null, ph })
        // v2: шаг 575 мс (~11.5 тика: свежий удар — ≥ 10 тиков, сила ≥ 0.92) вместо 675 (625 + тик запаса): по не-голове урон
        // dmg/4 + 1 — частые удары выгоднее (≈ 4.2/с против 3.7/с), меньше лечения до сидячего порога 50
        next = SWORD_V2() ? now + envNum('ND_RUN_SWORD_HIT_MS', 575) : now + pvp.cooldownMs(bot.heldItem)
        out.lastTgt = now
      }
    }
    await sleep(SWORD_V2() ? 8 : 25)
  }
  out.ms = gameClock.now() - t0
  return out
}

// Слепой дракон по заказу (Codex, farm/dragon/codex-20260930-blind: 4/4): Sensing у
// дракона не очищается — первое «не видно» при высматривании навсегда. Ждём заход
// на посадку (под крышкой нельзя ждать фаербол: STRAFE требует LOS), копаем яму в 2
// и закрываем крышкой; первое «высматривает» в 20 блоках — видит крышку, и всё.
// Вылезаем, как только он сел (посадка ещё 5 с — на кровати).
const blindTried = new Set()
async function blindPit (session, ctl, stats, deadline) {
  const bot = session.bot
  const d0 = dragonOf(bot)
  if (!d0 || !bot.entity || !bot.entity.onGround) return
  const key = d0.id + ':' + bot.entity.id
  if (blindTried.has(key) || sight.get(key)) return
  blindTried.add(key)
  const ev = (k, v) => { if (ctl.trace) ctl.trace.ev(k, v) }
  doing(ctl, 'blind:await-approach')
  let ok = false
  while (!ctl.aborted && bot.health > 0 && gameClock.now() < deadline - 15000) {
    clearControls(bot)
    const dd = dragonOf(bot)
    const ph = dd ? phaseOf(bot, dd) : null
    if (ph === PHASE.APPROACH || ph === PHASE.LANDING) { ok = true; break }
    if (SITTING.has(ph)) { ev('blind', { r: 'пропустил посадку' }); return }
    const me = bot.entity.position
    const danger = hazardNow(bot)
    if (danger) await evade(bot, ctl, stats, danger)
    else {
      // Ждать в кольце 9.5–12.5 от центра: яма там (глубина 3) — в ≤ 16 от сидящего по 3D
      // (oc8-17: яма в 19 по горизонтали и 6.8 ниже — 20.2 > 20: первого «высматривает» не
      // было, вылезли — увидел).
      const fromC = Math.hypot(me.x - CENTER.x, me.z - CENTER.z)
      // (Пока кружит — дальше, 13–16: у фонтана заходов с фаерболом вдвое больше; к яме —
      // ближе, перед копанием.)
      if (fromC > 16.5 || fromC < 12.5 || nearEdge(bot, me, 2)) {
        const P0 = podiumTop(bot)
        const spot = pickSpot(bot, CENTER, { rMin: 13, rMax: 16, step: 0.75, prefer: me, avoid: f => nearPillar(bot, f, 3) || (P0 != null && f.y > P0 - 2.5) })
        if (spot) await walkTo(session, ctl, spot.feet, { range: 1, timeoutMs: 12000 })
      } else { await guard(session, ctl); await heal(session, ctl, null, stats) }
    }
    await sleep(100)
  }
  if (!ok) { ev('blind', { r: 'не дождался захода' }); return }
  // Яму — там, где будет стоять первая кровать посадки (A): ждём снижения и прогноза
  // посадки, место A у головы по прогнозу — туда и копаем (вылезли — и сразу A: oc3 —
  // из ямы у кольца 15 до головы шли 2–3 с, первая посадка без кроватей).
  if (OC_ON && ctl.feed) {
    doing(ctl, 'blind:await-forecast')
    const tw = gameClock.now()
    let fc = null
    while (!ctl.aborted && gameClock.now() - tw < 45000) {
      const dd = dragonOf(bot)
      const ph = dd ? phaseOf(bot, dd) : null
      if (SITTING.has(ph) || !dd) break
      const f = ctl.feed.fc
      if (ph === PHASE.LANDING && f && f.id === dd.id && gameClock.now() - f.t < 400 && f.n >= 70) { fc = f; break }
      const danger = hazardNow(bot)
      if (danger) await evade(bot, ctl, stats, danger)
      await sleep(100)
    }
    // Сперва — кровать L из окопа с крышкой (ослепит и не потеряет первую посадку); не вышло
    // до стройки — яма, как раньше.
    // fin2: крышка к упору не встала ни разу из 4 (упор у окопа сносит взрыв L / путь после
    // толчка), 14 раз не дошло до стройки — по умолчанию выключено, яма надёжнее (fin1: 15 из 15).
    if (fc && process.env.ND_OC_LID === '1') {
      const tw2 = gameClock.now()
      while (!ctl.aborted && gameClock.now() - tw2 < 15000) {
        const f = ctl.feed.fc
        const left = f ? f.n - (gameClock.now() - f.t) / 50 : 999
        const ddw = dragonOf(bot)
        if (!ddw || SITTING.has(phaseOf(bot, ddw))) break
        if (f && gameClock.now() - f.t < 400 && left <= 185) break
        const danger = hazardNow(bot)
        if (danger) await evade(bot, ctl, stats, danger)
        await sleep(60)
      }
      const r = await ocLanding(session, ctl, null, stats, makeTrack(bot), ctl.feed, { blindLid: true })
      const fv = ctl.feed.fc
      ev('blind:viaL', { ok: !!r, blind: sight.get(key) || null, n: fv ? Math.round(fv.n - (gameClock.now() - fv.t) / 50) : null })
      if (sight.get(key) === 'blind') return
      const f = ctl.feed.fc
      const dd0 = dragonOf(bot)
      if (!dd0 || SITTING.has(phaseOf(bot, dd0))) return
      fc = f && gameClock.now() - f.t < 500 && f.n - (gameClock.now() - f.t) / 50 > 75 ? f : null
      if (!fc) { ev('blind', { r: 'после L — не успеть с ямой' }); return }
    }
    if (fc) {
      const dd = dragonOf(bot)
      const plan = dd && bedsLayout(bot, dd, predParts(fc), { headAt: fc.head, noTurn: true, brave: true, cap: 46 })
      // Только близко (≤ 9 шагов) и если после дороги до посадки ещё ≥ 4 с на яму: иначе —
      // яма на месте (oc5-19: шёл к месту 12 с, крышка встала уже после посадки — видящий).
      const spot = plan && new Vec3(plan.B.x + 0.5, plan.y, plan.B.z + 0.5)
      const far = spot ? Math.hypot(spot.x - bot.entity.position.x, spot.z - bot.entity.position.z) : 99
      if (plan && far <= 9 && fc.n - (gameClock.now() - fc.t) / 50 > 80 + far * 5) {
        ev('blind:spot', { n: fc.n, feet: [r1(plan.feet.x), plan.feet.y, r1(plan.feet.z)], expect: plan.expect, far: r1(far) })
        doing(ctl, 'blind:go-spot')
        await walkAround(session, ctl, spot, { timeoutMs: Math.min(3500, Math.max(1000, (fc.n - 80) * 50 - (gameClock.now() - fc.t))) })
        // Кровать A и заслон — сейчас (снижающийся их не заденет: голова в G + 2.9 и выше,
        // кровать — на земле), яма — под собой на месте стоящего у A: вылез — и щелчок.
        const left = () => fc.n - (gameClock.now() - fc.t) / 50
        const at = bot.entity.position
        if (left() > 90 && Math.floor(at.x) === plan.B.x && Math.floor(at.z) === plan.B.z) {
          await bedsGo(session, ctl, plan, true, predParts(fc))
          ctl.holdStation = true
          let b
          try { b = await bedsBuild(session, ctl, stats, plan) } finally { ctl.holdStation = false }
          ev('blind:A', { ok: b.ok, why: b.why || null, left: Math.round(left()) })
        }
      } else ev('blind:spot', { no: plan ? `далеко ${r1(far)}` : bedsLayout.why })
    }
  }
  {
    const m = bot.entity.position
    if (Math.hypot(m.x - CENTER.x, m.z - CENTER.z) > 13) {
      const P0 = podiumTop(bot)
      const spot = pickSpot(bot, CENTER, { rMin: 9.5, rMax: 12, step: 0.75, prefer: m, avoid: f => nearPillar(bot, f, 3) || (P0 != null && f.y > P0 - 2.5) })
      if (spot) await walkAround(session, ctl, spot.feet, { timeoutMs: 4000 })
      if (spot && Math.hypot(bot.entity.position.x - CENTER.x, bot.entity.position.z - CENTER.z) > 14) await walkTo(session, ctl, spot.feet, { range: 1, timeoutMs: 6000 }).catch(() => {})
      if (Math.hypot(bot.entity.position.x - CENTER.x, bot.entity.position.z - CENTER.z) > 14) { ev('blind', { r: 'далеко от центра для ямы' }); return }
    }
  }
  const start = bot.entity.position.floored()
  // Яма в 3: крышка — в яме на уровне головы (feet + 2), у неё стены с четырёх сторон
  // (в 2 блока крышке не к чему прислониться: сверху — воздух у поверхности).
  for (let i = 1; i <= 4; i++) {
    const b = bot.blockAt(start.offset(0, -i, 0))
    if (!b || !isSolid(b) || !/end_stone|cobble|stone|dirt|netherrack/.test(b.name)) { ev('blind', { r: 'нет земли под ямой', i }); return }
  }
  doing(ctl, 'blind:dig')
  // Копать под собой — только стоя целиком над клеткой (иначе тело висит на краю: oc12 —
  // «не спустился до земли», яма в 0, видящий дракон).
  const cc = start.offset(0.5, 0, 0.5)
  const centred = () => { const q = bot.entity.position; return Math.max(Math.abs(q.x - cc.x), Math.abs(q.z - cc.z)) <= 0.18 }
  for (let k = 0; k < 5 && !centred(); k++) { await stepTo(bot, ctl, cc, { ms: 700, sprint: false, stopAt: 0.05 }); clearControls(bot); await sleep(60) }
  let down = await digDownTo(bot, ctl, start.y - 3, 3)
  if (Math.floor(bot.entity.position.y + 0.01) > start.y - 3) {
    bot.setControlState('sneak', false)
    const c2 = bot.entity.position.floored().offset(0.5, 0, 0.5)
    for (let k = 0; k < 3; k++) { await stepTo(bot, ctl, c2, { ms: 600, sprint: false, stopAt: 0.05 }); clearControls(bot) }
    down = await digDownTo(bot, ctl, start.y - 3, 3)
  }
  const lidPos = bot.entity.position.floored().offset(0, 2, 0)
  const lid = await placeNoBed(bot, lidPos, { timeoutMs: 2000 })
  const depth = start.y - Math.floor(bot.entity.position.y + 0.01)
  ev('blind:sealed', { depth, lid: !!lid.ok, down: down.why })
  let sat = 0; let roared = false
  doing(ctl, 'blind:wait')
  while (!ctl.aborted && bot.health > 0 && depth >= 3 && lid.ok && gameClock.now() < deadline - 15000) {
    clearControls(bot)
    const dd = dragonOf(bot)
    if (!dd) break
    const ph = phaseOf(bot, dd)
    if (ph === PHASE.ROARING || ph === PHASE.FLAMING) { roared = true; break }
    // Сел: первое «высматривает» (мы в 20) уже спросило Sensing — через 3 тика выходим.
    if (SITTING.has(ph)) { if (!sat) sat = gameClock.now(); if (gameClock.now() - sat > 150) break }
    if (!SITTING.has(ph) && ph !== PHASE.LANDING && ph !== PHASE.APPROACH) break
    await sleep(25)
  }
  ev('blind:result', { sat: !!sat, roared })
  if (sat && !roared) sight.set(key, 'blind')
  doing(ctl, 'blind:exit')
  const cover = bot.blockAt(lidPos)
  if (!ctl.aborted && cover && isSolid(cover)) {
    await items.equipBestTool(bot, cover)
    await build.withTimeout(bot.dig(cover, true), 4000).catch(() => {})
  }
  if (!ctl.aborted && bot.health > 0) await build.towerUp(bot, ctl, depth).catch(() => {})
}

// ------------------------------------------------------------ бой только кроватями
//
// Решение пользователя (30.09.2026): дракона — только кроватями, кристаллы не
// трогать. Механика — байткод Paper 1.21.11 (research/dev-C-dragon.md):
//   · кристаллы лечат 1 хп за 10 тиков (2 хп/с), пока хоть один в коробке
//     дракона, раздутой на 32 (checkCrystals, и сидя тоже): у фонтана достают 8
//     обелисков из 10, в облёте — всегда. Между посадками (медиана 62 с по
//     трассам) это ~120 хп: урон одной посадки должен быть большим.
//   · сидя урон копится в sittingDamageReceived, > 50 — TAKEOFF; в LANDING и
//     TAKEOFF в счётчик не идёт (EnderDragon.hurt: только isSitting()).
//   · неуязвимость: взрыв раньше 10 тиков после прошлого даёт лишь разницу
//     (LivingEntity.hurtServer: invulnerableTime > 10 → amount − lastHurt).
//   · кровать — взрыв 5 с огнём в центре изголовья; часть дракона получает
//     ((1−d/10)·s)² + (1−d/10)·s)/2·70 + 1, s — видимость всей коробки
//     дракона (Paper ServerExplosion.hurtEntities: getBlockDensity по дракону,
//     d — от центра взрыва до низа-центра части). Голова — полный урон.
//   · сидящий: Y — верх фонтана P, низ головы — P − 1; земля у фонтана — P − 4,
//     тело на ней ниже всех коробок удара (голова и шея +1: от P − 2; крылья:
//     от Y − 2), кроме облака огня на земле.
// Посадка: A — кровать на земле под головой (~47: сидит дальше, если сидячий
// счёт ≤ 50), B — вторая (он взлетает), C — на взлёте, пока голова рядом
// (урон взлёта в счёт не идёт). Раскладка по оси D: мы (B) — заслон (W) —
// изножье (F) — изголовье (H) под головой. Честно: кровать — кликом по
// видимому верху пола под F, заслон — блок в одну высоту, щелчок — по видимой
// из глаз части верха кровати поверх заслона. Стоим у задней кромки своей
// клетки: взрыв видит лишь часть верхнего ряда точек нашей коробки (~7–20 %).
const BED_GAP_MS = 560
// Двойная станция (X + C через щит) и кровать на взлёте — опыт, по умолчанию
// выключены (b4, 30.09: свои блоки у X закрывают дракона — X 22–42 вместо ~50, C на
// взлёте — 0: дракон первые 0.5 с поворачивается на месте к узлу, голова уходит
// вбок в 2–8 блоков в разные стороны). ND_BEDS_DOUBLE=1 / ND_BEDS_TAKEOFF=1 — включить.
const BEDS_DOUBLE = process.env.ND_BEDS_DOUBLE === '1'
const BEDS_TAKEOFF = process.env.ND_BEDS_TAKEOFF === '1'
// Задел для кровати «на взлёте» (следующий шаг к «одному циклу», в бою пока не
// используется — только в отчёт): взлёт (an-takeoffturn.js) — тело 0.5 с на месте,
// дракон поворачивается к узлу пути (ближайший узел кольца r = 20) — за 0.5 с на
// 25–40°. Куда он летит — по прошлым взлётам этого дракона (узел тот же, пока
// садится туда же); headAfterTakeoff — где голова через ~10 тиков.
const takeoffSeen = new Map() // id дракона → { t0, pos, az: [] }
function noteTakeoff (d, ph, now) {
  let r = takeoffSeen.get(d.id)
  if (!r) { r = { t0: 0, pos: null, az: [] }; takeoffSeen.set(d.id, r) }
  if (ph === PHASE.TAKEOFF && !r.t0) { r.t0 = now; r.pos = d.position.clone() }
  if (r.t0 && now - r.t0 >= 1800) {
    const dx = d.position.x - r.pos.x; const dz = d.position.z - r.pos.z
    if (Math.hypot(dx, dz) >= 3 && now - r.t0 <= 2800) { r.az.push(Math.atan2(dz, dx)); if (r.az.length > 6) r.az.shift() }
    r.t0 = 0
  }
}
// Азимут полёта после взлёта (x = cos, z = sin): самый частый из виденных (±25°).
function takeoffAzOf (d) {
  const r = takeoffSeen.get(d.id)
  if (!r || !r.az.length) return null
  let best = null
  for (const a of r.az) {
    const n = r.az.filter(b => Math.abs(Math.atan2(Math.sin(b - a), Math.cos(b - a))) < 0.45).length
    if (!best || n > best.n) best = { a, n }
  }
  return best.a
}
// Где голова через ~10 тиков взлёта: повёрнута к азимуту полёта на ≤ 32°.
function headAfterTakeoff (d, parts) {
  const az = takeoffAzOf(d)
  if (az == null) return null
  const face = Math.atan2(parts.dir.z, parts.dir.x)
  const need = Math.atan2(Math.sin(az - face), Math.cos(az - face))
  const rot = Math.sign(need) * Math.min(Math.abs(need), 32 * Math.PI / 180)
  const a = face + rot
  return new Vec3(d.position.x + Math.cos(a) * HEAD_AHEAD, parts.head.min.y + 0.4, d.position.z + Math.sin(a) * HEAD_AHEAD)
}
// Глаза крадучись (sneakPlace ставит блоки крадучись): с 1.62 грань видно, с 1.27 — не всегда.
const SNEAK_EYE = 1.27
// Видящий дракон в каждом «высматривает» (25 тиков) доворачивает голову к нам —
// голова ходит по кругу 6.5 от тела (+1 раздутия, +0.5 оценки), шея — 5.5 ± 2.5.
// Стоять у головы ближе этого можно только у слепого: b2-26 (30.09, 269–270 с)
// — место кровати сбоку от шеи в 4.7 от тела, новый круг, четыре удара головой;
// b2-22 (попытка 2, 101 с) — удар и в 9.1 (поза клиента отстаёт от сервера).
const TURN_SAFE_R = 9.2
function turnSafe (d, feet) { return Math.hypot(feet.x - d.position.x, feet.z - d.position.z) >= TURN_SAFE_R }
const BED_TOP = 0.5625
// Коробки удара с запасом: по горизонтали 1.5 (оценка головы ошибается на ~0.5),
// по высоте ровно столько, сколько раздувает игра (1), + 0.05.
function hurtNear (pb, parts) {
  const grow = (b, h, v) => ({ min: b.min.offset(-h, -v, -h), max: b.max.offset(h, v, h) })
  return overlap(pb, grow(parts.head, HURT_PAD, 1.05)) || overlap(pb, grow(parts.neck, HURT_PAD, 1.05)) || overlap(pb, grow(parts.body, 0.5, 0.3))
}
function bedCellFree (b) { return !!b && (isAirish(b) || /^(fire|soul_fire)$/.test(b.name)) }
// Досыпку в клетку pos видно откуда-то из глаз eye: грань соседа (снизу или сбоку),
// в которую честно можно «кликнуть» (pick.faceAim). Воронка от прошлой кровати
// часто закрыта своим же краем — такой план не брать (b2, 30.09: десять подряд
// «пол не встал»).
function fillPlaceable (bot, pos, eye, { robust = false } = {}) {
  // robust: грань видна и при сдвиге глаз на ±0.2 (тело стоит не точно в середине клетки:
  // fin4 — заслон «грань не видно» с места ставки при касательном взгляде, бот в 0.4 от центра).
  const eyes = robust ? [eye, eye.offset(0.2, 0, 0), eye.offset(-0.2, 0, 0), eye.offset(0, 0, 0.2), eye.offset(0, 0, -0.2)] : [eye]
  for (const f of [new Vec3(0, 1, 0), new Vec3(1, 0, 0), new Vec3(-1, 0, 0), new Vec3(0, 0, 1), new Vec3(0, 0, -1)]) {
    const ref = bot.blockAt(pos.minus(f))
    if (!ref || !isSolid(ref) || /_bed$|portal|gateway/.test(ref.name)) continue
    if (eyes.every(e => pick.faceAim(bot, ref.position, f, { eye: e, avoid: [] }))) return true
  }
  return false
}
// План кровати у головы. headAt — где будет голова (взлёт: вперёд по скорости),
// stayAt {x,z} — только с этой клетки (некогда идти).
// cap — первая кровать посадки: взрыв выше 50 сидячего урона сразу поднимает
// его на взлёт (EnderDragon.hurt), и второй кровати сидя уже не будет; план с
// ожидаемым уроном ≤ cap дороже не штрафуется, выше — штраф. skip — ключи
// планов, которые только что не вышли (пол не встал и т.п.).
function bedsLayout (bot, d, parts, { headAt = null, stayAt = null, brave = false, cap = null, skip = null, noTurn = false, liftMax = 0, hurry = false } = {}) {
  const me = bot.entity.position
  const hp = headAt || new Vec3(parts.headC.x, parts.head.min.y, parts.headC.z)
  const clouds = cloudsOf(bot)
  const ph = phaseOf(bot, d)
  const blind = SITTING.has(ph) && blindKnown(sitRec)
  const breath = SITTING.has(ph) && !blind ? breathOf(bot, d, parts) : null
  const why = {}
  const no = k => { why[k] = (why[k] || 0) + 1 }
  const at = (x, y, z) => bot.blockAt(new Vec3(x, y, z))
  const solidOk = b => isSolid(b) && !/_bed$|portal|gateway/.test(b.name)
  let best = null
  const cands = []
  const nearY = Math.floor(hp.y) - 3
  for (const D of AXES) {
    // ±2 от головы: после первой кровати у головы воронка (эндерняк под изножьем
    // снесён, досыпку не видно) — вторая ложится на целый пол рядом.
    for (let ox = -2; ox <= 2; ox++) {
      for (let oz = -2; oz <= 2; oz++) {
        const H = { x: Math.floor(hp.x) + ox, z: Math.floor(hp.z) + oz }
        const F = { x: H.x - D.x, z: H.z - D.z }
        const W = { x: H.x - 2 * D.x, z: H.z - 2 * D.z }
        const B = { x: H.x - 3 * D.x, z: H.z - 3 * D.z }
        if (stayAt && (B.x !== stayAt.x || B.z !== stayAt.z)) continue
        const key = `${H.x},${H.z},${D.x},${D.z}`
        if (skip && skip.has(key)) { no('не вышло только что'); continue }
        const y0 = standY(bot, B.x + 0.5, B.z + 0.5, nearY, 2, 3)
        if (y0 == null) { no('нет земли'); continue }
        // lift 1 — всё на блок выше: мы на своём блоке у B, кровать на опоре у F (центр
        // взрыва в 0.5 под головой сидящего вместо 1.5; сидячий крыльями не бьёт).
        for (const lift of (liftMax && SITTING.has(ph) ? [0, 1] : [0])) {
        const y = y0 + lift
        if (lift && !isAirish(at(B.x, y + 1, B.z))) { no('над своим блоком'); continue }
        if (/fire/.test((at(B.x, y, B.z) || {}).name || '')) { no('огонь на месте'); continue }
        // У задней кромки клетки — если за ней свободно (иначе по центру).
        const backFree = !isSolid(at(B.x - D.x, y, B.z - D.z)) && !isSolid(at(B.x - D.x, y + 1, B.z - D.z))
        const back = backFree ? 0.22 : 0
        const feet = new Vec3(B.x + 0.5 - D.x * back, y, B.z + 0.5 - D.z * back)
        if (nearPortal(feet)) { no('чаша портала'); continue }
        if (hurtNear(playerBox(feet), parts)) { no('коробки дракона'); continue }
        if (!blind && !noTurn && !turnSafe(d, feet)) { no('в круге поворота головы'); continue }
        // В облако не вставать и смелому: рефлекс «на блок» поднимает тело, щелчок
        // поверх заслона срывается, и так по кругу (b4-21, попытка 2, 204–215 с:
        // 11 с в облаке огня, ни одной кровати).
        if (inClouds(clouds, feet, 1.0)) { no('облако'); continue }
        const breathHit = !!breath && cloudHits(breath, feet, 0.6)
        // Огонь уже идёт — в его круг нельзя; ревёт (облако через ≤ 2.5 с) — можно,
        // если место в паре шагов: кровать успевает раньше облака.
        if (breathHit && ph === PHASE.FLAMING) { no('облако огня'); continue }
        if (breathHit && ph === PHASE.ROARING && Math.hypot(feet.x - me.x, feet.z - me.z) > 3) { no('облако огня скоро'); continue }
        // Клетки кровати, заслона и вида поверх него.
        const hB = at(H.x, y, H.z); const fB = at(F.x, y, F.z)
        const reuse = !!hB && !!fB && /_bed$/.test(hB.name) && /_bed$/.test(fB.name)
        if (!reuse && (!bedCellFree(hB) || !bedCellFree(fB))) { no('клетки кровати'); continue }
        const wB = at(W.x, y, W.z)
        const wallUp = solidOk(wB)
        if (!wallUp && !bedCellFree(wB)) { no('клетка заслона'); continue }
        if (wallUp && !reuse) { no('заслон уже стоит — пол под кроватью не видно'); continue }
        if (!isAirish(at(W.x, y + 1, W.z)) || !isAirish(at(F.x, y + 1, F.z))) { no('над заслоном блок'); continue }
        // Пол: под изножьем — твёрдый (или досыпать один), под заслоном — тоже.
        const fills = []
        for (const c of [W, F]) {
          const fl = at(c.x, y - 1, c.z)
          if (!fl) { fills.push(null); break }
          if (solidOk(fl)) continue
          if (!isAirish(fl) && !/fire/.test(fl.name)) { fills.push(null); break }
          // Досыпать есть к чему прислонить: снизу или сбоку твёрдое (или
          // досыпка перед ней).
          const prev = fills[fills.length - 1]
          const nb = [[0, -1, 0], [1, 0, 0], [-1, 0, 0], [0, 0, 1], [0, 0, -1]].some(([a, b, e]) => solidOk(at(c.x + a, y - 1 + b, c.z + e)) || (prev && prev.x === c.x + a && prev.y === y - 1 + b && prev.z === c.z + e))
          if (!nb) { fills.push(null); break }
          fills.push(new Vec3(c.x, y - 1, c.z))
        }
        if (fills.includes(null)) { no('пол'); continue }
        // Каждую досыпку — на «мире как будет» (после предыдущих): вторая (под
        // изножьем) за первой часто не видна (b4/b5: «пол не встал» ×20).
        {
          const ex = new Map()
          let hidden = false
          for (const f of fills) {
            if (!fillPlaceable(ex.size ? virtualBot(bot, ex) : bot, f, feet.offset(0, SNEAK_EYE, 0))) { hidden = true; break }
            ex.set(`${f.x},${f.y},${f.z}`, 'block')
          }
          if (hidden) { no('досыпку не видно'); continue }
        }
        if (!lift && !solidOk(at(B.x, y - 1, B.z))) { no('пол под нами'); continue }
        // Кровать не в коробках дракона (checkWalls снёс бы её без взрыва).
        const bedBox = { min: new Vec3(Math.min(H.x, F.x), y, Math.min(H.z, F.z)), max: new Vec3(Math.max(H.x, F.x) + 1, y + BED_TOP, Math.max(H.z, F.z) + 1) }
        if (overlap(bedBox, inflate(parts.head, 0.1)) || overlap(bedBox, inflate(parts.neck, 0.1)) || overlap(bedBox, inflate(parts.body, 0.1))) { no('в драконе'); continue }
        const centre = new Vec3(H.x + 0.5, y + 0.5, H.z + 0.5)
        const dist = centre.distanceTo(hp)
        if (dist > 5.5) { no('далеко от головы'); continue }
        const expect = bedDamage(dist)
        const walk = Math.hypot(feet.x - me.x, feet.z - me.z) + Math.abs(feet.y - me.y) * 2
        const over = cap != null && expect > cap ? (expect - cap) * 3 : 0
        const cost = -expect + over + walk * 1.2 + fills.length * 6 + (breathHit ? 6 : 0) + (back ? 0 : 3)
        cands.push({ key: key + (lift ? ':1' : ''), H, F, W, B, D, y, feet, centre, dist: r1(dist), expect, fills, reuse, wallUp, cost: lift ? cost - fills.length * 6 + 3 : cost, breathHit, walk, back, lift })
        }
      }
    }
  }
  // Видимость дракона из центра взрыва (свои блоки у кровати — заслон, досыпка, яма и
  // окоп рядом — режут урон: oc4-27 — 18 и 6.8 при ожидании 41 и 31): для лучших по
  // расстоянию — пересчёт ожидаемого урона с ней (и cap — по нему).
  cands.sort((p, q) => p.cost - q.cost)
  for (const c of cands.slice(0, 6)) {
    const ex = new Map([[`${c.W.x},${c.y},${c.W.z}`, 'block']])
    for (const f of c.fills) ex.set(`${f.x},${f.y},${f.z}`, 'block')
    const seen = dragonSeen(virtualBot(bot, ex), c.centre, parts.pos)
    c.seen = Math.round(seen * 100) / 100
    c.expect = bedDamage(c.centre.distanceTo(hp), seen)
    const over = cap != null && c.expect > cap ? (c.expect - cap) * 3 : 0
    // На своём блоке досыпка под заслон и изножье — часть раскладки (не штраф «воронки»).
    c.cost = -c.expect + over + c.walk * 1.2 + (c.lift ? 3 : c.fills.length * 6) + (c.breathHit ? 6 : 0) + (c.back ? 0 : 3)
    // Слепой вот-вот взлетит сам (на 99-м тике): любая кровать ближе — лишь бы сидячий
    // счёт перевалил 50 и обнулился (иначе он перейдёт на следующую посадку: oc7-12).
    if (hurry) c.cost = -c.expect * 0.3 + c.walk * 3 + c.fills.length * 6
    if (!best || c.cost < best.cost) best = c
  }
  bedsLayout.why = best ? null : why
  return best
}
// Точка на верхе кровати, которую видно из глаз (луч до неё — первым входит в
// эту кровать): клик по ней — то, что сделал бы клиент под прицелом.
function bedClickPoint (bot, plan) {
  const eye = bot.entity.position.offset(0, EYE, 0)
  const grid = [0.85, 0.7, 0.5, 0.3, 0.15]
  for (const c of [plan.H, plan.F]) {
    const pos = new Vec3(c.x, plan.y, c.z)
    const b = bot.blockAt(pos)
    if (!b || !/_bed$/.test(b.name)) continue
    const top = Math.max(...(b.shapes && b.shapes.length ? b.shapes.map(s => s[4]) : [BED_TOP]))
    for (const a of grid) {
      for (const s of [0.5, 0.25, 0.75]) {
        // a — вдоль оси D (дальше от нас — больше), s — поперёк.
        const P = new Vec3(c.x + (plan.D.x ? (plan.D.x > 0 ? a : 1 - a) : s), pos.y + top, c.z + (plan.D.z ? (plan.D.z > 0 ? a : 1 - a) : s))
        const delta = P.minus(eye)
        const len = delta.norm()
        if (len > 4.4 || len < 0.5) continue
        const hit = pick.blockOnRay(bot, eye, delta.scaled(1 / len), len + 0.05)
        if (hit && /_bed$/.test(hit.block.name) && Math.abs(hit.t - len) < 0.04) return { block: hit.block, point: P }
      }
    }
  }
  return null
}
// Щелчок по кровати в видимую точку её верха: взгляд туда (пакет уходит на
// тике физики), потом «использовать блок» с этой гранью и курсором.
async function clickBedAt (bot, hit, { aimed = false, until = 0, prePlace = null } = {}) {
  bot.setControlState('sneak', false)
  if (!aimed) {
    await lookAtSafe(bot, hit.point)
    await new Promise(resolve => bot.once('physicsTick', resolve))
  }
  // Точный миг (снижение: тик до посадки): ждём игровой таймер, освобождая цикл событий для следующих тиков.
  if (until) {
    while (until - gameClock.now() > 12) await sleep(Math.min(40, until - gameClock.now() - 10))
    while (gameClock.now() < until) await sleep(until - gameClock.now())
    // Опоздание цикла событий (02.10, rs17: CPU ПК 100 % — щелчок уходил на 2–6 тиков позже плана, голова в 4–8 бл. вместо 1–2):
    // опоздали больше ND_CLICK_LATE_MS — кровать не тратить, ждать следующий проход. 0 — выкл. (по умолчанию, не замерено).
    const late = gameClock.now() - until, lim = envNum('ND_CLICK_LATE_MS', 0)
    if (lim > 0 && late > lim) { hit.guardWhy = `опоздал на ${late} мс`; return false }
  }
  if (hit.runnerGuard) { const g = hit.runnerGuard(); if (g !== true) { hit.guardWhy = typeof g === 'string' ? g : null; return false } }
  // ND_PLACE_CLICK: кровать ставится к грани опоры и тут же взрывается — два пакета подряд, сервер разбирает их в одном
  // окне между тиками (дракон кровать не застаёт)
  if (prePlace) {
    if (runnerOn() && hit.face) runnerAim(bot, prePlace.point)
    const pc = prePlace.point.minus(prePlace.pos)
    bot._client.write('block_place', { location: prePlace.pos, direction: FACE_IDX(prePlace.face), hand: 0, cursorX: pc.x, cursorY: pc.y, cursorZ: pc.z, insideBlock: false, sequence: 0, worldBorderHit: false })
  }
  if (runnerOn() && hit.face) runnerAim(bot, hit.point)
  const cur = hit.point.minus(hit.block.position)
  bot._client.write('block_place', { location: hit.block.position, direction: runnerOn() && hit.face ? FACE_IDX(hit.face) : 1, hand: 0, cursorX: cur.x, cursorY: cur.y, cursorZ: cur.z, insideBlock: false, sequence: 0, worldBorderHit: false })
  bot.swingArm()
}
// Прямая от нас до точки не проходит сквозь коробки головы/шеи/тела (сидящий бьёт
// головой всех в ней: b1-22, 30.09 — два удара по 3 на ходу к месту кровати).
function clearOfDragon (bot, from, to, parts) {
  if (!parts) return true
  const n = Math.max(1, Math.ceil(from.distanceTo(to) / 0.4))
  for (let k = 1; k <= n; k++) {
    const p = from.plus(to.minus(from).scaled(k / n))
    if (hurtNear(playerBox(p), parts)) return false
  }
  return true
}
async function bedsGo (session, ctl, plan, brave, parts = null) {
  const bot = session.bot
  if (plan.lift) {
    // Свой блок у B: дойти до земли под ним и встать на блок (прыжок с блоком под себя).
    const low = { ...plan, lift: 0, feet: plan.feet.offset(0, -1, 0), y: plan.y - 1 }
    const me0 = bot.entity.position
    if (!(Math.hypot(me0.x - plan.feet.x, me0.z - plan.feet.z) < 0.5 && Math.abs(me0.y - plan.y) < 0.3)) {
      const g = await bedsGo(session, ctl, low, brave, parts)
      if (!g.ok) return g
      doing(ctl, 'beds:stand')
      await build.towerUp(bot, ctl, 1).catch(() => {})
      clearControls(bot)
    }
    const p = bot.entity.position
    if (Math.abs(p.y - plan.y) > 0.3 || Math.hypot(p.x - plan.feet.x, p.z - plan.feet.z) > 0.6) return { ok: false, why: 'на свой блок не встал' }
    return { ok: true }
  }
  const me = bot.entity.position
  const off = Math.hypot(me.x - plan.feet.x, me.z - plan.feet.z)
  if (off < 0.2 && Math.abs(me.y - plan.feet.y) < 0.3) return { ok: true }
  doing(ctl, 'beds:walk')
  // Видящий начал новый круг «высматривает» — голова пойдёт к нам: остановиться
  // (b2-22, попытка 2, 100.8–101.3 с: шёл к месту — удар головой).
  const scanStop = () => { const dd = dragonOf(bot); return !!dd && phaseOf(bot, dd) === PHASE.SCANNING && !blindKnown(sitRec) && !turnSafe(dd, bot.entity.position) }
  const near = off < 8 && Math.abs(me.y - plan.feet.y) < 1.2 && clearOfDragon(bot, me, plan.feet, parts)
  let r = near ? await stepTo(bot, ctl, plan.feet, { ms: 3000, sprint: off > 3, stopAt: 0.15, clouds: true, stop: scanStop }) : { ok: false }
  if (scanStop()) return { ok: false, why: 'высматривает — голова пойдёт к нам' }
  if (!r.ok) {
    const g = new Vec3(plan.B.x + 0.5, plan.y, plan.B.z + 0.5)
    r = await walkTo(session, ctl, g, { range: 0.3, timeoutMs: 8000, hazards: true, stopIf: () => scanStop() ? 'высматривает — голова пойдёт к нам' : null })
    if (Math.hypot(bot.entity.position.x - g.x, bot.entity.position.z - g.z) > 0.7) return { ok: false, why: r.why || 'не дошёл' }
    await stepTo(bot, ctl, plan.feet, { ms: 900, sprint: false, stopAt: 0.12, clouds: false })
  }
  clearControls(bot)
  const p = bot.entity.position
  if (Math.hypot(p.x - plan.feet.x, p.z - plan.feet.z) > 0.5 || Math.abs(p.y - plan.y) > 0.3) {
    // Чуть не дошёл/проскочил — ещё шаг клавишами.
    await stepTo(bot, ctl, plan.feet, { ms: 700, sprint: false, stopAt: 0.12, clouds: false })
    clearControls(bot)
    const q = bot.entity.position
    if (Math.hypot(q.x - plan.feet.x, q.z - plan.feet.z) > 0.5 || Math.abs(q.y - plan.y) > 0.3) return { ok: false, why: 'не на месте' }
  }
  return { ok: true }
}
// Пол, кровать, заслон. { ok, why }.
async function bedsBuild (session, ctl, stats, plan) {
  const bot = session.bot
  const at = (c, y) => new Vec3(c.x, y, c.z)
  for (const f of plan.fills) {
    doing(ctl, 'beds:fill')
    const r = await placeNoBed(bot, f, { timeoutMs: 1200 })
    if (!r.ok) return { ok: false, why: `пол не встал: ${r.reason || r.why}` }
    stats.bedBlocks = (stats.bedBlocks || 0) + 1
  }
  if (!plan.reuse) {
    doing(ctl, 'beds:bed')
    // Изголовье ляжет по взгляду (BedBlock.getStateForPlacement: FACING —
    // горизонталь взгляда из последнего пакета движения): взгляд, тик, клик.
    const r = await placeBedAt(bot, plan.F, plan.H, plan.y)
    if (!r.ok) return r
  }
  const w = bot.blockAt(at(plan.W, plan.y))
  if (!w || !isSolid(w)) {
    doing(ctl, 'beds:wall')
    const r = await placeNoBed(bot, at(plan.W, plan.y), { timeoutMs: 1200 })
    if (!r.ok) return { ok: false, why: `заслон не встал: ${r.reason || r.why}` }
    stats.bedBlocks = (stats.bedBlocks || 0) + 1
  }
  return { ok: true }
}
// Щелчок и свидетель: урон по дракону с причиной «кровать» (damage_event).
async function bedsBoom (session, ctl, stats, plan, hit, why, opts = {}) {
  const bot = session.bot
  const d = dragonOf(bot)
  const wpn = items.bestWeapon(bot)
  if (!opts.keepHand && wpn && (!bot.heldItem || /_bed$|glowstone|respawn_anchor/.test(bot.heldItem.name))) await bot.equip(wpn, 'hand').catch(() => {})
  if (opts.phCheck && d && !opts.phCheck(phaseOf(bot, d))) return { ok: false, why: 'фаза уже не та' }
  const ph = d ? phaseOf(bot, d) : null
  const before = d ? hpOf(bot, d) : null
  const me0 = bot.health
  let boomAt = 0
  const onDmg = pk => { if (d && pk && pk.entityId === d.id && DAMAGE_TYPES[pk.sourceTypeId] === 'bad_respawn_point' && !boomAt) boomAt = gameClock.now() }
  bot._client.on('damage_event', onDmg)
  // Свидетель клиента (02.10, rs1: 14 из 25 ставок+щелчков R без взрыва и без причины в трассе): что сервер прислал по клеткам
  // кровати (ставка встала? снесена?), взрыв, телепорт; рука, крадучись, тело дракона против клетки F (коробка 16×8 мешает ставке).
  const wit = { blk: [] }; const tw0 = gameClock.now()
  const watch = opts.prePlace || hit.runnerGuard ? new Set([`${plan.H.x},${plan.y},${plan.H.z}`, ...(opts.prePlace ? [`${opts.prePlace.pos.x + opts.prePlace.face.x},${plan.y},${opts.prePlace.pos.z + opts.prePlace.face.z}`] : [])]) : null
  const onBlk = (o, n) => { if (watch && n && watch.has(`${n.position.x},${n.position.y},${n.position.z}`) && wit.blk.length < 8) wit.blk.push([gameClock.now() - tw0, n.position.x, n.position.z, n.name]) }
  const onExp = pk => { if (!wit.exp) wit.exp = gameClock.now() - tw0 }
  const onTp = () => { wit.tp = (wit.tp || 0) + 1 }
  if (watch) { bot.on('blockUpdate', onBlk); bot._client.on('explosion', onExp); bot._client.on('position', onTp) }
  const unwatch = () => { if (watch) { bot.removeListener('blockUpdate', onBlk); bot._client.removeListener('explosion', onExp); bot._client.removeListener('position', onTp) } }
  if (watch) {
    const hi = bot.heldItem; const q0 = bot.entity.position
    wit.hand = hi ? `${hi.name}x${hi.count}` : null; wit.sneak = !!bot.getControlState('sneak'); wit.g = !!bot.entity.onGround
    wit.me = [r1(q0.x), r1(q0.y), r1(q0.z)]
    if (d) { wit.body = [r1(d.position.x), r1(d.position.y), r1(d.position.z)]; wit.inBox = Math.abs(d.position.x - 0.5) < 8.5 && Math.abs(d.position.z - 0.5) < 8.5 && d.position.y < plan.y + 0.5625 && d.position.y + 8 > plan.y }
  }
  doing(ctl, `beds:click:${why}`)
  if (ctl.trace) ctl.trace.ev('bed', { ph, why, dist: plan.dist, expect: plan.expect, dragonHp: before, me: me0, D: [plan.D.x, plan.D.z], y: plan.y, at: [plan.H.x, plan.y, plan.H.z], ...(opts.note || {}) })
  let tc = gameClock.now()
  let tcWall = gameClock.wall.now()
  const failW = (w) => { unwatch(); if (watch && ctl.trace) { const dc = dragonOf(bot); if (dc) wit.body2 = [r1(dc.position.x), r1(dc.position.y), r1(dc.position.z)]; ctl.trace.ev('bedFail', { why: w, ...wit, ...(opts.note || {}) }) } return { ok: false, why: w } }
  try { const sent = await clickBedAt(bot, hit, { aimed: !!opts.aimed, until: opts.until || 0, prePlace: opts.prePlace || null }); if (sent === false) { bot._client.removeListener('damage_event', onDmg); return failW('R: поздняя проверка безопасности' + (hit.guardWhy ? ': ' + hit.guardWhy : '')) } tc = gameClock.now(); tcWall = gameClock.wall.now(); wit.sentMs = tc - tw0 } catch (e) { dbg('beds click', e.message) }
  // В тик щелчка (01.10): голова по клиенту — расстояние от центра взрыва (клетка подушки H) и фаза.
  let atClick = null
  try {
    const dc = dragonOf(bot)
    if (dc && plan.H) {
      const pc = partsOf(bot, dc, makeTrack(bot))
      const C = plan.centre || new Vec3(plan.H.x + 0.5, plan.y + 0.5, plan.H.z + 0.5)
      atClick = { headNow: r1(pc.headC.distanceTo(C)), phNow: PHASE_RU[phaseOf(bot, dc)] ?? phaseOf(bot, dc) }
    }
  } catch {}
  if (opts.afterClick) { try { await opts.afterClick() } catch (e) { dbg('afterClick', e.message) } }
  while (!boomAt && gameClock.now() - tc < 700) await sleep(25)
  bot._client.removeListener('damage_event', onDmg)
  await sleep(120)
  const nameAt = (bot.blockAt(new Vec3(plan.H.x, plan.y, plan.H.z)) || {}).name || ''
  const gone = plan.anchor ? nameAt !== 'respawn_anchor' : !/_bed$/.test(nameAt)
  if (!gone && !boomAt) return failW('щёлкнул — не взорвалась')
  // ставка+взрыв в одном тике (ND_PLACE_CLICK): кровать не встала — урона нет и кровать в рюкзаке, это не трата (fs1: 6
  // «нулевых» bedDone, B/s16 и s28 насчитали 7 кроватей при 6 взрывах)
  if (opts.prePlace && !boomAt) return failW('ставка не прошла')
  unwatch()
  stats.lastBoom = boomAt || tc
  const dd = dragonOf(bot)
  const after = dd ? hpOf(bot, dd) : 0
  const dmg = before != null && after != null ? Math.max(0, before - after) : null
  // Толчок сидящему (скорость заморожена и копит толчки — взлёт с ними): для прогноза взлёта (T1).
  if (dd && SITTING.has(phaseOf(bot, dd)) && plan.centre) { const fx = sitFix.get(dd.id); if (fx && fx.pushes) fx.pushes.push({ centre: plan.centre.clone(), seen: plan.seen != null ? plan.seen : 1 }) }
  // Снижение (L): урон не в сидячий счёт — только запомнить хп.
  if (dd && opts.uncounted) { const h = hpOf(bot, dd); if (h != null) sitAcc.hp = h; sitAcc.sitting = false } else if (dd) noteSitDamage(bot, dd, phaseOf(bot, dd))
  stats.bedsUsed = (stats.bedsUsed || 0) + 1
  if (dmg) stats.dmg += dmg
  const rec = { ph: PHASE_RU[ph] ?? ph, why, dist: plan.dist, expect: plan.expect, dmg: dmg != null ? r1(dmg) : null, self: r1(Math.max(0, me0 - bot.health)), took: dd ? phaseOf(bot, dd) === PHASE.TAKEOFF : false, lagMs: boomAt ? boomAt - tc : null, sent: tc, sentWall: tcWall, tickRate: gameClock.snapshot()?.tickRate ?? 20, ...(opts.note || {}), ...(atClick || {}) }
  console.log(`[bed] ${why}: фаза ${rec.ph}${atClick ? '/' + atClick.phNow : ''}, голова ${atClick ? atClick.headNow : '?'} бл. (прогноз ${plan.dist}), урон ${rec.dmg} (ждали ${plan.expect}), нам ${rec.self}`)
  stats.beds.push(rec)
  if (ctl.trace) ctl.trace.ev('bedDone', rec)
  dbg('beds boom', JSON.stringify(rec))
  return { ok: true, ...rec }
}
// ------------------------------------------------------------ двойная станция
//
// Посадка «A/B + C» (2026-09-30): X — кровать под головой сидящего (A — первая,
// ≤ 50 сидячего урона, B — вторая, взлёт), C — кровать впереди по взгляду, где
// голова будет через 10 тиков взлёта (~4.5 блока вперёд, на блок выше — трассы
// 1247 взлётов): её взрыв через 10 тиков после B (неуязвимость) в сидячий счёт
// не идёт. Между X и C — щит (взрыв X не сносит C: лучи гаснут в блоке), он же
// крышка для облака огня (центр в 2.5 перед головой, радиус 5 — ложится на
// верх первого непустого блока: на щит в два блока, выше нас). Мы — сбоку, в
// 2.5–5 блоках от середины, за стенкой в блок у своей клетки; щёлкаем по
// видимой части верха кровати поверх стенки, лучи взрыва к нижним четырём
// рядам точек нашей коробки режет стенка.
const CARD4 = [{ x: 1, z: 0 }, { x: -1, z: 0 }, { x: 0, z: 1 }, { x: 0, z: -1 }]
function cardOf (vx, vz) { return Math.abs(vx) >= Math.abs(vz) ? { x: Math.sign(vx) || 1, z: 0 } : { x: 0, z: Math.sign(vz) || 1 } }
// Клетки, которые горизонтальный отрезок a→b проходит (без концевых клеток).
function cellsOnSeg (a, b) {
  const out = new Map()
  const n = Math.max(1, Math.ceil(Math.hypot(b.x - a.x, b.z - a.z) / 0.1))
  const a0 = `${Math.floor(a.x)},${Math.floor(a.z)}`; const b0 = `${Math.floor(b.x)},${Math.floor(b.z)}`
  for (let k = 1; k < n; k++) {
    const x = Math.floor(a.x + (b.x - a.x) * k / n); const z = Math.floor(a.z + (b.z - a.z) * k / n)
    const key = `${x},${z}`
    if (key !== a0 && key !== b0) out.set(key, { x, z })
  }
  return [...out.values()]
}
const SOLID_SHAPE = [[0, 0, 0, 1, 1, 1]]
const BED_SHAPE = [[0, 0, 0, 1, 0.5625, 1]]
// Мир «как будет»: поверх настоящего — наши блоки и кровати (или воздух).
function virtualBot (bot, extra) {
  return {
    ...bot,
    blockAt (p, ...r) {
      const x = Math.floor(p.x); const y = Math.floor(p.y); const z = Math.floor(p.z)
      const k = `${x},${y},${z}`
      if (extra.has(k)) {
        const v = extra.get(k)
        const pos = new Vec3(x, y, z)
        if (v === 'air') return { name: 'air', boundingBox: 'empty', shapes: [], position: pos }
        if (v === 'bed') return { name: 'red_bed', boundingBox: 'block', shapes: BED_SHAPE, position: pos }
        return { name: 'cobblestone', boundingBox: 'block', shapes: SOLID_SHAPE, position: pos }
      }
      return bot.blockAt(p, ...r)
    }
  }
}
// Точки нижних четырёх рядов коробки игрока (ServerExplosion.getSeenPercent:
// шаг 1/(0.6·2+1) по x/z, 1/(1.8·2+1) по высоте) — все ли закрыты от центра.
const SEEN_XZ = [-0.255, 0.018, 0.29]
const SEEN_Y = [0, 0.391, 0.783, 1.174]
function lowRowsOpen (vbot, feet, centre) {
  let open = 0
  for (const fy of SEEN_Y) {
    for (const ox of SEEN_XZ) {
      for (const oz of SEEN_XZ) {
        const p = new Vec3(feet.x + ox, feet.y + fy, feet.z + oz)
        const dv = centre.minus(p); const len = dv.norm()
        if (len < 0.1) { open++; continue }
        if (!pick.blockOnRay(vbot, p, dv.scaled(1 / len), len - 0.02)) open++
      }
    }
  }
  return open
}
// Видимая точка на верхе кровати (клетки cells, уровень y) из глаз eye.
function bedPointFrom (vbot, eye, cells, y, far) {
  const grid = [0.85, 0.7, 0.5, 0.3, 0.15]
  for (const c of cells) {
    for (const a of grid) {
      for (const s of [0.5, 0.25, 0.75]) {
        // a — дальше от нас по главной оси взгляда (far), s — поперёк.
        const P = new Vec3(c.x + (far.x ? (far.x > 0 ? a : 1 - a) : s), y + BED_TOP, c.z + (far.z ? (far.z > 0 ? a : 1 - a) : s))
        const dv = P.minus(eye); const len = dv.norm()
        if (len > 4.4 || len < 0.5) continue
        const hit = pick.blockOnRay(vbot, eye, dv.scaled(1 / len), len + 0.05)
        if (hit && /_bed$/.test(hit.block.name) && Math.abs(hit.t - len) < 0.04 && hit.pos.x === c.x && hit.pos.z === c.z) return P
      }
    }
  }
  return null
}
function bedsDouble (bot, d, parts, { brave = false, skip = null, fixS = null, cap = null } = {}) {
  const me = bot.entity.position
  const at = (x, y, z) => bot.blockAt(new Vec3(x, y, z))
  const solidOk = b => isSolid(b) && !/_bed$|portal|gateway/.test(b.name)
  const hp0 = new Vec3(parts.headC.x, parts.head.min.y, parts.headC.z)
  // Взлёт (трассы, 1300 взлётов, an-takeoffdir.js): первые 0.5 с тело почти на
  // месте, дракон поворачивается к узлу пути — голова уходит вбок на ~3 (медиана),
  // вдоль взгляда −0.8, в случайную сторону. Лучшее место для C — рядом с местом
  // головы сидя, в 2–3 клетках от X (через щит).
  const hpC = new Vec3(hp0.x, hp0.y + 0.4, hp0.z)
  const mid = { x: (hp0.x + hpC.x) / 2, z: (hp0.z + hpC.z) / 2 }
  const nearY = Math.floor(hp0.y) - 3
  const clouds = cloudsOf(bot)
  const ph = phaseOf(bot, d)
  const breath = SITTING.has(ph) && !blindKnown(sitRec) ? breathOf(bot, d, parts) : null
  const why = {}
  const no = k => { why[k] = (why[k] || 0) + 1 }
  const bodyBoxes = [inflate(parts.head, 0.1), inflate(parts.neck, 0.1), inflate(parts.body, 0.1)]
  // Кровать на (foot, head) уровня y: клетки свободны, пол под изножьем есть или
  // досыпается, не в коробках дракона.
  const bedCells = (F, H, y) => {
    const fb = at(F.x, y, F.z); const hb = at(H.x, y, H.z)
    // Своя кровать уже лежит так, как надо (изголовье в H) — взять её.
    if (fb && hb && /_bed$/.test(fb.name) && /_bed$/.test(hb.name)) {
      let part = null
      try { part = hb.getProperties ? hb.getProperties().part : null } catch {}
      return part === 'head' || part == null ? { fill: null, reuse: true } : null
    }
    if (!bedCellFree(fb) || !bedCellFree(hb)) return null
    const bb = { min: new Vec3(Math.min(H.x, F.x), y, Math.min(H.z, F.z)), max: new Vec3(Math.max(H.x, F.x) + 1, y + BED_TOP, Math.max(H.z, F.z) + 1) }
    if (bodyBoxes.some(b => overlap(bb, b))) return null
    const fl = at(F.x, y - 1, F.z)
    if (!fl) return null
    if (solidOk(fl)) return { fill: null }
    if (!isAirish(fl) && !/fire/.test(fl.name)) return null
    const nb = [[0, -1, 0], [1, 0, 0], [-1, 0, 0], [0, 0, 1], [0, 0, -1]].some(([a, b, e]) => solidOk(at(F.x + a, y - 1 + b, F.z + e)))
    return nb ? { fill: new Vec3(F.x, y - 1, F.z) } : null
  }
  // Лучшие варианты кровати у точки hp (голова) для места с глазами eye.
  const bedOpts = (hp, feet, y, lim) => {
    const out = []
    for (let ox = -2; ox <= 2; ox++) {
      for (let oz = -2; oz <= 2; oz++) {
        const F = { x: Math.floor(hp.x) + ox, z: Math.floor(hp.z) + oz }
        // Изголовье ляжет по взгляду от нас на пол под изножьем (BedBlock.getStateForPlacement).
        const f = cardOf(F.x + 0.5 - feet.x, F.z + 0.5 - feet.z)
        const H = { x: F.x + f.x, z: F.z + f.z }
        const centre = new Vec3(H.x + 0.5, y + 0.5, H.z + 0.5)
        const dist = centre.distanceTo(hp)
        if (dist > lim) continue
        if (Math.max(Math.abs(F.x - Math.floor(feet.x)), Math.abs(F.z - Math.floor(feet.z))) < 2) continue
        const c = bedCells(F, H, y)
        if (!c) continue
        if (c.fill && !fillPlaceable(bot, c.fill, feet.offset(0, SNEAK_EYE, 0))) continue
        out.push({ F, H, f, centre, dist: r1(dist), expect: bedDamage(dist), fill: c.fill, reuse: !!c.reuse })
      }
    }
    return out.sort((a, b) => b.expect - a.expect)
  }
  let best = null
  for (let ox = -6; ox <= 6; ox++) {
    for (let oz = -6; oz <= 6; oz++) {
      const S = { x: Math.floor(mid.x) + ox, z: Math.floor(mid.z) + oz }
      if (fixS && (S.x !== fixS.x || S.z !== fixS.z)) continue
      const rS = Math.hypot(S.x + 0.5 - mid.x, S.z + 0.5 - mid.z)
      if (!fixS && (rS < 2.5 || rS > 5.2)) continue
      const y = standY(bot, S.x + 0.5, S.z + 0.5, nearY, 2, 3)
      if (y == null) { no('нет земли'); continue }
      if (/fire/.test((at(S.x, y, S.z) || {}).name || '')) { no('огонь'); continue }
      if (!solidOk(at(S.x, y - 1, S.z))) { no('пол под нами'); continue }
      // Задняя кромка — прочь от середины между кроватями.
      const ux = (S.x + 0.5 - mid.x) / (rS || 1); const uz = (S.z + 0.5 - mid.z) / (rS || 1)
      const bx = Math.round(ux); const bz = Math.round(uz)
      const backFree = !isSolid(at(S.x + bx, y, S.z + bz)) && !isSolid(at(S.x + bx, y + 1, S.z + bz))
      const feet = new Vec3(S.x + 0.5 + (backFree ? ux * 0.2 : 0), y, S.z + 0.5 + (backFree ? uz * 0.2 : 0))
      if (nearPortal(feet)) { no('чаша портала'); continue }
      if (hurtNear(playerBox(feet), parts)) { no('коробки дракона'); continue }
      if (!(SITTING.has(ph) && blindKnown(sitRec)) && !turnSafe(d, feet)) { no('в круге поворота головы'); continue }
      if (!brave && inClouds(clouds, feet, 1.0)) { no('облако'); continue }
      const eye = feet.offset(0, EYE, 0)
      // Первая кровать посадки — не выше cap (сидячий счёт > 50 — сразу взлёт).
      const xs = bedOpts(hp0, feet, y, 3.6).sort((a, b) => (b.expect - (cap != null && b.expect > cap ? (b.expect - cap) * 3 : 0)) - (a.expect - (cap != null && a.expect > cap ? (a.expect - cap) * 3 : 0))).slice(0, 4)
      const csAll = bedOpts(hpC, feet, y, 4.2)
      if (!xs.length) { no('нет места под головой'); continue }
      if (!csAll.length) { no('нет места для C'); continue }
      const walk = Math.hypot(feet.x - me.x, feet.z - me.z) + Math.abs(feet.y - me.y) * 2
      for (const X of xs) {
        // C — не ближе двух клеток к X (между ними щит).
        const cs = csAll.filter(C => ![C.F, C.H].some(a => [X.F, X.H].some(b => Math.max(Math.abs(a.x - b.x), Math.abs(a.z - b.z)) < 2))).slice(0, 4)
        for (const C of cs) {
          if (skip && skip.has(`${X.H.x},${X.H.z}|${C.H.x},${C.H.z}`)) continue
          const xc = [X.F, X.H]; const cc = [C.F, C.H]
          if (xc.some(a => cc.some(b => Math.max(Math.abs(a.x - b.x), Math.abs(a.z - b.z)) < 2))) { no('кровати тесно'); continue }
          const key = c => `${c.x},${c.z}`
          const taken = new Set([...xc, ...cc, S].map(key))
          // Стенка — клетки у нашей (8 соседей), через которые идут отрезки к кроватям.
          const walls = new Map()
          for (const t of [...xc, ...cc]) {
            for (const w of cellsOnSeg({ x: feet.x, z: feet.z }, { x: t.x + 0.5, z: t.z + 0.5 })) {
              if (Math.max(Math.abs(w.x - S.x), Math.abs(w.z - S.z)) === 1 && !taken.has(key(w))) walls.set(key(w), w)
            }
          }
          // Щит между X и C — клетки на отрезках от центра X к клеткам C.
          const shield = new Map()
          for (const t of cc) for (const w of cellsOnSeg({ x: X.H.x + 0.5, z: X.H.z + 0.5 }, { x: t.x + 0.5, z: t.z + 0.5 })) if (!taken.has(key(w)) && !walls.has(key(w))) shield.set(key(w), w)
          for (const t of cc) for (const w of cellsOnSeg({ x: X.F.x + 0.5, z: X.F.z + 0.5 }, { x: t.x + 0.5, z: t.z + 0.5 })) if (!taken.has(key(w)) && !walls.has(key(w))) shield.set(key(w), w)
          if (!shield.size) { no('щиту нет места'); continue }
          // Крышка облака огня: мы в круге облака — его колонка в два блока (облако
          // ляжет на её верх, выше нас).
          let lid = null
          if (breath && Math.hypot(feet.x - breath.pos.x, feet.z - breath.pos.z) < BREATH_R + 1) {
            const bc = breath.column
            if (taken.has(key(bc)) || walls.has(key(bc))) { no('крышка на клетке станции'); continue }
            const gy = standY(bot, bc.x + 0.5, bc.z + 0.5, y, 2, 3)
            if (gy == null) { no('крышка: нет земли'); continue }
            const h = Math.max(2, Math.ceil(y + 1.85 - gy))
            lid = { x: bc.x, z: bc.z, y: gy, h }
          }
          // Что поставить: всё должно встать в воздух (или уже стоять).
          const place = []
          let bad = false
          const want = (x, yy, z) => { const b = at(x, yy, z); if (!b) { bad = true; return } if (solidOk(b)) return; if (!bedCellFree(b)) { bad = true; return } place.push(new Vec3(x, yy, z)) }
          for (const w of walls.values()) want(w.x, y, w.z)
          for (const w of shield.values()) want(w.x, y, w.z)
          if (lid) for (let k = 0; k < lid.h; k++) want(lid.x, lid.y + k, lid.z)
          if (bad) { no('клетка стенки/щита занята'); continue }
          for (const w of walls.values()) if (!isAirish(at(w.x, y + 1, w.z))) bad = true
          if (bad) { no('над стенкой блок'); continue }
          // Каждый блок ставится честно: грань опоры видно из глаз и до неё ≤ 4.5
          // (b2, попытка 2: «щит/крышка не встали — не к чему прислонить»: щит
          // был в 5+ блоках). Верхний блок столбика — на нижний.
          const placeSet = new Set(place.map(p => `${p.x},${p.y},${p.z}`))
          const lidSet = new Set(lid ? Array.from({ length: lid.h }, (_, k) => `${lid.x},${lid.y + k},${lid.z}`) : [])
          const seye = feet.offset(0, SNEAK_EYE, 0)
          if (place.some(p => lidSet.has(`${p.x},${p.y},${p.z}`) && !placeSet.has(`${p.x},${p.y - 1},${p.z}`) && !fillPlaceable(bot, p, seye))) { no('до крышки не дотянуться'); continue }
          // Виртуальный мир: стенка, щит, крышка, кровати.
          const extra = new Map()
          const put = (x, yy, z, v) => extra.set(`${x},${yy},${z}`, v)
          // Кровати ставятся после крышки и досыпки, до щита и стенки: пол под
          // изножьями должен быть виден и с крышкой (b3-25: «C: пол под изножьем не видно»).
          if (lid) for (let k = 0; k < lid.h; k++) put(lid.x, lid.y + k, lid.z, 'block')
          for (const f of [X.fill, C.fill]) if (f) put(f.x, f.y, f.z, 'block')
          {
            const vb0 = virtualBot(bot, extra)
            const up = new Vec3(0, 1, 0)
            if (!C.reuse && !pick.faceAim(vb0, new Vec3(C.F.x, y - 1, C.F.z), up, { eye, avoid: [] })) { no('пол под C не видно'); continue }
            for (const c of cc) put(c.x, y, c.z, 'bed')
            if (!X.reuse && !pick.faceAim(virtualBot(bot, extra), new Vec3(X.F.x, y - 1, X.F.z), up, { eye, avoid: [] })) { no('пол под X не видно'); continue }
            // Щит и стенка — после кроватей: грань опоры каждого видна и ≤ 4.5
            // (b3: «щит не встал — не к чему прислонить», щит за кроватью).
            for (const c of xc) put(c.x, y, c.z, 'bed')
            const vb1 = virtualBot(bot, extra)
            const later = place.filter(p => !lidSet.has(`${p.x},${p.y},${p.z}`)).sort((a, b) => (walls.has(`${a.x},${a.z}`) ? 1 : 0) - (walls.has(`${b.x},${b.z}`) ? 1 : 0))
            let unreach = false
            for (const p of later) {
              if (!fillPlaceable(vb1, p, feet.offset(0, SNEAK_EYE, 0))) { unreach = true; break }
              put(p.x, p.y, p.z, 'block')
            }
            if (unreach) { no('до щита/стенки не дотянуться'); continue }
          }
          for (const p of place) put(p.x, p.y, p.z, 'block')
          for (const f of [X.fill, C.fill]) if (f) put(f.x, f.y, f.z, 'block')
          for (const c of xc) put(c.x, y, c.z, 'bed')
          for (const c of cc) put(c.x, y, c.z, 'bed')
          const vb = virtualBot(bot, extra)
          const far = (T) => cardOf(T.H.x + 0.5 - feet.x, T.H.z + 0.5 - feet.z)
          if (!bedPointFrom(vb, eye, [X.H, X.F], y, far(X))) { no('X не видно'); continue }
          // X взорвалась: её клетки — воздух.
          for (const c of xc) put(c.x, y, c.z, 'air')
          if (!bedPointFrom(vb, eye, [C.H, C.F], y, far(C))) { no('C не видно'); continue }
          if (lowRowsOpen(vb, feet, X.centre) > 0) { no('взрыв X видит нас'); continue }
          // C цела после X: все лучи от центра X к кровати C упираются в блоки.
          let cOpen = false
          for (const c of cc) for (const hy of [0.12, 0.45]) {
            const q = new Vec3(c.x + 0.5, y + hy, c.z + 0.5)
            const dv = q.minus(X.centre); const len = dv.norm()
            const hit = pick.blockOnRay(vb, X.centre, dv.scaled(1 / len), len - 0.05)
            if (!hit || /_bed$/.test(hit.block.name)) cOpen = true
          }
          if (cOpen) { no('щит не закрывает C'); continue }
          for (const c of cc) put(c.x, y, c.z, 'air')
          if (lowRowsOpen(vb, feet, C.centre) > 0) { no('взрыв C видит нас'); continue }
          const nPlace = place.length + (X.fill ? 1 : 0) + (C.fill ? 1 : 0)
          const xOver = cap != null && X.expect > cap ? (X.expect - cap) * 3 : 0
          const cost = -(X.expect + C.expect) + xOver + nPlace * 0.7 + walk * 1.2
          if (!best || cost < best.cost) {
            best = { S, y, feet, X, C, walls: [...walls.values()], shield: [...shield.values()], lid, place, nPlace, walk: r1(walk), cost, key: `${X.H.x},${X.H.z}|${C.H.x},${C.H.z}` }
          }
        }
      }
    }
  }
  bedsDouble.why = best ? null : why
  return best
}

// Кровать изножьем на F, изголовьем на H (по взгляду: смотрим на пол под F).
async function placeBedAt (bot, F, H, y) {
  const floor = bot.blockAt(new Vec3(F.x, y - 1, F.z))
  if (!floor || !isSolid(floor)) return { ok: false, why: 'нет пола под изножьем' }
  if (!pick.faceAim(bot, floor.position, new Vec3(0, 1, 0))) return { ok: false, why: 'пол под изножьем не видно' }
  try {
    await bot.equip(findItem(bot, /_bed$/), 'hand')
    await bot.lookAt(floor.position.offset(0.5, 1, 0.5), true)
    await new Promise(resolve => bot.once('physicsTick', resolve))
    // В руке должна быть кровать: иначе «кровать» встаёт булыжником досыпки
    // (b4, попытка 2: «кровать не встала (air/cobblestone)»).
    if (!bot.heldItem || !/_bed$/.test(bot.heldItem.name)) {
      await bot.equip(findItem(bot, /_bed$/), 'hand')
      await new Promise(resolve => bot.once('physicsTick', resolve))
      if (!bot.heldItem || !/_bed$/.test(bot.heldItem.name)) return { ok: false, why: 'кровать не в руке' }
    }
    await build.withTimeout(bot.placeBlock(floor, new Vec3(0, 1, 0)), 1500)
  } catch (e) { dbg('beds bed', e.message) }
  await sleep(60)
  const h = bot.blockAt(new Vec3(H.x, y, H.z)); const f = bot.blockAt(new Vec3(F.x, y, F.z))
  if (h && /_bed$/.test(h.name) && f && /_bed$/.test(f.name)) return { ok: true }
  return { ok: false, why: `кровать не встала (${h ? h.name : '?'}/${f ? f.name : '?'})` }
}
// Двойная станция: досыпка, кровати C и X, щит и крышка, стенка у нас (последней:
// с ней пол под изножьями уже не видно).
async function doubleBuild (session, ctl, stats, plan) {
  const bot = session.bot
  // Крышка облака огня — первой: облако встаёт на 10-м тике огня (через 2.5 с
  // после рёва) и ложится на верх первого непустого блока в своей колонке.
  if (plan.lid) {
    for (let k = 0; k < plan.lid.h; k++) {
      const p = new Vec3(plan.lid.x, plan.lid.y + k, plan.lid.z)
      if (isSolid(bot.blockAt(p))) continue
      doing(ctl, 'beds:lid')
      const r = await placeNoBed(bot, p, { timeoutMs: 1200 })
      if (!r.ok) return { ok: false, why: `крышка не встала: ${r.reason || r.why}` }
      stats.bedBlocks = (stats.bedBlocks || 0) + 1
    }
  }
  for (const T of [plan.C, plan.X]) {
    const h = bot.blockAt(new Vec3(T.H.x, plan.y, T.H.z)); const f = bot.blockAt(new Vec3(T.F.x, plan.y, T.F.z))
    if (h && /_bed$/.test(h.name) && f && /_bed$/.test(f.name)) continue
    if (T.fill && !isSolid(bot.blockAt(T.fill))) {
      doing(ctl, 'beds:fill')
      const r = await placeNoBed(bot, T.fill, { timeoutMs: 1200 })
      if (!r.ok) return { ok: false, why: `пол не встал: ${r.reason || r.why}` }
      stats.bedBlocks = (stats.bedBlocks || 0) + 1
    }
    doing(ctl, T === plan.C ? 'beds:bedC' : 'beds:bedX')
    const r = await placeBedAt(bot, T.F, T.H, plan.y)
    if (!r.ok) return { ok: false, why: `${T === plan.C ? 'C' : 'X'}: ${r.why}` }
  }
  const wallKeys = new Set(plan.walls.map(w => `${w.x},${w.z}`))
  const order = [...plan.place].sort((a, b) => (wallKeys.has(`${a.x},${a.z}`) ? 1 : 0) - (wallKeys.has(`${b.x},${b.z}`) ? 1 : 0) || a.y - b.y)
  for (const p of order) {
    if (ctl.aborted) return { ok: false, why: 'прервано' }
    if (isSolid(bot.blockAt(p))) continue
    doing(ctl, wallKeys.has(`${p.x},${p.z}`) ? 'beds:wall' : 'beds:shield')
    const r = await placeNoBed(bot, p, { timeoutMs: 1200 })
    if (!r.ok) return { ok: false, why: `${wallKeys.has(`${p.x},${p.z}`) ? 'стенка' : 'щит'} не встал: ${r.reason || r.why}` }
    stats.bedBlocks = (stats.bedBlocks || 0) + 1
  }
  return { ok: true }
}
// Прямо сейчас (настоящий мир, клетки взрывающейся кровати — воздух): закрыты
// ли нижние четыре ряда точек нашей коробки от центра взрыва. Прошлый взрыв
// сносит стенку — b3-26 (30.09, 125.6 с): C без стенки — 17.6 себе.
function exposedNow (bot, y, T) {
  const extra = new Map()
  for (const c of [T.H, T.F]) extra.set(`${c.x},${y},${c.z}`, 'air')
  return lowRowsOpen(virtualBot(bot, extra), bot.entity.position, T.centre)
}
async function shieldFor (session, ctl, stats, plan, T) {
  const bot = session.bot
  if (!exposedNow(bot, plan.y, T)) return true
  for (const w of plan.walls || []) {
    const p = new Vec3(w.x, plan.y, w.z)
    if (isSolid(bot.blockAt(p))) continue
    doing(ctl, 'beds:wall-fix')
    const r = await placeNoBed(bot, p, { timeoutMs: 1000 })
    if (r.ok) stats.bedBlocks = (stats.bedBlocks || 0) + 1
  }
  return !exposedNow(bot, plan.y, T)
}
function doubleHit (bot, plan, T) {
  const eye = bot.entity.position.offset(0, EYE, 0)
  const far = cardOf(T.H.x + 0.5 - eye.x, T.H.z + 0.5 - eye.z)
  const P = bedPointFrom(bot, eye, [T.H, T.F], plan.y, far)
  if (!P) return null
  const block = bot.blockAt(new Vec3(Math.floor(P.x), plan.y, Math.floor(P.z)))
  return block && /_bed$/.test(block.name) ? { block, point: P } : null
}
// Посадка двойной станцией: A (≤ cap) и B по X, C на взлёте. { ok, why, booms }.
async function doubleRun (session, ctl, rep, stats, track, P, plan0) {
  const bot = session.bot
  let plan = plan0
  const onSpot = () => { const p = bot.entity.position; return Math.hypot(p.x - plan0.feet.x, p.z - plan0.feet.z) < 0.55 && Math.abs(p.y - plan0.y) < 0.3 }
  const g = await bedsGo(session, ctl, { feet: plan.feet, B: plan.S, y: plan.y }, bot.health >= 16, partsOf(bot, dragonOf(bot), track))
  if (!g.ok) return { ok: false, why: g.why }
  ctl.holdStation = true
  try { return await doubleRunAt(session, ctl, rep, stats, track, P, plan, onSpot) } finally { ctl.holdStation = false }
}
async function doubleRunAt (session, ctl, rep, stats, track, P, plan, onSpot) {
  const bot = session.bot
  const b = await doubleBuild(session, ctl, stats, plan)
  if (!b.ok) return b
  if (ctl.trace) ctl.trace.ev('double', { S: [plan.S.x, plan.y, plan.S.z], X: [plan.X.H.x, plan.X.H.z, plan.X.expect], C: [plan.C.H.x, plan.C.H.z, plan.C.expect], n: plan.nPlace })
  // C лежит — её можно взорвать на взлёте и после кровати из запасного плана.
  stats.pendingC = { C: plan.C, y: plan.y, plan }
  let booms = 0
  for (let k = 0; k < 3 && !ctl.aborted; k++) {
    while (!ctl.aborted && gameClock.now() < (stats.lastBoom || 0) + BED_GAP_MS) await sleep(20)
    const d = dragonOf(bot)
    if (!d) break
    const ph = phaseOf(bot, d)
    if (!SITTING.has(ph)) break
    // Новый круг «высматривает» у видящего: голова доворачивает к нам (мы вне её
    // круга) — ждать рёва и проверить, что голова всё ещё над X.
    if (ph === PHASE.SCANNING && !blindKnown(sitRec)) {
      const tw = gameClock.now()
      while (!ctl.aborted && gameClock.now() - tw < 2000) {
        dragonZones(bot)
        const dd = dragonOf(bot)
        if (!dd || phaseOf(bot, dd) !== PHASE.SCANNING || blindKnown(sitRec)) break
        doing(ctl, 'beds:wait-scan')
        await sleep(50)
      }
      k--
      const dd = dragonOf(bot)
      if (!dd || !SITTING.has(phaseOf(bot, dd))) break
      const hd = headPoint(bot, dd, track, 0)
      if (hd.distanceTo(plan.X.centre) > 3.2) return { ok: false, why: 'голова ушла от X', booms }
      continue
    }
    if (bot.health < 8) return { ok: false, why: 'мало хп перед щелчком', booms }
    if (!onSpot()) return { ok: false, why: 'сдвинуло с места', booms }
    if (!(await shieldFor(session, ctl, stats, plan, plan.X))) return { ok: false, why: 'взрыв X видит нас — стенку не поправить', booms }
    const hit = doubleHit(bot, plan, plan.X)
    if (!hit) return { ok: false, why: 'X не видно', booms }
    const boom = await bedsBoom(session, ctl, stats, { H: plan.X.H, y: plan.y, dist: plan.X.dist, expect: plan.X.expect, D: plan.X.f }, hit, 'сидит')
    if (!boom.ok) return { ok: false, why: boom.why, booms }
    booms++
    P.beds.push(boom.dmg)
    const d2 = dragonOf(bot)
    if (!d2 || !SITTING.has(phaseOf(bot, d2))) break
    // Сидит (сидячий счёт ≤ 50): ещё X с того же места — заново план с этой клеткой.
    if (countOf(bot, /_bed$/) < 2) break
    const again = bedsDouble(bot, d2, partsOf(bot, d2, track), { brave: true, fixS: plan.S })
    if (!again) {
      // Нового места под головой нет — та же кровать X, если пол под изножьем цел.
      if (ctl.trace) ctl.trace.ev('bedFail', { why: 'повтор X: плана нет', no: bedsDouble.why })
      const r0 = await placeBedAt(bot, plan.X.F, plan.X.H, plan.y)
      if (!r0.ok) { P.lastWhy = `повтор X: ${r0.why}`; break }
      for (const w of plan.walls) if (!isSolid(bot.blockAt(new Vec3(w.x, plan.y, w.z)))) { const rw = await placeNoBed(bot, new Vec3(w.x, plan.y, w.z), { timeoutMs: 1200 }); if (!rw.ok) { P.lastWhy = 'повтор X: стенка'; break } }
      continue
    }
    plan = again
    stats.pendingC = { C: plan.C, y: plan.y, plan }
    const r = await doubleBuild(session, ctl, stats, plan)
    if (!r.ok) { if (ctl.trace) ctl.trace.ev('bedFail', { why: `повтор X: ${r.why}` }); break }
  }
  if (await tryC(session, ctl, stats, track, P)) booms++
  return { ok: true, booms }
}
// C: взлёт начался от нашей кровати — через 10 тиков неуязвимости голова над C
// (двойная станция; и после запасной одиночной кровати, если C видно отсюда).
async function tryC (session, ctl, stats, track, P) {
  const bot = session.bot
  const pc = stats.pendingC
  const d3 = dragonOf(bot)
  if (!pc || !d3 || phaseOf(bot, d3) !== PHASE.TAKEOFF || gameClock.now() - (stats.lastBoom || 0) > 900) return false
  const hb = bot.blockAt(new Vec3(pc.C.H.x, pc.y, pc.C.H.z))
  if (!hb || !/_bed$/.test(hb.name)) { stats.pendingC = null; return false }
  if (exposedNow(bot, pc.y, pc.C)) { if (ctl.trace) ctl.trace.ev('bedFail', { why: 'C: взрыв видит нас' }); return false }
  while (!ctl.aborted && gameClock.now() < (stats.lastBoom || 0) + BED_GAP_MS) await sleep(15)
  const hit = doubleHit(bot, { y: pc.y }, pc.C)
  if (!hit) { if (ctl.trace) ctl.trace.ev('bedFail', { why: 'C не видно' }); return false }
  const hd = headPoint(bot, d3, track, 0)
  // Голова уже далеко — взрыв впустую (0 урона), а кровать — последняя из запаса.
  if (hd.distanceTo(pc.C.centre) > 7.5) { if (ctl.trace) ctl.trace.ev('bedFail', { why: 'C: голова далеко', dist: r1(hd.distanceTo(pc.C.centre)) }); return false }
  const boom = await bedsBoom(session, ctl, stats, { H: pc.C.H, y: pc.y, dist: r1(hd.distanceTo(pc.C.centre)), expect: pc.C.expect, D: pc.C.f }, hit, 'взлёт')
  stats.pendingC = null
  if (boom.ok) { P.beds.push(boom.dmg); return true }
  return false
}
// Одна посадка: кровати A, B (сидя) и C (взлёт), пока есть кровати и окно.
// Посадка слепого по плану «взлёт» (ocLanding: tk): A (≤ 46), станция L заново (T1), окоп,
// ждать сам-взлёта (99-й тик) — T1 сразу, T2 через (i0 − 1) тиков. B не ставим: его толчок
// поднял бы голову взлёта на G + 4.5…5 (an-takeofffit) и увёл бы её от T2.
async function ocTakeoffRun (session, ctl, rep, stats, track, P, tkP) {
  const bot = session.bot
  const ev = (k, o) => { if (ctl.trace) ctl.trace.ev(k, o) }
  const rec = sitRec
  const t0 = rec && !rec.ended ? rec.t0 : gameClock.now()
  const el = () => gameClock.now() - t0
  const sitting = () => { const dd = dragonOf(bot); return !!dd && SITTING.has(phaseOf(bot, dd)) }
  const out = { A: null, T1: null, T2: null, why: null }
  try {
    // A
    if (tkP.A && el() < 2200 && sitting()) {
      const A = tkP.A
      const g = await bedsGo(session, ctl, A, true, partsOf(bot, dragonOf(bot), track))
      if (g.ok) {
        ctl.holdStation = true
        let b
        try { b = await bedsBuild(session, ctl, stats, A) } finally { ctl.holdStation = false }
        while (!ctl.aborted && gameClock.now() < (stats.lastBoom || 0) + BED_GAP_MS) await sleep(20)
        const hit = b.ok && sitting() ? bedClickPoint(bot, A) : null
        if (hit) { const bo = await bedsBoom(session, ctl, stats, A, hit, 'сидит', { note: { oc: 'A' } }); if (bo.ok) { out.A = bo.dmg; P.beds.push(bo.dmg) } }
      }
    }
    if (!sitting()) { out.why = 'взлетел до T1'; return out }
    // T1: станция L заново (опора/заслон, если снесло, кровать), в окоп
    const danger = () => (!sitting() ? 'взлетел' : el() > 4500 ? 'не успеть до взлёта' : null)
    ctl.holdStation = true
    let tb
    try { tb = await tsBuild(session, ctl, stats, tkP.plan, danger, null) } finally { ctl.holdStation = false }
    if (!tb.ok) { out.why = `T1: ${tb.why}`; return out }
    const hit1 = tsClickPoint(bot, bot.entity.position.offset(0, EYE, 0), tkP.plan)
    const hit2p = tsClickPoint(bot, bot.entity.position.offset(0, EYE, 0), tkP.T2)
    if (!hit1) { out.why = 'T1 не видно'; return out }
    await lookAtSafe(bot, hit1.point)
    await new Promise(resolve => bot.once('physicsTick', resolve))
    doing(ctl, 'tk:wait')
    // сам-взлёт: фаза TAKEOFF
    const tw = gameClock.now()
    while (!ctl.aborted && gameClock.now() - tw < 6000) {
      const dd = dragonOf(bot)
      if (!dd) break
      const ph = phaseOf(bot, dd)
      if (ph === PHASE.TAKEOFF) break
      if (!SITTING.has(ph)) { out.why = `фаза ${PHASE_RU[ph] ?? ph}`; return out }
      await sleep(5)
    }
    const tT1 = gameClock.now()
    const d1 = dragonOf(bot)
    if (!d1 || phaseOf(bot, d1) !== PHASE.TAKEOFF) { out.why = 'взлёта не дождался'; return out }
    const b1 = await bedsBoom(session, ctl, stats, tkP.plan, hit1, 'взлёт', { aimed: true, uncounted: true, note: { oc: 'T1', headDist: r1(tkP.path[1].head.distanceTo(tkP.plan.centre)) } })
    if (b1.ok) { out.T1 = b1.dmg; P.beds.push(b1.dmg) }
    // T2
    const hit2 = tsClickPoint(bot, bot.entity.position.offset(0, EYE, 0), tkP.T2) || hit2p
    if (!hit2) { out.why = 'T2 не видно'; return out }
    await lookAtSafe(bot, hit2.point)
    await new Promise(resolve => bot.once('physicsTick', resolve))
    const tT2 = tT1 + 50 * (tkP.T2.i0 - 1) - 30
    const b2 = await bedsBoom(session, ctl, stats, { ...tkP.T2, reuse: true }, hit2, 'взлёт', { aimed: true, until: Math.max(tT2, (stats.lastBoom || 0) + BED_GAP_MS), uncounted: true, note: { oc: 'T2', headDist: r1(tkP.path[tkP.T2.i0].head.distanceTo(tkP.T2.centre)) } })
    if (b2.ok) { out.T2 = b2.dmg; P.beds.push(b2.dmg) }
    return out
  } finally {
    ev('ocTkRun', out)
    // из окопа
    const q = bot.entity.position
    if (tkP.plan && Math.floor(q.y + 0.01) < tkP.plan.G && Math.floor(q.x) === tkP.plan.B.x && Math.floor(q.z) === tkP.plan.B.z) { await build.towerUp(bot, ctl, tkP.plan.G - Math.floor(q.y + 0.01)).catch(() => {}); clearControls(bot) }
  }
}

// T1 — кровать на сам-взлёт слепого (99 тиков сидения, без B): голова на первом тике взлёта
// почти там же (1.3 вбок, +1 вверх; прогноз по замороженной скорости + толчкам сидя — p90 0.005 бл,
// Codex по rec), а урон не в сидячий счёт. Станция в окопе под этой головой строится сидя после A;
// щелчок — сразу, как фаза сменилась на TAKEOFF (обработается тиком позже: голова — путь[0]).
async function ocT1 (session, ctl, stats, track, d, rec, P) {
  const bot = session.bot
  const ev = (k, o) => { if (ctl.trace) ctl.trace.ev(k, o) }
  const t0 = gameClock.now()
  const out = { why: null }
  const sittingNow = () => { const dd = dragonOf(bot); return !!dd && SITTING.has(phaseOf(bot, dd)) }
  try {
    const fx = sitFix.get(d.id)
    if (!fx || !fx.sit) { out.why = 'нет сидячего состояния'; return out }
    const S = simClone(fx.sit)
    S.x = d.position.x; S.y = d.position.y; S.z = d.position.z; S.yRot = yRotOf(d.yaw)
    for (const pu of fx.pushes || []) { const q = blastPush(S, pu.centre, pu.seen); S.vx += q.x; S.vy += q.y; S.vz += q.z }
    S.hist = new Array(12).fill(S.y); S.inWall = false
    const nodes = dragonNodes(bot)
    const node = nodes && takeoffNode(nodes, S)
    if (!node) { out.why = 'узел взлёта не найден'; return out }
    const path = takeoffForecast(S, node, 4)
    const target = path[0].head
    const sitHead = simHead(S, true); const sitNeck = simNeck(S, true)
    const fcT = { n: 3, path: [{ k: 0, head: path[0].head, neck: path[0].neck, pos: path[0].pos, yRot: path[0].yRot }], sit: S, head: sitHead, neck: sitNeck }
    const sitP = predParts(fcT)
    const left = () => rec.t0 + 4950 - gameClock.now()
    if (left() < 2300) { out.why = `некогда (${left()} мс)`; return out }
    let plan = null; const why = {}
    for (const lift of [2, 1, 0]) {
      const all = []
      tsPlan(bot, target, { lift, fc: fcT, dpos: new Vec3(S.x, S.y, S.z) })
      for (const [k, v] of Object.entries(tsPlan.why || {})) why[k] = (why[k] || 0) + v
      all.push(...(tsPlan.all || []))
      for (const c of all.sort((a, b) => a.cost - b.cost)) {
        const bb = { min: new Vec3(Math.min(c.F.x, c.H.x), c.yb, Math.min(c.F.z, c.H.z)), max: new Vec3(Math.max(c.F.x, c.H.x) + 1, c.yb + 1, Math.max(c.F.z, c.H.z) + 1) }
        if (overlap(bb, inflate(sitP.head, 0.05)) || overlap(bb, inflate(sitP.neck, 0.05)) || overlap(bb, inflate(sitP.body, 0.05))) { why['в сидячих коробках'] = (why['в сидячих коробках'] || 0) + 1; continue }
        const near = q => hurtNear(playerBox(q), sitP) || hurtNear(playerBox(q.offset(0, 1.3, 0)), sitP) || hurtNear(playerBox(q.offset(0.5, 0, 0)), sitP) || hurtNear(playerBox(q.offset(-0.5, 0, 0)), sitP) || hurtNear(playerBox(q.offset(0, 0, 0.5)), sitP) || hurtNear(playerBox(q.offset(0, 0, -0.5)), sitP)
        if (near(c.ground) || near(new Vec3(c.B.x + 0.5, c.G, c.B.z + 0.5))) { why['место ставки у шеи'] = (why['место ставки у шеи'] || 0) + 1; continue }
        if (!plan || c.cost < plan.cost) plan = c
        break
      }
    }
    out.plan = plan ? { H: [plan.H.x, plan.yb, plan.H.z], expect: plan.expect, dist: plan.dist, node: [node.x, node.z] } : { no: why }
    if (!plan) { out.why = 'нет станции'; return out }
    out.st = plan
    ctl.holdStation = true
    let b
    try { b = await tsBuild(session, ctl, stats, plan, () => (!sittingNow() ? 'взлетел' : null), null, { parts: () => partsOf(bot, dragonOf(bot), track) }) } finally { ctl.holdStation = false }
    if (!b.ok) { out.why = `стройка: ${b.why}`; return out }
    const hit = tsClickPoint(bot, bot.entity.position.offset(0, EYE, 0), plan)
    if (!hit) { out.why = 'бок не видно'; return out }
    await lookAtSafe(bot, hit.point)
    await new Promise(resolve => bot.once('physicsTick', resolve))
    doing(ctl, 'oc:waitT1')
    const tw = gameClock.now()
    let took = false
    while (!ctl.aborted && gameClock.now() - tw < 4000) {
      const dd = dragonOf(bot); const ph = dd ? phaseOf(bot, dd) : null
      if (ph === PHASE.TAKEOFF) { took = true; break }
      if (!SITTING.has(ph)) break
      await sleep(3)
    }
    out.wait = gameClock.now() - tw
    if (!took) { out.why = 'взлёта не дождался'; return out }
    const r = await bedsBoom(session, ctl, stats, { ...plan, reuse: true }, hit, 'взлёт', { aimed: true, uncounted: true, phCheck: p => p === PHASE.TAKEOFF, note: { oc: 'T1', headDist: plan.dist } })
    out.dmg = r.ok ? r.dmg : null
    if (r.ok) P.beds.push(r.dmg); else out.why = `щелчок: ${r.why}`
    return out
  } finally {
    const st = out.st
    delete out.st
    out.ms = gameClock.now() - t0
    ev('ocT1', out)
    const q = bot.entity.position
    if (st && Math.floor(q.y + 0.01) < st.G && Math.floor(q.x) === st.B.x && Math.floor(q.z) === st.B.z) { doing(ctl, 'oc:outT1'); await build.towerUp(bot, ctl, st.G - Math.floor(q.y + 0.01)).catch(() => {}); clearControls(bot) }
  }
}
// Видящий: голова после «высматривает» (25 вызовов поворота к нам) стоит рёв 40 + огонь 200 тиков
// (12 с). Уточнить её угол повтором поворота (scanPredict) от посадки к нашему месту на посадке —
// сверить с текущим yaw; совпало (≤ 4°) — взять оттуда замороженный A (отставание головы).
function seeCalibrate (bot, d) {
  const fx = sitFix.get(d.id)
  if (!fx || !fx.sit || fx.calibrated === d.yaw) return fx ? fx.calibOk : false
  const S = simClone(fx.sit)
  S.x = fx.pos.x; S.y = fx.pos.y; S.z = fx.pos.z
  S.yRot = yRotOf(fx.yaw); S.yRotA = fx.yRotA
  const me = fx.me || bot.entity.position
  const pr = scanPredict(S, me, 25)
  const yawNow = yRotOf(d.yaw)
  const dy = Math.abs(wrapDeg(pr.s.yRot - yawNow))
  fx.calibrated = d.yaw
  fx.calibOk = dy <= 4
  fx.yaw = d.yaw
  fx.yRotA = fx.calibOk ? pr.s.yRotA : 0
  fx.scan = { dYaw: r1(dy), A: r1(pr.s.yRotA) }
  return fx.calibOk
}
// Одна станция в окопе у неподвижной головы видящего (рёв/огонь): кровать под головой (lift 1–2,
// не выше P − 1: коробка сидящего 16×8 не даёт ставить выше), окоп и место ставки — вне облака
// огня (центр в 2.5 перед головой, R 5) и не у головы/шеи. cap — первая сидя (≤ 50 − счёт).
async function seeStation (session, ctl, stats, track, d, P, { cap = null } = {}) {
  const bot = session.bot
  const ev = (k, o) => { if (ctl.trace) ctl.trace.ev(k, o) }
  const t0 = gameClock.now()
  const out = { cap }
  try {
    const fx = sitFix.get(d.id)
    const S = { x: d.position.x, y: d.position.y, z: d.position.z, yRot: yRotOf(d.yaw), yRotA: fx ? fx.yRotA : 0, vx: 0, vy: 0, vz: 0, hist: new Array(12).fill(d.position.y) }
    const head = simHead(S, true); const neck = simNeck(S, true)
    const fcS = { n: 0, path: [], sit: S, head, neck }
    const sitP = predParts(fcS)
    const ux = head.x - S.x; const uz = head.z - S.z; const ul = Math.hypot(ux, uz) || 1
    const cloud = { x: head.x + ux / ul * 2.5, z: head.z + uz / ul * 2.5 }
    const inCloud = p => Math.hypot(p.x - cloud.x, p.z - cloud.z) < 5.6
    const Ptop = podiumTop(bot)
    let plan = null; const why = {}
    for (const lift of [2, 1, 0]) {
      tsPlan(bot, head, { lift, fc: fcS, dpos: new Vec3(S.x, S.y, S.z) })
      for (const [k, v] of Object.entries(tsPlan.why || {})) why[k] = (why[k] || 0) + v
      for (const c of (tsPlan.all || []).sort((a, b) => b.expect - a.expect)) {
        const no = k => { why[k] = (why[k] || 0) + 1 }
        if (c.psLift) { no('свой блок'); continue }
        if (Ptop != null && c.yb > Ptop - 1) { no('выше P − 1'); continue }
        if (cap != null && c.expect > cap) { no('больше потолка'); continue }
        const bb = { min: new Vec3(Math.min(c.F.x, c.H.x), c.yb, Math.min(c.F.z, c.H.z)), max: new Vec3(Math.max(c.F.x, c.H.x) + 1, c.yb + 1, Math.max(c.F.z, c.H.z) + 1) }
        if (overlap(bb, inflate(sitP.head, 0.05)) || overlap(bb, inflate(sitP.neck, 0.05)) || overlap(bb, inflate(sitP.body, 0.05))) { no('в сидячих коробках'); continue }
        const bG = new Vec3(c.B.x + 0.5, c.G, c.B.z + 0.5)
        // с запасом: тело прыгает (+1.25) и стоит на своём блоке; голова/шея бьют 10 (fin5-19: смерть у шеи)
        const near = q => hurtNear(playerBox(q), sitP) || hurtNear(playerBox(q.offset(0, 1.3, 0)), sitP) || hurtNear(playerBox(q.offset(0.5, 0, 0)), sitP) || hurtNear(playerBox(q.offset(-0.5, 0, 0)), sitP) || hurtNear(playerBox(q.offset(0, 0, 0.5)), sitP) || hurtNear(playerBox(q.offset(0, 0, -0.5)), sitP)
        if (near(c.ground) || near(bG)) { no('у головы/шеи'); continue }
        if (inCloud(c.ground) || inCloud(bG)) { no('в облаке'); continue }
        if (!plan || c.expect - c.cost * 0.05 > plan.expect - plan.cost * 0.05) plan = c
        break
      }
    }
    out.plan = plan ? { H: [plan.H.x, plan.yb, plan.H.z], expect: plan.expect, dist: plan.dist, depth: plan.depth } : { no: why }
    if (!plan) { out.why = 'нет станции'; return out }
    out.st = plan
    const sittingSettled = () => { const dd = dragonOf(bot); const ph = dd ? phaseOf(bot, dd) : null; return !dd ? 'нет дракона' : !SITTING.has(ph) ? 'взлетел' : ph === PHASE.SCANNING ? 'высматривает' : null }
    ctl.holdStation = true
    let b
    try { b = await tsBuild(session, ctl, stats, plan, sittingSettled, null, { parts: () => partsOf(bot, dragonOf(bot), track) }) } finally { ctl.holdStation = false }
    if (!b.ok) { out.why = `стройка: ${b.why}`; return out }
    const hit = tsClickPoint(bot, bot.entity.position.offset(0, EYE, 0), plan)
    if (!hit) { out.why = 'бок не видно'; return out }
    await lookAtSafe(bot, hit.point)
    await new Promise(resolve => bot.once('physicsTick', resolve))
    if (sittingSettled()) { out.why = sittingSettled(); return out }
    const r = await bedsBoom(session, ctl, stats, { ...plan, reuse: true }, hit, 'сидит', { aimed: true, until: Math.max(gameClock.now(), (stats.lastBoom || 0) + BED_GAP_MS), phCheck: p => SITTING.has(p) && p !== PHASE.SCANNING, note: { oc: cap != null ? 'SA' : 'SB', headDist: plan.dist } })
    if (r.ok) { out.dmg = r.dmg; P.beds.push(r.dmg) } else out.why = `щелчок: ${r.why}`
    return out
  } finally {
    const st = out.st
    delete out.st
    out.ms = gameClock.now() - t0
    ev('seeStation', out)
    const q = bot.entity.position
    if (st && Math.floor(q.y + 0.01) < st.G && Math.floor(q.x) === st.B.x && Math.floor(q.z) === st.B.z) { doing(ctl, 'see:out'); await build.towerUp(bot, ctl, st.G - Math.floor(q.y + 0.01)).catch(() => {}); clearControls(bot) }
  }
}
// Блок предмета itemRe (обсидиан) в клетку pos — к видимой грани твёрдого соседа (не кровати), крадучись.
async function placeItemAt (bot, pos, itemRe) {
  const at = bot.blockAt(pos)
  if (at && at.name !== 'air' && isSolid(at)) return { ok: true, already: at.name }
  const stack = bot.inventory.items().find(i => itemRe.test(i.name))
  if (!stack) return { ok: false, reason: 'нет блока' }
  const was = bot.getControlState('sneak')
  bot.setControlState('sneak', true)
  try {
    await bot.equip(stack, 'hand')
    await new Promise(resolve => bot.once('physicsTick', resolve))
    for (const face of [new Vec3(0, 1, 0), new Vec3(1, 0, 0), new Vec3(-1, 0, 0), new Vec3(0, 0, 1), new Vec3(0, 0, -1), new Vec3(0, -1, 0)]) {
      if (fbAlarm(bot)) return { ok: false, reason: 'фаербол' }
      const ref = bot.blockAt(pos.minus(face))
      if (!ref || !isSolid(ref) || /_bed$|portal|gateway/.test(ref.name)) continue
      const aim = pick.faceAim(bot, ref.position, face)
      if (!aim) continue
      try { await bot.lookAt(aim, true); await build.withTimeout(bot.placeBlock(ref, face), 1500) } catch (e) { dbg('placeItemAt', e.message) }
      const b = bot.blockAt(pos)
      if (b && isSolid(b)) return { ok: true }
    }
    return { ok: false, reason: 'грань не видно' }
  } finally { if (!was) bot.setControlState('sneak', false) }
}
// Где встать, чтобы поставить блок в cell: клетки рядом (земля, обод, дно чаши), с глаз крадучись видна
// грань твёрдого соседа cell. world — уже стоящие наши блоки.
function standFor (bot, cell, world) {
  const vb = virtualBot(bot, world)
  const clouds = cloudsOf(bot)
  const cands = []
  for (let dx = -4; dx <= 4; dx++) {
    for (let dz = -4; dz <= 4; dz++) {
      const x = cell.x + dx; const z = cell.z + dz
      if (x === 0 && z === 0) continue
      const s = surfaceY(vb, x + 0.5, z + 0.5, cell.y + 4)
      if (!s) continue
      const feet = new Vec3(x + 0.5, s.y, z + 0.5)
      if (Math.abs(feet.y - cell.y) > 4) continue
      if (clouds.some(c => cloudHits(c, feet, 1.2))) continue
      if (Math.floor(feet.x) === cell.x && Math.floor(feet.z) === cell.z && feet.y <= cell.y + 1.8 && feet.y + 1.8 > cell.y) continue
      const eye = feet.offset(0, SNEAK_EYE, 0)
      if (!fillPlaceable(vb, new Vec3(cell.x, cell.y, cell.z), eye, { robust: true })) continue
      cands.push({ feet, d: feet.distanceTo(bot.entity.position) })
    }
  }
  cands.sort((a, b) => a.d - b.d)
  standFor.all = cands
  return cands[0] || null
}
// Дойти к месту ставки и встать точно (середина клетки, на земле).
async function standAt (session, ctl, feet) {
  const bot = session.bot
  standAt.why = null; standAt.step = null
  for (let k = 0; k < 3 && bot.entity.position.distanceTo(feet) > 0.6; k++) {
    if (fbAlarm(bot)) { standAt.why = 'фаербол'; return false }
    // чаша фонтана — портал (пока дракон жив, неактивен): шагать в неё можно (portal: true)
    // |Δy| > 0.6 — маршрут и к близкой цели на другом ярусе (Codex fr1-fix: 83 «к столбику не дошёл»); не проверено боями — только при ND_RUNNER=1
    if (bot.entity.position.distanceTo(feet) > 3 || (runnerOn() && Math.abs(bot.entity.position.y - feet.y) > 0.6)) await walkTo(session, ctl, feet, { range: 0.4, timeoutMs: 9000, portal: true }).catch(() => {})
    const st1 = await stepTo(bot, ctl, feet, { ms: 1500, sprint: false, stopAt: 0.12, portal: true })
    if (st1 && st1.why) standAt.step = st1.why
    clearControls(bot)
  }
  for (let k = 0; k < 3 && !fbAlarm(bot) && Math.hypot(bot.entity.position.x - feet.x, bot.entity.position.z - feet.z) > 0.15; k++) { const st2 = await stepTo(bot, ctl, feet, { ms: 600, sprint: false, stopAt: 0.06, portal: true }); if (st2 && st2.why) standAt.step = st2.why; clearControls(bot) }
  for (let j = 0; j < 12 && !bot.entity.onGround; j++) await sleep(50)
  const q = bot.entity.position
  // в своей клетке на нужном ярусе и на земле — годится (столбик/ставка от середины клетки не зависят)
  if (bot.entity.onGround && Math.floor(q.x) === Math.floor(feet.x) && Math.floor(q.z) === Math.floor(feet.z) && Math.abs(q.y - feet.y) < 0.5) return true
  if (q.distanceTo(feet) <= 0.8) return true
  standAt.why = `стою ${r1(q.x)},${r1(q.y)},${r1(q.z)} — цель ${r1(feet.x)},${r1(feet.y)},${r1(feet.z)}${bot.entity.onGround ? '' : ', в воздухе'}${standAt.step ? ` (шаг: ${standAt.step})` : ''}`
  return false
}
// Поставить блок в cell (itemRe — обсидиан; иначе булыжник), перебирая до 4 мест ставки.
async function placeFrom (session, ctl, cell, world, itemRe) {
  const bot = session.bot
  standFor(bot, cell, world)
  const list = (standFor.all || []).slice(0, 4)
  if (!list.length) return { ok: false, reason: 'негде встать' }
  let last = null
  for (const st of list) {
    if (!(await standAt(session, ctl, st.feet))) { last = 'не дошёл'; continue }
    const r = itemRe ? await placeItemAt(bot, new Vec3(cell.x, cell.y, cell.z), itemRe) : await placeNoBed(bot, new Vec3(cell.x, cell.y, cell.z), { timeoutMs: 1500 })
    if (r.ok) return { ok: true }
    last = r.reason
  }
  return { ok: false, reason: last }
}
// Станция у столба: обсидиан (опора K и заслоны), леса из булыжника, если клетке не к чему прислониться;
// окоп B. Строится один раз за бой, пока дракон далеко.
// Годится ли станция с того места, где стоим (окоп вышел не той глубины, не по центру): в клетке B, на земле,
// опору K видно и взгляд на неё — вдоль a (кровать ляжет как надо), бок кровати виден, взрыву закрыто.
function pillarHere (bot, plan) {
  const q = bot.entity.position
  const runner = runnerOn() && plan.runner
  if (runner && Math.abs(q.y - plan.feet.y) > 0.3) return null
  if (runner ? Math.hypot(q.x - plan.feet.x, q.z - plan.feet.z) > 0.35 || !bot.entity.onGround : Math.floor(q.x) !== plan.B.x || Math.floor(q.z) !== plan.B.z || !bot.entity.onGround) return null
  const P = plan.P ?? plan.yb + 1
  const torchSet = new Set(pillarCells(P).torches.map(t => `${t.x},${t.y},${t.z}`))
  const torchHit = (eye, d, len) => { if (runner) return false; for (let t = 0; t < len; t += 0.1) { const r = eye.plus(d.scaled(t)); if (torchSet.has(`${Math.floor(r.x)},${Math.floor(r.y)},${Math.floor(r.z)}`)) return true } return false }
  const eye = q.offset(0, EYE, 0)
  const fcl = faceClick(bot, eye, new Vec3(plan.place.K.x, plan.place.K.y, plan.place.K.z), plan.place.face, { avoidTorch: torchHit })
  if (!fcl) return null
  const dom = Math.abs(fcl.dir.x) >= Math.abs(fcl.dir.z) ? { x: Math.sign(fcl.dir.x), z: 0 } : { x: 0, z: Math.sign(fcl.dir.z) }
  if (dom.x !== plan.a.x || dom.z !== plan.a.z) return null
  const wB = new Map([[`${plan.F.x},${plan.yb},${plan.F.z}`, 'bed'], [`${plan.H.x},${plan.yb},${plan.H.z}`, 'bed']])
  if (!faceClick(virtualBot(bot, wB), eye, new Vec3(plan.click.cell.x, plan.yb, plan.click.cell.z), new Vec3(plan.click.face.x, plan.click.face.y, plan.click.face.z), { avoidTorch: torchHit })) return null
  const feet = runner && plan.feet ? plan.feet : new Vec3(plan.B.x + 0.5, Math.floor(q.y + 0.01), plan.B.z + 0.5)
  const expo = exposure(bot, feet, plan.centre)
  if (expo > 0.04) return null
  return { feet, expo }
}
// Блок на высоте P и выше (опора K у подушки над столбом, 01.10): снизу его не поставить — верхнюю грань опоры из
// окопа и с земли не видно, а «лес» под ним упирается в ту же грань (hb2: 7 из 14 станций не встали: «лес: не к чему
// прислонить … грань не видно», «лес: не дошёл»). Поэтому: под клеткой — опора на P − 1 цепочкой от твёрдого на том же
// ярусе (опора подушки, столб) — к боковым граням, это видно с земли; потом столбик рядом (как bridge:rise) до ног на
// P − 1, с него — клетка на верх опоры, и столбик срыть.
// extra (R, 02.10) — клетки прямо над cell (K на P + 1 над K на P): тот же столбик на ярус выше, все с одного захода
// (было: столбик на каждую клетку — два подъёма и два спуска под драконом).
async function placeHigh (session, ctl, cell, world, itemRe, plan, lap, extra = []) {
  const bot = session.bot
  const solidW = (x, y, z) => world.get(`${x},${y},${z}`) === 'block' || isSolid(bot.blockAt(new Vec3(x, y, z)))
  const y1 = cell.y - 1
  const up = extra.length
  const forbid = new Set([`${plan.H.x},${plan.yb},${plan.H.z}`, `${plan.F.x},${plan.yb},${plan.F.z}`])
  // столбик не на окопе бота (и не рядом с ним по оси взгляда — заслоны/окоп)
  if (plan.B) for (let y = y1 - 6; y <= y1 + 2; y++) forbid.add(`${plan.B.x},${y},${plan.B.z}`)
  // 1) опора под клеткой: путь по ярусу y1 от твёрдого (BFS ≤ 4 шагов, r ≤ 3.5)
  const chainHigh = []
  if (!solidW(cell.x, y1, cell.z)) {
    const start = `${cell.x},${cell.z}`
    const prev = new Map([[start, null]])
    let q = [start]; let found = null
    for (let d = 0; d < 4 && q.length && !found; d++) {
      const nq = []
      for (const k of q) {
        const [x, z] = k.split(',').map(Number)
        for (const [dx, dz] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
          const nx = x + dx; const nz = z + dz; const nk = `${nx},${nz}`
          if (prev.has(nk) || Math.hypot(nx + 0.5, nz + 0.5) > 4) continue
          prev.set(nk, k)
          if (solidW(nx, y1, nz)) { found = nk; break }
          if (!isAirish(bot.blockAt(new Vec3(nx, y1, nz)))) continue
          nq.push(nk)
        }
        if (found) break
      }
      q = nq
    }
    if (!found) return { ok: false, reason: 'опору под клеткой не к чему прислонить' }
    // клетки пути от соседа найденного твёрдого до клетки под целью
    for (let k = prev.get(found); k; k = prev.get(k)) chainHigh.push(k)
  }
  const Ptop = plan.P ?? plan.yb + 1
  // ярус ниже верха столба — с земли к боковым граням; выше — со столбика (снизу не дотянуться)
  if (y1 < Ptop) {
    for (const k of chainHigh.splice(0)) {
      const [x, z] = k.split(',').map(Number)
      if (solidW(x, y1, z)) continue
      const r = await placeFrom(session, ctl, { x, y: y1, z }, world, FILLER_RE)
      if (!r.ok) return { ok: false, reason: `опора ${x},${y1},${z}: ${r.reason}` }
      world.set(`${x},${y1},${z}`, 'block'); lap.scaffold = (lap.scaffold || 0) + 1
    }
  }
  for (const k of chainHigh) { const [x, z] = k.split(',').map(Number); for (let y = y1; y <= y1 + 2; y++) forbid.add(`${x},${y},${z}`) }
  // 2) столбик рядом: ноги на y1, верх опоры виден
  let tower = null
  for (const [dx, dz] of [[1, 0], [-1, 0], [0, 1], [0, -1], [2, 0], [-2, 0], [0, 2], [0, -2], [1, 1], [1, -1], [-1, 1], [-1, -1]]) {
    const tx = cell.x + dx; const tz = cell.z + dz
    if (tx === 0 && tz === 0) continue
    let bad = false
    for (let y = y1; y <= y1 + 2 + up; y++) if (forbid.has(`${tx},${y},${tz}`) || world.get(`${tx},${y},${tz}`) === 'block') bad = true
    if (bad) continue
    const s = surfaceY(virtualBot(bot, world), tx + 0.5, tz + 0.5, y1)
    if (!s || s.y > y1 || s.y < y1 - 5) continue
    let clear = true
    for (let y = s.y; y <= y1 + 2 + up; y++) { const b = bot.blockAt(new Vec3(tx, y, tz)); if (b && isSolid(b) && world.get(`${tx},${y},${tz}`) !== 'air') { clear = false; break } }
    if (!clear) continue
    const wT = new Map(world)
    for (let y = s.y; y < y1 + up; y++) wT.set(`${tx},${y},${tz}`, 'block')
    for (const k of chainHigh) { const [x, z] = k.split(',').map(Number); wT.set(`${x},${y1},${z}`, 'block') }
    const eye = new Vec3(tx + 0.5, y1 + up + SNEAK_EYE, tz + 0.5)
    if (!pick.faceAim(virtualBot(bot, wT), new Vec3(cell.x, y1, cell.z), new Vec3(0, 1, 0), { eye, avoid: [] })) continue
    // клетки сверху — каждая к верхней грани предыдущей, с того же места
    let upOk = true
    for (let i = 0; i < up && upOk; i++) { wT.set(`${cell.x},${cell.y + i},${cell.z}`, 'block'); if (!pick.faceAim(virtualBot(bot, wT), new Vec3(cell.x, cell.y + i, cell.z), new Vec3(0, 1, 0), { eye, avoid: [] })) upOk = false }
    if (!upOk) continue
    tower = { x: tx, z: tz, ground: s.y }
    break
  }
  if (!tower) return { ok: false, reason: 'некуда поставить столбик' }
  // наверху голова открыта. Раньше — только пока дракон кружит (HOLDING); у фонтана он то и дело заходит с фаерболом
  // (STRAFE: шанс 1/(⌊d²/512⌋+2) ≈ 1/2 при боте у центра) — hb7: 41 отказ «дракон не кружит» на 28 боёв, станция p50 88 с.
  // Сетап раннеров ставится сразу по прибытии (research/06-speedrun-dragon.md): столбик и в STRAFE/заходе, если дракон
  // дальше TOWER_FAR от нас и фаербола в воздухе нет. Таран, снижение, сидит, взлёт — нет. ND_TOWER_FAR=0 — как было.
  const calm = () => {
    const dd = dragonOf(bot)
    const ph = dd ? phaseOf(bot, dd) : PHASE.HOLDING
    if (ph === PHASE.HOLDING) return !fbAlarm(bot) && !hazardNow(bot)
    if (!TOWER_FAR || !dd || (ph !== PHASE.STRAFE && ph !== PHASE.APPROACH)) return false
    const me = bot.entity.position
    if (Math.hypot(dd.position.x - me.x, dd.position.z - me.z) < TOWER_FAR) return false
    return !fireballsOf(bot).length && !hazardNow(bot)
  }
  if (!calm()) return { ok: false, reason: 'дракон не кружит' }
  doing(ctl, 'pillar:tower')
  lap.towerAt = [tower.x, tower.ground, tower.z, up]
  if (!(await standAt(session, ctl, new Vec3(tower.x + 0.5, tower.ground, tower.z + 0.5)))) { lap.towerMiss = standAt.why; return { ok: false, reason: 'к столбику не дошёл' } }
  if (!calm()) return { ok: false, reason: 'дракон не кружит' }
  const abortIf = () => hunters(bot, 5).length ? 'эндермен бьёт' : bot.health < 10 ? 'мало хп' : !calm() ? 'дракон не кружит' : null
  const t = await fastTower(bot, ctl, y1 + up, { maxMs: 12000, abortIf })
  lap.tower = { ok: t.ok, placed: t.placed, why: t.why || null }
  let r = { ok: false, reason: `столбик: ${t.why}` }
  if (Math.floor(bot.entity.position.y + 0.01) >= y1 + up) {
    r = { ok: true }
    for (const k of chainHigh) {
      const [x, z] = k.split(',').map(Number)
      if (solidW(x, y1, z)) continue
      const rc = await placeItemAt(bot, new Vec3(x, y1, z), FILLER_RE)
      if (!rc.ok) { r = { ok: false, reason: `опора ${x},${y1},${z} со столбика: ${rc.reason}` }; break }
      world.set(`${x},${y1},${z}`, 'block'); lap.scaffold = (lap.scaffold || 0) + 1
    }
    if (r.ok) r = await placeItemAt(bot, new Vec3(cell.x, cell.y, cell.z), itemRe)
    for (const e of extra) {
      if (!r.ok) break
      world.set(`${cell.x},${cell.y},${cell.z}`, 'block')
      r = await placeItemAt(bot, new Vec3(e.x, e.y, e.z), e.filler ? FILLER_RE : itemRe)
      if (r.ok) { world.set(`${e.x},${e.y},${e.z}`, 'block'); lap.placed.push([e.x, e.y, e.z]); e.done = true } else r = { ...r, reason: `над ней ${e.x},${e.y},${e.z}: ${r.reason}` }
    }
  }
  // вниз — всегда (раньше тот же abortIf с «не кружит» оставлял бота на столбике под фаерболом)
  await digDownTo(bot, ctl, tower.ground, 8, () => hunters(bot, 5).length ? 'эндермен бьёт' : null).catch(() => {})
  return r
}
// Заход на посадку ещё далеко: до снижения (LANDING от узла в ~40 бл.) секунды — стройку не бросать (hb7: заход ~13 с).
function approachFar (dd) { return !!dd && TOWER_FAR > 0 && Math.hypot(dd.position.x - CENTER.x, dd.position.z - CENTER.z) > 60 }
// R: свои блоки в чаше станции (рефлекс от облака/фаербола кладёт булыжник под ноги — rs8-s1: бот стоял на двух своих блоках
// в столбце изножья, клетка факела занята, станция не встала до конца боя). Снять сверху вниз: стоим на нём — копать под собой,
// иначе — видимую грань в досягаемости (raycast). Клетки: столбец изножья (0, G…P−2, s) и столбец ног (0, G…G+1, 2s).
async function runnerClean (session, ctl, plan) {
  const bot = session.bot
  const P = plan.P, s = plan.F.z, G = plan.G
  const cells = []
  for (let y = P - 2; y >= G; y--) cells.push(new Vec3(0, y, s))
  for (let y = G + 1; y >= G; y--) cells.push(new Vec3(0, y, 2 * s))
  const filled = () => cells.filter(c => { const b = bot.blockAt(c); return b && FILLER_RE.test(b.name) })
  let n = 0
  for (let k = 0; k < 8 && filled().length; k++) {
    const q = bot.entity.position
    const under = new Vec3(Math.floor(q.x), Math.floor(q.y + 0.01) - 1, Math.floor(q.z))
    const top = filled().sort((a, b) => b.y - a.y)[0]
    if (filled().some(c => c.equals(under))) { await digDownTo(bot, ctl, under.y, 1, () => hunters(bot, 5).length ? 'эндермен' : null).catch(() => {}); n++; continue }
    const b = bot.blockAt(top)
    const eye = q.offset(0, EYE, 0)
    if (eye.distanceTo(top.offset(0.5, 0.5, 0.5)) > 4.3) { await walkTo(session, ctl, new Vec3(top.x + 0.5, G, top.z + 0.5), { range: 2.5, timeoutMs: 6000, portal: true }).catch(() => {}); continue }
    try { const tool = findItem(bot, /_pickaxe$/); if (tool) await bot.equip(tool, 'hand'); await build.withTimeout(bot.dig(b, true, 'raycast'), 3000); n++ } catch (e) { bot.stopDigging(); break }
  }
  return { cleared: n, left: filled().length }
}
async function pillarBuild (session, ctl, stats, plan) {
  const bot = session.bot
  const ev = (k, o) => { if (ctl.trace) ctl.trace.ev(k, o) }
  const t0 = gameClock.now()
  const lap = { placed: [], scaffold: 0 }
  const res = r => { ev('pillarBuild', { ok: r.ok, why: r.why || null, ms: gameClock.now() - t0, ...lap }); return r }
  const OBS_RE = /^(obsidian|crying_obsidian)$/
  const runner = runnerOn() && plan.runner
  const cells = runner ? plan.cells.filter(c => OBS_RE.test(c[3])).map(c => ({ x: c[0], y: c[1], z: c[2] })) : []
  for (const c of plan.supCob || []) cells.push({ x: c[0], y: c[1], z: c[2], filler: true })
  for (const c of plan.sup || []) cells.push({ x: c[0], y: c[1], z: c[2] })
  if (plan.place.obsidian) cells.push({ x: plan.place.K.x, y: plan.place.K.y, z: plan.place.K.z })
  for (const o of plan.obs) cells.push({ x: o[0], y: o[1], z: o[2] })
  if (countOf(bot, OBS_RE) < cells.filter(c => !c.filler && !OBS_RE.test((bot.blockAt(new Vec3(c.x, c.y, c.z)) || {}).name || '')).length) return res({ ok: false, why: 'мало обсидиана' })
  const world = new Map()
  // Частичная/готовая R: не ставить уже имеющиеся обсидианы, даже при пустом рюкзаке.
  const left = cells.filter(c => {
    if (!runner || !OBS_RE.test((bot.blockAt(new Vec3(c.x, c.y, c.z)) || {}).name || '')) return true
    world.set(`${c.x},${c.y},${c.z}`, 'block'); return false
  })
  // Бьёт эндермен или мало хп — бросить стройку, пусть бой отобьётся/поест (pil6-20: смерть в окопе — эндермен
  // бил 12 раз за 18 с, пока бот копал: стройка шла до проверок боя)
  // st1 (01.10): смерть в облаке на стройке (s16, «pillar:build» — 4 удара за миг): облако/фаербол рядом — бросить, бой уведёт
  const abortIf = () => { if (hunters(bot, 5).length) return 'эндермен бьёт'; if (bot.health < 10) return 'мало хп'; const hz = hazardNow(bot); return hz ? `опасно: ${hz.kind || 'угроза'}` : null }
  for (let guard = 0; left.length && guard < 20; guard++) {
    // st2-s5: одна стройка шла 74.6 с (до 4 мест ставки × 3 маршрута по 9 с) — дольше BUILD_MAX — бросить, план заново
    if (BUILD_MAX_MS && gameClock.now() - t0 > BUILD_MAX_MS) return res({ ok: false, why: 'стройка долго' })
    const dd = dragonOf(bot)
    const ph = dd ? phaseOf(bot, dd) : null
    if ((ph === PHASE.APPROACH && !approachFar(dd)) || ph === PHASE.LANDING || SITTING.has(ph)) return res({ ok: false, why: 'дракон садится — потом' })
    const stopWhy = abortIf()
    if (stopWhy) return res({ ok: false, why: stopWhy })
    // клетка, которую можно поставить сейчас (есть сосед с видимой гранью откуда-то)
    let pick0 = null
    // клетка на высоте верха столба и выше (подушка над столбом) — со столбика, не «лесом»
    const Ptop = plan.P ?? plan.yb + 1
    for (const c of left) { if (c.y >= Ptop) continue; const st = standFor(bot, c, world); if (st) { pick0 = { c, st }; break } }
    const hi = !pick0 && left.find(c => c.y >= Ptop)
    if (hi) {
      // R: клетки над hi (K на P + 1) — с того же столбика
      const extra = []
      if (runner && RUN_TOWER1()) for (let y = hi.y + 1; ; y++) { const e = left.find(c => c.x === hi.x && c.z === hi.z && c.y === y); if (!e) break; extra.push(e) }
      const r = await placeHigh(session, ctl, hi, world, hi.filler ? FILLER_RE : OBS_RE, plan, lap, extra)
      for (const e of extra) if (e.done) left.splice(left.indexOf(e), 1)
      if (!r.ok) return res({ ok: false, why: `высоко ${hi.x},${hi.y},${hi.z}: ${r.reason}` })
      world.set(`${hi.x},${hi.y},${hi.z}`, 'block'); lap.placed.push([hi.x, hi.y, hi.z])
      left.splice(left.indexOf(hi), 1)
      continue
    }
    if (!pick0) {
      // лес: под первой клеткой — столбик булыжника от твёрдого снизу
      const c = left[0]
      let y = c.y - 1
      while (y > c.y - 6 && !isSolid(bot.blockAt(new Vec3(c.x, y, c.z)))) y--
      if (y <= c.y - 6) return res({ ok: false, why: `клетке ${c.x},${c.y},${c.z} не к чему прислониться` })
      const sc = { x: c.x, y: y + 1, z: c.z }
      const r = await placeFrom(session, ctl, sc, world, null)
      if (!r.ok) return res({ ok: false, why: `лес: ${r.reason}` })
      world.set(`${sc.x},${sc.y},${sc.z}`, 'block'); lap.scaffold++
      continue
    }
    const { c } = pick0
    const r = await placeFrom(session, ctl, c, world, c.filler ? FILLER_RE : OBS_RE)
    if (!r.ok) { lap.faceFail = (lap.faceFail || 0) + 1; if (lap.faceFail > 2) return res({ ok: false, why: `обсидиан ${c.x},${c.y},${c.z}: ${r.reason}` }); continue }
    world.set(`${c.x},${c.y},${c.z}`, 'block'); lap.placed.push([c.x, c.y, c.z])
    left.splice(left.indexOf(c), 1)
  }
  if (left.length) return res({ ok: false, why: 'не всё поставлено' })
  if (runner) {
    const cl0 = await runnerClean(session, ctl, plan)
    if (cl0.cleared || cl0.left) lap.clean = cl0
    if (cl0.left) return res({ ok: false, why: `R: в чаше свои блоки (${cl0.left})` })
  }
  if (runner) for (const c of plan.cells.filter(c => c[3] === 'air')) {
    const pos = new Vec3(c[0], c[1], c[2]), b = bot.blockAt(pos)
    if (b && /^(air|cave_air|void_air)$/.test(b.name)) continue
    // свой блок (рефлекс от облака кладёт булыжник под ноги — rs8-s1: бот стоял в клетке факела на своём блоке) — снять, как факел
    if (!b || !(/^(torch|wall_torch)$/.test(b.name) || FILLER_RE.test(b.name))) return res({ ok: false, why: `R: клетка факела занята (${b && b.name})` })
    const stopWhy = abortIf()
    if (stopWhy) return res({ ok: false, why: stopWhy })
    if (!(await standAt(session, ctl, plan.feet))) { lap.torchMiss = standAt.why; return res({ ok: false, why: 'R: к факелу не дошёл' }) }
    if (bot.entity.position.offset(0, EYE, 0).distanceTo(pos.offset(0.5, 0.5, 0.5)) > 4.5) return res({ ok: false, why: 'R: факел далеко' })
    try {
      const tool = findItem(bot, /_pickaxe$/)
      if (tool) await bot.equip(tool, 'hand'); else await bot.unequip('hand')
      // mineflayer digging.js: raycast выбирает реально видимую грань, torch hardness=0; свой булыжник — киркой (~0.5 с)
      await build.withTimeout(bot.dig(b, true, 'raycast'), FILLER_RE.test(b.name) ? 3000 : 1500)
    } catch (e) { bot.stopDigging(); return res({ ok: false, why: 'R: факел: ' + e.message }) }
    if (!/^(air|cave_air|void_air)$/.test((bot.blockAt(pos) || {}).name || '')) return res({ ok: false, why: 'R: факел остался' })
    lap.torch = [c[0], c[1], c[2]]
  }
  // Окоп A / готовая чаша R (depth 0).
  const tr = await tsTrench(bot, ctl, { B: plan.B, G: plan.G, depth: plan.dig, portal: true, runner, abortIf, feet: plan.feet }, k => doing(ctl, 'pillar:' + k), session)
  if (!tr.ok) lap.trench = { why: tr.why, ...(tr.lap || {}) }
  if (!tr.ok && /эндермен|мало хп|опасно/.test(tr.why || '')) return res({ ok: false, why: tr.why })
  if (!tr.ok) {
    // окоп не той глубины / не по центру — но с этого места станция годится? (pil5: «не спустился» ×9)
    const here = pillarHere(bot, plan)
    if (!here) return res({ ok: false, why: `окоп: ${tr.why}` })
    lap.here = { y: here.feet.y, expo: r1(here.expo * 100) / 100 }
    plan.feet = here.feet; plan.dig = Math.max(0, plan.G - here.feet.y); plan.G = here.feet.y + plan.dig
  }
  ctl.pillar = { plan, built: true, t: gameClock.now(), booms: 0 }
  return res({ ok: true })
}
// Подушка — как можно выше (01.10, правило спидраннеров: кровать вплотную к голове): перебор высоты сверху вниз, первая
// станция, которую можно поставить и щёлкнуть из окопа и на которую хватает обсидиана. ND_PILLOW_DY — одна высота.
// P + 1 из окопа не достать при макушке ≤ P − 2.6 (hb5) — не считать (ND_PILLOW_TRY1=1 — пробовать)
function pillowDys () { return envv('ND_PILLOW_DY') != null ? [Number(envv('ND_PILLOW_DY'))] : envv('ND_PILLOW_TRY1') === '1' ? [1, 0, -1] : [0, -1] }
// То же, что pillarPlanAuto, но кусками (подушка × направление) с отдачей хода: пакеты, физика и тревоги живут во время расчёта.
async function pillarPlanAutoAsync (bot, P, bad = null) {
  const obsHave = countOf(bot, /^(obsidian|crying_obsidian)$/)
  for (const dy of pillowDys()) {
    const all = []; const why = {}
    for (const Hc of [{ x: 1, z: 0 }, { x: -1, z: 0 }, { x: 0, z: 1 }, { x: 0, z: -1 }]) {
      for (const a of DIRS4) {
        pillarPlan(bot, P, { dy, pillow: Hc, aOnly: a })
        all.push(...(pillarPlan.all || []))
        for (const [k, v] of Object.entries(pillarPlan.why || {})) why[k] = (why[k] || 0) + v
        await new Promise(resolve => setImmediate(resolve))
      }
    }
    all.sort((p, q) => p.cost - q.cost)
    pillarPlan.all = all; pillarPlan.why = why
    const ok = all.filter(q => q.nObs <= obsHave && !(bad && (bad.get(pillarKey(q)) || 0) >= 2))
    if (ok.length) return ok[0]
  }
  return null
}
function pillarKey (p) { return `${p.B.x},${p.B.z}|${p.H.x},${p.H.z}|${p.F.x},${p.F.z}` }
function pillarPlanAuto (bot, P, bad = null) {
  const obsHave = countOf(bot, /^(obsidian|crying_obsidian)$/)
  // выше P + 1 из окопа не дотянуться (до грани опоры > 4.5) — не считать: перебор впустую — секунды стоящего тела
  const dys = pillowDys()
  for (const dy of dys) {
    const p = pillarPlan(bot, P, { dy })
    if (!p) continue
    const all = (pillarPlan.all || []).filter(q => q.nObs <= obsHave && !(bad && (bad.get(pillarKey(q)) || 0) >= 2))
    if (all.length) return all[0]
  }
  return null
}
// Кровать уже стоит у столба (план станции): заряд, который ещё не взорван.
function stationBedPlaced (bot, ctl) {
  const pl = ctl && ctl.pillar && ctl.pillar.built && ctl.pillar.plan
  if (!pl) return false
  const at = (x, z) => /_bed$/.test((bot.blockAt(new Vec3(x, pl.yb, z)) || {}).name || '')
  return at(pl.H.x, pl.H.z) && at(pl.F.x, pl.F.z)
}
// Перепроверка станции (обсидиан на месте, окоп выкопан) и встать в окоп.
async function pillarEnter (session, ctl, plan) {
  const bot = session.bot
  // R: рефлекс мог сложить свои блоки в чаше после постройки станции — снять до входа
  if (runnerOn() && plan.runner && !hunters(bot, 5).length) { const cl = await runnerClean(session, ctl, plan); if (cl.cleared && ctl.trace) ctl.trace.ev('runnerClean', cl) }
  const q = bot.entity.position
  const inB = Math.floor(q.x) === plan.B.x && Math.floor(q.z) === plan.B.z && Math.abs(q.y - plan.feet.y) < 0.3
  if (inB) return true
  if (pillarHere(bot, plan)) return true
  if (hunters(bot, 5).length) return false
  const bc = new Vec3(plan.B.x + 0.5, plan.G, plan.B.z + 0.5)
  // 03.10: от точки выстрела по кристаллам (до 30 от центра) — бегом и с запасом по времени (ND_ENTER_RUN=0 — шагом, 8 с)
  const farB = Math.hypot(q.x - bc.x, q.z - bc.z)
  const runE = envv('ND_ENTER_RUN') !== '0' && farB > 8
  await walkTo(session, ctl, bc, { range: 0.5, timeoutMs: runE ? Math.min(16000, 6000 + farB * 300) : 8000, portal: true, sprint: runE })
  const tr = await tsTrench(bot, ctl, { B: plan.B, G: plan.G, depth: plan.dig, portal: true, runner: runnerOn() && plan.runner, feet: plan.feet, abortIf: () => hunters(bot, 5).length ? 'эндермен бьёт' : null }, k => doing(ctl, 'pillar:' + k), session)
  return tr.ok || !!pillarHere(bot, plan)
}
// Цепочка на снижении: кровать у столба на каждый проход головы, щелчок в тик ближайшего прохода,
// не чаще раза в 11 тиков (неуязвимость 10). Толчок взрыва уводит дракона — он заходит снова.
// Добить стрелой с позиции R (02.10, rs3: 4 из 5 проигрышей — дракону осталось 1, 2, 13, 24 хп после 4 кроватей; снижение
// идёт дальше, голова снова проходит в 1–4 бл. от чаши). Лук натянут сразу после последнего взрыва; выстрел — в тик, когда
// стрела (≈ 3 бл./тик) застанет голову по прогнозу снижения ближе всего к глазам, луч к ней открыт, и не раньше 11 тиков
// после взрыва (неуязвимость 10: урон стрелы меньше урона кровати — пропал бы). Сидячему стрелы — 0 (onHurt), только снижение.
// ------------------------------------------------------------ видимость взрыва (Codex dragon-seen, 02.10)
// ServerExplosion.getSeenPercent 1.21.11 по коробке РОДИТЕЛЯ 16×8×16 (Paper hurtEntities: seen родителя, расстояние — до
// части), лучи от точек коробки к центру взрыва, COLLIDER-формы блоков. Сверено с сервером labR3: ошибка p50 0.0002, p90
// 0.0005 (codex-lab/dragon-seen/seenmodel.js, 12 тестов). Снимок мира у станции — один на цепочку (smCompile).
const SM_EMPTY = []
const SM_FULL = [[0, 0, 0, 1, 1, 1]]
const smAxes = new Map()
function smAxis (size) {
  if (smAxes.has(size)) return smAxes.get(size)
  const step = 1 / (2 * size + 1), out = []
  for (let a = 0; a <= 1; a += step) out.push(a * size)
  out.offset = (1 - Math.floor(1 / step) * step) / 2
  smAxes.set(size, out)
  return out
}
function smShapes (b) {
  if (!b || /^(air|cave_air|void_air|fire|soul_fire|end_portal|water|lava|.*torch)$/.test(b.name)) return SM_EMPTY
  if (b.shapes) return b.shapes
  return SM_FULL
}
function smRayHit (p, c, b) {
  let lo = 0, hi = 1, len2 = 0, inside = true
  for (let a = 0; a < 3; a++) {
    const d = c[a] - p[a], probe = p[a] + d * 0.001
    len2 += d * d
    if (probe < b[a] || probe >= b[a + 3]) inside = false
    if (Math.abs(d) < 1e-7) { if (p[a] < b[a] || p[a] > b[a + 3]) return false; continue }
    const t0 = (b[a] - p[a]) / d, t1 = (b[a + 3] - p[a]) / d
    lo = Math.max(lo, Math.min(t0, t1)); hi = Math.min(hi, Math.max(t0, t1))
    if (lo > hi) return false
  }
  return len2 >= 1e-7 && (inside || (lo > 0 && lo < 1 && hi >= lo))
}
// skip(x, y, z) — клетка, которую снимок не берёт (будущая кровать, опора под F — её добавляют отдельно)
function smCompile (bot, bounds, skip = null) {
  const colliders = []
  for (let x = Math.floor(bounds[0]); x <= Math.floor(bounds[3]); x++) {
    for (let y = Math.floor(bounds[1]); y <= Math.floor(bounds[4]); y++) {
      for (let z = Math.floor(bounds[2]); z <= Math.floor(bounds[5]); z++) {
        if (skip && skip(x, y, z)) continue
        for (const sh of smShapes(bot.blockAt(new Vec3(x, y, z)))) colliders.push([x + sh[0], y + sh[1], z + sh[2], x + sh[3], y + sh[4], z + sh[5]])
      }
    }
  }
  return { colliders, bounds: bounds.slice() }
}
function smSeenBox (snap, c, box, extra = SM_EMPTY) {
  const bounds = [Math.min(c[0], box[0]), Math.min(c[1], box[1]), Math.min(c[2], box[2]), Math.max(c[0], box[3]), Math.max(c[1], box[4]), Math.max(c[2], box[5])]
  const xs = smAxis(box[3] - box[0]), ys = smAxis(box[4] - box[1]), zs = smAxis(box[5] - box[2])
  const nx = xs.length, total = nx * ys.length * zs.length
  let blocked = 0
  const relevant = snap.colliders.concat(extra).filter(b => b[3] >= bounds[0] && b[4] >= bounds[1] && b[5] >= bounds[2] && b[0] <= bounds[3] && b[1] <= bounds[4] && b[2] <= bounds[5])
  const intervals = []
  for (const sy of ys) for (const sz of zs) {
    const y = box[1] + sy, z = box[2] + sz + zs.offset
    intervals.length = 0
    for (const b of relevant) {
      let lo = 0, hi = 1
      for (let a = 1; a <= 2; a++) {
        const d = (a === 1 ? y : z) - c[a]
        if (Math.abs(d) < 1e-7) { if (c[a] < b[a] || c[a] > b[a + 3]) hi = -1; continue }
        const t0 = (b[a] - c[a]) / d, t1 = (b[a + 3] - c[a]) / d
        lo = Math.max(lo, Math.min(t0, t1)); hi = Math.min(hi, Math.max(t0, t1))
      }
      if (hi < lo || hi <= 0) continue
      const a0 = b[0] - c[0], d0 = b[3] - c[0]
      const xmin = c[0] + Math.min(a0 / hi, lo > 0 ? a0 / lo : a0 < 0 ? -Infinity : a0 === 0 ? 0 : Infinity)
      const xmax = c[0] + Math.max(d0 / hi, lo > 0 ? d0 / lo : d0 > 0 ? Infinity : d0 === 0 ? 0 : -Infinity)
      let first = -1, last = -1
      for (let i = 0; i < nx; i++) {
        const x = box[0] + xs[i] + xs.offset
        if (x < xmin - 1e-7 || x > xmax + 1e-7) continue
        if (smRayHit([x, y, z], c, b)) { if (first < 0) first = i; last = i }
      }
      if (first >= 0) intervals.push([first, last])
    }
    intervals.sort((p, q) => p[0] - q[0])
    let end = -1
    for (const [start, stop] of intervals) if (stop > end) { blocked += stop - Math.max(start, end + 1) + 1; end = stop }
  }
  return Math.fround((total - blocked) / total)
}
// seen родителя для взрыва в centre при теле дракона в body (низ коробки)
function smDragonSeen (snap, centre, body, extra = SM_EMPTY) {
  const b = snap.bounds
  if (body.x - 8 < b[0] || body.z - 8 < b[2] || body.x + 8 > b[3] + 1 || body.z + 8 > b[5] + 1 || body.y < b[1] || body.y + 8 > b[4] + 1) return null
  return smSeenBox(snap, [centre.x, centre.y, centre.z], [body.x - 8, body.y, body.z - 8, body.x + 8, body.y + 8, body.z + 8], extra)
}

// Коробка родителя (EntityType ender_dragon 16×8, LivingEntity.blocksBuilding = true; EntityGetter.isUnobstructed) пересекает
// форму изножья F (9/16 высоты) — сервер не поставит кровать. pos — позиция тела (низ коробки), m — запас на ошибку прогноза.
function bodyBlocksBed (pos, F, yb, m = envNum('ND_RUN_BOX_M', 0)) {
  return !!pos && Math.abs(pos.x - (F.x + 0.5)) < 8.5 + m && Math.abs(pos.z - (F.z + 0.5)) < 8.5 + m && pos.y < yb + 0.5625 + m && pos.y + 8 > yb - m
}
// Стрела в промежутке цепочки R (02.10): между взрывами дракон снова заходит ~1.7 с — лук натягивается (≥ 1 с, крит), выстрел в
// голову по прогнозу, если стрела застанет её не раньше 11 тиков после прошлого взрыва (неуязвимость 10: урон стрелы < урона
// кровати — иначе пропал бы) и не позже 11 тиков до следующего щелчка (кровать после стрелы в окне неуязвимости потеряла бы урон
// стрелы, но не свой: damage − lastHurt). Нет случая — смена предмета (натяжение снимается без выстрела).
async function runnerGapArrow (session, ctl, feed, P, { minHit, maxHit, deadline }) {
  const bot = session.bot
  const bow = findItem(bot, /^bow$/)
  if (!bow || countOf(bot, /arrow$/) < 1) return { why: 'нет лука или стрел' }
  const out = {}
  try { await bot.equip(bow, 'hand') } catch (e) { return { why: 'лук: ' + e.message } }
  bot.activateItem()
  const tDraw = gameClock.now()
  try {
    while (!ctl.aborted && gameClock.now() < deadline) {
      const dd = dragonOf(bot)
      if (!dd || phaseOf(bot, dd) !== PHASE.LANDING) { out.why = 'фаза'; return out }
      const fc = landingForecast(feed, P)
      if (!fc) { await sleep(20); continue }
      const eye = bot.entity.position.offset(0, EYE, 0)
      const nowTick = Math.round((gameClock.now() - fc.t) / 50)
      let best = null
      for (let k = nowTick + 1; k < Math.min(fc.path.length, nowTick + 30, (fc.n || fc.path.length) - 3); k++) {
        const tHit = fc.t + 50 * k
        if (tHit < minHit || tHit > maxHit) continue
        const hc = fc.path[k].head.offset(0, 0.5, 0)
        const d = hc.distanceTo(eye)
        if (d < 1.5 || d > 12) continue
        const travel = Math.max(1, Math.ceil(d / 2.9))
        if (k - travel < nowTick) continue
        const dir = hc.minus(eye).scaled(1 / d)
        if (pick.blockOnRay(bot, eye, dir, d - 0.55)) continue
        if (!best || d < best.d) best = { k, d, hc, travel }
      }
      const drawn = gameClock.now() - tDraw >= 1000
      if (best && drawn && best.k - best.travel <= nowTick) {
        const hpB = hpOf(bot, dd)
        // падение стрелы за полёт (гравитация 0.05/тик): цель чуть выше
        runnerAim(bot, best.hc.offset(0, 0.025 * best.travel * best.travel, 0))
        bot.deactivateItem()
        out.shot = { d: r1(best.d), ahead: best.k - nowTick, drawMs: gameClock.now() - tDraw, hp: hpB != null ? r1(hpB) : null }
        await sleep(250)
        const d2 = dragonOf(bot); out.hpAfter = d2 ? r1(hpOf(bot, d2) ?? -1) : 0
        return out
      }
      if (best) await lookAtSafe(bot, best.hc); else { const pc = partsOf(bot, dd, makeTrack(bot)); if (pc && pc.headC) await lookAtSafe(bot, pc.headC) }
      await sleep(20)
    }
    out.why = 'нет окна'
    return out
  } finally {
    // без выстрела — снять натяжение сменой предмета (deactivateItem выстрелил бы)
    if (!out.shot) { const bi = findItem(bot, /_bed$/); if (bi) await bot.equip(bi, 'hand').catch(() => {}); else bot.deactivateItem() }
    if (ctl.trace) ctl.trace.ev('gapArrow', out)
  }
}
async function runnerArrow (session, ctl, feed, P, lastBoom) {
  const bot = session.bot
  const bow = findItem(bot, /^bow$/)
  if (!bow || countOf(bot, /arrow$/) < 1) return { why: 'нет лука или стрел' }
  const out = {}
  try { await bot.equip(bow, 'hand') } catch (e) { return { why: 'лук: ' + e.message } }
  bot.activateItem()
  const tDraw = gameClock.now()
  const hp0 = (() => { const dd = dragonOf(bot); return dd ? hpOf(bot, dd) : null })()
  try {
    while (!ctl.aborted && gameClock.now() - tDraw < 6000) {
      const dd = dragonOf(bot)
      if (!dd) { out.why = 'дракона нет'; return out }
      const ph = phaseOf(bot, dd)
      if (ph !== PHASE.LANDING) { out.why = `фаза ${PHASE_RU[ph] ?? ph}`; return out }
      if ((hpOf(bot, dd) ?? 1) <= 0) { out.why = 'убит'; return out }
      if (bot.health < 8) { out.why = 'мало хп'; return out }
      const fc = landingForecast(feed, P)
      const eye = bot.entity.position.offset(0, EYE, 0)
      if (!fc) { await sleep(25); continue }
      const nowTick = Math.round((gameClock.now() - fc.t) / 50)
      const minTick = Math.max(nowTick + 1, Math.ceil(((lastBoom || 0) + 560 - fc.t) / 50))
      let best = null
      // стрела должна застать голову до посадки: сидячему стрелы — 0 (rs4: 3 выстрела в последний тик снижения — мимо урона)
      for (let k = minTick; k < Math.min(fc.path.length, nowTick + 40, (fc.n || fc.path.length) - 3); k++) {
        const hc = fc.path[k].head.offset(0, 0.5, 0)
        const d = hc.distanceTo(eye)
        if (d > 9 || d < 1) continue
        const dir = hc.minus(eye).scaled(1 / d)
        if (pick.blockOnRay(bot, eye, dir, d - 0.55)) continue
        if (!best || d < best.d) best = { k, d, hc }
      }
      if (!best) { const pc = partsOf(bot, dd, makeTrack(bot)); if (pc && pc.headC) await lookAtSafe(bot, pc.headC); await sleep(25); continue }
      const travel = Math.max(1, Math.round(best.d / 2.9))
      const drawn = gameClock.now() - tDraw >= 1050
      if (drawn && best.k - travel <= nowTick) {
        runnerAim(bot, best.hc)
        bot.deactivateItem()
        out.shot = { d: r1(best.d), ahead: best.k - nowTick, drawMs: gameClock.now() - tDraw, hp: hp0 != null ? r1(hp0) : null }
        await sleep(400)
        const d2 = dragonOf(bot); out.hpAfter = d2 ? r1(hpOf(bot, d2) ?? -1) : 0
        return out
      }
      await lookAtSafe(bot, best.hc)
      await sleep(20)
    }
    out.why = 'прохода нет'
    return out
  } finally {
    if (!out.shot) bot.deactivateItem()
    if (ctl.trace) ctl.trace.ev('runnerArrow', out)
  }
}
async function pillarRun (session, ctl, stats, track, feed) {
  const bot = session.bot
  const ev = (k, o) => { if (ctl.trace) ctl.trace.ev(k, o) }
  const st = ctl.pillar
  let plan = st.plan
  const runnerLevels = plan.runnerLevels
  const P = podiumTop(bot)
  const out = { booms: [], why: null }
  const t0 = gameClock.now()
  let H = plan.H; let F = plan.F; let yb = plan.yb
  const bedHere = () => /_bed$/.test((bot.blockAt(new Vec3(H.x, yb, H.z)) || {}).name || '') && /_bed$/.test((bot.blockAt(new Vec3(F.x, yb, F.z)) || {}).name || '')
  const bedCells = [{ x: F.x, y: yb, z: F.z }, { x: H.x, y: yb, z: H.z }]
  // Якорь возрождения (если есть якоря и светокамень): взрыв той же силы, дракон его не ломает (dragon_immune) —
  // ставится и заряжается сразу после взрыва, не дожидаясь, пока коробки пройдут клетки кровати. Ставится в
  // клетку ИЗНОЖЬЯ F к той же опоре K: в подушке H с места окопа его не щёлкнуть (до ближней грани > 4.5 или
  // луч через заслон/факел: офлайн 0 из 36 станций, pil6 — «не видно» во всех боях), F — 36 из 36. Центр
  // взрыва на блок дальше от столба — урон меньше; поэтому по умолчанию якоря — запас, когда кровати кончились.
  // ND_PILLAR_ANCHOR: first — сперва якоря, 0 — без них, иначе (last) — после кроватей.
  const Apos = new Vec3(F.x, yb, F.z)
  const Acentre = new Vec3(F.x + 0.5, yb + 0.5, F.z + 0.5)
  const anMode = process.env.ND_PILLAR_ANCHOR || 'last'
  const anchorAt = () => anchorCharges(bot, Apos)
  const torchSetP = new Set(pillarCells(plan.P ?? yb + 1).torches.map(t => `${t.x},${t.y},${t.z}`))
  const torchHitP = (eye, d, len) => { if (runnerLevels) return false; for (let t = 0; t < len; t += 0.1) { const q = eye.plus(d.scaled(t)); if (torchSetP.has(`${Math.floor(q.x)},${Math.floor(q.y)},${Math.floor(q.z)}`)) return true } return false }
  const anClick = (vb) => { const eye = bot.entity.position.offset(0, EYE, 0); for (const f of [[1, 0, 0], [-1, 0, 0], [0, 0, 1], [0, 0, -1], [0, -1, 0], [0, 1, 0]]) { const c = faceClick(vb, eye, Apos, new Vec3(f[0], f[1], f[2]), { reach: 4.3, avoidTorch: torchHitP }); if (c) return { point: c.point, face: new Vec3(f[0], f[1], f[2]) } } return null }
  // F ближе к окопу, чем H, и закрыт хуже (pil7-22: 1–1.5 хп нам за якорь против 0.3 за кровать) — при хп < 12 только кровати
  // Толчок своего взрыва сдвигает нас в окопе — грань опоры/кровати может уйти из прицела (pil7-20: «грань
  // опоры не видно» после двух якорей): встать снова в середину клетки окопа, до 3 раз за цепочку.
  const recenter = async () => {
    out.recenter = (out.recenter || 0) + 1
    if (out.recenter > (runnerLevels ? 12 : 3)) return false
    const q = bot.entity.position
    await stepTo(bot, ctl, runnerLevels ? new Vec3(plan.feet.x, q.y, plan.feet.z) : new Vec3(plan.B.x + 0.5, q.y, plan.B.z + 0.5), { ms: 700, sprint: false, stopAt: 0.06, portal: true })
    clearControls(bot)
    // взрыв мог выбить эндерняк у окопа (якорь в F ближе к нам) — тогда окоп заново (глубже — подняться)
    if (!pillarHere(bot, plan)) await pillarEnter(session, ctl, plan)
    return true
  }
  const anchorOk = () => !runnerLevels && anMode !== '0' && !st.noAnchor && bot.health >= 12 && countOf(bot, /^respawn_anchor$/) >= 1 && countOf(bot, /^glowstone$/) >= 1
  // Поставленная, но не взорванная кровать — тоже заряд (01.10: последняя из 7 ставилась и бросалась — «кровати кончились»
  // при 0 в рюкзаке, хотя кровать стояла у столба: 6 взрывов из 7 в 41 из 58 вызовов).
  const noBoom = () => countOf(bot, /_bed$/) < 1 && !bedHere() && !anchorOk() && anchorAt() < 1
  const cellHit = (st2) => {
    // клетки кровати в коробках головы/шеи/тела (checkWalls — по клеткам)
    // низ коробок — на 0.1 ниже прогноза: на последнем заходе дракон опускается до P − 0.2 (запись сервера pil6:
    // 5 из 5 «съеденных» кроватей — тело на r 0.8–2.4 и y до P − 0.2, коробка тела задевает клетки на P − 1);
    // больше запас (0.3, pil7) закрывал и сам последний проход — «садится без прохода»
    const M = 0.1
    const hb = box(st2.head.x, st2.head.y - M, st2.head.z, 0.5, 1 + M); const nb = box(st2.neck.x, st2.neck.y - M, st2.neck.z, 1.5, 3 + M)
    const by = box(st2.pos.x + Math.sin(st2.yRot * DRAD) * 0.5, st2.pos.y - M, st2.pos.z - Math.cos(st2.yRot * DRAD) * 0.5, 2.5, 3 + M)
    const cellsOf = b => ({ x0: Math.floor(b.min.x), x1: Math.floor(b.max.x - 1e-7), y0: Math.floor(b.min.y), y1: Math.floor(b.max.y - 1e-7), z0: Math.floor(b.min.z), z1: Math.floor(b.max.z - 1e-7) })
    return [hb, nb, by].some(b => { const c = cellsOf(b); return bedCells.some(q => q.x >= c.x0 && q.x <= c.x1 && q.y >= c.y0 && q.y <= c.y1 && q.z >= c.z0 && q.z <= c.z1) })
  }
  try {
    if (noBoom()) { out.why = 'кровати кончились'; return out }
    doing(ctl, 'pillar:enter')
    if (!(await pillarEnter(session, ctl, plan))) { out.why = 'в окоп не встал'; return out }
    // якорь в H с этого места щёлкается? (иначе — только кровати)
    if (anchorOk() && anchorAt() < 0 && !anClick(virtualBot(bot, new Map([[`${F.x},${yb},${F.z}`, 'block']])))) { st.noAnchor = true; out.anchor = 'не видно' }
    // открытость окопа взрыву в F: > 0.3 — якоря не ставить (урон нам ~2+ за взрыв)
    if (anchorOk() && !st.anExpo) { st.anExpo = exposure(bot, bot.entity.position, Acentre); out.anExpo = r1(st.anExpo * 100) / 100; if (st.anExpo > 0.3) { st.noAnchor = true; out.anchor = 'окоп открыт взрыву в F' } }
    let lastBoom = stats.lastBoom || 0
    let gapKey = null
    let keepKey = null
    const supBan = new Map()
    // снимок мира у станции R для seen (без клеток кровати и опоры под F — их форма зависит от яруса), один на цепочку
    let smSnap = null; const smCache = new Map()
    if (runnerLevels && RUN_SEEN()) {
      const t0s = gameClock.now()
      try { smSnap = smCompile(bot, [-16, P - 6, -16, 16, P + 16, 16], (x, y, z) => x === 0 && (z === 0 || z === F.z) && y >= P && y <= P + 1) } catch (e) { smSnap = null }
      out.smMs = gameClock.now() - t0s; out.smN = smSnap ? smSnap.colliders.length : null
    }
    // прогноз seen родителя и высоты тела над ярусом в тик щелчка — в событие bed (сверка с сервером, DragonLab)
    let fcNow = null
    const seenNote = (k) => {
      try {
        const st0 = fcNow && fcNow.path[k]
        if (!st0) return {}
        const o = { bodyDy: r1(st0.pos.y - yb) }
        if (smSnap) { const sp = smDragonSeen(smSnap, new Vec3(0.5, yb + 0.5, 0.5), st0.pos, yb > P ? [[0, P, F.z, 1, P + 1, F.z + 1]] : SM_EMPTY); if (sp != null) o.seenP = Math.round(sp * 1000) / 1000 }
        return o
      } catch (e) { return {} }
    }
    let pushed = null
    let placedSince = bedHere()
    // Поставленная кровать без прохода (садится/сел) — взорвать сейчас, а не отдать коробкам дракона (st1: «садится без
    // прохода» с кроватью у столба — сел на неё, checkWalls снёс без взрыва: s15 −2, s22 −2 из 6). На снижении взрыв ещё и
    // толкает — сесть не даст, цепочка живёт; сидящему — сидячий урон (голова в ~5.5 от подушки).
    const salvage = async (tag) => {
      if (!bedHere() || gameClock.now() < (stats.lastBoom || 0) + BED_GAP_MS) return false
      const eye = bot.entity.position.offset(0, EYE, 0)
      let hitCell = new Vec3(plan.click.cell.x, yb, plan.click.cell.z)
      let hit = faceClick(bot, eye, hitCell, new Vec3(plan.click.face.x, plan.click.face.y, plan.click.face.z))
      // плановая грань не видна (толчок сдвинул в окопе) — любая видимая грань кровати
      for (const cell of [F, H]) for (const fc of [[1, 0, 0], [-1, 0, 0], [0, 0, 1], [0, 0, -1], [0, -1, 0], [0, 1, 0]]) { if (!hit) { const c3 = new Vec3(cell.x, yb, cell.z); hit = faceClick(bot, eye, c3, new Vec3(fc[0], fc[1], fc[2])); if (hit) hitCell = c3 } }
      if (!hit) { out.salvageFail = (out.salvageFail || 0) + 1; return false }
      await lookAtSafe(bot, hit.point)
      await new Promise(resolve => bot.once('physicsTick', resolve))
      const r = await bedsBoom(session, ctl, stats, { ...plan, dist: null, expect: null, D: plan.a, y: yb, reuse: true }, { point: hit.point, block: bot.blockAt(hitCell) }, 'снижение', { aimed: true, until: gameClock.now(), uncounted: true, phCheck: p => p === PHASE.LANDING || SITTING.has(p), note: { oc: 'P', salvage: tag } })
      out.booms.push(r.ok ? r.dmg : null)
      out.salvage = (out.salvage || 0) + 1
      if (r.ok) { lastBoom = stats.lastBoom || gameClock.now(); st.booms++; placedSince = false; pushed = null }
      return r.ok
    }
    const tEnd = gameClock.now() + 60000
    while (!ctl.aborted && gameClock.now() < tEnd) {
      const dd = dragonOf(bot)
      if (!dd) { out.why = 'дракона нет'; break }
      const ph = phaseOf(bot, dd)
      if (ph !== PHASE.LANDING) {
        out.why = `фаза ${PHASE_RU[ph] ?? ph}`
        if (!runnerLevels && SITTING.has(ph) && process.env.ND_SALVAGE !== '0') await salvage('сел')
        break
      }
      if (noBoom()) {
        // R: кровати кончились, а дракон ещё снижается и хп мало — стрела в проход головы (ND_RUN_ARROW=0 — выкл.)
        const hpNow = hpOf(bot, dd)
        if (runnerLevels && RUN_ARROW() && hpNow != null && hpNow <= envNum('ND_RUN_ARROW_HP', 30) && (out.arrows || 0) < 3) {
          out.arrows = (out.arrows || 0) + 1
          doing(ctl, 'pillar:arrow')
          const a = await runnerArrow(session, ctl, feed, P, lastBoom)
          ;(out.arrowLog || (out.arrowLog = [])).push(a.shot ? { ...a.shot, hpAfter: a.hpAfter } : a.why)
          continue
        }
        out.why = 'кровати кончились'; break
      }
      if ((hpOf(bot, dd) ?? 1) <= 0) break
      if (bot.health < 10 && hunters(bot, 5).length) { out.why = 'эндермен бьёт'; break }
      const hereAn = anchorAt()
      const useAn = hereAn >= 0 || (!bedHere() && anchorOk() && (anMode === 'first' || countOf(bot, /_bed$/) < 1))
      if (hereAn === 0 && countOf(bot, /^glowstone$/) < 1) { out.why = 'якорь без заряда'; break }
      // прогноз: свежий по пакетам, а сразу после взрыва — с толчком
      let fc = landingForecast(feed, P)
      if (pushed && (!fc || fc.t < pushed.after)) fc = pushed.fc
      if (!fc) { await sleep(20); continue }
      fcNow = fc
      const nowTick = Math.round((gameClock.now() - fc.t) / 50)
      const minTick = Math.max(nowTick + 3, Math.ceil((lastBoom + BED_GAP_MS + 60 - fc.t) / 50))
      if (runnerLevels) {
        const q = bot.entity.position
        // толчок своего взрыва сдвигает в чаше (labR: 27 из 30 цепочек обрывались после первого взрыва) — вернуться в клетку
        if (bot.health < 10) { out.why = 'R: мало хп'; break }
        // без проверки exposure: первый взрыв сносит факелы столба, клиентский exposure считал их заслоном и рвал цепочку
        // (labR2: 16 из 17), а урон боту в чаше по серверу 0.3 за снижение
        if (!bot.entity.onGround || q.distanceTo(plan.feet) > 0.25) { if (await recenter()) continue; out.why = 'R: потеря защищённой позиции'; break }
        const danger = landingHits({ path: fc.path.slice(Math.max(0, nowTick), nowTick + 4) }, q)
        if (danger) { out.why = 'R: ' + danger.what; break }
        // Опора под F для P + 1 — сразу после взрыва, если её снесло (labS1: P + 1 выбран лишь в 43 % взрывов — к проходу булыжник
        // не успевал встать, окно подготовки < 20 тиков; P при этом слабее: 38 против 53). ND_RUN_KEEPCOB=0 — как было.
        // один раз на взрыв (иначе спор с ярусом P: ему эта клетка нужна пустой — изножье)
        if (RUN_KEEPCOB() && keepKey !== lastBoom && !bedHere() && runnerLevels.some(p => p.yb > P) && gameClock.now() - (lastBoom || 0) > 120 && !supBan.has('keep')) {
          keepKey = lastBoom
          const sb = bot.blockAt(new Vec3(0, P, F.z))
          if (isAirish(sb) && !landingHits({ path: fc.path.slice(Math.max(0, nowTick), nowTick + 8) }, q)) {
            const ok = await runnerSupport(bot, { ...plan, P }, 1)
            out.keepCob = (out.keepCob || 0) + 1
            if (!ok) { supBan.set('keep', true); (out.supWhy || (out.supWhy = [])).push('держать: ' + runnerSupport.why) }
            continue
          }
        }
        if (!bedHere()) {
          const rej = {}
          const choices = runnerLevels.map(p => {
            let i = -1, dist = Infinity
            for (let k = minTick; k < fc.path.length - 1; k++) {
              const d = fc.path[k].head.distanceTo(p.centre)
              if (d > fc.path[k - 1].head.distanceTo(p.centre) || d > fc.path[k + 1].head.distanceTo(p.centre)) continue
              if (d < dist) { i = k; dist = d }
            }
            // коробка родителя закроет F в тик прохода — ближайший ранний тик, где не закрывает (тело выше), с его расстоянием
            if (RUN_BOX() && i >= 0 && bodyBlocksBed(fc.path[i].pos, p.F, p.yb)) {
              let c = i
              while (c > minTick && bodyBlocksBed(fc.path[c].pos, p.F, p.yb)) c--
              if (bodyBlocksBed(fc.path[c].pos, p.F, p.yb) || fc.path[c].head.distanceTo(p.centre) > 4.6) { i = -1; rej[p.yb - P] = 'коробка' } else { i = c; dist = fc.path[c].head.distanceTo(p.centre) }
            } else if (i < 0) rej[p.yb - P] = 'нет прохода'
            let score = null
            if (RUN_SEEN() && i >= 0 && smSnap) {
              const extra = p.yb > P ? [[0, P, F.z, 1, P + 1, F.z + 1]] : SM_EMPTY
              const key = `${p.yb}|${r1(fc.path[i].pos.x)}|${r1(fc.path[i].pos.y)}|${r1(fc.path[i].pos.z)}`
              let seen = smCache.get(key)
              if (seen === undefined) { seen = smDragonSeen(smSnap, p.centre, fc.path[i].pos, extra); smCache.set(key, seen) }
              score = seen == null ? null : bedDamage(dist, seen)
            }
            return { p, i, dist, score }
          }).filter(c => {
            if (c.i < 0) return false
            const b = bot.blockAt(new Vec3(0, P, F.z))
            const ready = c.p.yb > P ? (b || {}).name === 'cobblestone' : isAirish(b)
            // ярус, опору которого только что не удалось подготовить, — не раньше, чем через 2.5 с (rs3-s2: цепочка рвалась)
            if (!ready && supBan.has(c.p.yb) && gameClock.now() < supBan.get(c.p.yb)) { rej[c.p.yb - P] = 'бан'; return false }
            if (!ready && c.i - nowTick < 20) { rej[c.p.yb - P] = `не готов (${c.i - nowTick} т.)`; return false }
            return true
          }).sort((a, b) => (a.score != null && b.score != null ? b.score - a.score : 0) || (RUN_HIGH() ? b.p.yb - a.p.yb : 0) || a.dist - b.dist)
          const best = choices[0]
          if (!best) { await sleep(30); continue }
          if (best) {
            const support = bot.blockAt(new Vec3(0, P, F.z)), dy = best.p.yb - P
            const ready = dy ? (support || {}).name === 'cobblestone' : isAirish(support)
            if (!ready) {
              // Окно подготовки — не менее 20 тиков, без коробок на всём этом интервале.
              if (best.i - nowTick < 20 || landingHits({ path: fc.path.slice(Math.max(0, nowTick), nowTick + 20) }, q)) { await sleep(30); continue }
              // 02.10 (rs3-s2: «R: опора не подтверждена» рвал цепочку после 2 взрывов, и второй заход — сразу): не рвать — на 2.5 с
              // этот ярус не брать, взять готовый (на P опоре быть воздухом — после взрыва булыжник обычно снесён)
              if (!await runnerSupport(bot, plan, dy)) { out.supFail = (out.supFail || 0) + 1; (out.supWhy || (out.supWhy = [])).push(runnerSupport.why); supBan.set(best.p.yb, gameClock.now() + 2500); if (out.supFail > 6) { out.why = 'R: опора не подтверждена'; break } continue }
              continue // после await только свежий landingForecast/pushedForecast
            }
            plan = { ...best.p, runnerLevels }; st.plan = plan
            H = plan.H; F = plan.F; yb = plan.yb
            bedCells.splice(0, bedCells.length, F, H)
            const heightRec = { y: yb, headY: r1(fc.path[best.i].head.y * 10) / 10, pass: best.i, dist: r1(best.dist * 10) / 10, alt: choices.length > 1 ? r1(choices[1].dist * 10) / 10 : null, ...(Object.keys(rej).length ? { rej } : {}) }
            // запись — только когда выбор сменился (rs1: 149 одинаковых событий на цепочку)
            const rhKey = `${heightRec.y}|${heightRec.pass}`
            if (rhKey !== out.rhKey) { out.rhKey = rhKey; (out.runnerHeights || (out.runnerHeights = [])).push(heightRec); ev('runnerHeight', heightRec) }
          }
        }
      }
      // ближайший проход головы у подушки (локальный минимум ≤ 3.2), кровать не задета до него
      const ctr = useAn ? Acentre : plan.centre
      // Проход и свободное окно кровати — вместе (Codex dragon-series, 01.10: проход брался до проверки окна — первый
      // минимум ≤ 3.2, даже если кровать к нему не поставить (коробки дракона на клетках), а ранний пригодный 3–4 пропускался;
      // в 17 из 20 пустых посадок st2–st4 свободный минимум ≤ 4 был, нынешний порядок брал его в 6 из 20).
      // Ярусы: ≤ 3.2; ≤ 4.6 (первая кровать снижения — ≤ FIRST_MAX); ≤ 6.5 у конца захода — только идущей цепочке (толчок).
      const started = out.booms.some(b => typeof b === 'number')
      const mins = []
      for (let i = Math.max(1, minTick - 1); i < fc.path.length - 1; i++) {
        const a = fc.path[i - 1]; const b = fc.path[i]; const c = fc.path[i + 1]
        const d = b.head.distanceTo(ctr)
        if (i < minTick || d > a.head.distanceTo(ctr) || d > c.head.distanceTo(ctr)) continue
        if (d <= 6.5) mins.push({ i, d })
      }
      // Тик взрыва и когда ставить. Коробки дракона (голова/шея/тело) «съедают» кровать на клетках F/H (checkWalls): взрыв —
      // в последний тик c ≤ прохода, когда клетки свободны в c и c + 1; ставить — в свободном промежутке до c (≥ 3 тика на
      // ставку), а если кровать уже стоит — промежуток должен начинаться сейчас.
      const free = k => { const s2 = fc.path[k]; return !s2 || !cellHit(s2) }
      const placedNow = bedHere()
      // ND_PLACE_CLICK: 2 (по умолчанию с 02.10) — кровать ставится и взрывается двумя пакетами в тик прохода, коробки не
      // проверяются (lab6 на P: урон p50 44.4 → 45.1, ≥ 50 16 → 23 %, урон за снижение 263 → 271, урон боту тот же);
      // 1 — то же, но тик без коробок на клетках; 0 — как было (кровать за PLACE_LEAD тиков до щелчка)
      const pcMode = envv('ND_PLACE_CLICK') ?? '2'
      const placeClick = !useAn && (pcMode === '1' || pcMode === '2') && !placedNow
      const placeClick2 = placeClick && pcMode === '2'
      const firstMax = envNum('ND_FIRST_MAX', FIRST_MAX)
      const lim = started ? 6.5 : firstMax
      // ND_EAT_MARGIN=0 — кровать нужна целой только до тика взрыва c (щелчок обработан между тиками c и c + 1),
      // без запаса на поздний щелчок (лаборатория 02.10: щелчок −25 мс от конца окна — в середине тика)
      const eatMargin = envNum('ND_EAT_MARGIN', 1)
      // ND_MIN_BLAST_HP — не щёлкать в тик c, где прогнозный урон головы (bedDamage, видимость ND_MIN_BLAST_SEEN, 1 —
      // по замеру лаборатории seen p50 0.99) ниже порога: ранний «безопасный» тик слабее самого прохода (Codex dragon-blast, 02.10). 0 — выкл.
      const minBlastHp = Math.max(0, envNum('ND_MIN_BLAST_HP', 0)); const minBlastSeen = envNum('ND_MIN_BLAST_SEEN', 1)
      const windowFor = m => {
        if (useAn) return { clickI: m.i, safeFrom: nowTick }
        // ND_PLACE_CLICK=1: кровать ставится и взрывается двумя пакетами в одном окне тика — коробки дракона её не застают;
        // нужна только свободная клетка в тик взрыва c (сервер не ставит блок в коробку сущности)
        if (placeClick) {
          for (let c = m.i; c >= nowTick + 1; c--) {
            // ND_PLACE_CLICK=2 — и без проверки коробок: части дракона стройке не мешают (Entity.blocksBuilding у EnderDragonPart
            // нет; lab5: 14 неудачных ставок из 499), а checkWalls кровать, поставленную и взорванную между тиками, не застаёт
            if (placeClick2 ? false : !free(c)) continue
            // R: низ коробки родителя 16×8×16 (LivingEntity.blocksBuilding) ниже верха кровати в F — ставка не пройдёт (rs3/rs4:
            // 10 из 10 «ставка не прошла» — тело в 0.1–1.5 над ярусом кровати и снижается); раньше — тело выше
            if (RUN_BOX() && runnerLevels && bodyBlocksBed(fc.path[c].pos, F, yb)) continue
            const cd = fc.path[c].head.distanceTo(ctr)
            if (cd > lim) return null
            if (minBlastHp > 0 && bedDamage(cd, minBlastSeen) < minBlastHp) return null
            // R + seen: среди этого тика и до 3 более ранних (тело выше — seen больше) — наибольший прогнозный урон
            if (runnerLevels && RUN_SEEN() && smSnap && RUN_TICKSEEN()) {
              const extra = yb > P ? [[0, P, F.z, 1, P + 1, F.z + 1]] : SM_EMPTY
              let best = null
              for (let c2 = c; c2 >= Math.max(nowTick + 1, c - 3, minTick); c2--) {
                if (RUN_BOX() && bodyBlocksBed(fc.path[c2].pos, F, yb)) continue
                const d2 = fc.path[c2].head.distanceTo(ctr)
                if (d2 > lim) break
                const sn = smDragonSeen(smSnap, ctr, fc.path[c2].pos, extra)
                const sc = bedDamage(d2, sn == null ? 0.95 : sn)
                if (!best || sc > best.sc + 0.5) best = { c: c2, sc }
              }
              if (best) return { clickI: best.c, safeFrom: best.c }
            }
            return { clickI: c, safeFrom: c }
          }
          return null
        }
        for (let c = m.i; c >= nowTick + 1; c--) {
          if (!free(c) || (eatMargin && !free(c + 1))) continue
          let w0 = c
          while (w0 - 1 >= nowTick && free(w0 - 1)) w0--
          if (placedNow ? w0 > nowTick : c - w0 < 3) continue
          const clickDist = fc.path[c].head.distanceTo(ctr)
          if (clickDist > lim) return null
          if (minBlastHp > 0 && bedDamage(clickDist, minBlastSeen) < minBlastHp) return null
          return { clickI: c, safeFrom: w0 }
        }
        return null
      }
      // Ярусы прохода: ND_PASS_T1 (3.2), ND_PASS_T2 (4.6), ND_PASS_END=0 — без дальнего прохода у конца захода
      const passT1 = envNum('ND_PASS_T1', 3.2); const passT2 = envNum('ND_PASS_T2', 4.6); const passEnd = envNum('ND_PASS_END', 1)
      const tiers = [m => m.d <= passT1, m => m.d <= (started ? passT2 : Math.min(passT2, firstMax)), m => passEnd && started && fc.n - nowTick < 40]
      let pass = null; let win = null
      for (const okT of tiers) {
        for (const m of mins) { if (!okT(m)) continue; const w = windowFor(m); if (w) { pass = m; win = w; break } }
        if (pass) break
      }
      if (!pass) {
        // сядет без прохода — дальше сидячие кровати. Не раньше, чем за 6 тиков: после толчков прогноз конца
        // захода ошибается, а голова на деле проходит у подушки за ~10–13 тиков до «сел» (запись сервера pil8-9,
        // -10, -12: 2.3–4.2 бл.) — свежий прогноз его покажет, если ждать (было < 25 — бросали за ~1.2 с).
        if (fc.n - nowTick < 6) {
          if (!runnerLevels && !useAn && process.env.ND_SALVAGE !== '0' && await salvage('садится')) continue
          out.why = 'садится без прохода'; break
        }
        await sleep(40); continue
      }
      if (useAn && hereAn < 1) {
        // якорь: поставить и зарядить сейчас (дракон его не сносит), не раньше 120 мс после взрыва
        if (gameClock.now() < (lastBoom || 0) + 120) { await sleep(40); continue }
        doing(ctl, 'pillar:anchor')
        if (hereAn < 0) {
          // как кровать: к той же грани опоры K, прицел — по видимой точке (без факелов на луче)
          const K = bot.blockAt(new Vec3(plan.place.K.x, plan.place.K.y, plan.place.K.z))
          const fcl = K && faceClick(bot, bot.entity.position.offset(0, EYE, 0), K.position, plan.place.face, { avoidTorch: torchHitP })
          const it = findItem(bot, /^respawn_anchor$/)
          if (fcl && it) {
            await bot.equip(it, 'hand').catch(() => {})
            bot.setControlState('sneak', false)
            await bot.lookAt(fcl.point, true)
            await new Promise(resolve => bot.once('physicsTick', resolve))
            const cur = fcl.point.minus(K.position)
            bot._client.write('block_place', { location: K.position, direction: FACE_IDX(plan.place.face), hand: 0, cursorX: cur.x, cursorY: cur.y, cursorZ: cur.z, insideBlock: false, sequence: 0, worldBorderHit: false })
            bot.swingArm()
            const tw = gameClock.now()
            while (gameClock.now() - tw < 400 && anchorAt() < 0) await sleep(20)
          }
          if (!fcl && await recenter()) continue
          if (anchorAt() < 0) { out.anFail = (out.anFail || 0) + 1; if (out.anFail > 2) { st.noAnchor = true; out.anchor = fcl ? 'не встаёт' : 'опору не видно' } continue }
        }
        const c = await chargeAnchor(bot, { H: { x: F.x, z: F.z }, yb }, 1, () => { const h = anClick(bot); return h && { ...h, block: bot.blockAt(Apos) } })
        if (!c.ok) { out.anFail = (out.anFail || 0) + 1; if (out.anFail > 3) { out.why = `якорь: ${c.why}`; break } continue }
        continue
      }
      const clickI = win.clickI; const safeFrom = win.safeFrom
      // Ставить не в начале свободного окна, а за PLACE_LEAD тиков до щелчка (st4: кровати, поставленные заранее, съедали
      // коробки дракона или они оставались у столба при «садится без прохода» — s13 −2, s14 −2 из 6). ND_PLACE_LEAD=0 — как было.
      const placeLead = envNum('ND_PLACE_LEAD', PLACE_LEAD)
      const tPlace = fc.t + 50 * (placeLead > 0 ? Math.max(safeFrom, clickI - placeLead) : safeFrom)
      // Поставленная кровать пропала до щелчка (коробки дракона, checkWalls) — потеря из бюджета (01.10: с 7
      // кроватями бой кончался на 6 взрывах в 41 из 58 вызовов — одна уходила молча, без события).
      if (!useAn && placedSince && !bedHere()) {
        placedSince = false
        out.lost = (out.lost || 0) + 1
        ev('bedLost', { ph: PHASE_RU[ph] ?? ph, tick: nowTick, n: fc.n })
        console.log(`[bed] пропала до щелчка (съели коробки дракона?), тик ${nowTick} из ${fc.n}`)
      }
      if (!useAn && !bedHere() && !placeClick) {
        if (tPlace - gameClock.now() > 120) { await sleep(Math.min(200, tPlace - gameClock.now() - 100)); continue }
        if (gameClock.now() < (lastBoom || 0) + 120) { await sleep(40); continue }
        doing(ctl, 'pillar:bed')
        const K = bot.blockAt(new Vec3(plan.place.K.x, plan.place.K.y, plan.place.K.z))
        const fcl = K && (runnerLevels && RUN_FACING() ? faceClickFacing(bot, bot.entity.position.offset(0, EYE, 0), K.position, plan.place.face, { x: H.x - F.x, z: H.z - F.z }) : faceClick(bot, bot.entity.position.offset(0, EYE, 0), K.position, plan.place.face))
        if (!fcl) {
          if (await recenter()) continue
          // станция с этого места не работает (мир не как в плане: леса, выбитый эндерняк) — перепланировать,
          // пока дракон далеко (pil8-15: «грань опоры не видно» при боте точно в окопе)
          const e = bot.entity.position.offset(0, EYE, 0)
          out.dbg = { eye: [r1(e.x), r1(e.y), r1(e.z)], K: [plan.place.K.x, plan.place.K.y, plan.place.K.z], Kname: (K || {}).name, here: !!pillarHere(bot, plan) }
          st.built = false
          out.why = 'грань опоры не видно'; break
        }
        const bedItem = findItem(bot, /_bed$/)
        await bot.equip(bedItem, 'hand').catch(() => {})
        bot.setControlState('sneak', false)
        await bot.lookAt(fcl.point, true)
        await new Promise(resolve => bot.once('physicsTick', resolve))
        // сырой пакет: грань и точка — те, что видны (placeBlock сам смотрит в середину грани)
        const cur = fcl.point.minus(K.position)
        bot._client.write('block_place', { location: K.position, direction: FACE_IDX(plan.place.face), hand: 0, cursorX: cur.x, cursorY: cur.y, cursorZ: cur.z, insideBlock: false, sequence: 0, worldBorderHit: false })
        bot.swingArm()
        const tw = gameClock.now()
        while (gameClock.now() - tw < 400 && !bedHere()) await sleep(20)
        if (!bedHere()) { out.bedFail = (out.bedFail || 0) + 1; if (out.bedFail > 3) { out.why = 'кровать не встаёт'; break } continue }
        placedSince = true
      }
      // щелчок в тик прохода
      const eyeNow = bot.entity.position.offset(0, EYE, 0)
      const vBed = placeClick ? virtualBot(bot, new Map([[`${F.x},${yb},${F.z}`, 'bed'], [`${H.x},${yb},${H.z}`, 'bed']])) : bot
      const hit = useAn ? anClick(bot) : faceClick(vBed, eyeNow, new Vec3(plan.click.cell.x, yb, plan.click.cell.z), new Vec3(plan.click.face.x, plan.click.face.y, plan.click.face.z))
      // ставка в тот же миг: грань опоры K (взгляд — на неё: по горизонтали взгляда сервер кладёт изголовье)
      let pre = null
      if (placeClick && hit) {
        const Kb = bot.blockAt(new Vec3(plan.place.K.x, plan.place.K.y, plan.place.K.z))
        const fk = Kb && (runnerLevels && RUN_FACING() ? faceClickFacing(bot, eyeNow, Kb.position, plan.place.face, { x: H.x - F.x, z: H.z - F.z }) : faceClick(bot, eyeNow, Kb.position, plan.place.face))
        if (!fk) { if (await recenter()) continue; st.built = false; out.why = 'грань опоры не видно'; break }
        pre = { pos: Kb.position, face: plan.place.face, point: fk.point }
      }
      if (!hit) { if (await recenter()) continue; if (!useAn) st.built = false; out.why = useAn ? 'якорь не видно' : 'кровать не видно'; break }
      // +1 тик против L: по записи сервера (an-pilltiming.js, 90 взрывов pil2) лучший тик — на 1 позже в 81 из 90
      // ND_CLICK_OFS — мс от конца тика прохода по часам пакета. −25 — середина окна тика (lab1c–lab4: при −5 37–42 % взрывов
      // уходили на тик позже, урон p50 40 → 44.7, доля ≥ 50 вдвое; AUDIT.md Codex по байткоду)
      const tClick = fc.t + 50 * (clickI + 1) + envNum('ND_CLICK_OFS', -25)
      const dClick = clickI === pass.i ? pass.d : fc.path[clickI].head.distanceTo(ctr)
      // щёлкать — по свежему прогнозу, когда до прохода ≤ 8 тиков (на 30 тиков вперёд прогноз спирали
      // ошибается на 2–3 блока: pil1-8 — ждали 41, вышло 15)
      const aimAt = pre ? pre.point : hit.point
      // R: стрела в промежутке, пока до щелчка ≥ 1.5 с (ND_RUN_GAPARROW=1); одна попытка на промежуток
      if (runnerLevels && RUN_GAPARROW() && tClick - gameClock.now() > 1500 && gapKey !== lastBoom && bot.health >= 10 && countOf(bot, /arrow$/) > 0) {
        gapKey = lastBoom
        const ga = await runnerGapArrow(session, ctl, feed, P, { minHit: (lastBoom || 0) + 560, maxHit: tClick - 560, deadline: tClick - 330 })
        ;(out.gapLog || (out.gapLog = [])).push(ga.shot ? { ...ga.shot, hpAfter: ga.hpAfter } : ga.why)
        continue
      }
      if (tClick - gameClock.now() > 260) { await lookAtSafe(bot, aimAt); await sleep(30); continue }
      await lookAtSafe(bot, aimAt)
      if (pre) { const bi = findItem(bot, /_bed$/); if (!bi) { out.why = 'кровати кончились'; break } if (!bot.heldItem || !/_bed$/.test(bot.heldItem.name)) await bot.equip(bi, 'hand').catch(() => {}) }
      await new Promise(resolve => bot.once('physicsTick', resolve))
      const r = await bedsBoom(session, ctl, stats, { ...plan, ...(useAn ? { H: { x: F.x, z: F.z }, centre: Acentre } : {}), anchor: useAn, dist: r1(dClick), expect: bedDamage(dClick, plan.seen || 1), D: plan.a, y: yb, reuse: true }, { point: hit.point, face: runnerLevels ? plan.click.face : null, runnerGuard: runnerLevels ? () => {
        const q = bot.entity.position, f = landingForecast(feed, P) || fc
        const k = Math.max(0, Math.round((gameClock.now() - f.t) / 50))
        const dd = dragonOf(bot)
        // причина отказа — строкой (в трассу bedFail), годится — true
        if (ctl.aborted) return 'прервано'
        if (!dd || phaseOf(bot, dd) !== PHASE.LANDING) return 'фаза'
        if (k >= f.path.length) return 'прогноз кончился'
        if (!bot.entity.onGround) return 'не на земле'
        if (q.distanceTo(plan.feet) > 0.15) return `сдвинут ${r1(q.distanceTo(plan.feet) * 10) / 10}`
        if (bot.health < 10) return 'мало хп'
        // свежий прогноз в миг щелчка: голова в тик взрыва далеко (rs6-s1: прогноз 1.3, по серверу 11.1 — урон 0.3) — кровать не тратить;
        // порог с запасом (rs7-s18: вето при 3.3 на раннем тике — цепочка оборвалась, дракон сел)
        { const kc = Math.round((tClick + 25 - f.t) / 50); const st2 = f.path[Math.min(f.path.length - 1, Math.max(0, kc))]; const hd = st2 ? st2.head.distanceTo(ctr) : null; if (RUN_LATEHEAD() && hd != null && hd > Math.max(6.5, dClick + 3)) return `голова ${r1(hd)}` }
        if (landingHits({ path: f.path.slice(k, k + 3) }, q)) return 'коробки дракона'
        const v = virtualBot(bot, new Map([[`${F.x},${yb},${F.z}`, 'bed'], [`${H.x},${yb},${H.z}`, 'bed']]))
        const eye = q.offset(0, EYE, 0)
        if (!faceClick(v, eye, new Vec3(F.x, yb, F.z), plan.click.face)) return 'бок кровати не виден'
        if (!(RUN_FACING() ? faceClickFacing(bot, eye, new Vec3(plan.place.K.x, yb, plan.place.K.z), plan.place.face, { x: H.x - F.x, z: H.z - F.z }, { minCos: 0.75 }) : faceClick(bot, eye, new Vec3(plan.place.K.x, yb, plan.place.K.z), plan.place.face))) return 'грань K не видна'
        return true
      } : null, block: useAn ? bot.blockAt(Apos) : bot.blockAt(new Vec3(plan.click.cell.x, yb, plan.click.cell.z)) }, 'снижение', { aimed: true, until: Math.max(tClick, (stats.lastBoom || 0) + BED_GAP_MS), uncounted: true, ...(pre ? { keepHand: true, prePlace: pre } : {}), phCheck: p => p === PHASE.LANDING, note: { ...(pre ? { pc: 1 } : {}), ...(runnerLevels ? { runnerY: yb, ...seenNote(clickI) } : {}), oc: useAn ? 'PA' : 'P', pass: clickI, headDist: r1(dClick), fcT: fc.t, fcWall: fc.wallMs, tClick, ...(clickI !== pass.i ? { early: pass.i - clickI } : {}) } })
      // кровать пропала без удара по дракону и без урона нам — её снесли коробки дракона (checkWalls), взрыва
      // не было: толчка нет, прогноз — свежий (pil6-15, pil6-21: «съеденная» кровать на последнем заходе)
      const eaten = r.ok && !useAn && r.lagMs == null && !r.dmg && !r.self
      if (r.ok) placedSince = false
      out.booms.push(r.ok ? (eaten ? 'съели' : r.dmg) : null)
      if (!r.ok) (out.fails || (out.fails = [])).push(r.why)
      if (eaten) { out.eaten = (out.eaten || 0) + 1; pushed = null; continue }
      if (r.ok) {
        lastBoom = stats.lastBoom || gameClock.now()
        st.booms++
        const pf = pushedForecast(fc, clickI, ctr, plan.seen || 1, P)
        pushed = pf ? { fc: { ...pf, t: fc.t }, after: gameClock.now() + 150 } : null
      } else if (!useAn && !bedHere()) { /* снесло — следующая */ }
    }
    return out
  } finally {
    out.ms = gameClock.now() - t0
    ev('pillarRun', out)
  }
}

async function bedsPerch (session, ctl, rep, stats, track) {
  const bot = session.bot
  let d = track.tick()
  if (!d) return
  const tIn = gameClock.now()
  const rec0 = sitState(d, phaseOf(bot, d), tIn)
  const key = rec0 ? rec0.t0 : tIn
  stats.bedPerches = stats.bedPerches || []
  let P = stats.bedPerches.find(p => p.key === key)
  if (!P) {
    P = { key, at: Math.round((key - (ctl.started || key)) / 1000), hp0: Math.round(hpOf(bot, d) ?? 0), beds: [], fails: 0 }
    stats.bedPerches.push(P)
    if (ctl.trace) ctl.trace.ev('bedsPerch', { hp: P.hp0, acc: Math.round(sitAcc.dmg) })
  }
  // План «взлёт» с этой посадки (ocLanding: L уже взорвана) — A, T1, T2 вместо A, B.
  if (ctl.ocTk && ctl.ocTk.dId === d.id && gameClock.now() - ctl.ocTk.t < 8000 && blindKnown(rec0) && !P.tk) {
    const tkP = ctl.ocTk; ctl.ocTk = null; P.tk = true
    const r = await ocTakeoffRun(session, ctl, rep, stats, track, P, tkP)
    const dd = dragonOf(bot)
    if (!dd || !SITTING.has(phaseOf(bot, dd))) return
    P.tkWhy = r.why
  }
  let tries = 0
  let stayAt = null
  // Планы, что сейчас не вышли (пол не встал, кровать не легла): ключ → до когда.
  const failed = new Map()
  const skipNow = () => { const s = new Set(); for (const [k, t] of failed) if (t > gameClock.now()) s.add(k); return s }
  while (!ctl.aborted && tries < 14) {
    await yieldTick()
    d = track.tick()
    if (!d) break
    const ph = phaseOf(bot, d)
    const hpD = hpOf(bot, d)
    if (hpD != null && hpD <= 0) break
    const now = gameClock.now()
    const sitting = SITTING.has(ph)
    const takeoffWin = BEDS_TAKEOFF && ph === PHASE.TAKEOFF && now - (stats.lastBoom || 0) < 700
    if (!sitting && !takeoffWin) break
    if (countOf(bot, /_bed$/) < 1) { P.why = 'кровати кончились'; break }
    if (countOf(bot, FILLER_RE) < 1) { P.why = 'нет блоков на заслон'; break }
    const rec = sitState(d, ph, now)
    if (rec) noteNear(rec, d, bot, now)
    const parts = partsOf(bot, d, track)
    // Под ногами облако или летит фаербол — уйти и продолжить.
    // Видящему (и пока не ясно) — круг поворота головы как опасность и для ухода
    // от облака: b4-24 (попытка 2, 532 с) — уход от облака огня к телу (4.2 от
    // центра), удар головой, смерть.
    const sweep = sitting && !blindKnown(rec, now) ? { pos: d.position, dir: parts.dir } : null
    const ctx0 = { clouds: cloudsOf(bot), fireballs: fireballsOf(bot).filter(f => f.ticks < 30), parts: null, breath: null, sweep }
    // Видящий высматривает — голова пойдёт к нам: из круга её поворота выйти.
    const seeingScan = sitting && ph === PHASE.SCANNING && !blindKnown(rec, now)
    if (seeingScan && !turnSafe(d, bot.entity.position)) {
      const me = bot.entity.position
      const rx = me.x - d.position.x; const rz = me.z - d.position.z; const rh = Math.hypot(rx, rz) || 1
      const tx = d.position.x + rx / rh * (TURN_SAFE_R + 1.2); const tz = d.position.z + rz / rh * (TURN_SAFE_R + 1.2)
      const ty = standY(bot, tx, tz, me.y, 2, 3)
      doing(ctl, 'beds:out-of-turn')
      if (ctl.trace) ctl.trace.ev('evade', { kind: 'круг поворота головы', to: [r1(tx), ty, r1(tz)] })
      if (ty != null) await stepTo(bot, ctl, new Vec3(tx, ty, tz), { ms: 1200, stopAt: 0.4 })
      else await sleep(100)
      tries++
      continue
    }
    const bad = dangerAt(bot, bot.entity.position, ctx0) || (hurtNear(playerBox(bot.entity.position), parts) ? { kind: 'голова дракона' } : null)
    if (bad && !(bot.health >= 16 && /облако/.test(bad.kind))) { await evade(bot, ctl, stats, { ...bad, ctx: { ...ctx0, parts } }); tries++; continue }
    if (bot.health < 9) {
      await heal(session, ctl, rep, stats, { hard: true })
      if (bot.health < 9) { P.why = `мало хп (${Math.round(bot.health)})`; break }
    }
    // Видящий первые 25 тиков доворачивает голову к нам — план до рёва только
    // чтобы подойти; кровать — когда голова встала (рёв/огонь) или слепой.
    const settled = !sitting || !rec || blindKnown(rec, now) || ph !== PHASE.SCANNING
    // Голова ещё поворачивается (видящий высматривает, первые 25 тиков): идти
    // к нему по своему лучу — на ~11 от тела. Он доворачивает голову к нам
    // (DragonSittingScanningPhase, тем быстрее, чем ближе мы к голове), и она
    // ложится между нами и телом: место у кровати — в паре шагов.
    if (!settled) {
      const me = bot.entity.position
      const rx = me.x - d.position.x; const rz = me.z - d.position.z
      const rh = Math.hypot(rx, rz) || 1
      const P0 = podiumTop(bot)
      if (rh > 12.5) {
        const tx = d.position.x + rx / rh * 11; const tz = d.position.z + rz / rh * 11
        const ty = standY(bot, tx, tz, me.y, 2, 3)
        const t = ty != null ? new Vec3(Math.floor(tx) + 0.5, ty, Math.floor(tz) + 0.5) : null
        if (t && !nearPortal(t) && !(P0 != null && ty > P0 - 2.5) && clearOfDragon(bot, me, t, parts)) {
          doing(ctl, 'beds:approach')
          await stepTo(bot, ctl, t, { ms: 1200, sprint: true, stopAt: 0.6 })
          continue
        }
      }
      doing(ctl, 'beds:ready')
      await lookAtSafe(bot, parts.headC)
      await sleep(80)
      continue
    }
    let headAt = null
    if (takeoffWin) {
      // Взлёт: голова идёт вперёд по взгляду, к щелчку (конец неуязвимости) —
      // ~4.5 блока за 10 тиков от старта (трассы), чуть выше; щёлкаем с той же клетки.
      const lead = Math.max(2, (stats.lastBoom + BED_GAP_MS + 150 - now) / 50)
      const v = track.vel()
      const sp = Math.max(0.45, Math.hypot(v.x, v.z))
      headAt = new Vec3(parts.headC.x + parts.dir.x * sp * lead, parts.head.min.y + 0.8, parts.headC.z + parts.dir.z * sp * lead)
      const p = bot.entity.position
      stayAt = { x: Math.floor(p.x), z: Math.floor(p.z) }
    }
    // Видящий, голова встала (рёв/огонь): станции в окопе у неё — A (≤ 50 − счёт), потом B.
    if (OC_ON && process.env.ND_SEE_TS === '1' && sitting && !takeoffWin && rec && rec.roared && ph !== PHASE.SCANNING && countOf(bot, /_bed$/) >= 1 && (P.seeFails || 0) < 3) {
      seeCalibrate(bot, d)
      const capS = sitAcc.dmg < 25 ? 49 - sitAcc.dmg : null
      const r = await seeStation(session, ctl, stats, track, d, P, { cap: capS })
      if (r.dmg != null) { tries++; continue }
      P.seeFails = (P.seeFails || 0) + 1
    }
    // Слепой сидит, A уже была (счёт 20…50): вместо B (поднимет на взлёт с толчком) — T1 на
    // сам-взлёт (99-й тик, голова почти на месте, урон вне сидячего счёта). fin5: удалось 5 из ~25
    // (стройка за 2.3 с не успевает), B при этом терялась — только по ND_OC_T1=1.
    if (OC_ON && process.env.ND_OC_T1 === '1' && sitting && !takeoffWin && blindKnown(rec, now) && sitAcc.dmg >= 20 && sitAcc.dmg <= 50 && !P.t1Tried && rec && now - rec.t0 < 2700 && countOf(bot, /_bed$/) >= 1) {
      P.t1Tried = true
      const r = await ocT1(session, ctl, stats, track, d, rec, P)
      if (r.dmg != null) break
    }
    const brave = bot.health >= 16 || (hasEffect(bot, 'absorption') && bot.health >= 12)
    // Первая кровать посадки — не больше 50 сидячего урона (иначе сразу взлёт и
    // второй сидя не будет). Настоящий урон — ожидаемый ± 3 (b1, 30.09).
    const cap = sitting && sitAcc.dmg < 30 ? 46 - sitAcc.dmg : null
    // Добить мечом: слепой сидит, хп ≤ остатка сидячего счёта (удары его не поднимут).
    if (sitting && blindKnown(rec, now) && hpD != null && hpD <= Math.max(7, 50 - sitAcc.dmg) && !P.finished) {
      P.finished = true
      const f = await meleeFinish(session, ctl, stats, track)
      if (f.ok) continue
    }
    // Сперва двойная станция (A/B под головой + C на взлёте); нет её — одна кровать.
    if (BEDS_DOUBLE && sitting && !takeoffWin && countOf(bot, /_bed$/) >= 2 && !(P.doubleFails >= 2)) {
      const dp = bedsDouble(bot, d, parts, { brave, cap, skip: skipNow() })
      if (dp) {
        const r = await doubleRun(session, ctl, rep, stats, track, P, dp)
        P.double = (P.double || 0) + 1
        if (r.ok) { if (!r.booms) tries++; continue }
        P.doubleFails = (P.doubleFails || 0) + 1
        P.lastWhy = r.why
        failed.set(dp.key, gameClock.now() + 5000)
        if (ctl.trace) ctl.trace.ev('bedFail', { why: `двойная: ${r.why}` })
        tries++
        continue
      }
      P.noDouble = bedsDouble.why
    }
    // Слепой сидит, первая кровать уже была (счёт ≥ 30): вторая — станцией в окопе под
    // точной головой (кровать на блок выше земли: центр взрыва в 0.5 от низа головы).
    // (Выключено по умолчанию, ND_OC_TSB=1: окоп для B строится ~3 с — к взлёту слепого на
    // 4.95 с чаще не успевает; вместо него B «на своём блоке» в bedsLayout, liftMax.)
    if (process.env.ND_OC_TSB === '1' && OC_ON && sitting && !takeoffWin && cap == null && blindKnown(rec, now) && !P.tsTried && rec && now - rec.t0 < 3300) {
      const fix = sitFix.get(d.id)
      if (fix && fix.head) {
        P.tsTried = true
        const tp = tsPlan(bot, fix.head, { lift: 1, dpos: d.position })
        if (ctl.trace) ctl.trace.ev('ocB', tp ? { H: [tp.H.x, tp.yb, tp.H.z], dist: tp.dist, expect: tp.expect } : { no: tsPlan.why })
        if (tp && tp.expect >= 52) {
          ctl.holdStation = true
          let tb
          try { tb = await tsBuild(session, ctl, stats, tp) } finally { ctl.holdStation = false }
          const dd = dragonOf(bot)
          if (tb.ok && dd && SITTING.has(phaseOf(bot, dd))) {
            const hit = tsClickPoint(bot, bot.entity.position.offset(0, EYE, 0), tp)
            if (hit) {
              const boom = await bedsBoom(session, ctl, stats, tp, hit, 'сидит', { note: { oc: 'B' } })
              if (boom.ok) { P.beds.push(boom.dmg); continue }
            }
          }
          if (ctl.trace) ctl.trace.ev('bedFail', { why: `B в окопе: ${tb.ok ? 'щелчок' : tb.why}` })
        }
      }
    }
    const hurry = OC_ON && sitting && cap == null && blindKnown(rec, now) && !!rec && now - rec.t0 > 3000
    const plan = bedsLayout(bot, d, parts, { headAt, stayAt: takeoffWin ? stayAt : null, brave, cap, skip: skipNow(), liftMax: OC_ON && cap == null && blindKnown(rec, now) && !hurry ? 1 : 0, hurry })
    if (!plan) {
      P.noPlan = bedsLayout.why
      if (takeoffWin) { if (ctl.trace) ctl.trace.ev('bedFail', { why: 'взлёт: плана нет', no: bedsLayout.why }); break }
      tries++
      await lookAtSafe(bot, parts.headC)
      await sleep(120)
      continue
    }
    const g = await bedsGo(session, ctl, plan, brave, parts)
    if (!g.ok) { tries++; P.lastWhy = g.why; failed.set(plan.key, gameClock.now() + 1500); continue }
    ctl.holdStation = true
    let b
    try { b = await bedsBuild(session, ctl, stats, plan) } finally { ctl.holdStation = false }
    if (!b.ok) { tries++; P.fails++; P.lastWhy = b.why; failed.set(plan.key, gameClock.now() + 4000); if (ctl.trace) ctl.trace.ev('bedFail', { why: b.why, takeoff: takeoffWin || undefined }); continue }
    // Неуязвимость дракона после прошлого взрыва — 10 тиков.
    while (!ctl.aborted && gameClock.now() < (stats.lastBoom || 0) + BED_GAP_MS) await sleep(20)
    const d2 = dragonOf(bot)
    if (!d2) break
    const ph2 = phaseOf(bot, d2)
    if (!SITTING.has(ph2) && !(ph2 === PHASE.TAKEOFF && takeoffWin)) {
      // Взлетел, пока строили (его огни кончились) — кровать лежит: щёлкнуть, если голова ещё рядом.
      const hp2 = headPoint(bot, d2, track, 0)
      if (!(ph2 === PHASE.TAKEOFF && hp2.distanceTo(plan.centre) < 5)) break
    }
    if (bot.health < 8) { P.why = 'мало хп перед щелчком'; break }
    const pp = bot.entity.position
    if (Math.hypot(pp.x - plan.feet.x, pp.z - plan.feet.z) > 0.55 || Math.abs(pp.y - plan.y) > 0.3) { tries++; P.lastWhy = 'сдвинуло с места'; continue }
    const hit = bedClickPoint(bot, plan)
    if (!hit) { tries++; P.fails++; P.lastWhy = 'кровать не видно'; if (ctl.trace) ctl.trace.ev('bedFail', { why: 'не видно' }); continue }
    const why = takeoffWin || ph2 === PHASE.TAKEOFF ? 'взлёт' : SITTING.has(ph2) ? 'сидит' : PHASE_RU[ph2]
    const boom = await bedsBoom(session, ctl, stats, plan, hit, why)
    if (!boom.ok) { tries++; P.fails++; P.lastWhy = boom.why; continue }
    P.beds.push(boom.dmg)
    // Взлетел от неё, а C двойной станции лежит и видна — через 10 тиков в неё.
    if (boom.took) await tryC(session, ctl, stats, track, P)
    // Огонь под ногами после взрыва — шаг назад.
    const fire = bot.blockAt(bot.entity.position.floored())
    if (fire && /fire/.test(fire.name)) await stepTo(bot, ctl, bot.entity.position.offset(-plan.D.x * 1.2, 0, -plan.D.z * 1.2), { ms: 700, stopAt: 0.3 })
  }
  const dd = dragonOf(bot)
  P.hp1 = dd ? Math.round(hpOf(bot, dd) ?? 0) : 0
  P.secs = Math.round((gameClock.now() - key) / 100) / 10
}

// ------------------------------------------------------------ станция кроватей
//
// «Один цикл» спидраннеров по-нашему (2026-09-26). Сидящий дракон — в
// (0.5, P, 0.5), где P — верх столба фонтана (DragonLandingPhase: цель —
// низ-центр высоты MOTION_BLOCKING_NO_LEAVES над EndPodiumFeature.getLocation;
// садится, подлетев ближе блока — в прогонах y 64.9–65.8 при P = 65). Голова —
// на 6.5 вперёд, низ её коробки на y − 1 (EnderDragon.aiStep, getHeadYOffset
// −1 сидя). Высматривая (DragonSittingScanningPhase), он поворачивается к
// игроку в 20 блоках (и ±10 по высоте), пока угол больше 10°, — значит, где
// стоим, туда и ляжет голова; а на посадку заходит от узла кольца 40 напротив
// игрока (DragonLandingApproachPhase: findClosestNode(−p̂·40, 105, …)) — узлы
// стоят через 45°, и со станцией на оси ±x/±z он прилетает ровно по оси.
//
//   ось от центра:   (0.5) ··· H F W1 W2 B        n = 7 8 9 10 11
//
// H — изголовье кровати под головой, на высоте P−2 (кровать не должна попасть
// в коробку головы: EnderDragon.checkWalls ломает всё не из #dragon_immune, и
// в прогонах голова сидит на y 63.9–64.8 — кровать на 63..63.56 ниже; центр
// взрыва (P−1.5) до низа головы 0.4–1.3 блока — ~55–65 урона при 70·(i²+i)/2+1).
// F — изножье на опоре (столбик до P−3), W1, W2 — стенки в два блока от земли,
// F/W1/W2 по три в ширину. B — где стоим, на земле, в четырёх блоках от
// изголовья. Зачем стенки:
//   · облако сидячего огня встаёт в 2.5 блока за головой вдоль её взгляда
//     (DragonSittingFlamingPhase: центр head + 2.5·dir, высота — верх первого
//     непустого блока под головой в этом столбце) — n = 9, это W1, и облако
//     ложится на верх стенки, на P−1 и выше, а мы стоим ниже (облако высотой
//     0.5 задевает только тех, чья коробка его пересекает);
//   · взрыв кровати бьёт лучами к точкам нашей коробки (ServerExplosion.
//     getSeenPercent) — все они режут стенки ниже их верха: урон ~1.
// Когда жать: садится (LANDING) — урон не идёт в счётчик 50 (EnderDragon.hurt
// копит sittingDamageReceived только сидя), жмём, когда голова в ~2 блоках от
// изголовья; сидит — жмём сразу (больше 50 — взлёт); взлетает (TAKEOFF) —
// снова вне счётчика: новая кровать, пока голова не ушла.
const AXES = [{ x: 1, z: 0 }, { x: -1, z: 0 }, { x: 0, z: 1 }, { x: 0, z: -1 }]
const ST_N = { H: 7, F: 8, W1: 9, W2: 10, B: 11 }

function stationCell (a, n, l) {
  const px = -a.z; const pz = a.x
  return { x: Math.floor(CENTER.x + a.x * n + px * l), z: Math.floor(CENTER.z + a.z * n + pz * l) }
}
// Высота верха земли в колонке (ноги стоящего), около nearY.
function groundAt (bot, x, z, nearY) {
  return standY(bot, x + 0.5, z + 0.5, nearY, 3, 5)
}

// План станции по оси a: что поставить, где стоять, куда класть кровать.
function stationPlan (bot, a) {
  const podium = surfaceY(bot, CENTER.x, CENTER.z)
  if (!podium) return { ok: false, why: 'верх фонтана не виден' }
  // Кровать — на P−3, не P−2: садясь, дракон проходит ниже конечной высоты,
  // и шея задевала кровать на P−2 (checkWalls снёс её без взрыва — сцена
  // station9, bedLost). Урон с P−3 — 50–57 (центр взрыва на 1.3–2.3 ниже
  // низа головы), а сидя больше 50 за раз всё равно не взять: взлёт.
  const yb = podium.y - 3
  const cell = (n, l = 0) => stationCell(a, n, l)
  const B = cell(ST_N.B)
  const g = groundAt(bot, B.x, B.z, yb - 2)
  if (g == null) return { ok: false, why: 'под местом стоянки нет земли' }
  if (yb - g < 1 || yb - g > 3) return { ok: false, why: `земля у станции на ${g}, кровать на ${yb}` }
  const place = []
  const bad = []
  const want = (x, y, z) => {
    const b = bot.blockAt(new Vec3(x, y, z))
    if (!b) { bad.push('не прогружено'); return }
    if (isSolid(b)) return
    if (/portal|gateway/.test(b.name)) { bad.push(b.name); return }
    place.push(new Vec3(x, y, z))
  }
  const air = (x, y, z, bedOk = false) => {
    const b = bot.blockAt(new Vec3(x, y, z))
    if (!b) { bad.push('не прогружено'); return false }
    if (bedOk && /_bed$/.test(b.name)) return true
    return !isSolid(b) && !/portal|gateway|lava/.test(b.name)
  }
  // Что ставить — поменьше (e2e5: 128 блоков кончились — мост ~40, два столба
  // у клеток ~50, станции по 18): стенка W1 в три ширины (столбец облака огня
  // гуляет на блок вбок с углом дракона), W2 и опора F — только посередине,
  // пол — только под ними и под B.
  const rows = [[ST_N.F, [0]], [ST_N.W1, [-1, 0, 1]], [ST_N.W2, [0]], [ST_N.B, [0]]]
  for (const [n, ls] of rows) {
    for (const l of ls) {
      const c = cell(n, l)
      if (voidBelow(bot, c.x + 0.5, g, c.z + 0.5, 6)) { bad.push(`пустота под ${c.x},${c.z}`); continue }
      want(c.x, g - 1, c.z)
    }
  }
  // Стенки W1 (три) и W2 (середина) — два блока от земли; F — опора до yb−1.
  for (const [n, ls] of rows.slice(0, 3)) {
    for (const l of ls) {
      const c = cell(n, l)
      const top = n === ST_N.F ? yb - 1 : g + 1
      for (let y = g; y <= top; y++) want(c.x, y, c.z)
    }
  }
  const H = cell(ST_N.H); const F = cell(ST_N.F)
  if (!air(B.x, g, B.z) || !air(B.x, g + 1, B.z)) bad.push('на месте стоянки блок')
  if (!air(H.x, yb, H.z, true)) bad.push('в клетке изголовья блок')
  if (!air(F.x, yb, F.z, true)) bad.push('в клетке изножья блок')
  if (bad.length) return { ok: false, why: bad[0] }
  return {
    ok: true,
    key: `${a.x},${a.z}`,
    a,
    yb,
    g,
    podium: podium.y,
    B: new Vec3(B.x + 0.5, g, B.z + 0.5),
    H: new Vec3(H.x, yb, H.z),
    F: new Vec3(F.x, yb, F.z),
    support: new Vec3(F.x, yb - 1, F.z),
    blast: new Vec3(H.x + 0.5, yb + 0.5, H.z + 0.5),
    place
  }
}

// Какую ось взять: меньше ставить, ближе идти, место стоянки не в облаке.
function chooseStation (bot, fails = new Map()) {
  const me = bot.entity.position
  const clouds = cloudsOf(bot)
  let best = null
  const why = {}
  for (const a of AXES) {
    const st = stationPlan(bot, a)
    if (!st.ok) { why[`${a.x},${a.z}`] = st.why; continue }
    if (inClouds(clouds, st.B, 1.5)) { why[st.key] = 'облако'; continue }
    const cost = st.place.length * 0.6 + st.B.distanceTo(me) * 0.3 + (fails.get(st.key) || 0) * 12
    if (!best || cost < best.cost) best = { ...st, cost }
  }
  if (!best) chooseStation.why = why
  return best
}

function bedHere (bot, st) {
  const f = bot.blockAt(st.F); const h = bot.blockAt(st.H)
  return !!(f && /_bed$/.test(f.name) && h && /_bed$/.test(h.name))
}

// Голова (низ-центр её коробки — точка, от которой взрыв меряет расстояние,
// ServerExplosion.hurtEntities → entity.distanceToSqr) через lead тиков.
function headPoint (bot, d, track, lead = 0) {
  const parts = partsOf(bot, d, track)
  const v = SITTING.has(phaseOf(bot, d)) ? { x: 0, y: 0, z: 0 } : track.vel()
  return new Vec3(parts.headC.x + v.x * lead, parts.head.min.y + v.y * lead, parts.headC.z + v.z * lead)
}
// Урон взрыва кровати по голове на расстоянии dist (мощность 5, радиус 10).
function bedDamage (dist, seen = 1) {
  const i = Math.max(0, 1 - dist / 10) * seen
  return Math.round((i * i + i) / 2 * 70 + 1)
}
// Видимость дракона из центра взрыва (Paper: getSeenPercent по всей коробке 16×8×16):
// доля лучей до точек коробки без блоков на пути — 5×3×5 точек. Свои блоки у кровати
// (опора, заслон) между ней и драконом режут урон втрое (oc3-23: A 13.4 при ожидании 46).
const SEEN_DX = [-7, -3.5, 0, 3.5, 7]; const SEEN_DY = [0.5, 4, 7.5]
function dragonSeen (vbot, centre, pos) {
  let open = 0; let all = 0
  for (const dx of SEEN_DX) {
    for (const dy of SEEN_DY) {
      for (const dz of SEEN_DX) {
        all++
        const p = new Vec3(pos.x + dx, pos.y + dy, pos.z + dz)
        const dv = p.minus(centre); const len = dv.norm()
        if (len < 0.1) { open++; continue }
        if (!pick.blockOnRay(vbot, centre, dv.scaled(1 / len), len)) open++
      }
    }
  }
  return open / all
}

// Блок у кровати ставить — только крадучись. build.placeBlockAt берёт опорой
// любую твёрдую соседнюю грань, и опорой становилась сама кровать (изножье
// соседствует со стенкой): клик по кровати без приседа — это «лечь», а в Энде
// — взрыв (ServerPlayerGameMode.useItemOn: блок не «используется», только
// если игрок крадётся и в руке предмет — isSecondaryUseActive). Прогоны
// e2e12/e2e13: «bad_respawn_point» посреди bed:place — смерть с 14–16 хп.
// Блок у кровати — никогда не прислонять к самой кровати: клик по ней, если
// сервер не увидел приседа, — «лечь», а в Энде взрыв у нас (b4-22, 30.09, 349.8 с:
// «beds:wall» — своя кровать, смерть с 20 хп). Только к твёрдым не-кроватям,
// грань видна из глаз (pick.faceAim), крадучись.
async function placeNoBed (bot, pos, { timeoutMs = 1200 } = {}) {
  const at = bot.blockAt(pos)
  if (!at) return { ok: false, reason: 'не прогружено' }
  if (isSolid(at)) return { ok: true, already: at.name }
  if (build.occupiedByEntity(bot, pos)) return { ok: false, reason: `в клетке стоит ${build.occupiedByEntity(bot, pos)}` }
  const filler = fillerItem(bot) || (build.pickFiller(bot, { steady: true }) || {}).name
  const stack = bot.inventory.items().find(i => i.name === filler) || bot.inventory.items().find(i => FILLER_RE.test(i.name))
  if (!stack) return { ok: false, reason: 'нечем строить' }
  const was = bot.getControlState('sneak')
  bot.setControlState('sneak', true)
  try {
    await bot.equip(stack, 'hand')
    await new Promise(resolve => bot.once('physicsTick', resolve))
    for (const face of [new Vec3(0, 1, 0), new Vec3(1, 0, 0), new Vec3(-1, 0, 0), new Vec3(0, 0, 1), new Vec3(0, 0, -1), new Vec3(0, -1, 0)]) {
      const ref = bot.blockAt(pos.minus(face))
      if (!ref || !isSolid(ref) || /_bed$|portal|gateway/.test(ref.name)) continue
      const aim = pick.faceAim(bot, ref.position, face)
      if (!aim) continue
      try {
        await bot.lookAt(aim, true)
        await build.withTimeout(bot.placeBlock(ref, face), timeoutMs)
      } catch (e) { dbg('placeNoBed', e.message) }
      if (isSolid(bot.blockAt(pos))) return { ok: true }
    }
    return { ok: false, reason: 'не к чему прислонить (кроме кровати) или грань не видно' }
  } finally { if (!was) bot.setControlState('sneak', false) }
}
async function sneakPlace (bot, pos, opts) {
  const was = bot.getControlState('sneak')
  bot.setControlState('sneak', true)
  await new Promise(resolve => bot.once('physicsTick', resolve))
  try { return await build.placeBlockAt(bot, pos, { ...opts, item: fillerItem(bot) }) } finally { if (!was) bot.setControlState('sneak', false) }
}

// Чем строить: build.js берёт наполнитель сам (булыжник, земля…), но
// эндерняка в его списке нет — кончился булыжник, называем эндерняк явно.
function fillerItem (bot) {
  if (build.pickFiller(bot, { steady: true })) return undefined
  return findItem(bot, /^end_stone$/) ? 'end_stone' : undefined
}

// Блоки на исходе — наломать эндерняка вокруг себя киркой (0.75 с на блок
// железной: твёрдость 3). Набор кампании — ~64 булыжника, а мост с платформы
// берёт ~40, столб к клетке — 22 и 29 (e2e5: «нечем строить» к концу боя).
// Ломаем землю по кольцу у ног (ямы в блок — не опасны), подбираем.
async function mineEndStone (session, ctl, want, stats) {
  const bot = session.bot
  const pick = findItem(bot, /_pickaxe$/)
  if (!pick) return 0
  const t0 = gameClock.now()
  const have0 = countOf(bot, FILLER_RE)
  const was = ctl.doing
  doing(ctl, 'mine-endstone')
  // Сел или садится — бросить: высматривая, он через 100 тиков таранит того, кто
  // дальше 20 блоков (c2-4, 30.09, 63.8–70.2 с: копал в 27 блоках, таран, два удара).
  const perched = () => { const dd = dragonOf(bot); if (!dd) return false; const p = phaseOf(bot, dd); return SITTING.has(p) || p === PHASE.LANDING }
  // Только с земли острова: на обелиске (обсидиан) кольцо пусто, а «новое место в
  // 3–5 блоках» — край верхушки (c3-19, 30.09, 188–200 с: копал на обелиске в
  // 18 блоках над землёй, облако, отброс с края, смерть).
  {
    const sup = supportCell(bot)
    const ub = sup && bot.blockAt(sup)
    if (!ub || ub.name !== 'end_stone') { doing(ctl, was); if (ctl.trace) ctl.trace.ev('mined', { got: 0, secs: 0, have: countOf(bot, FILLER_RE), why: ub ? ub.name : 'нет опоры' }); return 0 }
  }
  try {
    for (let round = 0; round < 8 && !ctl.aborted && !perched() && countOf(bot, FILLER_RE) < want && gameClock.now() - t0 < 60000; round++) {
      const me = bot.entity.position
      const fy = Math.floor(me.y + 0.01) - 1
      const ring = []
      for (const [dx, dz] of [[1, 0], [-1, 0], [0, 1], [0, -1], [1, 1], [1, -1], [-1, 1], [-1, -1]]) {
        const p = new Vec3(Math.floor(me.x) + dx, fy, Math.floor(me.z) + dz)
        const b = bot.blockAt(p)
        if (!b || b.name !== 'end_stone') continue
        if (Math.hypot(p.x + 0.5 - CENTER.x, p.z + 0.5 - CENTER.z) < 6) continue
        if (voidBelow(bot, p.x + 0.5, fy, p.z + 0.5, 4)) continue
        ring.push(b)
      }
      for (const b of ring) {
        if (ctl.aborted || countOf(bot, FILLER_RE) >= want || perched()) break
        const bad = hazardNow(bot)
        if (bad) { await evade(bot, ctl, stats, bad); break }
        // Бьёт эндермен — отбиться, а не копать дальше (d5-26, 30.09, 227–233 с:
        // семь ударов эндермена за 6 с, пока тело ломало эндерняк, смерть).
        const pest = hunters(bot, 4)[0]
        if (pest) { await fightEnderman(session, ctl, stats, pest, null); break }
        try {
          await bot.equip(pick, 'hand')
          await build.withTimeout(bot.dig(b, true), 3000)
        } catch (e) { dbg('mine', e.message) }
      }
      await sleep(700)
      if (countOf(bot, FILLER_RE) >= want) break
      // Дальше — на новое место в 3–4 блоках, на ровную землю.
      const spot = pickSpot(bot, bot.entity.position, { rMin: 3, rMax: 5, step: 1, edge: 3, avoid: f => nearPillar(bot, f, 2) || Math.hypot(f.x - CENTER.x, f.z - CENTER.z) < 7 })
      if (!spot) break
      await walkTo(session, ctl, spot.feet, { range: 0.6, timeoutMs: 8000 })
    }
  } finally { doing(ctl, was) }
  const got = countOf(bot, FILLER_RE) - have0
  stats.mined = (stats.mined || 0) + Math.max(0, got)
  if (ctl.trace) ctl.trace.ev('mined', { got, secs: Math.round((gameClock.now() - t0) / 1000), have: countOf(bot, FILLER_RE) })
  return got
}

async function stationBuild (session, ctl, st, stats) {
  const bot = session.bot
  let placed = 0; let failed = 0
  // Блоков нет — сразу сказать: без этого круг боя крутил станцию вхолостую
  // (e2e5: 76 тысяч «нечем строить» за пять минут, дракон жив).
  // Последние 4 блока — не на станцию: они для уходов от облака «на блок».
  if (countOf(bot, FILLER_RE) <= 4) return { placed, failed, noBlocks: true }
  for (const p of st.place) {
    if (ctl.aborted) break
    const b = bot.blockAt(p)
    if (b && isSolid(b)) continue
    const r = await sneakPlace(bot, p, { timeoutMs: 1500 })
    if (r.ok) placed++
    else { failed++; dbg('station place', p.toString(), r.reason); if (/нечем строить/.test(r.reason || '')) return { placed, failed, noBlocks: true } }
    if (hazardNow(bot)) break
  }
  stats.stationBlocks = (stats.stationBlocks || 0) + placed
  return { placed, failed }
}

async function stationPlaceBed (bot, st) {
  const bed = findItem(bot, /_bed$/)
  if (!bed) return { ok: false, why: 'кроватей нет' }
  const ref = bot.blockAt(st.support)
  if (!ref || !isSolid(ref)) return { ok: false, why: 'опоры изножья нет' }
  try {
    await bot.equip(bed, 'hand')
    // Смотреть вдоль оси к изголовью: оно ляжет туда, куда смотрим
    // (BedBlock.getStateForPlacement: FACING = горизонталь взгляда), а взгляд
    // сервер берёт из последнего пакета движения — пакет установки поворота
    // не несёт. Поэтому: взгляд, тик физики (пакет ушёл), потом установка.
    // Без тика кровать ложилась по старому взгляду — изголовьем от головы
    // (сцена station: «не встала (air/red_bed)» пятнадцать раз подряд).
    await bot.lookAt(st.support.offset(0.5, 1, 0.5), true)
    await new Promise(resolve => bot.once('physicsTick', resolve))
    await build.withTimeout(bot.placeBlock(ref, new Vec3(0, 1, 0)), 2000)
  } catch (e) { dbg('station bed', e.message) }
  await sleep(50)
  return bedHere(bot, st) ? { ok: true } : { ok: false, why: `кровать не встала (${(bot.blockAt(st.H) || {}).name}/${(bot.blockAt(st.F) || {}).name})` }
}

async function stationBlow (session, ctl, st, stats, d, track, why) {
  const bot = session.bot
  const f = bot.blockAt(st.F)
  if (!f || !/_bed$/.test(f.name)) return false
  const w = items.bestWeapon(bot)
  if (w && (!bot.heldItem || /_bed$/.test(bot.heldItem.name))) await bot.equip(w, 'hand').catch(() => {})
  const ph = phaseOf(bot, d)
  const head = headPoint(bot, d, track, 0)
  const dist = head.distanceTo(st.blast)
  const before = hpOf(bot, d)
  const me0 = bot.health
  doing(ctl, `bed:${why}`)
  if (ctl.trace) ctl.trace.ev('bed', { ph, why, dist: r1(dist), expect: bedDamage(dist), dragonHp: before, me: me0 })
  // Свидетель взрыва — урон по дракону с причиной «кровать» (damage_event,
  // bad_respawn_point), а не пропажа кровати: её сносит и сам дракон.
  let boom = false
  const onDmg = pk => { if (pk && (pk.entityId === d.id || pk.entityId === bot.entity.id) && DAMAGE_TYPES[pk.sourceTypeId] === 'bad_respawn_point') boom = true }
  bot._client.on('damage_event', onDmg)
  try { await bot.activateBlock(f, new Vec3(0, 1, 0), new Vec3(0.5, 0.56, 0.5)) } catch (e) { dbg('bed use', e.message) }
  const tb = gameClock.now()
  while (!boom && gameClock.now() - tb < 600) await sleep(50)
  bot._client.removeListener('damage_event', onDmg)
  await sleep(100)
  const gone = !bot.blockAt(st.F) || !/_bed$/.test(bot.blockAt(st.F).name)
  if (!gone) return false
  const dd = dragonOf(bot)
  const after = dd ? hpOf(bot, dd) : 0
  const dmg = before != null && after != null ? Math.max(0, before - after) : null
  if (!boom && !(dmg > 0)) {
    stats.bedsLost = (stats.bedsLost || 0) + 1
    if (ctl.trace) ctl.trace.ev('bedLost', { ph, dist: r1(dist) })
    return false
  }
  stats.bedsUsed = (stats.bedsUsed || 0) + 1
  if (dmg) stats.dmg += dmg
  const rec = { ph: PHASE_RU[ph] ?? ph, why, dist: r1(dist), dmg: dmg != null ? Math.round(dmg) : null, self: r1(Math.max(0, me0 - bot.health)) }
  stats.beds.push(rec)
  if (ctl.trace) ctl.trace.ev('bedDone', rec)
  dbg('station bed', JSON.stringify(rec))
  return true
}

// Станция там, где голова уже сидит (2026-09-26). Сцена station: садясь,
// дракон крутится по инерции — поворот посадки (yRotA до сотен градусов)
// сидя прибавляется к углу целиком каждый тик (DragonSittingScanningPhase:
// setYRot(yRot + yRotA)), а к игроку он доворачивает только первые 25 тиков
// и тем слабее, чем дальше мы от головы (0.7/(d+1)² на градус). Голова
// ложится куда придётся — заранее построенная станция ловила её не всегда.
// Поэтому второй способ: дождаться, пока голова встанет (рёв и огонь её не
// поворачивают), и собрать ту же раскладку H F W B по оси, лучшей из четырёх,
// прямо под ней: опора изножья, стенка в два блока, кровать, щелчок.
function headPlan (bot, d, track, { breathSafe = true } = {}) {
  const parts = partsOf(bot, d, track)
  const hp = new Vec3(parts.headC.x, parts.head.min.y, parts.headC.z)
  // Верх кровати (yb + 0.5625) — на 0.3+ ниже низа головы и шеи: иначе их
  // коробки задевают кровать и EnderDragon.checkWalls сносит её каждый тик
  // (сцена station: восемь кроватей «взорваны» — исчезли без урона, запас
  // был 0.04 блока).
  const yb = Math.floor(hp.y - 0.87)
  const breath = breathOf(bot, d, parts)
  const clouds = cloudsOf(bot)
  const me = bot.entity.position
  const zones = { clouds, fireballs: [], parts, sweep: { pos: d.position, dir: parts.dir } }
  let best = null
  const why = {}
  const no = k => { why[k] = (why[k] || 0) + 1 }
  const cells = [[0, 0], [1, 0], [-1, 0], [0, 1], [0, -1]]
  for (const [ox, oz] of cells) {
    const hx = Math.floor(hp.x) + ox; const hz = Math.floor(hp.z) + oz
    const blast = new Vec3(hx + 0.5, yb + 0.5, hz + 0.5)
    const dist = blast.distanceTo(hp)
    if (dist > 2.2) continue
    for (const D of AXES) {
      // Стоять — перед мордой, по её взгляду: сбоку дракон доворачивает к нам
      // голову, и она уходит от кровати (сцена station7: план сбоку — четыре
      // пересчёта за посадку, одна кровать на третьем огне).
      if (D.x * parts.dir.x + D.z * parts.dir.z < 0.5) continue
      const at = k => ({ x: hx + D.x * k, z: hz + D.z * k })
      // Как у готовой станции: F, две стенки (H+2, H+3), стоим на H+4. Облако
      // огня встаёт в 2.5 блока за головой — на H+2 или H+3, то есть на верх
      // стенки, выше нас (e2e6: со стенкой в одну клетку и стоянкой на H+3
      // облако ложилось на землю у нас — уход, возврат, снова уход, кровати ни
      // одной за посадку).
      const F = at(1); const W = at(2); const W2 = at(3); const B = at(4)
      const g = groundAt(bot, B.x, B.z, yb - 2)
      if (g == null) { no('земля'); continue }
      if (yb - g < 1 || yb - g > 3) { no('высота'); continue }
      const feet = new Vec3(B.x + 0.5, g, B.z + 0.5)
      if (nearPortal(feet)) { no('портал'); continue }
      if (voidBelow(bot, feet.x, g, feet.z, 6) || nearEdge(bot, feet, 2)) { no('край'); continue }
      const air = (x, y, z, bedOk) => { const b = bot.blockAt(new Vec3(x, y, z)); return !!b && ((bedOk && /_bed$/.test(b.name)) || (!isSolid(b) && !/portal|gateway|lava/.test(b.name))) }
      if (!air(hx, yb, hz, true) || !air(F.x, yb, F.z, true)) { no('клетки кровати'); continue }
      if (!air(B.x, g, B.z) || !air(B.x, g + 1, B.z)) { no('место стоянки'); continue }
      // Кровать не должна войти в коробки головы, шеи и тела (checkWalls ломает).
      const bedBox = { min: new Vec3(Math.min(hx, F.x), yb, Math.min(hz, F.z)), max: new Vec3(Math.max(hx, F.x) + 1, yb + 0.5625, Math.max(hz, F.z) + 1) }
      if (overlap(bedBox, parts.head) || overlap(bedBox, parts.neck) || overlap(bedBox, parts.body)) { no('в драконе'); continue }
      // Место стоянки: не у головы и шеи, не под крылом (толкает), не в облаке.
      const bad = dangerAt(bot, feet, { ...zones, breath: null })
      if (bad && !/дуга/.test(bad.kind)) { no(bad.kind); continue }
      if (Math.hypot(feet.x - d.position.x, feet.z - d.position.z) < 6) { no('у тела'); continue }
      if (inClouds(clouds, feet, 1.2)) { no('облако'); continue }
      // Облако огня: ляжет на верх первого непустого под головой в своём
      // столбце — если это наша стенка/опора (станем их строить), оно выше нас.
      const bc = breath.column
      const raised = [W, W2, F].some(c => bc.x === c.x && bc.z === c.z)
      if (breathSafe && !raised && Math.hypot(feet.x - breath.pos.x, feet.z - breath.pos.z) < BREATH_R + 0.8 && feet.y < breath.pos.y + CLOUD_SLAB + 0.1) { no('будет облако огня'); continue }
      // Что поставить: пол под B, F и W; опора F до yb−1; стенка W в два блока.
      const place = []
      const want = (x, y, z) => { const b = bot.blockAt(new Vec3(x, y, z)); if (b && !isSolid(b)) place.push(new Vec3(x, y, z)) }
      for (const c of [B, W, W2, F]) if (!voidBelow(bot, c.x + 0.5, g, c.z + 0.5, 6)) want(c.x, g - 1, c.z)
      for (let y = g; y <= yb - 1; y++) want(F.x, y, F.z)
      for (const c of [W, W2]) for (let y = g; y <= g + 1; y++) want(c.x, y, c.z)
      // Изножье — в досягаемости руки от глаз на B (4.5, с запасом 4.3).
      if (feet.offset(0, EYE, 0).distanceTo(new Vec3(F.x + 0.5, yb + 0.5, F.z + 0.5)) > 4.3) { no('не дотянуться'); continue }
      const walk = feet.distanceTo(me)
      const cost = dist * 3 + place.length * 0.6 + walk * 0.4
      if (!best || cost < best.cost) {
        best = {
          ok: true, key: `голова ${hx},${hz} ${D.x},${D.z}`, a: D, yb, g, dynamic: true,
          B: feet, H: new Vec3(hx, yb, hz), F: new Vec3(F.x, yb, F.z), support: new Vec3(F.x, yb - 1, F.z),
          blast, place, dist, cost, expect: bedDamage(dist)
        }
      }
    }
  }
  if (!best) headPlan.why = why
  return best
}

// Что достроить у станции «под головой»: пол под B, W, F; опора F до yb−1;
// стенка W в два блока от земли.
function dynamicPlace (bot, st) {
  const D = st.a
  const B = { x: Math.floor(st.B.x), z: Math.floor(st.B.z) }
  const W = { x: st.H.x + 2 * D.x, z: st.H.z + 2 * D.z }
  const W2 = { x: st.H.x + 3 * D.x, z: st.H.z + 3 * D.z }
  const F = { x: st.F.x, z: st.F.z }
  const g = st.g
  const place = []
  const want = (x, y, z) => { const b = bot.blockAt(new Vec3(x, y, z)); if (b && !isSolid(b)) place.push(new Vec3(x, y, z)) }
  for (const c of [B, W, W2, F]) if (!voidBelow(bot, c.x + 0.5, g, c.z + 0.5, 6)) want(c.x, g - 1, c.z)
  for (let y = g; y <= st.yb - 1; y++) want(F.x, y, F.z)
  for (const c of [W, W2]) for (let y = g; y <= g + 1; y++) want(c.x, y, c.z)
  return place
}

// Один шаг станции (зовётся из круга боя): дойти до B, достроить, положить
// кровать, взорвать, когда голова рядом. Возвращает 'fail', если станция
// больше не годится (не дойти, не построить), иначе — что сделал.
async function stationStep (session, ctl, rep, stats, track, st, d, ph) {
  const bot = session.bot
  const me = bot.entity.position
  // Облако фаербола на станции (растёт 3 → 7 за 30 с) — не ходить туда, пока
  // лежит: e2e11, 476–489 с — облако в двух блоках от B, «к станции» четыре
  // раза подряд возвращало тело в него, смерть. Облако огня на верху стенки
  // (выше нас) — не помеха.
  const lidded = c => c.pos.y >= st.B.y + 1.8
  if (cloudsOf(bot).some(c => !lidded(c) && Math.hypot(st.B.x - c.pos.x, st.B.z - c.pos.z) < c.r + 1.2 && Math.abs(c.pos.y - st.B.y) < 2)) return 'облако'
  const atB = Math.hypot(me.x - st.B.x, me.z - st.B.z) < 0.6 && Math.abs(me.y - st.B.y) < 0.6
  if (!atB) {
    doing(ctl, 'station:walk')
    const near = Math.hypot(me.x - st.B.x, me.z - st.B.z) < 4 && Math.abs(me.y - st.B.y) < 1.2
    const r = near ? await stepTo(bot, ctl, st.B, { ms: 2000, sprint: false, stopAt: 0.2 }) : await walkTo(session, ctl, st.B, { range: 0.4, timeoutMs: 20000 })
    // Не дошёл — помеха (фаербол, облако, эндермен, путь); станция негодна,
    // только если не дойти трижды подряд (e2e6: каждый уход от фаербола
    // списывал станцию, к 266 с обе были «негодны» — ни одной кровати).
    if (!r.ok && Math.hypot(bot.entity.position.x - st.B.x, bot.entity.position.z - st.B.z) > 0.8) {
      st.walkFails = r.hazard || r.enderman ? (st.walkFails || 0) : (st.walkFails || 0) + 1
      return st.walkFails >= 3 ? 'fail' : 'помеха'
    }
    st.walkFails = 0
    await stepTo(bot, ctl, st.B, { ms: 700, sprint: false, stopAt: 0.12 })
    return 'дошёл'
  }
  // Блоки станции — взрыв кровати выбивает опору и верх стенок.
  const fresh = st.dynamic ? { ok: true, place: dynamicPlace(bot, st) } : stationPlan(bot, st.a)
  if (!fresh.ok) return 'fail'
  Object.assign(st, { place: fresh.place })
  const perch = ph === PHASE.LANDING || SITTING.has(ph) || ph === PHASE.TAKEOFF
  const hasBed = bedHere(bot, st)
  // Порядок: опора изножья (без неё кровать не положить) → кровать → стенки
  // и пол. В окне посадки стенки ждут: взрыв выбивает опору, и следующая
  // кровать (сидя, на взлёте) дороже целой стенки.
  const buildList = async (list, what) => {
    doing(ctl, `station:${what}`)
    st.place = [...list].sort((p, q) => p.y - q.y || p.distanceTo(st.B) - q.distanceTo(st.B))
    const b = await stationBuild(session, ctl, st, stats)
    if (b.noBlocks) { stats.stationNoBlocks = true; return 'fail' }
    if (!b.placed && b.failed) st.buildFails = (st.buildFails || 0) + 1
    else if (b.placed) st.buildFails = 0
    return (st.buildFails || 0) >= 3 ? 'fail' : 'строю'
  }
  const support = fresh.place.filter(p => p.x === st.F.x && p.z === st.F.z)
  // Кривая кровать (изголовьем не туда, или половина) в клетках станции —
  // убрать: на её место новую не поставить, а щёлкать её — взрыв у самих нас.
  if (!hasBed) {
    for (const p of [st.F, st.H]) {
      const b = bot.blockAt(p)
      if (b && /_bed$/.test(b.name)) {
        doing(ctl, 'station:clear')
        try { await build.withTimeout(bot.dig(b, true), 2000) } catch (e) { dbg('station clear', e.message) }
        st.cleared = (st.cleared || 0) + 1
        return 'убрал кровать'
      }
    }
  }
  if (!hasBed && support.length) return buildList(support, 'support')
  if (!hasBed) {
    if (!findItem(bot, /_bed$/)) return 'кроватей нет'
    doing(ctl, 'station:bed')
    const r = await stationPlaceBed(bot, st)
    if (!r.ok) { st.bedFails = (st.bedFails || 0) + 1; dbg('station', r.why); if (st.bedFails >= 4) return 'fail' } else st.bedFails = 0
    return 'кровать'
  }
  // Стенки — пока летает; сидя — только высматривая (до огня ≥ 3 с), и только
  // если кровать уже лежит: без стенки облако огня ляжет на землю у нас.
  // Жать — только за целыми стенками. Взрыв выбивает опору и верх стенок, и
  // три кровати подряд без стенок убили тело (e2e10, 583–585 с: 36, 13, и
  // третий взрыв — в открытую, два удара bad_respawn_point, смерть с 20 хп).
  // Поэтому достроить всегда, даже над садящимся и сидящим.
  if (fresh.place.length) return buildList(fresh.place, 'build')
  if (perch) {
    const head = headPoint(bot, d, track, 2)
    const dist = head.distanceTo(st.blast)
    const was = st.lastDist
    st.lastDist = dist
    if (ctl.trace && (!st.headLog || gameClock.now() - st.headLog > 250)) {
      st.headLog = gameClock.now()
      ctl.trace.ev('head', { ph, dist: r1(dist), head: [r1(head.x), r1(head.y), r1(head.z)], d: [r1(d.position.x), r1(d.position.y), r1(d.position.z)], yaw: +d.yaw.toFixed(2) })
    }
    let go = null
    if (ph === PHASE.LANDING) {
      if (dist <= 2.0 || (was != null && dist > was && was <= 3.2)) go = 'садится'
    } else if (SITTING.has(ph)) {
      if (!st.sitSince) st.sitSince = gameClock.now()
      if (dist <= 3.2) go = 'сидит'
      else if (gameClock.now() - st.sitSince > 2500 && dist <= 4.5) go = 'сидит'
      // Готовая станция: ждать на месте — высматривая, дракон сам повернёт
      // голову к нам (к B, а значит, к изголовью), не в этот огонь — так в
      // следующий. Уходить к «станции под головой» (headPlan) — только со
      // своей же такой станции, если голова ушла.
      else if (st.dynamic && gameClock.now() - st.sitSince > 700 && dist > 4.5) { st.lastDist = null; st.sitSince = null; return 'далеко' }
      // Голова не идёт к станции: дракон не видит нас (его Sensing у дракона
      // не чистится — EnderDragon.aiStep не зовёт serverAiStep, и первое «не
      // видно» остаётся навсегда: не повернётся, не дохнёт, не протаранит) или
      // сел не туда. Тогда — кровать у самой головы, как раньше (perchAttack).
      else if (gameClock.now() - st.sitSince > 1500) { st.lastDist = null; return 'далеко' }
    } else if (ph === PHASE.TAKEOFF) {
      if (dist <= 3.6) go = 'взлетает'
    }
    if (!SITTING.has(ph)) st.sitSince = null
    // Мало хп — не жать: за стенками взрыв снимает 0–0.4 (замер), но стенка
    // могла треснуть от прошлого взрыва так, что план этого не видит.
    if (go && bot.health >= 8) {
      await stationBlow(session, ctl, st, stats, d, track, go)
      st.lastDist = null
      return 'взрыв'
    }
    doing(ctl, 'station:wait')
    await lookAtSafe(bot, head)
    return 'жду голову'
  }
  st.lastDist = null
  return 'готово'
}
async function fightDragon (session, ctl, rep, stats, { deadline, perches = 0 }) {
  const bot = session.bot
  const track = makeTrack(bot)
  const feed = ctl.feed || (ctl.feed = makeDragonFeed(bot))
  feed.onSit = o => { if (ctl.trace) ctl.trace.ev('ocSit', o) }
  let ocLandKey = null
  let ocLandStart = 0
  let ocPrevPh = null
  // «Не видно» — ещё не «убит»: убит, только если выходной портал горит. Иначе
  // искать у центра до минуты (прогоны 4b-2, 6a-4: бой кончался на 15–29 с
  // словами «дракона не видно — убит?», а он был жив; в основном мире это
  // значило бы уйти из Энда с живым драконом).
  const lookFor = async (ms) => {
    const t0 = gameClock.now()
    let dd = track.tick()
    while (!dd && !ctl.aborted && gameClock.now() - t0 < ms && gameClock.now() < deadline) {
      if (portalBlocks(bot).length) return null
      doing(ctl, 'fight:search')
      const m = bot.entity.position
      if (Math.hypot(m.x - CENTER.x, m.z - CENTER.z) > 18) {
        const spot = pickSpot(bot, CENTER, { rMin: 8, rMax: 16 })
        if (spot) await walkTo(session, ctl, spot.feet, { range: 1.5, timeoutMs: 20000 })
      } else await sleep(500)
      dd = track.tick()
    }
    return dd
  }
  let d = track.tick() || await lookFor(60000)
  if (!d) {
    rep.dragon.seen = false
    if (portalBlocks(bot).length) { rep.dragon.won = true; rep.dragon.lost = 'дракона нет, выходной портал горит — убит' } else rep.dragon.lost = 'дракона не видно минуту, выходной портал не горит — жив, но не найден'
    return
  }
  rep.dragon.seen = true
  rep.dragon.hpStart = Math.round(hpOf(bot, d) ?? 0)
  const hpLog = []
  let lastPhase = null
  let lastShot = 0
  let won = false
  // Станция кроватей: ось, число неудач по осям, когда пробовать снова.
  let st = null
  let dyn = null
  const stFails = new Map()
  let stationRetry = 0
  // Когда дракон последний раз поворачивался (голова «встала» — можно
  // собирать станцию под ней).
  let yawWas = null
  let yawSince = gameClock.now()
  let sitStart = 0
  let mineRetry = 0
  let refillAt = 0
  let crystalRetry = gameClock.now() + 20000
  stats.perchCount = stats.perchCount || 0
  while (!ctl.aborted && gameClock.now() < deadline) {
    await yieldTick()
    doing(ctl, 'fight')
    d = track.tick()
    if (!d) {
      // Исчез после «умирает» — победа. Иначе улетел из прорисовки.
      if (lastPhase === PHASE.DYING) { won = true; break }
      await sleep(250)
      if (!dragonOf(bot) && lastPhase === PHASE.DYING) { won = true; break }
      if (!dragonOf(bot) && !(await lookFor(30000))) {
        if (portalBlocks(bot).length) { won = true; break }
        rep.dragon.lost = 'дракона не видно 30 с, выходной портал не горит'
        break
      }
      continue
    }
    const ph = phaseOf(bot, d)
    const hp = hpOf(bot, d)
    if (yawWas == null || Math.abs(d.yaw - yawWas) > 0.01) { yawWas = d.yaw; yawSince = gameClock.now() }
    if (SITTING.has(ph) && !sitStart) sitStart = gameClock.now()
    if (!SITTING.has(ph)) sitStart = 0
    noteTakeoff(d, ph, gameClock.now())
    if (ph !== lastPhase) {
      stats.phases.push(`${PHASE_RU[ph] ?? ph}${hp != null ? ` (${Math.round(hp)})` : ''}`)
      dbg('phase', PHASE_RU[ph], 'hp', hp)
      if (ph === PHASE.SCANNING && lastPhase === PHASE.LANDING) stats.perchCount++
      lastPhase = ph
    }
    if (hp != null && (!hpLog.length || hpLog[hpLog.length - 1] !== Math.round(hp))) hpLog.push(Math.round(hp))
    // Убит. В полёте игра переводит его в фазу «умирает», а сидящий умирает
    // в той фазе, где сидел (EnderDragon.hurt: DYING только если !isSitting),
    // — поэтому свидетель победы — здоровье 0, а не фаза.
    if (hp != null && hp <= 0) { won = true; break }
    if (ph === PHASE.DYING) { lastPhase = PHASE.DYING; await sleep(200); continue }
    // Проверка приёма (сцена): столько посадок — и хватит (когда посадка кончилась).
    if (perches && stats.perchCount >= perches && !SITTING.has(ph) && ph !== PHASE.LANDING && ph !== PHASE.TAKEOFF) { rep.dragon.stoppedAfterPerches = perches; break }

    const parts = partsOf(bot, d, track)
    const z = dragonZones(bot)
    const ctx = { clouds: cloudsOf(bot), fireballs: fireballsOf(bot), parts: z.parts ? parts : null, breath: null, prefer: null, sweep: z.sweep, wings: z.wings, wingKind: z.wingKind, wingAway: z.wingAway, wingAxis: z.wingAxis, landing: z.landing }
    // Облако огня предсказывать только на рёве: высматривая, дракон ещё
    // поворачивается к нам (DragonSittingScanningPhase), и прогноз по
    // промежуточному углу гнал тело со станции, под которую голова и так
    // встанет (сцена station: пять уходов за посадку). От рёва до облака —
    // 40 + 10 тиков: уйти успеваем.
    if (ph === PHASE.ROARING) ctx.breath = breathOf(bot, d, parts)
    if (z.charge) ctx.charge = z.charge
    // Один цикл: снижается — кровать у места головы сидящего, щелчок в тик до посадки.
    // Начало снижения — по собственной прошлой фазе (lastPhase выше уже обновлён: ключ был
    // один на весь бой — L только в одной посадке, oc7/oc8).
    if (ph === PHASE.LANDING && ocPrevPh !== PHASE.LANDING) ocLandStart = gameClock.now()
    ocPrevPh = ph
    // Станция у столба (ctl.pillarMode): строится, пока дракон далеко; на каждом снижении — цепочка кроватей.
    if (ctl.bedsOnly && ctl.pillarMode) {
      // 02.10 (rs6-s3, смерть): эндермен бил 10 раз за 9 с, пока бот снова и снова входил в чашу (pillar:enter): вход
      // отказывал «эндермен бьёт», а ветка станции стоит раньше отбоя (п. 2 ниже) — до него цикл не доходил. Сперва отбиться.
      const pest = hunters(bot, 4).sort((a, b) => a.position.distanceTo(bot.entity.position) - b.position.distanceTo(bot.entity.position))[0]
      if (pest && ph !== PHASE.LANDING) {
        if (ctl.trace) ctl.trace.ev('pestFirst', { ph, hp: r1(bot.health), at: [r1(pest.position.x), r1(pest.position.y), r1(pest.position.z)] })
        await fightEnderman(session, ctl, stats, pest, () => { const p2 = phaseOf(bot, dragonOf(bot)); return p2 === PHASE.LANDING })
        await sleep(50)
        continue
      }
      if (await earlyCrystalStep(session, ctl, stats, d, ph)) continue
      // R: кровати кончились, дракон снижается или сидит — меч из чаши (runnerSword, ND_RUN_SWORD=1), раз на посадку
      if (RUN_SWORD() && ctl.pillar && ctl.pillar.built && ctl.pillar.plan && ctl.pillar.plan.runner && countOf(bot, /_bed$/) < 1 && !stationBedPlaced(bot, ctl) &&
          (ph === PHASE.LANDING || SITTING.has(ph)) && hp != null && hp > 0 && bot.health >= 10) {
        const key = d.id + ':' + ocLandStart
        if (ctl.swordKey !== key) { ctl.swordKey = key; ctl.swordN = 0 }
        // выход по опасности прогноза («R: голова/шея/крыло») — снова, когда пройдёт (до 6 входов на посадку)
        if (ctl.swordN < 6 && ctl.swordDone !== key) {
          ctl.swordN++
          doing(ctl, 'pillar:sword')
          const f = await runnerSword(session, ctl, stats, track, feed, ctl.pillar.plan)
          if (ctl.trace) ctl.trace.ev('runnerSword', f)
          ;(rep.dragon.sword || (rep.dragon.sword = [])).push({ hits: f.hits, by: f.by, hp0: f.hp0, hpMin: f.hpMin, why: f.why })
          if (!/^R: /.test(f.why || '')) ctl.swordDone = key
          else await sleep(150)
          continue
        }
      }
      const far = ph === PHASE.HOLDING || ph === PHASE.STRAFE || ph === PHASE.CHARGING || (ph === PHASE.APPROACH && approachFar(d))
      const nearC = Math.hypot(bot.entity.position.x - 0.5, bot.entity.position.z - 0.5) < 30
      // не чаще раза в 2.5 с (pil5-28: 6 попыток за 3 с у облака — и больше ни одной за бой)
      if ((!ctl.pillar || !ctl.pillar.built) && far && nearC && (ctl.pillarTries || 0) < pillarTriesMax() && gameClock.now() >= (ctl.pillarNext || 0) && (runnerOn() || countOf(bot, /^(obsidian|crying_obsidian)$/) >= 1) && !hunters(bot, 6).length && bot.health >= 12) {
        ctl.pillarTries = (ctl.pillarTries || 0) + 1
        ctl.pillarNext = gameClock.now() + 2500
        const P0 = podiumTop(bot)
        const tP = gameClock.now()
        // план — заново на каждую попытку (hb6: план «на весь бой» устаревал после частичной стройки и окопа —
        // «окоп: не встал над окопом» ×22, станций 18 из 26 против 13 из 14 в hb3)
        // R (02.10): плана R нет дважды (fr1 s13/s24: 10 пустых планов — бой без станции, кровати сидящему) — станция A
        let pp = null; let rNo = null
        // 03.10 (rs18-s8, ca1-s8: «мало обсидиана» до конца боя): план R недостроен (часть обсидиана уже стоит) — продолжать его же:
        // новый расчёт с этими блоками в мире выбирал другой план (seen 0.84 → 0.76), а на его клетки обсидиана в рюкзаке не хватало.
        const partial = ctl.partialPlan
        if (partial && P0 === partial.P0 && runnerOn()) {
          const okObs = (partial.pp.cells || []).filter(c => /obsidian/.test(c[3])).every(c => { const b = bot.blockAt(new Vec3(c[0], c[1], c[2])); return b && (/obsidian/.test(b.name) || isAirish(b)) })
          if (okObs) pp = partial.pp; else ctl.partialPlan = null
        }
        if (!pp && P0 != null && runnerOn() && (ctl.runnerNull || 0) < 2) { pp = runnerPlan(bot, P0); if (!pp) { ctl.runnerNull = (ctl.runnerNull || 0) + 1; rNo = runnerPlan.why } }
        if (P0 != null && !pp && (envv('ND_RUNNER') !== '1' || (ctl.runnerNull || 0) >= 2)) pp = await pillarPlanAutoAsync(bot, P0, PILLAR_BAD ? (ctl.pillarBad || (ctl.pillarBad = new Map())) : null)
        if (ctl.trace) ctl.trace.ev('pillarPlan', pp ? { ms: gameClock.now() - tP, R: !!pp.runner, try: ctl.pillarTries, H: [pp.H.x, pp.yb, pp.H.z], F: [pp.F.x, pp.F.z], B: [pp.B.x, pp.feet.y, pp.B.z], dig: pp.dig, nObs: pp.nObs, seen: pp.seen, n: (pillarPlan.all || []).length, ...(rNo ? { rNo } : {}) } : { ms: gameClock.now() - tP, no: rNo || pillarPlan.why, P: P0 })
        if (pp) {
          doing(ctl, 'pillar:build')
          const rb = await pillarBuild(session, ctl, stats, pp)
          if (pp.runner && rb && !rb.ok) {
            const placedObs = (pp.cells || []).filter(c => /obsidian/.test(c[3]) && /obsidian/.test((bot.blockAt(new Vec3(c[0], c[1], c[2])) || {}).name || '')).length
            if (placedObs > 0) ctl.partialPlan = { pp, P0 }
          } else if (rb && rb.ok) ctl.partialPlan = null
          // ждали дракона (садится / не кружит) — не попытка: столбик для опоры над столбом ставится только пока кружит
          if (rb && !rb.ok && /дракон|опасно/.test(rb.why || '')) ctl.pillarTries--
          else if (PILLAR_BAD && rb && !rb.ok && !/эндермен|мало хп/.test(rb.why || '')) ctl.pillarBad.set(pillarKey(pp), (ctl.pillarBad.get(pillarKey(pp)) || 0) + 1)
        }
        continue
      }
      if (ctl.pillar && ctl.pillar.built && ph === PHASE.APPROACH) {
        doing(ctl, 'pillar:enter')
        await pillarEnter(session, ctl, ctl.pillar.plan)
        await sleep(50)
        continue
      }
      if (ctl.pillar && ctl.pillar.built && ph === PHASE.LANDING) {
        const key = d.id + ':' + ocLandStart
        if (key !== ctl.pillarKey) {
          ctl.pillarKey = key
          await pillarRun(session, ctl, stats, track, feed)
          continue
        }
      }
    }
    // Бюджет кроватей спидраннера (≤ 8, 01.10): все — в цепочку станции у столба на одном снижении. Сидящему (взлёт после
    // > 50) и «своей» станции на снижении — только когда станции не будет или дракона пора добить (hb3: в 5 проигрышах из 7
    // 2–4 кровати ушли сидящему до станции, цепочке не хватило).
    // hb5 (01.10): с запасом кроватей сидящему бот ждал у центра без укрытия bedsPerch — 14 смертей из 25; выключено,
    // пока нет безопасного ожидания (ND_KEEP_BEDS=1 — включить).
    // 01.10 (вечер): включено по умолчанию, но с безопасным ожиданием, как у раннеров — без станции бот уходит из обзора
    // сидящего (кольцо r 23–27, дальше 20 от фонтана: не рычит и не жжёт), со станцией — в окоп; сидящего добивать, только
    // если двух кроватей хватит (finish). Кристаллы лечат ~2 хп/с: сидячие 2 кровати до станции к следующей цепочке отлечены.
    const bedsN = countOf(bot, /_bed$/) + (stationBedPlaced(bot, ctl) ? 1 : 0)
    const finish = hp != null && hp <= 45 * Math.min(bedsN, 2) + 5
    const stationLater = !!ctl.pillarMode && (ctl.pillarTries || 0) < pillarTriesMax() && ((ctl.pillar && ctl.pillar.built) || runnerOn() || countOf(bot, /^(obsidian|crying_obsidian)$/) >= 1)
    const keepBeds = KEEP_ON && ctl.bedsOnly && stationLater && bedsN <= KEEP_N && !finish
    // st1-s23: «держаться в окопе» при сидящем копало окоп заново у его головы — смерть; не в окопе — тоже наружу
    const builtPl = ctl.pillar && ctl.pillar.built ? ctl.pillar.plan : null
    const holdPh = ph === PHASE.LANDING || ph === PHASE.TAKEOFF || SITTING.has(ph)
    const inTrench = keepBeds && holdPh && !!builtPl && (() => { const q = bot.entity.position; return (Math.floor(q.x) === builtPl.B.x && Math.floor(q.z) === builtPl.B.z && Math.abs(q.y - builtPl.feet.y) < 0.3) || !!pillarHere(bot, builtPl) })()
    const holdOut = keepBeds && holdPh && !inTrench
    if (ctl.bedsOnly && OC_ON && !keepBeds && ph === PHASE.LANDING && feed.fc && feed.fc.id === d.id) {
      const key = d.id + ':' + ocLandStart
      if (key !== ocLandKey && feed.fc.n >= 40 && feed.fc.n <= 190) {
        ocLandKey = key
        await ocLanding(session, ctl, rep, stats, track, feed)
        continue
      }
    }
    // Только кровати: сел — посадка целиком в bedsPerch (свои проверки облаков,
    // фаерболов и коробок дракона — по высоте точные: земля у фонтана под ними).
    if (keepBeds && SITTING.has(ph) && ctl.pillar && ctl.pillar.built) {
      const bad0 = dangerAt(bot, bot.entity.position, ctx)
      if (bad0) { await evade(bot, ctl, stats, { ...bad0, ctx }); continue }
      // R (02.10, rs3: после 4 кроватей дракону оставалось 1–24 хп в 7 из 11 проигрышей): кроватей нет, дракон сел — мечом
      // в голову, один заход на посадку (сидячий счёт до 50 удары не поднимают). ND_RUN_MELEE=1 — вкл., пока не замерено.
      const sitKey = d.id + ':' + ocLandStart
      if (RUN_MELEE() && builtPl && builtPl.runner && countOf(bot, /_bed$/) < 1 && !stationBedPlaced(bot, ctl) && hp != null && hp <= envNum('ND_RUN_MELEE_HP', 35) && bot.health >= 12 && ctl.meleeKey !== sitKey) {
        ctl.meleeKey = sitKey
        doing(ctl, 'pillar:melee')
        const f = await meleeFinish(session, ctl, stats, track, { blind: false })
        if (ctl.trace) ctl.trace.ev('runnerMelee', { ok: f.ok, why: f.why || null, hits: f.hits || 0, hp0: r1(hp) })
        continue
      }
      if (inTrench) {
        doing(ctl, 'pillar:hold')
        await lookAtSafe(bot, parts.bodyC)
        await sleep(150)
        continue
      }
    }
    if (ctl.bedsOnly && SITTING.has(ph) && !keepBeds) {
      await bedsPerch(session, ctl, rep, stats, track)
      await sleep(60)
      continue
    }
    const me = bot.entity.position
    // 1. Опасность под ногами — отойти.
    const bad = dangerAt(bot, me, ctx)
    if (bad) { await evade(bot, ctl, stats, { ...bad, ctx }); continue }
    // 2. Злой эндермен (бил нас) — отбиться; посадку не бросать ради него,
    // если кровать у головы уже ждёт.
    const angry = hunters(bot, 3.5).sort((a, b) => a.position.distanceTo(me) - b.position.distanceTo(me))[0]
    const window = SITTING.has(ph) || ph === PHASE.LANDING || ph === PHASE.TAKEOFF
    if (angry && !(window && st && bedHere(bot, st))) {
      await fightEnderman(session, ctl, stats, angry, () => {
        const p2 = phaseOf(bot, dragonOf(bot))
        return !!st && (p2 === PHASE.LANDING || SITTING.has(p2)) && bedHere(bot, st)
      })
      await sleep(50)
      continue
    }
    // 3. Здоровье. Есть — 1.6 с: в окне посадки у готовой кровати не есть,
    // если хп терпит (станция держит облако огня выше нас).
    const busy = window && st && bedHere(bot, st)
    // Стоим на блоке над облаком (рефлекс или «на блок» подняли) — не сходить
    // в него: ни за эндерняком, ни к месту у фонтана, ни в яму. Раньше круг
    // боя тут же уводил тело вниз, в то же облако: d4-24 (30.09, 32–35 с
    // второго вызова) — три удара по 6 подряд, смерть.
    const perched = overCloud(bot)
    if (perched) stats.overCloud = (stats.overCloud || 0) + 1
    if (!perched && !window && onSpike(bot)) { await getDown(session, ctl, stats); continue }
    {
      const pil = onOwnPillar(bot)
      if (pil) {
        doing(ctl, 'pillar:down')
        if (ctl.trace) ctl.trace.ev('pillarDown', { n: pil.n, gy: pil.gy })
        await digDownTo(bot, ctl, pil.gy, pil.n + 2)
        continue
      }
    }
    if (bot.health <= 7 && !window && !perched) { await hideAndHeal(session, ctl, rep, stats, { until: 16 }); continue }
    if (bot.health <= 14 && !window && !perched) await clearOfClouds(session, ctl, stats)
    if ((bot.health <= 14 || bot.food < 16) && !(busy && bot.health > 8)) await heal(session, ctl, rep, stats, { hard: bot.health <= 14 })
    // 4. Кровати. Пока летает — заранее построенная станция у фонтана (не
    // больше двух за бой); сел — если голова у неё, жать там, иначе дождаться,
    // пока голова встанет, и собрать станцию прямо под ней (headPlan).
    if (!window) dyn = null
    // Блоков на станцию (10) и заслоны нет — наломать эндерняка, пока летает.
    const lowBlocks = countOf(bot, FILLER_RE) < (ctl.beds && countOf(bot, /_bed$/) > 0 ? 14 : 6)
    if (!bot.inventory.slots.some((it, k) => k >= 36 && k <= 44 && it && it.name === 'water_bucket') && findItem(bot, /^water_bucket$/)) await waterToHotbar(bot)
    if (!window && !perched && gameClock.now() >= refillAt && !findItem(bot, /^water_bucket$/) && findItem(bot, /^bucket$/)) {
      refillAt = gameClock.now() + 20000
      await refillBucket(session, ctl, stats)
      continue
    }
    if (lowBlocks && !window && !perched && gameClock.now() >= mineRetry && findItem(bot, /_pickaxe$/)) {
      const got = await mineEndStone(session, ctl, 20, stats)
      if (got < 4) mineRetry = gameClock.now() + 30000
      continue
    }
    // Добить из лука в полёте: после посадки у дракона ≤ 20 хп (лечится 2 хп/с — только сейчас).
    if (ctl.bedsOnly && hp != null && hp <= 20 && !SITTING.has(ph) && ph !== PHASE.LANDING && !perched && gameClock.now() - lastShot > 900) {
      lastShot = gameClock.now()
      // (02.10 вечер, rs12-s8/s15/s18: сюда передавали false — bow.shoot звал hazardSoon() и вызов «сорвался» при драконе 0.2–12 хп
      // сразу после взлёта с меча; добивания из лука в полёте не было ни разу)
      if (await rangedShot(session, ctl, stats, track, d, () => !!hazardNow(bot))) { stats.finishArrows = (stats.finishArrows || 0) + 1; continue }
    }
    if (ctl.bedsOnly) {
      // Кровати кончились — бой «только кроватями» нечем продолжать: вернуть
      // вызывающему (need), а не стоять под драконом до конца срока.
      // 03.10: кристаллы сбиты (живых ≤ 3 — клетки) и станция R с мечом — бой не кончен, если дракону осталось мало: в облёте
      // он лечится только у клеток (~40 % пути), посадки в 2.6 раза чаще — следующая посадка мечом из чаши (runnerSword).
      // ND_SWORD_MORE=0 — выкл.; ND_SWORD_MORE_HP — до скольких хп дракона продолжать (80; ca1-s2: 2-я посадка мечом 33.7 → 6.3,
      // в облёте лечение у клеток 0–2 хп/с — 3-я посадка нужна, а предел 40 оборвал бой при 41).
      const swordMore = countOf(bot, /_bed$/) < 1 && !stationBedPlaced(bot, ctl) && crysOn() && envv('ND_SWORD_MORE') !== '0' && RUN_SWORD() &&
        !!(ctl.pillar && ctl.pillar.built && ctl.pillar.plan && ctl.pillar.plan.runner) && !!items.bestWeapon(bot) && crysAlive(ctl) != null && crysAlive(ctl) <= 3 &&
        hp != null && hp <= envNum('ND_SWORD_MORE_HP', 80) && bot.health >= 12 && deadline - gameClock.now() > 45000
      if (swordMore && !ctl.swordMoreT) { ctl.swordMoreT = gameClock.now(); if (ctl.trace) ctl.trace.ev('swordMore', { hp: r1(hp), alive: crysAlive(ctl) }) }
      if (countOf(bot, /_bed$/) < 1 && !stationBedPlaced(bot, ctl) && !swordMore) {
        rep.dragon.lost = 'кровати кончились — бой только кроватями нечем продолжать'; rep.need = { what: 'red_bed', count: BEDS_KIT, have: 0 }
        // 02.10 (rs2-s9): кровати кончились в окопе/чаше у фонтана — бот стоял под сидящим драконом после конца вызова и
        // погиб (11 хп после своих взрывов, удар дракона). Уйти на кольцо 23–27 (вне обзора сидящего), потом вернуть управление.
        if (dragonOf(bot) && Math.hypot(me.x - CENTER.x, me.z - CENTER.z) < 21 && !ctl.bedsOut) {
          ctl.bedsOut = true
          doing(ctl, 'beds:out')
          const P1 = podiumTop(bot)
          const spot = pickSpot(bot, CENTER, { rMin: 23, rMax: 27, step: 0.75, prefer: me, avoid: f => nearPillar(bot, f, 3) || (P1 != null && f.y > P1 - 2.5) })
          if (spot) await walkTo(session, ctl, spot.feet, { range: 1, timeoutMs: 15000 }).catch(() => {})
          if (ctl.trace) ctl.trace.ev('bedsOut', { to: spot ? [r1(spot.feet.x), r1(spot.feet.y), r1(spot.feet.z)] : null, at: [r1(bot.entity.position.x), r1(bot.entity.position.y), r1(bot.entity.position.z)], hp: r1(bot.health) })
        }
        break
      }
      // Только кровати: ни станции, ни кристаллов, ни стрел. Ждать посадку на
      // земле сразу за кругом посадки (крылья садящегося достают до 14.5 от
      // центра, а земля у фонтана — верх фонтана − 3, в их высоте): голова сядет
      // в 6.5 от центра — до места у неё 8–10 шагов, и сидящий видит нас (≤ 20).
      const fromC0 = Math.hypot(me.x - CENTER.x, me.z - CENTER.z)
      const P0 = podiumTop(bot)
      const high = P0 != null && me.y > P0 - 2.5
      // Кольцо 27–31 на время облёта (заходов с фаерболом по формуле меньше:
      // 1/(⌊d²/512⌋+2)) пробовали в b4 — заходов на перерыв не меньше (9 против 7),
      // а перерыв всё равно ≥ 88 с (кружит 56 с при 10 кристаллах) — лечение до 200
      // при любом кольце. Оставлено одно кольцо у круга посадки.
      const far = false
      // Заходит на посадку (фаза 2 — до снижения ещё 5–15 с, фаерболов нет): ближе к
      // фонтану, чтобы до станции у головы (голова сядет в 6.5 от центра) было ≤ 12 шагов.
      // Кровати бережём, станции ещё нет (holdOut): снижение и посадку ждать вне обзора сидящего (20 от него) — r 23–27
      // Кристаллы (03.10, crystalWait): станция готова, дракон кружит — стрелять по открытым с места ожидания; пока есть по
      // чему стрелять, место ожидания — полоса 13–30 от центра (точки выстрела), иначе — прежнее кольцо.
      const stationR = !!(ctl.pillar && ctl.pillar.built)
      if (crysOn() && stationR && !window && !perched && !holdOut) {
        if (await crystalWait(session, ctl, stats, d, ph)) continue
      }
      const crysBand = crysOn() && stationR && !!ctl.crys && ctl.crys.active && !window && !holdOut && ph !== PHASE.APPROACH
      // Дальнее ожидание (ND_WAIT_FAR=1, выкл.): заходов с фаерболом меньше — nextInt(⌊d²/512⌋+2): r 15 → 1/2, r 30–33 → 1/3–1/4;
      // при 10 кристаллах это ~12 с за бой, при 2 — ~3 с (5 решений до посадки), а дорога к станции на заход длиннее (APPROACH →
      // LANDING p10 5.6 с). b4 (30.09): кольцо 27–31 — заходов не меньше. Поэтому по умолчанию — прежнее кольцо.
      const waitFar = stationR && envv('ND_WAIT_FAR') === '1' && !holdOut && ph !== PHASE.APPROACH
      const bucketBand = dragonWaitBand({ station: stationR, crystalActive: crysBand, holdOut, ph })
      const [r0, r1b] = bucketBand || (holdOut ? [23, 27] : OC_ON && ph === PHASE.APPROACH ? [9.5, 11.5] : crysBand ? CRYS_BAND : waitFar ? [27, 33] : [15, 16.5])
      if ((!window || holdOut) && !perched && (fromC0 > r1b + 1 || fromC0 < r0 - 0.7 || (high && !crysBand) || nearEdge(bot, me, 2))) {
        let spot = pickSpot(bot, CENTER, { rMin: r0, rMax: r1b, step: crysBand ? 1.5 : 0.75, prefer: me, avoid: f => nearPillar(bot, f, 3) || (!far && !crysBand && P0 != null && f.y > P0 - 2.5) })
        if (!spot && (crysBand || waitFar || bucketBand)) spot = pickSpot(bot, CENTER, { rMin: 15, rMax: 16.5, step: 0.75, prefer: me, avoid: f => nearPillar(bot, f, 3) || (P0 != null && f.y > P0 - 2.5) })
        doing(ctl, 'beds:reposition')
        if (spot) {
          // Начался APPROACH — сразу вернуть управление pillarEnter, не заканчивать отход на кольцо.
          const stopWait = bucketBand ? () => dragonWaitStop(phaseOf(bot, dragonOf(bot))) : null
          if (bucketBand && ctl.trace && P0 != null) ctl.trace.ev('waitBucket', { ...holdingOdds(crysAlive(ctl) ?? 10, spot.feet, new Vec3(CENTER.x, P0 + 0.5, CENTER.z)), to: [spot.feet.x, spot.feet.y, spot.feet.z], knownAlive: crysAlive(ctl) })
          if (spot.feet.distanceTo(me) > 8) await walkTo(session, ctl, spot.feet, { range: 1, timeoutMs: 12000, sprint: crysBand || waitFar || !!bucketBand, stopIf: stopWait })
          else await stepTo(bot, ctl, spot.feet, { ms: 2500, stopAt: 0.5, stop: stopWait })
        } else await sleep(200)
        continue
      }
      if (bot.food < 18 && !window) await tidy(session, ctl, rep, stats)
      doing(ctl, window ? 'beds:landing' : 'beds:wait')
      await lookAtSafe(bot, parts.bodyC)
      await sleep(100)
      continue
    }
    if (ctl.beds && countOf(bot, /_bed$/) > 0 && countOf(bot, FILLER_RE) > 0) {
      if (!st && !window && gameClock.now() >= stationRetry) {
        st = chooseStation(bot, stFails)
        if (!st) {
          stats.stationNone = chooseStation.why
          stationRetry = gameClock.now() + 5000
        } else {
          stats.stations = (stats.stations || 0) + 1
          if (ctl.trace) ctl.trace.ev('station', { key: st.key, B: [st.B.x, st.B.y, st.B.z], yb: st.yb, g: st.g, place: st.place.length })
        }
      }
      // Сел — к готовой станции и ждать на ней: высматривая (25 тиков в
      // начале каждого круга огня), дракон поворачивается к игроку в 20 блоках
      // — к нам на B, голова ложится над изголовьем (сцена station8: уход к
      // «станции под головой» стоил 51 с метаний под облаком). Станция под
      // головой (headPlan) — только если он нас не видит: высматривает дольше
      // 25 тиков без рёва (Sensing у дракона не очищается — EnderDragon.aiStep
      // не зовёт serverAiStep, — и «не видно» остаётся навсегда): тогда не
      // повернётся и не дохнёт, 100 тиков сидит.
      const blind = ph === PHASE.SCANNING && blindKnown(sitRec)
      let use = window ? dyn : st
      // Поправка по замеру (e2e10, 2026-09-26): к игроку на B (11 блоков от
      // центра) сидящий почти не поворачивается — прибавка к повороту
      // 0.7/(d+1)² на градус от головы до игрока: с 13 блоков ~20° за 25 тиков
      // (две посадки по четыре огня, голова так и осталась в 7 блоках от
      // станции). Поэтому ждать на станции — только пока он садится и, сев,
      // первые 25 тиков; голова не у станции, когда направление уже
      // окончательное (рёв, огонь), — кровать у самой головы (perchAttack →
      // bedBlast, 33–43 урона за кровать в прогонах).
      const settled = ph === PHASE.ROARING || ph === PHASE.FLAMING || blind
      if (window && !use && st) {
        const near = headPoint(bot, d, track, 0).distanceTo(st.blast) <= 4.5
        if (near || ph === PHASE.LANDING || ph === PHASE.TAKEOFF || (SITTING.has(ph) && !settled)) use = st
      }
      // Без станции у головы — perchAttack (видящему — кровать или меч; слепому —
      // только выйти из коридора взлёта). Станция под головой (headPlan) слепому
      // больше не строится: за 5 с посадки её не собрать, а стоит она в коридоре
      // взлёта (dtr-1-2, 344–350 с).
      if (window && !use && SITTING.has(ph)) { await perchAttack(session, ctl, rep, stats, track); await sleep(50); continue }
      if (use) {
        const r = await stationStep(session, ctl, rep, stats, track, use, d, ph)
        if (r === 'далеко') {
          // Голова ушла от станции (довернулся) — собрать заново под ней.
          stats.stationFar = (stats.stationFar || 0) + 1
          if (use === dyn) dyn = null
          else if (SITTING.has(ph)) dyn = null
          continue
        }
        if (r === 'fail') {
          if (use === st) {
            stFails.set(st.key, (stFails.get(st.key) || 0) + 1)
            if (ctl.trace) ctl.trace.ev('stationFail', { key: st.key })
            st = null
          } else dyn = null
          continue
        }
        // Станция под облаком — обычный бой (лук, уход от угроз) поодаль.
        if (r !== 'готово' && r !== 'облако') continue
      }
    }
    const stationed = !!st && ctl.beds && countOf(bot, /_bed$/) > 0
    // 5. Без станции: сидит — к голове с мечом (только видящий, см. perchAttack).
    if (!stationed && SITTING.has(ph)) { await perchAttack(session, ctl, rep, stats, track); await sleep(50); continue }
    // Кристалл на обелиске ещё жив (не сбили в начале) — снова за ним, пока
    // дракон летает: иначе он лечит дракона на 2 хп/с (d5-17, d5-22).
    if (!window && !perched && gameClock.now() >= crystalRetry && crystalsOf(bot).some(c => c.pillar)) {
      crystalRetry = gameClock.now() + 60000
      stats.crystalRetry = (stats.crystalRetry || 0) + 1
      if (ctl.trace) ctl.trace.ev('crystalRetry', { left: crystalsOf(bot).filter(c => c.pillar).length })
      await destroyCrystals(session, ctl, rep, stats, { deadline: Math.min(deadline, gameClock.now() + 150000) })
      continue
    }
    // 6. Летает: без станции — держаться у портала в 10–16 блоках.
    const fromC = Math.hypot(me.x - CENTER.x, me.z - CENTER.z)
    // Садится, сидит, взлетает — не возвращаться к фонтану (там его крылья и
    // коридор взлёта): отошли от них — там и стоять до конца посадки.
    if (!stationed && !window && !perched && (fromC > 18 || fromC < 7 || nearEdge(bot, me, 2))) {
      const spot = pickSpot(bot, CENTER, { rMin: 9, rMax: 14, avoid: f => nearPillar(bot, f, 2) })
      doing(ctl, 'fight:reposition')
      if (spot) {
        if (spot.feet.distanceTo(me) > 8) await walkTo(session, ctl, spot.feet, { range: 1, timeoutMs: 12000 })
        else await stepTo(bot, ctl, spot.feet, { ms: 2500, stopAt: 0.5 })
      } else await sleep(200)
      continue
    }
    const hazardSoon = () => !!hazardNow(bot)
    // 7. Стрелы по летящему (сидящему — без толку: onHurt → 0).
    if (!window && gameClock.now() - lastShot > 300 && countOf(bot, /arrow$/) > 0) {
      const dist = d.position.distanceTo(me)
      const good = dist < 44 && (ph === PHASE.STRAFE || ph === PHASE.CHARGING || ph === PHASE.APPROACH || dist < 30)
      if (good && !hazardSoon()) {
        doing(ctl, 'fight:shoot')
        await rangedShot(session, ctl, stats, track, d, hazardSoon)
        lastShot = gameClock.now()
        continue
      }
    }
    // Пока ждём — смотреть на дракона (но не в глаза эндерменам) и есть.
    if (bot.food < 18 && !window) await tidy(session, ctl, rep, stats)
    await lookAtSafe(bot, parts.bodyC)
    await sleep(100)
  }
  rep.dragon.hpLog = hpLog.slice(-40)
  rep.dragon.won = won
  if (won && ctl.started) rep.timing.killed = Math.round((gameClock.now() - ctl.started) / 1000)
  if (stats.perchCount) rep.dragon.perchCount = stats.perchCount
  if (stats.bedPerches && stats.bedPerches.length) rep.dragon.bedPerches = stats.bedPerches.slice(-12).map(({ key, ...p }) => p)
  {
    const dd0 = dragonOf(bot)
    const tr = dd0 && takeoffSeen.get(dd0.id)
    if (tr && tr.az.length) rep.dragon.takeoffAz = tr.az.map(a => Math.round(a * 180 / Math.PI))
  }
  if (stats.stations) rep.dragon.station = { built: stats.stations, blocks: stats.stationBlocks || 0, none: stats.stationNone }
  const dd = dragonOf(bot)
  rep.dragon.hpNow = won ? 0 : (dd ? Math.round(hpOf(bot, dd) ?? 0) : null)
}

// ------------------------------------------------------------ после победы

function portalBlocks (bot) {
  const id = bot.registry.blocksByName.end_portal && bot.registry.blocksByName.end_portal.id
  if (id == null) return []
  return bot.findBlocks({ matching: id, maxDistance: 48, count: 30, point: new Vec3(0, 60, 0) })
}

async function collectXp (session, ctl, ms = 6000) {
  const bot = session.bot
  const t0 = gameClock.now()
  const xp0 = bot.experience ? bot.experience.points : 0
  while (!ctl.aborted && gameClock.now() - t0 < ms) {
    // Опыт сыплется над порталом: за шаром в портал не шагать (унесёт домой).
    const orb = bot.nearestEntity(e => e && e.name === 'experience_orb' && e.position && e.position.distanceTo(bot.entity.position) < 16 &&
      Math.hypot(e.position.x - CENTER.x, e.position.z - CENTER.z) > 6.5)
    if (!orb) { await sleep(250); continue }
    // Шагом, не бегом: шары сами летят к игроку в 8 блоках, а разбег у края
    // портала заносит в него (прогон 2026-09-25: тело ушло домой само).
    await stepTo(bot, ctl, orb.position, { ms: 800, stopAt: 0.8, sprint: false })
  }
  return bot.experience ? bot.experience.points - xp0 : null
}

// Яйцо. Руками его не сломать: ударить или нажать — телепортируется
// (DragonEggBlock) на воздух в ±15 блоках и падает на землю. Предметом оно
// становится, только если, падая, приземлится в клетку с незаменяемым
// неполным блоком (FallingBlockEntity → дроп): под опорой S копаем T, на дно
// ставим факел и выбиваем S — яйцо падает на факел. Потом спуститься за ним в
// яму и выбраться столбом. Если под яйцом bedrock/обсидиан — ткнуть ещё раз.
// Яйцо уже предметом на земле (прошлый заход уронил его, а подобрать не успел).
function eggItem (bot, r = 24) {
  const me = bot.entity.position
  return bot.nearestEntity(e => {
    if (!e || e.name !== 'item' || !e.position || e.position.distanceTo(me) > r) return false
    try { const it = e.getDroppedItem && e.getDroppedItem(); return !!it && it.name === 'dragon_egg' } catch { return false }
  })
}
// Подобрать предмет: встать на его клетку (в яму — так в яму), подождать,
// выбраться. Свидетель — рюкзак, а не «дошёл».
async function pickUp (session, ctl, item, name) {
  const bot = session.bot
  const had = countOf(bot, new RegExp(`^${name}$`))
  for (let i = 0; i < 3 && !ctl.aborted && item && item.isValid !== false; i++) {
    const at = item.position.clone()
    await stepTo(bot, ctl, at, { ms: 2500, stopAt: 0.25, sprint: false })
    if (Math.hypot(bot.entity.position.x - at.x, bot.entity.position.z - at.z) > 0.8) await walkTo(session, ctl, at, { range: 0, timeoutMs: 6000 })
    const t0 = gameClock.now()
    while (gameClock.now() - t0 < 1500 && countOf(bot, new RegExp(`^${name}$`)) <= had) await sleep(100)
    if (countOf(bot, new RegExp(`^${name}$`)) > had) break
  }
  const torch = bot.blockAt(bot.entity.position.floored())
  if (torch && /torch/.test(torch.name)) await bot.dig(torch, true).catch(() => {})
  await build.escapePit(bot, ctl, { maxClimb: 4, mcData: session.mcData }).catch(() => {})
  return countOf(bot, new RegExp(`^${name}$`)) > had
}

async function takeEgg (session, ctl, rep) {
  const bot = session.bot
  const id = bot.registry.blocksByName.dragon_egg.id
  const out = { pokes: 0 }
  const lying = eggItem(bot)
  if (lying) { out.lying = true; out.have = await pickUp(session, ctl, lying, 'dragon_egg'); if (!out.have) out.why = 'яйцо лежит предметом, но в рюкзак не попало'; return out }
  if (!findItem(bot, /^torch$/)) { out.why = 'нет факела — без него яйцо не взять (падая на факел, оно становится предметом)'; return out }
  const diggable = b => b && isSolid(b) && !/bedrock|obsidian|end_portal|end_gateway/.test(b.name)
  for (let attempt = 0; attempt < 5 && !ctl.aborted; attempt++) {
    const egg = bot.findBlock({ matching: id, maxDistance: 48, point: bot.entity.position })
    // Яйцо кладётся только за ПЕРВОГО дракона мира (EndDragonFight.setDragonKilled:
    // !previouslyKilled); за воскрешённого — нет.
    if (!egg) { out.why = 'яйца нет: его кладут только за первого дракона этого мира, за воскрешённого — нет'; return out }
    const E = egg.position
    out.at = { x: E.x, y: E.y, z: E.z }
    const S = E.offset(0, -1, 0); const T = E.offset(0, -2, 0); const U = E.offset(0, -3, 0)
    const sB = bot.blockAt(S); const tB = bot.blockAt(T); const uB = bot.blockAt(U)
    const fits = diggable(sB) && (diggable(tB) || isAirish(tB)) && isSolid(uB)
    // Встать рядом с яйцом, не над ямой.
    const near = pickSpot(bot, { x: E.x + 0.5, z: E.z + 0.5 }, { rMin: 2, rMax: 3, step: 1, edge: 0, nearY: E.y })
    if (near) await walkTo(session, ctl, near.feet, { range: 0.6, timeoutMs: 20000 })
    if (!fits) {
      // Ткнуть: перелетит на новое место.
      await bot.lookAt(E.offset(0.5, 0.5, 0.5), true).catch(() => {})
      await bot.activateBlock(egg).catch(() => {})
      out.pokes++
      await sleep(2000)
      continue
    }
    try {
      if (diggable(tB)) { await items.equipBestTool(bot, tB); await build.withTimeout(bot.dig(tB, true), 6000) }
      await bot.equip(findItem(bot, /^torch$/), 'hand')
      await build.withTimeout(bot.placeBlock(bot.blockAt(U), new Vec3(0, 1, 0)), 3000).catch(() => {})
      await sleep(250)
      if (!bot.blockAt(T) || !/torch/.test(bot.blockAt(T).name)) { out.why = 'факел на дно ямы не встал'; return out }
      const s2 = bot.blockAt(S)
      await items.equipBestTool(bot, s2)
      await build.withTimeout(bot.dig(s2, true), 6000)
    } catch (e) { out.why = e.message; return out }
    await sleep(1500)
    // Предмет на дне ямы: спуститься, подобрать, выбраться.
    const item = eggItem(bot, 8) || bot.nearestEntity(e => e && e.name === 'item' && e.position && e.position.distanceTo(T.offset(0.5, 0, 0.5)) < 3)
    if (item) await pickUp(session, ctl, item, 'dragon_egg')
    out.have = countOf(bot, /^dragon_egg$/) > 0
    if (!out.have) out.why = 'яйцо упало, но в рюкзак не попало'
    return out
  }
  if (!out.why) out.why = `после ${out.pokes} тычков яйцо так и не легло на копаемую землю`
  return out
}

// Домой через выходной портал. Первый проход показывает титры: сервер ждёт
// от клиента «возродиться» (ServerboundClientCommandPacket PERFORM_RESPAWN).
async function goHome (session, ctl, rep) {
  const bot = session.bot
  const out = {}
  const blocks = portalBlocks(bot)
  if (!blocks.length) { out.why = 'выходного портала не видно — дракон жив?'; return out }
  // Из ямы (после яйца) pathfinder не выводит — сначала выбраться.
  const pit = await build.escapePit(bot, ctl, { maxClimb: 6, mcData: session.mcData }).catch(() => null)
  if (pit && pit.wasInPit) out.pit = pit
  const target = blocks.sort((a, b) => a.distanceTo(bot.entity.position) - b.distanceTo(bot.entity.position))[0]
  // Край портала (bedrock) вровень с землёй: ходят на высоте target.y + 1. Кто
  // ниже (яма от яйца рядом с порталом) — сначала подняться столбом.
  for (let i = 0; i < 4 && !ctl.aborted && bot.entity.position.y < target.y + 0.9 && target.distanceTo(bot.entity.position) < 8; i++) {
    const t = await build.towerUp(bot, ctl, 1)
    if (!t.placed) break
  }
  const dim0 = bot.game.dimension
  ctl.homeBound = true
  let credits = false
  const onGame = (packet) => { if (packet && (packet.reason === 4 || packet.reason === 'win_game')) credits = true }
  bot._client.on('game_state_change', onGame)
  try {
    // pathfinder'у портал — не пол (blocksToAvoid): довести до края, а внутрь
    // шагнуть клавишами.
    const w = await walkTo(session, ctl, target.offset(0.5, 0, 0.5), { range: 3, timeoutMs: 25000, xz: true, portal: true })
    out.walk = w.ok ? 'дошёл до края' : w.why
    const t0 = gameClock.now()
    while (!ctl.aborted && gameClock.now() - t0 < 12000 && bot.game.dimension === dim0) {
      if (credits) {
        try { bot._client.write('client_command', bot.supportFeature('respawnIsPayload') ? { payload: 0 } : { actionId: 0 }) } catch {}
        credits = false
        out.credits = true
      }
      if (bot.game.dimension === dim0 && !credits) {
        const r = await stepTo(bot, ctl, target.offset(0.5, 0, 0.5), { ms: 1200, stopAt: 0.1, sprint: false, portal: true })
        out.step = r.why || 'ok'
      }
      await sleep(250)
    }
  } finally {
    bot._client.removeListener('game_state_change', onGame)
  }
  out.dimension = bot.game.dimension
  out.home = bot.game.dimension !== dim0
  if (!out.home) { out.target = { x: target.x, y: target.y, z: target.z }; const m = bot.entity.position; out.at = { x: +m.x.toFixed(1), y: +m.y.toFixed(1), z: +m.z.toFixed(1) } }
  return out
}

// Воскресить дракона: четыре кристалла на края выходного портала, по одному
// с каждой стороны (EndDragonFight.tryRespawn: кристалл в клетке
// portalLocation.above(1).relative(сторона, 2); Paper без
// allow-remote-ender-dragon-respawning принимает только поставленный на
// крест портала: |dx| ≤ 3 и |dz| ≤ 1 или наоборот). Ставят на bedrock края —
// в трёх блоках от центра.
async function respawnDragon (session, ctl, rep) {
  const bot = session.bot
  const out = { placed: 0, sides: [] }
  const blocks = portalBlocks(bot)
  if (!blocks.length) { out.why = 'выходного портала не видно (дракон жив или портал не зажжён)'; return out }
  const Y = Math.min(...blocks.map(b => b.y))
  const cx = Math.round(blocks.reduce((a, b) => a + b.x, 0) / blocks.length)
  const cz = Math.round(blocks.reduce((a, b) => a + b.z, 0) / blocks.length)
  out.center = { x: cx, y: Y, z: cz }
  const crystalItem = () => findItem(bot, /^end_crystal$/)
  if (!crystalItem() || countOf(bot, /^end_crystal$/) < 4) { out.why = `нужно 4 end_crystal, есть ${countOf(bot, /^end_crystal$/)}`; out.need = { what: 'end_crystal', count: 4, have: countOf(bot, /^end_crystal$/) }; return out }
  // Два прохода: «ответа от сервера нет» бывает и там, где кристалл встал бы
  // со второго раза; уже стоящие второй проход засчитывает и не трогает.
  for (let pass = 0; pass < 2 && !ctl.aborted; pass++) {
  if (pass) { if (out.placed >= 4) break; out.placed = 0; out.firstPass = out.sides; out.sides = [] }
  for (const [dx, dz] of [[3, 0], [-3, 0], [0, 3], [0, -3]]) {
    if (ctl.aborted) break
    const rim = new Vec3(cx + dx, Y, cz + dz)
    const side = { at: { x: rim.x, y: rim.y, z: rim.z } }
    out.sides.push(side)
    // Уже стоит?
    if (Object.values(bot.entities).some(e => e && e.name === 'end_crystal' && e.position && Math.abs(e.position.x - rim.x - 0.5) < 0.6 && Math.abs(e.position.z - rim.z - 0.5) < 0.6)) { side.already = true; out.placed++; continue }
    // Встать снаружи, в двух блоках от края, лицом к порталу.
    // Встать на землю у края (по высоте тоже: «рядом по x/z» на мостке над
    // порталом — это 8 блоков до края, кристалл не поставить).
    const sy = standY(bot, cx + Math.sign(dx) * 5 + 0.5, cz + Math.sign(dz) * 5 + 0.5, Y + 1, 2, 3) ?? (Y + 1)
    const stand = new Vec3(cx + Math.sign(dx) * 5 + 0.5, sy, cz + Math.sign(dz) * 5 + 0.5)
    const w = await walkTo(session, ctl, stand, { range: 1.5, timeoutMs: 20000 })
    side.dist = Math.round(bot.entity.position.offset(0, EYE, 0).distanceTo(rim.offset(0.5, 1, 0.5)) * 10) / 10
    if (!w.ok) side.walk = w.why
    // Край читать уже рядом (издали прогон увидел «stone» и «gravel» там, где
    // сервер отвечает bedrock).
    const b = bot.blockAt(rim)
    side.block = b && b.name
    if (!b || !/bedrock|obsidian/.test(b.name)) { side.why = 'край портала не bedrock'; continue }
    // Огонь над краем: кристалл держит огонь в своей клетке (EndCrystal.tick),
    // а bedrock в Энде горит вечно (#infiniburn_end) — от прошлого воскрешения
    // остаётся огонь, а кристалл ставится только в пустую клетку
    // (EndCrystalItem.useOn: isEmptyBlock). Блок в огонь (огонь заменяем) и
    // выкопать — клетка пустая.
    const above = bot.blockAt(rim.offset(0, 1, 0))
    if (above && /fire/.test(above.name)) {
      const pl = await build.placeBlockAt(bot, rim.offset(0, 1, 0), { timeoutMs: 3000 })
      const fb = bot.blockAt(rim.offset(0, 1, 0))
      if (pl.ok && fb && isSolid(fb)) { try { await items.equipBestTool(bot, fb); await build.withTimeout(bot.dig(fb, true), 5000) } catch {} }
      side.fire = bot.blockAt(rim.offset(0, 1, 0)) ? bot.blockAt(rim.offset(0, 1, 0)).name : '?'
    }
    try {
      await bot.equip(crystalItem(), 'hand')
      await bot.lookAt(rim.offset(0.5, 1, 0.5), true)
      await build.withTimeout(bot.placeEntity(b, new Vec3(0, 1, 0)), 4000)
      out.placed++
      side.ok = true
    } catch (e) {
      side.why = e.message
      // Сервер мог поставить, а подтверждение не дошло.
      if (Object.values(bot.entities).some(e2 => e2 && e2.name === 'end_crystal' && e2.position && e2.position.distanceTo(rim.offset(0.5, 1, 0.5)) < 1)) { out.placed++; side.ok = true }
    }
    await sleep(300)
  }
  }
  // Через пару секунд кристаллы потянут лучи вверх — анимация воскрешения.
  await sleep(3000)
  out.started = out.placed >= 4
  return out
}

// ------------------------------------------------------------ главный вход

// mode: beds (по умолчанию с 30.09.2026, решение пользователя: прибыть →
// дракон только кроватями, кристаллы не трогать → яйцо → домой), full
// (прибыть → кристаллы луком → дракон), crystals, dragon, home, look (только
// доложить, не двигаясь).
// Подход жемчугом (pearl-hop.js): от платформы/края острова — к месту станции у столба (её план считаем
// отсюда же: центр прогружен с платформы), иначе — к точке в 8 блоках от центра на нашей стороне.
// Посадка — только на end_stone, не в чашу портала (r < 4.5). Резерв на побег — ND_PEARL_RESERVE (1).
async function pearlApproach (session, ctl, stats) {
  const bot = session.bot
  const me = bot.entity.position
  const r0 = Math.hypot(me.x - CENTER.x, me.z - CENTER.z)
  if (r0 < 30) return null
  const reserve = Number(process.env.ND_PEARL_RESERVE ?? 1)
  if (countOf(bot, /^ender_pearl$/) <= reserve) return null
  let goal = null; let goalWhy = 'r8'
  const P0 = podiumTop(bot)
  if (P0 != null && countOf(bot, /^(obsidian|crying_obsidian)$/) >= 2) {
    let pp = null
    // план станции — цель броска; считать не чаще раза в 20 с (pearlApproach зовётся на ходу раз в 2 с)
    const pc = ctl.pearlPlan
    if (pc && gameClock.now() - pc.t < 20000) pp = pc.pp
    else { try { pp = await pillarPlanAutoAsync(bot, P0) } catch { pp = null } ctl.pearlPlan = { t: gameClock.now(), pp } }
    if (pp) { goal = new Vec3(pp.feet.x, pp.G, pp.feet.z); goalWhy = 'станция' }
  }
  if (!goal) {
    const ux = (me.x - CENTER.x) / r0; const uz = (me.z - CENTER.z) / r0
    goal = new Vec3(CENTER.x + ux * 8, P0 != null ? P0 - 4 : me.y, CENTER.z + uz * 8)
  }
  ctl.pearlGoal = goal
  doing(ctl, 'pearl')
  const log = (m) => { console.log('[pearl] ' + m); dbg('pearl', m) }
  const floorOk = (b) => b.name === 'end_stone'
  const avoid = (feet) => Math.hypot(feet.x - CENTER.x, feet.z - CENTER.z) < 4.5
  // С платформы (y 49) до верха острова (~60+) дальность броска ~37 бл., а дуга снизу бьёт в бок обрыва:
  // нет броска отсюда — столб на платформе (как bridge:rise) на столько, со скольки бросок есть.
  let rise = null
  const under = bot.blockAt(me.floored().offset(0, -1, 0))
  // 02.10 (rs8-s12, смерть): остров нависает над платформой — жемчуг с платформы задел его бок, телепорт в воздух над пустотой.
  // Есть end_stone над платформой (до 14 выше, ±6 к острову) — с платформы не бросать.
  if (under && under.name === 'obsidian') {
    // нависание, а не обрыв: в колонне end_stone выше на 4–14, а под ним у платформы — воздух (у обрыва колонна сплошная снизу)
    let over = false
    const dx = Math.sign(CENTER.x - me.x) || 0, dz = Math.sign(CENTER.z - me.z) || 0
    const y0 = Math.floor(me.y)
    for (let k = 0; k <= 6 && !over; k++) for (let w = -2; w <= 2 && !over; w++) {
      const cx = Math.floor(me.x) + dx * k + (dx ? 0 : w), cz = Math.floor(me.z) + dz * k + (dz ? 0 : w)
      const open = [1, 2].every(h => isAirish(bot.blockAt(new Vec3(cx, y0 + h, cz))))
      if (!open) continue
      for (let y = y0 + 4; y <= y0 + 14 && !over; y++) { const b = bot.blockAt(new Vec3(cx, y, cz)); if (b && b.name === 'end_stone') over = true }
    }
    if (over) { log('остров нависает над платформой — с платформы не бросать'); return { hops: 0, pearls: 0, hpLost: 0, misses: 0, secs: 0, stop: 'остров над платформой' } }
  }
  if (under && under.name === 'obsidian') {
    const world = pearlHop.worldOf(bot)
    const feet = new Vec3(Math.floor(me.x) + 0.5, Math.floor(me.y + 0.01), Math.floor(me.z) + 0.5)
    const o = { floorOk, avoid, obstacles: pearlHop.obstaclesOf(bot) }
    if (!pearlHop.planHop(world, feet, goal, o).plan) {
      for (let k = 2; k <= 16; k += 2) {
        // столб — только в открытое небо (сид с сушей над платформой: «потолок end_stone»)
        let open = true
        for (let y = feet.y; y <= feet.y + k + 1 && open; y++) { const b = world(Math.floor(feet.x), y, Math.floor(feet.z)); if (!b || b.boundingBox !== 'empty') open = false }
        if (!open) break
        const r = pearlHop.planHop(world, feet.offset(0, k, 0), goal, o)
        if (r.plan) { rise = { k, to: r.plan.feet }; break }
      }
      if (!rise) { log('нет броска ни с платформы, ни со столба до +16'); return { hops: 0, pearls: 0, hpLost: 0, misses: 0, secs: 0, stop: 'нет броска' } }
      if (countOf(bot, FILLER_RE) < rise.k + 6) { log('на столб мало блоков'); return null }
      const inner = platformInner(bot)
      if (inner && Math.hypot(inner.x - bot.entity.position.x, inner.z - bot.entity.position.z) > 0.3) await stepTo(bot, ctl, inner, { ms: 2500, sprint: false, stopAt: 0.2 })
      doing(ctl, 'pearl:rise')
      const t0 = gameClock.now()
      const t = await fastTower(bot, ctl, Math.floor(bot.entity.position.y + 0.01) + rise.k, { maxMs: 15000, abortIf: () => angryEndermen(bot, 3).length ? 'эндермен рядом' : null })
      rise.ok = t.ok; rise.ms = gameClock.now() - t0
      log('столб +' + rise.k + ' для броска: ' + (t.ok ? 'ок' : t.why) + ' за ' + rise.ms + ' мс')
      doing(ctl, 'pearl')
    }
  }
  log(`подход: от ${Math.round(me.x)},${Math.round(me.y)},${Math.round(me.z)} к ${goalWhy} ${goal.x.toFixed(1)},${goal.y},${goal.z.toFixed(1)}, жемчуга ${countOf(bot, /^ender_pearl$/)}, хп ${Math.round(bot.health)}`)
  const out = await pearlHop.hopTo(bot, goal, {
    reserve,
    hpMin: Number(process.env.ND_PEARL_HPMIN ?? 11),
    maxHops: Number(process.env.ND_PEARL_MAX ?? 3),
    arriveR: 5,
    floorOk,
    avoid,
    lookOk: (y, pt) => !starer(bot, y, pt),
    abortIf: () => ctl.aborted,
    log
  })
  out.goal = goalWhy
  // 02.10 (rs4-s1): жемчуг лёг в стену — тело в блоке, «in_wall» 15 раз за 10 с, пока бот ел (pearl:heal). Сперва выбраться.
  if (out.hops && embeddedNow(bot)) { out.embedded = (embeddedNow(bot) || {}).name; await unembed(bot, ctl) }
  // К станции — не с просевшим хп (01.10): после бросков поесть и дождаться регенерации (до 8 с, пока дракон не заходит).
  if (out.hops && bot.health < 19 && !ctl.aborted) {
    const hp0 = bot.health; const t0 = gameClock.now()
    const busy = () => { const dd = dragonOf(bot); const ph = dd ? phaseOf(bot, dd) : null; return ph === PHASE.APPROACH || ph === PHASE.LANDING || ph === PHASE.STRAFE || ph === PHASE.CHARGING || hunters(bot, 6).length > 0 || !!embeddedNow(bot) }
    if (!busy()) {
      doing(ctl, 'pearl:heal')
      try { await pearlHop.recover(bot, 19.5, 8000, busy) } catch {}
      out.healed = { from: r1(hp0), to: r1(bot.health), ms: gameClock.now() - t0 }
      log(`после бросков: хп ${r1(hp0)} → ${r1(bot.health)} за ${gameClock.now() - t0} мс`)
    }
  }
  if (rise) out.rise = rise
  if (ctl.trace) ctl.trace.ev('pearl', { goal: [r1(goal.x), goal.y, r1(goal.z)], ...out })
  log(`итог: бросков ${out.hops}, жемчуга ${out.pearls}, хп −${out.hpLost}, промахов ${out.misses}, ${Math.round(out.ms / 100) / 10} с; стоп: ${out.stop || '-'}`)
  return { hops: out.hops, pearls: out.pearls, hpLost: out.hpLost, misses: out.misses, secs: Math.round(out.ms / 100) / 10, saved: out.saved, stop: out.stop, rise: rise || undefined, steps: out.steps }
}

// Лаборатория взрыва кровати (try-lab-dragon-blast.js, только ферма). labPlan — план станции (pillarPlanAutoAsync) по
// нетронутому миру под плечо arm; клетки отдаются сцене, она ставит их командами. labRun — станция «построена» по плану
// плеча: тело уже в окопе (сцена ставит), ждёт снижения и делает одну цепочку pillarRun — как в бою. p.env — переключатели
// гипотезы на этот вызов (LABENV).
const LAB_PLANS = new Map()
function labCells (pp) {
  const cells = []
  for (const c of pp.supCob || []) cells.push([...c, 'cobblestone'])
  for (const c of pp.sup || []) cells.push([...c, 'obsidian'])
  if (pp.place.obsidian) cells.push([pp.place.K.x, pp.place.K.y, pp.place.K.z, 'obsidian'])
  for (const o of pp.obs || []) cells.push([...o, 'obsidian'])
  for (const c of pp.labExtra || []) cells.push(c)
  const dig = []
  for (let k = 1; k <= pp.dig; k++) dig.push([pp.B.x, pp.G - k, pp.B.z, 'air'])
  return { P: pp.P, H: [pp.H.x, pp.yb, pp.H.z], F: [pp.F.x, pp.yb, pp.F.z], B: [pp.B.x, pp.B.z], feet: [pp.feet.x, pp.feet.y, pp.feet.z], G: pp.G, dig: pp.dig, seen: pp.seen, expo: pp.expo, nObs: pp.nObs, cells: [...dig, ...cells] }
}
async function dragonLab (session, ctl, stats, p, mode, deadline) {
  const bot = session.bot
  const arm = String(p.arm || 'A')
  for (const k of Object.keys(LABENV)) delete LABENV[k]
  Object.assign(LABENV, p.env || {})
  try {
    if (mode === 'labPlan') {
      const P0 = podiumTop(bot)
      if (P0 == null) return { stop: 'нет вершины столба' }
      const t0 = gameClock.now()
      const pp = runnerOn() ? runnerPlan(bot, P0) : await pillarPlanAutoAsync(bot, P0)
      LAB_PLANS.set(arm, pp)
      if (!pp) return { stop: 'плана нет', why: pillarPlan.why, P: P0 }
      return { arm, ms: gameClock.now() - t0, plan: labCells(pp) }
    }
    const plan = LAB_PLANS.get(arm)
    if (!plan) return { stop: `нет плана плеча ${arm}` }
    ctl.pillar = { plan, built: true, t: gameClock.now(), booms: 0 }
    ctl.bedsOnly = true; ctl.pillarMode = true
    const feed = ctl.feed || (ctl.feed = makeDragonFeed(bot))
    const track = makeTrack(bot)
    const t0 = gameClock.now()
    const tEnd = Math.min(deadline, gameClock.now() + (p.waitSeconds ?? 60) * 1000)
    let run = null; let entered = 0
    while (!ctl.aborted && gameClock.now() < tEnd) {
      track.tick()
      const d = dragonOf(bot)
      const ph = d ? phaseOf(bot, d) : null
      if (ph === PHASE.LANDING) { run = await pillarRun(session, ctl, stats, track, feed); break }
      if (ph === PHASE.APPROACH && !pillarHere(bot, plan)) { entered++; doing(ctl, 'pillar:enter'); await pillarEnter(session, ctl, plan) }
      await sleep(50)
    }
    const me = bot.entity.position
    return { arm, run, beds: stats.beds, entered, ms: gameClock.now() - t0, hp: r1(bot.health), at: [r1(me.x), r1(me.y), r1(me.z)], inTrench: !!pillarHere(bot, plan), ...(run ? {} : { stop: 'снижения не было' }) }
  } finally {
    for (const k of Object.keys(LABENV)) delete LABENV[k]
  }
}

async function dragon (session, ctl, p = {}) {
  const bot = session.bot
  const mode = p.mode || 'beds'
  const started = gameClock.now()
  const deadline = started + Math.min(600, p.timeoutSeconds ?? 300) * 1000 - 5000
  const hp0 = Math.round(bot.health)
  const rep = {
    mode,
    crystals: { seen: 0, destroyed: 0, left: null, notes: [] },
    dragon: {},
    // Секунды от начала вызова: кристаллы сбиты, дракон убит.
    timing: {}
  }
  const stats = { arrows: 0, crystals: 0, melee: 0, dmg: 0, arrowHits: 0, headShots: 0, perches: [], phases: [], dodges: {}, endermen: 0, ate: [], hid: [], noSpot: 0, guarded: 0, beds: [] }
  const kit = kitOf(bot)
  rep.kit = kit
  // «20 -> 20» после смерти — ложь разности (грабли прогонов): после
  // возрождения снова двадцать. Смерть — отдельным свидетелем.
  let died = false
  const onDeath = () => { died = true; clearCrystalKnowledge(bot) }
  const report = (stopped) => {
    const d = dragonOf(bot)
    rep.hp = died ? `${hp0} -> УМЕР` : `${hp0} -> ${Math.round(bot.health)}`
    if (died) rep.died = true
    rep.seconds = Math.round((gameClock.now() - started) / 1000)
    // Счёт — только из Энда: после смерти тело в верхнем мире и «видит» ноль.
    if (/end/.test(bot.game.dimension)) rep.crystals.left = crystalsOf(bot).filter(c => c.pillar).length
    rep.crystals.destroyed = stats.crystals
    rep.crystals.arrows = stats.arrows
    // кристаллы с места ожидания (crystalWait, 03.10): стрел, сбито своими, переходов к точке выстрела, живых по памяти боя
    if (ctl.crys && ctl.crys.known.size) rep.crystals.wait = { shots: ctl.crys.shots, hits: ctl.crys.hits, moves: ctl.crys.moves, alive: crysAlive(ctl), known: ctl.crys.known.size, first: ctl.crys.firstShot ? Math.round((ctl.crys.firstShot - started) / 1000) : null }
    if (d) { rep.dragon.hp = Math.round(hpOf(bot, d) ?? 0); rep.dragon.phase = PHASE_RU[phaseOf(bot, d)] ?? null }
    rep.dragon.melee = { swings: stats.melee, perches: stats.perches.filter(x => x.reached).length, byPerch: stats.perches.filter(x => x.reached).slice(-6).map(({ dbgAt, ...x }) => ({ ...x, dmg: Math.round(x.dmg) })) }
    rep.dragon.arrows = { shot: stats.arrows, hits: stats.arrowHits, atHead: stats.headShots }
    if (stats.stationNone && !stats.stations) rep.dragon.stationNone = stats.stationNone
    if (stats.beds.length || stats.bedNoPlan) rep.dragon.beds = { used: stats.bedsUsed || 0, blasts: stats.beds.slice(-6), noPlan: stats.bedNoPlan }
    rep.dragon.dmgSeen = Math.round(stats.dmg)
    rep.dragon.phases = stats.phases.slice(-20)
    rep.dodged = stats.dodges
    rep.endermen = { fought: stats.endermen, killed: stats.endermenKilled || 0, lookGuard: stats.guarded }
    if (stats.ate.length) rep.ate = stats.ate
    if (stats.hid.length) rep.hid = stats.hid
    if (stats.potions && stats.potions.length) rep.potions = stats.potions
    if (stats.clutch && Object.keys(stats.clutch).length) rep.clutch = stats.clutch
    if (stopped) rep.stopped = stopped
    // Станция у столба построена в этом вызове — секунды от его начала (сцена складывает по вызовам).
    if (ctl.pillar && ctl.pillar.built && ctl.pillar.t >= started) rep.timing.station = Math.round((ctl.pillar.t - started) / 100) / 10
    if (rep.leftEnd && !rep.stopped) rep.stopped = `тело ушло из Энда само (${rep.leftEnd}) — бой прерван`
    if (!rep.crystals.notes.length) delete rep.crystals.notes
    return rep
  }
  if (!/end/.test(bot.game.dimension)) throw new Error(`я не в Энде (${bot.game.dimension}): бой с драконом — в Энде, сначала портал`)

  if (mode === 'look') {
    const d = dragonOf(bot)
    rep.dragon = d ? { hp: Math.round(hpOf(bot, d) ?? 0), phase: PHASE_RU[phaseOf(bot, d)], at: { x: Math.round(d.position.x), y: Math.round(d.position.y), z: Math.round(d.position.z) } } : { seen: false }
    rep.crystals = { seen: crystalsOf(bot).filter(c => c.pillar).map(c => ({ x: c.cx, y: c.top + 1, z: c.cz, caged: c.bars > 0, dist: Math.round(c.pos.distanceTo(bot.entity.position)) })) }
    const me = bot.entity.position
    rep.fromCenter = Math.round(Math.hypot(me.x - CENTER.x, me.z - CENTER.z))
    rep.portal = portalBlocks(bot).length > 0
    rep.note = 'кристаллы видно только с 64 блоков — список полный лишь у центра острова'
    if (p.around) {
      // Для разбора: срез блоков вокруг (сцены), по слою на высоту.
      const c = me.floored()
      rep.pos = { x: +me.x.toFixed(2), y: +me.y.toFixed(2), z: +me.z.toFixed(2), onGround: bot.entity.onGround, vehicle: bot.vehicle ? (bot.vehicle.name || bot.vehicle.id) : null, physics: bot.physicsEnabled }
      rep.around = {}
      for (let dy = -2; dy <= 2; dy++) {
        const rows = []
        for (let dz = -3; dz <= 3; dz++) {
          let row = ''
          for (let dx = -3; dx <= 3; dx++) {
            const b = bot.blockAt(c.offset(dx, dy, dz))
            row += !b ? '?' : b.name === 'air' ? '.' : b.name === 'end_stone' ? 'e' : b.name === 'cobblestone' ? 'c' : b.name === 'obsidian' ? 'o' : b.name[0].toUpperCase()
          }
          rows.push(row)
        }
        rep.around[`y${c.y + dy}`] = rows.join('|')
      }
    }
    return rep
  }

  const me0 = bot.entity.position
  let at = null
  if (Math.hypot(me0.x - CENTER.x, me0.z - CENTER.z) < 40) {
    const cr = crystalsOf(bot).filter(c => c.pillar)
    at = { crystals: cr.length, caged: cr.filter(c => c.bars > 0).length }
  }
  // На острове (под ногами не пустота) блоки добываются киркой — повторный
  // вызов не отказывает за булыжник (camp1: «cobblestone 6/44» у клетки в 40
  // блоках от центра, бой стоял).
  const onIsland = !voidBelow(bot, me0.x, me0.y, me0.z, 60)
  const need = missing(kit, mode, crystalKitState(bot, at, onIsland))
  if (need.length) {
    rep.need = need[0]
    rep.needAll = need
    rep.stopped = `не хватает снаряжения: ${need.map(n => `${n.what} ${n.have}/${n.count}`).join(', ')} — ни шагу не сделал`
    return rep
  }

  ctl.deadline = deadline
  ctl.started = started
  ctl.stats = stats
  // Кровати у головы — по умолчанию, если они в рюкзаке; beds:false — только меч.
  ctl.beds = p.beds !== false || mode === 'beds'
  ctl.bedsOnly = mode === 'beds'
  ctl.noRise = p.rise === false
  bot.on('death', onDeath)
  // Полуширина хитбокса как у сервера (0.6f / 2), а не 0.3: иначе тело,
  // упёршееся в ступеньку, залезает в блок на 1.2e-8, и сервер молча отбивает
  // каждый шаг назад (handleMovePlayer → hasNewCollision → CLIPPED_INTO_BLOCK).
  // Проверено голым mineflayer: 245 откатов за 15 с против нуля.
  if (bot.physics) bot.physics.playerHalfWidth = Math.fround(0.6) / 2
  // Взгляд уходит серверу сразу, без доворота. mineflayer шлёт не
  // bot.entity.yaw/pitch, а lastSentYaw/Pitch, которые догоняют их по 0.15 рад
  // за тик (physics.js updatePosition, yawSpeed = pitchSpeed = 3.0): сторож
  // взгляда проверял цель, а сервер видел промежуточные углы, и поворот с
  // кристалла на дорогу мог пройти сквозь глаза эндермена. С мгновенным
  // взглядом сторож проверяет ровно то, что уйдёт в пакет.
  const lookSpeed = bot.physics ? [bot.physics.yawSpeed, bot.physics.pitchSpeed] : null
  if (bot.physics) { bot.physics.yawSpeed = 1000; bot.physics.pitchSpeed = 1000 }
  const unguard = lookGuard(bot, stats)
  const unfall = fallGuard(bot, stats, ctl)
  const uncloud = cloudReflex(bot, ctl, stats)
  const unhit = hitTracker(bot)
  const unfb = fireballTracker(bot)
  const unalarm = fireballAlarm(bot, ctl, stats)
  const trace = makeTrace(bot, ctl, stats)
  ctl.trace = trace
  // Кто оборвал вызов (camp1: бой кончился «done» без причины на 175 с —
  // кто-то снял намерение). Стек — в трассу.
  ctl.onAbort.push(() => trace.ev('aborted', { by: String(new Error().stack).split('\n').slice(2, 8).map(s => s.trim().replace(/^at /, '').replace(/\(.*[\\/]/, '(')).join(' < ') }))
  if (trace.file) rep.trace = trace.file
  // Ушёл из Энда не домой (соскользнул в выходной портал, умер) — всё
  // остановить: бой, продолжающийся в верхнем мире, бьёт эндерменов ночью.
  const onRespawn = () => {
    if (ctl.homeBound || /end/.test(bot.game.dimension)) return
    rep.leftEnd = bot.game.dimension
    try { ctl.abort() } catch {}
  }
  bot.on('respawn', onRespawn)
  const taps = DEBUG ? ['mount', 'dismount', 'respawn', 'death', 'forcedMove'].map(ev => { const f = () => dbg('event', ev, bot.entity.position.toString()); bot.on(ev, f); return () => bot.removeListener(ev, f) }) : []
  if (DEBUG) {
    // Что мы слали серверу перед тем, как он вернул нас назад (отбой шага).
    const sent = []
    const origWrite = bot._client.write
    bot._client.write = function (name, params) {
      if (/^position/.test(name) || name === 'flying') {
        sent.push(`${name} ${params.x !== undefined ? `${params.x.toFixed(4)},${params.y.toFixed(4)},${params.z.toFixed(4)}` : ''} g${params.onGround ?? (params.flags && params.flags.onGround)}`)
        if (sent.length > 4) sent.shift()
      }
      return origWrite.apply(this, arguments)
    }
    taps.push(() => { bot._client.write = origWrite })
    let lastLog = 0
    const f = pk => {
      if (gameClock.now() - lastLog < 3000) return
      lastLog = gameClock.now()
      dbg('server pos', pk.x.toFixed(4), pk.y.toFixed(4), pk.z.toFixed(4), 'tp', pk.teleportId, 'sent:', sent.join(' | '))
    }
    bot._client.on('position', f)
    taps.push(() => bot._client.removeListener('position', f))
  }
  const onAbort = () => clearControls(bot)
  ctl.onAbort.push(onAbort)
  try {
    await armor.equipBestArmor(session, ctl).catch(() => {})
    // Вырезанная тыква на голове — эндермены не злятся на взгляд
    // (EnderMan.isBeingStaredBy: тыква на голове → false). Цена — шлем, поэтому
    // только по просьбе (pumpkin: true) или когда шлема нет вовсе.
    const pumpkin = findItem(bot, /^carved_pumpkin$/)
    const headNow = bot.inventory.slots[5]
    if (pumpkin && (p.pumpkin === true || (!headNow && p.pumpkin !== false))) {
      try { await bot.equip(pumpkin, 'head'); rep.pumpkin = true } catch (e) { rep.pumpkin = `не надел: ${e.message}` }
    }
    rep.waterReady = await waterToHotbar(bot)
    if (mode === 'labPlan' || mode === 'labRun') {
      rep.lab = await dragonLab(session, ctl, stats, p, mode, deadline)
      return report(rep.lab && rep.lab.stop ? rep.lab.stop : null)
    }
    if (mode === 'respawn') {
      clearCrystalKnowledge(bot)
      rep.respawn = await respawnDragon(session, ctl, rep)
      if (rep.respawn.need) rep.need = rep.respawn.need
      return report(rep.respawn.started ? null : `не воскресил: ${rep.respawn.why || 'поставил ' + rep.respawn.placed + ' из 4'}`)
    }
    if (mode === 'home') {
      if (p.egg !== false) rep.egg = await takeEgg(session, ctl, rep)
      rep.home = await goHome(session, ctl, rep)
      return report(rep.home.home ? null : `домой не ушёл: ${rep.home.why || rep.home.walk || 'портал не сработал'}`)
    }
    // Жемчуг (2026-10-01): с платформы — броском к станции у столба вместо моста и пешего пути, если
    // выходит быстрее с ценой хп (pearl-hop.js). ND_PEARL=0 или p.pearl === false — выкл.
    const pearlOn = (mode === 'beds' || mode === 'full' || mode === 'dragon') && p.pearl !== false && process.env.ND_PEARL !== '0'
    // Подход жемчугом и сводка по всем попыткам вызова (платформа, край острова после моста, на ходу к центру).
    const pearlStep = async (where) => {
      const ph = await pearlApproach(session, ctl, stats)
      if (!ph) return null
      const was = rep.pearl
      rep.pearl = was ? { ...ph, hops: was.hops + ph.hops, pearls: was.pearls + ph.pearls, hpLost: r1(was.hpLost + ph.hpLost), misses: was.misses + ph.misses, secs: r1(was.secs + ph.secs), steps: [...(was.steps || []), ...(ph.steps || [])], where: [...(was.where || []), where] } : { ...ph, where: [where] }
      if (ph.hops) rep.timing.pearl = Math.round((gameClock.now() - started) / 100) / 10
      return ph
    }
    if (pearlOn) await pearlStep('платформа')
    if (ctl.aborted) return report()
    // Прибыть: с платформы или издалека — мост к острову, потом к центру.
    // Стоим над пустотой (платформа, свой мост, столб на платформе) — мост к
    // острову. Опора — под хитбоксом, а не под центром (ab-23).
    const sup = supportCell(bot)
    if (sup && bot.blockAt(sup).name !== 'end_stone' && offIsland(bot, sup)) {
      const b = await bridgeToIsland(session, ctl, rep)
      // Платформа внутри острова (сид с сушей у x = 100: «потолок end_stone», «впереди не
      // пройти» — oc4-22): остров здесь — к центру напролом (копать/мостить), а не отказ.
      // (Напролом из-под потолка с платформы — нельзя: oc8-28, burrowTo с обсидиановой
      // платформы копнул вниз — падение в пустоту. Сид с сушей над платформой — отказ, как было.)
      if (b.stopped && !b.land) {
        // Отказ повторят через пару секунд — не стоять при этом в облаке на платформе.
        const c0 = inClouds(cloudsOf(bot), bot.entity.position, 1)
        if (c0) await evade(bot, ctl, stats, { kind: 'облако', c: c0 }).catch(() => {})
        return report(`мост не дошёл до острова: ${b.stopped}`)
      }
    }
    if (ctl.aborted) return report()
    // Жемчуг с края острова (мост дошёл; с платформы броска не было — далеко/обрыв): к станции броском.
    if (pearlOn && !(rep.pearl && rep.pearl.hops)) await pearlStep('край')
    if (ctl.aborted) return report()
    // До центра: pathfinder, а не вышло — напролом (копать, мостить).
    const toCenter = async () => {
      const m = bot.entity.position
      if (Math.hypot(m.x - CENTER.x, m.z - CENTER.z) <= 25) return null
      const sup0 = supportCell(bot)
      if (sup0 && !offIsland(bot, sup0) && Math.hypot(m.x - CENTER.x, m.z - CENTER.z) < 45) return null
      // На ходу (раз в 2 с): бросок к станции стал выгоден — встать и бросить (s23/s24 pp1: платформа под обрывом,
      // с неё не бросить, а пешком к центру 60–70 с).
      let pearlAt = 0
      const pearlStop = pearlOn && (ctl.pearlWalkStops || 0) < 3 ? () => {
        if (gameClock.now() - pearlAt < 2000 || !bot.entity.onGround) return null
        pearlAt = gameClock.now()
        const mm = bot.entity.position
        if (Math.hypot(mm.x - CENTER.x, mm.z - CENTER.z) < 35) return null
        const under = bot.blockAt(mm.floored().offset(0, -1, 0))
        if (!under || under.name !== 'end_stone') return null
        // 03.10 (ca1-s10): в своём прокопе под островом бросок «на ходу» трижды бился о потолок («не перенесло», −3.4 хп
        // каждый) — бросать только под открытым небом (над головой на 12 блоков нет твёрдого)
        for (let k = 2; k <= 12; k++) { const b = bot.blockAt(mm.floored().offset(0, k, 0)); if (b && isSolid(b)) return null }
        const goal = ctl.pearlGoal || new Vec3(CENTER.x + (mm.x - CENTER.x) * 8 / Math.hypot(mm.x - CENTER.x, mm.z - CENTER.z), mm.y, CENTER.z + (mm.z - CENTER.z) * 8 / Math.hypot(mm.x - CENTER.x, mm.z - CENTER.z))
        const hw = pearlHop.hopWorth(bot, goal, { reserve: Number(process.env.ND_PEARL_RESERVE ?? 1), hpMin: Number(process.env.ND_PEARL_HPMIN ?? 11), floorOk: (b) => b.name === 'end_stone', avoid: (f) => Math.hypot(f.x - CENTER.x, f.z - CENTER.z) < 4.5, lookOk: (y, pt) => !starer(bot, y, pt) })
        return hw.go ? 'жемчуг' : null
      } : null
      // 03.10 (пользователь видел тоннель на слоте 1, rs17-s8 22:05: платформа внутри острова — walkTo 30 с, потом burrowTo
      // прокопом на уровне платформы x 100 → 55 за 180 с; «остров над платформой» — 55 из 244 боёв rs13–vdr6, центр p50 ~80 с,
      // до 230 с): остров над головой — сперва шахта вверх из середины платформы (digUpThrough, 4–8 бл. за 5–11 с), потом бег
      // поверху, жемчуг (сверх резерва) — «на ходу» под открытым небом. ca2 на этих сидах: центр 21–41 с, станция 29–45 с (rs18/19:
      // станция 38–220, p50 ~116). ND_DIGUP_FIRST=0 — как было (шахта только над пустотой, после отказа пути).
      if (envv('ND_DIGUP') !== '0' && envv('ND_DIGUP_FIRST') !== '0' && !ctl.digUpFirst) {
        const f0 = bot.entity.position.floored()
        let ceil = false
        for (let k = 2; k <= 7 && !ceil; k++) { const b = bot.blockAt(f0.offset(0, k, 0)); if (b && b.name === 'end_stone') ceil = true }
        if (ceil) {
          ctl.digUpFirst = true
          doing(ctl, 'to-center:dig-up')
          const t0u = gameClock.now()
          const up = await digUpThrough(session, ctl)
          up.ms = gameClock.now() - t0u; up.first = true
          if (ctl.trace) ctl.trace.ev('digUp', up)
          // бросок сразу с верха шахты дважды «не перенесло» (cp1-s7, ca1-s5: −5…6 с) — жемчуг только «на ходу», под открытым небом
          if (ctl.aborted) return { walk: 'прервано', up }
          doing(ctl, 'to-center')
          return toCenter()
        }
      }
      // над пустотой (свой мост, платформа) — без копки: pathfinder рыл нависший остров с моста в блок шириной, тело в воздухе
      // «перед копкой» ушло за край (rs6-s18, смерть). Не прошёл без копки — отказ ниже, напролом не идти.
      // 03.10: бегом (sprint) и с дорогой копкой (digCost) — поверху, а копать только если иначе никак (ND_CENTER_RUN=0 — как было).
      const runC = envv('ND_CENTER_RUN') !== '0'
      const supW = supportCell(bot); const overVoid = !!(supW && offIsland(bot, supW))
      const w = await walkTo(session, ctl, new Vec3(CENTER.x, m.y, CENTER.z), { range: 18, xz: true, timeoutMs: 30000, stopIf: pearlStop, noDig: overVoid, sprint: runC, digCost: runC ? envNum('ND_CENTER_DIGCOST', 4) : 1 })
      if (w.stopped && w.why === 'жемчуг') {
        ctl.pearlWalkStops = (ctl.pearlWalkStops || 0) + 1
        clearControls(bot)
        await pearlStep('на ходу')
        doing(ctl, 'to-center')
        return toCenter()
      }
      if (w.ok) return { walk: 'дошёл' }
      // 02.10 (rs6-s18, смерть): мост с платформы под нависшим островом («потолок end_stone»), pathfinder рыл остров с моста над
      // пустотой — в прыжке «перед копкой» тело ушло за край. Сперва площадка 3×3 вокруг опоры (сорваться некуда), потом путь с
      // копкой и напролом; площадку не сложить — отказ (rs7-s5: без копки отказ сразу, бой потерян).
      const supV = supportCell(bot)
      // 02.10 (rs10-s7, rs11-s7, сид пула 9123766181046481267): платформа под нависшим островом — мост упирается в «потолок
      // end_stone», жемчугом с неё нельзя, площадка у края не складывается — бой терялся без боя. Остров над головой: с середины
      // платформы (обсидиан 5×5 под ногами — падать некуда) вверх шахтой 1×1 — копать над головой и ставить блок под себя,
      // пока не встанем на остров под открытым небом; дальше к центру пешком.
      if (supV && offIsland(bot, supV) && envv('ND_DIGUP') !== '0') {
        const up = await digUpThrough(session, ctl)
        if (ctl.trace) ctl.trace.ev('digUp', up)
        // шахта поднялась хоть на 3 (rs13-s7: 5 блоков вверх, дальше столб не встал — второй вызов пошёл оттуда пешком и дошёл) — идти
        if (up.ok || up.up >= 3) {
          const w3 = await walkTo(session, ctl, new Vec3(CENTER.x, bot.entity.position.y, CENTER.z), { range: 18, xz: true, timeoutMs: 45000, stopIf: pearlStop, sprint: runC, digCost: runC ? envNum('ND_CENTER_DIGCOST', 4) : 1 })
          if (w3.ok) return { walk: 'дошёл через остров над платформой', up }
          const sv3 = supportCell(bot)
          if (!(sv3 && offIsland(bot, sv3))) return { walk: w3.why, burrow: await burrowTo(session, ctl, new Vec3(CENTER.x, bot.entity.position.y, CENTER.z), { near: 18 }), up }
        }
      }
      if (supV && offIsland(bot, supV)) {
        const pad = await padOverVoid(bot, supV)
        if (ctl.trace) ctl.trace.ev('voidPad', pad)
        if (!pad.ok) { ctl.voidStop = true; return { walk: w.why, burrow: { ok: false, why: 'над пустотой — площадку не сложить' } } }
        const w2 = await walkTo(session, ctl, new Vec3(CENTER.x, m.y, CENTER.z), { range: 18, xz: true, timeoutMs: 45000, stopIf: pearlStop, sprint: runC, digCost: runC ? envNum('ND_CENTER_DIGCOST', 4) : 1 })
        if (w2.ok) return { walk: 'дошёл с площадки', pad }
        const sv2 = supportCell(bot)
        if (sv2 && offIsland(bot, sv2)) { ctl.voidStop = true; return { walk: w2.why, burrow: { ok: false, why: 'над пустотой — напролом нельзя' } } }
      }
      const b = await burrowTo(session, ctl, new Vec3(CENTER.x, m.y, CENTER.z), { near: 18 })
      return { walk: w.why, burrow: b }
    }
    if (mode === 'arrive') {
      rep.approach = await toCenter()
      const spot = pickSpot(bot, CENTER, { rMin: 8, rMax: 18 })
      if (spot) rep.walk = await walkTo(session, ctl, spot.feet, { range: 1.5, timeoutMs: 60000, stats })
      const m = bot.entity.position
      rep.fromCenter = Math.round(Math.hypot(m.x - CENTER.x, m.z - CENTER.z))
      return report(rep.fromCenter > 25 ? `до центра острова не дошёл: ${rep.walk ? rep.walk.why : 'нет места'}` : null)
    }
    doing(ctl, 'to-center')
    if (mode === 'full' || mode === 'crystals' || mode === 'dragon' || mode === 'beds') rep.approach = await toCenter()
    if (ctl.voidStop) { const sv = supportCell(bot); if (sv && offIsland(bot, sv)) return report('до центра острова не дошёл: над пустотой, напролом нельзя') }
    {
      const m = bot.entity.position
      if (Math.hypot(m.x - CENTER.x, m.z - CENTER.z) < 30) rep.timing.center = Math.round((gameClock.now() - started) / 100) / 10
    }
    if (mode === 'full' || mode === 'crystals') {
      await destroyCrystals(session, ctl, rep, stats, { deadline })
      noteCrystalClear(bot, rep.crystals)
      if (!ctl.aborted && /end/.test(bot.game.dimension) && rep.crystals.left === 0) rep.timing.crystals = Math.round((gameClock.now() - started) / 1000)
      if (ctl.aborted) return report()
      if (mode === 'crystals') return report(rep.crystals.left ? `кристаллов осталось ${rep.crystals.left}` : null)
    }
    if (mode === 'beds' && !ctl.feed) { ctl.feed = makeDragonFeed(bot) }
    // Станция у столба — по умолчанию, если в рюкзаке обсидиан (fightkit end: ≥ 4; станции нужно 2): ND_PILLAR=0 — выкл.,
    // ND_PILLAR=1 — вкл. и без него. С ней яма для слепого не нужна (pil4/pil5: ND_BEDS_BLIND=0).
    ctl.pillarMode = mode === 'beds' && (process.env.ND_PILLAR === '1' || (process.env.ND_PILLAR !== '0' && (runnerOn() || countOf(bot, /^(obsidian|crying_obsidian)$/) >= 2)))
    if (mode === 'beds' && process.env.ND_BEDS_BLIND !== '0' && !ctl.pillarMode) await blindPit(session, ctl, stats, deadline)
    await fightDragon(session, ctl, rep, stats, { deadline, perches: p.perches || 0 })
    if (ctl.aborted) return report()
    if (!rep.dragon.won) {
      return report(gameClock.now() >= deadline ? 'время вышло — позови mc_dragon ещё раз, продолжит с того места' : (rep.dragon.lost || 'дракон жив'))
    }
    // Победа: опыт, яйцо, домой.
    await sleep(3000)
    rep.xp = await collectXp(session, ctl, 8000)
    if (p.egg !== false) rep.egg = await takeEgg(session, ctl, rep)
    if (p.home !== false) rep.home = await goHome(session, ctl, rep)
    return report()
  } catch (e) {
    rep.error = String((e && e.message) || e)
    // Где сорвалось — первые строки стека (без них «reading 'id'» не найти).
    if (e && e.stack) {
      rep.errorAt = String(e.stack).split('\n').slice(1, 5).map(l => l.trim().replace(/^at /, '').replace(/\(.*[\\/]/, '(')).join(' ← ')
      console.error('[dragon] сорвалось:', e.stack)
    }
    return report(`сорвалось: ${rep.error}`)
  } finally {
    if (ctl.feed) { ctl.feed.close(); ctl.feed = null }
    bot.removeListener('death', onDeath)
    for (const t of taps) t()
    unguard()
    unfall()
    uncloud()
    unhit()
    unfb()
    unalarm()
    if (bot.physics && lookSpeed) { bot.physics.yawSpeed = lookSpeed[0]; bot.physics.pitchSpeed = lookSpeed[1] }
    trace.close({ died, won: !!(rep.dragon && rep.dragon.won), stopped: rep.stopped || null })
    bot.removeListener('respawn', onRespawn)
    clearControls(bot)
    // Стоять, опустив голову: между вызовами сторожа взгляда нет, а
    // эндермен, попавший в прицел праздного взгляда, злится сам.
    if (bot.entity) bot.look(bot.entity.yaw, -1.3, true).catch(() => {})
    try { session.updateMovements(true) } catch {}
  }
}

module.exports = { pillarHere, pillarPlanAuto,
  dragon,
  // для сцен и разбора
  crystalWait, crystalTimingAllowed, earlyCrystalStep,
  dragonOf, phaseOf, hpOf, partsOf, crystalsOf, cloudsOf, breathOf, starer, safePitch, meleeSpot, kitOf, missing,
  noteCrystalClear, clearCrystalKnowledge, crystalKitState,
  makeTrack, crystalShotSpot, bridgeToIsland, fallGuard, waterToHotbar, fastTower, stationPlan, PHASE, PHASE_RU, PART, SITTING, KIT,
  floorAt, runwayAhead, stepKeys, straightOut, dragonZones, dangerAt, wingBoxes, islandEdgeTop, awayFromHead, cloudZones, stepIntoZone,
  supportCell, offIsland, escapeSpot, noteNear, blindKnown, STAY_R, SCAN_RANGE, straightWalkable, onSpike, sitState, PHASE_SIT: SITTING,
  onOwnPillar, meleeSpot, DAMAGE_TYPES, aboveCloudY,
  bedsLayout, bedClickPoint, hurtNear, bedDamage, BEDS_KIT, BED_GAP_MS, bedsDouble, cellsOnSeg, headAfterTakeoff, noteTakeoff, takeoffAzOf,
  simStep, simHead, simNeck, turnLanding, landingForecast, predParts, landingHits, yRotOf, msin, mcos, tsPlan, exposure, tsClickPoint,
  closestNode, findNodePath, takeoffNode, blastPush, takeoffForecast, tsSecond, blastReaches,
  holdingOdds, dragonWaitBand, dragonWaitStop,
  pillarPlan, pillarBuild, pillarRun, faceClick, scanPredict, tsAPlan, tsOwnPlan, tsOwnStation, tsAddStation, stationCells, blastDestroyed, stationWorld, pushedForecast
}
