const { app, BrowserWindow, ipcMain, dialog, screen, shell, Menu } = require("electron");
const path = require("path");
const fs = require("fs");
const crypto = require("crypto");
const { Backend } = require("./backend");
const { zipFolder, uploadZip } = require("./importfit");

if (process.env.SUUNTO_BRIDGE_DATA) {
  app.setPath("userData", process.env.SUUNTO_BRIDGE_DATA);
}

const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
}

const supportDir = app.getPath("userData");
try {
  fs.mkdirSync(supportDir, { recursive: true });
} catch {}

function toolPath() {
  const exe = process.platform === "win32" ? "suuntool.exe" : "suuntool";
  return app.isPackaged
    ? path.join(process.resourcesPath, "bin", exe)
    : path.join(__dirname, "bin", exe);
}

const backend = new Backend({
  toolPath: toolPath(),
  supportDir,
  downloadsDir: app.getPath("downloads"),
});

let win = null;
let authWin = null;
let importWin = null;

function windowIcon() {
  return app.isPackaged
    ? path.join(process.resourcesPath, "icon.ico")
    : path.join(__dirname, "icon.ico");
}

function status() {
  return {
    hasCN: backend.hasSession("cn"),
    hasGlobal: backend.hasSession("global"),
    busy: backend.isBusy(),
    emailCN: backend.email("cn"),
    emailGlobal: backend.email("global"),
    fs: backend.fsAuthState(),
    platform: process.platform,
    defaultFolder: path.join(app.getPath("downloads"), "颂拓导出"),
  };
}

function createWindow() {
  const wa = screen.getPrimaryDisplay().workAreaSize;
  const height = Math.min(1010, wa.height - 24);
  win = new BrowserWindow({
    width: 860,
    height,
    minWidth: 720,
    minHeight: 620,
    title: "颂拓记录搬家",
    icon: windowIcon(),
    autoHideMenuBar: true,
    backgroundColor: "#f5f6f8",
    webPreferences: {
      preload: path.join(__dirname, "preload.js"),
      contextIsolation: false,
      nodeIntegration: false,
      sandbox: false,
      spellcheck: false,
    },
  });
  win.setMenuBarVisibility(false);
  win.loadFile(path.join(__dirname, "renderer", "index.html"));

  win.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:/i.test(url)) shell.openExternal(url);
    return { action: "deny" };
  });

  win.on("closed", () => {
    win = null;
    if (authWin && !authWin.isDestroyed()) authWin.close();
    if (importWin && !importWin.isDestroyed()) importWin.close();
  });
}

function fitHeight(h) {
  if (!win || !win.isVisible()) return;
  const b = win.getBounds();
  const wa = screen.getDisplayMatching(b).workArea;
  let target = Math.round(h);
  if (target > wa.height - 24) target = wa.height - 24;
  if (target < 560) target = 560;
  if (Math.abs(b.height - target) < 8) return;
  const top = b.y;
  let y = top + b.height - target;
  if (y < wa.y) y = wa.y;
  if (y + target > wa.y + wa.height) y = wa.y + wa.height - target;
  win.setBounds({ x: b.x, y, width: b.width, height: target });
}

function openAuthWindow(url, destinationMode) {
  return new Promise((resolve) => {
    const w = new BrowserWindow({
      width: 760,
      height: 800,
      parent: win || undefined,
      title: destinationMode ? "登录颂拓国际" : "登录 FitnessSyncer",
      icon: windowIcon(),
      autoHideMenuBar: true,
      webPreferences: { contextIsolation: true, nodeIntegration: false, sandbox: true },
    });
    authWin = w;
    let finished = false;
    let warned = false;

    const finish = (res) => {
      if (finished) return;
      finished = true;
      authWin = null;
      try {
        if (!w.isDestroyed()) w.close();
      } catch {}
      resolve(res);
    };

    const inspect = (u) => {
      let url;
      try {
        url = new URL(u);
      } catch {
        return null;
      }
      if (url.hostname !== "personal.fitnesssyncer.com") return null;
      if (destinationMode) return { code: "done", state: "" };
      return {
        code: url.searchParams.get("code") || "error",
        state: url.searchParams.get("state") || "",
      };
    };

    const onNav = (e, u) => {
      const r = inspect(u);
      if (r) {
        e.preventDefault();
        finish(r);
      }
    };
    w.webContents.on("will-navigate", onNav);
    w.webContents.on("will-redirect", onNav);
    w.webContents.on("did-navigate", (_e, u) => {
      const r = inspect(u);
      if (r) finish(r);
    });

    w.webContents.on("did-finish-load", async () => {
      if (warned || finished) return;
      try {
        const text = await w.webContents.executeJavaScript(
          "(document.body||{}).innerText||''"
        );
        if (typeof text !== "string" || !text) return;
        const rejected = text.includes("请求无效") || text.includes("The request is invalid");
        const denied = text.includes("拒绝") && text.includes("授权");
        if (rejected || denied) {
          warned = true;
          try {
            w.setTitle("授权失败：FitnessSyncer 拒绝了请求");
          } catch {}
          dialog.showMessageBox(w, {
            type: "warning",
            title: "授权失败",
            message: "FitnessSyncer 拒绝了这个请求",
            detail: "关掉这个窗口，回到程序再点一次「登录并授权」。",
            buttons: ["知道了"],
          });
        }
      } catch {}
    });

    w.on("closed", () => {
      if (!finished) {
        finished = true;
        if (authWin === w) authWin = null;
        resolve({ code: "", state: "" });
      }
    });

    w.loadURL(url).catch(() => {});
  });
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function readToken(w) {
  if (!w || w.isDestroyed()) return "";
  try {
    const t = await w.webContents.executeJavaScript(
      "(sessionStorage.getItem('WEB_TOKEN')||'').trim()"
    );
    return typeof t === "string" ? t : "";
  } catch {
    return "";
  }
}

async function waitForToken(wins, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const alive = wins.filter((w) => w && !w.isDestroyed());
    if (!alive.length) return "";
    for (const w of alive) {
      const t = await readToken(w);
      if (t) return t;
    }
    await sleep(1000);
  }
  return "";
}

async function runImport(folder, sendEvent) {
  if (importWin && !importWin.isDestroyed()) {
    importWin.show();
    importWin.focus();
  } else {
    importWin = new BrowserWindow({
      width: 1000,
      height: 860,
      title: "颂拓国际 · 导入运动记录",
      icon: windowIcon(),
      autoHideMenuBar: true,
      webPreferences: { contextIsolation: true, nodeIntegration: false, sandbox: true },
    });
    importWin.setMenuBarVisibility(false);
    importWin.webContents.setWindowOpenHandler(() => ({ action: "allow" }));
    importWin.loadURL("https://fit.suunto.com/").catch(() => {});
    importWin.on("closed", () => {
      importWin = null;
    });
  }

  const wins = [importWin];
  importWin.webContents.on("did-create-window", (child) => wins.push(child));

  sendEvent({ type: "stage", text: "在窗口里登录颂拓国际（邮箱+密码），登录好会自动开始" });
  const token = await waitForToken(wins, 30 * 60 * 1000);
  if (!token) {
    return { ok: false, data: { message: "还没等到你登录，再点一次「开始导入」" } };
  }

  sendEvent({ type: "stage", text: "已登录，正在打包文件…" });
  let packed;
  try {
    packed = zipFolder(folder);
  } catch (e) {
    return { ok: false, data: { message: (e && e.message) || "打包失败" } };
  }

  sendEvent({ type: "stage", text: `${packed.count} 条已打包，开始上传…` });
  const r = await uploadZip(packed.zipPath, token, (p) =>
    sendEvent({ type: "progress", percent: Math.round(p * 100) })
  );
  try {
    fs.unlinkSync(packed.zipPath);
  } catch {}
  return { ok: !!r.ok, data: r };
}

async function handle(cmd, payload, sender) {
  const sendEvent = (ev) => sender.send("bridge-event", ev);

  switch (cmd) {
    case "status":
      return { ok: true, data: status() };

    case "pickFolder": {
      const r = await dialog.showOpenDialog(win, {
        properties: ["openDirectory", "createDirectory"],
        buttonLabel: "选择",
        message: "选择导出到哪个文件夹",
        title: "选择导出到哪个文件夹",
      });
      if (!r.canceled && r.filePaths[0]) return { ok: true, data: { path: r.filePaths[0] } };
      return { ok: false, data: { message: "已取消" } };
    }

    case "cancel":
      backend.cancel();
      return { ok: true, data: {} };

    case "logout": {
      if (backend.isBusy())
        return { ok: false, data: { message: "正在下载，先点停止再退出登录" } };
      const region = payload.region || "cn";
      try {
        fs.unlinkSync(backend.sessionURL(region));
      } catch {}
      return { ok: true, data: { ok: true } };
    }

    case "pageReady":
      try {
        fs.writeFileSync(path.join(supportDir, "ui-loaded.txt"), new Date().toString() + "\n");
      } catch {}
      return { ok: true, data: {} };

    case "fitHeight":
      if (typeof payload.height === "number") fitHeight(payload.height);
      return { ok: true, data: {} };

    case "login": {
      const r = await backend.login(payload.region || "cn", payload.email || "", payload.password || "");
      return { ok: !!r.ok, data: r };
    }

    case "count": {
      const r = await backend.count(
        payload.region || "cn",
        Number(payload.from) || 0,
        Number(payload.to) || 0
      );
      return { ok: !!r.ok, data: r };
    }

    case "export": {
      const r = await backend.exportFit(
        payload.region || "cn",
        payload.folder || "",
        Number(payload.from) || 0,
        Number(payload.to) || 0,
        sendEvent
      );
      return { ok: !!r.ok, data: r };
    }

    case "openExportFolder": {
      const folder = payload.folder || "";
      if (!folder) return { ok: false, data: { message: "还没选文件夹" } };
      const err = await shell.openPath(folder);
      return err ? { ok: false, data: { message: "打不开这个文件夹" } } : { ok: true, data: {} };
    }

    case "suuntoImportStart": {
      const folder = payload.folder || "";
      if (!folder) return { ok: false, data: { message: "先在「下载记录」里选好文件夹" } };
      return await runImport(folder, sendEvent);
    }

    case "fsSignOut":
      return { ok: true, data: backend.fsSignOut() };

    case "fsStartAuth": {
      const state = crypto.randomUUID().replace(/-/g, "");
      const url = backend.fsAuthorizeURL(state);
      if (!url) return { ok: false, data: { message: "授权地址拼不出来" } };
      const res = await openAuthWindow(url, false);
      if (!res.code) return { ok: false, data: { message: "授权没做完，窗口被关掉了" } };
      if (res.code === "error")
        return { ok: false, data: { message: "FitnessSyncer 没有同意这次授权" } };
      if (res.state !== state)
        return { ok: false, data: { message: "回传校验没对上，再点一次登录授权" } };
      const r = await backend.fsExchangeCode(res.code);
      return { ok: !!r.ok, data: r };
    }

    case "fsConnect": {
      const r = await backend.fsConnect();
      return { ok: !!r.ok, data: r };
    }

    case "folderStats": {
      const r = backend.folderStats(payload.folder || "");
      return { ok: !!r.ok, data: r };
    }

    case "fsUpload": {
      const r = await backend.fsUpload(payload.sourceId || "", payload.folder || "", sendEvent);
      return { ok: !!r.ok, data: r };
    }

    case "destStatus": {
      const r = await backend.destStatus();
      return { ok: !!r.ok, data: r };
    }

    case "destPrepare": {
      const r = await backend.destPrepare(!!payload.force);
      if (!r.ok || !r.needAuth) return { ok: !!r.ok, data: r };
      if (!r.url) return { ok: false, data: { message: "授权地址拿不到" } };
      const res = await openAuthWindow(r.url, true);
      if (res.code !== "done")
        return { ok: false, data: { message: "授权窗口被关掉了，颂拓那边还没登完" } };
      let ok = false;
      for (let i = 0; i < 10; i++) {
        if (await backend.destAuthed()) {
          ok = true;
          break;
        }
        await new Promise((r2) => setTimeout(r2, 2000));
      }
      return ok
        ? { ok: true, data: { ok: true, needAuth: false, message: "颂拓国际已连上" } }
        : { ok: false, data: { message: "颂拓那边没走完授权，再点一次「连接颂拓国际」" } };
    }

    case "destSync": {
      const r = await backend.destSync();
      return { ok: !!r.ok, data: r };
    }

    default:
      return { ok: false, data: { message: "未知指令" } };
  }
}

ipcMain.on("bridge", async (event, msg) => {
  if (!msg || typeof msg !== "object") return;
  const id = typeof msg.id === "number" ? msg.id : 0;
  const cmd = typeof msg.cmd === "string" ? msg.cmd : "";
  const payload = msg.payload && typeof msg.payload === "object" ? msg.payload : {};
  const sender = event.sender;
  try {
    const r = await handle(cmd, payload, {
      send: (channel, data) => {
        if (!sender.isDestroyed()) sender.send(channel, data);
      },
    });
    sender.send("bridge-reply", { id, ok: r.ok, data: r.data || {} });
  } catch (e) {
    sender.send("bridge-reply", {
      id,
      ok: false,
      data: { message: (e && e.message) || "操作失败" },
    });
  }
});

app.on("second-instance", () => {
  if (win) {
    if (win.isMinimized()) win.restore();
    win.focus();
  }
});

app.whenReady().then(() => {
  Menu.setApplicationMenu(null);
  createWindow();
});

app.on("window-all-closed", () => app.quit());
