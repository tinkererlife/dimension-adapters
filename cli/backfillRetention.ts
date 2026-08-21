import 'dotenv/config';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { isRetentionAdapter, RetentionAdapter, RetentionConfig } from '../helpers/retention';

const RETENTION_ROOT = path.resolve(__dirname, '../retention');

function printUsage() {
  console.info(`Usage:
  npx ts-node --transpile-only cli/backfillRetention.ts <adapter> <to-date>

Arguments:
  adapter       Retention adapter name, for example collector-crypt
  to-date       Last complete UTC date to index, inclusive (YYYY-MM-DD)

The command builds or advances the retention activity index.
Normal adapter fetches only read the index. Production updates should call
indexActivity from the core backend before fetch.`);
}

function acquireLock(project: string, stateVersion: number) {
  const lockPath = path.join(os.tmpdir(), `dimension-adapters-retention-${project}-v${stateVersion}.lock`);

  let fd: number;
  try {
    fd = fs.openSync(lockPath, 'wx');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
    throw new Error(`Activity indexing is already running for ${project}. If it crashed, remove ${lockPath} and retry.`);
  }

  return () => {
    fs.closeSync(fd);
    fs.unlinkSync(lockPath);
  };
}

function loadRetentionModule(projectArg: string): { adapter: RetentionAdapter; config: RetentionConfig } {
  const project = projectArg.replace(/^retention\//, '');
  if (!/^[a-z0-9][a-z0-9-]*$/.test(project))
    throw new Error(`Invalid retention adapter name: ${projectArg}`);

  const folderEntry = path.join(RETENTION_ROOT, project, 'index.ts');
  const fileEntry = path.join(RETENTION_ROOT, `${project}.ts`);
  const modulePath = fs.existsSync(folderEntry) ? folderEntry : fileEntry;
  if (!fs.existsSync(modulePath)) throw new Error(`Retention adapter not found: ${project}`);

  const loaded = require(modulePath);
  const config: RetentionConfig | undefined = loaded.retentionConfig;
  if (!config) throw new Error(`${project} does not export retentionConfig`);
  if (config.project !== project)
    throw new Error(`${project} retentionConfig uses a different project key: ${config.project}`);
  const adapter = loaded.default;
  if (!adapter || !isRetentionAdapter(adapter))
    throw new Error(`${project} does not expose an activity indexer`);
  return { adapter, config };
}

async function main() {
  const [projectArg, toDate] = process.argv.slice(2);
  if (projectArg === '--help' || projectArg === '-h') {
    printUsage();
    return;
  }
  if (!projectArg || !toDate) {
    printUsage();
    throw new Error('Both adapter and to-date are required');
  }
  if (!/^\d{4}-\d{2}-\d{2}$/.test(toDate))
    throw new Error(`Invalid to-date: ${toDate}`);
  const missingEnv = ['DUNE_API_KEYS', 'R2_ENDPOINT', 'R2_ACCESS_KEY_ID', 'R2_SECRET_ACCESS_KEY']
    .filter((key) => !process.env[key]);
  if (missingEnv.length)
    throw new Error(`${missingEnv.join(', ')} ${missingEnv.length === 1 ? 'is' : 'are'} required to publish the activity index`);

  const { adapter, config } = loadRetentionModule(projectArg);

  const releaseLock = acquireLock(config.project, config.stateVersion);
  try {
    console.info(`Indexing retention/${config.project} v${config.stateVersion} through ${toDate}...`);
    const result = await adapter.indexActivity({ toDate });
    if (!result.processedDays) {
      console.info(`Activity is already indexed through ${result.indexedThrough} (${result.walletCount} wallets).`);
      return;
    }
    console.info(
      `Index updated: ${result.indexedFrom}..${result.indexedThrough}, ${result.processedDays} days, ${result.walletCount} wallets.`,
    );
  } finally {
    releaseLock();
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
