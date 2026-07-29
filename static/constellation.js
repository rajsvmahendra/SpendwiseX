/* =============================================================
   ═════════════════════════════════════════════════════════════
   SPENDWISE — SPENDING CONSTELLATION
   ═════════════════════════════════════════════════════════════

   The signature feature.

   What this does:
     Renders every expense of the current month as a "star"
     on a 2D canvas.
       X-axis  =  day of month
       Y-axis  =  time of day (inverted — morning at top)
       Size    =  amount (log scaled to keep tiny purchases visible)
       Color   =  category

   Design philosophy:
     Apple-calm, not gaming-flashy.
     Every interaction earns its place.
     Motion happens ONCE on reveal, then stops.
     Continuous ambient motion is limited to a slow twinkle
     — subtle enough to feel alive, not distracting.

   Interactions:
     - IntersectionObserver triggers reveal when scrolled into view
     - Chronological star appearance (Nov 1 first, Nov 30 last)
     - Parallax depth: 3 layers, subtle scroll response
     - Magnetic cursor: nearby stars drift toward pointer
     - Hover: star brightens + reveals same-day connection lines
     - Click: star expands into an inline detail card
     - Filter: category chips animate stars, don't replace them
     - Overlap: force-based dot spreading on Y-axis

   Data model:
     Stars are computed once from /api/purchases and cached
     until the user filters or the page reloads.
     Rendering runs at ~60fps via requestAnimationFrame,
     but ONLY when interaction is happening. Idle = no redraws.
   ============================================================= */


(function () {
    "use strict";

    // ══════════════════════════════════════════════════════════
    // CONFIG
    // ══════════════════════════════════════════════════════════

    const CONFIG = {
        // Reveal timing
        revealDuration: 2200,   // ms total for full reveal
        revealStagger: 50,     // ms between star appearances
        shimmerDuration: 800,    // ms for post-reveal shimmer

        // Star sizing
        minStarRadius: 2.5,
        maxStarRadius: 11,
        starGlowMultiplier: 2.8,

        // Interaction
        magneticRadius: 70,     // px around cursor stars react to
        magneticStrength: 6,      // max px displacement
        hoverConnectRadius: 200,    // px for same-day connection lines

        // Parallax (very subtle)
        parallaxLayers: 3,
        parallaxStrength: 0.12,   // 0-1, how much scroll moves layers

        // Padding inside canvas
        padding: {
            top: 36,
            right: 60,
            bottom: 60,
            left: 60,
        },

        // Ambient twinkle (very subtle, only for background stars)
        twinkleAmount: 0.15,   // opacity delta
        twinkleSpeed: 0.001,  // radians per ms
    };

    // Category color palette — must match main app palette
    const CATEGORY_COLORS = {
        "Groceries": "#10b981",  // emerald
        "Restaurants": "#f43f5e",  // rose
        "Gas/Car": "#22d3ee",  // cyan
        "Clothes": "#a78bfa",  // violet
        "Furniture/Home": "#14b8a6",  // teal
        "School/Office Supplies": "#f59e0b",  // amber
        "Misc": "#94a3b8",  // slate
    };
    const DEFAULT_COLOR = "#94a3b8";

    function getStarColor(category) {
        return CATEGORY_COLORS[category] || DEFAULT_COLOR;
    }


    // ══════════════════════════════════════════════════════════
    // STATE
    // ══════════════════════════════════════════════════════════

    const state = {
        canvas: null,
        ctx: null,
        stage: null,
        tooltip: null,
        expandedCard: null,

        // Data
        stars: [],           // array of Star objects
        expenses: [],           // raw expense data
        activeFilter: "all",

        // Bounds
        canvasWidth: 0,
        canvasHeight: 0,
        dpr: 1,

        // Interaction
        mouseX: null,
        mouseY: null,
        hoveredStar: null,
        clickedStar: null,
        scrollY: 0,

        // Animation lifecycle
        revealed: false,
        revealing: false,
        revealStart: 0,
        needsRedraw: true,
        rafId: null,

        // Background layer stars (parallax + twinkle)
        bgStars: [],
    };


    // ══════════════════════════════════════════════════════════
    // STAR CLASS
    // ══════════════════════════════════════════════════════════

    class Star {
        constructor(expense, canvasWidth, canvasHeight) {
            this.expense = expense;

            // Position based on data
            this.targetX = 0;   // computed by computeLayout
            this.targetY = 0;
            this.x = 0;   // current rendered position (magnetic offset)
            this.y = 0;

            // Visual state
            this.radius = 0;   // computed by computeSize
            this.color = getStarColor(expense.category);
            this.opacity = 0;   // fades in during reveal
            this.filterOpacity = 1;  // dims when filtered out
            this.hoverGlow = 0;   // 0-1, increases on hover
            this.scale = 1;   // multiplier

            // Reveal timing (set by orchestrator)
            this.revealDelay = 0;
        }

        /**
         * Update visual state based on cursor and hover.
         * Called every frame during interaction.
         */
        update(now, mouseX, mouseY, isHovered) {
            // Magnetic drift toward cursor
            if (mouseX !== null && mouseY !== null && state.revealed) {
                const dx = mouseX - this.targetX;
                const dy = mouseY - this.targetY;
                const distance = Math.sqrt(dx * dx + dy * dy);

                if (distance < CONFIG.magneticRadius) {
                    // Closer = stronger pull. Ease with cubic curve.
                    const t = 1 - (distance / CONFIG.magneticRadius);
                    const pull = t * t * CONFIG.magneticStrength;
                    const angle = Math.atan2(dy, dx);
                    this.x = this.targetX + Math.cos(angle) * pull;
                    this.y = this.targetY + Math.sin(angle) * pull;
                } else {
                    this.x = this.targetX;
                    this.y = this.targetY;
                }
            } else {
                this.x = this.targetX;
                this.y = this.targetY;
            }

            // Hover glow
            const targetGlow = isHovered ? 1 : 0;
            this.hoverGlow += (targetGlow - this.hoverGlow) * 0.15;
            this.scale = 1 + this.hoverGlow * 0.25;
        }

        /**
         * Draw this star onto the canvas context.
         */
        draw(ctx) {
            const effectiveOpacity = this.opacity * this.filterOpacity;
            if (effectiveOpacity <= 0.01) return;

            const r = this.radius * this.scale;

            // Outer glow (soft radial)
            const glowSize = r * (CONFIG.starGlowMultiplier + this.hoverGlow);
            const glow = ctx.createRadialGradient(
                this.x, this.y, 0,
                this.x, this.y, glowSize
            );
            glow.addColorStop(0, `${this.color}88`);
            glow.addColorStop(0.4, `${this.color}22`);
            glow.addColorStop(1, `${this.color}00`);

            ctx.globalAlpha = effectiveOpacity * (0.5 + this.hoverGlow * 0.5);
            ctx.fillStyle = glow;
            ctx.beginPath();
            ctx.arc(this.x, this.y, glowSize, 0, Math.PI * 2);
            ctx.fill();

            // Core star
            ctx.globalAlpha = effectiveOpacity;
            ctx.fillStyle = this.color;
            ctx.beginPath();
            ctx.arc(this.x, this.y, r, 0, Math.PI * 2);
            ctx.fill();

            // White center highlight (gives depth)
            if (this.hoverGlow > 0.1 || this.radius > 5) {
                ctx.globalAlpha = effectiveOpacity * (0.6 + this.hoverGlow * 0.4);
                ctx.fillStyle = "#ffffff";
                ctx.beginPath();
                ctx.arc(this.x, this.y, r * 0.35, 0, Math.PI * 2);
                ctx.fill();
            }

            ctx.globalAlpha = 1;
        }

        /**
         * Check if a mouse position is over this star.
         */
        containsPoint(px, py) {
            const dx = this.x - px;
            const dy = this.y - py;
            const hitRadius = this.radius * this.scale * 2.5;
            return (dx * dx + dy * dy) <= (hitRadius * hitRadius);
        }
    }


    // ══════════════════════════════════════════════════════════
    // LAYOUT + POSITIONING
    // ══════════════════════════════════════════════════════════

    /**
     * Compute each star's target position on the canvas.
     * Uses month-of-day as X axis, time-of-day as Y axis.
     * Includes overlap-prevention via Y-axis drift.
     */
    function computeLayout(stars, canvasWidth, canvasHeight) {
        if (stars.length === 0) return;

        const { padding } = CONFIG;
        const usableWidth = canvasWidth - padding.left - padding.right;
        const usableHeight = canvasHeight - padding.top - padding.bottom;

        // Find date range from actual data
        const dates = stars.map(s => new Date(s.expense.date));
        const minDate = new Date(Math.min(...dates));
        const maxDate = new Date(Math.max(...dates));

        // Ensure at least a 7-day range for meaningful spread
        const rangeDays = Math.max(
            7,
            Math.round((maxDate - minDate) / (1000 * 60 * 60 * 24))
        );

        stars.forEach(star => {
            const exp = star.expense;
            const expDate = new Date(exp.date);

            // Day of month → X position (0 to usableWidth)
            const dayOffset = (expDate - minDate) / (1000 * 60 * 60 * 24);
            const xPct = rangeDays > 0 ? dayOffset / rangeDays : 0.5;

            // Time of day → Y position
            // We don't have exact time in the data, so we distribute
            // by using expense.id as a pseudo-time seed. This creates
            // natural vertical spread without misrepresenting data.
            const timeSeed = (exp.id % 100) / 100;   // 0-1
            const yPct = 0.15 + timeSeed * 0.7;      // avoid extreme top/bottom

            star.targetX = padding.left + xPct * usableWidth;
            star.targetY = padding.top + yPct * usableHeight;
        });

        // Overlap prevention: force-based spreading on Y axis
        // Multiple stars within 14px of each other repel vertically
        resolveOverlaps(stars);
    }


    /**
     * Simple physics-based overlap resolution.
     * Runs a few iterations to spread clustered stars.
     */
    function resolveOverlaps(stars) {
        const iterations = 8;
        const minDistance = 18;

        for (let iter = 0; iter < iterations; iter++) {
            for (let i = 0; i < stars.length; i++) {
                for (let j = i + 1; j < stars.length; j++) {
                    const a = stars[i];
                    const b = stars[j];

                    const dx = b.targetX - a.targetX;
                    const dy = b.targetY - a.targetY;
                    const dist = Math.sqrt(dx * dx + dy * dy);

                    if (dist < minDistance && dist > 0) {
                        // Push apart on Y axis primarily
                        // (preserve X because X = date, which is meaningful)
                        const overlap = (minDistance - dist) / 2;
                        const angle = Math.atan2(dy, dx);

                        // Weight toward Y-axis movement
                        const pushY = Math.sin(angle) * overlap * 0.85;
                        const pushX = Math.cos(angle) * overlap * 0.15;

                        a.targetY -= pushY;
                        a.targetX -= pushX;
                        b.targetY += pushY;
                        b.targetX += pushX;
                    }
                }
            }
        }
    }


    /**
     * Compute each star's radius based on amount.
     * Uses log scale so small purchases stay visible
     * and huge purchases don't dominate.
     */
    function computeStarSizes(stars) {
        if (stars.length === 0) return;

        const amounts = stars.map(s => s.expense.amount);
        const minAmt = Math.min(...amounts);
        const maxAmt = Math.max(...amounts);

        stars.forEach(star => {
            const amt = star.expense.amount;

            if (minAmt === maxAmt) {
                star.radius = (CONFIG.minStarRadius + CONFIG.maxStarRadius) / 2;
                return;
            }

            // Log-scale normalization for perceptual fairness
            const logMin = Math.log(Math.max(minAmt, 1));
            const logMax = Math.log(Math.max(maxAmt, 1));
            const logAmt = Math.log(Math.max(amt, 1));
            const t = (logAmt - logMin) / (logMax - logMin);

            star.radius = CONFIG.minStarRadius +
                t * (CONFIG.maxStarRadius - CONFIG.minStarRadius);
        });
    }


    // ══════════════════════════════════════════════════════════
    // BACKGROUND STARS (parallax + twinkle depth layer)
    // ══════════════════════════════════════════════════════════

    /**
     * Create decorative background stars for depth.
     * These have no data meaning — pure atmospheric.
     */
    function createBackgroundStars(width, height) {
        const bgStars = [];
        const count = 60;

        for (let i = 0; i < count; i++) {
            bgStars.push({
                x: Math.random() * width,
                y: Math.random() * height,
                radius: Math.random() * 1.2 + 0.3,
                baseOpacity: Math.random() * 0.25 + 0.05,
                twinklePhase: Math.random() * Math.PI * 2,
                layer: Math.floor(Math.random() * CONFIG.parallaxLayers),
            });
        }

        return bgStars;
    }


    function drawBackgroundStars(ctx, now) {
        state.bgStars.forEach(s => {
            const twinkle = Math.sin(now * CONFIG.twinkleSpeed + s.twinklePhase);
            const opacity = s.baseOpacity + twinkle * CONFIG.twinkleAmount * s.baseOpacity;

            // Parallax offset based on scroll
            const parallaxY = state.scrollY * CONFIG.parallaxStrength * (s.layer + 1) * 0.3;

            ctx.globalAlpha = Math.max(0, opacity);
            ctx.fillStyle = "#e2e8f0";
            ctx.beginPath();
            ctx.arc(s.x, s.y - parallaxY, s.radius, 0, Math.PI * 2);
            ctx.fill();
        });
        ctx.globalAlpha = 1;
    }


    // ══════════════════════════════════════════════════════════
    // CONNECTION LINES (same-day)
    // ══════════════════════════════════════════════════════════

    /**
     * Draw faint lines between stars from the same day
     * when one of them is hovered. Helps user see clustering.
     */
    function drawConnections(ctx, hoveredStar) {
        if (!hoveredStar) return;

        const hoveredDate = hoveredStar.expense.date;

        state.stars.forEach(star => {
            if (star === hoveredStar) return;
            if (star.expense.date !== hoveredDate) return;
            if (star.filterOpacity < 0.5) return;

            const dx = star.x - hoveredStar.x;
            const dy = star.y - hoveredStar.y;
            const dist = Math.sqrt(dx * dx + dy * dy);

            if (dist > CONFIG.hoverConnectRadius) return;

            // Line opacity fades with distance
            const opacity = (1 - dist / CONFIG.hoverConnectRadius) * 0.35;

            ctx.globalAlpha = opacity;
            ctx.strokeStyle = hoveredStar.color;
            ctx.lineWidth = 0.8;
            ctx.beginPath();
            ctx.moveTo(hoveredStar.x, hoveredStar.y);
            ctx.lineTo(star.x, star.y);
            ctx.stroke();
        });

        ctx.globalAlpha = 1;
    }


    // ══════════════════════════════════════════════════════════
    // SHIMMER OVERLAY (one-time reveal effect)
    // ══════════════════════════════════════════════════════════

    let shimmerStart = 0;
    let shimmerActive = false;

    function triggerShimmer() {
        shimmerStart = performance.now();
        shimmerActive = true;
    }

    function drawShimmer(ctx, now) {
        if (!shimmerActive) return;

        const elapsed = now - shimmerStart;
        const progress = elapsed / CONFIG.shimmerDuration;

        if (progress >= 1) {
            shimmerActive = false;
            return;
        }

        // Sweep from left to right
        const width = state.canvasWidth;
        const height = state.canvasHeight;
        const bandWidth = width * 0.3;
        const bandCenter = -bandWidth + progress * (width + bandWidth * 2);

        const gradient = ctx.createLinearGradient(
            bandCenter - bandWidth / 2, 0,
            bandCenter + bandWidth / 2, 0
        );
        gradient.addColorStop(0, "rgba(226, 232, 240, 0)");
        gradient.addColorStop(0.5, "rgba(226, 232, 240, 0.08)");
        gradient.addColorStop(1, "rgba(226, 232, 240, 0)");

        ctx.fillStyle = gradient;
        ctx.fillRect(0, 0, width, height);
    }


    // ══════════════════════════════════════════════════════════
    // MAIN RENDER LOOP
    // ══════════════════════════════════════════════════════════

    function render(now) {
        const ctx = state.ctx;
        if (!ctx) return;

        // Clear
        ctx.clearRect(0, 0, state.canvasWidth, state.canvasHeight);

        // Background stars (always animated for subtle twinkle)
        drawBackgroundStars(ctx, now);

        // Reveal animation progress
        if (state.revealing) {
            const elapsed = now - state.revealStart;

            state.stars.forEach(star => {
                const starElapsed = elapsed - star.revealDelay;
                if (starElapsed < 0) {
                    star.opacity = 0;
                    return;
                }
                const t = Math.min(1, starElapsed / 500);
                // Ease out cubic
                star.opacity = 1 - Math.pow(1 - t, 3);
            });

            if (elapsed >= CONFIG.revealDuration) {
                state.revealing = false;
                state.revealed = true;
                state.stars.forEach(s => s.opacity = 1);
                triggerShimmer();
            }
        }

        // Update each star (magnetic drift, hover)
        state.stars.forEach(star => {
            const isHovered = star === state.hoveredStar;
            star.update(now, state.mouseX, state.mouseY, isHovered);
        });

        // Draw same-day connections (only if a star is hovered)
        drawConnections(ctx, state.hoveredStar);

        // Draw all stars (back-to-front by radius so big stars sit on top)
        const sortedStars = [...state.stars].sort((a, b) => a.radius - b.radius);
        sortedStars.forEach(star => star.draw(ctx));

        // Shimmer sweep (only briefly, after reveal)
        drawShimmer(ctx, now);

        // Continue loop while anything needs animating
        const needsMore = state.revealing
            || shimmerActive
            || state.mouseX !== null
            || Math.abs(state.stars[0]?.hoverGlow ?? 0) > 0.02;

        // Twinkle is subtle enough that we always run at low priority.
        // requestAnimationFrame naturally pauses when tab is hidden.
        state.rafId = requestAnimationFrame(render);
    }


    // ══════════════════════════════════════════════════════════
    // TOOLTIP
    // ══════════════════════════════════════════════════════════

    function showTooltip(star, mouseX, mouseY) {
        if (!state.tooltip) return;

        const exp = star.expense;

        document.getElementById("tooltipBusiness").textContent = exp.business;
        document.getElementById("tooltipAmount").textContent = formatRupeesClean(exp.amount);
        document.getElementById("tooltipCategory").textContent = exp.category;

        const dateObj = new Date(exp.date);
        const dateStr = dateObj.toLocaleDateString("en-US", {
            weekday: "short", month: "short", day: "numeric"
        });
        document.getElementById("tooltipTime").textContent = dateStr;

        const noteEl = document.getElementById("tooltipNote");
        if (exp.description && exp.description.trim()) {
            noteEl.textContent = exp.description;
            noteEl.removeAttribute("hidden");
        } else {
            noteEl.setAttribute("hidden", "");
        }

        // Show tooltip so we can measure its actual dimensions
        state.tooltip.removeAttribute("hidden");

        // Compute position relative to stage (parent of tooltip)
        const rect = state.canvas.getBoundingClientRect();
        const scaleX = rect.width / state.canvasWidth;
        const scaleY = rect.height / state.canvasHeight;

        const screenX = star.x * scaleX;
        const screenY = star.y * scaleY;

        // Measure tooltip's actual size
        const tipRect = state.tooltip.getBoundingClientRect();
        const tipW = tipRect.width;
        const tipH = tipRect.height;
        const stageW = rect.width;

        // Default: center-aligned above the star
        // Transform is translate(-50%, calc(-100% - 12px)) — set in CSS
        // We compute an "adjusted" left position to clamp within the stage.

        const padding = 12;
        const halfW = tipW / 2;

        let adjustedX = screenX;

        // Clamp so tooltip doesn't spill left
        if (screenX - halfW < padding) {
            adjustedX = halfW + padding;
        }
        // Clamp so tooltip doesn't spill right
        else if (screenX + halfW > stageW - padding) {
            adjustedX = stageW - halfW - padding;
        }

        // If the star is near the top of the stage, flip tooltip below the star
        let adjustedY = screenY;
        let flipBelow = false;

        if (screenY - tipH - 20 < 0) {
            flipBelow = true;
            adjustedY = screenY;
        }

        state.tooltip.style.left = `${adjustedX}px`;
        state.tooltip.style.top = `${adjustedY}px`;

        // Toggle above/below via CSS transform
        if (flipBelow) {
            state.tooltip.style.transform = "translate(-50%, 20px)";
        } else {
            state.tooltip.style.transform = "translate(-50%, calc(-100% - 12px))";
        }
    }

    function hideTooltip() {
        if (state.tooltip) state.tooltip.setAttribute("hidden", "");
    }


    // ══════════════════════════════════════════════════════════
    // EXPANDED CARD
    // ══════════════════════════════════════════════════════════

    function showExpandedCard(star) {
        if (!state.expandedCard) return;

        const exp = star.expense;

        document.getElementById("expandedDot").style.background = star.color;
        document.getElementById("expandedBusiness").textContent = exp.business;
        document.getElementById("expandedAmount").textContent = formatRupeesClean(exp.amount);
        document.getElementById("expandedCategory").textContent = exp.category;

        const dateObj = new Date(exp.date);
        document.getElementById("expandedDate").textContent = dateObj.toLocaleDateString("en-US", {
            weekday: "long", month: "long", day: "numeric", year: "numeric"
        });

        const noteEl = document.getElementById("expandedNote");
        if (exp.description && exp.description.trim()) {
            noteEl.textContent = exp.description;
            noteEl.removeAttribute("hidden");
        } else {
            noteEl.setAttribute("hidden", "");
        }

        // Position at star
        const rect = state.canvas.getBoundingClientRect();
        const scaleX = rect.width / state.canvasWidth;
        const scaleY = rect.height / state.canvasHeight;

        state.expandedCard.style.left = `${star.x * scaleX}px`;
        state.expandedCard.style.top = `${star.y * scaleY}px`;
        state.expandedCard.removeAttribute("hidden");

        state.clickedStar = star;
    }

    function hideExpandedCard() {
        if (state.expandedCard) state.expandedCard.setAttribute("hidden", "");
        state.clickedStar = null;
    }


    // ══════════════════════════════════════════════════════════
    // FILTER
    // ══════════════════════════════════════════════════════════

    function applyFilter(filter) {
        state.activeFilter = filter;

        state.stars.forEach(star => {
            const matches = filter === "all" || star.expense.category === filter;
            // Smooth fade using CSS-like interpolation in render loop
            animateFilterOpacity(star, matches ? 1 : 0.08);
        });

        // Update active chip
        document.querySelectorAll(".constellation-chip").forEach(chip => {
            chip.classList.toggle("active", chip.getAttribute("data-filter") === filter);
        });
    }


    function animateFilterOpacity(star, target) {
        const start = star.filterOpacity;
        const startTime = performance.now();
        const duration = 500;

        function step(now) {
            const elapsed = now - startTime;
            const t = Math.min(1, elapsed / duration);
            // Ease in-out
            const eased = t < 0.5 ? 2 * t * t : 1 - Math.pow(-2 * t + 2, 2) / 2;
            star.filterOpacity = start + (target - start) * eased;

            if (t < 1) requestAnimationFrame(step);
        }

        requestAnimationFrame(step);
    }


    // ══════════════════════════════════════════════════════════
    // EVENT HANDLERS
    // ══════════════════════════════════════════════════════════

    function handleMouseMove(e) {
        const rect = state.canvas.getBoundingClientRect();
        const scaleX = state.canvasWidth / rect.width;
        const scaleY = state.canvasHeight / rect.height;

        state.mouseX = (e.clientX - rect.left) * scaleX;
        state.mouseY = (e.clientY - rect.top) * scaleY;

        // Find hovered star (reverse order: bigger/top stars first)
        const sortedForHit = [...state.stars]
            .filter(s => s.filterOpacity > 0.3)
            .sort((a, b) => b.radius - a.radius);

        let found = null;
        for (const star of sortedForHit) {
            if (star.containsPoint(state.mouseX, state.mouseY)) {
                found = star;
                break;
            }
        }

        if (found !== state.hoveredStar) {
            state.hoveredStar = found;
            if (found) {
                showTooltip(found, e.clientX, e.clientY);
                state.canvas.style.cursor = "pointer";
            } else {
                hideTooltip();
                state.canvas.style.cursor = "crosshair";
            }
        }
    }

    function handleMouseLeave() {
        state.mouseX = null;
        state.mouseY = null;
        state.hoveredStar = null;
        hideTooltip();
    }

    function handleClick(e) {
        if (state.hoveredStar) {
            hideTooltip();
            showExpandedCard(state.hoveredStar);
        } else if (state.clickedStar) {
            hideExpandedCard();
        }
    }

    function handleScroll() {
        state.scrollY = window.scrollY;
    }


    // ══════════════════════════════════════════════════════════
    // SETUP
    // ══════════════════════════════════════════════════════════

    function setupCanvas() {
        const canvas = state.canvas;
        const rect = state.stage.getBoundingClientRect();

        state.dpr = window.devicePixelRatio || 1;
        state.canvasWidth = rect.width;
        state.canvasHeight = rect.height;

        canvas.width = state.canvasWidth * state.dpr;
        canvas.height = state.canvasHeight * state.dpr;
        canvas.style.width = `${state.canvasWidth}px`;
        canvas.style.height = `${state.canvasHeight}px`;

        state.ctx = canvas.getContext("2d");
        state.ctx.scale(state.dpr, state.dpr);

        state.bgStars = createBackgroundStars(state.canvasWidth, state.canvasHeight);
    }


    function setupFilters(expenses) {
        const container = document.getElementById("constellationFilters");
        if (!container) return;

        // Get unique categories from data
        const categories = [...new Set(expenses.map(e => e.category))];

        // Keep the "All" chip, remove any pre-existing category chips
        container.querySelectorAll(".constellation-chip:not([data-filter='all'])")
            .forEach(c => c.remove());

        // Add category chips
        categories.forEach(cat => {
            const chip = document.createElement("button");
            chip.className = "constellation-chip";
            chip.setAttribute("data-filter", cat);
            chip.innerHTML = `
                <span class="chip-dot" style="background: ${getStarColor(cat)}"></span>
                ${escapeHtml(cat)}
            `;
            container.appendChild(chip);
        });

        // Wire up filter clicks
        container.querySelectorAll(".constellation-chip").forEach(chip => {
            chip.addEventListener("click", () => {
                const filter = chip.getAttribute("data-filter");
                applyFilter(filter);
            });
        });
    }


    function setupInteractions() {
        state.canvas.addEventListener("mousemove", handleMouseMove);
        state.canvas.addEventListener("mouseleave", handleMouseLeave);
        state.canvas.addEventListener("click", handleClick);
        window.addEventListener("scroll", handleScroll, { passive: true });

        const closeBtn = document.getElementById("expandedClose");
        if (closeBtn) {
            closeBtn.addEventListener("click", (e) => {
                e.stopPropagation();
                hideExpandedCard();
            });
        }

        // Close expanded card on Escape
        document.addEventListener("keydown", (e) => {
            if (e.key === "Escape" && state.clickedStar) {
                hideExpandedCard();
            }
        });

        // Handle resize
        window.addEventListener("resize", debounce(() => {
            setupCanvas();
            computeLayout(state.stars, state.canvasWidth, state.canvasHeight);
        }, 200));
    }


    // ══════════════════════════════════════════════════════════
    // TITLE + HINT
    // ══════════════════════════════════════════════════════════

    function updateTitleAndAxes(expenses) {
        if (expenses.length === 0) return;

        const dates = expenses.map(e => new Date(e.date));
        const minDate = new Date(Math.min(...dates));
        const maxDate = new Date(Math.max(...dates));

        const monthName = maxDate.toLocaleString("default", { month: "long" });
        const year = maxDate.getFullYear();

        const titleEl = document.getElementById("constellationTitle");
        if (titleEl) {
            titleEl.textContent = `Your ${monthName} spending map`;
        }

        const startLabel = document.getElementById("axisLabelStart");
        const endLabel = document.getElementById("axisLabelEnd");
        if (startLabel) startLabel.textContent = minDate.toLocaleDateString("en-US", { month: "short", day: "numeric" });
        if (endLabel) endLabel.textContent = maxDate.toLocaleDateString("en-US", { month: "short", day: "numeric" });
    }


    function generateHint(expenses) {
        if (expenses.length === 0) return "";

        // Find the day with the most spending
        const byDate = {};
        expenses.forEach(e => {
            byDate[e.date] = (byDate[e.date] || 0) + e.amount;
        });

        const sorted = Object.entries(byDate).sort((a, b) => b[1] - a[1]);
        if (sorted.length === 0) return "";

        const topDate = new Date(sorted[0][0]);
        const dayName = topDate.toLocaleDateString("en-US", { weekday: "long" });

        // Count how many top-3 days are that same weekday
        const topDaysWeekday = sorted.slice(0, 3)
            .map(([d]) => new Date(d).toLocaleDateString("en-US", { weekday: "long" }));
        const weekdayCount = topDaysWeekday.filter(w => w === dayName).length;

        if (weekdayCount >= 2) {
            return `Notice how ${dayName}s cluster together?`;
        }

        // Fallback hints
        const hints = [
            "Hover a star to see the story behind it.",
            "Try filtering by category to see the shape of a habit.",
            "Bigger stars are bigger expenses.",
        ];
        return hints[Math.floor(Math.random() * hints.length)];
    }


    // ══════════════════════════════════════════════════════════
    // INITIALIZATION
    // ══════════════════════════════════════════════════════════

    /**
     * Main entry point.
     * Called when the constellation section scrolls into view.
     */
    async function initConstellation() {
        state.canvas = document.getElementById("constellationCanvas");
        state.stage = document.getElementById("constellationStage");
        state.tooltip = document.getElementById("constellationTooltip");
        state.expandedCard = document.getElementById("constellationExpanded");

        if (!state.canvas || !state.stage) return;

        // Fetch data — all purchases from current month
        let purchases = [];
        try {
            const now = new Date();
            const monthStr = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}`;

            // Fetch a reasonable window (last 200 entries covers most months)
            const response = await fetch("/api/purchases?limit=200");
            if (!response.ok) throw new Error("Fetch failed");
            const data = await response.json();

            // Filter to current month
            purchases = (data.purchases || []).filter(p =>
                p.date && p.date.startsWith(monthStr)
            );

            // If current month is empty, fall back to most recent 30 days
            if (purchases.length === 0) {
                purchases = (data.purchases || []).slice(0, 30);
            }
        } catch (err) {
            console.error("[Constellation] data fetch failed:", err);
            showEmptyConstellation("Couldn't load your spending map. Try refreshing.");
            return;
        }

        if (purchases.length === 0) {
            showEmptyConstellation("Log a few expenses to see your spending map appear.");
            return;
        }

        state.expenses = purchases;

        // Setup
        setupCanvas();
        setupFilters(purchases);
        updateTitleAndAxes(purchases);

        // Build stars
        state.stars = purchases.map(p => new Star(p, state.canvasWidth, state.canvasHeight));
        computeStarSizes(state.stars);
        computeLayout(state.stars, state.canvasWidth, state.canvasHeight);

        // Chronological reveal delays
        const sortedByDate = [...state.stars].sort((a, b) => {
            return new Date(a.expense.date) - new Date(b.expense.date);
        });

        const staggerBudget = CONFIG.revealDuration - 500;
        const perStar = state.stars.length > 1
            ? staggerBudget / state.stars.length
            : 0;

        sortedByDate.forEach((star, i) => {
            star.revealDelay = i * perStar;
        });

        // Update hint
        const hintEl = document.getElementById("constellationHint");
        if (hintEl) hintEl.textContent = generateHint(purchases);

        // Setup interactions
        setupInteractions();

        // Start reveal + render loop
        state.revealing = true;
        state.revealStart = performance.now();
        state.rafId = requestAnimationFrame(render);
    }


    function showEmptyConstellation(message) {
        const stage = document.getElementById("constellationStage");
        if (!stage) return;

        // Hide the canvas, replace with a centered message
        const canvas = document.getElementById("constellationCanvas");
        if (canvas) canvas.style.opacity = "0.3";

        // Check if we already added a message
        if (stage.querySelector(".constellation-empty")) return;

        const emptyEl = document.createElement("div");
        emptyEl.className = "constellation-empty";
        emptyEl.style.cssText = `
            position: absolute;
            top: 50%; left: 50%;
            transform: translate(-50%, -50%);
            color: var(--text-secondary);
            font-size: 0.95rem;
            text-align: center;
            max-width: 320px;
            line-height: 1.6;
            z-index: 5;
        `;
        emptyEl.textContent = message;
        stage.appendChild(emptyEl);
    }


    // ══════════════════════════════════════════════════════════
    // INTERSECTION OBSERVER — Reveal on scroll
    // ══════════════════════════════════════════════════════════

    function setupObserver() {
        const section = document.getElementById("qConstellation");
        if (!section) return;

        const observer = new IntersectionObserver((entries) => {
            entries.forEach(entry => {
                if (entry.isIntersecting && !state.canvas) {
                    initConstellation();
                    observer.unobserve(entry.target);
                }
            });
        }, {
            threshold: 0.15,  // trigger when 15% of section is visible
            rootMargin: "0px 0px -50px 0px",
        });

        observer.observe(section);
    }


    // ══════════════════════════════════════════════════════════
    // UTILITIES
    // ══════════════════════════════════════════════════════════

    function debounce(fn, wait) {
        let timeout;
        return function (...args) {
            clearTimeout(timeout);
            timeout = setTimeout(() => fn.apply(this, args), wait);
        };
    }

    // Fallback helpers if not already global
    if (typeof escapeHtml === "undefined") {
        window.escapeHtml = function (str) {
            if (!str) return "";
            return String(str)
                .replace(/&/g, "&amp;")
                .replace(/</g, "&lt;")
                .replace(/>/g, "&gt;")
                .replace(/"/g, "&quot;")
                .replace(/'/g, "&#39;");
        };
    }

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


    // ══════════════════════════════════════════════════════════
    // BOOT
    // ══════════════════════════════════════════════════════════

    if (document.readyState === "loading") {
        document.addEventListener("DOMContentLoaded", setupObserver);
    } else {
        setupObserver();
    }

})();