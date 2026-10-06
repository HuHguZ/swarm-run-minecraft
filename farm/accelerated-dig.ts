import fs from 'node:fs'
import path from 'node:path'
import { createHash } from 'node:crypto'
import { execFileSync } from 'node:child_process'

export function acceleratedDigArgs(java: string, server: string, env = process.env): string[] {
  if (!/^server-(?:[1-9]|[12][0-9]|3[0-2])$/.test(path.basename(server)) || path.dirname(path.resolve(server)) !== path.resolve(__dirname)) {
    throw new Error('accelerated digging is restricted to farm/server-1..32')
  }
  const source = path.join(__dirname, 'FarmDigClock.java')
  const lockSource = path.join(__dirname, 'FarmLockstep.java')
  const asm = path.resolve(__dirname, '../server-twin/libraries/org/ow2/asm/asm/9.9.1/asm-9.9.1.jar')
  const tree = path.resolve(__dirname, '../server-twin/libraries/org/ow2/asm/asm-tree/9.9.1/asm-tree-9.9.1.jar')
  const native = path.join(server, 'versions/1.21.11/paper-1.21.11.jar')
  const hash = (file: string) => createHash('sha256').update(fs.readFileSync(file)).digest('hex')
  if (hash(native) !== '3a73f0cc4020a5eb45629a67629b14263331c68de45552f8505df8060fa8ed43') {
    throw new Error('FarmDigClock requires the verified Paper 1.21.11 build 132; audit a new jar before accelerating digging')
  }
  const fingerprint = createHash('sha256').update(hash(source)).update(hash(lockSource)).update(hash(asm)).update(hash(tree)).digest('hex')
  const output = path.join(__dirname, '.accelerated-dig', fingerprint)
  const agent = path.join(output, 'farm-dig-clock.jar')
  if (!fs.existsSync(agent)) {
    const classes = path.join(output, 'classes')
    const lockClasses = path.join(output, 'lockstep-classes')
    fs.mkdirSync(classes, { recursive: true })
    fs.mkdirSync(lockClasses, { recursive: true })
    fs.copyFileSync(asm, path.join(output, 'asm.jar'))
    fs.copyFileSync(tree, path.join(output, 'asm-tree.jar'))
    const manifest = path.join(output, 'MANIFEST.MF')
    fs.writeFileSync(manifest, 'Manifest-Version: 1.0\nPremain-Class: FarmDigClock\nMain-Class: FarmDigClock\nClass-Path: asm.jar asm-tree.jar farm-lockstep.jar\n\n')
    const run = (args: string[]) => execFileSync(java, args, { windowsHide: true, timeout: 30_000, stdio: 'pipe' })
    // FarmLockstep is a separate jar: lockstep appends it to the bootstrap search, where ASM-based classes must not go.
    run(['-m', 'jdk.compiler/com.sun.tools.javac.Main', '--release', '21', '-d', lockClasses, lockSource])
    run(['-m', 'jdk.jartool/sun.tools.jar.Main', '--create', '--file', path.join(output, 'farm-lockstep.jar'), '-C', lockClasses, '.'])
    run(['-m', 'jdk.compiler/com.sun.tools.javac.Main', '--release', '21', '-cp', [asm, tree, lockClasses].join(path.delimiter), '-d', classes, source])
    run(['-m', 'jdk.jartool/sun.tools.jar.Main', '--create', '--file', agent, '--manifest', manifest, '-C', classes, '.'])
    try { run(['-jar', agent, native]) }
    catch (error) { fs.unlinkSync(agent); throw error }
  }
  // Farm-only native options: lockstep (ND_LOCKSTEP=1: tick gate + update_time every tick; window and stall valve from
  // ND_LOCKSTEP_WINDOW / ND_LOCKSTEP_STALL_MS), else the update_time cadence PoC. Ordinary startup only patches digging.
  if (env.ND_LOCKSTEP === '1') return [`-javaagent:${agent}=lockstep:${lockstepNumber(env.ND_LOCKSTEP_WINDOW, 2, 1, 20)}:${lockstepNumber(env.ND_LOCKSTEP_STALL_MS, 2000, 50, 60000)}`]
  return [`-javaagent:${agent}${env.ND_FARM_TIME_EVERY_TICK === '1' ? '=time-every-tick' : ''}`]
}

function lockstepNumber(value: string | undefined, fallback: number, min: number, max: number): number {
  const n = value === undefined || value === '' ? fallback : Number(value)
  if (!Number.isSafeInteger(n) || n < min || n > max) throw new Error(`lockstep: нужно целое ${min}..${max}, получено ${value}`)
  return n
}
