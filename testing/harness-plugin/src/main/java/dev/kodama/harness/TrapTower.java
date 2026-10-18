package dev.kodama.harness;

import org.bukkit.GameRule;
import org.bukkit.Location;
import org.bukkit.Material;
import org.bukkit.World;
import org.bukkit.WorldCreator;
import org.bukkit.generator.ChunkGenerator;
import org.bukkit.entity.Player;

/**
 * A plain mob farm for the trap tower test (design §8): a spawning floor with holes 28 blocks above a landing pad, where
 * falling mobs die, and a waiting spot next to the pad like real farms have: just over 24 blocks from the nearest floor
 * block (so mobs may spawn) and about 35 blocks from its center, i.e. mostly in Mob LOD's mid range.
 */
final class TrapTower {
    private static final int FLOOR_Y = 178;
    private static final int FLOOR_RADIUS = 16;
    private static final int PAD_Y = 150;
    private static final int PAD_RADIUS = 20;
    private static final int STAND_OFFSET_X = 22;

    private final World world;
    private final int cx;
    private final int cz;

    TrapTower(World world) {
        this.world = world;
        Location spawn = world.getSpawnLocation();
        this.cx = spawn.getBlockX();
        this.cz = spawn.getBlockZ();
    }

    /**
     * An empty world, so the tower is the only place mobs can spawn: in a normal world idle mobs in caves fill the
     * mob cap and the tower gets nothing, which tests the terrain rather than the server.
     */
    static World createVoidWorld(String name) {
        World world = new WorldCreator(name).generator(new ChunkGenerator() {
        }).createWorld();
        world.setSpawnLocation(0, PAD_Y + 1, 0);
        return world;
    }

    void build() {
        // Night locked: hostile mobs need darkness and the open floor only gets it at night.
        world.setGameRule(GameRule.DO_DAYLIGHT_CYCLE, false);
        world.setGameRule(GameRule.DO_WEATHER_CYCLE, false);
        world.setStorm(false);
        world.setThundering(false);
        world.setTime(18000);

        fill(cx - PAD_RADIUS, PAD_Y + 1, cz - PAD_RADIUS, cx + PAD_RADIUS, FLOOR_Y + 4, cz + PAD_RADIUS, Material.AIR);
        fill(cx - PAD_RADIUS, PAD_Y, cz - PAD_RADIUS, cx + PAD_RADIUS, PAD_Y, cz + PAD_RADIUS, Material.STONE);
        for (int x = -FLOOR_RADIUS; x <= FLOOR_RADIUS; x++) {
            for (int z = -FLOOR_RADIUS; z <= FLOOR_RADIUS; z++) {
                boolean hole = x % 4 == 0 && z % 4 == 0;
                world.getBlockAt(cx + x, FLOOR_Y, cz + z).setType(hole ? Material.AIR : Material.STONE, false);
            }
        }
        int sx = cx + STAND_OFFSET_X;
        fill(sx - 1, PAD_Y + 1, cz - 1, sx + 1, PAD_Y + 3, cz + 1, Material.AIR);
        fill(sx - 1, PAD_Y, cz - 1, sx + 1, PAD_Y, cz + 1, Material.STONE);
    }

    void park(Player player) {
        player.teleport(new Location(world, cx + STAND_OFFSET_X + 0.5, PAD_Y + 1, cz + 0.5));
    }

    private void fill(int x1, int y1, int z1, int x2, int y2, int z2, Material material) {
        for (int x = x1; x <= x2; x++) {
            for (int y = y1; y <= y2; y++) {
                for (int z = z1; z <= z2; z++) {
                    world.getBlockAt(x, y, z).setType(material, false);
                }
            }
        }
    }
}
