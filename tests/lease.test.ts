import { afterAll, beforeAll, describe, expect, it } from "vitest";

import type { Db } from "@/lib/db/client";
import { acquireLease, releaseLease } from "@/lib/lease";

import { createTestDb } from "./helpers/db";

let db: Db;
let close: () => Promise<void>;
beforeAll(async () => ({ db, close } = await createTestDb()));
afterAll(async () => close());

describe("leases", () => {
  it("lets only the owner release its lease", async () => {
    expect(await acquireLease(db, "x", 60_000, "proc-a")).toBe(true);
    expect(await acquireLease(db, "x", 60_000, "proc-b")).toBe(false);
    await releaseLease(db, "x", "proc-b"); // not the owner: no effect
    expect(await acquireLease(db, "x", 60_000, "proc-b")).toBe(false);
    await releaseLease(db, "x", "proc-a"); // e.g. on SIGTERM
    expect(await acquireLease(db, "x", 60_000, "proc-b")).toBe(true);
  });

  it("is taken over once a crashed run's lease expires", async () => {
    expect(await acquireLease(db, "y", 1, "crashed")).toBe(true);
    await new Promise((r) => setTimeout(r, 5));
    expect(await acquireLease(db, "y", 60_000, "next")).toBe(true);
  });
});
