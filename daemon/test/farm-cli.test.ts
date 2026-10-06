import test from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import path from 'node:path'

test('an invalid farm slot flag fails before starting scenes on other worlds', () => {
  const result = spawnSync(process.execPath, [path.resolve(__dirname, '../../farm/farm.js'), 'run', 'try-lab-ne-run.js', '--slots30'], { encoding: 'utf8', timeout: 3000, windowsHide: true })
  assert.equal(result.status, 1)
  assert.match(result.stderr, /неизвестный параметр --slots30/)
  assert.equal(result.stdout, '')
})
