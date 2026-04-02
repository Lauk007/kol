import http from "node:http";
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
    summary = await fetchAndPersist(source);
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

async function fetchAndPersist(source) {
  const startedAt = new Date().toISOString();
  const startedTs = Date.now();

  try {
    const payload = await fetchJson(config.signalApiUrl, config.requestTimeoutMs);
    const items = extractSignalItems(payload)
      .map(normalizeItem)
      .filter((item) => !shouldFilterItem(item));
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
    recentSignals
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

async function fetchJson(url, timeoutMs) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const response = await fetch(url, {
      method: "GET",
      signal: controller.signal,
      headers: {
        Accept: "application/json"
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

  `);

  try {
    database.exec("ALTER TABLE signals ADD COLUMN updated_at TEXT");
  } catch {}

  try {
    database.exec("ALTER TABLE signal_snapshots ADD COLUMN updated_at TEXT");
  } catch {}

  return database;
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
      --panel: rgba(255, 255, 255, 0.96);
      --ink: #121826;
      --muted: #5b6475;
      --line: rgba(104, 121, 153, 0.16);
      --accent: #2f6df6;
      --accent-soft: rgba(47, 109, 246, 0.08);
      --shadow: 0 18px 45px rgba(20, 36, 77, 0.08);
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
    .shell {
      max-width: 1200px;
      margin: 0 auto;
      padding: 32px 20px 48px;
    }
    .hero {
      padding: 28px;
      border-radius: 28px;
      background: linear-gradient(135deg, rgba(247,250,255,0.98), rgba(255,255,255,0.85));
      box-shadow: var(--shadow);
      border: 1px solid rgba(255,255,255,0.9);
      display: grid;
      gap: 16px;
    }
    .hero h1 {
      margin: 0;
      font-size: clamp(28px, 5vw, 44px);
      letter-spacing: -0.03em;
    }
    .hero p {
      margin: 0;
      color: var(--muted);
      max-width: 820px;
      line-height: 1.6;
    }
    .hero-actions {
      display: flex;
      flex-wrap: wrap;
      gap: 12px;
      align-items: center;
    }
    button {
      border: 0;
      border-radius: 999px;
      padding: 12px 18px;
      background: var(--accent);
      color: white;
      font-weight: 600;
      cursor: pointer;
      box-shadow: 0 10px 26px rgba(47, 109, 246, 0.22);
    }
    .meta {
      color: var(--muted);
      font-size: 14px;
    }
    .sections {
      display: grid;
      gap: 16px;
      margin-top: 16px;
    }
    .panel {
      background: var(--panel);
      border: 1px solid var(--line);
      border-radius: var(--radius);
      padding: 20px;
      box-shadow: var(--shadow);
      backdrop-filter: blur(12px);
    }
    .timeline-wrap {
      position: relative;
      padding-left: 34px;
    }
    .timeline-wrap::before {
      content: "";
      position: absolute;
      left: 10px;
      top: 0;
      bottom: 0;
      border-left: 2px dashed #d9deea;
    }
    .timeline-item {
      position: relative;
      padding-bottom: 26px;
    }
    .timeline-dot {
      position: absolute;
      left: -34px;
      top: 8px;
      width: 10px;
      height: 10px;
      border-radius: 50%;
      background: var(--accent);
      box-shadow: 0 0 0 5px rgba(47, 109, 246, 0.08);
    }
    .timeline-time {
      color: var(--accent);
      font-size: 22px;
      font-weight: 700;
      margin-bottom: 14px;
    }
    .signal-card {
      display: grid;
      gap: 14px;
    }
    .signal-title {
      font-size: 26px;
      font-weight: 800;
      letter-spacing: -0.02em;
    }
    .signal-body {
      color: #444f62;
      font-size: 18px;
      line-height: 1.8;
      word-break: break-word;
    }
    .signal-raw {
      padding: 14px 16px;
      border-radius: 14px;
      background: #f7f9fc;
      border: 1px solid var(--line);
      color: #22304a;
      font-size: 15px;
      line-height: 1.7;
      white-space: pre-wrap;
      word-break: break-word;
    }
    .tags {
      display: flex;
      flex-wrap: wrap;
      gap: 12px;
    }
    .tag {
      display: inline-flex;
      align-items: center;
      gap: 4px;
      min-height: 48px;
      padding: 0 18px;
      border-radius: 10px;
      background: #f3f5f9;
      color: #2f3f5f;
      font-size: 16px;
      font-weight: 500;
    }
    .tag strong {
      font-size: 18px;
      color: #111827;
    }
    .tag-symbol {
      color: #4a56ff;
      font-weight: 700;
    }
    .tag-long {
      color: #00a86b;
      font-weight: 700;
    }
    .tag-short {
      color: #ff3b30;
      font-weight: 700;
    }
    .pill {
      display: inline-flex;
      align-items: center;
      padding: 4px 10px;
      border-radius: 999px;
      background: var(--accent-soft);
      color: var(--accent);
      font-size: 12px;
      font-weight: 700;
      width: fit-content;
    }
    .hint {
      margin-top: 10px;
      color: var(--muted);
      font-size: 13px;
    }
    @media (max-width: 720px) {
      .shell { padding: 18px 14px 40px; }
      .panel { padding: 16px; }
    }
  </style>
</head>
<body>
  <div class="shell">
    <section class="hero">
      <div class="hero-actions">
        <button id="run-now">手动更新</button>
        <span class="meta" id="run-feedback"></span>
      </div>
    </section>

    <section class="sections">
      <div class="panel">
        <h2>最新信号流</h2>
        <div id="signals"></div>
      </div>
    </section>
  </div>
  <script>
    const feedback = document.getElementById("run-feedback");
    document.getElementById("run-now").addEventListener("click", async () => {
      feedback.textContent = "正在执行手动更新...";
      try {
        const response = await fetch("/api/run", { method: "POST" });
        const payload = await response.json();
        if (!payload.ok) throw new Error(payload.error || "Manual run failed");
        feedback.textContent = payload.summary.success ? "手动更新完成" : "手动更新失败";
        await load();
      } catch (error) {
        feedback.textContent = "手动更新失败: " + error.message;
      }
    });

    async function load() {
      const response = await fetch("/api/status");
      const data = await response.json();
      renderSignals(data.recentSignals || []);
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

    function renderTag(tag) {
      if (tag.type === "symbol") {
        return \`<span class="tag"><span class="tag-symbol">\${escapeHtml(tag.label)}</span></span>\`;
      }
      if (tag.type === "direction") {
        const className = tag.value === "做多" ? "tag-long" : "tag-short";
        return \`<span class="tag"><span class="\${className}">\${escapeHtml(tag.value)}</span></span>\`;
      }
      return \`<span class="tag">\${escapeHtml(tag.label)} <strong>\${escapeHtml(tag.value)}</strong></span>\`;
    }

    function buildHeading(signal, raw) {
      const author = signal.author || raw.author_nickname || raw.author_username || "群友发言";
      const title = signal.title || raw.analysis || raw.message_content || "最新观点";
      if (title.includes("【") && title.includes("】")) {
        return author + "：最新观点";
      }
      return author + "：最新信号";
    }

    function buildBody(signal, raw) {
      const base = signal.title || raw.analysis || raw.message_content || "";
      return base.replace(/\\s+/g, " ").trim();
    }

    function buildSignalText(raw) {
      if (!raw.signal || typeof raw.signal !== "string") {
        return "";
      }
      return raw.signal.trim();
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
      const match = text.match(/\\b(BTC|ETH|SOL|BNB|XRP|DOGE|SUI|TRX|ADA|LINK|LTC|GOOGL)\\b/i);
      return match ? match[1].toUpperCase() : "";
    }

    function pickDirection(text) {
      if (text.includes("做多") || text.includes("多单")) return "做多";
      if (text.includes("做空") || text.includes("空单")) return "做空";
      return "";
    }

    function pickValue(text, pattern) {
      const match = text.match(pattern);
      if (!match) return "";
      return match[2].replace(/，|。|；/g, "").trim();
    }

    function safeParse(value) {
      try {
        return value ? JSON.parse(value) : {};
      } catch {
        return {};
      }
    }

    function formatClock(value) {
      if (!value) return "--:--";
      const directMatch = String(value).match(/(\\d{2}):(\\d{2}):\\d{2}\\s+GMT$/i);
      if (directMatch) {
        return directMatch[1] + ":" + directMatch[2];
      }
      const date = new Date(value);
      if (Number.isNaN(date.getTime())) {
        const matched = String(value).match(/(\\d{2}:\\d{2})/);
        return matched ? matched[1] : String(value);
      }
      return String(date.getUTCHours()).padStart(2, "0") + ":" + String(date.getUTCMinutes()).padStart(2, "0");
    }

    function escapeHtml(value) {
      return String(value)
        .replaceAll("&", "&amp;")
        .replaceAll("<", "&lt;")
        .replaceAll(">", "&gt;")
        .replaceAll('"', "&quot;")
        .replaceAll("'", "&#39;");
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
    dashboardTitle: parsed.dashboardTitle || "KOL Signal Monitor"
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
