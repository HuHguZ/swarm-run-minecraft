'use strict'
import { cjsContext } from './cjs-context'
import test = require('node:test')
import assert = require('node:assert/strict')
import * as fs from 'fs'
import path = require('path')
import * as vm from 'vm'
import { createRequire } from 'module'
const Vec3: typeof import('vec3').Vec3 = require('vec3')
test('failed scoop is not counted in the high-source reserve', () => {
  const file = path.resolve(__dirname, '../src/cast1.js')
  const context = { require: createRequire(file), module: { exports: {} as Record<string, any> }, process }
  vm.runInNewContext(fs.readFileSync(file, 'utf8') + `
    C = () => ({ eyes: b => b.entity.position, levelOf: b => b.level, scoopAim: (b, p) => p });
    lakeReach = () => ({ top: new Set(['0,-1,3','1,-1,3','2,-1,3','3,-1,3']) });
    module.exports.check = lavaInReach;
  `, cjsContext(context))
  const lava = new Set(['0,-1,3','1,-1,3','2,-1,3','3,-1,3'])
  const bot = { entity: { position: new Vec3(0, 0, 0) }, blockAt: p => lava.has(`${p.x},${p.y},${p.z}`) ? { name: 'lava', level: 0 } : { name: 'air' } }
  const g = { H: (i,j) => new Vec3(i,j,3) }
  const sources = context.module.exports.check(bot,g,new Set(['0,-1,3']),{ keep: 3 })
  assert.equal(sources.length,0,'the remaining three sources must all stay for the top')
})
