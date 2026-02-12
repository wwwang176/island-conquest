/**
 * Web Worker for NavGrid building.
 * Rebuilds obstacle meshes from descriptors, performs raycasting,
 * and returns the completed grid + height data.
 *
 * Runs in a module Worker — imports Three.js directly from CDN.
 */
import * as THREE from 'https://cdn.jsdelivr.net/npm/three@0.162.0/build/three.module.js';

self.onmessage = (e) => {
    const {
        obstacles,      // Array of obstacle descriptors
        heightData,     // Float32Array — terrain vertex heights
        width, depth,   // Island dimensions (300, 120)
        segW, segD,     // Terrain mesh segments (150, 60)
        navCols, navRows, // NavGrid resolution (600, 240)
    } = e.data;

    const cellSize = width / navCols;
    const originX = -width / 2;
    const originZ = -depth / 2;

    // ── Reconstruct getHeightAt from heightData ──
    // Mirrors Island.getHeightAt — bilinear interpolation on the terrain grid
    function getHeightAt(x, z) {
        const u = (x + width / 2) / width;
        const v = (z + depth / 2) / depth;
        if (u < 0 || u > 1 || v < 0 || v > 1) return -5;

        const col = Math.min(Math.floor(u * segW), segW - 1);
        const row = Math.min(Math.floor(v * segD), segD - 1);
        const col2 = Math.min(col + 1, segW);
        const row2 = Math.min(row + 1, segD);

        const fx = u * segW - col;
        const fy = v * segD - row;

        const stride = segW + 1;
        const h00 = heightData[row * stride + col];
        const h10 = heightData[row * stride + col2];
        const h01 = heightData[row2 * stride + col];
        const h11 = heightData[row2 * stride + col2];

        return h00 * (1 - fx) * (1 - fy) + h10 * fx * (1 - fy) +
               h01 * (1 - fx) * fy + h11 * fx * fy;
    }

    // ── Rebuild obstacle meshes (simplified — no materials needed) ──
    const collidables = [];
    for (const desc of obstacles) {
        let geo;
        if (desc.type === 'rock') {
            // Approximate deformed dodecahedron with original geometry + deformation
            geo = new THREE.DodecahedronGeometry(desc.scale, 0);
            const pos = geo.attributes.position;
            for (let i = 0; i < pos.count; i++) {
                pos.setX(i, pos.getX(i) * desc.deform[i * 3]);
                pos.setY(i, pos.getY(i) * desc.deform[i * 3 + 1]);
                pos.setZ(i, pos.getZ(i) * desc.deform[i * 3 + 2]);
            }
        } else {
            geo = new THREE.BoxGeometry(desc.w, desc.h, desc.d);
        }
        const mesh = new THREE.Mesh(geo);
        mesh.position.set(desc.x, desc.y, desc.z);
        if (desc.rotY !== 0) mesh.rotation.y = desc.rotY;
        mesh.updateMatrixWorld(true);
        collidables.push(mesh);
    }

    // ── Build grid (mirrors NavGrid.build) ──
    const grid = new Uint8Array(navCols * navRows);
    const raycaster = new THREE.Raycaster();
    const downDir = new THREE.Vector3(0, -1, 0);

    // Pre-compute terrain heights + BFS distance-to-shore for water blocking
    const cellHeights = new Float32Array(navCols * navRows);
    for (let row = 0; row < navRows; row++) {
        for (let col = 0; col < navCols; col++) {
            const wx = originX + col * cellSize + cellSize / 2;
            const wz = originZ + row * cellSize + cellSize / 2;
            cellHeights[row * navCols + col] = getHeightAt(wx, wz);
        }
    }

    // BFS: compute distance (in cells) from nearest land cell for every water cell
    const SHORE_THRESHOLD = 0.3;
    const MAX_SHORE_DIST = 2; // cells — water within this range of land stays walkable
    const distToShore = new Int16Array(navCols * navRows);
    const bfsQueue = [];

    for (let i = 0; i < navCols * navRows; i++) {
        if (cellHeights[i] >= SHORE_THRESHOLD) {
            distToShore[i] = 0;
            bfsQueue.push(i);
        } else {
            distToShore[i] = 32767; // unvisited water
        }
    }

    let head = 0;
    while (head < bfsQueue.length) {
        const ci = bfsQueue[head++];
        const col = ci % navCols;
        const row = (ci - col) / navCols;
        const nd = distToShore[ci] + 1;
        const neighbors = [
            row > 0 ? ci - navCols : -1,
            row < navRows - 1 ? ci + navCols : -1,
            col > 0 ? ci - 1 : -1,
            col < navCols - 1 ? ci + 1 : -1,
        ];
        for (const ni of neighbors) {
            if (ni >= 0 && nd < distToShore[ni]) {
                distToShore[ni] = nd;
                bfsQueue.push(ni);
            }
        }
    }

    // Main grid pass
    for (let row = 0; row < navRows; row++) {
        for (let col = 0; col < navCols; col++) {
            const idx = row * navCols + col;
            const wx = originX + col * cellSize + cellSize / 2;
            const wz = originZ + row * cellSize + cellSize / 2;
            const h = cellHeights[idx];

            // Block deep water: low terrain AND far from any shore
            if (h < SHORE_THRESHOLD && distToShore[idx] > MAX_SHORE_DIST) {
                grid[idx] = 1; continue;
            }

            // Steep slopes
            const hN = getHeightAt(wx, wz - cellSize);
            const hS = getHeightAt(wx, wz + cellSize);
            const hE = getHeightAt(wx + cellSize, wz);
            const hW = getHeightAt(wx - cellSize, wz);
            const maxSlope = Math.max(
                Math.abs(h - hN), Math.abs(h - hS),
                Math.abs(h - hE), Math.abs(h - hW)
            );
            if (maxSlope / cellSize > 3.73) { grid[idx] = 1; continue; }

            // Obstacle raycast
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

    // Save pre-inflation copy
    const rawGrid = new Uint8Array(grid);

    // ── Inflate obstacles by 1 cell ──
    const copy = new Uint8Array(grid);
    for (let row = 0; row < navRows; row++) {
        for (let col = 0; col < navCols; col++) {
            if (copy[row * navCols + col] !== 1) continue;
            for (let dr = -1; dr <= 1; dr++) {
                for (let dc = -1; dc <= 1; dc++) {
                    if (dr === 0 && dc === 0) continue;
                    const nr = row + dr;
                    const nc = col + dc;
                    if (nr < 0 || nr >= navRows || nc < 0 || nc >= navCols) continue;
                    grid[nr * navCols + nc] = 1;
                }
            }
        }
    }

    // ── Build ThreatMap height grid ──
    const heightGrid = new Float32Array(navCols * navRows);
    for (let r = 0; r < navRows; r++) {
        for (let c = 0; c < navCols; c++) {
            const wx = originX + c * cellSize + cellSize / 2;
            const wz = originZ + r * cellSize + cellSize / 2;
            heightGrid[r * navCols + c] = getHeightAt(wx, wz);
        }
    }

    // ── Return results via Transferable ──
    self.postMessage(
        { grid, rawGrid, heightGrid, navCols, navRows },
        [grid.buffer, rawGrid.buffer, heightGrid.buffer]
    );
};
