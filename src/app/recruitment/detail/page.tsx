"use client";

// One volunteer application (25 Sep 2026): answers, CV, private equality data,
// interview booking, and the decision that turns an applicant into a volunteer.
import DashboardLayout from "@/components/layout/DashboardLayout";
import { Suspense, useEffect, useState } from "react";
import { useSearchParams } from "next/navigation";
import Link from "next/link";
import { collection, doc, getDoc, getDocs, query, updateDoc, where } from "firebase/firestore";
import { httpsCallable } from "firebase/functions";
import { db, functions } from "@/lib/firebase";
import { useAuth } from "@/contexts/AuthContext";
import { RequirePermission } from "@/components/auth/RequirePermission";
import { AGREEMENT, AGREEMENT_SCORE, awaitingDecision, DAYS, MOTIVATION_GROUPS, MOTIVATION_SHORT, MOTIVATIONS, SLOTS, STATUS_LABEL, VolunteerApplicationDoc } from "@/lib/volunteerForm";
import { declineEmail, formatWhen, interviewIcsUid, interviewInvite, interviewUpdate, mailtoLink, queueMail, splitRecipients } from "@/lib/recruitmentMail";
import { isoToLondon, londonToIso, londonToday } from "@/lib/social/londonTime";
import RecipientPicker, { RecipientOption } from "@/components/recruitment/RecipientPicker";
import { extraAnswerRows, FormGroup, GROUP_COLORS, loadTemplate, SubmissionLabels } from "@/lib/formTemplates";
import { Course } from "@/lib/types";
import { ArrowLeft, CalendarPlus, CheckCircle2, Circle, Download, FileText, Mail, UserCheck, UserX } from "lucide-react";

// The four steps of Accept (1 Oct 2026), run by the server function acceptVolunteerApplication
// and recorded on the application under acceptSteps, so Accept again carries on where it stopped.
const ACCEPT_STEPS: { key: "account" | "profile" | "course" | "welcome"; label: string }[] = [
    { key: "account", label: "Login created or reused" },
    { key: "profile", label: "Volunteer profile saved" },
    { key: "course", label: "Assigned to the course" },
    { key: "welcome", label: "Welcome email with the password link queued" },
];
type StepRecord = { at?: { toDate?: () => Date } | string; created?: boolean; upgraded?: boolean; courseId?: string };
type AppExtra = { acceptSteps?: Partial<Record<"account" | "profile" | "course" | "welcome", StepRecord>>; interviewIcsUid?: string; interviewIcsSequence?: number };

function callableMessage(e: unknown): string {
    const m = (e as { message?: string })?.message || "";
    return m && !/^internal$/i.test(m) ? m : "The server did not answer. Try again in a minute.";
}

type MailRow = { id: string; to: string[]; cc?: string[]; subject: string; text: string; ics?: string; icsName?: string; status: string; kind: string; error?: string; createdAt?: any };

function downloadText(name: string, text: string, type: string) {
    const url = URL.createObjectURL(new Blob([text], { type }));
    const a = document.createElement("a"); a.href = url; a.download = name; a.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
}

// The statements as a chart (29 Sep 2026): grouped by category, one bar per statement on
// the three-step scale A Little / Some / A Lot, and a score per category. The wording and
// groups come from what the applicant saw (labels), so an edited form never breaks old ones.
function MotivationChart({ answers, labels, groups: groupDefs }: { answers: Record<string, string>; labels?: Partial<SubmissionLabels>; groups: FormGroup[] }) {
    const texts: Record<string, string> = labels?.statements && Object.keys(labels.statements).length
        ? labels.statements : Object.fromEntries(MOTIVATIONS.map(m => [m.key, m.text]));
    const groupOf = (k: string) => labels?.groups?.[k] || MOTIVATION_GROUPS.find(g => g.keys.includes(k))?.name || "Other";
    const names: string[] = [];
    [...groupDefs.map(g => g.name), ...Object.keys(texts).map(groupOf)].forEach(n => { if (!names.includes(n)) names.push(n); });
    const groups = names.map((name, i) => {
        const keys = Object.keys(texts).filter(k => groupOf(k) === name);
        const scores = keys.map(k => AGREEMENT_SCORE[answers?.[k]] || 0).filter(Boolean);
        const color = groupDefs.find(g => g.name === name)?.color || GROUP_COLORS[i % GROUP_COLORS.length];
        return { name, color, keys, avg: scores.length ? scores.reduce((a, b) => a + b, 0) / scores.length : 0 };
    }).filter(g => g.keys.length);
    return (
        <div>
            <div className="grid grid-cols-2 gap-2 mb-4" aria-label="Score per category">
                {groups.map(g => (
                    <div key={g.name} className="rounded-lg border border-slate-200 p-2" title={`${g.name}: ${g.avg ? g.avg.toFixed(1) : "no answer"} out of 3`}>
                        <div className="flex items-center justify-between text-xs"><span className="flex items-center gap-1.5 font-semibold text-slate-700"><span className="w-2.5 h-2.5 rounded-sm" style={{ background: g.color }} />{g.name}</span><span className="text-slate-600 tabular-nums">{g.avg ? g.avg.toFixed(1) : "—"} / 3</span></div>
                        <div className="mt-1.5 h-2 rounded bg-slate-100 overflow-hidden"><div className="h-full rounded" style={{ width: `${(g.avg / 3) * 100}%`, background: g.color }} /></div>
                    </div>
                ))}
            </div>
            <div className="flex items-center text-[11px] text-slate-500 mb-1"><span className="w-40 shrink-0" /><div className="flex-1 grid grid-cols-3 gap-[2px] text-center">{AGREEMENT.map(a => <span key={a}>{a}</span>)}</div><span className="w-14 shrink-0" /></div>
            {groups.map(g => (
                <div key={g.name} className="mb-3">
                    <p className="text-xs font-bold text-slate-700 mb-1 flex items-center gap-1.5"><span className="w-2.5 h-2.5 rounded-sm" style={{ background: g.color }} />{g.name}</p>
                    {g.keys.map(k => {
                        const v = answers?.[k]; const n = AGREEMENT_SCORE[v] || 0;
                        return (
                            <div key={k} className="flex items-center py-0.5 group" title={`${texts[k]} ${v || "No answer"}`}>
                                <span className="w-40 shrink-0 text-xs text-slate-600 pr-2 truncate group-hover:text-slate-900">{MOTIVATION_SHORT[k] || texts[k]}</span>
                                <div className="flex-1 grid grid-cols-3 gap-[2px]">
                                    {[1, 2, 3].map(i => <div key={i} className={`h-3.5 ${i === 1 ? "rounded-l" : ""} ${i === 3 ? "rounded-r" : ""}`} style={{ background: i <= n ? g.color : "#f1f5f9" }} />)}
                                </div>
                                <span className="w-14 shrink-0 text-right text-xs font-medium text-slate-700">{v || "—"}</span>
                            </div>
                        );
                    })}
                </div>
            ))}
        </div>
    );
}

function Detail() {
    const id = useSearchParams().get("id") || "";
    const { user } = useAuth();
    const [app, setApp] = useState<(VolunteerApplicationDoc & AppExtra) | null>(null);
    // A wrong or old link (1 Oct 2026) says so instead of "Loading" for ever.
    const [loadState, setLoadState] = useState<"loading" | "ready" | "missing" | "error">("loading");
    const [loadError, setLoadError] = useState("");
    const [equality, setEquality] = useState<Record<string, any> | null>(null);
    const [groupDefs, setGroupDefs] = useState<FormGroup[]>(MOTIVATION_GROUPS.map(g => ({ name: g.name, color: g.color })));
    const [mails, setMails] = useState<MailRow[]>([]);
    const [courses, setCourses] = useState<Course[]>([]);
    const [busy, setBusy] = useState("");
    // Feedback that cannot be missed (29 Sep 2026): a toast at the bottom of the screen,
    // plus "sent" / "accepted" boxes next to the buttons themselves.
    const [msg, setMsgObj] = useState<{ text: string; tone: "ok" | "err" } | null>(null);
    const setMsg = (text: string, tone: "ok" | "err" = "err") => setMsgObj(text ? { text, tone } : null);
    const [justSent, setJustSent] = useState("");
    // interview form
    const [ivDate, setIvDate] = useState("");
    const [ivTime, setIvTime] = useState("10:00");
    const [ivLen, setIvLen] = useState(30);
    const [ivWhere, setIvWhere] = useState("Online (Microsoft Teams link to follow)");
    const [ivNotes, setIvNotes] = useState("");
    const [courseId, setCourseId] = useState("");
    // who receives the emails (29 Sep 2026)
    const [admins, setAdmins] = useState<RecipientOption[]>([]);
    const [ivPick, setIvPick] = useState<{ extra: string[]; ticked: string[] }>({ extra: [], ticked: [] });
    const [decPick, setDecPick] = useState<{ extra: string[]; ticked: string[] }>({ extra: [], ticked: [] });

    const load = async () => {
        let s;
        try { s = await getDoc(doc(db, "volunteer_applications", id)); } catch (e) {
            console.error(e);
            setApp(null); setLoadState("error");
            setLoadError((e as { code?: string })?.code === "permission-denied" ? "You do not have permission to open volunteer applications." : "The application could not be loaded. Check your connection and refresh the page.");
            return;
        }
        if (!s.exists()) { setApp(null); setLoadState("missing"); return; }
        setApp({ id: s.id, ...s.data() } as VolunteerApplicationDoc & AppExtra);
        setLoadState("ready");
        try { const e = await getDoc(doc(db, "volunteer_applications", id, "private", "equality")); setEquality(e.exists() ? e.data() as Record<string, any> : null); } catch { setEquality(null); }
        try {
            const m = await getDocs(query(collection(db, "mail"), where("applicationId", "==", id)));
            setMails(m.docs.map(d => ({ id: d.id, ...d.data() } as MailRow)).sort((a, b) => (b.createdAt?.seconds || 0) - (a.createdAt?.seconds || 0)));
        } catch { setMails([]); }
    };

    useEffect(() => {
        if (!id) { setLoadState("missing"); return; }
        setLoadState("loading");
        load();
        getDocs(collection(db, "course")).then(snap => setCourses(snap.docs.map(d => ({ id: d.id, ...d.data() } as Course))
            .filter(c => c.status === "Running" || c.status === "Planned").sort((a, b) => (a.code || "").localeCompare(b.code || ""))));
        loadTemplate("volunteer").then(t => { if (t.groups?.length) setGroupDefs(t.groups); });
        getDocs(query(collection(db, "users"), where("role", "in", ["admin", "super_admin"])))
            .then(snap => setAdmins(snap.docs.map(d => ({ email: String(d.data().email || "").trim().toLowerCase(), label: String(d.data().displayName || d.data().name || "") }))
                .filter(o => /@/.test(o.email)).sort((a, b) => a.label.localeCompare(b.label))))
            .catch(() => setAdmins([]));
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [id]);

    // Default ticks: interview = applicant + you; accept / decline = applicant only.
    const applicantEmail = (app?.email || "").trim().toLowerCase();
    const myEmail = (user?.email || "").trim().toLowerCase();
    useEffect(() => {
        if (msg?.tone !== "ok") return;
        const t = setTimeout(() => setMsgObj(null), 10000);
        return () => clearTimeout(t);
    }, [msg]);
    useEffect(() => {
        if (!justSent) return;
        const t = setTimeout(() => setJustSent(""), 6000);
        return () => clearTimeout(t);
    }, [justSent]);

    useEffect(() => {
        if (!applicantEmail) return;
        setIvPick({ extra: [], ticked: [applicantEmail, ...(myEmail ? [myEmail] : [])] });
        setDecPick({ extra: [], ticked: [applicantEmail] });
    }, [applicantEmail, myEmail]);

    // The booked interview fills the form in UK time, so changing it starts from what is booked.
    const bookedStart = app?.interview?.start || "";
    useEffect(() => {
        if (!bookedStart) return;
        const t = isoToLondon(bookedStart);
        if (t.date) { setIvDate(t.date); setIvTime(t.time); }
        if (app?.interview?.durationMinutes) setIvLen(app.interview.durationMinutes);
        if (app?.interview?.location) setIvWhere(app.interview.location);
        setIvNotes(app?.interview?.notes || "");
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [bookedStart]);

    if (loadState === "missing" || (!id && !app)) return (
        <div className="max-w-xl">
            <Link href="/recruitment" className="text-blue-600 hover:underline flex items-center gap-1 text-sm font-semibold mb-3"><ArrowLeft size={16} /> Back to Volunteer Applications</Link>
            <div className="bg-white rounded-xl border p-6">
                <h1 className="text-xl font-bold text-slate-800">Application not found</h1>
                <p className="text-sm text-slate-600 mt-2">This link does not match any application. It may be an old link, or the application may have been deleted.</p>
            </div>
        </div>
    );
    if (loadState === "error") return (
        <div className="max-w-xl">
            <Link href="/recruitment" className="text-blue-600 hover:underline flex items-center gap-1 text-sm font-semibold mb-3"><ArrowLeft size={16} /> Back to Volunteer Applications</Link>
            <div className="bg-white rounded-xl border border-red-200 p-6">
                <h1 className="text-xl font-bold text-slate-800">The application could not be opened</h1>
                <p className="text-sm text-slate-600 mt-2">{loadError}</p>
            </div>
        </div>
    );
    if (!app) return <p className="p-6 text-slate-500">Loading…</p>;

    const who = { id: app.id, name: app.name, email: app.email, role: app.role };
    const people: RecipientOption[] = [
        { email: applicantEmail, label: `${app.name} (applicant)` },
        ...(myEmail ? [{ email: myEmail, label: "You" }] : []),
        ...admins.filter(a => a.email !== applicantEmail && a.email !== myEmail),
    ];
    const decide = awaitingDecision(app);

    const openCv = async () => {
        setBusy("cv");
        try {
            const res = await httpsCallable(functions, "getVolunteerCv")({ applicationId: app.id });
            const { base64, name } = res.data as { base64: string; name: string };
            const bytes = Uint8Array.from(atob(base64), c => c.charCodeAt(0));
            const url = URL.createObjectURL(new Blob([bytes], { type: "application/pdf" }));
            const w = window.open(url, "_blank");
            if (!w) { const a = document.createElement("a"); a.href = url; a.download = name || "cv.pdf"; a.click(); }
        } catch (e) { console.error(e); alert("The CV could not be opened."); }
        finally { setBusy(""); }
    };

    const bookInterview = async (e: React.FormEvent) => {
        e.preventDefault();
        if (!ivDate || !ivTime || !ivWhere.trim()) { setMsg("Choose the date, time and place."); return; }
        // The date and time are UK time whatever zone the computer is set to.
        const startIso = londonToIso(ivDate, ivTime);
        if (!startIso) { setMsg("That date or time is not valid."); return; }
        const rcpt = splitRecipients(app.email, ivPick.ticked);
        if (!rcpt.to.length) { setMsg("Tick at least one person to receive the invitation."); return; }
        const prev = app.interview;
        const isChange = !!prev;
        const moved = !!prev && Date.parse(prev.start) !== Date.parse(startIso);
        const sameDetails = !!prev && !moved && prev.durationMinutes === ivLen && prev.location === ivWhere.trim() && (prev.notes || "") === ivNotes.trim();
        if (isChange) {
            const q = moved
                ? `Move ${app.name}'s interview to ${formatWhen(startIso)}?\n\nThey get a short email and an updated calendar invitation that replaces the first one.`
                : sameDetails
                    ? `Nothing has changed. Send ${app.name} the calendar invitation for ${formatWhen(startIso)} again?`
                    : `Send ${app.name} the changed interview details and an updated calendar invitation?`;
            if (!confirm(q)) return;
        }
        if (busy) return;
        setBusy("interview"); setMsg("");
        try {
            const iv = { start: startIso, durationMinutes: ivLen, location: ivWhere.trim(), notes: ivNotes.trim(),
                invitedBy: user?.uid || "", invitedByName: user?.displayName || "", invitedAt: new Date().toISOString() };
            // One calendar event per application: the same UID every time, SEQUENCE + 1 per change.
            const uid = interviewIcsUid(app);
            const sequence = isChange ? (typeof app.interviewIcsSequence === "number" ? app.interviewIcsSequence : 0) + (sameDetails ? 0 : 1) : 0;
            const mail = isChange ? interviewUpdate(who, iv, rcpt, { uid, sequence }, prev?.start) : interviewInvite(who, iv, rcpt, { uid, sequence });
            await updateDoc(doc(db, "volunteer_applications", app.id), { status: "interview", interview: iv, interviewIcsUid: uid, interviewIcsSequence: sequence });
            await queueMail(mail, user?.uid || "");
            setMsg(`${isChange ? (moved ? "Interview moved. Update" : "Update") : "Invitation"} sent to ${rcpt.to.join(", ")}${rcpt.cc.length ? `, copy to ${rcpt.cc.join(", ")}` : ""}.`, "ok");
            setJustSent("interview");
            await load();
            setTimeout(() => { load(); }, 6000); // pick up "sent" once the server has sent it
        } catch (err) { console.error(err); setMsg(`The interview could not be saved. ${(err as { message?: string })?.message || ""}`.trim()); }
        finally { setBusy(""); }
    };

    // Accept is ONE server step (1 Oct 2026): login, profile, course and welcome email are done by
    // acceptVolunteerApplication. Each finished step is recorded, so pressing Accept again resumes.
    const accept = async () => {
        const course = courses.find(c => c.id === courseId);
        const rcpt = splitRecipients(app.email, decPick.ticked);
        if (!rcpt.to.length) { setMsg("Tick at least one person to receive the welcome email."); return; }
        const resuming = !!app.acceptSteps && Object.keys(app.acceptSteps).length > 0;
        if (!confirm(resuming
            ? `Carry on accepting ${app.name}? The steps already done are not repeated.`
            : `Accept ${app.name} as a volunteer?\n\nThis creates their login, adds them to the Volunteers list${course ? `, assigns them to ${course.code} ${course.name}` : ""} and emails them a link to set their password.`)) return;
        if (busy) return;
        setBusy("accept"); setMsg("");
        try {
            const res = await httpsCallable(functions, "acceptVolunteerApplication", { timeout: 130000 })({ applicationId: app.id, courseId: course?.id || "", recipients: rcpt });
            const out = res.data as { steps?: Record<string, { upgraded?: boolean }> };
            const upgraded = !!out.steps?.account?.upgraded;
            setMsg(`${app.name} is now a volunteer${upgraded ? " (their existing account was switched to volunteer)" : ""}. The welcome email with the password link is on its way.`, "ok");
            await load();
            setTimeout(() => { load(); }, 6000); // pick up "sent" once the server has sent it
        } catch (err) {
            console.error(err);
            setMsg(`Not accepted yet. ${callableMessage(err)}`);
            await load();
        } finally { setBusy(""); }
    };

    const stepList = () => {
        const st = app.acceptSteps || {};
        const wantCourse = !!(st.course || courseId || app.decision?.courseId);
        if (!Object.keys(st).length) return null;
        return (
            <ul className="mt-3 space-y-1 text-sm" aria-label="Acceptance steps">
                {ACCEPT_STEPS.filter(s => s.key !== "course" || wantCourse).map(s => {
                    const r = st[s.key];
                    const at = r?.at && typeof r.at === "object" && r.at.toDate ? r.at.toDate().toLocaleString("en-GB", { dateStyle: "medium", timeStyle: "short" }) : "";
                    const extra = s.key === "account" && r ? (r.created ? " (new login)" : r.upgraded ? " (existing account switched to volunteer)" : " (existing login reused)") : "";
                    return (
                        <li key={s.key} className={`flex items-center gap-2 ${r ? "text-green-800" : "text-slate-500"}`}>
                            {r ? <CheckCircle2 size={16} className="text-green-600 shrink-0" /> : <Circle size={16} className="text-slate-300 shrink-0" />}
                            <span>{s.label}{extra}{at ? `, ${at}` : ""}{r ? "" : ": not done yet"}</span>
                        </li>
                    );
                })}
            </ul>
        );
    };

    const decline = async () => {
        const rcpt = splitRecipients(app.email, decPick.ticked);
        if (!rcpt.to.length) { setMsg("Tick at least one person to receive the email."); return; }
        if (!confirm(`Decline ${app.name}? A polite email will be sent to them.`)) return;
        if (busy) return;
        setBusy("decline"); setMsg("");
        try {
            await queueMail(declineEmail(who, rcpt), user?.uid || "");
            await updateDoc(doc(db, "volunteer_applications", app.id), { status: "declined", decision: { by: user?.uid || "", at: new Date().toISOString(), outcome: "declined" } });
            setMsg(`Declined. The email has been sent to ${rcpt.to.join(", ")}.`, "ok");
            await load();
            setTimeout(() => { load(); }, 6000); // pick up "sent" once the server has sent it
        } catch (err) { console.error(err); setMsg("That did not work."); }
        finally { setBusy(""); }
    };

    const remove = async () => {
        if (!confirm(`Delete ${app.name}'s application completely, including their CV? This cannot be undone.`)) return;
        setBusy("delete");
        try {
            await httpsCallable(functions, "deleteVolunteerApplication")({ applicationId: app.id });
            window.location.href = "/recruitment";
        } catch (e) { console.error(e); alert("The application could not be deleted."); setBusy(""); }
    };

    const sentBox = (list: MailRow[], what: string) => {
        if (!list.length) return null;
        const m = list[0];
        const when = m.createdAt?.toDate ? m.createdAt.toDate().toLocaleString("en-GB", { dateStyle: "medium", timeStyle: "short" }) : "";
        const tone = m.status === "sent" ? "bg-green-50 border-green-300 text-green-800" : m.status === "failed" ? "bg-red-50 border-red-300 text-red-800" : "bg-amber-50 border-amber-300 text-amber-800";
        return (
            <div className={`p-3 rounded-lg border text-sm ${tone}`} role="status">
                <p className="font-semibold">{m.status === "sent" ? "✓ " : ""}{what} {m.status === "sent" ? "sent" : m.status === "failed" ? "not sent" : "waiting to be sent"}{when ? ` on ${when}` : ""}{list.length > 1 ? ` (sent ${list.length} times)` : ""}</p>
                <p>To {m.to.join(", ")}{m.cc && m.cc.length ? `, copy to ${m.cc.join(", ")}` : ""}{m.status === "failed" && m.error ? `. Error: ${m.error}` : ""}</p>
            </div>
        );
    };

    const Row = ({ k, v }: { k: string; v?: string }) => <div className="flex justify-between gap-4 py-1.5 border-b border-slate-100 text-sm"><span className="text-slate-500">{k}</span><span className="font-medium text-right">{v || "—"}</span></div>;

    return (
        <div className="max-w-5xl">
            <Link href="/recruitment" className="text-blue-600 hover:underline flex items-center gap-1 text-sm font-semibold mb-3"><ArrowLeft size={16} /> Back to Volunteer Applications</Link>
            <div className="flex flex-wrap items-center gap-3 mb-6">
                <h1 className="text-2xl font-bold text-slate-800">{app.name}</h1>
                <span className="text-xs font-bold px-2 py-1 rounded-full bg-slate-100 text-slate-700">{STATUS_LABEL[app.status] || app.status}</span>
                <span className="text-sm text-slate-500">{app.role}</span>
                <button onClick={remove} disabled={!!busy} className="ml-auto text-xs px-3 py-1.5 rounded-lg border border-red-200 text-red-600 hover:bg-red-50 disabled:opacity-60">{busy === "delete" ? "Deleting…" : "Delete application"}</button>
            </div>
            {msg && (
                <div role={msg.tone === "err" ? "alert" : "status"} className={`fixed z-50 bottom-6 left-1/2 -translate-x-1/2 w-[min(92vw,36rem)] p-4 rounded-xl shadow-lg border flex items-start gap-3 text-sm ${msg.tone === "ok" ? "bg-green-600 border-green-700 text-white" : "bg-red-600 border-red-700 text-white"}`}>
                    <span className="font-bold text-lg leading-none">{msg.tone === "ok" ? "✓" : "!"}</span>
                    <span className="flex-1">{msg.text}</span>
                    <button onClick={() => setMsgObj(null)} className="font-bold opacity-80 hover:opacity-100" aria-label="Close">×</button>
                </div>
            )}

            <div className="grid md:grid-cols-2 gap-6">
                <div className="bg-white rounded-xl border p-5">
                    <h2 className="font-bold mb-2">About them</h2>
                    <Row k="Email" v={app.email} /><Row k="Phone" v={app.phone} /><Row k="Age" v={app.age} /><Row k="Gender" v={app.gender} />
                    <Row k="Role" v={app.role} /><Row k="Heard about us" v={app.heardFrom === "Other" ? `Other: ${app.heardFromOther}` : app.heardFrom} />
                    <Row k="Applied" v={app.submittedAt?.toDate ? app.submittedAt.toDate().toLocaleString("en-GB") : ""} />
                    <div className="mt-3 flex items-center gap-2">
                        {app.cvPath
                            ? <button onClick={openCv} disabled={busy === "cv"} className="text-sm px-3 py-1.5 rounded-lg bg-slate-800 text-white flex items-center gap-1 disabled:opacity-60"><FileText size={14} /> {busy === "cv" ? "Opening…" : "Open CV"}</button>
                            : <span className="text-sm text-slate-400">No CV uploaded</span>}
                    </div>
                    <div className="mt-4 p-3 rounded-lg bg-slate-50 border text-sm">
                        <p className="font-semibold text-slate-600 mb-1">Private (equality monitoring)</p>
                        {equality ? <>{equality.nationality && <p>Nationality: {equality.nationality}</p>}<p>Ethnicity: {equality.ethnicity === "Other" ? `Other: ${equality.ethnicityOther}` : equality.ethnicity}</p><p>Disability: {equality.disability}</p>{extraAnswerRows(equality.answers, (app as { labels?: SubmissionLabels }).labels).map(r => <p key={r.label}>{r.label}: {r.value}</p>)}</> : <p className="text-slate-400">Not available</p>}
                    </div>
                </div>

                <div className="bg-white rounded-xl border p-5">
                    <h2 className="font-bold mb-2">Why they want to volunteer</h2>
                    {app.motivationText && <div className="mb-4 p-3 rounded-lg bg-emerald-50 border border-emerald-200 text-sm text-slate-800 whitespace-pre-wrap"><p className="font-semibold text-emerald-800 mb-1">In their own words</p>{app.motivationText}</div>}
                    <MotivationChart answers={app.motivations || {}} labels={(app as { labels?: SubmissionLabels }).labels} groups={groupDefs} />
                </div>
            </div>

            {extraAnswerRows((app as { answers?: Record<string, unknown> }).answers, (app as { labels?: SubmissionLabels }).labels).length > 0 && (
                <div className="bg-white rounded-xl border p-5 mt-6">
                    <h2 className="font-bold mb-2">Other answers</h2>
                    {extraAnswerRows((app as { answers?: Record<string, unknown> }).answers, (app as { labels?: SubmissionLabels }).labels).map(r => <Row key={r.label} k={r.label} v={r.value} />)}
                </div>
            )}

            <div className="bg-white rounded-xl border p-5 mt-6 overflow-x-auto">
                <h2 className="font-bold mb-3">Weekly availability</h2>
                <table className="text-xs w-full min-w-[36rem] table-fixed border-separate" style={{ borderSpacing: "2px" }}>
                    <thead><tr><th className="w-16"></th>{DAYS.map(d => <th key={d} className="p-1 font-semibold text-slate-700">{d.slice(0, 3)}</th>)}</tr></thead>
                    <tbody>
                        {SLOTS.map(s => (
                            <tr key={s}><td className="pr-2 text-right text-slate-500 whitespace-nowrap tabular-nums">{s.slice(0, 5)}</td>
                                {DAYS.map(d => {
                                    const on = (app.availability?.[d] || []).includes(s);
                                    return <td key={d} title={`${d} ${s}: ${on ? "available" : "not available"}`}><div className={`h-6 rounded ${on ? "bg-emerald-500" : "bg-slate-100"}`} /></td>;
                                })}</tr>
                        ))}
                        <tr><td className="pr-2 text-right text-slate-500">Total</td>{DAYS.map(d => { const n = (app.availability?.[d] || []).length; return <td key={d} className="text-center font-semibold text-slate-700 pt-1">{n ? `${n} h` : "—"}</td>; })}</tr>
                    </tbody>
                </table>
                <p className="text-xs text-slate-500 mt-2 flex items-center gap-2"><span className="inline-block w-3 h-3 rounded bg-emerald-500" /> Available <span className="inline-block w-3 h-3 rounded bg-slate-100 border" /> Not available</p>
            </div>

            {(app.status === "new" || app.status === "interview") && (
                <form onSubmit={bookInterview} className="bg-white rounded-xl border p-5 mt-6 space-y-3">
                    <h2 className="font-bold flex items-center gap-2"><CalendarPlus size={18} /> {app.interview ? "Change the interview" : "Invite to an interview"}</h2>
                    {app.interview && <p className="text-sm text-slate-600">Booked: {formatWhen(app.interview.start)}, {app.interview.durationMinutes} min, {app.interview.location}. Change the details below and send: they get a short email and the calendar event moves (UK time).</p>}
                    <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
                        <label className="text-xs text-slate-500">Date<input type="date" className="w-full p-2 border rounded text-sm text-slate-800" value={ivDate} min={londonToday()} onChange={e => setIvDate(e.target.value)} /></label>
                        <label className="text-xs text-slate-500">Time<input type="time" className="w-full p-2 border rounded text-sm text-slate-800" value={ivTime} onChange={e => setIvTime(e.target.value)} /></label>
                        <label className="text-xs text-slate-500">Length<select className="w-full p-2 border rounded text-sm text-slate-800" value={ivLen} onChange={e => setIvLen(Number(e.target.value))}>{[15, 20, 30, 45, 60].map(m => <option key={m} value={m}>{m} min</option>)}</select></label>
                        <label className="text-xs text-slate-500 col-span-2 md:col-span-1">Where<input className="w-full p-2 border rounded text-sm text-slate-800" value={ivWhere} onChange={e => setIvWhere(e.target.value)} /></label>
                    </div>
                    <textarea className="w-full p-2 border rounded text-sm h-16" placeholder="Anything they should know (optional): what to bring, who they will meet…" value={ivNotes} onChange={e => setIvNotes(e.target.value)} />
                    <RecipientPicker title="Who receives the invitation and calendar invite" options={people} extra={ivPick.extra} ticked={ivPick.ticked} onChange={setIvPick}
                        note="The applicant gets it directly; everyone else ticked gets a copy." />
                    {sentBox(mails.filter(m => m.kind === "interview"), "Invitation")}
                    <button type="submit" disabled={busy === "interview"} className={`px-4 py-2 rounded-lg text-white font-semibold disabled:opacity-60 ${justSent === "interview" ? "bg-green-600" : "bg-blue-600"}`}>
                        {busy === "interview" ? "Sending…" : justSent === "interview" ? "✓ Sent" : app.interview ? "Send the change" : "Book and send the invitation"}
                    </button>
                </form>
            )}

            {(app.status === "new" || app.status === "interview") && (
                <div className={`rounded-xl border p-5 mt-6 ${decide ? "bg-amber-50 border-amber-300" : "bg-white"}`}>
                    <h2 className="font-bold mb-1">{decide ? `The interview has happened. Was ${app.name.split(" ")[0]} accepted?` : "Decision"}</h2>
                    <p className="text-sm text-slate-500 mb-3">Accepting creates their login, adds them to Volunteers with these details, and emails them how to start with a link to set their password.</p>
                    {app.acceptSteps && Object.keys(app.acceptSteps).length > 0 && (
                        <div className="mb-3 p-3 rounded-lg bg-white border border-amber-300">
                            <p className="text-sm font-semibold text-amber-800">The acceptance stopped part way. Press Yes, accept again to carry on from the first step not done.</p>
                            {stepList()}
                        </div>
                    )}
                    <div className="mb-3 max-w-xl"><RecipientPicker title="Who receives the welcome or decline email" options={people} extra={decPick.extra} ticked={decPick.ticked} onChange={setDecPick} /></div>
                    <div className="flex flex-wrap items-end gap-3">
                        <label className="text-xs text-slate-500">Assign to a course now (optional)
                            <select className="block p-2 border rounded text-sm text-slate-800 min-w-[16rem]" value={courseId} onChange={e => setCourseId(e.target.value)}>
                                <option value="">Not yet: we will assign them soon</option>
                                {courses.map(c => <option key={c.id} value={c.id}>{c.code} {c.name}</option>)}
                            </select>
                        </label>
                        <button onClick={accept} disabled={!!busy} className="px-4 py-2 rounded-lg bg-green-600 text-white font-semibold flex items-center gap-1 disabled:opacity-60"><UserCheck size={16} /> {busy === "accept" ? "Accepting… (up to a minute)" : "Yes, accept"}</button>
                        <button onClick={decline} disabled={!!busy} className="px-4 py-2 rounded-lg bg-white border border-slate-300 font-semibold flex items-center gap-1 disabled:opacity-60"><UserX size={16} /> {busy === "decline" ? "Declining…" : "No, decline"}</button>
                    </div>
                </div>
            )}

            {(app.status === "accepted" || app.status === "declined") && (
                <div className={`rounded-xl border p-5 mt-6 ${app.status === "accepted" ? "bg-green-50 border-green-300" : "bg-slate-50 border-slate-300"}`}>
                    <h2 className="font-bold text-lg flex items-center gap-2">{app.status === "accepted" ? <><UserCheck size={20} className="text-green-700" /> Accepted</> : <><UserX size={20} /> Declined</>}</h2>
                    <p className="text-sm text-slate-700 mt-1">
                        {app.decision?.at ? new Date(app.decision.at).toLocaleString("en-GB", { dateStyle: "medium", timeStyle: "short" }) : ""}
                        {app.status === "accepted" ? `. ${app.name} has a login and is in the Volunteers list${app.decision?.courseId ? `, assigned to ${courses.find(c => c.id === app.decision?.courseId)?.name || "a course"}` : ""}.` : "."}
                    </p>
                    {app.status === "accepted" && stepList()}
                    {app.status === "accepted" && app.decision?.userId && <Link href={`/admin/volunteers/detail?id=${app.decision.userId}`} className="inline-block mt-2 text-sm text-blue-700 hover:underline font-semibold">Open their volunteer record</Link>}
                    <div className="mt-3">{sentBox(mails.filter(m => m.kind === (app.status === "accepted" ? "welcome" : "declined")), app.status === "accepted" ? "Welcome email" : "Decline email")}</div>
                </div>
            )}

            <div className="bg-white rounded-xl border p-5 mt-6">
                <h2 className="font-bold mb-3 flex items-center gap-2"><Mail size={18} /> Emails</h2>
                {mails.length === 0 ? <p className="text-sm text-slate-400">No emails yet.</p> : (
                    <ul className="divide-y">
                        {mails.map(m => (
                            <li key={m.id} className="py-3 text-sm flex flex-wrap items-center justify-between gap-2">
                                <div>
                                    <p className="font-semibold">{m.subject}</p>
                                    <p className="text-slate-500">To {m.to.join(", ")}{m.cc && m.cc.length ? `, copy to ${m.cc.join(", ")}` : ""}</p>
                                    <p className={`text-xs ${m.status === "sent" ? "text-green-700" : m.status === "failed" ? "text-red-600" : "text-amber-700"}`}>
                                        {m.status === "sent" ? `Sent from recruitment@sovereignhousegh.com${m.createdAt?.toDate ? ` on ${m.createdAt.toDate().toLocaleString("en-GB", { dateStyle: "medium", timeStyle: "short" })}` : ""}` : m.status === "failed" ? `Not sent: ${m.error || "error"}` : m.status === "queued" ? "Sending…" : "Waiting to be sent"}
                                    </p>
                                </div>
                                {m.status !== "sent" && (
                                    <div className="flex gap-2">
                                        <a href={mailtoLink(m)} className="px-3 py-1.5 rounded-lg border border-slate-300 hover:bg-slate-50">Open in Outlook</a>
                                        {m.ics && <button onClick={() => downloadText(m.icsName || "invite.ics", m.ics!, "text/calendar")} className="px-3 py-1.5 rounded-lg border border-slate-300 hover:bg-slate-50 flex items-center gap-1"><Download size={14} /> Invite</button>}
                                    </div>
                                )}
                            </li>
                        ))}
                    </ul>
                )}
            </div>
        </div>
    );
}

export default function VolunteerApplicationDetail() {
    return (
        <RequirePermission perm="volunteer_applications">
            <DashboardLayout>
                <Suspense fallback={null}><Detail /></Suspense>
            </DashboardLayout>
        </RequirePermission>
    );
}
