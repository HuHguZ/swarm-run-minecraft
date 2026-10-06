package nd.lab;

// Лаборатория взрыва кровати (01.10.2026, агент дракона): только запись, мир не меняет.
// plugins/DragonLab/events.jsonl, строка на событие:
//   bx    — взрыв блока (кровать): центр, тип, дракон в этот момент
//   dd    — урон дракону: причина, урон, хп до, фаза, части (низ-центр), видимость seen
//           (ServerExplosion.getSeenPercent по коробке дракона — та, что берёт урон взрыва)
//   hp    — хп дракона в начале следующего тика (точная потеря за взрыв)
//   pd    — урон игроку: причина, тип урона, кто бил, хп до
//   ph    — смена фазы дракона
//   pose  — голова/тело дракона каждый тик в LANDING (и APPROACH ближе 40 от центра)
//   death — смерть игрока
//   pl/phit/ptp/pgone — жемчуг (s5 06.10): бросок (место, скорость, взгляд игрока), попадание (место, блок/сущность),
//           перенос игрока (откуда/куда), исчезновение без попадания
import org.bukkit.Bukkit;
import org.bukkit.Location;
import org.bukkit.World;
import org.bukkit.entity.ComplexEntityPart;
import org.bukkit.entity.EnderDragon;
import org.bukkit.entity.Entity;
import org.bukkit.entity.Player;
import org.bukkit.event.EventHandler;
import org.bukkit.event.EventPriority;
import org.bukkit.event.Listener;
import org.bukkit.event.block.BlockExplodeEvent;
import org.bukkit.event.entity.EnderDragonChangePhaseEvent;
import org.bukkit.event.entity.EntityDamageByEntityEvent;
import org.bukkit.event.entity.EntityDamageEvent;
import org.bukkit.event.entity.PlayerDeathEvent;
import org.bukkit.event.entity.ProjectileHitEvent;
import org.bukkit.event.entity.ProjectileLaunchEvent;
import org.bukkit.event.player.PlayerTeleportEvent;
import org.bukkit.entity.EnderPearl;
import org.bukkit.plugin.java.JavaPlugin;

import java.io.BufferedWriter;
import java.io.File;
import java.io.FileOutputStream;
import java.io.IOException;
import java.io.OutputStreamWriter;
import java.io.Writer;
import java.lang.reflect.Constructor;
import java.lang.reflect.Method;
import java.nio.charset.StandardCharsets;
import java.util.Locale;

public final class DragonLab extends JavaPlugin implements Listener {
    private Writer out;
    private Method seenM;
    private Constructor<?> vecC;
    private int hpTick = -1;

    @Override
    public void onEnable() {
        getDataFolder().mkdirs();
        try {
            out = new BufferedWriter(new OutputStreamWriter(new FileOutputStream(new File(getDataFolder(), "events.jsonl"), true), StandardCharsets.UTF_8));
        } catch (IOException e) {
            throw new RuntimeException(e);
        }
        try {
            Class<?> vec = Class.forName("net.minecraft.world.phys.Vec3");
            Class<?> ent = Class.forName("net.minecraft.world.entity.Entity");
            vecC = vec.getConstructor(double.class, double.class, double.class);
            seenM = Class.forName("net.minecraft.world.level.ServerExplosion").getMethod("getSeenPercent", vec, ent);
        } catch (Throwable t) {
            getLogger().warning("seen недоступен: " + t);
        }
        getServer().getPluginManager().registerEvents(this, this);
        Bukkit.getScheduler().runTaskTimer(this, this::pose, 1L, 1L);
        w("{\"t\":\"start\",\"tick\":" + Bukkit.getCurrentTick() + "}");
    }

    @Override
    public void onDisable() {
        try { if (out != null) out.close(); } catch (IOException ignored) { }
    }

    private void w(String s) {
        try { out.write(s); out.write('\n'); out.flush(); } catch (IOException ignored) { }
    }

    private static String f(double v) { return String.format(Locale.ROOT, "%.3f", v); }
    private static String loc(Location l) { return l == null ? "null" : "[" + f(l.getX()) + "," + f(l.getY()) + "," + f(l.getZ()) + "]"; }
    private static String q(String s) { return s == null ? "null" : "\"" + s.replace("\\", "\\\\").replace("\"", "\\\"") + "\""; }
    private long gt(World wd) { return wd == null ? -1 : wd.getGameTime(); }

    private Float seen(Location c, Entity e) {
        if (seenM == null || c == null) return null;
        try {
            Object h = e.getClass().getMethod("getHandle").invoke(e);
            Object v = vecC.newInstance(c.getX(), c.getY(), c.getZ());
            return (Float) seenM.invoke(null, v, h);
        } catch (Throwable t) {
            return null;
        }
    }

    private String dragonState(EnderDragon d, Location c) {
        StringBuilder b = new StringBuilder();
        Location p = d.getLocation();
        b.append("\"ph\":").append(q(d.getPhase().name()));
        b.append(",\"hp\":").append(f(d.getHealth()));
        b.append(",\"body\":[").append(f(p.getX())).append(',').append(f(p.getY())).append(',').append(f(p.getZ())).append(',').append(f(p.getYaw())).append(']');
        b.append(",\"vel\":[").append(f(d.getVelocity().getX())).append(',').append(f(d.getVelocity().getY())).append(',').append(f(d.getVelocity().getZ())).append(']');
        b.append(",\"parts\":[");
        boolean first = true;
        for (ComplexEntityPart part : d.getParts()) {
            if (!first) b.append(',');
            first = false;
            b.append(loc(part.getLocation()));
        }
        b.append(']');
        if (c != null) {
            Float s = seen(c, d);
            b.append(",\"seen\":").append(s == null ? "null" : f(s));
        }
        return b.toString();
    }

    // Кто закрывает коробку дракона от центра взрыва: та же сетка точек, что ServerExplosion.getSeenPercent
    // (шаг 1/(2·размер+1), сдвиг по x/z), луч от точки к центру (COLLIDER, без жидкостей); первый задетый блок — в счёт.
    private String occluders(Location c, EnderDragon d) {
        org.bukkit.util.BoundingBox bb = d.getBoundingBox();
        World wd = c.getWorld();
        double d0 = 1.0 / ((bb.getMaxX() - bb.getMinX()) * 2.0 + 1.0);
        double d1 = 1.0 / ((bb.getMaxY() - bb.getMinY()) * 2.0 + 1.0);
        double d2 = 1.0 / ((bb.getMaxZ() - bb.getMinZ()) * 2.0 + 1.0);
        double d3 = (1.0 - Math.floor(1.0 / d0) * d0) / 2.0;
        double d4 = (1.0 - Math.floor(1.0 / d2) * d2) / 2.0;
        java.util.HashMap<String, Integer> hits = new java.util.HashMap<>();
        int all = 0, blocked = 0, inside = 0;
        for (double a = 0; a <= 1; a += d0) for (double e = 0; e <= 1; e += d1) for (double g = 0; g <= 1; g += d2) {
            double x = bb.getMinX() + a * (bb.getMaxX() - bb.getMinX()) + d3;
            double y = bb.getMinY() + e * (bb.getMaxY() - bb.getMinY());
            double z = bb.getMinZ() + g * (bb.getMaxZ() - bb.getMinZ()) + d4;
            all++;
            org.bukkit.util.Vector dir = new org.bukkit.util.Vector(c.getX() - x, c.getY() - y, c.getZ() - z);
            double len = dir.length();
            if (len < 1e-6) continue;
            org.bukkit.util.RayTraceResult r = wd.rayTraceBlocks(new Location(wd, x, y, z), dir.multiply(1.0 / len), len, org.bukkit.FluidCollisionMode.NEVER, true);
            if (r == null || r.getHitBlock() == null) continue;
            blocked++;
            org.bukkit.block.Block hb = r.getHitBlock();
            if (hb.getX() == (int) Math.floor(x) && hb.getY() == (int) Math.floor(y) && hb.getZ() == (int) Math.floor(z)) inside++;
            String k = hb.getX() + "," + hb.getY() + "," + hb.getZ() + "," + hb.getType().name().toLowerCase(Locale.ROOT);
            hits.merge(k, 1, Integer::sum);
        }
        StringBuilder b = new StringBuilder();
        b.append("\"occ\":{\"rays\":").append(all).append(",\"blocked\":").append(blocked).append(",\"inside\":").append(inside).append(",\"top\":[");
        java.util.List<java.util.Map.Entry<String, Integer>> es = new java.util.ArrayList<>(hits.entrySet());
        es.sort((p, q) -> q.getValue() - p.getValue());
        for (int i = 0; i < Math.min(10, es.size()); i++) {
            if (i > 0) b.append(',');
            b.append("[\"").append(es.get(i).getKey()).append("\",").append(es.get(i).getValue()).append(']');
        }
        b.append("],\"bb\":[").append(f(bb.getMinX())).append(',').append(f(bb.getMinY())).append(',').append(f(bb.getMinZ())).append(',').append(f(bb.getMaxX())).append(',').append(f(bb.getMaxY())).append(',').append(f(bb.getMaxZ())).append("]}");
        return b.toString();
    }

    private static EnderDragon dragonIn(World wd) {
        if (wd == null) return null;
        for (EnderDragon d : wd.getEntitiesByClass(EnderDragon.class)) return d;
        return null;
    }

    private void pose() {
        for (World wd : Bukkit.getWorlds()) {
            if (wd.getEnvironment() != World.Environment.THE_END) continue;
            EnderDragon d = dragonIn(wd);
            if (d == null) continue;
            EnderDragon.Phase ph = d.getPhase();
            Location p = d.getLocation();
            boolean near = Math.hypot(p.getX(), p.getZ()) < 40;
            if (ph == EnderDragon.Phase.LAND_ON_PORTAL || ph == EnderDragon.Phase.LEAVE_PORTAL || (near && (ph == EnderDragon.Phase.FLY_TO_PORTAL || ph == EnderDragon.Phase.HOVER))) {
                ComplexEntityPart head = d.getParts().iterator().next();
                w("{\"t\":\"pose\",\"tick\":" + Bukkit.getCurrentTick() + ",\"ms\":" + System.currentTimeMillis() + ",\"gt\":" + gt(wd) + ",\"ph\":" + q(ph.name()) + ",\"head\":" + loc(head.getLocation())
                    + ",\"body\":[" + f(p.getX()) + "," + f(p.getY()) + "," + f(p.getZ()) + "," + f(p.getYaw()) + "],\"hp\":" + f(d.getHealth()) + "}");
            }
        }
    }

    @EventHandler(priority = EventPriority.MONITOR, ignoreCancelled = true)
    public void onExplode(BlockExplodeEvent e) {
        Location c = e.getBlock().getLocation().add(0.5, 0.5, 0.5);
        String type = e.getExplodedBlockState() == null ? null : e.getExplodedBlockState().getType().name();
        EnderDragon d = dragonIn(c.getWorld());
        w("{\"t\":\"bx\",\"tick\":" + Bukkit.getCurrentTick() + ",\"ms\":" + System.currentTimeMillis() + ",\"gt\":" + gt(c.getWorld()) + ",\"c\":" + loc(c) + ",\"type\":" + q(type)
            + ",\"blocks\":" + e.blockList().size() + (d != null ? "," + dragonState(d, c) : "") + "}");
    }

    @EventHandler(priority = EventPriority.MONITOR, ignoreCancelled = true)
    public void onDamage(EntityDamageEvent e) {
        Entity en = e.getEntity();
        String dt = null;
        Location src = null;
        try {
            dt = e.getDamageSource().getDamageType().getKey().getKey();
            src = e.getDamageSource().getSourceLocation();
        } catch (Throwable ignored) { }
        String by = null;
        if (e instanceof EntityDamageByEntityEvent ee && ee.getDamager() != null) by = ee.getDamager().getType().name();
        if (en instanceof EnderDragon d) {
            w("{\"t\":\"dd\",\"tick\":" + Bukkit.getCurrentTick() + ",\"ms\":" + System.currentTimeMillis() + ",\"gt\":" + gt(d.getWorld()) + ",\"cause\":" + q(e.getCause().name()) + ",\"type\":" + q(dt)
                + ",\"by\":" + q(by) + ",\"dmg\":" + f(e.getDamage()) + ",\"fin\":" + f(e.getFinalDamage()) + ",\"src\":" + loc(src) + "," + dragonState(d, src) + "}");
            final int tk = Bukkit.getCurrentTick();
            if (hpTick != tk) {
                hpTick = tk;
                if (src != null) { try { Location sc = src.clone(); sc.setWorld(d.getWorld()); w("{\"t\":\"occ\",\"tick\":" + tk + "," + occluders(sc, d) + "}"); } catch (Throwable t) { w("{\"t\":\"occErr\",\"tick\":" + tk + ",\"err\":" + q(String.valueOf(t)) + "}"); } }
                Bukkit.getScheduler().runTask(this, () -> w("{\"t\":\"hp\",\"tick\":" + Bukkit.getCurrentTick() + ",\"of\":" + tk + ",\"hp\":" + f(d.getHealth()) + ",\"ph\":" + q(d.getPhase().name()) + "}"));
            }
        } else if (en instanceof ComplexEntityPart part) {
            w("{\"t\":\"part\",\"tick\":" + Bukkit.getCurrentTick() + ",\"cause\":" + q(e.getCause().name()) + ",\"dmg\":" + f(e.getDamage()) + ",\"at\":" + loc(part.getLocation()) + "}");
        } else if (en instanceof Player pl) {
            w("{\"t\":\"pd\",\"tick\":" + Bukkit.getCurrentTick() + ",\"gt\":" + gt(pl.getWorld()) + ",\"name\":" + q(pl.getName()) + ",\"cause\":" + q(e.getCause().name()) + ",\"type\":" + q(dt)
                + ",\"by\":" + q(by) + ",\"dmg\":" + f(e.getDamage()) + ",\"fin\":" + f(e.getFinalDamage()) + ",\"hp\":" + f(pl.getHealth()) + ",\"at\":" + loc(pl.getLocation()) + ",\"src\":" + loc(src) + "}");
        }
    }

    @EventHandler(priority = EventPriority.MONITOR)
    public void onPhase(EnderDragonChangePhaseEvent e) {
        EnderDragon d = e.getEntity();
        w("{\"t\":\"ph\",\"tick\":" + Bukkit.getCurrentTick() + ",\"gt\":" + gt(d.getWorld()) + ",\"from\":" + q(e.getCurrentPhase() == null ? null : e.getCurrentPhase().name()) + ",\"to\":" + q(e.getNewPhase().name())
            + ",\"cancelled\":" + e.isCancelled() + ",\"body\":" + loc(d.getLocation()) + "}");
    }

    @EventHandler(priority = EventPriority.MONITOR)
    @SuppressWarnings("deprecation")
    public void onDeath(PlayerDeathEvent e) {
        w("{\"t\":\"death\",\"tick\":" + Bukkit.getCurrentTick() + ",\"name\":" + q(e.getEntity().getName()) + ",\"msg\":" + q(e.getDeathMessage()) + ",\"at\":" + loc(e.getEntity().getLocation()) + "}");
    }

    private static String v(org.bukkit.util.Vector x) { return x == null ? "null" : "[" + f(x.getX()) + "," + f(x.getY()) + "," + f(x.getZ()) + "]"; }

    @EventHandler(priority = EventPriority.MONITOR)
    public void onLaunch(ProjectileLaunchEvent e) {
        if (!(e.getEntity() instanceof EnderPearl pe)) return;
        Location sl = pe.getShooter() instanceof Player pl ? pl.getLocation() : null;
        w("{\"t\":\"pl\",\"tick\":" + Bukkit.getCurrentTick() + ",\"ms\":" + System.currentTimeMillis() + ",\"id\":" + pe.getEntityId() + ",\"at\":" + loc(pe.getLocation()) + ",\"vel\":" + v(pe.getVelocity())
            + ",\"cancelled\":" + e.isCancelled() + ",\"player\":" + loc(sl) + ",\"yaw\":" + (sl == null ? "null" : f(sl.getYaw())) + ",\"pitch\":" + (sl == null ? "null" : f(sl.getPitch())) + "}");
        final int id = pe.getEntityId();
        Bukkit.getScheduler().runTaskTimer(this, task -> {
            if (!pe.isValid()) { w("{\"t\":\"pgone\",\"tick\":" + Bukkit.getCurrentTick() + ",\"id\":" + id + ",\"at\":" + loc(pe.getLocation()) + "}"); task.cancel(); }
        }, 1L, 1L);
    }

    @EventHandler(priority = EventPriority.MONITOR)
    public void onHit(ProjectileHitEvent e) {
        if (!(e.getEntity() instanceof EnderPearl pe)) return;
        String what = e.getHitBlock() != null ? q(e.getHitBlock().getType().name() + "@" + e.getHitBlock().getX() + "," + e.getHitBlock().getY() + "," + e.getHitBlock().getZ())
            : e.getHitEntity() != null ? q(e.getHitEntity().getType().name()) : "null";
        w("{\"t\":\"phit\",\"tick\":" + Bukkit.getCurrentTick() + ",\"id\":" + pe.getEntityId() + ",\"at\":" + loc(pe.getLocation()) + ",\"hit\":" + what + ",\"cancelled\":" + e.isCancelled() + "}");
    }

    @EventHandler(priority = EventPriority.MONITOR)
    public void onTp(PlayerTeleportEvent e) {
        if (e.getCause() != PlayerTeleportEvent.TeleportCause.ENDER_PEARL) return;
        w("{\"t\":\"ptp\",\"tick\":" + Bukkit.getCurrentTick() + ",\"from\":" + loc(e.getFrom()) + ",\"to\":" + loc(e.getTo()) + ",\"cancelled\":" + e.isCancelled() + "}");
    }
}
