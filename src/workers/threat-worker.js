/**
 * Web Worker for ThreatMap computation.
 * Receives heightGrid + enemy positions, computes threat grid off main thread.
 *
 * Threat sources are split into:
 *   - visible: VISIBLE contacts (always applied, full confidence)
 *   - lost:    LOST/SUSPECTED contacts (confidence decays over time)
 *
 * LOST threat is NOT masked by friendly coverage — threat represents
 * "can be shot from enemy position", not "enemy is here". Friendly
 * scan clearing (confirmClear in scan-worker) handles source-level
 * decay acceleration instead.
 */

const EYE_HEIGHT = 1.5;

let cols = 0, rows = 0, cellSize = 1, originX = 0, originZ = 0;
let heightGrid = null;
let threat = null;

self.onmessage = (e) => {
    const msg = e.data;

    if (msg.type === 'init') {
        cols = msg.cols;
        rows = msg.rows;
        cellSize = msg.cellSize;
        originX = msg.originX;
        originZ = msg.originZ;
        heightGrid = new Float32Array(msg.heightGrid);
        threat = new Float32Array(cols * rows);
        return;
    }

    if (msg.type === 'update') {
        computeThreat(msg.visible || [], msg.lost || []);
        // Post threat back (copy, don't transfer — we reuse the buffer)
        self.postMessage({ type: 'result', threat: threat.slice() });
    }
};

function computeThreat(visible, lost) {
    threat.fill(0);

    // 1) Radiate threat from VISIBLE contacts (always applied)
    for (const src of visible) {
        radiate(src, 1.0);
    }

    // 2) Radiate threat from LOST contacts (confidence-weighted, time-decayed)
    for (const src of lost) {
        radiate(src, src.confidence);
    }
}

/**
 * Radiate threat from a single source position.
 * @param {{x,y,z}} src — world position
 * @param {number} conf — confidence multiplier (0-1)
 */
function radiate(src, conf) {
    if (conf <= 0) return;

    const eCol = Math.max(0, Math.min(Math.floor((src.x - originX) / cellSize), cols - 1));
    const eRow = Math.max(0, Math.min(Math.floor((src.z - originZ) / cellSize), rows - 1));
    const terrainEyeY = heightGrid[eRow * cols + eCol] + EYE_HEIGHT;
    const actualEyeY = (src.y !== undefined) ? src.y + EYE_HEIGHT : terrainEyeY;
    const enemyEyeY = Math.max(terrainEyeY, actualEyeY);

    const radius = 160;
    const radius2 = radius * radius;
    const minCol = Math.max(0, eCol - radius);
    const maxCol = Math.min(cols - 1, eCol + radius);
    const minRow = Math.max(0, eRow - radius);
    const maxRow = Math.min(rows - 1, eRow + radius);

    for (let r = minRow; r <= maxRow; r++) {
        for (let c = minCol; c <= maxCol; c++) {
            const dc = c - eCol;
            const dr = r - eRow;
            const dist2 = dc * dc + dr * dr;
            if (dist2 > radius2) continue;

            if (!hasLOS(eCol, eRow, enemyEyeY, c, r)) continue;

            const dy = enemyEyeY - (heightGrid[r * cols + c] + EYE_HEIGHT);
            const dist3Dsq = dist2 * cellSize * cellSize + dy * dy;
            threat[r * cols + c] += conf / (1 + dist3Dsq * 0.001);
        }
    }
}

function hasLOS(c0, r0, enemyEyeY, c1, r1) {
    const targetEyeY = heightGrid[r1 * cols + c1] + EYE_HEIGHT;

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
                const expectedY = enemyEyeY + (targetEyeY - enemyEyeY) * t;
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
