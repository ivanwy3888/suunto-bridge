const fs = require("fs");
const path = require("path");
const os = require("os");
const zlib = require("zlib");
const crypto = require("crypto");
const https = require("https");

const CRC_TABLE = (() => {
  const t = new Int32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c;
  }
  return t;
})();

function crc32(buf) {
  let c = -1;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ -1) >>> 0;
}

// 只写 deflate 的 ZIP，够颂拓解开就行
function buildZip(files) {
  const locals = [];
  const centrals = [];
  let offset = 0;
  for (const f of files) {
    const name = Buffer.from(f.name, "utf8");
    const raw = fs.readFileSync(f.path);
    const body = zlib.deflateRawSync(raw);
    const crc = crc32(raw);

    const lh = Buffer.alloc(30);
    lh.writeUInt32LE(0x04034b50, 0);
    lh.writeUInt16LE(20, 4);
    lh.writeUInt16LE(0x0800, 6);
    lh.writeUInt16LE(8, 8);
    lh.writeUInt16LE(0, 10);
    lh.writeUInt16LE(0x0021, 12);
    lh.writeUInt32LE(crc, 14);
    lh.writeUInt32LE(body.length, 18);
    lh.writeUInt32LE(raw.length, 22);
    lh.writeUInt16LE(name.length, 26);
    lh.writeUInt16LE(0, 28);
    locals.push(lh, name, body);

    const ch = Buffer.alloc(46);
    ch.writeUInt32LE(0x02014b50, 0);
    ch.writeUInt16LE(20, 4);
    ch.writeUInt16LE(20, 6);
    ch.writeUInt16LE(0x0800, 8);
    ch.writeUInt16LE(8, 10);
    ch.writeUInt16LE(0, 12);
    ch.writeUInt16LE(0x0021, 14);
    ch.writeUInt32LE(crc, 16);
    ch.writeUInt32LE(body.length, 20);
    ch.writeUInt32LE(raw.length, 24);
    ch.writeUInt16LE(name.length, 28);
    ch.writeUInt16LE(0, 30);
    ch.writeUInt16LE(0, 32);
    ch.writeUInt16LE(0, 34);
    ch.writeUInt16LE(0, 36);
    ch.writeUInt32LE(0, 38);
    ch.writeUInt32LE(offset, 42);
    centrals.push(ch, name);

    offset += 30 + name.length + body.length;
  }
  const cd = Buffer.concat(centrals);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(0, 4);
  eocd.writeUInt16LE(0, 6);
  eocd.writeUInt16LE(files.length, 8);
  eocd.writeUInt16LE(files.length, 10);
  eocd.writeUInt32LE(cd.length, 12);
  eocd.writeUInt32LE(offset, 16);
  eocd.writeUInt16LE(0, 20);
  return Buffer.concat([...locals, cd, eocd]);
}

function zipFolder(folder) {
  const names = fs
    .readdirSync(folder)
    .filter((n) => n.toLowerCase().endsWith(".fit"))
    .sort();
  if (!names.length) {
    const err = new Error("文件夹里没有 .fit 文件，先下载记录");
    err.userMessage = true;
    throw err;
  }
  const zipPath = path.join(os.tmpdir(), `SuuntoBridge-${crypto.randomUUID()}.zip`);
  const buf = buildZip(names.map((n) => ({ name: n, path: path.join(folder, n) })));
  fs.writeFileSync(zipPath, buf);
  return { zipPath, count: names.length };
}

function num(v) {
  if (typeof v === "number") return v;
  if (typeof v === "string") return parseInt(v, 10) || 0;
  return 0;
}

function parseReply(status, text) {
  if (status === 401 || status === 403) {
    return { ok: false, message: "颂拓那边登录过期了，在窗口里重新登录再点一次" };
  }
  let obj;
  try {
    obj = JSON.parse(text);
  } catch {
    return { ok: false, message: `颂拓没给结果（HTTP ${status}）：${String(text).slice(0, 160)}` };
  }
  // 颂拓把回执包在 {"data":{"true":N,"false":M}} 里
  const inner = obj && typeof obj.data === "object" && obj.data ? obj.data : obj || {};
  const has = (k) => Object.prototype.hasOwnProperty.call(inner, k);
  if (has("true") || has("false")) {
    return { ok: true, success: num(inner.true), failed: num(inner.false) };
  }
  if (obj && obj.error && obj.error.description) return { ok: false, message: obj.error.description };
  return { ok: false, message: `颂拓没认这批文件（HTTP ${status}）：${String(text).slice(0, 160)}` };
}

function uploadZip(zipPath, token, onProgress) {
  return new Promise((resolve) => {
    const boundary = `----SuuntoBridge${crypto.randomUUID()}`;
    const head = Buffer.from(
      `--${boundary}\r\n` +
        `Content-Disposition: form-data; name="file"; filename="suunto-import.zip"\r\n` +
        `Content-Type: application/zip\r\n\r\n`
    );
    const tail = Buffer.from(`\r\n--${boundary}--\r\n`);
    const size = fs.statSync(zipPath).size;
    const total = head.length + size + tail.length;

    let sent = 0;
    const tick = (n) => {
      sent += n;
      onProgress(Math.min(1, sent / total));
    };

    const req = https.request(
      {
        host: "api.sports-tracker.com",
        path: "/apiserver/management/user/import/fits",
        method: "POST",
        headers: {
          "Content-Type": `multipart/form-data; boundary=${boundary}`,
          "Content-Length": total,
          STTAuthorization: token,
          Accept: "application/json, text/plain, */*",
        },
        timeout: 300000,
      },
      (res) => {
        let text = "";
        res.setEncoding("utf8");
        res.on("data", (d) => (text += d));
        res.on("end", () => resolve(parseReply(res.statusCode || 0, text)));
        res.on("error", () => resolve({ ok: false, message: "上传中断，再点一次" }));
      }
    );
    req.on("error", (e) => resolve({ ok: false, message: `上传中断：${e.message}` }));

    req.write(head);
    tick(head.length);
    const rs = fs.createReadStream(zipPath, { highWaterMark: 1 << 20 });
    rs.on("data", (chunk) => {
      tick(chunk.length);
      if (!req.write(chunk)) rs.pause();
    });
    req.on("drain", () => rs.resume());
    rs.on("end", () => {
      req.write(tail);
      tick(tail.length);
      req.end();
    });
    rs.on("error", () => resolve({ ok: false, message: "读不到打包好的文件" }));
  });
}

module.exports = { zipFolder, uploadZip, parseReply };