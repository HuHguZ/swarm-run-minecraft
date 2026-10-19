// Рой: общее состояние драйвера — параметры с умолчаниями, доски команд, ямы и стены под лестницы, чертежи, передачи,
// планы и отметки, кулдауны, телеметрия, счётчики раунда. Части меняют его на месте; изменяемые счётчики — поля (sw.generation).
import { SwarmBoard } from '../../../daemon/src/swarm'
import type { SwarmDriverCtx } from './common'

export function createDriverState ({ bots, pos, alive, arena, home, hostile, log, arms = false, aggressive = false, hideouts = [], chestTops = [], perches = [], drops = () => [], announce = null, sandSpot = null, edgeOf = null, digSites = null, surfaceY = null, ladderSites = [], now = () => Date.now() }: any): SwarmDriverCtx {
  const boards = new Map<string, SwarmBoard>()
  // Ямы-ловушки раунда (dig): вскрытые клетки пола; край у врага — и обрыв модели, и своя дыра в 3.5 бл. от него.
  const holes: any[] = []
  // Подъём для команды (пользователь 14.10: «лестницу, по которой другие боты смогут залезать, ценнее одноразового столба»):
  // столбы, что построили лезущие (отрезок: вверх на 3+ почти на месте), — места под приставную лестницу (ladder_up);
  // готовые лестницы — общий путь наверх (строитель путей лезет по ним сам, и без своих блоков).
  // Стены под лестницы — из модели (watch.ts ladderSites), не из «столбов» лезущих (те не подтверждались: «стена кончилась»).
  const walls = new Map<string, any>(ladderSites.map(s => [s.key, { ...s }])), ladderRoutes: any[] = [], boxed = new Set<string>(), boxTries = new Map<string, number>()
  const blueprints = new Map<string, any>()
  const transfers = new Map<string, any>()
  const planned = new Map<string, Map<string, any>>()
  const plannedAt = new Map<string, number>()
  const visited = new Map<string, Map<string, number>>()
  const cooldown = new Map<string, number>()
  const telemetry = { observed: 0, built: 0, dug: 0, transfers: 0, searches: 0 }
  let generation = 0
  let positionQueries = 0
  let saidAt = 0
  // Поставленное своими за раунд не копается никогда: чертёж истекает, а кокон, стенка и укрытие стоят (лаборатория 13.10:
  // строитель, потеряв цель из виду, разобрал свой же кокон как «ближайший камень»).
  const placed = new Map<string, any[]>()
  // Обход мест с сундуками (натиск): лут-задача, а сундуков не видно — к ближнему месту колизея с сундуками (камеры,
  // галереи, лаборатория, оружейная, комнаты), где свои не были 45 с и до врага не меньше 16 бл.; случайное прочёсывание
  // уводило голых прямо к человеку (14.10: «бегут к игроку без вещей»).
  const toured = new Map<string, Map<number, { by: string; at: number; done?: boolean }>>()
  // До врага — 22+ (слабый, убежав, берётся за лут с 22 бл.: лут ближе снова гнал к врагу — «лут ↔ бегство» каждые 3–7 с).
  // Место занимается при выходе (кто идёт — его, 45 с): рой разбегается по разным местам, а не все к ближнему (15.10,
  // пользователь: «на спавне кружатся — должны сразу разбегаться по карте»). Не дошёл и не сдвинулся — место ему плохое на
  // минуту (верхние ярусы пешком недостижимы: бот каждые 4 с шёл к тому же). Высота дороже расстояния.
  const tourBad = new Map<string, number>()
  // Нет пути к цели в обход врага — не пробовать, пока обстановка та же: бот и каждый из свежих врагов на месте (в 2 бл.)
  // и врагов столько же. Не срок (пользователь 15.10: «отбежал на такую-то дистанцию — тогда меняй режим, а не по времени»).
  const blockedRoutes = new Map<string, any>()
  // Сундук, взятый дочиста или найденный пустым, пуст, пока арена его не пополнила (refill — уведомление из arena/loot.ts),
  // а не «через минуту снова» (пользователь 14.10: «лазают в пустые сундуки»; 15.10: режим — по событию мира, не по часам).
  // Остаток, который не влез в рюкзак, этому боту не повторять, пока рюкзак не изменился.
  const emptyChests = new Set<string>(), fullFor = new Map<string, string>()
  // Сундук под рукой (5 бл., тот же ярус): известный — верхние места колизея и виденные лутом; не пустой по нашему знанию и
  // не отказавший этому боту на том же месте. Его берут раньше любого приказа (пользователь 16.10: «залез наверх, а
  // незеритовые вещи не взял» — бой пришёл в ту же секунду, бот слез и дрался в слабом).
  const knownChests = new Map<string, any>()
  // Оценка «не вытяну» — симуляция боя на 600 тиков; на каждый ответ статуса (40 тел — ~160/с) её не пересчитывать: 250 мс.
  const unsafeCache = new Map<string, { at: number; v: boolean }>()
  return { bots, pos, alive, arena, home, hostile, log, arms, aggressive, hideouts, chestTops, perches, drops, announce, sandSpot, edgeOf, digSites, surfaceY, ladderSites, now,
    boards, holes, walls, ladderRoutes, boxed, boxTries, blueprints, transfers, planned, plannedAt, visited, cooldown, telemetry, generation, positionQueries, saidAt, placed, toured, tourBad, blockedRoutes, emptyChests, fullFor, knownChests, unsafeCache }
}
