'use strict'
import test = require('node:test')
import assert = require('node:assert/strict')
import * as fs from 'node:fs'
import * as os from 'node:os'
import path = require('node:path')
import * as vm from 'node:vm'
import ts from '@typescript/typescript6'
import { bodySource, moduleSourceTs, functionSource, declarationSource, declSource, statementSource, partSource, transpiledSource } from './source-fixture'
import { stubRequire } from './stub-require'

// Временная раскладка «фасад + папка тела»: files — путь относительно корня → текст.
function layout (files: Record<string, string>): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'nd-source-fixture-'))
  for (const [name, text] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(root, name)), { recursive: true })
    fs.writeFileSync(path.join(root, name), text)
  }
  return root
}

function run (code: string, stubs: Record<string, any> = {}): { exports: any, specs: string[] } {
  const specs: string[] = []
  const module = { exports: {} as any }
  vm.runInNewContext(code, { module, exports: module.exports, require: (spec: string) => { specs.push(spec); return stubs[spec] } })
  return { exports: module.exports, specs }
}

const topFunctions = (code: string): string[] => ts.createSourceFile('x.js', code, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS).statements
  .filter(ts.isFunctionDeclaration).map(s => s.name!.text).sort()

test('одиночный модуль без папки тела: тот же набор функций верхнего уровня, что у самого файла', () => {
  const clock = path.join(__dirname, '../src/game-clock.js')
  assert.deepEqual(topFunctions(bodySource(clock)), topFunctions(transpiledSource(clock)))
  assert.doesNotThrow(() => new vm.Script(bodySource(clock)))
})

test('кампания: склейка входа — все функции всех частей daemon/campaign/, один скрипт', () => {
  const campaign = path.join(__dirname, '../campaign.js')
  const body = path.join(__dirname, '../campaign')
  const parts = (fs.readdirSync(body, { recursive: true }) as string[]).filter(f => f.endsWith('.ts')).map(f => path.join(body, f))
  assert.ok(parts.length > 20)
  const expected = [campaign, ...parts].flatMap(file => topFunctions(transpiledSource(file))).sort()
  assert.deepEqual(topFunctions(bodySource(campaign)), expected)
  assert.doesNotThrow(() => new vm.Script(bodySource(campaign)))
})

test('ESM-фасад и части: порядок исполнения, export снят, внешние импорты слиты, spec пересчитаны, module.exports собран', () => {
  const root = layout({
    'm.ts': "import { h } from './m/a'\nexport { f, g } from './m/b'\nexport const top = (): number => h() + 1\n",
    'm/a.ts': "'use strict'\nimport { sleep } from '../clock'\nimport type { T } from '../types'\nexport function h (): number { const t: T = 1; return sleep() + t + require('../lazy').x + require('./b').marker }\n",
    'm/b.ts': "import { h } from './a'\nimport { sleep, unused } from '../clock'\nimport { sleep as nap } from '../clock'\n// якорь части b\nexport const f = (): number => h()\nexport function g (): number { return sleep() + nap() }\nexport const marker = 7\n"
  })
  const entry = path.join(root, 'm.ts')
  const code = bodySource(entry)
  assert.doesNotMatch(code, /\bexport\b|\bimport\b/)
  assert.ok(code.indexOf('function h') < code.indexOf('const f'), 'a исполняется раньше b')
  assert.equal(code.match(/require\("\.\/clock"\)/g)?.length, 2, 'sleep — один раз, nap — отдельной привязкой')
  assert.match(code, /require\("\.\/lazy"\)/)
  assert.match(code, /require\("\.\/m\/b"\)/)
  assert.doesNotMatch(code, /types/)
  assert.match(moduleSourceTs(entry), /\/\/ якорь части b/, 'TS-склейка хранит комментарии')
  const clock = { sleep: () => 10 }
  const { exports, specs } = run(code, { './clock': clock, './lazy': { x: 100 }, './m/b': { marker: 1000 } })
  assert.deepEqual(Object.keys(exports).sort(), ['f', 'g', 'top'])
  assert.equal(exports.f(), 1111)
  assert.equal(exports.g(), 20)
  assert.equal(exports.top(), 1112)
  assert.deepEqual(specs.filter(s => s === './clock'), ['./clock', './clock'])
})

test('старая форма CommonJS: const {…} = require(часть), spec .././x и module.exports фасада', () => {
  const root = layout({
    'src/d.ts': "const { a, b: bee }: typeof import('./d/one') = require('./d/one')\n'use strict'\nmodule.exports = { a, bee }\n",
    'src/d/one.ts': "const clock: typeof import('.././clock') = require('.././clock')\nconst { two }: typeof import('./two') = require('./two')\nfunction a () { return clock.t + two() }\nconst b = () => 2\nmodule.exports = { a, b }\n",
    'src/d/two.ts': "const clock: typeof import('../clock') = require('../clock')\nfunction two () { return 40 }\nmodule.exports = { two }\n"
  })
  const code = bodySource(path.join(root, 'src/d.js'))
  assert.equal(code.match(/require\("\.\/clock"\)/g)?.length, 1, 'два одинаковых require частей — одна привязка')
  const { exports } = run(code, { './clock': { t: 2 } })
  assert.equal(exports.a(), 42)
  assert.equal(exports.bee(), 2)
})

test('одно имя верхнего уровня в двух частях — ошибка', () => {
  const root = layout({
    'm.ts': "export { a } from './m/one'\nexport { b } from './m/two'\n",
    'm/one.ts': 'function helper () { return 1 }\nexport const a = helper\n',
    'm/two.ts': 'function helper () { return 2 }\nexport const b = helper\n'
  })
  assert.throws(() => bodySource(path.join(root, 'm.ts')), /«helper» объявлено дважды/)
})

test('function/declaration/decl/statement/part: по имени, без export, js и ts', () => {
  const root = layout({
    'm.ts': "import './m/stages'\nexport { run } from './m/run'\n",
    'm/run.ts': "import { STAGES } from './table'\nexport async function run (n: string): Promise<number> { return STAGES.length + n.length }\nexport const limit: number = 3, other = 4\n",
    'm/table.ts': "export const STAGES: string[] = []\nexport function defStage (name: string) { STAGES.push(name) }\n",
    'm/stages.ts': "import { defStage } from './table'\ndefStage('iron', () => require('../gear'))\ndefStage('wood')\n"
  })
  const entry = path.join(root, 'm.js')
  assert.match(functionSource(entry, 'run'), /^async function run\(n\)/)
  assert.match(functionSource(entry, 'run', { ts: true }), /^async function run \(n: string\): Promise<number>/)
  assert.match(declarationSource(entry, 'other'), /^const limit = 3, other = 4;/)
  assert.equal(declSource(entry, 'STAGES', 'defStage').split('\n').length, 4)
  assert.match(statementSource(entry, "defStage('iron'", { ts: true }), /require\('\.\/gear'\)/)
  assert.match(statementSource(entry, 'defStage("wood")'), /^defStage\("wood"\)/)
  assert.match(partSource(entry, 'stages', { ts: true }), /^\ndefStage\('iron', \(\) => require\('\.\/gear'\)\)\ndefStage\('wood'\)/)
  const { exports } = run(bodySource(entry), { './gear': {} })
  return exports.run('ab').then((n: number) => assert.equal(n, 4))
})

test('stubRequire: ключ находит модуль по пути, а не по буквальному spec; несработавшие ключи видны', () => {
  const root = layout({ 'src/combat.js': 'module.exports = { real: true }\n', 'src/pvp/part.js': '', 'src/build.js': 'module.exports = { dig: 1, keep: 2 }\n' })
  const fake = { fake: true }
  const req = stubRequire(path.join(root, 'src/pvp/part.js'), { './combat': fake, 'ws': 'socket', './never': 1 }, { 'src/build': actual => ({ ...actual, dig: 9 }) })
  assert.equal(req('../combat'), fake)
  assert.equal(req('ws'), 'socket')
  assert.deepEqual(req('../build'), { dig: 9, keep: 2 })
  assert.equal(req('node:path'), path)
  assert.deepEqual(req.unmatched(), ['./never'])
})
