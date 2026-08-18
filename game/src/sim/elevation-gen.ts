/**
 * Elevation generation.
 *
 * The adopted simulation carries a per-tile elevation array but its Arabia
 * generator leaves it flat, so nothing was ever raised. A flat plane is exactly
 * what reads as "2D and basic" no matter how good the tile art is — Age of
 * Empires maps have always had hills, and the silhouette of raised ground is
 * most of what makes a map feel like terrain rather than a board.
 *
 * This fills that array with rolling relief.
 *
 * Two constraints shape the algorithm:
 *
 * 1. **Playability beats drama.** Steep, frequent hills make an RTS map
 *    unreadable and units hard to select. Real Arabia is gently rolling with
 *    occasional plateaus, so amplitude is low and slopes are smoothed.
 *
 * 2. **Water must stay at zero.** Raising a water tile puts the shoreline
 *    underneath it and the coast falls apart.
 */

/** Maximum elevation steps. AoE2 itself uses a small integer range. */
export const MAX_ELEVATION = 5

interface ElevTarget {
  w: number
  h: number
  terrain: Uint8Array
  elevation: Uint8Array
}

/** Deterministic value noise — same seed, same hills, every load. */
function noise2d(w: number, h: number, scale: number, seed: number): Float32Array {
  const gw = Math.ceil(w / scale) + 2
  const grid = new Float32Array(gw * gw)

  let s = seed >>> 0 || 1
  const rnd = (): number => {
    s = (s + 0x6d2b79f5) >>> 0
    let t = s
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
  for (let i = 0; i < grid.length; i++) grid[i] = rnd()

  const out = new Float32Array(w * h)
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const gx = x / scale
      const gy = y / scale
      const x0 = Math.floor(gx)
      const y0 = Math.floor(gy)
      const fx = gx - x0
      const fy = gy - y0
      const sx = fx * fx * (3 - 2 * fx)
      const sy = fy * fy * (3 - 2 * fy)
      const v00 = grid[y0 * gw + x0]!
      const v10 = grid[y0 * gw + x0 + 1]!
      const v01 = grid[(y0 + 1) * gw + x0]!
      const v11 = grid[(y0 + 1) * gw + x0 + 1]!
      const a = v00 + (v10 - v00) * sx
      const b = v01 + (v11 - v01) * sx
      out[y * w + x] = a + (b - a) * sy
    }
  }
  return out
}

export function generateElevation(map: ElevTarget, seed = 1337): void {
  const { w, h } = map

  // Two octaves, both broad. An earlier version used a fine second octave and
  // produced speckle: isolated single-tile pillars rather than hills, because
  // high-frequency noise crosses the threshold in scattered points instead of
  // contiguous regions. Landforms want low frequencies.
  const broad = noise2d(w, h, 40, seed)
  const detail = noise2d(w, h, 18, seed ^ 0x9e3779b9)

  const raw = new Float32Array(w * h)
  for (let i = 0; i < raw.length; i++) {
    raw[i] = broad[i]! * 0.8 + detail[i]! * 0.2
  }

  for (let i = 0; i < raw.length; i++) {
    // Water and shallows stay at sea level, or the coastline breaks.
    if (map.terrain[i] !== 0) {
      map.elevation[i] = 0
      continue
    }
    // Bias downward so most of the map is low ground and hills are features,
    // not the default. Anything below the threshold is flat.
    const v = (raw[i]! - 0.45) / 0.55
    map.elevation[i] = v <= 0 ? 0 : Math.min(MAX_ELEVATION, Math.round(v * MAX_ELEVATION))
  }

  despeckle(map)
  smoothCliffs(map)
}

/**
 * Remove isolated raised or sunken tiles.
 *
 * Thresholding a continuous field always leaves stragglers along the contour —
 * a lone tile one step above its four neighbours, which renders as a pillar
 * rather than terrain. A median-style pass over the cardinal neighbours pulls
 * those back into line while leaving genuine slopes untouched.
 */
function despeckle(map: ElevTarget): void {
  const { w, h, elevation, terrain } = map
  const out = new Uint8Array(elevation)

  for (let y = 1; y < h - 1; y++) {
    for (let x = 1; x < w - 1; x++) {
      const i = y * w + x
      if (terrain[i] !== 0) continue

      const n = [
        elevation[i - 1]!, elevation[i + 1]!,
        elevation[i - w]!, elevation[i + w]!,
      ].sort((a, b) => a - b)
      const median = Math.round((n[1]! + n[2]!) / 2)

      // Only correct a tile that disagrees with every neighbour; a tile that
      // matches even one of them is part of a real slope.
      if (n.every((v) => v !== elevation[i])) out[i] = median
    }
  }
  elevation.set(out)
}

/**
 * Clamp any step steeper than one level.
 *
 * Sheer multi-level drops look like glitches rather than cliffs, and — more
 * importantly — a unit standing at the bottom of one is drawn overlapping the
 * face above it. AoE2 enforces the same single-step rule.
 *
 * Iterated because flattening one tile can create a new violation next to it.
 */
function smoothCliffs(map: ElevTarget): void {
  const { w, h, elevation } = map
  for (let pass = 0; pass < 6; pass++) {
    let changed = false
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        const i = y * w + x
        const e = elevation[i]!
        for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]] as const) {
          const nx = x + dx
          const ny = y + dy
          if (nx < 0 || ny < 0 || nx >= w || ny >= h) continue
          const n = elevation[ny * w + nx]!
          if (e - n > 1) {
            elevation[i] = n + 1
            changed = true
          }
        }
      }
    }
    if (!changed) break
  }
}
