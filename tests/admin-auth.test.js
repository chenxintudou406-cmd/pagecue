const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const net = require("node:net");
const { spawn } = require("node:child_process");
const { randomBytes, scryptSync } = require("node:crypto");

function passwordHash(password) {
  const salt = randomBytes(16);
  const derived = scryptSync(password, salt, 64);
  return `scrypt:${salt.toString("base64url")}:${derived.toString("base64url")}`;
}

async function freePort() {
  return await new Promise((resolve, reject) => {
    const probe = net.createServer();
    probe.once("error", reject);
    probe.listen(0, "127.0.0.1", () => {
      const port = probe.address().port;
      probe.close(() => resolve(port));
    });
  });
}

test("admin APIs require a valid signed login session", async t => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "pagecue-admin-auth-"));
  const dataFile = path.join(tempDir, "db.json");
  fs.copyFileSync(path.join(__dirname, "..", "data", "db.json"), dataFile);
  const port = await freePort();
  const phone = "13000000000";
  const password = "test-only-password";
  const child = spawn(process.execPath, [path.join(__dirname, "..", "server.js")], {
    env: {
      ...process.env,
      PORT: String(port),
      CONTEXT_COMPANION_DATA: dataFile,
      ADMIN_PHONE: phone,
      ADMIN_PASSWORD_HASH: passwordHash(password),
      ADMIN_SESSION_SECRET: randomBytes(32).toString("base64url")
    },
    stdio: "ignore"
  });
  t.after(() => {
    child.kill();
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  const base = `http://127.0.0.1:${port}`;
  for (let attempt = 0; attempt < 40; attempt += 1) {
    try { if ((await fetch(`${base}/api/health`)).ok) break; } catch {}
    await new Promise(resolve => setTimeout(resolve, 50));
  }

  assert.equal((await fetch(`${base}/api/admin/state`)).status, 401);
  assert.equal((await fetch(`${base}/api/admin/auth/login`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ phone, password: "wrong-password" })
  })).status, 401);

  const login = await fetch(`${base}/api/admin/auth/login`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ phone, password })
  });
  assert.equal(login.status, 200);
  const cookie = login.headers.get("set-cookie")?.split(";")[0];
  assert.match(cookie || "", /^pagecue_admin=/);

  const state = await fetch(`${base}/api/admin/state`, { headers: { Cookie: cookie } });
  assert.equal(state.status, 200);
  assert.equal((await state.json()).auth.adminId, "admin_demo");

  const logout = await fetch(`${base}/api/admin/auth/logout`, {
    method: "POST",
    headers: { Cookie: cookie }
  });
  assert.equal(logout.status, 200);
  assert.match(logout.headers.get("set-cookie") || "", /Max-Age=0/);
});

test("admin console presents a login form and does not trust a client role header", () => {
  const app = fs.readFileSync(path.join(__dirname, "..", "admin", "app.js"), "utf8");
  const css = fs.readFileSync(path.join(__dirname, "..", "admin", "styles.css"), "utf8");
  assert.match(app, /id="admin-login-form"/);
  assert.match(app, /autocomplete="current-password"/);
  assert.match(app, /credentials: "include"/);
  assert.doesNotMatch(app, /"X-User-Id": "admin_demo"/);
  assert.match(css, /\.login-screen/);
});
