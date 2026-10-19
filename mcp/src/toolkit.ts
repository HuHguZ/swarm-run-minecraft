// Общее для регистрации инструментов: ответы text/fail и tool() — обычный инструмент, который зовёт метод демона
// и рендерит ответ. server и daemon создаёт index.ts и передаёт сюда (makeTool) и в tools/*.ts (Toolkit).
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js'
import type { DaemonClient } from './daemon-client.js'
import { render } from './format.js'

const text = (s: string): CallToolResult => ({ content: [{ type: 'text', text: s }] })
const fail = (s: string): CallToolResult => ({ content: [{ type: 'text', text: s }], isError: true })

function makeTool (server: McpServer, daemon: DaemonClient) {
  return function tool (name, description, inputSchema, method, transform?: any) {
    server.registerTool(name, { description, inputSchema }, async (args: any = {} as Record<string, any>) => {
      try {
        const params = transform ? transform(args) : args
        const result = await daemon.call(method, params)
        return text(render(name.replace(/^mc_/, ''), result))
      } catch (err) {
        return fail(`${name}: ${err.message}`)
      }
    })
  }
}

type Toolkit = { tool: ReturnType<typeof makeTool>, server: McpServer, daemon: DaemonClient }

export { text, fail, makeTool }
export type { Toolkit }
