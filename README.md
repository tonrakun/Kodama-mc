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
