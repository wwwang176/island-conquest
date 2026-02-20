/**
 * HUDController — extracted from Game.js.
 * Owns all DOM overlay elements and their per-frame updates.
 */
import * as THREE from 'three';
import { WeaponDefs } from '../entities/WeaponDefs.js';

// Module-level reusable objects for damage indicator
const _gDmgFwd = new THREE.Vector3();
const _gDmgQuat = new THREE.Quaternion();
const _gYAxis = new THREE.Vector3(0, 1, 0);

export class HUDController {
    /**
     * @param {import('../core/Game.js').Game} game
     */
    constructor(game) {
        this.game = game;

        // Hit marker timer + scale animation
        this._hitMarkerTimer = 0;
        this._hitMarkerDuration = 0.15;
        this._hitMarkerScale = 1;

        // Kill banner state
        this._killBannerTimer = 0;
        this._killBannerFadeOut = false;

        // Flag banner state
        this._flagBannerTimer = 0;
        this._flagBannerFadeOut = false;

        // Kill streak state
        this._streakCount = 0;
        this._streakTimer = 0;

        // Dirty-check state for DOM writes
        this._lastAmmo = undefined;
        this._lastReloading = undefined;
        this._lastBolting = undefined;
        this._lastWeaponId = undefined;
        this._lastGrenades = undefined;
        this._lastHP = undefined;
        this._lastScoped = false;
        this._lastScoreA = undefined;
        this._lastScoreB = undefined;
        this._lastFlagsA = undefined;
        this._lastFlagsB = undefined;

        // Create all DOM elements
        this._createAllHUD();

        // Initial state: hide player-specific HUD
        this.ammoHUD.style.display = 'none';
        this.healthHUD.style.display = 'none';
        this.crosshair.style.display = 'none';
    }

    // ───── Per-frame update ─────

    update(dt) {
        this._updateScoreHUD();
        this._updateHUD();
        this._updateReloadIndicator();
        this._updateHitMarker(dt);
        this._updateKillBanner(dt);
        this._updateFlagBanner(dt);
        this._updateJoinScreen();
        this._updateVehicleHUD();
    }

    // ───── Public API ─────

    showHitMarker(type = 'hit') {
        const color = type === 'headshot_kill' ? '#ffd700'
            : type === 'kill' ? '#ff4444' : '#ffffff';
        this._hitMarkerDuration = type === 'headshot_kill' ? 0.35
            : type === 'kill' ? 0.30 : 0.15;
        this._hitMarkerTimer = this._hitMarkerDuration;

        // Set line colors
        for (let i = 0; i < this._hitMarkerLines.length; i++) {
            this._hitMarkerLines[i].setAttribute('stroke', color);
        }

        // Scale pop on kill
        if (type === 'kill' || type === 'headshot_kill') {
            this._hitMarkerScale = 1.6;
        } else {
            this._hitMarkerScale = 1;
        }

        this.hitMarker.style.display = 'block';
        this.hitMarker.style.opacity = '1';
        this.hitMarker.style.transform = `translate(-50%,-50%) rotate(45deg) scale(${this._hitMarkerScale})`;
    }

    recordKill(isHeadshot) {
        this._streakCount++;
        this._streakTimer = 4;

        // Pick label: streak text replaces single-kill text
        let text, color, isStreak;
        if (this._streakCount >= 2) {
            const labels = ['', '', 'DOUBLE KILL', 'TRIPLE KILL', 'MULTI KILL', 'RAMPAGE'];
            text = this._streakCount >= labels.length
                ? 'RAMPAGE' : labels[this._streakCount];
            color = '#ffd700';
            isStreak = true;
        } else {
            text = isHeadshot ? 'HEADSHOT' : 'ELIMINATED';
            color = isHeadshot ? '#ffd700' : '#ffffff';
            isStreak = false;
        }

        this._killBannerText.textContent = text;
        this._killBannerText.style.color = color;
        this._killBannerTimer = isStreak ? 2 : 1.5;
        this._killBannerFadeOut = false;

        // Streak: scale pop  /  Single kill: slide up
        if (isStreak) {
            this.killBanner.style.transition = 'transform 0.2s cubic-bezier(0.34,1.56,0.64,1), opacity 0.15s ease-out';
            this.killBanner.style.fontSize = '28px';
            this.killBanner.style.display = 'block';
            this.killBanner.style.opacity = '1';
            this.killBanner.style.transform = 'translateX(-50%) scale(0.5)';
            this.killBanner.offsetHeight; // reflow
            this.killBanner.style.transform = 'translateX(-50%) scale(1)';
        } else {
            this.killBanner.style.transition = 'opacity 0.15s ease-out, transform 0.15s ease-out';
            this.killBanner.style.fontSize = '18px';
            this.killBanner.style.display = 'block';
            this.killBanner.style.opacity = '0';
            this.killBanner.style.transform = 'translateX(-50%) translateY(8px)';
            this.killBanner.offsetHeight; // reflow
            this.killBanner.style.opacity = '1';
            this.killBanner.style.transform = 'translateX(-50%) translateY(0)';
        }
    }

    resetStreak() {
        this._streakCount = 0;
        this._streakTimer = 0;
        this.killBanner.style.display = 'none';
    }

    showFlagBanner(text, color) {
        this._flagBannerText.textContent = text;
        this._flagBannerText.style.color = color;
        this._flagBannerTimer = 2.0;
        this._flagBannerFadeOut = false;

        // Slide-down entrance (from above)
        this.flagBanner.style.transition = 'opacity 0.15s ease-out, transform 0.15s ease-out';
        this.flagBanner.style.display = 'block';
        this.flagBanner.style.opacity = '0';
        this.flagBanner.style.transform = 'translateX(-50%) translateY(-8px)';
        this.flagBanner.offsetHeight; // force reflow
        this.flagBanner.style.opacity = '1';
        this.flagBanner.style.transform = 'translateX(-50%) translateY(0)';
    }

    updateScoreboard() {
        const game = this.game;
        // Ensure every soldier has an entry
        const ensureEntry = (name, team) => {
            if (!game._kdStats.has(name))
                game._kdStats.set(name, { kills: 0, deaths: 0, team, weapon: '' });
        };

        // Register all AI soldiers
        if (game.aiManager.teamA) {
            for (const s of game.aiManager.teamA.soldiers) {
                const name = `A-${s.id}`;
                ensureEntry(name, 'teamA');
                if (s.controller) game._kdStats.get(name).weapon = s.controller.weaponId || '';
            }
        }
        if (game.aiManager.teamB) {
            for (const s of game.aiManager.teamB.soldiers) {
                const name = `B-${s.id}`;
                ensureEntry(name, 'teamB');
                if (s.controller) game._kdStats.get(name).weapon = s.controller.weaponId || '';
            }
        }
        // Register player
        if (game.player && game.player.team) {
            ensureEntry('You', game.player.team);
            game._kdStats.get('You').team = game.player.team;
            game._kdStats.get('You').weapon = game.player.weapon ? game.player.weapon.weaponId : '';
        }

        // Split into teams and sort by kills desc
        const teamA = [];
        const teamB = [];
        for (const [name, stat] of game._kdStats) {
            const entry = { name, ...stat };
            if (stat.team === 'teamA') teamA.push(entry);
            else teamB.push(entry);
        }
        teamA.sort((a, b) => b.kills - a.kills || a.deaths - b.deaths);
        teamB.sort((a, b) => b.kills - a.kills || a.deaths - b.deaths);

        const renderTeam = (entries, teamColor, teamLabel) => {
            let totalK = 0, totalD = 0;
            for (const e of entries) { totalK += e.kills; totalD += e.deaths; }
            let html = `<div style="color:${teamColor};font-weight:bold;font-size:16px;margin-bottom:8px;text-align:center;">${teamLabel}</div>`;
            html += `<div style="display:flex;color:#888;font-size:11px;padding:2px 6px;border-bottom:1px solid rgba(255,255,255,0.1);margin-bottom:2px;">
                <span style="flex:1">Name</span><span style="width:30px;text-align:center">K</span>
                <span style="width:30px;text-align:center">D</span><span style="width:50px;text-align:right">Wpn</span></div>`;
            for (const e of entries) {
                const isPlayer = e.name === 'You';
                const bg = isPlayer ? 'rgba(255,255,255,0.1)' : 'transparent';
                const nameColor = isPlayer ? '#fff' : 'rgba(255,255,255,0.75)';
                const wpn = e.weapon || '-';
                html += `<div style="display:flex;font-size:12px;padding:2px 6px;background:${bg};border-radius:2px;">
                    <span style="flex:1;color:${nameColor};font-weight:${isPlayer ? 'bold' : 'normal'}">${e.name}</span>
                    <span style="width:30px;text-align:center;color:#ccc">${e.kills}</span>
                    <span style="width:30px;text-align:center;color:#ccc">${e.deaths}</span>
                    <span style="width:50px;text-align:right;color:#888;font-size:11px">${wpn}</span></div>`;
            }
            html += `<div style="display:flex;font-size:12px;padding:4px 6px;margin-top:4px;border-top:1px solid rgba(255,255,255,0.1);color:#aaa;">
                <span style="flex:1;font-weight:bold">Total</span>
                <span style="width:30px;text-align:center">${totalK}</span>
                <span style="width:30px;text-align:center">${totalD}</span>
                <span style="width:50px"></span></div>`;
            return html;
        };

        document.getElementById('sb-teamA').innerHTML = renderTeam(teamA, '#4488ff', 'TEAM A');
        document.getElementById('sb-teamB').innerHTML = renderTeam(teamB, '#ff4444', 'TEAM B');
    }

    updateBlockerText() {
        const h1 = this.game.blocker.querySelector('h1');
        const p = this.game.blocker.querySelector('p');
        if (this.game.gameMode === 'spectator') {
            h1.textContent = 'Island Conquest';
            p.innerHTML = 'Click to spectate<br><small style="color:#888">[1] Team A &nbsp; [2] Team B</small>';
        } else {
            h1.textContent = 'Island Conquest';
            p.innerHTML = 'Click to resume<br><small style="color:#888">[Esc] Back to spectator</small>';
        }
    }

    applyUIState(state) {
        const game = this.game;
        const hide = el => { if (el) el.style.display = 'none'; };
        const show = (el, display = 'block') => { if (el) el.style.display = display; };

        switch (state) {
            case 'spectator':
                hide(this.joinScreen);
                hide(this.deathScreen);
                hide(this.scoreboard);
                hide(this.healthHUD);
                hide(this.scopeVignette);
                this._lastScoped = false;
                game.camera.fov = 75;
                game.camera.updateProjectionMatrix();
                this.damageIndicator.style.background = 'none';
                if (game.spectator) game.spectator.hud.show();
                show(this.keyHints);
                if (game.player && game.player.weapon) {
                    game.player.weapon.gunGroup.visible = false;
                    game.player.weapon.muzzleFlash.visible = false;
                }
                this.resetStreak();
                break;

            case 'joining':
                game.blocker.classList.add('hidden');
                hide(this.deathScreen);
                hide(this.scoreboard);
                if (game.spectator) game.spectator.hud.hide();
                hide(this.ammoHUD);
                hide(this.healthHUD);
                hide(this.crosshair);
                hide(this.reloadIndicator);
                this.damageIndicator.style.background = 'none';
                hide(this.keyHints);
                show(this.joinScreen, 'flex');
                if (game.player && game.player.weapon) {
                    game.player.weapon.gunGroup.visible = false;
                    game.player.weapon.muzzleFlash.visible = false;
                }
                break;

            case 'playing':
                game.blocker.classList.add('hidden');
                hide(this.joinScreen);
                hide(this.deathScreen);
                hide(this.scoreboard);
                hide(this.scopeVignette);
                this._lastScoped = false;
                game.camera.fov = 75;
                game.camera.updateProjectionMatrix();
                if (game.spectator) game.spectator.hud.hide();
                hide(this.keyHints);
                show(this.ammoHUD);
                show(this.healthHUD);
                if (game.player && game.player.weapon) {
                    game.player.weapon.gunGroup.visible = true;
                }
                break;

            case 'dead':
                game.blocker.classList.add('hidden');
                hide(this.joinScreen);
                hide(this.scoreboard);
                if (game.spectator) game.spectator.hud.hide();
                hide(this.ammoHUD);
                hide(this.healthHUD);
                hide(this.crosshair);
                hide(this.reloadIndicator);
                hide(this.keyHints);
                hide(this.scopeVignette);
                this._lastScoped = false;
                this.damageIndicator.style.background = 'none';
                show(this.deathScreen, 'flex');
                if (game.player && game.player.weapon) {
                    game.player.weapon.gunGroup.visible = false;
                    game.player.weapon.muzzleFlash.visible = false;
                }
                break;
        }
    }

    // ───── DOM Creation ─────

    _createAllHUD() {
        this._createCrosshair();
        this._createReloadIndicator();
        this._createAmmoHUD();
        this._createHealthHUD();
        this._createScoreHUD();
        this._createDamageIndicator();
        this._createScopeVignette();
        this._createJoinScreen();
        this._createDeathScreen();
        this._createGameOverScreen();
        this._createKeyHints();
        this._createScoreboard();
        this._createVehicleHUD();
        this._createKillBanner();
        this._createFlagBanner();
    }

    _createCrosshair() {
        const el = document.createElement('div');
        el.id = 'crosshair';
        el.style.cssText = `position:fixed;top:50%;left:50%;transform:translate(-50%,-50%);
            width:30px;height:30px;pointer-events:none;z-index:100;`;
        el.innerHTML = `<svg width="30" height="30" viewBox="0 0 20 20">
            <line x1="10" y1="3" x2="10" y2="8" stroke="white" stroke-width="1.2" opacity="0.8"/>
            <line x1="10" y1="12" x2="10" y2="17" stroke="white" stroke-width="1.2" opacity="0.8"/>
            <line x1="3" y1="10" x2="8" y2="10" stroke="white" stroke-width="1.2" opacity="0.8"/>
            <line x1="12" y1="10" x2="17" y2="10" stroke="white" stroke-width="1.2" opacity="0.8"/>
            <circle cx="10" cy="10" r="0.8" fill="white" opacity="0.6"/></svg>`;
        document.body.appendChild(el);
        this.crosshair = el;

        // Hit marker (X shape, 45deg rotated crosshair)
        const hm = document.createElement('div');
        hm.id = 'hit-marker';
        hm.style.cssText = `position:fixed;top:50%;left:50%;transform:translate(-50%,-50%) rotate(45deg);
            width:30px;height:30px;pointer-events:none;z-index:101;display:none;`;
        hm.innerHTML = `<svg width="30" height="30" viewBox="0 0 20 20">
            <line x1="10" y1="2" x2="10" y2="7" stroke="white" stroke-width="1.5"/>
            <line x1="10" y1="13" x2="10" y2="18" stroke="white" stroke-width="1.5"/>
            <line x1="2" y1="10" x2="7" y2="10" stroke="white" stroke-width="1.5"/>
            <line x1="13" y1="10" x2="18" y2="10" stroke="white" stroke-width="1.5"/></svg>`;
        document.body.appendChild(hm);
        this.hitMarker = hm;
        this._hitMarkerLines = hm.querySelectorAll('line');
    }

    _createReloadIndicator() {
        const el = document.createElement('div');
        el.id = 'reload-indicator';
        el.style.cssText = `position:fixed;top:50%;left:50%;transform:translate(-50%,-50%);
            width:40px;height:40px;pointer-events:none;z-index:100;display:none;`;
        el.innerHTML = `<svg width="40" height="40" viewBox="0 0 40 40" style="transform:rotate(-90deg)">
            <circle cx="20" cy="20" r="16" fill="none" stroke="rgba(255,255,255,0.2)" stroke-width="3"/>
            <circle id="reload-arc" cx="20" cy="20" r="16" fill="none" stroke="white" stroke-width="3"
                stroke-dasharray="100.53" stroke-dashoffset="100.53" stroke-linecap="round" opacity="0.85"/>
        </svg>`;
        document.body.appendChild(el);
        this.reloadIndicator = el;
        this.reloadArc = null; // lazy-cached
    }

    _createAmmoHUD() {
        const el = document.createElement('div');
        el.id = 'ammo-hud';
        el.style.cssText = `position:fixed;bottom:30px;right:30px;color:white;
            font-family:Consolas,monospace;font-size:16px;background:rgba(0,0,0,0.5);
            padding:12px 18px;border-radius:6px;pointer-events:none;z-index:100;min-width:120px;`;
        document.body.appendChild(el);
        this.ammoHUD = el;
    }

    _createHealthHUD() {
        const el = document.createElement('div');
        el.id = 'health-hud';
        el.style.cssText = `position:fixed;bottom:30px;left:30px;color:white;
            font-family:Consolas,monospace;background:rgba(0,0,0,0.5);
            padding:12px 18px;border-radius:6px;pointer-events:none;z-index:100;min-width:150px;`;
        document.body.appendChild(el);
        this.healthHUD = el;
    }

    _createScoreHUD() {
        const el = document.createElement('div');
        el.id = 'score-hud';
        el.style.cssText = `position:fixed;top:15px;left:50%;transform:translateX(-50%);
            color:white;font-family:Consolas,monospace;font-size:18px;
            background:rgba(0,0,0,0.5);padding:8px 24px;border-radius:6px;
            pointer-events:none;z-index:100;text-align:center;`;
        document.body.appendChild(el);
        this.scoreHUD = el;
    }

    _createDamageIndicator() {
        const el = document.createElement('div');
        el.id = 'damage-indicator';
        el.style.cssText = `position:fixed;top:0;left:0;width:100%;height:100%;
            pointer-events:none;z-index:99;`;
        document.body.appendChild(el);
        this.damageIndicator = el;
    }

    _createScopeVignette() {
        const el = document.createElement('div');
        el.id = 'scope-vignette';
        el.style.cssText = `position:fixed;top:0;left:0;width:100%;height:100%;
            pointer-events:none;z-index:98;display:none;
            background:radial-gradient(circle, transparent 30%, rgba(0,0,0,0.9) 70%);`;
        el.innerHTML = `
            <div style="position:absolute;top:50%;left:0;width:100%;height:1px;background:rgba(255,255,255,0.5);"></div>
            <div style="position:absolute;top:0;left:50%;width:1px;height:100%;background:rgba(255,255,255,0.5);"></div>
            <div style="position:absolute;top:50%;left:50%;width:6px;height:6px;transform:translate(-50%,-50%);
                border:1px solid rgba(255,255,255,0.6);border-radius:50%;"></div>`;
        document.body.appendChild(el);
        this.scopeVignette = el;
    }

    _weaponStatBars(weaponId) {
        const def = WeaponDefs[weaponId];
        let maxDmg = 0, maxRof = 0, maxRng = 0, maxSpread = 0, maxMob = 0;
        for (const k in WeaponDefs) {
            const w = WeaponDefs[k];
            if (!w.fireRate) continue;
            if (w.damage > maxDmg) maxDmg = w.damage;
            if (w.fireRate > maxRof) maxRof = w.fireRate;
            if (w.maxRange > maxRng) maxRng = w.maxRange;
            if (w.baseSpread > maxSpread) maxSpread = w.baseSpread;
            if ((w.moveSpeedMult || 1) > maxMob) maxMob = w.moveSpeedMult || 1;
        }
        const stats = [
            ['DMG', def.damage / maxDmg],
            ['ROF', def.fireRate / maxRof],
            ['RNG', def.maxRange / maxRng],
            ['ACC', 1 - def.baseSpread / (maxSpread * 1.25)],
            ['MOB', (def.moveSpeedMult || 1) / maxMob],
        ];
        const barW = 64;
        return stats.map(([label, ratio]) => {
            const pct = Math.round(Math.min(1, Math.max(0, ratio)) * 100);
            return `<div style="display:flex;align-items:center;gap:5px;margin-top:3px;">
                <span style="font-size:9px;color:#888;width:24px;text-align:right;">${label}</span>
                <div style="width:${barW}px;height:5px;background:rgba(255,255,255,0.12);border-radius:2px;overflow:hidden;">
                    <div style="width:${pct}%;height:100%;background:rgba(255,255,255,0.6);border-radius:2px;"></div>
                </div>
                <span style="font-size:9px;color:#aaa;width:20px;text-align:right;">${pct}</span>
            </div>`;
        }).join('');
    }

    _weaponCardHTML(idPrefix, num, weaponId, shortId, selected) {
        const def = WeaponDefs[weaponId];
        const border = selected ? '#4488ff' : '#888';
        const bg = selected ? 'rgba(68,136,255,0.15)' : 'transparent';
        return `<div id="${idPrefix}-${shortId}" style="border:2px solid ${border};border-radius:8px;padding:10px 14px;
            background:${bg};cursor:default;min-width:140px;">
            <div style="font-size:16px;font-weight:bold;">[${num}] ${def.name}</div>
            <div style="font-size:11px;color:#aaa;margin-top:3px;">${def.fireRate} RPM &middot; ${def.magazineSize} rds</div>
            ${this._weaponStatBars(weaponId)}
        </div>`;
    }

    _createJoinScreen() {
        const el = document.createElement('div');
        el.id = 'join-screen';
        el.style.cssText = `position:fixed;top:0;left:0;width:100%;height:100%;
            background:rgba(0,0,0,0.5);display:none;align-items:center;justify-content:center;
            flex-direction:column;pointer-events:none;z-index:101;`;
        el.innerHTML = `
            <div style="color:white;font-family:Arial,sans-serif;text-align:center;">
                <div id="join-team-label" style="font-size:28px;font-weight:bold;margin-bottom:16px;"></div>
                <div style="font-size:14px;color:#aaa;margin-bottom:8px;">Select weapon:</div>
                <div style="display:flex;gap:12px;justify-content:center;">
                    ${this._weaponCardHTML('join-wp', 1, 'AR15', 'ar', true)}
                    ${this._weaponCardHTML('join-wp', 2, 'SMG', 'smg', false)}
                    ${this._weaponCardHTML('join-wp', 3, 'LMG', 'lmg', false)}
                    ${this._weaponCardHTML('join-wp', 4, 'BOLT', 'bolt', false)}
                </div>
                <div style="font-size:16px;color:#aaa;margin-top:14px;">
                    Press <b>SPACE</b> to deploy &nbsp; | &nbsp; <b>ESC</b> to cancel
                </div>
            </div>`;
        document.body.appendChild(el);
        this.joinScreen = el;
        this._joinWpEls = {
            AR15: document.getElementById('join-wp-ar'),
            SMG: document.getElementById('join-wp-smg'),
            LMG: document.getElementById('join-wp-lmg'),
            BOLT: document.getElementById('join-wp-bolt'),
        };
        this._lastJoinWeapon = null;
    }

    _createDeathScreen() {
        const el = document.createElement('div');
        el.id = 'death-screen';
        el.style.cssText = `position:fixed;top:0;left:0;width:100%;height:100%;
            background:rgba(139,0,0,0.3);display:none;align-items:center;justify-content:center;
            flex-direction:column;pointer-events:none;z-index:101;`;
        el.innerHTML = `
            <div style="color:white;font-family:Arial,sans-serif;text-align:center;">
                <div style="font-size:36px;font-weight:bold;margin-bottom:10px;">YOU DIED</div>
                <div id="respawn-timer" style="font-size:20px;color:#ccc;"></div>
                <div id="weapon-select" style="display:none;margin-top:18px;">
                    <div style="font-size:14px;color:#aaa;margin-bottom:8px;">Select weapon:</div>
                    <div style="display:flex;gap:12px;justify-content:center;">
                        ${this._weaponCardHTML('weapon', 1, 'AR15', 'ar', true)}
                        ${this._weaponCardHTML('weapon', 2, 'SMG', 'smg', false)}
                        ${this._weaponCardHTML('weapon', 3, 'LMG', 'lmg', false)}
                        ${this._weaponCardHTML('weapon', 4, 'BOLT', 'bolt', false)}
                    </div>
                </div>
                <div id="respawn-prompt" style="font-size:16px;color:#aaa;margin-top:10px;display:none;">
                    Press <b>SPACE</b> to respawn &nbsp; | &nbsp; <b>ESC</b> to spectate
                </div>
            </div>`;
        document.body.appendChild(el);
        this.deathScreen = el;
        this._deathTimer = document.getElementById('respawn-timer');
        this._deathPrompt = document.getElementById('respawn-prompt');
        this._deathWeaponSelect = document.getElementById('weapon-select');
        this._deathWpEls = {
            AR15: document.getElementById('weapon-ar'),
            SMG: document.getElementById('weapon-smg'),
            LMG: document.getElementById('weapon-lmg'),
            BOLT: document.getElementById('weapon-bolt'),
        };
        this._lastDeathWeapon = null;
    }

    _createGameOverScreen() {
        const el = document.createElement('div');
        el.id = 'game-over';
        el.style.cssText = `position:fixed;top:0;left:0;width:100%;height:100%;
            background:rgba(0,0,0,0.8);display:none;align-items:center;justify-content:center;
            flex-direction:column;z-index:200;`;
        el.innerHTML = `
            <div style="color:white;font-family:Arial,sans-serif;text-align:center;">
                <div id="winner-text" style="font-size:48px;font-weight:bold;margin-bottom:20px;"></div>
                <div id="final-score" style="font-size:24px;color:#ccc;"></div>
            </div>`;
        document.body.appendChild(el);
        this.gameOverScreen = el;
    }

    _createKeyHints() {
        const el = document.createElement('div');
        el.id = 'key-hints';
        el.style.cssText = `position:fixed;bottom:12px;left:12px;
            font-family:Consolas,monospace;font-size:12px;color:rgba(255,255,255,0.5);
            line-height:1.6;pointer-events:none;z-index:100;`;
        el.innerHTML = [
            '<b style="color:rgba(255,255,255,0.7)">Keys</b>',
            '<span style="color:#fff">T</span> Threat map',
            '<span style="color:#fff">B</span> NavGrid',
            '<span style="color:#fff">P</span> A* paths',
            '<span style="color:#fff">I</span> Intel contacts',
            '<span style="color:#fff">N</span> Tactic labels',
            '<span style="color:#fff">Q</span> Next COM',
            '<span style="color:#fff">V</span> Camera mode',
            '<span style="color:#fff">E</span> Enter/exit vehicle',
            '<span style="color:#fff">1/2</span> Join team',
            '<span style="color:#fff">Esc</span> Leave team',
        ].join('<br>');
        document.body.appendChild(el);
        this.keyHints = el;
    }

    _createScoreboard() {
        const el = document.createElement('div');
        el.id = 'scoreboard';
        el.style.cssText = `position:fixed;top:50%;left:50%;transform:translate(-50%,-50%);
            background:rgba(0,0,0,0.8);border-radius:10px;padding:20px 28px;
            display:none;align-items:flex-start;gap:32px;
            pointer-events:none;z-index:150;font-family:Consolas,monospace;
            min-width:600px;backdrop-filter:blur(4px);border:1px solid rgba(255,255,255,0.1);`;
        el.innerHTML = `
            <div id="sb-teamA" style="flex:1;min-width:260px;"></div>
            <div style="width:1px;background:rgba(255,255,255,0.15);align-self:stretch;"></div>
            <div id="sb-teamB" style="flex:1;min-width:260px;"></div>`;
        document.body.appendChild(el);
        this.scoreboard = el;
    }

    _createVehicleHUD() {
        const el = document.createElement('div');
        el.id = 'vehicle-hud';
        el.style.cssText = `position:fixed;bottom:80px;left:50%;transform:translateX(-50%);
            color:white;font-family:Consolas,monospace;background:rgba(0,0,0,0.5);
            padding:10px 20px;border-radius:6px;pointer-events:none;z-index:100;
            text-align:center;display:none;`;
        el.innerHTML = `
            <div id="vhud-title" style="font-size:14px;font-weight:bold;margin-bottom:4px"></div>
            <div style="width:200px;height:8px;background:#333;border-radius:4px;margin:4px auto;">
                <div id="vhud-hp-bar" style="height:100%;border-radius:4px;"></div>
            </div>
            <div id="vhud-controls" style="font-size:11px;color:#aaa;margin-top:4px"></div>`;
        document.body.appendChild(el);
        this.vehicleHUD = el;
        this._vhudTitle = document.getElementById('vhud-title');
        this._vhudHpBar = document.getElementById('vhud-hp-bar');
        this._vhudControls = document.getElementById('vhud-controls');
        this._lastVehicleTitle = null;
        this._lastVehicleHpPct = -1;
    }

    _createKillBanner() {
        const el = document.createElement('div');
        el.id = 'kill-banner';
        el.style.cssText = `position:fixed;top:calc(50% + 60px);left:50%;transform:translateX(-50%);
            pointer-events:none;z-index:102;display:none;
            font-family:Arial,sans-serif;font-size:18px;font-weight:bold;
            text-shadow:0 0 6px rgba(0,0,0,0.8);letter-spacing:2px;
            transition:opacity 0.15s ease-out, transform 0.15s ease-out;`;
        const span = document.createElement('span');
        el.appendChild(span);
        document.body.appendChild(el);
        this.killBanner = el;
        this._killBannerText = span;
    }

    _createFlagBanner() {
        const el = document.createElement('div');
        el.id = 'flag-banner';
        el.style.cssText = `position:fixed;top:25%;left:50%;transform:translateX(-50%);
            pointer-events:none;z-index:102;display:none;
            font-family:Consolas,monospace;font-size:20px;font-weight:bold;
            letter-spacing:2px;background:rgba(0,0,0,0.5);padding:8px 24px;border-radius:6px;
            transition:opacity 0.15s ease-out, transform 0.15s ease-out;`;
        const span = document.createElement('span');
        el.appendChild(span);
        document.body.appendChild(el);
        this.flagBanner = el;
        this._flagBannerText = span;
    }

    // ───── Per-frame update methods ─────

    _updateHitMarker(dt) {
        if (this._hitMarkerTimer > 0) {
            this._hitMarkerTimer -= dt;
            if (this._hitMarkerTimer <= 0) {
                this.hitMarker.style.display = 'none';
            } else {
                this.hitMarker.style.opacity = String(Math.min(1, this._hitMarkerTimer / 0.08));
                // Scale pop decay back to 1.0
                if (this._hitMarkerScale > 1) {
                    this._hitMarkerScale = Math.max(1, this._hitMarkerScale - dt * 6);
                    this.hitMarker.style.transform = `translate(-50%,-50%) rotate(45deg) scale(${this._hitMarkerScale})`;
                }
            }
        }
    }

    _updateKillBanner(dt) {
        // Streak window countdown (independent of display timer)
        if (this._streakTimer > 0) {
            this._streakTimer -= dt;
            if (this._streakTimer <= 0) {
                this._streakCount = 0;
            }
        }
        if (this._killBannerTimer <= 0) return;
        this._killBannerTimer -= dt;
        if (this._killBannerTimer <= 0.3 && !this._killBannerFadeOut) {
            this._killBannerFadeOut = true;
            this.killBanner.style.opacity = '0';
            this.killBanner.style.transform = 'translateX(-50%) translateY(-8px)';
        }
        if (this._killBannerTimer <= 0) {
            this.killBanner.style.display = 'none';
            this._killBannerTimer = 0;
        }
    }

    _updateFlagBanner(dt) {
        if (this._flagBannerTimer <= 0) return;
        this._flagBannerTimer -= dt;
        if (this._flagBannerTimer <= 0.3 && !this._flagBannerFadeOut) {
            this._flagBannerFadeOut = true;
            this.flagBanner.style.opacity = '0';
            this.flagBanner.style.transform = 'translateX(-50%) translateY(-8px)';
        }
        if (this._flagBannerTimer <= 0) {
            this.flagBanner.style.display = 'none';
            this._flagBannerTimer = 0;
        }
    }

    _updateJoinScreen() {
        if (this.game.gameMode !== 'joining') return;
        const sel = this.game._pendingWeapon;
        if (sel === this._lastJoinWeapon) return;
        this._lastJoinWeapon = sel;
        for (const wep of ['AR15', 'SMG', 'LMG', 'BOLT']) {
            const el = this._joinWpEls[wep];
            el.style.borderColor = sel === wep ? '#4488ff' : '#888';
            el.style.background = sel === wep ? 'rgba(68,136,255,0.15)' : 'transparent';
        }
    }

    _updateVehicleHUD() {
        const game = this.game;
        if (!game.player || !game.player.vehicle || game.gameMode !== 'playing') {
            if (this._lastVehicleTitle) {
                this.vehicleHUD.style.display = 'none';
                this._lastVehicleTitle = null;
                this._lastVehicleHpPct = -1;
            }
            return;
        }

        const v = game.player.vehicle;
        this.vehicleHUD.style.display = 'block';

        const isPilot = v.driver === game.player;
        const occ = v.occupantCount || 1;
        const typeName = `HELICOPTER [${occ}/4]` + (isPilot ? ' PILOT' : ' GUNNER');
        if (typeName !== this._lastVehicleTitle) {
            this._lastVehicleTitle = typeName;
            this._vhudTitle.textContent = typeName;
            this._vhudControls.textContent = isPilot
                ? 'WASD Move | Space Up | Shift Down | E Exit'
                : 'Mouse Aim | LMB Fire | E Exit';
        }

        const hpPct = Math.round(Math.max(0, v.hp / v.maxHP * 100));
        if (hpPct !== this._lastVehicleHpPct) {
            this._lastVehicleHpPct = hpPct;
            const hpColor = hpPct > 50 ? '#4f4' : hpPct > 25 ? '#ff4' : '#f44';
            this._vhudHpBar.style.width = hpPct + '%';
            this._vhudHpBar.style.background = hpColor;
        }
    }

    _updateReloadIndicator() {
        const game = this.game;
        let isReloading = false;
        let progress = 0;

        if (game.gameMode === 'playing' && game.player && game.player.alive) {
            const w = game.player.weapon;
            if (w.isReloading) {
                isReloading = true;
                progress = 1 - w.reloadTimer / w.reloadTime;
            } else if (w.isBolting && w.def.boltTime) {
                isReloading = true;
                progress = 1 - w.boltTimer / w.def.boltTime;
            }
        } else if (game.gameMode === 'spectator' && game.spectator && game.spectator.mode === 'follow') {
            const target = game.spectator.getCurrentTarget();
            if (target) {
                const ctrl = target.controller;
                if (ctrl.isReloading) {
                    isReloading = true;
                    progress = 1 - ctrl.reloadTimer / ctrl.reloadTime;
                } else if (ctrl.boltTimer > 0 && ctrl.weaponDef.boltTime) {
                    isReloading = true;
                    progress = 1 - ctrl.boltTimer / ctrl.weaponDef.boltTime;
                }
            }
        }

        // Check if scoped (hide crosshair — scope overlay has its own crosshair)
        let isAnyScoped = false;
        if (game.gameMode === 'playing' && game.player && game.player.weapon) {
            isAnyScoped = game.player.weapon.isScoped;
        } else if (game.gameMode === 'spectator' && game.spectator && game.spectator.mode === 'follow') {
            const target = game.spectator.getCurrentTarget();
            if (target) isAnyScoped = target.controller.isScoped;
        }

        if (isReloading) {
            this.crosshair.style.display = 'none';
            this.reloadIndicator.style.display = 'block';
            if (!this.reloadArc) this.reloadArc = document.getElementById('reload-arc');
            const circ = 100.53;
            this.reloadArc.setAttribute('stroke-dashoffset', circ * (1 - progress));
        } else {
            this.reloadIndicator.style.display = 'none';
            const showCrosshair = !isAnyScoped && (
                game.gameMode === 'playing'
                || (game.gameMode === 'spectator' && game.spectator && game.spectator.mode === 'follow'));
            this.crosshair.style.display = showCrosshair ? 'block' : 'none';
        }
    }

    _updateHUD() {
        const game = this.game;

        // ── Spectator follow mode: show observed soldier's ammo HUD ──
        if (game.gameMode === 'spectator') {
            const isFollow = game.spectator && game.spectator.mode === 'follow';
            if (isFollow) {
                const target = game.spectator.getCurrentTarget();
                if (target) {
                    this.ammoHUD.style.display = 'block';
                    const ctrl = target.controller;
                    const curAmmo = ctrl.currentAmmo;
                    const curReloading = ctrl.isReloading;
                    const curBolting = ctrl.boltTimer > 0;
                    const curWeaponId = ctrl.weaponId;
                    const curGrenades = ctrl.grenadeCount;
                    if (curAmmo !== this._lastAmmo || curReloading !== this._lastReloading
                        || curBolting !== this._lastBolting
                        || curWeaponId !== this._lastWeaponId || curGrenades !== this._lastGrenades) {
                        this._lastAmmo = curAmmo;
                        this._lastReloading = curReloading;
                        this._lastBolting = curBolting;
                        this._lastWeaponId = curWeaponId;
                        this._lastGrenades = curGrenades;
                        const statusText = curReloading ? `<span style="color:#ffaa00">RELOADING...</span>`
                            : curBolting ? `<span style="color:#ffaa00">BOLTING...</span>` : '';
                        const grenadeText = `<div style="font-size:13px;color:#aaa;margin-top:6px">&#x1F4A3; ${curGrenades}</div>`;
                        this.ammoHUD.innerHTML = `
                            <div style="font-size:12px;color:#aaa;margin-bottom:4px">${ctrl.weaponDef.name}</div>
                            <div style="font-size:28px;font-weight:bold">
                                ${curAmmo}<span style="font-size:16px;color:#888"> / ${ctrl.magazineSize}</span>
                            </div>${statusText}${grenadeText}`;
                    }
                } else {
                    this.ammoHUD.style.display = 'none';
                }
            } else {
                this.ammoHUD.style.display = 'none';
            }
            // Scope vignette + FOV for spectated BOLT COM
            if (isFollow && game.spectator._initialized) {
                const target = game.spectator.getCurrentTarget();
                const comScoped = target && target.controller.isScoped;
                if (comScoped !== this._lastScoped) {
                    this._lastScoped = comScoped;
                    this.scopeVignette.style.display = comScoped ? 'block' : 'none';
                    game.camera.fov = comScoped ? (target.controller.weaponDef.scopeFOV || 20) : 75;
                    game.camera.updateProjectionMatrix();
                }
            } else if (this._lastScoped) {
                this._lastScoped = false;
                this.scopeVignette.style.display = 'none';
                game.camera.fov = 75;
                game.camera.updateProjectionMatrix();
            }

            this._updateDamageIndicator();
            return;
        }

        if (!game.player) return;

        // Death screen check (works in both 'playing' and 'dead' states)
        this._updateDeathScreen();

        // Skip ammo/health updates when dead
        if (game.gameMode === 'dead') return;

        const p = game.player;
        const w = p.weapon;

        // Ammo + grenade — only update DOM when values change
        const curAmmo = w.currentAmmo;
        const curReloading = w.isReloading;
        const curBolting = w.isBolting;
        const curWeaponId = w.weaponId;
        const curGrenades = p.grenadeCount;
        if (curAmmo !== this._lastAmmo || curReloading !== this._lastReloading
            || curBolting !== this._lastBolting
            || curWeaponId !== this._lastWeaponId || curGrenades !== this._lastGrenades) {
            this._lastAmmo = curAmmo;
            this._lastReloading = curReloading;
            this._lastBolting = curBolting;
            this._lastWeaponId = curWeaponId;
            this._lastGrenades = curGrenades;
            const statusText = curReloading ? `<span style="color:#ffaa00">RELOADING...</span>`
                : curBolting ? `<span style="color:#ffaa00">BOLTING...</span>` : '';
            const grenadeText = `<div style="font-size:13px;color:#aaa;margin-top:6px">&#x1F4A3; ${curGrenades}</div>`;
            this.ammoHUD.innerHTML = `
                <div style="font-size:12px;color:#aaa;margin-bottom:4px">${w.def.name}</div>
                <div style="font-size:28px;font-weight:bold">
                    ${curAmmo}<span style="font-size:16px;color:#888"> / ${w.magazineSize}</span>
                </div>${statusText}${grenadeText}`;
        }

        // Health — only update DOM when value changes
        const curHP = Math.round(p.hp);
        if (curHP !== this._lastHP) {
            this._lastHP = curHP;
            const hpColor = curHP > 60 ? '#4f4' : curHP > 30 ? '#ff4' : '#f44';
            const barWidth = Math.max(0, p.hp / p.maxHP * 100);
            this.healthHUD.innerHTML = `
                <div style="font-size:12px;color:#aaa;margin-bottom:4px">HEALTH</div>
                <div style="font-size:28px;font-weight:bold;color:${hpColor}">${curHP}</div>
                <div style="width:120px;height:6px;background:#333;border-radius:3px;margin-top:4px;">
                    <div style="width:${barWidth}%;height:100%;background:${hpColor};border-radius:3px;"></div>
                </div>`;
        }

        // Scope vignette
        const isScoped = w.isScoped;
        if (isScoped !== this._lastScoped) {
            this._lastScoped = isScoped;
            this.scopeVignette.style.display = isScoped ? 'block' : 'none';
        }

        // Damage direction indicator
        this._updateDamageIndicator();
    }

    _updateScoreHUD() {
        const game = this.game;
        const s = game.scoreManager.scores;
        let aFlagCount = 0, bFlagCount = 0;
        for (const f of game.flags) {
            if (f.owner === 'teamA') aFlagCount++;
            else if (f.owner === 'teamB') bFlagCount++;
        }
        if (s.teamA === this._lastScoreA && s.teamB === this._lastScoreB &&
            aFlagCount === this._lastFlagsA && bFlagCount === this._lastFlagsB) return;
        this._lastScoreA = s.teamA;
        this._lastScoreB = s.teamB;
        this._lastFlagsA = aFlagCount;
        this._lastFlagsB = bFlagCount;
        this.scoreHUD.innerHTML = `
            <span style="color:#4488ff;font-weight:bold">${s.teamA}</span>
            <span style="color:#aaa;font-size:14px;margin:0 6px">
                Team A [${aFlagCount}] &mdash; [${bFlagCount}] Team B
            </span>
            <span style="color:#ff4444;font-weight:bold">${s.teamB}</span>`;
    }

    _updateDamageIndicator() {
        const game = this.game;
        let timer = 0;
        let dmgDir = null;
        let camYaw = 0;

        if (game.gameMode === 'playing' && game.player) {
            timer = game.player.damageIndicatorTimer;
            dmgDir = game.player.lastDamageDirection;
            camYaw = game.player.yaw;
        } else if ((game.gameMode === 'spectator' || game.gameMode === 'joining') &&
                   game.spectator.mode === 'follow') {
            const target = game.spectator.getCurrentTarget();
            if (target) {
                timer = target.soldier.damageIndicatorTimer;
                dmgDir = target.soldier.lastDamageDirection;
                camYaw = game.spectator._lerpYaw;
            }
        }

        if (timer > 0 && dmgDir) {
            const opacity = Math.min(1, timer) * 0.6;

            _gDmgFwd.set(0, 0, -1);
            _gDmgQuat.setFromAxisAngle(_gYAxis, camYaw);
            const forward = _gDmgFwd.applyQuaternion(_gDmgQuat);

            const angle = Math.atan2(dmgDir.x, dmgDir.z) - Math.atan2(forward.x, forward.z);

            const gradAngle = (-angle * 180 / Math.PI + 90);
            this.damageIndicator.style.background = `
                linear-gradient(${gradAngle}deg,
                rgba(255,0,0,${opacity}) 0%,
                transparent 30%,
                transparent 100%)`;
            this.damageIndicator.style.display = 'block';
        } else {
            this.damageIndicator.style.background = 'none';
        }
    }

    _updateDeathScreen() {
        const game = this.game;
        if (!game.player || (game.gameMode !== 'playing' && game.gameMode !== 'dead')) return;
        const p = game.player;
        if (!p.alive) {
            // Transition to dead state once
            if (game.gameMode !== 'dead') {
                game.gameMode = 'dead';
                this.applyUIState('dead');
                this._lastDeathWeapon = null;
            }
            if (p.canRespawn()) {
                this._deathTimer.textContent = '';
                this._deathPrompt.style.display = 'block';
                this._deathWeaponSelect.style.display = 'block';

                // Weapon selection via keys
                if (game.input.isKeyDown('Digit1')) p.selectedWeaponId = 'AR15';
                if (game.input.isKeyDown('Digit2')) p.selectedWeaponId = 'SMG';
                if (game.input.isKeyDown('Digit3')) p.selectedWeaponId = 'LMG';
                if (game.input.isKeyDown('Digit4')) p.selectedWeaponId = 'BOLT';

                // Highlight selected weapon — only update DOM when selection changes
                const sel = p.selectedWeaponId;
                if (sel !== this._lastDeathWeapon) {
                    this._lastDeathWeapon = sel;
                    for (const wep of ['AR15', 'SMG', 'LMG', 'BOLT']) {
                        const el = this._deathWpEls[wep];
                        el.style.borderColor = sel === wep ? '#4488ff' : '#888';
                        el.style.background = sel === wep ? 'rgba(68,136,255,0.15)' : 'transparent';
                    }
                }

                if (game.input.isKeyDown('Space')) {
                    const spawnPos = game.aiManager.findSafeSpawn(p.team);
                    if (spawnPos) {
                        p.respawn(spawnPos);
                        game.gameMode = 'playing';
                        this.applyUIState('playing');
                        game.input.requestPointerLock();
                    }
                }
            } else {
                this._deathTimer.textContent = `Respawn in ${Math.ceil(p.deathTimer)}s`;
                this._deathPrompt.style.display = 'none';
                this._deathWeaponSelect.style.display = 'none';
            }
        }
    }
}
