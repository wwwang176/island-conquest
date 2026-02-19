/**
 * Web Worker for A* pathfinding.
 * Runs findPath off the main thread so AI path requests don't cause frame spikes.
 *
 * Protocol:
 *   Main → Worker:
 *     { type: 'init', grid, proxCost, cols, rows, cellSize, originX, originZ }
 *     { type: 'findPath', id, startX, startZ, goalX, goalZ, threatGrid?, threatCols }
 *   Worker → Main:
 *     { id, path: [{x,z},...] | null }
 */

let grid, proxCost, cols, rows, cellSize, originX, originZ;
let gCost, fCost, parent, _genBuf, _gen;

// 8 directions: [dcol, drow, cost]
const dirs = [
    [1, 0, 1], [-1, 0, 1], [0, 1, 1], [0, -1, 1],
    [1, 1, 1.414], [-1, 1, 1.414], [1, -1, 1.414], [-1, -1, 1.414],
];

function worldToGrid(wx, wz) {
    const col = Math.floor((wx - originX) / cellSize);
    const row = Math.floor((wz - originZ) / cellSize);
    return {
        col: Math.max(0, Math.min(col, cols - 1)),
        row: Math.max(0, Math.min(row, rows - 1)),
    };
}

function gridToWorld(col, row) {
    return {
        x: originX + col * cellSize + cellSize / 2,
        z: originZ + row * cellSize + cellSize / 2,
    };
}

function isWalkable(col, row) {
    if (col < 0 || col >= cols || row < 0 || row >= rows) return false;
    return grid[row * cols + col] === 0;
}

function _findNearestWalkable(col, row) {
    if (isWalkable(col, row)) return { col, row };
    for (let r = 1; r <= 15; r++) {
        for (let dr = -r; dr <= r; dr++) {
            for (let dc = -r; dc <= r; dc++) {
                if (Math.abs(dr) !== r && Math.abs(dc) !== r) continue;
                if (isWalkable(col + dc, row + dr)) {
                    return { col: col + dc, row: row + dr };
                }
            }
        }
    }
    return null;
}

function _heuristic(c1, r1, c2, r2) {
    const dx = Math.abs(c1 - c2);
    const dz = Math.abs(r1 - r2);
    return Math.max(dx, dz) + 0.414 * Math.min(dx, dz);
}

function _heapPush(heap, idx) {
    heap.push(idx);
    let i = heap.length - 1;
    while (i > 0) {
        const pi = (i - 1) >> 1;
        if (fCost[heap[pi]] <= fCost[heap[i]]) break;
        const tmp = heap[pi]; heap[pi] = heap[i]; heap[i] = tmp;
        i = pi;
    }
}

function _heapPop(heap) {
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
            const tmp = heap[i]; heap[i] = heap[smallest]; heap[smallest] = tmp;
            i = smallest;
        }
    }
    return top;
}

function _reconstructPath(endIdx, startCol, startRow) {
    const raw = [];
    let idx = endIdx;
    while (idx !== -1) {
        const c = idx % cols;
        const r = (idx - c) / cols;
        if (c !== startCol || r !== startRow) {
            raw.push({ col: c, row: r });
        }
        idx = parent[idx];
    }
    raw.reverse();
    return raw.map(p => gridToWorld(p.col, p.row));
}

function findPath(startX, startZ, goalX, goalZ, threatGrid, threatCols) {
    const start = worldToGrid(startX, startZ);
    const goal = worldToGrid(goalX, goalZ);

    const s = _findNearestWalkable(start.col, start.row);
    const g = _findNearestWalkable(goal.col, goal.row);
    if (!s || !g) return null;

    const sc = s.col, sr = s.row;
    const gc = g.col, gr = g.row;

    if (sc === gc && sr === gr) return [];

    _gen += 2;
    const genOpen = _gen;
    const genClosed = _gen + 1;

    const startIdx = sr * cols + sc;
    const goalIdx = gr * cols + gc;
    gCost[startIdx] = 0;
    _genBuf[startIdx] = genOpen;
    parent[startIdx] = -1;

    const heap = [startIdx];
    fCost[startIdx] = _heuristic(sc, sr, gc, gr);

    let iterations = 0;
    const maxIter = 120000;

    while (heap.length > 0 && iterations < maxIter) {
        iterations++;

        const currentIdx = _heapPop(heap);
        if (currentIdx === goalIdx) {
            return _reconstructPath(currentIdx, sc, sr);
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
            if (_genBuf[nIdx] === genClosed || !isWalkable(nc, nr)) continue;

            // Diagonal corner-cutting prevention
            if (dc !== 0 && dr !== 0) {
                if (!isWalkable(cc + dc, cr) || !isWalkable(cc, cr + dr)) continue;
            }

            const proxMul = proxCost[nIdx];
            const threatPenalty = threatGrid
                ? threatGrid[(nr >> 1) * threatCols + (nc >> 1)] * 1.5 : 0;
            const ng = cg + cost * proxMul + threatPenalty;
            const prevG = _genBuf[nIdx] === genOpen ? gCost[nIdx] : Infinity;
            if (ng < prevG) {
                gCost[nIdx] = ng;
                _genBuf[nIdx] = genOpen;
                fCost[nIdx] = ng + _heuristic(nc, nr, gc, gr);
                parent[nIdx] = currentIdx;
                _heapPush(heap, nIdx);
            }
        }
    }

    return null;
}

self.onmessage = (e) => {
    const msg = e.data;

    if (msg.type === 'init') {
        grid = msg.grid;
        proxCost = msg.proxCost;
        cols = msg.cols;
        rows = msg.rows;
        cellSize = msg.cellSize;
        originX = msg.originX;
        originZ = msg.originZ;

        const total = cols * rows;
        gCost = new Float32Array(total);
        fCost = new Float32Array(total);
        parent = new Int32Array(total);
        _genBuf = new Uint32Array(total);
        _gen = 0;
        return;
    }

    if (msg.type === 'findPath') {
        const path = findPath(
            msg.startX, msg.startZ,
            msg.goalX, msg.goalZ,
            msg.threatGrid, msg.threatCols
        );
        self.postMessage({ id: msg.id, path });
    }
};
