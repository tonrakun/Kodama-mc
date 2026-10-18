package dev.kodama.harness;

import com.destroystokyo.paper.event.server.ServerTickEndEvent;
import com.destroystokyo.paper.event.server.ServerTickStartEvent;
import com.sun.management.GarbageCollectionNotificationInfo;
import org.bukkit.Bukkit;
import org.bukkit.World;
import org.bukkit.entity.Player;
import org.bukkit.event.EventHandler;
import org.bukkit.event.EventPriority;
import org.bukkit.event.HandlerList;
import org.bukkit.event.Listener;
import org.bukkit.event.entity.EntityDamageEvent;
import org.bukkit.event.entity.EntityDeathEvent;
import org.bukkit.event.entity.EntityRemoveEvent;
import org.bukkit.entity.LivingEntity;
import org.bukkit.inventory.ItemStack;
import org.bukkit.plugin.java.JavaPlugin;

import javax.management.ListenerNotFoundException;
import javax.management.Notification;
import javax.management.NotificationEmitter;
import javax.management.NotificationListener;
import javax.management.openmbean.CompositeData;
import java.io.IOException;
import java.lang.management.GarbageCollectorMXBean;
import java.lang.management.ManagementFactory;
import java.nio.file.Path;
import java.util.ArrayList;
import java.util.Arrays;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.logging.Level;

/**
 * One recording session. Phases are driven from ServerTickEndEvent (main thread) using wall-clock time,
 * so no scheduler task is needed. durationSeconds <= 0 means "until finish() is called" (manual mode).
 */
final class MetricsRecorder implements Listener {
    private enum Phase { WARMUP, RECORDING, DONE }

    private final JavaPlugin plugin;
    private final Path outDir;
    private final int warmupSeconds;
    private final int durationSeconds;
    private final boolean autostop;

    private final Stats.DoubleList tickMs = new Stats.DoubleList();
    private final Stats.DoubleList gcPauseMs = new Stats.DoubleList();
    private final Map<String, long[]> gcByCollector = new LinkedHashMap<>(); // {count, timeMs}
    private final Object gcLock = new Object();
    private final List<Runnable> gcUnregister = new ArrayList<>();

    private Phase phase = Phase.WARMUP;
    private long phaseStartNanos;
    private long windowStartNanos;
    private long windowEndNanos;
    private long nextHeapSampleNanos;

    private long mainThreadId;
    private long allocStart;
    private long allocEnd;
    private final com.sun.management.ThreadMXBean threadBean;

    private double heapUsedSum;
    private long heapSamples;
    private long heapUsedMax;
    private long heapCommittedMax;

    private long deaths;
    private long dropItems;
    private long fallDeaths;
    private long fallDropItems;
    private final Map<String, long[]> despawnsByType = new LinkedHashMap<>();

    private volatile boolean recording;
    private SlowTickSampler sampler;

    MetricsRecorder(JavaPlugin plugin, Path outDir, int warmupSeconds, int durationSeconds, boolean autostop) {
        this.plugin = plugin;
        this.outDir = outDir;
        this.warmupSeconds = warmupSeconds;
        this.durationSeconds = durationSeconds;
        this.autostop = autostop;
        this.threadBean = ManagementFactory.getThreadMXBean() instanceof com.sun.management.ThreadMXBean t ? t : null;
    }

    /** Call on the main thread: its id is the one allocation is measured on. */
    void begin() {
        mainThreadId = Thread.currentThread().threadId();
        phaseStartNanos = System.nanoTime();
        Bukkit.getPluginManager().registerEvents(this, plugin);
        if (warmupSeconds <= 0) {
            startWindow();
        } else {
            plugin.getLogger().info("Metrics: warmup " + warmupSeconds + "s");
        }
    }

    boolean isFinished() {
        return phase == Phase.DONE;
    }

    @EventHandler
    public void onTickStart(ServerTickStartEvent e) {
        if (sampler != null) {
            sampler.tickStarted();
        }
    }

    @EventHandler
    public void onTickEnd(ServerTickEndEvent e) {
        if (sampler != null) {
            sampler.tickEnded();
        }
        long now = System.nanoTime();
        if (phase == Phase.WARMUP) {
            if (now - phaseStartNanos >= warmupSeconds * 1_000_000_000L) {
                startWindow();
            }
            return;
        }
        if (phase != Phase.RECORDING) {
            return;
        }
        tickMs.add(e.getTickDuration());
        if (now >= nextHeapSampleNanos) {
            sampleHeap();
            nextHeapSampleNanos = now + 1_000_000_000L;
        }
        if (durationSeconds > 0 && now >= windowEndNanos) {
            finish();
            if (autostop) {
                Bukkit.shutdown();
            }
        }
    }

    // Paper marks this Bukkit event for removal, but on 1.20.6 it is the only event that tells despawns apart.
    @SuppressWarnings("removal")
    @EventHandler(priority = EventPriority.MONITOR)
    public void onRemove(EntityRemoveEvent e) {
        if (!recording || e.getCause() != EntityRemoveEvent.Cause.DESPAWN) {
            return;
        }
        despawnsByType.computeIfAbsent(e.getEntityType().name(), k -> new long[1])[0]++;
    }

    @EventHandler(priority = EventPriority.MONITOR)
    public void onDeath(EntityDeathEvent e) {
        if (!recording || e.getEntity() instanceof Player) {
            return;
        }
        deaths++;
        boolean fall = e.getEntity().getLastDamageCause() != null
                && e.getEntity().getLastDamageCause().getCause() == EntityDamageEvent.DamageCause.FALL;
        if (fall) {
            fallDeaths++;
        }
        for (ItemStack s : e.getDrops()) {
            if (s != null) {
                dropItems += s.getAmount();
                if (fall) {
                    fallDropItems += s.getAmount();
                }
            }
        }
    }

    private void startWindow() {
        phase = Phase.RECORDING;
        windowStartNanos = System.nanoTime();
        windowEndNanos = windowStartNanos + durationSeconds * 1_000_000_000L;
        nextHeapSampleNanos = windowStartNanos;
        allocStart = threadAllocated();
        registerGcListeners();
        sampler = new SlowTickSampler(Thread.currentThread(), 100);
        sampler.start();
        recording = true;
        plugin.getLogger().info("Metrics: recording started"
                + (durationSeconds > 0 ? " (" + durationSeconds + "s)" : " (until stopped)"));
    }

    private long threadAllocated() {
        return threadBean == null ? 0 : threadBean.getThreadAllocatedBytes(mainThreadId);
    }

    private void sampleHeap() {
        var usage = ManagementFactory.getMemoryMXBean().getHeapMemoryUsage();
        heapUsedSum += usage.getUsed();
        heapSamples++;
        heapUsedMax = Math.max(heapUsedMax, usage.getUsed());
        heapCommittedMax = Math.max(heapCommittedMax, usage.getCommitted());
    }

    private void registerGcListeners() {
        for (GarbageCollectorMXBean gc : ManagementFactory.getGarbageCollectorMXBeans()) {
            if (!(gc instanceof NotificationEmitter emitter)) {
                continue;
            }
            // Notifications arrive on a JVM service thread, hence the lock.
            NotificationListener listener = (Notification n, Object handback) -> {
                if (!recording
                        || !GarbageCollectionNotificationInfo.GARBAGE_COLLECTION_NOTIFICATION.equals(n.getType())) {
                    return;
                }
                GarbageCollectionNotificationInfo info =
                        GarbageCollectionNotificationInfo.from((CompositeData) n.getUserData());
                long ms = info.getGcInfo().getDuration();
                synchronized (gcLock) {
                    if (isPause(info.getGcName())) {
                        gcPauseMs.add(ms);
                    }
                    long[] c = gcByCollector.computeIfAbsent(info.getGcName(), k -> new long[2]);
                    c[0]++;
                    c[1] += ms;
                }
            };
            emitter.addNotificationListener(listener, null, null);
            gcUnregister.add(() -> {
                try {
                    emitter.removeNotificationListener(listener);
                } catch (ListenerNotFoundException ignored) {
                    // already removed
                }
            });
        }
    }

    // "G1 Concurrent GC" and ZGC "... Cycles" report concurrent work, not stop-the-world time.
    private static boolean isPause(String gcName) {
        return !gcName.contains("Concurrent") && !gcName.endsWith("Cycles");
    }

    /** Stops recording and writes metrics.json. Main thread only (reads world state). Idempotent. */
    void finish() {
        if (phase == Phase.DONE) {
            return;
        }
        boolean wasRecording = phase == Phase.RECORDING;
        phase = Phase.DONE;
        recording = false;
        HandlerList.unregisterAll(this);
        gcUnregister.forEach(Runnable::run);
        if (sampler != null) {
            sampler.stop();
        }
        if (!wasRecording) {
            plugin.getLogger().warning("Metrics: stopped before the recording window started; nothing written");
            return;
        }
        allocEnd = threadAllocated();
        double actualSeconds = (System.nanoTime() - windowStartNanos) / 1e9;
        try {
            Json.write(outDir.resolve("metrics.json"), buildReport(actualSeconds));
            plugin.getLogger().info("Metrics: wrote " + outDir.resolve("metrics.json"));
        } catch (IOException ex) {
            plugin.getLogger().log(Level.SEVERE, "Failed to write metrics.json", ex);
        }
    }

    private Map<String, Object> buildReport(double actualSeconds) {
        double[] ticks = tickMs.toArray();
        double[] sorted = ticks.clone();
        Arrays.sort(sorted);
        int tickCount = ticks.length;

        Map<String, Object> mspt = new LinkedHashMap<>();
        mspt.put("avg", Stats.avg(ticks));
        mspt.put("p50", Stats.percentile(sorted, 50));
        mspt.put("p95", Stats.percentile(sorted, 95));
        mspt.put("p99", Stats.percentile(sorted, 99));
        mspt.put("max", Stats.max(ticks));
        mspt.put("over50", Arrays.stream(ticks).filter(t -> t > 50).count());
        mspt.put("over100", Arrays.stream(ticks).filter(t -> t > 100).count());

        Map<String, Object> byCollector = new LinkedHashMap<>();
        double[] pauses;
        synchronized (gcLock) {
            pauses = gcPauseMs.toArray();
            for (Map.Entry<String, long[]> en : gcByCollector.entrySet()) {
                Map<String, Object> c = new LinkedHashMap<>();
                c.put("count", en.getValue()[0]);
                c.put("timeMs", en.getValue()[1]);
                byCollector.put(en.getKey(), c);
            }
        }
        Arrays.sort(pauses);
        double pauseTotal = 0;
        for (double p : pauses) {
            pauseTotal += p;
        }
        Map<String, Object> gc = new LinkedHashMap<>();
        gc.put("count", pauses.length);
        gc.put("totalPauseMs", pauseTotal);
        gc.put("maxPauseMs", Stats.max(pauses));
        gc.put("p99PauseMs", Stats.percentile(pauses, 99));
        gc.put("byCollector", byCollector);

        double mb = 1024.0 * 1024.0;
        Map<String, Object> heap = new LinkedHashMap<>();
        heap.put("usedAvgMB", heapSamples == 0 ? 0 : heapUsedSum / heapSamples / mb);
        heap.put("usedMaxMB", heapUsedMax / mb);
        heap.put("committedMaxMB", heapCommittedMax / mb);

        Map<String, Object> worlds = new LinkedHashMap<>();
        for (World w : Bukkit.getWorlds()) {
            Map<String, Object> m = new LinkedHashMap<>();
            m.put("entities", w.getEntityCount());
            m.put("living", w.getLivingEntities().size());
            m.put("chunks", w.getLoadedChunks().length);
            worlds.put(w.getName(), m);
        }

        Map<String, Long> mobsByType = new java.util.TreeMap<>();
        for (World w : Bukkit.getWorlds()) {
            for (LivingEntity le : w.getLivingEntities()) {
                if (!(le instanceof Player)) {
                    mobsByType.merge(le.getType().name(), 1L, Long::sum);
                }
            }
        }
        Map<String, Long> despawns = new java.util.TreeMap<>();
        long despawnTotal = 0;
        for (Map.Entry<String, long[]> en : despawnsByType.entrySet()) {
            despawns.put(en.getKey(), en.getValue()[0]);
            despawnTotal += en.getValue()[0];
        }
        Map<String, Object> mobs = new LinkedHashMap<>();
        mobs.put("total", mobsByType.values().stream().mapToLong(Long::longValue).sum());
        mobs.put("byType", mobsByType);
        mobs.put("despawns", despawnTotal);
        mobs.put("despawnsByType", despawns);

        Map<String, Object> drops = new LinkedHashMap<>();
        drops.put("deaths", deaths);
        drops.put("items", dropItems);
        drops.put("fallDeaths", fallDeaths);
        drops.put("fallItems", fallDropItems);

        Map<String, Object> out = new LinkedHashMap<>();
        out.put("server", Bukkit.getName());
        out.put("version", Bukkit.getVersion());
        out.put("java", System.getProperty("java.version"));
        out.put("jvmArgs", ManagementFactory.getRuntimeMXBean().getInputArguments());
        out.put("warmupSeconds", warmupSeconds);
        out.put("durationSeconds", durationSeconds > 0 ? durationSeconds : Math.round(actualSeconds));
        out.put("ticks", tickCount);
        out.put("tps", actualSeconds > 0 ? tickCount / actualSeconds : 0);
        out.put("mspt", mspt);
        out.put("gc", gc);
        out.put("heap", heap);
        out.put("allocBytesPerTick", tickCount == 0 ? 0 : (double) (allocEnd - allocStart) / tickCount);
        out.put("worlds", worlds);
        out.put("players", Bukkit.getOnlinePlayers().size());
        out.put("drops", drops);
        out.put("mobs", mobs);
        out.put("slowTickStacks", sampler == null ? List.of() : sampler.top(15));
        return out;
    }
}
