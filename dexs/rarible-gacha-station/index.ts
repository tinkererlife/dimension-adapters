import { Dependencies, FetchOptions, FetchResult, SimpleAdapter } from "../../adapters/types";
import { CHAIN } from "../../helpers/chains";
import { queryAllium } from "../../helpers/allium";

// Rarible routes Gacha Station purchases through Collector Crypt's settlement
// wallet. Example $151 open: https://solscan.io/tx/28ehD8MmZxxrA6osfdMnUM8vSJqVMQSp5i9QrTRXLtLd7upeRbZ5enjQUGFe58V18qERa1Nhz8ncJipmaXo5Njyh
const GACHA_ADDRESS = "GachaNgyXTU3zFogQ8Z5jR2BLXs8215X2AtEH18VxJq3";
const USDC_MINT = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";

// Pack prices offered at https://rarible.com/gacha. The $151 Pokemon pack is
// Rarible-exclusive; the other stations use Collector Crypt's standard tiers.
const PACK_TIERS = [25, 50, 75, 100, 151, 250, 1000];

const timeRange = (options: FetchOptions) =>
  `block_timestamp >= TO_TIMESTAMP_NTZ(${options.startTimestamp}) AND block_timestamp < TO_TIMESTAMP_NTZ(${options.endTimestamp})`;

const fetch = async (options: FetchOptions): Promise<FetchResult> => {
  const dailyVolume = options.createBalances();
  const dailyFees = options.createBalances();

  const tierColumns = PACK_TIERS.map(
    (tier) =>
      `COALESCE(SUM(CASE WHEN action IN ('open', 'gift') AND inflow = ${tier} THEN inflow ELSE 0 END), 0) AS pack_sales_${tier}`,
  ).join(",\n      ");

  const query = `
    WITH flows AS (
      SELECT
        txn_id,
        SUM(CASE WHEN to_address = '${GACHA_ADDRESS}' THEN amount ELSE 0 END) AS inflow,
        SUM(CASE WHEN from_address = '${GACHA_ADDRESS}' THEN amount ELSE 0 END) AS outflow
      FROM solana.assets.transfers
      WHERE mint = '${USDC_MINT}'
        AND (to_address = '${GACHA_ADDRESS}' OR from_address = '${GACHA_ADDRESS}')
        AND ${timeRange(options)}
      GROUP BY txn_id
    ),
    memos AS (
      SELECT
        txn_id,
        REGEXP_SUBSTR(
          array_join(log_messages, '||'),
          'Memo \\\\(len [0-9]+\\\\): "([^"]+)"',
          1, 1, 'e', 1
        ) AS memo
      FROM solana.raw.transactions
      WHERE ${timeRange(options)}
        AND txn_id IN (SELECT txn_id FROM flows)
    ),
    events AS (
      SELECT
        f.inflow,
        f.outflow,
        REGEXP_SUBSTR(m.memo, ':([a-z]+)', 1, 1, 'e', 1) AS action
      FROM flows f
      JOIN memos m ON f.txn_id = m.txn_id
      WHERE m.memo LIKE 'rare-%'
    )
    SELECT
      ${tierColumns},
      COALESCE(SUM(CASE
        WHEN action IN ('open', 'gift') AND inflow NOT IN (${PACK_TIERS.join(", ")}) THEN inflow
        ELSE 0
      END), 0) AS pack_sales_other,
      COALESCE(SUM(CASE WHEN action = 'buyback' THEN outflow ELSE 0 END), 0) AS buybacks,
      COALESCE(SUM(CASE WHEN action = 'refund' THEN outflow ELSE 0 END), 0) AS refunds
    FROM events
  `;

  const result = (await queryAllium(query))[0] || {};

  for (const tier of PACK_TIERS) {
    const sales = Number(result[`pack_sales_${tier}`] || 0);
    if (!sales) continue;
    const label = `Gacha $${tier} Pack Sales`;
    dailyVolume.addUSDValue(sales, label);
    dailyFees.addUSDValue(sales, label);
  }

  const otherSales = Number(result.pack_sales_other || 0);
  if (otherSales) {
    dailyVolume.addUSDValue(otherSales, "Other Gacha Pack Sales");
    dailyFees.addUSDValue(otherSales, "Other Gacha Pack Sales");
  }

  const buybacks = Number(result.buybacks || 0);
  if (buybacks) dailyFees.addUSDValue(-buybacks, "Pack Buyback Spends");

  const refunds = Number(result.refunds || 0);
  if (refunds) dailyFees.addUSDValue(-refunds, "Pack Refunds");

  return {
    dailyVolume,
    dailyFees,
    dailyRevenue: dailyFees,
    dailyUserFees: dailyFees,
    dailyProtocolRevenue: dailyFees,
  };
};

const packSalesBreakdown = Object.fromEntries([
  ...PACK_TIERS.map((tier) => [
    `Gacha $${tier} Pack Sales`,
    `Rarible Gacha Station pack sales at $${tier}.`,
  ]),
  ["Other Gacha Pack Sales", "Rarible Gacha Station pack sales outside the currently listed price tiers."],
]);

const netRevenueBreakdown = {
  ...packSalesBreakdown,
  "Pack Buyback Spends": "USDC paid to users who sell cards back through a Gacha Station buyback offer.",
  "Pack Refunds": "USDC returned when a Gacha Station pack purchase is refunded.",
};

const adapter: SimpleAdapter = {
  version: 2,
  fetch,
  pullHourly: true,
  start: "2026-06-21",
  chains: [CHAIN.SOLANA],
  dependencies: [Dependencies.ALLIUM],
  isExpensiveAdapter: true,
  methodology: {
    Volume:
      "Gross USDC spent on Rarible Gacha Station pack openings and gift packs, identified by rare-prefixed onchain memos.",
    Fees: "Gross pack sales minus USDC paid through Gacha Station buyback offers and pack refunds.",
    Revenue: "Gross pack sales minus Gacha Station buyback payouts and pack refunds.",
    UserFees: "Users' net spend on Gacha Station packs after buyback payouts and pack refunds.",
    ProtocolRevenue:
      "Net Gacha Station revenue before any private revenue split between Rarible and Collector Crypt.",
  },
  breakdownMethodology: {
    Volume: packSalesBreakdown,
    Fees: netRevenueBreakdown,
    Revenue: netRevenueBreakdown,
    UserFees: netRevenueBreakdown,
    ProtocolRevenue: netRevenueBreakdown,
  },
  allowNegativeValue: true, // buyback payouts and refunds can exceed pack sales within a reporting window
  doublecounted: true, // settles through and overlaps with collector-crypt
};

export default adapter;
