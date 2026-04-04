import type { LayoutEngine } from './engine.js';
import { SearchMatchRect } from './paint.js';
export type { SearchMatchRect };
/** Per-query options for `LayoutSearch.search()`. */
export interface SearchOptions {
    /** Match regardless of letter case. Default: false (case-insensitive). */
    caseSensitive?: boolean;
    /**
     * Only match whole words — the characters immediately surrounding the
     * match (if present) must be non-word characters (\W equivalent).
     * Default: false.
     */
    wholeWord?: boolean;
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
    onScrollTo: (y: number) => void;
    /**
     * Returns the current vertical scroll offset in world-space pixels.
     * Called once at the start of each scroll animation to determine the
     * starting position. Not called in any per-frame hot path.
     */
    getScrollY: () => number;
    /**
     * Returns the canvas viewport height in CSS pixels.
     * Used to center the active match vertically on screen.
     * Called once per goToMatch().
     */
    getViewportH: () => number;
    /**
     * Opt out of the built-in search panel HTML (default: true = show panel).
     * Set to false if you supply your own search UI and call
     * `search.search(q)` / `search.goToMatch(n)` directly.
     */
    searchUI?: boolean;
    /**
     * Override the inactive-match highlight color passed to paintSearchHighlights().
     * Exposed here so the caller can read it and pass it to their paint call.
     * Default: 'rgba(255, 220, 0, 0.45)'.
     */
    inactiveMatchColor?: string;
    /**
     * Override the active-match highlight color.
     * Default: 'rgba(255, 165, 0, 0.75)'.
     */
    activeMatchColor?: string;
    /**
     * Optional: called whenever the search panel opens or closes.
     * Useful for external UI that needs to react (e.g. hiding other overlays).
     */
    onOpenChange?: (open: boolean) => void;
    /**
     * Optional: called after a search() completes with the match count.
     * Useful for external UI that displays match counts.
     */
    onMatchesChange?: (count: number) => void;
    /**
     * Optional: called after the active match index changes.
     * `index` is 0-based; `total` is matches.length.
     */
    onActiveChange?: (index: number, total: number) => void;
    /**
     * Trigger a canvas repaint outside the animation loop.
     * Called when the panel closes (to erase highlights) and when
     * search results change with the panel open.
     */
    requestRepaint?: () => void;
    /**
     * Duration of the scroll-to-match animation in milliseconds.
     * Set to 0 to jump instantly. Default: 200.
     */
    scrollDuration?: number;
}
export declare class LayoutSearch {
    private readonly engine;
    /** The canvas's parent element — panel is injected here. */
    private readonly container;
    private readonly showUI;
    private readonly onScrollTo;
    private readonly getScrollY;
    private readonly getViewportH;
    private readonly onOpenChange;
    private readonly onMatchesChange;
    private readonly onActiveChange;
    private readonly requestRepaint;
    private readonly scrollDuration;
    readonly inactiveMatchColor: string;
    readonly activeMatchColor: string;
    /** All matches from the most recent search(), in document order. */
    private _matches;
    /** Index of the match that will be highlighted as "active". */
    private _activeIndex;
    /** True when the search panel is visible (or Ctrl+F was pressed). */
    private _isOpen;
    /** Most recent query string. Re-run on rebuild() to stay current. */
    private _lastQuery;
    /** Most recent SearchOptions. Re-run on rebuild(). */
    private _lastOptions;
    private animFrame;
    private animStartTime;
    private animStartY;
    private animTargetY;
    private animDuration;
    private panel;
    private input;
    private countLabel;
    private readonly keydownHandler;
    private readonly cleanup;
    constructor(engine: LayoutEngine, 
    /** The canvas's parent element — panel is injected here. */
    container: HTMLElement, opts: SearchConstructorOptions);
    /** Matches from the most recent `search()` call. */
    get matches(): SearchMatchRect[];
    /** 0-based index of the currently highlighted match. */
    get activeIndex(): number;
    /** True when the search panel is open (highlights should be painted). */
    get isOpen(): boolean;
    /**
     * Open the search panel (or focus its input if already open).
     * This is also triggered by Ctrl/Cmd+F.
     */
    openPanel(): void;
    /** Close the search panel and clear highlights. */
    closePanel(): void;
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
    search(query: string, options?: SearchOptions): SearchMatchRect[];
    /**
     * Navigate to match at `index` (0-based), scrolling the canvas so the
     * match is vertically centered in the viewport.
     */
    goToMatch(index: number): void;
    /** Advance to the next match, wrapping around at the end. */
    nextMatch(): void;
    /** Move to the previous match, wrapping around at the start. */
    prevMatch(): void;
    /**
     * Rebuild search results after engine.compute() is called.
     * Re-runs the last query so highlights stay current after a layout change.
     * Safe to call with an empty last query (becomes a no-op).
     */
    rebuild(): void;
    /** Detach all event listeners and remove the panel from the DOM. */
    destroy(): void;
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
    private runSearch;
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
    private startScrollAnimation;
    private cancelAnimation;
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
    private buildPanel;
    /** Inject the search panel CSS once into the container's nearest shadow root
     *  or the document <head>. Uses a data attribute guard to avoid double-injection. */
    private injectPanelStyles;
    /** Update the "N of M" count label and ARIA live region. */
    private updateCountLabel;
    /**
     * Build the document-level keydown handler for Ctrl/Cmd+F, Ctrl/Cmd+G,
     * Ctrl/Cmd+Shift+G, and Escape.
     *
     * Runs in the capture phase so it fires before the browser's native
     * find-in-page dialog (PRD §9.1).
     */
    private buildKeydownHandler;
}
