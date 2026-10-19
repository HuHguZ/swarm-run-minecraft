// Корень репозитория. Код запускается из dist/ (сборка tsc), а данные, логи, память бота, миры фермы и исходники
// лежат в исходном дереве — пути к ним строятся от REPO_ROOT, а не от __dirname собранного файла.
// К собранным модулям и скриптам (*.js) путь по-прежнему строится от __dirname: dist/ повторяет дерево исходников.
import * as fs from 'fs'
import * as path from 'path'

function findRepoRoot (from: string): string {
  for (let dir = from; ; dir = path.dirname(dir)) {
    try {
      if (JSON.parse(fs.readFileSync(path.join(dir, 'package.json'), 'utf8')).name === 'neurodown') return dir
    } catch {}
    if (path.dirname(dir) === dir) throw new Error(`neurodown: корень репозитория не найден выше ${from}`)
  }
}

export const REPO_ROOT = findRepoRoot(__dirname)
// Корень собранного дерева, из которого запущен этот код: dist/ (или другая папка сборки, или снимок кода фермы) —
// этот файл лежит в <корень сборки>/daemon/src/paths.js.
export const DIST_ROOT = path.resolve(__dirname, '..', '..')

const jsonCache = new Map<string, unknown>()
// JSON-данные исходного дерева (daemon/data, фикстуры тестов, сиды): один разбор на процесс, как у require(*.json).
export function repoJson<T = any> (relative: string): T {
  const file = path.join(REPO_ROOT, relative)
  if (!jsonCache.has(file)) jsonCache.set(file, JSON.parse(fs.readFileSync(file, 'utf8')))
  return jsonCache.get(file) as T
}
