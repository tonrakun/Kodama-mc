package dev.kodama.harness;

import org.bukkit.Bukkit;
import org.bukkit.GameRule;
import org.bukkit.Material;
import org.bukkit.World;
import org.bukkit.block.Block;
import org.bukkit.block.BlockFace;
import org.bukkit.block.Container;
import org.bukkit.block.data.type.Chest;
import org.bukkit.block.data.type.Hopper;
import org.bukkit.inventory.ItemStack;
import org.bukkit.scheduler.BukkitRunnable;

import java.nio.file.Path;
import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.regex.Matcher;
import java.util.regex.Pattern;

/**
 * Micro benchmark for the hopper idle sleep: a grid of hoppers that never move anything, half of them under empty chests,
 * half of them facing full chests. The tick times come from the usual metrics recorder.
 */
final class HopperBench {
    private static final String WORLD = "harness_hopper_bench";
    // Units keep 3 blocks from the chunk edge so every chunk a hopper looks into is a loaded one
    private static final int[] LOCAL = {3, 5, 7, 9, 11};
    private static final int UNITS_PER_CHUNK = LOCAL.length * LOCAL.length;
    private static final Pattern SLEEPING = Pattern.compile(WORLD + ": (\\d+) sleeping");

    private final HarnessPlugin plugin;
    private final Path outDir;
    private final int hopperCount;
    private final int warmupSeconds;
    private final int durationSeconds;
    private final Map<String, Object> result = new LinkedHashMap<>();

    private World world;
    private MetricsRecorder metrics;

    HopperBench(HarnessPlugin plugin, Path outDir, int hopperCount, int warmupSeconds, int durationSeconds) {
        this.plugin = plugin;
        this.outDir = outDir;
        this.hopperCount = hopperCount;
        this.warmupSeconds = warmupSeconds;
        this.durationSeconds = durationSeconds;
    }

    void begin() {
        world = TrapTower.createVoidWorld(WORLD);
        world.setGameRule(GameRule.DO_DAYLIGHT_CYCLE, false);
        world.setGameRule(GameRule.DO_WEATHER_CYCLE, false);
        world.setGameRule(GameRule.DO_MOB_SPAWNING, false);
        world.setGameRule(GameRule.RANDOM_TICK_SPEED, 0);
        result.put("kodama", HopperTest.isKodama());
        result.put("world", WORLD);
        int chunkCount = (hopperCount + UNITS_PER_CHUNK - 1) / UNITS_PER_CHUNK;
        int side = (int) Math.ceil(Math.sqrt(chunkCount));
        List<int[]> chunks = new ArrayList<>();
        for (int i = 0; i < chunkCount; i++) {
            chunks.add(new int[] {i % side, i / side});
        }
        HopperTest.forceLoad(world, chunks);
        HopperTest.awaitTicking(plugin, world, chunks, () -> start(chunks), message -> {
            result.put("error", message);
            finish();
        });
    }

    private void start(List<int[]> chunks) {
        try {
            int built = build(chunks);
            result.put("hoppers", built);
            metrics = new MetricsRecorder(plugin, outDir, warmupSeconds, durationSeconds, false);
            metrics.begin();
            new BukkitRunnable() {
                @Override
                public void run() {
                    if (metrics.isFinished()) {
                        cancel();
                        finish();
                    }
                }
            }.runTaskTimer(plugin, 20L, 20L);
        } catch (Throwable t) {
            result.put("error", HopperTest.describe(t));
            finish();
        }
    }

    private int build(List<int[]> chunks) {
        int built = 0;
        for (int[] chunk : chunks) {
            for (int x = 0; x < 16; x++) {
                for (int z = 0; z < 16; z++) {
                    world.getBlockAt(chunk[0] * 16 + x, HopperTest.FLOOR_Y, chunk[1] * 16 + z).setType(Material.STONE, false);
                }
            }
            for (int lx : LOCAL) {
                for (int lz : LOCAL) {
                    if (built >= hopperCount) {
                        return built;
                    }
                    int x = chunk[0] * 16 + lx;
                    int z = chunk[1] * 16 + lz;
                    if (built % 2 == 0) {
                        // nothing to take from the chest and nowhere to put anything
                        chest(world.getBlockAt(x, HopperTest.Y + 1, z));
                        hopper(world.getBlockAt(x, HopperTest.Y, z), BlockFace.DOWN);
                    } else {
                        Block full = world.getBlockAt(x + 1, HopperTest.Y, z);
                        chest(full);
                        ((Container) full.getState()).getInventory().addItem(new ItemStack(Material.STONE, 64 * 27));
                        Block hopper = world.getBlockAt(x, HopperTest.Y, z);
                        hopper(hopper, BlockFace.EAST);
                        ((Container) hopper.getState()).getInventory().addItem(new ItemStack(Material.STONE, 1));
                    }
                    built++;
                }
            }
        }
        return built;
    }

    private static void chest(Block block) {
        block.setType(Material.CHEST, false);
        Chest data = (Chest) block.getBlockData();
        data.setFacing(BlockFace.SOUTH);
        block.setBlockData(data, false);
    }

    private static void hopper(Block block, BlockFace facing) {
        block.setType(Material.HOPPER, false);
        Hopper data = (Hopper) block.getBlockData();
        data.setFacing(facing);
        block.setBlockData(data, true);
    }

    private void finish() {
        if (metrics != null) {
            metrics.finish();
        }
        if (HopperTest.isKodama()) {
            String status = HopperTest.command("kodama status");
            Matcher m = SLEEPING.matcher(status);
            result.put("status", status);
            result.put("sleeping", m.find() ? Integer.parseInt(m.group(1)) : null);
        }
        try {
            Json.write(outDir.resolve("hopper-bench.json"), result);
        } catch (Exception e) {
            plugin.getLogger().warning("Cannot write the hopper benchmark result: " + e);
        }
        Bukkit.shutdown();
    }
}
