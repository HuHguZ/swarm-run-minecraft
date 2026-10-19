import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { DaemonClient } from './daemon-client.js'
import { INSTRUCTIONS } from './instructions.js'
import { makeTool, type Toolkit } from './toolkit.js'
import * as bodyTools from './tools/body.js'
import * as resourcesTools from './tools/resources.js'
import * as combatTools from './tools/combat.js'
import * as progressionTools from './tools/progression.js'
import * as inventoryTools from './tools/inventory.js'
import * as survivalTools from './tools/survival.js'
import * as buildingTools from './tools/building.js'
import * as mindTools from './tools/mind.js'

const daemon = new DaemonClient(process.env.ND_WS || 'ws://127.0.0.1:8765')

const server = new McpServer(
  { name: 'neurodown', version: '0.1.0' },
  { instructions: INSTRUCTIONS }
)

// Инструменты — по темам в tools/*.ts; полный список и описания — там.
const kit: Toolkit = { tool: makeTool(server, daemon), server, daemon }
bodyTools.register(kit)
resourcesTools.register(kit)
combatTools.register(kit)
progressionTools.register(kit)
inventoryTools.register(kit)
survivalTools.register(kit)
buildingTools.register(kit)
mindTools.register(kit)

await server.connect(new StdioServerTransport())
