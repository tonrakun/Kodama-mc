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

## Working with patches

- `kodama-api/` and `kodama-server/` are generated from `patches/` and are not tracked.
- Commit changes inside `kodama-server/` (or `kodama-api/`), then run `./gradlew rebuildPatches`
  to write them back to `patches/`.
- Patches imported from other forks (e.g. Leaf) are kept as the original patch, with the source
  and its license stated in the patch header.

Useful tasks: `applyPatches`, `rebuildPatches`, `runDev`, `createMojmapPaperclipJar`.

## License

See [LICENSE.md](LICENSE.md).
