"use client";

// Volunteer Applications pipeline (25 Sep 2026): New → Interview booked → decision.
import DashboardLayout from "@/components/layout/DashboardLayout";
import { useEffect, useMemo, useState } from "react";
import { collection, doc, getCountFromServer, getDoc, getDocs, orderBy, query, setDoc, where } from "firebase/firestore";
import { httpsCallable } from "firebase/functions";
import { db, functions } from "@/lib/firebase";
import Link from "next/link";
import { RequirePermission } from "@/components/auth/RequirePermission";
import { awaitingDecision, STATUS_LABEL, VolunteerApplicationDoc } from "@/lib/volunteerForm";
import { formatWhen } from "@/lib/recruitmentMail";
import { useAuth } from "@/contexts/AuthContext";
import RecipientPicker, { RecipientOption } from "@/components/recruitment/RecipientPicker";

// Who is told about every new application (29 Sep 2026). Stored in
// recruitmentSettings/alerts {emails, extra}; the server function
// volunteerApplicationReceived reads it. No document yet = all admins.
function AlertRecipients() {
    const { user } = useAuth();
    const [admins, setAdmins] = useState<RecipientOption[]>([]);
    const [pick, setPick] = useState<{ extra: string[]; ticked: string[] }>({ extra: [], ticked: [] });
    const [saved, setSaved] = useState<string>("");
    const [state, setState] = useState<"loading" | "ready" | "saving" | "error">("loading");
    const [open, setOpen] = useState(false);

    useEffect(() => {
        (async () => {
            try {
                const snap = await getDocs(query(collection(db, "users"), where("role", "in", ["admin", "super_admin"])));
                const list = snap.docs.map(d => ({ email: String(d.data().email || "").trim().toLowerCase(), label: String(d.data().displayName || d.data().name || "") }))
                    .filter(o => /@/.test(o.email)).sort((a, b) => a.label.localeCompare(b.label));
                setAdmins(list);
                const s = await getDoc(doc(db, "recruitmentSettings", "alerts"));
                const next = s.exists() && Array.isArray(s.data().emails)
                    ? { extra: (s.data().extra || []) as string[], ticked: s.data().emails as string[] }
                    : { extra: [], ticked: list.map(a => a.email) };
                setPick(next); setSaved(JSON.stringify(next)); setState("ready");
            } catch (e) { console.error(e); setState("error"); }
        })();
    }, []);

    const save = async () => {
        if (!pick.ticked.length) { alert("Tick at least one person, or nobody will know about new applications."); return; }
        setState("saving");
        try {
            await setDoc(doc(db, "recruitmentSettings", "alerts"), { emails: pick.ticked, extra: pick.extra, updatedBy: user?.uid || "", updatedAt: new Date().toISOString() });
            setSaved(JSON.stringify(pick)); setState("ready");
        } catch (e) { console.error(e); alert("Not saved. You may not have permission."); setState("ready"); }
    };
    const dirty = saved !== JSON.stringify(pick);

    return (
        <div className="mb-4 bg-white rounded-xl border p-4">
            <button type="button" onClick={() => setOpen(!open)} className="w-full flex justify-between items-center text-left">
                <span className="font-semibold text-slate-700 text-sm">New application alerts</span>
                <span className="text-xs text-slate-500">{state === "loading" ? "Loading…" : state === "error" ? "Could not load" : `${pick.ticked.length} ${pick.ticked.length === 1 ? "person" : "people"} ${open ? "▲" : "▼"}`}</span>
            </button>
            {open && state !== "loading" && state !== "error" && (
                <div className="mt-3 max-w-xl space-y-2">
                    <RecipientPicker title="Emailed about every new application" options={admins} extra={pick.extra} ticked={pick.ticked} onChange={setPick}
                        note="The applicant always gets their own copy of the application." />
                    <button onClick={save} disabled={!dirty || state === "saving"} className="px-3 py-1.5 rounded-lg bg-blue-600 text-white text-sm font-semibold disabled:opacity-50">{state === "saving" ? "Saving…" : dirty ? "Save" : "Saved"}</button>
                </div>
            )}
        </div>
    );
}

const COLUMNS: { id: string; label: string; tone: string }[] = [
    { id: "new", label: "New applications", tone: "border-blue-300 bg-blue-50" },
    { id: "decide", label: "Interviewed: decide now", tone: "border-amber-300 bg-amber-50" },
    { id: "interview", label: "Interview booked", tone: "border-yellow-300 bg-yellow-50" },
    { id: "accepted", label: "Accepted", tone: "border-green-300 bg-green-50" },
    { id: "declined", label: "Declined", tone: "border-slate-300 bg-slate-50" },
];

function VolunteerRecruitment() {
    const { user } = useAuth();
    const [apps, setApps] = useState<VolunteerApplicationDoc[]>([]);
    const [loading, setLoading] = useState(true);
    const [formOpen, setFormOpen] = useState(true);
    const [queued, setQueued] = useState(0);
    const [resending, setResending] = useState(false);
    const [resendMsg, setResendMsg] = useState("");
    const [copied, setCopied] = useState(false);
    const publicLink = typeof window !== "undefined" ? `${window.location.origin}/volunteer` : "https://shgh-portal.web.app/volunteer";

    useEffect(() => {
        (async () => {
            try {
                const snap = await getDocs(query(collection(db, "volunteer_applications"), orderBy("submittedAt", "desc")));
                setApps(snap.docs.map(d => ({ id: d.id, ...d.data() } as VolunteerApplicationDoc)));
                const s = await getDoc(doc(db, "settings", "volunteerForm"));
                setFormOpen(!(s.exists() && s.data().open === false));
                try {
                    // Count only, no email bodies downloaded (30 Sep 2026).
                    const m = await getCountFromServer(query(collection(db, "mail"), where("status", "in", ["queued", "waiting", "failed"])));
                    setQueued(m.data().count);
                } catch { /* no mail access */ }
            } catch (e) { console.error("Could not load volunteer applications", e); }
            finally { setLoading(false); }
        })();
    }, []);

    const grouped = useMemo(() => {
        const g: Record<string, VolunteerApplicationDoc[]> = { new: [], decide: [], interview: [], accepted: [], declined: [] };
        apps.forEach(a => {
            if (awaitingDecision(a)) g.decide.push(a);
            else (g[a.status] || g.new).push(a);
        });
        return g;
    }, [apps]);

    const toggleForm = async () => {
        const next = !formOpen;
        if (!confirm(next ? "Open the volunteer form? The public link will accept applications." : "Close the volunteer form? The public link will show that applications are closed.")) return;
        try {
            await setDoc(doc(db, "settings", "volunteerForm"), { open: next, changedBy: user?.uid || "", changedAt: new Date().toISOString() }, { merge: true });
            setFormOpen(next);
        } catch (e) { alert("The form could not be changed. You may not have permission."); console.error(e); }
    };

    return (
        <DashboardLayout>
            <div className="flex flex-wrap justify-between items-start gap-4 mb-6">
                <div>
                    <h1 className="text-2xl font-bold text-slate-800">Volunteer Applications</h1>
                    <p className="text-slate-500">Applications from the public volunteer form, from first contact to their first course.</p>
                </div>
                <div className="flex flex-wrap items-center gap-2">
                    <span className={`text-xs font-bold px-2 py-1 rounded-full ${formOpen ? "bg-green-100 text-green-700" : "bg-slate-200 text-slate-600"}`}>Form {formOpen ? "open" : "closed"}</span>
                    <button onClick={toggleForm} className="text-sm px-3 py-1.5 rounded-lg border border-slate-300 hover:bg-slate-50">{formOpen ? "Close form" : "Open form"}</button>
                    <button onClick={async () => { try { await navigator.clipboard.writeText(publicLink); setCopied(true); setTimeout(() => setCopied(false), 2000); } catch { prompt("Copy this link:", publicLink); } }}
                        className="text-sm px-3 py-1.5 rounded-lg bg-emerald-600 text-white hover:bg-emerald-700">{copied ? "Link copied" : "Copy form link"}</button>
                </div>
            </div>
            <AlertRecipients />
            {queued > 0 && (
                <div className="mb-4 p-3 rounded-lg bg-amber-50 border border-amber-200 text-sm text-amber-800">
                    {queued} recruitment email{queued === 1 ? " has" : "s have"} not gone out yet.{" "}
                    <button disabled={resending} onClick={async () => {
                        setResending(true);
                        try {
                            const res: any = (await httpsCallable(functions, "resendWaitingMail")({})).data;
                            setResendMsg(res?.firstError ? `Tried again. First error: ${res.firstError}` : "Sent again.");
                            const m = await getCountFromServer(query(collection(db, "mail"), where("status", "in", ["queued", "waiting", "failed"])));
                            setQueued(m.data().count);
                        } catch (e: any) { setResendMsg(e?.message || "Could not resend."); }
                        finally { setResending(false); }
                    }} className="ml-1 px-2 py-0.5 rounded bg-amber-600 text-white text-xs disabled:opacity-50">{resending ? "Sending…" : "Send waiting emails"}</button>
                    {resendMsg && <span className="ml-2">{resendMsg}</span>}
                </div>
            )}
            {loading ? <div className="p-8 text-slate-500">Loading…</div> : (
                <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-5 gap-4">
                    {COLUMNS.map(col => (
                        <div key={col.id} className={`rounded-xl border ${col.tone} p-3 min-h-[200px]`}>
                            <h2 className="font-bold text-slate-700 text-sm mb-3 flex justify-between">{col.label}<span className="bg-white px-2 rounded-full text-xs">{grouped[col.id].length}</span></h2>
                            <div className="space-y-2">
                                {grouped[col.id].map(a => (
                                    <Link key={a.id} href={`/recruitment/detail?id=${a.id}`} className="block bg-white rounded-lg p-3 shadow-sm hover:shadow border border-slate-100">
                                        <p className="font-semibold text-slate-800">{a.name}</p>
                                        <p className="text-xs text-slate-500">{a.role}</p>
                                        {a.interview?.start && (a.status === "interview") && <p className="text-xs text-slate-600 mt-1">Interview: {formatWhen(a.interview.start)}</p>}
                                        {col.id === "decide" && <p className="text-xs font-semibold text-amber-700 mt-1">Was {a.name.split(" ")[0]} accepted?</p>}
                                        <p className="text-[11px] text-slate-400 mt-1">{a.submittedAt?.toDate ? a.submittedAt.toDate().toLocaleDateString("en-GB") : ""} · {STATUS_LABEL[a.status] || a.status}{a.cvPath ? " · CV" : ""}</p>
                                    </Link>
                                ))}
                            </div>
                        </div>
                    ))}
                </div>
            )}
        </DashboardLayout>
    );
}

export default function GuardedVolunteerRecruitment() {
    return (
        <RequirePermission perm="volunteer_applications">
            <VolunteerRecruitment />
        </RequirePermission>
    );
}
