import { beforeEach, describe, expect, it } from "vitest";
import * as S from "@/lib/clinic-store";

beforeEach(() => localStorage.clear());

describe("clinic store rules", () => {
  it("device cleanup removes synced visits older than 30 days but keeps unsynced ones", () => {
    S.ensureSeed();
    const old = new Date(Date.now() - 40 * 864e5).toISOString();
    S.saveVisit({ id: "X1", patientId: "P1001", visitDate: old, symptoms: ["Fever"], diagnosis: "", treatment: "", doctor: "d" });
    S.setForcedOffline(true);
    S.cleanup();
    expect(S.getLocal().visits.some((v) => v.id === "X1")).toBe(true);
    const db = S.getLocal(); db.visits = db.visits.map((v) => (v.id === "X1" ? { ...v, syncStatus: "synced" } : v));
    localStorage.setItem("clinic.local.v1", JSON.stringify(db));
    S.cleanup();
    expect(S.getLocal().visits.some((v) => v.id === "X1")).toBe(false);
  });

  it("last updated wins on conflicting edits", () => {
    const a = { id: "P1", updatedAt: "2026-10-30T10:00:00Z", phone: "9876" };
    const b = { id: "P1", updatedAt: "2026-10-30T11:00:00Z", phone: "9123" };
    expect(S.mergeLWW([b], [a])[0]?.phone).toBe("9123");
    expect(S.mergeLWW([a], [b])[0]?.phone).toBe("9123");
  });
});
