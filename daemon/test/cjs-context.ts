// Контекст vm для собранного CommonJS-модуля: как обёртка Node, даёт и module, и exports (один и тот же объект).
// tsc пишет в начало каждого модуля Object.defineProperty(exports, '__esModule', …), а ES-экспорты — в exports.<имя>.
export function cjsContext<T extends Record<string, any>> (context: T): T & { exports?: any } {
  const ctx: any = context
  if (ctx && !('exports' in ctx)) ctx.exports = ctx.module ? ctx.module.exports : {}
  // Как у модуля Node: process виден всегда (флаги ND_* читаются через process.env внутри проверяемых функций).
  if (ctx && !('process' in ctx)) ctx.process = process
  return ctx
}
