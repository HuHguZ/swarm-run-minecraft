// Инструменты MCP — стройка, склад, ферма, езда, механизмы.
import { z } from 'zod'
import type { Toolkit } from '../toolkit.js'

const XYZ = z.object({ x: z.number(), y: z.number(), z: z.number() })

function register ({ tool }: Toolkit): void {
  tool(
    'mc_build',
    'Строить: от хижины на первую ночь до замка. Тело само ставит блоки с нужной ориентацией (ступени, двери, кровати, ' +
    'сундуки, таблички, факелы на стене), копает где надо, ставит и разбирает леса под высокое и не замуровывает себя — ' +
    'дверь ставит последней и снаружи. Постройка — это kind (готовая) или plan (свой, из частей).\n' +
    'КАК ДОГОВАРИВАТЬСЯ С ИГРОКОМ. Сначала mode=preview: место (выбирает само, если не дал origin), размер, смета — ' +
    'materials (сколько чего нужно ещё поставить), have (сколько есть), short [{what, count, have, inChests, craft}] — ' +
    'чего не хватает с учётом сундуков рядом и с рецептом словами, substitutions — что заменено и почему (нет ступеней — ' +
    'крыша уступами из полного блока; нет двери — проём; нет стекла — окна заложены), etaSeconds, entrance (где вход) и ' +
    'готовая фраза say — её можно отдать в чат как есть. Место и план preview запоминает: следующий build с теми же ' +
    'параметрами строит ровно это. Решай и говори игроку: строим / принеси вот это / давай меньше (width, depth) / из ' +
    'другого (material).\n' +
    'mode=build (по умолчанию) — строить. Если чего-то не хватает, ОТКАЗЫВАЕТ ДО ТОГО, КАК ТРОНУТ МИР: built=false, ' +
    'need {what, count, have} и stopped начинается «НЕ СТРОЮ». Недостающее из сундуков в 12 блоках берёт само. В воде, у ' +
    'лавы и без кирки по камню не строит — тоже отказ с причиной.\n' +
    'Долгая работа (дом ~2 мин, замок дольше) штатно встаёт на полпути: built=false, left — сколько клеток осталось, ' +
    'why {причина: сколько}, skippedAt [{at, block, why}]. Повтор (тот же вызов или mode=resume) ДОДЕЛЫВАЕТ, а не строит ' +
    'второй дом рядом: место, поворот и план лежат в памяти, готовые клетки пропускаются (тот же заказ по уже готовой ' +
    'постройке в 64 блоках — это проверка и починка её, а не вторая; вторую рядом — fresh=true). placed/dug — что сделал этот ' +
    'вызов, total/standing — всего клеток и сколько стояло до него, timing {walk, place, dig} — куда ушло время. ' +
    'Готовое записывается в память местом под именем (name, по умолчанию «дом», «склад»…).\n' +
    'kind: hut — укрытие на первую ночь (5×5, плоская крыша, дверь или проём, факел; из земли/булыжника/досок); house — ' +
    'дом с полом, каркасом из брёвен, окнами, дверью, двускатной крышей со свесом (roof=hip|flat), светом, furnish=true — ' +
    'кровать, сундук, верстак; dugout — землянка: сам ищет склон и КОПАЕТ комнату в нём, заделывая дыры; mine_room — ' +
    'комната-база под землёй прямо перед телом (direction — куда копать), заделывает пещеры, факелы, furnish; storage — ' +
    'склад: ряд сундуков с табличками категорий над каждым (categories: ores/руда, blocks/блоки, food/еда, gear/инструменты, ' +
    'mob/мобьё, rare/редкое, misc/разное; без categories — по тому, что есть в рюкзаке), потом mc_sort; castle — стена с ' +
    'зубцами, угловые башни, ворота с аркой, лестница на стену (width 9..31).\n' +
    'material: порода дерева (oak, spruce, birch, dark_oak, cherry…) или камень (cobblestone, stone_bricks, ' +
    'cobbled_deepslate, bricks, sandstone…), по умолчанию — чего больше в рюкзаке. front — куда смотрит вход (по умолчанию ' +
    'к телу). mode=kinds — справка без мира; mode=plan kind=… — чертёж частями без места, чтобы подправить и отдать как plan.\n' +
    'plan — свой проект: список частей с координатами ОТ угла (y=0 — земля): box{from,to,block,hollow}, walls, floor, line, ' +
    'clear (выкопать), seal (заделать только дыры), block{at,block,facing,half,axis}, stairs{from,to,block,facing,half}, slab, ' +
    'door{at,facing}, window, torch{at,facing — от стены}, lantern{at,hanging}, bed{at,facing}, chest{at,facing}, ' +
    'sign{at,facing,text:"строка|строка"}, ladder{from,to,facing}, crenel (зубцы через один), roof{from,to — прямоугольник ' +
    'стен на уровне их верха, style gable|hip|flat, axis, overhang, block — ступени, ridge, gable}. Вход рисуй на юг (+z), ' +
    'а front повернёт всё вместе с ориентацией. Поздняя часть перекрывает раннюю (окно вырезает стену).',
    {
      mode: z.enum(['build', 'preview', 'resume', 'kinds', 'plan', 'status', 'forget']).optional(),
      kind: z.enum(['hut', 'house', 'dugout', 'mine_room', 'storage', 'castle']).optional(),
      material: z.string().optional(),
      width: z.number().min(3).max(31).optional(),
      depth: z.number().min(3).max(17).optional(),
      height: z.number().min(2).max(8).optional(),
      roof: z.enum(['gable', 'hip', 'flat']).optional(),
      front: z.enum(['north', 'south', 'east', 'west']).optional(),
      direction: z.enum(['north', 'south', 'east', 'west']).optional(),
      furnish: z.boolean().optional(),
      door: z.boolean().optional(),
      windows: z.boolean().optional(),
      categories: z.array(z.string()).optional(),
      double: z.boolean().optional(),
      origin: XYZ.optional(),
      radius: z.number().min(4).max(32).optional(),
      plan: z.array(z.looseObject({ type: z.string() })).optional(),
      name: z.string().optional(),
      fresh: z.boolean().optional(),
      chests: z.boolean().optional(),
      fallback: z.boolean().optional(),
      timeoutSeconds: z.number().min(20).max(600).optional()
    },
    'build'
  )

  tool(
    'mc_sort',
    'Разложить по категориям рюкзак и сундуки склада: руда и слитки, блоки, еда, инструменты/оружие/броня, мобьё, редкое, ' +
    'разное. Какой сундук чей — по табличке при нём (над сундуком или на его передней грани), по памяти склада из ' +
    'mc_build kind=storage, а сундукам без таблички категории раздаются по порядку, и табличку тело вешает само ' +
    '(label=false — не вешать). Чужое из сундука забирает и несёт в свой — за несколько кругов (passes).\n' +
    'Снаряжение и запасы остаются при теле (кирки, броня, оружие, 16 еды, факелы, 64 булыжника, 8 палок — тот же список, ' +
    'что у mc_stash); everything=true — отдать всё. Ответ: chests [{at, category, label, put, took, slots/of}], moved, ' +
    'kept — что оставил при себе, noHome — чему не нашлось сундука (нет ни его категории, ни «Разного»), misplaced — чужое, ' +
    'которое не влезло в свой сундук и осталось при теле. radius — где искать сундуки (12).',
    {
      radius: z.number().min(4).max(24).optional(),
      everything: z.boolean().optional(),
      label: z.boolean().optional(),
      at: XYZ.optional(),
      timeoutSeconds: z.number().min(20).max(600).optional()
    },
    'sort'
  )

  tool(
    'mc_sign',
    'Табличка с текстом. Если на x,y,z уже табличка — переписать её (сервер пускает, если она не покрыта воском). Если там ' +
    'твёрдый блок — повесить новую на его грань facing (по умолчанию на ту, что к телу); если воздух — поставить ' +
    'стоячую (или настенную с facing — от стены). text — до 4 строк через | по 15 знаков (длиннее в игре не видно, ' +
    'обрезанное вернётся в cut). Нужна табличка в рюкзаке (6 досок + палка = 3). Ответ: at, placed/rewrote, text — ' +
    'что реально написано на табличке по данным сервера {front, back}.',
    {
      x: z.number(),
      y: z.number(),
      z: z.number(),
      text: z.string(),
      facing: z.enum(['north', 'south', 'east', 'west']).optional()
    },
    'sign'
  )

  tool(
    'mc_farm',
    'Грядки и огород. Тело работает только с тем, что ВИДИТ (заслонённую клетку своего поля сходит посмотреть), по полю ' +
    'ходит без прыжков — прыжок на грядку её топчет.\n' +
    'mode=status (по умолчанию, хода не стоит) — что видно в radius: farmland (wet/dry/empty), crops {культура: {planted, ' +
    'ripe, ages, max}} — спелость это max свойства age, у пшеницы/моркови/картошки 7, у свёклы 3; tall {sugar_cane|bamboo|' +
    'cactus: {columns, cut}} — сколько столбов выше корня; fruit — арбузы/тыквы у стеблей; water; warn — холодный биом: ' +
    'открытая вода замёрзнет под тиками, нужен факел не дальше 4 блоков от воды или крыша.\n' +
    'mode=plot — поле с нуля: at {x,y,z} — центр НА УРОВНЕ ЗЕМЛИ (сам блок земли), по умолчанию в radius+2 перед телом; ' +
    'выкапывает лунку в центре и льёт воду (water_bucket, а с пустым ведром сам наберёт из видимой воды), срезает траву, ' +
    'пашет квадрат (2·radius+1)², radius 1..4 (по умолчанию 4 → 9×9, 80 грядок: вода поит ровно на 4 клетки, ' +
    'FarmBlock.isNearWater) и сажает что есть (seed — что именно; seed=false — не сажать). Мотыга: удар по земле = 1 ' +
    'прочности, деревянная — 59 клеток, каменная — 131; сломалась — вспаханное всё равно засеет, stopped назовёт остаток и ' +
    'need.\n' +
    'mode=till — вспахать землю/траву у воды в radius (без воды в 4 блоках НЕ пашет: сухая грядка высохнет — stopped скажет, ' +
    'и dryNear — сколько таких клеток); mode=plant — посадить на пустые грядки (seed: wheat_seeds, carrot, potato, ' +
    'beetroot_seeds, melon_seeds, pumpkin_seeds; sugar_cane — на землю/песок вплотную к воде; cactus — на песок, по бокам ' +
    'пусто; nether_wart — на песок душ; можно словами: wheat, carrot, melon, тростник); mode=bonemeal — костная мука на ' +
    'нерастущее (count штук, +2..5 стадий за штуку); mode=harvest — собрать спелое и СРАЗУ посадить обратно тем, что ' +
    'выпало (replant=false — не сажать), срезать тростник/бамбук/кактус над корнем (корень остаётся — вырастет снова), ' +
    'сломать арбузы и тыквы у стеблей (стебель не трогает), подобрать дроп. what — только эти культуры (wheat, sugar_cane…).\n' +
    'Ответ: tilled, weeded, planted {plantedAs}, bonemealed, harvested {что: сколько}, replanted, replantShort — чем не ' +
    'хватило пересадить, gained/spent — разница рюкзака, field — то же, что status, после работы; need {what,count,have} и ' +
    'stopped, если чего-то нет или ничего не сделал (с причиной: «спелого нет: wheat 80 (спелых 0, max age 7)» — жди или ' +
    'mode=bonemeal). Растёт только при свете от 8 или под небом. Долгая работа встаёт по timeoutSeconds (180) со stopped — ' +
    'тот же вызов продолжит с того, что осталось.',
    {
      mode: z.enum(['status', 'plot', 'till', 'plant', 'bonemeal', 'harvest']).optional(),
      at: XYZ.optional(),
      radius: z.number().min(1).max(24).optional(),
      seed: z.union([z.string(), z.boolean()]).optional(),
      what: z.string().optional(),
      count: z.number().min(1).max(400).optional(),
      replant: z.boolean().optional(),
      timeoutSeconds: z.number().min(20).max(600).optional()
    },
    'farm'
  )

  tool(
    'mc_ride',
    'Езда: лошадь (осёл, мул) и лодка. Транспорт считает само тело, как настоящий клиент: сервер двигает лошадь/лодку ' +
    'только по присланным координатам, поэтому едет честно — с коллизией, шагом лошади на 1 блок без прыжка, прыжком ' +
    'на 2 (если лошади хватает прыгучести), в обход воды и узостей; маршрут — свой A* по сетке лошади/лодки.\n' +
    'kind=horse|donkey|mule (по умолчанию horse). mode=status — какая лошадь рядом: horse {id, kind, tamed, saddled, ' +
    'speed, blocksPerSecond, jump}; mode=tame — приручить ближнюю видимую (или id) ЧЕСТНО: сесть и терпеть, пока не ' +
    'стерпит. Раз в ~2.5с лошадь бросает кубик: шанс = нрав%, нрав с 0 и +5 за каждый сброс, так что n-я посадка ' +
    'приручает с шансом 5·(n−1)% — обычно 4–8 посадок, tries (20) хватает почти всегда. Ответ tame {tries, bucked, ' +
    'tamed, seconds}. mode=saddle — приручить при нужде и надеть седло (saddle в рюкзаке; седло не крафтится: сундуки, ' +
    'рыбалка, торговля). mode=mount — и сесть. mode=go — и доехать до x,z (y — если важен уровень), слезть ' +
    '(stay=true — остаться в седле), tie=true — привязать к забору в 7 блоках (нужен lead). Ответ: route {nodes, ' +
    'complete, legs}, rode {seconds, ticks, jumps, at, left, avgSpeed}, arrived, dismounted; horse.jumpHeight — на ' +
    'сколько блоков она прыгает. mode=tie — привязать ближнюю приручённую к забору. mode=dismount — слезть с чего угодно.\n' +
    'kind=boat: mode=craft — лодка из 5 досок одной породы (верстак найдёт/поставит); mode=launch — спустить на воду в ' +
    '4 блоках (нет лодки — скрафтит); mode=mount — сесть; mode=go — доплыть до x,z: цель на суше — плывёт к воде у неё ' +
    '(в 12 блоках), смотрит на берег и высаживается, лодку разбивает и подбирает (pickup=false — оставить у берега). ' +
    'Ответ: launched, route {complete, legs, to, fromShore}, rode {seconds, bumps, at}, arrived, landed, onLand — ' +
    'сколько от точки высадки до x,z, pickedUp. mode=pickup — разбить и подобрать ближнюю пустую лодку. Вода не ' +
    'соединена до цели — stopped скажет, докуда доплыть можно.\n' +
    'Скорость лошади — её атрибут: speed×43 бл/с, от 4.9 до 14.6 (horse.blocksPerSecond), пешком 4.3; лодка по ' +
    'открытой воде до 8 бл/с. Долгое — timeoutSeconds (120), stopped и ' +
    'rode.left скажут, сколько осталось; тот же вызов продолжит.',
    {
      kind: z.enum(['horse', 'donkey', 'mule', 'boat']).optional(),
      mode: z.enum(['status', 'tame', 'saddle', 'mount', 'go', 'tie', 'dismount', 'craft', 'launch', 'pickup']).optional(),
      x: z.number().optional(),
      y: z.number().optional(),
      z: z.number().optional(),
      id: z.number().optional(),
      radius: z.number().min(2).max(48).optional(),
      range: z.number().min(0.5).max(8).optional(),
      tries: z.number().min(1).max(40).optional(),
      stay: z.boolean().optional(),
      tie: z.boolean().optional(),
      pickup: z.boolean().optional(),
      tame: z.boolean().optional(),
      force: z.boolean().optional(),
      timeoutSeconds: z.number().min(10).max(600).optional()
    },
    'ride'
  )

  tool(
    'mc_mechanism',
    'Механизмы из чертежа, которые тело строит само и потом ими пользуется. kind=cane (пока единственный) — самосрез ' +
    'тростника: ряд из length столбцов (1..8, по умолчанию 4). Столбец: почва у водяного жёлоба, тростник; над водой ' +
    'поршень головой к тростнику, на поршне наблюдатель, глядящий на ТРЕТИЙ блок тростника, за ними камень и провод по ' +
    'всему ряду. Дорос тростник до трёх — поршни ломают 2-й и 3-й блок, корень остаётся, дроп падает к корню и на ' +
    'дорожку со стороны тела. Раскладка проверена в игре: наблюдатель прямо над поршнем НЕ работает (импульс до поршня ' +
    'не доходит), а наблюдатель на 2-м блоке видит голову поршня и зацикливается.\n' +
    'mode=plan (хода не стоит) — materials и short: чего не хватает. mode=build — at {x,y,z} — почва первого столбца ' +
    '(по умолчанию в 2 шагах перед телом, на уровень ниже ног), facing — сторона света от дорожки к воде (по умолчанию ' +
    'куда смотрит тело), ряд идёт влево от facing. Тело вынимает лишнее, кладёт дорожку, дно и стенки жёлоба, почву, ' +
    'наливает жёлоб из 2 вёдер воды (нечётные клетки становятся источником сами), ставит поршни, провод, наблюдателей ' +
    '(поворот — взглядом, как у игрока) и сажает тростник. На столбец: поршень, наблюдатель, редстоун, тростник, ~4–6 ' +
    'булыжника; на ряд — 2 water_bucket. Не хватает — stopped и need до работы (force=true — строить сколько выйдет). ' +
    'Ответ: columns [{i, ok, height, bad}], ok — сколько столбцов собрано верно, steps {dug, placed, poured, planted, ' +
    'fails}. Ферма запоминается. mode=collect — пройти по дорожке ближней знакомой фермы (или at/facing/length) и ' +
    'подобрать срезанное: gained, seen, left. mode=status — columns (высота тростника, что сломано), drops. Растёт ' +
    'тростник на блок за 16 случайных тиков (SugarCaneBlock.randomTick, age 0..15), а случайный тик блоку достаётся ' +
    'раз в ~68 с (random_tick_speed 3): ~18 минут на блок, срез — 2 тростника со столбца раз в ~36 минут, только пока ' +
    'чанк прогружен (тело рядом).',
    {
      kind: z.enum(['cane']).optional(),
      mode: z.enum(['plan', 'build', 'collect', 'status']).optional(),
      at: XYZ.optional(),
      facing: z.enum(['north', 'south', 'east', 'west']).optional(),
      length: z.number().min(1).max(8).optional(),
      force: z.boolean().optional(),
      timeoutSeconds: z.number().min(20).max(600).optional()
    },
    'mechanism'
  )
}

export { register }
