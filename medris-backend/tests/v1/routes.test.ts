import { describe, expect, it } from "vitest";
import { v1Definitions } from "../../src/routes/v1.js";

/**
 * Express matches routes in mounting order. A route with a parameter
 * (`/vendors/{vendorId}`) mounted before a fixed route of the same shape
 * (`/vendors/follower-counts`) would take its requests ("follower-counts" as a
 * vendor id) and answer 400. Fixed routes must therefore come first.
 */
describe("/api/v1 route order", () => {
  it("never mounts a parameter route before a fixed route it would shadow", () => {
    const segs = (path: string) => path.split("/").filter(Boolean);
    const isParam = (s: string) => s.startsWith("{");
    const problems: string[] = [];
    v1Definitions.forEach((earlier, i) => {
      const a = segs(earlier.path);
      for (const later of v1Definitions.slice(i + 1)) {
        const b = segs(later.path);
        if (earlier.method !== later.method || a.length !== b.length) continue;
        const shadows = a.every((s, k) => isParam(s) || s === b[k]) && a.some((s, k) => isParam(s) && !isParam(b[k]!));
        if (shadows) problems.push(`${earlier.method.toUpperCase()} ${earlier.path} is mounted before ${later.path}`);
      }
    });
    expect(problems).toEqual([]);
  });

  it("has no duplicate routes", () => {
    const seen = v1Definitions.map((d) => `${d.method} ${d.path}`);
    expect(seen.length).toBe(new Set(seen).size);
  });
});
