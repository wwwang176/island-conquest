import * as THREE from 'three';

/**
 * Object-pooled impact particle system.
 * Three particle types: dirt, water, spark — each rendered as a single THREE.Points
 * with a custom ShaderMaterial for per-particle size and opacity.
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
        count: 10,
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

export class ImpactVFX {
    constructor(scene) {
        this.scene = scene;
        this.types = {};

        for (const [name, cfg] of Object.entries(PARTICLE_TYPES)) {
            const data = this._createPool(cfg);
            this.types[name] = { cfg, ...data };
        }
    }

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
     * @param {'dirt'|'water'|'spark'} type
     * @param {THREE.Vector3} position - hit point
     * @param {THREE.Vector3} [normal] - surface normal (defaults to up)
     */
    spawn(type, position, normal) {
        const data = this.types[type];
        if (!data) return;

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
        for (const data of Object.values(this.types)) {
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
    }
}
