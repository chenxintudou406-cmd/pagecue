(function () {
  if (window.__contextCompanionLoaded) return;
  window.__contextCompanionLoaded = true;

  const MAX_HIGHLIGHTS = 500;
  const BLOCKED_SELECTOR = "script,style,noscript,textarea,input,select,option,button,[contenteditable='true'],[contenteditable=''],.cc-toast,.cc-findbar,.cc-annotation-popover,.cc-annotation-pin,.cc-picker-toolbar,mark[data-cc-highlight]";
  let bootstrap = null;
  let scanTimer = null;
  let previousMatchIds = new Set();
  let currentMatchedMemos = [];
  let currentMatchDetails = new Map();
  let lastHighlightSignature = "";
  let highlighting = false;
  let externalDomChanged = true;
  let focusedMemoId = null;
  let currentHighlightIndex = -1;
  let lastStrategyTestCheckAt = 0;
  const reportedStrategyTests = new Set();
  const visibleToasts = new Map();
  const unresolvedAnchors = new Set();
  let pinEntries = [];
  let activePopoverTarget = null;

  function send(message) { return chrome.runtime.sendMessage(message).catch(() => null); }

  async function loadBootstrap(force = false) {
    const result = await send({ type: force ? "REFRESH_BOOTSTRAP" : "GET_BOOTSTRAP" });
    if (result?.bootstrap) bootstrap = result.bootstrap;
    return bootstrap;
  }

  const SCANNABLE_FIELD_SELECTOR = 'input:not([type]), input[type="text"], input[type="search"]';
  const PAGECUE_UI_SELECTOR = ".cc-toast,.cc-findbar,.cc-annotation-popover,.cc-annotation-pin,.cc-picker-toolbar";

  function isScannableField(field) {
    if (!(field instanceof HTMLInputElement) || !field.matches(SCANNABLE_FIELD_SELECTOR)) return false;
    if (!field.value?.trim() || field.getClientRects().length === 0 || field.closest(PAGECUE_UI_SELECTOR)) return false;
    const identity = `${field.type || ""} ${field.name || ""} ${field.id || ""} ${field.autocomplete || ""}`.toLowerCase();
    if (/(password|passwd|pwd|token|secret|credential|one-time-code|otp|captcha)/.test(identity)) return false;
    return !field.form?.querySelector('input[type="password"]');
  }

  function readableText(root = document.body, limit = 2_000_000) {
    if (!root) return "";
    const fieldValues = root.querySelectorAll
      ? [...root.querySelectorAll(SCANNABLE_FIELD_SELECTOR)].filter(isScannableField).map(field => field.value.trim())
      : [];
    return [root.innerText || "", ...fieldValues].filter(Boolean).join("\n").slice(0, limit);
  }

  function pageText() {
    return readableText(document.body);
  }

  function strategyForRule(rule = {}) {
    return ContextRuleEngine.resolvePageStrategy(rule, location.href);
  }

  function collectMatchUnits(rule = {}) {
    const strategy = strategyForRule(rule);
    if (strategy.matchScope === "page") {
      return { strategy, selectorValid: true, units: document.body ? [{ root: document.body, text: pageText(), index: 0 }] : [], error: null };
    }
    if (!strategy.selector) return { strategy, selectorValid: false, units: [], error: "missing_selector" };
    try {
      const roots = [...document.querySelectorAll(strategy.selector)];
      const units = roots.filter(root => {
        if (!(root instanceof Element) || root.closest(BLOCKED_SELECTOR) || root.getClientRects().length === 0) return false;
        if (strategy.excludeSelector && (root.matches(strategy.excludeSelector) || root.closest(strategy.excludeSelector))) return false;
        return Boolean(readableText(root, 200_000).trim());
      }).map((root, index) => ({ root, text: readableText(root, 200_000), index }));
      return { strategy, selectorValid: true, units, error: null };
    } catch (error) {
      return { strategy, selectorValid: false, units: [], error: error.message || "invalid_selector" };
    }
  }

  function memoIsActive(memo, now = Date.now()) {
    if (memo.status && memo.status !== "published") return false;
    if (memo.startsAt && Date.parse(memo.startsAt) > now) return false;
    if (memo.expiresAt && Date.parse(memo.expiresAt) <= now) return false;
    return true;
  }

  function evaluateMemoOnPage(memo) {
    const collected = collectMatchUnits(memo.rule || {});
    const unitResult = ContextRuleEngine.evaluateRuleUnits(memo.rule || {}, collected.units, { url: location.href });
    const matchedUnits = unitResult.matchedUnitIndexes.map(index => collected.units[index]).filter(Boolean);
    return { memo, ...collected, result: unitResult, matchedUnits };
  }

  function evaluateCurrentMemos(memos = []) {
    const details = new Map();
    for (const memo of memos) {
      if (!memoIsActive(memo)) continue;
      const detail = evaluateMemoOnPage(memo);
      if (detail.result.matched) details.set(memo.id, detail);
    }
    currentMatchDetails = details;
    currentMatchedMemos = memos.filter(memo => details.has(memo.id));
    return currentMatchedMemos;
  }

  function memoMatchSignature(memo) {
    const detail = currentMatchDetails.get(memo.id);
    if (!detail) return "";
    return detail.matchedUnits.map(unit => `${unit.index}:${ContextRuleEngine.matchSignature(memo.rule || {}, { text: unit.text })}`).join(";");
  }

  function domain() { try { return location.hostname; } catch { return ""; } }
  function escapeRegex(value) { return value.replace(/[|\\{}()[\]^$+?.*]/g, "\\$&"); }
  function templateRank(template) { return ({ light: 1, standard: 2, medium: 2, strong: 3, heavy: 3 })[template] || 2; }
  function normalizeTemplate(template) { return template === "medium" ? "standard" : template === "heavy" ? "strong" : template; }
  function memoTemplate(memo) { return normalizeTemplate(memo?.annotation?.template || memo?.intensity) || (memo?.priority === "important" ? "strong" : memo?.scope === "personal" ? "light" : "standard"); }
  function memoById(id) { return bootstrap?.memos?.find(memo => memo.id === id) || currentMatchedMemos.find(memo => memo.id === id); }
  function markMemoIds(mark) { return String(mark?.dataset?.memoIds || mark?.dataset?.memoId || "").split(",").filter(Boolean); }
  function memoTypeLabel(memo) { return memo?.type === "operation" ? "操作提醒" : "知识提醒"; }
  function memoLevelLabel(memo) { return ({ light: "轻", standard: "中", strong: "重" })[memoTemplate(memo)] || "中"; }
  function memoTypeIcon(memo) {
    return memo?.type === "operation"
      ? `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" aria-hidden="true"><path d="M9 5H6a2 2 0 0 0-2 2v12a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-3M9 5a3 3 0 0 1 6 0m-6 0a3 3 0 0 0 6 0m-6 0h6m3-2 3 3-8 8-4 1 1-4 8-8Z"/></svg>`
      : `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" aria-hidden="true"><path d="M4 5.5A2.5 2.5 0 0 1 6.5 3H11v16H6.5A2.5 2.5 0 0 0 4 21.5v-16ZM20 5.5A2.5 2.5 0 0 0 17.5 3H13v16h4.5a2.5 2.5 0 0 1 2.5 2.5v-16Z"/></svg>`;
  }

  function createTermRegex(term, rule) {
    try {
      const source = rule.useRegex ? term : escapeRegex(term);
      const regex = new RegExp(source, rule.caseSensitive ? "g" : "gi");
      if (regex.test("")) return null;
      regex.lastIndex = 0;
      return regex;
    } catch { return null; }
  }

  function clearHighlights() {
    document.querySelectorAll("mark[data-cc-highlight]").forEach(mark => {
      const parent = mark.parentNode;
      mark.replaceWith(document.createTextNode(mark.textContent || ""));
      parent?.normalize();
    });
    document.querySelectorAll(".cc-match-unit").forEach(root => root.classList.remove("cc-match-unit"));
  }

  function textNodes(root = document.body) {
    const nodes = [];
    if (!root) return nodes;
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
      acceptNode(node) {
        const parent = node.parentElement;
        if (!parent || !node.nodeValue?.trim() || parent.closest(BLOCKED_SELECTOR)) return NodeFilter.FILTER_REJECT;
        if (parent.getClientRects().length === 0) return NodeFilter.FILTER_REJECT;
        return NodeFilter.FILTER_ACCEPT;
      }
    });
    while (walker.nextNode()) nodes.push(walker.currentNode);
    return nodes;
  }

  function highlightEntry(entry, remaining) {
    const regex = createTermRegex(entry.term, entry.rule);
    if (!regex || remaining <= 0) return 0;
    let created = 0;
    for (const node of textNodes(entry.root)) {
      if (created >= remaining) break;
      const text = node.nodeValue || "";
      regex.lastIndex = 0;
      let match;
      let cursor = 0;
      let changed = false;
      const fragment = document.createDocumentFragment();
      while ((match = regex.exec(text)) && created < remaining) {
        if (!match[0]) break;
        fragment.append(document.createTextNode(text.slice(cursor, match.index)));
        const mark = document.createElement("mark");
        mark.dataset.ccHighlight = "true";
        mark.dataset.memoId = entry.memoIds[0];
        mark.dataset.memoIds = entry.memoIds.join(",");
        mark.dataset.term = entry.term;
        mark.classList.add(`cc-template-${entry.template}`);
        if (entry.types.includes("operation")) mark.classList.add("cc-operation-highlight");
        mark.tabIndex = 0;
        mark.setAttribute("role", "button");
        mark.setAttribute("aria-label", `匹配关键词：${match[0]}`);
        mark.textContent = match[0];
        fragment.append(mark);
        cursor = match.index + match[0].length;
        created += 1;
        changed = true;
      }
      if (changed) {
        fragment.append(document.createTextNode(text.slice(cursor)));
        node.replaceWith(fragment);
      }
    }
    return created;
  }

  function allHighlights(memoId = null) {
    const marks = [...document.querySelectorAll("mark[data-cc-highlight]")];
    return memoId ? marks.filter(mark => markMemoIds(mark).includes(memoId)) : marks;
  }

  function ensureAnnotationPopover() {
    let popover = document.querySelector(".cc-annotation-popover");
    if (popover) return popover;
    popover = document.createElement("aside");
    popover.className = "cc-annotation-popover";
    popover.setAttribute("role", "dialog");
    popover.setAttribute("aria-label", "页面批注");
    popover.innerHTML = `<button class="cc-popover-close" type="button" data-cc-popover-close aria-label="关闭">×</button><div class="cc-popover-list" data-cc-popover-list></div>`;
    popover.querySelector("[data-cc-popover-close]").addEventListener("click", () => hideAnnotationPopover());
    popover.addEventListener("click", async event => {
      const businessLink = event.target.closest("[data-cc-business-link]");
      if (businessLink) {
        send({ type: "TRACK_EVENT", memoId: businessLink.dataset.memoId, domain: domain(), action: "opened", presentation: "annotation_link" });
        return;
      }
      const copyLink = event.target.closest("[data-cc-copy-link]");
      if (copyLink) {
        const copied = await copyText(copyLink.dataset.ccCopyLink);
        copyLink.textContent = copied ? "已复制" : "复制失败";
        if (copied) send({ type: "TRACK_EVENT", memoId: copyLink.dataset.memoId, domain: domain(), action: "link_copied", presentation: "annotation_link" });
        return;
      }
      const action = event.target.closest("[data-cc-popover-action]");
      if (!action) return;
      const memoId = action.dataset.memoId;
      const type = action.dataset.ccPopoverAction;
      if (type === "open") await send({ type: "OPEN_MEMO", memoId, domain: domain() });
      if (type === "supplier") await showSupplierCard(action.dataset.supplierId);
      if (type === "comments") await toggleCardComments(action.closest(".cc-card"), memoId);
      if (type === "locate") {
        const result = await focusMemoFresh(memoId);
        if (result.found) hideAnnotationPopover();
        else {
          const match = action.closest(".cc-popover-card")?.querySelector(".cc-match");
          if (match) match.textContent = result.reason === "no_keywords" ? "没有设置定位关键词" : `未找到：${result.terms?.join("、") || "对应关键词"}`;
        }
      }
      if (["confirmed", "snoozed"].includes(type)) {
        await send({ type: "MATCH_ACTION", memoId, domain: domain(), action: type, minutes: 60 });
        visibleToasts.get(memoId)?.remove(); visibleToasts.delete(memoId);
        hideAnnotationPopover();
      }
    });
    document.documentElement.appendChild(popover);
    return popover;
  }

  function hideAnnotationPopover() {
    const popover = document.querySelector(".cc-annotation-popover");
    popover?.classList.remove("cc-popover-show");
    activePopoverTarget = null;
  }

  function openAnnotationPopover(target, memoIds, anchorId = "") {
    const memos = memoIds.map(memoById).filter(Boolean).sort((a,b) => templateRank(memoTemplate(b)) - templateRank(memoTemplate(a)));
    if (!memos.length) return;
    const popover = ensureAnnotationPopover();
    popover.querySelector("[data-cc-popover-list]").innerHTML = memos.map(memo => {
      const template = memoTemplate(memo);
      const terms = memo.rule?.includeTerms?.join("、") || "页面规则";
      const primaryLink = (memo.links || []).find(link => /^https?:\/\//i.test(link.url || ""));
      const supplierRef = (memo.entityRefs || []).find(ref => ref.type === "supplier");
      const openAction = primaryLink
        ? `<div class="cc-link-actions"><a class="cc-card-link" href="${escapeHtml(primaryLink.url)}" target="_blank" rel="noopener noreferrer" data-cc-business-link data-memo-id="${memo.id}">查看具体信息<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true"><path d="M7 17 17 7M8 7h9v9"/></svg></a><button class="cc-copy-link" type="button" data-cc-copy-link="${escapeHtml(primaryLink.url)}" data-memo-id="${memo.id}">复制链接</button></div>`
        : `<button class="cc-card-link cc-link-button" type="button" data-cc-popover-action="open" data-memo-id="${memo.id}">查看详情</button>`;
      const supplierAction = supplierRef ? `<button class="cc-card-link cc-link-button" type="button" data-cc-popover-action="supplier" data-supplier-id="${escapeHtml(supplierRef.id)}" data-memo-id="${memo.id}">查看供应商</button>` : "";
      const owner = memo.type === "operation" ? `负责：${bootstrap?.user?.name || "我"}` : memo.scope === "personal" ? "我的知识" : "组织知识";
      return `<article class="cc-popover-card cc-card cc-template-${template} ${memo.type === "operation" ? "cc-operation-card" : "cc-knowledge-card"}"><header class="cc-card-head"><span class="cc-type"><span class="cc-type-icon">${memoTypeIcon(memo)}</span>${memoTypeLabel(memo)}</span><span class="cc-level-pill">${memoLevelLabel(memo)}</span></header><div class="cc-card-content"><strong>${escapeHtml(memo.title)}</strong><p>${escapeHtml(memo.body.replace(/[*#`]/g, "").slice(0, 130))}</p><div class="cc-meta"><span>${owner}</span><i></i><span class="cc-match">命中：${escapeHtml(terms)}</span><i></i><span>${memo.commentCount || 0} 条评论</span></div></div><footer class="cc-card-footer"><div class="cc-link-actions">${supplierAction}${openAction}</div><div class="cc-actions"><button type="button" data-cc-popover-action="comments" data-memo-id="${memo.id}">评论</button><button type="button" data-cc-popover-action="locate" data-memo-id="${memo.id}">定位</button><button class="cc-primary-action" type="button" data-cc-popover-action="confirmed" data-memo-id="${memo.id}">${memo.type === "operation" ? "完成了" : "知道了"}</button></div></footer></article>`;
    }).join("");
    const rect = target.getBoundingClientRect();
    const width = Math.min(360, window.innerWidth - 20);
    popover.style.width = `${width}px`;
    popover.style.left = `${Math.max(10, Math.min(window.innerWidth - width - 10, rect.left))}px`;
    const estimatedHeight = Math.min(560, 220 * memos.length);
    popover.style.top = `${Math.max(10, rect.bottom + estimatedHeight > window.innerHeight ? rect.top - estimatedHeight - 10 : rect.bottom + 10)}px`;
    popover.classList.add("cc-popover-show");
    activePopoverTarget = target;
    for (const memo of memos) send({ type: "TRACK_EVENT", memoId: memo.id, domain: domain(), action: "annotation_opened", presentation: anchorId ? "element_anchor" : "keyword", anchorId });
  }

  function escapeHtml(value = "") {
    return String(value).replace(/[&<>'"]/g, char => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", "'": "&#39;", '"': "&quot;" })[char]);
  }

  async function copyText(value) {
    try {
      await navigator.clipboard.writeText(String(value || ""));
      return true;
    } catch {
      const input = document.createElement("textarea");
      input.value = String(value || "");
      input.style.cssText = "position:fixed;left:-9999px;top:0";
      document.documentElement.appendChild(input);
      input.select();
      const copied = document.execCommand("copy");
      input.remove();
      return copied;
    }
  }

  function renderCardComments(panel, memoId, comments = []) {
    const rows = comments.length ? comments.map(comment => `<article><div><strong>${escapeHtml(comment.userName || "成员")}</strong><time>${comment.createdAt ? new Date(comment.createdAt).toLocaleString("zh-CN", { hour12: false }) : ""}</time></div><p>${escapeHtml(comment.content)}</p>${comment.canDelete ? `<button type="button" data-cc-delete-comment="${escapeHtml(comment.id)}">删除</button>` : ""}</article>`).join("") : `<div class="cc-comments-empty">还没有评论</div>`;
    panel.innerHTML = `<div class="cc-comment-list">${rows}</div><form data-cc-comment-form><textarea name="content" maxlength="2000" rows="2" required placeholder="写下评论…"></textarea><button type="submit">发送</button></form>`;
    panel.querySelector("form").addEventListener("submit", async event => {
      event.preventDefault(); const form = event.currentTarget; const content = form.elements.content.value.trim(); if (!content) return;
      const button = form.querySelector("button"); button.disabled = true;
      try { await send({ type: "ADD_MEMO_COMMENT", memoId, content }); const result = await send({ type: "GET_MEMO_COMMENTS", memoId }); renderCardComments(panel, memoId, result.comments || []); } catch { button.disabled = false; }
    });
    panel.querySelectorAll("[data-cc-delete-comment]").forEach(button => button.addEventListener("click", async () => { await send({ type: "DELETE_MEMO_COMMENT", commentId: button.dataset.ccDeleteComment }); const result = await send({ type: "GET_MEMO_COMMENTS", memoId }); renderCardComments(panel, memoId, result.comments || []); }));
  }

  async function toggleCardComments(card, memoId) {
    if (!card) return;
    const existing = card.querySelector(".cc-inline-comments");
    if (existing) { existing.remove(); return; }
    const panel = document.createElement("section"); panel.className = "cc-inline-comments"; panel.innerHTML = `<div class="cc-comments-empty">正在加载评论…</div>`;
    card.querySelector(".cc-card-content")?.appendChild(panel);
    try { const result = await send({ type: "GET_MEMO_COMMENTS", memoId }); renderCardComments(panel, memoId, result.comments || []); } catch (error) { panel.innerHTML = `<div class="cc-comments-empty">${escapeHtml(error.message || "评论加载失败")}</div>`; }
  }

  function supplierMetric(label, value) { return `<div><b>${Number(value || 0)}%</b><span>${label}</span></div>`; }

  async function showSupplierCard(supplierId) {
    if (!supplierId) return;
    document.querySelector(".cc-supplier-scrim")?.remove();
    const scrim = document.createElement("div");
    scrim.className = "cc-supplier-scrim";
    scrim.innerHTML = `<aside class="cc-supplier-card" role="dialog" aria-modal="true" aria-label="供应商资料"><div class="cc-supplier-loading">正在读取供应商资料…</div></aside>`;
    document.documentElement.appendChild(scrim);
    const close = () => scrim.remove();
    scrim.addEventListener("click", event => { if (event.target === scrim || event.target.closest("[data-cc-supplier-close]")) close(); });
    try {
      const supplier = await send({ type: "GET_SUPPLIER", supplierId });
      if (!supplier || supplier.error) throw new Error(supplier?.error || "供应商资料读取失败");
      const contact = supplier.contact || {}; const metrics = supplier.metrics || {};
      const products = (supplier.advantageProducts || []).slice(0, 6);
      const evaluation = (items, title) => items?.length ? `<section class="cc-supplier-section"><h3>${title}</h3>${items.slice(0, 3).map(item => `<blockquote><p>${escapeHtml(item.content)}</p><footer>${escapeHtml(item.contributor || "未署名")} · ${item.at ? new Date(item.at).toLocaleDateString("zh-CN") : "未记录时间"}</footer></blockquote>`).join("")}</section>` : "";
      scrim.querySelector(".cc-supplier-card").innerHTML = `<header class="cc-supplier-head"><div><span>供应商资料</span><button type="button" data-copy-value="${escapeHtml(supplier.companyName)}">${escapeHtml(supplier.companyName)}</button><button type="button" data-copy-value="${escapeHtml(supplier.customerId)}">客户 ID · ${escapeHtml(supplier.customerId)}</button></div><button class="cc-supplier-close" type="button" data-cc-supplier-close aria-label="关闭">×</button></header><div class="cc-supplier-body"><section class="cc-supplier-contact"><div><span>联系人</span><b>${escapeHtml(contact.name || "未填写")}</b><small>${escapeHtml(contact.title || "未填写岗位")}</small></div><div><span>联系方式</span><b>${escapeHtml(contact.phone || "未填写")}</b><small>${escapeHtml(contact.email || "未填写邮箱")}</small></div></section><section class="cc-supplier-metrics"><div class="cc-supplier-metric-title"><h3>业务数据</h3><span>${escapeHtml(metrics.periodLabel || "近12个月")}</span></div><div class="cc-supplier-metric-grid">${supplierMetric("产品数排序", metrics.productPercentile)}${supplierMetric("订单数排序", metrics.orderPercentile)}${supplierMetric("成交率", metrics.closeRate)}${supplierMetric("报价率", metrics.quoteRate)}${supplierMetric("售后率", metrics.afterSalesRate)}</div></section>${products.length ? `<section class="cc-supplier-section"><h3>优势产品</h3><div class="cc-supplier-products"><div><b>产品</b><b>CAS</b><b>成交率</b></div>${products.map(item => `<div><span>${escapeHtml(item.name || "-")}</span><span>${escapeHtml(item.cas || "-")}</span><strong>${Number(item.closeRate || 0)}%</strong></div>`).join("")}</div></section>` : ""}${evaluation(supplier.evaluations?.shortTerm, "短期评价")}${evaluation(supplier.evaluations?.longTerm, "长期评价")}</div><footer class="cc-supplier-foot"><span>资料由组织后台维护</span><button type="button" data-cc-supplier-close>关闭</button></footer>`;
      scrim.querySelectorAll("[data-copy-value]").forEach(button => button.addEventListener("click", async () => { const copied = await copyText(button.dataset.copyValue); if (copied) { const original = button.textContent; button.textContent = "已复制"; setTimeout(() => { if (button.isConnected) button.textContent = original; }, 1200); } }));
    } catch (error) {
      scrim.querySelector(".cc-supplier-card").innerHTML = `<div class="cc-supplier-error"><b>无法打开供应商资料</b><p>${escapeHtml(error.message)}</p><button type="button" data-cc-supplier-close>关闭</button></div>`;
    }
  }

  function ensureFindBar() {
    let bar = document.querySelector(".cc-findbar");
    if (bar) return bar;
    bar = document.createElement("aside");
    bar.className = "cc-findbar";
    bar.setAttribute("role", "region");
    bar.setAttribute("aria-label", "关键词匹配定位");
    bar.innerHTML = `<div class="cc-find-copy"><strong>关键词匹配</strong><span data-cc-find-term></span></div><span class="cc-find-count" data-cc-find-count>0 / 0</span><button type="button" data-cc-find="prev" aria-label="上一个匹配">↑</button><button type="button" data-cc-find="next" aria-label="下一个匹配">↓</button><button type="button" data-cc-find="close" aria-label="关闭定位">×</button>`;
    bar.querySelector('[data-cc-find="prev"]').addEventListener("click", () => focusHighlight(currentHighlightIndex - 1, focusedMemoId));
    bar.querySelector('[data-cc-find="next"]').addEventListener("click", () => focusHighlight(currentHighlightIndex + 1, focusedMemoId));
    bar.querySelector('[data-cc-find="close"]').addEventListener("click", () => {
      bar.classList.remove("cc-findbar-show");
      allHighlights().forEach(mark => mark.classList.remove("cc-keyword-active"));
      currentHighlightIndex = -1;
    });
    document.documentElement.appendChild(bar);
    return bar;
  }

  function updateFindBar(marks, activeMark = null) {
    const bar = ensureFindBar();
    const index = activeMark ? marks.indexOf(activeMark) : currentHighlightIndex;
    bar.querySelector("[data-cc-find-count]").textContent = marks.length ? `${index + 1} / ${marks.length}` : "0 / 0";
    bar.querySelector("[data-cc-find-term]").textContent = activeMark?.dataset.term || marks[0]?.dataset.term || "";
    bar.classList.toggle("cc-findbar-show", marks.length > 0);
  }

  function focusHighlight(index = 0, memoId = null) {
    focusedMemoId = memoId || null;
    const marks = allHighlights(focusedMemoId);
    if (!marks.length) return false;
    currentHighlightIndex = ((index % marks.length) + marks.length) % marks.length;
    allHighlights().forEach(mark => mark.classList.remove("cc-keyword-active"));
    const active = marks[currentHighlightIndex];
    active.classList.add("cc-keyword-active");
    const reduceMotion = window.matchMedia?.("(prefers-reduced-motion: reduce)").matches;
    active.scrollIntoView({ behavior: reduceMotion ? "auto" : "smooth", block: "center", inline: "nearest" });
    active.focus({ preventScroll: true });
    updateFindBar(marks, active);
    return true;
  }

  function bindHighlightClicks() {
    allHighlights().forEach(mark => {
      mark.addEventListener("click", event => {
        event.preventDefault();
        event.stopPropagation();
        const memoId = mark.dataset.memoId || null;
        const marks = allHighlights(memoId);
        focusHighlight(marks.indexOf(mark), memoId);
        openAnnotationPopover(mark, markMemoIds(mark));
      });
      mark.addEventListener("keydown", event => {
        if (event.key === "Enter" || event.key === " ") mark.click();
      });
    });
  }

  function renderHighlights(memos, signature) {
    highlighting = true;
    clearHighlights();
    let created = 0;
    const seen = new Set();
    const entries = [];
    const orderedMemos = [...memos].sort((a,b) => templateRank(memoTemplate(b)) - templateRank(memoTemplate(a)));
    for (const memo of orderedMemos) {
      const detail = currentMatchDetails.get(memo.id);
      const units = detail?.matchedUnits || [];
      if (detail?.strategy.matchScope !== "page") units.forEach(unit => unit.root.classList.add("cc-match-unit"));
      for (const unit of units) {
        const terms = memo.annotation?.keywordTerms?.length ? memo.annotation.keywordTerms : (memo.rule?.includeTerms || []);
        for (const term of terms) {
          const key = `${unit.index}|${term}|${Boolean(memo.rule?.useRegex)}|${Boolean(memo.rule?.caseSensitive)}`;
          if (!term) continue;
          const existing = entries.find(entry => entry.root === unit.root && entry.term === term && Boolean(entry.rule.useRegex) === Boolean(memo.rule?.useRegex) && Boolean(entry.rule.caseSensitive) === Boolean(memo.rule?.caseSensitive));
          if (existing) {
            if (!existing.memoIds.includes(memo.id)) existing.memoIds.push(memo.id);
            if (!existing.types.includes(memo.type || "knowledge")) existing.types.push(memo.type || "knowledge");
            if (templateRank(memoTemplate(memo)) > templateRank(existing.template)) existing.template = memoTemplate(memo);
          } else {
            seen.add(key);
            entries.push({ memoIds: [memo.id], types: [memo.type || "knowledge"], term, template: memoTemplate(memo), rule: memo.rule || {}, root: unit.root });
          }
        }
      }
    }
    for (const entry of entries) {
      created += highlightEntry(entry, MAX_HIGHLIGHTS - created);
      if (created >= MAX_HIGHLIGHTS) break;
    }
    bindHighlightClicks();
    const bar = document.querySelector(".cc-findbar");
    if (bar && !created) bar.classList.remove("cc-findbar-show");
    lastHighlightSignature = signature;
    externalDomChanged = false;
    requestAnimationFrame(() => { highlighting = false; });
  }

  function focusMemo(memoId) {
    if (!allHighlights(memoId).length && currentMatchedMemos.length) renderHighlights(currentMatchedMemos, lastHighlightSignature);
    return focusHighlight(0, memoId);
  }

  async function focusMemoFresh(memoId) {
    if (!bootstrap) await loadBootstrap();
    const memo = bootstrap?.memos?.find(item => item.id === memoId);
    if (!memo) return { found: false, reason: "memo_missing", terms: [] };

    const terms = (memo.rule?.includeTerms || []).filter(Boolean);
    if (!terms.length) return { found: false, reason: "no_keywords", terms: [] };

    const detail = evaluateMemoOnPage(memo);
    if (!detail.result.matched) return { found: false, reason: detail.result.reason || "missing", terms };

    evaluateCurrentMemos(bootstrap.memos);
    const signature = currentMatchedMemos.map(item => `${item.id}:${memoMatchSignature(item)}`).sort().join("|");
    renderHighlights(currentMatchedMemos, signature);
    const found = focusMemo(memoId);
    const marks = allHighlights(memoId);
    return {
      found,
      reason: found ? "located" : "not_renderable",
      terms,
      count: marks.length,
      term: marks[0]?.dataset.term || detail.result.terms?.[0] || terms[0]
    };
  }

  function wildcardMatch(value, pattern) {
    if (!pattern) return true;
    try { return new RegExp(`^${escapeRegex(pattern).replace(/\\\*/g, ".*")}$`, "i").test(value); }
    catch { return false; }
  }

  async function fingerprintElement(element) {
    const attrs = ["id", "name", "role", "data-testid", "data-qa"].map(name => `${name}=${element.getAttribute?.(name) || ""}`).join("|");
    const text = String(element.textContent || "").replace(/\s+/g, " ").trim().slice(0, 500);
    const payload = `${element.tagName || ""}|${attrs}|${text}`;
    if (!crypto?.subtle) return "";
    const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(payload));
    return [...new Uint8Array(digest)].map(value => value.toString(16).padStart(2, "0")).join("");
  }

  function queryAnchor(root, selector) {
    if (!selector) return [];
    if (selector === "__pagecue_self__") return root instanceof Element ? [root] : [];
    try { return [...root.querySelectorAll(selector)].filter(element => element.getClientRects().length > 0); }
    catch { return []; }
  }

  async function verifiedCandidates(root, anchor) {
    let candidates = queryAnchor(root, anchor.primarySelector);
    if (candidates.length !== 1 && anchor.fallbackSelector) candidates = queryAnchor(root, anchor.fallbackSelector);
    if (candidates.length !== 1) return [];
    if (anchor.fingerprintHash && await fingerprintElement(candidates[0]) !== anchor.fingerprintHash) return [];
    return candidates;
  }

  function clearElementPins() {
    pinEntries.forEach(entry => { entry.button.remove(); entry.target.classList.remove("cc-anchor-target", "cc-anchor-strong"); });
    pinEntries = [];
  }

  function positionElementPins() {
    for (const entry of pinEntries) {
      if (!entry.target.isConnected || entry.target.getClientRects().length === 0) { entry.button.hidden = true; continue; }
      entry.button.hidden = false;
      const rect = entry.target.getBoundingClientRect();
      entry.button.style.left = `${Math.max(4, Math.min(window.innerWidth - 32, rect.right - 12))}px`;
      entry.button.style.top = `${Math.max(4, Math.min(window.innerHeight - 32, rect.top - 10))}px`;
    }
    if (activePopoverTarget && activePopoverTarget.isConnected) {
      const popover = document.querySelector(".cc-annotation-popover.cc-popover-show");
      if (popover) {
        const rect = activePopoverTarget.getBoundingClientRect();
        popover.style.left = `${Math.max(10, Math.min(window.innerWidth - popover.offsetWidth - 10, rect.left))}px`;
      }
    }
  }

  async function renderElementPins(memos) {
    clearElementPins();
    for (const memo of memos) {
      const detail = currentMatchDetails.get(memo.id);
      const anchors = memo.annotation?.anchors || [];
      for (const anchor of anchors) {
        if (!wildcardMatch(`${location.origin}${location.pathname}`, anchor.pathPattern)) continue;
        if (anchor.pageGroupId && detail?.strategy?.pageGroupId !== anchor.pageGroupId) continue;
        const roots = anchor.relativeToMatchUnit ? detail.matchedUnits.map(unit => unit.root) : [document];
        let resolved = 0;
        for (const root of roots) {
          const candidates = await verifiedCandidates(root, anchor);
          if (candidates.length !== 1) continue;
          const target = candidates[0];
          const button = document.createElement("button");
          button.type = "button";
          button.className = `cc-annotation-pin cc-template-${memoTemplate(memo)}${memo.type === "operation" ? " cc-operation-pin" : ""}`;
          button.textContent = String(Number(anchor.order || 0) + 1);
          button.setAttribute("aria-label", `${anchor.label}，打开批注`);
          button.addEventListener("click", event => { event.preventDefault(); event.stopPropagation(); openAnnotationPopover(button, [memo.id], anchor.id); });
          document.documentElement.appendChild(button);
          target.classList.add("cc-anchor-target");
          if (memoTemplate(memo) === "strong") target.classList.add("cc-anchor-strong");
          pinEntries.push({ button, target, memoId: memo.id, anchorId: anchor.id });
          resolved += 1;
        }
        const unresolvedKey = `${memo.id}|${anchor.id}|${location.origin}${location.pathname}`;
        if (!resolved && !unresolvedAnchors.has(unresolvedKey)) {
          unresolvedAnchors.add(unresolvedKey);
          send({ type: "TRACK_EVENT", memoId: memo.id, domain: domain(), action: "annotation_unresolved", presentation: "element_anchor", anchorId: anchor.id });
        }
      }
    }
    positionElementPins();
  }

  function cssEscape(value) {
    if (globalThis.CSS?.escape) return CSS.escape(value);
    return String(value).replace(/[^a-zA-Z0-9_-]/g, char => `\\${char}`);
  }

  function selectorIsUnique(root, selector, element) {
    try { const matches = root.querySelectorAll(selector); return matches.length === 1 && matches[0] === element; }
    catch { return false; }
  }

  function structuralSelector(element, root) {
    if (element === root) return "__pagecue_self__";
    const parts = [];
    let current = element;
    while (current && current !== root && current.nodeType === 1 && parts.length < 6) {
      const tag = current.tagName.toLowerCase();
      const siblings = current.parentElement ? [...current.parentElement.children].filter(item => item.tagName === current.tagName) : [];
      parts.unshift(siblings.length > 1 ? `${tag}:nth-of-type(${siblings.indexOf(current) + 1})` : tag);
      current = current.parentElement;
    }
    return parts.join(" > ");
  }

  function generateSelectors(element, root) {
    if (element === root) return { primarySelector: "__pagecue_self__", fallbackSelector: "__pagecue_self__" };
    if (root === document && element.id) {
      const selector = `#${cssEscape(element.id)}`;
      if (selectorIsUnique(root, selector, element)) return { primarySelector: selector, fallbackSelector: structuralSelector(element, document.body) };
    }
    for (const name of ["data-testid", "data-qa", "name"]) {
      const value = element.getAttribute(name);
      if (!value) continue;
      const selector = `${element.tagName.toLowerCase()}[${name}="${cssEscape(value)}"]`;
      if (selectorIsUnique(root, selector, element)) return { primarySelector: selector, fallbackSelector: structuralSelector(element, root) };
    }
    const classes = [...element.classList].filter(name => !name.startsWith("cc-")).slice(0, 2);
    if (classes.length) {
      const selector = `${element.tagName.toLowerCase()}.${classes.map(cssEscape).join(".")}`;
      if (selectorIsUnique(root, selector, element)) return { primarySelector: selector, fallbackSelector: structuralSelector(element, root) };
    }
    const structural = structuralSelector(element, root);
    return { primarySelector: structural, fallbackSelector: structural };
  }

  async function startAnnotationPicker(code, options = {}) {
    const session = await send({ type: "GET_ANNOTATION_SESSION", code });
    if (!session || session.error || session.status !== "pending") return false;
    let targetUrl;
    try { targetUrl = new URL(session.url); } catch { return false; }
    if (targetUrl.origin !== location.origin || targetUrl.pathname !== location.pathname) return false;
    const strategy = session.pageGroup?.strategy || { matchScope: "page" };
    const relative = options.relative === true || (options.relative === undefined && ["module", "row"].includes(strategy.matchScope));
    const label = String(options.label || "页面批注").slice(0, 120);
    const toolbar = document.createElement("aside");
    toolbar.className = "cc-picker-toolbar";
    toolbar.innerHTML = `<strong>网页标记模式</strong><span>点击需要批注的元素；按 Esc 取消</span><button type="button">取消</button>`;
    document.documentElement.appendChild(toolbar);
    let hovered = null;
    let finished = false;
    const cleanup = () => {
      finished = true;
      hovered?.classList.remove("cc-picker-target");
      document.removeEventListener("mouseover", onHover, true);
      document.removeEventListener("click", onClick, true);
      document.removeEventListener("keydown", onKey, true);
      toolbar.remove();
    };
    const onHover = event => {
      const candidate = event.target instanceof Element ? event.target : null;
      if (!candidate || candidate.closest(".cc-picker-toolbar,.cc-toast,.cc-findbar,.cc-annotation-popover,.cc-annotation-pin")) return;
      hovered?.classList.remove("cc-picker-target");
      hovered = candidate;
      hovered.classList.add("cc-picker-target");
    };
    const onClick = async event => {
      if (finished || !hovered || event.target.closest(".cc-picker-toolbar")) return;
      event.preventDefault(); event.stopPropagation(); event.stopImmediatePropagation();
      finished = true;
      toolbar.innerHTML = `<strong>正在保存批注</strong><span>正在生成稳定锚点，请稍候</span>`;
      let root = document;
      if (relative && strategy.selector) {
        try { root = hovered.closest(strategy.selector) || document; } catch { root = document; }
      }
      const selectors = generateSelectors(hovered, root);
      const anchor = {
        label,
        pageGroupId: session.pageGroupId,
        pathPattern: `${location.origin}${location.pathname}`,
        ...selectors,
        fingerprintHash: await fingerprintElement(hovered),
        relativeToMatchUnit: relative,
        order: session.memo?.annotation?.anchors?.length || 0
      };
      const result = await send({ type: "COMPLETE_ANNOTATION_SESSION", sessionId: session.id, code, anchor });
      if (!result?.ok) {
        finished = false;
        toolbar.innerHTML = `<strong>保存失败</strong><span>${escapeHtml(result?.error || "请返回后台重新创建任务")}</span><button type="button">取消</button>`;
        toolbar.querySelector("button")?.addEventListener("click", cleanup);
        return;
      }
      toolbar.innerHTML = `<strong>元素批注已保存</strong><span>${escapeHtml(label)} · 返回后台即可查看</span>`;
      hovered.classList.remove("cc-picker-target");
      setTimeout(cleanup, 1800);
    };
    const onKey = event => { if (event.key === "Escape") cleanup(); };
    toolbar.querySelector("button").addEventListener("click", cleanup);
    document.addEventListener("mouseover", onHover, true);
    document.addEventListener("click", onClick, true);
    document.addEventListener("keydown", onKey, true);
    return true;
  }

  function annotationRequestFromHash() {
    const raw = location.hash.startsWith("#pagecue-annotation=") ? location.hash.slice(1) : "";
    if (!raw) return null;
    const params = new URLSearchParams(raw);
    const code = params.get("pagecue-annotation");
    if (!code) return null;
    return { code, label: params.get("label") || "页面批注", relative: params.get("relative") === "1" ? true : undefined };
  }

  function sameTestPage(current, requested) {
    try {
      const left = new URL(current);
      const right = new URL(requested);
      return left.origin === right.origin && left.pathname === right.pathname;
    } catch { return false; }
  }

  async function runPendingStrategyTests() {
    const now = Date.now();
    if (now - lastStrategyTestCheckAt < 2_000) return;
    lastStrategyTestCheckAt = now;
    const pending = await send({ type: "GET_PENDING_STRATEGY_TESTS" });
    for (const test of pending?.tests || []) {
      if (!sameTestPage(location.href, test.request?.url)) continue;
      if (!ContextRuleEngine.matchesSite(location.href, test.sitePatterns || [])) continue;
      const rule = {
        pageScope: "page_groups",
        pageStrategies: [{ pageGroupId: test.pageGroupId, sitePatterns: test.sitePatterns || [], ...test.strategy }],
        sitePatterns: test.sitePatterns || [],
        includeTerms: test.request.keywords || [],
        excludeTerms: [],
        operator: "AND",
        caseSensitive: false,
        useRegex: false
      };
      const collected = collectMatchUnits(rule);
      if (collected.selectorValid && !collected.units.length && now - Date.parse(test.request.requestedAt || 0) < 8_000) continue;
      const evaluated = ContextRuleEngine.evaluateRuleUnits(rule, collected.units, { url: location.href });
      const bestUnit = collected.units.reduce((best, unit) => {
        const count = rule.includeTerms.filter(term => ContextRuleEngine.testTerm(unit.text, term, false, false)).length;
        return !best || count > best.count ? { unit, count } : best;
      }, null);
      const matchedTerms = bestUnit ? rule.includeTerms.filter(term => ContextRuleEngine.testTerm(bestUnit.unit.text, term, false, false)) : [];
      const missingTerms = rule.includeTerms.filter(term => !matchedTerms.includes(term));
      const reportKey = `${test.request.id}|${collected.selectorValid}|${collected.units.length}|${evaluated.matchedUnitIndexes.length}|${matchedTerms.join("\u0001")}`;
      if (reportedStrategyTests.has(reportKey)) continue;
      const response = await send({
        type: "REPORT_STRATEGY_TEST",
        requestId: test.request.id,
        result: {
          url: location.href,
          matchScope: collected.strategy.matchScope,
          selectorValid: collected.selectorValid,
          unitCount: collected.units.length,
          matchedUnitCount: evaluated.matchedUnitIndexes.length,
          matchedTerms,
          missingTerms,
          error: collected.error
        }
      });
      if (response?.ok) reportedStrategyTests.add(reportKey);
    }
  }

  async function scan() {
    if (!bootstrap) await loadBootstrap();
    if (!bootstrap?.memos?.length) { await runPendingStrategyTests(); return; }
    const matches = evaluateCurrentMemos(bootstrap.memos);
    const signature = matches.map(memo => `${memo.id}:${memoMatchSignature(memo)}`).sort().join("|");
    if (signature !== lastHighlightSignature || externalDomChanged) renderHighlights(matches, signature);
    await renderElementPins(matches);

    const currentMatchIds = new Set(matches.map(memo => memo.id));
    for (const memoId of previousMatchIds) {
      if (!currentMatchIds.has(memoId)) send({ type: "REARM_MATCH", memoId, domain: domain() });
    }
    previousMatchIds = currentMatchIds;
    for (const memo of matches) {
      const memoSignature = memoMatchSignature(memo);
      const response = await send({ type: "MATCH", memoId: memo.id, domain: domain(), signature: memoSignature });
      if (response?.accepted) showToast(response.memo);
    }
    await runPendingStrategyTests();
  }

  function scheduleScan(delay = 700) {
    clearTimeout(scanTimer);
    scanTimer = setTimeout(scan, delay);
  }

  function showToast(memo) {
    const template = memoTemplate(memo);
    if (template === "light") return;
    if (visibleToasts.has(memo.id)) return;
    const root = document.createElement("aside");
    root.className = `cc-toast cc-card cc-template-${template} ${memo.type === "operation" ? "cc-operation-toast" : "cc-knowledge-toast"}`;
    root.setAttribute("role", "status");
    root.classList.toggle("cc-important", template === "strong");
    const terms = memo.rule?.includeTerms?.join("、") || "页面规则";
    const primaryLink = (memo.links || []).find(link => /^https?:\/\//i.test(link.url || ""));
    const supplierRef = (memo.entityRefs || []).find(ref => ref.type === "supplier");
    const linkMarkup = primaryLink
      ? `<div class="cc-link-actions"><a class="cc-card-link" data-action="link" href="${escapeHtml(primaryLink.url)}" target="_blank" rel="noopener noreferrer">查看具体信息<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true"><path d="M7 17 17 7M8 7h9v9"/></svg></a><button class="cc-copy-link" type="button" data-action="copy-link" aria-label="复制具体信息链接">复制链接</button></div>`
      : `<button class="cc-card-link cc-link-button" type="button" data-action="open">查看详情</button>`;
    const supplierMarkup = supplierRef ? `<button class="cc-card-link cc-link-button" type="button" data-action="supplier">查看供应商</button>` : "";
    root.innerHTML = `<header class="cc-card-head"><span class="cc-type"><span class="cc-type-icon">${memoTypeIcon(memo)}</span>${memoTypeLabel(memo)}</span><span class="cc-level-pill">${memoLevelLabel(memo)}</span></header><div class="cc-card-content"><strong></strong><p></p><div class="cc-meta"><span>${memo.type === "operation" ? `负责：${bootstrap?.user?.name || "我"}` : memo.scope === "personal" ? "我的知识" : "组织知识"}</span><i></i><span class="cc-match">命中：${escapeHtml(terms)}</span><i></i><span>${memo.commentCount || 0} 条评论</span></div></div><footer class="cc-card-footer"><div class="cc-link-actions">${supplierMarkup}${linkMarkup}</div><div class="cc-actions"><button type="button" data-action="comments">评论</button><button type="button" data-action="locate">定位</button><button class="cc-primary-action" type="button" data-action="confirm">${memo.type === "operation" ? "完成了" : "知道了"}</button></div></footer>`;
    root.querySelector("strong").textContent = memo.title;
    root.querySelector("p").textContent = memo.body.replace(/[*#`]/g, "").slice(0, 130);
    const remove = () => { root.classList.add("cc-leave"); setTimeout(() => root.remove(), 220); visibleToasts.delete(memo.id); };
    root.querySelector('[data-action="locate"]').addEventListener("click", async () => {
      const result = await focusMemoFresh(memo.id);
      if (result.found) return remove();
      root.querySelector(".cc-match").textContent = result.reason === "no_keywords"
        ? "这条备忘没有设置定位关键词"
        : `页面中未找到：${result.terms?.join("、") || "对应关键词"}`;
    });
    root.querySelector('[data-action="open"]')?.addEventListener("click", async () => { await send({ type: "OPEN_MEMO", memoId: memo.id, domain: domain() }); if (template !== "strong") remove(); });
    root.querySelector('[data-action="supplier"]')?.addEventListener("click", () => showSupplierCard(supplierRef.id));
    root.querySelector('[data-action="comments"]')?.addEventListener("click", () => toggleCardComments(root, memo.id));
    root.querySelector('[data-action="link"]')?.addEventListener("click", () => send({ type: "TRACK_EVENT", memoId: memo.id, domain: domain(), action: "opened", presentation: "inline_link" }));
    root.querySelector('[data-action="copy-link"]')?.addEventListener("click", async event => {
      const copied = await copyText(primaryLink?.url || "");
      event.currentTarget.textContent = copied ? "已复制" : "复制失败";
      if (copied) send({ type: "TRACK_EVENT", memoId: memo.id, domain: domain(), action: "link_copied", presentation: "inline_link" });
    });
    root.querySelector('[data-action="confirm"]')?.addEventListener("click", async event => {
      await send({ type: "MATCH_ACTION", memoId: memo.id, domain: domain(), action: "confirmed" });
      if (template === "strong") { event.currentTarget.textContent = memo.type === "operation" ? "已记录" : "已知晓"; event.currentTarget.disabled = true; }
      else remove();
    });
    document.documentElement.appendChild(root);
    requestAnimationFrame(() => root.classList.add("cc-show"));
    visibleToasts.set(memo.id, root);
  }

  chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
    if (message.type === "BOOTSTRAP_UPDATED") loadBootstrap().then(() => scheduleScan(100));
    if (message.type === "FOCUS_MATCH") {
      focusMemoFresh(message.memoId)
        .then(sendResponse)
        .catch(() => sendResponse({ found: false, reason: "scan_failed", terms: [] }));
      return true;
    }
    if (message.type === "SHOW_SUPPLIER") {
      showSupplierCard(message.supplierId).then(() => sendResponse({ ok: true })).catch(error => sendResponse({ ok: false, error: error.message }));
      return true;
    }
    if (message.type === "START_ANNOTATION_PICKER") {
      startAnnotationPicker(message.code, { label: message.label, relative: message.relative })
        .then(started => sendResponse({ started }))
        .catch(error => sendResponse({ started: false, error: error.message }));
      return true;
    }
  });

  chrome.storage.onChanged.addListener((changes, areaName) => {
    if (areaName !== "local" || !changes.bootstrap?.newValue) return;
    bootstrap = changes.bootstrap.newValue;
    scheduleScan(100);
  });

  const observer = new MutationObserver(mutations => {
    if (highlighting) return;
    if (mutations.every(item => [...item.addedNodes].every(node => node.nodeType === 1 && (node.classList?.contains("cc-toast") || node.classList?.contains("cc-findbar") || node.classList?.contains("cc-annotation-pin") || node.classList?.contains("cc-annotation-popover") || node.classList?.contains("cc-picker-toolbar"))))) return;
    externalDomChanged = true;
    scheduleScan();
  });
  if (document.body) observer.observe(document.body, { childList: true, subtree: true, characterData: true });
  document.addEventListener("input", event => { if (isScannableField(event.target)) scheduleScan(120); }, true);
  document.addEventListener("change", event => { if (isScannableField(event.target)) scheduleScan(120); }, true);
  window.addEventListener("scroll", positionElementPins, { passive: true });
  window.addEventListener("resize", positionElementPins, { passive: true });
  window.addEventListener("popstate", () => scheduleScan(100));
  window.addEventListener("hashchange", () => scheduleScan(100));
  for (const method of ["pushState", "replaceState"]) {
    const original = history[method];
    history[method] = function (...args) { const result = original.apply(this, args); scheduleScan(100); return result; };
  }
  const annotationRequest = annotationRequestFromHash();
  if (annotationRequest) history.replaceState(null, "", `${location.pathname}${location.search}`);
  loadBootstrap().then(async () => {
    if (annotationRequest) await startAnnotationPicker(annotationRequest.code, annotationRequest);
    scheduleScan(100);
  });
})();
