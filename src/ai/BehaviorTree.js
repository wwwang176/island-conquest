/**
 * Lightweight Behavior Tree engine.
 * Node types: Selector (OR), Sequence (AND), Condition, Action.
 * Each tick returns: 'success', 'failure', or 'running'.
 */

export const BTState = { SUCCESS: 'success', FAILURE: 'failure', RUNNING: 'running' };

/** Tries children in order, returns first success/running. */
export class Selector {
    constructor(children) { this.children = children; }
    tick(ctx) {
        for (const child of this.children) {
            const r = child.tick(ctx);
            if (r !== BTState.FAILURE) return r;
        }
        return BTState.FAILURE;
    }
}

/** Runs children in order, fails on first failure. */
export class Sequence {
    constructor(children) { this.children = children; }
    tick(ctx) {
        for (const child of this.children) {
            const r = child.tick(ctx);
            if (r !== BTState.SUCCESS) return r;
        }
        return BTState.SUCCESS;
    }
}

/** Returns success if fn(ctx) is truthy, else failure. */
export class Condition {
    constructor(fn) { this.fn = fn; }
    tick(ctx) { return this.fn(ctx) ? BTState.SUCCESS : BTState.FAILURE; }
}

/** Executes fn(ctx), returns its BTState result. */
export class Action {
    constructor(fn) { this.fn = fn; }
    tick(ctx) { return this.fn(ctx); }
}

/** Inverts child result (success↔failure, running stays). */
export class Inverter {
    constructor(child) { this.child = child; }
    tick(ctx) {
        const r = this.child.tick(ctx);
        if (r === BTState.SUCCESS) return BTState.FAILURE;
        if (r === BTState.FAILURE) return BTState.SUCCESS;
        return r;
    }
}
