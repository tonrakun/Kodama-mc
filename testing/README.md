# Kodama testing tools

- `bench/` - Node.js runner: Paper vs Kodama benchmark with mineflayer bots, and the vanilla-parity driver.
- `vanilla-diff/compare_worlds.py` - chunk-by-chunk Anvil comparer (Python 3, stdlib only).
- `harness-plugin/` - server plugin that pre-generates worlds and records metrics (driven by `-Dkodama.harness.*`).

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

## compare_worlds.py

```sh
python testing/vanilla-diff/compare_worlds.py <serverDirA> <serverDirB> [--dims overworld,nether,end] [--radius N] [--json out.json] [--max-examples 20] [--jobs N]
python testing/vanilla-diff/compare_worlds.py --self-test
```

Compares only chunks with status `full` in both worlds (block states and biomes decoded per block, structures,
block entities, heightmaps) and reports chunks that are full in only one of them. Light, tick lists, timestamps and
upgrade data are ignored. Exit code 0 means identical, 1 means differences.
