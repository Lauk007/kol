import http from "node:http";
import https from "node:https";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { URL } from "node:url";
import { DatabaseSync } from "node:sqlite";

const ROOT_DIR = process.cwd();
const DATA_DIR = path.join(ROOT_DIR, "data");
const CONFIG_PATH = path.join(ROOT_DIR, "config.json");
const DEFAULT_CONFIG_PATH = path.join(ROOT_DIR, "config.example.json");

ensureDir(DATA_DIR);

const config = loadConfig();
const db = initDatabase(path.join(DATA_DIR, "monitor.db"));
const state = {
  isRunning: false,
  lastRunStartedAt: null,
  lastRunFinishedAt: null,
  nextRunAt: null,
  lastRunSummary: null
};

const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, `http://${req.headers.host || "localhost"}`);

    if (req.method === "GET" && url.pathname === "/") {
      return sendHtml(res, renderDashboard(config));
    }

    if (req.method === "GET" && url.pathname === "/api/status") {
      return sendJson(res, buildStatusPayload());
    }

    if (req.method === "POST" && url.pathname === "/api/run") {
      const summary = await runMonitor({ source: "manual" });
      return sendJson(res, { ok: true, summary });
    }

    if (req.method === "POST" && url.pathname === "/api/okx-traders") {
      const body = await readJsonBody(req);
      const uniqueName = String(body.uniqueName || "").trim();
      const remark = String(body.remark || "").trim();
      if (!uniqueName) {
        return sendJson(res, { ok: false, error: "uniqueName is required" }, 400);
      }

      const trader = upsertOkxTrader(uniqueName, remark);
      const summary = await pollOkxTraders({ source: "manual_add", targetUniqueName: uniqueName });
      return sendJson(res, { ok: true, trader, summary });
    }

    if (req.method === "DELETE" && url.pathname.startsWith("/api/okx-traders/")) {
      const uniqueName = decodeURIComponent(url.pathname.replace("/api/okx-traders/", "")).trim();
      if (!uniqueName) {
        return sendJson(res, { ok: false, error: "uniqueName is required" }, 400);
      }

      const removed = deleteOkxTrader(uniqueName);
      if (!removed) {
        return sendJson(res, { ok: false, error: "Trader not found" }, 404);
      }

      return sendJson(res, { ok: true, uniqueName });
    }

    sendJson(res, { ok: false, error: "Not Found" }, 404);
  } catch (error) {
    console.error("Request failed:", error);
    sendJson(res, { ok: false, error: error.message }, 500);
  }
});

server.listen(config.port, () => {
  console.log(`Monitor started on http://localhost:${config.port}`);
  scheduleNextRun(1_000);
});

async function runMonitor({ source }) {
  if (state.isRunning) {
    return {
      skipped: true,
      reason: "A polling task is already running.",
      source
    };
  }

  state.isRunning = true;
  state.lastRunStartedAt = new Date().toISOString();

  let summary;

  try {
    const signalSummary = await fetchAndPersist(source);
    const okxSummary = await pollOkxTraders({ source });
    summary = {
      ...signalSummary,
      okx: okxSummary
    };
    state.lastRunSummary = summary;
    return summary;
  } finally {
    state.isRunning = false;
    state.lastRunFinishedAt = new Date().toISOString();
    scheduleNextRun(config.pollIntervalMinutes * 60_000);
  }
}

function scheduleNextRun(delayMs) {
  if (state.timer) {
    clearTimeout(state.timer);
  }

  const nextRunAt = new Date(Date.now() + delayMs);
  state.nextRunAt = nextRunAt.toISOString();

  state.timer = setTimeout(() => {
    runMonitor({ source: "scheduled" }).catch((error) => {
      console.error("Scheduled run failed:", error);
    });
  }, delayMs);
}

function upsertOkxTrader(uniqueName, remark = "") {
  const now = new Date().toISOString();
  db.prepare(
    `
    INSERT INTO okx_traders (
      unique_name,
      display_name,
      remark,
      status,
      created_at,
      updated_at,
      last_checked_at,
      last_error,
      latest_payload
    ) VALUES (?, ?, ?, 'active', ?, ?, NULL, NULL, NULL)
    ON CONFLICT(unique_name) DO UPDATE SET
      remark = CASE
        WHEN excluded.remark <> '' THEN excluded.remark
        ELSE okx_traders.remark
      END,
      status = 'active',
      updated_at = excluded.updated_at
    `
  ).run(uniqueName, uniqueName, remark, now, now);

  return db
    .prepare(
      `
      SELECT id, unique_name, display_name, remark, status, created_at, updated_at
      FROM okx_traders
      WHERE unique_name = ?
      `
    )
      .get(uniqueName);
}

function loadOkxPositionsForTrader(traderId) {
  return db
    .prepare(
      `
      SELECT
        trader_id,
        position_key,
        inst_id,
        side,
        open_avg_px,
        mark_px,
        margin,
        lever,
        pnl,
        updated_at,
        raw_json
      FROM okx_positions
      WHERE trader_id = ?
      ORDER BY id DESC
      `
    )
    .all(traderId);
}

function deleteOkxTrader(uniqueName) {
  const trader = db
    .prepare(
      `
      SELECT id
      FROM okx_traders
      WHERE unique_name = ?
      `
    )
    .get(uniqueName);

  if (!trader) {
    return false;
  }

  try {
    db.exec("BEGIN");
    db.prepare(`DELETE FROM okx_positions WHERE trader_id = ?`).run(trader.id);
    db.prepare(`DELETE FROM okx_traders WHERE id = ?`).run(trader.id);
    db.exec("COMMIT");
    return true;
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
}

async function fetchAndPersist(source) {
  const startedAt = new Date().toISOString();
  const startedTs = Date.now();

  try {
    const payload = await fetchJson(config.signalApiUrl, config.requestTimeoutMs);
    const items = extractSignalItems(payload)
      .map(normalizeItem)
      .filter((item) => !shouldFilterItem(item) && String(item.author || "").trim() !== "群友发言");
    const digest = sha256(JSON.stringify(items.map((item) => item.hash)));

    const previousSuccessfulRun = db
      .prepare(
        `
        SELECT id, response_digest
        FROM fetch_runs
        WHERE success = 1
        ORDER BY id DESC
        LIMIT 1
        `
      )
      .get();

    const runResult = db
      .prepare(
        `
        INSERT INTO fetch_runs (
          started_at,
          finished_at,
          source,
          success,
          http_status,
          total_items,
          new_items,
          changed_items,
          response_digest,
          error_message,
          duration_ms
        ) VALUES (?, ?, ?, 1, 200, ?, 0, 0, ?, NULL, ?)
        RETURNING id
        `
      )
      .get(startedAt, new Date().toISOString(), source, items.length, digest, Date.now() - startedTs);

    const runId = runResult.id;
    const existingMap = loadExistingSignalMap();
    const changes = [];

    const insertSignal = db.prepare(
      `
      INSERT INTO signals (
        signal_key,
        latest_hash,
        title,
        author,
        published_at,
        updated_at,
        source_url,
        latest_payload,
        first_seen_at,
        last_seen_at,
        last_changed_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `
    );

    const updateSignal = db.prepare(
      `
      UPDATE signals
      SET latest_hash = ?,
          title = ?,
          author = ?,
          published_at = ?,
          updated_at = ?,
          source_url = ?,
          latest_payload = ?,
          last_seen_at = ?,
          last_changed_at = ?
      WHERE signal_key = ?
      `
    );

    const touchSignal = db.prepare(
      `
      UPDATE signals
      SET last_seen_at = ?
      WHERE signal_key = ?
      `
    );

    const insertSnapshot = db.prepare(
      `
      INSERT INTO signal_snapshots (
        run_id,
        signal_key,
        payload_hash,
        title,
        author,
        published_at,
        updated_at,
        source_url,
        payload_json
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      `
    );

    let newItems = 0;
    let changedItems = 0;
    const now = new Date().toISOString();

    try {
      db.exec("BEGIN");

      for (const item of items) {
        const existing = existingMap.get(item.key);

        insertSnapshot.run(
          runId,
          item.key,
          item.hash,
          item.title,
          item.author,
          item.publishedAt,
          item.updatedAt,
          item.url,
          item.rawJson
        );

        if (!existing) {
          newItems += 1;
          changes.push({ type: "new", ...item });
          insertSignal.run(
            item.key,
            item.hash,
            item.title,
            item.author,
            item.publishedAt,
            item.updatedAt,
            item.url,
            item.rawJson,
            now,
            now,
            now
          );
          continue;
        }

        if (existing.latest_hash !== item.hash) {
          changedItems += 1;
          changes.push({ type: "changed", ...item });
          updateSignal.run(
            item.hash,
            item.title,
            item.author,
            item.publishedAt,
            item.updatedAt,
            item.url,
            item.rawJson,
            now,
            now,
            item.key
          );
          continue;
        }

        touchSignal.run(now, item.key);
      }
      db.exec("COMMIT");
    } catch (error) {
      db.exec("ROLLBACK");
      throw error;
    }

    db.prepare(
      `
      UPDATE fetch_runs
      SET new_items = ?, changed_items = ?
      WHERE id = ?
      `
    ).run(newItems, changedItems, runId);

    const summary = {
      runId,
      source,
      success: true,
      totalItems: items.length,
      newItems,
      changedItems,
      unchangedItems: items.length - newItems - changedItems,
      digestChanged: previousSuccessfulRun ? previousSuccessfulRun.response_digest !== digest : true,
      finishedAt: new Date().toISOString()
    };

    return summary;
  } catch (error) {
    const finishedAt = new Date().toISOString();
    const durationMs = Date.now() - startedTs;

    const row = db
      .prepare(
        `
        INSERT INTO fetch_runs (
          started_at,
          finished_at,
          source,
          success,
          http_status,
          total_items,
          new_items,
          changed_items,
          response_digest,
          error_message,
          duration_ms
        ) VALUES (?, ?, ?, 0, NULL, 0, 0, 0, NULL, ?, ?)
        RETURNING id
        `
      )
      .get(startedAt, finishedAt, source, error.message, durationMs);

    const summary = {
      runId: row.id,
      source,
      success: false,
      error: error.message,
      finishedAt
    };

    return summary;
  }
}

function buildStatusPayload() {
  const latestRun = db
    .prepare(
      `
      SELECT *
      FROM fetch_runs
      ORDER BY id DESC
      LIMIT 1
      `
    )
    .get();

  const runs = db
    .prepare(
      `
      SELECT id, started_at, finished_at, source, success, total_items, new_items, changed_items, error_message, duration_ms
      FROM fetch_runs
      ORDER BY id DESC
      LIMIT 20
      `
    )
    .all();

  const recentSignals = db
    .prepare(
      `
      SELECT ss.signal_key, ss.title, ss.author, ss.published_at, ss.updated_at, ss.source_url, ss.payload_json
      FROM signal_snapshots ss
      INNER JOIN (
        SELECT id
        FROM fetch_runs
        WHERE success = 1
        ORDER BY id DESC
        LIMIT 1
      ) fr ON ss.run_id = fr.id
      ORDER BY ss.id ASC
      LIMIT 50
      `
    )
    .all();

  const okxTraders = db
    .prepare(
      `
      SELECT
        t.id,
        t.unique_name,
        t.display_name,
        t.remark,
        t.status,
        t.last_checked_at,
        t.last_error,
        t.updated_at,
        COUNT(p.id) AS position_count
      FROM okx_traders t
      LEFT JOIN okx_positions p ON p.trader_id = t.id
      GROUP BY t.id, t.unique_name, t.display_name, t.remark, t.status, t.last_checked_at, t.last_error, t.updated_at
      ORDER BY t.updated_at DESC, t.id DESC
      `
    )
    .all();

  const okxPositions = db
    .prepare(
      `
      SELECT
        p.id,
        p.trader_id,
        t.unique_name,
        t.display_name,
        t.remark,
        p.position_key,
        p.inst_id,
        p.side,
        p.open_avg_px,
        p.mark_px,
        p.margin,
        p.lever,
        p.pnl,
        p.updated_at,
        p.raw_json
      FROM okx_positions p
      INNER JOIN okx_traders t ON t.id = p.trader_id
      ORDER BY t.updated_at DESC, p.updated_at DESC, p.id DESC
      `
    )
    .all();

  return {
    ok: true,
    title: config.dashboardTitle,
    signalApiUrl: config.signalApiUrl,
    polling: {
      intervalMinutes: config.pollIntervalMinutes,
      isRunning: state.isRunning,
      lastRunStartedAt: state.lastRunStartedAt,
      lastRunFinishedAt: state.lastRunFinishedAt,
      nextRunAt: state.nextRunAt,
      lastRunSummary: state.lastRunSummary
    },
    latestRun,
    runs,
    recentSignals,
    okxTraders,
    okxPositions
  };
}

function extractSignalItems(payload) {
  if (Array.isArray(payload)) {
    return payload;
  }

  if (!payload || typeof payload !== "object") {
    return [];
  }

  const candidateKeys = ["data", "list", "items", "rows", "results", "messages"];

  for (const key of candidateKeys) {
    if (Array.isArray(payload[key])) {
      return payload[key];
    }
    if (payload[key] && typeof payload[key] === "object") {
      for (const nestedKey of candidateKeys) {
        if (Array.isArray(payload[key][nestedKey])) {
          return payload[key][nestedKey];
        }
      }
    }
  }

  return [];
}

function normalizeItem(item) {
  const rawJson = stableJson(item);
  const title =
    firstString(item, ["title", "name", "summary", "analysis", "content", "message_content", "desc"]) ||
    "(untitled)";
  const author =
    firstString(item, ["author", "authorName", "author_username", "author_nickname", "nickname", "username", "screenName"]) ||
    "";
  const url = firstString(item, ["url", "link", "sourceUrl", "tweetUrl", "postUrl"]) || "";
  const publishedAt =
    firstString(item, ["publishedAt", "createdAt", "created_at", "createTime", "timestamp", "time"]) ||
    "";
  const updatedAt =
    firstString(item, ["updatedAt", "updated_at", "updateTime", "modifiedAt", "modified_at"]) ||
    publishedAt;
  const identity =
    firstPrimitive(item, ["id", "signalId", "postId", "tweetId", "uuid", "slug"]) ||
    url ||
    title;

  const key = sha256(String(identity)).slice(0, 24);
  const hash = sha256(rawJson);

  return {
    key,
    hash,
    title: title.slice(0, 200),
    author: author.slice(0, 120),
    url: url.slice(0, 500),
    publishedAt: String(publishedAt).slice(0, 64),
    updatedAt: String(updatedAt).slice(0, 64),
    rawJson
  };
}

function shouldFilterItem(item) {
  const author = String(item.author || "").trim();
  return author === "群友发言";
}

async function fetchJson(url, timeoutMs, extraHeaders = {}) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const response = await fetch(url, {
      method: "GET",
      signal: controller.signal,
      headers: {
        Accept: "application/json",
        ...extraHeaders
      }
    });

    const text = await response.text();

    if (!response.ok) {
      throw new Error(`API responded with ${response.status}: ${text.slice(0, 300)}`);
    }

    return JSON.parse(text);
  } finally {
    clearTimeout(timeout);
  }
}

async function readJsonBody(req) {
  const chunks = [];

  for await (const chunk of req) {
    chunks.push(chunk);
  }

  const raw = Buffer.concat(chunks).toString("utf8").trim();
  if (!raw) {
    return {};
  }

  return JSON.parse(raw);
}

async function postJson(url, payload, timeoutMs) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const response = await fetch(url, {
      method: "POST",
      signal: controller.signal,
      headers: {
        "Content-Type": "application/json; charset=utf-8"
      },
      body: JSON.stringify(payload)
    });

    const text = await response.text();
    if (!response.ok) {
      throw new Error(`Webhook responded with ${response.status}: ${text.slice(0, 300)}`);
    }

    const data = text ? JSON.parse(text) : {};
    if (data && typeof data === "object" && Number(data.code || 0) !== 0) {
      throw new Error(data.msg || data.message || "Feishu webhook rejected the request");
    }

    return data;
  } finally {
    clearTimeout(timeout);
  }
}

function requestJsonWithNativeHttp(url, timeoutMs, headers = {}) {
  return new Promise((resolve, reject) => {
    const target = new URL(url);
    const client = target.protocol === "https:" ? https : http;

    const request = client.request(
      target,
      {
        method: "GET",
        headers
      },
      (response) => {
        const chunks = [];

        response.on("data", (chunk) => chunks.push(chunk));
        response.on("end", () => {
          const text = Buffer.concat(chunks).toString("utf8");

          if ((response.statusCode || 500) >= 400) {
            reject(new Error(`HTTP ${response.statusCode}: ${text.slice(0, 300)}`));
            return;
          }

          try {
            resolve(JSON.parse(text));
          } catch (error) {
            reject(new Error(`响应不是合法 JSON: ${text.slice(0, 300)}`));
          }
        });
      }
    );

    request.setTimeout(timeoutMs, () => {
      request.destroy(new Error(`连接超时，${timeoutMs}ms 内未拿到 OKX 响应`));
    });

    request.on("error", (error) => {
      reject(error);
    });

    request.end();
  });
}

function initDatabase(dbPath) {
  const database = new DatabaseSync(dbPath);
  database.exec(`
    CREATE TABLE IF NOT EXISTS fetch_runs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      started_at TEXT NOT NULL,
      finished_at TEXT NOT NULL,
      source TEXT NOT NULL,
      success INTEGER NOT NULL,
      http_status INTEGER,
      total_items INTEGER NOT NULL DEFAULT 0,
      new_items INTEGER NOT NULL DEFAULT 0,
      changed_items INTEGER NOT NULL DEFAULT 0,
      response_digest TEXT,
      error_message TEXT,
      duration_ms INTEGER
    );

    CREATE TABLE IF NOT EXISTS signals (
      signal_key TEXT PRIMARY KEY,
      latest_hash TEXT NOT NULL,
      title TEXT,
      author TEXT,
      published_at TEXT,
      updated_at TEXT,
      source_url TEXT,
      latest_payload TEXT NOT NULL,
      first_seen_at TEXT NOT NULL,
      last_seen_at TEXT NOT NULL,
      last_changed_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS signal_snapshots (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      run_id INTEGER NOT NULL,
      signal_key TEXT NOT NULL,
      payload_hash TEXT NOT NULL,
      title TEXT,
      author TEXT,
      published_at TEXT,
      updated_at TEXT,
      source_url TEXT,
      payload_json TEXT NOT NULL,
      FOREIGN KEY(run_id) REFERENCES fetch_runs(id)
    );

    CREATE TABLE IF NOT EXISTS okx_traders (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      unique_name TEXT NOT NULL UNIQUE,
      display_name TEXT NOT NULL,
      remark TEXT NOT NULL DEFAULT '',
      status TEXT NOT NULL DEFAULT 'active',
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      last_checked_at TEXT,
      last_error TEXT,
      latest_payload TEXT
    );

    CREATE TABLE IF NOT EXISTS okx_positions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      trader_id INTEGER NOT NULL,
      position_key TEXT NOT NULL,
      inst_id TEXT,
      side TEXT,
      open_avg_px TEXT,
      mark_px TEXT,
      pos TEXT,
      margin TEXT,
      lever TEXT,
      pnl TEXT,
      updated_at TEXT,
      raw_json TEXT NOT NULL,
      FOREIGN KEY(trader_id) REFERENCES okx_traders(id),
      UNIQUE(trader_id, position_key)
    );

  `);

  try {
    database.exec("ALTER TABLE signals ADD COLUMN updated_at TEXT");
  } catch {}

  try {
    database.exec("ALTER TABLE signal_snapshots ADD COLUMN updated_at TEXT");
  } catch {}

  try {
    database.exec("ALTER TABLE okx_traders ADD COLUMN remark TEXT NOT NULL DEFAULT ''");
  } catch {}

  try {
    database.exec("ALTER TABLE okx_positions ADD COLUMN margin TEXT");
  } catch {}

  return database;
}

async function pollOkxTraders({ source, targetUniqueName = "" }) {
  const traders = targetUniqueName
    ? db
        .prepare(
          `
          SELECT id, unique_name, display_name, remark
          FROM okx_traders
          WHERE unique_name = ? AND status = 'active'
          `
        )
        .all(targetUniqueName)
    : db
        .prepare(
          `
          SELECT id, unique_name, display_name, remark
          FROM okx_traders
          WHERE status = 'active'
          ORDER BY id DESC
          `
        )
        .all();

  if (traders.length === 0) {
    return {
      source,
      monitoredTraders: 0,
      checkedTraders: 0,
      totalPositions: 0
    };
  }

  let checkedTraders = 0;
  let totalPositions = 0;
  const errors = [];
  let pushCount = 0;

  for (const trader of traders) {
    try {
      const payload = await fetchOkxPositionSummary(trader.unique_name);
      const positions = extractOkxPositionItems(payload).map((item) =>
        normalizeOkxPosition(item, trader.unique_name, payload.__okxSource || "trader")
      );
      const previousPositions = loadOkxPositionsForTrader(trader.id);
      const changeSet = buildOkxChangeSet(previousPositions, positions);
      persistOkxTraderSnapshot(trader, payload, positions);
      if (shouldPushOkxChange(source, previousPositions, changeSet)) {
        try {
          await pushOkxChangeNotification(trader, changeSet);
          pushCount += 1;
        } catch (error) {
          errors.push({
            uniqueName: trader.unique_name,
            error: `Feishu push failed: ${error.message}`
          });
          console.error(`[Feishu] Push failed uniqueName=${trader.unique_name} error=${error.message}`);
        }
      }
      checkedTraders += 1;
      totalPositions += positions.length;
    } catch (error) {
      errors.push({ uniqueName: trader.unique_name, error: error.message });
      db.prepare(
        `
        UPDATE okx_traders
        SET last_checked_at = ?, last_error = ?, updated_at = ?
        WHERE id = ?
        `
      ).run(new Date().toISOString(), error.message, new Date().toISOString(), trader.id);
    }
  }

  return {
    source,
    monitoredTraders: traders.length,
    checkedTraders,
    totalPositions,
    pushCount,
    errors
  };
}

async function fetchOkxPositionSummary(uniqueName) {
  const primaryUrl =
    `https://www.okx.com/priapi/v5/ecotrade/public/trader/position-summary` +
    `?instType=SWAP&uniqueName=${encodeURIComponent(uniqueName)}`;
  const fallbackUrl =
    `https://www.okx.com/priapi/v5/ecotrade/public/community/user/position-current` +
    `?uniqueName=${encodeURIComponent(uniqueName)}`;
  const startedAt = Date.now();

  console.log(`[OKX] Requesting ${primaryUrl}`);

  try {
    const primaryPayload = await requestJsonWithNativeHttp(primaryUrl, config.requestTimeoutMs, {
      Accept: "application/json, text/plain, */*",
      "User-Agent": "Mozilla/5.0",
      Referer: `https://www.okx.com/zh-hans/copy-trading/account/${encodeURIComponent(uniqueName)}?tab=swap`,
      Origin: "https://www.okx.com"
    });

    if (shouldUseOkxCommunityFallback(primaryPayload)) {
      console.log(`[OKX] Switching to fallback endpoint uniqueName=${uniqueName} url=${fallbackUrl}`);
      const fallbackPayload = await requestJsonWithNativeHttp(fallbackUrl, config.requestTimeoutMs, {
        Accept: "application/json, text/plain, */*",
        "User-Agent": "Mozilla/5.0",
        Referer: `https://www.okx.com/zh-hans/copy-trading/account/${encodeURIComponent(uniqueName)}?tab=swap`,
        Origin: "https://www.okx.com"
      });
      fallbackPayload.__okxSource = "community";
      const fallbackCount = extractOkxPositionItems(fallbackPayload).length;
      console.log(
        `[OKX] Success via fallback uniqueName=${uniqueName} positions=${fallbackCount} durationMs=${Date.now() - startedAt}`
      );
      return fallbackPayload;
    }

    primaryPayload.__okxSource = "trader";
    const count = extractOkxPositionItems(primaryPayload).length;
    console.log(`[OKX] Success uniqueName=${uniqueName} positions=${count} durationMs=${Date.now() - startedAt}`);
    return primaryPayload;
  } catch (error) {
    console.error(`[OKX] Failed uniqueName=${uniqueName} durationMs=${Date.now() - startedAt} error=${error.message}`);
    throw new Error(`OKX 抓取失败: ${error.message}`);
  }
}

function shouldUseOkxCommunityFallback(payload) {
  if (!payload || typeof payload !== "object") {
    return false;
  }

  return String(payload.code || "").trim() === "59243";
}

function extractOkxPositionItems(payload) {
  if (Array.isArray(payload)) {
    return payload;
  }

  if (!payload || typeof payload !== "object") {
    return [];
  }

  if (
    payload.__okxSource === "community" &&
    Array.isArray(payload.data)
  ) {
    return payload.data.flatMap((group) => (Array.isArray(group?.posData) ? group.posData : []));
  }

  if (Array.isArray(payload.data)) {
    return payload.data;
  }

  if (payload.data && typeof payload.data === "object") {
    for (const key of ["list", "positions", "items", "holdingList"]) {
      if (Array.isArray(payload.data[key])) {
        return payload.data[key];
      }
    }
  }

  for (const key of ["positions", "items", "list"]) {
    if (Array.isArray(payload[key])) {
      return payload[key];
    }
  }

  return [];
}

function normalizeOkxPosition(item, uniqueName, sourceType = "trader") {
  const rawJson = stableJson(item);
  const instId = firstString(item, ["instId", "ccy", "instFamily", "symbol"]) || "UNKNOWN";
  const side = firstString(item, ["posSide", "side", "direction"]) || "";
  const openAvgPx = String(firstPrimitive(item, ["openAvgPx", "avgPx", "openPx"]) || "");
  const pos = String(firstPrimitive(item, ["pos", "subPos", "availSubPos", "size"]) || "");
  const margin = String(firstPrimitive(item, ["margin", "marginAmount", "imr", "marginBalance"]) || "");
  const markPx = String(
    firstPrimitive(item, sourceType === "community" ? ["last", "markPx", "lastPx", "closePx"] : ["markPx", "last", "lastPx", "closePx"]) || ""
  );
  const lever = String(firstPrimitive(item, ["lever", "leverage"]) || "");
  const pnl = String(firstPrimitive(item, sourceType === "community" ? ["upl", "pnl", "uplRatio", "profit"] : ["upl", "pnl", "uplRatio", "profit"]) || "");
  const updatedAt =
    firstString(item, ["uTime", "updatedAt", "updateTime", "cTime", "createdAt"]) ||
    new Date().toISOString();
  const positionKey = sha256(`${uniqueName}|${instId}|${side}|${openAvgPx}`).slice(0, 32);

  return {
    positionKey,
    instId,
    side,
    openAvgPx,
    pos,
    margin,
    markPx,
    lever,
    pnl,
    updatedAt,
    rawJson
  };
}

function persistOkxTraderSnapshot(trader, payload, positions) {
  const now = new Date().toISOString();
  const payloadText = JSON.stringify(payload);

  try {
    db.exec("BEGIN");

    db.prepare(
      `
      UPDATE okx_traders
      SET display_name = ?,
          last_checked_at = ?,
          last_error = NULL,
          updated_at = ?,
          latest_payload = ?
      WHERE id = ?
      `
    ).run(resolveOkxTraderName(trader.unique_name, payload), now, now, payloadText, trader.id);

    db.prepare(
      `
      DELETE FROM okx_positions
      WHERE trader_id = ?
      `
    ).run(trader.id);

    const insertPosition = db.prepare(
      `
      INSERT INTO okx_positions (
        trader_id,
        position_key,
        inst_id,
        side,
        open_avg_px,
        mark_px,
        pos,
        margin,
        lever,
        pnl,
        updated_at,
        raw_json
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `
    );

    for (const position of positions) {
      insertPosition.run(
        trader.id,
        position.positionKey,
        position.instId,
        position.side,
        position.openAvgPx,
        position.markPx,
        position.pos,
        position.margin,
        position.lever,
        position.pnl,
        position.updatedAt,
        position.rawJson
      );
    }

    db.exec("COMMIT");
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
}

function buildOkxChangeSet(previousPositions, nextPositions) {
  const previousMap = new Map(previousPositions.map((item) => [item.position_key, item]));
  const nextMap = new Map(nextPositions.map((item) => [item.positionKey, item]));
  const opened = [];
  const closed = [];

  for (const position of nextPositions) {
    const previous = previousMap.get(position.positionKey);
    if (!previous) {
      opened.push(position);
    }
  }

  for (const previous of previousPositions) {
    if (!nextMap.has(previous.position_key)) {
      closed.push(previous);
    }
  }

  return {
    opened,
    closed,
    totalChanges: opened.length + closed.length
  };
}

function shouldPushOkxChange(source, previousPositions, changeSet) {
  if (!config.feishuWebhookUrl) {
    return false;
  }

  if (source === "manual_add") {
    return false;
  }

  if (previousPositions.length === 0) {
    return false;
  }

  return changeSet.totalChanges > 0;
}

async function pushOkxChangeNotification(trader, changeSet) {
  const titleName = trader.remark || trader.display_name || trader.unique_name;
  const body = {
    msg_type: "post",
    content: {
      post: {
        zh_cn: {
          title: `OKX 跟单播报 | ${titleName}`,
          content: buildFeishuPostContent(trader, changeSet)
        }
      }
    }
  };

  await postJson(config.feishuWebhookUrl, body, config.requestTimeoutMs);
}

function buildFeishuPostContent(trader, changeSet) {
  const summary = [];
  if (changeSet.opened.length) summary.push(`新开仓 ${changeSet.opened.length}`);
  if (changeSet.closed.length) summary.push(`已平仓 ${changeSet.closed.length}`);

  const content = [
    [
      { tag: "text", text: `本次变动：${summary.join(" | ") || "无"}` }
    ]
  ];

  for (const position of changeSet.opened) {
    content.push([
      { tag: "text", text: `【新开仓】${formatPositionHeadline(position)}\n` },
      { tag: "text", text: buildPositionDetail(position) }
    ]);
  }

  for (const position of changeSet.closed) {
    content.push([
      { tag: "text", text: `【已平仓】${formatPositionHeadline(position)}\n` },
      { tag: "text", text: buildPositionDetail(position) }
    ]);
  }

  return content;
}

function formatPositionHeadline(position) {
  return `${displayValue(position.instId || position.inst_id)} ${normalizeOkxSideLabel(position.side)}`;
}

function buildPositionDetail(position) {
  return (
    `开仓均价：${formatDecimal(position.openAvgPx || position.open_avg_px, 4)}\n` +
    `当前价格：${displayValue(position.markPx || position.mark_px)}\n` +
    `保证金：${formatDecimal(position.margin, 2)}\n` +
    `杠杆：${displayValue(position.lever)}\n` +
    `盈亏：${formatDecimal(position.pnl, 2)}`
  );
}

function normalizeOkxSideLabel(value) {
  const text = String(value || "").toLowerCase();
  if (["short", "sell", "net_short", "空", "空单"].some((item) => text.includes(item))) return "做空";
  if (["long", "buy", "net_long", "多", "多单"].some((item) => text.includes(item))) return "做多";
  return displayValue(value);
}

function formatDecimal(value, digits) {
  const num = Number(value);
  if (!Number.isFinite(num)) return displayValue(value);
  return num.toFixed(digits);
}

function displayValue(value) {
  return String(value ?? "").trim() || "-";
}

function resolveOkxTraderName(uniqueName, payload) {
  const source =
    (payload && typeof payload === "object" && Array.isArray(payload.data) && payload.data[0]) ||
    (payload && typeof payload.data === "object" ? payload.data : payload) ||
    {};

  return (
    firstString(source, ["nickName", "nickname", "name", "traderName", "userName", "uniqueName"]) ||
    uniqueName
  );
}

function loadExistingSignalMap() {
  const rows = db
    .prepare(
      `
      SELECT signal_key, latest_hash
      FROM signals
      `
    )
    .all();

  return new Map(rows.map((row) => [row.signal_key, row]));
}
function renderDashboard(currentConfig) {
  return `<!doctype html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>${escapeHtml(currentConfig.dashboardTitle)}</title>
  <style>
    :root {
      --bg: #f7f8fc;
      --panel: rgba(255,255,255,0.96);
      --ink: #121826;
      --muted: #5b6475;
      --line: rgba(104,121,153,0.16);
      --accent: #2f6df6;
      --accent-soft: rgba(47,109,246,0.08);
      --good: #00a86b;
      --bad: #ff3b30;
      --shadow: 0 18px 45px rgba(20,36,77,0.08);
      --radius: 22px;
    }
    * { box-sizing: border-box; }
    body {
      margin: 0;
      color: var(--ink);
      font-family: "Segoe UI", "PingFang SC", "Microsoft YaHei", sans-serif;
      background:
        radial-gradient(circle at top left, rgba(47,109,246,0.08), transparent 28%),
        radial-gradient(circle at right, rgba(27,184,163,0.07), transparent 22%),
        linear-gradient(180deg, #ffffff 0%, var(--bg) 100%);
      min-height: 100vh;
    }
    .shell { max-width: 1280px; margin: 0 auto; padding: 32px 20px 48px; }
    .hero, .panel {
      background: linear-gradient(135deg, rgba(247,250,255,0.98), rgba(255,255,255,0.85));
      border: 1px solid rgba(255,255,255,0.9);
      box-shadow: var(--shadow);
      border-radius: 28px;
    }
    .hero { padding: 28px; display: grid; gap: 16px; }
    .panel { padding: 20px; border-radius: var(--radius); }
    .hero h1 { margin: 0; font-size: clamp(28px, 5vw, 44px); letter-spacing: -0.03em; }
    .hero p, .meta { margin: 0; color: var(--muted); line-height: 1.6; font-size: 14px; }
    .hero-actions, .tab-bar, .okx-form, .tags, .okx-metrics { display: flex; flex-wrap: wrap; gap: 12px; align-items: center; }
    button {
      border: 0; border-radius: 999px; padding: 12px 18px; background: var(--accent); color: white;
      font-weight: 600; cursor: pointer; box-shadow: 0 10px 26px rgba(47,109,246,0.22);
    }
    .tab { background: white; color: var(--muted); border: 1px solid var(--line); box-shadow: none; }
    .tab.active { background: var(--accent); color: white; border-color: transparent; }
    input {
      min-width: 320px; max-width: 100%; border: 1px solid var(--line); border-radius: 999px;
      padding: 12px 16px; font: inherit; background: white; color: var(--ink);
    }
    .sections { display: grid; gap: 16px; margin-top: 16px; }
    .hidden { display: none; }
    .pill {
      display: inline-flex; align-items: center; padding: 4px 10px; border-radius: 999px;
      background: var(--accent-soft); color: var(--accent); font-size: 12px; font-weight: 700; width: fit-content;
    }
    .hint { margin-top: 10px; color: var(--muted); font-size: 13px; }
    .timeline-wrap { position: relative; padding-left: 34px; }
    .timeline-wrap::before { content: ""; position: absolute; left: 10px; top: 0; bottom: 0; border-left: 2px dashed #d9deea; }
    .timeline-item { position: relative; padding-bottom: 26px; }
    .timeline-dot {
      position: absolute; left: -34px; top: 8px; width: 10px; height: 10px; border-radius: 50%;
      background: var(--accent); box-shadow: 0 0 0 5px rgba(47,109,246,0.08);
    }
    .timeline-time { color: var(--accent); font-size: 22px; font-weight: 700; margin-bottom: 14px; }
    .signal-card { display: grid; gap: 14px; }
    .signal-title { font-size: 26px; font-weight: 800; letter-spacing: -0.02em; }
    .signal-body { color: #444f62; font-size: 18px; line-height: 1.8; word-break: break-word; }
    .signal-raw, .okx-pos-raw {
      padding: 14px 16px; border-radius: 14px; background: #f7f9fc; border: 1px solid var(--line);
      color: #22304a; font-size: 15px; line-height: 1.7; white-space: pre-wrap; word-break: break-word;
    }
    .tag, .metric {
      display: inline-flex; align-items: center; gap: 4px; min-height: 44px; padding: 0 16px; border-radius: 10px;
      background: #f3f5f9; color: #2f3f5f; font-size: 15px; font-weight: 500;
    }
    .tag strong, .metric strong { font-size: 17px; color: #111827; }
    .tag-symbol { color: #4a56ff; font-weight: 700; }
    .tag-long, .side-long { color: var(--good); font-weight: 700; }
    .tag-short, .side-short { color: var(--bad); font-weight: 700; }
    .okx-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(320px, 1fr)); gap: 16px; }
    .okx-trader-card {
      border: 1px solid var(--line); border-radius: 18px; padding: 18px; background: rgba(255,255,255,0.7); display: grid; gap: 14px;
    }
    .okx-header { display: flex; justify-content: space-between; gap: 12px; align-items: flex-start; }
    .okx-name { font-size: 22px; font-weight: 800; }
    .okx-sub { color: var(--muted); font-size: 13px; }
    .okx-positions { display: grid; gap: 12px; }
    .okx-position { border: 1px solid var(--line); border-radius: 16px; padding: 14px; background: #fbfcff; display: grid; gap: 10px; }
    .okx-pos-title { display: flex; justify-content: space-between; gap: 8px; align-items: center; font-size: 18px; font-weight: 700; }
    @media (max-width: 720px) {
      .shell { padding: 18px 14px 40px; }
      .panel { padding: 16px; }
      input { min-width: 100%; }
    }
  </style>
</head>
<body>
  <div class="shell">
    <section class="hero">
      <h1>${escapeHtml(currentConfig.dashboardTitle)}</h1>
      <div class="hero-actions">
        <button id="run-now">立即更新全部</button>
        <span class="meta" id="run-feedback">等待中</span>
      </div>
      <div class="tab-bar">
        <button class="tab active" data-tab="signals">KOL信号</button>
        <button class="tab" data-tab="okx">明灯监控</button>
      </div>
    </section>

    <section class="sections">
      <div class="panel" data-panel="signals">
        <h2>最新信号流</h2>
        <div id="signals"></div>
      </div>
      <div class="panel hidden" data-panel="okx">
        <h2>明灯监控</h2>
        <div class="okx-form">
          <input id="okx-unique-name" placeholder="ID" />
          <input id="okx-remark" placeholder="备注" />
          <button id="add-okx-trader">添加</button>
          <span class="meta" id="okx-feedback"></span>
        </div>
        <div id="okx-traders" style="margin-top:16px;"></div>
      </div>
    </section>
  </div>
  <script>
    const feedback = document.getElementById("run-feedback");
    const okxFeedback = document.getElementById("okx-feedback");

    document.querySelectorAll(".tab").forEach((button) => {
      button.addEventListener("click", () => switchTab(button.dataset.tab));
    });

    document.getElementById("run-now").addEventListener("click", async () => {
      feedback.textContent = "正在执行手动更新...";
      try {
        const response = await fetch("/api/run", { method: "POST" });
        const payload = await response.json();
        if (!payload.ok) throw new Error(payload.error || "Manual run failed");
        feedback.textContent = "手动更新完成";
        await load();
      } catch (error) {
        feedback.textContent = "手动更新失败: " + error.message;
      }
    });

    document.getElementById("add-okx-trader").addEventListener("click", async () => {
      const input = document.getElementById("okx-unique-name");
      const remarkInput = document.getElementById("okx-remark");
      const uniqueName = input.value.trim();
      const remark = remarkInput.value.trim();
      if (!uniqueName) {
        okxFeedback.textContent = "请先填写 uniqueName";
        return;
      }
      okxFeedback.textContent = "正在添加监控...";
      try {
        const response = await fetch("/api/okx-traders", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ uniqueName, remark })
        });
        const payload = await response.json();
        if (!payload.ok) throw new Error(payload.error || "Add trader failed");
        okxFeedback.textContent = "添加成功，已开始抓取";
        input.value = "";
        remarkInput.value = "";
        await load();
        switchTab("okx");
      } catch (error) {
        okxFeedback.textContent = "添加失败: " + error.message;
      }
    });

    async function removeOkxTrader(uniqueName) {
      okxFeedback.textContent = "正在删除监控...";
      try {
        const response = await fetch("/api/okx-traders/" + encodeURIComponent(uniqueName), {
          method: "DELETE"
        });
        const payload = await response.json();
        if (!payload.ok) throw new Error(payload.error || "Delete trader failed");
        okxFeedback.textContent = "删除成功";
        await load();
      } catch (error) {
        okxFeedback.textContent = "删除失败: " + error.message;
      }
    }

    function switchTab(tabName) {
      document.querySelectorAll(".tab").forEach((button) => {
        button.classList.toggle("active", button.dataset.tab === tabName);
      });
      document.querySelectorAll("[data-panel]").forEach((panel) => {
        panel.classList.toggle("hidden", panel.dataset.panel !== tabName);
      });
    }

    async function load() {
      const response = await fetch("/api/status");
      const data = await response.json();
      renderSignals(data.recentSignals || []);
      renderOkx(data.okxTraders || [], data.okxPositions || []);
    }

    function renderSignals(signals) {
      if (signals.length === 0) {
        document.getElementById("signals").innerHTML = '<div class="hint">还没有信号数据。</div>';
        return;
      }
      document.getElementById("signals").innerHTML = \`<div class="timeline-wrap">\${signals.map(renderSignalCard).join("")}</div>\`;
    }

    function renderSignalCard(signal) {
      const raw = safeParse(signal.payload_json);
      const time = formatClock(signal.updated_at || signal.published_at);
      const heading = buildHeading(signal, raw);
      const body = buildBody(signal, raw);
      const signalText = buildSignalText(raw);
      const tags = extractTags(signal, raw);
      return \`
        <article class="timeline-item">
          <span class="timeline-dot"></span>
          <div class="timeline-time">\${escapeHtml(time)}</div>
          <div class="signal-card">
            <div class="signal-title">\${escapeHtml(heading)}</div>
            <div class="signal-body">\${escapeHtml(body)}</div>
            \${signalText ? \`<div class="signal-raw">\${escapeHtml(signalText)}</div>\` : ""}
            \${tags.length ? \`<div class="tags">\${tags.map(renderTag).join("")}</div>\` : ""}
          </div>
        </article>
      \`;
    }

    function renderOkx(traders, positions) {
      if (traders.length === 0) {
        document.getElementById("okx-traders").innerHTML = '<div class="hint">还没有监控，先输入添加。</div>';
        return;
      }
      const grouped = new Map();
      for (const position of positions) {
        const list = grouped.get(position.trader_id) || [];
        list.push(position);
        grouped.set(position.trader_id, list);
      }
      document.getElementById("okx-traders").innerHTML = \`<div class="okx-grid">\${traders.map((trader) => renderTraderCard(trader, grouped.get(trader.id) || [])).join("")}</div>\`;
    }
    function renderTraderPosition(position) {
      const side = normalizeSide(position.side);
      const sideClass = side === "鍋氱┖" ? "side-short" : "side-long";
      return \`
        <div class="okx-position">
          <div class="okx-pos-title">
            <span>\${escapeHtml(position.inst_id || "未知合约")}</span>
            <span class="\${sideClass}">\${escapeHtml(side || "-")}</span>
          </div>
          <div class="okx-metrics">
            <span class="metric">开仓均价 <strong>\${escapeHtml(formatPrice(position.open_avg_px))}</strong></span>
            <span class="metric">当前价格 <strong>\${escapeHtml(position.mark_px || "-")}</strong></span>
            <span class="metric">保证金 <strong>\${escapeHtml(formatMetric(position.margin, 2))}</strong></span>
            <span class="metric">杠杆 <strong>\${escapeHtml(position.lever || "-")}</strong></span>
            <span class="metric">盈亏 <strong>\${escapeHtml(formatPnl(position.pnl))}</strong></span>
          </div>
        </div>
      \`;
    }

    function renderTraderCard(trader, positions) {
      return \`
        <article class="okx-trader-card">
          <div class="okx-header">
            <div>
              <div class="okx-name">\${escapeHtml(trader.remark || trader.display_name || trader.unique_name)}</div>
            </div>
            <div style="display:grid; gap:8px; justify-items:end;">
              <span class="pill">\${positions.length} 个仓位</span>
              <button onclick="removeOkxTrader('\${escapeJs(trader.unique_name)}')" style="background:#fff;color:#ff3b30;border:1px solid rgba(255,59,48,0.18);box-shadow:none;">删除</button>
            </div>
          </div>
          \${trader.last_error ? \`<div class="okx-pos-raw">\${escapeHtml(trader.last_error)}</div>\` : ""}
          <div class="okx-positions">
            \${positions.length ? positions.map(renderTraderPosition).join("") : '<div class="hint">当前没有抓到持仓。</div>'}
          </div>
        </article>
      \`;
    }

    function renderTag(tag) {
      if (tag.type === "symbol") return \`<span class="tag"><span class="tag-symbol">\${escapeHtml(tag.label)}</span></span>\`;
      if (tag.type === "direction") {
        const className = tag.value === "做多" ? "tag-long" : "tag-short";
        return \`<span class="tag"><span class="\${className}">\${escapeHtml(tag.value)}</span></span>\`;
      }
      return \`<span class="tag">\${escapeHtml(tag.label)} <strong>\${escapeHtml(tag.value)}</strong></span>\`;
    }

    function buildHeading(signal, raw) {
      const author = signal.author || raw.author_nickname || raw.author_username || "群友发言";
      const title = signal.title || raw.analysis || raw.message_content || "最新观点";
      return title.includes("【") && title.includes("】") ? author + "：最新观点" : author + "：最新信号";
    }

    function buildBody(signal, raw) {
      const base = signal.title || raw.analysis || raw.message_content || "";
      return base.replace(/\\s+/g, " ").trim();
    }

    function buildSignalText(raw) {
      return typeof raw.signal === "string" ? raw.signal.trim() : "";
    }

    function extractTags(signal, raw) {
      const source = [signal.title, raw.analysis, raw.message_content, raw.signal].filter(Boolean).join(" ");
      const tags = [];
      const symbol = pickSymbol(source);
      const direction = pickDirection(source);
      const entry = pickValue(source, /(入场价|入场)[:：]?\\s*([0-9.\\-~～至无]+)/);
      const takeProfit = pickValue(source, /(止盈)[:：]?\\s*([0-9.\\-~～至无]+)/);
      const stopLoss = pickValue(source, /(止损)[:：]?\\s*([0-9.\\-~～至无]+)/);
      if (symbol) tags.push({ type: "symbol", label: symbol });
      if (direction) tags.push({ type: "direction", value: direction });
      if (entry) tags.push({ type: "metric", label: "入场", value: entry });
      if (takeProfit) tags.push({ type: "metric", label: "止盈", value: takeProfit });
      if (stopLoss) tags.push({ type: "metric", label: "止损", value: stopLoss });
      return tags;
    }

    function pickSymbol(text) {
      const match = text.match(/\\b(BTC|ETH|SOL|BNB|XRP|DOGE|SUI|TRX|ADA|LINK|LTC|GOOGL|BCH)\\b/i);
      return match ? match[1].toUpperCase() : "";
    }

    function pickDirection(text) {
      if (text.includes("做多") || text.includes("多单")) return "做多";
      if (text.includes("做空") || text.includes("空单")) return "做空";
      return "";
    }

    function pickValue(text, pattern) {
      const match = text.match(pattern);
      return match ? match[2].replace(/，|。|；/g, "").trim() : "";
    }

    function normalizeSide(value) {
      const text = String(value || "").toLowerCase();
      if (["short", "sell", "net_short", "空", "空单"].some((item) => text.includes(item))) return "做空";
      if (["long", "buy", "net_long", "多", "多单"].some((item) => text.includes(item))) return "做多";
      return value || "";
    }

    function safeParse(value) {
      try { return value ? JSON.parse(value) : {}; } catch { return {}; }
    }

    function formatClock(value) {
      if (!value) return "--:--";
      const directMatch = String(value).match(/(\\d{2}):(\\d{2}):\\d{2}\\s+GMT$/i);
      if (directMatch) return directMatch[1] + ":" + directMatch[2];
      const date = new Date(value);
      if (Number.isNaN(date.getTime())) {
        const matched = String(value).match(/(\\d{2}:\\d{2})/);
        return matched ? matched[1] : String(value);
      }
      return String(date.getUTCHours()).padStart(2, "0") + ":" + String(date.getUTCMinutes()).padStart(2, "0");
    }

    function formatDateTime(value) {
      if (!value) return "-";
      const date = new Date(value);
      return Number.isNaN(date.getTime()) ? String(value) : date.toLocaleString("zh-CN");
    }

    function formatNumber(value, digits) {
      const num = Number(value);
      if (!Number.isFinite(num)) return value || "-";
      return num.toFixed(digits);
    }

    function formatPrice(value) {
      return formatNumber(value, 4);
    }

    function formatMetric(value, digits = 2) {
      return formatNumber(value, digits);
    }

    function formatPnl(value) {
      return formatNumber(value, 2);
    }

    function escapeHtml(value) {
      return String(value).replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;").replaceAll("'", "&#39;");
    }

    function escapeJs(value) {
      return String(value).replaceAll("\\\\", "\\\\\\\\").replaceAll("'", "\\\\'");
    }

    load();
    setInterval(load, 15000);
  </script>
</body>
</html>`;
}

function loadConfig() {
  const configPath = fs.existsSync(CONFIG_PATH) ? CONFIG_PATH : DEFAULT_CONFIG_PATH;
  const raw = fs.readFileSync(configPath, "utf8");
  const parsed = JSON.parse(raw);

  return {
    port: Number(parsed.port || 3000),
    pollIntervalMinutes: Math.max(1, Number(parsed.pollIntervalMinutes || 60)),
    requestTimeoutMs: Math.max(1_000, Number(parsed.requestTimeoutMs || 15_000)),
    signalApiUrl: parsed.signalApiUrl,
    dashboardTitle: parsed.dashboardTitle || "KOL Signal Monitor",
    feishuWebhookUrl: String(parsed.feishuWebhookUrl || "").trim()
  };
}

function ensureDir(targetPath) {
  fs.mkdirSync(targetPath, { recursive: true });
}

function sendJson(res, payload, statusCode = 200) {
  res.writeHead(statusCode, { "Content-Type": "application/json; charset=utf-8" });
  res.end(JSON.stringify(payload));
}

function sendHtml(res, html) {
  res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
  res.end(html);
}

function sha256(input) {
  return crypto.createHash("sha256").update(input).digest("hex");
}

function stableJson(value) {
  return JSON.stringify(sortDeep(value));
}

function sortDeep(value) {
  if (Array.isArray(value)) {
    return value.map(sortDeep);
  }

  if (value && typeof value === "object") {
    return Object.keys(value)
      .sort()
      .reduce((result, key) => {
        result[key] = sortDeep(value[key]);
        return result;
      }, {});
  }

  return value;
}

function firstString(object, keys) {
  for (const key of keys) {
    const value = object?.[key];
    if (typeof value === "string" && value.trim()) {
      return value.trim();
    }
  }
  return "";
}

function firstPrimitive(object, keys) {
  for (const key of keys) {
    const value = object?.[key];
    if (typeof value === "string" || typeof value === "number") {
      return value;
    }
  }
  return "";
}

function escapeHtml(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}
