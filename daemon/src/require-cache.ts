// Кэш разрешения относительных require (16.10, Claude-сим). Код демона зовёт require('./x') прямо в горячих циклах (geometry.bodyClear
// → require('../movement') на каждую клетку тела; планировщик спуска перебирает тысячи клеток). Node 24 на каждый такой вызов ищет
// package.json родителя (trySelf → getNearestParentPackageJSON → stat): профиль остановки (farm/lag, 16.10) — 11.5 с из 15 в
// internalModuleStat, цикл событий стоит, ферма lockstep падает «connected client stalled», в обычной игре тело застывает.
// Здесь имя файла запоминается на пару (родитель, запрос); уже загруженный модуль отдаётся из Module._cache как есть. Не загружен
// (круговая загрузка) или вынут из кэша (тесты) — обычный require.
const Module = require('module')
function installRequireCache () {
  if (Module.prototype.require._ndCached) return
  const original = Module.prototype.require
  const files = new Map()
  const cached = function (this: any, request: string) {
    if (typeof request === 'string' && (request.startsWith('./') || request.startsWith('../'))) {
      const key = this.filename + '\0' + request
      const file = files.get(key)
      if (file) { const m = Module._cache[file]; if (m && m.loaded) return m.exports }
      const exp = original.call(this, request)
      if (!file) { try { files.set(key, Module._resolveFilename(request, this)) } catch {} }
      return exp
    }
    return original.call(this, request)
  }
  cached._ndCached = true
  Module.prototype.require = cached
}
installRequireCache()
module.exports = { installRequireCache }
