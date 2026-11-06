"""Install-time setup for the packaged VWS app.

The installer ships a small, self-contained Python. This script (run with that
Python, standard library only) builds everything heavy on the user's machine:

  1. copies the bundled Python to <data>/runtime/python (so app updates and the
     install folder can change without breaking the environment),
  2. detects an NVIDIA GPU and installs the CUDA build of PyTorch, or the CPU
     build when there's no GPU (or the driver is too old),
  3. installs the backend's packages (requirements.txt, pinned by constraints.txt),
  4. installs Chromium for the crawler (Playwright),
  5. downloads the models (EmbeddingGemma 2 and the local LLM) into <data>/models,
  6. writes <data>/runtime/state.json, which the app checks before starting.

Every step is skipped when it's already done, so re-running is cheap and an
interrupted install resumes where it stopped.

Usage (the installer and the app call it like this):
    python setup_runtime.py                 # console output, for the installer window
    python setup_runtime.py --json          # @@{...} progress lines, for the app's setup screen
    python setup_runtime.py --check         # exit 0 if ready, 1 if setup is needed
Options: --data-dir DIR, --gpu auto|cuda|cpu, --skip-llm, --pause-on-error, --force
Env:     VWS_TORCH_INDEX (override the PyTorch wheel index), HF_TOKEN (optional),
         VWS_EMBED_MODEL / VWS_LLM_MODEL (model ids, same as the backend).
"""
from __future__ import annotations

import argparse
import hashlib
import json
import os
import re
import shutil
import subprocess
import sys
import threading
import time
from pathlib import Path

SETUP_VERSION = 1
HERE = Path(__file__).resolve().parent
EMBED_MODEL = os.environ.get("VWS_EMBED_MODEL", "google/embeddinggemma-2")
LLM_MODEL = os.environ.get("VWS_LLM_MODEL", "google/gemma-4-E2B-it")
TORCH_INDEX = "https://download.pytorch.org/whl/{variant}"
IS_WIN = os.name == "nt"

JSON = False
LOG_FH = None


# ---------------------------------------------------------------------------
# output
# ---------------------------------------------------------------------------
def emit(kind: str, **data) -> None:
    """Progress for the app (--json) or plain text for the installer console."""
    if JSON:
        print("@@" + json.dumps({"type": kind, **data}), flush=True)
    elif kind == "step" and data.get("status") == "running":
        print(f"\n==> {data.get('label')}" + (f"  ({data['detail']})" if data.get("detail") else ""), flush=True)
    elif kind == "step" and data.get("status") in ("done", "skipped"):
        print(f"    {data.get('status')}" + (f": {data['detail']}" if data.get("detail") else ""), flush=True)
    elif kind == "progress":
        print(f"\r    {data.get('detail', '')}      ", end="", flush=True)
    elif kind in ("warn", "error"):
        print(f"\n{'WARNING' if kind == 'warn' else 'ERROR'}: {data.get('message')}", flush=True)
    elif kind == "info":
        print(f"\n{data.get('message')}", flush=True)
    elif kind == "done":
        print(f"\nVWS is ready ({data.get('summary', '')}).", flush=True)
    if LOG_FH:
        LOG_FH.write(json.dumps({"t": round(time.time(), 1), "type": kind, **data}) + "\n")
        LOG_FH.flush()


def log_line(line: str) -> None:
    line = line.rstrip()
    if not line:
        return
    if JSON:
        print("@@" + json.dumps({"type": "log", "line": line[-400:]}), flush=True)
    else:
        print("    " + line, flush=True)
    if LOG_FH:
        LOG_FH.write(line + "\n")
        LOG_FH.flush()


def run(cmd: list[str], env: dict | None = None, cwd: str | None = None) -> None:
    """Run a command, streaming its output; raise with the last lines on failure.
    In the installer's console window the command writes straight to the console,
    so pip's own progress bars show."""
    if not JSON:
        if LOG_FH:
            LOG_FH.write("$ " + " ".join(cmd) + "\n")
            LOG_FH.flush()
        rc = subprocess.run(cmd, env=env, cwd=cwd).returncode
        if rc != 0:
            raise RuntimeError(f"{' '.join(cmd[:5])} … failed (exit {rc}). See the output above.")
        return
    tail: list[str] = []
    p = subprocess.Popen(cmd, stdout=subprocess.PIPE, stderr=subprocess.STDOUT, env=env, cwd=cwd,
                         text=True, encoding="utf-8", errors="replace", bufsize=1,
                         creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0) if JSON else 0)
    for line in p.stdout:
        # pip's progress bars use carriage returns; keep the last state of the line.
        line = line.split("\r")[-1]
        log_line(line)
        tail = (tail + [line.rstrip()])[-12:]
    if p.wait() != 0:
        raise RuntimeError(f"{' '.join(cmd[:4])} … failed (exit {p.returncode}):\n" + "\n".join(t for t in tail if t))


# ---------------------------------------------------------------------------
# paths and state
# ---------------------------------------------------------------------------
def default_data_dir() -> Path:
    if IS_WIN:
        return Path(os.environ.get("LOCALAPPDATA") or Path.home() / "AppData" / "Local") / "VWS"
    return Path(os.environ.get("XDG_DATA_HOME") or Path.home() / ".local" / "share") / "VWS"


def runtime_python(rt: Path) -> Path:
    return rt / "python" / ("python.exe" if IS_WIN else "bin/python3")


def requirements_hash(variant: str) -> str:
    h = hashlib.sha256(f"v{SETUP_VERSION}|{variant}|{EMBED_MODEL}".encode())
    for name in ("requirements.txt", "constraints.txt"):
        f = HERE / name
        if f.exists():
            h.update(f.read_bytes())
    return h.hexdigest()[:16]


def load_state(rt: Path) -> dict:
    try:
        return json.loads((rt / "state.json").read_text(encoding="utf-8"))
    except Exception:
        return {}


def save_state(rt: Path, state: dict) -> None:
    (rt / "state.json").write_text(json.dumps(state, indent=2), encoding="utf-8")


def model_cached(models_dir: Path, repo_id: str) -> bool:
    snaps = models_dir / "hub" / ("models--" + repo_id.replace("/", "--")) / "snapshots"
    if not snaps.is_dir():
        return False
    for snap in snaps.iterdir():
        weights = list(snap.glob("*.safetensors"))
        if weights and all(w.exists() and w.stat().st_size > 0 for w in weights):
            return True
    return False


# ---------------------------------------------------------------------------
# GPU
# ---------------------------------------------------------------------------
def detect_gpu() -> dict:
    """{'variant': 'cu130'|'cu126'|'cpu', 'gpu': name or None, 'cuda': 'x.y' or None, 'note': str}"""
    smi = shutil.which("nvidia-smi")
    if not smi and IS_WIN:
        cand = Path(os.environ.get("SystemRoot", r"C:\Windows")) / "System32" / "nvidia-smi.exe"
        smi = str(cand) if cand.exists() else None
    if not smi:
        return {"variant": "cpu", "gpu": None, "cuda": None, "note": "No NVIDIA GPU found, using the CPU build."}
    try:
        out = subprocess.run([smi], capture_output=True, text=True, timeout=20).stdout
        name = subprocess.run([smi, "--query-gpu=name", "--format=csv,noheader"], capture_output=True, text=True,
                              timeout=20).stdout.strip().splitlines()[0].strip()
    except Exception as e:
        return {"variant": "cpu", "gpu": None, "cuda": None, "note": f"nvidia-smi failed ({e}), using the CPU build."}
    m = re.search(r"CUDA Version:\s*(\d+)\.(\d+)", out)
    if not m:
        return {"variant": "cpu", "gpu": name, "cuda": None, "note": "Couldn't read the driver's CUDA version, using the CPU build."}
    major, minor = int(m.group(1)), int(m.group(2))
    cuda = f"{major}.{minor}"
    if major >= 13:
        return {"variant": "cu130", "gpu": name, "cuda": cuda, "note": ""}
    if major == 12 and minor >= 6:
        return {"variant": "cu126", "gpu": name, "cuda": cuda, "note": ""}
    return {"variant": "cpu", "gpu": name, "cuda": cuda,
            "note": f"{name}: the driver supports CUDA {cuda}, PyTorch needs 12.6 or newer. Using the CPU build; "
                    "update the NVIDIA driver and run setup again for GPU speed."}


# ---------------------------------------------------------------------------
# steps
# ---------------------------------------------------------------------------
def step_python(rt: Path) -> Path:
    emit("step", id="python", label="Python runtime", status="running")
    target = rt / "python"
    src = Path(sys.executable).resolve().parent if IS_WIN else Path(sys.executable).resolve().parent.parent
    ver = f"{sys.version_info.major}.{sys.version_info.minor}.{sys.version_info.micro}"
    marker = target / ".vws-python-version"
    if target.resolve() == src.resolve():
        emit("step", id="python", label="Python runtime", status="skipped", detail=f"already running from it ({ver})")
    elif marker.exists() and marker.read_text().strip() == ver and runtime_python(rt).exists():
        emit("step", id="python", label="Python runtime", status="skipped", detail=f"Python {ver} already in place")
    else:
        if target.exists():
            shutil.rmtree(target)  # a different Python version: its packages must be reinstalled anyway
        shutil.copytree(src, target)
        marker.write_text(ver)
        emit("step", id="python", label="Python runtime", status="done", detail=f"Python {ver}")
    return runtime_python(rt)


VCREDIST_URL = "https://aka.ms/vs/17/release/vc_redist.x64.exe"


def step_vcredist(rt: Path) -> None:
    """PyTorch on Windows needs the Microsoft Visual C++ runtime (msvcp140.dll,
    vcomp140.dll). Most PCs have it; when it's missing, install it (Windows asks
    for permission once)."""
    if not IS_WIN:
        return
    sysdir = Path(os.environ.get("SystemRoot", r"C:\Windows")) / "System32"
    if all((sysdir / dll).exists() for dll in ("msvcp140.dll", "vcruntime140.dll", "vcruntime140_1.dll", "vcomp140.dll")):
        return
    emit("step", id="vcredist", label="Microsoft Visual C++ runtime", status="running", detail="needed by PyTorch")
    import urllib.request
    exe = rt / "vc_redist.x64.exe"
    urllib.request.urlretrieve(VCREDIST_URL, exe)
    rc = subprocess.run([str(exe), "/install", "/quiet", "/norestart"]).returncode
    if rc not in (0, 1638, 3010):  # 1638: a newer version is installed; 3010: restart needed
        emit("warn", message=f"The Visual C++ runtime installer returned {rc}. If PyTorch fails to load, install it from {VCREDIST_URL}.")
    emit("step", id="vcredist", label="Microsoft Visual C++ runtime", status="done")


def pip_env(models_dir: Path) -> dict:
    env = dict(os.environ)
    env.update({"PIP_DISABLE_PIP_VERSION_CHECK": "1", "PYTHONUTF8": "1", "PYTHONNOUSERSITE": "1",
                "HF_HOME": str(models_dir), "HF_HUB_DISABLE_TELEMETRY": "1",
                # No Xet chunk cache: it would keep a second copy of every model on disk.
                "HF_XET_CHUNK_CACHE_SIZE_BYTES": "0"})
    return env


def installed_torch(py: Path, env: dict) -> str | None:
    """'cu130' / 'cu126' / 'cpu' for the torch already installed, None if there's none."""
    try:
        out = subprocess.run([str(py), "-c", "import torch,sys; sys.stdout.write(torch.version.cuda or 'cpu')"],
                             capture_output=True, text=True, timeout=180, env=env)
    except Exception:
        return None
    if out.returncode != 0:
        return None
    v = out.stdout.strip()
    return "cpu" if v == "cpu" else "cu" + v.replace(".", "")[:3]


def step_torch(py: Path, env: dict, gpu: dict, force: bool) -> str:
    variant = gpu["variant"]
    label = f"PyTorch ({'CUDA ' + gpu['cuda'] + ' for ' + gpu['gpu'] if variant != 'cpu' else 'CPU'})"
    emit("step", id="torch", label=label, status="running", detail=gpu.get("note") or "")
    have = installed_torch(py, env)
    if have == variant and not force:
        emit("step", id="torch", label=label, status="skipped", detail="already installed")
        return variant
    index = os.environ.get("VWS_TORCH_INDEX") or TORCH_INDEX.format(variant=variant)
    if have:
        run([str(py), "-m", "pip", "uninstall", "-y", "torch", "torchvision"], env=env)
    run([str(py), "-m", "pip", "install", "--upgrade", "torch", "torchvision", "--index-url", index,
         "--progress-bar", "off" if JSON else "on"], env=env)
    emit("step", id="torch", label=label, status="done")
    return variant


def step_packages(py: Path, env: dict, rt: Path) -> None:
    emit("step", id="packages", label="Python packages", status="running", detail="requirements.txt")
    # torch/torchvision are already in place (the right build); keep pip from swapping them.
    reqs = [l for l in (HERE / "requirements.txt").read_text(encoding="utf-8").splitlines()
            if not re.match(r"^\s*(torch|torchvision)\s*($|[<>=!~;\[])", l)]
    tmp = rt / "requirements.vws.txt"
    tmp.write_text("\n".join(reqs) + "\n", encoding="utf-8")
    cmd = [str(py), "-m", "pip", "install", "-r", str(tmp), "--progress-bar", "off" if JSON else "on"]
    if (HERE / "constraints.txt").exists():
        cmd += ["-c", str(HERE / "constraints.txt")]
    run(cmd, env=env)
    emit("step", id="packages", label="Python packages", status="done")


def step_browser(py: Path, env: dict, rt: Path) -> None:
    emit("step", id="browser", label="Chromium for the crawler", status="running")
    benv = dict(env, PLAYWRIGHT_BROWSERS_PATH=str(rt / "ms-playwright"))
    # The crawler only runs headless, so the headless shell is enough (~250 MB less than full Chromium).
    run([str(py), "-m", "playwright", "install", "chromium", "--only-shell"], env=benv)
    emit("step", id="browser", label="Chromium for the crawler", status="done")


def _dir_bytes(p: Path) -> int:
    total = 0
    for root, _, files in os.walk(p):
        for f in files:
            try:
                total += os.path.getsize(os.path.join(root, f))
            except OSError:
                pass
    return total


def step_model(py: Path, env: dict, models_dir: Path, repo_id: str, sid: str, label: str) -> None:
    emit("step", id=sid, label=label, status="running", detail=repo_id)
    if model_cached(models_dir, repo_id):
        emit("step", id=sid, label=label, status="skipped", detail="already downloaded")
        return
    # Expected size, for a progress bar (the download itself runs in the runtime Python,
    # which has huggingface_hub; this script only has the standard library).
    size_code = ("import json,sys; from huggingface_hub import HfApi; "
                 f"i=HfApi().model_info({repo_id!r}, files_metadata=True); "
                 "sys.stdout.write(json.dumps(sum((s.size or 0) for s in i.siblings)))")
    try:
        total = int(subprocess.run([str(py), "-c", size_code], capture_output=True, text=True, env=env, timeout=120).stdout or 0)
    except Exception:
        total = 0
    repo_dir = models_dir / "hub" / ("models--" + repo_id.replace("/", "--"))
    base = _dir_bytes(repo_dir)
    stop = threading.Event()

    def watch():
        while not stop.wait(1.5):
            got = _dir_bytes(repo_dir) - base
            if total:
                emit("progress", id=sid, pct=round(min(0.999, max(0.0, got / total)), 4),
                     detail=f"{got / 1e9:.2f} of {total / 1e9:.2f} GB")
            else:
                emit("progress", id=sid, pct=None, detail=f"{got / 1e9:.2f} GB")

    t = threading.Thread(target=watch, daemon=True)
    t.start()
    code = ("from huggingface_hub import snapshot_download; "
            f"snapshot_download({repo_id!r}, max_workers=8)")
    try:
        run([str(py), "-c", code], env=dict(env, HF_HUB_VERBOSITY="error", HF_HUB_DISABLE_PROGRESS_BARS="1"))
    finally:
        stop.set()
        t.join(timeout=3)
    if not model_cached(models_dir, repo_id):
        raise RuntimeError(f"{repo_id} didn't finish downloading.")
    emit("step", id=sid, label=label, status="done", detail=f"{total / 1e9:.1f} GB" if total else "")


def step_verify(py: Path, env: dict, variant: str) -> dict:
    emit("step", id="verify", label="Checking the install", status="running")
    code = ("import json, sys, torch, sentence_transformers, transformers, sqlite_vec, trafilatura, playwright, fastapi; "
            "ok = torch.cuda.is_available(); "
            "sys.stdout.write(json.dumps({'torch': torch.__version__, 'cuda': ok, "
            "'device': torch.cuda.get_device_name(0) if ok else 'cpu'}))")
    out = subprocess.run([str(py), "-c", code], capture_output=True, text=True, env=env, timeout=600)
    if out.returncode != 0:
        raise RuntimeError("The packages installed but don't import:\n" + out.stderr[-1500:])
    info = json.loads(out.stdout.strip().splitlines()[-1])
    if variant != "cpu" and not info["cuda"]:
        emit("warn", message="The CUDA build of PyTorch is installed but the GPU isn't visible to it; VWS will run on the CPU.")
    emit("step", id="verify", label="Checking the install", status="done", detail=f"torch {info['torch']} on {info['device']}")
    return info


# ---------------------------------------------------------------------------
def main() -> int:
    global JSON, LOG_FH
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--data-dir", default=None)
    ap.add_argument("--gpu", choices=("auto", "cuda", "cpu"), default="auto")
    ap.add_argument("--skip-llm", action="store_true", help="don't download the local LLM (rewrite suggestions)")
    ap.add_argument("--json", action="store_true")
    ap.add_argument("--check", action="store_true")
    ap.add_argument("--force", action="store_true", help="reinstall PyTorch and re-run every step")
    ap.add_argument("--pause-on-error", action="store_true")
    a = ap.parse_args()
    JSON = a.json

    data = Path(a.data_dir) if a.data_dir else default_data_dir()
    rt, models_dir = data / "runtime", data / "models"

    if a.check:
        st = load_state(rt)
        variant = st.get("variant", "")
        ready = (st.get("complete") and runtime_python(rt).exists() and st.get("hash") == requirements_hash(variant)
                 and model_cached(models_dir, EMBED_MODEL)
                 and (st.get("skip_llm") or model_cached(models_dir, LLM_MODEL)))
        print(json.dumps({"ready": bool(ready), "state": st}))
        return 0 if ready else 1

    for d in (rt, models_dir, data / "logs"):
        d.mkdir(parents=True, exist_ok=True)
    if IS_WIN and not JSON:
        os.system("title VWS setup")
    LOG_FH = open(data / "logs" / "setup.log", "a", encoding="utf-8")

    steps = [("python", "Python runtime"), ("torch", "PyTorch"), ("packages", "Python packages"),
             ("browser", "Chromium for the crawler"), ("embed", f"Embedding model ({EMBED_MODEL})")]
    if not a.skip_llm:
        steps.append(("llm", f"Local LLM ({LLM_MODEL})"))
    steps.append(("verify", "Checking the install"))
    emit("plan", steps=[{"id": i, "label": l} for i, l in steps], data_dir=str(data))

    try:
        need_gb = (3.5 if a.gpu != "cpu" else 1.5) + 1.6 + (0 if a.skip_llm else 10.4) + 0.5
        free_gb = shutil.disk_usage(data).free / 1e9
        if free_gb < need_gb:
            raise RuntimeError(f"Not enough disk space in {data}: about {need_gb:.0f} GB is needed, {free_gb:.0f} GB is free.")

        py = step_python(rt)
        step_vcredist(rt)
        env = pip_env(models_dir)
        gpu = detect_gpu() if a.gpu == "auto" else (
            {"variant": "cpu", "gpu": None, "cuda": None, "note": "CPU build requested."} if a.gpu == "cpu"
            else {**detect_gpu(), "note": ""})
        if a.gpu == "cuda" and gpu["variant"] == "cpu":
            raise RuntimeError(gpu.get("note") or "No usable NVIDIA GPU found.")
        if gpu.get("note"):
            emit("warn" if gpu.get("gpu") else "info", message=gpu["note"])
        variant = step_torch(py, env, gpu, a.force)
        step_packages(py, env, rt)
        step_browser(py, env, rt)
        step_model(py, env, models_dir, EMBED_MODEL, "embed", "Embedding model (EmbeddingGemma 2)")
        if not a.skip_llm:
            step_model(py, env, models_dir, LLM_MODEL, "llm", "Local LLM for rewrite suggestions")
        info = step_verify(py, env, variant)
        save_state(rt, {"complete": True, "setup_version": SETUP_VERSION, "variant": variant, "hash": requirements_hash(variant),
                        "gpu": gpu.get("gpu"), "cuda_driver": gpu.get("cuda"), "torch": info["torch"],
                        "cuda_available": info["cuda"], "device": info["device"], "skip_llm": a.skip_llm,
                        "embed_model": EMBED_MODEL, "llm_model": None if a.skip_llm else LLM_MODEL,
                        "python": str(py), "finished_at": time.strftime("%Y-%m-%d %H:%M:%S")})
        emit("done", ok=True, summary=f"torch {info['torch']} on {info['device']}")
        return 0
    except Exception as e:
        emit("error", message=str(e), log=str(data / "logs" / "setup.log"))
        if a.pause_on_error and not JSON:
            try:
                input("\nSetup didn't finish. VWS will try again the first time you open it. Press Enter to close…")
            except EOFError:
                pass
        return 1


if __name__ == "__main__":
    sys.exit(main())
