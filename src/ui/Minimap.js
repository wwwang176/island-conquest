/**
 * Canvas-based minimap HUD.
 * Shows terrain outline, flag positions, friendly/enemy dots.
 * Enemy dots only flash briefly when they fire.
 */
export class Minimap {
    constructor(mapWidth, mapDepth) {
        this.mapWidth = mapWidth;
        this.mapDepth = mapDepth;
        this.size = 160;          // pixel size of minimap
        this.padding = 8;

        // Enemy flash tracking: enemyId → remaining flash time
        this.enemyFlashes = new Map();
        this.flashDuration = 1.5; // seconds enemy dot stays visible after firing

        this._createDOM();
    }

    _createDOM() {
        const wrapper = document.createElement('div');
        wrapper.id = 'minimap';
        wrapper.style.cssText = `position:fixed;top:15px;left:15px;
            width:${this.size}px;height:${this.size}px;
            background:rgba(0,0,0,0.55);border:2px solid rgba(255,255,255,0.25);
            border-radius:6px;pointer-events:none;z-index:100;`;
        document.body.appendChild(wrapper);
        this.wrapper = wrapper;

        const canvas = document.createElement('canvas');
        canvas.width = this.size;
        canvas.height = this.size;
        wrapper.appendChild(canvas);
        this.canvas = canvas;
        this.ctx = canvas.getContext('2d');
    }

    /**
     * Notify that an enemy fired (flash them on minimap).
     */
    onEnemyFired(enemyId) {
        this.enemyFlashes.set(enemyId, this.flashDuration);
    }

    /**
     * Convert world (x,z) to minimap pixel coords.
     */
    _worldToMap(x, z) {
        const pad = this.padding;
        const usable = this.size - pad * 2;
        const mx = pad + ((x + this.mapWidth / 2) / this.mapWidth) * usable;
        const my = pad + ((z + this.mapDepth / 2) / this.mapDepth) * usable;
        return [mx, my];
    }

    /**
     * Main render call.
     * @param {object} data - { playerPos, playerYaw, playerTeam, flags, teamASoldiers, teamBSoldiers, dt }
     */
    update(data) {
        const { playerPos, playerYaw, playerTeam, flags, teamASoldiers, teamBSoldiers, dt } = data;
        const ctx = this.ctx;
        const s = this.size;

        // Decay enemy flashes
        for (const [id, t] of this.enemyFlashes) {
            const remaining = t - dt;
            if (remaining <= 0) this.enemyFlashes.delete(id);
            else this.enemyFlashes.set(id, remaining);
        }

        // Clear
        ctx.clearRect(0, 0, s, s);

        // Draw flags
        for (const flag of flags) {
            const [fx, fy] = this._worldToMap(flag.position.x, flag.position.z);
            ctx.save();
            ctx.translate(fx, fy);

            // Star shape
            const color = flag.owner === 'teamA' ? '#4488ff'
                        : flag.owner === 'teamB' ? '#ff4444'
                        : '#aaaaaa';
            ctx.fillStyle = color;
            ctx.strokeStyle = 'rgba(255,255,255,0.6)';
            ctx.lineWidth = 1;
            this._drawStar(ctx, 0, 0, 5, 5, 2.5);
            ctx.fill();
            ctx.stroke();

            // Label
            ctx.fillStyle = '#fff';
            ctx.font = 'bold 8px Consolas,monospace';
            ctx.textAlign = 'center';
            ctx.fillText(flag.name, 0, -7);
            ctx.restore();
        }

        // Draw soldiers
        const friendlySoldiers = playerTeam === 'teamA' ? teamASoldiers : teamBSoldiers;
        const enemySoldiers = playerTeam === 'teamA' ? teamBSoldiers : teamASoldiers;

        // Friendly dots (always visible, blue/team color)
        for (const s of friendlySoldiers) {
            if (!s.alive) continue;
            const pos = s.getPosition();
            const [sx, sy] = this._worldToMap(pos.x, pos.z);
            ctx.fillStyle = playerTeam === 'teamA' ? '#4488ff' : '#ff4444';
            ctx.beginPath();
            ctx.arc(sx, sy, 2.5, 0, Math.PI * 2);
            ctx.fill();
        }

        // Enemy dots (only visible when they recently fired)
        const enemyTeamKey = playerTeam === 'teamA' ? 'teamB' : 'teamA';
        const enemyColor = playerTeam === 'teamA' ? '#ff4444' : '#4488ff';
        for (const s of enemySoldiers) {
            if (!s.alive) continue;
            const flashKey = `${enemyTeamKey}_${s.id}`;
            if (!this.enemyFlashes.has(flashKey)) continue;
            const pos = s.getPosition();
            const [sx, sy] = this._worldToMap(pos.x, pos.z);
            const alpha = Math.min(1, this.enemyFlashes.get(flashKey) / this.flashDuration);
            ctx.fillStyle = enemyColor;
            ctx.globalAlpha = alpha;
            ctx.beginPath();
            ctx.arc(sx, sy, 2.5, 0, Math.PI * 2);
            ctx.fill();
            ctx.globalAlpha = 1;
        }

        // Draw player (white triangle pointing in yaw direction)
        if (playerPos) {
            const [px, py] = this._worldToMap(playerPos.x, playerPos.z);
            ctx.save();
            ctx.translate(px, py);
            // Yaw: 0 = north (-Z), rotate so triangle points in aim direction
            // On minimap, -Z is up (negative Y canvas direction)
            ctx.rotate(-playerYaw);
            ctx.fillStyle = '#ffffff';
            ctx.beginPath();
            ctx.moveTo(0, -5);
            ctx.lineTo(-3.5, 4);
            ctx.lineTo(3.5, 4);
            ctx.closePath();
            ctx.fill();
            ctx.restore();
        }
    }

    _drawStar(ctx, cx, cy, spikes, outerR, innerR) {
        let rot = Math.PI / 2 * 3;
        const step = Math.PI / spikes;
        ctx.beginPath();
        ctx.moveTo(cx, cy - outerR);
        for (let i = 0; i < spikes; i++) {
            ctx.lineTo(cx + Math.cos(rot) * outerR, cy + Math.sin(rot) * outerR);
            rot += step;
            ctx.lineTo(cx + Math.cos(rot) * innerR, cy + Math.sin(rot) * innerR);
            rot += step;
        }
        ctx.lineTo(cx, cy - outerR);
        ctx.closePath();
    }
}
