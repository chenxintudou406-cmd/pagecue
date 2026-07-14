const DEFAULT_CONFIG = {
  apiBase: "http://127.0.0.1:8787",
  userId: "user_demo",
  sitePatterns: []
};
const CONTENT_SCRIPT_ID = "context-companion-scanner";

chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true }).catch(() => {});

async function getConfig() {
  const { config } = await chrome.storage.local.get("config");
  return { ...DEFAULT_CONFIG, ...(config || {}) };
}

async function setConfig(patch) {
  const config = { ...(await getConfig()), ...patch };
  await chrome.storage.local.set({ config });
  return config;
}

async function fetchJson(path, options = {}) {
  const config = await getConfig();
  const response = await fetch(`${config.apiBase}${path}`, { headers: { "Content-Type": "application/json", "X-User-Id": config.userId }, ...options });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(payload.error || `服务请求失败 (${response.status})`);
  return payload;
}

async function refreshBootstrap() {
  try {
    const config = await getConfig();
    const bootstrap = await fetchJson(`/api/bootstrap?userId=${encodeURIComponent(config.userId)}`);
    await chrome.storage.local.set({ bootstrap, bootstrapUpdatedAt: Date.now(), lastSyncError: null });
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

async function registerSites(patterns) {
  try { await chrome.scripting.unregisterContentScripts({ ids: [CONTENT_SCRIPT_ID] }); } catch {}
  const permitted = [];
  for (const pattern of patterns) {
    try { if (await chrome.permissions.contains({ origins: [pattern] })) permitted.push(pattern); } catch {}
  }
  await setConfig({ sitePatterns: permitted });
  if (permitted.length) {
    await chrome.scripting.registerContentScripts([{
      id: CONTENT_SCRIPT_ID,
      matches: permitted,
      js: ["shared/rule-engine.js", "content/content.js"],
      css: ["content/content.css"],
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

function eventPayload(memoId, domain, action, presentation = "sidepanel") {
  return { memoId, ruleId: memoId, domain, action, presentation };
}

async function postEvent(payload) {
  const config = await getConfig();
  try { await fetchJson("/api/events", { method: "POST", body: JSON.stringify({ ...payload, userId: config.userId }) }); }
  catch {
    const { eventQueue = [] } = await chrome.storage.local.get("eventQueue");
    await chrome.storage.local.set({ eventQueue: [...eventQueue.slice(-99), { ...payload, userId: config.userId }] });
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
  if (memo.priority === "important") {
    chrome.notifications.create(`memo:${sender.tab.id}:${memo.id}`, {
      type: "basic",
      iconUrl: chrome.runtime.getURL("assets/icon-128.png"),
      title: `前衍提醒 · ${memo.title}`,
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
      case "SET_CONFIG": return sendResponse({ config: await setConfig(message.patch || {}) });
      case "REGISTER_SITES": return sendResponse({ patterns: await registerSites(message.patterns || []) });
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
          await chrome.sidePanel.open({ tabId });
        }
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
        const { activeMatches = {}, selectedMemoId = null } = await chrome.storage.local.get(["activeMatches", "selectedMemoId"]);
        return sendResponse({ tab, matches: tab?.id ? activeMatches[String(tab.id)] || [] : [], selectedMemoId });
      }
      case "MATCH_ACTION": {
        const tabId = message.tabId || sender.tab?.id;
        if (!tabId) return sendResponse({ error: "missing_tab" });
        await updateMatchState(tabId, message.memoId, message.action, message.domain || "");
        if (message.action === "snoozed") {
          const { snoozes = {} } = await chrome.storage.local.get("snoozes");
          snoozes[`${message.memoId}|${message.domain}`] = Date.now() + Number(message.minutes || 60) * 60_000;
          await chrome.storage.local.set({ snoozes });
        }
        return sendResponse({ ok: true });
      }
      case "TRACK_EVENT": await postEvent(eventPayload(message.memoId, message.domain || "", message.action, message.presentation)); return sendResponse({ ok: true });
      default: return sendResponse({ error: "unknown_message" });
    }
  })().catch(error => sendResponse({ error: error.message }));
  return true;
});

chrome.notifications.onClicked.addListener(async id => {
  const match = id.match(/^memo:(\d+):(.+)$/);
  if (!match) return;
  const tabId = Number(match[1]);
  await chrome.storage.local.set({ selectedMemoId: match[2] });
  await chrome.tabs.update(tabId, { active: true }).catch(() => {});
  await chrome.sidePanel.open({ tabId }).catch(() => {});
});

chrome.tabs.onRemoved.addListener(async tabId => {
  const { activeMatches = {} } = await chrome.storage.local.get("activeMatches");
  delete activeMatches[String(tabId)];
  await chrome.storage.local.set({ activeMatches });
});

chrome.runtime.onInstalled.addListener(async () => {
  const config = await getConfig();
  await chrome.storage.local.set({ config });
  await registerSites(config.sitePatterns);
  await refreshBootstrap().catch(() => {});
});

chrome.runtime.onStartup.addListener(async () => {
  const config = await getConfig();
  await registerSites(config.sitePatterns);
  await refreshBootstrap().catch(() => {});
});
