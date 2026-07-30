const fs = require("node:fs");
const path = require("node:path");
const zlib = require("node:zlib");

const root = path.resolve(__dirname, "..");
const source = path.join(root, "extension");
const output = path.join(root, ".deploy");
const downloads = path.join(root, "downloads");
const staging = path.join(output, "staging");
const version = require(path.join(root, "package.json")).version;

function crc32(buffer) {
  let crc = 0xffffffff;
  for (const byte of buffer) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit += 1) crc = (crc >>> 1) ^ ((crc & 1) ? 0xedb88320 : 0);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function dosTime(date = new Date("2026-01-01T00:00:00Z")) {
  return {
    time: (date.getUTCHours() << 11) | (date.getUTCMinutes() << 5) | (date.getUTCSeconds() >> 1),
    date: ((date.getUTCFullYear() - 1980) << 9) | ((date.getUTCMonth() + 1) << 5) | date.getUTCDate()
  };
}

function listFiles(directory, prefix = "") {
  return fs.readdirSync(directory, { withFileTypes: true })
    .sort((a, b) => a.name.localeCompare(b.name))
    .flatMap(entry => entry.isDirectory()
      ? listFiles(path.join(directory, entry.name), `${prefix}${entry.name}/`)
      : [{ absolute: path.join(directory, entry.name), name: `${prefix}${entry.name}` }]);
}

function copyDirectory(from, to) {
  fs.mkdirSync(to, { recursive: true });
  for (const entry of fs.readdirSync(from, { withFileTypes: true })) {
    const sourcePath = path.join(from, entry.name);
    const targetPath = path.join(to, entry.name);
    if (entry.isDirectory()) copyDirectory(sourcePath, targetPath);
    else fs.copyFileSync(sourcePath, targetPath);
  }
}

function zipDirectory(directory, destination) {
  const locals = [];
  const centrals = [];
  let offset = 0;
  const stamp = dosTime();
  for (const file of listFiles(directory)) {
    const name = Buffer.from(file.name.replaceAll("\\", "/"));
    const raw = fs.readFileSync(file.absolute);
    const compressed = zlib.deflateRawSync(raw, { level: 9 });
    const crc = crc32(raw);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0); local.writeUInt16LE(20, 4); local.writeUInt16LE(0x800, 6); local.writeUInt16LE(8, 8);
    local.writeUInt16LE(stamp.time, 10); local.writeUInt16LE(stamp.date, 12); local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(compressed.length, 18); local.writeUInt32LE(raw.length, 22); local.writeUInt16LE(name.length, 26);
    locals.push(local, name, compressed);
    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0); central.writeUInt16LE(20, 4); central.writeUInt16LE(20, 6); central.writeUInt16LE(0x800, 8); central.writeUInt16LE(8, 10);
    central.writeUInt16LE(stamp.time, 12); central.writeUInt16LE(stamp.date, 14); central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(compressed.length, 20); central.writeUInt32LE(raw.length, 24); central.writeUInt16LE(name.length, 28); central.writeUInt32LE(offset, 42);
    centrals.push(central, name);
    offset += local.length + name.length + compressed.length;
  }
  const centralSize = centrals.reduce((sum, item) => sum + item.length, 0);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0); end.writeUInt16LE(listFiles(directory).length, 8); end.writeUInt16LE(listFiles(directory).length, 10);
  end.writeUInt32LE(centralSize, 12); end.writeUInt32LE(offset, 16);
  fs.writeFileSync(destination, Buffer.concat([...locals, ...centrals, end]));
}

function build(target) {
  const targetDir = path.join(staging, target);
  copyDirectory(source, targetDir);
  const manifestPath = path.join(targetDir, "manifest.json");
  const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
  manifest.version = version;
  if (target === "sogou") {
    manifest.minimum_chrome_version = "109";
    // Keep both entry surfaces in the compatibility package. Sogou/360 builds
    // that expose chrome.sidePanel can switch to the persistent side panel;
    // older builds retain the action popup as the safe default.
    manifest.action.default_popup = "sidepanel/index.html";
  } else {
    manifest.minimum_chrome_version = "116";
    delete manifest.action.default_popup;
  }
  fs.writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
  const label = target === "chrome-edge" ? "chrome-edge" : "sogou";
  const zipPath = path.join(output, `pagecue-${label}-${version}.zip`);
  zipDirectory(targetDir, zipPath);
  fs.mkdirSync(downloads, { recursive: true });
  fs.copyFileSync(zipPath, path.join(downloads, path.basename(zipPath)));
  return { target, zipPath, bytes: fs.statSync(zipPath).size, manifest };
}

fs.rmSync(staging, { recursive: true, force: true });
fs.mkdirSync(staging, { recursive: true });
const results = [build("chrome-edge"), build("sogou")];
for (const result of results) console.log(`${result.target}: ${result.zipPath} (${result.bytes} bytes, minimum ${result.manifest.minimum_chrome_version})`);
