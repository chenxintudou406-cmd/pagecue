const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const root = path.join(__dirname, "..");
const read = file => fs.readFileSync(path.join(root, file), "utf8");

test("用户可以在自动、侧边栏和悬挂窗口之间切换", () => {
  const worker = read("extension/background/service-worker.js");
  const html = read("extension/sidepanel/index.html");
  const app = read("extension/sidepanel/app.js");

  assert.match(worker, /uiMode:\s*"auto"/);
  assert.match(worker, /function normalizeUiMode/);
  assert.match(worker, /async function applyUiMode/);
  assert.match(worker, /case "SET_UI_MODE"/);
  assert.match(worker, /chrome\.action\.setPopup\(\{\s*popup:\s*""\s*\}\)/);
  assert.match(worker, /popup:\s*"sidepanel\/index\.html"/);

  assert.match(html, /id="ui-mode"/);
  assert.match(html, /id="quick-ui-mode"/);
  for (const value of ["auto", "sidepanel", "popup"]) {
    assert.match(html, new RegExp(`<option value="${value}"`));
  }
  assert.match(app, /type:\s*"SET_UI_MODE"/);
  assert.match(app, /function renderQuickUiMode/);
  assert.match(app, /dataset\.nextMode/);
});

test("两种模式共享完整提醒界面并支持快速隐藏", () => {
  const manifest = read("extension/manifest.json");
  const worker = read("extension/background/service-worker.js");
  const html = read("extension/sidepanel/index.html");
  const app = read("extension/sidepanel/app.js");
  const build = read("scripts/build-extensions.js");

  assert.match(manifest, /"default_path":\s*"sidepanel\/index\.html"/);
  assert.match(build, /default_popup\s*=\s*"sidepanel\/index\.html"/);
  for (const tab of ["alerts", "memos", "tools"]) {
    assert.match(html, new RegExp(`data-tab="${tab}"`));
  }
  assert.match(html, /id="hide-primary-ui"/);
  assert.match(app, /type:\s*"HIDE_PRIMARY_UI"/);
  assert.match(worker, /case "HIDE_PRIMARY_UI"/);
  assert.match(worker, /chrome\.sidePanel\.close/);
  assert.match(worker, /chrome\.sidePanel\.setOptions/);
  assert.match(app, /window\.close\(\)/);
});

test("侧栏宽度响应式适配且不引入持续轮询", () => {
  const css = read("extension/sidepanel/styles.css");
  const app = read("extension/sidepanel/app.js");
  const worker = read("extension/background/service-worker.js");

  assert.match(css, /min-width:\s*280px/);
  assert.match(css, /@media\s*\(max-width:\s*360px\)/);
  assert.match(css, /\.header-actions/);
  assert.doesNotMatch(app, /setInterval\s*\(/);
  assert.doesNotMatch(worker, /setInterval\s*\(/);
});

test("兼容检测使用完整侧栏能力且悬挂窗口隐藏不触碰侧栏", () => {
  const worker = read("extension/background/service-worker.js");
  assert.match(worker, /sidePanel:\s*SIDE_PANEL_AVAILABLE/);
  assert.match(worker, /SIDE_PANEL_AVAILABLE\s*=\s*Boolean\(chrome\.sidePanel\?\.setPanelBehavior\)/);
  assert.match(worker, /SIDE_PANEL_OPEN_AVAILABLE\s*=\s*Boolean\(chrome\.sidePanel\?\.open\)/);
  assert.match(worker, /mode === "sidepanel" && SIDE_PANEL_OPEN_AVAILABLE && tabId/);
  assert.match(worker, /async function hidePrimaryUi[\s\S]*resolveUiMode\(\(await getConfig\(\)\)\.uiMode\)/);
  assert.match(worker, /if\s*\(mode === "popup"\)\s*return\s*\{\s*closed:\s*false,\s*method:\s*"window"\s*\}/);
});

test("搜狗与360兼容包同时声明侧栏和悬挂窗口入口", () => {
  const build = read("scripts/build-extensions.js");
  assert.doesNotMatch(build, /permissions\.filter\(permission => permission !== "sidePanel"\)/);
  assert.doesNotMatch(build, /delete manifest\.side_panel/);
  assert.match(build, /manifest\.action\.default_popup\s*=\s*"sidepanel\/index\.html"/);
});
