# =============================================================
# database.py — Data Access Layer
# =============================================================
#
# This module owns ALL interactions with the SQLite database.
# No other module imports sqlite3 or calls sqlite3.connect().
#
# Design pattern: Repository Pattern (simplified)
#   Each function represents one clearly named data operation.
#   The calling code (app.py routes) never writes SQL directly.
#   This means:
#     - SQL is tested and changed in one place only
#     - Switching from SQLite to PostgreSQL requires changes
#       only in this file
#     - Every query is visible and auditable in one location
#
# Connection strategy:
#   We use a new connection per request rather than a
#   persistent pool. SQLite does not benefit from connection
#   pooling the way PostgreSQL does — each write locks the
#   file anyway. A per-request connection is simpler and safer.
#
# Row factory:
#   conn.row_factory = sqlite3.Row allows column access by
#   name (row['amount']) instead of index (row[2]).
#   This prevents bugs from column order changes.
# =============================================================

import sqlite3
import base64
import os
from datetime import datetime


# -------------------------------------------------------------
# Configuration
# -------------------------------------------------------------

BASE_DIR = os.path.dirname(os.path.abspath(__file__))
DATABASE = os.path.join(BASE_DIR, 'budget.db')


# -------------------------------------------------------------
# Connection Factory
# -------------------------------------------------------------

def get_db():
    """
    Open and return a SQLite connection with row_factory set.

    Why not a global connection?
        A global connection shared across requests in a
        multi-threaded server (gunicorn, waitress) would cause
        race conditions. Per-request connections are thread-safe.

    Why not Flask's g object?
        Flask's g is the correct pattern for request-scoped
        resources in a full Flask app. We use a simpler approach
        here because this is a single-user application and the
        database functions are called directly from routes.
        If this were to scale to multi-user, migrating to
        Flask-SQLAlchemy with proper session management would
        be the next step.
    """
    conn = sqlite3.connect(DATABASE)
    conn.row_factory = sqlite3.Row

    # Enable WAL mode for better concurrent read performance.
    # WAL (Write-Ahead Logging) allows reads while a write
    # is in progress. Default journal mode blocks all reads
    # during writes.
    conn.execute("PRAGMA journal_mode=WAL")

    # Enforce foreign key constraints.
    # SQLite does NOT enforce foreign keys by default.
    # This PRAGMA must be set on every connection.
    conn.execute("PRAGMA foreign_keys=ON")

    return conn


# -------------------------------------------------------------
# Schema Initialisation
# -------------------------------------------------------------

def init_db():
    """
    Create all tables and indexes if they do not exist.
    Safe to call on every application startup (IF NOT EXISTS).

    Schema decisions documented inline.
    """
    with get_db() as conn:
        conn.executescript('''

            -- ── purchases ─────────────────────────────────────
            -- Core table. Every expense is one row.
            --
            -- date as TEXT (YYYY-MM-DD):
            --   SQLite has no native DATE type. Storing as
            --   ISO-8601 text allows lexicographic sorting
            --   to work correctly (ORDER BY date DESC).
            --
            -- amount as REAL:
            --   Floating point is acceptable for display.
            --   We round to 2 decimal places on insert.
            --   For accounting systems, INTEGER paise (×100)
            --   would be more precise — documented as known
            --   trade-off.
            --
            -- photo as BLOB:
            --   Images stored in DB for zero-configuration
            --   simplicity. Trade-off: inflates DB file size.
            --   Production alternative: store path to S3/disk.
            --
            -- created_at:
            --   Audit timestamp separate from the expense date.
            --   Allows detecting backdated entries.

            CREATE TABLE IF NOT EXISTS purchases (
                id          INTEGER PRIMARY KEY AUTOINCREMENT,
                date        TEXT    NOT NULL,
                business    TEXT    NOT NULL,
                amount      REAL    NOT NULL CHECK(amount > 0),
                category    TEXT    NOT NULL,
                description TEXT,
                photo       BLOB,
                created_at  TEXT    NOT NULL
                            DEFAULT (strftime('%Y-%m-%dT%H:%M:%S', 'now'))
            );

            -- Index on date: most queries ORDER BY or filter on date.
            -- Without this index, every query is a full table scan.
            CREATE INDEX IF NOT EXISTS idx_purchases_date
                ON purchases(date);

            -- Index on category: GROUP BY category queries
            -- (used by /api/category-totals) benefit from this.
            CREATE INDEX IF NOT EXISTS idx_purchases_category
                ON purchases(category);

            -- Composite index for month-based category queries.
            -- Covers: WHERE strftime('%Y-%m', date) = ? AND category
            CREATE INDEX IF NOT EXISTS idx_purchases_date_category
                ON purchases(date, category);


            -- ── budgets ───────────────────────────────────────
            -- Monthly spending limits per category.
            -- Used by Phase 3 health score and burn rate.
            --
            -- UNIQUE on category: one budget per category.
            -- INSERT OR REPLACE handles upsert behaviour.

            CREATE TABLE IF NOT EXISTS budgets (
                id          INTEGER PRIMARY KEY AUTOINCREMENT,
                category    TEXT    NOT NULL UNIQUE,
                amount      REAL    NOT NULL CHECK(amount > 0),
                created_at  TEXT    NOT NULL
                            DEFAULT (strftime('%Y-%m-%dT%H:%M:%S', 'now'))
            );


            -- ── achievements ──────────────────────────────────
            -- Unlocked achievements per user action.
            -- Scaffolded here; populated in Phase 4.
            --
            -- key: unique string identifier for each achievement
            --      e.g. "first_expense", "century", "budget_guardian"
            -- unlocked_at: ISO-8601 timestamp

            CREATE TABLE IF NOT EXISTS achievements (
                id          INTEGER PRIMARY KEY AUTOINCREMENT,
                key         TEXT    NOT NULL UNIQUE,
                title       TEXT    NOT NULL,
                description TEXT,
                unlocked_at TEXT    NOT NULL
                            DEFAULT (strftime('%Y-%m-%dT%H:%M:%S', 'now'))
            );

        ''')


# =============================================================
# PURCHASES — Read Operations
# =============================================================

def get_purchases_paginated(page=1, limit=20):
    """
    Return one page of purchases ordered by date descending.

    Photos are NOT included in this response.
    Fetch photos separately via get_purchase_photo(id).

    Why exclude photos?
        The transactions table only needs metadata.
        Including BLOB data in a list response sends megabytes
        of image data on every page load — a major performance
        problem in the original implementation.

    Returns dict with keys:
        purchases (list of dicts)
        total     (int)   — total record count across all pages
        page      (int)   — current page number
        pages     (int)   — total page count
    """
    offset = (page - 1) * limit

    with get_db() as conn:
        total = conn.execute(
            "SELECT COUNT(*) FROM purchases"
        ).fetchone()[0]

        rows = conn.execute(
            """
            SELECT
                id,
                date,
                business,
                amount,
                category,
                description,
                CASE WHEN photo IS NOT NULL THEN 1 ELSE 0 END AS has_photo
            FROM purchases
            ORDER BY date DESC, id DESC
            LIMIT ? OFFSET ?
            """,
            (limit, offset)
        ).fetchall()

    return {
        "purchases": [dict(row) for row in rows],
        "total":     total,
        "page":      page,
        "pages":     max(1, -(-total // limit)),  # ceiling division
    }


def get_purchase_photo(purchase_id):
    """
    Return the base64-encoded photo for a single purchase.
    Returns None if no photo exists.

    Called lazily — only when the user explicitly clicks
    "View Receipt" in the transactions table.
    """
    with get_db() as conn:
        row = conn.execute(
            "SELECT photo FROM purchases WHERE id = ?",
            (purchase_id,)
        ).fetchone()

    if not row or not row["photo"]:
        return None

    return base64.b64encode(row["photo"]).decode("utf-8")


def get_stats():
    """
    Compute enriched dashboard statistics.

    Returns time-based metrics with comparisons:
      today          — today's spending + transaction count
      this_week      — last 7 days total + comparison to prior 7 days
      this_month     — current calendar month + budget context
      projected      — end-of-month projection based on daily average
      top_category   — highest spending category (with amount + %)
    """
    from datetime import datetime, timedelta

    today_str    = datetime.now().strftime("%Y-%m-%d")
    week_start   = (datetime.now() - timedelta(days=6)).strftime("%Y-%m-%d")
    prev_start   = (datetime.now() - timedelta(days=13)).strftime("%Y-%m-%d")
    prev_end     = (datetime.now() - timedelta(days=7)).strftime("%Y-%m-%d")
    current_month = datetime.now().strftime("%Y-%m")
    day_of_month  = datetime.now().day

    # Days remaining in current month
    import calendar
    year, month = datetime.now().year, datetime.now().month
    days_in_month = calendar.monthrange(year, month)[1]

    with get_db() as conn:

        # ── Today ────────────────────────────────────────────
        row = conn.execute(
            "SELECT SUM(amount), COUNT(*) FROM purchases WHERE date = ?",
            (today_str,)
        ).fetchone()
        today_total = round(row[0] or 0, 2)
        today_count = row[1] or 0

        # ── This Week (rolling 7 days) ───────────────────────
        row = conn.execute(
            "SELECT SUM(amount) FROM purchases WHERE date >= ?",
            (week_start,)
        ).fetchone()
        week_total = round(row[0] or 0, 2)

        # Prior week for comparison
        row = conn.execute(
            "SELECT SUM(amount) FROM purchases WHERE date >= ? AND date <= ?",
            (prev_start, prev_end)
        ).fetchone()
        prev_week_total = round(row[0] or 0, 2)

        if prev_week_total > 0:
            week_change_pct = round(
                ((week_total - prev_week_total) / prev_week_total) * 100, 1
            )
        else:
            week_change_pct = 0

        # ── This Month ───────────────────────────────────────
        row = conn.execute(
            "SELECT SUM(amount), COUNT(*) FROM purchases "
            "WHERE strftime('%Y-%m', date) = ?",
            (current_month,)
        ).fetchone()
        month_total = round(row[0] or 0, 2)
        month_count = row[1] or 0

        # ── Projected month total based on daily average ────
        if day_of_month > 0 and month_total > 0:
            daily_avg    = month_total / day_of_month
            projected    = round(daily_avg * days_in_month, 2)
        else:
            projected    = 0

        # ── Top category (all time) ──────────────────────────
        row = conn.execute(
            "SELECT category, SUM(amount) as total FROM purchases "
            "GROUP BY category ORDER BY total DESC LIMIT 1"
        ).fetchone()
        top_category = row["category"] if row else "—"
        top_amount   = round(row["total"], 2) if row else 0

        # All-time total (for top category %)
        row = conn.execute("SELECT SUM(amount) FROM purchases").fetchone()
        all_time_total = round(row[0] or 0, 2)

        if all_time_total > 0 and top_amount > 0:
            top_pct = round((top_amount / all_time_total) * 100, 1)
        else:
            top_pct = 0

        # ── Legacy fields kept for backwards compatibility ──
        row = conn.execute("SELECT COUNT(*) FROM purchases").fetchone()
        transaction_count = row[0] or 0

    return {
        # New enriched fields
        "today_total":       today_total,
        "today_count":       today_count,
        "week_total":        week_total,
        "week_change_pct":   week_change_pct,
        "month_total":       month_total,
        "month_count":       month_count,
        "projected_total":   projected,
        "day_of_month":      day_of_month,
        "days_in_month":     days_in_month,
        "top_category":      top_category,
        "top_amount":        top_amount,
        "top_percentage":    top_pct,

        # Legacy fields (kept so other pages don't break)
        "total_all_time":       all_time_total,
        "total_this_month":     month_total,
        "transaction_count":    transaction_count,
        "avg_per_month":        0,   # Not used anywhere critical
        "avg_per_transaction":  0,   # Not used anywhere critical
        "last_30_days":         week_total,
    }

def get_monthly_totals(sort_order="DESC"):
    """
    Return total spending grouped by calendar month.

    sort_order is validated by the caller (validators.py)
    before reaching this function — only 'ASC' or 'DESC'
    can arrive here. The f-string interpolation is safe
    because of this whitelist enforcement upstream.

    Returns list of dicts:
        [{"month": "2026-07", "total": 12400.0, "count": 23}, ...]
    """
    with get_db() as conn:
        rows = conn.execute(
            f"""
            SELECT
                strftime('%Y-%m', date) AS month,
                SUM(amount)             AS total,
                COUNT(*)                AS count
            FROM purchases
            GROUP BY month
            ORDER BY month {sort_order}
            """
        ).fetchall()

    return [dict(row) for row in rows]


def get_category_totals(month=None):
    """
    Return spending grouped by category.

    If month (YYYY-MM) is provided, filter to that month.
    If month is None, return all-time totals.

    month parameter is validated by validators.py before
    reaching this function.

    Returns list of dicts:
        [{"category": "Restaurants", "category_amount": 4200.0,
          "count": 14}, ...]
    """
    with get_db() as conn:
        if month:
            rows = conn.execute(
                """
                SELECT
                    category,
                    SUM(amount) AS category_amount,
                    COUNT(*)    AS count
                FROM purchases
                WHERE strftime('%Y-%m', date) = ?
                GROUP BY category
                ORDER BY category_amount DESC
                """,
                (month,)
            ).fetchall()
        else:
            rows = conn.execute(
                """
                SELECT
                    category,
                    SUM(amount) AS category_amount,
                    COUNT(*)    AS count
                FROM purchases
                GROUP BY category
                ORDER BY category_amount DESC
                """
            ).fetchall()

    return [dict(row) for row in rows]


def get_all_purchases_for_analysis():
    """
    Return all purchases as a list of dicts for analysis.
    No photos. Used by insights.py for statistical computations.

    This is separate from get_purchases_paginated() because
    analysis functions need the complete dataset, not one page.
    For very large datasets (10k+ records), this would need
    to be replaced with chunked processing — documented as
    known trade-off for this project scale.
    """
    with get_db() as conn:
        rows = conn.execute(
            """
            SELECT id, date, business, amount, category, description
            FROM purchases
            ORDER BY date DESC
            """
        ).fetchall()

    return [dict(row) for row in rows]


# =============================================================
# PURCHASES — Write Operations
# =============================================================

def add_purchase(date, business, amount, category,
                 description=None, photo_blob=None):
    """
    Insert a new purchase record.

    All parameters are validated by validators.py before
    this function is called. This function assumes inputs
    are clean and does not re-validate.

    Returns the integer ID of the newly created record.
    The caller uses this ID to return {"id": new_id} in the
    API response, enabling the frontend to reference the
    record immediately after creation.
    """
    with get_db() as conn:
        cursor = conn.execute(
            """
            INSERT INTO purchases
                (date, business, amount, category, description, photo)
            VALUES (?, ?, ?, ?, ?, ?)
            """,
            (date, business, amount, category,
             description or None, photo_blob)
        )
        conn.commit()
        return cursor.lastrowid


def delete_purchase(purchase_id):
    """
    Delete a purchase by its integer ID.

    Returns True if a row was deleted, False if ID not found.
    The caller uses this to return 404 vs 200.
    """
    with get_db() as conn:
        result = conn.execute(
            "DELETE FROM purchases WHERE id = ?",
            (purchase_id,)
        )
        conn.commit()
        return result.rowcount > 0


def edit_purchase(purchase_id, date, business, amount,
                  category, description=None):
    """
    Update an existing purchase's metadata fields.
    Photo is not updatable via edit — delete and re-add.

    Returns True if a row was updated, False if ID not found.
    """
    with get_db() as conn:
        result = conn.execute(
            """
            UPDATE purchases
            SET date        = ?,
                business    = ?,
                amount      = ?,
                category    = ?,
                description = ?
            WHERE id = ?
            """,
            (date, business, amount, category,
             description or None, purchase_id)
        )
        conn.commit()
        return result.rowcount > 0


# =============================================================
# BUDGETS — Read + Write
# =============================================================

def get_budgets():
    """
    Return all budget limits as a dict keyed by category.

    Example return:
        {"Restaurants": 3000.0, "Groceries": 5000.0}

    Dict format is convenient for O(1) lookup by category
    in insights.py health score and burn rate calculations.
    """
    with get_db() as conn:
        rows = conn.execute(
            "SELECT category, amount FROM budgets"
        ).fetchall()

    return {row["category"]: row["amount"] for row in rows}


def set_budget(category, amount):
    """
    Create or update a budget for a category.

    Uses INSERT OR REPLACE for upsert behaviour.
    If a budget for this category exists, it is overwritten.
    If not, a new record is created.

    INSERT OR REPLACE works by:
        1. Attempting INSERT
        2. If UNIQUE constraint (on category) fails,
           DELETE the existing row and INSERT the new one.
    This resets the id and created_at — acceptable trade-off
    for the simplicity it provides.
    """
    with get_db() as conn:
        conn.execute(
            """
            INSERT OR REPLACE INTO budgets (category, amount)
            VALUES (?, ?)
            """,
            (category, round(float(amount), 2))
        )
        conn.commit()


def delete_budget(category):
    """Remove a budget limit for a category."""
    with get_db() as conn:
        conn.execute(
            "DELETE FROM budgets WHERE category = ?",
            (category,)
        )
        conn.commit()


# =============================================================
# ACHIEVEMENTS — Read + Write
# =============================================================

def get_achievements():
    """Return all unlocked achievements ordered by unlock time."""
    with get_db() as conn:
        rows = conn.execute(
            """
            SELECT key, title, description, unlocked_at
            FROM achievements
            ORDER BY unlocked_at DESC
            """
        ).fetchall()

    return [dict(row) for row in rows]


def unlock_achievement(key, title, description=""):
    """
    Unlock an achievement if it has not already been unlocked.

    Uses INSERT OR IGNORE — if the key already exists
    (UNIQUE constraint), the insert is silently skipped.
    This makes calling unlock_achievement() idempotent:
    safe to call multiple times without duplicate records.

    Returns True if newly unlocked, False if already existed.
    """
    with get_db() as conn:
        result = conn.execute(
            """
            INSERT OR IGNORE INTO achievements (key, title, description)
            VALUES (?, ?, ?)
            """,
            (key, title, description)
        )
        conn.commit()
        return result.rowcount > 0


def get_categories():
    """
    Return a list of all distinct category names in the database.
    Used by insights.py to iterate over real categories
    rather than hardcoded defaults.
    """
    with get_db() as conn:
        rows = conn.execute(
            "SELECT DISTINCT category FROM purchases ORDER BY category"
        ).fetchall()

    return [row["category"] for row in rows]