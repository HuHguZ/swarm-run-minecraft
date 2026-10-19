'use strict'
import * as fs from 'node:fs'
import path = require('node:path')
import { createRequire } from 'node:module'
import { transformSync } from 'esbuild'
import ts from '@typescript/typescript6'
import { bodySource, moduleSourceTs } from './source-fixture'

// Кампания для тестов — одной областью видимости: daemon/campaign.ts вместе с частями из daemon/campaign/, склеенными
// source-fixture в порядке исполнения (import → текст части, export снят, spec пересчитаны от daemon/). Тесты исполняют
// склейку в vm и подменяют её привязки (act = …, state = …) так же, как раньше подменяли привязки единого файла.
// Снимок для A/B (переменные окружения CAMPAIGN_TEST_SOURCE, CAMPAIGN_R4_SOURCE, WOOD_BOOTSTRAP_SOURCE): папка — корень
// daemon с campaign.ts и campaign/; файл .js без .ts рядом или файл .ts — как есть, одним файлом.
export const CAMPAIGN = path.join(__dirname, '../campaign.js')
// require от daemon/campaign.js: склейка просит модули spec'ами от daemon/ ('./src/route', './src/campaign/bread'), как вход.
export const campaignRequire = createRequire(CAMPAIGN)

function entryOf (override?: string): string | null {
  if (!override) return CAMPAIGN
  if (fs.statSync(override).isDirectory()) return path.join(override, 'campaign.js')
  if (override.endsWith('.js') && fs.existsSync(override.replace(/\.js$/, '.ts'))) return override
  return null
}

// Скрипт JS (типы сняты) для исполнения целиком.
export function campaignScript (override?: string): string {
  const entry = entryOf(override)
  if (entry) return bodySource(entry)
  const text = fs.readFileSync(override!, 'utf8')
  return override!.endsWith('.ts') ? transformSync(text, { loader: 'ts' }).code : text
}

// Текст TypeScript с комментариями — для тестов, которые режут его по якорям.
export function campaignTs (override?: string): string {
  const entry = entryOf(override)
  return entry ? moduleSourceTs(entry) : fs.readFileSync(override!, 'utf8')
}

// Общее состояние кампании живёт в daemon/campaign/state.ts (`export let x` + `export function setX (v) { return (x = v) }`),
// части пишут его через сеттеры. Тест, который исполняет вырезанный кусок в своём контексте, держит x как свойство
// контекста: withSetters даёт контексту setX, пишущий ctx.x.
let setterPairs: Array<[string, string]> | null = null
function setters (): Array<[string, string]> {
  if (setterPairs) return setterPairs
  const file = path.join(path.dirname(CAMPAIGN), 'campaign/state.ts')
  setterPairs = []
  if (!fs.existsSync(file)) return setterPairs
  const tree = ts.createSourceFile(file, fs.readFileSync(file, 'utf8'), ts.ScriptTarget.Latest, true, ts.ScriptKind.TS)
  const target = (node: ts.Node): string | null => {
    if (ts.isBinaryExpression(node) && node.operatorToken.kind === ts.SyntaxKind.EqualsToken && ts.isIdentifier(node.left)) return node.left.text
    let found: string | null = null
    ts.forEachChild(node, child => { found = found || target(child) })
    return found
  }
  for (const statement of tree.statements) {
    if (!ts.isFunctionDeclaration(statement) || !statement.name || !/^set[A-Z]/.test(statement.name.text) || !statement.body) continue
    const name = target(statement.body)
    if (name) setterPairs.push([statement.name.text, name])
  }
  return setterPairs
}

export function withSetters<T extends Record<string, any>> (ctx: T): T {
  const c: any = ctx
  for (const [setter, name] of setters()) if (!(setter in c)) c[setter] = (v: any) => (c[name] = v)
  return ctx
}

// Сеттеры текстом — для кусков, которые тест исполняет в своей функции со своими `let` (а не в контексте vm).
// Без имён — все сеттеры state.ts.
export function setterSource (...names: string[]): string {
  const pairs: Array<[string, string]> = names.length ? names.map(name => [`set${name[0]!.toUpperCase()}${name.slice(1)}`, name]) : setters()
  return pairs.map(([setter, name]) => `function ${setter} (v) { return (${name} = v) }`).join('\n')
}
