// Кэш разрешения относительных require (16.10, Claude-сим). Код демона зовёт require('./x') прямо в горячих циклах (geometry.bodyClear
// → require('../movement') на каждую клетку тела; планировщик спуска перебирает тысячи клеток). Node 24 на каждый такой вызов ищет
// package.json родителя (trySelf → getNearestParentPackageJSON → stat): профиль остановки (farm/lag, 16.10) — 11.5 с из 15 в
// internalModuleStat, цикл событий стоит, ферма lockstep падает «connected client stalled», в обычной игре тело застывает.
// Здесь имя файла запоминается на пару (родитель, запрос); уже загруженный модуль отдаётся из Module._cache как есть. Не загружен
// (круговая загрузка) или вынут из кэша (тесты) — обычный require.
// Голые имена пакетов — так же (27.10, профиль боя 15×15: 78% остановок цикла — internalModuleStat, половина — heightAbove →
// require('vec3') на каждый вызов). Свой кэш Node (relativeResolveCache) пишется только при первой загрузке модуля из этого
// родителя; vec3 первым грузит другой файл — и каждый require отсюда снова ищет package.json. Встроенные (node:…, fs) — как есть.
import Module = require('module')
// Внутренности Module, которых нет в типах node: кэш загруженных, разрешение имени файла, метка своей обёртки require.
type ModuleInternals = typeof Module & { _cache: Record<string, any>; _resolveFilename (request: string, parent: any): string }
function installRequireCache () {
  if ((Module.prototype.require as typeof Module.prototype.require & { _ndCached?: boolean })._ndCached) return
  const original = Module.prototype.require
  const files = new Map()
  const cached = function (this: any, request: string) {
    if (typeof request === 'string' && !request.startsWith('node:') && !Module.isBuiltin(request)) {
      const key = this.filename + '\0' + request
      const file = files.get(key)
      if (file) { const m = (Module as ModuleInternals)._cache[file]; if (m && m.loaded) return m.exports }
      const exp = original.call(this, request)
      if (!file) { try { files.set(key, (Module as ModuleInternals)._resolveFilename(request, this)) } catch {} }
      return exp
    }
    return original.call(this, request)
  }
  cached._ndCached = true
  Module.prototype.require = cached
}
installRequireCache()
export { installRequireCache }
