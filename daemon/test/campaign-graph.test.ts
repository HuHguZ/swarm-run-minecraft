'use strict'
import test = require('node:test')
import assert = require('node:assert/strict')
import * as fs from 'node:fs'
import path = require('node:path')
import ts from '@typescript/typescript6'

// Кампания разделена на части daemon/campaign/** (ES-модули). Тесты поведения исполняют их склейку одной областью видимости;
// здесь — то, чего склейка не видит: настоящий граф модулей после сборки грузится сам, без входа и без сокета, порядок этапов
// тот же, и ни одна часть не прочла при загрузке ещё не готовое значение соседа (const осталась бы undefined навсегда).
const BODY = path.join(__dirname, '../campaign')
const parts = (fs.readdirSync(BODY, { recursive: true }) as string[]).filter(f => f.endsWith('.ts')).sort()

test('the built campaign part graph loads without the entry and opens no socket', () => {
  const table: typeof import('../campaign/stages/table') = require('../campaign/stages/table')
  require('../campaign/stages/all')
  const loop: typeof import('../campaign/loop') = require('../campaign/loop')
  assert.equal(typeof loop.runCampaign, 'function')
  assert.equal((require('../campaign/rpc') as typeof import('../campaign/rpc')).ws, null)
  assert.deepEqual(table.STAGES.map(s => s.name), ['routeEnter', 'route', 'wood', 'stone', 'food', 'iron', 'water', 'cast', 'diamond',
    'obsidian', 'portal', 'prep', 'bastion', 'nether', 'pearls', 'eyes', 'endkit', 'stronghold', 'dragon'])
  assert.doesNotThrow(() => table.assertStageOrder())
})

test('every exported const of every campaign part is initialised after the graph loads', () => {
  for (const part of parts) require(path.join(BODY, part.replace(/\.ts$/, '')))
  for (const part of parts) {
    const tree = ts.createSourceFile(part, fs.readFileSync(path.join(BODY, part), 'utf8'), ts.ScriptTarget.Latest, true, ts.ScriptKind.TS)
    const consts = new Set<string>()
    for (const statement of tree.statements) {
      if (ts.isVariableStatement(statement) && !(statement.declarationList.flags & ts.NodeFlags.Let)) {
        for (const d of statement.declarationList.declarations) if (ts.isIdentifier(d.name) && d.initializer) consts.add(d.name.text)
      }
    }
    const mod = require(path.join(BODY, part.replace(/\.ts$/, '')))
    for (const name of Object.keys(mod)) if (consts.has(name)) assert.notEqual(mod[name], undefined, `${part}: ${name}`)
  }
})

test('campaign parts never import the entry and keep lazy src requires relative to daemon/campaign', () => {
  for (const part of parts) {
    const text = fs.readFileSync(path.join(BODY, part), 'utf8')
    const depth = part.split(/[\\/]/).length
    assert.doesNotMatch(text, /from '(\.\.\/)+campaign'|require\('(\.\.\/)+campaign'\)/, part)
    assert.doesNotMatch(text, /path\.join\(__dirname/, `${part}: путь от __dirname сломался бы в склейке тестов`)
    // src/ от daemon/campaign/<часть> — '../src/…', от stages/ — '../../src/…' ('./src/…' искал бы daemon/campaign/src/)
    for (const m of text.matchAll(/(?:require\(|import\()'(\.[^']*src\/[^']+)'\)/g)) assert.ok(m[1]!.startsWith('../'.repeat(depth) + 'src/'), `${part}: ${m[1]}`)
  }
})

test('every relative require of every campaign part resolves from the part itself (lazy ones too)', () => {
  const { createRequire }: typeof import('node:module') = require('node:module')
  for (const part of parts) {
    const file = path.join(BODY, part.replace(/\.ts$/, '.js'))
    const local = createRequire(file)
    for (const m of fs.readFileSync(file, 'utf8').matchAll(/require\(["'](\.[^"']+)["']\)/g)) {
      assert.doesNotThrow(() => local.resolve(m[1]!), `${part}: require('${m[1]}')`)
    }
  }
})
