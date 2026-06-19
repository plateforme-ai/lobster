import { spawnSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

function shellQuote(arg) {
  // Conservative POSIX-ish quoting for embedding argv into a single pipeline string.
  // Lobster's pipeline parser preserves quoted substrings.
  if (/^[A-Za-z0-9_\-./:=@]+$/.test(arg)) return arg;
  // single-quote, escaping embedded single quotes: ' -> '\''
  return `'${String(arg).replace(/'/g, `'\\''`)}'`;
}

function wantsHelp(argv) {
  return argv.includes('-h') || argv.includes('--help');
}

export function runBin(commandName, argv = process.argv.slice(2)) {
  const lobsterBin = join(__dirname, 'lobster.js');
  const lobsterArgs = wantsHelp(argv)
    ? ['help', commandName]
    : [[commandName, ...argv.map(shellQuote)].join(' ')];

  const res = spawnSync(process.execPath, [lobsterBin, ...lobsterArgs], {
    stdio: 'inherit',
    env: process.env,
  });

  if (res.error) {
    const code = res.error.code ? ` (${res.error.code})` : '';
    process.stderr.write(`${commandName}: failed to launch lobster${code}: ${res.error.message}\n`);
  }

  process.exit(typeof res.status === 'number' ? res.status : 1);
}
