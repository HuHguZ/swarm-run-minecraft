import java.lang.reflect.InvocationTargetException;
import java.lang.reflect.Method;
import java.util.IdentityHashMap;
import java.util.Iterator;
import java.util.Map;
import java.util.function.BooleanSupplier;

// Farm-only lockstep (ND_LOCKSTEP=1, FarmDigClock option "lockstep"). A normal (not frozen) server tick runs only when
// every client that reports ServerboundClientTickEnd has finished all but `window` of the server's normal ticks, so a
// bot busy with A*/planning pauses the world instead of losing physics ticks. Loaded by the bootstrap loader (Paperclip
// isolates the server from the agent's class path); called only on the main server thread. Uses only java.* types.
// FarmDigClock (app loader) is another runtime package: it may touch only public members here.
public final class FarmLockstep {
  static int window = 2;
  static long stallNanos = 2_000_000_000L;
  static long normalTicks, waits, waitNanos, valves, reportAt;
  // tick_end listener -> {normal ticks at opt-in, tick_end count since opt-in, wall nanos of the last tick_end}
  static final Map<Object, long[]> peers = new IdentityHashMap<>();
  static Method rateTick, frozen, stepping, normal, block, accepting;

  public static void configure(int ticks, long stallMs) {
    if (ticks < 1 || ticks > 20 || stallMs < 50 || stallMs > 60_000) throw new IllegalArgumentException("lockstep window 1..20, stall 50..60000 ms");
    window = ticks;
    stallNanos = stallMs * 1_000_000L;
  }

  // ServerGamePacketListenerImpl.handleClientTickEnd, after ensureRunningOnSameThread.
  public static void tickEnd(Object listener) {
    long[] peer = peers.computeIfAbsent(listener, key -> new long[]{normalTicks, 0, 0});
    peer[1]++;
    peer[2] = System.nanoTime();
  }

  static boolean ready(long now) {
    for (Iterator<Map.Entry<Object, long[]>> it = peers.entrySet().iterator(); it.hasNext();) {
      Map.Entry<Object, long[]> entry = it.next();
      long[] peer = entry.getValue();
      if (normalTicks - peer[0] < peer[1] + window) continue;
      if (!accepting(entry.getKey())) { it.remove(); valves++; continue; }
      // A live client's wall stall invalidates this farm run; releasing its debt lets mobs kill an unstepped body.
      if (now - peer[2] > stallNanos) throw new IllegalStateException("[farm-lockstep] connected client stalled: normalTicks=" +
        normalTicks + " tickEnds=" + peer[1] + " pending=" + (normalTicks - peer[0] - peer[1]) + " silentMs=" + (now - peer[2]) / 1_000_000);
      return false;
    }
    return true;
  }

  static boolean accepting(Object listener) {
    if (accepting == null) return true;
    try { return (Boolean) accepting.invoke(listener); } catch (ReflectiveOperationException error) { return true; }
  }

  static Object call(Method method, Object target, Object... args) throws Throwable {
    try { return method.invoke(target, args); } catch (InvocationTargetException error) { throw error.getCause(); }
  }

  // Replaces MinecraftServer.tickServer's single ServerTickRateManager.tick(): wait (still running packets and tasks via
  // managedBlock), then the native decision, counting the ticks that run game elements.
  public static void tick(Object rates, Object server) throws Throwable {
    if (rateTick == null) {
      Class<?> type = rates.getClass();
      frozen = type.getMethod("isFrozen");
      stepping = type.getMethod("isSteppingForward");
      normal = type.getMethod("runsNormally");
      block = server.getClass().getMethod("managedBlock", BooleanSupplier.class);
      rateTick = type.getMethod("tick");
    }
    boolean runs = !(Boolean) call(frozen, rates) || (Boolean) call(stepping, rates);
    if (runs && accepting == null && !peers.isEmpty()) accepting = peers.keySet().iterator().next().getClass().getMethod("isAcceptingMessages");
    if (runs && !ready(System.nanoTime())) {
      long start = System.nanoTime();
      waits++;
      call(block, server, (BooleanSupplier) () -> ready(System.nanoTime()));
      waitNanos += System.nanoTime() - start;
    }
    call(rateTick, rates);
    if ((Boolean) call(normal, rates)) normalTicks++;
    long now = System.nanoTime();
    if (now - reportAt > 10_000_000_000L) {
      if (reportAt != 0) System.out.println(report());
      reportAt = now;
    }
  }

  static String report() {
    return "[farm-lockstep] window=" + window + " normalTicks=" + normalTicks + " waits=" + waits +
      " waitMs=" + waitNanos / 1_000_000 + " valves=" + valves + " peers=" + peers.size();
  }

  // Self-check (run by FarmDigClock.main when the agent is built): credit, window and a failed-closed stall.
  public static void check() {
    configure(2, 50);
    Object bot = new Object();
    tickEnd(bot);
    long[] peer = peers.get(bot);
    if (!ready(peer[2])) throw new AssertionError("an opted-in client grants window + its tick_ends");
    normalTicks += 2;
    if (!ready(peer[2])) throw new AssertionError("server may lead by the window");
    normalTicks++;
    if (ready(peer[2])) throw new AssertionError("server must wait one tick past the window");
    tickEnd(bot);
    if (!ready(peer[2])) throw new AssertionError("a tick_end grants the next tick");
    normalTicks++;
    try { ready(peer[2] + stallNanos + 1); throw new AssertionError("a live stalled client must not release the world"); }
    catch (IllegalStateException expected) { }
    if (!peers.containsKey(bot)) throw new AssertionError("a stall must preserve the client's outstanding debt");
    tickEnd(bot);
    if (peers.get(bot) != peer || !ready(System.nanoTime())) throw new AssertionError("a fresh tick_end repays the existing debt");
    peers.clear(); normalTicks = 0; valves = 0;
  }
}
