import * as THREE from 'three';

/**
 * Object-pooled bullet tracer system using a single InstancedMesh.
 * Each tracer is a thin cylinder stretching from muzzle to impact,
 * visible briefly then fading out.
 *
 * 40 tracers → 1 draw call via InstancedMesh + per-instance opacity.
 */

const TRACER_RADIUS = 0.025;    // thickness
const TRACER_LIFE   = 0.1;      // seconds visible
const POOL_SIZE     = 40;

const _up = new THREE.Vector3(0, 1, 0);
const _quat = new THREE.Quaternion();
const _pos = new THREE.Vector3();
const _scale = new THREE.Vector3();
const _mat4 = new THREE.Matrix4();

// Zero-scale matrix for hiding inactive instances
const _zeroMatrix = new THREE.Matrix4().makeScale(0, 0, 0);

export class TracerSystem {
    constructor(scene) {
        this.scene = scene;

        // Per-instance data arrays
        this._lives = new Float32Array(POOL_SIZE);
        this._opacities = new Float32Array(POOL_SIZE);
        this.poolIndex = 0;

        // Shared geometry: unit-length cylinder along Y
        const geo = new THREE.CylinderGeometry(TRACER_RADIUS, TRACER_RADIUS, 1, 3, 1, true);

        // Material with per-instance opacity via onBeforeCompile
        const mat = new THREE.MeshBasicMaterial({
            color: 0xffffcc,
            transparent: true,
            opacity: 1.0,
            depthWrite: false,
        });

        mat.onBeforeCompile = (shader) => {
            shader.vertexShader = shader.vertexShader.replace(
                '#include <common>',
                '#include <common>\nattribute float instanceOpacity;\nvarying float vInstanceOpacity;\n'
            );
            shader.vertexShader = shader.vertexShader.replace(
                '#include <begin_vertex>',
                '#include <begin_vertex>\nvInstanceOpacity = instanceOpacity;\n'
            );
            shader.fragmentShader = shader.fragmentShader.replace(
                '#include <common>',
                '#include <common>\nvarying float vInstanceOpacity;\n'
            );
            shader.fragmentShader = shader.fragmentShader.replace(
                '#include <opaque_fragment>',
                '#include <opaque_fragment>\ngl_FragColor.a *= vInstanceOpacity;\n'
            );
        };

        // Create InstancedMesh
        this._mesh = new THREE.InstancedMesh(geo, mat, POOL_SIZE);
        this._mesh.frustumCulled = false;
        this._mesh.renderOrder = 1;

        // Add per-instance opacity attribute
        const opacityAttr = new THREE.InstancedBufferAttribute(this._opacities, 1);
        geo.setAttribute('instanceOpacity', opacityAttr);

        // Initialize all instances as hidden (zero scale)
        for (let i = 0; i < POOL_SIZE; i++) {
            this._mesh.setMatrixAt(i, _zeroMatrix);
            this._opacities[i] = 0;
        }
        this._mesh.instanceMatrix.needsUpdate = true;

        scene.add(this._mesh);
    }

    /**
     * Draw a full-length tracer line from origin to origin + dir * hitDist.
     */
    fire(origin, dir, hitDist = 200) {
        const idx = this.poolIndex;
        this.poolIndex = (this.poolIndex + 1) % POOL_SIZE;

        const len = hitDist;

        // Position at midpoint between origin and impact
        _pos.set(
            origin.x + dir.x * len * 0.5,
            origin.y + dir.y * len * 0.5,
            origin.z + dir.z * len * 0.5,
        );

        // Scale Y = full hit distance (geometry is 1 unit tall)
        _scale.set(1, len, 1);

        // Orient cylinder Y-axis along fire direction
        _quat.setFromUnitVectors(_up, dir);

        _mat4.compose(_pos, _quat, _scale);
        this._mesh.setMatrixAt(idx, _mat4);

        this._opacities[idx] = 0.5;
        this._lives[idx] = TRACER_LIFE;
    }

    update(dt) {
        let anyActive = false;

        for (let i = 0; i < POOL_SIZE; i++) {
            if (this._lives[i] <= 0) continue;

            anyActive = true;
            this._lives[i] -= dt;

            if (this._lives[i] <= 0) {
                this._lives[i] = 0;
                this._opacities[i] = 0;
                this._mesh.setMatrixAt(i, _zeroMatrix);
            } else {
                this._opacities[i] = 0.5 * (this._lives[i] / TRACER_LIFE);
            }
        }

        if (anyActive) {
            this._mesh.instanceMatrix.needsUpdate = true;
            this._mesh.geometry.attributes.instanceOpacity.needsUpdate = true;
        }
    }
}
