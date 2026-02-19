/**
 * Kill feed HUD — shows recent kills in the top-right corner.
 * Each entry fades out after a few seconds.
 * Uses pre-built DOM elements instead of innerHTML to reduce GC pressure.
 */

const MAX_ENTRIES = 5;
const ENTRY_LIFE = 5;  // seconds

export class KillFeed {
    constructor() {
        this.entries = []; // { killerName, killerTeam, victimName, victimTeam, headshot, weapon, life, el }
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

    _createEntryEl(entry) {
        const wrapper = document.createElement('div');
        wrapper.style.cssText = 'margin-bottom:3px;display:inline-block;background:rgba(0,0,0,0.45);padding:3px 8px;border-radius:3px;';

        const kColor = entry.killerTeam === 'teamA' ? '#4488ff' : '#ff4444';
        const vColor = entry.victimTeam === 'teamA' ? '#4488ff' : '#ff4444';

        const killer = document.createElement('span');
        killer.style.color = kColor;
        killer.textContent = entry.killerName;
        wrapper.appendChild(killer);

        const wep = document.createElement('span');
        if (entry.weapon) {
            wep.style.cssText = 'color:#aaa;font-size:11px';
            wep.textContent = ` [${entry.weapon}] `;
        } else {
            wep.style.color = '#888';
            wep.textContent = ' \u2192 ';
        }
        wrapper.appendChild(wep);

        const victim = document.createElement('span');
        victim.style.color = vColor;
        victim.textContent = entry.victimName;
        wrapper.appendChild(victim);

        if (entry.headshot) {
            const hs = document.createElement('span');
            hs.style.color = '#ffcc00';
            hs.textContent = ' HS';
            wrapper.appendChild(hs);
        }

        const br = document.createElement('br');

        return { wrapper, br };
    }

    /**
     * Add a kill entry.
     */
    addKill(killerName, killerTeam, victimName, victimTeam, headshot = false, weapon = '') {
        const entry = {
            killerName,
            killerTeam,
            victimName,
            victimTeam,
            headshot,
            weapon,
            life: ENTRY_LIFE,
            el: null,
            br: null,
        };
        const { wrapper, br } = this._createEntryEl(entry);
        entry.el = wrapper;
        entry.br = br;
        this.container.appendChild(wrapper);
        this.container.appendChild(br);

        this.entries.push(entry);

        // Trim old entries
        while (this.entries.length > MAX_ENTRIES) {
            const old = this.entries.shift();
            if (old.el.parentNode) old.el.parentNode.removeChild(old.el);
            if (old.br.parentNode) old.br.parentNode.removeChild(old.br);
        }
    }

    update(dt) {
        for (let i = this.entries.length - 1; i >= 0; i--) {
            const e = this.entries[i];
            e.life -= dt;
            if (e.life <= 0) {
                if (e.el.parentNode) e.el.parentNode.removeChild(e.el);
                if (e.br.parentNode) e.br.parentNode.removeChild(e.br);
                this.entries.splice(i, 1);
            } else {
                // Fade in last 1.5s
                const opacity = Math.min(1, e.life / 1.5);
                e.el.style.opacity = opacity;
            }
        }
    }
}
