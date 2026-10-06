import { readFileSync } from 'node:fs'
import { dirname, resolve, sep, basename } from 'node:path'
import ts from '@typescript/typescript6'

export function bodySource(entry: string): string {
  const base = resolve(dirname(entry), basename(entry, '.js')) + sep
  const seen = new Set<string>()
  const chunks: string[] = []
  function visit(file: string): void {
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

export function functionSource(entry: string, name: string): string {
  const source = bodySource(entry)
  const tree = ts.createSourceFile(entry, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS)
  for (const statement of tree.statements) if (ts.isFunctionDeclaration(statement) && statement.name?.text === name) return statement.getText(tree)
  throw new Error(`Function ${name} is missing from ${entry}`)
}

export function declarationSource(entry: string, name: string): string {
  const source = bodySource(entry)
  const tree = ts.createSourceFile(entry, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS)
  for (const statement of tree.statements) if (ts.isVariableStatement(statement) && statement.declarationList.declarations.some(declaration => declaration.name.getText(tree) === name)) return statement.getText(tree)
  throw new Error(`Declaration ${name} is missing from ${entry}`)
}
