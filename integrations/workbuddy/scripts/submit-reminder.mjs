import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createHash, randomBytes } from "node:crypto";

const args = process.argv.slice(2);
const valueAfter = flag => {
  const index = args.indexOf(flag);
  return index >= 0 ? args[index + 1] : null;
};
const apiBase = String(process.env.PAGECUE_API_BASE || "https://pagecue.herotop.cn").replace(/\/$/, "");
const tokenFile = process.env.PAGECUE_WORKBUDDY_TOKEN_FILE || path.join(os.homedir(), ".workbuddy", "pagecue-workbuddy-token");

if (args.includes("--init-token")) {
  if (!fs.existsSync(tokenFile)) {
    fs.mkdirSync(path.dirname(tokenFile), { recursive: true });
    fs.writeFileSync(tokenFile, randomBytes(48).toString("base64url"), { encoding: "utf8", mode: 0o600, flag: "wx" });
  }
  console.log(JSON.stringify({ ok: true, status: "configured", tokenFile, message: "WorkBuddy 本机密钥已配置" }, null, 2));
  process.exit(0);
}

const token = String(process.env.PAGECUE_WORKBUDDY_TOKEN || (fs.existsSync(tokenFile) ? fs.readFileSync(tokenFile, "utf8") : "")).trim();

if (!token) {
  console.log(JSON.stringify({ ok: false, status: "not_configured", message: "WorkBuddy 本机尚未配置页知接口密钥" }, null, 2));
  process.exitCode = 2;
} else {
  const headers = { Authorization: `Bearer ${token}` };
  let response;
  if (args.includes("--health")) {
    response = await fetch(`${apiBase}/api/integrations/workbuddy/health`, { headers });
  } else if (valueAfter("--status")) {
    response = await fetch(`${apiBase}/api/integrations/workbuddy/requests/${encodeURIComponent(valueAfter("--status"))}`, { headers });
  } else {
    const payloadFile = valueAfter("--payload");
    if (!payloadFile || !fs.existsSync(payloadFile)) {
      console.log(JSON.stringify({ ok: false, status: "validation_failed", message: "请通过 --payload 指定提醒 JSON 文件" }, null, 2));
      process.exit(2);
    }
    const payload = JSON.parse(fs.readFileSync(payloadFile, "utf8"));
    if (!payload.requestId) {
      const stableSource = String(payload.sourceText || JSON.stringify(payload));
      payload.requestId = `wb_${createHash("sha256").update(stableSource).digest("hex").slice(0, 32)}`;
    }
    delete payload.sourceText;
    response = await fetch(`${apiBase}/api/integrations/workbuddy/reminders`, {
      method: "POST",
      headers: { ...headers, "Content-Type": "application/json" },
      body: JSON.stringify(payload)
    });
  }

  let result;
  try { result = await response.json(); }
  catch { result = { ok: false, status: "invalid_response", message: `页知接口返回了无法解析的结果（HTTP ${response.status}）` }; }
  console.log(JSON.stringify(result, null, 2));
  if (!response.ok) process.exitCode = 1;
}
