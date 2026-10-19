// Части тела боя (src/pvp/duel-*.ts, turn-*.ts) для тестов-сцен: функции частей исполняются в vm, где их внешние
// имена (импорты модулей, константы правил) берутся из полей ctx — как раньше вырезанные из pvp.ts ветки.
// Ступень хода вызывается как stage(ctx, ctx): одна заготовка служит и контекстом боя, и кадром хода.
import { resolve } from 'node:path'
import { runInNewContext } from 'node:vm'
import { cjsContext } from './cjs-context'
import { partSource } from './source-fixture'

export const PVP_ENTRY = resolve(__dirname, '../src/pvp.js')
export const NEXT = 'next'

// pvpParts(ctx, ['turn-reach'], ['hopTurn']) → { hopTurn } — функции частей в контексте ctx.
export function pvpParts (ctx: Record<string, any>, parts: string[], names: string[]): Record<string, any> {
  const code = ['turn', ...parts].map(part => partSource(PVP_ENTRY, part)).join('\n')
  // В своей функции: повторный вызов на той же заготовке не объявляет имена частей второй раз. Vec3 частей —
  // фабрика vec3 из pvp/vec3.ts, как у собранной части (не подменяется заготовкой).
  return runInNewContext(`(Vec3) => {\n${code}\nreturn { ${names.join(', ')} }\n}`, cjsContext(ctx))(require('../src/pvp/vec3').Vec3)
}
