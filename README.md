# SpendWise 💰

**Track Smarter. Spend Better.**

SpendWise is an **AI-powered personal financial intelligence platform** built as a B.Tech Computer Science Engineering final year project. It goes beyond simple expense tracking — it analyzes your spending behavior, detects anomalies, predicts future spending, and gives you a real-time financial health score.

---

## Why SpendWise?

> *"There are already thousands of expense tracker applications."*

SpendWise is not just a tracker. It answers questions that raw data cannot:

| Tracker says | SpendWise says |
|---|---|
| You spent ₹4,500 at Zomato | That is 2.8× your usual restaurant spend |
| You spent ₹12,400 this month | Your spending is trending 18% higher — health score dropped 6 points |
| You spent in 5 categories | You are a "Socialite" — 42% goes to dining out |
| Your total is ₹1,20,000 | Next month you will likely spend ₹14,200 based on weighted moving average |

---

## Features

### Core Features
| Feature | Description |
|---|---|
| **Expense CRUD** | Add, edit, delete expenses with date, amount, category, notes, receipt photo |
| **Dashboard** | Real-time stat cards with GSAP count-up animations |
| **Analytics** | Monthly breakdown, category bars, per-month pie charts |
| **Transactions** | Searchable, filterable, paginated table with lazy photo loading |
| **Receipt Upload** | Photo stored as BLOB, viewable in lightbox |
| **Category Pills** | One-click category selection with inline SVG icons |

### AI / Intelligence Features
| Feature | Algorithm | Description |
|---|---|---|
| **Financial Health Score** | Rule-based 4-component engine | 0–100 score: budget adherence (30pts), spending trend (25pts), consistency (25pts), savings potential (20pts) |
| **Anomaly Detection** | Z-Score + IsolationForest (scikit-learn) | Flags expenses >2σ from category mean. ML model catches cross-feature patterns |
| **Spending Personality** | Category ratio classification | 6 archetypes: Planner, Socialite, Shopaholic, Nester, Impulsive, Saver |
| **Cash Flow Forecast** | Weighted Moving Average + LinearRegression | Predicts next month's spending total and per-category breakdown |
| **Duplicate Detector** | Bigram Jaccard similarity + time window | Warns before saving similar expenses within ±2 days and ±₹1 |
| **Weekly Report** | Rolling 7-day comparison | Week-over-week change, top categories, alerts for 1.8× spending spikes |

### UX Features
| Feature | Technology | Description |
|---|---|---|
| **Natural Language Input** | Python regex + keyword matching | Type "spent 500 at Zomato yesterday" → form auto-populates |
| **Achievement System** | Event-driven + INSERT OR IGNORE | 9 milestones with toast notifications and point values |
| **Budget Guardrails** | Per-category limits | Set monthly budgets, track burn rate, feeds into health score |
| **Dark Premium UI** | CSS custom properties | Zinc dark palette, indigo accent, frosted glass header |
| **GSAP Animations** | GreenSock | Count-up numbers, staggered cards, animated bars, lightbox transitions |
| **Keyboard Shortcuts** | Global keydown listener | N=Add, /=Search, D=Dashboard, A=Analytics, T=Transactions |

---

## Tech Stack

| Layer | Technology | Why |
|---|---|---|
| **Backend** | Python 3.9+, Flask | Lightweight, no boilerplate, ideal for single-user apps |
| **Database** | SQLite | Zero-config, embedded, full SQL — schema migrates to PostgreSQL with zero query changes |
| **ML/Stats** | scikit-learn, pandas, numpy | IsolationForest anomaly detection, LinearRegression forecasting, DataFrame aggregation |
| **Frontend** | HTML5, CSS3, Vanilla JavaScript | No framework dependency — demonstrates core skills |
| **Reactivity** | Alpine.js | Lightweight reactive UI without React/Vue — no build step required |
| **Animation** | GSAP (GreenSock) | Professional timeline animations used by Apple, Google, Linear |
| **Charts** | Chart.js + annotation plugin | Doughnut, bar charts with custom tooltips and average line overlay |

---

## Architecture

```
HTTP Request
    ↓
app.py (thin controller — routes only)
    ↓
validators.py (input validation)
    ↓
database.py (all SQL operations)
    ↓  (for intelligence endpoints)
insights.py (ML + statistical analysis)
    ↓
JSON Response
    ↓
script.js (DOM updates, charts, animations)
    ↓
User sees result
```

### Layered Architecture
```
SpendWise/
├── app.py           ← Routes only (thin controller)
├── database.py      ← All database operations (repository pattern)
├── validators.py    ← All input validation
├── insights.py      ← All business intelligence (6 algorithms)
├── requirements.txt
├── README.md
├── .gitignore
├── static/
│   ├── styles.css   ← Complete dark design system
│   ├── script.js    ← Frontend logic (21 sections)
│   └── images/
└── templates/
    ├── base.html    ← Layout + script loading
    ├── index.html   ← Dashboard (7 sections)
    ├── add.html     ← Add Expense (Alpine.js reactive form)
    ├── monthly.html ← Analytics (forecast + breakdown)
    ├── recent.html  ← Transactions (paginated table)
    └── 404.html     ← Error page
```

---

## Database Schema

```sql
-- Core expense table (indexed on date, category, date+category)
CREATE TABLE purchases (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    date        TEXT    NOT NULL,        -- YYYY-MM-DD
    business    TEXT    NOT NULL,
    amount      REAL    NOT NULL CHECK(amount > 0),
    category    TEXT    NOT NULL,
    description TEXT,
    photo       BLOB,
    created_at  TEXT    DEFAULT (datetime('now'))
);

-- Monthly budget limits per category
CREATE TABLE budgets (
    id       INTEGER PRIMARY KEY AUTOINCREMENT,
    category TEXT    NOT NULL UNIQUE,
    amount   REAL    NOT NULL CHECK(amount > 0)
);

-- Unlocked achievement milestones
CREATE TABLE achievements (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    key         TEXT    NOT NULL UNIQUE,
    title       TEXT    NOT NULL,
    description TEXT,
    unlocked_at TEXT    DEFAULT (datetime('now'))
);
```

---

## API Endpoints

### Expense CRUD
| Method | Endpoint | Description |
|---|---|---|
| `POST` | `/api/add` | Create expense (multipart/form-data) |
| `GET` | `/api/purchases?page=&limit=` | Paginated list (no photos) |
| `GET` | `/api/purchases/<id>/photo` | Lazy-load receipt photo |
| `PUT` | `/api/purchases/<id>` | Update expense (JSON) |
| `DELETE` | `/api/purchases/<id>` | Delete expense |

### Analytics
| Method | Endpoint | Description |
|---|---|---|
| `GET` | `/api/stats` | Dashboard summary (6 metrics) |
| `GET` | `/api/monthly-totals?sort=` | Monthly aggregation |
| `GET` | `/api/category-totals?month=` | Category aggregation |

### Intelligence
| Method | Endpoint | Description |
|---|---|---|
| `GET` | `/api/insights/health-score` | Financial health score (0–100) |
| `GET` | `/api/insights/anomalies` | Unusual expense detection |
| `GET` | `/api/insights/personality` | Spending personality classification |
| `GET` | `/api/insights/forecast` | Next month prediction |
| `GET` | `/api/insights/weekly-report` | 7-day spending summary |
| `POST` | `/api/insights/parse-nlp` | Natural language parsing |
| `POST` | `/api/insights/check-duplicate` | Duplicate expense check |

### Budgets & Achievements
| Method | Endpoint | Description |
|---|---|---|
| `GET` | `/api/budgets` | All budget limits |
| `POST` | `/api/budgets` | Set/update a budget |
| `GET` | `/api/achievements` | All unlocked achievements |

---

## Installation

### Prerequisites
- Python 3.9 or higher
- pip (Python package manager)
- Tesseract OCR engine (optional, for receipt scanning)

### Steps

```bash
# Clone the repository
git clone https://github.com/rajsvmahendra/SpendWise.git
cd SpendWise

# Create virtual environment
python -m venv venv
source venv/bin/activate    # macOS/Linux
venv\Scripts\activate       # Windows

# Install dependencies
pip install -r requirements.txt

# Run the application
python app.py

# Open in browser
# http://localhost:5000
```

> **Note:** The database (`budget.db`) is created automatically on first run. No manual setup required.

---

## Keyboard Shortcuts

| Key | Action |
|---|---|
| `N` | Navigate to Add Expense |
| `D` | Navigate to Dashboard |
| `A` | Navigate to Analytics |
| `T` | Navigate to Transactions |
| `/` | Focus search input |
| `Esc` | Close lightbox / blur input |

---

## Security Features

| Feature | Implementation |
|---|---|
| SQL Injection prevention | Parameterized queries (`?` placeholders) throughout |
| XSS prevention | `escapeHtml()` on all user-supplied strings before innerHTML |
| Sort order whitelist | Only `ASC` or `DESC` can reach SQL via f-string |
| File type validation | Server-side MIME type check against whitelist |
| File size limit | Flask `MAX_CONTENT_LENGTH = 10MB` |
| Input validation | Dedicated `validators.py` with 6 validation functions |
| Proper HTTP status codes | 201 Created, 400 Bad Request, 404 Not Found, 413 Too Large, 500 Error |
| CSRF awareness | Documented as known limitation — production would use Flask-WTF |

---

## Known Limitations & Trade-offs

| Decision | Trade-off | Why acceptable |
|---|---|---|
| SQLite instead of PostgreSQL | Single-user only, no concurrent writes | Zero-config deployment, schema migrates with zero query changes |
| Photos as BLOB in SQLite | Inflates DB file size | Eliminates external file storage dependency for demo |
| `REAL` for currency amounts | IEEE 754 precision issues | Rounded to 2 decimal places on insert; acceptable for personal tracking |
| No user authentication | Single-user only | Project scope is personal finance; auth adds complexity without value for demo |
| MIME type check (not magic bytes) | Spoofable by malicious clients | Demonstrates security awareness; production would add magic byte verification |

---

## Future Scope

- [ ] User authentication with Flask-Login
- [ ] Multi-currency support with exchange rate API
- [ ] Progressive Web App (offline support)
- [ ] Bank statement CSV import with auto-categorization
- [ ] OCR receipt scanning with pytesseract
- [ ] Export to PDF/CSV
- [ ] Recurring expense automation
- [ ] Email weekly digest report

---

## Author

**Rajsv Mahendra**
- GitHub: [@rajsvmahendra](https://github.com/rajsvmahendra)
- Project: [SpendWise](https://github.com/rajsvmahendra/SpendWise)

Built as a Final Year B.Tech CSE Project · SpendWise © 2026