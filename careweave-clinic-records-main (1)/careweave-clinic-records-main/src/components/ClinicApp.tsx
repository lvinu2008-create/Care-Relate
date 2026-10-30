import { useEffect, useMemo, useState, useSyncExternalStore, type ReactNode } from "react";
import { ArrowLeft, BriefcaseMedical, Home, LogOut, Pencil, PlusCircle, RefreshCw, Search, UserPlus, Wifi, WifiOff, Database, Trash2 } from "lucide-react";
import * as S from "@/lib/clinic-store";

type Screen =
  | { name: "home" } | { name: "search" } | { name: "register" } | { name: "sync" }
  | { name: "history"; id: string } | { name: "edit"; id: string } | { name: "visit"; id: string };

let ver = 0;
S.subscribe(() => { ver++; });
function useStore() {
  useSyncExternalStore(S.subscribe, () => ver, () => 0);
  return { local: S.getLocal(), server: S.getServer(), user: S.getUser(), online: S.isOnline(), syncing: S.isSyncing(), last: S.getLastSync() };
}

const initials = (n: string) => n.split(" ").map((w) => w[0]).slice(0, 2).join("").toUpperCase();
const isToday = (d: string) => new Date(d).toDateString() === new Date().toDateString();

function Badge({ status }: { status: S.SyncStatus }) {
  return status === "pending"
    ? <span className="rounded-full bg-warning px-2 py-0.5 text-xs font-semibold text-warning-foreground">Pending</span>
    : <span className="rounded-full bg-secondary px-2 py-0.5 text-xs font-semibold text-secondary-foreground">Synced</span>;
}
function Header({ title, onBack, right }: { title: string; onBack?: () => void; right?: ReactNode }) {
  return (
    <header className="sticky top-0 z-10 flex h-16 items-center justify-between bg-primary px-4 text-primary-foreground">
      <button aria-label="Back" onClick={onBack} className="p-2">{onBack && <ArrowLeft className="h-5 w-5" />}</button>
      <h1 className="text-lg font-bold">{title}</h1>
      <div className="w-9">{right}</div>
    </header>
  );
}
const Card = ({ children, className = "" }: { children: ReactNode; className?: string }) =>
  <div className={`rounded-2xl border border-border bg-card p-4 ${className}`}>{children}</div>;
const Field = ({ label, children }: { label: string; children: ReactNode }) =>
  <label className="block"><span className="mb-1.5 block text-sm font-semibold">{label}</span>{children}</label>;
const inputCls = "w-full rounded-xl border border-input bg-card px-4 py-3 outline-none focus:ring-2 focus:ring-ring";
const primaryBtn = "flex w-full items-center justify-center gap-2 rounded-xl bg-primary py-3.5 font-bold text-primary-foreground disabled:opacity-60";

function VisitCard({ v, title }: { v: S.Visit; title?: string }) {
  const d = new Date(v.visitDate);
  return (
    <Card>
      <div className="flex items-start gap-3">
        <div className="rounded-md bg-primary px-2.5 py-1 text-center text-primary-foreground">
          <div className="text-lg font-bold leading-tight">{d.getDate()}</div>
          <div className="text-xs">{d.toLocaleString("en", { month: "short" })} {String(d.getFullYear()).slice(2)}</div>
        </div>
        <div className="flex-1">
          {title && <div className="font-bold">{title}</div>}
          <div className="font-bold">{v.diagnosis || "Visit"}</div>
          <div className="text-sm text-muted-foreground">{v.doctor}</div>
        </div>
        <Badge status={v.syncStatus} />
      </div>
      <div className="mt-3 border-t border-border pt-3">
        <div className="text-xs font-semibold tracking-wider text-muted-foreground">SYMPTOMS</div>
        <div className="mt-2 flex flex-wrap gap-2">{v.symptoms.map((s) => <span key={s} className="rounded-full bg-secondary px-3 py-1 text-sm font-semibold text-secondary-foreground">{s}</span>)}</div>
      </div>
      {v.treatment && <div className="mt-3 border-t border-border pt-3">
        <div className="text-xs font-semibold tracking-wider text-muted-foreground">TREATMENT</div>
        <div className="mt-1">{v.treatment}</div>
      </div>}
    </Card>
  );
}

function StatusBanner({ online, pending, syncing }: { online: boolean; pending: number; syncing: boolean }) {
  const text = syncing ? "Synchronizing…" : online ? (pending ? `Online — ${pending} records pending sync` : "Online — all records synchronized") : `Offline — ${pending} records saved on device`;
  const cls = !online ? "bg-destructive text-destructive-foreground" : pending || syncing ? "bg-warning text-warning-foreground" : "bg-secondary text-secondary-foreground";
  return <div className={`flex items-center gap-2 rounded-xl px-4 py-3 font-semibold ${cls}`}><span className="h-2 w-2 rounded-full bg-current" />{text}</div>;
}

function Login() {
  const [u, setU] = useState(""); const [p, setP] = useState(""); const [err, setErr] = useState("");
  return (
    <div className="min-h-screen">
      <div className="rounded-b-3xl bg-primary px-6 pb-8 pt-6 text-primary-foreground">
        <div className="mb-4 inline-flex rounded-xl bg-primary-soft p-3"><BriefcaseMedical className="h-7 w-7" /></div>
        <h1 className="text-3xl font-bold">Clinic Records</h1>
        <p className="mt-1 opacity-90">Offline-first patient records for rural clinics</p>
      </div>
      <form className="space-y-4 p-6" onSubmit={(e) => { e.preventDefault(); if (!S.login(u, p)) setErr("Invalid username or password"); }}>
        <h2 className="text-xl font-bold">Sign in</h2>
        <Field label="Username"><input className={inputCls} value={u} onChange={(e) => setU(e.target.value)} placeholder="doctor" maxLength={50} /></Field>
        <Field label="Password"><input type="password" className={inputCls} value={p} onChange={(e) => setP(e.target.value)} maxLength={100} /></Field>
        {err && <p className="text-sm text-destructive">{err}</p>}
        <button className={primaryBtn}>Login</button>
        <p className="text-sm font-semibold text-muted-foreground">Quick fill for demo:</p>
        <div className="flex gap-2">
          {["doctor", "nurse"].map((r) => <button type="button" key={r} onClick={() => { setU(r); setP(r + "123"); }} className="rounded-full border border-border px-4 py-2 font-semibold capitalize">{r}</button>)}
        </div>
      </form>
    </div>
  );
}

export function ClinicApp() {
  const [ready, setReady] = useState(false);
  useEffect(() => { const c = S.initClinic(); setReady(true); return c; }, []);
  if (!ready) return <div className="min-h-screen bg-background" />;
  return <div className="mx-auto min-h-screen max-w-md bg-background shadow-xl"><Shell /></div>;
}

function Shell() {
  const st = useStore();
  const [screen, go] = useState<Screen>({ name: "home" });
  const [stack, setStack] = useState<Screen[]>([]);
  const nav = (s: Screen) => { setStack((x) => [...x, screen]); go(s); };
  const back = () => { const prev = stack.at(-1) ?? { name: "home" as const }; setStack((x) => x.slice(0, -1)); go(prev); };
  const tab = (s: Screen) => { setStack([]); go(s); };
  if (!st.user) return <Login />;

  const pending = st.local.patients.filter((p) => p.syncStatus === "pending").length + st.local.visits.filter((v) => v.syncStatus === "pending").length;
  const props = { st, nav, back, pending };
  let body: ReactNode;
  switch (screen.name) {
    case "home": body = <Dashboard {...props} />; break;
    case "search": body = <SearchScreen {...props} />; break;
    case "register": body = <PatientForm {...props} onDone={(id) => { setStack([{ name: "home" }]); go({ name: "history", id }); }} />; break;
    case "edit": body = <PatientForm {...props} id={screen.id} onDone={back} />; break;
    case "visit": body = <VisitForm {...props} id={screen.id} />; break;
    case "history": body = <History {...props} id={screen.id} />; break;
    case "sync": body = <SyncScreen {...props} />; break;
  }
  const tabs = [
    { n: "home", l: "Home", I: Home }, { n: "search", l: "Search", I: Search },
    { n: "register", l: "Register", I: UserPlus }, { n: "sync", l: "Sync", I: RefreshCw },
  ] as const;
  return (
    <div className="pb-20">
      {body}
      <nav className="fixed bottom-0 left-1/2 z-20 grid w-full max-w-md -translate-x-1/2 grid-cols-4 border-t border-border bg-card py-2">
        {tabs.map(({ n, l, I }) => (
          <button key={n} onClick={() => tab({ name: n })} className={`flex flex-col items-center gap-1 text-xs ${screen.name === n ? "text-primary font-semibold" : "text-muted-foreground"}`}>
            <I className="h-5 w-5" />{l}
          </button>
        ))}
      </nav>
    </div>
  );
}

type P = { st: ReturnType<typeof useStore>; nav: (s: Screen) => void; back: () => void; pending: number };

function Dashboard({ st, nav, pending }: P) {
  const today = st.local.visits.filter((v) => isToday(v.visitDate)).sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  const hour = new Date().getHours();
  const greet = hour < 12 ? "Good morning" : hour < 17 ? "Good afternoon" : "Good evening";
  const name = (id: string) => st.local.patients.find((p) => p.id === id)?.name ?? "Patient";
  const recent = [...st.local.patients].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt)).slice(0, 5);
  return (
    <>
      <div className="flex items-start justify-between bg-primary px-6 pb-6 pt-2 text-primary-foreground">
        <div><p className="opacity-90">{greet},</p><h1 className="text-2xl font-bold">{st.user!.name}</h1><p className="text-xs font-semibold uppercase opacity-80">{st.user!.role} · {st.user!.username}</p></div>
        <button aria-label="Log out" onClick={S.logout} className="mt-2 rounded-full bg-primary-soft p-3"><LogOut className="h-5 w-5" /></button>
      </div>
      <div className="space-y-5 p-4">
        <StatusBanner online={st.online} pending={pending} syncing={st.syncing} />
        <div className="grid grid-cols-3 gap-3">
          {[[today.length, "Today's visits", "text-primary"], [pending, "Pending sync", "text-warning"], [st.local.visits.length, "On device", "text-primary"]].map(([n, l, c]) => (
            <Card key={l as string} className="text-center"><div className={`text-3xl font-bold ${c}`}>{n}</div><div className="text-sm font-medium text-muted-foreground">{l}</div></Card>
          ))}
        </div>
        <p className="-mt-2 text-center text-sm text-muted-foreground">Main database: {st.server.patients.length} patients · {st.server.visits.length} visits</p>
        <h2 className="text-xl font-bold">Quick actions</h2>
        <div className="grid grid-cols-3 gap-3">
          <button onClick={() => nav({ name: "register" })} className="rounded-2xl bg-primary p-4 text-left font-bold text-primary-foreground"><UserPlus className="mb-3 h-6 w-6" /><span className="block text-center">Register Patient</span></button>
          <button onClick={() => nav({ name: "search" })} className="rounded-2xl border border-border bg-card p-4 text-left font-bold"><Search className="mb-3 h-6 w-6" /><span className="block text-center">Search Patient</span></button>
          <button onClick={() => nav({ name: "sync" })} className="rounded-2xl border border-border bg-card p-4 text-left font-bold"><RefreshCw className="mb-3 h-6 w-6" /><span className="block text-center">Sync Center</span></button>
        </div>
        <h2 className="text-xl font-bold">Today's visits</h2>
        {today.length ? today.map((v) => <button key={v.id} className="block w-full text-left" onClick={() => nav({ name: "history", id: v.patientId })}><VisitCard v={v} title={name(v.patientId)} /></button>)
          : <Card className="text-center text-muted-foreground">No visits recorded today yet.</Card>}
        <h2 className="text-xl font-bold">Recent patients</h2>
        <div className="space-y-2">{recent.map((p) => <PatientRow key={p.id} p={p} visits={st.local.visits} onClick={() => nav({ name: "history", id: p.id })} />)}</div>
      </div>
    </>
  );
}

function PatientRow({ p, visits, onClick }: { p: S.Patient; visits: S.Visit[]; onClick: () => void }) {
  const vs = visits.filter((v) => v.patientId === p.id).sort((a, b) => b.visitDate.localeCompare(a.visitDate));
  const last = vs[0];
  return (
    <button onClick={onClick} className="block w-full text-left">
      <Card className="flex items-center gap-3">
        <div className="grid h-12 w-12 place-items-center rounded-full bg-secondary font-bold text-secondary-foreground">{initials(p.name)}</div>
        <div className="min-w-0 flex-1">
          <div className="font-bold">{p.name}</div>
          <div className="text-sm text-muted-foreground">{p.age} yrs · Total visits: {vs.length}</div>
          {last && <div className="truncate text-sm text-muted-foreground">Last: {new Date(last.visitDate).toLocaleDateString("en-GB", { day: "2-digit", month: "short" })} · {last.symptoms.join(", ")}</div>}
        </div>
        <Badge status={p.syncStatus === "pending" || vs.some((v) => v.syncStatus === "pending") ? "pending" : "synced"} />
      </Card>
    </button>
  );
}

function SearchScreen({ st, nav, back }: P) {
  const [q, setQ] = useState("");
  const res = useMemo(() => {
    const t = q.trim().toLowerCase();
    return st.local.patients.filter((p) => !t || p.name.toLowerCase().includes(t) || p.phone.includes(t) || p.id.toLowerCase().includes(t)).sort((a, b) => a.name.localeCompare(b.name));
  }, [q, st.local.patients]);
  return (
    <>
      <Header title="Search Patient" onBack={back} />
      <div className="space-y-3 p-4">
        <div className="relative"><Search className="absolute left-4 top-3.5 h-5 w-5 text-muted-foreground" />
          <input autoFocus className={inputCls + " pl-12"} placeholder="Name, phone or patient ID" value={q} onChange={(e) => setQ(e.target.value)} maxLength={100} /></div>
        <p className="text-sm text-muted-foreground">Searching device storage — works offline.</p>
        {res.map((p) => <PatientRow key={p.id} p={p} visits={st.local.visits} onClick={() => nav({ name: "history", id: p.id })} />)}
        {!res.length && <Card className="text-center text-muted-foreground">No patients found.</Card>}
      </div>
    </>
  );
}

function History({ st, nav, back, id }: P & { id: string }) {
  const p = st.local.patients.find((x) => x.id === id);
  const [showAll, setShowAll] = useState(false);
  if (!p) return <><Header title="Patient History" onBack={back} /><p className="p-4">Patient not found.</p></>;
  const local = st.local.visits.filter((v) => v.patientId === id);
  const localIds = new Set(local.map((v) => v.id));
  const archived = st.online ? st.server.visits.filter((v) => v.patientId === id && !localIds.has(v.id)) : [];
  const visits = [...local, ...(showAll ? archived : [])].sort((a, b) => b.visitDate.localeCompare(a.visitDate));
  const status: S.SyncStatus = p.syncStatus === "pending" || local.some((v) => v.syncStatus === "pending") ? "pending" : "synced";
  return (
    <>
      <Header title="Patient History" onBack={back} right={<button aria-label="Edit patient" onClick={() => nav({ name: "edit", id })} className="p-2"><Pencil className="h-5 w-5" /></button>} />
      <div className="space-y-4 p-4">
        <Card className="flex gap-4">
          <div className="grid h-16 w-16 shrink-0 place-items-center rounded-full bg-secondary text-xl font-bold text-secondary-foreground">{initials(p.name)}</div>
          <div className="flex-1">
            <div className="flex items-start justify-between gap-2"><h2 className="text-xl font-bold">{p.name}</h2><Badge status={status} /></div>
            <p className="text-sm text-muted-foreground">{p.age} yrs · {p.gender} · {p.phone}</p>
            <p className="text-sm text-muted-foreground">{p.address}</p>
            <span className="mt-2 inline-block rounded-full bg-secondary px-3 py-1 text-sm font-semibold">Total visits: {local.length + archived.length}</span>
          </div>
        </Card>
        <button className={primaryBtn} onClick={() => nav({ name: "visit", id })}><PlusCircle className="h-5 w-5" /> Add New Visit</button>
        <h3 className="text-lg font-bold">Visit timeline — this device ({local.length})</h3>
        {visits.map((v) => <div key={v.id} className={localIds.has(v.id) ? "" : "opacity-80"}>{!localIds.has(v.id) && <p className="mb-1 text-xs font-semibold text-muted-foreground">FROM MAIN DATABASE</p>}<VisitCard v={v} /></div>)}
        {!local.length && <Card className="text-center text-muted-foreground">No visits on this device in the last month.</Card>}
        {archived.length > 0 && !showAll && <button onClick={() => setShowAll(true)} className="flex w-full items-center justify-center gap-2 rounded-xl border border-border py-3 font-semibold"><Database className="h-4 w-4" />Load {archived.length} older visits from main database</button>}
        {!st.online && <p className="text-center text-sm text-muted-foreground">Offline — older history in the main database will be available when connected.</p>}
      </div>
    </>
  );
}

function PatientForm({ st, back, id, onDone }: P & { id?: string; onDone: (id: string) => void }) {
  const ex = id ? st.local.patients.find((p) => p.id === id) : undefined;
  const [f, setF] = useState({ name: ex?.name ?? "", age: ex ? String(ex.age) : "", gender: ex?.gender ?? "Male", phone: ex?.phone ?? "", address: ex?.address ?? "", symptoms: "", diagnosis: "", treatment: "" });
  const [err, setErr] = useState("");
  const set = (k: keyof typeof f) => (e: { target: { value: string } }) => setF({ ...f, [k]: e.target.value });
  const submit = () => {
    const age = Number(f.age);
    if (!f.name.trim()) return setErr("Name is required");
    if (!Number.isInteger(age) || age < 0 || age > 130) return setErr("Enter a valid age");
    if (f.phone && !/^[0-9+ -]{6,15}$/.test(f.phone)) return setErr("Enter a valid phone number");
    const pid = ex?.id ?? S.newId("P");
    S.savePatient({ id: pid, name: f.name.trim(), age, gender: f.gender, phone: f.phone.trim(), address: f.address.trim() });
    const sym = f.symptoms.split(",").map((s) => s.trim()).filter(Boolean);
    if (!ex && sym.length) S.saveVisit({ id: S.newId("V"), patientId: pid, visitDate: new Date().toISOString(), symptoms: sym, diagnosis: f.diagnosis.trim(), treatment: f.treatment.trim(), doctor: st.user!.name });
    onDone(pid);
  };
  return (
    <>
      <Header title={ex ? "Edit Patient" : "Register Patient"} onBack={back} />
      <form className="space-y-4 p-4" onSubmit={(e) => { e.preventDefault(); submit(); }}>
        <Field label="Patient name"><input className={inputCls} value={f.name} onChange={set("name")} maxLength={100} /></Field>
        <div className="grid grid-cols-2 gap-3">
          <Field label="Age"><input inputMode="numeric" className={inputCls} value={f.age} onChange={set("age")} maxLength={3} /></Field>
          <Field label="Gender"><select className={inputCls} value={f.gender} onChange={set("gender")}><option>Male</option><option>Female</option><option>Other</option></select></Field>
        </div>
        <Field label="Phone"><input inputMode="tel" className={inputCls} value={f.phone} onChange={set("phone")} maxLength={15} /></Field>
        <Field label="Address"><input className={inputCls} value={f.address} onChange={set("address")} maxLength={200} /></Field>
        {!ex && <>
          <Field label="Symptoms (comma separated)"><input className={inputCls} value={f.symptoms} onChange={set("symptoms")} placeholder="Fever, cough" maxLength={300} /></Field>
          <Field label="Diagnosis"><input className={inputCls} value={f.diagnosis} onChange={set("diagnosis")} maxLength={200} /></Field>
          <Field label="Treatment"><input className={inputCls} value={f.treatment} onChange={set("treatment")} maxLength={300} /></Field>
        </>}
        {err && <p className="text-sm text-destructive">{err}</p>}
        <button className={primaryBtn}>{ex ? "Save Changes" : "Save"}</button>
        <p className="text-center text-sm text-muted-foreground">Saved to this device first{st.online ? ", then synced automatically." : " — will sync when internet returns."}</p>
      </form>
    </>
  );
}

function VisitForm({ st, back, id }: P & { id: string }) {
  const p = st.local.patients.find((x) => x.id === id);
  const [f, setF] = useState({ symptoms: "", diagnosis: "", treatment: "" }); const [err, setErr] = useState("");
  const set = (k: keyof typeof f) => (e: { target: { value: string } }) => setF({ ...f, [k]: e.target.value });
  return (
    <>
      <Header title="Add New Visit" onBack={back} />
      <form className="space-y-4 p-4" onSubmit={(e) => {
        e.preventDefault();
        const sym = f.symptoms.split(",").map((s) => s.trim()).filter(Boolean);
        if (!sym.length) return setErr("Add at least one symptom");
        S.saveVisit({ id: S.newId("V"), patientId: id, visitDate: new Date().toISOString(), symptoms: sym, diagnosis: f.diagnosis.trim(), treatment: f.treatment.trim(), doctor: st.user!.name });
        back();
      }}>
        <Card><div className="font-bold">{p?.name}</div><div className="text-sm text-muted-foreground">{new Date().toLocaleDateString("en-GB", { day: "2-digit", month: "long", year: "numeric" })}</div></Card>
        <Field label="Symptoms (comma separated)"><input autoFocus className={inputCls} value={f.symptoms} onChange={set("symptoms")} placeholder="Fever, cough, weakness" maxLength={300} /></Field>
        <Field label="Diagnosis"><input className={inputCls} value={f.diagnosis} onChange={set("diagnosis")} maxLength={200} /></Field>
        <Field label="Treatment"><textarea className={inputCls} rows={3} value={f.treatment} onChange={set("treatment")} maxLength={300} /></Field>
        {err && <p className="text-sm text-destructive">{err}</p>}
        <button className={primaryBtn}>Save Visit</button>
      </form>
    </>
  );
}

function SyncScreen({ st, back, pending }: P) {
  const [msg, setMsg] = useState("");
  const synced = st.local.patients.filter((p) => p.syncStatus === "synced").length + st.local.visits.filter((v) => v.syncStatus === "synced").length;
  const forced = S.isForcedOffline();
  const queue = [...st.local.patients.filter((p) => p.syncStatus === "pending").map((p) => ({ id: p.id, l: `Patient · ${p.name}` })),
    ...st.local.visits.filter((v) => v.syncStatus === "pending").map((v) => ({ id: v.id, l: `Visit · ${st.local.patients.find((p) => p.id === v.patientId)?.name ?? ""} · ${v.symptoms.join(", ")}` }))];
  return (
    <>
      <Header title="Synchronization" onBack={back} />
      <div className="space-y-4 p-4">
        <StatusBanner online={st.online} pending={pending} syncing={st.syncing} />
        <div className="grid grid-cols-2 gap-3">
          <Card className="text-center"><div className="text-3xl font-bold text-warning">{pending}</div><div className="text-sm text-muted-foreground">Pending</div></Card>
          <Card className="text-center"><div className="text-3xl font-bold text-primary">{synced}</div><div className="text-sm text-muted-foreground">Synced</div></Card>
        </div>
        <button disabled={!st.online || st.syncing || !pending} className={primaryBtn} onClick={async () => { const r = await S.syncNow(); if (r) setMsg(`✓ ${r.uploaded} records uploaded`); }}>
          <RefreshCw className={`h-5 w-5 ${st.syncing ? "animate-spin" : ""}`} /> {st.syncing ? "Synchronizing…" : "Sync Now"}
        </button>
        {(msg || st.last) && <p className="text-center font-semibold text-success">{msg || `✓ ${st.last!.uploaded} records uploaded at ${new Date(st.last!.at).toLocaleTimeString()}`}</p>}
        <Card>
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-3">{forced ? <WifiOff className="h-5 w-5" /> : <Wifi className="h-5 w-5" />}
              <div><div className="font-bold">Simulate offline</div><div className="text-sm text-muted-foreground">For demo: cut the connection to the main database</div></div></div>
            <button role="switch" aria-checked={forced} aria-label="Simulate offline" onClick={() => S.setForcedOffline(!forced)} className={`relative h-7 w-12 rounded-full transition ${forced ? "bg-destructive" : "bg-secondary"}`}>
              <span className={`absolute top-1 h-5 w-5 rounded-full bg-card transition-all ${forced ? "left-6" : "left-1"}`} /></button>
          </div>
        </Card>
        {queue.length > 0 && <Card><div className="mb-2 text-xs font-semibold tracking-wider text-muted-foreground">WAITING FOR SYNCHRONIZATION</div>
          <ul className="space-y-1 text-sm">{queue.map((q) => <li key={q.id}>⏳ {q.l}</li>)}</ul></Card>}
        <Card>
          <div className="mb-2 flex items-center gap-2 font-bold"><Database className="h-4 w-4" /> Main database</div>
          <p className="text-sm text-muted-foreground">{st.server.patients.length} patients · {st.server.visits.length} visits (long-term history)</p>
          <div className="mt-3 flex items-center gap-2 font-bold"><Trash2 className="h-4 w-4" /> Device retention</div>
          <p className="text-sm text-muted-foreground">Visits older than {S.RETENTION_DAYS} days are removed from this device — only after they are synced. Device holds {st.local.visits.length} visits.</p>
        </Card>
      </div>
    </>
  );
}
