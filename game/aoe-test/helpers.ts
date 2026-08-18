import { loadRegistryFromDisk, type GameData } from "../src/aoe/data/registry.ts";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

let cached: GameData | null = null;

export async function data(): Promise<GameData> {
  if (!cached) {
    const here = dirname(fileURLToPath(import.meta.url));
    cached = await loadRegistryFromDisk(join(here, "..", "aoe-data"));
  }
  return cached;
}

export function approx(actual: number, expected: number, tol: number, label: string): void {
  if (Math.abs(actual - expected) > tol) {
    throw new Error(`${label}: got ${actual}, want ${expected} (±${tol})`);
  }
}
