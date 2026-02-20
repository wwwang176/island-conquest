import * as THREE from 'three';

/**
 * Object-pooled impact particle system.
 * Three particle types: dirt, water, spark — each rendered as a single THREE.Points
 * with a custom ShaderMaterial for per-particle size and opacity.
 *
 * Explosion smoke spheres and spikes use InstancedMesh (2 draw calls total).
 */

const PARTICLE_TYPES = {
    dirt: {
        colors: [new THREE.Color(0x8B7355), new THREE.Color(0x6B5B3A)],
        count: 8,
        sizeMin: 0.375, sizeMax: 0.75,
        life: 0.4,
        speedMin: 2, speedMax: 5,
        gravity: 9.8,
    },
    water: {
        colors: [new THREE.Color(0xffffff), new THREE.Color(0xeeeeff)],
        count: 20,
        sizeMin: 0.3, sizeMax: 0.625,
        life: 0.5,
        speedMin: 3, speedMax: 6,
        gravity: 5.0,
    },
    spark: {
        colors: [new THREE.Color(0xffcc00), new THREE.Color(0xffaa00)],
        count: 6,
        sizeMin: 0.25, sizeMax: 0.5,
        life: 0.3,
        speedMin: 4, speedMax: 8,
        gravity: 2.0,
    },
    blood: {
        colors: [new THREE.Color(0xcc0000), new THREE.Color(0x880000)],
        count: 10,
        sizeMin: 0.3, sizeMax: 0.7,
        life: 0.5,
        speedMin: 2, speedMax: 5,
        gravity: 6.0,
    },
    explosion: {
        colors: [new THREE.Color(0xff6600), new THREE.Color(0xffaa00), new THREE.Color(0xffff88)],
        count: 20,
        sizeMin: 0.8, sizeMax: 2.0,
        life: 0.4,
        speedMin: 12, speedMax: 24,
        gravity: 16.0,
    },
};

const POOL_SIZE = 150; // per type

const _v = new THREE.Vector3();
const _tangent = new THREE.Vector3();
const _bitangent = new THREE.Vector3();

// Hide dead particles far below scene
const DEAD_Y = -9999;

// Custom shader for per-particle size + opacity
const vertexShader = /* glsl */`
    attribute float aSize;
    attribute float aOpacity;
    varying float vOpacity;
    varying vec3 vColor;
    void main() {
        vColor = color;
        vOpacity = aOpacity;
        vec4 mvPosition = modelViewMatrix * vec4(position, 1.0);
        gl_PointSize = aSize * (300.0 / -mvPosition.z);
        gl_Position = projectionMatrix * mvPosition;
    }
`;

const fragmentShader = /* glsl */`
    varying float vOpacity;
    varying vec3 vColor;
    void main() {
        // Soft circle
        float d = length(gl_PointCoord - vec2(0.5));
        if (d > 0.5) discard;
        float alpha = vOpacity * (1.0 - d * 2.0);
        gl_FragColor = vec4(vColor, alpha);
    }
`;

// ── Explosion smoke sphere pool ──
const SMOKE_POOL_SIZE = 60;     // max concurrent smoke spheres
const SMOKE_PER_EXPLOSION = 8;  // spheres per explosion
const SMOKE_LIFE = 0.4;         // seconds

// ── Explosion spike pool ──
const SPIKE_POOL_SIZE = 80;     // max concurrent spikes
const SPIKES_PER_EXPLOSION = 10;
const SPIKE_LIFE = 0.2;         // very brief flash

// Zero-scale matrix for hiding inactive instances
const _zeroMatrix = new THREE.Matrix4().makeScale(0, 0, 0);
const _mat4 = new THREE.Matrix4();
const _pos = new THREE.Vector3();
const _quat = new THREE.Quaternion();
const _scale = new THREE.Vector3();
const _color = new THREE.Color();
const _colorEnd = new THREE.Color(0x111111);
const _spikeDir = new THREE.Vector3();
const _spikeUp = new THREE.Vector3(0, 1, 0);

// Fire colors for smoke spheres
const _fireColors = [0xff2200, 0xff6600, 0xffaa00, 0xffcc00];
// Spike colors
const _spikeColors = [0xffee88, 0xffcc00, 0xff8800, 0xffffff];

export class ImpactVFX {
    constructor(scene, getHeightAt) {
        this.scene = scene;
        this.getHeightAt = getHeightAt || null;
        this.types = {};

        for (const [name, cfg] of Object.entries(PARTICLE_TYPES)) {
            const data = this._createPool(cfg);
            this.types[name] = { cfg, ...data };
        }

        // Cache type values array to avoid per-frame Object.values() allocation
        this._typeValues = Object.values(this.types);

        // Smoke sphere InstancedMesh for explosions
        this._initSmokePool();
        // Spike InstancedMesh for explosions
        this._initSpikePool();
    }

    // ── Smoke sphere pool (InstancedMesh) ──

    _initSmokePool() {
        const geo = new THREE.SphereGeometry(1, 10, 8);

        const mat = new THREE.MeshBasicMaterial({
            transparent: true,
            opacity: 1,
            depthWrite: false,
        });

        // Inject per-instance opacity + color
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

        const mesh = new THREE.InstancedMesh(geo, mat, SMOKE_POOL_SIZE);
        mesh.frustumCulled = false;
        mesh.renderOrder = 998;
        mesh.instanceColor = new THREE.InstancedBufferAttribute(
            new Float32Array(SMOKE_POOL_SIZE * 3), 3
        );

        // Per-instance opacity attribute
        this._smokeOpacities = new Float32Array(SMOKE_POOL_SIZE);
        geo.setAttribute('instanceOpacity',
            new THREE.InstancedBufferAttribute(this._smokeOpacities, 1)
        );

        // Initialize all hidden
        for (let i = 0; i < SMOKE_POOL_SIZE; i++) {
            mesh.setMatrixAt(i, _zeroMatrix);
            mesh.setColorAt(i, new THREE.Color(0x111111));
            this._smokeOpacities[i] = 0;
        }
        mesh.instanceMatrix.needsUpdate = true;
        mesh.instanceColor.needsUpdate = true;

        this.scene.add(mesh);
        this._smokeMesh = mesh;

        // Per-instance state
        this._smokeState = [];
        for (let i = 0; i < SMOKE_POOL_SIZE; i++) {
            this._smokeState.push({
                life: 0,
                maxLife: 0,
                px: 0, py: 0, pz: 0,
                vx: 0, vy: 0, vz: 0,
                scaleStart: 0,
                scaleEnd: 0,
                colorStartR: 0, colorStartG: 0, colorStartB: 0,
            });
        }
        this._smokeNextIndex = 0;
    }

    _spawnSmokeSpheres(position) {
        for (let i = 0; i < SMOKE_PER_EXPLOSION; i++) {
            const idx = this._smokeNextIndex;
            this._smokeNextIndex = (this._smokeNextIndex + 1) % SMOKE_POOL_SIZE;
            const s = this._smokeState[idx];

            // Random outward direction — fast burst
            const phi = Math.random() * Math.PI * 2;
            const theta = Math.random() * Math.PI * 0.6;
            const speed = 8 + Math.random() * 10;
            s.vx = Math.sin(theta) * Math.cos(phi) * speed;
            s.vy = Math.cos(theta) * speed * 0.8 + 4;
            s.vz = Math.sin(theta) * Math.sin(phi) * speed;

            s.scaleStart = 0.3 + Math.random() * 0.5;
            s.scaleEnd = 2.0 + Math.random() * 1.5;

            // Life with slight variation
            s.life = SMOKE_LIFE * (0.7 + Math.random() * 0.6);
            s.maxLife = s.life;

            // Position at blast center with small random offset
            const ox = (Math.random() - 0.5) * 1.0;
            const oy = Math.random() * 0.6;
            const oz = (Math.random() - 0.5) * 1.0;

            // Random warm start color (red/orange/yellow)
            _color.set(_fireColors[Math.floor(Math.random() * _fireColors.length)]);
            s.colorStartR = _color.r;
            s.colorStartG = _color.g;
            s.colorStartB = _color.b;

            let spawnY = position.y + oy;
            if (this.getHeightAt) {
                const groundY = this.getHeightAt(position.x + ox, position.z + oz);
                if (spawnY < groundY + 0.2) spawnY = groundY + 0.2;
            }
            s.px = position.x + ox;
            s.py = spawnY;
            s.pz = position.z + oz;

            // Set initial instance matrix
            _pos.set(s.px, s.py, s.pz);
            _scale.setScalar(s.scaleStart);
            _mat4.compose(_pos, _quat.identity(), _scale);
            this._smokeMesh.setMatrixAt(idx, _mat4);

            // Set initial color
            this._smokeMesh.setColorAt(idx, _color);
            this._smokeOpacities[idx] = 0.85;
        }

        this._smokeMesh.instanceMatrix.needsUpdate = true;
        this._smokeMesh.instanceColor.needsUpdate = true;
        this._smokeMesh.geometry.attributes.instanceOpacity.needsUpdate = true;
    }

    _updateSmokeSpheres(dt) {
        let anyActive = false;

        for (let idx = 0; idx < SMOKE_POOL_SIZE; idx++) {
            const s = this._smokeState[idx];
            if (s.life <= 0) continue;

            anyActive = true;
            s.life -= dt;
            const t = 1 - (s.life / s.maxLife); // 0→1 over lifetime

            // Move outward, decelerate hard
            const drag = 1 - 5.0 * dt;
            s.vx *= drag;
            s.vy *= drag;
            s.vz *= drag;
            s.vy -= 3.0 * dt;

            s.px += s.vx * dt;
            s.py += s.vy * dt;
            s.pz += s.vz * dt;

            // Clamp above ground
            if (this.getHeightAt) {
                const groundY = this.getHeightAt(s.px, s.pz);
                if (s.py < groundY + 0.2) {
                    s.py = groundY + 0.2;
                    if (s.vy < 0) s.vy = 0;
                }
            }

            // Scale: grow from small to large
            const scale = s.scaleStart + (s.scaleEnd - s.scaleStart) * t;

            // Color: fire → black smoke
            const colorT = Math.min(1, t * 3);
            _color.setRGB(s.colorStartR, s.colorStartG, s.colorStartB).lerp(_colorEnd, colorT);

            // Opacity: hold then fade out
            let opacity;
            if (t < 0.3) {
                opacity = 0.85;
            } else {
                opacity = 0.85 * (1 - (t - 0.3) / 0.7);
            }

            if (s.life <= 0) {
                s.life = 0;
                this._smokeMesh.setMatrixAt(idx, _zeroMatrix);
                this._smokeOpacities[idx] = 0;
            } else {
                _pos.set(s.px, s.py, s.pz);
                _scale.setScalar(scale);
                _mat4.compose(_pos, _quat.identity(), _scale);
                this._smokeMesh.setMatrixAt(idx, _mat4);
                this._smokeMesh.setColorAt(idx, _color);
                this._smokeOpacities[idx] = opacity;
            }
        }

        if (anyActive) {
            this._smokeMesh.instanceMatrix.needsUpdate = true;
            this._smokeMesh.instanceColor.needsUpdate = true;
            this._smokeMesh.geometry.attributes.instanceOpacity.needsUpdate = true;
        }
    }

    // ── Spike pool (InstancedMesh) ──

    _initSpikePool() {
        // Thin box stretched along Y, origin shifted to bottom
        const geo = new THREE.BoxGeometry(0.06, 1, 0.06);
        geo.translate(0, 0.5, 0);

        const mat = new THREE.MeshBasicMaterial({
            transparent: true,
            opacity: 1,
            depthWrite: false,
        });

        // Inject per-instance opacity + color
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

        const mesh = new THREE.InstancedMesh(geo, mat, SPIKE_POOL_SIZE);
        mesh.frustumCulled = false;
        mesh.renderOrder = 999;
        mesh.instanceColor = new THREE.InstancedBufferAttribute(
            new Float32Array(SPIKE_POOL_SIZE * 3), 3
        );

        // Per-instance opacity attribute
        this._spikeOpacities = new Float32Array(SPIKE_POOL_SIZE);
        geo.setAttribute('instanceOpacity',
            new THREE.InstancedBufferAttribute(this._spikeOpacities, 1)
        );

        // Initialize all hidden
        for (let i = 0; i < SPIKE_POOL_SIZE; i++) {
            mesh.setMatrixAt(i, _zeroMatrix);
            this._spikeOpacities[i] = 0;
        }
        mesh.instanceMatrix.needsUpdate = true;

        this.scene.add(mesh);
        this._spikeMesh = mesh;

        // Per-instance state
        this._spikeState = [];
        for (let i = 0; i < SPIKE_POOL_SIZE; i++) {
            this._spikeState.push({
                life: 0,
                maxLife: 0,
                length: 0,
                // Store position + orientation quaternion for updates
                px: 0, py: 0, pz: 0,
                qx: 0, qy: 0, qz: 0, qw: 1,
            });
        }
        this._spikeNextIndex = 0;
    }

    _spawnSpikes(position) {
        for (let i = 0; i < SPIKES_PER_EXPLOSION; i++) {
            const idx = this._spikeNextIndex;
            this._spikeNextIndex = (this._spikeNextIndex + 1) % SPIKE_POOL_SIZE;
            const s = this._spikeState[idx];

            // Random direction — full sphere distribution
            const phi = Math.random() * Math.PI * 2;
            const theta = Math.random() * Math.PI;
            const dx = Math.sin(theta) * Math.cos(phi);
            const dy = Math.cos(theta) * 0.5 + 0.5; // bias upward
            const dz = Math.sin(theta) * Math.sin(phi);
            _spikeDir.set(dx, dy, dz).normalize();

            // Orient: default is +Y, rotate to point along direction
            _quat.setFromUnitVectors(_spikeUp, _spikeDir);

            s.px = position.x;
            s.py = position.y;
            s.pz = position.z;
            s.qx = _quat.x;
            s.qy = _quat.y;
            s.qz = _quat.z;
            s.qw = _quat.w;

            // Spike length: 4-7m
            s.length = 4 + Math.random() * 3;

            // Life with variation
            s.life = SPIKE_LIFE * (0.6 + Math.random() * 0.8);
            s.maxLife = s.life;

            // Start invisible (scale near zero), grows outward
            _pos.set(s.px, s.py, s.pz);
            _scale.set(1, 0.01, 1);
            _mat4.compose(_pos, _quat, _scale);
            this._spikeMesh.setMatrixAt(idx, _mat4);

            // Bright fire color
            _color.set(_spikeColors[Math.floor(Math.random() * _spikeColors.length)]);
            this._spikeMesh.setColorAt(idx, _color);
            this._spikeOpacities[idx] = 1.0;
        }

        this._spikeMesh.instanceMatrix.needsUpdate = true;
        this._spikeMesh.instanceColor.needsUpdate = true;
        this._spikeMesh.geometry.attributes.instanceOpacity.needsUpdate = true;
    }

    _updateSpikes(dt) {
        let anyActive = false;

        for (let idx = 0; idx < SPIKE_POOL_SIZE; idx++) {
            const s = this._spikeState[idx];
            if (s.life <= 0) continue;

            anyActive = true;
            s.life -= dt;
            const t = 1 - (s.life / s.maxLife); // 0→1

            // Scale Y: spike shoots out fast then retracts
            let scaleY;
            if (t < 0.3) {
                scaleY = (t / 0.3) * s.length;
            } else {
                scaleY = s.length * (1 - (t - 0.3) / 0.7);
            }

            // Opacity: fade out
            const opacity = 1 - t;

            if (s.life <= 0) {
                s.life = 0;
                this._spikeMesh.setMatrixAt(idx, _zeroMatrix);
                this._spikeOpacities[idx] = 0;
            } else {
                _pos.set(s.px, s.py, s.pz);
                _quat.set(s.qx, s.qy, s.qz, s.qw);
                _scale.set(1, Math.max(0.01, scaleY), 1);
                _mat4.compose(_pos, _quat, _scale);
                this._spikeMesh.setMatrixAt(idx, _mat4);
                this._spikeOpacities[idx] = opacity;
            }
        }

        if (anyActive) {
            this._spikeMesh.instanceMatrix.needsUpdate = true;
            this._spikeMesh.geometry.attributes.instanceOpacity.needsUpdate = true;
        }
    }

    // ── Point particle pool ──

    _createPool(cfg) {
        const positions = new Float32Array(POOL_SIZE * 3);
        const colors = new Float32Array(POOL_SIZE * 3);
        const particleSizes = new Float32Array(POOL_SIZE);
        const opacities = new Float32Array(POOL_SIZE);
        const velocities = new Float32Array(POOL_SIZE * 3);
        const lives = new Float32Array(POOL_SIZE);
        const maxLives = new Float32Array(POOL_SIZE);

        // Init all particles as dead (below scene)
        for (let i = 0; i < POOL_SIZE; i++) {
            positions[i * 3 + 1] = DEAD_Y;
        }

        const geo = new THREE.BufferGeometry();
        geo.setAttribute('position', new THREE.BufferAttribute(positions, 3));
        geo.setAttribute('color', new THREE.BufferAttribute(colors, 3));
        geo.setAttribute('aSize', new THREE.BufferAttribute(particleSizes, 1));
        geo.setAttribute('aOpacity', new THREE.BufferAttribute(opacities, 1));

        const mat = new THREE.ShaderMaterial({
            vertexShader,
            fragmentShader,
            vertexColors: true,
            transparent: true,
            depthWrite: false,
        });

        const points = new THREE.Points(geo, mat);
        points.frustumCulled = false;
        this.scene.add(points);

        return { positions, colors, particleSizes, opacities, velocities, lives, maxLives, geo, points, nextIndex: 0 };
    }

    /**
     * Spawn particles at a hit position.
     * @param {'dirt'|'water'|'spark'|'blood'|'explosion'} type
     * @param {THREE.Vector3} position - hit point
     * @param {THREE.Vector3} [normal] - surface normal (defaults to up)
     */
    spawn(type, position, normal) {
        const data = this.types[type];
        if (!data) return;

        // Explosion: also spawn 3D smoke spheres + spikes
        if (type === 'explosion') {
            this._spawnSmokeSpheres(position);
            this._spawnSpikes(position);
        }

        const cfg = data.cfg;
        const n = normal ? _v.copy(normal).normalize() : _v.set(0, 1, 0);

        // Build tangent frame for hemisphere sampling
        if (Math.abs(n.y) < 0.99) {
            _tangent.set(0, 1, 0).cross(n).normalize();
        } else {
            _tangent.set(1, 0, 0).cross(n).normalize();
        }
        _bitangent.crossVectors(n, _tangent);

        for (let i = 0; i < cfg.count; i++) {
            const idx = data.nextIndex;
            data.nextIndex = (data.nextIndex + 1) % POOL_SIZE;
            const i3 = idx * 3;

            // Position
            data.positions[i3]     = position.x;
            data.positions[i3 + 1] = position.y;
            data.positions[i3 + 2] = position.z;

            // Random direction in hemisphere around normal
            const phi = Math.random() * Math.PI * 2;
            const cosTheta = Math.cos(Math.random() * (Math.PI / 6));
            const sinTheta = Math.sqrt(1 - cosTheta * cosTheta);

            const dx = _tangent.x * Math.cos(phi) * sinTheta + _bitangent.x * Math.sin(phi) * sinTheta + n.x * cosTheta;
            const dy = _tangent.y * Math.cos(phi) * sinTheta + _bitangent.y * Math.sin(phi) * sinTheta + n.y * cosTheta;
            const dz = _tangent.z * Math.cos(phi) * sinTheta + _bitangent.z * Math.sin(phi) * sinTheta + n.z * cosTheta;

            const speed = cfg.speedMin + Math.random() * (cfg.speedMax - cfg.speedMin);
            data.velocities[i3]     = dx * speed;
            data.velocities[i3 + 1] = dy * speed;
            data.velocities[i3 + 2] = dz * speed;

            // Life
            data.lives[idx] = cfg.life;
            data.maxLives[idx] = cfg.life;

            // Size + opacity
            data.particleSizes[idx] = cfg.sizeMin + Math.random() * (cfg.sizeMax - cfg.sizeMin);
            data.opacities[idx] = 1.0;

            // Color — pick random from palette
            const col = cfg.colors[Math.floor(Math.random() * cfg.colors.length)];
            data.colors[i3]     = col.r;
            data.colors[i3 + 1] = col.g;
            data.colors[i3 + 2] = col.b;
        }

        data.geo.attributes.position.needsUpdate = true;
        data.geo.attributes.color.needsUpdate = true;
        data.geo.attributes.aSize.needsUpdate = true;
        data.geo.attributes.aOpacity.needsUpdate = true;
    }

    update(dt) {
        // Point particles
        for (const data of this._typeValues) {
            const { cfg, positions, velocities, lives, maxLives, particleSizes, opacities, geo } = data;
            let anyAlive = false;

            for (let idx = 0; idx < POOL_SIZE; idx++) {
                if (lives[idx] <= 0) continue;

                anyAlive = true;
                lives[idx] -= dt;
                const i3 = idx * 3;

                // Apply gravity
                velocities[i3 + 1] -= cfg.gravity * dt;

                // Integrate position
                positions[i3]     += velocities[i3] * dt;
                positions[i3 + 1] += velocities[i3 + 1] * dt;
                positions[i3 + 2] += velocities[i3 + 2] * dt;

                if (lives[idx] <= 0) {
                    // Kill: hide below scene, zero size & opacity
                    lives[idx] = 0;
                    positions[i3 + 1] = DEAD_Y;
                    particleSizes[idx] = 0;
                    opacities[idx] = 0;
                } else {
                    // Fade opacity over lifetime
                    const t = lives[idx] / maxLives[idx];
                    opacities[idx] = t;
                }
            }

            if (anyAlive) {
                geo.attributes.position.needsUpdate = true;
                geo.attributes.aSize.needsUpdate = true;
                geo.attributes.aOpacity.needsUpdate = true;
            }
        }

        // 3D smoke spheres + spikes (InstancedMesh)
        this._updateSmokeSpheres(dt);
        this._updateSpikes(dt);
    }
}
