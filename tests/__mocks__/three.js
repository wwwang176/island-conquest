// Minimal THREE.js stub for unit tests that import modules using THREE.
// Only provides what's needed by tested code paths.
export class Vector3 {
    constructor(x = 0, y = 0, z = 0) { this.x = x; this.y = y; this.z = z; }
    set(x, y, z) { this.x = x; this.y = y; this.z = z; return this; }
    copy(v) { this.x = v.x; this.y = v.y; this.z = v.z; return this; }
    add(v) { this.x += v.x; this.y += v.y; this.z += v.z; return this; }
    sub(v) { this.x -= v.x; this.y -= v.y; this.z -= v.z; return this; }
    subVectors(a, b) { this.x = a.x - b.x; this.y = a.y - b.y; this.z = a.z - b.z; return this; }
    multiplyScalar(s) { this.x *= s; this.y *= s; this.z *= s; return this; }
    normalize() {
        const l = Math.sqrt(this.x * this.x + this.y * this.y + this.z * this.z);
        if (l > 0) { this.x /= l; this.y /= l; this.z /= l; }
        return this;
    }
    length() { return Math.sqrt(this.x * this.x + this.y * this.y + this.z * this.z); }
    lengthSq() { return this.x * this.x + this.y * this.y + this.z * this.z; }
    distanceTo(v) {
        const dx = this.x - v.x, dy = this.y - v.y, dz = this.z - v.z;
        return Math.sqrt(dx * dx + dy * dy + dz * dz);
    }
    clone() { return new Vector3(this.x, this.y, this.z); }
    addScaledVector(v, s) { this.x += v.x * s; this.y += v.y * s; this.z += v.z * s; return this; }
    applyQuaternion() { return this; }
    applyEuler() { return this; }
    negate() { this.x = -this.x; this.y = -this.y; this.z = -this.z; return this; }
    crossVectors() { return this; }
    dot() { return 0; }
    transformDirection() { return this; }
}

export class Raycaster {
    constructor() { this.far = Infinity; }
    set() {}
    intersectObjects() { return []; }
}

export class Euler {
    constructor(x = 0, y = 0, z = 0, order = 'XYZ') { this.x = x; this.y = y; this.z = z; this.order = order; }
}

export class Quaternion {
    constructor() { this.x = 0; this.y = 0; this.z = 0; this.w = 1; }
    setFromAxisAngle() { return this; }
    setFromEuler() { return this; }
}

export class Color {
    constructor(c) { this.r = 0; this.g = 0; this.b = 0; }
    clone() { return new Color(); }
    multiplyScalar() { return this; }
    getHex() { return 0; }
}

export class Group {
    constructor() { this.children = []; this.position = new Vector3(); this.rotation = new Euler(); }
    add(c) { this.children.push(c); }
    remove() {}
}

export class Mesh extends Group {
    constructor(geo, mat) { super(); this.geometry = geo; this.material = mat; this.castShadow = false; this.visible = true; this.userData = {}; }
}

export class BufferGeometry {
    constructor() { this.attributes = {}; }
    setAttribute() { return this; }
    translate() { return this; }
    computeVertexNormals() {}
    dispose() {}
    rotateX() { return this; }
}

export class BoxGeometry extends BufferGeometry {}
export class CylinderGeometry extends BufferGeometry {}
export class CapsuleGeometry extends BufferGeometry {}
export class SphereGeometry extends BufferGeometry {}

export class MeshLambertMaterial { constructor() {} dispose() {} }
export class MeshBasicMaterial { constructor() {} dispose() {} }

export const AdditiveBlending = 1;
export const DoubleSide = 2;

export class Float32BufferAttribute { constructor() {} }
export class BufferAttribute { constructor() {} }

export class Scene extends Group {}
export class Object3D extends Group {}
