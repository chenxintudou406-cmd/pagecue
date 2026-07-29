(function (root, factory) {
  const api = factory();
  if (typeof module === "object" && module.exports) module.exports = api;
  root.PageCueScroll = api;
})(typeof globalThis !== "undefined" ? globalThis : this, function () {
  function clamp(value, minimum, maximum) {
    return Math.min(Math.max(Number(value) || 0, Number(minimum) || 0), Math.max(Number(minimum) || 0, Number(maximum) || 0));
  }

  function centeredScrollTop({
    currentScroll = 0,
    targetStart = 0,
    targetSize = 0,
    containerStart = 0,
    containerSize = 0,
    maxScroll = Number.MAX_SAFE_INTEGER
  } = {}) {
    const targetCenter = Number(targetStart) + Number(targetSize) / 2;
    const containerCenter = Number(containerStart) + Number(containerSize) / 2;
    return Math.round(clamp(Number(currentScroll) + targetCenter - containerCenter, 0, maxScroll));
  }

  return { centeredScrollTop };
});
