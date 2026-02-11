import * as THREE from 'three';

/**
 * Spatial threat evaluation grid.
 * Same resolution as NavGrid (300×120, 1m cells) for accurate LOS shadow casting.
 * Heavy computation (Bresenham LOS for every cell) runs in a Web Worker.
 */
export class ThreatMap {
    constructor(width = 300, depth = 120, cols = 300, rows = 120) {
        this.width = width;
        this.depth = depth;
        this.cols = cols;
        this.rows = rows;
        this.cellSize = width / cols;   // 1
        this.originX = -width / 2;      // -150
        this.originZ = -depth / 2;      // -60

        this.threat = new Float32Array(cols * rows);

        /** @type {import('./NavGrid.js').NavGrid|null} */
        this.navGrid = null;

        // Pre-computed terrain + obstacle height per cell (built once at startup)
        this.heightGrid = new Float32Array(cols * rows);

        // Update throttle
        this._timer = 0.3;
        this._interval = 0.3; // seconds

        // Worker state
        this._worker = null;
        this._workerBusy = false;

        // Visualization
        this._visMesh = null;
        this._visTexture = null;
        this._visData = null;
    }

    /**
     * Pre-compute heights for every cell. Stores max(terrain, obstacle top)
     * so LOS checks account for cover objects like rocks and walls.
     * Uses bounding boxes instead of raycasting for speed.
     * After building, initializes the worker with the height data.
     */
    buildHeightGrid(getHeightAt, collidables) {
        const { cols, rows, cellSize, originX, originZ, heightGrid } = this;

        // 1) Fill with terrain heights
        for (let r = 0; r < rows; r++) {
            for (let c = 0; c < cols; c++) {
                const wx = originX + c * cellSize + cellSize / 2;
                const wz = originZ + r * cellSize + cellSize / 2;
                heightGrid[r * cols + c] = getHeightAt(wx, wz);
            }
        }

        // 2) Stamp obstacle bounding boxes onto the grid
        //    Skip terrain and water — they span the entire map and would
        //    overwrite all cells with their peak height.
        if (collidables && collidables.length > 0) {
            const box = new THREE.Box3();
            const skipTypes = new Set(['terrain', 'water']);
            const collectMeshes = (obj) => {
                if (obj.isMesh && obj.geometry) meshes.push(obj);
                if (obj.children) for (const child of obj.children) collectMeshes(child);
            };
            const meshes = [];
            for (const obj of collidables) {
                const st = obj.userData && obj.userData.surfaceType;
                if (st && skipTypes.has(st)) continue;
                collectMeshes(obj);
            }

            for (const mesh of meshes) {
                box.setFromObject(mesh);
                const topY = box.max.y;

                const minCol = Math.max(0, Math.floor((box.min.x - originX) / cellSize));
                const maxCol = Math.min(cols - 1, Math.floor((box.max.x - originX) / cellSize));
                const minRow = Math.max(0, Math.floor((box.min.z - originZ) / cellSize));
                const maxRow = Math.min(rows - 1, Math.floor((box.max.z - originZ) / cellSize));

                for (let r = minRow; r <= maxRow; r++) {
                    for (let c = minCol; c <= maxCol; c++) {
                        const idx = r * cols + c;
                        if (topY > heightGrid[idx]) {
                            heightGrid[idx] = topY;
                        }
                    }
                }
            }
        }

        // 3) Initialize worker with height data
        this._initWorker();
    }

    _initWorker() {
        this._worker = new Worker(
            new URL('../workers/threat-worker.js', import.meta.url),
            { type: 'module' }
        );

        this._worker.postMessage({
            type: 'init',
            cols: this.cols,
            rows: this.rows,
            cellSize: this.cellSize,
            originX: this.originX,
            originZ: this.originZ,
            heightGrid: this.heightGrid,
        });

        this._worker.onmessage = (e) => {
            if (e.data.type === 'result') {
                this.threat.set(e.data.threat);
                this._workerBusy = false;

                // Refresh visualization texture
                if (this._visMesh && this._visMesh.visible) {
                    this._updateVisTexture();
                }
            }
        };
    }

    // ───── Core ─────

    update(dt, enemies) {
        this._timer += dt;
        if (this._timer < this._interval) return;
        if (this._workerBusy) return; // skip if worker still computing
        if (!this._worker) return;
        this._timer = 0;

        // Extract enemy positions (plain data for worker)
        const enemyData = [];
        for (const enemy of enemies) {
            if (!enemy.alive) continue;
            const pos = enemy.getPosition();
            enemyData.push({ x: pos.x, z: pos.z });
        }

        this._workerBusy = true;
        this._worker.postMessage({ type: 'update', enemies: enemyData });
    }

    /**
     * Find the safest walkable position near `nearPos` within `radius` (world units).
     * Requires minimum distance of ~4m so COM actually moves to safety.
     * Returns THREE.Vector3 or null.
     */
    findSafePosition(nearPos, radius = 20) {
        if (!this.navGrid) return null;

        const center = this._worldToGrid(nearPos.x, nearPos.z);
        const cellRadius = Math.ceil(radius / this.cellSize); // 20 cells for 20m
        const minCellDist2 = 64; // at least 8 cells away (~8m) squared
        const { cols, rows, threat } = this;
        const cellRadius2 = cellRadius * cellRadius;

        let bestScore = Infinity;
        let bestCol = -1, bestRow = -1;

        const minCol = Math.max(0, center.col - cellRadius);
        const maxCol = Math.min(cols - 1, center.col + cellRadius);
        const minRow = Math.max(0, center.row - cellRadius);
        const maxRow = Math.min(rows - 1, center.row + cellRadius);

        for (let r = minRow; r <= maxRow; r++) {
            for (let c = minCol; c <= maxCol; c++) {
                const dc = c - center.col;
                const dr = r - center.row;
                const dist2 = dc * dc + dr * dr;

                // Skip cells too close (COM must move) or too far
                if (dist2 < minCellDist2) continue;
                if (dist2 > cellRadius2) continue;

                // Must be walkable — use NavGrid directly (same grid coords)
                if (!this.navGrid.isWalkable(c, r)) continue;

                const dist = Math.sqrt(dist2) * this.cellSize; // world dist
                // Threat is primary factor; distance is secondary tiebreaker
                const score = threat[r * cols + c] * 10 + dist * 0.05;
                if (score < bestScore) {
                    bestScore = score;
                    bestCol = c;
                    bestRow = r;
                }
            }
        }

        if (bestCol < 0) return null;

        const wx = this.originX + bestCol * this.cellSize + this.cellSize / 2;
        const wz = this.originZ + bestRow * this.cellSize + this.cellSize / 2;
        return new THREE.Vector3(wx, 0, wz);
    }

    /**
     * Get threat value at world coordinates.
     */
    getThreat(wx, wz) {
        const g = this._worldToGrid(wx, wz);
        return this.threat[g.row * this.cols + g.col];
    }

    // ───── Visualization ─────

    createVisualization(scene) {
        const { cols, rows, cellSize, originX, originZ, heightGrid } = this;
        this._visData = new Uint8Array(cols * rows * 4); // RGBA
        this._visTexture = new THREE.DataTexture(
            this._visData, cols, rows, THREE.RGBAFormat
        );
        this._visTexture.minFilter = THREE.NearestFilter;
        this._visTexture.magFilter = THREE.NearestFilter;
        this._visTexture.needsUpdate = true;

        // Create terrain-conforming geometry at reduced resolution for performance.
        // Visualization mesh uses fewer segments; DataTexture handles the detail.
        const visCols = Math.min(cols, 150);
        const visRows = Math.min(rows, 60);
        const segW = visCols - 1;
        const segH = visRows - 1;
        const geo = new THREE.PlaneGeometry(this.width, this.depth, segW, segH);
        const pos = geo.attributes.position;

        // Remap vertices from XY plane to XZ plane following terrain height.
        // PlaneGeometry iy=0 is top (UV v=1) → maps to grid row rows-1 (north).
        for (let iy = 0; iy <= segH; iy++) {
            for (let ix = 0; ix <= segW; ix++) {
                const i = iy * (segW + 1) + ix;
                // Map vis-grid coords to full-grid coords
                const c = Math.min(Math.round(ix * (cols - 1) / segW), cols - 1);
                const r = rows - 1 - Math.min(Math.round(iy * (rows - 1) / segH), rows - 1);

                const wx = originX + c * cellSize + cellSize / 2;
                const wz = originZ + r * cellSize + cellSize / 2;
                const h = heightGrid[r * cols + c];

                pos.setXYZ(i, wx, h + 0.5, wz); // +0.5 to float above terrain
            }
        }
        pos.needsUpdate = true;
        geo.computeVertexNormals();

        const mat = new THREE.MeshBasicMaterial({
            map: this._visTexture,
            transparent: true,
            opacity: 0.6,
            depthWrite: false,
            side: THREE.DoubleSide,
        });
        this._visMesh = new THREE.Mesh(geo, mat);
        // No rotation or position offset — vertices are already in world space
        this._visMesh.visible = false;
        this._visMesh.renderOrder = 999;
        scene.add(this._visMesh);
    }

    toggleVisualization() {
        if (!this._visMesh) return;
        this._visMesh.visible = !this._visMesh.visible;
        if (this._visMesh.visible) this._updateVisTexture();
    }

    setVisible(v) {
        if (this._visMesh) this._visMesh.visible = v;
        if (v) this._updateVisTexture();
    }

    _updateVisTexture() {
        const { cols, rows, threat, _visData } = this;
        if (!_visData) return;

        for (let r = 0; r < rows; r++) {
            for (let c = 0; c < cols; c++) {
                const idx = r * cols + c;
                const px = idx * 4;
                const t = Math.min(1, threat[idx]);
                // Red (high threat) → Green (safe)
                _visData[px + 0] = Math.floor(t * 255);         // R
                _visData[px + 1] = Math.floor((1 - t) * 255);   // G
                _visData[px + 2] = 0;                            // B
                _visData[px + 3] = Math.floor((0.15 + t * 0.7) * 255); // A
            }
        }
        this._visTexture.needsUpdate = true;
    }

    // ───── Internal Helpers ─────

    _worldToGrid(wx, wz) {
        const col = Math.floor((wx - this.originX) / this.cellSize);
        const row = Math.floor((wz - this.originZ) / this.cellSize);
        return {
            col: Math.max(0, Math.min(col, this.cols - 1)),
            row: Math.max(0, Math.min(row, this.rows - 1)),
        };
    }
}
