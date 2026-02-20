/**
 * Manages keyboard and mouse input state.
 * Tracks which keys are currently pressed and mouse movement deltas.
 */
export class InputManager {
    constructor() {
        this.keys = {};
        this.mouseDown = false;
        this.rightMouseDown = false;
        this.mouseDeltaX = 0;
        this.mouseDeltaY = 0;
        this.scrollDelta = 0;
        this.isPointerLocked = false;

        this._onKeyDown = this._onKeyDown.bind(this);
        this._onKeyUp = this._onKeyUp.bind(this);
        this._onMouseDown = this._onMouseDown.bind(this);
        this._onMouseUp = this._onMouseUp.bind(this);
        this._onMouseMove = this._onMouseMove.bind(this);
        this._onWheel = this._onWheel.bind(this);
        this._onPointerLockChange = this._onPointerLockChange.bind(this);

        document.addEventListener('keydown', this._onKeyDown);
        document.addEventListener('keyup', this._onKeyUp);
        document.addEventListener('mousedown', this._onMouseDown);
        document.addEventListener('mouseup', this._onMouseUp);
        document.addEventListener('mousemove', this._onMouseMove);
        document.addEventListener('wheel', this._onWheel, { passive: false });
        document.addEventListener('pointerlockchange', this._onPointerLockChange);
        document.addEventListener('contextmenu', (e) => e.preventDefault());
    }

    _onKeyDown(e) {
        this.keys[e.code] = true;
    }

    _onKeyUp(e) {
        this.keys[e.code] = false;
    }

    _onMouseDown(e) {
        if (e.button === 0) this.mouseDown = true;
        if (e.button === 2) this.rightMouseDown = true;
    }

    _onMouseUp(e) {
        if (e.button === 0) this.mouseDown = false;
        if (e.button === 2) this.rightMouseDown = false;
    }

    _onMouseMove(e) {
        if (this.isPointerLocked) {
            this.mouseDeltaX += e.movementX;
            this.mouseDeltaY += e.movementY;
        }
    }

    _onWheel(e) {
        e.preventDefault();
        this.scrollDelta += e.deltaY;
    }

    _onPointerLockChange() {
        this.isPointerLocked = document.pointerLockElement !== null;
    }

    isKeyDown(code) {
        return !!this.keys[code];
    }

    consumeMouseDelta() {
        const dx = this.mouseDeltaX;
        const dy = this.mouseDeltaY;
        this.mouseDeltaX = 0;
        this.mouseDeltaY = 0;
        return { dx, dy };
    }

    consumeScrollDelta() {
        const d = this.scrollDelta;
        this.scrollDelta = 0;
        return d;
    }

    requestPointerLock() {
        document.body.requestPointerLock().catch(() => {});
    }

    exitPointerLock() {
        document.exitPointerLock();
    }
}
