import java.lang.instrument.ClassFileTransformer;
import java.lang.instrument.Instrumentation;
import java.nio.file.Files;
import java.nio.file.Path;
import java.security.ProtectionDomain;
import java.util.Arrays;
import java.util.jar.JarFile;
import org.objectweb.asm.*;
import org.objectweb.asm.tree.*;

public final class FarmDigClock {
  private static final String GAME_MODE = "net/minecraft/server/level/ServerPlayerGameMode";
  private static final String LEVEL = "net/minecraft/server/level/ServerLevel";
  private static final String SERVER = "net/minecraft/server/MinecraftServer";
  private static final String PLAYER = "net/minecraft/world/entity/player/Player";
  private static final String TICK_CHILDREN = "(Ljava/util/function/BooleanSupplier;)V";
  private static final String RATES = "net/minecraft/server/ServerTickRateManager";
  private static final String LISTENER = "net/minecraft/server/network/ServerGamePacketListenerImpl";
  private static final String LOCKSTEP = "FarmLockstep";

  static byte[] transform(byte[] bytes) {
    ClassReader reader = new ClassReader(bytes);
    if (!GAME_MODE.equals(reader.getClassName())) throw new IllegalArgumentException("Unexpected native class");
    ClassWriter writer = new ClassWriter(reader, 0);
    int[] replacements = {0};
    reader.accept(new ClassVisitor(Opcodes.ASM9, writer) {
      public MethodVisitor visitMethod(int access, String name, String desc, String signature, String[] exceptions) {
        MethodVisitor next = super.visitMethod(access, name, desc, signature, exceptions);
        if (!name.equals("tick") || !desc.equals("()V")) return next;
        return new MethodVisitor(Opcodes.ASM9, next) {
          public void visitMethodInsn(int opcode, String owner, String method, String descriptor, boolean itf) {
            if (opcode == Opcodes.INVOKEVIRTUAL && owner.equals(LEVEL) && method.equals("getLagCompensationTick") && descriptor.equals("()J")) {
              method = "getGameTime";
              replacements[0]++;
            }
            super.visitMethodInsn(opcode, owner, method, descriptor, itf);
          }
        };
      }
    }, 0);
    if (replacements[0] != 1) throw new IllegalArgumentException("Expected one Paper digging clock call; found " + replacements[0]);
    return writer.toByteArray();
  }

  // Match the whole native (tickCount + player.id) % 20 == 0 gate. Other
  // constants of 20, including other server scheduling, remain untouched.
  static IntInsnNode timeGate(ClassNode node, int cadence) {
    if (!SERVER.equals(node.name)) throw new IllegalArgumentException("Unexpected time packet class");
    IntInsnNode found = null;
    int methods = 0;
    for (MethodNode method : node.methods) {
      if (!method.name.equals("tickChildren") || !method.desc.equals(TICK_CHILDREN)) continue;
      methods++;
      AbstractInsnNode[] code = Arrays.stream(method.instructions.toArray()).filter(i -> i.getOpcode() >= 0).toArray(AbstractInsnNode[]::new);
      for (int i = 0; i + 7 < code.length; i++) {
        if (!(code[i] instanceof VarInsnNode self) || self.getOpcode() != Opcodes.ALOAD || self.var != 0 ||
            !(code[i + 1] instanceof FieldInsnNode tick) || tick.getOpcode() != Opcodes.GETFIELD || !tick.owner.equals(SERVER) || !tick.name.equals("tickCount") || !tick.desc.equals("I") ||
            !(code[i + 2] instanceof VarInsnNode player) || player.getOpcode() != Opcodes.ALOAD || player.var <= 0 ||
            !(code[i + 3] instanceof MethodInsnNode id) || id.getOpcode() != Opcodes.INVOKEVIRTUAL || !id.owner.equals(PLAYER) || !id.name.equals("getId") || !id.desc.equals("()I") ||
            code[i + 4].getOpcode() != Opcodes.IADD ||
            !(code[i + 5] instanceof IntInsnNode every) || every.getOpcode() != Opcodes.BIPUSH || every.operand != cadence ||
            code[i + 6].getOpcode() != Opcodes.IREM || code[i + 7].getOpcode() != Opcodes.IFEQ) continue;
        if (found != null) throw new IllegalArgumentException("Duplicate native time packet cadence gate");
        found = every;
      }
    }
    if (methods != 1 || found == null) throw new IllegalArgumentException("Expected one native time packet cadence gate");
    return found;
  }

  static byte[] transformTime(byte[] bytes) { return transformServer(bytes, false); }

  // Lockstep needs update_time every tick (the client's per-tick grant) plus the tick gate.
  static byte[] transformServer(byte[] bytes, boolean lockstep) {
    ClassNode node = new ClassNode();
    new ClassReader(bytes).accept(node, 0);
    timeGate(node, 20).operand = 1;
    if (lockstep) {
      MethodInsnNode rates = only(node, "tickServer", TICK_CHILDREN, Opcodes.INVOKEVIRTUAL, RATES, "tick", "()V");
      MethodNode method = methodOf(node, rates);
      method.instructions.insertBefore(rates, new VarInsnNode(Opcodes.ALOAD, 0));
      method.instructions.set(rates, new MethodInsnNode(Opcodes.INVOKESTATIC, LOCKSTEP, "tick", "(Ljava/lang/Object;Ljava/lang/Object;)V", false));
      method.maxStack++;
    }
    ClassWriter writer = new ClassWriter(0);
    node.accept(writer);
    return writer.toByteArray();
  }

  static byte[] transformTickEnd(byte[] bytes) {
    ClassNode node = new ClassNode();
    new ClassReader(bytes).accept(node, 0);
    if (!LISTENER.equals(node.name)) throw new IllegalArgumentException("Unexpected tick end class");
    MethodInsnNode thread = only(node, "handleClientTickEnd", "(Lnet/minecraft/network/protocol/game/ServerboundClientTickEndPacket;)V",
      Opcodes.INVOKESTATIC, "net/minecraft/network/protocol/PacketUtils", "ensureRunningOnSameThread", null);
    MethodNode method = methodOf(node, thread);
    for (AbstractInsnNode i : method.instructions.toArray()) {
      if (i instanceof MethodInsnNode call && call.owner.equals(LOCKSTEP)) throw new IllegalArgumentException("Repeated tick end patch");
    }
    InsnList hook = new InsnList();
    hook.add(new VarInsnNode(Opcodes.ALOAD, 0));
    hook.add(new MethodInsnNode(Opcodes.INVOKESTATIC, LOCKSTEP, "tickEnd", "(Ljava/lang/Object;)V", false));
    method.instructions.insert(thread, hook);
    method.maxStack++;
    ClassWriter writer = new ClassWriter(0);
    node.accept(writer);
    return writer.toByteArray();
  }

  // Exactly one matching call in exactly one method, or the jar is not the reviewed Paper build.
  static MethodInsnNode only(ClassNode node, String name, String desc, int opcode, String owner, String method, String methodDesc) {
    MethodInsnNode found = null;
    for (MethodNode m : node.methods) {
      if (!m.name.equals(name) || !m.desc.equals(desc)) continue;
      for (AbstractInsnNode i : m.instructions.toArray()) {
        if (!(i instanceof MethodInsnNode call) || call.getOpcode() != opcode || !call.owner.equals(owner) || !call.name.equals(method) ||
            (methodDesc != null && !call.desc.equals(methodDesc))) continue;
        if (found != null) throw new IllegalArgumentException("Duplicate " + owner + "." + method + " in " + name);
        found = call;
      }
    }
    if (found == null) throw new IllegalArgumentException("Expected one " + owner + "." + method + " in " + name);
    return found;
  }
  static MethodNode methodOf(ClassNode node, AbstractInsnNode insn) {
    for (MethodNode m : node.methods) if (m.instructions.contains(insn)) return m;
    throw new IllegalStateException("instruction outside methods");
  }

  public static void premain(String option, Instrumentation instrumentation) throws Exception {
    boolean everyTick = "time-every-tick".equals(option);
    // lockstep[:window:stallMs] — FarmLockstep must be visible to Paperclip's isolated loader: bootstrap search.
    java.util.regex.Matcher lock = java.util.regex.Pattern.compile("lockstep(?::(\\d+):(\\d+))?").matcher(option == null ? "" : option);
    boolean lockstep = lock.matches();
    if (option != null && !option.isEmpty() && !everyTick && !lockstep) throw new IllegalArgumentException("Unknown farm clock option");
    String properties = Files.readString(Path.of("server.properties"));
    if (!java.util.regex.Pattern.compile("(?m)^server-port=256(?:0[1-9]|[12][0-9]|3[0-2])\\r?$").matcher(properties).find()) {
      throw new IllegalStateException("FarmDigClock requires a farm server port 25601..25632");
    }
    if (lockstep) {
      Path agent = Path.of(FarmDigClock.class.getProtectionDomain().getCodeSource().getLocation().toURI());
      instrumentation.appendToBootstrapClassLoaderSearch(new JarFile(agent.resolveSibling("farm-lockstep.jar").toFile()));
      if (lock.group(1) != null) FarmLockstep.configure(Integer.parseInt(lock.group(1)), Long.parseLong(lock.group(2)));
    }
    instrumentation.addTransformer(new ClassFileTransformer() {
      public byte[] transform(ClassLoader loader, String name, Class<?> existing, ProtectionDomain domain, byte[] bytes) {
        boolean server = (everyTick || lockstep) && SERVER.equals(name);
        if (!GAME_MODE.equals(name) && !server && !(lockstep && LISTENER.equals(name))) return null;
        try {
          byte[] changed = GAME_MODE.equals(name) ? FarmDigClock.transform(bytes) : server ? transformServer(bytes, lockstep) : transformTickEnd(bytes);
          System.out.println(GAME_MODE.equals(name)
            ? "[farm-dig-clock] native game ticks; exactly one Paper clock call replaced"
            : server && lockstep ? "[farm-lockstep] update_time every tick; tick gate before the one ServerTickRateManager.tick, option " + option
            : server ? "[farm-time-clock] PoC native update_time every tick; exactly one 20-tick cadence gate replaced"
            : "[farm-lockstep] tick_end counted after the one ensureRunningOnSameThread");
          return changed;
        } catch (Throwable error) {
          error.printStackTrace();
          Runtime.getRuntime().halt(2);
          return null;
        }
      }
    });
  }

  public static void main(String[] args) throws Exception {
    try (JarFile jar = new JarFile(args[0])) {
      byte[] source = jar.getInputStream(jar.getJarEntry(GAME_MODE + ".class")).readAllBytes();
      byte[] changed = transform(source);
      try { transform(changed); throw new AssertionError("Repeated patch must be rejected"); }
      catch (IllegalArgumentException expected) { }
      byte[] server = jar.getInputStream(jar.getJarEntry(SERVER + ".class")).readAllBytes();
      checkTime(server);
      byte[] gated = transformServer(server, true);
      only(readTime(gated), "tickServer", TICK_CHILDREN, Opcodes.INVOKESTATIC, LOCKSTEP, "tick", null);
      try { transformServer(gated, true); throw new AssertionError("Repeated lockstep server patch must be rejected"); }
      catch (IllegalArgumentException expected) { }
      byte[] listener = transformTickEnd(jar.getInputStream(jar.getJarEntry(LISTENER + ".class")).readAllBytes());
      ClassNode counted = new ClassNode(); new ClassReader(listener).accept(counted, 0);
      only(counted, "handleClientTickEnd", "(Lnet/minecraft/network/protocol/game/ServerboundClientTickEndPacket;)V", Opcodes.INVOKESTATIC, LOCKSTEP, "tickEnd", null);
      try { transformTickEnd(listener); throw new AssertionError("Repeated tick end patch must be rejected"); }
      catch (IllegalArgumentException expected) { }
    }
    FarmLockstep.check();
    for (int count : new int[]{0, 2}) {
      ClassWriter fixture = new ClassWriter(0);
      fixture.visit(Opcodes.V21, Opcodes.ACC_PUBLIC, GAME_MODE, null, "java/lang/Object", null);
      MethodVisitor tick = fixture.visitMethod(Opcodes.ACC_PUBLIC, "tick", "()V", null, null);
      tick.visitCode();
      for (int i = 0; i < count; i++) {
        tick.visitInsn(Opcodes.ACONST_NULL);
        tick.visitMethodInsn(Opcodes.INVOKEVIRTUAL, LEVEL, "getLagCompensationTick", "()J", false);
        tick.visitInsn(Opcodes.POP2);
      }
      tick.visitInsn(Opcodes.RETURN); tick.visitMaxs(2, 1); tick.visitEnd(); fixture.visitEnd();
      try { transform(fixture.toByteArray()); throw new AssertionError("Unexpected clock count must be rejected"); }
      catch (IllegalArgumentException expected) { }
    }
    for (int count : new int[]{0, 2}) {
      try { transformTime(timeFixture(count)); throw new AssertionError("Missing/duplicate time gate must be rejected"); }
      catch (IllegalArgumentException expected) { }
    }
    checkTime(timeFixture(1));
    System.out.println("FarmDigClock: native Paper clocks, lockstep gate, repeated/missing/duplicate/unrelated-20 guards PASS");
  }

  static ClassNode readTime(byte[] bytes) {
    ClassNode node = new ClassNode(); new ClassReader(bytes).accept(node, 0); return node;
  }
  static long constants20(ClassNode node) {
    return node.methods.stream().flatMap(m -> Arrays.stream(m.instructions.toArray()))
      .filter(i -> i instanceof IntInsnNode n && n.getOpcode() == Opcodes.BIPUSH && n.operand == 20).count();
  }
  static void checkTime(byte[] source) {
    ClassNode original = readTime(source);
    timeGate(original, 20);
    try { timeGate(original, 1); throw new AssertionError("Original native cadence must fail every-tick check"); }
    catch (IllegalArgumentException expected) { }
    byte[] changed = transformTime(source);
    ClassNode patched = readTime(changed);
    timeGate(patched, 1);
    if (constants20(original) - constants20(patched) != 1) throw new AssertionError("Only the selected cadence constant may change");
    try { transformTime(changed); throw new AssertionError("Repeated time patch must be rejected"); }
    catch (IllegalArgumentException expected) { }
  }
  static byte[] timeFixture(int gates) {
    ClassWriter writer = new ClassWriter(0);
    writer.visit(Opcodes.V21, Opcodes.ACC_PUBLIC, SERVER, null, "java/lang/Object", null);
    MethodVisitor tick = writer.visitMethod(Opcodes.ACC_PROTECTED, "tickChildren", TICK_CHILDREN, null, null);
    tick.visitCode(); tick.visitIntInsn(Opcodes.BIPUSH, 20); tick.visitInsn(Opcodes.POP);
    for (int i = 0; i < gates; i++) {
      tick.visitVarInsn(Opcodes.ALOAD, 0); tick.visitFieldInsn(Opcodes.GETFIELD, SERVER, "tickCount", "I");
      tick.visitVarInsn(Opcodes.ALOAD, 2); tick.visitMethodInsn(Opcodes.INVOKEVIRTUAL, PLAYER, "getId", "()I", false);
      tick.visitInsn(Opcodes.IADD); tick.visitIntInsn(Opcodes.BIPUSH, 20); tick.visitInsn(Opcodes.IREM);
      Label next = new Label(); tick.visitJumpInsn(Opcodes.IFEQ, next); tick.visitLabel(next);
    }
    tick.visitInsn(Opcodes.RETURN); tick.visitMaxs(2, 3); tick.visitEnd(); writer.visitEnd();
    return writer.toByteArray();
  }
}
