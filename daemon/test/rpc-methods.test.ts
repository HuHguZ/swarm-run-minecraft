'use strict'
import test = require('node:test')
import assert = require('node:assert/strict')
import { createMethods } from '../src/rpc/methods'

// Имена RPC-методов демона — контракт со сценами, кампанией, ареной и MCP (вызов по имени через WebSocket). Обработчики
// разнесены по rpc/*.ts (20.10.2026); список снят с прежнего src/index.ts — ни одно имя не должно пропасть или смениться.
const NAMES = [
  'status', 'peek', 'douse_lava', 'clear_water', 'evade', 'juke', 'take_cover', 'fly_to', 'swarm_work',
  'items_near', 'ladder_up', 'tnt_at', 'center_in', 'box_in', 'box_out', 'swarm_hold', 'swarm_pillar',
  'swarm_keep', 'swarm_pose', 'swarm_position', 'ledge_to', 'lance', 'wind_receive', 'wind_boost', 'dig_to', 'wind_leap',
  'undercut', 'peek_shot', 'rescue_config', 'wind_push', 'watch_dangers', 'connect', 'disconnect', 'say', 'goto',
  'flight_route', 'boat_hop', 'boat_climb', 'parkour', 'follow', 'escort', 'give', 'take', 'stop', 'wait',
  'look_at', 'emote', 'observe', 'perceive', 'players', 'look', 'mine', 'explore', 'dig_down', 'craft', 'place',
  'flint_grind', 'fight', 'assist', 'team_hint', 'fight_yield', 'fight_guard', 'temper', 'play_mode', 'flee', 'stronghold',
  'bucket', 'obsidian', 'pack', 'cache', 'animals', 'golem', 'wool', 'trade', 'blaze', 'fortress', 'pearls',
  'bastion', 'nether_tunnel', 'ne_burrow', 'ne_gold_first', 'ne_recover', 'pen', 'ne_route', 'unstuck', 'dragon', 'shoot', 'throw', 'prep',
  'enchant', 'brew', 'kit', 'loot', 'structure', 'auto_loot', 'xp_bottles', 'loot_seen', 'assess', 'ask',
  'slice', 'blocks_around', 'dig_time', 'tunnel', 'mine_seen', 'smelt', 'furnace_take', 'chest_put',
  'chest_take', 'chest_list', 'base', 'stash', 'armor', 'shelter', 'refuge', 'surface', 'recover', 'portal',
  'portal_natural', 'build', 'sort', 'sign', 'farm', 'ride', 'mechanism', 'sleep', 'wake', 'phys', 'profile',
  'equip', 'eat', 'burrow', 'wind_jump', 'pearl_to', 'block_behind', 'mobs', 'drink_buffs', 'drop', 'set_goal',
  'remember', 'recall', 'situation', 'escape_fire', 'director',
  // гонка вооружений (поток «тайники», 21.10): скан глаз и «пирога», бросок жемчуга наверх (rpc/caches.ts)
  'cache_scan', 'pearl_plan', 'pearl_up',
  // выход из лавовой ямы вне боя (поток «окружение», 21.10: rpc/pvp-escape.ts)
  'lava_escape',
  // уход от горящего динамита и его цепочки (22.10: rpc/hazards.ts)
  // таран копьём по приказу (23.10: rpc/aerial.ts lance, сцена pvp/try-lance)
  'dodge_blast', 'clear_web', 'enemy_wind_plan', 'wind_out', 'wind_report'
]

test('daemon RPC: every method name survives the split into rpc/*.ts, each exactly once', () => {
  assert.equal(new Set(NAMES).size, 152)
  const methods = createMethods({ session: {}, cfg: {}, bus: {}, vision: {}, director: {}, gameClock: {}, state: { dangerWatch: null } })
  assert.deepEqual(Object.keys(methods).sort(), [...NAMES].sort())
  for (const name of NAMES) assert.equal(typeof methods[name], 'function', name)
})
