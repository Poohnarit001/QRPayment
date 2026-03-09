require("dotenv").config();

const express = require("express");
const axios = require("axios");
const path = require("path");
const fs = require("fs");
const multer = require("multer");

const mysql = require("mysql2/promise");

const app = express();
app.use(express.json({ limit: "1mb" }));

// ===== OTA upload (web dashboard) =====
// NOTE: requires `npm i multer`
const otaUpload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 16 * 1024 * 1024 }, // 16MB
  fileFilter: (req, file, cb) => {
    const okName = /\.bin$/i.test(file?.originalname || "");
    const okType = !file?.mimetype || file.mimetype === "application/octet-stream" || file.mimetype === "application/macbinary";
    if (okName && okType) return cb(null, true);
    return cb(new Error("firmware must be a .bin file"));
  }
});

// ===== Image upload (web config) =====
// Upload background/splash jpg into ./public/images
// - device_id = "ALL" -> public/images/splash.jpg
// - device_id = "DEVxxxx" -> public/images/splash_DEVxxxx.jpg
const IMG_DIR = path.join(__dirname, "public", "images");

function ensureDirSync(p) {
  if (!fs.existsSync(p)) fs.mkdirSync(p, { recursive: true });
}

function safeDeviceId(s) {
  const t = String(s || "").trim().toUpperCase();
  if (!t || t === "ALL") return "ALL";
  // allow A-Z 0-9 _ -
  const clean = t.replace(/[^A-Z0-9_-]/g, "").slice(0, 32);
  return clean || "ALL";
}

const imageUpload = multer({
  storage: multer.diskStorage({
    destination: (req, file, cb) => {
      try {
        ensureDirSync(IMG_DIR);
        cb(null, IMG_DIR);
      } catch (e) {
        cb(e);
      }
    },
    filename: (req, file, cb) => {
      try {
        const device_id = safeDeviceId(req.body?.device_id);
        const base = device_id === "ALL" ? "splash" : `splash_${device_id}`;
        cb(null, base + ".jpg");
      } catch (e) {
        cb(e);
      }
    }
  }),
  limits: { fileSize: 600 * 1024 }, // 600KB (recommended <= 250KB for ESP32)
  fileFilter: (req, file, cb) => {
    const name = String(file?.originalname || "").toLowerCase();
    const okExt = name.endsWith(".jpg") || name.endsWith(".jpeg");
    const okType = !file?.mimetype || file.mimetype === "image/jpeg" || file.mimetype === "image/jpg";
    if (okExt && okType) return cb(null, true);
    return cb(new Error("image must be .jpg/.jpeg (image/jpeg)"));
  }
});



const PORT = process.env.PORT || 8787;
const BASE_URL = (process.env.BASE_URL || "").replace(/\/$/, "");
const XENDIT_SECRET_KEY = process.env.XENDIT_SECRET_KEY;
const XENDIT_WEBHOOK_TOKEN = process.env.XENDIT_WEBHOOK_TOKEN || "";

// Serve images from data/images at /images/...
ensureDirSync(IMG_DIR);
app.use('/images', express.static(IMG_DIR, { etag: false, maxAge: 0 }));

// ===== static dashboard files =====
// Put dashboard.* into ./public
app.use(express.static(path.join(__dirname, "public")));
app.get("/", (req, res) => res.redirect("/dashboard"));

app.get("/dashboard", (req, res) => {
  res.sendFile(path.join(__dirname, "public", "dashboard.html"));
});

app.get("/settings", (req, res) => {
  res.sendFile(path.join(__dirname, "public", "settings.html"));
});

app.get("/dashboard.html", (req, res) => res.redirect("/dashboard"));
app.get("/settings.html", (req, res) => res.redirect("/settings"));
app.get("/config.html", (req, res) => res.redirect("/settings"));
app.get("/ota.html", (req, res) => res.redirect("/settings"));

// ===== Xendit client =====
const xendit = axios.create({
  baseURL: "https://api.xendit.co",
  timeout: 30000,
  auth: { username: XENDIT_SECRET_KEY, password: "" },
  headers: { "Content-Type": "application/json" },
});

function requireEnv() {
  if (!XENDIT_SECRET_KEY) throw new Error("Missing XENDIT_SECRET_KEY in .env");
  if (!BASE_URL) console.warn("WARN: BASE_URL is empty (webhook URL may be wrong).");
}

function normalizeStatus(st) {
  if (!st) return "UNKNOWN";
  const s = String(st).toUpperCase();
  if (s === "SETTLED") return "PAID";
  if (s === "CANCELED") return "CANCELLED";
  if (s === "EXPIRED") return "CANCELLED";
  return s;
}

function guessDeviceId(external_id) {
  // external_id generated like: iot_DEVxxxx_<ts>_<rand>
  if (!external_id) return null;
  const m = String(external_id).match(/^iot_([^_]+)_/i);
  return m ? String(m[1]).trim().toUpperCase() : null;
}

// ===== MySQL =====
let db;
let pool;

function requireDbEnv() {
  const need = (k) => {
    const v = process.env[k];
    if (!v) throw new Error(`Missing ${k} in .env`);
    return v;
  };
  return {
    host: need("DB_HOST"),
    port: Number(process.env.DB_PORT || 3306),
    name: need("DB_NAME"),
    user: need("DB_USER"),
    pass: need("DB_PASS"),
  };
}

async function initDb() {
  const cfg = requireDbEnv();

  pool = mysql.createPool({
    host: cfg.host,
    port: cfg.port,
    user: cfg.user,
    password: cfg.pass,
    database: cfg.name,
    waitForConnections: true,
    connectionLimit: 10,
    queueLimit: 0,
  });

  // Create tables (fresh install). If tables already exist, MySQL will keep them as-is.
  await pool.execute(`
    CREATE TABLE IF NOT EXISTS transactions (
      invoice_id   VARCHAR(80) PRIMARY KEY,
      external_id  VARCHAR(160),
      device_id    VARCHAR(32),
      amount       INT,
      status       VARCHAR(20),
      paid_at      VARCHAR(64),
      invoice_url  VARCHAR(255),
      created_at   BIGINT NOT NULL,
      updated_at   BIGINT NOT NULL,
      INDEX idx_tx_device_updated (device_id, updated_at),
      INDEX idx_tx_status_updated (status, updated_at),
      INDEX idx_tx_created (created_at)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
  `);

  await pool.execute(`
    CREATE TABLE IF NOT EXISTS device_location (
      device_id    VARCHAR(32) PRIMARY KEY,
      device_name  VARCHAR(120),
      fix          TINYINT NOT NULL DEFAULT 0,
      lat          DOUBLE,
      lon          DOUBLE,
      hdop         DOUBLE,
      gps_svs      INT,
      updated_at   BIGINT NOT NULL,
      INDEX idx_loc_updated (updated_at)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
  `);

  await pool.execute(`
    CREATE TABLE IF NOT EXISTS device_config (
      device_id   VARCHAR(32) PRIMARY KEY,
      a1          INT NOT NULL,
      a2          INT NOT NULL,
      a3          INT NOT NULL,
      updated_at  BIGINT NOT NULL
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
  `);

  // SQLite-like helpers used throughout the codebase: db.get / db.all / db.run
  db = {
    async get(sql, params = []) {
      const [rows] = await pool.execute(sql, params);
      return rows?.[0] || null;
    },
    async all(sql, params = []) {
      const [rows] = await pool.execute(sql, params);
      return rows || [];
    },
    async run(sql, params = []) {
      const [result] = await pool.execute(sql, params);
      return result;
    },
  };

  // Ping
  await db.get("SELECT 1 AS ok");

  console.log("[DB] MySQL ready:", `${cfg.user}@${cfg.host}:${cfg.port}/${cfg.name}`);
}

async function upsertDeviceConfig(device_id, a1, a2, a3) {
  const now = Date.now();
  await db.run(
    `
    INSERT INTO device_config(device_id, a1, a2, a3, updated_at)
    VALUES(?,?,?,?,?)
    ON DUPLICATE KEY UPDATE
      a1 = VALUES(a1),
      a2 = VALUES(a2),
      a3 = VALUES(a3),
      updated_at = VALUES(updated_at)
    `,
    [device_id, a1, a2, a3, now]
  );
  return { device_id, a1, a2, a3, updated_at: now };
}

async function upsertTx(partial) {
  if (!partial?.invoice_id) return;

  const now = Date.now();

  await db.run(
    `
    INSERT INTO transactions
      (invoice_id, external_id, device_id, amount, status, paid_at, invoice_url, created_at, updated_at)
    VALUES
      (?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON DUPLICATE KEY UPDATE
      external_id = COALESCE(VALUES(external_id), external_id),
      device_id   = COALESCE(VALUES(device_id),   device_id),
      amount      = COALESCE(VALUES(amount),      amount),
      status      = COALESCE(VALUES(status),      status),
      paid_at     = COALESCE(VALUES(paid_at),     paid_at),
      invoice_url = COALESCE(VALUES(invoice_url), invoice_url),
      updated_at  = VALUES(updated_at)
    `,
    [
      partial.invoice_id,
      partial.external_id ?? null,
      partial.device_id ?? null,
      Number.isFinite(Number(partial.amount)) ? Number(partial.amount) : null,
      partial.status ?? null,
      partial.paid_at ?? null,
      partial.invoice_url ?? null,
      partial.created_at ?? now,
      now,
    ]
  );
}

async function getSummary(device_id) {
  const where = device_id ? "WHERE device_id = ?" : "";
  const args = device_id ? [device_id] : [];

  const row = await db.get(
    `
    SELECT
      COUNT(*) AS count_all,
      SUM(CASE WHEN status = 'PAID' THEN 1 ELSE 0 END) AS count_paid,
      SUM(CASE WHEN status = 'PAID' THEN amount ELSE 0 END) AS total_paid
    FROM transactions
    ${where}
    `,
    args
  );

  return {
    device_id: device_id || "ALL",
    total_paid: row?.total_paid || 0,
    count_paid: row?.count_paid || 0,
    count_all: row?.count_all || 0,
    updated_at: Date.now(),
  };
}

async function listTx(device_id, limit = 50) {
  // กัน limit แปลกๆ และให้เป็นตัวเลขล้วน (1..200)
  const lim = Math.max(1, Math.min(200, Number(limit) || 50));

  if (device_id) {
    return db.all(
      `
      SELECT invoice_id, external_id, device_id, amount, status, paid_at, invoice_url, created_at, updated_at
      FROM \`transactions\`
      WHERE device_id = ?
      ORDER BY updated_at DESC
      LIMIT ${lim}
      `,
      [device_id]
    );
  }

  return db.all(
    `
    SELECT invoice_id, external_id, device_id, amount, status, paid_at, invoice_url, created_at, updated_at
    FROM \`transactions\`
    ORDER BY updated_at DESC
    LIMIT ${lim}
    `
  );
}


// ===== health =====
app.get("/health", (req, res) => res.status(200).send("OK"));

// ===== 5) Image assets (background/splash) =====
// POST /api/images/upload (multipart/form-data) fields: device_id(optional="ALL"), image(.jpg)
app.post("/api/images/upload", imageUpload.single("image"), (req, res) => {
  try {
    const device_id = safeDeviceId(req.body?.device_id);
    if (!req.file) return res.status(400).json({ ok: false, error: "image required" });

    const filename = req.file.filename;
    const url = `/images/${filename}`;
    const full = path.join(IMG_DIR, filename);
    const st = fs.existsSync(full) ? fs.statSync(full) : { size: req.file.size || 0 };

    res.setHeader("Cache-Control", "no-store");
    return res.json({
      ok: true,
      device_id,
      filename,
      url,
      size: st.size || 0,
      updated_at: Date.now()
    });
  } catch (e) {
    return res.status(500).json({ ok: false, error: "image upload failed", detail: e?.message || String(e) });
  }
});

// GET /api/images/list -> list current splash images
app.get("/api/images/list", (req, res) => {
  try {
    ensureDirSync(IMG_DIR);
    const files = fs.readdirSync(IMG_DIR)
      .filter((f) => /^splash(_[A-Z0-9_-]+)?\.jpg$/i.test(f))
      .sort((a, b) => a.localeCompare(b));
    res.setHeader("Cache-Control", "no-store");
    return res.json({ ok: true, files, updated_at: Date.now() });
  } catch (e) {
    return res.status(500).json({ ok: false, error: "list images failed", detail: e?.message || String(e) });
  }
});

// GET /api/images/resolve?device_id=DEVxxxx
// - if splash_DEVxxxx.jpg exists -> return it
// - else fallback -> splash.jpg (ALL)
app.get("/api/images/resolve", (req, res) => {
  try {
    const device_id = safeDeviceId(req.query?.device_id);
    ensureDirSync(IMG_DIR);

    const cand = device_id === "ALL" ? "splash.jpg" : `splash_${device_id}.jpg`;
    const full = path.join(IMG_DIR, cand);
    const fallback = path.join(IMG_DIR, "splash.jpg");

    let filename = "splash.jpg";
    if (device_id !== "ALL" && fs.existsSync(full)) filename = cand;
    else if (!fs.existsSync(fallback) && fs.existsSync(full)) filename = cand;

    res.setHeader("Cache-Control", "no-store");
    return res.json({ ok: true, device_id, filename, url: `/images/${filename}` });
  } catch (e) {
    return res.status(500).json({ ok: false, error: "resolve image failed", detail: e?.message || String(e) });
  }
});


// ===== 1) Create Invoice (ESP32 calls) =====
app.post("/api/invoice/create", async (req, res) => {
  try {
    requireEnv();

    const amount = Number(req.body.amount || 0);
    const device_id = String(req.body.device_id || "DEV1").trim().toUpperCase();
    const description = String(req.body.description || `IoT Pay ${device_id}`);

    if (!Number.isFinite(amount) || amount <= 0) {
      return res.status(400).json({ error: "amount must be > 0" });
    }

    const external_id = `iot_${device_id}_${Date.now()}_${Math.floor(Math.random() * 1000)}`;
    const webhookUrl = `${BASE_URL}/webhooks/xendit/invoice`;

    const payload = {
      external_id,
      amount,
      currency: "THB",
      description,
      invoice_callback_url: webhookUrl,
      invoice_duration: 60,
    };

    const r = await xendit.post("/v2/invoices", payload);
    const inv = r.data;

    const invoice_id = inv.id;
    const status = normalizeStatus(inv.status);

    await upsertTx({
      invoice_id,
      external_id: inv.external_id,
      device_id,
      amount: inv.amount,
      status,
      paid_at: inv.paid_at || null,
      invoice_url: inv.invoice_url,
      created_at: Date.now(),
    });

    return res.json({
      invoice_id,
      external_id: inv.external_id,
      device_id,
      amount: inv.amount,
      status,
      paid_at: inv.paid_at || null,
      invoice_url: inv.invoice_url,
    });
  } catch (err) {
    const detail = err?.response?.data || err?.message || String(err);
    console.error("CREATE INVOICE ERROR:", detail);
    return res.status(500).json({ error: "Create invoice failed", detail });
  }
});

// ===== 1.1) Cancel (expire) invoice =====
app.post("/api/invoice/cancel", async (req, res) => {
  try {
    requireEnv();

    const invoice_id = String(req.body.invoice_id || "").trim();
    const device_id = String(req.body.device_id || "").trim().toUpperCase();
    const reason = String(req.body.reason || "USER").trim().toUpperCase(); // USER | TIMEOUT
    if (!invoice_id) return res.status(400).json({ ok: false, error: "invoice_id required" });

    // helper: get invoice
    const getInv = async () => (await xendit.get(`/v2/invoices/${invoice_id}`)).data;

    // 1) Try expire endpoints (some environments use different paths)
    const expAttempts = [];
    let exp = { expired: false, via: null };
    for (const p of [`/invoices/${invoice_id}/expire`, `/v2/invoices/${invoice_id}/expire`]) {
      try {
        await xendit.post(p);
        exp = { expired: true, via: p, attempts: expAttempts };
        break;
      } catch (e) {
        expAttempts.push({ path: p, status: e?.response?.status || null, data: e?.response?.data || null });
      }
    }
    if (!exp.expired) exp.attempts = expAttempts;

    // 2) Always fetch "truth" (even if expire failed)
    let inv;
    try {
      inv = await getInv();
    } catch (eGet) {
      // If GET also fails, return the most useful error
      const last = Array.isArray(exp?.attempts) && exp.attempts.length ? exp.attempts[exp.attempts.length-1] : null;
      const code = last?.status || eGet?.response?.status || 500;
      return res.status(code).json({
        ok: false,
        error: last?.data || eGet?.response?.data || String(eGet?.message || eGet),
      });
    }

    const xStatus = normalizeStatus(inv.status);

    // 3) Decide final status for your system
    // - If already PAID => keep PAID
    // - Else treat as CANCELLED (USER/TIMEOUT)
    const finalStatus = (xStatus === "PAID") ? "PAID" : "CANCELLED";

    await upsertTx({
      invoice_id: inv.id,
      external_id: inv.external_id,
      device_id: device_id || guessDeviceId(inv.external_id),
      amount: inv.amount,
      status: finalStatus,
      paid_at: inv.paid_at || null,
      invoice_url: inv.invoice_url || null,
      updated_at: Date.now(),
    });

    return res.json({
      ok: true,
      status: finalStatus,
      xendit_status: xStatus,
      reason,
      invoice_id: inv.id,
      expire_attempt: exp,
    });
  } catch (e) {
    const code = e?.response?.status || 500;
    return res.status(code).json({
      ok: false,
      error: e?.response?.data || String(e?.message || e),
    });
  }
});

// ===== 2) Status poll (ESP32) =====
app.get("/api/invoice/status/:invoiceId", async (req, res) => {
  try {
    requireEnv();
    const invoiceId = req.params.invoiceId;

    const r = await xendit.get(`/v2/invoices/${invoiceId}`);
    const inv = r.data;

    const status = normalizeStatus(inv.status);

    await upsertTx({
      invoice_id: inv.id,
      external_id: inv.external_id,
      device_id: guessDeviceId(inv.external_id),
      amount: inv.amount,
      status,
      paid_at: inv.paid_at || null,
      invoice_url: inv.invoice_url,
    });

    return res.json({
      invoice_id: inv.id,
      external_id: inv.external_id,
      amount: inv.amount,
      status,
      paid_at: inv.paid_at || null,
    });
  } catch (err) {
    const detail = err?.response?.data || err?.message || String(err);
    console.error("STATUS ERROR:", detail);
    return res.status(500).json({ error: "Get invoice status failed", detail });
  }
});

// ===== 3) Webhook (Xendit -> server) =====
app.post("/webhooks/xendit/invoice", async (req, res) => {
  try {
    const token = req.header("x-callback-token") || req.header("X-CALLBACK-TOKEN") || "";
    if (XENDIT_WEBHOOK_TOKEN && token !== XENDIT_WEBHOOK_TOKEN) {
      return res.status(401).send("Invalid token");
    }

    const body = req.body || {};
    const invoice_id = body.id || body.invoice_id;
    const status = normalizeStatus(body.status);

    if (invoice_id) {
      await upsertTx({
        invoice_id,
        external_id: body.external_id,
        device_id: guessDeviceId(body.external_id),
        amount: body.amount,
        status,
        paid_at: body.paid_at || null,
        invoice_url: body.invoice_url || null,
      });
    }

    return res.status(200).send("OK");
  } catch (e) {
    console.error("WEBHOOK ERROR:", e);
    return res.status(200).send("OK");
  }
});

// ===== 4) Dashboard APIs =====
app.get("/api/dashboard/summary", async (req, res) => {
  try {
    let device_id = req.query.device_id ? String(req.query.device_id).trim().toUpperCase() : "";
    if (device_id === "ALL") device_id = "";
    const out = await getSummary(device_id || null);
    return res.json(out);
  } catch (e) {
    return res.status(500).json({ error: "dashboard summary failed", detail: e?.message || String(e) });
  }
});

app.get("/api/dashboard/transactions", async (req, res) => {
  try {
    let device_id = req.query.device_id ? String(req.query.device_id).trim().toUpperCase() : "";
    if (device_id === "ALL") device_id = "";
    const limit = req.query.limit || 50;
    const rows = await listTx(device_id || null, limit);
    return res.json({ device_id: device_id || "ALL", rows, updated_at: Date.now() });
  } catch (e) {
    return res.status(500).json({ error: "dashboard transactions failed", detail: e?.message || String(e) });
  }
});

// ===== 5) Device config APIs (amount buttons) =====
// GET /api/device/config?device_id=DEVxxxx&since=<updated_at>
// - if since matches latest updated_at -> 204 No Content
// - else -> 200 JSON {device_id,a1,a2,a3,updated_at}
app.get("/api/device/config", async (req, res) => {
  try {
    const device_id = String(req.query.device_id || "DEV1").trim().toUpperCase();
    const since = Number(req.query.since || 0);

    // 1) Per-device config
    let row = await db.get(
      `SELECT device_id, a1, a2, a3, updated_at FROM device_config WHERE device_id = ?`,
      [device_id]
    );

    // 2) Fallback: default config stored in device_id="ALL"
    if (!row && device_id !== "ALL") {
      const def = await db.get(
        `SELECT device_id, a1, a2, a3, updated_at FROM device_config WHERE device_id = 'ALL'`
      );
      if (def) {
        row = { device_id, a1: def.a1, a2: def.a2, a3: def.a3, updated_at: def.updated_at };
      }
    }

    // 3) Built-in defaults if nothing exists
    const cfg = row || { device_id, a1: 10, a2: 20, a3: 30, updated_at: 0 };

    // If caller already has latest version, return 204.
    if (Number.isFinite(since) && since === Number(cfg.updated_at)) {
      return res.status(204).end();
    }

    return res.json(cfg);
  } catch (e) {
    return res.status(500).json({ error: "device config failed", detail: e?.message || String(e) });
  }
});


// ===== GPS locations for map/dashboard =====
app.get("/api/dashboard/locations", async (req, res) => {
  try {
    const q = String(req.query.device_id || "ALL").trim().toUpperCase();
    const device_id = safeDeviceId(q);

    let rows;
    if (!device_id || device_id === "ALL") {
      rows = await db.all(
        `SELECT device_id, device_name, fix, lat, lon, hdop, gps_svs, updated_at
         FROM device_location
         ORDER BY updated_at DESC`
      );
    } else {
      rows = await db.all(
        `SELECT device_id, device_name, fix, lat, lon, hdop, gps_svs, updated_at
         FROM device_location
         WHERE device_id = ?
         ORDER BY updated_at DESC`,
        [device_id]
      );
    }

    res.setHeader("Cache-Control", "no-store");
    return res.json({ ok: true, rows });
  } catch (e) {
    return res.status(500).json({ ok: false, error: "locations read failed", detail: e?.message || String(e) });
  }
});

;



// POST /api/device/location
// body: { device_id, device_name?, fix, lat?, lon?, hdop?, gps_svs? }
app.post("/api/device/location", async (req, res) => {
  try {
    const device_id = safeDeviceId(req.body?.device_id);
    const device_name = String(req.body?.device_name || device_id || "").trim().slice(0, 120);
    const fix = Number(req.body?.fix) ? 1 : 0;

    if (!device_id || device_id === "ALL") {
      return res.status(400).json({ ok: false, error: "device_id required" });
    }

    const latRaw = req.body?.lat;
    const lonRaw = req.body?.lon;
    const hdopRaw = req.body?.hdop;
    const gpsSvsRaw = req.body?.gps_svs;

    const lat = (latRaw === undefined || latRaw === null || latRaw === "") ? null : Number(latRaw);
    const lon = (lonRaw === undefined || lonRaw === null || lonRaw === "") ? null : Number(lonRaw);
    const hdop = (hdopRaw === undefined || hdopRaw === null || hdopRaw === "") ? null : Number(hdopRaw);
    const gps_svs = (gpsSvsRaw === undefined || gpsSvsRaw === null || gpsSvsRaw === "") ? null : Math.trunc(Number(gpsSvsRaw));

    if (fix) {
      if (!Number.isFinite(lat) || !Number.isFinite(lon)) {
        return res.status(400).json({ ok: false, error: "lat/lon required when fix=1" });
      }
      if (lat < -90 || lat > 90 || lon < -180 || lon > 180) {
        return res.status(400).json({ ok: false, error: "lat/lon out of range" });
      }
    }

    const now = Date.now();

    await db.run(
      `
      INSERT INTO device_location (device_id, device_name, fix, lat, lon, hdop, gps_svs, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      ON DUPLICATE KEY UPDATE
        device_name = VALUES(device_name),
        fix = VALUES(fix),
        lat = VALUES(lat),
        lon = VALUES(lon),
        hdop = VALUES(hdop),
        gps_svs = VALUES(gps_svs),
        updated_at = VALUES(updated_at)
      `,
      [
        device_id,
        device_name || device_id,
        fix,
        fix ? lat : null,
        fix ? lon : null,
        fix && Number.isFinite(hdop) ? hdop : null,
        fix && Number.isFinite(gps_svs) ? gps_svs : null,
        now,
      ]
    );

    res.setHeader("Cache-Control", "no-store");
    return res.json({
      ok: true,
      device_id,
      device_name: device_name || device_id,
      fix,
      lat: fix ? lat : null,
      lon: fix ? lon : null,
      hdop: fix && Number.isFinite(hdop) ? hdop : null,
      gps_svs: fix && Number.isFinite(gps_svs) ? gps_svs : null,
      updated_at: now,
    });
  } catch (e) {
    return res.status(500).json({ ok: false, error: "location save failed", detail: e?.message || String(e) });
  }
});

// POST /api/device/config
// body: {device_id, a1, a2, a3}
app.post("/api/device/config", async (req, res) => {
  try {
    const device_id = String(req.body.device_id || "").trim().toUpperCase();
    const a1 = Number(req.body.a1);
    const a2 = Number(req.body.a2);
    const a3 = Number(req.body.a3);

    if (!device_id) return res.status(400).json({ error: "device_id required" });
    if (![a1, a2, a3].every((v) => Number.isFinite(v) && v > 0)) {
      return res.status(400).json({ error: "a1, a2, a3 must be > 0" });
    }

    const out = await upsertDeviceConfig(device_id, Math.floor(a1), Math.floor(a2), Math.floor(a3));
    return res.json({ ok: true, ...out });
  } catch (e) {
    return res.status(500).json({ error: "device config save failed", detail: e?.message || String(e) });
  }
});

// POST /api/device/config/apply-all
// body: {a1, a2, a3}
// - creates/updates default row (device_id="ALL")
// - pushes the same config to all known devices (seen in tx/location/config tables)
app.post("/api/device/config/apply-all", async (req, res) => {
  try {
    const a1 = Number(req.body.a1);
    const a2 = Number(req.body.a2);
    const a3 = Number(req.body.a3);

    if (![a1, a2, a3].every((v) => Number.isFinite(v) && v > 0)) {
      return res.status(400).json({ ok: false, error: "a1, a2, a3 must be > 0" });
    }

    // 1) default (ALL)
    await upsertDeviceConfig("ALL", Math.floor(a1), Math.floor(a2), Math.floor(a3));

    // 2) collect device ids we know
    const txIds = await db.all(`SELECT DISTINCT device_id FROM transactions WHERE device_id IS NOT NULL AND TRIM(device_id) <> ''`);
    const locIds = await db.all(`SELECT DISTINCT device_id FROM device_location WHERE device_id IS NOT NULL AND TRIM(device_id) <> ''`);
    const cfgIds = await db.all(`SELECT DISTINCT device_id FROM device_config WHERE device_id IS NOT NULL AND TRIM(device_id) <> ''`);

    const set = new Set();
    for (const r of [...txIds, ...locIds, ...cfgIds]) {
      const id = String(r.device_id || "").trim().toUpperCase();
      if (!id || id === "ALL") continue;
      set.add(id);
    }

    let updated = 0;
    for (const id of set) {
      await upsertDeviceConfig(id, Math.floor(a1), Math.floor(a2), Math.floor(a3));
      updated++;
    }

    return res.json({ ok: true, default: "ALL", devices_updated: updated, updated_at: Date.now() });
  } catch (e) {
    return res.status(500).json({ ok: false, error: "apply-all failed", detail: e?.message || String(e) });
  }
});

// GET /api/devices/list (optional helper for UI)
app.get("/api/devices/list", async (req, res) => {
  try {
    const txIds = await db.all(`SELECT DISTINCT device_id FROM transactions WHERE device_id IS NOT NULL AND TRIM(device_id) <> ''`);
    const locIds = await db.all(`SELECT DISTINCT device_id FROM device_location WHERE device_id IS NOT NULL AND TRIM(device_id) <> ''`);
    const cfgIds = await db.all(`SELECT DISTINCT device_id FROM device_config WHERE device_id IS NOT NULL AND TRIM(device_id) <> ''`);

    const set = new Set();
    for (const r of [...txIds, ...locIds, ...cfgIds]) {
      const id = String(r.device_id || "").trim().toUpperCase();
      if (!id) continue;
      set.add(id);
    }

    const devices = Array.from(set).sort((a,b)=>a.localeCompare(b));
    res.setHeader("Cache-Control", "no-store");
    return res.json({ ok: true, devices, updated_at: Date.now() });
  } catch (e) {
    return res.status(500).json({ ok: false, error: "devices list failed", detail: e?.message || String(e) });
  }
});


// Backward compatible endpoints (dashboard.js tries these as fallback)
app.get("/summary", (req, res) => res.redirect("/api/dashboard/summary" + (req.url.includes("?") ? req.url.slice(req.url.indexOf("?")) : "")));
app.get("/transactions", (req, res) => res.redirect("/api/dashboard/transactions" + (req.url.includes("?") ? req.url.slice(req.url.indexOf("?")) : "")));


// ===== 6) OTA firmware (ESP32 over SIM/Wi-Fi) =====
// Files (primary):
//   - ./data/ota/firmware.json
//   - ./data/ota/firmware.bin
// Optional fallback (old structure):
//   - ./data/firmware/firmware.json
//   - ./data/firmware/firmware.bin
//
// ESP32 flow (recommended):
//   GET  /api/ota/manifest?version=<current>&meta=1
//     -> always 200 with schedule + server time
//   GET  /ota/firmware.bin
//
// Legacy ESP32 flow (older firmware):
//   GET  /api/ota/manifest?version=<current>
//     -> 204 when same version, 200 when update available
//
// Web UI flow:
//   POST /api/ota/upload (multipart/form-data) fields: version, firmware(.bin)
//   POST /api/ota/schedule (json) { apply_time: "HH:MM", tz_offset_min?: 420 }

const OTA_DIR_PRIMARY = path.join(__dirname, "data", "ota");
const OTA_DIR_FALLBACK = path.join(__dirname, "data", "firmware");
const OTA_BIN_FILE = "firmware.bin";
const OTA_MANIFEST_FILE = "firmware.json";

function ensureDir(p) {
  if (!fs.existsSync(p)) fs.mkdirSync(p, { recursive: true });
}

function resolveOtaDir() {
  const pManifest = path.join(OTA_DIR_PRIMARY, OTA_MANIFEST_FILE);
  if (fs.existsSync(pManifest)) return OTA_DIR_PRIMARY;
  const fManifest = path.join(OTA_DIR_FALLBACK, OTA_MANIFEST_FILE);
  if (fs.existsSync(fManifest)) return OTA_DIR_FALLBACK;
  return OTA_DIR_PRIMARY;
}

function readOtaManifest() {
  const dir = resolveOtaDir();
  const manifestPath = path.join(dir, OTA_MANIFEST_FILE);
  if (!fs.existsSync(manifestPath)) return null;
  try {
    const m = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
    return { dir, manifestPath, manifest: m };
  } catch {
    return { dir, manifestPath, manifest: null };
  }
}

function writeOtaManifest(manifest) {
  ensureDir(OTA_DIR_PRIMARY);
  const manifestPath = path.join(OTA_DIR_PRIMARY, OTA_MANIFEST_FILE);
  fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2));
  return { dir: OTA_DIR_PRIMARY, manifestPath };
}

function isValidHHMM(s) {
  return /^([01]\d|2[0-3]):[0-5]\d$/.test(String(s || "").trim());
}

function sanitizeOtaManifest(m) {
  // Keep it stable & predictable for the ESP32
  const out = {
    version: String(m?.version || "").trim(),
    url: String(m?.url || "/ota/firmware.bin").trim(),
    apply_time: isValidHHMM(m?.apply_time) ? String(m.apply_time) : "00:00",
    tz_offset_min: Number.isFinite(Number(m?.tz_offset_min)) ? Number(m.tz_offset_min) : 420, // Asia/Bangkok = +7h
  };
  return out;
}

/**
 * GET /api/ota/manifest
 * - Legacy (meta=0): 204 when same version, 200 when update available
 * - meta=1: always 200 with schedule + server time, plus update_available
 */
app.get("/api/ota/manifest", (req, res) => {
  try {
    const metaMode = String(req.query.meta || "").trim() === "1";
    const cur = String(req.query.version || "").trim();

    const r = readOtaManifest();
    if (!r?.manifest) return res.status(404).json({ error: "manifest not found" });

    const m = sanitizeOtaManifest(r.manifest);

    const sameVersion = !!(cur && m.version && cur === m.version);
    const updateAvailable = !!(cur && m.version && cur !== m.version);

    res.setHeader("Cache-Control", "no-store");

    // meta=1: always return 200 (so device can fetch schedule/time even when no update)
    if (metaMode) {
      return res.json({
        ...m,
        update_available: updateAvailable,
        same_version: sameVersion,
        server_epoch: Math.floor(Date.now() / 1000),
      });
    }

    // legacy behavior
    if (sameVersion) return res.status(204).end();
    return res.json(m);
  } catch (e) {
    return res.status(500).json({ error: "ota manifest failed", detail: e?.message || String(e) });
  }
});

app.get("/api/ota/schedule", (req, res) => {
  try {
    const r = readOtaManifest();
    if (!r?.manifest) return res.status(404).json({ error: "manifest not found" });
    const m = sanitizeOtaManifest(r.manifest);
    res.setHeader("Cache-Control", "no-store");
    return res.json({
      apply_time: m.apply_time,
      tz_offset_min: m.tz_offset_min,
      server_epoch: Math.floor(Date.now() / 1000),
    });
  } catch (e) {
    return res.status(500).json({ error: "ota schedule read failed", detail: e?.message || String(e) });
  }
});

app.post("/api/ota/schedule", (req, res) => {
  try {
    const apply_time = String(req.body?.apply_time || "").trim();
    const tz_offset_min_raw = req.body?.tz_offset_min;

    if (!isValidHHMM(apply_time)) {
      return res.status(400).json({ ok: false, error: 'apply_time must be "HH:MM" (00:00-23:59)' });
    }

    let tz_offset_min = 420;
    if (tz_offset_min_raw !== undefined) {
      const n = Number(tz_offset_min_raw);
      if (!Number.isFinite(n) || n < -12 * 60 || n > 14 * 60) {
        return res.status(400).json({ ok: false, error: "tz_offset_min invalid" });
      }
      tz_offset_min = Math.trunc(n);
    }

    const r = readOtaManifest();
    if (!r?.manifest) return res.status(404).json({ ok: false, error: "manifest not found" });

    const m0 = sanitizeOtaManifest(r.manifest);
    const m1 = { ...m0, apply_time, tz_offset_min };

    writeOtaManifest(m1);

    return res.json({ ok: true, ...m1 });
  } catch (e) {
    return res.status(500).json({ ok: false, error: "ota schedule save failed", detail: e?.message || String(e) });
  }
});

app.get("/ota/firmware.bin", (req, res) => {
  try {
    const dir = resolveOtaDir();
    const binPath = path.join(dir, OTA_BIN_FILE);
    if (!fs.existsSync(binPath)) return res.status(404).send("firmware not found");

    const st = fs.statSync(binPath);
    res.setHeader("Content-Type", "application/octet-stream");
    res.setHeader("Cache-Control", "no-store");
    res.setHeader("Content-Length", st.size);
    res.setHeader("Content-Encoding", "identity");

    fs.createReadStream(binPath).pipe(res);
  } catch (e) {
    return res.status(500).send("ota download failed");
  }
});

app.post("/api/ota/upload", otaUpload.single("firmware"), (req, res) => {
  try {
    const version = String(req.body.version || "").trim();
    if (!version) return res.status(400).json({ ok: false, error: "version required" });
    if (version.length > 32) return res.status(400).json({ ok: false, error: "version too long" });

    const file = req.file;
    if (!file?.buffer?.length) return res.status(400).json({ ok: false, error: "firmware file required" });

    // preserve existing schedule if present
    const r = readOtaManifest();
    const preserved = sanitizeOtaManifest(r?.manifest || {});

    ensureDir(OTA_DIR_PRIMARY);
    fs.writeFileSync(path.join(OTA_DIR_PRIMARY, OTA_BIN_FILE), file.buffer);

    const manifest = sanitizeOtaManifest({
      ...preserved,
      version,
      url: "/ota/firmware.bin",
    });

    fs.writeFileSync(path.join(OTA_DIR_PRIMARY, OTA_MANIFEST_FILE), JSON.stringify(manifest, null, 2));

    return res.json({ ok: true, version, size: file.size, url: manifest.url, apply_time: manifest.apply_time, tz_offset_min: manifest.tz_offset_min });
  } catch (e) {
    return res.status(500).json({ ok: false, error: "ota upload failed", detail: e?.message || String(e) });
  }
});


// ===== start =====
initDb()
  .then(() => {
    app.listen(PORT, () => {
      console.log(`Server running on http://localhost:${PORT}`);
      console.log(`Dashboard: http://localhost:${PORT}/dashboard.html`);
      console.log(`Webhook: ${BASE_URL}/webhooks/xendit/invoice`);
    });
  })
  .catch((e) => {
    console.error("DB init failed:", e);
    process.exit(1);
  });
