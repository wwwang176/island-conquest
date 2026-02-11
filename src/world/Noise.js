/**
 * Simple 2D value noise with multiple octaves for terrain generation.
 * Deterministic based on seed.
 */
export class Noise {
    constructor(seed = Math.random() * 65536) {
        this.seed = seed;
        this.perm = new Uint8Array(512);
        this._initPermutation();
    }

    _initPermutation() {
        const p = new Uint8Array(256);
        for (let i = 0; i < 256; i++) p[i] = i;
        // Fisher-Yates shuffle with seed
        let s = this.seed | 0;
        for (let i = 255; i > 0; i--) {
            s = (s * 16807 + 0) % 2147483647;
            const j = s % (i + 1);
            [p[i], p[j]] = [p[j], p[i]];
        }
        for (let i = 0; i < 512; i++) this.perm[i] = p[i & 255];
    }

    _grad(hash, x, y) {
        const h = hash & 3;
        const u = h < 2 ? x : -x;
        const v = h === 0 || h === 3 ? y : -y;
        return u + v;
    }

    _fade(t) {
        return t * t * t * (t * (t * 6 - 15) + 10);
    }

    _lerp(a, b, t) {
        return a + t * (b - a);
    }

    /**
     * Single octave 2D noise, returns -1 to 1
     */
    noise2D(x, y) {
        const xi = Math.floor(x) & 255;
        const yi = Math.floor(y) & 255;
        const xf = x - Math.floor(x);
        const yf = y - Math.floor(y);
        const u = this._fade(xf);
        const v = this._fade(yf);

        const p = this.perm;
        const aa = p[p[xi] + yi];
        const ab = p[p[xi] + yi + 1];
        const ba = p[p[xi + 1] + yi];
        const bb = p[p[xi + 1] + yi + 1];

        return this._lerp(
            this._lerp(this._grad(aa, xf, yf), this._grad(ba, xf - 1, yf), u),
            this._lerp(this._grad(ab, xf, yf - 1), this._grad(bb, xf - 1, yf - 1), u),
            v
        );
    }

    /**
     * Multi-octave fractal noise (fBm)
     * @param {number} x
     * @param {number} y
     * @param {number} octaves - number of layers
     * @param {number} lacunarity - frequency multiplier per octave
     * @param {number} persistence - amplitude multiplier per octave
     * @returns {number} value roughly in -1 to 1
     */
    fbm(x, y, octaves = 4, lacunarity = 2, persistence = 0.5) {
        let value = 0;
        let amplitude = 1;
        let frequency = 1;
        let maxAmp = 0;
        for (let i = 0; i < octaves; i++) {
            value += this.noise2D(x * frequency, y * frequency) * amplitude;
            maxAmp += amplitude;
            amplitude *= persistence;
            frequency *= lacunarity;
        }
        return value / maxAmp;
    }
}
