import type { BoxRecord, TextLineData } from './types.js';
import type { FocusController } from './focus.js';
/**
 * Number of additional viewport-heights of content to materialize above and
 * below the visible area. PRD §8.3 specifies ±3 viewport heights.
 */
export declare const BUFFER_VIEWPORTS = 3;
/**
 * Absolute ceiling on simultaneously mounted shadow DOM nodes.
 * Once the pool would exceed this, the buffer multiplier is shrunk so the
 * total stays within budget (PRD §8.3).
 */
export declare const MAX_SHADOW_NODES = 600;
export declare class ShadowSemanticTree {
    private readonly parentEl;
    /** The role="document" aria-live container. */
    private readonly container;
    /** The skip-navigation <a> element (WCAG 2.4.1). */
    private readonly skipLink;
    /**
     * All pool entries ever created. Entries with nodeId===null are idle.
     * The pool only grows; it never shrinks (pooled elements are reused).
     */
    private readonly pool;
    /**
     * Live mapping from nodeId → PoolEntry for currently mounted nodes.
     * Used for O(1) lookup during incremental sync.
     */
    private readonly mounted;
    /**
     * Optional FocusController reference. When set, focus/blur events on
     * shadow <a> elements are forwarded to it so the canvas draws focus rings.
     * Set via attachFocusController() after construction.
     */
    private focusController;
    constructor(parentEl: HTMLElement);
    /**
     * Wire a FocusController so shadow <a> focus/blur events drive canvas
     * focus-ring painting. Must be called before the first sync().
     */
    attachFocusController(fc: FocusController): void;
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
    sync(records: BoxRecord[], scrollY: number, viewportH: number, textLineMap: ReadonlyMap<string, TextLineData>): void;
    /**
     * Force-rebuild: unmount all nodes and reset pool occupancy.
     * Call after engine.compute() to flush stale BoxRecord geometry.
     */
    rebuild(): void;
    /** Remove all injected DOM nodes and the style tag. */
    destroy(): void;
    /**
     * Acquire an idle pool entry, or create a new one if the pool is exhausted.
     * Resets the element tag when the required tag differs from the pooled tag.
     * (Tags cannot be changed in-place — a mismatch causes a new createElement.)
     */
    private acquirePoolEntry;
    /** Return a pool entry to the idle state and remove its element from the DOM. */
    private unmount;
    /**
     * Populate an element's content and ARIA attributes to match `record`.
     * Called only on mount, not on every frame — content does not change
     * between mounts unless rebuild() is called first.
     */
    private populateElement;
    /**
     * Attach focus, blur, and keydown handlers to a shadow <a> element.
     *
     * When focused: forward the nodeId to FocusController so the canvas RAF
     * loop can draw a focus ring at the corresponding BoxRecord position.
     * When Enter/Space: navigate to href.
     */
    private attachLinkHandlers;
    /**
     * Write a compositor-only transform to position the element.
     * Only writes to the DOM when the computed string differs from what's
     * already set — avoids style invalidation on static elements.
     */
    private applyTransform;
    private injectStyles;
    private createSkipLink;
    private createContainer;
}
