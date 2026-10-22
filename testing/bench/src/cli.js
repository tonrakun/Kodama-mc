import { parseArgs } from 'node:util';
import { runBench } from './bench.js';
import { runHoppers } from './hoppers.js';
import { runGui } from './gui.js';
import { runPlugins } from './plugins.js';
import { runRedstone } from './redstone.js';
import { runVanilla } from './vanilla.js';

const USAGE = `Usage: node src/cli.js <command> [options]

Commands:
  bench     Paper vs Kodama performance benchmark with a bot swarm
  vanilla   Chunk generation parity check (Paper vs Kodama)
  plugins   Plugin compatibility smoke test (Paper vs Kodama)
  redstone  Redstone monitoring and per-chunk Alternate Current test (Kodama only)
  hoppers   Hopper idle sleep parity test and micro benchmark (Paper vs Kodama)
  gui       In-game config GUI test with bots (Kodama only)

Common options:
  --java <path>              Java executable (default: JAVA_HOME, then 'java')
  --heap <size>              JVM heap, -Xms/-Xmx (bench: 10G, vanilla: 4G, plugins, redstone, gui and hoppers: 2G)
  --jvm-args "<args>"        Extra JVM arguments, whitespace separated
  --port <n>                 Server port (25600, plugins: 25700, redstone: 25750, gui: 25800, hoppers: 25850)
  --view-distance <n>        (10)
  --simulation-distance <n>  (10)

bench options:
  --server paper|kodama|both Servers to run, sequentially (both)
  --bots <n>                 (10)
  --pattern settler|explorer|mixed|afk (mixed); afk bots stand still
  --tower                    Build a trap tower above spawn, night locked, and park the bots next to it
  --slow-tick-ms <ms>        Sample main thread stacks during ticks longer than this (100)
  --duration <s>             Measured seconds (120)
  --warmup <s>               (30)
  --seed <string>            World seed (kodama)
  --pregen-radius <chunks>   Radius of the cached pre-generated world (24)
  --kodama-set key=value     Kodama config override (repeatable), e.g. chunk-loading.prefetch.enabled=false;
                             prefix world. for world defaults, e.g. world.mob-lod.enabled=false
  --explorer-speed <b/s>     Explorer bot speed in blocks/s (30)
  --server-cpus <list>       Server CPU pinning (0-7)
  --bot-cpus <list>          Bot swarm CPU pinning (8-11)
  --no-affinity              Disable CPU pinning
  --fail-on-regression <pct> Exit 1 if Kodama MSPT avg/p99 is worse than Paper by more than pct
  --keep-work                Keep the server directories under testing/.work

vanilla options:
  --seeds <n>                Number of seeds kodama-parity-1..n (5)
  --seed-list a,b            Explicit seeds, overrides --seeds
  --radius <chunks>          Generation radius (100)
  --dims overworld,nether,end
  --python <path>            Python 3 executable (default: python3, then python)
  --keep-worlds              Keep work dirs after a passing seed
  --flavors a,b              Servers to compare (paper,kodama); paper,paper gives a baseline
  --parallel                 Generate with Paper's default worker threads (order-dependent, not comparable)

plugins options:
  --flavors a,b              Servers to run (paper,kodama); the plugins come from bench/plugins.json
  --keep-work                Keep the server directories under testing/.work

gui options:
  --keep-work                Keep the server directory under testing/.work

redstone options:
  --measure <s>              Seconds the clock is measured on the world's implementation (70)
  --follow-up <s>            Seconds measured after each switch (20)
  --keep-work                Keep the server directory under testing/.work

hoppers options:
  --flavors a,b              Servers to compare (paper,kodama); paper,paper gives a baseline
  --ticks <n>                Ticks the parity scenarios run (2400)
  --no-bench                 Skip the micro benchmark
  --bench-hoppers <n>        Idle hoppers in the benchmark (2000)
  --bench-warmup <s>         (20)
  --bench-duration <s>       (60)
  --keep-work                Keep the server directories under testing/.work
`;

const options = {
  help: { type: 'boolean', short: 'h' },
  java: { type: 'string' },
  heap: { type: 'string' },
  'jvm-args': { type: 'string' },
  port: { type: 'string' },
  'view-distance': { type: 'string', default: '10' },
  'simulation-distance': { type: 'string', default: '10' },
  server: { type: 'string', default: 'both' },
  bots: { type: 'string', default: '10' },
  pattern: { type: 'string', default: 'mixed' },
  duration: { type: 'string', default: '120' },
  warmup: { type: 'string', default: '30' },
  seed: { type: 'string', default: 'kodama' },
  'pregen-radius': { type: 'string', default: '24' },
  'kodama-set': { type: 'string', multiple: true },
  'explorer-speed': { type: 'string', default: '30' },
  tower: { type: 'boolean' },
  'slow-tick-ms': { type: 'string', default: '100' },
  'server-cpus': { type: 'string', default: '0-7' },
  'bot-cpus': { type: 'string', default: '8-11' },
  'no-affinity': { type: 'boolean' },
  'fail-on-regression': { type: 'string' },
  'keep-work': { type: 'boolean' },
  seeds: { type: 'string', default: '5' },
  'seed-list': { type: 'string' },
  radius: { type: 'string', default: '100' },
  dims: { type: 'string', default: 'overworld,nether,end' },
  python: { type: 'string' },
  'keep-worlds': { type: 'boolean' },
  flavors: { type: 'string', default: 'paper,kodama' },
  parallel: { type: 'boolean' },
  measure: { type: 'string', default: '70' },
  'follow-up': { type: 'string', default: '20' },
  ticks: { type: 'string', default: '2400' },
  'no-bench': { type: 'boolean' },
  'bench-hoppers': { type: 'string', default: '2000' },
  'bench-warmup': { type: 'string', default: '20' },
  'bench-duration': { type: 'string', default: '60' },
};

function number(values, name, { min = 0, integer = true } = {}) {
  const n = Number(values[name]);
  if (!Number.isFinite(n) || n < min || (integer && !Number.isInteger(n))) {
    throw new Error(`--${name} must be ${integer ? 'an integer' : 'a number'} >= ${min} (got '${values[name]}')`);
  }
  return n;
}

function commonOptions(v, defaultHeap, defaultPort = '25600') {
  return {
    java: v.java,
    heap: v.heap ?? defaultHeap,
    jvmArgs: v['jvm-args'] ? v['jvm-args'].split(/\s+/).filter(Boolean) : [],
    port: number({ port: v.port ?? defaultPort }, 'port', { min: 1 }),
    viewDistance: number(v, 'view-distance', { min: 2 }),
    simulationDistance: number(v, 'simulation-distance', { min: 2 }),
  };
}

async function main() {
  const { values, positionals } = parseArgs({ options, allowPositionals: true, strict: true });
  const command = positionals[0];
  if (values.help || !command) {
    console.log(USAGE);
    return command || values.help ? 0 : 1;
  }

  if (command === 'bench') {
    return runBench({
      ...commonOptions(values, '10G'),
      server: values.server,
      bots: number(values, 'bots', { min: 1 }),
      pattern: values.pattern,
      duration: number(values, 'duration', { min: 1 }),
      warmup: number(values, 'warmup', { min: 0 }),
      seed: values.seed,
      pregenRadius: number(values, 'pregen-radius', { min: 1 }),
      kodamaSet: values['kodama-set'] ?? [],
      explorerSpeed: number(values, 'explorer-speed', { min: 0, integer: false }),
      tower: Boolean(values.tower),
      slowTickMs: number(values, 'slow-tick-ms', { min: 1 }),
      serverCpus: values['server-cpus'],
      botCpus: values['bot-cpus'],
      noAffinity: Boolean(values['no-affinity']),
      failOnRegression: values['fail-on-regression'] === undefined ? null : number(values, 'fail-on-regression', { min: 0, integer: false }),
      keepWork: Boolean(values['keep-work']),
    });
  }
  if (command === 'vanilla') {
    return runVanilla({
      ...commonOptions(values, '4G'),
      seeds: number(values, 'seeds', { min: 1 }),
      seedList: values['seed-list'],
      radius: number(values, 'radius', { min: 2 }),
      dims: values.dims,
      python: values.python,
      keepWorlds: Boolean(values['keep-worlds']),
      flavors: values.flavors,
      parallel: Boolean(values.parallel),
    });
  }
  if (command === 'plugins') {
    return runPlugins({
      ...commonOptions(values, '2G', '25700'),
      flavors: values.flavors,
      keepWork: Boolean(values['keep-work']),
    });
  }
  if (command === 'redstone') {
    return runRedstone({
      ...commonOptions(values, '2G', '25750'),
      measure: number(values, 'measure', { min: 50 }),
      followUp: number(values, 'follow-up', { min: 1 }),
      keepWork: Boolean(values['keep-work']),
    });
  }
  if (command === 'gui') {
    return runGui({
      ...commonOptions(values, '2G', '25800'),
      keepWork: Boolean(values['keep-work']),
    });
  }
  if (command === 'hoppers') {
    return runHoppers({
      ...commonOptions(values, '2G', '25850'),
      flavors: values.flavors,
      ticks: number(values, 'ticks', { min: 400 }),
      bench: !values['no-bench'],
      benchHoppers: number(values, 'bench-hoppers', { min: 1 }),
      benchWarmup: number(values, 'bench-warmup', { min: 0 }),
      benchDuration: number(values, 'bench-duration', { min: 1 }),
      keepWork: Boolean(values['keep-work']),
    });
  }
  console.error(`Unknown command '${command}'\n\n${USAGE}`);
  return 1;
}

main().then(
  (code) => {
    process.exitCode = code;
  },
  (e) => {
    console.error(e.message);
    process.exitCode = 1;
  },
);
