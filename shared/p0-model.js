const { createHash, randomUUID } = require("node:crypto");

const INTERACTION_ACTIONS = new Set([
  "link_opened",
  "link_copied",
  "comment_opened",
  "comment_submitted",
  "operation_completed",
  "feedback_up",
  "feedback_down"
]);

function uniqueStrings(value, limit = 500) {
  if (!Array.isArray(value)) return [];
  return [...new Set(value.map(item => String(item || "").trim()).filter(Boolean))].slice(0, limit);
}

function inferredAudienceType(input = {}) {
  if (input.audienceType === "groups" || input.audienceType === "members" || input.audienceType === "all") return input.audienceType;
  if (uniqueStrings(input.targetUserIds).length) return "members";
  if (uniqueStrings(input.targetGroupIds).length) return "groups";
  return "all";
}

function normalizeAudience(input = {}, { allowEmpty = false } = {}) {
  const audienceType = inferredAudienceType(input);
  const groupIds = uniqueStrings(input.targetGroupIds, 500);
  const memberIds = uniqueStrings(input.targetUserIds || input.targetMemberIds, 500);
  if (audienceType === "groups") {
    if (!groupIds.length && !allowEmpty) throw new Error("指定成员组投放必须至少选择一个成员组");
    return { audienceType, targetGroupIds: groupIds, targetUserIds: [] };
  }
  if (audienceType === "members") {
    if (!memberIds.length && !allowEmpty) throw new Error("指定成员投放必须至少选择一名成员");
    return { audienceType, targetGroupIds: [], targetUserIds: memberIds };
  }
  return { audienceType: "all", targetGroupIds: [], targetUserIds: [] };
}

function baseDomain(hostname = "") {
  const host = String(hostname || "").trim().toLowerCase().replace(/\.$/, "").replace(/^www\./, "");
  if (!host || host === "localhost" || /^\d{1,3}(?:\.\d{1,3}){3}$/.test(host)) return host || "unknown";
  const parts = host.split(".").filter(Boolean);
  return parts.length > 2 ? parts.slice(-2).join(".") : host;
}

function normalizePageBucket(value = "", pathHint = "") {
  const raw = String(value || "").trim();
  if (!raw) return "unknown";
  let hostname = raw;
  let pathname = String(pathHint || "");
  try {
    const parsed = new URL(/^[a-z][a-z0-9+.-]*:\/\//i.test(raw) ? raw : `https://${raw}`);
    if (parsed.protocol === "file:") return "file";
    hostname = parsed.hostname;
    pathname = parsed.pathname || pathname;
  } catch {
    const slash = raw.indexOf("/");
    hostname = slash >= 0 ? raw.slice(0, slash) : raw;
    pathname = slash >= 0 ? raw.slice(slash) : pathname;
  }
  const domain = baseDomain(hostname);
  if (domain === "biochemsafebuy.com" && /^\/admin(?:\/|$)/i.test(pathname)) return "biochemsafebuy.com/admin";
  return domain;
}

function canonicalize(value) {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.keys(value).sort().map(key => [key, canonicalize(value[key])]));
  }
  return value;
}

function createSubmissionSnapshot(entity, options = {}) {
  const payload = canonicalize(JSON.parse(JSON.stringify(entity || {})));
  const canonicalPayload = JSON.stringify(payload);
  return {
    id: options.id || `submission_${randomUUID()}`,
    entityType: String(options.entityType || "memo"),
    entityId: String(entity?.id || options.entityId || ""),
    entityVersion: Number(entity?.version || options.entityVersion || 1),
    actorMemberId: String(options.actorMemberId || ""),
    actorNameSnapshot: String(options.actorName || options.actorMemberId || "未知成员").slice(0, 120),
    source: ["admin", "member", "workbuddy", "migration"].includes(options.source) ? options.source : "admin",
    requestId: options.requestId ? String(options.requestId).slice(0, 200) : null,
    contentHash: createHash("sha256").update(canonicalPayload).digest("hex"),
    payload,
    createdAt: options.now || new Date().toISOString()
  };
}

function actionStats(events, action) {
  const matching = events.filter(event => event.action === action);
  return {
    events: matching.length,
    members: new Set(matching.map(event => event.memberId || event.userId).filter(Boolean)).size
  };
}

function funnelStats(events = []) {
  const safeEvents = Array.isArray(events) ? events : [];
  const actions = {};
  for (const action of [...new Set(safeEvents.map(event => event.action).filter(Boolean))]) actions[action] = actionStats(safeEvents, action);
  const interactionEvents = safeEvents.filter(event => INTERACTION_ACTIONS.has(event.action));
  return {
    actions,
    anyInteraction: {
      events: interactionEvents.length,
      members: new Set(interactionEvents.map(event => event.memberId || event.userId).filter(Boolean)).size
    }
  };
}

module.exports = {
  INTERACTION_ACTIONS,
  normalizeAudience,
  normalizePageBucket,
  createSubmissionSnapshot,
  funnelStats
};
