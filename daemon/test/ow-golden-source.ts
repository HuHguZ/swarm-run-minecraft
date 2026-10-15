import assert from 'node:assert/strict'
import vm from 'node:vm'
import { stripTypeScriptTypes } from 'node:module'

export function body(source: string, start: string, end: string, globals: Record<string, unknown>, name: string): any {
  const chunk = source.slice(source.indexOf(start), source.indexOf(end, source.indexOf(start)))
  assert(chunk.length > 0, name)
  const code = stripTypeScriptTypes(chunk)
  return vm.runInNewContext(code + '\n' + name, globals)
}
