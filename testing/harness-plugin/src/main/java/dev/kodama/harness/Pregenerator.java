package dev.kodama.harness;

import org.bukkit.Bukkit;
import org.bukkit.World;
import org.bukkit.plugin.java.JavaPlugin;
import org.bukkit.scheduler.BukkitRunnable;
import org.bukkit.scheduler.BukkitTask;

import java.io.IOException;
import java.nio.file.Path;
import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.logging.Level;

/** Generates a square of chunks around 0,0 per world, sequentially, without ever blocking the main thread. */
final class Pregenerator {
    private final JavaPlugin plugin;
    private final int radius;
    private final int concurrency;
    private final Path outDir;
    private final Runnable onComplete;
    private final List<World> worlds = new ArrayList<>();
    private final Map<String, Map<String, Object>> results = new LinkedHashMap<>();
    private final int side;
    private final long total;

    private BukkitTask task;
    private int worldIndex = -1;
    private World current;
    private long next;
    private long done;
    private int inFlight;
    private long worldStartNanos;
    private int nextReportPct;

    Pregenerator(JavaPlugin plugin, int radius, int concurrency, List<World> worlds, Path outDir, Runnable onComplete) {
        this.plugin = plugin;
        this.radius = radius;
        this.concurrency = Math.max(1, concurrency);
        this.worlds.addAll(worlds);
        this.outDir = outDir;
        this.onComplete = onComplete;
        this.side = radius * 2 + 1;
        this.total = (long) side * side;
    }

    /** Must be called on the main thread. */
    void start() {
        plugin.getLogger().info("Pregen: radius " + radius + " (" + total + " chunks per world), concurrency "
                + concurrency + ", worlds " + worlds.stream().map(World::getName).toList());
        advanceWorld();
        task = new BukkitRunnable() {
            @Override
            public void run() {
                pump();
            }
        }.runTaskTimer(plugin, 1L, 1L);
    }

    void cancel() {
        if (task != null) {
            task.cancel();
            task = null;
        }
    }

    private void advanceWorld() {
        worldIndex++;
        if (worldIndex >= worlds.size()) {
            current = null;
            return;
        }
        current = worlds.get(worldIndex);
        next = 0;
        done = 0;
        inFlight = 0;
        nextReportPct = 5;
        worldStartNanos = System.nanoTime();
        plugin.getLogger().info("Pregen: starting world " + current.getName());
    }

    private void pump() {
        if (current == null) {
            finish();
            return;
        }
        while (inFlight < concurrency && next < total) {
            long i = next++;
            int x = (int) (i % side) - radius;
            int z = (int) (i / side) - radius;
            inFlight++;
            // The chunk is not retained: no tickets, so the server is free to unload it right after generation.
            current.getChunkAtAsync(x, z, true).whenComplete((chunk, err) -> {
                if (err != null) {
                    plugin.getLogger().log(Level.WARNING, "Chunk " + x + "," + z + " failed", err);
                }
                // Completions arrive on the main thread, same as the pump task, so no locking is needed.
                inFlight--;
                done++;
            });
        }
        int pct = (int) (done * 100 / total);
        while (pct >= nextReportPct && nextReportPct <= 100) {
            plugin.getLogger().info("Pregen " + current.getName() + ": " + nextReportPct + "% (" + done + "/" + total + ")");
            nextReportPct += 5;
        }
        if (done >= total) {
            long millis = (System.nanoTime() - worldStartNanos) / 1_000_000L;
            Map<String, Object> r = new LinkedHashMap<>();
            r.put("chunks", done);
            r.put("millis", millis);
            results.put(current.getName(), r);
            plugin.getLogger().info("Pregen: finished world " + current.getName() + " in " + millis + " ms");
            advanceWorld();
        }
    }

    private void finish() {
        cancel();
        for (World w : worlds) {
            w.save();
        }
        Map<String, Object> out = new LinkedHashMap<>();
        out.put("server", Bukkit.getName());
        out.put("version", Bukkit.getVersion());
        out.put("radius", radius);
        out.put("worlds", results);
        try {
            Json.write(outDir.resolve("pregen.json"), out);
            plugin.getLogger().info("Pregen: wrote " + outDir.resolve("pregen.json"));
        } catch (IOException e) {
            plugin.getLogger().log(Level.SEVERE, "Failed to write pregen.json", e);
        }
        onComplete.run();
    }
}
