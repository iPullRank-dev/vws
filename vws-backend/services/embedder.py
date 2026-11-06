"""Local embedding engine: Google EmbeddingGemma 2 (text-only).

EmbeddingGemma 2 (Oct 2026) is a 740M multimodal model built on Gemma 4. We load
only the 270M text/code backbone (vision + audio encoders disabled) because VWS
only embeds text. Key facts that shape this module:

* Native output is 768-d, Matryoshka-trained for 512 / 256 / 128. Any other size
  (the old code used 300) is not a supported truncation. We always store the full
  768-d vector and truncate + re-normalize at analysis time to the project's
  chosen size (see `truncate`), so switching sizes never needs a re-embed.
* The model is trained with task prefixes. Queries and documents get different
  ones, and documents should carry their real title:
      query:    "task: search result | query: {query}"
      document: "title: {title} | text: {content}"   ("title: none" if unknown)
* Run in bfloat16 or float32. float16 silently produces NaN/degraded vectors.
* Context window is 8,192 tokens. We default to 2,048 for speed on CPU; raise
  VWS_EMBED_MAX_TOKENS to 8192 on a GPU to embed long pages whole.

Environment overrides:
    VWS_EMBED_MODEL       default "google/embeddinggemma-2"
    VWS_EMBED_DIM         default analysis size for projects: 768 | 512 | 256 | 128 (default 768)
    VWS_EMBED_MAX_TOKENS  default 2048 (max 8192)
    VWS_EMBED_BATCH       default 16
    VWS_EMBED_TOKEN_BUDGET  tokens per forward pass (default 8192 CPU, 32768 CUDA)
"""
from __future__ import annotations

import os
import threading
import time
import warnings
from urllib.parse import urlparse

import numpy as np

warnings.filterwarnings("ignore")

MODEL_ID = os.environ.get("VWS_EMBED_MODEL", "google/embeddinggemma-2")
VALID_DIMS = (768, 512, 256, 128)
NATIVE_DIM = 768  # what we store; analysis truncates from here
# Default stays 768: on real iPR data 256-d flipped the best page for 32% of
# queries (mostly near-ties) and the Lab's best passage for 42% (see thresholds.DIM_EVAL).
_dim = int(os.environ.get("VWS_EMBED_DIM", "768"))
DEFAULT_ANALYSIS_DIM = _dim if _dim in VALID_DIMS else 768
EMBED_DIM = NATIVE_DIM  # back-compat name: dimension of stored local vectors
MAX_TOKENS = min(int(os.environ.get("VWS_EMBED_MAX_TOKENS", "2048")), 8192)
BATCH_SIZE = int(os.environ.get("VWS_EMBED_BATCH", "16"))
# Max (sequences x padded tokens) per forward pass. Set after device detection
# unless overridden: 8k on CPU/MPS (~1.5 GB activations), 32k on CUDA (fits 8 GB laptop GPUs).
_TOKEN_BUDGET_ENV = os.environ.get("VWS_EMBED_TOKEN_BUDGET")
TOKEN_BUDGET = int(_TOKEN_BUDGET_ENV) if _TOKEN_BUDGET_ENV else 8192

# Exact prefixes from the EmbeddingGemma 2 model card.
QUERY_PREFIXES = {
    "search": "task: search result | query: ",
    "question": "task: question answering | query: ",
    "fact": "task: fact checking | query: ",
    "code": "task: code retrieval | query: ",
    "similarity": "task: sentence similarity | query: ",
    "clustering": "task: clustering | query: ",
    "classification": "task: classification | query: ",
}

_PLACEHOLDER_TITLES = {"", "extracted page", "none", "untitled", "nan"}


def model_tag() -> str:
    """Identifier stored next to every vector so we never compare across spaces.
    The stored dimension lives in its own column; analysis compares name + size."""
    return MODEL_ID


# Models trained with Matryoshka representation learning: their leading
# dimensions form valid smaller embeddings, so we may truncate them.
MRL_FAMILIES = ("embeddinggemma", "text-embedding-3", "gemini-embedding", "qwen3-embedding", "nomic-embed-text-v1.5")


def base_model_name(tag: str) -> str:
    """Strip status prefixes and legacy ':<dim>' suffixes from a stored tag."""
    t = (tag or "").strip()
    if t.startswith("unverified:"):
        t = t[len("unverified:"):]
    head, sep, tail = t.rpartition(":")
    if sep and tail.isdigit():
        t = head
    return t


def supports_truncation(tag: str) -> bool:
    name = base_model_name(tag).lower()
    return not tag.startswith("legacy") and any(f in name for f in MRL_FAMILIES)


def truncate(vecs: np.ndarray, dim: int | None) -> np.ndarray:
    """Matryoshka truncation: keep the leading `dim` values, then L2-normalize."""
    v = np.asarray(vecs, dtype=np.float32)
    if dim is None or v.ndim == 0 or v.shape[-1] <= dim:
        return v
    v = v[..., :dim]
    n = np.linalg.norm(v, axis=-1, keepdims=True)
    n[n == 0] = 1.0
    return v / n


def title_from_url(url: str) -> str:
    try:
        path = urlparse(url).path.rstrip("/")
    except Exception:
        path = ""
    slug = path.split("/")[-1] if path else ""
    if not slug:
        return "Home"
    return slug.replace("-", " ").replace("_", " ").strip().capitalize()


def clean_title(title: str | None, url: str = "") -> str:
    t = (title or "").strip()
    if t.lower() in _PLACEHOLDER_TITLES or t.startswith("http://") or t.startswith("https://"):
        return title_from_url(url) if url else ""
    return t


def format_document(text: str, title: str | None = None) -> str:
    t = (title or "").replace("|", " ").strip() or "none"
    return f"title: {t} | text: {text or ''}"


class GemmaEmbedder:
    _instance: "GemmaEmbedder | None" = None
    _init_lock = threading.Lock()

    @classmethod
    def get_instance(cls) -> "GemmaEmbedder":
        if cls._instance is None:
            with cls._init_lock:
                if cls._instance is None:
                    cls._instance = cls()
        return cls._instance

    @classmethod
    def is_loaded(cls) -> bool:
        return cls._instance is not None and cls._instance.model is not None

    def __init__(self):
        self.model = None
        self.device = "cpu"
        self.dtype_name = "float32"
        self._encode_lock = threading.Lock()
        print(f"Initializing local inference engine ({MODEL_ID}, stores {NATIVE_DIM}-d, max {MAX_TOKENS} tokens)")

        import torch

        global TOKEN_BUDGET
        if torch.cuda.is_available():
            self.device = "cuda"
            dtype = torch.bfloat16 if torch.cuda.is_bf16_supported() else torch.float32
            if not _TOKEN_BUDGET_ENV:
                TOKEN_BUDGET = 32768
            print("CUDA detected - GPU inference enabled")
        elif torch.backends.mps.is_available() and torch.backends.mps.is_built():
            self.device = "mps"
            dtype = torch.float32
            print("Apple Silicon MPS detected - GPU inference enabled")
        else:
            dtype = torch.float32
            diag = gpu_diagnostics()
            if diag.get("warning"):
                print(f"WARNING: {diag['warning']}\n         Fix: {diag.get('fix')}")
            else:
                print("CPU mode (no CUDA GPU visible to PyTorch). Embedding will be slower.")
        self.dtype_name = str(dtype).replace("torch.", "")

        try:
            from sentence_transformers import SentenceTransformer
        except Exception as e:  # pragma: no cover - environment problem
            raise RuntimeError(
                "sentence-transformers is not installed. Run: "
                'pip install -U "sentence-transformers[image]>=6.1" "transformers>=5.20"'
            ) from e

        try:
            kwargs = {}
            if "embeddinggemma-2" in MODEL_ID:
                # Text-only: skip the vision (170M) and audio (300M) encoders.
                kwargs["config_kwargs"] = {"vision_config": None, "audio_config": None}
            self.model = SentenceTransformer(
                MODEL_ID,
                device=self.device,
                model_kwargs={"torch_dtype": dtype},
                **kwargs,
            )
            self.model.max_seq_length = MAX_TOKENS
        except Exception as e:
            print(f"CRITICAL: failed to load {MODEL_ID}: {e}")
            raise RuntimeError(
                f"Failed to load {MODEL_ID}. EmbeddingGemma 2 needs sentence-transformers>=6.1, "
                "transformers>=5.20 and torchvision (its processor imports it even for text). "
                'Run: pip install -U "sentence-transformers[image]>=6.1" "transformers>=5.20". '
                f"Original error: {e}"
            ) from e

    # -- core encode -------------------------------------------------------
    def _batches(self, texts: list[str]) -> list[list[int]]:
        """Token-budgeted batching. Memory scales with (batch x padded length), so a
        fixed batch size either wastes the GPU on short queries or blows up RAM
        on long pages (16 x 2,048 tokens needs ~6 GB on CPU)."""
        est = [min(MAX_TOKENS, len(t) // 4 + 8) for t in texts]
        order = sorted(range(len(texts)), key=lambda i: -est[i])
        batches, cur, cur_max = [], [], 0
        for i in order:
            m = max(cur_max, est[i])
            if cur and (m * (len(cur) + 1) > TOKEN_BUDGET or len(cur) >= BATCH_SIZE * 8):
                batches.append(cur)
                cur, m = [], est[i]
            cur.append(i)
            cur_max = m
        if cur:
            batches.append(cur)
        return batches

    def _encode(self, texts: list[str]) -> np.ndarray:
        if not texts:
            return np.zeros((0, EMBED_DIM), dtype=np.float32)
        out = np.zeros((len(texts), EMBED_DIM), dtype=np.float32)
        with self._encode_lock:
            for batch in self._batches(texts):
                vecs = self.model.encode(
                    [texts[i] for i in batch],
                    batch_size=len(batch),
                    convert_to_numpy=True,
                    normalize_embeddings=True,
                    show_progress_bar=False,
                )
                out[batch] = np.asarray(vecs, dtype=np.float32)
        return out

    def embed_queries(self, queries: list[str], task: str = "search") -> np.ndarray:
        prefix = QUERY_PREFIXES.get(task, QUERY_PREFIXES["search"])
        return self._encode([prefix + (q or "").strip() for q in queries])

    def embed_documents(self, texts: list[str], titles: list[str | None] | None = None) -> np.ndarray:
        titles = titles or [None] * len(texts)
        return self._encode([format_document(t, ti) for t, ti in zip(texts, titles)])

    def count_tokens(self, text: str) -> int | None:
        """Exact token count of an already-formatted input (incl. special tokens)."""
        try:
            tok = getattr(self.model, "tokenizer", None)
            tok = getattr(tok, "tokenizer", tok)  # multimodal processors wrap the tokenizer
            return len(tok(text, add_special_tokens=True, truncation=False, verbose=False)["input_ids"])
        except Exception:
            return None

    def embed_document_detailed(self, text: str, title: str | None = None) -> tuple[np.ndarray, dict]:
        """One page, plus what the live crawl log shows: tokens, cut-off, timings.
        `queue_ms` is time spent waiting for another page's encode to finish."""
        doc = format_document(text, title)
        exact = self.count_tokens(doc)
        tokens = exact if exact is not None else len(doc) // 4 + 8
        t_wait = time.perf_counter()
        with self._encode_lock:
            t0 = time.perf_counter()
            vec = self.model.encode([doc], batch_size=1, convert_to_numpy=True,
                                    normalize_embeddings=True, show_progress_bar=False)[0]
            t1 = time.perf_counter()
        return np.asarray(vec, dtype=np.float32), {
            "tokens": int(tokens),
            "tokens_exact": exact is not None,
            "embedded_tokens": int(min(tokens, MAX_TOKENS)),
            "truncated": tokens > MAX_TOKENS,
            "max_tokens": MAX_TOKENS,
            "embed_ms": int((t1 - t0) * 1000),
            "queue_ms": int((t0 - t_wait) * 1000),
            "device": self.device,
        }

    def status(self) -> dict:
        return {
            "model": MODEL_ID,
            "tag": model_tag(),
            "dim": NATIVE_DIM,
            "default_analysis_dim": DEFAULT_ANALYSIS_DIM,
            "max_tokens": MAX_TOKENS,
            "device": self.device,
            "dtype": self.dtype_name,
            "token_budget": TOKEN_BUDGET,
            "loaded": self.model is not None,
        }


# -- module-level helpers ---------------------------------------------------
def embed_queries(queries: list[str], task: str = "search") -> np.ndarray:
    return GemmaEmbedder.get_instance().embed_queries(queries, task)


def embed_documents(texts: list[str], titles: list[str | None] | None = None) -> np.ndarray:
    return GemmaEmbedder.get_instance().embed_documents(texts, titles)


def embed_document_detailed(text: str, title: str | None = None) -> tuple[np.ndarray, dict]:
    return GemmaEmbedder.get_instance().embed_document_detailed(text, title)


def generate_embeddings(texts: list[str]):
    """Backwards-compatible shim: embeds untitled documents, returns lists."""
    return embed_documents(texts).tolist()


def embedder_status() -> dict:
    base = {
        "model": MODEL_ID,
        "tag": model_tag(),
        "dim": NATIVE_DIM,
        "default_analysis_dim": DEFAULT_ANALYSIS_DIM,
        "max_tokens": MAX_TOKENS,
        "loaded": False,
    }
    if GemmaEmbedder.is_loaded():
        base.update(GemmaEmbedder.get_instance().status())
    base["error"] = _LOAD_ERROR
    base["gpu"] = gpu_diagnostics()
    return base


_GPU_DIAG: dict | None = None


def gpu_diagnostics() -> dict:
    """Is there an NVIDIA GPU, and can PyTorch use it? The common failure is a
    CPU-only torch wheel from PyPI on a machine that has a perfectly good GPU."""
    global _GPU_DIAG
    if _GPU_DIAG is not None:
        return _GPU_DIAG
    import re
    import shutil
    import subprocess

    info: dict = {}
    try:
        import torch
        info["torch"] = torch.__version__
        info["torch_cuda"] = torch.version.cuda
        info["cuda_available"] = bool(torch.cuda.is_available())
        if info["cuda_available"]:
            info["gpu_name"] = torch.cuda.get_device_name(0)
            info["bf16"] = bool(torch.cuda.is_bf16_supported())
    except Exception as e:
        info["torch_error"] = str(e)

    smi = shutil.which("nvidia-smi")
    if not smi and os.name == "nt":
        cand = os.path.join(os.environ.get("SystemRoot", r"C:\Windows"), "System32", "nvidia-smi.exe")
        smi = cand if os.path.exists(cand) else None
    if smi:
        try:
            out = subprocess.run([smi], capture_output=True, text=True, timeout=8).stdout
            m = re.search(r"CUDA Version:\s*([0-9]+)\.([0-9]+)", out)
            if m:
                info["driver_cuda"] = f"{m.group(1)}.{m.group(2)}"
            names = subprocess.run([smi, "--query-gpu=name", "--format=csv,noheader"],
                                   capture_output=True, text=True, timeout=8).stdout.strip().splitlines()
            if names:
                info["nvidia_gpus"] = names
        except Exception as e:
            info["nvidia_smi_error"] = str(e)

    if info.get("nvidia_gpus") and not info.get("cuda_available"):
        major, minor = (int(x) for x in (info.get("driver_cuda") or "0.0").split("."))
        if major >= 13:
            index = "cu130"
        elif (major, minor) >= (12, 6):
            index = "cu126"
        else:
            index = None
        cpu_build = "+cpu" in str(info.get("torch", "")) or not info.get("torch_cuda")
        info["warning"] = (
            f"NVIDIA GPU found ({info['nvidia_gpus'][0]}) but PyTorch {info.get('torch')} is "
            + ("a CPU-only build" if cpu_build else "not able to use it")
            + ", so embeddings run on the CPU."
        )
        info["fix"] = (
            "powershell -ExecutionPolicy Bypass -File setup_gpu.ps1   (in vws-backend; installs the "
            + (index or "CUDA") + " build of torch + torchvision into the venv)"
            if index else
            f"Update the NVIDIA driver (it reports CUDA {info.get('driver_cuda')}; PyTorch needs 12.6+), then run setup_gpu.ps1."
        )
        info["index"] = index
    _GPU_DIAG = info
    return info


_LOAD_ERROR: str | None = None


def warmup() -> None:
    """Load the model in the background at startup so the first request isn't slow."""
    global _LOAD_ERROR
    try:
        GemmaEmbedder.get_instance()
        _LOAD_ERROR = None
    except Exception as e:  # surfaced via /api/embedder/status
        _LOAD_ERROR = str(e)
        print(f"[embedder] warmup failed: {e}")


def load_error() -> str | None:
    return _LOAD_ERROR
