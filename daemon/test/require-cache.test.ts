import test from 'node:test'
import assert from 'node:assert/strict'
import Module = require('module')
import { installRequireCache } from '../src/require-cache'

// Профиль боя 27.10 (стенд 15×15, farm/lag): 78% времени остановок цикла событий — internalModuleStat, половина — из
// heightAbove → require('vec3') на каждый вызов. Node 24 запоминает разрешение для родителя, только если модуль впервые загрузился
// из него; vec3 первым грузит другой файл — и каждый require отсюда снова ищет package.json (trySelf → stat).
test('require cache: a bare package name already loaded elsewhere is resolved once per parent, not on every call', t => {
  installRequireCache()
  const first = Module.createRequire(require.resolve('../src/paths'))('vec3') // первая загрузка — из другого родителя
  assert.equal(require('vec3'), first)
  const original = (Module as any)._resolveFilename
  let resolves = 0
  t.mock.method(Module as any, '_resolveFilename', function (this: any, ...args: any[]) { resolves++; return original.apply(this, args) })
  for (let i = 0; i < 100; i++) assert.equal(require('vec3'), first)
  assert.ok(resolves <= 1, `resolves: ${resolves}`)
  assert.equal(require('node:path'), require('path'), 'builtins still load')
})
