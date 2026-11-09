"use client";

// My Team (29 Sep 2026): the people someone line manages (users.managerId), with their
// leave and policy reading, and a button to email a reminder about unread policies.
// People with Approve Leave (admins, super admins) can switch to "Everyone".
// Data comes from the teamOverview function; reminders go through sendPolicyReminder.
import DashboardLayout from "@/components/layout/DashboardLayout";
import { useEffect, useState } from "react";
import Link from "next/link";
import { httpsCallable } from "firebase/functions";
import { functions } from "@/lib/firebase";
import { Bell, CalendarDays, CheckCircle2, FileText, ShieldAlert, Users } from "lucide-react";
import { useAuth } from "@/contexts/AuthContext";

type Person = {
    uid: string; name: string; email: string; role: string; managerName: string;
    leave: { remaining: number; total: number } | null; pendingLeave: number;
    // Only the policies meant for this person (audience) count; a read counts when it is of the current version.
    policies: { total: number; required?: number; read: number; percent?: number; unread: string[] };
};
const ROLE_LABEL: Record<string, string> = { volunteer: "Volunteer", staff: "Staff", admin: "Admin", super_admin: "Super admin", standard_user: "No access yet" };

function Team() {
    const [people, setPeople] = useState<Person[]>([]);
    const [seesAll, setSeesAll] = useState(false);
    const [everyone, setEveryone] = useState(false);
    const [loading, setLoading] = useState(true);
    const [busy, setBusy] = useState("");
    const [note, setNote] = useState<{ text: string; tone: "ok" | "err" } | null>(null);
    const [open, setOpen] = useState<string>("");
    const [loadError, setLoadError] = useState("");

    const load = async (all: boolean) => {
        setLoading(true); setLoadError("");
        try {
            const res = await httpsCallable(functions, "teamOverview")({ everyone: all });
            const d = res.data as { people: Person[]; seesAll: boolean };
            setPeople(d.people); setSeesAll(d.seesAll);
        } catch (e: any) {
            console.error(e);
            setPeople([]);
            setLoadError(e?.code === "functions/permission-denied" ? `You do not have permission to see My Team. ${e?.message || ""}` : "The team could not be loaded. Please try again.");
        }
        finally { setLoading(false); }
    };
    useEffect(() => { load(everyone); }, [everyone]);
    useEffect(() => { if (note?.tone === "ok") { const t = setTimeout(() => setNote(null), 8000); return () => clearTimeout(t); } }, [note]);

    const remind = async (ids: string[], label: string) => {
        if (!ids.length) return;
        if (!confirm(`Email ${label} a reminder of the policies they have not read yet?`)) return;
        setBusy(ids.length === 1 ? ids[0] : "all");
        try {
            const res = await httpsCallable(functions, "sendPolicyReminder")({ userIds: ids });
            const { sent } = res.data as { sent: number; skipped: number };
            setNote({ text: sent ? `✓ Reminder sent to ${sent} ${sent === 1 ? "person" : "people"}.` : "Nobody needed a reminder.", tone: "ok" });
        } catch (e) { console.error(e); setNote({ text: "The reminder was not sent.", tone: "err" }); }
        finally { setBusy(""); }
    };

    const withUnread = people.filter(p => p.policies && p.policies.unread.length > 0);
    const pendingTotal = people.reduce((t, p) => t + p.pendingLeave, 0);

    return (
        <div className="max-w-5xl">
            <h1 className="text-2xl font-bold text-slate-800 flex items-center gap-2"><Users size={24} /> My Team</h1>
            <p className="text-slate-500 mb-4">{everyone ? "Everyone in the system." : "The people you line manage."} Leave and policy reading at a glance.</p>

            <div className="flex flex-wrap items-center gap-2 mb-4">
                {seesAll && (
                    <div className="flex gap-1 p-1 rounded-lg bg-slate-100" role="tablist">
                        <button role="tab" aria-selected={!everyone} onClick={() => setEveryone(false)} className={`px-3 py-1.5 rounded-md text-sm font-semibold ${!everyone ? "bg-white shadow text-slate-800" : "text-slate-600"}`}>My team</button>
                        <button role="tab" aria-selected={everyone} onClick={() => setEveryone(true)} className={`px-3 py-1.5 rounded-md text-sm font-semibold ${everyone ? "bg-white shadow text-slate-800" : "text-slate-600"}`}>Everyone</button>
                    </div>
                )}
                <button onClick={() => remind(withUnread.map(p => p.uid), `all ${withUnread.length} people with unread policies`)} disabled={!withUnread.length || !!busy}
                    className="ml-auto px-4 py-2 rounded-lg bg-blue-600 text-white text-sm font-semibold flex items-center gap-2 disabled:opacity-50">
                    <Bell size={15} /> {busy === "all" ? "Sending…" : `Remind everyone with unread policies (${withUnread.length})`}
                </button>
            </div>

            {note && <div role={note.tone === "err" ? "alert" : "status"} className={`mb-4 p-3 rounded-lg border text-sm font-medium ${note.tone === "ok" ? "bg-green-50 border-green-300 text-green-800" : "bg-red-50 border-red-300 text-red-700"}`}>{note.text}</div>}

            <div className="grid grid-cols-3 gap-3 mb-5">
                <div className="bg-white rounded-xl border p-4 text-center"><div className="text-2xl font-bold text-slate-800">{people.length}</div><div className="text-xs text-slate-500 uppercase">People</div></div>
                <div className="bg-white rounded-xl border p-4 text-center"><div className="text-2xl font-bold text-orange-600">{pendingTotal}</div><div className="text-xs text-slate-500 uppercase">Leave requests waiting</div>{pendingTotal > 0 && <Link href="/leave?tab=team" className="text-xs text-blue-700 hover:underline">Review</Link>}</div>
                <div className="bg-white rounded-xl border p-4 text-center"><div className="text-2xl font-bold text-slate-800">{withUnread.length}</div><div className="text-xs text-slate-500 uppercase">With unread policies</div></div>
            </div>

            {loading ? <div className="p-8 text-slate-500">Loading…</div> : loadError ? (
                <div role="alert" className="p-4 rounded-lg bg-red-50 border border-red-300 text-red-700 text-sm flex items-center gap-3">
                    <span className="flex-1">{loadError}</span>
                    <button onClick={() => load(everyone)} className="px-3 py-1.5 rounded-lg bg-white border border-red-300 font-semibold">Try again</button>
                </div>
            ) : people.length === 0 ? (
                <div className="p-8 text-center text-slate-400 bg-slate-50 rounded-xl border border-dashed">{everyone ? "Nobody found." : "Nobody has you as their line manager yet."}</div>
            ) : (
                <div className="bg-white rounded-xl border divide-y">
                    {people.map(p => {
                        const required = p.policies.required ?? p.policies.total;
                        const pct = typeof p.policies.percent === "number" ? p.policies.percent : required ? Math.round((p.policies.read / required) * 100) : 100;
                        return (
                            <div key={p.uid} className="p-4">
                                <div className="flex flex-col md:flex-row md:items-center gap-3">
                                    <div className="md:w-1/3 min-w-0">
                                        <Link href={`/admin/volunteers/detail?id=${p.uid}`} className="font-semibold text-slate-800 hover:text-blue-700">{p.name}</Link>
                                        <p className="text-xs text-slate-500 truncate">{ROLE_LABEL[p.role] || p.role || "No role"} · {p.email}{everyone && p.managerName ? ` · manager ${p.managerName}` : ""}</p>
                                    </div>
                                    <div className="md:w-1/4 text-sm text-slate-600 flex items-center gap-2">
                                        <CalendarDays size={15} className="text-slate-400" />
                                        {p.role === "volunteer" ? "Not eligible (volunteer)" : p.leave ? `${p.leave.remaining} of ${p.leave.total} days left` : "Leave not set"}
                                        {p.pendingLeave > 0 && <span className="text-xs px-2 py-0.5 rounded-full bg-orange-100 text-orange-700 font-semibold">{p.pendingLeave} waiting</span>}
                                    </div>
                                    <div className="flex-1">
                                        <div className="flex items-center justify-between text-xs text-slate-600 mb-1">
                                            <span className="flex items-center gap-1"><FileText size={13} /> Policies read</span>
                                            <span className="font-semibold">{p.policies.read} of {required} ({pct}%)</span>
                                        </div>
                                        <div className="h-2 rounded bg-slate-100 overflow-hidden"><div className={`h-full rounded ${pct === 100 ? "bg-green-600" : "bg-amber-500"}`} style={{ width: `${pct}%` }} /></div>
                                    </div>
                                    <div className="flex gap-2 md:w-48 justify-end">
                                        {p.policies.unread.length > 0 ? (
                                            <>
                                                <button onClick={() => setOpen(open === p.uid ? "" : p.uid)} className="px-2.5 py-1.5 rounded-lg border border-slate-300 text-xs hover:bg-slate-50">{open === p.uid ? "Hide" : "Unread"}</button>
                                                <button onClick={() => remind([p.uid], p.name)} disabled={!!busy} className="px-2.5 py-1.5 rounded-lg bg-blue-50 text-blue-700 border border-blue-200 text-xs font-semibold flex items-center gap-1 disabled:opacity-50"><Bell size={12} /> {busy === p.uid ? "Sending…" : "Remind"}</button>
                                            </>
                                        ) : <span className="text-xs text-green-700 font-semibold flex items-center gap-1"><CheckCircle2 size={14} /> All read</span>}
                                    </div>
                                </div>
                                {open === p.uid && (
                                    <ul className="mt-3 ml-1 text-sm text-slate-700 list-disc list-inside bg-amber-50 border border-amber-200 rounded-lg p-3">
                                        {p.policies.unread.map(t => <li key={t}>{t}</li>)}
                                    </ul>
                                )}
                            </div>
                        );
                    })}
                </div>
            )}
        </div>
    );
}

export default function TeamPage() {
    const { user } = useAuth();
    const allowed = user?.role === "super_admin" || user?.role === "admin";
    return (
        <DashboardLayout>
            {allowed ? <Team /> : (
                <div className="p-8"><div className="max-w-md rounded-xl border border-amber-200 bg-amber-50 p-6">
                    <div className="flex items-center gap-2 text-amber-700 font-semibold"><ShieldAlert size={18} /> Admins only</div>
                    <p className="mt-2 text-sm text-amber-800">My Team is for the super admin and admins.</p>
                </div></div>
            )}
        </DashboardLayout>
    );
}
