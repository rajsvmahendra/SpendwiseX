# =============================================================
# app.py — Flask Application + Routes
# =============================================================
#
# This file has ONE job: define routes and connect HTTP
# requests to the correct functions in other modules.
#
# What this file does NOT do:
#   ✗ Write SQL queries       → database.py
#   ✗ Validate inputs         → validators.py
#   ✗ Compute statistics      → database.py / insights.py
#   ✗ Business logic          → insights.py
#
# Layered architecture:
#
#   HTTP Request
#       ↓
#   app.py (route handler)
#       ↓
#   validators.py (is input valid?)
#       ↓
#   database.py (fetch / write data)
#       ↓  (for intelligence endpoints)
#   insights.py (what does the data mean?)
#       ↓
#   JSON Response
# =============================================================

from flask import Flask, request, jsonify, render_template

import database   as db
import validators as v
import insights   as ix

# =============================================================
# Application Factory
# =============================================================

app = Flask(__name__)

# Maximum upload size: 10 MB
# Enforced by Flask before the route handler runs.
# If exceeded, Flask returns 413 before our code executes.
app.config["MAX_CONTENT_LENGTH"] = 10 * 1024 * 1024

# Initialise database schema on startup
# Safe to call every time — all statements use IF NOT EXISTS
db.init_db()


# =============================================================
# Page Routes — Render HTML Templates
# =============================================================
# These routes do nothing except render a template.
# All data fetching happens via JavaScript → API routes.
# Jinja2 is used only for template inheritance (base.html).

@app.route("/")
def home():
    return render_template("index.html")


@app.route("/add")
def add_page():
    return render_template("add.html")


@app.route("/recent")
def recent_page():
    return render_template("recent.html")


@app.route("/monthly")
def monthly_page():
    return render_template("monthly.html")


# =============================================================
# API — Expense CRUD
# =============================================================

@app.route("/api/add", methods=["POST"])
def api_add_purchase():
    """
    Create a new expense record.

    Accepts: multipart/form-data
    Fields:  date, business, amount, category,
             description (optional), photo (optional)

    Returns:
        201 — { "success": true, "id": <int>,
                "achievements": [...] }
        400 — { "success": false, "error": "<message>" }
        500 — { "success": false, "error": "<message>" }
    """
    # ── Extract and strip all text fields ────────────────────
    date        = str(request.form.get("date",        "") or "").strip()
    business    = str(request.form.get("business",    "") or "").strip()
    amount_str  = str(request.form.get("amount",      "") or "").strip()
    category    = str(request.form.get("category",    "") or "").strip()
    description = str(request.form.get("description", "") or "").strip()
    photo_file  = request.files.get("photo")

    # ── Validate text fields ──────────────────────────────────
    ok, error = v.validate_expense_input(date, business, amount_str, category)
    if not ok:
        return jsonify({"success": False, "error": error}), 400

    # ── Validate photo (optional) ─────────────────────────────
    ok, error = v.validate_photo(photo_file)
    if not ok:
        return jsonify({"success": False, "error": error}), 400

    # ── Read photo binary ─────────────────────────────────────
    # photo_file.filename is "" when no file is selected.
    # We check both existence and non-empty filename before reading.
    photo_blob = (
        photo_file.read()
        if photo_file and photo_file.filename
        else None
    )

    # ── Determine if photo was provided ───────────────────────
    # Computed BEFORE the try block so it is available in both
    # the success path and referenced clearly.
    # This is what triggers the "photo_keeper" achievement.
    has_photo = photo_blob is not None

    # ── Save to database ──────────────────────────────────────
    try:
        new_id = db.add_purchase(
            date        = date,
            business    = business,
            amount      = round(float(amount_str), 2),
            category    = category,
            description = description or None,
            photo_blob  = photo_blob,
        )

        # ── Check and unlock achievements ─────────────────────
        # Called after every successful save.
        # Returns only NEWLY unlocked achievements (not all).
        # INSERT OR IGNORE in db.unlock_achievement ensures
        # previously unlocked achievements are not duplicated.
        new_achievements = ix.check_and_unlock_achievements(
            has_photo=has_photo
        )

        return jsonify({
            "success":      True,
            "id":           new_id,
            "achievements": new_achievements,
        }), 201

    except Exception as e:
        print(f"[ERROR] api_add_purchase: {e}")
        return jsonify({
            "success": False,
            "error":   "Failed to save expense. Please try again.",
        }), 500


@app.route("/api/purchases", methods=["GET"])
def api_get_purchases():
    """
    Return a paginated list of purchases (no photo data).

    Query params:
        page  — page number (default 1)
        limit — records per page (default 20, max 100)

    Returns:
        200 — { "purchases": [...], "total": n,
                "page": n, "pages": n }
        500 — { "error": "..." }
    """
    page, limit = v.validate_pagination_params(
        request.args.get("page",  1),
        request.args.get("limit", 20),
    )

    try:
        result = db.get_purchases_paginated(page=page, limit=limit)
        return jsonify(result), 200
    except Exception as e:
        print(f"[ERROR] api_get_purchases: {e}")
        return jsonify({"error": "Failed to fetch purchases."}), 500


@app.route("/api/purchases/<int:purchase_id>/photo", methods=["GET"])
def api_get_photo(purchase_id):
    """
    Return the base64-encoded photo for a single purchase.
    Called lazily when user clicks "View Receipt".

    Returns:
        200 — { "photo": "<base64>" } or { "photo": null }
        500 — { "error": "..." }
    """
    try:
        photo_b64 = db.get_purchase_photo(purchase_id)
        return jsonify({"photo": photo_b64}), 200
    except Exception as e:
        print(f"[ERROR] api_get_photo: {e}")
        return jsonify({"error": "Failed to fetch photo."}), 500


@app.route("/api/purchases/<int:purchase_id>", methods=["DELETE"])
def api_delete_purchase(purchase_id):
    """
    Delete a purchase by ID.

    Returns:
        200 — { "success": true }
        404 — { "success": false, "error": "Not found." }
        500 — { "success": false, "error": "..." }
    """
    try:
        deleted = db.delete_purchase(purchase_id)
        if not deleted:
            return jsonify({
                "success": False,
                "error":   "Expense not found.",
            }), 404
        return jsonify({"success": True}), 200
    except Exception as e:
        print(f"[ERROR] api_delete_purchase: {e}")
        return jsonify({
            "success": False,
            "error":   "Failed to delete expense.",
        }), 500


@app.route("/api/purchases/<int:purchase_id>", methods=["PUT"])
def api_edit_purchase(purchase_id):
    """
    Update an existing purchase's fields.

    Accepts: application/json
    Fields:  date, business, amount, category, description

    Returns:
        200 — { "success": true }
        400 — { "success": false, "error": "..." }
        404 — { "success": false, "error": "Not found." }
        500 — { "success": false, "error": "..." }
    """
    data = request.get_json(silent=True)
    if not data:
        return jsonify({
            "success": False,
            "error":   "Request body must be JSON.",
        }), 400

    date        = str(data.get("date",        "") or "").strip()
    business    = str(data.get("business",    "") or "").strip()
    amount_str  = str(data.get("amount",      "") or "").strip()
    category    = str(data.get("category",    "") or "").strip()
    description = str(data.get("description", "") or "").strip()

    ok, error = v.validate_expense_input(date, business, amount_str, category)
    if not ok:
        return jsonify({"success": False, "error": error}), 400

    try:
        updated = db.edit_purchase(
            purchase_id = purchase_id,
            date        = date,
            business    = business,
            amount      = round(float(amount_str), 2),
            category    = category,
            description = description or None,
        )
        if not updated:
            return jsonify({
                "success": False,
                "error":   "Expense not found.",
            }), 404
        return jsonify({"success": True}), 200
    except Exception as e:
        print(f"[ERROR] api_edit_purchase: {e}")
        return jsonify({
            "success": False,
            "error":   "Failed to update expense.",
        }), 500


# =============================================================
# API — Dashboard + Analytics Data
# =============================================================

@app.route("/api/stats", methods=["GET"])
def api_stats():
    """
    Return dashboard summary statistics.
    All computed in SQL — no photo data, no full table scans.

    Returns:
        200 — { total_all_time, total_this_month,
                transaction_count, top_category,
                avg_per_month, avg_per_transaction,
                last_30_days }
        500 — { "error": "..." }
    """
    try:
        return jsonify(db.get_stats()), 200
    except Exception as e:
        print(f"[ERROR] api_stats: {e}")
        return jsonify({"error": "Failed to compute stats."}), 500


@app.route("/api/monthly-totals", methods=["GET"])
def api_monthly_totals():
    """
    Return total spending grouped by month.

    Query params:
        sort — 'ASC' or 'DESC' (default: DESC)

    Returns:
        200 — [{ "month": "YYYY-MM", "total": n, "count": n }, ...]
        500 — { "error": "..." }
    """
    sort_order = v.validate_sort_order(request.args.get("sort", "DESC"))
    try:
        return jsonify(db.get_monthly_totals(sort_order)), 200
    except Exception as e:
        print(f"[ERROR] api_monthly_totals: {e}")
        return jsonify({"error": "Failed to fetch monthly totals."}), 500


@app.route("/api/category-totals", methods=["GET"])
def api_category_totals():
    """
    Return spending grouped by category.

    Query params:
        month — YYYY-MM to filter (optional, all-time if omitted)

    Returns:
        200 — [{ "category": "...", "category_amount": n,
                 "count": n }, ...]
        400 — { "error": "..." }
        500 — { "error": "..." }
    """
    month = (request.args.get("month") or "").strip() or None

    if month:
        ok, error = v.validate_month_param(month)
        if not ok:
            return jsonify({"error": error}), 400

    try:
        return jsonify(db.get_category_totals(month)), 200
    except Exception as e:
        print(f"[ERROR] api_category_totals: {e}")
        return jsonify({"error": "Failed to fetch category totals."}), 500


# =============================================================
# API — Budgets
# =============================================================

@app.route("/api/budgets", methods=["GET"])
def api_get_budgets():
    """
    Return all budget limits as a dict keyed by category.

    Returns:
        200 — { "Restaurants": 3000.0, "Groceries": 5000.0, ... }
    """
    try:
        return jsonify(db.get_budgets()), 200
    except Exception as e:
        print(f"[ERROR] api_get_budgets: {e}")
        return jsonify({"error": "Failed to fetch budgets."}), 500


@app.route("/api/budgets", methods=["POST"])
def api_set_budget():
    """
    Create or update a budget for a category.

    Accepts: application/json
    Fields:  category (str), amount (number)

    Returns:
        200 — { "success": true }
        400 — { "success": false, "error": "..." }
        500 — { "success": false, "error": "..." }
    """
    data = request.get_json(silent=True)
    if not data:
        return jsonify({
            "success": False,
            "error":   "Request body must be JSON.",
        }), 400

    category   = str(data.get("category",  "") or "").strip()
    amount_str = str(data.get("amount",    "") or "").strip()

    ok, error = v.validate_budget_input(category, amount_str)
    if not ok:
        return jsonify({"success": False, "error": error}), 400

    try:
        db.set_budget(category, float(amount_str))
        return jsonify({"success": True}), 200
    except Exception as e:
        print(f"[ERROR] api_set_budget: {e}")
        return jsonify({
            "success": False,
            "error":   "Failed to save budget.",
        }), 500


# =============================================================
# API — Insights (Phase 3 endpoints, stubs return defaults)
# =============================================================

@app.route("/api/insights/health-score", methods=["GET"])
def api_health_score():
    """Financial health score (0–100). Implemented in Phase 3."""
    try:
        return jsonify(ix.financial_health_score()), 200
    except Exception as e:
        print(f"[ERROR] api_health_score: {e}")
        return jsonify({"error": "Failed to compute health score."}), 500


@app.route("/api/insights/anomalies", methods=["GET"])
def api_anomalies():
    """Unusual expense detection. Implemented in Phase 3."""
    try:
        return jsonify(ix.detect_anomalies()), 200
    except Exception as e:
        print(f"[ERROR] api_anomalies: {e}")
        return jsonify({"error": "Failed to detect anomalies."}), 500


@app.route("/api/insights/personality", methods=["GET"])
def api_personality():
    """Spending personality classification. Implemented in Phase 3."""
    try:
        return jsonify(ix.spending_personality()), 200
    except Exception as e:
        print(f"[ERROR] api_personality: {e}")
        return jsonify({"error": "Failed to compute personality."}), 500


@app.route("/api/insights/forecast", methods=["GET"])
def api_forecast():
    """Next month spending forecast. Implemented in Phase 3."""
    try:
        return jsonify(ix.forecast_next_month()), 200
    except Exception as e:
        print(f"[ERROR] api_forecast: {e}")
        return jsonify({"error": "Failed to compute forecast."}), 500


@app.route("/api/insights/weekly-report", methods=["GET"])
def api_weekly_report():
    """7-day spending summary. Implemented in Phase 3."""
    try:
        return jsonify(ix.weekly_report()), 200
    except Exception as e:
        print(f"[ERROR] api_weekly_report: {e}")
        return jsonify({"error": "Failed to generate report."}), 500


@app.route("/api/insights/check-duplicate", methods=["POST"])
def api_check_duplicate():
    """
    Check if a similar expense exists before saving.
    Called from the Add Expense form before submission.

    Accepts: application/json
    Fields:  date, business, amount

    Returns:
        200 — { "duplicates": [...] }
    """
    data = request.get_json(silent=True) or {}
    date     = str(data.get("date",     "") or "").strip()
    business = str(data.get("business", "") or "").strip()
    amount   = data.get("amount", 0)

    try:
        duplicates = ix.check_duplicate(date, business, amount)
        return jsonify({"duplicates": duplicates}), 200
    except Exception as e:
        print(f"[ERROR] api_check_duplicate: {e}")
        return jsonify({"duplicates": []}), 200


# =============================================================
# API — Achievements
# =============================================================

@app.route("/api/insights/parse-nlp", methods=["POST"])
def api_parse_nlp():
    """
    Parse a natural language expense description.

    Accepts: application/json
    Fields:  { "text": "spent 500 at Zomato yesterday" }

    Returns:
        200 — {
            "amount": 500.0,
            "date": "2026-07-23",
            "business": "Zomato",
            "category": "Restaurants",
            "confidence": { ... },
            "parsed_ok": true
        }
        400 — { "error": "No text provided." }

    Called by the NLP input box on the Add Expense page.
    The frontend uses the result to pre-populate form fields.
    Fields can be overridden by the user before submitting.
    """
    data = request.get_json(silent=True) or {}
    text = str(data.get("text", "") or "").strip()

    if not text:
        return jsonify({"error": "No text provided."}), 400

    try:
        result = ix.parse_natural_language(text)
        return jsonify(result), 200
    except Exception as e:
        print(f"[ERROR] api_parse_nlp: {e}")
        return jsonify({"error": "Failed to parse input."}), 500

@app.route("/api/achievements", methods=["GET"])
def api_achievements():
    """Return all unlocked achievements."""
    try:
        return jsonify(db.get_achievements()), 200
    except Exception as e:
        print(f"[ERROR] api_achievements: {e}")
        return jsonify({"error": "Failed to fetch achievements."}), 500



# =============================================================
# Error Handlers
# =============================================================

@app.errorhandler(404)
def not_found(e):
    if request.path.startswith("/api/"):
        return jsonify({"error": "Endpoint not found."}), 404
    return render_template("index.html"), 404


@app.errorhandler(413)
def file_too_large(e):
    return jsonify({
        "success": False,
        "error":   "File too large. Maximum allowed size is 10 MB.",
    }), 413


@app.errorhandler(500)
def server_error(e):
    if request.path.startswith("/api/"):
        return jsonify({"error": "Internal server error."}), 500
    return render_template("index.html"), 500


# =============================================================
# Entry Point
# =============================================================

if __name__ == "__main__":
    # debug=True enables the Werkzeug interactive debugger.
    # NEVER use debug=True in production — it allows arbitrary
    # code execution on the server by anyone who can reach it.
    # Production deployment: gunicorn app:app --workers 4
    app.run(host="0.0.0.0", port=5000, debug=True)