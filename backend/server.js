const http = require("http");
const fs = require("fs/promises");
const path = require("path");
const crypto = require("crypto");

const PORT = Number(process.env.PORT || 4173);
const HOST = process.env.HOST || "0.0.0.0";
const BACKEND_DIR = __dirname;
const PROJECT_ROOT = path.join(BACKEND_DIR, "..");
const FRONTEND_DIR = path.join(PROJECT_ROOT, "frontend");
const ASSETS_DIR = path.join(FRONTEND_DIR, "assets");
const DATA_DIR = path.join(BACKEND_DIR, "data");
const DB_FILE = path.join(DATA_DIR, "submissions.json");
const MAX_BODY_SIZE = 1_000_000;

const mime = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".mp4": "video/mp4",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".svg": "image/svg+xml",
  ".webp": "image/webp",
  ".ico": "image/x-icon",
};

function headers(type, extra = {}) {
  return {
    "Content-Type": type,
    "Access-Control-Allow-Origin": process.env.CORS_ORIGIN || "*",
    "Access-Control-Allow-Methods": "GET,POST,OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type",
    "Access-Control-Max-Age": "86400",
    "X-Content-Type-Options": "nosniff",
    "X-Frame-Options": "SAMEORIGIN",
    "Referrer-Policy": "no-referrer-when-downgrade",
    "Permissions-Policy": "camera=(), microphone=(), geolocation=()",
    "Content-Security-Policy":
      "default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; media-src 'self'; connect-src 'self'; base-uri 'self'; form-action 'self'; frame-ancestors 'self'",
    ...extra,
  };
}

function send(res, status, body, type = "application/json; charset=utf-8", extra = {}) {
  res.writeHead(status, headers(type, extra));
  res.end(body);
}

function pathnameFrom(req) {
  try {
    return decodeURIComponent(new URL(req.url, `http://${req.headers.host || "localhost"}`).pathname);
  } catch {
    return null;
  }
}

function isInside(parent, target) {
  const relative = path.relative(parent, target);
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

async function ensureDb() {
  await fs.mkdir(DATA_DIR, { recursive: true });
  try {
    await fs.access(DB_FILE);
  } catch {
    await fs.writeFile(DB_FILE, "[]\n", "utf8");
  }
}

async function readSubmissions() {
  await ensureDb();
  const raw = await fs.readFile(DB_FILE, "utf8");
  return JSON.parse(raw || "[]");
}

async function writeSubmissions(items) {
  await ensureDb();
  await fs.writeFile(DB_FILE, `${JSON.stringify(items, null, 2)}\n`, "utf8");
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let body = "";
    req.on("data", (chunk) => {
      body += chunk;
      if (body.length > MAX_BODY_SIZE) {
        reject(new Error("Request body too large"));
        req.destroy();
      }
    });
    req.on("end", () => resolve(body));
    req.on("error", reject);
  });
}

function csvEscape(value) {
  const text = Array.isArray(value) ? value.join("、") : String(value ?? "");
  return `"${text.replaceAll('"', '""')}"`;
}

function toCsv(items) {
  const headersRow = [
    "提交时间",
    "性别",
    "工作类型",
    "关注话题",
    "综合元气指数",
    "脑部精神",
    "眼部健康",
    "肩颈上肢",
    "全身循环",
  ];
  const rows = items.map((item) => {
    const parts = Object.fromEntries(item.report.parts || []);
    return [
      item.createdAt,
      item.gender,
      item.workType,
      item.topics,
      item.report.total,
      parts["脑部精神"],
      parts["眼部健康"],
      parts["肩颈上肢"],
      parts["全身循环"],
    ].map(csvEscape);
  });
  return [headersRow.map(csvEscape), ...rows].map((row) => row.join(",")).join("\n");
}

function resolveStaticFile(pathname) {
  if (pathname === "/" || pathname === "/index.html") return path.join(FRONTEND_DIR, "index.html");
  if (pathname === "/admin" || pathname === "/admin.html") return path.join(FRONTEND_DIR, "admin.html");

  if (pathname.startsWith("/assets/")) {
    const filePath = path.join(FRONTEND_DIR, pathname);
    if (isInside(ASSETS_DIR, filePath)) return filePath;
  }

  return null;
}

async function serveFile(req, res, filePath) {
  try {
    const ext = path.extname(filePath).toLowerCase();
    if (!mime[ext]) {
      send(res, 403, "Forbidden", "text/plain; charset=utf-8");
      return;
    }

    const body = await fs.readFile(filePath);
    send(res, 200, req.method === "HEAD" ? "" : body, mime[ext], {
      "Cache-Control": ext === ".html" ? "no-store" : "public, max-age=31536000, immutable",
    });
  } catch {
    send(res, 404, "Not found", "text/plain; charset=utf-8");
  }
}

async function handleApi(req, res, pathname) {
  if (req.method === "GET" && pathname === "/api/submissions") {
    const items = await readSubmissions();
    send(res, 200, JSON.stringify(items));
    return true;
  }

  if (req.method === "POST" && pathname === "/api/submissions") {
    let payload;
    try {
      payload = JSON.parse(await readBody(req));
    } catch {
      send(res, 400, JSON.stringify({ error: "Invalid JSON payload" }));
      return true;
    }

    const items = await readSubmissions();
    const record = {
      id: crypto.randomUUID(),
      createdAt: new Date().toISOString(),
      gender: payload.gender,
      workType: payload.workType,
      topics: payload.topics || [],
      scores: payload.scores || {},
      report: payload.report || { total: 0, parts: [] },
    };

    items.unshift(record);
    await writeSubmissions(items);
    send(res, 201, JSON.stringify(record));
    return true;
  }

  if (req.method === "GET" && pathname === "/api/export") {
    const items = await readSubmissions();
    send(res, 200, `\ufeff${toCsv(items)}`, "text/csv; charset=utf-8", {
      "Content-Disposition": 'attachment; filename="vitality-submissions.csv"',
    });
    return true;
  }

  return false;
}

const server = http.createServer(async (req, res) => {
  try {
    if (req.method === "OPTIONS") {
      send(res, 204, "", "text/plain; charset=utf-8");
      return;
    }

    const pathname = pathnameFrom(req);
    if (!pathname) {
      send(res, 400, "Bad request", "text/plain; charset=utf-8");
      return;
    }

    if (await handleApi(req, res, pathname)) return;

    const filePath = resolveStaticFile(pathname);
    if (filePath) {
      await serveFile(req, res, filePath);
      return;
    }

    send(res, 404, "Not found", "text/plain; charset=utf-8");
  } catch (error) {
    send(res, 500, JSON.stringify({ error: error.message }));
  }
});

ensureDb().then(() => {
  server.listen(PORT, HOST, () => {
    console.log(`H5: http://localhost:${PORT}`);
    console.log(`Admin: http://localhost:${PORT}/admin`);
  });
});
