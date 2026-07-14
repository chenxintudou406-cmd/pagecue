const state = { bootstrap: null, context: null, config: null, tab: "alerts", scope: "all", query: "", editing: null };
const $ = selector => document.querySelector(selector); const $$ = selector => [...document.querySelectorAll(selector)];
const send = message => chrome.runtime.sendMessage(message);
function escapeHtml(value = "") { return String(value).replace(/[&<>'"]/g, char => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", "'": "&#39;", '"': "&quot;" }[char])); }
function markdown(value = "") { return escapeHtml(value).replace(/\*\*(.+?)\*\*/g, "<strong>$1</strong>").replace(/`(.+?)`/g, "<code>$1</code>").replace(/\n/g, "<br>"); }
function toast(message) { const el = $("#toast"); el.textContent = message; el.classList.add("show"); setTimeout(() => el.classList.remove("show"), 2100); }
function memoMatchesSearch(memo) { const haystack = `${memo.title} ${memo.body} ${(memo.tags || []).join(" ")}`.toLowerCase(); return haystack.includes(state.query.toLowerCase()); }
function linksHtml(memo) { return memo.links?.length ? `<div class="memo-links">${memo.links.map(link => `<a href="${escapeHtml(link.url)}" target="_blank" rel="noreferrer">${escapeHtml(link.label)} ↗</a>`).join("")}</div>` : ""; }
function tagsHtml(memo) { return memo.tags?.length ? `<div class="tags">${memo.tags.map(tag => `<span class="tag">${escapeHtml(tag)}</span>`).join("")}</div>` : ""; }
function triggerStrip(memo) {
  const rule = memo.rule || {};
  const tokens = [
    ...(rule.includeTerms || []).map(term => `包含：${term}`),
    ...(rule.excludeTerms || []).map(term => `排除：${term}`),
    ...(rule.sitePatterns || []).map(pattern => `站点：${pattern}`)
  ];
  return `<div class="trigger-strip" title="左右滑动查看完整规则">${(tokens.length ? tokens : ["所有已授权页面"]).map(token => `<span>${escapeHtml(token)}</span>`).join("")}</div>`;
}
function inlineMeta(memo, trailing = "") {
  return `<div class="meta-line"><div class="meta-scroll"><span class="scope">${memo.scope === "personal" ? "我的" : "组织"}</span>${(memo.tags || []).map(tag => `<span class="tag">${escapeHtml(tag)}</span>`).join("")}${memo.scope === "organization" ? `<span class="tag readonly">只读</span>` : ""}</div>${trailing}</div>`;
}

async function load(force = false) {
  const [bootstrapResult, contextResult, configResult] = await Promise.all([send({ type: force ? "REFRESH_BOOTSTRAP" : "GET_BOOTSTRAP" }), send({ type: "GET_CONTEXT" }), send({ type: "GET_CONFIG" })]);
  if (bootstrapResult.error) throw new Error(bootstrapResult.error);
  state.bootstrap = bootstrapResult.bootstrap; state.context = contextResult; state.config = configResult.config;
  $("#workspace-name").textContent = state.bootstrap.groups.map(item => item.name).join(" · ") || "个人工作区";
  $("#api-base").value = state.config.apiBase; $("#user-id").value = state.config.userId;
  const offline = Boolean(bootstrapResult.offline); $("#connection-dot").classList.toggle("error", offline); $("#connection-text").textContent = offline ? "离线缓存模式" : "组织内容已同步";
  render();
}

function render() { renderContext(); renderAlerts(); renderMemos(); renderTools(); renderSites(); }
function fillPersonalPageGroups(selected = "") {
  const groups = state.bootstrap?.pageGroups || [];
  const select = $("#personal-form [name=pageGroupId]");
  select.innerHTML = groups.length ? groups.map(group => `<option value="${group.id}">${escapeHtml(group.name)}</option>`).join("") : `<option value="">暂无页面组</option>`;
  select.value = selected || groups[0]?.id || "";
}
function togglePersonalPageScope() {
  const form = $("#personal-form");
  const scoped = form.elements.pageScope.value === "page_groups";
  $("[data-personal-page-group]").hidden = !scoped;
  form.elements.pageGroupId.disabled = !scoped;
}
function renderContext() {
  const tab = state.context?.tab;
  const count = currentAlerts().length;
  $("#page-context").classList.toggle("has-alerts", count > 0);
  $("#page-context").innerHTML = tab
    ? `<div class="signal-number">${count}</div><div class="signal-copy"><strong>${count ? "检测到相关提醒" : "页面检测正常"}</strong><span title="${escapeHtml(tab.url || "")}">${count ? `请查看下方 ${count} 条备忘` : escapeHtml(tab.title || tab.url || "当前页面")}</span></div>`
    : `<div class="signal-number">0</div><div class="signal-copy"><strong>没有可检测页面</strong><span>请打开普通网页后重试</span></div>`;
}

function currentAlerts() {
  const matches = state.context?.matches || [];
  return matches.map(match => ({ match, memo: state.bootstrap.memos.find(memo => memo.id === match.memoId) })).filter(item => item.memo && !["ignored", "confirmed", "snoozed"].includes(item.match.state) && memoMatchesSearch(item.memo));
}

function renderAlerts() {
  const alerts = currentAlerts(); $("#alert-count").textContent = alerts.length;
  $("#alert-list").innerHTML = alerts.length ? alerts.map(({ memo, match }) => `<article class="alert-card ${memo.priority === "important" ? "important" : ""}"><div class="alert-heading"><span class="scope">${memo.scope === "personal" ? "我的提醒" : "组织提醒"}</span><strong>${memo.priority === "important" ? "重要" : "已触发"}</strong></div><div class="match-proof"><b>命中</b><span>${escapeHtml(memo.rule?.includeTerms?.join("、") || "页面规则")}</span></div><h3>${escapeHtml(memo.title)}</h3><div class="memo-body alert-copy">${markdown(memo.body)}</div>${linksHtml(memo)}<div class="alert-actions"><button class="locate" data-locate-match="${memo.id}">定位关键词</button><button data-alert-action="snoozed" data-id="${memo.id}" data-domain="${escapeHtml(match.domain)}">稍后提醒</button><button class="confirm" data-alert-action="confirmed" data-id="${memo.id}" data-domain="${escapeHtml(match.domain)}">我知道了</button></div><div class="feedback"><button data-feedback="helpful" data-id="${memo.id}" data-domain="${escapeHtml(match.domain)}">有帮助</button><button data-feedback="unhelpful" data-id="${memo.id}" data-domain="${escapeHtml(match.domain)}">不相关</button></div></article>`).join("") : `<div class="empty"><b>当前没有提醒</b>命中规则后，这里会明确显示触发关键词和对应备忘。</div>`;
}

function renderMemos() {
  const memos = state.bootstrap.memos.filter(memo => (state.scope === "all" || memo.scope === state.scope) && memoMatchesSearch(memo)).sort((a,b) => (a.scope === "personal" ? -1 : 1) - (b.scope === "personal" ? -1 : 1));
  $("#memo-list").innerHTML = memos.length ? memos.map(memo => {
    const actions = memo.scope === "personal" ? `<div class="card-menu"><button class="mini-button" data-edit-personal="${memo.id}">编辑</button><button class="mini-button" data-delete-personal="${memo.id}">删除</button></div>` : "";
    const ruleLabel = `${memo.rule?.operator || "AND"} ${(memo.rule?.includeTerms || []).length} 条`;
    return `<article class="memo-card compact ${memo.priority === "important" ? "important" : ""}">${inlineMeta(memo, actions)}<div class="title-rule-line"><h3 title="${escapeHtml(memo.title)}">${escapeHtml(memo.title)}</h3><span>${escapeHtml(ruleLabel)}</span></div>${triggerStrip(memo)}<details class="compact-detail"><summary>查看内容</summary><div class="memo-body">${markdown(memo.body)}</div>${linksHtml(memo)}</details></article>`;
  }).join("") : `<div class="empty"><b>没有找到备忘</b>可以新建个人备忘，或调整搜索条件。</div>`;
}

function renderTools() {
  const tools = state.bootstrap.tools.filter(tool => `${tool.title} ${tool.description} ${tool.category}`.toLowerCase().includes(state.query.toLowerCase()));
  const groups = tools.reduce((result, item) => { const key = item.category || "常用"; (result[key] ||= []).push(item); return result; }, {});
  $("#tool-list").innerHTML = tools.length ? Object.entries(groups).map(([category, items]) => `<section class="tool-category"><h3>${escapeHtml(category.toUpperCase())}</h3>${items.map(tool => `<article class="tool-item"><span class="tool-icon">${escapeHtml(tool.icon || "↗")}</span><div><strong>${escapeHtml(tool.title)}</strong><small>${escapeHtml(tool.description || tool.url)}</small></div><div class="tool-actions"><button data-copy="${escapeHtml(tool.url)}" title="复制链接">⧉</button><a href="${escapeHtml(tool.url)}" target="_blank" rel="noreferrer" title="打开">↗</a></div></article>`).join("")}</section>`).join("") : `<div class="empty"><b>没有找到工具</b>组织管理员可在管理台统一发布工作资源。</div>`;
}

function renderSites() { const patterns = state.config?.sitePatterns || []; $("#site-list").innerHTML = patterns.length ? patterns.map(pattern => `<div class="site-item"><span title="${escapeHtml(pattern)}">${escapeHtml(pattern)}</span><button data-remove-site="${escapeHtml(pattern)}">移除</button></div>`).join("") : `<div class="empty">尚未授权任何站点</div>`; }
function switchTab(tab) { state.tab = tab; $$("nav button").forEach(el => el.classList.toggle("active", el.dataset.tab === tab)); $$(".tab").forEach(el => el.classList.toggle("active", el.id === `tab-${tab}`)); }

function openSettings(open) { $("#settings-panel").classList.toggle("open", open); $("#settings-panel").setAttribute("aria-hidden", String(!open)); }
async function grantPattern(pattern) {
  if (!/^https?:\/\//.test(pattern) || !pattern.endsWith("/*")) throw new Error("请输入以 http(s):// 开头、以 /* 结尾的站点模式");
  const granted = await chrome.permissions.request({ origins: [pattern] });
  if (!granted) throw new Error("用户未授予该站点权限");
  const patterns = [...new Set([...(state.config.sitePatterns || []), pattern])];
  const result = await send({ type: "REGISTER_SITES", patterns }); state.config.sitePatterns = result.patterns; renderSites(); toast("站点已授权，请刷新网页");
}

function openPersonal(id = null) {
  const form = $("#personal-form"); form.reset(); state.editing = id ? state.bootstrap.memos.find(memo => memo.id === id) : null; $("#personal-title").textContent = id ? "编辑个人备忘" : "新建个人备忘";
  fillPersonalPageGroups(state.editing?.rule?.pageGroupIds?.[0] || "");
  if (state.editing) { form.elements.id.value = state.editing.id; form.elements.title.value = state.editing.title; form.elements.body.value = state.editing.body; form.elements.pageScope.value = state.editing.rule?.pageScope || (state.editing.rule?.sitePatterns?.length ? "page_groups" : "global"); form.elements.includeTerms.value = state.editing.rule?.includeTerms?.join(", ") || ""; form.elements.tags.value = state.editing.tags?.join(", ") || ""; }
  togglePersonalPageScope();
  $("#personal-dialog").showModal();
}

async function directApi(path, options = {}) { const response = await fetch(`${state.config.apiBase}${path}`, { headers: { "Content-Type": "application/json", "X-User-Id": state.config.userId }, ...options }); const payload = await response.json().catch(() => ({})); if (!response.ok) throw new Error(payload.error || "保存失败"); return payload; }

$("#personal-form").addEventListener("submit", async event => {
  event.preventDefault(); const form = event.currentTarget; const data = new FormData(form); const id = data.get("id");
  const pageScope = data.get("pageScope");
  const pageGroupIds = pageScope === "page_groups" && data.get("pageGroupId") ? [data.get("pageGroupId")] : [];
  if (pageScope === "page_groups" && !pageGroupIds.length) return toast("请先在管理后台创建页面组");
  const payload = { ownerId: state.config.userId, title: data.get("title"), body: data.get("body"), tags: data.get("tags").split(/[,，]/).map(x => x.trim()).filter(Boolean), links: [], priority: "normal", rule: { pageScope, pageGroupIds, sitePatterns: [], includeTerms: data.get("includeTerms").split(/[,，]/).map(x => x.trim()).filter(Boolean), excludeTerms: [], operator: "AND", caseSensitive: false, useRegex: false, cooldownMinutes: 30 } };
  try { await directApi(`/api/personal-memos${id ? `/${id}?userId=${encodeURIComponent(state.config.userId)}` : ""}`, { method: id ? "PUT" : "POST", body: JSON.stringify(payload) }); $("#personal-dialog").close(); await load(true); toast("个人备忘已保存"); } catch (error) { toast(error.message); }
});

document.addEventListener("click", async event => {
  const tab = event.target.closest("[data-tab]"); if (tab) switchTab(tab.dataset.tab);
  const scope = event.target.closest("[data-scope]"); if (scope) { state.scope = scope.dataset.scope; $$("[data-scope]").forEach(el => el.classList.toggle("active", el === scope)); renderMemos(); }
  if (event.target.closest("#open-settings")) openSettings(true); if (event.target.closest("#close-settings")) openSettings(false);
  if (event.target.closest("#refresh-context") || event.target.closest("#footer-sync")) { try { await load(true); toast("内容已同步"); } catch (error) { toast(error.message); } }
  if (event.target.closest("#new-personal")) openPersonal(); const edit = event.target.closest("[data-edit-personal]"); if (edit) openPersonal(edit.dataset.editPersonal);
  const del = event.target.closest("[data-delete-personal]"); if (del && confirm("确认删除这条个人备忘？")) { try { await directApi(`/api/personal-memos/${del.dataset.deletePersonal}?userId=${encodeURIComponent(state.config.userId)}`, { method: "DELETE" }); await load(true); toast("个人备忘已删除"); } catch (error) { toast(error.message); } }
  if (event.target.closest("[data-close-dialog]")) $("#personal-dialog").close();
  const action = event.target.closest("[data-alert-action]"); if (action) { await send({ type: "MATCH_ACTION", tabId: state.context.tab.id, memoId: action.dataset.id, domain: action.dataset.domain, action: action.dataset.alertAction, minutes: 60 }); await load(); toast(action.dataset.alertAction === "confirmed" ? "已确认" : "将在 1 小时后再次提醒"); }
  const locate = event.target.closest("[data-locate-match]"); if (locate) {
    const result = await send({ type: "FOCUS_IN_PAGE", tabId: state.context.tab.id, memoId: locate.dataset.locateMatch });
    if (result?.found) toast(`已定位，共 ${result.count || 1} 处匹配`);
    else if (result?.reason === "no_keywords") toast("这条备忘没有设置定位关键词");
    else if (result?.reason === "page_unavailable") toast("当前页面未授权或尚未加载插件，请授权后刷新页面");
    else toast(`页面中未找到：${result?.terms?.join("、") || "对应关键词"}`);
  }
  const feedback = event.target.closest("[data-feedback]"); if (feedback) { await send({ type: "TRACK_EVENT", memoId: feedback.dataset.id, domain: feedback.dataset.domain, action: feedback.dataset.feedback, presentation: "sidepanel" }); toast("感谢反馈"); }
  const copy = event.target.closest("[data-copy]"); if (copy) { await navigator.clipboard.writeText(copy.dataset.copy); toast("链接已复制"); }
  const remove = event.target.closest("[data-remove-site]"); if (remove) { const pattern = remove.dataset.removeSite; await chrome.permissions.remove({ origins: [pattern] }); const patterns = state.config.sitePatterns.filter(item => item !== pattern); const result = await send({ type: "REGISTER_SITES", patterns }); state.config.sitePatterns = result.patterns; renderSites(); toast("站点授权已移除"); }
});

$("#save-connection").addEventListener("click", async () => { try { const result = await send({ type: "SET_CONFIG", patch: { apiBase: $("#api-base").value.replace(/\/$/, ""), userId: $("#user-id").value.trim() } }); state.config = result.config; await load(true); toast("连接设置已保存"); } catch (error) { toast(error.message); } });
$("#grant-site").addEventListener("click", async () => { try { await grantPattern($("#site-pattern").value.trim()); $("#site-pattern").value = ""; } catch (error) { toast(error.message); } });
$("#grant-current").addEventListener("click", async () => { try { const url = new URL(state.context.tab.url); if (!url.protocol.startsWith("http")) throw new Error("当前页面不支持授权"); await grantPattern(`${url.origin}/*`); } catch (error) { toast(error.message); } });
$("#global-search").addEventListener("input", event => { state.query = event.target.value; renderContext(); renderAlerts(); renderMemos(); renderTools(); });
document.addEventListener("keydown", event => { if (event.ctrlKey && event.key.toLowerCase() === "k") { event.preventDefault(); $("#global-search").focus(); } });
$("#personal-form [name=pageScope]").addEventListener("change", togglePersonalPageScope);

load().catch(error => { $("#connection-dot").classList.add("error"); $("#connection-text").textContent = "无法连接服务"; toast(error.message); });
