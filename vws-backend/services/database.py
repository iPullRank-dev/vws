import sqlite3
import sqlite_vec
import os

from services.vectors import setup_vector_tables

DB_PATH = os.environ.get("VWS_DB_PATH", "vws.sqlite")

def get_db():
    # Imports in one project run concurrently; a writer waits up to a minute for
    # another's transaction instead of failing with "database is locked".
    conn = sqlite3.connect(DB_PATH, timeout=60.0)
    conn.enable_load_extension(True)
    sqlite_vec.load(conn)
    conn.enable_load_extension(False)
    conn.row_factory = sqlite3.Row
    return conn

def setup_db():
    conn = get_db()
    cursor = conn.cursor()
    # Basic Application tables
    cursor.execute("""
        CREATE TABLE IF NOT EXISTS projects (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            name TEXT NOT NULL,
            domain TEXT,
            total_pages INTEGER DEFAULT 0,
            focus_score REAL DEFAULT 0.0,
            created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
        )
    """)
    
    cursor.execute("""
        CREATE TABLE IF NOT EXISTS pages (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            project_id INTEGER,
            url TEXT,
            title TEXT,
            content TEXT,
            source_type TEXT DEFAULT 'base',
            source_name TEXT DEFAULT '',
            FOREIGN KEY(project_id) REFERENCES projects(id)
        )
    """)
    
    # Additive migrations. Each ALTER is tried on its own so one existing
    # column doesn't stop the rest from being added.
    for ddl in (
        "ALTER TABLE pages ADD COLUMN source_type TEXT DEFAULT 'base'",
        "ALTER TABLE pages ADD COLUMN source_name TEXT DEFAULT ''",
        "ALTER TABLE pages ADD COLUMN volume REAL",
        # JSON: {source_name: {declared_model, column, dim, ...}} for CSV-supplied vectors.
        "ALTER TABLE projects ADD COLUMN vector_sources TEXT",
        # JSON project settings, e.g. {"analysis_dim": 256}
        "ALTER TABLE projects ADD COLUMN settings TEXT",
    ):
        try:
            cursor.execute(ddl)
        except sqlite3.OperationalError:
            pass  # Column already exists
    cursor.execute("CREATE INDEX IF NOT EXISTS idx_pages_project ON pages(project_id, source_type)")
        
    cursor.execute("""
        CREATE TABLE IF NOT EXISTS links (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            project_id INTEGER,
            source_url TEXT,
            target_url TEXT,
            link_type TEXT,
            anchor_text TEXT DEFAULT '',
            UNIQUE(project_id, source_url, target_url, link_type)
        )
    """)
    
    for ddl in (
        "ALTER TABLE links ADD COLUMN anchor_text TEXT DEFAULT ''",
        # Which uploaded file created the row, so one file can be removed or re-imported on its own.
        "ALTER TABLE links ADD COLUMN upload_id INTEGER",
        "ALTER TABLE pages ADD COLUMN upload_id INTEGER",
        # Per-link metadata from backlink tools (DR, nofollow, spam, context basis...), JSON.
        "ALTER TABLE links ADD COLUMN meta TEXT",
    ):
        try:
            cursor.execute(ddl)
        except sqlite3.OperationalError:
            pass

    # Every uploaded CSV, kept on disk (see services/uploads.py) so the project's
    # data sources survive page reloads, restarts and re-imports.
    cursor.execute("""
        CREATE TABLE IF NOT EXISTS uploads (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            project_id INTEGER NOT NULL,
            kind TEXT NOT NULL,
            source_name TEXT NOT NULL DEFAULT '',
            filename TEXT NOT NULL DEFAULT '',
            stored_path TEXT,
            bytes INTEGER DEFAULT 0,
            options TEXT,
            status TEXT NOT NULL DEFAULT 'queued',
            message TEXT DEFAULT '',
            created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
            finished_at TIMESTAMP,
            heartbeat_at REAL
        )
    """)
    for ddl in ("ALTER TABLE uploads ADD COLUMN heartbeat_at REAL",
                # What the import did: rows read, added, skipped by reason (JSON).
                "ALTER TABLE uploads ADD COLUMN stats TEXT",
                # Content hash, to recognise the same file uploaded twice.
                "ALTER TABLE uploads ADD COLUMN sha1 TEXT"):
        try:
            cursor.execute(ddl)
        except sqlite3.OperationalError:
            pass
    cursor.execute("CREATE INDEX IF NOT EXISTS idx_uploads_project ON uploads(project_id)")
    cursor.execute("CREATE INDEX IF NOT EXISTS idx_pages_upload ON pages(upload_id)")
    # Links are joined to pages by URL; backlink exports bring tens of thousands of rows.
    cursor.execute("CREATE INDEX IF NOT EXISTS idx_pages_url ON pages(project_id, url)")
    cursor.execute("CREATE INDEX IF NOT EXISTS idx_links_upload ON links(upload_id)")
    
    # Legacy 300-d vector table (pre EmbeddingGemma 2). Still created so old
    # projects keep loading; new vectors go to page_vectors.
    cursor.execute("""
        CREATE VIRTUAL TABLE IF NOT EXISTS vec_embeddings USING vec0(
            embedding float[300]
        )
    """)
    setup_vector_tables(cursor)
    
    cursor.execute("""
        CREATE TABLE IF NOT EXISTS embeddings (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            page_id INTEGER,
            vec_id INTEGER,
            FOREIGN KEY(page_id) REFERENCES pages(id)
        )
    """)

    # Cached AI rewrite briefs so the user doesn't pay the 30–90s generation cost
    # every time the modal is reopened. One brief per (project, keyword, url).
    cursor.execute("""
        CREATE TABLE IF NOT EXISTS rewrite_briefs (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            project_id INTEGER NOT NULL,
            keyword TEXT NOT NULL,
            url TEXT NOT NULL,
            brief_text TEXT NOT NULL,
            body_chars INTEGER DEFAULT 0,
            fetched_realtime INTEGER DEFAULT 0,
            created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
            updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
            UNIQUE(project_id, keyword, url),
            FOREIGN KEY(project_id) REFERENCES projects(id)
        )
    """)

    # Action Plan status tracking: one row per (project, deterministic action key).
    cursor.execute("""
        CREATE TABLE IF NOT EXISTS action_state (
            project_id INTEGER NOT NULL,
            action_key TEXT NOT NULL,
            status TEXT NOT NULL DEFAULT 'open',
            note TEXT DEFAULT '',
            updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
            PRIMARY KEY (project_id, action_key)
        )
    """)

    # Crawl log: every event the live crawl screen shows, so the table survives
    # a refresh and can be exported after the crawl.
    cursor.execute("""
        CREATE TABLE IF NOT EXISTS crawl_log (
            project_id INTEGER NOT NULL,
            seq INTEGER NOT NULL,
            data TEXT NOT NULL,
            created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
            PRIMARY KEY (project_id, seq)
        )
    """)

    try:
        cursor.execute("PRAGMA journal_mode=WAL")
    except sqlite3.OperationalError:
        pass

    conn.commit()
    conn.close()
