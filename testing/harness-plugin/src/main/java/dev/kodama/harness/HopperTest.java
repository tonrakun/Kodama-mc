package dev.kodama.harness;

import com.destroystokyo.paper.event.server.ServerTickEndEvent;
import org.bukkit.Bukkit;
import org.bukkit.Chunk;
import org.bukkit.GameRule;
import org.bukkit.Location;
import org.bukkit.Material;
import org.bukkit.World;
import org.bukkit.block.Block;
import org.bukkit.block.BlockFace;
import org.bukkit.block.BlockState;
import org.bukkit.block.Container;
import org.bukkit.block.data.FaceAttachable;
import org.bukkit.block.data.Levelled;
import org.bukkit.block.data.Lightable;
import org.bukkit.block.data.type.Chest;
import org.bukkit.block.data.type.Hopper;
import org.bukkit.block.data.type.Piston;
import org.bukkit.block.data.type.Switch;
import org.bukkit.command.CommandSender;
import org.bukkit.entity.Entity;
import org.bukkit.entity.EntityType;
import org.bukkit.entity.minecart.HopperMinecart;
import org.bukkit.entity.Item;
import org.bukkit.entity.minecart.StorageMinecart;
import org.bukkit.event.EventHandler;
import org.bukkit.event.Listener;
import org.bukkit.inventory.Inventory;
import org.bukkit.inventory.InventoryHolder;
import org.bukkit.inventory.ItemStack;
import org.bukkit.plugin.java.JavaPlugin;
import org.bukkit.scheduler.BukkitRunnable;
import org.bukkit.util.Vector;

import net.kyori.adventure.text.serializer.plain.PlainTextComponentSerializer;

import java.nio.file.Path;
import java.util.ArrayList;
import java.util.Collections;
import java.util.HashMap;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.concurrent.atomic.AtomicReference;
import java.util.function.BiConsumer;
import java.util.function.Consumer;
import java.util.function.Supplier;
import java.util.regex.Matcher;
import java.util.regex.Pattern;

/**
 * Hopper idle sleep parity test: contraptions that put hoppers to sleep and then wake them in every way the feature has to
 * catch. Every container is read once per tick and logged whenever its contents change, so two servers can be compared tick
 * by tick. The containers are read from block snapshots: opening the live Bukkit inventory of a container wakes the hoppers
 * around it, which would hide the feature. No listener for the hopper events may be registered either, they switch it off.
 * Nothing in the contraptions depends on the random number generator, so even two Paper runs produce the same logs.
 */
final class HopperTest implements Listener {
    static final String WORLD = "harness_hoppers";
    static final int FLOOR_Y = 99;
    static final int Y = FLOOR_Y + 1;
    private static final int ROW_Z = 8;
    private static final int SPOT_SPACING_CHUNKS = 4;
    private static final int DROP_INTERVAL = 97;
    private static final int TICKING_TIMEOUT_TICKS = 600;
    private static final int SLEEPING_SAMPLE_TICKS = 20;
    private static final Pattern SLEEPING = Pattern.compile(WORLD + ": (\\d+) sleeping");

    private final HarnessPlugin plugin;
    private final Path outDir;
    private final int totalTicks;
    private final boolean kodama = isKodama();
    private final Map<String, Object> result = new LinkedHashMap<>();
    private final List<Scenario> scenarios = new ArrayList<>();
    private final Map<Integer, List<Runnable>> actions = new HashMap<>();
    private final List<Def> defs = List.of(
            new Def("chain", "Chest -> 5 hoppers -> chest", this::chain),
            new Def("full-chest-api", "Hopper facing a full chest, items removed through the API", this::fullChestApi),
            new Def("full-chest-drain", "Hopper facing a full chest, drained by a second hopper", this::fullChestDrain),
            new Def("empty-chest-side-feed", "Empty chest over a hopper, a side hopper starts feeding it", this::emptyChestSideFeed),
            new Def("item-drop", "Item stacks dropped above a hopper", this::itemDrop),
            new Def("item-piston", "Item beside a hopper pushed into its suck area by a piston", this::itemPiston),
            new Def("item-flight", "Item thrown from outside the suck area into it", this::itemFlight),
            new Def("item-far", "Items lying 3 blocks away, one removed, one stays", this::itemFar),
            new Def("double-chest-partner", "Double chest over a hopper filled through the other half", this::doubleChestPartner),
            new Def("minecart-above", "Chest minecart appears above a hopper", this::minecartAbove),
            new Def("hopper-minecart-above", "Hopper minecart appears above a hopper", this::hopperMinecartAbove),
            new Def("minecart-front", "Chest minecart appears in front of a hopper", this::minecartFront),
            new Def("redstone-lock", "Hopper locked by a lever, unlocked and locked again", this::redstoneLock),
            new Def("composter", "Hopper into a composter, hopper below collects bone meal", this::composter),
            new Def("furnace", "Hoppers feeding and emptying a furnace", this::furnace));

    private World world;
    private boolean running;
    private boolean finished;
    private int tick;
    private int hoppers;
    private int sleepingMax;
    private int sleepingLast = -1;

    HopperTest(HarnessPlugin plugin, Path outDir, int totalTicks) {
        this.plugin = plugin;
        this.outDir = outDir;
        this.totalTicks = totalTicks;
    }

    void begin() {
        world = TrapTower.createVoidWorld(WORLD);
        world.setGameRule(GameRule.DO_DAYLIGHT_CYCLE, false);
        world.setGameRule(GameRule.DO_WEATHER_CYCLE, false);
        world.setGameRule(GameRule.DO_MOB_SPAWNING, false);
        world.setGameRule(GameRule.RANDOM_TICK_SPEED, 0);
        result.put("kodama", kodama);
        result.put("world", WORLD);
        result.put("ticks", totalTicks);
        List<int[]> chunks = new ArrayList<>();
        for (int i = 0; i < defs.size(); i++) {
            chunks.add(new int[] {i * SPOT_SPACING_CHUNKS, 0});
        }
        forceLoad(world, chunks);
        awaitTicking(plugin, world, chunks, this::start, message -> {
            result.put("error", message);
            finish();
        });
    }

    private void start() {
        try {
            for (int i = 0; i < defs.size(); i++) {
                Def def = defs.get(i);
                Scenario scenario = new Scenario(def.id, def.title);
                scenarios.add(scenario);
                Spot spot = new Spot(i * SPOT_SPACING_CHUNKS);
                spot.floor();
                def.build.accept(scenario, spot);
            }
            result.put("hoppers", hoppers);
            sample();
            running = true;
            Bukkit.getPluginManager().registerEvents(this, plugin);
        } catch (Throwable t) {
            result.put("error", describe(t));
            finish();
        }
    }

    @EventHandler
    public void onTickEnd(ServerTickEndEvent e) {
        if (!running || finished) {
            return;
        }
        try {
            tick++;
            sample();
            List<Runnable> due = actions.remove(tick);
            if (due != null) {
                due.forEach(Runnable::run);
            }
            if (kodama && tick % SLEEPING_SAMPLE_TICKS == 0) {
                sampleSleeping();
            }
            if (tick >= totalTicks) {
                finish();
            }
        } catch (Throwable t) {
            result.put("error", describe(t));
            finish();
        }
    }

    private void sample() {
        for (Scenario scenario : scenarios) {
            for (Watch watch : scenario.watches) {
                String now = watch.read.get();
                if (!now.equals(watch.last)) {
                    watch.last = now;
                    watch.log.add(List.of(tick, now));
                }
            }
        }
    }

    private void sampleSleeping() {
        Matcher m = SLEEPING.matcher(command("kodama status"));
        sleepingLast = m.find() ? Integer.parseInt(m.group(1)) : -1;
        sleepingMax = Math.max(sleepingMax, sleepingLast);
    }

    private void finish() {
        if (finished) {
            return;
        }
        finished = true;
        List<Object> out = new ArrayList<>();
        for (Scenario scenario : scenarios) {
            Map<String, Object> entry = new LinkedHashMap<>();
            entry.put("id", scenario.id);
            entry.put("title", scenario.title);
            entry.put("trigger", scenario.trigger);
            entry.put("notes", scenario.notes);
            Map<String, Object> containers = new LinkedHashMap<>();
            for (Watch watch : scenario.watches) {
                containers.put(watch.name, watch.log);
            }
            entry.put("containers", containers);
            out.add(entry);
        }
        result.put("scenarios", out);
        result.put("sleepingMax", sleepingMax);
        result.put("sleepingLast", sleepingLast);
        try {
            Json.write(outDir.resolve("hoppers.json"), result);
        } catch (Exception e) {
            plugin.getLogger().warning("Cannot write the hopper result: " + e);
        }
        Bukkit.shutdown();
    }

    // Contraptions. Local x runs along the row of the spot, dy is the height over the floor.

    private void chain(Scenario s, Spot p) {
        Material[] kinds = {Material.COBBLESTONE, Material.DIRT, Material.SAND, Material.GRAVEL, Material.OAK_PLANKS,
                Material.BRICK, Material.STICK, Material.COAL, Material.IRON_INGOT, Material.GOLD_INGOT};
        ItemStack[] stacks = new ItemStack[kinds.length];
        for (int i = 0; i < kinds.length; i++) {
            stacks[i] = new ItemStack(kinds[i], 2 + i % 3);
        }
        Block source = p.at(4, 1);
        chest(source, BlockFace.SOUTH, Chest.Type.SINGLE);
        fill(source, stacks);
        Block output = p.at(9, 0);
        chest(output, BlockFace.SOUTH, Chest.Type.SINGLE);
        watch(s, "source chest", source);
        for (int i = 0; i < 5; i++) {
            Block hopper = p.at(4 + i, 0);
            hopper(hopper, BlockFace.EAST);
            watch(s, "hopper " + (i + 1), hopper);
        }
        watch(s, "output chest", output);
    }

    private void fullChestApi(Scenario s, Spot p) {
        Block full = p.at(7, 0);
        chest(full, BlockFace.SOUTH, Chest.Type.SINGLE);
        fill(full, new ItemStack(Material.STONE, 64 * 27));
        Block hopper = p.at(6, 0);
        hopper(hopper, BlockFace.EAST);
        fill(hopper, new ItemStack(Material.STONE, 5), new ItemStack(Material.DIRT, 5));
        watch(s, "hopper", hopper);
        watch(s, "full chest", full);
        s.trigger = 400;
        at(400, () -> ((Container) full.getState()).getInventory().removeItem(new ItemStack(Material.STONE, 128)));
    }

    private void fullChestDrain(Scenario s, Spot p) {
        Block full = p.at(7, 1);
        chest(full, BlockFace.SOUTH, Chest.Type.SINGLE);
        fill(full, new ItemStack(Material.STONE, 64 * 27));
        Block drain = p.at(7, 0);
        hopper(drain, BlockFace.EAST);
        Block lock = p.at(7, 0, 1);
        lock(s, lock, drain);
        Block collected = p.at(8, 0);
        chest(collected, BlockFace.SOUTH, Chest.Type.SINGLE);
        Block hopper = p.at(6, 1);
        hopper(hopper, BlockFace.EAST);
        fill(hopper, new ItemStack(Material.STONE, 5), new ItemStack(Material.DIRT, 5));
        watch(s, "hopper", hopper);
        watch(s, "full chest", full);
        watch(s, "drain hopper", drain);
        watch(s, "collected chest", collected);
        s.trigger = 400;
        at(400, () -> lock.setType(Material.AIR, true));
    }

    private void emptyChestSideFeed(Scenario s, Spot p) {
        Block chest = p.at(6, 1);
        chest(chest, BlockFace.SOUTH, Chest.Type.SINGLE);
        Block output = p.at(7, 0);
        chest(output, BlockFace.SOUTH, Chest.Type.SINGLE);
        Block hopper = p.at(6, 0);
        hopper(hopper, BlockFace.EAST);
        Block sourceChest = p.at(5, 2);
        chest(sourceChest, BlockFace.SOUTH, Chest.Type.SINGLE);
        fill(sourceChest, new ItemStack(Material.COBBLESTONE, 6), new ItemStack(Material.DIRT, 6));
        Block side = p.at(5, 1);
        hopper(side, BlockFace.EAST);
        Block lock = p.at(5, 1, 1);
        lock(s, lock, side);
        watch(s, "source chest", sourceChest);
        watch(s, "side hopper", side);
        watch(s, "empty chest", chest);
        watch(s, "hopper", hopper);
        watch(s, "output chest", output);
        s.trigger = 300;
        at(300, () -> lock.setType(Material.AIR, true));
    }

    private void itemDrop(Scenario s, Spot p) {
        Block collected = p.at(7, 0);
        chest(collected, BlockFace.SOUTH, Chest.Type.SINGLE);
        Block hopper = p.at(6, 0);
        hopper(hopper, BlockFace.EAST);
        watch(s, "hopper", hopper);
        watch(s, "chest", collected);
        s.trigger = DROP_INTERVAL;
        dropEvery(p.center(6.5, 2.5), new ItemStack(Material.COBBLESTONE, 5));
    }

    private void itemPiston(Scenario s, Spot p) {
        Block collected = p.at(7, 0);
        chest(collected, BlockFace.SOUTH, Chest.Type.SINGLE);
        Block hopper = p.at(6, 0);
        hopper(hopper, BlockFace.EAST);
        p.at(5, 0).setType(Material.STONE, false);
        Block piston = p.at(4, 1);
        piston.setType(Material.PISTON, false);
        Piston data = (Piston) piston.getBlockData();
        data.setFacing(BlockFace.EAST);
        piston.setBlockData(data, false);
        Block power = p.at(4, 2);
        watch(s, "hopper", hopper);
        watch(s, "chest", collected);
        at(10, () -> drop(p.center(5.5, 1.5), new ItemStack(Material.COBBLESTONE, 3)));
        s.trigger = 500;
        at(500, () -> power.setType(Material.REDSTONE_BLOCK, true));
        at(520, () -> s.notes.put("pistonExtended", ((Piston) piston.getBlockData()).isExtended()));
    }

    private void itemFlight(Scenario s, Spot p) {
        Block collected = p.at(7, 0);
        chest(collected, BlockFace.SOUTH, Chest.Type.SINGLE);
        Block hopper = p.at(6, 0);
        hopper(hopper, BlockFace.EAST);
        watch(s, "hopper", hopper);
        watch(s, "chest", collected);
        // Starts 3 blocks away and above the suck area, and flies into it. Only an item in the air moves every tick.
        s.trigger = 500;
        at(500, () -> drop(p.center(9.2, 2.5), new ItemStack(Material.COBBLESTONE, 3), new Vector(-0.35, 0.1, 0)));
    }

    private void itemFar(Scenario s, Spot p) {
        Block collected = p.at(7, 0);
        chest(collected, BlockFace.SOUTH, Chest.Type.SINGLE);
        Block hopper = p.at(6, 0);
        hopper(hopper, BlockFace.EAST);
        watch(s, "hopper", hopper);
        watch(s, "chest", collected);
        AtomicReference<Item> removed = new AtomicReference<>();
        at(300, () -> removed.set(drop(p.center(9.5, 1.5), new ItemStack(Material.DIRT, 2))));
        s.trigger = 700;
        at(700, () -> removed.get().remove());
        dropEvery(p.center(6.5, 2.5), new ItemStack(Material.COBBLESTONE, 5));
        at(1000, () -> drop(p.center(9.5, 1.5), new ItemStack(Material.DIRT, 2)));
    }

    private void doubleChestPartner(Scenario s, Spot p) {
        // Facing south, the right half is the first half of the combined inventory and takes what a hopper inserts; the hopper
        // under the left half only sees it through the partner.
        Block first = p.at(6, 1);
        Block second = p.at(7, 1);
        chest(first, BlockFace.SOUTH, Chest.Type.RIGHT);
        chest(second, BlockFace.SOUTH, Chest.Type.LEFT);
        s.notes.put("doubleChestSize", ((Container) second.getState()).getInventory().getSize());
        Block output = p.at(8, 0);
        chest(output, BlockFace.SOUTH, Chest.Type.SINGLE);
        Block hopper = p.at(7, 0);
        hopper(hopper, BlockFace.EAST);
        Block sourceChest = p.at(5, 2);
        chest(sourceChest, BlockFace.SOUTH, Chest.Type.SINGLE);
        fill(sourceChest, new ItemStack(Material.COBBLESTONE, 4), new ItemStack(Material.DIRT, 4));
        Block feeder = p.at(5, 1);
        hopper(feeder, BlockFace.EAST);
        Block lock = p.at(5, 1, 1);
        lock(s, lock, feeder);
        watch(s, "source chest", sourceChest);
        watch(s, "feeder hopper", feeder);
        watch(s, "chest half (first)", first);
        watch(s, "chest half (over the hopper)", second);
        watch(s, "hopper", hopper);
        watch(s, "output chest", output);
        s.trigger = 500;
        at(500, () -> lock.setType(Material.AIR, true));
    }

    private void minecartAbove(Scenario s, Spot p) {
        Block collected = p.at(7, 0);
        chest(collected, BlockFace.SOUTH, Chest.Type.SINGLE);
        Block hopper = p.at(6, 0);
        hopper(hopper, BlockFace.EAST);
        AtomicReference<Entity> cart = new AtomicReference<>();
        watch(s, "hopper", hopper);
        watch(s, "chest", collected);
        watch(s, "chest minecart", entityContents(cart));
        s.trigger = 600;
        at(600, () -> {
            StorageMinecart minecart = (StorageMinecart) world.spawnEntity(p.center(6.5, 1.0), EntityType.CHEST_MINECART);
            minecart.getInventory().addItem(new ItemStack(Material.COBBLESTONE, 4), new ItemStack(Material.DIRT, 4));
            cart.set(minecart);
        });
    }

    private void hopperMinecartAbove(Scenario s, Spot p) {
        Block collected = p.at(7, 0);
        chest(collected, BlockFace.SOUTH, Chest.Type.SINGLE);
        Block hopper = p.at(6, 0);
        hopper(hopper, BlockFace.EAST);
        AtomicReference<Entity> cart = new AtomicReference<>();
        watch(s, "hopper", hopper);
        watch(s, "chest", collected);
        watch(s, "hopper minecart", entityContents(cart));
        s.trigger = 600;
        at(600, () -> {
            HopperMinecart minecart = (HopperMinecart) world.spawnEntity(p.center(6.5, 1.0), EntityType.HOPPER_MINECART);
            minecart.getInventory().addItem(new ItemStack(Material.COBBLESTONE, 4), new ItemStack(Material.DIRT, 4));
            cart.set(minecart);
        });
    }

    private void minecartFront(Scenario s, Spot p) {
        Block sourceChest = p.at(6, 1);
        chest(sourceChest, BlockFace.SOUTH, Chest.Type.SINGLE);
        fill(sourceChest, new ItemStack(Material.COBBLESTONE, 4), new ItemStack(Material.DIRT, 4));
        Block hopper = p.at(6, 0);
        hopper(hopper, BlockFace.EAST);
        AtomicReference<Entity> cart = new AtomicReference<>();
        watch(s, "source chest", sourceChest);
        watch(s, "hopper", hopper);
        watch(s, "chest minecart", entityContents(cart));
        s.trigger = 600;
        at(600, () -> cart.set(world.spawnEntity(p.center(7.5, 0.0), EntityType.CHEST_MINECART)));
    }

    private void redstoneLock(Scenario s, Spot p) {
        Block sourceChest = p.at(6, 1);
        chest(sourceChest, BlockFace.SOUTH, Chest.Type.SINGLE);
        fill(sourceChest, new ItemStack(Material.COBBLESTONE, 64), new ItemStack(Material.DIRT, 56));
        Block collected = p.at(7, 0);
        chest(collected, BlockFace.SOUTH, Chest.Type.SINGLE);
        Block hopper = p.at(6, 0);
        hopper(hopper, BlockFace.EAST);
        Block lever = p.at(5, 0);
        lever.setType(Material.LEVER, false);
        Switch data = (Switch) lever.getBlockData();
        data.setAttachedFace(FaceAttachable.AttachedFace.FLOOR);
        data.setFacing(BlockFace.EAST);
        data.setPowered(true);
        lever.setBlockData(data, true);
        s.notes.put("lockedAtStart", !((Hopper) hopper.getBlockData()).isEnabled());
        watch(s, "source chest", sourceChest);
        watch(s, "hopper", hopper);
        watch(s, "chest", collected);
        s.trigger = 200;
        at(200, () -> setLever(lever, false));
        at(900, () -> setLever(lever, true));
    }

    private void composter(Scenario s, Spot p) {
        Block sourceChest = p.at(6, 2);
        chest(sourceChest, BlockFace.SOUTH, Chest.Type.SINGLE);
        // Pumpkin pie always composts, so the level does not depend on the random number generator.
        fill(sourceChest, new ItemStack(Material.PUMPKIN_PIE, 7), new ItemStack(Material.PUMPKIN_PIE, 7), new ItemStack(Material.PUMPKIN_PIE, 7));
        Block composter = p.at(7, 1);
        composter.setType(Material.COMPOSTER, false);
        Block collected = p.at(8, 0);
        chest(collected, BlockFace.SOUTH, Chest.Type.SINGLE);
        Block input = p.at(6, 1);
        hopper(input, BlockFace.EAST);
        Block output = p.at(7, 0);
        hopper(output, BlockFace.EAST);
        watch(s, "source chest", sourceChest);
        watch(s, "input hopper", input);
        watch(s, "composter", composter);
        watch(s, "output hopper", output);
        watch(s, "collected chest", collected);
    }

    private void furnace(Scenario s, Spot p) {
        Block smeltables = p.at(7, 3);
        chest(smeltables, BlockFace.SOUTH, Chest.Type.SINGLE);
        fill(smeltables, new ItemStack(Material.SAND, 10));
        Block fuel = p.at(6, 2);
        chest(fuel, BlockFace.SOUTH, Chest.Type.SINGLE);
        fill(fuel, new ItemStack(Material.COAL, 3));
        Block furnace = p.at(7, 1);
        furnace.setType(Material.FURNACE, false);
        Block collected = p.at(8, 0);
        chest(collected, BlockFace.SOUTH, Chest.Type.SINGLE);
        Block input = p.at(7, 2);
        hopper(input, BlockFace.DOWN);
        Block fuelHopper = p.at(6, 1);
        hopper(fuelHopper, BlockFace.EAST);
        Block output = p.at(7, 0);
        hopper(output, BlockFace.EAST);
        watch(s, "smeltables chest", smeltables);
        watch(s, "input hopper", input);
        watch(s, "fuel chest", fuel);
        watch(s, "fuel hopper", fuelHopper);
        watch(s, "furnace", furnace);
        watch(s, "output hopper", output);
        watch(s, "collected chest", collected);
    }

    // Building blocks

    private void chest(Block block, BlockFace facing, Chest.Type type) {
        block.setType(Material.CHEST, false);
        Chest data = (Chest) block.getBlockData();
        data.setFacing(facing);
        data.setType(type);
        block.setBlockData(data, false);
    }

    private void hopper(Block block, BlockFace facing) {
        block.setType(Material.HOPPER, false);
        Hopper data = (Hopper) block.getBlockData();
        data.setFacing(facing);
        block.setBlockData(data, true);
        hoppers++;
    }

    /** The signal has to arrive after the hopper exists: a hopper only reads its power when a neighbour changes. */
    private static void lock(Scenario scenario, Block redstoneBlock, Block hopper) {
        redstoneBlock.setType(Material.REDSTONE_BLOCK, true);
        scenario.notes.put("lockedAtStart", !((Hopper) hopper.getBlockData()).isEnabled());
    }

    private static void fill(Block block, ItemStack... stacks) {
        ((Container) block.getState()).getInventory().addItem(stacks);
    }

    private static void setLever(Block lever, boolean powered) {
        Switch data = (Switch) lever.getBlockData();
        data.setPowered(powered);
        lever.setBlockData(data, true);
    }

    private Item drop(Location at, ItemStack stack) {
        return drop(at, stack, new Vector(0, 0, 0));
    }

    private Item drop(Location at, ItemStack stack, Vector velocity) {
        // A resting item only moves every fourth tick, at a phase given by its entity id, which differs between runs.
        // Dropping again until the id is a multiple of 4 fixes the phase; the random velocity of a new item is replaced too.
        for (int attempt = 0; attempt < 8; attempt++) {
            Item item = world.dropItem(at, stack.clone(), i -> i.setVelocity(velocity));
            if (item.getEntityId() % 4 == 0) {
                return item;
            }
            item.remove();
        }
        throw new IllegalStateException("no item entity with an id divisible by 4");
    }

    private void dropEvery(Location at, ItemStack stack) {
        for (int t = DROP_INTERVAL; t < totalTicks; t += DROP_INTERVAL) {
            at(t, () -> drop(at, stack.clone()));
        }
    }

    private void at(int tick, Runnable action) {
        actions.computeIfAbsent(tick, k -> new ArrayList<>()).add(action);
    }

    private void watch(Scenario scenario, String name, Block block) {
        watch(scenario, name, () -> contents(block));
    }

    private void watch(Scenario scenario, String name, Supplier<String> read) {
        scenario.watches.add(new Watch(name, read));
    }

    private static Supplier<String> entityContents(AtomicReference<Entity> ref) {
        return () -> {
            Entity entity = ref.get();
            if (entity == null) {
                return "absent";
            }
            return entity.isValid() ? items(((InventoryHolder) entity).getInventory()) : "removed";
        };
    }

    private static String contents(Block block) {
        if (block.getBlockData() instanceof Levelled levelled) {
            return "level " + levelled.getLevel();
        }
        // A snapshot has no level, so reading it does not look like a plugin touching the container
        if (block.getState() instanceof Container container) {
            String items = items(container.getSnapshotInventory());
            return block.getBlockData() instanceof Lightable lightable ? (lightable.isLit() ? "lit " : "unlit ") + items : items;
        }
        return block.getType().name();
    }

    private static String items(Inventory inventory) {
        StringBuilder out = new StringBuilder();
        ItemStack[] stacks = inventory.getContents();
        for (int i = 0; i < stacks.length; i++) {
            if (stacks[i] != null && !stacks[i].getType().isAir()) {
                out.append(i).append(':').append(stacks[i].getType().name()).append('x').append(stacks[i].getAmount()).append(' ');
            }
        }
        return out.isEmpty() ? "empty" : out.toString().trim();
    }

    // Shared with the benchmark

    static void forceLoad(World world, List<int[]> chunks) {
        // Nobody is online, so only force loaded chunks are in the ticking range
        for (int[] chunk : chunks) {
            world.setChunkForceLoaded(chunk[0], chunk[1], true);
            world.getChunkAt(chunk[0], chunk[1]);
        }
    }

    /** Hoppers only tick in entity ticking chunks, and building must not begin before they all are, or the first tick would differ. */
    static void awaitTicking(JavaPlugin plugin, World world, List<int[]> chunks, Runnable ready, Consumer<String> failed) {
        new BukkitRunnable() {
            private int waited;

            @Override
            public void run() {
                boolean all = true;
                for (int[] chunk : chunks) {
                    all &= world.getChunkAt(chunk[0], chunk[1]).getLoadLevel() == Chunk.LoadLevel.ENTITY_TICKING;
                }
                if (all) {
                    cancel();
                    ready.run();
                } else if (++waited >= TICKING_TIMEOUT_TICKS) {
                    cancel();
                    failed.accept("chunks are not entity ticking after " + waited + " ticks");
                }
            }
        }.runTaskTimer(plugin, 1L, 1L);
    }

    static String command(String command) {
        List<String> lines = Collections.synchronizedList(new ArrayList<>());
        CommandSender sender = Bukkit.createCommandSender(m -> lines.add(PlainTextComponentSerializer.plainText().serialize(m)));
        try {
            Bukkit.dispatchCommand(sender, command);
        } catch (Throwable t) {
            lines.add("threw " + describe(t));
        }
        return String.join("\n", lines);
    }

    static boolean isKodama() {
        try {
            Class.forName("dev.kodama.hopper.HopperSleep");
            return true;
        } catch (ClassNotFoundException e) {
            return false;
        }
    }

    static String describe(Throwable t) {
        return t.getClass().getName() + ": " + t.getMessage();
    }

    private record Def(String id, String title, BiConsumer<Scenario, Spot> build) {}

    private static final class Scenario {
        final String id;
        final String title;
        final List<Watch> watches = new ArrayList<>();
        final Map<String, Object> notes = new LinkedHashMap<>();
        Integer trigger;

        Scenario(String id, String title) {
            this.id = id;
            this.title = title;
        }
    }

    private static final class Watch {
        final String name;
        final Supplier<String> read;
        final List<List<Object>> log = new ArrayList<>();
        String last;

        Watch(String name, Supplier<String> read) {
            this.name = name;
            this.read = read;
        }
    }

    /** One chunk of the void world with its own floor; contraptions stay clear of the chunk edge so every chunk a hopper looks into is loaded. */
    private final class Spot {
        private final int baseX;

        Spot(int chunkX) {
            this.baseX = chunkX * 16;
        }

        void floor() {
            for (int x = 0; x < 16; x++) {
                for (int z = 0; z < 16; z++) {
                    world.getBlockAt(baseX + x, FLOOR_Y, z).setType(Material.STONE, false);
                }
            }
        }

        Block at(int lx, int dy) {
            return at(lx, dy, 0);
        }

        Block at(int lx, int dy, int dz) {
            return world.getBlockAt(baseX + lx, Y + dy, ROW_Z + dz);
        }

        Location center(double lx, double dy) {
            return new Location(world, baseX + lx, Y + dy, ROW_Z + 0.5);
        }
    }
}
