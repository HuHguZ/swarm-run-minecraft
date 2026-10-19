// Проверка типов (TypeScript 7):
//   1) весь проект — tsconfig.json, ошибок быть не должно;
//   2) строгая зона — tsconfig.core.json (strict). Строгий режим tsc включает на всю программу, поэтому в неё попадают и
//      нестрогие модули, которые строгая зона импортирует. Считаются только ошибки в файлах самой зоны (include
//      tsconfig.core.json); зона расширяется переносом файлов в её include.
import { spawnSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { dirname, join, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const tsc = join(root, 'node_modules', 'typescript', 'bin', 'tsc')

function check (project) {
  const result = spawnSync(process.execPath, [tsc, '-p', project, '--noEmit', '--pretty', 'false'], { cwd: root, encoding: 'utf8', maxBuffer: 256 * 1024 * 1024 })
  if (result.error) throw result.error
  const lines = (result.stdout + result.stderr).split('\n').filter(Boolean)
  return lines.filter(line => /^[^(\s][^(]*\(\d+,\d+\): error TS\d+/.test(line))
}

// include tsconfig.core.json → проверка пути: «dir/**/*.ts» — папка с подпапками, иначе — точный файл.
const zone = JSON.parse(readFileSync(join(root, 'tsconfig.core.json'), 'utf8')).include
const inZone = file => zone.some(pattern => pattern.endsWith('/**/*.ts') ? file.startsWith(pattern.slice(0, -'**/*.ts'.length)) : file === pattern)

const errors = check('tsconfig.json')
for (const line of errors) console.log(line)
const strict = check('tsconfig.core.json').filter(line => inZone(relative(root, resolve(root, line.slice(0, line.indexOf('('))))))
for (const line of strict) console.log('[strict] ' + line)
console.log(`typecheck: ${errors.length} ошибок в проекте, ${strict.length} в строгой зоне (tsconfig.core.json)`)
process.exit(errors.length || strict.length ? 1 : 0)
