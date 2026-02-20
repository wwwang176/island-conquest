/**
 * Web Worker for AI threat scanning (Bresenham LOS).
 * Offloads per-AI visibility checks from the main thread.
 *
 * Protocol:
 *   Main → Worker: { type: 'init', cols, rows, cellSize, originX, originZ, heightGrid }
 *   Main → Worker: { type: 'scan', aiAData, enAData, aiACount, enACount,
 *                                   aiBData, enBData, aiBCount, enBCount }
 *     (Float32Arrays, transferred)
 *   Worker → Main: { type: 'scanResult', teamAResults, teamBResults }
 *
 * AI stride  = 7: x, y, z, facingX, facingZ, range, flags (bit0=alive, bit1=inHeli)
 * Enemy stride = 5: x, y, z, visRange, alive
 */

const EYE_HEIGHT = 1.5;
const HEAD_TOP_HEIGHT = 1.7;
const AI_STRIDE = 7;
const EN_STRIDE = 5;

let cols = 0, rows = 0, cellSize = 1, originX = 0, originZ = 0;
let heightGrid = null;

function _worldToGrid(wx, wz) {
    const col = Math.floor((wx - originX) / cellSize);
    const row = Math.floor((wz - originZ) / cellSize);
    return {
        col: Math.max(0, Math.min(col, cols - 1)),
        row: Math.max(0, Math.min(row, rows - 1)),
    };
}

/** Bresenham walk: returns true if ray from eyeY0 to targetY1 is unblocked. */
function _bresenhamClear(c0, r0, eyeY0, c1, r1, targetY1) {
    let nc = c0, nr = r0;
    const dc = Math.abs(c1 - c0), dr = Math.abs(r1 - r0);
    const sc = c0 < c1 ? 1 : -1, sr = r0 < r1 ? 1 : -1;
    let err = dc - dr;
    const totalSteps = Math.max(dc, dr);
    let step = 0;
    while (true) {
        if (!(nc === c0 && nr === r0)) {
            if (totalSteps > 0) {
                const t = step / totalSteps;
                const expectedY = eyeY0 + (targetY1 - eyeY0) * t;
                const cellY = heightGrid[nr * cols + nc];
                if (cellY > expectedY) return false;
            }
        }
        if (nc === c1 && nr === r1) return true;
        step++;
        const e2 = 2 * err;
        if (e2 > -dr) { err -= dr; nc += sc; }
        if (e2 < dc) { err += dc; nr += sr; }
    }
}

/**
 * Dual-ray LOS: eye→eye, if blocked try eye→head-top.
 * Returns: 0 = not visible, 1 = body visible, 2 = head-only visible.
 */
function _hasGridLOS(c0, r0, eyeY0, c1, r1, targetY) {
    if (_bresenhamClear(c0, r0, eyeY0, c1, r1, targetY + EYE_HEIGHT)) return 1;
    if (_bresenhamClear(c0, r0, eyeY0, c1, r1, targetY + HEAD_TOP_HEIGHT)) return 2;
    return 0;
}

/**
 * Scan one team: each AI in aiData checks visibility against enemies in enData.
 */
function scanTeam(aiData, aiCount, enData, enCount) {
    const results = new Array(aiCount);

    for (let a = 0; a < aiCount; a++) {
        const ao = a * AI_STRIDE;
        const ax = aiData[ao], ay = aiData[ao + 1], az = aiData[ao + 2];
        const facingX = aiData[ao + 3], facingZ = aiData[ao + 4];
        const range = aiData[ao + 5];
        const flags = aiData[ao + 6];
        const alive = (flags & 1) !== 0;
        const inHeli = (flags & 2) !== 0;

        if (!alive) {
            results[a] = { visibleEnemies: [] };
            continue;
        }

        const visibleEnemies = [];
        const aiGrid = _worldToGrid(ax, az);
        const aiEyeY = inHeli
            ? ay + EYE_HEIGHT
            : heightGrid[aiGrid.row * cols + aiGrid.col] + EYE_HEIGHT;

        for (let ei = 0; ei < enCount; ei++) {
            const eo = ei * EN_STRIDE;
            const enAlive = enData[eo + 4];
            if (enAlive < 0.5) continue;

            const ex = enData[eo], ey = enData[eo + 1], ez = enData[eo + 2];
            const visRange = enData[eo + 3];

            const dx = ex - ax;
            const dy = ey - ay;
            const dz = ez - az;
            const dist = Math.sqrt(dx * dx + dy * dy + dz * dz);

            const maxRange = range > visRange ? range : visRange;
            if (dist > maxRange) continue;

            // FOV check (120 deg) — skip in helicopter
            if (!inHeli) {
                const invDist = dist > 0.001 ? 1 / dist : 0;
                const dot = facingX * (dx * invDist) + facingZ * (dz * invDist);
                if (dot < -0.2) continue;
            }

            // LOS check — skip in helicopter
            let losLevel = 1;
            if (!inHeli && heightGrid) {
                const eGrid = _worldToGrid(ex, ez);
                losLevel = _hasGridLOS(
                    aiGrid.col, aiGrid.row, aiEyeY,
                    eGrid.col, eGrid.row, ey
                );
                if (losLevel === 0) continue;
            }

            visibleEnemies.push({ idx: ei, dist, losLevel });
        }

        results[a] = { visibleEnemies };
    }

    return results;
}

self.onmessage = (e) => {
    const msg = e.data;

    if (msg.type === 'init') {
        cols = msg.cols;
        rows = msg.rows;
        cellSize = msg.cellSize;
        originX = msg.originX;
        originZ = msg.originZ;
        heightGrid = msg.heightGrid;
        return;
    }

    if (msg.type === 'scan') {
        const teamAResults = scanTeam(msg.aiAData, msg.aiACount, msg.enAData, msg.enACount);
        const teamBResults = scanTeam(msg.aiBData, msg.aiBCount, msg.enBData, msg.enBCount);
        self.postMessage({ type: 'scanResult', teamAResults, teamBResults });
    }
};
