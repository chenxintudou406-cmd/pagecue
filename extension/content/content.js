(function () {
  if (window.__contextCompanionLoaded) return;
  window.__contextCompanionLoaded = true;

  const MAX_HIGHLIGHTS = 500;
  const BLOCKED_SELECTOR = "script,style,noscript,textarea,input,select,option,button,[contenteditable='true'],[contenteditable=''],.cc-toast,.cc-findbar,mark[data-cc-highlight]";
  let bootstrap = null;
  let scanTimer = null;
  let previousMatchIds = new Set();
  let currentMatchedMemos = [];
  let lastHighlightSignature = "";
  let highlighting = false;
  let externalDomChanged = true;
  let focusedMemoId = null;
  let currentHighlightIndex = -1;
  const visibleToasts = new Map();

  function send(message) { return chrome.runtime.sendMessage(message).catch(() => null); }

  async function loadBootstrap(force = false) {
    const result = await send({ type: force ? "REFRESH_BOOTSTRAP" : "GET_BOOTSTRAP" });
    if (result?.bootstrap) bootstrap = result.bootstrap;
    return bootstrap;
  }

  function pageText() {
    const body = document.body;
    if (!body) return "";
    return (body.innerText || "").slice(0, 2_000_000);
  }

  function domain() { try { return location.hostname; } catch { return ""; } }
  function escapeRegex(value) { return value.replace(/[|\\{}()[\]^$+?.*]/g, "\\$&"); }

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
  }

  function textNodes() {
    const nodes = [];
    if (!document.body) return nodes;
    const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT, {
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
    for (const node of textNodes()) {
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
        mark.dataset.memoId = entry.memoId;
        mark.dataset.term = entry.term;
        mark.tabIndex = -1;
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
    return memoId ? marks.filter(mark => mark.dataset.memoId === memoId) : marks;
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
    for (const memo of memos) {
      for (const term of memo.rule?.includeTerms || []) {
        const key = `${memo.id}|${term}|${Boolean(memo.rule?.useRegex)}|${Boolean(memo.rule?.caseSensitive)}`;
        if (!term || seen.has(key)) continue;
        seen.add(key);
        entries.push({ memoId: memo.id, term, rule: memo.rule || {} });
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

    const context = { text: pageText(), url: location.href };
    const result = ContextRuleEngine.evaluateRule(memo.rule, context);
    if (!result.matched) return { found: false, reason: result.reason || "missing", terms };

    currentMatchedMemos = ContextRuleEngine.evaluateMemos(bootstrap.memos, context);
    const signature = currentMatchedMemos.map(item => `${item.id}:${ContextRuleEngine.matchSignature(item.rule, context)}`).sort().join("|");
    renderHighlights(currentMatchedMemos, signature);
    const found = focusMemo(memoId);
    const marks = allHighlights(memoId);
    return {
      found,
      reason: found ? "located" : "not_renderable",
      terms,
      count: marks.length,
      term: marks[0]?.dataset.term || result.terms?.[0] || terms[0]
    };
  }

  async function scan() {
    if (!bootstrap) await loadBootstrap();
    if (!bootstrap?.memos?.length) return;
    const context = { text: pageText(), url: location.href };
    const matches = ContextRuleEngine.evaluateMemos(bootstrap.memos, context);
    currentMatchedMemos = matches;
    const signature = matches.map(memo => `${memo.id}:${ContextRuleEngine.matchSignature(memo.rule, context)}`).sort().join("|");
    if (signature !== lastHighlightSignature || externalDomChanged) renderHighlights(matches, signature);

    const currentMatchIds = new Set(matches.map(memo => memo.id));
    for (const memoId of previousMatchIds) {
      if (!currentMatchIds.has(memoId)) send({ type: "REARM_MATCH", memoId, domain: domain() });
    }
    previousMatchIds = currentMatchIds;
    for (const memo of matches) {
      const memoSignature = ContextRuleEngine.matchSignature(memo.rule, context);
      const response = await send({ type: "MATCH", memoId: memo.id, domain: domain(), signature: memoSignature });
      if (response?.accepted) showToast(response.memo);
    }
  }

  function scheduleScan(delay = 700) {
    clearTimeout(scanTimer);
    scanTimer = setTimeout(scan, delay);
  }

  function showToast(memo) {
    if (visibleToasts.has(memo.id)) return;
    const root = document.createElement("aside");
    root.className = "cc-toast";
    root.setAttribute("role", "status");
    root.classList.toggle("cc-important", memo.priority === "important");
    const terms = memo.rule?.includeTerms?.join("、") || "页面规则";
    root.innerHTML = `<div class="cc-accent"></div><div class="cc-main"><div class="cc-head"><span>${memo.scope === "personal" ? "我的备忘已触发" : "组织提醒已触发"}</span><button type="button" aria-label="关闭">×</button></div><div class="cc-match"></div><strong></strong><p></p><div class="cc-actions"><button type="button" data-action="later">稍后</button><button type="button" data-action="locate">定位关键词</button><button type="button" data-action="open">查看备忘</button></div></div>`;
    root.querySelector(".cc-match").textContent = `检测到：${terms}`;
    root.querySelector("strong").textContent = memo.title;
    root.querySelector("p").textContent = memo.body.replace(/[*#`]/g, "").slice(0, 130);
    const remove = () => { root.classList.add("cc-leave"); setTimeout(() => root.remove(), 220); visibleToasts.delete(memo.id); };
    root.querySelector(".cc-head button").addEventListener("click", remove);
    root.querySelector('[data-action="later"]').addEventListener("click", async () => { await send({ type: "MATCH_ACTION", memoId: memo.id, domain: domain(), action: "snoozed", minutes: 60 }); remove(); });
    root.querySelector('[data-action="locate"]').addEventListener("click", async () => {
      const result = await focusMemoFresh(memo.id);
      if (result.found) return remove();
      root.querySelector(".cc-match").textContent = result.reason === "no_keywords"
        ? "这条备忘没有设置定位关键词"
        : `页面中未找到：${result.terms?.join("、") || "对应关键词"}`;
    });
    root.querySelector('[data-action="open"]').addEventListener("click", async () => { await send({ type: "OPEN_MEMO", memoId: memo.id, domain: domain() }); remove(); });
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
  });

  const observer = new MutationObserver(mutations => {
    if (highlighting) return;
    if (mutations.every(item => [...item.addedNodes].every(node => node.nodeType === 1 && (node.classList?.contains("cc-toast") || node.classList?.contains("cc-findbar"))))) return;
    externalDomChanged = true;
    scheduleScan();
  });
  if (document.body) observer.observe(document.body, { childList: true, subtree: true, characterData: true });
  loadBootstrap().then(() => scheduleScan(100));
})();
