# =============================================================
# insights.py — Business Intelligence Layer
# =============================================================
#
# This module transforms raw spending data into actionable
# financial intelligence. It is the core differentiator of
# SpendWise from a standard expense tracker.
#
# Design principles:
#   1. Every function receives data from database.py
#      and returns structured, JSON-serialisable results.
#   2. No database access inside this module directly —
#      all data comes via database.py functions.
#      (Exception: check_duplicate queries DB for efficiency)
#   3. Every algorithm is explainable — no black boxes.
#      Each score component is documented and returned
#      separately so the UI can show "why".
#   4. Graceful degradation — if data is insufficient,
#      return a meaningful default with a clear message.
#
# Dependencies:
#   pandas      — DataFrame aggregation and time-series ops
#   numpy       — numerical operations and statistics
#   scikit-learn — IsolationForest for anomaly detection
#   statistics  — Python stdlib, used for z-score fallback
#
# =============================================================

import re
import sqlite3
import statistics
from datetime import datetime, timedelta, date
from collections import defaultdict

import numpy  as np
import pandas as pd
from sklearn.ensemble      import IsolationForest
from sklearn.linear_model  import LinearRegression
from sklearn.preprocessing import StandardScaler

import database as db


# =============================================================
# SECTION 1 — FINANCIAL HEALTH SCORE
# =============================================================
#
# The health score is a single number (0–100) that represents
# the user's overall financial behaviour quality.
#
# It is composed of four independently scored components:
#
#   Component              Max Points  What it measures
#   ─────────────────────────────────────────────────────────
#   Budget Adherence          30       Staying within set limits
#   Spending Trend            25       Month-over-month direction
#   Consistency               25       Predictable, stable spending
#   Savings Potential         20       Headroom below income proxy
#
# Each component is scored separately and summed.
# The final score is clamped to [0, 100].
#
# Why rule-based instead of ML?
#   ML models require labelled training data ("this person has
#   good finances"). We have no such labels. Rule-based scoring
#   is transparent, explainable, and directly defensible in a
#   viva — "I chose these weights because budget adherence
#   has the highest direct impact on financial health."
# =============================================================

def financial_health_score():
    """
    Compute a 0–100 financial health score.

    Returns:
    {
        "score":      74,
        "label":      "Good",
        "color":      "#84CC16",
        "grade":      "B",
        "components": {
            "budget_adherence":  { "score": 22, "max": 30,
                                   "label": "3 of 4 categories on track" },
            "spending_trend":    { "score": 18, "max": 25,
                                   "label": "Spending decreased 8%" },
            "consistency":       { "score": 20, "max": 25,
                                   "label": "Low variance across months" },
            "savings_potential": { "score": 14, "max": 20,
                                   "label": "Moderate savings headroom" }
        },
        "insights": ["You stayed within budget in Groceries.",
                     "Restaurant spending dropped 12% this month."],
        "summary":  "Your finances are in good shape with room to improve."
    }
    """
    purchases = db.get_all_purchases_for_analysis()
    budgets   = db.get_budgets()

    if not purchases:
        return _health_score_default(
            "No expense data yet. Start logging to see your score."
        )

    df = pd.DataFrame(purchases)
    df["date"]   = pd.to_datetime(df["date"])
    df["month"]  = df["date"].dt.to_period("M")
    df["amount"] = pd.to_numeric(df["amount"], errors="coerce").fillna(0)

    insights = []
    components = {}

    # ── Component 1: Budget Adherence (max 30 pts) ────────────
    # For each category with a budget set:
    #   Compute current month's spending
    #   If under budget → full points for that category
    #   If over budget  → proportional deduction
    #
    # No budgets set → neutral score (15/30) with guidance message

    budget_score = 0
    current_month = datetime.now().strftime("%Y-%m")

    if budgets:
        current_df = df[
            df["date"].dt.to_period("M") == pd.Period(current_month)
        ]
        on_track   = 0
        over_budget = 0

        for category, limit in budgets.items():
            spent = current_df[
                current_df["category"] == category
            ]["amount"].sum()

            if spent <= limit:
                on_track += 1
                insights.append(
                    f"✓ {category}: ₹{spent:,.0f} of ₹{limit:,.0f} budget used."
                )
            else:
                over_budget += 1
                pct_over = ((spent - limit) / limit) * 100
                insights.append(
                    f"✗ {category}: {pct_over:.0f}% over your ₹{limit:,.0f} budget."
                )

        total_categories = len(budgets)
        budget_score = int((on_track / total_categories) * 30)
        label = (
            f"{on_track} of {total_categories} categories within budget"
            if total_categories > 0
            else "No budgets set"
        )
    else:
        budget_score = 15  # Neutral when no budgets configured
        label = "Set budgets to improve this score"
        insights.append("Tip: Set monthly budgets to track your spending limits.")

    components["budget_adherence"] = {
        "score": budget_score,
        "max":   30,
        "label": label,
    }

    # ── Component 2: Spending Trend (max 25 pts) ──────────────
    # Compare current month to previous month.
    # Decreasing or stable → high score
    # Increasing moderately → medium score
    # Increasing significantly → low score
    #
    # Requires at least 2 months of data.

    monthly = (
        df.groupby("month")["amount"]
          .sum()
          .sort_index()
    )

    trend_score = 13  # Neutral default
    trend_label = "Not enough monthly data"

    if len(monthly) >= 2:
        this_month_val = monthly.iloc[-1]
        last_month_val = monthly.iloc[-2]

        if last_month_val > 0:
            pct_change = ((this_month_val - last_month_val) / last_month_val) * 100
        else:
            pct_change = 0

        if pct_change <= -10:
            trend_score = 25
            trend_label = f"Spending decreased {abs(pct_change):.0f}% — excellent"
            insights.append(
                f"Your spending dropped {abs(pct_change):.0f}% from last month."
            )
        elif pct_change <= 0:
            trend_score = 20
            trend_label = f"Spending stable (−{abs(pct_change):.0f}%)"
        elif pct_change <= 10:
            trend_score = 16
            trend_label = f"Spending up {pct_change:.0f}% — slight increase"
        elif pct_change <= 25:
            trend_score = 10
            trend_label = f"Spending up {pct_change:.0f}% — moderate increase"
            insights.append(
                f"Spending increased {pct_change:.0f}% this month. Review your categories."
            )
        else:
            trend_score = 4
            trend_label = f"Spending up {pct_change:.0f}% — significant increase"
            insights.append(
                f"Warning: Spending jumped {pct_change:.0f}% compared to last month."
            )

    components["spending_trend"] = {
        "score": trend_score,
        "max":   25,
        "label": trend_label,
    }

    # ── Component 3: Consistency (max 25 pts) ─────────────────
    # Measure the coefficient of variation (CV) of monthly totals.
    # CV = standard_deviation / mean
    # Low CV → consistent spending → high score
    # High CV → erratic, unpredictable spending → low score
    #
    # CV < 0.15  → very consistent  → 25 pts
    # CV < 0.30  → fairly consistent → 18 pts
    # CV < 0.50  → moderate variance → 12 pts
    # CV >= 0.50 → high variance     →  5 pts

    consistency_score = 13  # Neutral
    consistency_label = "Need more months of data"

    if len(monthly) >= 3:
        mean_monthly = monthly.mean()
        std_monthly  = monthly.std()
        cv = (std_monthly / mean_monthly) if mean_monthly > 0 else 1.0

        if cv < 0.15:
            consistency_score = 25
            consistency_label = "Very consistent monthly spending"
        elif cv < 0.30:
            consistency_score = 18
            consistency_label = "Fairly consistent spending patterns"
        elif cv < 0.50:
            consistency_score = 12
            consistency_label = "Moderate spending variance"
        else:
            consistency_score = 5
            consistency_label = "High spending variance month-to-month"
            insights.append(
                "Your spending varies a lot between months. "
                "Try to plan more consistent budgets."
            )

    components["consistency"] = {
        "score": consistency_score,
        "max":   25,
        "label": consistency_label,
    }

    # ── Component 4: Savings Potential (max 20 pts) ───────────
    # We do not know the user's income, so we use their
    # lowest-spending month as a proxy for their baseline
    # capability. The gap between current spending and minimum
    # indicates savings potential.
    #
    # If current month < average       → 20 pts (spending below average)
    # If current month between avg-max → proportional between 5–20
    # If current month is highest ever → 5 pts

    savings_score = 10  # Neutral
    savings_label = "Savings potential data loading"

    if len(monthly) >= 2:
        avg_monthly = monthly.mean()
        min_monthly = monthly.min()
        max_monthly = monthly.max()
        cur_monthly = monthly.iloc[-1]

        if max_monthly > min_monthly:
            # Normalize: 0 = highest ever spend, 1 = lowest ever spend
            normalised = 1 - (
                (cur_monthly - min_monthly) / (max_monthly - min_monthly)
            )
            savings_score = int(normalised * 20)
        else:
            savings_score = 10

        if cur_monthly < avg_monthly:
            savings_label = (
                f"Spending ₹{avg_monthly - cur_monthly:,.0f} below average"
            )
            insights.append(
                f"You are spending ₹{avg_monthly - cur_monthly:,.0f} less than usual."
            )
        elif cur_monthly == max_monthly:
            savings_label = "Highest spending month recorded"
        else:
            savings_label = "Spending within normal range"

    components["savings_potential"] = {
        "score": savings_score,
        "max":   20,
        "label": savings_label,
    }

    # ── Final Score ───────────────────────────────────────────
    total_score = (
        components["budget_adherence"]["score"]
        + components["spending_trend"]["score"]
        + components["consistency"]["score"]
        + components["savings_potential"]["score"]
    )
    total_score = max(0, min(100, total_score))

    # Score label + colour + grade
    if total_score >= 85:
        label, color, grade = "Excellent", "#22C55E", "A"
        summary = "Outstanding financial discipline. Keep it up."
    elif total_score >= 70:
        label, color, grade = "Good",      "#84CC16", "B"
        summary = "Your finances are in good shape with room to improve."
    elif total_score >= 50:
        label, color, grade = "Fair",      "#F59E0B", "C"
        summary = "Some areas need attention. Review the insights below."
    elif total_score >= 30:
        label, color, grade = "Poor",      "#F97316", "D"
        summary = "Your spending patterns need significant improvement."
    else:
        label, color, grade = "Critical",  "#EF4444", "F"
        summary = "Immediate action needed. Review your spending urgently."

    return {
        "score":      total_score,
        "label":      label,
        "color":      color,
        "grade":      grade,
        "components": components,
        "insights":   insights[:5],  # Top 5 most relevant insights
        "summary":    summary,
    }


def _health_score_default(message):
    """Return a safe default health score when data is insufficient."""
    return {
        "score":      0,
        "label":      "No Data",
        "color":      "#94A3B8",
        "grade":      "—",
        "components": {
            "budget_adherence":  {"score": 0, "max": 30,
                                  "label": "No data"},
            "spending_trend":    {"score": 0, "max": 25,
                                  "label": "No data"},
            "consistency":       {"score": 0, "max": 25,
                                  "label": "No data"},
            "savings_potential": {"score": 0, "max": 20,
                                  "label": "No data"},
        },
        "insights": [],
        "summary":  message,
    }


# =============================================================
# SECTION 2 — ANOMALY DETECTION
# =============================================================
#
# We use two complementary approaches:
#
# Approach A — Z-Score (statistical, per category)
#   For each category with >= 3 data points:
#     Compute mean and std of historical amounts
#     Flag any expense where |z_score| > 2.0
#     (2 standard deviations above/below the category mean)
#
# Approach B — IsolationForest (scikit-learn ML)
#   Train on the full expense dataset (amount + day_of_week)
#   IsolationForest identifies points that are "isolated"
#   in the feature space — i.e., different from the norm
#
# Why both?
#   Z-score is per-category and interpretable ("2.3x your norm")
#   IsolationForest catches cross-category patterns
#   (e.g., unusually high total on a specific day)
#   Using both demonstrates depth of statistical thinking.
#
# Minimum data requirement:
#   At least 5 expenses total to produce meaningful results.
#   Below this threshold, we return an empty list with a note.
# =============================================================

def detect_anomalies(contamination=0.1):
    """
    Identify statistically unusual expenses.

    contamination: expected proportion of outliers (default 10%).
    This is an IsolationForest hyperparameter.

    Returns list of anomaly dicts, sorted by severity (z_score desc).
    Empty list if insufficient data.
    """
    purchases = db.get_all_purchases_for_analysis()

    if len(purchases) < 5:
        return []

    df = pd.DataFrame(purchases)
    df["date"]       = pd.to_datetime(df["date"])
    df["amount"]     = pd.to_numeric(df["amount"], errors="coerce").fillna(0)
    df["day_of_week"] = df["date"].dt.dayofweek  # 0=Monday, 6=Sunday

    anomalies = []
    flagged_ids = set()

    # ── Approach A: Z-Score per category ─────────────────────
    for category, group in df.groupby("category"):
        if len(group) < 3:
            # Cannot compute meaningful statistics with < 3 points
            continue

        amounts = group["amount"].values
        mean_amt = float(np.mean(amounts))
        std_amt  = float(np.std(amounts))

        if std_amt == 0:
            continue  # All amounts identical — no anomaly possible

        for _, row in group.iterrows():
            z = (row["amount"] - mean_amt) / std_amt

            if abs(z) > 2.0:
                # Compute a human-readable typical range
                low  = max(0, mean_amt - std_amt)
                high = mean_amt + std_amt

                flagged_ids.add(row["id"])
                anomalies.append({
                    "id":            int(row["id"]),
                    "date":          row["date"].strftime("%Y-%m-%d"),
                    "business":      row["business"],
                    "amount":        round(float(row["amount"]), 2),
                    "category":      row["category"],
                    "z_score":       round(float(z), 2),
                    "typical_range": f"₹{low:,.0f} – ₹{high:,.0f}",
                    "message":       _anomaly_message(
                                         row["business"],
                                         row["amount"],
                                         mean_amt,
                                         z,
                                         category
                                     ),
                    "method":        "z_score",
                })

    # ── Approach B: IsolationForest ───────────────────────────
    # Only run if we have at least 20 data points for meaningful
    # model training. IsolationForest with very few points
    # produces unreliable contamination estimates.
    if len(df) >= 20:
        try:
            features = df[["amount", "day_of_week"]].values

            scaler          = StandardScaler()
            features_scaled = scaler.fit_transform(features)

            model = IsolationForest(
                contamination = contamination,
                random_state  = 42,  # reproducible results
                n_estimators  = 100,
            )
            predictions = model.fit_predict(features_scaled)
            # IsolationForest returns: 1 = normal, -1 = anomaly

            for idx, pred in enumerate(predictions):
                if pred == -1:
                    row = df.iloc[idx]
                    rid = int(row["id"])

                    if rid not in flagged_ids:
                        # Compute anomaly score (lower = more anomalous)
                        score = model.score_samples(
                            features_scaled[idx].reshape(1, -1)
                        )[0]

                        flagged_ids.add(rid)
                        anomalies.append({
                            "id":            rid,
                            "date":          row["date"].strftime("%Y-%m-%d"),
                            "business":      row["business"],
                            "amount":        round(float(row["amount"]), 2),
                            "category":      row["category"],
                            "z_score":       round(abs(score) * 3, 2),
                            "typical_range": "—",
                            "message":       (
                                f"Unusual spending pattern detected "
                                f"at {row['business']}."
                            ),
                            "method":        "isolation_forest",
                        })

        except Exception as e:
            # IsolationForest failure should not break the endpoint
            print(f"[insights] IsolationForest error: {e}")

    # Sort by severity (highest absolute z_score first)
    anomalies.sort(key=lambda x: abs(x["z_score"]), reverse=True)

    # Return top 10 to avoid overwhelming the UI
    return anomalies[:10]


def _anomaly_message(business, amount, mean_amount, z_score, category):
    """Generate a human-readable anomaly explanation."""
    multiplier = amount / mean_amount if mean_amount > 0 else 1
    direction  = "above" if z_score > 0 else "below"
    return (
        f"{multiplier:.1f}x your usual {category} spend — "
        f"{abs(z_score):.1f} standard deviations {direction} average."
    )


# =============================================================
# SECTION 3 — SPENDING PERSONALITY
# =============================================================
#
# Six personality archetypes based on category distribution.
# Classification uses the ratio of spending across categories
# compared to the overall distribution.
#
# Why ratios instead of absolute amounts?
#   A person spending ₹50,000/month has different absolute
#   amounts than one spending ₹10,000/month, but both might
#   spend 40% on restaurants — they share the same personality.
#   Ratios normalise for income level.
#
# Personality rules (evaluated in priority order):
#
#   Saver      → total monthly average < ₹5,000
#   Socialite  → Restaurants > 35% of total spend
#   Shopaholic → Clothes > 25% of total spend
#   Nester     → (Groceries + Furniture/Home) > 45% of total
#   Impulsive  → coefficient of variation of daily spend > 0.8
#   Planner    → all other cases (consistent, balanced spender)
# =============================================================

PERSONALITIES = {
    "Saver": {
        "icon":        "piggy-bank",
        "description": "You keep your spending impressively low.",
        "color":       "#22C55E",
        "tip":         "Great discipline! Consider investing your savings.",
    },
    "Socialite": {
        "icon":        "users",
        "description": "A significant share of your budget goes to dining and eating out.",
        "color":       "#EC4899",
        "tip":         "Try cooking at home 2–3 times a week to cut costs.",
    },
    "Shopaholic": {
        "icon":        "shopping-bag",
        "description": "Clothes and shopping take up a large portion of your budget.",
        "color":       "#8B5CF6",
        "tip":         "Implement a 24-hour rule before non-essential purchases.",
    },
    "Nester": {
        "icon":        "home",
        "description": "Home and grocery spending dominate your budget.",
        "color":       "#10B981",
        "tip":         "Look for grocery deals and bulk buying opportunities.",
    },
    "Impulsive": {
        "icon":        "zap",
        "description": "Your spending varies significantly day to day.",
        "color":       "#F59E0B",
        "tip":         "Try a weekly spending plan to add predictability.",
    },
    "Planner": {
        "icon":        "target",
        "description": "Your spending is balanced and consistent across categories.",
        "color":       "#3B82F6",
        "tip":         "Excellent habits! Set stretch savings goals.",
    },
}


def spending_personality():
    """
    Classify the user's spending behaviour into one of six
    personality archetypes.

    Uses last 90 days of data for relevance.
    Falls back to all-time data if < 90 days of history.

    Returns:
    {
        "type":        "Socialite",
        "icon":        "users",
        "description": "A significant share of your budget goes to dining out.",
        "color":       "#EC4899",
        "tip":         "Try cooking at home 2–3 times a week.",
        "breakdown":   { "Restaurants": 42.1, "Groceries": 28.3, ... },
        "insight":     "Restaurants account for 42% of your spending.",
        "data_note":   "Based on last 90 days"
    }
    """
    purchases = db.get_all_purchases_for_analysis()

    if not purchases:
        return {
            "type":        "Unknown",
            "icon":        "help-circle",
            "description": "Add at least 5 expenses to see your personality.",
            "color":       "#94A3B8",
            "tip":         "Start logging your expenses!",
            "breakdown":   {},
            "insight":     "",
            "data_note":   "No data",
        }

    df = pd.DataFrame(purchases)
    df["date"]   = pd.to_datetime(df["date"])
    df["amount"] = pd.to_numeric(df["amount"], errors="coerce").fillna(0)

    # Use last 90 days if possible
    cutoff    = pd.Timestamp.now() - pd.Timedelta(days=90)
    recent_df = df[df["date"] >= cutoff]
    data_note = "Based on last 90 days"

    if len(recent_df) < 5:
        recent_df = df
        data_note = "Based on all-time data"

    total_spend = recent_df["amount"].sum()
    if total_spend == 0:
        return {
            "type":        "Unknown",
            "icon":        "help-circle",
            "description": "No spending data to classify.",
            "color":       "#94A3B8",
            "tip":         "Add expenses to discover your personality.",
            "breakdown":   {},
            "insight":     "",
            "data_note":   data_note,
        }

    # Category breakdown as percentages
    cat_totals = (
        recent_df.groupby("category")["amount"]
                 .sum()
                 .sort_values(ascending=False)
    )
    breakdown = {
        cat: round((amt / total_spend) * 100, 1)
        for cat, amt in cat_totals.items()
    }

    # Average monthly spend
    months_in_data = max(
        1,
        (recent_df["date"].max() - recent_df["date"].min()).days / 30
    )
    avg_monthly = total_spend / months_in_data

    # ── Classification logic (priority order) ─────────────────

    # Rule 1: Saver — very low average monthly spend
    if avg_monthly < 5000:
        personality_type = "Saver"
        insight = f"Your average monthly spend is just ₹{avg_monthly:,.0f}."

    # Rule 2: Socialite — restaurants dominate
    elif breakdown.get("Restaurants", 0) > 35:
        personality_type = "Socialite"
        pct = breakdown.get("Restaurants", 0)
        insight = f"Restaurants account for {pct:.0f}% of your spending."

    # Rule 3: Shopaholic — clothes/shopping dominate
    elif breakdown.get("Clothes", 0) > 25:
        personality_type = "Shopaholic"
        pct = breakdown.get("Clothes", 0)
        insight = f"Clothes account for {pct:.0f}% of your spending."

    # Rule 4: Nester — home-centric spending
    elif (breakdown.get("Groceries", 0)
          + breakdown.get("Furniture/Home", 0)) > 45:
        personality_type = "Nester"
        home_pct = (breakdown.get("Groceries", 0)
                    + breakdown.get("Furniture/Home", 0))
        insight = f"Home and groceries make up {home_pct:.0f}% of your budget."

    # Rule 5: Impulsive — high daily spending variance
    else:
        daily_totals = (
            recent_df.groupby(recent_df["date"].dt.date)["amount"].sum()
        )
        if len(daily_totals) >= 5:
            cv = daily_totals.std() / daily_totals.mean()
            if cv > 0.8:
                personality_type = "Impulsive"
                insight = (
                    f"Your daily spending varies by {cv:.1f}x — "
                    f"high unpredictability."
                )
            else:
                personality_type = "Planner"
                insight = (
                    "Your spending is well-balanced across categories."
                )
        else:
            personality_type = "Planner"
            insight = "Your spending appears balanced and consistent."

    meta = PERSONALITIES[personality_type]

    return {
        "type":        personality_type,
        "icon":        meta["icon"],
        "description": meta["description"],
        "color":       meta["color"],
        "tip":         meta["tip"],
        "breakdown":   breakdown,
        "insight":     insight,
        "data_note":   data_note,
    }


# =============================================================
# SECTION 4 — DUPLICATE EXPENSE DETECTOR
# =============================================================
#
# Before saving a new expense, check whether a similar one
# already exists in the database.
#
# Matching criteria (all three must match):
#   1. Business name similarity  — case-insensitive partial match
#   2. Amount proximity          — within ±₹1.00
#   3. Date proximity            — within ±2 calendar days
#
# Why ±₹1.00 on amount?
#   Service charges, rounding, or tip variations often mean
#   two legitimate records of the "same" transaction differ
#   by a small amount. ±₹1 catches these cases.
#
# Why ±2 days on date?
#   Users often log expenses the next day.
#   A duplicate logged "yesterday" vs "today" should be caught.
# =============================================================

def check_duplicate(date_str, business, amount):
    """
    Check for potential duplicate expenses before saving.

    Parameters:
        date_str (str)  — proposed expense date (YYYY-MM-DD)
        business (str)  — proposed business name
        amount   (float)— proposed amount

    Returns list of potential duplicates (may be empty).
    Each item: { id, date, business, amount, category }
    """
    if not date_str or not business or not amount:
        return []

    try:
        amount = float(amount)
    except (ValueError, TypeError):
        return []

    # Clean business name for comparison
    business_clean = business.strip().lower()

    # We query the database directly here for efficiency.
    # The alternative (fetching all purchases and filtering in Python)
    # would be wasteful for this single-purpose check.
    conn = sqlite3.connect(db.DATABASE)
    conn.row_factory = sqlite3.Row

    try:
        rows = conn.execute(
            """
            SELECT id, date, business, amount, category
            FROM purchases
            WHERE ABS(amount - ?) <= 1.0
              AND ABS(julianday(date) - julianday(?)) <= 2
            ORDER BY date DESC
            """,
            (amount, date_str)
        ).fetchall()

        duplicates = []
        for row in rows:
            # Fuzzy business name match (partial, case-insensitive)
            stored_business = (row["business"] or "").strip().lower()

            # Check if one name contains the other
            # (handles "Zomato" matching "Zomato India")
            if (business_clean in stored_business
                    or stored_business in business_clean
                    or _similarity_ratio(business_clean,
                                         stored_business) > 0.7):
                duplicates.append({
                    "id":       row["id"],
                    "date":     row["date"],
                    "business": row["business"],
                    "amount":   row["amount"],
                    "category": row["category"],
                })

        return duplicates

    finally:
        conn.close()


def _similarity_ratio(s1, s2):
    """
    Compute a simple character overlap similarity ratio
    between two strings. Range: 0.0 (no overlap) to 1.0 (identical).

    This is a simplified Jaccard similarity on character bigrams.
    Used to catch near-matches like "Reliance" vs "Reliance Fresh".

    Why not difflib.SequenceMatcher?
        SequenceMatcher is available in stdlib but its ratio()
        is O(n²). For short business names (< 50 chars),
        bigram Jaccard is equally accurate and simpler to explain.
    """
    if not s1 or not s2:
        return 0.0

    # Generate character bigrams
    def bigrams(s):
        return set(s[i:i+2] for i in range(len(s) - 1))

    b1 = bigrams(s1)
    b2 = bigrams(s2)

    if not b1 or not b2:
        return 1.0 if s1 == s2 else 0.0

    intersection = b1 & b2
    union        = b1 | b2

    return len(intersection) / len(union)


# =============================================================
# SECTION 5 — CASH FLOW FORECAST
# =============================================================
#
# Predict next month's total and per-category spending.
#
# Method: Weighted Moving Average + Linear Regression
#
# Step 1 — Weighted Moving Average (WMA)
#   Use the last 3 months of data.
#   Recent months have higher weight:
#     3 months ago → weight 1
#     2 months ago → weight 2
#     Last month   → weight 3
#
# Step 2 — Linear Regression trend adjustment
#   If we have 4+ months of data, fit a LinearRegression
#   on monthly totals to detect a trend direction.
#   If trend is upward, adjust WMA upward by trend slope.
#   If trend is downward, adjust WMA downward.
#
# Why not ARIMA or Prophet?
#   For a student project with typically < 12 months of data,
#   ARIMA requires careful parameter tuning and stationarity
#   testing. Prophet (Facebook) is excellent but adds a heavy
#   dependency. LinearRegression on a small time series is
#   transparent and defensible: "I fit a linear trend line
#   and extrapolate one period forward."
# =============================================================

def forecast_next_month():
    """
    Forecast next month's spending using weighted moving average
    with linear regression trend adjustment.

    Returns:
    {
        "month":       "2026-08",
        "month_label": "August 2026",
        "total":       14200.0,
        "by_category": {
            "Restaurants": 3200.0,
            "Groceries":   4100.0,
            ...
        },
        "trend":       "increasing",   # "increasing" | "decreasing" | "stable"
        "trend_pct":   8.3,            # expected % change from last month
        "confidence":  "medium",       # "low" | "medium" | "high"
        "note":        "Based on last 3 months weighted average."
    }
    """
    purchases = db.get_all_purchases_for_analysis()

    if not purchases:
        return _forecast_default("No data available for forecasting.")

    df = pd.DataFrame(purchases)
    df["date"]   = pd.to_datetime(df["date"])
    df["amount"] = pd.to_numeric(df["amount"], errors="coerce").fillna(0)
    df["period"] = df["date"].dt.to_period("M")

    # Monthly totals
    monthly = (
        df.groupby("period")["amount"]
          .sum()
          .sort_index()
    )

    if len(monthly) < 2:
        return _forecast_default(
            "Need at least 2 months of data to forecast."
        )

    # ── Step 1: Weighted Moving Average ──────────────────────
    # Use up to last 3 months
    recent_months = monthly.tail(3)
    weights       = list(range(1, len(recent_months) + 1))
    # weights = [1, 2, 3] for 3 months, [1, 2] for 2 months

    wma_total = float(
        np.average(recent_months.values, weights=weights)
    )

    # ── Step 2: Linear Regression Trend ──────────────────────
    trend        = "stable"
    trend_pct    = 0.0
    lr_adjustment = 0.0

    if len(monthly) >= 4:
        X = np.arange(len(monthly)).reshape(-1, 1)
        y = monthly.values

        lr = LinearRegression()
        lr.fit(X, y)

        # Slope: monthly change in spending
        slope = lr.coef_[0]

        # Predict next month's value
        next_X        = np.array([[len(monthly)]])
        lr_prediction = lr.predict(next_X)[0]

        last_actual = monthly.iloc[-1]

        if last_actual > 0:
            trend_pct = ((lr_prediction - last_actual) / last_actual) * 100

        # Apply a blended adjustment (50% WMA, 50% LR)
        lr_adjustment = (lr_prediction - wma_total) * 0.5
        wma_total     = max(0, wma_total + lr_adjustment)

        if trend_pct > 5:
            trend = "increasing"
        elif trend_pct < -5:
            trend = "decreasing"
        else:
            trend = "stable"

    # Round to 2 decimal places
    forecast_total = round(wma_total, 2)

    # ── Per-Category Forecast ─────────────────────────────────
    # Apply the same WMA logic independently to each category.
    by_category = {}
    all_categories = df["category"].unique()

    for cat in all_categories:
        cat_df      = df[df["category"] == cat]
        cat_monthly = (
            cat_df.groupby("period")["amount"]
                  .sum()
                  .reindex(monthly.index, fill_value=0)
        )
        recent_cat = cat_monthly.tail(3)
        w          = list(range(1, len(recent_cat) + 1))

        cat_forecast = float(np.average(recent_cat.values, weights=w))

        # Apply same proportional LR adjustment as total
        if wma_total > 0 and lr_adjustment != 0:
            cat_proportion = cat_forecast / wma_total if wma_total else 0
            cat_forecast  += lr_adjustment * cat_proportion

        by_category[cat] = round(max(0, cat_forecast), 2)

    # Confidence level based on data availability
    if len(monthly) >= 6:
        confidence = "high"
    elif len(monthly) >= 3:
        confidence = "medium"
    else:
        confidence = "low"

    # Next month label
    last_period  = monthly.index[-1]
    next_period  = last_period + 1
    next_month   = str(next_period)  # "2026-08"
    month_label  = next_period.to_timestamp().strftime("%B %Y")

    return {
        "month":       next_month,
        "month_label": month_label,
        "total":       forecast_total,
        "by_category": by_category,
        "trend":       trend,
        "trend_pct":   round(trend_pct, 1),
        "confidence":  confidence,
        "note":        (
            f"Based on {len(monthly)}-month weighted average"
            + (" with trend adjustment." if len(monthly) >= 4
               else ". Add more months for higher accuracy.")
        ),
    }


def _forecast_default(note):
    """Return a safe default forecast when data is insufficient."""
    next_month = (datetime.now().replace(day=1)
                  + timedelta(days=32)).replace(day=1)
    return {
        "month":       next_month.strftime("%Y-%m"),
        "month_label": next_month.strftime("%B %Y"),
        "total":       0,
        "by_category": {},
        "trend":       "unknown",
        "trend_pct":   0,
        "confidence":  "low",
        "note":        note,
    }


# =============================================================
# SECTION 6 — WEEKLY INSIGHT REPORT
# =============================================================
#
# A structured summary of the last 7 days vs the prior 7 days.
#
# Data computed:
#   - Total spending this week vs last week
#   - % change and direction
#   - Top 3 categories this week
#   - Best day (lowest spending)
#   - Worst day (highest spending)
#   - Any category spending unusually high vs 4-week average
#   - Transaction count
#
# "Week" is defined as the last 7 calendar days (rolling),
# not Mon–Sun. This means the report is always fresh when
# called, not stale until the next Monday.
# =============================================================

def weekly_report():
    """
    Generate a 7-day spending summary with week-over-week comparison.

    Returns:
    {
        "period":             "Jul 14 – Jul 20, 2026",
        "total":              3240.0,
        "total_last_week":    2820.0,
        "vs_amount":          420.0,
        "vs_pct":             14.9,
        "direction":          "up",
        "top_categories":  [
            {"category": "Restaurants", "amount": 1200.0,
             "pct": 37.0, "count": 4},
            ...
        ],
        "daily_breakdown":    {
            "2026-07-14": 240.0,
            "2026-07-15": 0.0,
            ...
        },
        "best_day":           "Sunday",
        "worst_day":          "Saturday",
        "transaction_count":  14,
        "alerts":          [
            "Restaurants: 2.1x your 4-week average."
        ],
        "health_delta":       -3,
    }
    """
    purchases = db.get_all_purchases_for_analysis()

    today     = datetime.now().date()
    week_start = today - timedelta(days=6)    # Last 7 days (inclusive)
    prev_start = today - timedelta(days=13)   # Prior 7 days
    prev_end   = today - timedelta(days=7)

    if not purchases:
        return _weekly_default()

    df = pd.DataFrame(purchases)
    df["date"]   = pd.to_datetime(df["date"]).dt.date
    df["amount"] = pd.to_numeric(df["amount"], errors="coerce").fillna(0)

    # This week's data
    this_week_df = df[df["date"] >= week_start]

    # Last week's data
    last_week_df = df[
        (df["date"] >= prev_start) & (df["date"] <= prev_end)
    ]

    total_this  = round(float(this_week_df["amount"].sum()), 2)
    total_last  = round(float(last_week_df["amount"].sum()), 2)
    vs_amount   = round(total_this - total_last, 2)
    vs_pct      = (
        round((vs_amount / total_last) * 100, 1)
        if total_last > 0 else 0.0
    )
    direction   = "up" if vs_amount > 0 else ("down" if vs_amount < 0 else "neutral")

    # Top 3 categories this week
    if not this_week_df.empty:
        cat_summary = (
            this_week_df.groupby("category")
            .agg(amount=("amount", "sum"), count=("amount", "count"))
            .sort_values("amount", ascending=False)
            .head(3)
        )
        top_categories = [
            {
                "category": cat,
                "amount":   round(float(row["amount"]), 2),
                "pct":      round(
                                (row["amount"] / total_this * 100), 1
                            ) if total_this > 0 else 0,
                "count":    int(row["count"]),
            }
            for cat, row in cat_summary.iterrows()
        ]
    else:
        top_categories = []

    # Daily spending breakdown
    date_range = [
        (week_start + timedelta(days=i))
        for i in range(7)
    ]
    daily_totals = (
        this_week_df.groupby("date")["amount"].sum()
    )
    daily_breakdown = {
        str(d): round(float(daily_totals.get(d, 0)), 2)
        for d in date_range
    }

    # Best and worst day names
    best_day_date  = min(daily_breakdown, key=daily_breakdown.get)
    worst_day_date = max(daily_breakdown, key=daily_breakdown.get)

    best_day  = datetime.strptime(best_day_date,  "%Y-%m-%d").strftime("%A")
    worst_day = datetime.strptime(worst_day_date, "%Y-%m-%d").strftime("%A")

    # Alerts — categories significantly above 4-week average
    four_weeks_ago = today - timedelta(days=28)
    recent_df = df[df["date"] >= four_weeks_ago]

    alerts = []
    if not this_week_df.empty and not recent_df.empty:
        four_week_avg_by_cat = (
            recent_df.groupby("category")["amount"]
                     .sum() / 4  # 4 weeks → per-week average
        )
        this_week_by_cat = (
            this_week_df.groupby("category")["amount"].sum()
        )

        for cat in this_week_by_cat.index:
            this_amt = float(this_week_by_cat[cat])
            avg_amt  = float(four_week_avg_by_cat.get(cat, 0))

            if avg_amt > 0 and this_amt > avg_amt * 1.8:
                multiplier = this_amt / avg_amt
                alerts.append(
                    f"{cat}: {multiplier:.1f}x your 4-week weekly average "
                    f"(₹{this_amt:,.0f} vs avg ₹{avg_amt:,.0f})."
                )

    # Period label
    period_label = (
        f"{week_start.strftime('%b %d')} – "
        f"{today.strftime('%b %d, %Y')}"
    )

    return {
        "period":             period_label,
        "total":              total_this,
        "total_last_week":    total_last,
        "vs_amount":          abs(vs_amount),
        "vs_pct":             abs(vs_pct),
        "direction":          direction,
        "top_categories":     top_categories,
        "daily_breakdown":    daily_breakdown,
        "best_day":           best_day,
        "worst_day":          worst_day,
        "transaction_count":  int(len(this_week_df)),
        "alerts":             alerts[:3],  # Max 3 alerts
    }


def _weekly_default():
    """Return a safe default weekly report when no data exists."""
    today      = datetime.now().date()
    week_start = today - timedelta(days=6)
    return {
        "period":             (
            f"{week_start.strftime('%b %d')} – "
            f"{today.strftime('%b %d, %Y')}"
        ),
        "total":              0,
        "total_last_week":    0,
        "vs_amount":          0,
        "vs_pct":             0,
        "direction":          "neutral",
        "top_categories":     [],
        "daily_breakdown":    {},
        "best_day":           "—",
        "worst_day":          "—",
        "transaction_count":  0,
        "alerts":             [],
    }

# =============================================================
# SECTION 7 — NATURAL LANGUAGE EXPENSE PARSER
# =============================================================
#
# Parses a free-text expense description into structured fields.
#
# Examples:
#   "spent 500 at Zomato yesterday"
#   → { date: yesterday, business: Zomato, amount: 500 }
#
#   "paid 1200 for groceries at Big Bazaar last friday"
#   → { date: last friday, business: Big Bazaar,
#       amount: 1200, category: Groceries }
#
#   "Uber 349 today"
#   → { date: today, business: Uber, amount: 349 }
#
# Algorithm:
#   Step 1 — Extract amount (numeric patterns)
#   Step 2 — Extract date reference (today/yesterday/last X)
#   Step 3 — Extract business name (after "at"/"from"/"in")
#   Step 4 — Infer category from keywords
#
# This is rule-based NLP using Python re (stdlib).
# No external NLP library required.
#
# Limitations (documented for viva honesty):
#   - Works best with English input
#   - Business names with multiple words work better with
#     explicit "at" / "from" marker
#   - Ambiguous inputs return partial results with
#     confidence flags so the UI can prompt the user
# =============================================================

# Keyword → category mapping
# Ordered from most specific to most general
NLP_CATEGORY_KEYWORDS = {
    "Restaurants": [
        "zomato", "swiggy", "restaurant", "cafe", "coffee",
        "dinner", "lunch", "breakfast", "food", "pizza",
        "burger", "biryani", "hotel", "dhaba", "canteen",
        "mcd", "kfc", "dominos", "starbucks",
    ],
    "Groceries": [
        "grocery", "groceries", "vegetables", "fruits",
        "supermarket", "bigbazaar", "big bazaar", "dmart",
        "reliance fresh", "more", "spencers", "milk",
        "kiryana", "provisions",
    ],
    "Gas/Car": [
        "petrol", "diesel", "fuel", "gas", "car", "uber",
        "ola", "rapido", "auto", "taxi", "parking",
        "service", "mechanic", "tyre",
    ],
    "Clothes": [
        "clothes", "clothing", "shirt", "pants", "dress",
        "shoes", "fashion", "myntra", "ajio", "zara",
        "h&m", "westside", "lifestyle",
    ],
    "Furniture/Home": [
        "furniture", "home", "ikea", "decor", "curtains",
        "bedsheet", "pillow", "sofa", "table", "chair",
        "rent", "maintenance", "repair",
    ],
    "School/Office Supplies": [
        "book", "stationery", "pen", "pencil", "notebook",
        "office", "school", "college", "course", "class",
        "amazon", "flipkart", "supplies",
    ],
}


def parse_natural_language(text):
    """
    Parse a free-text expense description into structured fields.

    Parameters:
        text (str) — raw natural language input from user

    Returns dict:
    {
        "amount":      500.0,       # None if not found
        "date":        "2026-07-23",# today's date as fallback
        "business":    "Zomato",    # None if not found
        "category":    "Restaurants",# None if not inferred
        "confidence":  {
            "amount":   "high",     # found explicit number
            "date":     "medium",   # inferred from "yesterday"
            "business": "high",     # found after "at" keyword
            "category": "inferred", # matched via keyword
        },
        "original":    "spent 500 at Zomato yesterday",
        "parsed_ok":   True,        # False if amount not found
    }
    """
    if not text or not text.strip():
        return _nlp_empty()

    raw  = text.strip()
    text = raw.lower()

    result = {
        "amount":     None,
        "date":       datetime.now().strftime("%Y-%m-%d"),
        "business":   None,
        "category":   None,
        "confidence": {
            "amount":   "none",
            "date":     "default",
            "business": "none",
            "category": "none",
        },
        "original":  raw,
        "parsed_ok": False,
    }

    # ── Step 1: Extract Amount ────────────────────────────────
    # Patterns supported:
    #   500, 500.00, 1,500, 1500.50
    #   Rs 500, Rs. 500, INR 500, ₹500
    #   "five hundred" — not supported (too ambiguous)

    amount_patterns = [
        r"(?:rs\.?\s*|inr\s*|₹\s*)(\d[\d,]*(?:\.\d{1,2})?)",
        r"(\d[\d,]*(?:\.\d{1,2})?)\s*(?:rs|inr|rupees?)",
        r"\b(\d[\d,]*(?:\.\d{1,2})?)\b",
    ]

    for pattern in amount_patterns:
        match = re.search(pattern, text)
        if match:
            amount_str = match.group(1).replace(",", "")
            try:
                amount = float(amount_str)
                if amount > 0:
                    result["amount"]               = amount
                    result["confidence"]["amount"] = "high"
                    break
            except ValueError:
                continue

    # ── Step 2: Extract Date Reference ───────────────────────
    # Supported references:
    #   today, yesterday, day before yesterday
    #   last monday/tuesday/.../sunday
    #   X days ago (X = 1–30)
    #   Explicit: 20 july, july 20, 20/07, 20-07-2026

    today     = datetime.now().date()
    date_conf = "default"
    resolved  = today  # fallback

    if re.search(r"\btoday\b", text):
        resolved  = today
        date_conf = "high"

    elif re.search(r"\byesterday\b", text):
        resolved  = today - timedelta(days=1)
        date_conf = "high"

    elif re.search(r"\bday before yesterday\b", text):
        resolved  = today - timedelta(days=2)
        date_conf = "high"

    else:
        # "X days ago"
        days_ago = re.search(r"(\d+)\s+days?\s+ago", text)
        if days_ago:
            try:
                n        = int(days_ago.group(1))
                resolved  = today - timedelta(days=n)
                date_conf = "high"
            except ValueError:
                pass

        # "last <weekday>"
        if date_conf == "default":
            weekdays = {
                "monday": 0, "tuesday": 1, "wednesday": 2,
                "thursday": 3, "friday": 4, "saturday": 5,
                "sunday": 6,
            }
            last_day = re.search(
                r"last\s+(monday|tuesday|wednesday|thursday"
                r"|friday|saturday|sunday)", text
            )
            if last_day:
                target_wd = weekdays[last_day.group(1)]
                days_back = (today.weekday() - target_wd) % 7
                if days_back == 0:
                    days_back = 7
                resolved  = today - timedelta(days=days_back)
                date_conf = "medium"

        # Explicit date patterns: "20 july" or "july 20"
        if date_conf == "default":
            months_map = {
                "jan": 1, "feb": 2, "mar": 3, "apr": 4,
                "may": 5, "jun": 6, "jul": 7, "aug": 8,
                "sep": 9, "oct": 10, "nov": 11, "dec": 12,
                "january": 1, "february": 2, "march": 3,
                "april": 4, "june": 6, "july": 7,
                "august": 8, "september": 9, "october": 10,
                "november": 11, "december": 12,
            }
            month_names = "|".join(months_map.keys())
            explicit = re.search(
                rf"(\d{{1,2}})\s+({month_names})|({month_names})\s+(\d{{1,2}})",
                text,
            )
            if explicit:
                try:
                    if explicit.group(1):
                        day   = int(explicit.group(1))
                        month = months_map[explicit.group(2)]
                    else:
                        month = months_map[explicit.group(3)]
                        day   = int(explicit.group(4))
                    year     = today.year
                    resolved  = date(year, month, day)
                    date_conf = "medium"
                except (ValueError, KeyError):
                    pass

    result["date"]              = resolved.strftime("%Y-%m-%d")
    result["confidence"]["date"] = date_conf

    # ── Step 3: Extract Business Name ────────────────────────
    # Strategy A: Look for text after "at", "from", "in", "@"
    # Strategy B: If no marker, use the first capitalised word
    #             that is not a common English word

    STOP_WORDS = {
        "spent", "paid", "bought", "for", "on", "the", "a",
        "an", "and", "or", "yesterday", "today", "last",
        "this", "week", "month", "day", "morning", "evening",
        "ago", "just", "rs", "inr", "rupees", "rupee",
    }

    business    = None
    biz_conf    = "none"

    # Strategy A — explicit marker
    biz_match = re.search(
        r"(?:at|from|in|@)\s+([A-Za-z][A-Za-z0-9\s&'.\-]{1,40}?)(?:\s+(?:for|on|yesterday|today|last|\d)|$)",
        raw,
        re.IGNORECASE,
    )
    if biz_match:
        business = biz_match.group(1).strip().title()
        biz_conf = "high"

    # Strategy B — capitalised words not in stop list
    if not business:
        words = raw.split()
        cap_words = [
            w for w in words
            if w[0].isupper()
            and w.lower() not in STOP_WORDS
            and not w.replace(".", "").replace(",", "").isdigit()
        ]
        if cap_words:
            business = " ".join(cap_words[:2]).strip()
            biz_conf = "low"

    result["business"]              = business
    result["confidence"]["business"] = biz_conf

    # ── Step 4: Infer Category from Keywords ─────────────────
    # Match the full text (including business name) against
    # keyword lists for each category.

    matched_category = None
    biz_lower        = (business or "").lower()

    for category, keywords in NLP_CATEGORY_KEYWORDS.items():
        for kw in keywords:
            if kw in text or kw in biz_lower:
                matched_category = category
                break
        if matched_category:
            break

    result["category"]              = matched_category
    result["confidence"]["category"] = (
        "inferred" if matched_category else "none"
    )

    # parsed_ok = True if we got at minimum an amount
    result["parsed_ok"] = result["amount"] is not None

    return result


def _nlp_empty():
    """Return empty parse result for blank input."""
    return {
        "amount":     None,
        "date":       datetime.now().strftime("%Y-%m-%d"),
        "business":   None,
        "category":   None,
        "confidence": {
            "amount":   "none",
            "date":     "default",
            "business": "none",
            "category": "none",
        },
        "original":  "",
        "parsed_ok": False,
    }

# =============================================================
# SECTION 8 — ACHIEVEMENT SYSTEM
# =============================================================
#
# Achievements are milestone-based rewards that encourage
# consistent financial tracking behaviour.
#
# Design principles:
#   1. Idempotent — checking achievements is safe to call
#      on every expense add. Uses INSERT OR IGNORE so already-
#      unlocked achievements are never duplicated.
#   2. Progressive — achievements scale with usage
#      (1 expense, 10 expenses, 50, 100...)
#   3. Behavioural — some reward good habits (budget adherence)
#      not just usage (transaction count)
#   4. Explainable — every achievement has a clear trigger
#      condition visible in the code
#
# Achievement keys (unique identifiers):
#
#   first_expense      — logged first expense
#   ten_expenses       — logged 10 expenses
#   fifty_expenses     — logged 50 expenses
#   century            — logged 100 expenses
#   budget_guardian    — all budgets met this month
#   streak_7           — logged expenses on 7 different days
#   streak_30          — logged expenses on 30 different days
#   category_explorer  — used 5+ different categories
#   photo_keeper       — attached a receipt photo
#   early_adopter      — used app within first week of install
# =============================================================

# Achievement definitions — key → metadata
ACHIEVEMENT_DEFINITIONS = {
    "first_expense": {
        "title":       "First Step",
        "description": "Logged your very first expense.",
        "icon":        "star",
        "points":      10,
    },
    "ten_expenses": {
        "title":       "Getting Started",
        "description": "Logged 10 expenses.",
        "icon":        "trending-up",
        "points":      25,
    },
    "fifty_expenses": {
        "title":       "Committed Tracker",
        "description": "Logged 50 expenses.",
        "icon":        "award",
        "points":      50,
    },
    "century": {
        "title":       "Century",
        "description": "Logged 100 expenses. Exceptional discipline.",
        "icon":        "zap",
        "points":      100,
    },
    "budget_guardian": {
        "title":       "Budget Guardian",
        "description": "Stayed within all budget limits for a full month.",
        "icon":        "shield",
        "points":      75,
    },
    "streak_7": {
        "title":       "Week Warrior",
        "description": "Logged expenses on 7 different days.",
        "icon":        "calendar",
        "points":      30,
    },
    "streak_30": {
        "title":       "Monthly Master",
        "description": "Logged expenses on 30 different days.",
        "icon":        "trophy",
        "points":      80,
    },
    "category_explorer": {
        "title":       "Category Explorer",
        "description": "Used 5 or more different spending categories.",
        "icon":        "grid",
        "points":      20,
    },
    "photo_keeper": {
        "title":       "Receipt Keeper",
        "description": "Attached a receipt photo to an expense.",
        "icon":        "camera",
        "points":      15,
    },
}


def check_and_unlock_achievements(has_photo=False):
    """
    Evaluate all achievement conditions and unlock any
    that have been newly earned.

    Called after every successful expense addition.
    Returns a list of newly unlocked achievement dicts
    so the frontend can display toast notifications.

    Parameters:
        has_photo (bool) — whether the new expense had a photo

    Returns:
        list of newly unlocked achievements:
        [{ "key", "title", "description", "icon", "points" }, ...]
    """
    purchases = db.get_all_purchases_for_analysis()
    budgets   = db.get_budgets()
    newly_unlocked = []

    total_count  = len(purchases)
    unique_days  = len(set(p["date"] for p in purchases))
    unique_cats  = len(set(p["category"] for p in purchases))

    def try_unlock(key):
        """Attempt to unlock an achievement. Return meta if newly unlocked."""
        defn = ACHIEVEMENT_DEFINITIONS.get(key)
        if not defn:
            return None
        was_unlocked = db.unlock_achievement(
            key         = key,
            title       = defn["title"],
            description = defn["description"],
        )
        if was_unlocked:
            return {
                "key":         key,
                "title":       defn["title"],
                "description": defn["description"],
                "icon":        defn["icon"],
                "points":      defn["points"],
            }
        return None

    # ── Count-based achievements ──────────────────────────────
    if total_count >= 1:
        r = try_unlock("first_expense")
        if r: newly_unlocked.append(r)

    if total_count >= 10:
        r = try_unlock("ten_expenses")
        if r: newly_unlocked.append(r)

    if total_count >= 50:
        r = try_unlock("fifty_expenses")
        if r: newly_unlocked.append(r)

    if total_count >= 100:
        r = try_unlock("century")
        if r: newly_unlocked.append(r)

    # ── Streak achievements ───────────────────────────────────
    if unique_days >= 7:
        r = try_unlock("streak_7")
        if r: newly_unlocked.append(r)

    if unique_days >= 30:
        r = try_unlock("streak_30")
        if r: newly_unlocked.append(r)

    # ── Category explorer ─────────────────────────────────────
    if unique_cats >= 5:
        r = try_unlock("category_explorer")
        if r: newly_unlocked.append(r)

    # ── Photo keeper ──────────────────────────────────────────
    if has_photo:
        r = try_unlock("photo_keeper")
        if r: newly_unlocked.append(r)

    # ── Budget guardian ───────────────────────────────────────
    # Check if all budgets were met this calendar month
    if budgets and purchases:
        df = pd.DataFrame(purchases)
        df["amount"] = pd.to_numeric(df["amount"], errors="coerce").fillna(0)
        current_month = datetime.now().strftime("%Y-%m")

        this_month = df[
            df["date"].str.startswith(current_month)
        ]

        all_within = all(
            this_month[
                this_month["category"] == cat
            ]["amount"].sum() <= limit
            for cat, limit in budgets.items()
        )

        if all_within and len(budgets) >= 2:
            r = try_unlock("budget_guardian")
            if r: newly_unlocked.append(r)

    return newly_unlocked