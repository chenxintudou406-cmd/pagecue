const http = require("node:http");
const fs = require("node:fs");
const path = require("node:path");
const { randomUUID } = require("node:crypto");
const { URL } = require("node:url");

const PORT = Number(process.env.PORT || 8787);
const HOST = process.env.HOST || "127.0.0.1";
const ROOT = __dirname;
const DATA_FILE = process.env.CONTEXT_COMPANION_DATA || path.join(ROOT, "data", "db.json");
const ADMIN_ROOT = path.join(ROOT, "admin");
const DEMO_ROOT = path.join(ROOT, "demo");

function readDb() {
  const db = JSON.parse(fs.readFileSync(DATA_FILE, "utf8"));
  if (!Array.isArray(db.pageGroups)) db.pageGroups = [];
  return db;
}

function writeDb(db) {
  fs.writeFileSync(DATA_FILE, `${JSON.stringify(db, null, 2)}\n`, "utf8");
}

function send(res, status, body, type = "application/json; charset=utf-8") {
  const payload = type.startsWith("application/json") ? JSON.stringify(body) : body;
  res.writeHead(status, {
    "Content-Type": type,
    "Content-Length": Buffer.byteLength(payload),
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Headers": "Content-Type, X-User-Id",
    "Access-Control-Allow-Methods": "GET, POST, PUT, DELETE, OPTIONS",
    "Cache-Control": "no-store"
  });
  res.end(payload);
}

function parseBody(req) {
  return new Promise((resolve, reject) => {
    let raw = "";
    req.on("data", chunk => {
      raw += chunk;
      if (raw.length > 1_000_000) reject(new Error("请求内容过大"));
    });
    req.on("end", () => {
      try {
        resolve(raw ? JSON.parse(raw) : {});
      } catch {
        reject(new Error("JSON 格式错误"));
      }
    });
    req.on("error", reject);
  });
}

function isActive(item, now = Date.now()) {
  if (item.status && item.status !== "published") return false;
  if (item.startsAt && Date.parse(item.startsAt) > now) return false;
  if (item.expiresAt && Date.parse(item.expiresAt) <= now) return false;
  return true;
}

function visibleTo(item, user) {
  if (item.scope === "personal") return item.ownerId === user.id;
  const targets = item.targetGroupIds || [];
  return targets.length === 0 || targets.some(id => user.groupIds.includes(id));
}

function cleanMemo(input, existing = {}) {
  const scope = input.scope === "personal" ? "personal" : "organization";
  const now = new Date().toISOString();
  return {
    ...existing,
    id: existing.id || `memo_${randomUUID()}`,
    scope,
    ownerId: scope === "personal" ? String(input.ownerId || existing.ownerId || "") : null,
    title: String(input.title || "未命名备忘").trim().slice(0, 120),
    body: String(input.body || "").slice(0, 20_000),
    tags: Array.isArray(input.tags) ? input.tags.map(String).slice(0, 20) : [],
    links: Array.isArray(input.links)
      ? input.links.slice(0, 20).map(link => ({ label: String(link.label || link.url || "链接"), url: String(link.url || "") }))
      : [],
    rule: normalizeRule(input.rule),
    targetGroupIds: scope === "organization" && Array.isArray(input.targetGroupIds) ? input.targetGroupIds.map(String) : [],
    priority: ["normal", "important"].includes(input.priority) ? input.priority : "normal",
    status: ["draft", "published", "archived"].includes(input.status) ? input.status : "published",
    startsAt: input.startsAt || null,
    expiresAt: input.expiresAt || null,
    version: Number(existing.version || 0) + 1,
    createdAt: existing.createdAt || now,
    updatedAt: now
  };
}

function normalizeRule(rule = {}) {
  const sitePatterns = Array.isArray(rule.sitePatterns) ? rule.sitePatterns.map(String).filter(Boolean).slice(0, 30) : [];
  const pageGroupIds = Array.isArray(rule.pageGroupIds) ? rule.pageGroupIds.map(String).filter(Boolean).slice(0, 20) : [];
  return {
    pageScope: rule.pageScope === "global" ? "global" : (rule.pageScope === "page_groups" || pageGroupIds.length || sitePatterns.length ? "page_groups" : "global"),
    pageGroupIds,
    sitePatterns,
    includeTerms: Array.isArray(rule.includeTerms) ? rule.includeTerms.map(String).filter(Boolean).slice(0, 50) : [],
    excludeTerms: Array.isArray(rule.excludeTerms) ? rule.excludeTerms.map(String).filter(Boolean).slice(0, 50) : [],
    operator: rule.operator === "OR" ? "OR" : "AND",
    caseSensitive: Boolean(rule.caseSensitive),
    useRegex: Boolean(rule.useRegex),
    cooldownMinutes: Math.max(1, Math.min(Number(rule.cooldownMinutes || 30), 10_080))
  };
}

function resolveMemoPageGroups(memo, pageGroups = []) {
  const rule = normalizeRule(memo.rule);
  if (rule.pageScope === "global") return { ...memo, rule: { ...rule, sitePatterns: [] } };
  const selectedPatterns = pageGroups
    .filter(group => rule.pageGroupIds.includes(group.id))
    .flatMap(group => group.sitePatterns || []);
  return { ...memo, rule: { ...rule, sitePatterns: [...new Set(selectedPatterns.length ? selectedPatterns : rule.sitePatterns)] } };
}

function cleanPageGroup(input, existing = {}) {
  const now = new Date().toISOString();
  return {
    ...existing,
    id: existing.id || `page_group_${randomUUID()}`,
    name: String(input.name || "未命名页面组").trim().slice(0, 80),
    description: String(input.description || "").trim().slice(0, 300),
    sitePatterns: Array.isArray(input.sitePatterns) ? [...new Set(input.sitePatterns.map(String).map(item => item.trim()).filter(Boolean))].slice(0, 50) : [],
    createdAt: existing.createdAt || now,
    updatedAt: now
  };
}

function cleanTool(input, existing = {}) {
  const now = new Date().toISOString();
  const scope = input.scope === "personal" ? "personal" : "organization";
  return {
    ...existing,
    id: existing.id || `tool_${randomUUID()}`,
    scope,
    ownerId: scope === "personal" ? String(input.ownerId || existing.ownerId || "") : null,
    category: String(input.category || "常用").trim().slice(0, 50),
    title: String(input.title || "未命名工具").trim().slice(0, 100),
    description: String(input.description || "").slice(0, 300),
    url: String(input.url || "").trim(),
    icon: String(input.icon || "↗").slice(0, 4),
    targetGroupIds: scope === "organization" && Array.isArray(input.targetGroupIds) ? input.targetGroupIds.map(String) : [],
    status: ["draft", "published", "archived"].includes(input.status) ? input.status : "published",
    sortOrder: Number(input.sortOrder || 0),
    createdAt: existing.createdAt || now,
    updatedAt: now
  };
}

function eventStats(events) {
  const totals = { triggered: 0, opened: 0, confirmed: 0, ignored: 0, snoozed: 0, helpful: 0, unhelpful: 0 };
  for (const event of events) if (Object.hasOwn(totals, event.action)) totals[event.action] += 1;
  const feedbackTotal = totals.helpful + totals.unhelpful;
  return {
    ...totals,
    openRate: totals.triggered ? totals.opened / totals.triggered : 0,
    helpfulRate: feedbackTotal ? totals.helpful / feedbackTotal : 0
  };
}

function serveStatic(reqPath, res) {
  const relative = reqPath === "/admin" || reqPath === "/admin/" ? "index.html" : reqPath.replace(/^\/admin\//, "");
  const resolved = path.resolve(ADMIN_ROOT, relative);
  if (!resolved.startsWith(path.resolve(ADMIN_ROOT)) || !fs.existsSync(resolved) || fs.statSync(resolved).isDirectory()) return false;
  const ext = path.extname(resolved);
  const type = { ".html": "text/html; charset=utf-8", ".css": "text/css; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".svg": "image/svg+xml", ".png": "image/png" }[ext] || "application/octet-stream";
  send(res, 200, fs.readFileSync(resolved), type);
  return true;
}

function serveDemo(reqPath, res) {
  const relative = reqPath === "/demo" || reqPath === "/demo/" ? "index.html" : reqPath.replace(/^\/demo\//, "");
  const resolved = path.resolve(DEMO_ROOT, relative);
  if (!resolved.startsWith(path.resolve(DEMO_ROOT)) || !fs.existsSync(resolved) || fs.statSync(resolved).isDirectory()) return false;
  const ext = path.extname(resolved);
  const type = { ".html": "text/html; charset=utf-8", ".css": "text/css; charset=utf-8", ".js": "text/javascript; charset=utf-8" }[ext] || "application/octet-stream";
  send(res, 200, fs.readFileSync(resolved), type);
  return true;
}

async function handleApi(req, res, url) {
  const db = readDb();
  const parts = url.pathname.split("/").filter(Boolean);

  if (req.method === "GET" && url.pathname === "/api/health") {
    return send(res, 200, { ok: true, version: db.meta.version, time: new Date().toISOString() });
  }

  if (req.method === "GET" && url.pathname === "/api/bootstrap") {
    const userId = url.searchParams.get("userId") || req.headers["x-user-id"] || "user_demo";
    const user = db.users.find(item => item.id === userId);
    if (!user) return send(res, 404, { error: "用户不存在" });
    return send(res, 200, {
      version: db.meta.version,
      user,
      groups: db.groups.filter(group => user.groupIds.includes(group.id)),
      memos: db.memos.filter(item => isActive(item) && visibleTo(item, user)).map(item => resolveMemoPageGroups(item, db.pageGroups)),
      tools: db.tools.filter(item => isActive(item) && visibleTo(item, user)).sort((a, b) => a.sortOrder - b.sortOrder),
      pageGroups: db.pageGroups,
      settings: db.settings
    });
  }

  if (req.method === "GET" && url.pathname === "/api/admin/state") {
    return send(res, 200, { ...db, stats: eventStats(db.events) });
  }

  if (req.method === "POST" && url.pathname === "/api/events") {
    const body = await parseBody(req);
    const allowedActions = ["triggered", "opened", "confirmed", "ignored", "snoozed", "helpful", "unhelpful"];
    if (!allowedActions.includes(body.action)) return send(res, 400, { error: "不支持的事件类型" });
    const event = {
      id: `event_${randomUUID()}`,
      organizationId: db.meta.organizationId,
      userId: String(body.userId || "anonymous"),
      memoId: String(body.memoId || ""),
      ruleId: String(body.ruleId || body.memoId || ""),
      domain: String(body.domain || "").slice(0, 255),
      action: body.action,
      presentation: String(body.presentation || "sidepanel"),
      createdAt: new Date().toISOString()
    };
    db.events.push(event);
    db.events = db.events.slice(-2000);
    writeDb(db);
    return send(res, 201, event);
  }

  if (req.method === "POST" && url.pathname === "/api/personal-memos") {
    const body = await parseBody(req);
    const memo = cleanMemo({ ...body, scope: "personal", status: "published" });
    if (!db.users.some(user => user.id === memo.ownerId)) return send(res, 400, { error: "个人备忘缺少有效用户" });
    db.memos.push(memo);
    db.meta.version += 1;
    writeDb(db);
    return send(res, 201, memo);
  }

  const personalMatch = url.pathname.match(/^\/api\/personal-memos\/([^/]+)$/);
  if (personalMatch && ["PUT", "DELETE"].includes(req.method)) {
    const index = db.memos.findIndex(item => item.id === personalMatch[1] && item.scope === "personal");
    if (index < 0) return send(res, 404, { error: "个人备忘不存在" });
    const userId = url.searchParams.get("userId") || req.headers["x-user-id"];
    if (userId !== db.memos[index].ownerId) return send(res, 403, { error: "无权修改该备忘" });
    if (req.method === "DELETE") db.memos.splice(index, 1);
    else db.memos[index] = cleanMemo({ ...(await parseBody(req)), scope: "personal", ownerId: userId }, db.memos[index]);
    db.meta.version += 1;
    writeDb(db);
    return send(res, 200, req.method === "DELETE" ? { ok: true } : db.memos[index]);
  }

  const adminCollection = parts[2];
  const collectionMap = { memos: "memos", tools: "tools", "page-groups": "pageGroups" };
  if (parts[0] === "api" && parts[1] === "admin" && Object.hasOwn(collectionMap, adminCollection)) {
    const collection = collectionMap[adminCollection];
    const cleaner = collection === "memos" ? cleanMemo : collection === "tools" ? cleanTool : cleanPageGroup;
    if (req.method === "POST" && parts.length === 3) {
      const item = cleaner(await parseBody(req));
      db[collection].push(item);
      db.meta.version += 1;
      writeDb(db);
      return send(res, 201, item);
    }
    if (["PUT", "DELETE"].includes(req.method) && parts.length === 4) {
      const index = db[collection].findIndex(item => item.id === parts[3]);
      if (index < 0) return send(res, 404, { error: "内容不存在" });
      if (req.method === "DELETE" && collection === "pageGroups") {
        const usedBy = db.memos.filter(item => item.rule?.pageGroupIds?.includes(parts[3]));
        if (usedBy.length) return send(res, 409, { error: `该页面组正被 ${usedBy.length} 条备忘使用，请先调整备忘范围` });
        db[collection].splice(index, 1);
      }
      else if (req.method === "DELETE") db[collection][index] = { ...db[collection][index], status: "archived", updatedAt: new Date().toISOString() };
      else db[collection][index] = cleaner(await parseBody(req), db[collection][index]);
      db.meta.version += 1;
      writeDb(db);
      return send(res, 200, req.method === "DELETE" && collection === "pageGroups" ? { ok: true } : db[collection][index]);
    }
  }

  return send(res, 404, { error: "接口不存在" });
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host || `${HOST}:${PORT}`}`);
  if (req.method === "OPTIONS") return send(res, 204, "", "text/plain");
  try {
    if (url.pathname.startsWith("/api/")) return await handleApi(req, res, url);
    if (url.pathname.startsWith("/admin") && serveStatic(url.pathname, res)) return;
    if (url.pathname.startsWith("/demo") && serveDemo(url.pathname, res)) return;
    if (url.pathname === "/") {
      res.writeHead(302, { Location: "/admin" });
      return res.end();
    }
    return send(res, 404, { error: "页面不存在" });
  } catch (error) {
    console.error(error);
    return send(res, 500, { error: error.message || "服务器错误" });
  }
});

if (require.main === module) {
  server.listen(PORT, HOST, () => {
    console.log(`PageCue is running at http://${HOST}:${PORT}/admin`);
  });
}

module.exports = { server, isActive, visibleTo, normalizeRule, resolveMemoPageGroups, cleanMemo, cleanTool, cleanPageGroup, eventStats };
