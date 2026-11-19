const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const { spawn } = require("child_process");

const FS_REDIRECT = "https://personal.fitnesssyncer.com/";
const FS_SCOPES =
  "source_read source_data_activity_read notebook_activity_write destination_read destination_write";
const FS_CLIENT_ID = "0EFA66C9AABD4CC0909BCC142990E553";
const FS_DEST_URL = "https://api.fitnesssyncer.com/api/providers/destinations/";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function baseURL(region) {
  return region === "global"
    ? "https://api.sports-tracker.com/apiserver/v1/"
    : "https://api.suunto.cn/apiserver/v1/";
}

function startMs(w) {
  const v = w && w.startTime;
  return typeof v === "number" ? v : 0;
}

function pad(n) {
  return String(n).padStart(2, "0");
}

function fmtLocal(ms) {
  const d = new Date(ms);
  return (
    d.getFullYear() +
    pad(d.getMonth() + 1) +
    pad(d.getDate()) +
    "-" +
    pad(d.getHours()) +
    pad(d.getMinutes())
  );
}

function isFitFile(file) {
  try {
    const fd = fs.openSync(file, "r");
    const buf = Buffer.alloc(14);
    const n = fs.readSync(fd, buf, 0, 14, 0);
    fs.closeSync(fd);
    return n === 14 && buf.slice(8, 12).toString("ascii") === ".FIT";
  } catch {
    return false;
  }
}

function fileSize(file) {
  try {
    return fs.statSync(file).size;
  } catch {
    return 0;
  }
}

function readJson(file) {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    return null;
  }
}

class Backend {
  constructor({ toolPath, supportDir, downloadsDir }) {
    this.toolPath = toolPath;
    this.supportDir = supportDir;
    this.downloadsDir = downloadsDir;
    this.cancelled = false;
    this.current = null;
    this._ensureDir(supportDir);
  }

  _ensureDir(dir) {
    try {
      fs.mkdirSync(dir, { recursive: true });
    } catch {}
  }

  begin() {
    this.cancelled = false;
  }

  isBusy() {
    return !!this.current;
  }

  cancel() {
    this.cancelled = true;
    this._killCurrent();
  }

  _killCurrent() {
    const c = this.current;
    if (!c) return;
    this.current = null;
    try {
      c.kill("SIGKILL");
    } catch {}
  }

  runTool(args, { env = {}, stdin = null, timeout = 120000 } = {}) {
    return new Promise((resolve) => {
      let child;
      try {
        child = spawn(this.toolPath, args, {
          env: Object.assign({}, process.env, env),
          windowsHide: true,
          stdio: ["pipe", "pipe", "pipe"],
        });
      } catch (e) {
        resolve({ code: 1, out: "", err: "无法启动组件: " + e.message });
        return;
      }

      this.current = child;
      let out = "";
      let err = "";
      let done = false;
      const finish = (code) => {
        if (done) return;
        done = true;
        clearTimeout(timer);
        if (this.current === child) this.current = null;
        resolve({ code, out, err });
      };

      child.stdout.on("data", (d) => {
        if (out.length < 4 * 1024 * 1024) out += d.toString("utf8");
      });
      child.stderr.on("data", (d) => {
        if (err.length < 4 * 1024 * 1024) err += d.toString("utf8");
      });
      child.on("error", (e) => {
        err += (err ? "\n" : "") + "无法启动组件: " + e.message;
        finish(1);
      });
      child.on("close", (code) => finish(code == null ? 1 : code));

      const timer = setTimeout(() => {
        if (this.current === child) this.current = null;
        try {
          child.kill("SIGKILL");
        } catch {}
      }, timeout);

      try {
        child.stdin.end(stdin == null ? "" : stdin);
      } catch {}
    });
  }

  // ---- 账号 ----

  sessionURL(region) {
    return path.join(this.supportDir, `session-${region}.json`);
  }

  hasSession(region) {
    try {
      return fs.existsSync(this.sessionURL(region));
    } catch {
      return false;
    }
  }

  email(region) {
    const o = readJson(this.sessionURL(region));
    return (o && typeof o.email === "string" && o.email) || "";
  }

  _toolEnv(region) {
    return {
      SUUNTOOL_BASE_URL: baseURL(region),
      SUUNTOOL_SESSION_FILE: this.sessionURL(region),
      NO_COLOR: "1",
    };
  }

  async login(region, email, password) {
    const res = await this.runTool(
      ["login", "--email", email, "--password-stdin"],
      { env: this._toolEnv(region), stdin: password + "\n", timeout: 60000 }
    );
    if (res.code === 0) return { ok: true, message: "登录成功" };
    let msg = this._friendlyError(res);
    if (res.code === 4 || !msg) msg = `邮箱或密码不对（${res.code}）`;
    return { ok: false, message: msg };
  }

  _friendlyError(r) {
    const lines = (r.err + "\n" + r.out)
      .split("\n")
      .map((s) => s.trim())
      .filter(Boolean);
    const hit = lines.find(
      (l) => l.toLowerCase().includes("error") || l.toLowerCase().includes("fail")
    );
    if (!hit) return "";
    return hit.length > 220 ? hit.slice(0, 220) + "…" : hit;
  }

  // ---- 导出 ----

  async _fetchWorkouts(region, from, to, progress) {
    if (!this.hasSession(region))
      return { items: [], error: { ok: false, message: "请先登录颂拓账号" } };
    progress({ type: "stage", text: "正在获取记录列表…" });

    const pageFile = path.join(this.supportDir, "workouts-page.json");
    const sinceArgs = [];
    if (from > 0) {
      const iso = new Date(from).toISOString().replace(/\.\d{3}Z$/, "Z");
      sinceArgs.push("--since", iso);
    }

    const workouts = [];
    const seen = new Set();
    let offset = 0;
    while (offset < 20000) {
      if (this.cancelled) break;
      try {
        fs.unlinkSync(pageFile);
      } catch {}
      const args = [
        "workouts",
        "list",
        "--limit",
        "100",
        "--offset",
        String(offset),
        "--format",
        "json",
        "-o",
        pageFile,
        ...sinceArgs,
      ];
      const res = await this.runTool(args, { env: this._toolEnv(region), timeout: 120000 });
      if (res.code === 4)
        return { items: [], error: { ok: false, message: "登录已过期，请重新登录" } };
      const obj = res.code === 0 ? readJson(pageFile) : null;
      if (!obj || !Array.isArray(obj.items)) {
        if (workouts.length === 0)
          return { items: [], error: { ok: false, message: `获取列表失败（${res.code}）` } };
        break;
      }
      let added = 0;
      for (const w of obj.items) {
        if (w && typeof w.key === "string" && !seen.has(w.key)) {
          seen.add(w.key);
          workouts.push(w);
          added++;
        }
      }
      progress({ type: "stage", text: `正在读取记录…（已取到 ${workouts.length} 条）` });
      if (obj.items.length < 100 || added === 0) break;
      offset += 100;
    }

    if (workouts.length === 0) {
      if (from > 0 || to > 0)
        return {
          items: [],
          error: { ok: false, empty: true, message: "这段时间里没有记录，换个日期再试" },
        };
      return { items: [], error: { ok: false, message: "账号里没有记录" } };
    }

    let list = workouts;
    if (from > 0 || to > 0) {
      list = workouts.filter((w) => {
        const ms = startMs(w);
        if (from > 0 && ms < from) return false;
        if (to > 0 && ms > to) return false;
        return true;
      });
      if (list.length === 0)
        return {
          items: [],
          error: { ok: false, empty: true, message: "这段时间里没有记录，换个日期再试" },
        };
      progress({
        type: "stage",
        text: `符合条件的有 ${list.length} 条`,
        total: list.length,
      });
    } else {
      progress({ type: "stage", text: `共 ${list.length} 条记录`, total: list.length });
    }
    return { items: list, error: null };
  }

  async count(region, from, to) {
    this.begin();
    const r = await this._fetchWorkouts(region, from, to, () => {});
    if (r.error) {
      if (r.error.empty) return { ok: true, total: 0 };
      return r.error;
    }
    return { ok: true, total: r.items.length };
  }

  async exportFit(region, folder, from, to, progress) {
    this.begin();
    if (!this.hasSession(region))
      return { ok: false, message: "请先登录颂拓账号" };
    const dir = folder;
    this._ensureDir(dir);

    const fetched = await this._fetchWorkouts(region, from, to, progress);
    if (fetched.error) return fetched.error;
    const workouts = fetched.items;
    const total = workouts.length;
    const maxItems = parseInt(process.env.SUUNTO_BRIDGE_MAX || "0", 10) || 0;

    let csv =
      "\uFEFF开始时间,activityId,总时长秒,距离米,爬升米,步数,平均心率,文件名,workoutKey\n";
    let okCount = 0;
    let skipCount = 0;
    let failCount = 0;
    const failures = [];

    for (let i = 0; i < workouts.length; i++) {
      if (this.cancelled) break;
      if (maxItems > 0 && i >= maxItems) break;
      const w = workouts[i];
      const key = typeof w.key === "string" ? w.key : "";
      const ms = startMs(w);
      const date = fmtLocal(ms);
      const act = Number.isFinite(w.activityId) ? w.activityId : 0;
      const name = `${date}_a${act}_${key}.fit`;
      const dest = path.join(dir, name);
      const hasFile = fileSize(dest) > 200;

      let note = "";
      if (hasFile) {
        skipCount++;
        note = "已存在";
      } else {
        const res = await this.runTool(
          ["workouts", "fit", key, "-o", dest, "--timeout", "90s"],
          { env: this._toolEnv(region), timeout: 120000 }
        );
        const size = fileSize(dest);
        if (res.code === 0 && size > 200 && isFitFile(dest)) {
          okCount++;
        } else {
          try {
            fs.unlinkSync(dest);
          } catch {}
          failCount++;
          failures.push(name);
          note = `失败 ${res.code}`;
        }
      }

      const dur = Number(w.totalTime) || 0;
      const dist = Number(w.totalDistance) || 0;
      const asc = Number(w.totalAscent) || 0;
      const steps = Number(w.stepCount) || 0;
      let avgHr = "";
      if (w.hrdata && Number.isFinite(w.hrdata.avg)) avgHr = String(w.hrdata.avg);
      const fileCell = fileSize(dest) > 200 ? name : "";
      csv += `${date},${act},${Math.trunc(dur)},${Math.trunc(dist)},${Math.trunc(
        asc
      )},${steps},${avgHr},${fileCell},${key}\n`;

      progress({
        type: "item",
        index: i + 1,
        total,
        name,
        note,
        ok: okCount,
        skip: skipCount,
        fail: failCount,
      });
      if (!hasFile) await sleep(500);
    }

    const csvPath = path.join(dir, "导出清单.csv");
    try {
      fs.writeFileSync(csvPath, csv, "utf8");
    } catch {}

    progress({ type: "stage", text: this.cancelled ? "已停止" : "导出结束，清单已保存" });
    return {
      ok: true,
      stopped: this.cancelled,
      total,
      downloaded: okCount,
      skipped: skipCount,
      failed: failCount,
      failures: failures.slice(0, 8),
      csv: csvPath,
      folder: dir,
    };
  }

  // ---- FitnessSyncer 凭据 ----

  get fsAuthFile() {
    return path.join(this.supportDir, "fs-oauth.json");
  }

  get fsAuth() {
    const o = readJson(this.fsAuthFile);
    return o && typeof o === "object" && !Array.isArray(o) ? o : {};
  }

  set fsAuth(obj) {
    try {
      fs.writeFileSync(this.fsAuthFile, JSON.stringify(obj), { encoding: "utf8" });
      fs.chmodSync(this.fsAuthFile, 0o600);
    } catch {}
  }

  get fsActiveClientID() {
    return FS_CLIENT_ID;
  }

  _migrateAuth() {
    const a = Object.assign({}, this.fsAuth);
    if (a.clientId !== FS_CLIENT_ID) {
      delete a.accessToken;
      delete a.refreshToken;
      delete a.expiresAt;
      delete a.clientSecret;
      a.clientId = FS_CLIENT_ID;
      this.fsAuth = a;
    }
    return a;
  }

  fsAuthState() {
    const a = this._migrateAuth();
    return {
      hasSecret: true,
      secretLength: 0,
      connected: !!(typeof a.refreshToken === "string" && a.refreshToken),
      clientId: FS_CLIENT_ID,
    };
  }

  fsSignOut() {
    const a = Object.assign({}, this.fsAuth);
    delete a.accessToken;
    delete a.refreshToken;
    delete a.expiresAt;
    this.fsAuth = a;
    return { ok: true };
  }

  fsAuthorizeURL(state) {
    this._migrateAuth();
    const verifier = crypto.randomBytes(32).toString("base64url");
    const challenge = crypto.createHash("sha256").update(verifier).digest("base64url");
    this._pkceVerifier = verifier;
    const u = new URL("https://www.fitnesssyncer.com/api/oauth/authorize");
    u.searchParams.set("response_type", "code");
    u.searchParams.set("client_id", FS_CLIENT_ID);
    u.searchParams.set("redirect_uri", FS_REDIRECT);
    u.searchParams.set("scope", FS_SCOPES);
    u.searchParams.set("state", state);
    u.searchParams.set("code_challenge", challenge);
    u.searchParams.set("code_challenge_method", "S256");
    return u.toString();
  }

  _formBody(pairs) {
    return pairs.map(([k, v]) => `${k}=${encodeURIComponent(v)}`).join("&");
  }

  async _httpResp(method, urlStr, { token, body, contentType, redirect = "follow" } = {}) {
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), 120000);
    const headers = { "User-Agent": "SuuntoBridge/1.0" };
    if (token) headers.Authorization = `Bearer ${token}`;
    if (body != null && contentType) headers["Content-Type"] = contentType;
    try {
      const res = await fetch(urlStr, {
        method,
        headers,
        body: body == null ? undefined : body,
        redirect,
        signal: ctl.signal,
      });
      const data = Buffer.from(await res.arrayBuffer());
      return { status: res.status, location: res.headers.get("location"), data };
    } catch {
      return { status: 0, location: null, data: Buffer.alloc(0) };
    } finally {
      clearTimeout(timer);
    }
  }

  async _http(method, urlStr, opts = {}) {
    const r = await this._httpResp(method, urlStr, opts);
    return { status: r.status, data: r.data };
  }

  _tokenJSON(d) {
    try {
      const o = JSON.parse(d.toString("utf8"));
      return o && typeof o === "object" ? o : null;
    } catch {
      return null;
    }
  }

  _storeToken(obj) {
    const a = Object.assign({}, this.fsAuth);
    if (typeof obj.access_token === "string") a.accessToken = obj.access_token;
    if (typeof obj.refresh_token === "string") a.refreshToken = obj.refresh_token;
    const ttl = Number(obj.expires_in) || 0;
    a.expiresAt = Date.now() / 1000 + ttl;
    if (typeof obj.scope === "string") a.scope = obj.scope;
    this.fsAuth = a;
  }

  _textOf(d) {
    return (d || Buffer.alloc(0)).slice(0, 300).toString("utf8");
  }

  _arraysFrom(obj) {
    if (Array.isArray(obj)) return obj;
    if (obj && typeof obj === "object") {
      for (const k of ["items", "sources", "data", "results", "list"]) {
        if (Array.isArray(obj[k])) return obj[k];
      }
      if (obj.data && typeof obj.data === "object") {
        for (const k of ["items", "sources"]) {
          if (Array.isArray(obj.data[k])) return obj.data[k];
        }
      }
    }
    return [];
  }

  async fsExchangeCode(code) {
    this._migrateAuth();
    const verifier = this._pkceVerifier || "";
    this._pkceVerifier = "";
    if (!verifier)
      return { ok: false, message: "授权校验码丢了，再点一次「登录并授权」" };
    const body = this._formBody([
      ["grant_type", "authorization_code"],
      ["code", code],
      ["client_id", FS_CLIENT_ID],
      ["redirect_uri", FS_REDIRECT],
      ["code_verifier", verifier],
    ]);
    const { status, data } = await this._http(
      "POST",
      "https://api.fitnesssyncer.com/api/oauth/access_token",
      { body, contentType: "application/x-www-form-urlencoded" }
    );
    const obj = this._tokenJSON(data);
    if (status !== 200 || !obj || typeof obj.access_token !== "string") {
      const msg =
        (obj && (obj.error_description || obj.error)) || this._textOf(data);
      return { ok: false, message: `换令牌失败（HTTP ${status}）：${msg}` };
    }
    this._storeToken(obj);
    return { ok: true };
  }

  async fsToken(force = false) {
    const a = this.fsAuth;
    const now = Date.now() / 1000;
    const exp = Number(a.expiresAt) || 0;
    const cached = typeof a.accessToken === "string" ? a.accessToken : "";
    if (!force && cached && exp - now > 120) return cached;
    const rt = typeof a.refreshToken === "string" ? a.refreshToken : "";
    if (!rt) return cached || null;
    const body = this._formBody([
      ["grant_type", "refresh_token"],
      ["refresh_token", rt],
      ["client_id", FS_CLIENT_ID],
      ["redirect_uri", FS_REDIRECT],
    ]);
    const { status, data } = await this._http(
      "POST",
      "https://api.fitnesssyncer.com/api/oauth/access_token",
      { body, contentType: "application/x-www-form-urlencoded" }
    );
    const obj = this._tokenJSON(data);
    if (status === 200 && obj && typeof obj.access_token === "string") {
      this._storeToken(obj);
      return obj.access_token;
    }
    return cached || null;
  }

  async fsConnect() {
    let tok = await this.fsToken();
    if (!tok) return { ok: false, message: "还没授权，先点登录并授权" };
    let r = await this._http("GET", "https://api.fitnesssyncer.com/api/providers/sources", { token: tok });
    if (r.status === 401) {
      tok = (await this.fsToken(true)) || tok;
      r = await this._http("GET", "https://api.fitnesssyncer.com/api/providers/sources", { token: tok });
    }
    if (r.status !== 200)
      return { ok: false, message: `读来源失败（HTTP ${r.status}）：${this._textOf(r.data)}` };
    const list = this._arraysFrom(this._tokenJSON(r.data));
    const out = [];
    for (const s of list) {
      let id = "";
      if (typeof s.id === "string") id = s.id;
      else if (typeof s.id === "number") id = String(s.id);
      else if (typeof s.sourceId === "string") id = s.sourceId;
      let name = "";
      for (const k of ["name", "displayName", "title", "provider"]) {
        if (typeof s[k] === "string" && s[k]) {
          name = s[k];
          break;
        }
      }
      if (!id) continue;
      out.push({ id, name: name || id });
    }
    return { ok: true, sources: out };
  }

  _filesAndLedger(folder) {
    let files = [];
    try {
      files = fs
        .readdirSync(folder, { withFileTypes: true })
        .filter((d) => d.isFile() && d.name.toLowerCase().endsWith(".fit"))
        .map((d) => d.name)
        .sort();
    } catch {}
    const ledger = new Set();
    try {
      const raw = fs.readFileSync(path.join(folder, "已上传.txt"), "utf8");
      for (const line of raw.split("\n")) {
        const n = line.trim();
        if (n) ledger.add(n);
      }
    } catch {}
    return { files, ledger };
  }

  folderStats(folder) {
    const { files, ledger } = this._filesAndLedger(folder);
    const done = files.filter((n) => ledger.has(n)).length;
    return { ok: true, total: files.length, done, pending: files.length - done };
  }

  async fsUpload(sourceId, folder, progress) {
    this.begin();
    let tok = await this.fsToken();
    if (!tok) return { ok: false, message: "还没授权" };
    const { files, ledger } = this._filesAndLedger(folder);
    if (files.length === 0)
      return { ok: false, message: "这个文件夹里没有 .fit 文件" };

    const sid = sourceId || "notebook";
    const ledgerPath = path.join(folder, "已上传.txt");
    if (!fs.existsSync(ledgerPath)) {
      try {
        fs.writeFileSync(ledgerPath, "");
      } catch {}
    }
    const endpoint = `https://api.fitnesssyncer.com/api/providers/sources/${sid}/items/upload`;

    let okCount = 0;
    let skipCount = 0;
    let failCount = 0;
    const failures = [];
    const total = files.length;

    for (let i = 0; i < files.length; i++) {
      if (this.cancelled) break;
      const name = files[i];
      if (ledger.has(name)) {
        skipCount++;
        progress({
          type: "item",
          index: i + 1,
          total,
          name,
          note: "之前传过",
          ok: okCount,
          skip: skipCount,
          fail: failCount,
        });
        continue;
      }
      let fileData;
      try {
        fileData = fs.readFileSync(path.join(folder, name));
      } catch {
        failCount++;
        failures.push(name);
        continue;
      }
      const boundary = "----SuuntoBridge" + Math.random().toString(16).slice(2) + Date.now().toString(16);
      const body = Buffer.concat([
        Buffer.from(`--${boundary}\r\n`, "utf8"),
        Buffer.from(
          `Content-Disposition: form-data; name="file"; filename="${name}"\r\n`,
          "utf8"
        ),
        Buffer.from("Content-Type: application/octet-stream\r\n\r\n", "utf8"),
        fileData,
        Buffer.from(`\r\n--${boundary}--\r\n`, "utf8"),
      ]);

      let r = await this._http("POST", endpoint, {
        token: tok,
        body,
        contentType: `multipart/form-data; boundary=${boundary}`,
      });
      if (r.status === 401) {
        tok = (await this.fsToken(true)) || tok;
        r = await this._http("POST", endpoint, {
          token: tok,
          body,
          contentType: `multipart/form-data; boundary=${boundary}`,
        });
      }
      let note = "";
      if (r.status === 200) {
        okCount++;
        try {
          fs.appendFileSync(ledgerPath, name + "\n");
        } catch {}
        const o = this._tokenJSON(r.data);
        if (o && Array.isArray(o.items)) {
          const hint = this._itemDateHint(name);
          let cleared = 0;
          for (const it of o.items) {
            if (it && typeof it.id === "string") {
              const c = await this._clearImportedComment(it.id, hint, tok);
              tok = c.tok;
              if (c.ok) cleared++;
            }
          }
          if (cleared > 0) note = "已清掉文件名评论";
        }
      } else {
        failCount++;
        failures.push(name);
        note = `HTTP ${r.status}`;
        if (r.status === 401 || r.status === 403) {
          progress({
            type: "item",
            index: i + 1,
            total,
            name,
            note,
            ok: okCount,
            skip: skipCount,
            fail: failCount,
          });
          return {
            ok: false,
            message: `FitnessSyncer 拒绝了这次上传（HTTP ${r.status}）：${this._textOf(r.data)}`,
            total,
            uploaded: okCount,
            skipped: skipCount,
            failed: failCount,
          };
        }
      }
      progress({
        type: "item",
        index: i + 1,
        total,
        name,
        note,
        ok: okCount,
        skip: skipCount,
        fail: failCount,
      });
      await sleep(400);
    }

    progress({ type: "stage", text: this.cancelled ? "已停止" : "上传结束" });
    return {
      ok: true,
      stopped: this.cancelled,
      total,
      uploaded: okCount,
      skipped: skipCount,
      failed: failCount,
      failures: failures.slice(0, 8),
      source: "FitnessSyncer",
    };
  }

  _itemDateHint(name) {
    if (name.length < 13) return null;
    const s = name.slice(0, 13);
    const m = /^(\d{4})(\d{2})(\d{2})-(\d{2})(\d{2})$/.exec(s);
    if (!m) return null;
    return new Date(
      Number(m[1]),
      Number(m[2]) - 1,
      Number(m[3]),
      Number(m[4]),
      Number(m[5])
    );
  }

  async _clearImportedComment(itemID, hint, tok) {
    const nb = "https://api.fitnesssyncer.com/api/providers/sources/notebook";
    const find = async (query) => {
      let r = await this._httpResp("GET", `${nb}/itemsByType/Activity?${query}`, { token: tok });
      if (r.status === 401) {
        tok = (await this.fsToken(true)) || tok;
        r = await this._httpResp("GET", `${nb}/itemsByType/Activity?${query}`, { token: tok });
      }
      if (r.status !== 200) return { hit: null, tok };
      const o = this._tokenJSON(r.data);
      const items = o && Array.isArray(o.items) ? o.items : null;
      if (!items) return { hit: null, tok };
      return { hit: items.find((x) => x && x.itemId === itemID) || null, tok };
    };

    let hit = null;
    if (hint) {
      const ms = hint.getTime();
      const span = 2 * 86400000;
      const r1 = await find(
        `startDate=${ms - span}&endDate=${ms + span}&limit=100`
      );
      hit = r1.hit;
      tok = r1.tok;
    }
    if (!hit) {
      const r2 = await find("limit=100");
      hit = r2.hit;
      tok = r2.tok;
    }
    if (!hit) return { ok: false, tok };
    const c = typeof hit.comment === "string" ? hit.comment : "";
    if (!c.startsWith("Imported from")) return { ok: true, tok };
    delete hit.comment;
    const payload = Buffer.from(JSON.stringify(hit), "utf8");
    let r = await this._httpResp("POST", `${nb}/items/${itemID}`, {
      token: tok,
      body: payload,
      contentType: "application/json",
    });
    if (r.status === 401) {
      tok = (await this.fsToken(true)) || tok;
      r = await this._httpResp("POST", `${nb}/items/${itemID}`, {
        token: tok,
        body: payload,
        contentType: "application/json",
      });
    }
    return { ok: r.status === 200, tok };
  }

  // ---- 目的地 ----

  async _destCall(method, urlStr, tok, bodyObj) {
    const payload = bodyObj == null ? null : Buffer.from(JSON.stringify(bodyObj), "utf8");
    let r = await this._httpResp(method, urlStr, {
      token: tok,
      body: payload,
      contentType: payload ? "application/json" : undefined,
      redirect: "manual",
    });
    if (r.status === 401) {
      tok = (await this.fsToken(true)) || tok;
      r = await this._httpResp(method, urlStr, {
        token: tok,
        body: payload,
        contentType: payload ? "application/json" : undefined,
        redirect: "manual",
      });
    }
    return { r, tok };
  }

  async _destList(tok) {
    const { r, tok: t } = await this._destCall("GET", FS_DEST_URL, tok, null);
    if (r.status !== 200) return { list: null, tok: t };
    return { list: this._arraysFrom(this._tokenJSON(r.data)), tok: t };
  }

  _suuntoDest(list) {
    return (list || []).find((d) => d && d.providerType === "SuuntoApp") || null;
  }

  async _suuntoAuthID(tok) {
    const { r, tok: t } = await this._destCall(
      "GET",
      "https://api.fitnesssyncer.com/api/providers/authentication/",
      tok,
      null
    );
    tok = t;
    if (r.status !== 200) return { id: null, tok };
    const o = this._tokenJSON(r.data);
    const provs = o && Array.isArray(o.providers) ? o.providers : [];
    for (const p of provs) {
      if (p && p.providerType === "SuuntoApp") {
        const keys = Array.isArray(p.keys) ? p.keys : [];
        const id = keys[0] && typeof keys[0].id === "string" ? keys[0].id : null;
        return { id, tok };
      }
    }
    return { id: null, tok };
  }

  async destAuthed() {
    let tok = await this.fsToken();
    if (!tok) return false;
    const { id } = await this._suuntoAuthID(tok);
    return !!id;
  }

  async destStatus() {
    let tok = await this.fsToken();
    if (!tok)
      return { ok: false, needFs: true, message: "还没连接 FitnessSyncer，先在第二个选项卡里授权" };
    let r = await this._destList(tok);
    tok = r.tok;
    if (!r.list)
      return {
        ok: false,
        message: "读目的地失败：令牌里可能没有「目的地」权限，去第二个选项卡点「重新授权」",
      };
    const dest = this._suuntoDest(r.list);
    if (!dest) return { ok: true, found: false, authed: false };
    const id = typeof dest.id === "string" ? dest.id : "";
    let authed = false;
    if (id) {
      const a = await this._suuntoAuthID(tok);
      tok = a.tok;
      authed = !!a.id;
    }
    let sync = {};
    const sr = await this._destCall(
      "GET",
      "https://api.fitnesssyncer.com/api/syncs/",
      tok,
      null
    );
    tok = sr.tok;
    if (sr.r.status === 200) {
      const o = this._tokenJSON(sr.r.data);
      const results = o && Array.isArray(o.results) ? o.results : [];
      for (let i = results.length - 1; i >= 0; i--) {
        if (results[i] && results[i].id === id) {
          sync = results[i];
          break;
        }
      }
    }
    return {
      ok: true,
      found: true,
      authed,
      id,
      name: typeof dest.name === "string" ? dest.name : "颂拓国际",
      enabled: typeof dest.enabled === "boolean" ? dest.enabled : true,
      lastDate: Number(dest.date) || 0,
      lastError: typeof dest.lastError === "string" ? dest.lastError : "",
      syncQueue: typeof sync.queueStatus === "string" ? sync.queueStatus : "",
      syncStatus: typeof sync.status === "string" ? sync.status : "",
      syncUpdate: typeof sync.update === "string" ? sync.update : "",
      syncOk: typeof sync.success === "boolean" ? sync.success : false,
    };
  }

  async destPrepare(force = false) {
    let tok = await this.fsToken();
    if (!tok)
      return { ok: false, needFs: true, message: "还没连接 FitnessSyncer，先在第二个选项卡里授权" };
    let r = await this._destList(tok);
    tok = r.tok;
    if (!r.list)
      return {
        ok: false,
        message: "读目的地失败：令牌里可能没有「目的地」权限，去第二个选项卡点「重新授权」",
      };
    let dest = this._suuntoDest(r.list);
    let created = false;
    if (!dest) {
      const c = await this._destCall("PUT", FS_DEST_URL, tok, {
        type: "sync",
        name: "颂拓国际",
        providerType: "SuuntoApp",
        taskType: "Activity",
        enabled: true,
      });
      tok = c.tok;
      const obj = this._tokenJSON(c.r.data);
      const newID =
        (obj && typeof obj.id === "string" && obj.id) ||
        (obj && obj.item && typeof obj.item.id === "string" && obj.item.id) ||
        "";
      if (c.r.status !== 200 || !newID)
        return {
          ok: false,
          message: `建接收方失败（HTTP ${c.r.status}）：${this._textOf(c.r.data)}`,
        };
      dest = { id: newID, name: "颂拓国际" };
      created = true;
    }
    const id = typeof dest.id === "string" ? dest.id : "";
    const name = typeof dest.name === "string" ? dest.name : "颂拓国际";
    if (!id) return { ok: false, message: "接收方 id 是空的" };

    if (!force) {
      const a = await this._suuntoAuthID(tok);
      tok = a.tok;
      if (a.id) {
        if (created) {
          const c = await this._destCall("PUT", `${FS_DEST_URL}${id}/authentication`, tok, {
            type: "OAuthReuse",
            id: a.id,
          });
          tok = c.tok;
          if (c.r.status !== 200)
            return {
              ok: false,
              message: `复用颂拓授权失败（HTTP ${c.r.status}）：${this._textOf(c.r.data)}`,
            };
        }
        return { ok: true, needAuth: false, name, id };
      }
    }

    const c = await this._destCall("PUT", `${FS_DEST_URL}${id}/authentication`, tok, {
      type: "OAuth",
      redirect: "https://personal.fitnesssyncer.com/?dst=1",
    });
    tok = c.tok;
    if (c.r.status !== 202 || !c.r.location)
      return {
        ok: false,
        message: `发起颂拓授权失败（HTTP ${c.r.status}）：${this._textOf(c.r.data)}`,
      };
    return { ok: true, needAuth: true, url: c.r.location, name, id };
  }

  async destSync() {
    let tok = await this.fsToken();
    if (!tok)
      return { ok: false, message: "还没连接 FitnessSyncer，先在第二个选项卡里授权" };
    let r = await this._destList(tok);
    tok = r.tok;
    if (!r.list)
      return {
        ok: false,
        message: "读目的地失败：令牌里可能没有「目的地」权限，去第二个选项卡点「重新授权」",
      };
    const dest = this._suuntoDest(r.list);
    const id = dest && typeof dest.id === "string" ? dest.id : "";
    if (!id)
      return { ok: false, message: "FitnessSyncer 里还没有颂拓国际接收方，先点「登录颂拓国际」" };
    const a = await this._suuntoAuthID(tok);
    tok = a.tok;
    if (!a.id)
      return { ok: false, message: "颂拓国际还没登录授权，先点「登录颂拓国际」" };
    const c = await this._destCall("POST", `${FS_DEST_URL}${id}/execute`, tok, null);
    const status = c.r.status;
    if (status === 200 || status === 202)
      return { ok: true, message: "已提交给 FitnessSyncer，正在往颂拓国际送记录" };
    if (status === 409) return { ok: false, message: "上一次同步还没跑完，过一会儿再点" };
    if (status === 403)
      return { ok: false, message: "FitnessSyncer 没给这个账号开「立即执行」，可以先让它在网站上按计划跑" };
    return { ok: false, message: `提交失败（HTTP ${status}）：${this._textOf(c.r.data)}` };
  }
}

module.exports = { Backend };
