# Kodama

An adaptive Minecraft server software based on [Paper](https://github.com/PaperMC/Paper),
aiming for full Spigot / Paper plugin compatibility.

The design document is in [`.docs/design.md`](.docs/design.md) (Japanese).

## Supported versions

| Minecraft | Upstream |
|---|---|
| 1.20.6 | Paper build 151 (`a4f0f5cc`) |

Versions are advanced in large steps, following the versions commonly used by servers.

## Building

Requires JDK 21 and Git.

```sh
./gradlew applyPatches
./gradlew createMojmapPaperclipJar
```

The server jar is written to `build/libs/kodama-paperclip-<version>-mojmap.jar`.

## Features

Everything is configured in `config/kodama-global.yml` and `config/kodama-world-defaults.yml` (per world:
`<world>/kodama-world.yml`). `preset: safe | balanced | aggressive` picks the defaults; `safe` keeps every vanilla
behavior. Options can be changed in game with `/kodama config set`, `/kodama gui` and `/kodama reload`.
A feature that keeps throwing exceptions is switched off on its own while the server keeps running.

| Area | What it does | Config |
|---|---|---|
| Chunk loading | Loads chunks in the direction a player moves first, keeps chunks behind the player loaded for a while, prefetches ahead of fast players and ender pearls, adapts to settlers, commuters and explorers, spreads the start of chunk ticking over several ticks | `chunk-loading.*` |
| Chunk packets | Shares one chunk packet between the players it is sent to (off while ProtocolLib or PacketEvents is enabled) | `chunk-loading.packet-cache` |
| Pre-generation | Generates chunks around spawn and where players go while nobody is online | `precache.*`, `/kodama precache` |
| Mob level of detail | Mobs far from players think less often; anything a plugin does with a mob's AI brings it back to full detail at once | `mob-lod.*` (world), `/kodama lod` |
| Network | Holds back chunk packets and compresses harder for players whose connection cannot keep up | `network.*` |
| Redstone | Reports chunks that run heavy clocks and lets admins switch single chunks to Alternate Current | `redstone.*` (world), `/kodama redstone` |
| Hoppers | Idle hoppers stop searching until something around them changes; items move in the same ticks as without it | `hoppers.*` (world) |
| Background work | Asynchronous pathfinding and mob counting (from Leaf / Pufferfish) | `async.*` |

`/kodama status` shows the state of every feature.

## Running

`scripts/start.sh` (Linux / macOS) and `scripts/start.bat` or `scripts/start.ps1` (Windows) start the
server with the recommended JVM flags. Copy the script next to the server jar.

- `MEMORY` / `-Memory`: heap size (default `4G`)
- `GC` / `-Gc`: `g1` (default, Aikar's flags) or `zgc` (generational ZGC)
- Compact Object Headers are turned on with JDK 24 or newer (JDK 25 is recommended)

## Working with patches

- `kodama-api/` and `kodama-server/` are generated from `patches/` and are not tracked.
- Commit changes inside `kodama-server/` (or `kodama-api/`), then run `./gradlew rebuildPatches`
  to write them back to `patches/`.
- Patches imported from other forks (e.g. Leaf) are kept as the original patch, with the source
  and its license stated in the patch header.

Useful tasks: `applyPatches`, `rebuildPatches`, `runDev`, `createMojmapPaperclipJar`.

## License

See [LICENSE.md](LICENSE.md).
