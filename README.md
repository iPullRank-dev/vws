# VWS: Vector Web Scanner & SEO Analytics Platform

VWS is a local-first desktop app for relevance engineering. It crawls a site (Playwright + Trafilatura) or imports a Screaming Frog export, embeds pages and target queries with Google's **EmbeddingGemma 2**, and turns the vector math into a ranked list of things to do: what to create, which page to optimize for which queries, which pages cannibalize each other, which internal links to add (with anchors), and what to prune. The Relevance Lab then scores any page passage by passage against a query and its fan-out, so you can test a rewrite before it ships.

---

## What's new (EmbeddingGemma 2 + Action layer)

* **EmbeddingGemma 2** (`google/embeddinggemma-2`, Apache 2.0, Oct 2026) replaces `embeddinggemma-300m`. Only the 270M text backbone is loaded (vision/audio encoders off).
* **Task prompts.** Queries are embedded as `task: search result | query: …` and pages as `title: … | text: …`, as the model card requires. The old code sent neither.
* **Full 768-d vectors.** The old code cut vectors to 300 dims (not a supported Matryoshka size) without re-normalizing. Vectors now live in `page_vectors`, tagged with the model that made them, so the app can refuse to compare across embedding spaces.
* **Action Plan** tab (the new default): ranked create / expand / optimize / de-cannibalize / consolidate / internal-link / fix-link / prune / competitor-gap tasks, each with evidence, steps, impact and effort, status + notes saved per project, CSV and Markdown export, and a one-click hand-off to the Lab.
* **Relevance Lab** tab: head query + fan-out sub-queries x passages heatmap, per-query verdicts, competitor comparison, edit-and-re-score, and AI briefs grounded in those measurements.
* **Ghost keyword locator** on the 3D map now embeds the query and projects it into the same PCA space (it used to be drawn at a fixed offset from the centroid), and lists the closest pages.
* **Calibrated thresholds.** Defaults for EmbeddingGemma 2 were measured on ~1,000 real queries against ipullrank.com pages (strong ≥ 0.76, gap < 0.66). For any other vector source the app falls back to percentiles of the project's own distribution. All thresholds are editable against a live histogram in the Action Plan.
* **Cannibalization fix.** The old rule (top-2 distance gap < 0.05) flagged almost every keyword; on real data the median gap is ~0.014. It now requires both pages to be real candidates and a margin of 0.01.

### Every view now ends in a decision

Each analysis view has a short "How to read this" panel and a recommendation per page or topic. Clicking any page anywhere opens the same diagnosis drawer (zone, topic, hub, queries, neighbors, links, open actions, plus buttons for the Lab, the Bullseye and a brief).

| View | What it tells you to do |
|---|---|
| **Site Focus** (was IQR Bullseye) | Pages are placed by distance from your site's center, with rings at your own Q1 / Q3 / outlier fence. Zone cards say what each zone means; the table lists Expansion and Peripheral pages with a verdict: Core asset, Optimize, Strengthen, Connect, Supporting page, or a strategic call on the whole topic. |
| **Query Bullseye** | Put a query (or a page) at the center. Rings are the strong and gap thresholds. A query gets *Covered / Contested / Partial / Gap* with the page that should own it; a page gets its near-duplicates and the closest pages it doesn't link to. |
| **Topic Clusters** (was Intertopic map) | Ward clusters of your pages, each with a hub, the queries it serves, the uncovered queries closest to it, and whether spokes link to the hub. Verdicts: Wire up hub and spokes, Expand this topic, Optimize existing pages, Healthy topic. |
| **3D Map** | Color by dataset, topic or zone; click a point to diagnose it; locate any query. |
| **Semantic Drift** | Does each page stay on its subject? Three checks against the project's own spread: distance from the site's center, fit to its own topic (or a better fit elsewhere), and whether the page reads as an answer to its own title (the title is embedded as a query). Verdicts: Doesn't match its title, Off-topic page, Drifted from its topic, Secondary topic (a group of similar far pages such as /case-studies/, fine if deliberate), On topic. Scatter of distance vs title match, plus a "see where it drifts" button that opens the page in the Lab. |
| **Content Gaps / Link Opportunities** | Filtered Action Plans (create + competitor gap; internal + weak links). Internal-link rows have a **where?** button that finds the best passage on the source page and the sentence to put the link in. |
| **Link Graph** | Internal and external links on a map where position = topic and lines = links, colored by relevance (similarity of the two pages, banded against the site's own page pairs). Nav/footer and template links (archives, bylines, category tags) are separated from editorial links. A 0-100 **link relevance score**: 0 = links are no more relevant than random, 100 = every link goes to the most related page (internal links equity-weighted with PageRank; backlinks weighted by authority, quality and follow; the two averaged). Lists the off-topic links carrying the most equity (with a better target and **where?**), pages that win queries but get no relevant links, topics by link relevance, and backlinks by relevance. |
| **Internal Link Health** | Every target page: Orphan, Under-linked, Diluted, Missing related links, or Healthy, with suggested source pages. |
| **Backlink Relevance** | Linking pages scored against the page they point to: priority, topical, off-topic. |
| **Intersection** | Compare any two pages / queries: verdict (near-duplicates, competing, related, distinct), shared queries with a suggested owner, link direction, and a section-by-section passage comparison. Suggested pairs come from the Action Plan. |

### Relevance Lab: AI rewrites you accept or reject

**Suggest rewrites** asks the local LLM (`VWS_LLM_MODEL`) to rewrite the best passage for each query the page doesn't cover yet; the ✨ button on any passage rewrites it for the selected query. Each rewrite is embedded and scored before you see it: a before/after score for every query, a redline of the changes, and a verdict (Improves / Mixed / No gain, where Mixed means another query drops). Facts the model doesn't have come back as `[add: …]` placeholders instead of invented numbers. **Accept**, **Accept & edit**, **Reject** or **Another version**; accepted rewrites become normal edits, so **Re-score** shows the effect on the whole page. In the heatmap, columns are numbered §1…§n, the cell you click stays outlined and the matching passage card is highlighted, and hovering a cell shows the passage and its score.

### Live crawl log

The crawl screen's log is a sortable, filterable table (CSV export, click a row for details) with, per page: status (Embedded / Warning / Skipped / Error) and the reason; HTTP status, redirects and final URL; TTFB, load time, DNS/connect/TLS, HTML size, server and cache headers; tokens embedded (and whether the page was cut off at `VWS_EMBED_MAX_TOKENS`), embed time; similarity to the center of the pages crawled so far, the closest page so far, and near-duplicate / far-from-core flags. The log is saved, so a refresh rebuilds it. Hovering the live embeddings plot shows each page's path.

### Uploaded files are kept

Every CSV you upload into a project (crawl export, competitor crawl, keywords, internal links, backlinks) is saved under `vws-backend/uploads/project_<id>/` and listed in the sidebar's **Uploaded files** panel, which reads from the database, so it survives page reloads and backend restarts. Each file shows a live status: *uploading* (transfer %), *queued* (imports in a project run one at a time), *processing* (current step and progress), *loaded* (rows added, and any still without vectors), *failed* (with the reason) or *interrupted* (the backend stopped mid-import; detected by a heartbeat, so a second backend instance never flags another's work). Every row a file creates is tagged with it, so you can **Remove** one file and only its data (files of the same type are replayed to restore anything they shared), **Re-import** it from the saved copy, or download the file again. Data imported before this feature still appears, marked as imported before file tracking.

### Backlink imports (Ahrefs, Semrush, GSC)

Backlink exports are read by column name, so an Ahrefs *Backlinks* export works as is (Referring page URL, Target URL, Anchor, Left/Right context, Domain rating, Nofollow, Is spam, Lost status...). Lost links and links between your own pages are skipped, and target URLs are matched to the crawl ignoring `www`, `http/https` and trailing slashes. Each referring page becomes a vector: the strongest ones (by follow, not spam, DR and traffic, up to `VWS_MAX_SYNTH_FETCH`) are fetched and embedded in full; the rest are embedded from their title, the text around the link and Ahrefs' page category, and the Link Graph says which basis each score uses. Referring pages are kept out of the site center, zones, focus score and 3D map, so a large export doesn't swamp your own content. Every backlink is scored against **the page it links to**: the similarity of the linking page to that page, banded with the same cut-offs as internal links, plus a note when the linking page is closer to another page of yours. Each backlink also gets a **value** from the export: authority (the linking page's referring domains, log scale, blended with its site's DR) × quality (the linking page's search traffic and ranking keywords; pages with none still count at 40%) × follow (nofollow/UGC/sponsored 0.3, spam 0). A domain counts once, at its strongest link, so a blog network with thousands of links weighs what its best link weighs. The **Link relevance score** is then the average of the internal score and a backlink score built the same way: value-weighted similarity of each linking page to the page it links to, against the same linking pages pointed at random pages of yours (0) and at their most related page (100). In the graph, each linking domain is a diamond beside the page it links to most, farther out the less related it is; size = authority, fill = search visibility, outline = relevance. The Link Graph also lists your most-linked URLs that aren't in the crawl, which usually means the crawl limit cut them off. Backlinks imported before these fields existed are refreshed from the saved file the first time the Link Graph opens (a few seconds, nothing is re-embedded). The upload's status line says how many rows were added, skipped (and why), and whether the same file was already loaded.

### Vector size (Matryoshka)

EmbeddingGemma 2 vectors can be cut to 512, 256 or 128 dims. VWS always stores the full 768 and truncates at analysis time, so you can switch size per project from the sidebar without re-embedding. Thresholds are re-calibrated for each size.

We tested whether 256 is good enough on ipullrank.com (156 pages, 999 queries, and the passages of the 8 longest pages), comparing each size with 768:

| Agreement with 768 | 512 | 256 | 128 |
|---|---|---|---|
| Same best page per query | 86% | 68% | 49% |
| Same best page when 768 has a clear winner | 100% | 98% | 79% |
| 768's best page in the top 3 | 97% | 88% | 68% |
| Same coverage band (strong / partial / gap) | 96% | 90% | 82% |
| Same top-3 neighbors per page (link suggestions) | 91% | 82% | 63% |
| Same best passage in the Lab | 80% | 58% | 34% |
| Same cannibalization pairs (Jaccard) | 0.68 | 0.56 | 0.39 |

256 holds up for clear-cut decisions but changes about a third of page-to-query assignments where two pages are close (exactly the cannibalization and "which page should own this" cases) and picks a different Lab passage 4 times in 10. So **768 stays the default**. 512 is a reasonable choice for very large sites; 256 and 128 are for quick exploration.

---

## Screaming Frog embeddings

Screaming Frog can generate embeddings with any model, and it writes them to the CSV as text (comma-separated floats). VWS parses that text, but **it needs to know which model produced it**, because vectors from different models live in unrelated spaces.

When you upload a CSV, VWS detects the vector column and its dimension, then asks you to:

1. **Use the embeddings in the CSV** and pick the model you configured in Screaming Frog (EmbeddingGemma 2 / 1, OpenAI `text-embedding-3-small` / `-large`, `gemini-embedding-001`, or type another), or
2. **Re-embed locally with EmbeddingGemma 2**, which fetches each page's text and embeds it here.

What happens next:

* Declared **EmbeddingGemma 2** at the same dimension: the vectors share a space with local keyword and Lab embeddings. VWS verifies the claim on import by embedding a sample of page titles locally and comparing them with their CSV vectors (same model ≈ 0.6+, different model ≈ 0). If the check fails, the vectors are stored as `unverified:` and keyword actions are blocked until you fix the label or re-embed.
* Declared **any other model**: page-to-page views (map, bullseye, drift, duplicates, links) work, but keyword mapping, the ghost locator and keyword actions need the same model on both sides, so the project asks you to re-embed.
* You can re-embed any project later from the Action Plan banner or the sidebar.

---

## 🛠️ Tech Stack
* **Frontend:** React, Vite, Electron, Plotly 3D, ECharts, React-Force-Graph
* **Backend:** Python, FastAPI, Uvicorn, SQLite
* **ML Inference:** PyTorch, Sentence-Transformers 6.1+ (`google/embeddinggemma-2`), scikit-learn, SciPy
* **Scraping Engine:** Playwright (Chromium), Scrapling, Trafilatura

---

## ⚙️ Prerequisites
1. **[Node.js](https://nodejs.org/en/)** (v18 or higher)
2. **[Python 3.10+](https://www.python.org/downloads/)**
3. **[Git](https://git-scm.com/)**

---

## 🚀 Installation

### 1. Backend (`vws-backend`)
```bash
cd vws-backend
python -m venv venv
venv\Scripts\activate        # Windows
source venv/bin/activate     # Mac/Linux
pip install -r requirements.txt
playwright install chromium
```

### Upgrading an existing install to EmbeddingGemma 2
EmbeddingGemma 2 needs newer libraries than the original build (sentence-transformers 6.1+, transformers 5.20+, and torchvision, which the model's processor imports even for text):
```bash
cd vws-backend
venv\Scripts\activate
pip install -U "sentence-transformers[image]>=6.1" "transformers>=5.20"
```
The first start downloads the model (~1.5 GB) from Hugging Face. It isn't gated, so no token is needed. Existing projects keep working on their old 300-d vectors and show a **Re-embed with EmbeddingGemma 2** button; your SQLite file is migrated in place (new tables/columns only).

**Titles from earlier crawls.** With trafilatura 2.x the crawler (and the Lab/re-embed fetcher) lost every page title, so pages crawled before this fix carry a title made from the URL ("Chapter 5", "Services"). That weakens topic labels, Drift's title check and the embeddings themselves (the title is part of what gets embedded). Re-crawl those projects to pick up real titles.

### Using your NVIDIA GPU (CUDA)
VWS uses the GPU automatically (bfloat16, larger batches) whenever PyTorch can see it. A plain `pip install torch` on Windows installs the **CPU-only** build, so on most machines you need to swap it once:
```powershell
cd vws-backend
powershell -ExecutionPolicy Bypass -File setup_gpu.ps1
```
The script reads your driver's CUDA version from `nvidia-smi`, reinstalls `torch` + `torchvision` from the matching pytorch.org index (cu130 or cu126), and prints whether CUDA is now available. If the backend starts on CPU while an NVIDIA GPU is present, it says so in the console and in the sidebar, with the exact command to run.

### 2. Frontend (`vws-ui`)
```bash
cd vws-ui
npm install
```

---

## 💻 Running the app

### The installed app (Windows)

1. Run `VWS Setup 1.0.0.exe` (from `vws-ui\release` after a build, or from the repo's GitHub release). It isn't code-signed, so the first time Windows SmartScreen asks: choose **More info → Run anyway**.
2. After the files are copied, a console window titled **VWS setup** installs PyTorch (the CUDA build if you have an NVIDIA GPU, otherwise the CPU build), the Python packages and the crawler's browser, then downloads the models. That's about 13 GB on a CPU machine and 16 GB with a GPU, so leave it running; it closes when it's done.
3. Open **VWS** from the Start menu or the desktop shortcut. The window shows "Starting the analysis engine…" for a few seconds while the backend loads, then the project dashboard.

If the setup window was closed early or a download failed, VWS finishes setup the next time it opens, with a progress screen and **Try again** / **Open logs** buttons; it picks up where it stopped.

| | Where |
|---|---|
| The app | `%LOCALAPPDATA%\Programs\VWS\VWS.exe` (unless you picked another folder) |
| Projects (`vws.sqlite`, `uploads\`) | `%LOCALAPPDATA%\VWS` |
| Models and Python runtime | `%LOCALAPPDATA%\VWS\models`, `%LOCALAPPDATA%\VWS\runtime` |
| Logs (`setup.log`, `backend.log`) | `%LOCALAPPDATA%\VWS\logs` |

- **Bring over projects from the dev setup:** close VWS, then copy `vws-backend\vws.sqlite` (and `vws-backend\uploads`) into `%LOCALAPPDATA%\VWS`.
- **Switch from CPU to GPU** after installing or updating an NVIDIA driver: run `"%LOCALAPPDATA%\Programs\VWS\VWS.exe" --setup`.
- **Uninstall** from Windows Settings → Apps. It asks whether to delete the downloaded models and runtime; your projects are kept either way.

### From source (development)

Do the [installation](#-installation) steps first (backend venv + `npm install`). Then use one of these, not both, since each starts a backend on port 8060:

**Desktop window** (one command):
```powershell
cd vws-ui
npm run dev
```
This opens the Electron window and starts the backend from `vws-backend\venv` on port 8060 with auto-reload, so edits to the backend or the UI apply without a restart. Backend output goes to the same terminal and to `%LOCALAPPDATA%\VWS\logs\backend.log`.

**Browser** (backend in its own terminal, handy for debugging it):
```powershell
# terminal 1
cd vws-backend
venv\Scripts\activate
python main.py                 # http://localhost:8060 (API docs at /docs)

# terminal 2
cd vws-ui
npm run dev:web                # open http://localhost:5173
```

Either way the dev app uses `vws-backend\vws.sqlite` and the model cache in your user profile, so it doesn't share projects with the installed app. The backend loads EmbeddingGemma 2 in the background at startup; the sidebar shows the model, vector size and device (cpu or cuda) once it's ready.

### Environment variables
| Variable | Default | What it does |
|---|---|---|
| `VWS_EMBED_MODEL` | `google/embeddinggemma-2` | Any sentence-transformers model. Set it to the model you used in Screaming Frog if you want local keywords to match CSV page vectors. Calibrated thresholds only apply to EmbeddingGemma 2. |
| `VWS_EMBED_DIM` | `768` | Default analysis size for projects without their own setting: 768, 512, 256 or 128. Vectors are always stored at 768, so no re-embed is needed; each project can override it in the sidebar. |
| `VWS_EMBED_MAX_TOKENS` | `2048` | Context per text (model max 8192). The Lab's page score only sees this many tokens of a long page. On a GPU, 8192 embeds long pages whole. |
| `VWS_EMBED_TOKEN_BUDGET` | 8192 CPU / 32768 CUDA | Tokens per forward pass. Lower it if you run out of RAM / VRAM. |
| `VWS_FETCH_WORKERS` | `8` | Parallel page fetches during import / re-embed. |
| `VWS_MAX_SYNTH_FETCH` | `200` | Max link-only URLs (e.g. backlink referring pages) fetched for full content; the rest are scored from title + link context. |
| `VWS_UPLOAD_DIR` | `vws-backend/uploads` | Where uploaded CSVs are kept. |
| `VWS_DB_PATH` | `vws.sqlite` (in the backend folder) | The project database. |
| `VWS_HOST` / `VWS_PORT` / `VWS_RELOAD` | `0.0.0.0` / `8060` / `1` | Where `python main.py` listens, and whether it reloads on code changes. |
| `VWS_LLM_MODEL` | `google/gemma-4-E2B-it` | Local LLM for AI insights and rewrite briefs. |

---

## 📦 Building the Windows installer

The desktop app ships as an NSIS installer built with electron-builder. The installer is small (about 150 MB): it carries the Electron app, the backend source and a self-contained Python. Everything heavy is set up on the user's machine by `vws-backend/setup_runtime.py`, which the installer runs right after copying the files (a console window shows the progress):

1. copies the bundled Python to `%LOCALAPPDATA%\VWS\runtime\python`,
2. installs the Microsoft Visual C++ runtime if it's missing (PyTorch needs it; Windows asks for permission),
3. checks for an NVIDIA GPU with `nvidia-smi`: a driver with CUDA 13+ gets the `cu130` build of PyTorch, CUDA 12.6-12.9 gets `cu126`, anything else (or no GPU) gets the CPU build,
4. installs the backend packages from `requirements.txt`, pinned by `constraints.txt` (versions from the working dev venv),
5. installs Chromium's headless shell for the crawler,
6. downloads the models into `%LOCALAPPDATA%\VWS\models`: EmbeddingGemma 2 (1.5 GB) and Gemma 4 E2B for rewrite suggestions (10.3 GB). Neither model needs a Hugging Face token; set `HF_TOKEN` before installing only if you hit download rate limits.

Plan on about 13 GB of downloads and disk on a CPU machine and 16 GB with an NVIDIA GPU (most of it is the LLM). Every step is skipped when it's already done, so a re-run resumes where an interrupted install stopped. If setup can't finish during install (offline, not enough disk), the app runs it again with a progress screen the next time it opens, with **Try again** and **Open logs** buttons.

When the app starts it launches the backend from `%LOCALAPPDATA%\VWS\runtime` on a free local port (127.0.0.1 only) with the models in offline mode, so there are no network checks or token warnings, and waits for `/api/health` before showing the UI. Projects live in `%LOCALAPPDATA%\VWS` (`vws.sqlite`, `uploads\`), so updates and reinstalls keep them. Logs are in `%LOCALAPPDATA%\VWS\logs` (`setup.log`, `backend.log`). Uninstalling asks whether to delete the downloaded runtime and models; projects are always kept.

**Build it** (on Windows, from `vws-ui`):

```powershell
npm install          # once, after pulling (package.json changed)
npm run dist         # → release\VWS Setup <version>.exe
```

`npm run dist` builds the UI and the Electron main process, downloads the Python build (python-build-standalone, Python 3.13, x64) into `build-resources\python` the first time, and packages the installer. `npm run dist:dir` builds the unpacked app only (`release\win-unpacked`), which is quicker for testing. The installer isn't code-signed, so Windows SmartScreen will warn the first time it runs ("More info" → "Run anyway"). `win.signAndEditExecutable` is off in `package.json` because the signing tools electron-builder downloads contain symlinks, which Windows only lets you create with Developer Mode on (Settings → System → For developers) or from an admin terminal; turn Developer Mode on and set it back to `true` once VWS has an icon or a signing certificate.

**Useful switches**

| | |
|---|---|
| `VWS.exe --setup` | Re-run setup (for example after updating the NVIDIA driver, to switch from the CPU to the GPU build). |
| `VWS.exe --setup-force` | Re-run every step and reinstall PyTorch. |
| `python setup_runtime.py --gpu cpu` | Force the CPU build (`--gpu cuda` to require the GPU build). |
| `python setup_runtime.py --skip-llm` | Skip the 10 GB LLM; rewrite suggestions won't work until it's downloaded. |
| `VWS_TORCH_INDEX` | Use a different PyTorch wheel index. |

**Bring your existing projects over:** close the app, then copy `vws-backend\vws.sqlite` (and the `vws-backend\uploads` folder) into `%LOCALAPPDATA%\VWS`.

**After upgrading packages in the dev venv**, refresh the pins so installs match: `venv\Scripts\python.exe -m pip freeze --exclude torch --exclude torchvision > constraints.txt`.

## 🧪 Workflows

**Start in the Action Plan.** Upload a crawl (or Screaming Frog CSV), then a keyword CSV (a `Keyword` column, plus `Search Volume` if you have it; volume weights the ranking). Optional: competitor page CSVs and Screaming Frog "All Inlinks" for the internal link graph.

* **Coverage + thresholds:** each query's best-page similarity is plotted as a histogram. Edit the gap / strong values (or the cannibalization margin and link similarity) and the plan recomputes.
* **Tasks:** expand a row for the steps, the queries with their similarities (and the best competitor page, if loaded), link sources with suggested anchors, and buttons to open the task in the Lab, generate an AI brief, or copy it as a Markdown ticket. Mark tasks in progress, done or skipped and leave notes; both persist.
* **Export:** CSV for trackers, Markdown for briefs and tickets. Exports respect the current filters.

**Relevance Lab.** Enter a head query plus its fan-out sub-queries (one per line), a URL (or paste a draft), and up to three competitor URLs. You get page and best-passage scores per query with a Covered / Partial / Missing verdict, a heatmap of where each query is answered on the page, and the competitor's best passage per query. Edit any passage and re-score; only the changed passages (and the page as a whole) are re-embedded. "AI brief from this evidence" sends the scores and weakest passages to the local LLM so the brief targets what's actually missing.

**3D Topical Map.** Type a query in *Locate a query* and press Enter to drop it into the map at its real position and list the nearest pages.

**Site Structure → Query & Content → Links.** The sidebar groups the analysis views in the order you'd usually work: check the site's shape (Site Focus, Topic Clusters), then query coverage (Query Bullseye, Content Gaps, Intersection), then links. Zones use the project's own IQR fences instead of fixed cut-offs, since raw distances differ by model and vector size.

## License

Copyright 2026 iPullRank

Licensed under the Apache License, Version 2.0 (the "License"); you may not use this project except in compliance with the License. You may obtain a copy of the License in [LICENSE](LICENSE) or at http://www.apache.org/licenses/LICENSE-2.0.

Unless required by applicable law or agreed to in writing, software distributed under the License is distributed on an "AS IS" BASIS, WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied. See the License for the specific language governing permissions and limitations under the License.
