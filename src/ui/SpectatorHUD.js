/**
 * Spectator mode HUD overlay.
 * Shows mode label, target info, and control hints.
 */
export class SpectatorHUD {
    constructor() {
        this._createDOM();
    }

    _createDOM() {
        const wrap = document.createElement('div');
        wrap.id = 'spectator-hud';
        wrap.style.cssText = `position:fixed;top:0;left:0;width:100%;height:100%;
            pointer-events:none;z-index:100;font-family:Consolas,monospace;`;

        // Top label
        const top = document.createElement('div');
        top.style.cssText = `position:absolute;top:50px;left:50%;transform:translateX(-50%);
            color:rgba(255,255,255,0.7);font-size:14px;text-align:center;
            background:rgba(0,0,0,0.4);padding:6px 16px;border-radius:4px;`;
        top.textContent = 'OBSERVER MODE';
        wrap.appendChild(top);
        this.topLabel = top;

        // Target info (follow mode)
        const info = document.createElement('div');
        info.style.cssText = `position:absolute;bottom:100px;left:50%;transform:translateX(-50%);
            color:white;font-size:14px;text-align:center;
            background:rgba(0,0,0,0.5);padding:8px 18px;border-radius:5px;`;
        wrap.appendChild(info);
        this.targetInfo = info;

        // Control hints
        const hints = document.createElement('div');
        hints.style.cssText = `position:absolute;bottom:40px;left:50%;transform:translateX(-50%);
            color:rgba(255,255,255,0.5);font-size:12px;text-align:center;`;
        hints.innerHTML = '[Tab] Next &nbsp; [V] View &nbsp; [1] Team A &nbsp; [2] Team B';
        wrap.appendChild(hints);

        document.body.appendChild(wrap);
        this.container = wrap;
    }

    updateTarget(name, role, team, hp, maxHP) {
        const color = team === 'teamA' ? '#4488ff' : '#ff4444';
        const pct = Math.round(hp / maxHP * 100);
        const barColor = pct > 60 ? '#4f4' : pct > 30 ? '#ff4' : '#f44';
        this.targetInfo.innerHTML = `
            <span style="color:${color};font-weight:bold">${name}</span>
            <span style="color:#888"> [${role}]</span><br>
            <div style="width:100px;height:4px;background:#333;border-radius:2px;margin:4px auto 0;">
                <div style="width:${pct}%;height:100%;background:${barColor};border-radius:2px;"></div>
            </div>`;
    }

    setOverheadMode() {
        this.topLabel.textContent = 'OVERHEAD VIEW';
        this.targetInfo.style.display = 'none';
    }

    setFollowMode() {
        this.topLabel.textContent = 'OBSERVER MODE';
        this.targetInfo.style.display = 'block';
    }

    show() { this.container.style.display = 'block'; }
    hide() { this.container.style.display = 'none'; }
}
