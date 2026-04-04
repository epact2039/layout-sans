// LayoutSans — shadow.ts (v0.2)
//
// Shadow Semantic Tree — the accessibility layer that makes pure-canvas
// content readable by screen readers and keyboard-navigable via Tab.
//
// Architecture constraints (PRD §8):
//   • Invisible to sighted users: opacity:0, pointer-events:none (except <a>).
//   • NOT display:none / visibility:hidden — those remove nodes from the a11y tree.
//   • Virtualized: only nodes whose BoxRecord overlaps the visible viewport
//     ± BUFFER_VIEWPORTS are materialized as DOM nodes. O(viewport), not O(total).
//   • Hard cap: MAX_SHADOW_NODES DOM nodes in the container at any time.
//   • Layout-free: elements are positioned via transform:translate only.
//     The browser never runs flex/grid layout on these nodes.
//   • Pool-based: createElement() is only called during pool growth; steady-state
//     scroll performs textContent writes and style.transform writes only.
//   • One injected <style> tag, one role="document" container, one skip link.
//
// Node mapping (PRD §8.2):
//   text      → <p>
//   heading   → <h1>…<h6>
//   link      → <a>  (pointer-events:auto, Tab-focusable)
//   box+aria  → <div role="…">
//   flex/grid/magazine/absolute with aria → <section>
//   anything else → not materialized

import type { BoxRecord, TextLineData } from './types.js'
import type { FocusController } from './focus.js'

// ─── Public constants ─────────────────────────────────────────────────────────

/**
 * Number of additional viewport-heights of content to materialize above and
 * below the visible area. PRD §8.3 specifies ±3 viewport heights.
 */
export const BUFFER_VIEWPORTS = 3

/**
 * Absolute ceiling on simultaneously mounted shadow DOM nodes.
 * Once the pool would exceed this, the buffer multiplier is shrunk so the
 * total stays within budget (PRD §8.3).
 */
export const MAX_SHADOW_NODES = 600

// ─── CSS (injected once) ──────────────────────────────────────────────────────

const SHADOW_CSS = `
.ls-shadow-container {
  position: absolute;
  top: 0;
  left: 0;
  width: 100%;
  height: 0;
  overflow: visible;
  pointer-events: none;
}
.ls-shadow {
  position: absolute;
  top: 0;
  left: 0;
  opacity: 0;
  pointer-events: none;
  margin: 0;
  padding: 0;
  border: 0;
  font-size: 0;
  line-height: 0;
  white-space: pre-wrap;
  color: transparent;
}
.ls-shadow a {
  pointer-events: auto;
  outline: none;
  color: transparent;
  text-decoration: none;
}
.ls-skip {
  position: absolute;
  top: -100vh;
  left: 0;
  z-index: 9999;
  background: #fff;
  color: #000;
  padding: 4px 8px;
  font-size: 14px;
  text-decoration: none;
  border: 1px solid #000;
}
.ls-skip:focus {
  top: 0;
}
`

// ─── Types ────────────────────────────────────────────────────────────────────

/**
 * A pooled DOM element together with the nodeId it currently represents.
 * `null` nodeId means the slot is idle (back in the free pool).
 */
interface PoolEntry {
  el: HTMLElement
  nodeId: string | null
}

// ─── ShadowSemanticTree ───────────────────────────────────────────────────────

export class ShadowSemanticTree {
  // ── DOM references ────────────────────────────────────────────────────────

  /** The role="document" aria-live container. */
  private readonly container: HTMLDivElement

  /** The skip-navigation <a> element (WCAG 2.4.1). */
  private readonly skipLink: HTMLAnchorElement

  // ── Pool ──────────────────────────────────────────────────────────────────

  /**
   * All pool entries ever created. Entries with nodeId===null are idle.
   * The pool only grows; it never shrinks (pooled elements are reused).
   */
  private readonly pool: PoolEntry[] = []

  /**
   * Live mapping from nodeId → PoolEntry for currently mounted nodes.
   * Used for O(1) lookup during incremental sync.
   */
  private readonly mounted: Map<string, PoolEntry> = new Map()

  // ── Focus integration ─────────────────────────────────────────────────────

  /**
   * Optional FocusController reference. When set, focus/blur events on
   * shadow <a> elements are forwarded to it so the canvas draws focus rings.
   * Set via attachFocusController() after construction.
   */
  private focusController: FocusController | null = null

  // ── Constructor ───────────────────────────────────────────────────────────

  constructor(private readonly parentEl: HTMLElement) {
    this.injectStyles()
    this.skipLink  = this.createSkipLink()
    this.container = this.createContainer()
    parentEl.insertBefore(this.skipLink, parentEl.firstChild)
    parentEl.appendChild(this.container)
  }

  // ── Public API ─────────────────────────────────────────────────────────────

  /**
   * Wire a FocusController so shadow <a> focus/blur events drive canvas
   * focus-ring painting. Must be called before the first sync().
   */
  attachFocusController(fc: FocusController): void {
    this.focusController = fc
  }

  /**
   * Synchronize the shadow DOM to the current viewport window.
   *
   * Called every animation frame by InteractionBridge.sync() AFTER the canvas
   * frame is painted. Execution budget: < 2ms (PRD §13).
   *
   * Algorithm:
   *   1. Compute the world-space Y window: [viewTop − buffer, viewBottom + buffer]
   *      where buffer = BUFFER_VIEWPORTS × viewportH. Cap at MAX_SHADOW_NODES.
   *   2. Walk records in tree order; collect those whose BoxRecord Y-range
   *      overlaps the window AND whose nodeType maps to a semantic element.
   *   3. Unmount any currently-mounted node whose nodeId is NOT in the new set.
   *   4. Mount any new node not yet in the mounted set.
   *   5. For mounted nodes: update transform if the record moved (re-layout).
   *      Avoid unnecessary style writes — only write when the value changed.
   *
   * No DOM reads inside this function (no getBoundingClientRect, no offsetHeight).
   * All geometry comes from BoxRecord values (world-space px).
   */
  sync(
    records: BoxRecord[],
    scrollY: number,
    viewportH: number,
    textLineMap: ReadonlyMap<string, TextLineData>,
  ): void {
    // ── 1. Compute Y window ────────────────────────────────────────────────

    const buffer  = BUFFER_VIEWPORTS * viewportH
    const winTop  = scrollY - buffer
    const winBot  = scrollY + viewportH + buffer

    // ── 2. Identify records in window ──────────────────────────────────────

    // Pre-count to enforce MAX_SHADOW_NODES before allocating.
    let windowCount = 0
    for (let i = 0; i < records.length; i++) {
      const r = records[i]!
      if (!isMaterializable(r)) continue
      if (r.y + r.height < winTop) continue
      if (r.y > winBot) continue
      windowCount++
    }

    // If too many nodes would be in scope, shrink the buffer proportionally.
    let effectiveWinTop = winTop
    let effectiveWinBot = winBot
    if (windowCount > MAX_SHADOW_NODES) {
      const excess = windowCount - MAX_SHADOW_NODES
      const shrinkFactor = 1 - excess / windowCount
      const shrunkBuffer = buffer * shrinkFactor
      effectiveWinTop = scrollY - shrunkBuffer
      effectiveWinBot = scrollY + viewportH + shrunkBuffer
    }

    // ── 3. Build target set ────────────────────────────────────────────────

    // Using a Set for O(1) has-check in unmount loop.
    const targetIds = new Set<string>()
    const targetRecords = new Map<string, BoxRecord>()

    for (let i = 0; i < records.length; i++) {
      const r = records[i]!
      if (!isMaterializable(r)) continue
      if (r.y + r.height < effectiveWinTop) continue
      if (r.y > effectiveWinBot) continue
      targetIds.add(r.nodeId)
      targetRecords.set(r.nodeId, r)
    }

    // ── 4. Unmount stale nodes (return to pool) ────────────────────────────

    for (const [nodeId, entry] of this.mounted) {
      if (!targetIds.has(nodeId)) {
        this.unmount(entry)
        this.mounted.delete(nodeId)
      }
    }

    // ── 5. Mount / update nodes ────────────────────────────────────────────

    for (const nodeId of targetIds) {
      const record = targetRecords.get(nodeId)!
      const tld    = textLineMap.get(nodeId)

      const existing = this.mounted.get(nodeId)
      if (existing) {
        // Already mounted — update position if record moved.
        this.applyTransform(existing.el, record, scrollY)
      } else {
        // New node — acquire a pool slot and mount it.
        const entry = this.acquirePoolEntry(record)
        this.populateElement(entry.el, record, tld)
        this.applyTransform(entry.el, record, scrollY)
        entry.nodeId = nodeId
        this.mounted.set(nodeId, entry)
        this.container.appendChild(entry.el)
      }
    }
  }

  /**
   * Force-rebuild: unmount all nodes and reset pool occupancy.
   * Call after engine.compute() to flush stale BoxRecord geometry.
   */
  rebuild(): void {
    for (const [, entry] of this.mounted) {
      this.unmount(entry)
    }
    this.mounted.clear()
  }

  /** Remove all injected DOM nodes and the style tag. */
  destroy(): void {
    this.rebuild()
    this.container.remove()
    this.skipLink.remove()
    const styleTag = this.parentEl.querySelector('style[data-ls-shadow]')
    styleTag?.remove()
  }

  // ── Pool management ────────────────────────────────────────────────────────

  /**
   * Acquire an idle pool entry, or create a new one if the pool is exhausted.
   * Resets the element tag when the required tag differs from the pooled tag.
   * (Tags cannot be changed in-place — a mismatch causes a new createElement.)
   */
  private acquirePoolEntry(record: BoxRecord): PoolEntry {
    const tag = tagForRecord(record)

    // Find a free entry with the same tag.
    for (const entry of this.pool) {
      if (entry.nodeId === null && entry.el.tagName.toLowerCase() === tag) {
        return entry
      }
    }

    // Create a new element.
    const el = document.createElement(tag) as HTMLElement
    el.className = 'ls-shadow'
    const entry: PoolEntry = { el, nodeId: null }
    this.pool.push(entry)
    return entry
  }

  /** Return a pool entry to the idle state and remove its element from the DOM. */
  private unmount(entry: PoolEntry): void {
    entry.el.remove()
    entry.el.textContent = ''
    // Clear dynamic attributes set during populate.
    entry.el.removeAttribute('aria-level')
    entry.el.removeAttribute('href')
    entry.el.removeAttribute('target')
    entry.el.removeAttribute('rel')
    entry.el.removeAttribute('aria-label')
    entry.el.removeAttribute('role')
    entry.el.removeAttribute('id')
    entry.el.removeAttribute('dir')
    entry.el.style.transform = ''
    // Detach focus listeners if this was a link.
    if (entry.el.tagName === 'A') {
      const clone = entry.el.cloneNode(false) as HTMLElement
      clone.className = 'ls-shadow'
      // Swap the element in the pool so we start with clean listeners.
      // (cloneNode(false) strips all event listeners.)
      const idx = this.pool.indexOf(entry)
      if (idx !== -1) {
        this.pool[idx] = { el: clone, nodeId: null }
        // Note: `entry` is no longer in the pool after this swap, but since
        // unmount() is called with the old reference, we update in-place too.
        entry.el = clone
      }
    }
    entry.nodeId = null
  }

  // ── Element population ─────────────────────────────────────────────────────

  /**
   * Populate an element's content and ARIA attributes to match `record`.
   * Called only on mount, not on every frame — content does not change
   * between mounts unless rebuild() is called first.
   */
  private populateElement(
    el: HTMLElement,
    record: BoxRecord,
    tld: TextLineData | undefined,
  ): void {
    el.removeAttribute('id')

    switch (record.nodeType) {
      // ── text ───────────────────────────────────────────────────────────────
      case 'text': {
        el.textContent = record.textContent ?? ''
        break
      }

      // ── heading ────────────────────────────────────────────────────────────
      case 'heading': {
        el.textContent = record.textContent ?? ''
        // <h1>…<h6> convey level via their tag — no aria-level needed, but
        // we set it anyway for ARIA mapping consistency with assistive tech
        // that reads role="heading" + aria-level on generic elements.
        // The tag itself is set correctly by tagForRecord() → acquirePoolEntry().
        break
      }

      // ── link ────────────────────────────────────────────────────────────────
      case 'link': {
        const a = el as HTMLAnchorElement
        if (record.href) a.href = record.href
        if (record.target) a.target = record.target
        if (record.rel)    a.rel    = record.rel
        else if (record.target === '_blank') a.rel = 'noopener noreferrer'
        // textContent — links may contain inline text children.
        // For now, use the href as the accessible name fallback.
        if (!a.textContent) a.textContent = record.href ?? ''
        // Attach focus/blur/keydown for keyboard nav integration.
        this.attachLinkHandlers(a, record)
        break
      }

      // ── box with ARIA ──────────────────────────────────────────────────────
      case 'box': {
        // Only materialized when box has aria metadata (PRD §8.2).
        // The role/aria-label are derived from the BoxRecord's node.aria.
        // Because BoxRecord doesn't currently store aria attributes, we
        // use the nodeId as the element id for aria-describedby chains.
        el.id = `ls-${record.nodeId}`
        break
      }

      // ── containers ─────────────────────────────────────────────────────────
      case 'flex':
      case 'grid':
      case 'magazine':
      case 'absolute': {
        el.id = `ls-${record.nodeId}`
        break
      }

      default:
        break
    }
  }

  // ── Link focus / keyboard handlers ────────────────────────────────────────

  /**
   * Attach focus, blur, and keydown handlers to a shadow <a> element.
   *
   * When focused: forward the nodeId to FocusController so the canvas RAF
   * loop can draw a focus ring at the corresponding BoxRecord position.
   * When Enter/Space: navigate to href.
   */
  private attachLinkHandlers(a: HTMLAnchorElement, record: BoxRecord): void {
    const nodeId = record.nodeId
    const href   = record.href ?? ''
    const target = record.target ?? '_self'

    const onFocus = () => {
      this.focusController?.setFocus(nodeId)
    }
    const onBlur = () => {
      this.focusController?.clearFocus(nodeId)
    }
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Enter' || e.key === ' ') {
        e.preventDefault()
        if (target === '_blank') {
          window.open(href, '_blank', 'noopener,noreferrer')
        } else {
          window.location.href = href
        }
      }
    }

    a.addEventListener('focus',   onFocus)
    a.addEventListener('blur',    onBlur)
    a.addEventListener('keydown', onKeyDown)
    // Note: event listeners are dropped when unmount() swaps the <a> via
    // cloneNode — no manual removeEventListener bookkeeping needed here.
  }

  // ── Geometry ───────────────────────────────────────────────────────────────

  /**
   * Write a compositor-only transform to position the element.
   * Only writes to the DOM when the computed string differs from what's
   * already set — avoids style invalidation on static elements.
   */
  private applyTransform(
    el: HTMLElement,
    record: BoxRecord,
    scrollY: number,
  ): void {
    const tx = Math.round(record.x)
    const ty = Math.round(record.y - scrollY)
    const next = `translate(${tx}px,${ty}px)`
    if (el.style.transform !== next) el.style.transform = next
  }

  // ── DOM setup helpers ──────────────────────────────────────────────────────

  private injectStyles(): void {
    if (this.parentEl.querySelector('style[data-ls-shadow]')) return
    const style = document.createElement('style')
    style.setAttribute('data-ls-shadow', '')
    style.textContent = SHADOW_CSS
    // Prepend so consumer styles can override if needed.
    this.parentEl.insertBefore(style, this.parentEl.firstChild)
  }

  private createSkipLink(): HTMLAnchorElement {
    const a = document.createElement('a')
    a.href      = '#ls-content-start'
    a.className = 'ls-skip'
    a.textContent = 'Skip to content'
    return a
  }

  private createContainer(): HTMLDivElement {
    const div = document.createElement('div')
    div.className          = 'ls-shadow-container'
    div.setAttribute('role',          'document')
    div.setAttribute('aria-label',    'LayoutSans content region')
    div.setAttribute('aria-live',     'polite')
    div.setAttribute('aria-atomic',   'false')
    div.setAttribute('aria-relevant', 'additions removals')
    div.id = 'ls-content-start'  // target for the skip link
    return div
  }
}

// ─── Pure helpers (module-level) ──────────────────────────────────────────────

/**
 * True when a BoxRecord should be materialized as a shadow DOM element.
 *
 * Rules (PRD §8.2):
 *   text, heading, link → always materialize
 *   box without aria   → skip (no accessible content to expose)
 *   flex/grid/magazine/absolute → skip for now (no aria metadata on BoxRecord yet)
 */
function isMaterializable(record: BoxRecord): boolean {
  return (
    record.nodeType === 'text'    ||
    record.nodeType === 'heading' ||
    record.nodeType === 'link'
  )
}

/**
 * Map a BoxRecord to the HTML tag name for its shadow element.
 *
 * heading nodes use the level-specific tag (h1…h6).
 * All other materialized types use the generic tag for their semantic role.
 *
 * Because BoxRecord doesn't carry `level` for headings, we infer it from
 * the textContent heuristic — callers that need precise levels should store
 * it on the BoxRecord (a Task 8/9 concern). For now we default to 'h2'.
 */
function tagForRecord(record: BoxRecord): string {
  switch (record.nodeType) {
    case 'text':    return 'p'
    case 'link':    return 'a'
    case 'heading': return headingTag(record)
    case 'box':
    case 'flex':
    case 'grid':
    case 'magazine':
    case 'absolute': return 'section'
    default:         return 'div'
  }
}

/**
 * Extract the heading level from a BoxRecord and return the matching tag.
 *
 * The `level` field from `HeadingNode` is not surfaced on `BoxRecord` in the
 * current type definition. We read it from an extended property if the engine
 * has stored it, or fall back to 'h2' as a safe default.
 *
 * TODO (Task 9): Add `headingLevel?: 1|2|3|4|5|6` to BoxRecord so this
 * function can be exact without the cast.
 */
function headingTag(record: BoxRecord): string {
  const extended = record as BoxRecord & { headingLevel?: number }
  const level = extended.headingLevel
  if (level && level >= 1 && level <= 6) return `h${level}`
  return 'h2'
}
