const fs = require("node:fs");
const path = require("node:path");
const { sha256, validateDatabase } = require("./backup-data.js");

function verifyBackup(backupFile) {
  const resolved = path.resolve(backupFile);
  const raw = fs.readFileSync(resolved);
  const data = JSON.parse(raw.toString("utf8"));
  const counts = validateDatabase(data);
  const manifestFile = resolved.replace(/\.json$/, ".manifest.json");
  let manifest = null;
  if (fs.existsSync(manifestFile)) {
    manifest = JSON.parse(fs.readFileSync(manifestFile, "utf8"));
    if (manifest.sha256 !== sha256(raw)) throw new Error("备份哈希不一致，禁止恢复");
    if (manifest.bytes !== raw.length) throw new Error("备份字节数不一致，禁止恢复");
  }
  return { backupFile: resolved, raw, data, counts, manifest };
}

function restoreBackup(backupFile, targetFile) {
  const verified = verifyBackup(backupFile);
  const target = path.resolve(targetFile);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  const temporary = `${target}.${process.pid}.restore.tmp`;
  fs.writeFileSync(temporary, verified.raw);
  fs.renameSync(temporary, target);
  const restored = verifyBackup(target);
  if (JSON.stringify(restored.counts) !== JSON.stringify(verified.counts)) throw new Error("恢复后集合数量不一致");
  return { targetFile: target, counts: restored.counts, sha256: sha256(restored.raw) };
}

if (require.main === module) {
  const [, , backupFile, targetFile] = process.argv;
  if (!backupFile) throw new Error("用法：node scripts/restore-backup.js <backup.json> [target.json]");
  const result = targetFile ? restoreBackup(backupFile, targetFile) : verifyBackup(backupFile);
  process.stdout.write(`${JSON.stringify({ backupFile: result.backupFile, targetFile: result.targetFile, counts: result.counts }, null, 2)}\n`);
}

module.exports = { verifyBackup, restoreBackup };
