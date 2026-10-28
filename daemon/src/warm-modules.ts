// Прогрев ленивых модулей боя (28.10, Claude, стенд 15×15 cl28d): профиль остановок цикла событий в первую минуту раунда —
// 20% времени блоков (39 с на 29 процессов) — первая загрузка модулей прямо в бою: enchant ~400 мс, elytra/landing до 1 с,
// session/intent-runner ~270, enemy-wind-execute ~225 (Windows: разрешение имён — сотни stat). Выпуск ветра в первую минуту
// просрочен у 30–45% бросков против 15–26% дальше. Грузим их заранее, по одному модулю за проход цикла событий, — до боя.
// ponytail: список — из профиля (scratchpad prof3.js по farm/lag, ND_LAG_PROFILE=1); новый ленивый модуль в бою — дописать сюда.
export const WARM = [
  'enchant', 'elytra/landing', 'session/intent-runner', 'combat/enemy-wind-execute', 'pvp/combat-observe', 'combat/pearl-watch',
  'cache-scan', 'swarm-senses', 'combat/aerial-executor', 'swarm-work', 'combat/wind-out', 'swarm-position', 'combat/spear-wind',
  'pvp/team-assist', 'combat/pearl-response', 'pvp/cover', 'combat/aerial-lance', 'pvp/recovery', 'combat/wing-orbit'
]
export function warmModules (list = WARM, next: (fn: () => void) => void = setImmediate) {
  let i = 0
  const step = () => {
    if (i >= list.length) return
    try { require('./' + list[i]) } catch {}
    i++
    next(step)
  }
  next(step)
}
