const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const root = path.join(__dirname, "..");
const read = file => fs.readFileSync(path.join(root, file), "utf8");

test("管理后台提供账号绑定列表、编辑、设备号码和事件时间线", () => {
  const html = read("admin/index.html");
  const app = read("admin/app.js");
  const css = read("admin/styles.css");
  for (const token of [
    'data-view="accounts"',
    'id="view-accounts"',
    'id="account-search"',
    'id="account-group-filter"',
    'id="account-status-filter"',
    'id="account-detail-dialog"',
    'id="invitation-status-filter"',
    'id="invitation-management-list"'
  ]) assert.match(html, new RegExp(token));
  for (const token of ["renderAccounts", "renderAccountDetail", "绑定号码", "最近登录", "accountTimeline", "data-edit-member", "data-revoke-device"]) assert.match(app, new RegExp(token));
  assert.match(css, /\.account-row/);
  assert.match(css, /\.account-timeline/);
  assert.match(app, /renderInvitations/);
  assert.match(app, /data-copy-invitation/);
  assert.match(app, /data-delete-invitation/);
  assert.match(css, /@media \(max-width: 760px\)/);
});

test("账号事件只从服务端安全汇总，不暴露设备令牌", () => {
  const server = read("server.js");
  assert.match(server, /accountEvents/);
  assert.match(server, /member_login/);
  assert.match(server, /device_bound/);
  assert.match(server, /device_revoked/);
  assert.match(server, /deviceBindings\.map\(\(\{ tokenHash/);
  assert.match(server, /accountEvents\.slice\(-1000\)\.reverse\(\)/);
  assert.match(server, /encryptInvitationCode/);
  assert.match(server, /decryptInvitationCode/);
  assert.match(server, /api\/admin\/invitations/);
});
