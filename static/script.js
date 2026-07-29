/* =============================================================
   SpendWise — Frontend Application Logic
   =============================================================

   Architecture overview
   ─────────────────────
   This file is the single JavaScript module for the entire
   application. It is loaded with defer on every page via
   base.html, so DOMContentLoaded is always available.

   Page detection strategy
   ───────────────────────
   Rather than separate JS files per page, each init function
   checks for a unique DOM element before doing any work.
   If the element is not found, the function returns immediately.
   This means unused code paths add near-zero cost.

   API contract (Phase 1 updated endpoints)
   ─────────────────────────────────────────
   GET  /api/stats                        — dashboard summary
   GET  /api/purchases?page=&limit=       — paginated, no photos
   GET  /api/purchases/<id>/photo         — lazy photo fetch
   GET  /api/monthly-totals?sort=         — monthly aggregation
   GET  /api/category-totals?month=       — category aggregation
   POST /api/add                          — create expense
   PUT  /api/purchases/<id>               — update expense
   DELETE /api/purchases/<id>             — delete expense

   External dependencies (loaded in base.html before this file)
   ─────────────────────────────────────────────────────────────
   Alpine.js  — reactive form state (add.html)
   GSAP       — animations (stat cards, transitions)
   Chart.js   — charts (index.html, monthly.html only)

   ============================================================= */

"use strict";

/* -------------------------------------------------------------
   INITIALISATION — runs after HTML is fully parsed (defer)
   ------------------------------------------------------------- */

document.addEventListener("DOMContentLoaded", () => {
    // ── Mascot welcome (must run first — covers the screen) ──
    initMascotWelcome();
    // initMascotFormReactions();

    // ── Global (all pages) ───────────────────────────────────
    setActiveNavLink();

    // ── Add Expense / Diary page ─────────────────────────────
    // initDatePicker();
    // initPurchaseForm();
    // initNaturalLanguageInput();


    // ── Transactions / Ledger page ───────────────────────────
    initRecentTransactions();

    // ── Insights / Analytics page ────────────────────────────
    initMonthlyAnalytics();
    initForecast();

    // ── Dashboard page ───────────────────────────────────────
    initDashboardExperience();
});

/* =============================================================
   SECTION 1 — FORMAT HELPERS
   =============================================================
   Pure functions. No side effects. No DOM access.
   Tested independently — each has one clear responsibility.
   ============================================================= */

/**
 * Format a number as Indian Rupees with 2 decimal places.
 * Uses en-IN locale for lakh/crore comma placement.
 * Example: 150000 → "₹1,50,000.00"
 */
const formatRupees = (amount) =>
    "₹" + Number(amount).toLocaleString("en-IN", {
        minimumFractionDigits: 2,
        maximumFractionDigits: 2,
    });

/**
 * Format a number as a short Indian Rupee string for chart axes.
 * Avoids axis label overcrowding on small screens.
 * Examples: 150000 → "₹1.5L"  |  5000 → "₹5K"  |  800 → "₹800"
 */
const formatRupeesShort = (amount) => {
    const n = Number(amount);
    if (n >= 100_000) return "₹" + (n / 100_000).toFixed(1) + "L";
    if (n >= 1_000) return "₹" + (n / 1_000).toFixed(1) + "K";
    return "₹" + n.toFixed(0);
};

/**
 * Convert "2026-07" → "July 2026"
 * Used in analytics monthly cards and summary strip.
 */
const getMonthYear = (dateString) => {
    const [year, month] = dateString.split("-");
    return new Date(year, month - 1)
        .toLocaleString("default", { month: "long", year: "numeric" });
};

/**
 * Convert "2026-07" → "Jul '26"
 * Used on chart X-axis labels where space is limited.
 */
const getMonthShort = (dateString) => {
    const [year, month] = dateString.split("-");
    const date = new Date(year, month - 1);
    return date.toLocaleString("default", { month: "short" })
        + " '" + year.slice(2);
};

/**
 * Format "2026-07-24" → "24 Jul 2026"
 * Used in the transactions table date column.
 *
 * Why not new Date(dateString)?
 *   new Date("2026-07-24") parses as UTC midnight, which shifts
 *   the date backward by one day in UTC+5:30 (IST).
 *   Splitting the string manually avoids timezone offset issues.
 */
const formatDate = (dateString) => {
    const [year, month, day] = dateString.split("-");
    return new Date(year, month - 1, day)
        .toLocaleDateString("en-GB", {
            day: "2-digit",
            month: "short",
            year: "numeric",
        });
};

/**
 * Convert a hex colour string to rgba() with a given alpha.
 * Used to create transparent backgrounds for category badges.
 * Example: hexToRgba("#EF4444", 0.12) → "rgba(239,68,68,0.12)"
 */
const hexToRgba = (hex, alpha) => {
    const r = parseInt(hex.slice(1, 3), 16);
    const g = parseInt(hex.slice(3, 5), 16);
    const b = parseInt(hex.slice(5, 7), 16);
    return `rgba(${r},${g},${b},${alpha})`;
};


/* =============================================================
   SECTION 2 — CATEGORY COLOUR MAP
   =============================================================
   Maps category names to brand colours.
   Used consistently across: badges, chart segments, bar dots.

   Why a flat object instead of a Map?
     Object literal is JSON-serialisable and easier to read.
     For this scale (< 20 categories), lookup is O(1) either way.

   Custom categories get DEFAULT_COLOR (slate-400).
   This is intentional — we cannot predict user-defined names.
   ============================================================= */

const CATEGORY_COLORS = {
    "Restaurants": "#EF4444", // red-500
    "Furniture/Home": "#10B981", // emerald-500
    "Gas/Car": "#3B82F6", // blue-500
    "Clothes": "#EC4899", // pink-500
    "School/Office Supplies": "#F59E0B", // amber-500
    "Misc": "#06B6D4", // cyan-500
    "Groceries": "#8B5CF6", // violet-500
};

const DEFAULT_COLOR = "#94A3B8"; // slate-400

const getColorFor = (category) =>
    CATEGORY_COLORS[category] || DEFAULT_COLOR;


/* =============================================================
   SECTION 3 — TOAST NOTIFICATION SYSTEM
   =============================================================
   Single toast element in base.html (#toast).
   CSS handles show/hide via the "show" class.
   GSAP animates the entrance — smoother than CSS-only.
   ============================================================= */

/**
 * Display a toast notification.
 *
 * @param {string} message — text to display
 * @param {"success"|"error"|"warning"} type — controls icon + colour
 * @param {number} duration — ms before auto-dismiss (default 3000)
 */
function showToast(message, type = "success", duration = 3000) {
    const toast = document.getElementById("toast");
    if (!toast) return;

    // Reset classes, set new type
    toast.className = `toast toast-${type}`;
    toast.textContent = message;

    // GSAP entrance animation
    // translateY starts below viewport, slides up to position
    gsap.fromTo(toast,
        { opacity: 0, y: 20 },
        {
            opacity: 1, y: 0, duration: 0.3, ease: "power2.out",
            onStart: () => toast.classList.add("show")
        }
    );

    // Auto-dismiss
    setTimeout(() => {
        gsap.to(toast, {
            opacity: 0,
            y: 10,
            duration: 0.25,
            ease: "power2.in",
            onComplete: () => toast.classList.remove("show"),
        });
    }, duration);
}


/* =============================================================
   SECTION 4 — NAVIGATION
   ============================================================= */

/**
 * Highlight the nav link that matches the current URL path.
 *
 * Compares link href to window.location.pathname.
 * Edge case: "/" matches only the exact dashboard link.
 * Sub-paths like "/add" do not accidentally match "/".
 */
function setActiveNavLink() {
    const currentPath = window.location.pathname;
    document.querySelectorAll(".nav-link").forEach((link) => {
        link.classList.toggle(
            "active",
            link.getAttribute("href") === currentPath
        );
    });
}


/* =============================================================
   SECTION 5 — DATE PICKER DEFAULT
   ============================================================= */

/**
 * Set the date input on the Add Expense form to today's date.
 *
 * Why not use input[type=date] defaulting to today natively?
 *   Browsers do not set a default value for date inputs.
 *   Users would have to manually select the date every time —
 *   most expenses are added on the day they occur.
 *
 * Why construct the string manually instead of toISOString()?
 *   toISOString() returns UTC date. In IST (UTC+5:30), a local
 *   date after midnight but before 05:30 UTC would return
 *   yesterday's date. Manual construction uses local time.
 */
// function initDatePicker() {
//     const dateInput = document.getElementById("date");
//     if (!dateInput) return;

//     const today = new Date();
//     const localDate = [
//         today.getFullYear(),
//         String(today.getMonth() + 1).padStart(2, "0"),
//         String(today.getDate()).padStart(2, "0"),
//     ].join("-");

//     dateInput.value = localDate;
// }


/* =============================================================
   SECTION 6 — ADD EXPENSE FORM
   =============================================================
   Handles form submission on the Add Expense page.

   Alpine.js manages UI state (pill selection, file name,
   button loading). This function manages the fetch call
   and communicates back to Alpine via window.formState.

   Flow:
   1. Form submit event fires
   2. e.preventDefault() stops browser default POST
   3. Read category from Alpine (getFinalCategory())
   4. Client-side validation (category presence check)
   5. Build FormData from form element
   6. Set isSubmitting = true (Alpine disables button)
   7. POST to /api/add
   8. Handle success or error
   9. Set isSubmitting = false (Alpine re-enables button)
   ============================================================= */

// function initPurchaseForm() {
//     const form = document.getElementById("purchaseForm");
//     if (!form) return;

//     form.addEventListener("submit", async (e) => {
//         e.preventDefault();

//         // ── Read category from Alpine state ──────────────────
//         // window.formState is set by x-init="window.formState = $data"
//         // on the <form> element in add.html.
//         // getFinalCategory() returns the resolved category string:
//         //   • pill selected → returns pill value
//         //   • "Other" selected → returns customCategory.trim()
//         //   • nothing selected → returns ""

//         const formState = window.formState || {};
//         const finalCategory = formState.getFinalCategory
//             ? formState.getFinalCategory()
//             : (document.getElementById("category")?.value || "");

//         // ── Client-side validation ───────────────────────────
//         // Server also validates, but this gives instant feedback
//         // without a network round-trip.

//         if (!finalCategory) {
//             showToast("Please select a category.", "error");
//             return;
//         }

//         if (formState.selectedCategory === "__other__" && !finalCategory) {
//             showToast("Please enter a custom category name.", "error");
//             return;
//         }

//         // ── Save date before reset (keep it across submissions) ──
//         const savedDate = document.getElementById("date")?.value;

//         // ── Build FormData ───────────────────────────────────
//         // FormData serialises the form including the file input.
//         // We override category with the Alpine-resolved value
//         // because the hidden input may be empty when "Other"
//         // is selected (it holds "" in that case).
//         const formData = new FormData(form);
//         formData.set("category", finalCategory);

//         // ── Set loading state via Alpine ─────────────────────
//         if (formState.isSubmitting !== undefined) {
//             formState.isSubmitting = true;
//         }

//         try {
//             const response = await fetch("/api/add", {
//                 method: "POST",
//                 body: formData,
//                 // Do NOT set Content-Type header manually.
//                 // When body is FormData, the browser sets it
//                 // automatically with the correct multipart boundary.
//             });

//             // Parse JSON regardless of status code
//             // so we can show the server's error message.
//             const result = await response.json();

//             if (response.ok && result.success) {
//                 showToast("Expense added successfully.", "success");

//                 // Show achievement notifications if any were unlocked
//                 if (result.achievements && result.achievements.length) {
//                     showAchievementToasts(result.achievements);
//                 }

//                 // ── Reset form cleanly ───────────────────────
//                 form.reset();

//                 // Restore today's date (reset clears it)
//                 if (savedDate) {
//                     const dateInput = document.getElementById("date");
//                     if (dateInput) dateInput.value = savedDate;
//                 }

//                 // Reset Alpine state
//                 if (window.formState) {
//                     window.formState.selectedCategory = "";
//                     window.formState.showCustomInput = false;
//                     window.formState.customCategory = "";
//                     window.formState.fileName = "";
//                 }

//             } else {
//                 // Server returned 400/500 with an error message
//                 const errorMsg = result.error || "Failed to add expense.";
//                 showToast(errorMsg, "error");
//             }

//         } catch (networkError) {
//             // fetch() itself threw — network failure, CORS, etc.
//             console.error("[SpendWise] add_purchase network error:", networkError);
//             showToast("Network error. Please check your connection.", "error");

//         } finally {
//             // Always re-enable the button, even on error
//             if (window.formState && window.formState.isSubmitting !== undefined) {
//                 window.formState.isSubmitting = false;
//             }
//         }
//     });
// }


/* =============================================================
   SECTION 7 — DASHBOARD STAT CARDS
   =============================================================
   Uses the new /api/stats endpoint introduced in Phase 1.

   BEFORE (original): Called /api/purchases which returned ALL
   records including base64-encoded photo BLOBs, then computed
   totals in JavaScript. Extremely wasteful.

   AFTER (Phase 1):   Single /api/stats call. Server computes
   all aggregates in SQL. Zero photo data transferred.

   GSAP count-up animation
   ────────────────────────
   Numbers animate from 0 to their final value over 1.2 seconds.
   This is done by animating a plain object's "value" property
   and updating the DOM on each frame via onUpdate.
   The effect makes the dashboard feel alive and premium.
   ============================================================= */

// function initDashboardStats() {
//     const grid = document.getElementById("statsGrid");
//     if (!grid) return;

//     fetch("/api/stats")
//         .then((r) => {
//             if (!r.ok) throw new Error(`HTTP ${r.status}`);
//             return r.json();
//         })
//         .then((data) => {
//             // Set values directly — no GSAP count-up animation
//             const totalEl = document.getElementById("statTotal");
//             if (totalEl) totalEl.textContent = formatRupees(data.total_all_time || 0);

//             const monthEl = document.getElementById("statMonth");
//             if (monthEl) monthEl.textContent = formatRupees(data.total_this_month || 0);

//             const countEl = document.getElementById("statCount");
//             if (countEl) countEl.textContent = (data.transaction_count || 0).toLocaleString("en-IN");

//             const topEl = document.getElementById("statTop");
//             if (topEl) topEl.textContent = data.top_category || "—";
//         })
//         .catch((err) => {
//             console.error("[SpendWise] initDashboardStats:", err);
//             ["statTotal", "statMonth", "statCount", "statTop"].forEach((id) => {
//                 const el = document.getElementById(id);
//                 if (el) el.textContent = "—";
//             });
//         });
// }

/**
 * Animate a stat card value from 0 to its final number using GSAP.
 *
 * @param {string}  elementId  — DOM element id to update
 * @param {number}  finalValue — the number to count up to
 * @param {boolean} isCurrency — if true, format as ₹ amount
 */
function animateStatValue(elementId, finalValue, isCurrency) {
    const el = document.getElementById(elementId);
    if (!el || finalValue === undefined || finalValue === null) return;

    // GSAP tweens a plain object's .value property.
    // onUpdate fires on every animation frame.
    // We read obj.value and write formatted text to the DOM.
    const obj = { value: 0 };

    gsap.to(obj, {
        value: Number(finalValue),
        duration: 1.2,
        ease: "power2.out",
        onUpdate: () => {
            el.textContent = isCurrency
                ? formatRupees(obj.value)
                : Math.round(obj.value).toLocaleString("en-IN");
        },
    });
}


/* =============================================================
   SECTION 8 — DASHBOARD CHARTS
   =============================================================
   Renders the monthly bar chart and all-time category
   doughnut chart on the dashboard (index.html).

   Both fetch calls are independent — they run in parallel
   implicitly because neither awaits the other.
   ============================================================= */

// function initDashboard() {
//     const lineChartCanvas = document.getElementById("monthlySpendingChart");
//     const pieChartCanvas = document.getElementById("allTimeCategoriesChart");
//     if (!lineChartCanvas && !pieChartCanvas) return;

//     // Monthly bar chart — sort ASC so months read left-to-right
//     if (lineChartCanvas) {
//         fetch("/api/monthly-totals?sort=ASC")
//             .then((r) => {
//                 if (!r.ok) throw new Error(`HTTP ${r.status}`);
//                 return r.json();
//             })
//             .then((data) => {
//                 if (Array.isArray(data) && data.length) {
//                     renderBarChart(lineChartCanvas, data);
//                 } else {
//                     showChartEmpty(lineChartCanvas, "No spending data yet.");
//                 }
//             })
//             .catch((err) => {
//                 console.error("[SpendWise] monthly chart:", err);
//                 showChartEmpty(lineChartCanvas, "Could not load chart.");
//             });
//     }

//     // Category doughnut chart
//     if (pieChartCanvas) {
//         fetch("/api/category-totals")
//             .then((r) => {
//                 if (!r.ok) throw new Error(`HTTP ${r.status}`);
//                 return r.json();
//             })
//             .then((data) => {
//                 if (Array.isArray(data) && data.length) {
//                     renderDoughnutChart(pieChartCanvas, data);
//                 } else {
//                     showChartEmpty(pieChartCanvas, "No category data yet.");
//                 }
//             })
//             .catch((err) => {
//                 console.error("[SpendWise] category chart:", err);
//                 showChartEmpty(pieChartCanvas, "Could not load chart.");
//             });
//     }
// }

/**
 * Show a centred empty/error message inside a chart container.
 * Called when the API returns empty data or fails.
 */
function showChartEmpty(canvas, message) {
    const container = canvas.parentElement;
    if (!container) return;
    canvas.style.display = "none";
    const p = document.createElement("p");
    p.className = "empty-state";
    p.textContent = message;
    container.appendChild(p);
}


/* =============================================================
   SECTION 9 — RECENT TRANSACTIONS PAGE
   =============================================================
   Phase 1 changes from original:
   ─────────────────────────────
   BEFORE: Fetched /api/purchases → got ALL records + photo BLOBs
           Computed stats from that full payload in JS.

   AFTER:  Fetches paginated /api/purchases?page=&limit=
           No photo data in the list response.
           Photos load lazily per row on demand.
           Delete button on each row calls DELETE /api/purchases/<id>
   ============================================================= */

// Module-level state for the transactions page
let allPurchases = [];
let activeCategory = "all";
let searchQuery = "";
let currentPage = 1;
const PAGE_LIMIT = 20;

function initRecentTransactions() {
    const table = document.getElementById("purchasesTable");
    if (!table) return;

    loadTransactions(1);
}

/**
 * Fetch one page of transactions and render the table.
 * @param {number} page — 1-based page number
 */
function loadTransactions(page = 1) {
    currentPage = page;

    const params = new URLSearchParams({
        page: page,
        limit: PAGE_LIMIT,
    });

    fetch(`/api/purchases?${params}`)
        .then((r) => {
            if (!r.ok) throw new Error(`HTTP ${r.status}`);
            return r.json();
        })
        .then((data) => {
            allPurchases = data.purchases || [];
            buildFilterChips();
            setupSearch();
            renderPurchases();
            renderPagination(data.total, data.page, data.pages);
        })
        .catch((err) => {
            console.error("[SpendWise] loadTransactions:", err);
            showTableError("Could not load transactions. Please refresh.");
        });
}

/** Build category filter chips from the loaded data. */
function buildFilterChips() {
    const container = document.getElementById("filterChips");
    if (!container) return;

    // Keep "All" chip, remove any previously built category chips
    container
        .querySelectorAll(".filter-chip:not([data-category='all'])")
        .forEach((c) => c.remove());

    const categories = [...new Set(allPurchases.map((p) => p.category))];

    categories.forEach((cat) => {
        const chip = document.createElement("button");
        chip.className = "filter-chip";
        chip.dataset.category = cat;
        chip.innerHTML = `
            <span class="chip-dot" style="background:${getColorFor(cat)}"></span>
            ${escapeHtml(cat)}`;
        container.appendChild(chip);
    });

    // Attach click handlers to ALL chips (including "All")
    container.querySelectorAll(".filter-chip").forEach((chip) => {
        chip.addEventListener("click", () => {
            container.querySelectorAll(".filter-chip")
                .forEach((c) => c.classList.remove("active"));
            chip.classList.add("active");
            activeCategory = chip.dataset.category;
            renderPurchases();
        });
    });
}

/** Wire up the search input with debouncing. */
function setupSearch() {
    const input = document.getElementById("searchInput");
    if (!input) return;

    // Debounce: wait 250ms after the user stops typing
    // before filtering. Prevents re-rendering on every keystroke.
    let debounceTimer;
    input.addEventListener("input", (e) => {
        clearTimeout(debounceTimer);
        debounceTimer = setTimeout(() => {
            searchQuery = e.target.value.trim().toLowerCase();
            renderPurchases();
        }, 250);
    });
}

/**
 * Filter allPurchases by activeCategory + searchQuery
 * and render the result into the table body.
 *
 * XSS fix (Phase 1):
 *   Original used innerHTML with raw data from the database.
 *   Any business name or description containing <script> tags
 *   would execute in the browser.
 *   Fix: escapeHtml() sanitises all user-supplied strings
 *   before they are injected into innerHTML.
 */
function renderPurchases() {
    const tbody = document.querySelector("#purchasesTable tbody");
    const countEl = document.getElementById("resultsCount");
    if (!tbody) return;

    let filtered = allPurchases;

    // Category filter
    if (activeCategory !== "all") {
        filtered = filtered.filter((p) => p.category === activeCategory);
    }

    // Text search across business, category, description
    if (searchQuery) {
        filtered = filtered.filter((p) =>
            (p.business || "").toLowerCase().includes(searchQuery) ||
            (p.category || "").toLowerCase().includes(searchQuery) ||
            (p.description || "").toLowerCase().includes(searchQuery)
        );
    }

    // Update results count
    if (countEl) {
        countEl.textContent = filtered.length
            ? `${filtered.length} transaction${filtered.length !== 1 ? "s" : ""}`
            : "";
    }

    tbody.innerHTML = "";

    if (!filtered.length) {
        tbody.innerHTML = `
            <tr>
                <td colspan="6" class="empty-state">
                    No matching transactions found.
                </td>
            </tr>`;
        return;
    }

    filtered.forEach((p) => {
        const row = document.createElement("tr");
        row.dataset.id = p.id;

        // Escape all user-supplied strings before DOM insertion
        const safeBusiness = escapeHtml(p.business || "");
        const safeCategory = escapeHtml(p.category || "");
        const safeDescription = escapeHtml(p.description || "—");

        const color = getColorFor(p.category);
        const badgeBg = hexToRgba(color, 0.12);

        row.innerHTML = `
            <td class="td-date">${formatDate(p.date)}</td>
            <td class="td-business">${safeBusiness}</td>
            <td>
                <span class="category-badge"
                      style="background:${badgeBg}; color:${color};">
                    ${safeCategory}
                </span>
            </td>
            <td class="td-notes">${safeDescription}</td>
            <td class="td-amount">${formatRupees(p.amount)}</td>
            <td class="td-actions">
                ${p.has_photo
                ? `<button class="btn-receipt"
                               data-id="${p.id}"
                               title="View receipt"
                               aria-label="View receipt for ${safeBusiness}">
                           <svg xmlns="http://www.w3.org/2000/svg" width="14" height="14"
                                viewBox="0 0 24 24" fill="none" stroke="currentColor"
                                stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                               <rect x="3" y="3" width="18" height="18" rx="2"/>
                               <circle cx="8.5" cy="8.5" r="1.5"/>
                               <polyline points="21 15 16 10 5 21"/>
                           </svg>
                       </button>`
                : "<span class='td-no-receipt'>—</span>"
            }
                <button class="btn-delete"
                        data-id="${p.id}"
                        title="Delete expense"
                        aria-label="Delete expense for ${safeBusiness}">
                    <svg xmlns="http://www.w3.org/2000/svg" width="14" height="14"
                         viewBox="0 0 24 24" fill="none" stroke="currentColor"
                         stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                        <polyline points="3 6 5 6 21 6"/>
                        <path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6"/>
                        <path d="M10 11v6M14 11v6"/>
                        <path d="M9 6V4a1 1 0 0 1 1-1h4a1 1 0 0 1 1 1v2"/>
                    </svg>
                </button>
            </td>`;

        tbody.appendChild(row);
    });

    // Attach delete handlers after rows are in the DOM
    attachDeleteHandlers();
    // Attach receipt view handlers
    attachReceiptHandlers();

    // GSAP stagger rows in
    gsap.from("#purchasesTable tbody tr", {
        opacity: 0,
        y: 8,
        duration: 0.3,
        stagger: 0.03,
        ease: "power1.out",
    });
}

/** Attach click → delete flow to all delete buttons in the table. */
function attachDeleteHandlers() {
    document.querySelectorAll(".btn-delete").forEach((btn) => {
        btn.addEventListener("click", async () => {
            const id = btn.dataset.id;
            if (!id) return;

            // Inline confirmation — no window.confirm (blocks UI)
            // We use a data attribute to track confirmation state.
            if (btn.dataset.confirming !== "true") {
                btn.dataset.confirming = "true";
                btn.title = "Click again to confirm delete";
                btn.style.color = "var(--danger)";

                // Auto-cancel confirmation after 3 seconds
                setTimeout(() => {
                    btn.dataset.confirming = "false";
                    btn.title = "Delete expense";
                    btn.style.color = "";
                }, 3000);
                return;
            }

            // Second click — confirmed, proceed with delete
            try {
                const response = await fetch(`/api/purchases/${id}`, {
                    method: "DELETE",
                });

                if (response.ok) {
                    // Animate row out before removing
                    const row = document.querySelector(`tr[data-id="${id}"]`);
                    if (row) {
                        gsap.to(row, {
                            opacity: 0,
                            x: -20,
                            duration: 0.25,
                            onComplete: () => {
                                row.remove();
                                // Update local array
                                allPurchases = allPurchases.filter(
                                    (p) => String(p.id) !== String(id)
                                );
                                // Update count display
                                renderPurchases();
                            },
                        });
                    }
                    showToast("Expense deleted.", "success");
                } else {
                    const result = await response.json();
                    showToast(result.error || "Could not delete expense.", "error");
                }
            } catch (err) {
                console.error("[SpendWise] delete:", err);
                showToast("Network error. Please try again.", "error");
            }
        });
    });
}

/**
 * Attach click handlers to receipt view buttons.
 * Fetches the photo lazily only when the user clicks the button.
 * Opens the image in a lightweight inline lightbox.
 */
function attachReceiptHandlers() {
    document.querySelectorAll(".btn-receipt").forEach((btn) => {
        btn.addEventListener("click", async () => {
            const id = btn.dataset.id;
            if (!id) return;

            try {
                btn.disabled = true;
                const r = await fetch(`/api/purchases/${id}/photo`);
                const data = await r.json();

                if (data.photo) {
                    openReceiptLightbox(data.photo);
                } else {
                    showToast("No receipt photo available.", "warning");
                }
            } catch (err) {
                console.error("[SpendWise] receipt fetch:", err);
                showToast("Could not load receipt.", "error");
            } finally {
                btn.disabled = false;
            }
        });
    });
}

/**
 * Open a simple lightbox overlay to display a receipt image.
 * Click anywhere to close.
 */
function openReceiptLightbox(base64Data) {
    // Remove any existing lightbox
    document.getElementById("receiptLightbox")?.remove();

    const overlay = document.createElement("div");
    overlay.id = "receiptLightbox";
    overlay.className = "lightbox-overlay";
    overlay.innerHTML = `
        <div class="lightbox-inner">
            <button class="lightbox-close" aria-label="Close receipt">
                <svg xmlns="http://www.w3.org/2000/svg" width="20" height="20"
                     viewBox="0 0 24 24" fill="none" stroke="currentColor"
                     stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                    <line x1="18" y1="6" x2="6" y2="18"/>
                    <line x1="6" y1="6" x2="18" y2="18"/>
                </svg>
            </button>
            <img src="data:image/jpeg;base64,${base64Data}"
                 alt="Receipt"
                 class="lightbox-img">
        </div>`;

    document.body.appendChild(overlay);

    // Animate in
    gsap.from(".lightbox-inner", {
        opacity: 0,
        scale: 0.92,
        duration: 0.25,
        ease: "power2.out",
    });

    // Close handlers
    overlay.addEventListener("click", (e) => {
        if (e.target === overlay || e.target.closest(".lightbox-close")) {
            gsap.to(".lightbox-inner", {
                opacity: 0,
                scale: 0.92,
                duration: 0.2,
                onComplete: () => overlay.remove(),
            });
        }
    });

    // Keyboard close
    document.addEventListener("keydown", function handler(e) {
        if (e.key === "Escape") {
            overlay.remove();
            document.removeEventListener("keydown", handler);
        }
    });
}

/** Show an error message inside the table body. */
function showTableError(message) {
    const tbody = document.querySelector("#purchasesTable tbody");
    if (!tbody) return;
    tbody.innerHTML = `
        <tr>
            <td colspan="6" class="empty-state" style="color:var(--danger);">
                ${escapeHtml(message)}
            </td>
        </tr>`;
}

/** Render prev / next pagination controls below the table. */
function renderPagination(total, page, pages) {
    let container = document.getElementById("pagination");
    if (!container) {
        container = document.createElement("div");
        container.id = "pagination";
        container.className = "pagination";
        document.querySelector("#purchasesTable")
            ?.parentElement
            ?.appendChild(container);
    }

    container.innerHTML = "";

    if (pages <= 1) return; // No pagination needed

    const info = document.createElement("span");
    info.className = "pagination-info";
    info.textContent = `Page ${page} of ${pages} · ${total} total`;
    container.appendChild(info);

    const btnGroup = document.createElement("div");
    btnGroup.className = "pagination-buttons";

    // Previous button
    const prevBtn = document.createElement("button");
    prevBtn.className = "btn-page";
    prevBtn.textContent = "← Previous";
    prevBtn.disabled = page <= 1;
    prevBtn.addEventListener("click", () => loadTransactions(page - 1));
    btnGroup.appendChild(prevBtn);

    // Next button
    const nextBtn = document.createElement("button");
    nextBtn.className = "btn-page";
    nextBtn.textContent = "Next →";
    nextBtn.disabled = page >= pages;
    nextBtn.addEventListener("click", () => loadTransactions(page + 1));
    btnGroup.appendChild(nextBtn);

    container.appendChild(btnGroup);
}


/* =============================================================
   SECTION 10 — ANALYTICS PAGE
   =============================================================
   Phase 1 fix: N+1 fetch problem.

   BEFORE: For 12 months of data, this page made 14 HTTP
   requests (2 initial + 1 per month for category breakdown).

   AFTER: Still uses per-month fetches for pie charts but now
   wrapped in Promise.all to run them all in parallel rather
   than sequentially. True fix (single endpoint returning all
   months + categories) is Phase 2 architecture work.
   ============================================================= */

function initMonthlyAnalytics() {
    const overview = document.getElementById("monthlyOverview");
    if (!overview) return;

    Promise.all([
        fetch("/api/monthly-totals").then((r) => {
            if (!r.ok) throw new Error(`HTTP ${r.status}`);
            return r.json();
        }),
        fetch("/api/category-totals").then((r) => {
            if (!r.ok) throw new Error(`HTTP ${r.status}`);
            return r.json();
        }),
    ])
        .then(([months, categories]) => {
            if (!months.length) {
                renderAnalyticsEmpty(overview);
                return;
            }

            renderAnalyticsSummary(months, categories);
            renderCategoryBreakdown(categories);
            renderMonthlyCards(months, overview);
        })
        .catch((err) => {
            console.error("[SpendWise] initMonthlyAnalytics:", err);
            overview.innerHTML = `
            <p class="empty-state" style="color:var(--danger);">
                Could not load analytics. Please refresh.
            </p>`;
        });
}

/** Show empty state when no data exists. */
function renderAnalyticsEmpty(container) {
    container.innerHTML = `
        <p class="empty-state">
            No expenses recorded yet. Add one to see analytics.
        </p>`;

    const summary = document.getElementById("analyticsSummary");
    if (summary) summary.style.display = "none";

    document.querySelectorAll(".analytics-card, .section-title")
        .forEach((el) => (el.style.display = "none"));
}

/** Populate the top summary stat cards on the analytics page. */
function renderAnalyticsSummary(months, categories) {
    const highest = months.reduce((a, b) => (a.total > b.total ? a : b));

    const setEl = (id, text) => {
        const el = document.getElementById(id);
        if (el) el.textContent = text;
    };

    setEl("statHighestMonth", getMonthYear(highest.month));
    setEl("statHighestMonthAmount", formatRupees(highest.total));

    if (categories.length) {
        setEl("statTopCategory", categories[0].category);
        setEl("statTopCategoryAmount", formatRupees(categories[0].category_amount));
    }

    const total = months.reduce((sum, m) => sum + m.total, 0);
    setEl("statAverage", formatRupees(total / months.length));
}

/** Render horizontal bar breakdown for each category. */
function renderCategoryBreakdown(categories) {
    const container = document.getElementById("categoryBreakdown");
    if (!container || !categories.length) return;

    const total = categories.reduce((sum, c) => sum + c.category_amount, 0);
    const maxAmount = Math.max(...categories.map((c) => c.category_amount));

    container.innerHTML = "";

    categories.forEach((cat, index) => {
        const percent = ((cat.category_amount / total) * 100).toFixed(1);
        const barWidth = (cat.category_amount / maxAmount) * 100;
        const color = getColorFor(cat.category);

        const row = document.createElement("div");
        row.className = "breakdown-row";
        row.innerHTML = `
            <div class="breakdown-label">
                <span class="breakdown-dot" style="background:${color}"></span>
                <span class="breakdown-name">${escapeHtml(cat.category)}</span>
            </div>
            <div class="breakdown-bar-wrapper">
                <div class="breakdown-bar"
                     style="width:0%; background:${color}"
                     data-width="${barWidth}">
                </div>
            </div>
            <div class="breakdown-values">
                <span class="breakdown-amount">
                    ${formatRupees(cat.category_amount)}
                </span>
                <span class="breakdown-percent">${percent}%</span>
            </div>`;

        container.appendChild(row);

        // Animate bar width in with stagger
        const bar = row.querySelector(".breakdown-bar");
        gsap.to(bar, {
            width: `${barWidth}%`,
            duration: 0.7,
            delay: index * 0.06,
            ease: "power2.out",
        });
    });
}

/** Create monthly summary cards and kick off per-month pie charts. */
function renderMonthlyCards(months, container) {
    // Fetch all months' category data in parallel (fix N+1)
    const fetches = months.map((item) =>
        fetch(`/api/category-totals?month=${item.month}`)
            .then((r) => r.json())
            .then((cats) => ({ month: item.month, total: item.total, cats }))
    );

    Promise.all(fetches).then((results) => {
        results.forEach((result, index) => {
            const card = createMonthCard(result.month, result.total);
            container.appendChild(card);

            const canvas = card.querySelector("canvas");
            if (result.cats.length) {
                renderDoughnutChart(canvas, result.cats);
            }

            // Update top category label
            const topCatEl = card.querySelector(".overview-top-category");
            if (result.cats.length && topCatEl) {
                const top = result.cats[0];
                const color = getColorFor(top.category);
                topCatEl.innerHTML = `
                    <span class="top-cat-label">Top:</span>
                    <span class="top-cat-dot" style="background:${color}"></span>
                    <span class="top-cat-name">${escapeHtml(top.category)}</span>`;
            }

            // Stagger card entrance
            gsap.from(card, {
                opacity: 0,
                y: 20,
                duration: 0.4,
                delay: index * 0.07,
                ease: "power2.out",
            });
        });
    });
}

/** Create and return a monthly summary card DOM element. */
function createMonthCard(month, total) {
    const card = document.createElement("div");
    card.className = "overview-item";
    card.innerHTML = `
        <div class="overview-header">
            <span class="month-name">${getMonthYear(month)}</span>
            <span class="total-amount">${formatRupees(total)}</span>
        </div>
        <div class="pie-chart-container">
            <canvas></canvas>
        </div>
        <div class="overview-top-category" data-month="${month}"></div>`;
    return card;
}


/* =============================================================
   SECTION 11 — CHART RENDERERS
   =============================================================
   Two reusable chart functions used across dashboard
   and analytics pages.

   Chart.js is NOT loaded in base.html — it is loaded only
   on pages that need it (index.html, monthly.html) via
   the extra_js block. These functions will only be called
   on those pages, so Chart will always be defined.
   ============================================================= */

/**
 * Render a doughnut chart on the given canvas.
 * Used on: dashboard (all-time), analytics (per-month cards).
 *
 * Theme: Warm diary palette
 *   - Segment borders match card background (#231f1b)
 *   - Legend text in warm secondary (#b8a99a)
 *   - Tooltip background in deep warm black
 *   - Font: DM Sans (matches global --font-sans)
 *
 * @param {HTMLCanvasElement} canvas
 * @param {Array} data — [{category, category_amount}, ...]
 */
function renderDoughnutChart(canvas, data) {
    const categories = data.map((d) => d.category);
    const totals = data.map((d) => d.category_amount);
    const colors = categories.map(getColorFor);

    new Chart(canvas, {
        type: "doughnut",
        data: {
            labels: categories,
            datasets: [{
                data: totals,
                backgroundColor: colors,
                borderWidth: 3,
                borderColor: "#231f1b",    // matches --bg-surface
                hoverOffset: 8,
            }],
        },
        options: {
            responsive: true,
            maintainAspectRatio: false,
            cutout: "62%",
            animation: {
                animateRotate: true,
                duration: 700,
            },
            plugins: {
                legend: {
                    position: "bottom",
                    labels: {
                        boxWidth: 10,
                        boxHeight: 10,
                        padding: 14,
                        font: { size: 12, family: "DM Sans" },
                        color: "#b8a99a",   // --text-secondary
                        usePointStyle: true,
                        pointStyle: "circle",
                    },
                },
                tooltip: {
                    backgroundColor: "#1a1614",     // --bg-primary
                    borderColor: "rgba(255,235,210,0.1)",
                    borderWidth: 1,
                    padding: 12,
                    titleFont: { size: 13, family: "DM Sans", weight: "600" },
                    bodyFont: { size: 12, family: "JetBrains Mono" },
                    titleColor: "#f5ede6",     // --text-primary
                    bodyColor: "#b8a99a",     // --text-secondary
                    cornerRadius: 8,
                    callbacks: {
                        label: (ctx) => ` ${formatRupees(ctx.parsed)}`,
                    },
                },
            },
        },
    });
}


/**
 * Render the monthly spending bar chart on the dashboard.
 * Highlights the highest-spend month in a different colour.
 * Draws an average line using chartjs-plugin-annotation.
 *
 * Theme: Warm diary palette
 *   - Primary bars: amber/gold gradient (--accent → lighter)
 *   - Highlight bar (highest month): warm green
 *   - Grid lines: very subtle warm white
 *   - Average line: amber at 25% opacity
 *   - Axis text: warm muted (#7d6e60)
 *   - Tooltip: deep warm background with warm text
 *   - Font: DM Sans for labels, JetBrains Mono for values
 *
 * @param {HTMLCanvasElement} canvas
 * @param {Array} data — [{month, total, count}, ...]
 */
function renderBarChart(canvas, data) {
    const totals = data.map((d) => d.total);
    const average = totals.reduce((a, b) => a + b, 0) / totals.length;
    const maxVal = Math.max(...totals);

    // Update subtitle below chart title
    const subtitle = document.getElementById("chartSubtitle");
    if (subtitle) {
        subtitle.textContent = `Avg ${formatRupees(average)} / month`;
    }

    // Gradient colours for bars — warm amber tones
    const ctx = canvas.getContext("2d");

    // Primary gradient: warm gold → lighter gold
    const primaryGradient = ctx.createLinearGradient(0, 0, 0, 300);
    primaryGradient.addColorStop(0, "#d4a647");    // --accent
    primaryGradient.addColorStop(1, "#c9886e");    // --rose (warm fade)

    // Highlight gradient: warm green for highest month
    const highlightGradient = ctx.createLinearGradient(0, 0, 0, 300);
    highlightGradient.addColorStop(0, "#7bc47f");  // --success
    highlightGradient.addColorStop(1, "#a3b86c");  // --score-good

    const barColors = totals.map((v) =>
        v === maxVal ? highlightGradient : primaryGradient
    );

    new Chart(canvas, {
        type: "bar",
        data: {
            labels: data.map((d) => getMonthShort(d.month)),
            datasets: [{
                label: "Spent",
                data: totals,
                backgroundColor: barColors,
                borderRadius: 8,
                borderSkipped: false,
                barThickness: 28,
                maxBarThickness: 40,
            }],
        },
        options: {
            responsive: true,
            maintainAspectRatio: false,
            interaction: { intersect: false, mode: "index" },
            animation: { duration: 700, easing: "easeOutQuart" },
            plugins: {
                legend: { display: false },
                tooltip: {
                    backgroundColor: "#1a1614",     // --bg-primary
                    borderColor: "rgba(255,235,210,0.1)",
                    borderWidth: 1,
                    padding: 12,
                    titleFont: { size: 13, family: "DM Sans", weight: "600" },
                    bodyFont: { size: 12, family: "JetBrains Mono" },
                    titleColor: "#f5ede6",     // --text-primary
                    bodyColor: "#d4a647",     // --accent (golden numbers)
                    cornerRadius: 8,
                    displayColors: false,
                    callbacks: {
                        label: (ctx) => "Spent: " + formatRupees(ctx.parsed.y),
                    },
                },
                annotation: {
                    annotations: {
                        avgLine: {
                            type: "line",
                            yMin: average,
                            yMax: average,
                            borderColor: "rgba(212,166,71,0.25)", // amber subtle
                            borderWidth: 1.5,
                            borderDash: [6, 6],
                            label: {
                                display: true,
                                content: "Avg " + formatRupeesShort(average),
                                position: "end",
                                backgroundColor: "rgba(35,31,27,0.95)", // --bg-surface
                                color: "#d4a647",             // --accent
                                font: {
                                    size: 10,
                                    family: "JetBrains Mono",
                                    weight: "600",
                                },
                                padding: { top: 4, bottom: 4, left: 8, right: 8 },
                                borderRadius: 6,
                            },
                        },
                    },
                },
            },
            scales: {
                x: {
                    grid: { display: false },
                    border: { display: false },
                    ticks: {
                        color: "#7d6e60",           // --text-muted
                        font: { size: 11, family: "DM Sans" },
                    },
                },
                y: {
                    beginAtZero: true,
                    grid: {
                        color: "rgba(255,235,210,0.04)", // warm subtle lines
                        drawTicks: false,
                    },
                    border: { display: false },
                    ticks: {
                        color: "#7d6e60",         // --text-muted
                        font: { size: 11, family: "JetBrains Mono" },
                        padding: 8,
                        callback: (v) => formatRupeesShort(v),
                    },
                },
            },
        },
    });
}

/* =============================================================
   SECTION 12 — SECURITY UTILITY
   =============================================================
   escapeHtml() is the fix for the XSS vulnerability in the
   original renderPurchases() which used innerHTML with raw
   database values.

   How XSS works here (original vulnerability):
     If a user saved a business name as:
       <img src=x onerror="alert('XSS')">
     The original code did:
       row.innerHTML = `<td>${p.business}</td>`
     Which would execute the onerror handler in the browser.

   Fix: escapeHtml() converts < > " ' & into their HTML
   entity equivalents before inserting into innerHTML.
   The browser then renders them as literal characters,
   not as HTML tags or event handlers.
   ============================================================= */

/**
 * Escape a string for safe insertion into innerHTML.
 * Prevents XSS from user-supplied data.
 *
 * @param {string} str — raw string from API response
 * @returns {string}   — HTML-safe string
 */
function escapeHtml(str) {
    if (!str) return "";
    return String(str)
        .replace(/&/g, "&amp;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;")
        .replace(/"/g, "&quot;")
        .replace(/'/g, "&#39;");
}

/* =============================================================
   SECTION 13 — NATURAL LANGUAGE INPUT
   =============================================================
   Handles the NLP text box on the Add Expense page.

   Flow:
   1. User types in the NLP input box
   2. After 600ms of inactivity (debounce), send to /api/insights/parse-nlp
   3. Receive structured result
   4. Pre-populate form fields with parsed values
   5. Show confidence indicators next to each field
   6. User can override any pre-populated field manually

   The NLP box is additive — it never blocks manual entry.
   If parsing fails or confidence is low, the user simply
   fills the form normally.
   ============================================================= */

// function initNaturalLanguageInput() {
//     const nlpInput = document.getElementById("nlpInput");
//     if (!nlpInput) return;

//     let nlpDebounce;

//     nlpInput.addEventListener("input", () => {
//         const text = nlpInput.value.trim();

//         // Clear previous indicators
//         clearNlpIndicators();

//         if (text.length < 4) return;

//         // Debounce — wait 600ms after user stops typing
//         clearTimeout(nlpDebounce);
//         nlpDebounce = setTimeout(async () => {

//             // Show parsing indicator
//             const indicator = document.getElementById("nlpIndicator");
//             if (indicator) {
//                 indicator.textContent = "Parsing…";
//                 indicator.className = "nlp-indicator nlp-parsing";
//             }

//             try {
//                 const response = await fetch("/api/insights/parse-nlp", {
//                     method: "POST",
//                     headers: { "Content-Type": "application/json" },
//                     body: JSON.stringify({ text }),
//                 });

//                 const result = await response.json();

//                 if (!response.ok || !result.parsed_ok) {
//                     if (indicator) {
//                         indicator.textContent = "Could not parse — fill manually";
//                         indicator.className = "nlp-indicator nlp-error";
//                     }
//                     return;
//                 }

//                 // Pre-populate form fields
//                 populateFromNlp(result);

//                 if (indicator) {
//                     indicator.textContent = "✓ Fields pre-filled — review and confirm";
//                     indicator.className = "nlp-indicator nlp-success";
//                 }

//             } catch (err) {
//                 console.error("[SpendWise] NLP parse error:", err);
//                 if (indicator) {
//                     indicator.textContent = "Parse failed — fill manually";
//                     indicator.className = "nlp-indicator nlp-error";
//                 }
//             }

//         }, 600);
//     });
// }

/**
 * Pre-populate the Add Expense form fields with NLP parse results.
 * Only populates fields where confidence is not "none".
 * Never overwrites a field the user has already manually edited.
 *
 * @param {Object} result — parsed NLP result from API
 */
function populateFromNlp(result) {
    // Amount
    if (result.amount && result.confidence.amount !== "none") {
        const amountInput = document.getElementById("amount");
        if (amountInput && !amountInput.dataset.manuallyEdited) {
            amountInput.value = result.amount.toFixed(2);
            highlightField(amountInput);
        }
    }

    // Date
    if (result.date && result.confidence.date !== "default") {
        const dateInput = document.getElementById("date");
        if (dateInput && !dateInput.dataset.manuallyEdited) {
            dateInput.value = result.date;
            highlightField(dateInput);
        }
    }

    // Business
    if (result.business && result.confidence.business !== "none") {
        const bizInput = document.getElementById("business");
        if (bizInput && !bizInput.dataset.manuallyEdited) {
            bizInput.value = result.business;
            highlightField(bizInput);
        }
    }

    // Category — update Alpine state if confidence is good
    if (result.category && result.confidence.category !== "none") {
        if (window.formState && result.category !== "__other__") {
            window.formState.selectCategory(result.category);

            // Also visually highlight the selected pill
            document.querySelectorAll(".category-pill").forEach((pill) => {
                if (pill.dataset.category === result.category) {
                    gsap.from(pill, {
                        scale: 0.95,
                        duration: 0.2,
                        ease: "back.out(2)",
                    });
                }
            });
        }
    }
}

/**
 * Briefly highlight a form field that was auto-populated.
 * Uses a CSS class that fades out — visual feedback that
 * the field was populated programmatically.
 */
function highlightField(input) {
    input.classList.add("nlp-populated");

    // Track that this field had a value suggested by NLP
    // but has not yet been manually edited
    input.dataset.nlpSuggested = "true";

    // Remove highlight after animation completes
    setTimeout(() => input.classList.remove("nlp-populated"), 1500);

    // GSAP micro-animation
    gsap.from(input, {
        backgroundColor: "rgba(79, 70, 229, 0.08)",
        duration: 0.6,
        ease: "power2.out",
    });

    // Mark as manually edited on user input
    // so future NLP suggestions don't overwrite it
    input.addEventListener("input", () => {
        input.dataset.manuallyEdited = "true";
    }, { once: true });
}

/** Clear NLP confidence indicators. */
function clearNlpIndicators() {
    const indicator = document.getElementById("nlpIndicator");
    if (indicator) {
        indicator.textContent = "";
        indicator.className = "nlp-indicator";
    }
}


/* =============================================================
   SECTION 14 — ACHIEVEMENT TOAST NOTIFICATIONS
   =============================================================
   After a successful expense add, the API returns an
   "achievements" array with any newly unlocked achievements.

   This function is called from initPurchaseForm() after
   a successful response. It shows a special achievement
   toast for each newly unlocked item with a slight delay
   between multiple unlocks.
   ============================================================= */

/**
 * Display achievement unlock notifications.
 * Called after successful expense submission.
 *
 * @param {Array} achievements — array of newly unlocked achievement objects
 */
function showAchievementToasts(achievements) {
    if (!achievements || !achievements.length) return;

    achievements.forEach((achievement, index) => {
        // Stagger multiple achievement toasts 1.5 seconds apart
        setTimeout(() => {
            showAchievementToast(achievement);
        }, index * 1500);
    });
}

/**
 * Show a single achievement unlock toast.
 * Uses a dedicated achievement toast style — distinct from
 * regular success/error toasts.
 *
 * @param {Object} achievement — { title, description, icon, points }
 */
function showAchievementToast(achievement) {
    // Create a dedicated achievement toast element
    // (separate from the regular #toast element)
    const existing = document.getElementById("achievementToast");
    if (existing) existing.remove();

    const toast = document.createElement("div");
    toast.id = "achievementToast";
    toast.className = "toast toast-achievement";
    toast.innerHTML = `
        <div class="achievement-toast-inner">
            <div class="achievement-toast-icon">
                <svg xmlns="http://www.w3.org/2000/svg" width="18" height="18"
                     viewBox="0 0 24 24" fill="none" stroke="currentColor"
                     stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                    <circle cx="12" cy="8" r="6"/>
                    <path d="M15.477 12.89L17 22l-5-3-5 3 1.523-9.11"/>
                </svg>
            </div>
            <div class="achievement-toast-text">
                <span class="achievement-toast-title">
                    Achievement Unlocked
                </span>
                <span class="achievement-toast-name">
                    ${escapeHtml(achievement.title)}
                </span>
                <span class="achievement-toast-desc">
                    ${escapeHtml(achievement.description)}
                </span>
            </div>
            <div class="achievement-toast-points">
                +${achievement.points}
            </div>
        </div>`;

    document.body.appendChild(toast);

    // Animate in with GSAP
    gsap.fromTo(toast,
        { opacity: 0, y: 30, scale: 0.95 },
        {
            opacity: 1,
            y: 0,
            scale: 1,
            duration: 0.4,
            ease: "back.out(1.5)",
            onStart: () => toast.classList.add("show"),
        }
    );

    // Auto dismiss after 4 seconds
    setTimeout(() => {
        gsap.to(toast, {
            opacity: 0,
            y: 10,
            duration: 0.3,
            ease: "power2.in",
            onComplete: () => toast.remove(),
        });
    }, 4000);
}

/* =============================================================
   SECTION 15 — DASHBOARD: Health Score
   =============================================================
   Fetches /api/insights/health-score and renders the hero
   health score card with animated SVG ring and component bars.
   ============================================================= */

// function initHealthScore() {
//     const card = document.getElementById("healthScoreCard");
//     if (!card) return;

//     fetch("/api/insights/health-score")
//         .then((r) => {
//             if (!r.ok) throw new Error(`HTTP ${r.status}`);
//             return r.json();
//         })
//         .then((data) => {
//             const score = data.score || 0;
//             const color = data.color || "#94A3B8";

//             // ── Animate score number ─────────────────────────
//             const scoreEl = document.getElementById("healthScoreValue");
//             if (scoreEl) {
//                 const obj = { value: 0 };
//                 gsap.to(obj, {
//                     value: score,
//                     duration: 1.5,
//                     ease: "power2.out",
//                     onUpdate: () => {
//                         scoreEl.textContent = Math.round(obj.value);
//                     },
//                 });
//             }

//             // ── Animate SVG ring fill ────────────────────────
//             // Circumference = 2 * π * 48 ≈ 301.6
//             // dashoffset = circumference × (1 - score/100)
//             const ring = document.getElementById("healthRingFill");
//             if (ring) {
//                 ring.style.stroke = color;
//                 const circumference = 301.6;
//                 const target = circumference * (1 - score / 100);
//                 gsap.to(ring, {
//                     strokeDashoffset: target,
//                     duration: 1.5,
//                     ease: "power2.out",
//                     delay: 0.2,
//                 });
//             }

//             // ── Label + summary ──────────────────────────────
//             const labelEl = document.getElementById("healthScoreLabel");
//             if (labelEl) {
//                 labelEl.textContent = data.label || "—";
//                 labelEl.style.color = color;
//             }

//             const summaryEl = document.getElementById("healthScoreSummary");
//             if (summaryEl) {
//                 summaryEl.textContent = data.summary || "";
//             }

//             // ── Component bars ───────────────────────────────
//             const components = data.components || {};
//             renderHealthComponent("Budget", components.budget_adherence, "hcBarBudget", "hcScoreBudget");
//             renderHealthComponent("Trend", components.spending_trend, "hcBarTrend", "hcScoreTrend");
//             renderHealthComponent("Consistency", components.consistency, "hcBarConsistency", "hcScoreConsistency");
//             renderHealthComponent("Savings", components.savings_potential, "hcBarSavings", "hcScoreSavings");

//             // ── Animate card in ──────────────────────────────
//             // gsap.from(card, {
//             //     opacity: 0,
//             //     y: 20,
//             //     duration: 0.6,
//             //     ease: "power2.out",
//             // });
//         })
//         .catch((err) => {
//             console.error("[SpendWise] Health score:", err);
//             const scoreEl = document.getElementById("healthScoreValue");
//             if (scoreEl) scoreEl.textContent = "—";
//         });
// }

/**
 * Render a single health score component bar.
 *
 * @param {string} name     — component name
 * @param {Object} comp     — { score, max, label }
 * @param {string} barId    — DOM id of the bar div
 * @param {string} scoreId  — DOM id of the score text span
 */
function renderHealthComponent(name, comp, barId, scoreId) {
    if (!comp) return;

    const bar = document.getElementById(barId);
    const scoreEl = document.getElementById(scoreId);

    if (scoreEl) {
        scoreEl.textContent = `${comp.score} / ${comp.max}`;
    }

    if (bar) {
        const pct = comp.max > 0 ? (comp.score / comp.max) * 100 : 0;
        gsap.to(bar, {
            width: `${pct}%`,
            duration: 1.0,
            delay: 0.3,
            ease: "power2.out",
        });
    }
}


/* =============================================================
   SECTION 16 — DASHBOARD: Spending Personality
   ============================================================= */

// function initPersonality() {
//     const card = document.getElementById("personalityCard");
//     if (!card) return;

//     fetch("/api/insights/personality")
//         .then((r) => {
//             if (!r.ok) throw new Error(`HTTP ${r.status}`);
//             return r.json();
//         })
//         .then((data) => {
//             const badge = document.getElementById("personalityBadge");
//             const desc = document.getElementById("personalityDesc");
//             const tip = document.getElementById("personalityTip");

//             if (badge && data.type) {
//                 badge.textContent = data.type;
//                 badge.style.color = data.color || "var(--text-muted)";
//                 badge.style.borderColor = data.color || "var(--border-default)";
//                 badge.style.background = data.color
//                     ? hexToRgba(data.color, 0.1)
//                     : "transparent";
//             }

//             if (desc) {
//                 desc.textContent = data.insight || data.description || "";
//             }

//             if (tip && data.tip) {
//                 tip.innerHTML = `<strong>Tip:</strong> ${escapeHtml(data.tip)}`;
//                 tip.style.display = "block";
//             }

//             // gsap.from(card, {
//             //     opacity: 0, y: 16, duration: 0.5, ease: "power2.out",
//             // });
//         })
//         .catch((err) => {
//             console.error("[SpendWise] Personality:", err);
//         });
// }


/* =============================================================
   SECTION 17 — DASHBOARD: Weekly Report
   ============================================================= */

// function initWeeklyReport() {
//     const card = document.getElementById("weeklyCard");
//     if (!card) return;

//     fetch("/api/insights/weekly-report")
//         .then((r) => {
//             if (!r.ok) throw new Error(`HTTP ${r.status}`);
//             return r.json();
//         })
//         .then((data) => {
//             // Total spent
//             const totalEl = document.getElementById("weeklyTotal");
//             if (totalEl) totalEl.textContent = formatRupees(data.total || 0);

//             // Delta vs last week
//             const deltaEl = document.getElementById("weeklyDelta");
//             if (deltaEl) {
//                 const arrow = data.direction === "up" ? "↑" : (data.direction === "down" ? "↓" : "→");
//                 const sign = data.direction === "up" ? "+" : (data.direction === "down" ? "−" : "");
//                 deltaEl.textContent = `${arrow} ${sign}${formatRupees(data.vs_amount || 0)} (${data.vs_pct || 0}%)`;
//                 deltaEl.className = `weekly-strip-delta ${data.direction || "neutral"}`;
//             }

//             // Transaction count
//             const countEl = document.getElementById("weeklyCount");
//             if (countEl) countEl.textContent = data.transaction_count || 0;

//             // Period label
//             const periodEl = document.getElementById("weeklyPeriod");
//             if (periodEl) periodEl.textContent = data.period || "";

//             // Alerts
//             const alertsEl = document.getElementById("weeklyAlerts");
//             if (alertsEl && data.alerts && data.alerts.length) {
//                 alertsEl.innerHTML = data.alerts.map((alert) => `
//                     <div class="alert-banner warning" style="margin-top:var(--space-3);">
//                         <div class="alert-banner-icon">
//                             <svg xmlns="http://www.w3.org/2000/svg" width="16" height="16"
//                                  viewBox="0 0 24 24" fill="none" stroke="currentColor"
//                                  stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
//                                 <circle cx="12" cy="12" r="10"/>
//                                 <line x1="12" y1="8" x2="12" y2="12"/>
//                                 <line x1="12" y1="16" x2="12.01" y2="16"/>
//                             </svg>
//                         </div>
//                         <div class="alert-banner-content">
//                             <div class="alert-banner-message">${escapeHtml(alert)}</div>
//                         </div>
//                     </div>
//                 `).join("");
//             }

//             // gsap.from(card, {
//             //     opacity: 0, y: 16, duration: 0.5, delay: 0.1, ease: "power2.out",
//             // });
//         })
//         .catch((err) => {
//             console.error("[SpendWise] Weekly report:", err);
//         });
// }


/* =============================================================
   SECTION 18 — DASHBOARD: Anomaly Alerts
   ============================================================= */

// function initAnomalyAlerts() {
//     const section = document.getElementById("anomalySection");
//     if (!section) return;

//     fetch("/api/insights/anomalies")
//         .then((r) => {
//             if (!r.ok) throw new Error(`HTTP ${r.status}`);
//             return r.json();
//         })
//         .then((anomalies) => {
//             if (!Array.isArray(anomalies) || !anomalies.length) return;

//             section.style.display = "block";
//             const container = document.getElementById("anomalyAlerts");
//             if (!container) return;

//             container.innerHTML = anomalies.slice(0, 3).map((a) => `
//                 <div class="alert-banner danger" style="margin-bottom:var(--space-3);">
//                     <div class="alert-banner-icon">
//                         <svg xmlns="http://www.w3.org/2000/svg" width="16" height="16"
//                              viewBox="0 0 24 24" fill="none" stroke="currentColor"
//                              stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
//                             <path d="M10.29 3.86L1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z"/>
//                             <line x1="12" y1="9" x2="12" y2="13"/>
//                             <line x1="12" y1="17" x2="12.01" y2="17"/>
//                         </svg>
//                     </div>
//                     <div class="alert-banner-content">
//                         <div class="alert-banner-title">
//                             ${escapeHtml(a.business)} — ${formatRupees(a.amount)}
//                             <span class="text-muted" style="font-weight:400; font-size:0.82rem;">
//                                 on ${formatDate(a.date)}
//                             </span>
//                         </div>
//                         <div class="alert-banner-message">${escapeHtml(a.message)}</div>
//                         ${a.typical_range !== "—"
//                     ? `<div class="text-muted" style="font-size:0.78rem; margin-top:2px;">
//                                  Typical range: ${escapeHtml(a.typical_range)}
//                                </div>`
//                     : ""
//                 }
//                     </div>
//                 </div>
//             `).join("");

//             // Stagger alert banners in
//             gsap.from(".alert-banner", {
//                 opacity: 0,
//                 x: -10,
//                 duration: 0.4,
//                 stagger: 0.1,
//                 ease: "power2.out",
//             });
//         })
//         .catch((err) => {
//             console.error("[SpendWise] Anomalies:", err);
//         });
// }

/* =============================================================
   SECTION 19 — DASHBOARD: Hero Greeting
   ============================================================= */

// function initHeroGreeting() {
//     const el = document.getElementById("heroGreeting");
//     if (!el) return;

//     const hour = new Date().getHours();
//     let greeting;

//     if (hour < 5) greeting = "Late night thoughts on money";
//     else if (hour < 12) greeting = "Good morning. A fresh page today.";
//     else if (hour < 17) greeting = "Good afternoon. How's the day looking?";
//     else if (hour < 21) greeting = "Good evening. Let's review the day.";
//     else greeting = "Winding down. Time to reflect.";

//     el.textContent = greeting;

//     // Animate the greeting text
//     gsap.from(el, {
//         opacity: 0,
//         y: 12,
//         duration: 0.6,
//         delay: 0.2,
//         ease: "power2.out",
//     });
// }

/* =============================================================
   SECTION 20 — ANALYTICS: Cash Flow Forecast
   =============================================================
   Fetches /api/insights/forecast and renders the forecast
   card on the analytics page (monthly.html).

   Visual elements:
     - Predicted total for next month
     - Trend direction (up/down/stable) with arrow
     - Confidence badge (low/medium/high)
     - Per-category forecast as horizontal bars
     - Methodology note
   ============================================================= */

function initForecast() {
    const card = document.getElementById("forecastCard");
    if (!card) return;

    fetch("/api/insights/forecast")
        .then((r) => {
            if (!r.ok) throw new Error(`HTTP ${r.status}`);
            return r.json();
        })
        .then((data) => {
            // Month label
            const monthLabel = document.getElementById("forecastMonthLabel");
            if (monthLabel) {
                monthLabel.textContent = data.month_label
                    ? `Forecast for ${data.month_label}`
                    : "Spending Forecast";
            }

            // Predicted total
            const totalEl = document.getElementById("forecastTotal");
            if (totalEl) {
                if (data.total > 0) {
                    // Animate count-up
                    const obj = { value: 0 };
                    gsap.to(obj, {
                        value: data.total,
                        duration: 1.2,
                        ease: "power2.out",
                        onUpdate: () => {
                            totalEl.textContent = formatRupees(obj.value);
                        },
                    });
                } else {
                    totalEl.textContent = "—";
                }
            }

            // Trend indicator
            const trendEl = document.getElementById("forecastTrend");
            if (trendEl && data.trend) {
                const arrows = {
                    increasing: "↑",
                    decreasing: "↓",
                    stable: "→",
                    unknown: "—",
                };
                const classes = {
                    increasing: "up",
                    decreasing: "down",
                    stable: "neutral",
                    unknown: "neutral",
                };
                const arrow = arrows[data.trend] || "—";
                const pct = Math.abs(data.trend_pct || 0);
                trendEl.textContent = `${arrow} ${pct}% ${data.trend}`;
                trendEl.className = `weekly-strip-delta ${classes[data.trend] || "neutral"}`;
            }

            // Confidence badge            
            const confEl = document.getElementById("forecastConfidence");
            if (confEl && data.confidence) {
                confEl.textContent = data.confidence + " confidence";
                const confColors = {
                    high: "var(--success)",
                    medium: "var(--accent)",
                    low: "var(--text-muted)",
                };
                confEl.style.background = confColors[data.confidence] || "var(--bg-overlay)";

                // Text colour needs to contrast with background
                confEl.style.color = data.confidence === "low"
                    ? "var(--text-primary)"
                    : "var(--bg-deep)";
            }

            // Per-category forecast bars
            const container = document.getElementById("forecastBreakdown");
            if (container && data.by_category) {
                const entries = Object.entries(data.by_category)
                    .sort((a, b) => b[1] - a[1]);
                const maxVal = entries.length ? entries[0][1] : 1;

                container.innerHTML = "";

                entries.forEach(([cat, amount], index) => {
                    const barWidth = maxVal > 0 ? (amount / maxVal) * 100 : 0;
                    const color = getColorFor(cat);

                    const row = document.createElement("div");
                    row.className = "breakdown-row";
                    row.innerHTML = `
                        <div class="breakdown-label">
                            <span class="breakdown-dot" style="background:${color}"></span>
                            <span class="breakdown-name">${escapeHtml(cat)}</span>
                        </div>
                        <div class="breakdown-bar-wrapper">
                            <div class="breakdown-bar"
                                 style="width:0%; background:${color}"
                                 data-width="${barWidth}">
                            </div>
                        </div>
                        <div class="breakdown-values">
                            <span class="breakdown-amount">${formatRupees(amount)}</span>
                            <span class="breakdown-percent text-muted" style="font-size:0.72rem;">predicted</span>
                        </div>`;

                    container.appendChild(row);

                    // Animate bar
                    const bar = row.querySelector(".breakdown-bar");
                    gsap.to(bar, {
                        width: `${barWidth}%`,
                        duration: 0.7,
                        delay: index * 0.06,
                        ease: "power2.out",
                    });
                });
            }

            // Note
            const noteEl = document.getElementById("forecastNote");
            if (noteEl && data.note) {
                noteEl.textContent = data.note;
            }

            // Animate card in
            // gsap.from(card, {
            //     opacity: 0,
            //     y: 16,
            //     duration: 0.5,
            //     ease: "power2.out",
            // });
        })
        .catch((err) => {
            console.error("[SpendWise] Forecast:", err);
            const noteEl = document.getElementById("forecastNote");
            if (noteEl) noteEl.textContent = "Could not load forecast.";
        });
}


/* =============================================================
   SECTION 21 — KEYBOARD SHORTCUTS
   =============================================================

   Global shortcuts (work on any page):
     N     → Navigate to Add Expense page
     /     → Focus the search input (if on Transactions page)
     Esc   → Close lightbox / blur focused input

   Why keyboard shortcuts?
     Power users expect them. Products like Linear, Notion,
     and GitHub all have keyboard-driven workflows.
     An examiner who presses "/" on the transactions page
     and sees the search focus will be impressed.

   Implementation:
     Single keydown listener on document.
     Checks that no input/textarea is currently focused
     before activating (to avoid hijacking typing).
   ============================================================= */

document.addEventListener("keydown", (e) => {
    // Ignore if user is typing in an input or textarea
    const tag = document.activeElement?.tagName?.toLowerCase();
    if (tag === "input" || tag === "textarea" || tag === "select") {
        // Only handle Escape while in an input
        if (e.key === "Escape") {
            document.activeElement.blur();
        }
        return;
    }

    // Ignore if modifier keys are held (Ctrl+N = browser new window)
    if (e.ctrlKey || e.metaKey || e.altKey) return;

    switch (e.key) {
        case "n":
        case "N":
            // Navigate to Add Expense
            e.preventDefault();
            window.location.href = "/add";
            break;

        case "/":
            // Focus search input on Transactions page
            e.preventDefault();
            const searchInput = document.getElementById("searchInput");
            if (searchInput) {
                searchInput.focus();
                searchInput.scrollIntoView({
                    behavior: "smooth",
                    block: "center",
                });
            }
            break;

        case "Escape":
            // Close lightbox if open
            const lightbox = document.getElementById("receiptLightbox");
            if (lightbox) {
                lightbox.remove();
            }
            break;

        case "d":
        case "D":
            // Navigate to Dashboard
            if (window.location.pathname !== "/") {
                window.location.href = "/";
            }
            break;

        case "a":
        case "A":
            // Navigate to Analytics
            if (window.location.pathname !== "/monthly") {
                window.location.href = "/monthly";
            }
            break;

        case "t":
        case "T":
            // Navigate to Transactions
            if (window.location.pathname !== "/recent") {
                window.location.href = "/recent";
            }
            break;
    }
});

/* =============================================================
   SECTION 22 — MASCOT WELCOME ANIMATION
   =============================================================

   The SpendWise AI Companion welcome sequence.

   Animation timeline (7 seconds total):
   ──────────────────────────────────────
   0.0s  — Overlay fades in, screen dims
   0.3s  — Ambient glow orb pulses to life
   0.6s  — Particles spawn and orbit around center
   1.0s  — Mascot image scales up from 0 with spring bounce
   1.5s  — Mascot rotates 360° while floating up slightly
   3.0s  — Greeting text fades in (serif font)
   3.5s  — Subtext fades in (handwritten font)
   5.5s  — Everything holds for reading
   6.0s  — Overlay begins fade out
   6.5s  — Mascot shrinks and flies to navbar dock position
   7.0s  — Overlay fully gone, navbar mascot appears

   Session management:
   ───────────────────
   sessionStorage.getItem("mascotPlayed") tracks if the
   animation has already played this browser session.
   If true, skip animation and go straight to docked state.
   User closes tab → session ends → animation plays again.

   Why sessionStorage (not localStorage)?
     localStorage persists forever — user would see animation
     only once, ever. sessionStorage resets on tab close, so
     returning users get the greeting again. This feels
     personal: "It remembers me today."
   ============================================================= */

function initMascotWelcome() {
    const overlay = document.getElementById("mascotOverlay");
    const character = document.getElementById("mascotCharacter");
    const bubble = document.getElementById("mascotBubble");
    const greeting = document.getElementById("mascotGreeting");
    const subtext = document.getElementById("mascotSubtext");
    const navMascot = document.getElementById("navMascot");

    if (!overlay || !character) return;

    // ── Check if animation already played this session ───────
    if (sessionStorage.getItem("mascotPlayed") === "true") {
        // Skip animation, dock immediately
        overlay.style.display = "none";
        if (navMascot) navMascot.classList.add("docked");
        initAssistantPanel();
        return;
    }

    // ── Set greeting based on time of day ────────────────────
    const hour = new Date().getHours();
    let greetText, subText;

    if (hour < 5) {
        greetText = "Burning the midnight oil?";
        subText = "Let's see where today's money went.";
    } else if (hour < 12) {
        greetText = "Good morning.";
        subText = "Ready to keep today's spending under control?";
    } else if (hour < 17) {
        greetText = "Good afternoon.";
        subText = "How's the wallet doing today?";
    } else if (hour < 21) {
        greetText = "Good evening.";
        subText = "Hope today was worth every rupee.";
    } else {
        greetText = "Winding down for the night?";
        subText = "Let's log today's expenses before you forget.";
    }

    if (greeting) greeting.textContent = greetText;
    if (subtext) subtext.textContent = subText;

    // ── Create floating particles ────────────────────────────
    createParticles();

    // ── Build GSAP Timeline ──────────────────────────────────
    const tl = gsap.timeline({
        onComplete: () => {
            // Mark as played for this session
            sessionStorage.setItem("mascotPlayed", "true");
        },
    });

    // Step 1: Fade in overlay (0.0s → 0.3s)
    tl.to(overlay, {
        duration: 0.3,
        opacity: 1,
        ease: "power2.out",
        onStart: () => {
            overlay.classList.add("active");
        },
    });

    // Step 2: Pulse the glow orb (0.3s → 0.6s)
    tl.from(".mascot-glow", {
        scale: 0,
        opacity: 0,
        duration: 0.5,
        ease: "back.out(1.5)",
    }, 0.3);

    // Step 3: Animate particles in (0.6s → 1.0s)
    tl.to(".particle", {
        opacity: 0.8,
        duration: 0.3,
        stagger: { each: 0.03, from: "random" },
    }, 0.6);

    // Start particle orbit animation
    tl.call(animateParticles, [], 0.6);

    // Step 4: Mascot scales up with spring (1.0s → 1.5s)
    tl.to(character, {
        scale: 1,
        duration: 0.6,
        ease: "back.out(2)",
    }, 1.0);

    // Step 5: Mascot rotates 360° while floating up (1.5s → 3.0s)
    tl.to(".mascot-image", {
        rotation: 360,
        duration: 1.5,
        ease: "power2.inOut",
    }, 1.5);

    // Float up slightly during rotation
    tl.to(character, {
        y: -15,
        duration: 1.5,
        ease: "power2.inOut",
    }, 1.5);

    // Float back to center
    tl.to(character, {
        y: 0,
        duration: 0.8,
        ease: "power2.inOut",
    }, 3.0);

    // Step 6: Greeting fades in (3.0s → 3.5s)
    tl.to(bubble, {
        opacity: 1,
        y: 0,
        duration: 0.5,
        ease: "power2.out",
    }, 3.0);

    // Step 7: Hold for reading (3.5s → 5.5s)
    // Nothing happens — user reads the greeting.
    tl.to({}, { duration: 2.0 });

    // Step 8: Fade out particles (5.5s → 5.8s)
    tl.to(".particle", {
        opacity: 0,
        duration: 0.3,
        stagger: { each: 0.02, from: "random" },
    }, 5.5);

    // Step 9: Fade out greeting bubble (5.5s → 5.8s)
    tl.to(bubble, {
        opacity: 0,
        y: -10,
        duration: 0.3,
    }, 5.5);

    // Step 10: Shrink mascot toward nav position (5.8s → 6.5s)
    tl.to(character, {
        scale: 0.25,
        opacity: 0,
        duration: 0.6,
        ease: "power3.in",
    }, 5.8);

    // Step 11: Fade out glow (5.8s → 6.2s)
    tl.to(".mascot-glow", {
        opacity: 0,
        scale: 0.5,
        duration: 0.4,
    }, 5.8);

    // Step 12: Fade out overlay (6.2s → 6.8s)
    tl.to(overlay, {
        opacity: 0,
        duration: 0.6,
        ease: "power2.in",
        onComplete: () => {
            overlay.classList.remove("active");
            overlay.style.display = "none";
        },
    }, 6.2);

    // Step 13: Dock mascot into navbar (6.5s → 7.0s)
    tl.call(() => {
        if (navMascot) {
            navMascot.classList.add("docked");

            // Entrance animation for the docked mascot
            gsap.from(navMascot, {
                scale: 0,
                opacity: 0,
                duration: 0.5,
                ease: "back.out(2.5)",
            });
        }

        // Initialize assistant panel click handlers
        initAssistantPanel();
    }, [], 6.5);
}


/**
 * Create particle elements inside the particles container.
 *
 * 20 particles distributed in a circle around the mascot.
 * Each particle has a random size (2-4px) and slight
 * position offset for organic feel.
 */
function createParticles() {
    const container = document.getElementById("mascotParticles");
    if (!container) return;

    container.innerHTML = "";

    const count = 20;
    const radius = 120; // Distance from center

    for (let i = 0; i < count; i++) {
        const particle = document.createElement("div");
        particle.className = "particle";

        // Distribute evenly around a circle
        const angle = (i / count) * Math.PI * 2;
        const x = Math.cos(angle) * radius + 150; // center offset
        const y = Math.sin(angle) * radius + 150;

        // Random size variation
        const size = 2 + Math.random() * 2;

        particle.style.cssText = `
            left: ${x}px;
            top: ${y}px;
            width: ${size}px;
            height: ${size}px;
        `;

        container.appendChild(particle);
    }
}


/**
 * Animate particles in orbital motion around the mascot.
 *
 * Each particle moves in a slightly elliptical path
 * using GSAP's motionPath-like manual calculation.
 * Staggered start times create a flowing effect.
 */
function animateParticles() {
    const particles = document.querySelectorAll(".particle");

    particles.forEach((p, i) => {
        const duration = 2 + Math.random() * 2;
        const delay = i * 0.05;
        const radius = 100 + Math.random() * 40;
        const startAngle = (i / particles.length) * Math.PI * 2;

        // Orbit animation using GSAP onUpdate
        const obj = { angle: startAngle };

        gsap.to(obj, {
            angle: startAngle + Math.PI * 2,
            duration: duration,
            delay: delay,
            repeat: 2,
            ease: "none",
            onUpdate: () => {
                const x = Math.cos(obj.angle) * radius + 150;
                const y = Math.sin(obj.angle) * (radius * 0.7) + 150;
                p.style.left = `${x}px`;
                p.style.top = `${y}px`;
            },
        });

        // Pulsing opacity
        gsap.to(p, {
            opacity: 0.3 + Math.random() * 0.5,
            duration: 0.5 + Math.random() * 0.5,
            repeat: -1,
            yoyo: true,
            delay: delay,
        });
    });
}


/* =============================================================
   SECTION 23 — ASSISTANT PANEL
   =============================================================

   The docked mascot in the navbar can be clicked to open
   a slide-in assistant panel on the right side.

   Panel content is populated dynamically based on:
     - Current time greeting
     - Health score summary
     - Recent anomalies
     - Achievement status
     - Financial tips

   The panel feels like talking to your AI companion —
   messages appear in a chat-like bubble format.
   ============================================================= */

function initAssistantPanel() {
    const navMascot = document.getElementById("navMascot");
    const panel = document.getElementById("assistantPanel");
    const closeBtn = document.getElementById("assistantClose");

    if (!navMascot || !panel) return;

    // Click docked mascot → toggle panel
    navMascot.addEventListener("click", () => {
        const isOpen = panel.classList.contains("open");

        if (isOpen) {
            panel.classList.remove("open");
        } else {
            panel.classList.add("open");
            populateAssistantMessages();
        }
    });

    // Close button
    if (closeBtn) {
        closeBtn.addEventListener("click", () => {
            panel.classList.remove("open");
        });
    }

    // Click outside panel → close
    document.addEventListener("click", (e) => {
        if (panel.classList.contains("open")
            && !panel.contains(e.target)
            && !navMascot.contains(e.target)) {
            panel.classList.remove("open");
        }
    });

    // Escape key → close
    document.addEventListener("keydown", (e) => {
        if (e.key === "Escape" && panel.classList.contains("open")) {
            panel.classList.remove("open");
        }
    });
}


/**
 * Populate the assistant panel with contextual messages.
 *
 * Fetches data from multiple insight endpoints and
 * constructs a conversational message feed.
 *
 * Messages appear with staggered GSAP animations
 * to feel like the assistant is "typing" them.
 */
async function populateAssistantMessages() {
    const container = document.getElementById("assistantMessages");
    if (!container) return;

    container.innerHTML = "";
    const messages = [];

    // ── Greeting ─────────────────────────────────────────────
    const hour = new Date().getHours();
    let timeGreeting;

    if (hour < 5) timeGreeting = "Late night, huh? Hope you're not online shopping.";
    else if (hour < 12) timeGreeting = "Good morning! A fresh day for smart spending.";
    else if (hour < 17) timeGreeting = "Afternoon check-in. How's the budget looking?";
    else if (hour < 21) timeGreeting = "Evening! Let's review what happened today.";
    else timeGreeting = "Winding down? Perfect time to log today's expenses.";

    messages.push({ text: timeGreeting, type: "greeting" });

    // ── Fetch insights in parallel ───────────────────────────
    try {
        const [healthRes, anomalyRes, weeklyRes, personalityRes] = await Promise.all([
            fetch("/api/insights/health-score").then(r => r.ok ? r.json() : null).catch(() => null),
            fetch("/api/insights/anomalies").then(r => r.ok ? r.json() : null).catch(() => null),
            fetch("/api/insights/weekly-report").then(r => r.ok ? r.json() : null).catch(() => null),
            fetch("/api/insights/personality").then(r => r.ok ? r.json() : null).catch(() => null),
        ]);

        // Health score message
        if (healthRes && healthRes.score > 0) {
            const score = healthRes.score;
            let healthMsg;

            if (score >= 85) {
                healthMsg = `Your financial health score is <strong>${score}/100</strong>. Outstanding discipline!`;
            } else if (score >= 70) {
                healthMsg = `Health score: <strong>${score}/100</strong>. You're doing well, with room to improve.`;
            } else if (score >= 50) {
                healthMsg = `Health score is <strong>${score}/100</strong>. Some areas need attention.`;
            } else {
                healthMsg = `Health score: <strong>${score}/100</strong>. Let's work on bringing this up.`;
            }
            messages.push({ text: healthMsg, type: "tip" });
        }

        // Anomaly alerts
        if (anomalyRes && Array.isArray(anomalyRes) && anomalyRes.length > 0) {
            const a = anomalyRes[0];
            messages.push({
                text: `I noticed something unusual: <strong>${escapeHtml(a.business)}</strong> for ${formatRupees(a.amount)}. ${escapeHtml(a.message)}`,
                type: "alert",
            });
        }

        // Weekly comparison
        if (weeklyRes && weeklyRes.total > 0) {
            const dir = weeklyRes.direction;
            const arrow = dir === "up" ? "more" : (dir === "down" ? "less" : "about the same as");
            messages.push({
                text: `This week you spent <strong>${formatRupees(weeklyRes.total)}</strong> — ${arrow} last week.`,
                type: "tip",
            });
        }

        // Personality insight
        if (personalityRes && personalityRes.type && personalityRes.type !== "Unknown" && personalityRes.type !== "Calculating…") {
            messages.push({
                text: `Your spending personality: <strong>${escapeHtml(personalityRes.type)}</strong>. ${escapeHtml(personalityRes.insight || "")}`,
                type: "tip",
            });
        }

    } catch (err) {
        console.error("[SpendWise] Assistant fetch error:", err);
    }

    // ── Financial tips (always show one) ─────────────────────
    const tips = [
        "Try the 50/30/20 rule: 50% needs, 30% wants, 20% savings.",
        "Logging expenses daily makes you 3x more aware of your spending.",
        "Set budgets for your top 3 categories to see real improvement.",
        "Weekend spending is usually 2-3x higher. Plan accordingly.",
        "Small daily savings compound into significant amounts over a year.",
        "Review your Insights page weekly to spot spending patterns.",
        "Use the Quick Add feature to log expenses in under 5 seconds.",
        "Your most expensive day is usually a weekend. Track and adjust.",
    ];
    const randomTip = tips[Math.floor(Math.random() * tips.length)];
    messages.push({ text: randomTip, type: "tip" });

    // ── Render messages with stagger ─────────────────────────
    messages.forEach((msg, i) => {
        const div = document.createElement("div");
        div.className = `assistant-msg ${msg.type}`;
        div.innerHTML = msg.text;
        div.style.opacity = "0";
        div.style.transform = "translateY(8px)";
        container.appendChild(div);

        // Stagger each message 200ms apart
        gsap.to(div, {
            opacity: 1,
            y: 0,
            duration: 0.3,
            delay: i * 0.2,
            ease: "power2.out",
        });
    });
}


/* =============================================================
   SECTION 24 — MASCOT REACTIONS
   =============================================================

   The docked mascot reacts to user actions with small
   speech bubbles that pop up briefly from the navbar.

   Reactions are triggered by:
     - Achievement unlocked
     - Anomaly detected
     - Budget exceeded
     - Expense added successfully
     - Health score change

   Each reaction has a message and auto-dismisses after 4s.
   Only one reaction shows at a time (new replaces old).
   ============================================================= */

/**
 * Show a brief reaction bubble from the docked mascot.
 *
 * @param {string} message — text to display
 * @param {number} duration — ms before auto-dismiss (default 4000)
 */
function showMascotReaction(message, duration = 4000) {
    const navMascot = document.getElementById("navMascot");
    if (!navMascot || !navMascot.classList.contains("docked")) return;

    // Remove existing reaction
    const existing = navMascot.querySelector(".mascot-reaction");
    if (existing) existing.remove();

    // Create reaction bubble
    const bubble = document.createElement("div");
    bubble.className = "mascot-reaction";
    bubble.textContent = message;
    navMascot.appendChild(bubble);

    // Animate in
    requestAnimationFrame(() => {
        bubble.classList.add("show");
    });

    // Bounce the mascot image
    gsap.to(navMascot.querySelector(".nav-mascot-img"), {
        scale: 1.15,
        duration: 0.15,
        yoyo: true,
        repeat: 1,
        ease: "power2.out",
    });

    // Auto-dismiss
    setTimeout(() => {
        bubble.classList.remove("show");
        setTimeout(() => bubble.remove(), 300);
    }, duration);
}


/* =============================================================
   SECTION 25 — ENHANCED initPurchaseForm WITH MASCOT REACTIONS
   =============================================================

   Override the success path in the existing initPurchaseForm
   to trigger mascot reactions after adding an expense.

   We do NOT rewrite initPurchaseForm — instead we hook into
   the existing success flow by adding a reaction call.

   This function is called AFTER the existing form handler
   runs. We use a MutationObserver to detect when the toast
   appears with "Expense added" text, then trigger a reaction.
   ============================================================= */

// function initMascotFormReactions() {
//     const toast = document.getElementById("toast");
//     if (!toast) return;

//     // Watch for toast content changes
//     const observer = new MutationObserver((mutations) => {
//         for (const mutation of mutations) {
//             if (mutation.type === "childList" || mutation.type === "characterData") {
//                 const text = toast.textContent || "";

//                 if (text.includes("added successfully")) {
//                     // Random positive reactions
//                     const reactions = [
//                         "Noted! Every rupee tracked is a rupee saved.",
//                         "Got it! Your diary is up to date.",
//                         "Logged. Let's see how this affects your score.",
//                         "Written down. Your future self will thank you.",
//                         "Added! Consistency is the key to financial health.",
//                         "Recorded. You're building great habits.",
//                     ];
//                     const reaction = reactions[Math.floor(Math.random() * reactions.length)];
//                     setTimeout(() => showMascotReaction(reaction), 500);
//                 }

//                 if (text.includes("deleted")) {
//                     showMascotReaction("Entry removed from your diary.");
//                 }
//             }
//         }
//     });

//     observer.observe(toast, {
//         childList: true,
//         characterData: true,
//         subtree: true,
//     });
// }

/* =============================================================
   SECTION 26 — DIARY PAGE NUMBER
   =============================================================
   Shows the current date as a "page number" at the bottom
   of the diary page. Format: "Page 204 · July 2026"
   where 204 is the day of the year.
   ============================================================= */

function initDiaryPageNumber() {
    const el = document.getElementById("diaryPageNum");
    if (!el) return;

    const now = new Date();
    const start = new Date(now.getFullYear(), 0, 0);
    const diff = now - start;
    const dayOfYear = Math.floor(diff / (1000 * 60 * 60 * 24));
    const monthName = now.toLocaleString("default", { month: "long" });
    const year = now.getFullYear();

    el.textContent = `Page ${dayOfYear} · ${monthName} ${year}`;
}

/* =============================================================
   ═════════════════════════════════════════════════════════════
   DASHBOARD ORCHESTRATOR
   ═════════════════════════════════════════════════════════════

   Single entry point for the new question-based dashboard.
   Replaces the old separate init functions.

   Loads all data in parallel, then renders each Q section
   independently. If one section fails, others still render.

   The Q5 constellation lives in constellation.js (Step 4)
   and initializes itself when scrolled into view.
   ============================================================= */

async function initDashboardExperience() {
    const dashboard = document.querySelector(".dashboard");
    if (!dashboard) return;  // Not on dashboard page

    // ── Fetch all data in parallel ────────────────────────
    // We batch every API call needed for Q1-Q4 into one
    // Promise.all. This is faster than sequential fetches
    // and makes render logic simpler.

    let stats, health, weekly, anomalies, personality, categories, recent;

    try {
        const responses = await Promise.all([
            fetch("/api/stats").then(safeJson),
            fetch("/api/insights/health-score").then(safeJson),
            fetch("/api/insights/weekly-report").then(safeJson),
            fetch("/api/insights/anomalies").then(safeJson),
            fetch("/api/insights/personality").then(safeJson),
            fetch("/api/category-totals").then(safeJson),
            fetch("/api/purchases?limit=5").then(safeJson),
        ]);

        [stats, health, weekly, anomalies, personality, categories, recent] = responses;

    } catch (err) {
        console.error("[SpendWise] Dashboard data fetch failed:", err);
        renderDashboardError();
        return;
    }

    // ── Render each Q section independently ────────────────
    // Wrapped in try/catch so a single failure doesn't
    // break the whole dashboard.

    tryRender("Q1 (Standing)", () => renderQ1Standing(stats, health, weekly, anomalies));
    // Initialize ring context panel interactions (hover/tap)
    tryRender("Ring Context", () => initRingContext());
    tryRender("Q2 (Changed)", () => renderQ2Changed(weekly, categories));
    tryRender("Q3 (Attention)", () => renderQ3Attention(anomalies, weekly, stats, personality, health));
    tryRender("Q4 (Categories)", () => renderQ4Categories(categories, recent));

    // Q5 (Constellation) is initialized separately when the
    // section scrolls into view. See constellation.js.
}


/** Safe JSON parser — returns null instead of throwing. */
async function safeJson(response) {
    if (!response.ok) return null;
    try { return await response.json(); }
    catch { return null; }
}


/** Try to render a section, log if it fails. */
function tryRender(label, fn) {
    try { fn(); }
    catch (err) { console.error(`[SpendWise] ${label} render failed:`, err); }
}


/** Render a page-level error if all data fetching fails. */
function renderDashboardError() {
    const greeting = document.getElementById("heroGreeting");
    if (greeting) greeting.textContent = "Something went wrong.";
    const projection = document.getElementById("greetingProjection");
    if (projection) {
        projection.textContent = "Please refresh the page. If it happens again, check that the server is running.";
    }
}


/* =============================================================
   Q1 — WHERE DO I STAND TODAY?
   =============================================================
   Renders: greeting, monthly total, projection, health ring,
            reward badge (when earned).
   ============================================================= */

function renderQ1Standing(stats, health, weekly, anomalies) {

    // ── Time-based greeting ────────────────────────────────
    const greetingEl = document.getElementById("heroGreeting");
    if (greetingEl) {
        const hour = new Date().getHours();
        let greeting;

        if (hour < 5) greeting = "Late night check-in.";
        else if (hour < 12) greeting = "Good morning.";
        else if (hour < 17) greeting = "Good afternoon.";
        else if (hour < 21) greeting = "Good evening.";
        else greeting = "Winding down.";

        greetingEl.textContent = greeting;
    }

    // ── Monthly total in greeting sentence ─────────────────
    const amountEl = document.getElementById("greetingAmount");
    if (amountEl && stats) {
        amountEl.textContent = formatRupeesClean(stats.month_total || 0);
    }

    // ── Projection sentence ────────────────────────────────
    const projEl = document.getElementById("greetingProjection");
    if (projEl && stats) {
        const projected = stats.projected_total || 0;
        const dayOfMonth = stats.day_of_month || 1;

        if (projected > 0 && dayOfMonth >= 3) {
            projEl.textContent = `You're on track for around ${formatRupeesClean(projected)} by month-end.`;
        } else if (dayOfMonth < 3) {
            projEl.textContent = "It's early in the month. Your projection will sharpen as you log more.";
        } else {
            projEl.textContent = "";
        }
    }

    // ── Health ring animation ──────────────────────────────
    renderHealthRing(health);

    // ── Reward badge (only if earned) ──────────────────────
    renderRewardBadge(stats, health, weekly, anomalies);
}


/**
 * Animate the health ring SVG.
 * Circle circumference = 2 * π * 76 ≈ 477.5
 * dashoffset = circumference * (1 - score/100)
 */
function renderHealthRing(health) {
    const scoreEl = document.getElementById("healthScoreValue");
    const labelEl = document.getElementById("healthScoreLabel");
    const fillEl = document.getElementById("healthRingFill");

    if (!health || !scoreEl || !labelEl || !fillEl) return;

    const score = health.score || 0;
    const color = health.color || "#10b981";

    // Score number
    scoreEl.textContent = score;

    // Label
    labelEl.textContent = health.label || "Loading";
    labelEl.style.color = color;

    // Ring fill animation
    const circumference = 477.5;
    const target = circumference * (1 - score / 100);

    fillEl.style.stroke = color;
    // Force reflow so animation triggers on page load
    void fillEl.getBoundingClientRect();
    fillEl.style.strokeDashoffset = target;

    // Component bars (revealed on hover)
    renderHealthComponents(health.components || {}, health);

}


/**
 * Render the ring context panel.
 *
 * Instead of showing 4 progress bars (a dashboard-within-a-dashboard),
 * we generate a short human-readable explanation:
 *   1. Score + label in header
 *   2. Three "why" bullets — natural language reasons
 *   3. One next-step sentence with a specific action
 */
function renderHealthComponents(components, healthData) {
    const scoreEl = document.getElementById("ringContextScore");
    const reasonsEl = document.getElementById("ringContextReasons");
    const nextStepEl = document.getElementById("ringContextNextStep");

    if (!scoreEl || !reasonsEl || !nextStepEl) return;
    if (!healthData || !components) return;

    // Header — score + label
    const score = healthData.score || 0;
    const label = healthData.label || "";
    scoreEl.textContent = `Health Score: ${score} · ${label}`;

    // Generate 3 human reasons from the components
    const reasons = generateHealthReasons(components);
    reasonsEl.innerHTML = reasons.map(r => `<li>${escapeHtml(r)}</li>`).join("");

    // Generate the next step sentence
    const nextStep = generateNextStep(components, healthData);
    nextStepEl.innerHTML = nextStep;
}


/**
 * Translate raw component scores into human sentences.
 * Returns array of exactly 3 reason strings.
 *
 * The reasons prioritize: worst-performing component first,
 * then next-worst, then a contextual observation.
 */
function generateHealthReasons(components) {
    const items = [
        {
            key: "budget_adherence",
            comp: components.budget_adherence,
            good: "Budget discipline is strong",
            average: "Budget discipline is average",
            poor: "Budget adherence needs attention",
        },
        {
            key: "spending_trend",
            comp: components.spending_trend,
            good: "Spending is trending downward",
            average: "Spending is roughly steady",
            poor: "Spending is trending upward",
        },
        {
            key: "consistency",
            comp: components.consistency,
            good: "Spending is consistent month-to-month",
            average: "Spending varies moderately",
            poor: "Spending is highly variable",
        },
        {
            key: "savings_potential",
            comp: components.savings_potential,
            good: "Savings are above your usual trend",
            average: "Savings are near your average",
            poor: "Savings are below your usual trend",
        },
    ];

    // Rate each component: good / average / poor
    const rated = items.map(item => {
        const pct = item.comp && item.comp.max > 0
            ? item.comp.score / item.comp.max
            : 0.5;

        let level, text;
        if (pct >= 0.75) { level = "good"; text = item.good; }
        else if (pct >= 0.45) { level = "average"; text = item.average; }
        else { level = "poor"; text = item.poor; }

        return { ...item, pct, level, text };
    });

    // Sort by pct ascending (worst first)
    rated.sort((a, b) => a.pct - b.pct);

    // Return top 3
    return rated.slice(0, 3).map(r => r.text);
}


/**
 * Generate the specific "next step" sentence.
 * Points to the single most impactful action based on the
 * lowest-scoring component.
 */
function generateNextStep(components, healthData) {
    const score = healthData.score || 0;
    const targetScore = score < 70 ? "Good" : (score < 85 ? "Excellent" : "Excellent");

    // Find the lowest component
    const items = [
        { key: "budget", comp: components.budget_adherence },
        { key: "trend", comp: components.spending_trend },
        { key: "consistency", comp: components.consistency },
        { key: "savings", comp: components.savings_potential },
    ].filter(i => i.comp);

    if (items.length === 0) {
        return "Log more expenses to unlock personalized guidance.";
    }

    items.sort((a, b) => {
        const aPct = a.comp.max > 0 ? a.comp.score / a.comp.max : 0;
        const bPct = b.comp.max > 0 ? b.comp.score / b.comp.max : 0;
        return aPct - bPct;
    });

    const weakest = items[0];

    // Suggestions per weakest area
    const suggestions = {
        budget: `Set spending budgets for your top categories to move toward <strong>"${targetScore}"</strong>.`,
        trend: `Reduce spending by 10-15% this month to move toward <strong>"${targetScore}"</strong>.`,
        consistency: `Build a consistent weekly spending rhythm to move toward <strong>"${targetScore}"</strong>.`,
        savings: `Cut back on your largest category to move toward <strong>"${targetScore}"</strong>.`,
    };

    return suggestions[weakest.key] || `Continue current habits to maintain your score.`;
}


/**
 * The ✦ reward badge.
 *
 * Logic: find the SINGLE most genuine positive moment worth
 * celebrating right now. Prioritize surprising over generic.
 *
 * If nothing genuinely positive, do not show the badge.
 * (No fake positivity. Silence is honest.)
 */
function renderRewardBadge(stats, health, weekly, anomalies) {
    const badge = document.getElementById("rewardBadge");
    const textEl = document.getElementById("rewardText");
    if (!badge || !textEl) return;

    const messages = [];

    // Priority 1: Zero-spend day today
    if (stats && stats.today_total === 0 && stats.month_count > 0) {
        messages.push("A spending-free day so far.");
    }

    // Priority 2: Week is trending down (spending less)
    if (weekly && weekly.direction === "down" && weekly.vs_pct >= 10) {
        messages.push(`You're spending ${Math.round(weekly.vs_pct)}% less than last week.`);
    }

    // Priority 3: Health score is excellent
    if (health && health.score >= 85) {
        messages.push("Your financial health is in top shape.");
    }

    // Priority 4: Good health score
    else if (health && health.score >= 70) {
        messages.push("You're building strong financial habits.");
    }

    // Priority 5: No anomalies this month
    if ((!anomalies || anomalies.length === 0) && stats && stats.month_count >= 5) {
        messages.push("No unusual spending patterns detected.");
    }

    // Priority 6: Best day of the week (contextual)
    if (weekly && weekly.best_day && weekly.transaction_count > 0) {
        const today = new Date().toLocaleDateString("en-US", { weekday: "long" });
        if (weekly.best_day === today) {
            messages.push(`${today}s are your best spending day.`);
        }
    }

    // Show the first (highest priority) message
    if (messages.length > 0) {
        textEl.textContent = messages[0];
        badge.removeAttribute("hidden");
    } else {
        badge.setAttribute("hidden", "");
    }
}


/* =============================================================
   Q2 — WHAT CHANGED?
   =============================================================
   Renders: two sparklines (this week vs last week),
            delta arrow, conclusion sentence.
   ============================================================= */

function renderQ2Changed(weekly, categories) {
    if (!weekly) return;

    const thisSpark = document.getElementById("weekSparkThis");
    const lastSpark = document.getElementById("weekSparkLast");
    const thisTotal = document.getElementById("weekTotalThis");
    const lastTotal = document.getElementById("weekTotalLast");
    const deltaArrow = document.getElementById("weekDeltaArrow");
    const deltaAmount = document.getElementById("weekDeltaAmount");
    const deltaLabel = document.getElementById("weekDeltaLabel");
    const conclusion = document.getElementById("weekConclusion");

    // Extract daily breakdowns
    const dailyBreakdown = weekly.daily_breakdown || {};
    const thisWeekDays = Object.keys(dailyBreakdown).sort();
    const thisWeekAmounts = thisWeekDays.map(d => dailyBreakdown[d]);

    // For last week we don't have per-day data from the API,
    // so we display the total as a flat "average" sparkline.
    // This is honest — we show only what we have.
    const lastTotalAmt = weekly.total_last_week || 0;
    const lastDailyAvg = lastTotalAmt / 7;
    const lastWeekAmounts = Array(7).fill(lastDailyAvg);

    // Find max across both weeks for consistent scale
    const maxAmount = Math.max(
        ...thisWeekAmounts,
        ...lastWeekAmounts,
        1  // prevent divide by zero
    );

    // ── Render this week sparkline ─────────────────────────
    if (thisSpark) {
        thisSpark.innerHTML = "";
        const dayNames = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];

        thisWeekAmounts.forEach((amount, i) => {
            const bar = document.createElement("div");
            bar.className = "week-spark-bar this-week";
            const heightPct = (amount / maxAmount) * 100;
            bar.style.height = `${Math.max(heightPct, 3)}%`;

            const dayIdx = new Date(thisWeekDays[i]).getDay();
            const dayName = dayNames[(dayIdx + 6) % 7];  // Adjust to Mon-Sun
            bar.setAttribute("data-tip", `${dayName}: ${formatRupeesClean(amount)}`);

            thisSpark.appendChild(bar);
        });
    }

    // ── Render last week sparkline (flat, since no daily data) ─
    if (lastSpark) {
        lastSpark.innerHTML = "";
        lastWeekAmounts.forEach(amount => {
            const bar = document.createElement("div");
            bar.className = "week-spark-bar last-week";
            const heightPct = (amount / maxAmount) * 100;
            bar.style.height = `${Math.max(heightPct, 3)}%`;
            bar.setAttribute("data-tip", `Avg: ${formatRupeesClean(amount)}`);
            lastSpark.appendChild(bar);
        });
    }

    // ── Totals ─────────────────────────────────────────────
    if (thisTotal) thisTotal.textContent = formatRupeesClean(weekly.total || 0);
    if (lastTotal) lastTotal.textContent = formatRupeesClean(weekly.total_last_week || 0);

    // ── Delta ──────────────────────────────────────────────
    if (deltaArrow && deltaAmount && deltaLabel) {
        const direction = weekly.direction || "neutral";
        const vsAmount = weekly.vs_amount || 0;
        const vsPct = weekly.vs_pct || 0;

        // Reset classes
        deltaArrow.className = "week-delta-arrow";

        if (direction === "up") {
            deltaArrow.textContent = "↑";
            deltaArrow.classList.add("up");
            deltaAmount.textContent = `+${formatRupeesClean(vsAmount)}`;
            deltaLabel.textContent = `${vsPct}% more`;
        } else if (direction === "down") {
            deltaArrow.textContent = "↓";
            deltaArrow.classList.add("down");
            deltaAmount.textContent = `-${formatRupeesClean(vsAmount)}`;
            deltaLabel.textContent = `${vsPct}% less`;
        } else {
            deltaArrow.textContent = "→";
            deltaAmount.textContent = "—";
            deltaLabel.textContent = "no change";
        }
    }

    // ── Conclusion sentence ────────────────────────────────
    if (conclusion) {
        conclusion.textContent = generateWeekConclusion(weekly, categories);
    }
}


/**
 * Generate a human sentence describing this week's story.
 * Falls back gracefully if data is thin.
 */
function generateWeekConclusion(weekly, categories) {
    if (!weekly) return "";

    // Prefer weekly alerts if any
    if (weekly.alerts && weekly.alerts.length > 0) {
        return weekly.alerts[0];
    }

    // Fall back to top category insight
    if (weekly.top_categories && weekly.top_categories.length > 0) {
        const top = weekly.top_categories[0];
        return `${top.category} led your spending this week at ${formatRupeesClean(top.amount)}.`;
    }

    // Very quiet week
    if (weekly.transaction_count === 0) {
        return "A quiet week — no expenses logged.";
    }

    return `You logged ${weekly.transaction_count} ${weekly.transaction_count === 1 ? "expense" : "expenses"} this week.`;
}


/* =============================================================
   Q3 — WHAT DESERVES YOUR ATTENTION?
   =============================================================
   Priority order:
     1. Unusual expenses (anomalies) — high priority
     2. Rapidly changing categories — medium priority
     3. Positive reinforcement — low priority (with ✦)

   Never shows more than 3 items.
   Never shows empty state — always has something to say.
   ============================================================= */

function renderQ3Attention(anomalies, weekly, stats, personality, health) {
    const list = document.getElementById("attentionList");
    if (!list) return;

    const items = [];

    // ── Priority: Anomalies ────────────────────────────────
    if (anomalies && anomalies.length > 0) {
        anomalies.slice(0, 2).forEach(a => {
            items.push({
                priority: "high",
                fact: `A ${formatRupeesClean(a.amount)} ${escapeHtml(a.business)} entry looks unusual.`,
                context: escapeHtml(a.message || `Your typical ${a.category} spend is ${a.typical_range || "much lower"}.`),
                action: null,
                actionText: null,
                spark: false,
            });
        });
    }

    // ── Priority: Category trend from weekly alerts ─────────
    if (weekly && weekly.alerts) {
        weekly.alerts.slice(0, 1).forEach(alert => {
            items.push({
                priority: "medium",
                fact: escapeHtml(alert),
                context: "Watch this trend over the coming days.",
                action: "/monthly",
                actionText: "See insights",
                spark: false,
            });
        });
    }

    // ── Positive reinforcement (rewards with ✦) ────────────
    // Only add if we don't already have 3 items and there's
    // something genuinely worth celebrating.

    if (items.length < 3) {
        // Health score improvement (would need prior score to compare — skipped)

        // Zero spending days this week
        if (weekly && weekly.daily_breakdown) {
            const zeroDays = Object.values(weekly.daily_breakdown).filter(v => v === 0).length;
            if (zeroDays >= 2) {
                items.push({
                    priority: "low",
                    fact: `You had ${zeroDays} spending-free days this week.`,
                    context: "Your discipline is showing.",
                    action: null,
                    actionText: null,
                    spark: true,
                });
            }
        }

        // Best day insight
        if (items.length < 3 && weekly && weekly.best_day && weekly.best_day !== "—") {
            items.push({
                priority: "low",
                fact: `${weekly.best_day}s tend to be your calmest spending day.`,
                context: "Something to lean into.",
                action: null,
                actionText: null,
                spark: true,
            });
        }

        // Personality-based note
        if (items.length < 3 && personality && personality.type &&
            personality.type !== "Unknown" && personality.tip) {
            items.push({
                priority: "low",
                fact: `You're spending like a ${personality.type}.`,
                context: escapeHtml(personality.tip),
                action: null,
                actionText: null,
                spark: false,
            });
        }
    }

    // ── Fallback if nothing to show (rare) ────────────────
    if (items.length === 0) {
        if (stats && stats.month_count === 0) {
            items.push({
                priority: "low",
                fact: "You haven't logged any expenses yet.",
                context: "Start with today's first entry to unlock insights.",
                action: "/add",
                actionText: "Log your first expense",
                spark: false,
            });
        } else {
            items.push({
                priority: "low",
                fact: "Everything looks steady.",
                context: "No unusual patterns or alerts right now.",
                action: null,
                actionText: null,
                spark: true,
            });
        }
    }

    // ── Render ─────────────────────────────────────────────
    list.innerHTML = items.slice(0, 3).map(item => `
        <div class="attention-item priority-${item.priority}">
            <span class="attention-dot"></span>
            <div class="attention-body">
                <p class="attention-fact">
                    ${item.fact}
                    ${item.spark ? '<span class="attention-spark">✦</span>' : ""}
                </p>
                <p class="attention-context">${item.context}</p>
                ${item.action ? `<a class="attention-action" href="${item.action}">${item.actionText} →</a>` : ""}
            </div>
        </div>
    `).join("");
}


/* =============================================================
   Q4 — WHERE IS YOUR MONEY GOING?
   =============================================================
   Renders: top 5 categories as rows with bars.
   Hover a row → floating preview of recent expenses in that category.
   Click a row → will filter constellation (handled in constellation.js).
   ============================================================= */

function renderQ4Categories(categories, recentPayload) {
    const list = document.getElementById("categoryList");
    if (!list || !categories) return;

    // Take top 5
    const top = categories.slice(0, 5);
    if (top.length === 0) {
        list.innerHTML = `<p class="empty-state" style="padding: var(--space-8) 0;">
            No categories to show yet. Log a few expenses to see your breakdown.
        </p>`;
        return;
    }

    const total = categories.reduce((sum, c) => sum + c.category_amount, 0);
    const maxAmount = top[0].category_amount;

    // Store the recent purchases for hover preview lookup
    const recentPurchases = (recentPayload && recentPayload.purchases) || [];

    list.innerHTML = top.map(cat => {
        const pct = total > 0 ? ((cat.category_amount / total) * 100).toFixed(1) : 0;
        const barWidth = (cat.category_amount / maxAmount) * 100;
        const color = getColorFor(cat.category);

        return `
            <div class="category-row"
                 data-category="${escapeHtml(cat.category)}"
                 style="--dot-color: ${color};">
                <span class="category-name">${escapeHtml(cat.category)}</span>
                <span class="category-bar">
                    <span class="category-fill"
                          style="background: ${color}; width: 0%;"
                          data-target-width="${barWidth}"></span>
                </span>
                <span class="category-amount">${formatRupeesClean(cat.category_amount)}</span>
                <span class="category-pct">${pct}%</span>
            </div>
        `;
    }).join("");

    // Animate bars in
    requestAnimationFrame(() => {
        list.querySelectorAll(".category-fill").forEach((fill, i) => {
            const target = fill.getAttribute("data-target-width");
            setTimeout(() => {
                fill.style.width = `${target}%`;
            }, 100 + i * 80);
        });
    });

    // Hover preview logic
    setupCategoryPreview(list, recentPurchases);
}


/**
 * Set up hover preview for category rows.
 * Shows a floating panel with the 3 most recent expenses
 * in the hovered category.
 */
function setupCategoryPreview(list, recentPurchases) {
    const preview = document.getElementById("categoryPreview");
    const header = document.getElementById("categoryPreviewHeader");
    const previewList = document.getElementById("categoryPreviewList");
    if (!preview || !header || !previewList) return;

    let hideTimer = null;

    list.querySelectorAll(".category-row").forEach(row => {
        row.addEventListener("mouseenter", () => {
            clearTimeout(hideTimer);

            const category = row.getAttribute("data-category");
            const entries = recentPurchases
                .filter(p => p.category === category)
                .slice(0, 3);

            header.textContent = `Recent · ${category}`;

            if (entries.length === 0) {
                previewList.innerHTML = `<p style="color: var(--text-muted); font-size: 0.82rem;">No recent entries in this category.</p>`;
            } else {
                previewList.innerHTML = entries.map(e => `
                    <div class="preview-entry">
                        <div class="preview-entry-info">
                            <span class="preview-entry-business">${escapeHtml(e.business)}</span>
                            <span class="preview-entry-date">${formatDate(e.date)}</span>
                        </div>
                        <span class="preview-entry-amount">${formatRupeesClean(e.amount)}</span>
                    </div>
                `).join("");
            }

            // Position preview to the right of the row
            // Smart positioning — try RIGHT of row first, then LEFT, then BELOW
            const rect = row.getBoundingClientRect();
            const previewWidth = 300;
            const previewHeight = 220;  // estimate
            const gap = 16;

            let leftPos, topPos;

            // Try RIGHT
            if (rect.right + gap + previewWidth < window.innerWidth - 20) {
                leftPos = rect.right + gap;
                topPos = rect.top;
            }
            // Try LEFT
            else if (rect.left - gap - previewWidth > 20) {
                leftPos = rect.left - gap - previewWidth;
                topPos = rect.top;
            }
            // Fall back to BELOW the row, centered
            else {
                leftPos = Math.max(
                    20,
                    Math.min(
                        rect.left + (rect.width / 2) - (previewWidth / 2),
                        window.innerWidth - previewWidth - 20
                    )
                );
                topPos = rect.bottom + gap;
            }

            // Also clamp vertical position so it stays in viewport
            if (topPos + previewHeight > window.innerHeight - 20) {
                topPos = window.innerHeight - previewHeight - 20;
            }
            if (topPos < 20) topPos = 20;

            preview.style.top = `${topPos}px`;
            preview.style.left = `${leftPos}px`;

            preview.removeAttribute("hidden");
            requestAnimationFrame(() => preview.classList.add("show"));
        });

        row.addEventListener("mouseleave", () => {
            hideTimer = setTimeout(() => {
                preview.classList.remove("show");
                setTimeout(() => preview.setAttribute("hidden", ""), 200);
            }, 150);
        });
    });
}


/* =============================================================
   FORMAT HELPER — Clean rupees, no decimals for whole numbers
   =============================================================
   Kept here in case it's not already defined elsewhere.
   Delete this function if formatRupeesClean already exists.
   ============================================================= */

if (typeof formatRupeesClean === "undefined") {
    window.formatRupeesClean = function (amount) {
        const n = Number(amount);
        const hasDecimal = n % 1 !== 0;
        return "₹" + n.toLocaleString("en-IN", {
            minimumFractionDigits: hasDecimal ? 2 : 0,
            maximumFractionDigits: hasDecimal ? 2 : 0,
        });
    };
}

/* =============================================================
   ═════════════════════════════════════════════════════════════
   WRITE PAGE — "Capture a Moment" (v3 — clean rebuild)
   ═════════════════════════════════════════════════════════════

   Complete rewrite. Simpler. Reliable. Both card views always
   visible together. Text always readable. Everything tested.
   ============================================================= */

(function () {
    "use strict";

    // Guard: only run on Write page
    if (!document.getElementById("writeInput")) return;


    // ══════════════════════════════════════════════════════════
    // CONFIG
    // ══════════════════════════════════════════════════════════

    const CONFIG = {
        parseDebounce: 400,
        flowModeWindow: 90000,
        flowModeExitDelay: 60000,
        justSavedDuration: 3000,
        lastSavedFooterDuration: 60000,
    };


    // ══════════════════════════════════════════════════════════
    // STATE
    // ══════════════════════════════════════════════════════════

    const state = {
        parseTimer: null,
        lastParsed: null,
        cardVisible: false,
        currentReceiptFile: null,
        lastSaveTime: 0,
        saveCount: 0,
        flowModeActive: false,
        flowExitTimer: null,
        recentMerchants: [],
        todayCount: 0,
        todayTotal: 0,
        lastSavedName: null,
        lastSavedTimer: null,
        suggestionsOpen: false,
        activeSuggestionIndex: -1,
    };


    // ══════════════════════════════════════════════════════════
    // DOM CACHE
    // ══════════════════════════════════════════════════════════

    const dom = {};

    function cacheDom() {
        // Hero + input
        dom.input = document.getElementById("writeInput");
        dom.inputWrap = document.getElementById("writeInputWrap");
        dom.tokens = document.getElementById("writeTokens");
        dom.manualLink = document.getElementById("writeManualLink");
        dom.suggestions = document.getElementById("writeSuggestions");
        dom.suggestionsList = document.getElementById("suggestionsList");

        // Card container
        dom.cardWrap = document.getElementById("writeCardWrap");
        dom.card = document.getElementById("writeCard");
        dom.cardView = document.getElementById("writeCardView");
        dom.cardEdit = document.getElementById("writeCardEdit");
        dom.cardReceipt = document.getElementById("writeCardReceipt");
        dom.cardReceiptImg = document.getElementById("writeCardReceiptImg");
        dom.receiptRemove = document.getElementById("receiptRemove");

        // Receipt view (read-only summary)
        dom.merchant = document.getElementById("cardMerchant");
        dom.category = document.getElementById("cardCategory");
        dom.amount = document.getElementById("cardAmount");
        dom.date = document.getElementById("cardDate");
        dom.noteDisplay = document.getElementById("cardNoteDisplay");
        dom.confidence = document.getElementById("cardConfidence");
        dom.saveBtn = document.getElementById("cardSaveBtn");
        dom.editBtn = document.getElementById("cardEditBtn");
        dom.noteBtn = document.getElementById("cardNoteBtn");

        // Edit form (always visible below receipt)
        dom.editBusiness = document.getElementById("editBusiness");
        dom.editAmount = document.getElementById("editAmount");
        dom.editDate = document.getElementById("editDate");
        dom.editCategory = document.getElementById("editCategory");
        dom.editNote = document.getElementById("editNote");
        dom.editReceipt = document.getElementById("editReceipt");
        dom.editAttachLabel = document.getElementById("editAttachLabel");
        dom.editSaveBtn = document.getElementById("editSaveBtn");
        dom.editCancelBtn = document.getElementById("editCancelBtn");

        // Post-save
        dom.checkmark = document.getElementById("writeCheckmark");
        dom.justSaved = document.getElementById("writeJustSaved");

        // Flow + context
        dom.flow = document.getElementById("writeFlow");
        dom.flowPills = document.getElementById("flowPills");
        dom.contextText = document.getElementById("writeContextText");

        // Drop overlay
        dom.dropOverlay = document.getElementById("writeDropOverlay");
    }


    // ══════════════════════════════════════════════════════════
    // INIT
    // ══════════════════════════════════════════════════════════

    async function init() {
        cacheDom();

        await Promise.all([
            loadRecentMerchants(),
            loadTodayStats(),
        ]);

        // Set default date in edit form
        if (dom.editDate) dom.editDate.value = todayIsoDate();

        setupInputHandlers();
        setupCardHandlers();
        setupEditHandlers();
        setupDragDrop();
        setupKeyboardShortcuts();
        setupSuggestions();

        renderContext();

        // Focus input on load
        if (dom.input) dom.input.focus();
    }


    // ══════════════════════════════════════════════════════════
    // DATA FETCHING
    // ══════════════════════════════════════════════════════════

    async function loadRecentMerchants() {
        try {
            const res = await fetch("/api/purchases?limit=30");
            if (!res.ok) return;
            const data = await res.json();
            const seen = new Set();
            const merchants = [];
            for (const p of (data.purchases || [])) {
                const key = (p.business || "").trim();
                if (key && !seen.has(key.toLowerCase())) {
                    seen.add(key.toLowerCase());
                    merchants.push(key);
                    if (merchants.length >= 8) break;
                }
            }
            state.recentMerchants = merchants;
        } catch (err) {
            console.warn("[Write] merchants load failed", err);
        }
    }

    async function loadTodayStats() {
        try {
            const res = await fetch("/api/stats");
            if (!res.ok) return;
            const data = await res.json();
            state.todayCount = data.today_count || 0;
            state.todayTotal = data.today_total || 0;
        } catch (err) {
            console.warn("[Write] stats load failed", err);
        }
    }


    // ══════════════════════════════════════════════════════════
    // INPUT HANDLERS
    // ══════════════════════════════════════════════════════════

    function setupInputHandlers() {
        dom.input.addEventListener("input", handleInputChange);

        dom.input.addEventListener("keydown", (e) => {
            if (e.key === "Enter") {
                e.preventDefault();
                if (state.cardVisible) {
                    saveExpense();
                } else if (dom.input.value.trim()) {
                    // Force immediate parse if user hits enter early
                    clearTimeout(state.parseTimer);
                    parseInput();
                }
            }
        });

        dom.manualLink.addEventListener("click", openManualEntry);
    }

    function handleInputChange() {
        const value = dom.input.value;

        if (value.length > 0) {
            dom.inputWrap.classList.add("has-content");
            dom.manualLink.classList.add("hidden");
        } else {
            dom.inputWrap.classList.remove("has-content");
            dom.manualLink.classList.remove("hidden");
            hideCard();
            clearTokens();
        }

        checkForTriggers(value);

        clearTimeout(state.parseTimer);
        const trimmed = value.trim();
        const hasNumber = /\d/.test(trimmed);
        const hasWord = /[a-z]{2,}/i.test(trimmed);

        // Parse if we have at least: a number AND some letters
        if (trimmed.length >= 4 && hasNumber && hasWord) {
            state.parseTimer = setTimeout(parseInput, CONFIG.parseDebounce);
        } else if (trimmed.length === 0) {
            hideCard();
            clearTokens();
        }
    }


    // ══════════════════════════════════════════════════════════
    // AI PARSING
    // ══════════════════════════════════════════════════════════

    async function parseInput() {
        const text = dom.input.value.trim();
        if (!text) {
            hideCard();
            clearTokens();
            return;
        }

        try {
            const res = await fetch("/api/insights/parse-nlp", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ text }),
            });

            if (!res.ok) throw new Error(`HTTP ${res.status}`);
            const data = await res.json();

            // Update tokens no matter what
            updateTokens(data);

            if (data.parsed_ok) {
                state.lastParsed = data;
                showCard(data);
            } else {
                // Parse failed but we still show tokens for whatever we detected
                signalParseFailure();
            }
        } catch (err) {
            console.warn("[Write] parse failed", err);
            signalParseFailure();
        }
    }

    function signalParseFailure() {
        dom.inputWrap.style.borderColor = "var(--warning)";
        setTimeout(() => {
            dom.inputWrap.style.borderColor = "";
        }, 800);
    }


    // ══════════════════════════════════════════════════════════
    // TOKEN CHIPS (below input)
    // ══════════════════════════════════════════════════════════

    function updateTokens(parsed) {
        if (!dom.tokens) return;

        if (!parsed) {
            clearTokens();
            return;
        }

        const chips = [];

        if (parsed.amount && parsed.confidence?.amount !== "none") {
            chips.push(`
                <span class="write-token token-amount">
                    <span class="write-token-label">Amount</span>
                    <span class="write-token-value">${formatRupeesClean(parsed.amount)}</span>
                </span>
            `);
        }

        if (parsed.business && parsed.confidence?.business !== "none") {
            chips.push(`
                <span class="write-token token-merchant">
                    <span class="write-token-label">Merchant</span>
                    <span class="write-token-value">${escapeHtml(parsed.business)}</span>
                </span>
            `);
        }

        if (parsed.date && parsed.confidence?.date !== "default") {
            chips.push(`
                <span class="write-token token-date">
                    <span class="write-token-label">Date</span>
                    <span class="write-token-value">${formatDateShort(parsed.date)}</span>
                </span>
            `);
        }

        if (parsed.category && parsed.confidence?.category !== "none") {
            chips.push(`
                <span class="write-token token-category">
                    <span class="write-token-label">Category</span>
                    <span class="write-token-value">${escapeHtml(parsed.category)}</span>
                </span>
            `);
        }

        if (chips.length > 0) {
            dom.tokens.innerHTML = chips.join("");
            dom.tokens.hidden = false;
        } else {
            clearTokens();
        }
    }

    function clearTokens() {
        if (!dom.tokens) return;
        dom.tokens.hidden = true;
        dom.tokens.innerHTML = "";
    }

    function formatDateShort(isoDate) {
        if (!isoDate) return "Today";
        const [y, m, d] = isoDate.split("-").map(Number);
        const date = new Date(y, m - 1, d);
        const today = new Date();
        today.setHours(0, 0, 0, 0);
        const diffDays = Math.round((today - date) / (1000 * 60 * 60 * 24));

        if (diffDays === 0) return "Today";
        if (diffDays === 1) return "Yesterday";
        if (diffDays === -1) return "Tomorrow";

        const monthShort = date.toLocaleString("en-US", { month: "short" });
        return `${monthShort} ${date.getDate()}`;
    }


    // ══════════════════════════════════════════════════════════
    // CARD LIFECYCLE
    // ══════════════════════════════════════════════════════════

    /**
     * Show the card with both views (receipt + edit form) visible.
     * Pre-fills edit form with parsed values.
     */
    function showCard(parsed) {
        state.cardVisible = true;

        // Populate the read-only receipt view
        renderReceiptView(parsed);

        // Compute + set confidence indicator
        const confidence = calculateConfidence(parsed);
        setConfidence(confidence);

        // ALWAYS show both views together
        dom.cardView.hidden = false;
        dom.cardEdit.hidden = false;

        // Pre-fill the edit form with parsed values
        dom.editBusiness.value = parsed?.business || "";
        dom.editAmount.value = parsed?.amount || "";
        dom.editDate.value = parsed?.date || todayIsoDate();
        dom.editCategory.value = parsed?.category || "Misc";
        dom.editNote.value = "";

        // Reveal the card container
        dom.cardWrap.hidden = false;
    }

    function hideCard() {
        state.cardVisible = false;
        if (dom.cardWrap) dom.cardWrap.hidden = true;

        // Reset receipt file
        state.currentReceiptFile = null;
        if (dom.cardReceipt) dom.cardReceipt.hidden = true;
    }

    function renderReceiptView(parsed) {
        dom.merchant.textContent = (parsed?.business || "UNTITLED").toUpperCase();
        dom.category.textContent = parsed?.category || "Uncategorized";
        dom.amount.textContent = formatRupeesClean(parsed?.amount || 0);
        dom.date.textContent = formatDateNatural(parsed?.date);

        if (parsed?.note && parsed.note.trim()) {
            dom.noteDisplay.textContent = parsed.note;
            dom.noteDisplay.hidden = false;
        } else {
            dom.noteDisplay.hidden = true;
        }
    }

    function calculateConfidence(parsed) {
        if (!parsed) return "low";
        let score = 0;
        if (parsed.confidence?.amount === "high") score += 2;
        else if (parsed.confidence?.amount) score += 1;
        if (parsed.confidence?.business === "high") score += 2;
        else if (parsed.confidence?.business === "medium") score += 1;
        if (parsed.confidence?.date === "high") score += 1;
        if (parsed.confidence?.category !== "none") score += 1;

        if (score >= 5) return "high";
        if (score >= 3) return "medium";
        return "low";
    }

    function setConfidence(level) {
        dom.confidence.className = "card-confidence " + (level !== "high" ? level : "");
        const textEl = dom.confidence.querySelector(".confidence-text");
        if (level === "high") textEl.textContent = "High confidence";
        if (level === "medium") textEl.textContent = "Review before saving";
        if (level === "low") textEl.textContent = "Please review";
    }


    // ══════════════════════════════════════════════════════════
    // MANUAL ENTRY LINK
    // ══════════════════════════════════════════════════════════

    /**
     * "or add details manually" — opens the card with empty form,
     * ready for direct manual input. No AI parse happens.
     */
    function openManualEntry() {
        state.cardVisible = true;
        state.lastParsed = null;

        // Blank receipt view display
        dom.merchant.textContent = "NEW ENTRY";
        dom.category.textContent = "—";
        dom.amount.textContent = "₹0";
        dom.date.textContent = "Today";
        dom.noteDisplay.hidden = true;
        setConfidence("high");

        // Both views visible
        dom.cardView.hidden = false;
        dom.cardEdit.hidden = false;

        // Empty edit form (except date defaults to today)
        dom.editBusiness.value = "";
        dom.editAmount.value = "";
        dom.editDate.value = todayIsoDate();
        dom.editCategory.value = "Misc";
        dom.editNote.value = "";

        dom.cardWrap.hidden = false;

        // Focus merchant field to start typing
        setTimeout(() => dom.editBusiness.focus(), 50);
    }


    // ══════════════════════════════════════════════════════════
    // CARD ACTION HANDLERS
    // ══════════════════════════════════════════════════════════

    function setupCardHandlers() {
        dom.saveBtn.addEventListener("click", saveExpense);

        dom.editBtn.addEventListener("click", () => {
            // Both views already visible — just focus the form
            setTimeout(() => dom.editBusiness.focus(), 50);
        });

        dom.noteBtn.addEventListener("click", () => {
            // Focus the note field
            setTimeout(() => dom.editNote.focus(), 50);
        });

        dom.receiptRemove.addEventListener("click", () => {
            state.currentReceiptFile = null;
            dom.cardReceipt.hidden = true;
        });
    }

    function setupEditHandlers() {
        dom.editSaveBtn.addEventListener("click", saveExpense);

        dom.editCancelBtn.addEventListener("click", () => {
            // "Clear" — reset everything and start fresh
            hideCard();
            clearTokens();
            dom.input.value = "";
            dom.inputWrap.classList.remove("has-content");
            dom.manualLink.classList.remove("hidden");
            dom.input.focus();
        });

        dom.editReceipt.addEventListener("change", (e) => {
            const file = e.target.files[0];
            if (file) attachReceipt(file);
        });

        // ── Live sync: when user edits form, update receipt view ──
        // This keeps the two views in sync so what user sees on
        // the receipt matches what will actually be saved.

        dom.editBusiness.addEventListener("input", () => {
            dom.merchant.textContent = (dom.editBusiness.value || "UNTITLED").toUpperCase();
        });

        dom.editAmount.addEventListener("input", () => {
            const val = parseFloat(dom.editAmount.value) || 0;
            dom.amount.textContent = formatRupeesClean(val);
        });

        dom.editDate.addEventListener("input", () => {
            dom.date.textContent = formatDateNatural(dom.editDate.value);
        });

        dom.editCategory.addEventListener("change", () => {
            dom.category.textContent = dom.editCategory.value;
        });

        dom.editNote.addEventListener("input", () => {
            const val = dom.editNote.value.trim();
            if (val) {
                dom.noteDisplay.textContent = val;
                dom.noteDisplay.hidden = false;
            } else {
                dom.noteDisplay.hidden = true;
            }
        });
    }


    // ══════════════════════════════════════════════════════════
    // SAVE EXPENSE
    // ══════════════════════════════════════════════════════════

    async function saveExpense() {
        // Always read from the edit form (source of truth)
        const payload = {
            business: dom.editBusiness.value.trim(),
            amount: dom.editAmount.value,
            date: dom.editDate.value,
            category: dom.editCategory.value,
            description: dom.editNote.value.trim(),
        };

        // Validate
        if (!payload.business || !payload.amount) {
            signalParseFailure();
            if (!payload.business) {
                dom.editBusiness.focus();
            } else {
                dom.editAmount.focus();
            }
            return;
        }

        dom.saveBtn.disabled = true;
        dom.editSaveBtn.disabled = true;

        const formData = new FormData();
        formData.append("date", payload.date);
        formData.append("business", payload.business);
        formData.append("amount", payload.amount);
        formData.append("category", payload.category);
        formData.append("description", payload.description);
        if (state.currentReceiptFile) {
            formData.append("photo", state.currentReceiptFile);
        }

        try {
            const res = await fetch("/api/add", {
                method: "POST",
                body: formData,
            });

            const data = await res.json();

            if (res.ok && data.success) {
                await handleSaveSuccess(payload);
            } else {
                showToast(data.error || "Could not save expense", "error");
                dom.saveBtn.disabled = false;
                dom.editSaveBtn.disabled = false;
            }
        } catch (err) {
            console.error("[Write] save failed", err);
            showToast("Network error — please try again", "error");
            dom.saveBtn.disabled = false;
            dom.editSaveBtn.disabled = false;
        }
    }


    // ══════════════════════════════════════════════════════════
    // SAVE SUCCESS ANIMATION
    // ══════════════════════════════════════════════════════════

    async function handleSaveSuccess(payload) {
        playFilingAnimation();
        showCheckmark();
        showJustSaved(payload.business);

        state.todayCount++;
        state.todayTotal += parseFloat(payload.amount);
        state.lastSavedName = payload.business;

        trackSaveForFlowMode();
        renderContext();

        if (payload.business && !state.recentMerchants.includes(payload.business)) {
            state.recentMerchants.unshift(payload.business);
            if (state.recentMerchants.length > 8) state.recentMerchants.pop();
        }

        setTimeout(() => {
            // Clear everything
            dom.input.value = "";
            dom.inputWrap.classList.remove("has-content");
            dom.manualLink.classList.remove("hidden");
            clearTokens();

            state.currentReceiptFile = null;
            if (dom.cardReceipt) dom.cardReceipt.hidden = true;

            state.cardVisible = false;
            dom.cardWrap.hidden = true;
            dom.cardWrap.classList.remove("filing-away");

            dom.saveBtn.disabled = false;
            dom.editSaveBtn.disabled = false;

            dom.input.focus();

            if (state.flowModeActive) renderFlowMode();
        }, 500);
    }

    function playFilingAnimation() {
        dom.cardWrap.classList.add("filing-away");
    }

    function showCheckmark() {
        dom.checkmark.hidden = false;
        setTimeout(() => { dom.checkmark.hidden = true; }, 900);
    }

    function showJustSaved(business) {
        dom.justSaved.textContent = `Saved. ${business} added to your ledger.`;
        dom.justSaved.hidden = false;
        setTimeout(() => { dom.justSaved.hidden = true; }, CONFIG.justSavedDuration);
    }


    // ══════════════════════════════════════════════════════════
    // FLOW MODE
    // ══════════════════════════════════════════════════════════

    function trackSaveForFlowMode() {
        const now = Date.now();
        const timeSince = now - state.lastSaveTime;

        if (timeSince < CONFIG.flowModeWindow) {
            state.saveCount++;
            if (state.saveCount >= 2 && !state.flowModeActive) {
                enterFlowMode();
            }
        } else {
            state.saveCount = 1;
        }

        state.lastSaveTime = now;
        clearTimeout(state.flowExitTimer);
        state.flowExitTimer = setTimeout(exitFlowMode, CONFIG.flowModeExitDelay);
    }

    function enterFlowMode() {
        state.flowModeActive = true;
        renderFlowMode();
    }

    function exitFlowMode() {
        state.flowModeActive = false;
        state.saveCount = 0;
        if (dom.flow) dom.flow.hidden = true;
    }

    function renderFlowMode() {
        if (!state.flowModeActive || state.recentMerchants.length === 0) {
            dom.flow.hidden = true;
            return;
        }

        dom.flowPills.innerHTML = "";
        state.recentMerchants.slice(0, 5).forEach(merchant => {
            const pill = document.createElement("button");
            pill.className = "flow-pill";
            pill.textContent = merchant;
            pill.addEventListener("click", () => {
                dom.input.value = merchant + " ";
                dom.input.focus();
                handleInputChange();
            });
            dom.flowPills.appendChild(pill);
        });

        dom.flow.hidden = false;
    }


    // ══════════════════════════════════════════════════════════
    // CONTEXTUAL FOOTER
    // ══════════════════════════════════════════════════════════

    function renderContext() {
        const count = state.todayCount;
        const total = state.todayTotal;

        clearTimeout(state.lastSavedTimer);

        if (state.lastSavedName) {
            const encoded = escapeHtml(state.lastSavedName);
            dom.contextText.innerHTML = `Last: <strong>${encoded}</strong> · just now`;
            state.lastSavedTimer = setTimeout(() => {
                state.lastSavedName = null;
                renderContext();
            }, CONFIG.lastSavedFooterDuration);
            return;
        }

        if (count === 0) {
            dom.contextText.textContent = "Start today's ledger.";
        } else if (count <= 5) {
            dom.contextText.innerHTML =
                `You've logged <strong>${count}</strong> ` +
                `${count === 1 ? "expense" : "expenses"} today · ` +
                `<strong>${formatRupeesClean(total)}</strong> ` +
                `<a href="/recent">view →</a>`;
        } else {
            dom.contextText.innerHTML =
                `You're on fire today. <strong>${count}</strong> expenses ` +
                `so far · <strong>${formatRupeesClean(total)}</strong> ` +
                `<a href="/recent">view →</a>`;
        }
    }


    // ══════════════════════════════════════════════════════════
    // @ MERCHANT SUGGESTIONS
    // ══════════════════════════════════════════════════════════

    function setupSuggestions() {
        document.addEventListener("click", (e) => {
            if (state.suggestionsOpen &&
                !dom.suggestions.contains(e.target) &&
                e.target !== dom.input) {
                closeSuggestions();
            }
        });

        dom.input.addEventListener("keydown", (e) => {
            if (!state.suggestionsOpen) return;
            const items = dom.suggestionsList.querySelectorAll(".suggestion-item");
            if (items.length === 0) return;

            if (e.key === "ArrowDown") {
                e.preventDefault();
                state.activeSuggestionIndex = Math.min(state.activeSuggestionIndex + 1, items.length - 1);
                updateActiveSuggestion(items);
            } else if (e.key === "ArrowUp") {
                e.preventDefault();
                state.activeSuggestionIndex = Math.max(state.activeSuggestionIndex - 1, 0);
                updateActiveSuggestion(items);
            } else if (e.key === "Enter" && state.activeSuggestionIndex >= 0) {
                e.preventDefault();
                e.stopPropagation();
                items[state.activeSuggestionIndex].click();
            } else if (e.key === "Escape") {
                closeSuggestions();
            }
        });
    }

    function checkForTriggers(value) {
        const cursorPos = dom.input.selectionStart;
        const textBeforeCursor = value.substring(0, cursorPos);
        const atMatch = textBeforeCursor.match(/@(\w*)$/);

        if (atMatch) {
            openMerchantSuggestions(atMatch[1]);
        } else {
            closeSuggestions();
        }
    }

    function openMerchantSuggestions(query) {
        const filtered = query
            ? state.recentMerchants.filter(m => m.toLowerCase().includes(query.toLowerCase()))
            : state.recentMerchants;

        if (filtered.length === 0) {
            closeSuggestions();
            return;
        }

        dom.suggestionsList.innerHTML = "";
        filtered.slice(0, 6).forEach(merchant => {
            const item = document.createElement("button");
            item.className = "suggestion-item";
            item.textContent = merchant;
            item.addEventListener("click", () => selectMerchant(merchant));
            dom.suggestionsList.appendChild(item);
        });

        dom.suggestions.hidden = false;
        state.suggestionsOpen = true;
        state.activeSuggestionIndex = -1;
    }

    function updateActiveSuggestion(items) {
        items.forEach((item, i) => {
            item.classList.toggle("active", i === state.activeSuggestionIndex);
        });
    }

    function closeSuggestions() {
        dom.suggestions.hidden = true;
        state.suggestionsOpen = false;
        state.activeSuggestionIndex = -1;
    }

    function selectMerchant(merchant) {
        const value = dom.input.value;
        const cursorPos = dom.input.selectionStart;
        const before = value.substring(0, cursorPos);
        const after = value.substring(cursorPos);

        const newBefore = before.replace(/@\w*$/, merchant);
        const newValue = newBefore + after;

        dom.input.value = newValue;
        dom.input.focus();
        dom.input.setSelectionRange(newBefore.length, newBefore.length);

        closeSuggestions();
        handleInputChange();
    }


    // ══════════════════════════════════════════════════════════
    // DRAG & DROP (showcase — no real OCR)
    // ══════════════════════════════════════════════════════════

    function setupDragDrop() {
        let dragCounter = 0;

        window.addEventListener("dragenter", (e) => {
            if (!containsFile(e)) return;
            dragCounter++;
            dom.dropOverlay.hidden = false;
        });

        window.addEventListener("dragleave", (e) => {
            if (!containsFile(e)) return;
            dragCounter--;
            if (dragCounter <= 0) {
                dragCounter = 0;
                dom.dropOverlay.hidden = true;
            }
        });

        window.addEventListener("dragover", (e) => {
            if (containsFile(e)) e.preventDefault();
        });

        window.addEventListener("drop", (e) => {
            if (!containsFile(e)) return;
            e.preventDefault();
            dragCounter = 0;
            dom.dropOverlay.hidden = true;

            const file = e.dataTransfer.files[0];
            if (file && file.type.startsWith("image/")) {
                attachReceipt(file);
            }
        });
    }

    function containsFile(event) {
        return event.dataTransfer &&
            Array.from(event.dataTransfer.types).includes("Files");
    }

    function attachReceipt(file) {
        state.currentReceiptFile = file;

        const reader = new FileReader();
        reader.onload = (e) => {
            dom.cardReceiptImg.src = e.target.result;
            dom.cardReceipt.hidden = false;
        };
        reader.readAsDataURL(file);

        dom.editAttachLabel.textContent = file.name;

        // Show card in manual mode (no AI parse for image)
        if (!state.cardVisible) {
            openManualEntry();
        } else {
            // Card already visible, just attach file
            dom.cardReceipt.hidden = false;
        }
    }


    // ══════════════════════════════════════════════════════════
    // KEYBOARD SHORTCUTS
    // ══════════════════════════════════════════════════════════

    function setupKeyboardShortcuts() {
        document.addEventListener("keydown", (e) => {
            const activeTag = document.activeElement?.tagName;
            const isTypingInField = activeTag === "TEXTAREA" ||
                (activeTag === "INPUT" && document.activeElement !== dom.input);

            if ((e.metaKey || e.ctrlKey) && e.key === "k") {
                e.preventDefault();
                dom.input.value = "";
                dom.input.focus();
                dom.inputWrap.classList.remove("has-content");
                clearTokens();
                hideCard();
                dom.manualLink.classList.remove("hidden");
                return;
            }

            if ((e.metaKey || e.ctrlKey) && e.key === "Enter") {
                if (state.cardVisible) {
                    e.preventDefault();
                    saveExpense();
                }
                return;
            }

            if (e.key === "Escape" && !isTypingInField) {
                if (state.cardVisible) {
                    hideCard();
                    clearTokens();
                } else if (dom.input.value) {
                    dom.input.value = "";
                    dom.inputWrap.classList.remove("has-content");
                    dom.manualLink.classList.remove("hidden");
                }
            }
        });
    }


    // ══════════════════════════════════════════════════════════
    // UTILITIES
    // ══════════════════════════════════════════════════════════

    function todayIsoDate() {
        const now = new Date();
        return [
            now.getFullYear(),
            String(now.getMonth() + 1).padStart(2, "0"),
            String(now.getDate()).padStart(2, "0"),
        ].join("-");
    }

    function formatDateNatural(isoDate) {
        if (!isoDate) return "Today";
        const [y, m, d] = isoDate.split("-").map(Number);
        const date = new Date(y, m - 1, d);
        const today = new Date();
        today.setHours(0, 0, 0, 0);
        const diffDays = Math.round((today - date) / (1000 * 60 * 60 * 24));

        const monthShort = date.toLocaleString("en-US", { month: "short" });
        const day = date.getDate();

        if (diffDays === 0) return `Today · ${monthShort} ${day}`;
        if (diffDays === 1) return `Yesterday · ${monthShort} ${day}`;
        if (diffDays === -1) return `Tomorrow · ${monthShort} ${day}`;
        if (diffDays > 1 && diffDays <= 7) {
            const weekday = date.toLocaleString("en-US", { weekday: "long" });
            return `${weekday} · ${monthShort} ${day}`;
        }
        return `${monthShort} ${day}, ${y}`;
    }


    // ══════════════════════════════════════════════════════════
    // BOOT
    // ══════════════════════════════════════════════════════════

    if (document.readyState === "loading") {
        document.addEventListener("DOMContentLoaded", init);
    } else {
        init();
    }

})();

/**
 * Update the token chips below the input.
 * Shows small colored badges for recognized entities.
 * This replaces the fragile "invisible input" highlight approach.
 */
function updateTokens(parsed) {
    if (!parsed || !parsed.parsed_ok) {
        dom.tokens.hidden = true;
        dom.tokens.innerHTML = "";
        return;
    }

    const chips = [];

    // Amount chip (emerald)
    if (parsed.amount && parsed.confidence?.amount !== "none") {
        chips.push(`
            <span class="write-token token-amount">
                <span class="write-token-label">Amount</span>
                <span class="write-token-value">${formatRupeesClean(parsed.amount)}</span>
            </span>
        `);
    }

    // Merchant chip (neutral)
    if (parsed.business && parsed.confidence?.business !== "none") {
        chips.push(`
            <span class="write-token token-merchant">
                <span class="write-token-label">Merchant</span>
                <span class="write-token-value">${escapeHtml(parsed.business)}</span>
            </span>
        `);
    }

    // Date chip (cyan) — only if confidently detected
    if (parsed.date && parsed.confidence?.date !== "default") {
        const dateLabel = formatDateShort(parsed.date);
        chips.push(`
            <span class="write-token token-date">
                <span class="write-token-label">Date</span>
                <span class="write-token-value">${dateLabel}</span>
            </span>
        `);
    }

    // Category chip (teal) — inferred from keywords
    if (parsed.category && parsed.confidence?.category !== "none") {
        chips.push(`
            <span class="write-token token-category">
                <span class="write-token-label">Category</span>
                <span class="write-token-value">${escapeHtml(parsed.category)}</span>
            </span>
        `);
    }

    if (chips.length > 0) {
        dom.tokens.innerHTML = chips.join("");
        dom.tokens.hidden = false;
    } else {
        dom.tokens.hidden = true;
        dom.tokens.innerHTML = "";
    }
}

/**
 * Short date formatter for token chips.
 * Same day: "Today"
 * Yesterday: "Yesterday"
 * Other: "Nov 22"
 */
function formatDateShort(isoDate) {
    if (!isoDate) return "Today";
    const [y, m, d] = isoDate.split("-").map(Number);
    const date = new Date(y, m - 1, d);
    const today = new Date();
    today.setHours(0, 0, 0, 0);
    const diffDays = Math.round((today - date) / (1000 * 60 * 60 * 24));

    if (diffDays === 0) return "Today";
    if (diffDays === 1) return "Yesterday";
    if (diffDays === -1) return "Tomorrow";

    const monthShort = date.toLocaleString("en-US", { month: "short" });
    return `${monthShort} ${date.getDate()}`;
}

/**
 * Set up the ring context panel interactions.
 * Handles hover, focus, tap, and smart positioning.
 */
function initRingContext() {
    const ring = document.getElementById("healthRingContainer");
    const panel = document.getElementById("ringContext");
    if (!ring || !panel) return;

    let hideTimer = null;
    let isPinned = false;    // for click/tap toggle on mobile

    /**
     * Compute and apply optimal position.
     * Tries in order: left of ring, right of ring, below ring, above ring.
     * Always clamps within viewport with 20px padding.
     */
    function positionPanel() {
        const ringRect = ring.getBoundingClientRect();
        const panelW = panel.offsetWidth;
        const panelH = panel.offsetHeight;
        const vw = window.innerWidth;
        const vh = window.innerHeight;
        const padding = 20;
        const gap = 20;

        // Positioning candidates (in preference order)
        const positions = [
            {
                // Left of ring, vertically centered
                left: ringRect.left - panelW - gap,
                top: ringRect.top + (ringRect.height / 2) - (panelH / 2),
                fits: () =>
                    (ringRect.left - panelW - gap) > padding,
            },
            {
                // Below ring, horizontally centered
                left: ringRect.left + (ringRect.width / 2) - (panelW / 2),
                top: ringRect.bottom + gap,
                fits: () =>
                    (ringRect.bottom + panelH + gap) < (vh - padding),
            },
            {
                // Above ring, horizontally centered
                left: ringRect.left + (ringRect.width / 2) - (panelW / 2),
                top: ringRect.top - panelH - gap,
                fits: () =>
                    (ringRect.top - panelH - gap) > padding,
            },
            {
                // Right of ring (last resort)
                left: ringRect.right + gap,
                top: ringRect.top + (ringRect.height / 2) - (panelH / 2),
                fits: () =>
                    (ringRect.right + panelW + gap) < (vw - padding),
            },
        ];

        // Pick first position that fits
        let chosen = positions.find(p => p.fits()) || positions[1]; // fallback: below

        // Clamp within viewport
        let leftPx = Math.max(padding, Math.min(chosen.left, vw - panelW - padding));
        let topPx = Math.max(padding, Math.min(chosen.top, vh - panelH - padding));

        // Position uses fixed since it's added at body scope for accuracy
        panel.style.position = "fixed";
        panel.style.left = `${leftPx}px`;
        panel.style.top = `${topPx}px`;
    }

    function showPanel() {
        clearTimeout(hideTimer);
        panel.hidden = false;
        // Measure requires visibility — position after making visible
        requestAnimationFrame(() => {
            positionPanel();
            panel.classList.add("visible");
        });
    }

    function hidePanel() {
        panel.classList.remove("visible");
        hideTimer = setTimeout(() => {
            panel.hidden = true;
        }, 300); // matches CSS transition
    }

    // ── Desktop: hover interactions ──────────────────────
    ring.addEventListener("mouseenter", () => {
        if (isPinned) return;  // ignore hover when pinned via click
        showPanel();
    });

    ring.addEventListener("mouseleave", () => {
        if (isPinned) return;
        hideTimer = setTimeout(hidePanel, 200);
    });

    // Keep panel open when mouse is over it
    panel.addEventListener("mouseenter", () => {
        clearTimeout(hideTimer);
    });

    panel.addEventListener("mouseleave", () => {
        if (isPinned) return;
        hideTimer = setTimeout(hidePanel, 150);
    });

    // ── Mobile / keyboard: tap/click toggle ─────────────
    ring.addEventListener("click", (e) => {
        e.stopPropagation();
        isPinned = !isPinned;
        if (isPinned) {
            showPanel();
        } else {
            hidePanel();
        }
    });

    ring.addEventListener("keydown", (e) => {
        if (e.key === "Enter" || e.key === " ") {
            e.preventDefault();
            ring.click();
        }
        if (e.key === "Escape") {
            isPinned = false;
            hidePanel();
        }
    });

    // Click outside to close (when pinned)
    document.addEventListener("click", (e) => {
        if (!isPinned) return;
        if (!panel.contains(e.target) && !ring.contains(e.target)) {
            isPinned = false;
            hidePanel();
        }
    });

    // Reposition on window resize (only if panel visible)
    window.addEventListener("resize", () => {
        if (!panel.hidden) positionPanel();
    });

    // Reposition on scroll (only if panel visible)
    window.addEventListener("scroll", () => {
        if (!panel.hidden) positionPanel();
    }, { passive: true });
}