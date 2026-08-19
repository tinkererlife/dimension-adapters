import { Dependencies, FetchOptions, SimpleAdapter } from "../../adapters/types";
import { CHAIN } from "../../helpers/chains";
import { queryRollingWeeklyRetention } from "../../helpers/retention";

// Wallet and volume retention (W4/W12) for Courtyard on Polygon.
//
// Event sources match onchain-cohort-analytics/backend/sql/cohort_heatmap.sql:
//   secondary: TradeExecuted  — bidder in topic1, USDC amount in data[33..65)
//   primary:   TokenPurchased — buyer  in topic1, USDC amount in data[97..129)
// Contracts and verified source/ABI:
// - https://polygonscan.com/address/0x5e4943373c2198625bd441ae0629e9e7b4fb4797#code
// - https://polygonscan.com/address/0x7fbf08a0ed3ef12565a61935ca6339bbecc25f48#code
// - https://polygonscan.com/address/0x776023a4573bd972c4c3e2a76f611d3c2bef516e#code
// - Polygon USDC: https://polygonscan.com/token/0x3c499c542cef5e3811e1192ce70d8cc03d5c3359
const USDC = "0x3c499c542cef5e3811e1192ce70d8cc03d5c3359";
const SECONDARY_CONTRACTS = [
  "0x5e4943373c2198625bd441ae0629e9e7b4fb4797",
  "0x7fbf08a0ed3ef12565a61935ca6339bbecc25f48",
];
const SECONDARY_TOPIC0 = "0xa6ae807740439025f50884311ce0f96f5c3809a8f7170f9459dab1b14c9d8afd";
const PRIMARY_CONTRACT = "0x776023a4573bd972c4c3e2a76f611d3c2bef516e";
const PRIMARY_TOPIC0 = "0x3ac06088fd2f047b705cf81c76a5be8b7d378860415de575a9974868ca188980";
const OBSERVATION_START = "2026-01-01";
const FIRST_COHORT_START = "2026-01-01";
const REPORTING_START = "2026-02-04";

const fetch = async (options: FetchOptions) => {
  // Dune EVM addresses are varbinary literals, so these must not be quoted.
  const contractsIn = SECONDARY_CONTRACTS.join(", ");
  const rawEventsSql = `
  SELECT lower(concat('evm:0x', to_hex(bytearray_substring(l.topic1,13,20)))) AS wallet,
         l.block_time AS activity_time,
         cast(varbinary_to_uint256(bytearray_substring(l.data,33,32)) AS double)/1e6 AS usd
  FROM polygon.logs l CROSS JOIN params p
  WHERE l.block_date >= date '${OBSERVATION_START}' AND l.block_time < p.return_window_end
    AND l.contract_address IN (${contractsIn})
    AND l.topic0 = ${SECONDARY_TOPIC0}
    AND bytearray_substring(l.data,13,20) = ${USDC}
  UNION ALL
  SELECT lower(concat('evm:0x', to_hex(bytearray_substring(l.topic1,13,20)))),
         l.block_time,
         cast(varbinary_to_uint256(bytearray_substring(l.data,97,32)) AS double)/1e6
  FROM polygon.logs l CROSS JOIN params p
  WHERE l.block_date >= date '${OBSERVATION_START}' AND l.block_time < p.return_window_end
    AND l.contract_address = ${PRIMARY_CONTRACT}
    AND l.topic0 = ${PRIMARY_TOPIC0}
    AND bytearray_substring(l.data,77,20) = ${USDC}
  `;
  return queryRollingWeeklyRetention(options, {
    cohortStart: FIRST_COHORT_START,
    rawEventsSql,
  });
};

const adapter: SimpleAdapter = {
  version: 1,
  fetch,
  chains: [CHAIN.POLYGON],
  dependencies: [Dependencies.DUNE],
  isExpensiveAdapter: true,
  start: REPORTING_START,
  methodology:
    "Daily rolling weekly cohort retention for Courtyard on Polygon. Each daily row ends a complete seven-day return window; W4 and W12 compare it with the same seven-day window shifted 4 or 12 weeks earlier. The cohort contains wallets whose first observed primary or secondary Courtyard purchase occurred in that earlier window. Activity is observed from 2026-01-01.",
};

export default adapter;
