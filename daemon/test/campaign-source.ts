'use strict'
import * as fs from 'node:fs'
import path = require('node:path')
import { createRequire } from 'node:module'
import { transformSync } from 'esbuild'
import ts from '@typescript/typescript6'
import * as vm from 'node:vm'
import { bodySource, moduleSourceTs } from './source-fixture'
import { cjsContext } from './cjs-context'

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

// ---------------------------------------------------------------- кампания в vm (общий загрузчик тестов)
// Сокет демона для склейки в vm: send отвечает result(method, params) следующей микрозадачей, как сеть. result —
// результат RPC целиком ({ status, detail, state, events }; rpcDone — обычный «done»), считается в момент send, а в
// JSON — уже в микрозадаче (state уходит каким стал к ответу). Без result — сокет только с on(): кампания его не зовёт.
export type RpcReply = (method: string, params: any) => any
export function campaignSocket (result?: RpcReply): any {
  if (!result) return class Socket { on () {} }
  return class Socket {
    listeners = new Map<string, (...args: any[]) => void>()
    on (name: string, fn: (...args: any[]) => void) { this.listeners.set(name, fn) }
    send (raw: string) {
      const { id, method, params } = JSON.parse(raw)
      const reply = result(method, params)
      queueMicrotask(() => this.listeners.get('message')!(JSON.stringify({ id, ok: true, result: reply })))
    }
    close () {}
  }
}
export const rpcDone = (detail: any, state: any): any => ({ status: 'done', detail, state, events: [] })

export interface CampaignVmOptions {
  socket?: any                                     // класс для require('ws'); по умолчанию — campaignSocket()
  log?: (line: string) => void                     // fs.appendFileSync журнала кампании
  require?: (name: string) => any                  // свои модули; undefined — настоящий (base или campaignRequire)
  base?: NodeJS.Require                            // require прочих модулей (другой корень для A/B)
  dirname?: string
  env?: Record<string, any>
  argv?: string[]                                  // process.argv целиком
  date?: any                                       // Date контекста (часы теста)
  console?: any
  globals?: Record<string, any>                    // прочие имена контекста (testState, fixture, …)
  source?: string                                  // снимок кампании (CAMPAIGN_TEST_SOURCE)
  wrap?: (context: any) => any                     // обёртка контекста (withClockFixture)
}

// Кампания одной областью видимости в vm с внешней границей тестов: сокет вместо демона, журнал в память, свои модули.
// append — код после склейки (подмены привязок, module.exports = { … }). Возвращает контекст (module.exports — его).
export function campaignVm (append: string, o: CampaignVmOptions = {}): any {
  const base = o.base || campaignRequire
  const context: any = {
    require: (name: string) => name === 'ws' ? (o.socket || campaignSocket()) : name === 'fs' ? { appendFileSync (_file: string, line: string) { o.log?.(line) } }
      : (o.require && o.require(name)) ?? base(name),
    __dirname: o.dirname ?? path.dirname(CAMPAIGN), module: { exports: {} as Record<string, any> },
    process: { argv: o.argv || ['node', 'campaign.js'], env: o.env || {} },
    console: o.console || { log () {}, error () {} }, setTimeout, Date: o.date || Date, queueMicrotask, ...o.globals
  }
  vm.runInNewContext(campaignScript(o.source) + append, cjsContext(o.wrap ? o.wrap(context) : context))
  return context
}

// Часы теста для Date контекста: fakeDate — только Date.now() = clock.t; clockDate — и new Date() без аргументов.
export function fakeDate (clock: { t?: number }): any { return class extends Date { static now () { return clock.t } } }
export function clockDate (clock: { t?: number }): any {
  return class Time extends Date { constructor (...args: any[]) { super(...((args.length ? args : [clock.t]) as [any])) } static now () { return clock.t } }
}

// Ответ «как демон» для загрузчиков с handle: situation и status — свои, остальное — handle(method, params);
// detail.rpcResult — результат RPC целиком (отказ, прерывание).
export function daemonReply (state: any, situation: any, handle: RpcReply, onStatus?: (() => any) | null): RpcReply {
  return (method, params) => {
    const detail = method === 'situation' ? situation : method === 'status' ? ((onStatus && onStatus()) || {}) : handle(method, params)
    return detail?.rpcResult || rpcDone(detail, state)
  }
}
