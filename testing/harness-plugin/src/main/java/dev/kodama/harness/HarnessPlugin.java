package dev.kodama.harness;

import org.bukkit.Bukkit;
import org.bukkit.GameMode;
import org.bukkit.World;
import org.bukkit.command.Command;
import org.bukkit.command.CommandSender;
import org.bukkit.entity.Player;
import org.bukkit.event.EventHandler;
import org.bukkit.event.Listener;
import org.bukkit.event.player.PlayerJoinEvent;
import org.bukkit.event.server.ServerLoadEvent;
import org.bukkit.plugin.java.JavaPlugin;

import java.nio.file.Files;
import java.nio.file.Path;
import java.util.ArrayList;
import java.util.List;

public final class HarnessPlugin extends JavaPlugin implements Listener {
    private static final String P = "kodama.harness.";

    private Path outDir;
    private String botPrefix;
    private MetricsRecorder metrics;
    private Pregenerator pregen;
    private TrapTower tower;

    @Override
    public void onEnable() {
        outDir = Path.of(System.getProperty(P + "out", "harness-out")).toAbsolutePath();
        try {
            Files.createDirectories(outDir);
        } catch (Exception e) {
            getLogger().warning("Cannot create output dir " + outDir + ": " + e);
        }
        botPrefix = System.getProperty(P + "botPrefix", "bot");
        getServer().getPluginManager().registerEvents(this, this);
    }

    @Override
    public void onDisable() {
        if (pregen != null) {
            pregen.cancel();
        }
        if (metrics != null) {
            metrics.finish();
        }
    }

    @EventHandler
    public void onServerLoad(ServerLoadEvent e) {
        if (e.getType() != ServerLoadEvent.LoadType.STARTUP) {
            return;
        }
        if (Boolean.getBoolean(P + "tower")) {
            tower = new TrapTower(TrapTower.createVoidWorld("harness_tower"));
            tower.build();
        }
        String mode = System.getProperty(P + "mode");
        if ("pregen".equals(mode)) {
            startPregen(intProp("radius", 16), true);
        } else if ("metrics".equals(mode)) {
            // Runs on the main thread, which is the thread whose allocations get measured.
            metrics = new MetricsRecorder(this, outDir, intProp("warmup", 30), intProp("duration", 120),
                    Boolean.parseBoolean(System.getProperty(P + "autostop", "true")));
            metrics.begin();
        }
    }

    @EventHandler
    public void onJoin(PlayerJoinEvent e) {
        Player p = e.getPlayer();
        if (p.getName().startsWith(botPrefix)) {
            p.setGameMode(GameMode.CREATIVE);
            p.setAllowFlight(true);
            p.setOp(true);
            if (tower != null) {
                tower.park(p);
            }
        }
    }

    private int intProp(String key, int def) {
        String v = System.getProperty(P + key);
        if (v == null || v.isBlank()) {
            return def;
        }
        try {
            return Integer.parseInt(v.trim());
        } catch (NumberFormatException ex) {
            getLogger().warning("Bad value for " + P + key + ": " + v + " (using " + def + ")");
            return def;
        }
    }

    private List<World> selectWorlds() {
        String csv = System.getProperty(P + "worlds");
        if (csv == null || csv.isBlank()) {
            return new ArrayList<>(Bukkit.getWorlds());
        }
        List<World> out = new ArrayList<>();
        for (String name : csv.split(",")) {
            World w = Bukkit.getWorld(name.trim());
            if (w == null) {
                getLogger().warning("Unknown world: " + name.trim());
            } else {
                out.add(w);
            }
        }
        return out;
    }

    private boolean startPregen(int radius, boolean shutdownWhenDone) {
        if (pregen != null) {
            return false;
        }
        Runnable onComplete = () -> {
            pregen = null;
            if (shutdownWhenDone) {
                Bukkit.shutdown();
            }
        };
        pregen = new Pregenerator(this, radius, intProp("concurrency", 64), selectWorlds(), outDir, onComplete);
        pregen.start();
        return true;
    }

    @Override
    public boolean onCommand(CommandSender sender, Command command, String label, String[] args) {
        if (args.length == 2 && args[0].equalsIgnoreCase("metrics") && args[1].equalsIgnoreCase("start")) {
            if (metrics != null && !metrics.isFinished()) {
                sender.sendMessage("Metrics already running");
                return true;
            }
            metrics = new MetricsRecorder(this, outDir, 0, 0, false);
            metrics.begin();
            sender.sendMessage("Metrics recording started");
        } else if (args.length == 2 && args[0].equalsIgnoreCase("metrics") && args[1].equalsIgnoreCase("stop")) {
            if (metrics == null || metrics.isFinished()) {
                sender.sendMessage("No metrics recording is running");
                return true;
            }
            metrics.finish();
            sender.sendMessage("Metrics written to " + outDir.resolve("metrics.json"));
        } else if (args.length == 2 && args[0].equalsIgnoreCase("pregen")) {
            int radius;
            try {
                radius = Integer.parseInt(args[1]);
            } catch (NumberFormatException ex) {
                return false;
            }
            sender.sendMessage(startPregen(radius, false) ? "Pregen started" : "Pregen already running");
        } else if (args.length == 1 && args[0].equalsIgnoreCase("stop")) {
            if (metrics != null) {
                metrics.finish();
            }
            Bukkit.shutdown();
        } else {
            return false;
        }
        return true;
    }
}
