// Умолчания флагов спидрана, доказанные замерами пакетом (21.10, координатор): ставятся, только если переменная не задана, —
// явное значение (в т.ч. =0) по-прежнему решает. Первый импорт обоих процессов: демона (src/index) и кампании (campaign/flags),
// раньше любых чтений process.env при импорте модулей.
// Пакет C5 потока ow (farm/results/claude-sim/s21/ow/flags-C5.txt, FLAGS.md): вход в Ад 3/18 и 3/18 (C5, C5b) против 0/12 без флагов;
// ND_OW_SCOUT_MS=0 + ND_OW_IRON_WANDER=0 — ведро вдвое раньше (медиана 12 против 26 мин). ND_OW_NETHER_STICKS — палки и железная
// кирка в набор Ада (просьба ne: кирки в Аду стираются за 3–5 мин). ND_OW_NIGHT_IRON (06:51): ночью под землёй с несобранным
// набором — этап iron целиком, как днём: скамья набора со снимков iron — 9/12 против 4/12, смертей 0 против 2. ND_OW_SHAFT_DESCENT (07:47):
// колодец 1×1 с чутьём вместо лестницы при спуске за железом — набор 10/12, медиана 8.7 мин против 9/12 и 12.4 (y16 к 3–4-й мин).
const DEFAULTS: Record<string, string> = {
  ND_OW_SCOUT_MS: '0', ND_OW_IRON_WANDER: '0', ND_NIGHT_STEP_MARGINAL: '1', ND_NIGHT_FAIL_KEY: '1',
  ND_CAST_SOURCE_RECOVER: '1', ND_CAST_SRC_SKIP: '1', ND_OW_SURFACE_WALK: '1', ND_OW_SURFACE_RECOVER: '1',
  ND_OW_LAVA_LOOK_EARLY: '1', ND_OW_LAVA_LOOK: '1', ND_OW_WATER_ROUTE: '1', ND_OW_PAUSE_CAUSE: '1',
  ND_NIGHT_CAVE_PRIOR: '0.01', ND_NIGHT_RELOCATE: '1', ND_OW_STAIR_HOME: '1', ND_OW_PREP_NEAR: '1',
  ND_OW_WATER_MEMORY: '1', ND_OW_SHIELD_KIT: '1', ND_OW_DEATH_RANGED: '1', ND_OW_DEATH_MELEE: '1',
  ND_OW_DEATH_WATER: '1', ND_OW_NIGHT_RELOCATE_REACH: '1', ND_OW_STAIR_RETRY_CAUSE: '1', ND_NIGHT_WATER_ROUTE_MEMORY: '1',
  ND_OW_TORCH_MATERIALS: '1', ND_OW_FALL_ARC: '1', ND_NIGHT_KIT_ROUTE: '1',
  ND_OW_NETHER_STICKS: '1', ND_OW_NIGHT_IRON: '1', ND_OW_SHAFT_DESCENT: '1',
  // ow3 (09:04) «ночь с набором»: набор → Ад на парных снимках 23/44 против 14/44 без проигрышей по парам; ночная скамья 8/15 против 3/15,
  // медиана 11.3 против 15.5 мин, смертей 3 против 5.
  ND_OW_NIGHT_KIT: '1', ND_OW_NIGHT_SKY_CAST: '1', ND_OW_DAWN_DAY: '1', ND_OW_SKY_LAVA_FIRST: '1', ND_OW_LAVA_TOWER: '20',
  ND_CAST_SAME_FAIL: '1',
  // ow3 (10:03) пакет G3 (s21/ow/flags-G3.txt, без вредных WATER_UP и NIGHT_DEEP): полные прогоны Ад 6/18 против 3/12, смертей 1/18
  // против 4/12, набор 15/18 против 7/12, железная кирка при входе 6/6 против 0/3 (KIT_PICK: 7 железа, кирка раньше щита).
  ND_OW_NIGHT_LOOK: '1', ND_OW_LAKE_WATER_LOOK: '1', ND_OW_CAST_LOOK: '1', ND_OW_BURIAL_STEP: '1', ND_OW_GRAVEL_SETTLE: '1',
  ND_OW_LAVA_EDGE: '1', ND_OW_SOFT_MARGIN: '1', ND_OW_IDLE_ANSWER: '1', ND_OW_KIT_PICK: '1', ND_OW_ENTER_LOWHP: '1',
  ND_OW_ICE_WATER: '1', ND_OW_CAST_SHAFT: '1',
  // ow3 (10:23): запас еды первого входа в Ад 4 вместо 6 — скамья набор → Ад 8/16 против 6/16, медиана 3.6 против 5.7 мин, смертей 2 против 5.
  ND_OW_PREP_FOOD: '4',
  // ow3 (11:26): щит восьмым слитком после кирки (просьба blz: иссушители без щита — 12 % прогонов) — скамья набора 8/11 против 8/12,
  // медиана 11.8 против 13.4 мин, смертей 1 против 3, щит скован 7/12 против 2/12.
  ND_OW_KIT_SHIELD: '1',
  // sr27 ow (27.10, farm/results/sr27/COORD.md): ND_DIG_RESTART — смена предмета в руке (урон кирки за прошлый блок, подбор в пустую
  // руку) начинает блок заново, как ваниль, а не рвёт копку: «Digging aborted» 6 на 11 прогонов против 32 на 9, столб вышки 5730 (40 мин)
  // не повторился. ND_SMELT_SPLIT + ND_OW_PLANK_FUEL — 8 слитков набора за 53 с против ~95 с. ND_OW_IRON_SNAKE — штреки железа змейкой,
  // а не квадратом по своим ходам (3292: 25 мин без руды → железо к 10-й мин, n=3).
  ND_DIG_RESTART: '1', ND_SMELT_SPLIT: '1', ND_OW_PLANK_FUEL: '1', ND_OW_IRON_SNAKE: '1',
}

// Наборы Ада, с которыми мерялись сцены потоков (06:56, просьба ne4: полные проходы шли без них, «бастион не узнан» и брут на 111-й мин
// int3): ne — farm/results/claude-sim/s21/ne/flags-n44.txt без KIT и без ND_HUNT_OPEN_GROUND (вреден, q9) — золото бастиона 14/14 на 5408;
// blz — s21/blz/flags-F.txt (третий заход: «вход → ≥ 6 стержней → наверху» 6/55, все на −2642). По одному флаги не доказаны —
// это конфигурация, в которой Ад вообще проходил; потоки развязывают их по ходу.
const NETHER: Record<string, string> = {
  ND_BASTION_SURFACE_ENTRY: '1', ND_BASTION_OBSERVED_ENTRY: '1', ND_BASTION_ENTRY_ON: '1', ND_BRUTE_GUARD: '1',
  ND_BASTION_TOOLS_PRICE: '1', ND_MAGMA_ESCAPE: '1', ND_SEALED_FLUID_GUARD: '1', ND_BASTION_LEVEL_PROBE: '1',
  ND_COVER_MOUTH_GUARD: '1', ND_BASTION_GOLD_EVIDENCE: '1', ND_BASTION_BLIND_TOWER: '1', ND_SEALED_BREACH: '1',
  ND_BASTION_TERRAIN_MEMORY: '1', ND_BASTION_ENTRY_TYPES: '1', ND_BASTION_FIRST_GOLD: '1', ND_BASTION_PRICE: '1',
  ND_BARTER_CARRIED_PHASE: '1', ND_BARTER_FIRST_BATCH: '1', ND_BARTER_FR_PRICE: '1', ND_BARTER_VISIBLE_TRADERS: '1',
  ND_BRUTE_MEMORY: '1', ND_BASTION_PIE_SEEK: '1', ND_NE_RECOVER: '1', ND_NE_STAY: '1', ND_BLZ_WALK_LEGS: '1',
  ND_SEALED_OPENING_MEMORY: '1', ND_LAVA_FALL_GUARD: '1', ND_BARTER_WALL_BOOTH: '1', ND_LAVA_NAV_GUARD: '1',
  ND_PIGLIN_GOLD_NEUTRAL: '1', ND_BARTER_TRADER_MEMORY: '1', ND_BASTION_TOUCH: '1', ND_BASTION_WALK_RECEIPT: '1',
  ND_BASTION_SEARCH_RESERVE: '1', ND_BARTER_OPEN_SITE: '1', ND_NE_NO_GIVEUP: '1', ND_BASTION_BRUTE_SIGN: '1',
  ND_BARTER_SEEK: '1',
  ND_SCOUT_HIGH: '1', ND_BLZ_PIE_FIRST: '1', ND_BLZ_DECK_BEARING: '1', ND_BLZ_OPEN_RING: '1',
  ND_BLZ_PRICED_LOOK: '1', ND_BLZ_TOOLS_PRICE: '1', ND_BLAZE_FR_LATE: '1', ND_BLAZE_SEEK_HEARD: '1', ND_BLAZE_SKELETON: '1',
  ND_BLAZE_FR_PICK: '1', ND_BLZ_CONT_CAUSE: '1', ND_BLZ_DIG_PRICE: '1', ND_BLZ_BASTION_DETOUR: '1', ND_BLAZE_STANCE: '1',
  ND_BLZ_TOOLS_NEAR: '1', ND_BLZ_FR_KEEP: '1', ND_BLZ_SEEK2: '1', ND_BLZ_CLIMB: '1', ND_BLZ_SPARE: '1', ND_BLZ_LAVA_FR: '1',
  ND_BLZ_EDGE_LAVA: '1', ND_BLZ_BRICK_FILL: '1', ND_BLZ_BLIND_LEGS: '1',
  // blz4 (09:01): глоток FR не рвут pathfinder/клатч — выпит 17/17 (было 41/69); домой по своему следу — 9.6 мин против 37.6;
  // поиск крепости лучами вдоль осей от портала — на 5730 крепость к 6–7-й мин в 6/6.
  ND_BLZ_DRINK_HOLD: '1', ND_BLZ_RETRACE: '1', ND_BLZ_AXES: '1',
  // blz5 (09:56) пакет S (s21/blz/flags-S.txt): на НАСТОЯЩЕМ наборе (1 FR, каменный меч, без щита) −2642 «вход → ≥ 6 стержней →
  // наверху» 4/7 против 0/14 у пакета O; по одному не мерены.
  ND_BLZ_RESERVE: '1', ND_BLZ_CLEAR_EXIT: '1', ND_BLZ_LAVA_FAR: '1', ND_BLZ_EXIT_FR: '1', ND_BLZ_EXIT_UNDER: '1',
  ND_BLZ_WOOD_WAY: '1', ND_BLZ_OPEN_LEGS: '1', ND_BLZ_NO_THRONE: '1', ND_BLZ_FR_BUDGET: '1', ND_BLZ_FR_RESERVE: '1',
  ND_BLZ_EXIT_TACTICS: '1', ND_BLZ_CROWD_RUN: '1', ND_SLIME_SIZE: '1', ND_BLZ_ROD_SWEEP: '1', ND_WITHER_HIDE: '1',
  ND_NETHER_TABLE_BACK: '1', ND_BLZ_DROP_PLINTH: '1',
}

// ND_SPEEDRUN_DEFAULTS=0 — без пакета (замер «как до 21.10»).
if (process.env.ND_SPEEDRUN_DEFAULTS !== '0') {
  for (const [name, value] of Object.entries({ ...DEFAULTS, ...NETHER })) if (process.env[name] === undefined) process.env[name] = value
}

export { DEFAULTS, NETHER }
