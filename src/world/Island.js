import * as THREE from 'three';
import * as CANNON from 'cannon-es';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { Noise } from './Noise.js';
import { NavGrid } from '../ai/NavGrid.js';

/**
 * Procedural tropical island generator.
 * Creates terrain, water, vegetation, and cover objects.
 */
export class Island {
    constructor(scene, physicsWorld, coverSystem, seed) {
        this.scene = scene;
        this.physics = physicsWorld;
        this.coverSystem = coverSystem;
        this.noise = new Noise(seed);

        // Island dimensions
        this.width = 300;
        this.depth = 120;
        this.segW = 150;    // terrain mesh resolution
        this.segD = 60;
        this.maxHeight = 9;

        // Store height data for physics and spawning
        this.heightData = [];

        // All generated meshes for raycasting
        this.collidables = [];

        // Obstacle descriptors for Worker-based NavGrid building
        this._obstacleDescs = [];

        // Per-obstacle bounding boxes for ThreatMap height grid
        this.obstacleBounds = [];

        this._generateTerrain();
        this._generateWater();
        this._generateCovers();
        this._generateVegetation();
    }

    /**
     * Get terrain height at world position (x, z).
     */
    getHeightAt(x, z) {
        // Map world coords to 0~1
        const u = (x + this.width / 2) / this.width;
        const v = (z + this.depth / 2) / this.depth;

        if (u < 0 || u > 1 || v < 0 || v > 1) return -5; // off island = underwater

        const col = Math.min(Math.floor(u * this.segW), this.segW - 1);
        const row = Math.min(Math.floor(v * this.segD), this.segD - 1);

        // Bilinear interpolation
        const col2 = Math.min(col + 1, this.segW);
        const row2 = Math.min(row + 1, this.segD);
        const fx = u * this.segW - col;
        const fy = v * this.segD - row;

        const h00 = this.heightData[row * (this.segW + 1) + col] || 0;
        const h10 = this.heightData[row * (this.segW + 1) + col2] || 0;
        const h01 = this.heightData[row2 * (this.segW + 1) + col] || 0;
        const h11 = this.heightData[row2 * (this.segW + 1) + col2] || 0;

        return h00 * (1 - fx) * (1 - fy) + h10 * fx * (1 - fy) +
               h01 * (1 - fx) * fy + h11 * fx * fy;
    }

    _generateTerrain() {
        const geo = new THREE.PlaneGeometry(this.width, this.depth, this.segW, this.segD);
        geo.rotateX(-Math.PI / 2);

        const positions = geo.attributes.position;
        this.heightData = new Float32Array(positions.count);

        for (let i = 0; i < positions.count; i++) {
            const x = positions.getX(i);
            const z = positions.getZ(i);
            const h = this._calcHeight(x, z);
            positions.setY(i, h);
            this.heightData[i] = h;
        }

        geo.computeVertexNormals();

        // Color vertices based on height
        const colors = new Float32Array(positions.count * 3);
        for (let i = 0; i < positions.count; i++) {
            const h = positions.getY(i);
            const color = this._getTerrainColor(h);
            colors[i * 3] = color.r;
            colors[i * 3 + 1] = color.g;
            colors[i * 3 + 2] = color.b;
        }
        geo.setAttribute('color', new THREE.BufferAttribute(colors, 3));

        const mat = new THREE.MeshLambertMaterial({
            vertexColors: true,
            flatShading: true,
        });

        this.terrainMesh = new THREE.Mesh(geo, mat);
        this.terrainMesh.receiveShadow = true;
        this.terrainMesh.castShadow = true;
        this.terrainMesh.userData.surfaceType = 'terrain';
        this.scene.add(this.terrainMesh);
        this.collidables.push(this.terrainMesh);

        // Physics: use heightfield
        this._createTerrainPhysics();
    }

    _calcHeight(x, z) {
        // Normalize to 0~1 range
        const nx = x / this.width;
        const nz = z / this.depth;

        // Island mask: ellipse falloff so edges go underwater
        const ex = (x / (this.width * 0.45));
        const ez = (z / (this.depth * 0.40));
        const distFromCenter = ex * ex + ez * ez;
        const islandMask = Math.max(0, 1 - distFromCenter);
        const smoothMask = islandMask * islandMask * (3 - 2 * islandMask); // smoothstep

        // Base terrain noise
        const base = this.noise.fbm(nx * 3, nz * 3, 4, 2, 0.5);

        // Ridge in the center (higher elevation)
        const centerRidge = Math.exp(-ez * ez * 2) * 0.4;

        // Detail noise
        const detail = this.noise.fbm(nx * 8 + 100, nz * 8 + 100, 3, 2, 0.4) * 0.3;

        const rawHeight = (base + centerRidge + detail) * this.maxHeight;
        const height = rawHeight * smoothMask;

        // Flatten below sea level
        return height < 0.3 ? height - 1 : height;
    }

    _getTerrainColor(h) {
        if (h < 0) return new THREE.Color(0.76, 0.70, 0.50);           // underwater sand
        if (h < 0.5) return new THREE.Color(0.85, 0.80, 0.60);         // beach
        if (h < 1) return new THREE.Color(0.55, 0.75, 0.35);           // grass
        if (h < 3) return new THREE.Color(0.35, 0.60, 0.25);           // dense grass
        if (h < 5) return new THREE.Color(0.30, 0.50, 0.22);           // forest
        if (h < 7) return new THREE.Color(0.45, 0.42, 0.35);           // rocky
        return new THREE.Color(0.55, 0.52, 0.48);                       // peak rock
    }

    _createTerrainPhysics() {
        // cannon-es Heightfield: data[xi][yi], grid in local XY plane, heights along local Z.
        // Rotation -PI/2 around X maps: local X → world X, local Y → world -Z, local Z → world Y.
        //
        // Three.js PlaneGeometry vertex (col, row):
        //   world X = -width/2 + col * 2
        //   world Z = -depth/2 + row * 2
        //
        // Cannon heightfield after rotation at (xi, yi):
        //   world X = xi * elemSize + posX
        //   world Z = -(yi * elemSize) + posZ
        //
        // Matching: xi = col, posX = -width/2
        //   -(yi * 2) + posZ = -depth/2 + row * 2
        //   With posZ = depth/2: yi = segD - row  (Z index must be reversed!)

        const matrix = [];
        for (let xi = 0; xi <= this.segW; xi++) {
            const row = [];
            for (let yi = 0; yi <= this.segD; yi++) {
                const threeRow = this.segD - yi;  // reverse Z index
                row.push(this.heightData[threeRow * (this.segW + 1) + xi]);
            }
            matrix.push(row);
        }

        const hfShape = new CANNON.Heightfield(matrix, {
            elementSize: this.depth / this.segD,
        });

        const hfBody = new CANNON.Body({
            mass: 0,
            material: this.physics.defaultMaterial,
        });
        hfBody.addShape(hfShape);

        // Rotate so local Z (heights) → world Y (up)
        hfBody.quaternion.setFromAxisAngle(new CANNON.Vec3(1, 0, 0), -Math.PI / 2);

        // Position: align grid origin with Three.js mesh corner
        hfBody.position.set(
            -this.width / 2,
            0,
            this.depth / 2
        );

        this.physics.addBody(hfBody);
        this.terrainBody = hfBody;
    }

    /**
     * Build navigation grid asynchronously using a Web Worker.
     * Returns a Promise that resolves to the NavGrid.
     */
    buildNavGridAsync() {
        const navCols = this.segW * 4;  // 600
        const navRows = this.segD * 4;  // 240

        return new Promise((resolve) => {
            const worker = new Worker(
                new URL('../workers/navgrid-worker.js', import.meta.url),
                { type: 'module' }
            );

            // Copy heightData — original stays on main thread for getHeightAt()
            const heightDataCopy = new Float32Array(this.heightData);

            // Collect transferables: copied heightData + deform arrays
            const transferables = [heightDataCopy.buffer];
            for (const desc of this._obstacleDescs) {
                if (desc.deform) transferables.push(desc.deform.buffer);
            }

            worker.postMessage({
                obstacles: this._obstacleDescs,
                heightData: heightDataCopy,
                width: this.width,
                depth: this.depth,
                segW: this.segW,
                segD: this.segD,
                navCols,
                navRows,
            }, transferables);

            worker.onmessage = (e) => {
                const { grid, heightGrid } = e.data;

                const navGrid = new NavGrid(this.width, this.depth, navCols, navRows);
                navGrid.grid = grid;
                navGrid._buildProxCost();
                this.navGrid = navGrid;

                worker.terminate();
                resolve({ navGrid, heightGrid });
            };
        });
    }

    /**
     * Synchronous fallback — build navigation grid on main thread.
     */
    buildNavGrid() {
        this.scene.updateMatrixWorld(true);

        const navCols = this.segW * 4;
        const navRows = this.segD * 4;
        const navGrid = new NavGrid(this.width, this.depth, navCols, navRows);
        navGrid.build(
            (x, z) => this.getHeightAt(x, z),
            this.collidables
        );
        this.navGrid = navGrid;
        return navGrid;
    }

    _generateWater() {
        const waterGeo = new THREE.PlaneGeometry(this.width * 2, this.depth * 2);
        const waterMat = new THREE.MeshLambertMaterial({
            color: 0x1a8fcc,
            transparent: true,
            opacity: 0.7,
        });
        const water = new THREE.Mesh(waterGeo, waterMat);
        water.rotation.x = -Math.PI / 2;
        water.position.y = -0.3;
        water.userData.surfaceType = 'water';
        this.scene.add(water);
        this.collidables.push(water);
    }

    _generateCovers() {
        // Geometry collection arrays for batch merging
        this._rockGeos = [];
        this._crateGeos = [];
        this._sandbagGeos = [];
        this._wallGeos = [];

        // Place covers along the map, clustered around flag positions
        // Flag positions are at linear intervals along X axis
        const flagXPositions = this._getFlagXPositions();

        // Generate cover clusters near each flag area
        for (let fi = 0; fi < flagXPositions.length; fi++) {
            const fx = flagXPositions[fi];
            this._placeCoverCluster(fx, 0, 14 + Math.floor(this.noise.noise2D(fx * 0.1, fi) * 4 + 4));
        }

        // Additional covers between flags
        for (let fi = 0; fi < flagXPositions.length - 1; fi++) {
            const midX = (flagXPositions[fi] + flagXPositions[fi + 1]) / 2;
            this._placeCoverCluster(midX, 0, 10 + Math.floor(this.noise.noise2D(midX * 0.1, 50) * 4));
            // Extra clusters offset in Z for wider coverage
            this._placeCoverCluster(midX, 15, 5 + Math.floor(this.noise.noise2D(midX * 0.1, 70) * 3));
            this._placeCoverCluster(midX, -15, 5 + Math.floor(this.noise.noise2D(midX * 0.1, 90) * 3));
        }

        // Scatter some random covers across the map
        for (let i = 0; i < 55; i++) {
            const rx = (this.noise.noise2D(i * 7.3, 200) * 0.8) * this.width / 2;
            const rz = (this.noise.noise2D(i * 3.7, 300) * 0.8) * this.depth / 2;
            const h = this.getHeightAt(rx, rz);
            if (h > 0.5) {
                this._placeRock(rx, h, rz);
            }
        }

        // Merge all obstacle geometries into one mesh per type
        this._mergeObstacles();
    }

    _getFlagXPositions() {
        const spacing = this.width * 0.7 / 4; // 5 flags across 70% of map width
        const startX = -this.width * 0.35;
        return Array.from({ length: 5 }, (_, i) => startX + i * spacing);
    }

    getFlagPositions() {
        return this._getFlagXPositions().map(fx => {
            // Find a suitable Z near center, on land
            let bestZ = 0;
            let bestH = -Infinity;
            for (let z = -10; z <= 10; z += 2) {
                const h = this.getHeightAt(fx, z);
                if (h > bestH && h > 0.5) {
                    bestH = h;
                    bestZ = z;
                }
            }
            return new THREE.Vector3(fx, Math.max(bestH, 1), bestZ);
        });
    }

    _placeCoverCluster(cx, cz, count) {
        for (let i = 0; i < count; i++) {
            const angle = this.noise.noise2D(cx + i * 13, cz + i * 7) * Math.PI * 2;
            const radius = 5 + Math.abs(this.noise.noise2D(cx + i * 5, cz + i * 11)) * 15;
            const x = cx + Math.cos(angle) * radius;
            const z = cz + Math.sin(angle) * radius;
            const h = this.getHeightAt(x, z);

            if (h < 0.5) continue; // skip underwater

            const r = Math.abs(this.noise.noise2D(x * 0.5, z * 0.5));
            if (r < 0.35) {
                this._placeRock(x, h, z);
            } else if (r < 0.6) {
                this._placeCrate(x, h, z);
            } else if (r < 0.8) {
                this._placeSandbag(x, h, z);
            } else {
                this._placeWall(x, h, z);
            }
        }
    }

    _placeRock(x, h, z) {
        const scale = 1 + Math.abs(this.noise.noise2D(x, z)) * 2;
        const geo = new THREE.DodecahedronGeometry(scale, 0);

        // Deform vertices for organic look — also capture multipliers for Worker
        const pos = geo.attributes.position;
        const deform = new Float32Array(pos.count * 3);
        for (let i = 0; i < pos.count; i++) {
            const vx = pos.getX(i);
            const vy = pos.getY(i);
            const vz = pos.getZ(i);
            const noise = this.noise.noise2D(vx * 2 + x, vz * 2 + z) * 0.3;
            const mx = 1 + noise;
            const my = 0.6 + Math.abs(noise);
            const mz = 1 + noise;
            pos.setX(i, vx * mx);
            pos.setY(i, vy * my);
            pos.setZ(i, vz * mz);
            deform[i * 3] = mx;
            deform[i * 3 + 1] = my;
            deform[i * 3 + 2] = mz;
        }

        const rotY = this.noise.noise2D(x * 3, z * 3) * Math.PI;

        // Bake world transform into geometry
        const mat4 = new THREE.Matrix4();
        mat4.compose(
            new THREE.Vector3(x, h + scale * 0.3, z),
            new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), rotY),
            new THREE.Vector3(1, 1, 1)
        );
        geo.applyMatrix4(mat4);
        geo.computeVertexNormals();
        geo.computeBoundingBox();
        this.obstacleBounds.push(geo.boundingBox.clone());
        this._rockGeos.push(geo);

        this._obstacleDescs.push({
            type: 'rock', x, y: h + scale * 0.3, z, scale, rotY, deform
        });

        // Physics
        const body = new CANNON.Body({ mass: 0, material: this.physics.defaultMaterial });
        body.addShape(new CANNON.Sphere(scale * 0.7));
        body.position.set(x, h + scale * 0.3, z);
        this.physics.addBody(body);

        // Register cover
        const normal = new THREE.Vector3(
            this.noise.noise2D(x * 5, z * 5),
            0,
            this.noise.noise2D(z * 5, x * 5)
        ).normalize();
        this.coverSystem.register(
            new THREE.Vector3(x, h, z),
            normal,
            1.0,    // full cover (rock)
            2
        );
    }

    _placeCrate(x, h, z) {
        const size = 0.8 + Math.abs(this.noise.noise2D(x * 2, z * 2)) * 0.6;
        const w = size * 1.2, ch = size, d = size;
        const geo = new THREE.BoxGeometry(w, ch, d);
        const rotY = this.noise.noise2D(x, z) * Math.PI;

        // Bake world transform into geometry
        const mat4 = new THREE.Matrix4();
        mat4.compose(
            new THREE.Vector3(x, h + size / 2, z),
            new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), rotY),
            new THREE.Vector3(1, 1, 1)
        );
        geo.applyMatrix4(mat4);
        geo.computeBoundingBox();
        this.obstacleBounds.push(geo.boundingBox.clone());
        this._crateGeos.push(geo);

        this._obstacleDescs.push({
            type: 'box', x, y: h + size / 2, z, w, h: ch, d, rotY
        });

        // Physics
        const body = new CANNON.Body({ mass: 0, material: this.physics.defaultMaterial });
        body.addShape(new CANNON.Box(new CANNON.Vec3(size * 0.6, size / 2, size / 2)));
        body.position.set(x, h + size / 2, z);
        body.quaternion.setFromAxisAngle(new CANNON.Vec3(0, 1, 0), rotY);
        this.physics.addBody(body);

        // Register cover (half cover)
        this.coverSystem.register(
            new THREE.Vector3(x, h, z),
            new THREE.Vector3(Math.cos(rotY), 0, Math.sin(rotY)),
            0.5,
            1
        );
    }

    _placeSandbag(x, h, z) {
        const geo = new THREE.BoxGeometry(2.5, 0.8, 0.6);
        const rotY = this.noise.noise2D(x * 2, z * 2) * Math.PI;

        // Bake world transform into geometry
        const mat4 = new THREE.Matrix4();
        mat4.compose(
            new THREE.Vector3(x, h + 0.4, z),
            new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), rotY),
            new THREE.Vector3(1, 1, 1)
        );
        geo.applyMatrix4(mat4);
        geo.computeBoundingBox();
        this.obstacleBounds.push(geo.boundingBox.clone());
        this._sandbagGeos.push(geo);

        this._obstacleDescs.push({
            type: 'box', x, y: h + 0.4, z, w: 2.5, h: 0.8, d: 0.6, rotY
        });

        // Physics
        const body = new CANNON.Body({ mass: 0, material: this.physics.defaultMaterial });
        body.addShape(new CANNON.Box(new CANNON.Vec3(1.25, 0.4, 0.3)));
        body.position.set(x, h + 0.4, z);
        body.quaternion.setFromAxisAngle(new CANNON.Vec3(0, 1, 0), rotY);
        this.physics.addBody(body);

        // Register cover (half cover)
        this.coverSystem.register(
            new THREE.Vector3(x, h, z),
            new THREE.Vector3(Math.cos(rotY + Math.PI / 2), 0, Math.sin(rotY + Math.PI / 2)),
            0.5,
            2
        );
    }

    _placeWall(x, h, z) {
        const wallH = 2.5 + Math.abs(this.noise.noise2D(x, z)) * 1.5;
        const wallW = 3 + Math.abs(this.noise.noise2D(x * 3, z * 3)) * 2;
        const geo = new THREE.BoxGeometry(wallW, wallH, 0.4);
        const rotY = this.noise.noise2D(x * 4, z * 4) * Math.PI;

        // Bake world transform into geometry
        const mat4 = new THREE.Matrix4();
        mat4.compose(
            new THREE.Vector3(x, h + wallH / 2, z),
            new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), rotY),
            new THREE.Vector3(1, 1, 1)
        );
        geo.applyMatrix4(mat4);
        geo.computeBoundingBox();
        this.obstacleBounds.push(geo.boundingBox.clone());
        this._wallGeos.push(geo);

        this._obstacleDescs.push({
            type: 'box', x, y: h + wallH / 2, z, w: wallW, h: wallH, d: 0.4, rotY
        });

        // Physics
        const body = new CANNON.Body({ mass: 0, material: this.physics.defaultMaterial });
        body.addShape(new CANNON.Box(new CANNON.Vec3(wallW / 2, wallH / 2, 0.2)));
        body.position.set(x, h + wallH / 2, z);
        body.quaternion.setFromAxisAngle(new CANNON.Vec3(0, 1, 0), rotY);
        this.physics.addBody(body);

        // Register cover on both sides of wall (full cover)
        const nx = Math.cos(rotY + Math.PI / 2);
        const nz = Math.sin(rotY + Math.PI / 2);
        this.coverSystem.register(new THREE.Vector3(x + nx, h, z + nz), new THREE.Vector3(nx, 0, nz), 1.0, 2);
        this.coverSystem.register(new THREE.Vector3(x - nx, h, z - nz), new THREE.Vector3(-nx, 0, -nz), 1.0, 2);
    }

    _mergeObstacles() {
        const configs = [
            { geos: this._rockGeos, color: 0x777777, surface: 'rock', shadow: true },
            { geos: this._crateGeos, color: 0x8B6914, surface: 'wood', shadow: true },
            { geos: this._sandbagGeos, color: 0xA08050, surface: 'dirt', shadow: true },
            { geos: this._wallGeos, color: 0x999088, surface: 'rock', shadow: true },
        ];
        for (const cfg of configs) {
            if (cfg.geos.length === 0) continue;
            const merged = mergeGeometries(cfg.geos);
            for (const g of cfg.geos) g.dispose();
            const mesh = new THREE.Mesh(
                merged,
                new THREE.MeshLambertMaterial({ color: cfg.color, flatShading: true })
            );
            mesh.castShadow = cfg.shadow;
            mesh.receiveShadow = cfg.shadow;
            mesh.userData.surfaceType = cfg.surface;
            this.scene.add(mesh);
            this.collidables.push(mesh);
        }
        // Free temporary arrays
        this._rockGeos = null;
        this._crateGeos = null;
        this._sandbagGeos = null;
        this._wallGeos = null;
    }

    _generateVegetation() {
        // Palm trees — merge all into 2 draw calls (trunks + fronds)
        const trunkGeometries = [];
        const frondGeometries = [];
        for (let i = 0; i < 80; i++) {
            const x = (this.noise.noise2D(i * 5.1, 500) * 0.85) * this.width / 2;
            const z = (this.noise.noise2D(i * 3.3, 600) * 0.85) * this.depth / 2;
            const h = this.getHeightAt(x, z);

            if (h > 0.5 && h < 5) {
                // Trunk (tapered cylinder, slightly curved via segments)
                const trunkH = 4 + Math.abs(this.noise.noise2D(x, z)) * 3;
                const trunkGeo = new THREE.CylinderGeometry(0.08, 0.18, trunkH, 5, 4);
                const trunkPos = trunkGeo.attributes.position;
                const bendX = this.noise.noise2D(x * 10, z * 10) * 0.8;
                const bendZ = this.noise.noise2D(z * 10, x * 10) * 0.8;
                for (let j = 0; j < trunkPos.count; j++) {
                    const ty = (trunkPos.getY(j) + trunkH / 2) / trunkH;
                    trunkPos.setX(j, trunkPos.getX(j) + bendX * ty * ty);
                    trunkPos.setZ(j, trunkPos.getZ(j) + bendZ * ty * ty);
                }
                trunkGeo.translate(x, h + trunkH / 2, z);
                trunkGeo.computeVertexNormals();
                trunkGeometries.push(trunkGeo);

                // Palm fronds (6 per tree)
                const topX = bendX;
                const topZ = bendZ;
                for (let f = 0; f < 6; f++) {
                    const angle = (f / 6) * Math.PI * 2 + this.noise.noise2D(x + f, z + f);
                    const frondGeo = new THREE.BufferGeometry();
                    const len = 2 + Math.random();
                    const vertices = new Float32Array([
                        0, 0, 0,
                        Math.cos(angle) * len, -0.5, Math.sin(angle) * len,
                        Math.cos(angle + 0.3) * len * 0.7, 0.1, Math.sin(angle + 0.3) * len * 0.7,
                        Math.cos(angle - 0.3) * len * 0.7, 0.1, Math.sin(angle - 0.3) * len * 0.7,
                    ]);
                    const indices = [0, 1, 2, 0, 3, 1];
                    frondGeo.setAttribute('position', new THREE.BufferAttribute(vertices, 3));
                    frondGeo.setIndex(indices);
                    frondGeo.translate(x + topX, h + trunkH, z + topZ);
                    frondGeo.computeVertexNormals();
                    frondGeometries.push(frondGeo);
                }

                this.coverSystem.register(
                    new THREE.Vector3(x, h, z),
                    new THREE.Vector3(0, 0, 1),
                    0.2,
                    1
                );
            }
        }

        if (trunkGeometries.length > 0) {
            const mergedTrunks = mergeGeometries(trunkGeometries);
            const trunkMesh = new THREE.Mesh(mergedTrunks, new THREE.MeshLambertMaterial({ color: 0x8B6508, flatShading: true }));
            trunkMesh.castShadow = false;
            this.scene.add(trunkMesh);

            const mergedFronds = mergeGeometries(frondGeometries);
            const frondMesh = new THREE.Mesh(mergedFronds, new THREE.MeshLambertMaterial({ color: 0x2d8a2d, side: THREE.DoubleSide, flatShading: true }));
            frondMesh.castShadow = false;
            this.scene.add(frondMesh);
        }

        // Low bushes/grass clumps — collect valid positions, then use InstancedMesh
        const bushPositions = [];
        for (let i = 0; i < 100; i++) {
            const x = (this.noise.noise2D(i * 4.7, 700) * 0.85) * this.width / 2;
            const z = (this.noise.noise2D(i * 6.1, 800) * 0.85) * this.depth / 2;
            const h = this.getHeightAt(x, z);

            if (h > 0.5 && h < 6) {
                const size = 0.4 + Math.abs(this.noise.noise2D(x * 3, z * 3)) * 0.6;
                bushPositions.push({ x, y: h + size * 0.5, z, size });
            }
        }

        if (bushPositions.length > 0) {
            const bushGeo = new THREE.IcosahedronGeometry(1, 0);
            const bushMat = new THREE.MeshLambertMaterial({ color: 0x3a7a2a, flatShading: true });
            const bushMesh = new THREE.InstancedMesh(bushGeo, bushMat, bushPositions.length);
            bushMesh.castShadow = false;
            const _mat4 = new THREE.Matrix4();
            const _pos = new THREE.Vector3();
            const _quat = new THREE.Quaternion();
            const _scale = new THREE.Vector3();
            for (let i = 0; i < bushPositions.length; i++) {
                const bp = bushPositions[i];
                _pos.set(bp.x, bp.y, bp.z);
                _scale.set(bp.size, bp.size * 0.6, bp.size);
                _mat4.compose(_pos, _quat, _scale);
                bushMesh.setMatrixAt(i, _mat4);
            }
            this.scene.add(bushMesh);
        }
    }

}
