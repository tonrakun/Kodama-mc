import { parseArgs } from 'node:util';
import { runBench } from './bench.js';
import { runVanilla } from './vanilla.js';

const USAGE = `Usage: node src/cli.js <command> [options]

Commands:
  bench     Paper vs Kodama performance benchmark with a bot swarm
  vanilla   Chunk generation parity check (Paper vs Kodama)

Common options:
  --java <path>              Java executable (default: JAVA_HOME, then 'java')
  --heap <size>              JVM heap, -Xms/-Xmx (bench: 10G, vanilla: 4G)
  --jvm-args "<args>"        Extra JVM arguments, whitespace separated
  --port <n>                 Server port (25600)
  --view-distance <n>        (10)
  --simulation-distance <n>  (10)

bench options:
  --server paper|kodama|both Servers to run, sequentially (both)
  --bots <n>                 (10)
  --pattern settler|explorer|mixed (mixed)
  --duration <s>             Measured seconds (120)
  --warmup <s>               (30)
  --seed <string>            World seed (kodama)
  --pregen-radius <chunks>   Radius of the cached pre-generated world (24)
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
`;

const options = {
  help: { type: 'boolean', short: 'h' },
  java: { type: 'string' },
  heap: { type: 'string' },
  'jvm-args': { type: 'string' },
  port: { type: 'string', default: '25600' },
  'view-distance': { type: 'string', default: '10' },
  'simulation-distance': { type: 'string', default: '10' },
  server: { type: 'string', default: 'both' },
  bots: { type: 'string', default: '10' },
  pattern: { type: 'string', default: 'mixed' },
  duration: { type: 'string', default: '120' },
  warmup: { type: 'string', default: '30' },
  seed: { type: 'string', default: 'kodama' },
  'pregen-radius': { type: 'string', default: '24' },
  'explorer-speed': { type: 'string', default: '30' },
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
};

function number(values, name, { min = 0, integer = true } = {}) {
  const n = Number(values[name]);
  if (!Number.isFinite(n) || n < min || (integer && !Number.isInteger(n))) {
    throw new Error(`--${name} must be ${integer ? 'an integer' : 'a number'} >= ${min} (got '${values[name]}')`);
  }
  return n;
}

function commonOptions(v, defaultHeap) {
  return {
    java: v.java,
    heap: v.heap ?? defaultHeap,
    jvmArgs: v['jvm-args'] ? v['jvm-args'].split(/\s+/).filter(Boolean) : [],
    port: number(v, 'port', { min: 1 }),
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
      explorerSpeed: number(values, 'explorer-speed', { min: 0, integer: false }),
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
