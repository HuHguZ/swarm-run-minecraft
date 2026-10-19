'use strict'
import { REPO_ROOT } from '../../daemon/src/paths'
// Контроль A/B: старый combat только у нечётных слотов лабораторной фермы.
// Загрузка через NODE_OPTIONS=--require; server-run и арена не допускаются.
const port = Number(process.env.MC_PORT)
if (process.env.ND_LAB_COMBAT_COMPARE === '1' && port >= 25601 && port <= 25610) {
  // Внутренности загрузчика (_load, _resolveFilename, _nodeModulePaths, _compile) в типах node не описаны.
  const Module: any = require('module')
  const fs: typeof import('fs') = require('fs')
  const path: typeof import('path') = require('path')
  const crypto: typeof import('crypto') = require('crypto')
  const combat = path.resolve(__dirname, '../../daemon/src/combat.js')
  const pvp = path.resolve(__dirname, '../../daemon/src/pvp.js')
  const load = Module._load
  const baselines = new Map()
  const announced = new Set()
  Module._load = function (request, parent, isMain) {
    const resolved = Module._resolveFilename(request, parent)
    if (resolved !== combat && resolved !== pvp) return load.call(this, request, parent, isMain)
    const backup = path.resolve(REPO_ROOT, 'run/backups/2026-09-28-food-ab', path.basename(resolved))
    const source = fs.readFileSync(port % 2 ? backup : resolved, 'utf8')
    if (!announced.has(resolved)) {
      announced.add(resolved)
      console.log('[lab-' + path.basename(resolved, '.js') + ']', port % 2 ? 'baseline' : 'fixed',
        crypto.createHash('sha256').update(source).digest('hex'))
    }
    if (!(port % 2)) return load.call(this, request, parent, isMain)
    let baseline = baselines.get(resolved)
    if (!baseline) {
      baseline = new Module(resolved, parent)
      baselines.set(resolved, baseline)
      baseline.filename = resolved
      baseline.paths = Module._nodeModulePaths(path.dirname(resolved))
      baseline._compile(source, resolved)
      baseline.loaded = true
    }
    return baseline.exports
  }
}
