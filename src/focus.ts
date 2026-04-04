// LayoutSans — focus.ts (v0.2)
//
// Keyboard focus state management for the Shadow Semantic Tree ↔ canvas bridge.
//
// The browser's native focus model (Tab key, :focus pseudo-class) operates
// entirely on DOM elements. LayoutSans has no focusable elements in the visual
// DOM — the canvas is not Tab-accessible by default and links are rendered
// as pixels. Instead, the Shadow Semantic Tree (shadow.ts) maintains invisible
// <a> elements in document order. When a shadow <a> receives focus, it fires
// a standard DOM 'focus' event; FocusController listens for those events via
// the setFocus() / clearFocus() callbacks exposed to shadow.ts, and updates
// `activeFocusNodeId`. The canvas RAF loop reads that value every frame and
// calls paintFocusRing() from paint.ts.
//
// Architecture constraints (PRD §7.2):
//   • Zero DOM reads inside any hot path. The record lookup is O(1) via a
//     pre-built Map that is rebuilt after each engine.compute().
//   • paintFocusRing() is called from the EXISTING RAF loop — FocusController
//     does not schedule its own animation frames.
//   • The canvas tabIndex is set to 0 so it participates in the normal Tab
//     order AROUND the shadow links; the canvas itself does not steal focus
//     from shadow links during keyboard navigation.
//   • Blur clears activeFocusNodeId only when no other link immediately gains
//     focus in the same tick (guarded by a one-tick defer via setTimeout(0)).

import type { BoxRecord } from './types.js'
import { paintFocusRing } from './paint.js'

// ─── FocusController ─────────────────────────────────────────────────────────

export class FocusController {
  // ── State ─────────────────────────────────────────────────────────────────

  /**
   * nodeId of the link that currently holds keyboard focus.
   * Null when no shadow link is focused. Read by the RAF loop each frame.
   */
  private _activeFocusNodeId: string | null = null

  /**
   * True when a blur event has fired but a new focus event has not yet arrived
   * in the same tick. Guards against the focus→blur→focus flicker that occurs
   * when Tab moves directly from one shadow link to the next.
   */
  private blurPending = false
  private blurTimer: ReturnType<typeof setTimeout> | null = null

  /**
   * Pre-built Map from nodeId → BoxRecord. Rebuilt after engine.compute().
   * Allows O(1) record lookup during RAF without iterating getAllRecords().
   */
  private recordMap: ReadonlyMap<string, BoxRecord> = new Map()

  // ── Constructor ───────────────────────────────────────────────────────────

  constructor(private readonly canvas: HTMLCanvasElement) {
    // The canvas must have tabIndex=0 so it participates in the Tab order
    // around the shadow links. The canvas keydown handler for Ctrl+A / Ctrl+C
    // was already set in mouse.ts, but we ensure it here as a safety measure.
    if (!canvas.hasAttribute('tabindex')) {
      canvas.setAttribute('tabindex', '0')
    }
  }

  // ── Public API ─────────────────────────────────────────────────────────────

  /** Current focused node id. Read by RAF loop; must be synchronous. */
  get activeFocusNodeId(): string | null {
    return this._activeFocusNodeId
  }

  /**
   * Rebuild the internal record map from a fresh compute() result.
   * Call after engine.compute() or engine.buildIndex().
   */
  setRecords(records: BoxRecord[]): void {
    const m = new Map<string, BoxRecord>()
    for (const r of records) m.set(r.nodeId, r)
    this.recordMap = m
    // If the previously-focused node no longer exists, clear focus.
    if (this._activeFocusNodeId && !m.has(this._activeFocusNodeId)) {
      this._activeFocusNodeId = null
    }
  }

  /**
   * Called by shadow.ts when a shadow <a> receives the 'focus' event.
   * Safe to call multiple times per tick (focus→focus without intervening blur).
   */
  setFocus(nodeId: string): void {
    // Cancel any pending blur-clear — a new focus arrived before the timeout.
    if (this.blurTimer !== null) {
      clearTimeout(this.blurTimer)
      this.blurTimer  = null
      this.blurPending = false
    }
    this._activeFocusNodeId = nodeId
  }

  /**
   * Called by shadow.ts when a shadow <a> receives the 'blur' event.
   * Deferred by one macrotask tick to allow the next 'focus' event to arrive
   * before we clear the active id (avoids a one-frame ring flash during Tab).
   */
  clearFocus(nodeId: string): void {
    // Only clear if this node is actually the active one (guards against
    // stale blur events from unmounted / recycled pool elements).
    if (this._activeFocusNodeId !== nodeId) return

    this.blurPending = true
    if (this.blurTimer !== null) clearTimeout(this.blurTimer)
    this.blurTimer = setTimeout(() => {
      this.blurTimer  = null
      this.blurPending = false
      // If setFocus() was not called in the interim, clear the id.
      if (this._activeFocusNodeId === nodeId) {
        this._activeFocusNodeId = null
      }
    }, 0)
  }

  /**
   * Programmatically focus the shadow link for `nodeId`, if one exists in the
   * Shadow Semantic Tree's container.
   *
   * Useful for `engine.scrollTo(nodeId)` flows where code wants to drive
   * keyboard focus to a specific item.
   */
  focusNode(nodeId: string, shadowContainer: HTMLElement): void {
    const candidate = shadowContainer.querySelector<HTMLAnchorElement>(
      `a[data-ls-node="${nodeId}"]`,
    )
    if (candidate) {
      candidate.focus({ preventScroll: true })
    }
  }

  /**
   * Paint the focus ring for the currently-active node onto the canvas.
   *
   * Must be called INSIDE the RAF loop, after all other canvas painting is
   * done, so the ring appears on top of content (PRD §7.2).
   *
   * @param ctx       The canvas 2D rendering context.
   * @param scrollY   Current vertical scroll offset.
   * @param accentColor  Optional override (default: Windows #0078d4).
   */
  paintActive(
    ctx: CanvasRenderingContext2D,
    scrollY: number,
    accentColor?: string,
  ): void {
    if (!this._activeFocusNodeId) return
    const record = this.recordMap.get(this._activeFocusNodeId)
    if (!record) return
    paintFocusRing(ctx, record, scrollY, accentColor)
  }

  /** Release all timers. Call on bridge.destroy(). */
  destroy(): void {
    if (this.blurTimer !== null) {
      clearTimeout(this.blurTimer)
      this.blurTimer = null
    }
    this._activeFocusNodeId = null
  }
}
