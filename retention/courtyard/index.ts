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
// The marketplace and minter contracts are read from the same on-chain role
// registry fees/courtyard uses - today only three of the fourteen registered
// addresses emit these events, but two of them only joined in Sep/Oct 2025, and
// a hardcoded list would read the next such rollout as churn.
// https://polygonscan.com/address/0x251be3a17af4892035c37ebf5890f4a4d889dcad#code
const REGISTRY = "0x251be3a17af4892035c37ebf5890f4a4d889dcad";
const abis = {
  listTrustedOperatorRoleMembers: "function listTrustedOperatorRoleMembers() view returns (address[])",
  listTrustedForwarderRoleMembers: "function listTrustedForwarderRoleMembers() view returns (address[])",
  listMinterRoleMembers: "function listMinterRoleMembers() view returns (address[])",
};

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
  const operators = await context.api.call({ target: REGISTRY, abi: abis.listTrustedOperatorRoleMembers });
  const forwarders = await context.api.call({ target: REGISTRY, abi: abis.listTrustedForwarderRoleMembers });
  const minterMembers = await context.api.call({ target: REGISTRY, abi: abis.listMinterRoleMembers });
  const marketplaces = [...new Set([...operators, ...forwarders].map((a: string) => a.toLowerCase()))];
  const minters = [...new Set(minterMembers.map((a: string) => a.toLowerCase()))];
  if (!marketplaces.length || !minters.length)
    throw new Error(`Courtyard registry returned ${marketplaces.length} marketplace and ${minters.length} minter addresses`);

  // Dune EVM addresses are varbinary literals, so they must not be quoted.
  const rows = await context.queryDuneSql<DuneActivityRow>(`
SELECT day, wallet, sum(volume_usd) AS volume_usd
FROM (
  SELECT cast(date_trunc('day', l.block_time) AS date) AS day,
         lower(concat('0x', to_hex(bytearray_substring(l.topic1,13,20)))) AS wallet,
         cast(varbinary_to_uint256(bytearray_substring(l.data,97,32)) AS double)/1e6 AS volume_usd
  FROM polygon.logs l
  WHERE l.block_date >= date '${range.fromDay}' AND l.block_date < date '${range.toDayExclusive}'
    AND l.contract_address IN (${minters.join(", ")})
    AND l.topic0 = ${TOKEN_PURCHASED_AND_MINTED}
    AND bytearray_substring(l.data,77,20) = ${USDC}
  UNION ALL
  SELECT cast(date_trunc('day', l.block_time) AS date),
         lower(concat('0x', to_hex(bytearray_substring(l.topic1,13,20)))),
         cast(varbinary_to_uint256(bytearray_substring(l.data,33,32)) AS double)/1e6
  FROM polygon.logs l
  WHERE l.block_date >= date '${range.fromDay}' AND l.block_date < date '${range.toDayExclusive}'
    AND l.contract_address IN (${marketplaces.join(", ")})
    AND l.topic0 = ${TRADE_EXECUTED}
    AND bytearray_substring(l.data,13,20) = ${USDC}
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
