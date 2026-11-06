// node dist/farm/series/collect-check.js — реальные shell-потоки с заглушками farm.js, без миров.
'use strict'
import { REPO_ROOT } from '../../daemon/src/paths'
import assert from 'node:assert/strict'
import * as fs from 'node:fs'
import * as os from 'node:os'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
const root = REPO_ROOT
const gitBash = process.platform === 'win32' && process.env.ProgramFiles && path.join(process.env.ProgramFiles, 'Git', 'bin', 'bash.exe')
const bash = process.env.BASH_EXE || (gitBash && fs.existsSync(gitBash) ? gitBash : 'bash')
const shellPath = p => p.replace(/\\/g, '/').replace(/^([A-Za-z]):/, (_, d) => '/' + d.toLowerCase())
const quote = s => "'" + s.replace(/'/g, "'\\''") + "'"
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'nd-collect-check-with spaces-'))
assert.equal(path.dirname(path.resolve(tmp)), path.resolve(os.tmpdir()))
assert.ok(path.basename(tmp).startsWith('nd-collect-check-'))
const write = (p, s) => { fs.mkdirSync(path.dirname(path.join(tmp, p)), { recursive: true }); fs.writeFileSync(path.join(tmp, p), s) }
try {
  for (const file of ['farm/series/collect.sh', 'farm/route-scan/series.sh', 'farm/series/ne-series.sh']) {
    const source = fs.readFileSync(path.join(root, file), 'utf8')
    const syntax = spawnSync(bash, ['-n', path.join(root, file)], { encoding: 'utf8', windowsHide: true })
    assert.equal(syntax.status, 0, syntax.stderr)
    let sandbox = source
    if (file === 'farm/series/collect.sh') {
      assert.match(source, /while ok 36;/)
      assert.match(source, /while ok 66;/)
      // Только в копии: два плеча вместо ожидания настенного срока.
      sandbox = sandbox.replace(/^ok \(\) \{.*$/m, 'ok () { [ "$k" -lt 2 ]; }')
      sandbox = 'export PATH=' + quote(shellPath(path.join(tmp, 'bin')) + ':' + shellPath(path.dirname(process.execPath)) + ':/usr/bin:/bin') + '\n' + sandbox
    }
    write(file, sandbox)
  }
  fs.mkdirSync(path.join(tmp, 'dist/farm'), { recursive: true })
  fs.copyFileSync(path.join(__dirname, '..', 'tick-control.js'), path.join(tmp, 'dist/farm/tick-control.js'))
  write('farm/limits.json', JSON.stringify({ maxUp: 4, tickRate: 750 }))
  write('farm/seeds/good-v2.json', JSON.stringify({ seeds: Array.from({ length: 9 }, (_, i) => ({ seed: i + 100, lava: 1 })) }))
  for (let i = 1; i <= 9; i++) write(`farm/route-scan/${i}.json`, '{"gravelBuried":[]}')
  write('dist/farm/route-scan/report.js', '')
  write('farm/series/ne-cycle.sh', '#!/bin/sh\nnode dist/farm/farm.js ne-cycle "$@"\n')
  write('dist/farm/farm.js', `const fs=require('fs');fs.appendFileSync('calls.jsonl',JSON.stringify({args:process.argv.slice(2),rate:process.env.TICK_RATE,clock:process.env.ND_CLOCK,barter:process.env.ND_BARTER_FLOW,gold:process.env.ND_GOLD_ROUTE})+'\\n');console.log('✓')\n`)
  write('bin/sleep', '#!/bin/sh\nexit 0\n')
  write('bin/powershell', '#!/bin/sh\necho 0\n')
  for (const p of ['bin/sleep', 'bin/powershell', 'farm/series/ne-cycle.sh']) fs.chmodSync(path.join(tmp, p), 0o755)
  fs.mkdirSync(path.join(tmp, 'farm/results'), { recursive: true })
  fs.mkdirSync(path.join(tmp, 'farm/logs/neF3'), { recursive: true })
  const run = (overrides: any = {} as Record<string, any>) => {
    fs.writeFileSync(path.join(tmp, 'calls.jsonl'), '')
    const env = { ...process.env }
    for (const key of ['TICK_RATE', 'FARM_MAX_UP', 'ROUTE', 'NETHER', 'ROUTE_SLOTS']) delete env[key]
    const script = path.join(tmp, 'farm', 'series', 'collect.sh')
    const result = spawnSync(bash, [script, '-', 'check'], { cwd: path.dirname(tmp), env: { ...env, ...overrides }, encoding: 'utf8', windowsHide: true, timeout: 15000 })
    const calls = fs.readFileSync(path.join(tmp, 'calls.jsonl'), 'utf8').trim().split('\n').filter(Boolean).map(JSON.parse as (text: string) => any)
    return { result, calls }
  }
  for (const [env, rs, ns, rate] of [
    [{} as Record<string, any>, '8,9', '1,2', '750'],
    [{ NETHER: '0', TICK_RATE: '123' }, '8,9,10,11', '', '123'],
    [{ ROUTE: '0' }, '', '1,2,3,4', '750'],
    [{ FARM_MAX_UP: '2' }, '8', '1', '750']
  ]) {
    const { result, calls } = run(env)
    assert.equal(result.status, 0, result.stderr || result.error?.message)
    assert.ok(calls.length)
    assert.ok(calls.every(c => c.rate === rate && c.clock === 'game'))
    const route = calls.filter(c => c.args[0] === 'run')
    const nether = calls.filter(c => c.args[0] === 'ne-cycle')
    assert.equal(route.length, rs ? 2 : 0)
    if (rs) {
      assert.ok(route.every(c => c.args[c.args.indexOf('--slots') + 1] === rs))
      assert.ok(route[0].args.includes('DEATHS_MAX=1') && route[1].args.includes('ND_ROUTE_SHAFT_BACK=1'))
      const up = calls.filter(c => c.args[0] === 'up')
      const n = rs.split(',').length
      assert.equal(up.length, n * 2)
      assert.deepEqual(up.slice(0, n).map(c => c.args.at(-1)), up.slice(n).map(c => c.args.at(-1)))
    }
    assert.equal(nether.length, ns ? ns.split(',').length * 2 : 0)
    if (ns) {
      assert.deepEqual([...new Set(nether.map(c => c.args[1]))].sort(), ns.split(',').sort())
      const a = nether.filter(c => c.args[2] === 'checkN1ax').sort((a, b) => a.args[1].localeCompare(b.args[1]))
      const b = nether.filter(c => c.args[2] === 'checkN2bx').sort((a, b) => a.args[1].localeCompare(b.args[1]))
      assert.deepEqual(a.map(c => c.args[3]), b.map(c => c.args[3]))
      assert.ok(a.every(c => !c.barter && c.gold === '1'))
      assert.ok(b.every(c => c.barter === '1' && c.args.includes('MINUTES=60') && c.args.some(v => v.includes('"ND_BARTER_FLOW":"1"'))))
    }
    const owned = new Set([...(rs ? rs.split(',') : []), ...(ns ? ns.split(',') : [])])
    assert.ok(calls.filter(c => c.args[0] === 'down').every(c => c.args[1].split(',').every(s => owned.has(s))))
  }
  for (const env of [{ TICK_RATE: 'wrong' }, { FARM_MAX_UP: '0' }, { FARM_MAX_UP: '1' }]) {
    const { result, calls } = run(env)
    assert.notEqual(result.status, 0)
    assert.equal(calls.length, 0)
  }
  console.log('collect check PASS: 2+2 / route4 / nether4 / env overrides / A-B seeds and flags / validation; bash -n 3/3')
} finally {
  fs.rmSync(tmp, { recursive: true, force: true })
}
