import * as sdk from "@defillama/sdk";
import { ChainApi } from "@defillama/sdk";
import { Dependencies, FetchOptions, FetchResultRetention, SimpleAdapter } from "../adapters/types";

const ENGINE_VERSION = 1;
const DAY = 86400;
const WEEK = 7 * DAY;
const HORIZONS = [4, 12];
const DEFAULT_CHUNK_DAYS = 30;
const DUNE_REFRESH_HOUR_UTC = 8;

export interface RetentionActivity {
  day: string;
  wallet: string;
  volumeUsd: number;
}

export type RetentionQueryOptions = Pick<
  FetchOptions,
  "chain" | "api" | "startTimestamp" | "endTimestamp" | "moduleUID" | "metadata"
>;

export interface RetentionConfig {
  project: string;
  chain: string;
  stateVersion: number;
  observationStart: string;
  firstCohortStart: string;
  shardCount?: number;
  chunkDays?: number;
  methodology: string;
  getActivity: (options: RetentionQueryOptions, fromDay: string, toDayExclusive: string) => Promise<RetentionActivity[]>;
}

const dayIndex = (dateOrTs: string | number) =>
  Math.floor((typeof dateOrTs === "number" ? dateOrTs : Date.parse(`${dateOrTs}T00:00:00Z`) / 1000) / DAY);
const dateStr = (dayIdx: number) => new Date(dayIdx * DAY * 1000).toISOString().slice(0, 10);
const monthOf = (dayIdx: number) => dateStr(dayIdx).slice(0, 7);
const monthFirstDay = (month: string) => dayIndex(`${month}-01`);
const monthLastDay = (month: string) => {
  const [y, m] = month.split("-").map(Number);
  return dayIndex(`${m === 12 ? y + 1 : y}-${String(m === 12 ? 1 : m + 1).padStart(2, "0")}-01`) - 1;
};

function shardOf(wallet: string, shardCount: number) {
  let h = 5381;
  for (let i = 0; i < wallet.length; i++) h = ((h * 33) ^ wallet.charCodeAt(i)) >>> 0;
  return h % shardCount;
}

interface Meta {
  engineVersion: number;
  indexedThrough: number;
  bootstrapComplete: boolean;
  shardCount: number;
  shardWallets: number[];
}
interface FirstSeenShard { wallets: string[]; firstDay: number[] }
interface ActivityDay { wallets: string[]; volumesUsd: number[] }
interface ActivityMonth { indexedThrough: number; days: Record<string, ActivityDay> }

function stateStore(project: string, stateVersion: number) {
  const base = `dimensions-adapter-cache/retention/${project}/v${stateVersion}`;
  return {
    read: async <T>(key: string): Promise<T | undefined> => {
      const data = await sdk.cache.readCache(`${base}/${key}`, { readFromR2Cache: true });
      return data && Object.keys(data).length ? data as T : undefined;
    },
    write: async <T>(key: string, data: T) => {
      const written = await sdk.cache.writeCache(`${base}/${key}`, data);
      if (!written) throw new Error(`${project}: failed to publish retention state ${key}`);
    },
  };
}

type Store = ReturnType<typeof stateStore>;

const firstSeenKey = (shardCount: number, i: number) => `first-seen/${shardCount}/${i}`;

async function indexRange(
  store: Store,
  config: RetentionConfig,
  options: RetentionQueryOptions,
  meta: Meta,
  fromDay: number,
  toDay: number,
): Promise<Meta> {
  const chunkDays = config.chunkDays ?? DEFAULT_CHUNK_DAYS;
  for (let chunkStart = fromDay; chunkStart <= toDay; chunkStart += chunkDays) {
    const chunkEnd = Math.min(chunkStart + chunkDays - 1, toDay);
    const queryOptions = {
      ...options,
      startTimestamp: chunkStart * DAY,
      endTimestamp: (chunkEnd + 1) * DAY,
    };
    const rows = await config.getActivity(queryOptions, dateStr(chunkStart), dateStr(chunkEnd + 1));

    const byDay: Record<string, ActivityDay> = {};
    for (let d = chunkStart; d <= chunkEnd; d++) byDay[dateStr(d)] = { wallets: [], volumesUsd: [] };
    const firstInChunk = new Map<string, number>();
    for (const row of rows) {
      const slot = byDay[row.day];
      if (!slot) throw new Error(`getActivity returned day ${row.day} outside [${dateStr(chunkStart)}, ${dateStr(chunkEnd + 1)})`);
      if (!(row.volumeUsd > 0)) continue;
      slot.wallets.push(row.wallet);
      slot.volumesUsd.push(row.volumeUsd);
      const idx = dayIndex(row.day);
      const seen = firstInChunk.get(row.wallet);
      if (seen === undefined || idx < seen) firstInChunk.set(row.wallet, idx);
    }

    const months = new Set(Object.keys(byDay).map((d) => d.slice(0, 7)));
    for (const month of months) {
      const file = (await store.read<ActivityMonth>(`activity/${month}`)) ?? { indexedThrough: -1, days: {} };
      const monthThrough = Math.min(chunkEnd, monthLastDay(month));
      // A failed run may already have published this immutable portion before
      // the global watermark. In that case the retry can safely reuse it.
      if (file.indexedThrough >= monthThrough) continue;
      for (const [day, slot] of Object.entries(byDay)) if (day.startsWith(month)) file.days[day] = slot;
      file.indexedThrough = monthThrough;
      await store.write(`activity/${month}`, file);
    }

    const byShard = new Map<number, Map<string, number>>();
    for (const [wallet, idx] of firstInChunk) {
      const s = shardOf(wallet, meta.shardCount);
      if (!byShard.has(s)) byShard.set(s, new Map());
      byShard.get(s)!.set(wallet, idx);
    }
    for (const [s, entries] of byShard) {
      const shard = (await store.read<FirstSeenShard>(firstSeenKey(meta.shardCount, s))) ?? { wallets: [], firstDay: [] };
      const pos = new Map(shard.wallets.map((w, i) => [w, i]));
      let changed = false;
      for (const [wallet, idx] of entries) {
        const at = pos.get(wallet);
        if (at === undefined) {
          shard.wallets.push(wallet);
          shard.firstDay.push(idx);
          changed = true;
        }
        else if (idx < shard.firstDay[at])
          throw new Error(`${config.project}: ${wallet} appeared before its stored first-seen day; bump stateVersion and rebuild`);
      }
      if (changed) await store.write(firstSeenKey(meta.shardCount, s), shard);
      meta.shardWallets[s] = shard.wallets.length;
    }

    meta.indexedThrough = chunkEnd;
    // Data and first-seen shards are written first. Publishing this checkpoint
    // last makes the completed chunk visible and lets a retry resume here.
    await store.write("meta", meta);
  }

  return meta;
}

function validateConfig(config: RetentionConfig) {
  const shardCount = config.shardCount ?? 1;
  if (!Number.isInteger(shardCount) || shardCount < 1 || (shardCount & (shardCount - 1)))
    throw new Error(`${config.project}: shardCount must be a positive power of two`);
  if (!Number.isInteger(config.chunkDays ?? DEFAULT_CHUNK_DAYS) || (config.chunkDays ?? DEFAULT_CHUNK_DAYS) < 1)
    throw new Error(`${config.project}: chunkDays must be a positive integer`);
  const observationStartDay = dayIndex(config.observationStart);
  if (!Number.isFinite(observationStartDay) || dateStr(observationStartDay) !== config.observationStart)
    throw new Error(`${config.project}: invalid observationStart ${config.observationStart}`);
  const firstCohortStartDay = dayIndex(config.firstCohortStart);
  if (!Number.isFinite(firstCohortStartDay) || dateStr(firstCohortStartDay) !== config.firstCohortStart)
    throw new Error(`${config.project}: invalid firstCohortStart ${config.firstCohortStart}`);
  if (firstCohortStartDay < observationStartDay)
    throw new Error(`${config.project}: firstCohortStart precedes observationStart`);
  return { shardCount, observationStartDay, firstCohortStartDay };
}

function validateMeta(config: RetentionConfig, meta: Meta, shardCount: number) {
  if (meta.engineVersion !== ENGINE_VERSION)
    throw new Error(`${config.project}: retention state engine v${meta.engineVersion} is incompatible with v${ENGINE_VERSION}; bump stateVersion and rebuild the activity index`);
  if (typeof meta.bootstrapComplete !== "boolean")
    throw new Error(`${config.project}: retention state has no bootstrap status; bump stateVersion and rebuild the activity index`);
  if (meta.shardCount !== shardCount || !Array.isArray(meta.shardWallets) || meta.shardWallets.length !== shardCount)
    throw new Error(`${config.project}: retention state shard layout is incompatible; bump stateVersion and rebuild the activity index`);
}

export interface ActivityIndexResult {
  indexedFrom?: string;
  indexedThrough: string;
  processedDays: number;
  walletCount: number;
}

export interface ActivityIndexOptions {
  /** Inclusive last complete UTC date to add to the activity index. */
  toDate: string;
}

export interface RetentionAdapter extends SimpleAdapter {
  /**
   * Initializes or advances the persisted activity index. The core backend
   * must serialize calls for the same project and run this before fetch.
   */
  indexActivity: (options: ActivityIndexOptions) => Promise<ActivityIndexResult>;
}

export function isRetentionAdapter(adapter: SimpleAdapter): adapter is RetentionAdapter {
  return typeof (adapter as RetentionAdapter).indexActivity === "function";
}

/** Creates a W4/W12 adapter backed by an incrementally maintained activity index. */
export function createRetentionAdapter(config: RetentionConfig): RetentionAdapter {
  const { shardCount, observationStartDay, firstCohortStartDay } = validateConfig(config);

  const store = stateStore(config.project, config.stateVersion);

  function assertDuneDayReady(targetDay: number) {
    const now = Math.trunc(Date.now() / 1000);
    const today = dayIndex(now);
    if (targetDay === today - 1 && new Date(now * 1000).getUTCHours() < DUNE_REFRESH_HOUR_UTC)
      throw new Error(
        `${config.project}: Dune activity for ${dateStr(targetDay)} is not final before 08:00 UTC`);
  }

  async function getExistingState(): Promise<Meta> {
    const meta = await store.read<Meta>("meta");
    if (!meta)
      throw new Error(
        `${config.project}: no activity index at v${config.stateVersion}; run the retention backfill CLI before fetch`);
    validateMeta(config, meta, shardCount);
    if (!meta.bootstrapComplete)
      throw new Error(`${config.project}: activity bootstrap is incomplete; rerun the retention backfill CLI`);
    return meta;
  }

  async function indexActivity({ toDate }: ActivityIndexOptions): Promise<ActivityIndexResult> {
    const toDay = dayIndex(toDate);
    if (!Number.isFinite(toDay) || dateStr(toDay) !== toDate)
      throw new Error(`Invalid toDate: ${toDate}`);
    if (toDay < observationStartDay)
      throw new Error(`${config.project}: index target ${toDate} precedes observation start ${config.observationStart}`);
    if (toDay >= dayIndex(Math.trunc(Date.now() / 1000)))
      throw new Error(`${config.project}: index target ${toDate} is not a complete UTC day`);

    const startOfTargetDay = toDay * DAY;
    const api = new ChainApi({ chain: config.chain, timestamp: startOfTargetDay + DAY - 1 });
    const options: RetentionQueryOptions = {
      chain: config.chain,
      api,
      startTimestamp: startOfTargetDay,
      endTimestamp: startOfTargetDay + DAY,
      moduleUID: `retention-index-${config.project}-v${config.stateVersion}`,
      metadata: {
        adapterType: "retention",
        protocolName: config.project,
        runType: "index-activity",
      },
    };

    let meta = await store.read<Meta>("meta");
    if (meta) validateMeta(config, meta, shardCount);
    else meta = {
      engineVersion: ENGINE_VERSION,
      indexedThrough: observationStartDay - 1,
      bootstrapComplete: false,
      shardCount,
      shardWallets: new Array(shardCount).fill(0),
    };

    const fromDay = meta.indexedThrough + 1;
    if (fromDay <= toDay) {
      assertDuneDayReady(toDay);
      meta = await indexRange(store, config, options, meta, fromDay, toDay);
    }
    if (!meta.bootstrapComplete) {
      meta.bootstrapComplete = true;
      await store.write("meta", meta);
    }

    return {
      indexedFrom: fromDay <= toDay ? dateStr(fromDay) : undefined,
      indexedThrough: dateStr(meta.indexedThrough),
      processedDays: Math.max(0, toDay - fromDay + 1),
      walletCount: meta.shardWallets.reduce((sum, count) => sum + count, 0),
    };
  }

  async function fetch(options: FetchOptions): Promise<FetchResultRetention> {
    const targetDay = dayIndex(options.startOfDay);
    const returnStart = options.startOfDay - 6 * DAY;
    const returnEnd = options.startOfDay + DAY;
    if (returnEnd > Math.trunc(Date.now() / 1000))
      throw new Error(`Return week ends ${new Date(returnEnd * 1000).toISOString()}, which is still in the future`);

    const cohorts = HORIZONS
      .map((weeks) => ({ weeks, start: returnStart - weeks * WEEK, end: returnEnd - weeks * WEEK }))
      .filter(({ start }) => dayIndex(start) >= firstCohortStartDay);
    if (!cohorts.length)
      throw new Error(`No cohort week on ${options.dateString} is backed by history from ${config.firstCohortStart}`);

    const meta = await getExistingState();
    if (meta.indexedThrough < targetDay)
      throw new Error(
        `${config.project}: activity index ends at ${dateStr(meta.indexedThrough)}; core must run indexActivity through ${dateStr(targetDay)} before fetch`,
      );

    const windows = [{ key: "return", start: returnStart, end: returnEnd },
      ...cohorts.map(({ weeks, start, end }) => ({ key: `w${weeks}`, start, end }))];
    const active = new Map<string, Record<string, number>>();
    const months = new Set<string>();
    for (const w of windows) for (let d = dayIndex(w.start); d < dayIndex(w.end); d++) months.add(monthOf(d));
    for (const month of months) {
      const file = await store.read<ActivityMonth>(`activity/${month}`);
      const needThrough = Math.min(meta.indexedThrough, monthLastDay(month));
      if (!file || file.indexedThrough < needThrough)
        throw new Error(`${config.project}: activity state for ${month} is missing or behind the watermark - rebuild v${config.stateVersion}`);
      for (const w of windows) {
        for (let d = Math.max(dayIndex(w.start), monthFirstDay(month)); d < Math.min(dayIndex(w.end), monthLastDay(month) + 1); d++) {
          const day = file.days[dateStr(d)];
          if (!day) continue;
          day.wallets.forEach((wallet, i) => {
            let sums = active.get(wallet);
            if (!sums) active.set(wallet, (sums = {}));
            sums[w.key] = (sums[w.key] ?? 0) + day.volumesUsd[i];
          });
        }
      }
    }

    const counts: Record<string, { cohortWallets: number; returnedWallets: number; cohortVolume: number; returnedVolume: number }> = {};
    for (const { weeks } of cohorts) counts[`w${weeks}`] = { cohortWallets: 0, returnedWallets: 0, cohortVolume: 0, returnedVolume: 0 };
    for (let s = 0; s < meta.shardCount; s++) {
      const shard = (await store.read<FirstSeenShard>(firstSeenKey(meta.shardCount, s))) ?? { wallets: [], firstDay: [] };
      const publishedWallets = meta.shardWallets[s];
      if (shard.wallets.length < publishedWallets || shard.firstDay.length < publishedWallets)
        throw new Error(`${config.project}: first-seen shard ${s} is shorter than its published watermark - rebuild v${config.stateVersion}`);
      for (let at = 0; at < publishedWallets; at++) {
        const wallet = shard.wallets[at];
        const sums = active.get(wallet);
        if (!sums) continue;
        const first = shard.firstDay[at];
        for (const { weeks, start, end } of cohorts) {
          if (first < dayIndex(start) || first >= dayIndex(end)) continue;
          const c = counts[`w${weeks}`];
          c.cohortWallets++;
          c.cohortVolume += sums[`w${weeks}`] ?? 0;
          if (sums.return) { c.returnedWallets++; c.returnedVolume += sums.return; }
        }
      }
    }

    const result: Record<string, number> = {};
    for (const { weeks } of cohorts) {
      const c = counts[`w${weeks}`];
      if (c.returnedWallets > c.cohortWallets)
        throw new Error(`W${weeks} returned ${c.returnedWallets} wallets out of a cohort of ${c.cohortWallets}`);
      result[`dailyRetentionW${weeks}CohortWallets`] = c.cohortWallets;
      result[`dailyRetentionW${weeks}ReturnedWallets`] = c.returnedWallets;
      result[`dailyRetentionW${weeks}CohortVolume`] = c.cohortVolume;
      result[`dailyRetentionW${weeks}ReturnedVolume`] = c.returnedVolume;
    }
    return result;
  }

  return {
    version: 1,
    indexActivity,
    fetch,
    chains: [config.chain],
    dependencies: [Dependencies.DUNE],
    start: dateStr(firstCohortStartDay + HORIZONS[0] * 7 + 6),
    methodology: config.methodology,
  };
}
