# Kodama testing tools

- `bench/` - Node.js runner: Paper vs Kodama benchmark with mineflayer bots, the vanilla-parity driver, the plugin smoke test and the redstone monitoring test.
- `vanilla-diff/compare_worlds.py` - chunk-by-chunk Anvil comparer (Python 3, stdlib only).
- `harness-plugin/` - server plugin that pre-generates worlds, records metrics and runs the plugin smoke test and the redstone test (driven by `-Dkodama.harness.*`).

Everything runs on Windows (Git Bash / PowerShell) and Linux. Requirements: Node 22+ (CI uses 24), Python 3, a Java 21 runtime.

## Setup

```sh
./gradlew createMojmapPaperclipJar          # Kodama server jar (build/libs)
./gradlew :kodama-harness:jar               # harness plugin (built automatically if missing)
cd testing/bench && npm install
```

The Paper 1.20.6 build 151 jar is downloaded on first use into `testing/.cache/jars/` and checked against its sha256.

## Benchmark

```sh
cd testing/bench
npm run bench -- --bots 10 --duration 120
```

Both servers run sequentially against the same pre-generated world (fixed seed). The world is generated once by Paper
and cached in `testing/.cache/worlds/<seed>-r<radius>/`.

| Option | Default | Meaning |
|---|---|---|
| `--server paper\|kodama\|both` | both | Servers to run |
| `--bots` | 10 | Bot count |
| `--pattern settler\|explorer\|mixed` | mixed | `settler` random-walks around a home point on a 64 block ring; `explorer` flies straight at y=160; `mixed` is half/half |
| `--duration` / `--warmup` | 120 / 30 | Measured and warmup seconds |
| `--seed` | kodama | World seed |
| `--pregen-radius` | 24 | Chunk radius of the cached world |
| `--explorer-speed` | 30 | Explorer speed in blocks/s |
| `--view-distance` / `--simulation-distance` | 10 / 10 | Server settings |
| `--port` | 25600 | Server port |
| `--heap` | 10G | JVM `-Xms`/`-Xmx` |
| `--java` | JAVA_HOME, then `java` | Java executable |
| `--jvm-args` | - | Extra JVM arguments |
| `--server-cpus` / `--bot-cpus` | 0-7 / 8-11 | CPU pinning (`taskset` on Linux, `ProcessorAffinity` on Windows) |
| `--no-affinity` | off | Disable pinning (also disabled automatically with a warning if the machine has too few CPUs) |
| `--fail-on-regression <pct>` | off | Exit 1 if Kodama MSPT avg or p99 is worse than Paper by more than pct (needs `--server both`) |
| `--keep-work` | off | Keep server directories in `testing/.work/` |

Output goes to `testing/results/bench-<timestamp>/`:
`paper/` and `kodama/` (each with `metrics.json`, `bots.json`, `console.log`), `report.json` and `report.md`
(also printed to stdout).

## Vanilla parity

```sh
cd testing/bench
npm run vanilla -- --seeds 5 --radius 100
```

For each seed (`kodama-parity-1..N`, or `--seed-list a,b`) Paper and Kodama generate empty worlds with the harness,
then `compare_worlds.py` compares them. Exit code is 1 if any chunk mismatches.

| Option | Default | Meaning |
|---|---|---|
| `--seeds` | 5 | Number of generated seeds |
| `--seed-list` | - | Explicit comma separated seeds |
| `--radius` | 100 | Generation radius in chunks; chunks on the outermost ring (x or z equal to the radius) are not compared |
| `--dims` | overworld,nether,end | Dimensions |
| `--keep-worlds` | off | Keep work dirs after a passing seed (failing seeds are always kept) |
| `--flavors a,b` | `paper,kodama` | Servers to compare; `paper,paper` is the baseline that validates the method |
| `--parallel` | off | Use Paper's default chunk worker threads (see below) |
| `--python` | python3, then python | Python executable |
| `--heap` | 4G | JVM heap |

By default generation is deterministic: one chunk worker thread and one chunk request at a time.
Features (ores, plants, deltas...) spill into neighbouring chunks, so with parallel generation the result
depends on the order chunks are generated in and even two Paper runs differ.

Output goes to `testing/results/vanilla-<timestamp>/`: `parity.md` and one `compare-<seed>.json` per seed.

## Plugin compatibility

```sh
cd testing/bench
npm run plugins
```

For each flavor a fresh server starts with the plugins from `bench/plugins.json` (LuckPerms, WorldEdit, EssentialsX,
ProtocolLib, ViaVersion), the harness in `smoke` mode and one bot. The bot sends a few plugin commands as chat; the
harness lists the plugins, runs console commands and writes `smoke.json`. On Kodama it also checks that

- a mob in a reduced Mob LOD tier is promoted to NEAR in the same tick by a plugin API call (`Mob#getTarget`), and
- the chunk packet cache is off while ProtocolLib is enabled.

The jars are downloaded into `testing/.cache/plugins/` and checked against the sha512 in `plugins.json`.
Each console.log is scanned for ERROR lines and exception starts, which are normalized and compared between the flavors.

Exit code is 1 if a plugin is enabled on Paper but not on Kodama, a command threw on Kodama but not on Paper,
a Kodama check failed, or there are error lines only in Kodama.

| Option | Default | Meaning |
|---|---|---|
| `--flavors a,b` | `paper,kodama` | Servers to run; comparisons need both |
| `--port` | 25700 | Server port |
| `--heap` | 2G | JVM `-Xms`/`-Xmx` |
| `--view-distance` / `--simulation-distance` | 10 / 10 | Server settings |
| `--java` | JAVA_HOME, then `java` | Java executable |
| `--jvm-args` | - | Extra JVM arguments |
| `--keep-work` | off | Keep server directories in `testing/.work/` |

Output goes to `testing/results/plugins-<timestamp>/`: `paper/` and `kodama/` (each with `smoke.json` and
`console.log`), `report.json` and `report.md` (also printed to stdout).

## Redstone monitoring

```sh
cd testing/bench
npm run redstone
```

Kodama only. Two server runs on the same server directory, with `redstone.notify-updates-per-second=5` in the world defaults.
The harness builds a void world with a two observer clock in chunk A (driving a line of 10 redstone dust into a lamp) and
a single lever pull in chunk B, both force loaded.

Run 1 (`redstone` mode) measures the clock for 70 s, reads `/kodama redstone info` for both chunks and `top`, switches
chunk A to Alternate Current and measures it for 20 s more. Run 2 (`redstone-verify` mode) restarts on the same world and
checks that chunk A still uses Alternate Current and that the clock runs at the same rate, then switches it back to the
world implementation. The checks are

- chunk A is `continuous (clock)`, chunk B is `transient` or idle, `top` lists chunk A first, and the console has the
  "Redstone clock at" warning for chunk A,
- the switch shows in `info` within 15 s, and the clock rate with Alternate Current and after the restart is within 10% of
  the rate on the world implementation,
- the clock still runs after switching back.

The rate is the number of changes per game second of the power of the last dust before the lamp. The lamp itself stays lit,
because it turns off 4 ticks after it lost power and the clock's off phase is shorter.

Exit code is 1 if any check fails.

| Option | Default | Meaning |
|---|---|---|
| `--measure` | 70 | Seconds measured on the world's implementation; the chunk needs 45 active seconds to count as a clock, so keep it at 50 or more |
| `--follow-up` | 20 | Seconds measured after each switch |
| `--port` | 25750 | Server port |
| `--heap` | 2G | JVM `-Xms`/`-Xmx` |
| `--view-distance` / `--simulation-distance` | 10 / 10 | Server settings |
| `--java` | JAVA_HOME, then `java` | Java executable |
| `--jvm-args` | - | Extra JVM arguments |
| `--keep-work` | off | Keep the server directory in `testing/.work/` |

Output goes to `testing/results/redstone-<timestamp>/`: `console-redstone.log` and `console-redstone-verify.log`,
`report.json` and `report.md` (also printed to stdout).

## compare_worlds.py

```sh
python testing/vanilla-diff/compare_worlds.py <serverDirA> <serverDirB> [--dims overworld,nether,end] [--radius N] [--json out.json] [--max-examples 20] [--jobs N]
python testing/vanilla-diff/compare_worlds.py --self-test
```

Compares only chunks with status `full` in both worlds (block states and biomes decoded per block, structures,
block entities, heightmaps) and reports chunks that are full in only one of them. Light, tick lists, timestamps and
upgrade data are ignored. Exit code 0 means identical, 1 means differences.
