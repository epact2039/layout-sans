import type { LayoutEngine } from './engine.js';
import type { TextLineData, SelectionCursor } from './types.js';
import { FocusController } from './focus.js';
import { LayoutSearch } from './search.js';
/**
 * Options passed to `engine.mount()` / `new InteractionBridge()`.
 *
 * All fields are optional. Defaults are deliberately conservative — no
 * override is needed for the common single-canvas setup.
 */
export interface InteractionOptions {
    /**
     * Opt in to the built-in search panel UI (default: true).
     * Set to false to render your own UI calling engine.layoutSearch APIs.
     */
    searchUI?: boolean;
    /**
     * Canvas selection highlight color (CSS color string).
     * Default: 'rgba(0, 120, 215, 0.35)' (light mode) or
     *           'rgba(100, 155, 255, 0.38)' (dark mode).
     */
    selectionColor?: string;
    /**
     * Canvas highlight color for non-active search matches.
     * Default: 'rgba(255, 220, 0, 0.45)'.
     */
    searchHighlightColor?: string;
    /**
     * Canvas highlight color for the active (current) search match.
     * Default: 'rgba(255, 165, 0, 0.7)'.
     */
    searchActiveColor?: string;
    /**
     * Override link navigation. Return false to prevent the default
     * window.open / location.href behaviour.
     */
    onLinkClick?: (href: string, target: string) => boolean;
    /**
     * Called when the canvas selection changes (after every mouse/touch drag
     * tick and on programmatic setSelection / clearSelection calls).
     *
     * `text` is the plain-text string of the current selection, or '' when the
     * selection is empty. Called synchronously inside SelectionState.onChange().
     */
    onSelectionChange?: (text: string) => void;
    /**
     * Called by the search engine's scroll-to-match animation on every RAF frame.
     * The caller must update their scrollY state variable and schedule a repaint.
     *
     * If not provided, the bridge manages scrollY internally — callers using the
     * bridge's `sync(scrollY)` pattern should pass their setState/setter here.
     */
    onScrollTo?: (y: number) => void;
    /**
     * Trigger a canvas repaint outside the normal RAF loop.
     * Called when the search panel closes (to erase highlights) and when
     * search results change while the panel is open.
     *
     * If not provided, callers are responsible for repainting on the next frame.
     */
    requestRepaint?: () => void;
}
/**
 * Manages the OS Bridge subsystem described in PRD §6.
 *
 * Owns:
 *   - The Proxy Caret `<textarea>` (one element, constant count).
 *   - All canvas mouse/touch event → clipboard/handle subscriptions that
 *     don't belong to the main mouse.ts selection drag handlers.
 *
 * Lifecycle:
 *   ```ts
 *   const bridge = new InteractionBridge(canvas, engine, options)
 *   // inside RAF loop, after painting:
 *   bridge.sync(scrollY)
 *   // on unmount:
 *   bridge.destroy()
 *   ```
 */
export declare class InteractionBridge {
    private readonly canvas;
    private readonly engine;
    private readonly options;
    /** The single Proxy Caret textarea. Injected once, never recreated. */
    private readonly proxyCaret;
    /** Virtualized accessibility DOM (screen reader + keyboard nav). */
    private readonly shadowTree;
    /** Canvas focus-ring state driven by shadow <a> focus/blur events. */
    readonly focusController: FocusController;
    /** In-memory full-text search engine + optional panel UI. */
    readonly search: LayoutSearch;
    /**
     * nodeId of the TextNode whose text is currently mirrored into the Proxy
     * Caret. Null when the caret is at rest (0×0). Tracked so that incoming
     * `selectionchange` events can be mapped back to SelectionCursors.
     */
    private mirroredNodeId;
    /**
     * Character offset within the mirrored node's text where the mirror window
     * starts. Required for offset arithmetic when PROXY_TEXT_WINDOW < full text.
     */
    private mirrorWindowStart;
    /**
     * True after a long-press completes and the OS handles are visible.
     * Suppresses the syncText() → textarea.focus() flow on the next
     * selectionState.onChange() tick to avoid a focus battle.
     */
    private handlesActive;
    private longPressTimer;
    private longPressTouchStartX;
    private longPressTouchStartY;
    /** Functions to call on destroy() — removes all event listeners. */
    private readonly cleanup;
    constructor(canvas: HTMLCanvasElement, engine: LayoutEngine, options?: InteractionOptions);
    /**
     * Most-recently passed scrollY. Cached so that mobile Proxy Caret
     * population can read the current scroll offset without querying the DOM.
     * Updated on every `sync()` call.
     */
    private lastScrollY;
    /**
     * Canvas viewport height in CSS pixels, derived from the canvas element's
     * clientHeight. Cached and updated each sync() call to avoid a layout read
     * per frame (one read per frame is acceptable; it is a cheap property).
     */
    private viewportH;
    /**
     * Sync all DOM subsystems to the current viewport state.
     *
     * Called every animation frame by the caller's RAF loop, AFTER the canvas
     * frame has been painted. Execution budget: < 2ms (PRD §13).
     *
     * Responsibilities:
     *   1. Update cached scroll + viewport geometry.
     *   2. Drive ShadowSemanticTree.sync() — virtualizes accessibility DOM.
     *   3. FocusController.setRecords() is called only when records change
     *      (from rebuild()), not every frame, to avoid Map allocation churn.
     *
     * No DOM reads except `canvas.clientHeight` (compositor-safe; no layout
     * recalculation triggered because we do not write layout properties before
     * reading it in this method).
     */
    sync(scrollY: number): void;
    /**
     * Force-rebuild all internal state from the current engine.compute() result.
     * Call after engine recomputes (layout changes).
     *
     * - Resets mobile mirror state (stale TextLineData references dropped).
     * - Rebuilds the ShadowSemanticTree (flushes all mounted nodes).
     * - Updates the FocusController's record map.
     */
    rebuild(): void;
    /**
     * Remove all DOM nodes injected by this bridge and detach all event listeners.
     * Must be called when the canvas is unmounted.
     */
    destroy(): void;
    /**
     * Create and style the Proxy Caret textarea.
     *
     * CSS follows PRD §6.2 exactly. Key points:
     *   - NOT display:none / visibility:hidden (must stay in accessibility tree).
     *   - NOT pointer-events:none (must receive keyboard focus and touch events).
     *   - opacity:0 + color/background/caret-color transparent → fully invisible.
     *   - width:0 / height:0 at rest → zero footprint on the visual layout.
     */
    private createProxyCaret;
    /**
     * Inject the Proxy Caret into the DOM as a sibling of the canvas.
     *
     * The parent container must be `position: relative` (or absolute/fixed) so
     * that `position: absolute` on the textarea is scoped to the canvas wrapper,
     * not the document body.
     */
    private mountProxyCaret;
    /**
     * Attach document-level keydown (capture) listener for Ctrl/Cmd+C.
     *
     * Capture phase fires before the browser's default clipboard handler,
     * giving us the chance to populate the textarea before the copy event.
     *
     * This is the most reliable cross-browser approach (PRD §6.2 "alternative
     * for browsers where textarea.focus() on selectionchange is unreliable").
     */
    private attachDesktopClipboardHandlers;
    /**
     * Subscribe to SelectionState changes and sync the textarea value.
     *
     * On every selection change (drag tick, programmatic set/clear) the textarea
     * value is updated so that any subsequent Ctrl+C fires the correct text.
     * This path does NOT focus the textarea to avoid disrupting the user's drag.
     */
    private attachSelectionChangeListener;
    /**
     * Populate the textarea with the currently selected text and make the full
     * string selected. Focus is transferred to the textarea so the browser's
     * Ctrl+C shortcut copies from it.
     *
     * After the copy event fires, `attachDesktopClipboardHandlers.onCopy`
     * returns focus to the canvas.
     *
     * Called:
     *   - By the Ctrl/Cmd+C keydown handler immediately before the copy event.
     *   - Optionally from external code that wants to trigger a programmatic copy.
     */
    syncText(): void;
    /**
     * Attach touchstart / touchmove / touchend listeners to the canvas for
     * long-press detection and native handle spawning.
     */
    private attachMobileTouchHandlers;
    /** Cancel a pending long-press timer (drift, early touchend, or destroy). */
    private cancelLongPress;
    /**
     * Execute the full long-press procedure (PRD §6.3 Steps 1–6).
     *
     * @param clientX  Touch X in viewport (CSS pixel) coordinates.
     * @param clientY  Touch Y in viewport (CSS pixel) coordinates.
     */
    private handleLongPress;
    /**
     * Position and populate the Proxy Caret so the OS spawns native teardrop
     * handles at the correct screen coordinates (PRD §6.3 Steps 3–4).
     *
     * The textarea is given real geometry (matching the TextNode's origin +
     * dimensions) and the same font as the TextNode, then selectionRange is
     * set to the word's char offsets. The OS observes "focused text input with
     * non-collapsed selection" and renders handles.
     */
    private populateProxyCaretForMobile;
    /**
     * Handle `selectionchange` fired on the Proxy Caret while mobile handles
     * are active (PRD §6.3 Step 5).
     *
     * Maps textarea char offsets → SelectionCursors → engine.selection.set()
     * so the canvas repaints with the updated highlight on the next RAF.
     */
    private readonly onMobileSelectionChange;
    /**
     * Handle `copy` fired on the Proxy Caret by the OS context menu
     * ("Copy" tap after handle selection — PRD §6.3 Step 6).
     */
    private readonly onMobileCopy;
    /**
     * Restore the Proxy Caret to its rest state: 0×0, opacity 0, tabIndex -1.
     * Called after a mobile copy completes or when the selection is cleared.
     */
    private resetProxyCaretToRest;
    /**
     * Extract the plain-text string of the current SelectionState.
     * Returns '' when nothing is selected.
     */
    private getSelectionText;
    /**
     * Write text to the OS clipboard.
     *
     * Primary: navigator.clipboard.writeText() (async, requires secure context).
     * Fallback: document.execCommand('copy') via a temporarily-focused textarea.
     * Silent failure if both are unavailable (e.g. non-secure context in tests).
     */
    private writeToClipboard;
    /**
     * Legacy execCommand('copy') fallback.
     * Temporarily selects all text in the Proxy Caret and fires the command.
     */
    private execCommandCopy;
}
/**
 * Convert a SelectionCursor to a linear character offset within its node.
 *
 * This is the inverse of `charOffsetToCursor` (selection.ts). It walks the
 * TextLineData's line/segment structure, accumulating grapheme counts, until
 * it reaches the cursor position.
 *
 * Used by the mobile Proxy Caret population procedure to compute the
 * `setSelectionRange` arguments from SelectionCursors.
 *
 * O(lines × segments_per_line) ≈ O(30) for typical paragraphs.
 * Not in the mousemove hot path — only called on long-press.
 */
export declare function cursorToCharOffset(cursor: SelectionCursor, tld: TextLineData): number;
/**
 * Expand a SelectionCursor to the word surrounding it.
 *
 * Word boundaries are defined by Pretext segment kinds:
 *   'space' | 'zero-width-break' | 'hard-break' | 'preserved-space' | 'tab'
 *
 * Walks `prepared.kinds` (the global segment-level kind array) backward from
 * `cursor.segmentIndex` to find the word start, and forward to find the end.
 * This is segment-level only — it does NOT attempt to split a segment
 * mid-grapheme, which matches browser double-click semantics for CJK and
 * hyphenated runs.
 *
 * Identical logic to mouse.ts `expandToWordBoundaries` (private helper), but
 * duplicated here to avoid a cross-module import of a non-exported function.
 * If that function is ever exported, this one can delegate to it.
 */
export declare function expandToWordBoundaries(cursor: SelectionCursor, tld: TextLineData): {
    anchor: SelectionCursor;
    focus: SelectionCursor;
};
