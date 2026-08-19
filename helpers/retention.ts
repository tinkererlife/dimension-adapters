import { FetchOptions, FetchResultRetention } from "../adapters/types";
import { queryDuneSql } from "./dune";

interface RollingWeeklyRetentionQuery {
  cohortStart: string;
  rawEventsSql: string;
}

/**
 * Runs a daily rolling W4/W12 cohort query over complete seven-day windows.
 *
 * The adapter timestamp is the last day of the return window. The corresponding
 * cohort windows are the same seven-day interval shifted 4 and 12 weeks back.
 */
export async function queryRollingWeeklyRetention(
  options: FetchOptions,
  { cohortStart, rawEventsSql }: RollingWeeklyRetentionQuery,
): Promise<FetchResultRetention> {
  const cohortStartTimestamp = Date.parse(`${cohortStart}T00:00:00Z`) / 1_000;
  if (!Number.isInteger(cohortStartTimestamp)) throw new Error(`Invalid cohort start date: ${cohortStart}`);

  const day = 86400;
  const returnWindowStart = options.startOfDay - 6 * day;
  const returnWindowEnd = options.startOfDay + day;
  const w4CohortStart = returnWindowStart - 4 * 7 * day;
  const w4CohortEnd = returnWindowEnd - 4 * 7 * day;
  const w12CohortStart = returnWindowStart - 12 * 7 * day;
  const w12CohortEnd = returnWindowEnd - 12 * 7 * day;

  const query = `
WITH
params AS (
  SELECT
    from_unixtime(${returnWindowStart}) AS return_window_start,
    from_unixtime(${returnWindowEnd}) AS return_window_end,
    from_unixtime(${w4CohortStart}) AS w4_cohort_start,
    from_unixtime(${w4CohortEnd}) AS w4_cohort_end,
    from_unixtime(${w12CohortStart}) AS w12_cohort_start,
    from_unixtime(${w12CohortEnd}) AS w12_cohort_end,
    from_unixtime(${cohortStartTimestamp}) AS first_cohort_start
),
raw_events AS (
${rawEventsSql}
),
wallet_activity AS (
  SELECT
    e.wallet,
    min(e.activity_time) AS first_activity,
    sum(CASE WHEN e.activity_time >= p.w4_cohort_start AND e.activity_time < p.w4_cohort_end THEN e.usd ELSE 0 END) AS w4_cohort_volume,
    sum(CASE WHEN e.activity_time >= p.w12_cohort_start AND e.activity_time < p.w12_cohort_end THEN e.usd ELSE 0 END) AS w12_cohort_volume,
    sum(CASE WHEN e.activity_time >= p.return_window_start AND e.activity_time < p.return_window_end THEN e.usd ELSE 0 END) AS return_volume
  FROM raw_events e
  CROSS JOIN params p
  WHERE e.usd > 0
  GROUP BY 1
)
SELECT
  CASE WHEN p.return_window_end <= current_timestamp AND p.w4_cohort_start >= p.first_cohort_start
       THEN count_if(a.first_activity >= p.w4_cohort_start AND a.first_activity < p.w4_cohort_end) END AS w4_cohort_wallets,
  CASE WHEN p.return_window_end <= current_timestamp AND p.w4_cohort_start >= p.first_cohort_start
       THEN count_if(a.first_activity >= p.w4_cohort_start AND a.first_activity < p.w4_cohort_end AND a.return_volume > 0) END AS w4_returned_wallets,
  CASE WHEN p.return_window_end <= current_timestamp AND p.w4_cohort_start >= p.first_cohort_start
       THEN coalesce(sum(CASE WHEN a.first_activity >= p.w4_cohort_start AND a.first_activity < p.w4_cohort_end THEN a.w4_cohort_volume END), 0) END AS w4_cohort_volume,
  CASE WHEN p.return_window_end <= current_timestamp AND p.w4_cohort_start >= p.first_cohort_start
       THEN coalesce(sum(CASE WHEN a.first_activity >= p.w4_cohort_start AND a.first_activity < p.w4_cohort_end THEN a.return_volume END), 0) END AS w4_returned_volume,
  CASE WHEN p.return_window_end <= current_timestamp AND p.w12_cohort_start >= p.first_cohort_start
       THEN count_if(a.first_activity >= p.w12_cohort_start AND a.first_activity < p.w12_cohort_end) END AS w12_cohort_wallets,
  CASE WHEN p.return_window_end <= current_timestamp AND p.w12_cohort_start >= p.first_cohort_start
       THEN count_if(a.first_activity >= p.w12_cohort_start AND a.first_activity < p.w12_cohort_end AND a.return_volume > 0) END AS w12_returned_wallets,
  CASE WHEN p.return_window_end <= current_timestamp AND p.w12_cohort_start >= p.first_cohort_start
       THEN coalesce(sum(CASE WHEN a.first_activity >= p.w12_cohort_start AND a.first_activity < p.w12_cohort_end THEN a.w12_cohort_volume END), 0) END AS w12_cohort_volume,
  CASE WHEN p.return_window_end <= current_timestamp AND p.w12_cohort_start >= p.first_cohort_start
       THEN coalesce(sum(CASE WHEN a.first_activity >= p.w12_cohort_start AND a.first_activity < p.w12_cohort_end THEN a.return_volume END), 0) END AS w12_returned_volume
FROM params p
LEFT JOIN wallet_activity a ON true
GROUP BY p.return_window_end, p.w4_cohort_start, p.w4_cohort_end, p.w12_cohort_start, p.w12_cohort_end, p.first_cohort_start
  `;

  const rows = await queryDuneSql(options, query);
  const result = rows?.[0] ?? {};
  const numberOrUndefined = (value: unknown) => value == null ? undefined : Number(value);

  return {
    dailyRetentionW4CohortWallets: numberOrUndefined(result.w4_cohort_wallets),
    dailyRetentionW4ReturnedWallets: numberOrUndefined(result.w4_returned_wallets),
    dailyRetentionW4CohortVolume: numberOrUndefined(result.w4_cohort_volume),
    dailyRetentionW4ReturnedVolume: numberOrUndefined(result.w4_returned_volume),
    dailyRetentionW12CohortWallets: numberOrUndefined(result.w12_cohort_wallets),
    dailyRetentionW12ReturnedWallets: numberOrUndefined(result.w12_returned_wallets),
    dailyRetentionW12CohortVolume: numberOrUndefined(result.w12_cohort_volume),
    dailyRetentionW12ReturnedVolume: numberOrUndefined(result.w12_returned_volume),
  };
}
