// Offline-first store: "local" = device storage (current month), "server" = simulated main database.
export type SyncStatus = "pending" | "synced";
export interface Patient {
  id: string; name: string; age: number; gender: string; phone: string; address: string;
  createdAt: string; updatedAt: string; updatedBy: string; syncStatus: SyncStatus;
}
export interface Visit {
  id: string; patientId: string; visitDate: string; symptoms: string[]; diagnosis: string;
  treatment: string; doctor: string; createdAt: string; updatedAt: string; syncStatus: SyncStatus;
}
interface DB { patients: Patient[]; visits: Visit[] }
export interface User { username: string; name: string; role: "doctor" | "nurse" }

const LOCAL = "clinic.local.v1", SERVER = "clinic.server.v1", USER = "clinic.user.v1",
  NET = "clinic.forceOffline.v1", DEVICE = "clinic.device.v1";
export const RETENTION_DAYS = 30;

const listeners = new Set<() => void>();
export const subscribe = (fn: () => void) => { listeners.add(fn); return () => listeners.delete(fn); };
const emit = () => listeners.forEach((l) => l());

const read = (k: string): DB => JSON.parse(localStorage.getItem(k) || '{"patients":[],"visits":[]}');
const write = (k: string, db: DB) => { localStorage.setItem(k, JSON.stringify(db)); };

const daysAgo = (n: number) => { const d = new Date(); d.setDate(d.getDate() - n); return d.toISOString(); };
function deviceId() {
  let id = localStorage.getItem(DEVICE);
  if (!id) { id = "dev" + Math.random().toString(36).slice(2, 6); localStorage.setItem(DEVICE, id); }
  return id;
}
export const newId = (p: string) => `${deviceId()}-${p}${Date.now().toString(36)}${Math.random().toString(36).slice(2, 5)}`;

export function ensureSeed() {
  if (localStorage.getItem(SERVER)) return;
  const mk = (id: string, name: string, age: number, gender: string, phone: string, address: string): Patient =>
    ({ id, name, age, gender, phone, address, createdAt: daysAgo(40), updatedAt: daysAgo(40), updatedBy: "doctor", syncStatus: "synced" });
  const v = (id: string, pid: string, d: number, symptoms: string[], diagnosis: string, treatment: string, s: SyncStatus = "synced"): Visit =>
    ({ id, patientId: pid, visitDate: daysAgo(d), symptoms, diagnosis, treatment, doctor: "Dr. Meera Nair", createdAt: daysAgo(d), updatedAt: daysAgo(d), syncStatus: s });
  const patients = [
    mk("P1001", "Ravi Kumar", 45, "Male", "9876543210", "Village Rampur"),
    mk("P1002", "Suresh Yadav", 32, "Male", "9123456780", "Village Sonpur"),
    mk("P1003", "Anita Devi", 28, "Female", "9988776655", "Village Rampur"),
    mk("P1004", "Lakshmi Bai", 61, "Female", "9090909090", "Village Kheri"),
  ];
  const visits = [
    v("V001", "P1001", 45, ["Fever", "Headache"], "Viral fever", "Paracetamol"),
    v("V002", "P1001", 12, ["Cough", "Fever"], "Upper respiratory infection", "Cough syrup, rest"),
    v("V003", "P1001", 8, ["Cold", "Cough"], "Common cold", "Antihistamine"),
    v("V004", "P1002", 20, ["Cold"], "Common cold", "Steam inhalation"),
    v("V005", "P1003", 5, ["Back pain"], "Muscle strain", "Rest, pain relief"),
    v("V006", "P1004", 38, ["Joint pain"], "Arthritis", "Physiotherapy"),
    v("V007", "P1004", 15, ["Dizziness"], "Low BP", "ORS, follow-up"),
    v("V008", "P1003", 50, ["Fever"], "Malaria test negative", "Paracetamol"),
    v("V009", "P1002", 2, ["Headache"], "Tension headache", "Hydration"),
  ];
  write(SERVER, { patients, visits });
  // device holds only the last month
  const cutoff = Date.now() - RETENTION_DAYS * 864e5;
  write(LOCAL, { patients, visits: visits.filter((x) => new Date(x.visitDate).getTime() >= cutoff) });
}

// ---------- connectivity ----------
export const isForcedOffline = () => localStorage.getItem(NET) === "1";
export const setForcedOffline = (b: boolean) => { localStorage.setItem(NET, b ? "1" : "0"); emit(); if (!b) void syncNow(); };
export const isOnline = () => navigator.onLine && !isForcedOffline();

// ---------- auth ----------
export const getUser = (): User | null => JSON.parse(localStorage.getItem(USER) || "null");
export function login(username: string, password: string): User | null {
  const users: Record<string, User & { pw: string }> = {
    doctor: { username: "doctor", name: "Dr. Meera Nair", role: "doctor", pw: "doctor123" },
    nurse: { username: "nurse", name: "Nurse Priya Sharma", role: "nurse", pw: "nurse123" },
  };
  const u = users[username.trim().toLowerCase()];
  if (!u || u.pw !== password) return null;
  const { pw: _pw, ...user } = u;
  localStorage.setItem(USER, JSON.stringify(user)); emit(); return user;
}
export const logout = () => { localStorage.removeItem(USER); emit(); };

// ---------- local reads ----------
export const getLocal = () => read(LOCAL);
export const getServer = () => read(SERVER);

// ---------- local writes (always succeed offline) ----------
export function savePatient(p: Omit<Patient, "createdAt" | "updatedAt" | "syncStatus" | "updatedBy"> & Partial<Patient>) {
  const db = read(LOCAL); const now = new Date().toISOString(); const u = getUser();
  const existing = db.patients.find((x) => x.id === p.id);
  const rec: Patient = { ...existing, ...p, createdAt: existing?.createdAt ?? now, updatedAt: now, updatedBy: u?.username ?? "?", syncStatus: "pending" } as Patient;
  db.patients = existing ? db.patients.map((x) => (x.id === p.id ? rec : x)) : [...db.patients, rec];
  write(LOCAL, db); emit(); if (isOnline()) void syncNow(); return rec;
}
export function saveVisit(v: Omit<Visit, "createdAt" | "updatedAt" | "syncStatus">) {
  const db = read(LOCAL); const now = new Date().toISOString();
  const existing = db.visits.find((x) => x.id === v.id);
  const rec: Visit = { ...v, createdAt: existing?.createdAt ?? now, updatedAt: now, syncStatus: "pending" };
  db.visits = existing ? db.visits.map((x) => (x.id === v.id ? rec : x)) : [...db.visits, rec];
  write(LOCAL, db); emit(); if (isOnline()) void syncNow(); return rec;
}

// ---------- sync engine (last-updated-wins, idempotent by device-generated id) ----------
let syncing = false;
export const isSyncing = () => syncing;
export interface SyncResult { uploaded: number; at: string }
let lastSync: SyncResult | null = null;
export const getLastSync = () => lastSync;

export function mergeLWW<T extends { id: string; updatedAt: string }>(server: T[], incoming: T[]): T[] {
  const map = new Map(server.map((s) => [s.id, s]));
  for (const r of incoming) {
    const cur = map.get(r.id);
    if (!cur || new Date(r.updatedAt) >= new Date(cur.updatedAt)) map.set(r.id, r);
  }
  return [...map.values()];
}

export async function syncNow(): Promise<SyncResult | null> {
  if (syncing || !isOnline()) return null;
  const local = read(LOCAL);
  const pp = local.patients.filter((p) => p.syncStatus === "pending");
  const pv = local.visits.filter((v) => v.syncStatus === "pending");
  if (!pp.length && !pv.length) { cleanup(); return null; }
  syncing = true; emit();
  await new Promise((r) => setTimeout(r, 1200)); // simulated network
  if (!isOnline()) { syncing = false; emit(); return null; }
  const server = read(SERVER);
  const mark = <T extends { syncStatus: SyncStatus }>(x: T) => ({ ...x, syncStatus: "synced" as const });
  server.patients = mergeLWW(server.patients, pp.map(mark));
  server.visits = mergeLWW(server.visits, pv.map(mark));
  write(SERVER, server);
  const ids = new Set([...pp, ...pv].map((x) => x.id));
  const fresh = read(LOCAL);
  fresh.patients = fresh.patients.map((p) => (ids.has(p.id) && pp.find((q) => q.id === p.id)?.updatedAt === p.updatedAt ? mark(p) : p));
  fresh.visits = fresh.visits.map((v) => (ids.has(v.id) && pv.find((q) => q.id === v.id)?.updatedAt === v.updatedAt ? mark(v) : v));
  write(LOCAL, fresh);
  syncing = false; lastSync = { uploaded: ids.size, at: new Date().toISOString() };
  cleanup(); emit(); return lastSync;
}

/** Remove local visits older than retention, but ONLY if already synced. */
export function cleanup(now = Date.now()) {
  const db = read(LOCAL); const cutoff = now - RETENTION_DAYS * 864e5;
  const before = db.visits.length;
  db.visits = db.visits.filter((v) => new Date(v.visitDate).getTime() >= cutoff || v.syncStatus !== "synced");
  const removed = before - db.visits.length;
  if (removed) { write(LOCAL, db); emit(); }
  return removed;
}

export function initClinic() {
  ensureSeed(); cleanup();
  const on = () => { emit(); void syncNow(); };
  window.addEventListener("online", on); window.addEventListener("offline", emit);
  const t = setInterval(() => { void syncNow(); }, 15000);
  void syncNow();
  return () => { window.removeEventListener("online", on); window.removeEventListener("offline", emit); clearInterval(t); };
}
