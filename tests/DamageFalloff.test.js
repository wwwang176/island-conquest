import { describe, it, expect } from 'vitest';
import { applyFalloff } from '../src/shared/DamageFalloff.js';

describe('applyFalloff', () => {
    const base = 30;
    const start = 50;
    const end = 100;
    const minScale = 0.4;

    it('no falloff when distance < falloffStart', () => {
        expect(applyFalloff(base, 30, start, end, minScale)).toBe(30);
    });

    it('no falloff when distance = falloffStart', () => {
        expect(applyFalloff(base, 50, start, end, minScale)).toBe(30);
    });

    it('minimum damage at falloffEnd', () => {
        expect(applyFalloff(base, 100, start, end, minScale)).toBeCloseTo(30 * 0.4, 5);
    });

    it('linear interpolation at midpoint', () => {
        // t = 0.5 → dmg = 30 * (1 - 0.5 * 0.6) = 30 * 0.7 = 21
        expect(applyFalloff(base, 75, start, end, minScale)).toBeCloseTo(21, 5);
    });

    it('does not go below minimum beyond falloffEnd', () => {
        expect(applyFalloff(base, 200, start, end, minScale)).toBeCloseTo(30 * 0.4, 5);
    });

    it('handles zero distance', () => {
        expect(applyFalloff(base, 0, start, end, minScale)).toBe(30);
    });
});
