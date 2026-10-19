import { campaignScript } from './campaign-source'
import { cjsContext } from './cjs-context'
import test = require('node:test')
import assert = require('node:assert/strict')
import * as fs from 'node:fs'
import path = require('node:path')
import * as vm from 'node:vm'
import { createRequire } from 'node:module'
import { withClockFixture } from './clock-fixture'

// Выход из Ада без записи «портал (ад)» (вход прерван тактикой — s1-post08 06.10): идти к x/8, z/8 портала верхнего мира.
function exitFixture() {
  const state = { health: 20, food: 20, dimension: 'the_nether', pos: { x: 106, y: 69, z: -151 },
    armor: {}, potions: {}, inventory: { ender_eye: 10, cooked_beef: 12 } as Record<string, number> }
  const requests: Array<{ method: string; params: Record<string, any> }> = []
  class Socket {
    listeners = new Map<string, (...args: unknown[]) => void>()
    on(name: string, handler: (...args: unknown[]) => void) { this.listeners.set(name, handler) }
    send(raw: string) {
      const { id, method, params } = JSON.parse(raw)
      requests.push({ method, params })
      const detail = method === 'situation' ? { surface: false, foes: 0 } : {}
      queueMicrotask(() => this.listeners.get('message')!(JSON.stringify({ id, ok: true, result: { status: 'done', detail, state, events: [] } })))
    }
    close() {}
  }
  const filename = path.resolve(__dirname, '../campaign.js')
  const local = createRequire(filename)
  const context = { require: (name: string) => name === 'ws' ? Socket : name === 'fs' ? { appendFileSync() {} } : local(name),
    __dirname: path.dirname(filename), module: { exports: {} as Record<string, any> },
    process: { argv: ['node', 'campaign.js'], env: { ND_NE_ROUTE: '1' } },
    console: { log() {}, error() {} }, setTimeout, Date, queueMicrotask, AbortController, fixtureState: state }
  vm.runInNewContext(campaignScript() + `
    state = fixtureState; sit = { surface: false, foes: 0 };
    known.portal = { x: 236, y: 68, z: 170, dimension: 'overworld' };
    known.netherPortal = null;
    module.exports = { leave: returnFromNether };
  `, cjsContext(withClockFixture(context)))
  return { context, requests }
}

test('leaving the Nether without a recorded arrival portal routes to the overworld portal divided by eight', async () => {
  const { context, requests } = exitFixture()
  await context.module.exports.leave()
  const route = requests.find(r => r.method === 'ne_route')
  assert.ok(route, 'a route toward the linked portal is attempted before portal enter')
  assert.equal(route!.params.x, 30)
  assert.equal(route!.params.z, 21)
  const portal = requests.findIndex(r => r.method === 'portal')
  assert.ok(portal === -1 || requests.findIndex(r => r.method === 'ne_route') < portal, 'portal enter only after the route')
})
