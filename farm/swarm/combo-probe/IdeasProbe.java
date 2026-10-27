import com.google.gson.Gson;
import com.google.gson.GsonBuilder;
import com.destroystokyo.paper.event.server.ServerTickEndEvent;
import java.io.BufferedWriter;
import java.io.IOException;
import java.io.UncheckedIOException;
import java.lang.reflect.Field;
import java.lang.reflect.InvocationTargetException;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.StandardOpenOption;
import java.util.LinkedHashMap;
import java.util.Map;
import java.util.Objects;
import java.util.concurrent.Callable;
import org.bukkit.Bukkit;
import org.bukkit.Location;
import org.bukkit.entity.Player;
import org.bukkit.entity.ThrownPotion;
import org.bukkit.event.EventHandler;
import org.bukkit.event.EventPriority;
import org.bukkit.event.Listener;
import org.bukkit.event.entity.EntityDamageByEntityEvent;
import org.bukkit.event.entity.EntityDamageEvent;
import org.bukkit.event.entity.ProjectileLaunchEvent;
import org.bukkit.event.entity.ProjectileHitEvent;
import org.bukkit.event.player.PlayerMoveEvent;
import org.bukkit.plugin.java.JavaPlugin;
import org.bukkit.util.Vector;

/** Passive, slot-28-only event receipts. No commands, packet hooks or entity writes. */
public final class IdeasProbe extends JavaPlugin implements Listener {
    private static final String ACTOR = "NeuroFarm28b0";
    private final Gson json = new GsonBuilder().serializeNulls().create();
    private BufferedWriter output;
    private String lastPending;

    @Override public void onEnable() {
        try {
            Files.createDirectories(getDataFolder().toPath());
            output = Files.newBufferedWriter(getDataFolder().toPath().resolve("events.jsonl"),
                StandardCharsets.UTF_8, StandardOpenOption.CREATE, StandardOpenOption.APPEND);
        } catch (IOException error) { throw new UncheckedIOException(error); }
        Bukkit.getPluginManager().registerEvents(this, this);
        getLogger().info("Passive receipts for " + ACTOR + " -> " + getDataFolder() + "/events.jsonl");
    }

    @Override public void onDisable() {
        if (output == null) return;
        try { output.close(); } catch (IOException error) { getLogger().severe(error.toString()); }
    }

    @EventHandler(priority = EventPriority.MONITOR, ignoreCancelled = false)
    public void onPotion(ProjectileLaunchEvent event) {
        if (!(event.getEntity() instanceof ThrownPotion potion) ||
            !(potion.getShooter() instanceof Player player) || !ACTOR.equals(player.getName())) return;
        Map<String, Object> row = event("potion_launch", player, snapshot(player));
        row.put("entityId", potion.getEntityId());
        row.put("cancelled", event.isCancelled());
        row.put("launchpos", position(potion.getLocation()));
        row.put("velocity", vector(potion.getVelocity()));
        write(row);
    }

    @EventHandler(priority = EventPriority.MONITOR, ignoreCancelled = false)
    public void onWindLaunch(ProjectileLaunchEvent event) {
        if (getServer().getPort() != 25628 || event.getEntity().getType() != org.bukkit.entity.EntityType.WIND_CHARGE ||
            !(event.getEntity().getShooter() instanceof Player player) || !"NeuroFarm28j".equals(player.getName())) return;
        Map<String, Object> row = event("wind_launch", player, snapshot(player));
        row.put("projectileId", event.getEntity().getEntityId()); row.put("cancelled", event.isCancelled());
        row.put("launchpos", position(event.getEntity().getLocation())); row.put("velocity", vector(event.getEntity().getVelocity()));
        write(row);
    }

    @EventHandler(priority = EventPriority.MONITOR)
    public void onWindHit(ProjectileHitEvent event) {
        if (getServer().getPort() != 25628 || event.getEntity().getType() != org.bukkit.entity.EntityType.WIND_CHARGE ||
            !(event.getEntity().getShooter() instanceof Player player) || !"NeuroFarm28j".equals(player.getName())) return;
        Map<String, Object> row = event("wind_hit", player, snapshot(player));
        row.put("cancelled", event.isCancelled());
        row.put("projectileId", event.getEntity().getEntityId()); row.put("hitpos", position(event.getEntity().getLocation()));
        row.put("hitEntityId", event.getHitEntity() == null ? null : event.getHitEntity().getEntityId());
        row.put("hitBlock", event.getHitBlock() == null ? null : position(event.getHitBlock().getLocation()));
        write(row);
    }

    @EventHandler(priority = EventPriority.MONITOR, ignoreCancelled = false)
    public void onMaceDamage(EntityDamageByEntityEvent event) {
        if (getServer().getPort() != 25628 || !(event.getDamager() instanceof Player attacker) ||
            !(ACTOR.equals(attacker.getName()) || "NeuroFarm28j".equals(attacker.getName())) ||
            !(event.getEntity() instanceof Player target) || !target.getName().startsWith("NeuroFarm28")) return;
        Map<String, Object> row = event("mace_damage", attacker, snapshot(attacker));
        row.put("cancelled", event.isCancelled());
        row.put("damageTypeKey", event.getDamageSource().getDamageType().getKey().toString());
        row.put("rawDamage", event.getDamage()); row.put("finalDamage", event.getFinalDamage());
        row.put("attackerId", attacker.getEntityId()); row.put("targetId", target.getEntityId());
        row.put("target", target.getName()); row.put("targetpos", position(target.getLocation()));
        row.put("targetOnGround", target.isOnGround()); row.put("targetHpPre", target.getHealth());
        row.put("targetNoDamageTicks", target.getNoDamageTicks());
        row.put("targetMaximumNoDamageTicks", target.getMaximumNoDamageTicks());
        row.put("targetLastHurt", read(() -> field(target.getClass().getMethod("getHandle").invoke(target), "lastHurt")));
        row.put("targetHurtTime", read(() -> field(target.getClass().getMethod("getHandle").invoke(target), "hurtTime")));
        row.put("targetVelocity", vector(target.getVelocity()));
        row.put("targetKnownMovement", read(() -> {
            Object handle = target.getClass().getMethod("getHandle").invoke(target);
            return nativeVector(handle.getClass().getMethod("getKnownMovement").invoke(handle));
        }));
        row.put("targetKnownSpeed", read(() -> {
            Object handle = target.getClass().getMethod("getHandle").invoke(target);
            return nativeVector(handle.getClass().getMethod("getKnownSpeed").invoke(handle));
        }));
        write(row);
    }

    @EventHandler(priority = EventPriority.MONITOR)
    public void onTickEnd(ServerTickEndEvent event) {
        if (getServer().getPort() != 25628) return;
        for (String name : new String[] { ACTOR, "NeuroFarm28j" }) {
            Player player = Bukkit.getPlayerExact(name);
            if (player == null) continue;
            Map<String, Object> row = event("player_tick_end", player, snapshot(player));
            row.put("isInWater", player.isInWater()); row.put("hp", player.getHealth());
            row.put("velocity", vector(player.getVelocity()));
            row.put("feetBlockData", player.getLocation().getBlock().getBlockData().getAsString());
            row.put("sourceBlockData", player.getWorld().isChunkLoaded(37, 37)
                ? player.getWorld().getBlockAt(600, 151, 597).getBlockData().getAsString() : "unloaded");
            write(row);
        }
    }

    @EventHandler(priority = EventPriority.MONITOR, ignoreCancelled = false)
    public void onFallDamage(EntityDamageEvent event) {
        if (getServer().getPort() != 25628 || event.getCause() != EntityDamageEvent.DamageCause.FALL ||
            !(event.getEntity() instanceof Player player) ||
            !(ACTOR.equals(player.getName()) || "NeuroFarm28j".equals(player.getName()))) return;
        Map<String, Object> row = event("fall_damage", player, snapshot(player));
        row.put("cancelled", event.isCancelled()); row.put("rawDamage", event.getDamage());
        row.put("finalDamage", event.getFinalDamage()); row.put("hpPre", player.getHealth());
        row.put("isInWater", player.isInWater()); row.put("cause", event.getCause().name());
        write(row);
    }

    @EventHandler(priority = EventPriority.MONITOR, ignoreCancelled = false)
    public void onMove(PlayerMoveEvent event) {
        Player player = event.getPlayer();
        if (!ACTOR.equals(player.getName())) return;
        Map<String, Object> state = snapshot(player);
        Object status = state.get("connection");
        if (status instanceof Map<?, ?> fields) {
            Map<String, Object> flags = new LinkedHashMap<>();
            for (String name : new String[] { "awaitingPositionFromClient", "awaitingTeleport", "hasClientLoaded",
                "clientLoadedTimeoutTimer", "waitingForRespawn", "justTeleported", "hasMoved" }) flags.put(name, fields.get(name));
            status = flags;
        }
        String pending = json.toJson(status);
        boolean changed = !Objects.equals(lastPending, pending);
        lastPending = pending;
        Location to = event.getTo();
        if (to != null && Double.compare(event.getFrom().getY(), to.getY()) == 0 && !changed) return;
        Map<String, Object> row = event("player_move", player, state);
        row.put("from", position(event.getFrom()));
        row.put("to", to == null ? null : position(to));
        row.put("cancelled", event.isCancelled());
        row.put("pendingChanged", changed);
        write(row);
    }

    private Map<String, Object> event(String kind, Player player, Map<String, Object> state) {
        Map<String, Object> row = new LinkedHashMap<>();
        row.put("event", kind);
        row.put("tick", Bukkit.getCurrentTick());
        row.put("ms", System.currentTimeMillis());
        row.put("player", player.getName());
        row.put("world", player.getWorld().getName());
        row.putAll(state);
        return row;
    }

    private Map<String, Object> snapshot(Player player) {
        Map<String, Object> state = new LinkedHashMap<>();
        state.put("playerpos", position(player.getLocation()));
        state.put("onGround", player.isOnGround());
        try {
            Object handle = player.getClass().getMethod("getHandle").invoke(player);
            Object connection = field(handle, "connection");
            state.put("fallDistance", read(() -> field(handle, "fallDistance")));
            state.put("knownMovement", read(() -> nativeVector(handle.getClass().getMethod("getKnownMovement").invoke(handle))));
            state.put("knownSpeed", read(() -> nativeVector(handle.getClass().getMethod("getKnownSpeed").invoke(handle))));
            state.put("isUsingItem", read(() -> handle.getClass().getMethod("isUsingItem").invoke(handle)));
            state.put("ticksUsingItem", read(() -> handle.getClass().getMethod("getTicksUsingItem").invoke(handle)));
            state.put("useItemRemainingTicks", read(() -> handle.getClass().getMethod("getUseItemRemainingTicks").invoke(handle)));
            state.put("held", player.getInventory().getItemInMainHand().getType().toString());
            state.put("impulseImpactPos", read(() -> nativeVector(field(handle, "currentImpulseImpactPos"))));
            state.put("ignoreFallDamageFromCurrentImpulse", read(() -> handle.getClass().getMethod("isIgnoringFallDamageFromCurrentImpulse").invoke(handle)));
            state.put("impulseGraceTicks", read(() -> field(handle, "currentImpulseContextResetGraceTime")));
            state.put("explosionCause", read(() -> {
                Object cause = field(handle, "currentExplosionCause");
                if (cause == null) return null;
                org.bukkit.entity.Entity entity = (org.bukkit.entity.Entity) cause.getClass().getMethod("getBukkitEntity").invoke(cause);
                return Map.of("id", entity.getEntityId(), "type", entity.getType().toString());
            }));
            Map<String, Object> pending = new LinkedHashMap<>();
            pending.put("awaitingPositionFromClient", read(() -> nativeVector(field(connection, "awaitingPositionFromClient"))));
            pending.put("awaitingTeleport", read(() -> field(connection, "awaitingTeleport")));
            pending.put("hasClientLoaded", read(() -> connection.getClass().getMethod("hasClientLoaded").invoke(connection)));
            pending.put("clientLoadedTimeoutTimer", read(() -> field(connection, "clientLoadedTimeoutTimer")));
            pending.put("waitingForRespawn", read(() -> field(connection, "waitingForRespawn")));
            pending.put("justTeleported", read(() -> field(connection, "justTeleported")));
            pending.put("hasMoved", read(() -> field(connection, "hasMoved")));
            pending.put("lastPosX", read(() -> field(connection, "lastPosX")));
            pending.put("lastPosY", read(() -> field(connection, "lastPosY")));
            pending.put("lastPosZ", read(() -> field(connection, "lastPosZ")));
            state.put("connection", pending);
        } catch (ReflectiveOperationException | RuntimeException error) {
            state.put("knownMovement", unknown(error));
            state.put("connection", unknown(error));
        }
        return state;
    }

    private static Object field(Object target, String name) throws ReflectiveOperationException {
        for (Class<?> type = target.getClass(); type != null; type = type.getSuperclass()) {
            try {
                Field field = type.getDeclaredField(name);
                field.setAccessible(true);
                return field.get(target);
            } catch (NoSuchFieldException absent) { /* Search inherited NMS fields. */ }
        }
        throw new NoSuchFieldException(target.getClass().getName() + "." + name);
    }

    private static Object nativeVector(Object value) throws ReflectiveOperationException {
        if (value == null) return null;
        return xyz(((Number) field(value, "x")).doubleValue(),
            ((Number) field(value, "y")).doubleValue(), ((Number) field(value, "z")).doubleValue());
    }

    private static Map<String, Object> position(Location value) {
        Map<String, Object> point = xyz(value.getX(), value.getY(), value.getZ());
        point.put("yaw", value.getYaw());
        point.put("pitch", value.getPitch());
        return point;
    }

    private static Map<String, Object> vector(Vector value) { return xyz(value.getX(), value.getY(), value.getZ()); }

    private static Map<String, Object> xyz(double x, double y, double z) {
        Map<String, Object> point = new LinkedHashMap<>();
        point.put("x", x); point.put("y", y); point.put("z", z);
        return point;
    }

    private static Object read(Callable<Object> operation) {
        try { return operation.call(); } catch (Exception error) { return unknown(error); }
    }

    private static Map<String, String> unknown(Throwable error) {
        Throwable cause = error instanceof InvocationTargetException ? error.getCause() : error;
        return Map.of("unknown", cause.getClass().getSimpleName() + ": " + cause.getMessage());
    }

    private void write(Map<String, Object> row) {
        try { output.write(json.toJson(row)); output.newLine(); output.flush(); }
        catch (IOException error) { getLogger().severe(error.toString()); }
    }
}
