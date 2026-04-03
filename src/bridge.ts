// LayoutSans — bridge.ts (v0.2)
//
// OS Bridge: the thin DOM shim that connects the pure-canvas renderer to the
// operating system's text interaction surface — clipboard, IME, and native
// mobile selection handles.
//
// Architecture invariants (PRD §6):
//   • Exactly ONE <textarea> element in the DOM (the Proxy Caret). Its count
//     does not scale with item count. It is 0×0 and fully transparent at rest.
//   • All selection painting remains on the canvas. The Proxy Caret is never
//     used to show text to sighted users — opacity: 0 always.
//   • The Proxy Caret is NOT display:none / visibility:hidden because those
//     remove the element from the OS accessibility tree and prevent clipboard
//     and mobile handle APIs from working.
//   • On mobile, the textarea is temporarily given real geometry matching the
//     hit TextNode so the OS positions teardrop drag handles at the correct
//     screen coordinates. It is restored to 0×0 after the selection is committed.
//
// Task 5 — Desktop clipboard:
//   • syncText(): copies SelectionState text → textarea.value + selectAll
//   • Ctrl/Cmd+C handler via document keydown (capture) → reliable cross-browser copy
//   • navigator.clipboard.writeText() as the primary path; execCommand fallback
//
// Task 6 — Mobile long-press + native handles:
//   • 500ms long-press detector; cancelled by drift > 8px or early touchend
//   • Word boundary expansion using prepared.kinds (space / zero-width-break /
//     hard-break are boundaries — same algorithm as mouse.ts expandToWordBoundaries)
//   • Proxy Caret population: mirrors font, origin, and text of the hit TextNode
//   • selectionchange listener maps textarea char offsets → SelectionCursors →
//     engine.selection.set() so the canvas repaints on every handle drag

import type { LayoutEngine }        from './engine.js'
import type { TextLineData, SelectionCursor } from './types.js'
import { charOffsetToCursor, getSelectedText, normalizeSelection, segmentIndexToCursor } from './selection.js'

// ─── InteractionOptions ───────────────────────────────────────────────────────

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
  searchUI?: boolean

  /**
   * Canvas selection highlight color (CSS color string).
   * Default: 'rgba(0, 120, 215, 0.35)' (light mode) or
   *           'rgba(100, 155, 255, 0.38)' (dark mode).
   */
  selectionColor?: string

  /**
   * Canvas highlight color for non-active search matches.
   * Default: 'rgba(255, 220, 0, 0.45)'.
   */
  searchHighlightColor?: string

  /**
   * Canvas highlight color for the active (current) search match.
   * Default: 'rgba(255, 165, 0, 0.7)'.
   */
  searchActiveColor?: string

  /**
   * Override link navigation. Return false to prevent the default
   * window.open / location.href behaviour.
   */
  onLinkClick?: (href: string, target: string) => boolean

  /**
   * Called when the canvas selection changes (after every mouse/touch drag
   * tick and on programmatic setSelection / clearSelection calls).
   *
   * `text` is the plain-text string of the current selection, or '' when the
   * selection is empty. Called synchronously inside SelectionState.onChange().
   */
  onSelectionChange?: (text: string) => void
}

// ─── Internal constants ───────────────────────────────────────────────────────

/** Milliseconds before a touchstart is classified as a long-press. */
const LONG_PRESS_DELAY_MS = 500

/**
 * Pixels of touch drift that cancel a pending long-press.
 * Matches the PRD recommendation (8px) and is consistent with typical
 * browser scroll-start thresholds.
 */
const LONG_PRESS_DRIFT_CANCEL_PX = 8

/**
 * Maximum number of characters mirrored into the Proxy Caret for a single
 * TextNode during mobile long-press. Limits O(n) string assignment jank on
 * very long nodes (PRD §6.3 edge-cases).
 */
const PROXY_TEXT_WINDOW = 2000

// ─── InteractionBridge ────────────────────────────────────────────────────────

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
export class InteractionBridge {
  // ── DOM elements ──────────────────────────────────────────────────────────

  /** The single Proxy Caret textarea. Injected once, never recreated. */
  private readonly proxyCaret: HTMLTextAreaElement

  // ── State ─────────────────────────────────────────────────────────────────

  /**
   * nodeId of the TextNode whose text is currently mirrored into the Proxy
   * Caret. Null when the caret is at rest (0×0). Tracked so that incoming
   * `selectionchange` events can be mapped back to SelectionCursors.
   */
  private mirroredNodeId: string | null = null

  /**
   * Character offset within the mirrored node's text where the mirror window
   * starts. Required for offset arithmetic when PROXY_TEXT_WINDOW < full text.
   */
  private mirrorWindowStart = 0

  /**
   * True after a long-press completes and the OS handles are visible.
   * Suppresses the syncText() → textarea.focus() flow on the next
   * selectionState.onChange() tick to avoid a focus battle.
   */
  private handlesActive = false

  // ── Long-press tracking ───────────────────────────────────────────────────

  private longPressTimer: ReturnType<typeof setTimeout> | null = null
  private longPressTouchStartX = 0
  private longPressTouchStartY = 0

  // ── Cleanup registry ──────────────────────────────────────────────────────

  /** Functions to call on destroy() — removes all event listeners. */
  private readonly cleanup: Array<() => void> = []

  // ── Constructor ───────────────────────────────────────────────────────────

  constructor(
    private readonly canvas: HTMLCanvasElement,
    private readonly engine: LayoutEngine,
    private readonly options: InteractionOptions = {},
  ) {
    this.proxyCaret = this.createProxyCaret()
    this.mountProxyCaret()
    this.attachDesktopClipboardHandlers()
    this.attachMobileTouchHandlers()
    this.attachSelectionChangeListener()
  }

  // ── Public API ─────────────────────────────────────────────────────────────

  /**
   * Most-recently passed scrollY. Cached so that mobile Proxy Caret
   * population can read the current scroll offset without querying the DOM.
   * Updated on every `sync()` call.
   */
  private lastScrollY = 0

  /**
   * Called every animation frame with the current scroll position, AFTER
   * the canvas frame has been painted.
   *
   * In v0.2.0 (Task 5/6 scope) this method is intentionally minimal: it keeps
   * the Proxy Caret's absolute position in sync with the canvas offset so that
   * any stray OS focus events land at the correct screen coordinate.
   *
   * v0.2.2 (Task 7) will extend this to also call
   * ShadowSemanticTree.sync(records, scrollY, viewportH, textLineMap).
   *
   * Execution budget: < 2ms (PRD §13).
   * Hot path: ONE style write (transform) if position changed; zero DOM reads.
   */
  sync(scrollY: number): void {
    this.lastScrollY = scrollY
    // Shadow Semantic Tree sync will be added in Task 7.
    // The Proxy Caret does not need per-frame repositioning at rest because it
    // is 0×0. When the mobile mirror is active (handlesActive), the caret was
    // positioned absolutely during long-press population (§6.3 Step 3) and
    // doesn't move between frames — the user is holding still during handle drag.
  }

  /**
   * Force-rebuild any internal state from the current engine.compute() result.
   * Call after the engine recomputes (layout changes).
   *
   * Currently resets the mobile mirror state so stale TextLineData references
   * are dropped. Task 7 will add ShadowSemanticTree.rebuild() here.
   */
  rebuild(): void {
    this.resetProxyCaretToRest()
    this.handlesActive = false
    this.mirroredNodeId = null
  }

  /**
   * Remove all DOM nodes injected by this bridge and detach all event listeners.
   * Must be called when the canvas is unmounted.
   */
  destroy(): void {
    for (const fn of this.cleanup) fn()
    this.cleanup.length = 0
    this.proxyCaret.remove()
    this.cancelLongPress()
  }

  // ── Proxy Caret construction ───────────────────────────────────────────────

  /**
   * Create and style the Proxy Caret textarea.
   *
   * CSS follows PRD §6.2 exactly. Key points:
   *   - NOT display:none / visibility:hidden (must stay in accessibility tree).
   *   - NOT pointer-events:none (must receive keyboard focus and touch events).
   *   - opacity:0 + color/background/caret-color transparent → fully invisible.
   *   - width:0 / height:0 at rest → zero footprint on the visual layout.
   */
  private createProxyCaret(): HTMLTextAreaElement {
    const ta = document.createElement('textarea')
    ta.className = 'ls-proxy-caret'

    // Apply all styles directly to avoid a <style> injection dependency.
    const s = ta.style
    s.position = 'absolute'
    s.top = '0'
    s.left = '0'
    s.width = '0'
    s.height = '0'
    s.padding = '0'
    s.border = '0'
    s.margin = '0'
    s.opacity = '0'
    s.resize = 'none'
    s.outline = 'none'
    s.overflow = 'hidden'
    s.color = 'transparent'
    s.background = 'transparent'
    s.caretColor = 'transparent'
    s.whiteSpace = 'pre-wrap'
    s.zIndex = '-1'
    // tabIndex is managed dynamically (set to -1 at rest; 0 during active desktop copy).
    ta.tabIndex = -1
    ta.setAttribute('aria-hidden', 'true')
    ta.setAttribute('autocomplete', 'off')
    ta.setAttribute('autocorrect', 'off')
    ta.setAttribute('autocapitalize', 'off')
    ta.setAttribute('spellcheck', 'false')
    ta.setAttribute('data-ls-proxy', '')

    return ta
  }

  /**
   * Inject the Proxy Caret into the DOM as a sibling of the canvas.
   *
   * The parent container must be `position: relative` (or absolute/fixed) so
   * that `position: absolute` on the textarea is scoped to the canvas wrapper,
   * not the document body.
   */
  private mountProxyCaret(): void {
    const parent = this.canvas.parentElement
    if (!parent) {
      // Defer until the canvas is actually in the DOM.
      const observer = new MutationObserver(() => {
        if (this.canvas.parentElement) {
          observer.disconnect()
          this.mountProxyCaret()
        }
      })
      observer.observe(document.body, { childList: true, subtree: true })
      return
    }

    // Ensure the container is a positioned ancestor so absolute children
    // are scoped correctly. Avoid overwriting non-static positions.
    const parentPos = getComputedStyle(parent).position
    if (parentPos === 'static') parent.style.position = 'relative'

    parent.appendChild(this.proxyCaret)
  }

  // ── Desktop clipboard (Task 5) ─────────────────────────────────────────────

  /**
   * Attach document-level keydown (capture) listener for Ctrl/Cmd+C.
   *
   * Capture phase fires before the browser's default clipboard handler,
   * giving us the chance to populate the textarea before the copy event.
   *
   * This is the most reliable cross-browser approach (PRD §6.2 "alternative
   * for browsers where textarea.focus() on selectionchange is unreliable").
   */
  private attachDesktopClipboardHandlers(): void {
    const onKeyDown = (e: KeyboardEvent) => {
      // Only intercept when the canvas (or our proxy caret) has focus, or
      // when SelectionState is non-empty (user may have clicked elsewhere).
      if (!this.engine.selection.isEmpty()) {
        const isMac = /Mac|iPhone|iPad/.test(navigator.platform)
        const mod = isMac ? e.metaKey : e.ctrlKey

        if (mod && e.key === 'c') {
          // Don't preventDefault — we want the browser to fire the 'copy' event.
          // We just pre-populate the textarea so it has the right content.
          this.syncText()
        }
      }
    }

    // Copy event fires on the textarea after we focus it + the OS copy gesture.
    const onCopy = (e: ClipboardEvent) => {
      if (!this.handlesActive) {
        // Desktop path: e.target is typically our textarea or the canvas.
        const text = this.getSelectionText()
        if (!text) return

        if (e.clipboardData) {
          e.preventDefault()
          e.clipboardData.setData('text/plain', text)
        }

        // Belt-and-suspenders: also write via async clipboard API.
        this.writeToClipboard(text)

        // Return focus to canvas so keyboard shortcuts keep working.
        this.canvas.focus()
      }
    }

    document.addEventListener('keydown', onKeyDown, { capture: true })
    this.proxyCaret.addEventListener('copy', onCopy)

    this.cleanup.push(() => {
      document.removeEventListener('keydown', onKeyDown, { capture: true })
      this.proxyCaret.removeEventListener('copy', onCopy)
    })
  }

  /**
   * Subscribe to SelectionState changes and sync the textarea value.
   *
   * On every selection change (drag tick, programmatic set/clear) the textarea
   * value is updated so that any subsequent Ctrl+C fires the correct text.
   * This path does NOT focus the textarea to avoid disrupting the user's drag.
   */
  private attachSelectionChangeListener(): void {
    const off = this.engine.selection.onChange(() => {
      if (this.handlesActive) return  // Mobile handles manage their own sync.

      const text = this.getSelectionText()

      // Notify the caller first (synchronous, before DOM writes).
      if (this.options.onSelectionChange) {
        this.options.onSelectionChange(text)
      }

      // Keep the textarea value fresh so Ctrl+C always has the right content.
      if (text) {
        this.proxyCaret.value = text
      } else {
        this.proxyCaret.value = ''
      }
    })

    this.cleanup.push(off)
  }

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
  syncText(): void {
    const text = this.getSelectionText()
    if (!text) return

    this.proxyCaret.value = text

    // Re-enable tab focus transiently so the browser treats it as a real input.
    this.proxyCaret.tabIndex = 0

    // Select all text so Ctrl+C copies everything we put in.
    this.proxyCaret.setSelectionRange(0, text.length)

    // Focus without scrolling the page (the textarea is 0×0, but some browsers
    // still scroll to focused elements).
    this.proxyCaret.focus({ preventScroll: true })

    // Attempt the async clipboard API as a redundant path.
    this.writeToClipboard(text)
  }

  // ── Mobile long-press + native handle sync (Task 6) ───────────────────────

  /**
   * Attach touchstart / touchmove / touchend listeners to the canvas for
   * long-press detection and native handle spawning.
   */
  private attachMobileTouchHandlers(): void {
    const onTouchStart = (e: TouchEvent) => {
      if (e.touches.length !== 1) return  // Ignore multi-touch.

      const touch = e.touches[0]!
      this.longPressTouchStartX = touch.clientX
      this.longPressTouchStartY = touch.clientY

      this.longPressTimer = setTimeout(() => {
        this.longPressTimer = null
        this.handleLongPress(touch.clientX, touch.clientY)
      }, LONG_PRESS_DELAY_MS)
    }

    const onTouchMove = (e: TouchEvent) => {
      if (!this.longPressTimer) return
      const touch = e.touches[0]!
      const dx = touch.clientX - this.longPressTouchStartX
      const dy = touch.clientY - this.longPressTouchStartY
      if (Math.sqrt(dx * dx + dy * dy) > LONG_PRESS_DRIFT_CANCEL_PX) {
        this.cancelLongPress()
      }
    }

    const onTouchEnd = () => {
      this.cancelLongPress()
    }

    this.canvas.addEventListener('touchstart',  onTouchStart, { passive: true })
    this.canvas.addEventListener('touchmove',   onTouchMove,  { passive: true })
    this.canvas.addEventListener('touchend',    onTouchEnd)
    this.canvas.addEventListener('touchcancel', onTouchEnd)

    this.cleanup.push(() => {
      this.canvas.removeEventListener('touchstart',  onTouchStart)
      this.canvas.removeEventListener('touchmove',   onTouchMove)
      this.canvas.removeEventListener('touchend',    onTouchEnd)
      this.canvas.removeEventListener('touchcancel', onTouchEnd)
    })
  }

  /** Cancel a pending long-press timer (drift, early touchend, or destroy). */
  private cancelLongPress(): void {
    if (this.longPressTimer !== null) {
      clearTimeout(this.longPressTimer)
      this.longPressTimer = null
    }
  }

  /**
   * Execute the full long-press procedure (PRD §6.3 Steps 1–6).
   *
   * @param clientX  Touch X in viewport (CSS pixel) coordinates.
   * @param clientY  Touch Y in viewport (CSS pixel) coordinates.
   */
  private async handleLongPress(clientX: number, clientY: number): Promise<void> {
    // ── Step 2: Identify the word under the finger ──────────────────────────

    const canvasRect = this.canvas.getBoundingClientRect()
    const worldX = clientX - canvasRect.left
    const worldY = clientY - canvasRect.top   // scrollY baked in by the engine's queryPoint

    const hits = await this.engine.queryPoint(worldX, worldY, 4)
    if (hits.length === 0) return

    // Find the first hit that has TextLineData (text or heading node).
    let hitNodeId: string | null = null
    for (const nodeId of hits) {
      if (this.engine.textLineMap.has(nodeId)) { hitNodeId = nodeId; break }
    }
    if (!hitNodeId) return

    const tld = this.engine.textLineMap.get(hitNodeId)!
    const record = this.engine.getAllRecords().find(r => r.nodeId === hitNodeId)
    if (!record) return

    // Resolve touch point → SelectionCursor.
    const { resolvePixelToCursor } = await import('./selection.js')
    const localX = worldX - tld.originX
    const localY = worldY - tld.originY
    const touchCursor = resolvePixelToCursor(hitNodeId, localX, localY, tld)

    // Expand to word boundaries using segment kinds (same algorithm as
    // mouse.ts expandToWordBoundaries — duplicated here to avoid a circular
    // import of the non-exported private helper).
    const { anchor: wordAnchor, focus: wordFocus } =
      expandToWordBoundaries(touchCursor, tld)

    // Set canvas selection immediately so the highlight appears under the handles.
    this.engine.selection.set({ anchor: wordAnchor, focus: wordFocus })

    // ── Step 3: Populate the Proxy Caret ────────────────────────────────────

    await this.populateProxyCaretForMobile(
      hitNodeId, tld, record, canvasRect,
      wordAnchor, wordFocus,
    )
  }

  /**
   * Position and populate the Proxy Caret so the OS spawns native teardrop
   * handles at the correct screen coordinates (PRD §6.3 Steps 3–4).
   *
   * The textarea is given real geometry (matching the TextNode's origin +
   * dimensions) and the same font as the TextNode, then selectionRange is
   * set to the word's char offsets. The OS observes "focused text input with
   * non-collapsed selection" and renders handles.
   */
  private async populateProxyCaretForMobile(
    nodeId: string,
    tld: TextLineData,
    record: import('./types.js').BoxRecord,
    canvasRect: DOMRect,
    wordAnchor: SelectionCursor,
    wordFocus: SelectionCursor,
  ): Promise<void> {
    const { prepared } = tld
    const fullText = prepared.segments.join('')

    // ── Windowed text (PRD §6.3 edge-case: very long nodes) ────────────────
    // Limit the mirrored text to PROXY_TEXT_WINDOW chars centred on the touch.
    const wordCharStart = cursorToCharOffset(wordAnchor, tld)
    const wordCharEnd   = cursorToCharOffset(wordFocus,  tld)

    let mirrorText: string
    let mirrorWindowStart: number

    if (fullText.length <= PROXY_TEXT_WINDOW) {
      mirrorText = fullText
      mirrorWindowStart = 0
    } else {
      const center = Math.floor((wordCharStart + wordCharEnd) / 2)
      mirrorWindowStart = Math.max(0, center - Math.floor(PROXY_TEXT_WINDOW / 2))
      const windowEnd   = Math.min(fullText.length, mirrorWindowStart + PROXY_TEXT_WINDOW)
      // Back-adjust if we hit the end of the text.
      mirrorWindowStart = Math.max(0, windowEnd - PROXY_TEXT_WINDOW)
      mirrorText = fullText.slice(mirrorWindowStart, windowEnd)
    }

    this.mirroredNodeId    = nodeId
    this.mirrorWindowStart = mirrorWindowStart

    // ── RTL direction ───────────────────────────────────────────────────────
    // Pretext exposes bidi metadata via segLevels; an odd level means RTL.
    // We check the first segment's level. If segLevels is null (LTR-only
    // fast path) we default to 'ltr'.
    const isRtl = isTextRtl(prepared)
    this.proxyCaret.dir = isRtl ? 'rtl' : 'ltr'

    // ── Mirror font and geometry ────────────────────────────────────────────
    // Font on the record may be the node's font string. Fall back to a
    // reasonable default that is close enough for the OS handle positioning.
    const nodeFont = record.textContent !== undefined
      ? (this.engine.getAllRecords().find(r => r.nodeId === nodeId) as
           import('./types.js').BoxRecord & { font?: string } | undefined)?.font
      : undefined
    this.proxyCaret.style.font = nodeFont ?? `${tld.lineHeight}px sans-serif`
    this.proxyCaret.style.lineHeight = `${tld.lineHeight}px`

    // Position the textarea over the TextNode's bounding box in screen space.
    // scrollY is implicit: record.y is in world space, but we subtract it from
    // canvasRect.top which is already in viewport space. The caller (handleLongPress)
    // must ensure worldY accounts for scroll. We use the stored originY here.
    const scrollY = this.lastScrollY
    this.proxyCaret.style.width  = `${record.width}px`
    this.proxyCaret.style.height = `${record.height}px`
    this.proxyCaret.style.left   = `${canvasRect.left + record.x}px`
    this.proxyCaret.style.top    = `${canvasRect.top  + record.y - scrollY}px`

    // ── Populate text and selection ─────────────────────────────────────────
    this.proxyCaret.value = mirrorText

    // Map word cursors to char offsets within the mirror window.
    const mirrorAnchorOffset = Math.max(0, wordCharStart - mirrorWindowStart)
    const mirrorFocusOffset  = Math.max(0, wordCharEnd   - mirrorWindowStart)

    // Critical ordering (PRD §6.3 Step 3):
    this.proxyCaret.style.opacity = '0'  // stays invisible but has real dimensions
    this.proxyCaret.tabIndex = 0
    this.proxyCaret.focus({ preventScroll: true })
    this.proxyCaret.setSelectionRange(mirrorAnchorOffset, mirrorFocusOffset)

    this.handlesActive = true

    // ── Step 5: selectionchange → canvas sync ───────────────────────────────
    // Attach listener now (detached in resetProxyCaretToRest).
    this.proxyCaret.addEventListener('selectionchange', this.onMobileSelectionChange)

    // ── Step 6: copy event ──────────────────────────────────────────────────
    this.proxyCaret.addEventListener('copy', this.onMobileCopy, { once: true })
  }

  /**
   * Handle `selectionchange` fired on the Proxy Caret while mobile handles
   * are active (PRD §6.3 Step 5).
   *
   * Maps textarea char offsets → SelectionCursors → engine.selection.set()
   * so the canvas repaints with the updated highlight on the next RAF.
   */
  private readonly onMobileSelectionChange = (): void => {
    if (!this.mirroredNodeId) return

    const tld = this.engine.textLineMap.get(this.mirroredNodeId)
    if (!tld) return

    const newCharStart = this.proxyCaret.selectionStart
    const newCharEnd   = this.proxyCaret.selectionEnd

    // Re-adjust from mirror-window-relative to full-text-relative offsets.
    const absStart = newCharStart + this.mirrorWindowStart
    const absEnd   = newCharEnd   + this.mirrorWindowStart

    const anchor = charOffsetToCursor(tld.prepared, absStart, tld)
    const focus  = charOffsetToCursor(tld.prepared, absEnd,   tld)

    // Update canvas selection. The RAF loop will repaint on the next tick.
    this.engine.selection.set({ anchor, focus })

    // Notify external handler.
    if (this.options.onSelectionChange) {
      const text = this.getSelectionText()
      this.options.onSelectionChange(text)
    }
  }

  /**
   * Handle `copy` fired on the Proxy Caret by the OS context menu
   * ("Copy" tap after handle selection — PRD §6.3 Step 6).
   */
  private readonly onMobileCopy = (e: ClipboardEvent): void => {
    const text = this.getSelectionText()
    if (text) {
      if (e.clipboardData) {
        e.preventDefault()
        e.clipboardData.setData('text/plain', text)
      }
      this.writeToClipboard(text)
    }

    // Restore the Proxy Caret to its resting 0×0 state.
    this.resetProxyCaretToRest()
  }

  // ── Proxy Caret reset ──────────────────────────────────────────────────────

  /**
   * Restore the Proxy Caret to its rest state: 0×0, opacity 0, tabIndex -1.
   * Called after a mobile copy completes or when the selection is cleared.
   */
  private resetProxyCaretToRest(): void {
    this.proxyCaret.removeEventListener('selectionchange', this.onMobileSelectionChange)

    const s = this.proxyCaret.style
    s.width   = '0'
    s.height  = '0'
    s.left    = '0'
    s.top     = '0'
    s.font    = ''
    s.lineHeight = ''
    this.proxyCaret.dir = ''
    this.proxyCaret.value = ''
    this.proxyCaret.tabIndex = -1
    this.handlesActive = false
    this.mirroredNodeId = null
    this.mirrorWindowStart = 0
  }

  // ── Utility ────────────────────────────────────────────────────────────────

  /**
   * Extract the plain-text string of the current SelectionState.
   * Returns '' when nothing is selected.
   */
  private getSelectionText(): string {
    const range = this.engine.selection.get()
    if (!range) return ''
    return getSelectedText(range, this.engine)
  }

  /**
   * Write text to the OS clipboard.
   *
   * Primary: navigator.clipboard.writeText() (async, requires secure context).
   * Fallback: document.execCommand('copy') via a temporarily-focused textarea.
   * Silent failure if both are unavailable (e.g. non-secure context in tests).
   */
  private writeToClipboard(text: string): void {
    // Primary: async Clipboard API.
    const clip = (navigator as unknown as { clipboard?: { writeText(s: string): Promise<void> } }).clipboard
    if (clip?.writeText) {
      clip.writeText(text).catch(() => this.execCommandCopy(text))
      return
    }
    // Fallback.
    this.execCommandCopy(text)
  }

  /**
   * Legacy execCommand('copy') fallback.
   * Temporarily selects all text in the Proxy Caret and fires the command.
   */
  private execCommandCopy(text: string): void {
    const prev = document.activeElement as HTMLElement | null
    this.proxyCaret.value = text
    this.proxyCaret.tabIndex = 0
    this.proxyCaret.select()
    this.proxyCaret.focus({ preventScroll: true })
    try {
      document.execCommand('copy')
    } catch {
      // Silently ignore — execCommand is deprecated and may throw in some contexts.
    } finally {
      this.proxyCaret.tabIndex = -1
      prev?.focus({ preventScroll: true })
    }
  }
}

// ─── Module-level helpers (pure functions, no `this`) ─────────────────────────

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
export function cursorToCharOffset(
  cursor: SelectionCursor,
  tld: TextLineData,
): number {
  const { prepared, lines } = tld
  let offset = 0

  for (let li = 0; li < lines.length; li++) {
    const line = lines[li]!

    for (let si = line.start.segmentIndex; si <= line.end.segmentIndex; si++) {
      const pfx = prepared.breakablePrefixWidths[si]
      const segStartGi = si === line.start.segmentIndex ? line.start.graphemeIndex : 0
      const segEndGi   = si === line.end.segmentIndex   ? line.end.graphemeIndex   : 0

      // Grapheme count for this segment on this line.
      const totalInSeg = pfx && pfx.length > 0
        ? (segEndGi > 0 ? segEndGi : pfx.length) - segStartGi
        : 1

      if (li === cursor.lineIndex && si === cursor.segmentIndex) {
        // We've reached the target segment. Add the intra-segment offset.
        const intraGi = cursor.graphemeIndex - segStartGi
        offset += Math.max(0, intraGi)
        return offset
      }

      offset += totalInSeg
    }
  }

  return offset
}

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
export function expandToWordBoundaries(
  cursor: SelectionCursor,
  tld: TextLineData,
): { anchor: SelectionCursor; focus: SelectionCursor } {
  const { prepared, lines } = tld
  const kinds = prepared.kinds
  const n = kinds.length

  // ── Walk backward to find word start ──────────────────────────────────────
  let startSi = cursor.segmentIndex
  while (startSi > 0) {
    const k = kinds[startSi - 1]
    if (isWordBoundaryKind(k)) break
    startSi--
  }

  // ── Walk forward to find word end ─────────────────────────────────────────
  let endSi = cursor.segmentIndex
  while (endSi < n - 1) {
    const k = kinds[endSi + 1]
    if (isWordBoundaryKind(k)) break
    endSi++
  }

  // ── Convert segment indices → SelectionCursors ────────────────────────────
  const startLi = findLineForSegment(lines, startSi)
  const endLi   = findLineForSegment(lines, endSi)

  // Word-start grapheme: first grapheme of startSi on its line.
  const startLineStart = lines[startLi]?.start
  const startGi = startSi === startLineStart?.segmentIndex
    ? startLineStart.graphemeIndex
    : 0

  // Word-end grapheme: last grapheme + 1 (cursor after the final grapheme).
  const endPfx = prepared.breakablePrefixWidths[endSi]
  const endGi  = endPfx && endPfx.length > 0 ? endPfx.length : 1

  const anchor = segmentIndexToCursor(tld, startLi, startSi, startGi)
  const focus  = segmentIndexToCursor(tld, endLi,   endSi,   endGi)

  return { anchor, focus }
}

// ─── Private module helpers ───────────────────────────────────────────────────

/** True for segment kinds that act as word boundaries during expansion. */
function isWordBoundaryKind(
  kind: string | undefined,
): boolean {
  return (
    kind === 'space' ||
    kind === 'zero-width-break' ||
    kind === 'hard-break' ||
    kind === 'preserved-space' ||
    kind === 'tab'
  )
}

/**
 * Binary search: find the index of the LayoutLine that contains segment `si`.
 * Mirrors the identical helper in mouse.ts (also private there) — duplicated
 * to avoid cross-module coupling of private internals.
 */
function findLineForSegment(
  lines: TextLineData['lines'],
  si: number,
): number {
  let lo = 0
  let hi = lines.length - 1
  while (lo <= hi) {
    const mid = (lo + hi) >> 1
    const line = lines[mid]!
    if (si < line.start.segmentIndex) {
      hi = mid - 1
    } else if (si > line.end.segmentIndex) {
      lo = mid + 1
    } else {
      return mid
    }
  }
  return Math.max(0, lines.length - 1)
}

/**
 * Detect whether the prepared text has a dominant RTL base direction.
 *
 * Pretext's `segLevels` (Int8Array | null) contains Unicode Bidi Algorithm
 * embedding levels per segment. An odd level means RTL. We check the first
 * segment — for most texts the base direction is uniform across the whole run.
 *
 * Returns false (LTR) when segLevels is null (Pretext's LTR-only fast path)
 * or when the array is empty.
 */
function isTextRtl(
  prepared: import('@chenglou/pretext').PreparedTextWithSegments,
): boolean {
  const levels = (prepared as unknown as { segLevels?: Int8Array | null }).segLevels
  if (!levels || levels.length === 0) return false
  // Level 0 = LTR, 1 = RTL, 2 = LTR-override, 3 = RTL-override, …
  // Odd levels are right-to-left.
  return (levels[0]! & 1) === 1
}
