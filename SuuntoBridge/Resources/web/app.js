const PENDING = new Map();
let seq = 1;

const HAS_BRIDGE = !!(window.webkit && window.webkit.messageHandlers && window.webkit.messageHandlers.bridge);

// 浏览器里直接打开时用假数据预览样子
const MOCK = {
  status: { hasCN: true, hasGlobal: false, emailCN: "you@example.com", defaultFolder: "/Users/you/Downloads/颂拓导出" },
  count: { total: 256 },
  logout: { ok: true },
  openExportFolder: { ok: true },
  export: async (emit) => {
    const total = 256;
    for (let i = 1; i <= total; i += 16) {
      emit({ type: "item", index: i, total, name: `20241130-0951_a22_sampleactivity01.fit`, note: "" });
      await new Promise((r) => setTimeout(r, 12));
    }
    return { total, downloaded: 256, skipped: 0, failed: 0, failures: [], csv: "/Users/you/Downloads/颂拓导出/导出清单.csv" };
  },
  suuntoImportStart: async (emit) => {
    for (let i = 1; i <= 5; i++) {
      emit({ type: "progress", percent: i * 20 });
      await new Promise((r) => setTimeout(r, 80));
    }
    return { success: 256, failed: 0 };
  },
  corosLogin: { ok: true, email: "you@example.com" },
  corosImportStart: async (emit) => {
    const total = 256;
    for (let i = 8; i <= total; i += 8) {
      emit({ type: "item", index: i, total, name: "20241130-0951_a22_sampleactivity01.fit", note: "", ok: i, skip: 0, fail: 0 });
      await new Promise((r) => setTimeout(r, 10));
    }
    return { ok: true, total, success: 256, duplicate: 0, failed: 0, failures: [] };
  },
  garminImportStart: async (emit) => {
    const total = 256;
    for (let i = 4; i <= total; i += 4) {
      emit({ type: "item", index: i, total, name: "20241130-0951_a22_sampleactivity01.fit", note: "", ok: i, skip: 0, fail: 0 });
      await new Promise((r) => setTimeout(r, 10));
    }
    return { ok: true, total, success: 256, duplicate: 0, failed: 0, failures: [] };
  },
};

function call(cmd, payload = {}) {
  return new Promise((resolve, reject) => {
    if (!HAS_BRIDGE) {
      if (cmd === "export" || cmd === "suuntoImportStart" || cmd === "corosImportStart" || cmd === "garminImportStart") {
        const f = onEvent[cmd === "export" ? "export" : "import"];
        MOCK[cmd]((e) => { if (f) f(e); }).then(resolve, reject);
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

const onEvent = { export: null, import: null };
window.__event = (e) => {
  if (onEvent.export) onEvent.export(e);
  if (onEvent.import) onEvent.import(e);
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

const state = { hasCN: false, hasGlobal: false, hasCoros: false };
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
  state.hasCoros = !!st.hasCoros;
  state.emailCN = st.emailCN || "";
  state.emailGlobal = st.emailGlobal || "";
  if (st.hasCoros) {
    $("corosEmail").value = st.emailCoros || "";
    chip($("corosChip"), "已登录", "ok");
  }
  exportFolder = localStorage.getItem("exportFolder") || st.defaultFolder || "";
  showFolder($("exportFolder"), exportFolder);
  showFolder($("importFolder"), exportFolder);
  showFolder($("corosFolder"), exportFolder);
  showFolder($("garminFolder"), exportFolder);
  initScope();
  applyLoginUI();
  sizeGlow();
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
    showFolder($("importFolder"), exportFolder);
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

// ---------- 模块二·高驰 ----------

$("corosLoginBtn").addEventListener("click", async () => {
  const email = $("corosEmail").value.trim();
  const password = $("corosPassword").value;
  const chipEl = $("corosChip");
  if (!email || !password) { chip(chipEl, "先填邮箱和密码", "warn"); return; }
  const btn = $("corosLoginBtn");
  btn.disabled = true;
  chip(chipEl, "登录中…", "warn");
  try {
    const r = await call("corosLogin", { email, password });
    $("corosPassword").value = "";
    $("corosEmail").value = r.email || email;
    state.hasCoros = true;
    chip(chipEl, "已登录", "ok");
  } catch (e) {
    chip(chipEl, "登录失败", "bad");
    logLine($("corosLog"), e.message || "高驰登录失败", "bad");
  } finally {
    btn.disabled = false;
  }
});

$("corosOpenFinderBtn").addEventListener("click", async () => {
  if (!exportFolder) { chip($("corosImportChip"), "先在「下载记录」里选文件夹", "warn"); return; }
  try {
    await call("openExportFolder", { folder: exportFolder });
  } catch (e) {
    chip($("corosImportChip"), e.message || "打不开文件夹", "bad");
  }
});

$("corosStartBtn").addEventListener("click", async () => {
  const chipEl = $("corosImportChip");
  if (!exportFolder) { chip(chipEl, "先在「下载记录」里选文件夹", "warn"); return; }
  if (!state.hasCoros) { chip(chipEl, "先在上面登录高驰", "warn"); return; }

  const btn = $("corosStartBtn");
  const bar = $("corosBar");
  const countEl = $("corosCount");
  const noteEl = $("corosNote");
  const tallyEl = $("corosTally");
  btn.disabled = true;
  chip(chipEl, "准备中…", "warn");
  $("corosLog").textContent = "";
  bar.style.width = "0%";
  countEl.textContent = "0 / 0";
  noteEl.textContent = "";
  tallyEl.textContent = "正在向高驰要上传凭证…";

  const t = { ok: 0, dup: 0, fail: 0 };
  const showTally = () => {
    tallyEl.textContent = `成功 ${t.ok} 条 · 已存在 ${t.dup} 条 · 失败 ${t.fail} 条`;
  };

  onEvent.import = (e) => {
    if (e.type === "stage") {
      noteEl.textContent = e.text || "";
      logLine($("corosLog"), "· " + e.text);
      if (/^正在导入/.test(e.text)) tallyEl.textContent = e.text;
    } else if (e.type === "item") {
      if (typeof e.ok === "number") t.ok = e.ok;
      if (typeof e.skip === "number") t.dup = e.skip;
      if (typeof e.fail === "number") t.fail = e.fail;
      showTally();
      setProgress(bar, countEl, noteEl, e.index, e.total, e.name || "");
      logLine($("corosLog"), `${e.index}/${e.total} ${e.name}${e.note ? " · " + e.note : ""}`,
        e.note && e.note.startsWith("失败") ? "bad" : (e.note === "已存在" ? "warn" : ""));
    } else if (e.type === "progress") {
      const p = Math.max(0, Math.min(100, e.percent || 0));
      bar.style.width = p + "%";
      countEl.textContent = p + "%";
    }
  };

  try {
    const r = await call("corosImportStart", { folder: exportFolder });
    bar.style.width = "100%";
    countEl.textContent = "完成";
    noteEl.textContent = "";
    const bad = r.failed || 0;
    chip(chipEl, bad ? "部分失败" : "导入完成", bad ? "warn" : "ok");
    tallyEl.textContent = `成功 ${r.success} 条 · 已存在 ${r.duplicate || 0} 条 · 失败 ${bad} 条`;
    logLine($("corosLog"), `高驰回执：成功 ${r.success} 条，已存在 ${r.duplicate || 0} 条，失败 ${bad} 条`, bad ? "warn" : "ok");
    if (r.failures && r.failures.length) logLine($("corosLog"), "失败示例：" + r.failures.join("；"), "bad");
  } catch (e) {
    chip(chipEl, e.message || "导入失败", "bad");
    logLine($("corosLog"), e.message || "导入失败", "bad");
    noteEl.textContent = "";
  } finally {
    onEvent.import = null;
    btn.disabled = false;
  }
});

// ---------- 模块二·佳明 ----------

$("garminOpenFinderBtn").addEventListener("click", async () => {
  if (!exportFolder) { chip($("garminImportChip"), "先在「下载记录」里选文件夹", "warn"); return; }
  try {
    await call("openExportFolder", { folder: exportFolder });
  } catch (e) {
    chip($("garminImportChip"), e.message || "打不开文件夹", "bad");
  }
});

$("garminStopBtn").addEventListener("click", () => { call("garminImportStop").catch(() => {}); });

$("garminStartBtn").addEventListener("click", async () => {
  const chipEl = $("garminImportChip");
  if (!exportFolder) { chip(chipEl, "先在「下载记录」里选文件夹", "warn"); return; }

  const btn = $("garminStartBtn");
  const stopBtn = $("garminStopBtn");
  const bar = $("garminBar");
  const countEl = $("garminCount");
  const noteEl = $("garminNote");
  const tallyEl = $("garminTally");
  btn.disabled = true;
  stopBtn.classList.remove("hidden");
  chip(chipEl, "准备中…", "warn");
  $("garminLog").textContent = "";
  bar.style.width = "0%";
  countEl.textContent = "0 / 0";
  noteEl.textContent = "";
  tallyEl.textContent = "正在打开佳明的登录窗口…";

  const t = { ok: 0, dup: 0, fail: 0 };
  const showTally = () => {
    tallyEl.textContent = `成功 ${t.ok} 条 · 已存在 ${t.dup} 条 · 失败 ${t.fail} 条`;
  };

  onEvent.import = (e) => {
    if (e.type === "stage") {
      noteEl.textContent = e.text || "";
      logLine($("garminLog"), "· " + e.text);
      if (/^已登录/.test(e.text)) tallyEl.textContent = e.text;
    } else if (e.type === "item") {
      if (typeof e.ok === "number") t.ok = e.ok;
      if (typeof e.skip === "number") t.dup = e.skip;
      if (typeof e.fail === "number") t.fail = e.fail;
      showTally();
      setProgress(bar, countEl, noteEl, e.index, e.total, e.name || "");
      logLine($("garminLog"), `${e.index}/${e.total} ${e.name}${e.note ? " · " + e.note : ""}`,
        e.note && e.note.startsWith("失败") ? "bad" : (e.note === "已存在" ? "warn" : ""));
    }
  };

  try {
    const r = await call("garminImportStart", { folder: exportFolder });
    bar.style.width = "100%";
    countEl.textContent = r.stopped ? "已停止" : "完成";
    noteEl.textContent = "";
    const bad = r.failed || 0;
    chip(chipEl, r.stopped ? "已停止" : (bad ? "部分失败" : "导入完成"), r.stopped ? "warn" : (bad ? "warn" : "ok"));
    tallyEl.textContent = `成功 ${r.success} 条 · 已存在 ${r.duplicate || 0} 条 · 失败 ${bad} 条`;
    logLine($("garminLog"), `佳明回执：成功 ${r.success} 条，已存在 ${r.duplicate || 0} 条，失败 ${bad} 条`, bad ? "warn" : "ok");
    if (r.failures && r.failures.length) logLine($("garminLog"), "失败示例：" + r.failures.join("；"), "bad");
    if (r.stopped) logLine($("garminLog"), "已停止，下次接着传，传过的会显示「已存在」不会重复", "warn");
  } catch (e) {
    chip(chipEl, e.message || "导入失败", "bad");
    logLine($("garminLog"), e.message || "导入失败", "bad");
    noteEl.textContent = "";
  } finally {
    onEvent.import = null;
    btn.disabled = false;
    stopBtn.classList.add("hidden");
  }
});

// ---------- 模块二：颂拓国际 ----------

$("startImportBtn").addEventListener("click", async () => {
  const chipEl = $("importChip");
  if (!exportFolder) { chip(chipEl, "先在「下载记录」里选文件夹", "warn"); return; }

  const btn = $("startImportBtn");
  const bar = $("importBar");
  const countEl = $("importCount");
  const noteEl = $("importNote");
  const tallyEl = $("importTally");
  btn.disabled = true;
  chip(chipEl, "准备中…", "warn");
  $("importLog").textContent = "";
  tallyEl.textContent = "正在打开颂拓的窗口…";
  bar.style.width = "0%";
  countEl.textContent = "0 / 0";
  noteEl.textContent = "";

  onEvent.import = (e) => {
    if (e.type === "stage") {
      noteEl.textContent = e.text || "";
      tallyEl.textContent = e.text || "";
      logLine($("importLog"), "· " + e.text);
    } else if (e.type === "progress") {
      const p = Math.max(0, Math.min(100, e.percent || 0));
      bar.style.width = p + "%";
      countEl.textContent = p + "%";
      noteEl.textContent = "上传中…";
      tallyEl.textContent = `上传中 ${p}%`;
    }
  };

  try {
    const r = await call("suuntoImportStart", { folder: exportFolder });
    bar.style.width = "100%";
    countEl.textContent = "完成";
    noteEl.textContent = "";
    chip(chipEl, r.failed ? "部分失败" : "导入完成", r.failed ? "warn" : "ok");
    tallyEl.textContent = `成功 ${r.success} 条 · 失败 ${r.failed} 条`;
    logLine($("importLog"), `颂拓回执：成功 ${r.success} 条，失败 ${r.failed} 条`, r.failed ? "warn" : "ok");
    if (r.failed) logLine($("importLog"), "有失败的话，到颂拓里核对一下条数；再导一次会把已经成功的也重复导入", "warn");
  } catch (e) {
    chip(chipEl, e.message || "导入失败", "bad");
    logLine($("importLog"), e.message || "导入失败", "bad");
    noteEl.textContent = "";
  } finally {
    onEvent.import = null;
    btn.disabled = false;
  }
});

$("openFinderBtn").addEventListener("click", async () => {
  if (!exportFolder) { chip($("importChip"), "先在「下载记录」里选文件夹", "warn"); return; }
  try {
    await call("openExportFolder", { folder: exportFolder });
  } catch (e) {
    chip($("importChip"), e.message || "打不开文件夹", "bad");
  }
});

init().then(() => { call("pageReady"); setTimeout(reportHeight, 200); }).catch(() => {});
