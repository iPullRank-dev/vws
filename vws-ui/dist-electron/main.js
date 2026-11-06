"use strict";
const electron = require("electron");
const path = require("path");
const fs = require("fs");
const net = require("net");
const http = require("http");
const child_process = require("child_process");
const isDev = !!process.env.VITE_DEV_SERVER_URL;
const DEV_PORT = 8060;
const dataDir = path.join(process.env.LOCALAPPDATA || electron.app.getPath("userData"), "VWS");
const runtimeDir = path.join(dataDir, "runtime");
const logsDir = path.join(dataDir, "logs");
const backendDir = isDev ? path.join(__dirname, "../../vws-backend") : path.join(process.resourcesPath, "backend");
const bundledPython = path.join(process.resourcesPath, "python", process.platform === "win32" ? "python.exe" : "bin/python3");
const runtimePython = path.join(runtimeDir, "python", process.platform === "win32" ? "python.exe" : "bin/python3");
const setupScript = path.join(backendDir, "setup_runtime.py");
let mainWindow = null;
let backend = null;
let quitting = false;
let retrySetup = null;
let appUrl = null;
const gotLock = electron.app.requestSingleInstanceLock();
if (!gotLock) electron.app.quit();
electron.app.on("second-instance", () => {
  if (mainWindow) {
    if (mainWindow.isMinimized()) mainWindow.restore();
    mainWindow.focus();
  }
});
function createWindow() {
  const win = new electron.BrowserWindow({
    width: 1400,
    height: 900,
    backgroundColor: "#0f172a",
    title: "VWS",
    webPreferences: { nodeIntegration: false, contextIsolation: true }
  });
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (url === "https://vws.local/retry") {
      retrySetup == null ? void 0 : retrySetup();
      return { action: "deny" };
    }
    if (url === "https://vws.local/logs") {
      electron.shell.openPath(logsDir);
      return { action: "deny" };
    }
    if (/^https?:/.test(url)) electron.shell.openExternal(url);
    return { action: "deny" };
  });
  win.on("closed", () => {
    if (mainWindow === win) mainWindow = null;
  });
  return win;
}
const SCREEN = `<!doctype html><html><head><meta charset="utf-8"><title>VWS</title><style>
  :root{color-scheme:dark}body{margin:0;background:#0f172a;color:#e2e8f0;font:14px/1.5 system-ui,Segoe UI,sans-serif;display:flex;justify-content:center}
  main{width:min(680px,92vw);padding:56px 0}h1{font-size:26px;margin:0 0 4px;background:linear-gradient(90deg,#60a5fa,#a78bfa);-webkit-background-clip:text;color:transparent}
  p.sub{color:#94a3b8;margin:0 0 28px}ol{list-style:none;padding:0;margin:0 0 20px}li{display:grid;grid-template-columns:22px 1fr;gap:8px;padding:7px 0;border-bottom:1px solid #1e293b}
  li i{font-style:normal;color:#475569}li.running i{color:#60a5fa}li.done i,li.skipped i{color:#10b981}li.failed i{color:#ef4444}li small{display:block;color:#94a3b8}
  .bar{height:6px;background:#1e293b;border-radius:3px;overflow:hidden;margin:6px 0 2px}.bar b{display:block;height:100%;width:0;background:#60a5fa;transition:width .4s}
  .bar.ind b{width:30%;animation:ind 1.4s infinite ease-in-out}@keyframes ind{0%{margin-left:-30%}100%{margin-left:100%}}
  pre{background:#020617;border:1px solid #1e293b;border-radius:6px;padding:10px;color:#64748b;font:12px/1.45 Consolas,monospace;white-space:pre-wrap;max-height:150px;overflow:hidden}
  .err{background:#450a0a;border:1px solid #7f1d1d;color:#fecaca;border-radius:6px;padding:10px 12px;margin:12px 0;white-space:pre-wrap}
  .warn{color:#fcd34d;margin:6px 0}a.btn{display:inline-block;margin-right:8px;padding:7px 14px;border-radius:6px;background:#2563eb;color:#fff;text-decoration:none}a.btn.sec{background:#1e293b}
</style></head><body><main><h1>VWS</h1><p class="sub" id="sub">Starting…</p><ol id="steps"></ol><div id="msgs"></div><pre id="log" hidden></pre><div id="actions"></div></main>
<script>
  const S = {}; const ICON = {pending:'○',running:'◐',done:'✓',skipped:'✓',failed:'✕'};
  function li(id,label){let e=document.getElementById('s_'+id);if(!e){e=document.createElement('li');e.id='s_'+id;e.innerHTML='<i>○</i><div><span></span><small></small><div class="bar" hidden><b></b></div></div>';document.getElementById('steps').append(e)}if(label)e.querySelector('span').textContent=label;return e}
  window.vws = function(ev){
    if(ev.type==='sub'){document.getElementById('sub').textContent=ev.text}
    else if(ev.type==='plan'){ev.steps.forEach(s=>{li(s.id,s.label).className='pending'})}
    else if(ev.type==='step'){const e=li(ev.id,ev.label);e.className=ev.status;e.querySelector('i').textContent=ICON[ev.status]||'○';e.querySelector('small').textContent=ev.detail||'';const b=e.querySelector('.bar');b.hidden=ev.status!=='running';b.className='bar ind'}
    else if(ev.type==='progress'){const e=li(ev.id);const b=e.querySelector('.bar');b.hidden=false;if(ev.pct!=null){b.className='bar';b.firstChild.style.width=(ev.pct*100).toFixed(1)+'%'}e.querySelector('small').textContent=ev.detail||''}
    else if(ev.type==='log'){const p=document.getElementById('log');p.hidden=false;const l=(p.textContent+'\\n'+ev.line).split('\\n').filter(Boolean).slice(-8);p.textContent=l.join('\\n')}
    else if(ev.type==='warn'||ev.type==='info'){const d=document.createElement('div');d.className='warn';d.textContent=ev.message;document.getElementById('msgs').append(d)}
    else if(ev.type==='error'){const d=document.createElement('div');d.className='err';d.textContent=ev.message;document.getElementById('msgs').append(d);
      document.getElementById('actions').innerHTML='<a class="btn" href="https://vws.local/retry" target="_blank">Try again</a><a class="btn sec" href="https://vws.local/logs" target="_blank">Open logs</a>'}
    else if(ev.type==='reset'){document.getElementById('msgs').innerHTML='';document.getElementById('actions').innerHTML=''}
  };
<\/script></body></html>`;
function screen(win) {
  return win.loadURL("data:text/html;charset=utf-8," + encodeURIComponent(SCREEN));
}
function push(win, ev) {
  if (win && !win.isDestroyed()) win.webContents.executeJavaScript(`window.vws && window.vws(${JSON.stringify(ev)})`).catch(() => {
  });
}
function setupReady() {
  return new Promise((resolve) => {
    if (!fs.existsSync(runtimePython)) return resolve(false);
    child_process.execFile(
      bundledPython,
      [setupScript, "--check", "--data-dir", dataDir],
      { windowsHide: true, timeout: 6e4 },
      (err) => resolve(!err)
    );
  });
}
function runSetup(win) {
  return new Promise((resolve) => {
    push(win, { type: "sub", text: "Setting up: downloading PyTorch, packages and the AI models. This only happens once and can take a while." });
    const args = [setupScript, "--json", "--data-dir", dataDir];
    if (process.argv.includes("--setup-force")) args.push("--force");
    const p = child_process.spawn(bundledPython, args, { cwd: backendDir, windowsHide: true, env: { ...process.env, PYTHONUTF8: "1", PYTHONUNBUFFERED: "1" } });
    let buf = "";
    const onData = (d) => {
      buf += d.toString("utf8");
      const lines = buf.split(/\r?\n/);
      buf = lines.pop() || "";
      for (const line of lines) {
        if (line.startsWith("@@")) {
          try {
            push(win, JSON.parse(line.slice(2)));
          } catch {
          }
        } else if (line.trim()) push(win, { type: "log", line });
      }
    };
    p.stdout.on("data", onData);
    p.stderr.on("data", onData);
    p.on("error", (e) => {
      push(win, { type: "error", message: `Couldn't start setup: ${e.message}` });
      resolve(false);
    });
    p.on("exit", (code) => resolve(code === 0));
  });
}
function freePort() {
  return new Promise((resolve, reject) => {
    const s = net.createServer();
    s.unref();
    s.on("error", reject);
    s.listen(0, "127.0.0.1", () => {
      const port = s.address().port;
      s.close(() => resolve(port));
    });
  });
}
function waitForBackend(port, timeoutMs) {
  const until = Date.now() + timeoutMs;
  return new Promise((resolve) => {
    const tryOnce = () => {
      const req = http.get({ host: "127.0.0.1", port, path: "/api/health", timeout: 2e3 }, (res) => {
        res.resume();
        if (res.statusCode === 200) return resolve(true);
        retry();
      });
      req.on("error", retry);
      req.on("timeout", () => {
        req.destroy();
        retry();
      });
    };
    const retry = () => {
      if ((backend == null ? void 0 : backend.exitCode) != null || Date.now() > until) return resolve(false);
      setTimeout(tryOnce, 500);
    };
    tryOnce();
  });
}
function startBackend(port) {
  var _a, _b;
  fs.mkdirSync(logsDir, { recursive: true });
  const log = fs.createWriteStream(path.join(logsDir, "backend.log"), { flags: "a" });
  log.write(`
=== ${(/* @__PURE__ */ new Date()).toISOString()} start on port ${port} ===
`);
  if (isDev) {
    const venvPython = path.join(backendDir, "venv", process.platform === "win32" ? "Scripts/python.exe" : "bin/python");
    backend = child_process.spawn(venvPython, ["-m", "uvicorn", "main:app", "--host", "127.0.0.1", "--port", String(port), "--reload"], { cwd: backendDir });
  } else {
    const env = {
      ...process.env,
      VWS_DB_PATH: path.join(dataDir, "vws.sqlite"),
      VWS_UPLOAD_DIR: path.join(dataDir, "uploads"),
      HF_HOME: path.join(dataDir, "models"),
      HF_HUB_OFFLINE: "1",
      // models were downloaded at install; no network checks, no token warnings
      HF_HUB_DISABLE_TELEMETRY: "1",
      PLAYWRIGHT_BROWSERS_PATH: path.join(runtimeDir, "ms-playwright"),
      PYTHONPYCACHEPREFIX: path.join(dataDir, "pycache"),
      PYTHONUNBUFFERED: "1",
      PYTHONUTF8: "1",
      PYTHONNOUSERSITE: "1"
    };
    backend = child_process.spawn(
      runtimePython,
      ["-m", "uvicorn", "main:app", "--host", "127.0.0.1", "--port", String(port)],
      { cwd: backendDir, env, windowsHide: true }
    );
  }
  (_a = backend.stdout) == null ? void 0 : _a.on("data", (d) => {
    log.write(d);
    if (isDev) process.stdout.write(`Backend: ${d}`);
  });
  (_b = backend.stderr) == null ? void 0 : _b.on("data", (d) => {
    log.write(d);
    if (isDev) process.stderr.write(`Backend: ${d}`);
  });
  backend.on("exit", (code) => {
    log.write(`=== exited with ${code} ===
`);
    if (!quitting && !isDev) {
      electron.dialog.showErrorBox("VWS engine stopped", `The analysis engine exited (code ${code}). Details are in ${path.join(logsDir, "backend.log")}. Restart VWS to continue.`);
    }
  });
}
function stopBackend() {
  if (!backend || backend.exitCode != null || !backend.pid) return;
  if (process.platform === "win32") {
    child_process.execFile("taskkill", ["/pid", String(backend.pid), "/T", "/F"], () => {
    });
  } else {
    backend.kill();
  }
}
async function startPackaged() {
  const win = createWindow();
  mainWindow = win;
  await screen(win);
  const forceSetup = process.argv.includes("--setup") || process.argv.includes("--setup-force");
  if (forceSetup || !await setupReady()) {
    let ok = await runSetup(win);
    while (!ok) {
      await new Promise((r) => {
        retrySetup = r;
      });
      retrySetup = null;
      push(win, { type: "reset" });
      ok = await runSetup(win);
    }
  }
  push(win, { type: "sub", text: "Starting the analysis engine…" });
  const port = await freePort();
  startBackend(port);
  if (!await waitForBackend(port, 18e4)) {
    push(win, { type: "error", message: `The analysis engine didn't start. Details are in ${path.join(logsDir, "backend.log")}.` });
    return;
  }
  appUrl = { file: path.join(__dirname, "../dist/index.html"), query: { api: `http://127.0.0.1:${port}` } };
  await win.loadFile(appUrl.file, { query: appUrl.query });
}
async function startDev() {
  startBackend(DEV_PORT);
  appUrl = { url: process.env.VITE_DEV_SERVER_URL };
  mainWindow = createWindow();
  mainWindow.loadURL(appUrl.url);
}
if (gotLock) electron.app.whenReady().then(() => isDev ? startDev() : startPackaged());
electron.app.on("activate", () => {
  if (electron.BrowserWindow.getAllWindows().length === 0 && appUrl) {
    mainWindow = createWindow();
    if (appUrl.url) mainWindow.loadURL(appUrl.url);
    else mainWindow.loadFile(appUrl.file, { query: appUrl.query });
  }
});
electron.app.on("window-all-closed", () => {
  if (process.platform !== "darwin") electron.app.quit();
});
electron.app.on("before-quit", () => {
  quitting = true;
  stopBackend();
});
