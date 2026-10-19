'use strict'
// Загрузчик кампании для тестов campaign-*.test.ts (бывший campaign.test.ts): склейка в vm, RPC — сокет-заглушка.
import { campaignSocket, campaignVm, daemonReply, fakeDate } from './campaign-source'
import { withClockFixture } from './clock-fixture'
import * as netherSupply from '../src/campaign/nether-supply'

// Настоящие функции кампании, внешняя граница — RPC вместо живого Minecraft.
// Загрузчик не открывает сокет, не пишет журнал и не запускает кампанию сам.
// Часы кампании для тестов политики повторов: Date.now() — clock.t, «ожидание» двигает его вперёд.

function campaign (state, situation, handle: (...args: any[]) => any = () => ({} as Record<string, any>), { logs = null, records = null, env = {} as Record<string, any>, argv = [], clock = null, onStatus = null }: any = {} as Record<string, any>) {
  const context = campaignVm(`
    module.exports = { act, refresh, readMemory, nextBastion, viaNetherTo, ensurePick, ensureTable, died: () => died, stage: name => { stage = name }, craft, replenishNetherSupply, nightGuard, rest, eatTo, recoverGuard, descend, goToward, returnFromNether, spares, toSurface, unclutter, smeltAll, mineSeenAll, lightUp, known, makeBed,
      changeNetherCause: () => typeof changeNetherCause === 'function' ? changeNetherCause() : false, deferBastionMining, pearlTrip: () => ({ ...pearlTrips }), pearlPrice: endermenSecondsPerPearl, forestToHunt, emptyForests: () => emptyForests, trackedHunt: async () => { strategyExecuting = true; try { return await act('pearls', {}) } finally { strategyExecuting = false; strategyInterrupted = false } }, retryState: typeof netherRetryState === 'function' ? netherRetryState : () => '', fightReady: () => fightReady(), gearWorth: (item, o) => gearWorth(item, o), wantFightGear: () => { fightGearWanted = true },
      continueFortressChoice: (selection, blocked) => typeof continueFortressChoice === 'function' ? continueFortressChoice(selection, blocked) : false, worldObservation: () => intelligence.environment.observe(),
      runStage: (name, ...args) => STAGES.find(s => s.name === name).run(...args),
      needs: name => STAGES.find(s => s.name === name).needed(),
      ready: name => STAGES.find(s => s.name === name).ready(),
      done: name => STAGES.find(s => s.name === name).done(),
      wantBeds: n => { wantBeds = n },
      defers: name => STAGES.find(s => s.name === name).defer(),
      boot: () => ws.listeners.get('open')(), intelligenceObservation, executeStrategy,
      keepStages: names => { const keep = STAGES.filter(s => names.includes(s.name)); STAGES.splice(0, STAGES.length, ...keep) },
      ironOnly: run => { STAGES.splice(0, STAGES.length, { name: 'iron', needed: () => !have(PICK_IRON),
        ready: () => true, defer: () => false, done: () => have(PICK_IRON) > 0, run }); },
      bastionOnly: run => { STAGES.splice(0, STAGES.length, { name: 'bastion', needed: () => true,
        ready: () => true, defer: () => false, done: () => false, run }); },
      netherOnly: run => { STAGES.splice(0, STAGES.length, { name: 'nether', needed: () => have('blaze_rod') < 7,
        ready: () => true, defer: () => false, done: () => have('blaze_rod') >= 7, run }); },
      deferBastion: (site, until) => { bState(site).miningDeferredUntil = until },
      castFailed: () => { castSurfaceFailed = true },
      hooks: h => { if (h.spares) spares = h.spares; if (h.ensurePick) ensurePick = h.ensurePick;
        if (h.recoverGuard) recoverGuard = h.recoverGuard; if (h.toSurface) toSurface = h.toSurface; },
      init: () => { state = testState; sit = testSituation; }
    }
  `, { socket: campaignSocket(daemonReply(state, situation, handle, onStatus)), log: line => { if (logs) logs.push(String(line)) },
    require: name => name === './src/telemetry' && records ? { ...(require('../src/telemetry') as typeof import('../src/telemetry')), on: () => true, record: row => records.push(row) } :
      name === './src/campaign/nether-supply' ? netherSupply : undefined,
    argv: ['node', 'campaign.js', ...argv], env, date: clock ? fakeDate(clock) : Date, wrap: withClockFixture,
    globals: { testState: state, testSituation: situation }, source: process.env.CAMPAIGN_TEST_SOURCE })
  context.module.exports.init()
  return context.module.exports
}

export { campaign }
