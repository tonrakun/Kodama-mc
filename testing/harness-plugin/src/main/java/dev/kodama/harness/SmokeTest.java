package dev.kodama.harness;

import net.kyori.adventure.text.Component;
import net.kyori.adventure.text.serializer.plain.PlainTextComponentSerializer;
import org.bukkit.Bukkit;
import org.bukkit.GameRule;
import org.bukkit.Location;
import org.bukkit.Material;
import org.bukkit.World;
import org.bukkit.command.CommandSender;
import org.bukkit.entity.Player;
import org.bukkit.entity.Zombie;
import org.bukkit.event.EventHandler;
import org.bukkit.event.EventPriority;
import org.bukkit.event.Listener;
import org.bukkit.event.player.PlayerCommandPreprocessEvent;
import org.bukkit.plugin.Plugin;
import org.bukkit.scheduler.BukkitRunnable;

import java.nio.file.Path;
import java.util.ArrayList;
import java.util.Collections;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;

/**
 * Plugin compatibility smoke test: lists the plugins, runs console commands, and on Kodama checks that Mob LOD
 * promotes a mob that a plugin touches through the API and that the chunk packet cache steps aside for ProtocolLib.
 * Kodama internals are reached by reflection because this jar compiles against the Paper API only.
 */
final class SmokeTest implements Listener {
    private static final int SETTLE_TICKS = 40;
    private static final int OUTPUT_WAIT_TICKS = 60;
    private static final int TIER_TIMEOUT_TICKS = 40 * 20;
    private static final int BOT_COMMANDS_TIMEOUT_TICKS = 60 * 20;
    private static final int FINISH_GRACE_TICKS = 40;
    private static final int OUTPUT_LIMIT = 2000;

    private static final int PLATFORM_Y = 150;
    private static final int PLATFORM_RADIUS = 48;
    private static final int WALL_X = 8;
    // Between the near distance plus hysteresis (24) and the far distance plus hysteresis (40) of the balanced preset: MID
    private static final int ZOMBIE_X = 30;

    private final HarnessPlugin plugin;
    private final Path outDir;
    private final String botPrefix;
    private final List<String> commands;
    private final int expectedBotCommands;
    private final Map<String, Object> result = new LinkedHashMap<>();
    private final List<Map<String, Object>> botCommands = Collections.synchronizedList(new ArrayList<>());
    private final boolean kodama = isKodama();

    private World world;
    private boolean started;
    private boolean finished;
    private Zombie zombie;
    private Map<String, Object> tierCheck;
    private final List<CommandCapture> captures = new ArrayList<>();

    SmokeTest(HarnessPlugin plugin, Path outDir, String botPrefix, List<String> commands, int expectedBotCommands) {
        this.plugin = plugin;
        this.outDir = outDir;
        this.botPrefix = botPrefix;
        this.commands = commands;
        this.expectedBotCommands = expectedBotCommands;
    }

    void begin(int joinTimeoutSeconds) {
        plugin.getServer().getPluginManager().registerEvents(this, plugin);
        world = TrapTower.createVoidWorld("harness_smoke");
        world.setGameRule(GameRule.DO_DAYLIGHT_CYCLE, false);
        world.setGameRule(GameRule.DO_MOB_SPAWNING, false);
        world.setTime(18000);
        buildPlatform();
        result.put("kodama", kodama);
        Bukkit.getScheduler().runTaskLater(plugin, () -> {
            if (!started) {
                result.put("error", "no bot joined within " + joinTimeoutSeconds + "s");
                finish();
            }
        }, joinTimeoutSeconds * 20L);
    }

    void onBotJoin(Player bot) {
        if (started) {
            return;
        }
        started = true;
        Bukkit.getScheduler().runTaskLater(plugin, () -> run(bot), SETTLE_TICKS);
    }

    @EventHandler(priority = EventPriority.MONITOR)
    public void onCommand(PlayerCommandPreprocessEvent e) {
        if (!e.getPlayer().getName().startsWith(botPrefix)) {
            return;
        }
        String label = e.getMessage().substring(1).split(" ", 2)[0];
        Map<String, Object> entry = new LinkedHashMap<>();
        entry.put("command", e.getMessage());
        entry.put("known", Bukkit.getCommandMap().getCommand(label) != null);
        entry.put("cancelled", e.isCancelled());
        botCommands.add(entry);
    }

    private void run(Player bot) {
        try {
            result.put("plugins", listPlugins());
            bot.teleport(new Location(world, 0.5, PLATFORM_Y + 1, 0.5));
            if (kodama) {
                zombie = world.spawn(new Location(world, ZOMBIE_X + 0.5, PLATFORM_Y + 1, 0.5), Zombie.class, z -> z.setPersistent(true));
            }
            for (String command : commands) {
                captures.add(runConsoleCommand(command));
            }
        } catch (Throwable t) {
            result.put("error", describe(t));
            finish();
            return;
        }
        new BukkitRunnable() {
            private int ticks;
            private int doneAt = -1;

            @Override
            public void run() {
                ticks++;
                try {
                    if (kodama && tierCheck == null) {
                        pollTier(ticks);
                    }
                } catch (Throwable t) {
                    tierCheck = failedCheck("exception: " + describe(t));
                }
                boolean tierDone = !kodama || tierCheck != null;
                boolean outputDone = ticks >= OUTPUT_WAIT_TICKS;
                boolean botDone = botCommands.size() >= expectedBotCommands || ticks >= BOT_COMMANDS_TIMEOUT_TICKS;
                if (doneAt < 0 && tierDone && outputDone && botDone) {
                    doneAt = ticks;
                }
                if (doneAt >= 0 && ticks - doneAt >= FINISH_GRACE_TICKS) {
                    cancel();
                    collect();
                    finish();
                }
            }
        }.runTaskTimer(plugin, 1L, 1L);
    }

    private void collect() {
        List<Map<String, Object>> out = new ArrayList<>();
        for (CommandCapture c : captures) {
            out.add(c.toMap());
        }
        result.put("commands", out);
        result.put("botCommands", new ArrayList<>(botCommands));
        if (kodama) {
            Map<String, Object> checks = new LinkedHashMap<>();
            checks.put("mobLodTouchPromotes", tierCheck);
            checks.put("packetCacheOffWithProtocolLib", packetCacheCheck());
            result.put("kodamaChecks", checks);
        }
    }

    private void finish() {
        if (finished) {
            return;
        }
        finished = true;
        try {
            Json.write(outDir.resolve("smoke.json"), result);
        } catch (Exception e) {
            plugin.getLogger().warning("Cannot write smoke.json: " + e);
        }
        Bukkit.shutdown();
    }

    private List<Map<String, Object>> listPlugins() {
        List<Map<String, Object>> out = new ArrayList<>();
        for (Plugin p : Bukkit.getPluginManager().getPlugins()) {
            Map<String, Object> entry = new LinkedHashMap<>();
            entry.put("name", p.getName());
            entry.put("version", p.getPluginMeta().getVersion());
            entry.put("enabled", p.isEnabled());
            out.add(entry);
        }
        return out;
    }

    private CommandCapture runConsoleCommand(String command) {
        CommandCapture capture = new CommandCapture(command);
        CommandSender sender = Bukkit.createCommandSender(capture::accept);
        try {
            capture.handled = Bukkit.dispatchCommand(sender, command);
        } catch (Throwable t) {
            capture.threw = describe(t);
        }
        return capture;
    }

    private void pollTier(int ticks) throws ReflectiveOperationException {
        if (!zombie.isValid()) {
            tierCheck = failedCheck("the test zombie is gone");
            return;
        }
        String before = tierOf(zombie);
        if (before.equals("NEAR") || before.equals("OFF")) {
            if (ticks >= TIER_TIMEOUT_TICKS) {
                tierCheck = failedCheck("the zombie never left NEAR within " + TIER_TIMEOUT_TICKS / 20 + "s (tier " + before + ")");
            }
            return;
        }
        // Both reads and the API call are in this tick, so only the call itself can have changed the tier.
        zombie.getTarget();
        String after = tierOf(zombie);
        tierCheck = new LinkedHashMap<>();
        tierCheck.put("pass", after.equals("NEAR"));
        tierCheck.put("tierBefore", before);
        tierCheck.put("tierAfter", after);
        tierCheck.put("ticksUntilReduced", ticks);
        if (!after.equals("NEAR")) {
            tierCheck.put("reason", "getTarget() did not promote the mob");
        }
    }

    private Map<String, Object> packetCacheCheck() {
        Map<String, Object> check = new LinkedHashMap<>();
        Plugin protocolLib = Bukkit.getPluginManager().getPlugin("ProtocolLib");
        try {
            Class<?> cache = Class.forName("dev.kodama.chunk.packetcache.ChunkPacketCache");
            String reason = (String) cache.getMethod("inactiveReason").invoke(null);
            check.put("inactiveReason", reason);
            check.put("describe", cache.getMethod("describe").invoke(null));
            if (protocolLib == null || !protocolLib.isEnabled()) {
                check.put("pass", false);
                check.put("reason", "ProtocolLib is not enabled, nothing to check");
            } else {
                boolean pass = reason != null && reason.startsWith("ProtocolLib");
                check.put("pass", pass);
                if (!pass) {
                    check.put("reason", "the cache is " + (reason == null ? "active" : "inactive for another reason") + " while ProtocolLib is enabled");
                }
            }
        } catch (Throwable t) {
            check.put("pass", false);
            check.put("reason", "exception: " + describe(t));
        }
        return check;
    }

    private void buildPlatform() {
        for (int x = -PLATFORM_RADIUS; x <= PLATFORM_RADIUS; x++) {
            for (int z = -PLATFORM_RADIUS; z <= PLATFORM_RADIUS; z++) {
                world.getBlockAt(x, PLATFORM_Y, z).setType(Material.STONE, false);
            }
        }
        // Without it the zombie sees the bot, targets it, and getTarget() would be no test of the promotion
        for (int z = -16; z <= 16; z++) {
            for (int y = PLATFORM_Y + 1; y <= PLATFORM_Y + 12; y++) {
                world.getBlockAt(WALL_X, y, z).setType(Material.STONE, false);
            }
        }
    }

    private static String tierOf(Zombie entity) throws ReflectiveOperationException {
        Object handle = entity.getClass().getMethod("getHandle").invoke(entity);
        return String.valueOf(handle.getClass().getField("kodamaTier").get(handle));
    }

    private static boolean isKodama() {
        try {
            Class.forName("dev.kodama.entity.lod.MobLod");
            return true;
        } catch (ClassNotFoundException e) {
            return false;
        }
    }

    private static Map<String, Object> failedCheck(String reason) {
        Map<String, Object> check = new LinkedHashMap<>();
        check.put("pass", false);
        check.put("reason", reason);
        return check;
    }

    private static String describe(Throwable t) {
        return t.getClass().getName() + ": " + t.getMessage();
    }

    private static final class CommandCapture {
        private final String command;
        private final List<String> lines = Collections.synchronizedList(new ArrayList<>());
        private boolean handled;
        private String threw;

        CommandCapture(String command) {
            this.command = command;
        }

        void accept(Component message) {
            lines.add(PlainTextComponentSerializer.plainText().serialize(message));
        }

        Map<String, Object> toMap() {
            String output = String.join("\n", lines);
            Map<String, Object> map = new LinkedHashMap<>();
            map.put("command", command);
            map.put("handled", handled);
            map.put("threw", threw);
            map.put("output", output.length() > OUTPUT_LIMIT ? output.substring(0, OUTPUT_LIMIT) + "..." : output);
            return map;
        }
    }
}
