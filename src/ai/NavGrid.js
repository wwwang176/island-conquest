import * as THREE from 'three';

/**
 * 2D navigation grid with A* pathfinding.
 * Built once at startup from heightmap + obstacle raycasts.
 */
export class NavGrid {
    constructor(width, depth, cols, rows) {
        this.width = width;       // 300
        this.depth = depth;       // 120
        this.cols = cols;         // 600
        this.rows = rows;         // 240
        this.cellSize = width / cols; // 0.5
        this.originX = -width / 2;    // -150
        this.originZ = -depth / 2;    // -60

        this.grid = new Uint8Array(cols * rows); // 0=walkable, 1=blocked

        // Reusable A* buffers (generation-based — no fill() needed per search)
        this.gCost = new Float32Array(cols * rows);
        this.fCost = new Float32Array(cols * rows);
        this.parent = new Int32Array(cols * rows);
        this._gen = 0;                                  // current generation (uses bits 0-30)
        this._genBuf = new Uint32Array(cols * rows);     // per-cell: gen stamp, bit 31 = closed

        // 8 directions: [dcol, drow, cost]
        this.dirs = [
            [1, 0, 1], [-1, 0, 1], [0, 1, 1], [0, -1, 1],
            [1, 1, 1.414], [-1, 1, 1.414], [1, -1, 1.414], [-1, -1, 1.414],
        ];
    }

    /**
     * Build the grid from heightmap and obstacle raycasts.
     */
    build(getHeightAt, collidables) {
        const { cols, rows, cellSize, originX, originZ, grid } = this;
        const raycaster = new THREE.Raycaster();
        const downDir = new THREE.Vector3(0, -1, 0);

        // Pre-compute terrain heights
        const SHORE_THRESHOLD = 0.3;
        const MAX_SHORE_DIST = 2;
        const cellHeights = new Float32Array(cols * rows);
        for (let row = 0; row < rows; row++) {
            for (let col = 0; col < cols; col++) {
                const wx = originX + col * cellSize + cellSize / 2;
                const wz = originZ + row * cellSize + cellSize / 2;
                cellHeights[row * cols + col] = getHeightAt(wx, wz);
            }
        }

        // BFS distance-to-shore: land cells = 0, water cells = dist to nearest land
        const distToShore = new Int16Array(cols * rows);
        const bfsQueue = [];
        for (let i = 0; i < cols * rows; i++) {
            if (cellHeights[i] >= SHORE_THRESHOLD) {
                distToShore[i] = 0;
                bfsQueue.push(i);
            } else {
                distToShore[i] = 32767;
            }
        }
        let head = 0;
        while (head < bfsQueue.length) {
            const ci = bfsQueue[head++];
            const col = ci % cols;
            const row = (ci - col) / cols;
            const nd = distToShore[ci] + 1;
            const neighbors = [
                row > 0 ? ci - cols : -1,
                row < rows - 1 ? ci + cols : -1,
                col > 0 ? ci - 1 : -1,
                col < cols - 1 ? ci + 1 : -1,
            ];
            for (const ni of neighbors) {
                if (ni >= 0 && nd < distToShore[ni]) {
                    distToShore[ni] = nd;
                    bfsQueue.push(ni);
                }
            }
        }

        // Main grid pass
        for (let row = 0; row < rows; row++) {
            for (let col = 0; col < cols; col++) {
                const idx = row * cols + col;
                const wx = originX + col * cellSize + cellSize / 2;
                const wz = originZ + row * cellSize + cellSize / 2;
                const h = cellHeights[idx];

                // Block deep water: low terrain AND far from any shore
                if (h < SHORE_THRESHOLD && distToShore[idx] > MAX_SHORE_DIST) {
                    grid[idx] = 1; continue;
                }

                // Block steep slopes: check max gradient to cardinal neighbors
                const hN = getHeightAt(wx, wz - cellSize);
                const hS = getHeightAt(wx, wz + cellSize);
                const hE = getHeightAt(wx + cellSize, wz);
                const hW = getHeightAt(wx - cellSize, wz);
                const maxSlope = Math.max(
                    Math.abs(h - hN), Math.abs(h - hS),
                    Math.abs(h - hE), Math.abs(h - hW)
                );
                // tan(75°) ≈ 3.73, rise > 3.73 * cellSize means too steep
                if (maxSlope / cellSize > 3.73) { grid[idx] = 1; continue; }

                // Obstacle detection: downward raycast
                // Block any obstacle > 0.3m above terrain (matches kinematic threshold)
                raycaster.set(new THREE.Vector3(wx, h + 10, wz), downDir);
                raycaster.far = 12;
                const hits = raycaster.intersectObjects(collidables, true);
                let hasObstacle = false;
                for (const hit of hits) {
                    if (hit.point.y > h + 0.3) {
                        hasObstacle = true;
                        break;
                    }
                }
                grid[idx] = hasObstacle ? 1 : 0;
            }
        }

        // Build proximity cost: walkable cells near obstacles cost more
        this._buildProxCost();
    }

    /**
     * BFS from all blocked cells to compute distance-based cost for walkable cells.
     * Cells near obstacles get higher A* cost so paths naturally avoid edges.
     */
    _buildProxCost() {
        const { cols, rows, grid } = this;
        const total = cols * rows;
        const dist = new Uint8Array(total);
        dist.fill(255);
        const queue = [];

        // Seed: all blocked cells have distance 0
        for (let i = 0; i < total; i++) {
            if (grid[i] === 1) {
                dist[i] = 0;
                queue.push(i);
            }
        }

        // BFS up to distance 3
        const MAX_DIST = 3;
        let head = 0;
        while (head < queue.length) {
            const ci = queue[head++];
            const cd = dist[ci];
            if (cd >= MAX_DIST) continue;
            const col = ci % cols;
            const row = (ci - col) / cols;
            for (let dr = -1; dr <= 1; dr++) {
                for (let dc = -1; dc <= 1; dc++) {
                    if (dr === 0 && dc === 0) continue;
                    const nr = row + dr, nc = col + dc;
                    if (nr < 0 || nr >= rows || nc < 0 || nc >= cols) continue;
                    const ni = nr * cols + nc;
                    if (dist[ni] <= cd + 1) continue;
                    dist[ni] = cd + 1;
                    queue.push(ni);
                }
            }
        }

        // Convert distance to cost multiplier:
        // dist 1 → ×4, dist 2 → ×2, dist 3 → ×1.5, dist 4+ → ×1
        this.proxCost = new Float32Array(total);
        for (let i = 0; i < total; i++) {
            const d = dist[i];
            if (d === 0) this.proxCost[i] = 1; // blocked, won't be used
            else if (d === 1) this.proxCost[i] = 8;
            else if (d === 2) this.proxCost[i] = 4;
            else if (d === 3) this.proxCost[i] = 2;
            else this.proxCost[i] = 1;
        }
    }

    worldToGrid(wx, wz) {
        const col = Math.floor((wx - this.originX) / this.cellSize);
        const row = Math.floor((wz - this.originZ) / this.cellSize);
        return {
            col: Math.max(0, Math.min(col, this.cols - 1)),
            row: Math.max(0, Math.min(row, this.rows - 1)),
        };
    }

    gridToWorld(col, row) {
        return {
            x: this.originX + col * this.cellSize + this.cellSize / 2,
            z: this.originZ + row * this.cellSize + this.cellSize / 2,
        };
    }

    isWalkable(col, row) {
        if (col < 0 || col >= this.cols || row < 0 || row >= this.rows) return false;
        return this.grid[row * this.cols + col] === 0;
    }

    /**
     * Find nearest walkable cell to (col, row). Returns {col, row} or null.
     */
    _findNearestWalkable(col, row) {
        if (this.isWalkable(col, row)) return { col, row };
        for (let r = 1; r <= 15; r++) {
            for (let dr = -r; dr <= r; dr++) {
                for (let dc = -r; dc <= r; dc++) {
                    if (Math.abs(dr) !== r && Math.abs(dc) !== r) continue;
                    if (this.isWalkable(col + dc, row + dr)) {
                        return { col: col + dc, row: row + dr };
                    }
                }
            }
        }
        return null;
    }

    /**
     * A* pathfinding. Returns array of {x, z} world waypoints, or null.
     * @param {Float32Array} [threatGrid] - flat threat values at ThreatMap resolution
     * @param {number} [threatCols] - ThreatMap column count (NavGrid cols / 2)
     */
    findPath(startX, startZ, goalX, goalZ, threatGrid = null, threatCols = 0) {
        const start = this.worldToGrid(startX, startZ);
        const goal = this.worldToGrid(goalX, goalZ);

        // Handle blocked start/goal
        const s = this._findNearestWalkable(start.col, start.row);
        const g = this._findNearestWalkable(goal.col, goal.row);
        if (!s || !g) return null;

        const sc = s.col, sr = s.row;
        const gc = g.col, gr = g.row;

        // Same cell
        if (sc === gc && sr === gr) return [];

        const { cols, rows, gCost, parent, dirs, _genBuf } = this;
        const total = cols * rows;

        // Generation-based reset — O(1) instead of O(144k) fill
        // Use even gen for "open", gen+1 for "closed"; advance by 2 each call
        this._gen += 2;
        const genOpen = this._gen;
        const genClosed = this._gen + 1;

        const startIdx = sr * cols + sc;
        const goalIdx = gr * cols + gc;
        gCost[startIdx] = 0;
        _genBuf[startIdx] = genOpen;
        parent[startIdx] = -1;

        // Binary min-heap (stores indices, sorted by f-cost)
        const heap = [startIdx];
        const fCost = this.fCost;
        fCost[startIdx] = this._heuristic(sc, sr, gc, gr);

        let iterations = 0;
        const maxIter = 120000;

        while (heap.length > 0 && iterations < maxIter) {
            iterations++;

            // Pop min
            const currentIdx = this._heapPop(heap, fCost);
            if (currentIdx === goalIdx) {
                return this._reconstructPath(parent, currentIdx, sc, sr);
            }

            if (_genBuf[currentIdx] === genClosed) continue;
            _genBuf[currentIdx] = genClosed;

            const cc = currentIdx % cols;
            const cr = (currentIdx - cc) / cols;
            const cg = gCost[currentIdx];

            for (const [dc, dr, cost] of dirs) {
                const nc = cc + dc;
                const nr = cr + dr;
                if (nc < 0 || nc >= cols || nr < 0 || nr >= rows) continue;

                const nIdx = nr * cols + nc;
                if (_genBuf[nIdx] === genClosed || !this.isWalkable(nc, nr)) continue;

                // Diagonal corner-cutting prevention
                if (dc !== 0 && dr !== 0) {
                    if (!this.isWalkable(cc + dc, cr) || !this.isWalkable(cc, cr + dr)) continue;
                }

                // Add proximity + threat avoidance cost
                const proxMul = this.proxCost[nIdx];
                const threatPenalty = threatGrid
                    ? threatGrid[(nr >> 1) * threatCols + (nc >> 1)] * 1.5 : 0;
                const ng = cg + cost * proxMul + threatPenalty;
                const prevG = _genBuf[nIdx] === genOpen ? gCost[nIdx] : Infinity;
                if (ng < prevG) {
                    gCost[nIdx] = ng;
                    _genBuf[nIdx] = genOpen;
                    fCost[nIdx] = ng + this._heuristic(nc, nr, gc, gr);
                    parent[nIdx] = currentIdx;
                    this._heapPush(heap, nIdx, fCost);
                }
            }
        }

        return null; // No path found
    }

    _heuristic(c1, r1, c2, r2) {
        const dx = Math.abs(c1 - c2);
        const dz = Math.abs(r1 - r2);
        return Math.max(dx, dz) + 0.414 * Math.min(dx, dz);
    }

    _reconstructPath(parent, endIdx, startCol, startRow) {
        const { cols } = this;
        const raw = [];
        let idx = endIdx;
        while (idx !== -1) {
            const c = idx % cols;
            const r = (idx - c) / cols;
            // Skip start position
            if (c !== startCol || r !== startRow) {
                raw.push({ col: c, row: r });
            }
            idx = parent[idx];
        }
        raw.reverse();

        // Convert to world coords
        return raw.map(p => this.gridToWorld(p.col, p.row));
    }

    // ───── Binary Min-Heap ─────

    _heapPush(heap, idx, fCost) {
        heap.push(idx);
        let i = heap.length - 1;
        while (i > 0) {
            const pi = (i - 1) >> 1;
            if (fCost[heap[pi]] <= fCost[heap[i]]) break;
            [heap[pi], heap[i]] = [heap[i], heap[pi]];
            i = pi;
        }
    }

    _heapPop(heap, fCost) {
        const top = heap[0];
        const last = heap.pop();
        if (heap.length > 0) {
            heap[0] = last;
            let i = 0;
            const len = heap.length;
            while (true) {
                let smallest = i;
                const l = 2 * i + 1, r = 2 * i + 2;
                if (l < len && fCost[heap[l]] < fCost[heap[smallest]]) smallest = l;
                if (r < len && fCost[heap[r]] < fCost[heap[smallest]]) smallest = r;
                if (smallest === i) break;
                [heap[i], heap[smallest]] = [heap[smallest], heap[i]];
                i = smallest;
            }
        }
        return top;
    }

    // ───── Debug Visualization ─────

    /**
     * Create debug columns on all blocked cells.
     * Red tall columns = original obstacle cells (pre-inflation).
     * Black short columns = inflation-only cells.
     * @param {THREE.Scene} scene
     * @param {Function} getHeightAt - terrain height function
     */
    createBlockedVisualization(scene, getHeightAt) {
        const group = new THREE.Group();
        group.name = 'navgrid-blocked-vis';

        const { cols, rows, cellSize, originX, originZ, grid } = this;

        let count = 0;
        for (let i = 0; i < cols * rows; i++) {
            if (grid[i] === 1) count++;
        }

        const dummy = new THREE.Object3D();
        const boxH = 8;
        const geo = new THREE.BoxGeometry(cellSize * 0.9, boxH, cellSize * 0.9);
        const mat = new THREE.MeshBasicMaterial({
            color: 0xff2222,
            transparent: true,
            opacity: 0.4,
            depthWrite: false,
        });
        const mesh = new THREE.InstancedMesh(geo, mat, count);
        let idx3d = 0;

        for (let row = 0; row < rows; row++) {
            for (let col = 0; col < cols; col++) {
                if (grid[row * cols + col] !== 1) continue;
                const wx = originX + col * cellSize + cellSize / 2;
                const wz = originZ + row * cellSize + cellSize / 2;
                const h = getHeightAt(wx, wz);
                dummy.position.set(wx, h + boxH / 2, wz);
                dummy.updateMatrix();
                mesh.setMatrixAt(idx3d++, dummy.matrix);
            }
        }

        mesh.instanceMatrix.needsUpdate = true;
        mesh.frustumCulled = false;
        group.add(mesh);
        scene.add(group);

        this._blockedVis = group;
        return group;
    }

    /** Toggle blocked-cell visualization. */
    setBlockedVisible(visible) {
        if (this._blockedVis) this._blockedVis.visible = visible;
    }
}
