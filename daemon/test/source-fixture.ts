import { existsSync, readFileSync } from 'node:fs'
import { dirname, resolve, relative, sep, basename, join } from 'node:path'
import ts from '@typescript/typescript6'
import { transformSync } from 'esbuild'

// Текст модуля «одной областью видимости» для тестов, которые исполняют исходник в vm и подменяют его привязки.
//
// Модуль `x.ts` с телом в папке `x/` (фасад + части) склеивается в один скрипт:
//   - импорты частей из папки тела (`import { a } from './x/part'`, `export { a } from './x/part'`, старое
//     `const { a } = require('./x/part')`) заменяются текстом самой части — в порядке исполнения модулей
//     (зависимость раньше того, кто её импортирует; повторно часть не вставляется);
//   - прочие импорты становятся `const … = require(spec)`; spec любого относительного require/import, в том числе
//     ленивого внутри функций, пересчитывается от папки входного файла (`'../combat'` из `x/part.ts` → `'./combat'`),
//     чтобы ключи заглушек тестов (`name === './combat'`) совпадали как до разделения; одинаковые внешние импорты
//     разных частей сливаются в один;
//   - `export` у объявлений снимается, списки экспорта частей отбрасываются, для входного файла собирается
//     `module.exports = { … }` (если в нём нет своего `module.exports =`);
//   - два одинаковых имени верхнего уровня в разных частях — ошибка (одна область видимости).
// Импорты, которые esbuild выбросил бы как неиспользуемые (типы), выбрасываются и здесь.
// Без .ts рядом с .js (старый снимок кода) — прежний разбор собранного CommonJS.

type Options = { ts?: boolean }
type Export = { local?: string; file?: string; name?: string; star?: string }

const typeStripped = new Map<string, string>()
const moduleTexts = new Map<string, string>()
const scripts = new Map<string, string>()
const exportMaps = new Map<string, Map<string, Export>>()
const keptImports = new Map<string, Map<string, Set<string>>>()
const trees = new Map<string, ts.SourceFile>()

const tsPath = (file: string): string => file.endsWith('.ts') ? file : file.replace(/\.js$/, '.ts')
const hasTs = (file: string): boolean => existsSync(tsPath(file)) && tsPath(file).endsWith('.ts')
const bodyBase = (entry: string): string => resolve(dirname(entry), basename(basename(entry, '.ts'), '.js')) + sep
const posix = (path: string): string => path.split(sep).join('/')

function treeOf (file: string): ts.SourceFile {
  if (!trees.has(file)) trees.set(file, ts.createSourceFile(file, readFileSync(file, 'utf8'), ts.ScriptTarget.Latest, true, ts.ScriptKind.TS))
  return trees.get(file)!
}

// Какие импорты переживут снятие типов: esbuild (как и tsc) выбрасывает импорт, имена которого в коде не используются.
function keptImportsOf (file: string): Map<string, Set<string>> {
  if (keptImports.has(file)) return keptImports.get(file)!
  const kept = new Map<string, Set<string>>()
  const code = transformSync(readFileSync(file, 'utf8'), { loader: 'ts' }).code
  const tree = ts.createSourceFile(file + '.js', code, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS)
  for (const statement of tree.statements) {
    if (!ts.isImportDeclaration(statement) || !ts.isStringLiteral(statement.moduleSpecifier)) continue
    const names = kept.get(statement.moduleSpecifier.text) || new Set<string>()
    kept.set(statement.moduleSpecifier.text, names)
    const clause = statement.importClause
    if (clause?.name) names.add(clause.name.text)
    const bindings = clause?.namedBindings
    if (bindings && ts.isNamespaceImport(bindings)) names.add(bindings.name.text)
    if (bindings && ts.isNamedImports(bindings)) for (const element of bindings.elements) names.add(element.name.text)
  }
  keptImports.set(file, kept)
  return kept
}

function unwrap (node: ts.Expression): ts.Expression {
  while (ts.isAsExpression(node) || ts.isParenthesizedExpression(node) || ts.isNonNullExpression(node) || ts.isTypeAssertionExpression(node) || ts.isSatisfiesExpression(node)) node = node.expression
  return node
}

// `require('<spec>')` верхнего уровня: `const x = require(…)`, `const { a, b: c } = require(…)`.
function requireCall (statement: ts.Statement): { spec: string; declaration: ts.VariableDeclaration } | null {
  if (!ts.isVariableStatement(statement) || statement.declarationList.declarations.length !== 1) return null
  const declaration = statement.declarationList.declarations[0]!
  const init = declaration.initializer && unwrap(declaration.initializer)
  if (!init || !ts.isCallExpression(init) || !ts.isIdentifier(init.expression) || init.expression.text !== 'require') return null
  const arg = init.arguments[0]
  if (!arg || !ts.isStringLiteralLike(arg)) return null
  return { spec: arg.text, declaration }
}

const hasModifier = (node: ts.Node, kind: ts.SyntaxKind): boolean => !!(ts.canHaveModifiers(node) && ts.getModifiers(node)?.some(m => m.kind === kind))

function bodyTarget (base: string, file: string, spec: string): string | null {
  if (!spec.startsWith('.')) return null
  const abs = resolve(dirname(file), spec)
  for (const candidate of [abs + '.ts', abs.replace(/\.js$/, '.ts'), join(abs, 'index.ts')]) {
    if (candidate.endsWith('.ts') && candidate.startsWith(base) && existsSync(candidate)) return candidate
  }
  return null
}

// Что экспортирует файл: имя экспорта → локальное имя (или где его искать дальше).
function exportMapOf (base: string, file: string): Map<string, Export> {
  if (exportMaps.has(file)) return exportMaps.get(file)!
  const map = new Map<string, Export>()
  exportMaps.set(file, map)
  const tree = treeOf(file)
  const declared = (statement: ts.Statement): string[] => {
    if ((ts.isFunctionDeclaration(statement) || ts.isClassDeclaration(statement) || ts.isEnumDeclaration(statement)) && statement.name) return [statement.name.text]
    if (ts.isVariableStatement(statement)) return statement.declarationList.declarations.flatMap(d => bindingNames(d.name))
    return []
  }
  let star = 0
  for (const statement of tree.statements) {
    if (ts.isExportDeclaration(statement)) {
      if (statement.isTypeOnly) continue
      const spec = statement.moduleSpecifier && ts.isStringLiteral(statement.moduleSpecifier) ? statement.moduleSpecifier.text : null
      const target = spec ? bodyTarget(base, file, spec) : null
      const clause = statement.exportClause
      if (!clause) { if (target) map.set(`*${star++}`, { star: target }); continue }
      if (!ts.isNamedExports(clause)) { if (target) map.set(clause.name.text, { local: clause.name.text }); continue }
      for (const element of clause.elements) {
        if (element.isTypeOnly) continue
        const name = element.name.text, from = (element.propertyName || element.name).text
        map.set(name, target ? { file: target, name: from } : { local: spec ? name : from })
      }
    } else if (ts.isExportAssignment(statement)) {
      if (!statement.isExportEquals && ts.isIdentifier(statement.expression)) map.set('default', { local: statement.expression.text })
    } else if (ts.isExpressionStatement(statement) && ts.isBinaryExpression(statement.expression) && statement.expression.operatorToken.kind === ts.SyntaxKind.EqualsToken &&
      statement.expression.left.getText(tree) === 'module.exports' && ts.isObjectLiteralExpression(statement.expression.right)) {
      // старая форма части: module.exports = { a, b: c }
      for (const property of statement.expression.right.properties) {
        if (ts.isShorthandPropertyAssignment(property)) map.set(property.name.text, { local: property.name.text })
        else if (ts.isPropertyAssignment(property) && ts.isIdentifier(property.initializer) && (ts.isIdentifier(property.name) || ts.isStringLiteral(property.name))) map.set(property.name.text, { local: property.initializer.text })
      }
    } else if (hasModifier(statement, ts.SyntaxKind.ExportKeyword) && !hasModifier(statement, ts.SyntaxKind.DeclareKeyword)) {
      if (hasModifier(statement, ts.SyntaxKind.DefaultKeyword)) { const [name] = declared(statement); if (name) map.set('default', { local: name }) }
      else for (const name of declared(statement)) map.set(name, { local: name })
    }
  }
  return map
}

function bindingNames (name: ts.BindingName): string[] {
  if (ts.isIdentifier(name)) return [name.text]
  return name.elements.flatMap(element => ts.isOmittedExpression(element) ? [] : bindingNames(element.name))
}

function resolveExport (base: string, file: string, name: string, guard = new Set<string>()): string | null {
  const key = file + '\0' + name
  if (guard.has(key)) return null
  guard.add(key)
  const map = exportMapOf(base, file)
  const found = map.get(name)
  if (found?.local) return found.local
  if (found?.file) return resolveExport(base, found.file, found.name!, guard)
  if (name === 'default') return null
  for (const [key, value] of map) if (key.startsWith('*') && value.star) { const local = resolveExport(base, value.star, name, guard); if (local) return local }
  return null
}

function exportNames (base: string, file: string, guard = new Set<string>()): string[] {
  if (guard.has(file)) return []
  guard.add(file)
  const names: string[] = []
  for (const [key, value] of exportMapOf(base, file)) {
    if (key.startsWith('*') && value.star) names.push(...exportNames(base, value.star, guard).filter(n => n !== 'default'))
    else names.push(key)
  }
  return [...new Set(names)]
}

function concatenate (entryPath: string): string {
  const entry = tsPath(entryPath)
  const base = bodyBase(entry)
  const entryDir = dirname(entry)
  const seen = new Set<string>()
  const chunks: string[] = []
  const declared = new Map<string, { file: string; key: string | null }>()
  const short = (file: string): string => posix(relative(entryDir, file)) || basename(file)
  const respec = (file: string, spec: string): string => {
    if (file === entry || !spec.startsWith('.')) return spec
    const rel = posix(relative(entryDir, resolve(dirname(file), spec)))
    return rel.startsWith('.') ? rel : './' + rel
  }
  // Имя верхнего уровня: второе объявление того же имени — ошибка, кроме того же внешнего импорта (key).
  const declare = (file: string, name: string, key: string | null): boolean => {
    const before = declared.get(name)
    if (!before) { declared.set(name, { file, key }); return true }
    if (key !== null && before.key === key) return false
    throw new Error(`bodySource(${short(entry)}): имя верхнего уровня «${name}» объявлено дважды — ${short(before.file)} и ${short(file)}`)
  }

  function visit (file: string): void {
    if (seen.has(file)) return
    seen.add(file)
    const tree = treeOf(file)
    const text = tree.text
    const kept = keptImportsOf(file)
    chunks.push('\n')
    const isEntry = file === entry
    for (const statement of tree.statements) {
      const lead = text.slice(statement.pos, statement.getStart(tree))
      const emit = (code: string) => chunks.push(lead + code)
      const requireOf = (spec: string, names: Array<{ local: string; key: string; pattern: string }>, original?: string) => {
        const fresh = names.filter(n => declare(file, n.local, n.key))
        if (!fresh.length) return emit('')
        if (original && fresh.length === names.length) return emit(original)
        const namespace = fresh.filter(n => n.pattern === '*'), named = fresh.filter(n => n.pattern !== '*')
        const lines: string[] = []
        for (const n of namespace) lines.push(n.key.endsWith('\0default') ? `const ${n.local} = ((m) => m && m.__esModule ? m.default : m)(require('${spec}'))` : `const ${n.local} = require('${spec}')`)
        if (named.length) lines.push(`const { ${named.map(n => n.pattern === n.local ? n.local : `${n.pattern}: ${n.local}`).join(', ')} } = require('${spec}')`)
        emit(lines.join('\n'))
      }

      if (ts.isImportDeclaration(statement)) {
        if (statement.importClause?.isTypeOnly || !ts.isStringLiteral(statement.moduleSpecifier)) { emit(''); continue }
        const spec = statement.moduleSpecifier.text
        const keep = kept.get(spec)
        if (!keep) { emit(''); continue }
        const target = bodyTarget(base, file, spec)
        const clause = statement.importClause
        const bindings: Array<{ local: string; imported: string }> = []
        if (clause?.name && keep.has(clause.name.text)) bindings.push({ local: clause.name.text, imported: 'default' })
        const named = clause?.namedBindings
        if (named && ts.isNamespaceImport(named) && keep.has(named.name.text)) bindings.push({ local: named.name.text, imported: '*' })
        if (named && ts.isNamedImports(named)) for (const element of named.elements) {
          if (!element.isTypeOnly && keep.has(element.name.text)) bindings.push({ local: element.name.text, imported: (element.propertyName || element.name).text })
        }
        if (target) {
          visit(target)
          const aliases: string[] = []
          for (const b of bindings) {
            if (b.imported === '*') {
              const getters = exportNames(base, target).map(n => [n, resolveExport(base, target, n)]).filter(([, l]) => l && declared.has(l!))
              if (declare(file, b.local, null)) aliases.push(`const ${b.local} = { ${getters.map(([n, l]) => `get ${n} () { return ${l} }`).join(', ')} }`)
              continue
            }
            const local = resolveExport(base, target, b.imported)
            if (!local) throw new Error(`bodySource(${short(entry)}): ${short(file)} импортирует «${b.imported}» из ${short(target)}, а там его нет`)
            if (local !== b.local && declare(file, b.local, null)) aliases.push(`const ${b.local} = ${local}`)
          }
          emit(aliases.join('\n'))
          continue
        }
        const to = respec(file, spec)
        if (!clause) { emit(`require('${to}')`); continue }
        requireOf(to, bindings.map(b => ({ local: b.local, key: `${to}\0${b.imported}`, pattern: b.imported === '*' || b.imported === 'default' ? '*' : b.imported })))
        continue
      }

      if (ts.isImportEqualsDeclaration(statement)) {
        const ref = statement.moduleReference
        if (statement.isTypeOnly || !ts.isExternalModuleReference(ref) || !ts.isStringLiteral(ref.expression)) { emit(statement.isTypeOnly ? '' : statement.getText(tree)); continue }
        const to = respec(file, ref.expression.text)
        requireOf(to, [{ local: statement.name.text, key: `${to}\0*`, pattern: '*' }])
        continue
      }

      if (ts.isExportDeclaration(statement)) {
        const spec = statement.moduleSpecifier && ts.isStringLiteral(statement.moduleSpecifier) ? statement.moduleSpecifier.text : null
        const target = spec ? bodyTarget(base, file, spec) : null
        if (statement.isTypeOnly || !spec) { emit(''); continue }
        if (target) { visit(target); emit(''); continue }
        const clause = statement.exportClause
        if (!clause || !ts.isNamedExports(clause)) throw new Error(`bodySource(${short(entry)}): «export * from '${spec}'» вне папки тела не поддерживается (${short(file)})`)
        const to = respec(file, spec)
        requireOf(to, clause.elements.filter(e => !e.isTypeOnly).map(e => ({ local: e.name.text, key: `${to}\0${(e.propertyName || e.name).text}`, pattern: (e.propertyName || e.name).text })))
        continue
      }

      if (ts.isExportAssignment(statement)) {
        if (statement.isExportEquals) { emit(`module.exports = ${statement.expression.getText(tree)}`); continue }
        if (ts.isIdentifier(statement.expression)) { emit(''); continue }
        throw new Error(`bodySource(${short(entry)}): «export default <выражение>» не поддерживается (${short(file)})`)
      }

      const legacy = requireCall(statement)
      if (legacy) {
        const target = bodyTarget(base, file, legacy.spec)
        const pattern = legacy.declaration.name
        if (target) {
          visit(target)
          const aliases: string[] = []
          if (ts.isIdentifier(pattern)) {
            const getters = exportNames(base, target).map(n => [n, resolveExport(base, target, n)]).filter(([, l]) => l && declared.has(l!))
            if (getters.length && declare(file, pattern.text, null)) aliases.push(`const ${pattern.text} = { ${getters.map(([n, l]) => `get ${n} () { return ${l} }`).join(', ')} }`)
          }
          if (ts.isObjectBindingPattern(pattern)) for (const element of pattern.elements) {
            if (!element.propertyName || !ts.isIdentifier(element.name) || !ts.isIdentifier(element.propertyName)) continue
            const local = resolveExport(base, target, element.propertyName.text) || element.propertyName.text
            if (local !== element.name.text && declare(file, element.name.text, null)) aliases.push(`const ${element.name.text} = ${local}`)
          }
          emit(aliases.join('\n'))
          continue
        }
        const to = respec(file, legacy.spec)
        const simple = ts.isIdentifier(pattern) || (ts.isObjectBindingPattern(pattern) && pattern.elements.every(e => !e.dotDotDotToken && !e.initializer && ts.isIdentifier(e.name) && (!e.propertyName || ts.isIdentifier(e.propertyName))))
        if (simple && ts.isVariableStatement(statement)) {
          const names = ts.isIdentifier(pattern)
            ? [{ local: pattern.text, key: `${to}\0*`, pattern: '*' }]
            : (pattern as ts.ObjectBindingPattern).elements.map(e => {
              const imported = ((e.propertyName || e.name) as ts.Identifier).text
              return { local: (e.name as ts.Identifier).text, key: `${to}\0${imported}`, pattern: imported }
            })
          requireOf(to, names, rewrite(statement, file, isEntry, respec, tree))
          continue
        }
      }

      if (!isEntry && ts.isExpressionStatement(statement) && statement.getText(tree).startsWith('module.exports')) { emit(''); continue }
      if (!hasModifier(statement, ts.SyntaxKind.DeclareKeyword)) {
        if ((ts.isFunctionDeclaration(statement) && statement.body) || ts.isClassDeclaration(statement) || ts.isEnumDeclaration(statement)) {
          if (statement.name) declare(file, statement.name.text, null)
        } else if (ts.isVariableStatement(statement)) {
          for (const d of statement.declarationList.declarations) for (const name of bindingNames(d.name)) declare(file, name, null)
        }
      }
      emit(rewrite(statement, file, isEntry, respec, tree))
    }
    chunks.push(text.slice(tree.endOfFileToken.pos, tree.endOfFileToken.end) + '\n')
  }

  visit(entry)
  const entryText = treeOf(entry).text
  const ownExports = /^\s*module\.exports\s*=/m.test(entryText)
  const names = exportNames(base, entry).filter(n => !n.startsWith('*'))
  if (!ownExports && names.length) {
    const pairs = names.map(n => [n, resolveExport(base, entry, n)] as const).filter(([, local]) => local && declared.has(local))
    chunks.push(`\nmodule.exports = { ${pairs.map(([n, local]) => n === local ? n : `${JSON.stringify(n)}: ${local}`).join(', ')} }\n`)
  }
  return chunks.join('')
}

// Текст оператора без `export`/`export default`, с пересчитанными spec относительных require/import().
function rewrite (statement: ts.Statement, file: string, isEntry: boolean, respec: (file: string, spec: string) => string, tree: ts.SourceFile): string {
  const start = statement.getStart(tree)
  const text = tree.text
  const edits: Array<[number, number, string]> = []
  if (ts.canHaveModifiers(statement)) for (const modifier of ts.getModifiers(statement) || []) {
    if (modifier.kind !== ts.SyntaxKind.ExportKeyword && modifier.kind !== ts.SyntaxKind.DefaultKeyword) continue
    let end = modifier.end
    while (end < text.length && /\s/.test(text[end]!)) end++
    edits.push([modifier.getStart(tree), end, ''])
  }
  if (!isEntry) {
    const walk = (node: ts.Node): void => {
      if (ts.isCallExpression(node)) {
        const callee = node.expression
        const isRequire = (ts.isIdentifier(callee) && callee.text === 'require') || callee.kind === ts.SyntaxKind.ImportKeyword ||
          (ts.isPropertyAccessExpression(callee) && ts.isIdentifier(callee.expression) && callee.expression.text === 'require' && callee.name.text === 'resolve')
        const arg = node.arguments[0]
        if (isRequire && arg && ts.isStringLiteralLike(arg) && arg.text.startsWith('.')) {
          const quote = text[arg.getStart(tree)]!
          edits.push([arg.getStart(tree), arg.end, quote + respec(file, arg.text) + quote])
        }
      }
      ts.forEachChild(node, walk)
    }
    walk(statement)
  }
  let out = text.slice(start, statement.end)
  for (const [from, to, code] of edits.sort((a, b) => b[0] - a[0])) out = out.slice(0, from - start) + code + out.slice(to - start)
  return out
}

// Склейка модуля и его папки тела в исходном TypeScript (с комментариями и типами) — для тестов, которые режут текст.
export function moduleSourceTs (entry: string): string {
  const file = tsPath(entry)
  if (!moduleTexts.has(file)) moduleTexts.set(file, concatenate(file))
  return moduleTexts.get(file)!
}

// Тот же скрипт без типов (esbuild): его исполняют в vm целиком или режут на объявления.
export function bodySource (entry: string): string {
  if (!hasTs(entry)) return legacyBodySource(entry)
  const file = tsPath(entry)
  if (!scripts.has(file)) scripts.set(file, transformSync(moduleSourceTs(file), { loader: 'ts' }).code)
  return scripts.get(file)!
}

function scriptTree (entry: string, options: Options): ts.SourceFile {
  const source = options.ts ? moduleSourceTs(entry) : bodySource(entry)
  return ts.createSourceFile(entry + (options.ts ? '.ts' : '.js'), source, ts.ScriptTarget.Latest, true, options.ts ? ts.ScriptKind.TS : ts.ScriptKind.JS)
}

function findDeclaration (tree: ts.SourceFile, name: string, kinds: 'function' | 'variable' | 'any'): ts.Statement | null {
  for (const statement of tree.statements) {
    if (kinds !== 'variable' && (ts.isFunctionDeclaration(statement) || ts.isClassDeclaration(statement)) && statement.name?.text === name && (!ts.isFunctionDeclaration(statement) || statement.body)) return statement
    if (kinds !== 'function' && ts.isVariableStatement(statement) && statement.declarationList.declarations.some(d => bindingNames(d.name).includes(name))) return statement
  }
  return null
}

export function functionSource (entry: string, name: string, options: Options = {}): string {
  const tree = scriptTree(entry, options)
  for (const statement of tree.statements) if (ts.isFunctionDeclaration(statement) && statement.name?.text === name && statement.body) return statement.getText(tree)
  throw new Error(`Function ${name} is missing from ${entry}`)
}

export function declarationSource (entry: string, name: string, options: Options = {}): string {
  const statement = findDeclaration(scriptTree(entry, options), name, 'variable')
  if (!statement) throw new Error(`Declaration ${name} is missing from ${entry}`)
  return statement.getText(statement.getSourceFile())
}

// Несколько объявлений верхнего уровня (function, class, const/let) по именам, в порядке перечисления.
export function declSource (entry: string, ...names: Array<string | Options>): string {
  const options = (names.find(n => typeof n === 'object') || {}) as Options
  const tree = scriptTree(entry, options)
  return names.filter((n): n is string => typeof n === 'string').map(name => {
    const statement = findDeclaration(tree, name, 'any')
    if (!statement) throw new Error(`Declaration ${name} is missing from ${entry}`)
    return statement.getText(tree)
  }).join('\n')
}

// Оператор верхнего уровня, в тексте которого есть anchor (например "defStage('iron',").
export function statementSource (entry: string, anchor: string, options: Options = {}): string {
  const tree = scriptTree(entry, options)
  for (const statement of tree.statements) if (statement.getText(tree).includes(anchor)) return statement.getText(tree)
  throw new Error(`Statement with ${JSON.stringify(anchor)} is missing from ${entry}`)
}

// То же по готовому тексту (склейка, снимок одного файла): объявления по именам и оператор по якорю, текст как есть.
export function declarationsOf (source: string, ...names: string[]): string {
  const tree = ts.createSourceFile('source.ts', source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS)
  return names.map(name => {
    const statement = findDeclaration(tree, name, 'any')
    if (!statement) throw new Error(`Declaration ${name} is missing`)
    return statement.getText(tree)
  }).join('\n')
}

export function statementOf (source: string, anchor: string): string {
  const tree = ts.createSourceFile('source.ts', source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS)
  for (const statement of tree.statements) if (statement.getText(tree).includes(anchor)) return statement.getText(tree)
  throw new Error(`Statement with ${JSON.stringify(anchor)} is missing`)
}

// Одна часть тела (`partSource('…/campaign.js', 'night-work-step')`) в том виде, в каком она входит в склейку:
// без export, с пересчитанными spec. Только её собственные операторы, без вставленных зависимостей.
export function partSource (entry: string, part: string, options: Options = {}): string {
  const file = tsPath(entry)
  const target = bodyTarget(bodyBase(file), file, './' + basename(basename(file, '.ts'), '.js') + '/' + part.replace(/\.(ts|js)$/, ''))
  if (!target) throw new Error(`Part ${part} is missing from ${bodyBase(file)}`)
  const tree = treeOf(target)
  const entryDir = dirname(file)
  const respec = (from: string, spec: string): string => {
    if (!spec.startsWith('.')) return spec
    const rel = posix(relative(entryDir, resolve(dirname(from), spec)))
    return rel.startsWith('.') ? rel : './' + rel
  }
  const out: string[] = []
  for (const statement of tree.statements) {
    const lead = tree.text.slice(statement.pos, statement.getStart(tree))
    if (ts.isImportDeclaration(statement) || ts.isImportEqualsDeclaration(statement) || ts.isExportDeclaration(statement) || ts.isExportAssignment(statement)) { out.push(lead); continue }
    if (ts.isExpressionStatement(statement) && statement.getText(tree).startsWith('module.exports')) { out.push(lead); continue }
    const legacy = requireCall(statement)
    if (legacy && bodyTarget(bodyBase(file), target, legacy.spec)) { out.push(lead); continue }
    out.push(lead + rewrite(statement, target, false, respec, tree))
  }
  const source = out.join('')
  return options.ts ? source : transformSync(source, { loader: 'ts' }).code
}

// Прежний разбор: собранный CommonJS, части только через `const x = require('./<mod>/…')`.
function legacyBodySource (entry: string): string {
  const base = resolve(dirname(entry), basename(entry, '.js')) + sep
  const seen = new Set<string>()
  const chunks: string[] = []
  function visit (file: string): void {
    if (seen.has(file)) return
    seen.add(file)
    const source = readFileSync(file, 'utf8')
    const tree = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS)
    for (const statement of tree.statements) {
      if (ts.isVariableStatement(statement)) {
        const declaration = statement.declarationList.declarations[0]
        const init = declaration?.initializer
        if (init && ts.isCallExpression(init) && init.expression.getText(tree) === 'require' && ts.isStringLiteral(init.arguments[0]!) && init.arguments[0].text.startsWith('.')) {
          const target = resolve(dirname(file), init.arguments[0].text) + '.js'
          if (target.startsWith(base)) { visit(target); continue }
        }
        if (declaration?.name.getText(tree) === 'bodyDirectory') continue
      }
      if (file !== entry && statement.getText(tree).startsWith('module.exports')) continue
      let text = statement.getText(tree)
      if (file !== entry) text = text.replace(/require\((['"])\.\.\/(\.\.?\/[^'"]+)\1\)/g, (_all, quote: string, local: string) => `require(${quote}${local}${quote})`).replace(/\bbodyDirectory\b/g, '__dirname')
      chunks.push(text)
    }
  }
  visit(entry)
  return chunks.join('\n')
}

const transpiled = new Map<string, string>()
// Исходник .ts, переведённый esbuild в CommonJS по одному файлу — тот же текст, что давала прежняя сборка рядом с исходниками.
// Тесты, которые вырезают из модуля куски по тексту и исполняют их в vm, читают его, а не dist/: печать tsc у собранного
// кода другая (отступы, кавычки), и вырезка не должна зависеть от того, чем собран dist/.
export function transpiledSource (file: string): string {
  const source = file.replace(/\.js$/, '.ts')
  if (!transpiled.has(source)) transpiled.set(source, transformSync(readFileSync(source, 'utf8'), { loader: 'ts', format: 'cjs', target: 'node24' }).code)
  return transpiled.get(source)!
}
