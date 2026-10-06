'use strict'
const gameClock = require('./src/game-clock')
// Щит: ветка, которая в коде была, а в игре не была ни разу.
//
// В combat.js больше года стоял вызов bot.activateItem(true) против стрелков, и
// щита у бота при этом не было НИ РАЗУ — то есть ветку никто не выполнял. Хуже
// того, она не могла работать дважды подряд: щит искали через itemNamed(), а он
// смотрит bot.inventory.items() = слоты 9..44 (prismarine-windows/index.js:44),
// и надетый в off-hand щит лежит в слоте 45. Первый бой надевал щит, все
// следующие решали, что щита нет.
//
// Поэтому здесь мерится не «щит поднят», а урон. «Подняли» — это наш пакет;
// подтверждение приходит метаданными (living_entity_flags, бит 0x01 «рука
// занята» и 0x02 «рука левая»), а погашенный удар — звуком item.shield.block.
// И то и другое считает combat.makeShield, а сцена смотрит на хп.
//
// КАК МЕРЯЕТСЯ. Три захода подряд сравнивали «прогон со щитом» с «прогоном без»
// и тонули в разбросе арены: 12 секунд обстрела дали 1.5 хп против 1, то есть
// разницу в одну стрелу. Поэтому сравнение переехало ВНУТРЬ одного боя —
// shield: 'measure' держит блок фазами по три секунды, и обе колонки урона
// набираются под одними и теми же стрелами. Заодно этот режим не преследует, и
// поэтому ров, которым бот удерживался от сближения, больше не нужен: он же его
// и портил — моб на кромке ямы сбрасывал пять тиков непрерывной видимости,
// нужные RangedAttackGoal, и почти не стрелял.
//
// ЦЕНА. Пока щит поднят, бот не бьёт. Поэтому в каждом случае печатается не
// только «сколько хп сэкономили», но и темп: секунд контакта на удар. Щит,
// который спас 3 хп и удвоил время боя, своей цены не стоит.
//
// ГРАБЛИ (оплачены другими сценами, повторять не будем):
//   * /kill @e видит только прогруженные чанки, поэтому чистка идёт СТОЯ в
//     арене, и третий раз — вплотную перед призывом, но ДО mark(), чтобы наш
//     же мусор не попал в замер;
//   * координаты в командах — через ПРОБЕЛ;
//   * /fill молчит в непрогруженных чанках, поэтому сначала /tp, потом пауза,
//     потом заливка; объёмы мелкие (за 32768 блоков /fill тоже молча отказывает);
//   * /clear @s первым делом: в полный рюкзак /give роняет предмет на землю.
//     Он же обнуляет слот 45 — иначе щит доживал бы до следующего случая;
//   * любой ответ демона выгребает шину событий, поэтому события копятся на
//     транспорте, а не в месте проверки;
//   * лечим ТОЛЬКО instant_health и ТОЛЬКО до mark(): регенерация во время боя
//     маскирует ровно тот урон, который мы меряем;
//   * моба призываем ПОСЛЕ mark().
//
//   node daemon/try-shield.js
//   ND_SHIELD_SOUNDS=1 node daemon/try-shield.js   — плюс перепись имён звуков
//                                                    в отчёте каждого боя
//
// Нужен поднятый демон и бот в игре. Код возврата ненулевой, если хоть один
// случай пришёл [ПЛОХО].
const WebSocket = require('ws')

require('./arms-guard').farmOnly({ ws: [process.env.ND_WS] })
const ws = new WebSocket(process.env.ND_WS)
let id = 0
const pending = new Map()
const call = (method, params: any = {} as Record<string, any>) => new Promise<any>((resolve, reject) => {
  const rid = ++id
  pending.set(rid, { resolve, reject })
  ws.send(JSON.stringify({ id: rid, method, params }))
})

// Всё, что демон сказал сам. Собирается на транспорте: каждый ответ дренит
// шину, и событие, приехавшее с ответом на /give, иначе теряется навсегда.
const heard = []
const mark = () => heard.length
const since = (n, type) => heard.slice(n).filter(e => !type || e.type === type)

ws.on('message', raw => {
  const m = JSON.parse(raw.toString()); gameClock.follow(m.clock || m.result?.state?.clock || m.result?.clock)
  const p = pending.get(m.id)
  if (!p) return
  pending.delete(m.id)
  if (m.ok && m.result && Array.isArray(m.result.events)) heard.push(...m.result.events)
  m.ok ? p.resolve(m.result) : p.reject(new Error(m.error))
})

const sleep = ms => gameClock.sleep(ms)

async function cmd (text) {
  await call('say', { text })
  await sleep(600)
}

// ---------------------------------------------------------------- вердикты

let failures = 0
function check (label, ok, note = '') {
  if (!ok) failures++
  console.log(`  ${ok ? '[ OK ]' : '[ПЛОХО]'} ${label}${note ? ' — ' + note : ''}`)
}
// Число, а не приговор: часть замеров существует, чтобы попасть в отчёт, а не
// чтобы что-то запретить.
function report (label, note) {
  console.log(`  [ЦИФРА] ${label} — ${note}`)
}

// ------------------------------------------------------------------- арена

// x=2000: далеко от арен всех остальных прогонов (z -26..-4, 190..210,
// 300..329, 400..429, 600..630, 686..783; x=850 z=850..990; x=1300..1700 и
// x=1800/1900 у соседей), чтобы чужой мусор нельзя было принять за местность
// этого.
const BOX = ['1988 74 1988', '2014 89 2012']   // 27x16x25 = 10800
const ROOM = ['1989 80 1989', '2013 87 2011']  // 25x8x23 = 4600, пол y=79
const STAND = '2000.5 80 2000.5'

// ОДИН стрелок, в переднем секторе, где щит вообще что-то гасит. Трое — это
// перелёт, и он посчитан, а не подобран. Замер с тремя дал 12.3 хп за 5.1
// секунды выборки, то есть 0.80 хп/с на стрелка (для сравнения: тот же скелет
// за рвом давал 0.125 — ров глушил обстрел в шесть с половиной раз). Отсюда
// бюджет: старт 20 хп, залп N стрелков разом это ~3N хп, значит порог отхода
// приходится ставить на 3N+3, и на замер остаётся 20-(3N+3).
//
//   N=1 T=15с: урон ~12 хп, колонки 4.2 и 8.1, порог 6, бюджет 14 — влезает
//   N=1 T=18с: урон ~15 хп при бюджете 14 — уже нет
//   N=2 T=12с: урон ~20 хп при бюджете 11 — нет
//   N=3 (как было): урон ~29 хп при бюджете 8 — отсюда две смерти из трёх
//
// Единственная клетка, где хватает и на сигнал, и на выживание. Уверенность
// добирается не силой обстрела, а числом боёв: пять вместо трёх.
const ARCHERS_AT = ['2007.5 80 2000.5']
const WALKER_AT = '2003.5 80 2000.5'   // вплотную, контакт с первой секунды

// Скелеты не должны умирать: тогда окно замера всегда полной длины, в обоих
// плечах, и обрезанные прогоны исчезают как класс. Это ПОСТРОЙКА АРЕНЫ НА
// МОБАХ, а не лечение бота: правило «не лечи перед замером» запрещает чинить
// того, чей урон меряешь, — бота, — потому что регенерация маскирует ровно
// измеряемое. Резист на стрелках ничего в измеряемом не маскирует: он лишь не
// даёт бою кончиться раньше окна. amplifier 4 — это Resistance V, то есть
// полная неуязвимость к мечу.
const ARCHERS_IMMORTAL = '/effect give @e[type=skeleton] minecraft:resistance 120 4 true'

// Крыша обязательна: под открытым небом скелет загорается на рассвете и
// умирает сам, и тогда сцена меряет солнце, а не щит.
// Против стрелка брони нет вовсе. Шлем и ботинки — это 3 очка, около 12%
// срезки, то есть меньше разброса одной стрелы: они ничего не защищали, зато
// добавляли в замер второе смягчение того же урона. Полное железо оставлено
// только ближнему бою, где меряется не гашение, а темп.
const KIT_MELEE = [
  'minecraft:iron_sword 1',
  'minecraft:iron_helmet 1', 'minecraft:iron_chestplate 1',
  'minecraft:iron_leggings 1', 'minecraft:iron_boots 1',
  'minecraft:cooked_beef 4'
]
const KIT_ARCHER = [
  'minecraft:iron_sword 1',
  'minecraft:cooked_beef 4'
]

// kind:
//   range  — ровный пол и трое бессмертных стрелков в семи блоках. Рва здесь
//            больше нет, и это главный вывод прошлых трёх прогонов: ров развёл
//            бота со скелетом и заодно обнулил обстрел. RangedAttackGoal
//            стреляет только после пяти тиков НЕПРЕРЫВНОЙ видимости, а моб,
//            топчущийся на кромке шестиблочной ямы к цели, до которой нет
//            пути, сбрасывает этот счётчик снова и снова. Ожидали ~26 хп за 12
//            секунд, намерили 1.5 — расхождение в двадцать раз, и оно было не
//            про урон вообще. Устройство, разделявшее участников замера,
//            заглушило сам замер.
//            Держит бота на дистанции теперь не геометрия, а shield: 'measure'
//            — в нём бой не преследует (combat.js, chase()).
//   flat   — ровный пол: ближний бой, контакт с первой секунды.
async function arena (kind, { shield = false, pickaxe = false }: any = {} as Record<string, any>) {
  const kit = kind === 'range' ? KIT_ARCHER : KIT_MELEE
  await call('stop')
  await sleep(800)
  await cmd('/gamerule spawn_mobs false')
  await cmd('/gamerule advance_time false')
  await cmd('/time set 6000')
  // hard, а не normal: на normal скелет за 18 секунд снял 2 хп сквозь железо,
  // и мерить в этом нечего.
  await cmd('/difficulty hard')
  await cmd('/kill @e[type=!player]')

  await cmd(`/tp @s ${STAND}`)
  // @e видит только прогруженные чанки, поэтому чистить арену можно только
  // стоя в ней: kill до /tp вычищает ту, из которой уходим.
  await cmd('/kill @e[type=!player]')
  await sleep(3000) // дать чанкам доехать до заливки

  await cmd(`/fill ${BOX[0]} ${BOX[1]} minecraft:stone`)
  await cmd(`/fill ${ROOM[0]} ${ROOM[1]} minecraft:air`)

  await cmd('/clear @s')
  for (const give of kit) await cmd(`/give @s ${give}`)
  if (shield) await cmd('/give @s minecraft:shield 1')
  if (pickaxe) await cmd('/give @s minecraft:iron_pickaxe 1')

  await cmd(`/tp @s ${STAND}`)
  await sleep(2000)

  // Одеться ЯВНО, а не ждать автопилота. Прогон 2026-09-01 пришёл с
  // armor {head:null,...} и defense 0 при полном железе в наборе: /clear снимает
  // надетое, автопилот берётся за броню не чаще раза в 15 секунд и вовсе не
  // берётся, пока работает намерение, — а combat.fight одевает только оружие и
  // щит. То есть бой шёл на голом боте, и всякий замер «сквозь железо» был не о
  // железе. Ждать таймер — это и есть та самая грабля «включающее действие до
  // отметки», только с другой стороны.
  const dressed: any = await call('armor', {} as Record<string, any>).catch(e => ({ status: 'RPC', error: e.message }))
  if (dressed.status !== 'done') {
    console.log(`  ВНИМАНИЕ: одеться не вышло: ${dressed.error || dressed.status}`)
  }
  await sleep(600)
  await heal()
}

// Только мгновенное лечение и только до отметки. Регенерация тикает во время
// боя и съедает ровно тот урон, ради которого всё это.
async function heal () {
  for (let i = 0; i < 3; i++) {
    const st: any = await call('status')
    if (st.state.health >= 20) return
    await cmd('/effect give @s minecraft:instant_health 1 10 true')
    await sleep(400)
  }
  const st: any = await call('status')
  if (st.state.health < 20) console.log(`  ВНИМАНИЕ: старт с ${st.state.health} хп, а не с 20`)
}

const has = (state, name) => !!(state.inventory && state.inventory[name])

// perception.js отдаёт offHand отдельным полем через armor.readOffHand, то есть
// объектом {item, durability}. Терпим и голую строку: поле молодое, и сцена не
// должна краснеть из-за того, что его однажды упростят.
const offHandName = state => {
  const v = state && state.offHand
  if (!v) return null
  return typeof v === 'string' ? v : (v.item || null)
}
const offHandIs = (state, name) => offHandName(state) === name

// Обрезанный отступлением прогон нельзя сравнивать по хп: он просто короче.
// Всё сравнение обстрела идёт в хп/сек.
const rate = b => (b.seconds > 0 ? Math.round((b.lost / b.seconds) * 100) / 100 : null)

// ------------------------------------------------------------------- бой

// Один бой от призыва до ответа, с часами снаружи: без секунд «щит спас 3 хп»
// не значит ничего — три хп, купленные удвоением боя, это убыток.
async function bout (label, { kind, mob, at, params, shield = true, pickaxe = false, postSummon = [] }: any) {
  console.log(`\n=== ${label} ===`)
  await arena(kind, { shield, pickaxe })

  const before: any = await call('status')
  // Третья чистка — вплотную перед призывом и ДО отметки, чтобы дроп и трупы
  // предыдущего случая не попали в замер как события этого.
  await cmd('/kill @e[type=!player,type=!item]')
  const from = mark()
  for (const where of (Array.isArray(at) ? at : [at])) {
    await cmd(`/summon minecraft:${mob} ${where}`)
  }
  // Всё, что делает мобов пригодными для замера, — после призыва и после
  // отметки: до отметки их ещё нет, а свои же команды в измерение попасть не
  // должны.
  for (const line of postSummon) await cmd(line)

  const t0 = gameClock.now()
  const r: any = await call('fight', params).catch(e => ({ status: 'RPC', error: e.message }))
  const seconds = Math.round((gameClock.now() - t0) / 100) / 10
  const after = r.state || ((await call('status')) as any).state

  const d = r.detail || {} as Record<string, any>
  const s = d.shield || {} as Record<string, any>
  const died = (r.by && r.by.type === 'death') || since(from, 'death').length > 0
  // После смерти бот возрождается с 20 хп, и разность «было минус стало»
  // показывает НОЛЬ там, где случилось худшее: случай (а) приехал как
  // «хп 20 -> 20, потеряно 0», хотя тело погибло. Для погибшего прогона
  // потеря — это всё, что было.
  const lost = died
    ? Math.round(before.state.health * 10) / 10
    : Math.round((before.state.health - after.health) * 10) / 10

  const problem = r.status === 'failed' ? ` ← ${r.error}` : r.status === 'timeout' ? ' ← таймаут' : ''
  console.log(`  бой ${String(r.status).padEnd(11)} ${seconds}с${problem}${died ? '  ← УМЕР' : ''}`)
  console.log(`  итог: ${d.killed ? 'убил ' + d.killed : d.mode || (d.timeout ? 'не добил' : '—')}` +
    `, ударов ${d.swings ?? 0}, хп ${before.state.health} -> ${after.health} (потеряно ${lost})`)
  console.log(`  щит: ${s.note || 'блока про щит нет'}`)
  console.log(`  одёжка перед боем: ${JSON.stringify(d.armor ?? null)}`)
  console.log(`  левая рука: до боя ${JSON.stringify(before.state.offHand ?? null)}, ` +
    `после ${JSON.stringify(after.offHand ?? null)}${died ? '  (после смерти она пуста всегда)' : ''}`)
  if (d.stopped) console.log(`  остановка: ${d.stopped}`)
  if (d.survivesOn) console.log(`  на чём держится выживание: ${d.survivesOn}`)
  if (s.sounds) console.log(`  звуки за бой: ${JSON.stringify(s.sounds)}`)
  if (s.raises !== undefined) {
    console.log(`  щит, цифры: ${JSON.stringify({
      worn: s.worn, raises: s.raises, confirmed: s.confirmed, confirmMs: s.confirmMs,
      // Эти две строки — то, чего в прошлом прогоне не хватило, чтобы отличить
      // «щит не работает» от «сломан счётчик»: урон по колонкам и сколько
      // звуков вообще долетело. Печатать надо то, по чему делается вывод.
      hpUnderShield: s.hpUnderShield, hpOpen: s.hpOpen,
      hpPerSecUnder: s.hpPerSecUnder, hpPerSecOpen: s.hpPerSecOpen,
      blocked: s.blocked, soundsHeard: s.soundsHeard,
      upSeconds: s.upSeconds, facingSeconds: s.facingSeconds, openSeconds: s.openSeconds,
      contactSeconds: s.contactSeconds, secondsPerSwing: s.secondsPerSwing
    })}`)
  }

  return {
    label, r, d, s, died, lost, seconds,
    pre: d.armor || {} as Record<string, any>,
    before: before.state,
    after,
    killed: !!d.killed,
    swings: d.swings ?? 0
  }
}

const mean = (runs, pick) => {
  const xs = runs.map(pick).filter(v => typeof v === 'number')
  if (!xs.length) return null
  return Math.round((xs.reduce((a, b) => a + b, 0) / xs.length) * 10) / 10
}

// ------------------------------------------------------------------ случаи

// 15 секунд и shield: 'measure'. Три прошлых захода мерили «прогон со щитом
// против прогона без», и разница тонула в разбросе арены: 1.5 хп против 1 —
// это одна стрела. Здесь обе колонки набираются В ОДНОМ бою, фазами по три
// секунды, под одними и теми же стрелами с одного и того же расстояния, и
// разброс арены сокращается сам. Это и есть ответ на «дай сигнал, а не просто
// больше урона»: не крутилка, а устройство замера.
// retreatAtHealth 6, а не 4: между двумя проверками хп проходит тик боя, и
// залп успевает снять больше, чем 4. С тремя стрелками порог 4 бот дважды
// проскочил в ноль, и обе смерти обрезали фазу посреди замера — то есть портили
// ровно то парное сравнение, ради которого всё делалось. Плюс после
// возрождения левая рука пуста, и щита на ней уже нет.
const ARCHER = { target: 'skeleton', retreatAtHealth: 6, timeoutSeconds: 15, shield: 'measure' }
const WALKER = { target: 'zombie', retreatAtHealth: 3, timeoutSeconds: 45 }

ws.on('open', async () => {
  try {
    await call('connect')

    // --- (а) стрелки, щита нет вовсе: контроль ----------------------------
    // Одного прогона хватает: (а) больше не половина сравнения, а проверка
    // того, что без щита код не врёт. Само сравнение теперь живёт внутри (б).
    const bare = []
    for (let i = 1; i <= 1; i++) {
      bare.push(await bout(`а${i}. стрелок 15с, щита в рюкзаке нет`, {
        kind: 'range', mob: 'skeleton', at: ARCHERS_AT, shield: false,
        postSummon: [ARCHERS_IMMORTAL], params: ARCHER
      }))
    }
    for (const b of bare) {
      check(`а: без щита отчёт честен (${b.label})`, b.s.worn === false, b.s.note)
      check(`а: бой не сломался (${b.label})`, b.r.status !== 'failed', b.r.error || '')
    }

    // --- (б) тот же стрелок, щит есть -------------------------------------
    const armed = []
    for (let i = 1; i <= 5; i++) {
      armed.push(await bout(`б${i}. стрелок 15с, щит фазами по 3с`, {
        kind: 'range', mob: 'skeleton', at: ARCHERS_AT, shield: true,
        postSummon: [ARCHERS_IMMORTAL], params: ARCHER
      }))
    }
    for (const b of armed) {
      check(`б: щит доехал до off-hand (${b.label})`, b.s.worn === true, b.s.why || '')
      // confirmed считает сэмплер, который слушает весь бой, а не окно
      // ожидания внутри raise(). Поэтому ноль здесь означает «сервер молчал»,
      // а не «мы перестали слушать» — это разные диагнозы, и один из них
      // сегодня уже стоил нам ложного вывода на постановке блока.
      check(`б: сервер подтвердил подъём (${b.label})`,
        b.s.raises > 0 && b.s.confirmed > 0, `${b.s.raises}/${b.s.confirmed}`)
      // Факт мира, а не переход. Проверка «был в рюкзаке, потом пропал»
      // сломалась о собственную правку armor.js: автопилот теперь надевает щит
      // сам раз в 15 секунд и успевает сделать это, пока сцена строит арену, —
      // к отметке замера рюкзак уже пуст, и переход ловить нечего.
      // Смотрим состояние ДО боя, а не после: после смерти левая рука пуста
      // всегда, и проверка «щит на руке» превращалась в проверку «бот выжил».
      // Пять null подряд в прошлом прогоне не отличали «щит не надет» от
      // «щит потерян вместе с телом» — а это разные поломки.
      check(`б: щит был на левой руке к началу боя (${b.label})`,
        offHandIs(b.before, 'shield'),
        `до боя ${JSON.stringify(b.before.offHand ?? null)}, после ${JSON.stringify(b.after.offHand ?? null)}`)
    }
    // Тот самый поводок: SHIELD_CONFIRM_MS в combat.js стоит 600мс, и это
    // догадка до тех пор, пока её не измерили. Здесь она измерена — если
    // lateConfirms не ноль, окно надо расширять, а не считать щит сломанным.
    const worstLag = Math.max(0, ...armed.map(b => b.s.confirmMs || 0))
    const late = armed.reduce((n, b) => n + (b.s.lateConfirms || 0), 0)
    report('б: сколько сервер думал над подъёмом',
      `худшая задержка ${worstLag}мс при окне 600мс, опоздавших подтверждений ${late}`)

    const upTotal = armed.reduce((n, b) => n + (b.s.upSeconds || 0), 0)
    const faceTotal = armed.reduce((n, b) => n + (b.s.facingSeconds || 0), 0)
    report('б: щит стоял и куда смотрел',
      `поднят ${Math.round(upTotal * 10) / 10}с всего, из них лицом к цели ${Math.round(faceTotal * 10) / 10}с`)

    const blockedTotal = armed.reduce((n, b) => n + (b.s.blocked || 0), 0)
    const soundsTotal = armed.reduce((n, b) => n + (b.s.soundsHeard || 0), 0)

    // Свидетель по звуку — тот, которого может не быть. Прогон 2026-09-01: щит
    // поднят и подтверждён за 43мс, урон резал, звуков item.shield.block ноль.
    // В jar всё на месте (у щита выставлен block_sound, onBlocked играет его с
    // aconst_null, то есть всем; плагин sound в mineflayer загружен), но факт
    // сильнее вывода из исходников. Поэтому это ЦИФРА, а не приговор: сцена,
    // которая краснеет на ненадёжном свидетеле, перестаёт читаться.
    report('б: погашено по звуку', `${blockedTotal} при ${soundsTotal} услышанных звуках всего`)
    // Раньше эта ветка смотрела на hurtBare — урон в ПРОГОНАХ БЕЗ ЩИТА, — и
    // порог 3 был подобран под мягкую арену. На злой арене она объявила «скелет
    // почти не попадал» при 29 услышанных звуках и 13 потерянных хп: число, по
    // которому она выбирала ветку, никогда и не было про то, было ли что гасить
    // в прогонах СО щитом. Считаем теперь ровно то, о чём вопрос — сколько
    // урона вообще прилетело в бои со щитом, обе фазы вместе.
    const measurable = armed.reduce((n, b) =>
      n + (b.s.hpUnderShield || 0) + (b.s.hpOpen || 0), 0)
    // Одна стрела это ~2 хп, и на двух стрелах за прогон гасить действительно
    // нечего. Порог в четыре — это две стрелы, ниже которых любая ветка
    // диагностики говорила бы о шуме.
    const NOTHING_TO_BLOCK = 4
    if (!blockedTotal) {
      report('б: почему ноль погашенных', !soundsTotal
        ? 'за бой не долетело НИ ОДНОГО звука — дело не в щите, а в звуковом канале целиком'
        : measurable < NOTHING_TO_BLOCK
          ? `в бои со щитом прилетело всего ${Math.round(measurable * 10) / 10} хп — гасить было нечего, арену надо злее`
          : faceTotal < upTotal * 0.5
            ? 'щит стоял, но бот был к цели боком: блок гасит только спереди'
            : `прилетело ${Math.round(measurable * 10) / 10} хп, звуков ${soundsTotal}, бот лицом — значит именно ` +
              'item.shield.block до нас не доходит. Прогнать раз с ND_SHIELD_SOUNDS=1: в отчёт попадёт перепись имён')
    }

    // --- (б') та же поклажа, но щит запрещён: разница именно в щите --------
    const muzzled = await bout("б'. стрелок 15с, щит есть, но shield: 'never'", {
      kind: 'range', mob: 'skeleton', at: ARCHERS_AT, shield: true,
      postSummon: [ARCHERS_IMMORTAL],
      // shield: 'never' — это не режим замера, значит бой ПРЕСЛЕДУЕТ. Резист на
      // стрелках здесь не роскошь, а условие: иначе бот их зарубит за десяток
      // секунд и окно окажется вдвое короче, чем у плеча со щитом.
      params: { ...ARCHER, shield: 'never' }
    })
    // Надет он или нет — теперь решает автопилот, а не сцена: щит из набора он
    // наденет за время подготовки. Проверяем то единственное, что здесь наше:
    // поднят не был ни разу. Надетый, но ни разу не поднятый щит в ванили не
    // гасит ничего — то есть это даже более честный контроль, чем пустая рука.
    check("б': запрет соблюдён — щит не поднимался ни разу",
      !muzzled.s.raises && !muzzled.s.blocked, JSON.stringify(muzzled.s))

    // Сравнение между прогонами осталось как цифра, но не как приговор: именно
    // оно тонуло в разбросе арены три захода подряд.
    const open = bare.concat(muzzled)
    const rateBare = mean(open, rate)
    const rateArmed = mean(armed, rate)
    report('а против б: потеряно хп', `без щита ${mean(open, b => b.lost)}, со щитом ${mean(armed, b => b.lost)}`)
    report('а против б: хп в секунду (так честно при обрезанных окнах)',
      `без щита ${rateBare}, со щитом ${rateArmed}`)
    report('б: между прогонами (справочно, тонет в разбросе арены)',
      `${rateBare} -> ${rateArmed} хп/сек`)

    // Тот же вопрос, но внутри одного боя и без контрфактики: пока блок стоял
    // против того времени, пока он был опущен. Это и есть замена сломанному
    // счётчику погашенных — свидетель, который есть всегда, потому что считается
    // из хп, а хп видно.
    // ГЛАВНОЕ СРАВНЕНИЕ. Парное, внутри одного боя, под одними стрелами.
    const underRate = mean(armed, b => b.s.hpPerSecUnder)
    const openRate = mean(armed, b => b.s.hpPerSecOpen)
    // Погибший прогон в статистику не идёт: смерть обрывает фазу на случайном
    // месте, а после возрождения левая рука пуста — то есть у такого боя и
    // колонки обрезаны, и щита на второй половине не было вовсе.
    const paired = armed.filter(b => !b.died &&
      typeof b.s.hpPerSecUnder === 'number' && typeof b.s.hpPerSecOpen === 'number')
    const deaths = armed.filter(b => b.died).length
    if (deaths) report('б: прогонов выброшено из-за смерти', String(deaths))
    const wins = paired.filter(b => b.s.hpPerSecUnder < b.s.hpPerSecOpen).length
    report('б: урон в секунду под щитом против опущенного (в одном бою)',
      `${underRate} против ${openRate}, боёв с обеими фазами ${paired.length} из ${armed.length}`)
    report('б: сколько урона вообще было, чем меряем',
      `под щитом ${mean(armed, b => b.s.hpUnderShield)} хп за ${mean(armed, b => b.s.upSeconds)}с, ` +
      `без щита ${mean(armed, b => b.s.hpOpen)} хп за ${mean(armed, b => b.s.openSeconds)}с`)

    // Обе фазы обязаны набраться, иначе сравнивать нечего и красное здесь —
    // про арену, а не про щит.
    check('б: в бою набрались обе фазы, есть что сравнивать', paired.length === armed.length,
      `${paired.length} из ${armed.length}` + (deaths ? `, погибших ${deaths}` : ''))
    // Вердикт несёт свою выборку прямо в строке — и не только СКОЛЬКО боёв, но
    // и КАКИХ: «3 из 5, погибших 2» честно по числу и при этом означает один
    // чистый бой. Отдельно от него — проверка, и она красная только на том, что
    // действительно поломка. «Разницы не нашли» поломкой не является: это
    // результат, и печатать его красным значит приучать читателя листать мимо.
    const cut = paired.length ? Math.round((1 - underRate / (openRate || 1)) * 100) : null
    report('б: ВЕРДИКТ по щиту против стрелка', !paired.length
      ? `чистых боёв нет вовсе (${armed.length} прогонов, погибших ${deaths}) — вывода нет`
      : paired.length < 3
        ? `чистых боёв всего ${paired.length} из ${armed.length} (погибших ${deaths}) — для вывода мало`
        : wins > paired.length / 2 && cut >= 15
          ? `щит режет урон примерно на ${cut}% — ${underRate}/с под щитом против ${openRate}/с без, ` +
            `${wins} чистых боёв из ${paired.length} в одну сторону`
          : wins < paired.length / 2 && cut <= -15
            ? `под щитом урон ВЫШЕ (${underRate}/с против ${openRate}/с) в ${paired.length - wins} боях ` +
              `из ${paired.length} — так быть не должно, это поломка, а не результат`
            : `на ${paired.length} чистых боях разницы не видно ни в одну сторону: ${underRate}/с под щитом ` +
              `против ${openRate}/с без, в пользу щита ${wins} боёв из ${paired.length}`)

    // Красное — только если щит делает ХУЖЕ. Это единственный исход, который
    // означает ошибку в коде, а не свойство мира.
    if (paired.length >= 3) {
      check('б: щит не делает хуже', !(wins < paired.length / 2 && cut <= -15),
        `${underRate}/с под щитом против ${openRate}/с без, выборка ${paired.length}`)
    }

    // --- (в) щит против зомби вплотную ------------------------------------
    // По три прогона на плечо, а не по два. Первый заход дал 6.3с против 8.9с
    // и 0 против 0 по хп — это уже похоже на приговор ближнему щиту, но на
    // выборке в два боя с зомби так же выглядит и обычный разброс.
    const meleeOpen = []
    for (let i = 1; i <= 3; i++) {
      meleeOpen.push(await bout(`в${i}. зомби вплотную, без щита`, {
        kind: 'flat', mob: 'zombie', at: WALKER_AT, shield: true,
        params: { ...WALKER, shield: 'never' }
      }))
    }
    const meleeShield = []
    for (let i = 1; i <= 3; i++) {
      meleeShield.push(await bout(`в${i}. зомби вплотную, щит между ударами`, {
        kind: 'flat', mob: 'zombie', at: WALKER_AT, shield: true,
        params: { ...WALKER, shield: 'always' }
      }))
    }
    for (const b of meleeShield) {
      check(`в: со щитом бот всё равно бьёт (${b.label})`, b.swings > 0, `ударов ${b.swings}`)
      check(`в: со щитом зомби всё равно умер (${b.label})`, b.killed || b.r.status === 'timeout',
        b.r.status)
    }
    report('в: время убийства зомби',
      `без щита ${mean(meleeOpen, b => b.seconds)}с, со щитом ${mean(meleeShield, b => b.seconds)}с`)
    report('в: потеряно хп',
      `без щита ${mean(meleeOpen, b => b.lost)}, со щитом ${mean(meleeShield, b => b.lost)}`)
    report('в: секунд контакта на удар',
      `без щита ${mean(meleeOpen, b => b.s.secondsPerSwing)}, ` +
      `со щитом ${mean(meleeShield, b => b.s.secondsPerSwing)}`)
    report('в: погашено ударов щитом', String(mean(meleeShield, b => b.s.blocked)))

    // Тот самый вывод, ради которого затевалось: если щит между ударами удлиняет
    // бой и не экономит хп, он в ближнем бою убыточен, и это надо записать в
    // описание mc_fight, а не оставлять мозгу гадать. Сцена печатает приговор
    // сама, чтобы он не выводился заново каждым читателем лога.
    const tOpen = mean(meleeOpen, b => b.seconds)
    const tShield = mean(meleeShield, b => b.seconds)
    const hOpen = mean(meleeOpen, b => b.lost)
    const hShield = mean(meleeShield, b => b.lost)
    const slower = tOpen !== null && tShield !== null && tShield > tOpen * 1.15
    const saves = hOpen !== null && hShield !== null && hShield < hOpen - 0.5
    const n = meleeOpen.length + meleeShield.length
    report('в: ВЕРДИКТ по ближнему щиту',
      slower && !saves
        ? `убыточен: бой длиннее (${tOpen}с -> ${tShield}с), хп не экономит (${hOpen} -> ${hShield}), ` +
          `боёв ${n}. Значит always против ходячих не советовать`
        : saves
          ? `платит за себя: хп ${hOpen} -> ${hShield} ценой ${tOpen}с -> ${tShield}с, боёв ${n} — решать мозгу`
          // Не «выборки мало» — на ${n} боях НЕ подтверждается ни то, ни это, и
          // это самостоятельный результат, а не отсутствие результата. Две
          // гипотезы («щит удлиняет бой» и «щит спасает хп») проверены и обе
          // не выдержали; писать в описание инструмента нечего, и это надо
          // говорить именно так, а не «данных не хватило».
          : `на ${n} боях разницы не видно ни в одну сторону: ${tOpen}с/${hOpen} хп без щита против ` +
            `${tShield}с/${hShield} хп со щитом. Ни «удлиняет», ни «спасает» не подтвердилось`)

    // --- (г) КОНТРОЛЬ: щита нет, код не врёт и не роняет бой ---------------
    const control: any = await bout('г. КОНТРОЛЬ: зомби, щита в рюкзаке нет', {
      kind: 'flat', mob: 'zombie', at: WALKER_AT, shield: false, params: WALKER
    })
    check('г: код не сказал, что поднял щит', control.s.worn === false && !control.s.confirmed,
      JSON.stringify(control.s))
    check('г: отчёт называет причину словами', /щит/.test(control.s.note || ''), control.s.note)
    check('г: бой не сломался и не завис', control.r.status !== 'failed' && !control.died,
      control.r.error || control.r.status)
    check('г: бот всё равно махал', control.swings > 0, `ударов ${control.swings}`)

    // --- (д) щит в руке мешает работать? ----------------------------------
    console.log('\n=== д. после боя со щитом: копать и строить ===')
    const work = await bout('д. зомби, щит надет, дальше работа', {
      kind: 'flat', mob: 'zombie', at: WALKER_AT, shield: true, pickaxe: true, params: WALKER
    })
    check('д: щит на руке после боя', work.s.worn === true, JSON.stringify(work.s.worn))
    check('д: шапка состояния показывает щит в левой руке', offHandIs(work.after, 'shield'),
      `offHand: ${JSON.stringify(work.after.offHand ?? null)}`)
    // Проверка держится на том, что арена теперь одевает бота явным mc_armor.
    // Если здесь снова пусто — значит сломалось одевание, а не поле шапки.
    check('д: шапка состояния показывает и броню', !!(work.after.armor && work.after.armor.torso),
      `armor: ${JSON.stringify(work.after.armor ?? null)}, defense: ${work.after.defense}`)
    // Арена одевает бота явным mc_armor, поэтому предполётный шаг боя обязан
    // сказать «уже одет» и не тратить кликов. Если он вдруг что-то надевает —
    // значит одевание в подготовке не сработало, и красное здесь правильное.
    // Правильных ответов здесь два, и оба означают одно: кликов не было.
    // already — «уже одет, менять нечего»; skipped «вплотную» — «моб в трёх
    // блоках, переодеваться поздно». Прошлая версия ждала только первый и
    // краснела на втором, хотя код отвечал верно, просто по другой причине.
    const noClicks = !work.pre.put || !work.pre.put.length
    const goodAnswer = work.pre.already === true || /вплотную/.test(work.pre.skipped || '')
    check('д: перед боем бот не переодевался зря', noClicks && goodAnswer,
      JSON.stringify(work.pre))
    check('д: надетое НЕ подмешано в рюкзак шапки', !has(work.after, 'shield'),
      'inventory должен оставаться «что можно потратить»')

    await cmd('/give @s minecraft:cobblestone 16')
    await sleep(800)
    const place: any = await call('place', { block: 'cobblestone' }).catch(e => ({ status: 'RPC', error: e.message }))
    console.log(`  поставить блок: ${place.status} ${JSON.stringify(place.detail ?? null)}` +
      (place.error ? ' ← ' + place.error : ''))
    check('д: со щитом в off-hand блок ставится', place.status === 'done', place.error || '')

    const mine: any = await call('mine', { block: 'cobblestone', count: 1, radius: 6 })
      .catch(e => ({ status: 'RPC', error: e.message }))
    console.log(`  копать: ${mine.status} ${JSON.stringify(mine.detail ?? null)}` +
      (mine.error ? ' ← ' + mine.error : ''))
    check('д: со щитом в off-hand копается', mine.status === 'done', mine.error || '')

    // Раньше здесь стояла косвенная проверка «пропал из рюкзака» и строка о
    // том, что в шапке щита не видно. Обе устарели: perception.js отдаёт
    // offHand отдельным полем через armor.readOffHand, так что спрашивать
    // можно прямо.
    check('д: после работы щит всё ещё на руке', offHandIs(mine.state, 'shield'),
      `offHand: ${JSON.stringify((mine.state && mine.state.offHand) ?? null)}`)

    await cmd('/kill @e[type=!player,type=!item]')
    await cmd('/effect clear @s')
  } catch (e) {
    console.error('FAILED:', e.message)
    failures++
  } finally {
    console.log(failures ? `\nПРОВАЛОВ: ${failures}` : '\nвсё зелёное')
    process.exitCode = failures ? 1 : 0
    ws.close()
  }
})
ws.on('error', e => { console.error('ws:', e.message); process.exitCode = 1 })
