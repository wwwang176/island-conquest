import { describe, it, expect } from 'vitest';
import { computeHitDamage, applyHealthRegen } from '../src/shared/DamageModel.js';

describe('computeHitDamage', () => {
    it('body hit deals 1× damage', () => {
        const r = computeHitDamage(30, 1.0, 0);
        expect(r.actualDamage).toBe(30);
        expect(r.headshot).toBe(false);
        expect(r.legshot).toBe(false);
    });

    it('headshot deals 2× damage', () => {
        const r = computeHitDamage(30, 1.5, 0);
        expect(r.actualDamage).toBe(60);
        expect(r.headshot).toBe(true);
        expect(r.legshot).toBe(false);
    });

    it('legshot deals 0.5× damage', () => {
        const r = computeHitDamage(30, 0.5, 0);
        expect(r.actualDamage).toBe(15);
        expect(r.headshot).toBe(false);
        expect(r.legshot).toBe(true);
    });

    it('hitY=null (explosion) deals 1× damage, no headshot/legshot', () => {
        const r = computeHitDamage(50, null, 0);
        expect(r.actualDamage).toBe(50);
        expect(r.headshot).toBe(false);
        expect(r.legshot).toBe(false);
    });

    it('respects non-zero baseY', () => {
        // baseY = 10, hitY = 11.5 → headshot (11.5 >= 10 + 1.45)
        const r = computeHitDamage(20, 11.5, 10);
        expect(r.headshot).toBe(true);
        expect(r.actualDamage).toBe(40);
    });

    it('body hit just below headshot threshold', () => {
        // baseY = 0, hitY = 1.44 → not headshot
        const r = computeHitDamage(30, 1.44, 0);
        expect(r.headshot).toBe(false);
        expect(r.legshot).toBe(false);
        expect(r.actualDamage).toBe(30);
    });
});

describe('applyHealthRegen', () => {
    function makeEntity(overrides = {}) {
        return {
            hp: 50,
            maxHP: 100,
            timeSinceLastDamage: 0,
            regenDelay: 5,
            regenRate: 10,
            ...overrides,
        };
    }

    it('does not regen during delay period', () => {
        const e = makeEntity({ timeSinceLastDamage: 0 });
        applyHealthRegen(e, 2);
        expect(e.hp).toBe(50); // still within delay
        expect(e.timeSinceLastDamage).toBe(2);
    });

    it('regens after delay period', () => {
        const e = makeEntity({ timeSinceLastDamage: 4.5 });
        applyHealthRegen(e, 1); // timeSinceLastDamage becomes 5.5 (>= 5)
        expect(e.hp).toBeGreaterThan(50);
        expect(e.hp).toBeCloseTo(60, 1); // 50 + 10 * 1
    });

    it('does not exceed maxHP', () => {
        const e = makeEntity({ hp: 95, timeSinceLastDamage: 10 });
        applyHealthRegen(e, 2); // would be 95 + 20 = 115, clamped to 100
        expect(e.hp).toBe(100);
    });

    it('does not regen when already at maxHP', () => {
        const e = makeEntity({ hp: 100, timeSinceLastDamage: 10 });
        applyHealthRegen(e, 1);
        expect(e.hp).toBe(100);
    });
});
