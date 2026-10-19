'use strict'
import * as gameClock from '../../src/game-clock'
// «Я ещё в шахте?» — и что бывает, когда ответ неверный.
//
// mc_surface должен различать три места, которые сверху выглядят одинаково:
//
//   1. дно собственного колодца 1x1 глубиной 20, а над ним честное небо —
//      выйти отсюда можно только лесенкой, и лесенку надо вырубать в своей же
//      стене, потому что после смерти строить нечем;
//   2. ровная поверхность — тут копать нечего, и любой «подъём» отсюда это
//      столб в пустое небо (ровно на этом сгорел прогон try-diamond: бот стоял
//      на траве на y=80, ему сказали targetY=81, и он весь интент пытался
//      достроиться на два блока с пустым рюкзаком);
//   3. пещера под шестьюдесятью блоками камня — вылезти за один вызов нельзя,
//      и честный ответ «поднялся на N, позови ещё раз».
//
// Плюс поход за лутом с глубины: и отказ по арифметике (5 минут на дроп), и
// настоящая фаза спуска.
//
// Арены строятся в сплошном камне, чтобы природный рельеф не подмешивался.
// /fill не работает в непрогруженных чанках и отказывается делать больше 32768
// блоков — поэтому сначала /tp, пауза, и только потом заливка кусками.
import WebSocket = require('ws')

const ws = new WebSocket(process.env.ND_WS || 'ws://127.0.0.1:8765')
let id = 0
const pending = new Map()
const call = (method, params: any = {} as Record<string, any>) => new Promise<any>((resolve, reject) => {
  const rid = ++id
  pending.set(rid, { resolve, reject })
  ws.send(JSON.stringify({ id: rid, method, params }))
})

// Всё, что демон сказал за прогон. Собирается на транспорте, а не в месте
// проверки: шину опустошает ЛЮБОЙ ответ (session.js: result.events =
// this.bus.drain()), поэтому событие, приехавшее с ответом на pos() или на
// /give, иначе теряется навсегда.
const heard = []
const mark = () => heard.length
const since = (n, type?: any) => heard.slice(n).filter(e => !type || e.type === type)

ws.on('message', raw => {
  const m = JSON.parse(raw.toString()); gameClock.follow(m.clock || m.result?.state?.clock || m.result?.clock)
  const p = pending.get(m.id)
  if (!p) return
  pending.delete(m.id)
  if (m.ok && m.result && Array.isArray(m.result.events)) heard.push(...m.result.events)
  m.ok ? p.resolve(m.result) : p.reject(new Error(m.error))
})

const sleep = ms => gameClock.sleep(ms)
const pos = async () => ((await call('status')) as any).state.pos
const health = async () => ((await call('status')) as any).state.health

async function cmd (text) {
  await call('say', { text })
  await sleep(600)
}

async function step (label, method, params) {
  const r: any = await call(method, params).catch(e => ({ status: 'RPC', error: e.message }))
  const problem = r.status === 'failed' ? ` <- ${r.error}` : r.status === 'timeout' ? ' <- таймаут' : ''
  console.log(`${label.padEnd(28)} ${String(r.status).padEnd(11)} ${JSON.stringify(r.detail ?? null)}${problem}`)
  if (r.by) console.log(`${''.padEnd(28)} прервано: ${r.by.type}`)
  return r
}

let failures = 0
function check (what, ok, saw) {
  if (!ok) failures++
  console.log(`   [${ok ? ' OK ' : 'ПЛОХО'}] ${what}${saw === undefined ? '' : ` — вижу ${JSON.stringify(saw)}`}`)
}

// ------------------------------------------------------------------ арены

// Арены нарочно широкие: лесенка тратит блок в сторону на каждый уровень, и
// подъём с 20 метров уводит тело на 20 блоков вбок. Плита уже 30x30 кончалась
// раньше подъёма, и половина проверки шла бы по природному рельефу.
// Ровная каменная плита 44x44 с открытым небом. Верх плиты — y=79, стоят на
// y=80. В центре при желании пробит колодец 1x1 на 20 вниз.
async function plate ({ well = false, crypt = false }: any = {} as Record<string, any>) {
  await call('stop')
  await sleep(800)
  await cmd('/kill @e[type=!player]')
  await cmd('/gamerule spawn_mobs false')
  // Сложность объявляется здесь, а не наследуется. На peaceful сервер удаляет
  // призванного моба в следующий же тик, /summon при этом не жалуется, и случай
  // с мобом молча превращается в контрольный — то есть проходит, ничего не
  // проверив. Ровно это и случилось с (е): try-give.js ставит peaceful и не
  // возвращает обратно, а из трёх арен этого файла сложность заявляла только
  // drift(). Поэтому (ж), (з), (и), (к) и (л) были зелёными, а (е) — нет.
  await cmd('/difficulty normal')
  await cmd('/time set 6000')
  await cmd('/clear @s')
  await cmd('/tp @s 708 100 708')
  await sleep(3000) // чанки должны приехать раньше заливки
  // Второй kill: @e видит только прогруженные чанки, так что первый вычистил
  // арену, ИЗ которой мы ушли, а не эту. В двенадцати сценах из шестнадцати
  // было так же, и в try-buried это стоило двух ложных диагнозов.
  await cmd('/kill @e[type=!player]')
  // 22x21x44 = 20328 блоков на кусок: /fill молча отказывается от 32768.
  await cmd('/fill 686 59 686 707 79 729 minecraft:stone')
  await cmd('/fill 708 59 686 729 79 729 minecraft:stone')
  await cmd('/fill 686 80 686 707 100 729 minecraft:air')
  await cmd('/fill 708 80 686 729 100 729 minecraft:air')
  if (well) await cmd('/fill 708 60 708 708 79 708 minecraft:air')
  // Замурованная камера внутри плиты: умереть в ней можно, а вернуться —
  // только прокопавшись сверху.
  if (crypt) await cmd('/fill 698 66 698 704 68 704 minecraft:air')
}

// Глухой куб камня от y=10 до y=79 под такой же открытой поверхностью.
// Внутри — либо комната на глубине (случай «пещера»), либо камера под лут.
async function deep ({ room = false, chamber = false, lava = false, archer = false, cage = false, pocket = false }: any = {} as Record<string, any>) {
  await call('stop')
  await sleep(800)
  await cmd('/kill @e[type=!player]')
  await cmd('/gamerule spawn_mobs false')
  // Сложность объявляется здесь, а не наследуется. На peaceful сервер удаляет
  // призванного моба в следующий же тик, /summon при этом не жалуется, и случай
  // с мобом молча превращается в контрольный — то есть проходит, ничего не
  // проверив. Ровно это и случилось с (е): try-give.js ставит peaceful и не
  // возвращает обратно, а из трёх арен этого файла сложность заявляла только
  // drift(). Поэтому (ж), (з), (и), (к) и (л) были зелёными, а (е) — нет.
  await cmd('/difficulty normal')
  await cmd('/time set 6000')
  await cmd('/clear @s')
  await cmd('/tp @s 761 100 761')
  await sleep(3000)
  // Второй kill: @e видит только прогруженные чанки, так что первый вычистил
  // арену, ИЗ которой мы ушли, а не эту. В двенадцати сценах из шестнадцати
  // было так же, и в try-buried это стоило двух ложных диагнозов.
  await cmd('/kill @e[type=!player]')
  // 44x44x14 = 27104 на кусок.
  for (const [lo, hi] of [[10, 23], [24, 37], [38, 51], [52, 65], [66, 79]]) {
    await cmd(`/fill 740 ${lo} 740 783 ${hi} 783 minecraft:stone`)
  }
  await cmd('/fill 740 80 740 783 90 783 minecraft:air')
  await cmd('/fill 740 91 740 783 100 783 minecraft:air')
  // Комната 13x13: шире, чем радиус проверки «могу уйти пешком», поэтому
  // единственное, что держит бота внизу, — шестьдесят два блока потолка.
  if (room) await cmd('/fill 755 15 755 767 17 767 minecraft:air')
  if (chamber) await cmd('/fill 758 66 758 764 68 764 minecraft:air')
  if (archer) {
    // Две каморки и три блока сплошного камня между ними. Скелет сидит в
    // дальней: пять блоков по прямой, стрелять не во что, дойти нельзя.
    //
    // Ближняя нарочно длинная (11 клеток), и это не декорация. В каморке 5x5
    // стрелок за полторы секунды настройки подходил на два блока — то есть
    // внутрь CONTACT, где клетка под заслон занята им самим и правильный ответ
    // уже «бой, а не стена». Проверять на такой дистанции заслон нельзя: он там
    // и не должен ставиться. Одиннадцать клеток дают восемь блоков форы.
    await cmd('/fill 752 15 758 762 16 762 minecraft:air')
    await cmd('/fill 766 15 760 768 16 762 minecraft:air')
  }
  if (cage) {
    // Комната 5x5 вокруг тела — открытая, чтобы подъём ставил именно заслон, а
    // не стену штрека. Клетка 1x1x2 в восьми блоках к западу, и в комнату из неё
    // ведёт только щель высотой в блок (y=16): скелету, чтобы пройти, нужны две
    // клетки высоты, а чтобы видеть и стрелять — хватает одной. Глаз скелета на
    // 16.74, глаз бота на 16.62: оба внутри щели.
    await cmd('/fill 759 15 759 763 16 763 minecraft:air')
    await cmd('/fill 753 15 761 753 16 761 minecraft:air')
    await cmd('/fill 754 16 761 758 16 761 minecraft:air')
  }
  if (lava) {
    // Каморка 5x2, потолок сплошной, и ровно над головой — запечатанный в
    // камне блок лавы. Он никуда не течёт (все шесть соседей — камень), но
    // попадает в проверку «не копать рядом с лавой» и для клетки над головой,
    // и для клетки столба. Это та самая геометрия с y=-36: все четыре азимута
    // лестницы и столб упираются в один и тот же блок.
    await cmd('/fill 759 15 759 763 16 763 minecraft:air')
    await cmd('/setblock 761 18 761 minecraft:lava')
  }
  // Карман 1x1x2 в сплошном камне — дно лестницы, у которой все стены на месте:
  // вбок не шагнуть, а вода, если придёт сверху, никуда из него не утечёт. Воду
  // ставит сам случай и в свой момент, а не арена: тело должно стоять в кармане
  // раньше, чем она придёт, иначе /tp приносит его в уже затопленную клетку.
  if (pocket) await cmd('/fill 761 15 761 761 16 761 minecraft:air')
}

// «Проверить мир до замера» для воды. fair:false нарочно: вопрос «есть ли
// вода у тела», а не «видит ли её бот»; observe отдаёт по каждому виду блоков
// число и ближайший, с расстоянием от ног.
async function waterNear (radius = 3) {
  const r: any = await call('observe', { radius, fair: false }).catch(() => ({} as Record<string, any>))
  const w = ((r.detail || {} as Record<string, any>).blocks || []).find(b => b.name === 'water')
  return w ? { count: w.count, dist: w.dist, nearest: w.nearest } : { count: 0, dist: null }
}

// Штрек 1x2 на глубине -50 в сплошном дипслейте — форма, в которой стена
// вообще возможна: пол, потолок и обе стены уже есть, так что один столбик
// блоков закрывает проход целиком. Это та же геометрия, на которой стоят
// combat.sealCorridor и mining.sealOff, и та, в которой бот застрял на -51.
//
// Породы над штреком десять уровней, а не сто десять. Проверяется ход, а не
// выносливость: замерено 23 уровня лестницы за 120 с в камне, дипслейт вдвое
// твёрже, и сто уровней превратили бы каждый случай в одиннадцать минут
// ожидания. Глубина при этом настоящая — тело стоит на y=-50, вокруг дипслейт,
// кирка тратится по-настоящему.
//
//   штрек   x 826..839, z 820, y -50..-49   (тупик на западе, у тела за спиной)
//   стена   ожидается на 827,-50,820 и 827,-49,820
//   выход   верх плиты y=-40, встать можно на -39
const DRIFT = { x: 826, y: -50, z: 820, top: -39 }

async function drift ({ gravel = null, chamber = false }: any = {} as Record<string, any>) {
  await call('stop')
  await sleep(800)
  await cmd('/kill @e[type=!player]')
  await cmd('/gamerule spawn_mobs false')
  // На peaceful призванный моб исчезает в тот же тик, /summon при этом молчит,
  // и случай с мобом стал бы контрольным — прошёл бы, не проверив ничего.
  await cmd('/difficulty normal')
  await cmd('/time set 6000')
  await cmd('/clear @s')
  // Арена вырезается в чужом рельефе сверху вниз: телепорт роняет тело с
  // неизвестной высоты, а первая же заливка воздухом вынимает землю у него
  // из-под ног — от 90 до -39 это сто тридцать блоков падения. Сопротивление V
  // (amplifier 4) гасит и падение, и удушье; markHealth() снимает его ДО
  // отметки, иначе «выжил» не доказывало бы ничего.
  await cmd('/effect give @s minecraft:resistance 200 4 true')
  await cmd('/tp @s 821 90 821')
  await sleep(3000) // чанки должны приехать раньше заливки
  // Второй kill, и он не дубль. @e берёт сущности только в прогруженных
  // чанках, так что первый вызов вычистил арену, ИЗ которой мы ушли. Чужой
  // моб здесь — не шум: случаи (ж), (з) и (к) призывают своего, и подменить
  // его чужим значит померить что угодно, кроме того, что написано в проверке.
  await cmd('/kill @e[type=!player]')
  // 20x40x21 = 16800 на кусок: /fill молча отказывается от 32768.
  await cmd('/fill 802 -60 802 821 -40 841 minecraft:deepslate')
  await cmd('/fill 822 -60 802 841 -40 841 minecraft:deepslate')
  // Обечайка в один блок по четырём стенам колодца, и без неё арена неверна:
  // первый прогон встал на «вода у 833,-39,821 — туда не копаю» и ушёл вбок
  // четыре раза. Воду туда не завезли — она натекла обратно из водоносного
  // слоя за границей заливки, пока восемь кусков воздуха вынимались по
  // очереди. Дипслейт по периметру перекрывает приток, а всё, что затекло
  // раньше, снимает заливка воздухом следом. 1x170x40 = 6800 на кусок.
  for (const [x1, z1, x2, z2] of [[802, 802, 802, 841], [841, 802, 841, 841], [803, 802, 840, 802], [803, 841, 840, 841]]) {
    await cmd(`/fill ${x1} -39 ${z1} ${x2} 130 ${z2} minecraft:deepslate`)
  }
  // 38x38x22 = 31768 на кусок. Небо нужно до самого верха: openSky читает
  // клетки подряд до потолка мира, и один природный блок на y=110 сделал бы
  // «вылез наружу» ложным — а заодно и сам подъём бесконечным.
  for (let lo = -39; lo <= 130; lo += 22) {
    await cmd(`/fill 803 ${lo} 803 840 ${Math.min(lo + 21, 130)} 840 minecraft:air`)
  }
  // Сам штрек: четырнадцать клеток на восток, тело встаёт в западном тупике.
  await cmd(`/fill ${DRIFT.x} ${DRIFT.y} ${DRIFT.z} 839 ${DRIFT.y + 1} ${DRIFT.z} minecraft:air`)

  // Каморка 7x7 на восточном конце штрека: четыре открытые стороны вместо
  // одной, то есть четыре точки контакта вместо одной при той же своре. Это
  // вся разница между случаями (м1) и (м2) — форма земли, а не число врагов.
  // 7x2x7 = 98 блоков.
  if (chamber) await cmd('/fill 833 -50 817 839 -49 823 minecraft:air')

  // Колонка гравия НАД потолком штрека, а не в нём. Это принципиально: гравий
  // падает только когда под ним открыли клетку, поэтому колонка, стоящая на
  // дипслейте y=-48, стабильна и никого не заваливает — ровно до первого
  // взмаха лестницы, которая этот самый -48 и режет первым. Насыпь её в сам
  // штрек — и она осыплется на теле ещё в подготовке, и мерить будет нечего.
  //   узкая  — 7 блоков над одной клеткой: уйти вбок можно, и надо;
  //   широкая — то же поле 9x9, уйти некуда: проверяем честность отказа.
  if (gravel === 'узкая') {
    await cmd(`/fill ${DRIFT.x} -47 ${DRIFT.z} ${DRIFT.x} -41 ${DRIFT.z} minecraft:gravel`)
  } else if (gravel === 'широкая') {
    // 9x9x7 = 567 блоков, целиком внутри обечайки.
    await cmd(`/fill ${DRIFT.x - 4} -47 ${DRIFT.z - 4} ${DRIFT.x + 4} -41 ${DRIFT.z + 4} minecraft:gravel`)
  }
  if (gravel) {
    // Если при заливке что-то всё-таки поехало, это уже сущность falling_block,
    // и она долетит и встанет блоком посреди замера. Чистим и даём осесть.
    await cmd('/kill @e[type=!player]')
    await sleep(1200)
  }
}

async function kit (items) {
  await cmd('/clear @s')
  for (const give of items) await cmd(`/give @s ${give}`)
  await sleep(600)
}

// Прогон стартует после телепорта, а телепорт роняет тело с высоты — лечим до
// замера, иначе половина отказов будет по здоровью, а не по геометрии.
async function heal () {
  await cmd('/effect give @s minecraft:regeneration 12 5 true')
  await sleep(5000)
}

// Отметка здоровья, с которой можно мерить урон. heal() даёт регенерацию на
// двенадцать секунд, а прогон стартует через пять — оставшиеся семь легли бы
// ровно на замер и замаскировали бы его. Здесь же снимается сопротивление,
// которым арена гасит падение при телепорте: под ним «выжил» не значит ничего.
async function markHealth () {
  await cmd('/effect clear @s')
  await sleep(500)
  return health()
}

// «Проверить мир до замера», в самой дешёвой форме: существует ли моб вообще.
// Прогон, в котором (е) молча позеленел мимо цели, отличался от зелёного ровно
// этим — скелета в мире не было, /summon об этом не сказал, а сцена узнала
// только по отсутствию отказа. fair:false нарочно: вопрос «есть ли он», а не
// «вижу ли я его»; на второй отвечает поле met в самом ответе подъёма.
async function mobsAround (radius = 16) {
  const r: any = await call('observe', { radius, fair: false }).catch(() => ({} as Record<string, any>))
  const list = ((r.detail || {} as Record<string, any>).entities || [])
  return list.filter(e => /skeleton|zombie|creeper|spider|husk|stray/i.test(e.name || ''))
}

// Подъём — это одна нога за вызов, и мозг обязан звать снова. Сцена делает то
// же самое и складывает стены со всех ног: заложиться бот должен ровно один
// раз, на первой, и это как раз то, что надо увидеть целиком.
async function climbOut (label, { legs = 3, targetY = DRIFT.top, timeoutSeconds = 200 }: any = {} as Record<string, any>) {
  const walls = []
  let last = null
  let first = null
  for (let i = 0; i < legs; i++) {
    last = await step(`${label} #${i + 1}`, 'surface', { targetY, timeoutSeconds })
    const d = last.detail || {} as Record<string, any>
    if (!first) first = d
    for (const w of d.walls || []) walls.push(w)
    if (last.status !== 'done') break
    if (d.out) break
    if (!d.climbed) break
  }
  return { last, detail: (last && last.detail) || {} as Record<string, any>, first: first || {} as Record<string, any>, walls }
}

// ------------------------------------------------------------------ случаи

// (а) Дно собственного колодца 1x1 на 20 вниз, над головой честное небо.
// Рюкзак пустой, кроме кирки: доказываем, что лесенка вырубается в своей же
// стене и ничего не стоит.
async function caseWell () {
  console.log('\n=== (а) дно колодца 1x1 глубиной 20 под открытым небом ===')
  await plate({ well: true })
  await kit(['minecraft:iron_pickaxe 1', 'minecraft:cooked_beef 8'])
  await cmd('/tp @s 708.5 60 708.5')
  await sleep(1500)
  await heal()

  const from = await pos()
  console.log('стою:', JSON.stringify(from), 'hp', await health())

  let last = null
  for (let i = 0; i < 3; i++) {
    last = await step(`подъём #${i + 1}`, 'surface', { timeoutSeconds: 120 })
    const d = last.detail || {} as Record<string, any>
    if (last.status !== 'done') break
    if (d.out) break
    if (!d.climbed) break
  }
  const d = (last && last.detail) || {} as Record<string, any>
  const at = await pos()
  check('понял, что в яме, и полез', (at.y - from.y) > 0, { from: from.y, at: at.y })
  // Критерий — предикат, а не абсолютная высота. Верхняя ступенька лежит на
  // уровень ниже плиты (y=79 при поверхности 80): это устройство лестницы, а
  // не недолёт — с неё тело шагает на поверхность само, и walkAway это видит.
  // Требовать y>=80 значит требовать от лестницы столба.
  check('вылез (out=true)', d.out === true, { out: d.out, y: at.y, note: d.note })
  check('лесенкой, а не столбом', (d.stairs || 0) > 0, { stairs: d.stairs, pillar: d.pillar })
  check('больше не в яме (pit=false)', d.pit === false, { pit: d.pit })

  // Проверка по существу вместо высоты. Высота — плохой критерий: верхняя
  // ступенька лестницы по устройству лежит на уровень ниже плиты, и подкручивать
  // порог (80, 79, 78...) значит лечить симптом. «Вылез» означает ровно одно:
  // тело своими ногами доходит до точки на поверхности. Это и спрашиваем.
  console.log(`   остановился на y=${at.y}, поверхность на 80 — проверяем ногами`)
  await step('дойти по плите', 'goto', { x: 700, y: 80, z: 700, range: 1, timeoutSeconds: 60 })
  const walked = await pos()
  check('дошёл пешком до точки на поверхности',
    walked.y >= 79 && Math.abs(walked.x - 700) <= 2 && Math.abs(walked.z - 700) <= 2, walked)
}

// (б) Честная поверхность. Копать нечего, и сказать про это надо сразу.
async function caseGround () {
  console.log('\n=== (б) ровная поверхность ===')
  await plate()
  await kit(['minecraft:iron_pickaxe 1', 'minecraft:cobblestone 64'])
  await cmd('/tp @s 704.5 80 704.5')
  await sleep(1500)
  await heal()

  const r: any = await step('подъём без targetY', 'surface', { timeoutSeconds: 60 })
  const d = r.detail || {} as Record<string, any>
  check('сказал «и так наверху»', d.out === true && d.climbed === 0, { out: d.out, climbed: d.climbed })
  check('ничего не выкопал', d.dug === 0, { dug: d.dug })
  check('видит небо', d.sky === true, { sky: d.sky })
}

// (б2) Тот же пятачок, но пустой рюкзак и targetY на два блока выше земли —
// ровно то, что вернул diamond4: «столб строить нечем, а лестницу не
// вырубить». Правильный ответ — «я снаружи», а не попытка достроиться в небо.
async function caseGroundWithTarget () {
  console.log('\n=== (б2) поверхность, пустой рюкзак, targetY выше земли ===')
  await plate()
  await kit(['minecraft:cooked_beef 4'])
  await cmd('/tp @s 704.5 80 704.5')
  await sleep(1500)
  await heal()

  const before = await pos()
  const r: any = await step('подъём targetY=82', 'surface', { targetY: 82, timeoutSeconds: 60 })
  const d = r.detail || {} as Record<string, any>
  const at = await pos()
  check('не стал строить столб в небо', d.dug === 0 && at.y === before.y, { dug: d.dug, y: at.y })
  check('доложил, что он снаружи', d.out === true, { out: d.out })
  check('в note нет «строить нечем»', !/строить нечем/.test(d.note || ''), d.note)
}

// (в) Пещера под 62 блоками камня. Комната шире, чем радиус проверки «могу
// уйти пешком», поэтому единственное, что держит бота внизу, — потолок.
async function caseCave () {
  console.log('\n=== (в) пещера под 62 блоками камня ===')
  await deep({ room: true })
  await kit([
    'minecraft:iron_pickaxe 2', 'minecraft:torch 32',
    'minecraft:cobblestone 32', 'minecraft:cooked_beef 8'
  ])
  await cmd('/tp @s 761.5 15 761.5')
  await sleep(1500)
  await heal()

  const from = await pos()
  const r: any = await step('подъём (один отрезок)', 'surface', { timeoutSeconds: 120 })
  const d = r.detail || {} as Record<string, any>
  const at = await pos()
  check('не считает, что уже наверху', d.out === false, { out: d.out, sky: d.sky })
  check('полез вверх', (at.y - from.y) > 0, { from: from.y, at: at.y })
  check('зовёт себя ещё раз', /позови ещё раз/.test(d.note || ''), d.note)
  console.log(`   за один вызов набрал ${at.y - from.y} уровней (осталось ${80 - at.y})`)
}

// (г1) Смерть на глубине, возрождение у мирового спавна: замерено — 988
// блоков по горизонтали и 65 уровней вниз против пяти минут жизни дропа.
// Похода тут быть НЕ ДОЛЖНО, и проверяется ровно это: отказ, названная
// причина и числа, по которым мозг может проверить расчёт сам. Если бот
// всё-таки пошёл — это провал. Настоящий поход проверяется в (г3), где
// смерть рядом со спавном.
async function caseDeepDeath () {
  console.log('\n=== (г1) поход за лутом после смерти на глубине ===')
  await deep({ room: true })
  await kit([
    'minecraft:iron_pickaxe 1', 'minecraft:iron_sword 1',
    'minecraft:cooked_beef 8', 'minecraft:diamond 3'
  ])
  await cmd('/tp @s 761.5 15 761.5')
  await sleep(1500)
  await cmd('/kill @s')
  await sleep(4000) // возрождение и запись смерти в память

  const spawn = await pos()
  const memory: any = await call('recall', { lines: 1 })
  const slot = ((memory.detail.state.deaths || {} as Record<string, any>).всего || 1) - 1
  console.log('возродился:', JSON.stringify(spawn), `смерть №${slot}`)

  const r1: any = await step('recover без кирки', 'recover', { index: slot, timeoutSeconds: 120 })
  const d1 = r1.detail || {} as Record<string, any>
  const at1 = await pos()
  check('отказался, а не пошёл', d1.went === false, { went: d1.went, at: at1 })
  check('назвал причину — нечем копать', /кирки нет/.test(d1.stopped || ''), d1.stopped)
  check('посчитал дорогу', !!d1.road && d1.road.down > 40, d1.road)
  check('остался на месте', at1.x === spawn.x && at1.z === spawn.z, at1)

  // С киркой причина меняется: уже не «нечем», а «не успею». Проверяем не
  // текст, а сходимость — отказ должен следовать из собственных чисел.
  await cmd('/give @s minecraft:iron_pickaxe 1')
  await sleep(800)
  const r2: any = await step('recover с киркой', 'recover', { index: slot, timeoutSeconds: 280 })
  const d2 = r2.detail || {} as Record<string, any>
  const at2 = await pos()
  check('и с киркой отказался', d2.went === false, { went: d2.went, at: at2 })
  check('отказ по времени', /не успею|уже нет/.test(d2.stopped || ''), d2.stopped)
  check('числа сходятся с отказом',
    !!d2.road && d2.road.etaSeconds > d2.road.leftSeconds, d2.road)
  check('остался на месте', at2.x === spawn.x && at2.z === spawn.z, at2)
}

// (г2) Та же машинка, но задача выполнимая: куча в 14 уровнях под ногами, и
// время не идёт (координаты заданы руками, это не смерть). Тут фаза спуска
// обязана отработать — дойти по поверхности, встать в 14 блоках сбоку и
// прокопать лесенку ровно в кучу.
async function caseShallowLoot () {
  console.log('\n=== (г2) лут на 14 уровней ниже по координатам: спуск лесенкой ===')
  await deep({ chamber: true })
  await kit(['minecraft:iron_pickaxe 2', 'minecraft:torch 32', 'minecraft:cooked_beef 8'])
  await cmd('/tp @s 761.5 80 761.5')
  await sleep(1500)
  await heal()
  // Куча в закрытой камере: пробраться к ней можно только прокопавшись.
  // Кладём её последней — у дропа те же пять минут жизни, что и у настоящего.
  // Формат NBT предмета — начиная с 1.20.5 это `count`, а не `Count`.
  await cmd('/summon minecraft:item 761 67 761 {Item:{id:"minecraft:diamond",count:5}}')

  const from = await pos()
  const t0 = gameClock.now()
  const r: any = await step('recover x=761 y=66 z=761', 'recover',
    { x: 761, y: 66, z: 761, radius: 8, timeoutSeconds: 240 })
  const took = Math.round((gameClock.now() - t0) / 1000)
  const d = r.detail || {} as Record<string, any>
  const at = await pos()
  // Срок — первая проверка, а не следствие остальных. Прогон, в котором это
  // сломалось, выглядел как «спускался лесенкой» и «забрал алмазы» красными,
  // хотя тело стояло на куче: интент не уложился, а таймаут отдаёт detail:null,
  // и обе проверки читали пустоту. Спрашиваем про срок прямо.
  check('уложился в срок и ответил', r.status === 'done', { status: r.status, detail: r.detail })
  // «!== false» проходило и на пустом detail, то есть на молчании.
  check('пошёл, а не отказался', d.went === true, { went: d.went, stopped: d.stopped })
  check('спускался лесенкой', !!d.descended, d.descended)
  check('оказался внизу у кучи', at.y <= 70, { from: from.y, at: at.y })
  check('забрал алмазы', (d.gained || {} as Record<string, any>).diamond > 0, d.gained)
  // Чем кончился подбор — то, чего не мог сказать прогон 2026-09-15: алмазы
  // лежали в рюкзаке через 34 с лестницы, а ответ пришёл таймаутом на 265-й.
  // Один стак, до которого pathfinder не находил пути, держал подбор до обрыва
  // сессии: goto на «stuck» перестраивает путь и не сдаётся никогда. Теперь
  // каждому стаку один ход, и отчёт обязан назвать, почему подбор кончился.
  const sw = d.sweep || {} as Record<string, any>
  check('сказал, чем кончился подбор', d.arrived !== true || typeof sw.ended === 'string', d.sweep)
  // «Больше ничего не лежит» — утверждение о мире, и мир его проверяет: сразу
  // после ответа, тем же радиусом, что был у подбора. Осыпь от своего же
  // копания в счёт подбора не входит, а на земле лежит. Запас в 0.1 — это
  // округление dist в observe, не терпимость.
  const lying = (((await call('observe', { radius: 8, fair: false }).catch(() => ({} as Record<string, any>))) as any).detail || {} as Record<string, any>).entities || []
  const stacks = lying.filter(e => /^item$/i.test(e.name || '') && e.dist < 8 - 0.1)
  check('«больше ничего не лежит» — и правда не лежит',
    !(/больше ничего не лежит|на месте пусто/.test(d.note || '') && stacks.length),
    { лежит: stacks.map(e => `${e.pos.x},${e.pos.y},${e.pos.z} в ${e.dist}`), note: d.note })
  console.log('   дорога: ' + JSON.stringify(d.road || null))
  const skippedEarlier = (sw.left || []).filter(l => l.why === 'списан раньше').length
  console.log(`   подбор: ${sw.ended || '—'}, взял стаков ${sw.taken ?? '?'}, не достал ${(sw.left || []).length - skippedEarlier}` +
    `${skippedEarlier ? ` (и ${skippedEarlier} списанных раньше)` : ''}, не обошёл ${sw.unvisited || 0}, ` +
    `лежит рядом не из кучи ${(sw.stray || []).length}, на земле в 8 бл. после ответа ${stacks.length}; ответ через ${took} с при сроке 240`)
}

// (г3) Смерть рядом со спавном и неглубоко — единственная форма, в которой
// поход за лутом вообще успевает. Точка возрождения ставится руками: мировой
// спавн от любой арены за километр, а на таком плече отказ верен всегда, и
// проверять на нём поход бессмысленно. Здесь дорога считается в полторы
// минуты против пяти, значит бот обязан пойти, прокопаться в свой же склеп и
// забрать то, что из него выпало.
async function caseNearDeath () {
  console.log('\n=== (г3) смерть рядом и неглубоко: поход должен состояться ===')
  await plate({ crypt: true })
  await cmd('/spawnpoint @s 712 80 712')
  await kit(['minecraft:iron_pickaxe 1', 'minecraft:diamond 5', 'minecraft:cooked_beef 8'])
  await cmd('/tp @s 701.5 66 701.5')
  await sleep(1500)
  await cmd('/kill @s')
  await sleep(4000) // возрождение и запись смерти в память

  const spawn = await pos()
  const memory: any = await call('recall', { lines: 1 })
  const slot = ((memory.detail.state.deaths || {} as Record<string, any>).всего || 1) - 1
  console.log('возродился:', JSON.stringify(spawn), `смерть №${slot}`)
  // Кирка из общака — без неё отказ будет «прокопаться нечем», и это тоже
  // правильный отказ, но он уже проверен в (г1).
  await cmd('/give @s minecraft:iron_pickaxe 1')
  await sleep(800)

  const r: any = await step('recover (последняя смерть)', 'recover',
    { index: slot, radius: 8, timeoutSeconds: 240 })
  const d = r.detail || {} as Record<string, any>
  const at = await pos()
  // Срок — первая проверка, а не следствие остальных. Прогон, в котором это
  // сломалось, выглядел как «спускался лесенкой» и «забрал алмазы» красными,
  // хотя тело стояло на куче: интент не уложился, а таймаут отдаёт detail:null,
  // и обе проверки читали пустоту. Спрашиваем про срок прямо.
  check('уложился в срок и ответил', r.status === 'done', { status: r.status, detail: r.detail })
  check('пошёл, а не отказался', d.went === true, { went: d.went, stopped: d.stopped })
  check('расчёт обещал, что успеет',
    !!d.road && d.road.etaSeconds < d.road.leftSeconds, d.road)
  check('спускался лесенкой', !!d.descended, d.descended)
  check('дошёл до склепа', at.y <= 70, { at: at.y })
  check('вернул свои алмазы', (d.gained || {} as Record<string, any>).diamond > 0, d.gained)
  console.log('   дорога: ' + JSON.stringify(d.road || null))
}

// (д) Лава ровно над головой. Замерено на четвёртом пролёте try-diamond:
// подъём встал на 124,-36,142 и стоял там, сколько его ни зови — climbed 0,
// та же лава, тот же текст, бот жив, три кирки в рюкзаке. Причина в том, что
// первая клетка, которую режет ЛЮБОЙ из четырёх азимутов, — это блок над
// собственной головой, и столб идёт через него же. Значит четыре азимута тут
// не четыре, а один, и единственный ход — уйти из-под лавы вбок.
async function caseLavaOverhead () {
  console.log('\n=== (д) лава над головой: подъём обязан обойти ===')
  await deep({ lava: true })
  await kit([
    'minecraft:iron_pickaxe 2', 'minecraft:torch 32',
    'minecraft:cobblestone 64', 'minecraft:cooked_beef 8'
  ])
  await cmd('/tp @s 761.5 15 761.5')
  await sleep(1500)
  await heal()

  const from = await pos()
  const r: any = await step('подъём из-под лавы', 'surface', { timeoutSeconds: 120 })
  const d = r.detail || {} as Record<string, any>
  const at = await pos()
  check('не встал намертво', (at.y - from.y) > 0, { from: from.y, at: at.y, stopped: d.stopped })
  check('отошёл вбок', (d.aside || 0) > 0, { aside: d.aside })
  check('в лаву не полез', (await health()) > 10, await health())
  console.log(`   ушёл с ${from.x},${from.z} на ${at.x},${at.z}, набрал ${at.y - from.y} уровней`)
}

// (о) Вода в лестнице. Замерено на походе 2026-09-16: четвёртый отрезок подъёма
// встал на 166,56,162 со словами «стою в воде — отсюда не поднимаюсь», пятый
// ответил то же с climbed 0, а через 23 секунды после конца сцены сервер
// написал «NeuroDown drowned» — голова была под водой, и ничто тело оттуда не
// вынимало: автопилот во время намерения из воды не выводит, а сцена звала
// подъём снова. Источник ставится ровно в клетку, которую подъём режет первой
// при любом азимуте, — над головой, — когда тело уже стоит в кармане, и вода
// приходит на него сверху. Выход по построению один: заткнуть течь блоком и
// лезть. Потолок кармана над источником — камень, так что всплыть некуда, а
// ступенька в стене без затычки упирается в ту же воду.
//
// Вторая половина — контроль, и он обязан покраснеть на вердикте «полез»: та
// же вода, в сумке ни блока, то есть выхода нет вовсе. Если вердикт «вылез и
// полез» зеленеет и там, он не отличает подъём от чего-то ещё, и первая
// половина не доказывает ничего.
async function caseFloodedStair () {
  console.log('\n=== (о) вода над головой в лестнице: заткнуть и лезть ===')
  const LEVELS = 6
  const climbedOut = (from, at) => at.y - from.y >= LEVELS

  await deep({ pocket: true })
  await kit(['minecraft:iron_pickaxe 2', 'minecraft:cobblestone 32', 'minecraft:cooked_beef 8'])
  await cmd('/tp @s 761.5 15 761.5')
  await sleep(1500)
  await heal()
  const hp0 = await markHealth()
  await cmd('/kill @e[type=!player]')
  const from = await pos()
  const seen = mark()
  await cmd('/setblock 761 17 761 minecraft:water')
  await sleep(1000)
  const wet = await waterNear()
  console.log('стою:', JSON.stringify(from), 'hp', hp0, '— вода:', JSON.stringify(wet))
  // Источник и два блока течения под ним: без них тело стоит сухим, и случай
  // проверяет обычный подъём.
  check('арена затоплена: у ног вода, клеток воды не меньше двух', wet.count >= 2 && wet.dist !== null && wet.dist <= 1.5, wet)

  const r: any = await step('подъём из воды', 'surface', { targetY: from.y + LEVELS, timeoutSeconds: 90 })
  const d = r.detail || {} as Record<string, any>
  const at = await pos()
  const hp1 = await health()
  const hurt = since(seen, 'damage').length
  check(`вылез из воды и полез: +${at.y - from.y} из ${LEVELS} (замер один)`, climbedOut(from, at),
    { from: from.y, at: at.y, stopped: d.stopped, water: d.water })
  check('заткнул течь над головой 761,17,761 и назвал её в water.plugged',
    ((d.water || {} as Record<string, any>).plugged || []).some(p => p.x === 761 && p.y === 17 && p.z === 761), d.water)
  check('нет мёртвого «отсюда не поднимаюсь»', !/отсюда не поднимаюсь/.test(`${d.stopped || ''} ${d.note || ''}`), d.stopped)
  check('не тонул: ни одного урона за замер', hurt === 0 && hp1 >= hp0, { hp0, hp1, damage: hurt })
  console.log(`   water: ${JSON.stringify(d.water)}; поднялся с ${from.y} до ${at.y}, hp ${hp0} -> ${hp1}`)

  // Та же вода, но тело на пяти хп — форма, в которой подъём убил бота в
  // походе: он встал в воде на hp 8, утопление бьёт 2 хп в секунду, и после
  // первого же тика урона ответ шёл из гейта по здоровью, до единого хода.
  // Пара самоконтрольная: «вышел из воды» краснеет, если ход из воды снова
  // окажется под гейтом, а «встал именно на здоровье» краснеет, если гейт
  // вместо переноса просто убрали. Дыхание выдано нарочно: регресс тогда
  // отвечает красным, а не трупом посреди сцены, а само утопление меряет стенд.
  console.log('\n--- та же вода, но хп 5: ход из воды не под гейтом здоровья ---')
  await deep({ pocket: true })
  await kit(['minecraft:iron_pickaxe 2', 'minecraft:cobblestone 32', 'minecraft:cooked_beef 8'])
  await cmd('/tp @s 761.5 15 761.5')
  await sleep(1500)
  await heal()
  await markHealth()
  await cmd('/kill @e[type=!player]')
  await cmd('/effect give @s minecraft:water_breathing 90 0 true')
  await cmd('/setblock 761 17 761 minecraft:water')
  await sleep(1000)
  await cmd('/damage @s 15 minecraft:generic')
  await sleep(600)
  const hpLow = await health()
  const wetLow = await waterNear()
  console.log('хп перед вызовом:', hpLow, '— вода:', JSON.stringify(wetLow))
  check('сцена: хп ниже гейта (6) и арена затоплена', hpLow < 6 && wetLow.count >= 2 && wetLow.dist !== null && wetLow.dist <= 1.5, { hp: hpLow, wet: wetLow })

  const r3: any = await step('подъём из воды на хп 5', 'surface', { targetY: from.y + LEVELS, timeoutSeconds: 60 })
  const d3 = r3.detail || {} as Record<string, any>
  const wetAfter = await waterNear(1)
  check('на пяти хп всё равно сделал ход из воды (поле water)', !!d3.water, d3.water)
  check('вышел из воды: у ног её больше нет', (d3.water || {} as Record<string, any>).dry === true && !(wetAfter.dist !== null && wetAfter.dist <= 0.9), { water: d3.water, вокруг: wetAfter })
  check('контроль: гейт по здоровью не убран — встал именно на нём', /здоровья \d+ — дальше не лезу/.test(d3.stopped || ''), d3.stopped)
  check('note зовёт поесть, а не «позови ещё раз»', /mc_eat/.test(d3.note || '') && !/полезу дальше отсюда/.test(d3.note || ''), d3.note)
  await cmd('/setblock 761 17 761 minecraft:stone')
  await cmd('/effect clear @s')

  console.log('\n--- та же вода, но в сумке ни блока: контроль, выхода нет ---')
  await deep({ pocket: true })
  await kit(['minecraft:iron_pickaxe 1', 'minecraft:cooked_beef 8'])
  await cmd('/tp @s 761.5 15 761.5')
  await sleep(1500)
  await heal()
  await markHealth()
  // Дыхание в контроле не измеряется, а тело стоит под водой, пока сцена читает
  // ответ и убирает источник. inWater в демоне смотрит на блоки, не на эффект.
  await cmd('/effect give @s minecraft:water_breathing 60 0 true')
  await cmd('/kill @e[type=!player]')
  const from2 = await pos()
  await cmd('/setblock 761 17 761 minecraft:water')
  await sleep(1000)
  const wet2 = await waterNear()
  check('контроль затоплен так же', wet2.count >= 2 && wet2.dist !== null && wet2.dist <= 1.5, wet2)

  const r2: any = await step('подъём из воды без блоков', 'surface', { targetY: from2.y + LEVELS, timeoutSeconds: 60 })
  const d2 = r2.detail || {} as Record<string, any>
  const at2 = await pos()
  check('контроль: вердикт «вылез и полез» здесь красный (иначе он не различает)', !climbedOut(from2, at2),
    { from: from2.y, at: at2.y, stopped: d2.stopped })
  check('назвал воду и вызываемый ход', /из воды сам не выбраться/.test(d2.stopped || '') && /mc_[a-z_]+/.test(d2.stopped || ''), d2.stopped)
  check('note: звать ещё раз с этого места бесполезно', /бесполезно/.test(d2.note || ''), d2.note)
  check('нет мёртвого «отсюда не поднимаюсь»', !/отсюда не поднимаюсь/.test(`${d2.stopped || ''} ${d2.note || ''}`), d2.stopped)

  // Тело не оставляем в воде: источник в камень, карман в воздух.
  await cmd('/setblock 761 17 761 minecraft:stone')
  await cmd('/fill 761 15 761 761 16 761 minecraft:air')
  await cmd('/effect clear @s')
}

// (е) Стрелок за сплошной стеной. Замерено на прогоне, где бот впервые выжил:
// он заложился от скелета на y=-51, штрек написал «между нами сплошная порода
// — стою за ней», бой написал «я в норе, ко мне не пройти», а подъём отказался
// лезть, потому что тот же скелет в пяти блоках. Три модуля согласны, что моб
// недостижим, и все трое стоят. Проверяется пара: замурованный моб подъёму не
// помеха, а тот же моб на виду обязан его остановить — и сказать, что повтор
// ответит то же самое.
async function caseArcherBehindWall () {
  console.log('\n=== (е) стрелок за сплошной стеной: подъём обязан идти ===')
  await deep({ archer: true })
  await kit([
    'minecraft:iron_pickaxe 2', 'minecraft:torch 32', 'minecraft:cobblestone 64',
    'minecraft:cooked_beef 8', 'minecraft:iron_helmet 1', 'minecraft:iron_chestplate 1'
  ])
  await cmd('/tp @s 761.5 15 761.5')
  await sleep(1500)
  await heal()
  await cmd('/summon minecraft:skeleton 766.5 15 761.5')
  await sleep(1200)

  const from = await pos()
  const r: any = await step('подъём при замурованном стрелке', 'surface', { timeoutSeconds: 90 })
  const d = r.detail || {} as Record<string, any>
  const at = await pos()
  check('полез, хотя моб в пяти блоках', (at.y - from.y) > 0, { from: from.y, at: at.y })
  check('не сослался на моба', !/спиной к нему/.test(d.stopped || ''), d.stopped)

  // Тот же скелет, но в одной каморке с ботом. Сопротивление — чтобы стрела не
  // увела прогон в low_health: проверяем предикат, а не выживание.
  //
  // Проверка тут развёрнута, и это не подгонка под поведение, а смена доктрины,
  // которую видно по датам. Написана она была тогда, когда «тут не штрек»
  // означало «хода нет»: стена ставится только в штреке, а на лестнице спина
  // открыта, поэтому единственным честным ответом был отказ. С тех пор у
  // подъёма появился второй ход — заслон: два блока в ту клетку, через которую
  // идёт луч, с той высоты, где тело стоит сейчас. В каморке 5x5 он ставится
  // ровно так же, как в штреке, и режет линию сразу; дальше два уровня
  // лестницы — и линию добивает потолок самой каморки.
  //
  // Так что отказ «не полезу» остался ровно там, где он и был верен: моб
  // вплотную (в занятую им клетку блок не встанет — тогда бой) и блоков нет
  // (тогда «дай блоков или убей»). А «вижу стрелка, закрыться нечем, значит
  // стою на дне навсегда» — это и есть тот тупик, ради которого всё затевалось.
  console.log('\n--- он же, но на виду ---')
  await deep({ archer: true })
  await kit([
    'minecraft:iron_pickaxe 2', 'minecraft:cobblestone 64', 'minecraft:cooked_beef 8',
    'minecraft:iron_helmet 1', 'minecraft:iron_chestplate 1'
  ])
  await cmd('/tp @s 761.5 15 761.5')
  await sleep(1500)
  await cmd('/effect give @s minecraft:resistance 40 4 true')
  await heal()
  await cmd('/summon minecraft:skeleton 753.5 15 761.5')
  await sleep(1200)

  const alive = await mobsAround(12)
  check('скелет в мире есть (арена цела)', alive.some(m => /skeleton/i.test(m.name)), alive)

  const before2 = await pos()
  const r2: any = await step('подъём при стрелке на виду', 'surface', { timeoutSeconds: 60 })
  const d2 = r2.detail || {} as Record<string, any>
  const at2 = await pos()
  const screens = (d2.walls || []).filter(w => /заслон/.test(w.kind || ''))
  // Первым делом — увидел ли он его вообще. Прогон, поднявший этот вопрос,
  // нельзя было прочитать: «поставил заслон и полез» и «моба не заметил»
  // выглядели одинаково, а чинить их надо противоположно.
  check('вообще увидел стрелка', (d2.met || []).length > 0, d2.met)
  check('закрылся заслоном, а не отказом', screens.length > 0,
    { walls: d2.walls, met: d2.met, stopped: d2.stopped })
  check('заслон стоит', screens.length > 0 && screens.every(w => w.standing),
    screens.map(w => `${w.at.x},${w.at.y},${w.at.z}:${w.standing}`))
  // «Полез уже за ним» здесь больше не проверка, а один из двух честных исходов,
  // и это не смягчение, а «красное — только там, где виноват код». Каморка
  // открытая: заслон в одну клетку закрывает линию, но не дорогу, а
  // RangedBowAttackGoal на потерянную линию отвечает тем, что идёт прямо к цели.
  // Замерено 2026-09-15: заслон за 0 с, первый взмах сразу за ним — и тот же
  // скелет в 1 блоке (сторон 3) раньше третьей клетки первой же ступеньки,
  // которой ещё нужны блок под ногу и прыжок. Никакой порядок тех же ходов эту
  // гонку не выигрывает: это бой, и красное здесь — только ответ, который этого
  // не говорит. Лезет ли бот за заслоном, когда обойти его нельзя, проверяет
  // (е2): там это единственный верный исход.
  //
  // Чем кончился вызов, читается по stopped, а не по climbed. Третий исход был
  // слеп: подъём на 2, а потом тот же скелет останавливает его с лестницы. Так
  // вёл себя код до 2026-09-15 в прогоне этой сцены всухую — сцена по climbed > 0
  // напечатала «скелет не успел его обойти» и не проверила ни одного слова
  // ответа, а в ответе были «клетки так и остались воздухом» над одним
  // поставленным блоком и «позови ещё раз, полезу дальше отсюда» под отказом
  // лезть. Поэтому проверки ответа идут всякий раз, когда вызов встал на нём.
  const stopped2 = d2.stopped || ''
  const climbed2 = (at2.y - before2.y) > 0 && (d2.climbed || 0) > 0
  const last2 = (d2.met || [])[(d2.met || []).length - 1] || {} as Record<string, any>
  const endedOnIt = /спиной к нему/.test(stopped2) && last2.who === 'skeleton'
  const walkedRound = /обош[её]л мой заслон на (-?\d+),(-?\d+),(-?\d+)/.exec(stopped2)
  if (endedOnIt) {
    console.log(`   исход: ${climbed2 ? `поднялся на ${d2.climbed}, потом встал` : 'не полез, встал'} на нём: ` +
      `${last2.dist ?? '?'} бл., сторон ${last2.reach ?? '?'}, ${last2.danger || 'опасность не названа'}` +
      `${walkedRound ? ', говорит — обошёл заслон' : ''}${last2.built ? `, блоков второй стены встало ${last2.built.blocks}` : ''}`)
  } else {
    console.log(`   исход: ${climbed2 ? `полез за заслоном на ${d2.climbed}` : 'не полез'} и на скелете не вставал; stopped: ${stopped2 || '—'}`)
  }
  if (!climbed2) {
    // С той же высоты, при стоящем заслоне в два блока, скелет видит тело только
    // из-за края заслона: не по устройству — значит по обходу.
    check('встал, потому что он обошёл заслон и подошёл вплотную',
      last2.danger === 'вплотную' && !!walkedRound, { met: last2, stopped: d2.stopped })
  } else if (endedOnIt) {
    // Выше заслона видеть можно и поверх него, так что обход здесь не требуется —
    // требуется, чтобы причина была названа, и чтобы названный заслон был.
    check('назвал, почему встал на нём: обход, незакрытая стена или контакт',
      /обош[её]л мой заслон|не закрыл|вплотную|уже поставил/.test(stopped2), d2.stopped)
    check('заслон, который он «обошёл», есть и стоит',
      !walkedRound || screens.some(w => `${w.at.x},${w.at.y},${w.at.z}` === walkedRound.slice(1).join(',') && w.standing),
      { claim: walkedRound && walkedRound[0], screens })
  }
  if (!climbed2 || endedOnIt) {
    check('назвал вызываемый бой здесь, а не «уведи в проход»',
      /mc_fight target=skeleton/.test(stopped2) && !/mc_goto в проход/.test(stopped2), d2.stopped)
    if (!climbed2) {
      check('не пишет «стену не поставить» рядом со стоящим заслоном',
        !/сам я тут стену поставить не могу/.test(d2.note || ''), d2.note)
    } else {
      check('не пишет «стену не поставить» про стену, которая стоит',
        !(/сам я тут стену поставить не могу/.test(d2.note || '') && (!!walkedRound || /бл\. встали/.test(stopped2))), d2.note)
    }
    // Два слова ответа, которые проверяются друг о друга без мира: число блоков в
    // отказе стены и «воздух», и отказ лезть и обещание лезть.
    const put = [...stopped2.matchAll(/не закрыл[аио]? его \((\d+) бл\./g)].reduce((n, m) => n + Number(m[1]), 0)
    check('не пишет «остались воздухом» над поставленными блоками',
      !(put > 0 && /остались воздухом/.test(stopped2)), { блоков: put, stopped: d2.stopped })
    check('не обещает «полезу дальше отсюда» под отказом лезть',
      !/полезу дальше отсюда/.test(d2.note || ''), d2.note)
  }
  check('не встал намертво без объяснения', !/прервано/.test(d2.stopped || ''), d2.stopped)
  console.log('   ответ целиком: ' + JSON.stringify(d2))
}

// (е2) Тот же стрелок, но обойти заслон ему нельзя по устройству арены: он в
// клетке 1x1 в восьми блоках к западу и смотрит в комнату через щель высотой в
// блок. Видеть и стрелять щели хватает, пройти — нет. Это та половина (е),
// которую открытая каморка проверить не может: встанет ли заслон и полезет ли
// бот ЗА ним. Любое красное здесь — код: моб на виду и дальше контакта,
// закрыться есть чем, обойти нельзя, значит лезть обязан. Сломанные копии
// ловятся ровно тут: подъём, который встаёт после заслона, и подъём, который
// первой же ступенькой срубает собственный заслон.
//
// Чего этот случай НЕ доказывает: что починен ответ (е) «на виду». Код до
// 2026-09-15 проходит его целиком — в прогоне всухую тоже заслон, подъём на 4 и
// одна стоящая стена. Это страж хода «заслон и лезть за ним», чтобы починка
// ответа в (е) его не сломала; сам ответ проверяют строки (е) под «исход:».
async function caseArcherCaged () {
  console.log('\n=== (е2) стрелок в клетке за щелью: заслон и лезть за ним ===')
  await deep({ cage: true })
  await kit([
    'minecraft:iron_pickaxe 2', 'minecraft:cobblestone 64', 'minecraft:cooked_beef 8',
    'minecraft:iron_helmet 1', 'minecraft:iron_chestplate 1'
  ])
  await cmd('/tp @s 761.5 15 761.5')
  await sleep(1500)
  await cmd('/effect give @s minecraft:resistance 90 4 true')
  await heal()
  // Третий kill, вплотную к призыву: после арены прошло полдюжины команд.
  await cmd('/kill @e[type=!player]')
  await cmd('/summon minecraft:skeleton 753.5 15 761.5')
  await sleep(1200)

  const caged = (await mobsAround(12)).filter(m => /skeleton/i.test(m.name))
  check('скелет в мире есть и сидит в клетке 753,15,761 (арена цела)',
    caged.length === 1 && caged[0].pos.x === 753 && caged[0].pos.z === 761, caged)

  const from = await pos()
  const r: any = await step('подъём при стрелке в клетке', 'surface', { timeoutSeconds: 60 })
  const d = r.detail || {} as Record<string, any>
  const at = await pos()
  const screens = (d.walls || []).filter(w => /заслон/.test(w.kind || ''))
  const after = (await mobsAround(24)).filter(m => /skeleton/i.test(m.name))
  check('увидел его в щель (не увидел — щель не прорезалась, арена не та)', (d.met || []).length > 0, d.met)
  check('закрылся заслоном', screens.length > 0, { walls: d.walls, met: d.met, stopped: d.stopped })
  check('полез за заслоном', (at.y - from.y) > 0 && (d.climbed || 0) > 0,
    { from: from.y, at: at.y, climbed: d.climbed, stopped: d.stopped })
  check('не отказался «спиной к нему»', !/спиной к нему/.test(d.stopped || ''), d.stopped)
  check('стена на весь подъём одна и стоит', (d.walls || []).length === 1 && d.walls[0].standing === true, d.walls)
  check('клетка удержала его: обойти заслон было нельзя',
    after.length === 1 && after[0].pos.x === 753 && after[0].pos.z === 761, after)
  console.log(`   заслон: ${screens.map(w => `${w.at.x},${w.at.y},${w.at.z}, ${w.blocks} бл. за ${w.seconds} с`).join('; ') || 'нет'}` +
    `; поднялся ${from.y} -> ${at.y} (climbed ${d.climbed ?? '?'}), стен ${(d.walls || []).length}`)
}

// ------------------------------------------- подъём при мобе: ход, а не отказ
//
// Тупик, который эти четыре случая закрывают, дословно с лучшего прогона на
// y=-51: «skeleton в шести блоках — спиной к нему на лестницу не полезу»,
// climbed 0, и так навсегда. Отказ был верен по существу — лестница по
// устройству ходибельная рампа (её за это и предпочитают столбу), а прямая
// держит линию видимости по своей же оси, так что лезть при мобе значит
// отдать ему и дорогу, и выстрел. Неверно было то, что других ходов у подъёма
// не оказалось ни одного, хотя заложиться бот УМЕЛ: бой в том же прогоне
// ответил sealed: true через минуту после отказа.
//
// Цена хода — два блока. Замер уже есть, try-corridor прогон 3: скелет за
// десять блоков по штреку, два блока поставлено, ноль урона и ноль взмахов.
// Против этого ~4 удара кирки на каждый уровень лестницы, которую иначе
// пришлось бы рубить под стрелами.
//
// Форм у хода две, и первый прогон этой сцены показал, почему одной мало.
// Стена в штреке встала идеально — 2 блока, 0.1 с, hp 20 -> 20, — а через два
// уровня подъём отчитался «out=false, y=-48» и встал: лестница на каждой
// ступеньке срезает клетку над собственной головой, то есть разбирает потолок
// штрека, и тело поднялось выше своей же стены. Поэтому вторая форма —
// заслон: два блока в ту клетку, через которую идёт луч, с той высоты, на
// которой тело стоит СЕЙЧАС. Стена растёт вместе с подъёмом, пока моб в
// тупике не потеряет линию совсем.

// (ж) Скелет в шести блоках по штреку. Стреляет по прямой линии видимости,
// поэтому закрывается ВЕСЬ столбик, а не только пол: пола хватает пешему,
// стреле нужен блок на уровне головы.
async function caseArcherInDrift () {
  console.log('\n=== (ж) скелет в 6 блоках по штреку на -50: закрыться и вылезти ===')
  await drift()
  await kit([
    'minecraft:iron_pickaxe 3', 'minecraft:cobbled_deepslate 64', 'minecraft:torch 16',
    'minecraft:cooked_beef 8', 'minecraft:iron_helmet 1', 'minecraft:iron_chestplate 1'
  ])
  await cmd(`/tp @s ${DRIFT.x}.5 ${DRIFT.y} ${DRIFT.z}.5`)
  await sleep(1500)
  await heal()
  const hp0 = await markHealth()
  const from = await pos()
  // Третий kill, вплотную к призыву. Между постановкой арены и этой строкой
  // прошло полдюжины команд выдачи, а штрек — дорога: за это время в него
  // успевает прийти чужой. Дальше в отчёте будет ровно один моб, и мой.
  await cmd('/kill @e[type=!player]')
  // Отметка ДО призыва: всё, что случится дальше, — это про моба и только.
  const seen = mark()
  await cmd(`/summon minecraft:skeleton ${DRIFT.x + 6}.5 ${DRIFT.y} ${DRIFT.z}.5`)
  await sleep(1200)
  console.log('стою:', JSON.stringify(from), 'hp', hp0)
  const alive = await mobsAround(12)
  check('скелет в мире есть (арена цела)', alive.some(m => /skeleton/i.test(m.name)), alive)

  const r = await climbOut('подъём')
  const at = await pos()
  const hp1 = await health()
  const wall = r.walls[0]
  const spent = r.walls.reduce((n, w) => n + w.blocks, 0)

  check('увидел его', (r.first.met || []).length > 0, r.first.met)
  check('вылез наверх (out=true)', r.detail.out === true,
    { out: r.detail.out, y: at.y, note: r.detail.note })
  check('жив', hp1 > 0, { hp0, hp1 })
  check('не отказался «спиной к нему»', !/спиной к нему/.test(r.first.stopped || ''), r.first.stopped)
  check('заложился от скелета', !!wall && wall.who === 'skeleton', r.walls)
  check('в отчёте видно, ЧЕМ закрылся', !!wall && !!wall.block && wall.blocks > 0,
    wall && { block: wall.block, blocks: wall.blocks, секунд: wall.seconds })
  check('стена стоит между нами', !!wall && wall.standing === true &&
    wall.at.z === DRIFT.z && wall.at.x > from.x && wall.at.x < DRIFT.x + 6,
    wall && { at: wall.at, standing: wall.standing, from: wall.from })
  check('первая стена — по штреку', !!wall && wall.kind === 'штрек', wall && wall.kind)
  check('все стены, что ставил, стоят', r.walls.length > 0 && r.walls.every(w => w.standing),
    r.walls.map(w => `${w.kind}@${w.at.x},${w.at.y},${w.at.z}:${w.standing}`))
  // Первый прогон встал на y=-48: стена в штреке была верна на -50 и перестала
  // закрывать линию, как только лестница срезала потолок штрека над головой.
  // Считать её одну больше нельзя — считаем цену всего подъёма.
  check('весь подъём обошёлся дёшево', spent > 0 && spent <= 10, { стен: r.walls.length, блоков: spent })
  check('в note сказано, чем закрылся', /закрылся от/.test(r.first.note || ''), r.first.note)
  check('под обстрелом не стоял', since(seen, 'damage').length <= 2,
    since(seen).map(e => e.type))
  console.log('   стены: ' + JSON.stringify(r.walls))
  console.log(`   hp ${hp0} -> ${hp1}, блоков в стены ${spent}`)
  // Второй прогон встал на «ответа от сервера нет» — а это наш собственный
  // поводок, не ответ сервера: mineflayer ждёт blockUpdate до 5 с, мы обрывали
  // на 1.2. Теперь отказ обязан назвать, что именно случилось, и одна эта
  // строка в следующем прогоне закрывает вопрос.
  if (!r.detail.out) {
    console.log('   вердикт стены: ' + (r.first.stopped || '—'))
    // Вердиктов у стены четыре, а не два: к «опоздал» и «отказал» добавились
    // «ставить было некуда — и так сплошные» и «встали, но линию не перекрыли».
    // Каждый из них различает, что стало с клетками; прежняя регулярка знала два
    // и покраснела бы на верном ответе.
    check('отказ различает «опоздал» и «отказал»',
      /встали, но уже после|встали \(.*\) и стоят, но линию не перекрыли|и так сплошные|остались воздухом|вплотную|нечем/.test(r.first.stopped || ''),
      r.first.stopped)
  }
}

// (з) То же место, но зомби: ходит, не стреляет, и именно поэтому первый
// прогон этого случая кончился «прервано: low_health», hp 20 -> 7 и восемью
// ударами при нуле поставленных блоков. Причина не в стене, а в частоте
// вопроса: подъём спрашивал «кто меня видит» раз в уровень, а уровень — это
// три клетки дипслейта, четыре-восемь секунд, за которые ходок проходит
// шестнадцать блоков. Он успевал прийти вплотную внутри одной ступеньки.
// Теперь вопрос задаётся между клетками ступеньки, а радиус — двенадцать, то
// есть шесть секунд хода. Отсюда и призыв с дальнего конца штрека: пусть
// придёт сам и будет увиден на подходе, а не на пороге.
async function caseWalkerInDrift () {
  console.log('\n=== (з) зомби по тому же штреку: закрыться и вылезти ===')
  await drift()
  await kit([
    'minecraft:iron_pickaxe 3', 'minecraft:cobbled_deepslate 64', 'minecraft:iron_sword 1',
    'minecraft:cooked_beef 8', 'minecraft:iron_helmet 1', 'minecraft:iron_chestplate 1'
  ])
  await cmd(`/tp @s ${DRIFT.x}.5 ${DRIFT.y} ${DRIFT.z}.5`)
  await sleep(1500)
  await heal()
  const hp0 = await markHealth()
  const from = await pos()
  // Третий kill, вплотную к призыву. Между постановкой арены и этой строкой
  // прошло полдюжины команд выдачи, а штрек — дорога: за это время в него
  // успевает прийти чужой. Дальше в отчёте будет ровно один моб, и мой.
  await cmd('/kill @e[type=!player]')
  const seen = mark()
  // С дальнего конца штрека, за тринадцать. Не поблажка, а замер: подъём
  // смотрит на двенадцать блоков, зомби идёт блок за четверть секунды, и за
  // 1.2 с настройки он проходит около трёх — как скелет в (ж), который к
  // постановке стены оказался на трёх вместо шести. Значит к первому вопросу
  // «кто меня видит» он подходит примерно на девять, и стена успевает за 0.1 с
  // с запасом. Ставить его на шесть значило бы мерить контакт, а в контакте
  // правильный ответ уже другой и уже измерен трижды: бить, а не строить.
  await cmd(`/summon minecraft:zombie ${DRIFT.x + 13}.5 ${DRIFT.y} ${DRIFT.z}.5`)
  await sleep(1200)
  console.log('стою:', JSON.stringify(from), 'hp', hp0)
  const alive = await mobsAround(16)
  check('зомби в мире есть (арена цела)', alive.some(m => /zombie/i.test(m.name)), alive)

  const r = await climbOut('подъём')
  const at = await pos()
  const hp1 = await health()
  const wall = r.walls[0]
  const spent = r.walls.reduce((n, w) => n + w.blocks, 0)

  check('увидел его', (r.first.met || []).length > 0, r.first.met)
  check('вылез наверх (out=true)', r.detail.out === true,
    { out: r.detail.out, y: at.y, note: r.detail.note })
  check('жив', hp1 > 0, { hp0, hp1 })
  check('заложился от зомби', !!wall && wall.who === 'zombie', r.walls)
  check('в отчёте видно, ЧЕМ закрылся', !!wall && !!wall.block && wall.blocks > 0,
    wall && { block: wall.block, blocks: wall.blocks })
  check('стена стоит и держит', !!wall && wall.standing === true && wall.at.x > from.x,
    wall && { at: wall.at, standing: wall.standing, from: wall.from })
  check('все стены, что ставил, стоят', r.walls.length > 0 && r.walls.every(w => w.standing),
    r.walls.map(w => `${w.kind}@${w.at.x},${w.at.y},${w.at.z}:${w.standing}`))
  check('весь подъём обошёлся дёшево', spent > 0 && spent <= 10, { стен: r.walls.length, блоков: spent })
  // Восемь ударов в первом прогоне: зомби дошёл вплотную за одну ступеньку,
  // пока цикл ждал её конца. Здесь он обязан быть отсечён стеной, а не
  // измерен по здоровью, поэтому предел жёсткий.
  check('событий об уроне не больше двух', since(seen, 'damage').length <= 2,
    since(seen).map(e => e.type))
  console.log('   стены: ' + JSON.stringify(r.walls))
  console.log(`   hp ${hp0} -> ${hp1}, блоков в стены ${spent}`)
}

// (и) Тот же скелет, но закладывать нечем. Отказ тут правильный — и он обязан
// назвать, чего именно не хватило и сколько. «Не полезу» без числа оставляет
// мозгу ровно ту развилку, на которой прошлый прогон встал навсегда.
async function caseNothingToWallWith () {
  console.log('\n=== (и) тот же скелет, но блоков на закладку нет ===')
  await drift()
  await kit(['minecraft:iron_pickaxe 1', 'minecraft:cooked_beef 8', 'minecraft:iron_helmet 1'])
  await cmd(`/tp @s ${DRIFT.x}.5 ${DRIFT.y} ${DRIFT.z}.5`)
  await sleep(1500)
  await heal()
  const hp0 = await markHealth()
  const before = await pos()
  // Третий kill, вплотную к призыву. Между постановкой арены и этой строкой
  // прошло полдюжины команд выдачи, а штрек — дорога: за это время в него
  // успевает прийти чужой. Дальше в отчёте будет ровно один моб, и мой.
  await cmd('/kill @e[type=!player]')
  const seen = mark()
  await cmd(`/summon minecraft:skeleton ${DRIFT.x + 6}.5 ${DRIFT.y} ${DRIFT.z}.5`)
  await sleep(1200)

  const r: any = await step('подъём без блоков', 'surface', { targetY: DRIFT.top, timeoutSeconds: 60 })
  const d = r.detail || {} as Record<string, any>
  const at = await pos()

  check('не полез', (at.y - before.y) === 0 && (d.climbed || 0) === 0,
    { from: before.y, at: at.y, climbed: d.climbed })
  check('ничего не выкопал', d.dug === 0, { dug: d.dug })
  check('стен не строил', d.walls === undefined, d.walls)
  check('назвал моба причиной', /спиной к нему/.test(d.stopped || ''), d.stopped)
  check('сказал, что закрыться нечем', /закрыться нечем/.test(d.stopped || ''), d.stopped)
  check('назвал, сколько блоков нужно', /нужно \d+ блока/.test(d.stopped || ''), d.stopped)
  check('в note просит принести блоки', /дай мне блоков/.test(d.note || ''), d.note)
  check('предупредил, что повтор ответит то же', /то же самое/.test(d.note || ''), d.note)
  console.log(`   hp ${hp0} -> ${await health()}; события: ${since(seen).map(e => e.type).join(', ') || '—'}`)
}

// (к) КОНТРОЛЬ. Тот же штрек и тот же рюкзак, моба нет. Подъём обязан остаться
// прежним: лесенка, и ни одного блока в стену — новый ход не должен ничего
// стоить там, где он не нужен.
async function caseDriftNoMob () {
  console.log('\n=== (к) контроль: тот же штрек, моба нет ===')
  await drift()
  await kit([
    'minecraft:iron_pickaxe 3', 'minecraft:cobbled_deepslate 64',
    'minecraft:cooked_beef 8', 'minecraft:iron_helmet 1', 'minecraft:iron_chestplate 1'
  ])
  await cmd(`/tp @s ${DRIFT.x}.5 ${DRIFT.y} ${DRIFT.z}.5`)
  await sleep(1500)
  await heal()
  const hp0 = await markHealth()
  const from = await pos()
  // Контроль доказывает «ни одного блока в стену». Чужой моб в арене
  // превратил бы его в четвёртый случай с мобом, и красный цвет читался бы
  // как поломка хода, которого тут вообще не должно быть.
  await cmd('/kill @e[type=!player]')

  const r = await climbOut('подъём без моба')
  const at = await pos()

  check('вылез наверх (out=true)', r.detail.out === true,
    { out: r.detail.out, y: at.y, note: r.detail.note })
  check('стен не строил вовсе', r.walls.length === 0 && r.first.walls === undefined, r.first.walls)
  check('лесенкой, а не столбом', (r.first.stairs || 0) > 0,
    { stairs: r.first.stairs, pillar: r.first.pillar })
  check('работал, а не стоял', (r.first.dug || 0) > 0, { dug: r.first.dug })
  check('вбок от опасности не ходил', (r.first.aside || 0) === 0,
    { aside: r.first.aside, stopped: r.first.stopped })
  check('в note про стены ни слова', !/закрылся от/.test(r.first.note || ''), r.first.note)
  check('больше не в яме (pit=false)', r.detail.pit === false, { pit: r.detail.pit })
  console.log(`   поднялся с ${from.y} до ${at.y}, hp ${hp0} -> ${await health()}, добыл ${JSON.stringify(r.first.gained || {} as Record<string, any>)}`)
}

// ------------------------------------------- подъём из-под сыпучей колонки
//
// Поход встал на этом, имея всё для успеха: кирка только что починена (275
// ударов, 67 уровней), рюкзак полон блоков, моба рядом нет — и подъём не
// начался. Тело стояло под колонкой гравия: она сыплется быстрее, чем он
// копает, заваливает, он откапывается, она сыплется снова. Восемь событий
// урона на штреке, ещё шесть на подъёме, still_buried, hp 20 -> 9, y=-58.
//
// Физика тут не про «опасный блок», а про порядок клеток. Гравий падает строго
// по своей колонке и только когда под ним открыли клетку, — то есть стоящая
// колонка стабильна, пока её никто не подрывает. А лестница подрывает: первая
// же клетка ЛЮБОГО азимута — это блок над собственной головой (feet+2), а
// вторая (ahead+2) становится головой после шага. Значит под колонкой четыре
// азимута — это один азимут, ровно как с лавой над головой в случае (д), и
// единственный ход — выйти из-под неё. Отсюда и решение: та же sideStep, но
// она обязана смотреть на клетку to+2 — иначе уходит из-под одной линзы под
// следующую.
async function caseGravelOverhead () {
  console.log('\n=== (л) колонка гравия над головой: уйти вбок и лезть рядом ===')
  await drift({ gravel: 'узкая' })
  await kit([
    'minecraft:iron_pickaxe 3', 'minecraft:cobbled_deepslate 64',
    'minecraft:cooked_beef 8', 'minecraft:iron_helmet 1', 'minecraft:iron_chestplate 1'
  ])
  await cmd(`/tp @s ${DRIFT.x}.5 ${DRIFT.y} ${DRIFT.z}.5`)
  await sleep(1500)
  await heal()
  const hp0 = await markHealth()
  const from = await pos()
  const seen = mark()
  console.log('стою:', JSON.stringify(from), 'hp', hp0, '— над головой 7 бл. гравия')

  const r = await climbOut('подъём из-под гравия')
  const at = await pos()
  const hp1 = await health()

  check('вылез наверх (out=true)', r.detail.out === true,
    { out: r.detail.out, y: at.y, note: r.detail.note })
  check('не «прервано»', !/прервано/.test(r.first.stopped || ''), r.first.stopped)
  check('вышел из-под колонки вбок', (r.first.aside || 0) > 0,
    { aside: r.first.aside, stopped: r.first.stopped })
  // Гравий не бьёт при падении — он душит, когда встаёт в клетку головы. Ноль
  // событий урона и есть доказательство, что бот под него не полез.
  check('не закапывался', since(seen).filter(e => e.type === 'damage' || e.type === 'still_buried').length === 0,
    since(seen).map(e => e.type))
  check('жив и целый', hp1 >= hp0, { hp0, hp1 })
  console.log(`   отошёл на ${r.first.aside}, поднялся с ${from.y} до ${at.y}, hp ${hp0} -> ${hp1}`)

  // Та же колонка, но полем 9x9: отойти некуда, и отказ обязан назвать высоту,
  // материал и куда уводить. Заодно это проверка самой арены: если бы гравий
  // осыпался при постройке, высота в отчёте была бы другой.
  console.log('\n--- она же, но полем 9x9: уйти некуда ---')
  await drift({ gravel: 'широкая' })
  await kit([
    'minecraft:iron_pickaxe 3', 'minecraft:cobbled_deepslate 64',
    'minecraft:cooked_beef 8', 'minecraft:iron_helmet 1', 'minecraft:iron_chestplate 1'
  ])
  await cmd(`/tp @s ${DRIFT.x}.5 ${DRIFT.y} ${DRIFT.z}.5`)
  await sleep(1500)
  await heal()
  const hp2 = await markHealth()
  const before = await pos()
  const seen2 = mark()

  const r2: any = await step('подъём под полем гравия', 'surface',
    { targetY: DRIFT.top, timeoutSeconds: 60 })
  const d2 = r2.detail || {} as Record<string, any>
  const at2 = await pos()

  check('не полез', (at2.y - before.y) === 0 && (d2.climbed || 0) === 0,
    { from: before.y, at: at2.y, climbed: d2.climbed })
  check('ни одного удара киркой', d2.dug === 0, { dug: d2.dug })
  check('не закапывался', since(seen2).filter(e => e.type === 'damage' || e.type === 'still_buried').length === 0,
    since(seen2).map(e => e.type))
  check('назвал материал и высоту колонки', /колонка gravel в 7 бл\./.test(d2.stopped || ''), d2.stopped)
  check('сказал, что она сыплется', /сыплется/.test(d2.stopped || ''), d2.stopped)
  check('сказал, что вбок не выйти', /в сторону не отойти/.test(d2.stopped || ''), d2.stopped)
  check('сказал, куда уводить', /mc_goto блоков на \d+/.test(d2.stopped || ''), d2.stopped)
  check('предупредил, что повтор бесполезен', /бесполезно/.test(d2.note || ''), d2.note)
  console.log(`   hp ${hp2} -> ${await health()}`)
}

// ------------------------------------------------- свора: труба против устья
//
// Поход кончился смертью ровно здесь. `met` показал одного зомби в четырёх
// блоках и «не закрылся», отказ отправил мозг в бой, бой случился там, где
// тело стояло, — и одиннадцать событий урона прошли сквозь пятнадцать очков
// железа и надетый щит. Число, которого не хватало, — не количество врагов, а
// количество точек контакта: combat замерил, что одна стоит ~2 хп, две ~7,
// три ~14, четыре убивают. Три зомби в штреке шириной в клетку — это ОДНА
// точка, то есть 2 хп; те же трое в устье пещеры — четыре точки.
//
// Поэтому случай двойной, и обе половины ставят одинаковую свору. Меняется
// только форма земли, а решение обязано смениться на противоположное.

// (м1) Устье: тело в каморке 7x7, вокруг четыре открытые стороны, закладывать
// нечем. Отказ обязан назвать оба числа, причину, по которой стена не встала,
// и место, где драться выгодно.
async function casePackInTheOpen () {
  console.log('\n=== (м1) свора в устье: отказ обязан назвать оба числа и землю ===')
  await drift({ chamber: true })
  // Нарочно без блоков на закладку: так отказ детерминирован и проверяется
  // именно текст, а не гонка «успел ли заслон».
  await kit([
    'minecraft:iron_pickaxe 2', 'minecraft:iron_sword 1', 'minecraft:cooked_beef 8',
    'minecraft:iron_helmet 1', 'minecraft:iron_chestplate 1',
    'minecraft:iron_leggings 1', 'minecraft:iron_boots 1'
  ])
  await cmd('/tp @s 836.5 -50 820.5')
  await sleep(1500)
  await heal()
  const hp0 = await markHealth()
  const before = await pos()
  await cmd('/kill @e[type=!player]')
  const seen = mark()
  for (const [x, z] of [[834, 818], [838, 818], [834, 822]]) {
    await cmd(`/summon minecraft:zombie ${x}.5 -50 ${z}.5`)
  }
  // Дольше, чем везде, и это не терпение ради терпения. Случаю нужна свора,
  // которая УЖЕ взялась за тело, а не просто стоит рядом: отказ теперь может
  // прийти по трём разным признакам (вплотную / бьёт с дистанции / только что
  // били), и на полутора секундах прошлый прогон показал ближайшего зомби
  // дальше 2.5 — то есть вердикт держался на том, успел ли кто-то ударить.
  // Две с половиной секунды снимают эту случайность; хп при этом падает с 20
  // до ~11, выше порога low_health.
  await sleep(2500)

  const alive = await mobsAround(12)
  check('свора в мире есть (арена цела)', alive.filter(m => /zombie/i.test(m.name)).length >= 2, alive)

  const r: any = await step('подъём при своре в устье', 'surface',
    { targetY: DRIFT.top, timeoutSeconds: 60 })
  const d = r.detail || {} as Record<string, any>
  const at = await pos()
  const first = (d.met || [])[0] || {} as Record<string, any>

  check('не полез', (at.y - before.y) === 0 && (d.climbed || 0) === 0,
    { from: before.y, at: at.y, climbed: d.climbed })
  check('увидел свору, а не одного', (first.seen || 0) >= 2, d.met)
  check('посчитал точки контакта', (first.reach || 0) >= 3, d.met)
  check('назвал причину, почему не закрылся', !!first.why, d.met)
  check('оба числа в отказе', /Вижу таких \d+/.test(d.stopped || '') &&
    /дотянуться разом могут \d+/.test(d.stopped || ''), d.stopped)
  check('сказал, где драться выгодно',
    /mc_goto|фланг|пролезет только один/.test(d.stopped || ''), d.stopped)
  check('жив', (await health()) > 0, { hp0 })
  console.log('   met: ' + JSON.stringify(d.met))
  console.log('   отказ: ' + (d.stopped || '—'))
}

// (м2) Труба: та же свора, но тело в тупике штрека шириной в клетку. Видит
// троих, достать может один — и решение обязано быть прежним: заложиться и
// вылезти. Это и есть контроль на ложную панику: доклад «зомби 3» без второго
// числа увёл бы бота бежать от своры, которую коридор уже обезвредил.
async function casePackInTheDrift () {
  console.log('\n=== (м2) та же свора, но в штреке: считает троих, боится одного ===')
  await drift()
  await kit([
    'minecraft:iron_pickaxe 3', 'minecraft:cobbled_deepslate 64', 'minecraft:iron_sword 1',
    'minecraft:cooked_beef 8', 'minecraft:iron_helmet 1', 'minecraft:iron_chestplate 1',
    'minecraft:iron_leggings 1', 'minecraft:iron_boots 1'
  ])
  await cmd(`/tp @s ${DRIFT.x}.5 ${DRIFT.y} ${DRIFT.z}.5`)
  await sleep(1500)
  await heal()
  const hp0 = await markHealth()
  const from = await pos()
  await cmd('/kill @e[type=!player]')
  const seen = mark()
  // Все трое на оси штрека: раскаст проверяет блоки, а не тела, поэтому линия
  // есть у всех троих сразу — и `seen` обязан показать три, а не один.
  for (const x of [834, 836, 838]) {
    await cmd(`/summon minecraft:zombie ${x}.5 ${DRIFT.y} ${DRIFT.z}.5`)
  }
  await sleep(1200)

  const alive = await mobsAround(16)
  check('свора в мире есть (арена цела)', alive.filter(m => /zombie/i.test(m.name)).length >= 2, alive)

  const r = await climbOut('подъём при своре в штреке')
  const at = await pos()
  const hp1 = await health()
  const first = (r.first.met || [])[0] || {} as Record<string, any>
  const wall = r.walls[0]

  check('увидел троих', (first.seen || 0) >= 2, r.first.met)
  check('но точка контакта одна', (first.reach || 0) <= 2, r.first.met)
  check('не побежал от своры', !/спиной к нему/.test(r.first.stopped || ''), r.first.stopped)
  check('заложился штреком', !!wall && wall.kind === 'штрек' && wall.standing === true, r.walls)
  check('вылез наверх (out=true)', r.detail.out === true,
    { out: r.detail.out, y: at.y, note: r.detail.note })
  check('жив', hp1 > 0, { hp0, hp1 })
  console.log('   met: ' + JSON.stringify(r.first.met))
  console.log(`   hp ${hp0} -> ${hp1}, стен ${r.walls.length}, события: ${since(seen).map(e => e.type).join(', ') || '—'}`)
}

// -------------------------------- враждебный по типу против опасного сейчас
//
// Поход дошёл до -59, поднялся живым до -42 и встал там перед эндерменом в
// десяти блоках. Отказ отправил мозг в бой; бой длился 45.3 секунды, сделал
// ноль взмахов, оставил цель живой и принял ноль урона — эндермен телепортом
// уходит из-под удара и при этом ни разу не нападал. Подъём остановило
// существо, которое не угрожало, которое нельзя отгородить и в которое нельзя
// попасть.
//
// Хуже того, в эту ловушку бот заходит сам: во всём демоне на тело наводится
// только combat (holdTheLine и fight), а подъём смотрит исключительно на
// клетки. То есть «убей его» — это единственная строка, которая наводит
// прицел на существо, становящееся враждебным именно от взгляда.
//
// Правило поведенческое, а не по списку видов: опасен тот, кто вплотную, кто
// бьёт с дистанции по типу, или кто нас только что ударил. Обе половины
// случая ставят моба, который не сделает ни того, ни другого, ни третьего
// (NoAI), на одном и том же расстоянии и с одинаково пустым рюкзаком, — и
// решение обязано разойтись по одному признаку: стреляет он по типу или нет.
//
// NoAI, а не живой эндермен, нарочно: эндермен телепортируется, и сцена не
// смогла бы сказать ни где он, ни про него ли было решение.

// (н1) Крипер, который не может ни подойти, ни выстрелить. Стена не встанет —
// блоков нет, — и это ровно та развилка, на которой поход умер: отказаться
// нельзя, потому что отказ отправит драться с тем, кого не бьют.
async function caseScenery () {
  console.log('\n=== (н1) моб, который ни разу не тронул: лезть мимо ===')
  await drift()
  await kit([
    'minecraft:iron_pickaxe 2', 'minecraft:cooked_beef 8',
    'minecraft:iron_helmet 1', 'minecraft:iron_chestplate 1'
  ])
  await cmd(`/tp @s ${DRIFT.x}.5 ${DRIFT.y} ${DRIFT.z}.5`)
  await sleep(1500)
  await heal()
  const hp0 = await markHealth()
  const from = await pos()
  await cmd('/kill @e[type=!player]')
  const seen = mark()
  await cmd(`/summon minecraft:creeper ${DRIFT.x + 8}.5 ${DRIFT.y} ${DRIFT.z}.5 {NoAI:1b}`)
  await sleep(1200)

  const alive = await mobsAround(16)
  check('крипер в мире есть (арена цела)', alive.some(m => /creeper/i.test(m.name)), alive)

  const r = await climbOut('подъём мимо крипера')
  const at = await pos()
  const hp1 = await health()
  const first = (r.first.met || [])[0] || {} as Record<string, any>

  check('увидел его', (r.first.met || []).length > 0, r.first.met)
  check('назвал его декорацией, а не причиной', first.what === 'мимо', r.first.met)
  check('и сказал, почему стена не встала', !!first.why, r.first.met)
  check('не отказался «спиной к нему»', !/спиной к нему/.test(r.first.stopped || ''), r.first.stopped)
  check('полез и вылез', (at.y - from.y) > 0 && r.detail.out === true,
    { from: from.y, at: at.y, out: r.detail.out })
  check('доложил об этом в note', /мимо .* полез не останавливаясь/.test(r.first.note || ''), r.first.note)
  check('жив и не тронут', hp1 >= hp0 && since(seen, 'damage').length === 0,
    { hp0, hp1, события: since(seen).map(e => e.type) })
  console.log('   met: ' + JSON.stringify(r.first.met))

  // (н2) Тот же неподвижный моб на том же расстоянии и тот же пустой рюкзак —
  // но стрелок. Он тоже ни разу не выстрелил (NoAI), и это важно: правило не
  // должно сводиться к «уже ударил», иначе первая стрела всегда будет за счёт
  // бота. По типу он бьёт с дистанции — значит отказ обязан остаться.
  console.log('\n--- он же неподвижный, но стрелок: отказ обязан остаться ---')
  await drift()
  await kit([
    'minecraft:iron_pickaxe 2', 'minecraft:cooked_beef 8',
    'minecraft:iron_helmet 1', 'minecraft:iron_chestplate 1'
  ])
  await cmd(`/tp @s ${DRIFT.x}.5 ${DRIFT.y} ${DRIFT.z}.5`)
  await sleep(1500)
  await heal()
  const hp2 = await markHealth()
  const before2 = await pos()
  await cmd('/kill @e[type=!player]')
  const seen2 = mark()
  await cmd(`/summon minecraft:skeleton ${DRIFT.x + 8}.5 ${DRIFT.y} ${DRIFT.z}.5 {NoAI:1b}`)
  await sleep(1200)

  const alive2 = await mobsAround(16)
  check('скелет в мире есть (арена цела)', alive2.some(m => /skeleton/i.test(m.name)), alive2)

  const r2: any = await step('подъём при неподвижном стрелке', 'surface',
    { targetY: DRIFT.top, timeoutSeconds: 60 })
  const d2 = r2.detail || {} as Record<string, any>
  const at2 = await pos()
  const m2 = (d2.met || [])[0] || {} as Record<string, any>

  check('не полез', (at2.y - before2.y) === 0 && (d2.climbed || 0) === 0,
    { from: before2.y, at: at2.y, climbed: d2.climbed })
  check('не счёл его декорацией', m2.what === 'не закрылся', d2.met)
  check('назвал причину опасности типом, а не ударом',
    /дистанции/.test(m2.danger || ''), d2.met)
  check('отказ на месте', /спиной к нему/.test(d2.stopped || ''), d2.stopped)
  console.log('   met: ' + JSON.stringify(d2.met))
  console.log(`   hp ${hp2} -> ${await health()}`)
}

// ------------------------------------------------------------------ запуск

ws.on('open', async () => {
  try {
    await call('connect')
    await cmd('/clear @s')

    await caseWell()
    await caseGround()
    await caseGroundWithTarget()
    await caseCave()
    await caseDeepDeath()
    await caseShallowLoot()
    await caseNearDeath()
    await caseLavaOverhead()
    await caseFloodedStair()
    await caseArcherBehindWall()
    await caseArcherCaged()
    await caseArcherInDrift()
    await caseWalkerInDrift()
    await caseNothingToWallWith()
    await caseDriftNoMob()
    await caseGravelOverhead()
    await casePackInTheOpen()
    await casePackInTheDrift()
    await caseScenery()

    // Последняя арена — колодец на сто семьдесят блоков вниз, и тело остаётся
    // на его дне. Возвращаем на каменную плиту, чтобы следующий прогон
    // начинался не с подъёма из чужой сцены.
    await cmd('/effect clear @s')
    await cmd('/tp @s 708.5 81 708.5')
    await cmd('/kill @e[type=!player]')
    // Прогон оставляет за собой две каменные плиты и личную точку
    // возрождения — на игру не влияет, но в мире это мусор.
    console.log('\nоставлено в мире: плиты 686..729 и 740..783, дипслейтовый колодец 802..841')
    console.log('точка возрождения 712,80,712; сложность выставлена в normal')
    console.log(`итог: ${failures ? failures + ' проверок провалено' : 'все проверки прошли'}`)
    if (failures) process.exitCode = 1
  } catch (e) {
    console.error('FAILED:', e.message)
    process.exitCode = 1
  } finally {
    ws.close()
  }
})
ws.on('error', e => { console.error('ws:', e.message); process.exitCode = 1 })
