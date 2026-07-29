const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const read = file => fs.readFileSync(path.join(__dirname, "..", file), "utf8");

test("页面打开会检查内容版本，强提醒广播不依赖关键词并只确认一次", () => {
  const worker = read("extension/background/service-worker.js");
  const content = read("extension/content/content.js");
  const server = read("server.js");
  assert.match(content, /type:\s*"PAGE_OPENED"/);
  assert.match(content, /bootstrap\.pendingBroadcasts/);
  assert.match(content, /type:\s*"BROADCAST"/);
  assert.match(content, /memo\.triggerMode === "broadcast"/);
  assert.match(worker, /PAGE_SYNC_THROTTLE_MS = 60_000/);
  assert.match(worker, /async function processBroadcast/);
  assert.match(worker, /api\/broadcast-receipts/);
  assert.match(worker, /页知广播/);
  assert.match(server, /pendingBroadcasts/);
  assert.match(server, /memoVersion === memoVersion && item\.memberId === user\.id/);
});

test("提醒卡片使用单一队列并记录展开、链接、评论、完成和赞踩", () => {
  const content = read("extension/content/content.js");
  const sidepanel = read("extension/sidepanel/app.js");
  const server = read("server.js");
  assert.match(content, /const toastQueue = \[\]/);
  assert.match(content, /activeToastMemoId/);
  assert.match(content, /data-action="next"/);
  assert.doesNotMatch(content, /负责：/);
  assert.doesNotMatch(sidepanel, /负责：/);
  for (const action of ["expanded", "link_opened", "link_copied", "comment_opened", "comment_submitted", "feedback_up", "feedback_down"]) {
    assert.match(content + sidepanel + server, new RegExp(action));
  }
  assert.match(server, /operation_completed/);
});

test("赞踩状态在所有提醒卡片中互斥选中并在重新打开后恢复", () => {
  const content = read("extension/content/content.js");
  const sidepanel = read("extension/sidepanel/app.js");
  const styles = read("extension/sidepanel/styles.css") + read("extension/content/content.css");
  const worker = read("extension/background/service-worker.js");
  assert.match(content, /memo\.myFeedback/);
  assert.match(sidepanel, /memo\.myFeedback/);
  assert.match(content + sidepanel, /aria-pressed/);
  assert.match(worker, /memo\.myFeedback\s*=\s*action/);
  assert.match(styles, /feedback_up.*selected|selected.*feedback_up/s);
  assert.match(styles, /feedback_down.*selected|selected.*feedback_down/s);
});

test("用户设置按打开方式、账号权限、页面行为和连接版本清晰分区", () => {
  const html = read("extension/sidepanel/index.html");
  const styles = read("extension/sidepanel/styles.css");
  for (const group of ["display", "identity", "page", "connection"]) {
    assert.match(html, new RegExp(`data-settings-group="${group}"`));
  }
  assert.equal((html.match(/class="settings-group"/g) || []).length, 4);
  assert.match(styles, /\.settings-group\s*\{[^}]*border:/s);
  assert.match(styles, /\.settings-group-title/);
});

test("重度操作提醒完成时二次确认并只关闭当前页面卡片", () => {
  const content = read("extension/content/content.js");
  const sidepanel = read("extension/sidepanel/app.js");
  const worker = read("extension/background/service-worker.js");
  assert.match(content, /PAGE_INSTANCE_ID/);
  assert.match(content, /确认已经完成这项操作/);
  assert.match(content, /message\.type === "DISMISS_MATCH_CARD"/);
  assert.match(sidepanel, /确认已经完成这项操作/);
  assert.match(sidepanel, /item\.memo\.type !== "operation"/);
  assert.match(worker, /confirmed_current_page/);
  assert.match(worker, /dismissedCurrentPage:\s*true/);
  assert.match(worker, /type:\s*"DISMISS_MATCH_CARD"/);
});

test("后台投放对象互斥、展示到期历史并提供分级和网站漏斗", () => {
  const html = read("admin/index.html");
  const app = read("admin/app.js");
  const server = read("server.js");
  for (const value of ["all", "groups", "members"]) assert.match(html, new RegExp(`name="audienceType" value="${value}"`));
  assert.match(html, /不设置负责人或处理人/);
  assert.match(html, /value="expired"/);
  assert.match(app, /轻提醒/);
  assert.match(app, /中\/重提醒/);
  assert.match(app, /biochemsafebuy\.com\/admin|website-funnel/);
  assert.match(server, /lifecycleStatus/);
  assert.match(server, /submissionSnapshots/);
  assert.match(server, /memberNameSnapshot/);
});

test("生产镜像包含 P0 服务端共享模型", () => {
  const dockerfile = read("Dockerfile");
  assert.match(dockerfile, /COPY shared \.\/shared/);
});
