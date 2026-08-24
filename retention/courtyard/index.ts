import { CHAIN } from "../../helpers/chains";
import {
  createRetentionFetchAdapter,
  defineRetentionManifest,
  RetentionActivity,
  RetentionActivityRange,
  RetentionEvmLog,
  RetentionQueryContext,
} from "../../helpers/retention";

// Wallet and volume retention (W4/W12) for Courtyard on Polygon.
//
// Runtime indexing uses only event logs. Courtyard's AccessControl registry emits
// every contract-membership change as RoleGranted/RoleRevoked, and the purchase
// contracts emit the buyer, payment token and amount. No eth_call or Dune query is
// needed.
// https://polygonscan.com/address/0x251be3a17af4892035c37ebf5890f4a4d889dcad#events
const REGISTRY = "0x251be3a17af4892035c37ebf5890f4a4d889dcad";

// keccak256 hashes of Courtyard's AccessControl role names and event signatures.
const MINTER_ROLE = "0x9f2df0fed2c77648de5860a4cc508cd0818c85b8b8a1ab4ceeef8d981c8956a6";
const TRUSTED_OPERATOR_ROLE = "0x41c4ce85041f61d74dbc163195f4901b81f46e99d2a521a7b7f6d3a09da4f8c1";
const TRUSTED_FORWARDER_ROLE = "0xd3df22cd6a774f62b0ae21ffd602cc92e7f3390518eee8b33307fc70380da7d2";
const ROLE_GRANTED = "0x2f8788117e7eff1d82e926ec794901d17c78024a50270940304540a733656f0d";
const ROLE_REVOKED = "0xf6391f5c32d9c69d2a47ea670b442974b53935d1edc7fd64eb21e047a839171b";

// TradeExecuted(address indexed bidder, address indexed asker, uint256 indexed nftTokenId,
//               address erc20Token, uint256 amount, bytes tradeSignature, uint256 feeAccrued)
// TokenPurchasedAndMinted(address indexed mintedToAddress, address mintedTokenAddress,
//               uint256 mintedTokenId, address paymentTokenAddress, uint256 paymentAmount)
const TRADE_EXECUTED = "0xa6ae807740439025f50884311ce0f96f5c3809a8f7170f9459dab1b14c9d8afd";
const TOKEN_PURCHASED_AND_MINTED = "0x3ac06088fd2f047b705cf81c76a5be8b7d378860415de575a9974868ca188980";

// Polygon native USDC. Purchase events using another token are deliberately ignored
// because their raw amount cannot be interpreted with USDC's six decimals.
// https://polygonscan.com/token/0x3c499c542cef5e3811e1192ce70d8cc03d5c3359
const USDC = "0x3c499c542cef5e3811e1192ce70d8cc03d5c3359";

type Role = typeof MINTER_ROLE | typeof TRUSTED_OPERATOR_ROLE | typeof TRUSTED_FORWARDER_ROLE;
type Position = { blockNumber: number; logIndex: number };
type RoleMember = { role: Role; member: string };
type RoleChange = RoleMember & Position & { isGrant: boolean };
type RoleInterval = RoleMember & { from: Position; to?: Position };

// Public Polygon RPCs cap historical eth_getLogs ranges. Replaying the registry
// from its 2023 deployment for every seven-day activity batch would turn a small
// adapter query into thousands of RPC calls. This event-derived checkpoint is the
// active registry state at observationStart (2025-01-16T00:00:00Z). Changes up to
// ROLE_SNAPSHOT_DAY are pinned below; changes on and after that day are read live.
const ROLE_SNAPSHOT_DAY = "2026-08-24";
const INITIAL_ROLE_MEMBERS: RoleMember[] = [
  { role: MINTER_ROLE, member: "0x0725d2b69e107a7404c98c98aab7ec9dbf7af3c4" },
  { role: MINTER_ROLE, member: "0x7fc1afb29861fd4a7dfb7859b5271d3c75e4abbd" },
  { role: MINTER_ROLE, member: "0x0af477ac793c3ee69bfcad83e148add148705d79" },
  { role: MINTER_ROLE, member: "0xa0e6cb4c42f0fe31846c48f2693bfe879bc10534" },
  { role: MINTER_ROLE, member: "0x776023a4573bd972c4c3e2a76f611d3c2bef516e" },
  { role: MINTER_ROLE, member: "0x243880832644839397725558b108dcf2af12a58d" },
  { role: MINTER_ROLE, member: "0x4cd41debc6d038317379df1d059938894362ef7f" },
  { role: MINTER_ROLE, member: "0x7ee9f40d48f4e58dc9f21fbd2335c4f2ec1f3d78" },
  { role: MINTER_ROLE, member: "0x732134d7f99b90c704d736b360db45425073380f" },
  { role: MINTER_ROLE, member: "0x92714d4827fa2e396d9f753976cc8a3d395b8064" },
  { role: MINTER_ROLE, member: "0x5e9e7841198c34bad39c7344c6e2829ebf39b8b3" },
  { role: MINTER_ROLE, member: "0x554ad79f0c9d512b624b9bfc2e1ffd4cf50cf220" },
  { role: TRUSTED_OPERATOR_ROLE, member: "0x732134d7f99b90c704d736b360db45425073380f" },
  { role: TRUSTED_OPERATOR_ROLE, member: "0xba98da3e643527acb88ffa50d5a7ca24a14565b4" },
  { role: TRUSTED_OPERATOR_ROLE, member: "0x0725d2b69e107a7404c98c98aab7ec9dbf7af3c4" },
  { role: TRUSTED_OPERATOR_ROLE, member: "0x1e0049783f008a0085193e00003d00cd54003c71" },
  { role: TRUSTED_FORWARDER_ROLE, member: "0xd8253782c45a12053594b9deb72d8e8ab2fca54c" },
  { role: TRUSTED_FORWARDER_ROLE, member: "0xc65d82ece367ef06bf2ab791b3f3cf037dc0e816" },
];

// RoleGranted/RoleRevoked events from observationStart through 2026-08-23 UTC.
// blockNumber + logIndex preserve the exact within-block membership boundary.
const PINNED_ROLE_CHANGES: RoleChange[] = [
  { blockNumber: 66750075, logIndex: 106, isGrant: false, role: MINTER_ROLE, member: "0x92714d4827fa2e396d9f753976cc8a3d395b8064" },
  { blockNumber: 66750149, logIndex: 179, isGrant: false, role: MINTER_ROLE, member: "0x7fc1afb29861fd4a7dfb7859b5271d3c75e4abbd" },
  { blockNumber: 66750158, logIndex: 182, isGrant: false, role: MINTER_ROLE, member: "0x5e9e7841198c34bad39c7344c6e2829ebf39b8b3" },
  { blockNumber: 66750164, logIndex: 249, isGrant: false, role: MINTER_ROLE, member: "0x4cd41debc6d038317379df1d059938894362ef7f" },
  { blockNumber: 66750172, logIndex: 268, isGrant: false, role: MINTER_ROLE, member: "0x0af477ac793c3ee69bfcad83e148add148705d79" },
  { blockNumber: 66750179, logIndex: 200, isGrant: false, role: MINTER_ROLE, member: "0x554ad79f0c9d512b624b9bfc2e1ffd4cf50cf220" },
  { blockNumber: 66750187, logIndex: 192, isGrant: false, role: MINTER_ROLE, member: "0x7ee9f40d48f4e58dc9f21fbd2335c4f2ec1f3d78" },
  { blockNumber: 66750194, logIndex: 277, isGrant: false, role: MINTER_ROLE, member: "0xa0e6cb4c42f0fe31846c48f2693bfe879bc10534" },
  { blockNumber: 73163841, logIndex: 814, isGrant: true, role: TRUSTED_FORWARDER_ROLE, member: "0x07d79f0f6879f4d555431573320236628d16083e" },
  { blockNumber: 76257739, logIndex: 900, isGrant: true, role: TRUSTED_OPERATOR_ROLE, member: "0x5e4943373c2198625bd441ae0629e9e7b4fb4797" },
  { blockNumber: 77481133, logIndex: 670, isGrant: true, role: TRUSTED_OPERATOR_ROLE, member: "0x7fbf08a0ed3ef12565a61935ca6339bbecc25f48" },
  { blockNumber: 81051878, logIndex: 1105, isGrant: true, role: MINTER_ROLE, member: "0x64ecc7f2753df33e21f7c4211ea2b68b608bf8f9" },
  { blockNumber: 81652913, logIndex: 161, isGrant: true, role: TRUSTED_OPERATOR_ROLE, member: "0x64ecc7f2753df33e21f7c4211ea2b68b608bf8f9" },
  { blockNumber: 86838127, logIndex: 1367, isGrant: true, role: TRUSTED_OPERATOR_ROLE, member: "0x969e8e93d83472223a0a87bfcca0c50ee6aed571" },
  { blockNumber: 87467550, logIndex: 383, isGrant: true, role: MINTER_ROLE, member: "0x39cb23e079084cfd3e0e1bee896fbf9175fa10fb" },
];

async function queryActivity(
  context: RetentionQueryContext,
  range: RetentionActivityRange,
): Promise<RetentionActivity[]> {
  const liveRoleChanges = range.toDayExclusive > ROLE_SNAPSHOT_DAY
    ? parseRoleChanges(await context.queryEvmLogs({
      targets: [REGISTRY],
      topic0: [ROLE_GRANTED, ROLE_REVOKED],
      fromDay: ROLE_SNAPSHOT_DAY,
      toDayExclusive: range.toDayExclusive,
    }))
    : [];
  const intervals = buildRoleIntervals([
    ...PINNED_ROLE_CHANGES,
    ...liveRoleChanges,
  ]);
  const minters = membersForRoles(intervals, [MINTER_ROLE]);
  const marketplaces = membersForRoles(intervals, [
    TRUSTED_OPERATOR_ROLE,
    TRUSTED_FORWARDER_ROLE,
  ]);
  const activity: RetentionActivity[] = [];

  // Query one UTC day at a time. This keeps both result size and provider block
  // ranges bounded even when the state service executes a week-long batch.
  for (let day = range.fromDay; day < range.toDayExclusive; day = addUtcDay(day)) {
    const toDayExclusive = addUtcDay(day);
    const mintLogs = await context.queryEvmLogs({
      targets: minters,
      topic0: TOKEN_PURCHASED_AND_MINTED,
      fromDay: day,
      toDayExclusive,
    });
    const tradeLogs = await context.queryEvmLogs({
      targets: marketplaces,
      topic0: TRADE_EXECUTED,
      fromDay: day,
      toDayExclusive,
    });

    for (const log of mintLogs) {
      if (!hasActiveRole(log, MINTER_ROLE, intervals) || dataAddress(log.data, 2) !== USDC) continue;
      activity.push({ day, wallet: topicAddress(log.topics[1]), volumeUsd: usdcAmount(log.data, 3) });
    }
    for (const log of tradeLogs) {
      const isMarketplace = hasActiveRole(log, TRUSTED_OPERATOR_ROLE, intervals)
        || hasActiveRole(log, TRUSTED_FORWARDER_ROLE, intervals);
      if (!isMarketplace || dataAddress(log.data, 0) !== USDC) continue;
      activity.push({ day, wallet: topicAddress(log.topics[1]), volumeUsd: usdcAmount(log.data, 1) });
    }
  }

  return activity;
}

function parseRoleChanges(logs: RetentionEvmLog[]): RoleChange[] {
  const relevantRoles = new Set<string>([
    MINTER_ROLE,
    TRUSTED_OPERATOR_ROLE,
    TRUSTED_FORWARDER_ROLE,
  ]);
  return logs.flatMap((log) => {
    const event = log.topics[0]?.toLowerCase();
    const role = log.topics[1]?.toLowerCase();
    if ((event !== ROLE_GRANTED && event !== ROLE_REVOKED) || !relevantRoles.has(role)) return [];
    return [{
      blockNumber: log.blockNumber,
      logIndex: log.logIndex,
      isGrant: event === ROLE_GRANTED,
      role: role as Role,
      member: topicAddress(log.topics[2]),
    }];
  });
}

function buildRoleIntervals(changes: RoleChange[]): RoleInterval[] {
  const intervals: RoleInterval[] = INITIAL_ROLE_MEMBERS.map(({ role, member }) => ({
    role,
    member,
    from: { blockNumber: 0, logIndex: 0 },
  }));
  const open = new Map(intervals.map((interval) => [roleKey(interval.role, interval.member), interval]));
  const sorted = [...changes].sort(compareChanges);

  for (const change of sorted) {
    const key = roleKey(change.role, change.member);
    const current = open.get(key);
    if (change.isGrant) {
      if (current) continue;
      const interval: RoleInterval = {
        role: change.role,
        member: change.member,
        from: change,
      };
      intervals.push(interval);
      open.set(key, interval);
    } else if (current) {
      current.to = change;
      open.delete(key);
    }
  }
  return intervals;
}

function membersForRoles(intervals: RoleInterval[], roles: Role[]): string[] {
  const accepted = new Set<Role>(roles);
  return [...new Set(intervals.filter(({ role }) => accepted.has(role)).map(({ member }) => member))];
}

function hasActiveRole(log: RetentionEvmLog, role: Role, intervals: RoleInterval[]): boolean {
  const address = log.address.toLowerCase();
  const position = { blockNumber: log.blockNumber, logIndex: log.logIndex };
  return intervals.some((interval) => interval.role === role
    && interval.member === address
    && comparePositions(position, interval.from) >= 0
    && (!interval.to || comparePositions(position, interval.to) < 0));
}

function roleKey(role: Role, member: string): string {
  return `${role}:${member}`;
}

function compareChanges(a: RoleChange, b: RoleChange): number {
  return comparePositions(a, b);
}

function comparePositions(a: Position, b: Position): number {
  return a.blockNumber - b.blockNumber || a.logIndex - b.logIndex;
}

function topicAddress(topic: string | undefined): string {
  if (!topic || !/^0x[0-9a-fA-F]{64}$/.test(topic)) throw new Error(`invalid address topic: ${topic}`);
  return `0x${topic.slice(-40).toLowerCase()}`;
}

function dataAddress(data: string, wordIndex: number): string {
  return `0x${dataWord(data, wordIndex).slice(-40).toLowerCase()}`;
}

function usdcAmount(data: string, wordIndex: number): number {
  const raw = BigInt(`0x${dataWord(data, wordIndex)}`);
  const whole = raw / 1_000_000n;
  if (whole > BigInt(Number.MAX_SAFE_INTEGER)) throw new Error(`USDC amount exceeds safe range: ${raw}`);
  return Number(whole) + Number(raw % 1_000_000n) / 1e6;
}

function dataWord(data: string, wordIndex: number): string {
  if (!/^0x[0-9a-fA-F]*$/.test(data)) throw new Error("invalid event data");
  const start = 2 + wordIndex * 64;
  const word = data.slice(start, start + 64);
  if (word.length !== 64) throw new Error(`event data is missing word ${wordIndex}`);
  return word;
}

function addUtcDay(day: string): string {
  return new Date(Date.parse(`${day}T00:00:00Z`) + 86_400_000).toISOString().slice(0, 10);
}

export const retentionManifest = defineRetentionManifest({
  project: "courtyard",
  chain: CHAIN.POLYGON,
  stateVersion: 1,
  // Courtyard has been live since 2021, but this index observes pack mints only
  // from 2025-01-16. Delaying cohorts until October provides an eight-month
  // lookback and reduces the chance of treating an existing buyer as first-seen.
  observationStart: "2025-01-16",
  firstCohortStart: "2025-10-01",
  maxQueryDays: 7,
  queryActivity,
  methodology:
    "Daily rolling weekly cohort retention for Courtyard on Polygon. Each daily row ends a complete seven-day return window; W4 and W12 compare it with the same seven-day window shifted 4 or 12 weeks earlier. The cohort contains wallets whose first observed Courtyard purchase - primary pack mints or secondary marketplace trades, on the contracts the on-chain role registry lists - occurred in that earlier window. Every purchase settles in USDC. Activity is observed from the first available pack mints on 2025-01-16 and cohorts start on 2025-10-01, so wallets active earlier in the observed history are not mistaken for new buyers.",
});

export default createRetentionFetchAdapter(retentionManifest);
