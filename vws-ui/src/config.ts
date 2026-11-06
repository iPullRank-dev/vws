// Where the backend API lives.
// - Packaged app: Electron starts the backend on a free port and opens the UI as
//   index.html?api=http://127.0.0.1:<port>.
// - Dev: VITE_API_BASE, else the dev backend on port 8060.
function apiBase(): string {
  try {
    const q = new URLSearchParams(window.location.search).get('api');
    if (q) return q.replace(/\/$/, '');
  } catch {
    /* not in a browser */
  }
  return import.meta.env.VITE_API_BASE || 'http://localhost:8060';
}

export const API_BASE = apiBase();
