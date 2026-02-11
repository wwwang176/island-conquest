import * as THREE from 'three';

const EYE_HEIGHT = 1.5;
const FOV_DOT = -0.2; // 120° FOV — same as COM vision in AIController

/**
 * Fog-of-war / exploration map.
 * Same resolution as ThreatMap (300×120, 1m cells).
 * Tracks which cells have been recently observed by friendly units.
 *
 * Values: 0.0 = just seen (safe) → 1.0 = unexplored (uncertain).
 * Shared per team. Decays over time back to 1.0.
 */
export class FogMap {
    constructor(width = 300, depth = 120, cols = 300, rows = 120) {
        this.width = width;
        this.depth = depth;
        this.cols = cols;
        this.rows = rows;
        this.cellSize = width / cols;   // 1
        this.originX = -width / 2;      // -150
        this.originZ = -depth / 2;      // -60

        // Fog grid: 1.0 = fully unexplored, 0.0 = just observed
        this.fog = new Float32Array(cols * rows);
        this.fog.fill(1.0); // start fully unexplored

        /** @type {import('./NavGrid.js').NavGrid|null} */
        this.navGrid = null;

        // Shared heightGrid (set by AIManager, same as ThreatMap)
        this.heightGrid = null;

        // Update throttle
        this._timer = 0.5;  // start at interval for immediate first update
        this._interval = 0.5;

        // Decay rate: fog increases by this per second
        this._decayRate = 0.05; // 20s from 0→1

        // Vision radius (same as COM vision / ThreatMap)
        this._radius = 80;

        // Visualization
        this._visMesh = null;
        this._visTexture = null;
        this._visData = null;
    }

    /**
     * Initialize spawn area as explored.
     * Call after heightGrid is set.
     * @param {THREE.Vector3} spawnPos - team base flag position
     * @param {number} radius - explored radius in world units
     */
    initSpawnArea(spawnPos, radius = 30) {
        const center = this._worldToGrid(spawnPos.x, spawnPos.z);
        const cellRadius = Math.ceil(radius / this.cellSize);
        const cellRadius2 = cellRadius * cellRadius;
        const { cols, rows, fog } = this;

        for (let r = Math.max(0, center.row - cellRadius); r <= Math.min(rows - 1, center.row + cellRadius); r++) {
            for (let c = Math.max(0, center.col - cellRadius); c <= Math.min(cols - 1, center.col + cellRadius); c++) {
                const dc = c - center.col;
                const dr = r - center.row;
                if (dc * dc + dr * dr <= cellRadius2) {
                    fog[r * cols + c] = 0.0;
                }
            }
        }
    }

    // ───── Core ─────

    /**
     * @param {number} dt
     * @param {AIController[]} friendlyControllers - this team's controllers
     */
    update(dt, friendlyControllers) {
        this._timer += dt;
        if (this._timer < this._interval) return;
        this._timer = 0;

        const { cols, rows, fog, heightGrid, _radius, _decayRate, _interval } = this;
        if (!heightGrid) return;

        // 1) Decay: all cells drift toward 1.0
        const decayAmount = _decayRate * _interval;
        for (let i = 0, len = cols * rows; i < len; i++) {
            fog[i] = Math.min(1.0, fog[i] + decayAmount);
        }

        const radius2 = _radius * _radius;

        // 2) Each alive COM reveals cells within FOV + LOS
        for (const ctrl of friendlyControllers) {
            if (!ctrl.soldier.alive) continue;

            const pos = ctrl.soldier.getPosition();
            const grid = this._worldToGrid(pos.x, pos.z);
            const eyeY = heightGrid[grid.row * cols + grid.col] + EYE_HEIGHT;

            // Facing direction (2D normalized)
            const fdx = ctrl.facingDir.x;
            const fdz = ctrl.facingDir.z;
            const fdLen = Math.sqrt(fdx * fdx + fdz * fdz);
            const fnx = fdLen > 0.001 ? fdx / fdLen : 0;
            const fnz = fdLen > 0.001 ? fdz / fdLen : -1;

            const minCol = Math.max(0, grid.col - _radius);
            const maxCol = Math.min(cols - 1, grid.col + _radius);
            const minRow = Math.max(0, grid.row - _radius);
            const maxRow = Math.min(rows - 1, grid.row + _radius);

            for (let r = minRow; r <= maxRow; r++) {
                for (let c = minCol; c <= maxCol; c++) {
                    const dc = c - grid.col;
                    const dr = r - grid.row;
                    const dist2 = dc * dc + dr * dr;
                    if (dist2 > radius2) continue;

                    // FOV check: direction to cell vs facing direction
                    const len = Math.sqrt(dist2);
                    if (len > 0.5) { // skip own cell (always visible)
                        const dirC = dc / len;
                        const dirR = dr / len;
                        // Grid: col → X, row → Z
                        const dot = fnx * dirC + fnz * dirR;
                        if (dot < FOV_DOT) continue;
                    }

                    // LOS check
                    if (!this._hasLOS(grid.col, grid.row, eyeY, c, r)) continue;

                    fog[r * cols + c] = 0.0;
                }
            }
        }

        // Refresh visualization
        if (this._visMesh && this._visMesh.visible) {
            this._updateVisTexture();
        }
    }

    /**
     * Get fog value at world coordinates.
     * @returns {number} 0.0 (explored) to 1.0 (unexplored)
     */
    getFog(wx, wz) {
        const g = this._worldToGrid(wx, wz);
        return this.fog[g.row * this.cols + g.col];
    }

    // ───── Visualization ─────

    createVisualization(scene) {
        const { cols, rows, cellSize, originX, originZ, heightGrid } = this;
        if (!heightGrid) return;

        this._visData = new Uint8Array(cols * rows * 4);
        this._visTexture = new THREE.DataTexture(
            this._visData, cols, rows, THREE.RGBAFormat
        );
        this._visTexture.minFilter = THREE.NearestFilter;
        this._visTexture.magFilter = THREE.NearestFilter;
        this._visTexture.needsUpdate = true;

        const visCols = Math.min(cols, 150);
        const visRows = Math.min(rows, 60);
        const segW = visCols - 1;
        const segH = visRows - 1;
        const geo = new THREE.PlaneGeometry(this.width, this.depth, segW, segH);
        const pos = geo.attributes.position;

        for (let iy = 0; iy <= segH; iy++) {
            for (let ix = 0; ix <= segW; ix++) {
                const i = iy * (segW + 1) + ix;
                const c = Math.min(Math.round(ix * (cols - 1) / segW), cols - 1);
                const r = rows - 1 - Math.min(Math.round(iy * (rows - 1) / segH), rows - 1);
                const wx = originX + c * cellSize + cellSize / 2;
                const wz = originZ + r * cellSize + cellSize / 2;
                const h = heightGrid[r * cols + c];
                pos.setXYZ(i, wx, h + 0.7, wz); // slightly higher than threat vis
            }
        }
        pos.needsUpdate = true;
        geo.computeVertexNormals();

        const mat = new THREE.MeshBasicMaterial({
            map: this._visTexture,
            transparent: true,
            opacity: 0.5,
            depthWrite: false,
            side: THREE.DoubleSide,
        });
        this._visMesh = new THREE.Mesh(geo, mat);
        this._visMesh.visible = false;
        this._visMesh.renderOrder = 998;
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
        const { cols, rows, fog, _visData } = this;
        if (!_visData) return;

        for (let r = 0; r < rows; r++) {
            for (let c = 0; c < cols; c++) {
                const idx = r * cols + c;
                const px = idx * 4;
                const f = fog[idx];
                // Blue-grey (unexplored) → transparent (explored)
                _visData[px + 0] = Math.floor(f * 80);          // R
                _visData[px + 1] = Math.floor(f * 80);          // G
                _visData[px + 2] = Math.floor(f * 140);         // B
                _visData[px + 3] = Math.floor(f * 180);         // A
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
     * LOS check — same algorithm as ThreatMap._hasLOS.
     * Bresenham + terrain height + obstacle blocking.
     */
    _hasLOS(c0, r0, eyeY, c1, r1) {
        const { cols, heightGrid, navGrid } = this;

        const targetEyeY = heightGrid[r1 * cols + c1] + EYE_HEIGHT;

        let nc = c0, nr = r0;
        const dc = Math.abs(c1 - c0), dr = Math.abs(r1 - r0);
        const sc = c0 < c1 ? 1 : -1, sr = r0 < r1 ? 1 : -1;
        let err = dc - dr;
        const totalSteps = Math.max(dc, dr);
        let step = 0;

        while (true) {
            if (!(nc === c0 && nr === r0)) {
                if (navGrid && !navGrid.isWalkable(nc, nr)) return false;
                if (totalSteps > 0) {
                    const t = step / totalSteps;
                    const expectedY = eyeY + (targetEyeY - eyeY) * t;
                    const terrainY = heightGrid[nr * cols + nc];
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
