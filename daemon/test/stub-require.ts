import { createRequire } from 'node:module'
import { dirname, resolve } from 'node:path'

// require для vm-контекста теста: подмены модулей по ключу, который сверяется не только с буквальным spec,
// но и с путём, куда spec разрешается. Ключ './combat', 'combat' или 'src/combat' находит src/combat.js и тогда,
// когда код после разделения просит его как '../combat' из папки тела; 'ws', 'fs', 'node:fs' — пакеты и встроенные.
// Без совпадения — настоящий require от файла from. unmatched() — ключи, которые ни разу не сработали: раньше такая
// подмена молча пропадала (настоящие часы, настоящая постройка вместо заглушки).
//   const req = stubRequire(file, { './combat': fakeCombat }, { './build': actual => ({ ...actual, digUp }) })
//   vm.runInNewContext(code, { require: req, … }); assert.deepEqual(req.unmatched(), [])

export type StubPatch = (actual: any, spec: string) => any
export interface StubRequire {
  (spec: string): any
  unmatched (): string[]
  resolveSpec (spec: string): string
  resolve (spec: string): string
}

const stripExt = (path: string): string => path.replace(/\\/g, '/').replace(/\.(c|m)?(js|ts)$|\.json$/, '').replace(/\/index$/, '')
const keyPath = (key: string): string => stripExt(key.replace(/^node:/, '')).replace(/^(\.\.?\/)+/, '')

export function stubRequire (from: string, stubs: Record<string, any> = {}, patches: Record<string, StubPatch> = {}): StubRequire {
  const real = createRequire(from)
  const keys = [...new Set([...Object.keys(stubs), ...Object.keys(patches)])]
  const used = new Set<string>()
  const resolveSpec = (spec: string): string => {
    try { return real.resolve(spec) } catch { return spec.startsWith('.') ? resolve(dirname(from), spec) : spec }
  }
  const keyFor = (spec: string): string | null => {
    const plain = spec.replace(/^node:/, '')
    const exact = keys.find(key => key === spec || key.replace(/^node:/, '') === plain)
    if (exact) return exact
    const target = stripExt(resolveSpec(spec).replace(/^node:/, ''))
    let best: string | null = null
    for (const key of keys) {
      const k = keyPath(key)
      if (!k) continue
      if (target === k || target.endsWith('/' + k)) if (!best || keyPath(best).length < k.length) best = key
    }
    return best
  }
  const req = ((spec: string) => {
    const key = keyFor(spec)
    if (key === null) return real(spec)
    used.add(key)
    if (key in stubs) return stubs[key]
    return patches[key]!(real(spec), spec)
  }) as StubRequire
  req.unmatched = () => keys.filter(key => !used.has(key))
  req.resolveSpec = resolveSpec
  req.resolve = (spec: string) => real.resolve(spec)
  return req
}
