import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { REPO_ROOT } from '../daemon/src/paths'
import { javaExecutable } from './java'

test('farm lockstep aborts before a connected stall advances the world; disconnect and healthy clients still work', () => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'nd-lockstep-test-'))
  const java = javaExecutable()
  const harness = `
import java.util.function.BooleanSupplier;
public class LockstepStallTest {
  public static class Peer { boolean connected = true; public boolean isAcceptingMessages() { return connected; } }
  public static class Rates {
    int ticks; boolean frozen;
    public boolean isFrozen() { return frozen; }
    public boolean isSteppingForward() { return false; }
    public boolean runsNormally() { return !frozen; }
    public void tick() { ticks++; }
  }
  public static class Server {
    int polls; boolean resume; Peer peer;
    public void managedBlock(BooleanSupplier ready) {
      polls++;
      if (resume) FarmLockstep.tickEnd(peer);
      else FarmLockstep.peers.get(peer)[2] = System.nanoTime() - FarmLockstep.stallNanos - 1;
      if (!ready.getAsBoolean()) throw new AssertionError("test managedBlock did not reach its condition");
    }
  }
  static void reset() {
    FarmLockstep.peers.clear(); FarmLockstep.normalTicks = 0; FarmLockstep.valves = 0;
    FarmLockstep.rateTick = null; FarmLockstep.accepting = null;
    FarmLockstep.configure(2, 8000);
  }
  static Peer waiting() {
    Peer peer = new Peer(); FarmLockstep.tickEnd(peer); FarmLockstep.normalTicks = 3; return peer;
  }
  public static void main(String[] args) throws Throwable {
    reset();
    Peer blocked = waiting(); Rates rates = new Rates(); Server server = new Server(); server.peer = blocked;
    try { FarmLockstep.tick(rates, server); throw new AssertionError("a connected stall released the world"); }
    catch (IllegalStateException expected) {
      if (!expected.getMessage().contains("connected client stalled")) throw expected;
    }
    if (rates.ticks != 0 || FarmLockstep.normalTicks != 3 || !FarmLockstep.peers.containsKey(blocked))
      throw new AssertionError("stall must not advance time or erase the outstanding client debt");
    System.out.println("connected stall: no world tick");

    reset(); Peer gone = waiting(); gone.connected = false;
    FarmLockstep.peers.get(gone)[2] = System.nanoTime() - FarmLockstep.stallNanos - 1;
    rates = new Rates(); server = new Server(); server.peer = gone;
    FarmLockstep.tick(rates, server);
    if (rates.ticks != 1 || server.polls != 0 || !FarmLockstep.peers.isEmpty()) throw new AssertionError("disconnected peer must not gate");
    System.out.println("disconnect: world continues");

    reset(); Peer healthy = waiting(); rates = new Rates(); server = new Server(); server.peer = healthy; server.resume = true;
    FarmLockstep.tick(rates, server);
    if (rates.ticks != 1 || server.polls != 1 || !FarmLockstep.peers.containsKey(healthy))
      throw new AssertionError("managedBlock must process a fresh tick_end and resume normally");
    System.out.println("healthy credit: world continues");

    reset(); Peer paused = waiting(); rates = new Rates(); rates.frozen = true; server = new Server(); server.peer = paused;
    FarmLockstep.peers.get(paused)[2] = System.nanoTime() - FarmLockstep.stallNanos - 1;
    FarmLockstep.tick(rates, server);
    if (server.polls != 0 || FarmLockstep.normalTicks != 3) throw new AssertionError("native freeze must retain its semantics");
    System.out.println("native freeze: no normal tick");
    reset(); FarmLockstep.check(); System.out.println("agent self-check: PASS");
  }
}`
  const run = (args: string[]) => {
    const result = spawnSync(java, args, { cwd: temp, encoding: 'utf8', windowsHide: true, timeout: 30000 })
    assert.ifError(result.error)
    assert.equal(result.status, 0, result.stdout + result.stderr)
    return result.stdout
  }
  try {
    const source = path.join(temp, 'FarmLockstep.java'), fixture = path.join(temp, 'LockstepStallTest.java')
    fs.copyFileSync(path.join(REPO_ROOT, 'farm/FarmLockstep.java'), source)
    fs.writeFileSync(fixture, harness)
    run(['-m', 'jdk.compiler/com.sun.tools.javac.Main', '-proc:none', '-source', '21', '-target', '21',
      '-classpath', temp, '-sourcepath', temp, '-d', temp, source, fixture])
    assert.match(run(['-cp', temp, 'LockstepStallTest']), /agent self-check: PASS/)
  } finally { fs.rmSync(temp, { recursive: true, force: true }) }
})
