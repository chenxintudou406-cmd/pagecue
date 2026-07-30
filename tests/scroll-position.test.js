const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const root = path.join(__dirname, "..");
const read = file => fs.readFileSync(path.join(root, file), "utf8");

test("关键词定位把目标中心放到滚动容器中心并限制滚动边界", () => {
  const { centeredScrollTop } = require("../extension/shared/scroll-position.js");
  assert.equal(centeredScrollTop({
    currentScroll: 100,
    targetStart: 650,
    targetSize: 20,
    containerStart: 100,
    containerSize: 400,
    maxScroll: 1000
  }), 460);
  assert.equal(centeredScrollTop({
    currentScroll: 0,
    targetStart: 10,
    targetSize: 20,
    containerStart: 0,
    containerSize: 600,
    maxScroll: 900
  }), 0);
  assert.equal(centeredScrollTop({
    currentScroll: 850,
    targetStart: 590,
    targetSize: 20,
    containerStart: 0,
    containerSize: 300,
    maxScroll: 900
  }), 900);
});

test("网页定位加载共享几何模块并执行嵌套滚动和二次校正", () => {
  const manifest = JSON.parse(read("extension/manifest.json"));
  const contentScripts = manifest.content_scripts[0].js;
  const content = read("extension/content/content.js");
  const worker = read("extension/background/service-worker.js");
  assert.ok(contentScripts.includes("shared/scroll-position.js"));
  assert.match(worker, /"shared\/scroll-position\.js", "content\/content\.js"/);
  assert.match(content, /function centerHighlightInViewport/);
  assert.match(content, /scrollableAncestors/);
  assert.match(content, /requestAnimationFrame/);
  assert.doesNotMatch(content, /active\.scrollIntoView\(\{\s*behavior:\s*reduceMotion\s*\?\s*"auto"\s*:\s*"smooth"/);
});

test("有链接的网页卡片把资料操作和提醒操作拆成上下两行", () => {
  const content = read("extension/content/content.js");
  const css = read("extension/content/content.css");
  assert.match(content, /cc-resource-row/);
  assert.match(content, /cc-action-row/);
  assert.match(css, /\.cc-card-footer\s*\{[^}]*display:grid/s);
  assert.match(css, /\.cc-resource-row/);
  assert.match(css, /\.cc-action-row/);
});
