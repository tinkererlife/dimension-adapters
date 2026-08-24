import { CHAIN } from "../../helpers/chains";
import {
  createRetentionFetchAdapter,
  defineRetentionManifest,
  RetentionActivity,
  RetentionActivityRange,
  RetentionQueryContext,
} from "../../helpers/retention";

// Wallet and volume retention (W4/W12) for Courtyard on Polygon.
//
// Marketplace and minter membership comes from the same on-chain role registry
// fees/courtyard uses. The Dune query reconstructs membership intervals from
// RoleGranted/RoleRevoked logs, so backfills stay event-only while respecting
// the registry state that was active for each purchase.
// https://polygonscan.com/address/0x251be3a17af4892035c37ebf5890f4a4d889dcad#code
const REGISTRY = "0x251be3a17af4892035c37ebf5890f4a4d889dcad";
// First relevant RoleGranted log on the registry; it predates observationStart.
const REGISTRY_ROLE_START = "2023-07-23";
// keccak256 of the named AccessControl roles and events.
const MINTER_ROLE = "0x9f2df0fed2c77648de5860a4cc508cd0818c85b8b8a1ab4ceeef8d981c8956a6";
const TRUSTED_OPERATOR_ROLE = "0x41c4ce85041f61d74dbc163195f4901b81f46e99d2a521a7b7f6d3a09da4f8c1";
const TRUSTED_FORWARDER_ROLE = "0xd3df22cd6a774f62b0ae21ffd602cc92e7f3390518eee8b33307fc70380da7d2";
const ROLE_GRANTED = "0x2f8788117e7eff1d82e926ec794901d17c78024a50270940304540a733656f0d";
const ROLE_REVOKED = "0xf6391f5c32d9c69d2a47ea670b442974b53935d1edc7fd64eb21e047a839171b";

// Dune has no decoded tables for these contracts, so the logs are decoded by hand.
// Both topic0 values are keccak256 of the signatures fees/courtyard decodes:
//
//   TradeExecuted(address indexed bidder, address indexed asker, uint256 indexed nftTokenId,
//                 address erc20Token, uint256 amount, bytes tradeSignature, uint256 feeAccrued)
//     buyer = topic1, erc20Token = data word 0, amount = data word 1
//
//   TokenPurchasedAndMinted(address indexed mintedToAddress, address mintedTokenAddress,
//                 uint256 mintedTokenId, address paymentTokenAddress, uint256 paymentAmount)
//     buyer = topic1, paymentTokenAddress = data word 2, paymentAmount = data word 3
const TRADE_EXECUTED = "0xa6ae807740439025f50884311ce0f96f5c3809a8f7170f9459dab1b14c9d8afd";
const TOKEN_PURCHASED_AND_MINTED = "0x3ac06088fd2f047b705cf81c76a5be8b7d378860415de575a9974868ca188980";

// Every purchase on both rails settles in USDC - checked over the full observed
// history, no event carries another payment token. The filter is kept so a future
// second currency shows up as missing volume rather than as 6-decimal nonsense.
// https://polygonscan.com/token/0x3c499c542cef5e3811e1192ce70d8cc03d5c3359
const USDC = "0x3c499c542cef5e3811e1192ce70d8cc03d5c3359";
type DuneActivityRow = { day: string; wallet: string; volume_usd: string | number };

async function queryActivity(
  context: RetentionQueryContext,
  range: RetentionActivityRange,
): Promise<RetentionActivity[]> {
  // Dune EVM addresses are varbinary literals, so they must not be quoted.
  const rows = await context.queryDuneSql<DuneActivityRow>(`
WITH role_changes AS (
  SELECT bytearray_substring(topic2, 13, 20) AS member,
         topic1 AS role,
         topic0 = ${ROLE_GRANTED} AS is_grant,
         block_number,
         index AS log_index,
         lead(block_number) OVER (
           PARTITION BY topic1, topic2 ORDER BY block_number, index
         ) AS next_block_number,
         lead(index) OVER (
           PARTITION BY topic1, topic2 ORDER BY block_number, index
         ) AS next_log_index
  FROM polygon.logs
  WHERE contract_address = ${REGISTRY}
    AND block_date >= date '${REGISTRY_ROLE_START}'
    AND block_date < date '${range.toDayExclusive}'
    AND topic0 IN (${ROLE_GRANTED}, ${ROLE_REVOKED})
    AND topic1 IN (${MINTER_ROLE}, ${TRUSTED_OPERATOR_ROLE}, ${TRUSTED_FORWARDER_ROLE})
),
active_role_intervals AS (
  SELECT member, role, block_number, log_index, next_block_number, next_log_index
  FROM role_changes
  WHERE is_grant
),
mint_activity AS (
  SELECT DISTINCT l.block_number,
         l.index AS log_index,
         cast(date_trunc('day', l.block_time) AS date) AS day,
         lower(concat('0x', to_hex(bytearray_substring(l.topic1, 13, 20)))) AS wallet,
         cast(varbinary_to_uint256(bytearray_substring(l.data, 97, 32)) AS double) / 1e6 AS volume_usd
  FROM polygon.logs l
  JOIN active_role_intervals role
    ON role.member = l.contract_address
   AND role.role = ${MINTER_ROLE}
   AND (l.block_number > role.block_number OR
        (l.block_number = role.block_number AND l.index >= role.log_index))
   AND (role.next_block_number IS NULL OR l.block_number < role.next_block_number OR
        (l.block_number = role.next_block_number AND l.index < role.next_log_index))
  WHERE l.block_date >= date '${range.fromDay}' AND l.block_date < date '${range.toDayExclusive}'
    AND l.topic0 = ${TOKEN_PURCHASED_AND_MINTED}
    AND bytearray_substring(l.data, 77, 20) = ${USDC}
),
marketplace_activity AS (
  SELECT DISTINCT l.block_number,
         l.index AS log_index,
         cast(date_trunc('day', l.block_time) AS date) AS day,
         lower(concat('0x', to_hex(bytearray_substring(l.topic1, 13, 20)))) AS wallet,
         cast(varbinary_to_uint256(bytearray_substring(l.data, 33, 32)) AS double) / 1e6 AS volume_usd
  FROM polygon.logs l
  JOIN active_role_intervals role
    ON role.member = l.contract_address
   AND role.role IN (${TRUSTED_OPERATOR_ROLE}, ${TRUSTED_FORWARDER_ROLE})
   AND (l.block_number > role.block_number OR
        (l.block_number = role.block_number AND l.index >= role.log_index))
   AND (role.next_block_number IS NULL OR l.block_number < role.next_block_number OR
        (l.block_number = role.next_block_number AND l.index < role.next_log_index))
  WHERE l.block_date >= date '${range.fromDay}' AND l.block_date < date '${range.toDayExclusive}'
    AND l.topic0 = ${TRADE_EXECUTED}
    AND bytearray_substring(l.data, 13, 20) = ${USDC}
)
SELECT day, wallet, sum(volume_usd) AS volume_usd
FROM (
  SELECT day, wallet, volume_usd FROM mint_activity
  UNION ALL
  SELECT day, wallet, volume_usd FROM marketplace_activity
)
GROUP BY 1, 2
  `);
  return rows.map((row) => ({ day: String(row.day).slice(0, 10), wallet: row.wallet, volumeUsd: Number(row.volume_usd) }));
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
  // One complete week per query keeps the backfill bounded; Dune pagination handles
  // weeks whose result has more than 100k wallet-day rows.
  maxQueryDays: 7,
  queryActivity,
  methodology:
    "Daily rolling weekly cohort retention for Courtyard on Polygon. Each daily row ends a complete seven-day return window; W4 and W12 compare it with the same seven-day window shifted 4 or 12 weeks earlier. The cohort contains wallets whose first observed Courtyard purchase - primary pack mints or secondary marketplace trades, on the contracts the on-chain role registry lists - occurred in that earlier window. Every purchase settles in USDC. Activity is observed from the first available pack mints on 2025-01-16 and cohorts start on 2025-10-01, so wallets active earlier in the observed history are not mistaken for new buyers.",
});

export default createRetentionFetchAdapter(retentionManifest);
