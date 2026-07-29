require("dotenv").config();
const http = require("node:http");
const fs = require("node:fs");
const path = require("node:path");
const { createCipheriv, createDecipheriv, createHash, createHmac, randomBytes, randomUUID, scryptSync, timingSafeEqual } = require("node:crypto");
const { URL } = require("node:url");
const webPush = require("web-push");
const packageJson = require("./package.json");
const { matchesSite } = require("./extension/shared/rule-engine.js");
const { validateSelection: validateQuickSelection } = require("./extension/shared/quick-create-policy.js");
const {
  INTERACTION_ACTIONS,
  normalizeAudience,
  normalizePageBucket,
  createSubmissionSnapshot,
  funnelStats
} = require("./shared/p0-model.js");

function isSupportedPageUrlProtocol(protocol) {
  return /^(https?|file):$/.test(protocol);
}
const { nextAlarmOccurrence } = require("./extension/shared/alarm-schedule.js");

const PORT = Number(process.env.PORT || 8787);
const HOST = process.env.HOST || "127.0.0.1";
const ROOT = __dirname;
const DATA_FILE = process.env.CONTEXT_COMPANION_DATA || path.join(ROOT, "data", "db.json");
const ADMIN_ROOT = path.join(ROOT, "admin");
const DEMO_ROOT = path.join(ROOT, "demo");
const DOWNLOAD_ROOT = process.env.PAGECUE_DOWNLOAD_ROOT || path.join(ROOT, "downloads");
const SYNC_CHECK_INTERVAL_MINUTES = 60;
const VAPID_PUBLIC_KEY = String(process.env.VAPID_PUBLIC_KEY || "").trim();
const VAPID_PRIVATE_KEY = String(process.env.VAPID_PRIVATE_KEY || "").trim();
const VAPID_SUBJECT = String(process.env.VAPID_SUBJECT || "mailto:admin@example.com").trim();
const PUSH_CONFIGURED = Boolean(VAPID_PUBLIC_KEY && VAPID_PRIVATE_KEY);
const ANNOTATION_SESSION_TTL_MS = 30 * 60_000;
const CHROME_MINIMUM = "116";
const SOGOU_MINIMUM = "109";
const ADMIN_PHONE = String(process.env.ADMIN_PHONE || "").trim();
const ADMIN_PASSWORD_HASH = String(process.env.ADMIN_PASSWORD_HASH || "").trim();
const ADMIN_SESSION_SECRET = String(process.env.ADMIN_SESSION_SECRET || randomBytes(32).toString("base64url"));
const ADMIN_SESSION_TTL_SECONDS = 8 * 60 * 60;
const ADMIN_COOKIE = "pagecue_admin";
const WORKBUDDY_API_TOKEN = String(process.env.WORKBUDDY_API_TOKEN || "").trim();
const WORKBUDDY_ACTOR_ID = "integration_workbuddy";
const WORKBUDDY_API_VERSION = "1";
const LOGIN_WINDOW_MS = 15 * 60_000;
const LOGIN_MAX_FAILURES = 5;
const loginFailures = new Map();
const PERSONAL_MEMO_FOLDERS = [
  {
    id: "memo_folder_personal_knowledge",
    name: "20-个人关注知识",
    description: "成员自己提交的个人知识提醒自动归类",
    sortOrder: 20,
    scope: "personal",
    systemKey: "personal_knowledge"
  },
  {
    id: "memo_folder_personal_operation",
    name: "99-个人操作提醒",
    description: "成员自己提交的个人操作提醒自动归类",
    sortOrder: 99,
    scope: "personal",
    systemKey: "personal_operation"
  }
];

function personalMemoFolderId(type, db = {}) {
  const definition = PERSONAL_MEMO_FOLDERS[type === "operation" ? 1 : 0];
  const existing = (db.memoFolders || []).find(folder => folder.systemKey === definition.systemKey || folder.id === definition.id || folder.name === definition.name);
  return existing?.id || definition.id;
}

function ensurePersonalMemoFolders(db) {
  if (!Array.isArray(db.memoFolders)) db.memoFolders = [];
  const now = new Date().toISOString();
  let changed = false;
  for (const definition of PERSONAL_MEMO_FOLDERS) {
    const existing = db.memoFolders.find(folder => folder.systemKey === definition.systemKey || folder.id === definition.id || folder.name === definition.name);
    if (!existing) {
      db.memoFolders.push({
        ...definition,
        status: "active",
        systemManaged: true,
        createdBy: "system",
        updatedBy: "system",
        createdAt: now,
        updatedAt: now
      });
      changed = true;
      continue;
    }
    let folderChanged = false;
    const { id: _defaultId, ...managedDefinition } = definition;
    for (const [key, value] of Object.entries({ ...managedDefinition, status: "active", systemManaged: true })) {
      if (existing[key] !== value) {
        existing[key] = value;
        folderChanged = true;
      }
    }
    if (folderChanged) {
      existing.updatedAt = now;
      changed = true;
    }
  }
  return changed;
}

if (PUSH_CONFIGURED) webPush.setVapidDetails(VAPID_SUBJECT, VAPID_PUBLIC_KEY, VAPID_PRIVATE_KEY);

function readDb() {
  const db = JSON.parse(fs.readFileSync(DATA_FILE, "utf8"));
  db.settings = normalizeSettings(db.settings || {});
  if (!Array.isArray(db.groups)) db.groups = [];
  db.groups = db.groups.map(group => ({
    ...group,
    canPublishOrganizationMemos: group.canPublishOrganizationMemos === true
  }));
  if (!Array.isArray(db.memoFolders)) db.memoFolders = [];
  ensurePersonalMemoFolders(db);
  if (!Array.isArray(db.pageGroups)) db.pageGroups = [];
  db.pageGroups = db.pageGroups.map(group => ({ ...group, strategy: normalizePageStrategy(group.strategy) }));
  if (!Array.isArray(db.memos)) db.memos = [];
  db.memos = db.memos.map(memo => ({
    ...memo,
    ...normalizeAudience(memo, { allowEmpty: true }),
    folderId: memo.folderId ? String(memo.folderId).slice(0, 120) : null,
    type: memo.type === "operation" ? "operation" : "knowledge",
    triggerMode: memo.triggerMode === "broadcast" ? "broadcast" : "page_match",
    createdByMemberId: memo.createdByMemberId || memo.createdBy || memo.ownerId || null,
    submittedByMemberId: memo.submittedByMemberId || memo.createdByMemberId || memo.createdBy || memo.ownerId || null,
    createdByNameSnapshot: String(memo.createdByNameSnapshot || "").slice(0, 120),
    submittedByNameSnapshot: String(memo.submittedByNameSnapshot || memo.integration?.submittedBy || "").slice(0, 120),
    dailyReminder: memo.type === "operation" ? { enabled: true, timezone: String(memo.dailyReminder?.timezone || "Asia/Shanghai") } : { enabled: false, timezone: "Asia/Shanghai" },
    links: normalizeLinks(memo.links),
    annotation: normalizeAnnotation(memo.annotation, memo.priority, memo.scope),
    intensity: normalizeAnnotation(memo.annotation, memo.priority, memo.scope).intensity
  }));
  if (!Array.isArray(db.tools)) db.tools = [];
  if (!Array.isArray(db.events)) db.events = [];
  if (!Array.isArray(db.auditLog)) db.auditLog = [];
  if (!Array.isArray(db.pushSubscriptions)) db.pushSubscriptions = [];
  if (!Array.isArray(db.pushDeliveries)) db.pushDeliveries = [];
  if (!Array.isArray(db.annotationSessions)) db.annotationSessions = [];
  if (!Array.isArray(db.operationReceipts)) db.operationReceipts = [];
  if (!Array.isArray(db.personalAlarms)) db.personalAlarms = [];
  if (!Array.isArray(db.suppliers)) db.suppliers = [];
  if (!Array.isArray(db.memoComments)) db.memoComments = [];
  if (!Array.isArray(db.invitations)) db.invitations = [];
  db.invitations = db.invitations.map(invitation => ({ ...invitation, memberId: invitation.memberId || invitation.userId || null }));
  if (!Array.isArray(db.deviceBindings)) db.deviceBindings = [];
  if (!Array.isArray(db.accountEvents)) db.accountEvents = [];
  if (!Array.isArray(db.integrationRequests)) db.integrationRequests = [];
  if (!Array.isArray(db.submissionSnapshots)) db.submissionSnapshots = [];
  if (!Array.isArray(db.memberFeedback)) db.memberFeedback = [];
  if (!Array.isArray(db.broadcastReceipts)) db.broadcastReceipts = [];
  if (!Array.isArray(db.users)) db.users = [];
  db.users = db.users.map(user => ({ ...user, groupIds: Array.isArray(user.groupIds) ? user.groupIds : [], status: user.status || "active" }));
  ensureSupplierTriggerMemos(db);
  return db;
}

function writeDb(db) {
  ensureSupplierTriggerMemos(db);
  const directory = path.dirname(DATA_FILE);
  const backupDirectory = path.join(directory, "backups");
  const temporaryFile = path.join(directory, `.${path.basename(DATA_FILE)}.${process.pid}.${randomUUID()}.tmp`);
  const payload = `${JSON.stringify(db, null, 2)}\n`;
  fs.mkdirSync(directory, { recursive: true });
  if (fs.existsSync(DATA_FILE)) {
    fs.mkdirSync(backupDirectory, { recursive: true });
    const backups = fs.readdirSync(backupDirectory)
      .filter(name => name.endsWith(".json"))
      .map(name => ({ name, modifiedAt: fs.statSync(path.join(backupDirectory, name)).mtimeMs }))
      .sort((a, b) => a.modifiedAt - b.modifiedAt);
    const latestBackup = backups.at(-1);
    if (!latestBackup || Date.now() - latestBackup.modifiedAt >= 5 * 60_000) {
      fs.copyFileSync(DATA_FILE, path.join(backupDirectory, `${Date.now()}-${randomUUID()}.json`));
      while (backups.length >= 100) fs.unlinkSync(path.join(backupDirectory, backups.shift().name));
    }
  }
  const descriptor = fs.openSync(temporaryFile, "w");
  try {
    fs.writeFileSync(descriptor, payload, "utf8");
    fs.fsyncSync(descriptor);
  } finally {
    fs.closeSync(descriptor);
  }
  fs.renameSync(temporaryFile, DATA_FILE);
}

function ensureSupplierTriggerMemos(db) {
  if (!Array.isArray(db.memos)) db.memos = [];
  if (!Array.isArray(db.suppliers)) db.suppliers = [];
  const activeSuppliers = db.suppliers.filter(supplier => supplier.status !== "archived" && Array.isArray(supplier.matchTerms) && supplier.matchTerms.length);
  const activeIds = new Set(activeSuppliers.map(supplier => supplier.id));
  db.memos = db.memos.filter(memo => !memo.systemGeneratedSupplier || activeIds.has(memo.sourceSupplierId));
  for (const supplier of activeSuppliers) {
    const id = `memo_supplier_${supplier.id.replace(/^supplier_/, "")}`;
    const existing = db.memos.find(memo => memo.id === id || (memo.systemGeneratedSupplier && memo.sourceSupplierId === supplier.id));
    const revision = `${supplier.updatedAt || ""}|${supplier.matchTerms.join("\u001f")}|${supplier.companyName}`;
    const now = supplier.updatedAt || new Date().toISOString();
    const next = {
      ...(existing || {}),
      id,
      type: "knowledge",
      scope: "organization",
      ownerId: null,
      title: `供应商 · ${supplier.companyName}`.slice(0, 120),
      body: "页面命中供应商匹配词，点击查看供应商资料。",
      tags: ["供应商"],
      links: [],
      entityRefs: [{ type: "supplier", id: supplier.id, displayName: supplier.companyName }],
      rule: normalizeRule({ pageScope: "global", pageGroupIds: [], sitePatterns: [], includeTerms: supplier.matchTerms, excludeTerms: [], operator: "OR", caseSensitive: false, useRegex: false, cooldownMinutes: 30 }),
      audienceType: "all",
      targetGroupIds: [],
      targetUserIds: [],
      triggerMode: "page_match",
      priority: "normal",
      annotation: normalizeAnnotation({ template: "standard", keywordTerms: supplier.matchTerms, anchors: [] }, "normal", "organization"),
      intensity: "standard",
      dailyReminder: { enabled: false, timezone: "Asia/Shanghai" },
      status: "published",
      startsAt: null,
      expiresAt: null,
      version: existing ? Number(existing.version || 1) + (existing.supplierRevision === revision ? 0 : 1) : 1,
      systemGeneratedSupplier: true,
      sourceSupplierId: supplier.id,
      supplierRevision: revision,
      createdBy: existing?.createdBy || supplier.createdBy || "admin_demo",
      updatedBy: supplier.updatedBy || supplier.createdBy || "admin_demo",
      createdByMemberId: existing?.createdByMemberId || existing?.createdBy || supplier.createdBy || "admin_demo",
      submittedByMemberId: existing?.submittedByMemberId || existing?.createdByMemberId || existing?.createdBy || supplier.createdBy || "admin_demo",
      createdFromDeviceId: null,
      updatedFromDeviceId: null,
      createdAt: existing?.createdAt || supplier.createdAt || now,
      updatedAt: now
    };
    if (existing) Object.assign(existing, next);
    else db.memos.push(next);
  }
}

function requestActor(req, fallback = "admin_demo") {
  return String(req.adminActorId || req.headers["x-user-id"] || fallback).trim().slice(0, 120) || fallback;
}

function hashToken(value) {
  return createHash("sha256").update(String(value || "")).digest("hex");
}

function encryptInvitationCode(code) {
  const key = createHash("sha256").update(ADMIN_SESSION_SECRET).digest();
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  const encrypted = Buffer.concat([cipher.update(String(code), "utf8"), cipher.final()]);
  return `v1.${iv.toString("base64url")}.${cipher.getAuthTag().toString("base64url")}.${encrypted.toString("base64url")}`;
}

function decryptInvitationCode(payload) {
  try {
    const [version, ivText, tagText, encryptedText] = String(payload || "").split(".");
    if (version !== "v1" || !ivText || !tagText || !encryptedText) return null;
    const key = createHash("sha256").update(ADMIN_SESSION_SECRET).digest();
    const decipher = createDecipheriv("aes-256-gcm", key, Buffer.from(ivText, "base64url"));
    decipher.setAuthTag(Buffer.from(tagText, "base64url"));
    return Buffer.concat([decipher.update(Buffer.from(encryptedText, "base64url")), decipher.final()]).toString("utf8");
  } catch { return null; }
}

function bearerToken(req) {
  const match = /^Bearer\s+(.+)$/i.exec(String(req.headers.authorization || ""));
  return match ? match[1].trim() : "";
}

function authenticateMember(db, req) {
  const token = bearerToken(req);
  if (!token) return null;
  const tokenHash = hashToken(token);
  const binding = db.deviceBindings.find(item => item.tokenHash === tokenHash && item.status === "active");
  if (!binding) return null;
  const user = db.users.find(item => item.id === binding.userId && item.status !== "disabled");
  return user ? { user, binding } : null;
}

function requireMember(db, req) {
  const session = authenticateMember(db, req);
  if (!session) {
    const error = new Error("请先使用邀请码绑定成员账号");
    error.statusCode = 401;
    throw error;
  }
  req.memberSession = session;
  return session;
}

function requireAdmin(db, req) {
  const actorId = req.adminActorId || authenticateAdmin(req)?.adminId;
  const actor = db.users.find(user => user.id === actorId);
  if (!actor || actor.role !== "admin") {
    const error = new Error("仅管理员可以配置组织批注");
    error.statusCode = 401;
    throw error;
  }
  req.adminActorId = actorId;
  return actorId;
}

function parseCookies(req) {
  return Object.fromEntries(String(req.headers.cookie || "").split(";").map(item => item.trim()).filter(Boolean).map(item => {
    const separator = item.indexOf("=");
    return separator < 0 ? [item, ""] : [item.slice(0, separator), item.slice(separator + 1)];
  }));
}

function signSession(payload) {
  const encoded = Buffer.from(JSON.stringify(payload)).toString("base64url");
  const signature = createHmac("sha256", ADMIN_SESSION_SECRET).update(encoded).digest("base64url");
  return `${encoded}.${signature}`;
}

function authenticateAdmin(req) {
  const token = parseCookies(req)[ADMIN_COOKIE];
  if (!token || !token.includes(".")) return null;
  const [encoded, suppliedSignature] = token.split(".", 2);
  const expectedSignature = createHmac("sha256", ADMIN_SESSION_SECRET).update(encoded).digest();
  let supplied;
  try { supplied = Buffer.from(suppliedSignature, "base64url"); } catch { return null; }
  if (supplied.length !== expectedSignature.length || !timingSafeEqual(supplied, expectedSignature)) return null;
  try {
    const payload = JSON.parse(Buffer.from(encoded, "base64url").toString("utf8"));
    if (payload.adminId !== "admin_demo" || Number(payload.expiresAt) <= Date.now()) return null;
    return payload;
  } catch { return null; }
}

function verifyPassword(password) {
  const [algorithm, saltText, hashText] = ADMIN_PASSWORD_HASH.split(":");
  if (algorithm !== "scrypt" || !saltText || !hashText) return false;
  try {
    const expected = Buffer.from(hashText, "base64url");
    const actual = scryptSync(String(password || ""), Buffer.from(saltText, "base64url"), expected.length);
    return actual.length === expected.length && timingSafeEqual(actual, expected);
  } catch { return false; }
}

function adminCookie(value, maxAge = ADMIN_SESSION_TTL_SECONDS) {
  return `${ADMIN_COOKIE}=${value}; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=${maxAge}`;
}

function loginKey(req) {
  return String(req.headers["x-forwarded-for"] || req.socket.remoteAddress || "unknown").split(",")[0].trim();
}

function noteLoginFailure(req) {
  const key = loginKey(req);
  const current = loginFailures.get(key);
  const entry = !current || Date.now() - current.startedAt > LOGIN_WINDOW_MS ? { count: 0, startedAt: Date.now() } : current;
  entry.count += 1;
  loginFailures.set(key, entry);
  return entry.count;
}

function loginBlocked(req) {
  const entry = loginFailures.get(loginKey(req));
  return Boolean(entry && Date.now() - entry.startedAt <= LOGIN_WINDOW_MS && entry.count >= LOGIN_MAX_FAILURES);
}

function appendAudit(db, { action, entityType, entityId, userId, detail = null }) {
  const member = db.users.find(item => item.id === userId);
  db.auditLog.push({
    id: `audit_${randomUUID()}`,
    action,
    entityType,
    entityId,
    userId,
    memberId: userId,
    memberNameSnapshot: member?.name || String(detail?.submittedBy || userId || "未知成员").slice(0, 120),
    detail,
    createdAt: new Date().toISOString()
  });
}

function appendAccountEvent(db, { type, userId, binding, actorId = null, invitation = null }) {
  const member = db.users.find(item => item.id === userId);
  db.accountEvents.push({
    id: `account_event_${randomUUID()}`,
    type,
    userId,
    memberId: userId,
    memberNameSnapshot: member?.name || String(userId || "未知成员").slice(0, 120),
    bindingId: binding?.id || null,
    deviceId: binding?.deviceId || null,
    browser: binding?.browser || "unknown",
    extensionVersion: binding?.extensionVersion || "unknown",
    invitationId: invitation?.id || null,
    codeSuffix: invitation?.codeSuffix || null,
    actorId,
    createdAt: new Date().toISOString()
  });
  if (db.accountEvents.length > 5000) db.accountEvents.splice(0, db.accountEvents.length - 5000);
}

function appendSubmissionSnapshot(db, entity, {
  entityType = "memo",
  actorMemberId,
  actorName,
  source = "admin",
  requestId = null
} = {}) {
  const existing = requestId
    ? db.submissionSnapshots.find(item => item.entityType === entityType && item.requestId === requestId)
    : null;
  if (existing) return existing;
  const member = db.users.find(item => item.id === actorMemberId);
  const snapshot = createSubmissionSnapshot(entity, {
    entityType,
    actorMemberId,
    actorName: actorName || member?.name || actorMemberId,
    source,
    requestId
  });
  db.submissionSnapshots.push(snapshot);
  return snapshot;
}

function invitationIsInactive(invitation, now = Date.now()) {
  if (!invitation || invitation.status !== "pending") return true;
  const expiresAt = Date.parse(invitation.expiresAt || "");
  return !Number.isFinite(expiresAt) || expiresAt <= now;
}

function removeInactiveInvitations(db) {
  const removed = [];
  db.invitations = (db.invitations || []).filter(invitation => {
    if (!invitationIsInactive(invitation)) return true;
    removed.push(invitation);
    return false;
  });
  return removed;
}

function send(res, status, body, type = "application/json; charset=utf-8", extraHeaders = {}) {
  const payload = type.startsWith("application/json") ? JSON.stringify(body) : body;
  res.writeHead(status, {
    "Content-Type": type,
    "Content-Length": Buffer.byteLength(payload),
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Headers": "Content-Type, Authorization, X-User-Id, If-None-Match",
    "Access-Control-Allow-Methods": "GET, POST, PUT, DELETE, OPTIONS",
    "Cache-Control": "no-store",
    ...extraHeaders
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

function normalizeSettings(settings = {}) {
  return {
    defaultCooldownMinutes: Number(settings.defaultCooldownMinutes || 30),
    recommendedSitePatterns: Array.isArray(settings.recommendedSitePatterns) ? settings.recommendedSitePatterns.map(String).filter(Boolean).slice(0, 50) : [],
    excludedSitePatterns: Array.isArray(settings.excludedSitePatterns) ? [...new Set(settings.excludedSitePatterns.map(String).map(item => item.trim()).filter(Boolean))].slice(0, 100) : [],
    privacyMode: String(settings.privacyMode || "local_match")
  };
}

function requireWorkbuddy(req) {
  if (!WORKBUDDY_API_TOKEN) {
    const error = new Error("WorkBuddy 接口尚未配置");
    error.statusCode = 503;
    throw error;
  }
  const header = String(req.headers.authorization || "");
  const token = header.startsWith("Bearer ") ? header.slice(7).trim() : "";
  const expected = createHash("sha256").update(WORKBUDDY_API_TOKEN).digest();
  const actual = createHash("sha256").update(token).digest();
  if (!token || !timingSafeEqual(expected, actual)) {
    const error = new Error("WorkBuddy 接口密钥无效");
    error.statusCode = 401;
    throw error;
  }
}

function workbuddyStrings(value, limit = 50) {
  const items = Array.isArray(value) ? value : (typeof value === "string" ? value.split(/[\n,，]/) : []);
  return [...new Set(items.map(item => String(item || "").trim()).filter(Boolean))].slice(0, limit);
}

function resolveWorkbuddyReferences(values, collection, label) {
  return workbuddyStrings(values, 100).map(reference => {
    const exactId = collection.find(item => item.id === reference);
    if (exactId) return exactId.id;
    const matches = collection.filter(item => String(item.name || "").trim().toLocaleLowerCase() === reference.toLocaleLowerCase());
    if (matches.length === 1) return matches[0].id;
    const error = new Error(matches.length ? `${label}“${reference}”存在重名，请改用 ID` : `找不到${label}“${reference}”`);
    error.statusCode = 400;
    throw error;
  });
}

function workbuddyLinks(value) {
  if (!Array.isArray(value)) return [];
  return value.map(link => typeof link === "string" ? { label: "查看具体信息", url: link } : link);
}

function workbuddyDateTime(value) {
  return new Intl.DateTimeFormat("zh-CN", {
    timeZone: "Asia/Shanghai",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23"
  }).format(new Date(value)).replaceAll("/", "-");
}

function addOneCalendarMonth(value) {
  const date = new Date(value);
  const day = date.getUTCDate();
  date.setUTCDate(1);
  date.setUTCMonth(date.getUTCMonth() + 1);
  const lastDay = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth() + 1, 0)).getUTCDate();
  date.setUTCDate(Math.min(day, lastDay));
  return date.toISOString();
}

function workbuddyReminderResult(db, requestRecord, status = requestRecord.status) {
  const memo = db.memos.find(item => item.id === requestRecord.memoId);
  if (!memo) return {
    ok: false,
    status: "deleted",
    requestId: requestRecord.requestId,
    reminderId: requestRecord.memoId,
    message: `提醒 ${requestRecord.memoId} 已被删除`
  };
  const names = (ids, collection) => ids.map(id => collection.find(item => item.id === id)?.name || id);
  const typeName = memo.type === "operation" ? "操作提醒" : "知识提醒";
  const pageGroupNames = names(memo.rule.pageGroupIds || [], db.pageGroups);
  const targetGroupNames = names(memo.targetGroupIds || [], db.groups);
  const targetUserNames = names(memo.targetUserIds || [], db.users);
  const intensityName = { light: "轻度", medium: "中度", heavy: "重度" }[memo.intensity] || "轻度";
  const push = requestRecord.push || { configured: PUSH_CONFIGURED, targetCount: 0, acceptedCount: 0, fallbackMinutes: SYNC_CHECK_INTERVAL_MINUTES };
  const heading = status === "duplicate" ? "该请求已处理，无需重复创建" : "创建成功";
  const compactFields = `标题：${memo.title}\n提交人：${requestRecord.submittedBy}\n关键词：${memo.rule.includeTerms.join("、")}（${memo.rule.operator}）\n强度：${intensityName}`;
  const message = memo.type === "operation"
    ? `${heading}\n${compactFields}\n有效期：${workbuddyDateTime(memo.startsAt)} 至 ${workbuddyDateTime(memo.expiresAt)}`
    : `${heading}\n提醒类型：${typeName}\n${compactFields}`;
  return {
    ok: true,
    status,
    requestId: requestRecord.requestId,
    submittedBy: requestRecord.submittedBy,
    reminder: {
      id: memo.id,
      type: memo.type,
      title: memo.title,
      body: memo.body,
      intensity: memo.intensity,
      keywords: memo.rule.includeTerms,
      pageScope: memo.rule.pageScope,
      pageGroups: pageGroupNames,
      targetGroups: targetGroupNames,
      targetUsers: targetUserNames,
      links: memo.links,
      cooldownMinutes: memo.rule.cooldownMinutes,
      startsAt: memo.startsAt,
      expiresAt: memo.expiresAt
    },
    defaultsApplied: requestRecord.defaultsApplied || [],
    push,
    message
  };
}

function isActive(item, now = Date.now()) {
  if (item.status && item.status !== "published") return false;
  if (item.startsAt && Date.parse(item.startsAt) > now) return false;
  if (item.expiresAt && Date.parse(item.expiresAt) <= now) return false;
  return true;
}

function localDateKey(value = Date.now(), timezone = "Asia/Shanghai") {
  const date = value instanceof Date ? value : new Date(value);
  const safeDate = Number.isFinite(date.getTime()) ? date : new Date();
  let formatter;
  try {
    formatter = new Intl.DateTimeFormat("en-US", { timeZone: timezone, year: "numeric", month: "2-digit", day: "2-digit" });
  } catch {
    formatter = new Intl.DateTimeFormat("en-US", { timeZone: "Asia/Shanghai", year: "numeric", month: "2-digit", day: "2-digit" });
  }
  const parts = Object.fromEntries(formatter.formatToParts(safeDate).map(part => [part.type, part.value]));
  return `${parts.year}-${parts.month}-${parts.day}`;
}

function visibleTo(item, user) {
  if (item.scope === "personal") return item.ownerId === user.id;
  const audience = normalizeAudience(item, { allowEmpty: true });
  if (audience.audienceType === "all") return true;
  if (audience.audienceType === "members") return audience.targetUserIds.includes(user.id);
  return audience.targetGroupIds.some(id => user.groupIds.includes(id));
}

function canPublishOrganizationMemos(db, user) {
  if (!user || user.status === "disabled") return false;
  if (user.role === "admin") return true;
  const groupIds = new Set(Array.isArray(user.groupIds) ? user.groupIds : []);
  return (db.groups || []).some(group =>
    groupIds.has(group.id) &&
    group.canPublishOrganizationMemos === true
  );
}

function validateMemoAudience(db, memo) {
  if (memo.scope === "personal") return memo;
  const audience = normalizeAudience(memo);
  if (audience.audienceType === "groups" && audience.targetGroupIds.some(id => !db.groups.some(group => group.id === id))) {
    const error = new Error("投放成员组不存在");
    error.statusCode = 400;
    throw error;
  }
  if (audience.audienceType === "members" && audience.targetUserIds.some(id => !db.users.some(user => user.id === id && user.status !== "disabled"))) {
    const error = new Error("投放成员不存在或已停用");
    error.statusCode = 400;
    throw error;
  }
  if (memo.triggerMode === "broadcast" && memo.annotation?.template !== "strong") {
    const error = new Error("广播提醒必须使用重度提醒");
    error.statusCode = 400;
    throw error;
  }
  return memo;
}

function cleanPushSubscription(input = {}, existing = {}) {
  const subscription = input.subscription || {};
  const endpoint = String(subscription.endpoint || "").trim();
  const p256dh = String(subscription.keys?.p256dh || "").trim();
  const auth = String(subscription.keys?.auth || "").trim();
  if (!endpoint.startsWith("https://") || !p256dh || !auth) {
    const error = new Error("无效的 Push Subscription");
    error.statusCode = 400;
    throw error;
  }
  const now = new Date().toISOString();
  return {
    ...existing,
    id: existing.id || `push_subscription_${randomUUID()}`,
    userId: String(input.userId || existing.userId || "").trim(),
    deviceId: String(input.deviceId || existing.deviceId || randomUUID()).trim().slice(0, 200),
    browser: String(input.browser || existing.browser || "unknown").slice(0, 200),
    extensionVersion: String(input.extensionVersion || existing.extensionVersion || "unknown").slice(0, 50),
    subscription: { endpoint, expirationTime: subscription.expirationTime || null, keys: { p256dh, auth } },
    status: "active",
    lastSeenAt: now,
    createdAt: existing.createdAt || now,
    updatedAt: now
  };
}

function publicPushStats(db) {
  const activeSubscriptions = db.pushSubscriptions.filter(item => item.status === "active").length;
  const latest = [...db.pushDeliveries].reverse().find(Boolean) || null;
  return {
    configured: PUSH_CONFIGURED,
    activeSubscriptions,
    checkIntervalMinutes: SYNC_CHECK_INTERVAL_MINUTES,
    latestDelivery: latest ? {
      id: latest.id,
      type: latest.type,
      targetCount: latest.targetCount,
      acceptedCount: latest.acceptedCount,
      failedCount: latest.failedCount,
      acknowledgedCount: (latest.acknowledgements || []).length,
      createdAt: latest.createdAt
    } : null
  };
}

function adminState(db) {
  const { pushSubscriptions, deviceBindings, invitations, personalAlarms, accountEvents, memoComments, ...safe } = db;
  const userName = userId => db.users.find(user => user.id === userId)?.name || userId || "未知成员";
  const eventsByMemo = new Map();
  for (const event of db.events) {
    const memoEvents = eventsByMemo.get(event.memoId) || [];
    memoEvents.push(event);
    eventsByMemo.set(event.memoId, memoEvents);
  }
  const memoActivity = db.memos.map(memo => {
    const events = eventsByMemo.get(memo.id) || [];
    const stats = eventStats(events);
    return {
      memoId: memo.id,
      title: memo.title,
      scope: memo.scope,
      type: memo.type || "knowledge",
      lifecycleStatus: memo.expiresAt && Date.parse(memo.expiresAt) <= Date.now() ? "expired" : memo.status,
      createdBy: memo.createdBy || memo.ownerId || null,
      createdByMemberId: memo.createdByMemberId || memo.createdBy || memo.ownerId || null,
      createdByName: userName(memo.createdBy || memo.ownerId),
      submittedByMemberId: memo.submittedByMemberId || memo.createdByMemberId || memo.createdBy || memo.ownerId || null,
      submittedByNameSnapshot: memo.submittedByNameSnapshot || userName(memo.submittedByMemberId || memo.createdByMemberId || memo.createdBy || memo.ownerId),
      createdFromDeviceId: memo.createdFromDeviceId || null,
      createdAt: memo.createdAt,
      stats,
      recentFeedback: events
        .filter(event => ["helpful", "unhelpful", "feedback_up", "feedback_down", "confirmed", "operation_completed", "ignored", "snoozed"].includes(event.action))
        .reverse()
        .map(event => ({ ...event, userName: userName(event.userId) })),
      comments: memoComments.filter(comment => comment.memoId === memo.id).map(comment => ({ ...comment, userName: userName(comment.userId) }))
    };
  });
  return {
    ...safe,
    memos: db.memos.filter(memo => !memo.systemGeneratedSupplier),
    groups: db.groups.map(group => ({ ...group, memberCount: db.users.filter(user => user.status !== "disabled" && user.groupIds.includes(group.id)).length })),
    invitations: invitations.filter(invitation => !invitationIsInactive(invitation)).map(({ codeHash, codeCipher, ...item }) => ({
      ...item,
      memberId: item.memberId || item.userId,
      userId: item.memberId || item.userId,
      code: decryptInvitationCode(codeCipher)
    })),
    deviceBindings: deviceBindings.map(({ tokenHash, ...item }) => item),
    accountEvents: accountEvents.slice(-1000).reverse(),
    pushStats: publicPushStats(db),
    stats: eventStats(db.events),
    funnels: {
      overall: funnelStats(db.events),
      light: funnelStats(db.events.filter(event => event.intensity === "light")),
      mediumHeavy: funnelStats(db.events.filter(event => ["medium", "heavy"].includes(event.intensity))),
      websites: websiteFunnelStats(db.events)
    },
    memoActivity,
    memoComments: memoComments.map(comment => ({ ...comment, userName: userName(comment.userId) })),
    operationStats: db.memos.filter(memo => memo.type === "operation").map(memo => {
      const triggeredUsers = new Set(db.events.filter(event => event.memoId === memo.id && event.action === "triggered").map(event => event.userId));
      const today = localDateKey(Date.now(), memo.dailyReminder?.timezone || "Asia/Shanghai");
      const confirmedToday = new Set(db.operationReceipts.filter(receipt => receipt.memoId === memo.id && receipt.localDate === today).map(receipt => receipt.userId));
      return { memoId: memo.id, triggeredUsers: triggeredUsers.size, confirmedToday: confirmedToday.size, pendingToday: Math.max(0, triggeredUsers.size - confirmedToday.size) };
    })
  };
}

function subscriptionTargets(db, targetGroupIds = [], targetUserIds = []) {
  const groupIds = Array.isArray(targetGroupIds) ? targetGroupIds.map(String).filter(Boolean) : [];
  const userIds = Array.isArray(targetUserIds) ? targetUserIds.map(String).filter(Boolean) : [];
  return db.pushSubscriptions.filter(subscription => {
    if (subscription.status !== "active") return false;
    const user = db.users.find(item => item.id === subscription.userId);
    if (!user) return false;
    return (!groupIds.length && !userIds.length) || userIds.includes(user.id) || groupIds.some(groupId => user.groupIds.includes(groupId));
  });
}

async function dispatchPush(db, input = {}) {
  const type = ["extension_update", "broadcast"].includes(input.type) ? input.type : "sync";
  const targetGroupIds = Array.isArray(input.targetGroupIds) ? input.targetGroupIds.map(String).filter(Boolean) : [];
  const targetUserIds = Array.isArray(input.targetUserIds) ? input.targetUserIds.map(String).filter(Boolean) : [];
  const targets = subscriptionTargets(db, targetGroupIds, targetUserIds);
  const delivery = {
    id: `push_delivery_${randomUUID()}`,
    type,
    version: db.meta.version,
    memoId: input.memoId ? String(input.memoId) : null,
    targetGroupIds,
    targetUserIds,
    targetCount: targets.length,
    acceptedCount: 0,
    failedCount: 0,
    failures: [],
    acknowledgements: [],
    configured: PUSH_CONFIGURED,
    createdAt: new Date().toISOString()
  };
  const payload = JSON.stringify({ type, deliveryId: delivery.id, version: db.meta.version, memoId: delivery.memoId, latestExtensionVersion: packageJson.version });
  if (PUSH_CONFIGURED) {
    await Promise.all(targets.map(async target => {
      try {
        await webPush.sendNotification(target.subscription, payload, { TTL: 300, urgency: ["extension_update", "broadcast"].includes(type) ? "high" : "normal" });
        delivery.acceptedCount += 1;
      } catch (error) {
        delivery.failedCount += 1;
        delivery.failures.push({ deviceId: target.deviceId, statusCode: Number(error.statusCode || 0), message: String(error.message || "Push failed").slice(0, 200) });
        if ([404, 410].includes(Number(error.statusCode))) target.status = "expired";
      }
    }));
  }
  db.pushDeliveries.push(delivery);
  writeDb(db);
  return delivery;
}

function normalizeLinks(links = []) {
  if (!Array.isArray(links)) return [];
  return links.slice(0, 20).map(link => {
    const url = String(link?.url || "").trim().slice(0, 2000);
    try {
      const parsed = new URL(url);
      if (!/^https?:$/.test(parsed.protocol)) return null;
      return { label: String(link?.label || url || "链接").trim().slice(0, 120), url: parsed.href };
    } catch { return null; }
  }).filter(Boolean);
}

function normalizeEntityRefs(refs = []) {
  if (!Array.isArray(refs)) return [];
  return refs.slice(0, 5).map(ref => {
    const type = String(ref?.type || "").trim();
    const id = String(ref?.id || "").trim().slice(0, 120);
    if (type !== "supplier" || !id) return null;
    return { type, id, displayName: String(ref?.displayName || "").trim().slice(0, 160) };
  }).filter(Boolean);
}

function percentage(value) {
  const number = Number(value);
  return Number.isFinite(number) ? Math.max(0, Math.min(100, Math.round(number * 10) / 10)) : 0;
}

function normalizeSupplierEvaluations(items = []) {
  if (!Array.isArray(items)) return [];
  return items.slice(0, 20).map(item => ({
    content: String(item?.content || "").trim().slice(0, 2000),
    contributor: String(item?.contributor || "").trim().slice(0, 120),
    at: Number.isFinite(Date.parse(item?.at || "")) ? new Date(item.at).toISOString() : null
  })).filter(item => item.content);
}

function cleanSupplier(input = {}, existing = {}, actorId = "") {
  const now = new Date().toISOString();
  const companyName = String(input.companyName === undefined ? existing.companyName || "" : input.companyName).trim().slice(0, 160);
  const customerId = String(input.customerId === undefined ? existing.customerId || "" : input.customerId).trim().slice(0, 80);
  if (!companyName || !customerId) {
    const error = new Error("公司名称和客户 ID 为必填项");
    error.statusCode = 400;
    throw error;
  }
  const contact = input.contact === undefined ? (existing.contact || {}) : (input.contact || {});
  const metrics = input.metrics === undefined ? (existing.metrics || {}) : (input.metrics || {});
  const evaluations = input.evaluations === undefined ? (existing.evaluations || {}) : (input.evaluations || {});
  const matchTerms = (Array.isArray(input.matchTerms) ? input.matchTerms : (existing.matchTerms || [])).map(item => String(item).trim().slice(0, 200)).filter(Boolean).slice(0, 20);
  if (!matchTerms.length) {
    const error = new Error("供应商至少需要填写一个匹配词");
    error.statusCode = 400;
    throw error;
  }
  return {
    ...existing,
    id: existing.id || `supplier_${randomUUID()}`,
    customerId,
    companyName,
    matchTerms,
    contact: {
      name: String(contact.name || "").trim().slice(0, 120),
      title: String(contact.title || "").trim().slice(0, 120),
      phone: String(contact.phone || "").trim().slice(0, 80),
      email: String(contact.email || "").trim().slice(0, 200)
    },
    metrics: {
      periodLabel: String(metrics.periodLabel || "近12个月").trim().slice(0, 80),
      productPercentile: percentage(metrics.productPercentile),
      orderPercentile: percentage(metrics.orderPercentile),
      closeRate: percentage(metrics.closeRate),
      quoteRate: percentage(metrics.quoteRate),
      afterSalesRate: percentage(metrics.afterSalesRate)
    },
    advantageProducts: (Array.isArray(input.advantageProducts) ? input.advantageProducts : (existing.advantageProducts || [])).slice(0, 20).map(item => ({
      name: String(item?.name || "").trim().slice(0, 160),
      cas: String(item?.cas || "").trim().slice(0, 80),
      closeRate: percentage(item?.closeRate)
    })).filter(item => item.name || item.cas),
    evaluations: {
      shortTerm: normalizeSupplierEvaluations(evaluations.shortTerm),
      longTerm: normalizeSupplierEvaluations(evaluations.longTerm)
    },
    source: {
      type: ["manual", "spreadsheet", "feishu"].includes(input.source?.type) ? input.source.type : (existing.source?.type || "manual"),
      externalSourceId: input.source?.externalSourceId || existing.source?.externalSourceId || null,
      externalRowId: input.source?.externalRowId || existing.source?.externalRowId || null,
      lastImportedAt: input.source?.lastImportedAt || existing.source?.lastImportedAt || null
    },
    status: input.status === "archived" ? "archived" : "active",
    createdBy: existing.createdBy || actorId || null,
    updatedBy: actorId || existing.updatedBy || null,
    createdAt: existing.createdAt || now,
    updatedAt: now
  };
}

function normalizeAlarmSchedule(schedule = {}) {
  const mode = ["once", "daily", "weekdays", "weekly"].includes(schedule.mode) ? schedule.mode : "once";
  let timezone = String(schedule.timezone || "Asia/Shanghai").slice(0, 100);
  try { new Intl.DateTimeFormat("en-US", { timeZone: timezone }).format(new Date()); }
  catch { timezone = "Asia/Shanghai"; }
  if (mode === "once") {
    const triggerAt = new Date(schedule.triggerAt || "");
    if (!Number.isFinite(triggerAt.getTime())) {
      const error = new Error("单次闹钟必须设置有效触发时间");
      error.statusCode = 400;
      throw error;
    }
    return { mode, triggerAt: triggerAt.toISOString(), timeOfDay: null, weekdays: [], timezone };
  }
  const timeOfDay = /^([01]\d|2[0-3]):[0-5]\d$/.test(String(schedule.timeOfDay || "")) ? String(schedule.timeOfDay) : "";
  const weekdays = mode === "weekly" ? [...new Set((Array.isArray(schedule.weekdays) ? schedule.weekdays : []).map(Number).filter(day => Number.isInteger(day) && day >= 0 && day <= 6))].sort() : [];
  if (!timeOfDay || (mode === "weekly" && !weekdays.length)) {
    const error = new Error("周期闹钟必须设置有效时间和星期");
    error.statusCode = 400;
    throw error;
  }
  return { mode, triggerAt: null, timeOfDay, weekdays, timezone };
}

function cleanPersonalAlarm(input = {}, existing = {}, actorId = "") {
  const now = new Date().toISOString();
  const schedule = normalizeAlarmSchedule(input.schedule === undefined ? existing.schedule : input.schedule);
  const status = ["active", "archived"].includes(input.status) ? input.status : (existing.status || "active");
  const nextTriggerAt = status === "active" ? nextAlarmOccurrence(schedule, Date.now() - 1000) : null;
  if (status === "active" && !nextTriggerAt) {
    const error = new Error("闹钟触发时间必须晚于当前时间");
    error.statusCode = 400;
    throw error;
  }
  return {
    ...existing,
    id: existing.id || `alarm_${randomUUID()}`,
    ownerId: String(input.ownerId || existing.ownerId || actorId || "").slice(0, 120),
    title: String(input.title || existing.title || "未命名闹钟").trim().slice(0, 120),
    body: String(input.body === undefined ? (existing.body || "") : input.body).slice(0, 20_000),
    tags: Array.isArray(input.tags) ? input.tags.map(String).slice(0, 20) : (existing.tags || []),
    links: input.links === undefined ? normalizeLinks(existing.links) : normalizeLinks(input.links),
    schedule,
    status,
    nextTriggerAt: input.snoozedUntil && Date.parse(input.snoozedUntil) > Date.now() ? new Date(input.snoozedUntil).toISOString() : nextTriggerAt,
    snoozedUntil: input.snoozedUntil === undefined ? (existing.snoozedUntil || null) : (input.snoozedUntil || null),
    lastCompletedOccurrence: existing.lastCompletedOccurrence || null,
    createdBy: existing.createdBy || actorId || input.ownerId || null,
    updatedBy: actorId || input.ownerId || existing.updatedBy || null,
    createdAt: existing.createdAt || now,
    updatedAt: now
  };
}

function cleanMemo(input, existing = {}, actorId = "") {
  const scope = input.scope === "personal" ? "personal" : "organization";
  const type = input.type === "operation" ? "operation" : (existing.type === "operation" ? "operation" : "knowledge");
  const now = new Date().toISOString();
  const ownerId = scope === "personal" ? String(input.ownerId || existing.ownerId || "") : null;
  const changedBy = String(actorId || ownerId || existing.updatedBy || existing.createdBy || "admin_demo").slice(0, 120);
  const audienceInput = input.audienceType === undefined && input.targetGroupIds === undefined && input.targetUserIds === undefined
    ? existing
    : input;
  const audience = scope === "personal"
    ? { audienceType: "members", targetGroupIds: [], targetUserIds: ownerId ? [ownerId] : [] }
    : normalizeAudience(audienceInput);
  const priority = ["normal", "important"].includes(input.priority) ? input.priority : (existing.priority || "normal");
  const annotationInput = input.annotation === undefined ? existing.annotation : input.annotation;
  const startsAt = input.startsAt === undefined ? (existing.startsAt || null) : (input.startsAt || null);
  const expiresAt = input.expiresAt === undefined ? (existing.expiresAt || null) : (input.expiresAt || null);
  const folderId = input.folderId === undefined ? (existing.folderId || null) : (String(input.folderId || "").trim().slice(0, 120) || null);
  if (type === "operation" && (!startsAt || !expiresAt || !Number.isFinite(Date.parse(startsAt)) || !Number.isFinite(Date.parse(expiresAt)) || Date.parse(startsAt) >= Date.parse(expiresAt))) {
    const error = new Error("操作提醒必须设置有效的开始和结束时间");
    error.statusCode = 400;
    throw error;
  }
  return {
    ...existing,
    id: existing.id || `memo_${randomUUID()}`,
    type,
    scope,
    ownerId,
    triggerMode: input.triggerMode === "broadcast" ? "broadcast" : (existing.triggerMode === "broadcast" && input.triggerMode === undefined ? "broadcast" : "page_match"),
    folderId,
    title: String(input.title || "未命名备忘").trim().slice(0, 120),
    body: String(input.body || "").slice(0, 20_000),
    tags: Array.isArray(input.tags) ? input.tags.map(String).slice(0, 20) : [],
    links: input.links === undefined ? normalizeLinks(existing.links) : normalizeLinks(input.links),
    entityRefs: scope === "organization" ? normalizeEntityRefs(input.entityRefs === undefined ? existing.entityRefs : input.entityRefs) : [],
    rule: normalizeRule(input.rule),
    audienceType: audience.audienceType,
    targetGroupIds: audience.targetGroupIds,
    targetUserIds: audience.targetUserIds,
    priority,
    annotation: normalizeAnnotation(annotationInput, priority, scope),
    intensity: normalizeAnnotation(annotationInput, priority, scope).intensity,
    dailyReminder: type === "operation" ? {
      enabled: true,
      timezone: String(input.dailyReminder?.timezone || existing.dailyReminder?.timezone || "Asia/Shanghai").slice(0, 100)
    } : { enabled: false, timezone: "Asia/Shanghai" },
    status: ["draft", "published", "archived"].includes(input.status) ? input.status : "published",
    startsAt,
    expiresAt,
    version: Number(existing.version || 0) + 1,
    createdBy: existing.createdBy || changedBy,
    updatedBy: changedBy,
    createdByMemberId: existing.createdByMemberId || existing.createdBy || changedBy,
    submittedByMemberId: String(input.submittedByMemberId || existing.submittedByMemberId || existing.createdByMemberId || existing.createdBy || changedBy).slice(0, 120),
    createdByNameSnapshot: String(existing.createdByNameSnapshot || input.createdByNameSnapshot || input.actorName || "").slice(0, 120),
    submittedByNameSnapshot: String(input.submittedByNameSnapshot || existing.submittedByNameSnapshot || input.actorName || "").slice(0, 120),
    createdFromDeviceId: existing.createdFromDeviceId || String(input.deviceId || "").slice(0, 200) || null,
    updatedFromDeviceId: String(input.deviceId || existing.updatedFromDeviceId || "").slice(0, 200) || null,
    createdAt: existing.createdAt || now,
    updatedAt: now
  };
}

function normalizeAnnotationAnchor(anchor = {}, index = 0) {
  const fingerprintHash = String(anchor.fingerprintHash || "").trim().toLowerCase();
  return {
    id: String(anchor.id || `anchor_${randomUUID()}`).slice(0, 120),
    label: String(anchor.label || `批注 ${index + 1}`).trim().slice(0, 120),
    pageGroupId: String(anchor.pageGroupId || "").slice(0, 120),
    pathPattern: String(anchor.pathPattern || "").trim().slice(0, 1000),
    primarySelector: String(anchor.primarySelector || "").trim().slice(0, 500),
    fallbackSelector: String(anchor.fallbackSelector || "").trim().slice(0, 500),
    fingerprintHash: /^[a-f0-9]{64}$/.test(fingerprintHash) ? fingerprintHash : "",
    relativeToMatchUnit: Boolean(anchor.relativeToMatchUnit),
    order: Math.max(0, Math.min(Number(anchor.order ?? index), 999))
  };
}

function normalizeAnnotation(annotation = {}, priority = "normal", scope = "organization") {
  const fallbackTemplate = scope === "personal" ? "light" : (priority === "important" ? "strong" : "standard");
  const rawTemplate = annotation?.template || annotation?.intensity;
  const aliases = { light: "light", medium: "standard", standard: "standard", heavy: "strong", strong: "strong" };
  const template = aliases[rawTemplate] || fallbackTemplate;
  const anchors = Array.isArray(annotation?.anchors)
    ? annotation.anchors.slice(0, 20).map(normalizeAnnotationAnchor).filter(anchor => anchor.pageGroupId && anchor.primarySelector)
    : [];
  return {
    template,
    intensity: template === "strong" ? "heavy" : template === "standard" ? "medium" : "light",
    keywordTerms: Array.isArray(annotation?.keywordTerms) ? annotation.keywordTerms.map(String).map(term => term.trim()).filter(Boolean).slice(0, 50) : [],
    anchors
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

function normalizePageStrategy(strategy = {}) {
  const matchScope = ["module", "row"].includes(strategy.matchScope) ? strategy.matchScope : "page";
  return {
    matchScope,
    selector: matchScope === "page" ? "" : String(strategy.selector || "").trim().slice(0, 500),
    excludeSelector: matchScope === "page" ? "" : String(strategy.excludeSelector || "").trim().slice(0, 500),
    testRequest: strategy.testRequest && typeof strategy.testRequest === "object" ? strategy.testRequest : null,
    lastTestResult: strategy.lastTestResult && typeof strategy.lastTestResult === "object" ? strategy.lastTestResult : null
  };
}

function resolveMemoPageGroups(memo, pageGroups = []) {
  const rule = normalizeRule(memo.rule);
  if (rule.pageScope === "global") return { ...memo, rule: { ...rule, sitePatterns: [], pageStrategies: [] } };
  const selectedGroups = pageGroups.filter(group => rule.pageGroupIds.includes(group.id));
  const selectedPatterns = selectedGroups.flatMap(group => group.sitePatterns || []);
  const pageStrategies = selectedGroups.map(group => {
    const strategy = normalizePageStrategy(group.strategy);
    return {
      pageGroupId: group.id,
      sitePatterns: group.sitePatterns || [],
      matchScope: strategy.matchScope,
      selector: strategy.selector,
      excludeSelector: strategy.excludeSelector
    };
  });
  return { ...memo, rule: { ...rule, sitePatterns: [...new Set(selectedPatterns.length ? selectedPatterns : rule.sitePatterns)], pageStrategies } };
}

function cleanMemoFolder(input, existing = {}, actorId = "admin_demo") {
  const now = new Date().toISOString();
  const name = String(input.name || existing.name || "").trim().slice(0, 80);
  if (!name) {
    const error = new Error("文件夹名称不能为空");
    error.statusCode = 400;
    throw error;
  }
  return {
    ...existing,
    id: existing.id || `memo_folder_${randomUUID()}`,
    name,
    description: String(input.description === undefined ? (existing.description || "") : input.description).trim().slice(0, 300),
    sortOrder: Math.max(0, Math.min(Number(input.sortOrder ?? existing.sortOrder ?? 0) || 0, 9999)),
    status: ["active", "archived"].includes(input.status) ? input.status : (existing.status || "active"),
    createdBy: existing.createdBy || actorId,
    updatedBy: actorId,
    createdAt: existing.createdAt || now,
    updatedAt: now
  };
}

function cleanGroup(input, existing = {}, actorId = "admin_demo") {
  const now = new Date().toISOString();
  const name = String(input.name === undefined ? (existing.name || "") : input.name).trim().slice(0, 80);
  if (!name) {
    const error = new Error("分组名称不能为空");
    error.statusCode = 400;
    throw error;
  }
  return {
    ...existing,
    id: existing.id || `group_${randomUUID()}`,
    name,
    description: String(input.description === undefined ? (existing.description || "") : input.description).trim().slice(0, 300),
    canPublishOrganizationMemos: input.canPublishOrganizationMemos === undefined
      ? existing.canPublishOrganizationMemos === true
      : input.canPublishOrganizationMemos === true,
    createdBy: existing.createdBy || actorId,
    updatedBy: actorId,
    createdAt: existing.createdAt || now,
    updatedAt: now
  };
}

function cleanPageGroup(input, existing = {}, actorId = "admin_demo") {
  const now = new Date().toISOString();
  const incomingStrategy = normalizePageStrategy(input.strategy || existing.strategy);
  if (incomingStrategy.matchScope !== "page" && !incomingStrategy.selector) {
    const error = new Error("模块或同一行策略必须设置内容选择器");
    error.statusCode = 400;
    throw error;
  }
  return {
    ...existing,
    id: existing.id || `page_group_${randomUUID()}`,
    name: String(input.name || "未命名页面组").trim().slice(0, 80),
    description: String(input.description || "").trim().slice(0, 300),
    sitePatterns: Array.isArray(input.sitePatterns) ? [...new Set(input.sitePatterns.map(String).map(item => item.trim()).filter(Boolean))].slice(0, 50) : [],
    strategy: incomingStrategy,
    createdBy: existing.createdBy || actorId,
    updatedBy: actorId,
    createdAt: existing.createdAt || now,
    updatedAt: now
  };
}

function cleanTool(input, existing = {}, actorId = "admin_demo") {
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
    createdBy: existing.createdBy || actorId,
    updatedBy: actorId,
    createdAt: existing.createdAt || now,
    updatedAt: now
  };
}

function eventStats(events) {
  const totals = {
    triggered: 0,
    opened: 0,
    confirmed: 0,
    ignored: 0,
    snoozed: 0,
    helpful: 0,
    unhelpful: 0,
    annotation_shown: 0,
    annotation_opened: 0,
    annotation_located: 0,
    annotation_unresolved: 0,
    published: 0,
    matched: 0,
    highlight_shown: 0,
    highlight_opened: 0,
    popup_shown: 0,
    expanded: 0,
    link_opened: 0,
    link_copied: 0,
    comment_opened: 0,
    comment_submitted: 0,
    operation_completed: 0,
    feedback_up: 0,
    feedback_down: 0
  };
  for (const event of events) if (Object.hasOwn(totals, event.action)) totals[event.action] += 1;
  const feedbackTotal = totals.helpful + totals.unhelpful;
  const funnel = funnelStats(events);
  return {
    ...totals,
    openRate: totals.triggered ? totals.opened / totals.triggered : 0,
    helpfulRate: feedbackTotal ? totals.helpful / feedbackTotal : 0,
    funnel
  };
}

function websiteFunnelStats(events = []) {
  const buckets = new Map();
  for (const event of events) {
    const bucket = normalizePageBucket(event.pageBucket || event.domain || "");
    const current = buckets.get(bucket) || [];
    current.push(event);
    buckets.set(bucket, current);
  }
  return [...buckets.entries()]
    .map(([pageBucket, bucketEvents]) => ({ pageBucket, ...funnelStats(bucketEvents) }))
    .sort((a, b) => Number(b.actions.matched?.events || 0) - Number(a.actions.matched?.events || 0) || a.pageBucket.localeCompare(b.pageBucket));
}

function serveStatic(reqPath, res) {
  const relative = reqPath === "/admin" || reqPath === "/admin/" ? "index.html" : reqPath.replace(/^\/admin\//, "");
  const resolved = path.resolve(ADMIN_ROOT, relative);
  if (!resolved.startsWith(path.resolve(ADMIN_ROOT)) || !fs.existsSync(resolved) || fs.statSync(resolved).isDirectory()) return false;
  const ext = path.extname(resolved);
  const type = { ".html": "text/html; charset=utf-8", ".css": "text/css; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".svg": "image/svg+xml", ".png": "image/png", ".webp": "image/webp" }[ext] || "application/octet-stream";
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

function serveDownload(reqPath, res) {
  const filename = path.basename(reqPath);
  if (filename !== reqPath.replace(/^\/downloads\//, "") || !/^pagecue-(chrome-edge|sogou)-[0-9.]+\.zip$/.test(filename)) return false;
  const resolved = path.join(DOWNLOAD_ROOT, filename);
  if (!fs.existsSync(resolved) || !fs.statSync(resolved).isFile()) return false;
  res.writeHead(200, {
    "Content-Type": "application/zip",
    "Content-Length": fs.statSync(resolved).size,
    "Content-Disposition": `attachment; filename="${filename}"`,
    "Cache-Control": "public, max-age=3600"
  });
  fs.createReadStream(resolved).pipe(res);
  return true;
}

async function handleApi(req, res, url) {
  const db = readDb();
  const parts = url.pathname.split("/").filter(Boolean);

  if (req.method === "GET" && url.pathname === "/api/health") {
    return send(res, 200, { ok: true, version: db.meta.version, appVersion: packageJson.version, pushConfigured: PUSH_CONFIGURED, time: new Date().toISOString() });
  }

  if (req.method === "GET" && url.pathname === "/api/integrations/workbuddy/health") {
    requireWorkbuddy(req);
    return send(res, 200, {
      ok: true,
      status: "ready",
      service: "pagecue-workbuddy",
      apiVersion: WORKBUDDY_API_VERSION,
      appVersion: packageJson.version,
      pushConfigured: PUSH_CONFIGURED,
      message: "页知提醒接口连接正常"
    });
  }

  const workbuddyRequestMatch = url.pathname.match(/^\/api\/integrations\/workbuddy\/requests\/([^/]+)$/);
  if (req.method === "GET" && workbuddyRequestMatch) {
    requireWorkbuddy(req);
    const requestId = decodeURIComponent(workbuddyRequestMatch[1]);
    const requestRecord = db.integrationRequests.find(item => item.channel === "workbuddy-wecom" && item.requestId === requestId);
    if (!requestRecord) return send(res, 404, { ok: false, status: "not_found", requestId, message: "没有找到该提交记录" });
    return send(res, 200, workbuddyReminderResult(db, requestRecord));
  }

  if (req.method === "POST" && url.pathname === "/api/integrations/workbuddy/reminders") {
    requireWorkbuddy(req);
    const body = await parseBody(req);
    const requestId = String(body.requestId || "").trim().slice(0, 160);
    if (requestId.length < 8) return send(res, 400, { ok: false, status: "validation_failed", message: "requestId 至少需要 8 个字符，用于防止重复创建" });
    const existingRequest = db.integrationRequests.find(item => item.channel === "workbuddy-wecom" && item.requestId === requestId);
    if (existingRequest) return send(res, 200, workbuddyReminderResult(db, existingRequest, "duplicate"));

    const defaultsApplied = [];
    const submittedBy = String(body.submittedBy || "").trim().replace(/^@+/, "").trim().slice(0, 120);
    if (!submittedBy) return send(res, 400, { ok: false, status: "validation_failed", requestId, message: "请说明本条提醒的提交人姓名" });
    const keywords = workbuddyStrings(body.keywords);
    if (!keywords.length) return send(res, 400, { ok: false, status: "validation_failed", requestId, message: "至少需要填写一个匹配关键词" });
    const type = body.type === "operation" ? "operation" : "knowledge";
    if (!body.type) defaultsApplied.push("类型=知识提醒");
    const title = String(body.title || "").trim() || `${keywords[0]}${type === "operation" ? "操作" : "知识"}提醒`;
    if (!String(body.title || "").trim()) defaultsApplied.push(`标题=${title}`);
    const memoBody = String(body.body || "").trim() || (type === "operation"
      ? `请按要求处理与“${keywords.join("、")}”相关的工作事项。`
      : `请查看与“${keywords.join("、")}”相关的知识信息。`);
    if (!String(body.body || "").trim()) defaultsApplied.push("正文=自动生成");
    const pageScope = body.pageScope === "page_groups" ? "page_groups" : "global";
    if (!body.pageScope) defaultsApplied.push("页面范围=全局页面");
    const pageGroupIds = pageScope === "page_groups" ? resolveWorkbuddyReferences(body.pageGroups, db.pageGroups, "页面组") : [];
    if (pageScope === "page_groups" && !pageGroupIds.length) return send(res, 400, { ok: false, status: "validation_failed", requestId, message: "选择特定页面组时，pageGroups 不能为空" });
    const targetGroupIds = resolveWorkbuddyReferences(body.targetGroups, db.groups, "成员组");
    const targetUserIds = resolveWorkbuddyReferences(body.targetUsers, db.users.filter(user => user.status !== "disabled"), "成员");
    if (targetGroupIds.length && targetUserIds.length) return send(res, 400, { ok: false, status: "validation_failed", requestId, message: "成员组和指定成员不能同时作为投放对象" });
    const audienceType = targetUserIds.length ? "members" : targetGroupIds.length ? "groups" : "all";
    if (!targetGroupIds.length && !targetUserIds.length) defaultsApplied.push("投放对象=全员");
    const intensity = ["light", "medium", "heavy"].includes(body.intensity) ? body.intensity : "light";
    if (!body.intensity) defaultsApplied.push("强度=轻度");
    const template = intensity === "heavy" ? "strong" : intensity === "light" ? "light" : "standard";
    const keywordOperator = body.keywordOperator === "AND" ? "AND" : "OR";
    if (!body.keywordOperator) defaultsApplied.push("关键词关系=OR");
    if (!body.cooldownMinutes) defaultsApplied.push("冷却时间=30分钟");
    let startsAt = body.startsAt || null;
    let expiresAt = body.expiresAt || null;
    if (type === "operation") {
      if (!startsAt) {
        startsAt = new Date().toISOString();
        defaultsApplied.push("开始时间=立即生效");
      }
      if (!expiresAt) {
        expiresAt = addOneCalendarMonth(startsAt);
        defaultsApplied.push("结束时间=1个月后");
      }
    }
    const memo = cleanMemo({
      scope: "organization",
      type,
      title,
      body: memoBody,
      tags: [...workbuddyStrings(body.tags, 19), "WorkBuddy"],
      links: workbuddyLinks(body.links),
      audienceType,
      targetGroupIds,
      targetUserIds,
      startsAt,
      expiresAt,
      priority: intensity === "heavy" ? "important" : "normal",
      annotation: { template, keywordTerms: keywords, anchors: [] },
      status: "published",
      submittedByMemberId: WORKBUDDY_ACTOR_ID,
      submittedByNameSnapshot: submittedBy,
      rule: {
        pageScope,
        pageGroupIds,
        includeTerms: keywords,
        excludeTerms: workbuddyStrings(body.excludeKeywords),
        operator: keywordOperator,
        caseSensitive: false,
        useRegex: false,
        cooldownMinutes: Number(body.cooldownMinutes || 30)
      }
    }, {}, WORKBUDDY_ACTOR_ID);
    memo.integration = {
      channel: "workbuddy-wecom",
      requestId,
      submittedBy
    };
    const requestRecord = {
      id: `integration_request_${randomUUID()}`,
      channel: "workbuddy-wecom",
      requestId,
      memoId: memo.id,
      status: "created",
      submittedBy: memo.integration.submittedBy,
      defaultsApplied,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      push: null
    };
    db.memos.push(memo);
    db.integrationRequests.push(requestRecord);
    appendSubmissionSnapshot(db, memo, {
      entityType: "memo",
      actorMemberId: WORKBUDDY_ACTOR_ID,
      actorName: submittedBy,
      source: "workbuddy",
      requestId
    });
    if (db.integrationRequests.length > 5000) db.integrationRequests.splice(0, db.integrationRequests.length - 5000);
    appendAudit(db, {
      action: "created_via_workbuddy",
      entityType: "memo",
      entityId: memo.id,
      userId: WORKBUDDY_ACTOR_ID,
      detail: { requestId, submittedBy: memo.integration.submittedBy }
    });
    db.meta.version += 1;
    writeDb(db);
    const delivery = await dispatchPush(db, { type: "sync", memoId: memo.id, targetGroupIds, targetUserIds });
    requestRecord.push = {
      configured: delivery.configured,
      targetCount: delivery.targetCount,
      acceptedCount: delivery.acceptedCount,
      failedCount: delivery.failedCount,
      fallbackMinutes: SYNC_CHECK_INTERVAL_MINUTES
    };
    requestRecord.updatedAt = new Date().toISOString();
    writeDb(db);
    return send(res, 201, workbuddyReminderResult(db, requestRecord));
  }

  if (req.method === "POST" && url.pathname === "/api/admin/auth/login") {
    if (!ADMIN_PHONE || !ADMIN_PASSWORD_HASH) return send(res, 503, { error: "管理员登录尚未配置" });
    if (loginBlocked(req)) return send(res, 429, { error: "登录失败次数过多，请15分钟后重试" });
    const body = await parseBody(req);
    if (String(body.phone || "").trim() !== ADMIN_PHONE || !verifyPassword(body.password)) {
      noteLoginFailure(req);
      return send(res, 401, { error: "手机号或密码错误" });
    }
    loginFailures.delete(loginKey(req));
    const expiresAt = Date.now() + ADMIN_SESSION_TTL_SECONDS * 1000;
    const token = signSession({ adminId: "admin_demo", phone: ADMIN_PHONE, expiresAt });
    return send(res, 200, { ok: true, adminId: "admin_demo", phone: ADMIN_PHONE, expiresAt }, "application/json; charset=utf-8", { "Set-Cookie": adminCookie(token) });
  }

  if (req.method === "POST" && url.pathname === "/api/admin/auth/logout") {
    return send(res, 200, { ok: true }, "application/json; charset=utf-8", { "Set-Cookie": adminCookie("", 0) });
  }

  if (req.method === "GET" && url.pathname === "/api/admin/auth/session") {
    const session = authenticateAdmin(req);
    if (!session) return send(res, 401, { error: "请先登录管理员账号" });
    return send(res, 200, { authenticated: true, adminId: session.adminId, phone: session.phone, expiresAt: session.expiresAt });
  }

  if (req.method === "POST" && url.pathname === "/api/device-bindings") {
    const body = await parseBody(req);
    const codeHash = hashToken(String(body.inviteCode || "").trim().toUpperCase());
    const invitation = db.invitations.find(item => item.codeHash === codeHash && item.status === "pending");
    if (!invitation || Date.parse(invitation.expiresAt) <= Date.now()) return send(res, 400, { error: "邀请码无效或已过期" });
    const user = db.users.find(item => item.id === (invitation.memberId || invitation.userId) && item.status !== "disabled");
    if (!user) return send(res, 400, { error: "邀请码对应成员不可用" });
    const deviceId = String(body.deviceId || randomUUID()).trim().slice(0, 200);
    const token = randomBytes(32).toString("base64url");
    const binding = {
      id: `device_binding_${randomUUID()}`,
      userId: user.id,
      deviceId,
      tokenHash: hashToken(token),
      status: "active",
      browser: String(body.browser || "unknown").slice(0, 100),
      extensionVersion: String(body.extensionVersion || "unknown").slice(0, 50),
      createdAt: new Date().toISOString(),
      lastSeenAt: new Date().toISOString(),
      lastLoginAt: null,
      revokedAt: null
    };
    db.deviceBindings.push(binding);
    invitation.status = "used";
    invitation.usedAt = new Date().toISOString();
    invitation.usedByDeviceId = deviceId;
    appendAudit(db, { action: "device_bound", entityType: "user", entityId: user.id, userId: user.id });
    appendAccountEvent(db, { type: "device_bound", userId: user.id, binding, actorId: user.id, invitation });
    db.invitations = db.invitations.filter(item => item.id !== invitation.id);
    writeDb(db);
    return send(res, 201, { token, user, deviceId });
  }

  if (req.method === "GET" && url.pathname === "/api/device/session") {
    const { user, binding } = requireMember(db, req);
    const now = new Date().toISOString();
    if (!binding.lastLoginAt || Date.now() - Date.parse(binding.lastLoginAt) >= 30 * 60_000) {
      binding.lastLoginAt = now;
      binding.lastSeenAt = now;
      appendAccountEvent(db, { type: "member_login", userId: user.id, binding, actorId: user.id });
      writeDb(db);
    }
    return send(res, 200, { authenticated: true, user, deviceId: binding.deviceId });
  }

  if (req.method === "DELETE" && url.pathname === "/api/device/session") {
    const { user, binding } = requireMember(db, req);
    binding.status = "revoked";
    binding.revokedAt = new Date().toISOString();
    appendAudit(db, { action: "device_revoked", entityType: "user", entityId: user.id, userId: user.id });
    appendAccountEvent(db, { type: "device_revoked", userId: user.id, binding, actorId: user.id });
    writeDb(db);
    return send(res, 200, { ok: true });
  }

  const codeCompletion = /^\/api\/admin\/annotation-sessions\/[^/]+\/complete$/.test(url.pathname);
  if (url.pathname.startsWith("/api/admin/") && !codeCompletion) requireAdmin(db, req);

  if (req.method === "POST" && url.pathname === "/api/admin/groups") {
    const body = await parseBody(req);
    const group = cleanGroup(body, {}, req.adminActorId);
    if (db.groups.some(item => item.name.trim().toLocaleLowerCase() === group.name.toLocaleLowerCase())) {
      return send(res, 409, { error: "分组名称已存在" });
    }
    db.groups.push(group);
    appendAudit(db, { action: "created", entityType: "group", entityId: group.id, userId: req.adminActorId });
    db.meta.version += 1;
    writeDb(db);
    return send(res, 201, group);
  }

  const adminGroupMatch = url.pathname.match(/^\/api\/admin\/groups\/([^/]+)$/);
  if (adminGroupMatch && req.method === "PUT") {
    const index = db.groups.findIndex(item => item.id === adminGroupMatch[1]);
    if (index < 0) return send(res, 404, { error: "成员分组不存在" });
    const body = await parseBody(req);
    const group = cleanGroup(body, db.groups[index], req.adminActorId);
    if (db.groups.some((item, itemIndex) => itemIndex !== index && item.name.trim().toLocaleLowerCase() === group.name.toLocaleLowerCase())) {
      return send(res, 409, { error: "分组名称已存在" });
    }
    db.groups[index] = group;
    appendAudit(db, { action: "updated", entityType: "group", entityId: group.id, userId: req.adminActorId });
    db.meta.version += 1;
    writeDb(db);
    return send(res, 200, group);
  }

  if (req.method === "POST" && url.pathname === "/api/admin/users") {
    const body = await parseBody(req);
    const name = String(body.name || "").trim().slice(0, 120);
    if (!name) return send(res, 400, { error: "请填写成员姓名" });
    const groupIds = (Array.isArray(body.groupIds) ? body.groupIds : []).map(String).filter(id => db.groups.some(group => group.id === id));
    const user = { id: `user_${randomUUID()}`, name, role: "member", groupIds, status: "active", createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() };
    db.users.push(user);
    appendAudit(db, { action: "created", entityType: "user", entityId: user.id, userId: req.adminActorId });
    appendAccountEvent(db, { type: "account_created", userId: user.id, actorId: req.adminActorId });
    db.meta.version += 1;
    writeDb(db);
    return send(res, 201, user);
  }

  const adminUserMatch = url.pathname.match(/^\/api\/admin\/users\/([^/]+)$/);
  if (adminUserMatch && req.method === "PUT") {
    const user = db.users.find(item => item.id === adminUserMatch[1] && item.role !== "admin");
    if (!user) return send(res, 404, { error: "成员不存在" });
    const body = await parseBody(req);
    user.name = String(body.name || user.name).trim().slice(0, 120);
    user.groupIds = (Array.isArray(body.groupIds) ? body.groupIds : user.groupIds).map(String).filter(id => db.groups.some(group => group.id === id));
    user.status = body.status === "disabled" ? "disabled" : "active";
    user.updatedAt = new Date().toISOString();
    appendAudit(db, { action: "updated", entityType: "user", entityId: user.id, userId: req.adminActorId });
    appendAccountEvent(db, { type: "account_updated", userId: user.id, actorId: req.adminActorId });
    db.meta.version += 1;
    writeDb(db);
    return send(res, 200, user);
  }

  if (req.method === "POST" && url.pathname === "/api/admin/invitations") {
    const body = await parseBody(req);
    const requestedMemberId = String(body.memberId || body.userId || "");
    const user = db.users.find(item => item.id === requestedMemberId && item.status !== "disabled");
    if (!user) return send(res, 404, { error: "成员不存在" });
    const code = randomBytes(4).toString("hex").toUpperCase();
    const invitation = {
      id: `invitation_${randomUUID()}`,
      memberId: user.id,
      codeHash: hashToken(code),
      codeCipher: encryptInvitationCode(code),
      codeSuffix: code.slice(-4),
      status: "pending",
      expiresAt: new Date(Date.now() + Math.max(10, Math.min(Number(body.validMinutes || 1440), 10_080)) * 60_000).toISOString(),
      createdBy: req.adminActorId,
      createdAt: new Date().toISOString(),
      usedAt: null,
      usedByDeviceId: null
    };
    db.invitations.push(invitation);
    appendAudit(db, { action: "invitation_created", entityType: "user", entityId: user.id, userId: req.adminActorId });
    appendAccountEvent(db, { type: "invitation_created", userId: user.id, actorId: req.adminActorId, invitation });
    writeDb(db);
    const { codeHash: _codeHash, codeCipher: _codeCipher, ...publicInvitation } = invitation;
    return send(res, 201, { ...publicInvitation, code });
  }

  if (req.method === "DELETE" && url.pathname === "/api/admin/invitations/inactive") {
    const removed = removeInactiveInvitations(db);
    if (removed.length) {
      appendAudit(db, { action: "invitations_deleted", entityType: "invitation", entityId: "inactive", userId: req.adminActorId, detail: { count: removed.length } });
      writeDb(db);
    }
    return send(res, 200, { ok: true, deletedCount: removed.length });
  }

  const adminInvitationMatch = url.pathname.match(/^\/api\/admin\/invitations\/([^/]+)$/);
  if (adminInvitationMatch && req.method === "DELETE") {
    const index = db.invitations.findIndex(item => item.id === adminInvitationMatch[1]);
    if (index < 0) return send(res, 404, { error: "邀请码不存在" });
    const [invitation] = db.invitations.splice(index, 1);
    const memberId = invitation.memberId || invitation.userId;
    appendAudit(db, { action: "invitation_deleted", entityType: "user", entityId: memberId, userId: req.adminActorId });
    appendAccountEvent(db, { type: "invitation_deleted", userId: memberId, actorId: req.adminActorId, invitation });
    writeDb(db);
    return send(res, 200, { ok: true });
  }

  const adminBindingMatch = url.pathname.match(/^\/api\/admin\/device-bindings\/([^/]+)$/);
  if (adminBindingMatch && req.method === "DELETE") {
    const binding = db.deviceBindings.find(item => item.id === adminBindingMatch[1]);
    if (!binding) return send(res, 404, { error: "设备绑定不存在" });
    binding.status = "revoked";
    binding.revokedAt = new Date().toISOString();
    appendAudit(db, { action: "device_revoked", entityType: "user", entityId: binding.userId, userId: req.adminActorId });
    appendAccountEvent(db, { type: "device_revoked", userId: binding.userId, binding, actorId: req.adminActorId });
    writeDb(db);
    return send(res, 200, { ok: true });
  }

  if (req.method === "GET" && url.pathname === "/api/version") {
    const etag = `"${db.meta.version}-${packageJson.version}-${String(process.env.MINIMUM_EXTENSION_VERSION || packageJson.version)}"`;
    if (req.headers["if-none-match"] === etag) {
      res.writeHead(304, { ETag: etag, "Cache-Control": "no-cache" });
      return res.end();
    }
    const body = JSON.stringify({
      version: db.meta.version,
      latestExtensionVersion: packageJson.version,
      minimumExtensionVersion: String(process.env.MINIMUM_EXTENSION_VERSION || packageJson.version),
      pushConfigured: PUSH_CONFIGURED,
      checkIntervalMinutes: SYNC_CHECK_INTERVAL_MINUTES,
      downloads: {
        chromeEdgeUrl: String(process.env.CHROME_EDGE_DOWNLOAD_URL || `/downloads/pagecue-chrome-edge-${packageJson.version}.zip`),
        sogouUrl: String(process.env.SOGOU_DOWNLOAD_URL || `/downloads/pagecue-sogou-${packageJson.version}.zip`)
      },
      compatibility: { chromeMinimum: CHROME_MINIMUM, sogouMinimum: SOGOU_MINIMUM }
    });
    res.writeHead(200, {
      "Content-Type": "application/json; charset=utf-8",
      "Content-Length": Buffer.byteLength(body),
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Headers": "Content-Type, Authorization, X-User-Id, If-None-Match",
      "Cache-Control": "no-cache",
      ETag: etag
    });
    return res.end(body);
  }

  if (req.method === "GET" && url.pathname === "/api/push/config") {
    return send(res, 200, {
      enabled: PUSH_CONFIGURED,
      publicKey: PUSH_CONFIGURED ? VAPID_PUBLIC_KEY : null,
      checkIntervalMinutes: SYNC_CHECK_INTERVAL_MINUTES,
      latestExtensionVersion: packageJson.version
    });
  }

  if (req.method === "POST" && url.pathname === "/api/push/subscribe") {
    if (!PUSH_CONFIGURED) return send(res, 503, { error: "Web Push 尚未配置", checkIntervalMinutes: SYNC_CHECK_INTERVAL_MINUTES });
    const { user } = requireMember(db, req);
    const body = await parseBody(req);
    const userId = user.id;
    const endpoint = String(body.subscription?.endpoint || "");
    const existingIndex = db.pushSubscriptions.findIndex(item => item.subscription?.endpoint === endpoint || (item.userId === userId && item.deviceId === body.deviceId));
    const subscription = cleanPushSubscription({ ...body, userId }, existingIndex >= 0 ? db.pushSubscriptions[existingIndex] : {});
    if (existingIndex >= 0) db.pushSubscriptions[existingIndex] = subscription;
    else db.pushSubscriptions.push(subscription);
    writeDb(db);
    return send(res, existingIndex >= 0 ? 200 : 201, { id: subscription.id, deviceId: subscription.deviceId, checkIntervalMinutes: SYNC_CHECK_INTERVAL_MINUTES });
  }

  if (req.method === "POST" && url.pathname === "/api/push/ack") {
    const { user } = requireMember(db, req);
    const body = await parseBody(req);
    const delivery = db.pushDeliveries.find(item => item.id === body.deliveryId);
    if (!delivery) return send(res, 404, { error: "推送记录不存在" });
    const deviceId = String(body.deviceId || "").slice(0, 200);
    const acknowledgement = {
      deviceId,
      userId: user.id,
      status: ["received", "synced", "update_requested", "failed"].includes(body.status) ? body.status : "received",
      extensionVersion: String(body.extensionVersion || "unknown").slice(0, 50),
      error: body.error ? String(body.error).slice(0, 300) : null,
      createdAt: new Date().toISOString()
    };
    delivery.acknowledgements = (delivery.acknowledgements || []).filter(item => !(item.deviceId === deviceId && item.status === acknowledgement.status));
    delivery.acknowledgements.push(acknowledgement);
    writeDb(db);
    return send(res, 201, acknowledgement);
  }

  if (req.method === "GET" && url.pathname === "/api/bootstrap") {
    const { user, binding } = requireMember(db, req);
    const timezone = String(user.timezone || "Asia/Shanghai");
    const today = localDateKey(Date.now(), timezone);
    const visibleActiveMemos = db.memos.filter(item => isActive(item) && visibleTo(item, user));
    const acknowledgedBroadcastKeys = new Set(db.broadcastReceipts
      .filter(item => item.memberId === user.id)
      .map(item => `${item.memoId}:${item.memoVersion}`));
    const feedbackByMemoVersion = new Map(db.memberFeedback
      .filter(item => item.memberId === user.id)
      .map(item => [`${item.memoId}:${item.memoVersion}`, item.action]));
    const memberMemo = item => ({
      ...resolveMemoPageGroups(item, db.pageGroups),
      commentCount: db.memoComments.filter(comment => comment.memoId === item.id).length,
      myFeedback: feedbackByMemoVersion.get(`${item.id}:${Number(item.version || 1)}`) || null
    });
    return send(res, 200, {
      version: db.meta.version,
      user,
      identity: { deviceId: binding.deviceId },
      capabilities: {
        canPublishOrganizationMemos: canPublishOrganizationMemos(db, user)
      },
      groups: db.groups.filter(group => user.groupIds.includes(group.id)),
      memos: visibleActiveMemos.map(memberMemo),
      pendingBroadcasts: visibleActiveMemos
        .filter(item => item.triggerMode === "broadcast" && !acknowledgedBroadcastKeys.has(`${item.id}:${Number(item.version || 1)}`))
        .map(memberMemo),
      operationReceipts: db.operationReceipts.filter(item => item.userId === user.id && item.localDate === today),
      tools: db.tools.filter(item => isActive(item) && visibleTo(item, user)).sort((a, b) => a.sortOrder - b.sortOrder),
      pageGroups: db.pageGroups,
      settings: db.settings
    });
  }

  const memoCommentsMatch = url.pathname.match(/^\/api\/memos\/([^/]+)\/comments$/);
  if (memoCommentsMatch && ["GET", "POST"].includes(req.method)) {
    const { user, binding } = requireMember(db, req);
    const memo = db.memos.find(item => item.id === memoCommentsMatch[1]);
    if (!memo || !isActive(memo)) return send(res, 404, { error: "提醒不存在或已失效" });
    if (!visibleTo(memo, user)) return send(res, 403, { error: "无权查看该提醒的评论" });
    if (req.method === "GET") {
      const comments = db.memoComments.filter(item => item.memoId === memo.id).map(item => ({ ...item, userName: db.users.find(candidate => candidate.id === item.userId)?.name || item.userId, canDelete: item.userId === user.id }));
      return send(res, 200, { memoId: memo.id, comments });
    }
    const body = await parseBody(req);
    const content = String(body.content || "").trim().slice(0, 2000);
    if (!content) return send(res, 400, { error: "评论内容不能为空" });
    const comment = {
      id: `comment_${randomUUID()}`,
      memoId: memo.id,
      userId: user.id,
      memberId: user.id,
      memberNameSnapshot: user.name,
      deviceId: binding.deviceId,
      content,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString()
    };
    db.memoComments.push(comment);
    appendSubmissionSnapshot(db, comment, { entityType: "memoComment", actorMemberId: user.id, actorName: user.name, source: "member", requestId: body.requestId || null });
    appendAudit(db, { action: "commented", entityType: "memo", entityId: memo.id, userId: user.id, detail: { commentId: comment.id } });
    writeDb(db);
    return send(res, 201, { ...comment, userName: user.name, canDelete: true });
  }

  const memberCommentMatch = url.pathname.match(/^\/api\/memo-comments\/([^/]+)$/);
  if (memberCommentMatch && req.method === "DELETE") {
    const { user } = requireMember(db, req);
    const index = db.memoComments.findIndex(item => item.id === memberCommentMatch[1]);
    if (index < 0) return send(res, 404, { error: "评论不存在" });
    if (db.memoComments[index].userId !== user.id) return send(res, 403, { error: "只能删除自己的评论" });
    const comment = db.memoComments[index];
    appendSubmissionSnapshot(db, comment, { entityType: "memoCommentDeleted", actorMemberId: user.id, actorName: user.name, source: "member" });
    db.memoComments.splice(index, 1);
    appendAudit(db, { action: "comment_deleted", entityType: "memo", entityId: comment.memoId, userId: user.id, detail: { commentId: comment.id } });
    writeDb(db);
    return send(res, 200, { ok: true });
  }

  const adminCommentMatch = url.pathname.match(/^\/api\/admin\/memo-comments\/([^/]+)$/);
  if (adminCommentMatch && req.method === "DELETE") {
    const actorId = requireAdmin(db, req);
    const index = db.memoComments.findIndex(item => item.id === adminCommentMatch[1]);
    if (index < 0) return send(res, 404, { error: "评论不存在" });
    const comment = db.memoComments[index];
    appendSubmissionSnapshot(db, comment, { entityType: "memoCommentDeleted", actorMemberId: actorId, source: "admin" });
    db.memoComments.splice(index, 1);
    appendAudit(db, { action: "comment_deleted", entityType: "memo", entityId: comment.memoId, userId: actorId, detail: { commentId: comment.id } });
    writeDb(db);
    return send(res, 200, { ok: true });
  }

  if (req.method === "GET" && parts[0] === "api" && parts[1] === "suppliers" && parts.length === 3) {
    const { user } = requireMember(db, req);
    const supplier = db.suppliers.find(item => item.id === parts[2] && item.status !== "archived");
    if (!supplier) return send(res, 404, { error: "供应商资料不存在" });
    const allowed = db.memos.some(memo => isActive(memo) && visibleTo(memo, user) && (memo.entityRefs || []).some(ref => ref.type === "supplier" && ref.id === supplier.id));
    if (!allowed) return send(res, 403, { error: "当前账号无权查看该供应商资料" });
    return send(res, 200, supplier);
  }

  if (req.method === "GET" && url.pathname === "/api/admin/state") {
    const session = authenticateAdmin(req);
    return send(res, 200, { ...adminState(db), auth: { adminId: session.adminId, phone: session.phone, expiresAt: session.expiresAt } });
  }

  if (req.method === "PUT" && url.pathname === "/api/admin/settings") {
    const actorId = requireAdmin(db, req);
    const body = await parseBody(req);
    db.settings = normalizeSettings({ ...db.settings, ...body });
    appendAudit(db, { action: "updated", entityType: "settings", entityId: "organization_settings", userId: actorId });
    db.meta.version += 1;
    writeDb(db);
    const delivery = await dispatchPush(db, { type: "sync" });
    return send(res, 200, { settings: db.settings, sync: { targetCount: delivery.targetCount, acceptedCount: delivery.acceptedCount } });
  }

  if (req.method === "POST" && url.pathname === "/api/admin/annotation-sessions") {
    const actorId = requireAdmin(db, req);
    const body = await parseBody(req);
    const memo = db.memos.find(item => item.id === body.memoId && item.scope === "organization");
    const pageGroup = db.pageGroups.find(item => item.id === body.pageGroupId);
    if (!memo) return send(res, 404, { error: "组织提醒不存在" });
    if (!pageGroup) return send(res, 404, { error: "页面组不存在" });
    let targetUrl;
    try {
      targetUrl = new URL(String(body.url || ""));
      if (!isSupportedPageUrlProtocol(targetUrl.protocol)) throw new Error("invalid protocol");
    } catch { return send(res, 400, { error: "请输入有效的 HTTP、HTTPS 或 file 标记网址" }); }
    if (!matchesSite(targetUrl.href, pageGroup.sitePatterns || [])) return send(res, 400, { error: "标记网址不属于所选页面组" });
    const code = String(Math.floor(100000 + Math.random() * 900000));
    const session = {
      id: `annotation_session_${randomUUID()}`,
      code,
      memoId: memo.id,
      pageGroupId: pageGroup.id,
      url: targetUrl.href,
      template: memo.annotation.template,
      status: "pending",
      createdBy: actorId,
      createdAt: new Date().toISOString(),
      expiresAt: new Date(Date.now() + ANNOTATION_SESSION_TTL_MS).toISOString(),
      completedAt: null
    };
    db.annotationSessions.push(session);
    appendAudit(db, { action: "annotation_session_created", entityType: "memo", entityId: memo.id, userId: actorId });
    writeDb(db);
    return send(res, 201, session);
  }

  const annotationSessionLookup = url.pathname.match(/^\/api\/(?:admin\/)?annotation-sessions\/([^/]+)$/);
  if (annotationSessionLookup && req.method === "GET") {
    const key = annotationSessionLookup[1];
    const session = db.annotationSessions.find(item => item.id === key || item.code === key);
    if (!session) return send(res, 404, { error: "标记任务不存在" });
    if (Date.parse(session.expiresAt) <= Date.now() && session.status === "pending") session.status = "expired";
    const memo = db.memos.find(item => item.id === session.memoId);
    const pageGroup = db.pageGroups.find(item => item.id === session.pageGroupId);
    return send(res, 200, {
      ...session,
      code: undefined,
      memo: memo ? { id: memo.id, title: memo.title, body: memo.body, annotation: memo.annotation } : null,
      pageGroup: pageGroup ? { id: pageGroup.id, name: pageGroup.name, sitePatterns: pageGroup.sitePatterns, strategy: pageGroup.strategy } : null
    });
  }

  const completeAnnotationSession = url.pathname.match(/^\/api\/admin\/annotation-sessions\/([^/]+)\/complete$/);
  if (completeAnnotationSession && req.method === "POST") {
    const body = await parseBody(req);
    const session = db.annotationSessions.find(item => item.id === completeAnnotationSession[1]);
    if (!session) return send(res, 404, { error: "标记任务不存在" });
    const actorId = requestActor(req, "");
    const codeMatches = String(body.code || "") === session.code;
    const isAdmin = db.users.some(user => user.id === actorId && user.role === "admin");
    if (!isAdmin && !codeMatches) return send(res, 403, { error: "标记任务校验失败" });
    if (session.status !== "pending") return send(res, 409, { error: "标记任务已经完成或失效" });
    if (Date.parse(session.expiresAt) <= Date.now()) return send(res, 410, { error: "标记任务已过期" });
    const memo = db.memos.find(item => item.id === session.memoId && item.scope === "organization");
    if (!memo) return send(res, 404, { error: "组织提醒不存在" });
    const incoming = normalizeAnnotationAnchor({ ...body.anchor, pageGroupId: session.pageGroupId }, memo.annotation.anchors.length);
    if (!incoming.primarySelector) return send(res, 400, { error: "没有生成有效的页面元素选择器" });
    const existingIndex = memo.annotation.anchors.findIndex(anchor => anchor.id === incoming.id);
    if (existingIndex >= 0) memo.annotation.anchors[existingIndex] = incoming;
    else if (memo.annotation.anchors.length >= 20) return send(res, 400, { error: "每条提醒最多配置 20 个元素锚点" });
    else memo.annotation.anchors.push(incoming);
    memo.version = Number(memo.version || 0) + 1;
    memo.updatedBy = actorId || session.createdBy;
    memo.updatedAt = new Date().toISOString();
    session.status = "completed";
    session.completedAt = memo.updatedAt;
    appendAudit(db, { action: "annotation_anchor_created", entityType: "memo", entityId: memo.id, userId: memo.updatedBy });
    db.meta.version += 1;
    writeDb(db);
    return send(res, 201, { session, memo, anchor: incoming });
  }

  if (req.method === "POST" && url.pathname === "/api/admin/push") {
    const body = await parseBody(req);
    const memo = body.memoId ? db.memos.find(item => item.id === body.memoId && item.scope === "organization") : null;
    if (body.memoId && !memo) return send(res, 404, { error: "组织提醒不存在" });
    if (memo && memo.status !== "published") return send(res, 400, { error: "只有已发布提醒可以推送" });
    const delivery = await dispatchPush(db, {
      type: body.type,
      memoId: memo?.id || null,
      targetGroupIds: memo ? memo.targetGroupIds : body.targetGroupIds,
      targetUserIds: memo ? memo.targetUserIds : body.targetUserIds
    });
    return send(res, 201, {
      ...delivery,
      message: PUSH_CONFIGURED
        ? `已向 ${delivery.acceptedCount}/${delivery.targetCount} 台设备提交推送`
        : `内容已发布；Web Push 未配置，将由每 ${SYNC_CHECK_INTERVAL_MINUTES} 分钟兜底同步`
    });
  }

  if (req.method === "GET" && url.pathname === "/api/strategy-tests/pending") {
    const cutoff = Date.now() - 15 * 60_000;
    const tests = db.pageGroups
      .filter(group => group.strategy?.testRequest?.status === "pending" && Date.parse(group.strategy.testRequest.requestedAt || 0) >= cutoff)
      .map(group => ({
        pageGroupId: group.id,
        pageGroupName: group.name,
        sitePatterns: group.sitePatterns,
        strategy: {
          matchScope: group.strategy.matchScope,
          selector: group.strategy.selector,
          excludeSelector: group.strategy.excludeSelector
        },
        request: group.strategy.testRequest
      }));
    return send(res, 200, { tests });
  }

  const startStrategyTest = url.pathname.match(/^\/api\/admin\/page-groups\/([^/]+)\/test$/);
  if (startStrategyTest && req.method === "POST") {
    const group = db.pageGroups.find(item => item.id === startStrategyTest[1]);
    if (!group) return send(res, 404, { error: "页面组不存在" });
    if (group.strategy.matchScope === "page") return send(res, 400, { error: "整页策略不需要模块测试" });
    if (!group.strategy.selector) return send(res, 400, { error: "请先设置模块或行选择器" });
    const body = await parseBody(req);
    let testUrl;
    try {
      testUrl = new URL(String(body.url || ""));
      if (!isSupportedPageUrlProtocol(testUrl.protocol)) throw new Error("invalid protocol");
    } catch { return send(res, 400, { error: "请输入有效的 HTTP、HTTPS 或 file 测试网址" }); }
    const keywords = Array.isArray(body.keywords) ? body.keywords.map(String).map(item => item.trim()).filter(Boolean).slice(0, 50) : [];
    if (!keywords.length) return send(res, 400, { error: "请至少填写一个测试关键词" });
    const request = {
      id: `strategy_test_${randomUUID()}`,
      url: testUrl.href,
      keywords,
      requestedAt: new Date().toISOString(),
      status: "pending"
    };
    group.strategy.testRequest = request;
    group.strategy.lastTestResult = null;
    group.updatedAt = new Date().toISOString();
    db.meta.version += 1;
    writeDb(db);
    return send(res, 201, { pageGroupId: group.id, request });
  }

  const strategyTestResult = url.pathname.match(/^\/api\/strategy-tests\/([^/]+)\/result$/);
  if (strategyTestResult && req.method === "POST") {
    const group = db.pageGroups.find(item => item.strategy?.testRequest?.id === strategyTestResult[1]);
    if (!group) return send(res, 404, { error: "测试任务不存在或已失效" });
    const body = await parseBody(req);
    const result = {
      requestId: strategyTestResult[1],
      url: String(body.url || group.strategy.testRequest.url).slice(0, 2000),
      matchScope: ["module", "row"].includes(body.matchScope) ? body.matchScope : group.strategy.matchScope,
      selectorValid: Boolean(body.selectorValid),
      unitCount: Math.max(0, Number(body.unitCount || 0)),
      matchedUnitCount: Math.max(0, Number(body.matchedUnitCount || 0)),
      matchedTerms: Array.isArray(body.matchedTerms) ? body.matchedTerms.map(String).slice(0, 50) : [],
      missingTerms: Array.isArray(body.missingTerms) ? body.missingTerms.map(String).slice(0, 50) : [],
      error: body.error ? String(body.error).slice(0, 500) : null,
      testedAt: new Date().toISOString()
    };
    group.strategy.lastTestResult = result;
    group.strategy.testRequest = { ...group.strategy.testRequest, status: "completed", completedAt: result.testedAt };
    group.updatedAt = result.testedAt;
    writeDb(db);
    return send(res, 201, result);
  }

  if (req.method === "POST" && url.pathname === "/api/operation-receipts") {
    const { user, binding } = requireMember(db, req);
    const body = await parseBody(req);
    const memo = db.memos.find(item => item.id === body.memoId && item.type === "operation" && isActive(item) && visibleTo(item, user));
    if (!memo) return send(res, 404, { error: "操作提醒不存在或不可见" });
    const timezone = String(memo.dailyReminder?.timezone || user.timezone || "Asia/Shanghai");
    const localDate = localDateKey(Date.now(), timezone);
    const existing = db.operationReceipts.find(item => item.memoId === memo.id && item.userId === user.id && item.localDate === localDate);
    if (existing) return send(res, 200, existing);
    const receipt = {
      id: `operation_receipt_${randomUUID()}`,
      memoId: memo.id,
      userId: user.id,
      memberId: user.id,
      memberNameSnapshot: user.name,
      localDate,
      action: "acknowledged",
      acknowledgedAt: new Date().toISOString(),
      deviceId: binding.deviceId
    };
    db.operationReceipts.push(receipt);
    db.events.push({
      id: `event_${receipt.id}`,
      eventId: `operation:${receipt.id}`,
      organizationId: db.meta.organizationId,
      userId: user.id,
      memberId: user.id,
      memberNameSnapshot: user.name,
      memoId: memo.id,
      memoVersion: Number(memo.version || 1),
      memoType: memo.type,
      intensity: memo.intensity || memo.annotation?.intensity || "medium",
      ruleId: memo.id,
      deviceId: binding.deviceId,
      domain: "unknown",
      pageBucket: "unknown",
      action: "operation_completed",
      presentation: "reminder_card",
      anchorId: "",
      occurredAt: receipt.acknowledgedAt,
      createdAt: receipt.acknowledgedAt
    });
    appendAudit(db, { action: "operation_acknowledged", entityType: "memo", entityId: memo.id, userId: user.id });
    writeDb(db);
    return send(res, 201, receipt);
  }

  if (req.method === "POST" && url.pathname === "/api/broadcast-receipts") {
    const { user, binding } = requireMember(db, req);
    const body = await parseBody(req);
    const memo = db.memos.find(item => item.id === body.memoId && item.triggerMode === "broadcast" && isActive(item) && visibleTo(item, user));
    if (!memo) return send(res, 404, { error: "广播提醒不存在或不可见" });
    const memoVersion = Number(memo.version || 1);
    const existing = db.broadcastReceipts.find(item => item.memoId === memo.id && item.memoVersion === memoVersion && item.memberId === user.id);
    if (existing) return send(res, 200, existing);
    const receipt = {
      id: `broadcast_receipt_${randomUUID()}`,
      memoId: memo.id,
      memoVersion,
      memberId: user.id,
      memberNameSnapshot: user.name,
      deviceId: binding.deviceId,
      action: "acknowledged",
      acknowledgedAt: new Date().toISOString()
    };
    db.broadcastReceipts.push(receipt);
    appendAudit(db, { action: "broadcast_acknowledged", entityType: "memo", entityId: memo.id, userId: user.id, detail: { memoVersion } });
    writeDb(db);
    return send(res, 201, receipt);
  }

  if (url.pathname.startsWith("/api/personal-alarms")) {
    requireMember(db, req);
    return send(res, 410, { error: "个人闹钟已在页知 3.0 停用；原数据已安全归档" });
  }

  if (req.method === "POST" && url.pathname === "/api/personal-alarms") {
    const { user } = requireMember(db, req);
    const body = await parseBody(req);
    const alarm = cleanPersonalAlarm({ ...body, ownerId: user.id, status: "active" }, {}, user.id);
    db.personalAlarms.push(alarm);
    appendAudit(db, { action: "created", entityType: "alarm", entityId: alarm.id, userId: user.id });
    db.meta.version += 1;
    writeDb(db);
    return send(res, 201, alarm);
  }

  const personalAlarmMatch = url.pathname.match(/^\/api\/personal-alarms\/([^/]+)$/);
  if (personalAlarmMatch && ["PUT", "DELETE"].includes(req.method)) {
    const { user } = requireMember(db, req);
    const index = db.personalAlarms.findIndex(item => item.id === personalAlarmMatch[1] && item.ownerId === user.id);
    if (index < 0) return send(res, 404, { error: "个人闹钟不存在" });
    if (req.method === "DELETE") {
      db.personalAlarms[index].status = "archived";
      db.personalAlarms[index].nextTriggerAt = null;
      db.personalAlarms[index].updatedAt = new Date().toISOString();
    } else {
      db.personalAlarms[index] = cleanPersonalAlarm({ ...(await parseBody(req)), ownerId: user.id }, db.personalAlarms[index], user.id);
    }
    appendAudit(db, { action: req.method === "DELETE" ? "deleted" : "updated", entityType: "alarm", entityId: personalAlarmMatch[1], userId: user.id });
    db.meta.version += 1;
    writeDb(db);
    return send(res, 200, req.method === "DELETE" ? { ok: true } : db.personalAlarms[index]);
  }

  const completeAlarmMatch = url.pathname.match(/^\/api\/personal-alarms\/([^/]+)\/complete$/);
  if (completeAlarmMatch && req.method === "POST") {
    const { user } = requireMember(db, req);
    const alarm = db.personalAlarms.find(item => item.id === completeAlarmMatch[1] && item.ownerId === user.id && item.status === "active");
    if (!alarm) return send(res, 404, { error: "个人闹钟不存在" });
    const occurrence = alarm.nextTriggerAt || new Date().toISOString();
    alarm.lastCompletedOccurrence = occurrence;
    alarm.snoozedUntil = null;
    if (alarm.schedule.mode === "once") {
      alarm.status = "archived";
      alarm.nextTriggerAt = null;
    } else {
      alarm.nextTriggerAt = nextAlarmOccurrence(alarm.schedule, Math.max(Date.now(), Date.parse(occurrence)));
    }
    alarm.updatedAt = new Date().toISOString();
    appendAudit(db, { action: "alarm_completed", entityType: "alarm", entityId: alarm.id, userId: user.id });
    db.meta.version += 1;
    writeDb(db);
    return send(res, 200, alarm);
  }

  const snoozeAlarmMatch = url.pathname.match(/^\/api\/personal-alarms\/([^/]+)\/snooze$/);
  if (snoozeAlarmMatch && req.method === "POST") {
    const { user } = requireMember(db, req);
    const alarm = db.personalAlarms.find(item => item.id === snoozeAlarmMatch[1] && item.ownerId === user.id && item.status === "active");
    if (!alarm) return send(res, 404, { error: "个人闹钟不存在" });
    const body = await parseBody(req);
    const minutes = [10, 60, 1440].includes(Number(body.minutes)) ? Number(body.minutes) : 10;
    alarm.snoozedUntil = new Date(Date.now() + minutes * 60_000).toISOString();
    alarm.nextTriggerAt = alarm.snoozedUntil;
    alarm.updatedAt = new Date().toISOString();
    appendAudit(db, { action: "alarm_snoozed", entityType: "alarm", entityId: alarm.id, userId: user.id });
    writeDb(db);
    return send(res, 200, alarm);
  }

  if (req.method === "POST" && url.pathname === "/api/events") {
    const { user, binding } = requireMember(db, req);
    const body = await parseBody(req);
    const allowedActions = [
      "triggered", "opened", "confirmed", "ignored", "snoozed", "helpful", "unhelpful",
      "annotation_shown", "annotation_opened", "annotation_located", "annotation_unresolved",
      "published", "matched", "highlight_shown", "highlight_opened", "popup_shown", "expanded",
      "link_opened", "link_copied", "comment_opened", "comment_submitted",
      "operation_completed", "feedback_up", "feedback_down"
    ];
    if (!allowedActions.includes(body.action)) return send(res, 400, { error: "不支持的事件类型" });
    const eventId = String(body.eventId || `event-client-${randomUUID()}`).slice(0, 200);
    const duplicate = db.events.find(item => item.eventId === eventId);
    if (duplicate) return send(res, 200, duplicate);
    const memo = db.memos.find(item => item.id === String(body.memoId || ""));
    if (!memo || !visibleTo(memo, user)) return send(res, 404, { error: "提醒不存在或不可见" });
    const pageBucket = normalizePageBucket(body.pageBucket || body.pageUrl || body.domain || "", body.pathHint || "");
    const occurredAtValue = Date.parse(body.occurredAt || "");
    const occurredAt = Number.isFinite(occurredAtValue) && occurredAtValue <= Date.now() + 5 * 60_000
      ? new Date(occurredAtValue).toISOString()
      : new Date().toISOString();
    const event = {
      id: `event_${randomUUID()}`,
      eventId,
      organizationId: db.meta.organizationId,
      userId: user.id,
      memberId: user.id,
      memberNameSnapshot: user.name,
      memoId: String(body.memoId || ""),
      memoVersion: Number(body.memoVersion || memo.version || 1),
      memoType: memo.type || "knowledge",
      intensity: memo.intensity || memo.annotation?.intensity || "medium",
      ruleId: String(body.ruleId || body.memoId || ""),
      deviceId: binding.deviceId,
      domain: pageBucket,
      pageBucket,
      action: body.action,
      presentation: String(body.presentation || "sidepanel"),
      anchorId: String(body.anchorId || "").slice(0, 120),
      occurredAt,
      createdAt: new Date().toISOString()
    };
    db.events.push(event);
    let feedback = null;
    if (body.action === "feedback_up" || body.action === "feedback_down") {
      const feedbackIndex = db.memberFeedback.findIndex(item => item.memoId === memo.id && item.memoVersion === event.memoVersion && item.memberId === user.id);
      feedback = {
        id: feedbackIndex >= 0 ? db.memberFeedback[feedbackIndex].id : `feedback_${randomUUID()}`,
        memoId: memo.id,
        memoVersion: event.memoVersion,
        memberId: user.id,
        memberNameSnapshot: user.name,
        action: body.action,
        deviceId: binding.deviceId,
        updatedAt: event.createdAt,
        createdAt: feedbackIndex >= 0 ? db.memberFeedback[feedbackIndex].createdAt : event.createdAt
      };
      if (feedbackIndex >= 0) db.memberFeedback[feedbackIndex] = feedback;
      else db.memberFeedback.push(feedback);
    }
    writeDb(db);
    return send(res, 201, feedback ? { ...event, feedback } : event);
  }

  if (req.method === "POST" && url.pathname === "/api/quick-memos") {
    const { user, binding } = requireMember(db, req);
    const body = await parseBody(req);
    const scope = body.scope === "organization" ? "organization" : "personal";
    if (scope === "organization" && !canPublishOrganizationMemos(db, user)) {
      return send(res, 403, { error: "仅管理组成员可以发布全员提醒" });
    }
    const includeTerms = normalizeRule(body.rule).includeTerms;
    if (!includeTerms.length) return send(res, 400, { error: "请至少设置一个关键词" });
    const invalidTerm = includeTerms.map(term => validateQuickSelection(term)).find(result => !result.ok);
    if (invalidTerm?.reason === "too_long") return send(res, 400, { error: "每个关键词最多20个字符" });
    if (invalidTerm?.reason === "too_short") return send(res, 400, { error: "每个关键词至少2个字符" });
    if (invalidTerm?.reason === "line_break") return send(res, 400, { error: "关键词不允许换行" });
    if (invalidTerm) return send(res, 400, { error: "关键词格式无效" });
    if (!String(body.body || "").trim()) return send(res, 400, { error: "请填写提醒备注" });

    const now = new Date();
    const operationDefaults = body.type === "operation" ? {
      startsAt: body.startsAt || now.toISOString(),
      expiresAt: body.expiresAt || new Date(now.getTime() + 30 * 24 * 60 * 60_000).toISOString()
    } : {};
    const memo = cleanMemo({
      ...body,
      ...operationDefaults,
      scope,
      ownerId: scope === "personal" ? user.id : null,
      deviceId: binding.deviceId,
      folderId: scope === "personal" ? personalMemoFolderId(body.type, db) : null,
      status: "published",
      triggerMode: "page_match",
      audienceType: scope === "organization" ? "all" : "members",
      targetGroupIds: [],
      targetUserIds: scope === "organization" ? [] : [user.id],
      annotation: {
        ...(body.annotation || {}),
        template: body.annotation?.template || "light"
      },
      submittedByMemberId: user.id,
      submittedByNameSnapshot: user.name,
      createdByNameSnapshot: user.name,
      actorName: user.name
    }, {}, user.id);
    validateMemoAudience(db, memo);
    db.memos.push(memo);
    appendSubmissionSnapshot(db, memo, {
      entityType: "memo",
      actorMemberId: user.id,
      actorName: user.name,
      source: "member",
      requestId: body.requestId || null
    });
    if (scope === "organization") {
      db.events.push({
        id: `event_${randomUUID()}`,
        eventId: `published:${memo.id}:${memo.version}`,
        organizationId: db.meta.organizationId,
        userId: user.id,
        memberId: user.id,
        memberNameSnapshot: user.name,
        memoId: memo.id,
        memoVersion: Number(memo.version || 1),
        memoType: memo.type,
        intensity: memo.intensity,
        ruleId: memo.id,
        deviceId: binding.deviceId,
        domain: "quick-create",
        pageBucket: "quick-create",
        action: "published",
        presentation: "context_menu",
        anchorId: "",
        occurredAt: memo.createdAt,
        createdAt: memo.createdAt
      });
    }
    appendAudit(db, { action: "created", entityType: "memo", entityId: memo.id, userId: user.id });
    db.meta.version += 1;
    writeDb(db);
    if (scope === "organization") {
      await dispatchPush(db, { type: "sync", memoId: memo.id, targetGroupIds: [], targetUserIds: [] });
    }
    return send(res, 201, memo);
  }

  if (req.method === "POST" && url.pathname === "/api/personal-memos") {
    const { user, binding } = requireMember(db, req);
    const body = await parseBody(req);
    const actorId = user.id;
    const memo = cleanMemo({
      ...body,
      scope: "personal",
      ownerId: user.id,
      deviceId: binding.deviceId,
      folderId: personalMemoFolderId(body.type, db),
      status: "published",
      submittedByMemberId: user.id,
      submittedByNameSnapshot: user.name,
      actorName: user.name
    }, {}, actorId);
    db.memos.push(memo);
    appendSubmissionSnapshot(db, memo, { entityType: "memo", actorMemberId: user.id, actorName: user.name, source: "member", requestId: body.requestId || null });
    appendAudit(db, { action: "created", entityType: "memo", entityId: memo.id, userId: actorId });
    db.meta.version += 1;
    writeDb(db);
    return send(res, 201, memo);
  }

  const personalMatch = url.pathname.match(/^\/api\/personal-memos\/([^/]+)$/);
  if (personalMatch && ["PUT", "DELETE"].includes(req.method)) {
    const { user, binding } = requireMember(db, req);
    const index = db.memos.findIndex(item => item.id === personalMatch[1] && item.scope === "personal");
    if (index < 0) return send(res, 404, { error: "个人备忘不存在" });
    const userId = user.id;
    if (userId !== db.memos[index].ownerId) return send(res, 403, { error: "无权修改该备忘" });
    if (req.method === "DELETE") {
      appendAudit(db, { action: "deleted", entityType: "memo", entityId: db.memos[index].id, userId });
      db.memos.splice(index, 1);
    }
    else {
      const body = await parseBody(req);
      const updatedMemo = cleanMemo({ ...body, scope: "personal", ownerId: userId, deviceId: binding.deviceId, actorName: user.name }, db.memos[index], userId);
      updatedMemo.folderId = personalMemoFolderId(updatedMemo.type, db);
      db.memos[index] = updatedMemo;
      appendSubmissionSnapshot(db, db.memos[index], { entityType: "memo", actorMemberId: user.id, actorName: user.name, source: "member", requestId: body.requestId || null });
      appendAudit(db, { action: "updated", entityType: "memo", entityId: db.memos[index].id, userId });
    }
    db.meta.version += 1;
    writeDb(db);
    return send(res, 200, req.method === "DELETE" ? { ok: true } : db.memos[index]);
  }

  const memoFolderMoveMatch = url.pathname.match(/^\/api\/admin\/memos\/([^/]+)\/folder$/);
  if (memoFolderMoveMatch && req.method === "PUT") {
    const actorId = requestActor(req);
    const memo = db.memos.find(item => item.id === memoFolderMoveMatch[1] && item.scope === "organization" && !item.systemGeneratedSupplier);
    if (!memo) return send(res, 404, { error: "组织提醒不存在" });
    const body = await parseBody(req);
    const folderId = String(body.folderId || "").trim().slice(0, 120) || null;
    if (folderId && !db.memoFolders.some(folder => folder.id === folderId && folder.status !== "archived" && folder.scope !== "personal")) {
      return send(res, 400, { error: "选择的提醒文件夹不存在" });
    }
    const previousFolderId = memo.folderId || null;
    if (previousFolderId === folderId) return send(res, 200, memo);
    memo.folderId = folderId;
    memo.version = Number(memo.version || 0) + 1;
    memo.updatedBy = actorId;
    memo.updatedAt = new Date().toISOString();
    appendAudit(db, { action: "folder_changed", entityType: "memo", entityId: memo.id, userId: actorId, detail: { previousFolderId, folderId } });
    db.meta.version += 1;
    writeDb(db);
    return send(res, 200, memo);
  }

  const adminCollection = parts[2];
  const collectionMap = { memos: "memos", tools: "tools", "page-groups": "pageGroups", suppliers: "suppliers", "memo-folders": "memoFolders" };
  if (parts[0] === "api" && parts[1] === "admin" && Object.hasOwn(collectionMap, adminCollection)) {
    const collection = collectionMap[adminCollection];
    const cleaner = collection === "memos" ? cleanMemo : collection === "tools" ? cleanTool : collection === "suppliers" ? cleanSupplier : collection === "memoFolders" ? cleanMemoFolder : cleanPageGroup;
    const entityType = collection === "pageGroups" ? "pageGroup" : collection.slice(0, -1);
    const actorId = requestActor(req);
    const actorName = db.users.find(user => user.id === actorId)?.name || actorId;
    if (req.method === "POST" && parts.length === 3) {
      const body = await parseBody(req);
      const item = cleaner(collection === "memos" ? { ...body, actorName } : body, {}, actorId);
      if (collection === "memoFolders" && db.memoFolders.some(folder => folder.status !== "archived" && folder.name.toLocaleLowerCase("zh-CN") === item.name.toLocaleLowerCase("zh-CN"))) {
        return send(res, 409, { error: "已存在同名提醒文件夹" });
      }
      if (collection === "memos") {
        validateMemoAudience(db, item);
        item.entityRefs = (item.entityRefs || []).map(ref => {
          const supplier = db.suppliers.find(candidate => candidate.id === ref.id && candidate.status !== "archived");
          if (!supplier) { const error = new Error("关联的供应商资料不存在"); error.statusCode = 400; throw error; }
          return { ...ref, displayName: supplier.companyName };
        });
        if (item.folderId && !db.memoFolders.some(folder => folder.id === item.folderId && folder.status !== "archived" && folder.scope !== "personal")) {
          const error = new Error("选择的提醒文件夹不存在");
          error.statusCode = 400;
          throw error;
        }
      }
      db[collection].push(item);
      appendSubmissionSnapshot(db, item, { entityType, actorMemberId: actorId, actorName, source: "admin", requestId: body.requestId || null });
      if (collection === "memos" && item.status === "published") {
        db.events.push({
          id: `event_${randomUUID()}`,
          eventId: `published:${item.id}:${item.version}`,
          organizationId: db.meta.organizationId,
          userId: actorId,
          memberId: actorId,
          memberNameSnapshot: actorName,
          memoId: item.id,
          memoVersion: Number(item.version || 1),
          memoType: item.type,
          intensity: item.intensity,
          ruleId: item.id,
          deviceId: null,
          domain: "configuration",
          pageBucket: "configuration",
          action: "published",
          presentation: "admin",
          anchorId: "",
          occurredAt: item.createdAt,
          createdAt: item.createdAt
        });
      }
      appendAudit(db, { action: "created", entityType, entityId: item.id, userId: actorId });
      db.meta.version += 1;
      writeDb(db);
      return send(res, 201, item);
    }
    if (["PUT", "DELETE"].includes(req.method) && parts.length === 4) {
      const index = db[collection].findIndex(item => item.id === parts[3]);
      if (index < 0) return send(res, 404, { error: "内容不存在" });
      const previousItem = JSON.parse(JSON.stringify(db[collection][index]));
      let deletedItem = null;
      if (req.method === "DELETE" && collection === "pageGroups") {
        const usedBy = db.memos.filter(item => item.rule?.pageGroupIds?.includes(parts[3]));
        if (usedBy.length) return send(res, 409, { error: `该页面组正被 ${usedBy.length} 条备忘使用，请先调整备忘范围` });
        db[collection].splice(index, 1);
      }
      else if (req.method === "DELETE" && collection === "suppliers") {
        const usedBy = db.memos.filter(item => !item.systemGeneratedSupplier && (item.entityRefs || []).some(ref => ref.type === "supplier" && ref.id === parts[3]));
        if (usedBy.length) return send(res, 409, { error: `该供应商正被 ${usedBy.length} 条提醒使用，请先取消关联` });
        db[collection].splice(index, 1);
      }
      else if (req.method === "DELETE" && collection === "memos") {
        deletedItem = db[collection][index];
        db[collection].splice(index, 1);
        for (const session of db.annotationSessions.filter(item => item.memoId === deletedItem.id && item.status === "pending")) session.status = "cancelled";
      }
      else if (req.method === "DELETE" && collection === "memoFolders") {
        if (db[collection][index].systemManaged) return send(res, 409, { error: "系统自动归类文件夹不能删除" });
        db[collection].splice(index, 1);
        for (const memo of db.memos) if (memo.folderId === parts[3]) memo.folderId = null;
      }
      else if (req.method === "DELETE") db[collection][index] = { ...db[collection][index], status: "archived", updatedBy: actorId, updatedAt: new Date().toISOString() };
      else {
        if (collection === "memoFolders" && db[collection][index].systemManaged) return send(res, 409, { error: "系统自动归类文件夹不能编辑" });
        const body = await parseBody(req);
        const nextItem = cleaner(collection === "memos" ? { ...body, actorName } : body, db[collection][index], actorId);
        if (collection === "memoFolders" && db.memoFolders.some((folder, folderIndex) => folderIndex !== index && folder.status !== "archived" && folder.name.toLocaleLowerCase("zh-CN") === nextItem.name.toLocaleLowerCase("zh-CN"))) {
          return send(res, 409, { error: "已存在同名提醒文件夹" });
        }
        db[collection][index] = nextItem;
        if (collection === "memos") {
          validateMemoAudience(db, db[collection][index]);
          db[collection][index].entityRefs = (db[collection][index].entityRefs || []).map(ref => {
            const supplier = db.suppliers.find(candidate => candidate.id === ref.id && candidate.status !== "archived");
            if (!supplier) { const error = new Error("关联的供应商资料不存在"); error.statusCode = 400; throw error; }
            return { ...ref, displayName: supplier.companyName };
          });
          if (db[collection][index].folderId && !db.memoFolders.some(folder => folder.id === db[collection][index].folderId && folder.status !== "archived" && folder.scope !== "personal")) {
            const error = new Error("选择的提醒文件夹不存在");
            error.statusCode = 400;
            throw error;
          }
        }
        appendSubmissionSnapshot(db, db[collection][index], { entityType, actorMemberId: actorId, actorName, source: "admin", requestId: body.requestId || null });
        if (collection === "memos" && db[collection][index].status === "published") {
          const memo = db[collection][index];
          db.events.push({
            id: `event_${randomUUID()}`,
            eventId: `published:${memo.id}:${memo.version}`,
            organizationId: db.meta.organizationId,
            userId: actorId,
            memberId: actorId,
            memberNameSnapshot: actorName,
            memoId: memo.id,
            memoVersion: Number(memo.version || 1),
            memoType: memo.type,
            intensity: memo.intensity,
            ruleId: memo.id,
            deviceId: null,
            domain: "configuration",
            pageBucket: "configuration",
            action: "published",
            presentation: "admin",
            anchorId: "",
            occurredAt: memo.updatedAt,
            createdAt: memo.updatedAt
          });
        }
      }
      if (req.method === "DELETE") appendSubmissionSnapshot(db, previousItem, { entityType: `${entityType}Deleted`, actorMemberId: actorId, actorName, source: "admin" });
      appendAudit(db, { action: req.method === "DELETE" ? "deleted" : "updated", entityType, entityId: parts[3], userId: actorId });
      db.meta.version += 1;
      writeDb(db);
      if (deletedItem) {
        const delivery = await dispatchPush(db, { type: "sync", memoId: null, targetGroupIds: deletedItem.targetGroupIds, targetUserIds: deletedItem.targetUserIds });
        return send(res, 200, { ok: true, deletedId: deletedItem.id, sync: { targetCount: delivery.targetCount, acceptedCount: delivery.acceptedCount } });
      }
      return send(res, 200, req.method === "DELETE" && ["pageGroups", "suppliers", "memoFolders"].includes(collection) ? { ok: true } : db[collection][index]);
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
    if (url.pathname.startsWith("/downloads/") && serveDownload(url.pathname, res)) return;
    if (url.pathname.startsWith("/demo") && serveDemo(url.pathname, res)) return;
    if (url.pathname === "/") {
      res.writeHead(302, { Location: "/admin" });
      return res.end();
    }
    return send(res, 404, { error: "页面不存在" });
  } catch (error) {
    const statusCode = Number(error.statusCode) || 500;
    if (statusCode >= 500) console.error(error);
    if (url.pathname.startsWith("/api/integrations/workbuddy/")) {
      return send(res, statusCode, {
        ok: false,
        status: statusCode === 401 ? "unauthorized" : statusCode === 503 ? "not_configured" : statusCode < 500 ? "validation_failed" : "server_error",
        message: error.message || "页知服务暂时不可用"
      });
    }
    return send(res, statusCode, { error: error.message || "服务器错误" });
  }
});

if (require.main === module) {
  server.listen(PORT, HOST, () => {
    console.log(`页知 PageCue is running at http://${HOST}:${PORT}/admin`);
  });
}

module.exports = { server, isActive, visibleTo, canPublishOrganizationMemos, localDateKey, normalizeRule, normalizePageStrategy, normalizeAnnotation, normalizeAnnotationAnchor, normalizeAlarmSchedule, resolveMemoPageGroups, cleanMemo, cleanMemoFolder, cleanGroup, ensurePersonalMemoFolders, personalMemoFolderId, cleanPersonalAlarm, cleanSupplier, cleanTool, cleanPageGroup, eventStats, websiteFunnelStats, validateMemoAudience };
