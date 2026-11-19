const { ipcRenderer } = require("electron");

window.webkit = window.webkit || {};
window.webkit.messageHandlers = window.webkit.messageHandlers || {};
window.webkit.messageHandlers.bridge = {
  postMessage: (msg) => ipcRenderer.send("bridge", msg),
};

ipcRenderer.on("bridge-reply", (_e, msg) => {
  if (typeof window.__bridge === "function") window.__bridge(msg);
});
ipcRenderer.on("bridge-event", (_e, ev) => {
  if (typeof window.__event === "function") window.__event(ev);
});
