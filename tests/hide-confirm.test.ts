import { describe, expect, it, vi } from "vitest";

import { confirmHide } from "@/components/hide-confirm";

describe("Hide button (UI-11)", () => {
  it("asks before hiding and selling, and does nothing if the admin says no", () => {
    const no = vi.fn((message: string) => message.length < 0);
    expect(confirmHide(false, no)).toBe(false);
    expect(no).toHaveBeenCalledOnce();
    expect(no.mock.calls[0][0]).toMatch(/sell/i);
    expect(confirmHide(false, () => true)).toBe(true);
  });
  it("restoring a hidden trader needs no confirmation", () => {
    const ask = vi.fn(() => false);
    expect(confirmHide(true, ask)).toBe(true);
    expect(ask).not.toHaveBeenCalled();
  });
});
