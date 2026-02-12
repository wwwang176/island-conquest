/**
 * Kill feed HUD — shows recent kills in the top-right corner.
 * Each entry fades out after a few seconds.
 */

const MAX_ENTRIES = 5;
const ENTRY_LIFE = 5;  // seconds

export class KillFeed {
    constructor() {
        this.entries = []; // { killerName, killerTeam, victimName, victimTeam, headshot, life }
        this._dirty = false;
        this._createDOM();
    }

    _createDOM() {
        const el = document.createElement('div');
        el.id = 'kill-feed';
        el.style.cssText = `position:fixed;top:50px;right:15px;
            font-family:Consolas,monospace;font-size:13px;
            pointer-events:none;z-index:100;text-align:right;`;
        document.body.appendChild(el);
        this.container = el;
    }

    /**
     * Add a kill entry.
     * @param {string} killerName
     * @param {string} killerTeam - 'teamA' or 'teamB'
     * @param {string} victimName
     * @param {string} victimTeam - 'teamA' or 'teamB'
     * @param {boolean} headshot
     */
    addKill(killerName, killerTeam, victimName, victimTeam, headshot = false) {
        this.entries.push({
            killerName,
            killerTeam,
            victimName,
            victimTeam,
            headshot,
            life: ENTRY_LIFE,
        });
        this._dirty = true;
        // Trim old entries
        while (this.entries.length > MAX_ENTRIES) {
            this.entries.shift();
        }
    }

    update(dt) {
        if (this.entries.length === 0) {
            if (this._dirty) {
                this.container.innerHTML = '';
                this._dirty = false;
            }
            return;
        }

        // Decay entries
        for (let i = this.entries.length - 1; i >= 0; i--) {
            this.entries[i].life -= dt;
            if (this.entries[i].life <= 0) {
                this.entries.splice(i, 1);
                this._dirty = true;
            }
        }

        // Entries with fading opacity need DOM update each frame
        if (this.entries.length > 0) this._dirty = true;

        if (!this._dirty) return;
        this._dirty = false;

        // Render
        let html = '';
        for (const e of this.entries) {
            const opacity = Math.min(1, e.life / 1.5); // fade in last 1.5s
            const kColor = e.killerTeam === 'teamA' ? '#4488ff' : '#ff4444';
            const vColor = e.victimTeam === 'teamA' ? '#4488ff' : '#ff4444';
            const hs = e.headshot ? ' <span style="color:#ffcc00">HS</span>' : '';
            html += `<div style="opacity:${opacity};margin-bottom:3px;
                background:rgba(0,0,0,0.45);padding:3px 8px;border-radius:3px;display:inline-block;">
                <span style="color:${kColor}">${e.killerName}</span>
                <span style="color:#888"> → </span>
                <span style="color:${vColor}">${e.victimName}</span>${hs}
            </div><br>`;
        }
        this.container.innerHTML = html;
    }
}
