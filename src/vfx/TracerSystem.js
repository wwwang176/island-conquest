import * as THREE from 'three';

/**
 * Object-pooled bullet tracer system.
 * Each tracer is a thin triangular prism stretching from muzzle to impact,
 * visible briefly then fading out.
 */

const TRACER_RADIUS = 0.025;    // thickness
const TRACER_LIFE   = 0.1;      // seconds visible
const POOL_SIZE     = 40;

// Shared geometry: unit-length cylinder along Y, we scale Y per shot
let _sharedGeo = null;

function getSharedGeo() {
    if (!_sharedGeo) {
        _sharedGeo = new THREE.CylinderGeometry(TRACER_RADIUS, TRACER_RADIUS, 1, 3, 1, false);
    }
    return _sharedGeo;
}

const _up = new THREE.Vector3(0, 1, 0);
const _quat = new THREE.Quaternion();

export class TracerSystem {
    constructor(scene) {
        this.scene = scene;
        this.pool = [];
        this.poolIndex = 0;

        const geo = getSharedGeo();
        const baseMat = new THREE.MeshBasicMaterial({
            color: 0xffffcc,
            transparent: true,
            opacity: 0.5,
            depthWrite: false,
        });

        for (let i = 0; i < POOL_SIZE; i++) {
            const mat = baseMat.clone();
            const mesh = new THREE.Mesh(geo, mat);
            mesh.visible = false;
            mesh.frustumCulled = false;
            mesh.userData.life = 0;
            this.scene.add(mesh);
            this.pool.push(mesh);
        }
    }

    /**
     * Draw a full-length tracer line from origin to origin + dir * hitDist.
     */
    fire(origin, dir, hitDist = 200) {
        const tracer = this.pool[this.poolIndex];
        this.poolIndex = (this.poolIndex + 1) % POOL_SIZE;

        const len = hitDist;

        // Position at midpoint between origin and impact
        tracer.position.set(
            origin.x + dir.x * len * 0.5,
            origin.y + dir.y * len * 0.5,
            origin.z + dir.z * len * 0.5,
        );

        // Scale Y = full hit distance (geometry is 1 unit tall)
        tracer.scale.set(1, len, 1);

        // Orient cylinder Y-axis along fire direction
        _quat.setFromUnitVectors(_up, dir);
        tracer.quaternion.copy(_quat);

        tracer.material.opacity = 0.5;
        tracer.visible = true;
        tracer.userData.life = TRACER_LIFE;
    }

    update(dt) {
        for (const t of this.pool) {
            if (!t.visible) continue;
            t.userData.life -= dt;
            if (t.userData.life <= 0) {
                t.visible = false;
            } else {
                t.material.opacity = 0.5 * (t.userData.life / TRACER_LIFE);
            }
        }
    }
}
