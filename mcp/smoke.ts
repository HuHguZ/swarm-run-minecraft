// End-to-end check: drives the MCP server over stdio exactly like Claude Code
// will, so a broken tool schema fails here and not in the middle of a game.
//
// Two modes, and the safe one is the default. There is exactly one bot in the
// world and several agents working on it at once, so a script that connects and
// walks it around must never be the thing that runs when someone types
// `node smoke.js` to see whether the schemas still parse.
//
//   node smoke.js          — поднять сервер, перечислить инструменты, проверить
//                            схемы. Демона не трогает, в игру не заходит.
//   node smoke.js --live   — то же плюс настоящие вызовы: демон должен быть
//                            запущен, и бот в мире действительно шевельнётся.
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const live = process.argv.includes('--live')
const here = dirname(fileURLToPath(import.meta.url))

// Absolute, because the working directory of whoever runs this is not our
// business — the same reason .mcp.json spells the path out in full.
const transport = new StdioClientTransport({ command: process.execPath, args: [join(here, 'src', 'index.js')] })
const client = new Client({ name: 'neurodown-smoke', version: '0.1.0' })
await client.connect(transport)

const { tools } = await client.listTools()
console.log(`инструментов: ${tools.length}`)

let bad = 0
for (const t of tools) {
  const problems = []
  // Ten characters, not fifty: «Встать с кровати.» is a complete description of
  // a complete tool, and a length rule that calls it broken teaches nobody
  // anything. The rule is only here to catch an empty string.
  if (!t.description || t.description.length < 10) problems.push('нет описания')
  if (!t.inputSchema || t.inputSchema.type !== 'object') problems.push('схема входа не объект')
  if (problems.length) { bad++; console.log(`  [ПЛОХО] ${t.name}: ${problems.join(', ')}`) }
}
// Descriptions ride along in every session's context, so their total size is a
// standing cost worth seeing rather than discovering later.
const chars = tools.reduce((n, t) => n + (t.description || '').length, 0)
console.log(`описаний: ${chars} символов (~${Math.round(chars / 3)} токенов на сессию)`)
console.log(bad ? `[ПЛОХО] инструментов с проблемами: ${bad}` : '[ OK ] схемы и описания на месте')

if (!live) {
  console.log('\nживые вызовы пропущены. Бот в мире один — запускай с --live осознанно.')
  await client.close()
  process.exit(bad ? 1 : 0)
}

async function run (name, args: any = {} as Record<string, any>) {
  const r: any = await client.callTool({ name, arguments: args })
  const body = r.content.filter(c => c.type === 'text').map(c => c.text).join('\n')
  console.log(`--- ${name} ${JSON.stringify(args)} ${r.isError ? '[ERROR]' : ''}\n${body}\n`)
  return r
}

await run('mc_connect')
await run('mc_set_goal', { text: 'осмотреться и не помереть' })
await run('mc_say', { text: 'подключился, я NeuroDown' })
await run('mc_observe', { radius: 16 })
await run('mc_status')
await run('mc_wait', { seconds: 5 })
await run('mc_recall', { lines: 8 })

await client.close()
process.exit(bad ? 1 : 0)
