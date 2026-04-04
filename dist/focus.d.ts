import type { BoxRecord } from './types.js';
export declare class FocusController {
    private readonly canvas;
    /**
     * nodeId of the link that currently holds keyboard focus.
     * Null when no shadow link is focused. Read by the RAF loop each frame.
     */
    private _activeFocusNodeId;
    /**
     * True when a blur event has fired but a new focus event has not yet arrived
     * in the same tick. Guards against the focus→blur→focus flicker that occurs
     * when Tab moves directly from one shadow link to the next.
     */
    private blurPending;
    private blurTimer;
    /**
     * Pre-built Map from nodeId → BoxRecord. Rebuilt after engine.compute().
     * Allows O(1) record lookup during RAF without iterating getAllRecords().
     */
    private recordMap;
    constructor(canvas: HTMLCanvasElement);
    /** Current focused node id. Read by RAF loop; must be synchronous. */
    get activeFocusNodeId(): string | null;
    /**
     * Rebuild the internal record map from a fresh compute() result.
     * Call after engine.compute() or engine.buildIndex().
     */
    setRecords(records: BoxRecord[]): void;
    /**
     * Called by shadow.ts when a shadow <a> receives the 'focus' event.
     * Safe to call multiple times per tick (focus→focus without intervening blur).
     */
    setFocus(nodeId: string): void;
    /**
     * Called by shadow.ts when a shadow <a> receives the 'blur' event.
     * Deferred by one macrotask tick to allow the next 'focus' event to arrive
     * before we clear the active id (avoids a one-frame ring flash during Tab).
     */
    clearFocus(nodeId: string): void;
    /**
     * Programmatically focus the shadow link for `nodeId`, if one exists in the
     * Shadow Semantic Tree's container.
     *
     * Useful for `engine.scrollTo(nodeId)` flows where code wants to drive
     * keyboard focus to a specific item.
     */
    focusNode(nodeId: string, shadowContainer: HTMLElement): void;
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
    paintActive(ctx: CanvasRenderingContext2D, scrollY: number, accentColor?: string): void;
    /** Release all timers. Call on bridge.destroy(). */
    destroy(): void;
}
