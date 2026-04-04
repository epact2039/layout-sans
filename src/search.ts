// LayoutSans — search.ts (v0.2)
//
// In-memory full-text search over the layout tree, with animated
// match navigation and an optional built-in search panel UI.
//
// Architecture constraints (PRD §9):
//   • Zero DOM reads in the search hot path. All geometry comes from BoxRecord
//     values (world-space px) and TextLineData (pre-computed grapheme widths).
//   • charRangeToRect() (paint.ts) converts character offsets to pixel rects
//     without calling measureText() — all geometry was paid for at prepare().
//   • The panel UI is ~60 lines of vanilla DOM (zero frameworks, zero deps).
//   • Ctrl+F is intercepted in the document keydown capture phase so it fires
//     before the browser's native find-in-page dialog opens.
//   • Animated scroll runs its own requestAnimationFrame loop, independent
//     of the caller's paint loop. The caller is notified via onScrollTo() and
//     is responsible for updating their scrollY state and repainting.
//   • LayoutSearch does NOT own scrollY — it reads the current position via
//     getScrollY() and writes new positions via onScrollTo(). This keeps it
//     compatible with any scroll architecture the caller uses.
//
// Integration (caller's RAF loop):
//   ```ts
//   // After painting background + content:
//   if (search.isOpen && search.matches.length > 0) {
//     paintSearchHighlights(ctx, search.matches, search.activeIndex, scrollY, viewportH)
//   }
//   ```

import type { BoxRecord, TextLineData } from './types.js'
import type { LayoutEngine }            from './engine.js'
import { charRangeToRect, SearchMatchRect } from './paint.js'

// Re-export so callers can type-annotate without a second import path.
export type { SearchMatchRect }

// ─── Public types ─────────────────────────────────────────────────────────────

/** Per-query options for `LayoutSearch.search()`. */
export interface SearchOptions {
  /** Match regardless of letter case. Default: false (case-insensitive). */
  caseSensitive?: boolean
  /**
   * Only match whole words — the characters immediately surrounding the
   * match (if present) must be non-word characters (\W equivalent).
   * Default: false.
   */
  wholeWord?: boolean
}

/**
 * Constructor options for `LayoutSearch`.
 * All scroll/viewport queries are callbacks so `LayoutSearch` never reads
 * the DOM itself (except when manipulating the panel it owns).
 */
export interface SearchConstructorOptions {
  /**
   * Called on every animation frame during a scroll-to-match animation.
   * The caller must update their `scrollY` state and schedule a repaint.
   *
   * Also called once synchronously by `goToMatch()` to jump to the target
   * position when the animation duration is 0.
   */
  onScrollTo: (y: number) => void

  /**
   * Returns the current vertical scroll offset in world-space pixels.
   * Called once at the start of each scroll animation to determine the
   * starting position. Not called in any per-frame hot path.
   */
  getScrollY: () => number

  /**
   * Returns the canvas viewport height in CSS pixels.
   * Used to center the active match vertically on screen.
   * Called once per goToMatch().
   */
  getViewportH: () => number

  /**
   * Opt out of the built-in search panel HTML (default: true = show panel).
   * Set to false if you supply your own search UI and call
   * `search.search(q)` / `search.goToMatch(n)` directly.
   */
  searchUI?: boolean

  /**
   * Override the inactive-match highlight color passed to paintSearchHighlights().
   * Exposed here so the caller can read it and pass it to their paint call.
   * Default: 'rgba(255, 220, 0, 0.45)'.
   */
  inactiveMatchColor?: string

  /**
   * Override the active-match highlight color.
   * Default: 'rgba(255, 165, 0, 0.75)'.
   */
  activeMatchColor?: string

  /**
   * Optional: called whenever the search panel opens or closes.
   * Useful for external UI that needs to react (e.g. hiding other overlays).
   */
  onOpenChange?: (open: boolean) => void

  /**
   * Optional: called after a search() completes with the match count.
   * Useful for external UI that displays match counts.
   */
  onMatchesChange?: (count: number) => void

  /**
   * Optional: called after the active match index changes.
   * `index` is 0-based; `total` is matches.length.
   */
  onActiveChange?: (index: number, total: number) => void

  /**
   * Trigger a canvas repaint outside the animation loop.
   * Called when the panel closes (to erase highlights) and when
   * search results change with the panel open.
   */
  requestRepaint?: () => void

  /**
   * Duration of the scroll-to-match animation in milliseconds.
   * Set to 0 to jump instantly. Default: 200.
   */
  scrollDuration?: number
}

// ─── LayoutSearch ─────────────────────────────────────────────────────────────

export class LayoutSearch {
  // ── Resolved options (with defaults) ─────────────────────────────────────

  private readonly showUI:          boolean
  private readonly onScrollTo:      (y: number) => void
  private readonly getScrollY:      () => number
  private readonly getViewportH:    () => number
  private readonly onOpenChange:    ((open: boolean) => void)     | undefined
  private readonly onMatchesChange: ((count: number) => void)     | undefined
  private readonly onActiveChange:  ((index: number, total: number) => void) | undefined
  private readonly requestRepaint:  (() => void)                  | undefined
  private readonly scrollDuration:  number

  readonly inactiveMatchColor: string
  readonly activeMatchColor:   string

  // ── Search state ──────────────────────────────────────────────────────────

  /** All matches from the most recent search(), in document order. */
  private _matches: SearchMatchRect[] = []
  /** Index of the match that will be highlighted as "active". */
  private _activeIndex = 0
  /** True when the search panel is visible (or Ctrl+F was pressed). */
  private _isOpen = false
  /** Most recent query string. Re-run on rebuild() to stay current. */
  private _lastQuery = ''
  /** Most recent SearchOptions. Re-run on rebuild(). */
  private _lastOptions: SearchOptions = {}

  // ── Scroll animation state ────────────────────────────────────────────────

  private animFrame: number | null = null
  private animStartTime = 0
  private animStartY    = 0
  private animTargetY   = 0
  private animDuration  = 200

  // ── Panel DOM ─────────────────────────────────────────────────────────────

  private panel:      HTMLDivElement    | null = null
  private input:      HTMLInputElement  | null = null
  private countLabel: HTMLSpanElement   | null = null

  // ── Keyboard cleanup ──────────────────────────────────────────────────────

  private readonly keydownHandler: (e: KeyboardEvent) => void
  private readonly cleanup: Array<() => void> = []

  // ── Constructor ───────────────────────────────────────────────────────────

  constructor(
    private readonly engine: LayoutEngine,
    /** The canvas's parent element — panel is injected here. */
    private readonly container: HTMLElement,
    opts: SearchConstructorOptions,
  ) {
    this.showUI          = opts.searchUI !== false
    this.onScrollTo      = opts.onScrollTo
    this.getScrollY      = opts.getScrollY
    this.getViewportH    = opts.getViewportH
    this.onOpenChange    = opts.onOpenChange
    this.onMatchesChange = opts.onMatchesChange
    this.onActiveChange  = opts.onActiveChange
    this.requestRepaint  = opts.requestRepaint
    this.scrollDuration  = opts.scrollDuration ?? 200
    this.inactiveMatchColor = opts.inactiveMatchColor ?? 'rgba(255, 220, 0, 0.45)'
    this.activeMatchColor   = opts.activeMatchColor   ?? 'rgba(255, 165, 0, 0.75)'

    this.keydownHandler = this.buildKeydownHandler()
    document.addEventListener('keydown', this.keydownHandler, { capture: true })
    this.cleanup.push(() =>
      document.removeEventListener('keydown', this.keydownHandler, { capture: true }),
    )

    if (this.showUI) this.buildPanel()
  }

  // ── Public read-only state (read by caller's RAF loop) ─────────────────────

  /** Matches from the most recent `search()` call. */
  get matches(): SearchMatchRect[] { return this._matches }

  /** 0-based index of the currently highlighted match. */
  get activeIndex(): number { return this._activeIndex }

  /** True when the search panel is open (highlights should be painted). */
  get isOpen(): boolean { return this._isOpen }

  // ── Public API ─────────────────────────────────────────────────────────────

  /**
   * Open the search panel (or focus its input if already open).
   * This is also triggered by Ctrl/Cmd+F.
   */
  openPanel(): void {
    if (this._isOpen && this.panel) {
      this.input?.focus()
      this.input?.select()
      return
    }

    this._isOpen = true
    if (this.panel) {
      this.panel.style.display = 'flex'
      this.input?.focus()
      this.input?.select()
    }
    this.onOpenChange?.(true)

    // If there was a previous query, re-run it immediately.
    if (this._lastQuery) {
      this.runSearch(this._lastQuery, this._lastOptions)
    }
  }

  /** Close the search panel and clear highlights. */
  closePanel(): void {
    if (!this._isOpen) return
    this._isOpen = false
    if (this.panel) this.panel.style.display = 'none'
    this._matches     = []
    this._activeIndex = 0
    this.cancelAnimation()
    this.onOpenChange?.(false)
    this.requestRepaint?.()
  }

  /**
   * Execute a full-text search across all text/heading nodes in document order.
   *
   * Walks `engine.getAllRecords()` and reads `record.textContent` for each
   * text/heading node. Character-to-pixel conversion uses `charRangeToRect()`
   * from paint.ts — zero `measureText()` calls.
   *
   * @param query    The string to search for.
   * @param options  Case-sensitivity and whole-word options.
   * @returns        All matches with their pixel rects, in document order.
   */
  search(query: string, options: SearchOptions = {}): SearchMatchRect[] {
    this._lastQuery   = query
    this._lastOptions = options
    this.runSearch(query, options)
    return this._matches
  }

  /**
   * Navigate to match at `index` (0-based), scrolling the canvas so the
   * match is vertically centered in the viewport.
   */
  goToMatch(index: number): void {
    if (this._matches.length === 0) return
    // Wrap around.
    const n = this._matches.length
    this._activeIndex = ((index % n) + n) % n

    const match = this._matches[this._activeIndex]!
    const viewH  = this.getViewportH()
    const target = Math.max(0, match.rect.y - viewH / 2 + match.rect.height / 2)

    this.startScrollAnimation(target)
    this.updateCountLabel()
    this.onActiveChange?.(this._activeIndex, n)
  }

  /** Advance to the next match, wrapping around at the end. */
  nextMatch(): void {
    this.goToMatch(this._activeIndex + 1)
  }

  /** Move to the previous match, wrapping around at the start. */
  prevMatch(): void {
    this.goToMatch(this._activeIndex - 1)
  }

  /**
   * Rebuild search results after engine.compute() is called.
   * Re-runs the last query so highlights stay current after a layout change.
   * Safe to call with an empty last query (becomes a no-op).
   */
  rebuild(): void {
    if (!this._isOpen || !this._lastQuery) {
      this._matches     = []
      this._activeIndex = 0
      return
    }
    this.runSearch(this._lastQuery, this._lastOptions)
    // Keep the active index in range.
    if (this._activeIndex >= this._matches.length) {
      this._activeIndex = Math.max(0, this._matches.length - 1)
    }
  }

  /** Detach all event listeners and remove the panel from the DOM. */
  destroy(): void {
    this.cancelAnimation()
    for (const fn of this.cleanup) fn()
    this.cleanup.length = 0
    this.panel?.remove()
    this.panel = null
  }

  // ── Core search algorithm ──────────────────────────────────────────────────

  /**
   * Execute the search and store results in `_matches`.
   *
   * PRD §9.2 algorithm (exact match via indexOf loop):
   *   1. Walk records in tree order. For each record with textContent, do
   *      a case-adjusted indexOf loop to find all occurrences.
   *   2. For each occurrence call charRangeToRect() to get the pixel rect.
   *   3. Collect into SearchMatchRect[].
   *
   * Time complexity: O(total_chars × query_len) in the worst case (degenerate
   * overlapping patterns). For typical queries O(total_chars) — indexOf is
   * implemented in native C in all JS engines.
   */
  private runSearch(query: string, options: SearchOptions): void {
    if (!query) {
      this._matches     = []
      this._activeIndex = 0
      this.updateCountLabel()
      this.onMatchesChange?.(0)
      this.requestRepaint?.()
      return
    }

    const { caseSensitive = false, wholeWord = false } = options
    const q        = caseSensitive ? query : query.toLowerCase()
    const qLen     = q.length
    const records  = this.engine.getAllRecords()
    const results: SearchMatchRect[] = []

    for (let ri = 0; ri < records.length; ri++) {
      const record = records[ri]!

      // Only text and heading nodes carry textContent.
      if (record.nodeType !== 'text' && record.nodeType !== 'heading') continue
      if (!record.textContent) continue

      const tld = this.engine.textLineMap.get(record.nodeId)
      if (!tld) continue

      const raw  = record.textContent
      const text = caseSensitive ? raw : raw.toLowerCase()
      const len  = text.length

      let idx = 0
      while (idx <= len - qLen) {
        const found = text.indexOf(q, idx)
        if (found === -1) break

        // Whole-word check.
        if (wholeWord) {
          const before = found > 0        ? raw[found - 1]!       : null
          const after  = found + qLen < len ? raw[found + qLen]!  : null
          if ((before !== null && isWordChar(before)) ||
              (after  !== null && isWordChar(after))) {
            idx = found + 1
            continue
          }
        }

        // Map character offsets to a pixel rect.
        const rect = charRangeToRect(
          record.nodeId,
          found,
          found + qLen,
          tld,
          record,
        )

        if (rect) {
          results.push({
            nodeId:    record.nodeId,
            charStart: found,
            charEnd:   found + qLen,
            rect,
          })
        }

        // Advance past this match. We use `found + 1` (not `found + qLen`) to
        // catch overlapping matches — e.g. searching "aa" in "aaa" finds 2 matches.
        idx = found + 1
      }
    }

    // Preserve the active match index if it still points at a valid match.
    // If the result set shrank, clamp to the last result.
    if (this._activeIndex >= results.length) {
      this._activeIndex = Math.max(0, results.length - 1)
    }

    this._matches = results
    this.updateCountLabel()
    this.onMatchesChange?.(results.length)
    this.onActiveChange?.(this._activeIndex, results.length)
    this.requestRepaint?.()
  }

  // ── Scroll animation ───────────────────────────────────────────────────────

  /**
   * Animate the canvas scroll position to `targetY` using a cubic ease-out
   * curve over `this.scrollDuration` milliseconds.
   *
   * The animation runs in its own `requestAnimationFrame` loop. Each frame
   * calls `this.onScrollTo(y)` with the interpolated position — the caller
   * updates their scroll state and schedules a repaint for the next frame.
   *
   * If duration is 0, jumps immediately (one synchronous onScrollTo call).
   */
  private startScrollAnimation(targetY: number): void {
    this.cancelAnimation()

    const startY = this.getScrollY()

    // No animation needed if already at target.
    if (Math.abs(targetY - startY) < 0.5) {
      this.onScrollTo(targetY)
      return
    }

    // Instant jump when duration is 0.
    if (this.scrollDuration === 0) {
      this.onScrollTo(targetY)
      return
    }

    this.animStartY    = startY
    this.animTargetY   = targetY
    this.animDuration  = this.scrollDuration
    this.animStartTime = performance.now()

    const step = (now: number): void => {
      const elapsed = now - this.animStartTime
      const t       = Math.min(elapsed / this.animDuration, 1)
      // Cubic ease-out: t' = 1 - (1-t)³
      const eased   = 1 - (1 - t) ** 3
      const y       = this.animStartY + (this.animTargetY - this.animStartY) * eased

      this.onScrollTo(y)

      if (t < 1) {
        this.animFrame = requestAnimationFrame(step)
      } else {
        // Snap to exact target to avoid floating-point residual drift.
        this.onScrollTo(this.animTargetY)
        this.animFrame = null
      }
    }

    this.animFrame = requestAnimationFrame(step)
  }

  private cancelAnimation(): void {
    if (this.animFrame !== null) {
      cancelAnimationFrame(this.animFrame)
      this.animFrame = null
    }
  }

  // ── Built-in panel UI ──────────────────────────────────────────────────────

  /**
   * Build and inject the built-in search panel.
   *
   * The panel is ~60 lines of vanilla DOM. It is injected into `this.container`
   * (the canvas's parent element) with `position: absolute; top: 8px; right: 8px`.
   * The container must have `position: relative/absolute/fixed` — this is already
   * guaranteed by InteractionBridge.mountProxyCaret().
   *
   * Structure:
   *   <div.ls-search-panel>
   *     <input.ls-search-input placeholder="Find…" />
   *     <span.ls-search-count>0 of 0</span>
   *     <button.ls-search-prev aria-label="Previous match">‹</button>
   *     <button.ls-search-next aria-label="Next match">›</button>
   *     <button.ls-search-close aria-label="Close search">×</button>
   *   </div>
   */
  private buildPanel(): void {
    this.injectPanelStyles()

    const panel = document.createElement('div')
    panel.className     = 'ls-search-panel'
    panel.style.display = 'none'   // hidden until Ctrl+F
    panel.setAttribute('role', 'search')
    panel.setAttribute('aria-label', 'Find in content')

    // ── Input ───────────────────────────────────────────────────────────────

    const input = document.createElement('input')
    input.type        = 'text'
    input.className   = 'ls-search-input'
    input.placeholder = 'Find…'
    input.setAttribute('aria-label', 'Search query')
    input.setAttribute('autocomplete', 'off')
    input.setAttribute('autocorrect',  'off')
    input.setAttribute('spellcheck',   'false')

    // Debounce: search runs 50ms after the user stops typing.
    let debounceTimer: ReturnType<typeof setTimeout> | null = null
    input.addEventListener('input', () => {
      if (debounceTimer !== null) clearTimeout(debounceTimer)
      debounceTimer = setTimeout(() => {
        debounceTimer = null
        const q = input.value.trim()
        if (!q) {
          this._matches     = []
          this._activeIndex = 0
          this.updateCountLabel()
          this.requestRepaint?.()
          return
        }
        this.runSearch(q, this._lastOptions)
        if (this._matches.length > 0) this.goToMatch(0)
      }, 50)
    })

    // Enter → next match; Shift+Enter → prev match.
    input.addEventListener('keydown', (e: KeyboardEvent) => {
      if (e.key === 'Enter') {
        e.preventDefault()
        e.shiftKey ? this.prevMatch() : this.nextMatch()
      } else if (e.key === 'Escape') {
        e.preventDefault()
        this.closePanel()
      }
    })

    // ── Count label ─────────────────────────────────────────────────────────

    const countLabel = document.createElement('span')
    countLabel.className   = 'ls-search-count'
    countLabel.textContent = ''
    countLabel.setAttribute('aria-live', 'polite')
    countLabel.setAttribute('aria-atomic', 'true')

    // ── Prev button ─────────────────────────────────────────────────────────

    const prevBtn = document.createElement('button')
    prevBtn.className = 'ls-search-btn ls-search-prev'
    prevBtn.textContent = '‹'
    prevBtn.setAttribute('aria-label', 'Previous match')
    prevBtn.addEventListener('click', () => this.prevMatch())

    // ── Next button ─────────────────────────────────────────────────────────

    const nextBtn = document.createElement('button')
    nextBtn.className = 'ls-search-btn ls-search-next'
    nextBtn.textContent = '›'
    nextBtn.setAttribute('aria-label', 'Next match')
    nextBtn.addEventListener('click', () => this.nextMatch())

    // ── Close button ─────────────────────────────────────────────────────────

    const closeBtn = document.createElement('button')
    closeBtn.className = 'ls-search-btn ls-search-close'
    closeBtn.textContent = '×'
    closeBtn.setAttribute('aria-label', 'Close search')
    closeBtn.addEventListener('click', () => this.closePanel())

    // ── Assemble ─────────────────────────────────────────────────────────────

    panel.appendChild(input)
    panel.appendChild(countLabel)
    panel.appendChild(prevBtn)
    panel.appendChild(nextBtn)
    panel.appendChild(closeBtn)
    this.container.appendChild(panel)

    this.panel      = panel
    this.input      = input
    this.countLabel = countLabel
  }

  /** Inject the search panel CSS once into the container's nearest shadow root
   *  or the document <head>. Uses a data attribute guard to avoid double-injection. */
  private injectPanelStyles(): void {
    const existing = document.querySelector('style[data-ls-search]')
    if (existing) return

    const style = document.createElement('style')
    style.setAttribute('data-ls-search', '')
    style.textContent = SEARCH_PANEL_CSS
    document.head.appendChild(style)
  }

  /** Update the "N of M" count label and ARIA live region. */
  private updateCountLabel(): void {
    if (!this.countLabel) return
    const total = this._matches.length
    if (!this._lastQuery || total === 0) {
      // Show "No results" only when there was a real query with no hits.
      this.countLabel.textContent = this._lastQuery && total === 0 ? 'No results' : ''
    } else {
      // 1-based display for human readability.
      this.countLabel.textContent = `${this._activeIndex + 1} of ${total}`
    }
  }

  // ── Keyboard shortcuts ─────────────────────────────────────────────────────

  /**
   * Build the document-level keydown handler for Ctrl/Cmd+F, Ctrl/Cmd+G,
   * Ctrl/Cmd+Shift+G, and Escape.
   *
   * Runs in the capture phase so it fires before the browser's native
   * find-in-page dialog (PRD §9.1).
   */
  private buildKeydownHandler(): (e: KeyboardEvent) => void {
    return (e: KeyboardEvent) => {
      const isMac = /Mac|iPhone|iPad/.test(navigator.platform)
      const mod   = isMac ? e.metaKey : e.ctrlKey

      // Ctrl/Cmd+F — open panel.
      if (mod && e.key === 'f') {
        e.preventDefault()
        this.openPanel()
        return
      }

      // Ctrl/Cmd+G — next match (only when panel is open).
      if (mod && e.key === 'g' && this._isOpen) {
        e.preventDefault()
        e.shiftKey ? this.prevMatch() : this.nextMatch()
        return
      }

      // Escape — close panel (only when panel is open and focus is inside it).
      if (e.key === 'Escape' && this._isOpen) {
        const target = e.target as Node | null
        if (this.panel && (this.panel === target || this.panel.contains(target))) {
          e.preventDefault()
          this.closePanel()
        }
        return
      }
    }
  }
}

// ─── Panel CSS ────────────────────────────────────────────────────────────────

const SEARCH_PANEL_CSS = `
.ls-search-panel {
  position: absolute;
  top: 8px;
  right: 8px;
  z-index: 1000;
  display: flex;
  align-items: center;
  gap: 4px;
  padding: 5px 8px;
  background: #fff;
  border: 1px solid rgba(0,0,0,0.18);
  border-radius: 6px;
  box-shadow: 0 2px 8px rgba(0,0,0,0.14), 0 1px 3px rgba(0,0,0,0.10);
  font-family: system-ui, -apple-system, sans-serif;
  font-size: 13px;
  line-height: 1;
  color: #111;
  user-select: none;
  /* Prevent panel interaction from triggering canvas events */
  pointer-events: auto;
}

@media (prefers-color-scheme: dark) {
  .ls-search-panel {
    background: #2b2b2b;
    border-color: rgba(255,255,255,0.16);
    color: #e8e8e8;
  }
  .ls-search-input {
    background: #1e1e1e !important;
    color: #e8e8e8 !important;
    border-color: rgba(255,255,255,0.20) !important;
  }
  .ls-search-input:focus {
    border-color: #3a9eff !important;
    box-shadow: 0 0 0 2px rgba(58,158,255,0.25) !important;
  }
  .ls-search-count {
    color: #aaa !important;
  }
  .ls-search-btn {
    color: #ccc !important;
  }
  .ls-search-btn:hover {
    background: rgba(255,255,255,0.10) !important;
    color: #fff !important;
  }
}

.ls-search-input {
  width: 180px;
  padding: 3px 7px;
  border: 1px solid rgba(0,0,0,0.22);
  border-radius: 4px;
  font-size: 13px;
  font-family: inherit;
  background: #fafafa;
  color: inherit;
  outline: none;
  transition: border-color 120ms, box-shadow 120ms;
}

.ls-search-input:focus {
  border-color: #0070c9;
  box-shadow: 0 0 0 2px rgba(0,112,201,0.22);
  background: #fff;
}

.ls-search-input::placeholder {
  color: #aaa;
}

.ls-search-count {
  min-width: 52px;
  text-align: center;
  font-variant-numeric: tabular-nums;
  font-size: 12px;
  color: #666;
  white-space: nowrap;
}

.ls-search-btn {
  width: 24px;
  height: 24px;
  padding: 0;
  border: none;
  border-radius: 4px;
  background: transparent;
  cursor: pointer;
  font-size: 16px;
  line-height: 1;
  color: #444;
  display: flex;
  align-items: center;
  justify-content: center;
  transition: background 100ms, color 100ms;
  flex-shrink: 0;
}

.ls-search-btn:hover {
  background: rgba(0,0,0,0.08);
  color: #000;
}

.ls-search-btn:active {
  background: rgba(0,0,0,0.14);
}

.ls-search-close {
  font-size: 18px;
  color: #888;
  margin-left: 2px;
}

.ls-search-close:hover {
  color: #cc2200;
}
`

// ─── Private helpers ──────────────────────────────────────────────────────────

/**
 * True when `ch` is a word character (letter, digit, or underscore).
 *
 * Equivalent to `\w` in a JS regex. Used by the whole-word boundary check
 * to determine whether characters adjacent to a match are word characters.
 *
 * This is intentionally ASCII-only — it matches browser regex `\w` behaviour
 * rather than Unicode property escapes, which would slow down the hot path.
 */
function isWordChar(ch: string): boolean {
  const c = ch.charCodeAt(0)
  return (
    (c >= 65 && c <= 90)  ||  // A–Z
    (c >= 97 && c <= 122) ||  // a–z
    (c >= 48 && c <= 57)  ||  // 0–9
    c === 95                  // underscore
  )
}
