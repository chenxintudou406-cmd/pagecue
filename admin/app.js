const state = { data: null, view: "overview", editingMemo: null, editingMemoFolder: null, editingSupplier: null, editingTool: null, editingPageGroup: null, editingMember: null, editingGroup: null, selectedAccountId: null, selectedMemoIds: new Set(), strategyTestPoll: null, annotationSessionPoll: null };
const $ = selector => document.querySelector(selector);
const $$ = selector => [...document.querySelectorAll(selector)];
const API_BASE = location.protocol === "file:" ? "http://127.0.0.1:8787" : "";
document.body.classList.add("auth-locked");
document.body.insertAdjacentHTML("afterbegin", `
  <section id="admin-login" class="login-screen" aria-labelledby="login-title">
    <form id="admin-login-form" class="login-card">
      <img src="${adminAsset("pagecue-logo.png")}" alt="" />
      <div><span>页知 · PageCue</span><h1 id="login-title">管理员登录</h1><p>登录后才能发布组织提醒和查看成员反馈。</p></div>
      <label>管理员手机号<input name="phone" type="tel" inputmode="numeric" autocomplete="username" required /></label>
      <label>密码<input name="password" type="password" autocomplete="current-password" required /></label>
      <p id="login-error" class="login-error" role="alert" hidden></p>
      <button class="button primary" type="submit">安全登录</button>
    </form>
  </section>`);
const icons = {
  edit: `<svg viewBox="0 0 24 24" aria-hidden="true"><path d="m4 20 4.5-1 10-10a2.1 2.1 0 0 0-3-3l-10 10L4 20Zm10-12 3 3" /></svg>`,
  archive: `<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M5 8h14v12H5V8Zm-1-4h16v4H4V4Zm5 8h6" /></svg>`,
  trash: `<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 7h16M9 7V4h6v3m-9 0 1 13h10l1-13M10 11v5m4-5v5" /></svg>`,
  external: `<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M14 5h5v5M19 5l-8 8M18 13v6H5V6h6" /></svg>`
};

$("#page-group-form .modal-body").insertAdjacentHTML("beforeend", `
  <fieldset class="wide strategy-fields"><legend>内容识别策略</legend>
    <div class="form-grid">
      <label class="wide">匹配范围<select name="matchScope"><option value="page">整个页面（默认）</option><option value="module">同一内容模块</option><option value="row">列表同一行</option></select><small>普通成员无需配置。只有该页面组会使用模块或行内 AND。</small></label>
      <label class="wide" data-strategy-selector hidden>模块/行选择器 <em>必填</em><input name="strategySelector" placeholder="例如：.product-card、tbody tr 或 [role='row']" /><small>可以填写多个 CSS 选择器并用逗号分隔。</small></label>
      <label class="wide" data-strategy-selector hidden>排除选择器<input name="strategyExcludeSelector" placeholder="例如：thead tr、.summary-row" /><small>可排除表头、汇总行或无关模块。</small></label>
    </div>
  </fieldset>`);

async function api(path, options = {}) {
  const response = await fetch(`${API_BASE}${path}`, { ...options, credentials: "include", headers: { "Content-Type": "application/json", ...(options.headers || {}) } });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) {
    const error = new Error(payload.error || `请求失败 (${response.status})`);
    error.status = response.status;
    if (response.status === 401 && !path.endsWith("/auth/login")) showLogin();
    throw error;
  }
  return payload;
}

function showLogin(message = "") {
  document.body.classList.add("auth-locked");
  $("#admin-login").hidden = false;
  $("#login-error").hidden = !message;
  $("#login-error").textContent = message;
}

function showAdmin(session) {
  document.body.classList.remove("auth-locked");
  $("#admin-login").hidden = true;
  $(".admin-profile").innerHTML = `<span class="avatar">管</span><div><strong>管理员</strong><small>${escapeHtml(session.phone)}</small></div><button id="admin-logout" class="profile-logout" type="button">退出</button>`;
}

async function initializeAdmin() {
  try {
    const session = await api("/api/admin/auth/session");
    showAdmin(session);
    await load();
  } catch (error) {
    showLogin(error.status === 401 ? "" : error.message);
  }
}

function escapeHtml(value = "") {
  return String(value).replace(/[&<>'"]/g, char => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", "'": "&#39;", '"': "&quot;" }[char]));
}

function truncate(value, max = 100) { return value.length > max ? `${value.slice(0, max)}…` : value; }
function splitLines(value) { return value.split(/\r?\n/).map(item => item.trim()).filter(Boolean); }
function parseLinks(value) { return splitLines(value || "").map(line => { const parts = line.split("|"); const url = (parts.length > 1 ? parts.pop() : parts[0]).trim(); return { label: parts.join("|").trim() || url, url }; }).filter(link => /^https?:\/\//i.test(link.url)).slice(0, 20); }
function linksText(links = []) { return links.map(link => `${link.label} | ${link.url}`).join("\n"); }
function toast(message) { const el = $("#toast"); el.textContent = message; el.classList.add("show"); setTimeout(() => el.classList.remove("show"), 3200); }
function formatPercent(value) { return `${Math.round((value || 0) * 100)}%`; }
function annotationTemplateLabel(template) { return ({ light: "轻", standard: "中", medium: "中", strong: "重", heavy: "重" })[template] || "中"; }
function dateInputValue(date = new Date()) {
  const local = new Date(date.getTime() - date.getTimezoneOffset() * 60_000);
  return local.toISOString().slice(0, 10);
}
function localDateStartIso(value) {
  const fallback = dateInputValue();
  const [year, month, day] = String(value || fallback).split("-").map(Number);
  return new Date(year || new Date().getFullYear(), (month || 1) - 1, day || 1, 0, 0, 0, 0).toISOString();
}
function addDaysIso(startIso, days) {
  const date = new Date(startIso);
  date.setDate(date.getDate() + Number(days || 30));
  return date.toISOString();
}
function durationPresetFromDates(startsAt, expiresAt) {
  const days = Math.round((Date.parse(expiresAt || 0) - Date.parse(startsAt || 0)) / 86_400_000);
  return [7, 30, 90, 180, 365].reduce((best, current) => Math.abs(current - days) < Math.abs(best - days) ? current : best, 30);
}
function setSubmitting(form, loading, label = "保存中") {
  const buttons = [...form.querySelectorAll('[type="submit"]')];
  if (!buttons.length) return;
  if (loading) {
    buttons.forEach((button, index) => { button.dataset.label = button.textContent; button.textContent = index === buttons.length - 1 ? label : button.textContent; button.disabled = true; });
    form.setAttribute("aria-busy", "true");
  } else {
    buttons.forEach(button => { button.textContent = button.dataset.label || button.textContent; button.disabled = false; });
    form.removeAttribute("aria-busy");
  }
}

function renderLoading() {
  $("#sync-state").textContent = "正在同步";
  $("#metric-grid").innerHTML = Array.from({ length: 4 }, () => `<article class="metric skeleton"><span></span><strong></strong><small></small></article>`).join("");
  $("#active-memos").innerHTML = `<div class="loading-rows"><i></i><i></i><i></i></div>`;
  $("#group-overview").innerHTML = `<div class="loading-rows"><i></i><i></i></div>`;
  $("#funnel-overview").innerHTML = `<div class="loading-rows"><i></i><i></i><i></i></div>`;
  $("#website-funnel").innerHTML = `<div class="loading-rows"><i></i><i></i></div>`;
}

async function load() {
  renderLoading();
  try {
    state.data = await api("/api/admin/state");
    $("#sync-state").textContent = `已同步 · v${state.data.meta.version}`;
    $("#sync-state").classList.remove("error");
    renderAll();
  } catch (error) {
    $("#sync-state").textContent = "同步失败";
    $("#sync-state").classList.add("error");
    toast(error.message);
  }
}

function renderAll() {
  fillMemoFolderOptions(); renderOverview(); renderMemoFolders(); renderMemos(); renderMemoActivity(); renderSuppliers(); renderTools(); renderGroups(); renderMembers(); renderAccounts(); renderInvitations(); renderExcludedSites(); renderPageGroups(); decoratePageGroupStrategies(); fillGroupOptions(); fillPageGroupOptions(); fillSupplierOptions();
}

function renderOverview() {
  const { stats, memos, groups } = state.data;
  const now = Date.now();
  const activeMemos = memos.filter(item => item.scope === "organization" && item.status === "published" && (!item.startsAt || Date.parse(item.startsAt) <= now) && (!item.expiresAt || Date.parse(item.expiresAt) > now));
  $("#hero-rule-count").textContent = activeMemos.length;
  $("#hero-page-count").textContent = state.data.pageGroups.length;
  $("#push-summary").textContent = state.data.pushStats?.configured
    ? `${state.data.pushStats.activeSubscriptions} 台设备已订阅实时推送`
    : "Web Push 未配置，设备每 60 分钟自动同步";
  $("#push-extension-update").disabled = !state.data.pushStats?.configured || !state.data.pushStats?.activeSubscriptions;
  $("#push-extension-update").textContent = state.data.pushStats?.configured ? "通知检查新版本" : "等待实时推送配置";
  const metrics = [
    ["规则命中", stats.matched, "只记录业务域名"],
    ["提醒展开", stats.expanded, `${stats.highlight_opened + stats.popup_shown} 次展示后互动`],
    ["赞 / 踩", `${stats.feedback_up} / ${stats.feedback_down}`, "成员可在卡片直接反馈"],
    ["生效内容", activeMemos.length, "已到期内容仍保留历史"],
    ["实时推送设备", state.data.pushStats?.activeSubscriptions || 0, state.data.pushStats?.configured ? "Web Push 已启用" : "每 60 分钟兜底同步"]
  ];
  $("#metric-grid").innerHTML = metrics.map(([label, value, detail]) => `<article class="metric"><span>${label}</span><strong>${value}</strong><small>${detail}</small></article>`).join("");
  const active = activeMemos.slice(0, 4);
  $("#active-memos").innerHTML = active.length ? active.map(item => `<div class="compact-item"><i class="status-dot"></i><div><strong>${escapeHtml(item.title)}</strong><small>${item.type === "operation" ? "操作" : "知识"} · ${item.rule.includeTerms.length} 个关键词 · ${pageScopeLabel(item.rule)}</small></div><span class="badge">${annotationTemplateLabel(item.annotation?.template)}</span></div>`).join("") : `<div class="empty">还没有已发布提醒</div>`;
  const max = Math.max(...groups.map(group => group.memberCount), 1);
  $("#group-overview").innerHTML = groups.map(group => `<div class="group-row"><div class="group-label"><span>${escapeHtml(group.name)}</span><b>${group.memberCount} 人</b></div><div class="bar"><i style="width:${Math.max(12, group.memberCount / max * 100)}%"></i></div></div>`).join("");
  renderFunnels();
}

function funnelValue(funnel, action) {
  return funnel?.actions?.[action] || { events: 0, members: 0 };
}

function renderFunnels() {
  const funnels = state.data?.funnels || {};
  const overall = funnels.overall || {};
  const light = funnels.light || {};
  const mediumHeavy = funnels.mediumHeavy || {};
  const published = funnelValue(overall, "published");
  const matched = funnelValue(overall, "matched");
  const expanded = funnelValue(overall, "expanded");
  const interaction = overall.anyInteraction || { events: 0, members: 0 };
  const rows = [
    ["轻提醒", funnelValue(light, "highlight_shown"), funnelValue(light, "highlight_opened"), light.anyInteraction || { events: 0, members: 0 }],
    ["中/重提醒", funnelValue(mediumHeavy, "popup_shown"), funnelValue(mediumHeavy, "expanded"), mediumHeavy.anyInteraction || { events: 0, members: 0 }]
  ];
  const branches = [
    ["打开链接", "link_opened"],
    ["查看评论", "comment_opened"],
    ["发表评论", "comment_submitted"],
    ["操作完成", "operation_completed"],
    ["赞", "feedback_up"],
    ["踩", "feedback_down"]
  ];
  $("#funnel-overview").innerHTML = `<div class="funnel-row overall"><strong>总路径</strong><span><b>${published.events}</b><small>发布设置</small></span><i>→</i><span><b>${matched.events}</b><small>命中提醒</small></span><i>→</i><span><b>${expanded.events}</b><small>点击展开</small></span><i>→</i><span><b>${interaction.events}</b><small>操作互动</small></span></div>${rows.map(([label, shown, opened, interacted]) => `<div class="funnel-row"><strong>${label}</strong><span><b>${shown.members}</b><small>展示成员</small></span><i>→</i><span><b>${opened.members}</b><small>展开成员</small></span><i>→</i><span><b>${interacted.members}</b><small>互动成员</small></span><em>${shown.members ? Math.round(interacted.members / shown.members * 100) : 0}%</em></div>`).join("")}<div class="interaction-branches">${branches.map(([label, action]) => { const value = funnelValue(overall, action); return `<span><small>${label}</small><b>${value.events}</b><em>${value.members} 人</em></span>`; }).join("")}</div>`;
  const websites = funnels.websites || [];
  $("#website-funnel").innerHTML = websites.length ? websites.slice(0, 8).map(item => {
    const matched = funnelValue(item, "matched");
    const interaction = item.anyInteraction || { events: 0, members: 0 };
    return `<div class="website-funnel-row"><div><strong>${escapeHtml(item.pageBucket)}</strong><small>${matched.events} 次命中 · ${matched.members} 人</small></div><b>${matched.members ? Math.round(interaction.members / matched.members * 100) : 0}%<small>互动率</small></b></div>`;
  }).join("") : `<div class="empty">还没有网站互动数据</div>`;
}

function activeMemoFolders() {
  return [...(state.data?.memoFolders || [])].filter(folder => folder.status !== "archived").sort((a, b) => Number(a.sortOrder || 0) - Number(b.sortOrder || 0) || String(a.name).localeCompare(String(b.name), "zh-CN"));
}

function memoFolderName(folderId) {
  return activeMemoFolders().find(folder => folder.id === folderId)?.name || "未分组";
}

function memoFolderSelectOptions(selected = "") {
  return `<option value="">未分组</option>${activeMemoFolders().filter(folder => folder.scope !== "personal").map(folder => `<option value="${escapeHtml(folder.id)}" ${folder.id === selected ? "selected" : ""}>${escapeHtml(folder.name)}</option>`).join("")}`;
}

function memoFolderFilterOptions(scope = "organization", selected = "all") {
  const folders = activeMemoFolders().filter(folder => scope === "all" || (scope === "personal" ? folder.scope === "personal" : folder.scope !== "personal"));
  return `<option value="all">全部文件夹</option><option value="">未分组</option>${folders.map(folder => `<option value="${escapeHtml(folder.id)}" ${folder.id === selected ? "selected" : ""}>${escapeHtml(folder.name)}</option>`).join("")}`;
}

function refreshMemoFolderFilter(selected = null) {
  const filter = $("#memo-folder-filter");
  if (!filter) return;
  const scope = $("#memo-scope")?.value || "organization";
  const previous = selected === null ? (filter.value || "all") : selected;
  filter.innerHTML = memoFolderFilterOptions(scope, previous);
  filter.value = [...filter.options].some(option => option.value === previous) ? previous : "all";
}

function renderMemoFolders() {
  if (!state.data) return;
  const folders = activeMemoFolders();
  const managedMemos = (state.data.memos || []).filter(memo => !memo.systemGeneratedSupplier);
  const counts = new Map();
  for (const memo of managedMemos) {
    counts.set(memo.folderId || "", (counts.get(memo.folderId || "") || 0) + 1);
  }
  $("#memo-folder-summary").innerHTML = [
    ["文件夹", folders.length, "可继续新增"],
    ["已归类", managedMemos.filter(memo => memo.folderId).length, "条个人或组织提醒"],
    ["未分组", counts.get("") || 0, "条待整理"]
  ].map(([label, value, detail]) => `<article><span>${label}</span><strong>${value}</strong><small>${detail}</small></article>`).join("");
  $("#memo-folder-list").innerHTML = [
    { id: "all", name: "全部组织提醒", description: "查看所有管理员发布的组织提醒", system: true, count: managedMemos.filter(memo => memo.scope === "organization").length },
    { id: "", name: "未分组", description: "还没有归入文件夹的组织提醒", system: true, sortOrder: -1 },
    ...folders
  ].map(folder => `<article class="memo-folder-card ${folder.system || folder.systemManaged ? "system" : ""}"><button class="memo-folder-open" type="button" data-open-memo-folder="${escapeHtml(folder.id)}" data-memo-scope="${folder.scope === "personal" ? "personal" : "organization"}"><span class="folder-mark" aria-hidden="true"><svg viewBox="0 0 24 24"><path d="M3 7h7l2 2h9v10H3V7Z" /></svg></span><span class="folder-copy"><strong>${escapeHtml(folder.name)}</strong><small>${escapeHtml(folder.description || "暂无说明")}</small><b>${folder.count ?? counts.get(folder.id) ?? 0} 条提醒${folder.systemManaged ? " · 自动归类" : ""}</b></span><span class="folder-enter">查看提醒 →</span></button>${folder.system || folder.systemManaged ? "" : `<div class="card-actions"><button class="icon-button" title="编辑" aria-label="编辑 ${escapeHtml(folder.name)}" data-edit-memo-folder="${escapeHtml(folder.id)}">${icons.edit}</button><button class="icon-button danger" title="删除" aria-label="删除 ${escapeHtml(folder.name)}" data-delete-memo-folder="${escapeHtml(folder.id)}">${icons.trash}</button></div>`}</article>`).join("");
}

function fillMemoFolderOptions(selected = "") {
  if (!state.data) return;
  const folders = activeMemoFolders();
  const options = memoFolderSelectOptions(selected);
  const memoSelect = $("#memo-form [name=folderId]");
  if (memoSelect) { memoSelect.innerHTML = options; memoSelect.value = selected || ""; }
  refreshMemoFolderFilter();
  const bulkFolder = $("#memo-bulk-folder");
  if (bulkFolder) bulkFolder.innerHTML = `<option value="">移动到未分组</option>${folders.filter(folder => folder.scope !== "personal").map(folder => `<option value="${escapeHtml(folder.id)}">移动到 ${escapeHtml(folder.name)}</option>`).join("")}`;
}

function memoStatusMatches(item, status) {
  const expired = Boolean(item.expiresAt && Date.parse(item.expiresAt) <= Date.now());
  if (status === "all") return true;
  if (status === "archived") return item.status === "archived";
  if (status === "expired") return item.status !== "archived" && expired;
  return item.status === status && !expired;
}

function filteredMemos() {
  if (!state.data) return;
  const query = ($("#memo-search").value || "").toLowerCase();
  const status = $("#memo-status").value;
  const type = $("#memo-type").value;
  const scope = $("#memo-scope")?.value || "organization";
  const folder = $("#memo-folder-filter")?.value ?? "all";
  return state.data.memos.filter(item => (scope === "all" || item.scope === scope) && (type === "all" || item.type === type) && memoStatusMatches(item, status) && (folder === "all" || (item.folderId || "") === folder) && `${item.title} ${item.body} ${(item.tags || []).join(" ")} ${memoFolderName(item.folderId)}`.toLowerCase().includes(query));
}

function updateMemoBulkBar(memos) {
  const bar = $("#memo-bulk-bar");
  const selected = (state.data?.memos || []).filter(item => state.selectedMemoIds.has(item.id));
  const visibleIds = memos.map(item => item.id);
  const selectedVisible = visibleIds.filter(id => state.selectedMemoIds.has(id));
  const selectAll = $("#memo-select-all");
  bar.hidden = false;
  selectAll.checked = Boolean(visibleIds.length && selectedVisible.length === visibleIds.length);
  selectAll.indeterminate = Boolean(selectedVisible.length && selectedVisible.length < visibleIds.length);
  $("#memo-selected-count").textContent = `已选 ${selected.length} 条`;
  const hasPersonal = selected.some(item => item.scope === "personal");
  const moveButton = $("#memo-bulk-move");
  const moveFolder = $("#memo-bulk-folder");
  moveButton.disabled = !selected.length || hasPersonal;
  moveFolder.disabled = !selected.length || hasPersonal;
  moveButton.title = hasPersonal ? "个人提醒由系统自动归类，不能移动到组织文件夹" : "";
  $("#memo-bulk-archive").disabled = !selected.some(item => item.status !== "archived");
  $("#memo-bulk-clear").disabled = !selected.length;
}

function clearMemoSelection(render = true) {
  state.selectedMemoIds.clear();
  if (render) renderMemos();
}

function renderMemos() {
  if (!state.data) return;
  const memos = filteredMemos();
  const folder = $("#memo-folder-filter")?.value ?? "all";
  const scope = $("#memo-scope")?.value || "organization";
  const scopeLabel = scope === "personal" ? "全部个人提醒" : scope === "all" ? "全部提醒" : "全部组织提醒";
  $("#memo-folder-current").textContent = folder === "all" ? scopeLabel : memoFolderName(folder);
  $("#memo-folder-current-count").textContent = `${memos.length} 条`;
  $("#memo-list").innerHTML = memos.length ? memos.map(item => {
    const personal = item.scope === "personal";
    const selected = state.selectedMemoIds.has(item.id);
    const isExpired = Boolean(item.expiresAt && Date.parse(item.expiresAt) <= Date.now());
    const ownerName = state.data.users.find(user => user.id === item.ownerId)?.name || item.ownerId || "未知成员";
    const audienceNames = personal
      ? `个人 · ${ownerName}`
      : item.audienceType === "members"
      ? (item.targetUserIds || []).map(id => state.data.users.find(user => user.id === id)?.name || id).join("、")
      : item.audienceType === "groups"
        ? (item.targetGroupIds || []).map(id => state.data.groups.find(group => group.id === id)?.name || id).join("、")
        : "全体成员";
    const legacyArchived = item.status === "archived";
    const editAction = personal || legacyArchived ? "" : `<button class="icon-button" title="编辑" aria-label="编辑 ${escapeHtml(item.title)}" data-edit-memo="${item.id}">${icons.edit}</button>`;
    const supplier = (item.entityRefs || []).find(ref => ref.type === "supplier");
    const lifecycle = item.status === "archived" ? "已下架" : isExpired ? "已到期" : item.status === "published" ? "已发布" : "草稿";
    const managementActions = personal
      ? `<span class="pill">成员个人内容 · 只读</span>`
      : `<label class="quick-folder-move"><span>移动到</span><select data-move-memo="${escapeHtml(item.id)}" aria-label="移动 ${escapeHtml(item.title)} 到文件夹">${memoFolderSelectOptions(item.folderId || "")}</select></label>${editAction}<button class="icon-button danger" title="删除" aria-label="删除 ${escapeHtml(item.title)}" data-delete-memo="${item.id}">${icons.trash}</button>`;
    return `<article class="content-card memo-content-card ${selected ? "selected" : ""}"><label class="memo-row-select" aria-label="选择 ${escapeHtml(item.title)}"><input type="checkbox" data-select-memo="${escapeHtml(item.id)}" ${selected ? "checked" : ""} /></label><div><h3>${escapeHtml(item.title)}</h3><p>${escapeHtml(truncate(item.body.replace(/[*#`]/g, ""), 150))}</p><div class="content-meta"><span class="pill">${personal ? "个人提醒" : "组织提醒"}</span><span class="pill">${escapeHtml(memoFolderName(item.folderId))}</span><span class="pill ${isExpired ? "important" : ""}">${lifecycle}</span><span class="pill">${item.triggerMode === "broadcast" ? "强提醒广播" : "页面匹配"}</span><span class="pill ${item.annotation?.template === "strong" ? "important" : ""}">${annotationTemplateLabel(item.annotation?.template)}</span>${supplier ? `<span class="pill supplier-pill">供应商 · ${escapeHtml(supplier.displayName || supplier.id)}</span>` : ""}<span class="pill">${item.annotation?.anchors?.length || 0} 个元素锚点</span><span class="pill">${item.triggerMode === "broadcast" ? "不依赖页面" : escapeHtml(pageScopeLabel(item.rule))}</span><span class="pill">${escapeHtml(audienceNames)}</span><span class="pill">${escapeHtml((item.rule?.includeTerms || []).join(" / ") || "无关键词")}</span></div></div><div class="card-actions memo-card-actions">${managementActions}</div></article>`;
  }).join("") : `<div class="empty">没有符合条件的提醒</div>`;
  updateMemoBulkBar(memos);
}

function supplierEvaluationPreview(supplier) {
  return supplier.evaluations?.shortTerm?.[0]?.content || supplier.evaluations?.longTerm?.[0]?.content || "暂无评价";
}

function renderSuppliers() {
  if (!state.data) return;
  const query = String($("#supplier-search")?.value || "").trim().toLowerCase();
  const suppliers = (state.data.suppliers || []).filter(item => item.status !== "archived" && [item.companyName, item.customerId, item.contact?.name, ...(item.matchTerms || []), ...(item.advantageProducts || []).flatMap(product => [product.name, product.cas])].join(" ").toLowerCase().includes(query));
  $("#supplier-list").innerHTML = suppliers.length ? suppliers.map(item => `<article class="supplier-admin-card"><div class="supplier-admin-head"><div><span>${escapeHtml(item.customerId)}</span><h3>${escapeHtml(item.companyName)}</h3><p>${escapeHtml(item.contact?.name || "未填写联系人")}${item.contact?.title ? ` · ${escapeHtml(item.contact.title)}` : ""}</p></div><div class="card-actions"><button class="icon-button" aria-label="编辑 ${escapeHtml(item.companyName)}" data-edit-supplier="${item.id}">${icons.edit}</button><button class="icon-button danger" aria-label="删除 ${escapeHtml(item.companyName)}" data-delete-supplier="${item.id}">${icons.trash}</button></div></div><div class="supplier-admin-metrics"><span><b>${Number(item.metrics?.productPercentile || 0)}%</b>产品数排序</span><span><b>${Number(item.metrics?.orderPercentile || 0)}%</b>订单数排序</span><span><b>${Number(item.metrics?.closeRate || 0)}%</b>成交率</span><span><b>${Number(item.metrics?.quoteRate || 0)}%</b>报价率</span></div><p class="supplier-admin-evaluation">${escapeHtml(truncate(supplierEvaluationPreview(item), 110))}</p><div class="content-meta"><span class="pill">匹配：${escapeHtml((item.matchTerms || []).join(" / ") || "未设置")}</span><span class="pill">${(item.advantageProducts || []).length} 个优势产品</span><span class="pill">更新于 ${formatDateTime(item.updatedAt)}</span></div></article>`).join("") : `<div class="empty">还没有供应商资料。新建后即可与组织提醒关联。</div>`;
}

function feedbackLabel(action) {
  return ({ helpful: "有帮助", unhelpful: "不相关", feedback_up: "赞", feedback_down: "踩", confirmed: "已确认", operation_completed: "操作已完成", link_opened: "打开链接", link_copied: "复制链接", comment_opened: "查看评论", comment_submitted: "发表评论", ignored: "已忽略", snoozed: "稍后提醒" })[action] || action;
}

function formatDateTime(value) {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? "时间未知" : date.toLocaleString("zh-CN", { hour12: false });
}

function renderMemoActivity() {
  const activities = [...(state.data.memoActivity || [])].sort((a, b) => Date.parse(b.createdAt || 0) - Date.parse(a.createdAt || 0));
  $("#memo-activity-list").innerHTML = activities.length ? activities.map(item => {
    const feedback = item.recentFeedback || [];
    const comments = item.comments || [];
    const feedbackRows = feedback.length
      ? feedback.map(event => `<li><span>${escapeHtml(event.userName)}${event.deviceId ? ` · 设备 ${escapeHtml(event.deviceId.slice(-6))}` : ""}</span><b>${escapeHtml(feedbackLabel(event.action))}</b><small>${escapeHtml(event.domain || "未知页面")} · ${formatDateTime(event.createdAt)}</small></li>`).join("")
      : `<li class="activity-empty">暂无成员反馈</li>`;
    const commentRows = comments.length ? comments.map(comment => `<li class="activity-comment"><span>${escapeHtml(comment.userName)}<small>${formatDateTime(comment.createdAt)}</small></span><p>${escapeHtml(comment.content)}</p><button class="button ghost" type="button" data-admin-delete-comment="${escapeHtml(comment.id)}">删除</button></li>`).join("") : `<li class="activity-empty">暂无成员评论</li>`;
    return `<article class="activity-card"><div class="activity-head"><div><span class="pill">${item.scope === "personal" ? "个人提醒" : "组织提醒"}</span><h3>${escapeHtml(item.title)}</h3><p>由 ${escapeHtml(item.submittedByNameSnapshot || item.createdByName)}${item.createdFromDeviceId ? ` · 设备 ${escapeHtml(item.createdFromDeviceId.slice(-6))}` : ""} 提交 · ${formatDateTime(item.createdAt)}</p></div><div class="activity-stats"><span><b>${item.stats.matched}</b>命中</span><span><b>${item.stats.expanded}</b>展开</span><span><b>${item.stats.operation_completed}</b>完成</span><span><b>${comments.length}</b>评论</span><span><b>${item.stats.feedback_up}</b>赞</span><span><b>${item.stats.feedback_down}</b>踩</span></div></div><details><summary>查看 ${comments.length} 条评论</summary><ul>${commentRows}</ul></details><details><summary>查看 ${feedback.length} 条反馈明细</summary><ul>${feedbackRows}</ul></details></article>`;
  }).join("") : `<div class="empty">还没有提醒创建或成员反馈记录</div>`;
}

function renderTools() {
  const tools = state.data.tools.filter(item => item.scope === "organization" && item.status !== "archived").sort((a,b) => a.sortOrder - b.sortOrder);
  $("#tool-list").innerHTML = tools.length ? tools.map(item => `<article class="tool-card"><div class="tool-icon">${escapeHtml(item.icon)}</div><h3>${escapeHtml(item.title)}</h3><p>${escapeHtml(item.description || "暂无简介")}</p><div class="content-meta"><span class="pill">${escapeHtml(item.category)}</span><span class="pill">${item.status === "published" ? "已发布" : "草稿"}</span></div><div class="tool-foot"><a href="${escapeHtml(item.url)}" target="_blank" rel="noreferrer">打开链接 ${icons.external}</a><div class="card-actions"><button class="icon-button" aria-label="编辑 ${escapeHtml(item.title)}" data-edit-tool="${item.id}">${icons.edit}</button><button class="icon-button danger" aria-label="撤回 ${escapeHtml(item.title)}" data-delete-tool="${item.id}">${icons.archive}</button></div></div></article>`).join("") : `<div class="empty">还没有团队工具链接</div>`;
}

function renderGroups() {
  $("#group-list").innerHTML = state.data.groups.length ? state.data.groups.map(group => `<article class="group-card"><div class="group-card-head"><span class="member-count">${group.memberCount}</span><button class="icon-button" type="button" aria-label="编辑 ${escapeHtml(group.name)}" data-edit-group="${escapeHtml(group.id)}">${icons.edit}</button></div><h3>${escapeHtml(group.name)}</h3><p>${escapeHtml(group.description || "暂无分组说明")}</p><div class="content-meta">${group.canPublishOrganizationMemos ? `<span class="pill">可发布全员提醒</span>` : `<span class="pill">仅个人提醒</span>`}</div><small>已投放 ${state.data.memos.filter(item => item.targetGroupIds.includes(group.id) && item.status === "published").length} 条组织提醒，${state.data.tools.filter(item => item.targetGroupIds.includes(group.id) && item.status === "published").length} 个工具链接。</small></article>`).join("") : `<div class="empty">还没有成员分组</div>`;
}

function renderMembers() {
  const users = (state.data.users || []).filter(user => user.role !== "admin");
  $("#member-list").innerHTML = users.length ? users.map(user => {
    const groups = (user.groupIds || []).map(id => state.data.groups.find(group => group.id === id)?.name || id).join("、") || "未分组";
    const devices = (state.data.deviceBindings || []).filter(item => item.userId === user.id && item.status === "active");
    return `<article class="content-card"><div><h3>${escapeHtml(user.name)}</h3><p>${escapeHtml(groups)} · ${user.status === "disabled" ? "已停用" : `${devices.length} 台已绑定设备`}</p><div class="content-meta"><button class="button secondary" data-invite-member="${user.id}">生成邀请码</button>${devices.map(device => `<button class="button ghost" data-revoke-device="${device.id}">撤销 ${escapeHtml(device.deviceId.slice(-6))}</button>`).join("")}</div></div><div class="card-actions"><button class="icon-button" data-edit-member="${user.id}">${icons.edit}</button></div></article>`;
  }).join("") : `<div class="empty">还没有普通成员。创建成员后再生成邀请码。</div>`;
}

function accountBindings(userId) {
  return (state.data.deviceBindings || []).filter(item => item.userId === userId).sort((a, b) => Date.parse(b.createdAt || 0) - Date.parse(a.createdAt || 0));
}

function latestAccountLogin(userId) {
  return accountBindings(userId).map(item => item.lastLoginAt).filter(Boolean).sort((a, b) => Date.parse(b) - Date.parse(a))[0] || null;
}

function shortBindingNumber(deviceId = "") {
  const value = String(deviceId);
  return value.length > 14 ? `…${value.slice(-12)}` : value || "未记录";
}

function accountTimeline(userId) {
  const events = (state.data.accountEvents || []).filter(item => item.userId === userId).map(item => ({ ...item }));
  for (const binding of accountBindings(userId)) {
    if (!events.some(item => item.type === "device_bound" && item.bindingId === binding.id)) events.push({ id: `legacy-bound-${binding.id}`, type: "device_bound", userId, bindingId: binding.id, deviceId: binding.deviceId, browser: binding.browser, extensionVersion: binding.extensionVersion, createdAt: binding.createdAt });
    if (binding.revokedAt && !events.some(item => item.type === "device_revoked" && item.bindingId === binding.id)) events.push({ id: `legacy-revoked-${binding.id}`, type: "device_revoked", userId, bindingId: binding.id, deviceId: binding.deviceId, browser: binding.browser, extensionVersion: binding.extensionVersion, createdAt: binding.revokedAt });
  }
  return events.sort((a, b) => Date.parse(b.createdAt || 0) - Date.parse(a.createdAt || 0));
}

function accountEventLabel(type) {
  return ({ account_created: "创建成员账号", account_updated: "更新姓名或组别", invitation_created: "生成绑定邀请码", invitation_deleted: "删除邀请码", device_bound: "设备完成绑定", member_login: "成员账号登录", device_revoked: "撤销设备绑定" })[type] || type;
}

function renderAccounts() {
  if (!state.data) return;
  const users = (state.data.users || []).filter(user => user.role !== "admin");
  const activeBindings = (state.data.deviceBindings || []).filter(item => item.status === "active");
  const sevenDaysAgo = Date.now() - 7 * 24 * 60 * 60_000;
  const recentUsers = new Set(activeBindings.filter(item => item.lastLoginAt && Date.parse(item.lastLoginAt) >= sevenDaysAgo).map(item => item.userId));
  $("#account-summary").innerHTML = [
    ["成员账号", users.length, "不含管理员"],
    ["有效绑定", activeBindings.length, `${new Set(activeBindings.map(item => item.userId)).size} 名成员已绑定`],
    ["近 7 天登录", recentUsers.size, "按成员去重"]
  ].map(([label, value, detail]) => `<article><span>${label}</span><strong>${value}</strong><small>${detail}</small></article>`).join("");

  const groupSelect = $("#account-group-filter");
  const selectedGroup = groupSelect.value || "all";
  groupSelect.innerHTML = `<option value="all">全部成员组</option>${state.data.groups.map(group => `<option value="${escapeHtml(group.id)}">${escapeHtml(group.name)}</option>`).join("")}`;
  groupSelect.value = [...groupSelect.options].some(option => option.value === selectedGroup) ? selectedGroup : "all";

  const query = String($("#account-search").value || "").trim().toLowerCase();
  const status = $("#account-status-filter").value;
  const groupId = groupSelect.value;
  const filtered = users.filter(user => {
    const bindings = accountBindings(user.id);
    const active = bindings.filter(item => item.status === "active");
    const groupNames = (user.groupIds || []).map(id => state.data.groups.find(group => group.id === id)?.name || id);
    const haystack = [user.name, user.id, ...groupNames, ...bindings.map(item => item.deviceId)].join(" ").toLowerCase();
    const matchesStatus = status === "all" || (status === "disabled" ? user.status === "disabled" : status === "bound" ? user.status !== "disabled" && active.length > 0 : user.status !== "disabled" && active.length === 0);
    return (!query || haystack.includes(query)) && (groupId === "all" || user.groupIds.includes(groupId)) && matchesStatus;
  });

  $("#account-list").innerHTML = filtered.length ? filtered.map(user => {
    const bindings = accountBindings(user.id);
    const active = bindings.filter(item => item.status === "active");
    const groupNames = (user.groupIds || []).map(id => state.data.groups.find(group => group.id === id)?.name || id);
    const lastLogin = latestAccountLogin(user.id);
    const deviceNumbers = active.slice(0, 2).map(item => `<code title="${escapeHtml(item.deviceId)}">${escapeHtml(shortBindingNumber(item.deviceId))}</code>`).join("");
    return `<article class="account-row"><div class="account-person"><span class="account-avatar">${escapeHtml(user.name.slice(0, 1) || "员")}</span><div><strong>${escapeHtml(user.name)}</strong><small>${escapeHtml(user.id)}</small></div><span class="account-status ${user.status === "disabled" ? "disabled" : active.length ? "bound" : "unbound"}">${user.status === "disabled" ? "已停用" : active.length ? "已绑定" : "未绑定"}</span></div><div class="account-groups">${groupNames.length ? groupNames.map(name => `<span class="pill">${escapeHtml(name)}</span>`).join("") : `<span class="account-muted">未分组</span>`}</div><div class="account-devices"><b>${active.length} 台有效</b>${deviceNumbers || `<small>暂无绑定号码</small>`}${active.length > 2 ? `<small>另有 ${active.length - 2} 台</small>` : ""}</div><div class="account-login"><b>${lastLogin ? formatDateTime(lastLogin) : "暂无登录记录"}</b><small>${lastLogin ? "最近账号登录" : bindings.length ? "设备已绑定，尚未记录登录" : "等待邀请码绑定"}</small></div><div class="account-actions"><button class="button ghost" type="button" data-account-detail="${escapeHtml(user.id)}">查看详情</button><button class="icon-button" type="button" aria-label="编辑 ${escapeHtml(user.name)}" data-edit-member="${escapeHtml(user.id)}">${icons.edit}</button></div></article>`;
  }).join("") : `<div class="empty">没有符合筛选条件的成员账号</div>`;

  if (state.selectedAccountId && $("#account-detail-dialog").open) renderAccountDetail(state.selectedAccountId);
}

function invitationDisplayState(item) {
  if (item.status === "used") return "used";
  if (item.status !== "pending" || Date.parse(item.expiresAt) <= Date.now()) return "expired";
  return "pending";
}

function renderInvitations() {
  if (!state.data) return;
  const filter = $("#invitation-status-filter").value;
  const invitations = [...(state.data.invitations || [])].sort((a, b) => Date.parse(b.createdAt || 0) - Date.parse(a.createdAt || 0)).filter(item => filter === "all" || invitationDisplayState(item) === filter);
  $("#invitation-management-list").innerHTML = invitations.length ? invitations.map(item => {
    const user = state.data.users.find(candidate => candidate.id === item.userId);
    const status = invitationDisplayState(item);
    const canCopy = status === "pending" && item.code;
    return `<article class="invitation-row"><div><strong>${escapeHtml(user?.name || item.userId)}</strong><small>${escapeHtml(item.userId)}</small></div><div class="invitation-code-cell"><code>${item.code ? escapeHtml(item.code) : `历史邀请码 ····${escapeHtml(item.codeSuffix || "----")}`}</code>${!item.code ? `<small>旧记录未保存完整邀请码</small>` : ""}</div><span class="invitation-status ${status}">${status === "pending" ? "待使用" : status === "used" ? "已使用" : "已过期"}</span><div class="invitation-dates"><b>${formatDateTime(item.createdAt)}</b><small>${status === "used" ? `使用于 ${formatDateTime(item.usedAt)}` : `到期于 ${formatDateTime(item.expiresAt)}`}</small></div><div class="invitation-actions">${canCopy ? `<button class="button ghost" type="button" data-copy-invitation="${escapeHtml(item.code)}">复制</button>` : ""}<button class="icon-button danger" type="button" aria-label="删除 ${escapeHtml(user?.name || "成员")} 的邀请码" data-delete-invitation="${escapeHtml(item.id)}">${icons.archive}</button></div></article>`;
  }).join("") : `<div class="empty">没有符合条件的邀请码</div>`;
}

function renderAccountDetail(userId) {
  const user = (state.data.users || []).find(item => item.id === userId && item.role !== "admin");
  if (!user) return $("#account-detail-dialog").close();
  state.selectedAccountId = user.id;
  const bindings = accountBindings(user.id);
  const invitations = (state.data.invitations || []).filter(item => (item.memberId || item.userId) === user.id).sort((a, b) => Date.parse(b.createdAt || 0) - Date.parse(a.createdAt || 0));
  const groups = (user.groupIds || []).map(id => state.data.groups.find(group => group.id === id)?.name || id);
  const timeline = accountTimeline(user.id).slice(0, 30);
  $("#account-detail-title").textContent = user.name;
  const deviceCards = bindings.length ? bindings.map(binding => `<article class="binding-card"><div class="binding-card-head"><div><span class="account-status ${binding.status === "active" ? "bound" : "disabled"}">${binding.status === "active" ? "有效绑定" : "已撤销"}</span><strong>绑定号码</strong></div><button class="button ghost" type="button" data-copy-binding="${escapeHtml(binding.deviceId)}">复制号码</button></div><code>${escapeHtml(binding.deviceId)}</code><dl><div><dt>浏览器</dt><dd>${escapeHtml(truncate(binding.browser || "unknown", 90))}</dd></div><div><dt>插件版本</dt><dd>${escapeHtml(binding.extensionVersion || "unknown")}</dd></div><div><dt>绑定时间</dt><dd>${formatDateTime(binding.createdAt)}</dd></div><div><dt>最近登录</dt><dd>${binding.lastLoginAt ? formatDateTime(binding.lastLoginAt) : "暂无登录记录"}</dd></div></dl>${binding.status === "active" ? `<button class="button secondary binding-revoke" type="button" data-revoke-device="${escapeHtml(binding.id)}">撤销此设备</button>` : ""}</article>`).join("") : `<div class="empty">该成员还没有设备绑定记录</div>`;
  const invitationRows = invitations.length ? invitations.slice(0, 8).map(item => { const status = invitationDisplayState(item); return `<li><code>${item.code ? escapeHtml(item.code) : `邀请码 ····${escapeHtml(item.codeSuffix || "----")}`}</code><span>${status === "pending" ? "待使用" : status === "used" ? "已使用" : "已过期"}</span><small>${formatDateTime(item.createdAt)}</small><div>${status === "pending" && item.code ? `<button type="button" data-copy-invitation="${escapeHtml(item.code)}">复制</button>` : ""}<button type="button" data-delete-invitation="${escapeHtml(item.id)}">删除</button></div></li>`; }).join("") : `<li class="account-empty-row">暂无邀请码记录</li>`;
  const eventRows = timeline.length ? timeline.map(item => `<li><i class="account-event-dot ${escapeHtml(item.type)}"></i><div><strong>${escapeHtml(accountEventLabel(item.type))}</strong><p>${item.deviceId ? `绑定号码 ${escapeHtml(shortBindingNumber(item.deviceId))}` : item.codeSuffix ? `邀请码尾号 ${escapeHtml(item.codeSuffix)}` : "管理员后台操作"}${item.extensionVersion && item.extensionVersion !== "unknown" ? ` · v${escapeHtml(item.extensionVersion)}` : ""}</p></div><time>${formatDateTime(item.createdAt)}</time></li>`).join("") : `<li class="account-empty-row">暂无账号事件</li>`;
  $("#account-detail-body").innerHTML = `<section class="account-profile-card"><div class="account-profile-main"><span class="account-avatar large">${escapeHtml(user.name.slice(0, 1) || "员")}</span><div><strong>${escapeHtml(user.name)}</strong><p>${groups.length ? groups.map(escapeHtml).join("、") : "未分组"} · ${user.status === "disabled" ? "账号已停用" : "账号正常"}</p><code>${escapeHtml(user.id)}</code></div></div><div class="account-profile-actions"><button class="button secondary" type="button" data-invite-member="${escapeHtml(user.id)}">生成邀请码</button><button class="button primary" type="button" data-edit-member="${escapeHtml(user.id)}">编辑姓名与组别</button></div></section><section class="account-detail-section"><div class="account-detail-heading"><h3>设备绑定</h3><span>${bindings.filter(item => item.status === "active").length} 台有效</span></div><div class="binding-grid">${deviceCards}</div></section><section class="account-detail-section"><div class="account-detail-heading"><h3>邀请码记录</h3><span>只显示安全尾号</span></div><ul class="invitation-list">${invitationRows}</ul></section><section class="account-detail-section"><div class="account-detail-heading"><h3>绑定与登录事件</h3><span>最近 ${timeline.length} 条</span></div><ul class="account-timeline">${eventRows}</ul></section>`;
}

function openAccountDetail(userId) {
  renderAccountDetail(userId);
  $("#account-detail-dialog").showModal();
}

function pageScopeLabel(rule = {}) {
  if (rule.pageScope === "global") return "全局页面";
  const names = (rule.pageGroupIds || []).map(id => state.data.pageGroups.find(group => group.id === id)?.name || id);
  return names.length ? names.join("、") : "特定页面";
}

function renderPageGroups() {
  const groups = state.data.pageGroups || [];
  $("#page-group-list").innerHTML = groups.length ? groups.map(group => {
    const usage = state.data.memos.filter(item => item.rule?.pageGroupIds?.includes(group.id)).length;
    const patterns = group.sitePatterns.map(pattern => `<code title="${escapeHtml(pattern)}">${escapeHtml(pattern)}</code>`).join("");
    return `<article class="page-group-card"><div><h3>${escapeHtml(group.name)}</h3><p>${escapeHtml(group.description || "暂无说明")}</p><div class="usage-count">${usage} 条备忘正在使用</div></div><div class="pattern-list">${patterns}</div><div class="card-actions"><button class="icon-button" title="编辑" aria-label="编辑 ${escapeHtml(group.name)}" data-edit-page-group="${group.id}">${icons.edit}</button><button class="icon-button danger" title="删除" aria-label="删除 ${escapeHtml(group.name)}" data-delete-page-group="${group.id}">${icons.archive}</button></div></article>`;
  }).join("") : `<div class="empty">还没有页面组。新建后即可在关键词规则中选择。</div>`;
}

function renderExcludedSites() {
  const form = $("#excluded-sites-form");
  if (!form || !state.data) return;
  form.elements.excludedSitePatterns.value = (state.data.settings?.excludedSitePatterns || []).join("\n");
}

function strategyLabel(strategy = {}) {
  return strategy.matchScope === "row" ? "列表同一行" : strategy.matchScope === "module" ? "同一内容模块" : "整个页面";
}

function decoratePageGroupStrategies() {
  const groups = state.data?.pageGroups || [];
  $$("#page-group-list .page-group-card").forEach((card, index) => {
    const group = groups[index];
    if (!group) return;
    const strategy = group.strategy || { matchScope: "page" };
    const meta = card.querySelector(".usage-count");
    meta?.insertAdjacentHTML("afterend", `<div class="strategy-meta"><span class="pill">${strategyLabel(strategy)}</span>${strategy.lastTestResult ? `<span class="pill ${strategy.lastTestResult.matchedUnitCount ? "strategy-ok" : "important"}">${strategy.lastTestResult.matchedUnitCount ? "测试通过" : "需要调整"}</span>` : ""}</div>`);
    if (strategy.matchScope !== "page") {
      const actions = card.querySelector(".card-actions");
      actions?.insertAdjacentHTML("afterbegin", `<button class="button secondary strategy-test-button" type="button" data-test-page-group="${group.id}">测试策略</button>`);
    }
  });
}

function togglePageGroupStrategyFields() {
  const form = $("#page-group-form");
  const scoped = form.elements.matchScope.value !== "page";
  $$('[data-strategy-selector]').forEach(field => { field.hidden = !scoped; });
  form.elements.strategySelector.required = scoped;
  form.elements.strategySelector.disabled = !scoped;
  form.elements.strategyExcludeSelector.disabled = !scoped;
}

function fillGroupOptions() {
  const options = `<option value="">全体成员</option>${state.data.groups.map(group => `<option value="${group.id}">${escapeHtml(group.name)}</option>`).join("")}`;
  $("#memo-form [name=targetGroupIds]").innerHTML = state.data.groups.map(group => `<option value="${group.id}">${escapeHtml(group.name)}</option>`).join("");
  $("#tool-form [name=targetGroupId]").innerHTML = options;
  $("#memo-form [name=targetUserIds]").innerHTML = (state.data.users || []).filter(user => user.role !== "admin" && user.status !== "disabled").map(user => `<option value="${user.id}">${escapeHtml(user.name)}</option>`).join("");
  $("#member-form [name=groupIds]").innerHTML = state.data.groups.map(group => `<option value="${group.id}">${escapeHtml(group.name)}</option>`).join("");
}

function fillPageGroupOptions(selected = []) {
  const groups = state.data.pageGroups || [];
  $("#memo-page-group-options").innerHTML = groups.length
    ? groups.map(group => `<label><input type="checkbox" name="pageGroupIds" value="${group.id}" ${selected.includes(group.id) ? "checked" : ""} />${escapeHtml(group.name)}</label>`).join("")
    : `<span class="empty">请先在“页面组”中创建网址范围</span>`;
}

function fillSupplierOptions(selected = "") {
  const select = $("#memo-form [name=supplierId]");
  if (!select || !state.data) return;
  select.innerHTML = `<option value="">不关联供应商卡片</option>${(state.data.suppliers || []).filter(item => item.status !== "archived").map(item => `<option value="${escapeHtml(item.id)}">${escapeHtml(item.companyName)} · ${escapeHtml(item.customerId)}</option>`).join("")}`;
  select.value = selected;
}

function renderMemoAnchors() {
  const anchors = state.editingMemo?.annotation?.anchors || [];
  $("#anchor-count").textContent = `${anchors.length} / 20`;
  $("#memo-anchor-list").innerHTML = anchors.length ? anchors.sort((a,b) => a.order - b.order).map((anchor, index) => {
    const group = state.data.pageGroups.find(item => item.id === anchor.pageGroupId);
    return `<div class="anchor-row"><i>${index + 1}</i><div><strong>${escapeHtml(anchor.label)}</strong><small>${escapeHtml(group?.name || anchor.pageGroupId)} · ${anchor.relativeToMatchUnit ? "相对命中模块/行" : "页面固定元素"}</small></div><button type="button" data-delete-anchor="${escapeHtml(anchor.id)}" aria-label="删除锚点 ${escapeHtml(anchor.label)}">×</button></div>`;
  }).join("") : `<div class="empty">保存提醒后可在真实网页中点选元素</div>`;
}

function togglePageScope() {
  const form = $("#memo-form");
  const scoped = form.elements.triggerMode.value === "page_match" && form.elements.pageScope.value === "page_groups";
  $("#page-group-picker").hidden = !scoped;
  $$("#memo-page-group-options input").forEach(input => { input.disabled = !scoped; });
}

function toggleMemoType() {
  const form = $("#memo-form");
  const operation = form.elements.type.value === "operation";
  $$("[data-operation-window]").forEach(field => { field.hidden = !operation; });
  form.elements.startsAtDate.required = operation;
  form.elements.durationPreset.required = operation;
}

function toggleAudience() {
  const form = $("#memo-form");
  const type = form.elements.audienceType.value;
  $("[data-audience-groups]").hidden = type !== "groups";
  $("[data-audience-members]").hidden = type !== "members";
  form.elements.targetGroupIds.disabled = type !== "groups";
  form.elements.targetUserIds.disabled = type !== "members";
}

function toggleTriggerMode() {
  const form = $("#memo-form");
  const broadcast = form.elements.triggerMode.value === "broadcast";
  $("[data-page-trigger-fields]").hidden = broadcast;
  form.elements.includeTerms.required = !broadcast;
  if (broadcast) {
    form.elements.annotationTemplate.value = "strong";
    form.elements.priority.value = "important";
  }
  $$('[name="annotationTemplate"]').forEach(input => { input.disabled = broadcast && input.value !== "strong"; });
  togglePageScope();
}

function switchView(view, updateHash = true) {
  state.view = view;
  $$(".view").forEach(el => el.classList.toggle("active", el.id === `view-${view}`));
  $$(".nav-item").forEach(el => { const active = el.dataset.view === view; el.classList.toggle("active", active); active ? el.setAttribute("aria-current", "page") : el.removeAttribute("aria-current"); });
  const titles = { overview: "运营概览", memos: "知识与规则", "memo-folders": "提醒文件夹", suppliers: "供应商卡片", pagegroups: "页面组", tools: "团队工具箱", accounts: "账号绑定", groups: "成员分组" };
  const descriptions = { overview: "查看规则运行状态与团队使用情况", memos: "创建、发布和维护情境提醒", "memo-folders": "创建文件夹、整理提醒并按文件夹查询", suppliers: "手工维护可与提醒关联的供应商资料", pagegroups: "统一管理规则可使用的网址范围", tools: "维护成员侧栏中的常用工作入口", accounts: "管理成员身份、设备绑定与最近登录记录", groups: "查看组织成员分组与内容覆盖" };
  $("#page-title").textContent = titles[view];
  $("#page-description").textContent = descriptions[view];
  const primary = $("#primary-action");
  primary.style.display = ["overview", "memos", "memo-folders", "suppliers", "pagegroups"].includes(view) ? "block" : "none";
  primary.textContent = view === "pagegroups" ? "新建页面组" : view === "suppliers" ? "新建供应商" : view === "memo-folders" ? "新建文件夹" : "新建组织提醒";
  if (updateHash && location.hash !== `#${view}`) history.replaceState(null, "", `#${view}`);
}

function openMemoFolder(id = null) {
  const form = $("#memo-folder-form");
  form.reset();
  state.editingMemoFolder = id ? activeMemoFolders().find(item => item.id === id) : null;
  $("#memo-folder-dialog-title").textContent = id ? "编辑提醒文件夹" : "新建提醒文件夹";
  form.elements.sortOrder.value = 0;
  if (state.editingMemoFolder) {
    form.elements.id.value = state.editingMemoFolder.id;
    form.elements.name.value = state.editingMemoFolder.name;
    form.elements.description.value = state.editingMemoFolder.description || "";
    form.elements.sortOrder.value = state.editingMemoFolder.sortOrder || 0;
  }
  $("#memo-folder-dialog").showModal();
}

function openMemo(id = null) {
  const form = $("#memo-form"); form.reset(); form.elements.cooldownMinutes.value = 30;
  form.elements.id.value = "";
  form.elements.startsAtDate.value = dateInputValue();
  form.elements.durationPreset.value = "30";
  state.editingMemo = id ? state.data.memos.find(item => item.id === id) : null;
  $("#memo-dialog-title").textContent = id ? "编辑组织提醒" : "新建组织提醒";
  fillMemoFolderOptions(state.editingMemo?.folderId || "");
  if (state.editingMemo) {
    const item = state.editingMemo;
    form.elements.id.value = item.id; form.elements.type.value = item.type || "knowledge"; form.elements.title.value = item.title; form.elements.body.value = item.body;
    form.elements.folderId.value = item.folderId || "";
    form.elements.triggerMode.value = item.triggerMode || "page_match";
    form.elements.audienceType.value = item.audienceType || ((item.targetUserIds || []).length ? "members" : (item.targetGroupIds || []).length ? "groups" : "all");
    Array.from(form.elements.targetGroupIds.options).forEach(option => { option.selected = (item.targetGroupIds || []).includes(option.value); });
    form.elements.priority.value = item.priority; form.elements.status.value = item.status === "archived" ? "draft" : item.status;
    Array.from(form.elements.targetUserIds.options).forEach(option => { option.selected = (item.targetUserIds || []).includes(option.value); });
    form.elements.pageScope.value = item.rule.pageScope || (item.rule.sitePatterns?.length ? "page_groups" : "global"); fillPageGroupOptions(item.rule.pageGroupIds || []); form.elements.includeTerms.value = item.rule.includeTerms.join("\n"); form.elements.excludeTerms.value = item.rule.excludeTerms.join("\n");
    form.elements.operator.value = item.rule.operator; form.elements.cooldownMinutes.value = item.rule.cooldownMinutes; form.elements.caseSensitive.checked = item.rule.caseSensitive; form.elements.useRegex.checked = item.rule.useRegex;
    form.elements.tags.value = item.tags.join(", ");
    form.elements.startsAtDate.value = item.startsAt ? dateInputValue(new Date(item.startsAt)) : dateInputValue();
    form.elements.durationPreset.value = String(item.startsAt && item.expiresAt ? durationPresetFromDates(item.startsAt, item.expiresAt) : 30);
    form.elements.links.value = linksText(item.links || []);
    form.elements.annotationTemplate.value = item.annotation?.template || (item.priority === "important" ? "strong" : "standard");
    form.elements.keywordTerms.value = item.annotation?.keywordTerms?.join("\n") || "";
    fillSupplierOptions((item.entityRefs || []).find(ref => ref.type === "supplier")?.id || "");
  } else { fillPageGroupOptions(); fillSupplierOptions(); }
  renderMemoAnchors();
  toggleMemoType();
  toggleAudience();
  toggleTriggerMode();
  $("#memo-dialog").showModal();
}

function parseAdvantageProducts(value = "") {
  return splitLines(value).map(line => { const [name = "", cas = "", closeRate = "0"] = line.split("|").map(item => item.trim()); return { name, cas, closeRate: Number(String(closeRate).replace("%", "")) || 0 }; }).filter(item => item.name || item.cas).slice(0, 20);
}

function advantageProductsText(items = []) { return items.map(item => `${item.name} | ${item.cas} | ${item.closeRate}`).join("\n"); }

function openSupplier(id = null) {
  const form = $("#supplier-form"); form.reset();
  state.editingSupplier = id ? (state.data.suppliers || []).find(item => item.id === id) : null;
  $("#supplier-dialog-title").textContent = id ? "编辑供应商" : "新建供应商";
  form.elements.periodLabel.value = "近12个月";
  if (state.editingSupplier) {
    const item = state.editingSupplier;
    form.elements.companyName.value = item.companyName || ""; form.elements.customerId.value = item.customerId || ""; form.elements.matchTerms.value = (item.matchTerms || []).join("\n");
    form.elements.contactName.value = item.contact?.name || ""; form.elements.contactTitle.value = item.contact?.title || ""; form.elements.phone.value = item.contact?.phone || ""; form.elements.email.value = item.contact?.email || "";
    for (const name of ["periodLabel", "productPercentile", "orderPercentile", "closeRate", "quoteRate", "afterSalesRate"]) form.elements[name].value = item.metrics?.[name] ?? (name === "periodLabel" ? "近12个月" : 0);
    form.elements.advantageProducts.value = advantageProductsText(item.advantageProducts || []);
    const short = item.evaluations?.shortTerm?.[0]; const long = item.evaluations?.longTerm?.[0];
    form.elements.shortEvaluation.value = short?.content || ""; form.elements.shortContributor.value = short?.contributor || ""; form.elements.shortAt.value = short?.at ? short.at.slice(0, 16) : "";
    form.elements.longEvaluation.value = long?.content || ""; form.elements.longContributor.value = long?.contributor || ""; form.elements.longAt.value = long?.at ? long.at.slice(0, 16) : "";
  }
  $("#supplier-dialog").showModal();
}

function openAnnotationSession(memo) {
  if (!memo) return toast("请先保存组织提醒");
  const form = $("#annotation-session-form");
  form.reset();
  form.elements.memoId.value = memo.id;
  form.elements.pageGroupId.innerHTML = (memo.rule?.pageGroupIds || []).map(id => {
    const group = state.data.pageGroups.find(item => item.id === id);
    return group ? `<option value="${group.id}">${escapeHtml(group.name)}</option>` : "";
  }).join("");
  if (!form.elements.pageGroupId.options.length) {
    form.elements.pageGroupId.innerHTML = state.data.pageGroups.map(group => `<option value="${group.id}">${escapeHtml(group.name)}</option>`).join("");
  }
  const group = state.data.pageGroups.find(item => item.id === form.elements.pageGroupId.value);
  form.elements.url.value = suggestedTestUrl(group || {}) || "";
  form.elements.relativeToMatchUnit.checked = ["module", "row"].includes(group?.strategy?.matchScope);
  $("#annotation-memo-summary").innerHTML = `<span class="pill">${annotationTemplateLabel(memo.annotation?.template)}</span><strong>${escapeHtml(memo.title)}</strong>`;
  $("#annotation-session-result").className = "wide annotation-session-result";
  $("#annotation-session-result").innerHTML = `<strong>尚未创建标记任务</strong><p>搜狗无法自动进入时，可在插件“网页标记”入口输入一次性代码。</p>`;
  $("#memo-dialog").close();
  $("#annotation-session-dialog").showModal();
}

function pollAnnotationSession(sessionId) {
  clearInterval(state.annotationSessionPoll);
  state.annotationSessionPoll = setInterval(async () => {
    try {
      const session = await api(`/api/admin/annotation-sessions/${sessionId}`);
      if (session.status === "completed") {
        clearInterval(state.annotationSessionPoll); state.annotationSessionPoll = null;
        $("#annotation-session-result").className = "wide annotation-session-result active";
        $("#annotation-session-result").innerHTML = `<strong>元素批注已保存</strong><p>后台和成员插件会在下一次同步后使用这个锚点。</p>`;
        await load();
      }
    } catch {}
  }, 1500);
}

function openPageGroup(id = null) {
  const form = $("#page-group-form"); form.reset();
  form.elements.id.value = "";
  state.editingPageGroup = id ? state.data.pageGroups.find(item => item.id === id) : null;
  $("#page-group-dialog-title").textContent = id ? "编辑页面组" : "新建页面组";
  if (state.editingPageGroup) {
    form.elements.id.value = state.editingPageGroup.id;
    form.elements.name.value = state.editingPageGroup.name;
    form.elements.description.value = state.editingPageGroup.description || "";
    form.elements.sitePatterns.value = state.editingPageGroup.sitePatterns.join("\n");
    form.elements.matchScope.value = state.editingPageGroup.strategy?.matchScope || "page";
    form.elements.strategySelector.value = state.editingPageGroup.strategy?.selector || "";
    form.elements.strategyExcludeSelector.value = state.editingPageGroup.strategy?.excludeSelector || "";
  }
  togglePageGroupStrategyFields();
  $("#page-group-dialog").showModal();
}

function suggestedTestUrl(group) {
  if (group.strategy?.lastTestResult?.url) return group.strategy.lastTestResult.url;
  const pattern = group.sitePatterns?.[0] || "";
  if (/^[a-z*]+:\/\/\*\./i.test(pattern)) return "";
  return pattern.replace(/^\*:\/\//, "https://").replace(/\*+$/, "").replace(/\/$/, "");
}

function renderStrategyTestResult(group, waiting = false) {
  const resultBox = $("#strategy-test-result");
  const result = group?.strategy?.lastTestResult;
  if (waiting && !result) {
    resultBox.className = "wide strategy-result testing";
    resultBox.innerHTML = `<strong>等待目标页面返回结果</strong><p>请保持扩展运行，并确认测试网站已经授权。SPA 页面加载完成后会自动检测。</p>`;
    return;
  }
  if (!result) {
    resultBox.className = "wide strategy-result";
    resultBox.innerHTML = `<strong>尚未开始测试</strong><p>扩展会在真实页面中统计模块或列表行，并返回命中结果。</p>`;
    return;
  }
  const passed = result.selectorValid && result.matchedUnitCount > 0;
  resultBox.className = `wide strategy-result ${passed ? "success" : "warning"}`;
  const missing = result.missingTerms?.length ? `；最佳候选仍缺少：${escapeHtml(result.missingTerms.join("、"))}` : "";
  const error = result.error ? `；错误：${escapeHtml(result.error)}` : "";
  resultBox.innerHTML = `<strong>${passed ? "策略测试通过" : "策略需要调整"}</strong><p>识别到 ${result.unitCount} 个${result.matchScope === "row" ? "列表行" : "内容模块"}，其中 ${result.matchedUnitCount} 个满足全部关键词${missing}${error}</p>`;
}

function openStrategyTest(id) {
  const group = state.data.pageGroups.find(item => item.id === id);
  if (!group) return;
  const form = $("#strategy-test-form");
  form.reset();
  form.elements.pageGroupId.value = group.id;
  form.elements.testUrl.value = suggestedTestUrl(group);
  form.elements.testKeywords.value = group.strategy?.testRequest?.keywords?.join("\n") || "";
  $("#strategy-test-title").textContent = `测试：${group.name}`;
  $("#strategy-test-summary").innerHTML = `<span class="pill">${strategyLabel(group.strategy)}</span><code>${escapeHtml(group.strategy?.selector || "未设置选择器")}</code>`;
  renderStrategyTestResult(group);
  $("#strategy-test-dialog").showModal();
}

function pollStrategyTest(pageGroupId, requestId) {
  clearInterval(state.strategyTestPoll);
  const startedAt = Date.now();
  state.strategyTestPoll = setInterval(async () => {
    try {
      const next = await api("/api/admin/state");
      const group = next.pageGroups.find(item => item.id === pageGroupId);
      if (!group) return;
      if (group.strategy?.lastTestResult?.requestId === requestId) {
        state.data = next;
        renderStrategyTestResult(group);
        clearInterval(state.strategyTestPoll);
        state.strategyTestPoll = null;
        renderPageGroups();
        decoratePageGroupStrategies();
      } else if (Date.now() - startedAt > 60_000) {
        clearInterval(state.strategyTestPoll);
        state.strategyTestPoll = null;
        const box = $("#strategy-test-result");
        box.className = "wide strategy-result warning";
        box.innerHTML = `<strong>暂未收到结果</strong><p>请确认扩展已安装、目标网站已授权，并刷新测试页面。</p>`;
      }
    } catch {}
  }, 1_500);
}

function openTool(id = null) {
  const form = $("#tool-form"); form.reset();
  form.elements.id.value = "";
  state.editingTool = id ? state.data.tools.find(item => item.id === id) : null;
  $("#tool-dialog-title").textContent = id ? "编辑工具链接" : "新建工具链接";
  if (state.editingTool) for (const name of ["id","title","category","url","description","icon","sortOrder","status"]) form.elements[name].value = state.editingTool[name] ?? "";
  if (state.editingTool) form.elements.targetGroupId.value = state.editingTool.targetGroupIds[0] || "";
  $("#tool-dialog").showModal();
}

function openMember(id = null) {
  const form = $("#member-form"); form.reset();
  state.editingMember = id ? state.data.users.find(item => item.id === id) : null;
  $("#member-dialog-title").textContent = id ? "编辑成员" : "新建成员";
  if (state.editingMember) {
    form.elements.id.value = state.editingMember.id; form.elements.name.value = state.editingMember.name; form.elements.status.value = state.editingMember.status || "active";
    Array.from(form.elements.groupIds.options).forEach(option => { option.selected = (state.editingMember.groupIds || []).includes(option.value); });
  }
  $("#member-dialog").showModal();
}

function openGroup(id = null) {
  const form = $("#group-form");
  form.reset();
  state.editingGroup = id ? state.data.groups.find(item => item.id === id) : null;
  $("#group-dialog-title").textContent = id ? "编辑分组" : "新建分组";
  if (state.editingGroup) {
    form.elements.id.value = state.editingGroup.id;
    form.elements.name.value = state.editingGroup.name || "";
    form.elements.description.value = state.editingGroup.description || "";
    form.elements.canPublishOrganizationMemos.checked = state.editingGroup.canPublishOrganizationMemos === true;
  }
  $("#group-dialog").showModal();
}

$("#member-form").addEventListener("submit", async event => {
  event.preventDefault(); const data = new FormData(event.currentTarget); const id = state.editingMember?.id || "";
  try { await api(`/api/admin/users${id ? `/${id}` : ""}`, { method: id ? "PUT" : "POST", body: JSON.stringify({ name: data.get("name"), groupIds: data.getAll("groupIds"), status: data.get("status") }) }); $("#member-dialog").close(); await load(); toast("成员已保存"); } catch (error) { toast(error.message); }
});

$("#group-form").addEventListener("submit", async event => {
  event.preventDefault();
  const form = event.currentTarget;
  const data = new FormData(form);
  const id = state.editingGroup?.id || "";
  setSubmitting(form, true);
  try {
    await api(`/api/admin/groups${id ? `/${id}` : ""}`, {
      method: id ? "PUT" : "POST",
      body: JSON.stringify({
        name: data.get("name"),
        description: data.get("description"),
        canPublishOrganizationMemos: data.get("canPublishOrganizationMemos") === "on"
      })
    });
    $("#group-dialog").close();
    await load();
    toast("分组已保存");
  } catch (error) { toast(error.message); } finally { setSubmitting(form, false); }
});

$("#memo-folder-form").addEventListener("submit", async event => {
  event.preventDefault();
  const form = event.currentTarget;
  const data = new FormData(form);
  const id = state.editingMemoFolder?.id || "";
  const payload = { name: data.get("name"), description: data.get("description"), sortOrder: Number(data.get("sortOrder")) };
  setSubmitting(form, true);
  try {
    await api(`/api/admin/memo-folders${id ? `/${id}` : ""}`, { method: id ? "PUT" : "POST", body: JSON.stringify(payload) });
    $("#memo-folder-dialog").close();
    await load();
    toast("提醒文件夹已保存");
  } catch (error) { toast(error.message); } finally { setSubmitting(form, false); }
});

$("#memo-form").addEventListener("submit", async event => {
  event.preventDefault(); const form = event.currentTarget; const data = new FormData(form);
  const shouldPush = event.submitter?.dataset.publish === "true";
  const shouldAnnotate = event.submitter?.dataset.annotate === "true";
  const triggerMode = data.get("triggerMode") === "broadcast" ? "broadcast" : "page_match";
  const pageScope = data.get("pageScope");
  const pageGroupIds = data.getAll("pageGroupIds");
  if (triggerMode === "page_match" && pageScope === "page_groups" && !pageGroupIds.length) return toast("请至少选择一个页面组");
  if (triggerMode === "page_match" && !splitLines(data.get("includeTerms")).length) return toast("请至少填写一个包含关键词");
  const audienceType = data.get("audienceType") || "all";
  const targetGroupIds = audienceType === "groups" ? data.getAll("targetGroupIds") : [];
  const targetUserIds = audienceType === "members" ? data.getAll("targetUserIds") : [];
  if (audienceType === "groups" && !targetGroupIds.length) return toast("请至少选择一个成员组");
  if (audienceType === "members" && !targetUserIds.length) return toast("请至少选择一名成员");
  const annotationTemplate = data.get("annotationTemplate") || "standard";
  const type = data.get("type") === "operation" ? "operation" : "knowledge";
  const startsAt = type === "operation" ? localDateStartIso(data.get("startsAtDate")) : null;
  const expiresAt = type === "operation" ? addDaysIso(startsAt, data.get("durationPreset")) : null;
  const payload = { scope: "organization", type, triggerMode, audienceType, folderId: data.get("folderId") || null, title: data.get("title"), body: data.get("body"), targetGroupIds, targetUserIds, entityRefs: data.get("supplierId") ? [{ type: "supplier", id: data.get("supplierId") }] : [], priority: annotationTemplate === "strong" ? "important" : data.get("priority"), status: data.get("status"), startsAt, expiresAt, tags: data.get("tags").split(/[,，]/).map(x => x.trim()).filter(Boolean), links: parseLinks(data.get("links")), annotation: { template: annotationTemplate, keywordTerms: splitLines(data.get("keywordTerms")), anchors: state.editingMemo?.annotation?.anchors || [] }, rule: { pageScope: triggerMode === "broadcast" ? "global" : pageScope, pageGroupIds: triggerMode === "broadcast" ? [] : pageGroupIds, sitePatterns: [], includeTerms: triggerMode === "broadcast" ? [] : splitLines(data.get("includeTerms")), excludeTerms: triggerMode === "broadcast" ? [] : splitLines(data.get("excludeTerms")), operator: data.get("operator"), cooldownMinutes: Number(data.get("cooldownMinutes")), caseSensitive: data.get("caseSensitive") === "on", useRegex: data.get("useRegex") === "on" } };
  setSubmitting(form, true, shouldPush ? "正在发布" : "保存中");
  try {
    const editingId = state.editingMemo?.id || "";
    const saved = await api(`/api/admin/memos${editingId ? `/${editingId}` : ""}`, { method: editingId ? "PUT" : "POST", body: JSON.stringify(payload) });
    let message = "组织提醒已保存";
    if (shouldPush && saved.status === "published") {
      const delivery = await api("/api/admin/push", { method: "POST", body: JSON.stringify({ memoId: saved.id, type: triggerMode === "broadcast" ? "broadcast" : "sync" }) });
      message = delivery.message;
    } else if (shouldPush) message = "草稿已保存，未向成员推送";
    await load();
    const current = state.data.memos.find(item => item.id === saved.id) || saved;
    if (shouldAnnotate) openAnnotationSession(current);
    else $("#memo-dialog").close();
    toast(shouldAnnotate ? "提醒已保存，请选择要标记的页面元素" : message);
  } catch (error) { toast(error.message); } finally { setSubmitting(form, false); }
});

$("#supplier-form").addEventListener("submit", async event => {
  event.preventDefault(); const form = event.currentTarget; const data = new FormData(form);
  const evaluation = prefix => data.get(`${prefix}Evaluation`) ? [{ content: data.get(`${prefix}Evaluation`), contributor: data.get(`${prefix}Contributor`), at: data.get(`${prefix}At`) ? new Date(data.get(`${prefix}At`)).toISOString() : new Date().toISOString() }] : [];
  const payload = { companyName: data.get("companyName"), customerId: data.get("customerId"), matchTerms: splitLines(data.get("matchTerms")), contact: { name: data.get("contactName"), title: data.get("contactTitle"), phone: data.get("phone"), email: data.get("email") }, metrics: { periodLabel: data.get("periodLabel"), productPercentile: Number(data.get("productPercentile")), orderPercentile: Number(data.get("orderPercentile")), closeRate: Number(data.get("closeRate")), quoteRate: Number(data.get("quoteRate")), afterSalesRate: Number(data.get("afterSalesRate")) }, advantageProducts: parseAdvantageProducts(data.get("advantageProducts")), evaluations: { shortTerm: evaluation("short"), longTerm: evaluation("long") }, source: { type: "manual" }, status: "active" };
  setSubmitting(form, true);
  const id = state.editingSupplier?.id || "";
  try { await api(`/api/admin/suppliers${id ? `/${id}` : ""}`, { method: id ? "PUT" : "POST", body: JSON.stringify(payload) }); $("#supplier-dialog").close(); await load(); toast("供应商资料已保存"); } catch (error) { toast(error.message); } finally { setSubmitting(form, false); }
});

$("#annotation-session-form").addEventListener("change", event => {
  if (event.target.name !== "pageGroupId") return;
  const group = state.data.pageGroups.find(item => item.id === event.target.value);
  const form = event.currentTarget;
  form.elements.url.value = suggestedTestUrl(group || {}) || "";
  form.elements.relativeToMatchUnit.checked = ["module", "row"].includes(group?.strategy?.matchScope);
});

$("#annotation-session-form").addEventListener("submit", async event => {
  event.preventDefault();
  const form = event.currentTarget;
  const data = new FormData(form);
  setSubmitting(form, true, "正在打开");
  try {
    const session = await api("/api/admin/annotation-sessions", { method: "POST", body: JSON.stringify({ memoId: data.get("memoId"), pageGroupId: data.get("pageGroupId"), url: data.get("url") }) });
    sessionStorage.setItem(`pagecue-annotation-label:${session.code}`, String(data.get("label") || "页面批注"));
    sessionStorage.setItem(`pagecue-annotation-relative:${session.code}`, data.get("relativeToMatchUnit") === "on" ? "1" : "0");
    const target = new URL(session.url);
    target.hash = `pagecue-annotation=${encodeURIComponent(session.code)}&label=${encodeURIComponent(data.get("label") || "页面批注")}&relative=${data.get("relativeToMatchUnit") === "on" ? "1" : "0"}`;
    const opened = window.open(target.href, "_blank", "noopener");
    $("#annotation-session-result").className = "wide annotation-session-result active";
    $("#annotation-session-result").innerHTML = `<strong>标记任务已创建 <span class="annotation-code">${session.code}</span></strong><p>${opened ? "目标页面已经打开，请点击需要批注的元素。" : "新标签页被阻止，请手动打开目标网址并在插件中输入上方代码。"}</p>`;
    pollAnnotationSession(session.id);
  } catch (error) { toast(error.message); } finally { setSubmitting(form, false); }
});

$("#page-group-form").addEventListener("submit", async event => {
  event.preventDefault(); const form = event.currentTarget; const data = new FormData(form);
  const payload = { name: data.get("name"), description: data.get("description"), sitePatterns: splitLines(data.get("sitePatterns")), strategy: { matchScope: data.get("matchScope"), selector: data.get("strategySelector") || "", excludeSelector: data.get("strategyExcludeSelector") || "" } };
  if (!payload.sitePatterns.length) return toast("请至少填写一个网址规则");
  setSubmitting(form, true);
  const editingId = state.editingPageGroup?.id || "";
  try { await api(`/api/admin/page-groups${editingId ? `/${editingId}` : ""}`, { method: editingId ? "PUT" : "POST", body: JSON.stringify(payload) }); $("#page-group-dialog").close(); toast("页面组已保存"); await load(); } catch (error) { toast(error.message); } finally { setSubmitting(form, false); }
});

$("#excluded-sites-form").addEventListener("submit", async event => {
  event.preventDefault();
  const form = event.currentTarget;
  const data = new FormData(form);
  const payload = { excludedSitePatterns: splitLines(String(data.get("excludedSitePatterns") || "")) };
  setSubmitting(form, true);
  try {
    await api("/api/admin/settings", { method: "PUT", body: JSON.stringify(payload) });
    toast("组织不提醒页面已保存并推送同步");
    await load();
  } catch (error) { toast(error.message); }
  finally { setSubmitting(form, false); }
});

$("#strategy-test-form").addEventListener("submit", async event => {
  event.preventDefault();
  const form = event.currentTarget;
  const data = new FormData(form);
  const pageGroupId = data.get("pageGroupId");
  const url = String(data.get("testUrl") || "").trim();
  const keywords = splitLines(String(data.get("testKeywords") || ""));
  if (!keywords.length) return toast("请至少填写一个测试关键词");
  const opened = window.open(url, "_blank", "noopener");
  setSubmitting(form, true, "等待页面结果");
  try {
    const payload = await api(`/api/admin/page-groups/${pageGroupId}/test`, { method: "POST", body: JSON.stringify({ url, keywords }) });
    const group = state.data.pageGroups.find(item => item.id === pageGroupId);
    if (group) { group.strategy.lastTestResult = null; group.strategy.testRequest = payload.request; renderStrategyTestResult(group, true); }
    if (!opened) toast("浏览器阻止了新标签页，请手动打开测试网址");
    pollStrategyTest(pageGroupId, payload.request.id);
  } catch (error) {
    toast(error.message);
    renderStrategyTestResult(state.data.pageGroups.find(item => item.id === pageGroupId));
  } finally { setSubmitting(form, false); }
});

$("#tool-form").addEventListener("submit", async event => {
  event.preventDefault(); const form = event.currentTarget; const data = new FormData(form);
  const payload = { scope: "organization", title: data.get("title"), category: data.get("category"), url: data.get("url"), description: data.get("description"), icon: data.get("icon"), targetGroupIds: data.get("targetGroupId") ? [data.get("targetGroupId")] : [], sortOrder: Number(data.get("sortOrder")), status: data.get("status") };
  setSubmitting(form, true);
  const editingId = state.editingTool?.id || "";
  try { await api(`/api/admin/tools${editingId ? `/${editingId}` : ""}`, { method: editingId ? "PUT" : "POST", body: JSON.stringify(payload) }); $("#tool-dialog").close(); toast("工具链接已保存"); await load(); } catch (error) { toast(error.message); } finally { setSubmitting(form, false); }
});

$("#admin-login-form").addEventListener("submit", async event => {
  event.preventDefault();
  const form = event.currentTarget;
  const data = new FormData(form);
  setSubmitting(form, true, "正在登录");
  try {
    const session = await api("/api/admin/auth/login", { method: "POST", body: JSON.stringify({ phone: data.get("phone"), password: data.get("password") }) });
    form.elements.password.value = "";
    showAdmin(session);
    await load();
  } catch (error) {
    showLogin(error.message);
  } finally { setSubmitting(form, false); }
});

document.addEventListener("click", async event => {
  if (event.target.closest("#admin-logout")) {
    await api("/api/admin/auth/logout", { method: "POST" });
    state.data = null;
    showLogin("已安全退出");
    return;
  }
  const nav = event.target.closest("[data-view]"); if (nav) switchView(nav.dataset.view);
  const jump = event.target.closest("[data-jump]"); if (jump) switchView(jump.dataset.jump);
  if (event.target.closest("#primary-action")) state.view === "pagegroups" ? openPageGroup() : state.view === "suppliers" ? openSupplier() : state.view === "memo-folders" ? openMemoFolder() : openMemo();
  if (event.target.closest("#new-memo-folder")) openMemoFolder();
  if (event.target.closest("#new-supplier")) openSupplier();
  if (event.target.closest("#new-tool")) openTool();
  if (event.target.closest("#new-page-group")) openPageGroup();
  if (event.target.closest("#new-member")) openMember();
  if (event.target.closest("#new-group")) openGroup();
  if (event.target.closest("#new-account")) openMember();
  if (event.target.closest("#push-extension-update")) {
    const button = event.target.closest("#push-extension-update");
    button.disabled = true;
    try {
      const delivery = await api("/api/admin/push", { method: "POST", body: JSON.stringify({ type: "extension_update" }) });
      toast(delivery.message);
      await load();
    } catch (error) { toast(error.message); }
    finally { button.disabled = false; }
  }
  const editMemo = event.target.closest("[data-edit-memo]"); if (editMemo) openMemo(editMemo.dataset.editMemo);
  const openMemoFolderButton = event.target.closest("[data-open-memo-folder]"); if (openMemoFolderButton) {
    const folderId = openMemoFolderButton.dataset.openMemoFolder;
    $("#memo-scope").value = openMemoFolderButton.dataset.memoScope || "organization";
    refreshMemoFolderFilter(folderId === "all" ? "all" : folderId);
    clearMemoSelection(false);
    switchView("memos");
    renderMemos();
  }
  if (event.target.closest("#memo-bulk-clear")) clearMemoSelection();
  const bulkMove = event.target.closest("#memo-bulk-move"); if (bulkMove) {
    const memoIds = [...state.selectedMemoIds].filter(id => state.data?.memos?.some(item => item.id === id));
    const folderId = $("#memo-bulk-folder").value || null;
    const folderName = folderId ? memoFolderName(folderId) : "未分组";
    if (memoIds.length && confirm(`确认将选中的 ${memoIds.length} 条组织提醒移动到“${folderName}”？`)) {
      bulkMove.disabled = true;
      try {
        const result = await api("/api/admin/memos/bulk", { method: "POST", body: JSON.stringify({ action: "move", memoIds, folderId }) });
        clearMemoSelection(false);
        await load();
        toast(`已移动 ${result.changedCount} 条提醒`);
      } catch (error) { toast(error.message); }
      finally { bulkMove.disabled = false; }
    }
  }
  const bulkArchive = event.target.closest("#memo-bulk-archive"); if (bulkArchive) {
    const memoIds = [...state.selectedMemoIds].filter(id => state.data?.memos?.some(item => item.id === id && item.status !== "archived"));
    if (memoIds.length && confirm(`确认下架选中的 ${memoIds.length} 条提醒？下架后不再触发，正文、评论、反馈和历史记录都会保留。`)) {
      bulkArchive.disabled = true;
      try {
        const result = await api("/api/admin/memos/bulk", { method: "POST", body: JSON.stringify({ action: "archive", memoIds }) });
        clearMemoSelection(false);
        await load();
        toast(`已下架 ${result.changedCount} 条提醒`);
      } catch (error) { toast(error.message); }
      finally { bulkArchive.disabled = false; }
    }
  }
  const editMemoFolder = event.target.closest("[data-edit-memo-folder]"); if (editMemoFolder) openMemoFolder(editMemoFolder.dataset.editMemoFolder);
  const editSupplier = event.target.closest("[data-edit-supplier]"); if (editSupplier) openSupplier(editSupplier.dataset.editSupplier);
  const editTool = event.target.closest("[data-edit-tool]"); if (editTool) openTool(editTool.dataset.editTool);
  const editPageGroup = event.target.closest("[data-edit-page-group]"); if (editPageGroup) openPageGroup(editPageGroup.dataset.editPageGroup);
  const accountDetail = event.target.closest("[data-account-detail]"); if (accountDetail) openAccountDetail(accountDetail.dataset.accountDetail);
  const editMember = event.target.closest("[data-edit-member]"); if (editMember) { if ($("#account-detail-dialog").open) $("#account-detail-dialog").close(); openMember(editMember.dataset.editMember); }
  const editGroup = event.target.closest("[data-edit-group]"); if (editGroup) openGroup(editGroup.dataset.editGroup);
  const copyBinding = event.target.closest("[data-copy-binding]"); if (copyBinding) { await navigator.clipboard.writeText(copyBinding.dataset.copyBinding).catch(() => {}); toast("绑定号码已复制"); }
  const inviteMember = event.target.closest("[data-invite-member]"); if (inviteMember) { try { const invitation = await api("/api/admin/invitations", { method: "POST", body: JSON.stringify({ memberId: inviteMember.dataset.inviteMember, validMinutes: 1440 }) }); await navigator.clipboard.writeText(invitation.code).catch(() => {}); await load(); toast(`邀请码 ${invitation.code} 已生成并复制`); } catch (error) { toast(error.message); } }
  const copyInvitation = event.target.closest("[data-copy-invitation]"); if (copyInvitation) { await navigator.clipboard.writeText(copyInvitation.dataset.copyInvitation).catch(() => {}); toast("邀请码已复制"); }
  const clearInactiveInvitations = event.target.closest("#clear-inactive-invitations"); if (clearInactiveInvitations && confirm("确认清理所有已使用、已过期或已撤销的邀请码？绑定与删除事件仍会保留。")) { const result = await api("/api/admin/invitations/inactive", { method: "DELETE" }); await load(); toast(result.deletedCount ? `已清理 ${result.deletedCount} 条失效邀请码` : "没有需要清理的失效邀请码"); }
  const deleteInvitation = event.target.closest("[data-delete-invitation]"); if (deleteInvitation && confirm("确认删除这条邀请码记录？已发出的邀请码将立即失效。")) { await api(`/api/admin/invitations/${deleteInvitation.dataset.deleteInvitation}`, { method: "DELETE" }); await load(); toast("邀请码已删除"); }
  const revokeDevice = event.target.closest("[data-revoke-device]"); if (revokeDevice && confirm("立即撤销这台设备的成员权限？")) { await api(`/api/admin/device-bindings/${revokeDevice.dataset.revokeDevice}`, { method: "DELETE" }); await load(); toast("设备权限已撤销"); }
  const testPageGroup = event.target.closest("[data-test-page-group]"); if (testPageGroup) openStrategyTest(testPageGroup.dataset.testPageGroup);
  const deleteAnchor = event.target.closest("[data-delete-anchor]"); if (deleteAnchor && state.editingMemo) { state.editingMemo.annotation.anchors = (state.editingMemo.annotation.anchors || []).filter(anchor => anchor.id !== deleteAnchor.dataset.deleteAnchor); renderMemoAnchors(); }
  const deleteMemo = event.target.closest("[data-delete-memo]"); if (deleteMemo && confirm("确认永久删除这条组织提醒？删除后无法恢复，历史反馈与审计记录仍会保留。")) { await api(`/api/admin/memos/${deleteMemo.dataset.deleteMemo}`, { method: "DELETE" }); toast("组织提醒已删除"); await load(); }
  const deleteMemoFolder = event.target.closest("[data-delete-memo-folder]"); if (deleteMemoFolder && confirm("确认删除这个文件夹？文件夹内提醒会保留，并自动变为未分组。")) { await api(`/api/admin/memo-folders/${deleteMemoFolder.dataset.deleteMemoFolder}`, { method: "DELETE" }); toast("提醒文件夹已删除"); await load(); }
  const deleteSupplier = event.target.closest("[data-delete-supplier]"); if (deleteSupplier && confirm("确认删除这条供应商资料？已关联提醒时需要先取消关联。")) { try { await api(`/api/admin/suppliers/${deleteSupplier.dataset.deleteSupplier}`, { method: "DELETE" }); toast("供应商资料已删除"); await load(); } catch (error) { toast(error.message); } }
  const adminDeleteComment = event.target.closest("[data-admin-delete-comment]"); if (adminDeleteComment && confirm("管理员删除这条成员评论？")) { try { await api(`/api/admin/memo-comments/${adminDeleteComment.dataset.adminDeleteComment}`, { method: "DELETE" }); toast("评论已删除"); await load(); } catch (error) { toast(error.message); } }
  const deleteTool = event.target.closest("[data-delete-tool]"); if (deleteTool && confirm("确认撤回这个工具链接？")) { await api(`/api/admin/tools/${deleteTool.dataset.deleteTool}`, { method: "DELETE" }); toast("链接已撤回"); await load(); }
  const deletePageGroup = event.target.closest("[data-delete-page-group]"); if (deletePageGroup && confirm("确认删除这个页面组？")) { try { await api(`/api/admin/page-groups/${deletePageGroup.dataset.deletePageGroup}`, { method: "DELETE" }); toast("页面组已删除"); await load(); } catch (error) { toast(error.message); } }
  const close = event.target.closest("[data-close]"); if (close) { $(`#${close.dataset.close}`).close(); if (close.dataset.close === "account-detail-dialog") state.selectedAccountId = null; }
});
$("#memo-search").addEventListener("input", () => { clearMemoSelection(false); renderMemos(); });
$("#memo-status").addEventListener("change", () => { clearMemoSelection(false); renderMemos(); });
$("#memo-type").addEventListener("change", () => { clearMemoSelection(false); renderMemos(); });
$("#memo-folder-filter").addEventListener("change", () => { clearMemoSelection(false); renderMemos(); });
$("#memo-scope").addEventListener("change", () => { clearMemoSelection(false); refreshMemoFolderFilter("all"); renderMemos(); });
document.addEventListener("change", async event => {
  const rowSelection = event.target.closest("[data-select-memo]");
  if (rowSelection) {
    if (rowSelection.checked) state.selectedMemoIds.add(rowSelection.dataset.selectMemo);
    else state.selectedMemoIds.delete(rowSelection.dataset.selectMemo);
    renderMemos();
    return;
  }
  if (event.target.closest("#memo-select-all")) {
    const checked = $("#memo-select-all").checked;
    for (const memo of filteredMemos()) {
      if (checked) state.selectedMemoIds.add(memo.id);
      else state.selectedMemoIds.delete(memo.id);
    }
    renderMemos();
    return;
  }
  const select = event.target.closest("[data-move-memo]");
  if (!select) return;
  const memoId = select.dataset.moveMemo;
  const memo = state.data?.memos?.find(item => item.id === memoId);
  const previousFolderId = memo?.folderId || "";
  if (!memo || previousFolderId === select.value) return;
  select.disabled = true;
  try {
    await api(`/api/admin/memos/${memoId}/folder`, { method: "PUT", body: JSON.stringify({ folderId: select.value || null }) });
    toast(select.value ? `已移动到“${memoFolderName(select.value)}”` : "已移动到未分组");
    await load();
  } catch (error) {
    select.value = previousFolderId;
    toast(error.message);
  } finally { select.disabled = false; }
});
$("#supplier-search").addEventListener("input", renderSuppliers);
$("#account-search").addEventListener("input", renderAccounts); $("#account-status-filter").addEventListener("change", renderAccounts); $("#account-group-filter").addEventListener("change", renderAccounts);
$("#invitation-status-filter").addEventListener("change", renderInvitations);
$("#memo-form").addEventListener("change", event => {
  if (event.target.name === "pageScope") togglePageScope();
  if (event.target.name === "type") toggleMemoType();
  if (event.target.name === "audienceType") toggleAudience();
  if (event.target.name === "triggerMode") toggleTriggerMode();
});
$("#memo-form [name=supplierId]").addEventListener("change", event => { const supplier = (state.data.suppliers || []).find(item => item.id === event.target.value); const terms = $("#memo-form [name=includeTerms]"); if (supplier && !terms.value.trim()) terms.value = (supplier.matchTerms || []).join("\n"); });
$("#page-group-form").addEventListener("change", event => { if (event.target.name === "matchScope") togglePageGroupStrategyFields(); });
const adminViews = ["overview", "memos", "memo-folders", "suppliers", "pagegroups", "tools", "accounts", "groups"];
const initialView = adminViews.includes(location.hash.slice(1)) ? location.hash.slice(1) : "overview";
switchView(initialView, false);
window.addEventListener("hashchange", () => { const view = location.hash.slice(1); if (adminViews.includes(view)) switchView(view, false); });
initializeAdmin();
