/**
 * Content hash for the boot caches: 2 × 32-bit lanes of a
 * murmur3-style mix over the exact BYTES of typed arrays, plain-number arrays
 * (hashed as float64, so two arrays hash equal only if every double is
 * bit-identical), integers and strings. Not cryptographic — a cache key whose
 * collision odds (≈ 2⁻⁶⁴ per pair) are far below anything a session sees.
 *
 *   const h = new ContentHash();
 *   h.str('ao/3').f64(positions).f32(normals).i32(weld);
 *   const key = h.digest();          // 16 hex digits
 */

const C1 = 0xcc9e2d51;
const C2 = 0x1b873593;

/** Scratch for number[] → float64 bytes, grown on demand. */
let scratch = new Float64Array(1 << 16);

export class ContentHash {
  private a = 0x9747b28c;
  private b = 0x2545f491;
  private n = 0;

  private word(k: number): void {
    k = Math.imul(k, C1);
    k = (k << 15) | (k >>> 17);
    k = Math.imul(k, C2);
    let a = this.a ^ k;
    a = (a << 13) | (a >>> 19);
    this.a = (Math.imul(a, 5) + 0xe6546b64) | 0;
    let b = this.b ^ Math.imul(k, 0x85ebca6b);
    b = (b << 17) | (b >>> 15);
    this.b = (Math.imul(b, 9) + 0x7a2d1f39) | 0;
    this.n++;
  }

  private words(u: Uint32Array): this {
    this.word(u.length);
    for (let i = 0; i < u.length; i++) this.word(u[i]);
    return this;
  }

  /** Bytes of any typed array (length is mixed in, so [1,2]+[3] ≠ [1]+[2,3]). */
  bytes(v: ArrayBufferView): this {
    const len = v.byteLength;
    const whole = len >>> 2;
    if ((v.byteOffset & 3) === 0) {
      this.words(new Uint32Array(v.buffer, v.byteOffset, whole));
    } else {
      this.words(new Uint32Array(new Uint8Array(v.buffer, v.byteOffset, whole * 4).slice().buffer));
    }
    const rest = len & 3;
    if (rest) {
      const u8 = new Uint8Array(v.buffer, v.byteOffset + whole * 4, rest);
      let k = 0;
      for (let i = 0; i < rest; i++) k |= u8[i] << (8 * i);
      this.word(k);
    }
    this.word(len);
    return this;
  }

  /** A plain number array as float64 bits (exactly what the bake reads). */
  f64(v: ArrayLike<number>): this {
    if (v instanceof Float64Array) return this.bytes(v);
    const n = v.length;
    if (scratch.length < n) scratch = new Float64Array(Math.max(n, scratch.length * 2));
    for (let i = 0; i < n; i++) scratch[i] = v[i];
    return this.bytes(scratch.subarray(0, n));
  }

  f32(v: Float32Array): this {
    return this.bytes(v);
  }

  i32(v: Int32Array | Uint32Array | Uint16Array): this {
    return this.bytes(v);
  }

  /** One number, as its float64 bits. */
  num(x: number): this {
    scratch[0] = x;
    const u = new Uint32Array(scratch.buffer, 0, 2);
    this.word(u[0]);
    this.word(u[1]);
    return this;
  }

  str(s: string): this {
    this.word(s.length);
    for (let i = 0; i < s.length; i++) this.word(s.charCodeAt(i));
    return this;
  }

  digest(): string {
    let a = this.a ^ this.n;
    let b = this.b ^ (this.n * 31);
    a ^= a >>> 16; a = Math.imul(a, 0x85ebca6b); a ^= a >>> 13; a = Math.imul(a, 0xc2b2ae35); a ^= a >>> 16;
    b ^= b >>> 16; b = Math.imul(b, 0x7feb352d); b ^= b >>> 15; b = Math.imul(b, 0x846ca68b); b ^= b >>> 16;
    a = (a + b) | 0;
    b = (b + a) | 0;
    return (a >>> 0).toString(16).padStart(8, '0') + (b >>> 0).toString(16).padStart(8, '0');
  }
}
