/* ============================================================
   SHARED MUTABLE STATE
   Used by both render.js and clipboard.js to avoid circular deps.
   ============================================================ */
export let focusedNodeId = null;
export let focusedCardId = null;
export let zCounter = 10;
export let _nodeObserver = null;
export function setNodeObserver(obs) { _nodeObserver = obs; }
export function setFocusedNodeId(id) { focusedNodeId = id; }
export function setFocusedCardId(id) { focusedCardId = id; }
export function incZCounter() { return ++zCounter; }
