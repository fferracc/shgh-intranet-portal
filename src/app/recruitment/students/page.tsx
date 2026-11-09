"use client";

import DashboardLayout from "@/components/layout/DashboardLayout";
import React, { useState, useEffect } from "react";
import { collection, query, getDocs, addDoc, doc, updateDoc, deleteDoc, getDoc, setDoc } from "firebase/firestore";
import { db } from "@/lib/firebase";
import { ApplicationProcess, Course } from "@/lib/types";
import CourseFields from "@/components/academy/CourseFields";
import { createCourse, describeSchedule, emptyCourse } from "@/lib/courses";
import { Plus, FolderOpen, Archive, ChevronRight, X, Inbox, Search, RotateCcw } from "lucide-react";
import Link from "next/link";
import { RequirePermission } from "@/components/auth/RequirePermission";
import { publicFormUrl, submissionsPath } from "@/lib/applicationForms";
import { DEFAULT_TEMPLATES, STUDENT_FORM_IDS } from "@/lib/formTemplates";
import RecipientPicker, { RecipientOption } from "@/components/recruitment/RecipientPicker";
import { useAuth } from "@/contexts/AuthContext";
import { can } from "@/lib/permissions";
import { APP_STATUSES, AppStatus, Application, STATUS_STYLE, appStatusOf, countByStatus, endOfLondonDay, isOldDatabase, loadApplications, processState, ukShortDate } from "@/lib/studentApplications";
import { applicantName } from "@/lib/students/matching";

// Who is told about every new student application (1 Oct 2026). Stored in
// recruitmentSettings/studentAlerts {emails, extra}; the server function
// studentApplicationReceived reads it. No list saved yet = all admins and super admins
// plus everyone with the Student Applications permission. Only portal forms send alerts.
function StudentAlertRecipients() {
    const { user } = useAuth();
    const [people, setPeople] = useState<RecipientOption[]>([]);
    const [pick, setPick] = useState<{ extra: string[]; ticked: string[] }>({ extra: [], ticked: [] });
    const [saved, setSaved] = useState<string>("");
    const [state, setState] = useState<"loading" | "ready" | "saving" | "error">("loading");
    const [usingDefault, setUsingDefault] = useState(false);
    const [open, setOpen] = useState(false);

    useEffect(() => {
        (async () => {
            try {
                const snap = await getDocs(collection(db, "users"));
                const list = snap.docs.map(d => d.data())
                    .filter(u => u.archived !== true && (u.role === "admin" || u.role === "super_admin" || can(u, "student_applications")))
                    .map(u => ({ email: String(u.email || "").trim().toLowerCase(), label: String(u.displayName || u.name || "") }))
                    .filter(o => /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(o.email))
                    .sort((a, b) => (a.label || a.email).localeCompare(b.label || b.email));
                const unique = list.filter((o, i) => list.findIndex(x => x.email === o.email) === i);
                setPeople(unique);
                const s = await getDoc(doc(db, "recruitmentSettings", "studentAlerts"));
                const hasList = s.exists() && Array.isArray(s.data().emails);
                const next = hasList
                    ? { extra: (s.data()!.extra || []) as string[], ticked: s.data()!.emails as string[] }
                    : { extra: [], ticked: unique.map(a => a.email) };
                setUsingDefault(!hasList);
                setPick(next); setSaved(JSON.stringify(next)); setState("ready");
            } catch (e) { console.error(e); setState("error"); }
        })();
    }, []);

    const save = async () => {
        if (!pick.ticked.length) { alert("Tick at least one person, or nobody will know about new applications."); return; }
        setState("saving");
        try {
            await setDoc(doc(db, "recruitmentSettings", "studentAlerts"), { emails: pick.ticked, extra: pick.extra, updatedBy: user?.uid || "", updatedAt: new Date().toISOString() });
            setSaved(JSON.stringify(pick)); setUsingDefault(false); setState("ready");
        } catch (e) { console.error(e); alert("Not saved. You may not have permission."); setState("ready"); }
    };
    const dirty = usingDefault || saved !== JSON.stringify(pick);

    return (
        <div className="mb-6 bg-white rounded-xl border border-slate-200 p-4 max-w-5xl">
            <button type="button" onClick={() => setOpen(!open)} className="w-full flex justify-between items-center text-left">
                <span className="font-semibold text-slate-700 text-sm">Application alerts</span>
                <span className="text-xs text-slate-500">{state === "loading" ? "Loading…" : state === "error" ? "Could not load" : `${pick.ticked.length} ${pick.ticked.length === 1 ? "person" : "people"} ${open ? "▲" : "▼"}`}</span>
            </button>
            {open && state !== "loading" && state !== "error" && (
                <div className="mt-3 max-w-xl space-y-2">
                    <RecipientPicker title="Emailed about every new student application" options={people} extra={pick.extra} ticked={pick.ticked} onChange={setPick}
                        note="Only applications made on the portal's own forms send an alert. The applicant (or parent) gets a copy of what they sent if they gave an email address." />
                    {usingDefault && <p className="text-xs text-slate-500">No list saved yet: admins and everyone with Student Applications are emailed.</p>}
                    <button onClick={save} disabled={!dirty || state === "saving"} className="px-3 py-1.5 rounded-lg bg-blue-600 text-white text-sm font-semibold disabled:opacity-50">{state === "saving" ? "Saving…" : dirty ? "Save" : "Saved"}</button>
                </div>
            )}
        </div>
    );
}

type Tab = "processes" | "inbox" | "archived";
type Proc = ApplicationProcess & { formLink?: boolean };

const FORM_NAME = (f?: string) => (f && (DEFAULT_TEMPLATES as Record<string, { name: string }>)[f]?.name) || "";

/** "Open until 31 Dec 2026", "Opens 1 Nov 2026", "Closed 3 Oct 2026", "Open" */
function datesLine(p: Proc): string {
    const st = processState(p);
    if (st === "upcoming") return `Opens ${ukShortDate(p.opensOn)}${p.closesOn ? `, closes ${ukShortDate(p.closesOn)}` : ""}`;
    if (st === "open") return p.closesOn ? `Open until ${ukShortDate(p.closesOn)}` : "Open, no closing date";
    if (st === "closed") return p.closesOn && p.status === "Open" ? `Closed on ${ukShortDate(p.closesOn)} (its closing date)` : "Closed";
    return `Archived${p.archivedAt ? ` ${ukShortDate(p.archivedAt.slice(0, 10))}` : ""}${p.archivedByName ? ` by ${p.archivedByName}` : ""}`;
}

function StatusChips({ counts }: { counts: Record<AppStatus, number> | null }) {
    if (!counts) return <span className="text-xs text-slate-400">Loading…</span>;
    return (
        <span className="flex flex-wrap gap-1">
            {APP_STATUSES.map(s => counts[s] ? <span key={s} className={`text-[11px] font-semibold px-2 py-0.5 rounded-full border ${STATUS_STYLE[s]}`}>{counts[s]} {s}</span> : null)}
            {!Object.values(counts).some(Boolean) && <span className="text-xs text-slate-400">No applications yet</span>}
        </span>
    );
}

function ApplicationProcessesOverview() {
    const { user } = useAuth();
    const isSuper = user?.role === "super_admin";
    const [tab, setTab] = useState<Tab>("processes");
    const [processes, setProcesses] = useState<Proc[]>([]);
    const [oldLinks, setOldLinks] = useState<Proc[]>([]);
    const [apps, setApps] = useState<Record<string, Application[] | null>>({});
    const [loadError, setLoadError] = useState<Record<string, boolean>>({});
    const [loading, setLoading] = useState(true);
    const [courses, setCourses] = useState<Course[]>([]);
    const [copiedId, setCopiedId] = useState<string | null>(null);
    // Inbox filters
    const [statusFilter, setStatusFilter] = useState<"todo" | "all" | AppStatus>("todo");
    const [procFilter, setProcFilter] = useState("");
    const [search, setSearch] = useState("");
    // New process
    const [isCreateModalOpen, setIsCreateModalOpen] = useState(false);
    const blank = { title: "", description: "", formType: "adults" as NonNullable<ApplicationProcess["formType"]>, opensOn: "", closesOn: "" };
    const [formData, setFormData] = useState(blank);
    const [courseChoice, setCourseChoice] = useState<"existing" | "new">("existing");
    const [selectedCourseId, setSelectedCourseId] = useState("");
    const [newCourse, setNewCourse] = useState<Partial<Course>>(emptyCourse());
    const [creating, setCreating] = useState(false);
    const [createError, setCreateError] = useState("");
    const selectedCourse = courses.find(c => c.id === selectedCourseId);
    const courseName = (id?: string) => { const c = courses.find(x => x.id === id); return c ? `${c.code ? c.code + " " : ""}${c.name}` : ""; };

    useEffect(() => {
        const t = new URLSearchParams(window.location.search).get("tab");
        if (t === "inbox" || t === "archived") setTab(t);
    }, []);

    useEffect(() => {
        (async () => {
            try {
                const snapshot = await getDocs(query(collection(db, "applicationProcesses")));
                const all = snapshot.docs.map(d => ({ id: d.id, ...d.data() } as Proc & { isFormLink?: boolean }));
                const procs = all.filter(d => !d.isFormLink);
                setProcesses(procs);
                setOldLinks(all.filter(d => d.isFormLink));
                const cSnap = await getDocs(collection(db, "course"));
                setCourses(cSnap.docs.map(d => ({ id: d.id, ...d.data() } as Course)).sort((a, b) => (a.code || "").localeCompare(b.code || "")));
                setLoading(false);
                // The applications of every process, one read each (also for archived ones: the Archived tab counts them).
                await Promise.all(procs.map(async p => {
                    try { const list = await loadApplications(p); setApps(prev => ({ ...prev, [p.id]: list })); }
                    catch (e) { console.error("Applications not loaded for", p.title, e); setLoadError(prev => ({ ...prev, [p.id]: true })); setApps(prev => ({ ...prev, [p.id]: [] })); }
                }));
            } catch (err) {
                console.error("Error fetching data:", err);
                setLoading(false);
            }
        })();
    }, []);

    const copyLink = async (e: React.MouseEvent, url: string, id: string) => {
        e.preventDefault(); e.stopPropagation();
        try { await navigator.clipboard.writeText(url); setCopiedId(id); setTimeout(() => setCopiedId(null), 2000); }
        catch { prompt("Copy this link:", url); }
    };

    const resetCreate = () => {
        setFormData(blank);
        setCourseChoice("existing"); setSelectedCourseId(""); setNewCourse(emptyCourse()); setCreateError("");
    };

    const handleCreateProcess = async (e: React.FormEvent) => {
        e.preventDefault();
        setCreateError("");
        if (!formData.title.trim()) { setCreateError("Give the process a name, for example \"Adults 50+ Salford, January 2027\"."); return; }
        if (courseChoice === "existing" && !selectedCourseId) { setCreateError("Choose the course this application is for, or create a new one."); return; }
        if (courseChoice === "new" && !(newCourse.name || "").trim()) { setCreateError("Give the new course a name."); return; }
        if (formData.opensOn && formData.closesOn && formData.closesOn < formData.opensOn) { setCreateError("The closing date is before the opening date."); return; }
        setCreating(true);
        try {
            let courseId = selectedCourseId;
            if (courseChoice === "new") {
                try {
                    const made = await createCourse({ ...newCourse, name: (newCourse.name || "").trim() });
                    courseId = made.id;
                    setCourses(prev => [...prev, { id: made.id, ...newCourse, code: made.code } as Course]);
                } catch (err) {
                    console.error("Course not created", err);
                    setCreateError("The course could not be created (you may not have course permission). Nothing was saved.");
                    return;
                }
            }
            const base: Record<string, unknown> = {
                title: formData.title.trim(), description: formData.description.trim(), status: "Open", formType: formData.formType, courseId,
                sourceProject: "main", collectionName: "pending", createdAt: new Date().toISOString(), createdBy: user?.uid || "",
            };
            if (formData.opensOn) base.opensOn = formData.opensOn;
            if (formData.closesOn) { base.closesOn = formData.closesOn; base.closesAt = endOfLondonDay(formData.closesOn); }
            const docRef = await addDoc(collection(db, "applicationProcesses"), base);
            const extra = { collectionName: submissionsPath(docRef.id), externalLink: publicFormUrl(docRef.id) };
            await updateDoc(docRef, extra);
            setProcesses(prev => [...prev, { id: docRef.id, ...base, ...extra } as Proc]);
            setApps(prev => ({ ...prev, [docRef.id]: [] }));
            setIsCreateModalOpen(false);
            resetCreate();
        } catch (err) {
            console.error("Error creating process:", err);
            setCreateError("The application process could not be created. Please try again.");
        } finally {
            setCreating(false);
        }
    };

    const restore = async (p: Proc) => {
        if (!confirm(`Restore "${p.title}"? It goes back to the Processes list, closed. You can reopen it there.`)) return;
        try {
            await updateDoc(doc(db, "applicationProcesses", p.id), { archived: false, status: "Closed" });
            setProcesses(prev => prev.map(x => x.id === p.id ? { ...x, archived: false, status: "Closed" } : x));
        } catch (e) { console.error(e); alert("Not restored. Only the super admin can restore a process."); }
    };

    const removeOldLinks = async () => {
        if (!confirm(`Remove the ${oldLinks.length} entries of the old "Application Form Links" list? They were only typed-in links; every process now has its own link and dates. No applications are touched.`)) return;
        try {
            for (const l of oldLinks) await deleteDoc(doc(db, "applicationProcesses", l.id));
            setOldLinks([]);
        } catch (e) { console.error(e); alert("Not all entries could be removed."); }
    };

    const live = processes.filter(p => processState(p) !== "archived");
    const openProcs = live.filter(p => ["open", "upcoming"].includes(processState(p)));
    const closedProcs = live.filter(p => processState(p) === "closed");
    const archivedProcs = processes.filter(p => processState(p) === "archived");
    const countsOf = (id: string) => apps[id] ? countByStatus(apps[id]!) : null;
    const todo = live.reduce((n, p) => { const c = countsOf(p.id); return n + (c ? c["New"] : 0); }, 0);

    // The inbox: every application of every process that is not archived.
    const inbox = live.flatMap(p => (apps[p.id] || []).map(a => ({ a, p })))
        .filter(({ a, p }) => {
            const st = appStatusOf(a.status);
            if (statusFilter === "todo" && !(st === "New" || st === "Waiting list")) return false;
            if (statusFilter !== "todo" && statusFilter !== "all" && st !== statusFilter) return false;
            if (procFilter && p.id !== procFilter) return false;
            if (search.trim()) {
                const q = search.trim().toLowerCase();
                const hay = [applicantName(a), a.email, a.mobile, a.postcode, a.parentName].map(v => String(v || "").toLowerCase()).join(" ");
                if (!hay.includes(q)) return false;
            }
            return true;
        });

    const ProcessCard = ({ p }: { p: Proc }) => {
        const st = processState(p);
        const counts = countsOf(p.id);
        return (
            <Link href={`/recruitment/students/detail?id=${p.id}`} className={`group p-5 rounded-xl border shadow-sm hover:shadow-md transition block relative overflow-hidden ${st === "closed" || st === "archived" ? "bg-slate-50 border-slate-200" : "bg-white border-slate-200 hover:border-blue-300"}`}>
                {st === "open" && <div className="absolute top-0 left-0 w-1 h-full bg-blue-500"></div>}
                <div className="flex justify-between items-start gap-2 mb-1">
                    <h3 className="font-bold text-lg text-slate-800 group-hover:text-blue-600 transition">{p.title}</h3>
                    <ChevronRight className="text-slate-400 group-hover:text-blue-500 shrink-0" size={20} />
                </div>
                <p className="text-sm text-slate-600">{courseName(p.courseId) || <span className="text-orange-600">No course linked</span>}</p>
                <p className="text-xs text-slate-500 mt-0.5">{[FORM_NAME(p.formType) ? `${FORM_NAME(p.formType)} form` : "", datesLine(p)].filter(Boolean).join(" · ")}</p>
                {isOldDatabase(p) && <p className="text-xs font-semibold text-amber-700 mt-1">Still in the old forms database: open it to move it into the portal.</p>}
                {loadError[p.id] && <p className="text-xs font-semibold text-red-600 mt-1">Could not load its applications.</p>}
                <div className="flex flex-wrap items-center gap-2 mt-3">
                    <StatusChips counts={counts} />
                    {st === "open" && p.formType && p.externalLink && !isOldDatabase(p) && (
                        <button type="button" onClick={e => copyLink(e, p.externalLink!, p.id)} className="text-xs font-semibold px-2 py-1 bg-emerald-100 text-emerald-700 rounded hover:bg-emerald-200 ml-auto">
                            {copiedId === p.id ? "Link copied" : "Copy form link"}
                        </button>
                    )}
                </div>
            </Link>
        );
    };

    const tabBtn = (id: Tab, label: string, n?: number) => (
        <button onClick={() => setTab(id)} className={`px-4 py-2 rounded-lg text-sm font-semibold flex items-center gap-2 ${tab === id ? "bg-blue-600 text-white" : "bg-white text-slate-600 border border-slate-200 hover:bg-slate-50"}`}>
            {label}{n !== undefined && <span className={`text-xs px-1.5 rounded-full ${tab === id ? "bg-white/20" : "bg-slate-100"}`}>{n}</span>}
        </button>
    );

    return (
        <DashboardLayout>
            <div className="flex justify-between items-start gap-4 mb-6 flex-wrap">
                <div>
                    <h1 className="text-2xl font-bold text-slate-800">Student Applications</h1>
                    <p className="text-slate-500">One process for each course intake. Applicants are New, Accepted, on the Waiting list or Declined.</p>
                </div>
                <button onClick={() => { resetCreate(); setIsCreateModalOpen(true); }} className="bg-blue-600 text-white px-4 py-2 rounded-lg flex items-center gap-2 hover:bg-blue-700 transition">
                    <Plus size={18} /> New Process
                </button>
            </div>

            <StudentAlertRecipients />

            <div className="flex flex-wrap gap-2 mb-6">
                {tabBtn("processes", "Processes", live.length)}
                {tabBtn("inbox", "All applications", todo)}
                {tabBtn("archived", "Archived", archivedProcs.length)}
            </div>

            {loading ? (
                <div className="flex justify-center items-center h-64"><div className="animate-spin rounded-full h-8 w-8 border-b-2 border-blue-600"></div></div>
            ) : tab === "processes" ? (
                <div className="space-y-10 max-w-5xl">
                    <div className="space-y-4">
                        <h2 className="text-xl font-bold text-slate-800 flex items-center gap-2 border-b pb-2">
                            <FolderOpen className="text-blue-600" size={24} /> Open <span className="ml-1 text-sm bg-blue-100 text-blue-700 px-2 py-0.5 rounded-full font-semibold">{openProcs.length}</span>
                        </h2>
                        <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                            {openProcs.length === 0 ? <p className="text-slate-500 p-4 bg-slate-50 rounded-lg border border-slate-100 text-sm">No open processes. Press New Process to open one.</p>
                                : openProcs.map(p => <ProcessCard key={p.id} p={p} />)}
                        </div>
                    </div>
                    <div className="space-y-4">
                        <h2 className="text-xl font-bold text-slate-800 flex items-center gap-2 border-b pb-2">
                            <Archive className="text-slate-500" size={24} /> Closed <span className="ml-1 text-sm bg-slate-100 text-slate-600 px-2 py-0.5 rounded-full font-semibold">{closedProcs.length}</span>
                        </h2>
                        <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                            {closedProcs.length === 0 ? <p className="text-slate-500 p-4 bg-slate-50 rounded-lg border border-slate-100 text-sm">No closed processes.</p>
                                : closedProcs.map(p => <ProcessCard key={p.id} p={p} />)}
                        </div>
                    </div>
                    {isSuper && oldLinks.length > 0 && (
                        <div className="p-4 rounded-xl border border-amber-200 bg-amber-50 text-sm text-amber-900 flex flex-wrap items-center justify-between gap-3">
                            <span>The old &quot;Application Form Links&quot; list ({oldLinks.length} typed-in links) is no longer used: every process has its own link and dates.</span>
                            <button onClick={removeOldLinks} className="px-3 py-1.5 rounded-lg bg-white border border-amber-300 font-semibold hover:bg-amber-100">Remove the old list</button>
                        </div>
                    )}
                </div>
            ) : tab === "inbox" ? (
                <div className="max-w-6xl space-y-4">
                    <div className="flex flex-wrap gap-3 items-end bg-white p-4 rounded-xl border border-slate-200">
                        <label className="text-sm"><span className="block text-xs font-semibold text-slate-500 mb-1">Show</span>
                            <select className="p-2 border rounded-lg" value={statusFilter} onChange={e => setStatusFilter(e.target.value as typeof statusFilter)}>
                                <option value="todo">To decide (New and Waiting list)</option>
                                <option value="all">Everyone</option>
                                {APP_STATUSES.map(s => <option key={s} value={s}>{s}</option>)}
                            </select>
                        </label>
                        <label className="text-sm"><span className="block text-xs font-semibold text-slate-500 mb-1">Process</span>
                            <select className="p-2 border rounded-lg max-w-[260px]" value={procFilter} onChange={e => setProcFilter(e.target.value)}>
                                <option value="">All processes</option>
                                {live.map(p => <option key={p.id} value={p.id}>{p.title}</option>)}
                            </select>
                        </label>
                        <label className="text-sm flex-1 min-w-[200px]"><span className="block text-xs font-semibold text-slate-500 mb-1">Search</span>
                            <span className="flex items-center gap-2 p-2 border rounded-lg"><Search size={16} className="text-slate-400" />
                                <input className="outline-none flex-1" placeholder="Name, email, phone or postcode" value={search} onChange={e => setSearch(e.target.value)} /></span>
                        </label>
                    </div>
                    <div className="bg-white rounded-xl border border-slate-200 overflow-hidden">
                        <table className="w-full text-sm">
                            <thead className="bg-slate-50 text-xs uppercase text-slate-500 font-semibold">
                                <tr><th className="px-4 py-3 text-left">Applicant</th><th className="px-4 py-3 text-left">Contact</th><th className="px-4 py-3 text-left">Process</th><th className="px-4 py-3 text-left">Received</th><th className="px-4 py-3 text-left">Status</th></tr>
                            </thead>
                            <tbody className="divide-y divide-slate-100">
                                {inbox.slice(0, 500).map(({ a, p }) => {
                                    const st = appStatusOf(a.status);
                                    return (
                                        <tr key={p.id + a.id} className="hover:bg-slate-50">
                                            <td className="px-4 py-2"><Link href={`/recruitment/students/detail?id=${p.id}&app=${encodeURIComponent(a.id)}`} className="font-semibold text-blue-700 hover:underline">{applicantName(a) || "No name"}</Link></td>
                                            <td className="px-4 py-2 text-slate-600">{[a.mobile, a.email].filter(Boolean).map(String).join(" · ")}</td>
                                            <td className="px-4 py-2 text-slate-600">{p.title}</td>
                                            <td className="px-4 py-2 text-slate-500 whitespace-nowrap">{ukShortDate(a.submittedAt)}</td>
                                            <td className="px-4 py-2"><span className={`text-[11px] font-semibold px-2 py-0.5 rounded-full border ${STATUS_STYLE[st]}`}>{st}</span></td>
                                        </tr>
                                    );
                                })}
                                {inbox.length === 0 && <tr><td colSpan={5} className="px-4 py-8 text-center text-slate-500"><Inbox className="mx-auto mb-2 text-slate-300" />Nothing here with these filters.</td></tr>}
                            </tbody>
                        </table>
                        {inbox.length > 500 && <p className="p-3 text-xs text-slate-500">Showing the newest 500 of {inbox.length}. Use the filters to narrow it down.</p>}
                    </div>
                </div>
            ) : (
                <div className="max-w-5xl space-y-4">
                    <p className="text-sm text-slate-600">Archived processes are kept with all their applications, read only. {isSuper ? "You can restore one." : "Only the super admin archives and restores processes."}</p>
                    <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                        {archivedProcs.length === 0 ? <p className="text-slate-500 p-4 bg-slate-50 rounded-lg border border-slate-100 text-sm">Nothing archived.</p>
                            : archivedProcs.map(p => (
                                <div key={p.id} className="relative">
                                    <ProcessCard p={p} />
                                    {isSuper && <button onClick={() => restore(p)} className="absolute bottom-4 right-4 text-xs font-semibold px-2 py-1 bg-white border border-slate-300 rounded hover:bg-slate-100 flex items-center gap-1"><RotateCcw size={12} /> Restore</button>}
                                </div>
                            ))}
                    </div>
                </div>
            )}

            {isCreateModalOpen && (
                <div className="fixed inset-0 bg-black/50 z-50 flex items-center justify-center p-4">
                    <div className="bg-white rounded-xl shadow-lg w-full max-w-2xl max-h-[90vh] overflow-y-auto">
                        <div className="p-5 border-b border-slate-100 bg-slate-50 flex justify-between items-center">
                            <h3 className="font-bold text-lg text-slate-800">New application process</h3>
                            <button onClick={() => setIsCreateModalOpen(false)} className="text-slate-400" aria-label="Close"><X size={20} /></button>
                        </div>
                        <form onSubmit={handleCreateProcess} className="p-6 space-y-4">
                            <div>
                                <label className="block text-sm font-semibold mb-1">Name</label>
                                <input required className="w-full p-2 border rounded" placeholder="e.g. Adults 50+ Salford, January 2027" value={formData.title} onChange={e => setFormData({ ...formData, title: e.target.value })} />
                                <p className="text-xs text-slate-500 mt-1">Applicants see this name at the top of the form.</p>
                            </div>
                            <div>
                                <label className="block text-sm font-semibold mb-1">Description (optional, staff only)</label>
                                <textarea className="w-full p-2 border rounded h-20" value={formData.description} onChange={e => setFormData({ ...formData, description: e.target.value })} />
                            </div>
                            <div>
                                <label className="block text-sm font-semibold mb-1">Form</label>
                                <select className="w-full p-2 border rounded" value={formData.formType} onChange={e => setFormData({ ...formData, formType: e.target.value as typeof formData.formType })}>
                                    {STUDENT_FORM_IDS.map(id => <option key={id} value={id}>{DEFAULT_TEMPLATES[id].name}</option>)}
                                </select>
                                <p className="text-xs text-slate-500 mt-1">The questions are edited in Recruitment &gt; Application Forms. <a className="text-blue-600 underline" href={`/apply?form=${formData.formType}&preview=1`} target="_blank" rel="noopener noreferrer">Preview this form</a></p>
                            </div>
                            <div className="grid grid-cols-2 gap-4">
                                <div>
                                    <label className="block text-sm font-semibold mb-1">Opens on (optional)</label>
                                    <input type="date" className="w-full p-2 border rounded" value={formData.opensOn} onChange={e => setFormData({ ...formData, opensOn: e.target.value })} />
                                </div>
                                <div>
                                    <label className="block text-sm font-semibold mb-1">Closes on (optional)</label>
                                    <input type="date" className="w-full p-2 border rounded" value={formData.closesOn} onChange={e => setFormData({ ...formData, closesOn: e.target.value })} />
                                </div>
                            </div>
                            <p className="text-xs text-slate-500 -mt-2">With a closing date the link stops working by itself after that day. Without one it stays open until you close it.</p>

                            <div className="pt-4 border-t">
                                <label className="block text-sm font-semibold mb-2">Which course is this application for?</label>
                                <div className="flex gap-4 mb-3">
                                    <label className="flex items-center gap-2 text-sm"><input type="radio" checked={courseChoice === "existing"} onChange={() => setCourseChoice("existing")} /> A course that already exists</label>
                                    <label className="flex items-center gap-2 text-sm"><input type="radio" checked={courseChoice === "new"} onChange={() => setCourseChoice("new")} /> A new course</label>
                                </div>
                                {courseChoice === "existing" ? (
                                    <div className="space-y-2">
                                        <select className="w-full p-2 border rounded" value={selectedCourseId} onChange={e => setSelectedCourseId(e.target.value)}>
                                            <option value="">Choose a course…</option>
                                            {courses.map(c => <option key={c.id} value={c.id}>{c.code ? `${c.code} ` : ""}{c.name}{c.status ? ` (${c.status})` : ""}</option>)}
                                        </select>
                                        {selectedCourse && (
                                            <div className="p-3 bg-slate-50 border border-slate-200 rounded text-sm space-y-1">
                                                <p><span className="text-slate-500">Type:</span> {selectedCourse.type || "Rolling"}</p>
                                                <p><span className="text-slate-500">When:</span> {describeSchedule(selectedCourse)}</p>
                                                <p><span className="text-slate-500">Dates:</span> {selectedCourse.startDate || "not set"} to {selectedCourse.endDate || "not set"}</p>
                                                <p><span className="text-slate-500">Where:</span> {[selectedCourse.setting === "Virtual" ? "Online" : selectedCourse.venue, selectedCourse.address, selectedCourse.postcode].filter(Boolean).join(", ") || "not set"}</p>
                                                <p><span className="text-slate-500">Status:</span> {selectedCourse.status}</p>
                                            </div>
                                        )}
                                    </div>
                                ) : (
                                    <div className="p-3 bg-slate-50 border border-slate-200 rounded">
                                        <p className="text-xs text-slate-500 mb-3">The course is created with these details. Its code is given automatically.</p>
                                        <CourseFields value={newCourse} onChange={setNewCourse} showCode={false} />
                                    </div>
                                )}
                            </div>

                            {createError && <p className="text-sm text-red-600" role="alert">{createError}</p>}
                            <div className="mt-6 flex justify-end gap-2 pt-4 border-t">
                                <button type="button" onClick={() => setIsCreateModalOpen(false)} className="px-4 py-2 hover:bg-slate-100 rounded font-medium">Cancel</button>
                                <button type="submit" disabled={creating} className="bg-blue-600 text-white px-5 py-2 rounded font-bold hover:bg-blue-700 disabled:opacity-60">{creating ? "Creating…" : "Create and publish"}</button>
                            </div>
                        </form>
                    </div>
                </div>
            )}
        </DashboardLayout>
    );
}

export default function GuardedApplicationProcessesOverview() {
    return (
        <RequirePermission perm="student_applications">
            <ApplicationProcessesOverview />
        </RequirePermission>
    );
}
