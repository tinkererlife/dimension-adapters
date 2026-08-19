import { Dependencies, FetchOptions, SimpleAdapter } from "../../adapters/types";
import { CHAIN } from "../../helpers/chains";
import { queryRollingWeeklyRetention } from "../../helpers/retention";

// Wallet and volume retention (W4/W12) for Collector Crypt on Solana.
//
// Sources:
// - Sink label and transfers: https://solscan.io/account/GachaNgyXTU3zFogQ8Z5jR2BLXs8215X2AtEH18VxJq3
// - First sink transaction (2025-12-07): https://solscan.io/tx/2iSpTcqEc85tjD6VJ4i9Q9NCvEdf8pZ3axSw287FSmpgVahpErv5911ntuALUGxvzYCBTNZ28vhHrXBsJeatXjq6
// - Solana USDC mint: https://solscan.io/token/EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v
// - Team/treasury exclusions: https://github.com/DefiLlama/dimension-adapters/blob/master/fees/collector-crypt/index.ts
const USDC_MINT = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";
const GACHA_SINK = "GachaNgyXTU3zFogQ8Z5jR2BLXs8215X2AtEH18VxJq3";
// The sink went live on Sunday 2025-12-07. Start with the next full UTC week.
const OBSERVATION_START = "2025-12-07";
const FIRST_COHORT_START = "2025-12-08";
// The first rolling W4 return window ends on this date.
const REPORTING_START = "2026-01-11";

const EXCLUDED_WALLETS = [
  "BAxTk97HsaJqbnbFmTiQTaL4KSRvJ8Y65ArZCsP6vA5M",
  "21KhtC7y2JGYvwc8dcGqTdbrudbM8fgMPJsVwxRQqdY8",
  "DFEstpYN3fsz93AC9v2ujzPPngPgodqH2xxopuyfSsAE",
  "HW2HRqN1pXQGH9GfP9xet4XwqtLqFyYGDNRKjUAVgh9u",
  "HighJBfnAaqH9cKkeMErQFJZ4ATxQJwxqFupX6zaKTns",
  "LGNDXqcm6U57QQ6Ad7icZ6oizkAVKRWrw97KwZy5nVf",
  "EpicWWZspT1trKndbDDr29ULViN56rN5vofWSKZp8ePF",
  "Mid9NeCpPNxP59fAdsLgMLy7BYexxXFw52ZP58Jrney",
  "Lowq9dkpY43VpjfYeRjtKfGA6JtB7HaMmwQgXkjHLvN",
  "Low6UekJP3QrFVMfNRTL8CPK2SiGFhvp57sgF2pkmVu",
  "miDtj3vgdxVykHzRyFwyG8MXpvK8eQqamSLVdBr7WPt",
  "HiGHqwYddP5N2waqUmXPdaASpMpUEvfqPr2fSawctEb",
  "epiC3zkqa1RfcPMMM1Kc8m3GZGDwF2RmjbfA3g1BBjn",
  "LGNDfXQFMiRMz3qqTNAREmRFQutMvazqqRrzn5i98uj",
  "SPrT7eFrCM9UJ4j7Xf9iktKCoBwJjfykFbiNbRsKQm8",
  "Cc4pHGnoaRWL1WnHsV517T3YvQn5gLDBMiuVXkF9rZhK",
  "8373hLiAEXxaJ3oV7SRzx4KHwurEg9rEG98tUPj1sdtX",
  "onePMfirJs2Rx3eixoPnjY6NHiaC74pkQ2k313K2Lxs",
  "SportGmqffp9zC3VZV7Wwz6s2nCkEB5Q3nVwKGU4esD",
  "DQPERZ9e86pNJ4mhUnCEP8V75yxZofsipoVrRWT5Wdxd",
  "cc3novbXuNSe292qKH2gGhxToaWjuBvJbA7zQf8NVxi",
  "GachaNgyXTU3zFogQ8Z5jR2BLXs8215X2AtEH18VxJq3",
  "GachazZscHZ5bn3vnq1yEC4zpYdhAYJBzuKJwSJksc9z",
  "96DULv1BqYfe5wyMr6pVUNC6Uyrtj6yr3tNi6VtfwW9s",
  "jrS7Pbn38wKiPsXbyNhGCr3icfXuJxdytZr1N4TwdFu",
];

const fetch = async (options: FetchOptions) => {
  const excludeIn = EXCLUDED_WALLETS.map((a) => `'${a}'`).join(", ");
  const rawEventsSql = `
  SELECT concat('solana:', t.from_owner) AS wallet,
         t.block_time AS activity_time,
         t.amount_display AS usd
  FROM tokens_solana.transfers t CROSS JOIN params p
  WHERE t.block_date >= date '${OBSERVATION_START}' AND t.block_time < p.return_window_end
    AND t.token_mint_address = '${USDC_MINT}'
    AND t.to_owner = '${GACHA_SINK}'
    AND t.from_owner IS NOT NULL
    AND t.from_owner NOT IN (${excludeIn})
  `;
  return queryRollingWeeklyRetention(options, {
    cohortStart: FIRST_COHORT_START,
    rawEventsSql,
  });
};

const adapter: SimpleAdapter = {
  version: 1,
  fetch,
  chains: [CHAIN.SOLANA],
  dependencies: [Dependencies.DUNE],
  isExpensiveAdapter: true,
  start: REPORTING_START,
  methodology:
    "Daily rolling weekly cohort retention for Collector Crypt on Solana. Each daily row ends a complete seven-day return window; W4 and W12 compare it with the same seven-day window shifted 4 or 12 weeks earlier. The cohort contains wallets whose first observed USDC purchase into the gacha sink occurred in that earlier window, with team and treasury wallets excluded. Cohorts begin on 2025-12-08, the first full day after the current sink became active.",
};

export default adapter;
