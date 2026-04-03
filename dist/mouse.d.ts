import type { LayoutEngine } from './engine.js';
export interface MouseHandlerOptions {
    /** The canvas element that receives mouse events. */
    canvas: HTMLCanvasElement;
    /** The LayoutEngine instance (owns SelectionState and textLineMap). */
    engine: LayoutEngine;
    /**
     * Returns the current vertical scroll offset in world-space pixels.
     * Called on every mouse event to convert viewport coords to world coords.
     */
    getScrollY: () => number;
    /**
     * Called whenever the selection changes and the canvas should be repainted.
     * Typically schedules a requestAnimationFrame if one isn't already pending.
     */
    requestRepaint: () => void;
    /**
     * Optional: link click handler override.
     * Return false to prevent default navigation (window.open / location.href).
     */
    onLinkClick?: (href: string, target: string) => boolean;
}
/**
 * Attach all mouse interaction handlers to the canvas.
 *
 * Returns a cleanup function — call it when the canvas is unmounted to remove
 * all event listeners and release internal state.
 */
export declare function attachMouseHandlers(opts: MouseHandlerOptions): () => void;
