const PENDING = new Map();
let seq = 1;

const HAS_BRIDGE = !!(window.webkit && window.webkit.messageHandlers && window.webkit.messageHandlers.bridge);

// 浏览器里直接打开时用假数据预览样子
const MOCK = {
  status: { hasCN: true, hasGlobal: false, emailCN: "you@example.com", defaultFolder: "/Users/you/Downloads/颂拓导出", fs: { hasSecret: false, connected: false, clientId: "" }, },
  fsStartAuth: { ok: true },
  fsConnect: { ok: true, sources: [
    { id: "1", name: "Suunto (中国区)" }, { id: "2", name: "Strava" }, { id: "3", name: "Garmin" }
  ] },
  fsSignOut: { ok: true },
  folderStats: { ok: true, total: 256, done: 4, pending: 252 },
  destStatus: { ok: true, found: true, authed: true, name: "颂拓外区", lastDate: Date.now(), lastError: "",
                syncQueue: "COMPLETED", syncStatus: "Complete", syncUpdate: "Success", syncOk: true },
  destPrepare: { ok: true, needAuth: false, name: "颂拓外区", message: "颂拓国际已连上" },
  destSync: { ok: true, message: "已提交给 FitnessSyncer，正在往颂拓国际送记录" },
  count: { total: 256 },
  logout: { ok: true },
  export: async (emit) => {
    const total = 256;
    for (let i = 1; i <= total; i += 16) {
      emit({ type: "item", index: i, total, name: `20241130-0951_a22_sampleactivity01.fit`, note: "" });
      await new Promise((r) => setTimeout(r, 12));
    }
    return { total, downloaded: 256, skipped: 0, failed: 0, failures: [], csv: "/Users/you/Downloads/颂拓导出/导出清单.csv" };
  },
  fsUpload: async (emit) => {
    const total = 256;
    for (let i = 1; i <= total; i += 8) {
      emit({ type: "item", index: i, total, name: `20241130-0951_a22_sampleactivity01.fit`, note: "", ok: i, skip: 0, fail: 0 });
      await new Promise((r) => setTimeout(r, 12));
    }
    return { ok: true, total, uploaded: total, skipped: 0, failed: 0, failures: [], source: "FitnessSyncer" };
  },
};

function call(cmd, payload = {}) {
  return new Promise((resolve, reject) => {
    if (!HAS_BRIDGE) {
      if (cmd === "export") {
        MOCK.export((e) => { const f = onEvent.export; if (f) f(e); }).then(resolve, reject);
        return;
      }
      if (cmd === "fsUpload") {
        MOCK.uploadFolder = payload.folder || MOCK.uploadFolder;
        MOCK.fsUpload((e) => { const f = onEvent.upload; if (f) f(e); }).then(resolve, reject);
        return;
      }
      if (cmd === "login") { resolve({ ok: true }); return; }
      if (cmd === "pickFolder") { resolve({ path: MOCK.status.defaultFolder }); return; }
      const v = MOCK[cmd];
      if (v === undefined) { reject({ message: "预览模式不支持这个操作" }); return; }
      resolve(v);
      return;
    }
    const id = seq++;
    PENDING.set(id, { resolve, reject });
    window.webkit.messageHandlers.bridge.postMessage({ id, cmd, payload });
  });
}

window.__bridge = (msg) => {
  const p = PENDING.get(msg.id);
  if (!p) return;
  PENDING.delete(msg.id);
  if (msg.ok) p.resolve(msg.data || {});
  else p.reject(msg.data || { message: "操作失败" });
};

const onEvent = { export: null, upload: null };
window.__event = (e) => {
  if (onEvent.export) onEvent.export(e);
  if (onEvent.upload) onEvent.upload(e);
};

const $ = (id) => document.getElementById(id);
const prettyPath = (p) => (p || "").replace(/^\/Users\/[^/]+/, "~").replace(/^[A-Za-z]:\\Users\\[^\\]+/, "~");

function showFolder(el, path) {
  el.textContent = path ? prettyPath(path) : "—";
  el.title = path || "";
  el.dataset.path = path || "";
}

// ---------- 分页 ----------
const tabButtons = Array.from(document.querySelectorAll(".tab"));
const glow = $("tabGlow");
let activePane = "one";

function currentPane() { return activePane; }

function sizeGlow() {
  const btn = document.querySelector(`.tab[data-pane="${activePane}"]`);
  if (!btn) return;
  glow.style.width = btn.offsetWidth + "px";
  glow.style.transform = `translateX(${btn.offsetLeft - 4}px)`;
}

tabButtons.forEach((b) => {
  b.addEventListener("click", () => {
    activePane = b.dataset.pane;
    tabButtons.forEach((x) => x.classList.toggle("active", x === b));
    document.querySelectorAll(".pane").forEach((p) => {
      p.classList.toggle("active", p.id === "pane-" + activePane);
    });
    sizeGlow();
    setTimeout(reportHeight, 120);
    if (activePane === "three") refreshDest(true);
  });
});
window.addEventListener("resize", sizeGlow);

function reportHeight() {
  const h = Math.ceil(document.documentElement.scrollHeight);
  call("fitHeight", { height: h }).catch(() => {});
}

// ---------- 通用 ----------
function chip(el, text, kind) {
  el.textContent = text;
  el.className = "chip" + (kind ? " " + kind : "");
}

function logLine(box, text, kind) {
  const d = document.createElement("div");
  d.textContent = text;
  if (kind) d.className = kind;
  box.appendChild(d);
  while (box.children.length > 200) box.removeChild(box.firstChild);
  box.scrollTop = box.scrollHeight;
}

function setProgress(bar, count, noteEl, done, total, note) {
  bar.style.width = total ? Math.min(100, (done / total) * 100) + "%" : "0%";
  count.textContent = `${done} / ${total}`;
  if (noteEl && note !== undefined) noteEl.textContent = note;
}

// ---------- 模块一 ----------
const region = "cn";
let exportFolder = "";
let exportScope = "all";
let exportQueried = false;
let busyExport = false;

const state = { hasCN: false, hasGlobal: false, fs: { hasSecret: false, connected: false, clientId: "", secretLength: 0 } };
const savedEmail = (r) =>
  localStorage.getItem("email_" + r) || state[r === "cn" ? "emailCN" : "emailGlobal"] || "";

function isLoggedIn() { return region === "cn" ? state.hasCN : state.hasGlobal; }

function applyLoginUI(note) {
  const loggedIn = isLoggedIn();
  const emailEl = $("email");
  const pwEl = $("password");
  const btn = $("loginBtn");

  emailEl.disabled = loggedIn;
  pwEl.disabled = loggedIn;
  emailEl.value = savedEmail(region);
  pwEl.value = "";
  pwEl.placeholder = loggedIn ? "••••••••" : "只在本地使用，不保存";

  btn.textContent = loggedIn ? "退出登录" : "登录";
  btn.className = "btn " + (loggedIn ? "ghost" : "primary");
  chip($("cnChip"), loggedIn ? "已登录" : "未登录", loggedIn ? "ok" : "");

  const hint = $("loginHint");
  hint.className = "hint" + (loggedIn ? " ok" : "");
  hint.textContent = loggedIn
    ? (note || "登录成功，可以开始下载了。")
    : (note || "密码直接交给颂拓服务器，程序不留存。");
}

async function init() {
  const st = await call("status");
  state.hasCN = !!st.hasCN;
  state.hasGlobal = !!st.hasGlobal;
  state.emailCN = st.emailCN || "";
  state.emailGlobal = st.emailGlobal || "";
  state.fs = st.fs || { hasSecret: false, connected: false, clientId: "", secretLength: 0 };
  exportFolder = localStorage.getItem("exportFolder") || st.defaultFolder || "";
  showFolder($("exportFolder"), exportFolder);
  initScope();
  applyLoginUI();
  applyFsUI();
  renderUploadStats();
  refreshUploadStats();
  refreshDest(true);
  sizeGlow();
  if (state.fs.connected) verifyToken();
}

// ---------- 导出范围 ----------
function initScope() {
  exportScope = localStorage.getItem("exportScope") || "all";
  document.querySelectorAll("#scopeSeg .seg-item").forEach((x) => {
    x.classList.toggle("active", x.dataset.scope === exportScope);
  });
  $("rangeRow").classList.toggle("hidden", exportScope !== "range");
  ["dateFrom", "dateTo"].forEach((id) => {
    setFieldValue($(id), localStorage.getItem(id) || "");
  });
  resetQuery();
}

function resetQuery() {
  exportQueried = false;
  $("exportBtn").textContent = "查询记录";
  $("exportTally").textContent = "选好范围后先查一下有多少条";
  setProgress($("exportBar"), $("exportCount"), $("exportNote"), 0, 0, "");
}

document.querySelectorAll("#scopeSeg .seg-item").forEach((b) => {
  b.addEventListener("click", () => {
    exportScope = b.dataset.scope;
    localStorage.setItem("exportScope", exportScope);
    initScope();
  });
});

// ---------- 日历 ----------
const calEl = $("cal");
let calField = null;
let calCursor = null;

const isoOf = (d) =>
  `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;

function setFieldValue(el, iso) {
  el.dataset.value = iso || "";
  el.value = iso ? iso.replace(/-/g, "/") : "";
  localStorage.setItem(el.id, iso || "");
  resetQuery();
}

function openCal(el) {
  calField = el;
  const cur = el.dataset.value || isoOf(new Date());
  const d = new Date(cur + "T00:00:00");
  calCursor = new Date(d.getFullYear(), d.getMonth(), 1);
  renderCal();
  calEl.classList.remove("hidden");
  const r = el.getBoundingClientRect();
  const w = calEl.offsetWidth;
  const h = calEl.offsetHeight;
  let x = r.left;
  let y = r.bottom + 6;
  if (x + w > innerWidth - 12) x = innerWidth - w - 12;
  if (y + h > innerHeight - 12) y = Math.max(12, r.top - h - 6);
  calEl.style.left = Math.round(x) + "px";
  calEl.style.top = Math.round(y) + "px";
}

function closeCal() {
  calEl.classList.add("hidden");
  calField = null;
}

function renderCal() {
  const y = calCursor.getFullYear();
  const m = calCursor.getMonth();
  $("calTitle").textContent = `${y} 年 ${m + 1} 月`;
  const sel = calField.dataset.value || "";
  const today = isoOf(new Date());
  const startDow = (new Date(y, m, 1).getDay() + 6) % 7;
  const grid = $("calGrid");
  grid.textContent = "";
  for (let i = 0; i < 42; i++) {
    const d = new Date(y, m, i - startDow + 1);
    const iso = isoOf(d);
    const b = document.createElement("button");
    b.className = "cal-cell"
      + (d.getMonth() === m ? "" : " dim")
      + (iso === sel ? " sel" : "")
      + (iso === today ? " today" : "");
    b.textContent = d.getDate();
    b.dataset.iso = iso;
    grid.appendChild(b);
  }
}

$("calGrid").addEventListener("click", (e) => {
  const b = e.target.closest(".cal-cell");
  if (!b || !calField) return;
  setFieldValue(calField, b.dataset.iso);
  closeCal();
});

$("calPrevM").addEventListener("click", () => { calCursor.setMonth(calCursor.getMonth() - 1); renderCal(); });
$("calNextM").addEventListener("click", () => { calCursor.setMonth(calCursor.getMonth() + 1); renderCal(); });
$("calPrevY").addEventListener("click", () => { calCursor.setFullYear(calCursor.getFullYear() - 1); renderCal(); });
$("calNextY").addEventListener("click", () => { calCursor.setFullYear(calCursor.getFullYear() + 1); renderCal(); });

["dateFrom", "dateTo"].forEach((id) => {
  $(id).addEventListener("click", (e) => {
    e.stopPropagation();
    if (calField === $(id)) closeCal();
    else openCal($(id));
  });
});

document.addEventListener("click", (e) => {
  if (calEl.classList.contains("hidden")) return;
  if (!calEl.contains(e.target)) closeCal();
});

document.addEventListener("keydown", (e) => {
  if (e.key === "Escape") closeCal();
});

$("pickBtn").addEventListener("click", async () => {
  try {
    const r = await call("pickFolder");
    exportFolder = r.path;
    localStorage.setItem("exportFolder", exportFolder);
    showFolder($("exportFolder"), exportFolder);
  } catch (e) { /* 取消 */ }
});

$("loginBtn").addEventListener("click", async () => {
  const btn = $("loginBtn");

  if (isLoggedIn()) {
    btn.disabled = true;
    try {
      await call("logout", { region });
      if (region === "cn") state.hasCN = false; else state.hasGlobal = false;
      applyLoginUI("已退出登录，密码已从本机清除。");
      resetQuery();
    } catch (e) {
      applyLoginUI();
      chip($("cnChip"), e.message || "退出失败", "bad");
    } finally {
      btn.disabled = false;
    }
    return;
  }

  const email = $("email").value.trim();
  const password = $("password").value;
  if (!email || !password) {
    chip($("cnChip"), "请填邮箱和密码", "warn");
    return;
  }
  btn.disabled = true;
  chip($("cnChip"), "登录中…", "");
  try {
    await call("login", { region, email, password });
    localStorage.setItem("email_" + region, email);
    if (region === "cn") state.hasCN = true; else state.hasGlobal = true;
    applyLoginUI();
    resetQuery();
  } catch (e) {
    $("password").value = "";
    chip($("cnChip"), e.message || "登录失败", "bad");
    $("loginHint").className = "hint";
    $("loginHint").textContent = "检查一下邮箱和密码，再试一次。";
  } finally {
    btn.disabled = false;
  }
});

$("exportBtn").addEventListener("click", async () => {
  if (!isLoggedIn()) {
    chip($("exportChip"), "还没登录", "warn");
    logLine($("exportLog"), "请先在「颂拓账号」里登录，再开始下载。", "bad");
    $("email").focus();
    return;
  }
  if (!exportFolder) { chip($("exportChip"), "先选文件夹", "warn"); return; }

  let from = 0;
  let to = 0;
  if (exportScope === "range") {
    const f = $("dateFrom").dataset.value || "";
    const t2 = $("dateTo").dataset.value || "";
    if (!f || !t2) { chip($("exportChip"), "把起止日期都选上", "warn"); return; }
    from = new Date(f + "T00:00:00").getTime();
    to = new Date(t2 + "T23:59:59").getTime();
    if (from > to) { chip($("exportChip"), "起始日期要早于结束日期", "warn"); return; }
  }

  if (!exportQueried) {
    const btn = $("exportBtn");
    btn.disabled = true;
    btn.textContent = "查询中…";
    chip($("exportChip"), "查询中…", "warn");
    try {
      const r = await call("count", { region, from, to });
      $("exportLog").textContent = "";
      if (!r.total) {
        exportQueried = false;
        btn.textContent = "查询记录";
        chip($("exportChip"), "查询范围内没有记录", "warn");
        $("exportTally").textContent = "这段时间里没有记录，换个日期再试";
        setProgress($("exportBar"), $("exportCount"), $("exportNote"), 0, 0, "");
        return;
      }
      exportQueried = true;
      btn.textContent = "开始下载";
      chip($("exportChip"), `找到 ${r.total} 条`, "ok");
      $("exportTally").textContent = `符合条件的记录 ${r.total} 条`;
      logLine($("exportLog"), `符合条件的记录 ${r.total} 条，点「开始下载」开始`);
      setProgress($("exportBar"), $("exportCount"), $("exportNote"), 0, r.total, "");
    } catch (e) {
      chip($("exportChip"), e.message || "查询失败", "bad");
      btn.textContent = "查询记录";
    } finally {
      btn.disabled = false;
    }
    return;
  }

  busyExport = true;
  $("exportBtn").disabled = true;
  $("stopExportBtn").classList.remove("hidden");
  $("exportLog").textContent = "";
  logLine($("exportLog"), exportScope === "range"
    ? `范围：${$("dateFrom").value} 至 ${$("dateTo").value}`
    : "范围：全部记录");
  chip($("exportChip"), "运行中…", "warn");
  const bar = $("exportBar");
  const countEl = $("exportCount");
  const noteEl = $("exportNote");
  const tallyEl = $("exportTally");
  const t = { ok: 0, skip: 0, fail: 0 };
  const showTally = () => {
    tallyEl.textContent = `新下载 ${t.ok} · 已存在 ${t.skip} · 失败 ${t.fail}`;
  };
  showTally();

  onEvent.export = (e) => {
    if (e.type === "stage") {
      noteEl.textContent = e.text || "";
      logLine($("exportLog"), "· " + e.text);
    } else if (e.type === "item") {
      if (typeof e.ok === "number") t.ok = e.ok;
      if (typeof e.skip === "number") t.skip = e.skip;
      if (typeof e.fail === "number") t.fail = e.fail;
      showTally();
      setProgress(bar, countEl, noteEl, e.index, e.total, e.note || "");
      logLine($("exportLog"),
        `${e.index}/${e.total} ${e.name}${e.note ? " · " + e.note : ""}`,
        e.note && e.note.startsWith("失败") ? "bad" : "");
    }
  };

  try {
    const r = await call("export", { region, folder: exportFolder, from, to });
    t.ok = r.downloaded;
    t.skip = r.skipped;
    t.fail = r.failed;
    showTally();
    setProgress(bar, countEl, noteEl, r.total, r.total, r.stopped ? "已停止" : "完成");
    chip($("exportChip"), r.stopped ? "已停止" : "完成", r.failed ? "warn" : "ok");
    logLine($("exportLog"),
      `完成：新下载 ${r.downloaded}，已存在 ${r.skipped}，失败 ${r.failed}`,
      r.failed ? "bad" : "ok");
    if (r.failures && r.failures.length) logLine($("exportLog"), "失败示例：" + r.failures.join("、"), "bad");
    if (r.csv) logLine($("exportLog"), "清单：" + r.csv);
  } catch (e) {
    chip($("exportChip"), e.message || "失败", "bad");
    logLine($("exportLog"), e.message || "失败", "bad");
  } finally {
    busyExport = false;
    $("exportBtn").disabled = false;
    $("stopExportBtn").classList.add("hidden");
    onEvent.export = null;
  }
});

$("stopExportBtn").addEventListener("click", () => { call("cancel").catch(() => {}); });

// ---------- 模块二 ----------
let uploadFolder = localStorage.getItem("uploadFolder") || "";
let busyUpload = false;

function applyFsUI() {
  const connected = !!state.fs.connected;
  const chipEl = $("fsChip");
  $("signOutBtn").classList.toggle("hidden", !connected);
  $("uploadCard").classList.toggle("hidden", !connected);
  const authBtn = $("authBtn");

  if (connected) {
    chip(chipEl, "已连接", "ok");
    authBtn.textContent = "重新授权";
    authBtn.className = "btn ghost";
    authBtn.disabled = false;
    $("fsHint").className = "hint ok";
    $("fsHint").textContent = "授权有效，选好文件夹就能把 .fit 批量送进去。";
  } else {
    chip(chipEl, "未连接", "");
    authBtn.textContent = "登录并授权";
    authBtn.className = "btn primary";
    authBtn.disabled = false;
    $("fsHint").className = "hint";
    $("fsHint").textContent = "点「登录并授权」，在弹窗里登录你自己的 FitnessSyncer 账号并同意即可，不用填任何东西。";
  }
  if (!uploadFolder) {
    $("uploadFolder").textContent = prettyPath(exportFolder) || "—";
  } else {
    showFolder($("uploadFolder"), uploadFolder);
  }
}

async function verifyToken() {
  try {
    await call("fsConnect");
    refreshUploadStats();
    refreshDest();
    return true;
  } catch (e) {
    chip($("fsChip"), "令牌失效", "bad");
    $("fsHint").className = "hint";
    $("fsHint").textContent = "连不上 FitnessSyncer，点「登录并授权」再来一次。";
    return false;
  }
}

// —— 条数 ——
const upStats = { total: 0, done: 0, pending: null };

function renderUploadStats() {
  const el = $("uploadStats");
  if (upStats.pending === null) {
    el.textContent = "选好文件夹后显示本机记录数";
    return;
  }
  el.textContent = `本机 ${upStats.total} 条记录 · 待上传 ${upStats.pending} 条` +
                   (upStats.done ? `，已传 ${upStats.done}` : "");
}

async function refreshUploadStats() {
  const folder = uploadFolder || exportFolder || "";
  if (!folder) {
    upStats.total = 0; upStats.done = 0; upStats.pending = null;
    renderUploadStats();
    return;
  }
  try {
    const r = await call("folderStats", { folder });
    upStats.total = r.total;
    upStats.done = r.done;
    upStats.pending = r.pending;
  } catch (e) {
    upStats.total = 0; upStats.done = 0; upStats.pending = null;
  }
  renderUploadStats();
}


$("authBtn").addEventListener("click", async () => {
  const btn = $("authBtn");
  btn.disabled = true;
  chip($("fsChip"), "授权中…", "warn");
  $("fsHint").className = "hint";
  $("fsHint").textContent = "在弹出窗口里登录 FitnessSyncer 并点同意，窗口会自己关。";
  try {
    await call("fsStartAuth");
    chip($("fsChip"), "已授权", "ok");
    state.fs.connected = true;
    applyFsUI();
    await verifyToken();
  } catch (e) {
    chip($("fsChip"), e.message || "没授权成", "bad");
    $("fsHint").className = "hint";
    $("fsHint").textContent = e.message || "没授权成，再点一次试试。";
  } finally {
    btn.disabled = false;
  }
});

$("signOutBtn").addEventListener("click", async () => {
  $("signOutBtn").disabled = true;
  try {
    await call("fsSignOut");
    state.fs.connected = false;
    applyFsUI();
    refreshUploadStats();
  } catch (e) {
    chip($("fsChip"), e.message || "断开失败", "bad");
  } finally {
    $("signOutBtn").disabled = false;
  }
});

$("pickUploadBtn").addEventListener("click", async () => {
  try {
    const r = await call("pickFolder");
    uploadFolder = r.path;
    localStorage.setItem("uploadFolder", uploadFolder);
    showFolder($("uploadFolder"), uploadFolder);
    refreshUploadStats();
  } catch (e) { /* 取消 */ }
});

$("uploadBtn").addEventListener("click", async () => {
  const folder = uploadFolder || exportFolder;
  if (!folder) { chip($("uploadChip"), "先选文件夹", "warn"); return; }

  busyUpload = true;
  $("uploadBtn").disabled = true;
  $("stopUploadBtn").classList.remove("hidden");
  $("uploadLog").textContent = "";
  chip($("uploadChip"), "上传中…", "warn");
  setProgress($("uploadBar"), $("uploadCount"), $("uploadNote"), 0, upStats.total, "");
  const t = { ok: 0, skip: 0, fail: 0 };
  const tallyEl = $("uploadTally");
  const showTally = () => {
    tallyEl.textContent = `新上传 ${t.ok} · 已存在 ${t.skip} · 失败 ${t.fail}`;
  };
  showTally();

  onEvent.upload = (e) => {
    if (e.type === "stage") {
      $("uploadNote").textContent = e.text || "";
      logLine($("uploadLog"), "· " + e.text);
    } else if (e.type === "item") {
      if (typeof e.ok === "number") t.ok = e.ok;
      if (typeof e.skip === "number") t.skip = e.skip;
      if (typeof e.fail === "number") t.fail = e.fail;
      showTally();
      setProgress($("uploadBar"), $("uploadCount"), $("uploadNote"), e.index, e.total, e.note || "");
      logLine($("uploadLog"),
        `${e.index}/${e.total} ${e.name}${e.note ? " · " + e.note : ""}`,
        e.note && e.note.startsWith("HTTP") ? "bad" : "");
    }
  };

  try {
    const r = await call("fsUpload", { folder });
    t.ok = r.uploaded;
    t.skip = r.skipped;
    t.fail = r.failed;
    showTally();
    setProgress($("uploadBar"), $("uploadCount"), $("uploadNote"), r.total, r.total, r.stopped ? "已停止" : "完成");
    chip($("uploadChip"), r.stopped ? "已停止" : "完成", r.failed ? "warn" : "ok");
    if (r.source) logLine($("uploadLog"), "写进：" + r.source);
    logLine($("uploadLog"),
      `完成：新上传 ${r.uploaded}，已存在 ${r.skipped}，失败 ${r.failed}`,
      r.failed ? "bad" : "ok");
  } catch (e) {
    chip($("uploadChip"), e.message || "失败", "bad");
    logLine($("uploadLog"), e.message || "失败", "bad");
  } finally {
    busyUpload = false;
    $("uploadBtn").disabled = false;
    $("stopUploadBtn").classList.add("hidden");
    onEvent.upload = null;
    refreshUploadStats();
  }
});

$("stopUploadBtn").addEventListener("click", () => { call("cancel").catch(() => {}); });

// ---------- 模块三 ----------
let destState = null;
let destPollGen = 0;
let destRanThisSession = false;
let destRunning = false;
let destBusy = false;

const pad2 = (n) => String(n).padStart(2, "0");
function fmtDate(ms) {
  if (!ms) return "";
  const d = new Date(ms);
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())} ${pad2(d.getHours())}:${pad2(d.getMinutes())}`;
}

function setDestButtonStyle(authed) {
  $("destAuthBtn").className = authed ? "btn ghost" : "btn primary";
  $("destBtn").className = authed ? "btn primary big" : "btn ghost big";
}

function renderDest() {
  const s = destState;
  if (!s) return;
  const chipEl = $("destChip");
  const stateEl = $("destState");
  const btn = $("destBtn");
  const authBtn = $("destAuthBtn");
  const fsOn = !!(state.fs && state.fs.connected);

  if (!fsOn || s.needFs) {
    chip(chipEl, "未连接", "");
    stateEl.textContent = "第一步：先到「上传到 FitnessSyncer」里登录授权，再回来。";
    setDestButtonStyle(false);
    btn.style.display = "none";
    btn.dataset.action = "gotoFs";
    authBtn.disabled = false;
    authBtn.textContent = "登录颂拓国际";
    setDestBar("", null);
    return;
  }
  btn.style.display = "";
  if (!s.ok) {
    chip(chipEl, "连不上", "bad");
    stateEl.textContent = s.message || "读不到接收方状态";
    setDestButtonStyle(false);
    btn.disabled = false;
    btn.textContent = "重新检查";
    btn.dataset.action = "refresh";
    authBtn.disabled = false;
    authBtn.textContent = "登录颂拓国际";
    setDestBar("", null);
    return;
  }

  const authed = !!s.authed;
  setDestButtonStyle(authed);
  authBtn.disabled = false;
  authBtn.textContent = authed ? "重新登录颂拓国际" : "登录颂拓国际";

  if (!s.found) {
    chip(chipEl, "未连接", "");
    stateEl.textContent = "第二步：点「登录颂拓国际」，会建好接收方并带你去登颂拓。";
    btn.disabled = true;
    btn.textContent = "先登录颂拓国际";
    btn.dataset.action = "sync";
    setDestBar("", null);
    return;
  }
  if (!authed) {
    chip(chipEl, "待登录", "warn");
    stateEl.textContent = `接收方「${s.name}」已建好，还差第二步：点「登录颂拓国际」把账号连上。`;
    btn.disabled = true;
    btn.textContent = "先登录颂拓国际";
    btn.dataset.action = "sync";
    setDestBar("", null);
    return;
  }

  const parts = [`接收方「${s.name}」已连上颂拓国际`];
  if (s.lastDate) parts.push(`上次同步 ${fmtDate(s.lastDate)}`);
  if (s.lastError) parts.push(`上次报错：${s.lastError}`);
  stateEl.textContent = parts.join(" · ");

  const q = (s.syncQueue || "").toUpperCase();
  if (destRunning || q === "RUNNING" || q === "PENDING" || q === "QUEUED") {
    chip(chipEl, "同步中…", "ok");
    btn.disabled = true;
    btn.textContent = "同步中…";
    setDestBar(destRunning ? "RUNNING" : (q || "RUNNING"), s);
  } else if (q === "COMPLETED") {
    chip(chipEl, s.syncOk ? (destRanThisSession ? "同步完成" : "上次成功") : "上次失败",
         s.syncOk ? "ok" : "bad");
    btn.disabled = false;
    btn.textContent = "上传颂拓国际";
  } else {
    chip(chipEl, "已连接", "ok");
    btn.disabled = false;
    btn.textContent = "上传颂拓国际";
  }
  btn.dataset.action = "sync";
  if (!destRunning) setDestBar(q, s);
}

function setDestBar(q, s) {
  const bar = $("destBar");
  const label = $("destCount");
  const note = $("destNote");
  if (!bar) return;
  if (["RUNNING", "PENDING", "QUEUED", "STARTED", "PROCESSING"].includes(q)) {
    bar.classList.add("indeterminate");
    bar.style.width = "";
    label.textContent = q === "RUNNING" ? "同步中" : "排队中";
    note.textContent = "FitnessSyncer 服务器在跑，给它一点时间";
    return;
  }
  bar.classList.remove("indeterminate");
  const good = !s || s.syncOk !== false;
  if (q === "COMPLETED" && good) {
    bar.style.width = "100%";
    label.textContent = destRanThisSession ? "已完成" : "上次已完成";
    note.textContent = "";
  } else if (q === "COMPLETED") {
    bar.style.width = "0%";
    label.textContent = "上次没成功";
    note.textContent = (s && s.lastError) || "";
  } else {
    bar.style.width = "0%";
    label.textContent = "未开始";
    note.textContent = "";
  }
}

async function refreshDest(startPollIfActive = false) {
  try {
    destState = await call("destStatus");
  } catch (e) {
    destState = { ok: false, message: e.message || "读不到接收方状态" };
  }
  renderDest();
  if (startPollIfActive) {
    const q = ((destState && destState.syncQueue) || "").toUpperCase();
    if (["RUNNING", "PENDING", "QUEUED"].includes(q)) {
      destRunning = true;
      startDestPoll();
    }
  }
}

function startDestPoll() {
  destPollGen++;
  const gen = destPollGen;
  const baseDate = (destState && destState.lastDate) || 0;
  let n = 0;
  let lastLine = "";
  let sawActive = false;

  const tick = async () => {
    if (gen !== destPollGen) return;
    n++;
    await refreshDest();
    if (gen !== destPollGen) return;
    const s = destState || {};
    const q = (s.syncQueue || "").toUpperCase();
    const line = [s.syncQueue, s.syncStatus, s.syncUpdate].filter(Boolean).join(" · ");
    const failed = q === "FAILED" || q === "ERROR";
    if (line && line !== lastLine) {
      lastLine = line;
      logLine($("destLog"), "状态：" + line, failed || (q === "COMPLETED" && !s.syncOk) ? "bad" : "ok");
    }
    if (["RUNNING", "PENDING", "QUEUED", "STARTED", "PROCESSING"].includes(q)) sawActive = true;
    const finished = /COMPLETE/i.test(q + " " + (s.syncStatus || ""))
      && ((s.lastDate || 0) > baseDate || sawActive);
    if (finished || failed || n >= 30) {
      destPollGen++;
      destRunning = false;
      renderDest();
      if (finished) logLine($("destLog"), s.syncOk ? "同步完成" : "这次同步没成功", s.syncOk ? "ok" : "bad");
      else if (failed) logLine($("destLog"), "这次同步没成功", "bad");
      else logLine($("destLog"), "还没看到完成结果，过一会儿点「刷新状态」再看", "warn");
      return;
    }
    setTimeout(tick, 6000);
  };
  setTimeout(tick, 2000);
}

$("destBtn").addEventListener("click", async () => {
  if (destBusy) return;
  const btn = $("destBtn");
  const action = btn.dataset.action || "sync";
  const log = $("destLog");

  if (action === "gotoFs") {
    const tabBtn = document.querySelector('.tab[data-pane="two"]');
    if (tabBtn) tabBtn.click();
    chip($("fsChip"), "先完成这一步", "warn");
    return;
  }
  if (action === "refresh") {
    await refreshDest();
    return;
  }

  destBusy = true;
  destRunning = true;
  btn.disabled = true;
  chip($("destChip"), "提交中…", "warn");
  setDestBar("QUEUED", null);
  try {
    const r = await call("destSync");
    destRanThisSession = true;
    logLine(log, r.message || "已提交", "ok");
    await refreshDest();
    startDestPoll();
  } catch (e) {
    destRunning = false;
    chip($("destChip"), e.message || "提交失败", "bad");
    logLine(log, e.message || "提交失败", "bad");
  } finally {
    destBusy = false;
    renderDest();
  }
});

$("destAuthBtn").addEventListener("click", async () => {
  if (destBusy) return;
  if (!(state.fs && state.fs.connected)) {
    const tabBtn = document.querySelector('.tab[data-pane="two"]');
    if (tabBtn) tabBtn.click();
    chip($("fsChip"), "先完成这一步", "warn");
    return;
  }
  const authBtn = $("destAuthBtn");
  const log = $("destLog");
  destBusy = true;
  authBtn.disabled = true;
  $("destBtn").disabled = true;
  chip($("destChip"), "打开授权…", "warn");
  logLine(log, "在弹出的窗口里用颂拓国际账号登录并同意；还没有账号就在窗口里注册一个。窗口会自己关。");
  try {
    const r = await call("destPrepare", { force: true });
    logLine(log, r.message || "颂拓国际已连上", "ok");
    await refreshDest();
  } catch (e) {
    chip($("destChip"), e.message || "没登录成", e.needFs ? "warn" : "bad");
    logLine(log, e.message || "没登录成", e.needFs ? "warn" : "bad");
  } finally {
    destBusy = false;
    renderDest();
  }
});

init().then(() => { call("pageReady"); setTimeout(reportHeight, 200); }).catch(() => {});
