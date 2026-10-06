import { build } from 'esbuild'
import { readFile, readdir } from 'node:fs/promises'
import { dirname, join, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const config = JSON.parse(await readFile(join(root, 'tsconfig.json'), 'utf8'))
const entries = new Set()
const seen = new Set()
async function collect(directory, recursive) {
  const key = directory + recursive
  if (seen.has(key)) return
  seen.add(key)
  for (const entry of await readdir(join(root, directory), { withFileTypes: true })) {
    const path = join(directory, entry.name)
    if (recursive && entry.isDirectory() && entry.name !== 'node_modules' && !entry.name.startsWith('codex-')) await collect(path, true)
    else if (entry.isFile() && entry.name.endsWith('.ts') && !entry.name.endsWith('.d.ts')) entries.add(path)
  }
}
await Promise.all(config.include.map(pattern => collect(pattern.replace(/\/\*.*$/, ''), pattern.includes('**'))))
const cjs = [...entries].filter(path => !path.startsWith('mcp' + (process.platform === 'win32' ? '\\' : '/')))
const esm = [...entries].filter(path => !cjs.includes(path))
const options = {
  absWorkingDir: root,
  outdir: root,
  outbase: root,
  bundle: false,
  platform: 'node',
  target: 'node24',
  sourcemap: true,
  sourcesContent: true,
  legalComments: 'inline',
  logLevel: 'warning',
  tsconfig: join(root, 'tsconfig.json')
}
for (const [entryPoints, format] of [[cjs, 'cjs'], [esm, 'esm']]) {
  if (!entryPoints.length) continue
  await build({ ...options, entryPoints, format })
}
console.log(`Built ${entries.size} TypeScript modules with esbuild`)
if (process.argv.includes('--watch')) {
  const { watch } = await import('node:fs')
  let timer
  watch(root, { recursive: true }, (_event, path) => {
    if (!path?.endsWith('.ts') || path.includes('node_modules')) return
    clearTimeout(timer)
    timer = setTimeout(async () => {
      const source = resolve(root, path)
      const local = relative(root, source)
      if (!config.include.some(pattern => {
        const directory = pattern.replace(/\/\*.*$/, '').replaceAll('/', process.platform === 'win32' ? '\\' : '/')
        return local.startsWith(directory + (process.platform === 'win32' ? '\\' : '/')) && (pattern.includes('**') || dirname(local) === directory)
      })) return
      try { await build({ ...options, entryPoints: [source], format: path.startsWith('mcp') ? 'esm' : 'cjs' }) }
      catch (error) { console.error(error.message) }
    }, 100)
  })
}
