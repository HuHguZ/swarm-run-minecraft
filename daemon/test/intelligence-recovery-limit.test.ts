const test = require('node:test')
const assert = require('node:assert/strict')
const { createCampaignIntelligence } = require('../src/campaign/intelligence')

test('legacy recovery shares the director failure bound and leaves another eligible recovery available', async () => {
  const attempts: string[] = []
  const intelligence = createCampaignIntelligence({
    eyes: 10, beds: 1, now: () => 0,
    observe: async () => ({ state: { dimension: 'unknown', health: 20, food: 20, inventory: {} } }),
    call: async () => ({}), sleep: async () => {}, record() {},
    execute: async command => { attempts.push(command.skill); return { outcome: 'FAILURE', events: [] } }
  })
  const stage = name => ({ name, needed: () => true, ready: () => true, defer: () => false, done: () => false, run: async () => {} })
  const stages = [stage('firstRepair'), stage('secondRepair')]
  for (let i = 0; i < 2; i++) {
    const selected = await intelligence.select(stages, () => false)
    assert.equal(selected.stage.name, 'firstRepair')
    await selected.stage.run()
  }
  const next = await intelligence.select(stages, () => false)
  assert.equal(next.stage.name, 'secondRepair')
  for (let i = 0; i < 2; i++) {
    const selected = await intelligence.select(stages, () => false)
    assert.equal(selected.stage.name, 'secondRepair')
    await selected.stage.run()
  }
  assert.equal(await intelligence.select(stages, () => false), null)
  assert.deepEqual(attempts, ['firstRepair', 'firstRepair', 'secondRepair', 'secondRepair'])
})
