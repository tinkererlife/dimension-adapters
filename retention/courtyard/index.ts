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
// Marketplace and minter membership is reconstructed from RoleGranted and
// RoleRevoked logs emitted by the same on-chain registry fees/courtyard uses.
// This keeps the query Dune-only while preserving the membership that applied
// when each purchase happened; using today's registry state for old purchases
// would incorrectly erase activity from contracts that were later revoked.
// https://polygonscan.com/address/0x251be3a17af4892035c37ebf5890f4a4d889dcad#code
const REGISTRY = "0x251be3a17af4892035c37ebf5890f4a4d889dcad";
// The proxy was deployed on 2023-07-23, so this lower bound includes its
// initializer grants and lets Dune prune older Polygon log partitions.
const REGISTRY_DEPLOYMENT_DAY = "2023-07-23";
const ROLE_GRANTED = "0x2f8788117e7eff1d82e926ec794901d17c78024a50270940304540a733656f0d";
const ROLE_REVOKED = "0xf6391f5c32d9c69d2a47ea670b442974b53935d1edc7fd64eb21e047a839171b";
const MINTER_ROLE = "0x9f2df0fed2c77648de5860a4cc508cd0818c85b8b8a1ab4ceeef8d981c8956a6";
const TRUSTED_OPERATOR_ROLE = "0x41c4ce85041f61d74dbc163195f4901b81f46e99d2a521a7b7f6d3a09da4f8c1";
const TRUSTED_FORWARDER_ROLE = "0xd3df22cd6a774f62b0ae21ffd602cc92e7f3390518eee8b33307fc70380da7d2";

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
  const rows = await context.queryDuneSql<DuneActivityRow>(`
WITH role_changes AS (
  SELECT l.block_number,
         l."index" AS log_index,
         l.topic1 AS role,
         bytearray_substring(l.topic2, 13, 20) AS account,
         l.topic0 = ${ROLE_GRANTED} AS granted
  FROM polygon.logs l
  WHERE l.block_date >= date '${REGISTRY_DEPLOYMENT_DAY}'
    AND l.block_date < date '${range.toDayExclusive}'
    AND l.contract_address = ${REGISTRY}
    AND l.topic0 IN (${ROLE_GRANTED}, ${ROLE_REVOKED})
    AND l.topic1 IN (${MINTER_ROLE}, ${TRUSTED_OPERATOR_ROLE}, ${TRUSTED_FORWARDER_ROLE})
), role_periods AS (
  SELECT role,
         account,
         granted,
         block_number AS active_from_block,
         log_index AS active_from_index,
         lead(block_number) OVER (
           PARTITION BY role, account ORDER BY block_number, log_index
         ) AS active_until_block,
         lead(log_index) OVER (
           PARTITION BY role, account ORDER BY block_number, log_index
         ) AS active_until_index
  FROM role_changes
), purchase_events AS (
  SELECT DISTINCT l.tx_hash,
         l."index" AS log_index,
         cast(date_trunc('day', l.block_time) AS date) AS day,
         lower(concat('0x', to_hex(bytearray_substring(l.topic1, 13, 20)))) AS wallet,
         cast(varbinary_to_uint256(bytearray_substring(l.data, 97, 32)) AS double) / 1e6 AS volume_usd
  FROM polygon.logs l
  JOIN role_periods role
    ON role.role = ${MINTER_ROLE}
   AND role.granted
   AND role.account = l.contract_address
   AND (
     l.block_number > role.active_from_block
     OR (l.block_number = role.active_from_block AND l."index" > role.active_from_index)
   )
   AND (
     role.active_until_block IS NULL
     OR l.block_number < role.active_until_block
     OR (l.block_number = role.active_until_block AND l."index" < role.active_until_index)
   )
  WHERE l.block_date >= date '${range.fromDay}' AND l.block_date < date '${range.toDayExclusive}'
    AND l.topic0 = ${TOKEN_PURCHASED_AND_MINTED}
    AND bytearray_substring(l.data, 77, 20) = ${USDC}

  UNION ALL

  SELECT DISTINCT l.tx_hash,
         l."index" AS log_index,
         cast(date_trunc('day', l.block_time) AS date) AS day,
         lower(concat('0x', to_hex(bytearray_substring(l.topic1, 13, 20)))) AS wallet,
         cast(varbinary_to_uint256(bytearray_substring(l.data, 33, 32)) AS double) / 1e6 AS volume_usd
  FROM polygon.logs l
  JOIN role_periods role
    ON role.role IN (${TRUSTED_OPERATOR_ROLE}, ${TRUSTED_FORWARDER_ROLE})
   AND role.granted
   AND role.account = l.contract_address
   AND (
     l.block_number > role.active_from_block
     OR (l.block_number = role.active_from_block AND l."index" > role.active_from_index)
   )
   AND (
     role.active_until_block IS NULL
     OR l.block_number < role.active_until_block
     OR (l.block_number = role.active_until_block AND l."index" < role.active_until_index)
   )
  WHERE l.block_date >= date '${range.fromDay}' AND l.block_date < date '${range.toDayExclusive}'
    AND l.topic0 = ${TRADE_EXECUTED}
    AND bytearray_substring(l.data, 13, 20) = ${USDC}
)
SELECT day, wallet, sum(volume_usd) AS volume_usd
FROM purchase_events
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
