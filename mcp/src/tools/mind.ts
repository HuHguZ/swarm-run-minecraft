// Инструменты MCP — режим, характер, цель и память.
import { z } from 'zod'
import type { Toolkit } from '../toolkit.js'

function register ({ tool }: Toolkit): void {
  tool(
    'mc_play_mode',
    'Правила расхода ресурсов и выбора боёв. mode speedrun — мирных животных мечом, ' +
    'эндермена без стрел, стрелы сверх arrowReserve (16) можно расходовать; бой за дроп ' +
    'прекращается при выполненной цели; соседних мобов автоматически не зачищает. ' +
    'mode free — свободная совместная игра; при переходе из speedrun останавливает директор и передаёт управление от кампании. ' +
    'Режим и квоты сохраняются, текущие правила есть в заголовке playPolicy. ' +
    'resources — требуемые количества предметов, 0 отключает цель; foodTarget — запас еды (8). ' +
    'Без параметров — текущие правила. Меняй по намерению игрока, в том числе полученному через чат.',
    { mode: z.enum(['speedrun', 'free']).optional(), arrowReserve: z.number().int().min(0).max(4096).optional(),
      foodTarget: z.number().int().min(0).max(4096).optional(),
      resources: z.record(z.string(), z.number().int().min(0).max(4096)).optional() },
    'play_mode'
  )

  tool(
    'mc_temper',
    'Характер: как бот отвечает человеку, который его бьёт. Без параметров — показать. ' +
    'На первый удар отвечает с шансом firstHitChance (0..1, по умолчанию 0.35: случайно задел — простит), ' +
    'на второй за windowSeconds (30) — всегда. Бой ведёт автопилот сам, до fightSeconds (90), и бросает, когда ' +
    'обидчик не бьёт calmSeconds (12) и отошёл. retreatAtHealth — порог, на котором уходит жемчугом, если он есть. ' +
    'enabled:false — терпеть всё. Любое твоё намерение (mc_goto, mc_fight...) снимает такой бой. ' +
    'defend (по умолчанию true) — вступаться за игрока рядом, когда его бьёт моб: тело само бьёт именно этого моба, ' +
    'если свободно и у него самого хп от 10. Людей в чужой драке не трогает никогда.',
    {
      enabled: z.boolean().optional(),
      firstHitChance: z.number().min(0).max(1).optional(),
      windowSeconds: z.number().min(5).max(600).optional(),
      fightSeconds: z.number().min(10).max(300).optional(),
      calmSeconds: z.number().min(3).max(120).optional(),
      retreatAtHealth: z.number().min(1).max(19).optional(),
      defend: z.boolean().optional()
    },
    'temper'
  )

  tool('mc_set_goal', 'Записать текущую цель. Она попадает в шапку каждого ответа и переживает перезапуск.',
    { text: z.string() }, 'set_goal')

  tool(
    'mc_remember',
    'Записать что-то в журнал. Если указать place — координаты сохранятся под этим именем (база, шахта, портал).',
    { text: z.string(), kind: z.string().optional(), place: z.string().optional() },
    'remember'
  )

  tool(
    'mc_recall',
    'Прочитать память: цель, известные места, смерти, люди, и хвост журнала. Вызывать после перезапуска или компакции контекста.',
    { lines: z.number().min(5).max(200).optional() },
    'recall'
  )
}

export { register }
