// The search log and its reports (brainstorm 5.1). Each search a reader types is
// one row (query text, result count, time) plus a count in `search_daily`; the
// first doc they open from the results is added to the row. There is no IP
// address and no session id anywhere in these tables, because anonymous queries
// can hold sensitive text.
//
// The miss rate is the share of searches that ended with no click (zero results
// included). It is a quality indicator, not a gate (brainstorm 5.1).

import { log, errorFields } from '../logger.js';

export const REPORT_DAYS = 30;
export const MISS_THRESHOLD = 0.15;
export const MIN_SEARCHES = 100;
export const QUERY_LOG_MAX = 200;
const TOP_LIMIT = 25;

// A failed log write is logged but never stops the search it belongs to.
// Resolves to the log row id, or null when it could not be written.
export async function recordSearch(pool, { queryText, resultCount, partial }) {
  try {
    const [result] = await pool.query(
      'INSERT INTO search_log (query_text, result_count, partial) VALUES (?, ?, ?)',
      [String(queryText).slice(0, QUERY_LOG_MAX), resultCount, partial ? 1 : 0],
    );
    await pool.query(
      `INSERT INTO search_daily (day, searches, zero_results) VALUES (CURDATE(), 1, ?)
       ON DUPLICATE KEY UPDATE searches = searches + 1, zero_results = zero_results + VALUES(zero_results)`,
      [resultCount === 0 ? 1 : 0],
    );
    return Number(result.insertId);
  } catch (err) {
    log.error('search log write failed', errorFields(err));
    return null;
  }
}

// Notes that the doc was opened from the results of search `logId`. Only the
// first click of a search counts, and it is counted on the day of the search.
// Resolves to true when a click was recorded.
export async function recordClick(pool, { logId, docId }) {
  try {
    const [result] = await pool.query(
      'UPDATE search_log SET clicked_doc_id = ?, clicked_at = NOW() WHERE id = ? AND result_count > 0 AND clicked_doc_id IS NULL',
      [docId, logId],
    );
    if (result.affectedRows !== 1) return false;
    await pool.query(
      `UPDATE search_daily d JOIN search_log l ON d.day = DATE(l.created_at)
          SET d.clicked = d.clicked + 1 WHERE l.id = ?`,
      [logId],
    );
    return true;
  } catch (err) {
    log.error('search click write failed', errorFields(err));
    return false;
  }
}

// Deletes log rows older than the retention limit. The per-day counts stay.
export async function pruneSearchLog(pool, retentionDays) {
  const [result] = await pool.query('DELETE FROM search_log WHERE created_at < NOW() - INTERVAL ? DAY', [retentionDays]);
  return result.affectedRows;
}

// { windowDays, searches, zeroResults, noClick, clicked, missRate, enough, over,
//   zeroQueries, noClickQueries } for the last REPORT_DAYS days. missRate is
// null with no searches; enough says there were at least MIN_SEARCHES.
export async function searchReport(pool) {
  const [[totals]] = await pool.query(
    `SELECT COALESCE(SUM(searches), 0) AS searches, COALESCE(SUM(zero_results), 0) AS zero_results,
            COALESCE(SUM(clicked), 0) AS clicked
       FROM search_daily WHERE day > CURDATE() - INTERVAL ? DAY`,
    [REPORT_DAYS],
  );
  const topQueries = async (where) => {
    const [rows] = await pool.query(
      `SELECT query_text, COUNT(*) AS searches, MAX(created_at) AS last_at FROM search_log
        WHERE created_at > NOW() - INTERVAL ? DAY AND ${where}
        GROUP BY query_text ORDER BY searches DESC, last_at DESC LIMIT ?`,
      [REPORT_DAYS, TOP_LIMIT],
    );
    return rows.map((r) => ({ query: r.query_text, searches: Number(r.searches), lastAt: r.last_at }));
  };

  const searches = Number(totals.searches);
  const clicked = Number(totals.clicked);
  const missRate = searches === 0 ? null : (searches - clicked) / searches;
  return {
    windowDays: REPORT_DAYS,
    searches,
    zeroResults: Number(totals.zero_results),
    clicked,
    noClick: Math.max(0, searches - clicked - Number(totals.zero_results)),
    missRate,
    enough: searches >= MIN_SEARCHES,
    over: missRate !== null && missRate > MISS_THRESHOLD,
    zeroQueries: await topQueries('result_count = 0'),
    noClickQueries: await topQueries('result_count > 0 AND clicked_doc_id IS NULL'),
  };
}
