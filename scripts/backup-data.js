const fs = require("node:fs");
const path = require("node:path");
const { createHash } = require("node:crypto");

const DEFAULT_DATA_FILE = process.env.CONTEXT_COMPANION_DATA || path.join(__dirname, "..", "data", "db.json");

function databaseCounts(data = {}) {
  const collections = [
    "users", "groups", "memos", "memoComments", "events", "auditLog",
    "operationReceipts", "broadcastReceipts", "submissionSnapshots",
    "memberFeedback", "deviceBindings", "invitations"
  ];
  return Object.fromEntries(collections.map(key => [key, Array.isArray(data[key]) ? data[key].length : 0]));
}

function validateDatabase(data) {
  if (!data || typeof data !== "object" || Array.isArray(data)) throw new Error("备份内容不是有效数据库对象");
  if (!data.meta || typeof data.meta !== "object") throw new Error("数据库缺少 meta");
  if (!Array.isArray(data.memos) || !Array.isArray(data.users)) throw new Error("数据库缺少 memos 或 users 集合");
  return databaseCounts(data);
}

function safeTimestamp(date = new Date()) {
  return date.toISOString().replace(/[:.]/g, "-");
}

function sha256(buffer) {
  return createHash("sha256").update(buffer).digest("hex");
}

function pruneBackups(directory, keep = 90) {
  if (!fs.existsSync(directory)) return [];
  const manifests = fs.readdirSync(directory)
    .filter(name => /^pagecue-.*\.manifest\.json$/.test(name))
    .map(name => ({ name, modifiedAt: fs.statSync(path.join(directory, name)).mtimeMs }))
    .sort((a, b) => b.modifiedAt - a.modifiedAt);
  const removed = [];
  for (const item of manifests.slice(Math.max(1, keep))) {
    const manifestPath = path.join(directory, item.name);
    const dataPath = manifestPath.replace(/\.manifest\.json$/, ".json");
    if (fs.existsSync(dataPath)) fs.unlinkSync(dataPath);
    fs.unlinkSync(manifestPath);
    removed.push(path.basename(dataPath));
  }
  return removed;
}

function backupDatabase(options = {}) {
  const dataFile = path.resolve(options.dataFile || DEFAULT_DATA_FILE);
  const backupDir = path.resolve(options.backupDir || path.join(path.dirname(dataFile), "backups", "protected"));
  const raw = fs.readFileSync(dataFile);
  const data = JSON.parse(raw.toString("utf8"));
  const counts = validateDatabase(data);
  const stamp = safeTimestamp(options.now || new Date());
  const baseName = `pagecue-${stamp}`;
  fs.mkdirSync(backupDir, { recursive: true });
  const backupFile = path.join(backupDir, `${baseName}.json`);
  const manifestFile = path.join(backupDir, `${baseName}.manifest.json`);
  fs.writeFileSync(backupFile, raw);
  const manifest = {
    format: "pagecue-backup-v1",
    source: dataFile,
    backupFile: path.basename(backupFile),
    sha256: sha256(raw),
    bytes: raw.length,
    counts,
    createdAt: (options.now || new Date()).toISOString()
  };
  fs.writeFileSync(manifestFile, `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
  const offsiteDir = options.offsiteDir || process.env.PAGECUE_OFFSITE_BACKUP_DIR;
  if (offsiteDir) {
    fs.mkdirSync(offsiteDir, { recursive: true });
    fs.copyFileSync(backupFile, path.join(offsiteDir, path.basename(backupFile)));
    fs.copyFileSync(manifestFile, path.join(offsiteDir, path.basename(manifestFile)));
  }
  const removed = pruneBackups(backupDir, Number(options.keep || process.env.PAGECUE_BACKUP_KEEP || 90));
  return { backupFile, manifestFile, counts, sha256: manifest.sha256, removed };
}

if (require.main === module) {
  const result = backupDatabase();
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
}

module.exports = { backupDatabase, databaseCounts, validateDatabase, sha256 };
