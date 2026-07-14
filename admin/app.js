const state = { data: null, view: "overview", editingMemo: null, editingTool: null, editingPageGroup: null };
const $ = selector => document.querySelector(selector);
const $$ = selector => [...document.querySelectorAll(selector)];
const API_BASE = location.protocol === "file:" ? "http://127.0.0.1:8787" : "";
const icons = {
  edit: `<svg viewBox="0 0 24 24" aria-hidden="true"><path d="m4 20 4.5-1 10-10a2.1 2.1 0 0 0-3-3l-10 10L4 20Zm10-12 3 3" /></svg>`,
  archive: `<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M5 8h14v12H5V8Zm-1-4h16v4H4V4Zm5 8h6" /></svg>`,
  external: `<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M14 5h5v5M19 5l-8 8M18 13v6H5V6h6" /></svg>`
};

async function api(path, options = {}) {
  const response = await fetch(`${API_BASE}${path}`, { headers: { "Content-Type": "application/json" }, ...options });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(payload.error || `请求失败 (${response.status})`);
  return payload;
}

function escapeHtml(value = "") {
  return String(value).replace(/[&<>'"]/g, char => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", "'": "&#39;", '"': "&quot;" }[char]));
}

function truncate(value, max = 100) { return value.length > max ? `${value.slice(0, max)}…` : value; }
function splitLines(value) { return value.split(/\r?\n/).map(item => item.trim()).filter(Boolean); }
function toast(message) { const el = $("#toast"); el.textContent = message; el.classList.add("show"); setTimeout(() => el.classList.remove("show"), 3200); }
function formatPercent(value) { return `${Math.round((value || 0) * 100)}%`; }
function setSubmitting(form, loading, label = "保存中") {
  const button = form.querySelector('[type="submit"]');
  if (!button) return;
  if (loading) { button.dataset.label = button.textContent; button.textContent = label; button.disabled = true; form.setAttribute("aria-busy", "true"); }
  else { button.textContent = button.dataset.label || button.textContent; button.disabled = false; form.removeAttribute("aria-busy"); }
}

function renderLoading() {
  $("#sync-state").textContent = "正在同步";
  $("#metric-grid").innerHTML = Array.from({ length: 4 }, () => `<article class="metric skeleton"><span></span><strong></strong><small></small></article>`).join("");
  $("#active-memos").innerHTML = `<div class="loading-rows"><i></i><i></i><i></i></div>`;
  $("#group-overview").innerHTML = `<div class="loading-rows"><i></i><i></i></div>`;
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
  renderOverview(); renderMemos(); renderTools(); renderGroups(); renderPageGroups(); fillGroupOptions(); fillPageGroupOptions();
}

function renderOverview() {
  const { stats, memos, groups } = state.data;
  $("#hero-rule-count").textContent = memos.filter(item => item.scope === "organization" && item.status === "published").length;
  $("#hero-page-count").textContent = state.data.pageGroups.length;
  const metrics = [
    ["规则触发", stats.triggered, "仅记录命中事件"],
    ["提醒打开率", formatPercent(stats.openRate), `${stats.opened} 次主动查看`],
    ["有用反馈率", formatPercent(stats.helpfulRate), `${stats.helpful + stats.unhelpful} 条反馈`],
    ["生效内容", memos.filter(item => item.status === "published").length, "组织与个人备忘"]
  ];
  $("#metric-grid").innerHTML = metrics.map(([label, value, detail]) => `<article class="metric"><span>${label}</span><strong>${value}</strong><small>${detail}</small></article>`).join("");
  const active = memos.filter(item => item.status === "published" && item.scope === "organization").slice(0, 4);
  $("#active-memos").innerHTML = active.length ? active.map(item => `<div class="compact-item"><i class="status-dot"></i><div><strong>${escapeHtml(item.title)}</strong><small>${item.rule.includeTerms.length} 个关键词 · ${pageScopeLabel(item.rule)}</small></div><span class="badge">${item.priority === "important" ? "重要" : "普通"}</span></div>`).join("") : `<div class="empty">还没有已发布提醒</div>`;
  const max = Math.max(...groups.map(group => group.memberCount), 1);
  $("#group-overview").innerHTML = groups.map(group => `<div class="group-row"><div class="group-label"><span>${escapeHtml(group.name)}</span><b>${group.memberCount} 人</b></div><div class="bar"><i style="width:${Math.max(12, group.memberCount / max * 100)}%"></i></div></div>`).join("");
}

function renderMemos() {
  if (!state.data) return;
  const query = ($("#memo-search").value || "").toLowerCase();
  const status = $("#memo-status").value;
  const memos = state.data.memos.filter(item => item.scope === "organization" && (status === "all" || item.status === status) && `${item.title} ${item.body} ${item.tags.join(" ")}`.toLowerCase().includes(query));
  $("#memo-list").innerHTML = memos.length ? memos.map(item => {
    const groupNames = item.targetGroupIds.length ? item.targetGroupIds.map(id => state.data.groups.find(group => group.id === id)?.name || id).join("、") : "全体成员";
    return `<article class="content-card"><div><h3>${escapeHtml(item.title)}</h3><p>${escapeHtml(truncate(item.body.replace(/[*#`]/g, ""), 150))}</p><div class="content-meta"><span class="pill">${item.status === "published" ? "已发布" : item.status === "draft" ? "草稿" : "已撤回"}</span><span class="pill ${item.priority === "important" ? "important" : ""}">${item.priority === "important" ? "重要提醒" : "普通提醒"}</span><span class="pill">${escapeHtml(pageScopeLabel(item.rule))}</span><span class="pill">${escapeHtml(groupNames)}</span><span class="pill">${escapeHtml(item.rule.includeTerms.join(" / ") || "无关键词")}</span></div></div><div class="card-actions"><button class="icon-button" title="编辑" aria-label="编辑 ${escapeHtml(item.title)}" data-edit-memo="${item.id}">${icons.edit}</button><button class="icon-button danger" title="撤回" aria-label="撤回 ${escapeHtml(item.title)}" data-delete-memo="${item.id}">${icons.archive}</button></div></article>`;
  }).join("") : `<div class="empty">没有符合条件的组织提醒</div>`;
}

function renderTools() {
  const tools = state.data.tools.filter(item => item.scope === "organization" && item.status !== "archived").sort((a,b) => a.sortOrder - b.sortOrder);
  $("#tool-list").innerHTML = tools.length ? tools.map(item => `<article class="tool-card"><div class="tool-icon">${escapeHtml(item.icon)}</div><h3>${escapeHtml(item.title)}</h3><p>${escapeHtml(item.description || "暂无简介")}</p><div class="content-meta"><span class="pill">${escapeHtml(item.category)}</span><span class="pill">${item.status === "published" ? "已发布" : "草稿"}</span></div><div class="tool-foot"><a href="${escapeHtml(item.url)}" target="_blank" rel="noreferrer">打开链接 ${icons.external}</a><div class="card-actions"><button class="icon-button" aria-label="编辑 ${escapeHtml(item.title)}" data-edit-tool="${item.id}">${icons.edit}</button><button class="icon-button danger" aria-label="撤回 ${escapeHtml(item.title)}" data-delete-tool="${item.id}">${icons.archive}</button></div></div></article>`).join("") : `<div class="empty">还没有团队工具链接</div>`;
}

function renderGroups() {
  $("#group-list").innerHTML = state.data.groups.map(group => `<article class="group-card"><span class="member-count">${group.memberCount}</span><h3>${escapeHtml(group.name)}</h3><p>已投放 ${state.data.memos.filter(item => item.targetGroupIds.includes(group.id) && item.status === "published").length} 条组织提醒，${state.data.tools.filter(item => item.targetGroupIds.includes(group.id) && item.status === "published").length} 个工具链接。</p></article>`).join("");
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

function fillGroupOptions() {
  const options = `<option value="">全体成员</option>${state.data.groups.map(group => `<option value="${group.id}">${escapeHtml(group.name)}</option>`).join("")}`;
  $("#memo-form [name=targetGroupId]").innerHTML = options;
  $("#tool-form [name=targetGroupId]").innerHTML = options;
}

function fillPageGroupOptions(selected = []) {
  const groups = state.data.pageGroups || [];
  $("#memo-page-group-options").innerHTML = groups.length
    ? groups.map(group => `<label><input type="checkbox" name="pageGroupIds" value="${group.id}" ${selected.includes(group.id) ? "checked" : ""} />${escapeHtml(group.name)}</label>`).join("")
    : `<span class="empty">请先在“页面组”中创建网址范围</span>`;
}

function togglePageScope() {
  const form = $("#memo-form");
  const scoped = form.elements.pageScope.value === "page_groups";
  $("#page-group-picker").hidden = !scoped;
  $$("#memo-page-group-options input").forEach(input => { input.disabled = !scoped; });
}

function switchView(view, updateHash = true) {
  state.view = view;
  $$(".view").forEach(el => el.classList.toggle("active", el.id === `view-${view}`));
  $$(".nav-item").forEach(el => { const active = el.dataset.view === view; el.classList.toggle("active", active); active ? el.setAttribute("aria-current", "page") : el.removeAttribute("aria-current"); });
  const titles = { overview: "运营概览", memos: "知识与规则", pagegroups: "页面组", tools: "团队工具箱", groups: "成员分组" };
  const descriptions = { overview: "查看规则运行状态与团队使用情况", memos: "创建、发布和维护情境提醒", pagegroups: "统一管理规则可使用的网址范围", tools: "维护成员侧栏中的常用工作入口", groups: "查看组织成员分组与内容覆盖" };
  $("#page-title").textContent = titles[view];
  $("#page-description").textContent = descriptions[view];
  const primary = $("#primary-action");
  primary.style.display = ["overview", "memos", "pagegroups"].includes(view) ? "block" : "none";
  primary.textContent = view === "pagegroups" ? "新建页面组" : "新建组织提醒";
  if (updateHash && location.hash !== `#${view}`) history.replaceState(null, "", `#${view}`);
}

function openMemo(id = null) {
  const form = $("#memo-form"); form.reset(); form.elements.cooldownMinutes.value = 30;
  state.editingMemo = id ? state.data.memos.find(item => item.id === id) : null;
  $("#memo-dialog-title").textContent = id ? "编辑组织提醒" : "新建组织提醒";
  if (state.editingMemo) {
    const item = state.editingMemo;
    form.elements.id.value = item.id; form.elements.title.value = item.title; form.elements.body.value = item.body;
    form.elements.targetGroupId.value = item.targetGroupIds[0] || ""; form.elements.priority.value = item.priority; form.elements.status.value = item.status === "archived" ? "draft" : item.status;
    form.elements.pageScope.value = item.rule.pageScope || (item.rule.sitePatterns?.length ? "page_groups" : "global"); fillPageGroupOptions(item.rule.pageGroupIds || []); form.elements.includeTerms.value = item.rule.includeTerms.join("\n"); form.elements.excludeTerms.value = item.rule.excludeTerms.join("\n");
    form.elements.operator.value = item.rule.operator; form.elements.cooldownMinutes.value = item.rule.cooldownMinutes; form.elements.caseSensitive.checked = item.rule.caseSensitive; form.elements.useRegex.checked = item.rule.useRegex;
    form.elements.tags.value = item.tags.join(", "); form.elements.expiresAt.value = item.expiresAt ? item.expiresAt.slice(0, 16) : ""; form.elements.linkLabel.value = item.links[0]?.label || ""; form.elements.linkUrl.value = item.links[0]?.url || "";
  } else fillPageGroupOptions();
  togglePageScope();
  $("#memo-dialog").showModal();
}

function openPageGroup(id = null) {
  const form = $("#page-group-form"); form.reset();
  state.editingPageGroup = id ? state.data.pageGroups.find(item => item.id === id) : null;
  $("#page-group-dialog-title").textContent = id ? "编辑页面组" : "新建页面组";
  if (state.editingPageGroup) {
    form.elements.id.value = state.editingPageGroup.id;
    form.elements.name.value = state.editingPageGroup.name;
    form.elements.description.value = state.editingPageGroup.description || "";
    form.elements.sitePatterns.value = state.editingPageGroup.sitePatterns.join("\n");
  }
  $("#page-group-dialog").showModal();
}

function openTool(id = null) {
  const form = $("#tool-form"); form.reset();
  state.editingTool = id ? state.data.tools.find(item => item.id === id) : null;
  $("#tool-dialog-title").textContent = id ? "编辑工具链接" : "新建工具链接";
  if (state.editingTool) for (const name of ["id","title","category","url","description","icon","sortOrder","status"]) form.elements[name].value = state.editingTool[name] ?? "";
  if (state.editingTool) form.elements.targetGroupId.value = state.editingTool.targetGroupIds[0] || "";
  $("#tool-dialog").showModal();
}

$("#memo-form").addEventListener("submit", async event => {
  event.preventDefault(); const form = event.currentTarget; const data = new FormData(form);
  const pageScope = data.get("pageScope");
  const pageGroupIds = data.getAll("pageGroupIds");
  if (pageScope === "page_groups" && !pageGroupIds.length) return toast("请至少选择一个页面组");
  const payload = { scope: "organization", title: data.get("title"), body: data.get("body"), targetGroupIds: data.get("targetGroupId") ? [data.get("targetGroupId")] : [], priority: data.get("priority"), status: data.get("status"), expiresAt: data.get("expiresAt") ? new Date(data.get("expiresAt")).toISOString() : null, tags: data.get("tags").split(/[,，]/).map(x => x.trim()).filter(Boolean), links: data.get("linkUrl") ? [{ label: data.get("linkLabel") || data.get("linkUrl"), url: data.get("linkUrl") }] : [], rule: { pageScope, pageGroupIds, sitePatterns: [], includeTerms: splitLines(data.get("includeTerms")), excludeTerms: splitLines(data.get("excludeTerms")), operator: data.get("operator"), cooldownMinutes: Number(data.get("cooldownMinutes")), caseSensitive: data.get("caseSensitive") === "on", useRegex: data.get("useRegex") === "on" } };
  setSubmitting(form, true);
  try { await api(`/api/admin/memos${data.get("id") ? `/${data.get("id")}` : ""}`, { method: data.get("id") ? "PUT" : "POST", body: JSON.stringify(payload) }); $("#memo-dialog").close(); toast("组织提醒已保存"); await load(); } catch (error) { toast(error.message); } finally { setSubmitting(form, false); }
});

$("#page-group-form").addEventListener("submit", async event => {
  event.preventDefault(); const form = event.currentTarget; const data = new FormData(form);
  const payload = { name: data.get("name"), description: data.get("description"), sitePatterns: splitLines(data.get("sitePatterns")) };
  if (!payload.sitePatterns.length) return toast("请至少填写一个网址规则");
  setSubmitting(form, true);
  try { await api(`/api/admin/page-groups${data.get("id") ? `/${data.get("id")}` : ""}`, { method: data.get("id") ? "PUT" : "POST", body: JSON.stringify(payload) }); $("#page-group-dialog").close(); toast("页面组已保存"); await load(); } catch (error) { toast(error.message); } finally { setSubmitting(form, false); }
});

$("#tool-form").addEventListener("submit", async event => {
  event.preventDefault(); const form = event.currentTarget; const data = new FormData(form);
  const payload = { scope: "organization", title: data.get("title"), category: data.get("category"), url: data.get("url"), description: data.get("description"), icon: data.get("icon"), targetGroupIds: data.get("targetGroupId") ? [data.get("targetGroupId")] : [], sortOrder: Number(data.get("sortOrder")), status: data.get("status") };
  setSubmitting(form, true);
  try { await api(`/api/admin/tools${data.get("id") ? `/${data.get("id")}` : ""}`, { method: data.get("id") ? "PUT" : "POST", body: JSON.stringify(payload) }); $("#tool-dialog").close(); toast("工具链接已保存"); await load(); } catch (error) { toast(error.message); } finally { setSubmitting(form, false); }
});

document.addEventListener("click", async event => {
  const nav = event.target.closest("[data-view]"); if (nav) switchView(nav.dataset.view);
  const jump = event.target.closest("[data-jump]"); if (jump) switchView(jump.dataset.jump);
  if (event.target.closest("#primary-action")) state.view === "pagegroups" ? openPageGroup() : openMemo();
  if (event.target.closest("#new-tool")) openTool();
  if (event.target.closest("#new-page-group")) openPageGroup();
  const editMemo = event.target.closest("[data-edit-memo]"); if (editMemo) openMemo(editMemo.dataset.editMemo);
  const editTool = event.target.closest("[data-edit-tool]"); if (editTool) openTool(editTool.dataset.editTool);
  const editPageGroup = event.target.closest("[data-edit-page-group]"); if (editPageGroup) openPageGroup(editPageGroup.dataset.editPageGroup);
  const deleteMemo = event.target.closest("[data-delete-memo]"); if (deleteMemo && confirm("确认撤回这条组织提醒？")) { await api(`/api/admin/memos/${deleteMemo.dataset.deleteMemo}`, { method: "DELETE" }); toast("提醒已撤回"); await load(); }
  const deleteTool = event.target.closest("[data-delete-tool]"); if (deleteTool && confirm("确认撤回这个工具链接？")) { await api(`/api/admin/tools/${deleteTool.dataset.deleteTool}`, { method: "DELETE" }); toast("链接已撤回"); await load(); }
  const deletePageGroup = event.target.closest("[data-delete-page-group]"); if (deletePageGroup && confirm("确认删除这个页面组？")) { try { await api(`/api/admin/page-groups/${deletePageGroup.dataset.deletePageGroup}`, { method: "DELETE" }); toast("页面组已删除"); await load(); } catch (error) { toast(error.message); } }
  const close = event.target.closest("[data-close]"); if (close) $(`#${close.dataset.close}`).close();
});
$("#memo-search").addEventListener("input", renderMemos); $("#memo-status").addEventListener("change", renderMemos);
$("#memo-form").addEventListener("change", event => { if (event.target.name === "pageScope") togglePageScope(); });
const initialView = ["overview", "memos", "pagegroups", "tools", "groups"].includes(location.hash.slice(1)) ? location.hash.slice(1) : "overview";
switchView(initialView, false);
window.addEventListener("hashchange", () => { const view = location.hash.slice(1); if (["overview", "memos", "pagegroups", "tools", "groups"].includes(view)) switchView(view, false); });
load();
