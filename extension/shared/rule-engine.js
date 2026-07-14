(function (root, factory) {
  const api = factory();
  if (typeof module === "object" && module.exports) module.exports = api;
  else root.ContextRuleEngine = api;
})(typeof globalThis !== "undefined" ? globalThis : this, function () {
  function escapeRegex(value) { return value.replace(/[|\\{}()[\]^$+?.]/g, "\\$&"); }

  function patternToRegex(pattern) {
    let normalized = String(pattern || "").trim();
    if (!normalized) return null;
    if (!normalized.includes("://")) normalized = `*://${normalized}`;
    const source = escapeRegex(normalized).replace(/\*/g, ".*");
    return new RegExp(`^${source}$`, "i");
  }

  function matchesSite(url, patterns = []) {
    if (!patterns.length) return true;
    return patterns.some(pattern => {
      try { return patternToRegex(pattern)?.test(url) || false; }
      catch { return false; }
    });
  }

  function testTerm(text, term, useRegex, caseSensitive) {
    if (useRegex) {
      try { return new RegExp(term, caseSensitive ? "" : "i").test(text); }
      catch { return false; }
    }
    if (caseSensitive) return text.includes(term);
    return text.toLocaleLowerCase().includes(term.toLocaleLowerCase());
  }

  function evaluateRule(rule = {}, context = {}) {
    const text = String(context.text || "");
    const url = String(context.url || "");
    const includeTerms = (rule.includeTerms || []).filter(Boolean);
    const excludeTerms = (rule.excludeTerms || []).filter(Boolean);
    if (!matchesSite(url, rule.sitePatterns || [])) return { matched: false, reason: "site" };
    if (excludeTerms.some(term => testTerm(text, term, rule.useRegex, rule.caseSensitive))) return { matched: false, reason: "excluded" };
    if (!includeTerms.length) return { matched: true, reason: "site-only", terms: [] };
    const results = includeTerms.map(term => testTerm(text, term, rule.useRegex, rule.caseSensitive));
    const matched = rule.operator === "OR" ? results.some(Boolean) : results.every(Boolean);
    return { matched, reason: matched ? "included" : "missing", terms: includeTerms.filter((_, index) => results[index]) };
  }

  function matchSignature(rule = {}, context = {}) {
    const sourceText = String(context.text || "");
    const text = rule.caseSensitive ? sourceText : sourceText.toLocaleLowerCase();
    const counts = (rule.includeTerms || []).filter(Boolean).map(term => {
      if (rule.useRegex) {
        try {
          const flags = rule.caseSensitive ? "g" : "gi";
          return [...sourceText.matchAll(new RegExp(term, flags))].length;
        } catch { return 0; }
      }
      const needle = rule.caseSensitive ? term : term.toLocaleLowerCase();
      if (!needle) return 0;
      let count = 0;
      let index = 0;
      while ((index = text.indexOf(needle, index)) !== -1) { count += 1; index += needle.length; }
      return count;
    });
    return counts.join(":");
  }

  function evaluateMemos(memos = [], context = {}, now = Date.now()) {
    return memos.filter(memo => {
      if (memo.status && memo.status !== "published") return false;
      if (memo.startsAt && Date.parse(memo.startsAt) > now) return false;
      if (memo.expiresAt && Date.parse(memo.expiresAt) <= now) return false;
      return evaluateRule(memo.rule, context).matched;
    });
  }

  return { patternToRegex, matchesSite, testTerm, evaluateRule, evaluateMemos, matchSignature };
});
