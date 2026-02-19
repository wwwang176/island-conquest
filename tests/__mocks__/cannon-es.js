// Minimal cannon-es stub for unit tests.
export class Body {
    static KINEMATIC = 4;
    static DYNAMIC = 1;
    constructor() {
        this.position = { x: 0, y: 0, z: 0, set(x, y, z) { this.x = x; this.y = y; this.z = z; } };
        this.velocity = { x: 0, y: 0, z: 0, set(x, y, z) { this.x = x; this.y = y; this.z = z; } };
        this.quaternion = { x: 0, y: 0, z: 0, w: 1, set(x, y, z, w) { this.x = x; this.y = y; this.z = z; this.w = w; } };
        this.angularVelocity = { x: 0, y: 0, z: 0, set(x, y, z) { this.x = x; this.y = y; this.z = z; } };
        this.shapes = [];
        this.mass = 0;
        this.type = Body.DYNAMIC;
        this.fixedRotation = false;
        this.collisionResponse = true;
        this.linearDamping = 0;
        this.angularDamping = 0;
        this.collisionFilterGroup = 0;
    }
    addShape(s, offset) { this.shapes.push(s); }
    removeShape(s) { const i = this.shapes.indexOf(s); if (i >= 0) this.shapes.splice(i, 1); }
    updateMassProperties() {}
    applyImpulse() {}
}

export class Vec3 {
    constructor(x = 0, y = 0, z = 0) { this.x = x; this.y = y; this.z = z; }
}

export class Sphere { constructor(r) { this.radius = r; } }
export class Cylinder { constructor(rt, rb, h, n) {} }
export class Material { constructor() {} }
