// Сборка: tsc (TypeScript 7) → dist/ с той же раскладкой, что у исходников (dist/daemon, dist/farm, dist/mcp, dist/run).
// Кроме собранного кода в dist/ кладутся:
//   - копии .ts рядом с .js — их читают тесты, разбирающие текст исходника, и хеш кода телеметрии;
//   - dist/mcp/package.json с "type": "module" — mcp собирается как ESM;
//   - ссылки dist/daemon/node_modules и dist/mcp/node_modules на зависимости пакетов (junction на Windows).
// Старые .js/.js.map прежней сборки рядом с исходниками сборка удаляет.
// Ошибки типов сборку не останавливают (код всё равно выпускается) — их строгая проверка: npm run typecheck.
//   node scripts/build.mjs             чистая сборка в dist/
//   node scripts/build.mjs --watch     пересборка при изменениях
//   node scripts/build.mjs --out dist-a   своя папка сборки (параллельная работа: тесты — из dist-a/)
import { spawn, spawnSync } from 'node:child_process'
import { copyFileSync, existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, rmSync, symlinkSync, unlinkSync, watch, writeFileSync } from 'node:fs'
import { dirname, join, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const outArg = process.argv.indexOf('--out')
const outName = outArg > 0 ? process.argv[outArg + 1] : 'dist'
if (!/^dist(-[\w.-]+)?$/.test(outName ?? '')) throw new Error('--out: папка сборки в корне репозитория, dist или dist-<имя>')
const dist = join(root, outName)
const tsc = join(root, 'node_modules', 'typescript', 'bin', 'tsc')
const packages = ['daemon', 'mcp']
const config = JSON.parse(readFileSync(join(root, 'tsconfig.json'), 'utf8'))

// Исходники сборки — по образцам include из tsconfig.json: «dir/*.ts» — только файлы папки, «dir/**/*.ts» — с подпапками.
function sources () {
  const files = []
  const walk = (directory, deep) => {
    if (!existsSync(join(root, directory))) return
    for (const entry of readdirSync(join(root, directory), { withFileTypes: true })) {
      const path = join(directory, entry.name)
      if (entry.isDirectory()) { if (deep && entry.name !== 'node_modules' && !entry.name.startsWith('codex-')) walk(path, deep) }
      else if (entry.name.endsWith('.ts') && !entry.name.endsWith('.d.ts')) files.push(path)
    }
  }
  for (const pattern of config.include) walk(pattern.replace(/\/\*.*$/, ''), pattern.includes('**'))
  return [...new Set(files)]
}

function unlinkModules () {
  for (const name of packages) {
    const link = join(dist, name, 'node_modules')
    try { if (lstatSync(link).isSymbolicLink()) unlinkSync(link) } catch {}
  }
}

// Ссылку снимаем до рекурсивного удаления: на Windows rmSync по junction может уйти в чужое дерево.
function clean () {
  unlinkModules()
  for (const name of packages) if (existsSync(join(dist, name, 'node_modules'))) throw new Error(`dist/${name}/node_modules — не ссылка, не удаляю`)
  rmSync(dist, { recursive: true, force: true })
}

// Старая сборка (esbuild до 19.10.2026) клала .js и .js.map рядом с исходниками — убрать, если остались.
function removeLegacyOutputs () {
  for (const file of sources()) {
    const js = join(root, file.replace(/\.ts$/, '.js'))
    if (!existsSync(js)) continue
    if (existsSync(js + '.map') || readFileSync(js, 'utf8').includes('//# sourceMappingURL=')) {
      rmSync(js, { force: true })
      rmSync(js + '.map', { force: true })
    }
  }
}

function copySource (file) {
  const target = join(dist, file)
  mkdirSync(dirname(target), { recursive: true })
  copyFileSync(join(root, file), target)
}

function finish () {
  for (const file of sources()) copySource(file)
  mkdirSync(join(dist, 'mcp'), { recursive: true })
  writeFileSync(join(dist, 'mcp', 'package.json'), JSON.stringify({ private: true, type: 'module' }, null, 2) + '\n')
  unlinkModules()
  for (const name of packages) {
    const target = join(root, name, 'node_modules')
    if (!existsSync(target)) { console.warn(`нет ${name}/node_modules — npm --prefix ${name} ci`); continue }
    mkdirSync(join(dist, name), { recursive: true })
    symlinkSync(target, join(dist, name, 'node_modules'), 'junction')
  }
}

if (process.argv.includes('--watch')) {
  clean()
  removeLegacyOutputs()
  mkdirSync(dist, { recursive: true })
  finish()
  spawn(process.execPath, [tsc, '-p', 'tsconfig.json', '--outDir', dist, '--watch', '--preserveWatchOutput'], { cwd: root, stdio: 'inherit' })
  const included = new Set(sources().map(file => file.split(sep).join('/')))
  watch(root, { recursive: true }, (_event, path) => {
    const file = path?.split(sep).join('/')
    if (file && included.has(file) && existsSync(join(root, file))) copySource(file)
  })
} else {
  const started = Date.now()
  clean()
  removeLegacyOutputs()
  const result = spawnSync(process.execPath, [tsc, '-p', 'tsconfig.json', '--outDir', dist], { cwd: root, stdio: 'inherit' })
  if (result.error) throw result.error
  if (!existsSync(join(dist, 'daemon', 'src', 'index.js'))) {
    console.error('tsc ничего не выпустил')
    process.exit(1)
  }
  finish()
  const typeErrors = result.status !== 0 ? ' (есть ошибки типов — npm run typecheck)' : ''
  console.log(`${outName}/ собран за ${((Date.now() - started) / 1000).toFixed(1)} с: ${sources().length} модулей${typeErrors}`)
}
