import * as sdk from "@defillama/sdk";
import assert from "node:assert/strict";
import { test } from "node:test";
import { ADAPTER_TYPES, AdapterType } from "../adapters/types";
import type { FetchOptions } from "../adapters/types";
import collectorCrypt from "../retention/collector-crypt";
import courtyard from "../retention/courtyard";
import {
  createRetentionAdapter,
  isRetentionAdapter,
  RetentionActivity,
  RetentionConfig,
} from "./retention";

// In-memory integration test; it never reads from or writes to R2.
// Run with:
// node --test -r ts-node/register/transpile-only helpers/retention.test.ts

const timestamp = (day: string) => Date.parse(`${day}T00:00:00Z`) / 1000;

const activity: RetentionActivity[] = [
  { day: "2025-01-01", wallet: "w12-returned", volumeUsd: 10 },
  { day: "2025-03-30", wallet: "w12-returned", volumeUsd: 4 },
  { day: "2025-01-03", wallet: "w12-not-returned", volumeUsd: 20 },
  { day: "2025-01-21", wallet: "partial-write", volumeUsd: 1 },
  { day: "2025-02-26", wallet: "w4-returned", volumeUsd: 30 },
  { day: "2025-04-01", wallet: "w4-returned", volumeUsd: 15 },
  { day: "2025-03-01", wallet: "w4-not-returned", volumeUsd: 40 },
  { day: "2025-02-20", wallet: "seen-before-w4", volumeUsd: 5 },
  { day: "2025-03-01", wallet: "seen-before-w4", volumeUsd: 50 },
  { day: "2025-03-29", wallet: "seen-before-w4", volumeUsd: 25 },
];

test("activity indexing resumes safely and fetch stays read-only", async () => {
  assert.ok(ADAPTER_TYPES.includes(AdapterType.RETENTION));
  assert.ok(isRetentionAdapter(collectorCrypt));
  assert.ok(isRetentionAdapter(courtyard));

  const requestedRanges: Array<[string, string]> = [];
  const config: RetentionConfig = {
    project: "retention-integration-test",
    chain: "solana",
    stateVersion: 1,
    observationStart: "2025-01-01",
    firstCohortStart: "2025-01-01",
    shardCount: 2,
    chunkDays: 10,
    methodology: "Test fixture",
    getActivity: async (_options, fromDay, toDayExclusive) => {
      requestedRanges.push([fromDay, toDayExclusive]);
      return activity.filter((row) => row.day >= fromDay && row.day < toDayExclusive);
    },
  };

  const state = new Map<string, unknown>();
  const writes: string[] = [];
  let failOnce = true;
  const originalDateNow = Date.now;
  const originalReadCache = sdk.cache.readCache;
  const originalWriteCache = sdk.cache.writeCache;
  sdk.cache.readCache = async (key) => state.get(key) ?? {};
  sdk.cache.writeCache = async (key, data) => {
    if (failOnce && key.includes("/first-seen/") && JSON.stringify(data).includes("partial-write")) {
      failOnce = false;
      return undefined;
    }
    state.set(key, JSON.parse(JSON.stringify(data)));
    writes.push(key);
    return "written";
  };

  try {
    const adapter = createRetentionAdapter(config);
    assert.ok(isRetentionAdapter(adapter));
    assert.ok(adapter.fetch);

    const missingStateAdapter = createRetentionAdapter({
      ...config,
      project: "retention-missing-state-test",
    });
    assert.ok(missingStateAdapter.fetch);
    await assert.rejects(
      missingStateAdapter.fetch({
        startOfDay: timestamp("2025-04-01"),
        dateString: "2025-04-01",
      } as FetchOptions),
      /run the retention backfill CLI before fetch/,
    );
    assert.equal(requestedRanges.length, 0, "fetch must not bootstrap missing history");

    await assert.rejects(
      adapter.indexActivity({ toDate: "2025-03-31" }),
      /failed to publish retention state first-seen/,
    );
    assert.deepEqual(requestedRanges, [
      ["2025-01-01", "2025-01-11"],
      ["2025-01-11", "2025-01-21"],
      ["2025-01-21", "2025-01-31"],
    ]);
    const publishedMeta = [...state.entries()].find(([key]) => key.endsWith("/meta"))?.[1] as {
      indexedThrough: number;
      bootstrapComplete: boolean;
    };
    assert.equal(publishedMeta.indexedThrough, timestamp("2025-01-20") / 86400);
    assert.equal(publishedMeta.bootstrapComplete, false);
    assert.match(writes[writes.length - 1], /\/activity\/2025-01$/);
    const queriesAfterFailedBootstrap = requestedRanges.length;
    await assert.rejects(
      adapter.fetch({
        startOfDay: timestamp("2025-04-01"),
        dateString: "2025-04-01",
      } as FetchOptions),
      /activity bootstrap is incomplete/,
    );
    assert.equal(requestedRanges.length, queriesAfterFailedBootstrap, "fetch must not finish an incomplete bootstrap");

    const rangesBeforeRetry = requestedRanges.length;
    const indexed = await adapter.indexActivity({ toDate: "2025-03-31" });
    assert.deepEqual(indexed, {
      indexedFrom: "2025-01-21",
      indexedThrough: "2025-03-31",
      processedDays: 70,
      walletCount: 6,
    });
    assert.deepEqual(requestedRanges[requestedRanges.length - 1], ["2025-03-22", "2025-04-01"]);
    assert.deepEqual(requestedRanges[rangesBeforeRetry], ["2025-01-21", "2025-01-31"]);
    assert.match(writes[writes.length - 1], /\/meta$/);

    const queriesAfterIndex = requestedRanges.length;
    const writesAfterIndex = writes.length;
    const repeated = await adapter.indexActivity({ toDate: "2025-03-31" });
    assert.deepEqual(repeated, {
      indexedFrom: undefined,
      indexedThrough: "2025-03-31",
      processedDays: 0,
      walletCount: 6,
    });
    assert.equal(requestedRanges.length, queriesAfterIndex, "repeated indexing must not query the source again");
    assert.equal(writes.length, writesAfterIndex, "repeated indexing must not update the activity index");

    Date.now = () => Date.parse("2025-04-02T07:59:59Z");
    await assert.rejects(
      adapter.indexActivity({ toDate: "2025-04-01" }),
      /not final before 08:00 UTC/,
    );
    assert.equal(requestedRanges.length, queriesAfterIndex, "indexing must wait for the Dune refresh window");
    assert.equal(writes.length, writesAfterIndex, "indexing must not publish incomplete Dune activity");

    Date.now = () => Date.parse("2025-04-02T08:00:00Z");
    await assert.rejects(
      adapter.fetch({
        startOfDay: timestamp("2025-04-01"),
        dateString: "2025-04-01",
      } as FetchOptions),
      /core must run indexActivity through 2025-04-01 before fetch/,
    );
    assert.equal(requestedRanges.length, queriesAfterIndex, "fetch must not advance a stale activity index");
    assert.equal(writes.length, writesAfterIndex, "fetch must stay read-only when the activity index is stale");

    const advanced = await adapter.indexActivity({ toDate: "2025-04-01" });
    assert.deepEqual(advanced, {
      indexedFrom: "2025-04-01",
      indexedThrough: "2025-04-01",
      processedDays: 1,
      walletCount: 6,
    });
    assert.deepEqual(requestedRanges[requestedRanges.length - 1], ["2025-04-01", "2025-04-02"]);
    assert.ok(writes.length > writesAfterIndex, "indexActivity must publish newly available activity");

    const queriesAfterAdvance = requestedRanges.length;
    const writesAfterAdvance = writes.length;
    const result = await adapter.fetch({
      startOfDay: timestamp("2025-04-01"),
      dateString: "2025-04-01",
    } as FetchOptions);

    assert.deepEqual(result, {
      dailyRetentionW4CohortWallets: 2,
      dailyRetentionW4ReturnedWallets: 1,
      dailyRetentionW4CohortVolume: 70,
      dailyRetentionW4ReturnedVolume: 15,
      dailyRetentionW12CohortWallets: 2,
      dailyRetentionW12ReturnedWallets: 1,
      dailyRetentionW12CohortVolume: 30,
      dailyRetentionW12ReturnedVolume: 4,
    });
    assert.equal(requestedRanges.length, queriesAfterAdvance, "fetch must not query the source");
    assert.equal(writes.length, writesAfterAdvance, "fetch must not publish activity");

    const queriesAfterFetch = requestedRanges.length;
    const writesAfterFetch = writes.length;
    assert.deepEqual(await adapter.fetch({
      startOfDay: timestamp("2025-04-01"),
      dateString: "2025-04-01",
    } as FetchOptions), result);
    assert.equal(requestedRanges.length, queriesAfterFetch, "an indexed fetch must not query the source again");
    assert.equal(writes.length, writesAfterFetch, "an indexed fetch must stay read-only");
  } finally {
    Date.now = originalDateNow;
    sdk.cache.readCache = originalReadCache;
    sdk.cache.writeCache = originalWriteCache;
  }
});
