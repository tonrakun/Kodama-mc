package dev.kodama.harness;

import net.kyori.adventure.text.Component;
import net.kyori.adventure.text.serializer.plain.PlainTextComponentSerializer;
import org.bukkit.Bukkit;
import org.bukkit.GameRule;
import org.bukkit.Material;
import org.bukkit.World;
import org.bukkit.block.Block;
import org.bukkit.block.BlockFace;
import org.bukkit.block.data.Lightable;
import org.bukkit.block.data.type.Observer;
import org.bukkit.block.data.type.RedstoneWire;
import org.bukkit.block.data.type.Switch;
import org.bukkit.command.CommandSender;
import org.bukkit.scheduler.BukkitRunnable;

import java.nio.file.Path;
import java.util.ArrayList;
import java.util.Collections;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;

/**
 * Redstone monitoring test: a two observer clock driving a lamp in chunk A, a single lever pull in chunk B. The first run
 * measures the clock, reads the monitor commands and switches chunk A to Alternate Current. The verify run starts again on
 * the same world and checks that the switch survived the restart, then switches back. Kodama's commands are reached
 * through the console command line because this jar compiles against the Paper API only.
 */
final class RedstoneTest {
    private static final String WORLD = "harness_redstone";
    private static final int CHUNK_A_X = 0;
    private static final int CHUNK_A_Z = 0;
    private static final int CHUNK_B_X = 4;
    private static final int CHUNK_B_Z = 0;
    private static final int FLOOR_Y = 99;
    private static final int Y = FLOOR_Y + 1;
    private static final int LINE_LENGTH = 10;

    private static final int SETTLE_TICKS = 40;
    private static final int SWITCH_TIMEOUT_TICKS = 15 * 20;
    private static final int RESTART_SETTLE_TICKS = 5 * 20;

    private final HarnessPlugin plugin;
    private final Path outDir;
    private final boolean verify;
    private final int measureTicks;
    private final int followUpTicks;
    private final Map<String, Object> result = new LinkedHashMap<>();

    private World world;
    private Block lampA;
    private Block lampB;
    private boolean finished;

    RedstoneTest(HarnessPlugin plugin, Path outDir, boolean verify, int measureSeconds, int followUpSeconds) {
        this.plugin = plugin;
        this.outDir = outDir;
        this.verify = verify;
        this.measureTicks = measureSeconds * 20;
        this.followUpTicks = followUpSeconds * 20;
    }

    void begin() {
        world = TrapTower.createVoidWorld(WORLD);
        world.setGameRule(GameRule.DO_DAYLIGHT_CYCLE, false);
        world.setGameRule(GameRule.DO_WEATHER_CYCLE, false);
        world.setGameRule(GameRule.DO_MOB_SPAWNING, false);
        result.put("kodama", isKodama());
        result.put("world", WORLD);
        result.put("chunkA", List.of(CHUNK_A_X, CHUNK_A_Z));
        result.put("chunkB", List.of(CHUNK_B_X, CHUNK_B_Z));
        // Nobody is online, so only force loaded chunks stay in the ticking range
        world.setChunkForceLoaded(CHUNK_A_X, CHUNK_A_Z, true);
        world.setChunkForceLoaded(CHUNK_B_X, CHUNK_B_Z, true);
        world.getChunkAt(CHUNK_A_X, CHUNK_A_Z);
        world.getChunkAt(CHUNK_B_X, CHUNK_B_Z);
        lampA = world.getBlockAt(CHUNK_A_X * 16 + 3 + LINE_LENGTH, Y, CHUNK_A_Z * 16 + 8);
        lampB = world.getBlockAt(CHUNK_B_X * 16 + 3 + LINE_LENGTH / 2, Y, CHUNK_B_Z * 16 + 8);
        if (!verify) {
            build();
        }
        run();
    }

    private void run() {
        new BukkitRunnable() {
            @Override
            public void run() {
                try {
                    if (verify) {
                        runVerify();
                    } else {
                        runMeasure();
                    }
                } catch (Throwable t) {
                    result.put("error", describe(t));
                    finish();
                }
            }
        }.runTaskLater(plugin, SETTLE_TICKS);
    }

    private void runMeasure() {
        new Sequence() {
            @Override
            void next(int step) {
                switch (step) {
                    case 0 -> {
                        Switch lever = (Switch) world.getBlockAt(CHUNK_B_X * 16 + 2, Y, CHUNK_B_Z * 16 + 8).getBlockData();
                        lever.setPowered(true);
                        world.getBlockAt(CHUNK_B_X * 16 + 2, Y, CHUNK_B_Z * 16 + 8).setBlockData(lever, true);
                        sampler("baseline", measureTicks, 1);
                    }
                    case 1 -> {
                        result.put("lampBLit", ((Lightable) lampB.getBlockData()).isLit());
                        result.put("infoA", command(info()));
                        result.put("infoB", command("kodama redstone info " + CHUNK_B_X + " " + CHUNK_B_Z + " " + WORLD));
                        result.put("top", command("kodama redstone top 5 " + WORLD));
                        result.put("setOutput", command(set("alternate-current")));
                        awaitInfo("Alternate Current", "switch", 2);
                    }
                    case 2 -> sampler("alternateCurrent", followUpTicks, 3);
                    case 3 -> finish();
                    default -> throw new IllegalStateException("step " + step);
                }
            }
        }.advance();
    }

    private void runVerify() {
        new Sequence() {
            @Override
            void next(int step) {
                switch (step) {
                    case 0 -> delay(RESTART_SETTLE_TICKS, 1);
                    case 1 -> {
                        result.put("infoAtStart", command(info()));
                        sampler("afterRestart", followUpTicks, 2);
                    }
                    case 2 -> {
                        result.put("infoAfterRestart", command(info()));
                        result.put("setVanillaOutput", command(set("vanilla")));
                        awaitInfo("world implementation", "switchBack", 3);
                    }
                    case 3 -> sampler("vanilla", followUpTicks, 4);
                    case 4 -> finish();
                    default -> throw new IllegalStateException("step " + step);
                }
            }
        }.advance();
    }

    /** Steps run one after another; a step names the step that follows once its asynchronous part is done. */
    private abstract class Sequence {
        private int step;

        abstract void next(int step);

        void advance() {
            try {
                next(step);
            } catch (Throwable t) {
                result.put("error", describe(t));
                finish();
            }
        }

        void goTo(int next) {
            step = next;
            advance();
        }

        void delay(int ticks, int next) {
            Bukkit.getScheduler().runTaskLater(plugin, () -> goTo(next), ticks);
        }

        void sampler(String name, int ticks, int next) {
            new Sampler(name, ticks, () -> goTo(next)).runTaskTimer(plugin, 1L, 1L);
        }

        void awaitInfo(String expected, String name, int next) {
            new BukkitRunnable() {
                private int ticks;

                @Override
                public void run() {
                    ticks += 20;
                    boolean reached = command(info()).contains(expected);
                    if (reached || ticks >= SWITCH_TIMEOUT_TICKS) {
                        cancel();
                        result.put(name + "Seconds", reached ? ticks / 20 : null);
                        goTo(next);
                    }
                }
            }.runTaskTimer(plugin, 20L, 20L);
        }
    }

    /**
     * Counts the changes of the signal that reaches the lamp per game second. The lamp itself cannot show it: a lamp turns
     * off 4 ticks after it lost power, and the clock's pulses are shorter than that, so the lamp stays lit.
     */
    private final class Sampler extends BukkitRunnable {
        private final String name;
        private final int ticks;
        private final Runnable done;
        private final Block lastWire = lampA.getRelative(BlockFace.WEST);
        private final List<Integer> perSecond = new ArrayList<>();
        private int elapsed;
        private int lampToggles;
        private int signalToggles;
        private int bucket;
        private Boolean lampBefore;
        private Boolean signalBefore;

        Sampler(String name, int ticks, Runnable done) {
            this.name = name;
            this.ticks = ticks;
            this.done = done;
        }

        @Override
        public void run() {
            boolean lamp = ((Lightable) lampA.getBlockData()).isLit();
            boolean signal = ((RedstoneWire) lastWire.getBlockData()).getPower() > 0;
            if (lampBefore != null && lampBefore != lamp) {
                lampToggles++;
            }
            if (signalBefore != null && signalBefore != signal) {
                signalToggles++;
                bucket++;
            }
            lampBefore = lamp;
            signalBefore = signal;
            elapsed++;
            if (elapsed % 20 == 0) {
                perSecond.add(bucket);
                bucket = 0;
            }
            if (elapsed >= ticks) {
                cancel();
                Map<String, Object> out = new LinkedHashMap<>();
                double seconds = elapsed / 20.0;
                out.put("seconds", seconds);
                out.put("signalToggles", signalToggles);
                out.put("signalTogglesPerSecond", signalToggles / seconds);
                out.put("signalTogglesEachSecond", perSecond);
                out.put("lampToggles", lampToggles);
                result.put(name, out);
                done.run();
            }
        }
    }

    private String info() {
        return "kodama redstone info " + CHUNK_A_X + " " + CHUNK_A_Z + " " + WORLD;
    }

    private String set(String mode) {
        return "kodama redstone set " + mode + " " + CHUNK_A_X + " " + CHUNK_A_Z + " " + WORLD;
    }

    private String command(String command) {
        List<String> lines = Collections.synchronizedList(new ArrayList<>());
        CommandSender sender = Bukkit.createCommandSender(m -> lines.add(PlainTextComponentSerializer.plainText().serialize(m)));
        try {
            Bukkit.dispatchCommand(sender, command);
        } catch (Throwable t) {
            lines.add("threw " + describe(t));
        }
        return String.join("\n", lines);
    }

    private void build() {
        for (int[] chunk : new int[][] {{CHUNK_A_X, CHUNK_A_Z}, {CHUNK_B_X, CHUNK_B_Z}}) {
            for (int x = 0; x < 16; x++) {
                for (int z = 0; z < 16; z++) {
                    world.getBlockAt(chunk[0] * 16 + x, FLOOR_Y, chunk[1] * 16 + z).setType(Material.STONE, false);
                }
            }
        }
        // The lamp and the wire go first so the observers' first pulse has something to power. Updates are on, because
        // wire connections only form from the updates of the neighbours and the second observer starts the clock.
        int ax = CHUNK_A_X * 16;
        int az = CHUNK_A_Z * 16 + 8;
        world.getBlockAt(ax + 3 + LINE_LENGTH, Y, az).setType(Material.REDSTONE_LAMP, true);
        for (int i = LINE_LENGTH - 1; i >= 0; i--) {
            world.getBlockAt(ax + 3 + i, Y, az).setType(Material.REDSTONE_WIRE, true);
        }
        place(ax + 1, az, Material.OBSERVER, BlockFace.EAST);
        place(ax + 2, az, Material.OBSERVER, BlockFace.WEST);

        int bx = CHUNK_B_X * 16;
        int bz = CHUNK_B_Z * 16 + 8;
        world.getBlockAt(lampB.getX(), Y, bz).setType(Material.REDSTONE_LAMP, true);
        for (int x = bx + 3; x < lampB.getX(); x++) {
            world.getBlockAt(x, Y, bz).setType(Material.REDSTONE_WIRE, true);
        }
        Block lever = world.getBlockAt(bx + 2, Y, bz);
        lever.setType(Material.LEVER, false);
        Switch data = (Switch) lever.getBlockData();
        data.setAttachedFace(org.bukkit.block.data.FaceAttachable.AttachedFace.FLOOR);
        lever.setBlockData(data, true);
    }

    private void place(int x, int z, Material material, BlockFace facing) {
        Block block = world.getBlockAt(x, Y, z);
        block.setType(material, false);
        Observer data = (Observer) block.getBlockData();
        data.setFacing(facing);
        block.setBlockData(data, true);
    }

    private void finish() {
        if (finished) {
            return;
        }
        finished = true;
        try {
            Json.write(outDir.resolve(verify ? "redstone-verify.json" : "redstone.json"), result);
        } catch (Exception e) {
            plugin.getLogger().warning("Cannot write the redstone result: " + e);
        }
        Bukkit.shutdown();
    }

    private static boolean isKodama() {
        try {
            Class.forName("dev.kodama.redstone.RedstoneMonitor");
            return true;
        } catch (ClassNotFoundException e) {
            return false;
        }
    }

    private static String describe(Throwable t) {
        return t.getClass().getName() + ": " + t.getMessage();
    }
}
