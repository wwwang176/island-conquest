import * as THREE from 'three';

const EYE_HEIGHT = 1.5; // soldier eye height above ground

/**
 * Spatial threat evaluation grid.
 * Same resolution as NavGrid (300×120, 1m cells) for accurate LOS shadow casting.
 * Each cell stores a threat value based on enemy LOS and distance.
 * Cells behind obstacles OR terrain ridges (LOS blocked) are safe (shadow zones).
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

        // Pre-computed terrain height per cell (built once at startup)
        this.heightGrid = new Float32Array(cols * rows);

        // Update throttle — start at interval so first update is immediate
        this._timer = 0.5;
        this._interval = 0.5; // seconds

        // Visualization
        this._visMesh = null;
        this._visTexture = null;
        this._visData = null;
    }

    /**
     * Pre-compute terrain heights for every cell. Call once after terrain is ready.
     */
    buildHeightGrid(getHeightAt) {
        const { cols, rows, cellSize, originX, originZ, heightGrid } = this;
        for (let r = 0; r < rows; r++) {
            for (let c = 0; c < cols; c++) {
                const wx = originX + c * cellSize + cellSize / 2;
                const wz = originZ + r * cellSize + cellSize / 2;
                heightGrid[r * cols + c] = getHeightAt(wx, wz);
            }
        }
    }

    // ───── Core ─────

    update(dt, enemies) {
        this._timer += dt;
        if (this._timer < this._interval) return;
        this._timer = 0;

        const { cols, rows, threat, heightGrid } = this;
        threat.fill(0);

        for (const enemy of enemies) {
            if (!enemy.alive) continue;
            const ePos = enemy.getPosition();
            const eGrid = this._worldToGrid(ePos.x, ePos.z);
            // Enemy eye height = terrain height at their cell + EYE_HEIGHT
            const enemyEyeY = heightGrid[eGrid.row * cols + eGrid.col] + EYE_HEIGHT;

            // Scan radius 42 cells (~42 m at 1m/cell)
            const radius = 42;
            const radius2 = radius * radius;
            const minCol = Math.max(0, eGrid.col - radius);
            const maxCol = Math.min(cols - 1, eGrid.col + radius);
            const minRow = Math.max(0, eGrid.row - radius);
            const maxRow = Math.min(rows - 1, eGrid.row + radius);

            for (let r = minRow; r <= maxRow; r++) {
                for (let c = minCol; c <= maxCol; c++) {
                    const dc = c - eGrid.col;
                    const dr = r - eGrid.row;
                    const dist2 = dc * dc + dr * dr;
                    if (dist2 > radius2) continue;

                    // Combined LOS: obstacle blocking + terrain height blocking
                    if (!this._hasLOS(eGrid.col, eGrid.row, enemyEyeY, c, r)) continue;

                    const dist = Math.sqrt(dist2) * this.cellSize; // world distance
                    threat[r * cols + c] += 1 / (1 + dist * dist * 0.01);
                }
            }
        }

        // Refresh visualization texture
        if (this._visMesh && this._visMesh.visible) {
            this._updateVisTexture();
        }
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
        const minCellDist2 = 4; // at least 2 cells away (~4m) squared
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

    /**
     * Combined LOS check: obstacle blocking (NavGrid) + terrain height blocking.
     * Traces from enemy eye position to target cell eye position.
     * Returns true if the target cell is visible (has threat).
     */
    _hasLOS(c0, r0, enemyEyeY, c1, r1) {
        const { cols, heightGrid, navGrid } = this;

        // Target eye height
        const targetEyeY = heightGrid[r1 * cols + c1] + EYE_HEIGHT;

        // Bresenham walk
        let nc = c0, nr = r0;
        const dc = Math.abs(c1 - c0), dr = Math.abs(r1 - r0);
        const sc = c0 < c1 ? 1 : -1, sr = r0 < r1 ? 1 : -1;
        let err = dc - dr;

        // Total steps for interpolation
        const totalSteps = Math.max(dc, dr);
        let step = 0;

        while (true) {
            // Skip start cell (enemy position)
            if (!(nc === c0 && nr === r0)) {
                // 1) Obstacle check: NavGrid blocked cell blocks LOS
                if (navGrid && !navGrid.isWalkable(nc, nr)) return false;

                // 2) Terrain height check: interpolate expected LOS line height
                //    and compare with actual terrain + obstacle height at this cell
                if (totalSteps > 0) {
                    const t = step / totalSteps;
                    const expectedY = enemyEyeY + (targetEyeY - enemyEyeY) * t;
                    const terrainY = heightGrid[nr * cols + nc];
                    // Terrain blocks if it rises above the LOS line
                    if (terrainY > expectedY) return false;
                }
            }

            if (nc === c1 && nr === r1) return true;

            step++;
            const e2 = 2 * err;
            if (e2 > -dr) { err -= dr; nc += sc; }
            if (e2 < dc) { err += dc; nr += sr; }
        }
    }
}
