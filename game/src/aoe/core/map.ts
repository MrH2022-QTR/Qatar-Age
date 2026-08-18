/**
 * Tile world: terrain passability, elevation, static obstructions (buildings,
 * trees, mines), and a spatial hash for range queries. Positions are continuous
 * (tile units); the obstruction grid is per-tile like the original.
 */

import type { Entity } from "./entity.ts";

export class GameMap {
  readonly w: number;
  readonly h: number;
  /** 0 = land (passable), 1 = water, 2 = shallows */
  terrain: Uint8Array;
  elevation: Uint8Array;
  /** entity id occupying each tile (0 = free); statics only */
  occupied: Int32Array;
  private buckets = new Map<number, Set<number>>();
  private static BUCKET = 4; // tiles per spatial bucket

  constructor(w: number, h: number) {
    this.w = w;
    this.h = h;
    this.terrain = new Uint8Array(w * h);
    this.elevation = new Uint8Array(w * h);
    this.occupied = new Int32Array(w * h);
  }

  inBounds(x: number, y: number): boolean {
    return x >= 0 && y >= 0 && x < this.w && y < this.h;
  }

  tileIdx(x: number, y: number): number {
    return (y | 0) * this.w + (x | 0);
  }

  isLand(x: number, y: number): boolean {
    return this.inBounds(x, y) && this.terrain[this.tileIdx(x, y)] === 0;
  }

  elevationAt(x: number, y: number): number {
    return this.inBounds(x, y) ? this.elevation[this.tileIdx(x, y)] : 0;
  }

  /** Mark a static footprint. radius in tiles (genie collision half-size). */
  occupy(e: Entity, rx: number, ry: number): void {
    const x0 = Math.round(e.x - rx);
    const y0 = Math.round(e.y - ry);
    const x1 = Math.ceil(e.x + rx) - 1;
    const y1 = Math.ceil(e.y + ry) - 1;
    for (let ty = y0; ty <= Math.max(y0, y1); ty++) {
      for (let tx = x0; tx <= Math.max(x0, x1); tx++) {
        if (this.inBounds(tx, ty)) this.occupied[ty * this.w + tx] = e.id;
      }
    }
  }

  vacate(e: Entity, rx: number, ry: number): void {
    const x0 = Math.round(e.x - rx);
    const y0 = Math.round(e.y - ry);
    const x1 = Math.ceil(e.x + rx) - 1;
    const y1 = Math.ceil(e.y + ry) - 1;
    for (let ty = y0; ty <= Math.max(y0, y1); ty++) {
      for (let tx = x0; tx <= Math.max(x0, x1); tx++) {
        if (this.inBounds(tx, ty) && this.occupied[ty * this.w + tx] === e.id) {
          this.occupied[ty * this.w + tx] = 0;
        }
      }
    }
  }

  isFreeForFootprint(cx: number, cy: number, rx: number, ry: number, ignoreId = 0): boolean {
    const x0 = Math.round(cx - rx);
    const y0 = Math.round(cy - ry);
    const x1 = Math.ceil(cx + rx) - 1;
    const y1 = Math.ceil(cy + ry) - 1;
    for (let ty = y0; ty <= Math.max(y0, y1); ty++) {
      for (let tx = x0; tx <= Math.max(x0, x1); tx++) {
        if (!this.inBounds(tx, ty)) return false;
        if (this.terrain[ty * this.w + tx] !== 0) return false;
        const occ = this.occupied[ty * this.w + tx];
        if (occ !== 0 && occ !== ignoreId) return false;
      }
    }
    return true;
  }

  passableTile(tx: number, ty: number): boolean {
    if (!this.inBounds(tx, ty)) return false;
    const i = ty * this.w + tx;
    return this.terrain[i] === 0 && this.occupied[i] === 0;
  }

  // ---- spatial hash for moving entities --------------------------------------------------

  private bucketKey(x: number, y: number): number {
    return Math.floor(y / GameMap.BUCKET) * 4096 + Math.floor(x / GameMap.BUCKET);
  }

  indexEntity(e: Entity): void {
    const k = this.bucketKey(e.x, e.y);
    let b = this.buckets.get(k);
    if (!b) this.buckets.set(k, (b = new Set()));
    b.add(e.id);
  }

  unindexEntity(e: Entity): void {
    this.buckets.get(this.bucketKey(e.x, e.y))?.delete(e.id);
  }

  moveEntity(e: Entity, nx: number, ny: number): void {
    const k0 = this.bucketKey(e.x, e.y);
    const k1 = this.bucketKey(nx, ny);
    if (k0 !== k1) {
      this.buckets.get(k0)?.delete(e.id);
      let b = this.buckets.get(k1);
      if (!b) this.buckets.set(k1, (b = new Set()));
      b.add(e.id);
    }
    e.x = nx;
    e.y = ny;
  }

  /** ids of indexed entities within `r` tiles of (x, y) (coarse: bucket sweep). */
  idsNear(x: number, y: number, r: number): number[] {
    const out: number[] = [];
    const b0x = Math.floor((x - r) / GameMap.BUCKET);
    const b1x = Math.floor((x + r) / GameMap.BUCKET);
    const b0y = Math.floor((y - r) / GameMap.BUCKET);
    const b1y = Math.floor((y + r) / GameMap.BUCKET);
    for (let by = b0y; by <= b1y; by++) {
      for (let bx = b0x; bx <= b1x; bx++) {
        const b = this.buckets.get(by * 4096 + bx);
        if (b) for (const id of b) out.push(id);
      }
    }
    return out;
  }
}
