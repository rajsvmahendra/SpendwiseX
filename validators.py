# =============================================================
# validators.py — Input Validation Layer
# =============================================================
#
# This module owns ALL input validation for the application.
# No route in app.py validates inputs directly — it delegates
# to these functions and acts on the result.
#
# Design:
#   Every function returns a tuple: (is_valid: bool, error: str)
#   On success: (True, None)
#   On failure: (False, "Human-readable error message")
#
# Why a separate module?
#   1. Validation rules are tested independently of Flask
#   2. The same validation function can be called from
#      multiple routes without code duplication
#   3. Changing a validation rule (e.g. max amount) requires
#      editing exactly one function in one file
# =============================================================

import re
from datetime import datetime


# =============================================================
# Expense Input Validation
# =============================================================

def validate_expense_input(date, business, amount_str, category):
    """
    Validate all required fields for creating or editing an expense.

    Parameters (all strings from request.form or request.json):
        date        — expected format: YYYY-MM-DD
        business    — merchant / vendor name
        amount_str  — numeric string, will be cast to float
        category    — category label

    Returns:
        (True, None)              — all fields valid
        (False, error_message)    — first validation failure
    """

    # ── Date ──────────────────────────────────────────────────
    if not date or not str(date).strip():
        return False, "Date is required."

    date = str(date).strip()

    if not re.match(r"^\d{4}-\d{2}-\d{2}$", date):
        return False, "Date must be in YYYY-MM-DD format."

    try:
        parsed = datetime.strptime(date, "%Y-%m-%d")
    except ValueError:
        return False, "Date is not a valid calendar date."

    # Reject dates more than 10 years in the future
    # (likely a data entry error)
    if parsed.year > datetime.now().year + 10:
        return False, "Date is too far in the future."

    # Reject dates before year 2000
    # (this app is not for historical accounting)
    if parsed.year < 2000:
        return False, "Date must be from year 2000 onwards."

    # ── Business ──────────────────────────────────────────────
    if not business or not str(business).strip():
        return False, "Business name is required."

    business = str(business).strip()

    if len(business) > 200:
        return False, "Business name must be under 200 characters."

    # Must contain at least one letter (not just numbers/symbols)
    if not re.search(r"[a-zA-Z\u0900-\u097F]", business):
        return False, "Business name must contain at least one letter."

    # ── Amount ────────────────────────────────────────────────
    if not amount_str and amount_str != 0:
        return False, "Amount is required."

    try:
        amount = float(str(amount_str).strip())
    except (ValueError, TypeError):
        return False, "Amount must be a valid number."

    if amount <= 0:
        return False, "Amount must be greater than zero."

    if amount > 10_000_000:
        return False, "Amount cannot exceed ₹1,00,00,000."

    # Check for unreasonable decimal precision
    # (more than 2 decimal places is a data entry error)
    amount_str_clean = str(amount_str).strip()
    if "." in amount_str_clean:
        decimal_places = len(amount_str_clean.split(".")[1])
        if decimal_places > 2:
            return False, "Amount can have at most 2 decimal places."

    # ── Category ──────────────────────────────────────────────
    if not category or not str(category).strip():
        return False, "Category is required."

    category = str(category).strip()

    if len(category) > 100:
        return False, "Category name must be under 100 characters."

    # Must contain at least one letter
    if not re.search(r"[a-zA-Z\u0900-\u097F]", category):
        return False, "Category must contain at least one letter."

    return True, None


# =============================================================
# Photo Upload Validation
# =============================================================

# Allowed MIME types for receipt photos.
# Must match ALLOWED_MIME_TYPES in app.py config.
ALLOWED_MIME_TYPES = frozenset({
    "image/jpeg",
    "image/png",
    "image/webp",
})

# Maximum file size: 10 MB
# Flask enforces this at the app level via MAX_CONTENT_LENGTH,
# but we check here too for a cleaner error message.
MAX_PHOTO_BYTES = 10 * 1024 * 1024  # 10 MB


def validate_photo(photo_file):
    """
    Validate an uploaded receipt photo file.

    photo_file is a Werkzeug FileStorage object from
    request.files.get('photo').

    Returns (True, None) if valid or if no file was provided
    (photo is optional). Returns (False, error) if invalid.

    Security note on MIME type checking:
        We check photo_file.mimetype which comes from the
        Content-Type header sent by the client.
        This CAN be spoofed — a malicious client can send
        Content-Type: image/jpeg with a PHP file as the body.

        For this project, the MIME check is sufficient to
        demonstrate security awareness. A production system
        would additionally check file magic bytes (the first
        4–8 bytes of the file that identify its true format):
            JPEG: FF D8 FF
            PNG:  89 50 4E 47
            WEBP: 52 49 46 46 ... 57 45 42 50
        This is documented as a known improvement area.
    """
    # Photo is optional
    if not photo_file or not photo_file.filename:
        return True, None

    if photo_file.mimetype not in ALLOWED_MIME_TYPES:
        allowed = ", ".join(sorted(ALLOWED_MIME_TYPES))
        return False, (
            f"Invalid file type '{photo_file.mimetype}'. "
            f"Allowed types: {allowed}."
        )

    return True, None


# =============================================================
# Query Parameter Validation
# =============================================================

def validate_sort_order(sort_param):
    """
    Validate and return a safe SQL ORDER BY direction.

    Why whitelist instead of trusting the parameter?
        sort_param is interpolated into an f-string SQL query
        in database.py. If we allowed arbitrary values, an
        attacker could inject SQL fragments.

        Whitelist approach: only 'ASC' or 'DESC' can ever
        reach the SQL query — any other value returns 'DESC'.

    Returns: 'ASC' or 'DESC' (never anything else)
    """
    if str(sort_param).strip().upper() == "ASC":
        return "ASC"
    return "DESC"


def validate_month_param(month):
    """
    Validate a month query parameter (format: YYYY-MM).

    Returns (True, None) if valid or if month is empty/None.
    Returns (False, error) if month is provided but malformed.

    Why validate even though it's used in a parameterised query?
        The month value is used in:
            WHERE strftime('%Y-%m', date) = ?
        The ? prevents SQL injection, but an invalid month
        format would silently return zero results with no
        error, which is confusing behaviour. Validation gives
        the caller a clear error response instead.
    """
    if not month or not str(month).strip():
        return True, None  # Optional parameter — absence is valid

    month = str(month).strip()

    if not re.match(r"^\d{4}-\d{2}$", month):
        return False, "month parameter must be in YYYY-MM format."

    # Validate actual calendar month (01–12)
    try:
        year, mo = month.split("-")
        if not (1 <= int(mo) <= 12):
            return False, "Month value must be between 01 and 12."
    except ValueError:
        return False, "month parameter must be in YYYY-MM format."

    return True, None


def validate_pagination_params(page_str, limit_str):
    """
    Parse and validate pagination query parameters.

    Returns (page: int, limit: int) with safe defaults
    and clamped ranges.

    page  : minimum 1, no maximum (caller handles 404 on empty)
    limit : minimum 1, maximum 100
            (prevents fetching entire database in one request)
    """
    try:
        page = max(1, int(str(page_str).strip()))
    except (ValueError, TypeError):
        page = 1

    try:
        limit = int(str(limit_str).strip())
        limit = max(1, min(100, limit))  # clamp to [1, 100]
    except (ValueError, TypeError):
        limit = 20

    return page, limit


# =============================================================
# Budget Validation
# =============================================================

def validate_budget_input(category, amount_str):
    """
    Validate inputs for creating or updating a budget limit.

    Returns (True, None) or (False, error_message).
    """
    if not category or not str(category).strip():
        return False, "Category is required."

    if len(str(category).strip()) > 100:
        return False, "Category name must be under 100 characters."

    try:
        amount = float(str(amount_str).strip())
    except (ValueError, TypeError):
        return False, "Budget amount must be a valid number."

    if amount <= 0:
        return False, "Budget amount must be greater than zero."

    if amount > 10_000_000:
        return False, "Budget amount cannot exceed ₹1,00,00,000."

    return True, None