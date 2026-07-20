const PRODUCTION_API_BASE = "https://pagecue.herotop.cn";
const DEFAULT_CONFIG = {
  apiBase: PRODUCTION_API_BASE,
  sitePatterns: [],
  managedSitePatterns: []
};
const CONTENT_SCRIPT_ID = "context-companion-scanner";
const SYNC_ALARM_NAME = "pagecue-hourly-sync";
const SYNC_INTERVAL_MINUTES = 60;
const PERSONAL_ALARM_PREFIX = "pagecue-personal:";
const NOTIFICATIONS_AVAILABLE = Boolean(chrome.notifications?.create);
const UPDATE_CHECK_AVAILABLE = Boolean(chrome.runtime?.requestUpdateCheck);
const DYNAMIC_SCRIPTS_AVAILABLE = Boolean(chrome.scripting?.registerContentScripts);

const SIDE_PANEL_AVAILABLE = Boolean(chrome.sidePanel?.setPanelBehavior && chrome.sidePanel?.open);
if (SIDE_PANEL_AVAILABLE) chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true }).catch(() => {});
else chrome.action.setPopup({ popup: "sidepanel/index.html" }).catch(() => {});

async function openPageCue(tabId) {
  if (SIDE_PANEL_AVAILABLE && tabId) return chrome.sidePanel.open({ tabId });
  return chrome.tabs.create({ url: chrome.runtime.getURL("sidepanel/index.html") });
}

async function getConfig() {
  const { config } = await chrome.storage.local.get("config");
  return { ...DEFAULT_CONFIG, ...(config || {}) };
}

async function setConfig(patch) {
  const config = { ...(await getConfig()), ...patch };
  await chrome.storage.local.set({ config });
  return config;
}

async function getDeviceId() {
  const stored = await chrome.storage.local.get("pushDeviceId");
  if (stored.pushDeviceId) return stored.pushDeviceId;
  const pushDeviceId = crypto.randomUUID ? crypto.randomUUID() : `device-${Date.now()}-${Math.random().toString(16).slice(2)}`;
  await chrome.storage.local.set({ pushDeviceId });
  return pushDeviceId;
}

function urlB64ToUint8Array(value) {
  const padding = "=".repeat((4 - value.length % 4) % 4);
  const base64 = (value + padding).replace(/-/g, "+").replace(/_/g, "/");
  const raw = atob(base64);
  return Uint8Array.from([...raw].map(char => char.charCodeAt(0)));
}

function sameApplicationServerKey(subscription, expected) {
  const current = subscription?.options?.applicationServerKey;
  if (!current) return false;
  const bytes = new Uint8Array(current);
  return bytes.length === expected.length && bytes.every((value, index) => value === expected[index]);
}

function compareVersions(left = "0", right = "0") {
  const a = String(left).split(".").map(value => Number(value) || 0);
  const b = String(right).split(".").map(value => Number(value) || 0);
  for (let index = 0; index < Math.max(a.length, b.length); index += 1) {
    if ((a[index] || 0) !== (b[index] || 0)) return (a[index] || 0) - (b[index] || 0);
  }
  return 0;
}

async function fetchJson(path, options = {}) {
  const config = await getConfig();
  const { memberToken } = await chrome.storage.local.get("memberToken");
  const response = await fetch(`${config.apiBase}${path}`, {
    ...options,
    headers: { "Content-Type": "application/json", ...(memberToken ? { Authorization: `Bearer ${memberToken}` } : {}), ...(options.headers || {}) }
  });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(payload.error || `服务请求失败 (${response.status})`);
  return payload;
}

async function refreshBootstrap() {
  try {
    const bootstrap = await fetchJson("/api/bootstrap");
    const syncedReceipts = await flushOperationReceiptQueue();
    if (syncedReceipts.length) bootstrap.operationReceipts = [...(bootstrap.operationReceipts || []).filter(item => !syncedReceipts.some(receipt => receipt.memoId === item.memoId)), ...syncedReceipts];
    await chrome.storage.local.set({ bootstrap, bootstrapUpdatedAt: Date.now(), lastSyncError: null });
    const config = await getConfig();
    const managedPatterns = [...new Set((bootstrap.pageGroups || []).flatMap(group => group.sitePatterns || []).filter(pattern => /^https?:\/\//i.test(pattern)))];
    await registerSites(config.sitePatterns || [], managedPatterns);
    await clearPersonalAlarmSchedules();
    await chrome.storage.local.remove(["duePersonalAlarms", "selectedAlarmId"]);
    flushEventQueue();
    notifyContentScripts({ type: "BOOTSTRAP_UPDATED" });
    return { bootstrap, offline: false };
  } catch (error) {
    const cached = await chrome.storage.local.get(["bootstrap", "bootstrapUpdatedAt"]);
    await chrome.storage.local.set({ lastSyncError: error.message });
    if (cached.bootstrap) return { bootstrap: cached.bootstrap, offline: true, error: error.message, updatedAt: cached.bootstrapUpdatedAt };
    throw error;
  }
}

async function flushOperationReceiptQueue() {
  const { operationReceiptQueue = [] } = await chrome.storage.local.get("operationReceiptQueue");
  if (!operationReceiptQueue.length) return [];
  const remaining = [];
  const synced = [];
  for (const item of operationReceiptQueue) {
    try { synced.push(await fetchJson("/api/operation-receipts", { method: "POST", body: JSON.stringify({ memoId: item.memoId }) })); }
    catch { remaining.push(item); }
  }
  await chrome.storage.local.set({ operationReceiptQueue: remaining });
  return synced;
}

async function getMemberSession() {
  const { memberToken, memberSession } = await chrome.storage.local.get(["memberToken", "memberSession"]);
  if (!memberToken) return { bound: false };
  try {
    const session = await fetchJson("/api/device/session");
    await chrome.storage.local.set({ memberSession: session });
    return { bound: true, ...session };
  } catch (error) {
    await chrome.storage.local.remove(["memberToken", "memberSession", "bootstrap"]);
    return { bound: false, error: error.message, previous: memberSession || null };
  }
}

async function bindInvitation(inviteCode) {
  const config = await getConfig();
  const response = await fetch(`${config.apiBase}/api/device-bindings`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ inviteCode, deviceId: await getDeviceId(), browser: navigator.userAgent, extensionVersion: chrome.runtime.getManifest().version })
  });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(payload.error || "邀请码绑定失败");
  await chrome.storage.local.set({ memberToken: payload.token, memberSession: payload });
  await refreshBootstrap();
  await registerPushSubscription().catch(() => {});
  return payload;
}

async function unbindMember() {
  await fetchJson("/api/device/session", { method: "DELETE" }).catch(() => {});
  await chrome.storage.local.remove(["memberToken", "memberSession", "bootstrap", "activeMatches"]);
  await clearPersonalAlarmSchedules();
  await chrome.action.setBadgeText({ text: "" });
  return { ok: true };
}

async function clearPersonalAlarmSchedules() {
  const alarms = await chrome.alarms.getAll();
  await Promise.all(alarms.filter(item => item.name.startsWith(PERSONAL_ALARM_PREFIX)).map(item => chrome.alarms.clear(item.name)));
}

async function ensureSyncAlarm() {
  const existing = await chrome.alarms.get(SYNC_ALARM_NAME);
  if (!existing || existing.periodInMinutes !== SYNC_INTERVAL_MINUTES) {
    await chrome.alarms.create(SYNC_ALARM_NAME, { delayInMinutes: SYNC_INTERVAL_MINUTES, periodInMinutes: SYNC_INTERVAL_MINUTES });
  }
}

async function registerPushSubscription() {
  const pushConfig = await fetchJson("/api/push/config");
  if (!pushConfig.enabled || !pushConfig.publicKey || !self.registration?.pushManager) {
    await chrome.storage.local.set({ pushState: { enabled: false, reason: "server_not_configured", checkedAt: Date.now() } });
    return { enabled: false };
  }
  const applicationServerKey = urlB64ToUint8Array(pushConfig.publicKey);
  let subscription = await self.registration.pushManager.getSubscription();
  if (subscription && !sameApplicationServerKey(subscription, applicationServerKey)) {
    await subscription.unsubscribe();
    subscription = null;
  }
  if (!subscription) {
    subscription = await self.registration.pushManager.subscribe({
      userVisibleOnly: false,
      applicationServerKey
    });
  }
  const deviceId = await getDeviceId();
  const registered = await fetchJson("/api/push/subscribe", {
    method: "POST",
    body: JSON.stringify({
      deviceId,
      browser: navigator.userAgent,
      extensionVersion: chrome.runtime.getManifest().version,
      subscription: subscription.toJSON()
    })
  });
  await chrome.storage.local.set({ pushState: { enabled: true, subscriptionId: registered.id, registeredAt: Date.now() } });
  return { enabled: true, subscriptionId: registered.id };
}

async function acknowledgePush(deliveryId, status, error = null) {
  if (!deliveryId) return;
  await fetchJson("/api/push/ack", {
    method: "POST",
    body: JSON.stringify({
      deliveryId,
      deviceId: await getDeviceId(),
      status,
      extensionVersion: chrome.runtime.getManifest().version,
      error
    })
  }).catch(() => {});
}

async function requestExtensionUpdate(force = false) {
  if (!UPDATE_CHECK_AVAILABLE) return { status: "manual_update_required" };
  const { lastExtensionUpdateCheckAt = 0 } = await chrome.storage.local.get("lastExtensionUpdateCheckAt");
  if (!force && Date.now() - lastExtensionUpdateCheckAt < 12 * 60 * 60_000) return { status: "throttled_locally" };
  await chrome.storage.local.set({ lastExtensionUpdateCheckAt: Date.now() });
  return chrome.runtime.requestUpdateCheck();
}

async function checkServerVersion() {
  const config = await getConfig();
  const cached = await chrome.storage.local.get(["bootstrap", "versionEtag", "pushState"]);
  const response = await fetch(`${config.apiBase}/api/version`, {
    headers: { ...(cached.versionEtag ? { "If-None-Match": cached.versionEtag } : {}) }
  });
  if (response.status === 304) return { changed: false };
  if (!response.ok) throw new Error(`版本检查失败 (${response.status})`);
  const versionInfo = await response.json();
  await chrome.storage.local.set({ versionInfo });
  const etag = response.headers.get("ETag");
  if (etag) await chrome.storage.local.set({ versionEtag: etag });
  const changed = Number(versionInfo.version || 0) > Number(cached.bootstrap?.version || 0);
  if (changed) await refreshBootstrap();
  if (versionInfo.pushConfigured && !cached.pushState?.enabled) await registerPushSubscription().catch(() => {});
  if (compareVersions(versionInfo.latestExtensionVersion, chrome.runtime.getManifest().version) > 0) {
    await chrome.storage.local.set({ pendingExtensionVersion: versionInfo.latestExtensionVersion, updateAvailableAt: Date.now() });
    await requestExtensionUpdate();
  }
  return { changed, version: versionInfo.version };
}

async function handlePushEvent(event) {
  let payload = {};
  try { payload = event.data?.json() || {}; } catch { payload = { type: "sync" }; }
  await acknowledgePush(payload.deliveryId, "received");
  if (payload.type === "extension_update") {
    try {
      await requestExtensionUpdate(true);
      await acknowledgePush(payload.deliveryId, "update_requested");
    } catch (error) {
      await acknowledgePush(payload.deliveryId, "failed", error.message);
    }
    return;
  }
  try {
    await refreshBootstrap();
    await acknowledgePush(payload.deliveryId, "synced");
  } catch (error) {
    await acknowledgePush(payload.deliveryId, "failed", error.message);
  }
}

async function flushEventQueue() {
  const { eventQueue = [] } = await chrome.storage.local.get("eventQueue");
  if (!eventQueue.length) return;
  const remaining = [];
  for (const event of eventQueue) {
    try { await fetchJson("/api/events", { method: "POST", body: JSON.stringify(event) }); }
    catch { remaining.push(event); }
  }
  await chrome.storage.local.set({ eventQueue: remaining });
}

async function getBootstrap() {
  const cached = await chrome.storage.local.get(["bootstrap", "bootstrapUpdatedAt", "lastSyncError"]);
  if (cached.bootstrap && Date.now() - Number(cached.bootstrapUpdatedAt || 0) < 5 * 60_000) return { bootstrap: cached.bootstrap, offline: Boolean(cached.lastSyncError), updatedAt: cached.bootstrapUpdatedAt };
  return refreshBootstrap();
}

async function registerSites(patterns, managedPatterns = []) {
  const personalPatterns = [...new Set((patterns || []).filter(pattern => /^https?:\/\//i.test(pattern)))];
  const organizationPatterns = [...new Set((managedPatterns || []).filter(pattern => /^https?:\/\//i.test(pattern)))];
  const requestedPatterns = [...new Set([...personalPatterns, ...organizationPatterns])];
  if (!DYNAMIC_SCRIPTS_AVAILABLE) {
    const permitted = [];
    for (const pattern of requestedPatterns) {
      try { if (await chrome.permissions.contains({ origins: [pattern] })) permitted.push(pattern); } catch {}
    }
    await setConfig({ sitePatterns: personalPatterns.filter(pattern => permitted.includes(pattern)), managedSitePatterns: organizationPatterns.filter(pattern => permitted.includes(pattern)) });
    return permitted;
  }
  try { await chrome.scripting.unregisterContentScripts({ ids: [CONTENT_SCRIPT_ID] }); } catch {}
  const permitted = [];
  for (const pattern of requestedPatterns) {
    try { if (await chrome.permissions.contains({ origins: [pattern] })) permitted.push(pattern); } catch {}
  }
  await setConfig({ sitePatterns: personalPatterns.filter(pattern => permitted.includes(pattern)), managedSitePatterns: organizationPatterns.filter(pattern => permitted.includes(pattern)) });
  if (permitted.length) {
    await chrome.scripting.registerContentScripts([{
      id: CONTENT_SCRIPT_ID,
      matches: permitted,
      js: ["shared/rule-engine.js", "content/content.js"],
      css: ["content/content.css"],
      allFrames: true,
      runAt: "document_idle",
      persistAcrossSessions: true
    }]);
  }
  return permitted;
}

async function notifyContentScripts(message) {
  const tabs = await chrome.tabs.query({});
  for (const tab of tabs) if (tab.id) chrome.tabs.sendMessage(tab.id, message).catch(() => {});
}

function eventPayload(memoId, domain, action, presentation = "sidepanel", anchorId = "") {
  return { memoId, ruleId: memoId, domain, action, presentation, anchorId };
}

async function postEvent(payload) {
  const event = { ...payload, deviceId: await getDeviceId() };
  try { await fetchJson("/api/events", { method: "POST", body: JSON.stringify(event) }); }
  catch {
    const { eventQueue = [] } = await chrome.storage.local.get("eventQueue");
    await chrome.storage.local.set({ eventQueue: [...eventQueue, event] });
  }
}

async function addActiveMatch(tabId, memo, domain) {
  const { activeMatches = {} } = await chrome.storage.local.get("activeMatches");
  const list = activeMatches[String(tabId)] || [];
  const existing = list.find(item => item.memoId === memo.id);
  const next = existing ? list.map(item => item.memoId === memo.id ? { ...item, matchedAt: Date.now(), domain, state: "new" } : item) : [...list, { memoId: memo.id, domain, matchedAt: Date.now(), state: "new" }];
  activeMatches[String(tabId)] = next.slice(-30);
  await chrome.storage.local.set({ activeMatches });
  await chrome.action.setBadgeBackgroundColor({ tabId, color: "#f0785d" });
  await chrome.action.setBadgeText({ tabId, text: String(next.filter(item => !["ignored", "confirmed"].includes(item.state)).length || "") });
}

async function processMatch(message, sender) {
  if (!sender.tab?.id || !message.memoId || !message.domain) return { accepted: false };
  const { bootstrap } = await getBootstrap();
  const memo = bootstrap.memos.find(item => item.id === message.memoId);
  if (!memo) return { accepted: false };
  if (memo.type === "operation" && memo.annotation?.template !== "strong" && (bootstrap.operationReceipts || []).some(item => item.memoId === memo.id)) return { accepted: false, reason: "acknowledged_today" };
  const key = `${memo.id}|${message.domain}`;
  const { cooldowns = {}, snoozes = {} } = await chrome.storage.local.get(["cooldowns", "snoozes"]);
  const now = Date.now();
  if (Number(snoozes[key] || 0) > now) return { accepted: false, reason: "snoozed" };
  const cooldownMs = Math.max(1, Number(memo.rule?.cooldownMinutes || 30)) * 60_000;
  const previous = cooldowns[key];
  const previousAt = typeof previous === "number" ? previous : Number(previous?.at || 0);
  const sameSignature = typeof previous === "number" || previous?.signature === message.signature;
  if (sameSignature && now - previousAt < cooldownMs) return { accepted: false, reason: "cooldown" };
  cooldowns[key] = { at: now, signature: String(message.signature || "") };
  await chrome.storage.local.set({ cooldowns });
  await addActiveMatch(sender.tab.id, memo, message.domain);
  postEvent(eventPayload(memo.id, message.domain, "triggered", memo.priority === "important" ? "system" : "inline"));
  if (memo.annotation?.template === "strong" && NOTIFICATIONS_AVAILABLE) {
    chrome.notifications.create(`memo:${sender.tab.id}:${memo.id}`, {
      type: "basic",
      iconUrl: chrome.runtime.getURL("assets/icon-128.png"),
      title: `页知 · ${memo.title}`,
      message: memo.body.replace(/[*#`]/g, "").slice(0, 160),
      priority: 1
    }).catch(() => {});
  }
  return { accepted: true, memo };
}

async function updateMatchState(tabId, memoId, state, domain) {
  const { activeMatches = {} } = await chrome.storage.local.get("activeMatches");
  const list = activeMatches[String(tabId)] || [];
  activeMatches[String(tabId)] = list.map(item => item.memoId === memoId ? { ...item, state } : item);
  await chrome.storage.local.set({ activeMatches });
  const remaining = activeMatches[String(tabId)].filter(item => !["ignored", "confirmed", "snoozed"].includes(item.state)).length;
  await chrome.action.setBadgeText({ tabId, text: remaining ? String(remaining) : "" });
  await postEvent(eventPayload(memoId, domain, state));
}

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  (async () => {
    switch (message.type) {
      case "GET_BOOTSTRAP": return sendResponse(await getBootstrap());
      case "REFRESH_BOOTSTRAP": return sendResponse(await refreshBootstrap());
      case "GET_CONFIG": return sendResponse({ config: await getConfig() });
      case "GET_MEMBER_SESSION": return sendResponse(await getMemberSession());
      case "BIND_INVITATION": return sendResponse(await bindInvitation(message.inviteCode || ""));
      case "UNBIND_MEMBER": return sendResponse(await unbindMember());
      case "GET_DEVICE_ID": return sendResponse({ deviceId: await getDeviceId() });
      case "GET_CAPABILITIES": {
        const stored = await chrome.storage.local.get(["versionInfo", "pendingExtensionVersion"]);
        return sendResponse({
          capabilities: {
            sidePanel: Boolean(chrome.sidePanel),
            notifications: NOTIFICATIONS_AVAILABLE,
            push: typeof PushManager !== "undefined",
            dynamicScripts: DYNAMIC_SCRIPTS_AVAILABLE,
            updateCheck: UPDATE_CHECK_AVAILABLE
          },
          currentVersion: chrome.runtime.getManifest().version,
          versionInfo: stored.versionInfo || null,
          pendingVersion: stored.pendingExtensionVersion || null
        });
      }
      case "SET_CONFIG": {
        const config = await setConfig(message.patch || {});
        const push = await registerPushSubscription().catch(error => ({ enabled: false, error: error.message }));
        return sendResponse({ config, push });
      }
      case "REGISTER_SITES": {
        const { bootstrap } = await chrome.storage.local.get("bootstrap");
        const managedPatterns = [...new Set((bootstrap?.pageGroups || []).flatMap(group => group.sitePatterns || []))];
        return sendResponse({ patterns: await registerSites(message.patterns || [], managedPatterns) });
      }
      case "GET_PENDING_STRATEGY_TESTS": return sendResponse(await fetchJson("/api/strategy-tests/pending"));
      case "REPORT_STRATEGY_TEST": {
        const result = await fetchJson(`/api/strategy-tests/${encodeURIComponent(message.requestId || "")}/result`, { method: "POST", body: JSON.stringify(message.result || {}) });
        return sendResponse({ ok: true, result });
      }
      case "GET_ANNOTATION_SESSION": return sendResponse(await fetchJson(`/api/annotation-sessions/${encodeURIComponent(message.code || "")}`));
      case "GET_SUPPLIER": return sendResponse(await fetchJson(`/api/suppliers/${encodeURIComponent(message.supplierId || "")}`));
      case "GET_MEMO_COMMENTS": return sendResponse(await fetchJson(`/api/memos/${encodeURIComponent(message.memoId || "")}/comments`));
      case "ADD_MEMO_COMMENT": return sendResponse(await fetchJson(`/api/memos/${encodeURIComponent(message.memoId || "")}/comments`, { method: "POST", body: JSON.stringify({ content: message.content || "" }) }));
      case "DELETE_MEMO_COMMENT": return sendResponse(await fetchJson(`/api/memo-comments/${encodeURIComponent(message.commentId || "")}`, { method: "DELETE" }));
      case "OPEN_SUPPLIER_IN_PAGE": {
        const tabId = message.tabId || sender.tab?.id;
        if (!tabId) return sendResponse({ ok: false, error: "missing_tab" });
        return sendResponse(await chrome.tabs.sendMessage(tabId, { type: "SHOW_SUPPLIER", supplierId: message.supplierId }).catch(() => ({ ok: false, error: "page_unavailable" })));
      }
      case "COMPLETE_ANNOTATION_SESSION": {
        const result = await fetchJson(`/api/admin/annotation-sessions/${encodeURIComponent(message.sessionId || "")}/complete`, { method: "POST", body: JSON.stringify({ code: message.code, anchor: message.anchor || {} }) });
        await refreshBootstrap();
        return sendResponse({ ok: true, result });
      }
      case "START_ANNOTATION_CODE": {
        const session = await fetchJson(`/api/annotation-sessions/${encodeURIComponent(message.code || "")}`);
        const tab = await chrome.tabs.create({ url: `${session.url}${session.url.includes("#") ? "&" : "#"}pagecue-annotation=${encodeURIComponent(message.code || "")}` });
        return sendResponse({ ok: true, session, tabId: tab.id });
      }
      case "MATCH": return sendResponse(await processMatch(message, sender));
      case "REARM_MATCH": {
        const key = `${message.memoId}|${message.domain}`;
        const { cooldowns = {} } = await chrome.storage.local.get("cooldowns");
        delete cooldowns[key];
        await chrome.storage.local.set({ cooldowns });
        return sendResponse({ ok: true });
      }
      case "OPEN_MEMO": {
        const tabId = sender.tab?.id || message.tabId;
        if (tabId) {
          await chrome.storage.local.set({ selectedMemoId: message.memoId });
          await postEvent(eventPayload(message.memoId, message.domain || "", "opened", "sidepanel"));
          await openPageCue(tabId);
        }
        return sendResponse({ ok: true });
      }
      case "OPEN_COMMENTS": {
        const tabId = sender.tab?.id || message.tabId;
        await chrome.storage.local.set({ selectedCommentMemoId: message.memoId });
        if (tabId) await openPageCue(tabId);
        return sendResponse({ ok: true });
      }
      case "CLEAR_SELECTED_COMMENT": {
        await chrome.storage.local.remove("selectedCommentMemoId");
        return sendResponse({ ok: true });
      }
      case "FOCUS_IN_PAGE": {
        const tabId = message.tabId || sender.tab?.id;
        if (!tabId) return sendResponse({ found: false, error: "missing_tab" });
        const result = await chrome.tabs.sendMessage(tabId, { type: "FOCUS_MATCH", memoId: message.memoId }).catch(() => ({ found: false, reason: "page_unavailable" }));
        return sendResponse(result || { found: false });
      }
      case "GET_CONTEXT": {
        const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
        const { activeMatches = {}, selectedMemoId = null, selectedCommentMemoId = null } = await chrome.storage.local.get(["activeMatches", "selectedMemoId", "selectedCommentMemoId"]);
        return sendResponse({ tab, matches: tab?.id ? activeMatches[String(tab.id)] || [] : [], selectedMemoId, selectedCommentMemoId });
      }
      case "MATCH_ACTION": {
        const tabId = message.tabId || sender.tab?.id;
        if (!tabId) return sendResponse({ error: "missing_tab" });
        const { bootstrap } = await getBootstrap();
        const memo = bootstrap.memos.find(item => item.id === message.memoId);
        if (message.action === "confirmed" && memo?.type === "operation") {
          let receipt;
          try { receipt = await fetchJson("/api/operation-receipts", { method: "POST", body: JSON.stringify({ memoId: memo.id }) }); }
          catch {
            receipt = { memoId: memo.id, localDate: new Intl.DateTimeFormat("en-CA", { timeZone: memo.dailyReminder?.timezone || "Asia/Shanghai" }).format(new Date()), action: "acknowledged", pending: true, acknowledgedAt: new Date().toISOString() };
            const { operationReceiptQueue = [] } = await chrome.storage.local.get("operationReceiptQueue");
            if (!operationReceiptQueue.some(item => item.memoId === memo.id)) operationReceiptQueue.push({ memoId: memo.id, queuedAt: Date.now() });
            await chrome.storage.local.set({ operationReceiptQueue });
          }
          bootstrap.operationReceipts = [...(bootstrap.operationReceipts || []).filter(item => item.memoId !== memo.id), receipt];
          await chrome.storage.local.set({ bootstrap });
        }
        if (message.action === "confirmed" && memo?.annotation?.template === "strong") {
          await postEvent(eventPayload(message.memoId, message.domain || "", "confirmed"));
          return sendResponse({ ok: true, persistent: true });
        }
        await updateMatchState(tabId, message.memoId, message.action, message.domain || "");
        if (message.action === "snoozed") {
          const { snoozes = {} } = await chrome.storage.local.get("snoozes");
          snoozes[`${message.memoId}|${message.domain}`] = Date.now() + Number(message.minutes || 60) * 60_000;
          await chrome.storage.local.set({ snoozes });
        }
        return sendResponse({ ok: true });
      }
      case "TRACK_EVENT": await postEvent(eventPayload(message.memoId, message.domain || "", message.action, message.presentation, message.anchorId)); return sendResponse({ ok: true });
      default: return sendResponse({ error: "unknown_message" });
    }
  })().catch(error => sendResponse({ error: error.message }));
  return true;
});

if (chrome.notifications?.onClicked) chrome.notifications.onClicked.addListener(async id => {
  const match = id.match(/^memo:(\d+):(.+)$/);
  if (!match) return;
  const tabId = Number(match[1]);
  await chrome.storage.local.set({ selectedMemoId: match[2] });
  await chrome.tabs.update(tabId, { active: true }).catch(() => {});
  await openPageCue(tabId).catch(() => {});
});

self.addEventListener("push", event => {
  event.waitUntil(handlePushEvent(event));
});

chrome.alarms.onAlarm.addListener(alarm => {
  if (alarm.name === SYNC_ALARM_NAME) checkServerVersion().catch(() => {});
});

if (chrome.runtime.onUpdateAvailable) chrome.runtime.onUpdateAvailable.addListener(details => {
  chrome.storage.local.set({ pendingExtensionVersion: details.version, updateAvailableAt: Date.now() })
    .finally(() => chrome.runtime.reload());
});

chrome.tabs.onRemoved.addListener(async tabId => {
  const { activeMatches = {} } = await chrome.storage.local.get("activeMatches");
  delete activeMatches[String(tabId)];
  await chrome.storage.local.set({ activeMatches });
});

chrome.runtime.onInstalled.addListener(async details => {
  let config = await getConfig();
  if (!config.apiBase || /^http:\/\/(127\.0\.0\.1|localhost):8787$/.test(config.apiBase)) {
    config = await setConfig({ apiBase: PRODUCTION_API_BASE });
  }
  await chrome.storage.local.set({ config });
  await registerSites(config.sitePatterns, config.managedSitePatterns);
  await clearPersonalAlarmSchedules();
  await chrome.storage.local.remove(["duePersonalAlarms", "selectedAlarmId"]);
  await ensureSyncAlarm();
  await refreshBootstrap().catch(() => {});
  await registerPushSubscription().catch(() => {});
});

chrome.runtime.onStartup.addListener(async () => {
  const config = await getConfig();
  await registerSites(config.sitePatterns, config.managedSitePatterns);
  await clearPersonalAlarmSchedules();
  await chrome.storage.local.remove(["duePersonalAlarms", "selectedAlarmId"]);
  await ensureSyncAlarm();
  await refreshBootstrap().catch(() => {});
  await registerPushSubscription().catch(() => {});
});

ensureSyncAlarm().catch(() => {});
